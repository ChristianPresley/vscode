/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { IJsonRpcErrorResponse, IJsonRpcNotification, IJsonRpcRequest, IJsonRpcSuccessResponse, JsonRpcId, JsonRpcMessage, JsonRpcResponse } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { LEGACY_MCP_PROTOCOL_VERSIONS, META_PROGRESS_TOKEN } from '../common/mcpProtocolVersions.js';
import { MCP } from '../common/modelContextProtocol.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';
import { IMcpGatewayDispatchContext, IMcpGatewayNotification, McpGatewayDispatcher } from './mcpGatewayDispatcher.js';

/** Where the messages produced while serving a request go: the client's response stream. */
export interface IMcpGatewayMessageSink {
	notify(notification: IMcpGatewayNotification): void;
	/**
	 * Legacy sessions: writes a server→client request and resolves with the
	 * client's result; rejects when `token` (the originating request's) cancels.
	 */
	sendRequest(request: IMcpGatewayNotification, token?: CancellationToken): Promise<unknown>;
}

/** An open server→client SSE stream of a legacy session (opened with HTTP GET). */
export interface IMcpGatewaySessionStream extends IMcpGatewayMessageSink {
	readonly isOpen: boolean;
	/** Fires once when the stream is over, whoever ended it. */
	readonly onDidClose: Event<void>;
	end(): void;
}

export interface IMcpGatewayPendingRequest {
	readonly id: JsonRpcId;
	/** Settles with the client's result, or rejects when the client answers with an error, the token cancels or the session ends. */
	readonly result: Promise<unknown>;
}

/** Hands out ids and results for the server→client requests a legacy session has in flight. */
export interface IMcpGatewayRequestBroker {
	createRequest(token?: CancellationToken): IMcpGatewayPendingRequest;
}

const LOGGING_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequest(message: unknown): message is IJsonRpcRequest {
	return isObject(message) && typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number');
}

function isNotification(message: unknown): message is IJsonRpcNotification {
	return isObject(message) && typeof message.method === 'string' && message.id === undefined;
}

function isResponse(message: unknown): message is IJsonRpcSuccessResponse | IJsonRpcErrorResponse {
	return isObject(message) && message.method === undefined && (message.result !== undefined || isObject(message.error));
}

function errorResponseFor(id: JsonRpcId, error: McpGatewayRpcError): IJsonRpcErrorResponse {
	return { jsonrpc: '2.0', id, error: error.data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data: error.data } };
}

/**
 * One 2025-11-25 (and earlier) Streamable HTTP session: the `initialize`
 * handshake, the per-session logging level and resource subscriptions, the
 * server→client requests the dispatcher's input rounds need and the
 * list-changed broadcasts on the session's streams. Every other method goes
 * through the {@link McpGatewayDispatcher}.
 */
export class McpGatewaySession extends Disposable implements IMcpGatewayRequestBroker {
	private readonly _streams = new Set<IMcpGatewaySessionStream>();
	private readonly _streamListeners = this._register(new DisposableMap<IMcpGatewaySessionStream>());
	private readonly _pending = new Map<JsonRpcId, { readonly deferred: DeferredPromise<unknown>; readonly listener: IDisposable }>();
	private readonly _inflight = new Map<JsonRpcId, CancellationTokenSource>();
	private readonly _resourceSubscriptions = this._register(new DisposableMap<string>());
	private _nextServerRequestId = 1;
	private _initialized = false;
	private _protocolVersion: string | undefined;
	private _clientCapabilities: MCP.ClientCapabilities = {};
	private _clientInfo: MCP.Implementation | undefined;
	private _logLevel: MCP.LoggingLevel | undefined;

	/** The session's own streams (HTTP GET): where messages go that have no response stream of their own. */
	readonly streamSink: IMcpGatewayMessageSink = {
		notify: notification => this._broadcast(notification),
		sendRequest: (request, token) => {
			const stream = this._openStream();
			if (!stream) {
				return Promise.reject(new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'The client has no open stream to receive a server request'));
			}
			return stream.sendRequest(request, token);
		},
	};

	constructor(
		public readonly id: string,
		private readonly _logger: ILogger,
		private readonly _dispatcher: McpGatewayDispatcher,
		private readonly _invoker: IMcpGatewaySingleServerInvoker,
		private readonly _onDidDispose: () => void,
	) {
		super();
		this._register(_invoker.onDidChangeTools(() => this._broadcastListChanged('notifications/tools/list_changed')));
		this._register(_invoker.onDidChangeResources(() => this._broadcastListChanged('notifications/resources/list_changed')));
		if (_invoker.onDidChangePrompts) {
			this._register(_invoker.onDidChangePrompts(() => this._broadcastListChanged('notifications/prompts/list_changed')));
		}
		if (_invoker.onDidUpdateResource) {
			this._register(_invoker.onDidUpdateResource(({ uri }) => {
				if (this._resourceSubscriptions.has(uri)) {
					this._broadcast({ method: 'notifications/resources/updated', params: { uri } });
				}
			}));
		}
	}

	get isInitialized(): boolean {
		return this._initialized;
	}

	/** The negotiated legacy revision; undefined before `initialize`. */
	get protocolVersion(): string | undefined {
		return this._protocolVersion;
	}

	get logLevel(): MCP.LoggingLevel | undefined {
		return this._logLevel;
	}

	get clientCapabilities(): MCP.ClientCapabilities {
		return this._clientCapabilities;
	}

	get streamCount(): number {
		return this._streams.size;
	}

	get pendingRequestCount(): number {
		return this._pending.size;
	}

	/** Adds an open GET stream; it is forgotten when it closes. */
	attachStream(stream: IMcpGatewaySessionStream): void {
		this._streams.add(stream);
		this._logger.info(`[McpGateway][session ${this.id}] Stream attached (total: ${this._streams.size})`);
		this._streamListeners.set(stream, stream.onDidClose(() => {
			this._streams.delete(stream);
			this._streamListeners.deleteAndDispose(stream);
			this._logger.info(`[McpGateway][session ${this.id}] Stream detached (total: ${this._streams.size})`);
		}));
	}

	/**
	 * Handles the messages of one POST. Requests yield responses (in order);
	 * notifications and the client's answers to server requests yield none.
	 * `sink` is the POST's own response stream; it defaults to the session's
	 * GET streams. `token` is the POST's own cancellation (the client went
	 * away): it cancels every request of the POST.
	 */
	async handleIncoming(message: JsonRpcMessage | JsonRpcMessage[], sink: IMcpGatewayMessageSink = this.streamSink, headers: Readonly<Record<string, string>> = {}, token: CancellationToken = CancellationToken.None): Promise<JsonRpcResponse[]> {
		const messages: unknown[] = Array.isArray(message) ? message : [message];
		const responses: JsonRpcResponse[] = [];
		for (const single of messages) {
			const response = await this._handleMessage(single, sink, headers, token);
			if (response) {
				responses.push(response);
			}
		}
		return responses;
	}

	createRequest(token: CancellationToken = CancellationToken.None): IMcpGatewayPendingRequest {
		const id = this._nextServerRequestId++;
		if (token.isCancellationRequested || this._store.isDisposed) {
			return { id, result: Promise.reject(new CancellationError()) };
		}
		const deferred = new DeferredPromise<unknown>();
		const listener = token.onCancellationRequested(() => this._failPending(id, new CancellationError()));
		this._pending.set(id, { deferred, listener });
		const result = deferred.p.finally(() => {
			listener.dispose();
			this._pending.delete(id);
		});
		return { id, result };
	}

	/** Cancels an in-flight client request (`notifications/cancelled`). */
	cancelRequest(requestId: JsonRpcId): boolean {
		const cts = this._inflight.get(requestId);
		if (!cts) {
			return false;
		}
		cts.cancel();
		return true;
	}

	override dispose(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._logger.info(`[McpGateway][session ${this.id}] Disposing session (streams: ${this._streams.size}, pending: ${this._pending.size})`);
		for (const id of [...this._pending.keys()]) {
			this._failPending(id, new CancellationError());
		}
		for (const cts of this._inflight.values()) {
			cts.cancel();
		}
		for (const stream of [...this._streams]) {
			stream.end();
		}
		this._streams.clear();
		this._onDidDispose();
		super.dispose();
	}

	private _openStream(): IMcpGatewaySessionStream | undefined {
		for (const stream of this._streams) {
			if (stream.isOpen) {
				return stream;
			}
		}
		return undefined;
	}

	private _broadcast(notification: IMcpGatewayNotification): void {
		let delivered = 0;
		for (const stream of [...this._streams]) {
			if (stream.isOpen) {
				stream.notify(notification);
				delivered++;
			}
		}
		if (delivered === 0) {
			this._logger.debug(`[McpGateway][session ${this.id}] No stream for ${notification.method}, dropping it`);
		}
	}

	private _broadcastListChanged(method: string): void {
		if (!this._initialized) {
			return;
		}
		this._logger.info(`[McpGateway][session ${this.id}] ${method}`);
		this._broadcast({ method });
	}

	private _failPending(id: JsonRpcId, error: Error): void {
		const entry = this._pending.get(id);
		if (entry) {
			this._pending.delete(id);
			entry.listener.dispose();
			entry.deferred.error(error);
		}
	}

	private async _handleMessage(message: unknown, sink: IMcpGatewayMessageSink, headers: Readonly<Record<string, string>>, token: CancellationToken): Promise<JsonRpcResponse | undefined> {
		if (isResponse(message)) {
			this._handleResponse(message);
			return undefined;
		}
		if (isRequest(message)) {
			return this._handleRequest(message, sink, headers, token);
		}
		if (isNotification(message)) {
			this._handleNotification(message);
			return undefined;
		}
		this._logger.warn(`[McpGateway][session ${this.id}] Ignored a message that is not a JSON-RPC request, notification or response`);
		const id = isObject(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : undefined;
		const response: IJsonRpcErrorResponse = { jsonrpc: '2.0', error: { code: MCP.INVALID_REQUEST, message: 'Invalid Request' } };
		return id === undefined ? response : { ...response, id };
	}

	private _handleResponse(response: IJsonRpcSuccessResponse | IJsonRpcErrorResponse): void {
		const id = response.id;
		if (id === undefined) {
			return;
		}
		const entry = this._pending.get(id);
		if (!entry) {
			this._logger.warn(`[McpGateway][session ${this.id}] Response for unknown server request ${String(id)}`);
			return;
		}
		this._pending.delete(id);
		entry.listener.dispose();
		const error = (response as { readonly error?: unknown }).error;
		if (isObject(error)) {
			entry.deferred.error(new McpGatewayRpcError(typeof error.code === 'number' ? error.code : MCP.INTERNAL_ERROR, typeof error.message === 'string' ? error.message : 'The client failed the request', error.data));
		} else {
			entry.deferred.complete((response as IJsonRpcSuccessResponse).result);
		}
	}

	private _handleNotification(notification: IJsonRpcNotification): void {
		this._logger.debug(`[McpGateway][session ${this.id}] <-- notification: ${notification.method}`);
		switch (notification.method) {
			case 'notifications/initialized':
				this._initialized = true;
				this._logger.info(`[McpGateway][session ${this.id}] Session initialized`);
				break;
			case 'notifications/cancelled': {
				const requestId = isObject(notification.params) ? notification.params.requestId : undefined;
				if (typeof requestId === 'string' || typeof requestId === 'number') {
					this.cancelRequest(requestId);
				}
				break;
			}
		}
	}

	private async _handleRequest(request: IJsonRpcRequest, sink: IMcpGatewayMessageSink, headers: Readonly<Record<string, string>>, token: CancellationToken): Promise<JsonRpcResponse | undefined> {
		this._logger.debug(`[McpGateway][session ${this.id}] <-- request: ${request.method} (id=${String(request.id)})`);
		const cts = new CancellationTokenSource(token);
		this._inflight.set(request.id, cts);
		try {
			const result = await this._dispatchRequest(request, sink, headers, cts.token);
			if (cts.token.isCancellationRequested) {
				return undefined;
			}
			return { jsonrpc: '2.0', id: request.id, result };
		} catch (error) {
			if (cts.token.isCancellationRequested) {
				this._logger.debug(`[McpGateway][session ${this.id}] ${request.method} (id=${String(request.id)}) was cancelled`);
				return undefined;
			}
			if (error instanceof McpGatewayRpcError) {
				return errorResponseFor(request.id, error);
			}
			this._logger.error(`[McpGateway][session ${this.id}] ${request.method} failed`, error);
			return errorResponseFor(request.id, new McpGatewayRpcError(MCP.INTERNAL_ERROR, error instanceof Error ? error.message : String(error)));
		} finally {
			if (this._inflight.get(request.id) === cts) {
				this._inflight.delete(request.id);
			}
			cts.dispose();
		}
	}

	private async _dispatchRequest(request: IJsonRpcRequest, sink: IMcpGatewayMessageSink, headers: Readonly<Record<string, string>>, token: CancellationToken): Promise<object> {
		const params = isObject(request.params) ? request.params : {};
		switch (request.method) {
			case 'initialize':
				return this._initialize(params);
			case 'ping':
				return {};
		}
		if (!this._initialized) {
			this._logger.warn(`[McpGateway][session ${this.id}] Rejected '${request.method}': session not initialized`);
			throw new McpGatewayRpcError(MCP.INVALID_REQUEST, 'Session is not initialized');
		}
		switch (request.method) {
			case 'logging/setLevel': {
				if (typeof params.level !== 'string' || !LOGGING_LEVELS.has(params.level)) {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Invalid logging level');
				}
				this._logLevel = params.level as MCP.LoggingLevel;
				return {};
			}
			case 'resources/subscribe':
				return this._subscribeResource(params);
			case 'resources/unsubscribe': {
				if (typeof params.uri !== 'string') {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing resource URI');
				}
				this._resourceSubscriptions.deleteAndDispose(params.uri);
				return {};
			}
		}
		const meta = isObject(params._meta) ? params._meta : undefined;
		const progressTokenRaw = meta?.[META_PROGRESS_TOKEN];
		const context: IMcpGatewayDispatchContext = {
			era: 'legacy',
			protocolVersion: this._protocolVersion ?? MCPLegacy.LATEST_PROTOCOL_VERSION,
			requestId: request.id,
			clientCapabilities: this._clientCapabilities,
			clientInfo: this._clientInfo,
			logLevel: this._logLevel,
			progressToken: typeof progressTokenRaw === 'string' || typeof progressTokenRaw === 'number' ? progressTokenRaw : undefined,
			headers,
			token,
			notify: notification => sink.notify(notification),
			sendServerRequest: serverRequest => sink.sendRequest(serverRequest, token),
		};
		return this._dispatcher.dispatch(context, request.method, params);
	}

	private _initialize(params: Record<string, unknown>): MCPLegacy.InitializeResult {
		const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
		const negotiatedVersion = clientVersion !== undefined && LEGACY_MCP_PROTOCOL_VERSIONS.includes(clientVersion) ? clientVersion : MCPLegacy.LATEST_PROTOCOL_VERSION;
		const clientInfo = isObject(params.clientInfo) && typeof params.clientInfo.name === 'string' && typeof params.clientInfo.version === 'string' ? params.clientInfo as unknown as MCP.Implementation : undefined;
		this._protocolVersion = negotiatedVersion;
		this._clientCapabilities = isObject(params.capabilities) ? params.capabilities as MCP.ClientCapabilities : {};
		this._clientInfo = clientInfo;

		this._logger.info(`[McpGateway][session ${this.id}] Initialize: client=${clientInfo?.name ?? 'unknown'}/${clientInfo?.version ?? '?'}, clientProtocol=${clientVersion ?? '(none)'}, negotiated=${negotiatedVersion}`);
		if (clientVersion !== undefined && clientVersion !== negotiatedVersion) {
			this._logger.warn(`[McpGateway][session ${this.id}] Client requested unsupported protocol version '${clientVersion}', falling back to '${negotiatedVersion}'`);
		}

		const serverInfo = this._dispatcher.serverInfo;
		const result: MCPLegacy.InitializeResult = {
			protocolVersion: negotiatedVersion,
			capabilities: this._dispatcher.legacyInitializeCapabilities(),
			serverInfo: serverInfo.title === undefined ? { name: serverInfo.name, version: serverInfo.version } : { name: serverInfo.name, version: serverInfo.version, title: serverInfo.title },
		};
		const instructions = this._dispatcher.discoverResult().instructions;
		if (instructions) {
			result.instructions = instructions;
		}
		return result;
	}

	private async _subscribeResource(params: Record<string, unknown>): Promise<object> {
		if (typeof params.uri !== 'string') {
			throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing resource URI');
		}
		const uri = params.uri;
		if (this._resourceSubscriptions.has(uri)) {
			return {};
		}
		const subscribe = this._invoker.subscribeResource;
		if (!subscribe) {
			this._logger.debug(`[McpGateway][session ${this.id}] The server cannot watch ${uri}; subscription recorded without updates`);
			this._resourceSubscriptions.set(uri, Disposable.None);
			return {};
		}
		const subscription = await subscribe.call(this._invoker, uri);
		if (this._store.isDisposed) {
			subscription.dispose();
		} else {
			this._resourceSubscriptions.set(uri, subscription);
		}
		return {};
	}
}

export function isInitializeMessage(message: unknown): boolean {
	const first = Array.isArray(message) ? message[0] : message;
	return isRequest(first) && first.method === 'initialize';
}
