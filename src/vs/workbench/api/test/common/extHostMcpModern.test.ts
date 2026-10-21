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
		const messageWaiters: { matches: (message: string) => boolean; received: DeferredPromise<void> }[] = [];
		/** Resolves once a message that `matches` reached the engine. */
		const waitForMessage = (matches: (message: string) => boolean): Promise<void> => {
			const received = new DeferredPromise<void>();
			if (messages.some(matches)) {
				received.complete();
			} else {
				messageWaiters.push({ matches, received });
			}
			return received.p;
		};
		const proxy = Object.assign(new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
			override $onDidReceiveMessage(_id: number, message: string): void {
				messages.push(message);
				for (const waiter of messageWaiters.filter(w => w.matches(message))) {
					waiter.received.complete();
				}
			}
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
		return { handle, requests, messages, aborts, states, logs, waitForMessage };
	}

	const toolsCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: { region: 'us-west1' } } });
	const resultFor = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, result: { resultType: 'complete' } });
	const discoverRequest = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'server/discover', params: {} });

	/** Polls until `condition` holds (for work the handle does after `send` returned, such as the HTTP+SSE fallback). */
	async function waitUntil(condition: () => boolean, what: string): Promise<void> {
		for (let waited = 0; !condition(); waited += 5) {
			assert.ok(waited < 2000, `timed out waiting for ${what}`);
			await new Promise(resolve => setTimeout(resolve, 5));
		}
	}

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

		test('a recognized modern error whose id is null or missing is delivered with the id of the request it rejects', async () => {
			const error = { code: -32020, message: 'Header mismatch: the Mcp-Method header is missing' };
			const bodies = [
				JSON.stringify({ jsonrpc: '2.0', id: null, error }),
				JSON.stringify({ jsonrpc: '2.0', error }),
				JSON.stringify([{ jsonrpc: '2.0', id: null, error }]),
			];
			for (const body of bodies) {
				const { handle, messages, aborts } = createHandle(() => response({ status: 400, headers: { 'Content-Type': 'application/json' }, body }));
				await handle.send(discoverRequest(5), modernEnvelope({ requestId: 5, method: 'server/discover' }));
				const expected = { jsonrpc: '2.0', id: 5, error };
				assert.deepStrictEqual(messages.map(m => JSON.parse(m)), [body.startsWith('[') ? [expected] : expected], body);
				assert.deepStrictEqual(aborts, []);
			}
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

		/** A legacy HTTP+SSE server that answers a POST to its URL, whatever the method, with its event stream; it answers on the newest GET stream. */
		function legacyServerAnsweringPostsWithItsStream() {
			const endpoint = 'event: endpoint\ndata: /messages\n\n';
			const getStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
			const created = createHandle(req => {
				if (req.method === 'GET') {
					return response({
						headers: { 'Content-Type': 'text/event-stream' },
						stream: new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(endpoint));
								getStreams.push(controller);
							},
						}),
					});
				}
				if (req.url.endsWith('/messages')) {
					const message = JSON.parse(req.body ?? '{}');
					getStreams.at(-1)?.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } } })}\n\n`));
					return response({ status: 202 });
				}
				return sseResponse([endpoint]);
			});
			const closeStreams = () => {
				for (const stream of getStreams) {
					try {
						stream.close();
					} catch {
						// the handle cancelled the stream already
					}
				}
			};
			return { ...created, closeStreams };
		}

		test('a legacy HTTP+SSE server that answers the unhinted probe with its event stream aborts the probe with legacy-probe, and the legacy initialize falls back to HTTP+SSE', async () => {
			const { handle, requests, messages, aborts, states, logs, closeStreams } = legacyServerAnsweringPostsWithItsStream();
			try {
				await handle.send(discoverRequest(1), modernEnvelope({ method: 'server/discover' }));
				assert.deepStrictEqual(aborts, [{ requestId: 1, reason: 'legacy-probe', message: 'The server uses the legacy HTTP+SSE transport' }], 'the engine falls back to the legacy handshake');
				assert.deepStrictEqual(messages, []);
				assert.deepStrictEqual(requests.map(r => r.method), ['POST'], 'no HTTP+SSE fallback for the 2026-07-28 request itself');

				const initialize = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
				await handle.send(initialize, legacyEnvelope({ requestId: 2 }));
				await waitUntil(() => messages.length > 0, 'the initialize result over HTTP+SSE');
				const sentToEndpoint = requests.filter(r => r.url === 'https://example.com/messages');
				assert.deepStrictEqual(sentToEndpoint.map(r => JSON.parse(r.body ?? '{}').method), ['initialize'], 'the initialize went to the message endpoint');
				assert.strictEqual(JSON.parse(messages[0]).id, 2);
				assert.strictEqual(aborts.length, 1, 'the initialize is not aborted');
				assert.ok(!states.some(s => s.state === McpConnectionState.Kind.Error), JSON.stringify(states));
				assert.deepStrictEqual(logs.filter(l => l.startsWith('Error reading SSE stream')), [], 'ending the stream that named the endpoint is no stream error');
			} finally {
				closeStreams();
			}
		});

		test('an endpoint event is no legacy server once the server is known to speak 2026-07-28, nor after the stream delivered a message', async () => {
			const endpoint = 'event: endpoint\ndata: /messages\n\n';
			// The probe made the server modern: a later stream that names an endpoint is still a modern one.
			const known = createHandle((req, index) => index === 0
				? response({ headers: { 'Content-Type': 'application/json' }, body: resultFor(1) })
				: sseResponse([endpoint, `event: message\ndata: ${resultFor(2)}\n\n`]));
			await known.handle.send(discoverRequest(1), modernEnvelope({ method: 'server/discover' }));
			await known.handle.send(toolsCall.replace('"id":1', '"id":2'), modernEnvelope({ requestId: 2, method: 'tools/call' }));
			assert.deepStrictEqual(known.messages, [resultFor(1), resultFor(2)]);
			assert.deepStrictEqual(known.aborts, []);
			assert.deepStrictEqual(known.requests.map(r => r.method), ['POST', 'POST']);

			// A probe stream that delivered the response before an endpoint event comes from a modern server.
			const answered = createHandle(req => sseResponse([`event: message\ndata: ${resultFor(JSON.parse(req.body ?? '{}').id)}\n\n`, endpoint]));
			await answered.handle.send(discoverRequest(1), modernEnvelope({ method: 'server/discover' }));
			assert.deepStrictEqual(answered.messages, [resultFor(1)]);
			assert.deepStrictEqual(answered.aborts, []);
			await answered.handle.send(toolsCall.replace('"id":1', '"id":2'), modernEnvelope({ requestId: 2, method: 'tools/call' }));
			assert.deepStrictEqual(answered.aborts, [], 'still modern: a 2026-07-28 request is sent, not aborted as a legacy probe');
			assert.deepStrictEqual(answered.requests.map(r => r.method), ['POST', 'POST']);
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

		suite('a pinned legacy initialize that the server rejects', () => {
			const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
			const errorBody = (code: number, message: string, data?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, error: data === undefined ? { code, message } : { code, message, data } });
			/** A 2026-07-28-only server: the rejection for the initialize POST, 200 for server/discover, 405 for GET (no HTTP+SSE). */
			const modernOnlyServer = (status: number, body: string): Responder => req => {
				if (req.method === 'GET') {
					return response({ status: 405 });
				}
				if (req.body?.includes('"initialize"')) {
					return response({ status, headers: { 'Content-Type': 'application/json' }, body });
				}
				return response({ headers: { 'Content-Type': 'application/json' }, body: resultFor(2) });
			};

			const recognized: { readonly name: string; readonly status: number; readonly body: string }[] = [
				{ name: '400 with -32020 (the zig server: the legacy request has no Mcp-Method header)', status: 400, body: errorBody(-32020, 'Header mismatch: the Mcp-Method header is missing') },
				{ name: '400 with -32022 naming the supported revisions', status: 400, body: errorBody(-32022, 'Unsupported protocol version 2025-11-25', { supported: ['2026-07-28'], requested: '2025-11-25' }) },
				{ name: '404 with -32601', status: 404, body: errorBody(-32601, 'Method not found: initialize') },
			];
			for (const { name, status, body } of recognized) {
				test(`${name}: the error is delivered and no HTTP+SSE fallback is attempted`, async () => {
					const { handle, requests, messages, aborts, states } = createHandle(modernOnlyServer(status, body));
					await handle.send(initialize, legacyEnvelope());

					assert.deepStrictEqual(messages, [body], 'the engine gets the JSON-RPC error and renegotiates');
					assert.deepStrictEqual(aborts, []);
					assert.deepStrictEqual(requests.map(r => r.method), ['POST'], 'no GET for the legacy HTTP+SSE transport');
					assert.ok(!states.some(s => s.state === McpConnectionState.Kind.Error), JSON.stringify(states));

					// The engine's server/discover then goes through as a 2026-07-28 request.
					await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} }), modernEnvelope({ requestId: 2, method: 'server/discover', headers: { 'Mcp-Method': 'server/discover' } }));
					assert.deepStrictEqual(messages, [body, resultFor(2)]);
					await new Promise(resolve => setTimeout(resolve, 20));
					assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'POST'], 'still no GET: the server speaks 2026-07-28');
				});
			}

			const unrecognized: { readonly name: string; readonly status: number; readonly body: string }[] = [
				{ name: '400 with -32601 (method-not-found counts only with 404)', status: 400, body: errorBody(-32601, 'Method not found') },
				{ name: '400 with -32600', status: 400, body: errorBody(-32600, 'Invalid Request') },
				{ name: '404 without a JSON-RPC body', status: 404, body: 'Not Found' },
			];
			for (const { name, status, body } of unrecognized) {
				test(`${name}: a legacy server, so the HTTP+SSE fallback runs as before`, async () => {
					const { handle, requests, messages, aborts, states } = createHandle(modernOnlyServer(status, body));
					await handle.send(initialize, legacyEnvelope());
					await waitUntil(() => aborts.length > 0 || states.some(s => s.state === McpConnectionState.Kind.Error), `the end of the fallback: ${JSON.stringify(states)}`);

					assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'GET'], 'the HTTP+SSE fallback was attempted');
					assert.deepStrictEqual(messages, []);
					// The fallback failed too: the initialize is aborted with both reasons, so the engine
					// renegotiates the pin, and the server does not fail.
					assert.deepStrictEqual(aborts, [{
						requestId: 1,
						reason: 'http-status',
						httpStatus: status,
						message: `${status} status sending message to https://example.com/mcp, and the fallback to legacy SSE failed: 405 status connecting to https://example.com/mcp as SSE: `,
					}]);
					assert.ok(!states.some(s => s.state === McpConnectionState.Kind.Error), JSON.stringify(states));

					// The engine's server/discover then goes through as a 2026-07-28 request.
					await handle.send(discoverRequest(2), modernEnvelope({ requestId: 2, method: 'server/discover', headers: { 'Mcp-Method': 'server/discover' } }));
					assert.deepStrictEqual(messages, [resultFor(2)]);
				});
			}

			for (const status of [406, 415]) {
				test(`${status} with a 2026-07-28 error body: only 400, 404 and 405 bodies are inspected, so the HTTP+SSE fallback runs`, async () => {
					const { handle, requests, messages, aborts } = createHandle(modernOnlyServer(status, errorBody(-32020, 'Header mismatch: the Mcp-Method header is missing')));
					await handle.send(initialize, legacyEnvelope());
					await waitUntil(() => aborts.length > 0, 'the abort after the failed fallback');

					assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'GET'], 'the HTTP+SSE fallback was attempted');
					assert.deepStrictEqual(messages, [], 'the body is not delivered');
					assert.deepStrictEqual(aborts.map(a => [a.reason, a.httpStatus]), [['http-status', status]]);
				});
			}

			test('a recognized 2026-07-28 error whose id is null or missing is delivered with the id of the initialize', async () => {
				const error = { code: -32020, message: 'Header mismatch: the Mcp-Method header is missing' };
				for (const body of [JSON.stringify({ jsonrpc: '2.0', id: null, error }), JSON.stringify({ jsonrpc: '2.0', error })]) {
					const { handle, requests, messages, aborts } = createHandle(modernOnlyServer(400, body));
					await handle.send(initialize, legacyEnvelope());

					assert.deepStrictEqual(messages.map(m => JSON.parse(m)), [{ jsonrpc: '2.0', id: 1, error }], body);
					assert.deepStrictEqual(aborts, []);
					assert.deepStrictEqual(requests.map(r => r.method), ['POST'], 'no HTTP+SSE fallback');
				}
			});

			test('an HTTP+SSE fallback whose GET stream ends without naming a message endpoint has failed: the initialize is aborted instead of waiting forever', async () => {
				const page = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('<html><body>Not an MCP server</body></html>'));
						controller.close();
					},
				});
				const { handle, requests, aborts, states } = createHandle(req => req.method === 'GET'
					? response({ headers: { 'Content-Type': 'text/html' }, stream: page })
					: response({ status: 400, body: 'Bad Request' }));
				await handle.send(initialize, legacyEnvelope());
				await waitUntil(() => aborts.length > 0, 'the abort after the failed fallback');

				assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'GET']);
				assert.strictEqual(aborts[0].message, '400 status sending message to https://example.com/mcp, and the fallback to legacy SSE failed: The SSE stream from https://example.com/mcp ended before it named the message endpoint');
				assert.ok(!states.some(s => s.state === McpConnectionState.Kind.Error), JSON.stringify(states));
			});

			/** An SSE response that sends `events`, then fails with `error` once `fail` completes (at once without it). */
			const failingSseResponse = (events: string[], error: Error, fail?: DeferredPromise<void>) => response({
				headers: { 'Content-Type': 'text/event-stream' },
				stream: new ReadableStream<Uint8Array>({
					async start(controller) {
						for (const event of events) {
							controller.enqueue(new TextEncoder().encode(event));
						}
						await fail?.p;
						controller.error(error);
					},
				}),
			});

			test('an HTTP+SSE fallback whose GET stream fails before naming a message endpoint has failed: the initialize is aborted instead of waiting forever', async () => {
				const { handle, requests, aborts, states } = createHandle(req => req.method === 'GET'
					? failingSseResponse([], new TypeError('terminated: other side closed'))
					: response({ status: 400, body: 'Bad Request' }));
				await handle.send(initialize, legacyEnvelope());
				await waitUntil(() => aborts.length > 0 || states.some(s => s.state === McpConnectionState.Kind.Error), `the end of the fallback: ${JSON.stringify(states)}`);

				assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'GET']);
				assert.deepStrictEqual(aborts.map(a => [a.requestId, a.reason, a.httpStatus]), [[1, 'http-status', 400]]);
				assert.ok(aborts[0].message?.startsWith('400 status sending message to https://example.com/mcp, and the fallback to legacy SSE failed: Error reading SSE stream: ') && aborts[0].message.includes('terminated: other side closed'), aborts[0].message);
				assert.ok(!states.some(s => s.state === McpConnectionState.Kind.Error), JSON.stringify(states));
			});

			test('once the GET stream of the HTTP+SSE fallback named the message endpoint, a failure of that stream fails the server', async () => {
				const fail = new DeferredPromise<void>();
				const { handle, requests, aborts, states } = createHandle(req => {
					if (req.method === 'GET') {
						return failingSseResponse(['event: endpoint\ndata: /messages\n\n'], new TypeError('terminated: other side closed'), fail);
					}
					return req.url.endsWith('/messages') ? response({ status: 202 }) : response({ status: 400, body: 'Bad Request' });
				});
				await handle.send(initialize, legacyEnvelope());
				await waitUntil(() => requests.length === 3, 'the initialize sent to the message endpoint');
				assert.deepStrictEqual(requests.map(r => [r.method, r.url]), [['POST', TEST_MCP_URL], ['GET', TEST_MCP_URL], ['POST', 'https://example.com/messages']]);
				assert.ok(!states.some(s => s.state === McpConnectionState.Kind.Error), JSON.stringify(states));

				fail.complete();
				await waitUntil(() => states.some(s => s.state === McpConnectionState.Kind.Error), `the server failing: ${JSON.stringify(states)}`);
				const error = states.find(s => s.state === McpConnectionState.Kind.Error);
				assert.ok(error?.state === McpConnectionState.Kind.Error && error.message.startsWith('Error reading SSE stream: ') && error.message.includes('terminated: other side closed'), JSON.stringify(error));
				assert.deepStrictEqual(aborts, [], 'the initialize was delivered: the server fails instead');
			});

			test('a POST answered with an SSE stream that names a message endpoint (a legacy server) is not a rejected POST: when that fallback fails, the server fails', async () => {
				const { handle, requests, aborts, states, logs } = createHandle(req => req.method === 'GET'
					? response({ status: 405 })
					: sseResponse(['event: endpoint\ndata: /messages\n\n']));
				await handle.send(initialize, legacyEnvelope());
				await waitUntil(() => states.some(s => s.state === McpConnectionState.Kind.Error), `the server failing: ${JSON.stringify(states)}`);

				// The POST, the GET backchannel of Streamable HTTP, and the GET of the fallback.
				assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'GET', 'GET']);
				const error = states.find(s => s.state === McpConnectionState.Kind.Error);
				assert.ok(error?.state === McpConnectionState.Kind.Error && error.message === '405 status connecting to https://example.com/mcp as SSE: ', JSON.stringify(error));
				assert.deepStrictEqual(aborts, [], 'no abort with an HTTP status the server did not send');
				assert.deepStrictEqual(logs.filter(l => l.startsWith('Error reading SSE stream')), [], 'ending the POST stream that named the endpoint is no stream error');
			});

			test('without an envelope, a recognized modern error body still falls back to HTTP+SSE (the wire is unchanged)', async () => {
				const { handle, requests, messages, aborts, states } = createHandle(modernOnlyServer(400, errorBody(-32022, 'Unsupported protocol version unknown', { supported: ['2026-07-28'], requested: 'unknown' })));
				await handle.send(initialize);
				await waitUntil(() => states.some(s => s.state === McpConnectionState.Kind.Error), `the end of the fallback: ${JSON.stringify(states)}`);
				assert.deepStrictEqual(requests.map(r => r.method), ['POST', 'GET']);
				assert.deepStrictEqual(messages, []);
				assert.deepStrictEqual(aborts, [], 'a message without an envelope is not aborted: its failed fallback fails the server as before');
			});

			test('without an envelope, a GET stream that ends without naming a message endpoint fails the server instead of waiting forever', async () => {
				const { handle, states } = createHandle(req => req.method === 'GET'
					? response({ headers: { 'Content-Type': 'text/event-stream' }, body: '' })
					: response({ status: 400, body: 'Bad Request' }));
				await handle.send(initialize);
				await waitUntil(() => states.some(s => s.state === McpConnectionState.Kind.Error), `the end of the fallback: ${JSON.stringify(states)}`);
				const error = states.find(s => s.state === McpConnectionState.Kind.Error);
				assert.ok(error?.state === McpConnectionState.Kind.Error && error.message === 'The SSE stream from https://example.com/mcp ended before it named the message endpoint', JSON.stringify(error));
			});
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

		test('a priming event (an id and empty data) is not delivered as a message', async () => {
			const { handle, messages, aborts, logs } = createHandle(req => {
				if (req.method === 'GET') {
					return response({ status: 405 });
				}
				return sseResponse([
					'id: prime-1\ndata:\n\n',
					'id: prime-2\nretry: 500\ndata: \n\n',
					`id: event-1\nevent: message\ndata: ${resultFor(1)}\n\n`,
				]);
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), legacyEnvelope());
			assert.deepStrictEqual(messages, [resultFor(1)]);
			assert.deepStrictEqual(aborts, []);
			assert.deepStrictEqual(logs.filter(l => l.includes('parse') || l.includes('Error reading')), []);
		});

		test('a priming event alone sets the resumption point of a POST stream that closes early', async () => {
			const clock = sinon.useFakeTimers({ shouldAdvanceTime: true });
			const { handle, requests, messages, aborts } = createHandle(req => {
				if (req.method === 'POST' && req.body?.includes('"initialize"')) {
					return response({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) });
				}
				if (req.method === 'POST') {
					return sseResponse(['id: prime-1\nretry: 200\ndata:\n\n']);
				}
				if (req.headers['Last-Event-ID'] === 'prime-1') {
					return sseResponse([`event: message\ndata: ${resultFor(2)}\n\n`]);
				}
				return response({ status: 405 });
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), legacyEnvelope());
			await handle.send(toolsCall.replace('"id":1', '"id":2'), legacyEnvelope({ requestId: 2, method: 'tools/call' }));
			await clock.tickAsync(300);
			assert.ok(requests.some(r => r.method === 'GET' && r.headers['Last-Event-ID'] === 'prime-1'), 'resumed from the priming event id');
			assert.deepStrictEqual(messages.filter(m => m.trim() === ''), [], 'no empty message reached the engine');
			assert.ok(messages.includes(resultFor(2)));
			assert.deepStrictEqual(aborts, []);
		});

		test('the GET backchannel of a legacy session does not deliver an empty data event', async () => {
			const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
			const { handle, messages, waitForMessage } = createHandle(req => {
				if (req.method === 'GET') {
					return sseResponse(['id: prime\ndata:\n\n', 'data: \n\n', `event: message\ndata: ${notification}\n\n`], new DeferredPromise<void>());
				}
				return response({ headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' }, body: resultFor(1) });
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), legacyEnvelope());
			// The backchannel delivers its events in order: the empty ones came before the notification, if at all.
			await waitForMessage(message => message === notification);
			assert.deepStrictEqual(messages, [resultFor(1), notification]);
		});

		test('legacy HTTP+SSE: an empty data event on the session stream is not delivered', async () => {
			const { handle, requests, messages, waitForMessage } = createHandle(req => {
				if (req.method === 'GET') {
					return sseResponse(['event: endpoint\ndata: /messages?session=1\n\n', 'id: prime\ndata:\n\n', `event: message\ndata: ${resultFor(1)}\n\n`], new DeferredPromise<void>());
				}
				if (req.url.includes('/messages')) {
					return response({ status: 202 });
				}
				return response({ status: 405 });
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
			// The session stream delivers its events in order: the empty one came before the result, if at all.
			await waitForMessage(message => message === resultFor(1));
			assert.ok(requests.some(r => r.url.includes('/messages')), 'fell back to HTTP+SSE');
			assert.deepStrictEqual(messages, [resultFor(1)]);
		});

		test('legacy HTTP+SSE: a 2026-07-28 request (the engine re-probing after the server rejected a pin) is aborted with legacy-probe and not sent', async () => {
			const { handle, requests, aborts } = createHandle(req => {
				if (req.method === 'GET') {
					return sseResponse(['event: endpoint\ndata: /messages?session=1\n\n'], new DeferredPromise<void>());
				}
				if (req.url.includes('/messages')) {
					return response({ status: 202 });
				}
				return response({ status: 405 });
			});
			await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }), legacyEnvelope({ protocolVersion: '2024-11-05' }));
			await waitUntil(() => requests.some(r => r.url.includes('/messages')), 'the initialize over HTTP+SSE');
			const sent = requests.length;

			await handle.send(discoverRequest(2), modernEnvelope({ requestId: 2, method: 'server/discover' }));
			assert.deepStrictEqual(aborts, [{ requestId: 2, reason: 'legacy-probe', message: 'The server uses the legacy HTTP+SSE transport' }], 'the engine falls back to the legacy handshake');
			assert.strictEqual(requests.length, sent, 'nothing is sent');
		});
	});
});
