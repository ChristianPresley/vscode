/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Readers of what the run recorded about the MCP traffic: the MCP server log of
 * VS Code (`mcpServer.<id>.log`, which carries every JSON-RPC message at
 * `--log debug`) and the wire log of `runner/grpc-log-proxy.ts` (the gRPC calls
 * that reached a server).
 */

export interface ILoggedJsonRpc {
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
	readonly result?: Record<string, unknown>;
	readonly error?: unknown;
}

export interface ILoggedMessage {
	/** `sent`: an `[editor -> server]` line; `received`: a `[server -> editor]` line. */
	readonly direction: 'sent' | 'received';
	readonly message: ILoggedJsonRpc;
	/** The offset of the message in the log text. */
	readonly offset: number;
}

const LOGGED_MESSAGE = /\[(editor -> server|server -> editor)\] (\{.*\})$/gm;
export const SUBSCRIPTION_ID_META = 'io.modelcontextprotocol/subscriptionId';
export const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
/** The extension id of the Tasks extension (SEP-2663) in `capabilities.extensions`. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** The JSON-RPC messages of an MCP server log, in order, from `fromOffset` on. */
export function loggedMessages(logText: string, fromOffset = 0): ILoggedMessage[] {
	const out: ILoggedMessage[] = [];
	for (const m of logText.matchAll(LOGGED_MESSAGE)) {
		if (m.index < fromOffset) {
			continue;
		}
		try {
			out.push({ direction: m[1] === 'editor -> server' ? 'sent' : 'received', message: JSON.parse(m[2]) as ILoggedJsonRpc, offset: m.index });
		} catch {
			// a line that is not one JSON object
		}
	}
	return out;
}

/** The methods VS Code sent to a server, in order. */
export function sentMethods(logText: string, fromOffset = 0): string[] {
	return loggedMessages(logText, fromOffset).filter(m => m.direction === 'sent' && m.message.method).map(m => m.message.method!);
}

/** The response of the server to a request VS Code sent. */
export function responseTo(messages: readonly ILoggedMessage[], request: ILoggedMessage): ILoggedMessage | undefined {
	return messages.find(m => m.direction === 'received' && m.offset > request.offset && m.message.method === undefined && m.message.id === request.message.id);
}

/** The `inputResponses` of the last `tools/call` retry of `tool` that VS Code sent (multi round-trip requests). */
export function lastInputResponses(logText: string, tool: string, fromOffset = 0): Record<string, unknown> | undefined {
	const retry = loggedMessages(logText, fromOffset).filter(m => m.direction === 'sent' && m.message.method === 'tools/call' && m.message.params?.name === tool && m.message.params?.inputResponses !== undefined).at(-1);
	return retry?.message.params?.inputResponses as Record<string, unknown> | undefined;
}

/** A JSON value with sorted object keys, for comparisons that ignore the key order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
		? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
		: v);
}

export type ListenCheck = { readonly ok: true; readonly details: Record<string, unknown> } | { readonly ok: false; readonly reason: string };

/** The server's acknowledgement of a `subscriptions/listen` stream (mcpSubscriptions.ts). */
export const LISTEN_ACK = 'notifications/subscriptions/acknowledged';
/** VS Code's warning when an acknowledgement does not come (and it reconnects). */
export const LISTEN_NOT_ACKNOWLEDGED = /subscriptions\/listen \(\w+\) was not acknowledged within \d+ms.*/;

/**
 * Whether a list change reached VS Code over its `subscriptions/listen` stream
 * after `fromOffset`: the server sent `notifications/<kind>/list_changed` with
 * the `subscriptionId` of VS Code's latest `subscriptions/listen` request that
 * asked for that list, VS Code then sent its own `<kind>/list`, and the answer
 * to that re-list contains `expectedName`. The caller must not send `<kind>/list`
 * through the gateway in that window: the gateway forwards it over the same
 * connection, so it would look like a re-list.
 */
export function checkListenDelivery(logText: string, fromOffset: number, kind: 'tools' | 'prompts', expectedName: string, notificationMethod = `notifications/${kind}/list_changed`): ListenCheck {
	const messages = loggedMessages(logText);
	const flag = kind === 'tools' ? 'toolsListChanged' : 'promptsListChanged';
	const notification = messages.find(m => m.offset >= fromOffset && m.direction === 'received' && m.message.method === notificationMethod);
	if (!notification) {
		const seen = messages.filter(m => m.offset >= fromOffset && m.direction === 'received' && m.message.method?.startsWith('notifications/')).map(m => m.message.method);
		return { ok: false, reason: `the server sent no ${notificationMethod} to VS Code after the trigger (notifications seen: ${JSON.stringify(seen)})` };
	}
	const subscriptionId = (notification.message.params?._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID_META];
	const listen = messages.filter(m => m.offset < notification.offset && m.direction === 'sent' && m.message.method === 'subscriptions/listen'
		&& (m.message.params?.notifications as Record<string, unknown> | undefined)?.[flag] === true).at(-1);
	if (!listen) {
		return { ok: false, reason: `VS Code sent no subscriptions/listen with ${flag} before the ${notificationMethod}` };
	}
	if (subscriptionId === undefined || String(subscriptionId) !== String(listen.message.id)) {
		return { ok: false, reason: `the ${notificationMethod} carries subscriptionId ${JSON.stringify(subscriptionId)}, but VS Code's subscriptions/listen request has id ${JSON.stringify(listen.message.id)}` };
	}
	// The stream was acknowledged (VS Code reconnects a listen that is not), and it is the only one:
	// a second listen for the same list before the change means the first one was dropped.
	const ack = messages.find(m => m.offset > listen.offset && m.offset < notification.offset && m.direction === 'received' && m.message.method === LISTEN_ACK
		&& (m.message.params?._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID_META] === listen.message.id);
	if (!ack) {
		return { ok: false, reason: `the server never acknowledged VS Code's subscriptions/listen (id ${JSON.stringify(listen.message.id)}) with ${LISTEN_ACK} carrying that subscriptionId before the ${notificationMethod}` };
	}
	const listens = messages.filter(m => m.offset < notification.offset && m.direction === 'sent' && m.message.method === 'subscriptions/listen'
		&& (m.message.params?.notifications as Record<string, unknown> | undefined)?.[flag] === true);
	if (listens.length !== 1) {
		return { ok: false, reason: `VS Code sent ${listens.length} subscriptions/listen requests with ${flag} before the ${notificationMethod} (ids ${JSON.stringify(listens.map(l => l.message.id))}); expected exactly one` };
	}
	const unacknowledged = LISTEN_NOT_ACKNOWLEDGED.exec(logText);
	if (unacknowledged) {
		return { ok: false, reason: `VS Code logged a listen stream that was not acknowledged: ${JSON.stringify(unacknowledged[0])}` };
	}
	const relist = messages.find(m => m.offset > notification.offset && m.direction === 'sent' && m.message.method === `${kind}/list`);
	if (!relist) {
		return { ok: false, reason: `VS Code did not send ${kind}/list after the ${notificationMethod}` };
	}
	const response = responseTo(messages, relist);
	if (!response) {
		return { ok: false, reason: `no answer yet to VS Code's re-list ${kind}/list (id ${JSON.stringify(relist.message.id)})` };
	}
	const names = ((response.message.result?.[kind] ?? []) as { name?: string }[]).map(i => i.name);
	if (!names.includes(expectedName)) {
		return { ok: false, reason: `VS Code's re-list ${kind}/list (id ${JSON.stringify(relist.message.id)}) has no ${expectedName}: ${JSON.stringify(names)}` };
	}
	return {
		ok: true,
		details: {
			listenRequestId: listen.message.id,
			acknowledgement: ack.message,
			notification: notification.message,
			relistRequestId: relist.message.id,
			relistedNames: names.length,
		},
	};
}

// --- The Tasks extension (SEP-2663) --------------------------------------------------------------

/** Whether a request VS Code sent declares the Tasks extension in its `_meta` client capabilities. */
export function declaresTasks(message: ILoggedJsonRpc): boolean {
	const meta = message.params?._meta as Record<string, unknown> | undefined;
	const capabilities = meta?.[CLIENT_CAPABILITIES_META] as { extensions?: Record<string, unknown> } | undefined;
	return capabilities?.extensions?.[TASKS_EXTENSION] !== undefined;
}

export interface ILoggedExchange {
	readonly request: ILoggedMessage;
	/** The answer, once VS Code's log has it. */
	readonly response: ILoggedMessage | undefined;
}

export interface ITaskRun {
	readonly taskId: string;
	/** The `tools/call` requests of the tool up to the one the task answered, in order (an input round first, when the tool asks for one). */
	readonly calls: readonly ILoggedExchange[];
	/** The answer that created the task. */
	readonly created: ILoggedJsonRpc;
	/** VS Code's `tasks/get` requests for the task, with their answers. */
	readonly polls: readonly ILoggedExchange[];
	readonly cancels: readonly ILoggedExchange[];
	/** VS Code's `tasks/update` requests (the answers to a task's own input requests). */
	readonly updates: readonly ILoggedExchange[];
}

export type LogCheck<T> = { readonly ok: true; readonly details: T } | { readonly ok: false; readonly reason: string };

/**
 * The task VS Code ran for the last `tools/call` of `tool` after `fromOffset` that was answered
 * with `resultType: "task"`: every `tools/call` of the tool must declare the Tasks extension, and the
 * answer must be a CreateTaskResult (a top-level `taskId`). Fails while VS Code's log has no such answer.
 */
export function taskRunOf(logText: string, fromOffset: number, tool: string): LogCheck<ITaskRun> {
	const messages = loggedMessages(logText, fromOffset);
	const calls = messages.filter(m => m.direction === 'sent' && m.message.method === 'tools/call' && m.message.params?.name === tool);
	if (!calls.length) {
		return { ok: false, reason: `VS Code sent no tools/call of ${tool}` };
	}
	const undeclared = calls.filter(c => !declaresTasks(c.message));
	if (undeclared.length) {
		return { ok: false, reason: `the tools/call of ${tool} (id ${JSON.stringify(undeclared[0].message.id)}) does not declare ${TASKS_EXTENSION} in _meta.${CLIENT_CAPABILITIES_META}: ${JSON.stringify(undeclared[0].message.params?._meta)}` };
	}
	const answered: ILoggedExchange[] = calls.map(request => ({ request, response: responseTo(messages, request) }));
	const task = answered.filter(a => a.response?.message.result?.resultType === 'task').at(-1);
	const created = task?.response;
	if (!task || !created) {
		return { ok: false, reason: `no tools/call of ${tool} was answered with resultType "task" (answers: ${JSON.stringify(answered.map(a => a.response?.message.result?.resultType ?? a.response?.message.error ?? '(none yet)'))})` };
	}
	const taskId = created.message.result?.taskId;
	if (typeof taskId !== 'string') {
		return { ok: false, reason: `the task answer has no top-level taskId: ${JSON.stringify(created.message.result)}` };
	}
	const withResponse = (method: string): ILoggedExchange[] => messages
		.filter(m => m.direction === 'sent' && m.message.method === method && m.message.params?.taskId === taskId && m.offset > created.offset)
		.map(request => ({ request, response: responseTo(messages, request) }));
	return { ok: true, details: { taskId, calls: answered.filter(a => a.request.offset <= task.request.offset), created: created.message, polls: withResponse('tasks/get'), cancels: withResponse('tasks/cancel'), updates: withResponse('tasks/update') } };
}

/** The status of a `tasks/get` answer (`working`, `completed`, `cancelled`, ...). */
export function taskStatusOf(response: ILoggedMessage | undefined): string | undefined {
	const status = response?.message.result?.status;
	return typeof status === 'string' ? status : undefined;
}

/** The text content of the CallToolResult a completed task carries inline (`tasks/get` result.result). */
export function taskResultText(response: ILoggedMessage | undefined): string {
	const result = response?.message.result?.result as { content?: { text?: string }[] } | undefined;
	return (result?.content ?? []).map(c => c.text ?? '').join('\n');
}

// --- The wire log of runner/grpc-log-proxy.ts ----------------------------------------------------

export const TUNNEL_CALL_PATH = '/mcp.zig.transport.v1.Mcp/Call';
export const TYPED_SERVICE_PREFIX = '/model_context_protocol.Mcp/';

export interface IWireEvent {
	readonly event: 'listening' | 'connection' | 'call' | 'end' | 'rst' | 'goaway' | 'session-error' | 'tls-error' | 'stream-error' | 'upstream-error';
	readonly t: string;
	/** The client connection (one HTTP/2 session), counted from 1. */
	readonly session?: number;
	/** `call`, `end`: the proxy's call counter; `rst`: the HTTP/2 stream id. */
	readonly stream?: number;
	/** `call`, `end`: the HTTP/2 stream id of the call on the client connection. */
	readonly h2Stream?: number;
	readonly path?: string;
	readonly metadata?: Record<string, string>;
	/** The JSON-RPC methods of a tunnel `Call`. */
	readonly jsonRpcMethods?: readonly string[];
	readonly grpcStatus?: string;
	readonly grpcMessage?: string;
	/** `end`: the proxy answered the call itself (`--refuse-tunnel`). */
	readonly refused?: boolean;
	/** `call`: the proxy rewrote the mcp-name metadata (`--mangle-mcp-name`), or held the call (`--hold`). */
	readonly mangled?: { readonly from: string; readonly to: string; readonly once: boolean };
	readonly heldMs?: number;
	/** `end`: the MCP error of the trailers (`mcp-error-code`, presence of `mcp-error-bin`). */
	readonly mcpErrorCode?: string;
	readonly mcpErrorBin?: boolean;
	/** `end`: the client reset the call while the proxy held it. */
	readonly cancelledWhileHeld?: boolean;
	/** `connection`: `open` or `close`; `tls`: the SNI and ALPN of a TLS connection. */
	readonly phase?: 'open' | 'close';
	readonly tls?: { readonly servername?: string; readonly alpn?: string };
	/** `rst`, `goaway`: which side sent the frame, its error code; `afterEnd`: the other side had ended the stream. */
	readonly from?: 'client' | 'server';
	readonly errorCode?: number;
	readonly afterEnd?: boolean;
	readonly lastStreamId?: number;
	/** `tls-error`, `session-error`. */
	readonly error?: string;
	readonly servername?: string;
	/** `listening`: nghttp2's stream reset rate limit of the proxy. */
	readonly resetLimit?: unknown;
	/** `connection` `close`: the HTTP/2 frames each side sent, by type (`HEADERS`, `RST_STREAM`, ...). */
	readonly frames?: { readonly fromClient: Readonly<Record<string, number>>; readonly fromServer: Readonly<Record<string, number>> };
}

export function parseWireLog(text: string): IWireEvent[] {
	return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as IWireEvent);
}

/** One line per call for the test details: `<path> [<JSON-RPC methods>] -> <grpc-status>`. */
export function describeWireCalls(events: readonly IWireEvent[]): string[] {
	return events.filter(e => e.event === 'call').map(call => {
		const end = events.find(e => e.event === 'end' && e.session === call.session && e.stream === call.stream);
		return `${call.path}${call.jsonRpcMethods ? ` ${JSON.stringify(call.jsonRpcMethods)}` : ''} -> ${end?.grpcStatus ?? '(open)'}`;
	});
}

// --- The request log of runner/http-fault-proxy.ts -----------------------------------------------

export interface IHttpProxyMessage {
	readonly method: string;
	readonly id?: number | string | null;
	readonly name?: string;
	readonly cursor?: unknown;
	readonly taskId?: string;
	readonly inputResponses?: boolean;
}

export interface IHttpProxyEvent {
	readonly event: 'listening' | 'request' | 'dropped';
	readonly t: string;
	readonly n?: number;
	readonly httpMethod?: string;
	readonly path?: string;
	/** The MCP headers of the request (lowercase), `mcp-param-*` included; `authorization` as its scheme only. */
	readonly headers?: Record<string, string>;
	readonly messages?: readonly IHttpProxyMessage[];
	readonly status?: number;
	readonly contentType?: string;
	/** The fault the proxy injected, the mutation it applied, or what its 2025-11-25 bridge did. */
	readonly fault?: string;
	readonly mutation?: string;
	readonly bridged?: string;
	readonly faults?: readonly string[];
	/** input-required-url: the URL the round asked for. */
	readonly url?: string;
	/** input-required-url: the round a retry answered (from its verified requestState). */
	readonly round?: number;
	/** input-required-url: the requestState the round issued, or the one its retry sent back (`null`: none). */
	readonly requestState?: string | null;
	/** input-required-url: the `inputResponses` of the retry (`null`: none). */
	readonly inputResponses?: Record<string, { readonly action?: string }> | null;
}
