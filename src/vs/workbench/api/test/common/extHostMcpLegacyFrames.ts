/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Recorded legacy (2025-11-25) Streamable HTTP traffic: the requests that the
 * `McpHTTPHandle` of `main` (before the 2026-07-28 work) sends for the opening
 * messages of a session, which carry no envelope. A message without an
 * envelope must still go on the wire exactly like this.
 *
 * - The bodies are the frames of VS Code's protocol engine: `initialize` as the
 *   zig-bridge-sdk VS Code transcripts record it (`bridges/vscode/test/harness.zig`,
 *   VS Code 1.140.0), and `notifications/initialized` and `tools/list` as `main`'s
 *   `McpServerRequestHandler` serializes them (`{ ...notification, jsonrpc }`, and
 *   `{ jsonrpc, id, method, params }` with a pagination cursor that is undefined).
 * - The headers follow `main`'s `_sendStreamableHttp` and `_attachStreamableBackchannel`:
 *   the configured headers, the session id, then the transport headers, which
 *   `_fetch` sets again (so they move to the end), and the user agent last.
 *   They are listed in that order, names in the case they are sent with.
 */

export interface IRecordedHttpRequest {
	readonly method: string;
	readonly url: string;
	/** Name and value of every header, in the order they are set. */
	readonly headers: readonly (readonly [string, string])[];
	readonly body: string | undefined;
}

/** The URL of the recorded server. */
export const LEGACY_FRAMES_URL = 'https://example.com/mcp';

/** The headers configured for the recorded server. */
export const LEGACY_FRAMES_CONFIGURED_HEADERS: readonly (readonly [string, string])[] = [['X-Custom', 'configured']];

/** The session id the recorded server assigns in its `initialize` response. */
export const LEGACY_FRAMES_SESSION_ID = 'session-1';

export const LEGACY_INITIALIZE_FRAME = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"sampling":{},"elicitation":{"form":{},"url":{}},"tasks":{"list":{},"cancel":{},"requests":{"sampling":{"createMessage":{}},"elicitation":{"create":{}}}},"extensions":{"io.modelcontextprotocol/ui":{"mimeTypes":["text/html;profile=mcp-app"]}}},"clientInfo":{"name":"Visual Studio Code","version":"1.140.0"}}}';

export const LEGACY_INITIALIZED_FRAME = '{"method":"notifications/initialized","jsonrpc":"2.0"}';

export const LEGACY_TOOLS_LIST_FRAME = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';

/**
 * The recorded requests, in the order of the messages: the POST of `initialize`,
 * the GET of the session's notification stream that its success opens, and the
 * POSTs of `notifications/initialized` and `tools/list`. `userAgent` is
 * `${product.nameLong}/${product.version}`, the one value that changes from
 * build to build.
 */
export function legacyHttpRequests(userAgent: string): {
	readonly initialize: IRecordedHttpRequest;
	readonly backchannel: IRecordedHttpRequest;
	readonly initialized: IRecordedHttpRequest;
	readonly toolsList: IRecordedHttpRequest;
} {
	const post = (body: string, sessionId?: string): IRecordedHttpRequest => ({
		method: 'POST',
		url: LEGACY_FRAMES_URL,
		headers: [
			...LEGACY_FRAMES_CONFIGURED_HEADERS,
			...(sessionId ? [['Mcp-Session-Id', sessionId] as const] : []),
			['Content-Type', 'application/json'],
			['Accept', 'text/event-stream, application/json'],
			['user-agent', userAgent],
		],
		body,
	});
	return {
		initialize: post(LEGACY_INITIALIZE_FRAME),
		backchannel: {
			method: 'GET',
			url: LEGACY_FRAMES_URL,
			headers: [
				...LEGACY_FRAMES_CONFIGURED_HEADERS,
				['Mcp-Session-Id', LEGACY_FRAMES_SESSION_ID],
				['Accept', 'text/event-stream'],
				['user-agent', userAgent],
			],
			body: undefined,
		},
		initialized: post(LEGACY_INITIALIZED_FRAME, LEGACY_FRAMES_SESSION_ID),
		toolsList: post(LEGACY_TOOLS_LIST_FRAME, LEGACY_FRAMES_SESSION_ID),
	};
}
