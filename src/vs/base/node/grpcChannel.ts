/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http2 from 'http2';
import type { Socket } from 'net';
import type { TLSSocket } from 'tls';
import { domainToASCII } from 'url';
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
	/** `host:port` of the server; an internationalized host connects and is sent by its ASCII form. */
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
	/**
	 * When set to a positive number, a PING is sent every N ms while at least
	 * one call is open on the session (also while a session that received
	 * GOAWAY drains its calls); disabled by default. Like grpc-js
	 * (`keepalive_permit_without_calls` off), an idle session sends none:
	 * grpc-core and grpc-go servers count a PING without an open stream as a
	 * strike. gRPC servers answer pings more frequent than they allow (5
	 * minutes by default for grpc-core and grpc-js) with GOAWAY
	 * `too_many_pings` (ENHANCE_YOUR_CALM), so callers should not go below
	 * that; after one, the channel doubles its intervals for the next
	 * session, as grpc-js does. An interval longer than a timer can wait
	 * (2^31-1 ms) is cut to it.
	 */
	readonly keepAliveTimeMs?: number;
	/**
	 * The PING interval while a call started with
	 * {@link IGrpcCallOptions.longLived} is open on the session, when
	 * {@link keepAliveTimeMs} sends none: a stream that carries no traffic for
	 * minutes is otherwise cut by the idle timeout of a NAT or load balancer.
	 * The same bounds as {@link keepAliveTimeMs} apply.
	 */
	readonly longLivedKeepAliveTimeMs?: number;
	/** A PING that is not acknowledged within this time destroys the session; defaults to 20 s. */
	readonly keepAliveTimeoutMs?: number;
	readonly userAgent?: string;
	/** Defaults to `application/grpc+proto`. */
	readonly contentType?: string;
}

export interface IGrpcCallOptions {
	readonly signal?: AbortSignal;
	/**
	 * A timeout for the call, relative to its start; sent as `grpc-timeout`.
	 * The local timer that enforces it is re-armed in steps when the deadline
	 * is further away than a timer can wait (2^31-1 ms).
	 */
	readonly deadlineMs?: number;
	/**
	 * The call may stay open without traffic for a long time (a listen
	 * stream): while it is open, the session sends PINGs every
	 * {@link IGrpcChannelOptions.longLivedKeepAliveTimeMs}.
	 */
	readonly longLived?: boolean;
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
	/**
	 * The HTTP status of the response, when one arrived. A gRPC server always
	 * answers 200; any other status (with the gRPC status mapped from it when
	 * the response carries no `grpc-status`) means the peer is not a gRPC
	 * server or an intermediary rejected the call.
	 */
	readonly httpStatus?: number;
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
const DEFAULT_USER_AGENT = 'grpc-node-vscode/0.1';
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 20_000;
/** The flow-control window of the session (all streams together). */
const LOCAL_WINDOW_SIZE = 4 * 1024 * 1024;
/** SETTINGS_INITIAL_WINDOW_SIZE: the flow-control window of each stream. */
const STREAM_WINDOW_SIZE = 1024 * 1024;
/** SETTINGS_MAX_HEADER_LIST_SIZE: the largest header list (and trailer list) the channel accepts. */
const MAX_HEADER_LIST_SIZE = 8 * 1024;
const MAX_SESSION_MEMORY_MB = 64;
/** Attempts per call, counting transparent retries after REFUSED_STREAM. */
const MAX_ATTEMPTS = 2;
/**
 * The longest delay a timer can wait (2^31-1 ms, about 24.8 days); Node
 * fires a longer one after 1 ms.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** The END_STREAM flag of a HEADERS frame (`http2.constants.NGHTTP2_FLAG_END_STREAM`). */
const NGHTTP2_FLAG_END_STREAM = 0x1;

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
	/** A usable PING interval ({@link timerInterval}), or `undefined`. */
	readonly keepAliveTimeMs: number | undefined;
	readonly longLivedKeepAliveTimeMs: number | undefined;
	readonly keepAliveTimeoutMs: number;
	readonly userAgent: string;
	readonly contentType: string;
}

/**
 * A configured interval as a timer can wait it: `undefined` for unset, zero,
 * negative or non-finite values (which would otherwise fire on every timer
 * tick), cut to {@link MAX_TIMER_DELAY_MS}.
 */
function timerInterval(ms: number | undefined): number | undefined {
	return ms === undefined || !Number.isFinite(ms) || ms <= 0 ? undefined : Math.min(ms, MAX_TIMER_DELAY_MS);
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

interface IGrpcAuthorityParts {
	/** The host without brackets; a domain name in its ASCII form. */
	readonly host: string;
	readonly isIPv6: boolean;
	/** The port as written; `undefined` when the authority names none. */
	readonly port: number | undefined;
}

/**
 * Splits `host:port` (or `[v6]:port`, or a host without a port), without user
 * info. A domain name is converted to its ASCII form (the A-labels of an
 * internationalized name, lowercased, as the URL parser does), so that DNS,
 * the TLS server name, the certificate check, proxy CONNECT and `:authority`
 * all see the name the server's certificate and DNS records carry.
 */
function splitGrpcAuthority(authority: string): IGrpcAuthorityParts {
	const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
	let host: string;
	let portText: string | undefined;
	const isIPv6 = hostPort.startsWith('[');
	if (isIPv6) {
		const end = hostPort.indexOf(']');
		if (end < 0) {
			throw new Error(`invalid authority '${authority}'`);
		}
		host = hostPort.slice(1, end);
		const rest = hostPort.slice(end + 1);
		if (rest !== '' && !rest.startsWith(':')) {
			throw new Error(`invalid authority '${authority}'`);
		}
		portText = rest === '' ? undefined : rest.slice(1);
	} else {
		const colon = hostPort.lastIndexOf(':');
		if (colon >= 0 && hostPort.indexOf(':') !== colon) {
			throw new Error(`invalid authority '${authority}': an IPv6 address must be in brackets`);
		}
		host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
		portText = colon >= 0 ? hostPort.slice(colon + 1) : undefined;
		if (host !== '') {
			const ascii = domainToASCII(host);
			if (ascii === '') {
				throw new Error(`invalid authority '${authority}': bad host '${host}'`);
			}
			host = ascii;
		}
	}
	if (host === '') {
		throw new Error(`invalid authority '${authority}': no host`);
	}
	if (portText === undefined || portText === '') {
		return { host, isIPv6, port: undefined };
	}
	if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) {
		throw new Error(`invalid authority '${authority}': bad port '${portText}'`);
	}
	return { host, isIPv6, port: Number(portText) };
}

/**
 * Splits `host:port` (or `[v6]:port`, or a host without a port) into the
 * connection target, with an internationalized host name in its ASCII
 * (punycode) form. A missing port is the default of the scheme: 443 for
 * `grpcs`, 80 for `grpc`. The authority is not parsed as an `http:` URL,
 * which would drop an explicit `:80` and connect `grpcs://host:80` to 443.
 */
export function parseGrpcAuthority(authority: string, secure: boolean): { host: string; port: number } {
	const { host, port } = splitGrpcAuthority(authority);
	return { host, port: port ?? (secure ? 443 : 80) };
}

/** The `:authority` of the calls to `authority`: the ASCII host (an IPv6 address in brackets) and the port as written, without user info. */
export function formatGrpcAuthority(authority: string): string {
	const { host, isIPv6, port } = splitGrpcAuthority(authority);
	const hostText = isIPv6 ? `[${host}]` : host;
	return port === undefined ? hostText : `${hostText}:${port}`;
}

/** {@link formatGrpcAuthority}, or `authority` itself when it is invalid (the connection reports that). */
function requestAuthority(authority: string): string {
	try {
		return formatGrpcAuthority(authority);
	} catch {
		return authority;
	}
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
	/** The server ended its side of the stream (END_STREAM): nothing more arrives. */
	private remoteEnded = false;
	private ignoreBody = false;
	private transportError: string | undefined;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	/** When the deadline expires (`Date.now()` time), if the call has one. */
	private deadlineAt: number | undefined;
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

	get isLongLived(): boolean {
		return this.options.longLived === true;
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
			this.deadlineAt = Date.now() + timeoutMs;
			this.armDeadlineTimer(timeoutMs);
		}
	}

	/** A deadline further away than a timer can wait is reached in steps of at most {@link MAX_TIMER_DELAY_MS}. */
	private armDeadlineTimer(remainingMs: number): void {
		this.deadlineTimer = setTimeout(() => {
			this.deadlineTimer = undefined;
			const left = this.deadlineAt === undefined ? 0 : this.deadlineAt - Date.now();
			if (remainingMs > MAX_TIMER_DELAY_MS && left > 0) {
				this.armDeadlineTimer(left);
			} else {
				this.failDeadline();
			}
		}, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
	}

	private failDeadline(): void {
		this.fail(GrpcStatus.DEADLINE_EXCEEDED, `deadline of ${formatGrpcTimeout(Math.max(0, this.options.deadlineMs ?? 0))} exceeded`);
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

		// Events of a stream the call has given up for a transparent retry are ignored.
		const isCurrent = () => this.stream === stream;
		stream.on('response', (headers, flags) => isCurrent() && this.onResponse(headers, flags));
		stream.on('data', (chunk: Buffer) => isCurrent() && this.onData(chunk));
		stream.on('trailers', (trailers) => isCurrent() && this.onTrailers(trailers));
		stream.on('end', () => isCurrent() && this.onEnd());
		stream.on('error', (error) => isCurrent() && this.onError(error));
		stream.on('close', () => {
			// Defer so that a session-level failure, whose 'close' is emitted
			// right after the stream's, is classified as a transport error. If
			// the session's 'close' came first and retried the call on a new
			// stream, this outcome is stale: it must neither retry the call a
			// second time nor fail the retried call.
			const rstCode = stream.rstCode;
			setImmediate(() => isCurrent() && this.finalize(rstCode, undefined, false));
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
		if (this.stream) {
			this.finalize(this.stream.rstCode, error, true);
		}
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
			// A transparent retry carries what is left of the deadline, not all of it again.
			const timeoutMs = this.attempts === 0 || this.deadlineAt === undefined ? this.options.deadlineMs : this.deadlineAt - Date.now();
			headers['grpc-timeout'] = formatGrpcTimeout(Math.max(0, timeoutMs));
		}
		return headers;
	}

	private onResponse(incoming: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader, flags: number): void {
		if (this.settled) {
			return;
		}
		if ((flags & NGHTTP2_FLAG_END_STREAM) !== 0) {
			// A headers-only response (trailers-only, or an HTTP status without a body).
			this.remoteEnded = true;
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
		this.remoteEnded = true;
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
			// The server did not process the request (REFUSED_STREAM, or a stream
			// above the last stream id of a GOAWAY): it is safe to retry it
			// transparently, once, on a session that accepts streams.
			if (this.deadlineAt !== undefined && Date.now() >= this.deadlineAt) {
				this.failDeadline();
				return;
			}
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
		this.remoteEnded = false;
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

		const httpStatus = this.httpStatus;
		const trailers: IGrpcTrailers = {
			status,
			...(message === undefined ? {} : { message }),
			raw,
			...(httpStatus === undefined ? {} : { httpStatus }),
		};
		this.trailersDeferred.complete(trailers);

		if (status === GrpcStatus.OK) {
			this.queue.end();
		} else {
			this.queue.fail(new GrpcCallError(status, message ?? grpcStatusName(status), this.httpStatus, raw));
		}
		if (!this.headersDeferred.isSettled) {
			this.headersDeferred.error(new GrpcCallError(status, message ?? grpcStatusName(status), this.httpStatus, raw));
		}

		// Only a stream that is still open in a direction is reset: the response
		// is still arriving (a cancel, a deadline, a failure), or the request is
		// still being sent after a complete early response (RFC 9113 section
		// 8.1). A completed call closes by itself: an RST_STREAM after every
		// call counts against the rapid-reset protection of servers
		// (CVE-2023-44487), and nghttp2 ends the connection with INTERNAL_ERROR
		// after about 1,000 of them.
		const stream = this.stream;
		if (stream && !stream.closed && !stream.destroyed) {
			if (!this.remoteEnded) {
				stream.close(closeCode);
			} else if (!stream.writableFinished) {
				// CANCEL, not NO_ERROR: Node holds an RST_STREAM(NO_ERROR) back until the
				// request is completely written, which never happens when the server no
				// longer reads it.
				stream.close(Http2ErrorCode.CANCEL);
			}
		}
	}
}

/** The keepalive PING intervals of a session (see {@link IGrpcChannelOptions.keepAliveTimeMs}). */
interface IKeepAliveIntervals {
	readonly timeMs: number | undefined;
	readonly longLivedTimeMs: number | undefined;
}

/** The opaque data of a GOAWAY ENHANCE_YOUR_CALM that gRPC servers send to a client that pings too often. */
const TOO_MANY_PINGS = 'too_many_pings';

/**
 * Wraps one HTTP/2 session: tracks the calls on it, runs keepalive pings
 * while calls are open (any call with {@link IGrpcChannelOptions.keepAliveTimeMs},
 * else a long-lived one), also while the session drains after GOAWAY, and
 * reports when it can no longer be used for new streams.
 */
class ChannelSession {

	private readonly calls = new Set<GrpcCall>();
	private longLivedCalls = 0;
	private connected = false;
	private goingAway = false;
	private closed = false;
	private lastError: Error | undefined;
	private keepAliveTimer: ReturnType<typeof setInterval> | undefined;
	/** The interval of {@link keepAliveTimer}. */
	private keepAliveIntervalMs: number | undefined;
	/** The timers that destroy the session when a keepalive is not acknowledged. */
	private readonly ackTimeouts = new Set<ReturnType<typeof setTimeout>>();

	constructor(
		readonly session: http2.ClientHttp2Session,
		private readonly options: IResolvedChannelOptions,
		private readonly keepAlive: IKeepAliveIntervals,
		private readonly onUnusable: () => void,
		private readonly onTooManyPings: () => void,
	) {
		session.on('connect', () => {
			this.connected = true;
			if (!session.destroyed) {
				session.setLocalWindowSize(LOCAL_WINDOW_SIZE);
			}
			this.updateKeepAlive();
		});
		session.on('goaway', (errorCode: number, _lastStreamId: number, opaqueData?: Buffer) => {
			this.goingAway = true;
			if (errorCode === Http2ErrorCode.ENHANCE_YOUR_CALM && opaqueData?.toString('latin1') === TOO_MANY_PINGS) {
				this.onTooManyPings();
			}
			this.onUnusable();
			// Let the in-flight streams finish, then shut down. They are still pinged:
			// a listen stream may stay open for long while the session drains.
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
			for (const timeout of this.ackTimeouts) {
				clearTimeout(timeout);
			}
			this.ackTimeouts.clear();
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
		if (!this.calls.has(call)) {
			this.calls.add(call);
			if (call.isLongLived) {
				this.longLivedCalls++;
			}
			this.updateKeepAlive();
		}
	}

	untrack(call: GrpcCall): void {
		if (this.calls.delete(call)) {
			if (call.isLongLived) {
				this.longLivedCalls--;
			}
			this.updateKeepAlive();
		}
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

	/** Whether PINGs can be sent: the session is connected and not closed (a session that received GOAWAY still is). */
	private get canPing(): boolean {
		return this.connected && !this.closed && !this.session.destroyed;
	}

	/**
	 * Starts, restarts or stops the PING timer for the interval that applies
	 * now: none without an open call (an idle connection is not pinged).
	 */
	private updateKeepAlive(): void {
		const intervalMs = !this.canPing || this.calls.size === 0
			? undefined
			: this.keepAlive.timeMs ?? (this.longLivedCalls > 0 ? this.keepAlive.longLivedTimeMs : undefined);
		if (intervalMs === this.keepAliveIntervalMs) {
			return;
		}
		this.stopKeepAlive();
		if (intervalMs !== undefined) {
			this.keepAliveIntervalMs = intervalMs;
			this.keepAliveTimer = setInterval(() => this.ping(), intervalMs);
		}
	}

	private stopKeepAlive(): void {
		if (this.keepAliveTimer !== undefined) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = undefined;
		}
		this.keepAliveIntervalMs = undefined;
	}

	private ping(): void {
		if (!this.canPing || this.calls.size === 0) {
			this.stopKeepAlive();
			return;
		}
		const session = this.session;
		let acknowledged = false;
		const timeout = setTimeout(() => {
			this.ackTimeouts.delete(timeout);
			if (!acknowledged && !session.destroyed) {
				session.destroy(new Error(`keepalive ping not acknowledged within ${this.options.keepAliveTimeoutMs}ms`));
			}
		}, this.options.keepAliveTimeoutMs);
		this.ackTimeouts.add(timeout);
		const onAcknowledged = () => {
			acknowledged = true;
			clearTimeout(timeout);
			this.ackTimeouts.delete(timeout);
		};
		let sent = false;
		try {
			if (session.closed) {
				// The session received GOAWAY: Node closes it at once and sends no PING on a closed
				// session, but the calls it drains (a listen stream may stay open for long) still need
				// the connection kept alive and checked. An empty SETTINGS frame is acknowledged like a
				// PING (RFC 9113, section 6.5.3), and gRPC servers count only PINGs as strikes.
				session.settings({}, error => {
					if (!error) {
						onAcknowledged();
					}
				});
				sent = true;
			} else {
				sent = session.ping(onAcknowledged);
			}
		} catch {
			sent = false;
		}
		if (!sent) {
			clearTimeout(timeout);
			this.ackTimeouts.delete(timeout);
		}
	}
}

export class GrpcChannel extends Disposable {

	private readonly resolved: IResolvedChannelOptions;
	private current: ChannelSession | undefined;
	private connecting: Promise<ChannelSession> | undefined;
	private http2Module: typeof http2 | undefined;
	private disposed = false;
	/**
	 * Every call that has not settled, including the ones that wait for a
	 * session (a first connection, or a transparent retry after GOAWAY) and so
	 * are on no session's list.
	 */
	private readonly inflight = new Set<GrpcCall>();
	/** The keepalive intervals of the next session; doubled after a GOAWAY `too_many_pings`. */
	private keepAlive: IKeepAliveIntervals;

	constructor(private readonly options: IGrpcChannelOptions) {
		super();
		this.resolved = {
			authority: requestAuthority(options.authority),
			scheme: options.secure ? 'https' : 'http',
			maxReceiveMessageBytes: options.maxReceiveMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES,
			maxSendMessageBytes: options.maxSendMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES,
			keepAliveTimeMs: timerInterval(options.keepAliveTimeMs),
			longLivedKeepAliveTimeMs: timerInterval(options.longLivedKeepAliveTimeMs),
			keepAliveTimeoutMs: timerInterval(options.keepAliveTimeoutMs) ?? DEFAULT_KEEPALIVE_TIMEOUT_MS,
			userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
			contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
		};
		this.keepAlive = { timeMs: this.resolved.keepAliveTimeMs, longLivedTimeMs: this.resolved.longLivedKeepAliveTimeMs };
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
			this.inflight.add(call);
			call.trailers.then(() => this.inflight.delete(call));
			this.startCall(call);
		}
		return call;
	}

	/**
	 * Closes the current session; the next call reconnects. In-flight calls are
	 * cancelled, also those waiting for a connection or for a session to retry on.
	 */
	close(): void {
		for (const call of Array.from(this.inflight)) {
			call.fail(GrpcStatus.CANCELLED, 'channel closed');
		}
		this.inflight.clear();
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
		const { host, port } = parseGrpcAuthority(this.options.authority, this.options.secure);
		const socket = this.options.createConnection ? await this.options.createConnection({ host, port }) : undefined;
		if (this.disposed) {
			socket?.destroy();
			throw new Error('channel is disposed');
		}

		const tlsOptions = this.options.tls;
		const ca = tlsOptions?.ca;
		const session = http2Module.connect(`${this.resolved.scheme}://${this.resolved.authority}`, {
			settings: { enablePush: false, initialWindowSize: STREAM_WINDOW_SIZE, maxHeaderListSize: MAX_HEADER_LIST_SIZE },
			maxSessionMemory: MAX_SESSION_MEMORY_MB,
			ca: typeof ca === 'string' ? ca : ca ? Array.from(ca) : undefined,
			rejectUnauthorized: tlsOptions?.rejectUnauthorized,
			servername: tlsOptions?.servername,
			createConnection: socket ? () => socket : undefined,
		});

		const wrapper: ChannelSession = new ChannelSession(session, this.resolved, this.keepAlive, () => {
			if (this.current === wrapper) {
				this.current = undefined;
			}
		}, () => {
			// As grpc-js does: the server allows fewer pings than we send, so the next session sends half as many.
			const double = (ms: number | undefined) => ms === undefined ? undefined : Math.min(ms * 2, MAX_TIMER_DELAY_MS);
			this.keepAlive = { timeMs: double(this.keepAlive.timeMs), longLivedTimeMs: double(this.keepAlive.longLivedTimeMs) };
		});
		this.current = wrapper;
		return wrapper;
	}
}
