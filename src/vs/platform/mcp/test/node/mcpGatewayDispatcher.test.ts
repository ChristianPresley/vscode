/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IJsonRpcRequest } from '../../../../base/common/jsonRpcProtocol.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IMcpGatewayInputRequired, IMcpGatewaySingleServerInvoker } from '../../common/mcpGateway.js';
import { McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { MCP_METHOD_HEADER, MCP_NAME_HEADER, MCP_PROTOCOL_VERSION_HEADER } from '../../common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, META_SERVER_INFO } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { CONFORMANCE_CACHE_HINTS, CONFORMANCE_INSTRUCTIONS, CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { IMcpGatewayDispatchContext, IMcpGatewayDispatcherOptions, IMcpGatewayNotification, MAX_GATEWAY_INPUT_ROUNDS, McpGatewayDispatcher, McpGatewayResourceNotFoundError } from '../../node/mcpGatewayDispatcher.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';
import { modernMeta } from './mcpGatewayTestUtils.js';

interface ITestContext {
	readonly ctx: IMcpGatewayDispatchContext;
	readonly notifications: IMcpGatewayNotification[];
	readonly serverRequests: IMcpGatewayNotification[];
}

const ALL_CAPABILITIES: MCP.ClientCapabilities = { elicitation: { form: {}, url: {} }, sampling: {}, roots: {} };

function minimalInvoker(overrides: Partial<IMcpGatewaySingleServerInvoker> = {}): IMcpGatewaySingleServerInvoker {
	return {
		onDidChangeTools: Event.None,
		onDidChangeResources: Event.None,
		listTools: async () => [{ name: 'echo', description: 'Echoes its arguments', inputSchema: { type: 'object' } }],
		callTool: async (_name, args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
		listResources: async () => [],
		readResource: async uri => { throw new McpGatewayResourceNotFoundError(uri); },
		listResourceTemplates: async () => [],
		...overrides,
	};
}

async function assertRpcError(promise: Promise<unknown>, code: number, check?: (error: McpGatewayRpcError) => void): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof McpGatewayRpcError, `expected an McpGatewayRpcError, got ${error}`);
		assert.strictEqual(error.code, code, error.message);
		check?.(error);
		return true;
	});
}

suite('MCP - GatewayDispatcher', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const logger = new NullLogService();

	function createDispatcher(invoker?: IMcpGatewaySingleServerInvoker, options: IMcpGatewayDispatcherOptions = { serverInfo: CONFORMANCE_SERVER_INFO }): McpGatewayDispatcher {
		return store.add(new McpGatewayDispatcher('route-1', logger, invoker ?? store.add(new McpGatewayConformanceInvoker()), new McpGatewaySealedState(), options));
	}

	function context(era: 'modern' | 'legacy', overrides: Partial<IMcpGatewayDispatchContext> = {}, answer?: (request: IMcpGatewayNotification) => unknown): ITestContext {
		const notifications: IMcpGatewayNotification[] = [];
		const serverRequests: IMcpGatewayNotification[] = [];
		const ctx: IMcpGatewayDispatchContext = {
			era,
			protocolVersion: era === 'modern' ? LATEST_MCP_PROTOCOL_VERSION : '2025-11-25',
			requestId: 1,
			clientCapabilities: ALL_CAPABILITIES,
			headers: {},
			token: CancellationToken.None,
			notify: notification => notifications.push(notification),
			sendServerRequest: answer ? async request => { serverRequests.push(request); return answer(request); } : undefined,
			...overrides,
		};
		return { ctx, notifications, serverRequests };
	}

	function textOf(result: object): string {
		const content = (result as MCPLegacy.CallToolResult).content;
		const first = content[0];
		return first.type === 'text' ? first.text : '';
	}

	test('method table: each era gets its own methods; listen and the session methods are the transport\'s', async () => {
		const dispatcher = createDispatcher();
		assert.strictEqual(dispatcher.supportsMethod('server/discover', 'modern'), true);
		assert.strictEqual(dispatcher.supportsMethod('server/discover', 'legacy'), false);
		assert.strictEqual(dispatcher.supportsMethod('ping', 'legacy'), true);
		assert.strictEqual(dispatcher.supportsMethod('ping', 'modern'), false);
		for (const method of ['tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get', 'completion/complete']) {
			assert.strictEqual(dispatcher.supportsMethod(method, 'modern'), true, method);
			assert.strictEqual(dispatcher.supportsMethod(method, 'legacy'), true, method);
		}
		for (const method of ['initialize', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe', 'subscriptions/listen', 'unknown/method']) {
			assert.strictEqual(dispatcher.supportsMethod(method, 'modern'), false, method);
			await assertRpcError(dispatcher.dispatch(context('modern').ctx, method, {}), MCP.METHOD_NOT_FOUND);
		}
		await assertRpcError(dispatcher.dispatch(context('legacy').ctx, 'server/discover', {}), MCP.METHOD_NOT_FOUND);
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'ping', {}), MCP.METHOD_NOT_FOUND);
		assert.deepStrictEqual(await dispatcher.dispatch(context('legacy').ctx, 'ping', {}), {});
	});

	test('modern results get the envelope and cache hints, legacy results stay bare', async () => {
		const dispatcher = createDispatcher();
		const modern = await dispatcher.dispatch(context('modern').ctx, 'tools/list', {}) as MCP.ListToolsResult;
		assert.strictEqual(modern.resultType, 'complete');
		assert.deepStrictEqual(modern._meta?.[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
		assert.strictEqual(modern.ttlMs, CONFORMANCE_CACHE_HINTS.ttlMs);
		assert.strictEqual(modern.cacheScope, CONFORMANCE_CACHE_HINTS.cacheScope);
		assert.ok(modern.tools.length > 0);

		const call = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_simple_text', arguments: {} }) as Record<string, unknown>;
		assert.strictEqual(call.resultType, 'complete');
		assert.strictEqual(call.ttlMs, undefined, 'tools/call is not cacheable');

		const legacy = await dispatcher.dispatch(context('legacy').ctx, 'tools/list', {}) as Record<string, unknown>;
		assert.strictEqual(legacy.resultType, undefined);
		assert.strictEqual(legacy._meta, undefined);
		assert.strictEqual(legacy.ttlMs, undefined);
	});

	test('server/discover advertises the version, capabilities, instructions and cache hints', async () => {
		const dispatcher = createDispatcher();
		const result = await dispatcher.dispatch(context('modern').ctx, 'server/discover', {}) as MCP.DiscoverResult;
		assert.deepStrictEqual(result.supportedVersions, [LATEST_MCP_PROTOCOL_VERSION]);
		assert.deepStrictEqual(result.capabilities, {
			tools: { listChanged: true },
			resources: { subscribe: true, listChanged: true },
			prompts: { listChanged: true },
			completions: {},
			logging: {},
			// The fixture serves the Tasks extension (see mcpGatewayTasks.test.ts); the legacy initialize below does not announce it.
			extensions: { 'io.modelcontextprotocol/tasks': {} },
		});
		assert.strictEqual(result.instructions, CONFORMANCE_INSTRUCTIONS);
		assert.strictEqual(result.ttlMs, CONFORMANCE_CACHE_HINTS.ttlMs);
		assert.strictEqual(result.cacheScope, CONFORMANCE_CACHE_HINTS.cacheScope);
		assert.deepStrictEqual(result._meta?.[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
		assert.deepStrictEqual(dispatcher.legacyInitializeCapabilities(), {
			tools: { listChanged: true },
			resources: { subscribe: true, listChanged: true },
			prompts: { listChanged: true },
			logging: {},
			completions: {},
		});
	});

	test('the gateway issues no cursors: any cursor, the empty string included, is -32602', async () => {
		const dispatcher = createDispatcher();
		for (const era of ['modern', 'legacy'] as const) {
			for (const method of ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']) {
				await assertRpcError(dispatcher.dispatch(context(era).ctx, method, { cursor: '' }), MCP.INVALID_PARAMS, error => assert.deepStrictEqual(error.data, { cursor: '' }));
			}
		}
	});

	test('one capability rule for both eras: the legacy initialize advertises what server/discover does, and the methods follow', async () => {
		const minimal = createDispatcher(minimalInvoker(), {});
		assert.deepStrictEqual(minimal.legacyInitializeCapabilities(), { tools: { listChanged: true }, resources: { subscribe: false, listChanged: true }, logging: {} });
		for (const method of ['prompts/list', 'prompts/get', 'completion/complete']) {
			assert.strictEqual(minimal.supportsMethod(method, 'legacy'), false, method);
			await assertRpcError(minimal.dispatch(context('legacy').ctx, method, { name: 'x', ref: {}, argument: {} }), MCP.METHOD_NOT_FOUND);
		}
		const withMethods = createDispatcher(minimalInvoker({
			listPrompts: async () => [{ name: 'p' }],
			complete: async () => ({ completion: { values: ['a'] } }),
			subscribeResource: async () => ({ dispose: () => { } }),
		}), {});
		assert.deepStrictEqual(withMethods.legacyInitializeCapabilities(), { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true }, logging: {}, completions: {} });
		assert.deepStrictEqual(await withMethods.dispatch(context('legacy').ctx, 'prompts/list', {}), { prompts: [{ name: 'p' }] });
		const quiet = createDispatcher(minimalInvoker(), { capabilities: { tools: { listChanged: false }, logging: false } });
		assert.deepStrictEqual(quiet.legacyInitializeCapabilities(), { tools: { listChanged: false }, resources: { subscribe: false, listChanged: true } });
	});

	test('a declared capability whose method the invoker lacks is served empty, not refused', async () => {
		const dispatcher = createDispatcher(minimalInvoker({ capabilities: { prompts: { listChanged: false }, completions: true } }), {});
		assert.deepStrictEqual(dispatcher.legacyInitializeCapabilities().prompts, { listChanged: false });
		for (const era of ['modern', 'legacy'] as const) {
			const prompts = await dispatcher.dispatch(context(era).ctx, 'prompts/list', {}) as MCPLegacy.ListPromptsResult;
			assert.deepStrictEqual(prompts.prompts, [], era);
			const completion = await dispatcher.dispatch(context(era).ctx, 'completion/complete', { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'a', value: '' } }) as MCPLegacy.CompleteResult;
			assert.deepStrictEqual(completion.completion, { values: [], total: 0, hasMore: false }, era);
			await assertRpcError(dispatcher.dispatch(context(era).ctx, 'prompts/get', { name: 'p' }), MCP.INVALID_PARAMS);
		}
	});

	test('the polling hook of a legacy request reaches the invoker', async () => {
		let hook: (() => void) | undefined;
		const dispatcher = createDispatcher(minimalInvoker({ callTool: async (_name, _args, invokeCtx) => { hook = invokeCtx?.closeSseStream; return { content: [] }; } }), {});
		let closed = 0;
		await dispatcher.dispatch(context('legacy', { closeSseStream: () => closed++ }).ctx, 'tools/call', { name: 'echo', arguments: {} });
		hook?.();
		assert.strictEqual(closed, 1);
		await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'echo', arguments: {} });
		assert.strictEqual(hook, undefined, 'no hook without a closable stream');
	});

	test('capability gating: prompts and completion are -32601 when the upstream has neither', async () => {
		const dispatcher = createDispatcher(minimalInvoker(), {});
		const caps = dispatcher.serverCapabilities();
		assert.strictEqual(caps.prompts, undefined);
		assert.strictEqual(caps.completions, undefined);
		assert.strictEqual(caps.resources?.subscribe, false);
		for (const method of ['prompts/list', 'prompts/get', 'completion/complete']) {
			assert.strictEqual(dispatcher.supportsMethod(method, 'modern'), false, method);
			await assertRpcError(dispatcher.dispatch(context('modern').ctx, method, { name: 'x' }), MCP.METHOD_NOT_FOUND);
		}
		assert.deepStrictEqual(dispatcher.honoredFilter({ toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ['a://b'] }), { toolsListChanged: true });
	});

	test('tools/call and prompts/get validate their parameters', async () => {
		const dispatcher = createDispatcher();
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', {}), MCP.INVALID_PARAMS);
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_simple_text', arguments: 'nope' }), MCP.INVALID_PARAMS);
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'prompts/get', { name: 7 }), MCP.INVALID_PARAMS);
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'resources/read', {}), MCP.INVALID_PARAMS);
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'completion/complete', { ref: 'x' }), MCP.INVALID_PARAMS);
	});

	test('modern input rounds pass through with a sealed requestState that round-trips', async () => {
		const dispatcher = createDispatcher();
		const first = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_request_state', arguments: {} }) as MCP.InputRequiredResult;
		assert.strictEqual(first.resultType, 'input_required');
		assert.strictEqual(first.inputRequests?.confirm.method, 'elicitation/create');
		assert.ok(typeof first.requestState === 'string' && first.requestState.startsWith('v1.'), 'sealed');
		assert.ok(!first.requestState.includes('nonce'), 'the upstream state is not readable by the client');
		assert.deepStrictEqual(first._meta?.[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);

		const second = await dispatcher.dispatch(context('modern').ctx, 'tools/call', {
			name: 'test_input_required_result_request_state',
			arguments: {},
			inputResponses: { confirm: { action: 'accept', content: { ok: true } } },
			requestState: first.requestState,
		});
		assert.strictEqual(textOf(second), 'state-ok request-state-nonce');

		// Three rounds, each with a new state.
		let result = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_multi_round', arguments: {} }) as MCP.InputRequiredResult;
		const r1 = result.requestState;
		result = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_multi_round', arguments: {}, inputResponses: { step1: { action: 'accept', content: { name: 'Ada' } } }, requestState: r1 }) as MCP.InputRequiredResult;
		assert.strictEqual(result.resultType, 'input_required');
		assert.notStrictEqual(result.requestState, r1);
		const done = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_multi_round', arguments: {}, inputResponses: { step2: { action: 'accept', content: { color: 'blue' } } }, requestState: result.requestState });
		assert.strictEqual(textOf(done), 'Ada likes blue');
	});

	test('a tampered, foreign or non-string requestState is -32602 invalid_request_state', async () => {
		const dispatcher = createDispatcher();
		const first = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_tampered_state', arguments: {} }) as MCP.InputRequiredResult;
		const responses = { confirm: { action: 'accept', content: { ok: true } } };
		const reason = (error: McpGatewayRpcError) => assert.deepStrictEqual(error.data, { reason: 'invalid_request_state' });
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_tampered_state', arguments: {}, inputResponses: responses, requestState: first.requestState + '-TAMPERED' }), MCP.INVALID_PARAMS, reason);
		// Sealed for another tool: the AAD binds method, target and route.
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_request_state', arguments: {}, inputResponses: responses, requestState: first.requestState }), MCP.INVALID_PARAMS, reason);
		// Sealed by another route.
		const other = store.add(new McpGatewayDispatcher('route-2', logger, store.add(new McpGatewayConformanceInvoker()), new McpGatewaySealedState(), {}));
		await assertRpcError(other.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_tampered_state', arguments: {}, inputResponses: responses, requestState: first.requestState }), MCP.INVALID_PARAMS, reason);
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_tampered_state', arguments: {}, requestState: 42 }), MCP.INVALID_PARAMS, reason);
	});

	test('an input request for an undeclared client capability is -32021 naming the capability', async () => {
		const dispatcher = createDispatcher();
		await assertRpcError(dispatcher.dispatch(context('modern', { clientCapabilities: {} }).ctx, 'tools/call', { name: 'test_missing_capability', arguments: {} }), MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, error => {
			assert.deepStrictEqual((error.data as { requiredCapabilities: unknown }).requiredCapabilities, { sampling: {} });
		});
		// The fixture only asks for what the client declared.
		const partial = await dispatcher.dispatch(context('modern', { clientCapabilities: { sampling: {} } }).ctx, 'tools/call', { name: 'test_input_required_result_capabilities', arguments: {} }) as MCP.InputRequiredResult;
		assert.deepStrictEqual(Object.keys(partial.inputRequests ?? {}), ['greeting']);
	});

	test('inputResponses must be an object of objects', async () => {
		const dispatcher = createDispatcher();
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_elicitation', arguments: {}, inputResponses: { user_name: 12345 } }), MCP.INVALID_PARAMS);
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_elicitation', arguments: {}, inputResponses: null }), MCP.INVALID_PARAMS);
		// Extra keys are ignored, missing keys are asked again.
		const extra = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_elicitation', arguments: {}, inputResponses: { user_name: { action: 'accept', content: { name: 'Bo' } }, other: { action: 'accept' } } });
		assert.strictEqual(textOf(extra), 'Hello, Bo!');
		const missing = await dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'test_input_required_result_elicitation', arguments: {}, inputResponses: { wrong_key: { action: 'accept' } } }) as MCP.InputRequiredResult;
		assert.strictEqual(missing.resultType, 'input_required');
	});

	test('legacy bridge: input rounds become server→client requests until the upstream completes', async () => {
		const dispatcher = createDispatcher();
		const { ctx, serverRequests } = context('legacy', {}, request => {
			switch (request.method) {
				case 'elicitation/create': return { action: 'accept', content: { name: 'Alice' } };
				case 'sampling/createMessage': return { role: 'assistant', content: { type: 'text', text: 'Hi' }, model: 'test-model', stopReason: 'endTurn' };
				default: return { roots: [{ uri: 'file:///root', name: 'Root' }] };
			}
		});
		const result = await dispatcher.dispatch(ctx, 'tools/call', { name: 'test_input_required_result_multiple_inputs', arguments: {} });
		assert.deepStrictEqual(serverRequests.map(r => r.method).sort(), ['elicitation/create', 'roots/list', 'sampling/createMessage']);
		assert.strictEqual(textOf(result), 'Alice: model test-model, 1 roots');
		assert.strictEqual((result as Record<string, unknown>).resultType, undefined, 'legacy results have no envelope');
	});

	test('legacy bridge: URL elicitations get a gateway elicitationId and a completion notification', async () => {
		let calls = 0;
		const invoker = minimalInvoker({
			callTool: async (_name, _args, invokeCtx) => {
				calls++;
				if (!invokeCtx?.inputResponses?.login) {
					const result: IMcpGatewayInputRequired = { resultType: 'input_required', inputRequests: { login: { method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', url: 'https://example.com/login' } } } };
					return result;
				}
				return { content: [{ type: 'text', text: 'signed in' }] };
			},
		});
		const dispatcher = createDispatcher(invoker, {});
		const { ctx, notifications, serverRequests } = context('legacy', {}, () => ({ action: 'accept' }));
		const result = await dispatcher.dispatch(ctx, 'tools/call', { name: 'echo', arguments: {} });
		assert.strictEqual(textOf(result), 'signed in');
		assert.strictEqual(calls, 2);
		assert.strictEqual(serverRequests.length, 1);
		const elicitationId = (serverRequests[0].params as { elicitationId?: unknown }).elicitationId;
		assert.ok(typeof elicitationId === 'string' && elicitationId.length > 0);
		assert.deepStrictEqual(notifications, [{ method: 'notifications/elicitation/complete', params: { elicitationId } }]);

		// A URL elicitation needs the client's url capability.
		const formOnly = context('legacy', { clientCapabilities: { elicitation: {} } }, () => ({ action: 'accept' }));
		await assertRpcError(dispatcher.dispatch(formOnly.ctx, 'tools/call', { name: 'echo', arguments: {} }), MCP.MISSING_REQUIRED_CLIENT_CAPABILITY);
	});

	test('legacy bridge: no request channel, a non-object answer and endless rounds are -32603', async () => {
		const dispatcher = createDispatcher();
		await assertRpcError(dispatcher.dispatch(context('legacy').ctx, 'tools/call', { name: 'test_sampling', arguments: { prompt: 'x' } }), MCP.INTERNAL_ERROR);
		await assertRpcError(dispatcher.dispatch(context('legacy', {}, () => 'not an object').ctx, 'tools/call', { name: 'test_sampling', arguments: { prompt: 'x' } }), MCP.INTERNAL_ERROR);

		const endless = createDispatcher(minimalInvoker({
			callTool: async () => ({ resultType: 'input_required', inputRequests: { again: { method: 'roots/list', params: {} } } }) satisfies IMcpGatewayInputRequired,
		}), {});
		const { ctx, serverRequests } = context('legacy', {}, () => ({ roots: [] }));
		await assertRpcError(endless.dispatch(ctx, 'tools/call', { name: 'echo', arguments: {} }), MCP.INTERNAL_ERROR);
		assert.strictEqual(serverRequests.length, MAX_GATEWAY_INPUT_ROUNDS - 1);
	});

	test('progress is forwarded only when the request carries a progress token', async () => {
		const dispatcher = createDispatcher();
		const withToken = context('modern', { progressToken: 'p-1' });
		await dispatcher.dispatch(withToken.ctx, 'tools/call', { name: 'test_tool_with_progress', arguments: {} });
		assert.deepStrictEqual(withToken.notifications.map(n => n.method), ['notifications/progress', 'notifications/progress', 'notifications/progress']);
		assert.deepStrictEqual(withToken.notifications.map(n => (n.params as { progress: number; progressToken: string; total: number })), [
			{ progressToken: 'p-1', progress: 0, total: 100, message: 'Completed step 1 of 3' },
			{ progressToken: 'p-1', progress: 50, total: 100, message: 'Completed step 2 of 3' },
			{ progressToken: 'p-1', progress: 100, total: 100, message: 'Completed step 3 of 3' },
		]);
		const without = context('modern');
		await dispatcher.dispatch(without.ctx, 'tools/call', { name: 'test_tool_with_progress', arguments: {} });
		assert.deepStrictEqual(without.notifications, []);
	});

	test('logs: modern requests need _meta logLevel, legacy sessions follow logging/setLevel', async () => {
		const dispatcher = createDispatcher();
		const run = async (era: 'modern' | 'legacy', logLevel: MCP.LoggingLevel | undefined) => {
			const test = context(era, { logLevel });
			await dispatcher.dispatch(test.ctx, 'tools/call', { name: 'test_tool_with_logging', arguments: {} });
			return test.notifications.filter(n => n.method === 'notifications/message').length;
		};
		assert.strictEqual(await run('modern', undefined), 0);
		assert.strictEqual(await run('modern', 'info'), 3);
		assert.strictEqual(await run('modern', 'error'), 0);
		assert.strictEqual(await run('legacy', undefined), 3);
		assert.strictEqual(await run('legacy', 'debug'), 3);
		assert.strictEqual(await run('legacy', 'warning'), 0);
		const test = context('modern', { logLevel: 'debug' });
		await dispatcher.dispatch(test.ctx, 'tools/call', { name: 'test_logging_tool', arguments: {} });
		assert.deepStrictEqual(test.notifications[0], { method: 'notifications/message', params: { level: 'info', data: 'Tool execution started', logger: 'conformance-server' } });
	});

	test('a missing resource is -32602 on the modern wire and -32002 on the legacy wire, with the uri', async () => {
		const dispatcher = createDispatcher();
		const uri = 'test://nonexistent';
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'resources/read', { uri }), MCP.INVALID_PARAMS, error => assert.deepStrictEqual(error.data, { uri }));
		await assertRpcError(dispatcher.dispatch(context('legacy').ctx, 'resources/read', { uri }), -32002, error => assert.deepStrictEqual(error.data, { uri }));
	});

	test('upstream failures: -32603 on the modern wire, -32602 on the legacy wire', async () => {
		const dispatcher = createDispatcher(minimalInvoker({ callTool: async () => { throw new Error('boom'); } }), {});
		await assertRpcError(dispatcher.dispatch(context('modern').ctx, 'tools/call', { name: 'echo' }), MCP.INTERNAL_ERROR, error => assert.strictEqual(error.message, 'boom'));
		await assertRpcError(dispatcher.dispatch(context('legacy').ctx, 'tools/call', { name: 'echo' }), MCPLegacy.INVALID_PARAMS);
	});

	test('prepareModernRequest validates _meta, the version and the mirrored headers', async () => {
		const dispatcher = createDispatcher();
		const request = (method: string, params: Record<string, unknown>): IJsonRpcRequest => ({ jsonrpc: '2.0', id: 9, method, params });
		const headers = (method: string, extra: Record<string, string> = {}) => ({ [MCP_PROTOCOL_VERSION_HEADER.toLowerCase()]: LATEST_MCP_PROTOCOL_VERSION, [MCP_METHOD_HEADER.toLowerCase()]: method, ...extra });

		const ok = await dispatcher.prepareModernRequest(headers('tools/list'), request('tools/list', { _meta: modernMeta({ sampling: {} }, { 'io.modelcontextprotocol/logLevel': 'info', progressToken: 7 }) }));
		assert.ok(ok.ok);
		assert.deepStrictEqual(ok.meta.clientCapabilities, { sampling: {} });
		assert.strictEqual(ok.meta.logLevel, 'info');
		assert.strictEqual(ok.meta.progressToken, 7);

		const expectError = async (h: Record<string, string>, r: IJsonRpcRequest, code: number) => {
			const prepared = await dispatcher.prepareModernRequest(h, r);
			assert.ok(!prepared.ok, `expected ${code}`);
			assert.strictEqual(prepared.error.code, code, prepared.error.message);
			return prepared.error;
		};
		await expectError(headers('tools/list'), request('tools/list', {}), MCP.INVALID_PARAMS);
		await expectError(headers('tools/list'), request('tools/list', { _meta: { [META_CLIENT_CAPABILITIES]: {} } }), MCP.INVALID_PARAMS);
		await expectError(headers('tools/list'), request('tools/list', { _meta: { [META_PROTOCOL_VERSION]: LATEST_MCP_PROTOCOL_VERSION } }), MCP.INVALID_PARAMS);
		const unsupported = await expectError(headers('tools/list', { [MCP_PROTOCOL_VERSION_HEADER.toLowerCase()]: 'v9' }), request('tools/list', { _meta: { ...modernMeta(), [META_PROTOCOL_VERSION]: 'v9' } }), MCP.UNSUPPORTED_PROTOCOL_VERSION);
		assert.deepStrictEqual(unsupported.data, { supported: [LATEST_MCP_PROTOCOL_VERSION], requested: 'v9' });
		// The header disagrees with the body: a mismatch, before the version is judged.
		await expectError(headers('tools/list'), request('tools/list', { _meta: { ...modernMeta(), [META_PROTOCOL_VERSION]: 'v9' } }), MCP.HEADER_MISMATCH);
		await expectError(headers('prompts/list'), request('tools/list', { _meta: modernMeta() }), MCP.HEADER_MISMATCH);
		await expectError(headers('tools/call'), request('tools/call', { name: 'test_simple_text', _meta: modernMeta() }), MCP.HEADER_MISMATCH);
		assert.ok((await dispatcher.prepareModernRequest(headers('tools/call', { [MCP_NAME_HEADER.toLowerCase()]: 'test_simple_text' }), request('tools/call', { name: 'test_simple_text', _meta: modernMeta() }))).ok);
		// Annotated arguments must be mirrored into Mcp-Param-* headers.
		const annotated = request('tools/call', { name: 'test_x_mcp_header', arguments: { region: 'eu' }, _meta: modernMeta() });
		await expectError(headers('tools/call', { [MCP_NAME_HEADER.toLowerCase()]: 'test_x_mcp_header' }), annotated, MCP.HEADER_MISMATCH);
		assert.ok((await dispatcher.prepareModernRequest(headers('tools/call', { [MCP_NAME_HEADER.toLowerCase()]: 'test_x_mcp_header', 'mcp-param-region': 'eu' }), annotated)).ok);
		await expectError(headers('tools/call', { [MCP_NAME_HEADER.toLowerCase()]: 'test_x_mcp_header', 'mcp-param-region': 'us' }), annotated, MCP.HEADER_MISMATCH);
	});
});
