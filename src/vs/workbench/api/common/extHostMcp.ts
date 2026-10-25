/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DeferredPromise, raceCancellationError, Sequencer, timeout } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { AUTH_SCOPE_SEPARATOR, IAuthorizationProtectedResourceMetadata, IAuthorizationServerMetadata, isAuthorizationProtectedResourceMetadata, OAuthClientError, parseWWWAuthenticateHeader, scopesMatch } from '../../../base/common/oauth.js';
import { InMemoryOAuthClientStorage, IOAuthClientRecord, IOAuthClientStorage, OAuthClient, OAuthClientCredentials, OAuthGrant, OAuthGrantKind, OAuthLogLevel, parseOAuthChallenge, redact, resourceRequiresDpop, workloadIdentityJwtProblem } from '../../../base/common/oauthClient.js';
import { DPOP_HEADER, DPOP_NONCE_HEADER, DPOP_SCHEME, IOAuthDpopProver, OAuthDpopProver, USE_DPOP_NONCE_ERROR } from '../../../base/common/oauthDpop.js';
import { importPkcs8PrivateKey, isJwsAlgorithm } from '../../../base/common/oauthJose.js';
import { SSEParser } from '../../../base/common/sseParser.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { IValidator, vArray, vBoolean, vNumber, vObj, vObjAny, vOptionalProp, vString } from '../../../base/common/validation.js';
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
import { ExtHostMcpShape, IMcpAuthenticationDetails, IAuthMetadataSource, IStartMcpOptions, MainContext, MainThreadMcpShape, IAuthResourceMetadataSource, IAuthServerMetadataSource, IMcpGatewayServerDto, IMcpRegisteredAuthorizationServer } from './extHost.protocol.js';
import { IExtHostInitDataService } from './extHostInitDataService.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import * as Convert from './extHostTypeConverters.js';
import { McpGrpcServerDefinition, McpHttpServerDefinition, McpStdioServerDefinition, McpToolAvailability } from './extHostTypes.js';
import { IExtHostVariableResolverProvider } from './extHostVariableResolverService.js';
import { IExtHostWorkspace } from './extHostWorkspace.js';
import { createMcpOAuthClient, IMcpOAuthServerPolicy, MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS, MCP_OAUTH_MAX_CHALLENGE_CYCLES, MCP_OAUTH_METADATA_TIMEOUT_MS, MCP_OAUTH_REJECTIONS_BEFORE_REREGISTRATION, mcpWantsDpop, resolveMcpOAuthPolicy } from './mcpOAuthClientFactory.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../platform/mcp/common/mcpPlatformTypes.js';

export const IExtHostMpcService = createDecorator<IExtHostMpcService>('IExtHostMpcService');

export interface IExtHostMpcService extends ExtHostMcpShape {
	registerMcpConfigurationProvider(extension: IExtensionDescription, id: string, provider: vscode.McpServerDefinitionProvider): IDisposable;

	/** Event that fires when the set of MCP server definitions changes. */
	readonly onDidChangeMcpServerDefinitions: Event<void>;

	/** Returns all MCP server definitions known to the editor. */
	readonly mcpServerDefinitions: readonly vscode.McpServerDefinition[];

	/**
	 * Starts an MCP gateway that exposes MCP servers via HTTP endpoints
	 * ({@link vscode.lm.startMcpGateway}). Both parameters are required, also
	 * when `undefined`, so that a caller (the API factory) cannot drop the
	 * extension's options without failing to compile.
	 */
	startMcpGateway(chatSessionResource: URI | undefined, options: vscode.McpGatewayStartOptions | undefined): Promise<vscode.McpGateway | undefined>;
}

/** A value of the proposed `McpGrpcBinding` enum (Auto = 1, Tunnel = 2, Typed = 3, TypedWithTunnel = 4); any other number is invalid too. */
const vGrpcBinding: IValidator<number> = {
	validate(content: unknown) {
		return content === 1 || content === 2 || content === 3 || content === 4
			? { content, error: undefined }
			: { content: undefined, error: { message: `Expected McpGrpcBinding.Auto, .Tunnel, .Typed or .TypedWithTunnel, but got ${typeof content === 'number' ? content : typeof content}` } };
	},
	getJSONSchema() {
		return { enum: [1, 2, 3, 4] };
	},
};

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
	})),
	// McpGrpcServerDefinition (proposed API `mcpGrpcServerDefinition`)
	tls: vOptionalProp(vObj({
		ca: vOptionalProp(vString()),
		insecure: vOptionalProp(vBoolean()),
		serverName: vOptionalProp(vString()),
	})),
	binding: vOptionalProp(vGrpcBinding),
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
		/** The extension of the provider; resolved definitions are subject to its API proposals too. */
		extension: IExtensionDescription;
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

	/**
	 * Starts a launch. The main thread does not wait for this call, so a launch
	 * that cannot start (a transport this extension host does not have, an
	 * invalid launch, a transport handle that throws) reports the Error state
	 * here, rather than leaving the server in Starting forever.
	 */
	$startMcp(id: number, opts: IStartMcpOptions): void {
		let started: void | Promise<void>;
		try {
			started = this._startMcp(id, McpServerLaunch.fromSerialized(opts.launch), opts.defaultCwd && URI.revive(opts.defaultCwd), opts.errorOnUserInteraction);
		} catch (err) {
			this._didFailToStart(id, err);
			return;
		}
		started?.catch(err => this._didFailToStart(id, err));
	}

	private _didFailToStart(id: number, err: unknown): void {
		this._logService.error(`[MCP] Could not start server ${id}: ${stringifyError(err)}`);
		this._sseEventSources.deleteAndDispose(id);
		this._proxy.$onDidChangeState(id, { state: McpConnectionState.Kind.Error, message: err instanceof Error ? err.message : String(err) });
	}

	/** Starts a launch; throws, or returns a promise that rejects, when it cannot. */
	protected _startMcp(id: number, launch: McpServerLaunch, _defaultCwd?: URI, errorOnUserInteraction?: boolean): void | Promise<void> {
		if (launch.type === McpServerTransportType.HTTP) {
			this._sseEventSources.set(id, new McpHTTPHandle(id, launch, this._proxy, this._logService, errorOnUserInteraction));
			return;
		}

		throw new Error(localize('mcp.transportUnsupported', "This extension host cannot start {0} MCP servers.", transportDisplayName(launch.type)));
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
		if (resolved instanceof McpGrpcServerDefinition) {
			// As in provideMcpServerDefinitions: a resolved definition may be the first gRPC one.
			checkProposedApiEnabled(rec.extension, 'mcpGrpcServerDefinition');
			// The launch of this server alone fails, with the reason.
			McpServerLaunch.validateGrpcUri(resolved.uri);
		}
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
			this._unresolvedMcpServers.set(mcp.id, { servers: list ?? [], provider, extension });

			const servers: McpServerDefinition.Serialized[] = [];
			const accepted: vscode.McpServerDefinition[] = [];
			for (const item of list ?? []) {
				serverDataValidation.validateOrThrow(item);
				if ((item as vscode.McpHttpServerDefinition2).authentication) {
					checkProposedApiEnabled(extension, 'mcpToolDefinitions');
				}
				if (item instanceof McpGrpcServerDefinition) {
					checkProposedApiEnabled(extension, 'mcpGrpcServerDefinition');
					if (!McpServerLaunch.isGrpcScheme(item.uri.scheme)) {
						// Left out alone: the main thread would reject the launch, and with it every server of the collection.
						this._logService.error(`[MCP] The server '${item.label}' of ${extension.identifier.value} is a McpGrpcServerDefinition whose URI ${item.uri.toString(true)} does not start with grpc:// or grpcs://; it is left out.`);
						continue;
					}
				}
				accepted.push(item);

				let id = ExtensionIdentifier.toKey(extension.identifier) + '/' + item.label;
				if (servers.some(s => s.id === id)) {
					let i = 2;
					while (servers.some(s => s.id === id + i)) { i++; }
					id = id + i;
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

			this._unresolvedMcpServers.set(mcp.id, { servers: accepted, provider, extension });
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

	/** {@link vscode.lm.startMcpGateway} (see {@link IExtHostMpcService.startMcpGateway} for why both parameters are required) */
	public async startMcpGateway(chatSessionResource: URI | undefined, options: vscode.McpGatewayStartOptions | undefined): Promise<vscode.McpGateway | undefined> {
		// Only `grpc: true` opens the gateway's gRPC listener (a truthy non-boolean does not).
		const result = await this._proxy.$startMcpGateway(chatSessionResource?.toJSON(), options?.grpc === true ? { grpc: true } : undefined);
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

/** A gateway server for the API; `grpcAddress` only when the gateway serves gRPC. */
function reviveGatewayServer(server: IMcpGatewayServerDto): vscode.McpGatewayServer {
	return server.grpcAddress
		? { label: server.label, address: URI.revive(server.address), grpcAddress: URI.revive(server.grpcAddress) }
		: { label: server.label, address: URI.revive(server.address) };
}

function transportDisplayName(type: McpServerTransportType): string {
	switch (type) {
		case McpServerTransportType.Stdio: return 'stdio';
		case McpServerTransportType.HTTP: return 'HTTP';
		case McpServerTransportType.Grpc: return 'gRPC';
		default: return String(type);
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

/**
 * Whether an SSE `message` event carries no JSON-RPC message: the priming
 * event of a 2025-11-25 stream (an id, maybe a retry, and empty data) or a
 * keep-alive. Its `id` and `retry` still count for resumption.
 */
function isEmptySSEData(data: string): boolean {
	return data.trim() === '';
}

function tryParseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * HTTP error statuses whose JSON-RPC body, if any, is not the server's answer to
 * the request: the authorization flow (401, 403) and conditions the request may
 * outlive (a timeout, a rate limit, an unavailable upstream).
 */
const NOT_AN_ANSWER_STATUS_CODES: ReadonlySet<number> = new Set([401, 403, 408, 429, 502, 503, 504]);

/** True when `body` is one JSON-RPC 2.0 error response: an object with `jsonrpc: "2.0"` whose `error` has a numeric `code`. */
function isJsonRpcErrorResponse(body: unknown): body is { jsonrpc: '2.0'; error: { code: number } } {
	if (typeof body !== 'object' || body === null || Array.isArray(body) || (body as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
		return false;
	}
	const error = (body as { error?: unknown }).error;
	return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number';
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

/**
 * An HTTP error body (`text`, parsed as `body`) for the POST of request
 * `requestId`, as the message delivered to the engine. Each POST carries one
 * message, so a JSON-RPC error in the body answers that request even when its
 * `id` is null or missing (a server or intermediary that rejected the request
 * before reading it): the request's id is put in, because the JSON-RPC layer
 * drops a response that matches no pending request, which would leave the
 * request (a handshake, for instance) pending forever.
 */
function asResponseToRequest(text: string, body: unknown, requestId: JsonRpcId | undefined): string {
	if (requestId === undefined) {
		return text;
	}
	const lacksId = (message: unknown): message is Record<string, unknown> =>
		typeof message === 'object' && message !== null && !Array.isArray(message)
		&& Object.prototype.hasOwnProperty.call(message, 'error')
		&& ((message as { id?: unknown }).id === null || (message as { id?: unknown }).id === undefined);
	if (Array.isArray(body)) {
		return body.some(lacksId) ? JSON.stringify(body.map(message => lacksId(message) ? { ...message, id: requestId } : message)) : text;
	}
	// A single error answers the one request of the POST whatever id it carries
	// (some servers put a placeholder such as "server-error" there).
	const answersOtherId = typeof body === 'object' && body !== null
		&& Object.prototype.hasOwnProperty.call(body, 'error')
		&& (body as { id?: unknown }).id !== requestId;
	return lacksId(body) || answersOtherId ? JSON.stringify({ ...body as Record<string, unknown>, id: requestId }) : text;
}

/** The outcome of a legacy HTTP+SSE attachment: the message endpoint the server named, or why there is none. */
type SseAttachment =
	| { readonly kind: 'attached'; readonly endpoint: string }
	| { readonly kind: 'failed'; readonly message: string };

const MAX_FOLLOW_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308];
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
// Credential-bearing headers that must not be replayed to a different origin
// after a redirect (matches browser fetch / curl behavior). Compared case-insensitively.
const CROSS_ORIGIN_STRIPPED_HEADERS = new Set(['authorization', 'dpop', 'cookie', 'proxy-authorization', 'mcp-session-id']);

function setHostHeader(headers: Record<string, string>, name: string, value: string): void {
	for (const configuredName of Object.keys(headers)) {
		if (configuredName.toLowerCase() === name.toLowerCase()) {
			delete headers[configuredName];
		}
	}
	headers[name] = value;
}

/**
 * The headers of a request (or a redirect) to another origin than the MCP
 * server's: without the credential-bearing headers and the configured ones
 * (`configured`, compared case-insensitively), with the generated
 * `transportHeaders`, which survive. Shared by the Streamable HTTP and gRPC
 * transports.
 */
export function stripCrossOriginHeaders(headers: Readonly<Record<string, string>>, configured: readonly (readonly [string, string])[], transportHeaders: Readonly<Record<string, string>>): Record<string, string> {
	const configuredNames = new Set(configured.map(([name]) => name.toLowerCase()));
	const filtered = Object.fromEntries(Object.entries(headers).filter(([name]) =>
		!CROSS_ORIGIN_STRIPPED_HEADERS.has(name.toLowerCase()) && !configuredNames.has(name.toLowerCase())));
	for (const [name, value] of Object.entries(transportHeaders)) {
		setHostHeader(filtered, name, value);
	}
	return filtered;
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
 * revision; any other 4xx, or a 2xx whose event stream names a message
 * endpoint (a legacy HTTP+SSE server answering any POST with its stream),
 * means it is a legacy server, the request is aborted with `legacy-probe` and
 * the engine retries with the legacy handshake.
 * Messages without an envelope are legacy traffic and go on the wire exactly
 * as they always did (first POST decides between Streamable HTTP and SSE).
 * A first legacy request with an envelope (a pinned or cached legacy revision)
 * that the server rejects with a recognized modern error is answered with that
 * error instead of the HTTP+SSE fallback, so the engine renegotiates. Any other
 * rejection still tries the HTTP+SSE fallback; when that fails too, the
 * enveloped request is aborted rather than the server failed, and the engine
 * renegotiates (a hinted handshake) or fails the start.
 * A 2026-07-28 request that cannot be sent (a network error) is aborted with
 * `transport-error` and the connection stays up; a legacy one, or a terminal
 * authorization failure in either revision, fails the connection.
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
			fetchMetadata: (url, init, transportHeaders, signal) => this._fetch(url, init, { isAuthMetadata: true, transportHeaders, signal }),
			fetchToken: (url, init, signal) => this._fetchToken(url, init, signal),
			log: (level, message) => this._log(level, message),
			readFile: path => this._readCredentialFile(path),
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
			// Only 2026-07-28 requests are tracked, so only they can have been
			// cancelled locally; a failed legacy request (a terminal authorization
			// error such as step_up_limit, a network error) must not be dropped.
			if (era === 'modern' && envelope?.requestId !== undefined && this._wasCancelledLocally(envelope.requestId)) {
				return;
			}
			if (envelope?.requestId !== undefined) {
				this._abortRequest(envelope, { reason: 'transport-error', message: stringifyError(err) });
			}
			// A 2026-07-28 request has no session that its failure (a network error,
			// for instance) could have broken: only that request fails, and the next
			// one is sent as usual. A terminal authorization failure still fails the
			// connection, in either revision.
			if (era === 'modern' && envelope && !isTerminalAuthorizationError(err)) {
				if (isCancellationError(err)) {
					// The sign-in needs the user: the Stopped state was published and this
					// connection is done, so release it (and its other in-flight requests)
					// without reporting an error over that state.
					this.dispose();
					return;
				}
				this._log(LogLevel.Warning, `Error sending ${envelope.method} to ${this._launch.uri}: ${stringifyError(err)}`);
				return;
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
			// A legacy server, recognized when its 4xx led to the HTTP+SSE fallback: a probe (the engine
			// renegotiating a pinned revision this server rejected) falls back to the legacy handshake.
			this._abortRequest(envelope, { reason: 'legacy-probe', message: 'The server uses the legacy HTTP+SSE transport' });
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
			const probing = this._mode.value === HttpMode.Unknown;
			if (probing) {
				this._mode = { value: HttpMode.Modern };
			}
			await this._handleSuccessfulStreamableHttp(res, message, envelope, controller?.signal, probing);
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
				this._proxy.$onDidReceiveMessage(this._id, asResponseToRequest(errText, body, envelope.requestId));
				return;
			}
			if (this._mode.value === HttpMode.Unknown) {
				this._log(LogLevel.Info, `${res.status} status for a ${envelope.protocolVersion} request to ${this._launch.uri}; the server does not speak this revision`);
				this._abortRequest(envelope, { reason: 'legacy-probe', httpStatus: res.status, message: errText });
				return;
			}
		}

		// A server known to speak 2026-07-28 may answer a request with an HTTP error
		// status and a JSON-RPC error in the body (-32602 with a 400 for a resource
		// that does not exist, for instance): that error is the server's answer, so
		// deliver it. 401/403 belong to the authorization flow, which already ran;
		// a timeout, rate limit or unavailable upstream stays an abort, which the
		// engine may retry (a listen stream reconnects; gRPC maps them to UNAVAILABLE).
		if (this._mode.value === HttpMode.Modern && envelope.requestId !== undefined && !NOT_AN_ANSWER_STATUS_CODES.has(res.status)) {
			const body = tryParseJson(errText);
			if (isJsonRpcErrorResponse(body)) {
				this._untrackRequest(envelope);
				this._proxy.$onDidReceiveMessage(this._id, asResponseToRequest(errText, body, envelope.requestId));
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
			// An enveloped legacy request (a pinned or cached revision) rejected with a recognized
			// 2026-07-28 error comes from a modern server, not from a legacy HTTP+SSE one: the
			// engine gets the JSON-RPC error and renegotiates. Any other 4xx keeps the fallback.
			if (envelope && (res.status === 400 || res.status === 404 || res.status === 405)) {
				const errText = await this._getErrText(res);
				const body = tryParseJson(errText);
				if (body !== undefined && isRecognizedModernError(res.status, body)) {
					this._log(LogLevel.Info, `${res.status} status with a 2026-07-28 error for a ${envelope.protocolVersion} request to ${this._launch.uri}; the server does not speak this revision`);
					this._proxy.$onDidReceiveMessage(this._id, asResponseToRequest(errText, body, envelope.requestId));
					return;
				}
			}
			this._log(LogLevel.Info, `${res.status} status sending message to ${this._launch.uri}, will attempt to fall back to legacy SSE`);
			this._sseFallbackWithMessage(message, envelope, res.status);
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

	/**
	 * Falls back to the legacy HTTP+SSE transport and sends `message` there.
	 * When the fallback follows a rejected POST (`rejectedStatus`) and fails
	 * before the server names its message endpoint, an enveloped request is
	 * aborted with both reasons instead of failing the server, and the engine
	 * decides: it renegotiates a pinned or cached revision the server rejected
	 * (`server/discover`), and otherwise fails the start with that message.
	 */
	private async _sseFallbackWithMessage(message: string, envelope?: IMcpMessageEnvelope, rejectedStatus?: number) {
		try {
			const attached = await this._attachSSE();
			if (attached.kind === 'failed') {
				if (rejectedStatus !== undefined && envelope?.kind === 'request' && envelope.requestId !== undefined) {
					this._log(LogLevel.Info, `The fallback to legacy SSE failed (${attached.message}); the ${envelope.method} request fails with the ${rejectedStatus} status`);
					this._abortRequest(envelope, { reason: 'http-status', httpStatus: rejectedStatus, message: `${rejectedStatus} status sending message to ${this._launch.uri}, and the fallback to legacy SSE failed: ${attached.message}` });
				} else {
					this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message: attached.message });
				}
				return;
			}
			this._mode = { value: HttpMode.SSE, endpoint: attached.endpoint };
			await this._sendLegacySSE(attached.endpoint, message, envelope);
		} catch (err) {
			this._handleSendError(err);
		}
	}

	/**
	 * Handles a 2xx response to a POST: nothing (202), a JSON body, or an SSE
	 * stream whose events are forwarded until it ends. With an envelope the
	 * stream is watched for the response to the request: a modern stream that
	 * ends without it aborts the request; a legacy stream that ends without it
	 * is resumed with `Last-Event-ID` when the server supports resumption. A
	 * stream that names a message endpoint (a legacy HTTP+SSE server) is ended
	 * and the message goes to the HTTP+SSE fallback instead, without an abort.
	 * When it answers the first 2026-07-28 request (`probing`: this response
	 * took the mode for modern), the server is a legacy one all the same: the
	 * mode is unknown again and the request is aborted with `legacy-probe`, as
	 * for a 4xx, so the engine falls back to the legacy handshake, whose POST
	 * then gets the HTTP+SSE fallback.
	 */
	private async _handleSuccessfulStreamableHttp(res: CommonResponse, message: string, envelope?: IMcpMessageEnvelope, signal?: AbortSignal, probing = false) {
		if (res.status === 202) {
			return; // no body
		}

		const contentType = res.headers.get('Content-Type')?.toLowerCase() || '';
		if (contentType.startsWith('text/event-stream')) {
			const watched = envelope?.requestId !== undefined && envelope.kind !== 'notification' ? envelope : undefined;
			let sawResponse = false;
			/** Whether the stream delivered a message: a stream that did is not a legacy server's. */
			let sawMessage = false;
			/**
			 * The stream named an endpoint: the message went to the legacy HTTP+SSE fallback, which answers it or
			 * fails the server, or the probe was aborted with `legacy-probe`. Either way the stream ends here.
			 */
			let fellBack = false;
			let lastEventId: string | undefined;
			let retryMs: number | undefined;
			const parser = new SSEParser(event => {
				if (event.id) {
					lastEventId = event.id;
				}
				if (event.retry) {
					retryMs = event.retry;
				}
				if (event.type === 'message' && isEmptySSEData(event.data)) {
					// A priming event (an id and empty data, 2025-11-25): it only sets the resumption point.
					return;
				}
				if (event.type === 'message') {
					sawMessage = true;
					if (watched && !sawResponse && isResponseFor(event.data, watched.requestId!)) {
						sawResponse = true;
					}
					this._proxy.$onDidReceiveMessage(this._id, event.data);
				} else if (event.type === 'endpoint' && this._mode.value !== HttpMode.Modern) {
					// An SSE server that didn't correctly return a 4xx status when we POSTed
					this._log(LogLevel.Warning, `Received SSE endpoint from a POST to ${this._launch.uri}, will fall back to legacy SSE`);
					fellBack = true;
					this._sseFallbackWithMessage(message, envelope);
					throw new CancellationError(); // just to end the SSE stream
				} else if (event.type === 'endpoint' && probing && watched && !sawMessage) {
					// The same server answering the 2026-07-28 probe: it does not speak that revision.
					this._log(LogLevel.Warning, `Received SSE endpoint from a ${watched.protocolVersion} POST to ${this._launch.uri}; the server uses the legacy HTTP+SSE transport`);
					fellBack = true;
					this._mode = { value: HttpMode.Unknown };
					this._abortRequest(watched, { reason: 'legacy-probe', message: 'The server uses the legacy HTTP+SSE transport' });
					throw new CancellationError(); // just to end the SSE stream
				}
			});

			let streamFailed = false;
			try {
				await this._doSSE(parser, res, signal);
			} catch (err) {
				if (!fellBack) {
					streamFailed = true;
					this._log(LogLevel.Warning, `Error reading SSE stream: ${stringifyError(err)}`);
				}
			}

			if (!watched || sawResponse || fellBack || this._store.isDisposed || signal?.aborted) {
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
				if (event.type === 'message' && !isEmptySSEData(event.data)) {
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
			try {
				if (canReconnectAt !== undefined) {
					await timeout(Math.max(0, canReconnectAt - Date.now()), this._cts.token);
					canReconnectAt = undefined;
				} else {
					await timeout(Math.min(retry * 1000, 30_000), this._cts.token);
				}
			} catch {
				// Cancelled: the handle was disposed while waiting to (re)connect. Nobody awaits this
				// loop, so it must end quietly rather than with an unhandled CancellationError.
				return;
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
				if (event.type === 'message' && !isEmptySSEData(event.data)) {
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
	 * Resolves with the message endpoint the server names, or with the reason the
	 * attachment failed before it named one (the GET failed, or the stream errored
	 * or ended first); the caller reports that failure.
	 */
	private async _attachSSE(): Promise<SseAttachment> {
		const outcome = new DeferredPromise<SseAttachment>();
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
				return { kind: 'failed', message: `${res.status} status connecting to ${this._launch.uri} as SSE: ${await this._getErrText(res)}` };
			}
		} catch (e) {
			return { kind: 'failed', message: `Error connecting to ${this._launch.uri} as SSE: ${e}` };
		}

		const parser = new SSEParser(event => {
			if (event.type === 'message') {
				if (!isEmptySSEData(event.data)) {
					this._proxy.$onDidReceiveMessage(this._id, event.data);
				}
			} else if (event.type === 'endpoint' && !outcome.isSettled) {
				outcome.complete({ kind: 'attached', endpoint: new URL(event.data, this._launch.uri.toString(true)).toString() });
			}
		});

		this._register(toDisposable(() => outcome.cancel()));
		this._doSSE(parser, res).then(() => {
			if (!outcome.isSettled) {
				outcome.complete({ kind: 'failed', message: `The SSE stream from ${this._launch.uri} ended before it named the message endpoint` });
			}
		}, err => {
			const message = `Error reading SSE stream: ${stringifyError(err)}`;
			if (!outcome.isSettled) {
				outcome.complete({ kind: 'failed', message });
			} else {
				this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message });
			}
		});

		return outcome.p;
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
	 * returned as is. Cancelling the request (`signal`) or disposing the
	 * handle ends the challenge handling, discovery included.
	 */
	private async _fetchWithAuthRetry(mcpUrl: string, init: MinimalRequestInit, headers: Record<string, string>, transportHeaders?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<CommonResponse> {
		const doFetch = () => this._fetch(mcpUrl, init, { transportHeaders, signal });

		let res = await doFetch();
		if (isAuthStatusCode(res.status)) {
			// Challenge handling ends with the request or the handle.
			const cts = new CancellationTokenSource(this._cts.token);
			const onAbort = () => cts.cancel();
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) {
				cts.cancel();
			}
			try {
				for (let cycle = 0; isAuthStatusCode(res.status); cycle++) {
					if (cycle >= MCP_OAUTH_MAX_CHALLENGE_CYCLES) {
						this._log(LogLevel.Warning, `${res.status} status from ${mcpUrl} after ${cycle} authorization attempts; giving up on this request`);
						break;
					}
					const retry = await this._auth.handleChallenge(res.status, res.headers.get('WWW-Authenticate') ?? undefined, headers, cts.token, res.headers.get(DPOP_NONCE_HEADER) ?? undefined);
					if (!retry) {
						break;
					}
					const errorText = await this._getErrText(res);
					this._log(LogLevel.Debug, `Retrying after a ${res.status} status with a new token. Error details: ${redact(errorText) || 'no additional details'}`);
					init.headers = headers;
					res = await doFetch();
				}
			} finally {
				signal?.removeEventListener('abort', onAbort);
				cts.dispose();
			}
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
			// Never log credentials: neither the ones the transport adds nor the configured
			// headers, whose values are typically API keys (as on gRPC).
			traceObj.headers = redactCredentialHeaders(traceObj.headers, this._launch.headers.map(([name]) => name));
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
			// A DPoP-bound token needs a fresh proof for each request, for this hop's method and URL.
			const signing = options.isAuthMetadata ? undefined : this._auth.addDpopProof(init.headers, init.method, currentUrl);
			if (signing) {
				await signing;
			}
			response = await this._fetchInternal(currentUrl, {
				...init,
				signal,
				redirect: 'manual'
			});
			if (!options.isAuthMetadata) {
				this._auth.observeResponse(currentUrl, init.headers, response.headers);
			}

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
		return stripCrossOriginHeaders(headers, this._launch.headers, transportHeaders);
	}

	protected _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
		return fetch(url, init);
	}

	/**
	 * A token request of a machine client's grant ({@link IMcpAuthHeaderProviderHost.fetchToken}): to
	 * the authorization server's token endpoint only, with its own headers (the client authentication,
	 * the DPoP proof; the MCP server's configured headers are not its to receive), following no
	 * redirect, within {@link MCP_OAUTH_METADATA_TIMEOUT_MS}.
	 */
	private async _fetchToken(url: string, init: MinimalRequestInit, signal: AbortSignal | undefined): Promise<CommonResponse> {
		if (!HTTP_PROTOCOLS.has(new URL(url).protocol)) {
			throw new Error(`The token endpoint ${url} is not an http(s) URL`);
		}
		const headers = { ...init.headers };
		setHostHeader(headers, 'user-agent', `${product.nameLong}/${product.version}`);
		const signals = [this._abortCtrl.signal, AbortSignal.timeout(MCP_OAUTH_METADATA_TIMEOUT_MS)];
		if (signal) {
			signals.push(signal);
		}
		this._log(LogLevel.Trace, `Token request to ${url}`);
		return this._fetchInternal(url, { ...init, headers, signal: AbortSignal.any(signals), redirect: 'manual' });
	}

	/** Reads a credential file of the server's `oauth` configuration; only an extension host with a file system can. */
	protected _readCredentialFile(_path: string): Promise<string> {
		return Promise.reject(new Error(localize('mcp.oauth.noFiles', "This extension host has no file system")));
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
	/** Whether the server requires DPoP-bound tokens: its metadata says so, or it challenged with the `DPoP` scheme only ({@link resourceRequiresDpop}). */
	readonly resourceRequiresDpop: boolean;

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
		public readonly resourceRequiresDpop: boolean = false,
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
			const scheme = challenge.scheme.toLowerCase();
			if ((scheme === 'bearer' || scheme === DPOP_SCHEME.toLowerCase()) && challenge.params['scope']) {
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
	/**
	 * Fetch function to use for HTTP requests. `signal` aborts the request when
	 * discovery is cancelled or the request exceeds {@link metadataTimeoutMs};
	 * discovery does not wait for a fetch that ignores it.
	 */
	fetch: (url: string, init: MinimalRequestInit & { signal?: AbortSignal }) => Promise<CommonResponse>;
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
	 * The authorization servers this client already holds a registration (or
	 * obtained tokens) with for the resource: the first `authorization_servers`
	 * entry among them is selected, otherwise the first listed one.
	 */
	registeredAuthorizationServers?: readonly IMcpRegisteredAuthorizationServer[];
	/** How long one metadata request may take; defaults to {@link MCP_OAUTH_METADATA_TIMEOUT_MS}. */
	metadataTimeoutMs?: number;
	/** The grant tokens are requested with; a machine client's needs no authorization endpoint. Defaults to `authorization_code`. */
	grant?: OAuthGrantKind;
	token?: CancellationToken;
}

/** The grant a discovery-only client is configured with for a machine client: it requests no tokens. */
const MACHINE_DISCOVERY_GRANT: OAuthGrant = { kind: 'jwt_bearer', assertion: () => Promise.reject(new Error('Authorization metadata discovery does not request tokens')) };

/**
 * A storage that only answers which authorization server already has a
 * registration, for the selection rule: the first `authorization_servers`
 * entry of the protected resource metadata that is registered. The fetch
 * adapter shows it each protected resource metadata document it reads; the
 * client asks after accepting one, so the last document is the accepted one.
 */
class RegisteredAuthorizationServerSelection implements IOAuthClientStorage {
	private _resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined;

	constructor(private readonly _registered: readonly IMcpRegisteredAuthorizationServer[]) { }

	observe(body: unknown): void {
		if (isAuthorizationProtectedResourceMetadata(body)) {
			this._resourceMetadata = body;
		}
	}

	async get(_key: string): Promise<IOAuthClientRecord | undefined> {
		const metadata = this._resourceMetadata;
		const issuer = metadata?.authorization_servers?.find(server => this._registered.some(registered => isRegistration(registered, server, metadata.resource)));
		return issuer ? { issuer, registrationKind: 'dcr', clientId: '', tokenEndpointAuthMethod: 'none', authorizationRequests: 0 } : undefined;
	}

	async set(): Promise<void> { /* discovery stores nothing */ }

	async delete(): Promise<void> { /* discovery stores nothing */ }
}

function isRegistration(registered: IMcpRegisteredAuthorizationServer, server: string, resource: string): boolean {
	if (registered.resource !== undefined && registered.resource !== resource) {
		return false;
	}
	if (registered.authorizationServer === server) {
		return true;
	}
	try {
		return URI.parse(server).toString(true) === registered.authorizationServer;
	} catch {
		return false;
	}
}

/**
 * A metadata fetch that ends when `signal` aborts (a {@link CancellationError})
 * or after `timeoutMs` (an error the client treats as an unavailable
 * document), also when the underlying fetch ignores its signal. The response
 * and the reading of its body each get `timeoutMs`; the timer and the listener
 * on `signal` end with each, so a response whose body is never read (a `404`
 * probe, for example) keeps neither alive. Exported for testing.
 */
export async function fetchMetadataWithin(fetchImpl: ICreateAuthMetadataOptions['fetch'], url: string, init: MinimalRequestInit, signal: AbortSignal | undefined, timeoutMs: number): Promise<CommonResponse> {
	const controller = new AbortController();
	const within = <T>(start: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
		const end = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		const fail = (error: Error) => {
			end();
			controller.abort();
			reject(error);
		};
		const onAbort = () => fail(new CancellationError());
		const timer = setTimeout(() => fail(new Error(`The metadata request to ${url} timed out after ${timeoutMs} ms`)), timeoutMs);
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		new Promise<T>(started => started(start())).then(value => {
			end();
			resolve(value);
		}, error => {
			end();
			reject(error);
		});
	});
	const response = await within(() => fetchImpl(url, { ...init, signal: controller.signal }));
	return {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		body: response.body,
		url: response.url,
		json: () => within(() => response.json()),
		text: () => within(() => response.text()),
	};
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
 * 2. the authorization server: the first listed one that already has a
 *    registration ({@link ICreateAuthMetadataOptions.registeredAuthorizationServers}),
 *    otherwise the first listed one;
 * 3. its metadata in the specification's discovery order, whose `issuer` must
 *    equal the authorization server identifier exactly; its endpoints must be
 *    HTTPS (or loopback) unless the server's policy allows HTTP;
 * 4. only a server without protected resource metadata falls back to the
 *    2025-03-26 default endpoints at its origin.
 *
 * Each metadata request ends after {@link MCP_OAUTH_METADATA_TIMEOUT_MS}
 * (it counts as unavailable), and cancelling `options.token` ends discovery.
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
	const challenge = parseOAuthChallenge(wwwAuthenticate);
	if (challenge?.resourceMetadataUrl) {
		log(LogLevel.Debug, `Found resource_metadata challenge in WWW-Authenticate header: ${challenge.resourceMetadataUrl}`);
	}
	if (challenge?.scope) {
		log(LogLevel.Debug, `Found scope challenge in WWW-Authenticate header: ${challenge.scope}`);
	}

	const policy = options.policy ?? resolveMcpOAuthPolicy(undefined);
	const protocolVersion = options.protocolVersion ?? MCPLegacy.LATEST_PROTOCOL_VERSION;
	const sameOriginHeaders = { ...options.sameOriginHeaders, [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion };
	const timeoutMs = options.metadataTimeoutMs ?? MCP_OAUTH_METADATA_TIMEOUT_MS;
	const selection = options.registeredAuthorizationServers?.length ? new RegisteredAuthorizationServerSelection(options.registeredAuthorizationServers) : undefined;
	const client = createMcpOAuthClient({
		clientName: product.nameLong,
		redirectUris: ['http://127.0.0.1/'],
		// Discovery only: the grant runs elsewhere, so no registration and no browser.
		registration: { dynamic: false },
		authorize: () => Promise.reject(new Error('Authorization metadata discovery does not authorize')),
		policy: { ...policy, pkce: 'assume-supported' },
		grant: options.grant !== undefined && options.grant !== 'authorization_code' ? MACHINE_DISCOVERY_GRANT : undefined,
		storage: selection,
		fetch: async (url, init) => {
			const response = await fetchMetadataWithin(fetch, url, { method: init.method ?? 'GET', headers: { ...init.headers } }, init.signal, timeoutMs);
			return selection ? { ...response, json: async () => { const body = await response.json(); selection.observe(body); return body; } } : response;
		},
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
			log,
			resourceRequiresDpop(wwwAuthenticate, discovery.resourceMetadata),
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
const CREDENTIAL_HEADERS = new Set(['authorization', 'dpop', 'proxy-authorization', 'cookie', 'set-cookie']);

/** A copy of `headers` with the credential-bearing ones and those named in `alsoRedact` (in any letter case) blanked, for trace logs. */
function redactCredentialHeaders(headers: Record<string, string> | undefined, alsoRedact: readonly string[] = []): Record<string, string> | undefined {
	if (!headers) {
		return headers;
	}
	const redacted = new Set(alsoRedact.map(name => name.toLowerCase()));
	const copy: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		copy[name] = CREDENTIAL_HEADERS.has(lower) || redacted.has(lower) ? '***' : value;
	}
	return copy;
}

/** The access token a request carries in its `Authorization` header (`Bearer` or `DPoP` scheme), and whether it is DPoP-bound. */
function accessTokenOf(headers: Readonly<Record<string, string>>): { readonly token: string; readonly dpop: boolean } | undefined {
	for (const [name, value] of Object.entries(headers)) {
		const match = name.toLowerCase() === 'authorization' ? /^(bearer|dpop)\s+(.*)$/i.exec(value) : null;
		if (match) {
			return { token: match[2], dpop: match[1].toLowerCase() === 'dpop' };
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

/**
 * Step-ups (re-authorizations for `insufficient_scope`) per canonical resource
 * for the lifetime of the extension host. With the initial authorization they
 * may make at most {@link MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS} authorization
 * requests.
 */
const processStepUps = new Map<string, number>();

/** What an {@link McpAuthHeaderProvider} needs from the transport that owns it. */
export interface IMcpAuthHeaderProviderHost {
	readonly id: number;
	readonly launch: {
		readonly uri: URI;
		readonly headers: readonly (readonly [string, string])[];
		readonly oauth?: McpServerTransportHTTP['oauth'];
		readonly authentication?: McpServerTransportHTTP['authentication'];
	};
	readonly proxy: Pick<MainThreadMcpShape, '$getTokenFromServerMetadata' | '$getTokenForProviderId' | '$onDidChangeState' | '$logMcpAuthSetup' | '$getRegisteredAuthorizationServers' | '$getAccessTokenBinding' | '$getMcpOAuthClientSecret'>;
	readonly errorOnUserInteraction?: boolean;
	/** The protocol revision of the traffic; metadata requests to the resource origin carry it. */
	protocolVersion(): string | undefined;
	/**
	 * Fetches authorization metadata, and sends the token requests of a
	 * machine client's grant. It is not subject to the server allow list;
	 * `transportHeaders` are generated headers that survive cross-origin
	 * redirects; `signal` aborts the request (discovery was cancelled or the
	 * request timed out).
	 */
	fetchMetadata(url: string, init: MinimalRequestInit, transportHeaders: Readonly<Record<string, string>> | undefined, signal?: AbortSignal): Promise<CommonResponse>;
	/**
	 * Sends a token request of a machine client's grant: to the token endpoint
	 * only (no redirect is followed: the body carries the credentials), with
	 * its own headers (the client authentication and the DPoP proof survive,
	 * whatever the origin), within a timeout. A host without it runs no
	 * machine client.
	 */
	fetchToken?(url: string, init: MinimalRequestInit, signal?: AbortSignal): Promise<CommonResponse>;
	log(level: LogLevel, message: string): void;
	/** The URL protected resource metadata is discovered for, when it is not the launch URI (a `grpc(s)://` server's HTTPS identity). */
	resourceUrl?(): string;
	/** Step-ups per resource; defaults to the process-wide counter. */
	readonly stepUps?: Map<string, number>;
	/**
	 * Reads a credential file of the server's `oauth` configuration (a private
	 * key, a workload identity JWT) where the transport runs; a host without a
	 * file system leaves it out.
	 */
	readFile?(path: string): Promise<string>;
}

/** The client of a machine client's grant, its DPoP key, and the authorization server its credentials were first used with. */
interface IMachineClient {
	readonly client: OAuthClient;
	readonly prover: OAuthDpopProver;
	readonly issuer: string;
}

/** How many of the last tokens a provider keeps the binding of: a request in flight may still carry an older one. */
const MAX_TOKEN_BINDINGS = 4;

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
 * - A DPoP-bound token (RFC 9449) goes with the `DPoP` scheme, and the
 *   transport asks {@link addDpopProof} for a fresh proof for each request it
 *   sends; a `use_dpop_nonce` challenge is answered with the server's nonce.
 *   VS Code asks for one when the server signals that it accepts them, or
 *   when `oauth.dpop` says so ({@link mcpWantsDpop}).
 * - A machine client (`oauth.grant`: `client_credentials` or
 *   `workload_identity`) gets its tokens here, from an {@link OAuthClient}
 *   in the extension host, without a user and without the main thread's
 *   authentication providers.
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
	/**
	 * How the last tokens put on requests are bound, by token: the DPoP key of a DPoP-bound one,
	 * `null` for a bearer token. A token's binding is looked up once.
	 */
	private readonly _tokenBindings = new Map<string, IOAuthDpopProver | null>();
	/** The client of a machine client's grant, created on its first token request. */
	private _machine: Promise<IMachineClient> | undefined;

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

	private get _policy(): IMcpOAuthServerPolicy {
		return resolveMcpOAuthPolicy(this._host.launch.oauth as IMcpRemoteServerOAuthConfiguration | undefined);
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
	 * Signs the DPoP proof (RFC 9449 section 7.1) of a request whose
	 * `Authorization` carries a DPoP-bound token: a fresh one for each request
	 * the transport sends (each redirect too), for its method and URL. Any
	 * other request gets none, and a proof left from an earlier attempt is
	 * removed. Returns the signing to wait for, or `undefined` when there is
	 * nothing to sign, so that other requests go out without delay.
	 */
	addDpopProof(headers: Record<string, string>, method: string, url: string): Promise<void> | undefined {
		deleteHeader(headers, DPOP_HEADER);
		const sent = accessTokenOf(headers);
		const prover = sent?.dpop ? this._tokenBindings.get(sent.token) : undefined;
		if (!sent || !prover) {
			return undefined;
		}
		return prover.createProof(method, url, sent.token).then(proof => setHostHeader(headers, DPOP_HEADER, proof));
	}

	/** Keeps the DPoP nonce (RFC 9449 section 9) a response to a request from {@link addDpopProof} supplied, for the next proofs to its origin. */
	observeResponse(url: string, requestHeaders: Readonly<Record<string, string>>, responseHeaders: { get(name: string): string | null }): void {
		const nonce = responseHeaders.get(DPOP_NONCE_HEADER);
		const sent = nonce !== null ? accessTokenOf(requestHeaders) : undefined;
		if (nonce !== null && sent?.dpop) {
			this._tokenBindings.get(sent.token)?.rememberNonce(url, nonce);
		}
	}

	/**
	 * Handles a challenge to a request that carried `headers`. Returns true
	 * when `headers` now carry a (new) token and the request should be sent
	 * again; false when the response stands. Throws a terminal
	 * {@link OAuthClientError}. `dpopNonce` is the response's `DPoP-Nonce`: a
	 * `use_dpop_nonce` challenge to a DPoP-bound token sends the request again
	 * with the same token, its next proof carrying the nonce.
	 */
	async handleChallenge(status: number, wwwAuthenticate: string | undefined, headers: Record<string, string>, token: CancellationToken = CancellationToken.None, dpopNonce?: string): Promise<boolean> {
		const sent = accessTokenOf(headers);
		const challenge = parseOAuthChallenge(wwwAuthenticate, sent?.dpop ? 'DPoP' : 'Bearer');
		const insufficientScope = status === 403 && challenge?.error === 'insufficient_scope';
		if (status !== 401 && !insufficientScope) {
			return false;
		}
		if (status === 401 && sent?.dpop && challenge?.error === USE_DPOP_NONCE_ERROR && dpopNonce !== undefined && this._tokenBindings.get(sent.token)) {
			this._host.log(LogLevel.Debug, 'The MCP server asked for a DPoP nonce; sending the request again with it');
			return true;
		}
		const sentToken = sent?.token;
		// A cancelled request stops waiting for the challenges ahead of it, and its own discovery ends.
		return raceCancellationError(this._challenges.queue(async () => {
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
			deleteHeader(headers, DPOP_HEADER);
			// The token stands for its own scopes; a machine client's grant still must not hand it out again for the wider ones.
			const machineStepUp = insufficientScope && this._policy.grant !== 'authorization_code';
			const newToken = await this._requestToken({ errorOnUserInteraction: this._host.errorOnUserInteraction, forceNewRegistration, rejectedToken: machineStepUp ? sentToken : rejectedToken, token });
			if (!newToken || newToken === sentToken) {
				return false;
			}
			this._issued = { token: newToken, scopes: metadata.scopes ?? [] };
			this._setToken(headers, newToken);
			return true;
		}), token);
	}

	/** Records that a request carrying `headers` was answered without a challenge: the rejection streak ends. */
	onDidAccept(headers: Readonly<Record<string, string>>): void {
		if (accessTokenOf(headers) !== undefined) {
			this._rejections = 0;
		}
	}

	protected async _discover(wwwAuthenticate: string | undefined, token: CancellationToken): Promise<AuthMetadata> {
		const protocolVersion = this._host.protocolVersion() ?? MCPLegacy.LATEST_PROTOCOL_VERSION;
		const policy = this._policy;
		const registeredAuthorizationServers = await this._registeredAuthorizationServers(token);
		return createAuthMetadata(this._resourceUrl, new Headers(wwwAuthenticate !== undefined ? { 'WWW-Authenticate': wwwAuthenticate } : {}), {
			sameOriginHeaders: Object.fromEntries(this._host.launch.headers),
			protocolVersion,
			policy,
			registeredAuthorizationServers,
			grant: policy.grant === 'authorization_code' ? 'authorization_code' : policy.grant === 'client_credentials' ? 'client_credentials' : 'jwt_bearer',
			fetch: (url, init) => this._host.fetchMetadata(url, { method: init.method, headers: init.headers, body: init.body }, init.headers[MCP_PROTOCOL_VERSION_HEADER] === protocolVersion ? { [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion } : undefined, init.signal),
			log: (level, message) => this._host.log(level, message),
			token,
		});
	}

	/**
	 * The authorization servers with a registration for the resource: the one
	 * this connection obtained tokens from, and those the main thread keeps
	 * dynamic providers for, which outlive the connection and the window.
	 */
	private async _registeredAuthorizationServers(token: CancellationToken): Promise<IMcpRegisteredAuthorizationServer[]> {
		const registered: IMcpRegisteredAuthorizationServer[] = this._registeredAuthorizationServer ? [{ authorizationServer: this._registeredAuthorizationServer }] : [];
		const persisted = this._host.proxy.$getRegisteredAuthorizationServers?.(this._host.id, this._resourceUrl);
		if (persisted) {
			try {
				registered.push(...await raceCancellationError(persisted, token));
			} catch (e) {
				if (isCancellationError(e)) {
					throw e;
				}
				this._host.log(LogLevel.Warning, `Could not look up the registered authorization servers of ${this._resourceUrl}: ${redact(String(e))}`);
			}
		}
		return registered;
	}

	/** Puts a token on a request: with the `DPoP` scheme when it is DPoP-bound, else as a bearer token. The proof is the transport's ({@link addDpopProof}). */
	private _setToken(headers: Record<string, string>, token: string): void {
		setHostHeader(headers, 'Authorization', `${this._tokenBindings.get(token) ? DPOP_SCHEME : 'Bearer'} ${token}`);
		deleteHeader(headers, DPOP_HEADER);
		this._currentToken = token;
	}

	/** Records how a token is bound: its DPoP key, or `null` for a bearer token. */
	private _bindToken(token: string, prover: IOAuthDpopProver | null): void {
		this._tokenBindings.delete(token);
		this._tokenBindings.set(token, prover);
		for (const oldest of this._tokenBindings.keys()) {
			if (this._tokenBindings.size <= MAX_TOKEN_BINDINGS) {
				break;
			}
			this._tokenBindings.delete(oldest);
		}
	}

	private async _requestToken(options: { errorOnUserInteraction?: boolean; forceNewRegistration?: boolean; rejectedToken?: string; token?: CancellationToken }): Promise<string | undefined> {
		const metadata = this._metadata;
		if (!metadata) {
			return undefined;
		}
		const policy = this._policy;
		const dpop = mcpWantsDpop(policy, metadata.resourceRequiresDpop);
		if (policy.grant !== 'authorization_code') {
			return this._requestMachineToken(metadata, policy.grant, dpop, options.rejectedToken, options.token ?? CancellationToken.None);
		}
		const details: IMcpAuthenticationDetails = {
			authorizationServer: metadata.authorizationServer.toJSON(),
			authorizationServerMetadata: metadata.serverMetadata,
			resourceMetadata: metadata.resourceMetadata,
			scopes: metadata.scopes,
			resource: metadata.resource,
			clientId: this._host.launch.oauth?.clientId,
			enterpriseManaged: this._host.launch.oauth?.enterpriseManaged,
			dpop: dpop || undefined,
		};
		try {
			const token = await this._host.proxy.$getTokenFromServerMetadata(this._host.id, details, {
				errorOnUserInteraction: options.errorOnUserInteraction,
				forceNewRegistration: options.forceNewRegistration || undefined,
				rejectedToken: options.rejectedToken,
			});
			if (token) {
				this._registeredAuthorizationServer = metadata.authorizationServerIdentifier;
				await this._lookUpDpopBinding(token);
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

	/** Learns whether a token of the main thread is DPoP-bound, and to which key. */
	private async _lookUpDpopBinding(token: string): Promise<void> {
		if (this._tokenBindings.has(token)) {
			return;
		}
		if (!this._host.proxy.$getAccessTokenBinding) {
			this._bindToken(token, null);
			return;
		}
		try {
			const binding = await this._host.proxy.$getAccessTokenBinding(this._host.id, token);
			this._bindToken(token, binding?.dpopKey ? await OAuthDpopProver.fromPrivateJwk(binding.dpopKey) : null);
		} catch (e) {
			// Sent as a bearer token, the server rejects a bound token, and the challenge gets another one.
			this._host.log(LogLevel.Warning, `Could not look up the DPoP key of the access token: ${redact(String(e))}`);
		}
	}

	/**
	 * The token of a machine client's grant (`oauth.grant`): the extension-host
	 * {@link OAuthClient} keeps it and requests a new one when it expires or is
	 * rejected. A refused grant, and credentials that are missing or belong to
	 * another authorization server, are terminal: the connection fails with the
	 * reason and the grant is not retried. A token endpoint that cannot be
	 * reached leaves the request unauthenticated, as for a user's sign-in.
	 */
	private async _requestMachineToken(metadata: AuthMetadata, grant: 'client_credentials' | 'workload_identity', dpop: boolean, rejectedToken: string | undefined, token: CancellationToken): Promise<string | undefined> {
		const issuer = metadata.serverMetadata.issuer;
		// Pre-registered credentials belong to one authorization server (`oauth.authorizationServer`): nothing is sent to another.
		const configuredIssuer = this._policy.authorizationServer;
		if (configuredIssuer !== undefined && configuredIssuer !== issuer) {
			throw new OAuthClientError('issuer_not_registered', localize('mcp.oauth.machineIssuerMismatch', "The MCP server names the authorization server {0}, but its `oauth.authorizationServer` is {1}; its credentials are not sent there.", issuer, configuredIssuer));
		}
		const pending = this._machine ??= this._createMachineClient(grant, issuer);
		let machine: IMachineClient;
		try {
			machine = await pending;
		} catch (e) {
			// The next challenge reads the configuration again (a secret set meanwhile, a fixed key file).
			if (this._machine === pending) {
				this._machine = undefined;
			}
			throw e;
		}
		// The credentials were first used with one authorization server: a resource that names another later does not get them.
		// (A workload identity JWT names its authorization server itself; it is checked before each request.)
		if (grant === 'client_credentials' && machine.issuer !== issuer) {
			throw new OAuthClientError('issuer_not_registered', localize('mcp.oauth.machineIssuerMoved', "The MCP server now names the authorization server {0}, but its client credentials were used with {1}; they are not sent to another.", issuer, machine.issuer));
		}
		let authorization;
		try {
			authorization = await machine.client.acquireToken({
				serverMetadata: metadata.serverMetadata,
				resourceMetadata: metadata.resourceMetadata,
				resource: metadata.resource,
				scopes: metadata.scopes,
				rejectedToken,
				dpop,
			}, token);
		} catch (e) {
			if (isCancellationError(e) || isTerminalAuthorizationError(e)) {
				throw e;
			}
			this._host.log(LogLevel.Warning, `The token request of the machine client failed: ${redact(String(e))}`);
			return undefined;
		}
		this._registeredAuthorizationServer = metadata.authorizationServerIdentifier;
		this._bindToken(authorization.accessToken, authorization.tokenType === 'DPoP' ? machine.prover : null);
		return authorization.accessToken;
	}

	private async _createMachineClient(grant: 'client_credentials' | 'workload_identity', issuer: string): Promise<IMachineClient> {
		const fetchToken = this._host.fetchToken;
		if (!fetchToken) {
			throw new OAuthClientError('grant_unsupported', localize('mcp.oauth.noMachineClient', "This transport cannot run the grant of `oauth.grant` `{0}`.", grant));
		}
		const oauthGrant = await this._machineGrant(grant, issuer);
		const prover = await OAuthDpopProver.generate();
		if (this._store.isDisposed) {
			throw new CancellationError();
		}
		const client = this._register(createMcpOAuthClient({
			clientName: product.nameLong,
			redirectUris: ['http://127.0.0.1/'],
			// Pre-registered credentials or a workload identity: no registration and no browser.
			registration: { dynamic: false },
			authorize: () => Promise.reject(new Error('A machine client does not authorize')),
			policy: this._policy,
			storage: new InMemoryOAuthClientStorage(),
			grant: oauthGrant,
			dpop: prover,
			fetch: (url, init) => fetchToken(url, { method: init.method ?? 'GET', headers: { ...init.headers }, body: init.body !== undefined ? new TextEncoder().encode(init.body) as Uint8Array<ArrayBuffer> : undefined }, init.signal),
			log: (level, message) => this._host.log(toLogLevel(level), message),
		}));
		return { client, prover, issuer };
	}

	/**
	 * The grant of `oauth.grant`, with the credentials of the server's `oauth`
	 * configuration, for their first use with the authorization server `issuer`.
	 */
	private async _machineGrant(grant: 'client_credentials' | 'workload_identity', issuer: string): Promise<OAuthGrant> {
		const oauth = this._host.launch.oauth;
		const clientId = oauth?.clientId;
		if (grant === 'workload_identity') {
			const tokenFile = oauth?.workloadIdentityTokenFile;
			if (!tokenFile) {
				throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.noWorkloadToken', "The MCP server's `oauth.grant` is `workload_identity`, which needs `oauth.workloadIdentityTokenFile`."));
			}
			return {
				kind: 'jwt_bearer',
				// The workload platform rotates the JWT, so the file is read for each token request.
				assertion: async request => {
					const jwt = (await this._readCredentialFile(tokenFile, 'workloadIdentityTokenFile')).trim();
					const problem = workloadIdentityJwtProblem(jwt, request.serverMetadata, Date.now());
					if (problem) {
						throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.badWorkloadToken', "The workload identity JWT in `oauth.workloadIdentityTokenFile` is not sent to {0}: {1}.", request.serverMetadata.issuer, problem));
					}
					return jwt;
				},
				client: clientId ? { clientId } : undefined,
			};
		}
		if (!clientId) {
			throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.noClientId', "The MCP server's `oauth.grant` is `client_credentials`, which needs the pre-registered `oauth.clientId`."));
		}
		let credentials: OAuthClientCredentials;
		if (oauth.privateKeyFile) {
			const algorithm = oauth.signingAlgorithm ?? 'ES256';
			if (!isJwsAlgorithm(algorithm)) {
				throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.badAlgorithm', "`oauth.signingAlgorithm` must be ES256, ES384, RS256 or PS256, not '{0}'.", algorithm));
			}
			const pem = await this._readCredentialFile(oauth.privateKeyFile, 'privateKeyFile');
			try {
				credentials = { clientId, privateKey: await importPkcs8PrivateKey(pem, algorithm), keyId: oauth.keyId, audience: oauth.clientAssertionAudience === 'token_endpoint' ? 'token_endpoint' : 'issuer' };
			} catch (e) {
				throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.badKey', "The private key in `oauth.privateKeyFile` cannot be used: {0}", e instanceof Error ? e.message : String(e)));
			}
		} else {
			// The main thread refuses a secret bound to another authorization server, and binds an unbound one to this one.
			const clientSecret = await this._host.proxy.$getMcpOAuthClientSecret?.(this._host.id, clientId, issuer);
			if (!clientSecret) {
				throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.noClientSecret', "No client secret is set for the MCP server's `oauth.clientId` '{0}'. Set one with the Set Client Secret code lens in mcp.json, or configure `oauth.privateKeyFile`.", clientId));
			}
			credentials = { clientId, clientSecret };
		}
		return { kind: 'client_credentials', credentials };
	}

	private async _readCredentialFile(path: string, setting: string): Promise<string> {
		if (!this._host.readFile) {
			throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.noFileSystem', "`oauth.{0}` cannot be read in this extension host.", setting));
		}
		try {
			return await this._host.readFile(path);
		} catch (e) {
			throw new OAuthClientError('credentials_unavailable', localize('mcp.oauth.unreadableFile', "Could not read `oauth.{0}` ({1}): {2}", setting, path, e instanceof Error ? e.message : String(e)));
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
