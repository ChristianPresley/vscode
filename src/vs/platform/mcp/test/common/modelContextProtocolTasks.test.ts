/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { McpTasks } from '../../common/modelContextProtocolTasks.js';

suite('MCP - Tasks extension types', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('extension id and result type constants', () => {
		assert.strictEqual(McpTasks.EXTENSION_ID, 'io.modelcontextprotocol/tasks');
		assert.strictEqual(McpTasks.RESULT_TYPE_TASK, 'task');
	});

	test('isCreateTaskResult requires resultType task and a string taskId', () => {
		const created: McpTasks.CreateTaskResult = { resultType: 'task', taskId: 't1', status: 'working', createdAt: '2026-07-28T00:00:00Z', lastUpdatedAt: '2026-07-28T00:00:00Z', ttlMs: 600000 };
		assert.strictEqual(McpTasks.isCreateTaskResult(created), true);
		assert.strictEqual(McpTasks.isCreateTaskResult({ resultType: 'complete' }), false);
		assert.strictEqual(McpTasks.isCreateTaskResult({ resultType: 'task' }), false);
		assert.strictEqual(McpTasks.isCreateTaskResult({ resultType: 'task', taskId: 42 } as unknown as McpTasks.CreateTaskResult), false);
	});

	test('isTerminalStatus', () => {
		assert.strictEqual(McpTasks.isTerminalStatus('working'), false);
		assert.strictEqual(McpTasks.isTerminalStatus('input_required'), false);
		assert.strictEqual(McpTasks.isTerminalStatus('completed'), true);
		assert.strictEqual(McpTasks.isTerminalStatus('failed'), true);
		assert.strictEqual(McpTasks.isTerminalStatus('cancelled'), true);
	});
});
