/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createServer } from 'net';
import { timeout } from '../../../../base/common/async.js';
import { JsonRpcMessage } from '../../../../base/common/jsonRpcProtocol.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import product from '../../../../platform/product/common/product.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { McpServerRequestHandler } from '../../../contrib/mcp/common/mcpServerRequestHandler.js';
import { McpTaskManager } from '../../../contrib/mcp/common/mcpTaskManager.js';
import { IMcpMessageEnvelope, IMcpNegotiationHints, IMcpRequestAbort, McpClientError, McpConnectionState, McpServerTransportHTTP, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { IAuthResourceMetadataSource, IAuthServerMetadataSource, IMcpAuthenticationDetails } from '../../common/extHost.protocol.js';
import { CommonRequestInit, CommonResponse, McpHTTPHandle } from '../../common/extHostMcp.js';
import { ConformanceMainThreadMcp, InProcessMcpTransport, parseConformanceContext, redactSecrets, StderrLogger } from '../../node/mcpConformanceProxy.js';

const TEST_URL = 'http://localhost:1/mcp';
const LAUNCH: McpServerTransportHTTP = { type: McpServerTransportType.HTTP, uri: URI.parse(TEST_URL), headers: [] };

interface IRecordedRequest {
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string | undefined;
}

function jsonResponse(body: string, status = 200): CommonResponse {
	return {
		status,
		statusText: 'status',
		url: TEST_URL,
		headers: new Headers({ 'Content-Type': 'application/json' }),
		body: null,
		json: async () => JSON.parse(body),
		text: async () => body,
	};
}

suite('MCP conformance - proxy', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseConformanceContext', () => {
		test('returns an empty context without input or for invalid JSON', () => {
			assert.deepStrictEqual(parseConformanceContext(undefined), { raw: {} });
			assert.deepStrictEqual(parseConformanceContext(''), { raw: {} });
			assert.deepStrictEqual(parseConformanceContext('{not json'), { raw: {} });
			assert.deepStrictEqual(parseConformanceContext('[1, 2]'), { raw: {} });
		});

		test('reads the credentials and tool calls and keeps every key in raw', () => {
			const context = parseConformanceContext(JSON.stringify({
				name: 'http-custom-headers',
				client_id: 'id',
				client_secret: 'secret',
				private_key_pem: 'pem',
				toolCalls: [{ name: 'a', arguments: { x: 1 } }, { name: 'b' }, { arguments: {} }, 'junk'],
			}));
			assert.strictEqual(context.client_id, 'id');
			assert.strictEqual(context.client_secret, 'secret');
			assert.deepStrictEqual(context.toolCalls, [{ name: 'a', arguments: { x: 1 } }, { name: 'b', arguments: {} }]);
			assert.strictEqual(context.raw.private_key_pem, 'pem');
			assert.strictEqual(context.raw.name, 'http-custom-headers');
		});

		test('ignores credentials of the wrong type', () => {
			const context = parseConformanceContext(JSON.stringify({ client_id: 5, toolCalls: 'nope' }));
			assert.strictEqual(context.client_id, undefined);
			assert.strictEqual(context.toolCalls, undefined);
		});
	});

	suite('redactSecrets', () => {
		test('blanks authorization headers and bearer tokens', () => {
			assert.strictEqual(redactSecrets('Authorization: Bearer abc.def-123'), 'Authorization: [redacted]');
			assert.strictEqual(redactSecrets('{"authorization":"Basic dXNlcjpwYXNz"}'), '{"authorization":"[redacted]"}');
			assert.strictEqual(redactSecrets('Proxy-Authorization: Negotiate YIIGhgYJKoZIhvcSAQICAQ'), 'Proxy-Authorization: [redacted]');
			assert.strictEqual(redactSecrets('Authorization: Token abc'), 'Authorization: [redacted]', 'any scheme');
			assert.strictEqual(redactSecrets('sending Bearer eyJhbGci to the server'), 'sending Bearer [redacted] to the server');
			assert.strictEqual(redactSecrets('scheme DPoP eyJhbGci'), 'scheme DPoP [redacted]');
		});

		test('blanks token and registration response fields and query parameters', () => {
			assert.strictEqual(redactSecrets('{"access_token":"at","refresh_token":"rt","client_secret":"cs","token_type":"bearer"}'), '{"access_token":"[redacted]","refresh_token":"[redacted]","client_secret":"[redacted]","token_type":"bearer"}');
			assert.strictEqual(redactSecrets('http://localhost/cb?code=abc123&state=xyz'), 'http://localhost/cb?code=[redacted]&state=xyz');
			assert.strictEqual(redactSecrets('grant_type=authorization_code&code=abc&client_secret=s'), 'grant_type=authorization_code&code=[redacted]&client_secret=[redacted]');
		});

		test('uses the OAuth client\'s redaction: verifiers, assertions, JSON codes, Location; and blanks cookies', () => {
			assert.strictEqual(redactSecrets('grant_type=authorization_code&code=c&code_verifier=v123&redirect_uri=http%3A%2F%2F127.0.0.1'), 'grant_type=authorization_code&code=[redacted]&code_verifier=[redacted]&redirect_uri=http%3A%2F%2F127.0.0.1');
			assert.strictEqual(redactSecrets('client_assertion_type=urn%3Ajwt&client_assertion=eyJhbGciOiJSUzI1NiJ9.e30.sig'), 'client_assertion_type=urn%3Ajwt&client_assertion=[redacted]');
			assert.strictEqual(redactSecrets('{"code":"auth-code-1","state":"s"}'), '{"code":"[redacted]","state":"s"}');
			assert.strictEqual(redactSecrets('302 Location: http://127.0.0.1:33418/callback?code=abc&state=s'), '302 Location: [redacted]');
			assert.strictEqual(redactSecrets('Set-Cookie: sid=31d4d96e407aad42; Path=/; HttpOnly'), 'Set-Cookie: [redacted]');
			assert.strictEqual(redactSecrets('{"cookie":"sid=1; theme=dark"}'), '{"cookie":"[redacted]"}');
		});

		test('leaves JSON-RPC error codes alone', () => {
			assert.strictEqual(redactSecrets('{"error":{"code":-32601,"message":"Method not found"}}'), '{"error":{"code":-32601,"message":"Method not found"}}');
		});
	});

	suite('StderrLogger', () => {
		test('writes redacted lines at or above its level', () => {
			const lines: string[] = [];
			const logger = store.add(new StderrLogger(line => lines.push(line), LogLevel.Info));
			logger.debug('hidden');
			logger.info('token is Bearer secret', { Authorization: 'Bearer x' });
			logger.warn('careful');
			logger.error(new Error('boom'));
			assert.strictEqual(lines.length, 3);
			assert.strictEqual(lines[0], '[mcp-conformance] info: token is Bearer [redacted] {"Authorization":"[redacted]"}\n');
			assert.strictEqual(lines[1], '[mcp-conformance] warn: careful\n');
			assert.ok(lines[2].startsWith('[mcp-conformance] error: Error: boom'));
		});

		test('follows level changes', () => {
			const lines: string[] = [];
			const logger = store.add(new StderrLogger(line => lines.push(line), LogLevel.Error));
			logger.info('hidden');
			logger.setLevel(LogLevel.Trace);
			logger.trace('shown');
			assert.deepStrictEqual(lines, ['[mcp-conformance] trace: shown\n']);
		});
	});

	suite('ConformanceMainThreadMcp', () => {
		test('records what the transport reports', () => {
			const proxy = store.add(new ConformanceMainThreadMcp());
			const states: McpConnectionState[] = [];
			const messages: string[] = [];
			const logs: string[] = [];
			const aborts: IMcpRequestAbort[] = [];
			store.add(proxy.onDidChangeState(e => states.push(e.state)));
			store.add(proxy.onDidReceiveMessage(e => messages.push(e.message)));
			store.add(proxy.onDidPublishLog(e => logs.push(`${e.level}:${e.message}`)));
			store.add(proxy.onDidAbortRequest(e => aborts.push(e.abort)));
			proxy.$onDidChangeState(1, { state: McpConnectionState.Kind.Running });
			proxy.$onDidReceiveMessage(1, '{"jsonrpc":"2.0"}');
			proxy.$onDidPublishLog(1, LogLevel.Warning, 'w');
			proxy.$onDidAbortRequest(1, { requestId: 3, reason: 'stream-closed' });
			proxy.$logMcpAuthSetup({ resourceMetadataSource: IAuthResourceMetadataSource.Header, serverMetadataSource: IAuthServerMetadataSource.WellKnown });
			assert.deepStrictEqual(states, [{ state: McpConnectionState.Kind.Running }]);
			assert.deepStrictEqual(messages, ['{"jsonrpc":"2.0"}']);
			assert.deepStrictEqual(logs, [`${LogLevel.Warning}:w`]);
			assert.deepStrictEqual(aborts, [{ requestId: 3, reason: 'stream-closed' }]);
			assert.deepStrictEqual(proxy.authSetups, [{ resourceMetadataSource: IAuthResourceMetadataSource.Header, serverMetadataSource: IAuthServerMetadataSource.WellKnown }]);
		});

		test('allows every server and has no gateway', async () => {
			const proxy = store.add(new ConformanceMainThreadMcp());
			assert.strictEqual(await proxy.$checkMcpServerAllowed(1, 'http://anywhere'), undefined);
			await assert.rejects(() => proxy.$startMcpGateway(), /no MCP gateway/);
			assert.throws(() => proxy.$disposeMcpGateway('g'), /no MCP gateway/);
			assert.strictEqual(await proxy.$getTokenForProviderId(1, 'github', []), undefined);
		});

		test('asks the token source for tokens and has none without one', async () => {
			const proxy = store.add(new ConformanceMainThreadMcp());
			const details: IMcpAuthenticationDetails = {
				authorizationServer: URI.parse('http://as').toJSON(),
				authorizationServerMetadata: { issuer: 'http://as', authorization_endpoint: 'http://as/authorize', token_endpoint: 'http://as/token', response_types_supported: ['code'] },
				resourceMetadata: undefined,
				scopes: ['read'],
			};
			assert.strictEqual(await proxy.$getTokenFromServerMetadata(1, details), undefined);
			const seen: string[] = [];
			proxy.tokenSource = {
				async getToken(d, options) {
					seen.push(`${d.scopes?.join(' ')} ${options?.forceNewRegistration ?? false}`);
					return 'tok';
				},
			};
			assert.strictEqual(await proxy.$getTokenFromServerMetadata(1, details, { forceNewRegistration: true }), 'tok');
			assert.deepStrictEqual(seen, ['read true']);
		});
	});

	suite('InProcessMcpTransport', () => {
		function createTransport(respond: (request: IRecordedRequest) => CommonResponse | Promise<CommonResponse>) {
			const proxy = store.add(new ConformanceMainThreadMcp());
			const requests: IRecordedRequest[] = [];
			const diagnostics: string[] = [];
			let handle: McpHTTPHandle | undefined;
			const transport = store.add(new InProcessMcpTransport(7, proxy, () => {
				handle = new class extends McpHTTPHandle {
					protected override async _fetchInternal(_url: string, init?: CommonRequestInit): Promise<CommonResponse> {
						assert.ok(init);
						const recorded: IRecordedRequest = { method: init.method, headers: { ...init.headers }, body: init.body ? new TextDecoder().decode(init.body) : undefined };
						requests.push(recorded);
						return respond(recorded);
					}
				}(7, LAUNCH, proxy, new NullLogService());
				return handle;
			}, message => diagnostics.push(message)));
			assert.ok(handle);
			return { proxy, transport, requests, diagnostics, handle };
		}

		const envelope: IMcpMessageEnvelope = { kind: 'request', requestId: 1, protocolVersion: '2026-07-28', method: 'tools/list', headers: { 'Mcp-Method': 'tools/list' } };

		test('is running once the handle exists and stops when told', async () => {
			const { transport, proxy } = createTransport(() => jsonResponse('{}'));
			assert.strictEqual(transport.state.get().state, McpConnectionState.Kind.Running);
			transport.stop();
			transport.stop(); // idempotent
			await transport.whenStopped();
			assert.strictEqual(transport.state.get().state, McpConnectionState.Kind.Stopped);
			// a stopped handle reports nothing any more
			proxy.$onDidChangeState(8, { state: McpConnectionState.Kind.Running });
			assert.strictEqual(transport.state.get().state, McpConnectionState.Kind.Stopped, 'events of other handles are ignored');
		});

		test('serializes outgoing messages and delivers the parsed response', async () => {
			const received: JsonRpcMessage[] = [];
			const { transport, requests } = createTransport(() => jsonResponse('{"jsonrpc":"2.0","id":1,"result":{"resultType":"complete","tools":[]}}'));
			store.add(transport.onDidReceiveMessage(m => received.push(m)));
			transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, envelope);
			await timeout(0);
			assert.strictEqual(requests.length, 1);
			assert.strictEqual(requests[0].method, 'POST');
			assert.strictEqual(requests[0].body, '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
			assert.strictEqual(requests[0].headers['Mcp-Method'], 'tools/list');
			assert.strictEqual(requests[0].headers['MCP-Protocol-Version'], '2026-07-28');
			assert.deepStrictEqual(received, [{ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [] } }]);
		});

		test('splits batches and reports unparsable messages instead of throwing', () => {
			const received: JsonRpcMessage[] = [];
			const { transport, proxy, diagnostics } = createTransport(() => jsonResponse('{}'));
			store.add(transport.onDidReceiveMessage(m => received.push(m)));
			proxy.$onDidReceiveMessage(7, '[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":2,"result":{}}]');
			proxy.$onDidReceiveMessage(7, 'not json');
			proxy.$onDidReceiveMessage(7, '42');
			proxy.$onDidReceiveMessage(8, '{"jsonrpc":"2.0","id":9,"result":{}}');
			assert.strictEqual(received.length, 2);
			assert.strictEqual(diagnostics.length, 2);
			assert.ok(diagnostics[0].includes('not JSON'));
			assert.ok(diagnostics[1].includes('not a JSON object'));
		});

		test('forwards aborts and logs of its handle', () => {
			const aborts: IMcpRequestAbort[] = [];
			const logs: string[] = [];
			const { transport, proxy } = createTransport(() => jsonResponse('{}'));
			store.add(transport.onDidAbortRequest(a => aborts.push(a)));
			store.add(transport.onDidLog(l => logs.push(l.message)));
			proxy.$onDidAbortRequest(7, { requestId: 1, reason: 'http-status', httpStatus: 500 });
			proxy.$onDidAbortRequest(8, { requestId: 2, reason: 'http-status', httpStatus: 500 });
			proxy.$onDidPublishLog(7, LogLevel.Info, 'hello');
			assert.deepStrictEqual(aborts, [{ requestId: 1, reason: 'http-status', httpStatus: 500 }]);
			assert.deepStrictEqual(logs, ['hello']);
		});

		test('reports a non-JSON-RPC HTTP failure as an abort of the request', async () => {
			const aborts: IMcpRequestAbort[] = [];
			const { transport } = createTransport(() => jsonResponse('Internal Server Error', 500));
			store.add(transport.onDidAbortRequest(a => aborts.push(a)));
			transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, envelope);
			await timeout(0);
			assert.strictEqual(aborts.length, 1);
			assert.strictEqual(aborts[0].requestId, 1);
			assert.strictEqual(aborts[0].reason, 'http-status');
		});

		test('cancels a request at the transport', async () => {
			let abortSignal: AbortSignal | undefined;
			const { transport } = createTransport(() => new Promise<CommonResponse>(() => { /* never answers */ }));
			const handleWithSignal = transport as unknown as { _handle: McpHTTPHandle & { _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> } };
			const original = handleWithSignal._handle._fetchInternal.bind(handleWithSignal._handle);
			handleWithSignal._handle._fetchInternal = (url, init) => {
				abortSignal = init?.signal;
				return original(url, init);
			};
			transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, envelope);
			await timeout(0);
			assert.ok(abortSignal);
			assert.strictEqual(abortSignal.aborted, false);
			transport.cancelRequest(1);
			assert.strictEqual(abortSignal.aborted, true);
		});

	});

	suite('InProcessMcpTransport under the protocol engine, with a cached legacy revision', () => {
		/**
		 * Starts the engine over a real handle with the negotiation hint McpServer passes for a server that
		 * connected over 2025-11-25 before (or with `negotiationHint`, undefined for a server seen for the
		 * first time); settles with the handler, the error, or 'pending' after 15 s.
		 */
		async function startWithCachedLegacyHint(createHandle: (proxy: ConformanceMainThreadMcp) => McpHTTPHandle, { negotiationHint }: { readonly negotiationHint: IMcpNegotiationHints | undefined } = { negotiationHint: { era: 'legacy', protocolVersion: '2025-11-25' } }) {
			const proxy = store.add(new ConformanceMainThreadMcp());
			const transport = store.add(new InProcessMcpTransport(7, proxy, () => createHandle(proxy)));
			const wire: string[] = [];
			const send = transport.send.bind(transport);
			transport.send = (message, envelope) => {
				wire.push(`${envelope?.method} (${envelope?.protocolVersion})`);
				send(message, envelope);
			};
			const lines: string[] = [];
			const logger = store.add(new StderrLogger(line => lines.push(line), LogLevel.Trace));
			const productService: IProductService = { _serviceBrand: undefined, ...product };
			const instantiationService = store.add(new InstantiationService(new ServiceCollection([IProductService, productService]), true));
			const created = McpServerRequestHandler.create(instantiationService, {
				launch: transport,
				logger,
				taskManager: store.add(new McpTaskManager()),
				transportType: McpServerTransportType.HTTP,
				negotiationHint,
			});
			let deadline: ReturnType<typeof setTimeout> | undefined;
			const settled = await Promise.race([
				created.then(handler => store.add(handler), (error: unknown) => error),
				new Promise<'pending'>(resolve => deadline = setTimeout(() => resolve('pending'), 15_000)),
			]);
			clearTimeout(deadline);
			const outcome = `${settled === 'pending' ? 'no outcome within 15 s' : String(settled)}; wire ${JSON.stringify(wire)}, log ${JSON.stringify(lines)}`;
			return { settled, outcome, transport, wire, lines };
		}

		test('a server that cannot be reached fails the start with the connection error at once, without a probe', async function () {
			this.timeout(30_000);
			// A port nothing listens on.
			const port = await new Promise<number>((resolve, reject) => {
				const server = createServer();
				server.once('error', reject);
				server.listen(0, '127.0.0.1', () => {
					const address = server.address();
					server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')));
				});
			});
			const launch: McpServerTransportHTTP = { type: McpServerTransportType.HTTP, uri: URI.parse(`http://127.0.0.1:${port}/mcp`), headers: [] };
			const { settled, outcome, transport, wire, lines } = await startWithCachedLegacyHint(proxy => new McpHTTPHandle(7, launch, proxy, new NullLogService(), true));
			assert.ok(settled instanceof McpClientError, `the start must fail with the connection error, got ${outcome}`);
			assert.strictEqual(settled.reason, 'request-aborted');
			assert.strictEqual((settled.detail as IMcpRequestAbort).reason, 'transport-error');
			assert.strictEqual(transport.state.get().state, McpConnectionState.Kind.Error);
			assert.deepStrictEqual(wire, ['initialize (2025-11-25)']);
			assert.ok(!lines.some(line => line.includes('Waiting for server to respond')), JSON.stringify(lines));
		});

		const sseServerStarts: { readonly name: string; readonly hint: IMcpNegotiationHints | undefined; readonly wire: readonly string[] }[] = [
			{ name: 'with the cached legacy revision', hint: { era: 'legacy', protocolVersion: '2025-11-25' }, wire: ['initialize (2025-11-25)'] },
			// Its event stream answers the 2026-07-28 probe too: that is a legacy server, not a stream that ends without the response.
			{ name: 'without a hint (probed first)', hint: undefined, wire: ['server/discover (2026-07-28)', 'initialize (2025-11-25)'] },
		];
		for (const { name, hint, wire: expectedWire } of sseServerStarts) {
			test(`an HTTP+SSE server that answers the POST with its event stream connects through the fallback, ${name}`, async function () {
				this.timeout(30_000);
				const encoder = new TextEncoder();
				/** The open event streams of the GET requests: the server answers on the newest one. */
				const getStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
				const eventStream = (events: string[], keepOpen: boolean): CommonResponse => ({
					status: 200,
					statusText: 'OK',
					url: TEST_URL,
					headers: new Headers({ 'Content-Type': 'text/event-stream' }),
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							for (const event of events) {
								controller.enqueue(encoder.encode(event));
							}
							if (keepOpen) {
								getStreams.push(controller);
							} else {
								controller.close();
							}
						},
					}),
					json: async () => ({}),
					text: async () => '',
				});
				const endpoint = 'event: endpoint\ndata: /messages\n\n';
				const posted: string[] = [];
				const { settled, outcome, wire } = await startWithCachedLegacyHint(proxy => new class extends McpHTTPHandle {
					protected override async _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
						if (init?.method === 'GET') {
							return eventStream([endpoint], true);
						}
						if (!url.endsWith('/messages')) {
							// A legacy server that serves its event stream whatever the method.
							return eventStream([endpoint], false);
						}
						const message = JSON.parse(new TextDecoder().decode(init?.body));
						posted.push(message.method);
						if (message.method === 'initialize') {
							const result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy-sse', version: '1.0.0' } };
							getStreams.at(-1)?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`));
						}
						return { status: 202, statusText: 'Accepted', url, headers: new Headers(), body: null, json: async () => ({}), text: async () => '' };
					}
				}(7, LAUNCH, proxy, new NullLogService(), true), { negotiationHint: hint });
				try {
					assert.ok(settled instanceof McpServerRequestHandler, `the start must succeed, got ${outcome}`);
					assert.deepStrictEqual(settled.negotiated, { era: 'legacy', protocolVersion: '2025-11-25' });
					assert.deepStrictEqual(posted.slice(0, 2), ['initialize', 'notifications/initialized']);
					assert.deepStrictEqual(wire.slice(0, expectedWire.length), expectedWire);
				} finally {
					for (const stream of getStreams) {
						try {
							stream.close();
						} catch {
							// the handle cancelled the stream already
						}
					}
				}
			});
		}
	});
});
