/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { IJsonRpcRequest, isJsonRpcRequest, JsonRpcId, JsonRpcMessage } from '../../../../../base/common/jsonRpcProtocol.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../../base/common/observable.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { LogLevel, NullLogger } from '../../../../../platform/log/common/log.js';
import { LATEST_MCP_PROTOCOL_VERSION, McpProtocolEra, META_SERVER_INFO, META_SUBSCRIPTION_ID } from '../../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../../platform/mcp/common/modelContextProtocol.js';
import { StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceFolderData } from '../../../../../platform/workspace/common/workspace.js';
import { IResolvedValue } from '../../../../services/configurationResolver/common/configurationResolverExpression.js';
import { IMcpHostDelegate, IMcpMessageTransport, IMcpRegistry, IMcpResolveConnectionOptions } from '../../common/mcpRegistryTypes.js';
import { McpServerConnection } from '../../common/mcpServerConnection.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, IMcpServerConnection, LazyCollectionState, McpCollectionDefinition, McpCollectionReference, McpConnectionState, McpDefinitionReference, McpServerDefinition, McpServerTransportType, McpServerTrust } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';

export interface ITestMcpTransportOptions {
	/** The era the fake server speaks. Legacy servers answer `server/discover` with -32601; modern servers answer `initialize` with -32601. */
	readonly era?: McpProtocolEra;
	/** Overrides for the default `server/discover` result (modern). */
	readonly discoverResult?: Partial<MCP.DiscoverResult>;
	/** Overrides for the default `initialize` result (legacy). */
	readonly initializeResult?: Partial<MCPLegacy.InitializeResult>;
	/** Acknowledge `subscriptions/listen` streams automatically (modern, default true). */
	readonly acknowledgeListen?: boolean;
}

export type TestMcpResponder = (message: IJsonRpcRequest) => JsonRpcMessage | JsonRpcMessage[] | undefined;

export const TEST_MODERN_SERVER_INFO: MCP.Implementation = { name: 'Test Modern Server', version: '2.0.0' };

/**
 * Implementation of IMcpMessageTransport for testing purposes.
 * Allows tests to easily send/receive messages and control the connection state.
 */
export class TestMcpMessageTransport extends Disposable implements IMcpMessageTransport {
	private readonly _onDidLog = this._register(new Emitter<{ level: LogLevel; message: string }>());
	public readonly onDidLog = this._onDidLog.event;

	private readonly _onDidReceiveMessage = this._register(new Emitter<JsonRpcMessage>());
	public readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

	private readonly _onDidAbortRequest = this._register(new Emitter<IMcpRequestAbort>());
	public readonly onDidAbortRequest = this._onDidAbortRequest.event;

	private readonly _stateValue = observableValue<McpConnectionState>('testTransportState', { state: McpConnectionState.Kind.Starting });
	public readonly state = this._stateValue;

	private readonly _sentMessages: JsonRpcMessage[] = [];
	private readonly _sentEnvelopes: (IMcpMessageEnvelope | undefined)[] = [];
	private readonly _cancelledRequests: JsonRpcId[] = [];
	private _responders = new Map<string, TestMcpResponder>();
	public readonly era: McpProtocolEra;

	constructor(private readonly _options: ITestMcpTransportOptions = {}) {
		super();
		this.era = _options.era ?? 'legacy';

		if (this.era === 'legacy') {
			this.setResponder('server/discover', req => ({
				jsonrpc: MCPLegacy.JSONRPC_VERSION,
				id: req.id,
				error: { code: MCPLegacy.METHOD_NOT_FOUND, message: 'Method not found: server/discover' },
			}));
			this.setResponder('initialize', req => ({
				jsonrpc: MCPLegacy.JSONRPC_VERSION,
				id: req.id,
				result: this.defaultInitializeResult(),
			}));
		} else {
			this.setResponder('initialize', req => ({
				jsonrpc: MCPLegacy.JSONRPC_VERSION,
				id: req.id,
				error: { code: MCP.METHOD_NOT_FOUND, message: 'Method not found: initialize' },
			}));
			this.setResponder('server/discover', req => ({
				jsonrpc: MCP.JSONRPC_VERSION,
				id: req.id,
				result: this.defaultDiscoverResult(),
			}));
			if (_options.acknowledgeListen !== false) {
				this.setResponder('subscriptions/listen', req => ({
					jsonrpc: MCP.JSONRPC_VERSION,
					method: 'notifications/subscriptions/acknowledged',
					params: {
						_meta: { [META_SUBSCRIPTION_ID]: req.id },
						notifications: (req.params as { notifications?: MCP.SubscriptionFilter } | undefined)?.notifications ?? {},
					},
				}));
			}
		}
	}

	public defaultInitializeResult(): MCPLegacy.InitializeResult {
		return {
			protocolVersion: MCPLegacy.LATEST_PROTOCOL_VERSION,
			serverInfo: {
				name: 'Test MCP Server',
				version: '1.0.0',
			},
			capabilities: {
				resources: {},
				tools: {},
			},
			...this._options.initializeResult,
		};
	}

	public defaultDiscoverResult(): MCP.DiscoverResult {
		return {
			resultType: 'complete',
			supportedVersions: [LATEST_MCP_PROTOCOL_VERSION],
			capabilities: {
				tools: { listChanged: true },
				prompts: { listChanged: true },
				resources: { subscribe: true, listChanged: true },
				logging: {},
				completions: {},
			},
			ttlMs: 60_000,
			cacheScope: 'public',
			_meta: { [META_SERVER_INFO]: TEST_MODERN_SERVER_INFO },
			...this._options.discoverResult,
		};
	}

	/**
	 * Set a responder function for a specific method.
	 * The responder receives the sent request and should return a response object
	 * (or several messages), which will be simulated as server messages.
	 */
	public setResponder(method: string, responder: TestMcpResponder | undefined): void {
		if (responder) {
			this._responders.set(method, responder);
		} else {
			this._responders.delete(method);
		}
	}

	/**
	 * Send a message through the transport.
	 */
	public send(message: JsonRpcMessage, envelope?: IMcpMessageEnvelope): void {
		this._sentMessages.push(message);
		this._sentEnvelopes.push(envelope);
		if (isJsonRpcRequest(message)) {
			const responder = this._responders.get(message.method);
			if (responder) {
				const response = responder(message);
				if (response) {
					const messages = Array.isArray(response) ? response : [response];
					setTimeout(() => messages.forEach(m => this.simulateReceiveMessage(m)));
				}
			}
		}
	}

	public cancelRequest(requestId: JsonRpcId): void {
		this._cancelledRequests.push(requestId);
	}

	/**
	 * Stop the transport.
	 */
	public stop(): void {
		this._stateValue.set({ state: McpConnectionState.Kind.Stopped }, undefined);
	}

	// Test Helper Methods

	/**
	 * Simulate receiving a message from the server.
	 */
	public simulateReceiveMessage(message: JsonRpcMessage): void {
		this._onDidReceiveMessage.fire(message);
	}

	/**
	 * Answers the handshake request (`initialize` for legacy, `server/discover`
	 * for modern transports) with the default result, if it was sent.
	 */
	public simulateInitialized(): boolean {
		const method = this.era === 'legacy' ? 'initialize' : 'server/discover';
		const request = this.getSentRequests(method).at(-1);
		if (!request) {
			// The default responders complete the handshake on their own.
			return false;
		}

		this.simulateReceiveMessage({
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: request.id,
			result: this.era === 'legacy' ? this.defaultInitializeResult() : this.defaultDiscoverResult(),
		});
		return true;
	}

	/** Reports a transport abort for a request. */
	public simulateAbort(abort: IMcpRequestAbort): void {
		this._onDidAbortRequest.fire(abort);
	}

	/** Delivers a notification on a listen stream. */
	public simulateListenEvent(subscriptionId: JsonRpcId, method: string, params: Record<string, unknown> = {}): void {
		this.simulateReceiveMessage({
			jsonrpc: MCP.JSONRPC_VERSION,
			method,
			params: { ...params, _meta: { ...(params._meta as object | undefined), [META_SUBSCRIPTION_ID]: subscriptionId } },
		});
	}

	/** Closes a listen stream gracefully (the server sends its result). */
	public simulateListenClosed(subscriptionId: JsonRpcId): void {
		this.simulateReceiveMessage({
			jsonrpc: MCP.JSONRPC_VERSION,
			id: subscriptionId,
			result: { resultType: 'complete', _meta: { [META_SUBSCRIPTION_ID]: subscriptionId } } satisfies MCP.SubscriptionsListenResult,
		});
	}

	/** Answers a request with an `input_required` result. */
	public simulateInputRequired(requestId: JsonRpcId, inputRequests: MCP.InputRequests, requestState?: string): void {
		const result: MCP.InputRequiredResult = { resultType: 'input_required', inputRequests };
		if (requestState !== undefined) {
			result.requestState = requestState;
		}
		this.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: requestId, result });
	}

	/** Answers a request with a complete result (modern results get `resultType`). */
	public simulateResult(requestId: JsonRpcId, result: object): void {
		this.simulateReceiveMessage({
			jsonrpc: MCP.JSONRPC_VERSION,
			id: requestId,
			result: this.era === 'modern' ? { resultType: 'complete', ...result } : result,
		});
	}

	/** Answers a request with an error. */
	public simulateError(requestId: JsonRpcId, code: number, message: string, data?: unknown): void {
		this.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: requestId, error: data === undefined ? { code, message } : { code, message, data } });
	}

	/**
	 * Simulate a log event.
	 */
	public simulateLog(message: string): void {
		this._onDidLog.fire({ level: LogLevel.Info, message });
	}

	/**
	 * Set the connection state.
	 */
	public setConnectionState(state: McpConnectionState): void {
		this._stateValue.set(state, undefined);
	}

	/**
	 * Get all messages that have been sent.
	 */
	public getSentMessages(): readonly JsonRpcMessage[] {
		return [...this._sentMessages];
	}

	/** Get the sent requests, optionally for one method only. */
	public getSentRequests(method?: string): readonly IJsonRpcRequest[] {
		return this._sentMessages.filter((m): m is IJsonRpcRequest => isJsonRpcRequest(m) && (method === undefined || m.method === method));
	}

	/** Get the envelopes sent alongside each message (same order as {@link getSentMessages}). */
	public getSentEnvelopes(): readonly (IMcpMessageEnvelope | undefined)[] {
		return [...this._sentEnvelopes];
	}

	/** Get the envelope of the last request sent for a method. */
	public getSentEnvelope(method: string): IMcpMessageEnvelope | undefined {
		for (let i = this._sentMessages.length - 1; i >= 0; i--) {
			const message = this._sentMessages[i];
			if (isJsonRpcRequest(message) && message.method === method) {
				return this._sentEnvelopes[i];
			}
		}
		return undefined;
	}

	/** Request ids cancelled through {@link cancelRequest}. */
	public getCancelledRequests(): readonly JsonRpcId[] {
		return [...this._cancelledRequests];
	}

	/**
	 * Clear the sent messages history.
	 */
	public clearSentMessages(): void {
		this._sentMessages.length = 0;
		this._sentEnvelopes.length = 0;
	}
}

export class TestMcpRegistry implements IMcpRegistry {
	public makeTestTransport = () => new TestMcpMessageTransport();

	constructor(@IInstantiationService private readonly _instantiationService: IInstantiationService) { }

	_serviceBrand: undefined;
	onDidChangeInputs = Event.None;
	collections = observableValue<readonly McpCollectionDefinition[]>(this, [{
		id: 'test-collection',
		remoteAuthority: null,
		label: 'Test Collection',
		configTarget: ConfigurationTarget.USER,
		order: 0,
		serverDefinitions: observableValue(this, [{
			id: 'test-server',
			label: 'Test Server',
			launch: { type: McpServerTransportType.Stdio, command: 'echo', args: ['Hello MCP'], env: {}, envFile: undefined, cwd: undefined, sandbox: undefined },
			cacheNonce: 'a',
		} satisfies McpServerDefinition]),
		trustBehavior: McpServerTrust.Kind.Trusted,
		scope: StorageScope.APPLICATION,
	}]);
	delegates = observableValue<readonly IMcpHostDelegate[]>(this, [{
		priority: 0,
		canStart: () => true,
		substituteVariables(serverDefinition, launch) {
			return Promise.resolve(launch);
		},
		expandEnvironmentVariables(serverDefinition, launch) {
			return Promise.resolve(launch);
		},
		start: () => {
			const t = this.makeTestTransport();
			setTimeout(() => t.setConnectionState({ state: McpConnectionState.Kind.Running }));
			return t;
		},
		waitForInitialProviderPromises: () => Promise.resolve(),
	}]);
	lazyCollectionState = observableValue(this, { state: LazyCollectionState.AllKnown, collections: [] });
	collectionToolPrefix(collection: McpCollectionReference): IObservable<string> {
		return observableValue<string>(this, `mcp-${collection.id}-`);
	}
	getServerDefinition(collectionRef: McpDefinitionReference, definitionRef: McpDefinitionReference): IObservable<{ server: McpServerDefinition | undefined; collection: McpCollectionDefinition | undefined }> {
		const collectionObs = this.collections.map(cols => cols.find(c => c.id === collectionRef.id));
		return collectionObs.map((collection, reader) => {
			const server = collection?.serverDefinitions.read(reader).find(s => s.id === definitionRef.id);
			return { collection, server };
		});
	}
	discoverCollections(): Promise<McpCollectionDefinition[]> {
		throw new Error('Method not implemented.');
	}
	registerDelegate(delegate: IMcpHostDelegate): IDisposable {
		throw new Error('Method not implemented.');
	}
	registerCollection(collection: McpCollectionDefinition): IDisposable {
		throw new Error('Method not implemented.');
	}
	resetTrust(): void {
		throw new Error('Method not implemented.');
	}
	clearSavedInputs(scope: StorageScope, inputId?: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	editSavedInput(inputId: string, folderData: IWorkspaceFolderData | undefined, configSection: string, target: ConfigurationTarget): Promise<void> {
		throw new Error('Method not implemented.');
	}
	setSavedInput(inputId: string, target: ConfigurationTarget, value: string): Promise<void> {
		throw new Error('Method not implemented.');
	}
	getSavedInputs(scope: StorageScope): Promise<{ [id: string]: IResolvedValue }> {
		throw new Error('Method not implemented.');
	}
	resolveConnection(options: IMcpResolveConnectionOptions): Promise<IMcpServerConnection | undefined> {
		const collection = this.collections.get().find(c => c.id === options.collectionRef.id);
		const definition = collection?.serverDefinitions.get().find(d => d.id === options.definitionRef.id);
		if (!collection || !definition) {
			throw new Error(`Collection or definition not found: ${options.collectionRef.id}, ${options.definitionRef.id}`);
		}
		const del = this.delegates.get()[0];
		return Promise.resolve(new McpServerConnection(
			collection,
			definition,
			del,
			definition.launch,
			new NullLogger(),
			false,
			options.taskManager,
			this._instantiationService,
		));
	}
}
