/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as http2 from 'http2';

/**
 * Minimal MCP clients for the gateway checks: a 2026-07-28 client (raw
 * `fetch`, per-request `_meta`, mirrored headers), a 2025-11-25 client
 * (`initialize` session) and a gRPC client of the JSON-RPC tunnel service.
 */

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';

export interface IJsonRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id?: number | string | null;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
	readonly method?: string;
	readonly params?: unknown;
}

export interface IHttpExchange {
	readonly status: number;
	readonly contentType: string;
	readonly headers: Record<string, string>;
	/** The JSON-RPC messages of the body (one for JSON, every `data:` event for SSE). */
	readonly messages: readonly IJsonRpcResponse[];
	/** The final response to the request id (the last message with an id). */
	readonly response: IJsonRpcResponse | undefined;
}

const CLIENT_INFO = { name: 'mcp-e2e-gateway-client', version: '0.0.1' };

function parseBody(contentType: string, body: string): IJsonRpcResponse[] {
	if (contentType.includes('text/event-stream')) {
		const out: IJsonRpcResponse[] = [];
		for (const event of body.split(/\r?\n\r?\n/)) {
			const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
			if (data) {
				try {
					out.push(JSON.parse(data) as IJsonRpcResponse);
				} catch {
					// keep-alive or a non-JSON event
				}
			}
		}
		return out;
	}
	if (!body.trim()) {
		return [];
	}
	const parsed = JSON.parse(body) as IJsonRpcResponse | IJsonRpcResponse[];
	return Array.isArray(parsed) ? parsed : [parsed];
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<IHttpExchange> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	const contentType = res.headers.get('content-type') ?? '';
	const messages = parseBody(contentType, text);
	const outHeaders: Record<string, string> = {};
	res.headers.forEach((value, key) => { outHeaders[key] = value; });
	const withId = messages.filter(m => m.id !== undefined && m.method === undefined);
	return { status: res.status, contentType, headers: outHeaders, messages, response: withId.at(-1) };
}

function modernMeta(clientCapabilities: Record<string, unknown> = {}, clientInfo: { name: string; version: string } = CLIENT_INFO): Record<string, unknown> {
	return {
		'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
		'io.modelcontextprotocol/clientCapabilities': clientCapabilities,
		'io.modelcontextprotocol/clientInfo': clientInfo,
	};
}

export interface IModernRequestOptions {
	/** The `_meta` client capabilities (default none), e.g. `{ extensions: { 'io.modelcontextprotocol/tasks': {} } }`. */
	readonly clientCapabilities?: Record<string, unknown>;
	/** The `_meta` client info (the gateway's rate limits are per client). */
	readonly clientInfo?: { readonly name: string; readonly version: string };
	/** Headers that replace the mirrored ones (e.g. a wrong `mcp-name`). */
	readonly headers?: Record<string, string>;
}

/** The name the 2026-07-28 `Mcp-Name` header mirrors for a request (tool, prompt or resource). */
function mirroredName(method: string, params: Record<string, unknown>): string | undefined {
	switch (method) {
		case 'tools/call':
		case 'prompts/get':
			return typeof params.name === 'string' ? params.name : undefined;
		case 'resources/read':
			return typeof params.uri === 'string' ? params.uri : undefined;
		case 'tasks/get':
		case 'tasks/update':
		case 'tasks/cancel':
			return typeof params.taskId === 'string' ? params.taskId : undefined;
		default:
			return undefined;
	}
}

let nextId = 1;

/** One stateless 2026-07-28 request: `_meta` in the body, `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers. */
export async function modernRequest(url: string, method: string, params: Record<string, unknown> = {}, options: IModernRequestOptions = {}): Promise<IHttpExchange> {
	const headers: Record<string, string> = { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method };
	const name = mirroredName(method, params);
	if (name !== undefined) {
		headers['mcp-name'] = name;
	}
	const clientInfo = options.clientInfo ? { name: options.clientInfo.name, version: options.clientInfo.version } : CLIENT_INFO;
	return post(url, { ...headers, ...options.headers }, { jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: modernMeta(options.clientCapabilities, clientInfo) } });
}

export interface IRawHttpResponse {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: string;
	/** The body as one JSON-RPC message, when it is one. */
	readonly message: IJsonRpcResponse | undefined;
}

/**
 * One 2026-07-28 POST through node:http, which (unlike fetch) sends any `Host` and `Origin`: for
 * the gateway's DNS-rebinding checks.
 */
export function rawModernPost(url: string, method: string, params: Record<string, unknown>, headers: Record<string, string>): Promise<IRawHttpResponse> {
	const target = new URL(url);
	const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: modernMeta() } });
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: target.hostname, port: target.port, path: target.pathname, method: 'POST',
			headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method, 'content-length': String(Buffer.byteLength(body)), ...headers },
		}, res => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8');
				let message: IJsonRpcResponse | undefined;
				try {
					message = parseBody(String(res.headers['content-type'] ?? ''), text).at(-1);
				} catch {
					message = undefined;
				}
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, message });
			});
			res.on('error', reject);
		});
		req.on('error', reject);
		req.setTimeout(30_000, () => req.destroy(new Error(`${method} to ${url} timed out`)));
		req.end(body);
	});
}

/** A 2026-07-28 `subscriptions/listen` stream read as its SSE events arrive. */
export interface IListenStream {
	readonly requestId: number;
	readonly status: Promise<number>;
	/** Every JSON-RPC message the stream delivered so far. */
	readonly messages: IJsonRpcResponse[];
	close(): void;
}

export function openListenStream(url: string, notifications: Record<string, unknown>): IListenStream {
	const target = new URL(url);
	const requestId = nextId++;
	const body = JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'subscriptions/listen', params: { notifications, _meta: modernMeta() } });
	const messages: IJsonRpcResponse[] = [];
	let resolveStatus: (status: number) => void = () => undefined;
	const status = new Promise<number>(r => { resolveStatus = r; });
	const req = http.request({
		host: target.hostname, port: target.port, path: target.pathname, method: 'POST',
		headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'subscriptions/listen', 'content-length': String(Buffer.byteLength(body)) },
	}, res => {
		resolveStatus(res.statusCode ?? 0);
		res.setEncoding('utf8');
		let buffer = '';
		res.on('data', (chunk: string) => {
			buffer += chunk.replace(/\r\n/g, '\n');
			const events = buffer.split('\n\n');
			buffer = events.pop() ?? '';
			for (const event of events) {
				const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
				if (data) {
					try {
						messages.push(JSON.parse(data) as IJsonRpcResponse);
					} catch {
						// not JSON
					}
				}
			}
		});
		res.on('error', () => undefined);
	});
	req.on('error', () => resolveStatus(0));
	req.end(body);
	return { requestId, status, messages, close: () => req.destroy() };
}

/** A 2025-11-25 session: `initialize`, `notifications/initialized`, then requests with `Mcp-Session-Id`. */
export class LegacySession {
	private _sessionId: string | undefined;
	public initializeResult: Record<string, unknown> | undefined;

	constructor(private readonly _url: string) { }

	private _headers(): Record<string, string> {
		const headers: Record<string, string> = { 'mcp-protocol-version': LEGACY_VERSION };
		if (this._sessionId) {
			headers['mcp-session-id'] = this._sessionId;
		}
		return headers;
	}

	async initialize(): Promise<IHttpExchange> {
		const exchange = await post(this._url, {}, {
			jsonrpc: '2.0', id: nextId++, method: 'initialize',
			params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		});
		this._sessionId = exchange.headers['mcp-session-id'];
		this.initializeResult = exchange.response?.result;
		if (exchange.response?.result) {
			await post(this._url, this._headers(), { jsonrpc: '2.0', method: 'notifications/initialized' });
		}
		return exchange;
	}

	get sessionId(): string | undefined {
		return this._sessionId;
	}

	request(method: string, params: Record<string, unknown> = {}): Promise<IHttpExchange> {
		return post(this._url, this._headers(), { jsonrpc: '2.0', id: nextId++, method, params });
	}

	async close(): Promise<void> {
		if (this._sessionId) {
			await fetch(this._url, { method: 'DELETE', headers: this._headers() }).catch(() => undefined);
		}
	}
}

// --- gRPC: the zig-sdk JSON-RPC tunnel, /mcp.zig.transport.v1.Mcp/Call ---------------------------

function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	let v = value;
	while (v > 0x7f) {
		bytes.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	bytes.push(v);
	return Buffer.from(bytes);
}

/** `JsonRpcMessage { bytes jsonrpc = 1; }` in a gRPC length-prefixed frame. */
export function encodeTunnelFrame(json: string): Buffer {
	const payload = Buffer.from(json, 'utf8');
	const message = Buffer.concat([Buffer.from([0x0a]), encodeVarint(payload.length), payload]);
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(message.length, 1);
	return Buffer.concat([header, message]);
}

/** Decodes every `JsonRpcMessage` of a gRPC response body. */
export function decodeTunnelFrames(body: Buffer): string[] {
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
				out.push(message.subarray(i, i + len).toString('utf8'));
			}
			i += len;
		}
	}
	return out;
}

export interface IGrpcExchange {
	readonly httpStatus: number;
	readonly grpcStatus: string | undefined;
	readonly grpcMessage: string | undefined;
	readonly messages: readonly IJsonRpcResponse[];
}

export interface IGrpcTunnelCallOptions {
	readonly timeoutMs?: number;
	/** Send the route id of the address as the `mcp-gateway-route` metadata (default true). */
	readonly sendRoute?: boolean;
}

/**
 * One unary-request/server-streaming `Call` of the tunnel with a 2026-07-28 request. The gateway
 * serves every server on one listener, `grpc://127.0.0.1:<port>/<routeId>`, and routes a call by
 * the `mcp-gateway-route` metadata: the last path segment of the address.
 */
export function grpcTunnelCall(address: string, method: string, params: Record<string, unknown> = {}, options: IGrpcTunnelCallOptions = {}): Promise<IGrpcExchange> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const url = new URL(address);
	const authority = `http://${url.hostname}:${url.port}`;
	const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: modernMeta() } });
	return new Promise((resolve, reject) => {
		const session = http2.connect(authority);
		const timer = setTimeout(() => { session.destroy(); reject(new Error(`gRPC Call ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
		session.on('error', e => { clearTimeout(timer); reject(e); });
		const headers: http2.OutgoingHttpHeaders = {
			':method': 'POST',
			':path': '/mcp.zig.transport.v1.Mcp/Call',
			'content-type': 'application/grpc+proto',
			'te': 'trailers',
			'mcp-protocol-version': MODERN_VERSION,
			'mcp-method': method,
		};
		const name = mirroredName(method, params);
		if (name !== undefined) {
			headers['mcp-name'] = name;
		}
		const route = url.pathname.split('/').filter(Boolean).at(-1);
		if (route && options.sendRoute !== false) {
			headers['mcp-gateway-route'] = route;
		}
		const stream = session.request(headers);
		const chunks: Buffer[] = [];
		let httpStatus = 0;
		let grpcStatus: string | undefined;
		let grpcMessage: string | undefined;
		stream.on('response', h => {
			httpStatus = Number(h[':status']);
			grpcStatus ??= h['grpc-status'] as string | undefined;
			grpcMessage ??= h['grpc-message'] as string | undefined;
		});
		stream.on('trailers', h => {
			grpcStatus = h['grpc-status'] as string | undefined;
			grpcMessage = h['grpc-message'] as string | undefined;
		});
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', e => { clearTimeout(timer); session.close(); reject(e); });
		stream.on('end', () => {
			clearTimeout(timer);
			session.close();
			try {
				const messages = decodeTunnelFrames(Buffer.concat(chunks)).map(m => JSON.parse(m) as IJsonRpcResponse);
				resolve({ httpStatus, grpcStatus, grpcMessage, messages });
			} catch (e) {
				reject(e);
			}
		});
		stream.end(encodeTunnelFrame(body));
	});
}

// --- gRPC: the typed service model_context_protocol.Mcp -------------------------------------------
//
// A hand-written protobuf encoder/decoder for the two RPCs the gateway check needs (the repo's
// descriptors are product code the extension cannot import). Field numbers from mcp_messages.proto
// (src/vs/platform/mcp/common/mcpGrpcProto.ts): CallToolRequest { RequestFields common = 1;
// Request request = 2 { string name = 1; Struct arguments = 2; } }, ListToolsRequest { common = 1 },
// ListToolsResponse { ResponseFields common = 1; repeated Tool tools = 2 { string name = 1; } },
// CallToolResponse { common = 1; repeated Content content = 2 { TextContent text = 1 { string text = 1; } };
// Struct structured_content = 3; bool is_error = 4; }.

export const TYPED_PATH_PREFIX = '/model_context_protocol.Mcp/';

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

/** A length-delimited field (string, bytes or an embedded message). */
export function protoField(field: number, value: string | Buffer): Buffer {
	const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
	return Buffer.concat([encodeVarint(field * 8 + WIRE_LENGTH_DELIMITED), encodeVarint(bytes.length), bytes]);
}

/** The fields of one protobuf message: field number -> values (numbers for varints, bytes otherwise). */
export function decodeProto(message: Buffer): Map<number, (number | Buffer)[]> {
	const fields = new Map<number, (number | Buffer)[]>();
	let i = 0;
	const varint = () => {
		let value = 0;
		let shift = 0;
		let b: number;
		do {
			if (i >= message.length) {
				throw new Error('truncated varint');
			}
			b = message[i++];
			value += (b & 0x7f) * Math.pow(2, shift);
			shift += 7;
		} while (b & 0x80);
		return value;
	};
	while (i < message.length) {
		const key = varint();
		const field = Math.floor(key / 8);
		const wire = key % 8;
		let value: number | Buffer;
		if (wire === WIRE_VARINT) {
			value = varint();
		} else if (wire === WIRE_LENGTH_DELIMITED) {
			const length = varint();
			value = message.subarray(i, i + length);
			i += length;
		} else if (wire === 1) {
			value = message.subarray(i, i + 8);
			i += 8;
		} else if (wire === 5) {
			value = message.subarray(i, i + 4);
			i += 4;
		} else {
			throw new Error(`unsupported wire type ${wire}`);
		}
		const list = fields.get(field) ?? [];
		list.push(value);
		fields.set(field, list);
	}
	return fields;
}

function bytesFields(fields: Map<number, (number | Buffer)[]>, field: number): Buffer[] {
	return (fields.get(field) ?? []).filter((v): v is Buffer => Buffer.isBuffer(v));
}

/** `CallToolRequest` for a tool without arguments. */
export function encodeCallToolRequest(name: string): Buffer {
	return protoField(2, protoField(1, name));
}

/** The tool names of a `ListToolsResponse`. */
export function decodeListToolsResponse(message: Buffer): string[] {
	return bytesFields(decodeProto(message), 2).map(tool => bytesFields(decodeProto(tool), 1)[0]?.toString('utf8') ?? '');
}

/** The text parts and `is_error` of a `CallToolResponse`. */
export function decodeCallToolResponse(message: Buffer): { readonly texts: string[]; readonly isError: boolean } {
	const fields = decodeProto(message);
	const texts: string[] = [];
	for (const content of bytesFields(fields, 2)) {
		for (const text of bytesFields(decodeProto(content), 1)) {
			texts.push(...bytesFields(decodeProto(text), 1).map(b => b.toString('utf8')));
		}
	}
	return { texts, isError: (fields.get(4) ?? []).some(v => v === 1) };
}

/** The messages of a gRPC response body (length-prefixed frames). */
export function decodeGrpcFrames(body: Buffer): Buffer[] {
	const out: Buffer[] = [];
	let offset = 0;
	while (offset + 5 <= body.length) {
		const length = body.readUInt32BE(offset + 1);
		out.push(body.subarray(offset + 5, offset + 5 + length));
		offset += 5 + length;
	}
	return out;
}

export interface IGrpcUnaryExchange {
	readonly httpStatus: number;
	readonly grpcStatus: string | undefined;
	readonly grpcMessage: string | undefined;
	/** The trailers (or the headers of a trailers-only response), without pseudo-headers. */
	readonly trailers: Record<string, string>;
	readonly messages: readonly Buffer[];
}

export interface IGrpcUnaryOptions {
	readonly timeoutMs?: number;
	/** Send the route id of the address as the `mcp-gateway-route` metadata (default true). */
	readonly sendRoute?: boolean;
	readonly metadata?: Record<string, string>;
}

/** One unary call of `path` with a protobuf request message; resolves with the status and the response messages. */
export function grpcUnaryCall(address: string, path: string, request: Buffer, options: IGrpcUnaryOptions = {}): Promise<IGrpcUnaryExchange> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const url = new URL(address);
	return new Promise((resolve, reject) => {
		const session = http2.connect(`http://${url.hostname}:${url.port}`);
		const timer = setTimeout(() => { session.destroy(); reject(new Error(`gRPC ${path} timed out after ${timeoutMs}ms`)); }, timeoutMs);
		session.on('error', e => { clearTimeout(timer); reject(e); });
		const headers: http2.OutgoingHttpHeaders = {
			':method': 'POST',
			':path': path,
			'content-type': 'application/grpc+proto',
			'te': 'trailers',
			'mcp-protocol-version': MODERN_VERSION,
			...options.metadata,
		};
		const route = url.pathname.split('/').filter(Boolean).at(-1);
		if (route && options.sendRoute !== false) {
			headers['mcp-gateway-route'] = route;
		}
		const stream = session.request(headers);
		const chunks: Buffer[] = [];
		let httpStatus = 0;
		const trailers: Record<string, string> = {};
		const keep = (h: http2.IncomingHttpHeaders) => {
			for (const [key, value] of Object.entries(h)) {
				if (!key.startsWith(':') && value !== undefined) {
					trailers[key] = Array.isArray(value) ? value.join(', ') : String(value);
				}
			}
		};
		stream.on('response', h => {
			httpStatus = Number(h[':status']);
			if (h['grpc-status'] !== undefined) {
				keep(h);
			}
		});
		stream.on('trailers', keep);
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', e => { clearTimeout(timer); session.close(); reject(e); });
		stream.on('end', () => {
			clearTimeout(timer);
			session.close();
			resolve({ httpStatus, grpcStatus: trailers['grpc-status'], grpcMessage: trailers['grpc-message'], trailers, messages: decodeGrpcFrames(Buffer.concat(chunks)) });
		});
		const header = Buffer.alloc(5);
		header.writeUInt32BE(request.length, 1);
		stream.end(Buffer.concat([header, request]));
	});
}
