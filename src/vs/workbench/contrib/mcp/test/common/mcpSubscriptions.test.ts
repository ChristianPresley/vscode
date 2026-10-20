/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { JsonRpcId } from '../../../../../base/common/jsonRpcProtocol.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogger } from '../../../../../platform/log/common/log.js';
import { META_SUBSCRIPTION_ID } from '../../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../../platform/mcp/common/modelContextProtocol.js';
import { LISTEN_ACK_TIMEOUT_MS, LISTEN_BACKOFF_MS, LISTEN_MAX_BACKOFF_MS, LISTEN_STABLE_MS } from '../../common/mcpProtocolMeta.js';
import { IMcpListenHost, IMcpListenReconnect, McpSubscriptionManager } from '../../common/mcpSubscriptions.js';
import { MpcResponseError } from '../../common/mcpTypes.js';

interface IFakeListen {
	readonly id: number;
	readonly filter: MCP.SubscriptionFilter;
	readonly result: DeferredPromise<MCP.SubscriptionsListenResult>;
}

/** Records every `subscriptions/listen` the manager opens and every cancellation it asks for. */
class FakeListenHost implements IMcpListenHost {
	readonly logger = new NullLogger();
	readonly listens: IFakeListen[] = [];
	readonly cancelled: JsonRpcId[] = [];
	private _nextId = 1;

	listen(filter: MCP.SubscriptionFilter): { readonly id: JsonRpcId; readonly result: Promise<MCP.SubscriptionsListenResult> } {
		const listen: IFakeListen = { id: this._nextId++, filter, result: new DeferredPromise() };
		this.listens.push(listen);
		return { id: listen.id, result: listen.result.p };
	}

	cancel(id: JsonRpcId): void {
		this.cancelled.push(id);
		// The engine fails the pending listen request locally when it cancels it.
		const listen = this.listens.find(l => l.id === id);
		if (listen && !listen.result.isSettled) {
			listen.result.error(new CancellationError());
		}
	}

	get last(): IFakeListen {
		assert.ok(this.listens.length > 0, 'no listen stream was opened');
		return this.listens[this.listens.length - 1];
	}

	/** Lets the server end a stream gracefully. */
	close(listen: IFakeListen): void {
		listen.result.complete({ resultType: 'complete', _meta: { [META_SUBSCRIPTION_ID]: listen.id } });
	}
}

suite('Workbench - MCP - Subscriptions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let clock: sinon.SinonFakeTimers;
	let host: FakeListenHost;
	let manager: McpSubscriptionManager;
	let scheduledDelays: number[];
	let reconnects: IMcpListenReconnect[];
	let events: { tools: number; prompts: number; resources: number; updates: MCP.ResourceUpdatedNotificationParams[] };

	const schedule = (fn: () => void, delayMs: number): IDisposable => {
		scheduledDelays.push(delayMs);
		const handle = setTimeout(fn, delayMs);
		return toDisposable(() => clearTimeout(handle));
	};

	setup(() => {
		clock = sinon.useFakeTimers();
		host = new FakeListenHost();
		scheduledDelays = [];
		reconnects = [];
		events = { tools: 0, prompts: 0, resources: 0, updates: [] };
		manager = store.add(new McpSubscriptionManager(host, schedule));
		store.add(manager.onDidReconnect(r => reconnects.push(r)));
		store.add(manager.onDidChangeToolList(() => events.tools++));
		store.add(manager.onDidChangePromptList(() => events.prompts++));
		store.add(manager.onDidChangeResourceList(() => events.resources++));
		store.add(manager.onDidUpdateResource(e => events.updates.push(e)));
	});

	teardown(() => {
		clock.restore();
	});

	const acknowledge = (id: JsonRpcId, filter: MCP.SubscriptionFilter) =>
		manager.handleNotification({ method: 'notifications/subscriptions/acknowledged', params: { _meta: { [META_SUBSCRIPTION_ID]: id }, notifications: filter } });

	const streamEvent = (id: JsonRpcId, method: string, params: Record<string, unknown> = {}) =>
		manager.handleNotification({ method, params: { ...params, _meta: { [META_SUBSCRIPTION_ID]: id } } });

	const allLists = { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true };

	/** The fake clock runs a zero-delay timer that was set inside a timer callback one millisecond later. */
	const delayInTick = (delayMs: number) => Math.max(delayMs, 1);

	suite('lists stream', () => {
		test('start opens the stream with the kinds the server can produce', () => {
			manager.start({ toolsListChanged: true, promptsListChanged: false, resourcesListChanged: true });
			assert.strictEqual(host.listens.length, 1);
			assert.deepStrictEqual(host.listens[0].filter, { toolsListChanged: true, resourcesListChanged: true });
			assert.deepStrictEqual(scheduledDelays, [LISTEN_ACK_TIMEOUT_MS]);
		});

		test('start opens nothing when the server produces no list changes', () => {
			manager.start({});
			manager.start({ toolsListChanged: false, promptsListChanged: false });
			assert.strictEqual(host.listens.length, 0);
			assert.deepStrictEqual(scheduledDelays, []);
		});

		test('routes events by subscription id', () => {
			manager.start(allLists);
			const id = host.last.id;

			assert.strictEqual(manager.handleNotification({ method: 'notifications/tools/list_changed', params: {} }), false, 'a notification without a subscription id is not ours');
			assert.strictEqual(manager.handleNotification({ method: 'notifications/tools/list_changed' }), false);
			assert.strictEqual(streamEvent(999, 'notifications/tools/list_changed'), true, 'an unknown subscription id is swallowed');
			assert.strictEqual(events.tools, 0);

			assert.strictEqual(acknowledge(id, allLists), true);
			assert.strictEqual(streamEvent(id, 'notifications/tools/list_changed'), true);
			assert.strictEqual(streamEvent(id, 'notifications/prompts/list_changed'), true);
			assert.strictEqual(streamEvent(id, 'notifications/resources/list_changed'), true);
			assert.strictEqual(streamEvent(id, 'notifications/resources/updated', { uri: 'file:///a.txt' }), true);
			assert.strictEqual(streamEvent(id, 'notifications/resources/updated', { nope: true }), true, 'an update without a uri is swallowed');
			assert.strictEqual(streamEvent(id, 'notifications/unknown'), true, 'other notifications on the stream are swallowed');

			assert.strictEqual(events.tools, 1);
			assert.strictEqual(events.prompts, 1);
			assert.strictEqual(events.resources, 1);
			assert.strictEqual(events.updates.length, 1);
			assert.strictEqual(events.updates[0].uri, 'file:///a.txt');
		});

		test('the first acknowledgement does not compensate anything', () => {
			manager.start(allLists);
			acknowledge(host.last.id, allLists);
			assert.deepStrictEqual(events, { tools: 0, prompts: 0, resources: 0, updates: [] });
			assert.deepStrictEqual(reconnects, []);
		});

		test('an unacknowledged stream is cancelled after the ack timeout and reconnected with growing backoff', async () => {
			manager.start({ toolsListChanged: true });
			const expectedBackoffs = [0, LISTEN_BACKOFF_MS, 1000, 2000, 4000, 8000, 16000, LISTEN_MAX_BACKOFF_MS, LISTEN_MAX_BACKOFF_MS];

			for (const [cycle, backoff] of expectedBackoffs.entries()) {
				const id = host.last.id;
				assert.strictEqual(host.listens.length, cycle + 1, `cycle ${cycle}: one stream per cycle`);
				await clock.tickAsync(LISTEN_ACK_TIMEOUT_MS - 1);
				assert.strictEqual(host.cancelled.includes(id), false, `cycle ${cycle}: not cancelled before the timeout`);
				await clock.tickAsync(1);
				assert.strictEqual(host.cancelled.includes(id), true, `cycle ${cycle}: cancelled at the timeout`);
				assert.deepStrictEqual(reconnects[cycle], { stream: 'lists', reason: 'acknowledgement timeout', backoffMs: backoff }, `cycle ${cycle}: reconnect event`);
				await clock.tickAsync(delayInTick(backoff) - 1);
				assert.strictEqual(host.listens.length, cycle + 1, `cycle ${cycle}: not yet reconnected`);
				await clock.tickAsync(1);
				assert.strictEqual(host.listens.length, cycle + 2, `cycle ${cycle}: reconnected`);
				assert.deepStrictEqual(host.last.filter, { toolsListChanged: true });
			}
		});

		test('a stream that stays acknowledged resets the backoff', async () => {
			manager.start({ toolsListChanged: true });
			await clock.tickAsync(LISTEN_ACK_TIMEOUT_MS + delayInTick(0)); // timeout, reconnect at once
			await clock.tickAsync(LISTEN_ACK_TIMEOUT_MS + LISTEN_BACKOFF_MS); // timeout, reconnect after 500ms
			assert.strictEqual(host.listens.length, 3);
			assert.deepStrictEqual(reconnects.map(r => r.backoffMs), [0, LISTEN_BACKOFF_MS]);

			acknowledge(host.last.id, { toolsListChanged: true });
			await clock.tickAsync(LISTEN_STABLE_MS);

			assert.strictEqual(manager.handleCancelled(host.last.id), true);
			assert.deepStrictEqual(reconnects[2], { stream: 'lists', reason: 'cancelled by the server', backoffMs: 0 });
		});

		test('the backoff is kept while the stream is not yet stable', async () => {
			manager.start({ toolsListChanged: true });
			await clock.tickAsync(LISTEN_ACK_TIMEOUT_MS + delayInTick(0));
			await clock.tickAsync(LISTEN_ACK_TIMEOUT_MS + LISTEN_BACKOFF_MS);
			assert.strictEqual(host.listens.length, 3);

			acknowledge(host.last.id, { toolsListChanged: true });
			await clock.tickAsync(LISTEN_STABLE_MS - 1);

			manager.handleCancelled(host.last.id);
			assert.deepStrictEqual(reconnects[2], { stream: 'lists', reason: 'cancelled by the server', backoffMs: 1000 });
		});

		test('a graceful close reconnects immediately', async () => {
			manager.start(allLists);
			const first = host.last;
			acknowledge(first.id, allLists);
			scheduledDelays.length = 0;

			host.close(first);
			await clock.tickAsync(0);

			assert.deepStrictEqual(reconnects, [{ stream: 'lists', reason: 'closed by the server', backoffMs: 0 }]);
			assert.strictEqual(host.listens.length, 2);
			assert.deepStrictEqual(host.cancelled, [], 'a closed stream is not cancelled');
			assert.deepStrictEqual(scheduledDelays, [LISTEN_ACK_TIMEOUT_MS], 'the new stream waits for its acknowledgement');
		});

		test('a server cancellation of the listen id reconnects', async () => {
			manager.start(allLists);
			const id = host.last.id;
			assert.strictEqual(manager.handleCancelled(42), false, 'unknown ids are not ours');

			assert.strictEqual(manager.handleCancelled(id), true);
			assert.deepStrictEqual(reconnects, [{ stream: 'lists', reason: 'cancelled by the server', backoffMs: 0 }]);
			assert.deepStrictEqual(host.cancelled, [], 'the engine does not cancel a stream the server already cancelled');
			await clock.tickAsync(0);
			assert.strictEqual(host.listens.length, 2);
			assert.strictEqual(manager.handleCancelled(id), false, 'the old id is forgotten');
		});

		test('a JSON-RPC error disables the stream without retries', async () => {
			manager.start(allLists);
			const lists = host.last;
			store.add(manager.subscribeResource('file:///a.txt'));
			await clock.tickAsync(50);
			assert.strictEqual(host.listens.length, 2);
			const resources = host.last;
			acknowledge(resources.id, { resourceSubscriptions: ['file:///a.txt'] });

			lists.result.error(new MpcResponseError('Method not found', -32601, undefined));
			await clock.tickAsync(0);
			await clock.tickAsync(LISTEN_MAX_BACKOFF_MS * 2);

			assert.deepStrictEqual(reconnects, []);
			assert.strictEqual(host.listens.length, 2, 'no retry');
			assert.deepStrictEqual(host.cancelled, []);

			manager.restart();
			assert.strictEqual(host.listens.length, 3, 'restart re-opens only the resources stream');
			assert.deepStrictEqual(host.cancelled, [resources.id]);
			assert.deepStrictEqual(host.last.filter, { resourceSubscriptions: ['file:///a.txt'] });
		});

		test('gap compensation signals list changes after a re-acknowledgement', async () => {
			manager.start({ toolsListChanged: true, resourcesListChanged: true });
			acknowledge(host.last.id, { toolsListChanged: true, resourcesListChanged: true });
			assert.deepStrictEqual(events, { tools: 0, prompts: 0, resources: 0, updates: [] });

			host.close(host.last);
			await clock.tickAsync(0);
			acknowledge(host.last.id, { toolsListChanged: true, resourcesListChanged: true });
			assert.deepStrictEqual(events, { tools: 1, prompts: 0, resources: 1, updates: [] });

			// the filter the server echoes decides what is compensated
			host.close(host.last);
			await clock.tickAsync(0);
			acknowledge(host.last.id, { toolsListChanged: true });
			assert.deepStrictEqual(events, { tools: 2, prompts: 0, resources: 1, updates: [] });
		});

		test('events for a replaced stream are dropped', async () => {
			manager.start(allLists);
			const old = host.last;
			manager.restart();
			assert.deepStrictEqual(host.cancelled, [old.id]);
			assert.strictEqual(host.listens.length, 2);

			assert.strictEqual(streamEvent(old.id, 'notifications/tools/list_changed'), true);
			assert.strictEqual(events.tools, 0);
			assert.strictEqual(streamEvent(host.last.id, 'notifications/tools/list_changed'), true);
			assert.strictEqual(events.tools, 1);
		});
	});

	suite('resources stream', () => {
		test('resource subscriptions are ref-counted and swap the stream after a debounce with a sorted filter', async () => {
			manager.start({});
			const b = store.add(manager.subscribeResource('file:///b.txt'));
			const a1 = store.add(manager.subscribeResource('file:///a.txt'));
			assert.strictEqual(host.listens.length, 0, 'the stream is debounced');
			await clock.tickAsync(49);
			assert.strictEqual(host.listens.length, 0);
			await clock.tickAsync(1);
			assert.strictEqual(host.listens.length, 1);
			assert.deepStrictEqual(host.last.filter, { resourceSubscriptions: ['file:///a.txt', 'file:///b.txt'] });
			assert.deepStrictEqual([...manager.subscribedUris].sort(), ['file:///a.txt', 'file:///b.txt']);
			const first = host.last;

			const a2 = store.add(manager.subscribeResource('file:///a.txt'));
			await clock.tickAsync(50);
			assert.deepStrictEqual(host.cancelled, [first.id], 'the running stream is swapped');
			assert.deepStrictEqual(host.last.filter, { resourceSubscriptions: ['file:///a.txt', 'file:///b.txt'] });

			a1.dispose();
			a1.dispose(); // idempotent
			await clock.tickAsync(50);
			assert.deepStrictEqual([...manager.subscribedUris].sort(), ['file:///a.txt', 'file:///b.txt'], 'one reference to a.txt remains');
			assert.deepStrictEqual(host.last.filter, { resourceSubscriptions: ['file:///a.txt', 'file:///b.txt'] });

			a2.dispose();
			await clock.tickAsync(50);
			assert.deepStrictEqual([...manager.subscribedUris], ['file:///b.txt']);
			assert.deepStrictEqual(host.last.filter, { resourceSubscriptions: ['file:///b.txt'] });
			const last = host.last;

			b.dispose();
			await clock.tickAsync(50);
			assert.strictEqual(host.listens.length, 4);
			assert.strictEqual(host.cancelled.at(-1), last.id, 'disposing the last reference stops the stream');
			assert.deepStrictEqual([...manager.subscribedUris], []);
		});

		test('the lists stream is untouched by resource subscriptions', async () => {
			manager.start(allLists);
			const lists = host.last;
			const subscription = store.add(manager.subscribeResource('file:///a.txt'));
			await clock.tickAsync(50);
			subscription.dispose();
			await clock.tickAsync(50);
			assert.strictEqual(host.cancelled.includes(lists.id), false);
			assert.strictEqual(host.listens[0], lists);
		});

		test('resource updates are routed by the resources subscription id', async () => {
			manager.start(allLists);
			const lists = host.last;
			store.add(manager.subscribeResource('file:///a.txt'));
			await clock.tickAsync(50);
			const resources = host.last;
			acknowledge(resources.id, { resourceSubscriptions: ['file:///a.txt'] });

			streamEvent(resources.id, 'notifications/resources/updated', { uri: 'file:///a.txt' });
			streamEvent(lists.id, 'notifications/resources/updated', { uri: 'file:///b.txt' });
			assert.deepStrictEqual(events.updates.map(u => u.uri), ['file:///a.txt', 'file:///b.txt']);
			assert.deepStrictEqual(reconnects, []);
		});

		test('the resources stream reconnects with its own backoff and reports its kind', async () => {
			store.add(manager.subscribeResource('file:///a.txt'));
			await clock.tickAsync(50);
			const first = host.last;
			await clock.tickAsync(LISTEN_ACK_TIMEOUT_MS);
			assert.deepStrictEqual(host.cancelled, [first.id]);
			assert.deepStrictEqual(reconnects, [{ stream: 'resources', reason: 'acknowledgement timeout', backoffMs: 0 }]);
			await clock.tickAsync(delayInTick(0));
			assert.strictEqual(host.listens.length, 2);
			assert.deepStrictEqual(host.last.filter, { resourceSubscriptions: ['file:///a.txt'] });
		});
	});

	test('restart re-opens both streams', async () => {
		manager.start(allLists);
		store.add(manager.subscribeResource('file:///a.txt'));
		await clock.tickAsync(50);
		const [lists, resources] = host.listens;

		manager.restart();
		assert.deepStrictEqual(host.cancelled, [lists.id, resources.id]);
		assert.strictEqual(host.listens.length, 4);
		assert.deepStrictEqual(host.listens[2].filter, allLists);
		assert.deepStrictEqual(host.listens[3].filter, { resourceSubscriptions: ['file:///a.txt'] });
		assert.deepStrictEqual(reconnects, [], 'a restart is not a reconnection');
	});

	test('dispose cancels the active streams and stops reconnecting', async () => {
		manager.start(allLists);
		store.add(manager.subscribeResource('file:///a.txt'));
		await clock.tickAsync(50);
		const ids = host.listens.map(l => l.id);

		manager.dispose();
		assert.deepStrictEqual(host.cancelled, ids);
		await clock.tickAsync(LISTEN_MAX_BACKOFF_MS * 2);
		assert.strictEqual(host.listens.length, 2);
		assert.deepStrictEqual(reconnects, []);
	});

	test('releasing a subscription after dispose schedules nothing', async () => {
		const subscription = manager.subscribeResource('file:///a.txt');
		await clock.tickAsync(50);
		assert.strictEqual(host.listens.length, 1);

		manager.dispose();
		scheduledDelays.length = 0;
		subscription.dispose();
		await clock.tickAsync(50);
		assert.deepStrictEqual(scheduledDelays, []);
		assert.strictEqual(host.listens.length, 1);
	});
});
