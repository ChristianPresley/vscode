/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../instantiation/common/descriptors.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILoggerService, NullLogger, NullLoggerService } from '../../../log/common/log.js';
import { IMcpGatewayInvokeContext, IMcpGatewayServerDescriptor, IMcpGatewayService, IMcpGatewaySingleServerInvoker, IMcpGatewayToolInvoker } from '../../common/mcpGateway.js';
import { LEGACY_TRANSPORT_ERROR, MAX_LISTEN_RESOURCE_SUBSCRIPTIONS } from '../../common/mcpGatewayProtocol.js';
import { MCP_PROTOCOL_VERSION_HEADER } from '../../common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_CLIENT_INFO, META_SERVER_INFO, META_SUBSCRIPTION_ID, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { CONFORMANCE_HIDDEN_TOOL, CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { McpGatewayEventLog, McpGatewayStreamKind } from '../../node/mcpGatewayEventLog.js';
import { ROUTE_RATE_MULTIPLIER } from '../../node/mcpGatewayRateLimit.js';
import { LEGACY_NOT_INITIALIZED, LEGACY_SESSION_NOT_FOUND, LEGACY_SSE_RETRY_MS, MAX_BODY_BYTES, McpGatewayHttpResponse, McpGatewayResponseWriter, McpGatewayRoute, SSE_KEEPALIVE_MS } from '../../node/mcpGatewayRoute.js';
import { IMcpGatewayServiceOptions, McpGatewayService, mcpGatewayServiceDescriptor } from '../../node/mcpGatewayService.js';
import { IMcpGatewayLegacyStreamOptions } from '../../node/mcpGatewaySession.js';
import { httpRequest, jsonOf, LEGACY_HEADERS, legacyHeaders, modernRequest, openHttp, rawHttp, sendHttp, TEST_CLIENT_INFO } from './mcpGatewayTestUtils.js';

interface IJsonRpcBody {
	readonly id?: unknown;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** Waits until the route has closed responses so that `condition` holds. */
async function whenResponsesClosed(route: McpGatewayRoute, condition: () => boolean): Promise<void> {
	while (!condition()) {
		await Event.toPromise(route.onDidCloseResponse);
	}
}

const INITIALIZE = (capabilities: Record<string, unknown> = {}, protocolVersion = '2025-11-25') => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities, clientInfo: { name: 'route-test', version: '1.0.0' } } });

const OTHER_CLIENT_INFO: MCP.Implementation = { name: 'another-client', version: '2.0.0' };

/** A 2026-07-28 `notifications/cancelled` POST from the client that `clientInfo` names (`null`: a client that sends no `_meta`). */
function modernCancel(requestId: string | number, clientInfo: MCP.Implementation | null = TEST_CLIENT_INFO): { body: string; headers: Record<string, string> } {
	const params: Record<string, unknown> = { requestId };
	if (clientInfo) {
		params._meta = { [META_CLIENT_INFO]: clientInfo };
	}
	return {
		body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params }),
		headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', [MCP_PROTOCOL_VERSION_HEADER]: LATEST_MCP_PROTOCOL_VERSION },
	};
}

suite('MCP - GatewayRoute (HTTP)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface ITestGateway {
		readonly service: McpGatewayService;
		readonly url: string;
		readonly route: McpGatewayRoute;
		readonly invoker: IMcpGatewaySingleServerInvoker;
	}

	async function createGateway(invoker?: IMcpGatewaySingleServerInvoker, options?: IMcpGatewayServiceOptions): Promise<ITestGateway> {
		const loggerService = store.add(new NullLoggerService());
		const service = store.add(new McpGatewayService(loggerService, options));
		const upstream = invoker ?? store.add(new McpGatewayConformanceInvoker());
		const handle = store.add(await service.createRoute('test', upstream, { serverInfo: CONFORMANCE_SERVER_INFO }));
		return { service, url: handle.address.toString(true), route: service.getRoute(handle.routeId)!, invoker: upstream };
	}

	async function post(url: string, request: { body: string; headers: Record<string, string> }): Promise<{ status: number; body: IJsonRpcBody; headers: Record<string, unknown> }> {
		const result = await httpRequest(url, { method: 'POST', headers: request.headers, body: request.body });
		return { status: result.status, body: result.text ? jsonOf(result) as IJsonRpcBody : {}, headers: result.headers };
	}

	async function initializeSession(url: string, capabilities: Record<string, unknown> = {}, protocolVersion = '2025-11-25'): Promise<string> {
		const init = await httpRequest(url, { headers: LEGACY_HEADERS, body: INITIALIZE(capabilities, protocolVersion) });
		assert.strictEqual(init.status, 200, init.text);
		const sessionId = init.headers['mcp-session-id'];
		assert.ok(typeof sessionId === 'string' && /^[\x21-\x7e]+$/.test(sessionId), 'visible ASCII session id');
		const initialized = await httpRequest(url, { headers: legacyHeaders(sessionId, protocolVersion), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
		assert.strictEqual(initialized.status, 202);
		return sessionId;
	}

	function getHeaders(sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
		return { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId, [MCP_PROTOCOL_VERSION_HEADER]: '2025-11-25', ...extra };
	}

	/** An invoker whose `wait` tool runs until the test releases it or the request is cancelled. */
	function blockingInvoker(overrides: Partial<IMcpGatewaySingleServerInvoker> = {}) {
		const calls: Array<{ readonly context: IMcpGatewayInvokeContext | undefined; readonly release: DeferredPromise<void> }> = [];
		const onDidCall = store.add(new Emitter<void>());
		const invoker: IMcpGatewaySingleServerInvoker = {
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			listTools: async () => [{ name: 'wait', description: 'Waits until released or cancelled', inputSchema: { type: 'object' } }],
			callTool: async (_name, _args, context) => {
				const release = new DeferredPromise<void>();
				calls.push({ context, release });
				onDidCall.fire();
				const listener = context?.token.onCancellationRequested(() => release.complete());
				try {
					await release.p;
				} finally {
					listener?.dispose();
				}
				return { content: [{ type: 'text', text: context?.token.isCancellationRequested ? 'cancelled' : 'released' }] };
			},
			listResources: async () => [],
			readResource: async () => ({ contents: [] }),
			listResourceTemplates: async () => [],
			...overrides,
		};
		const waitForCalls = async (count: number) => {
			while (calls.length < count) {
				await Event.toPromise(onDidCall.event);
			}
		};
		return { invoker, calls, waitForCalls };
	}

	test('the Host and Origin checks run before the route lookup (403)', async () => {
		const { url, service } = await createGateway();
		const tools = modernRequest('tools/list');
		const evilHost = await httpRequest(url, { headers: { ...tools.headers, Host: 'evil.example.com' }, body: tools.body });
		assert.strictEqual(evilHost.status, 403);
		assert.strictEqual((jsonOf(evilHost) as IJsonRpcBody).error?.code, MCP.INVALID_REQUEST);
		const evilOrigin = await httpRequest(url, { headers: { ...tools.headers, Origin: 'http://evil.example.com' }, body: tools.body });
		assert.strictEqual(evilOrigin.status, 403);
		const unknownRouteEvil = await httpRequest(`http://127.0.0.1:${service.port}/gateway/nope`, { headers: { ...tools.headers, Host: 'evil.example.com' }, body: tools.body });
		assert.strictEqual(unknownRouteEvil.status, 403, 'refused before the route lookup');
		const local = await httpRequest(url, { headers: { ...tools.headers, Host: `localhost:${service.port}`, Origin: `http://localhost:${service.port}` }, body: tools.body });
		assert.strictEqual(local.status, 200, local.text);
	});

	test('extra allowed hosts and origins can be configured', async () => {
		const { url } = await createGateway(undefined, { allowedHosts: ['gateway.test'], allowedOrigins: ['https://app.example.com'] });
		const tools = modernRequest('tools/list');
		assert.strictEqual((await httpRequest(url, { headers: { ...tools.headers, Host: 'gateway.test:8080', Origin: 'https://app.example.com' }, body: tools.body })).status, 200);
		assert.strictEqual((await httpRequest(url, { headers: { ...tools.headers, Origin: 'https://other.example.com' }, body: tools.body })).status, 403);
	});

	test('options reach a service registered through DI; the plain descriptor stays loopback-only', async () => {
		const loggerService = store.add(new NullLoggerService());
		const tools = modernRequest('tools/list');
		const hostAccepted = async (descriptor: SyncDescriptor<IMcpGatewayService>) => {
			const instantiation = new InstantiationService(new ServiceCollection([ILoggerService, loggerService], [IMcpGatewayService, descriptor]), true);
			try {
				const service = instantiation.invokeFunction(accessor => accessor.get(IMcpGatewayService));
				assert.ok(service instanceof McpGatewayService);
				const handle = await service.createRoute('di', store.add(new McpGatewayConformanceInvoker()));
				try {
					return (await httpRequest(handle.address.toString(true), { headers: { ...tools.headers, Host: 'gateway.test' }, body: tools.body })).status;
				} finally {
					handle.dispose();
				}
			} finally {
				instantiation.dispose();
			}
		};
		assert.strictEqual(await hostAccepted(mcpGatewayServiceDescriptor({ allowedHosts: ['gateway.test'] })), 200);
		assert.strictEqual(await hostAccepted(new SyncDescriptor(McpGatewayService)), 403);
	});

	test('a malformed request target is 400 and the server keeps serving', async () => {
		const { url, service } = await createGateway();
		const response = await rawHttp(service.port!, `GET http://[zz HTTP/1.1\r\nHost: 127.0.0.1:${service.port}\r\nConnection: close\r\n\r\n`);
		assert.ok(response.startsWith('HTTP/1.1 400'), response);
		const tools = await post(url, modernRequest('tools/list'));
		assert.strictEqual(tools.status, 200, 'still alive');
	});

	test('an unknown route is 404 with a JSON-RPC -32601 body', async () => {
		const { service } = await createGateway();
		const tools = modernRequest('tools/list');
		for (const path of ['/gateway/unknown', '/', '/gateway', '/gateway/a/b']) {
			const result = await httpRequest(`http://127.0.0.1:${service.port}${path}`, { headers: tools.headers, body: tools.body });
			assert.strictEqual(result.status, 404, path);
			assert.strictEqual((jsonOf(result) as IJsonRpcBody).error?.code, MCP.METHOD_NOT_FOUND);
		}
	});

	test('GET and DELETE without a session are 405, other methods too', async () => {
		const { url } = await createGateway();
		for (const method of ['GET', 'DELETE', 'PUT']) {
			const result = await httpRequest(url, { method, headers: { [MCP_PROTOCOL_VERSION_HEADER]: LATEST_MCP_PROTOCOL_VERSION } });
			assert.strictEqual(result.status, 405, method);
			assert.ok(result.headers.allow);
		}
	});

	test('an oversized body is 413 and malformed JSON is 400 with -32700', async () => {
		const { url } = await createGateway();
		const big = await httpRequest(url, { headers: LEGACY_HEADERS, body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20) });
		assert.strictEqual(big.status, 413);
		const bad = await httpRequest(url, { headers: LEGACY_HEADERS, body: '{"jsonrpc":' });
		assert.strictEqual(bad.status, 400);
		assert.strictEqual((jsonOf(bad) as IJsonRpcBody).error?.code, MCP.PARSE_ERROR);
	});

	test('2026-07-28 request errors map to HTTP statuses and echo the request id', async () => {
		const { url } = await createGateway();
		const missingMeta = modernRequest('tools/list', {}, 41);
		const noMeta = await post(url, { headers: missingMeta.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} }) });
		assert.deepStrictEqual([noMeta.status, noMeta.body.error?.code, noMeta.body.id], [400, MCP.INVALID_PARAMS, 41]);

		const unsupported = modernRequest('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': 'v999.0.0' } }, 42, {}, { [MCP_PROTOCOL_VERSION_HEADER]: 'v999.0.0' });
		const version = await post(url, unsupported);
		assert.deepStrictEqual([version.status, version.body.error?.code], [400, MCP.UNSUPPORTED_PROTOCOL_VERSION]);
		assert.deepStrictEqual(version.body.error?.data, { supported: [LATEST_MCP_PROTOCOL_VERSION], requested: 'v999.0.0' });

		const mismatch = await post(url, modernRequest('tools/list', {}, 43, {}, { 'Mcp-Method': 'prompts/list' }));
		assert.deepStrictEqual([mismatch.status, mismatch.body.error?.code], [400, MCP.HEADER_MISMATCH]);

		// A version of neither era on a body without a _meta version is -32022 before an era is
		// chosen, even without Mcp-Method; it lists the versions of both eras.
		const list = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
		for (const [index, version] of ['v999.0.0', '2099-01-01', ' 2099-01-01 '].entries()) {
			const other = await post(url, { headers: { ...LEGACY_HEADERS, [MCP_PROTOCOL_VERSION_HEADER]: version }, body: list(50 + index) });
			assert.deepStrictEqual([other.status, other.body.error?.code, other.body.id], [400, MCP.UNSUPPORTED_PROTOCOL_VERSION, 50 + index], version);
			assert.deepStrictEqual(other.body.error?.data, { supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS], requested: version.trim() }, version);
		}
		const wrongMethod = await post(url, { headers: { ...LEGACY_HEADERS, [MCP_PROTOCOL_VERSION_HEADER]: 'v999.0.0', 'Mcp-Method': 'prompts/list' }, body: list(53) });
		assert.deepStrictEqual([wrongMethod.status, wrongMethod.body.error?.code], [400, MCP.UNSUPPORTED_PROTOCOL_VERSION]);
		// Unchanged: a header that disagrees with the _meta version is -32020, and a legacy
		// header or an empty one on a body without _meta is legacy traffic without a session.
		const disagrees = await post(url, modernRequest('tools/list', {}, 54, {}, { [MCP_PROTOCOL_VERSION_HEADER]: 'v999.0.0' }));
		assert.deepStrictEqual([disagrees.status, disagrees.body.error?.code], [400, MCP.HEADER_MISMATCH]);
		for (const version of ['2025-11-25', '']) {
			const legacy = await post(url, { headers: { ...LEGACY_HEADERS, [MCP_PROTOCOL_VERSION_HEADER]: version }, body: list(55) });
			assert.deepStrictEqual([legacy.status, legacy.body.error?.code], [400, LEGACY_NOT_INITIALIZED], JSON.stringify(version));
		}

		for (const method of ['initialize', 'ping', 'logging/setLevel', 'resources/subscribe', 'unknown/method']) {
			const removed = await post(url, modernRequest(method, {}, 44));
			assert.deepStrictEqual([removed.status, removed.body.error?.code, removed.body.id], [404, MCP.METHOD_NOT_FOUND, 44], method);
		}

		const capability = await post(url, modernRequest('tools/call', { name: 'test_missing_capability', arguments: {} }, 45));
		assert.deepStrictEqual([capability.status, capability.body.error?.code], [400, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY]);
		assert.deepStrictEqual((capability.body.error?.data as { requiredCapabilities: unknown }).requiredCapabilities, { sampling: {} });

		const tool = await post(url, modernRequest('tools/call', { name: 'no_such_tool', arguments: {} }, 46));
		assert.deepStrictEqual([tool.status, tool.body.error?.code], [400, MCP.INVALID_PARAMS]);

		const headers = modernRequest('tools/list').headers;
		assert.strictEqual((await post(url, { headers, body: JSON.stringify([JSON.parse(modernRequest('tools/list').body)]) })).status, 400, 'no batches');
		assert.strictEqual((await post(url, { headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })).status, 400, 'no responses');
		const notification = await httpRequest(url, modernCancel('nothing'));
		assert.deepStrictEqual([notification.status, notification.text], [202, '']);
	});

	test('an unexpected failure while preparing a 2026-07-28 request is 500 with -32603, not 202', async () => {
		const brokenSchema = { type: 'object' } as MCPLegacy.Tool['inputSchema'];
		Object.defineProperty(brokenSchema, 'properties', { enumerable: true, get: () => { throw new Error('broken schema'); } });
		const { invoker } = blockingInvoker({ listTools: async () => [{ name: 'wait', description: 'A tool with a schema that cannot be read', inputSchema: brokenSchema }] });
		const { url, route } = await createGateway(invoker);
		const result = await post(url, modernRequest('tools/call', { name: 'wait', arguments: {} }, 7));
		assert.deepStrictEqual([result.status, result.body.id, result.body.error?.code], [500, 7, MCP.INTERNAL_ERROR]);
		assert.strictEqual(result.body.error?.message, 'Internal server error', 'no internal details leak');
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('a client that goes away while its request is validated does not run the tool', async () => {
		const listing = new DeferredPromise<void>();
		const listed = new DeferredPromise<void>();
		const { invoker, calls } = blockingInvoker({
			listTools: async () => {
				listed.complete();
				await listing.p;
				return [{ name: 'wait', description: 'Waits', inputSchema: { type: 'object' } }];
			},
		});
		const { url, route } = await createGateway(invoker);
		const call = modernRequest('tools/call', { name: 'wait', arguments: {} }, 1);
		const pending = await sendHttp(url, { method: 'POST', headers: call.headers, body: call.body });
		await listed.p;
		pending.abort();
		await whenResponsesClosed(route, () => route.openResponses === 0);
		listing.complete();
		// Let the validation finish, then make sure the gateway did not dispatch the call.
		await timeout(20);
		assert.strictEqual((await post(url, modernRequest('tools/list', {}, 2))).status, 200);
		assert.strictEqual(calls.length, 0, 'the tool never ran');
		assert.strictEqual(await pending.response, undefined);
	});

	test('2026-07-28 answers are JSON unless notifications are produced, then SSE; never a session id', async () => {
		const { url } = await createGateway();
		const list = await httpRequest(url, { ...modernRequest('tools/list'), method: 'POST' });
		assert.strictEqual(list.status, 200);
		assert.ok(String(list.headers['content-type']).startsWith('application/json'));
		assert.strictEqual(list.headers['mcp-session-id'], undefined);
		const result = (jsonOf(list) as IJsonRpcBody).result!;
		assert.strictEqual(result.resultType, 'complete');
		assert.deepStrictEqual((result._meta as Record<string, unknown>)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
		assert.ok(typeof result.ttlMs === 'number' && typeof result.cacheScope === 'string');

		const progress = modernRequest('tools/call', { name: 'test_tool_with_progress', arguments: {}, _meta: { progressToken: 'p' } }, 7);
		const stream = await openHttp(url, { method: 'POST', headers: progress.headers, body: progress.body });
		assert.ok(stream.contentType.startsWith('text/event-stream'));
		assert.strictEqual(stream.headers['x-accel-buffering'], 'no');
		await stream.ended;
		const methods = stream.messages.map(m => (m as { method?: string }).method ?? 'response');
		assert.deepStrictEqual(methods, ['notifications/progress', 'notifications/progress', 'notifications/progress', 'response']);
		assert.ok(stream.events.every(e => e.id === undefined), '2026-07-28 streams are not resumable');
		assert.strictEqual((stream.messages[3] as IJsonRpcBody).id, 7);
	});

	test('concurrent POSTs are served independently', async () => {
		const { url } = await createGateway();
		const calls = await Promise.all([1, 2, 3, 4, 5].map(id => post(url, modernRequest('tools/call', { name: id % 2 ? 'test_simple_text' : 'test_tool_with_logging', arguments: {} }, id))));
		assert.deepStrictEqual(calls.map(c => [c.status, c.body.id]), [[200, 1], [200, 2], [200, 3], [200, 4], [200, 5]]);
	});

	test('rate limits (service option): tools/call and completion/complete over the limit are -32603 rate_limited, per client, on both revisions', async () => {
		// A token every ~17 minutes: what is refused stays refused for the test.
		const { url } = await createGateway(undefined, { rateLimits: { toolCalls: { perSecond: 0.001, burst: 2 }, completions: { perSecond: 0.001, burst: 1 } } });
		const assertRateLimited = (response: { status: number; body: IJsonRpcBody }, id: unknown, method: string) => {
			assert.strictEqual(response.status, 200, 'an application error: status 200, the error in the body');
			assert.strictEqual(response.body.id, id);
			assert.strictEqual(response.body.error?.code, MCP.INTERNAL_ERROR);
			const data = response.body.error?.data as { reason?: unknown; retryAfterMs?: unknown; method?: unknown };
			assert.deepStrictEqual([data.reason, data.method], ['rate_limited', method]);
			assert.ok(typeof data.retryAfterMs === 'number' && data.retryAfterMs > 0);
		};
		const call = (id: number, params: Record<string, unknown> = {}) => post(url, modernRequest('tools/call', { name: 'test_simple_text', arguments: {}, ...params }, id));
		assert.strictEqual((await call(1)).body.result?.resultType, 'complete');
		assert.strictEqual((await call(2)).body.result?.resultType, 'complete');
		assertRateLimited(await call(3), 3, 'tools/call');
		// Another client (its own _meta client info) has its own bucket.
		assert.strictEqual((await call(4, { _meta: { [META_CLIENT_INFO]: OTHER_CLIENT_INFO } })).body.result?.resultType, 'complete');
		const completion = (id: number) => post(url, modernRequest('completion/complete', { ref: { type: 'ref/prompt', name: 'test_prompt_with_arguments' }, argument: { name: 'arg1', value: '' } }, id));
		assert.ok((await completion(5)).body.result);
		assertRateLimited(await completion(6), 6, 'completion/complete');
		// Other methods are not limited.
		assert.ok((await post(url, modernRequest('tools/list', {}, 7))).body.result);

		// 2025-11-25: each session is a client.
		const legacyCall = async (sessionId: string, id: number) => {
			const response = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'test_simple_text', arguments: {} } }) });
			return { status: response.status, body: jsonOf(response) as IJsonRpcBody };
		};
		const session = await initializeSession(url);
		assert.ok((await legacyCall(session, 10)).body.result?.content);
		assert.ok((await legacyCall(session, 11)).body.result?.content);
		assertRateLimited(await legacyCall(session, 12), 12, 'tools/call');
		const other = await initializeSession(url);
		assert.ok((await legacyCall(other, 13)).body.result?.content);
	});

	test('rate limits: a client that changes its _meta client info, or opens a new 2025-11-25 session, at each call is held to the route-wide ceiling', async () => {
		// A token every ~17 minutes: the route-wide bucket holds ROUTE_RATE_MULTIPLIER calls.
		const { url } = await createGateway(undefined, { rateLimits: { toolCalls: { perSecond: 0.001, burst: 1 }, completions: false } });
		const call = (id: number) => post(url, modernRequest('tools/call', { name: 'test_simple_text', arguments: {}, _meta: { [META_CLIENT_INFO]: { name: 'rotating', version: `${id}.0.0` } } }, id));
		const outcomes: unknown[] = [];
		for (let id = 1; id <= ROUTE_RATE_MULTIPLIER - 1; id++) {
			const response = await call(id);
			outcomes.push(response.body.result?.resultType ?? (response.body.error?.data as { reason?: unknown } | undefined)?.reason);
		}
		const session = await initializeSession(url);
		const legacy = await httpRequest(url, { headers: legacyHeaders(session), body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'test_simple_text', arguments: {} } }) });
		assert.ok((jsonOf(legacy) as IJsonRpcBody).result?.content, 'a new session is a new client, within the ceiling');
		for (let id = ROUTE_RATE_MULTIPLIER; id <= ROUTE_RATE_MULTIPLIER + 2; id++) {
			const response = await call(id);
			outcomes.push(response.body.result?.resultType ?? (response.body.error?.data as { reason?: unknown } | undefined)?.reason);
		}
		assert.deepStrictEqual(outcomes, [...new Array(ROUTE_RATE_MULTIPLIER - 1).fill('complete'), 'rate_limited', 'rate_limited', 'rate_limited']);
		const another = await initializeSession(url);
		const refused = await httpRequest(url, { headers: legacyHeaders(another), body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'test_simple_text', arguments: {} } }) });
		assert.strictEqual(((jsonOf(refused) as IJsonRpcBody).error?.data as { reason?: unknown } | undefined)?.reason, 'rate_limited', 'and so is the next session');
	});

	test('subscriptions/listen: acknowledgement first, honoured filter, tagged notifications; a cancelled stream ends without a result', async () => {
		const { url, route } = await createGateway();
		const listen = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true, resourceSubscriptions: ['test://watched-resource'] } }, 'listen-1');
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		assert.ok(stream.contentType.startsWith('text/event-stream'));
		const ack = await stream.message(0);
		assert.deepStrictEqual(ack, {
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: { _meta: { [META_SUBSCRIPTION_ID]: 'listen-1' }, notifications: { toolsListChanged: true, resourceSubscriptions: ['test://watched-resource'] } },
		});
		assert.strictEqual(route.openListenStreams, 1);

		await post(url, modernRequest('tools/call', { name: 'test_trigger_tool_change', arguments: {} }, 2));
		await post(url, modernRequest('tools/call', { name: 'test_trigger_prompt_change', arguments: {} }, 3));
		const changed = await stream.message(1);
		assert.deepStrictEqual(changed, { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { [META_SUBSCRIPTION_ID]: 'listen-1' } } });

		const cancel = await httpRequest(url, modernCancel('listen-1'));
		assert.strictEqual(cancel.status, 202);
		await stream.ended;
		// basic/patterns/cancellation: a server SHOULD NOT respond to a cancelled request; the graceful result is for streams the server ends.
		assert.deepStrictEqual(stream.messages.filter(m => (m as IJsonRpcBody).id !== undefined), [], 'no subscriptions/listen response');
		assert.ok(stream.messages.every(m => (m as { method?: string }).method !== 'notifications/prompts/list_changed'), 'prompts were not requested');
		assert.strictEqual(route.openListenStreams, 0);
	});

	test('subscriptions/listen ends when the client goes away, and a filter is required', async () => {
		const { url, route } = await createGateway();
		const bad = await post(url, modernRequest('subscriptions/listen', {}, 1));
		assert.deepStrictEqual([bad.status, bad.body.error?.code], [400, MCP.INVALID_PARAMS]);

		const listen = modernRequest('subscriptions/listen', { notifications: { promptsListChanged: true } }, 2);
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		await stream.message(0);
		assert.strictEqual(route.openListenStreams, 1);
		stream.close();
		await whenResponsesClosed(route, () => route.openListenStreams === 0 && route.openResponses === 0);
	});

	test('subscriptions/listen: a malformed filter is 400 with -32602, not an internal error', async () => {
		const { url, route } = await createGateway();
		for (const notifications of [{ resourceSubscriptions: 'x' }, { resourceSubscriptions: [1] }, { toolsListChanged: 'yes' }, { promptsListChanged: 1 }, { resourcesListChanged: null }, 'all', ['toolsListChanged']]) {
			const result = await post(url, modernRequest('subscriptions/listen', { notifications }, 'bad'));
			assert.deepStrictEqual([result.status, result.body.id, result.body.error?.code], [400, 'bad', MCP.INVALID_PARAMS], JSON.stringify(notifications));
			assert.ok(!/TypeError|is not a function|undefined/.test(result.body.error?.message ?? ''), result.body.error?.message);
		}
		assert.strictEqual(route.openListenStreams, 0);
		// Unknown keys are ignored.
		const listen = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true, somethingElse: 'x' } }, 'ok');
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		assert.deepStrictEqual(((await stream.message(0)).params as { notifications: unknown }).notifications, { toolsListChanged: true });
		stream.close();
		await whenResponsesClosed(route, () => route.openListenStreams === 0);
	});

	test('subscriptions/listen: a filter over the resource subscription limit is -32603 and opens nothing on the server; repeated URIs are subscribed once', async () => {
		const subscribed: string[] = [];
		const { invoker } = blockingInvoker({
			capabilities: { resources: { subscribe: true, listChanged: true } },
			subscribeResource: async uri => {
				subscribed.push(uri);
				return { dispose: () => { } };
			},
		});
		const { url, route } = await createGateway(invoker);
		const uris = Array.from({ length: MAX_LISTEN_RESOURCE_SUBSCRIPTIONS + 1 }, (_, i) => `test://r/${i}`);
		const refused = await post(url, modernRequest('subscriptions/listen', { notifications: { resourceSubscriptions: uris } }, 'big'));
		assert.deepStrictEqual([refused.status, refused.body.id, refused.body.error?.code], [200, 'big', MCP.INTERNAL_ERROR]);
		assert.deepStrictEqual([route.openListenStreams, subscribed.length], [0, 0]);

		const listen = modernRequest('subscriptions/listen', { notifications: { resourceSubscriptions: ['test://a', 'test://a', 'test://b'] } }, 'dup');
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		assert.deepStrictEqual(((await stream.message(0)).params as { notifications: unknown }).notifications, { resourceSubscriptions: ['test://a', 'test://b'] });
		assert.deepStrictEqual(subscribed, ['test://a', 'test://b']);
		stream.close();
		await whenResponsesClosed(route, () => route.openListenStreams === 0 && route.openResponses === 0);
	});

	/** A route with a small {@link IMcpGatewayRouteOptions.maxBufferedSseBytes}, and a resource whose updates are large events. */
	async function createSmallBufferGateway() {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService())));
		const handle = store.add(await service.createRoute('test', invoker, { maxBufferedSseBytes: 64 * 1024 }));
		const bigUri = `test://big/${'x'.repeat(32 * 1024)}`;
		/**
		 * Updates the resource until `isOpen` turns false, letting the sockets flush in between; returns the number of updates.
		 * At most 2000 (64 MB): the kernel's socket buffers take a few MB before the gateway's queue grows.
		 */
		const flood = async (isOpen: () => boolean) => {
			let updates = 0;
			while (isOpen() && updates < 2000) {
				invoker.touchResource(bigUri);
				updates++;
				await new Promise<void>(resolve => setImmediate(resolve));
			}
			return updates;
		};
		return { url: handle.address.toString(true), route: service.getRoute(handle.routeId)!, bigUri, flood };
	}

	test('a 2026-07-28 listen stream whose client stops reading is closed once maxBufferedSseBytes are queued, without a result', async () => {
		const { url, route, bigUri, flood } = await createSmallBufferGateway();
		const listen = modernRequest('subscriptions/listen', { notifications: { resourceSubscriptions: [bigUri] } }, 'slow');
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		await stream.message(0);
		stream.pause();
		const updates = await flood(() => route.openListenStreams > 0);
		assert.strictEqual(route.openListenStreams, 0, `the stream is still open after ${updates} updates of ${bigUri.length} characters`);
		stream.resume();
		await stream.ended;
		assert.ok(stream.messages.length < updates + 1, 'the queued events were dropped');
		assert.deepStrictEqual(stream.messages.filter(m => (m as IJsonRpcBody).id !== undefined), [], 'no subscriptions/listen response');
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('2025-11-25: a GET stream whose client stops reading is closed once maxBufferedSseBytes are queued; the session lives on', async () => {
		const { url, route, bigUri, flood } = await createSmallBufferGateway();
		const sessionId = await initializeSession(url);
		const subscribed = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: bigUri } }) });
		assert.deepStrictEqual([subscribed.status, (jsonOf(subscribed) as IJsonRpcBody).result], [200, {}]);
		const get = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId) });
		await get.event(0);
		const session = route.getSession(sessionId)!;
		assert.strictEqual(session.streamCount, 1);
		get.pause();
		const updates = await flood(() => session.streamCount > 0);
		assert.strictEqual(session.streamCount, 0, `the GET stream is still open after ${updates} updates of ${bigUri.length} characters`);
		get.resume();
		await get.ended;
		assert.strictEqual(route.getSession(sessionId), session, 'the session lives on');
		const again = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId) });
		await again.event(0);
		assert.strictEqual(session.streamCount, 1, 'and takes a new GET stream');
		again.close();
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('closing a 2026-07-28 response stream cancels the request', async () => {
		const cancelled = new DeferredPromise<void>();
		const invoker: IMcpGatewaySingleServerInvoker = {
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			listTools: async () => [{ name: 'wait', description: 'Waits for cancellation', inputSchema: { type: 'object' } }],
			callTool: async (_name, _args, context) => {
				context?.onProgress?.({ progress: 1 });
				await new Promise<void>(resolve => {
					const listener = context?.token.onCancellationRequested(() => {
						listener?.dispose();
						resolve();
					});
				});
				cancelled.complete();
				return { content: [] };
			},
			listResources: async () => [],
			readResource: async () => ({ contents: [] }),
			listResourceTemplates: async () => [],
		};
		const { url, route } = await createGateway(invoker);
		const call = modernRequest('tools/call', { name: 'wait', arguments: {}, _meta: { progressToken: 1 } }, 1);
		const stream = await openHttp(url, { method: 'POST', headers: call.headers, body: call.body });
		await stream.message(0);
		stream.close();
		await cancelled.p;
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('notifications/cancelled reaches only the requests and listen streams of the client that sent it', async () => {
		const { invoker, calls, waitForCalls } = blockingInvoker();
		const { url, route } = await createGateway(invoker);
		const callA = modernRequest('tools/call', { name: 'wait', arguments: {} }, 1);
		const callB = modernRequest('tools/call', { name: 'wait', arguments: {}, _meta: { [META_CLIENT_INFO]: OTHER_CLIENT_INFO } }, 1);
		const a = await sendHttp(url, { method: 'POST', headers: callA.headers, body: callA.body });
		await waitForCalls(1);
		const b = await sendHttp(url, { method: 'POST', headers: callB.headers, body: callB.body });
		await waitForCalls(2);

		// A cancellation without client info is ambiguous here (two clients of this address have id 1): it reaches neither.
		assert.strictEqual((await httpRequest(url, modernCancel(1, null))).status, 202);
		assert.deepStrictEqual(calls.map(c => c.context?.token.isCancellationRequested), [false, false]);

		assert.strictEqual((await httpRequest(url, modernCancel(1, TEST_CLIENT_INFO))).status, 202);
		const responseA = (await a.response)!;
		await responseA.ended;
		assert.deepStrictEqual([responseA.status, responseA.contentType.startsWith('text/event-stream'), responseA.messages], [200, true, []], 'a cancelled request gets an empty event stream: no response, and no 202');
		assert.deepStrictEqual(calls.map(c => c.context?.token.isCancellationRequested), [true, false], 'the other client\'s request with the same id runs on');

		calls[1].release.complete();
		const responseB = (await b.response)!;
		await responseB.ended;
		assert.strictEqual(responseB.status, 200);
		assert.deepStrictEqual((JSON.parse(responseB.text) as IJsonRpcBody).result?.content, [{ type: 'text', text: 'released' }]);

		// Listen streams too: two clients, one listen request id.
		const listenA = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true } }, 'L');
		const listenB = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true }, _meta: { [META_CLIENT_INFO]: OTHER_CLIENT_INFO } }, 'L');
		const streamA = await openHttp(url, { method: 'POST', headers: listenA.headers, body: listenA.body });
		const streamB = await openHttp(url, { method: 'POST', headers: listenB.headers, body: listenB.body });
		await streamA.message(0);
		await streamB.message(0);
		assert.strictEqual(route.openListenStreams, 2);
		assert.strictEqual((await httpRequest(url, modernCancel('L', OTHER_CLIENT_INFO))).status, 202);
		await streamB.ended;
		assert.deepStrictEqual(streamB.messages.map(m => (m as { method?: string }).method), ['notifications/subscriptions/acknowledged'], 'ended without a subscriptions/listen response');
		assert.strictEqual(route.openListenStreams, 1);
		assert.strictEqual(streamA.isDone, false, 'the first client\'s stream stays open');
		streamA.close();
		await whenResponsesClosed(route, () => route.openListenStreams === 0 && route.openResponses === 0);
	});

	test('notifications/cancelled without _meta reaches the request and the listen stream of the only client of its address with that id', async () => {
		const { invoker, calls, waitForCalls } = blockingInvoker();
		const { url, route } = await createGateway(invoker);
		// The request names its client (requests SHOULD carry clientInfo); the cancellation does not (notifications need not carry _meta).
		const call = modernRequest('tools/call', { name: 'wait', arguments: {} }, 5);
		const pending = await sendHttp(url, { method: 'POST', headers: call.headers, body: call.body });
		await waitForCalls(1);
		assert.strictEqual((await httpRequest(url, modernCancel(5, null))).status, 202);
		assert.strictEqual(calls[0].context?.token.isCancellationRequested, true, 'the nameless cancellation reached the only request with id 5');
		const response = (await pending.response)!;
		await response.ended;
		assert.deepStrictEqual([response.status, response.messages], [200, []]);

		const listen = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true } }, 'L2');
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		await stream.message(0);
		assert.strictEqual((await httpRequest(url, modernCancel('L2', null))).status, 202);
		assert.strictEqual(route.openListenStreams, 0, 'closed when the cancellation was accepted');
		await stream.ended;
		assert.deepStrictEqual(stream.messages.map(m => (m as { method?: string }).method), ['notifications/subscriptions/acknowledged'], 'without a subscriptions/listen response');
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('notifications/cancelled without _meta is ambiguous across listen streams and requests: two clients of the address use the id, one for each, and it cancels neither', async () => {
		const { invoker, calls, waitForCalls } = blockingInvoker({ capabilities: { tools: { listChanged: true } } });
		const { url, route } = await createGateway(invoker);
		const listen = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true } }, 7);
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		await stream.message(0);
		const call = modernRequest('tools/call', { name: 'wait', arguments: {}, _meta: { [META_CLIENT_INFO]: OTHER_CLIENT_INFO } }, 7);
		const pending = await sendHttp(url, { method: 'POST', headers: call.headers, body: call.body });
		await waitForCalls(1);

		assert.strictEqual((await httpRequest(url, modernCancel(7, null))).status, 202);
		assert.deepStrictEqual([route.openListenStreams, stream.isDone, calls[0].context?.token.isCancellationRequested], [1, false, false], 'neither the listen stream nor the other client\'s request');

		assert.strictEqual((await httpRequest(url, modernCancel(7, OTHER_CLIENT_INFO))).status, 202);
		assert.strictEqual(calls[0].context?.token.isCancellationRequested, true);
		const response = (await pending.response)!;
		await response.ended;
		assert.deepStrictEqual([response.status, response.messages], [200, []]);
		assert.strictEqual(route.openListenStreams, 1, 'the named cancellation reached the request only');

		// With the request gone, one client of the address has id 7: the nameless cancellation reaches its listen stream.
		assert.strictEqual((await httpRequest(url, modernCancel(7, null))).status, 202);
		await stream.ended;
		assert.deepStrictEqual([route.openListenStreams, stream.messages.length], [0, 1]);
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('notifications/cancelled without _meta is ambiguous when a client that sends no client info and a named client of the address use the id: it cancels neither', async () => {
		const { invoker, calls, waitForCalls } = blockingInvoker({ capabilities: { tools: { listChanged: true } } });
		const { url, route } = await createGateway(invoker);
		// Client A names itself nowhere (clientInfo is optional); client B names itself in its request but, like A, sends its cancellation without _meta.
		const listenA = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true }, _meta: { [META_CLIENT_INFO]: undefined } }, 9);
		const stream = await openHttp(url, { method: 'POST', headers: listenA.headers, body: listenA.body });
		await stream.message(0);
		const callB = modernRequest('tools/call', { name: 'wait', arguments: {}, _meta: { [META_CLIENT_INFO]: OTHER_CLIENT_INFO } }, 9);
		const pending = await sendHttp(url, { method: 'POST', headers: callB.headers, body: callB.body });
		await waitForCalls(1);

		// The cancellation matches A's key exactly, but B may have sent it: it reaches neither.
		assert.strictEqual((await httpRequest(url, modernCancel(9, null))).status, 202);
		assert.deepStrictEqual([route.openListenStreams, stream.isDone, calls[0].context?.token.isCancellationRequested], [1, false, false], 'neither the nameless client\'s listen stream nor the named client\'s request');

		calls[0].release.complete();
		const response = (await pending.response)!;
		await response.ended;
		assert.deepStrictEqual((JSON.parse(response.text) as IJsonRpcBody).result?.content, [{ type: 'text', text: 'released' }]);

		// Once B's request is done, A is the only client of the address with id 9.
		assert.strictEqual((await httpRequest(url, modernCancel(9, null))).status, 202);
		await stream.ended;
		assert.deepStrictEqual([route.openListenStreams, stream.messages.map(m => (m as { method?: string }).method)], [0, ['notifications/subscriptions/acknowledged']]);
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('2025-11-25 session lifecycle: initialize, session header, GET stream, DELETE', async () => {
		const { url, route } = await createGateway();
		const noSession = await httpRequest(url, { headers: LEGACY_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
		assert.deepStrictEqual([noSession.status, (jsonOf(noSession) as IJsonRpcBody).error?.code], [400, LEGACY_NOT_INITIALIZED]);

		const sessionId = await initializeSession(url);
		assert.strictEqual(route.sessionCount, 1);
		const list = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
		assert.strictEqual(list.status, 200);
		assert.strictEqual(list.headers['mcp-session-id'], sessionId);
		assert.strictEqual((jsonOf(list) as IJsonRpcBody).result?.resultType, undefined);

		const unknown = await httpRequest(url, { headers: legacyHeaders('not-a-session'), body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) });
		assert.deepStrictEqual([unknown.status, (jsonOf(unknown) as IJsonRpcBody).error?.code], [404, LEGACY_SESSION_NOT_FOUND]);

		const get = await openHttp(url, { method: 'GET', headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId, 'Last-Event-ID': '17' } });
		assert.strictEqual(get.status, 200);
		const priming = await get.event(0);
		assert.ok(priming.id && priming.id.length > 0);
		assert.strictEqual(priming.retry, LEGACY_SSE_RETRY_MS);
		assert.strictEqual(priming.data, '');

		// list_changed goes to the session's GET stream, with event ids.
		assert.strictEqual(route.getSession(sessionId)?.streamCount, 1);
		await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'test_trigger_tool_change', arguments: {} } }) });
		const changed = await get.messageWhere(m => m.method === 'notifications/tools/list_changed');
		assert.ok(changed);
		assert.ok(get.events.filter(e => e.data).every(e => e.id !== undefined), 'legacy events carry ids');

		const deleted = await httpRequest(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
		assert.strictEqual(deleted.status, 204);
		await get.ended;
		assert.strictEqual(route.sessionCount, 0);
		const gone = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }) });
		assert.strictEqual(gone.status, 404);
		assert.strictEqual((await httpRequest(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } })).status, 404);
		assert.strictEqual((await httpRequest(url, { method: 'GET', headers: { 'Mcp-Session-Id': sessionId } })).status, 404);
	});

	test('2025-11-25: a route keeps at most maxLegacySessions sessions: a new one replaces the least recently active idle session, and is refused with 503 while every session is busy', async () => {
		const { invoker, calls, waitForCalls } = blockingInvoker();
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService())));
		const handle = store.add(await service.createRoute('test', invoker, { maxLegacySessions: 2 }));
		const url = handle.address.toString(true);
		const route = service.getRoute(handle.routeId)!;
		const listTools = (sessionId: string, id: number) => httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) });

		const first = await initializeSession(url);
		await timeout(5);
		const second = await initializeSession(url);
		await timeout(5);
		assert.strictEqual((await listTools(first, 2)).status, 200, 'the first session is now the more recently active one');
		await timeout(5);
		const third = await initializeSession(url);
		assert.strictEqual(route.sessionCount, 2);
		assert.deepStrictEqual([(await listTools(second, 3)).status, (await listTools(first, 4)).status, (await listTools(third, 5)).status], [404, 200, 200], 'the least recently active session was closed');

		// Both sessions busy: a new session is refused, nothing is closed.
		const busy = await Promise.all([first, third].map((sessionId, i) => sendHttp(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'wait', arguments: {} } }) })));
		await waitForCalls(2);
		const refused = await httpRequest(url, { headers: LEGACY_HEADERS, body: INITIALIZE() });
		assert.deepStrictEqual([refused.status, refused.headers['retry-after'], (jsonOf(refused) as IJsonRpcBody).error?.code], [503, '1', LEGACY_TRANSPORT_ERROR]);
		assert.strictEqual(route.sessionCount, 2);

		for (const call of calls) {
			call.release.complete();
		}
		for (const pending of busy) {
			await (await pending.response)?.ended;
		}
		await initializeSession(url);
		assert.strictEqual(route.sessionCount, 2, 'once a session is idle again, a new one replaces it');
	});

	test('2025-11-25: an invalid or unsupported MCP-Protocol-Version on a session request is 400; absent or supported is accepted', async () => {
		const { url, route } = await createGateway();
		const sessionId = await initializeSession(url);
		const list = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' });
		for (const [index, version] of ['2099-01-01', 'garbage', ''].entries()) {
			const refused = await httpRequest(url, { headers: legacyHeaders(sessionId, version), body: list(index) });
			assert.deepStrictEqual([refused.status, (jsonOf(refused) as IJsonRpcBody).error?.code], [400, LEGACY_TRANSPORT_ERROR], JSON.stringify(version));
			assert.strictEqual((await httpRequest(url, { method: 'GET', headers: getHeaders(sessionId, { [MCP_PROTOCOL_VERSION_HEADER]: version }) })).status, 400, `GET ${version}`);
			assert.strictEqual((await httpRequest(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId, [MCP_PROTOCOL_VERSION_HEADER]: version } })).status, 400, `DELETE ${version}`);
		}
		assert.strictEqual(route.sessionCount, 1, 'a refused DELETE keeps the session');
		assert.strictEqual((await httpRequest(url, { headers: { ...LEGACY_HEADERS, 'Mcp-Session-Id': sessionId }, body: list(10) })).status, 200, 'absent: the negotiated version applies');
		assert.strictEqual((await httpRequest(url, { headers: legacyHeaders(sessionId, '2025-06-18'), body: list(11) })).status, 200, 'another supported revision');
		// initialize itself is not checked: the version is being negotiated.
		const init = await httpRequest(url, { headers: { ...LEGACY_HEADERS, [MCP_PROTOCOL_VERSION_HEADER]: '2099-01-01' }, body: INITIALIZE() });
		assert.strictEqual(init.status, 200);
		assert.strictEqual((await httpRequest(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } })).status, 204);
	});

	test('sessions before 2025-11-25 get no priming events (a comment instead); their events still carry ids', async () => {
		const { url, route } = await createGateway();
		const sessionId = await initializeSession(url, { sampling: {} }, '2025-06-18');
		const get = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId, { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' }) });
		assert.strictEqual(get.status, 200);
		await post(url, { headers: legacyHeaders(sessionId, '2025-06-18'), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'test_trigger_tool_change', arguments: {} } }) });
		await get.messageWhere(m => m.method === 'notifications/tools/list_changed');
		assert.ok(get.text.startsWith(': connected\n\n'), JSON.stringify(get.text.substring(0, 40)));
		assert.ok(get.events.every(e => e.data !== '' && e.retry === undefined && e.id !== undefined), 'no priming event');

		const call = await openHttp(url, { method: 'POST', headers: legacyHeaders(sessionId, '2025-06-18'), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'test_sampling', arguments: { prompt: 'Hi' } } }) });
		const request = await call.message(0);
		assert.strictEqual(request.method, 'sampling/createMessage');
		assert.ok(call.events[0].data !== '' && call.events[0].id !== undefined, 'the first event is the request, not a priming event');
		await httpRequest(url, { headers: legacyHeaders(sessionId, '2025-06-18'), body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { role: 'assistant', content: { type: 'text', text: 'Hello' }, model: 'm', stopReason: 'endTurn' } }) });
		await call.ended;
		get.close();
		await whenResponsesClosed(route, () => route.getSession(sessionId)?.streamCount === 0);
	});

	test('2025-11-25 sampling round: the request goes out on the POST stream, the answer comes back on another POST', async () => {
		const { url, route } = await createGateway();
		const sessionId = await initializeSession(url, { sampling: {} });
		const call = await openHttp(url, { method: 'POST', headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'test_sampling', arguments: { prompt: 'Hello?' } } }) });
		assert.ok(call.contentType.startsWith('text/event-stream'), 'upgraded lazily to SSE');
		const priming = await call.event(0);
		assert.strictEqual(priming.retry, LEGACY_SSE_RETRY_MS);
		const request = await call.message(0);
		assert.strictEqual(request.method, 'sampling/createMessage');
		assert.ok(request.id !== undefined);
		assert.strictEqual(route.getSession(sessionId)?.pendingRequestCount, 1);

		const answer = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { role: 'assistant', content: { type: 'text', text: 'Hi there' }, model: 'test-model', stopReason: 'endTurn' } }) });
		assert.strictEqual(answer.status, 202);
		await call.ended;
		const response = call.messages[1] as IJsonRpcBody;
		assert.strictEqual(response.id, 10);
		assert.deepStrictEqual(response.result?.content, [{ type: 'text', text: 'LLM response: Hi there' }]);
	});

	test('2025-11-25: a client that drops a POST stream has not cancelled: the request runs on, its server request and response are replayed on GET with Last-Event-ID', async () => {
		const { url, route } = await createGateway();
		const sessionId = await initializeSession(url, { elicitation: {} });
		const call = await openHttp(url, { method: 'POST', headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'test_elicitation', arguments: { message: 'Name?' } } }) });
		const priming = await call.event(0);
		assert.ok(priming.id);
		const elicitation = await call.message(0);
		assert.strictEqual(elicitation.method, 'elicitation/create');
		call.close();
		await whenResponsesClosed(route, () => route.openResponses === 0);
		assert.strictEqual(route.getSession(sessionId)?.pendingRequestCount, 1, 'the server request is still waiting for its answer');

		const resumed = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId, { 'Last-Event-ID': priming.id }) });
		assert.strictEqual(resumed.status, 200);
		const replayed = await resumed.message(0);
		assert.deepStrictEqual([replayed.method, replayed.id], ['elicitation/create', elicitation.id], 'the server request is replayed with its id');
		const answer = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: elicitation.id, result: { action: 'accept', content: { username: 'ada', email: 'ada@example.com' } } }) });
		assert.strictEqual(answer.status, 202);
		const response = await resumed.messageWhere(m => m.id === 11);
		assert.deepStrictEqual((response.result as MCPLegacy.CallToolResult).content, [{ type: 'text', text: 'User response: action=accept, content={"username":"ada","email":"ada@example.com"}' }]);
		await resumed.ended;
		assert.ok(resumed.events.every(e => e.id !== undefined), 'every replayed and live event carries its id');
		assert.strictEqual(route.getSession(sessionId)?.pendingRequestCount, 0);

		// notifications/cancelled is still how a legacy client cancels a request whose stream it dropped.
		const { invoker, calls, waitForCalls } = blockingInvoker();
		const blocking = await createGateway(invoker);
		const blockingSession = await initializeSession(blocking.url, { elicitation: {} });
		const pending = await sendHttp(blocking.url, { method: 'POST', headers: legacyHeaders(blockingSession), body: JSON.stringify({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'wait', arguments: {}, _meta: { progressToken: 'p' } } }) });
		await waitForCalls(1);
		// A progress notification turns the answer into a stream.
		calls[0].context?.onProgress?.({ progress: 1 });
		const slow = (await pending.response)!;
		assert.strictEqual((await slow.message(0)).method, 'notifications/progress');
		slow.close();
		await whenResponsesClosed(blocking.route, () => blocking.route.openResponses === 0);
		assert.strictEqual(calls[0].context?.token.isCancellationRequested, false, 'a dropped POST stream is not a cancellation');
		await httpRequest(blocking.url, { headers: legacyHeaders(blockingSession), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } }) });
		assert.strictEqual(calls[0].context?.token.isCancellationRequested, true);
	});

	test('2025-11-25: a client that goes away before anything streamed does not cancel the request either; its answer is dropped', async () => {
		const { invoker, calls, waitForCalls } = blockingInvoker();
		const { url, route } = await createGateway(invoker);
		const sessionId = await initializeSession(url);
		const pending = await sendHttp(url, { method: 'POST', headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 'json', method: 'tools/call', params: { name: 'wait', arguments: {} } }) });
		await waitForCalls(1);
		pending.abort();
		await whenResponsesClosed(route, () => route.openResponses === 0);
		assert.strictEqual(calls[0].context?.token.isCancellationRequested, false);
		calls[0].release.complete();
		// The request finishes on its own; the session keeps serving.
		const list = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
		assert.strictEqual(list.status, 200);
		assert.strictEqual(route.sessionCount, 1);
	});

	test('2025-11-25: a request cancelled with notifications/cancelled gets an empty event stream, not 202', async () => {
		const { invoker, calls, waitForCalls } = blockingInvoker();
		const { url } = await createGateway(invoker);
		const sessionId = await initializeSession(url);
		const pending = await sendHttp(url, { method: 'POST', headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'wait', arguments: {} } }) });
		await waitForCalls(1);
		const cancel = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } }) });
		assert.strictEqual(cancel.status, 202, 'a POST with only a notification is 202');
		const response = (await pending.response)!;
		await response.ended;
		assert.deepStrictEqual([response.status, response.contentType.startsWith('text/event-stream'), response.messages], [200, true, []]);
		assert.strictEqual(calls[0].context?.token.isCancellationRequested, true);
	});

	test('2025-11-25 SEP-1699 polling: test_reconnection closes the POST stream and the result is replayed on GET with Last-Event-ID', async () => {
		const { url, route } = await createGateway();
		const sessionId = await initializeSession(url);
		const call = await openHttp(url, { method: 'POST', headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'test_reconnection', arguments: {} } }) });
		assert.ok(call.contentType.startsWith('text/event-stream'));
		await call.ended;
		const priming = call.events[0];
		assert.ok(priming.id, 'the priming event comes first, with an id');
		assert.deepStrictEqual([priming.retry, priming.data], [LEGACY_SSE_RETRY_MS, '']);
		assert.deepStrictEqual(call.messages, [], 'the stream closed before the result');
		assert.ok(call.text.endsWith(`retry: ${LEGACY_SSE_RETRY_MS}\n\n`), 'a retry hint before the close');

		const resumed = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId, { 'Last-Event-ID': priming.id! }) });
		assert.strictEqual(resumed.status, 200);
		const response = await resumed.messageWhere(m => m.id === 10);
		assert.deepStrictEqual((response.result as MCPLegacy.CallToolResult).content, [{ type: 'text', text: 'Reconnection test completed' }]);
		await resumed.ended;
		assert.ok(resumed.events.every(e => e.id !== undefined && e.data !== ''), 'replayed events carry their ids; no priming on a resumed stream');
		assert.strictEqual(route.getSession(sessionId)?.streamCount, 0, 'a resumed request stream is not one of the session\'s GET streams');

		// The request is over: resuming again replays its response and ends at once.
		const again = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId, { 'Last-Event-ID': priming.id! }) });
		await again.ended;
		assert.deepStrictEqual(again.messages.map(m => (m as IJsonRpcBody).id), [10]);
		// Events are never replayed on another session's streams.
		const other = await initializeSession(url);
		const foreign = await openHttp(url, { method: 'GET', headers: getHeaders(other, { 'Last-Event-ID': priming.id! }) });
		const fresh = await foreign.event(0);
		assert.strictEqual(fresh.data, '', 'an id of another session starts a fresh stream (a priming event)');
		foreign.close();
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('a GET stream resumed with Last-Event-ID gets what it missed and carries on; an open stream cannot be resumed twice', async () => {
		const { url, route } = await createGateway();
		const sessionId = await initializeSession(url);
		const first = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId) });
		const priming = await first.event(0);
		const conflict = await httpRequest(url, { method: 'GET', headers: getHeaders(sessionId, { 'Last-Event-ID': priming.id! }) });
		assert.deepStrictEqual([conflict.status, (jsonOf(conflict) as IJsonRpcBody).error?.code], [409, LEGACY_TRANSPORT_ERROR]);
		first.close();
		await whenResponsesClosed(route, () => route.getSession(sessionId)?.streamCount === 0);

		const trigger = (id: number) => post(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'test_trigger_tool_change', arguments: {} } }) });
		await trigger(2);
		const resumed = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId, { 'Last-Event-ID': priming.id! }) });
		const missed = await resumed.message(0);
		assert.strictEqual(missed.method, 'notifications/tools/list_changed', 'the change made while no stream was open');
		assert.strictEqual(route.getSession(sessionId)?.streamCount, 1);
		await trigger(3);
		await resumed.message(1);
		assert.deepStrictEqual(resumed.messages.map(m => (m as { method: string }).method), ['notifications/tools/list_changed', 'notifications/tools/list_changed']);

		const unknown = await openHttp(url, { method: 'GET', headers: getHeaders(sessionId, { 'Last-Event-ID': 'not-an-id' }) });
		assert.strictEqual((await unknown.event(0)).data, '', 'an unknown id starts a fresh stream');
		assert.strictEqual(route.getSession(sessionId)?.streamCount, 2);
		// One stream only: the most recent open GET stream gets the next change.
		await trigger(4);
		await unknown.messageWhere(m => m.method === 'notifications/tools/list_changed');
		assert.strictEqual(resumed.messages.length, 2, 'the older stream did not get it too');
		resumed.close();
		unknown.close();
		await whenResponsesClosed(route, () => route.openResponses === 0);
	});

	test('stopping the service ends listen streams with their result and closes sessions', async () => {
		const { url, service, route } = await createGateway();
		const sessionId = await initializeSession(url);
		const get = await openHttp(url, { method: 'GET', headers: { 'Mcp-Session-Id': sessionId } });
		await get.event(0);
		const listen = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true } }, 'l');
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		await stream.message(0);
		// The real shutdown path: the service stops its server, and the routes end their long-lived streams first.
		service.dispose();
		await stream.ended;
		await get.ended;
		const final = stream.messages[stream.messages.length - 1] as IJsonRpcBody;
		assert.strictEqual(final.id, 'l');
		assert.strictEqual(final.result?.resultType, 'complete');
		assert.strictEqual(route.sessionCount, 0);
		assert.strictEqual(service.port, undefined, 'the server is stopped');
	});

	test('the hidden tool appears after the trigger tool is called (list changes reach the upstream state)', async () => {
		const { url } = await createGateway();
		const before = await post(url, modernRequest('tools/list', {}, 1));
		assert.ok(!(before.body.result?.tools as Array<{ name: string }>).some(t => t.name === CONFORMANCE_HIDDEN_TOOL));
		const trigger = await post(url, modernRequest('tools/call', { name: 'test_trigger_tool_change', arguments: {} }, 2));
		assert.strictEqual(trigger.status, 200);
		const after = await post(url, modernRequest('tools/list', {}, 3));
		assert.ok((after.body.result?.tools as Array<{ name: string }>).some(t => t.name === CONFORMANCE_HIDDEN_TOOL));
		const hidden = await post(url, modernRequest('tools/call', { name: CONFORMANCE_HIDDEN_TOOL, arguments: {} }, 4));
		assert.deepStrictEqual(hidden.body.result?.content, [{ type: 'text', text: 'hidden' }]);
	});

	test('createGateway: one route per server of an IPC-style invoker, with its optional methods absent', async () => {
		const onDidUpdateResource = store.add(new Emitter<{ readonly serverId: string; readonly uri: string }>());
		const onDidChangeServers = store.add(new Emitter<readonly IMcpGatewayServerDescriptor[]>());
		const capabilitiesRead = new DeferredPromise<void>();
		let capabilityCalls = 0;
		const invoker: IMcpGatewayToolInvoker = {
			onDidChangeServers: onDidChangeServers.event,
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			onDidUpdateResource: onDidUpdateResource.event,
			listServers: () => [{ id: 'a', label: 'Server A' }, { id: 'b', label: 'Server B' }, { id: 'c', label: 'Server C' }],
			getServerCapabilities: async serverId => {
				if (++capabilityCalls === 3) {
					capabilitiesRead.complete();
				}
				switch (serverId) {
					case 'a': return { tools: { listChanged: true }, prompts: { listChanged: false }, resources: { subscribe: true, listChanged: false }, completions: true, logging: false };
					case 'b': return { tools: { listChanged: false }, resources: { subscribe: true } };
					default: return undefined;
				}
			},
			listToolsForServer: async serverId => [{ name: `tool_${serverId}`, description: 'A tool', inputSchema: { type: 'object' } }],
			callToolForServer: async (serverId, name) => ({ content: [{ type: 'text', text: `${serverId}:${name}` }] }),
			listResourcesForServer: async () => [],
			readResourceForServer: async (serverId, uri) => ({ contents: [{ uri, text: serverId }] }),
			listResourceTemplatesForServer: async () => [],
		};
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService())));
		const info = await service.createGateway('client-1', invoker);
		assert.deepStrictEqual(info.servers.map(s => s.label), ['Server A', 'Server B', 'Server C']);
		const [a, b, c] = info.servers.map(s => s.address.toString(true));
		await capabilitiesRead.p;
		await timeout(0);

		// Server A declares its capabilities: they are advertised as declared, and what the invoker cannot serve is empty.
		const discoverA = await post(a, modernRequest('server/discover', {}, 1));
		assert.deepStrictEqual(discoverA.body.result?.capabilities, { tools: { listChanged: true }, resources: { subscribe: true, listChanged: false }, prompts: { listChanged: false }, completions: {} });
		assert.deepStrictEqual((await post(a, modernRequest('prompts/list', {}, 2))).body.result?.prompts, []);
		const completion = await post(a, modernRequest('completion/complete', { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'x', value: '' } }, 3));
		assert.deepStrictEqual(completion.body.result?.completion, { values: [], total: 0, hasMore: false });
		const getPrompt = await post(a, modernRequest('prompts/get', { name: 'p' }, 4));
		assert.deepStrictEqual([getPrompt.status, getPrompt.body.error?.code], [400, MCP.INVALID_PARAMS]);
		// The legacy initialize advertises the same capabilities.
		const init = await httpRequest(a, { headers: LEGACY_HEADERS, body: INITIALIZE() });
		assert.deepStrictEqual((jsonOf(init) as IJsonRpcBody).result?.capabilities, { tools: { listChanged: true }, resources: { subscribe: true, listChanged: false }, prompts: { listChanged: false }, completions: {} });

		// Servers B (declared without prompts) and C (nothing declared, derived from the methods) have no prompts or completions.
		for (const url of [b, c]) {
			const prompts = await post(url, modernRequest('prompts/list', {}, 5));
			assert.deepStrictEqual([prompts.status, prompts.body.error?.code], [404, MCP.METHOD_NOT_FOUND], url);
			const complete = await post(url, modernRequest('completion/complete', { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'x', value: '' } }, 6));
			assert.strictEqual(complete.status, 404, url);
		}
		const discoverC = await post(c, modernRequest('server/discover', {}, 7));
		assert.deepStrictEqual(discoverC.body.result?.capabilities, { tools: { listChanged: true }, resources: { subscribe: false, listChanged: true }, logging: {} });
		assert.deepStrictEqual((await post(b, modernRequest('tools/call', { name: 'tool_b', arguments: {} }, 8))).body.result?.content, [{ type: 'text', text: 'b:tool_b' }]);

		// A resource update reaches only the routes of its server.
		const listen = (url: string) => {
			const request = modernRequest('subscriptions/listen', { notifications: { resourceSubscriptions: ['test://x'] } }, 'r');
			return openHttp(url, { method: 'POST', headers: request.headers, body: request.body });
		};
		const listenA = await listen(a);
		const listenB = await listen(b);
		await listenA.message(0);
		await listenB.message(0);
		onDidUpdateResource.fire({ serverId: 'b', uri: 'test://x' });
		onDidUpdateResource.fire({ serverId: 'a', uri: 'test://x' });
		await listenB.messageWhere(m => m.method === 'notifications/resources/updated');
		await listenA.messageWhere(m => m.method === 'notifications/resources/updated');
		assert.strictEqual(listenA.messages.filter(m => (m as { method?: string }).method === 'notifications/resources/updated').length, 1);
		assert.strictEqual(listenB.messages.filter(m => (m as { method?: string }).method === 'notifications/resources/updated').length, 1);

		await service.disposeGateway(info.gatewayId);
		await listenA.ended;
		await listenB.ended;
		assert.strictEqual(service.port, undefined, 'the last gateway stops the server');
	});
});

const KEEPALIVE = ': keepalive\n\n';

/** The part of an HTTP response the writer uses ({@link McpGatewayHttpResponse}), recording what is written on it. */
class FakeSseResponse {
	readonly chunks: string[] = [];
	headersSent = false;
	destroyed = false;
	writableEnded = false;
	readonly writableLength = 0;
	private readonly _closeListeners: Array<() => void> = [];

	get response(): McpGatewayHttpResponse {
		return this as unknown as McpGatewayHttpResponse;
	}

	get keepalives(): number {
		return this.chunks.filter(chunk => chunk === KEEPALIVE).length;
	}

	writeHead(): this {
		this.headersSent = true;
		return this;
	}

	flushHeaders(): void { }

	write(chunk: string): boolean {
		this.chunks.push(chunk);
		return true;
	}

	end(chunk?: string): this {
		if (chunk !== undefined) {
			this.chunks.push(chunk);
		}
		this.writableEnded = true;
		return this;
	}

	destroy(): this {
		this.destroyed = true;
		return this;
	}

	on(event: string, listener: () => void): this {
		if (event === 'close') {
			this._closeListeners.push(listener);
		}
		return this;
	}

	off(event: string, listener: () => void): this {
		const index = this._closeListeners.indexOf(listener);
		if (index !== -1) {
			this._closeListeners.splice(index, 1);
		}
		return this;
	}

	/** The client goes away: the response's `close` event. */
	close(): void {
		this.destroyed = true;
		for (const listener of [...this._closeListeners]) {
			listener();
		}
	}
}

suite('MCP - GatewayResponseWriter (SSE keep-alive)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function legacyOptions(kind: McpGatewayStreamKind, log: McpGatewayEventLog): IMcpGatewayLegacyStreamOptions {
		return {
			broker: { createRequest: () => { throw new Error('the test sends no server requests'); } },
			log,
			kind,
			priming: () => true,
		};
	}

	/**
	 * Runs `fn` on a virtual clock with the writers it creates, all disposed
	 * before the clock stops (a running keep-alive timer would never let it).
	 * Offsets of half an interval keep the checks clear of the ticks.
	 */
	function withWriters(fn: (writers: DisposableStore) => Promise<void>): Promise<void> {
		return runWithFakedTimers({ useFakeTimers: true }, async () => {
			const writers = new DisposableStore();
			try {
				await fn(writers);
			} finally {
				writers.dispose();
			}
		});
	}

	test('a response gets no keep-alive while it is JSON; once it streams, one comment per SSE_KEEPALIVE_MS until respond()', () => withWriters(async writers => {
		const json = new FakeSseResponse();
		const jsonWriter = writers.add(new McpGatewayResponseWriter(json.response, new NullLogger()));
		await timeout(SSE_KEEPALIVE_MS * 2.5);
		jsonWriter.respond({ jsonrpc: '2.0', id: 1, result: {} });
		assert.deepStrictEqual(json.chunks, ['{"jsonrpc":"2.0","id":1,"result":{}}']);

		const res = new FakeSseResponse();
		const writer = writers.add(new McpGatewayResponseWriter(res.response, new NullLogger()));
		await timeout(SSE_KEEPALIVE_MS * 1.5);
		assert.strictEqual(res.chunks.length, 0, 'nothing streams before a notification');
		// The lazy upgrade: the first notification starts the stream and its keep-alive clock.
		writer.notify({ method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } });
		await timeout(SSE_KEEPALIVE_MS * 0.5);
		assert.strictEqual(res.keepalives, 0);
		await timeout(SSE_KEEPALIVE_MS);
		assert.strictEqual(res.keepalives, 1);
		await timeout(SSE_KEEPALIVE_MS * 2);
		assert.strictEqual(res.keepalives, 3);
		writer.respond({ jsonrpc: '2.0', id: 2, result: {} });
		assert.ok(res.writableEnded);
		await timeout(SSE_KEEPALIVE_MS * 3);
		assert.strictEqual(res.keepalives, 3, 'none after respond()');
		assert.deepStrictEqual(res.chunks.filter(chunk => chunk !== KEEPALIVE).map(chunk => chunk.split('\n')[0]), ['event: message', 'event: message']);
	}));

	test('the keep-alive stops at end() and when the client goes away', () => withWriters(async writers => {
		const ended = new FakeSseResponse();
		const endedWriter = writers.add(new McpGatewayResponseWriter(ended.response, new NullLogger()));
		endedWriter.startStream();
		await timeout(SSE_KEEPALIVE_MS * 1.5);
		assert.strictEqual(ended.keepalives, 1);
		endedWriter.end();
		await timeout(SSE_KEEPALIVE_MS * 3);
		assert.strictEqual(ended.keepalives, 1, 'none after end()');

		const left = new FakeSseResponse();
		const leftWriter = writers.add(new McpGatewayResponseWriter(left.response, new NullLogger()));
		let aborted = false;
		writers.add(leftWriter.onDidAbort(() => { aborted = true; }));
		leftWriter.startStream();
		await timeout(SSE_KEEPALIVE_MS * 1.5);
		assert.strictEqual(left.keepalives, 1);
		left.close();
		assert.ok(aborted);
		await timeout(SSE_KEEPALIVE_MS * 3);
		assert.strictEqual(left.keepalives, 1, 'none after the client left');
	}));

	test('a legacy stream starts with a priming event (id and retry); closeForPolling() ends the response with a retry and stops the keep-alive', () => withWriters(async writers => {
		const log = new McpGatewayEventLog();
		const res = new FakeSseResponse();
		const writer = writers.add(new McpGatewayResponseWriter(res.response, new NullLogger(), { legacy: legacyOptions('request', log) }));
		writer.startStream();
		const priming = /^id: (\S+)\nretry: (\d+)\ndata: \n\n$/.exec(res.chunks[0]);
		assert.ok(priming, JSON.stringify(res.chunks[0]));
		assert.strictEqual(Number(priming[2]), LEGACY_SSE_RETRY_MS);
		assert.strictEqual(log.find(priming[1])?.id, writer.streamId, 'the priming id resumes this stream');
		await timeout(SSE_KEEPALIVE_MS * 1.5);
		assert.strictEqual(res.keepalives, 1);

		assert.ok(writer.closeForPolling());
		assert.strictEqual(res.chunks[res.chunks.length - 1], `retry: ${LEGACY_SSE_RETRY_MS}\n\n`);
		assert.ok(res.writableEnded);
		await timeout(SSE_KEEPALIVE_MS * 3);
		assert.strictEqual(res.keepalives, 1, 'none after closeForPolling()');
	}));
});
