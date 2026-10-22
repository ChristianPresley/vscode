/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ProgressOptions } from 'vscode';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { IAuthorizationServerMetadata, IAuthorizationTokenResponse, OAuthClientError } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, NullLogger } from '../../../../platform/log/common/log.js';
import { INotificationSource } from '../../../../platform/notification/common/notification.js';
import { Progress } from '../../../../platform/progress/common/progress.js';
import { Proxied } from '../../../services/extensions/common/proxyIdentifier.js';
import { DynamicAuthProvider } from '../../common/extHostAuthentication.js';
import { IProgressStepDto, MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import {
	cacheKey,
	IDP_SCOPES,
	isExpired,
	toSession,
	XaaifyAuthProvider,
} from '../../common/extHostXaaAuthProvider.js';
import { MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION } from '../../common/mcpOAuthClientFactory.js';

// Minimal unsigned JWT: getClaimsFromJWT only base64-decodes the header/payload segments.
const jwt = (claims: object): string =>
	`${encodeBase64(VSBuffer.fromString(JSON.stringify({ alg: 'none' })))}.${encodeBase64(VSBuffer.fromString(JSON.stringify(claims)))}.sig`;

suite('XaaAuthProvider helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('cacheKey is scope-order-independent', () => {
		assert.strictEqual(
			cacheKey('https://r.example.com', ['b', 'a']),
			cacheKey('https://r.example.com', ['a', 'b'])
		);
	});

	test('cacheKey distinguishes different audiences', () => {
		assert.notStrictEqual(
			cacheKey('https://r1.example.com', ['s']),
			cacheKey('https://r2.example.com', ['s'])
		);
	});

	test('isExpired treats tokens without expires_in as never expiring', () => {
		assert.strictEqual(
			isExpired({ token: {}, created_at: 0 }, Number.MAX_SAFE_INTEGER),
			false
		);
	});

	test('isExpired flags tokens within 60s of expiry as expired', () => {
		const created_at = 1_000_000;
		const expires_in = 3600;
		// 60s before nominal expiry → already expired due to safety margin
		const justInsideMargin = created_at + (expires_in * 1000) - 30_000;
		assert.strictEqual(isExpired({ token: { expires_in }, created_at }, justInsideMargin), true);
		// well before expiry
		const earlier = created_at + 1000;
		assert.strictEqual(isExpired({ token: { expires_in }, created_at }, earlier), false);
	});

	test('isExpired treats expires_in: 0 as immediately expired', () => {
		// Distinguish from `expires_in === undefined` (which means "never"); zero must mean
		// "already expired" so a malformed/edge-case AS response can't be served from cache.
		assert.strictEqual(
			isExpired({ token: { expires_in: 0 }, created_at: 1_000_000 }, 1_000_000),
			true
		);
	});

	test('IDP_SCOPES requests an OpenID session with refresh', () => {
		assert.deepStrictEqual([...IDP_SCOPES].sort(), ['offline_access', 'openid']);
	});
});

suite('XaaAuthProvider toSession', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefers the identity in the session\'s own id_token over the fallback account', () => {
		// The token passed to toSession is the response for THIS session, so its id_token is the
		// authoritative identity. The fallback account comes from a different (IdP) token response and
		// must only fill in when this token carries no id_token of its own.
		const token: IAuthorizationTokenResponse = { access_token: 'opaque', token_type: 'Bearer', id_token: jwt({ sub: 'session-sub', preferred_username: 'session@contoso.com' }) };
		const session = toSession(token, ['mcp:proxy'], { id: 'idp-sub', label: 'idp@contoso.com' });
		assert.deepStrictEqual(session.account, { id: 'session-sub', label: 'session@contoso.com' });
	});

	test('falls back to the threaded account when the token has no id_token', () => {
		// The common resource-session case: the resource token carries no id_token, so the session adopts
		// the IdP identity — keeping it aligned with account enumeration (getAccounts).
		const token: IAuthorizationTokenResponse = { access_token: 'opaque-resource-token', token_type: 'Bearer' };
		const session = toSession(token, ['mcp:proxy'], { id: 'idp-sub', label: 'user@contoso.com' });
		assert.deepStrictEqual(session.account, { id: 'idp-sub', label: 'user@contoso.com' });
	});

	test('never mines identity from the access_token', () => {
		// The access token is a bearer credential for the resource server, opaque to us by design. Even when
		// it is a JWT with identity claims and there is neither an id_token nor a fallback, we must not read it.
		const token: IAuthorizationTokenResponse = { access_token: jwt({ sub: 'resource-sub', preferred_username: 'do-not-use' }), token_type: 'Bearer' };
		const session = toSession(token, ['mcp:proxy']);
		assert.deepStrictEqual(session.account, { id: 'unknown', label: 'XAA' });
	});
});

suite('XaaAuthProvider resource token endpoint', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const idpIssuer = 'https://idp.example';
	const audience = 'https://resource-as.example';
	const resource = 'https://mcp.example/mcp';
	const idpMetadata: IAuthorizationServerMetadata = {
		issuer: idpIssuer,
		authorization_endpoint: `${idpIssuer}/authorize`,
		token_endpoint: `${idpIssuer}/token`,
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
	};

	interface IRequest {
		readonly url: string;
		readonly body: string | undefined;
	}

	/** An XAA provider with a signed-in IdP session (unless `signedOut`) whose requests `respond` answers. */
	function createProvider(respond: (url: string) => Response, signedOut = false) {
		const requests: IRequest[] = [];
		/** IdP sign-ins started (the callback URI of the authorization code flow was created). */
		const signIns: string[] = [];
		const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			requests.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
			return respond(url);
		};
		const loggerService = new class extends mock<ILoggerService>() {
			override createLogger(): ILogger { return new NullLogger(); }
		}();
		const proxy = new class extends mock<Proxied<MainThreadAuthenticationShape>>() {
			override $setSessionsForDynamicAuthProvider = (): Promise<void> => Promise.resolve();
		}();
		const extHostProgress = new class extends mock<IExtHostProgress>() {
			override async withProgressFromSource<R>(_source: string | INotificationSource, _options: ProgressOptions, task: (progress: Progress<IProgressStepDto>, token: CancellationToken) => Thenable<R>): Promise<R> {
				return task(new Progress<IProgressStepDto>(() => { }), CancellationToken.None);
			}
		}();
		const initData = new class extends mock<IExtHostInitDataService>() {
			override environment = { appUriScheme: 'vscode', appName: 'Test' } as IExtHostInitDataService['environment'];
		}();
		const XaaProvider = XaaifyAuthProvider(DynamicAuthProvider);
		const provider = disposables.add(new XaaProvider(
			new class extends mock<IExtHostWindow>() {
				override async openUri(): Promise<boolean> { return false; }
			}(),
			new class extends mock<IExtHostUrlsService>() {
				override async createAppUri(uri: URI): Promise<URI> {
					signIns.push(uri.toString());
					return uri;
				}
			}(),
			initData,
			extHostProgress,
			loggerService,
			proxy,
			URI.parse(idpIssuer),
			idpMetadata,
			undefined,
			'idp-client',
			'idp-secret',
			disposables.add(new Emitter()),
			// The IdP session the ID-JAG exchange starts from.
			signedOut ? [] : [{ access_token: 'idp-access-token', token_type: 'Bearer', scope: IDP_SCOPES.join(' '), id_token: jwt({ sub: 'user', preferred_username: 'user@example.com' }), created_at: Date.now() }],
			fetcher,
		));
		return { provider, requests, signIns };
	}

	function json(body: object): Response {
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}

	function respondWith(resourceAsIssuer: string, resourceTokenEndpoint: string) {
		return (url: string): Response => {
			if (url === idpMetadata.token_endpoint) {
				return json({ access_token: jwt({ client_id: 'resource-client', aud: audience }), token_type: 'N_A', issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag' });
			}
			if (url.startsWith(`${audience}/.well-known/`)) {
				return json({ issuer: resourceAsIssuer, token_endpoint: resourceTokenEndpoint, response_types_supported: ['code'] });
			}
			if (url === resourceTokenEndpoint) {
				return json({ access_token: 'resource-access-token', token_type: 'Bearer' });
			}
			return new Response('not found', { status: 404 });
		};
	}

	const sessionOptions = { audience, resource, clientId: 'resource-client', clientSecret: 'resource-secret' };

	test('the ID-JAG and the resource client secret go only to the token endpoint of metadata whose issuer is the audience', async () => {
		const honest = createProvider(respondWith(audience, `${audience}/token`));
		const session = await honest.provider.createSession(['mcp.read'], sessionOptions);

		// A document at the audience's well-known URL that names another issuer, and that issuer's token endpoint.
		const forged = createProvider(respondWith('https://attacker.example', 'https://attacker.example/token'));
		await assert.rejects(forged.provider.createSession(['mcp.read'], sessionOptions), (error: unknown) => {
			assert.ok(error instanceof OAuthClientError, `expected an OAuthClientError, got ${String(error)}`);
			assert.strictEqual(error.code, 'issuer_mismatch');
			return true;
		});

		assert.deepStrictEqual({
			accessToken: session.accessToken,
			honestRedemptions: honest.requests.filter(r => r.url === `${audience}/token`).map(r => new URLSearchParams(r.body).get('client_secret')),
			forgedRequests: forged.requests.filter(r => !r.url.startsWith(`${audience}/.well-known/`)).map(r => r.url),
			secretSentByForged: forged.requests.some(r => r.body?.includes('resource-secret') ?? false),
		}, {
			accessToken: 'resource-access-token',
			honestRedemptions: ['resource-secret'],
			// The audience is checked first: neither the IdP (no ID-JAG exchange) nor the attacker's token endpoint got a request.
			forgedRequests: [],
			secretSentByForged: false,
		});
	});

	test('the resource client secret goes only to an HTTPS or loopback token endpoint, and only from an HTTPS or loopback audience\'s metadata', async () => {
		const insecureEndpoint = (error: unknown) => {
			assert.ok(error instanceof OAuthClientError, `expected an OAuthClientError, got ${String(error)}`);
			assert.strictEqual(error.code, 'insecure_endpoint');
			return true;
		};
		const secretSent = (requests: readonly IRequest[]) => requests.some(r => r.body?.includes('resource-secret') ?? false);

		// The audience's own metadata names a plain-HTTP token endpoint on a non-loopback host.
		const plain = createProvider(respondWith(audience, 'http://resource-as.example/token'));
		await assert.rejects(plain.provider.createSession(['mcp.read'], sessionOptions), insecureEndpoint);
		assert.deepStrictEqual([plain.requests.some(r => r.url.startsWith('http://')), secretSent(plain.requests)], [false, false]);

		// A plain-HTTP audience: its metadata could be anyone's, so it is not even fetched.
		const plainAudience = 'http://resource-as.example';
		const fromPlain = createProvider(url => url === idpMetadata.token_endpoint
			? respondWith(audience, `${audience}/token`)(url)
			: json({ issuer: plainAudience, token_endpoint: `${audience}/token`, response_types_supported: ['code'] }));
		await assert.rejects(fromPlain.provider.createSession(['mcp.read'], { ...sessionOptions, audience: plainAudience }), insecureEndpoint);
		// Not even the IdP is asked for an ID-JAG for that audience.
		assert.deepStrictEqual([fromPlain.requests.map(r => r.url), secretSent(fromPlain.requests)], [[], false]);

		// Loopback stays allowed over HTTP (local authorization servers), as in the transport's discovery.
		const loopbackEndpoint = 'http://127.0.0.1:9000/token';
		const loopback = createProvider(respondWith(audience, loopbackEndpoint));
		const session = await loopback.provider.createSession(['mcp.read'], sessionOptions);
		assert.deepStrictEqual([session.accessToken, loopback.requests.filter(r => r.url === loopbackEndpoint).map(r => new URLSearchParams(r.body).get('client_secret'))], ['resource-access-token', ['resource-secret']]);
	});

	test('the server\'s oauth.allowInsecureHttp, set by the workbench, allows a plain-HTTP audience and token endpoint, as in the transport\'s discovery', async () => {
		const plainAudience = 'http://resource-as.example';
		const plainEndpoint = `${plainAudience}/token`;
		const respond = (url: string): Response => url.startsWith(`${plainAudience}/.well-known/`)
			? json({ issuer: plainAudience, token_endpoint: plainEndpoint, response_types_supported: ['code'] })
			: url === plainEndpoint ? json({ access_token: 'resource-access-token', token_type: 'Bearer' }) : respondWith(audience, `${audience}/token`)(url);
		const options = { ...sessionOptions, audience: plainAudience };

		const refused = createProvider(respond);
		await assert.rejects(refused.provider.createSession(['mcp.read'], options), (error: unknown) => error instanceof OAuthClientError && error.code === 'insecure_endpoint');
		const allowed = createProvider(respond);
		const session = await allowed.provider.createSession(['mcp.read'], { ...options, [MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION]: true });
		assert.deepStrictEqual({
			refusedRequests: refused.requests.map(r => r.url),
			accessToken: session.accessToken,
			redemptions: allowed.requests.filter(r => r.url === plainEndpoint).map(r => new URLSearchParams(r.body).get('client_secret')),
		}, {
			refusedRequests: [],
			accessToken: 'resource-access-token',
			redemptions: ['resource-secret'],
		});
	});

	test('a refused audience ends the sign-in before the user signs in to the IdP', async () => {
		const signedOut = createProvider(respondWith('https://attacker.example', 'https://attacker.example/token'), /* signedOut */ true);
		await assert.rejects(signedOut.provider.createSession(['mcp.read'], sessionOptions), (error: unknown) => error instanceof OAuthClientError && error.code === 'issuer_mismatch');
		assert.deepStrictEqual({
			signIns: signedOut.signIns,
			requests: signedOut.requests.filter(r => !r.url.startsWith(`${audience}/.well-known/`)).map(r => r.url),
		}, { signIns: [], requests: [] });
	});
});
