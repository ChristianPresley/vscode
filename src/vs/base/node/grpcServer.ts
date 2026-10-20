/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http2 from 'http2';
import { CancellationToken, CancellationTokenSource } from '../common/cancellation.js';
import { DEFAULT_MAX_GRPC_MESSAGE_BYTES, GrpcFramingError, LengthPrefixedMessageReader, encodeLengthPrefixedMessage } from '../common/grpc/lpm.js';
import { GRPC_MESSAGE_MAX_BYTES, GrpcStatus, encodeGrpcMessage, grpcStatusName } from '../common/grpc/status.js';
import { parseGrpcTimeout } from '../common/grpc/timeout.js';
import { Disposable, IDisposable, toDisposable } from '../common/lifecycle.js';

/**
 * A hand-written gRPC server transport on top of Node's built-in `http2`
 * module (cleartext HTTP/2 with prior knowledge), for loopback listeners.
 * It follows the gRPC-over-HTTP/2 protocol
 * (https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md) and owns
 * everything below the request message: the limits of the connection, the
 * validation order of a call (`POST` else HTTP 405, an `application/grpc`
 * content type else HTTP 415, an unknown path or a compressed encoding
 * UNIMPLEMENTED, a refused `:authority` PERMISSION_DENIED, a malformed
 * `grpc-timeout` INVALID_ARGUMENT), the deadline, cancellation by
 * `RST_STREAM` or a lost connection, trailers-only responses and the
 * `RST_STREAM(NO_ERROR)` after a response that came before the end of the
 * request. Handlers see one {@link IGrpcServerCall} per stream.
 */

export type GrpcServerLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface IGrpcServerOptions {
	/** Largest request message accepted; defaults to 4 MiB. Overflow: RESOURCE_EXHAUSTED. */
	readonly maxReceiveMessageBytes?: number;
	/** Largest response message sent; defaults to 4 MiB. Overflow: RESOURCE_EXHAUSTED. */
	readonly maxSendMessageBytes?: number;
	/** Concurrent streams per connection; defaults to 256 (more are refused with REFUSED_STREAM). */
	readonly maxConcurrentStreams?: number;
	/** Largest request header list in octets; defaults to 8 KiB (overflow: RST_STREAM ENHANCE_YOUR_CALM). */
	readonly maxHeaderListBytes?: number;
	/** A connection without open streams for this long is closed with GOAWAY; defaults to 5 minutes, 0 keeps it open. */
	readonly idleTimeoutMs?: number;
	/** How long {@link GrpcServer.close} lets open streams finish after GOAWAY before it drops the connections; defaults to 1 s. */
	readonly shutdownGraceMs?: number;
	/** The content type of responses; defaults to `application/grpc+proto`. */
	readonly contentType?: string;
	/**
	 * Refuses a call whose `:authority` this returns false for with
	 * PERMISSION_DENIED, before the request message is read (for instance
	 * the DNS-rebinding check of a loopback server).
	 */
	readonly isAllowedAuthority?: (authority: string | undefined) => boolean;
	readonly log?: (level: GrpcServerLogLevel, message: string) => void;
}

/** One call (one HTTP/2 stream) as a handler sees it. */
export interface IGrpcServerCall {
	/** The `:path`, `/package.Service/Method`. */
	readonly path: string;
	readonly authority: string | undefined;
	/**
	 * The request metadata: every header except the pseudo-headers, with
	 * lowercase names; repeated values are joined with `, `. `-bin` values
	 * are passed as received (base64).
	 */
	readonly metadata: Readonly<Record<string, string>>;
	/** The `grpc-timeout` of the call in milliseconds, when it has one. */
	readonly timeoutMs: number | undefined;
	readonly remoteAddress: string | undefined;
	/**
	 * Cancelled when the call ends without the handler ending it: the client
	 * reset the stream, the connection went away, the deadline passed, the
	 * request was malformed or the server shut down.
	 */
	readonly token: CancellationToken;
	/** Whether the call has ended; sending is a no-op then. */
	readonly isEnded: boolean;
	/**
	 * Reads the one request message of a unary or server-streaming call.
	 * Resolves `undefined` when there is none to read: the call then has
	 * already ended (RESOURCE_EXHAUSTED for a message over the limit,
	 * UNIMPLEMENTED for a compressed one, INVALID_ARGUMENT for a missing,
	 * truncated or second message) or was cancelled.
	 */
	readRequest(): Promise<Uint8Array | undefined>;
	/**
	 * Sends one response message; the response headers go out with the
	 * first. Returns false when the call has ended (or ends now, because the
	 * message is over the send limit).
	 */
	sendMessage(payload: Uint8Array): boolean;
	/**
	 * Ends the call with a status: in the trailers after the messages, or in
	 * a trailers-only response when nothing was sent yet. `message` becomes
	 * `grpc-message` (cut to 1024 bytes of UTF-8, then percent-encoded) and
	 * `trailers` are added as they are.
	 */
	end(status: GrpcStatus, message?: string, trailers?: Readonly<Record<string, string>>): void;
}

export type GrpcCallHandler = (call: IGrpcServerCall) => void | Promise<void>;

const DEFAULT_CONTENT_TYPE = 'application/grpc+proto';
const DEFAULT_MAX_CONCURRENT_STREAMS = 256;
const DEFAULT_MAX_HEADER_LIST_BYTES = 8 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SHUTDOWN_GRACE_MS = 1000;
/** The connection-level receive window. */
const LOCAL_WINDOW_SIZE = 4 * 1024 * 1024;
/** The receive window of each stream. */
const STREAM_WINDOW_SIZE = 1024 * 1024;
const MAX_SESSION_MEMORY_MB = 64;
const NGHTTP2_NO_ERROR = 0;
const NGHTTP2_ENHANCE_YOUR_CALM = 11;
/** The per-entry overhead of a header field in the header list size (RFC 9113 section 6.5.2). */
const HEADER_FIELD_OVERHEAD = 32;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Cuts `text` to at most `maxBytes` bytes of UTF-8 without splitting a
 * character.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.codePointAt(i)!;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + size > maxBytes) {
			return text.substring(0, i);
		}
		bytes += size;
		if (code >= 0x10000) {
			i++; // the low surrogate
		}
	}
	return text;
}

function flattenMetadata(headers: http2.IncomingHttpHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(':') || value === undefined) {
			continue;
		}
		result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
	}
	return result;
}

/** The size of a header list as SETTINGS_MAX_HEADER_LIST_SIZE counts it. */
function headerListSize(headers: http2.IncomingHttpHeaders): number {
	let size = 0;
	for (const [name, value] of Object.entries(headers)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== undefined) {
				size += name.length + String(item).length + HEADER_FIELD_OVERHEAD;
			}
		}
	}
	return size;
}

function headerString(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

interface IResolvedServerOptions {
	readonly maxReceiveMessageBytes: number;
	readonly maxSendMessageBytes: number;
	readonly maxConcurrentStreams: number;
	readonly maxHeaderListBytes: number;
	readonly idleTimeoutMs: number;
	readonly shutdownGraceMs: number;
	readonly contentType: string;
}

/** The outcome of a call once it has ended. */
type CallOutcome = 'handler' | 'cancelled';

/**
 * One stream. The request body is read from the start (so that the end of
 * the request is known for the `RST_STREAM(NO_ERROR)` rule); the first
 * complete message is kept for {@link readRequest}.
 */
class GrpcServerCall implements IGrpcServerCall {

	readonly path: string;
	readonly authority: string | undefined;
	readonly metadata: Readonly<Record<string, string>>;
	readonly remoteAddress: string | undefined;
	timeoutMs: number | undefined;

	private readonly cts = new CancellationTokenSource();
	private readonly reader: LengthPrefixedMessageReader;
	private request: Uint8Array | undefined;
	private requestWaiters: ((value: Uint8Array | undefined) => void)[] = [];
	private requestEnded = false;
	private headersSent = false;
	private ended = false;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingTrailers: http2.OutgoingHttpHeaders | undefined;

	constructor(
		private readonly stream: http2.ServerHttp2Stream,
		headers: http2.IncomingHttpHeaders,
		private readonly options: IResolvedServerOptions,
		private readonly log: (level: GrpcServerLogLevel, message: string) => void,
	) {
		this.path = headerString(headers[':path']) ?? '';
		this.authority = headerString(headers[':authority']) ?? headerString(headers.host);
		this.metadata = flattenMetadata(headers);
		this.remoteAddress = stream.session?.socket?.remoteAddress;
		this.reader = new LengthPrefixedMessageReader(options.maxReceiveMessageBytes);

		stream.on('data', (chunk: Buffer) => this.onData(chunk));
		stream.on('end', () => this.onEnd());
		stream.on('close', () => this.onClose());
		stream.on('wantTrailers', () => this.onWantTrailers());
	}

	get token(): CancellationToken {
		return this.cts.token;
	}

	get isEnded(): boolean {
		return this.ended;
	}

	/** Starts the deadline of the call (from `grpc-timeout`). */
	armDeadline(timeoutMs: number): void {
		this.timeoutMs = timeoutMs;
		this.deadlineTimer = setTimeout(() => {
			this.deadlineTimer = undefined;
			if (!this.ended) {
				this.log('debug', `[grpc] ${this.path}: deadline of ${timeoutMs}ms exceeded`);
				this.finish(GrpcStatus.DEADLINE_EXCEEDED, 'Deadline exceeded', undefined, 'cancelled');
			}
		}, timeoutMs);
	}

	readRequest(): Promise<Uint8Array | undefined> {
		if (this.request !== undefined) {
			return Promise.resolve(this.request);
		}
		if (this.ended) {
			return Promise.resolve(undefined);
		}
		return new Promise(resolve => this.requestWaiters.push(resolve));
	}

	sendMessage(payload: Uint8Array): boolean {
		if (this.ended) {
			return false;
		}
		if (payload.byteLength > this.options.maxSendMessageBytes) {
			this.log('warn', `[grpc] ${this.path}: response message of ${payload.byteLength} bytes exceeds the limit of ${this.options.maxSendMessageBytes} bytes`);
			this.finish(GrpcStatus.RESOURCE_EXHAUSTED, `Response message too large: ${payload.byteLength} bytes exceeds the limit of ${this.options.maxSendMessageBytes} bytes`, undefined, 'cancelled');
			return false;
		}
		try {
			if (!this.headersSent) {
				this.headersSent = true;
				this.stream.respond({ ':status': 200, 'content-type': this.options.contentType }, { waitForTrailers: true });
			}
			const framed = encodeLengthPrefixedMessage(payload);
			this.stream.write(Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength));
			return true;
		} catch (error) {
			this.log('debug', `[grpc] ${this.path}: could not send a message: ${errorMessage(error)}`);
			this.finish(GrpcStatus.UNAVAILABLE, undefined, undefined, 'cancelled');
			return false;
		}
	}

	end(status: GrpcStatus, message?: string, trailers?: Readonly<Record<string, string>>): void {
		this.finish(status, message, trailers, 'handler');
	}

	/** An HTTP-level refusal (405, 415) that is not a gRPC response at all. */
	respondHttp(httpStatus: number, headers: http2.OutgoingHttpHeaders = {}): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.clearDeadline();
		try {
			this.headersSent = true;
			this.stream.respond({ ':status': httpStatus, ...headers }, { endStream: true });
		} catch (error) {
			this.log('debug', `[grpc] ${this.path}: could not respond: ${errorMessage(error)}`);
		}
		this.resetAfterEarlyResponse();
		this.settle('cancelled');
	}

	private finish(status: GrpcStatus, message: string | undefined, extra: Readonly<Record<string, string>> | undefined, outcome: CallOutcome): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.clearDeadline();
		const statusHeaders: http2.OutgoingHttpHeaders = { 'grpc-status': String(status) };
		if (message !== undefined && message.length > 0) {
			statusHeaders['grpc-message'] = encodeGrpcMessage(truncateUtf8(message, GRPC_MESSAGE_MAX_BYTES));
		}
		for (const [name, value] of Object.entries(extra ?? {})) {
			const lower = name.toLowerCase();
			if (!lower.startsWith(':') && lower !== 'grpc-status' && lower !== 'grpc-message') {
				statusHeaders[lower] = value;
			}
		}
		if (status !== GrpcStatus.OK) {
			this.log('debug', `[grpc] ${this.path}: ${grpcStatusName(status)}${message ? ` (${message})` : ''}`);
		}
		const stream = this.stream;
		if (!stream.destroyed && !stream.closed) {
			try {
				if (!this.headersSent) {
					// Trailers-only: the status travels in the only header block.
					this.headersSent = true;
					stream.respond({ ':status': 200, 'content-type': this.options.contentType, ...statusHeaders }, { endStream: true });
					this.resetAfterEarlyResponse();
				} else {
					this.pendingTrailers = statusHeaders;
					stream.end();
				}
			} catch (error) {
				this.log('debug', `[grpc] ${this.path}: could not end the call: ${errorMessage(error)}`);
			}
		}
		this.settle(outcome);
	}

	private onWantTrailers(): void {
		const trailers = this.pendingTrailers ?? { 'grpc-status': String(GrpcStatus.OK) };
		this.pendingTrailers = undefined;
		try {
			this.stream.sendTrailers(trailers);
		} catch (error) {
			this.log('debug', `[grpc] ${this.path}: could not send the trailers: ${errorMessage(error)}`);
		}
		this.resetAfterEarlyResponse();
	}

	/**
	 * RFC 9113 section 8.1: after a complete response, a request that has
	 * not ended is stopped with `RST_STREAM(NO_ERROR)`; the client keeps
	 * the response.
	 */
	private resetAfterEarlyResponse(): void {
		if (this.requestEnded || this.stream.destroyed || this.stream.closed) {
			return;
		}
		try {
			this.stream.close(NGHTTP2_NO_ERROR);
		} catch (error) {
			this.log('debug', `[grpc] ${this.path}: could not reset the stream: ${errorMessage(error)}`);
		}
	}

	/** Releases the waiters, cancels the token when the handler did not end the call, and frees the token. */
	private settle(outcome: CallOutcome): void {
		this.resolveRequest(undefined);
		if (outcome === 'cancelled') {
			this.cts.cancel();
		}
		this.cts.dispose();
	}

	private resolveRequest(value: Uint8Array | undefined): void {
		const waiters = this.requestWaiters;
		this.requestWaiters = [];
		for (const waiter of waiters) {
			waiter(value);
		}
	}

	private clearDeadline(): void {
		if (this.deadlineTimer !== undefined) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
	}

	private onData(chunk: Buffer): void {
		if (this.ended) {
			return;
		}
		let messages: Uint8Array[];
		try {
			messages = this.reader.feed(chunk);
		} catch (error) {
			this.failFraming(error);
			return;
		}
		for (const message of messages) {
			if (this.request !== undefined) {
				this.finish(GrpcStatus.INVALID_ARGUMENT, 'The call carried more than one request message', undefined, 'cancelled');
				return;
			}
			this.request = message;
			this.resolveRequest(message);
		}
	}

	private onEnd(): void {
		this.requestEnded = true;
		if (this.ended) {
			return;
		}
		try {
			this.reader.end();
		} catch (error) {
			this.failFraming(error);
			return;
		}
		if (this.request === undefined) {
			this.finish(GrpcStatus.INVALID_ARGUMENT, 'The call carried no request message', undefined, 'cancelled');
		}
	}

	private onClose(): void {
		this.clearDeadline();
		if (!this.ended) {
			// RST_STREAM from the client, or the connection went away.
			this.ended = true;
			this.log('debug', `[grpc] ${this.path}: cancelled by the client (code ${this.stream.rstCode})`);
			this.settle('cancelled');
		}
	}

	private failFraming(error: unknown): void {
		if (error instanceof GrpcFramingError) {
			switch (error.reason) {
				case 'message-too-large':
					this.finish(GrpcStatus.RESOURCE_EXHAUSTED, error.message, undefined, 'cancelled');
					return;
				case 'compressed':
					this.finish(GrpcStatus.UNIMPLEMENTED, 'Compression is not supported', { 'grpc-accept-encoding': 'identity' }, 'cancelled');
					return;
				case 'truncated':
					this.finish(GrpcStatus.INVALID_ARGUMENT, 'Truncated request message', undefined, 'cancelled');
					return;
			}
		}
		this.finish(GrpcStatus.INTERNAL, errorMessage(error), undefined, 'cancelled');
	}
}

/** One HTTP/2 connection: its open streams and the idle timer. */
class ServerSession {

	private openStreams = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private goingAway = false;

	constructor(
		readonly session: http2.ServerHttp2Session,
		private readonly idleTimeoutMs: number,
		private readonly log: (level: GrpcServerLogLevel, message: string) => void,
		onClose: () => void,
	) {
		try {
			session.setLocalWindowSize(LOCAL_WINDOW_SIZE);
		} catch (error) {
			log('debug', `[grpc] could not set the connection window: ${errorMessage(error)}`);
		}
		session.on('error', (error: Error) => log('debug', `[grpc] connection error: ${error.message}`));
		session.on('close', () => {
			this.clearIdle();
			onClose();
		});
		this.armIdle();
	}

	streamOpened(): void {
		this.openStreams++;
		this.clearIdle();
	}

	streamClosed(): void {
		this.openStreams--;
		if (this.openStreams === 0) {
			this.armIdle();
		}
	}

	/** GOAWAY: the open streams finish, no new ones are accepted. */
	goAway(): void {
		this.goingAway = true;
		this.clearIdle();
		if (!this.session.closed && !this.session.destroyed) {
			this.session.close();
		}
	}

	destroy(): void {
		this.clearIdle();
		if (!this.session.destroyed) {
			this.session.destroy();
		}
	}

	private armIdle(): void {
		if (this.idleTimeoutMs <= 0 || this.goingAway) {
			return;
		}
		this.clearIdle();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this.openStreams === 0) {
				this.log('debug', `[grpc] closing a connection idle for ${this.idleTimeoutMs}ms`);
				this.goAway();
			}
		}, this.idleTimeoutMs);
		// The listening socket keeps the process alive, not an idle connection.
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	private clearIdle(): void {
		if (this.idleTimer !== undefined) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}
}

/**
 * A gRPC server on the loopback interface. Register handlers with
 * {@link addService}, then {@link listen}; {@link close} sends GOAWAY to every
 * connection and stops listening.
 */
export class GrpcServer extends Disposable {

	private readonly handlers = new Map<string, GrpcCallHandler>();
	private readonly servers: http2.Http2Server[] = [];
	private readonly sessions = new Set<ServerSession>();
	private readonly resolved: IResolvedServerOptions;
	private readonly logFn: (level: GrpcServerLogLevel, message: string) => void;
	private boundPort: number | undefined;
	private readonly boundAddresses: string[] = [];
	private closing: Promise<void> | undefined;

	constructor(private readonly options: IGrpcServerOptions = {}) {
		super();
		this.resolved = {
			maxReceiveMessageBytes: options.maxReceiveMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES,
			maxSendMessageBytes: options.maxSendMessageBytes ?? DEFAULT_MAX_GRPC_MESSAGE_BYTES,
			maxConcurrentStreams: options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS,
			maxHeaderListBytes: options.maxHeaderListBytes ?? DEFAULT_MAX_HEADER_LIST_BYTES,
			idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			shutdownGraceMs: options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
			contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
		};
		this.logFn = options.log ?? (() => { });
	}

	/** The port the server listens on, once {@link listen} resolved. */
	get port(): number | undefined {
		return this.boundPort;
	}

	/** The `host:port` addresses the server listens on (`127.0.0.1:<port>`, and `[::1]:<port>` when IPv6 is available). */
	get addresses(): readonly string[] {
		return this.boundAddresses;
	}

	/** The number of open HTTP/2 connections (diagnostics and tests). */
	get connectionCount(): number {
		return this.sessions.size;
	}

	/**
	 * Serves calls to `path` (`/package.Service/Method`) with `handler`. The
	 * handler may return before it ends the call (a streaming response); a
	 * handler that throws or rejects ends the call with INTERNAL. Disposing
	 * the result removes the handler.
	 */
	addService(path: string, handler: GrpcCallHandler): IDisposable {
		if (this.handlers.has(path)) {
			throw new Error(`A handler for ${path} is already registered`);
		}
		this.handlers.set(path, handler);
		return toDisposable(() => {
			if (this.handlers.get(path) === handler) {
				this.handlers.delete(path);
			}
		});
	}

	/**
	 * Starts listening on `host:port` (port 0 picks a free one) and resolves
	 * with the port. For the IPv4 loopback host the server also listens on
	 * `[::1]` with the same port when the machine has IPv6.
	 */
	async listen(port: number = 0, host: string = '127.0.0.1'): Promise<number> {
		if (this.boundPort !== undefined) {
			throw new Error('The gRPC server is already listening');
		}
		if (this.closing) {
			throw new Error('The gRPC server is closed');
		}
		// Loaded lazily so that bundles that never serve gRPC do not pull in http2.
		const http2Module = await import('http2');
		const primary = this.createServer(http2Module);
		const bound = await this.listenOn(primary, port, host);
		this.boundPort = bound;
		this.boundAddresses.push(`${host.includes(':') ? `[${host}]` : host}:${bound}`);
		if (host === '127.0.0.1') {
			const secondary = this.createServer(http2Module);
			try {
				await this.listenOn(secondary, bound, '::1');
				this.boundAddresses.push(`[::1]:${bound}`);
			} catch (error) {
				this.logFn('debug', `[grpc] not listening on [::1]:${bound}: ${errorMessage(error)}`);
				this.removeServer(secondary);
			}
		}
		this.logFn('info', `[grpc] listening on ${this.boundAddresses.join(', ')}`);
		return bound;
	}

	/**
	 * Stops accepting connections and sends GOAWAY to every open one; the
	 * streams in flight may finish within the shutdown grace period, after
	 * which the remaining connections are dropped (their calls cancelled).
	 */
	close(): Promise<void> {
		if (!this.closing) {
			this.closing = this.doClose();
		}
		return this.closing;
	}

	override dispose(): void {
		void this.close();
		super.dispose();
	}

	private async doClose(): Promise<void> {
		for (const session of this.sessions) {
			session.goAway();
		}
		const closed = this.servers.map(server => new Promise<void>(resolve => server.close(() => resolve())));
		const grace = setTimeout(() => {
			for (const session of this.sessions) {
				session.destroy();
			}
		}, this.resolved.shutdownGraceMs);
		await Promise.all(closed);
		clearTimeout(grace);
		this.servers.length = 0;
		this.boundPort = undefined;
		this.boundAddresses.length = 0;
	}

	private createServer(http2Module: typeof http2): http2.Http2Server {
		const server = http2Module.createServer({
			settings: {
				enablePush: false,
				maxConcurrentStreams: this.resolved.maxConcurrentStreams,
				maxHeaderListSize: this.resolved.maxHeaderListBytes,
				initialWindowSize: STREAM_WINDOW_SIZE,
			},
			maxSessionMemory: MAX_SESSION_MEMORY_MB,
		});
		server.on('session', session => {
			if (this.closing) {
				session.destroy();
				return;
			}
			const wrapper: ServerSession = new ServerSession(session, this.resolved.idleTimeoutMs, this.logFn, () => this.sessions.delete(wrapper));
			this.sessions.add(wrapper);
			session.on('stream', stream => {
				wrapper.streamOpened();
				stream.once('close', () => wrapper.streamClosed());
			});
		});
		server.on('stream', (stream, headers) => this.onStream(stream, headers));
		server.on('sessionError', error => this.logFn('debug', `[grpc] session error: ${error.message}`));
		this.servers.push(server);
		return server;
	}

	private removeServer(server: http2.Http2Server): void {
		const index = this.servers.indexOf(server);
		if (index !== -1) {
			this.servers.splice(index, 1);
		}
		server.close();
	}

	private listenOn(server: http2.Http2Server, port: number, host: string): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off('listening', onListening);
				reject(error);
			};
			const onListening = () => {
				server.off('error', onError);
				server.on('error', error => this.logFn('error', `[grpc] server error: ${error.message}`));
				const address = server.address();
				if (address && typeof address === 'object') {
					resolve(address.port);
				} else {
					reject(new Error('Unable to determine the port of the gRPC server'));
				}
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, host);
		});
	}

	private onStream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
		stream.on('error', error => this.logFn('debug', `[grpc] stream error: ${error.message}`));
		// nghttp2 applies SETTINGS_MAX_HEADER_LIST_SIZE only once the client acknowledged
		// the settings, so the first streams of a connection are checked here.
		const headerListBytes = headerListSize(headers);
		if (headerListBytes > this.resolved.maxHeaderListBytes) {
			this.logFn('warn', `[grpc] refused a stream with a header list of ${headerListBytes} bytes (limit ${this.resolved.maxHeaderListBytes})`);
			stream.close(NGHTTP2_ENHANCE_YOUR_CALM);
			return;
		}
		const call = new GrpcServerCall(stream, headers, this.resolved, this.logFn);

		// The validation order of the gRPC transports (zig-sdk `grpc_server.zig`).
		const method = headerString(headers[':method']);
		if (method !== 'POST') {
			call.respondHttp(405, { allow: 'POST' });
			return;
		}
		const contentType = headerString(headers['content-type']);
		if (contentType === undefined || !contentType.toLowerCase().startsWith('application/grpc')) {
			call.respondHttp(415);
			return;
		}
		const handler = this.handlers.get(call.path);
		if (!handler) {
			call.end(GrpcStatus.UNIMPLEMENTED, `Unknown service or method: ${call.path}`, { 'grpc-accept-encoding': 'identity' });
			return;
		}
		const encoding = call.metadata['grpc-encoding'];
		if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
			call.end(GrpcStatus.UNIMPLEMENTED, `Compression is not supported (grpc-encoding '${encoding}')`, { 'grpc-accept-encoding': 'identity' });
			return;
		}
		if (this.closing) {
			call.end(GrpcStatus.UNAVAILABLE, 'The server is shutting down');
			return;
		}
		if (this.options.isAllowedAuthority && !this.options.isAllowedAuthority(call.authority)) {
			this.logFn('warn', `[grpc] ${call.path} refused: the authority '${call.authority ?? ''}' is not allowed`);
			call.end(GrpcStatus.PERMISSION_DENIED, 'The :authority of the call is not allowed');
			return;
		}
		const rawTimeout = call.metadata['grpc-timeout'];
		if (rawTimeout !== undefined) {
			let timeoutMs: number;
			try {
				timeoutMs = parseGrpcTimeout(rawTimeout.trim());
			} catch {
				call.end(GrpcStatus.INVALID_ARGUMENT, `Invalid grpc-timeout '${rawTimeout}'`);
				return;
			}
			call.armDeadline(timeoutMs);
		}

		let result: void | Promise<void>;
		try {
			result = handler(call);
		} catch (error) {
			this.onHandlerError(call, error);
			return;
		}
		if (result) {
			result.catch(error => this.onHandlerError(call, error));
		}
	}

	private onHandlerError(call: GrpcServerCall, error: unknown): void {
		this.logFn('error', `[grpc] the handler of ${call.path} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		call.end(GrpcStatus.INTERNAL, 'Internal server error');
	}
}
