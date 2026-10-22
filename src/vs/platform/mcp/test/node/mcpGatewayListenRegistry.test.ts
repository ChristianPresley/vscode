/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { cancellationTargets, IMcpGatewayMessageSender, McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { META_SUBSCRIPTION_ID } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { CONFORMANCE_HIDDEN_PROMPT, CONFORMANCE_HIDDEN_TOOL, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { IMcpGatewayNotification, McpGatewayDispatcher } from '../../node/mcpGatewayDispatcher.js';
import { IMcpGatewayListenStream, MAX_LISTEN_STREAMS, McpGatewayListenRegistry } from '../../node/mcpGatewayListenRegistry.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';

class TestListenStream implements IMcpGatewayListenStream {
	readonly notifications: IMcpGatewayNotification[] = [];
	readonly results: object[] = [];
	/** How often the stream was closed without a result. */
	cancelled = 0;

	notify(notification: IMcpGatewayNotification): void {
		this.notifications.push(notification);
	}

	complete(result: object): void {
		this.results.push(result);
	}

	cancel(): void {
		this.cancelled++;
	}

	get methods(): string[] {
		return this.notifications.map(n => n.method);
	}
}

/**
 * What the route does with a `notifications/cancelled` of `sender` for the
 * listen streams with `requestId` (it pools them with its requests in flight
 * before it applies {@link cancellationTargets}); returns whether it reached one.
 */
function cancel(registry: McpGatewayListenRegistry, requestId: JsonRpcId, sender: IMcpGatewayMessageSender): boolean {
	const targets = cancellationTargets(registry.cancellables(requestId), sender);
	for (const target of targets) {
		target.cancel();
	}
	return targets.length > 0;
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
		assert.deepStrictEqual([registry.has('abc'), registry.cancellables('abc').length], [false, 0], 'a closed stream is not cancellable');
	});

	test('closeAll completes every stream; stateless clients may reuse a request id', () => {
		const { registry } = setup();
		const a = new TestListenStream();
		const b = new TestListenStream();
		const c = new TestListenStream();
		const registrationA = registry.register(1, { toolsListChanged: true }, a, 'me', 'here');
		registry.register(1, { toolsListChanged: true }, b, 'them', 'here');
		registry.register(2, { toolsListChanged: true }, c, 'far', 'elsewhere');
		assert.strictEqual(registry.size, 3);
		assert.deepStrictEqual(registry.cancellables(1).map(stream => stream.owner), ['me', 'them'], 'both streams with id 1 are open');
		registrationA.dispose();
		assert.deepStrictEqual([a.results.length, b.results.length, c.results.length], [1, 0, 0], 'disposing a registration ends its stream only');
		registry.closeAll();
		assert.deepStrictEqual([a.results.length, b.results.length, c.results.length], [1, 1, 1]);
		assert.deepStrictEqual([a.cancelled, b.cancelled, c.cancelled], [0, 0, 0]);
		assert.strictEqual(registry.size, 0);
	});

	test('a stream that a notifications/cancelled cannot reach (no cancel, a gRPC call) is not among the cancellables', () => {
		const { registry } = setup();
		const uncancellableResults: object[] = [];
		const uncancellable: IMcpGatewayListenStream = {
			notify: () => { },
			complete: result => {
				uncancellableResults.push(result);
			},
		};
		const cancellable = new TestListenStream();
		registry.register(1, { toolsListChanged: true }, uncancellable, 'me', 'here');
		registry.register(1, { toolsListChanged: true }, cancellable, 'me', 'here');
		assert.strictEqual(registry.size, 2);
		assert.strictEqual(cancel(registry, 1, { key: 'me', peer: 'here', named: true }), true);
		assert.deepStrictEqual([cancellable.cancelled, cancellable.results.length, uncancellableResults.length, registry.size], [1, 0, 0, 1], 'only the stream with cancel was cancelled');
		assert.strictEqual(cancel(registry, 1, { key: 'me', peer: 'here', named: true }), false);
		registry.closeAll();
		assert.strictEqual(uncancellableResults.length, 1, 'the server ends it with the graceful result');
	});

	test('cancel closes the streams a cancellation of its sender reaches, without a result: its own, or without client info the only client of its address with the id', () => {
		const { invoker, registry } = setup();
		const mine = new TestListenStream();
		const theirs = new TestListenStream();
		const remote = new TestListenStream();
		registry.register(1, { toolsListChanged: true }, mine, 'me', 'here');
		registry.register(1, { toolsListChanged: true }, theirs, 'them', 'here');
		registry.register(2, { toolsListChanged: true }, remote, 'far', 'elsewhere');
		const nameless: IMcpGatewayMessageSender = { key: 'nameless', peer: 'here', named: false };
		assert.strictEqual(cancel(registry, 1, nameless), false, 'ambiguous: two clients of the address have id 1');
		assert.strictEqual(cancel(registry, 1, { key: 'them', peer: 'here', named: true }), true);
		assert.deepStrictEqual([mine.cancelled, theirs.cancelled], [0, 1]);
		assert.deepStrictEqual(theirs.results, [], 'a cancelled listen request gets no response');
		assert.strictEqual(cancel(registry, 1, nameless), true, 'now only one client of the address has id 1');
		assert.deepStrictEqual([mine.cancelled, mine.results.length], [1, 0]);
		assert.strictEqual(cancel(registry, 2, nameless), false, 'another address');
		assert.deepStrictEqual([remote.cancelled, remote.results.length], [0, 0]);
		invoker.setToolHidden(CONFORMANCE_HIDDEN_TOOL, false);
		assert.deepStrictEqual([mine.methods.length, theirs.methods.length, remote.methods.length], [1, 1, 2], 'a cancelled stream gets nothing more');
		registry.closeAll();
		assert.deepStrictEqual([mine.results.length, theirs.results.length, remote.results.length], [0, 0, 1], 'only the stream the server ends gets the graceful result');

		// A client without client info that opened a stream itself is no exception: it is one of two clients of the address with the id, and the nameless cancellation may come from the other one.
		const ownNameless = new TestListenStream();
		const otherNamed = new TestListenStream();
		registry.register(3, { toolsListChanged: true }, ownNameless, nameless.key, 'here');
		registry.register(3, { toolsListChanged: true }, otherNamed, 'them', 'here');
		assert.strictEqual(cancel(registry, 3, nameless), false, 'ambiguous: the nameless client and another client of the address have id 3');
		assert.deepStrictEqual([ownNameless.cancelled, otherNamed.cancelled, registry.size], [0, 0, 2]);
		registry.closeAll();
	});

	test('cancellables hands out the open streams of an id with their sender; cancelling one closes it without a result, once', () => {
		const { registry } = setup();
		const stream = new TestListenStream();
		registry.register('L', { toolsListChanged: true }, stream, 'me', 'here');
		const [cancellable, ...rest] = registry.cancellables('L');
		assert.deepStrictEqual([cancellable.owner, cancellable.peer, rest.length, registry.cancellables('other').length], ['me', 'here', 0, 0]);
		cancellable.cancel();
		cancellable.cancel();
		assert.deepStrictEqual([stream.cancelled, stream.results.length, registry.size, registry.cancellables('L').length], [1, 0, 0, 0]);
	});

	test(`the stream after ${MAX_LISTEN_STREAMS} open ones is refused with -32603`, () => {
		const { registry } = setup();
		const streams: TestListenStream[] = [];
		const registrations: IDisposable[] = [];
		for (let i = 0; i < MAX_LISTEN_STREAMS; i++) {
			const stream = new TestListenStream();
			streams.push(stream);
			registrations.push(registry.register(i, { toolsListChanged: true }, stream));
		}
		assert.throws(() => registry.register('one-too-many', { toolsListChanged: true }, new TestListenStream()), (error: unknown) => error instanceof McpGatewayRpcError && error.code === MCP.INTERNAL_ERROR);
		assert.strictEqual(registry.size, MAX_LISTEN_STREAMS);
		registrations[0].dispose();
		const late = new TestListenStream();
		registry.register('late', { toolsListChanged: true }, late);
		assert.strictEqual(late.methods[0], 'notifications/subscriptions/acknowledged');
		registry.dispose();
		assert.ok(streams.every(s => s.results.length === 1));
		assert.strictEqual(late.results.length, 1);
	});
});
