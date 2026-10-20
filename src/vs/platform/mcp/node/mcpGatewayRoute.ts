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
import { applyModernEnvelope, classifyEra, errorResponse, httpStatusForRpcError, IMcpGatewayErrorResponse, McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';
import { IMcpGatewayDispatchContext, IMcpGatewayDispatcherOptions, IMcpGatewayNotification, McpGatewayDispatcher } from './mcpGatewayDispatcher.js';
import { IMcpGatewayListenStream, McpGatewayListenRegistry } from './mcpGatewayListenRegistry.js';
import { McpGatewaySealedState } from './mcpGatewaySealedState.js';
import { IMcpGatewayMessageSink, IMcpGatewayRequestBroker, IMcpGatewaySessionStream, isInitializeMessage, McpGatewaySession } from './mcpGatewaySession.js';

/** The largest POST body the gateway reads; anything bigger is answered with 413. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** How often an open SSE stream gets a comment line so intermediaries keep it alive. */
export const SSE_KEEPALIVE_MS = 15_000;
/** The reconnection delay legacy streams advertise in their priming event. */
export const LEGACY_SSE_RETRY_MS = 1000;
/** The legacy session header (lowercase, as Node reports request headers). */
export const MCP_SESSION_ID_HEADER = 'mcp-session-id';

/** The 2025-11-25 "server not initialized" / "no valid session" code a session-less legacy POST gets. */
export const LEGACY_NOT_INITIALIZED = -32000;
/** The 2025-11-25 "session not found" code. */
export const LEGACY_SESSION_NOT_FOUND = -32001;

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

/** The part of `http.ServerResponse` the writer uses (tests substitute a fake). */
export type McpGatewayHttpResponse = Pick<http.ServerResponse, 'writeHead' | 'write' | 'end' | 'on' | 'off' | 'flushHeaders' | 'headersSent' | 'destroyed' | 'writableEnded'>;

export interface IMcpGatewayResponseWriterLegacyOptions {
	readonly broker: IMcpGatewayRequestBroker;
	/** Allocates the `id` of the next SSE event (unique per session). */
	readonly nextEventId: () => string;
	/** Where messages go once this response has ended (the session's GET streams). */
	readonly fallback?: IMcpGatewayMessageSink;
	/** The cancellation token of the request this response answers. */
	readonly token?: CancellationToken;
}

export interface IMcpGatewayResponseWriterOptions {
	/** Extra response headers (for instance `Mcp-Session-Id`). */
	readonly headers?: Readonly<Record<string, string>>;
	/** Legacy streams carry event ids, start with a priming event and can carry server→client requests. */
	readonly legacy?: IMcpGatewayResponseWriterLegacyOptions;
}

/**
 * One HTTP response: a plain JSON body until something has to be streamed
 * (a notification, a server→client request, a listen stream), after which it
 * is an SSE stream that ends with the final JSON-RPC response.
 *
 * {@link onDidClose} fires exactly once before the writer disposes itself,
 * whoever ended the response; {@link onDidAbort} fires (first) when the
 * client went away before the server finished.
 */
export class McpGatewayResponseWriter extends Disposable implements IMcpGatewayMessageSink, IMcpGatewaySessionStream {
	private readonly _onDidAbort = this._register(new Emitter<void>());
	readonly onDidAbort: Event<void> = this._onDidAbort.event;
	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;
	private readonly _keepAlive = this._register(new IntervalTimer());
	private _streaming = false;
	/** The server has written (or given up on) the end of the response. */
	private _finished = false;
	private _closed = false;

	constructor(
		private readonly _res: McpGatewayHttpResponse,
		private readonly _logger: ILogger,
		private readonly _options: IMcpGatewayResponseWriterOptions = {},
	) {
		super();
		const onClose = () => this._handleClose();
		_res.on('close', onClose);
		this._register(toDisposable(() => _res.off('close', onClose)));
	}

	get isOpen(): boolean {
		return !this._finished && !this._res.destroyed && !this._res.writableEnded;
	}

	get isStreaming(): boolean {
		return this._streaming;
	}

	/** Switches the response to an SSE stream (a no-op when it already is one). */
	startStream(): void {
		if (this._streaming || !this.isOpen) {
			return;
		}
		this._streaming = true;
		this._res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no',
			...this._options.headers,
		});
		this._res.flushHeaders();
		if (this._options.legacy) {
			// SEP-1699 priming event: an id for `Last-Event-ID` and the reconnection delay.
			this._res.write(`id: ${this._options.legacy.nextEventId()}\nretry: ${LEGACY_SSE_RETRY_MS}\ndata: \n\n`);
		}
		this._keepAlive.cancelAndSet(() => {
			if (this.isOpen) {
				this._res.write(': keepalive\n\n');
			}
		}, SSE_KEEPALIVE_MS);
	}

	notify(notification: IMcpGatewayNotification): void {
		if (!this.isOpen) {
			if (this._options.legacy?.fallback) {
				this._options.legacy.fallback.notify(notification);
			} else {
				this._logger.debug(`[McpGateway] Dropping ${notification.method}: the response has ended`);
			}
			return;
		}
		this.startStream();
		this._writeEvent(notification.params === undefined ? { jsonrpc: '2.0', method: notification.method } : { jsonrpc: '2.0', method: notification.method, params: notification.params });
	}

	sendRequest(request: IMcpGatewayNotification, token?: CancellationToken): Promise<unknown> {
		const legacy = this._options.legacy;
		if (!legacy) {
			return Promise.reject(new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'This connection cannot carry server requests'));
		}
		if (!this.isOpen) {
			if (legacy.fallback) {
				return legacy.fallback.sendRequest(request, token);
			}
			return Promise.reject(new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'The response has ended; the server request cannot be delivered'));
		}
		// The originating request's token (a child of this POST's) when known, else this POST's.
		const requestToken = token ?? legacy.token;
		if (requestToken?.isCancellationRequested) {
			return Promise.reject(new CancellationError());
		}
		this.startStream();
		const pending = legacy.broker.createRequest(requestToken);
		this._writeEvent(request.params === undefined ? { jsonrpc: '2.0', id: pending.id, method: request.method } : { jsonrpc: '2.0', id: pending.id, method: request.method, params: request.params });
		return pending.result;
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
		if (!this.isOpen) {
			return;
		}
		if (this._streaming) {
			this.end();
			return;
		}
		this._finished = true;
		this._res.writeHead(202, { ...this._options.headers });
		this._res.end();
	}

	/** Ends the response without a final message (a cancelled request, a closed stream). */
	end(): void {
		if (!this.isOpen) {
			this._finished = true;
			return;
		}
		this._finished = true;
		this._keepAlive.cancel();
		if (!this._res.headersSent) {
			this._res.writeHead(202, { ...this._options.headers });
		}
		this._res.end();
	}

	override dispose(): void {
		if (!this._closed) {
			this.end();
			// Fires onDidClose and disposes again.
			this._handleClose();
			return;
		}
		super.dispose();
	}

	private _handleClose(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		this._keepAlive.cancel();
		const aborted = !this._finished;
		this._finished = true;
		if (aborted) {
			this._onDidAbort.fire();
		}
		this._onDidClose.fire();
		this.dispose();
	}

	private _finish(status: number, body: object | readonly object[]): void {
		if (!this.isOpen) {
			this._logger.debug('[McpGateway] Dropping a response: the connection has gone');
			return;
		}
		if (this._streaming) {
			for (const message of Array.isArray(body) ? body : [body]) {
				this._writeEvent(message);
			}
			this.end();
			return;
		}
		this._finished = true;
		this._keepAlive.cancel();
		this._res.writeHead(status, { 'Content-Type': 'application/json', ...this._options.headers });
		this._res.end(JSON.stringify(body));
	}

	private _writeEvent(message: object): void {
		const id = this._options.legacy ? `id: ${this._options.legacy.nextEventId()}\n` : '';
		this._res.write(`${id}event: message\ndata: ${JSON.stringify(message)}\n\n`);
	}
}

/**
 * One MCP endpoint (`/gateway/{routeId}`) for one upstream server. The
 * 2026-07-28 wire is stateless: every POST is classified, validated and
 * dispatched on its own; `subscriptions/listen` keeps a stream open. The
 * 2025-11-25 wire keeps sessions (`Mcp-Session-Id`), a GET stream per session
 * and bridges the dispatcher's input rounds as server→client requests. The
 * Host/Origin check is the service's, before a route is looked up.
 */
export class McpGatewayRoute extends Disposable {
	private readonly _dispatcher: McpGatewayDispatcher;
	private readonly _listen: McpGatewayListenRegistry;
	private readonly _sessions = new Map<string, McpGatewaySession>();
	/** Modern requests being served, by JSON-RPC id (stateless clients may reuse ids, hence a set). */
	private readonly _inflight = new Map<JsonRpcId, Set<CancellationTokenSource>>();
	private readonly _responses = new Set<McpGatewayResponseWriter>();
	private readonly _eventIds = new WeakMap<McpGatewaySession, number>();
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
			for (const cts of set) {
				cts.cancel();
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

	private _nextEventId(session: McpGatewaySession): string {
		const next = (this._eventIds.get(session) ?? 0) + 1;
		this._eventIds.set(session, next);
		return String(next);
	}

	// ---- GET / DELETE (legacy sessions only) ---------------------------------

	private _handleGet(req: http.IncomingMessage, res: http.ServerResponse): void {
		req.resume();
		const headers = lowercaseRequestHeaders(req.headers);
		const sessionId = this._sessionIdOf(headers);
		if (sessionId === undefined) {
			// 2026-07-28 has no GET stream; a legacy client always names its session.
			this._respondJson(res, 405, errorResponse(null, MCP.INVALID_REQUEST, 'Method not allowed'), { Allow: 'POST' });
			return;
		}
		const session = this._sessions.get(sessionId);
		if (!session) {
			this._respondJson(res, 404, errorResponse(null, LEGACY_SESSION_NOT_FOUND, 'Session not found'));
			return;
		}
		if (headers['last-event-id'] !== undefined) {
			this._logger.debug(`[McpGateway][route ${this.routeId}] GET with Last-Event-ID ${headers['last-event-id']}: streams are not replayed, starting a fresh stream`);
		}
		this._logger.info(`[McpGateway][route ${this.routeId}] SSE stream requested for session ${sessionId}`);
		const writer = this._track(new McpGatewayResponseWriter(res, this._logger, {
			headers: { 'Mcp-Session-Id': session.id },
			legacy: { broker: session, nextEventId: () => this._nextEventId(session) },
		}));
		writer.startStream();
		session.attachStream(writer);
	}

	private _handleDelete(req: http.IncomingMessage, res: http.ServerResponse): void {
		req.resume();
		const headers = lowercaseRequestHeaders(req.headers);
		const sessionId = this._sessionIdOf(headers);
		if (sessionId === undefined) {
			this._respondJson(res, 405, errorResponse(null, MCP.INVALID_REQUEST, 'Method not allowed'), { Allow: 'POST' });
			return;
		}
		const session = this._sessions.get(sessionId);
		if (!session) {
			this._respondJson(res, 404, errorResponse(null, LEGACY_SESSION_NOT_FOUND, 'Session not found'));
			return;
		}
		this._logger.info(`[McpGateway][route ${this.routeId}] Deleting session ${sessionId}`);
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
			await this._handleModernPost(headers, message, res);
		} else {
			await this._handleLegacyPost(headers, message, res);
		}
	}

	private async _handleModernPost(headers: Readonly<Record<string, string>>, message: unknown, res: http.ServerResponse): Promise<void> {
		const writer = this._track(new McpGatewayResponseWriter(res, this._logger));
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
				this._handleModernNotification(message);
				writer.accept();
				return;
			}
			if (!isRequest(message)) {
				writer.respondError(400, errorResponse(null, MCP.INVALID_REQUEST, 'Invalid Request'));
				return;
			}
			const prepared = await this._dispatcher.prepareModernRequest(headers, message);
			if (!prepared.ok) {
				const { error } = prepared;
				this._logger.debug(`[McpGateway][route ${this.routeId}] Rejected ${message.method}: ${error.code} ${error.message}`);
				writer.respondError(httpStatusForRpcError('modern', error.code), errorResponse(message.id, error.code, error.message, error.data));
				return;
			}
			const params = isObject(message.params) ? message.params : {};
			if (message.method === 'subscriptions/listen') {
				keepOpen = this._openListenStream(message, params, writer);
				return;
			}
			await this._dispatchModern(message, params, headers, prepared.meta, writer);
		} finally {
			if (!keepOpen) {
				writer.dispose();
			}
		}
	}

	private async _dispatchModern(request: IJsonRpcRequest, params: Record<string, unknown>, headers: Readonly<Record<string, string>>, meta: { readonly protocolVersion: string; readonly clientCapabilities: MCP.ClientCapabilities; readonly clientInfo?: MCP.Implementation; readonly logLevel?: MCP.LoggingLevel; readonly progressToken?: MCP.ProgressToken }, writer: McpGatewayResponseWriter): Promise<void> {
		const cts = new CancellationTokenSource();
		const untrackInflight = this._trackInflight(request.id, cts);
		// Closing the response stream is the 2026-07-28 cancellation signal.
		const abortListener = writer.onDidAbort(() => cts.cancel());
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
			abortListener.dispose();
			untrackInflight.dispose();
			cts.dispose();
		}
	}

	private _trackInflight(id: JsonRpcId, cts: CancellationTokenSource): IDisposable {
		let set = this._inflight.get(id);
		if (!set) {
			set = new Set();
			this._inflight.set(id, set);
		}
		set.add(cts);
		return toDisposable(() => {
			const current = this._inflight.get(id);
			current?.delete(cts);
			if (current?.size === 0) {
				this._inflight.delete(id);
			}
		});
	}

	private _handleModernNotification(notification: { readonly method: string; readonly params?: unknown }): void {
		this._logger.debug(`[McpGateway][route ${this.routeId}] <-- notification: ${notification.method}`);
		if (notification.method !== 'notifications/cancelled') {
			return;
		}
		const requestId = isObject(notification.params) ? notification.params.requestId : undefined;
		if (typeof requestId !== 'string' && typeof requestId !== 'number') {
			return;
		}
		if (this._listen.close(requestId)) {
			this._logger.info(`[McpGateway][route ${this.routeId}] Listen stream ${String(requestId)} cancelled by the client`);
			return;
		}
		const inflight = this._inflight.get(requestId);
		if (inflight) {
			this._logger.info(`[McpGateway][route ${this.routeId}] Request ${String(requestId)} cancelled by the client`);
			for (const cts of inflight) {
				cts.cancel();
			}
		}
	}

	/** Opens a `subscriptions/listen` stream; returns whether the response stays open. */
	private _openListenStream(request: IJsonRpcRequest, params: Record<string, unknown>, writer: McpGatewayResponseWriter): boolean {
		if (!isObject(params.notifications)) {
			writer.respondError(400, errorResponse(request.id, MCP.INVALID_PARAMS, 'subscriptions/listen needs a notifications filter'));
			return false;
		}
		const stream: IMcpGatewayListenStream = {
			notify: notification => writer.notify(notification),
			complete: result => writer.respond({ jsonrpc: '2.0', id: request.id, result: applyModernEnvelope('subscriptions/listen', result, this._dispatcher.serverInfo) }),
		};
		let registration: IDisposable;
		try {
			registration = this._listen.register(request.id, params.notifications as MCP.SubscriptionFilter, stream);
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

	private async _handleLegacyPost(headers: Readonly<Record<string, string>>, message: unknown, res: http.ServerResponse): Promise<void> {
		const sessionId = this._sessionIdOf(headers);
		let session: McpGatewaySession | undefined;
		if (sessionId !== undefined) {
			session = this._sessions.get(sessionId);
			if (!session) {
				this._logger.warn(`[McpGateway][route ${this.routeId}] Session not found: ${sessionId}`);
				this._respondJson(res, 404, errorResponse(null, LEGACY_SESSION_NOT_FOUND, 'Session not found'));
				return;
			}
		} else if (isInitializeMessage(message)) {
			session = this._createSession();
		} else if (isNotification(message)) {
			// A notification without a session has nothing to act on (a stateless client's cancellation, at most).
			this._handleModernNotification(message);
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
			legacy: { broker: session, nextEventId: () => this._nextEventId(session), fallback: session.streamSink, token: cts.token },
		}));
		const abortListener = writer.onDidAbort(() => cts.cancel());
		try {
			const responses = await session.handleIncoming(message as JsonRpcMessage | JsonRpcMessage[], writer, headers, cts.token);
			if (responses.length === 0) {
				writer.accept();
			} else {
				writer.respond(Array.isArray(message) ? responses : responses[0]);
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
