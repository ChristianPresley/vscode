/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { IAuthorizationServerMetadata, OAuthClientError } from '../../../../base/common/oauth.js';
import { OAuthDpopProver } from '../../../../base/common/oauthDpop.js';
import { jwkThumbprint, publicJwkOf, sha256Base64Url } from '../../../../base/common/oauthJose.js';
import { URI } from '../../../../base/common/uri.js';
import { createFixtureRouter, IFixtureRequest, IFixtureResponse } from '../../../../base/test/common/oauthClientFixture.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ILogService, LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { McpServerTransportHTTP, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { IMcpAccessTokenBinding, IMcpAuthenticationDetails, MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { CommonRequestInit, CommonResponse, IMcpAuthHeaderProviderHost, McpAuthHeaderProvider, McpHTTPHandle } from '../../common/extHostMcp.js';

/**
 * The authorization extensions in the transport's {@link McpAuthHeaderProvider}:
 * DPoP-bound tokens of the main thread (RFC 9449) and the grants of a machine
 * client (`oauth.grant`), which it runs itself.
 */

const ISSUER = 'https://as.example.test';
const OTHER_ISSUER = 'https://other-as.example.test';
const RESOURCE = 'https://mcp.example.test/mcp';
const PRM_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
const RESPONSE_HEADERS = ['www-authenticate', 'content-type', 'location', 'dpop-nonce'];

function decodeJwt(jwt: string): { readonly header: Record<string, unknown>; readonly claims: Record<string, unknown> } {
	const [header, claims] = jwt.split('.');
	return { header: JSON.parse(decodeBase64(header).toString()), claims: JSON.parse(decodeBase64(claims).toString()) };
}

async function verifyProof(proof: string): Promise<{ readonly header: Record<string, unknown>; readonly claims: Record<string, unknown> }> {
	const [header, claims, signature] = proof.split('.');
	const decoded = decodeJwt(proof);
	const key = await crypto.subtle.importKey('jwk', decoded.header.jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
	assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64(signature).buffer as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${header}.${claims}`) as Uint8Array<ArrayBuffer>), 'the proof verifies with its jwk');
	return decoded;
}

async function pkcs8Pem(): Promise<string> {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
	const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	return `-----BEGIN PRIVATE KEY-----\n${encodeBase64(VSBuffer.wrap(der))}\n-----END PRIVATE KEY-----\n`;
}

/** A structurally valid workload identity JWT for the authorization server (the client does not verify its signature). */
function workloadJwt(id: string, claims: Record<string, unknown> = {}): string {
	const segment = (value: unknown) => encodeBase64(VSBuffer.fromString(JSON.stringify(value)), false, true);
	return `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment({ iss: 'https://platform.example.test', sub: 'workload', aud: `${ISSUER}/token`, exp: Math.floor(Date.now() / 1000) + 600, jti: id, ...claims })}.c2lnbmF0dXJl`;
}

function toCommonResponse(url: string, response: { readonly status: number; readonly headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }): CommonResponse {
	const headers = new Headers();
	for (const name of RESPONSE_HEADERS) {
		const value = response.headers.get(name);
		if (value !== null) {
			headers.set(name, value);
		}
	}
	return { status: response.status, statusText: '', headers, body: null, url, json: () => response.json(), text: () => response.text() };
}

interface IHarnessOptions {
	readonly oauth?: McpServerTransportHTTP['oauth'];
	readonly metadata?: Partial<IAuthorizationServerMetadata>;
	readonly binding?: (token: string) => IMcpAccessTokenBinding | undefined;
	readonly clientSecret?: string;
	readonly files?: Record<string, string>;
	readonly token?: (request: IFixtureRequest) => IFixtureResponse | undefined;
	/** The token the main thread returns each time; `user-<n>` by default. */
	readonly userToken?: string;
	/** The `authorization_servers` of the protected resource metadata, read at each discovery; the issuer by default. */
	readonly authorizationServers?: () => string[];
	/** Fails each token request of a machine client as a network error would. */
	readonly tokenFetchError?: Error;
}

suite('McpAuthHeaderProvider: authorization extensions', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness(options: IHarnessOptions = {}) {
		const router = createFixtureRouter();
		const tokenRequests: IFixtureRequest[] = [];
		const mainThreadCalls: IMcpAuthenticationDetails[] = [];
		const secretRequests: string[] = [];
		const fileReads: string[] = [];
		for (const issuer of [ISSUER, OTHER_ISSUER]) {
			router.handle(issuer, request => {
				if (request.url.pathname === '/.well-known/oauth-authorization-server') {
					return { status: 200, body: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], ...options.metadata } };
				}
				if (request.url.pathname === '/token') {
					tokenRequests.push(request);
					return options.token?.(request) ?? { status: 200, body: { access_token: `machine-${tokenRequests.length}`, token_type: request.headers.dpop ? 'DPoP' : 'Bearer', expires_in: 3600 } };
				}
				return undefined;
			});
		}
		router.handle('https://mcp.example.test', request => request.url.pathname === '/.well-known/oauth-protected-resource/mcp'
			? { status: 200, body: { resource: RESOURCE, authorization_servers: options.authorizationServers?.() ?? [ISSUER] } }
			: undefined);
		const proxy: IMcpAuthHeaderProviderHost['proxy'] = {
			async $getTokenFromServerMetadata(_id, details) {
				mainThreadCalls.push(details);
				return options.userToken ?? `user-${mainThreadCalls.length}`;
			},
			async $getTokenForProviderId() { return undefined; },
			$onDidChangeState() { },
			$logMcpAuthSetup() { },
			$getAccessTokenBinding: options.binding ? async (_id, token) => options.binding!(token) : undefined,
			async $getMcpOAuthClientSecret(_id, clientId, issuer) {
				secretRequests.push(`${clientId}@${issuer}`);
				return options.clientSecret;
			},
		};
		const provider = store.add(new McpAuthHeaderProvider({
			id: 1,
			launch: { uri: URI.parse(RESOURCE), headers: [], oauth: options.oauth },
			proxy,
			protocolVersion: () => '2026-07-28',
			fetchMetadata: async (url, init): Promise<CommonResponse> => toCommonResponse(url, await router.fetch(url, { method: init.method, headers: init.headers, body: init.body && new TextDecoder().decode(init.body) })),
			fetchToken: async (url, init): Promise<CommonResponse> => {
				if (options.tokenFetchError) {
					throw options.tokenFetchError;
				}
				return toCommonResponse(url, await router.fetch(url, { method: init.method, headers: init.headers, body: init.body && new TextDecoder().decode(init.body) }));
			},
			log: () => { },
			stepUps: new Map(),
			readFile: async path => {
				fileReads.push(path);
				const content = options.files?.[path];
				if (content === undefined) {
					throw new Error(`ENOENT: ${path}`);
				}
				return content;
			},
		}));
		return { provider, tokenRequests, mainThreadCalls, secretRequests, fileReads };
	}

	async function expectOAuthError(promise: Promise<unknown>, code: string): Promise<OAuthClientError> {
		let caught: unknown;
		try {
			await promise;
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof OAuthClientError, `expected an OAuthClientError, got ${String(caught)}`);
		assert.strictEqual(caught.code, code, caught.message);
		return caught;
	}

	suite('DPoP', () => {
		test('a token the main thread binds to a DPoP key goes with the DPoP scheme, and each request gets a fresh proof for its method and URL', async () => {
			const prover = await OAuthDpopProver.generate();
			const { provider, mainThreadCalls } = createHarness({ binding: token => token === 'user-1' ? { dpopKey: prover.privateJwk } : undefined });
			const headers: Record<string, string> = {};
			assert.strictEqual(await provider.handleChallenge(401, `DPoP resource_metadata="${PRM_URL}"`, headers), true);
			assert.deepStrictEqual([headers.Authorization, mainThreadCalls[0].dpop], ['DPoP user-1', true]);

			await provider.addDpopProof(headers, 'POST', `${RESOURCE}?x=1`);
			const first = await verifyProof(headers.DPoP);
			await provider.addDpopProof(headers, 'GET', RESOURCE);
			const second = await verifyProof(headers.DPoP);
			assert.deepStrictEqual({
				thumbprint: await jwkThumbprint(first.header.jwk as JsonWebKey),
				first: { htm: first.claims.htm, htu: first.claims.htu, ath: first.claims.ath },
				second: { htm: second.claims.htm },
				fresh: first.claims.jti !== second.claims.jti,
			}, {
				thumbprint: prover.thumbprint,
				first: { htm: 'POST', htu: RESOURCE, ath: await sha256Base64Url('user-1') },
				second: { htm: 'GET' },
				fresh: true,
			});
		});

		test('a bearer token gets no proof, and a stale proof is removed', async () => {
			const { provider, mainThreadCalls } = createHarness({ binding: () => undefined });
			const headers: Record<string, string> = { DPoP: 'stale' };
			assert.ok(await provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, headers));
			await provider.addDpopProof(headers, 'POST', RESOURCE);
			assert.deepStrictEqual([headers.Authorization, headers.DPoP, mainThreadCalls[0].dpop], ['Bearer user-1', undefined, undefined]);
		});

		test('the binding of a token is looked up once, also when it is a bearer token', async () => {
			const lookups: string[] = [];
			const { provider } = createHarness({ userToken: 'same-token', binding: token => { lookups.push(token); return undefined; } });
			const headers: Record<string, string> = {};
			await provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, headers);
			for (let i = 0; i < 3; i++) {
				await provider.addAuthHeader({});
			}
			assert.deepStrictEqual([headers.Authorization, lookups], ['Bearer same-token', ['same-token']]);
		});

		test('oauth.dpop asks for a DPoP-bound token always (true) or never (false), whatever the server signals', async () => {
			const always = createHarness({ oauth: { dpop: true } as McpServerTransportHTTP['oauth'] });
			assert.ok(await always.provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, {}));
			const never = createHarness({ oauth: { dpop: false } as McpServerTransportHTTP['oauth'] });
			assert.ok(await never.provider.handleChallenge(401, `DPoP resource_metadata="${PRM_URL}"`, {}));
			assert.deepStrictEqual([always.mainThreadCalls[0].dpop, never.mainThreadCalls[0].dpop], [true, undefined]);
		});

		test('use_dpop_nonce sends the request again with the same token, and the next proof carries the nonce', async () => {
			const prover = await OAuthDpopProver.generate();
			const { provider, mainThreadCalls } = createHarness({ binding: () => ({ dpopKey: prover.privateJwk }) });
			const headers: Record<string, string> = {};
			await provider.handleChallenge(401, `DPoP resource_metadata="${PRM_URL}"`, headers);
			provider.observeResponse(RESOURCE, headers, new Headers({ 'DPoP-Nonce': 'rs-nonce' }));
			assert.strictEqual(await provider.handleChallenge(401, 'DPoP error="use_dpop_nonce"', headers, undefined, 'rs-nonce'), true);
			await provider.addDpopProof(headers, 'POST', RESOURCE);
			assert.deepStrictEqual([headers.Authorization, (await verifyProof(headers.DPoP)).claims.nonce, mainThreadCalls.length], ['DPoP user-1', 'rs-nonce', 1]);
		});
	});

	suite('machine clients', () => {
		test('client_credentials: the transport runs the grant with the client secret of the main thread, without the user\'s providers', async () => {
			const { provider, tokenRequests, mainThreadCalls, secretRequests } = createHarness({ oauth: { grant: 'client_credentials', clientId: 'machine' }, clientSecret: 'shh' });
			const headers: Record<string, string> = {};
			assert.ok(await provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, headers));
			const form = tokenRequests[0].form();
			assert.deepStrictEqual({
				authorization: headers.Authorization,
				grant: form.get('grant_type'),
				resource: form.get('resource'),
				credentials: decodeBase64(tokenRequests[0].headers.authorization.substring(6)).toString(),
				mainThreadCalls: mainThreadCalls.length,
				secretRequests,
			}, { authorization: 'Bearer machine-1', grant: 'client_credentials', resource: RESOURCE, credentials: 'machine:shh', mainThreadCalls: 0, secretRequests: [`machine@${ISSUER}`] });
		});

		test('client_credentials: privateKeyFile signs a private_key_jwt assertion', async () => {
			const { provider, tokenRequests, secretRequests, fileReads } = createHarness({ oauth: { grant: 'client_credentials', clientId: 'machine', privateKeyFile: '/keys/machine.pem', keyId: 'k1' }, files: { '/keys/machine.pem': await pkcs8Pem() } });
			assert.ok(await provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, {}));
			const assertion = decodeJwt(tokenRequests[0].form().get('client_assertion')!);
			assert.deepStrictEqual({ kid: assertion.header.kid, iss: assertion.claims.iss, aud: assertion.claims.aud, secretRequests, fileReads }, { kid: 'k1', iss: 'machine', aud: ISSUER, secretRequests: [], fileReads: ['/keys/machine.pem'] });
		});

		test('missing or unusable credentials, and another authorization server than oauth.authorizationServer, end the connection without a token request', async () => {
			const cases: { readonly oauth: McpServerTransportHTTP['oauth']; readonly code: string; readonly files?: Record<string, string> }[] = [
				{ oauth: { grant: 'client_credentials', clientId: 'machine' }, code: 'credentials_unavailable' },
				{ oauth: { grant: 'client_credentials' }, code: 'credentials_unavailable' },
				{ oauth: { grant: 'client_credentials', clientId: 'machine', privateKeyFile: '/missing.pem' }, code: 'credentials_unavailable' },
				{ oauth: { grant: 'client_credentials', clientId: 'machine', privateKeyFile: '/ec.pem' }, code: 'credentials_unavailable', files: { '/ec.pem': '-----BEGIN EC PRIVATE KEY-----\nAA==\n-----END EC PRIVATE KEY-----' } },
				{ oauth: { grant: 'workload_identity' }, code: 'credentials_unavailable' },
				{ oauth: { grant: 'workload_identity', workloadIdentityTokenFile: '/w.jwt', authorizationServer: 'https://other.example.test' } as McpServerTransportHTTP['oauth'], code: 'issuer_not_registered', files: { '/w.jwt': workloadJwt('1') } },
				// A file that holds no JWT, a JWT for another audience, and an expired one stay on the machine.
				{ oauth: { grant: 'workload_identity', workloadIdentityTokenFile: '/creds' }, code: 'credentials_unavailable', files: { '/creds': '[default]\naws_secret_access_key = abc' } },
				{ oauth: { grant: 'workload_identity', workloadIdentityTokenFile: '/w.jwt' }, code: 'credentials_unavailable', files: { '/w.jwt': workloadJwt('1', { aud: 'https://another-service.example.test' }) } },
				{ oauth: { grant: 'workload_identity', workloadIdentityTokenFile: '/w.jwt' }, code: 'credentials_unavailable', files: { '/w.jwt': workloadJwt('1', { exp: 1 }) } },
			];
			for (const { oauth, code, files } of cases) {
				const { provider, tokenRequests } = createHarness({ oauth, files });
				await expectOAuthError(provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, {}), code);
				assert.strictEqual(tokenRequests.length, 0, JSON.stringify(oauth));
			}
		});

		test('client credentials stay with the authorization server they were first used with, when the resource later names another', async () => {
			let servers = [ISSUER];
			const { provider, tokenRequests } = createHarness({ oauth: { grant: 'client_credentials', clientId: 'machine' }, clientSecret: 'shh', authorizationServers: () => servers });
			const headers: Record<string, string> = {};
			assert.ok(await provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, headers));
			servers = [OTHER_ISSUER];
			await expectOAuthError(provider.handleChallenge(401, `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`, headers), 'issuer_not_registered');
			assert.deepStrictEqual(tokenRequests.map(r => r.url.origin), [ISSUER]);
		});

		test('a token endpoint that cannot be reached leaves the request unauthenticated instead of failing the connection', async () => {
			const { provider } = createHarness({ oauth: { grant: 'client_credentials', clientId: 'machine' }, clientSecret: 'shh', tokenFetchError: new TypeError('fetch failed') });
			const headers: Record<string, string> = {};
			assert.strictEqual(await provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, headers), false);
			assert.strictEqual(headers.Authorization, undefined);
		});

		test('workload_identity: the token file is read for each grant, so a rotated JWT is presented', async () => {
			const files: Record<string, string> = { '/var/run/token': `${workloadJwt('1')}\n` };
			const { provider, tokenRequests, fileReads } = createHarness({ oauth: { grant: 'workload_identity', workloadIdentityTokenFile: '/var/run/token' }, files });
			const headers: Record<string, string> = {};
			assert.ok(await provider.handleChallenge(401, `Bearer resource_metadata="${PRM_URL}"`, headers));
			files['/var/run/token'] = workloadJwt('2');
			// The server rejects the token: a new grant with the rotated JWT.
			assert.ok(await provider.handleChallenge(401, `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`, headers));
			assert.deepStrictEqual({
				assertions: tokenRequests.map(r => r.form().get('assertion')),
				clientIds: tokenRequests.map(r => r.form().get('client_id')),
				fileReads: fileReads.length,
				authorization: headers.Authorization,
			}, { assertions: [workloadJwt('1'), workloadJwt('2')], clientIds: [null, null], fileReads: 2, authorization: 'Bearer machine-2' });
		});

		test('through the transport, the token request goes to the authorization server on another origin with its client authentication, follows no redirect, and stays out of the trace log', async () => {
			const run = async (tokenEndpoint: (request: IFixtureRequest) => IFixtureResponse) => {
				const router = createFixtureRouter();
				const tokenRequests: IFixtureRequest[] = [];
				const elsewhere: IFixtureRequest[] = [];
				const mcpRequests: IFixtureRequest[] = [];
				router.handle(ISSUER, request => {
					if (request.url.pathname === '/.well-known/oauth-authorization-server') {
						return { status: 200, body: { issuer: ISSUER, token_endpoint: `${ISSUER}/token`, response_types_supported: ['code'] } };
					}
					tokenRequests.push(request);
					return tokenEndpoint(request);
				});
				router.handle('https://elsewhere.example.test', request => {
					elsewhere.push(request);
					return { status: 200, body: { access_token: 'stolen', token_type: 'Bearer' } };
				});
				router.handle('https://mcp.example.test', request => {
					if (request.url.pathname === '/.well-known/oauth-protected-resource/mcp') {
						return { status: 200, body: { resource: RESOURCE, authorization_servers: [ISSUER] } };
					}
					mcpRequests.push(request);
					return request.headers.authorization === 'Bearer issued' ? { status: 200, body: {} } : { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${PRM_URL}"` } };
				});
				const logs: string[] = [];
				const proxy = Object.assign(new class extends mock<MainThreadMcpShape>() {
					override $onDidChangeState(): void { }
					override $onDidPublishLog(_id: number, _level: LogLevel, message: string): void { logs.push(message); }
					override $logMcpAuthSetup(): void { }
				}, { async $checkMcpServerAllowed() { return undefined; }, async $getMcpOAuthClientSecret() { return 'the-client-secret'; } });
				const logService: ILogService = new class extends NullLogService {
					override getLevel(): LogLevel { return LogLevel.Trace; }
				}();
				const handle = store.add(new class extends McpHTTPHandle {
					protected override async _fetchInternal(url: string, init?: CommonRequestInit): Promise<CommonResponse> {
						return toCommonResponse(url, await router.fetch(url, { method: init?.method, headers: init?.headers, body: init?.body ? new TextDecoder().decode(init.body) : undefined }));
					}
				}(1, { type: McpServerTransportType.HTTP, uri: URI.parse(RESOURCE), headers: [['X-Api-Key', 'configured-key']], oauth: { grant: 'client_credentials', clientId: 'machine' } }, proxy, logService));
				const headers: Record<string, string> = {};
				const internals = handle as unknown as { _fetchWithAuthRetry(url: string, init: { method: string; headers: Record<string, string> }, headers: Record<string, string>): Promise<CommonResponse> };
				const outcome = await internals._fetchWithAuthRetry(RESOURCE, { method: 'POST', headers }, headers).then(r => r.status, (e: unknown) => e instanceof OAuthClientError ? e.code : String(e));
				return { outcome, tokenRequests, elsewhere, mcpRequests, logs };
			};

			const issued = await run(() => ({ status: 200, body: { access_token: 'issued', token_type: 'Bearer', expires_in: 3600 } }));
			const [tokenRequest] = issued.tokenRequests;
			assert.deepStrictEqual({
				outcome: issued.outcome,
				credentials: decodeBase64(tokenRequest.headers.authorization.substring(6)).toString(),
				configuredHeader: tokenRequest.headers['x-api-key'],
				mcpAuthorization: issued.mcpRequests.at(-1)?.headers.authorization,
				secretLogged: issued.logs.some(line => line.includes('the-client-secret') || line.includes(btoa('machine:the-client-secret'))),
			}, { outcome: 200, credentials: 'machine:the-client-secret', configuredHeader: undefined, mcpAuthorization: 'Bearer issued', secretLogged: false });

			const redirected = await run(() => ({ status: 307, headers: { Location: 'https://elsewhere.example.test/token' } }));
			assert.deepStrictEqual([redirected.outcome, redirected.elsewhere.length], ['token_request_failed', 0]);
		});

		test('a machine client gets a DPoP-bound token from a server that requires one, and proves possession for each request', async () => {
			const { provider } = createHarness({ oauth: { grant: 'client_credentials', clientId: 'machine' }, clientSecret: 'shh', metadata: { dpop_signing_alg_values_supported: ['ES256'] } });
			const headers: Record<string, string> = {};
			assert.ok(await provider.handleChallenge(401, `DPoP resource_metadata="${PRM_URL}"`, headers));
			await provider.addDpopProof(headers, 'POST', RESOURCE);
			const proof = await verifyProof(headers.DPoP);
			assert.deepStrictEqual([headers.Authorization, proof.claims.ath, publicJwkOf(proof.header.jwk as JsonWebKey).kty], ['DPoP machine-1', await sha256Base64Url('machine-1'), 'EC']);
		});
	});
});
