/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IMcpGatewayInputRequired, IMcpGatewaySingleServerInvoker } from '../../common/mcpGateway.js';
import { McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_SERVER_INFO } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { McpTasks } from '../../common/modelContextProtocolTasks.js';
import { CONFORMANCE_SERVER_INFO, CONFORMANCE_TASK_OPTIONS, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { IMcpGatewayDispatchContext, McpGatewayDispatcher, McpGatewayResourceNotFoundError } from '../../node/mcpGatewayDispatcher.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';
import { clientDeclaresTasks, IMcpGatewayTaskRunInput, isStartTaskResult, McpGatewayTaskBody, McpGatewayTaskStore, startTaskResult, taskOptionsOf, taskRunOf, taskSupportOf, withoutTaskSupport } from '../../node/mcpGatewayTasks.js';

const TASKS: MCP.ClientCapabilities = { extensions: { [McpTasks.EXTENSION_ID]: {} } };
const ALL_WITH_TASKS: MCP.ClientCapabilities = { elicitation: { form: {}, url: {} }, sampling: {}, roots: {}, extensions: { [McpTasks.EXTENSION_ID]: {} } };
const ALL_WITHOUT_TASKS: MCP.ClientCapabilities = { elicitation: { form: {}, url: {} }, sampling: {}, roots: {} };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

async function assertRpcError(promise: Promise<unknown> | (() => unknown), code: number, check?: (error: McpGatewayRpcError) => void): Promise<void> {
	const run = typeof promise === 'function' ? Promise.resolve().then(promise) : promise;
	await assert.rejects(run, (error: unknown) => {
		assert.ok(error instanceof McpGatewayRpcError, `expected an McpGatewayRpcError, got ${error}`);
		assert.strictEqual(error.code, code, error.message);
		check?.(error);
		return true;
	});
}

function text(value: string): MCPLegacy.CallToolResult {
	return { content: [{ type: 'text', text: value }] };
}

function textOf(result: unknown): string {
	const first = (result as MCPLegacy.CallToolResult | undefined)?.content?.[0];
	return first?.type === 'text' ? first.text : '';
}

/** Resolves with the task once `predicate` holds, waiting for the store's status changes. */
async function whenTask(tasks: McpGatewayTaskStore, taskId: string, predicate: (task: McpTasks.Task) => boolean): Promise<McpTasks.Task> {
	if (!predicate(tasks.get(taskId))) {
		await Event.toPromise(Event.filter(tasks.onDidChangeStatus, change => change.taskId === taskId && predicate(tasks.get(taskId))));
	}
	return tasks.get(taskId);
}

const elicit = (message: string): MCP.InputRequest => ({ method: 'elicitation/create', params: { message, requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } });

suite('MCP - GatewayTaskStore', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const logger = new NullLogService();
	let now: number;

	setup(() => {
		now = Date.UTC(2026, 6, 28, 12, 0, 0);
	});

	function createStore(options = { ttlMs: 60_000, pollIntervalMs: 250, maxTasks: 3 }): McpGatewayTaskStore {
		return store.add(new McpGatewayTaskStore(options, logger, '[test]', () => now));
	}

	/** A task body the test answers run by run. */
	function scriptedBody() {
		const runs: Array<{ readonly input: IMcpGatewayTaskRunInput; readonly answer: DeferredPromise<MCPLegacy.CallToolResult | IMcpGatewayInputRequired> }> = [];
		let onRun: (() => void) | undefined;
		const body: McpGatewayTaskBody = input => {
			const answer = new DeferredPromise<MCPLegacy.CallToolResult | IMcpGatewayInputRequired>();
			const listener = input.token.onCancellationRequested(() => {
				listener.dispose();
				answer.error(new CancellationError());
			});
			runs.push({ input, answer });
			onRun?.();
			return answer.p.finally(() => listener.dispose());
		};
		const waitForRuns = async (count: number) => {
			while (runs.length < count) {
				await new Promise<void>(resolve => { onRun = resolve; });
			}
		};
		return { body, runs, waitForRuns };
	}

	/** The task once it settled or waits for input. */
	function settled(tasks: McpGatewayTaskStore, taskId: string): Promise<McpTasks.Task> {
		return whenTask(tasks, taskId, task => McpTasks.isTerminalStatus(task.status) || task.status === 'input_required');
	}

	test('a created task is flat, working, readable at once and carries integer ttlMs and pollIntervalMs', async () => {
		const tasks = createStore();
		const { body, runs } = scriptedBody();
		const created = tasks.create('slow', body);
		assert.strictEqual(created.resultType, 'task');
		assert.strictEqual(created.status, 'working');
		assert.ok(ISO.test(created.createdAt) && ISO.test(created.lastUpdatedAt));
		assert.strictEqual(created.ttlMs, 60_000);
		assert.strictEqual(created.pollIntervalMs, 250);
		for (const key of ['task', 'result', 'error', 'inputRequests', 'requestState', 'ttl', 'pollInterval']) {
			assert.strictEqual(Object.prototype.hasOwnProperty.call(created, key), false, key);
		}
		const got = tasks.get(created.taskId);
		assert.deepStrictEqual({ taskId: got.taskId, status: got.status, resultType: got.resultType }, { taskId: created.taskId, status: 'working', resultType: 'complete' });
		assert.strictEqual(got.result, undefined);
		assert.strictEqual(runs.length, 1, 'the body started');
		runs[0].answer.complete(text('done'));
		const done = await settled(tasks, created.taskId);
		assert.strictEqual(done.status, 'completed');
		assert.deepStrictEqual(done.result, { resultType: 'complete', content: [{ type: 'text', text: 'done' }] });
	});

	test('the inlined result loses the related-task _meta but keeps the other keys', async () => {
		const tasks = createStore();
		const created = tasks.create('meta', async () => ({ content: [], _meta: { 'io.modelcontextprotocol/related-task': { taskId: 'x' }, keep: 1 } }));
		const done = await settled(tasks, created.taskId);
		assert.deepStrictEqual(done.result?._meta, { keep: 1 });
		const bare = tasks.create('meta', async () => ({ content: [], _meta: { 'io.modelcontextprotocol/related-task': { taskId: 'x' } } }));
		const bareDone = await settled(tasks, bare.taskId);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(bareDone.result, '_meta'), false);
	});

	test('a protocol error fails the task with the inlined error and no result; other errors become -32603', async () => {
		const tasks = createStore();
		const failed = tasks.create('rpc', async () => { throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'boom', { why: 'test' }); });
		const task = await settled(tasks, failed.taskId);
		assert.strictEqual(task.status, 'failed');
		assert.deepStrictEqual(task.error, { code: MCP.INTERNAL_ERROR, message: 'boom', data: { why: 'test' } });
		assert.strictEqual(task.result, undefined);
		const thrown = tasks.create('plain', async () => { throw new Error('plain failure'); });
		assert.deepStrictEqual((await settled(tasks, thrown.taskId)).error, { code: MCP.INTERNAL_ERROR, message: 'plain failure' });
		const nested = tasks.create('nested', async () => startTaskResult());
		assert.strictEqual((await settled(tasks, nested.taskId)).status, 'failed', 'asking for a task inside the task');
	});

	test('cancel cancels the body and settles as cancelled; it is idempotent on a settled task; unknown ids are -32602', async () => {
		const tasks = createStore();
		const { body, runs } = scriptedBody();
		const created = tasks.create('slow', body);
		tasks.cancel(created.taskId);
		assert.strictEqual(runs[0].input.token.isCancellationRequested, true);
		assert.strictEqual(tasks.get(created.taskId).status, 'cancelled');
		await timeout(0);
		assert.strictEqual(tasks.get(created.taskId).status, 'cancelled', 'the body\'s cancellation does not change it');
		tasks.cancel(created.taskId);
		const completed = tasks.create('fast', async () => text('ok'));
		await settled(tasks, completed.taskId);
		tasks.cancel(completed.taskId);
		assert.strictEqual(tasks.get(completed.taskId).status, 'completed');
		await assertRpcError(() => tasks.get('nope'), MCP.INVALID_PARAMS);
		await assertRpcError(() => tasks.cancel('nope'), MCP.INVALID_PARAMS);
		await assertRpcError(() => tasks.update('nope', {}), MCP.INVALID_PARAMS);
	});

	test('input rounds: pending requests on get, partial updates, unknown keys ignored, then a run with every answer and the state', async () => {
		const tasks = createStore();
		const { body, runs, waitForRuns } = scriptedBody();
		const created = tasks.create('ask', body, { inputResponses: { early: { action: 'accept', content: { name: 'seed' } } }, requestState: 'state-0' });
		assert.deepStrictEqual(runs[0].input.inputResponses, { early: { action: 'accept', content: { name: 'seed' } } });
		assert.strictEqual(runs[0].input.requestState, 'state-0');
		runs[0].answer.complete({ resultType: 'input_required', inputRequests: { first: elicit('First?'), second: elicit('Second?') }, requestState: 'state-1' });
		const waiting = await settled(tasks, created.taskId);
		assert.strictEqual(waiting.status, 'input_required');
		assert.deepStrictEqual(Object.keys(waiting.inputRequests ?? {}), ['first', 'second']);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(waiting, 'requestState'), false, 'the state stays in the gateway');

		tasks.update(created.taskId, { first: { action: 'accept', content: { name: 'A' } }, unknown: { action: 'decline' } });
		const partial = tasks.get(created.taskId);
		assert.strictEqual(partial.status, 'input_required');
		assert.deepStrictEqual(Object.keys(partial.inputRequests ?? {}), ['second']);
		assert.strictEqual(runs.length, 1, 'no run while a request is pending');

		tasks.update(created.taskId, { second: { action: 'accept', content: { name: 'B' } } });
		assert.strictEqual(tasks.get(created.taskId).status, 'working');
		await waitForRuns(2);
		assert.deepStrictEqual(runs[1].input.inputResponses, {
			early: { action: 'accept', content: { name: 'seed' } },
			first: { action: 'accept', content: { name: 'A' } },
			second: { action: 'accept', content: { name: 'B' } },
		});
		assert.strictEqual(runs[1].input.requestState, 'state-1');
		runs[1].answer.complete(text('A and B'));
		assert.strictEqual(textOf((await settled(tasks, created.taskId)).result), 'A and B');
		tasks.update(created.taskId, { second: { action: 'decline' } });
		assert.strictEqual(tasks.get(created.taskId).status, 'completed', 'an update after the end is ignored');
	});

	test('a round with only a new state runs again, a bounded number of times', async () => {
		const tasks = createStore();
		let calls = 0;
		const created = tasks.create('state', async run => {
			calls++;
			return run.requestState === 'go' ? text('went') : { resultType: 'input_required', requestState: 'go' };
		});
		assert.strictEqual(textOf((await settled(tasks, created.taskId)).result), 'went');
		assert.strictEqual(calls, 2);
		const looping = tasks.create('loop', async () => ({ resultType: 'input_required', requestState: 'again' }));
		assert.strictEqual((await settled(tasks, looping.taskId)).status, 'failed');
	});

	test('a task stays readable for its ttlMs and is dropped after it; the number of tasks is bounded', async () => {
		const tasks = createStore();
		const created = tasks.create('fast', async () => text('ok'));
		await settled(tasks, created.taskId);
		now += 60_000;
		assert.strictEqual(tasks.get(created.taskId).status, 'completed', 'still readable at its ttlMs');
		now += 1;
		await assertRpcError(() => tasks.get(created.taskId), MCP.INVALID_PARAMS);
		const { body } = scriptedBody();
		tasks.create('a', body);
		tasks.create('b', body);
		tasks.create('c', body);
		await assertRpcError(() => tasks.create('d', body), MCP.INTERNAL_ERROR);
		assert.strictEqual(tasks.size, 3);
	});

	test('helpers: the start marker, the task run, the extension check and the tool support', () => {
		assert.strictEqual(isStartTaskResult(startTaskResult()), true);
		assert.strictEqual(isStartTaskResult({ content: [] }), false);
		assert.strictEqual(taskRunOf(undefined), undefined);
		assert.strictEqual(clientDeclaresTasks(TASKS), true);
		assert.strictEqual(clientDeclaresTasks({}), false);
		assert.strictEqual(clientDeclaresTasks({ extensions: { [McpTasks.EXTENSION_ID]: null as unknown as MCP.JSONObject } }), false);
		assert.strictEqual(clientDeclaresTasks({ extensions: 5 as unknown as MCP.ClientCapabilities['extensions'] }), false);
		assert.strictEqual(taskSupportOf({ name: 't', inputSchema: { type: 'object' }, execution: { taskSupport: 'forbidden' } }), undefined);
		assert.strictEqual(taskSupportOf({ name: 't', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }), 'required');
		assert.deepStrictEqual(withoutTaskSupport({ name: 't', inputSchema: { type: 'object' }, execution: { taskSupport: 'optional' } }), { name: 't', inputSchema: { type: 'object' } });
		const invoker = store.add(new McpGatewayConformanceInvoker());
		assert.deepStrictEqual(taskOptionsOf(invoker), CONFORMANCE_TASK_OPTIONS);
	});
});

suite('MCP - GatewayDispatcher - Tasks extension', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const logger = new NullLogService();

	function createDispatcher(invoker?: IMcpGatewaySingleServerInvoker): McpGatewayDispatcher {
		return store.add(new McpGatewayDispatcher('route-1', logger, invoker ?? store.add(new McpGatewayConformanceInvoker()), new McpGatewaySealedState(), { serverInfo: CONFORMANCE_SERVER_INFO }));
	}

	function context(clientCapabilities: MCP.ClientCapabilities = ALL_WITH_TASKS, era: 'modern' | 'legacy' = 'modern'): IMcpGatewayDispatchContext {
		return {
			era,
			protocolVersion: era === 'modern' ? LATEST_MCP_PROTOCOL_VERSION : '2025-11-25',
			requestId: 1,
			clientCapabilities,
			headers: {},
			token: CancellationToken.None,
			notify: () => { },
			sendServerRequest: era === 'legacy' ? async () => ({ action: 'accept', content: { name: 'Legacy' } }) : undefined,
		};
	}

	const call = (dispatcher: McpGatewayDispatcher, name: string, args: Record<string, unknown> = {}, capabilities: MCP.ClientCapabilities = ALL_WITH_TASKS, extra: Record<string, unknown> = {}) =>
		dispatcher.dispatch(context(capabilities), 'tools/call', { name, arguments: args, ...extra }) as Promise<Record<string, unknown>>;
	const getTask = (dispatcher: McpGatewayDispatcher, taskId: string) => dispatcher.dispatch(context(), 'tasks/get', { taskId }) as Promise<McpTasks.Task>;

	/** The `tasks/get` result once the task left `working` (or reached `status`). */
	async function poll(dispatcher: McpGatewayDispatcher, taskId: string, status?: McpTasks.TaskStatus): Promise<McpTasks.Task> {
		const tasks = dispatcher.tasks;
		assert.ok(tasks);
		await whenTask(tasks, taskId, task => status ? task.status === status || McpTasks.isTerminalStatus(task.status) : task.status !== 'working');
		return getTask(dispatcher, taskId);
	}

	test('server/discover advertises the extension under capabilities.extensions, the legacy initialize does not', () => {
		const dispatcher = createDispatcher();
		const capabilities = dispatcher.discoverResult().capabilities;
		assert.deepStrictEqual(capabilities.extensions, { [McpTasks.EXTENSION_ID]: {} });
		assert.strictEqual(Object.prototype.hasOwnProperty.call(capabilities, 'tasks'), false);
		const legacy = dispatcher.legacyInitializeCapabilities();
		assert.strictEqual(legacy.extensions, undefined);
		assert.strictEqual(legacy.tasks, undefined);
		const plain = createDispatcher({
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			listTools: async () => [],
			callTool: async () => text('x'),
			listResources: async () => [],
			readResource: async uri => { throw new McpGatewayResourceNotFoundError(uri); },
			listResourceTemplates: async () => [],
		});
		assert.strictEqual(plain.discoverResult().capabilities.extensions, undefined, 'no tasks without a task-capable invoker');
		assert.strictEqual(plain.supportsMethod('tasks/get', 'modern'), false);
		assert.strictEqual(plain.tasks, undefined);
	});

	test('tasks/get, tasks/update and tasks/cancel need the extension in the request (-32021); tasks/list, tasks/result and legacy sessions get -32601', async () => {
		const dispatcher = createDispatcher();
		for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
			await assertRpcError(dispatcher.dispatch(context(ALL_WITHOUT_TASKS), method, { taskId: 'gate-test', inputResponses: {} }), MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, error => {
				assert.deepStrictEqual(error.data, { requiredCapabilities: { extensions: { [McpTasks.EXTENSION_ID]: {} } } });
			});
			await assertRpcError(dispatcher.dispatch(context(), method, { taskId: 'tasks-conformance-nonexistent-12345', inputResponses: {} }), MCP.INVALID_PARAMS);
			await assertRpcError(dispatcher.dispatch(context(ALL_WITH_TASKS, 'legacy'), method, { taskId: 'x' }), MCP.METHOD_NOT_FOUND);
		}
		for (const method of ['tasks/list', 'tasks/result']) {
			await assertRpcError(dispatcher.dispatch(context(), method, { taskId: 'x' }), MCP.METHOD_NOT_FOUND);
		}
		await assertRpcError(dispatcher.dispatch(context(), 'tasks/get', {}), MCP.INVALID_PARAMS);
	});

	test('a sync tool stays sync, also with a legacy task param; slow_compute with 0 seconds takes the immediate-result shortcut', async () => {
		const dispatcher = createDispatcher();
		const greet = await call(dispatcher, 'greet', { name: 'World' }, ALL_WITH_TASKS, { task: { ttl: 60_000, pollInterval: 100 } });
		assert.strictEqual(greet.resultType, 'complete');
		assert.strictEqual(greet.taskId, undefined);
		assert.strictEqual(textOf(greet), 'Hello, World!');
		const instant = await call(dispatcher, 'slow_compute', { seconds: 0, label: 'instant' });
		assert.strictEqual(instant.resultType, 'complete');
		assert.strictEqual(textOf(instant), 'computed instant after 0 s');
	});

	test('an opted-in call of a task tool answers a flat, enveloped CreateTaskResult and completes in the background', async () => {
		const dispatcher = createDispatcher();
		const created = await call(dispatcher, 'slow_compute', { seconds: 0.02, label: 'bg' });
		assert.strictEqual(created.resultType, 'task');
		assert.strictEqual(typeof created.taskId, 'string');
		assert.strictEqual(created.status, 'working');
		assert.strictEqual(created.ttlMs, CONFORMANCE_TASK_OPTIONS.ttlMs);
		assert.strictEqual(created.pollIntervalMs, CONFORMANCE_TASK_OPTIONS.pollIntervalMs);
		assert.deepStrictEqual((created._meta as Record<string, unknown>)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
		for (const key of ['task', 'content', 'requestState', 'inputRequests', 'result', 'error']) {
			assert.strictEqual(Object.prototype.hasOwnProperty.call(created, key), false, key);
		}
		const taskId = created.taskId as string;
		const first = await getTask(dispatcher, taskId);
		assert.strictEqual(first.taskId, taskId, 'durable before the CreateTaskResult');
		assert.strictEqual(first.resultType, 'complete');
		const done = await poll(dispatcher, taskId);
		assert.strictEqual(done.status, 'completed');
		assert.strictEqual(textOf(done.result), 'computed bg after 0.02 s');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(done, 'requestState'), false);
		assert.strictEqual((done.result?._meta as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/related-task'], undefined);
		const ack = await dispatcher.dispatch(context(), 'tasks/cancel', { taskId }) as Record<string, unknown>;
		assert.strictEqual(ack.resultType, 'complete');
		for (const key of ['taskId', 'status', 'result', 'error', 'inputRequests']) {
			assert.strictEqual(Object.prototype.hasOwnProperty.call(ack, key), false, key);
		}
		assert.strictEqual((await getTask(dispatcher, taskId)).status, 'completed', 'cancelling a settled task changes nothing');
	});

	test('without the extension an optional task tool runs at once and a required one is -32021 before it runs', async () => {
		const dispatcher = createDispatcher();
		const sync = await call(dispatcher, 'slow_compute', { seconds: 0.01, label: 'sync' }, ALL_WITHOUT_TASKS);
		assert.strictEqual(sync.resultType, 'complete');
		assert.strictEqual(sync.taskId, undefined);
		assert.strictEqual(textOf(sync), 'computed sync after 0.01 s');
		for (const name of ['failing_job', 'test_tool_with_task']) {
			await assertRpcError(call(dispatcher, name, {}, ALL_WITHOUT_TASKS), MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, error => {
				assert.deepStrictEqual(error.data, { requiredCapabilities: { extensions: { [McpTasks.EXTENSION_ID]: {} } } });
			});
		}
		const perRequest = await call(dispatcher, 'slow_compute', { seconds: 0.01 }, { extensions: { [McpTasks.EXTENSION_ID]: {} } });
		assert.strictEqual(perRequest.resultType, 'task', 'the extension in this request alone opts in');
		await poll(dispatcher, perRequest.taskId as string);
	});

	test('a tool error completes the task with isError; a protocol error fails it with the inlined error', async () => {
		const dispatcher = createDispatcher();
		const failing = await call(dispatcher, 'failing_job');
		assert.strictEqual(failing.resultType, 'task');
		const protocolError = await call(dispatcher, 'protocol_error_job');
		const failed = await poll(dispatcher, protocolError.taskId as string);
		assert.strictEqual(failed.status, 'failed');
		assert.strictEqual(failed.error?.code, MCP.INTERNAL_ERROR);
		assert.strictEqual(typeof failed.error?.message, 'string');
		assert.strictEqual(failed.result, undefined);
		const toolError = await poll(dispatcher, failing.taskId as string);
		assert.strictEqual(toolError.status, 'completed');
		assert.strictEqual((toolError.result as unknown as MCPLegacy.CallToolResult | undefined)?.isError, true);
	});

	test('tasks/cancel on a running task settles it as cancelled', async () => {
		const dispatcher = createDispatcher();
		const created = await call(dispatcher, 'slow_compute', { seconds: 60, label: 'cancel' });
		const ack = await dispatcher.dispatch(context(), 'tasks/cancel', { taskId: created.taskId }) as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(ack).sort(), ['_meta', 'resultType']);
		assert.strictEqual((await poll(dispatcher, created.taskId as string)).status, 'cancelled');
	});

	test('confirm_delete waits in input_required and tasks/update resumes it to completed', async () => {
		const dispatcher = createDispatcher();
		const created = await call(dispatcher, 'confirm_delete', { filename: 'a.txt' });
		const waiting = await poll(dispatcher, created.taskId as string, 'input_required');
		assert.strictEqual(waiting.status, 'input_required');
		const [key] = Object.keys(waiting.inputRequests ?? {});
		assert.strictEqual(waiting.inputRequests?.[key].method, 'elicitation/create');
		const unknownKey = await dispatcher.dispatch(context(), 'tasks/update', { taskId: created.taskId, inputResponses: { 'unknown-key': { ignored: true } } }) as Record<string, unknown>;
		assert.strictEqual(unknownKey.resultType, 'complete');
		assert.strictEqual((await getTask(dispatcher, created.taskId as string)).status, 'input_required');
		await assertRpcError(dispatcher.dispatch(context(), 'tasks/update', { taskId: created.taskId, inputResponses: null }), MCP.INVALID_PARAMS);
		const ack = await dispatcher.dispatch(context(), 'tasks/update', { taskId: created.taskId, inputResponses: { [key]: { action: 'accept', content: { confirm: true } } } }) as Record<string, unknown>;
		assert.deepStrictEqual(Object.keys(ack).sort(), ['_meta', 'resultType']);
		const done = await poll(dispatcher, created.taskId as string);
		assert.strictEqual(done.status, 'completed');
		assert.strictEqual(textOf(done.result), 'Deleted a.txt');
	});

	test('multi_input: a partial update keeps the task waiting for the other answer', async () => {
		const dispatcher = createDispatcher();
		const created = await call(dispatcher, 'multi_input');
		const taskId = created.taskId as string;
		const waiting = await poll(dispatcher, taskId, 'input_required');
		const [first, second] = Object.keys(waiting.inputRequests ?? {});
		assert.ok(first && second);
		await dispatcher.dispatch(context(), 'tasks/update', { taskId, inputResponses: { [first]: { action: 'accept', content: { name: 'partial-1' } } } });
		const partial = await getTask(dispatcher, taskId);
		assert.strictEqual(partial.status, 'input_required');
		assert.deepStrictEqual(Object.keys(partial.inputRequests ?? {}), [second]);
		await dispatcher.dispatch(context(), 'tasks/update', { taskId, inputResponses: { [second]: { action: 'accept', content: { name: 'partial-2' } } } });
		const done = await poll(dispatcher, taskId);
		assert.strictEqual(textOf(done.result), 'partial-1 and partial-2');
	});

	test('test_tool_with_task: an input_required round without a task, then a CreateTaskResult whose result has the answer', async () => {
		const dispatcher = createDispatcher();
		const round1 = await call(dispatcher, 'test_tool_with_task');
		assert.strictEqual(round1.resultType, 'input_required');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(round1, 'taskId'), false);
		const [key] = Object.keys(round1.inputRequests as object);
		const round2 = await call(dispatcher, 'test_tool_with_task', {}, ALL_WITH_TASKS, { inputResponses: { [key]: { action: 'accept', content: { name: 'Alice' } } } });
		assert.strictEqual(round2.resultType, 'task');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(round2, 'requestState'), false);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(round2, 'inputRequests'), false);
		const done = await poll(dispatcher, round2.taskId as string);
		assert.match(textOf(done.result), /Alice/);
	});

	test('an input request the creating client cannot answer fails the task with -32021', async () => {
		const dispatcher = createDispatcher();
		const created = await call(dispatcher, 'confirm_delete', {}, TASKS);
		const failed = await poll(dispatcher, created.taskId as string);
		assert.strictEqual(failed.status, 'failed');
		assert.strictEqual(failed.error?.code, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY);
	});

	test('legacy sessions: no task support in tools/list, task tools run at once', async () => {
		const dispatcher = createDispatcher();
		const legacyList = await dispatcher.dispatch(context(ALL_WITH_TASKS, 'legacy'), 'tools/list', {}) as MCPLegacy.ListToolsResult;
		assert.ok(legacyList.tools.every(tool => tool.execution?.taskSupport === undefined));
		const modernList = await dispatcher.dispatch(context(), 'tools/list', {}) as MCPLegacy.ListToolsResult;
		const supportOf = (name: string) => modernList.tools.find(tool => tool.name === name)?.execution?.taskSupport;
		assert.deepStrictEqual(['greet', 'slow_compute', 'failing_job', 'protocol_error_job', 'confirm_delete', 'multi_input', 'test_tool_with_task'].map(supportOf), [undefined, 'optional', 'required', 'optional', 'optional', 'optional', 'required']);
		const legacyCall = await dispatcher.dispatch(context(ALL_WITH_TASKS, 'legacy'), 'tools/call', { name: 'slow_compute', arguments: { seconds: 0.01, label: 'legacy' } }) as MCPLegacy.CallToolResult;
		assert.strictEqual(textOf(legacyCall), 'computed legacy after 0.01 s');
		const bridged = await dispatcher.dispatch(context(ALL_WITH_TASKS, 'legacy'), 'tools/call', { name: 'confirm_delete', arguments: { filename: 'b.txt' } }) as MCPLegacy.CallToolResult;
		assert.strictEqual(textOf(bridged), 'Deleted b.txt', 'the input round is bridged as a server request');
	});
});
