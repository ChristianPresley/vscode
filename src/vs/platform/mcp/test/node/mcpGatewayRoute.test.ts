/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../../common/mcpGateway.js';
import { MCP_PROTOCOL_VERSION_HEADER } from '../../common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_SERVER_INFO, META_SUBSCRIPTION_ID } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { CONFORMANCE_HIDDEN_TOOL, CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { LEGACY_NOT_INITIALIZED, LEGACY_SESSION_NOT_FOUND, LEGACY_SSE_RETRY_MS, MAX_BODY_BYTES, McpGatewayRoute } from '../../node/mcpGatewayRoute.js';
import { IMcpGatewayServiceOptions, McpGatewayService } from '../../node/mcpGatewayService.js';
import { httpRequest, jsonOf, LEGACY_HEADERS, legacyHeaders, modernRequest, openHttp } from './mcpGatewayTestUtils.js';

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

const INITIALIZE = (capabilities: Record<string, unknown> = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'route-test', version: '1.0.0' } } });

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

	async function initializeSession(url: string, capabilities: Record<string, unknown> = {}): Promise<string> {
		const init = await httpRequest(url, { headers: LEGACY_HEADERS, body: INITIALIZE(capabilities) });
		assert.strictEqual(init.status, 200, init.text);
		const sessionId = init.headers['mcp-session-id'];
		assert.ok(typeof sessionId === 'string' && /^[\x21-\x7e]+$/.test(sessionId), 'visible ASCII session id');
		const initialized = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
		assert.strictEqual(initialized.status, 202);
		return sessionId;
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
		const notification = await httpRequest(url, { headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'nothing' } }) });
		assert.deepStrictEqual([notification.status, notification.text], [202, '']);
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

	test('subscriptions/listen: acknowledgement first, honoured filter, tagged notifications, graceful close on cancel', async () => {
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

		const cancel = await httpRequest(url, { headers: modernRequest('tools/list').headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'listen-1' } }) });
		assert.strictEqual(cancel.status, 202);
		await stream.ended;
		const final = stream.messages[stream.messages.length - 1] as IJsonRpcBody;
		assert.strictEqual(final.id, 'listen-1');
		assert.strictEqual(final.result?.resultType, 'complete');
		assert.strictEqual((final.result?._meta as Record<string, unknown>)[META_SUBSCRIPTION_ID], 'listen-1');
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

	test('2025-11-25: a client that goes away cancels the pending server request', async () => {
		const { url, route } = await createGateway();
		const sessionId = await initializeSession(url, { elicitation: {} });
		const call = await openHttp(url, { method: 'POST', headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'test_elicitation', arguments: { message: 'Name?' } } }) });
		await call.message(0);
		assert.strictEqual(route.getSession(sessionId)?.pendingRequestCount, 1);
		call.close();
		await whenResponsesClosed(route, () => route.openResponses === 0);
		assert.strictEqual(route.getSession(sessionId)?.pendingRequestCount, 0, 'the pending request was cancelled');
	});

	test('stopping the service ends listen streams with their result and closes sessions', async () => {
		const { url, service, route } = await createGateway();
		const sessionId = await initializeSession(url);
		const get = await openHttp(url, { method: 'GET', headers: { 'Mcp-Session-Id': sessionId } });
		await get.event(0);
		const listen = modernRequest('subscriptions/listen', { notifications: { toolsListChanged: true } }, 'l');
		const stream = await openHttp(url, { method: 'POST', headers: listen.headers, body: listen.body });
		await stream.message(0);
		route.closeAllConnections();
		await stream.ended;
		await get.ended;
		const final = stream.messages[stream.messages.length - 1] as IJsonRpcBody;
		assert.strictEqual(final.id, 'l');
		assert.strictEqual(final.result?.resultType, 'complete');
		assert.strictEqual(route.sessionCount, 0);
		assert.ok(service.port !== undefined);
	});

	test('the hidden tool appears after the trigger (list changes reach the upstream state)', async () => {
		const { url, invoker } = await createGateway();
		const before = await post(url, modernRequest('tools/list', {}, 1));
		assert.ok(!(before.body.result?.tools as Array<{ name: string }>).some(t => t.name === CONFORMANCE_HIDDEN_TOOL));
		(invoker as McpGatewayConformanceInvoker).setToolHidden(CONFORMANCE_HIDDEN_TOOL, false);
		const after = await post(url, modernRequest('tools/list', {}, 2));
		assert.ok((after.body.result?.tools as Array<{ name: string }>).some(t => t.name === CONFORMANCE_HIDDEN_TOOL));
	});
});
