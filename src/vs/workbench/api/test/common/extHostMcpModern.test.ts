/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise } from '../../../../base/common/async.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpConnectionState, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { CommonRequestInit, CommonResponse, McpHTTPHandle } from '../../common/extHostMcp.js';

const TEST_MCP_URL = 'https://example.com/mcp';

interface IRecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string | undefined;
	readonly signal: AbortSignal | undefined;
	readonly at: number;
}

type Responder = (request: IRecordedRequest, index: number) => CommonResponse | Promise<CommonResponse>;

function response(options: { status?: number; headers?: Record<string, string>; body?: string; stream?: ReadableStream<Uint8Array> }): CommonResponse {
	return {
		status: options.status ?? 200,
		statusText: 'status',
		url: TEST_MCP_URL,
		headers: new Headers(options.headers ?? {}),
		body: options.stream ?? null,
		json: async () => JSON.parse(options.body ?? '{}'),
		text: async () => options.body ?? '',
	};
}

/** An SSE response whose events are written up front; the stream closes after them unless `hold` is given. */
function sseResponse(events: string[], hold?: DeferredPromise<void>): CommonResponse {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(event));
			}
			if (hold) {
				await hold.p;
			}
			controller.close();
		},
	});
	return response({ headers: { 'Content-Type': 'text/event-stream' }, stream });
}

const modernEnvelope = (overrides: Partial<IMcpMessageEnvelope> = {}): IMcpMessageEnvelope => ({
	kind: 'request',
	requestId: 1,
	protocolVersion: '2026-07-28',
	method: 'tools/list',
	...overrides,
});

const legacyEnvelope = (overrides: Partial<IMcpMessageEnvelope> = {}): IMcpMessageEnvelope => ({
	kind: 'request',
	requestId: 1,
	protocolVersion: '2025-11-25',
	method: 'initialize',
	...overrides,
});

suite('ExtHostMcp - dual-era Streamable HTTP', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	function createHandle(respond: Responder) {
		const requests: IRecordedRequest[] = [];
		const messages: string[] = [];
		const aborts: IMcpRequestAbort[] = [];
		const states: McpConnectionState[] = [];
		const logs: string[] = [];
		const proxy = Object.assign(new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
			override $onDidReceiveMessage(_id: number, message: string): void { messages.push(message); }
			override $onDidAbortRequest(_id: number, abort: IMcpRequestAbort): void { aborts.push(abort); }
			override $onDidPublishLog(_id: number, _level: LogLevel, message: string): void { logs.push(message); }
			override async $getTokenFromServerMetadata(): Promise<string> { return 'test-access-token'; }
			override $logMcpAuthSetup(): void { }
		}, {
			async $checkMcpServerAllowed(): Promise<string | undefined> { return undefined; }
		});
		const handle = store.add(new class extends McpHTTPHandle {
			protected override async _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
				assert.ok(init);
				const recorded: IRecordedRequest = {
					url,
					method: init.method,
					headers: { ...init.headers },
					body: init.body ? new TextDecoder().decode(init.body) : undefined,
					signal: init.signal,
					at: Date.now(),
				};
				requests.push(recorded);
				return respond(recorded, requests.length - 1);
			}
		}(1, { type: McpServerTransportType.HTTP, uri: URI.parse(TEST_MCP_URL), headers: [['X-Custom', 'configured']] }, proxy, new NullLogService()));
		return { handle, requests, messages, aborts, states, logs };
	}

	const toolsCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: { region: 'us-west1' } } });
	const resultFor = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, result: { resultType: 'complete' } });

	suite('modern era', () => {
		test('a modern request carries the version and mirrored headers and never a session id', async () => {
			const { handle, requests, messages, aborts } = createHandle(() => response({ headers: { 'Content-Type': 'application/json' }, body: resultFor(1) }));
			await handle.send(toolsCall, modernEnvelope({ method: 'tools/call', headers: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_weather', 'Mcp-Param-Region': 'us-west1' } }));

			assert.strictEqual(requests.length, 1);
			const req = requests[0];
			assert.strictEqual(req.method, 'POST');
			assert.strictEqual(req.headers['MCP-Protocol-Version'], '2026-07-28');
			assert.strictEqual(req.headers['Mcp-Method'], 'tools/call');
			assert.strictEqual(req.headers['Mcp-Name'], 'get_weather');
			assert.strictEqual(req.headers['Mcp-Param-Region'], 'us-west1');
			assert.strictEqual(req.headers['X-Custom'], 'configured');
			assert.strictEqual(req.headers['Mcp-Session-Id'], undefined);
			assert.strictEqual(req.headers.Accept, 'text/event-stream, application/json');
			assert.deepStrictEqual(messages, [resultFor(1)]);
			assert.deepStrictEqual(aborts, []);
		});

		test('a modern server never gets a GET backchannel and later requests are independent', async () => {
			const { handle, requests, messages } = createHandle(() => response({ headers: { 'Content-Type': 'application/json' }, body: resultFor(1) }));
			await handle.send(toolsCall, modernEnvelope({ method: 'tools/call' }));
			await handle.send(toolsCall, modernEnvelope({ method: 'tools/call', requestId: 2 }));
			await new Promise(resolve => setTimeout(resolve, 20));
			assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'POST']);
			assert.strictEqual(messages.length, 2);
		});

		test('the response may arrive on a per-request SSE stream that then ends', async () => {
			const { handle, messages, aborts } = createHandle(() => sseResponse([
				`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } })}\n\n`,
				`event: message\ndata: ${resultFor(1)}\n\n`,
			]));
			await handle.send(toolsCall, modernEnvelope({ method: 'tools/call' }));
			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[1], resultFor(1));
			assert.deepStrictEqual(aborts, []);
		});

		test('a stream that ends without the response aborts the request with stream-closed', async () => {
			const { handle, aborts } = createHandle(() => sseResponse([
				`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: {} })}\n\n`,
			]));
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'subscriptions/listen', params: {} }), modernEnvelope({ kind: 'listen', requestId: 7, method: 'subscriptions/listen' }));
			assert.strictEqual(aborts.length, 1);
			assert.strictEqual(aborts[0].requestId, 7);
			assert.strictEqual(aborts[0].reason, 'stream-closed');
		});

		test('a 400 with a recognized modern error body is delivered as a message, not an abort', async () => {
			const unsupported = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2027-01-01' } } });
			const { handle, messages, aborts } = createHandle(() => response({ status: 400, headers: { 'Content-Type': 'application/json' }, body: unsupported }));
			await handle.send(toolsCall, modernEnvelope({ protocolVersion: '2027-01-01' }));
			assert.deepStrictEqual(messages, [unsupported]);
			assert.deepStrictEqual(aborts, []);
		});

		test('a 404 with method-not-found is delivered as a message', async () => {
			const notFound = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });
			const { handle, messages, aborts } = createHandle(() => response({ status: 404, body: notFound }));
			await handle.send(toolsCall, modernEnvelope());
			assert.deepStrictEqual(messages, [notFound]);
			assert.deepStrictEqual(aborts, []);
		});

		test('a legacy server (4xx without a modern error body) aborts the probe with legacy-probe and the legacy handshake proceeds as before', async () => {
			const { handle, requests, messages, aborts } = createHandle((req, index) => {
				if (index === 0) {
					return response({ status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Server not initialized' }, id: null }) });
				}
				if (req.method === 'GET') {
					return response({ status: 405 });
				}
				return response({ headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } } }) });
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }), modernEnvelope({ method: 'server/discover' }));
			assert.strictEqual(aborts.length, 1);
			assert.strictEqual(aborts[0].reason, 'legacy-probe');
			assert.strictEqual(aborts[0].httpStatus, 400);
			assert.deepStrictEqual(messages, []);

			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }), legacyEnvelope());
			const initialize = requests[1];
			assert.strictEqual(initialize.method, 'POST');
			assert.strictEqual(initialize.headers['MCP-Protocol-Version'], '2025-11-25');
			assert.strictEqual(initialize.headers['Mcp-Method'], undefined);
			assert.strictEqual(messages.length, 1);
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), legacyEnvelope({ requestId: 2, method: 'tools/list' }));
			const toolsList = requests.find((r, i) => i > 1 && r.method === 'POST');
			assert.ok(toolsList);
			assert.strictEqual(toolsList.headers['Mcp-Session-Id'], 'session-1', 'the legacy session id is used from then on');
		});

		test('a 5xx aborts the request with http-status', async () => {
			const { handle, aborts, states } = createHandle(() => response({ status: 503, body: 'down' }));
			await handle.send(toolsCall, modernEnvelope());
			assert.strictEqual(aborts.length, 1);
			assert.strictEqual(aborts[0].reason, 'http-status');
			assert.strictEqual(aborts[0].httpStatus, 503);
			assert.ok(!states.some(s => s.state === McpConnectionState.Kind.Error), 'one failed request does not fail the connection');
		});

		test('cancelRequest aborts the in-flight request without reporting an abort', async () => {
			const gate = new DeferredPromise<CommonResponse>();
			const { handle, requests, aborts } = createHandle(req => {
				const signal = req.signal;
				assert.ok(signal);
				signal.addEventListener('abort', () => gate.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
				return gate.p;
			});
			const sending = handle.send(toolsCall, modernEnvelope({ requestId: 42 }));
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.strictEqual(requests.length, 1);
			handle.cancelRequest(42);
			await sending;
			assert.strictEqual(requests[0].signal?.aborted, true);
			assert.deepStrictEqual(aborts, []);
		});

		test('mirrored headers survive a cross-origin redirect while credentials are stripped', async () => {
			const { handle, requests } = createHandle((req, index) => {
				if (index === 0) {
					return response({ status: 307, headers: { Location: 'https://other.example/mcp' } });
				}
				return response({ headers: { 'Content-Type': 'application/json' }, body: resultFor(1) });
			});
			await handle.send(toolsCall, modernEnvelope({ method: 'tools/call', headers: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_weather' } }));
			assert.strictEqual(requests.length, 2);
			assert.strictEqual(requests[1].url, 'https://other.example/mcp');
			assert.strictEqual(requests[1].headers['Mcp-Method'], 'tools/call');
			assert.strictEqual(requests[1].headers['Mcp-Name'], 'get_weather');
			assert.strictEqual(requests[1].headers['MCP-Protocol-Version'], '2026-07-28');
			assert.strictEqual(requests[1].headers['X-Custom'], undefined, 'configured headers are not replayed cross-origin');
		});
	});

	suite('legacy era', () => {
		test('a message without an envelope goes on the wire exactly as before', async () => {
			const { handle, requests } = createHandle(req => req.method === 'GET' ? response({ status: 405 }) : response({ status: 202 }));
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
			const post = requests[0];
			assert.deepStrictEqual(Object.keys(post.headers).sort(), ['Accept', 'Content-Type', 'X-Custom', 'user-agent'].sort());
			assert.strictEqual(post.headers['MCP-Protocol-Version'], undefined);
		});

		test('a legacy envelope adds the protocol version header to POST and the GET backchannel', async () => {
			const backchannel = new DeferredPromise<void>();
			const { handle, requests } = createHandle(req => {
				if (req.method === 'GET') {
					backchannel.complete();
					return response({ status: 405 });
				}
				return response({ status: 202 });
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), legacyEnvelope());
			await backchannel.p;
			assert.strictEqual(requests[0].headers['MCP-Protocol-Version'], '2025-11-25');
			assert.strictEqual(requests[0].headers['Mcp-Method'], undefined);
			const get = requests.find(r => r.method === 'GET');
			assert.ok(get);
			assert.strictEqual(get.headers['MCP-Protocol-Version'], '2025-11-25');
		});

		test('a POST stream that closes before the response is resumed with Last-Event-ID after the advertised retry', async () => {
			const clock = sinon.useFakeTimers({ shouldAdvanceTime: true });
			let postedAt = 0;
			const { handle, requests, messages, aborts } = createHandle(req => {
				if (req.method === 'POST' && req.body?.includes('"initialize"')) {
					return response({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });
				}
				if (req.method === 'POST') {
					postedAt = Date.now();
					return sseResponse([`id: event-1\nretry: 500\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`]);
				}
				if (req.headers['Last-Event-ID'] === 'event-1') {
					return sseResponse([`event: message\ndata: ${resultFor(2)}\n\n`]);
				}
				return response({ status: 405 });
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), legacyEnvelope());
			await handle.send(toolsCall.replace('"id":1', '"id":2'), legacyEnvelope({ requestId: 2, method: 'tools/call' }));

			await clock.tickAsync(600);
			const resumed = requests.find(r => r.method === 'GET' && r.headers['Last-Event-ID'] === 'event-1');
			assert.ok(resumed, 'a GET with Last-Event-ID was sent');
			assert.ok(resumed.at - postedAt >= 450 && resumed.at - postedAt <= 700, `resumed ${resumed.at - postedAt} ms after the POST`);
			assert.strictEqual(resumed.headers['MCP-Protocol-Version'], '2025-11-25');
			assert.ok(messages.includes(resultFor(2)), 'the response delivered on the resumed stream reached the engine');
			assert.deepStrictEqual(aborts, []);
		});
	});
});
