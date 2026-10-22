/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { buildMirroredHeaders, MCP_PROTOCOL_VERSION_HEADER } from '../../common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_PROTOCOL_VERSION } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';

/** Test helpers that talk to a real gateway over HTTP (raw `http`, so `Host` and `Origin` can be set). */

export interface IHttpResult {
	readonly status: number;
	readonly headers: http.IncomingHttpHeaders;
	readonly text: string;
}

export interface IHttpRequestOptions {
	readonly method?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string | Buffer;
}

/** One request; resolves with the whole response. */
export async function httpRequest(url: string, options: IHttpRequestOptions = {}): Promise<IHttpResult> {
	const connection = await openHttp(url, options);
	await connection.ended;
	return { status: connection.status, headers: connection.headers, text: connection.text };
}

export function jsonOf(result: IHttpResult): unknown {
	return JSON.parse(result.text);
}

export interface ISseEvent {
	readonly id?: string;
	readonly event?: string;
	readonly retry?: number;
	readonly data: string;
}

/** An open response: its status, the raw text so far and its SSE events as they arrive. */
export class HttpConnection {
	readonly events: ISseEvent[] = [];
	private _text = '';
	private _buffer = '';
	private readonly _waiters: Array<() => void> = [];
	private _done = false;
	readonly ended: Promise<void>;
	private _resolveEnded!: () => void;

	constructor(
		private readonly _req: http.ClientRequest,
		private readonly _res: http.IncomingMessage,
	) {
		this.ended = new Promise<void>(resolve => { this._resolveEnded = resolve; });
		_res.setEncoding('utf8');
		_res.on('data', (chunk: string) => this._onData(chunk));
		const finish = () => {
			if (!this._done) {
				this._done = true;
				this._resolveEnded();
				this._wake();
			}
		};
		_res.on('end', finish);
		_res.on('close', finish);
		_res.on('error', finish);
	}

	get status(): number {
		return this._res.statusCode ?? 0;
	}

	get headers(): http.IncomingHttpHeaders {
		return this._res.headers;
	}

	get contentType(): string {
		return String(this._res.headers['content-type'] ?? '');
	}

	get text(): string {
		return this._text;
	}

	get isDone(): boolean {
		return this._done;
	}

	/** The JSON-RPC messages of the SSE events so far (priming events and comments excluded). */
	get messages(): unknown[] {
		return this.events.filter(e => e.data.trim().length > 0).map(e => JSON.parse(e.data));
	}

	/** Waits for the `index`-th JSON-RPC message of the stream (0-based). */
	async message(index: number, timeoutMs = 5000): Promise<Record<string, unknown>> {
		await this._waitFor(() => this.messages.length > index, timeoutMs, `message #${index}`);
		return this.messages[index] as Record<string, unknown>;
	}

	/** Waits for the first message matching the predicate. */
	async messageWhere(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
		const find = () => (this.messages as Record<string, unknown>[]).find(predicate);
		await this._waitFor(() => find() !== undefined, timeoutMs, 'a matching message');
		return find()!;
	}

	/** Waits for the `index`-th raw SSE event (priming events included). */
	async event(index: number, timeoutMs = 5000): Promise<ISseEvent> {
		await this._waitFor(() => this.events.length > index, timeoutMs, `event #${index}`);
		return this.events[index];
	}

	/** Aborts the request (the client goes away). */
	close(): void {
		this._req.destroy();
		this._res.destroy();
	}

	/** Stops reading the response (a client that does not keep up): the server's writes queue up behind TCP flow control. */
	pause(): void {
		this._res.pause();
	}

	/** Reads the response again after {@link pause}. */
	resume(): void {
		this._res.resume();
	}

	private async _waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!condition()) {
			if (this._done) {
				throw new Error(`The response ended before ${what} arrived (status ${this.status}, text ${JSON.stringify(this._text.substring(0, 500))})`);
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error(`Timed out waiting for ${what} (text so far ${JSON.stringify(this._text.substring(0, 500))})`);
			}
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, remaining);
				this._waiters.push(() => { clearTimeout(timer); resolve(); });
			});
		}
	}

	private _wake(): void {
		for (const waiter of this._waiters.splice(0)) {
			waiter();
		}
	}

	private _onData(chunk: string): void {
		this._text += chunk;
		if (this.contentType.includes('text/event-stream')) {
			this._buffer += chunk;
			let separator: RegExpExecArray | null;
			while ((separator = /\r?\n\r?\n/.exec(this._buffer))) {
				const block = this._buffer.substring(0, separator.index);
				this._buffer = this._buffer.substring(separator.index + separator[0].length);
				const event = parseSseBlock(block);
				if (event) {
					this.events.push(event);
				}
			}
		}
		this._wake();
	}
}

function parseSseBlock(block: string): ISseEvent | undefined {
	let id: string | undefined;
	let event: string | undefined;
	let retry: number | undefined;
	const data: string[] = [];
	let sawField = false;
	for (const line of block.split(/\r?\n/)) {
		if (line.startsWith(':')) {
			continue;
		}
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.substring(0, colon);
		let value = colon === -1 ? '' : line.substring(colon + 1);
		if (value.startsWith(' ')) {
			value = value.substring(1);
		}
		sawField = true;
		switch (field) {
			case 'id': id = value; break;
			case 'event': event = value; break;
			case 'retry': retry = Number(value); break;
			case 'data': data.push(value); break;
		}
	}
	return sawField ? { id, event, retry, data: data.join('\n') } : undefined;
}

/** Sends a request and resolves once the response headers are in (the body streams on). */
export async function openHttp(url: string, options: IHttpRequestOptions = {}): Promise<HttpConnection> {
	const { request } = await import('http');
	const target = new URL(url);
	return new Promise<HttpConnection>((resolve, reject) => {
		const headers: Record<string, string | number> = { ...options.headers };
		if (options.body !== undefined) {
			headers['Content-Length'] = Buffer.byteLength(options.body);
		}
		const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? 'POST', headers, agent: false }, res => {
			resolve(new HttpConnection(req, res));
		});
		req.on('error', reject);
		if (options.body !== undefined) {
			req.write(options.body);
		}
		req.end();
	});
}

export interface IPendingHttp {
	/** Settles with the response once its headers are in; undefined when the request failed or was aborted first. */
	readonly response: Promise<HttpConnection | undefined>;
	/** Drops the connection (the client goes away), also before the response arrived. */
	abort(): void;
}

/** Sends a request without waiting for its response. */
export async function sendHttp(url: string, options: IHttpRequestOptions = {}): Promise<IPendingHttp> {
	const { request } = await import('http');
	const target = new URL(url);
	const headers: Record<string, string | number> = { ...options.headers };
	if (options.body !== undefined) {
		headers['Content-Length'] = Buffer.byteLength(options.body);
	}
	const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? 'POST', headers, agent: false });
	const response = new Promise<HttpConnection | undefined>(resolve => {
		req.on('response', res => resolve(new HttpConnection(req, res)));
		req.on('error', () => resolve(undefined));
		req.on('close', () => resolve(undefined));
	});
	if (options.body !== undefined) {
		req.write(options.body);
	}
	req.end();
	return { response, abort: () => req.destroy() };
}

/** Sends raw bytes on a fresh connection and resolves with everything the server answered until it closed the connection. */
export async function rawHttp(port: number, text: string): Promise<string> {
	const { connect } = await import('net');
	return new Promise<string>((resolve, reject) => {
		const socket = connect(port, '127.0.0.1');
		let data = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => { data += chunk; });
		socket.on('end', () => resolve(data));
		socket.on('error', reject);
		socket.write(text);
	});
}

export const TEST_CLIENT_INFO: MCP.Implementation = { name: 'gateway-test-client', version: '1.0.0' };

/** The `_meta` of a 2026-07-28 request. */
export function modernMeta(clientCapabilities: MCP.ClientCapabilities = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { [META_PROTOCOL_VERSION]: LATEST_MCP_PROTOCOL_VERSION, [META_CLIENT_CAPABILITIES]: clientCapabilities, [META_CLIENT_INFO]: TEST_CLIENT_INFO, ...extra };
}

export interface IModernRequest {
	readonly body: string;
	readonly headers: Record<string, string>;
}

/** A well-formed 2026-07-28 POST: `_meta` in the params and the mirrored headers. */
export function modernRequest(method: string, params: Record<string, unknown> = {}, id: number | string = 1, clientCapabilities: MCP.ClientCapabilities = {}, extraHeaders: Record<string, string> = {}): IModernRequest {
	const fullParams = { ...params, _meta: { ...modernMeta(clientCapabilities), ...(params._meta as Record<string, unknown> | undefined) } };
	return {
		body: JSON.stringify({ jsonrpc: '2.0', id, method, params: fullParams }),
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			[MCP_PROTOCOL_VERSION_HEADER]: LATEST_MCP_PROTOCOL_VERSION,
			...buildMirroredHeaders(method, fullParams),
			...extraHeaders,
		},
	};
}

export const LEGACY_HEADERS: Readonly<Record<string, string>> = {
	'Content-Type': 'application/json',
	'Accept': 'application/json, text/event-stream',
};

/** Headers of a legacy POST in a session. */
export function legacyHeaders(sessionId: string | undefined, protocolVersion = '2025-11-25'): Record<string, string> {
	return sessionId === undefined ? { ...LEGACY_HEADERS } : { ...LEGACY_HEADERS, 'Mcp-Session-Id': sessionId, [MCP_PROTOCOL_VERSION_HEADER]: protocolVersion };
}
