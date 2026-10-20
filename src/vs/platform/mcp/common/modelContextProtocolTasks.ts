/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MCP } from './modelContextProtocol.js';

/**
 * The Tasks extension of MCP 2026-07-28 (`io.modelcontextprotocol/tasks`, SEP-2663).
 *
 * In the 2025-11-25 revision tasks were part of the core schema (see
 * `MCPLegacy.Task` and friends). The current revision moves them into an
 * extension that both sides declare through `capabilities.extensions`:
 * a long-running `tools/call` answers with a {@link CreateTaskResult}
 * (`resultType: "task"`), the client polls it with `tasks/get`, answers
 * pending input requests with `tasks/update` and stops it with `tasks/cancel`.
 * `tasks/list` and `tasks/result` no longer exist.
 *
 * These shapes are hand-maintained from the extension specification; the
 * core schema in `modelContextProtocol.ts` does not contain them.
 */
export namespace McpTasks {
	/** The extension id used in `capabilities.extensions` on both sides. */
	export const EXTENSION_ID = 'io.modelcontextprotocol/tasks';

	/** The `resultType` of a {@link CreateTaskResult}. */
	export const RESULT_TYPE_TASK = 'task';

	export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

	/**
	 * Returned by `tools/call` (and the other task-capable requests) instead
	 * of the final result when the server turned the request into a task.
	 */
	export interface CreateTaskResult extends MCP.Result {
		resultType: typeof RESULT_TYPE_TASK;
		taskId: string;
		status: TaskStatus;
		/** ISO 8601 timestamp. */
		createdAt: string;
		/** ISO 8601 timestamp. */
		lastUpdatedAt: string;
		/** How long the task stays readable after creation, in milliseconds. */
		ttlMs: number;
		/** The poll interval the server advises, in milliseconds. */
		pollIntervalMs?: number;
	}

	/**
	 * The result of `tasks/get`: the task plus, once it settled, the inlined
	 * result or error. While `status` is `input_required` the pending
	 * {@link MCP.InputRequests} are present and the client answers them with
	 * `tasks/update`.
	 */
	export interface Task extends MCP.Result {
		taskId: string;
		status: TaskStatus;
		createdAt: string;
		lastUpdatedAt: string;
		ttlMs: number;
		pollIntervalMs?: number;
		statusMessage?: string;
		inputRequests?: MCP.InputRequests;
		result?: MCP.Result;
		error?: MCP.Error;
	}

	export interface GetTaskRequest extends MCP.Request {
		method: 'tasks/get';
		params: MCP.RequestParams & { taskId: string };
	}

	export type GetTaskResult = Task;

	export interface UpdateTaskRequest extends MCP.Request {
		method: 'tasks/update';
		params: MCP.RequestParams & { taskId: string; inputResponses?: MCP.InputResponses };
	}

	export type UpdateTaskResult = MCP.EmptyResult;

	export interface CancelTaskRequest extends MCP.Request {
		method: 'tasks/cancel';
		params: MCP.RequestParams & { taskId: string };
	}

	export type CancelTaskResult = MCP.EmptyResult;

	/**
	 * Optional status notification a server may push on a listen stream.
	 * Clients do not have to act on it; polling `tasks/get` is authoritative.
	 */
	export interface TaskStatusNotification extends MCP.Notification {
		method: 'notifications/tasks/status';
		params: MCP.NotificationParams & Task;
	}

	export function isCreateTaskResult(result: MCP.Result): result is CreateTaskResult {
		return result.resultType === RESULT_TYPE_TASK && typeof (result as Partial<CreateTaskResult>).taskId === 'string';
	}

	export function isTerminalStatus(status: TaskStatus): boolean {
		return status === 'completed' || status === 'failed' || status === 'cancelled';
	}
}
