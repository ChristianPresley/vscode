/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { OAuthClientError } from '../../../../base/common/oauth.js';
import { IOAuthFetchResponse } from '../../../../base/common/oauthClient.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { bearerChallenge, createOAuthFixture, IOAuthFixture, IOAuthFixtureOptions } from '../../../../base/test/common/oauthClientFixture.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogService, LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IMcpRequestAbort, McpConnectionState, McpServerTransportHTTP, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { IAuthMetadataSource, IMcpAuthenticationDetails, IMcpAuthenticationOptions, IMcpRegisteredAuthorizationServer, MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { CommonRequestInit, CommonResponse, createAuthMetadata, fetchMetadataWithin, IMcpAuthHeaderProviderHost, McpAuthHeaderProvider, McpHTTPHandle } from '../../common/extHostMcp.js';

/** The headers the transport reads from a response. */
const RESPONSE_HEADERS = ['www-authenticate', 'content-type', 'location', 'mcp-session-id', 'set-cookie'];

function toCommonResponse(url: string, response: IOAuthFetchResponse): CommonResponse {
	const headers = new Headers();
	for (const name of RESPONSE_HEADERS) {
		const value = response.headers.get(name);
		if (value !== null) {
			headers.set(name, value);
		}
	}
	return { status: response.status, statusText: response.statusText ?? '', headers, body: null, url, json: () => response.json(), text: () => response.text() };
}

/** The transport's private request paths, which these tests drive directly. */
interface IHandleInternals {
	_fetchWithAuthRetry(mcpUrl: string, init: { method: string; headers: Record<string, string> }, headers: Record<string, string>, transportHeaders?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<CommonResponse>;
	_fetch(url: string, init: { method: string; headers: Record<string, string> }): Promise<CommonResponse>;
}

function internals(handle: McpHTTPHandle): IHandleInternals {
	return handle as unknown as IHandleInternals;
}

interface ITokenCall {
	readonly details: IMcpAuthenticationDetails;
	readonly options: IMcpAuthenticationOptions | undefined;
}

suite('McpAuthHeaderProvider', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IHarness {
		readonly provider: McpAuthHeaderProvider;
		readonly fixture: IOAuthFixture;
		readonly calls: ITokenCall[];
		readonly setups: IAuthMetadataSource[];
		readonly logs: string[];
		readonly states: McpConnectionState[];
	}

	function createHarness(options: {
		readonly fixture?: IOAuthFixtureOptions;
		/** An existing fixture (the same servers across connections); {@link fixture} is ignored then. */
		readonly fixtureInstance?: IOAuthFixture;
		readonly launch?: Partial<McpServerTransportHTTP>;
		readonly stepUps?: Map<string, number>;
		/** Answers the main thread's token request; defaults to `token-<n>`. */
		readonly getToken?: (call: ITokenCall, index: number) => Promise<string | undefined>;
		/** The registrations the main thread keeps for the resource; without it the host offers no lookup. */
		readonly registered?: (resource: string) => IMcpRegisteredAuthorizationServer[];
	} = {}): IHarness {
		const fixture = options.fixtureInstance ?? createOAuthFixture(options.fixture);
		const calls: ITokenCall[] = [];
		const setups: IAuthMetadataSource[] = [];
		const logs: string[] = [];
		const states: McpConnectionState[] = [];
		const registered = options.registered;
		const proxy: IMcpAuthHeaderProviderHost['proxy'] = {
			async $getTokenFromServerMetadata(_id, details, tokenOptions) {
				const call = { details, options: tokenOptions };
				calls.push(call);
				return options.getToken ? options.getToken(call, calls.length) : `token-${calls.length}`;
			},
			async $getTokenForProviderId() { return undefined; },
			$onDidChangeState(_id, state) { states.push(state); },
			$logMcpAuthSetup(data) { setups.push(data); },
			$getRegisteredAuthorizationServers: registered ? async (_id, resource) => registered(resource) : undefined,
		};
		const provider = store.add(new McpAuthHeaderProvider({
			id: 1,
			launch: { uri: URI.parse(fixture.resource), headers: [], ...options.launch },
			proxy,
			protocolVersion: () => '2026-07-28',
			fetchMetadata: async (url, init) => toCommonResponse(url, await fixture.fetch(url, { method: init.method, headers: init.headers })),
			log: (_level, message) => logs.push(message),
			stepUps: options.stepUps ?? new Map(),
		}));
		return { provider, fixture, calls, setups, logs, states };
	}

	function challenge(fixture: IOAuthFixture, params: Record<string, string | undefined> = {}): string {
		return bearerChallenge({ resource_metadata: fixture.rs.metadataUrl, ...params });
	}

	async function expectOAuthError(promise: Promise<unknown>, code: string): Promise<void> {
		await assert.rejects(promise, (error: unknown) => {
			assert.ok(error instanceof OAuthClientError, `expected an OAuthClientError, got ${String(error)}`);
			assert.strictEqual(error.code, code, error.message);
			return true;
		});
	}

	test('a 401 discovers the authorization server and asks for a token for the canonical resource with the challenged scopes', async () => {
		const { provider, fixture, calls, setups } = createHarness();
		const headers: Record<string, string> = {};

		assert.strictEqual(await provider.handleChallenge(401, challenge(fixture, { scope: 'mcp:read mcp:write' }), headers), true);
		assert.strictEqual(headers.Authorization, 'Bearer token-1');
		assert.deepStrictEqual(calls.map(c => ({
			resource: c.details.resource,
			scopes: c.details.scopes,
			authorizationServer: URI.revive(c.details.authorizationServer).toString(true),
			issuer: c.details.authorizationServerMetadata.issuer,
			rejectedToken: c.options?.rejectedToken,
			forceNewRegistration: c.options?.forceNewRegistration,
		})), [{ resource: fixture.resource, scopes: ['mcp:read', 'mcp:write'], authorizationServer: URI.parse(fixture.issuer).toString(true), issuer: fixture.issuer, rejectedToken: undefined, forceNewRegistration: undefined }]);
		assert.strictEqual(setups.length, 1);
		// The next request carries the token without another discovery.
		const next: Record<string, string> = {};
		await provider.addAuthHeader(next);
		assert.strictEqual(next.Authorization, 'Bearer token-2');
		assert.strictEqual(fixture.as.metadataRequests.length, 1);
	});

	test('the protected resource metadata is requested path-based before root, and its scopes apply when the challenge has none', async () => {
		const { provider, fixture, calls } = createHarness({ fixture: { rs: { prmInWwwAuthenticate: false, scopesSupported: ['mcp:basic'] } } });
		assert.ok(await provider.handleChallenge(401, 'Bearer', {}));
		assert.deepStrictEqual(fixture.rs.prmRequests, ['/.well-known/oauth-protected-resource/mcp']);
		assert.deepStrictEqual(calls[0].details.scopes, ['mcp:basic']);
	});

	test('a rejected token is named, and two consecutive rejections of fresh tokens force a new registration', async () => {
		const { provider, fixture, calls } = createHarness();
		const headers: Record<string, string> = {};
		await provider.handleChallenge(401, challenge(fixture), headers);
		await provider.handleChallenge(401, challenge(fixture, { error: 'invalid_token' }), headers);
		await provider.handleChallenge(401, challenge(fixture, { error: 'invalid_token' }), headers);
		provider.onDidAccept(headers);
		await provider.handleChallenge(401, challenge(fixture, { error: 'invalid_token' }), headers);
		assert.deepStrictEqual(calls.map(c => [c.options?.rejectedToken, c.options?.forceNewRegistration ?? false]), [
			[undefined, false],
			['token-1', false],
			['token-2', true],
			['token-3', false],
		]);
	});

	test('insufficient_scope steps up to the union of the held and demanded scopes; a fresh token that is still insufficient is terminal', async () => {
		const { provider, fixture, calls } = createHarness();
		const headers: Record<string, string> = {};
		await provider.handleChallenge(401, challenge(fixture, { scope: 'mcp:basic' }), headers);
		assert.ok(await provider.handleChallenge(403, challenge(fixture, { error: 'insufficient_scope', scope: 'mcp:write' }), headers));
		assert.strictEqual(headers.Authorization, 'Bearer token-2');
		await expectOAuthError(provider.handleChallenge(403, challenge(fixture, { error: 'insufficient_scope', scope: 'mcp:write' }), headers), 'step_up_limit');
		assert.deepStrictEqual(calls.map(c => [c.details.scopes, c.options?.rejectedToken]), [
			[['mcp:basic'], undefined],
			[['mcp:basic', 'mcp:write'], undefined],
		]);
	});

	test('at most two step-ups per resource for the lifetime of the process', async () => {
		const stepUps = new Map<string, number>();
		const first = createHarness({ stepUps });
		const headers: Record<string, string> = {};
		await first.provider.handleChallenge(401, challenge(first.fixture, { scope: 'a' }), headers);
		await first.provider.handleChallenge(403, challenge(first.fixture, { error: 'insufficient_scope', scope: 'b' }), headers);
		await first.provider.handleChallenge(403, challenge(first.fixture, { error: 'insufficient_scope', scope: 'c' }), headers);
		await expectOAuthError(first.provider.handleChallenge(403, challenge(first.fixture, { error: 'insufficient_scope', scope: 'd' }), headers), 'step_up_limit');
		// A new connection to the same resource inherits the count.
		const second = createHarness({ stepUps });
		const other: Record<string, string> = {};
		await second.provider.handleChallenge(401, challenge(second.fixture, { scope: 'a' }), other);
		await expectOAuthError(second.provider.handleChallenge(403, challenge(second.fixture, { error: 'insufficient_scope', scope: 'e' }), other), 'step_up_limit');
		assert.deepStrictEqual([...stepUps.values()], [2]);
	});

	test('re-discovers before every token request, so a moved resource names its new authorization server', async () => {
		let moved = false;
		const { provider, fixture, calls } = createHarness({ fixture: { rs: { authorizationServers: () => [moved ? 'https://as2.example.test' : 'https://as.example.test'] } } });
		fixture.router.handle('https://as2.example.test', request => request.url.pathname === '/.well-known/oauth-authorization-server'
			? { status: 200, body: { ...fixture.as.metadata(), issuer: 'https://as2.example.test' } }
			: undefined);
		const headers: Record<string, string> = {};
		await provider.handleChallenge(401, challenge(fixture), headers);
		moved = true;
		await provider.handleChallenge(401, challenge(fixture, { error: 'invalid_token' }), headers);
		assert.deepStrictEqual(calls.map(c => c.details.authorizationServerMetadata.issuer), ['https://as.example.test', 'https://as2.example.test']);
	});

	test('the authorization server that already issued a token is preferred over the first listed one', async () => {
		let servers = ['https://as2.example.test'];
		const { provider, fixture, calls } = createHarness({ fixture: { rs: { authorizationServers: () => servers } } });
		fixture.router.handle('https://as2.example.test', request => request.url.pathname === '/.well-known/oauth-authorization-server'
			? { status: 200, body: { ...fixture.as.metadata(), issuer: 'https://as2.example.test' } }
			: undefined);
		const headers: Record<string, string> = {};
		await provider.handleChallenge(401, challenge(fixture), headers);
		servers = ['https://as.example.test', 'https://as2.example.test'];
		await provider.handleChallenge(401, challenge(fixture, { error: 'invalid_token' }), headers);
		assert.deepStrictEqual(calls.map(c => c.details.authorizationServerMetadata.issuer), ['https://as2.example.test', 'https://as2.example.test']);
	});

	test('the first listed authorization server the main thread holds a registration with is selected, also after a restart', async () => {
		let servers = ['https://as.example.test'];
		const fixture = createOAuthFixture({ rs: { authorizationServers: () => servers } });
		fixture.router.handle('https://as2.example.test', request => request.url.pathname === '/.well-known/oauth-authorization-server'
			? { status: 200, body: { ...fixture.as.metadata(), issuer: 'https://as2.example.test' } }
			: undefined);
		// The main thread keeps a dynamic provider per authorization server that issued a token for the resource.
		const registrations: IMcpRegisteredAuthorizationServer[] = [];
		const lookups: string[] = [];
		const registered = (resource: string) => {
			lookups.push(resource);
			return [...registrations];
		};
		const getToken = async (call: ITokenCall) => {
			registrations.push({ authorizationServer: URI.revive(call.details.authorizationServer).toString(true), resource: call.details.resourceMetadata?.resource });
			return 'token';
		};

		const beforeRestart = createHarness({ fixtureInstance: fixture, registered, getToken });
		await beforeRestart.provider.handleChallenge(401, challenge(fixture), {});
		// The resource now lists a new authorization server first, and the window restarted: a new connection.
		servers = ['https://as2.example.test', 'https://as.example.test'];
		const afterRestart = createHarness({ fixtureInstance: fixture, registered, getToken });
		await afterRestart.provider.handleChallenge(401, challenge(fixture), {});
		// Without a registration the first listed one is selected.
		const unregistered = createHarness({ fixtureInstance: fixture, registered: () => [] });
		await unregistered.provider.handleChallenge(401, challenge(fixture), {});

		assert.deepStrictEqual({
			issuers: [beforeRestart, afterRestart, unregistered].map(h => h.calls[0].details.authorizationServerMetadata.issuer),
			lookups,
		}, {
			issuers: ['https://as.example.test', 'https://as.example.test', 'https://as2.example.test'],
			lookups: [fixture.resource, fixture.resource],
		});
	});

	test('a metadata request that never answers times out, and cancelling the token ends discovery', async () => {
		const requested: string[] = [];
		const hung = (url: string) => {
			requested.push(url);
			// A fetch that ignores its signal.
			return new Promise<CommonResponse>(() => { });
		};
		const timedOut = await createAuthMetadata('https://mcp.example.test/mcp', new Headers(), { fetch: hung, log: () => { }, metadataTimeoutMs: 5 });

		const started = new DeferredPromise<void>();
		const cts = new CancellationTokenSource();
		const pending = createAuthMetadata('https://mcp.example.test/mcp', new Headers(), {
			fetch: url => {
				started.complete();
				return hung(url);
			},
			log: () => { },
			token: cts.token,
		});
		await started.p;
		cts.cancel();
		await assert.rejects(pending, (error: unknown) => isCancellationError(error));
		cts.dispose();

		assert.deepStrictEqual({
			telemetry: timedOut.telemetry,
			// Every protected resource and authorization server metadata location was tried in turn.
			triedResourceMetadata: requested.some(url => url.includes('/.well-known/oauth-protected-resource')),
			triedServerMetadata: requested.some(url => url.includes('/.well-known/oauth-authorization-server')),
		}, {
			telemetry: { resourceMetadataSource: 'none', serverMetadataSource: 'default' },
			triedResourceMetadata: true,
			triedServerMetadata: true,
		});
	});

	test('a metadata response whose body is never read keeps no timer and no listener on the caller\'s signal; a body read has its own deadline', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const url = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
			const signals: AbortSignal[] = [];
			const respond = (json: () => Promise<unknown>) => async (_url: string, init: { signal?: AbortSignal }): Promise<CommonResponse> => {
				signals.push(init.signal!);
				return { status: 404, statusText: 'Not Found', headers: new Headers(), body: null, url, json, text: async () => '' };
			};

			// A probe answered 404: the client does not read the body.
			const caller = new AbortController();
			await fetchMetadataWithin(respond(async () => ({})), url, { method: 'GET', headers: {} }, caller.signal, 30_000);
			const timersAfterProbe = clock.countTimers();
			// The caller's signal outlives the request: aborting it must not reach the finished request.
			caller.abort();

			// A body that is read: its deadline ends with the read.
			const read = await fetchMetadataWithin(respond(async () => ({ resource: 'https://mcp.example.test/mcp' })), url, { method: 'GET', headers: {} }, undefined, 30_000);
			const body = await read.json();
			const timersAfterRead = clock.countTimers();

			// A body that never arrives times out and aborts the request.
			const hung = await fetchMetadataWithin(respond(() => new Promise(() => { })), url, { method: 'GET', headers: {} }, undefined, 30_000);
			const reading = assert.rejects(hung.json(), /timed out after 30000 ms/);
			clock.tick(30_000);
			await reading;

			assert.deepStrictEqual({
				timersAfterProbe,
				probeAbortedByCaller: signals[0].aborted,
				body,
				timersAfterRead,
				hungAborted: signals[2].aborted,
				timersAfterTimeout: clock.countTimers(),
			}, {
				timersAfterProbe: 0,
				probeAbortedByCaller: false,
				body: { resource: 'https://mcp.example.test/mcp' },
				timersAfterRead: 0,
				hungAborted: true,
				timersAfterTimeout: 0,
			});
		} finally {
			clock.restore();
		}
	});

	test('discovery failures are terminal and send nothing', async () => {
		const cases: Array<[string, IOAuthFixtureOptions, string]> = [
			['a resource metadata document naming another resource', { rs: { prmResource: 'https://evil.example.com/mcp' } }, 'resource_mismatch'],
			['authorization server metadata naming another issuer', { as: { advertisedIssuer: 'https://attacker.example.com' } }, 'issuer_mismatch'],
			['no authorization server metadata although a resource metadata document exists', { as: { serveMetadata: false } }, 'discovery_failed'],
			['plain-HTTP endpoints on a non-loopback host', { as: { insecureEndpoints: true } }, 'insecure_endpoint'],
		];
		for (const [description, fixtureOptions, code] of cases) {
			const { provider, fixture, calls } = createHarness({ fixture: fixtureOptions });
			await expectOAuthError(provider.handleChallenge(401, challenge(fixture), {}), code);
			assert.deepStrictEqual(calls, [], description);
			assert.deepStrictEqual(fixture.as.registrations, [], description);
		}
	});

	test('a plain-HTTP registration endpoint does not fail discovery: a pre-registered or metadata-document client never uses it, and the dynamic registration applies the endpoint rule where it registers', async () => {
		const withPlainRegistration = (): IOAuthFixture => {
			const fixture = createOAuthFixture();
			fixture.router.handle(new URL(fixture.issuer).origin, request => request.url.pathname === '/.well-known/oauth-authorization-server'
				? { status: 200, body: { ...fixture.as.metadata(), registration_endpoint: 'http://as.example.test/register' } }
				: undefined);
			return fixture;
		};
		const strict = createHarness({ fixtureInstance: withPlainRegistration() });
		assert.ok(await strict.provider.handleChallenge(401, challenge(strict.fixture), {}));
		const oauth: IMcpRemoteServerOAuthConfiguration = { allowInsecureHttp: true };
		const lenient = createHarness({ fixtureInstance: withPlainRegistration(), launch: { oauth } });
		assert.ok(await lenient.provider.handleChallenge(401, challenge(lenient.fixture), {}));
		// The main thread creates the dynamic provider with `oauth.allowInsecureHttp`, and the provider refuses
		// a plain-HTTP registration endpoint without it (mainThreadMcp.test.ts, extHostAuthentication.test.ts).
		assert.deepStrictEqual({
			registrationEndpoint: [...strict.calls, ...lenient.calls].map(call => call.details.authorizationServerMetadata.registration_endpoint),
			cleartextRequests: [...strict.fixture.requests, ...lenient.fixture.requests].filter(r => r.url.startsWith('http://')).length,
		}, { registrationEndpoint: ['http://as.example.test/register', 'http://as.example.test/register'], cleartextRequests: 0 });
	});

	test('a server without protected resource metadata falls back to the 2025-03-26 default endpoints', async () => {
		const { provider, calls, setups } = createHarness({ fixture: { rs: { prmLocation: 'none' }, as: { serveMetadata: false } } });
		assert.ok(await provider.handleChallenge(401, 'Bearer', {}));
		assert.strictEqual(calls[0].details.resourceMetadata, undefined);
		assert.strictEqual(calls[0].details.authorizationServerMetadata.authorization_endpoint, 'https://mcp.example.test/authorize');
		assert.deepStrictEqual(setups, [{ resourceMetadataSource: 'none', serverMetadataSource: 'default' }]);
	});

	test('PKCE is checked by the grant; "assume-supported" hands on metadata that advertises S256', async () => {
		const strict = createHarness({ fixture: { as: { codeChallengeMethodsSupported: null } } });
		assert.ok(await strict.provider.handleChallenge(401, challenge(strict.fixture), {}));
		assert.strictEqual(strict.calls[0].details.authorizationServerMetadata.code_challenge_methods_supported, undefined);

		const oauth: IMcpRemoteServerOAuthConfiguration = { pkce: 'assume-supported' };
		const lenient = createHarness({ fixture: { as: { codeChallengeMethodsSupported: null } }, launch: { oauth } });
		assert.ok(await lenient.provider.handleChallenge(401, challenge(lenient.fixture), {}));
		assert.deepStrictEqual(lenient.calls[0].details.authorizationServerMetadata.code_challenge_methods_supported, ['S256']);
	});

	test('a 403 without insufficient_scope is not a challenge', async () => {
		const { provider, fixture, calls } = createHarness();
		assert.strictEqual(await provider.handleChallenge(403, challenge(fixture, { error: 'access_denied' }), {}), false);
		assert.deepStrictEqual([calls.length, fixture.requests.length], [0, 0]);
	});

	test('concurrent challenges share one token request', async () => {
		const { provider, fixture, calls } = createHarness();
		const a: Record<string, string> = {};
		const b: Record<string, string> = {};
		const results = await Promise.all([provider.handleChallenge(401, challenge(fixture), a), provider.handleChallenge(401, challenge(fixture), b)]);
		assert.deepStrictEqual({ results, a: a.Authorization, b: b.Authorization, calls: calls.length }, { results: [true, true], a: 'Bearer token-1', b: 'Bearer token-1', calls: 1 });
	});

	test('terminal authorization errors of the main thread propagate; others leave the request unauthenticated', async () => {
		const terminal = createHarness({
			getToken: async () => {
				// What an OAuthClientError looks like after the RPC boundary.
				const error = new Error('The authorization response iss parameter does not match');
				error.name = 'OAuthClientError';
				throw error;
			},
		});
		await assert.rejects(terminal.provider.handleChallenge(401, challenge(terminal.fixture), {}), /iss parameter/);

		const soft = createHarness({ getToken: async () => { throw new Error('User did not consent to login. refresh_token=abc'); } });
		const headers: Record<string, string> = {};
		assert.strictEqual(await soft.provider.handleChallenge(401, challenge(soft.fixture), headers), false);
		assert.strictEqual(headers.Authorization, undefined);
		const warning = soft.logs.find(line => line.includes('User did not consent'));
		assert.ok(warning && !warning.includes('abc'), warning);
	});

	test('the same rejected token again ends the challenge handling', async () => {
		const { provider, fixture } = createHarness({ getToken: async () => 'same-token' });
		const headers: Record<string, string> = { Authorization: 'Bearer same-token' };
		assert.strictEqual(await provider.handleChallenge(401, challenge(fixture, { error: 'invalid_token' }), headers), false);
	});
});

suite('McpHTTPHandle authorization', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** @param hang Requests that never get an answer (the fetch ignores its signal too); it sees the signal the request was sent with. */
	function createHandle(fixture: IOAuthFixture, logLevel = LogLevel.Info, hang?: (url: string, signal: AbortSignal | undefined) => boolean) {
		const logs: string[] = [];
		const states: McpConnectionState[] = [];
		const aborts: IMcpRequestAbort[] = [];
		const tokenCalls: IMcpAuthenticationOptions[] = [];
		let issued = 0;
		const proxy = Object.assign(new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
			override $onDidAbortRequest(_id: number, abort: IMcpRequestAbort): void { aborts.push(abort); }
			override $onDidReceiveMessage(): void { }
			override $onDidPublishLog(_id: number, _level: LogLevel, message: string): void { logs.push(message); }
			override $logMcpAuthSetup(): void { }
			override async $getTokenFromServerMetadata(_id: number, _details: IMcpAuthenticationDetails, options?: IMcpAuthenticationOptions): Promise<string> {
				tokenCalls.push(options ?? {});
				return `token-${++issued}`;
			}
		}, { async $checkMcpServerAllowed() { return undefined; } });
		const logService: ILogService = new class extends NullLogService {
			override getLevel(): LogLevel { return logLevel; }
		}();
		const handle = store.add(new class extends McpHTTPHandle {
			protected override async _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
				if (hang?.(url, init?.signal)) {
					return new Promise<CommonResponse>(() => { });
				}
				const response = await fixture.fetch(url, { method: init?.method, headers: init?.headers, body: init?.body ? new TextDecoder().decode(init.body) : undefined });
				return toCommonResponse(url, response);
			}
		}(1, { type: McpServerTransportType.HTTP, uri: URI.parse(fixture.resource), headers: [] }, proxy, logService));
		return { handle, logs, states, aborts, tokenCalls };
	}

	test('stops answering challenges after three cycles and returns the challenged response', async () => {
		// A resource that rejects every token.
		const fixture = createOAuthFixture({ rs: { verifyToken: () => undefined } });
		const { handle, tokenCalls } = createHandle(fixture);
		const headers: Record<string, string> = {};
		const response = await internals(handle)._fetchWithAuthRetry(fixture.resource, { method: 'POST', headers }, headers);
		assert.strictEqual(response.status, 401);
		assert.strictEqual(fixture.rs.accesses.length, 4, 'the request and three retries');
		assert.deepStrictEqual(tokenCalls.map(o => [o.rejectedToken, o.forceNewRegistration ?? false]), [
			[undefined, false],
			['token-1', false],
			['token-2', true],
		]);
	});

	test('cancelling the request or disposing the handle ends a hung discovery', async () => {
		const outcomes: Record<string, { cancelled: boolean; tokenCalls: number }> = {};
		for (const end of ['cancel the request', 'dispose the handle'] as const) {
			const fixture = createOAuthFixture();
			const discovering = new DeferredPromise<void>();
			const { handle, tokenCalls } = createHandle(fixture, LogLevel.Info, url => {
				if (url.includes('/.well-known/')) {
					discovering.complete();
					return true;
				}
				return false;
			});
			const request = new AbortController();
			const headers: Record<string, string> = {};
			const pending = internals(handle)._fetchWithAuthRetry(fixture.resource, { method: 'POST', headers }, headers, undefined, request.signal);
			await discovering.p;
			if (end === 'cancel the request') {
				request.abort();
			} else {
				handle.dispose();
			}
			let cancelled = false;
			try {
				await pending;
			} catch (error) {
				cancelled = isCancellationError(error);
			}
			outcomes[end] = { cancelled, tokenCalls: tokenCalls.length };
		}
		assert.deepStrictEqual(outcomes, {
			'cancel the request': { cancelled: true, tokenCalls: 0 },
			'dispose the handle': { cancelled: true, tokenCalls: 0 },
		});
	});

	test('cancelling a request aborts the discovery fetch its challenge started', async () => {
		const fixture = createOAuthFixture();
		const discovery = new DeferredPromise<AbortSignal | undefined>();
		const { handle, tokenCalls, states } = createHandle(fixture, LogLevel.Info, (url, signal) => {
			if (url.includes('/.well-known/')) {
				discovery.complete(signal);
				return true;
			}
			return false;
		});
		// A 2026-07-28 request: the 401 to it starts discovery, whose first metadata request hangs.
		const sending = handle.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), { kind: 'request', requestId: 7, protocolVersion: '2026-07-28', method: 'tools/list' });
		const signal = await discovery.p;
		const abortedBeforeCancel = signal?.aborted;
		handle.cancelRequest(7);
		await sending;
		assert.deepStrictEqual({
			abortedBeforeCancel,
			abortedAfterCancel: signal?.aborted,
			tokenCalls: tokenCalls.length,
			failed: states.some(state => state.state === McpConnectionState.Kind.Error),
		}, { abortedBeforeCancel: false, abortedAfterCancel: true, tokenCalls: 0, failed: false });
	});

	test('a terminal authorization failure fails the request', async () => {
		const fixture = createOAuthFixture({ rs: { prmResource: 'https://evil.example.com/mcp' } });
		const { handle, tokenCalls } = createHandle(fixture);
		const headers: Record<string, string> = {};
		await assert.rejects(internals(handle)._fetchWithAuthRetry(fixture.resource, { method: 'POST', headers }, headers), (error: unknown) => error instanceof OAuthClientError && error.code === 'resource_mismatch');
		assert.deepStrictEqual(tokenCalls, []);
	});

	test('a terminal authorization failure of a 2025-11-25 request fails that request and the connection at once', async () => {
		// auth/scope-retry-limit: a fresh token is refused for the very scope it was issued for (step_up_limit).
		const fixture = createOAuthFixture({
			rs: {
				authorize: ({ accessToken, metadataUrl }) => accessToken === undefined
					? { status: 401, headers: { 'WWW-Authenticate': bearerChallenge({ scope: 'mcp:admin', resource_metadata: metadataUrl }) }, body: { error: 'invalid_token' } }
					: { status: 403, headers: { 'WWW-Authenticate': bearerChallenge({ error: 'insufficient_scope', scope: 'mcp:admin', resource_metadata: metadataUrl }) }, body: { error: 'insufficient_scope' } },
			},
		});
		const { handle, states, aborts, tokenCalls } = createHandle(fixture);
		await handle.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), { kind: 'request', requestId: 3, protocolVersion: '2025-11-25', method: 'tools/list' });
		assert.deepStrictEqual({
			accesses: fixture.rs.accesses.map(access => access.status),
			tokenCalls: tokenCalls.length,
			aborts: aborts.map(abort => ({ requestId: abort.requestId, reason: abort.reason, insufficientScope: !!abort.message?.includes('insufficient scope') })),
			failed: states.some(state => state.state === McpConnectionState.Kind.Error),
		}, {
			accesses: [401, 403],
			tokenCalls: 1,
			aborts: [{ requestId: 3, reason: 'transport-error', insufficientScope: true }],
			failed: true,
		});
	});

	test('trace logs blank the credential-bearing headers', async () => {
		const fixture = createOAuthFixture();
		fixture.router.handle(new URL(fixture.resource).origin, request => request.url.pathname === '/cookie'
			? { status: 200, headers: { 'Set-Cookie': 'session=cookie-value' }, body: { ok: true } }
			: undefined);
		const { handle, logs } = createHandle(fixture, LogLevel.Trace);
		await internals(handle)._fetch(`${new URL(fixture.resource).origin}/cookie`, { method: 'GET', headers: { Authorization: 'Bearer bearer-value', Cookie: 'c=cookie-sent' } });
		const leaked = ['bearer-value', 'cookie-value', 'cookie-sent'].filter(secret => logs.some(line => line.includes(secret)));
		assert.ok(logs.some(line => line.startsWith('Fetching ')) && logs.some(line => line.startsWith('Fetched ')));
		assert.deepStrictEqual(leaked, []);
	});
});
