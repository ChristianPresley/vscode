/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, disposableTimeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ILogger } from '../../../../platform/log/common/log.js';
import { MCP } from '../../../../platform/mcp/common/modelContextProtocol.js';
import { McpTasks } from '../../../../platform/mcp/common/modelContextProtocolTasks.js';
import { MAX_MRTR_ROUNDS } from './mcpProtocolMeta.js';
import { IMcpTaskInternal } from './mcpTaskManager.js';
import { IMcpToolCallContext, McpClientError, MpcResponseError } from './mcpTypes.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';

/** The poll interval when the server advises none. */
export const DEFAULT_MODERN_TASK_POLL_INTERVAL_MS = 1000;
/** The server's advice is clamped to this range. */
export const MIN_MODERN_TASK_POLL_INTERVAL_MS = 100;
export const MAX_MODERN_TASK_POLL_INTERVAL_MS = 30_000;
/** `tasks/get` failures in a row (other than an unknown task) before the client gives up. */
export const MAX_MODERN_TASK_POLL_FAILURES = 3;

/** What a modern task needs from the request handler (implemented by `McpServerRequestHandler`). */
export interface IMcpModernTaskHost {
	readonly logger: ILogger;
	getModernTask(params: { taskId: string }, token?: CancellationToken): Promise<McpTasks.GetTaskResult>;
	updateTask(params: { taskId: string; inputResponses?: MCP.InputResponses }, token?: CancellationToken): Promise<McpTasks.UpdateTaskResult>;
	cancelModernTask(params: { taskId: string }, token?: CancellationToken): Promise<McpTasks.CancelTaskResult>;
	/** Answers the input requests of one round through the elicitation, sampling and roots handlers. */
	answerInputRequests(inputRequests: MCP.InputRequests, token: CancellationToken, context: IMcpToolCallContext | undefined, seenUrls: Set<string>): Promise<MCP.InputResponses>;
}

function clampPollInterval(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.min(MAX_MODERN_TASK_POLL_INTERVAL_MS, Math.max(MIN_MODERN_TASK_POLL_INTERVAL_MS, Math.round(value)));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TASK_STATUSES: ReadonlySet<string> = new Set<McpTasks.TaskStatus>(['working', 'input_required', 'completed', 'failed', 'cancelled']);

/**
 * A tool call that a 2026-07-28 server turned into a task of the Tasks
 * extension (`io.modelcontextprotocol/tasks`, SEP-2663): the client polls
 * `tasks/get` every `pollIntervalMs`, answers `input_required` rounds with
 * the same elicitation, sampling and roots handlers as a multi round-trip
 * request and delivers the answers with `tasks/update`, and sends
 * `tasks/cancel` when the caller cancels. A completed task resolves with the
 * inlined tool result, a failed one rejects with its inlined error, a task
 * the server cancelled rejects with a cancellation.
 *
 * `notifications/tasks/status` (optional on the server side) only triggers
 * an early poll: `tasks/get` is authoritative. Like the 2025-11-25 task it
 * is adopted by the server's `McpTaskManager`, so polling continues on the
 * new handler after a reconnection.
 */
export class McpModernTask extends Disposable implements IMcpTaskInternal {
	private readonly _promise = new DeferredPromise<MCPLegacy.CallToolResult>();
	private readonly _cts: CancellationTokenSource;
	private readonly _onDidWake = this._register(new Emitter<void>());
	private readonly _onDidChangeHost = this._register(new Emitter<void>());
	private readonly _seenUrls = new Set<string>();
	private _host: IMcpModernTaskHost | undefined;
	private _pollIntervalMs: number;
	private _lastStatusMessage: string | undefined;
	private _cancelRequested = false;
	private _cancelSent = false;

	public get id(): string {
		return this._created.taskId;
	}

	public get result(): Promise<MCPLegacy.CallToolResult> {
		return this._promise.p;
	}

	constructor(
		private readonly _created: McpTasks.CreateTaskResult,
		token: CancellationToken = CancellationToken.None,
		private readonly _onStatusMessage?: (message: string) => void,
		private readonly _context?: IMcpToolCallContext,
	) {
		super();
		this._cts = this._register(new CancellationTokenSource());
		this._pollIntervalMs = clampPollInterval(_created.pollIntervalMs) ?? DEFAULT_MODERN_TASK_POLL_INTERVAL_MS;
		if (token.isCancellationRequested) {
			this._cancel();
		} else {
			this._register(token.onCancellationRequested(() => this._cancel()));
		}
		void this._run();
	}

	/** A status notification (either era's shape): poll now instead of at the next interval. */
	onDidUpdateState(task: Pick<MCPLegacy.Task, 'taskId' | 'status' | 'statusMessage'>): void {
		if (task.taskId !== this.id) {
			return;
		}
		this._reportStatusMessage(task.statusMessage);
		this._onDidWake.fire();
	}

	setHandler(handler: IMcpModernTaskHost | undefined): void {
		this._host = handler;
		if (this._cancelRequested) {
			// The caller cancelled while no handler was attached.
			this._sendCancel();
		}
		this._onDidChangeHost.fire();
	}

	override dispose(): void {
		if (!this._promise.isSettled) {
			this._promise.cancel();
		}
		this._cts.cancel();
		super.dispose();
	}

	/** The caller cancelled: tell the server once and reject. */
	private _cancel(): void {
		if (this._promise.isSettled) {
			return;
		}
		this._cancelRequested = true;
		this._cts.cancel();
		this._sendCancel();
		this._promise.cancel();
	}

	private _sendCancel(): void {
		const host = this._host;
		if (this._cancelSent || !host) {
			return;
		}
		this._cancelSent = true;
		host.cancelModernTask({ taskId: this.id }).catch(e => host.logger.warn(`Could not cancel task ${this.id}: ${e}`));
	}

	private _reportStatusMessage(message: string | undefined): void {
		if (message && message !== this._lastStatusMessage) {
			this._lastStatusMessage = message;
			this._onStatusMessage?.(message);
		}
	}

	private async _run(): Promise<void> {
		try {
			const result = await this._poll();
			this._promise.complete(result);
		} catch (e) {
			if (this._promise.isSettled) {
				return;
			}
			if (e instanceof CancellationError || this._cts.token.isCancellationRequested) {
				this._promise.cancel();
			} else {
				this._promise.error(e);
			}
		}
	}

	private async _poll(): Promise<MCPLegacy.CallToolResult> {
		const token = this._cts.token;
		let rounds = 0;
		let failures = 0;
		let immediate = false;
		/** The input requests of the last round answered, and whether a poll that still showed them was skipped. */
		let answered: string | undefined;
		let skipped = false;
		for (; ;) {
			if (!immediate) {
				await this._sleep(this._pollIntervalMs);
			}
			immediate = false;
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const host = await this._waitForHost();
			let task: McpTasks.Task;
			try {
				task = await host.getModernTask({ taskId: this.id }, token);
			} catch (e) {
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				if (e instanceof CancellationError && this._host !== host) {
					continue; // the connection went away; poll again on the next handler
				}
				// An unknown task (expired, or the server forgot it) cannot recover.
				if (e instanceof MpcResponseError && e.code === MCP.INVALID_PARAMS) {
					throw e;
				}
				if (++failures >= MAX_MODERN_TASK_POLL_FAILURES) {
					throw e;
				}
				host.logger.warn(`Polling task ${this.id} failed (${failures}/${MAX_MODERN_TASK_POLL_FAILURES}): ${e}`);
				continue;
			}
			failures = 0;
			if (!isObject(task) || typeof task.status !== 'string' || !TASK_STATUSES.has(task.status)) {
				throw new McpClientError('invalid-result-type', `tasks/get answered with an invalid task for ${this.id}`, task);
			}
			this._pollIntervalMs = clampPollInterval(task.pollIntervalMs) ?? this._pollIntervalMs;
			this._reportStatusMessage(task.statusMessage);
			switch (task.status) {
				case 'working':
					break;
				case 'completed': {
					if (!isObject(task.result)) {
						throw new McpClientError('invalid-result-type', `The completed task ${this.id} carries no result`, task);
					}
					return task.result as unknown as MCPLegacy.CallToolResult;
				}
				case 'failed': {
					const error = task.error;
					if (isObject(error) && typeof error.code === 'number') {
						throw new MpcResponseError(typeof error.message === 'string' ? error.message : `Task ${this.id} failed`, error.code, error.data);
					}
					throw new Error(`Task ${this.id} failed: ${task.statusMessage ?? 'unknown error'}`);
				}
				case 'cancelled':
					throw new CancellationError();
				case 'input_required': {
					if (!isObject(task.inputRequests) || Object.keys(task.inputRequests).length === 0) {
						break; // nothing to answer (yet): poll again
					}
					const signature = JSON.stringify(task.inputRequests);
					if (signature === answered && !skipped) {
						// The server may not have taken the last answers in yet: give it one interval before asking again.
						skipped = true;
						break;
					}
					if (++rounds > MAX_MRTR_ROUNDS) {
						this._sendCancel();
						throw new McpClientError('too-many-rounds', `Task ${this.id} asked for input more than ${MAX_MRTR_ROUNDS} times`);
					}
					const inputResponses = await host.answerInputRequests(task.inputRequests as MCP.InputRequests, token, this._context, this._seenUrls);
					if (token.isCancellationRequested) {
						throw new CancellationError();
					}
					await host.updateTask({ taskId: this.id, inputResponses }, token);
					answered = signature;
					skipped = false;
					immediate = true; // the answers usually move the task on at once
					break;
				}
			}
		}
	}

	/** Waits for the poll interval, a status notification or the cancellation, whichever comes first. */
	private _sleep(ms: number): Promise<void> {
		return new Promise<void>(resolve => {
			const listeners: IDisposable[] = [];
			const done = () => {
				for (const listener of listeners) {
					listener.dispose();
				}
				resolve();
			};
			listeners.push(disposableTimeout(done, ms));
			listeners.push(this._onDidWake.event(done));
			listeners.push(this._cts.token.onCancellationRequested(done));
		});
	}

	/** The current handler, or the next one after a reconnection. */
	private async _waitForHost(): Promise<IMcpModernTaskHost> {
		while (!this._host) {
			if (this._cts.token.isCancellationRequested) {
				throw new CancellationError();
			}
			await new Promise<void>(resolve => {
				const listeners: IDisposable[] = [];
				const done = () => {
					for (const listener of listeners) {
						listener.dispose();
					}
					resolve();
				};
				listeners.push(this._onDidChangeHost.event(done));
				listeners.push(this._cts.token.onCancellationRequested(done));
			});
		}
		return this._host;
	}
}
