/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A Streamable HTTP proxy in front of an MCP server (the zig-sdk server's /mcp) that records every
// request VS Code sends (HTTP method, the MCP headers, the JSON-RPC methods) and can inject the
// faults of the 2026-07-28 error paths for named tools, because the zig-sdk server never produces
// them for a well-behaved client. Responses are streamed through unchanged unless a fault rewrites
// them (then they are buffered: JSON or SSE).
//
// One JSON line per request in the log:
//   { "event": "request", "n", "httpMethod", "path", "headers": { "mcp-protocol-version", "mcp-method",
//     "mcp-name", "mcp-session-id", "mcp-param-*", "authorization" (scheme only) }, "messages": [{ "method",
//     "id", "name", "cursor", "taskId" }], "status", "contentType", "fault"?, "mutation"?, "bridged"?,
//     "url"?, "requestState"?, "inputResponses"? (input-required-url: the round's URL and state, and what the
//     retry sent back) }
//
// Usage: node runner/http-fault-proxy.ts --listen <port> --upstream <port> --log <file.jsonl>
//            [--fault <spec>]... [--mutate <name>]...
// Faults (each for the tools/call of one tool unless said otherwise):
//   missing-capability:<tool>       HTTP 400 with -32021, data.requiredCapabilities { elicitation: { url: {} } }
//   result-type:<tool>=<value>      the result's resultType replaced with <value> (an unknown one)
//   output-schema-mismatch:<tool>   tools/list gives <tool> an outputSchema { count: integer, required },
//                                   its result gets structuredContent { count: "many" }
//   output-schema-match:<tool>      outputSchema { greeting: string, required }, structuredContent { greeting: <its text> }
//   empty-cursor                    tools/list: the first half of the tools with nextCursor "", and the second
//                                   half (no nextCursor) for the request with cursor ""
//   version-same:<tool>             the first call: HTTP 400 with -32022, data { supported: ["2026-07-28"] }
//   version-legacy:<tool>           the first call: HTTP 400 with -32022, data { supported: ["2025-11-25"] }; from
//                                   then on the proxy answers the 2025-11-25 handshake itself (initialize,
//                                   notifications, logging/setLevel, ping) and forwards the client's 2025-11-25
//                                   requests to the 2026-07-28 upstream with the 2026-07-28 envelope ("bridged")
//   input-required-url:<tool>       every call without inputResponses and requestState: an input_required result
//                                   with one URL-mode elicitation (key "consent", url
//                                   https://url-elicitation.mcp-e2e.test/consent?id=<round>; the 2026-07-28
//                                   URL params have no elicitationId) and a requestState the proxy signs (HTTP 400 with -32021
//                                   when the request's _meta client capabilities lack elicitation.url). The retry:
//                                   with inputResponses.consent accept, forwarded without inputResponses and
//                                   requestState (the upstream issued none), so the tool's own result comes back;
//                                   with decline or cancel, answered "URL elicitation <action>: <tool> was not run";
//                                   with a missing or wrong requestState, or no valid inputResponses.consent,
//                                   HTTP 400 with -32602
// Mutations (runner/mutations.ts; a test must detect each):
//   strip-tasks        removes the Tasks extension from the _meta client capabilities of every request
//   drop-tasks-cancel  answers tasks/cancel with an empty result without forwarding it
//   drop-listen-ack    drops notifications/subscriptions/acknowledged from the listen streams
//   drop-progress      drops notifications/progress from the tools/call answers
//   strip-mcp-param    removes the Mcp-Param-* headers before forwarding (the server sees a mismatch)

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** The request headers the log keeps. */
const LOGGED_HEADERS = ['mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'accept', 'content-type', 'last-event-id'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface IMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: JsonObject;
	result?: JsonObject;
	error?: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argValues(args: readonly string[], name: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === name) {
			out.push(args[i + 1]);
		}
	}
	return out;
}

export interface IFaults {
	readonly missingCapability: Set<string>;
	readonly resultType: Map<string, string>;
	readonly outputSchemaMismatch: Set<string>;
	readonly outputSchemaMatch: Set<string>;
	readonly emptyCursor: boolean;
	readonly versionSame: Set<string>;
	readonly versionLegacy: Set<string>;
	readonly inputRequiredUrl: Set<string>;
}

export function parseFaults(specs: readonly string[]): IFaults {
	const faults: IFaults = { missingCapability: new Set(), resultType: new Map(), outputSchemaMismatch: new Set(), outputSchemaMatch: new Set(), emptyCursor: false, versionSame: new Set(), versionLegacy: new Set(), inputRequiredUrl: new Set() };
	let emptyCursor = false;
	for (const spec of specs) {
		const colon = spec.indexOf(':');
		const kind = colon === -1 ? spec : spec.slice(0, colon);
		const arg = colon === -1 ? '' : spec.slice(colon + 1);
		switch (kind) {
			case 'missing-capability': faults.missingCapability.add(arg); break;
			case 'result-type': {
				const [tool, value] = arg.split('=');
				faults.resultType.set(tool, value);
				break;
			}
			case 'output-schema-mismatch': faults.outputSchemaMismatch.add(arg); break;
			case 'output-schema-match': faults.outputSchemaMatch.add(arg); break;
			case 'empty-cursor': emptyCursor = true; break;
			case 'version-same': faults.versionSame.add(arg); break;
			case 'version-legacy': faults.versionLegacy.add(arg); break;
			case 'input-required-url': faults.inputRequiredUrl.add(arg); break;
			default: throw new Error(`unknown fault ${spec}`);
		}
	}
	return { ...faults, emptyCursor };
}

const MISMATCH_SCHEMA: JsonObject = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] };
const MATCH_SCHEMA: JsonObject = { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] };

/** The URL-mode elicitation of input-required-url: its key in inputRequests and where it points. */
const URL_ELICITATION_KEY = 'consent';
const URL_ELICITATION_ORIGIN = 'https://url-elicitation.mcp-e2e.test';

/** What a requestState of input-required-url carries. */
export interface IUrlRoundState {
	readonly tool: string;
	readonly round: number;
}

/** `<payload>.<HMAC-SHA256 of it>`, both base64url: opaque to the client, verifiable by the proxy. */
export function signRequestState(key: Buffer, state: IUrlRoundState): string {
	const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
	return `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** The state of a requestState that {@link signRequestState} issued with `key`, or `undefined` (wrong, tampered). */
export function verifyRequestState(key: Buffer, requestState: string): IUrlRoundState | undefined {
	const [payload, mac, ...rest] = requestState.split('.');
	if (!payload || !mac || rest.length) {
		return undefined;
	}
	const expected = crypto.createHmac('sha256', key).update(payload).digest();
	const given = Buffer.from(mac, 'base64url');
	if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
		return undefined;
	}
	try {
		const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
		return isObject(state) && typeof state.tool === 'string' && typeof state.round === 'number' ? { tool: state.tool, round: state.round } : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the `_meta` client capabilities of a request declare URL-mode elicitation. */
function declaresUrlElicitation(params: JsonObject | undefined): boolean {
	const caps = isObject(params?._meta) ? params._meta[META_CLIENT_CAPABILITIES] : undefined;
	return isObject(caps) && isObject(caps.elicitation) && caps.elicitation.url !== undefined;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function parseMessages(body: Buffer): IMessage[] {
	if (!body.length) {
		return [];
	}
	try {
		const parsed = JSON.parse(body.toString('utf8')) as unknown;
		return (Array.isArray(parsed) ? parsed : [parsed]).filter(isObject) as IMessage[];
	} catch {
		return [];
	}
}

/** Applies `fn` to every JSON-RPC message of a JSON or SSE body and returns the new body. */
export function rewriteBody(body: string, contentType: string, fn: (message: IMessage) => IMessage): string {
	if (contentType.includes('text/event-stream')) {
		return body.split('\n').map(line => {
			if (!line.startsWith('data:')) {
				return line;
			}
			try {
				return `data: ${JSON.stringify(fn(JSON.parse(line.slice(5).trim()) as IMessage))}`;
			} catch {
				return line;
			}
		}).join('\n');
	}
	try {
		const parsed = JSON.parse(body) as unknown;
		return JSON.stringify(Array.isArray(parsed) ? parsed.map(m => fn(m as IMessage)) : fn(parsed as IMessage));
	} catch {
		return body;
	}
}

function firstText(result: JsonObject | undefined): string {
	const content = result?.content;
	if (Array.isArray(content)) {
		for (const c of content) {
			if (isObject(c) && typeof c.text === 'string') {
				return c.text;
			}
		}
	}
	return '';
}

function jsonRpcError(id: IMessage['id'], code: number, message: string, data?: Json): string {
	return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function main(args: readonly string[]): void {
	const listen = Number(argValues(args, '--listen')[0]);
	const upstreamPort = Number(argValues(args, '--upstream')[0]);
	const logFile = argValues(args, '--log')[0];
	if (!Number.isInteger(listen) || !Number.isInteger(upstreamPort) || !logFile) {
		console.error('usage: http-fault-proxy.ts --listen <port> --upstream <port> --log <file.jsonl> [--fault <spec>]... [--mutate <name>]...');
		process.exitCode = 2;
		return;
	}
	const faults = parseFaults(argValues(args, '--fault'));
	const mutations = new Set(argValues(args, '--mutate'));
	const record = (entry: Record<string, unknown>) => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
	const used = new Set<string>();
	/** After a version-legacy fault: the 2025-11-25 session the proxy serves itself. */
	let bridgeSession: string | undefined;
	let requests = 0;
	/** input-required-url: the key of the requestStates of this process and the rounds asked so far. */
	const stateKey = crypto.randomBytes(32);
	let urlRounds = 0;

	const server = http.createServer(async (req, res) => {
		const n = ++requests;
		const body = await readBody(req);
		let messages = parseMessages(body);
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (value !== undefined && (LOGGED_HEADERS.includes(key) || key.startsWith('mcp-param-'))) {
				headers[key] = Array.isArray(value) ? value.join(', ') : value;
			}
		}
		if (req.headers.authorization) {
			headers.authorization = `${req.headers.authorization.split(' ')[0]} ***`;
		}
		const summary = messages.map(m => ({
			method: m.method ?? '(response)',
			id: m.id,
			...(typeof m.params?.name === 'string' ? { name: m.params.name } : {}),
			...(m.params?.cursor !== undefined ? { cursor: m.params.cursor } : {}),
			...(typeof m.params?.taskId === 'string' ? { taskId: m.params.taskId } : {}),
			...(m.params?.inputResponses !== undefined ? { inputResponses: true } : {}),
		}));
		const entry: Record<string, unknown> = { event: 'request', n, httpMethod: req.method, path: req.url, headers, messages: summary };
		const reply = (status: number, text: string, extra: Record<string, unknown>, replyHeaders: Record<string, string> = {}) => {
			res.writeHead(status, { 'content-type': 'application/json', ...replyHeaders });
			res.end(text);
			record({ ...entry, status, contentType: 'application/json', ...extra });
		};
		const single = messages.length === 1 ? messages[0] : undefined;
		const tool = single?.method === 'tools/call' && typeof single.params?.name === 'string' ? single.params.name : undefined;

		// --- The 2025-11-25 bridge after a version-legacy fault -------------------------------------
		const legacyRequest = bridgeSession !== undefined && req.headers['mcp-protocol-version'] !== MODERN && (req.headers['mcp-protocol-version'] === LEGACY || single?.method === 'initialize' || req.headers['mcp-session-id'] !== undefined);
		if (legacyRequest || (bridgeSession !== undefined && single?.method === 'initialize')) {
			if (req.method === 'GET') {
				reply(405, '', { bridged: 'no GET stream' });
				return;
			}
			if (req.method === 'DELETE') {
				reply(200, '', { bridged: 'session closed' });
				return;
			}
			if (single?.method === 'initialize') {
				const result = { protocolVersion: LEGACY, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'http-fault-proxy 2025-11-25 bridge', version: '1.0.0' } };
				reply(200, JSON.stringify({ jsonrpc: '2.0', id: single.id ?? null, result }), { bridged: 'initialize' }, { 'mcp-session-id': bridgeSession! });
				return;
			}
			if (single && single.id === undefined) {
				res.writeHead(202);
				res.end();
				record({ ...entry, status: 202, bridged: 'notification' });
				return;
			}
			if (single?.method === 'logging/setLevel' || single?.method === 'ping') {
				reply(200, JSON.stringify({ jsonrpc: '2.0', id: single.id ?? null, result: {} }), { bridged: single.method });
				return;
			}
			if (single) {
				// A 2025-11-25 request: the 2026-07-28 envelope for the upstream.
				const params: JsonObject = { ...(single.params ?? {}) };
				params._meta = { ...(isObject(params._meta) ? params._meta : {}), [META_PROTOCOL_VERSION]: MODERN, [META_CLIENT_CAPABILITIES]: {}, [META_CLIENT_INFO]: { name: 'http-fault-proxy bridge', version: '1.0.0' } };
				const modernHeaders: Record<string, string> = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'mcp-protocol-version': MODERN, 'mcp-method': single.method ?? '' };
				if (typeof params.name === 'string') {
					modernHeaders['mcp-name'] = params.name;
				}
				forward(JSON.stringify({ ...single, params }), modernHeaders, res, { ...entry, bridged: 'forwarded as 2026-07-28' }, undefined);
				return;
			}
		}

		// --- Faults ----------------------------------------------------------------------------------
		if (tool && faults.missingCapability.has(tool)) {
			reply(400, jsonRpcError(single!.id, -32021, 'The request needs a client capability that the client did not declare', { requiredCapabilities: { elicitation: { url: {} } } }), { fault: `missing-capability:${tool}` });
			return;
		}
		if (tool && faults.versionSame.has(tool) && !used.has(`version-same:${tool}`)) {
			used.add(`version-same:${tool}`);
			reply(400, jsonRpcError(single!.id, -32022, 'Unsupported protocol version', { supported: [MODERN], requested: MODERN }), { fault: `version-same:${tool}` });
			return;
		}
		if (tool && faults.versionLegacy.has(tool) && !used.has(`version-legacy:${tool}`)) {
			used.add(`version-legacy:${tool}`);
			bridgeSession = crypto.randomUUID();
			reply(400, jsonRpcError(single!.id, -32022, 'Unsupported protocol version', { supported: [LEGACY], requested: MODERN }), { fault: `version-legacy:${tool}` });
			return;
		}
		let forwardBody: string | Buffer = body;
		if (tool && faults.inputRequiredUrl.has(tool)) {
			const params = single!.params ?? {};
			const fault = `input-required-url:${tool}`;
			if (params.inputResponses === undefined && params.requestState === undefined) {
				// A server asks for a URL only when the request's client capabilities declare URL-mode elicitation.
				if (!declaresUrlElicitation(params)) {
					reply(400, jsonRpcError(single!.id, -32021, 'The request needs a client capability that the client did not declare', { requiredCapabilities: { elicitation: { url: {} } } }), { fault: `${fault} (-32021: no elicitation.url)` });
					return;
				}
				const round = ++urlRounds;
				const url = `${URL_ELICITATION_ORIGIN}/consent?id=${round}`;
				const requestState = signRequestState(stateKey, { tool, round });
				const elicitation = { mode: 'url', message: `MCP E2E URL elicitation: consent for ${tool} (round ${round})`, url };
				const result = { resultType: 'input_required', inputRequests: { [URL_ELICITATION_KEY]: { method: 'elicitation/create', params: elicitation } }, requestState };
				reply(200, JSON.stringify({ jsonrpc: '2.0', id: single!.id ?? null, result }), { fault, url, requestState });
				return;
			}
			// The retry: what it sent back is recorded, whatever the outcome.
			const sent = { requestState: params.requestState ?? null, inputResponses: params.inputResponses ?? null };
			const state = typeof params.requestState === 'string' ? verifyRequestState(stateKey, params.requestState) : undefined;
			if (state?.tool !== tool) {
				reply(400, jsonRpcError(single!.id, -32602, 'Invalid params: the requestState is missing or was not issued for this tool', { reason: 'invalid_request_state' }), { fault: `${fault} (retry refused: requestState)`, ...sent });
				return;
			}
			const answer = isObject(params.inputResponses) ? params.inputResponses[URL_ELICITATION_KEY] : undefined;
			const action = isObject(answer) ? answer.action : undefined;
			if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
				reply(400, jsonRpcError(single!.id, -32602, `Invalid params: inputResponses.${URL_ELICITATION_KEY} is missing or has no valid action`, { reason: 'invalid_input_responses' }), { fault: `${fault} (retry refused: inputResponses)`, round: state.round, ...sent });
				return;
			}
			if (action !== 'accept') {
				const result = { resultType: 'complete', content: [{ type: 'text', text: `URL elicitation ${action}: ${tool} was not run` }] };
				reply(200, JSON.stringify({ jsonrpc: '2.0', id: single!.id ?? null, result }), { fault: `${fault} (retry ${action}: answered)`, round: state.round, ...sent });
				return;
			}
			// Accepted: the tool's own call, as the upstream (which issued no requestState) expects it.
			const { inputResponses: _responses, requestState: _state, ...upstreamParams } = params;
			messages = [{ ...single!, params: upstreamParams }];
			forwardBody = JSON.stringify(messages[0]);
			Object.assign(entry, { fault: `${fault} (retry accept: forwarded)`, round: state.round, ...sent });
		}

		// --- Mutations ---------------------------------------------------------------------------------
		if (mutations.has('drop-tasks-cancel') && single?.method === 'tasks/cancel') {
			reply(200, JSON.stringify({ jsonrpc: '2.0', id: single.id ?? null, result: { resultType: 'complete' } }), { mutation: 'drop-tasks-cancel' });
			return;
		}
		if (mutations.has('strip-tasks')) {
			let stripped = false;
			messages = messages.map(m => {
				const caps = isObject(m.params?._meta) ? m.params._meta[META_CLIENT_CAPABILITIES] : undefined;
				if (isObject(caps) && isObject(caps.extensions) && caps.extensions[TASKS_EXTENSION] !== undefined) {
					const { [TASKS_EXTENSION]: _removed, ...rest } = caps.extensions;
					stripped = true;
					return { ...m, params: { ...m.params, _meta: { ...(m.params!._meta as JsonObject), [META_CLIENT_CAPABILITIES]: { ...caps, extensions: rest } } } };
				}
				return m;
			});
			if (stripped) {
				forwardBody = JSON.stringify(messages.length === 1 ? messages[0] : messages);
				entry.mutation = 'strip-tasks';
			}
		}

		// --- Rewrites of the answer ------------------------------------------------------------------
		let rewrite: ((message: IMessage) => IMessage) | undefined;
		if (single?.method === 'tools/list' && (faults.emptyCursor || faults.outputSchemaMismatch.size || faults.outputSchemaMatch.size)) {
			const secondPage = faults.emptyCursor && single.params?.cursor === '';
			if (secondPage) {
				// The upstream has one page: ask it without the cursor and answer with the second half.
				const { cursor: _cursor, ...params } = single.params!;
				forwardBody = JSON.stringify({ ...single, params });
			}
			rewrite = m => {
				if (m.id !== single.id || !isObject(m.result) || !Array.isArray(m.result.tools)) {
					return m;
				}
				let tools = m.result.tools.map(t => {
					if (!isObject(t) || typeof t.name !== 'string') {
						return t;
					}
					if (faults.outputSchemaMismatch.has(t.name)) {
						return { ...t, outputSchema: MISMATCH_SCHEMA };
					}
					if (faults.outputSchemaMatch.has(t.name)) {
						return { ...t, outputSchema: MATCH_SCHEMA };
					}
					return t;
				});
				const result: JsonObject = { ...m.result };
				if (faults.emptyCursor) {
					const half = Math.ceil(tools.length / 2);
					tools = secondPage ? tools.slice(half) : tools.slice(0, half);
					if (secondPage) {
						delete result.nextCursor;
					} else {
						result.nextCursor = '';
					}
				}
				return { ...m, result: { ...result, tools } };
			};
			entry.fault = faults.emptyCursor ? (secondPage ? 'empty-cursor (second page)' : 'empty-cursor (first page)') : 'output-schema (tools/list)';
		} else if (tool && (faults.resultType.has(tool) || faults.outputSchemaMismatch.has(tool) || faults.outputSchemaMatch.has(tool))) {
			rewrite = (m): IMessage => {
				if (m.id !== single!.id || !isObject(m.result)) {
					return m;
				}
				let structuredContent: JsonObject;
				if (faults.resultType.has(tool)) {
					return { ...m, result: { ...m.result, resultType: faults.resultType.get(tool)! } };
				} else if (faults.outputSchemaMismatch.has(tool)) {
					structuredContent = { count: 'many' };
				} else {
					structuredContent = { greeting: firstText(m.result) };
				}
				return { ...m, result: { ...m.result, structuredContent } };
			};
			entry.fault = faults.resultType.has(tool) ? `result-type:${tool}` : faults.outputSchemaMismatch.has(tool) ? `output-schema-mismatch:${tool}` : `output-schema-match:${tool}`;
		}
		const forwardHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (value !== undefined && key !== 'host' && key !== 'connection' && key !== 'content-length') {
				if (mutations.has('strip-mcp-param') && key.startsWith('mcp-param-')) {
					entry.mutation = 'strip-mcp-param';
					continue;
				}
				forwardHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
			}
		}
		// Mutations that drop server messages from a streamed (SSE) answer.
		let drop: ((message: IMessage) => boolean) | undefined;
		if (mutations.has('drop-listen-ack') && single?.method === 'subscriptions/listen') {
			drop = m => m.method === 'notifications/subscriptions/acknowledged';
			entry.mutation = 'drop-listen-ack';
		} else if (mutations.has('drop-progress') && single?.method === 'tools/call') {
			drop = m => m.method === 'notifications/progress';
			entry.mutation = 'drop-progress';
		}
		forward(forwardBody, forwardHeaders, res, entry, rewrite, req.method, drop);
	});

	const forward = (body: string | Buffer, headers: Record<string, string>, res: http.ServerResponse, entry: Record<string, unknown>, rewrite: ((message: IMessage) => IMessage) | undefined, method = 'POST', drop?: (message: IMessage) => boolean) => {
		const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
		const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: '/mcp', method, headers: { ...headers, ...(payload.length || method === 'POST' ? { 'content-length': String(payload.length) } : {}) } }, upRes => {
			const contentType = String(upRes.headers['content-type'] ?? '');
			const outHeaders: http.OutgoingHttpHeaders = {};
			for (const [key, value] of Object.entries(upRes.headers)) {
				if (key !== 'connection' && key !== 'transfer-encoding' && key !== 'content-length' && value !== undefined) {
					outHeaders[key] = value;
				}
			}
			record({ ...entry, status: upRes.statusCode, contentType });
			if (drop && contentType.includes('text/event-stream')) {
				// Event by event (the stream may stay open): drop the events whose message `drop` names.
				res.writeHead(upRes.statusCode ?? 502, outHeaders);
				let buffer = '';
				const flush = (final: boolean) => {
					const events = buffer.split('\n\n');
					buffer = final ? '' : events.pop() ?? '';
					for (const event of events) {
						if (!event) {
							continue;
						}
						const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
						let dropped = false;
						try {
							dropped = !!data && drop(JSON.parse(data) as IMessage);
						} catch {
							// not JSON: keep it
						}
						if (dropped) {
							record({ event: 'dropped', n: entry.n, message: data.slice(0, 300) });
						} else {
							res.write(`${event}\n\n`);
						}
					}
				};
				upRes.setEncoding('utf8');
				upRes.on('data', (chunk: string) => {
					buffer += chunk.replace(/\r\n/g, '\n');
					flush(false);
				});
				upRes.on('end', () => {
					flush(true);
					res.end();
				});
				return;
			}
			if (!rewrite) {
				res.writeHead(upRes.statusCode ?? 502, outHeaders);
				upRes.pipe(res);
				return;
			}
			const chunks: Buffer[] = [];
			upRes.on('data', (c: Buffer) => chunks.push(c));
			upRes.on('end', () => {
				const text = rewriteBody(Buffer.concat(chunks).toString('utf8'), contentType, rewrite);
				res.writeHead(upRes.statusCode ?? 502, { ...outHeaders, 'content-length': String(Buffer.byteLength(text)) });
				res.end(text);
			});
		});
		up.on('error', e => {
			record({ ...entry, status: 502, error: String(e) });
			if (!res.headersSent) {
				res.writeHead(502, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: String(e) }));
			} else {
				res.destroy();
			}
		});
		res.on('close', () => up.destroy());
		up.end(payload);
	};

	server.listen(listen, '127.0.0.1', () => {
		console.log(`[http-fault-proxy] http://127.0.0.1:${listen}/mcp -> http://127.0.0.1:${upstreamPort}/mcp, faults ${JSON.stringify(argValues(args, '--fault'))}, mutations ${JSON.stringify([...mutations])}, log ${logFile}`);
		record({ event: 'listening', listen, upstream: upstreamPort, faults: argValues(args, '--fault'), mutations: [...mutations] });
	});
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
