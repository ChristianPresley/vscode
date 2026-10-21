/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewayInputRequired, IMcpGatewayInvokeContext, IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';
import { McpTasks } from '../common/modelContextProtocolTasks.js';

/**
 * The gateway side of the Tasks extension of MCP 2026-07-28
 * (`io.modelcontextprotocol/tasks`, SEP-2663).
 *
 * A tool that can run as a task says so in its listing
 * (`execution.taskSupport`: `optional` or `required`) and returns
 * {@link startTaskResult} from a call that runs outside a task. For a
 * request that declares the extension in its `_meta.clientCapabilities`
 * (per request: the 2026-07-28 wire is stateless), the gateway then creates
 * the task, answers with a flat {@link McpTasks.CreateTaskResult} and calls
 * the tool again in the background with {@link taskRunOf} set. A request
 * without the extension gets the tool's body at once (an `optional` tool) or
 * `-32021` (a `required` tool). A tool may skip the task for a call it can
 * answer at once (the immediate-result shortcut) and may first gather input
 * through ordinary `input_required` rounds before it asks for the task.
 *
 * The task body can ask for input: the task waits in `input_required` with
 * the pending requests, the client answers them with `tasks/update` (all at
 * once or one by one) and the body runs again with every answer collected so
 * far. The upstream `requestState` of a round stays in the gateway; the task
 * wire carries none. `tasks/get` inlines the result or the error once the
 * task settled, `tasks/cancel` is an empty acknowledgement (also for a task
 * that already settled), and an unknown task id is `-32602`.
 */

export type McpGatewayTaskSupport = 'optional' | 'required';

export interface IMcpGatewayTaskOptions {
	/** How long a task stays readable after its creation, in milliseconds. */
	readonly ttlMs?: number;
	/** The poll interval the gateway advises, in milliseconds. */
	readonly pollIntervalMs?: number;
	/** The tasks kept at the same time; one more is refused with `-32603`. */
	readonly maxTasks?: number;
}

export const DEFAULT_TASK_TTL_MS = 600_000;
export const DEFAULT_TASK_POLL_INTERVAL_MS = 1000;
export const DEFAULT_MAX_TASKS = 1024;
/** Rounds in a row that only carry a new `requestState` (no input requests) before the task fails. */
export const MAX_TASK_STATE_ONLY_ROUNDS = 10;

/** An invoker whose tools can run as tasks; the gateway advertises the extension for it. */
export interface IMcpGatewayTaskCapableInvoker extends IMcpGatewaySingleServerInvoker {
	readonly tasks: IMcpGatewayTaskOptions;
}

/** The task options of an invoker that implements {@link IMcpGatewayTaskCapableInvoker}. */
export function taskOptionsOf(invoker: IMcpGatewaySingleServerInvoker): IMcpGatewayTaskOptions | undefined {
	const tasks = (invoker as Partial<IMcpGatewayTaskCapableInvoker>).tasks;
	return typeof tasks === 'object' && tasks !== null ? tasks : undefined;
}

/** How a tool relates to tasks, from its listing; undefined for a tool that never becomes a task. */
export function taskSupportOf(tool: MCPLegacy.Tool | undefined): McpGatewayTaskSupport | undefined {
	const support = tool?.execution?.taskSupport;
	return support === 'optional' || support === 'required' ? support : undefined;
}

/** The tool without `execution.taskSupport` (for a wire on which the gateway runs no tasks). */
export function withoutTaskSupport(tool: MCPLegacy.Tool): MCPLegacy.Tool {
	if (tool.execution?.taskSupport === undefined) {
		return tool;
	}
	const { taskSupport: _taskSupport, ...execution } = tool.execution;
	const copy: MCPLegacy.Tool = { ...tool, execution };
	if (Object.keys(execution).length === 0) {
		delete copy.execution;
	}
	return copy;
}

/** Whether a request's client capabilities declare the Tasks extension. */
export function clientDeclaresTasks(capabilities: MCP.ClientCapabilities | undefined): boolean {
	const extensions: unknown = capabilities?.extensions;
	if (typeof extensions !== 'object' || extensions === null) {
		return false;
	}
	const value = (extensions as Record<string, unknown>)[McpTasks.EXTENSION_ID];
	return typeof value === 'object' && value !== null;
}

/** The `-32021` error for a request that needs the Tasks extension but did not declare it. */
export function missingTasksExtensionError(): McpGatewayRpcError {
	return new McpGatewayRpcError(
		MCP.MISSING_REQUIRED_CLIENT_CAPABILITY,
		`Missing required client capability: the ${McpTasks.EXTENSION_ID} extension`,
		{ requiredCapabilities: { extensions: { [McpTasks.EXTENSION_ID]: {} } } },
	);
}

/** Where a tool call runs when the tool asked for a task. */
export interface IMcpGatewayTaskRun {
	readonly taskId: string;
	/** True when the client did not opt into tasks: the body runs inside the request that called the tool. */
	readonly synthetic: boolean;
}

/** The invoke context of a tool call that runs as the body of a task. */
export interface IMcpGatewayTaskInvokeContext extends IMcpGatewayInvokeContext {
	readonly task?: IMcpGatewayTaskRun;
}

/** The task a tool call runs in, or undefined outside a task. */
export function taskRunOf(context: IMcpGatewayInvokeContext | undefined): IMcpGatewayTaskRun | undefined {
	return (context as IMcpGatewayTaskInvokeContext | undefined)?.task;
}

/**
 * What the body of a task keeps of the request that created it: plain
 * values only. A task outlives its request (until its TTL), so it must not
 * hold the request's invoke context, whose `onProgress`, `onLog` and
 * `closeSseStream` reach the request's response stream, its headers and its
 * token.
 */
export interface IMcpGatewayTaskOrigin {
	readonly protocolVersion: string;
	readonly clientCapabilities: MCP.ClientCapabilities;
	readonly clientInfo?: MCP.Implementation;
	readonly logLevel?: MCP.LoggingLevel;
	readonly chatSessionResource?: string;
}

/** Copies the fields a task body needs out of the creating request's invoke context. */
export function taskOriginOf(context: IMcpGatewayInvokeContext): IMcpGatewayTaskOrigin {
	return {
		protocolVersion: context.protocolVersion,
		clientCapabilities: context.clientCapabilities,
		clientInfo: context.clientInfo,
		logLevel: context.logLevel,
		chatSessionResource: context.chatSessionResource,
	};
}

const startTaskMarkers = new WeakSet<object>();

/**
 * What a task tool returns from a call outside a task: "run me as a task".
 * The marker never reaches the wire; the gateway recognises it with
 * {@link isStartTaskResult} and calls the tool again inside the task.
 */
export function startTaskResult(): MCPLegacy.CallToolResult {
	const marker: MCPLegacy.CallToolResult = { content: [] };
	startTaskMarkers.add(marker);
	return marker;
}

export function isStartTaskResult(value: unknown): boolean {
	return typeof value === 'object' && value !== null && startTaskMarkers.has(value);
}

function isInputRequired(value: unknown): value is IMcpGatewayInputRequired {
	return typeof value === 'object' && value !== null && (value as { resultType?: unknown }).resultType === 'input_required';
}

/** One run of a task body: the answers collected so far and the upstream state of the last round. */
export interface IMcpGatewayTaskRunInput {
	readonly taskId: string;
	readonly inputResponses: MCP.InputResponses | undefined;
	readonly requestState: string | undefined;
	readonly token: CancellationToken;
}

/**
 * Runs the task body once. Throws {@link McpGatewayRpcError} for a protocol
 * error (the task fails with it) and a cancellation error when the token was
 * cancelled.
 */
export type McpGatewayTaskBody = (run: IMcpGatewayTaskRunInput) => Promise<MCPLegacy.CallToolResult | IMcpGatewayInputRequired>;

export interface IMcpGatewayTaskSeed {
	/** The answers the creating request carried (a tool that gathered input before it asked for the task). */
	readonly inputResponses?: MCP.InputResponses;
	/** The upstream state the creating request carried (already unsealed). */
	readonly requestState?: string;
}

export interface IMcpGatewayTaskStatusChange {
	readonly taskId: string;
	readonly status: McpTasks.TaskStatus;
}

interface ITaskRecord {
	readonly id: string;
	readonly label: string;
	readonly body: McpGatewayTaskBody;
	readonly createdAt: number;
	readonly ttlMs: number;
	readonly cts: CancellationTokenSource;
	updatedAt: number;
	status: McpTasks.TaskStatus;
	statusMessage?: string;
	/** The input requests still unanswered (status `input_required`). */
	pending?: Record<string, MCP.InputRequest>;
	/** Every answer collected so far, by request key. */
	readonly responses: Record<string, MCP.InputResponse>;
	/** The upstream state of the last input round; never leaves the gateway. */
	requestState?: string;
	result?: MCPLegacy.CallToolResult;
	error?: MCP.Error;
	/** Incremented for every run, so that a late answer of an abandoned run is ignored. */
	generation: number;
	stateOnlyRounds: number;
}

const RELATED_TASK_META = 'io.modelcontextprotocol/related-task';

function isTerminal(status: McpTasks.TaskStatus): boolean {
	return McpTasks.isTerminalStatus(status);
}

/**
 * The tool result as `tasks/get` inlines it: a 2026-07-28 result (with its
 * `resultType`) without the 2025-11-25 related-task `_meta`, since the task id
 * is at the root of the `tasks/get` result.
 */
function inlinedResult(result: MCPLegacy.CallToolResult): MCP.Result {
	const copy: Record<string, unknown> = { ...result, resultType: typeof result.resultType === 'string' ? result.resultType : 'complete' };
	const meta = result._meta;
	if (isObject(meta) && Object.prototype.hasOwnProperty.call(meta, RELATED_TASK_META)) {
		const rest: Record<string, unknown> = { ...meta };
		delete rest[RELATED_TASK_META];
		if (Object.keys(rest).length > 0) {
			copy._meta = rest;
		} else {
			delete copy._meta;
		}
	}
	return copy as MCP.Result;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The tasks of one gateway route, in memory. A task is in the store before
 * its `CreateTaskResult` is returned, so a `tasks/get` right after it
 * resolves. A task stays readable for its `ttlMs` after creation and is
 * dropped (cancelled first, when it still runs) on the first access after
 * that.
 */
export class McpGatewayTaskStore extends Disposable {
	private readonly _tasks = new Map<string, ITaskRecord>();
	private readonly _onDidChangeStatus = this._register(new Emitter<IMcpGatewayTaskStatusChange>());
	/** Fires when a task changes its status (diagnostics, tests, status notifications). */
	readonly onDidChangeStatus: Event<IMcpGatewayTaskStatusChange> = this._onDidChangeStatus.event;
	private readonly _ttlMs: number;
	private readonly _pollIntervalMs: number;
	private readonly _maxTasks: number;

	constructor(
		options: IMcpGatewayTaskOptions,
		private readonly _logger: ILogger,
		private readonly _logPrefix: string,
		private readonly _now: () => number = Date.now,
	) {
		super();
		this._ttlMs = positiveInteger(options.ttlMs, DEFAULT_TASK_TTL_MS);
		this._pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_TASK_POLL_INTERVAL_MS);
		this._maxTasks = positiveInteger(options.maxTasks, DEFAULT_MAX_TASKS);
	}

	get size(): number {
		return this._tasks.size;
	}

	get pollIntervalMs(): number {
		return this._pollIntervalMs;
	}

	/** Creates a task, starts its body and returns the `CreateTaskResult` (status `working`). */
	create(label: string, body: McpGatewayTaskBody, seed: IMcpGatewayTaskSeed = {}): McpTasks.CreateTaskResult {
		if (this._store.isDisposed) {
			throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'The gateway is shutting down');
		}
		this._sweep();
		if (this._tasks.size >= this._maxTasks) {
			throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `Too many tasks (the limit is ${this._maxTasks})`);
		}
		const now = this._now();
		const record: ITaskRecord = {
			id: generateUuid(),
			label,
			body,
			createdAt: now,
			updatedAt: now,
			ttlMs: this._ttlMs,
			cts: new CancellationTokenSource(),
			status: 'working',
			responses: { ...seed.inputResponses },
			requestState: seed.requestState,
			generation: 0,
			stateOnlyRounds: 0,
		};
		this._tasks.set(record.id, record);
		this._logger.debug(`${this._logPrefix} Created task ${record.id} for ${label}`);
		const created: McpTasks.CreateTaskResult = {
			resultType: McpTasks.RESULT_TYPE_TASK,
			taskId: record.id,
			status: record.status,
			createdAt: new Date(record.createdAt).toISOString(),
			lastUpdatedAt: new Date(record.updatedAt).toISOString(),
			ttlMs: record.ttlMs,
			pollIntervalMs: this._pollIntervalMs,
		};
		this._start(record);
		return created;
	}

	/** The `tasks/get` result (the dispatcher adds the envelope's `_meta`). */
	get(taskId: string): McpTasks.Task {
		const record = this._find(taskId);
		const task: McpTasks.Task = {
			resultType: 'complete',
			taskId: record.id,
			status: record.status,
			createdAt: new Date(record.createdAt).toISOString(),
			lastUpdatedAt: new Date(record.updatedAt).toISOString(),
			ttlMs: record.ttlMs,
			pollIntervalMs: this._pollIntervalMs,
		};
		if (record.statusMessage !== undefined) {
			task.statusMessage = record.statusMessage;
		}
		if (record.status === 'input_required' && record.pending) {
			task.inputRequests = { ...record.pending };
		}
		if (record.status === 'completed' && record.result) {
			task.result = inlinedResult(record.result);
		}
		if (record.status === 'failed' && record.error) {
			task.error = record.error;
		}
		return task;
	}

	/**
	 * Delivers answers. Answers to keys the task does not wait for are
	 * ignored; once no request is pending the body runs again. A task that is
	 * not waiting for input ignores the update.
	 */
	update(taskId: string, inputResponses: MCP.InputResponses): void {
		const record = this._find(taskId);
		if (record.status !== 'input_required' || !record.pending) {
			return;
		}
		const pending = record.pending;
		for (const [key, response] of Object.entries(inputResponses)) {
			if (Object.prototype.hasOwnProperty.call(pending, key)) {
				record.responses[key] = response;
				delete pending[key];
			}
		}
		record.updatedAt = this._now();
		if (Object.keys(pending).length === 0) {
			record.pending = undefined;
			record.status = 'working';
			record.statusMessage = undefined;
			this._onDidChangeStatus.fire({ taskId: record.id, status: record.status });
			this._start(record);
		}
	}

	/** Cancels a task; a task that already settled stays as it is. */
	cancel(taskId: string): void {
		const record = this._find(taskId);
		if (isTerminal(record.status)) {
			return;
		}
		this._settle(record, 'cancelled', 'The task was cancelled by the client');
		record.cts.cancel();
		this._logger.debug(`${this._logPrefix} Cancelled task ${record.id}`);
	}

	override dispose(): void {
		for (const record of this._tasks.values()) {
			record.cts.dispose(true);
		}
		this._tasks.clear();
		super.dispose();
	}

	private _find(taskId: string): ITaskRecord {
		this._sweep();
		const record = this._tasks.get(taskId);
		if (!record) {
			throw new McpGatewayRpcError(MCP.INVALID_PARAMS, `Unknown task: ${taskId}`, { taskId });
		}
		return record;
	}

	/** Drops the tasks whose lifetime ended. */
	private _sweep(): void {
		const now = this._now();
		for (const record of [...this._tasks.values()]) {
			if (now - record.createdAt > record.ttlMs) {
				this._tasks.delete(record.id);
				record.cts.dispose(true);
				this._logger.debug(`${this._logPrefix} Task ${record.id} expired`);
			}
		}
	}

	private _settle(record: ITaskRecord, status: McpTasks.TaskStatus, statusMessage?: string): void {
		record.status = status;
		record.statusMessage = statusMessage;
		record.pending = undefined;
		record.updatedAt = this._now();
		this._onDidChangeStatus.fire({ taskId: record.id, status });
	}

	private _start(record: ITaskRecord): void {
		const generation = ++record.generation;
		void this._run(record, generation);
	}

	private async _run(record: ITaskRecord, generation: number): Promise<void> {
		const current = () => record.generation === generation && !isTerminal(record.status) && this._tasks.get(record.id) === record;
		let outcome: MCPLegacy.CallToolResult | IMcpGatewayInputRequired;
		try {
			outcome = await record.body({
				taskId: record.id,
				inputResponses: Object.keys(record.responses).length > 0 ? { ...record.responses } : undefined,
				requestState: record.requestState,
				token: record.cts.token,
			});
		} catch (error) {
			if (!current()) {
				return;
			}
			if (error instanceof CancellationError || record.cts.token.isCancellationRequested) {
				this._settle(record, 'cancelled', 'The task was cancelled');
				return;
			}
			if (error instanceof McpGatewayRpcError) {
				record.error = error.data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data: error.data };
			} else {
				this._logger.error(`${this._logPrefix} Task ${record.id} (${record.label}) failed`, error);
				record.error = { code: MCP.INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) };
			}
			this._settle(record, 'failed', record.error.message);
			return;
		}
		if (!current()) {
			return;
		}
		if (isStartTaskResult(outcome)) {
			record.error = { code: MCP.INTERNAL_ERROR, message: 'The tool asked for a task inside its task' };
			this._settle(record, 'failed', record.error.message);
			return;
		}
		if (isInputRequired(outcome)) {
			record.requestState = outcome.requestState;
			const requests = isObject(outcome.inputRequests) ? outcome.inputRequests : {};
			if (Object.keys(requests).length === 0) {
				// A round that only carries state: run again with it.
				if (++record.stateOnlyRounds > MAX_TASK_STATE_ONLY_ROUNDS) {
					record.error = { code: MCP.INTERNAL_ERROR, message: `The tool returned more than ${MAX_TASK_STATE_ONLY_ROUNDS} rounds without input requests` };
					this._settle(record, 'failed', record.error.message);
					return;
				}
				this._start(record);
				return;
			}
			record.stateOnlyRounds = 0;
			record.pending = { ...requests };
			record.status = 'input_required';
			record.statusMessage = undefined;
			record.updatedAt = this._now();
			this._onDidChangeStatus.fire({ taskId: record.id, status: record.status });
			return;
		}
		record.result = outcome;
		this._settle(record, 'completed');
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
