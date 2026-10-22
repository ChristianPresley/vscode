/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { MCP_NAME_HEADER } from '../../common/mcpHttpHeaders.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { McpTasks } from '../../common/modelContextProtocolTasks.js';
import { CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { McpGatewayService } from '../../node/mcpGatewayService.js';
import { httpRequest, jsonOf, LEGACY_HEADERS, legacyHeaders, modernRequest } from './mcpGatewayTestUtils.js';

interface IJsonRpcBody {
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

const TASKS: MCP.ClientCapabilities = { extensions: { [McpTasks.EXTENSION_ID]: {} } };

suite('MCP - GatewayRoute (HTTP) - Tasks extension', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createGateway(): Promise<string> {
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService())));
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const handle = store.add(await service.createRoute('tasks', invoker, { serverInfo: CONFORMANCE_SERVER_INFO }));
		return handle.address.toString(true);
	}

	async function post(url: string, request: { body: string; headers: Record<string, string> }): Promise<{ status: number; body: IJsonRpcBody }> {
		const result = await httpRequest(url, { method: 'POST', headers: request.headers, body: request.body });
		return { status: result.status, body: result.text ? jsonOf(result) as IJsonRpcBody : {} };
	}

	test('a task tool answers a CreateTaskResult, and tasks/get and tasks/cancel go through the Mcp-Name check', async () => {
		const url = await createGateway();
		const discover = await post(url, modernRequest('server/discover'));
		assert.deepStrictEqual((discover.body.result?.capabilities as MCP.ServerCapabilities).extensions, { [McpTasks.EXTENSION_ID]: {} });

		const created = await post(url, modernRequest('tools/call', { name: 'slow_compute', arguments: { seconds: 60, label: 'http' } }, 1, TASKS));
		assert.strictEqual(created.status, 200);
		assert.strictEqual(created.body.result?.resultType, 'task');
		const taskId = created.body.result?.taskId as string;

		const got = await post(url, modernRequest('tasks/get', { taskId }, 2, TASKS));
		assert.strictEqual(got.status, 200);
		assert.strictEqual(got.body.result?.taskId, taskId);
		assert.strictEqual(got.body.result?.resultType, 'complete');

		const mismatched = await post(url, modernRequest('tasks/get', { taskId }, 3, TASKS, { [MCP_NAME_HEADER]: 'another-task' }));
		assert.strictEqual(mismatched.status, 400);
		assert.strictEqual(mismatched.body.error?.code, MCP.HEADER_MISMATCH);

		const request = modernRequest('tasks/cancel', { taskId }, 4, TASKS);
		const withoutName = { body: request.body, headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name !== MCP_NAME_HEADER)) };
		const missing = await post(url, withoutName);
		assert.strictEqual(missing.status, 400);
		assert.strictEqual(missing.body.error?.code, MCP.HEADER_MISMATCH);

		const cancelled = await post(url, request);
		assert.strictEqual(cancelled.status, 200);
		assert.deepStrictEqual(Object.keys(cancelled.body.result ?? {}).sort(), ['_meta', 'resultType']);
		const after = await post(url, modernRequest('tasks/get', { taskId }, 5, TASKS));
		assert.strictEqual(after.body.result?.status, 'cancelled');
	});

	test('the task methods without the extension are 400/-32021; tasks/list and tasks/result are 404/-32601', async () => {
		const url = await createGateway();
		const gated = await post(url, modernRequest('tasks/get', { taskId: 'gate-test' }));
		assert.strictEqual(gated.status, 400);
		assert.strictEqual(gated.body.error?.code, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY);
		assert.deepStrictEqual(gated.body.error?.data, { requiredCapabilities: { extensions: { [McpTasks.EXTENSION_ID]: {} } } });
		const unknown = await post(url, modernRequest('tasks/get', { taskId: 'nope' }, 2, TASKS));
		assert.strictEqual(unknown.status, 400);
		assert.strictEqual(unknown.body.error?.code, MCP.INVALID_PARAMS);
		for (const method of ['tasks/list', 'tasks/result']) {
			const removed = await post(url, modernRequest(method, method === 'tasks/result' ? { taskId: 'x' } : {}, 3, TASKS));
			assert.strictEqual(removed.status, 404, method);
			assert.strictEqual(removed.body.error?.code, MCP.METHOD_NOT_FOUND, method);
		}
		const required = await post(url, modernRequest('tools/call', { name: 'failing_job', arguments: {} }));
		assert.strictEqual(required.status, 400);
		assert.strictEqual(required.body.error?.code, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY);
	});

	test('legacy sessions: no extension in initialize, no task methods, task tools run at once', async () => {
		const url = await createGateway();
		const init = await httpRequest(url, { headers: LEGACY_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { extensions: { [McpTasks.EXTENSION_ID]: {} } }, clientInfo: { name: 'legacy', version: '1.0.0' } } }) });
		assert.strictEqual(init.status, 200, init.text);
		const capabilities = (jsonOf(init) as IJsonRpcBody).result?.capabilities as Record<string, unknown>;
		assert.strictEqual(capabilities.extensions, undefined);
		assert.strictEqual(capabilities.tasks, undefined);
		const sessionId = init.headers['mcp-session-id'] as string;
		await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

		const get = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: 'x' } }) });
		assert.strictEqual((jsonOf(get) as IJsonRpcBody).error?.code, MCP.METHOD_NOT_FOUND);
		const call = await httpRequest(url, { headers: legacyHeaders(sessionId), body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow_compute', arguments: { seconds: 0.01, label: 'legacy' } } }) });
		const result = (jsonOf(call) as IJsonRpcBody).result as { content: Array<{ text: string }> } | undefined;
		assert.strictEqual(result?.content[0].text, 'computed legacy after 0.01 s');
	});
});
