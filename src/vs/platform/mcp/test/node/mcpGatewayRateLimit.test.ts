/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { grpcClientKey } from '../../node/mcpGatewayGrpc.js';
import { isRateLimitedError, MAX_CLIENT_KEY_PART_LENGTH, MAX_RATE_LIMITED_CLIENTS, mcpGatewayClientKey, McpGatewayRateDecision, McpGatewayRateLimitedError, McpGatewayRateLimiter, RATE_LIMIT_IDLE_TTL_MS, RATE_LIMITED_REASON, ROUTE_RATE_MULTIPLIER } from '../../node/mcpGatewayRateLimit.js';
import { modernClientKey } from '../../node/mcpGatewayRoute.js';

function retryAfter(decision: McpGatewayRateDecision): number | undefined {
	return decision.admitted ? undefined : decision.retryAfterMs;
}

function scopeOf(decision: McpGatewayRateDecision): 'admitted' | 'client' | 'route' {
	return decision.admitted ? 'admitted' : decision.scope;
}

suite('MCP - Gateway rate limits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers();
	});

	teardown(() => {
		clock.restore();
	});

	test('a token bucket per client: a full burst, then one request per period, refilled at an even rate up to the burst', () => {
		const limiter = new McpGatewayRateLimiter({ toolCalls: { perSecond: 10, burst: 5 } });
		for (let i = 0; i < 5; i++) {
			assert.strictEqual(limiter.take('tools/call', 'a').admitted, true);
		}
		assert.strictEqual(retryAfter(limiter.take('tools/call', 'a')), 100);
		assert.strictEqual(limiter.take('tools/call', 'b').admitted, true, 'another client has its own bucket');
		clock.tick(99);
		assert.strictEqual(retryAfter(limiter.take('tools/call', 'a')), 1);
		clock.tick(1);
		assert.strictEqual(limiter.take('tools/call', 'a').admitted, true);
		clock.tick(10_000);
		for (let i = 0; i < 5; i++) {
			assert.strictEqual(limiter.take('tools/call', 'a').admitted, true);
		}
		assert.strictEqual(limiter.take('tools/call', 'a').admitted, false, 'never more than the burst');
	});

	test('the first refusal of a run is flagged (the dispatcher logs it once)', () => {
		const limiter = new McpGatewayRateLimiter({ toolCalls: { perSecond: 1, burst: 1 } });
		limiter.take('tools/call', 'a');
		const first = limiter.take('tools/call', 'a');
		const second = limiter.take('tools/call', 'a');
		assert.deepStrictEqual([first.admitted || first.first, second.admitted || second.first], [true, false]);
		clock.tick(1000);
		assert.strictEqual(limiter.take('tools/call', 'a').admitted, true);
		const again = limiter.take('tools/call', 'a');
		assert.strictEqual(!again.admitted && again.first, true);
	});

	test('only tools/call and completion/complete are limited; false, a zero rate or a missing burst are handled', () => {
		const limiter = new McpGatewayRateLimiter({ toolCalls: false, completions: { perSecond: 3, burst: 0 } });
		for (let i = 0; i < 500; i++) {
			assert.strictEqual(limiter.take('tools/call', 'a').admitted, true);
			assert.strictEqual(limiter.take('resources/read', 'a').admitted, true);
		}
		// A burst under one is the rate's own size.
		assert.deepStrictEqual([0, 1, 2, 3].map(() => limiter.take('completion/complete', 'a').admitted), [true, true, true, false]);
		const off = new McpGatewayRateLimiter({ toolCalls: { perSecond: 0, burst: 10 }, completions: { perSecond: Number.NaN, burst: 1 } });
		for (let i = 0; i < 50; i++) {
			assert.strictEqual(off.take('tools/call', 'a').admitted, true);
			assert.strictEqual(off.take('completion/complete', 'a').admitted, true);
		}
	});

	test('at most MAX_RATE_LIMITED_CLIENTS buckets: the least recently seen client is forgotten', () => {
		// A burst large enough that the route-wide bucket (ROUTE_RATE_MULTIPLIER times it) admits every request below; no time passes.
		const burst = 400;
		assert.ok(burst * (ROUTE_RATE_MULTIPLIER - 1) > MAX_RATE_LIMITED_CLIENTS + 2);
		const limiter = new McpGatewayRateLimiter({ toolCalls: { perSecond: 0.001, burst } });
		for (let i = 0; i < burst; i++) {
			limiter.take('tools/call', 'first');
		}
		assert.strictEqual(scopeOf(limiter.take('tools/call', 'first')), 'client');
		for (let i = 0; i < MAX_RATE_LIMITED_CLIENTS; i++) {
			assert.strictEqual(limiter.take('tools/call', `client-${i}`).admitted, true);
		}
		assert.strictEqual(limiter.clientCount('tools/call'), MAX_RATE_LIMITED_CLIENTS);
		assert.strictEqual(limiter.take('tools/call', 'first').admitted, true, 'a forgotten client starts with a full bucket');
		assert.strictEqual(limiter.clientCount('tools/call'), MAX_RATE_LIMITED_CLIENTS);
	});

	test('a client\'s bucket is forgotten after RATE_LIMIT_IDLE_TTL_MS without a request (or its refill time, if longer)', () => {
		const limiter = new McpGatewayRateLimiter({ toolCalls: { perSecond: 10, burst: 5 } });
		for (let i = 0; i < 100; i++) {
			limiter.take('tools/call', `idle-${i}`);
			clock.tick(1);
		}
		assert.strictEqual(limiter.clientCount('tools/call'), 100);
		clock.tick(RATE_LIMIT_IDLE_TTL_MS - 100);
		assert.strictEqual(limiter.clientCount('tools/call'), 99, 'only the first is idle for the TTL');
		limiter.take('tools/call', 'busy');
		clock.tick(100);
		assert.strictEqual(limiter.clientCount('tools/call'), 1, 'the idle buckets are forgotten; the busy one stays');
		clock.tick(RATE_LIMIT_IDLE_TTL_MS);
		limiter.take('completion/complete', 'other-limit');
		assert.strictEqual(limiter.clientCount('tools/call'), 0);

		// Any request forgets the idle buckets of its limit, without a clientCount call.
		for (let i = 0; i < 100; i++) {
			limiter.take('tools/call', `idle-${i}`);
		}
		clock.tick(RATE_LIMIT_IDLE_TTL_MS);
		limiter.take('tools/call', 'next');
		clock.tick(1);
		assert.strictEqual(limiter.clientCount('tools/call'), 1);

		// A slow rate refills in 2000 s, longer than the TTL: its bucket is kept until it would be full anyway.
		const slow = new McpGatewayRateLimiter({ toolCalls: { perSecond: 0.001, burst: 2 } });
		slow.take('tools/call', 'a');
		slow.take('tools/call', 'a');
		assert.strictEqual(scopeOf(slow.take('tools/call', 'a')), 'client');
		clock.tick(RATE_LIMIT_IDLE_TTL_MS);
		assert.strictEqual(slow.clientCount('tools/call'), 1);
		assert.strictEqual(scopeOf(slow.take('tools/call', 'a')), 'client', 'still limited after the TTL');
		clock.tick(2_000_000);
		assert.strictEqual(slow.clientCount('tools/call'), 0);
		assert.deepStrictEqual([slow.take('tools/call', 'a').admitted, slow.take('tools/call', 'a').admitted, slow.take('tools/call', 'a').admitted], [true, true, false]);
	});

	test('a route-wide bucket of ROUTE_RATE_MULTIPLIER times the rate holds all clients together', () => {
		const limiter = new McpGatewayRateLimiter({ toolCalls: { perSecond: 1, burst: 2 }, completions: { perSecond: 1, burst: 1 } });
		const routeBurst = 2 * ROUTE_RATE_MULTIPLIER;
		for (let i = 0; i < routeBurst; i++) {
			assert.strictEqual(limiter.take('tools/call', `client-${i}`).admitted, true);
		}
		const first = limiter.take('tools/call', 'fresh-1');
		assert.deepStrictEqual(first, { admitted: false, retryAfterMs: 1000 / ROUTE_RATE_MULTIPLIER, first: true, scope: 'route' });
		const second = limiter.take('tools/call', 'fresh-2');
		assert.strictEqual(!second.admitted && !second.first, true, 'only the first refusal of the route\'s run is flagged');
		assert.strictEqual(limiter.take('completion/complete', 'fresh-1').admitted, true, 'each limit has its own route-wide bucket');
		// A refused request takes no token: one comes back every 1000 / ROUTE_RATE_MULTIPLIER ms.
		clock.tick(1000 / ROUTE_RATE_MULTIPLIER);
		assert.strictEqual(limiter.take('tools/call', 'fresh-3').admitted, true);
		assert.strictEqual(scopeOf(limiter.take('tools/call', 'fresh-4')), 'route');
		// A client over its own limit is refused by its own bucket, and takes nothing from the route's.
		clock.tick(60_000);
		limiter.take('tools/call', 'x');
		limiter.take('tools/call', 'x');
		for (let i = 0; i < 5; i++) {
			assert.strictEqual(scopeOf(limiter.take('tools/call', 'x')), 'client');
		}
		for (let i = 0; i < routeBurst - 2; i++) {
			assert.strictEqual(limiter.take('tools/call', `other-${i}`).admitted, true);
		}
		assert.strictEqual(scopeOf(limiter.take('tools/call', 'other-last')), 'route');
	});

	test('a client that changes its client info at each request is held to the route-wide ceiling', () => {
		const limiter = new McpGatewayRateLimiter({ toolCalls: { perSecond: 10, burst: 5 } });
		const admitted = (keyOf: (i: number) => string) => {
			let count = 0;
			for (let i = 0; i < 1000; i++) {
				if (limiter.take('tools/call', keyOf(i)).admitted) {
					count++;
				}
			}
			return count;
		};
		const socket = { remoteAddress: '127.0.0.1', remoteFamily: 'IPv4' };
		assert.strictEqual(admitted(i => modernClientKey(socket, { name: 'rotating', version: String(i) })), 5 * ROUTE_RATE_MULTIPLIER);
		clock.tick(60_000);
		assert.strictEqual(admitted(i => grpcClientKey('127.0.0.1', { name: `rotating-${i}`, version: '1' })), 5 * ROUTE_RATE_MULTIPLIER);
		clock.tick(60_000);
		assert.strictEqual(admitted(i => `session:${i}`), 5 * ROUTE_RATE_MULTIPLIER, 'new 2025-11-25 sessions too');
	});

	test('client keys are fixed-size hashes of the client identity, whatever the client info claims', () => {
		const socket = { remoteAddress: '127.0.0.1', remoteFamily: 'IPv4' };
		const huge = 'n'.repeat(1_000_000);
		const keys = [
			modernClientKey(socket, { name: huge, version: huge }),
			modernClientKey(socket, { name: 'a', version: '1' }),
			modernClientKey(undefined, undefined),
			grpcClientKey('127.0.0.1', { name: huge, version: '1' }),
			grpcClientKey(undefined, undefined),
			mcpGatewayClientKey([huge]),
		];
		for (const key of keys) {
			assert.match(key, /^[A-Za-z0-9_-]{43}$/);
		}
		assert.strictEqual(modernClientKey(socket, { name: 'a', version: '1' }), keys[1], 'the same identity, the same key');
		assert.notStrictEqual(modernClientKey(socket, { name: 'a', version: '2' }), keys[1]);
		assert.notStrictEqual(modernClientKey({ remoteAddress: '127.0.0.2', remoteFamily: 'IPv4' }, { name: 'a', version: '1' }), keys[1]);
		assert.notStrictEqual(grpcClientKey('127.0.0.1', { name: 'a', version: '1' }), keys[1], 'HTTP and gRPC clients have different keys');
		assert.notStrictEqual(modernClientKey(socket, { name: '', version: '' }), modernClientKey(socket, undefined), 'no client info is not an empty one');
		// Only the first MAX_CLIENT_KEY_PART_LENGTH characters of a part count.
		const long = 'x'.repeat(MAX_CLIENT_KEY_PART_LENGTH);
		assert.strictEqual(mcpGatewayClientKey([long + 'a']), mcpGatewayClientKey([long + 'b']));
		assert.notStrictEqual(mcpGatewayClientKey([long.slice(1) + 'a']), mcpGatewayClientKey([long.slice(1) + 'b']));

		// A long raw key (from another transport) is stored hashed and still identifies one client.
		const limiter = new McpGatewayRateLimiter({ toolCalls: { perSecond: 1, burst: 1 } });
		assert.strictEqual(limiter.take('tools/call', huge).admitted, true);
		assert.strictEqual(scopeOf(limiter.take('tools/call', huge)), 'client');
		assert.strictEqual(limiter.take('tools/call', huge.slice(1)).admitted, true);
	});

	test('the rate-limited error: -32603 with data.reason rate_limited and retryAfterMs, recognized after a copy', () => {
		const error = new McpGatewayRateLimitedError('tools/call', 250);
		assert.strictEqual(error.code, MCP.INTERNAL_ERROR);
		assert.deepStrictEqual(error.data, { reason: RATE_LIMITED_REASON, retryAfterMs: 250, method: 'tools/call', scope: 'client' });
		assert.ok(isRateLimitedError(error));
		assert.ok(isRateLimitedError(new McpGatewayRpcError(error.code, error.message, JSON.parse(JSON.stringify(error.data)))));
		assert.ok(!isRateLimitedError(new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'boom')));
		assert.ok(!isRateLimitedError(new McpGatewayRpcError(MCP.INVALID_PARAMS, 'x', { reason: RATE_LIMITED_REASON })));
	});

	test('the rate-limited error names whose limit refused the request: the client\'s own, or the route-wide one (the server is busy)', () => {
		const own = new McpGatewayRateLimitedError('tools/call', 100, 'client');
		assert.strictEqual(own.message, 'Rate limit exceeded: too many tools/call requests from this client; retry in 100 ms');
		const busy = new McpGatewayRateLimitedError('completion/complete', 250, 'route');
		assert.deepStrictEqual(busy.data, { reason: RATE_LIMITED_REASON, retryAfterMs: 250, method: 'completion/complete', scope: 'route' });
		assert.strictEqual(busy.message, 'Rate limit exceeded: the server is busy (too many completion/complete requests from all of its clients); retry in 250 ms');
		assert.ok(!/this client/.test(busy.message), 'a client refused by the route-wide limit is not told that it sent too many');
		assert.ok(isRateLimitedError(busy));
	});
});
