/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, disposableTimeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { stableStringify } from '../../../../base/common/objects.js';
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

/** The `requestState` a server may put on a task waiting for input (the extension does not require one). */
function requestStateOf(task: McpTasks.Task): string | undefined {
	const value: unknown = task.requestState;
	return typeof value === 'string' ? value : undefined;
}

/**
 * The input requests of a task that the client answered in the current
 * input round. A server may keep showing requests it was answered for (it
 * did not take the `tasks/update` in yet, or it shows each round for a
 * while), so the client remembers every request it answered, by its key and
 * a canonical form of the request, and never answers the same pair twice in
 * one round. A request under a known key with different content is a new
 * request.
 *
 * A new round starts, and the remembered answers are forgotten, when the
 * server shows that it moved on: a `tasks/get` with a status other than
 * `input_required` (the task ran again with the answers), or a
 * `requestState` other than the one the answers were given under (for a
 * server that sends one).
 */
class AnsweredInputRequests {
	private readonly _answered = new Map<string, string>();
	private _requestState: string | undefined;

	/** The task left `input_required`: the next input requests belong to a new round. */
	reset(): void {
		this._answered.clear();
		this._requestState = undefined;
	}

	/** The requests of this poll that were not answered in the current round, with their canonical forms. */
	unanswered(inputRequests: MCP.InputRequests, requestState: string | undefined): Map<string, { readonly request: MCP.InputRequest; readonly fingerprint: string }> {
		if (requestState !== this._requestState) {
			this.reset();
		}
		const fresh = new Map<string, { readonly request: MCP.InputRequest; readonly fingerprint: string }>();
		for (const [key, request] of Object.entries(inputRequests)) {
			const fingerprint = stableStringify(request);
			if (this._answered.get(key) !== fingerprint) {
				fresh.set(key, { request, fingerprint });
			}
		}
		return fresh;
	}

	/** Records the requests that were answered (and delivered) under the given state. */
	add(answered: ReadonlyMap<string, { readonly fingerprint: string }>, requestState: string | undefined): void {
		this._requestState = requestState;
		for (const [key, { fingerprint }] of answered) {
			this._answered.set(key, fingerprint);
		}
	}
}

/**
 * A tool call that a 2026-07-28 server turned into a task of the Tasks
 * extension (`io.modelcontextprotocol/tasks`, SEP-2663): the client polls
 * `tasks/get` every `pollIntervalMs`, answers `input_required` rounds with
 * the same elicitation, sampling and roots handlers as a multi round-trip
 * request and delivers the answers with `tasks/update`. A completed task
 * resolves with the inlined tool result, a failed one rejects with its
 * inlined error, a task the server cancelled rejects with a cancellation.
 * The same input request is never answered twice in one round (see
 * {@link AnsweredInputRequests}).
 *
 * Whenever the client stops following a task the server may still run (the
 * caller cancelled, answering input or `tasks/update` failed, polling gave
 * up, the task manager dropped the task), it sends `tasks/cancel` once, on a
 * best-effort basis; not after a terminal status or when the server no
 * longer knows the task.
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
	/** Set once the server's task is over (a terminal status) or unknown to the server: no `tasks/cancel` is due then. */
	private _serverTaskEnded = false;

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
			// The task manager drops a task that may still run on the server (the server is going away).
			this._stopServerTask();
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

	/** The client stops following the task: cancel it on the server unless it is over there already. */
	private _stopServerTask(): void {
		if (!this._serverTaskEnded) {
			this._sendCancel();
		}
	}

	/** Sends `tasks/cancel` at most once (best effort: a failure is only logged). */
	private _sendCancel(): void {
		const host = this._host;
		if (this._cancelSent || !host) {
			return;
		}
		this._cancelSent = true;
		host.cancelModernTask({ taskId: this.id }).catch(e => {
			// A cancellation only means that the connection went away with the request.
			if (!isCancellationError(e)) {
				host.logger.warn(`Could not cancel task ${this.id}: ${e}`);
			}
		});
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
			// Answering input or `tasks/update` failed, polling gave up, the result was invalid, or the
			// caller cancelled (then the cancel is already out): the server may still run the task.
			this._stopServerTask();
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
		const answered = new AnsweredInputRequests();
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
					this._serverTaskEnded = true;
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
			if (McpTasks.isTerminalStatus(task.status)) {
				this._serverTaskEnded = true;
			}
			if (task.status !== 'input_required') {
				answered.reset(); // the task moved on: the next input requests are a new round
			}
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
					const requestState = requestStateOf(task);
					const unanswered = answered.unanswered(task.inputRequests as MCP.InputRequests, requestState);
					if (unanswered.size === 0) {
						// Every request was answered in this round: the server did not take the answers in yet.
						break;
					}
					if (++rounds > MAX_MRTR_ROUNDS) {
						throw new McpClientError('too-many-rounds', `Task ${this.id} asked for input more than ${MAX_MRTR_ROUNDS} times`);
					}
					const inputRequests: MCP.InputRequests = {};
					for (const [key, { request }] of unanswered) {
						inputRequests[key] = request;
					}
					const inputResponses = await host.answerInputRequests(inputRequests, token, this._context, this._seenUrls);
					if (token.isCancellationRequested) {
						throw new CancellationError();
					}
					await host.updateTask({ taskId: this.id, inputResponses }, token);
					answered.add(unanswered, requestState);
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
