/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { FileAccess } from '../../../../base/common/network.js';
import { OAuthClientError } from '../../../../base/common/oauth.js';
import { IOAuthFetchResponse, OAuthClient } from '../../../../base/common/oauthClient.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { bearerChallenge, createAuthorizationServerFixture, createFixtureRouter, createOAuthFixture, createResourceServerFixture, IFixtureRequest, IOAuthFixture } from '../../../../base/test/common/oauthClientFixture.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { IMcpAuthenticationDetails } from '../../common/extHost.protocol.js';
import { CommonRequestInit, CommonResponse, McpHTTPHandle } from '../../common/extHostMcp.js';
import { MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS, MCP_OAUTH_MAX_CHALLENGE_CYCLES, mcpOAuthClientOptions, resolveMcpOAuthPolicy } from '../../common/mcpOAuthClientFactory.js';
import { CONFORMANCE_CLIENT_METADATA_URL, CONFORMANCE_LAUNCH_OAUTH, conformanceGrantFor, createConformanceOAuthClient, createConformanceTokenSource } from '../../node/mcpConformanceOAuth.js';
import { ConformanceMainThreadMcp, parseConformanceContext } from '../../node/mcpConformanceProxy.js';

/** The transport's private request path, which these tests drive directly. */
interface IHandleInternals {
	_fetchWithAuthRetry(mcpUrl: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array<ArrayBuffer> }, headers: Record<string, string>): Promise<CommonResponse>;
}

function toCommonResponse(url: string, response: IOAuthFetchResponse): CommonResponse {
	const headers = new Headers();
	for (const name of ['www-authenticate', 'content-type', 'location']) {
		const value = response.headers.get(name);
		if (value !== null) {
			headers.set(name, value);
		}
	}
	return { status: response.status, statusText: response.statusText ?? '', headers, body: null, url, json: () => response.json(), text: () => response.text() };
}

suite('MCP conformance - OAuth client', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createClient(fixture: Pick<IOAuthFixture, 'fetch'>, contextJson?: string, log?: string[]): OAuthClient {
		return store.add(createConformanceOAuthClient({
			context: parseConformanceContext(contextJson),
			fetch: fixture.fetch,
			protocolVersion: '2026-07-28',
			log: log ? (level, message) => log.push(`${level}: ${message}`) : undefined,
		}));
	}

	/** Drives the extension-host transport against the fixture with the conformance token source behind its main thread. */
	function createTransport(fixture: IOAuthFixture, client: OAuthClient) {
		const proxy = store.add(new ConformanceMainThreadMcp());
		proxy.tokenSource = createConformanceTokenSource(client);
		const handle = store.add(new class extends McpHTTPHandle {
			protected override async _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
				return toCommonResponse(url, await fixture.fetch(url, { method: init?.method, headers: init?.headers, body: init?.body ? new TextDecoder().decode(init.body) : undefined }));
			}
		}(1, { type: McpServerTransportType.HTTP, uri: URI.parse(fixture.resource), headers: [], oauth: CONFORMANCE_LAUNCH_OAUTH }, proxy, new NullLogService(), true));
		const request = (body: object = { jsonrpc: '2.0', id: 1, method: 'tools/list' }): Promise<CommonResponse> => {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			return (handle as unknown as IHandleInternals)._fetchWithAuthRetry(fixture.resource, { method: 'POST', headers, body: new TextEncoder().encode(JSON.stringify(body)) as Uint8Array<ArrayBuffer> }, headers);
		};
		return { proxy, handle, request };
	}

	function details(fixture: IOAuthFixture, overrides: Partial<IMcpAuthenticationDetails> = {}): IMcpAuthenticationDetails {
		return {
			authorizationServer: URI.parse(fixture.issuer).toJSON(),
			authorizationServerMetadata: fixture.as.metadata(),
			resourceMetadata: fixture.rs.metadata(),
			scopes: undefined,
			resource: fixture.resource,
			...overrides,
		};
	}

	test('authorizes through the transport: discovery, registration, PKCE, resource indicator', async () => {
		const fixture = createOAuthFixture({ rs: { trapRootPrm: true } });
		const { request } = createTransport(fixture, createClient(fixture));
		assert.strictEqual((await request()).status, 200);
		assert.deepStrictEqual({
			registrations: fixture.as.registrations.map(r => [r.application_type, r.token_endpoint_auth_method]),
			authorizations: fixture.as.authorizationRequests.map(r => [r.query.code_challenge_method, r.query.resource]),
			tokens: fixture.as.tokenRequests.map(r => [r.body.grant_type, r.body.resource, typeof r.body.code_verifier]),
			violations: [...fixture.as.violations, ...fixture.rs.violations],
		}, {
			registrations: [['native', 'none']],
			authorizations: [['S256', fixture.resource]],
			tokens: [['authorization_code', fixture.resource, 'string']],
			violations: [],
		});
	});

	test('uses the client ID metadata document URL the suite expects when the server supports it', async () => {
		const fixture = createOAuthFixture({ as: { clientIdMetadataDocumentSupported: true } });
		const { request } = createTransport(fixture, createClient(fixture));
		assert.strictEqual((await request()).status, 200);
		assert.deepStrictEqual(fixture.as.authorizationRequests.map(r => r.query.client_id), [CONFORMANCE_CLIENT_METADATA_URL]);
		assert.deepStrictEqual(fixture.as.registrations, []);
	});

	test('uses the pre-registered credentials of the scenario context with the supported authentication method', async () => {
		const fixture = createOAuthFixture({
			as: {
				disableDynamicRegistration: true,
				tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
				clients: { 'pre-registered-client': { clientSecret: 'pre-registered-secret', tokenEndpointAuthMethod: 'client_secret_basic' } },
				requireKnownClient: true,
			},
		});
		const log: string[] = [];
		const { request } = createTransport(fixture, createClient(fixture, JSON.stringify({ client_id: 'pre-registered-client', client_secret: 'pre-registered-secret' }), log));
		assert.strictEqual((await request()).status, 200);
		assert.deepStrictEqual(fixture.as.tokenRequests.map(r => [r.authMethod, r.clientId]), [['client_secret_basic', 'pre-registered-client']]);
		// The OAuth client's log carries no credential.
		const secrets = ['pre-registered-secret', ...fixture.as.issuedTokens.keys()];
		assert.ok(log.length > 0);
		assert.deepStrictEqual(secrets.filter(secret => log.some(line => line.includes(secret))), []);
	});

	test('allows plain-HTTP scenario servers but still requires PKCE', async () => {
		const insecure = createOAuthFixture({ as: { insecureEndpoints: true } });
		assert.strictEqual((await createTransport(insecure, createClient(insecure)).request()).status, 200);

		const noPkce = createOAuthFixture({ as: { codeChallengeMethodsSupported: null } });
		await assert.rejects(createTransport(noPkce, createClient(noPkce)).request(), (error: unknown) => error instanceof OAuthClientError && error.code === 'pkce_unsupported');
		assert.deepStrictEqual(noPkce.as.authorizationRequests, []);
	});

	test('requests offline_access only when the authorization server lists it', async () => {
		const listed = createOAuthFixture({ as: { scopesSupported: ['mcp:basic', 'offline_access'] }, rs: { scopesSupported: ['mcp:basic'] } });
		await createTransport(listed, createClient(listed)).request();
		const unlisted = createOAuthFixture({ as: { scopesSupported: ['mcp:basic', 'mcp:read'] }, rs: { scopesSupported: ['mcp:basic', 'mcp:read'] } });
		await createTransport(unlisted, createClient(unlisted)).request();
		assert.deepStrictEqual([listed, unlisted].map(f => f.as.authorizationRequests.map(r => r.query.scope)), [['mcp:basic offline_access'], ['mcp:basic mcp:read']]);
	});

	test('re-registers with the new authorization server when the resource moves', async () => {
		let moved = false;
		const router = createOAuthFixture().router;
		const as1 = createAuthorizationServerFixture(router, { issuer: 'https://as1.example.test', tokenPrefix: 'as1' });
		const as2 = createAuthorizationServerFixture(router, { issuer: 'https://as2.example.test', tokenPrefix: 'as2' });
		const rs = createResourceServerFixture(router, {
			resource: 'https://migrating.example.test/mcp',
			authorizationServers: () => [moved ? as2.issuer : as1.issuer],
			verifyToken: token => moved ? as2.verifyToken(token) : as1.verifyToken(token),
		});
		const fixture: IOAuthFixture = { fetch: router.fetch, requests: router.requests, issuer: as1.issuer, resource: rs.resource, router, as: as1, rs };
		const { request } = createTransport(fixture, createClient(fixture));
		assert.strictEqual((await request()).status, 200);
		moved = true;
		assert.strictEqual((await request()).status, 200);
		assert.deepStrictEqual({
			as1Clients: as1.registeredClientIds.length,
			as2Clients: as2.registeredClientIds.length,
			reusedAtAs2: as2.authorizationRequests.some(r => as1.registeredClientIds.includes(r.query.client_id)),
		}, { as1Clients: 1, as2Clients: 1, reusedAtAs2: false });
	});

	test('a repeated insufficient_scope for scopes just granted ends the scenario without another authorization request', async () => {
		const fixture = createOAuthFixture({
			rs: {
				scopesSupported: ['mcp:admin'],
				scopeInWwwAuthenticate: true,
				authorize: context => context.accessToken === undefined
					? { status: 401, headers: { 'WWW-Authenticate': bearerChallenge({ scope: 'mcp:admin', resource_metadata: context.metadataUrl }) } }
					: { status: 403, headers: { 'WWW-Authenticate': bearerChallenge({ error: 'insufficient_scope', scope: 'mcp:admin', resource_metadata: context.metadataUrl }) } },
			},
		});
		await assert.rejects(createTransport(fixture, createClient(fixture)).request(), (error: unknown) => error instanceof OAuthClientError && error.code === 'step_up_limit');
		assert.strictEqual(fixture.as.authorizationRequests.length, 1);
	});

	test('the token source names the rejected token and forwards a forced re-registration', async () => {
		const fixture = createOAuthFixture();
		const source = createConformanceTokenSource(createClient(fixture));
		const first = await source.getToken(details(fixture), undefined);
		const second = await source.getToken(details(fixture), { rejectedToken: first });
		const third = await source.getToken(details(fixture), { rejectedToken: second, forceNewRegistration: true });
		assert.ok(first && second && third && new Set([first, second, third]).size === 3);
		assert.strictEqual(fixture.as.registeredClientIds.length, 2, 'the forced re-registration registered a second client');
		await assert.rejects(source.getToken(details(fixture, { resource: undefined, resourceMetadata: undefined }), undefined), /no protected resource/);
	});
});

suite('MCP OAuth rule set', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every MCP OAuth client gets the specification limits, offline_access only when listed, and the server policy', () => {
		const options = mcpOAuthClientOptions({
			clientName: 'x',
			redirectUris: ['http://127.0.0.1/'],
			registration: {},
			authorize: () => Promise.reject(new Error('unused')),
			policy: resolveMcpOAuthPolicy({ pkce: 'assume-supported' }, { allowInsecureHttp: true }),
		});
		assert.deepStrictEqual({
			maxChallengesPerRequest: options.maxChallengesPerRequest,
			maxAuthorizationRequests: options.maxAuthorizationRequests,
			requestOfflineAccess: options.requestOfflineAccess,
			pkce: options.pkce,
			allowInsecureHttp: options.allowInsecureHttp,
			legacyDefaultEndpoints: options.legacyDefaultEndpoints,
		}, { maxChallengesPerRequest: MCP_OAUTH_MAX_CHALLENGE_CYCLES, maxAuthorizationRequests: MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS, requestOfflineAccess: true, pkce: 'assume-supported', allowInsecureHttp: true, legacyDefaultEndpoints: false });
		assert.deepStrictEqual([MCP_OAUTH_MAX_CHALLENGE_CYCLES, MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS], [3, 3]);
		assert.deepStrictEqual(resolveMcpOAuthPolicy(undefined), { pkce: 'require-advertised', allowInsecureHttp: false, authorizationServer: undefined, grant: 'authorization_code', dpop: undefined });
		assert.deepStrictEqual(resolveMcpOAuthPolicy({ grant: 'workload_identity', dpop: false }), { pkce: 'require-advertised', allowInsecureHttp: false, authorizationServer: undefined, grant: 'workload_identity', dpop: false });
	});

	test('the scenarios of the authorization extensions run the grant of a machine client from their context; every other scenario the user\'s', async () => {
		const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
		const pem = `-----BEGIN PRIVATE KEY-----\n${encodeBase64(VSBuffer.wrap(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))))}\n-----END PRIVATE KEY-----`;
		const idp: IFixtureRequest[] = [];
		const router = createFixtureRouter();
		router.handle('http://localhost:9001', request => {
			idp.push(request);
			return { status: 200, body: { access_token: 'the.id.jag', issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', token_type: 'N_A' } };
		});
		const grant = (scenario: string, context: object) => conformanceGrantFor(scenario, parseConformanceContext(JSON.stringify({ name: scenario, ...context })), router.fetch);
		const serverMetadata = { issuer: 'http://localhost:9002', response_types_supported: ['code'] };

		const jwt = await grant('auth/client-credentials-jwt', { client_id: 'c', private_key_pem: pem, signing_algorithm: 'ES256' });
		const basic = await grant('auth/client-credentials-basic', { client_id: 'c', client_secret: 's' });
		const preRegistration = await grant('auth/pre-registration', { client_id: 'c', client_secret: 's' });
		const wif = await grant('auth/wif-jwt-bearer', { client_id: 'w', valid_jwt: 'workload.jwt', expired_jwt: 'old.jwt' });
		const ema = await grant('auth/enterprise-managed-authorization', { client_id: 'rc', client_secret: 'rs', idp_client_id: 'ic', idp_id_token: 'id.token', idp_issuer: 'http://localhost:9001', idp_token_endpoint: 'http://localhost:9001/token' });
		assert.ok(jwt?.kind === 'client_credentials' && jwt.credentials.privateKey !== undefined && jwt.credentials.clientId === 'c');
		assert.deepStrictEqual([basic, preRegistration, await grant('tools_call', {})], [{ kind: 'client_credentials', credentials: { clientId: 'c', clientSecret: 's' } }, undefined, undefined]);
		assert.ok(wif?.kind === 'jwt_bearer' && wif.client === undefined);
		assert.strictEqual(await wif.assertion({ serverMetadata, resource: 'http://localhost:9003/mcp' }, CancellationToken.None), 'workload.jwt');
		assert.ok(ema?.kind === 'jwt_bearer');
		assert.deepStrictEqual(ema.client, { clientId: 'rc', clientSecret: 'rs' });
		assert.strictEqual(await ema.assertion({ serverMetadata, resource: 'http://localhost:9003/mcp', scopes: ['a'] }, CancellationToken.None), 'the.id.jag');
		const form = idp[0].form();
		assert.deepStrictEqual([form.get('subject_token'), form.get('audience'), form.get('resource'), form.get('client_id'), form.get('scope')], ['id.token', 'http://localhost:9002', 'http://localhost:9003/mcp', 'ic', 'a']);
		await assert.rejects(grant('auth/client-credentials-jwt', { client_id: 'c', private_key_pem: pem, signing_algorithm: 'HS256' }), /HS256 of the scenario is not supported/);
	});

	test('the conformance client, the transport and the main thread share one factory and rule set', async () => {
		const root = join(FileAccess.asFileUri('').fsPath, '..', 'src', 'vs', 'workbench', 'api');
		const read = (...segments: string[]) => fs.readFile(join(root, ...segments), 'utf8');
		const [conformance, transport, mainThread] = await Promise.all([read('node', 'mcpConformanceOAuth.ts'), read('common', 'extHostMcp.ts'), read('browser', 'mainThreadMcp.ts')]);
		const factoryImport = /import \{([^}]*)\} from '(?:\.\.\/common|\.)\/mcpOAuthClientFactory\.js';/;
		const imported = (source: string) => (factoryImport.exec(source)?.[1] ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
		assert.ok(imported(conformance).includes('createMcpOAuthClient'), 'the conformance client builds its OAuth client with the factory');
		assert.ok(imported(transport).includes('createMcpOAuthClient'), 'the transport discovers with the factory');
		assert.ok(imported(transport).includes('resolveMcpOAuthPolicy') && imported(mainThread).includes('resolveMcpOAuthPolicy'), 'the transport and the main thread read the same server policy');
		assert.ok(imported(mainThread).includes('selectMcpAuthorizationScopes'), 'the main thread selects scopes with the shared rule');
		assert.ok(!/new OAuthClient\(/.test(conformance) && !/new OAuthClient\(/.test(transport), 'no OAuth client is built around the factory');
	});
});
