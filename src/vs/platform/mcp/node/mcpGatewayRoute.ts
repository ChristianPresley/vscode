/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { IntervalTimer } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IJsonRpcRequest, JsonRpcId, JsonRpcMessage, JsonRpcResponse } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { applyModernEnvelope, classifyEra, clientInfoFromMeta, errorResponse, httpStatusForRpcError, IMcpGatewayErrorResponse, IModernRequestMeta, LEGACY_TRANSPORT_ERROR, McpGatewayRpcError, validateLegacyProtocolVersionHeader, validateSubscriptionFilter } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';
import { IMcpGatewayDispatchContext, IMcpGatewayDispatcherOptions, IMcpGatewayNotification, McpGatewayDispatcher } from './mcpGatewayDispatcher.js';
import { IMcpGatewaySseConnection, McpGatewayStreamKind } from './mcpGatewayEventLog.js';
import { IMcpGatewayListenStream, McpGatewayListenRegistry } from './mcpGatewayListenRegistry.js';
import { McpGatewaySealedState } from './mcpGatewaySealedState.js';
import { containsRequest, IMcpGatewayLegacyStreamOptions, IMcpGatewayMessageSink, IMcpGatewaySessionStream, isInitializeMessage, McpGatewaySession, notificationMessage } from './mcpGatewaySession.js';

/** The largest POST body the gateway reads; anything bigger is answered with 413. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** How often an open SSE stream gets a comment line so intermediaries keep it alive. */
export const SSE_KEEPALIVE_MS = 15_000;
/** The reconnection delay legacy streams advertise in their priming event and when the server closes them for polling. */
export const LEGACY_SSE_RETRY_MS = 1000;
/** The legacy session header (lowercase, as Node reports request headers). */
export const MCP_SESSION_ID_HEADER = 'mcp-session-id';

/** The 2025-11-25 "server not initialized" / "no valid session" code a session-less legacy POST gets. */
export const LEGACY_NOT_INITIALIZED = LEGACY_TRANSPORT_ERROR;
/** The 2025-11-25 "session not found" code. */
export const LEGACY_SESSION_NOT_FOUND = -32001;

const SSE_HEADERS: Readonly<Record<string, string>> = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache, no-transform',
	'Connection': 'keep-alive',
	'X-Accel-Buffering': 'no',
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequest(message: unknown): message is IJsonRpcRequest {
	return isObject(message) && typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number');
}

function isNotification(message: unknown): message is { readonly method: string; readonly params?: unknown } {
	return isObject(message) && typeof message.method === 'string' && message.id === undefined;
}

function isResponse(message: unknown): boolean {
	return isObject(message) && message.method === undefined && (message.result !== undefined || isObject(message.error));
}

/** The request headers with lowercase names; multi-valued headers keep their first value. */
export function lowercaseRequestHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === 'string') {
			out[name.toLowerCase()] = value;
		} else if (Array.isArray(value) && value.length > 0) {
			out[name.toLowerCase()] = value[0];
		}
	}
	return out;
}

/**
 * Who sent a 2026-07-28 message, for `notifications/cancelled`. Stateless
 * clients have no session, and on HTTP/1.1 a cancellation arrives on another
 * connection than the request it cancels, so the socket cannot be the key
 * either. The rule: a cancellation reaches only the requests and listen
 * streams that came from the same remote address (and address family) with
 * the same `_meta` client info (name and version, or none on both). Two
 * processes on one machine that identify themselves identically count as
 * one client.
 */
export function modernClientKey(socket: { readonly remoteAddress?: string; readonly remoteFamily?: string } | undefined, clientInfo: MCP.Implementation | undefined): string {
	return JSON.stringify([socket?.remoteFamily ?? '', socket?.remoteAddress ?? '', clientInfo?.name ?? null, clientInfo?.version ?? null]);
}

/** The part of `http.ServerResponse` the writer uses (tests substitute a fake). */
export type McpGatewayHttpResponse = Pick<http.ServerResponse, 'writeHead' | 'write' | 'end' | 'on' | 'off' | 'flushHeaders' | 'headersSent' | 'destroyed' | 'writableEnded'>;

export interface IMcpGatewayResponseWriterOptions {
	/** Extra response headers (for instance `Mcp-Session-Id`). */
	readonly headers?: Readonly<Record<string, string>>;
	/**
	 * Legacy streams: every event goes through the session's replay log (and
	 * carries an event id), streams start with a priming event (2025-11-25) or
	 * a comment (older revisions), and can carry server→client requests.
	 */
	readonly legacy?: IMcpGatewayLegacyStreamOptions;
}

/** What a GET with `Last-Event-ID` resumed: a POST's response stream, a GET stream, nothing (unknown id) or nothing because another response carries it. */
export type McpGatewayResumeOutcome = McpGatewayStreamKind | 'unknown' | 'conflict';

const enum WriterState {
	/** Nothing written yet: the answer can still be a JSON body. */
	Pending,
	/** An SSE stream on this response. */
	Streaming,
	/** Legacy: the server closed the response for polling; the stream goes on in the log. */
	Detached,
	/** The response (and, for the stream's owner, the stream) is over. */
	Done,
}

/**
 * One HTTP response: a plain JSON body until something has to be streamed
 * (a notification, a server→client request, a listen stream), after which it
 * is an SSE stream that ends with the final JSON-RPC response. A request
 * that ends without a response (it was cancelled) gets an empty event
 * stream, never a 202.
 *
 * Legacy responses carry a stream of the session's event log: a POST's
 * response stream (which this writer owns: it is complete when the POST's
 * requests are answered) or a GET stream. {@link closeForPolling} ends the
 * HTTP response but not the stream (SEP-1699), and {@link resume} lets a GET
 * response continue a stream from a `Last-Event-ID`.
 *
 * {@link onDidClose} fires exactly once when the HTTP response is over,
 * whoever ended it; {@link onDidAbort} fires (first) when the client went
 * away before the server finished. The writer disposes itself then, unless
 * it was detached for polling (its request still writes to the stream).
 */
export class McpGatewayResponseWriter extends Disposable implements IMcpGatewayMessageSink, IMcpGatewaySessionStream, IMcpGatewaySseConnection {
	private readonly _onDidAbort = this._register(new Emitter<void>());
	readonly onDidAbort: Event<void> = this._onDidAbort.event;
	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;
	private readonly _keepAlive = this._register(new IntervalTimer());
	private _state = WriterState.Pending;
	private _sse = false;
	/** The HTTP response is over (its `close` event, or the writer's own disposal). */
	private _closed = false;
	private _disposing = false;
	private _streamId: string | undefined;
	private _kind: McpGatewayStreamKind | undefined;
	/** Whether this writer started its stream (and so completes a request stream). */
	private _owner = false;

	constructor(
		private readonly _res: McpGatewayHttpResponse,
		private readonly _logger: ILogger,
		private readonly _options: IMcpGatewayResponseWriterOptions = {},
	) {
		super();
		this._kind = _options.legacy?.kind;
		const onClose = () => this._handleClose();
		_res.on('close', onClose);
		this._register(toDisposable(() => _res.off('close', onClose)));
	}

	/** Whether the response can still carry messages to the client. */
	get isOpen(): boolean {
		return (this._state === WriterState.Pending || this._state === WriterState.Streaming) && !this._res.destroyed && !this._res.writableEnded;
	}

	/** Whether the response is (or was) an SSE stream. */
	get isStreaming(): boolean {
		return this._sse;
	}

	/** Legacy: the id of the stream this response carries, once it streams. */
	get streamId(): string | undefined {
		return this._streamId;
	}

	/** Switches the response to an SSE stream (a no-op when it already is one). */
	startStream(): void {
		if (this._state !== WriterState.Pending || !this.isOpen) {
			return;
		}
		this._openSse();
		const legacy = this._options.legacy;
		if (legacy) {
			this._owner = true;
			this._streamId = legacy.log.open(legacy.kind, this);
			if (legacy.priming()) {
				// SEP-1699 priming event: an id for `Last-Event-ID` and the reconnection delay.
				this._res.write(`id: ${legacy.log.cursor(this._streamId)}\nretry: ${LEGACY_SSE_RETRY_MS}\ndata: \n\n`);
			} else {
				// Clients before 2025-11-25 cannot take an event with empty data.
				this._res.write(': connected\n\n');
			}
		}
	}

	/**
	 * Legacy GET with `Last-Event-ID` (SEP-1699): this response continues the
	 * stream the id belongs to, starting with the stream's logged events after
	 * it. A complete request stream ends right after its replay. Events of a
	 * stream are never replayed on another, so an id this session did not hand
	 * out (or one of a forgotten stream) is `unknown`, and a stream that an
	 * open response carries is a `conflict`.
	 */
	resume(lastEventId: string): McpGatewayResumeOutcome {
		const legacy = this._options.legacy;
		if (!legacy || this._state !== WriterState.Pending || !this.isOpen) {
			return 'unknown';
		}
		const stream = legacy.log.find(lastEventId);
		if (!stream) {
			return 'unknown';
		}
		if (legacy.log.connectionOf(stream.id)?.isOpen) {
			return 'conflict';
		}
		this._streamId = stream.id;
		this._kind = stream.kind;
		this._openSse();
		const outcome = legacy.log.connect(stream.id, this, lastEventId);
		this._logger.debug(`[McpGateway] Resumed ${stream.kind} stream ${stream.id} after ${lastEventId}: ${outcome.replayed} event(s) replayed${outcome.truncated ? ', older events were dropped' : ''}`);
		return stream.kind;
	}

	notify(notification: IMcpGatewayNotification): void {
		if (this._state === WriterState.Pending) {
			if (!this.isOpen) {
				this._logger.debug(`[McpGateway] Dropping ${notification.method}: the response has ended`);
				return;
			}
			this.startStream();
		}
		if (this._state === WriterState.Done) {
			this._logger.debug(`[McpGateway] Dropping ${notification.method}: the response has ended`);
			return;
		}
		this._write(notificationMessage(notification));
	}

	sendRequest(request: IMcpGatewayNotification, token?: CancellationToken): Promise<unknown> {
		const legacy = this._options.legacy;
		if (!legacy) {
			return Promise.reject(new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'This connection cannot carry server requests'));
		}
		if (this._state === WriterState.Pending && this.isOpen) {
			this.startStream();
		}
		if (this._state !== WriterState.Streaming && this._state !== WriterState.Detached) {
			return Promise.reject(new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'The response has ended; the server request cannot be delivered'));
		}
		// The originating request's token (a child of this POST's) when known, else this POST's.
		const requestToken = token ?? legacy.token;
		if (requestToken?.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}
		const pending = legacy.broker.createRequest(requestToken);
		this._write(request.params === undefined ? { jsonrpc: '2.0', id: pending.id, method: request.method } : { jsonrpc: '2.0', id: pending.id, method: request.method, params: request.params });
		return pending.result;
	}

	/**
	 * SEP-1699 polling (legacy POST streams of 2025-11-25 sessions): ends the
	 * HTTP response with a `retry` hint but keeps the stream; the request's
	 * further messages, its response included, are logged for the client's
	 * `Last-Event-ID` reconnection. Starts the stream first when the response
	 * has not streamed yet, so the client has an event id to resume from.
	 */
	closeForPolling(): boolean {
		const legacy = this._options.legacy;
		if (!legacy || legacy.kind !== 'request' || !legacy.priming()) {
			return false;
		}
		if (this._state === WriterState.Pending && this.isOpen) {
			this.startStream();
		}
		if (this._state !== WriterState.Streaming || this._streamId === undefined || !this._owner) {
			return false;
		}
		this._state = WriterState.Detached;
		this._keepAlive.cancel();
		legacy.log.disconnect(this._streamId, this);
		if (!this._res.destroyed && !this._res.writableEnded) {
			this._res.write(`retry: ${LEGACY_SSE_RETRY_MS}\n\n`);
			this._res.end();
		}
		return true;
	}

	/** Writes the final response(s): the last SSE event(s) of a stream, or a JSON body. */
	respond(response: JsonRpcResponse | readonly JsonRpcResponse[]): void {
		this._finish(200, response);
	}

	/** Writes an error response with an HTTP status (the status is 200 once the response streams). */
	respondError(status: number, response: IMcpGatewayErrorResponse): void {
		this._finish(status, response);
	}

	/** Answers a notification (or a batch without requests): 202 with no body. */
	accept(): void {
		if (this._state === WriterState.Pending && this.isOpen) {
			this._state = WriterState.Done;
			this._res.writeHead(202, { ...this._options.headers });
			this._res.end();
			return;
		}
		this.end();
	}

	/**
	 * Ends the response without a final message (a cancelled request, a closed
	 * stream). A response that never streamed becomes an empty event stream.
	 */
	end(): void {
		if (this._state === WriterState.Done) {
			return;
		}
		this._state = WriterState.Done;
		this._keepAlive.cancel();
		const legacy = this._options.legacy;
		if (legacy && this._streamId !== undefined && this._owner && this._kind === 'request') {
			// Ends whichever response carries the stream now (this one, or one that resumed it).
			legacy.log.complete(this._streamId);
		}
		if (!this._res.destroyed && !this._res.writableEnded) {
			if (!this._res.headersSent) {
				this._res.writeHead(200, { ...SSE_HEADERS, ...this._options.headers });
			}
			this._res.end();
		}
	}

	/** {@link IMcpGatewaySseConnection}: writes one logged event on this response. */
	writeEvent(id: string, data: string): void {
		if (this._state === WriterState.Streaming && !this._res.destroyed && !this._res.writableEnded) {
			this._res.write(`id: ${id}\nevent: message\ndata: ${data}\n\n`);
		}
	}

	override dispose(): void {
		if (this._disposing) {
			return;
		}
		this._disposing = true;
		this.end();
		// Fires onDidClose when the response's own close event has not come yet.
		this._handleClose();
		super.dispose();
	}

	private _openSse(): void {
		this._state = WriterState.Streaming;
		this._sse = true;
		this._res.writeHead(200, { ...SSE_HEADERS, ...this._options.headers });
		this._res.flushHeaders();
		this._keepAlive.cancelAndSet(() => {
			if (this._state === WriterState.Streaming && this.isOpen) {
				this._res.write(': keepalive\n\n');
			}
		}, SSE_KEEPALIVE_MS);
	}

	private _write(message: object): void {
		const legacy = this._options.legacy;
		if (legacy) {
			if (this._streamId !== undefined) {
				// Logged for replay, and written on whichever response carries the stream now.
				legacy.log.write(this._streamId, message);
			}
			return;
		}
		if (this._state === WriterState.Streaming && !this._res.destroyed && !this._res.writableEnded) {
			this._res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
		}
	}

	private _handleClose(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this._keepAlive.cancel();
		const legacy = this._options.legacy;
		if (legacy && this._streamId !== undefined) {
			legacy.log.disconnect(this._streamId, this);
		}
		const aborted = this._state === WriterState.Pending || this._state === WriterState.Streaming;
		if (aborted) {
			// The client went away. The route cancels the request(s), so a request stream is complete too.
			this.end();
			this._onDidAbort.fire();
		}
		this._onDidClose.fire();
		if (this._state === WriterState.Done) {
			this.dispose();
		}
	}

	private _finish(status: number, body: object | readonly object[]): void {
		switch (this._state) {
			case WriterState.Pending:
				if (!this.isOpen) {
					this._state = WriterState.Done;
					this._logger.debug('[McpGateway] Dropping a response: the connection has gone');
					return;
				}
				this._state = WriterState.Done;
				this._keepAlive.cancel();
				this._res.writeHead(status, { 'Content-Type': 'application/json', ...this._options.headers });
				this._res.end(JSON.stringify(body));
				return;
			case WriterState.Streaming:
			case WriterState.Detached:
				for (const message of Array.isArray(body) ? body : [body]) {
					this._write(message);
				}
				this.end();
				return;
			case WriterState.Done:
				this._logger.debug('[McpGateway] Dropping a response: the response has ended');
				return;
		}
	}
}

interface IInflightRequest {
	readonly cts: CancellationTokenSource;
	/** The {@link modernClientKey} of the client that sent the request. */
	readonly owner: string;
}

/**
 * One MCP endpoint (`/gateway/{routeId}`) for one upstream server. The
 * 2026-07-28 wire is stateless: every POST is classified, validated and
 * dispatched on its own; `subscriptions/listen` keeps a stream open. The
 * 2025-11-25 wire keeps sessions (`Mcp-Session-Id`), GET streams that can be
 * resumed (`Last-Event-ID`) and bridges the dispatcher's input rounds as
 * server→client requests. The Host/Origin check is the service's, before a
 * route is looked up.
 */
export class McpGatewayRoute extends Disposable {
	private readonly _dispatcher: McpGatewayDispatcher;
	private readonly _listen: McpGatewayListenRegistry;
	private readonly _sessions = new Map<string, McpGatewaySession>();
	/** Modern requests being served, by JSON-RPC id (stateless clients may reuse ids, hence a set). */
	private readonly _inflight = new Map<JsonRpcId, Set<IInflightRequest>>();
	private readonly _responses = new Set<McpGatewayResponseWriter>();
	private readonly _onDidCloseResponse = this._register(new Emitter<void>());
	/** Fires after an HTTP response of this route is over (diagnostics and tests). */
	readonly onDidCloseResponse: Event<void> = this._onDidCloseResponse.event;

	constructor(
		public readonly routeId: string,
		private readonly _logger: ILogger,
		private readonly _invoker: IMcpGatewaySingleServerInvoker,
		sealedState: McpGatewaySealedState,
		public label: string = '',
		dispatcherOptions?: IMcpGatewayDispatcherOptions,
	) {
		super();
		this._dispatcher = this._register(new McpGatewayDispatcher(routeId, _logger, _invoker, sealedState, dispatcherOptions));
		this._listen = this._register(new McpGatewayListenRegistry(this._dispatcher, _invoker, _logger));
	}

	get dispatcher(): McpGatewayDispatcher {
		return this._dispatcher;
	}

	get sessionCount(): number {
		return this._sessions.size;
	}

	getSession(sessionId: string): McpGatewaySession | undefined {
		return this._sessions.get(sessionId);
	}

	get openListenStreams(): number {
		return this._listen.size;
	}

	/** Open responses (JSON in progress, SSE streams); for diagnostics and tests. */
	get openResponses(): number {
		return this._responses.size;
	}

	handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		this._logger.debug(`[McpGateway][route ${this.routeId}] ${req.method} request (sessions: ${this._sessions.size})`);
		switch (req.method) {
			case 'POST':
				this._handlePost(req, res).catch(error => {
					this._logger.error(`[McpGateway][route ${this.routeId}] POST failed`, error);
					if (!res.headersSent) {
						this._respondJson(res, 500, errorResponse(null, MCP.INTERNAL_ERROR, 'Internal server error'));
					} else if (!res.writableEnded) {
						res.end();
					}
				});
				return;
			case 'GET':
				this._handleGet(req, res);
				return;
			case 'DELETE':
				this._handleDelete(req, res);
				return;
			default:
				req.resume();
				this._respondJson(res, 405, errorResponse(null, MCP.INVALID_REQUEST, 'Method not allowed'), { Allow: 'POST, GET, DELETE' });
		}
	}

	/** Ends every open stream and session: listen streams get their graceful result first. */
	closeAllConnections(): void {
		this._listen.closeAll();
		for (const set of this._inflight.values()) {
			for (const request of set) {
				request.cts.cancel();
			}
		}
		for (const session of [...this._sessions.values()]) {
			session.dispose();
		}
		this._sessions.clear();
		for (const writer of [...this._responses]) {
			writer.dispose();
		}
		this._responses.clear();
	}

	override dispose(): void {
		this._logger.info(`[McpGateway][route ${this.routeId}] Disposing route (sessions: ${this._sessions.size}, listen streams: ${this._listen.size})`);
		this.closeAllConnections();
		super.dispose();
	}

	private _track(writer: McpGatewayResponseWriter): McpGatewayResponseWriter {
		this._responses.add(writer);
		Event.once(writer.onDidClose)(() => {
			this._responses.delete(writer);
			this._onDidCloseResponse.fire();
		});
		return writer;
	}

	private _respondJson(res: http.ServerResponse, status: number, body: object, extraHeaders: Record<string, string> = {}): void {
		this._logger.debug(`[McpGateway][route ${this.routeId}] HTTP ${status}`);
		res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
		res.end(JSON.stringify(body));
	}

	private _sessionIdOf(headers: Readonly<Record<string, string>>): string | undefined {
		const value = headers[MCP_SESSION_ID_HEADER];
		return value === undefined || value.trim().length === 0 ? undefined : value.trim();
	}

	/** The session a GET or DELETE names, or the error response it got (405 without a session, 404 for an unknown one, 400 for a bad protocol version header). */
	private _sessionForStreamRequest(headers: Readonly<Record<string, string>>, res: http.ServerResponse): McpGatewaySession | undefined {
		const sessionId = this._sessionIdOf(headers);
		if (sessionId === undefined) {
			// 2026-07-28 has no GET stream; a legacy client always names its session.
			this._respondJson(res, 405, errorResponse(null, MCP.INVALID_REQUEST, 'Method not allowed'), { Allow: 'POST' });
			return undefined;
		}
		const session = this._sessions.get(sessionId);
		if (!session) {
			this._respondJson(res, 404, errorResponse(null, LEGACY_SESSION_NOT_FOUND, 'Session not found'));
			return undefined;
		}
		const versionError = validateLegacyProtocolVersionHeader(headers);
		if (versionError) {
			this._logger.warn(`[McpGateway][route ${this.routeId}] Refused for session ${sessionId}: ${versionError.message}`);
			this._respondJson(res, 400, errorResponse(null, versionError.code, versionError.message));
			return undefined;
		}
		return session;
	}

	// ---- GET / DELETE (legacy sessions only) ---------------------------------

	private _handleGet(req: http.IncomingMessage, res: http.ServerResponse): void {
		req.resume();
		const headers = lowercaseRequestHeaders(req.headers);
		const session = this._sessionForStreamRequest(headers, res);
		if (!session) {
			return;
		}
		const writer = this._track(new McpGatewayResponseWriter(res, this._logger, {
			headers: { 'Mcp-Session-Id': session.id },
			legacy: session.streamOptions('standalone'),
		}));
		const lastEventId = headers['last-event-id']?.trim();
		if (lastEventId) {
			const outcome = writer.resume(lastEventId);
			switch (outcome) {
				case 'conflict':
					this._logger.warn(`[McpGateway][route ${this.routeId}] GET with Last-Event-ID ${lastEventId} refused: another response carries that stream`);
					writer.respondError(409, errorResponse(null, LEGACY_TRANSPORT_ERROR, 'Conflict: the stream already has an open connection'));
					return;
				case 'request':
					// A POST's response stream continues here; it is not one of the session's GET streams.
					this._logger.info(`[McpGateway][route ${this.routeId}] Session ${session.id} resumed a request stream after ${lastEventId}`);
					session.holdOpen(writer.onDidClose);
					return;
				case 'standalone':
					this._logger.info(`[McpGateway][route ${this.routeId}] Session ${session.id} resumed its GET stream after ${lastEventId}`);
					session.attachStream(writer);
					return;
				case 'unknown':
					this._logger.debug(`[McpGateway][route ${this.routeId}] GET with unknown Last-Event-ID ${lastEventId}: starting a fresh stream`);
					break;
			}
		}
		this._logger.info(`[McpGateway][route ${this.routeId}] SSE stream requested for session ${session.id}`);
		writer.startStream();
		session.attachStream(writer);
	}

	private _handleDelete(req: http.IncomingMessage, res: http.ServerResponse): void {
		req.resume();
		const headers = lowercaseRequestHeaders(req.headers);
		const session = this._sessionForStreamRequest(headers, res);
		if (!session) {
			return;
		}
		this._logger.info(`[McpGateway][route ${this.routeId}] Deleting session ${session.id}`);
		session.dispose();
		res.writeHead(204);
		res.end();
	}

	// ---- POST -----------------------------------------------------------------

	private async _handlePost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await this._readRequestBody(req);
		if (body === undefined) {
			this._respondJson(res, 413, errorResponse(null, MCP.INVALID_REQUEST, `Payload too large (limit ${MAX_BODY_BYTES} bytes)`));
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch (error) {
			this._logger.warn(`[McpGateway][route ${this.routeId}] JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
			this._respondJson(res, 400, errorResponse(null, MCP.PARSE_ERROR, 'Parse error'));
			return;
		}
		const headers = lowercaseRequestHeaders(req.headers);
		if (classifyEra(headers, message) === 'modern') {
			await this._handleModernPost(req, headers, message, res);
		} else {
			await this._handleLegacyPost(req, headers, message, res);
		}
	}

	private async _handleModernPost(req: http.IncomingMessage, headers: Readonly<Record<string, string>>, message: unknown, res: http.ServerResponse): Promise<void> {
		const writer = this._track(new McpGatewayResponseWriter(res, this._logger));
		// Closing the response stream is the 2026-07-28 cancellation signal, also while the request is validated.
		const cts = new CancellationTokenSource();
		const abortListener = writer.onDidAbort(() => cts.cancel());
		let keepOpen = false;
		try {
			if (Array.isArray(message)) {
				writer.respondError(400, errorResponse(null, MCP.INVALID_REQUEST, 'Batches are not accepted'));
				return;
			}
			if (isResponse(message)) {
				writer.respondError(400, errorResponse(null, MCP.INVALID_REQUEST, 'Clients do not send responses on this transport'));
				return;
			}
			if (isNotification(message)) {
				this._handleModernNotification(message, modernClientKey(req.socket, clientInfoFromMeta(message)));
				writer.accept();
				return;
			}
			if (!isRequest(message)) {
				writer.respondError(400, errorResponse(null, MCP.INVALID_REQUEST, 'Invalid Request'));
				return;
			}
			const prepared = await this._dispatcher.prepareModernRequest(headers, message);
			if (cts.token.isCancellationRequested || !writer.isOpen) {
				this._logger.debug(`[McpGateway][route ${this.routeId}] ${message.method} (id=${String(message.id)}): the client went away before the request ran`);
				return;
			}
			if (!prepared.ok) {
				const { error } = prepared;
				this._logger.debug(`[McpGateway][route ${this.routeId}] Rejected ${message.method}: ${error.code} ${error.message}`);
				writer.respondError(httpStatusForRpcError('modern', error.code), errorResponse(message.id, error.code, error.message, error.data));
				return;
			}
			const owner = modernClientKey(req.socket, prepared.meta.clientInfo);
			const params = isObject(message.params) ? message.params : {};
			if (message.method === 'subscriptions/listen') {
				keepOpen = this._openListenStream(message, params, writer, owner);
				return;
			}
			await this._dispatchModern(message, params, headers, prepared.meta, writer, cts, owner);
		} catch (error) {
			this._logger.error(`[McpGateway][route ${this.routeId}] Failed handling a request`, error);
			if (writer.isOpen && !writer.isStreaming) {
				writer.respondError(500, errorResponse(isRequest(message) ? message.id : null, MCP.INTERNAL_ERROR, 'Internal server error'));
			}
		} finally {
			abortListener.dispose();
			cts.dispose();
			if (!keepOpen) {
				writer.dispose();
			}
		}
	}

	private async _dispatchModern(request: IJsonRpcRequest, params: Record<string, unknown>, headers: Readonly<Record<string, string>>, meta: IModernRequestMeta, writer: McpGatewayResponseWriter, cts: CancellationTokenSource, owner: string): Promise<void> {
		const untrackInflight = this._trackInflight(request.id, { cts, owner });
		try {
			const context: IMcpGatewayDispatchContext = {
				era: 'modern',
				protocolVersion: meta.protocolVersion,
				requestId: request.id,
				clientCapabilities: meta.clientCapabilities,
				clientInfo: meta.clientInfo,
				logLevel: meta.logLevel,
				progressToken: meta.progressToken,
				headers,
				token: cts.token,
				notify: notification => {
					if (!cts.token.isCancellationRequested) {
						writer.notify(notification);
					}
				},
			};
			const result = await this._dispatcher.dispatch(context, request.method, params);
			if (cts.token.isCancellationRequested) {
				// No response for a cancelled request: the stream just ends.
				writer.end();
				return;
			}
			writer.respond({ jsonrpc: '2.0', id: request.id, result });
		} catch (error) {
			if (cts.token.isCancellationRequested) {
				writer.end();
				return;
			}
			const rpcError = error instanceof McpGatewayRpcError ? error : new McpGatewayRpcError(MCP.INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
			if (!(error instanceof McpGatewayRpcError)) {
				this._logger.error(`[McpGateway][route ${this.routeId}] ${request.method} failed`, error);
			}
			writer.respondError(httpStatusForRpcError('modern', rpcError.code), errorResponse(request.id, rpcError.code, rpcError.message, rpcError.data));
		} finally {
			untrackInflight.dispose();
		}
	}

	private _trackInflight(id: JsonRpcId, request: IInflightRequest): IDisposable {
		let set = this._inflight.get(id);
		if (!set) {
			set = new Set();
			this._inflight.set(id, set);
		}
		set.add(request);
		return toDisposable(() => {
			const current = this._inflight.get(id);
			current?.delete(request);
			if (current?.size === 0) {
				this._inflight.delete(id);
			}
		});
	}

	/** A 2026-07-28 `notifications/cancelled`: it reaches only the listen streams and requests of the client that sent it ({@link modernClientKey}). */
	private _handleModernNotification(notification: { readonly method: string; readonly params?: unknown }, owner: string): void {
		this._logger.debug(`[McpGateway][route ${this.routeId}] <-- notification: ${notification.method}`);
		if (notification.method !== 'notifications/cancelled') {
			return;
		}
		const requestId = isObject(notification.params) ? notification.params.requestId : undefined;
		if (typeof requestId !== 'string' && typeof requestId !== 'number') {
			return;
		}
		if (this._listen.close(requestId, owner)) {
			this._logger.info(`[McpGateway][route ${this.routeId}] Listen stream ${String(requestId)} cancelled by the client`);
			return;
		}
		let cancelled = 0;
		for (const request of this._inflight.get(requestId) ?? []) {
			if (request.owner === owner) {
				request.cts.cancel();
				cancelled++;
			}
		}
		if (cancelled > 0) {
			this._logger.info(`[McpGateway][route ${this.routeId}] Request ${String(requestId)} cancelled by the client`);
		} else {
			this._logger.debug(`[McpGateway][route ${this.routeId}] Ignored the cancellation of ${String(requestId)}: no request or listen stream of this client has that id`);
		}
	}

	/** Opens a `subscriptions/listen` stream; returns whether the response stays open. */
	private _openListenStream(request: IJsonRpcRequest, params: Record<string, unknown>, writer: McpGatewayResponseWriter, owner: string): boolean {
		const filterError = validateSubscriptionFilter(params.notifications);
		if (filterError) {
			writer.respondError(httpStatusForRpcError('modern', filterError.code), errorResponse(request.id, filterError.code, filterError.message));
			return false;
		}
		const stream: IMcpGatewayListenStream = {
			notify: notification => writer.notify(notification),
			complete: result => writer.respond({ jsonrpc: '2.0', id: request.id, result: applyModernEnvelope('subscriptions/listen', result, this._dispatcher.serverInfo) }),
		};
		let registration: IDisposable;
		try {
			registration = this._listen.register(request.id, params.notifications as MCP.SubscriptionFilter, stream, owner);
		} catch (error) {
			const rpcError = error instanceof McpGatewayRpcError ? error : new McpGatewayRpcError(MCP.INTERNAL_ERROR, String(error));
			writer.respondError(httpStatusForRpcError('modern', rpcError.code), errorResponse(request.id, rpcError.code, rpcError.message, rpcError.data));
			return false;
		}
		Event.once(writer.onDidClose)(() => {
			// The client went away (or the registry completed the stream, in which case this is a no-op).
			registration.dispose();
		});
		return true;
	}

	private async _handleLegacyPost(req: http.IncomingMessage, headers: Readonly<Record<string, string>>, message: unknown, res: http.ServerResponse): Promise<void> {
		const sessionId = this._sessionIdOf(headers);
		let session: McpGatewaySession | undefined;
		if (sessionId !== undefined) {
			session = this._sessions.get(sessionId);
			if (!session) {
				this._logger.warn(`[McpGateway][route ${this.routeId}] Session not found: ${sessionId}`);
				this._respondJson(res, 404, errorResponse(null, LEGACY_SESSION_NOT_FOUND, 'Session not found'));
				return;
			}
			const versionError = validateLegacyProtocolVersionHeader(headers);
			if (versionError) {
				this._logger.warn(`[McpGateway][route ${this.routeId}] Refused a POST of session ${sessionId}: ${versionError.message}`);
				this._respondJson(res, 400, errorResponse(null, versionError.code, versionError.message));
				return;
			}
		} else if (isInitializeMessage(message)) {
			session = this._createSession();
		} else if (isNotification(message)) {
			// A notification without a session has nothing to act on (a stateless client's cancellation, at most).
			this._handleModernNotification(message, modernClientKey(req.socket, clientInfoFromMeta(message)));
			res.writeHead(202);
			res.end();
			return;
		} else {
			this._respondJson(res, 400, errorResponse(null, LEGACY_NOT_INITIALIZED, 'Bad Request: Server not initialized'));
			return;
		}

		const cts = new CancellationTokenSource();
		const writer = this._track(new McpGatewayResponseWriter(res, this._logger, {
			headers: { 'Mcp-Session-Id': session.id },
			legacy: session.streamOptions('request', cts.token),
		}));
		const abortListener = writer.onDidAbort(() => cts.cancel());
		try {
			const responses = await session.handleIncoming(message as JsonRpcMessage | JsonRpcMessage[], writer, headers, cts.token);
			if (responses.length > 0) {
				writer.respond(Array.isArray(message) ? responses : responses[0]);
			} else if (containsRequest(message)) {
				// Every request was cancelled: no response is sent, and a POST with a request never gets 202.
				writer.end();
			} else {
				writer.accept();
			}
		} catch (error) {
			this._logger.error(`[McpGateway][route ${this.routeId}] Failed handling a session request`, error);
			writer.respondError(500, errorResponse(null, MCP.INTERNAL_ERROR, 'Internal server error'));
		} finally {
			abortListener.dispose();
			cts.dispose();
			writer.dispose();
		}
	}

	private _createSession(): McpGatewaySession {
		const sessionId = generateUuid();
		this._logger.info(`[McpGateway][route ${this.routeId}] Creating session ${sessionId}`);
		const session = new McpGatewaySession(sessionId, this._logger, this._dispatcher, this._invoker, () => {
			this._sessions.delete(sessionId);
		});
		this._sessions.set(sessionId, session);
		return session;
	}

	/** Reads the whole body; undefined when it exceeds {@link MAX_BODY_BYTES} (the rest is drained, not kept). */
	private _readRequestBody(req: http.IncomingMessage): Promise<string | undefined> {
		return new Promise<string | undefined>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let overflow = false;
			req.on('data', (chunk: Buffer | string) => {
				if (overflow) {
					return;
				}
				const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
				size += buffer.byteLength;
				if (size > MAX_BODY_BYTES) {
					overflow = true;
					chunks.length = 0;
					return;
				}
				chunks.push(buffer);
			});
			req.on('end', () => resolve(overflow ? undefined : Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}
}
