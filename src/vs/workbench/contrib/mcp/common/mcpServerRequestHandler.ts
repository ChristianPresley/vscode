/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../../../../base/common/arrays.js';
import { softAssertNever } from '../../../../base/common/assert.js';
import { DeferredPromise, disposableTimeout, IntervalTimer, isThenable } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { jsonRpcCodeForGrpcStatus } from '../../../../base/common/grpc/status.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { IJsonRpcNotification, IJsonRpcRequest, isJsonRpcNotification, isJsonRpcRequest, JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcProtocol } from '../../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, ISettableObservable, ObservablePromise, observableValue, transaction } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { canLog, ILogger, log, LogLevel } from '../../../../platform/log/common/log.js';
import { collectHeaderAnnotations, McpHeaderAnnotation } from '../../../../platform/mcp/common/mcpHttpHeaders.js';
import { eraForProtocolVersion, LATEST_MCP_PROTOCOL_VERSION, McpProtocolEra, META_SERVER_INFO, negotiateProtocolVersion, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../platform/mcp/common/modelContextProtocol.js';
import { McpTasks } from '../../../../platform/mcp/common/modelContextProtocolTasks.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { McpModernTask } from './mcpModernTask.js';
import { buildClientCapabilities, buildEnvelope, buildRequestMeta, getResultType, IMcpRequestMetaBase, mapLogLevelToMcp, MAX_MRTR_ROUNDS, McpProtocolEvent, parseInputRequiredResult, PROBE_TIMEOUT_MS, validateElicitFormContent } from './mcpProtocolMeta.js';
import { IMcpMessageTransport } from './mcpRegistryTypes.js';
import { IMcpListenHost, McpSubscriptionManager } from './mcpSubscriptions.js';
import { IMcpTaskInternal, McpTaskManager } from './mcpTaskManager.js';
import { IMcpClientMethods, IMcpElicitOptions, IMcpMessageEnvelope, IMcpNegotiationHints, IMcpRequestAbort, IMcpToolCallContext, McpClientError, McpConnectionState, McpError, McpServerTransportType, MpcResponseError } from './mcpTypes.js';
import { isTaskResult, translateMcpLogMessage } from './mcpTypesUtils.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';
import { localize } from '../../../../nls.js';

export interface McpRoot {
	uri: string;
	name?: string;
}

export interface IMcpServerRequestHandlerOptions extends IMcpClientMethods {
	/** MCP message transport */
	launch: IMcpMessageTransport;
	/** Logger instance. */
	logger: ILogger;
	/** Log level MCP messages is logged at */
	requestLogLevel?: LogLevel;
	/** Task manager for server-side MCP tasks (shared across reconnections) */
	taskManager: McpTaskManager;
	/** The transport the launch uses; decides how modern requests are cancelled and whether the probe times out. */
	transportType?: McpServerTransportType;
	/** Era/version hints that skip or pin the protocol probe. */
	negotiationHint?: IMcpNegotiationHints;
	/** Shown for modern servers that never send `_meta.serverInfo`. */
	defaultServerInfo?: MCP.Implementation;
	/** Overrides the stdio probe timeout (tests). */
	probeTimeoutMs?: number;
}

/** When a list result was received and how long the server allows it to be reused. */
export interface IMcpCacheHint {
	readonly receivedAt: number;
	/** Undefined for legacy servers (no hint) and for results that must not be cached. */
	readonly ttlMs: number | undefined;
	readonly cacheScope: 'public' | 'private' | undefined;
}

export interface IMcpListResult<T> {
	readonly items: T[];
	readonly cacheHint: IMcpCacheHint;
}

export interface IMcpNegotiatedProtocol {
	readonly era: McpProtocolEra;
	readonly protocolVersion: string;
}

interface ISendOptions {
	/** Speak this version instead of the negotiated one (used during the probe). */
	readonly version?: string;
	readonly kind?: IMcpMessageEnvelope['kind'];
	readonly deadlineMs?: number;
	/** Result types the caller handles itself (besides `complete`). */
	readonly acceptResultTypes?: readonly string[];
	/** Declare the Tasks extension (`io.modelcontextprotocol/tasks`) in this request's client capabilities (modern only). */
	readonly tasks?: boolean;
}

type ProbeOutcome =
	| { readonly kind: 'modern'; readonly version: string; readonly result: MCP.DiscoverResult }
	/** The server does not speak the modern revision: do the legacy handshake with the default version. */
	| { readonly kind: 'fallback'; readonly reason: string }
	/** The server told us (-32022) which legacy revision it speaks. */
	| { readonly kind: 'legacy-version'; readonly version: string }
	| { readonly kind: 'error'; readonly error: Error };

const MAX_PAGES = 10_000;

/**
 * Request handler for communicating with an MCP server.
 *
 * Owns the protocol era: it probes `server/discover` (2026-07-28) first and
 * falls back to the `initialize` handshake (2025-11-25 and older), stamps the
 * per-request `_meta` the stateless revision requires, answers the server's
 * `input_required` results (elicitation, sampling, roots), keeps the
 * `subscriptions/listen` streams, and keeps the legacy server-request
 * handling for older servers.
 */
export class McpServerRequestHandler extends Disposable {
	private readonly _rpc: JsonRpcProtocol;

	private _hasAnnouncedRoots = false;
	private _roots: MCPLegacy.Root[] = [];

	public set roots(roots: MCPLegacy.Root[]) {
		if (!equals(this._roots, roots)) {
			this._roots = roots;
			if (this._hasAnnouncedRoots && this._negotiated?.era === 'legacy') {
				this.sendNotification({ method: 'notifications/roots/list_changed' });
				this._hasAnnouncedRoots = false;
			}
		}
	}

	public get roots(): MCPLegacy.Root[] {
		return this._roots;
	}

	private _negotiated: IMcpNegotiatedProtocol | undefined;
	private _discoverResult: MCP.DiscoverResult | undefined;
	private _discoverHint: IMcpCacheHint | undefined;
	private _serverInit: MCPLegacy.InitializeResult | undefined;
	private _serverInfo: MCP.Implementation;
	private _clientInfo: MCP.Implementation = { name: 'Visual Studio Code', version: '0.0.0' };
	private _logLevel: MCP.LoggingLevel | undefined;
	private _probeTimedOut = false;
	private _lastNegotiation: (McpProtocolEvent & { kind: 'negotiation' }) | undefined;
	private _pendingInitializeId: JsonRpcId | undefined;
	private _sending: { readonly version: string; readonly kind?: IMcpMessageEnvelope['kind']; readonly deadlineMs?: number } | undefined;
	private readonly _headerAnnotations = new Map<string, readonly McpHeaderAnnotation[]>();
	private readonly _droppedTools = new Set<string>();
	private _subscriptions: McpSubscriptionManager | undefined;

	/** The era and revision negotiated with the server. Set once {@link create} resolves. */
	public get negotiated(): IMcpNegotiatedProtocol {
		if (!this._negotiated) {
			throw new Error('The protocol has not been negotiated yet');
		}
		return this._negotiated;
	}

	public get era(): McpProtocolEra {
		return this.negotiated.era;
	}

	public get protocolVersion(): string {
		return this.negotiated.protocolVersion;
	}

	/** The server's capabilities in the 2026-07-28 shape (legacy capabilities are projected onto it). */
	public get capabilities(): MCP.ServerCapabilities {
		if (this._discoverResult) {
			return this._discoverResult.capabilities;
		}
		return this._serverInit ? legacyToModernCapabilities(this._serverInit.capabilities) : {};
	}

	/** The raw capabilities a legacy server announced in `initialize` (tasks, experimental, …). */
	public get legacyCapabilities(): MCPLegacy.ServerCapabilities | undefined {
		return this._serverInit?.capabilities;
	}

	public get serverInfo(): MCP.Implementation {
		return this._serverInfo;
	}

	public get serverInstructions(): string | undefined {
		return this._discoverResult?.instructions ?? this._serverInit?.instructions;
	}

	/** The `server/discover` result for modern servers. */
	public get discoverResult(): MCP.DiscoverResult | undefined {
		return this._discoverResult;
	}

	public get discoverCacheHint(): IMcpCacheHint | undefined {
		return this._discoverHint;
	}

	/** The negotiation event of this connection (fired before anyone could subscribe). */
	public get lastNegotiation(): (McpProtocolEvent & { kind: 'negotiation' }) | undefined {
		return this._lastNegotiation;
	}

	/** The modern subscription manager; undefined for legacy servers. */
	public get subscriptions(): McpSubscriptionManager | undefined {
		return this._subscriptions;
	}

	/** Tool names dropped because their `x-mcp-header` annotations were invalid. */
	public get droppedTools(): ReadonlySet<string> {
		return this._droppedTools;
	}

	// Event emitters for server notifications
	private readonly _onDidReceiveCancelledNotification = this._register(new Emitter<MCP.CancelledNotificationParams>());
	readonly onDidReceiveCancelledNotification = this._onDidReceiveCancelledNotification.event;

	private readonly _onDidReceiveProgressNotification = this._register(new Emitter<MCPLegacy.ProgressNotification>());
	readonly onDidReceiveProgressNotification = this._onDidReceiveProgressNotification.event;

	private readonly _onDidReceiveElicitationCompleteNotification = this._register(new Emitter<MCPLegacy.ElicitationCompleteNotification>());
	readonly onDidReceiveElicitationCompleteNotification = this._onDidReceiveElicitationCompleteNotification.event;

	private readonly _onDidReceiveLoggingNotification = this._register(new Emitter<MCP.LoggingMessageNotificationParams>());
	readonly onDidReceiveLoggingNotification = this._onDidReceiveLoggingNotification.event;

	private readonly _onDidChangeResourceList = this._register(new Emitter<void>());
	readonly onDidChangeResourceList = this._onDidChangeResourceList.event;

	private readonly _onDidUpdateResource = this._register(new Emitter<MCP.ResourceUpdatedNotificationParams>());
	readonly onDidUpdateResource = this._onDidUpdateResource.event;

	private readonly _onDidChangeToolList = this._register(new Emitter<void>());
	readonly onDidChangeToolList = this._onDidChangeToolList.event;

	private readonly _onDidChangePromptList = this._register(new Emitter<void>());
	readonly onDidChangePromptList = this._onDidChangePromptList.event;

	private readonly _onDidReportProtocolEvent = this._register(new Emitter<McpProtocolEvent>());
	readonly onDidReportProtocolEvent = this._onDidReportProtocolEvent.event;

	/**
	 * Connects to the MCP server and negotiates the protocol era.
	 * @throws MpcResponseError if the server rejects the handshake, McpClientError
	 * when no common revision exists or the probe timed out without an answer.
	 */
	public static async create(instaService: IInstantiationService, opts: IMcpServerRequestHandlerOptions, token: CancellationToken = CancellationToken.None) {
		const mcp = new McpServerRequestHandler(opts);
		const store = new DisposableStore();
		try {
			const timer = store.add(new IntervalTimer());
			timer.cancelAndSet(() => {
				opts.logger.info('Waiting for server to respond to the protocol handshake...');
			}, 5000);

			const productService = instaService.invokeFunction(accessor => accessor.get(IProductService));
			mcp._clientInfo = { name: productService.nameLong, version: productService.version };

			const started = Date.now();
			await mcp._negotiate(token);
			const negotiated = mcp.negotiated;
			mcp._lastNegotiation = {
				kind: 'negotiation',
				era: negotiated.era,
				protocolVersion: negotiated.protocolVersion,
				durationMs: Date.now() - started,
				probeTimedOut: mcp._probeTimedOut,
				usedHint: !!(opts.negotiationHint?.era || opts.negotiationHint?.protocolVersion),
			};
			mcp._onDidReportProtocolEvent.fire(mcp._lastNegotiation);
			opts.logger.info(`Negotiated MCP ${negotiated.protocolVersion} (${negotiated.era} era)`);
			return mcp;
		} catch (e) {
			mcp.dispose();
			throw e;
		} finally {
			store.dispose();
		}
	}

	public readonly logger: ILogger;
	private readonly _launch: IMcpMessageTransport;
	private readonly _requestLogLevel: LogLevel;
	private readonly _createMessageRequestHandler: IMcpServerRequestHandlerOptions['createMessageRequestHandler'];
	private readonly _elicitationRequestHandler: IMcpServerRequestHandlerOptions['elicitationRequestHandler'];
	private readonly _taskManager: McpTaskManager;
	private readonly _transportType: McpServerTransportType | undefined;
	private readonly _negotiationHint: IMcpNegotiationHints | undefined;
	private readonly _probeTimeoutMs: number | undefined;

	protected constructor({
		launch,
		logger,
		createMessageRequestHandler,
		elicitationRequestHandler,
		requestLogLevel = LogLevel.Debug,
		taskManager,
		transportType,
		negotiationHint,
		defaultServerInfo,
		probeTimeoutMs,
	}: IMcpServerRequestHandlerOptions) {
		super();
		this._launch = launch;
		this.logger = logger;
		this._requestLogLevel = requestLogLevel;
		this._createMessageRequestHandler = createMessageRequestHandler;
		this._elicitationRequestHandler = elicitationRequestHandler;
		this._taskManager = taskManager;
		this._transportType = transportType;
		this._negotiationHint = negotiationHint;
		this._serverInfo = defaultServerInfo ?? { name: 'MCP Server', version: '' };
		// HTTP relies on the transport's legacy-probe abort; stdio (and unknown transports) time out.
		this._probeTimeoutMs = probeTimeoutMs ?? (transportType === McpServerTransportType.HTTP ? undefined : PROBE_TIMEOUT_MS);
		this._logLevel = mapLogLevelToMcp(logger.getLevel());

		this._rpc = this._register(new JsonRpcProtocol(
			message => this._sendOut(message),
			{
				handleRequest: (request, token) => this.handleServerRequest(request, token),
				handleNotification: notification => this.handleServerNotification(notification),
			}
		));

		// Attach this handler to the task manager
		this._taskManager.setHandler(this);
		this._register(this._taskManager.onDidUpdateTask(task => {
			if (this._negotiated?.era === 'legacy') {
				this.sendNotification<MCPLegacy.TaskStatusNotification>({ method: 'notifications/tasks/status', params: task });
			}
		}));
		this._register(toDisposable(() => this._taskManager.setHandler(undefined)));

		this._register(launch.onDidReceiveMessage(message => {
			if (canLog(this.logger.getLevel(), this._requestLogLevel)) {
				log(this.logger, this._requestLogLevel, `[server -> editor] ${JSON.stringify(message)}`);
			}
			void this._rpc.handleMessage(message);
		}));
		if (launch.onDidAbortRequest) {
			this._register(launch.onDidAbortRequest(abort => this._handleAbort(abort)));
		}
		this._register(autorun(reader => {
			const state = launch.state.read(reader).state;
			// the handler will get disposed when the launch stops, but if we're still
			// create()'ing we need to make sure to cancel the initialize request.
			if (state === McpConnectionState.Kind.Error || state === McpConnectionState.Kind.Stopped) {
				this.cancelAllRequests();
			}
		}));

		// Listen for log level changes and forward them to the MCP server
		this._register(logger.onDidChangeLogLevel((logLevel) => {
			this._logLevel = mapLogLevelToMcp(logLevel);
			if (this._negotiated?.era === 'legacy') {
				this._sendLogLevelToServer(logLevel);
			}
		}));
	}

	//#region negotiation

	private async _negotiate(token: CancellationToken): Promise<void> {
		const hint = this._negotiationHint;
		const hintedEra = hint?.era ?? (hint?.protocolVersion ? eraForProtocolVersion(hint.protocolVersion) : undefined);

		if (hintedEra === 'legacy') {
			const version = hint?.protocolVersion && eraForProtocolVersion(hint.protocolVersion) === 'legacy' ? hint.protocolVersion : MCPLegacy.LATEST_PROTOCOL_VERSION;
			try {
				await this._legacyHandshake(version, token);
				return;
			} catch (e) {
				if (hint?.strict || e instanceof CancellationError) {
					throw e;
				}
				this.logger.info(`Legacy handshake with the cached revision ${version} failed; probing again`);
			}
		}

		const modernVersion = hint?.protocolVersion && eraForProtocolVersion(hint.protocolVersion) === 'modern' ? hint.protocolVersion : LATEST_MCP_PROTOCOL_VERSION;
		const strict = !!hint?.strict;

		if (this._probeTimeoutMs === undefined || strict) {
			const outcome = await this._probeDiscover(modernVersion, token);
			await this._applyProbeOutcome(outcome, strict, token);
			return;
		}

		// Stdio: race the probe against a timeout; after the timeout both handshakes
		// are in flight and the first decisive answer wins.
		const discover = this._probeDiscover(modernVersion, token);
		const timer = new DeferredPromise<'timeout'>();
		const timerHandle = disposableTimeout(() => timer.complete('timeout'), this._probeTimeoutMs);
		try {
			const first = await Promise.race([discover, timer.p]);
			if (first !== 'timeout') {
				await this._applyProbeOutcome(first, strict, token);
				return;
			}
		} finally {
			timerHandle.dispose();
		}

		this._probeTimedOut = true;
		this.logger.info(`No answer to server/discover within ${this._probeTimeoutMs}ms; trying the legacy initialize handshake`);
		const legacy = this._legacyHandshake(MCPLegacy.LATEST_PROTOCOL_VERSION, token).then(
			(): { kind: 'legacy-done' } => ({ kind: 'legacy-done' }),
			(error: unknown): { kind: 'legacy-failed'; error: unknown } => ({ kind: 'legacy-failed', error }),
		);
		const winner = await Promise.race([
			discover.then((outcome): { kind: 'discover'; outcome: ProbeOutcome } => ({ kind: 'discover', outcome })),
			legacy,
		]);
		if (winner.kind === 'discover') {
			if (winner.outcome.kind === 'modern') {
				this._adoptModern(winner.outcome.version, winner.outcome.result);
				return;
			}
			if (winner.outcome.kind === 'error' && !(winner.outcome.error instanceof McpClientError)) {
				throw winner.outcome.error;
			}
			const legacyResult = await legacy;
			if (legacyResult.kind === 'legacy-failed') {
				throw legacyResult.error;
			}
			return;
		}
		if (winner.kind === 'legacy-done') {
			return;
		}
		// The legacy handshake failed (a modern server answering `initialize` with -32601 for instance): wait for the probe.
		const outcome = await discover;
		if (outcome.kind === 'modern') {
			this._adoptModern(outcome.version, outcome.result);
			return;
		}
		if (outcome.kind === 'fallback') {
			throw new McpClientError('probe-timeout', 'The server answered neither server/discover nor initialize', { discover: outcome.reason, initialize: String(winner.error) });
		}
		throw winner.error;
	}

	private async _applyProbeOutcome(outcome: ProbeOutcome, strict: boolean, token: CancellationToken): Promise<void> {
		switch (outcome.kind) {
			case 'modern':
				this._adoptModern(outcome.version, outcome.result);
				return;
			case 'legacy-version':
				if (strict) {
					throw new McpClientError('no-supported-version', `The server only speaks ${outcome.version}, which the strict negotiation does not allow`);
				}
				await this._legacyHandshake(outcome.version, token);
				return;
			case 'fallback':
				if (strict) {
					// A strict modern client against a server without server/discover: speak the revision with no advertised capabilities.
					this.logger.warn(`server/discover failed (${outcome.reason}); continuing with the requested revision and no capabilities`);
					this._adoptModern(this._negotiationHint?.protocolVersion ?? LATEST_MCP_PROTOCOL_VERSION, undefined);
					return;
				}
				this.logger.info(`Server does not speak MCP ${LATEST_MCP_PROTOCOL_VERSION} (${outcome.reason}); using the legacy initialize handshake`);
				await this._legacyHandshake(MCPLegacy.LATEST_PROTOCOL_VERSION, token);
				return;
			case 'error':
				throw outcome.error;
			default:
				softAssertNever(outcome);
		}
	}

	/** Sends `server/discover`, retrying once when the server names another modern revision (-32022). Never rejects. */
	private async _probeDiscover(version: string, token: CancellationToken, retried = false): Promise<ProbeOutcome> {
		let result: MCP.DiscoverResult;
		try {
			result = await this._send<MCP.DiscoverResult>('server/discover', {}, token, { version });
		} catch (e) {
			if (e instanceof CancellationError) {
				return { kind: 'error', error: e };
			}
			if (e instanceof MpcResponseError) {
				if (e.code === MCP.UNSUPPORTED_PROTOCOL_VERSION) {
					const negotiated = negotiateProtocolVersion(supportedVersionsFromError(e.data));
					const willRetry = !!negotiated && (negotiated.era === 'legacy'
						? !this._negotiationHint?.strict
						: !retried && negotiated.version !== version);
					this._onDidReportProtocolEvent.fire({ kind: 'renegotiation', code: e.code, retried: willRetry });
					if (!negotiated) {
						return { kind: 'error', error: new McpClientError('no-supported-version', 'The server supports no MCP revision this client speaks', e.data) };
					}
					if (negotiated.era === 'legacy') {
						return { kind: 'legacy-version', version: negotiated.version };
					}
					if (retried) {
						return { kind: 'error', error: new McpClientError('no-supported-version', `The server rejected ${version} and offered ${negotiated.version}`, e.data) };
					}
					// Retry once with the offered revision, even when it is the one just
					// rejected: SEP-2575 asks for a retry with a supported version, and a
					// server may reject transiently (the conformance scenario
					// request-metadata simulates exactly that; its check
					// sep-2575-client-retry-supported-version needs the retry). The
					// `retried` flag bounds this to one retry.
					return this._probeDiscover(negotiated.version, token, true);
				}
				if (e.code === MCP.HEADER_MISMATCH || e.code === MCP.MISSING_REQUIRED_CLIENT_CAPABILITY) {
					return { kind: 'error', error: e };
				}
				return { kind: 'fallback', reason: `${e.code}: ${e.message}` };
			}
			if (e instanceof McpClientError && e.reason === 'request-aborted') {
				const abort = e.detail as IMcpRequestAbort | undefined;
				if (abort?.reason === 'legacy-probe') {
					return { kind: 'fallback', reason: abort.message ?? 'legacy server' };
				}
				return { kind: 'error', error: e };
			}
			return { kind: 'error', error: e instanceof Error ? e : new Error(String(e)) };
		}
		if (!Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(version)) {
			// The server answered under a revision it does not list; pick one we share when we can.
			const negotiated = Array.isArray(result.supportedVersions) ? negotiateProtocolVersion(result.supportedVersions) : undefined;
			if (negotiated?.era === 'modern' && negotiated.version !== version && !retried) {
				return this._probeDiscover(negotiated.version, token, true);
			}
		}
		return { kind: 'modern', version, result };
	}

	private _adoptModern(version: string, result: MCP.DiscoverResult | undefined): void {
		if (this._negotiated) {
			return;
		}
		if (this._pendingInitializeId !== undefined) {
			this._rpc.failPendingRequest(this._pendingInitializeId, new CancellationError());
			this._pendingInitializeId = undefined;
		}
		this._negotiated = { era: 'modern', protocolVersion: version };
		this._discoverResult = result ?? { supportedVersions: [version], capabilities: {}, ttlMs: 0, cacheScope: 'private', resultType: 'complete' };
		this._discoverHint = result ? cacheHintOf(result) : undefined;
		if (result) {
			this._noteServerInfo(result);
		}
		this._startSubscriptions();
	}

	private async _legacyHandshake(version: string, token: CancellationToken): Promise<void> {
		const params: MCPLegacy.InitializeRequest['params'] = {
			protocolVersion: version,
			capabilities: buildClientCapabilities('legacy', {
				sampling: !!this._createMessageRequestHandler,
				samplingTools: true,
				elicitation: !!this._elicitationRequestHandler,
			}),
			clientInfo: this._clientInfo,
		};
		const { id, result } = this._sendRequestWithVersion<MCPLegacy.InitializeResult>(version, 'initialize', params, token);
		this._pendingInitializeId = id;
		let initialized: MCPLegacy.InitializeResult;
		try {
			initialized = await result;
		} finally {
			if (this._pendingInitializeId === id) {
				this._pendingInitializeId = undefined;
			}
		}
		if (this._negotiated) {
			return; // the modern probe won the race
		}
		const serverVersion = typeof initialized.protocolVersion === 'string' ? initialized.protocolVersion : version;
		if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(serverVersion)) {
			this.logger.warn(`The server answered initialize with the unknown protocol version ${serverVersion}; continuing with ${version}`);
		}
		this._serverInit = initialized;
		this._serverInfo = initialized.serverInfo;
		this._negotiated = { era: 'legacy', protocolVersion: eraForProtocolVersion(serverVersion) === 'legacy' ? serverVersion : version };
		this.sendNotification<MCPLegacy.InitializedNotification>({ method: 'notifications/initialized' });
		this._sendLogLevelToServer(this.logger.getLevel());
	}

	private _startSubscriptions(): void {
		if (this._subscriptions || this._store.isDisposed) {
			return;
		}
		const host: IMcpListenHost = {
			logger: this.logger,
			listen: filter => this._sendListen(filter),
			cancel: id => this._cancelOutgoing(id, true),
		};
		const manager = this._register(new McpSubscriptionManager(host));
		this._subscriptions = manager;
		this._register(manager.onDidChangeToolList(() => this._onDidChangeToolList.fire()));
		this._register(manager.onDidChangePromptList(() => this._onDidChangePromptList.fire()));
		this._register(manager.onDidChangeResourceList(() => this._onDidChangeResourceList.fire()));
		this._register(manager.onDidUpdateResource(params => this._onDidUpdateResource.fire(params)));
		this._register(manager.onDidReconnect(r => this._onDidReportProtocolEvent.fire({ kind: 'listen-reconnect', stream: r.stream, reason: r.reason, backoffMs: r.backoffMs })));
		const caps = this.capabilities;
		manager.start({
			toolsListChanged: !!caps.tools?.listChanged,
			promptsListChanged: !!caps.prompts?.listChanged,
			resourcesListChanged: !!caps.resources?.listChanged,
		});
	}

	private _sendListen(filter: MCP.SubscriptionFilter): { readonly id: JsonRpcId; readonly result: Promise<MCP.SubscriptionsListenResult> } {
		const version = this.negotiated.protocolVersion;
		const params = this._stampMeta({ notifications: filter }, version);
		const { id, result } = this._sendRequestWithVersion<MCP.SubscriptionsListenResult>(version, 'subscriptions/listen', params, CancellationToken.None, undefined, 'listen');
		return { id, result };
	}

	//#endregion

	//#region sending

	/** Sends a request in the negotiated era (modern requests are stamped with `_meta`) and maps protocol errors. */
	private async _send<R>(method: string, params: object | undefined, token: CancellationToken, options: ISendOptions = {}): Promise<R> {
		if (this._store.isDisposed) {
			throw new CancellationError();
		}
		const version = options.version ?? this._negotiated?.protocolVersion ?? LATEST_MCP_PROTOCOL_VERSION;
		const modern = eraForProtocolVersion(version) !== 'legacy';
		const outParams = modern ? this._stampMeta(params ?? {}, version, options.tasks) : params;
		const result = await this._sendRequestWithVersion<R>(version, method, outParams, token, options.deadlineMs, options.kind).result;
		if (modern) {
			this._noteServerInfo(result);
			const resultType = getResultType(result);
			if (resultType !== 'complete' && !options.acceptResultTypes?.includes(resultType)) {
				throw new McpClientError('invalid-result-type', `Unexpected resultType "${resultType}" for ${method}`, result);
			}
		}
		return result;
	}

	/**
	 * Sends a request with the -32020 and -32022 recovery rules: a header
	 * mismatch re-lists the tools and retries once; an unsupported version
	 * renegotiates and retries once.
	 */
	private async _request<R>(method: string, params: object | undefined, token: CancellationToken, options: ISendOptions = {}): Promise<R> {
		let retriedHeaders = false;
		let retriedVersion = false;
		for (; ;) {
			try {
				return await this._send<R>(method, params, token, options);
			} catch (e) {
				if (!(e instanceof MpcResponseError) || this._negotiated?.era !== 'modern') {
					throw e;
				}
				if (e.code === MCP.HEADER_MISMATCH && method === 'tools/call' && !retriedHeaders) {
					retriedHeaders = true;
					this.logger.warn(`The server reported a header mismatch for ${method}; refreshing the tool list and retrying once`);
					try {
						await this.listToolsEx({}, token);
					} catch {
						throw e;
					}
					this._onDidChangeToolList.fire();
					continue;
				}
				if (e.code === MCP.UNSUPPORTED_PROTOCOL_VERSION && !retriedVersion) {
					retriedVersion = true;
					if (await this._renegotiate(e, token)) {
						continue;
					}
				}
				throw e;
			}
		}
	}

	/** Handles -32022 on an ordinary request: switch revision (or era) and report whether the request can be retried. */
	private async _renegotiate(error: MpcResponseError, token: CancellationToken): Promise<boolean> {
		const negotiated = negotiateProtocolVersion(supportedVersionsFromError(error.data));
		// A strict negotiation or an offer of the revision already in use is not retried.
		const retry = !!negotiated && !this._negotiationHint?.strict && (negotiated.era === 'legacy' || negotiated.version !== this._negotiated?.protocolVersion);
		this._onDidReportProtocolEvent.fire({ kind: 'renegotiation', code: error.code, retried: retry });
		if (!negotiated || !retry) {
			return false;
		}
		if (negotiated.era === 'modern') {
			this.logger.info(`Switching to MCP ${negotiated.version} at the server's request`);
			this._negotiated = { era: 'modern', protocolVersion: negotiated.version };
			return true;
		}
		this.logger.info(`The server only speaks MCP ${negotiated.version}; switching to the legacy handshake`);
		this._subscriptions?.dispose();
		this._subscriptions = undefined;
		this._discoverResult = undefined;
		this._negotiated = undefined;
		await this._legacyHandshake(negotiated.version, token);
		return true;
	}

	private _sendRequestWithVersion<R>(version: string, method: string, params: object | undefined, token: CancellationToken, deadlineMs?: number, kind?: IMcpMessageEnvelope['kind']): { readonly id: JsonRpcId; readonly result: Promise<R> } {
		const modern = eraForProtocolVersion(version) !== 'legacy';
		this._sending = { version, kind, deadlineMs };
		let sent: { readonly id: JsonRpcId; readonly result: Promise<R> };
		try {
			sent = this._rpc.sendRequestWithId<R>({ method, params: params as Record<string, unknown> | undefined }, token, id => this._cancelOutgoing(id, modern));
		} finally {
			this._sending = undefined;
		}
		const result = sent.result.catch((error: unknown) => {
			if (error instanceof JsonRpcError) {
				throw new MpcResponseError(error.message, error.code, error.data);
			}
			throw error;
		});
		return { id: sent.id, result };
	}

	/** Cancels an outgoing request: a transport-level cancellation for modern non-stdio transports, `notifications/cancelled` otherwise. */
	private _cancelOutgoing(id: JsonRpcId, modern: boolean): void {
		if (modern && this._transportType !== McpServerTransportType.Stdio && this._launch.cancelRequest) {
			this._launch.cancelRequest(id);
		} else {
			this.sendNotification({ method: 'notifications/cancelled', params: { requestId: id } });
		}
		if (this._rpc.hasPendingRequest(id)) {
			this._rpc.failPendingRequest(id, new CancellationError());
		}
	}

	private _stampMeta(params: object, version: string, tasks = false): Record<string, unknown> {
		const record = params as Record<string, unknown>;
		const callerMeta = typeof record._meta === 'object' && record._meta !== null ? record._meta as Record<string, unknown> : undefined;
		return { ...record, _meta: buildRequestMeta(this._metaBase(version, tasks), callerMeta) };
	}

	/**
	 * The per-request `_meta` base. The Tasks extension is declared per request
	 * (SEP-2575 per-request opt-in): on `tasks/*` and on the `tools/call`
	 * requests that opted in, never on the others.
	 */
	private _metaBase(version: string, tasks = false): IMcpRequestMetaBase {
		return {
			protocolVersion: version,
			clientInfo: this._clientInfo,
			clientCapabilities: buildClientCapabilities('modern', {
				sampling: !!this._createMessageRequestHandler,
				samplingTools: true,
				elicitation: !!this._elicitationRequestHandler,
				tasks,
			}),
			logLevel: this._logLevel,
		};
	}

	private _noteServerInfo(result: unknown): void {
		if (typeof result !== 'object' || result === null) {
			return;
		}
		const meta = (result as { _meta?: unknown })._meta;
		if (typeof meta !== 'object' || meta === null) {
			return;
		}
		const info = (meta as Record<string, unknown>)[META_SERVER_INFO];
		if (typeof info === 'object' && info !== null && typeof (info as { name?: unknown }).name === 'string') {
			this._serverInfo = info as MCP.Implementation;
		}
	}

	private _sendOut(message: JsonRpcMessage): void {
		if (canLog(this.logger.getLevel(), this._requestLogLevel)) { // avoid building the string if we don't need to
			log(this.logger, this._requestLogLevel, `[editor -> server] ${JSON.stringify(message)}`);
		}
		const version = this._sending?.version ?? this._negotiated?.protocolVersion;
		let envelope: IMcpMessageEnvelope | undefined;
		if (version !== undefined) {
			if (isJsonRpcRequest(message)) {
				const kind = this._sending?.kind ?? (message.method === 'subscriptions/listen' ? 'listen' : 'request');
				envelope = buildEnvelope(kind, message.id, version, message.method, message.params, this._headerAnnotations, this._sending?.deadlineMs);
			} else if (isJsonRpcNotification(message)) {
				envelope = buildEnvelope('notification', undefined, version, message.method, message.params);
			}
		}
		this._launch.send(message, envelope);
	}

	private _handleAbort(abort: IMcpRequestAbort): void {
		if (!this._rpc.hasPendingRequest(abort.requestId)) {
			return;
		}
		const message = abort.message ?? `The request was aborted by the transport (${abort.reason})`;
		// A gRPC status-only failure with a JSON-RPC equivalent (INVALID_ARGUMENT, UNIMPLEMENTED,
		// NOT_FOUND, INTERNAL, ...) is a protocol error; CANCELLED, DEADLINE_EXCEEDED, UNAVAILABLE,
		// UNAUTHENTICATED and PERMISSION_DENIED stay transport failures.
		const code = abort.reason === 'grpc-status' && abort.grpcStatus !== undefined ? jsonRpcCodeForGrpcStatus(abort.grpcStatus) : undefined;
		if (code !== undefined) {
			this._rpc.failPendingRequest(abort.requestId, new MpcResponseError(message, code, { grpcStatus: abort.grpcStatus }));
			return;
		}
		this._rpc.failPendingRequest(abort.requestId, new McpClientError('request-aborted', message, abort));
	}

	/**
	 * Handles paginated requests by making multiple requests until all items are retrieved.
	 * An empty-string cursor is a valid cursor; only a missing (or non-string) cursor ends the listing.
	 */
	private async *sendRequestPaginated<R extends { nextCursor?: unknown }, I>(method: string, getItems: (result: R) => I[], initialParams?: object, token: CancellationToken = CancellationToken.None, onPage?: (result: R) => void): AsyncIterable<I[]> {
		let nextCursor: string | undefined = undefined;
		let pages = 0;
		do {
			const params: Record<string, unknown> = { ...initialParams };
			if (nextCursor !== undefined) {
				params.cursor = nextCursor;
			}
			const result: R = await this._request<R>(method, params, token);
			onPage?.(result);
			yield getItems(result);
			if (typeof result.nextCursor === 'string') {
				nextCursor = result.nextCursor;
			} else {
				if (result.nextCursor !== undefined && result.nextCursor !== null) {
					this.logger.warn(`Ignoring a non-string nextCursor from ${method}`);
				}
				nextCursor = undefined;
			}
			if (++pages >= MAX_PAGES) {
				this.logger.warn(`Stopping ${method} pagination after ${MAX_PAGES} pages`);
				break;
			}
		} while (nextCursor !== undefined && !token.isCancellationRequested);
	}

	private sendNotification<N extends { method: string; params?: object }>(notification: Omit<N, 'jsonrpc'>): void {
		this._rpc.sendNotification(notification);
	}

	//#endregion

	//#region incoming

	/**
	 * Handle incoming server requests. Modern servers never send requests
	 * (input is requested through `input_required` results), so only `ping`
	 * is tolerated there.
	 */
	private handleServerRequest(request: IJsonRpcRequest, token: CancellationToken): unknown | Promise<unknown> {
		const mapError = (error: unknown): JsonRpcError => {
			if (error instanceof McpError) {
				return new JsonRpcError(error.code, error.message, error.data);
			}

			this.logger.error(`Error handling request ${request.method}:`, error);
			const mcpError = McpError.unknown(error instanceof Error ? error : new Error(String(error)));
			return new JsonRpcError(mcpError.code, mcpError.message, mcpError.data);
		};

		try {
			if (request.method === 'ping') {
				return {};
			}
			if (this._negotiated?.era !== 'legacy') {
				throw McpError.methodNotFound(request.method);
			}
			const legacyRequest = request as unknown as MCPLegacy.JSONRPCRequest & MCPLegacy.ServerRequest;
			let result: MCPLegacy.Result | Promise<MCPLegacy.Result>;
			if (legacyRequest.method === 'roots/list') {
				result = this.handleRootsList();
			} else if (legacyRequest.method === 'sampling/createMessage' && this._createMessageRequestHandler) {
				// Check if this is a task-augmented request
				if (legacyRequest.params.task) {
					const taskResult = this._taskManager.createTask(
						legacyRequest.params.task.ttl ?? null,
						(token) => this._createMessageRequestHandler!(legacyRequest.params, token)
					);
					taskResult._meta ??= {};
					taskResult._meta['io.modelcontextprotocol/related-task'] = { taskId: taskResult.task.taskId };
					result = taskResult;
				} else {
					result = this._createMessageRequestHandler(legacyRequest.params, token);
				}
			} else if (legacyRequest.method === 'elicitation/create' && this._elicitationRequestHandler) {
				// Check if this is a task-augmented request
				if (legacyRequest.params.task) {
					const taskResult = this._taskManager.createTask(
						legacyRequest.params.task.ttl ?? null,
						(token) => this._elicitationRequestHandler!(legacyRequest.params, token)
					);
					taskResult._meta ??= {};
					taskResult._meta['io.modelcontextprotocol/related-task'] = { taskId: taskResult.task.taskId };
					result = taskResult;
				} else {
					result = this._elicitationRequestHandler(legacyRequest.params, token);
				}
			} else if (legacyRequest.method === 'tasks/get') {
				result = this._taskManager.getTask(legacyRequest.params.taskId);
			} else if (legacyRequest.method === 'tasks/result') {
				result = this._taskManager.getTaskResult(legacyRequest.params.taskId);
			} else if (legacyRequest.method === 'tasks/cancel') {
				result = this._taskManager.cancelTask(legacyRequest.params.taskId);
			} else if (legacyRequest.method === 'tasks/list') {
				result = this._taskManager.listTasks();
			} else {
				throw McpError.methodNotFound(request.method);
			}

			if (isThenable(result)) {
				return result.then(undefined, (error: unknown) => {
					throw mapError(error);
				});
			}

			return result;
		} catch (e) {
			throw mapError(e);
		}
	}

	/**
	 * Handle incoming server notifications
	 */
	private handleServerNotification(notification: IJsonRpcNotification): void {
		try {
			if (this._subscriptions?.handleNotification(notification)) {
				return;
			}
			const request = notification as unknown as MCPLegacy.JSONRPCNotification & MCPLegacy.ServerNotification;
			switch (request.method) {
				case 'notifications/message':
					return this.handleLoggingNotification(request);
				case 'notifications/cancelled':
					this._onDidReceiveCancelledNotification.fire(request.params as unknown as MCP.CancelledNotificationParams);
					return this.handleCancelledNotification(request);
				case 'notifications/progress':
					this._onDidReceiveProgressNotification.fire(request);
					return;
				case 'notifications/resources/list_changed':
					this._onDidChangeResourceList.fire();
					return;
				case 'notifications/resources/updated':
					this._onDidUpdateResource.fire(request.params);
					return;
				case 'notifications/tools/list_changed':
					this._onDidChangeToolList.fire();
					return;
				case 'notifications/prompts/list_changed':
					this._onDidChangePromptList.fire();
					return;
				case 'notifications/elicitation/complete':
					this._onDidReceiveElicitationCompleteNotification.fire(request);
					return;
				case 'notifications/tasks/status':
					this._taskManager.getClientTask(request.params.taskId)?.onDidUpdateState(request.params);
					return;
				default:
					softAssertNever(request);
			}
		} catch (error) {
			this.logger.error(`Error handling notification ${notification.method}:`, error);
		}
	}

	private handleCancelledNotification(request: MCPLegacy.CancelledNotification): void {
		const requestId = request.params.requestId;
		if (requestId === undefined || requestId === null) {
			return;
		}
		if (this._subscriptions?.handleCancelled(requestId)) {
			// The server will not answer a request it cancelled; release it.
			this._rpc.failPendingRequest(requestId, new CancellationError());
			return;
		}
		// The server cancels a request it sent us (legacy sampling/elicitation)…
		if (this._rpc.cancelIncomingRequest(requestId)) {
			return;
		}
		// …or, leniently, tells us it abandoned one of ours.
		this._rpc.cancelPendingRequest(requestId);
	}

	private handleLoggingNotification(request: MCPLegacy.LoggingMessageNotification): void {
		translateMcpLogMessage(this.logger, request.params);
		this._onDidReceiveLoggingNotification.fire(request.params);
	}

	/**
	 * Send a response to a roots/list request
	 */
	private handleRootsList(): MCPLegacy.ListRootsResult {
		this._hasAnnouncedRoots = true;
		return { roots: this._roots };
	}

	//#endregion

	private cancelAllRequests() {
		this._rpc.cancelAllRequests();
	}

	public override dispose(): void {
		this.cancelAllRequests();
		super.dispose();
	}

	/**
	 * Forwards log level changes to a legacy MCP server if it supports logging
	 */
	private async _sendLogLevelToServer(logLevel: LogLevel): Promise<void> {
		try {
			// Only send if the server supports logging capabilities
			if (this._negotiated?.era !== 'legacy' || !this.capabilities.logging) {
				return;
			}

			await this.setLevel({ level: mapLogLevelToMcp(logLevel) });
		} catch (error) {
			this.logger.error(`Failed to set MCP server log level: ${error}`);
		}
	}

	//#region input_required

	/**
	 * Sends a request that may come back as `input_required`, answering the
	 * server's input requests and re-sending until the result is complete.
	 */
	private async _sendWithInputs<R extends object>(method: 'tools/call' | 'prompts/get' | 'resources/read', params: object, token: CancellationToken, context?: IMcpToolCallContext, onStatusMessage?: (message: string) => void, acceptResultTypes?: readonly string[], tasks = false): Promise<R> {
		const { inputResponses: _ignoredResponses, requestState: _ignoredState, ...base } = params as Record<string, unknown>;
		let current: Record<string, unknown> = { ...base };
		let rounds = 0;
		const inputKinds: string[] = [];
		const seenUrls = new Set<string>();
		for (; ;) {
			const result = await this._request<R | MCP.InputRequiredResult>(method, current, token, { acceptResultTypes: ['input_required', ...(acceptResultTypes ?? [])], tasks });
			const resultType = getResultType(result);
			if (resultType !== 'input_required') {
				if (rounds > 0) {
					this._onDidReportProtocolEvent.fire({ kind: 'mrtr', method, rounds, inputKinds });
				}
				return result as R;
			}
			if (++rounds > MAX_MRTR_ROUNDS) {
				throw new McpClientError('too-many-rounds', `The server asked for input more than ${MAX_MRTR_ROUNDS} times for ${method}`);
			}
			const parsed = parseInputRequiredResult(result);
			if (parsed instanceof McpClientError) {
				throw parsed;
			}
			const inputResponses: MCP.InputResponses = {};
			for (const [key, request] of Object.entries(parsed.inputRequests)) {
				inputKinds.push(request.method);
				inputResponses[key] = await this._answerInputRequest(request, token, context, seenUrls);
			}
			current = { ...base };
			if (Object.keys(inputResponses).length > 0) {
				current.inputResponses = inputResponses;
			}
			if (parsed.requestState !== undefined) {
				current.requestState = parsed.requestState;
			}
			onStatusMessage?.(localize('mcp.inputRound', "Round {0}: answered {1} input request(s)", rounds, Object.keys(inputResponses).length));
		}
	}

	private async _answerInputRequest(request: MCP.InputRequest, token: CancellationToken, context: IMcpToolCallContext | undefined, seenUrls: Set<string>): Promise<MCP.InputResponse> {
		switch (request.method) {
			case 'roots/list':
				this._hasAnnouncedRoots = true;
				return { roots: this._roots };
			case 'sampling/createMessage': {
				if (!this._createMessageRequestHandler) {
					throw new McpClientError('undeclared-input-request', 'The server asked for sampling, which this client did not declare');
				}
				const result = await this._createMessageRequestHandler(request.params as unknown as MCPLegacy.CreateMessageRequest['params'], token, context);
				return result as unknown as MCP.CreateMessageResult;
			}
			case 'elicitation/create': {
				if (!this._elicitationRequestHandler) {
					throw new McpClientError('undeclared-input-request', 'The server asked for elicitation, which this client did not declare');
				}
				const params = request.params as unknown as MCPLegacy.ElicitRequest['params'];
				let options: IMcpElicitOptions | undefined;
				if (params.mode === 'url') {
					const key = `${params.elicitationId}\0${params.url}`;
					options = { resume: seenUrls.has(key) };
					seenUrls.add(key);
				}
				const result = await this._elicitationRequestHandler(params, token, context, options);
				if (result.action === 'accept' && params.mode !== 'url') {
					const validation = validateElicitFormContent(result.content, params.requestedSchema);
					if (!validation.ok) {
						throw new McpClientError('invalid-elicit-content', `The elicitation answer does not match the requested schema: ${validation.message}`);
					}
					return { action: 'accept', content: validation.content as MCP.ElicitResult['content'] };
				}
				return result as MCP.ElicitResult;
			}
			default:
				throw new McpClientError('invalid-input-request', `Unsupported input request ${(request as { method: string }).method}`);
		}
	}

	/**
	 * Answers the input requests of a task waiting in `input_required` (the
	 * Tasks extension) with the same handlers and checks as a multi
	 * round-trip request; the caller sends the answers with `tasks/update`.
	 */
	async answerInputRequests(inputRequests: MCP.InputRequests, token: CancellationToken, context: IMcpToolCallContext | undefined, seenUrls: Set<string>): Promise<MCP.InputResponses> {
		const parsed = parseInputRequiredResult({ resultType: 'input_required', inputRequests });
		if (parsed instanceof McpClientError) {
			throw parsed;
		}
		const inputResponses: MCP.InputResponses = {};
		for (const [key, request] of Object.entries(parsed.inputRequests)) {
			inputResponses[key] = await this._answerInputRequest(request, token, context, seenUrls);
		}
		return inputResponses;
	}

	//#endregion

	//#region public API

	/** Re-fetches `server/discover` (modern servers). */
	async discover(token?: CancellationToken): Promise<MCP.DiscoverResult | undefined> {
		if (this.era !== 'modern') {
			return undefined;
		}
		const result = await this._request<MCP.DiscoverResult>('server/discover', {}, token ?? CancellationToken.None);
		this._discoverResult = result;
		this._discoverHint = cacheHintOf(result);
		return result;
	}

	/** Seeds the `x-mcp-header` annotations from a cached tool list (used before the first live listing). */
	seedToolHeaderAnnotations(tools: readonly MCPLegacy.Tool[]): void {
		for (const tool of tools) {
			const annotations = collectHeaderAnnotations(tool.inputSchema);
			if (annotations.kind === 'valid' && annotations.annotations.length > 0) {
				this._headerAnnotations.set(tool.name, annotations.annotations);
			}
		}
	}

	/**
	 * List available resources
	 */
	listResources(params?: MCPLegacy.ListResourcesRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Resource[]> {
		return Iterable.asyncToArrayFlat(this.listResourcesIterable(params, token));
	}

	/**
	 * List available resources (iterable)
	 */
	listResourcesIterable(params?: MCPLegacy.ListResourcesRequest['params'], token?: CancellationToken): AsyncIterable<MCPLegacy.Resource[]> {
		return this.sendRequestPaginated<MCPLegacy.ListResourcesResult, MCPLegacy.Resource>('resources/list', result => result.resources, params, token);
	}

	/** List available resources with the server's caching hint. */
	async listResourcesEx(params?: MCPLegacy.ListResourcesRequest['params'], token?: CancellationToken): Promise<IMcpListResult<MCPLegacy.Resource>> {
		const hints = new CacheHintCollector();
		const items = await Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListResourcesResult, MCPLegacy.Resource>('resources/list', result => result.resources, params, token, r => hints.add(r)));
		return { items, cacheHint: hints.hint };
	}

	/**
	 * Read a specific resource. Retry results (after an `input_required` round) are never cached: their `ttlMs` is set to 0.
	 */
	async readResource(params: MCPLegacy.ReadResourceRequest['params'], token: CancellationToken = CancellationToken.None, context?: IMcpToolCallContext): Promise<MCPLegacy.ReadResourceResult> {
		let rounds = 0;
		const listener = this.onDidReportProtocolEvent(e => {
			if (e.kind === 'mrtr' && e.method === 'resources/read') {
				rounds = e.rounds;
			}
		});
		try {
			const result = await this._sendWithInputs<MCPLegacy.ReadResourceResult & { ttlMs?: number }>('resources/read', params, token, context);
			if (rounds > 0 && typeof result.ttlMs === 'number') {
				return { ...result, ttlMs: 0 };
			}
			return result;
		} finally {
			listener.dispose();
		}
	}

	/**
	 * List available resource templates
	 */
	listResourceTemplates(params?: MCPLegacy.ListResourceTemplatesRequest['params'], token?: CancellationToken): Promise<MCPLegacy.ResourceTemplate[]> {
		return Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListResourceTemplatesResult, MCPLegacy.ResourceTemplate>('resources/templates/list', result => result.resourceTemplates, params, token));
	}

	/**
	 * Subscribes to updates of a resource; `onDidUpdateResource` fires for it
	 * until the returned disposable is disposed. Modern servers get a
	 * `subscriptions/listen` stream, legacy servers `resources/subscribe`.
	 */
	subscribeResource(uri: string): IDisposable {
		if (this._subscriptions) {
			return this._subscriptions.subscribeResource(uri);
		}
		// Legacy servers: try even when the capability is not advertised (as before) and only warn on failure.
		let disposed = false;
		this._request<MCPLegacy.EmptyResult>('resources/subscribe', { uri }, CancellationToken.None).then(() => {
			if (disposed) {
				this._request('resources/unsubscribe', { uri }, CancellationToken.None).catch(() => { });
			}
		}, err => {
			this.logger.warn(`Failed to subscribe to ${uri}: ${err}`);
		});
		return toDisposable(() => {
			if (!disposed) {
				disposed = true;
				if (!this._store.isDisposed) {
					this._request('resources/unsubscribe', { uri }, CancellationToken.None).catch(() => { });
				}
			}
		});
	}

	/**
	 * List available prompts
	 */
	listPrompts(params?: MCPLegacy.ListPromptsRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Prompt[]> {
		return Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListPromptsResult, MCPLegacy.Prompt>('prompts/list', result => result.prompts, params, token));
	}

	/** List available prompts with the server's caching hint. */
	async listPromptsEx(params?: MCPLegacy.ListPromptsRequest['params'], token?: CancellationToken): Promise<IMcpListResult<MCPLegacy.Prompt>> {
		const hints = new CacheHintCollector();
		const items = await Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListPromptsResult, MCPLegacy.Prompt>('prompts/list', result => result.prompts, params, token, r => hints.add(r)));
		return { items, cacheHint: hints.hint };
	}

	/**
	 * Get a specific prompt
	 */
	getPrompt(params: MCPLegacy.GetPromptRequest['params'], token: CancellationToken = CancellationToken.None, context?: IMcpToolCallContext): Promise<MCPLegacy.GetPromptResult> {
		return this._sendWithInputs<MCPLegacy.GetPromptResult>('prompts/get', params, token, context);
	}

	/**
	 * List available tools
	 */
	async listTools(params?: MCPLegacy.ListToolsRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Tool[]> {
		return (await this.listToolsEx(params, token)).items;
	}

	/**
	 * List available tools with the server's caching hint. Tools whose
	 * `x-mcp-header` annotations are invalid are dropped (modern servers).
	 */
	async listToolsEx(params?: MCPLegacy.ListToolsRequest['params'], token?: CancellationToken): Promise<IMcpListResult<MCPLegacy.Tool>> {
		const hints = new CacheHintCollector();
		const all = await Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListToolsResult, MCPLegacy.Tool>('tools/list', result => result.tools, params, token, r => hints.add(r)));
		if (this._negotiated?.era !== 'modern') {
			return { items: all, cacheHint: hints.hint };
		}
		const items: MCPLegacy.Tool[] = [];
		this._headerAnnotations.clear();
		for (const tool of all) {
			const annotations = collectHeaderAnnotations(tool.inputSchema);
			if (annotations.kind === 'invalid') {
				if (!this._droppedTools.has(tool.name)) {
					this._droppedTools.add(tool.name);
					this.logger.warn(`Ignoring tool "${tool.name}": invalid x-mcp-header annotation (${annotations.problem}${annotations.annotation ? ` on ${annotations.annotation}` : ''})`);
				}
				continue;
			}
			this._droppedTools.delete(tool.name);
			if (annotations.annotations.length > 0) {
				this._headerAnnotations.set(tool.name, annotations.annotations);
			}
			items.push(tool);
		}
		return { items, cacheHint: hints.hint };
	}

	/**
	 * Call a specific tool. Answers `input_required` rounds. A `task` on the
	 * request opts into tasks: legacy servers get it as the 2025-11-25 task
	 * augmentation; modern servers that advertise the Tasks extension
	 * (`io.modelcontextprotocol/tasks`) see the extension in this request's
	 * client capabilities instead (the `task` param is not sent) and may
	 * answer with a `CreateTaskResult`, which is then polled to its result.
	 */
	async callTool(params: MCPLegacy.CallToolRequest['params'] & MCPLegacy.Request['params'], token: CancellationToken = CancellationToken.None, onStatusMessage?: (message: string) => void, context?: IMcpToolCallContext): Promise<MCPLegacy.CallToolResult> {
		if (this._negotiated?.era === 'modern') {
			const { task, ...modernParams } = params;
			const tasks = task !== undefined && this.supportsModernTasks;
			const modernResponse = await this._sendWithInputs<MCPLegacy.CallToolResult | McpTasks.CreateTaskResult>('tools/call', modernParams, token, context, onStatusMessage, tasks ? [McpTasks.RESULT_TYPE_TASK] : undefined, tasks);
			if (!McpTasks.isCreateTaskResult(modernResponse as MCP.Result)) {
				return modernResponse as MCPLegacy.CallToolResult;
			}
			const created = modernResponse as McpTasks.CreateTaskResult;
			const modernTask = new McpModernTask(created, token, onStatusMessage, context);
			this._taskManager.adoptClientTask(modernTask);
			modernTask.setHandler(this);
			return modernTask.result.finally(() => {
				this._taskManager.abandonClientTask(modernTask.id);
			});
		}

		const response = await this._sendWithInputs<MCPLegacy.CallToolResult | MCPLegacy.CreateTaskResult>('tools/call', params, token, context, onStatusMessage);

		if (this._negotiated?.era === 'legacy' && isTaskResult(response)) {
			const task = new McpTask<MCPLegacy.CallToolResult>(response.task, token, onStatusMessage);
			this._taskManager.adoptClientTask(task);
			task.setHandler(this);
			return task.result.finally(() => {
				this._taskManager.abandonClientTask(task.id);
			});
		}

		return response as MCPLegacy.CallToolResult;
	}

	/**
	 * Set the logging level. Legacy servers get `logging/setLevel`; modern
	 * servers see the level in the `_meta` of every following request.
	 */
	async setLevel(params: MCPLegacy.SetLevelRequest['params'], token?: CancellationToken): Promise<MCPLegacy.EmptyResult> {
		this._logLevel = params.level;
		if (this._negotiated?.era !== 'legacy') {
			return {};
		}
		return this._request<MCPLegacy.EmptyResult>('logging/setLevel', params, token ?? CancellationToken.None);
	}

	/**
	 * Find completions for an argument
	 */
	complete(params: MCPLegacy.CompleteRequest['params'], token?: CancellationToken): Promise<MCPLegacy.CompleteResult> {
		return this._request<MCPLegacy.CompleteResult>('completion/complete', params, token ?? CancellationToken.None);
	}

	/**
	 * Get task status
	 */
	getTask(params: { taskId: string }, token?: CancellationToken): Promise<MCPLegacy.GetTaskResult> {
		return this._request<MCPLegacy.GetTaskResult>('tasks/get', params, token ?? CancellationToken.None);
	}

	/**
	 * Get task result
	 */
	getTaskResult(params: { taskId: string }, token?: CancellationToken): Promise<MCPLegacy.GetTaskPayloadResult> {
		return this._request<MCPLegacy.GetTaskPayloadResult>('tasks/result', params, token ?? CancellationToken.None);
	}

	/**
	 * Cancel a task
	 */
	cancelTask(params: { taskId: string }, token?: CancellationToken): Promise<MCPLegacy.CancelTaskResult> {
		return this._request<MCPLegacy.CancelTaskResult>('tasks/cancel', params, token ?? CancellationToken.None);
	}

	/**
	 * List all tasks
	 */
	listTasks(params?: MCPLegacy.ListTasksRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Task[]> {
		return Iterable.asyncToArrayFlat(
			this.sendRequestPaginated<MCPLegacy.ListTasksResult, MCPLegacy.Task>('tasks/list', result => result.tasks, params, token)
		);
	}

	/** Whether the server speaks 2026-07-28 and advertises the Tasks extension (`io.modelcontextprotocol/tasks`). */
	get supportsModernTasks(): boolean {
		if (this._negotiated?.era !== 'modern') {
			return false;
		}
		const extensions: unknown = this.capabilities.extensions;
		return typeof extensions === 'object' && extensions !== null && Object.prototype.hasOwnProperty.call(extensions, McpTasks.EXTENSION_ID);
	}

	/** `tasks/get` of the Tasks extension (modern servers): the task, with the inlined result or error once it settled. */
	getModernTask(params: { taskId: string }, token?: CancellationToken): Promise<McpTasks.GetTaskResult> {
		return this._request<McpTasks.GetTaskResult>('tasks/get', params, token ?? CancellationToken.None, { tasks: true });
	}

	/** `tasks/update` of the Tasks extension: delivers the answers to a task's input requests. */
	updateTask(params: { taskId: string; inputResponses?: MCP.InputResponses }, token?: CancellationToken): Promise<McpTasks.UpdateTaskResult> {
		return this._request<McpTasks.UpdateTaskResult>('tasks/update', params, token ?? CancellationToken.None, { tasks: true });
	}

	/** `tasks/cancel` of the Tasks extension: an empty acknowledgement, also for a task that already settled. */
	cancelModernTask(params: { taskId: string }, token?: CancellationToken): Promise<McpTasks.CancelTaskResult> {
		return this._request<McpTasks.CancelTaskResult>('tasks/cancel', params, token ?? CancellationToken.None, { tasks: true });
	}

	//#endregion
}

/** Collects the per-page caching hints of a paginated listing into one hint (shortest TTL, private if any page is). */
class CacheHintCollector {
	private _ttlMs: number | undefined;
	private _scope: 'public' | 'private' | undefined;
	private _sawHint = false;
	private readonly _receivedAt = Date.now();

	add(result: unknown): void {
		const hint = cacheHintOf(result);
		if (hint.ttlMs === undefined && hint.cacheScope === undefined) {
			return;
		}
		if (hint.ttlMs !== undefined) {
			this._ttlMs = this._ttlMs === undefined ? hint.ttlMs : Math.min(this._ttlMs, hint.ttlMs);
		}
		if (hint.cacheScope === 'private' || this._scope === undefined) {
			this._scope = hint.cacheScope ?? this._scope;
		}
		this._sawHint = true;
	}

	get hint(): IMcpCacheHint {
		return { receivedAt: this._receivedAt, ttlMs: this._sawHint ? this._ttlMs : undefined, cacheScope: this._sawHint ? this._scope : undefined };
	}
}

function cacheHintOf(result: unknown): IMcpCacheHint {
	const receivedAt = Date.now();
	if (typeof result !== 'object' || result === null) {
		return { receivedAt, ttlMs: undefined, cacheScope: undefined };
	}
	const { ttlMs, cacheScope } = result as { ttlMs?: unknown; cacheScope?: unknown };
	return {
		receivedAt,
		ttlMs: typeof ttlMs === 'number' && ttlMs >= 0 ? ttlMs : undefined,
		cacheScope: cacheScope === 'public' || cacheScope === 'private' ? cacheScope : undefined,
	};
}

function supportedVersionsFromError(data: unknown): readonly string[] {
	if (typeof data !== 'object' || data === null) {
		return [];
	}
	const supported = (data as { supported?: unknown }).supported;
	return Array.isArray(supported) ? supported.filter((v): v is string => typeof v === 'string') : [];
}

function legacyToModernCapabilities(cap: MCPLegacy.ServerCapabilities): MCP.ServerCapabilities {
	const out: MCP.ServerCapabilities = {};
	if (cap.experimental) {
		out.experimental = cap.experimental as MCP.ServerCapabilities['experimental'];
	}
	if (cap.logging) {
		out.logging = cap.logging as MCP.JSONObject;
	}
	if (cap.completions) {
		out.completions = cap.completions as MCP.JSONObject;
	}
	if (cap.prompts) {
		out.prompts = { listChanged: cap.prompts.listChanged };
	}
	if (cap.resources) {
		out.resources = { subscribe: cap.resources.subscribe, listChanged: cap.resources.listChanged };
	}
	if (cap.tools) {
		out.tools = { listChanged: cap.tools.listChanged };
	}
	if (cap.extensions) {
		out.extensions = cap.extensions as MCP.ServerCapabilities['extensions'];
	}
	return out;
}

function isTaskInTerminalState(task: MCPLegacy.Task): boolean {
	return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

/**
 * Implementation of a task that handles polling, status notifications, and handler reconnections. It implements the task polling loop internally and can also be
 * updated externally via `onDidUpdateState`, when notifications are received
 * for example.
 * @internal
 */
export class McpTask<T extends MCPLegacy.Result> extends Disposable implements IMcpTaskInternal {
	private readonly promise = new DeferredPromise<T>();

	public get result(): Promise<T> {
		return this.promise.p;
	}

	public get id() {
		return this._task.taskId;
	}

	private _lastTaskState: ISettableObservable<MCPLegacy.Task>;
	private _handler = observableValue<McpServerRequestHandler | undefined>('mcpTaskHandler', undefined);

	constructor(
		private readonly _task: MCPLegacy.Task,
		_token: CancellationToken = CancellationToken.None,
		private readonly _onStatusMessage?: (message: string) => void,
	) {
		super();

		const expiresAt = _task.ttl ? (Date.now() + _task.ttl) : undefined;
		this._lastTaskState = observableValue('lastTaskState', this._task);

		const store = this._register(new DisposableStore());

		// Handle external cancellation token
		if (_token.isCancellationRequested) {
			this._lastTaskState.set({ ...this._task, status: 'cancelled' }, undefined);
		} else {
			store.add(_token.onCancellationRequested(() => {
				const current = this._lastTaskState.get();
				if (!isTaskInTerminalState(current)) {
					this._lastTaskState.set({ ...current, status: 'cancelled' }, undefined);
				}
			}));
		}

		// Handle TTL expiration with an explicit timeout
		if (expiresAt) {
			const ttlTimeout = expiresAt - Date.now();
			if (ttlTimeout <= 0) {
				this._lastTaskState.set({ ...this._task, status: 'cancelled', statusMessage: 'Task timed out.' }, undefined);
			} else {
				store.add(disposableTimeout(() => {
					const current = this._lastTaskState.get();
					if (!isTaskInTerminalState(current)) {
						this._lastTaskState.set({ ...current, status: 'cancelled', statusMessage: 'Task timed out.' }, undefined);
					}
				}, ttlTimeout));
			}
		}

		// A `tasks/result` call triggered by an input_required state.
		const inputRequiredLookup = observableValue<ObservablePromise<MCPLegacy.Task> | undefined>('activeResultLookup', undefined);

		// 1. Poll for task updates when the task isn't in a terminal state
		store.add(autorun(reader => {
			const current = this._lastTaskState.read(reader);
			if (isTaskInTerminalState(current)) {
				return;
			}

			// When a task goes into the input_required state, by spec we should call
			// `tasks/result` which can return an SSE stream of task updates. No need
			// to poll while such a lookup is going on, but once it resolves we should
			// clear and update our state.
			const lookup = inputRequiredLookup.read(reader);
			if (lookup) {
				const result = lookup.promiseResult.read(reader);
				return transaction(tx => {
					if (!result) {
						// still ongoing
					} else if (result.data) {
						inputRequiredLookup.set(undefined, tx);
						this._lastTaskState.set(result.data, tx);
					} else {
						inputRequiredLookup.set(undefined, tx);
						if (result.error instanceof McpError && result.error.code === MCPLegacy.INVALID_PARAMS) {
							this._lastTaskState.set({ ...current, status: 'cancelled' }, undefined);
						} else {
							// Maybe a connection error -- start polling again
							this._lastTaskState.set({ ...current, status: 'working' }, undefined);
						}
					}
				});
			}

			const handler = this._handler.read(reader);
			if (!handler) {
				return;
			}

			const pollInterval = _task.pollInterval ?? 2000;
			const cts = new CancellationTokenSource(_token);
			reader.store.add(toDisposable(() => cts.dispose(true)));
			reader.store.add(disposableTimeout(() => {
				handler.getTask({ taskId: current.taskId }, cts.token)
					.catch((e): MCPLegacy.Task | undefined => {
						if (e instanceof McpError && e.code === MCPLegacy.INVALID_PARAMS) {
							return { ...current, status: 'cancelled' };
						} else {
							return { ...current }; // errors are already logged, keep in current state
						}
					})
					.then(r => {
						if (r && !cts.token.isCancellationRequested) {
							this._lastTaskState.set(r, undefined);
						}
					});
			}, pollInterval));
		}));

		// 2. Get the result once it's available (or propagate errors). Trigger
		// input_required handling as needed. Only react when the status itself changes.
		const lastStatus = this._lastTaskState.map(task => task.status);
		store.add(autorun(reader => {
			const status = lastStatus.read(reader);
			if (status === 'failed') {
				const current = this._lastTaskState.read(undefined);
				this.promise.error(new Error(`Task ${current.taskId} failed: ${current.statusMessage ?? 'unknown error'}`));
				store.dispose();
			} else if (status === 'cancelled') {
				this.promise.cancel();
				store.dispose();
			} else if (status === 'input_required') {
				const handler = this._handler.read(reader);
				if (handler) {
					const current = this._lastTaskState.read(undefined);
					const cts = new CancellationTokenSource(_token);
					reader.store.add(toDisposable(() => cts.dispose(true)));
					inputRequiredLookup.set(new ObservablePromise<MCPLegacy.Task>(handler.getTask({ taskId: current.taskId }, cts.token)), undefined);
				}
			} else if (status === 'completed') {
				const handler = this._handler.read(reader);
				if (handler) {
					this.promise.settleWith(handler.getTaskResult({ taskId: _task.taskId }, _token) as Promise<T>);
					store.dispose();
				}
			} else if (status === 'working') {
				// no-op
			} else {
				softAssertNever(status);
			}
		}));
	}

	onDidUpdateState(task: MCPLegacy.Task) {
		this._lastTaskState.set(task, undefined);
		if (task.statusMessage && this._onStatusMessage) {
			this._onStatusMessage(task.statusMessage);
		}
	}

	setHandler(handler: McpServerRequestHandler | undefined): void {
		this._handler.set(handler, undefined);
	}
}
