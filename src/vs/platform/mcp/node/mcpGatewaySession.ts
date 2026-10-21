/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, RunOnceScheduler } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { IJsonRpcErrorResponse, IJsonRpcNotification, IJsonRpcRequest, IJsonRpcSuccessResponse, JsonRpcId, JsonRpcMessage, JsonRpcResponse } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableMap, IDisposable } from '../../../base/common/lifecycle.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { legacyVersionSupportsPriming, MAX_LISTEN_FILTER_LENGTH, MAX_LISTEN_RESOURCE_SUBSCRIPTIONS, McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { LEGACY_MCP_PROTOCOL_VERSIONS, META_PROGRESS_TOKEN } from '../common/mcpProtocolVersions.js';
import { MCP } from '../common/modelContextProtocol.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';
import { IMcpGatewayDispatchContext, IMcpGatewayNotification, McpGatewayDispatcher } from './mcpGatewayDispatcher.js';
import { McpGatewayEventLog, McpGatewayStreamKind } from './mcpGatewayEventLog.js';

/** A legacy session with no message in flight and no open stream for this long is disposed. */
export const LEGACY_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The most resources one 2025-11-25 session subscribes to with
 * `resources/subscribe`: the limit of one 2026-07-28 `subscriptions/listen`
 * filter. With the route's session limit (`MAX_LEGACY_SESSIONS`) it bounds
 * what the legacy clients of a route keep subscribed upstream.
 */
export const MAX_LEGACY_RESOURCE_SUBSCRIPTIONS = MAX_LISTEN_RESOURCE_SUBSCRIPTIONS;

/** The most characters the subscribed URIs of one 2025-11-25 session add up to: the size limit of one `subscriptions/listen` filter. */
export const MAX_LEGACY_SUBSCRIPTION_URI_LENGTH = MAX_LISTEN_FILTER_LENGTH;

/** Where the messages produced while serving a request go: the client's response stream. */
export interface IMcpGatewayMessageSink {
	notify(notification: IMcpGatewayNotification): void;
	/**
	 * Legacy sessions: writes a server→client request and resolves with the
	 * client's result; rejects when `token` (the originating request's) cancels.
	 */
	sendRequest(request: IMcpGatewayNotification, token?: CancellationToken): Promise<unknown>;
	/**
	 * Legacy sessions at 2025-11-25 (SEP-1699 polling): ends the HTTP response
	 * now, with a `retry` hint, but not the stream: what the request produces
	 * afterwards is logged for the client's `Last-Event-ID` reconnection.
	 * Returns whether the response was closed.
	 */
	closeForPolling?(): boolean;
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

/** What an HTTP response needs to carry an SSE stream of a legacy session. */
export interface IMcpGatewayLegacyStreamOptions {
	readonly broker: IMcpGatewayRequestBroker;
	/** The session's streams and replay log: every event of the response goes through it. */
	readonly log: McpGatewayEventLog;
	/** What the response is when it starts a stream: a POST's response stream or a GET stream. */
	readonly kind: McpGatewayStreamKind;
	/** Whether the session's revision allows priming events (and so closing the stream for polling). */
	readonly priming: () => boolean;
	/** The cancellation token of the request(s) the response answers (POST responses). */
	readonly token?: CancellationToken;
}

/** The JSON-RPC form of a notification. */
export function notificationMessage(notification: IMcpGatewayNotification): IJsonRpcNotification {
	return notification.params === undefined ? { jsonrpc: '2.0', method: notification.method } : { jsonrpc: '2.0', method: notification.method, params: notification.params };
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

/** A `resources/subscribe` whose upstream subscription is being opened. */
interface IOpeningSubscription {
	/** False once `resources/unsubscribe` came for its URI (and no `resources/subscribe` after it). */
	wanted: boolean;
	/** Settles when the upstream call does: rejects with its error. */
	opened: Promise<void>;
}

function errorResponseFor(id: JsonRpcId, error: McpGatewayRpcError): IJsonRpcErrorResponse {
	return { jsonrpc: '2.0', id, error: error.data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data: error.data } };
}

/**
 * One 2025-11-25 (and earlier) Streamable HTTP session: the `initialize`
 * handshake, the per-session logging level and resource subscriptions, the
 * server→client requests the dispatcher's input rounds need, the session's
 * SSE streams with their replay log, and the list-changed notifications,
 * each sent on one stream only (the most recent open GET stream). Every
 * other method goes through the {@link McpGatewayDispatcher}. A session that
 * has been idle (no message in flight, no open stream) for
 * {@link LEGACY_SESSION_IDLE_TIMEOUT_MS} disposes itself.
 */
export class McpGatewaySession extends Disposable implements IMcpGatewayRequestBroker {
	/** The open GET streams, oldest first. */
	private readonly _streams: IMcpGatewaySessionStream[] = [];
	private readonly _streamListeners = this._register(new DisposableMap<IMcpGatewaySessionStream>());
	private readonly _pending = new Map<JsonRpcId, { readonly deferred: DeferredPromise<unknown>; readonly listener: IDisposable }>();
	private readonly _inflight = new Map<JsonRpcId, CancellationTokenSource>();
	private readonly _resourceSubscriptions = this._register(new DisposableMap<string>());
	/**
	 * The upstream subscriptions being opened, at most one per URI. Each
	 * counts toward the session's limits until its upstream call settles,
	 * also once the client unsubscribed (then `wanted` is false and the
	 * subscription is closed as soon as it opens), so subscribing and
	 * unsubscribing in a loop cannot pile up upstream calls.
	 */
	private readonly _openingSubscriptions = new Map<string, IOpeningSubscription>();
	private readonly _idleTimer: RunOnceScheduler;
	/** Open responses that keep the session from expiring, each with the listener that releases it. */
	private readonly _holds = this._register(new DisposableMap<object>());
	private _activeMessages = 0;
	/** When a message of the session or one of its open responses last started or ended (or the session was created). */
	private _lastActiveAt = Date.now();
	private _nextServerRequestId = 1;
	private _initialized = false;
	private _protocolVersion: string | undefined;
	private _clientCapabilities: MCP.ClientCapabilities = {};
	private _clientInfo: MCP.Implementation | undefined;
	private _logLevel: MCP.LoggingLevel | undefined;

	/** The session's SSE streams and the events kept for `Last-Event-ID` replay. */
	readonly eventLog = new McpGatewayEventLog();

	/** The session's own streams (HTTP GET): where messages go that have no response stream of their own. */
	readonly streamSink: IMcpGatewayMessageSink = {
		notify: notification => this._sendUnrelated(notification),
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
		idleTimeoutMs: number = LEGACY_SESSION_IDLE_TIMEOUT_MS,
	) {
		super();
		this._idleTimer = this._register(new RunOnceScheduler(() => {
			this._logger.info(`[McpGateway][session ${this.id}] Expiring the session after ${Math.round(idleTimeoutMs / 1000)}s without requests or open streams`);
			this.dispose();
		}, idleTimeoutMs));
		this._register(_invoker.onDidChangeTools(() => this._sendListChanged('notifications/tools/list_changed')));
		this._register(_invoker.onDidChangeResources(() => this._sendListChanged('notifications/resources/list_changed')));
		if (_invoker.onDidChangePrompts) {
			this._register(_invoker.onDidChangePrompts(() => this._sendListChanged('notifications/prompts/list_changed')));
		}
		if (_invoker.onDidUpdateResource) {
			this._register(_invoker.onDidUpdateResource(({ uri }) => {
				if (this._resourceSubscriptions.has(uri)) {
					this._sendUnrelated({ method: 'notifications/resources/updated', params: { uri } });
				}
			}));
		}
		this._updateIdle();
	}

	get isInitialized(): boolean {
		return this._initialized;
	}

	/** The negotiated legacy revision; undefined before `initialize`. */
	get protocolVersion(): string | undefined {
		return this._protocolVersion;
	}

	/** Whether the session's streams get SEP-1699 priming events (2025-11-25 and later). */
	get supportsPriming(): boolean {
		return legacyVersionSupportsPriming(this._protocolVersion);
	}

	get logLevel(): MCP.LoggingLevel | undefined {
		return this._logLevel;
	}

	get clientCapabilities(): MCP.ClientCapabilities {
		return this._clientCapabilities;
	}

	get streamCount(): number {
		return this._streams.length;
	}

	get pendingRequestCount(): number {
		return this._pending.size;
	}

	/** Whether nothing of the session runs: no message in flight and no open response (the idle timer runs). */
	get isIdle(): boolean {
		return !this._store.isDisposed && this._activeMessages === 0 && this._holds.size === 0;
	}

	/** When a message of the session or one of its open responses last started or ended (`Date.now()` time). */
	get lastActiveAt(): number {
		return this._lastActiveAt;
	}

	/** What a response of this session needs to carry one of its SSE streams. */
	streamOptions(kind: McpGatewayStreamKind, token?: CancellationToken): IMcpGatewayLegacyStreamOptions {
		return { broker: this, log: this.eventLog, kind, priming: () => this.supportsPriming, token };
	}

	/** Adds an open GET stream; it is forgotten when it closes. The most recent open one carries the messages that belong to no request. */
	attachStream(stream: IMcpGatewaySessionStream): void {
		this._streams.push(stream);
		this._logger.info(`[McpGateway][session ${this.id}] Stream attached (total: ${this._streams.length})`);
		this.holdOpen(stream.onDidClose);
		this._streamListeners.set(stream, stream.onDidClose(() => {
			const index = this._streams.indexOf(stream);
			if (index !== -1) {
				this._streams.splice(index, 1);
			}
			this._streamListeners.deleteAndDispose(stream);
			this._logger.info(`[McpGateway][session ${this.id}] Stream detached (total: ${this._streams.length})`);
		}));
	}

	/** Keeps the session from expiring until `onDidClose` fires (an open response of the session). */
	holdOpen(onDidClose: Event<void>): void {
		if (this._store.isDisposed) {
			return;
		}
		const hold = {};
		this._lastActiveAt = Date.now();
		this._idleTimer.cancel();
		this._holds.set(hold, Event.once(onDidClose)(() => {
			this._holds.deleteAndDispose(hold);
			this._updateIdle();
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
		this._activeMessages++;
		this._lastActiveAt = Date.now();
		this._idleTimer.cancel();
		try {
			for (const single of messages) {
				const response = await this._handleMessage(single, sink, headers, token);
				if (response) {
					responses.push(response);
				}
			}
		} finally {
			this._activeMessages--;
			this._updateIdle();
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

	/** Cancels an in-flight client request of this session (`notifications/cancelled`). */
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
		this._logger.info(`[McpGateway][session ${this.id}] Disposing session (streams: ${this._streams.length}, pending: ${this._pending.size})`);
		for (const id of [...this._pending.keys()]) {
			this._failPending(id, new CancellationError());
		}
		for (const cts of this._inflight.values()) {
			cts.cancel();
		}
		for (const stream of [...this._streams]) {
			stream.end();
		}
		this._streams.length = 0;
		this.eventLog.endAll();
		this._onDidDispose();
		super.dispose();
	}

	private _updateIdle(): void {
		if (this._store.isDisposed) {
			return;
		}
		this._lastActiveAt = Date.now();
		if (this._activeMessages > 0 || this._holds.size > 0) {
			this._idleTimer.cancel();
		} else {
			// (Re)starts the clock: the session has just become idle.
			this._idleTimer.schedule();
		}
	}

	/** The most recent open GET stream. */
	private _openStream(): IMcpGatewaySessionStream | undefined {
		for (let i = this._streams.length - 1; i >= 0; i--) {
			if (this._streams[i].isOpen) {
				return this._streams[i];
			}
		}
		return undefined;
	}

	/**
	 * A message that belongs to no request (a list change, a resource update):
	 * 2025-11-25 sends each message on one stream only, so it goes on the most
	 * recent open GET stream. Without one it is kept in the replay log of the
	 * session's latest GET stream, for a client that resumes it.
	 */
	private _sendUnrelated(notification: IMcpGatewayNotification): void {
		const stream = this._openStream();
		if (stream) {
			stream.notify(notification);
			return;
		}
		const latest = this.eventLog.latestStandalone;
		if (latest !== undefined && this.eventLog.write(latest, notificationMessage(notification)) !== undefined) {
			this._logger.debug(`[McpGateway][session ${this.id}] No open stream for ${notification.method}: kept for replay on stream ${latest}`);
			return;
		}
		this._logger.debug(`[McpGateway][session ${this.id}] No stream for ${notification.method}, dropping it`);
	}

	private _sendListChanged(method: string): void {
		if (!this._initialized) {
			return;
		}
		this._logger.info(`[McpGateway][session ${this.id}] ${method}`);
		this._sendUnrelated({ method });
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
				// Only this session's requests: another session may well use the same id.
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
				// A subscription still being opened is closed as soon as it is (it keeps its slot until then).
				const opening = this._openingSubscriptions.get(params.uri);
				if (opening) {
					opening.wanted = false;
				}
				return {};
			}
		}
		const meta = isObject(params._meta) ? params._meta : undefined;
		const progressTokenRaw = meta?.[META_PROGRESS_TOKEN];
		const closeForPolling = sink.closeForPolling;
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
			// A 2025-11-25 client is its session, for the rate limits as for everything else.
			clientKey: `session:${this.id}`,
			notify: notification => sink.notify(notification),
			sendServerRequest: serverRequest => sink.sendRequest(serverRequest, token),
			closeSseStream: closeForPolling && this.supportsPriming ? () => {
				if (closeForPolling.call(sink)) {
					this._logger.debug(`[McpGateway][session ${this.id}] Closed the stream of ${request.method} (id=${String(request.id)}) for polling`);
				}
			} : undefined,
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
		const opening = this._openingSubscriptions.get(uri);
		if (opening) {
			// Already being opened (maybe unsubscribed since): this request wants it again and gets the outcome of that one upstream call.
			opening.wanted = true;
			await opening.opened;
			return {};
		}
		this._checkSubscriptionLimits(uri);
		const subscribe = this._invoker.subscribeResource;
		if (!subscribe) {
			this._logger.debug(`[McpGateway][session ${this.id}] The server cannot watch ${uri}; subscription recorded without updates`);
			this._resourceSubscriptions.set(uri, Disposable.None);
			return {};
		}
		await this._openSubscription(uri, subscribe).opened;
		return {};
	}

	/**
	 * Opens the upstream subscription of `uri`: it is kept when the client
	 * still wants it once it opens (no `resources/unsubscribe` came last),
	 * and closed at once otherwise.
	 */
	private _openSubscription(uri: string, subscribe: NonNullable<IMcpGatewaySingleServerInvoker['subscribeResource']>): IOpeningSubscription {
		const opening: IOpeningSubscription = { wanted: true, opened: Promise.resolve() };
		this._openingSubscriptions.set(uri, opening);
		opening.opened = (async () => {
			let subscription: IDisposable;
			try {
				subscription = await subscribe.call(this._invoker, uri);
			} finally {
				if (this._openingSubscriptions.get(uri) === opening) {
					this._openingSubscriptions.delete(uri);
				}
			}
			if (this._store.isDisposed || !opening.wanted) {
				subscription.dispose();
			} else {
				this._resourceSubscriptions.set(uri, subscription);
			}
		})();
		return opening;
	}

	/**
	 * Refuses (`-32603`, as a `subscriptions/listen` filter over the limits) a
	 * subscription that would take the session past
	 * {@link MAX_LEGACY_RESOURCE_SUBSCRIPTIONS} URIs or
	 * {@link MAX_LEGACY_SUBSCRIPTION_URI_LENGTH} characters of URIs. The
	 * subscriptions still being opened count, also those the client has
	 * unsubscribed from (their upstream call is still in flight).
	 */
	private _checkSubscriptionLimits(uri: string): void {
		const count = this._resourceSubscriptions.size + this._openingSubscriptions.size;
		if (count >= MAX_LEGACY_RESOURCE_SUBSCRIPTIONS) {
			this._logger.warn(`[McpGateway][session ${this.id}] Refused resources/subscribe: the session already has ${count} subscriptions (limit ${MAX_LEGACY_RESOURCE_SUBSCRIPTIONS})`);
			throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `Too many resource subscriptions in this session (limit ${MAX_LEGACY_RESOURCE_SUBSCRIPTIONS}); unsubscribe from some first`);
		}
		let length = uri.length;
		for (const subscribed of this._resourceSubscriptions.keys()) {
			length += subscribed.length;
		}
		for (const pending of this._openingSubscriptions.keys()) {
			length += pending.length;
		}
		if (length > MAX_LEGACY_SUBSCRIPTION_URI_LENGTH) {
			this._logger.warn(`[McpGateway][session ${this.id}] Refused resources/subscribe: the subscribed URIs would have ${length} characters (limit ${MAX_LEGACY_SUBSCRIPTION_URI_LENGTH})`);
			throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `The resource subscriptions of this session are too large: ${length} characters of URIs (limit ${MAX_LEGACY_SUBSCRIPTION_URI_LENGTH}); unsubscribe from some first`);
		}
	}
}

export function isInitializeMessage(message: unknown): boolean {
	const first = Array.isArray(message) ? message[0] : message;
	return isRequest(first) && first.method === 'initialize';
}

/** Whether a POST body carries at least one request (it must then be answered with JSON or an event stream, never 202). */
export function containsRequest(message: unknown): boolean {
	return Array.isArray(message) ? message.some(isRequest) : isRequest(message);
}
