/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DeferredPromise, raceCancellationError, Sequencer, timeout } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { AUTH_SCOPE_SEPARATOR, IAuthorizationProtectedResourceMetadata, IAuthorizationServerMetadata, OAuthClientError, parseWWWAuthenticateHeader, scopesMatch } from '../../../base/common/oauth.js';
import { IOAuthClientRecord, IOAuthClientStorage, OAuthLogLevel, parseBearerChallenge, redact } from '../../../base/common/oauthClient.js';
import { SSEParser } from '../../../base/common/sseParser.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { vArray, vBoolean, vNumber, vObj, vObjAny, vOptionalProp, vString } from '../../../base/common/validation.js';
import { localize } from '../../../nls.js';
import { ConfigurationTarget } from '../../../platform/configuration/common/configuration.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { canLog, ILogService, LogLevel } from '../../../platform/log/common/log.js';
import { MCP_PROTOCOL_VERSION_HEADER } from '../../../platform/mcp/common/mcpHttpHeaders.js';
import { eraForProtocolVersion, isRecognizedModernError } from '../../../platform/mcp/common/mcpProtocolVersions.js';
import product from '../../../platform/product/common/product.js';
import { StorageScope } from '../../../platform/storage/common/storage.js';
import { extensionPrefixedIdentifier, IMcpMessageEnvelope, IMcpRequestAbort, McpCollectionDefinition, McpConnectionState, McpServerDefinition, McpServerEnvironmentVariableExpansion, McpServerLaunch, McpServerStaticMetadata, McpServerStaticToolAvailability, McpServerTransportHTTP, McpServerTransportType, UserInteractionRequiredError } from '../../contrib/mcp/common/mcpTypes.js';
import { MCPLegacy } from '../../contrib/mcp/common/modelContextProtocolLegacy.js';
import { checkProposedApiEnabled, isProposedApiEnabled } from '../../services/extensions/common/extensions.js';
import { ExtHostMcpShape, IMcpAuthenticationDetails, IAuthMetadataSource, IStartMcpOptions, MainContext, MainThreadMcpShape, IAuthResourceMetadataSource, IAuthServerMetadataSource, IMcpGatewayServerDto } from './extHost.protocol.js';
import { IExtHostInitDataService } from './extHostInitDataService.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import * as Convert from './extHostTypeConverters.js';
import { McpHttpServerDefinition, McpStdioServerDefinition, McpToolAvailability } from './extHostTypes.js';
import { IExtHostVariableResolverProvider } from './extHostVariableResolverService.js';
import { IExtHostWorkspace } from './extHostWorkspace.js';
import { createMcpOAuthClient, IMcpOAuthServerPolicy, MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS, MCP_OAUTH_MAX_CHALLENGE_CYCLES, MCP_OAUTH_REJECTIONS_BEFORE_REREGISTRATION, resolveMcpOAuthPolicy } from './mcpOAuthClientFactory.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../platform/mcp/common/mcpPlatformTypes.js';

export const IExtHostMpcService = createDecorator<IExtHostMpcService>('IExtHostMpcService');

export interface IExtHostMpcService extends ExtHostMcpShape {
	registerMcpConfigurationProvider(extension: IExtensionDescription, id: string, provider: vscode.McpServerDefinitionProvider): IDisposable;

	/** Event that fires when the set of MCP server definitions changes. */
	readonly onDidChangeMcpServerDefinitions: Event<void>;

	/** Returns all MCP server definitions known to the editor. */
	readonly mcpServerDefinitions: readonly vscode.McpServerDefinition[];

	/** Starts an MCP gateway that exposes MCP servers via HTTP endpoints. */
	startMcpGateway(chatSessionResource?: URI): Promise<vscode.McpGateway | undefined>;
}

const serverDataValidation = vObj({
	label: vString(),
	version: vOptionalProp(vString()),
	metadata: vOptionalProp(vObj({
		capabilities: vOptionalProp(vObjAny()),
		serverInfo: vOptionalProp(vObjAny()),
		tools: vOptionalProp(vArray(vObj({
			availability: vNumber(),
			definition: vObjAny(),
		}))),
	})),
	authentication: vOptionalProp(vObj({
		providerId: vString(),
		scopes: vArray(vString()),
	}))
});

// Can be validated with:
// declare const _serverDataValidationTest: vscode.McpStdioServerDefinition | vscode.McpHttpServerDefinition;
// const _serverDataValidationProd: ValidatorType<typeof serverDataValidation> = _serverDataValidationTest;

/** A transport handle living in the extension host (Streamable HTTP, or gRPC in the Node.js extension host). */
export interface IMcpExtHostHandle extends IDisposable {
	send(message: string, envelope?: IMcpMessageEnvelope): Promise<void>;
	cancelRequest(requestId: JsonRpcId): void;
	close(): Promise<void>;
}

export class ExtHostMcpService extends Disposable implements IExtHostMpcService {
	protected _proxy: MainThreadMcpShape;
	private readonly _initialProviderPromises = new Set<Promise<void>>();
	protected readonly _sseEventSources = this._register(new DisposableMap<number, IMcpExtHostHandle>());
	private readonly _unresolvedMcpServers = new Map</* collectionId */ string, {
		provider: vscode.McpServerDefinitionProvider;
		servers: vscode.McpServerDefinition[];
	}>();

	// MCP server definitions synced from main thread
	private readonly _onDidChangeMcpServerDefinitions = this._register(new Emitter<void>());
	readonly onDidChangeMcpServerDefinitions: Event<void> = this._onDidChangeMcpServerDefinitions.event;
	private _mcpServerDefinitions: readonly vscode.McpServerDefinition[] = [];

	// Active gateways with their server emitters for dynamic updates
	private readonly _activeGateways = new Map<string, {
		servers: vscode.McpGatewayServer[];
		onDidChangeServers: Emitter<readonly vscode.McpGatewayServer[]>;
	}>();

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@ILogService protected readonly _logService: ILogService,
		@IExtHostInitDataService private readonly _extHostInitData: IExtHostInitDataService,
		@IExtHostWorkspace protected readonly _workspaceService: IExtHostWorkspace,
		@IExtHostVariableResolverProvider private readonly _variableResolver: IExtHostVariableResolverProvider,
	) {
		super();
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadMcp);
	}

	/** Returns all MCP server definitions known to the editor. */
	get mcpServerDefinitions(): readonly vscode.McpServerDefinition[] {
		return this._mcpServerDefinitions;
	}

	/** Called by main thread to notify that MCP server definitions have changed. */
	$onDidChangeMcpServerDefinitions(servers: McpServerDefinition.Serialized[]): void {
		this._mcpServerDefinitions = servers.map(dto => Convert.McpServerDefinition.to(dto));
		this._onDidChangeMcpServerDefinitions.fire();
	}

	$startMcp(id: number, opts: IStartMcpOptions): void {
		this._startMcp(id, McpServerLaunch.fromSerialized(opts.launch), opts.defaultCwd && URI.revive(opts.defaultCwd), opts.errorOnUserInteraction);
	}

	protected _startMcp(id: number, launch: McpServerLaunch, _defaultCwd?: URI, errorOnUserInteraction?: boolean): void {
		if (launch.type === McpServerTransportType.HTTP) {
			this._sseEventSources.set(id, new McpHTTPHandle(id, launch, this._proxy, this._logService, errorOnUserInteraction));
			return;
		}

		throw new Error('not implemented');
	}

	async $substituteVariables<T>(_workspaceFolder: UriComponents | undefined, value: T): Promise<T> {
		const folderURI = URI.revive(_workspaceFolder);
		const folder = folderURI && await this._workspaceService.resolveWorkspaceFolder(folderURI);
		const variableResolver = await this._variableResolver.getResolver();
		return variableResolver.resolveAsync(folder && {
			uri: folder.uri,
			name: folder.name,
			index: folder.index,
		}, value) as T;
	}

	/**
	 * Hosts without a process environment, such as the web worker extension host,
	 * leave references verbatim, as the Copilot runtime does without an environment.
	 */
	async $expandEnvironmentVariables(launch: McpServerLaunch.Serialized, _expansion: McpServerEnvironmentVariableExpansion): Promise<McpServerLaunch.Serialized> {
		return launch;
	}

	$stopMcp(id: number): void {
		this._sseEventSources.get(id)
			?.close()
			.then(() => this._didClose(id));
	}

	private _didClose(id: number) {
		this._sseEventSources.deleteAndDispose(id);
	}

	$sendMessage(id: number, message: string, envelope?: IMcpMessageEnvelope): void {
		this._sseEventSources.get(id)?.send(message, envelope);
	}

	$cancelRequest(id: number, requestId: JsonRpcId): void {
		this._sseEventSources.get(id)?.cancelRequest(requestId);
	}

	async $waitForInitialCollectionProviders(): Promise<void> {
		await Promise.all(this._initialProviderPromises);
	}

	async $resolveMcpLaunch(collectionId: string, label: string): Promise<McpServerLaunch.Serialized | undefined> {
		const rec = this._unresolvedMcpServers.get(collectionId);
		if (!rec) {
			return;
		}

		const server = rec.servers.find(s => s.label === label);
		if (!server) {
			return;
		}
		if (!rec.provider.resolveMcpServerDefinition) {
			return Convert.McpServerDefinition.from(server);
		}

		const resolved = await rec.provider.resolveMcpServerDefinition(server, CancellationToken.None);
		return resolved ? Convert.McpServerDefinition.from(resolved) : undefined;
	}

	/** {@link vscode.lm.registerMcpServerDefinitionProvider} */
	public registerMcpConfigurationProvider(extension: IExtensionDescription, id: string, provider: vscode.McpServerDefinitionProvider): IDisposable {
		const store = new DisposableStore();

		const metadata = extension.contributes?.mcpServerDefinitionProviders?.find(m => m.id === id);
		if (!metadata) {
			throw new Error(`MCP configuration providers must be registered in the contributes.mcpServerDefinitionProviders array within your package.json, but "${id}" was not`);
		}

		const mcp: McpCollectionDefinition.FromExtHost = {
			id: extensionPrefixedIdentifier(extension.identifier, id),
			isTrustedByDefault: true,
			label: metadata?.label ?? extension.displayName ?? extension.name,
			scope: StorageScope.WORKSPACE,
			canResolveLaunch: typeof provider.resolveMcpServerDefinition === 'function',
			extensionId: extension.identifier.value,
			configTarget: this._extHostInitData.remote.isRemote ? ConfigurationTarget.USER_REMOTE : ConfigurationTarget.USER,
		};

		const update = async () => {
			const list = await provider.provideMcpServerDefinitions(CancellationToken.None);
			this._unresolvedMcpServers.set(mcp.id, { servers: list ?? [], provider });

			const servers: McpServerDefinition.Serialized[] = [];
			for (const item of list ?? []) {
				let id = ExtensionIdentifier.toKey(extension.identifier) + '/' + item.label;
				if (servers.some(s => s.id === id)) {
					let i = 2;
					while (servers.some(s => s.id === id + i)) { i++; }
					id = id + i;
				}

				serverDataValidation.validateOrThrow(item);
				if ((item as vscode.McpHttpServerDefinition2).authentication) {
					checkProposedApiEnabled(extension, 'mcpToolDefinitions');
				}

				let staticMetadata: McpServerStaticMetadata | undefined;
				const castAs2 = item as McpStdioServerDefinition | McpHttpServerDefinition;
				if (isProposedApiEnabled(extension, 'mcpToolDefinitions') && castAs2.metadata) {
					staticMetadata = {
						capabilities: castAs2.metadata.capabilities as MCPLegacy.ServerCapabilities,
						instructions: castAs2.metadata.instructions,
						serverInfo: castAs2.metadata.serverInfo as MCPLegacy.Implementation,
						tools: castAs2.metadata.tools?.map(t => ({
							availability: t.availability === McpToolAvailability.Dynamic ? McpServerStaticToolAvailability.Dynamic : McpServerStaticToolAvailability.Initial,
							definition: t.definition as MCPLegacy.Tool,
						})),
					};
				}

				servers.push({
					id,
					label: item.label,
					cacheNonce: item.version || '$$NONE',
					staticMetadata,
					launch: Convert.McpServerDefinition.from(item),
				});
			}

			this._proxy.$upsertMcpCollection(mcp, servers);
		};

		store.add(toDisposable(() => {
			this._unresolvedMcpServers.delete(mcp.id);
			this._proxy.$deleteMcpCollection(mcp.id);
		}));

		if (provider.onDidChangeMcpServerDefinitions) {
			store.add(provider.onDidChangeMcpServerDefinitions(update));
		}
		// todo@connor4312: proposed API back-compat
		// eslint-disable-next-line local/code-no-any-casts
		if ((provider as any).onDidChangeServerDefinitions) {
			// eslint-disable-next-line local/code-no-any-casts
			store.add((provider as any).onDidChangeServerDefinitions(update));
		}
		// eslint-disable-next-line local/code-no-any-casts
		if ((provider as any).onDidChange) {
			// eslint-disable-next-line local/code-no-any-casts
			store.add((provider as any).onDidChange(update));
		}

		const promise = new Promise<void>(resolve => {
			setTimeout(() => update().finally(() => {
				this._initialProviderPromises.delete(promise);
				resolve();
			}), 0);
		});

		this._initialProviderPromises.add(promise);

		return store;
	}

	/** {@link vscode.lm.startMcpGateway} */
	public async startMcpGateway(chatSessionResource?: URI): Promise<vscode.McpGateway | undefined> {
		const result = await this._proxy.$startMcpGateway(chatSessionResource?.toJSON());
		if (!result) {
			return undefined;
		}

		const gatewayId = result.gatewayId;
		const servers: vscode.McpGatewayServer[] = result.servers.map(reviveGatewayServer);
		const onDidChangeServers = new Emitter<readonly vscode.McpGatewayServer[]>();

		this._activeGateways.set(gatewayId, { servers, onDidChangeServers });

		return {
			get servers() { return servers; },
			onDidChangeServers: onDidChangeServers.event,
			dispose: () => {
				this._activeGateways.delete(gatewayId);
				onDidChangeServers.dispose();
				this._proxy.$disposeMcpGateway(gatewayId);
			}
		};
	}

	/** Called by main thread to notify that a gateway's server set has changed. */
	$onDidChangeGatewayServers(gatewayId: string, newServers: IMcpGatewayServerDto[]): void {
		const gateway = this._activeGateways.get(gatewayId);
		if (!gateway) {
			return;
		}

		const servers: vscode.McpGatewayServer[] = newServers.map(reviveGatewayServer);
		gateway.servers.length = 0;
		gateway.servers.push(...servers);
		gateway.onDidChangeServers.fire(servers);
	}
}

function stringifyError(err: unknown): string {
	if (!(err instanceof Error)) {
		return String(err);
	}
	let msg = String(err);
	let cause: unknown = err.cause;
	for (let depth = 0; cause !== undefined && depth < 5; depth++) {
		msg += `: ${cause instanceof Error ? (cause.message || String(cause)) : String(cause)}`;
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return msg;
}

/** A gateway server for the API; `grpcAddress` only when the gateway serves gRPC. */
function reviveGatewayServer(server: IMcpGatewayServerDto): vscode.McpGatewayServer {
	return server.grpcAddress
		? { label: server.label, address: URI.revive(server.address), grpcAddress: URI.revive(server.grpcAddress) }
		: { label: server.label, address: URI.revive(server.address) };
}

const enum HttpMode {
	/** No request answered yet: a modern request probes, a legacy request behaves as before. */
	Unknown,
	/** 2026-07-28 Streamable HTTP: POST only, no session, every request is its own stream. */
	Modern,
	/** Legacy (2025-11-25) Streamable HTTP with an optional session id and a GET backchannel. */
	Http,
	/** Legacy HTTP+SSE: one long-lived GET stream and a POST endpoint. */
	SSE,
}

type HttpModeT =
	| { value: HttpMode.Unknown }
	| { value: HttpMode.Modern }
	| { value: HttpMode.Http; sessionId: string | undefined }
	| { value: HttpMode.SSE; endpoint: string };

/** How often a legacy POST stream that closed before its response is resumed with `Last-Event-ID`. */
const MAX_LOST_STREAM_RETRIES = 3;
/** The reconnection delay when the server sent no `retry` field. */
const DEFAULT_SSE_RETRY_MS = 1000;

function requestKey(id: JsonRpcId): string {
	return `${typeof id}:${id}`;
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** True when `data` (one JSON-RPC message or a batch) carries the response to `requestId`. */
function isResponseFor(data: string, requestId: JsonRpcId): boolean {
	const parsed = tryParseJson(data);
	const messages = Array.isArray(parsed) ? parsed : [parsed];
	return messages.some(message =>
		typeof message === 'object' && message !== null
		&& (message as { id?: unknown }).id === requestId
		&& (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error')));
}

const MAX_FOLLOW_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
// Credential-bearing headers that must not be replayed to a different origin
// after a redirect (matches browser fetch / curl behavior). Compared case-insensitively.
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'mcp-session-id']);

function setHostHeader(headers: Record<string, string>, name: string, value: string): void {
	for (const configuredName of Object.keys(headers)) {
		if (configuredName.toLowerCase() === name.toLowerCase()) {
			delete headers[configuredName];
		}
	}
	headers[name] = value;
}

function isSameSocketEndpoint(url: string, configuredUrl: string): boolean {
	const destination = URI.parse(url);
	const configured = URI.parse(configuredUrl);
	// The Node dispatcher uses the decoded path as the socket, and the fragment as the HTTP route.
	return (configured.scheme === 'unix' || configured.scheme === 'pipe')
		&& destination.scheme === configured.scheme
		&& destination.path === configured.path;
}

/**
 * Implementation of the 2026-07-28 Streamable HTTP transport, the legacy
 * (2025-11-25) Streamable HTTP transport and legacy HTTP+SSE.
 *
 * The protocol engine tells the handle which revision a message belongs to
 * through its {@link IMcpMessageEnvelope}. A modern request probes the server
 * first: a 2xx or a recognized modern error means the server speaks the new
 * revision; any other 4xx means it is a legacy server, the request is aborted
 * with `legacy-probe` and the engine retries with the legacy handshake.
 * Messages without an envelope are legacy traffic and go on the wire exactly
 * as they always did (first POST decides between Streamable HTTP and SSE).
 */
export class McpHTTPHandle extends Disposable implements IMcpExtHostHandle {
	private readonly _requestSequencer = new Sequencer();
	private readonly _postEndpoint = new DeferredPromise<{ url: string; transport: McpServerTransportHTTP }>();
	private _mode: HttpModeT = { value: HttpMode.Unknown };
	private readonly _cts = new CancellationTokenSource();
	private readonly _abortCtrl = new AbortController();
	/** Per-request abort controllers, keyed by {@link requestKey}. */
	private readonly _requestAborts = new Map<string, AbortController>();
	/** The protocol version of the last enveloped message; legacy GET/DELETE requests reuse it. */
	private _protocolVersion: string | undefined;
	/** Discovery, token acquisition and challenge handling (OAuth 2.1). */
	private readonly _auth: McpAuthHeaderProvider;
	private _didSendClose = false;

	constructor(
		private readonly _id: number,
		private readonly _launch: McpServerTransportHTTP,
		private readonly _proxy: MainThreadMcpShape,
		private readonly _logService: ILogService,
		private readonly _errorOnUserInteraction?: boolean,
	) {
		super();

		this._auth = this._register(new McpAuthHeaderProvider({
			id: _id,
			launch: _launch,
			proxy: _proxy,
			errorOnUserInteraction: this._errorOnUserInteraction,
			protocolVersion: () => this._protocolVersion,
			fetchMetadata: (url, init, transportHeaders) => this._fetch(url, init, { isAuthMetadata: true, transportHeaders }),
			log: (level, message) => this._log(level, message),
		}));

		this._register(toDisposable(() => {
			this._abortCtrl.abort();
			for (const controller of this._requestAborts.values()) {
				controller.abort();
			}
			this._requestAborts.clear();
			this._cts.dispose(true);
		}));
		this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Running });
	}

	async send(message: string, envelope?: IMcpMessageEnvelope) {
		if (envelope) {
			this._protocolVersion = envelope.protocolVersion;
		}
		const era = envelope ? (eraForProtocolVersion(envelope.protocolVersion) ?? 'modern') : 'legacy';
		try {
			if (era === 'modern' && envelope) {
				await this._sendModern(message, envelope);
			} else if (this._mode.value === HttpMode.Unknown) {
				await this._requestSequencer.queue(() => this._send(message, envelope));
			} else {
				await this._send(message, envelope);
			}
		} catch (err) {
			if (envelope?.requestId !== undefined && this._wasCancelledLocally(envelope.requestId)) {
				return;
			}
			if (envelope?.requestId !== undefined) {
				this._abortRequest(envelope, { reason: 'transport-error', message: stringifyError(err) });
			}
			this._handleSendError(err);
		}
	}

	cancelRequest(requestId: JsonRpcId): void {
		const controller = this._requestAborts.get(requestKey(requestId));
		if (controller) {
			this._requestAborts.delete(requestKey(requestId));
			controller.abort();
		}
	}

	private _trackRequest(envelope: IMcpMessageEnvelope): AbortController | undefined {
		if (envelope.requestId === undefined) {
			return undefined;
		}
		const controller = new AbortController();
		this._requestAborts.set(requestKey(envelope.requestId), controller);
		return controller;
	}

	private _untrackRequest(envelope: IMcpMessageEnvelope): void {
		if (envelope.requestId !== undefined) {
			this._requestAborts.delete(requestKey(envelope.requestId));
		}
	}

	private _wasCancelledLocally(requestId: JsonRpcId): boolean {
		return !this._requestAborts.has(requestKey(requestId));
	}

	private _abortRequest(envelope: IMcpMessageEnvelope, abort: Omit<IMcpRequestAbort, 'requestId'>): void {
		this._untrackRequest(envelope);
		if (envelope.requestId !== undefined && !this._store.isDisposed) {
			this._proxy.$onDidAbortRequest(this._id, { requestId: envelope.requestId, ...abort });
		}
	}

	private _handleSendError(err: unknown): void {
		if (this._store.isDisposed) {
			return;
		}
		const message = `Error sending message to ${this._launch.uri}: ${stringifyError(err)}`;
		this.dispose();
		this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message });
	}

	async close() {
		if (this._mode.value === HttpMode.Http && this._mode.sessionId && !this._didSendClose) {
			this._didSendClose = true;
			try {
				await this._closeSession(this._mode.sessionId);
			} catch {
				// ignored -- already logged
			}
		}

		this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Stopped });
	}

	private _versionHeader(): Record<string, string> {
		return this._protocolVersion ? { [MCP_PROTOCOL_VERSION_HEADER]: this._protocolVersion } : {};
	}

	private async _closeSession(sessionId: string) {
		const headers: Record<string, string> = {
			...Object.fromEntries(this._launch.headers),
			...this._versionHeader(),
			'Mcp-Session-Id': sessionId,
		};

		try {
			await this._addAuthHeader(headers, { errorOnUserInteraction: true });
		} catch (e) {
			// If auth is no longer available (e.g. user signed out), skip the close request
			this._log(LogLevel.Debug, `Skipping session close: authentication no longer available`);
			return;
		}

		// no fetch with retry here -- don't try to auth if we get an auth failure
		await this._fetch(
			this._launch.uri.toString(true),
			{
				method: 'DELETE',
				headers,
			},
		);
	}

	private _send(message: string, envelope?: IMcpMessageEnvelope) {
		if (this._mode.value === HttpMode.SSE) {
			return this._sendLegacySSE(this._mode.endpoint, message, envelope);
		} else {
			return this._sendStreamableHttp(message, this._mode.value === HttpMode.Http ? this._mode.sessionId : undefined, envelope);
		}
	}

	/**
	 * Sends a 2026-07-28 request: POST only, no session, the response (JSON or
	 * an SSE stream) belongs to this request alone.
	 */
	private async _sendModern(message: string, envelope: IMcpMessageEnvelope): Promise<void> {
		if (this._mode.value === HttpMode.SSE) {
			this._abortRequest(envelope, { reason: 'unexpressible', message: 'The server uses the legacy HTTP+SSE transport' });
			return;
		}

		const controller = this._trackRequest(envelope);
		const asBytes = new TextEncoder().encode(message) as Uint8Array<ArrayBuffer>;
		const transportHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream, application/json',
			[MCP_PROTOCOL_VERSION_HEADER]: envelope.protocolVersion,
			...envelope.headers,
		};
		const headers: Record<string, string> = {
			...Object.fromEntries(this._launch.headers),
			...transportHeaders,
		};
		await this._addAuthHeader(headers);

		const res = await this._fetchWithAuthRetry(
			this._launch.uri.toString(true),
			{
				method: 'POST',
				headers,
				body: asBytes,
			},
			headers,
			transportHeaders,
			controller?.signal,
		);

		if (res.status >= 200 && res.status < 300) {
			if (this._mode.value === HttpMode.Unknown) {
				this._mode = { value: HttpMode.Modern };
			}
			await this._handleSuccessfulStreamableHttp(res, message, envelope, controller?.signal);
			this._untrackRequest(envelope);
			return;
		}

		const errText = await this._getErrText(res);
		if (res.status === 400 || res.status === 404 || res.status === 405) {
			const body = tryParseJson(errText);
			if (body !== undefined && isRecognizedModernError(res.status, body)) {
				// A modern server rejecting this request (unsupported version, header
				// mismatch, missing capability, unknown method): deliver the JSON-RPC error.
				if (this._mode.value === HttpMode.Unknown) {
					this._mode = { value: HttpMode.Modern };
				}
				this._untrackRequest(envelope);
				this._proxy.$onDidReceiveMessage(this._id, errText);
				return;
			}
			if (this._mode.value === HttpMode.Unknown) {
				this._log(LogLevel.Info, `${res.status} status for a ${envelope.protocolVersion} request to ${this._launch.uri}; the server does not speak this revision`);
				this._abortRequest(envelope, { reason: 'legacy-probe', httpStatus: res.status, message: errText });
				return;
			}
		}

		this._abortRequest(envelope, { reason: 'http-status', httpStatus: res.status, message: `${res.status} status sending message to ${this._launch.uri}: ${errText}` });
	}

	/**
	 * Sends a legacy streamable-HTTP request.
	 * 1. Posts to the endpoint
	 * 2. Updates internal state as needed. Falls back to SSE if appropriate.
	 * 3. If the response body is empty, JSON, or a JSON stream, handle it appropriately.
	 */
	private async _sendStreamableHttp(message: string, sessionId: string | undefined, envelope?: IMcpMessageEnvelope) {
		const asBytes = new TextEncoder().encode(message) as Uint8Array<ArrayBuffer>;
		const transportHeaders: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream, application/json',
		};
		if (envelope) {
			transportHeaders[MCP_PROTOCOL_VERSION_HEADER] = envelope.protocolVersion;
		}
		const headers: Record<string, string> = {
			...Object.fromEntries(this._launch.headers),
			...transportHeaders,
		};
		if (sessionId) {
			headers['Mcp-Session-Id'] = sessionId;
		}
		await this._addAuthHeader(headers);

		const res = await this._fetchWithAuthRetry(
			this._launch.uri.toString(true),
			{
				method: 'POST',
				headers,
				body: asBytes,
			},
			headers,
			transportHeaders,
		);

		const wasUnknown = this._mode.value === HttpMode.Unknown;

		// Mcp-Session-Id is the strongest signal that we're in streamable HTTP mode
		const nextSessionId = res.headers.get('Mcp-Session-Id');
		if (nextSessionId) {
			this._mode = { value: HttpMode.Http, sessionId: nextSessionId };
		}

		if (this._mode.value === HttpMode.Unknown &&
			// We care about 4xx errors...
			res.status >= 400 && res.status < 500
			// ...except for auth errors
			&& !isAuthStatusCode(res.status)
		) {
			this._log(LogLevel.Info, `${res.status} status sending message to ${this._launch.uri}, will attempt to fall back to legacy SSE`);
			this._sseFallbackWithMessage(message, envelope);
			return;
		}

		if (res.status >= 300) {
			// "When a client receives HTTP 404 in response to a request containing an Mcp-Session-Id, it MUST start a new session by sending a new InitializeRequest without a session ID attached"
			// Though this says only 404, some servers send 400s as well, including their example
			// https://github.com/modelcontextprotocol/typescript-sdk/issues/389
			const retryWithSessionId = this._mode.value === HttpMode.Http && !!this._mode.sessionId && (res.status === 400 || res.status === 404);

			this._proxy.$onDidChangeState(this._id, {
				state: McpConnectionState.Kind.Error,
				message: `${res.status} status sending message to ${this._launch.uri}: ${await this._getErrText(res)}` + (retryWithSessionId ? `; will retry with new session ID` : ''),
				shouldRetry: retryWithSessionId,
			});
			return;
		}

		if (this._mode.value === HttpMode.Unknown) {
			this._mode = { value: HttpMode.Http, sessionId: undefined };
		}
		if (wasUnknown) {
			this._attachStreamableBackchannel();
		}

		await this._handleSuccessfulStreamableHttp(res, message, envelope);
	}

	private async _sseFallbackWithMessage(message: string, envelope?: IMcpMessageEnvelope) {
		try {
			const endpoint = await this._attachSSE();
			if (endpoint) {
				this._mode = { value: HttpMode.SSE, endpoint };
				await this._sendLegacySSE(endpoint, message, envelope);
			}
		} catch (err) {
			this._handleSendError(err);
		}
	}

	/**
	 * Handles a 2xx response to a POST: nothing (202), a JSON body, or an SSE
	 * stream whose events are forwarded until it ends. With an envelope the
	 * stream is watched for the response to the request: a modern stream that
	 * ends without it aborts the request; a legacy stream that ends without it
	 * is resumed with `Last-Event-ID` when the server supports resumption.
	 */
	private async _handleSuccessfulStreamableHttp(res: CommonResponse, message: string, envelope?: IMcpMessageEnvelope, signal?: AbortSignal) {
		if (res.status === 202) {
			return; // no body
		}

		const contentType = res.headers.get('Content-Type')?.toLowerCase() || '';
		if (contentType.startsWith('text/event-stream')) {
			const watched = envelope?.requestId !== undefined && envelope.kind !== 'notification' ? envelope : undefined;
			let sawResponse = false;
			let lastEventId: string | undefined;
			let retryMs: number | undefined;
			const parser = new SSEParser(event => {
				if (event.id) {
					lastEventId = event.id;
				}
				if (event.retry) {
					retryMs = event.retry;
				}
				if (event.type === 'message') {
					if (watched && !sawResponse && isResponseFor(event.data, watched.requestId!)) {
						sawResponse = true;
					}
					this._proxy.$onDidReceiveMessage(this._id, event.data);
				} else if (event.type === 'endpoint' && this._mode.value !== HttpMode.Modern) {
					// An SSE server that didn't correctly return a 4xx status when we POSTed
					this._log(LogLevel.Warning, `Received SSE endpoint from a POST to ${this._launch.uri}, will fall back to legacy SSE`);
					this._sseFallbackWithMessage(message, envelope);
					throw new CancellationError(); // just to end the SSE stream
				}
			});

			let streamFailed = false;
			try {
				await this._doSSE(parser, res, signal);
			} catch (err) {
				streamFailed = true;
				this._log(LogLevel.Warning, `Error reading SSE stream: ${stringifyError(err)}`);
			}

			if (!watched || sawResponse || this._store.isDisposed || signal?.aborted) {
				return;
			}
			if (this._mode.value === HttpMode.Modern) {
				this._abortRequest(watched, { reason: streamFailed ? 'transport-error' : 'stream-closed', message: `The response stream for ${watched.method} ended before the response arrived` });
			} else if (lastEventId !== undefined && !streamFailed) {
				void this._resumeClosedStream(watched, lastEventId, retryMs ?? DEFAULT_SSE_RETRY_MS);
			} else {
				this._abortRequest(watched, { reason: streamFailed ? 'transport-error' : 'stream-closed', message: `The response stream for ${watched.method} ended before the response arrived` });
			}
		} else if (contentType.startsWith('application/json')) {
			this._proxy.$onDidReceiveMessage(this._id, await res.text());
		} else {
			const responseBody = await res.text();
			if (isJSON(responseBody)) { // try to read as JSON even if the server didn't set the content type
				this._proxy.$onDidReceiveMessage(this._id, responseBody);
			} else {
				this._log(LogLevel.Warning, `Unexpected ${res.status} response for request: ${responseBody}`);
			}
		}
	}

	/**
	 * Legacy Streamable HTTP: a POST stream that closed before delivering the
	 * response is resumed with a GET carrying `Last-Event-ID`, after the delay
	 * the server advertised in its `retry` field.
	 */
	private async _resumeClosedStream(envelope: IMcpMessageEnvelope, lastEventId: string, retryMs: number): Promise<void> {
		let sawResponse = false;
		for (let attempt = 0; attempt < MAX_LOST_STREAM_RETRIES && !this._store.isDisposed && !sawResponse; attempt++) {
			try {
				await timeout(retryMs, this._cts.token);
			} catch {
				return;
			}
			const transportHeaders: Record<string, string> = { 'Accept': 'text/event-stream', 'Last-Event-ID': lastEventId, ...this._versionHeader() };
			const headers: Record<string, string> = {
				...Object.fromEntries(this._launch.headers),
				...transportHeaders,
			};
			if (this._mode.value === HttpMode.Http && this._mode.sessionId !== undefined) {
				headers['Mcp-Session-Id'] = this._mode.sessionId;
			}
			let res: CommonResponse;
			try {
				await this._addAuthHeader(headers);
				res = await this._fetchWithAuthRetry(this._launch.uri.toString(true), { method: 'GET', headers }, headers, transportHeaders);
			} catch (err) {
				this._log(LogLevel.Info, `Error resuming the response stream of ${envelope.method}: ${stringifyError(err)}`);
				continue;
			}
			if (res.status >= 300) {
				this._log(LogLevel.Info, `${res.status} status resuming the response stream of ${envelope.method}: ${await this._getErrText(res)}`);
				break;
			}
			const parser = new SSEParser(event => {
				if (event.id) {
					lastEventId = event.id;
				}
				if (event.retry) {
					retryMs = event.retry;
				}
				if (event.type === 'message' && event.data) {
					this._proxy.$onDidReceiveMessage(this._id, event.data);
					if (isResponseFor(event.data, envelope.requestId!)) {
						sawResponse = true;
						throw new CancellationError(); // the resumed stream served its purpose
					}
				}
			});
			try {
				await this._doSSE(parser, res);
			} catch (err) {
				if (!sawResponse) {
					this._log(LogLevel.Info, `Error reading the resumed response stream of ${envelope.method}: ${stringifyError(err)}`);
				}
			}
		}
		if (!sawResponse) {
			this._abortRequest(envelope, { reason: 'stream-closed', message: `The response stream for ${envelope.method} ended before the response arrived and could not be resumed` });
		} else {
			this._untrackRequest(envelope);
		}
	}

	/**
	 * Attaches the SSE backchannel that streamable HTTP servers can use
	 * for async notifications. This is a "MAY" support, so if the server gives
	 * us a 4xx code, we'll stop trying to connect..
	 */
	private async _attachStreamableBackchannel() {
		let lastEventId: string | undefined;
		let canReconnectAt: number | undefined;
		for (let retry = 0; !this._store.isDisposed; retry++) {
			if (canReconnectAt !== undefined) {
				await timeout(Math.max(0, canReconnectAt - Date.now()), this._cts.token);
				canReconnectAt = undefined;
			} else {
				await timeout(Math.min(retry * 1000, 30_000), this._cts.token);
			}

			let res: CommonResponse;
			try {
				const transportHeaders: Record<string, string> = { 'Accept': 'text/event-stream', ...this._versionHeader() };
				if (lastEventId) {
					transportHeaders['Last-Event-ID'] = lastEventId;
				}
				const headers: Record<string, string> = {
					...Object.fromEntries(this._launch.headers),
					...transportHeaders,
				};
				await this._addAuthHeader(headers);

				if (this._mode.value === HttpMode.Http && this._mode.sessionId !== undefined) {
					headers['Mcp-Session-Id'] = this._mode.sessionId;
				}

				res = await this._fetchWithAuthRetry(
					this._launch.uri.toString(true),
					{
						method: 'GET',
						headers,
					},
					headers,
					transportHeaders,
				);
			} catch (e) {
				this._log(LogLevel.Info, `Error connecting to ${this._launch.uri} for async notifications, will retry`);
				continue;
			}

			if (res.status >= 400) {
				this._log(LogLevel.Debug, `${res.status} status connecting to ${this._launch.uri} for async notifications; they will be disabled: ${await this._getErrText(res)}`);
				return;
			}

			// Only reset the retry counter if we definitely get an event stream to avoid
			// spamming servers that (incorrectly) don't return one from this endpoint.
			if (res.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
				retry = 0;
			}

			const parser = new SSEParser(event => {
				if (event.retry) {
					canReconnectAt = Date.now() + event.retry;
				}
				if (event.type === 'message' && event.data) {
					this._proxy.$onDidReceiveMessage(this._id, event.data);
				}
				if (event.id) {
					lastEventId = event.id;
				}
			});

			try {
				await this._doSSE(parser, res);
			} catch (e) {
				this._log(LogLevel.Info, `Error reading from async stream, we will reconnect: ${e}`);
			}
		}
	}

	/**
	 * Starts a legacy SSE attachment, where the SSE response is the session lifetime.
	 * Unlike `_attachStreamableBackchannel`, this fails the server if it disconnects.
	 */
	private async _attachSSE(): Promise<string | undefined> {
		const postEndpoint = new DeferredPromise<string>();
		const transportHeaders: Record<string, string> = { 'Accept': 'text/event-stream', ...this._versionHeader() };
		const headers: Record<string, string> = {
			...Object.fromEntries(this._launch.headers),
			...transportHeaders,
		};
		await this._addAuthHeader(headers);

		let res: CommonResponse;
		try {
			res = await this._fetchWithAuthRetry(
				this._launch.uri.toString(true),
				{
					method: 'GET',
					headers,
				},
				headers,
				transportHeaders,
			);
			if (res.status >= 300) {
				this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message: `${res.status} status connecting to ${this._launch.uri} as SSE: ${await this._getErrText(res)}` });
				return;
			}
		} catch (e) {
			this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message: `Error connecting to ${this._launch.uri} as SSE: ${e}` });
			return;
		}

		const parser = new SSEParser(event => {
			if (event.type === 'message') {
				this._proxy.$onDidReceiveMessage(this._id, event.data);
			} else if (event.type === 'endpoint') {
				postEndpoint.complete(new URL(event.data, this._launch.uri.toString(true)).toString());
			}
		});

		this._register(toDisposable(() => postEndpoint.cancel()));
		this._doSSE(parser, res).catch(err => {
			this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message: `Error reading SSE stream: ${stringifyError(err)}` });
		});

		return postEndpoint.p;
	}

	/**
	 * Sends a legacy SSE message to the server. The response is always empty and
	 * is otherwise received in {@link _attachSSE}'s loop.
	 */
	private async _sendLegacySSE(url: string, message: string, envelope?: IMcpMessageEnvelope) {
		const asBytes = new TextEncoder().encode(message) as Uint8Array<ArrayBuffer>;
		const transportHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
		if (envelope) {
			transportHeaders[MCP_PROTOCOL_VERSION_HEADER] = envelope.protocolVersion;
		}
		const headers: Record<string, string> = {
			...Object.fromEntries(this._launch.headers),
			...transportHeaders,
		};
		await this._addAuthHeader(headers);
		const res = await this._fetch(url, {
			method: 'POST',
			headers,
			body: asBytes,
		}, { transportHeaders });

		if (res.status >= 300) {
			this._log(LogLevel.Warning, `${res.status} status sending message to ${this._postEndpoint}: ${await this._getErrText(res)}`);
		}
	}

	/** Generic handle to pipe a response into an SSE parser. */
	private async _doSSE(parser: SSEParser, res: CommonResponse, signal?: AbortSignal) {
		if (!res.body) {
			return;
		}

		const reader = res.body.getReader();
		const onAbort = () => { reader.cancel().catch(() => { }); };
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			do {
				try {
					chunk = await raceCancellationError(reader.read(), this._cts.token);
				} catch (err) {
					if (this._store.isDisposed || signal?.aborted) {
						return;
					}
					await reader.cancel();
					throw err;
				}

				if (chunk.value) {
					parser.feed(chunk.value);
				}
			} while (!chunk.done);
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
	}

	private _addAuthHeader(headers: Record<string, string>, options?: { errorOnUserInteraction?: boolean }) {
		return this._auth.addAuthHeader(headers, options);
	}

	private _log(level: LogLevel, message: string) {
		if (!this._store.isDisposed) {
			this._proxy.$onDidPublishLog(this._id, level, message);
		}
	}

	private async _getErrText(res: CommonResponse) {
		try {
			return await res.text();
		} catch {
			return res.statusText;
		}
	}

	/**
	 * Sends a request and answers its authorization challenges: a `401` (with
	 * or without a token) or a `403` with `insufficient_scope` is handed to
	 * {@link McpAuthHeaderProvider.handleChallenge}, which re-discovers the
	 * authorization server and obtains a new token, and the request is sent
	 * again, at most {@link MCP_OAUTH_MAX_CHALLENGE_CYCLES} times. A terminal
	 * authorization failure ({@link OAuthClientError}) is thrown, which puts
	 * the connection in the error state; any other challenged response is
	 * returned as is.
	 */
	private async _fetchWithAuthRetry(mcpUrl: string, init: MinimalRequestInit, headers: Record<string, string>, transportHeaders?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<CommonResponse> {
		const doFetch = () => this._fetch(mcpUrl, init, { transportHeaders, signal });

		let res = await doFetch();
		for (let cycle = 0; isAuthStatusCode(res.status); cycle++) {
			if (cycle >= MCP_OAUTH_MAX_CHALLENGE_CYCLES) {
				this._log(LogLevel.Warning, `${res.status} status from ${mcpUrl} after ${cycle} authorization attempts; giving up on this request`);
				break;
			}
			const retry = await this._auth.handleChallenge(res.status, res.headers.get('WWW-Authenticate') ?? undefined, headers);
			if (!retry) {
				break;
			}
			const errorText = await this._getErrText(res);
			this._log(LogLevel.Debug, `Retrying after a ${res.status} status with a new token. Error details: ${redact(errorText) || 'no additional details'}`);
			init.headers = headers;
			res = await doFetch();
		}
		if (res.status < 400) {
			this._auth.onDidAccept(headers);
		}
		return res;
	}

	private async _fetch(url: string, init: MinimalRequestInit, options: { isAuthMetadata?: boolean; transportHeaders?: Readonly<Record<string, string>>; signal?: AbortSignal } = {}): Promise<CommonResponse> {
		const signal = options.signal ? AbortSignal.any([this._abortCtrl.signal, options.signal]) : this._abortCtrl.signal;
		const destination = new URL(url);
		const configuredUrl = this._launch.uri.toString(true);
		const isHttp = HTTP_PROTOCOLS.has(destination.protocol);
		const isSameOrigin = isHttp
			? destination.origin === new URL(configuredUrl).origin
			: isSameSocketEndpoint(url, configuredUrl);
		if (!isHttp && !isSameOrigin) {
			throw new Error(localize('mcpUnsupportedDestination', "MCP server selected a non-http(s) destination ({0}), which is not allowed", destination.protocol));
		}

		const transportHeaders = { ...options.transportHeaders, 'user-agent': `${product.nameLong}/${product.version}` };
		init = { ...init, headers: { ...init.headers } };
		for (const [name, value] of Object.entries(transportHeaders)) {
			setHostHeader(init.headers, name, value);
		}
		if (!isSameOrigin) {
			init.headers = this._stripCrossOriginHeaders(init.headers, transportHeaders);
		}

		if (canLog(this._logService.getLevel(), LogLevel.Trace)) {
			const traceObj: any = { ...init, headers: { ...init.headers } };
			if (traceObj.body) {
				traceObj.body = new TextDecoder().decode(traceObj.body);
			}
			traceObj.headers = redactCredentialHeaders(traceObj.headers); // don't log credentials
			this._log(LogLevel.Trace, `Fetching ${url} with options: ${JSON.stringify(traceObj)}`);
		}

		let currentUrl = url;
		let response!: CommonResponse;
		for (let redirectCount = 0; redirectCount < MAX_FOLLOW_REDIRECTS; redirectCount++) {
			if (this._cts.token.isCancellationRequested) {
				throw new CancellationError();
			}
			if (!options.isAuthMetadata) {
				const denied = await raceCancellationError(this._proxy.$checkMcpServerAllowed(this._id, currentUrl), this._cts.token);
				if (denied !== undefined) {
					this.dispose();
					this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message: denied });
					throw new Error(denied);
				}
			}
			if (this._cts.token.isCancellationRequested) {
				throw new CancellationError();
			}
			response = await this._fetchInternal(currentUrl, {
				...init,
				signal,
				redirect: 'manual'
			});

			// Check for redirect status codes (301, 302, 303, 307, 308)
			if (!REDIRECT_STATUS_CODES.includes(response.status)) {
				break;
			}

			const location = response.headers.get('location');
			if (!location) {
				break;
			}

			const currentUrlParsed = new URL(currentUrl);
			const nextUrlParsed = new URL(location, currentUrl);

			// Only follow redirects to http(s). Blocks a malicious Location header from
			// reaching the unix:// / pipe:// socket dispatcher or other local schemes.
			// Fail closed so the connection errors deterministically rather than the
			// caller treating the 3xx response as final.
			if (!HTTP_PROTOCOLS.has(nextUrlParsed.protocol)) {
				throw new Error(`MCP server redirected to a non-http(s) target (${nextUrlParsed.protocol}), which is not allowed`);
			}

			if (currentUrlParsed.origin !== nextUrlParsed.origin) {
				init.headers = this._stripCrossOriginHeaders(init.headers, transportHeaders);
			}

			const nextUrl = nextUrlParsed.toString();
			this._log(LogLevel.Trace, redact(`Redirect (${response.status}) from ${currentUrl} to ${nextUrl}`));
			currentUrl = nextUrl;
			// Per fetch spec, for 303 always use GET, keep method unless original was POST and 301/302, then GET.
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && init.method === 'POST')) {
				init.method = 'GET';
				delete init.body;
			}
		}

		if (canLog(this._logService.getLevel(), LogLevel.Trace)) {
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => { headers[key] = value; });
			this._log(LogLevel.Trace, `Fetched ${currentUrl}: ${JSON.stringify({
				status: response.status,
				headers: redactCredentialHeaders(headers),
			})}`);
		}

		return response;
	}

	private _stripCrossOriginHeaders(headers: Record<string, string>, transportHeaders: Readonly<Record<string, string>>): Record<string, string> {
		const configuredNames = new Set(this._launch.headers.map(([name]) => name.toLowerCase()));
		const filtered = Object.fromEntries(Object.entries(headers).filter(([name]) =>
			!CROSS_ORIGIN_STRIPPED_HEADERS.has(name.toLowerCase()) && !configuredNames.has(name.toLowerCase())));
		for (const [name, value] of Object.entries(transportHeaders)) {
			setHostHeader(filtered, name, value);
		}
		return filtered;
	}

	protected _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
		return fetch(url, init);
	}
}

interface MinimalRequestInit {
	method: string;
	headers: Record<string, string>;
	body?: Uint8Array<ArrayBuffer>;
}

export interface CommonRequestInit extends MinimalRequestInit {
	signal?: AbortSignal;
	redirect?: RequestRedirect;
}

export interface CommonResponse {
	status: number;
	statusText: string;
	headers: Headers;
	body?: ReadableStream | null;
	url: string;
	json(): Promise<any>;
	text(): Promise<string>;
}

function isJSON(str: string): boolean {
	try {
		JSON.parse(str);
		return true;
	} catch (e) {
		return false;
	}
}

function isAuthStatusCode(status: number): boolean {
	return status === 401 || status === 403;
}


//#region AuthMetadata

/**
 * Logger callback type for AuthMetadata operations.
 */
export type AuthMetadataLogger = (level: LogLevel, message: string) => void;

/**
 * Interface for authentication metadata that can be updated when scopes change.
 */
export interface IAuthMetadata {
	readonly authorizationServer: URI;
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined;
	/** The canonical URI of the MCP server, the RFC 8707 `resource` its tokens are requested for. */
	readonly resource: string;
	readonly scopes: string[] | undefined;
	/** Telemetry data about how auth metadata was discovered */
	readonly telemetry: IAuthMetadataSource;

	/**
	 * Updates the scopes based on the WWW-Authenticate header in the response.
	 * @param response The HTTP response containing potential scope challenges
	 * @returns true if scopes were updated, false otherwise
	 */
	update(responseHeaders: Headers): boolean;
}

/**
 * Concrete implementation of IAuthMetadata that manages OAuth authentication metadata.
 * Consumers should use {@link createAuthMetadata} to create instances.
 */
class AuthMetadata implements IAuthMetadata {
	private _scopes: string[] | undefined;

	constructor(
		public readonly authorizationServer: URI,
		public readonly serverMetadata: IAuthorizationServerMetadata,
		public readonly resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined,
		public readonly resource: string,
		scopes: string[] | undefined,
		public readonly telemetry: IAuthMetadataSource,
		private readonly _log: AuthMetadataLogger,
	) {
		this._scopes = scopes;
	}

	get scopes(): string[] | undefined {
		return this._scopes;
	}

	/** The `authorization_servers` entry as the resource lists it (no URI normalization). */
	authorizationServerIdentifier: string | undefined;

	/** Replaces the scopes tokens are requested with (a step-up's union, for example). */
	setScopes(scopes: string[] | undefined): void {
		this._scopes = scopes && scopes.length > 0 ? scopes : undefined;
	}

	update(responseHeaders: Headers): boolean {
		const scopesChallenge = this._parseScopesFromResponse(responseHeaders);
		if (!scopesMatch(scopesChallenge, this._scopes)) {
			this._log(LogLevel.Info, `Scopes changed from ${JSON.stringify(this._scopes)} to ${JSON.stringify(scopesChallenge)}, updating`);
			this._scopes = scopesChallenge;
			return true;
		}
		return false;
	}

	private _parseScopesFromResponse(responseHeaders: Headers): string[] | undefined {
		const authHeader = responseHeaders.get('WWW-Authenticate');
		if (!authHeader) {
			return undefined;
		}
		const challenges = parseWWWAuthenticateHeader(authHeader);
		for (const challenge of challenges) {
			if (challenge.scheme === 'Bearer' && challenge.params['scope']) {
				const scopes = challenge.params['scope'].split(AUTH_SCOPE_SEPARATOR).filter(s => s.trim().length);
				if (scopes.length) {
					this._log(LogLevel.Info, `Found scope challenge in WWW-Authenticate header: ${challenge.params['scope']}`);
					return scopes;
				}
			}
		}
		return undefined;
	}
}

/**
 * Options for creating AuthMetadata.
 */
export interface ICreateAuthMetadataOptions {
	/** Headers to include when fetching metadata from the same origin as the resource server */
	sameOriginHeaders?: Record<string, string>;
	/** Fetch function to use for HTTP requests */
	fetch: (url: string, init: MinimalRequestInit) => Promise<CommonResponse>;
	/** Logger function for diagnostic output */
	log: AuthMetadataLogger;
	/**
	 * The protocol revision of the challenged request. Metadata requests to the
	 * resource's own origin carry it as `MCP-Protocol-Version`; defaults to the
	 * latest legacy revision.
	 */
	protocolVersion?: string;
	/** The server's authorization policy (`oauth` escape hatches); defaults to PKCE required, HTTPS or loopback only. */
	policy?: IMcpOAuthServerPolicy;
	/**
	 * An authorization server this client already obtained tokens from for the
	 * resource; it is selected when the resource still lists it, otherwise the
	 * first listed authorization server is.
	 */
	registeredAuthorizationServer?: string;
	token?: CancellationToken;
}

/** A storage that only answers which authorization server already has a registration, for the authorization server selection rule. */
class RegisteredAuthorizationServerStorage implements IOAuthClientStorage {
	constructor(private readonly _issuer: string) { }

	async get(_key: string): Promise<IOAuthClientRecord | undefined> {
		return { issuer: this._issuer, registrationKind: 'dcr', clientId: '', tokenEndpointAuthMethod: 'none', authorizationRequests: 0 };
	}

	async set(): Promise<void> { /* discovery stores nothing */ }

	async delete(): Promise<void> { /* discovery stores nothing */ }
}

function toLogLevel(level: OAuthLogLevel): LogLevel {
	switch (level) {
		case 'error': return LogLevel.Error;
		case 'warn': return LogLevel.Warning;
		default: return LogLevel.Info;
	}
}

/**
 * Discovers the OAuth metadata of an MCP server with the rules of the MCP
 * 2026-07-28 authorization specification ({@link OAuthClient.discover}):
 *
 * 1. the protected resource metadata (RFC 9728) from the challenge's
 *    `resource_metadata`, then the path-based, then the root well-known URI;
 *    its `resource` must name the server;
 * 2. the authorization server: the listed one that already has a registration,
 *    otherwise the first listed one;
 * 3. its metadata in the specification's discovery order, whose `issuer` must
 *    equal the authorization server identifier exactly; its endpoints must be
 *    HTTPS (or loopback) unless the server's policy allows HTTP;
 * 4. only a server without protected resource metadata falls back to the
 *    2025-03-26 default endpoints at its origin.
 *
 * Any violation is a terminal {@link OAuthClientError}. PKCE support is
 * checked by whoever runs the authorization code grant (VS Code's dynamic
 * authentication provider or the conformance client); a server whose policy
 * is `assume-supported` gets `S256` added to the metadata it hands on.
 *
 * @param resourceUrl The resource server URL
 * @param initialResponseHeaders The headers of the challenged response (its `WWW-Authenticate`)
 * @param options Configuration options including headers, fetch function, and logger
 * @returns A new AuthMetadata instance
 */
export async function createAuthMetadata(
	resourceUrl: string,
	initialResponseHeaders: Headers,
	options: ICreateAuthMetadataOptions
): Promise<AuthMetadata> {
	const { fetch, log } = options;
	const wwwAuthenticate = initialResponseHeaders.get('WWW-Authenticate') ?? undefined;
	const challenge = parseBearerChallenge(wwwAuthenticate);
	if (challenge?.resourceMetadataUrl) {
		log(LogLevel.Debug, `Found resource_metadata challenge in WWW-Authenticate header: ${challenge.resourceMetadataUrl}`);
	}
	if (challenge?.scope) {
		log(LogLevel.Debug, `Found scope challenge in WWW-Authenticate header: ${challenge.scope}`);
	}

	const policy = options.policy ?? resolveMcpOAuthPolicy(undefined);
	const protocolVersion = options.protocolVersion ?? MCPLegacy.LATEST_PROTOCOL_VERSION;
	const sameOriginHeaders = { ...options.sameOriginHeaders, [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion };
	const client = createMcpOAuthClient({
		clientName: product.nameLong,
		redirectUris: ['http://127.0.0.1/'],
		// Discovery only: the grant runs elsewhere, so no registration and no browser.
		registration: { dynamic: false },
		authorize: () => Promise.reject(new Error('Authorization metadata discovery does not authorize')),
		policy: { ...policy, pkce: 'assume-supported' },
		storage: options.registeredAuthorizationServer ? new RegisteredAuthorizationServerStorage(options.registeredAuthorizationServer) : undefined,
		fetch: (url, init) => fetch(url, { method: init.method ?? 'GET', headers: { ...init.headers } }),
		sameOriginHeaders,
		legacyDefaultEndpoints: true,
		log: (level, message) => log(toLogLevel(level), message),
	});
	try {
		const discovery = await client.discover(resourceUrl, wwwAuthenticate, options.token);
		const resourceMetadataSource = !discovery.resourceMetadata
			? IAuthResourceMetadataSource.None
			: challenge?.resourceMetadataUrl !== undefined && discovery.resourceMetadataUrl === challenge.resourceMetadataUrl ? IAuthResourceMetadataSource.Header : IAuthResourceMetadataSource.WellKnown;
		const serverMetadataSource = discovery.resourceMetadata
			? IAuthServerMetadataSource.ResourceMetadata
			: discovery.legacyDefaults ? IAuthServerMetadataSource.Default : IAuthServerMetadataSource.WellKnown;
		if (discovery.resourceMetadataUrl) {
			log(LogLevel.Info, `Discovered resource metadata at ${discovery.resourceMetadataUrl}`);
			log(LogLevel.Info, `Using auth server metadata url: ${discovery.authorizationServer}`);
		}
		if (discovery.legacyDefaults) {
			log(LogLevel.Info, 'Using default auth metadata');
		}
		let serverMetadata = discovery.serverMetadata;
		if (policy.pkce === 'assume-supported' && !serverMetadata.code_challenge_methods_supported?.includes('S256')) {
			log(LogLevel.Info, `The authorization server ${serverMetadata.issuer} does not advertise PKCE S256; assuming support as configured`);
			serverMetadata = { ...serverMetadata, code_challenge_methods_supported: [...(serverMetadata.code_challenge_methods_supported ?? []), 'S256'] };
		}
		const challengeScopes = challenge?.scope?.split(AUTH_SCOPE_SEPARATOR).filter(s => s.trim().length);
		const scopes = challengeScopes?.length ? challengeScopes : discovery.resourceMetadata?.scopes_supported;
		const metadata = new AuthMetadata(
			URI.parse(discovery.authorizationServer),
			serverMetadata,
			discovery.resourceMetadata,
			discovery.resource,
			scopes ? [...scopes] : undefined,
			{ resourceMetadataSource, serverMetadataSource },
			log
		);
		metadata.authorizationServerIdentifier = discovery.authorizationServer;
		return metadata;
	} finally {
		client.dispose();
	}
}

//#endregion

//#region McpAuthHeaderProvider

/** The headers that carry credentials; trace logs show them blanked. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

/** A copy of `headers` with the credential-bearing ones blanked, for trace logs. */
function redactCredentialHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return headers;
	}
	const copy: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		copy[name] = CREDENTIAL_HEADERS.has(name.toLowerCase()) ? '***' : value;
	}
	return copy;
}

function bearerTokenOf(headers: Readonly<Record<string, string>>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === 'authorization' && /^bearer\s+/i.test(value)) {
			return value.replace(/^bearer\s+/i, '');
		}
	}
	return undefined;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) {
			delete headers[key];
		}
	}
}

/** Every {@link OAuthClientError} (it survives the RPC boundary by name and code) ends the authorization flow. */
function isTerminalAuthorizationError(error: unknown): error is Error {
	return error instanceof OAuthClientError || (error instanceof Error && error.name === 'OAuthClientError');
}

function splitScopeParameter(scope: string | undefined): string[] {
	return scope ? scope.split(AUTH_SCOPE_SEPARATOR).filter(s => s.trim().length > 0) : [];
}

		return new AuthMetadata(
			URI.parse(serverMetadataUrl),
			metadata,
			resource,
			scopesChallenge,
			{ resourceMetadataSource, serverMetadataSource },
			log
		);
	} catch (e) {
		log(LogLevel.Warning, `Error populating auth server metadata for ${serverMetadataUrl}: ${String(e)}`);
	}

	// If there's no well-known server metadata, then use the default values based off of the url.
	const defaultMetadata = getDefaultMetadataForUrl(new URL(baseUrl));
	log(LogLevel.Info, 'Using default auth metadata');
	return new AuthMetadata(
		URI.parse(baseUrl),
		defaultMetadata,
		resource,
		scopesChallenge,
		{ resourceMetadataSource, serverMetadataSource: IAuthServerMetadataSource.Default },
		log
	);
}

/**
 * Supplies the `Authorization` header of an MCP transport and answers its
 * authorization challenges with the rules of the MCP 2026-07-28 authorization
 * specification. The Streamable HTTP transport uses it, and so can any
 * transport that maps its own status codes to `401` (unauthenticated) and
 * `403` with an `insufficient_scope` challenge (insufficient permission).
 *
 * - Before the first challenge no token is sent.
 * - A `401` re-discovers the authorization server (it may have moved) and asks
 *   the main thread for a token, naming the rejected one; after two
 *   consecutive rejections of freshly issued tokens the client registers anew.
 * - A `403` with `insufficient_scope` steps up to the union of the held and
 *   the demanded scopes, at most twice per resource for the lifetime of the
 *   process; a fresh token that is still insufficient for the scopes it was
 *   issued for is terminal (`step_up_limit`).
 * - Challenges are handled one at a time; a request whose token was already
 *   replaced is retried with the new one.
 */
export class McpAuthHeaderProvider extends Disposable {
	private _metadata: AuthMetadata | undefined;
	private readonly _challenges = new Sequencer();
	/** The token most recently put on a request. */
	private _currentToken: string | undefined;
	/** The token the last challenge handling obtained, and the scopes it was requested for. */
	private _issued: { readonly token: string; readonly scopes: readonly string[] } | undefined;
	/** Consecutive rejections (401) of tokens obtained by challenge handling. */
	private _rejections = 0;
	/** The authorization server tokens were obtained from, preferred on re-discovery. */
	private _registeredAuthorizationServer: string | undefined;
	private readonly _stepUps: Map<string, number>;

	constructor(private readonly _host: IMcpAuthHeaderProviderHost) {
		super();
		this._stepUps = _host.stepUps ?? processStepUps;
	}

	/** The metadata of the last discovery, if a challenge was handled. */
	get metadata(): IAuthMetadata | undefined {
		return this._metadata;
	}

	private get _resourceUrl(): string {
		return this._host.resourceUrl?.() ?? this._host.launch.uri.toString(true);
	}

	/** Adds the `Authorization` header for a request, when a token is (or can silently be) available. */
	async addAuthHeader(headers: Record<string, string>, options?: { errorOnUserInteraction?: boolean }): Promise<Record<string, string>> {
		const errorOnUserInteraction = options?.errorOnUserInteraction ?? this._host.errorOnUserInteraction;
		if (this._host.launch.authentication) {
			const token = await this._requestProviderToken({ errorOnUserInteraction });
			if (token) {
				this._setToken(headers, token);
			}
		} else if (this._metadata) {
			const token = await this._requestToken({ errorOnUserInteraction });
			if (token) {
				this._setToken(headers, token);
			}
		}
		return headers;
	}

	/**
	 * Handles a challenge to a request that carried `headers`. Returns true
	 * when `headers` now carry a (new) token and the request should be sent
	 * again; false when the response stands. Throws a terminal
	 * {@link OAuthClientError}.
	 */
	async handleChallenge(status: number, wwwAuthenticate: string | undefined, headers: Record<string, string>, token: CancellationToken = CancellationToken.None): Promise<boolean> {
		const challenge = parseBearerChallenge(wwwAuthenticate);
		const insufficientScope = status === 403 && challenge?.error === 'insufficient_scope';
		if (status !== 401 && !insufficientScope) {
			return false;
		}
		const sentToken = bearerTokenOf(headers);
		return this._challenges.queue(async () => {
			if (this._store.isDisposed || token.isCancellationRequested) {
				throw new CancellationError();
			}
			// Another request answered a challenge while this one was in flight: retry with its token.
			if (this._currentToken !== undefined && this._currentToken !== sentToken && (this._metadata || this._host.launch.authentication)) {
				this._setToken(headers, this._currentToken);
				return true;
			}
			if (this._host.launch.authentication) {
				return this._handleProviderChallenge(headers, sentToken);
			}

			const previous = this._metadata;
			// Re-discover before asking for a token: the resource may name another authorization server now.
			const metadata = await this._discover(wwwAuthenticate, token);
			if (!previous) {
				this._host.proxy.$logMcpAuthSetup(metadata.telemetry);
			} else if (previous.serverMetadata.issuer !== metadata.serverMetadata.issuer) {
				this._host.log(LogLevel.Info, `The authorization server of ${metadata.resource} changed from ${previous.serverMetadata.issuer} to ${metadata.serverMetadata.issuer}`);
				this._issued = undefined;
				this._rejections = 0;
			}

			let rejectedToken: string | undefined;
			let forceNewRegistration = false;
			if (insufficientScope) {
				const held = previous?.scopes ?? this._issued?.scopes ?? [];
				const union = [...new Set([...held, ...splitScopeParameter(challenge.scope)])];
				if (sentToken !== undefined && this._issued?.token === sentToken && union.every(scope => this._issued!.scopes.includes(scope))) {
					throw new OAuthClientError('step_up_limit', localize('mcp.oauth.stepUpExhausted', "The MCP server at {0} still reports insufficient scope for a token that was issued for every scope it demands ({1}).", metadata.resource, union.join(' ')));
				}
				const stepUps = this._stepUps.get(metadata.resource) ?? 0;
				if (stepUps >= MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS - 1) {
					throw new OAuthClientError('step_up_limit', localize('mcp.oauth.stepUpLimit', "Not authorizing the MCP server at {0} again: it demanded more scopes {1} times.", metadata.resource, stepUps + 1));
				}
				this._stepUps.set(metadata.resource, stepUps + 1);
				this._host.log(LogLevel.Info, `Stepping up the authorization for ${metadata.resource} to scope '${union.join(' ')}'`);
				metadata.setScopes(union);
			} else {
				if (previous?.scopes?.length) {
					// Re-authorization keeps the scopes already held (SEP-2350).
					metadata.setScopes([...new Set([...previous.scopes, ...splitScopeParameter(challenge?.scope)])]);
				}
				if (sentToken !== undefined) {
					rejectedToken = sentToken;
					this._rejections = this._issued?.token === sentToken ? this._rejections + 1 : 1;
					forceNewRegistration = this._rejections >= MCP_OAUTH_REJECTIONS_BEFORE_REREGISTRATION;
					this._host.log(LogLevel.Info, `The MCP server rejected its access token (${this._rejections} in a row)${forceNewRegistration ? '; registering the client again' : ''}`);
				}
			}
			this._metadata = metadata;

			deleteHeader(headers, 'Authorization');
			const newToken = await this._requestToken({ errorOnUserInteraction: this._host.errorOnUserInteraction, forceNewRegistration, rejectedToken });
			if (!newToken || newToken === sentToken) {
				return false;
			}
			this._issued = { token: newToken, scopes: metadata.scopes ?? [] };
			this._setToken(headers, newToken);
			return true;
		});
	}

	/** Records that a request carrying `headers` was answered without a challenge: the rejection streak ends. */
	onDidAccept(headers: Readonly<Record<string, string>>): void {
		if (bearerTokenOf(headers) !== undefined) {
			this._rejections = 0;
		}
	}

	protected _discover(wwwAuthenticate: string | undefined, token: CancellationToken): Promise<AuthMetadata> {
		const protocolVersion = this._host.protocolVersion() ?? MCPLegacy.LATEST_PROTOCOL_VERSION;
		const policy = resolveMcpOAuthPolicy(this._host.launch.oauth as IMcpRemoteServerOAuthConfiguration | undefined);
		return createAuthMetadata(this._resourceUrl, new Headers(wwwAuthenticate !== undefined ? { 'WWW-Authenticate': wwwAuthenticate } : {}), {
			sameOriginHeaders: Object.fromEntries(this._host.launch.headers),
			protocolVersion,
			policy,
			registeredAuthorizationServer: this._registeredAuthorizationServer,
			fetch: (url, init) => this._host.fetchMetadata(url, init, init.headers[MCP_PROTOCOL_VERSION_HEADER] === protocolVersion ? { [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion } : undefined),
			log: (level, message) => this._host.log(level, message),
			token,
		});
	}

	private _setToken(headers: Record<string, string>, token: string): void {
		setHostHeader(headers, 'Authorization', `Bearer ${token}`);
		this._currentToken = token;
	}

	private async _requestToken(options: { errorOnUserInteraction?: boolean; forceNewRegistration?: boolean; rejectedToken?: string }): Promise<string | undefined> {
		const metadata = this._metadata;
		if (!metadata) {
			return undefined;
		}
		const details: IMcpAuthenticationDetails = {
			authorizationServer: metadata.authorizationServer.toJSON(),
			authorizationServerMetadata: metadata.serverMetadata,
			resourceMetadata: metadata.resourceMetadata,
			scopes: metadata.scopes,
			resource: metadata.resource,
			clientId: this._host.launch.oauth?.clientId,
			enterpriseManaged: this._host.launch.oauth?.enterpriseManaged,
		};
		try {
			const token = await this._host.proxy.$getTokenFromServerMetadata(this._host.id, details, {
				errorOnUserInteraction: options.errorOnUserInteraction,
				forceNewRegistration: options.forceNewRegistration || undefined,
				rejectedToken: options.rejectedToken,
			});
			if (token) {
				this._registeredAuthorizationServer = metadata.authorizationServerIdentifier;
			}
			return token;
		} catch (e) {
			if (UserInteractionRequiredError.is(e)) {
				this._host.proxy.$onDidChangeState(this._host.id, { state: McpConnectionState.Kind.Stopped, reason: 'needs-user-interaction' });
				throw new CancellationError();
			}
			if (isTerminalAuthorizationError(e)) {
				throw e;
			}
			this._host.log(LogLevel.Warning, `Error getting token from server metadata: ${redact(String(e))}`);
			return undefined;
		}
	}

	private async _requestProviderToken(options: { errorOnUserInteraction?: boolean; forceNewRegistration?: boolean }): Promise<string | undefined> {
		const authentication = this._host.launch.authentication;
		if (!authentication) {
			return undefined;
		}
		try {
			this._host.log(LogLevel.Debug, `Using provided authentication config: providerId=${authentication.providerId}, scopes=${authentication.scopes.join(', ')}`);
			const token = await this._host.proxy.$getTokenForProviderId(this._host.id, authentication.providerId, authentication.scopes, {
				errorOnUserInteraction: options.errorOnUserInteraction,
				forceNewRegistration: options.forceNewRegistration,
				clientId: this._host.launch.oauth?.clientId,
			});
			if (token) {
				this._host.log(LogLevel.Info, 'Successfully obtained token from provided authentication config');
			}
			return token;
		} catch (e) {
			if (UserInteractionRequiredError.is(e)) {
				this._host.proxy.$onDidChangeState(this._host.id, { state: McpConnectionState.Kind.Stopped, reason: 'needs-user-interaction' });
				throw new CancellationError();
			}
			this._host.log(LogLevel.Warning, `Error getting token from provided authentication config: ${redact(String(e))}`);
			return undefined;
		}
	}

	/** A configured authentication provider: one more token, a fresh one when the last was rejected. */
	private async _handleProviderChallenge(headers: Record<string, string>, sentToken: string | undefined): Promise<boolean> {
		deleteHeader(headers, 'Authorization');
		const token = await this._requestProviderToken({ errorOnUserInteraction: this._host.errorOnUserInteraction, forceNewRegistration: sentToken !== undefined });
		if (!token || token === sentToken) {
			return false;
		}
		this._setToken(headers, token);
		return true;
	}
}

//#endregion
