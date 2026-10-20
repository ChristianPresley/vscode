/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { OAuthClientError } from '../../../../base/common/oauth.js';
import { IOAuthFetchResponse } from '../../../../base/common/oauthClient.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { bearerChallenge, createOAuthFixture, IOAuthFixture, IOAuthFixtureOptions } from '../../../../base/test/common/oauthClientFixture.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogService, LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { McpConnectionState, McpServerTransportHTTP, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { IAuthMetadataSource, IMcpAuthenticationDetails, IMcpAuthenticationOptions, MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { CommonRequestInit, CommonResponse, IMcpAuthHeaderProviderHost, McpAuthHeaderProvider, McpHTTPHandle } from '../../common/extHostMcp.js';

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
	_fetchWithAuthRetry(mcpUrl: string, init: { method: string; headers: Record<string, string> }, headers: Record<string, string>): Promise<CommonResponse>;
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
		readonly launch?: Partial<McpServerTransportHTTP>;
		readonly stepUps?: Map<string, number>;
		/** Answers the main thread's token request; defaults to `token-<n>`. */
		readonly getToken?: (call: ITokenCall, index: number) => Promise<string | undefined>;
	} = {}): IHarness {
		const fixture = createOAuthFixture(options.fixture);
		const calls: ITokenCall[] = [];
		const setups: IAuthMetadataSource[] = [];
		const logs: string[] = [];
		const states: McpConnectionState[] = [];
		const proxy: IMcpAuthHeaderProviderHost['proxy'] = {
			async $getTokenFromServerMetadata(_id, details, tokenOptions) {
				const call = { details, options: tokenOptions };
				calls.push(call);
				return options.getToken ? options.getToken(call, calls.length) : `token-${calls.length}`;
			},
			async $getTokenForProviderId() { return undefined; },
			$onDidChangeState(_id, state) { states.push(state); },
			$logMcpAuthSetup(data) { setups.push(data); },
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

	function createHandle(fixture: IOAuthFixture, logLevel = LogLevel.Info) {
		const logs: string[] = [];
		const states: McpConnectionState[] = [];
		const tokenCalls: IMcpAuthenticationOptions[] = [];
		let issued = 0;
		const proxy = Object.assign(new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
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
				const response = await fixture.fetch(url, { method: init?.method, headers: init?.headers, body: init?.body ? new TextDecoder().decode(init.body) : undefined });
				return toCommonResponse(url, response);
			}
		}(1, { type: McpServerTransportType.HTTP, uri: URI.parse(fixture.resource), headers: [] }, proxy, logService));
		return { handle, logs, states, tokenCalls };
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

	test('a terminal authorization failure fails the request', async () => {
		const fixture = createOAuthFixture({ rs: { prmResource: 'https://evil.example.com/mcp' } });
		const { handle, tokenCalls } = createHandle(fixture);
		const headers: Record<string, string> = {};
		await assert.rejects(internals(handle)._fetchWithAuthRetry(fixture.resource, { method: 'POST', headers }, headers), (error: unknown) => error instanceof OAuthClientError && error.code === 'resource_mismatch');
		assert.deepStrictEqual(tokenCalls, []);
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
