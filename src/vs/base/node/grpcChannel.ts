/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http2 from 'http2';
import type { Socket } from 'net';
import type { TLSSocket } from 'tls';
import { DeferredPromise } from '../common/async.js';
import { DEFAULT_MAX_GRPC_MESSAGE_BYTES, GrpcFramingError, LengthPrefixedMessageReader, encodeLengthPrefixedMessage } from '../common/grpc/lpm.js';
import { GrpcStatus, decodeGrpcMessage, grpcStatusForHttpStatus, grpcStatusName, parseGrpcStatus } from '../common/grpc/status.js';
import { formatGrpcTimeout } from '../common/grpc/timeout.js';
import { Disposable } from '../common/lifecycle.js';

/**
 * A hand-written gRPC client transport on top of Node's built-in `http2`
 * module, following the gRPC-over-HTTP/2 protocol
 * (https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md).
 *
 * The channel owns one HTTP/2 session that is created lazily on the first
 * call and recreated after it closes or receives GOAWAY.
 */

export interface IGrpcChannelOptions {
	/** `host:port` of the server. */
	readonly authority: string;
	/** Whether to use TLS. */
	readonly secure: boolean;
	/**
	 * Supplies the socket for the session, e.g. through a proxy CONNECT
	 * tunnel. When given, `http2.connect` uses the returned socket as-is.
	 */
	readonly createConnection?: (target: { host: string; port: number }) => Promise<Socket | TLSSocket>;
	readonly tls?: {
		ca?: string | readonly string[];
		rejectUnauthorized?: boolean;
		servername?: string;
	};
	/** Largest response message accepted; defaults to 4 MiB. */
	readonly maxReceiveMessageBytes?: number;
	/** Largest request message sent; defaults to 4 MiB. */
	readonly maxSendMessageBytes?: number;
	/** When set, a PING is sent every N ms; disabled by default. */
	readonly keepAliveTimeMs?: number;
	/** A PING that is not acknowledged within this time destroys the session; defaults to 20 s. */
	readonly keepAliveTimeoutMs?: number;
	readonly userAgent?: string;
	/** Defaults to `application/grpc+proto`. */
	readonly contentType?: string;
}

export interface IGrpcCallOptions {
	readonly signal?: AbortSignal;
	/** A timeout for the call, relative to its start; sent as `grpc-timeout`. */
	readonly deadlineMs?: number;
}

export interface IGrpcResponseHeaders {
	readonly httpStatus: number;
	/** Response headers with lowercase names; trailers-only responses surface here too. */
	readonly headers: Readonly<Record<string, string>>;
}

export interface IGrpcTrailers {
	readonly status: GrpcStatus;
	/** The decoded `grpc-message`. */
	readonly message?: string;
	readonly raw: Readonly<Record<string, string>>;
}

export interface IGrpcCall {
	/**
	 * Resolves with the response headers; rejects with a {@link GrpcCallError}
	 * when the call fails before any headers arrive.
	 */
	readonly responseHeaders: Promise<IGrpcResponseHeaders>;
	/**
	 * Yields decoded message payloads as they arrive. The iteration throws a
	 * {@link GrpcCallError} when the call ends with a non-OK status, and
	 * returning from it early cancels the call.
	 */
	readonly messages: AsyncIterable<Uint8Array>;
	/**
	 * Always resolves (never rejects): transport failures become a
	 * synthesized status (UNAVAILABLE for connection loss, CANCELLED for
	 * abort/cancel, DEADLINE_EXCEEDED for a local deadline, INTERNAL for
	 * framing or encoding problems) with a `message`.
	 */
	readonly trailers: Promise<IGrpcTrailers>;
	cancel(): void;
}

export class GrpcCallError extends Error {
	constructor(
		public readonly status: GrpcStatus,
		message: string,
		public readonly httpStatus?: number,
		public readonly trailers?: Readonly<Record<string, string>>,
	) {
		super(message);
		this.name = 'GrpcCallError';
	}
}

const DEFAULT_CONTENT_TYPE = 'application/grpc+proto';
const DEFAULT_USER_AGENT = 'vscode-grpc/0.1';
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 20_000;
const LOCAL_WINDOW_SIZE = 4 * 1024 * 1024;
const MAX_SESSION_MEMORY_MB = 64;
/** Attempts per call, counting transparent retries after REFUSED_STREAM. */
const MAX_ATTEMPTS = 2;

const enum Http2ErrorCode {
	NO_ERROR = 0,
	REFUSED_STREAM = 7,
	CANCEL = 8,
	ENHANCE_YOUR_CALM = 11,
}

/** Headers the transport owns; matching metadata entries are dropped. */
const reservedHeaders = new Set([
	'te',
	'content-type',
	'grpc-encoding',
	'grpc-accept-encoding',
	'grpc-timeout',
	'user-agent',
	'host',
	'connection',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'upgrade',
	'http2-settings',
]);

interface IResolvedChannelOptions {
	readonly authority: string;
	readonly scheme: 'http' | 'https';
	readonly maxReceiveMessageBytes: number;
	readonly maxSendMessageBytes: number;
	readonly keepAliveTimeMs: number | undefined;
	readonly keepAliveTimeoutMs: number;
	readonly userAgent: string;
	readonly contentType: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function flattenHeaders(headers: http2.IncomingHttpHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(':') || value === undefined) {
			continue;
		}
		result[name] = Array.isArray(value) ? value.join(', ') : String(value);
	}
	return result;
}

function parseAuthority(authority: string, secure: boolean): { host: string; port: number } {
	const url = new URL(`http://${authority}`);
	const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
	const port = url.port ? Number(url.port) : (secure ? 443 : 80);
	return { host, port };
}

/**
 * An unbounded queue bridging the push-based stream events to the
 * pull-based `messages` iterable. A single consumer is expected.
 */
class MessageQueue implements AsyncIterable<Uint8Array> {

	private readonly items: Uint8Array[] = [];
	private waiter: DeferredPromise<IteratorResult<Uint8Array>> | undefined;
	private done = false;
	private error: Error | undefined;
	private errorDelivered = false;

	constructor(private readonly onReturn: () => void) { }

	push(item: Uint8Array): void {
		if (this.done) {
			return;
		}
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			waiter.complete({ value: item, done: false });
		} else {
			this.items.push(item);
		}
	}

	end(): void {
		if (this.done) {
			return;
		}
		this.done = true;
		this.settleWaiter();
	}

	fail(error: Error): void {
		if (this.done) {
			return;
		}
		this.done = true;
		this.error = error;
		this.settleWaiter();
	}

	private settleWaiter(): void {
		const waiter = this.waiter;
		if (!waiter) {
			return;
		}
		this.waiter = undefined;
		if (this.error && !this.errorDelivered) {
			this.errorDelivered = true;
			waiter.error(this.error);
		} else {
			waiter.complete({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return {
			next: (): Promise<IteratorResult<Uint8Array>> => {
				const item = this.items.shift();
				if (item !== undefined) {
					return Promise.resolve({ value: item, done: false });
				}
				if (this.done) {
					if (this.error && !this.errorDelivered) {
						this.errorDelivered = true;
						return Promise.reject(this.error);
					}
					return Promise.resolve({ value: undefined, done: true });
				}
				this.waiter ??= new DeferredPromise<IteratorResult<Uint8Array>>();
				return this.waiter.p;
			},
			return: (): Promise<IteratorResult<Uint8Array>> => {
				if (!this.done) {
					this.onReturn();
				}
				this.done = true;
				this.items.length = 0;
				this.settleWaiter();
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}

/**
 * A single RPC: issues the request stream, decodes the response, and
 * reduces every way the stream can end to one trailers object.
 */
class GrpcCall implements IGrpcCall {

	private readonly headersDeferred = new DeferredPromise<IGrpcResponseHeaders>();
	private readonly trailersDeferred = new DeferredPromise<IGrpcTrailers>();
	private readonly queue: MessageQueue;
	private reader: LengthPrefixedMessageReader;

	private stream: http2.ClientHttp2Stream | undefined;
	private session: ChannelSession | undefined;
	private attempts = 0;
	private settled = false;
	private httpStatus: number | undefined;
	private recordedTrailers: Record<string, string> | undefined;
	private ignoreBody = false;
	private transportError: string | undefined;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly onAbort = () => this.fail(GrpcStatus.CANCELLED, 'call aborted');

	readonly responseHeaders: Promise<IGrpcResponseHeaders>;
	readonly messages: AsyncIterable<Uint8Array>;
	readonly trailers: Promise<IGrpcTrailers>;

	constructor(
		private readonly path: string,
		private readonly metadata: Readonly<Record<string, string>>,
		private readonly request: Uint8Array,
		private readonly options: IGrpcCallOptions,
		private readonly channelOptions: IResolvedChannelOptions,
		private readonly restart: (call: GrpcCall) => void,
	) {
		this.queue = new MessageQueue(() => this.cancel());
		this.reader = new LengthPrefixedMessageReader(channelOptions.maxReceiveMessageBytes);
		this.responseHeaders = this.headersDeferred.p;
		this.messages = this.queue;
		this.trailers = this.trailersDeferred.p;
		// The headers promise rejects when the call fails early; callers that
		// only await the trailers must not see an unhandled rejection.
		this.responseHeaders.catch(() => { });
	}

	get isSettled(): boolean {
		return this.settled;
	}

	cancel(): void {
		this.fail(GrpcStatus.CANCELLED, 'call cancelled');
	}

	/** Starts the deadline timer and the abort listener; the deadline covers connection setup. */
	arm(): void {
		const signal = this.options.signal;
		if (signal) {
			if (signal.aborted) {
				this.onAbort();
				return;
			}
			signal.addEventListener('abort', this.onAbort);
		}
		if (this.options.deadlineMs !== undefined) {
			const timeoutMs = Math.max(0, this.options.deadlineMs);
			this.deadlineTimer = setTimeout(() => this.fail(GrpcStatus.DEADLINE_EXCEEDED, `deadline of ${formatGrpcTimeout(timeoutMs)} exceeded`), timeoutMs);
		}
	}

	/**
	 * Opens the stream on the given session. Returns false when the session
	 * can no longer accept streams, in which case the caller retries on a
	 * fresh session.
	 */
	start(session: ChannelSession): boolean {
		let stream: http2.ClientHttp2Stream;
		try {
			stream = session.request(this.buildHeaders());
		} catch (error) {
			const code = errorCode(error);
			if (code === 'ERR_HTTP2_GOAWAY_SESSION' || code === 'ERR_HTTP2_INVALID_SESSION' || !session.isUsable) {
				return false;
			}
			this.fail(GrpcStatus.INTERNAL, `invalid request: ${errorMessage(error)}`);
			return true;
		}

		this.attempts++;
		this.stream = stream;
		this.session = session;
		session.track(this);

		stream.on('response', (headers) => this.onResponse(headers));
		stream.on('data', (chunk: Buffer) => this.onData(chunk));
		stream.on('trailers', (trailers) => this.onTrailers(trailers));
		stream.on('end', () => this.onEnd());
		stream.on('error', (error) => this.onError(error));
		stream.on('close', () => {
			// Defer so that a session-level failure, whose 'close' is emitted
			// right after the stream's, is classified as a transport error.
			const rstCode = stream.rstCode;
			setImmediate(() => this.finalize(rstCode, undefined, false));
		});

		const framed = encodeLengthPrefixedMessage(this.request);
		stream.end(Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength));
		return true;
	}

	/** Fails the call with a locally synthesized status. */
	fail(status: GrpcStatus, message: string): void {
		this.settle(status, message, {}, Http2ErrorCode.CANCEL);
	}

	/** The session closed underneath the stream. */
	onSessionClosed(error: Error | undefined): void {
		this.finalize(this.stream?.rstCode, error, true);
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(this.metadata)) {
			const lower = name.toLowerCase();
			if (lower.startsWith(':') || reservedHeaders.has(lower)) {
				continue;
			}
			headers[lower] = value;
		}
		headers[':method'] = 'POST';
		headers[':scheme'] = this.channelOptions.scheme;
		headers[':path'] = this.path;
		headers[':authority'] = this.channelOptions.authority;
		headers.te = 'trailers';
		headers['content-type'] = this.channelOptions.contentType;
		headers['grpc-encoding'] = 'identity';
		headers['grpc-accept-encoding'] = 'identity';
		headers['user-agent'] = this.channelOptions.userAgent;
		if (this.options.deadlineMs !== undefined) {
			headers['grpc-timeout'] = formatGrpcTimeout(Math.max(0, this.options.deadlineMs));
		}
		return headers;
	}

	private onResponse(incoming: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader): void {
		if (this.settled) {
			return;
		}
		const httpStatus = incoming[':status'] ?? 0;
		const headers = flattenHeaders(incoming);
		this.httpStatus = httpStatus;
		this.headersDeferred.complete({ httpStatus, headers });

		const rawStatus = headers['grpc-status'];
		if (httpStatus !== 200) {
			this.ignoreBody = true;
			if (parseGrpcStatus(rawStatus) !== undefined) {
				this.settleFromTrailers(headers);
			} else {
				this.settle(grpcStatusForHttpStatus(httpStatus), `HTTP status ${httpStatus}`, headers, Http2ErrorCode.CANCEL);
			}
			return;
		}

		const contentType = headers['content-type'];
		if (contentType !== undefined && !contentType.startsWith('application/grpc')) {
			this.ignoreBody = true;
			this.settle(GrpcStatus.UNKNOWN, `unexpected content-type '${contentType}'`, headers, Http2ErrorCode.CANCEL);
			return;
		}

		const encoding = headers['grpc-encoding'];
		if (encoding !== undefined && encoding !== 'identity') {
			this.ignoreBody = true;
			this.settle(GrpcStatus.INTERNAL, `unsupported encoding '${encoding}'`, headers, Http2ErrorCode.CANCEL);
			return;
		}

		if (rawStatus !== undefined) {
			// Trailers-only response: the headers carry the status and the stream ends.
			this.ignoreBody = true;
			this.settleFromTrailers(headers);
		}
	}

	private onData(chunk: Uint8Array): void {
		if (this.settled || this.ignoreBody) {
			return;
		}
		try {
			for (const message of this.reader.feed(chunk)) {
				this.queue.push(message);
			}
		} catch (error) {
			this.failFraming(error);
		}
	}

	private onTrailers(incoming: http2.IncomingHttpHeaders): void {
		if (this.settled) {
			return;
		}
		this.recordedTrailers = flattenHeaders(incoming);
	}

	private onEnd(): void {
		if (this.settled) {
			return;
		}
		if (!this.ignoreBody) {
			try {
				this.reader.end();
			} catch (error) {
				this.failFraming(error);
				return;
			}
		}
		if (this.recordedTrailers) {
			this.settleFromTrailers(this.recordedTrailers);
		}
		// Otherwise wait for 'close': the trailers event may still be pending.
	}

	private onError(error: unknown): void {
		if (this.settled) {
			return;
		}
		// Resets reported by nghttp2 are classified by rstCode on 'close';
		// anything else is a transport problem.
		if (errorCode(error) !== 'ERR_HTTP2_STREAM_ERROR') {
			this.transportError = errorMessage(error);
		}
	}

	/** Decides the outcome once the stream (or its session) is gone. */
	private finalize(rstCode: number | undefined, sessionError: Error | undefined, sessionClosed: boolean): void {
		if (this.settled) {
			return;
		}
		if (this.recordedTrailers) {
			this.settleFromTrailers(this.recordedTrailers);
			return;
		}
		if (rstCode === Http2ErrorCode.REFUSED_STREAM && this.httpStatus === undefined && this.attempts < MAX_ATTEMPTS) {
			// The server did not process the request (GOAWAY or REFUSED_STREAM):
			// it is safe to retry transparently on a fresh session.
			this.resetForRetry();
			this.restart(this);
			return;
		}
		if (sessionClosed || this.transportError !== undefined) {
			const reason = sessionError ? errorMessage(sessionError) : this.transportError;
			this.fail(GrpcStatus.UNAVAILABLE, reason ? `connection lost: ${reason}` : 'connection lost');
			return;
		}
		switch (rstCode) {
			case Http2ErrorCode.NO_ERROR:
				if (this.httpStatus !== undefined) {
					this.settle(GrpcStatus.UNKNOWN, 'missing status', {}, Http2ErrorCode.NO_ERROR);
				} else {
					this.fail(GrpcStatus.UNAVAILABLE, 'stream closed before a response was received');
				}
				break;
			case Http2ErrorCode.REFUSED_STREAM:
				this.fail(GrpcStatus.UNAVAILABLE, 'stream refused by the server');
				break;
			case Http2ErrorCode.ENHANCE_YOUR_CALM:
				this.fail(GrpcStatus.RESOURCE_EXHAUSTED, 'stream reset by the server (ENHANCE_YOUR_CALM)');
				break;
			default:
				this.fail(GrpcStatus.INTERNAL, `stream reset by the server (code ${rstCode ?? 'unknown'})`);
				break;
		}
	}

	private resetForRetry(): void {
		this.session?.untrack(this);
		this.session = undefined;
		this.stream = undefined;
		this.transportError = undefined;
		this.recordedTrailers = undefined;
		this.reader = new LengthPrefixedMessageReader(this.channelOptions.maxReceiveMessageBytes);
	}

	private failFraming(error: unknown): void {
		if (error instanceof GrpcFramingError) {
			switch (error.reason) {
				case 'message-too-large':
					this.fail(GrpcStatus.RESOURCE_EXHAUSTED, error.message);
					return;
				case 'compressed':
				case 'truncated':
					this.fail(GrpcStatus.INTERNAL, error.message);
					return;
			}
		}
		this.fail(GrpcStatus.INTERNAL, errorMessage(error));
	}

	private settleFromTrailers(raw: Record<string, string>): void {
		const rawStatus = raw['grpc-status'];
		const status = parseGrpcStatus(rawStatus);
		const rawMessage = raw['grpc-message'];
		if (status === undefined) {
			this.settle(GrpcStatus.UNKNOWN, rawStatus === undefined ? 'missing status' : `invalid grpc-status '${rawStatus}'`, raw, Http2ErrorCode.NO_ERROR);
		} else {
			this.settle(status, rawMessage === undefined ? undefined : decodeGrpcMessage(rawMessage), raw, Http2ErrorCode.NO_ERROR);
		}
	}

	private settle(status: GrpcStatus, message: string | undefined, raw: Record<string, string>, closeCode: Http2ErrorCode): void {
		if (this.settled) {
			return;
		}
		this.settled = true;

		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
		this.options.signal?.removeEventListener('abort', this.onAbort);
		this.session?.untrack(this);

		const trailers: IGrpcTrailers = message === undefined ? { status, raw } : { status, message, raw };
		this.trailersDeferred.complete(trailers);

		if (status === GrpcStatus.OK) {
			this.queue.end();
		} else {
			this.queue.fail(new GrpcCallError(status, message ?? grpcStatusName(status), this.httpStatus, raw));
		}
		if (!this.headersDeferred.isSettled) {
			this.headersDeferred.error(new GrpcCallError(status, message ?? grpcStatusName(status), this.httpStatus, raw));
		}

		// A stream that is still open (e.g. the request body is still being
		// sent after a complete early response) is reset.
		const stream = this.stream;
		if (stream && !stream.closed && !stream.destroyed) {
			stream.close(closeCode);
		}
	}
}

/**
 * Wraps one HTTP/2 session: tracks the calls on it, runs keepalive pings
 * and reports when it can no longer be used for new streams.
 */
class ChannelSession {

	private readonly calls = new Set<GrpcCall>();
	private connected = false;
	private goingAway = false;
	private closed = false;
	private lastError: Error | undefined;
	private keepAliveTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		readonly session: http2.ClientHttp2Session,
		private readonly options: IResolvedChannelOptions,
		private readonly onUnusable: () => void,
	) {
		session.on('connect', () => {
			this.connected = true;
			if (!session.destroyed) {
				session.setLocalWindowSize(LOCAL_WINDOW_SIZE);
			}
			this.startKeepAlive();
		});
		session.on('goaway', () => {
			this.goingAway = true;
			this.onUnusable();
			// Let the in-flight streams finish, then shut down.
			if (!session.destroyed) {
				session.close();
			}
		});
		session.on('error', (error: Error) => {
			this.lastError = error;
		});
		session.on('close', () => {
			this.closed = true;
			this.stopKeepAlive();
			this.onUnusable();
			for (const call of Array.from(this.calls)) {
				call.onSessionClosed(this.lastError);
			}
		});
	}

	get isUsable(): boolean {
		return !this.goingAway && !this.closed && !this.session.closed && !this.session.destroyed;
	}

	get isConnected(): boolean {
		return this.connected && this.isUsable;
	}

	request(headers: Record<string, string>): http2.ClientHttp2Stream {
		return this.session.request(headers);
	}

	track(call: GrpcCall): void {
		this.calls.add(call);
	}

	untrack(call: GrpcCall): void {
		this.calls.delete(call);
	}

	/** Cancels every call on the session and closes it. */
	close(): void {
		for (const call of Array.from(this.calls)) {
			call.fail(GrpcStatus.CANCELLED, 'channel closed');
		}
		this.stopKeepAlive();
		if (!this.session.destroyed) {
			this.session.close();
		}
	}

	private startKeepAlive(): void {
		const intervalMs = this.options.keepAliveTimeMs;
		if (intervalMs === undefined || this.keepAliveTimer !== undefined) {
			return;
		}
		this.keepAliveTimer = setInterval(() => this.ping(), intervalMs);
	}

	private stopKeepAlive(): void {
		if (this.keepAliveTimer !== undefined) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = undefined;
		}
	}

	private ping(): void {
		if (!this.isUsable) {
			this.stopKeepAlive();
			return;
		}
		const session = this.session;
		let acknowledged = false;
		const timeout = setTimeout(() => {
			if (!acknowledged && !session.destroyed) {
				session.destroy(new Error(`keepalive ping not acknowledged within ${this.options.keepAliveTimeoutMs}ms`));
			}
		}, this.options.keepAliveTimeoutMs);
		let sent = false;
		try {
			sent = session.ping(() => {
				acknowledged = true;
				clearTimeout(timeout);
			});
		} catch {
			sent = false;
		}
		if (!sent) {
			clearTimeout(timeout);
		}
	}
}

export class GrpcChannel extends Disposable {

	private readonly resolved: IResolvedChannelOptions;
	private current: ChannelSession | undefined;
	private connecting: Promise<ChannelSession> | undefined;
	private http2Module: typeof http2 | undefined;
	private disposed = false;

	constructor(private readonly options: IGrpcChannelOptions) {
		super();
		this.resolved = {
			authority: options.authority,
			scheme: options.secure ? 'https' : 'http',
			maxReceiveMessageBytes: options.maxReceiveMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES,
			maxSendMessageBytes: options.maxSendMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES,
			keepAliveTimeMs: options.keepAliveTimeMs,
			keepAliveTimeoutMs: options.keepAliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS,
			userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
			contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
		};
	}

	get isConnected(): boolean {
		return this.current?.isConnected ?? false;
	}

	call(path: string, metadata: Readonly<Record<string, string>>, request: Uint8Array, options: IGrpcCallOptions = {}): IGrpcCall {
		const call = new GrpcCall(path, metadata, request, options, this.resolved, retrying => this.startCall(retrying));
		if (this.disposed) {
			call.fail(GrpcStatus.UNAVAILABLE, 'channel is disposed');
			return call;
		}
		if (request.byteLength > this.resolved.maxSendMessageBytes) {
			call.fail(GrpcStatus.RESOURCE_EXHAUSTED, `request message too large: ${request.byteLength} bytes exceeds the limit of ${this.resolved.maxSendMessageBytes} bytes`);
			return call;
		}
		call.arm();
		if (!call.isSettled) {
			this.startCall(call);
		}
		return call;
	}

	/** Closes the current session; the next call reconnects. In-flight calls are cancelled. */
	close(): void {
		const session = this.current;
		this.current = undefined;
		session?.close();
	}

	override dispose(): void {
		this.disposed = true;
		this.close();
		super.dispose();
	}

	private async startCall(call: GrpcCall): Promise<void> {
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				const session = await this.acquireSession();
				if (call.isSettled) {
					return;
				}
				if (call.start(session)) {
					return;
				}
			}
			call.fail(GrpcStatus.UNAVAILABLE, 'connection is shutting down');
		} catch (error) {
			call.fail(GrpcStatus.UNAVAILABLE, `connection failed: ${errorMessage(error)}`);
		}
	}

	private acquireSession(): Promise<ChannelSession> {
		if (this.current?.isUsable) {
			return Promise.resolve(this.current);
		}
		if (!this.connecting) {
			const connecting = this.createSession();
			this.connecting = connecting;
			const clear = () => {
				if (this.connecting === connecting) {
					this.connecting = undefined;
				}
			};
			connecting.then(clear, clear);
		}
		return this.connecting;
	}

	private async createSession(): Promise<ChannelSession> {
		// Loaded lazily so that web bundles never pull in node's http2.
		const http2Module = this.http2Module ??= await import('http2');
		const { host, port } = parseAuthority(this.options.authority, this.options.secure);
		const socket = this.options.createConnection ? await this.options.createConnection({ host, port }) : undefined;
		if (this.disposed) {
			socket?.destroy();
			throw new Error('channel is disposed');
		}

		const tlsOptions = this.options.tls;
		const ca = tlsOptions?.ca;
		const session = http2Module.connect(`${this.resolved.scheme}://${this.options.authority}`, {
			settings: { enablePush: false },
			maxSessionMemory: MAX_SESSION_MEMORY_MB,
			ca: typeof ca === 'string' ? ca : ca ? Array.from(ca) : undefined,
			rejectUnauthorized: tlsOptions?.rejectUnauthorized,
			servername: tlsOptions?.servername,
			createConnection: socket ? () => socket : undefined,
		});

		const wrapper: ChannelSession = new ChannelSession(session, this.resolved, () => {
			if (this.current === wrapper) {
				this.current = undefined;
			}
		});
		this.current = wrapper;
		return wrapper;
	}
}
