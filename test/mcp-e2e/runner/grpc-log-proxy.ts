/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An HTTP/2 proxy in front of a gRPC server that records every call it forwards: the zig-sdk
// conformance server logs no requests, so this is the server-side record of which RPCs reached it
// (the suite checks, for example, that the typed binding sends no `server/discover`).
//
// VS Code connects to a TCP (or, with --tls-cert/--tls-key, TLS) front end that relays the bytes
// unchanged to an HTTP/2 server of this process on an ephemeral loopback port, which forwards each
// call to the upstream server. The relay reads the HTTP/2 frames of both directions, so the log
// also has the frames Node's http2 module does not surface (an RST_STREAM the client sends for a
// stream that already ended, a GOAWAY). The HTTP/2 server is Node's (nghttp2), with its
// rapid-reset protection (CVE-2023-44487): a token bucket of `streamResetBurst` resets (default
// 1000) refilled at `streamResetRate` per second (default 33); a client that resets streams faster
// than the refill gets GOAWAY(INTERNAL_ERROR) once the bucket is empty, as from any Node gRPC
// server. --rst-rate 0 turns the refill off, so the session ends after `burst` resets however
// slowly they come (the soak test: the zig server answers a call in about 40 ms on Linux, slower
// than the default refill).
//
// One JSON line per event in the log file (`session` is the client connection, counted from 1):
//   { "event": "connection", "session", "phase": "open", "tls"? }  a client connected;
//   { "event": "connection", "session", "phase": "close", "frames", "clientResets", "clientResetsAfterEnd" }
//   { "event": "call", "session", "stream", "h2Stream", "path", "metadata": { "mcp-method", ... }, "jsonRpcMethods"? }
//     when the request half of a call ended (`stream` counts the calls of the proxy, `h2Stream` is the
//     HTTP/2 stream id on the client connection; `jsonRpcMethods` for the JSON-RPC tunnel `Call`);
//   { "event": "end", "session", "stream", "path", "grpcStatus", "grpcMessage", "ms", "refused"? } when it completed;
//   { "event": "rst", "session", "stream", "from": "client" | "server", "errorCode", "afterEnd" }
//     every RST_STREAM frame; `afterEnd`: the other side had already ended the stream (for a
//     client reset: the server had sent END_STREAM, the call was complete);
//   { "event": "goaway", "session", "from", "errorCode", "lastStreamId" } every GOAWAY frame;
//   { "event": "session-error", "session", "error" }, { "event": "tls-error", "error", "servername" }.
//
// Usage: node runner/grpc-log-proxy.ts --listen <port> --upstream <port> --log <file.jsonl>
//            [--refuse-tunnel] [--tls-cert <cert.pem> --tls-key <key.pem>] [--rst-burst <n> --rst-rate <n>]
//   --refuse-tunnel  answers the JSON-RPC tunnel `/mcp.zig.transport.v1.Mcp/Call` itself with a
//                    trailers-only UNIMPLEMENTED (grpc-status 12, no mcp-error-code), as a gRPC
//                    server without the tunnel service does, and forwards every other path;
//   --tls-cert/--tls-key  terminates TLS (ALPN h2) and forwards cleartext to the upstream;
//   --rst-burst/--rst-rate  nghttp2's stream reset rate limit (both or neither; default 1000 and 33);
//   --mangle-mcp-name <tool>=<value>[:once]  replaces the mirrored `mcp-name` metadata of a tools/call
//                    of <tool> (the body is unchanged, so the server answers -32020), every time or once;
//   --hold <tool>=<ms>  forwards a tools/call of <tool> only after <ms> (for deadlines and cancellation).
// The `call` event records `mangled` and `heldMs`, the `end` event `mcpErrorCode`/`mcpErrorBin` of the
// trailers, and the metadata keeps `mcp-param-*` and the scheme of `authorization`.

import * as fs from 'node:fs';
import * as http2 from 'node:http2';
import * as net from 'node:net';
import * as tls from 'node:tls';

const TUNNEL_CALL_PATH = '/mcp.zig.transport.v1.Mcp/Call';
/** The request metadata the log keeps (the MCP mirror headers, the routing metadata and the deadline). */
const LOGGED_METADATA = ['mcp-method', 'mcp-name', 'mcp-protocol-version', 'mcp-gateway-route', 'mcp_tool', 'grpc-timeout'];
const GRPC_UNIMPLEMENTED = '12';

function argValue(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** The JSON-RPC methods of the `JsonRpcMessage { bytes jsonrpc = 1; }` frames of a tunnel request body. */
export function tunnelMethods(body: Buffer): string[] {
	const out: string[] = [];
	let offset = 0;
	while (offset + 5 <= body.length) {
		const length = body.readUInt32BE(offset + 1);
		const message = body.subarray(offset + 5, offset + 5 + length);
		offset += 5 + length;
		let i = 0;
		while (i < message.length) {
			const key = message[i++];
			let len = 0;
			let shift = 0;
			let b: number;
			do {
				b = message[i++];
				len += (b & 0x7f) * Math.pow(2, shift);
				shift += 7;
			} while (b & 0x80);
			if (key === 0x0a) {
				try {
					const parsed = JSON.parse(message.subarray(i, i + len).toString('utf8')) as { method?: unknown };
					out.push(typeof parsed.method === 'string' ? parsed.method : '(response)');
				} catch {
					out.push('(not JSON)');
				}
			}
			i += len;
		}
	}
	return out;
}

// --- HTTP/2 frames -------------------------------------------------------------------------------

export const FRAME_TYPE_NAMES: readonly string[] = ['DATA', 'HEADERS', 'PRIORITY', 'RST_STREAM', 'SETTINGS', 'PUSH_PROMISE', 'PING', 'GOAWAY', 'WINDOW_UPDATE', 'CONTINUATION'];
export const FRAME_RST_STREAM = 0x3;
export const FRAME_GOAWAY = 0x7;
const FRAME_DATA = 0x0;
const FRAME_HEADERS = 0x1;
const FLAG_END_STREAM = 0x1;
const FRAME_HEADER_BYTES = 9;
/** The client connection preface, `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`. */
const CLIENT_PREFACE_BYTES = 24;
/** RST_STREAM carries a 4-byte error code, GOAWAY the last stream id and an error code. */
const KEPT_PAYLOAD_BYTES = 8;

export interface IHttp2Frame {
	readonly type: number;
	readonly flags: number;
	readonly streamId: number;
	readonly length: number;
	/** The first {@link KEPT_PAYLOAD_BYTES} bytes of the payload (the frame is not buffered). */
	readonly head: Buffer;
}

/**
 * Reads the HTTP/2 frames of one direction of a connection from the bytes as they are relayed,
 * without buffering payloads. The client direction starts with the 24-byte connection preface.
 */
export class Http2FrameReader {
	private readonly _onFrame: (frame: IHttp2Frame) => void;
	private _prefaceLeft: number;
	private _header: Buffer = Buffer.alloc(0);
	private _frame: { type: number; flags: number; streamId: number; length: number } | undefined;
	private _payloadLeft = 0;
	private _head: Buffer[] = [];
	private _headBytes = 0;

	constructor(expectPreface: boolean, onFrame: (frame: IHttp2Frame) => void) {
		this._prefaceLeft = expectPreface ? CLIENT_PREFACE_BYTES : 0;
		this._onFrame = onFrame;
	}

	push(chunk: Buffer): void {
		let offset = 0;
		if (this._prefaceLeft > 0) {
			const n = Math.min(this._prefaceLeft, chunk.length);
			this._prefaceLeft -= n;
			offset = n;
		}
		while (offset < chunk.length) {
			if (this._frame) {
				const n = Math.min(this._payloadLeft, chunk.length - offset);
				if (this._headBytes < KEPT_PAYLOAD_BYTES) {
					const kept = chunk.subarray(offset, offset + Math.min(n, KEPT_PAYLOAD_BYTES - this._headBytes));
					this._head.push(kept);
					this._headBytes += kept.length;
				}
				this._payloadLeft -= n;
				offset += n;
				if (this._payloadLeft === 0) {
					this._emit();
				}
				continue;
			}
			const need = FRAME_HEADER_BYTES - this._header.length;
			const take = chunk.subarray(offset, offset + need);
			this._header = this._header.length ? Buffer.concat([this._header, take]) : Buffer.from(take);
			offset += take.length;
			if (this._header.length === FRAME_HEADER_BYTES) {
				const length = this._header.readUIntBE(0, 3);
				this._frame = { type: this._header[3], flags: this._header[4], streamId: this._header.readUInt32BE(5) & 0x7fffffff, length };
				this._header = Buffer.alloc(0);
				this._payloadLeft = length;
				if (length === 0) {
					this._emit();
				}
			}
		}
	}

	private _emit(): void {
		const frame = this._frame!;
		const head = Buffer.concat(this._head);
		this._frame = undefined;
		this._head = [];
		this._headBytes = 0;
		this._onFrame({ ...frame, head });
	}
}

export function frameTypeName(type: number): string {
	return FRAME_TYPE_NAMES[type] ?? `0x${type.toString(16)}`;
}

/** What the relay saw on one client connection. */
interface IConnectionStats {
	readonly frames: { readonly fromClient: Record<string, number>; readonly fromServer: Record<string, number> };
	clientResets: number;
	clientResetsAfterEnd: number;
	serverResets: number;
	/** The streams the server ended (END_STREAM on HEADERS or DATA): their calls are complete. */
	readonly serverEnded: Set<number>;
	readonly clientEnded: Set<number>;
}

function withoutPseudoHeaders(headers: http2.IncomingHttpHeaders): http2.OutgoingHttpHeaders {
	const out: http2.OutgoingHttpHeaders = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!key.startsWith(':') && value !== undefined) {
			out[key] = value;
		}
	}
	return out;
}

interface IProxyOptions {
	readonly listen: number;
	readonly upstreamPort: number;
	readonly logFile: string;
	readonly refuseTunnel: boolean;
	readonly tls: { readonly cert: string; readonly key: string } | undefined;
	/** nghttp2's stream reset rate limit, when it is not the default. */
	readonly resetLimit: { readonly burst: number; readonly rate: number } | undefined;
	/** --mangle-mcp-name: the `mcp-name` metadata of a tools/call of `tool` is replaced with `value` (only the first call with `once`). */
	readonly mangles: { readonly tool: string; readonly value: string; readonly once: boolean; used: boolean }[];
	/** --hold: a tools/call of the tool is forwarded only after this many milliseconds. */
	readonly holds: ReadonlyMap<string, number>;
}

/** All values of a repeatable option. */
function argValues(args: readonly string[], name: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === name) {
			out.push(args[i + 1]);
		}
	}
	return out;
}

/** `<tool>=<value>[:once]` of --mangle-mcp-name. */
export function parseMangle(spec: string): { tool: string; value: string; once: boolean; used: boolean } | undefined {
	const eq = spec.indexOf('=');
	if (eq <= 0) {
		return undefined;
	}
	const once = spec.endsWith(':once');
	const value = spec.slice(eq + 1, once ? -':once'.length : undefined);
	return value ? { tool: spec.slice(0, eq), value, once, used: false } : undefined;
}

/** The MCP error a gRPC answer carries in its trailers (or trailers-only headers), for the `end` event. */
function mcpErrorOf(trailers: http2.IncomingHttpHeaders | http2.OutgoingHttpHeaders): Record<string, unknown> {
	const code = trailers['mcp-error-code'];
	const bin = trailers['mcp-error-bin'];
	return {
		...(code !== undefined ? { mcpErrorCode: String(code) } : {}),
		...(bin !== undefined ? { mcpErrorBin: true } : {}),
	};
}

function parseOptions(args: readonly string[]): IProxyOptions | undefined {
	const listen = Number(argValue(args, '--listen'));
	const upstreamPort = Number(argValue(args, '--upstream'));
	const logFile = argValue(args, '--log');
	const cert = argValue(args, '--tls-cert');
	const key = argValue(args, '--tls-key');
	const burst = argValue(args, '--rst-burst');
	const rate = argValue(args, '--rst-rate');
	if (!Number.isInteger(listen) || !Number.isInteger(upstreamPort) || !logFile || (cert === undefined) !== (key === undefined) || (burst === undefined) !== (rate === undefined)) {
		return undefined;
	}
	const resetLimit = burst !== undefined && rate !== undefined ? { burst: Number(burst), rate: Number(rate) } : undefined;
	if (resetLimit && !(Number.isInteger(resetLimit.burst) && resetLimit.burst > 0 && Number.isInteger(resetLimit.rate) && resetLimit.rate >= 0)) {
		return undefined;
	}
	const mangles = argValues(args, '--mangle-mcp-name').map(parseMangle);
	const holds = new Map<string, number>();
	for (const spec of argValues(args, '--hold')) {
		const [tool, ms] = spec.split('=');
		if (!tool || !Number.isInteger(Number(ms)) || Number(ms) < 0) {
			return undefined;
		}
		holds.set(tool, Number(ms));
	}
	if (mangles.some(m => !m)) {
		return undefined;
	}
	return { listen, upstreamPort, logFile, refuseTunnel: args.includes('--refuse-tunnel'), tls: cert && key ? { cert, key } : undefined, resetLimit, mangles: mangles.filter(m => m !== undefined), holds };
}

function main(args: readonly string[]): void {
	const options = parseOptions(args);
	if (!options) {
		console.error('usage: grpc-log-proxy.ts --listen <port> --upstream <port> --log <file.jsonl> [--refuse-tunnel] [--tls-cert <cert.pem> --tls-key <key.pem>] [--rst-burst <n> --rst-rate <n>] [--mangle-mcp-name <tool>=<value>[:once]]... [--hold <tool>=<ms>]...');
		process.exitCode = 2;
		return;
	}
	const { listen, upstreamPort, logFile } = options;
	const record = (entry: Record<string, unknown>) => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
	const upstreams = new WeakMap<http2.ServerHttp2Session, http2.ClientHttp2Session>();
	let connections = 0;
	let streams = 0;
	/** The relay connection of each loopback port the relay connects to the HTTP/2 server from. */
	const connectionByRelayPort = new Map<number, number>();
	const sessionIds = new WeakMap<http2.ServerHttp2Session, number>();
	const sessionIdOf = (session: http2.ServerHttp2Session): number => {
		let id = sessionIds.get(session);
		if (id === undefined) {
			id = connectionByRelayPort.get(session.socket?.remotePort ?? -1) ?? 0;
			sessionIds.set(session, id);
		}
		return id;
	};

	const upstreamFor = (session: http2.ServerHttp2Session): http2.ClientHttp2Session => {
		let upstream = upstreams.get(session);
		if (!upstream || upstream.closed || upstream.destroyed) {
			upstream = http2.connect(`http://127.0.0.1:${upstreamPort}`);
			upstream.on('error', e => record({ event: 'upstream-error', session: sessionIdOf(session), error: String(e) }));
			upstreams.set(session, upstream);
			session.once('close', () => upstream?.close());
		}
		return upstream;
	};

	// --- The HTTP/2 server that forwards the calls (reached through the relay only) ---------------
	const server = http2.createServer(options.resetLimit ? { streamResetBurst: options.resetLimit.burst, streamResetRate: options.resetLimit.rate } : {});
	server.on('session', session => {
		session.on('error', e => record({ event: 'session-error', session: sessionIdOf(session), error: String(e) }));
	});
	server.on('stream', (down, headers) => {
		const session = sessionIdOf(down.session as http2.ServerHttp2Session);
		const stream = ++streams;
		const h2Stream = down.id;
		const path = String(headers[':path'] ?? '');
		const started = Date.now();
		const metadata: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			// The MCP mirror headers, the routing metadata, the deadline and the Mcp-Param-* values.
			if (value !== undefined && (LOGGED_METADATA.includes(key) || key.startsWith('mcp-param-') || key === 'authorization')) {
				metadata[key] = key === 'authorization' ? String(value).replace(/^(\S+\s+).*$/, '$1***') : String(value);
			}
		}
		const requestChunks: Buffer[] = [];
		/** What the proxy did to the call (`mangled`, `heldMs`). */
		const extraCall: Record<string, unknown> = {};
		let callRecorded = false;
		const recordCall = () => {
			if (!callRecorded) {
				callRecorded = true;
				const body = Buffer.concat(requestChunks);
				record({ event: 'call', session, stream, h2Stream, path, metadata, ...(path === TUNNEL_CALL_PATH ? { jsonRpcMethods: tunnelMethods(body) } : {}), ...extraCall });
			}
		};
		let ended = false;
		const recordEnd = (grpcStatus: unknown, grpcMessage: unknown, extra: Record<string, unknown> = {}) => {
			if (!ended) {
				ended = true;
				recordCall();
				record({ event: 'end', session, stream, h2Stream, path, grpcStatus: grpcStatus === undefined ? undefined : String(grpcStatus), grpcMessage: grpcMessage === undefined ? undefined : String(grpcMessage), ms: Date.now() - started, ...extra });
			}
		};

		if (options.refuseTunnel && path === TUNNEL_CALL_PATH) {
			// A typed-only server: a gRPC answer (HTTP 200, grpc-status of its own) without the
			// tunnel service and without the mcp-error-code a JSON-RPC error of the tunnel carries.
			down.on('data', (chunk: Buffer) => requestChunks.push(chunk));
			down.on('error', () => undefined);
			down.on('end', () => {
				recordCall();
				if (!down.closed && !down.headersSent) {
					const message = 'grpc-log-proxy: unknown service mcp.zig.transport.v1.Mcp';
					down.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': GRPC_UNIMPLEMENTED, 'grpc-message': message }, { endStream: true });
					recordEnd(GRPC_UNIMPLEMENTED, message, { refused: true });
				}
			});
			down.on('close', () => recordEnd(undefined, 'cancelled by the client'));
			return;
		}

		// The rewrites of --mangle-mcp-name and the delays of --hold (by the mirrored tool name).
		const forwardHeaders = withoutPseudoHeaders(headers);
		const toolName = headers['mcp-method'] === 'tools/call' ? String(headers['mcp-name'] ?? headers.mcp_tool ?? '') : '';
		const mangle = options.mangles.find(m => m.tool === toolName && (!m.once || !m.used));
		if (mangle) {
			mangle.used = true;
			forwardHeaders['mcp-name'] = mangle.value;
			extraCall.mangled = { from: toolName, to: mangle.value, once: mangle.once };
		}
		const holdMs = options.holds.get(toolName);
		if (holdMs !== undefined) {
			extraCall.heldMs = holdMs;
		}

		let up: http2.ClientHttp2Stream | undefined;
		let downEnded = false;
		const pending: Buffer[] = [];
		let holdTimer: ReturnType<typeof setTimeout> | undefined;
		down.on('data', (chunk: Buffer) => {
			requestChunks.push(chunk);
			if (up) {
				up.write(chunk);
			} else {
				pending.push(chunk);
			}
		});
		down.on('end', () => {
			recordCall();
			downEnded = true;
			up?.end();
		});
		down.on('error', () => undefined);
		down.on('close', () => {
			clearTimeout(holdTimer);
			if (up && !up.closed) {
				up.close(http2.constants.NGHTTP2_CANCEL);
			}
			recordEnd(undefined, 'cancelled by the client', up ? {} : { cancelledWhileHeld: true });
		});

		const startUpstream = () => {
			if (down.closed || down.destroyed) {
				return;
			}
			const upStream = upstreamFor(down.session as http2.ServerHttp2Session).request({
				...forwardHeaders,
				':method': String(headers[':method'] ?? 'POST'),
				':path': path,
			});
			up = upStream;
			for (const chunk of pending.splice(0)) {
				upStream.write(chunk);
			}
			if (downEnded) {
				upStream.end();
			}
			let trailers: http2.OutgoingHttpHeaders | undefined;
			upStream.on('response', (responseHeaders, flags) => {
				const out = { ...withoutPseudoHeaders(responseHeaders), ':status': responseHeaders[':status'] ?? 200 };
				if (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) {
					// A trailers-only response (an error without messages).
					if (!down.closed) {
						down.respond(out, { endStream: true });
					}
					recordEnd(responseHeaders['grpc-status'], responseHeaders['grpc-message'], mcpErrorOf(responseHeaders));
				} else if (!down.closed) {
					down.respond(out, { waitForTrailers: true });
				}
			});
			upStream.on('data', (chunk: Buffer) => {
				if (!down.closed) {
					down.write(chunk);
				}
			});
			upStream.on('trailers', responseTrailers => {
				trailers = withoutPseudoHeaders(responseTrailers);
			});
			down.on('wantTrailers', () => {
				const final = trailers ?? { 'grpc-status': '13', 'grpc-message': 'grpc-log-proxy: the upstream sent no trailers' };
				down.sendTrailers(final);
				recordEnd(final['grpc-status'], final['grpc-message'], mcpErrorOf(final));
			});
			upStream.on('end', () => {
				if (down.headersSent && !down.writableEnded && !down.closed) {
					down.end();
				}
			});
			upStream.on('error', e => record({ event: 'stream-error', session, stream, path, error: String(e) }));
			upStream.on('close', () => {
				if (!down.closed && !down.writableEnded) {
					if (down.headersSent) {
						down.close(upStream.rstCode ?? http2.constants.NGHTTP2_CANCEL);
					} else {
						down.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '14', 'grpc-message': 'grpc-log-proxy: the upstream closed the stream' }, { endStream: true });
					}
					recordEnd(14, `upstream closed (rst ${upStream.rstCode})`);
				}
			});
		};
		if (holdMs !== undefined) {
			holdTimer = setTimeout(startUpstream, holdMs);
		} else {
			startUpstream();
		}
	});
	server.on('error', e => {
		console.error(`[grpc-log-proxy] ${e}`);
		process.exitCode = 1;
	});

	// --- The front end: relays the bytes and reads the frames ------------------------------------
	const relay = (client: net.Socket, internalPort: number, tlsInfo: Record<string, unknown> | undefined) => {
		const session = ++connections;
		const stats: IConnectionStats = { frames: { fromClient: {}, fromServer: {} }, clientResets: 0, clientResetsAfterEnd: 0, serverResets: 0, serverEnded: new Set(), clientEnded: new Set() };
		record({ event: 'connection', session, phase: 'open', ...(tlsInfo ? { tls: tlsInfo } : {}) });
		const onFrame = (from: 'client' | 'server') => (frame: IHttp2Frame) => {
			const counts = from === 'client' ? stats.frames.fromClient : stats.frames.fromServer;
			const name = frameTypeName(frame.type);
			counts[name] = (counts[name] ?? 0) + 1;
			if ((frame.type === FRAME_HEADERS || frame.type === FRAME_DATA) && frame.flags & FLAG_END_STREAM) {
				(from === 'client' ? stats.clientEnded : stats.serverEnded).add(frame.streamId);
			} else if (frame.type === FRAME_RST_STREAM) {
				const afterEnd = (from === 'client' ? stats.serverEnded : stats.clientEnded).has(frame.streamId);
				if (from === 'client') {
					stats.clientResets++;
					stats.clientResetsAfterEnd += afterEnd ? 1 : 0;
				} else {
					stats.serverResets++;
				}
				record({ event: 'rst', session, stream: frame.streamId, from, errorCode: frame.head.length >= 4 ? frame.head.readUInt32BE(0) : undefined, afterEnd });
			} else if (frame.type === FRAME_GOAWAY) {
				record({ event: 'goaway', session, from, lastStreamId: frame.head.length >= 4 ? frame.head.readUInt32BE(0) & 0x7fffffff : undefined, errorCode: frame.head.length >= 8 ? frame.head.readUInt32BE(4) : undefined });
			}
		};
		const fromClient = new Http2FrameReader(true, onFrame('client'));
		const fromServer = new Http2FrameReader(false, onFrame('server'));
		const inner = net.connect({ host: '127.0.0.1', port: internalPort });
		// Registered before any byte is written: writes wait for 'connect', and this listener runs first.
		inner.once('connect', () => { connectionByRelayPort.set(inner.localPort ?? -1, session); });
		client.on('data', (chunk: Buffer) => {
			fromClient.push(chunk);
			inner.write(chunk);
		});
		inner.on('data', (chunk: Buffer) => {
			fromServer.push(chunk);
			if (!client.destroyed) {
				client.write(chunk);
			}
		});
		client.on('end', () => inner.end());
		inner.on('end', () => client.end());
		client.on('error', () => inner.destroy());
		inner.on('error', () => client.destroy());
		let closed = false;
		const onClose = () => {
			inner.destroy();
			client.destroy();
			if (!closed) {
				closed = true;
				record({ event: 'connection', session, phase: 'close', frames: stats.frames, clientResets: stats.clientResets, clientResetsAfterEnd: stats.clientResetsAfterEnd, serverResets: stats.serverResets });
			}
		};
		client.on('close', onClose);
		inner.on('close', onClose);
	};

	server.listen(0, '127.0.0.1', () => {
		const internalPort = (server.address() as net.AddressInfo).port;
		let front: net.Server;
		if (options.tls) {
			const secure = tls.createServer({ cert: fs.readFileSync(options.tls.cert), key: fs.readFileSync(options.tls.key), ALPNProtocols: ['h2'] });
			secure.on('secureConnection', socket => relay(socket, internalPort, { servername: socket.servername || undefined, alpn: socket.alpnProtocol || undefined }));
			secure.on('tlsClientError', (e, socket) => record({ event: 'tls-error', error: String(e), servername: (socket as tls.TLSSocket).servername || undefined }));
			front = secure;
		} else {
			front = net.createServer(socket => relay(socket, internalPort, undefined));
		}
		front.on('error', e => {
			console.error(`[grpc-log-proxy] ${e}`);
			process.exitCode = 1;
		});
		front.listen(listen, '127.0.0.1', () => {
			console.log(`[grpc-log-proxy] ${options.tls ? 'tls' : 'tcp'} 127.0.0.1:${listen} -> http2 127.0.0.1:${internalPort} -> 127.0.0.1:${upstreamPort}${options.refuseTunnel ? ' (tunnel refused)' : ''}, log ${logFile}`);
			record({ event: 'listening', listen, upstream: upstreamPort, tls: !!options.tls, refuseTunnel: options.refuseTunnel, resetLimit: options.resetLimit ?? 'default (burst 1000, rate 33/s)' });
		});
		if (options.tls) {
			// `localhost` may resolve to ::1 first; listen there too when the host has IPv6.
			const v6 = net.createServer();
			v6.on('error', () => undefined);
			v6.on('connection', socket => front.emit('connection', socket));
			v6.listen(listen, '::1');
		}
	});
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
