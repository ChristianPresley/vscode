/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { META_SUBSCRIPTION_ID } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { CONFORMANCE_HIDDEN_PROMPT, CONFORMANCE_HIDDEN_TOOL, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { IMcpGatewayNotification, McpGatewayDispatcher } from '../../node/mcpGatewayDispatcher.js';
import { IMcpGatewayListenStream, MAX_LISTEN_STREAMS, McpGatewayListenRegistry } from '../../node/mcpGatewayListenRegistry.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';

class TestListenStream implements IMcpGatewayListenStream {
	readonly notifications: IMcpGatewayNotification[] = [];
	readonly results: object[] = [];

	notify(notification: IMcpGatewayNotification): void {
		this.notifications.push(notification);
	}

	complete(result: object): void {
		this.results.push(result);
	}

	get methods(): string[] {
		return this.notifications.map(n => n.method);
	}
}

suite('MCP - GatewayListenRegistry', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const logger = new NullLogService();
		const dispatcher = store.add(new McpGatewayDispatcher('route-1', logger, invoker, new McpGatewaySealedState()));
		const registry = store.add(new McpGatewayListenRegistry(dispatcher, invoker, logger));
		return { invoker, registry };
	}

	test('acknowledges first, with the subscription id and the honoured filter', () => {
		const { registry } = setup();
		const stream = new TestListenStream();
		const registration = registry.register(7, { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: false }, stream);
		assert.deepStrictEqual(stream.notifications, [{
			method: 'notifications/subscriptions/acknowledged',
			params: { _meta: { [META_SUBSCRIPTION_ID]: 7 }, notifications: { toolsListChanged: true, promptsListChanged: true } },
		}]);
		assert.strictEqual(registry.size, 1);
		assert.ok(registry.has(7));
		assert.deepStrictEqual(registry.filterOf(7), { toolsListChanged: true, promptsListChanged: true });
		registration.dispose();
	});

	test('forwards only the requested kinds, each tagged with the subscription id', () => {
		const { invoker, registry } = setup();
		const tools = new TestListenStream();
		const prompts = new TestListenStream();
		const r1 = registry.register('tools', { toolsListChanged: true }, tools);
		const r2 = registry.register('prompts', { promptsListChanged: true }, prompts);
		invoker.setToolHidden(CONFORMANCE_HIDDEN_TOOL, false);
		invoker.setPromptHidden(CONFORMANCE_HIDDEN_PROMPT, false);
		assert.deepStrictEqual(tools.methods, ['notifications/subscriptions/acknowledged', 'notifications/tools/list_changed']);
		assert.deepStrictEqual(prompts.methods, ['notifications/subscriptions/acknowledged', 'notifications/prompts/list_changed']);
		assert.deepStrictEqual(tools.notifications[1].params, { _meta: { [META_SUBSCRIPTION_ID]: 'tools' } });
		assert.deepStrictEqual(prompts.notifications[1].params, { _meta: { [META_SUBSCRIPTION_ID]: 'prompts' } });
		r1.dispose();
		r2.dispose();
	});

	test('resource subscriptions go through the upstream and end with the stream', async () => {
		const { invoker, registry } = setup();
		const stream = new TestListenStream();
		const registration = registry.register(1, { resourceSubscriptions: ['test://watched-resource'] }, stream);
		await timeout(0);
		assert.strictEqual(invoker.subscriptionCount('test://watched-resource'), 1);
		invoker.touchResource('test://static-text');
		invoker.touchResource('test://watched-resource');
		assert.deepStrictEqual(stream.notifications.slice(1), [{ method: 'notifications/resources/updated', params: { uri: 'test://watched-resource', _meta: { [META_SUBSCRIPTION_ID]: 1 } } }]);
		registration.dispose();
		assert.strictEqual(invoker.subscriptionCount('test://watched-resource'), 0);
		invoker.touchResource('test://watched-resource');
		assert.strictEqual(stream.notifications.length, 2, 'nothing after the stream closed');
	});

	test('disposing a registration completes the stream with the graceful result, once', () => {
		const { registry } = setup();
		const stream = new TestListenStream();
		const registration = registry.register('abc', { toolsListChanged: true }, stream);
		registration.dispose();
		registration.dispose();
		assert.deepStrictEqual(stream.results, [{ resultType: 'complete', _meta: { [META_SUBSCRIPTION_ID]: 'abc' } }]);
		assert.strictEqual(registry.size, 0);
		assert.strictEqual(registry.close('abc'), false);
	});

	test('close and closeAll complete every stream; stateless clients may reuse a request id', () => {
		const { registry } = setup();
		const a = new TestListenStream();
		const b = new TestListenStream();
		const c = new TestListenStream();
		registry.register(1, { toolsListChanged: true }, a);
		registry.register(1, { toolsListChanged: true }, b);
		registry.register(2, { toolsListChanged: true }, c);
		assert.strictEqual(registry.size, 3);
		assert.strictEqual(registry.close(1), true);
		assert.strictEqual(a.results.length, 1);
		assert.strictEqual(b.results.length, 1);
		assert.strictEqual(c.results.length, 0);
		registry.closeAll();
		assert.strictEqual(c.results.length, 1);
		assert.strictEqual(registry.size, 0);
	});

	test(`the stream after ${MAX_LISTEN_STREAMS} open ones is refused with -32603`, () => {
		const { registry } = setup();
		const streams: TestListenStream[] = [];
		for (let i = 0; i < MAX_LISTEN_STREAMS; i++) {
			const stream = new TestListenStream();
			streams.push(stream);
			registry.register(i, { toolsListChanged: true }, stream);
		}
		assert.throws(() => registry.register('one-too-many', { toolsListChanged: true }, new TestListenStream()), (error: unknown) => error instanceof McpGatewayRpcError && error.code === MCP.INTERNAL_ERROR);
		assert.strictEqual(registry.size, MAX_LISTEN_STREAMS);
		registry.close(0);
		const late = new TestListenStream();
		registry.register('late', { toolsListChanged: true }, late);
		assert.strictEqual(late.methods[0], 'notifications/subscriptions/acknowledged');
		registry.dispose();
		assert.ok(streams.every(s => s.results.length === 1));
		assert.strictEqual(late.results.length, 1);
	});
});
