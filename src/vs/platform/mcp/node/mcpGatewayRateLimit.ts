/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';

/**
 * The rate of a token bucket: `perSecond` tokens a second at an even rate,
 * at most `burst` tokens held (the largest burst). A new bucket is full and
 * each request takes one token.
 */
export interface IMcpGatewayRate {
	readonly perSecond: number;
	readonly burst: number;
}

/**
 * The rate limits of a gateway route, each per client of the route
 * (server/tools: servers MUST rate limit tool invocations;
 * server/utilities/completion: implementations MUST implement appropriate
 * rate limiting). `false` turns a limit off; an absent one has its default
 * ({@link DEFAULT_MCP_GATEWAY_RATE_LIMITS}). Each limit also has a route-wide
 * bucket of {@link ROUTE_RATE_MULTIPLIER} times its rate that every request
 * of the route takes from, whatever its client: the client identity is the
 * client's own claim, so a client that changes it at each request is still
 * held to that ceiling.
 */
export interface IMcpGatewayRateLimits {
	/** `tools/call` requests (each 2026-07-28 retry of an input round is one request). */
	readonly toolCalls?: IMcpGatewayRate | false;
	/** `completion/complete` requests. */
	readonly completions?: IMcpGatewayRate | false;
}

/**
 * Generous enough for agents (the gateway's client is the local Copilot CLI
 * acting for the user), low enough that a runaway loop cannot flood the
 * servers behind the gateway.
 */
export const DEFAULT_MCP_GATEWAY_RATE_LIMITS: { readonly [K in keyof IMcpGatewayRateLimits]-?: IMcpGatewayRate } = {
	toolCalls: { perSecond: 50, burst: 100 },
	completions: { perSecond: 20, burst: 40 },
};

/** The most clients a limit keeps a bucket for; the least recently seen one is forgotten (its next request finds a full bucket). */
export const MAX_RATE_LIMITED_CLIENTS = 1024;

/**
 * How long a client's bucket is kept without a request (at least the time
 * the bucket takes to refill, so that forgetting it never admits a request
 * the bucket would have refused).
 */
export const RATE_LIMIT_IDLE_TTL_MS = 10 * 60 * 1000;

/** The route-wide bucket of a limit has this many times the per-client rate and burst. */
export const ROUTE_RATE_MULTIPLIER = 4;

/** The longest client key a limit stores as is; a longer one is stored as its SHA-256. */
export const MAX_CLIENT_KEY_LENGTH = 128;

/** The most characters of each part of a client identity that count ({@link mcpGatewayClientKey}). */
export const MAX_CLIENT_KEY_PART_LENGTH = 256;

/**
 * The fixed-size key of a client identity (for instance its address and the
 * client info it claims): the base64url SHA-256 of the parts, each cut to
 * {@link MAX_CLIENT_KEY_PART_LENGTH} characters. Equal parts give equal keys;
 * a client that claims a long name costs no more memory than another.
 */
export function mcpGatewayClientKey(parts: readonly (string | null)[]): string {
	const capped = parts.map(part => typeof part === 'string' && part.length > MAX_CLIENT_KEY_PART_LENGTH ? part.slice(0, MAX_CLIENT_KEY_PART_LENGTH) : part);
	return createHash('sha256').update(JSON.stringify(capped)).digest('base64url');
}

/** `data.reason` of the error a rate-limited request gets. */
export const RATE_LIMITED_REASON = 'rate_limited';

/**
 * Which bucket refused a request: the client's own (`client`: this client
 * sends too many), or the route-wide one that every client of the route
 * shares (`route`: the server is busy, whoever sends the requests).
 */
export type McpGatewayRateLimitScope = 'client' | 'route';

export interface IMcpGatewayRateLimitedData {
	readonly reason: typeof RATE_LIMITED_REASON;
	/** The time until the bucket that refused the request admits a request of this kind again. */
	readonly retryAfterMs: number;
	readonly method: string;
	/** Whose limit refused the request ({@link McpGatewayRateLimitScope}). */
	readonly scope: McpGatewayRateLimitScope;
}

/**
 * The answer to a request over its rate limit. The specification prescribes
 * no error for it (server/tools and server/utilities/completion only require
 * the limit), so the gateway answers `-32603` (Internal error) with
 * `data.reason: 'rate_limited'`, `data.retryAfterMs` and `data.scope`, on both
 * protocol revisions; HTTP keeps status 200 as for every other application
 * error, and the gRPC listener ends the call with RESOURCE_EXHAUSTED. The
 * message tells a client that is over its own limit that it sends too many
 * requests, and any client refused by the route-wide limit that the server
 * is busy.
 */
export class McpGatewayRateLimitedError extends McpGatewayRpcError {
	constructor(method: string, retryAfterMs: number, scope: McpGatewayRateLimitScope = 'client') {
		const data: IMcpGatewayRateLimitedData = { reason: RATE_LIMITED_REASON, retryAfterMs, method, scope };
		super(MCP.INTERNAL_ERROR, scope === 'route'
			? `Rate limit exceeded: the server is busy (too many ${method} requests from all of its clients); retry in ${retryAfterMs} ms`
			: `Rate limit exceeded: too many ${method} requests from this client; retry in ${retryAfterMs} ms`, data);
	}
}

/** Whether an error is the gateway's rate-limit answer ({@link McpGatewayRateLimitedError}, also after a copy of it). */
export function isRateLimitedError(error: McpGatewayRpcError): boolean {
	const data = error.data;
	return error.code === MCP.INTERNAL_ERROR && typeof data === 'object' && data !== null && (data as { reason?: unknown }).reason === RATE_LIMITED_REASON;
}

interface IBucket {
	tokens: number;
	updatedAt: number;
	/** Whether the last request of the bucket was refused by it (the first refusal of a run is logged). */
	limited: boolean;
}

export type McpGatewayRateDecision =
	| { readonly admitted: true }
	| {
		readonly admitted: false;
		readonly retryAfterMs: number;
		/** The first refusal after an admitted request (of the client, or of the route for `scope: 'route'`). */
		readonly first: boolean;
		/** Whether the client's own bucket refused the request, or the route-wide one ({@link ROUTE_RATE_MULTIPLIER}). */
		readonly scope: McpGatewayRateLimitScope;
	};

const ADMITTED: McpGatewayRateDecision = { admitted: true };

/** A token bucket of `capacity` tokens refilled at `perMs` a millisecond. */
class TokenBucketRate {
	readonly perMs: number;
	readonly capacity: number;

	constructor(perSecond: number, burst: number) {
		this.perMs = perSecond / 1000;
		this.capacity = Number.isFinite(burst) && burst >= 1 ? Math.floor(burst) : Math.max(1, Math.ceil(perSecond));
	}

	/** Brings the bucket to `now`. */
	refill(bucket: IBucket, now: number): void {
		bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.perMs);
		bucket.updatedAt = now;
	}

	/** The time until a refilled bucket holds a token. */
	waitMs(bucket: IBucket): number {
		// The epsilon absorbs floating-point noise (0.99 tokens at 10 a second is 1 ms away, not 2).
		return Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs - 1e-6));
	}
}

/**
 * One limit: a token bucket per client, and a route-wide bucket of
 * {@link ROUTE_RATE_MULTIPLIER} times the rate that every request takes from
 * as well. A client's bucket is forgotten after {@link RATE_LIMIT_IDLE_TTL_MS}
 * without a request (or the refill time, if longer), and the least recently
 * seen past {@link MAX_RATE_LIMITED_CLIENTS}; a forgotten client's next
 * request finds a full bucket.
 */
class McpGatewayRateLimit {
	/** Least recently seen first. */
	private readonly _buckets = new Map<string, IBucket>();
	private readonly _client: TokenBucketRate;
	private readonly _route: TokenBucketRate;
	private readonly _routeBucket: IBucket;
	private readonly _idleMs: number;

	constructor(rate: IMcpGatewayRate, private readonly _now: () => number) {
		this._client = new TokenBucketRate(rate.perSecond, rate.burst);
		this._route = new TokenBucketRate(rate.perSecond * ROUTE_RATE_MULTIPLIER, this._client.capacity * ROUTE_RATE_MULTIPLIER);
		this._routeBucket = { tokens: this._route.capacity, updatedAt: _now(), limited: false };
		// A bucket idle for its refill time is full: forgetting it then changes no decision.
		this._idleMs = Math.max(RATE_LIMIT_IDLE_TTL_MS, Math.ceil(this._client.capacity / this._client.perMs));
	}

	take(clientKey: string): McpGatewayRateDecision {
		const now = this._now();
		this._forgetIdle(now);
		const key = clientKey.length > MAX_CLIENT_KEY_LENGTH ? createHash('sha256').update(clientKey).digest('base64url') : clientKey;
		let bucket = this._buckets.get(key);
		if (bucket) {
			// Most recently seen last: the map's first key is the one to forget.
			this._buckets.delete(key);
			this._client.refill(bucket, now);
		} else {
			bucket = { tokens: this._client.capacity, updatedAt: now, limited: false };
		}
		this._buckets.set(key, bucket);
		if (this._buckets.size > MAX_RATE_LIMITED_CLIENTS) {
			const oldest = this._buckets.keys().next().value;
			if (oldest !== undefined) {
				this._buckets.delete(oldest);
			}
		}
		this._route.refill(this._routeBucket, now);
		if (bucket.tokens < 1) {
			const first = !bucket.limited;
			bucket.limited = true;
			return { admitted: false, retryAfterMs: this._client.waitMs(bucket), first, scope: 'client' };
		}
		if (this._routeBucket.tokens < 1) {
			const first = !this._routeBucket.limited;
			this._routeBucket.limited = true;
			return { admitted: false, retryAfterMs: this._route.waitMs(this._routeBucket), first, scope: 'route' };
		}
		bucket.tokens -= 1;
		bucket.limited = false;
		this._routeBucket.tokens -= 1;
		this._routeBucket.limited = false;
		return ADMITTED;
	}

	get clientCount(): number {
		this._forgetIdle(this._now());
		return this._buckets.size;
	}

	private _forgetIdle(now: number): void {
		for (const [key, bucket] of this._buckets) {
			if (now - bucket.updatedAt < this._idleMs) {
				break; // the rest were seen later
			}
			this._buckets.delete(key);
		}
	}
}

function isEnabled(rate: IMcpGatewayRate | false | undefined): rate is IMcpGatewayRate {
	return !!rate && Number.isFinite(rate.perSecond) && rate.perSecond > 0;
}

/**
 * The rate limits of one gateway route ({@link IMcpGatewayRateLimits}).
 * Requests of the same client key share a bucket; the transports choose the
 * key (a 2026-07-28 HTTP client by its address and `_meta` client info, a
 * 2025-11-25 client by its session, a gRPC client by its address and client
 * info, the first and last through {@link mcpGatewayClientKey}). All the
 * requests of the route also share its route-wide bucket. The clock is
 * `Date.now`, read at each request.
 */
export class McpGatewayRateLimiter {
	private readonly _toolCalls: McpGatewayRateLimit | undefined;
	private readonly _completions: McpGatewayRateLimit | undefined;

	constructor(limits: IMcpGatewayRateLimits = {}, now: () => number = () => Date.now()) {
		const toolCalls = limits.toolCalls ?? DEFAULT_MCP_GATEWAY_RATE_LIMITS.toolCalls;
		const completions = limits.completions ?? DEFAULT_MCP_GATEWAY_RATE_LIMITS.completions;
		this._toolCalls = isEnabled(toolCalls) ? new McpGatewayRateLimit(toolCalls, now) : undefined;
		this._completions = isEnabled(completions) ? new McpGatewayRateLimit(completions, now) : undefined;
	}

	/** Takes a token for one request of `method`; methods without a limit are always admitted. */
	take(method: string, clientKey: string): McpGatewayRateDecision {
		const limit = this._limitOf(method);
		return limit ? limit.take(clientKey) : ADMITTED;
	}

	/** The clients the limit of `method` keeps a bucket for (tests and diagnostics). */
	clientCount(method: string): number {
		return this._limitOf(method)?.clientCount ?? 0;
	}

	private _limitOf(method: string): McpGatewayRateLimit | undefined {
		switch (method) {
			case 'tools/call':
				return this._toolCalls;
			case 'completion/complete':
				return this._completions;
			default:
				return undefined;
		}
	}
}
