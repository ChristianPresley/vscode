/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IMcpGatewaySseConnection, MAX_REPLAY_EVENTS, McpGatewayEventLog } from '../../node/mcpGatewayEventLog.js';

class TestConnection implements IMcpGatewaySseConnection {
	readonly events: Array<{ readonly id: string; readonly message: unknown }> = [];
	ended = false;

	get isOpen(): boolean {
		return !this.ended;
	}

	writeEvent(id: string, data: string): void {
		this.events.push({ id, message: JSON.parse(data) });
	}

	end(): void {
		this.ended = true;
	}

	get messages(): unknown[] {
		return this.events.map(e => e.message);
	}
}

suite('MCP - GatewayEventLog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('writes go to the stream\'s connection, with ids unique in the session that name their stream', () => {
		const log = new McpGatewayEventLog({ idPrefix: 's' });
		const a = new TestConnection();
		const b = new TestConnection();
		const streamA = log.open('request', a);
		const streamB = log.open('standalone', b);
		const id1 = log.write(streamA, { n: 1 });
		const id2 = log.write(streamB, { n: 2 });
		const id3 = log.write(streamA, { n: 3 });
		assert.deepStrictEqual(a.messages, [{ n: 1 }, { n: 3 }]);
		assert.deepStrictEqual(b.messages, [{ n: 2 }]);
		assert.strictEqual(new Set([id1, id2, id3]).size, 3);
		assert.deepStrictEqual([log.find(id1!)?.id, log.find(id2!)?.id, log.find(id3!)?.id], [streamA, streamB, streamA]);
		assert.deepStrictEqual(log.find(id2!), { id: streamB, kind: 'standalone', complete: false });
		assert.strictEqual(log.latestStandalone, streamB);
	});

	test('a reconnection replays only the events of the same stream after the cursor', () => {
		const log = new McpGatewayEventLog({ idPrefix: 's' });
		const first = new TestConnection();
		const stream = log.open('request', first);
		const other = log.open('request', new TestConnection());
		const cursor = log.cursor(stream);
		log.write(stream, { n: 1 });
		log.disconnect(stream, first);
		log.write(stream, { n: 2 });
		log.write(other, { n: 'other' });
		log.write(stream, { n: 3 });
		assert.deepStrictEqual(first.messages, [{ n: 1 }], 'nothing after the disconnection');

		const resumed = new TestConnection();
		assert.deepStrictEqual(log.connect(stream, resumed, cursor), { replayed: 3, truncated: false });
		assert.deepStrictEqual(resumed.messages, [{ n: 1 }, { n: 2 }, { n: 3 }]);
		assert.strictEqual(resumed.ended, false, 'the request is still running');
		log.write(stream, { n: 4 });
		assert.deepStrictEqual(resumed.messages.at(-1), { n: 4 }, 'the new connection carries the stream on');

		const again = new TestConnection();
		log.disconnect(stream, resumed);
		log.connect(stream, again, resumed.events[1].id);
		assert.deepStrictEqual(again.messages, [{ n: 3 }, { n: 4 }]);
	});

	test('a complete request stream ends its connection, and a later reconnection replays and ends', () => {
		const log = new McpGatewayEventLog({ idPrefix: 's' });
		const connection = new TestConnection();
		const stream = log.open('request', connection);
		const cursor = log.cursor(stream);
		log.disconnect(stream, connection);
		log.write(stream, { result: 'done' });
		log.complete(stream);
		assert.strictEqual(log.write(stream, { late: true }), undefined, 'nothing is logged after completion');
		assert.deepStrictEqual(log.find(cursor), { id: stream, kind: 'request', complete: true });

		const resumed = new TestConnection();
		log.connect(stream, resumed, cursor);
		assert.deepStrictEqual(resumed.messages, [{ result: 'done' }]);
		assert.strictEqual(resumed.ended, true);

		const live = new TestConnection();
		const second = log.open('request', live);
		log.complete(second);
		assert.strictEqual(live.ended, true, 'complete ends the connection that carries the stream');
		assert.strictEqual(log.find(log.cursor('999')), undefined);
	});

	test('ids of other sessions, forgotten streams and garbage are unknown', () => {
		const log = new McpGatewayEventLog({ idPrefix: 's' });
		const stream = log.open('request', new TestConnection());
		const valid = log.cursor(stream);
		assert.ok(log.find(valid));
		for (const id of ['', 'abc', '1', 's-1', 's-1-', '-1-1', `s-${stream}-999999`, 's-42-1', `s-${stream}-1-2`, `s-${stream}-x`, `t-${stream}-1`, `${stream}-1`]) {
			assert.strictEqual(log.find(id), undefined, JSON.stringify(id));
		}
		const otherSession = new McpGatewayEventLog();
		otherSession.open('request');
		assert.strictEqual(otherSession.find(valid), undefined, 'another log (session) does not know the id');
		// A complete stream without logged events is forgotten.
		const cursor = log.cursor(stream);
		assert.ok(log.find(cursor));
		log.complete(stream);
		assert.strictEqual(log.find(cursor), undefined);
		assert.strictEqual(log.streamCount, 0);
	});

	test('the log is bounded: the oldest events are dropped and a replay says it is truncated', () => {
		const log = new McpGatewayEventLog({ idPrefix: 's', maxEvents: 4 });
		const stream = log.open('request');
		const cursor = log.cursor(stream);
		for (let n = 1; n <= 6; n++) {
			log.write(stream, { n });
		}
		assert.strictEqual(log.eventCount, 4);
		const resumed = new TestConnection();
		assert.deepStrictEqual(log.connect(stream, resumed, cursor), { replayed: 4, truncated: true });
		assert.deepStrictEqual(resumed.messages, [{ n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }]);

		const bySize = new McpGatewayEventLog({ maxEvents: 100, maxDataLength: 30 });
		const big = bySize.open('request');
		bySize.write(big, { data: 'x'.repeat(10) });
		bySize.write(big, { data: 'y'.repeat(10) });
		assert.strictEqual(bySize.eventCount, 1, 'the data limit drops the oldest event');
		bySize.write(big, { data: 'z'.repeat(100) });
		assert.strictEqual(bySize.eventCount, 1, 'the newest event is kept even when it alone exceeds the limit');
		assert.ok(MAX_REPLAY_EVENTS > 0);
	});

	test('standalone streams: the latest one is kept for replay, older empty ones are forgotten', () => {
		const log = new McpGatewayEventLog({ idPrefix: 's' });
		const first = new TestConnection();
		const one = log.open('standalone', first);
		const oneCursor = log.cursor(one);
		log.disconnect(one, first);
		assert.ok(log.find(oneCursor), 'the latest standalone stream is kept even without events');
		log.write(one, { method: 'missed' });
		const resumed = new TestConnection();
		log.connect(one, resumed, oneCursor);
		assert.deepStrictEqual(resumed.messages, [{ method: 'missed' }]);
		assert.strictEqual(resumed.ended, false, 'a standalone stream is never complete');
		log.complete(one);
		assert.strictEqual(resumed.ended, false, 'complete does not apply to standalone streams');

		const twoConnection = new TestConnection();
		const two = log.open('standalone', twoConnection);
		assert.strictEqual(log.latestStandalone, two);
		const twoCursor = log.cursor(two);
		log.disconnect(two, twoConnection);
		log.open('standalone');
		assert.strictEqual(log.find(twoCursor), undefined, 'an older standalone stream without events is forgotten');
		assert.strictEqual(log.hasOpenConnection, true, 'the resumed connection of the first stream is open');
		log.endAll();
		assert.strictEqual(resumed.ended, true);
		assert.strictEqual(log.hasOpenConnection, false);
	});
});
