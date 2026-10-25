/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../common/buffer.js';
import { IAuthorizationServerMetadata, OAuthClientError, OAuthClientErrorCode } from '../../common/oauth.js';
import { CLIENT_ASSERTION_TYPE_JWT_BEARER, createHeadlessRedirectAuthorize, InMemoryOAuthClientStorage, IOAuthClientOptions, IOAuthFetch, OAuthClient, OAuthGrant, parseOAuthChallenge, requestIdJag, resourceRequiresDpop, workloadIdentityJwtProblem } from '../../common/oauthClient.js';
import { OAuthDpopProver } from '../../common/oauthDpop.js';
import { generateSigningKeyPair, jwkThumbprint, publicJwkOf, sha256Base64Url } from '../../common/oauthJose.js';
import { createFixtureRouter, IFixtureRequest, IFixtureResponse, IFixtureRouter } from './oauthClientFixture.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

/**
 * The authorization extensions of MCP in {@link OAuthClient}: the client
 * credentials grant (`io.modelcontextprotocol/oauth-client-credentials`), the
 * JWT authorization grant of workload identity federation
 * (`io.modelcontextprotocol/auth/wif`) and of enterprise-managed authorization
 * (with {@link requestIdJag}), and DPoP-bound tokens
 * (`io.modelcontextprotocol/auth/dpop`, RFC 9449), against an in-memory
 * authorization server and MCP server that mirror the conformance suite's.
 */

const ISSUER = 'https://as.example.test';
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const RESOURCE = 'https://mcp.example.test/mcp';
const PRM_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
const REDIRECT_URI = 'http://127.0.0.1:33418/';

interface IDecodedJwt {
	readonly header: Record<string, unknown>;
	readonly claims: Record<string, unknown>;
}

function decodeJwt(jwt: string): IDecodedJwt {
	const [header, claims] = jwt.split('.');
	return { header: JSON.parse(decodeBase64(header).toString()), claims: JSON.parse(decodeBase64(claims).toString()) };
}

/** Verifies an ES256 JWS with the key of its own `jwk` header (a DPoP proof) or with `publicJwk`. */
async function verifyJwt(jwt: string, publicJwk?: JsonWebKey): Promise<IDecodedJwt> {
	const decoded = decodeJwt(jwt);
	const [header, claims, signature] = jwt.split('.');
	const key = await crypto.subtle.importKey('jwk', publicJwk ?? decoded.header.jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
	assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64(signature).buffer as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${header}.${claims}`) as Uint8Array<ArrayBuffer>), 'the JWS signature verifies');
	return decoded;
}

interface IServerOptions {
	/** Overrides of the authorization server metadata. */
	readonly metadata?: Partial<IAuthorizationServerMetadata>;
	/** The scheme the MCP server challenges with. */
	readonly challengeScheme?: 'Bearer' | 'DPoP';
	/** Issue DPoP-bound tokens for token requests with a proof (as a DPoP-capable server does). */
	readonly bindTokens?: boolean;
	/** Answer token requests here first; `undefined` falls back to issuing a token. */
	readonly token?: (request: IFixtureRequest, index: number) => IFixtureResponse | undefined;
	/** Answer MCP requests that carry a valid token here first. */
	readonly resource?: (request: IFixtureRequest) => IFixtureResponse | undefined;
}

interface IServers {
	readonly router: IFixtureRouter;
	readonly tokenRequests: IFixtureRequest[];
	readonly authorizationRequests: URLSearchParams[];
	readonly resourceRequests: IFixtureRequest[];
	/** The tokens issued, with the thumbprint they are bound to. */
	readonly issued: Map<string, string | undefined>;
}

function createServers(options: IServerOptions = {}): IServers {
	const router = createFixtureRouter();
	const tokenRequests: IFixtureRequest[] = [];
	const authorizationRequests: URLSearchParams[] = [];
	const resourceRequests: IFixtureRequest[] = [];
	const issued = new Map<string, string | undefined>();
	const metadata: IAuthorizationServerMetadata = {
		issuer: ISSUER,
		authorization_endpoint: `${ISSUER}/authorize`,
		token_endpoint: TOKEN_ENDPOINT,
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
		...options.metadata,
	};
	router.handle(ISSUER, async request => {
		if (request.method === 'GET' && request.url.pathname === '/.well-known/oauth-authorization-server') {
			return { status: 200, body: metadata };
		}
		if (request.method === 'GET' && request.url.pathname === '/authorize') {
			authorizationRequests.push(request.url.searchParams);
			const location = new URL(request.url.searchParams.get('redirect_uri')!);
			location.searchParams.set('code', 'the-code');
			location.searchParams.set('state', request.url.searchParams.get('state')!);
			return { status: 302, headers: { Location: location.toString() } };
		}
		if (request.method === 'POST' && request.url.pathname === '/token') {
			const index = tokenRequests.push(request) - 1;
			const answered = options.token?.(request, index);
			if (answered) {
				return answered;
			}
			const proof = request.headers.dpop;
			const thumbprint = proof && options.bindTokens ? await jwkThumbprint((await verifyJwt(proof)).header.jwk as JsonWebKey) : undefined;
			const token = `token-${index}`;
			issued.set(token, thumbprint);
			return { status: 200, body: { access_token: token, token_type: thumbprint ? 'DPoP' : 'Bearer', expires_in: 3600 } };
		}
		return undefined;
	});
	router.handle('https://mcp.example.test', async request => {
		if (request.method === 'GET' && request.url.pathname === '/.well-known/oauth-protected-resource/mcp') {
			return { status: 200, body: { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['mcp:read'] } };
		}
		if (request.url.pathname !== '/mcp') {
			return undefined;
		}
		resourceRequests.push(request);
		const scheme = options.challengeScheme ?? 'Bearer';
		const challenge = { status: 401, headers: { 'WWW-Authenticate': `${scheme} resource_metadata="${PRM_URL}"` }, body: { error: 'unauthorized' } };
		const match = /^(Bearer|DPoP) (.+)$/.exec(request.headers.authorization ?? '');
		if (!match || !issued.has(match[2])) {
			return challenge;
		}
		const bound = issued.get(match[2]);
		if (bound !== undefined) {
			const proof = request.headers.dpop;
			if (match[1] !== 'DPoP' || !proof) {
				return challenge;
			}
			const { header, claims } = await verifyJwt(proof);
			if (await jwkThumbprint(header.jwk as JsonWebKey) !== bound || claims.ath !== await sha256Base64Url(match[2]) || claims.htm !== request.method || claims.htu !== RESOURCE) {
				return challenge;
			}
		}
		return options.resource?.(request) ?? { status: 200, body: { result: {} } };
	});
	return { router, tokenRequests, authorizationRequests, resourceRequests, issued };
}

suite('OAuthClient: authorization extensions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createClient(fetchImpl: IOAuthFetch, overrides: Partial<IOAuthClientOptions> = {}): { readonly client: OAuthClient; readonly log: string[] } {
		const log: string[] = [];
		const client = store.add(new OAuthClient({
			clientName: 'VS Code Test',
			redirectUris: [REDIRECT_URI],
			registration: { preRegistered: { clientId: 'user-client' } },
			authorize: createHeadlessRedirectAuthorize(fetchImpl),
			fetch: fetchImpl,
			storage: new InMemoryOAuthClientStorage(),
			log: (level, message) => log.push(`${level}: ${message}`),
			...overrides,
		}));
		return { client, log };
	}

	function call(client: OAuthClient) {
		return client.fetchWithAuth(RESOURCE, RESOURCE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"method":"tools/list"}' });
	}

	async function expectClientError(promise: Promise<unknown>, code: OAuthClientErrorCode): Promise<OAuthClientError> {
		try {
			await promise;
		} catch (error) {
			assert.ok(error instanceof OAuthClientError, `expected an OAuthClientError '${code}', got ${String(error)}`);
			assert.strictEqual(error.code, code, error.message);
			return error;
		}
		assert.fail(`expected an OAuthClientError '${code}', but the promise resolved`);
	}

	function basicCredentials(request: IFixtureRequest): string | undefined {
		const header = request.headers.authorization;
		return header?.startsWith('Basic ') ? decodeBase64(header.substring(6)).toString() : undefined;
	}

	suite('client credentials', () => {
		const secretGrant: OAuthGrant = { kind: 'client_credentials', credentials: { clientId: 'machine', clientSecret: 's3cret' } };

		test('a client secret goes with client_secret_basic, and the token is for the resource and its scopes', async () => {
			const servers = createServers({ metadata: { grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['client_secret_basic'] } });
			const { client } = createClient(servers.router.fetch, { grant: secretGrant });
			assert.strictEqual((await call(client)).status, 200);
			assert.strictEqual(servers.tokenRequests.length, 1);
			const [request] = servers.tokenRequests;
			assert.deepStrictEqual({
				form: Object.fromEntries(request.form()),
				credentials: basicCredentials(request),
				authorizationRequests: servers.authorizationRequests.length,
			}, {
				form: { grant_type: 'client_credentials', resource: RESOURCE, scope: 'mcp:read', client_id: 'machine' },
				credentials: 'machine:s3cret',
				authorizationRequests: 0,
			});
		});

		test('a client secret goes in the body when the server only supports client_secret_post', async () => {
			const servers = createServers({ metadata: { token_endpoint_auth_methods_supported: ['client_secret_post'] } });
			const { client } = createClient(servers.router.fetch, { grant: secretGrant });
			assert.strictEqual((await call(client)).status, 200);
			const [request] = servers.tokenRequests;
			assert.deepStrictEqual([request.form().get('client_secret'), basicCredentials(request)], ['s3cret', undefined]);
		});

		test('private_key_jwt: a signed client assertion names the client, the issuer is its audience, and no client_id goes in the body', async () => {
			const { key, publicJwk } = await generateSigningKeyPair();
			const servers = createServers({ metadata: { token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['ES256'] } });
			const { client } = createClient(servers.router.fetch, { grant: { kind: 'client_credentials', credentials: { clientId: 'machine', privateKey: key, keyId: 'k1' } } });
			assert.strictEqual((await call(client)).status, 200);
			const form = servers.tokenRequests[0].form();
			const { header, claims } = await verifyJwt(form.get('client_assertion')!, publicJwk);
			assert.deepStrictEqual({
				type: form.get('client_assertion_type'),
				clientId: form.get('client_id'),
				header,
				claims: { ...claims, iat: typeof claims.iat, jti: typeof claims.jti, lifetime: (claims.exp as number) - (claims.iat as number) },
			}, {
				type: CLIENT_ASSERTION_TYPE_JWT_BEARER,
				clientId: null,
				header: { typ: 'JWT', kid: 'k1', alg: 'ES256' },
				claims: { iss: 'machine', sub: 'machine', aud: ISSUER, iat: 'number', exp: claims.exp, jti: 'string', lifetime: 300 },
			});
		});

		test('a server that does not offer what the machine client needs is refused before any token request', async () => {
			const { key } = await generateSigningKeyPair();
			const cases: { readonly metadata: Partial<IAuthorizationServerMetadata>; readonly grant: OAuthGrant }[] = [
				{ metadata: { grant_types_supported: ['authorization_code'] }, grant: secretGrant },
				{ metadata: { token_endpoint_auth_methods_supported: ['private_key_jwt'] }, grant: secretGrant },
				{ metadata: { token_endpoint_auth_methods_supported: ['client_secret_basic'] }, grant: { kind: 'client_credentials', credentials: { clientId: 'machine', privateKey: key } } },
				{ metadata: { token_endpoint_auth_signing_alg_values_supported: ['RS256'] }, grant: { kind: 'client_credentials', credentials: { clientId: 'machine', privateKey: key } } },
			];
			for (const { metadata, grant } of cases) {
				const servers = createServers({ metadata });
				const { client } = createClient(servers.router.fetch, { grant });
				await expectClientError(call(client), 'grant_unsupported');
				assert.strictEqual(servers.tokenRequests.length, 0, JSON.stringify(metadata));
			}
		});

		test('an authorization server without an authorization endpoint or PKCE serves a machine client', async () => {
			const servers = createServers({ metadata: { authorization_endpoint: undefined, code_challenge_methods_supported: undefined } });
			const { client } = createClient(servers.router.fetch, { grant: secretGrant });
			assert.strictEqual((await call(client)).status, 200);
			// The same server cannot serve a user's sign-in.
			const user = createClient(servers.router.fetch);
			await expectClientError(call(user.client), 'discovery_failed');
		});

		test('a rejected token is replaced by a new grant, without a refresh token', async () => {
			let rejectFirst = true;
			const servers = createServers({
				resource: () => {
					if (rejectFirst) {
						rejectFirst = false;
						return { status: 401, headers: { 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${PRM_URL}"` } };
					}
					return undefined;
				},
			});
			const { client } = createClient(servers.router.fetch, { grant: secretGrant });
			assert.strictEqual((await call(client)).status, 200);
			assert.deepStrictEqual(servers.tokenRequests.map(r => r.form().get('grant_type')), ['client_credentials', 'client_credentials']);
		});
	});

	test('private_key_jwt names the token endpoint as its audience when configured so', async () => {
		const { key, publicJwk } = await generateSigningKeyPair();
		const servers = createServers();
		const { client } = createClient(servers.router.fetch, { grant: { kind: 'client_credentials', credentials: { clientId: 'machine', privateKey: key, audience: 'token_endpoint' } } });
		assert.strictEqual((await call(client)).status, 200);
		assert.strictEqual((await verifyJwt(servers.tokenRequests[0].form().get('client_assertion')!, publicJwk)).claims.aud, TOKEN_ENDPOINT);
	});

	suite('JWT authorization grant', () => {
		test('workload identity: the JWT is the assertion, for the resource, without a client', async () => {
			const servers = createServers();
			const assertions: string[] = [];
			const { client } = createClient(servers.router.fetch, {
				grant: {
					kind: 'jwt_bearer', assertion: async request => {
						assertions.push(`${request.resource} ${request.scopes?.join(' ')}`);
						return 'workload.jwt.value';
					}
				},
			});
			assert.strictEqual((await call(client)).status, 200);
			const [request] = servers.tokenRequests;
			assert.deepStrictEqual({ form: Object.fromEntries(request.form()), authorization: request.headers.authorization, assertions }, {
				form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'workload.jwt.value', resource: RESOURCE, scope: 'mcp:read' },
				authorization: undefined,
				assertions: [`${RESOURCE} mcp:read`],
			});
		});

		test('a refused grant fails without a retry or another grant, and the refused JWT is not presented again', async () => {
			const servers = createServers({ token: () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'expired' } }) });
			const { client } = createClient(servers.router.fetch, { grant: { kind: 'jwt_bearer', assertion: async () => 'expired.jwt.value' } });
			const error = await expectClientError(call(client), 'token_request_failed');
			assert.match(error.message, /invalid_grant \(expired\)/);
			assert.strictEqual(servers.tokenRequests.length, 1);
			await expectClientError(call(client), 'token_request_failed');
			assert.strictEqual(servers.tokenRequests.length, 1, 'the same JWT is not sent again');
			assert.strictEqual(servers.authorizationRequests.length, 0, 'no fall back to the authorization code grant');
		});

		test('an ID-JAG is redeemed with the client of the resource authorization server', async () => {
			const servers = createServers({ metadata: { token_endpoint_auth_methods_supported: ['client_secret_basic'] } });
			const { client } = createClient(servers.router.fetch, {
				grant: { kind: 'jwt_bearer', assertion: async () => 'id.jag.value', client: { clientId: 'resource-client', clientSecret: 'resource-secret' } },
			});
			assert.strictEqual((await call(client)).status, 200);
			const [request] = servers.tokenRequests;
			assert.deepStrictEqual([request.form().get('assertion'), basicCredentials(request)], ['id.jag.value', 'resource-client:resource-secret']);
		});
	});

	suite('requestIdJag', () => {
		test('sends the token exchange of enterprise-managed authorization and returns the ID-JAG', async () => {
			const router = createFixtureRouter();
			const requests: IFixtureRequest[] = [];
			router.handle('https://idp.example.test', request => {
				requests.push(request);
				return { status: 200, body: { access_token: 'the.id.jag', issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', token_type: 'N_A' } };
			});
			const jag = await requestIdJag({
				tokenEndpoint: 'https://idp.example.test/token',
				client: { clientId: 'idp-client', clientSecret: 'idp-secret', tokenEndpointAuthMethod: 'client_secret_basic' },
				idToken: 'the.id.token',
				audience: ISSUER,
				resource: RESOURCE,
				scopes: ['mcp:read', 'mcp:write'],
				fetch: router.fetch,
			});
			assert.deepStrictEqual({ jag, form: Object.fromEntries(requests[0].form()), credentials: basicCredentials(requests[0]) }, {
				jag: 'the.id.jag',
				form: {
					client_id: 'idp-client',
					grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
					requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
					subject_token: 'the.id.token',
					subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
					audience: ISSUER,
					resource: RESOURCE,
					scope: 'mcp:read mcp:write',
				},
				credentials: 'idp-client:idp-secret',
			});
		});

		test('a refusal, or a token of another type, is a token_request_failed error', async () => {
			for (const response of [
				{ status: 400, body: { error: 'invalid_grant' } },
				{ status: 200, body: { access_token: 'an.access.token', issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' } },
			]) {
				const router = createFixtureRouter();
				router.handle('https://idp.example.test', () => response);
				await expectClientError(requestIdJag({ tokenEndpoint: 'https://idp.example.test/token', client: { clientId: 'c' }, idToken: 't', audience: ISSUER, fetch: router.fetch }), 'token_request_failed');
			}
		});
	});

	suite('DPoP', () => {
		const dpopMetadata: Partial<IAuthorizationServerMetadata> = { dpop_signing_alg_values_supported: ['ES256'] };

		test('a DPoP-bound refresh token is refreshed with a proof of its key, also when the request does not ask for DPoP', async () => {
			const prover = await OAuthDpopProver.generate();
			const servers = createServers({ metadata: dpopMetadata, bindTokens: true });
			const storage = new InMemoryOAuthClientStorage();
			await storage.set(RESOURCE, { issuer: ISSUER, registrationKind: 'pre-registered', clientId: 'user-client', tokenEndpointAuthMethod: 'none', refreshToken: 'bound-refresh', scopes: ['mcp:read'], tokenType: 'DPoP', dpopThumbprint: prover.thumbprint, authorizationRequests: 0 });
			const { client } = createClient(servers.router.fetch, { storage, dpop: prover });
			const metadata = await (await servers.router.fetch(`${ISSUER}/.well-known/oauth-authorization-server`, { method: 'GET' })).json() as IAuthorizationServerMetadata;
			const authorization = await client.acquireToken({ serverMetadata: metadata, resource: RESOURCE, scopes: ['mcp:read'] });
			const [request] = servers.tokenRequests;
			assert.deepStrictEqual({
				grant: request.form().get('grant_type'),
				proofKey: await jwkThumbprint((await verifyJwt(request.headers.dpop)).header.jwk as JsonWebKey),
				tokenType: authorization.tokenType,
				authorizationRequests: servers.authorizationRequests.length,
			}, { grant: 'refresh_token', proofKey: prover.thumbprint, tokenType: 'DPoP', authorizationRequests: 0 });
		});

		test('a server that challenges with DPoP gets a DPoP-bound token with the DPoP scheme and a fresh proof on each request', async () => {
			const servers = createServers({ metadata: dpopMetadata, challengeScheme: 'DPoP', bindTokens: true });
			const prover = await OAuthDpopProver.generate();
			const { client } = createClient(servers.router.fetch, { dpop: prover });
			assert.strictEqual((await call(client)).status, 200);
			assert.strictEqual((await call(client)).status, 200);

			const tokenProof = await verifyJwt(servers.tokenRequests[0].headers.dpop);
			const authorized = servers.resourceRequests.filter(r => r.headers.authorization);
			const proofs = await Promise.all(authorized.map(r => verifyJwt(r.headers.dpop)));
			assert.deepStrictEqual({
				dpopJkt: servers.authorizationRequests[0].get('dpop_jkt'),
				tokenProof: { htm: tokenProof.claims.htm, htu: tokenProof.claims.htu, ath: tokenProof.claims.ath },
				schemes: authorized.map(r => r.headers.authorization.split(' ')[0]),
				distinctJtis: new Set(proofs.map(p => p.claims.jti)).size,
				record: (await client.getAuthorization(RESOURCE))?.tokenType,
			}, {
				dpopJkt: prover.thumbprint,
				tokenProof: { htm: 'POST', htu: TOKEN_ENDPOINT, ath: undefined },
				schemes: ['DPoP', 'DPoP'],
				distinctJtis: 2,
				record: 'DPoP',
			});
		});

		test('no proof goes to a server that challenges with Bearer, or to an authorization server that does not advertise ES256', async () => {
			const cases: [IServerOptions, string][] = [
				[{ metadata: dpopMetadata, challengeScheme: 'Bearer', bindTokens: true }, 'a Bearer challenge'],
				[{ metadata: { dpop_signing_alg_values_supported: ['RS256'] }, challengeScheme: 'DPoP', bindTokens: true }, 'RS256 only'],
			];
			for (const [options, why] of cases) {
				const servers = createServers(options);
				const { client } = createClient(servers.router.fetch, { dpop: await OAuthDpopProver.generate() });
				assert.strictEqual((await call(client)).status, 200, why);
				assert.deepStrictEqual([servers.tokenRequests[0].headers.dpop, servers.authorizationRequests[0].has('dpop_jkt'), (await client.getAuthorization(RESOURCE))?.tokenType], [undefined, false, 'Bearer'], why);
			}
		});

		test('the token endpoint\'s use_dpop_nonce is answered once with its nonce', async () => {
			const servers = createServers({
				metadata: dpopMetadata, challengeScheme: 'DPoP', bindTokens: true,
				token: (request, index) => index === 0 ? { status: 400, headers: { 'DPoP-Nonce': 'as-nonce' }, body: { error: 'use_dpop_nonce' } } : undefined,
			});
			const { client } = createClient(servers.router.fetch, { dpop: await OAuthDpopProver.generate() });
			assert.strictEqual((await call(client)).status, 200);
			const nonces = await Promise.all(servers.tokenRequests.map(async r => (await verifyJwt(r.headers.dpop)).claims.nonce));
			assert.deepStrictEqual(nonces, [undefined, 'as-nonce']);

			// A server that keeps asking is not asked a third time.
			const insisting = createServers({ metadata: dpopMetadata, challengeScheme: 'DPoP', token: () => ({ status: 400, headers: { 'DPoP-Nonce': 'again' }, body: { error: 'use_dpop_nonce' } }) });
			const second = createClient(insisting.router.fetch, { dpop: await OAuthDpopProver.generate() });
			await expectClientError(call(second.client), 'token_request_failed');
			assert.strictEqual(insisting.tokenRequests.length, 2);
		});

		test('the MCP server\'s use_dpop_nonce is answered with its nonce and the same token', async () => {
			let challenged = false;
			const servers = createServers({
				metadata: dpopMetadata, challengeScheme: 'DPoP', bindTokens: true,
				resource: request => {
					if (!challenged) {
						challenged = true;
						return { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce' } };
					}
					return undefined;
				},
			});
			const { client } = createClient(servers.router.fetch, { dpop: await OAuthDpopProver.generate() });
			assert.strictEqual((await call(client)).status, 200);
			const authorized = servers.resourceRequests.filter(r => r.headers.authorization);
			const proofs = await Promise.all(authorized.map(r => verifyJwt(r.headers.dpop)));
			assert.deepStrictEqual({
				tokens: new Set(authorized.map(r => r.headers.authorization)).size,
				nonces: proofs.map(p => p.claims.nonce),
				tokenRequests: servers.tokenRequests.length,
			}, { tokens: 1, nonces: [undefined, 'rs-nonce'], tokenRequests: 1 });
		});

		test('a token of a DPoP request is refused as DPoP without a proof, and tokens of another key are not used', async () => {
			// A server that issues a DPoP token type for a request without a proof.
			const servers = createServers({ token: () => ({ status: 200, body: { access_token: 'x', token_type: 'DPoP' } }) });
			await expectClientError(call(createClient(servers.router.fetch).client), 'token_request_failed');

			const storage = new InMemoryOAuthClientStorage();
			await storage.set(RESOURCE, { issuer: ISSUER, registrationKind: 'pre-registered', clientId: 'user-client', tokenEndpointAuthMethod: 'none', accessToken: 'old-token', tokenType: 'DPoP', dpopThumbprint: 'another-key', authorizationRequests: 0 });
			const bound = createServers({ metadata: dpopMetadata, challengeScheme: 'DPoP', bindTokens: true });
			const { client } = createClient(bound.router.fetch, { storage, dpop: await OAuthDpopProver.generate() });
			assert.strictEqual(await client.getAuthorization(RESOURCE), undefined);
			assert.strictEqual((await call(client)).status, 200);
			assert.ok(bound.resourceRequests.every(r => !r.headers.authorization?.includes('old-token')));
		});
	});

	test('parseOAuthChallenge reads the DPoP scheme; resourceRequiresDpop only when no bearer token is accepted', () => {
		const both = `Bearer resource_metadata="${PRM_URL}", DPoP error="use_dpop_nonce", algs="ES256"`;
		assert.deepStrictEqual([parseOAuthChallenge(both)?.scheme, parseOAuthChallenge(both, 'DPoP')?.error, parseOAuthChallenge(`DPoP resource_metadata="${PRM_URL}"`)?.resourceMetadataUrl], ['Bearer', 'use_dpop_nonce', PRM_URL]);
		assert.deepStrictEqual([
			resourceRequiresDpop(`DPoP resource_metadata="${PRM_URL}"`, undefined),
			// A server that takes either is served a bearer token, which every client of the session can present.
			resourceRequiresDpop(both, undefined),
			resourceRequiresDpop(`Bearer resource_metadata="${PRM_URL}"`, undefined),
			resourceRequiresDpop(both, { resource: RESOURCE, dpop_bound_access_tokens_required: true }),
			resourceRequiresDpop(undefined, { resource: RESOURCE }),
		], [true, false, false, true, false]);
	});

	test('workloadIdentityJwtProblem lets only an unexpired, signed JWT for this authorization server leave the machine', () => {
		const now = 1_700_000_000_000;
		const segment = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const jwt = (header: object, claims: object) => `${segment(header)}.${segment(claims)}.c2lnbmF0dXJl`;
		const metadata = { issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT };
		const exp = now / 1000 + 600;
		assert.deepStrictEqual([
			workloadIdentityJwtProblem(jwt({ alg: 'RS256' }, { aud: TOKEN_ENDPOINT, exp }), metadata, now),
			workloadIdentityJwtProblem(jwt({ alg: 'ES256' }, { aud: [`${ISSUER}/`, 'other'], exp }), metadata, now),
			workloadIdentityJwtProblem('[default]\naws_secret_access_key = abc', metadata, now),
			workloadIdentityJwtProblem(jwt({ alg: 'none' }, { aud: TOKEN_ENDPOINT, exp }), metadata, now),
			workloadIdentityJwtProblem(jwt({ alg: 'RS256' }, { aud: 'https://other.example.test/token', exp }), metadata, now),
			workloadIdentityJwtProblem(jwt({ alg: 'RS256' }, { aud: TOKEN_ENDPOINT, exp: now / 1000 - 3600 }), metadata, now),
			workloadIdentityJwtProblem(jwt({ alg: 'RS256' }, { aud: TOKEN_ENDPOINT }), metadata, now),
		], [
			undefined,
			undefined,
			'it is not a JWT in the compact serialization',
			'it is not signed',
			`its audience is not the authorization server ${ISSUER}`,
			'it has expired',
			'it has no expiration time',
		]);
	});

	test('publicJwkOf of a prover\'s key is the jwk of its proofs', async () => {
		const prover = await OAuthDpopProver.generate();
		const { header } = await verifyJwt(await prover.createProof('POST', RESOURCE));
		assert.deepStrictEqual(header.jwk, publicJwkOf(prover.privateJwk));
	});
});
