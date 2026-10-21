/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../common/buffer.js';
import { CancellationTokenSource } from '../../common/cancellation.js';
import { isCancellationError } from '../../common/errors.js';
import { IAuthorizationServerMetadata, OAuthClientError, OAuthClientErrorCode } from '../../common/oauth.js';
import { createHeadlessRedirectAuthorize, InMemoryOAuthClientStorage, IOAuthClientOptions, IOAuthClientRecord, IOAuthFetch, OAuthClient, parseBearerChallenge, redact, resourceIndicatorFor, selectScopes } from '../../common/oauthClient.js';
import { bearerChallenge, createAuthorizationServerFixture, createFixtureRouter, createOAuthFixture, createResourceServerFixture, IFixtureResponse, IOAuthAuthorizationServerFixtureOptions } from './oauthClientFixture.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

/**
 * Covers the scored client authorization scenarios of the MCP conformance
 * suite (`@modelcontextprotocol/conformance`, requirements/2026-07-28.yaml and
 * requirements/2025-11-25.yaml) against an in-memory fixture that mirrors the
 * suite's authorization server and protected resource, plus the rules of the
 * 2026-07-28 authorization specification that the scenarios exercise only
 * indirectly.
 */

const REDIRECT_URI = 'http://127.0.0.1:33418/';
const CIMD_URL = 'https://conformance-test.local/client-metadata.json';

type Revision = '2025-11-25' | '2026-07-28';
const BOTH: readonly Revision[] = ['2025-11-25', '2026-07-28'];
const LATEST: readonly Revision[] = ['2026-07-28'];

/** The `client` list of requirements/2026-07-28.yaml, auth entries only. */
const SCORED_2026_07_28 = [
	'auth/metadata-default', 'auth/metadata-var1', 'auth/metadata-var2', 'auth/metadata-var3', 'auth/basic-cimd',
	'auth/scope-from-www-authenticate', 'auth/scope-from-scopes-supported', 'auth/scope-omitted-when-undefined', 'auth/scope-step-up', 'auth/scope-retry-limit',
	'auth/token-endpoint-auth-basic', 'auth/token-endpoint-auth-post', 'auth/token-endpoint-auth-none', 'auth/pre-registration',
	'auth/resource-mismatch', 'auth/offline-access-scope', 'auth/offline-access-not-supported', 'auth/authorization-server-migration',
	'auth/iss-supported', 'auth/iss-not-advertised', 'auth/iss-supported-missing', 'auth/iss-wrong-issuer', 'auth/iss-unexpected', 'auth/iss-normalized',
	'auth/metadata-issuer-mismatch',
];

/** The `client` list of requirements/2025-11-25.yaml, auth entries only. */
const SCORED_2025_11_25 = [
	'auth/metadata-default', 'auth/metadata-var1', 'auth/metadata-var2', 'auth/metadata-var3', 'auth/basic-cimd',
	'auth/scope-from-www-authenticate', 'auth/scope-from-scopes-supported', 'auth/scope-omitted-when-undefined', 'auth/scope-step-up', 'auth/scope-retry-limit',
	'auth/token-endpoint-auth-basic', 'auth/token-endpoint-auth-post', 'auth/token-endpoint-auth-none', 'auth/pre-registration',
];

interface IScenario {
	readonly name: string;
	readonly revisions: readonly Revision[];
	/** The check ids the conformance scenario emits that the test asserts. */
	readonly checks: readonly string[];
	run(): Promise<void>;
}

suite('OAuthClient', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let seed = 1;
	const random = (bytes: number): Uint8Array => {
		const out = new Uint8Array(bytes);
		for (let i = 0; i < bytes; i++) {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			out[i] = (seed >>> 16) & 0xff;
		}
		return out;
	};
	const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as ArrayBufferView<ArrayBuffer>));

	interface ITestClient {
		readonly client: OAuthClient;
		readonly log: string[];
		readonly storage: InMemoryOAuthClientStorage;
		/** Every record change, in order; `undefined` is a forgotten record. */
		readonly records: Array<IOAuthClientRecord | undefined>;
	}

	function createClient(fixture: { readonly fetch: IOAuthFetch }, overrides: Partial<IOAuthClientOptions> = {}): ITestClient {
		const log: string[] = [];
		const storage = new InMemoryOAuthClientStorage();
		const records: Array<IOAuthClientRecord | undefined> = [];
		const client = store.add(new OAuthClient({
			clientName: 'VS Code Test',
			clientUri: 'https://conformance-test.local',
			redirectUris: [REDIRECT_URI],
			registration: { clientMetadataUrl: CIMD_URL },
			authorize: createHeadlessRedirectAuthorize(fixture.fetch),
			fetch: fixture.fetch,
			storage,
			random,
			sha256,
			log: (level, message) => log.push(`${level}: ${message}`),
			...overrides,
		}));
		store.add(client.onDidChangeRecord(e => records.push(e.record)));
		return { client, log, storage, records };
	}

	function call(client: OAuthClient, fixture: { readonly resource: string }, body: unknown = { method: 'tools/list' }) {
		return client.fetchWithAuth(fixture.resource, fixture.resource, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	}

	async function expectClientError(promise: Promise<unknown>, code: OAuthClientErrorCode, why = ''): Promise<OAuthClientError> {
		try {
			await promise;
		} catch (error) {
			assert.ok(error instanceof OAuthClientError, `expected an OAuthClientError '${code}'${why ? ` (${why})` : ''}, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
			assert.strictEqual(error.code, code, `expected '${code}'${why ? ` (${why})` : ''}, got '${error.code}': ${error.message}`);
			return error;
		}
		assert.fail(`expected an OAuthClientError '${code}'${why ? ` (${why})` : ''}, but the promise resolved`);
	}

	function challengeResponse(status: number, params: Record<string, string | undefined>, error: string): IFixtureResponse {
		return { status, headers: { 'WWW-Authenticate': bearerChallenge(params) }, body: { error } };
	}

	function assertBasicCredentials(header: string | undefined, clientId: string, clientSecret: string): void {
		if (header === undefined || !header.startsWith('Basic ')) {
			assert.fail(`the token request carries Basic credentials, got '${header}'`);
		}
		const decoded = decodeBase64(header.substring(6)).toString();
		assert.ok(decoded.includes(':'), 'Basic credentials have a colon separator');
		assert.strictEqual(decoded, `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
	}

	const scenarios: IScenario[] = [
		{
			name: 'auth/metadata-default', revisions: BOTH,
			checks: ['prm-pathbased-requested', 'prm-priority-order', 'authorization-server-metadata', 'client-registration', 'sep-837-application-type-present', 'authorization-request', 'pkce-code-challenge-sent', 'pkce-s256-method-used', 'token-request', 'pkce-code-verifier-sent', 'pkce-verifier-matches-challenge', 'valid-bearer-token'],
			run: async () => {
				const fixture = createOAuthFixture({ rs: { trapRootPrm: true } });
				const { client } = createClient(fixture);
				const response = await call(client, fixture);
				assert.strictEqual(response.status, 200);
				assert.deepStrictEqual(fixture.rs.prmRequests, ['/.well-known/oauth-protected-resource/mcp']);
				assert.deepStrictEqual(fixture.rs.violations, []);
				assert.deepStrictEqual(fixture.as.metadataRequests, ['/.well-known/oauth-authorization-server']);
				assert.strictEqual(fixture.as.registrations.length, 1);
				assert.strictEqual(fixture.as.registrations[0].application_type, 'native');
				assert.ok((fixture.as.registrations[0].grant_types as string[]).includes('refresh_token'), 'refresh_token is registered as a grant type');
				assert.deepStrictEqual(fixture.as.registrations[0].redirect_uris, [REDIRECT_URI]);
				const authorization = fixture.as.authorizationRequests[0].query;
				assert.strictEqual(authorization.response_type, 'code');
				assert.strictEqual(authorization.client_id, fixture.as.registeredClientIds[0]);
				assert.strictEqual(authorization.redirect_uri, REDIRECT_URI);
				assert.strictEqual(authorization.code_challenge_method, 'S256');
				assert.match(authorization.code_challenge, /^[A-Za-z0-9_-]{43}$/);
				assert.ok(authorization.state, 'state is sent');
				assert.strictEqual(authorization.resource, fixture.resource);
				const token = fixture.as.tokenRequests[0];
				assert.strictEqual(token.body.grant_type, 'authorization_code');
				assert.match(token.body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
				assert.strictEqual(token.body.resource, fixture.resource);
				const access = fixture.rs.accesses.at(-1)!;
				assert.strictEqual(access.status, 200);
				assert.ok(access.accessToken && fixture.as.issuedTokens.has(access.accessToken), 'the resource saw the issued bearer token');
			},
		},
		{
			name: 'auth/metadata-var1', revisions: BOTH,
			checks: ['prm-pathbased-requested', 'authorization-server-metadata', 'client-registration', 'authorization-request', 'token-request'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { metadataLocation: 'oidc' }, rs: { prmInWwwAuthenticate: false } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.deepStrictEqual(fixture.rs.prmRequests, ['/.well-known/oauth-protected-resource/mcp'], 'the path-based well-known URI is probed when the challenge names no metadata URL');
				assert.deepStrictEqual(fixture.as.metadataRequests, ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'], 'RFC 8414 first, then OpenID Connect Discovery');
				assert.strictEqual(fixture.as.tokenRequests.length, 1);
			},
		},
		{
			name: 'auth/metadata-var2', revisions: BOTH,
			checks: ['authorization-server-metadata', 'authorization-server-metadata-wrong-path', 'client-registration', 'authorization-request', 'token-request', 'resource-parameter-matches-prm'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issuer: 'https://as.example.test/tenant1', trapRootMetadata: true }, rs: { prmLocation: 'root', prmInWwwAuthenticate: false } });
				const { client, storage } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.deepStrictEqual(fixture.rs.prmRequests, ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], 'path-based before root');
				assert.deepStrictEqual(fixture.as.metadataRequests, ['/.well-known/oauth-authorization-server/tenant1'], 'path insertion for an issuer with a path');
				assert.deepStrictEqual(fixture.as.violations, []);
				// The root metadata names the bare origin: it is sent exactly as published, without the slash a URL parser adds.
				const published = fixture.rs.metadata().resource;
				assert.strictEqual(published, new URL(fixture.resource).origin);
				assert.strictEqual(fixture.as.authorizationRequests[0].query.resource, published, 'the authorization request names the resource of the metadata');
				assert.strictEqual(fixture.as.tokenRequests[0].body.resource, published, 'the token request names the resource of the metadata');
				assert.ok(await storage.get(fixture.resource), 'the record stays keyed by the MCP server URL');
			},
		},
		{
			name: 'auth/metadata-var3', revisions: BOTH,
			checks: ['authorization-server-metadata', 'authorization-server-metadata-wrong-path', 'client-registration', 'authorization-request', 'token-request'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issuer: 'https://as.example.test/tenant1', metadataLocation: 'oidc-appended', trapRootMetadata: true }, rs: { prmLocation: 'custom' } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.deepStrictEqual(fixture.rs.prmRequests, ['/custom/metadata/location.json'], 'the metadata URL of the challenge is used as is');
				assert.deepStrictEqual(fixture.as.metadataRequests, [
					'/.well-known/oauth-authorization-server/tenant1',
					'/.well-known/openid-configuration/tenant1',
					'/tenant1/.well-known/openid-configuration',
				], 'the discovery order of the specification');
				assert.deepStrictEqual(fixture.as.violations, []);
			},
		},
		{
			name: 'auth/basic-cimd', revisions: BOTH,
			checks: ['cimd-client-id-used'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { clientIdMetadataDocumentSupported: true } });
				const { client, storage } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.strictEqual(fixture.as.registrations.length, 0, 'no dynamic registration when the server supports client ID metadata documents');
				assert.strictEqual(fixture.as.authorizationRequests[0].query.client_id, CIMD_URL);
				assert.strictEqual(fixture.as.tokenRequests[0].clientId, CIMD_URL);
				assert.strictEqual((await storage.get(fixture.resource))?.registrationKind, 'cimd');
			},
		},
		{
			name: 'auth/scope-from-www-authenticate', revisions: BOTH,
			checks: ['scope-from-www-authenticate'],
			run: async () => {
				const fixture = createOAuthFixture({ rs: { requiredScopes: ['mcp:basic'], scopeInWwwAuthenticate: true } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.deepStrictEqual(fixture.as.authorizationRequests[0].scopes, ['mcp:basic']);
			},
		},
		{
			name: 'auth/scope-from-scopes-supported', revisions: BOTH,
			checks: ['scope-from-scopes-supported'],
			run: async () => {
				const scopes = ['mcp:basic', 'mcp:read', 'mcp:write'];
				const fixture = createOAuthFixture({ rs: { requiredScopes: scopes, scopesSupported: scopes, scopeInWwwAuthenticate: false } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.deepStrictEqual(fixture.as.authorizationRequests[0].scopes, scopes);
			},
		},
		{
			name: 'auth/scope-omitted-when-undefined', revisions: BOTH,
			checks: ['scope-omitted-when-undefined'],
			run: async () => {
				const fixture = createOAuthFixture({ rs: { scopeInWwwAuthenticate: false } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.strictEqual(fixture.as.authorizationRequests[0].query.scope, undefined, 'no scope parameter without a challenge scope or scopes_supported');
			},
		},
		{
			name: 'auth/scope-step-up', revisions: BOTH,
			checks: ['scope-step-up-initial', 'scope-step-up-escalation', 'sep-2350-scope-union-on-reauth (2026-07-28)'],
			run: async () => {
				const fixture = createOAuthFixture({
					rs: {
						scopesSupported: ['mcp:profile'],
						authorize: context => {
							if (context.accessToken === undefined) {
								return challengeResponse(401, { scope: 'mcp:basic', resource_metadata: context.metadataUrl }, 'invalid_token');
							}
							const method = (context.request.json() as { method?: string }).method;
							const needed = method === 'tools/call' ? 'mcp:write' : 'mcp:basic';
							return context.grant?.scopes.includes(needed) ? undefined : challengeResponse(403, { scope: needed, resource_metadata: context.metadataUrl, error: 'insufficient_scope' }, 'insufficient_scope');
						},
					},
				});
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture, { method: 'tools/list' })).status, 200);
				assert.deepStrictEqual(fixture.as.authorizationRequests[0].scopes, ['mcp:basic'], 'the challenge scope wins over scopes_supported');
				assert.strictEqual((await call(client, fixture, { method: 'tools/call' })).status, 200);
				assert.strictEqual(fixture.as.authorizationRequests.length, 2);
				assert.ok(fixture.as.authorizationRequests[1].scopes.includes('mcp:write'), 'the challenged scope is requested');
				assert.ok(fixture.as.authorizationRequests[1].scopes.includes('mcp:basic'), 'the previously granted scope is kept (SEP-2350 union)');
				assert.ok(!fixture.as.authorizationRequests[1].scopes.includes('mcp:profile'), 'scopes_supported is not consulted during step-up');
			},
		},
		{
			name: 'auth/scope-retry-limit', revisions: BOTH,
			checks: ['scope-retry-limit', 'scope-retry-auth-attempt'],
			run: async () => {
				let denials = 0;
				const fixture = createOAuthFixture({
					rs: {
						scopesSupported: ['mcp:admin'],
						authorize: context => {
							if (context.accessToken === undefined) {
								return challengeResponse(401, { scope: 'mcp:admin', resource_metadata: context.metadataUrl }, 'invalid_token');
							}
							denials++;
							return denials > 3
								? { status: 410, body: { error: 'test_complete' } }
								: challengeResponse(403, { error: 'insufficient_scope', scope: 'mcp:admin', resource_metadata: context.metadataUrl }, 'insufficient_scope');
						},
					},
				});
				const { client } = createClient(fixture);
				await expectClientError(call(client, fixture), 'step_up_limit');
				assert.ok(fixture.as.authorizationRequests.length >= 1 && fixture.as.authorizationRequests.length <= 3, `at most 3 authorization attempts, got ${fixture.as.authorizationRequests.length}`);
				assert.ok(denials <= 3, 'the resource never had to end the test');
			},
		},
		{
			name: 'auth/token-endpoint-auth-basic', revisions: BOTH,
			checks: ['token-endpoint-auth-method', 'resource-parameter-in-authorization', 'resource-parameter-in-token', 'resource-parameter-valid-uri', 'resource-parameter-consistency'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { tokenEndpointAuthMethodsSupported: ['client_secret_basic'] } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				const token = fixture.as.tokenRequests[0];
				assert.strictEqual(token.authMethod, 'client_secret_basic');
				assertBasicCredentials(token.authorizationHeader, fixture.as.registeredClientIds[0], `${fixture.as.registeredClientIds[0].replace('client', 'secret')}`);
				assert.strictEqual(token.body.client_secret, undefined);
				assertResourceParameter(fixture);
			},
		},
		{
			name: 'auth/token-endpoint-auth-post', revisions: BOTH,
			checks: ['token-endpoint-auth-method', 'resource-parameter-in-authorization', 'resource-parameter-in-token', 'resource-parameter-valid-uri', 'resource-parameter-consistency'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { tokenEndpointAuthMethodsSupported: ['client_secret_post'] } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				const token = fixture.as.tokenRequests[0];
				assert.strictEqual(token.authMethod, 'client_secret_post');
				assert.strictEqual(token.authorizationHeader, undefined);
				assert.ok(token.body.client_secret, 'the secret travels in the body');
				assert.strictEqual(token.body.client_id, fixture.as.registeredClientIds[0]);
				assertResourceParameter(fixture);
			},
		},
		{
			name: 'auth/token-endpoint-auth-none', revisions: BOTH,
			checks: ['token-endpoint-auth-method', 'resource-parameter-in-authorization', 'resource-parameter-in-token', 'resource-parameter-valid-uri', 'resource-parameter-consistency'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { tokenEndpointAuthMethodsSupported: ['none'] } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				const token = fixture.as.tokenRequests[0];
				assert.strictEqual(token.authMethod, 'none');
				assert.strictEqual(token.authorizationHeader, undefined);
				assert.strictEqual(token.body.client_secret, undefined);
				assert.strictEqual(token.body.client_id, fixture.as.registeredClientIds[0]);
				assertResourceParameter(fixture);
			},
		},
		{
			name: 'auth/pre-registration', revisions: BOTH,
			checks: ['pre-registration-auth'],
			run: async () => {
				const fixture = createOAuthFixture({
					as: {
						disableDynamicRegistration: true,
						tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
						clients: { 'pre-registered-client': { clientSecret: 'pre-registered-secret', tokenEndpointAuthMethod: 'client_secret_basic' } },
						requireKnownClient: true,
					},
				});
				const { client, storage } = createClient(fixture, { registration: { preRegistered: { clientId: 'pre-registered-client', clientSecret: 'pre-registered-secret' }, clientMetadataUrl: CIMD_URL } });
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.strictEqual(fixture.as.registrations.length, 0);
				assertBasicCredentials(fixture.as.tokenRequests[0].authorizationHeader, 'pre-registered-client', 'pre-registered-secret');
				assert.strictEqual((await storage.get(fixture.resource))?.registrationKind, 'pre-registered');
			},
		},
		{
			name: 'auth/resource-mismatch', revisions: LATEST,
			checks: ['resource-mismatch-rejected'],
			run: async () => {
				const fixture = createOAuthFixture({ rs: { prmResource: 'https://evil.example.com/mcp' } });
				const { client } = createClient(fixture);
				await expectClientError(call(client, fixture), 'resource_mismatch');
				assert.strictEqual(fixture.as.authorizationRequests.length, 0, 'no authorization request after a resource mismatch');
				assert.strictEqual(fixture.as.registrations.length, 0);
			},
		},
		{
			name: 'auth/offline-access-scope', revisions: LATEST,
			checks: ['sep-2207-offline-access-requested', 'sep-2207-client-metadata-grant-types'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { scopesSupported: ['mcp:basic', 'offline_access'], clientIdMetadataDocumentSupported: true }, rs: { requiredScopes: ['mcp:basic'], scopesSupported: ['mcp:basic'] } });
				const { client } = createClient(fixture, { requestOfflineAccess: true });
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.deepStrictEqual(fixture.as.authorizationRequests[0].scopes, ['mcp:basic', 'offline_access']);
				assert.ok(fixture.as.tokenRequests[0].body.resource, 'the token request names the resource');
			},
		},
		{
			name: 'auth/offline-access-not-supported', revisions: LATEST,
			checks: ['sep-2207-offline-access-not-requested'],
			run: async () => {
				const scopes = ['mcp:basic', 'mcp:read'];
				const fixture = createOAuthFixture({ as: { scopesSupported: scopes }, rs: { requiredScopes: scopes, scopesSupported: scopes } });
				const { client } = createClient(fixture, { requestOfflineAccess: true });
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.deepStrictEqual(fixture.as.authorizationRequests[0].scopes, scopes, 'offline_access is not requested when the authorization server does not list it');
			},
		},
		{
			name: 'auth/authorization-server-migration', revisions: LATEST,
			checks: ['sep-2352-reregister-on-as-change', 'sep-2352-no-reuse-on-as-change', 'sep-2352-no-cross-as-credential-reuse'],
			run: async () => {
				const router = createFixtureRouter();
				const as1 = createAuthorizationServerFixture(router, { issuer: 'https://as1.example.test', tokenPrefix: 'as1' });
				const as2 = createAuthorizationServerFixture(router, { issuer: 'https://as2.example.test', tokenPrefix: 'as2' });
				let migrated = false;
				const rs = createResourceServerFixture(router, {
					authorizationServers: () => [migrated ? as2.issuer : as1.issuer],
					verifyToken: token => as1.verifyToken(token) ?? as2.verifyToken(token),
					authorize: context => {
						if (context.accessToken === undefined) {
							return challengeResponse(401, { scope: 'mcp:basic', resource_metadata: context.metadataUrl }, 'invalid_token');
						}
						if (!migrated) {
							migrated = true;
							return undefined;
						}
						return context.accessToken.startsWith('as2-') ? undefined : challengeResponse(401, { scope: 'mcp:basic', resource_metadata: context.metadataUrl }, 'invalid_token');
					},
				});
				const fixture = { fetch: router.fetch, resource: rs.resource };
				const { client, records } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				const leaked = as1.registeredClientIds[0];
				assert.ok(leaked, 'the client registered with the first authorization server');
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.strictEqual(as2.registrations.length, 1, 'the client re-registered with the new authorization server');
				assert.ok(as2.authorizationRequests.every(r => r.query.client_id === as2.registeredClientIds[0]), 'only the new client id reaches the new authorization server');
				assert.ok(as2.tokenRequests.every(r => r.clientId === as2.registeredClientIds[0]));
				assert.ok(as2.authorizationRequests.every(r => r.query.client_id !== leaked) && as2.tokenRequests.every(r => r.clientId !== leaked), 'the previous client id is never presented to the new authorization server');
				assert.strictEqual(as1.tokenRequests.length, 1, 'no refresh is attempted at the previous authorization server');
				assert.ok(records.includes(undefined), 'the record bound to the previous issuer was forgotten');
			},
		},
		{
			name: 'auth/iss-supported', revisions: LATEST,
			checks: ['sep-2468-client-compare-iss-supported'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issParameterSupported: true, issInRedirect: 'correct' } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.strictEqual(fixture.as.tokenRequests.length, 1, 'the matching iss lets the code be redeemed');
			},
		},
		{
			name: 'auth/iss-not-advertised', revisions: LATEST,
			checks: ['sep-2468-client-proceed-no-iss'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issParameterSupported: null, issInRedirect: 'omit' } });
				const { client } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				assert.strictEqual(fixture.as.tokenRequests.length, 1, 'an absent iss is fine when support is not advertised');
			},
		},
		{
			name: 'auth/iss-supported-missing', revisions: LATEST,
			checks: ['sep-2468-client-reject-missing-iss'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issParameterSupported: true, issInRedirect: 'omit' } });
				const { client } = createClient(fixture);
				await expectClientError(call(client, fixture), 'iss_missing');
				assert.strictEqual(fixture.as.authorizationRequests.length, 1);
				assert.strictEqual(fixture.as.tokenRequests.length, 0, 'the code is not redeemed');
			},
		},
		{
			name: 'auth/iss-wrong-issuer', revisions: LATEST,
			checks: ['sep-2468-client-compare-iss-supported'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issParameterSupported: true, issInRedirect: 'wrong' } });
				const { client } = createClient(fixture);
				await expectClientError(call(client, fixture), 'iss_mismatch');
				assert.strictEqual(fixture.as.authorizationRequests.length, 1);
				assert.strictEqual(fixture.as.tokenRequests.length, 0);
			},
		},
		{
			name: 'auth/iss-unexpected', revisions: LATEST,
			checks: ['sep-2468-client-compare-iss-unadvertised'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issParameterSupported: null, issInRedirect: 'wrong' } });
				const { client } = createClient(fixture);
				await expectClientError(call(client, fixture), 'iss_mismatch');
				assert.strictEqual(fixture.as.tokenRequests.length, 0, 'a present iss is compared even when support is not advertised');
			},
		},
		{
			name: 'auth/iss-normalized', revisions: LATEST,
			checks: ['sep-2468-client-no-normalization'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { issParameterSupported: true, issInRedirect: 'normalized' } });
				const { client } = createClient(fixture);
				await expectClientError(call(client, fixture), 'iss_mismatch');
				assert.strictEqual(fixture.as.tokenRequests.length, 0, 'a trailing-slash variant of the issuer is a mismatch');
			},
		},
		{
			name: 'auth/metadata-issuer-mismatch', revisions: LATEST,
			checks: ['sep-2468-client-validate-metadata-issuer', 'authorization-server-metadata'],
			run: async () => {
				const fixture = createOAuthFixture({ as: { advertisedIssuer: 'https://attacker.example.com' } });
				const { client } = createClient(fixture);
				const error = await expectClientError(call(client, fixture), 'issuer_mismatch');
				assert.ok(error.message.includes('https://attacker.example.com'));
				assert.ok(fixture.as.metadataRequests.length >= 1, 'the metadata document was retrieved');
				assert.strictEqual(fixture.as.registrations.length, 0);
				assert.strictEqual(fixture.as.authorizationRequests.length, 0);
				assert.strictEqual(fixture.as.tokenRequests.length, 0, 'no endpoint of the mismatched metadata is used');
			},
		},
	];

	function assertResourceParameter(fixture: ReturnType<typeof createOAuthFixture>): void {
		const inAuthorization = fixture.as.authorizationRequests[0].query.resource;
		const inToken = fixture.as.tokenRequests[0].body.resource;
		assert.strictEqual(inAuthorization, fixture.resource, 'resource in the authorization request');
		assert.strictEqual(inToken, fixture.resource, 'resource in the token request');
		assert.strictEqual(new URL(inAuthorization).hash, '', 'the resource indicator has no fragment');
	}

	suite('conformance client auth scenarios', () => {
		for (const scenario of scenarios) {
			test(`${scenario.name} [${scenario.revisions.join(', ')}] — ${scenario.checks.join(', ')}`, () => scenario.run());
		}

		test('the scenario table covers the 25 scored 2026-07-28 and the 14 scored 2025-11-25 client auth scenarios', () => {
			assert.strictEqual(SCORED_2026_07_28.length, 25);
			assert.strictEqual(SCORED_2025_11_25.length, 14);
			for (const name of SCORED_2026_07_28) {
				assert.ok(scenarios.some(s => s.name === name && s.revisions.includes('2026-07-28')), `${name} is covered for 2026-07-28`);
			}
			for (const name of SCORED_2025_11_25) {
				assert.ok(scenarios.some(s => s.name === name && s.revisions.includes('2025-11-25')), `${name} is covered for 2025-11-25`);
			}
			assert.strictEqual(scenarios.filter(s => s.revisions.includes('2026-07-28')).length, 25);
			assert.strictEqual(scenarios.filter(s => s.revisions.includes('2025-11-25')).length, 14);
			assert.strictEqual(new Set(scenarios.map(s => s.name)).size, scenarios.length, 'every scenario appears once');
		});
	});

	suite('rules', () => {
		const issuer = 'https://as.example.test/tenant';
		const resource = 'https://mcp.example.test/mcp';
		const metadataFor = (overrides: Partial<IAuthorizationServerMetadata> = {}): IAuthorizationServerMetadata => ({
			issuer,
			authorization_endpoint: `${issuer}/authorize`,
			token_endpoint: `${issuer}/token`,
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			authorization_response_iss_parameter_supported: true,
			...overrides,
		});
		const registration = { kind: 'pre-registered' as const, clientId: 'client', tokenEndpointAuthMethod: 'none' as const };
		const tokenEndpointFetch: IOAuthFetch = async url => {
			assert.strictEqual(url, `${issuer}/token`, 'only the token endpoint is contacted');
			return { status: 200, headers: { get: () => null }, text: async () => '', json: async () => ({ access_token: 'issued', token_type: 'Bearer', expires_in: 60 }) };
		};
		const noNetwork: IOAuthFetch = async url => { throw new Error(`unexpected request to ${url}`); };

		test('exact iss comparison rejects trailing-slash, host-case, scheme-case and default-port variants', async () => {
			for (const variant of [`${issuer}/`, 'https://AS.example.test/tenant', 'HTTPS://as.example.test/tenant', 'https://as.example.test:443/tenant', 'https://as.example.test/ten%61nt']) {
				const { client } = createClient({ fetch: noNetwork }, { authorize: async request => ({ code: 'code', state: request.state, iss: variant }), maxAuthorizationRequests: 10 });
				const error = await expectClientError(client.authorizationCodeGrant({ serverMetadata: metadataFor(), resource, registration }), 'iss_mismatch');
				assert.deepStrictEqual(error.detail, { iss: variant, expectedIssuer: issuer });
			}
		});

		test('a missing iss is rejected when advertised and tolerated otherwise; a present one is compared regardless', async () => {
			const missing = createClient({ fetch: noNetwork }, { authorize: async request => ({ code: 'code', state: request.state }) });
			await expectClientError(missing.client.authorizationCodeGrant({ serverMetadata: metadataFor(), resource, registration }), 'iss_missing');

			const tolerated = createClient({ fetch: tokenEndpointFetch }, { authorize: async request => ({ code: 'code', state: request.state }) });
			for (const advertised of [false, undefined]) {
				const result = await tolerated.client.authorizationCodeGrant({ serverMetadata: metadataFor({ authorization_response_iss_parameter_supported: advertised }), resource, registration });
				assert.strictEqual(result.accessToken, 'issued');
			}

			const unadvertised = createClient({ fetch: noNetwork }, { authorize: async request => ({ code: 'code', state: request.state, iss: 'https://evil.example.com' }) });
			await expectClientError(unadvertised.client.authorizationCodeGrant({ serverMetadata: metadataFor({ authorization_response_iss_parameter_supported: undefined }), resource, registration }), 'iss_mismatch');
		});

		test('iss is validated before an error response is acted on', async () => {
			const mixedUp = createClient({ fetch: noNetwork }, { authorize: async request => ({ query: `?error=access_denied&error_description=nope&state=${request.state}&iss=${encodeURIComponent('https://evil.example.com')}` }) });
			await expectClientError(mixedUp.client.authorizationCodeGrant({ serverMetadata: metadataFor(), resource, registration }), 'iss_mismatch');

			const denied = createClient({ fetch: noNetwork }, { authorize: async request => ({ query: `?error=access_denied&error_description=nope&state=${request.state}&iss=${encodeURIComponent(issuer)}` }) });
			const error = await expectClientError(denied.client.authorizationCodeGrant({ serverMetadata: metadataFor(), resource, registration }), 'authorization_denied');
			assert.deepStrictEqual(error.detail, { error: 'access_denied', errorDescription: 'nope', errorUri: undefined });

			const forged = createClient({ fetch: noNetwork }, { authorize: async () => ({ code: 'code', state: 'someone-elses-state', iss: issuer }) });
			await expectClientError(forged.client.authorizationCodeGrant({ serverMetadata: metadataFor(), resource, registration }), 'state_mismatch');
		});

		test('PKCE S256 must be advertised unless the client assumes support', async () => {
			for (const advertised of [null, ['plain']] as const) {
				const fixture = createOAuthFixture({ as: { codeChallengeMethodsSupported: advertised } });
				const { client } = createClient(fixture);
				await expectClientError(call(client, fixture), 'pkce_unsupported');
				assert.strictEqual(fixture.as.authorizationRequests.length, 0);
			}
			const fixture = createOAuthFixture({ as: { codeChallengeMethodsSupported: null } });
			const { client } = createClient(fixture, { pkce: 'assume-supported' });
			assert.strictEqual((await call(client, fixture)).status, 200);
			assert.strictEqual(fixture.as.authorizationRequests[0].query.code_challenge_method, 'S256', 'S256 is used even when the server does not advertise it');
		});

		test('http endpoints are rejected unless loopback or explicitly allowed', async () => {
			const insecure = createOAuthFixture({ as: { insecureEndpoints: true } });
			await expectClientError(call(createClient(insecure).client, insecure), 'insecure_endpoint');
			assert.strictEqual(insecure.as.authorizationRequests.length, 0);

			const allowed = createOAuthFixture({ as: { insecureEndpoints: true } });
			assert.strictEqual((await call(createClient(allowed, { allowInsecureHttp: true }).client, allowed)).status, 200);

			const loopback = createOAuthFixture({ as: { issuer: 'http://localhost:3000' } });
			assert.strictEqual((await call(createClient(loopback).client, loopback)).status, 200);
			assert.ok(loopback.as.authorizationEndpoint.startsWith('http://localhost:3000/'));
		});

		test('a plain-HTTP authorization server fails discovery before anything is sent there, unless explicitly allowed', async () => {
			// A plain-HTTP issuer whose metadata names HTTPS endpoints: whoever answers in cleartext picks the endpoints.
			const withPlainIssuer = (): ReturnType<typeof createOAuthFixture> => {
				const fixture = createOAuthFixture({ rs: { authorizationServers: ['http://as.example.test'] } });
				fixture.router.handle('http://as.example.test', request => request.url.pathname === '/.well-known/oauth-authorization-server'
					? { status: 200, body: { ...fixture.as.metadata(), issuer: 'http://as.example.test' } }
					: undefined);
				return fixture;
			};
			const refused = withPlainIssuer();
			const error = await expectClientError(call(createClient(refused).client, refused), 'insecure_endpoint');
			const allowed = withPlainIssuer();
			const discovery = await createClient(allowed, { allowInsecureHttp: true }).client.discover(allowed.resource);
			assert.deepStrictEqual({
				message: error.message.includes('http://as.example.test') ? 'named' : 'unnamed',
				cleartextRequests: refused.requests.filter(r => r.url.startsWith('http://as.example.test')).length,
				registrations: refused.as.registrations.length,
				allowed: `${discovery.serverMetadata.issuer} ${discovery.serverMetadata.registration_endpoint}`,
			}, { message: 'named', cleartextRequests: 0, registrations: 0, allowed: 'http://as.example.test https://as.example.test/register' });
		});

		test('a plain-HTTP registration endpoint is refused only when the client registers there: discovery, pre-registered and client ID metadata document clients are unaffected', async () => {
			// HTTPS authorization and token endpoints, but client metadata (and the secret in the response) would travel in cleartext.
			const withPlainRegistration = (as: IOAuthAuthorizationServerFixtureOptions = {}): ReturnType<typeof createOAuthFixture> => {
				const fixture = createOAuthFixture({ as: { clientIdMetadataDocumentSupported: false, ...as } });
				fixture.router.handle(new URL(fixture.issuer).origin, request => request.url.pathname === '/.well-known/oauth-authorization-server'
					? { status: 200, body: { ...fixture.as.metadata(), registration_endpoint: 'http://as.example.test/register' } }
					: undefined);
				return fixture;
			};
			const cleartext = (fixture: ReturnType<typeof createOAuthFixture>) => fixture.requests.filter(r => r.url.startsWith('http://')).length;
			const outcomes: Record<string, string> = {};

			const discovered = withPlainRegistration();
			const discovery = await createClient(discovered).client.discover(discovered.resource);
			outcomes.discovery = `${discovery.serverMetadata.issuer} ${discovery.serverMetadata.registration_endpoint}, ${cleartext(discovered)} cleartext requests`;

			const preRegistered = withPlainRegistration({ clients: { 'pre-registered-client': { tokenEndpointAuthMethod: 'none' } }, requireKnownClient: true });
			const status = (await call(createClient(preRegistered, { registration: { preRegistered: { clientId: 'pre-registered-client' } } }).client, preRegistered)).status;
			outcomes.preRegistered = `${status}, ${cleartext(preRegistered)} cleartext requests, ${preRegistered.as.registrations.length} registrations`;

			const cimd = withPlainRegistration({ clientIdMetadataDocumentSupported: true });
			outcomes.cimd = `${(await call(createClient(cimd).client, cimd)).status}, ${cleartext(cimd)} cleartext requests, ${cimd.as.authorizationRequests[0]?.query.client_id}`;

			const dynamic = withPlainRegistration();
			const error = await expectClientError(call(createClient(dynamic).client, dynamic), 'insecure_endpoint', 'dynamic registration');
			outcomes.dynamic = `${error.message.includes('http://as.example.test/register') ? 'named' : 'unnamed'}, ${cleartext(dynamic)} cleartext requests, ${dynamic.as.authorizationRequests.length} authorization requests`;

			// With a configured prompt the client asks for credentials instead, as the extension host's providers do.
			const prompted = withPlainRegistration({ clients: { 'typed-client': { tokenEndpointAuthMethod: 'none' } }, requireKnownClient: true });
			let asked = 0;
			const promptingClient = createClient(prompted, { registration: { prompt: async () => { asked++; return { clientId: 'typed-client' }; } } });
			const promptedStatus = (await call(promptingClient.client, prompted)).status;
			outcomes.prompted = `${promptedStatus}, asked ${asked}, ${cleartext(prompted)} cleartext requests, ${prompted.as.registrations.length} registrations, ${promptingClient.log.filter(line => line.startsWith('warn: the registration endpoint http://as.example.test/register is not served over HTTPS')).length} warning`;

			assert.deepStrictEqual(outcomes, {
				discovery: 'https://as.example.test http://as.example.test/register, 0 cleartext requests',
				preRegistered: '200, 0 cleartext requests, 0 registrations',
				cimd: `200, 0 cleartext requests, ${CIMD_URL}`,
				dynamic: 'named, 0 cleartext requests, 0 authorization requests',
				prompted: '200, asked 1, 0 cleartext requests, 0 registrations, 1 warning',
			});
		});

		function escalatingResource(): ReturnType<typeof createOAuthFixture> {
			let challenges = 0;
			return createOAuthFixture({
				rs: {
					authorize: context => {
						if (context.accessToken === undefined) {
							return challengeResponse(401, { scope: 's0', resource_metadata: context.metadataUrl }, 'invalid_token');
						}
						challenges++;
						return challengeResponse(403, { error: 'insufficient_scope', scope: `s${challenges}`, resource_metadata: context.metadataUrl }, 'insufficient_scope');
					},
				},
			});
		}

		test('step-up requests the union of held and demanded scopes and stops at the authorization request limit', async () => {
			const fixture = escalatingResource();
			const { client } = createClient(fixture, { maxChallengesPerRequest: 10 });
			await expectClientError(call(client, fixture), 'step_up_limit');
			assert.deepStrictEqual(fixture.as.authorizationRequests.map(r => r.scopes), [['s0'], ['s0', 's1'], ['s0', 's1', 's2']]);
		});

		test('fetchWithAuth stops at the challenge limit', async () => {
			const fixture = escalatingResource();
			const { client } = createClient(fixture, { maxAuthorizationRequests: 10, maxChallengesPerRequest: 2 });
			await expectClientError(call(client, fixture), 'challenge_limit');
			assert.strictEqual(fixture.as.authorizationRequests.length, 2);
		});

		test('insufficient_scope for scopes that were just requested is terminal', async () => {
			let tokens = 0;
			const fixture = createOAuthFixture({
				as: { grantScopes: () => ['s0'] },
				rs: {
					authorize: context => {
						if (context.accessToken === undefined) {
							return challengeResponse(401, { scope: 's0 s1', resource_metadata: context.metadataUrl }, 'invalid_token');
						}
						tokens++;
						return challengeResponse(403, { error: 'insufficient_scope', scope: 's1', resource_metadata: context.metadataUrl }, 'insufficient_scope');
					},
				},
			});
			const { client } = createClient(fixture, { maxChallengesPerRequest: 10, maxAuthorizationRequests: 10 });
			await expectClientError(call(client, fixture), 'step_up_limit');
			assert.strictEqual(fixture.as.authorizationRequests.length, 1, 'no re-authorization for a scope the server declined to grant');
			assert.strictEqual(tokens, 1);
		});

		test('the authorization server with a stored registration is selected, otherwise the first listed', async () => {
			const router = createFixtureRouter();
			const first = createAuthorizationServerFixture(router, { issuer: 'https://first.example.test', tokenPrefix: 'first' });
			const second = createAuthorizationServerFixture(router, { issuer: 'https://second.example.test', tokenPrefix: 'second' });
			const rs = createResourceServerFixture(router, { authorizationServers: [first.issuer, second.issuer], verifyToken: token => first.verifyToken(token) ?? second.verifyToken(token) });
			const fixture = { fetch: router.fetch, resource: rs.resource };

			const fresh = createClient(fixture);
			assert.strictEqual((await fresh.client.discover(rs.resource)).authorizationServer, first.issuer);

			const returning = createClient(fixture);
			await returning.storage.set(rs.resource, { issuer: second.issuer, registrationKind: 'dcr', clientId: 'known', tokenEndpointAuthMethod: 'none', authorizationRequests: 0 });
			assert.strictEqual((await returning.client.discover(rs.resource)).authorizationServer, second.issuer);
			assert.deepStrictEqual(first.metadataRequests, ['/.well-known/oauth-authorization-server'], 'the first server was only consulted by the fresh client');
		});

		test('invalid_client after a client ID metadata document falls back to dynamic registration once', async () => {
			for (const at of ['token', 'authorize'] as const) {
				const fixture = createOAuthFixture({ as: { clientIdMetadataDocumentSupported: true, rejectCimdClientAt: at } });
				const { client, storage } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200, at);
				assert.strictEqual(fixture.as.registrations.length, 1, 'registered dynamically after the rejection');
				assert.strictEqual(fixture.as.authorizationRequests[0].query.client_id, CIMD_URL);
				assert.strictEqual(fixture.as.authorizationRequests[1].query.client_id, fixture.as.registeredClientIds[0]);
				assert.strictEqual((await storage.get(fixture.resource))?.registrationKind, 'dcr', 'the record remembers the fallback');

				fixture.as.revokeAll();
				assert.strictEqual((await call(client, fixture)).status, 200, 'a later re-authorization reuses the dynamic registration');
				assert.strictEqual(fixture.as.authorizationRequests.at(-1)!.query.client_id, fixture.as.registeredClientIds[0], 'CIMD is not reselected');
			}
		});

		test('the prompt supplies credentials when no other registration mechanism is available or dynamic registration fails', async () => {
			const fixture = createOAuthFixture({
				as: {
					disableDynamicRegistration: true,
					tokenEndpointAuthMethodsSupported: ['client_secret_post'],
					clients: { 'typed-client': { clientSecret: 'typed-secret', tokenEndpointAuthMethod: 'client_secret_post' } },
					requireKnownClient: true,
				},
			});
			let prompted = 0;
			const typed = createClient(fixture, { registration: { clientMetadataUrl: CIMD_URL, prompt: async () => { prompted++; return { clientId: 'typed-client', clientSecret: 'typed-secret' }; } } });
			assert.strictEqual((await call(typed.client, fixture)).status, 200);
			assert.strictEqual(prompted, 1);
			assert.strictEqual(fixture.as.authorizationRequests[0].query.client_id, 'typed-client', 'CIMD is not used when the server does not advertise it');
			assert.strictEqual(fixture.as.tokenRequests[0].authMethod, 'client_secret_post', 'the method the server supports is used');
			assert.strictEqual((await typed.storage.get(fixture.resource))?.registrationKind, 'prompt');

			const failing = createOAuthFixture();
			failing.router.handle(new URL(failing.issuer).origin, request => request.url.pathname === '/register' ? { status: 503, body: 'unavailable' } : undefined);
			let asked = 0;
			const fallback = createClient(failing, { registration: { prompt: async () => { asked++; return { clientId: 'typed-public-client' }; } } });
			assert.strictEqual((await call(fallback.client, failing)).status, 200);
			assert.strictEqual(asked, 1, 'a failed dynamic registration falls back to the prompt');
			assert.strictEqual(failing.as.tokenRequests[0].clientId, 'typed-public-client');
			assert.strictEqual(failing.as.tokenRequests[0].authMethod, 'none', 'a client without a secret is public');

			const cancelled = createOAuthFixture({ as: { disableDynamicRegistration: true } });
			await expectClientError(call(createClient(cancelled, { registration: { prompt: async () => undefined } }).client, cancelled), 'registration_failed', 'the prompt was cancelled');
			assert.strictEqual(cancelled.as.authorizationRequests.length, 0);

			const nothing = createOAuthFixture({ as: { disableDynamicRegistration: true } });
			await expectClientError(call(createClient(nothing, { registration: { dynamic: false } }).client, nothing), 'registration_failed', 'no mechanism at all');
		});

		test('invalid_client without a fallback is surfaced', async () => {
			const fixture = createOAuthFixture({ as: { clientIdMetadataDocumentSupported: true, rejectCimdClientAt: 'token', disableDynamicRegistration: true } });
			const { client } = createClient(fixture);
			const error = await expectClientError(call(client, fixture), 'token_request_failed');
			assert.strictEqual((error.detail as { error?: string }).error, 'invalid_client');
		});

		test('an issuer change forgets the record and skips the refresh', async () => {
			const router = createFixtureRouter();
			const previous = createAuthorizationServerFixture(router, { issuer: 'https://previous.example.test', tokenPrefix: 'previous' });
			const next = createAuthorizationServerFixture(router, { issuer: 'https://next.example.test', tokenPrefix: 'next' });
			const rs = createResourceServerFixture(router, { authorizationServers: [next.issuer], verifyToken: token => next.verifyToken(token) });
			const fixture = { fetch: router.fetch, resource: rs.resource };
			const { client, storage, records } = createClient(fixture);
			await storage.set(rs.resource, { issuer: previous.issuer, registrationKind: 'dcr', clientId: 'old-client', tokenEndpointAuthMethod: 'none', accessToken: 'expired', expiresAt: 0, refreshToken: 'old-refresh', scopes: ['a'], authorizationRequests: 1 });

			assert.strictEqual((await call(client, fixture)).status, 200);
			assert.strictEqual(previous.tokenRequests.length, 0, 'the old refresh token is not presented anywhere');
			assert.strictEqual(previous.metadataRequests.length, 0);
			assert.strictEqual(records[0], undefined, 'the stale record was forgotten first');
			const record = await storage.get(rs.resource);
			assert.strictEqual(record?.issuer, next.issuer);
			assert.strictEqual(record?.clientId, next.registeredClientIds[0]);
			assert.ok(next.tokenRequests.every(r => r.clientId !== 'old-client'));
		});

		test('pre-registered credentials bound to another issuer are an error rather than reused', async () => {
			const fixture = createOAuthFixture({ as: { disableDynamicRegistration: true } });
			const bound = createClient(fixture, { registration: { preRegistered: { clientId: 'static', clientSecret: 'secret', issuer: 'https://other.example.test' } } });
			await expectClientError(call(bound.client, fixture), 'issuer_not_registered');
			assert.strictEqual(fixture.as.authorizationRequests.length, 0);

			const stale = createClient(fixture, { registration: { preRegistered: { clientId: 'static', clientSecret: 'secret' } } });
			await stale.storage.set(fixture.resource, { issuer: 'https://other.example.test', registrationKind: 'pre-registered', clientId: 'static', clientSecret: 'secret', tokenEndpointAuthMethod: 'client_secret_basic', refreshToken: 'r', authorizationRequests: 1 });
			await expectClientError(call(stale.client, fixture), 'issuer_not_registered');
			assert.strictEqual(fixture.as.tokenRequests.length, 0);
		});

		test('offline_access is requested only when wanted and listed by the authorization server', () => {
			assert.deepStrictEqual(selectScopes({ challengeScope: 'a b', prmScopes: ['c'] }), ['a', 'b'], 'the challenge wins');
			assert.deepStrictEqual(selectScopes({ prmScopes: ['c', 'd'] }), ['c', 'd'], 'then scopes_supported');
			assert.strictEqual(selectScopes({}), undefined, 'then nothing');
			assert.strictEqual(selectScopes({ challengeScope: '  ' }), undefined);
			assert.deepStrictEqual(selectScopes({ challengeScope: 'b', previous: ['a', 'b'] }), ['a', 'b'], 'previous scopes are kept without duplicates');
			assert.deepStrictEqual(selectScopes({ challengeScope: 'a', requestOfflineAccess: true, scopesSupported: ['a', 'offline_access'] }), ['a', 'offline_access']);
			assert.deepStrictEqual(selectScopes({ challengeScope: 'a', requestOfflineAccess: true, scopesSupported: ['a'] }), ['a'], 'not listed');
			assert.deepStrictEqual(selectScopes({ challengeScope: 'a', requestOfflineAccess: false, scopesSupported: ['a', 'offline_access'] }), ['a'], 'not wanted');
			assert.deepStrictEqual(selectScopes({ challengeScope: 'a', prmScopes: ['offline_access'], requestOfflineAccess: true }), ['a'], 'the resource listing it is not enough');
			assert.deepStrictEqual(selectScopes({ requestOfflineAccess: true, scopesSupported: ['offline_access'] }), ['offline_access']);
		});

		test('expiring tokens are refreshed within the margin instead of re-authorizing', async () => {
			let now = 1_000_000;
			const fixture = createOAuthFixture({ as: { tokenLifetimeSeconds: 100 } });
			const { client, storage } = createClient(fixture, { now: () => now, refreshMarginSeconds: 60 });
			assert.strictEqual((await call(client, fixture)).status, 200);
			const first = (await storage.get(fixture.resource))!;
			assert.strictEqual(first.expiresAt, now + 100_000);
			assert.ok(await client.getAuthorization(fixture.resource), 'the fresh token is returned');

			now += 50_000;
			assert.strictEqual(await client.getAuthorization(fixture.resource), undefined, 'a token expiring within the margin is not handed out');
			assert.strictEqual((await call(client, fixture)).status, 200);
			assert.strictEqual(fixture.as.authorizationRequests.length, 1, 'no second authorization');
			assert.deepStrictEqual(fixture.as.tokenRequests.map(r => r.body.grant_type), ['authorization_code', 'refresh_token']);
			assert.strictEqual(fixture.as.tokenRequests[1].body.refresh_token, first.refreshToken);
			assert.strictEqual(fixture.as.tokenRequests[1].body.resource, fixture.resource, 'the refresh names the resource too');
			const second = (await storage.get(fixture.resource))!;
			assert.notStrictEqual(second.accessToken, first.accessToken);
			assert.notStrictEqual(second.refreshToken, first.refreshToken, 'the rotated refresh token is stored');
			assert.strictEqual(second.clientId, first.clientId, 'the registration is kept');
		});

		test('the resource indicator is the protected resource metadata\'s resource as published, else the server URL without the slash of a bare origin; records stay keyed by the canonical URI', async () => {
			const sent = (fixture: ReturnType<typeof createOAuthFixture>) => [...fixture.as.authorizationRequests.map(r => `authorize ${r.query.resource}`), ...fixture.as.tokenRequests.map(r => `${r.body.grant_type} ${r.body.resource}`)];
			const outcomes: Record<string, unknown> = {};

			// A bare-origin server whose root metadata names the origin without a slash, or with one.
			for (const prmResource of ['https://mcp.example.test', 'https://mcp.example.test/']) {
				const fixture = createOAuthFixture({ rs: { resource: 'https://mcp.example.test', prmLocation: 'root', prmResource } });
				const { client, storage } = createClient(fixture);
				assert.strictEqual((await call(client, fixture)).status, 200);
				outcomes[`published ${prmResource}`] = { sent: sent(fixture), stored: (await storage.get('https://mcp.example.test/')) !== undefined };
			}

			// Metadata that spells the host in capitals: sent as written.
			const capitals = createOAuthFixture({ rs: { prmResource: 'https://MCP.example.test/mcp' } });
			assert.strictEqual((await call(createClient(capitals).client, capitals)).status, 200);
			outcomes.capitals = sent(capitals);

			// Metadata whose resource carries a fragment: sent as written but without it (RFC 8707 section 2).
			const fragment = createOAuthFixture({ rs: { prmResource: 'https://MCP.example.test/mcp#tools' } });
			assert.strictEqual((await call(createClient(fragment).client, fragment)).status, 200);
			outcomes.fragment = sent(fragment);
			outcomes.fragmentHelper = [
				resourceIndicatorFor('https://mcp.example.test/mcp', 'https://mcp.example.test/mcp#tools'),
				resourceIndicatorFor('https://mcp.example.test/', 'https://mcp.example.test#tools'),
				resourceIndicatorFor('https://mcp.example.test/', 'https://mcp.example.test/#'),
				resourceIndicatorFor('https://mcp.example.test/mcp?x=1', 'https://mcp.example.test/mcp?x=1#a#b'),
			];

			// No metadata: the canonical URI, slash-less for a bare origin, in the grant and in the refresh.
			let now = 1_000_000;
			const noMetadata = createOAuthFixture({ as: { tokenLifetimeSeconds: 100 } });
			const bare = createClient(noMetadata, { now: () => now, refreshMarginSeconds: 60 });
			await bare.client.acquireToken({ serverMetadata: noMetadata.as.metadata(), resource: 'https://mcp.example.test' });
			now += 50_000;
			await bare.client.acquireToken({ serverMetadata: noMetadata.as.metadata(), resource: 'https://mcp.example.test/' });
			outcomes.noMetadata = { sent: sent(noMetadata), stored: (await bare.storage.get('https://mcp.example.test/'))?.authorizationRequests };

			// Metadata naming another resource (from a caller) is not used.
			const foreign = createOAuthFixture();
			await createClient(foreign).client.acquireToken({ serverMetadata: foreign.as.metadata(), resourceMetadata: { resource: 'https://other.example.test/mcp', authorization_servers: [foreign.issuer] }, resource: foreign.resource });
			outcomes.foreign = sent(foreign);

			assert.deepStrictEqual(outcomes, {
				'published https://mcp.example.test': { sent: ['authorize https://mcp.example.test', 'authorization_code https://mcp.example.test'], stored: true },
				'published https://mcp.example.test/': { sent: ['authorize https://mcp.example.test/', 'authorization_code https://mcp.example.test/'], stored: true },
				capitals: ['authorize https://MCP.example.test/mcp', 'authorization_code https://MCP.example.test/mcp'],
				fragment: ['authorize https://MCP.example.test/mcp', 'authorization_code https://MCP.example.test/mcp'],
				fragmentHelper: ['https://mcp.example.test/mcp', 'https://mcp.example.test', 'https://mcp.example.test/', 'https://mcp.example.test/mcp?x=1'],
				noMetadata: { sent: ['authorize https://mcp.example.test', 'authorization_code https://mcp.example.test', 'refresh_token https://mcp.example.test'], stored: 1 },
				foreign: [`authorize ${foreign.resource}`, `authorization_code ${foreign.resource}`],
			});
		});

		function rejectingResource(as: IOAuthAuthorizationServerFixtureOptions = {}): ReturnType<typeof createOAuthFixture> {
			return createOAuthFixture({ as, rs: { authorize: context => challengeResponse(401, { error: context.accessToken === undefined ? undefined : 'invalid_token', resource_metadata: context.metadataUrl }, 'invalid_token') } });
		}

		test('a rejected token is forgotten and refreshed; two consecutive rejections of fresh tokens register the client anew', async () => {
			const fixture = rejectingResource();
			const { client, log } = createClient(fixture);
			await expectClientError(call(client, fixture), 'challenge_limit');
			assert.strictEqual(fixture.as.registrations.length, 2, 'the second rejection in a row registered a new client');
			const [first, second] = fixture.as.registeredClientIds;
			assert.deepStrictEqual(fixture.as.tokenRequests.map(r => [r.body.grant_type, r.clientId]), [
				['authorization_code', first],
				['refresh_token', first],
				['authorization_code', second],
			], 'the first rejection refreshes with the stored registration (refresh before re-authorization); the refreshed token is rejected too, so the client registers anew');
			assert.deepStrictEqual(fixture.as.authorizationRequests.map(r => r.query.client_id), [first, second]);
			assert.deepStrictEqual(fixture.rs.accesses.map(a => a.accessToken), [undefined, ...fixture.as.issuedTokens.keys()], 'every issued token is presented once, in order: no rejected token is presented again');
			assert.ok(log.some(line => line.includes('2 in a row') && line.includes('registering the client again')), 'the forced registration is logged');
		});

		test('without a refresh token a rejected token is re-authorized with the same registration first', async () => {
			const fixture = rejectingResource({ issueRefreshTokens: false });
			const { client } = createClient(fixture);
			await expectClientError(call(client, fixture), 'challenge_limit');
			assert.strictEqual(fixture.as.registrations.length, 2, 'the second rejection in a row registered a new client');
			const [first, second] = fixture.as.registeredClientIds;
			assert.deepStrictEqual(fixture.as.authorizationRequests.map(r => r.query.client_id), [first, first, second], 'the first rejection kept the registration');
			assert.ok(fixture.as.tokenRequests.every(r => r.body.grant_type === 'authorization_code'));
		});

		test('a step-up re-authorizes instead of refreshing, even when the granted scopes are unknown', async () => {
			const fixture = createOAuthFixture({
				as: { echoScope: false },
				rs: {
					authorize: context => {
						if (context.accessToken === undefined) {
							return challengeResponse(401, { resource_metadata: context.metadataUrl }, 'invalid_token');
						}
						return context.grant?.scopes.includes('mcp:write') ? undefined : challengeResponse(403, { error: 'insufficient_scope', scope: 'mcp:write', resource_metadata: context.metadataUrl }, 'insufficient_scope');
					},
				},
			});
			const { client, storage } = createClient(fixture);
			assert.strictEqual((await call(client, fixture)).status, 200);
			assert.deepStrictEqual(fixture.as.authorizationRequests.map(r => r.scopes), [[], ['mcp:write']], 'scope omitted first, then the challenged scope');
			assert.deepStrictEqual(fixture.as.tokenRequests.map(r => r.body.grant_type), ['authorization_code', 'authorization_code'], 'a refresh cannot widen the grant');
			assert.deepStrictEqual((await storage.get(fixture.resource))?.scopes, ['mcp:write'], 'the requested scopes are recorded when the server does not echo them');
		});

		test('an accepted token resets the rejection streak', async () => {
			let reject = false;
			const fixture = createOAuthFixture({
				rs: {
					authorize: context => {
						if (context.accessToken === undefined || (reject && context.grant === undefined)) {
							return challengeResponse(401, { resource_metadata: context.metadataUrl }, 'invalid_token');
						}
						return undefined;
					},
				},
			});
			const { client } = createClient(fixture, { maxAuthorizationRequests: 10 });
			assert.strictEqual((await call(client, fixture)).status, 200);
			reject = true;
			fixture.as.revokeAll();
			assert.strictEqual((await call(client, fixture)).status, 200);
			fixture.as.revokeAll();
			assert.strictEqual((await call(client, fixture)).status, 200);
			assert.strictEqual(fixture.as.registrations.length, 1, 'rejections separated by accepted tokens do not re-register');
		});

		test('legacy default endpoints are used only without protected resource metadata and when enabled', async () => {
			const strict = createOAuthFixture({ rs: { prmLocation: 'none' } });
			await expectClientError(call(createClient(strict).client, strict), 'discovery_failed');

			const router = createFixtureRouter();
			const rs = createResourceServerFixture(router, { authorizationServers: [], verifyToken: () => undefined, prmLocation: 'none' });
			const as = createAuthorizationServerFixture(router, { issuer: 'https://mcp.example.test', issInRedirect: 'omit', issParameterSupported: null });
			const found = createClient({ fetch: router.fetch }, { legacyDefaultEndpoints: true });
			const discovery = await found.client.discover(rs.resource);
			assert.strictEqual(discovery.legacyDefaults, false, 'metadata at the resource origin is used when it exists');
			assert.strictEqual(discovery.serverMetadata.issuer, as.issuer);

			const fallbackRouter = createFixtureRouter();
			const fallbackRs = createResourceServerFixture(fallbackRouter, { authorizationServers: [], verifyToken: token => fallbackAs.verifyToken(token), prmLocation: 'none' });
			const fallbackAs = createAuthorizationServerFixture(fallbackRouter, { issuer: 'https://mcp.example.test', serveMetadata: false, issInRedirect: 'omit' });
			const fallback = createClient({ fetch: fallbackRouter.fetch }, { legacyDefaultEndpoints: true });
			const fallbackDiscovery = await fallback.client.discover(fallbackRs.resource);
			assert.strictEqual(fallbackDiscovery.legacyDefaults, true);
			assert.strictEqual(fallbackDiscovery.serverMetadata.authorization_endpoint, 'https://mcp.example.test/authorize');
			assert.strictEqual((await call(fallback.client, { resource: fallbackRs.resource })).status, 200);
			assert.strictEqual(fallbackAs.registrations.length, 1, 'registered at the default /register endpoint');
			assert.strictEqual(fallbackAs.authorizationRequests[0].query.code_challenge_method, 'S256');

			const withPrm = createOAuthFixture({ rs: { prmResource: 'https://evil.example.com/mcp' } });
			await expectClientError(call(createClient(withPrm, { legacyDefaultEndpoints: true }).client, withPrm), 'resource_mismatch', 'a mismatching document is still a document: no legacy fallback');
		});

		test('sameOriginHeaders accompany protected resource metadata requests to the resource origin only', async () => {
			const fixture = createOAuthFixture();
			const sameOrigin = createClient(fixture, { sameOriginHeaders: { 'X-Session': 'abc' } });
			assert.strictEqual((await call(sameOrigin.client, fixture)).status, 200);
			const prmRequests = fixture.requests.filter(r => r.url.includes('/.well-known/oauth-protected-resource'));
			assert.ok(prmRequests.length > 0 && prmRequests.every(r => r.headers['x-session'] === 'abc'), 'sent with metadata requests to the resource origin');
			assert.ok(fixture.requests.filter(r => r.url.startsWith(fixture.issuer)).every(r => r.headers['x-session'] === undefined), 'never sent to the authorization server');

			const elsewhere = 'https://metadata.example.test/prm';
			const crossOrigin = createOAuthFixture({ rs: { authorize: context => context.accessToken === undefined ? challengeResponse(401, { resource_metadata: elsewhere }, 'invalid_token') : undefined } });
			crossOrigin.router.handle('https://metadata.example.test', request => request.url.pathname === '/prm' ? { status: 200, body: { resource: crossOrigin.resource, authorization_servers: [crossOrigin.issuer] } } : undefined);
			const other = createClient(crossOrigin, { sameOriginHeaders: { 'X-Session': 'abc' } });
			assert.strictEqual((await call(other.client, crossOrigin)).status, 200);
			const metadataRequest = crossOrigin.requests.find(r => r.url === elsewhere);
			assert.ok(metadataRequest, 'the metadata URL of the challenge was used');
			assert.strictEqual(metadataRequest.headers['x-session'], undefined, 'not sent to another origin');
		});

		test('token responses must carry a Bearer access token', async () => {
			const respond = (body: unknown): IOAuthFetch => async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
			for (const body of [{ access_token: 'x', token_type: 'DPoP' }, { access_token: 'x', token_type: 7 }, { access_token: '', token_type: 'Bearer' }, { access_token: 42, token_type: 'Bearer' }, { token_type: 'Bearer' }]) {
				const { client } = createClient({ fetch: respond(body) }, { authorize: async request => ({ code: 'code', state: request.state, iss: issuer }) });
				await expectClientError(client.authorizationCodeGrant({ serverMetadata: metadataFor(), resource, registration }), 'token_request_failed', JSON.stringify(body));
			}
			const { client } = createClient({ fetch: respond({ access_token: 'x', token_type: 'bearer' }) }, { authorize: async request => ({ code: 'code', state: request.state, iss: issuer }) });
			assert.strictEqual((await client.authorizationCodeGrant({ serverMetadata: metadataFor(), resource, registration })).accessToken, 'x', 'the token type is case-insensitive (RFC 6749 section 7.1)');
		});

		test('non-challenge responses pass through fetchWithAuth untouched', async () => {
			const forbidden = createOAuthFixture({ rs: { authorize: context => context.accessToken === undefined ? challengeResponse(401, { resource_metadata: context.metadataUrl }, 'invalid_token') : { status: 403, body: { error: 'forbidden' } } } });
			assert.strictEqual((await call(createClient(forbidden).client, forbidden)).status, 403);
			assert.strictEqual(forbidden.as.authorizationRequests.length, 1);

			const basic = createOAuthFixture({ rs: { authorize: () => ({ status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' } }) } });
			assert.strictEqual((await call(createClient(basic).client, basic)).status, 401);
			assert.strictEqual(basic.as.authorizationRequests.length, 0, 'a non-Bearer challenge is not handled');
		});

		test('getAuthorization, forget and onDidChangeRecord', async () => {
			const fixture = createOAuthFixture();
			const { client, records } = createClient(fixture);
			assert.strictEqual(await client.getAuthorization(fixture.resource), undefined);
			assert.strictEqual((await call(client, fixture)).status, 200);
			const authorization = await client.getAuthorization(fixture.resource);
			assert.ok(authorization?.accessToken && fixture.as.issuedTokens.has(authorization.accessToken));
			assert.strictEqual(authorization.record.registrationKind, 'dcr');
			assert.strictEqual(authorization.record.issuer, fixture.issuer);
			assert.strictEqual(authorization.record.authorizationRequests, 1);
			assert.strictEqual(records.length, 1);
			await client.forget(fixture.resource);
			assert.strictEqual(await client.getAuthorization(fixture.resource), undefined);
			assert.strictEqual(records.at(-1), undefined);
			assert.strictEqual((await call(client, fixture)).status, 200);
			assert.strictEqual(fixture.as.registrations.length, 2, 'forgetting drops the registration too');
		});

		test('cancellation aborts discovery, requests and a pending authorization', async () => {
			const fixture = createOAuthFixture();
			const { client } = createClient(fixture);
			const source = store.add(new CancellationTokenSource());
			source.cancel();
			await assert.rejects(client.discover(fixture.resource, undefined, source.token), (error: unknown) => isCancellationError(error));
			await assert.rejects(client.fetchWithAuth(fixture.resource, fixture.resource, {}, source.token), (error: unknown) => isCancellationError(error));
			assert.strictEqual(fixture.as.authorizationRequests.length, 0);
			assert.strictEqual(fixture.requests.length, 0, 'nothing is sent once cancelled');

			const later = store.add(new CancellationTokenSource());
			const cancelling = createOAuthFixture();
			const authorizing = createClient(cancelling, { authorize: async () => { later.cancel(); return new Promise<never>(() => { }); } });
			await assert.rejects(authorizing.client.fetchWithAuth(cancelling.resource, cancelling.resource, {}, later.token), (error: unknown) => isCancellationError(error), 'a strategy that ignores the token is not waited on after cancellation');
			assert.strictEqual(cancelling.as.tokenRequests.length, 0);
		});

		test('parseBearerChallenge reads the Bearer challenge only', () => {
			assert.deepStrictEqual(parseBearerChallenge('Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="a b", error="insufficient_scope", error_description="more"'), {
				scheme: 'Bearer', resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp', scope: 'a b', error: 'insufficient_scope', errorDescription: 'more',
			});
			assert.deepStrictEqual(parseBearerChallenge('Basic realm="r", Bearer scope=""'), { scheme: 'Bearer', resourceMetadataUrl: undefined, scope: undefined, error: undefined, errorDescription: undefined });
			assert.strictEqual(parseBearerChallenge('Basic realm="r"'), undefined);
			assert.strictEqual(parseBearerChallenge(undefined), undefined);
			assert.strictEqual(parseBearerChallenge(''), undefined);
		});

		test('redact strips credentials from log messages', () => {
			assert.strictEqual(redact('Authorization: Bearer eyJhbGciOi.secret'), 'Authorization: Bearer [redacted]');
			assert.strictEqual(redact('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic [redacted]');
			assert.strictEqual(redact('WWW-Authenticate: Bearer resource_metadata="https://x", scope="a"'), 'WWW-Authenticate: Bearer resource_metadata="https://x", scope="a"', 'challenges are not credentials');
			assert.strictEqual(redact('Location: http://127.0.0.1:33418/?code=abc&state=s'), 'Location: [redacted]');
			assert.strictEqual(redact('redirect ?code=abc&state=s&iss=x'), 'redirect ?code=[redacted]&state=s&iss=x');
			assert.strictEqual(redact('grant_type=authorization_code&code=c&code_verifier=v&client_secret=s&resource=r'), 'grant_type=authorization_code&code=[redacted]&code_verifier=[redacted]&client_secret=[redacted]&resource=r');
			assert.strictEqual(redact('{"access_token":"t","token_type":"Bearer","refresh_token": "r","client_secret":"s","code":"c"}'), '{"access_token":"[redacted]","token_type":"Bearer","refresh_token":"[redacted]","client_secret":"[redacted]","code":"[redacted]"}');
			assert.strictEqual(redact('discovered https://as.example.test for https://mcp.example.test/mcp'), 'discovered https://as.example.test for https://mcp.example.test/mcp');
			assert.strictEqual(redact('Authorization: Basic dXNlcjpwYXNzMQ=='), 'Authorization: Basic [redacted]', 'base64 padding is part of the credential');
			assert.strictEqual(redact('Authorization: Bearer abc=def'), 'Authorization: Bearer [redacted]', 'a token with an equals sign is not a challenge parameter');
			assert.strictEqual(redact('{"registration_access_token":"rat","client_secret_expires_at":0,"token_endpoint_auth_method":"none"}'), '{"registration_access_token":"[redacted]","client_secret_expires_at":0,"token_endpoint_auth_method":"none"}');
			assert.strictEqual(redact('grant_type=refresh_token&refresh_token=r&subject_token=s&token_type_hint=x'), 'grant_type=refresh_token&refresh_token=[redacted]&subject_token=[redacted]&token_type_hint=x');
		});

		test('the log never contains tokens, codes, verifiers or secrets', async () => {
			const fixture = createOAuthFixture({ as: { tokenEndpointAuthMethodsSupported: ['client_secret_basic'], tokenLifetimeSeconds: 100, clientIdMetadataDocumentSupported: true, rejectCimdClientAt: 'token' } });
			let now = 0;
			const { client, log, storage } = createClient(fixture, { now: () => now });
			assert.strictEqual((await call(client, fixture)).status, 200);
			now += 90_000;
			assert.strictEqual((await call(client, fixture)).status, 200);
			const record = (await storage.get(fixture.resource))!;
			const secrets = new Set<string>();
			for (const token of fixture.as.issuedTokens.keys()) {
				secrets.add(token);
			}
			for (const request of fixture.as.tokenRequests) {
				for (const name of ['code', 'code_verifier', 'refresh_token', 'client_secret']) {
					if (request.body[name]) {
						secrets.add(request.body[name]);
					}
				}
				if (request.authorizationHeader) {
					secrets.add(request.authorizationHeader.substring(6));
				}
			}
			secrets.add(record.clientSecret!);
			secrets.add(record.refreshToken!);
			assert.ok(secrets.size >= 6, `collected ${secrets.size} secrets`);
			assert.ok(log.length >= 5, 'the flow logged something');
			for (const line of log) {
				for (const secret of secrets) {
					assert.ok(!line.includes(secret), `the log line '${line}' leaks '${secret}'`);
				}
			}
			assert.ok(log.some(line => line.includes('invalid_client') || line.includes('rejected the client ID metadata document')), 'the CIMD rejection was logged');
		});
	});
});
