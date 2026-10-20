/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { IJsonRpcRequest, JsonRpcMessage } from '../../../../../base/common/jsonRpcProtocol.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { upcast } from '../../../../../base/common/types.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';
import { META_CLIENT_CAPABILITIES } from '../../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../../platform/mcp/common/modelContextProtocol.js';
import { McpTasks } from '../../../../../platform/mcp/common/modelContextProtocolTasks.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { TestLoggerService, TestProductService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { DEFAULT_MODERN_TASK_POLL_INTERVAL_MS, MIN_MODERN_TASK_POLL_INTERVAL_MS } from '../../common/mcpModernTask.js';
import { IMcpServerRequestHandlerOptions, McpServerRequestHandler } from '../../common/mcpServerRequestHandler.js';
import { McpTaskManager } from '../../common/mcpTaskManager.js';
import { McpClientError, McpConnectionState, MpcResponseError } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { ITestMcpTransportOptions, TestMcpMessageTransport } from './mcpRegistryTypes.js';

const TASKS_EXTENSION = { [McpTasks.EXTENSION_ID]: {} };
const WITH_TASKS: ITestMcpTransportOptions = {
	era: 'modern',
	discoverResult: { capabilities: { tools: { listChanged: false }, extensions: TASKS_EXTENSION } },
};
const CREATED_AT = '2026-07-28T12:00:00.000Z';

interface ITaskState {
	readonly status: McpTasks.TaskStatus;
	readonly result?: object;
	readonly error?: MCP.Error;
	readonly inputRequests?: MCP.InputRequests;
	readonly statusMessage?: string;
	readonly pollIntervalMs?: number;
}

const ok = (request: IJsonRpcRequest, result: object): JsonRpcMessage => ({ jsonrpc: MCP.JSONRPC_VERSION, id: request.id, result: { resultType: 'complete', ...result } });
const paramsOf = (request: IJsonRpcRequest): Record<string, unknown> => (request.params ?? {}) as Record<string, unknown>;
const capabilitiesOf = (request: IJsonRpcRequest): MCP.ClientCapabilities => (paramsOf(request)._meta as Record<string, unknown>)[META_CLIENT_CAPABILITIES] as MCP.ClientCapabilities;
const declaresTasks = (request: IJsonRpcRequest): boolean => capabilitiesOf(request).extensions?.[McpTasks.EXTENSION_ID] !== undefined;

function created(taskId: string, pollIntervalMs?: number): McpTasks.CreateTaskResult {
	const result: McpTasks.CreateTaskResult = { resultType: 'task', taskId, status: 'working', createdAt: CREATED_AT, lastUpdatedAt: CREATED_AT, ttlMs: 60_000 };
	if (pollIntervalMs !== undefined) {
		result.pollIntervalMs = pollIntervalMs;
	}
	return result;
}

suite('Workbench - MCP - ServerRequestHandler - Modern tasks', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let instantiationService: TestInstantiationService;
	let logger: ILogger;

	setup(() => {
		const services = new ServiceCollection(
			[ILoggerService, store.add(new TestLoggerService())],
			[IOutputService, upcast({ showChannel: () => { } })],
			[IStorageService, store.add(new TestStorageService())],
			[IProductService, TestProductService],
		);
		instantiationService = store.add(new TestInstantiationService(services));
		logger = store.add((instantiationService.get(ILoggerService) as TestLoggerService).createLogger('mcpModernTaskTest', { hidden: true, name: 'MCP Test' }));
	});

	async function connect(transport: TestMcpMessageTransport, options: Partial<IMcpServerRequestHandlerOptions> = {}, taskManager?: McpTaskManager): Promise<McpServerRequestHandler> {
		transport.setConnectionState({ state: McpConnectionState.Kind.Running });
		return store.add(await McpServerRequestHandler.create(instantiationService, { logger, launch: transport, taskManager: taskManager ?? store.add(new McpTaskManager()), ...options }));
	}

	/** A server whose `tools/call` creates a task and whose `tasks/get` walks through the given states (the last one repeats). */
	function taskServer(states: ITaskState[], options: { readonly taskId?: string; readonly pollIntervalMs?: number; readonly transport?: ITestMcpTransportOptions } = {}) {
		const transport = store.add(new TestMcpMessageTransport(options.transport ?? WITH_TASKS));
		const taskId = options.taskId ?? 'task-1';
		const polls: number[] = [];
		transport.setResponder('tools/list', req => ok(req, { tools: [] }));
		transport.setResponder('tools/call', req => ok(req, created(taskId, options.pollIntervalMs)));
		transport.setResponder('tasks/get', req => {
			polls.push(Date.now());
			const state = states.length > 1 ? states.shift()! : states[0];
			return ok(req, { taskId, createdAt: CREATED_AT, lastUpdatedAt: CREATED_AT, ttlMs: 60_000, ...state });
		});
		transport.setResponder('tasks/update', req => ok(req, {}));
		transport.setResponder('tasks/cancel', req => ok(req, {}));
		return { transport, taskId, polls };
	}

	test('supportsModernTasks follows the advertised extension and the era', async () => {
		const modern = await connect(store.add(new TestMcpMessageTransport(WITH_TASKS)));
		assert.strictEqual(modern.supportsModernTasks, true);
		const plain = await connect(store.add(new TestMcpMessageTransport({ era: 'modern' })));
		assert.strictEqual(plain.supportsModernTasks, false);
		const legacy = await connect(store.add(new TestMcpMessageTransport({ era: 'legacy', initializeResult: { capabilities: { tools: {}, extensions: TASKS_EXTENSION } } })));
		assert.strictEqual(legacy.supportsModernTasks, false);
	});

	test('the opt-in puts the extension into the tools/call capabilities only, and the legacy task param is not sent', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const { transport } = taskServer([{ status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } }]);
		const handler = await connect(transport);
		await handler.listTools();
		const result = await handler.callTool({ name: 'slow', arguments: {}, task: {} });
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'done' }]);

		const call = transport.getSentRequests('tools/call')[0];
		assert.strictEqual(Object.prototype.hasOwnProperty.call(paramsOf(call), 'task'), false);
		assert.strictEqual(declaresTasks(call), true);
		assert.strictEqual(declaresTasks(transport.getSentRequests('tools/list')[0]), false);
		assert.strictEqual(declaresTasks(transport.getSentRequests('server/discover')[0]), false);
		for (const get of transport.getSentRequests('tasks/get')) {
			assert.strictEqual(declaresTasks(get), true, 'tasks/get declares the extension');
			assert.deepStrictEqual(paramsOf(get).taskId, 'task-1');
		}
		assert.deepStrictEqual(transport.getSentEnvelope('tasks/get')?.headers, { 'Mcp-Method': 'tasks/get', 'Mcp-Name': 'task-1' });
	}));

	test('without the opt-in no extension is declared and a task result is rejected', async () => {
		const { transport } = taskServer([{ status: 'working' }]);
		const handler = await connect(transport);
		await assert.rejects(handler.callTool({ name: 'slow', arguments: {} }), (e: unknown) => e instanceof McpClientError && e.reason === 'invalid-result-type');
		assert.strictEqual(declaresTasks(transport.getSentRequests('tools/call')[0]), false);
		assert.strictEqual(transport.getSentRequests('tasks/get').length, 0);
	});

	test('an immediate result is returned as is', async () => {
		const transport = store.add(new TestMcpMessageTransport(WITH_TASKS));
		transport.setResponder('tools/call', req => ok(req, { content: [{ type: 'text', text: 'at once' }] }));
		const handler = await connect(transport);
		const result = await handler.callTool({ name: 'quick', arguments: {}, task: {} });
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'at once' }]);
		assert.strictEqual(transport.getSentRequests('tasks/get').length, 0);
	});

	test('tasks/get is polled every pollIntervalMs (clamped) until the task completes', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const statuses: string[] = [];
		const { transport, polls } = taskServer([
			{ status: 'working', statusMessage: 'step 1' },
			{ status: 'working', statusMessage: 'step 1', pollIntervalMs: 1 },
			{ status: 'completed', result: { content: [{ type: 'text', text: 'done' }], structuredContent: { v: 1 } } },
		], { pollIntervalMs: 500 });
		const handler = await connect(transport);
		const start = Date.now();
		const result = await handler.callTool({ name: 'slow', arguments: {}, task: {} }, CancellationToken.None, m => statuses.push(m));
		assert.deepStrictEqual(result.structuredContent, { v: 1 });
		assert.strictEqual(polls.length, 3);
		assert.ok(polls[0] - start >= 500, 'the first poll waits the advised interval');
		assert.ok(polls[1] - polls[0] >= 500);
		assert.ok(polls[2] - polls[1] >= MIN_MODERN_TASK_POLL_INTERVAL_MS && polls[2] - polls[1] < 500, 'a smaller advice is honoured, but clamped');
		assert.deepStrictEqual(statuses, ['step 1'], 'a status message is reported once');
		assert.strictEqual(transport.getSentRequests('tasks/cancel').length, 0);
	}));

	test('the default poll interval applies when the server advises none', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const { transport, polls } = taskServer([{ status: 'completed', result: { content: [] } }]);
		const handler = await connect(transport);
		const start = Date.now();
		await handler.callTool({ name: 'slow', arguments: {}, task: {} });
		assert.ok(polls[0] - start >= DEFAULT_MODERN_TASK_POLL_INTERVAL_MS);
	}));

	test('input_required inside a task is answered by the elicitation handler and delivered with tasks/update', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const inputRequests: MCP.InputRequests = { confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Delete?', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } } } } };
		const { transport } = taskServer([
			{ status: 'input_required', inputRequests },
			{ status: 'completed', result: { content: [{ type: 'text', text: 'Deleted' }] } },
		], { pollIntervalMs: 200 });
		const elicitation = sinon.stub().resolves({ action: 'accept', content: { confirm: true } });
		const handler = await connect(transport, { elicitationRequestHandler: elicitation });
		const context = { chatSessionResource: undefined, chatRequestId: 'req-7' };
		const result = await handler.callTool({ name: 'confirm_delete', arguments: {}, task: {} }, CancellationToken.None, undefined, context);
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'Deleted' }]);
		assert.strictEqual(elicitation.callCount, 1);
		assert.deepStrictEqual(elicitation.firstCall.args[0], inputRequests.confirm.params);
		assert.strictEqual(elicitation.firstCall.args[2], context);
		const updates = transport.getSentRequests('tasks/update');
		assert.strictEqual(updates.length, 1);
		assert.deepStrictEqual(paramsOf(updates[0]).taskId, 'task-1');
		assert.deepStrictEqual(paramsOf(updates[0]).inputResponses, { confirm: { action: 'accept', content: { confirm: true } } });
		assert.strictEqual(declaresTasks(updates[0]), true);
		assert.deepStrictEqual(transport.getSentEnvelope('tasks/update')?.headers, { 'Mcp-Method': 'tasks/update', 'Mcp-Name': 'task-1' });
	}));

	test('the same pending requests right after an update are not answered twice without waiting an interval', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const inputRequests: MCP.InputRequests = { q: { method: 'roots/list' } };
		const { transport } = taskServer([
			{ status: 'input_required', inputRequests },
			{ status: 'input_required', inputRequests },
			{ status: 'completed', result: { content: [] } },
		], { pollIntervalMs: 200 });
		const handler = await connect(transport);
		await handler.callTool({ name: 'roots', arguments: {}, task: {} });
		assert.strictEqual(transport.getSentRequests('tasks/update').length, 1);
		assert.strictEqual(transport.getSentRequests('tasks/get').length, 3);
	}));

	test('a failed task rejects with its inlined error, a task the server cancelled with a cancellation', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const failing = taskServer([{ status: 'failed', error: { code: MCP.INTERNAL_ERROR, message: 'boom', data: { x: 1 } } }], { pollIntervalMs: 100 });
		const handler = await connect(failing.transport);
		await assert.rejects(handler.callTool({ name: 'job', arguments: {}, task: {} }), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.INTERNAL_ERROR && e.message.includes('boom') && (e.data as { x: number }).x === 1);
		const cancelled = taskServer([{ status: 'cancelled' }], { pollIntervalMs: 100 });
		const other = await connect(cancelled.transport);
		await assert.rejects(other.callTool({ name: 'job', arguments: {}, task: {} }), (e: unknown) => e instanceof CancellationError);
		const empty = taskServer([{ status: 'completed' }], { pollIntervalMs: 100 });
		const third = await connect(empty.transport);
		await assert.rejects(third.callTool({ name: 'job', arguments: {}, task: {} }), (e: unknown) => e instanceof McpClientError && e.reason === 'invalid-result-type');
	}));

	test('an unknown task (-32602 on tasks/get) rejects the call', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const { transport } = taskServer([{ status: 'working' }], { pollIntervalMs: 100 });
		transport.setResponder('tasks/get', req => ({ jsonrpc: MCP.JSONRPC_VERSION, id: req.id, error: { code: MCP.INVALID_PARAMS, message: 'Unknown task' } }));
		const handler = await connect(transport);
		await assert.rejects(handler.callTool({ name: 'job', arguments: {}, task: {} }), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.INVALID_PARAMS);
	}));

	test('cancelling the call sends tasks/cancel once and stops polling', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const { transport } = taskServer([{ status: 'working' }], { pollIntervalMs: 100 });
		const handler = await connect(transport);
		const cts = new CancellationTokenSource();
		const call = handler.callTool({ name: 'slow', arguments: {}, task: {} }, cts.token);
		await Event.toPromise(Event.filter(transport.onDidReceiveMessage, () => transport.getSentRequests('tasks/get').length >= 2));
		cts.cancel();
		await assert.rejects(call, (e: unknown) => e instanceof CancellationError);
		const polled = transport.getSentRequests('tasks/get').length;
		const cancels = transport.getSentRequests('tasks/cancel');
		assert.strictEqual(cancels.length, 1);
		assert.deepStrictEqual(paramsOf(cancels[0]).taskId, 'task-1');
		assert.strictEqual(declaresTasks(cancels[0]), true);
		await new Promise(resolve => setTimeout(resolve, 1000));
		assert.strictEqual(transport.getSentRequests('tasks/get').length, polled, 'no more polls');
		cts.dispose();
	}));

	test('a status notification triggers an early poll', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const { transport, polls } = taskServer([{ status: 'working' }, { status: 'completed', result: { content: [] } }], { pollIntervalMs: 10_000 });
		const handler = await connect(transport);
		const start = Date.now();
		const call = handler.callTool({ name: 'slow', arguments: {}, task: {} });
		await Event.toPromise(Event.filter(transport.onDidReceiveMessage, () => transport.getSentRequests('tools/call').length === 1));
		await new Promise(resolve => setTimeout(resolve, 50));
		transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, method: 'notifications/tasks/status', params: { taskId: 'task-1', status: 'completed' } });
		await call;
		assert.ok(polls[0] - start < 10_000, 'polled before the interval ended');
	}));

	test('the task survives a reconnection: polling continues on the new handler', () => runWithFakedTimers({ useFakeTimers: true, maxTaskCount: 1000 }, async () => {
		const taskManager = store.add(new McpTaskManager());
		const first = taskServer([{ status: 'working' }], { pollIntervalMs: 100 });
		const firstStore = new DisposableStore();
		first.transport.setConnectionState({ state: McpConnectionState.Kind.Running });
		const handler = firstStore.add(await McpServerRequestHandler.create(instantiationService, { logger, launch: first.transport, taskManager }));
		const call = handler.callTool({ name: 'slow', arguments: {}, task: {} });
		await Event.toPromise(Event.filter(first.transport.onDidReceiveMessage, () => first.transport.getSentRequests('tasks/get').length >= 1));
		firstStore.dispose();

		const second = taskServer([{ status: 'completed', result: { content: [{ type: 'text', text: 'after reconnect' }] } }], { pollIntervalMs: 100 });
		await connect(second.transport, {}, taskManager);
		const result = await call;
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'after reconnect' }]);
		assert.ok(second.transport.getSentRequests('tasks/get').length >= 1);
	}));

	test('legacy servers keep the 2025-11-25 task param', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'legacy' }));
		transport.setResponder('tools/call', req => ({ jsonrpc: MCP.JSONRPC_VERSION, id: req.id, result: { content: [] } satisfies MCPLegacy.CallToolResult }));
		const handler = await connect(transport);
		await handler.callTool({ name: 'x', arguments: {}, task: { ttl: 1000 } });
		assert.deepStrictEqual(paramsOf(transport.getSentRequests('tools/call')[0]).task, { ttl: 1000 });
	});
});
