/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ProgressOptions } from 'vscode';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { canonicalResourceUri, IAuthorizationServerMetadata, OAuthClientError } from '../../../../base/common/oauth.js';
import { resourceIndicatorFor } from '../../../../base/common/oauthClient.js';
import { jwkThumbprint } from '../../../../base/common/oauthJose.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { createOAuthFixture, IOAuthFixture } from '../../../../base/test/common/oauthClientFixture.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, NullLogger, NullLogService } from '../../../../platform/log/common/log.js';
import { INotificationSource } from '../../../../platform/notification/common/notification.js';
import { Progress } from '../../../../platform/progress/common/progress.js';
import { IAuthenticationProviderSessionOptions } from '../../../services/authentication/common/authentication.js';
import { DynamicAuthProvider, ExtHostAuthentication, IAuthorizationToken, reviveAccountIcon, TokenStore } from '../../common/extHostAuthentication.js';
import { IProgressStepDto, IRegisterDynamicAuthenticationProviderDetails, IRegisterDynamicAuthProviderOptions, MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostRpcService } from '../../common/extHostRpcService.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import { MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION, MCP_OAUTH_DPOP_SESSION_OPTION, MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION } from '../../common/mcpOAuthClientFactory.js';
import { Proxied } from '../../../services/extensions/common/proxyIdentifier.js';

/** Builds a structurally-valid JWT carrying the given claims. */
function jwt(claims: object): string {
	const segment = (value: object) => encodeBase64(VSBuffer.fromString(JSON.stringify(value)));
	return `${segment({ alg: 'none', typ: 'JWT' })}.${segment(claims)}.signature`;
}

suite('TokenStore', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createStore(initialTokens: IAuthorizationToken[]): TokenStore {
		const persistence = {
			onDidChange: disposables.add(new Emitter<IAuthorizationToken[]>()).event,
			set: () => { }
		};
		return disposables.add(new TokenStore(persistence, initialTokens, new NullLogger()));
	}

	// Regression for the MCP sign-in loop: an explicit empty `token.scope` must derive empty session scopes, not the granted scopes from the JWT claims, else empty-scope lookups never match their own session.
	test('derives session scopes from the stored token.scope, falling back to JWT claims only when scope is absent', () => {
		const store = createStore([
			// Explicit empty scope must win over the scopes embedded in the JWT claims.
			{ access_token: jwt({ sub: 'a', scope: 'menu:read orders:create orders:cancel' }), token_type: 'Bearer', scope: '', created_at: 0 },
			// Absent scope (undefined) falls back to the JWT claims.
			{ access_token: jwt({ sub: 'b', scope: 'menu:read orders:create' }), token_type: 'Bearer', created_at: 0 },
			// A non-empty scope is authoritative over the JWT claims.
			{ access_token: jwt({ sub: 'c', scope: 'ignored:claim' }), token_type: 'Bearer', scope: 'read write', created_at: 0 },
		]);

		assert.deepStrictEqual(
			store.sessions.map(session => session.scopes),
			[[], ['menu:read', 'orders:create'], ['read', 'write']]
		);
	});
});

suite('DynamicAuthProvider', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	class TestDynamicAuthProvider extends DynamicAuthProvider {
		generateNewClientIdCalls = 0;
		/** Register anew for real (dynamic client registration) instead of only counting. */
		registerForReal = false;

		protected override async _generateNewClientId(): Promise<void> {
			this.generateNewClientIdCalls++;
			if (this.registerForReal) {
				await super._generateNewClientId();
			}
		}
	}

	interface ITestServer {
		readonly authorizationServer: string;
		readonly serverMetadata: IAuthorizationServerMetadata;
	}

	const resource = 'https://workiq.example.com/mcp';

	const servers: Record<string, ITestServer> = {
		entra: {
			authorizationServer: 'https://login.microsoftonline.com/organizations/v2.0',
			serverMetadata: {
				issuer: 'https://login.microsoftonline.com/organizations/v2.0',
				authorization_endpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
				token_endpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
				response_types_supported: ['code'],
				scopes_supported: ['openid', 'profile', 'offline_access'],
				code_challenge_methods_supported: ['S256'],
			},
		},
		nonMicrosoft: {
			authorizationServer: 'https://auth.example.com',
			serverMetadata: {
				issuer: 'https://auth.example.com',
				authorization_endpoint: 'https://auth.example.com/authorize',
				token_endpoint: 'https://auth.example.com/token',
				response_types_supported: ['code'],
				scopes_supported: ['openid', 'profile', 'offline_access'],
				code_challenge_methods_supported: ['S256'],
			},
		},
		// A Microsoft authorization endpoint must not opt a non-Microsoft token endpoint into Microsoft behavior.
		entraWithForeignTokenEndpoint: {
			authorizationServer: 'https://login.microsoftonline.com/organizations/v2.0',
			serverMetadata: {
				issuer: 'https://login.microsoftonline.com/organizations/v2.0',
				authorization_endpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
				token_endpoint: 'https://auth.example.com/token',
				response_types_supported: ['code'],
				scopes_supported: ['openid', 'profile', 'offline_access'],
				code_challenge_methods_supported: ['S256'],
			},
		},
	};

	function createProvider(options: ITestServer & {
		/** The `resource` of the protected resource metadata; `undefined` for a server without metadata. */
		readonly resource: string | undefined;
		readonly initialTokens?: IAuthorizationToken[];
		readonly fetcher?: typeof fetch;
		readonly onDidOpenUri?: (uri: string) => void;
		readonly clientSecret?: string;
		/** `client-id` by default. */
		readonly clientId?: string;
		readonly logger?: ILogger;
		/** The query of the redirect the URI handler receives; without it the browser "fails to open". */
		readonly redirectQuery?: (authorizationUrl: URL) => string | Promise<string>;
		/**
		 * The query of the callback URI the redirect page delivers the response to; by default the
		 * callback's own (`nonce=…`), to which the page appends the response's parameters.
		 */
		readonly callbackQuery?: (expectedQuery: string) => string;
		/** Refuse authorization servers that do not advertise PKCE S256, as MCP-server providers do. */
		readonly requireAdvertisedPkce?: boolean;
		/** Receives the tokens the provider persists through the main thread. */
		readonly onDidPersist?: (tokens: IAuthorizationToken[]) => void;
		/** The external form of the callback URI (`createAppUri`); the callback itself by default. */
		readonly createAppUri?: (uri: URI) => URI;
	}): TestDynamicAuthProvider {
		const loggerService = new class extends mock<ILoggerService>() {
			override createLogger(): ILogger {
				return options.logger ?? new NullLogger();
			}
		}();
		/** The authorization URL the browser opens next; each sign-in waits for its own. */
		let opened = new DeferredPromise<URL>();
		const proxy = new class extends mock<Proxied<MainThreadAuthenticationShape>>() {
			override $setSessionsForDynamicAuthProvider = (_id: string, _clientId: string, tokens: IAuthorizationToken[]): Promise<void> => {
				options.onDidPersist?.(tokens);
				return Promise.resolve();
			};
			// Never settles without a redirect, so an abandoned authorization flow leaves no rejected promise behind.
			override $waitForUriHandler = async (expected: UriComponents): Promise<UriComponents> => {
				const redirectQuery = options.redirectQuery;
				if (!redirectQuery) {
					return new Promise<UriComponents>(() => { });
				}
				const expectedQuery = expected.query ?? '';
				const callbackQuery = options.callbackQuery ? options.callbackQuery(expectedQuery) : expectedQuery;
				const authorizationUrl = await opened.p;
				opened = new DeferredPromise<URL>();
				return { ...expected, query: [callbackQuery, await redirectQuery(authorizationUrl)].filter(part => part.length > 0).join('&') };
			};
		}();
		const extHostWindow = new class extends mock<IExtHostWindow>() {
			override async openUri(uri: string | URI): Promise<boolean> {
				options.onDidOpenUri?.(uri.toString());
				opened.complete(new URL(uri.toString()));
				return !!options.redirectQuery;
			}
		}();
		const extHostUrls = new class extends mock<IExtHostUrlsService>() {
			override async createAppUri(uri: URI): Promise<URI> {
				return options.createAppUri ? options.createAppUri(uri) : uri;
			}
		}();
		const initData = new class extends mock<IExtHostInitDataService>() {
			override environment = { appUriScheme: 'vscode', appName: 'Test' } as IExtHostInitDataService['environment'];
		}();
		const extHostProgress = new class extends mock<IExtHostProgress>() {
			override async withProgressFromSource<R>(_source: string | INotificationSource, _options: ProgressOptions, task: (progress: Progress<IProgressStepDto>, token: CancellationToken) => Thenable<R>): Promise<R> {
				return task(new Progress<IProgressStepDto>(() => { }), CancellationToken.None);
			}
		}();
		const provider = disposables.add(new TestDynamicAuthProvider(
			extHostWindow,
			extHostUrls,
			initData,
			extHostProgress,
			loggerService,
			proxy,
			URI.parse(options.authorizationServer),
			options.serverMetadata,
			options.resource !== undefined ? { resource: options.resource } : undefined,
			options.clientId ?? 'client-id',
			options.clientSecret,
			disposables.add(new Emitter()),
			options.initialTokens ?? [],
			options.fetcher,
		));
		if (options.requireAdvertisedPkce) {
			provider.requireAdvertisedPkce();
		}
		return provider;
	}

	function tokenResponse(body: object): Response {
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}

	async function expectOAuthError(promise: Promise<unknown>, code: string): Promise<void> {
		await assert.rejects(promise, (error: unknown) => {
			assert.ok(error instanceof OAuthClientError, `expected an OAuthClientError, got ${String(error)}`);
			assert.strictEqual(error.code, code);
			return true;
		});
	}

	const expiredToken = (scope: string): IAuthorizationToken => ({
		access_token: jwt({ sub: 'account', jti: 'expired' }),
		token_type: 'Bearer',
		scope,
		expires_in: 1,
		refresh_token: 'refresh-token',
		created_at: 0,
	});

	test('a provider for an MCP server refuses the authorization code flow when PKCE S256 is not advertised', async () => {
		const openedUris: string[] = [];
		const withoutPkce: IAuthorizationServerMetadata = { ...servers.nonMicrosoft.serverMetadata, code_challenge_methods_supported: undefined };
		const provider = createProvider({ ...servers.nonMicrosoft, serverMetadata: withoutPkce, resource, requireAdvertisedPkce: true, onDidOpenUri: uri => openedUris.push(uri) });

		await expectOAuthError(provider.createSession(['api://res/Read'], {}), 'pkce_unsupported');
		assert.deepStrictEqual(openedUris, [], 'no authorization request is made');
	});

	test('other providers (an identity provider that does not advertise PKCE) still send S256 and only log the omission', async () => {
		const warnings: string[] = [];
		const logger = new class extends NullLogger {
			override warn(message: string) { warnings.push(message); }
		}();
		const bodies: Record<string, string>[] = [];
		let challengeMethod: string | null = null;
		const withoutPkce: IAuthorizationServerMetadata = { ...servers.entra.serverMetadata, code_challenge_methods_supported: undefined };
		const provider = createProvider({
			...servers.entra,
			serverMetadata: withoutPkce,
			resource,
			logger,
			redirectQuery: url => {
				challengeMethod = url.searchParams.get('code_challenge_method');
				return 'code=the-code';
			},
			fetcher: async (_input, init) => {
				bodies.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
				return tokenResponse({ access_token: jwt({ sub: 'account' }), token_type: 'Bearer' });
			},
		});

		await provider.createSession(['openid'], {});
		assert.deepStrictEqual({
			challengeMethod,
			verifierSent: (bodies[0]?.code_verifier?.length ?? 0) > 0,
			warned: warnings.some(line => line.includes('does not advertise PKCE S256')),
		}, { challengeMethod: 'S256', verifierSent: true, warned: true });
	});

	test('the URL handler flow validates the returned state (the callback nonce) after iss and before an error', async () => {
		const withIss = { ...servers.nonMicrosoft.serverMetadata, authorization_response_iss_parameter_supported: true };
		const iss = (issuer: string) => `iss=${encodeURIComponent(issuer)}`;
		const forwardedState = (nonce: string) => `state=${encodeURIComponent(`vscode://dynamicauthprovider/auth.example.com/authorize?nonce=${nonce}`)}`;
		const outcomes: string[] = [];
		const cases: Array<{ callbackQuery?: (expected: string) => string; response: (expected: string) => string }> = [
			// The callback's own nonce: the state returned.
			{ response: () => `code=the-code&${iss('https://auth.example.com')}` },
			// A forwarded state naming the same callback.
			{ response: expected => `code=the-code&${iss('https://auth.example.com')}&${forwardedState(new URLSearchParams(expected).get('nonce')!)}` },
			// Another flow's nonce.
			{ callbackQuery: () => 'nonce=someone-elses', response: () => `code=the-code&${iss('https://auth.example.com')}` },
			// No nonce at all.
			{ callbackQuery: () => '', response: () => `code=the-code&${iss('https://auth.example.com')}` },
			// A forwarded state naming another callback.
			{ response: () => `code=the-code&${iss('https://auth.example.com')}&${forwardedState('someone-elses')}` },
			// iss is checked first: a foreign issuer wins over the state.
			{ callbackQuery: () => 'nonce=someone-elses', response: () => `error=access_denied&${iss('https://evil.example.com')}` },
			// The state is checked before an error.
			{ callbackQuery: () => 'nonce=someone-elses', response: () => `error=access_denied&${iss('https://auth.example.com')}` },
			// With iss and state valid, the error is surfaced.
			{ response: () => `error=access_denied&error_description=Nope&${iss('https://auth.example.com')}` },
		];
		for (const { callbackQuery, response } of cases) {
			let tokenRequests = 0;
			let expectedQuery = '';
			const provider = createProvider({
				...servers.nonMicrosoft,
				serverMetadata: withIss,
				resource,
				callbackQuery: expected => {
					expectedQuery = expected;
					return callbackQuery ? callbackQuery(expected) : expected;
				},
				redirectQuery: () => response(expectedQuery),
				fetcher: async () => {
					tokenRequests++;
					return tokenResponse({ access_token: jwt({ sub: 'account' }), token_type: 'Bearer' });
				},
			});
			try {
				await provider.createSession(['api://res/Read'], {});
				outcomes.push(`signed in after ${tokenRequests} token request(s)`);
			} catch (error) {
				outcomes.push(`${error instanceof OAuthClientError ? error.code : String(error)} after ${tokenRequests} token request(s)`);
			}
		}
		assert.deepStrictEqual(outcomes, [
			'signed in after 1 token request(s)',
			'signed in after 1 token request(s)',
			'state_mismatch after 0 token request(s)',
			'state_mismatch after 0 token request(s)',
			'state_mismatch after 0 token request(s)',
			'iss_mismatch after 0 token request(s)',
			'state_mismatch after 0 token request(s)',
			'authorization_denied after 0 token request(s)',
		]);
	});

	test('a forwarded state names the callback nonce in its desktop, web and remote forms', async () => {
		// Desktop: the app URI itself, with the window id the native URL service adds.
		const desktop = (uri: URI) => uri.with({ query: `${uri.query}&windowId=1` });
		// Web and remote-in-browser (Codespaces): the workbench's callback page, as `LocalStorageURLCallbackProvider.create` builds it.
		const web = (nested: (query: string) => string) => (uri: URI) => URI.parse('https://codespace.example.dev/callback').with({
			query: [`vscode-reqid=1`, `vscode-scheme=${uri.scheme}`, `vscode-authority=${encodeURIComponent(uri.authority)}`, `vscode-path=${encodeURIComponent(uri.path)}`, `vscode-query=${encodeURIComponent(nested(uri.query))}`].join('&'),
		});
		const otherNonce = (query: string) => query.replace(/nonce=[^&]*/, 'nonce=someone-elses');
		const cases: Array<{ name: string; createAppUri: (uri: URI) => URI; forward: (state: string) => string }> = [
			// The state exactly as the authorization request carried it (`URI.toString()` encodes its whole query).
			{ name: 'desktop', createAppUri: desktop, forward: state => state },
			{ name: 'web', createAppUri: web(query => query), forward: state => state },
			// Decoded once by a redirect page: the nonce is still encoded in `vscode-query`.
			{ name: 'web, decoded', createAppUri: web(query => query), forward: state => URI.parse(state).toString(true) },
			{ name: 'web, another nonce', createAppUri: web(otherNonce), forward: state => state },
			{ name: 'web, another nonce, decoded', createAppUri: web(otherNonce), forward: state => URI.parse(state).toString(true) },
		];
		const outcomes: Record<string, string> = {};
		for (const { name, createAppUri, forward } of cases) {
			const provider = createProvider({
				...servers.nonMicrosoft,
				resource,
				createAppUri,
				// The redirect page delivers the response to the app URI, forwarding the state.
				redirectQuery: url => `code=the-code&state=${encodeURIComponent(forward(url.searchParams.get('state')!))}`,
				fetcher: async () => tokenResponse({ access_token: jwt({ sub: 'account' }), token_type: 'Bearer' }),
			});
			try {
				await provider.createSession(['api://res/Read'], {});
				outcomes[name] = 'signed in';
			} catch (error) {
				outcomes[name] = error instanceof OAuthClientError ? error.code : String(error);
			}
		}
		assert.deepStrictEqual(outcomes, {
			'desktop': 'signed in',
			'web': 'signed in',
			'web, decoded': 'signed in',
			'web, another nonce': 'state_mismatch',
			'web, another nonce, decoded': 'state_mismatch',
		});
	});

	test('the authorization request carries an S256 challenge of a verifier sent at the token endpoint', async () => {
		const bodies: Record<string, string>[] = [];
		let challenge: string | null = null;
		const provider = createProvider({
			...servers.nonMicrosoft,
			resource,
			redirectQuery: url => {
				challenge = url.searchParams.get('code_challenge');
				assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
				return 'code=the-code';
			},
			fetcher: async (_input, init) => {
				bodies.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
				return tokenResponse({ access_token: jwt({ sub: 'account' }), token_type: 'Bearer' });
			},
		});

		await provider.createSession(['api://res/Read'], {});
		const verifier = bodies[0].code_verifier;
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
		assert.strictEqual(challenge, encodeBase64(VSBuffer.wrap(digest), false, true));
		assert.strictEqual(bodies[0].code, 'the-code');
	});

	/** The header and claims of a DPoP proof whose signature verifies with the key of its `jwk` header. */
	async function verifiedProof(proof: string | undefined): Promise<{ readonly jkt: string; readonly claims: Record<string, unknown> }> {
		assert.ok(proof, 'the request carries a DPoP proof');
		const [header, claims, signature] = proof.split('.');
		const jwk = JSON.parse(decodeBase64(header).toString()).jwk as JsonWebKey;
		const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64(signature).buffer as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${header}.${claims}`) as Uint8Array<ArrayBuffer>));
		return { jkt: await jwkThumbprint(jwk), claims: JSON.parse(decodeBase64(claims).toString()) };
	}

	test('a request that asks for DPoP gets a DPoP-bound token: the code is bound to the key, the token requests prove possession of it, and the token is stored and refreshed with it', async () => {
		const requests: { readonly grant: string | null; readonly proof: string | undefined }[] = [];
		const persisted: IAuthorizationToken[][] = [];
		let dpopJkt: string | null = null;
		const provider = createProvider({
			authorizationServer: servers.nonMicrosoft.authorizationServer,
			serverMetadata: { ...servers.nonMicrosoft.serverMetadata, dpop_signing_alg_values_supported: ['ES256'] },
			resource,
			redirectQuery: url => {
				dpopJkt = url.searchParams.get('dpop_jkt');
				return 'code=the-code';
			},
			onDidPersist: tokens => persisted.push(tokens),
			fetcher: async (_input, init) => {
				requests.push({ grant: new URLSearchParams(String(init?.body)).get('grant_type'), proof: (init?.headers as Record<string, string>).DPoP });
				// The first token request learns the nonce the authorization server requires (RFC 9449 section 8).
				if (requests.length === 1) {
					return new Response(JSON.stringify({ error: 'use_dpop_nonce' }), { status: 400, headers: { 'Content-Type': 'application/json', 'DPoP-Nonce': 'as-nonce' } });
				}
				return tokenResponse({ access_token: jwt({ sub: 'account', n: requests.length }), token_type: 'DPoP', expires_in: 1, refresh_token: 'refresh-token' });
			},
		});

		await provider.createSession(['mcp:read'], { [MCP_OAUTH_DPOP_SESSION_OPTION]: true });
		const stored = persisted.at(-1)![0];
		// The token expires within the refresh margin: the next lookup refreshes it with the stored key.
		await provider.getSessions(['mcp:read'], {});
		const proofs = await Promise.all(requests.map(r => verifiedProof(r.proof)));

		assert.ok(stored.dpop_jwk?.d, 'the token is stored with its private key');
		assert.deepStrictEqual({
			tokenType: stored.token_type,
			grants: requests.map(r => r.grant),
			nonces: proofs.map(p => p.claims.nonce),
			htu: proofs.map(p => p.claims.htu),
			keys: new Set([dpopJkt, ...proofs.map(p => p.jkt), await jwkThumbprint(stored.dpop_jwk!)]).size,
			refreshed: persisted.at(-1)![0].dpop_jwk !== undefined,
		}, {
			tokenType: 'DPoP',
			grants: ['authorization_code', 'authorization_code', 'refresh_token'],
			nonces: [undefined, 'as-nonce', undefined],
			htu: [servers.nonMicrosoft.serverMetadata.token_endpoint, servers.nonMicrosoft.serverMetadata.token_endpoint, servers.nonMicrosoft.serverMetadata.token_endpoint],
			keys: 1,
			refreshed: true,
		});
	});

	test('without the DPoP request option, or from an authorization server without DPoP, a sign-in asks for no DPoP-bound token, and a DPoP token type is refused', async () => {
		const cases: [IAuthorizationServerMetadata, IAuthenticationProviderSessionOptions][] = [
			[{ ...servers.nonMicrosoft.serverMetadata, dpop_signing_alg_values_supported: ['ES256'] }, {}],
			[servers.nonMicrosoft.serverMetadata, { [MCP_OAUTH_DPOP_SESSION_OPTION]: true }],
		];
		for (const [metadata, options] of cases) {
			const proofs: (string | undefined)[] = [];
			let dpopJkt: string | null = 'unset';
			const provider = createProvider({
				authorizationServer: servers.nonMicrosoft.authorizationServer,
				serverMetadata: metadata,
				resource,
				redirectQuery: url => {
					dpopJkt = url.searchParams.get('dpop_jkt');
					return 'code=the-code';
				},
				fetcher: async (_input, init) => {
					proofs.push((init?.headers as Record<string, string>).DPoP);
					return tokenResponse({ access_token: jwt({ sub: 'account' }), token_type: 'DPoP' });
				},
			});
			await expectOAuthError(provider.createSession(['mcp:read'], options), 'token_request_failed');
			assert.deepStrictEqual([proofs, dpopJkt], [[undefined], null]);
		}
	});

	test('validates iss before the code and before an error', async () => {
		const withIss = { ...servers.nonMicrosoft.serverMetadata, authorization_response_iss_parameter_supported: true };
		const outcomes: string[] = [];
		for (const query of [
			`code=the-code&iss=${encodeURIComponent('https://evil.example.com')}`,
			`error=access_denied&iss=${encodeURIComponent('https://evil.example.com')}`,
			'code=the-code',
			`code=the-code&iss=${encodeURIComponent('https://auth.example.com/')}`,
			`error=access_denied&iss=${encodeURIComponent('https://auth.example.com')}`,
		]) {
			let tokenRequests = 0;
			const provider = createProvider({
				...servers.nonMicrosoft,
				serverMetadata: withIss,
				resource,
				redirectQuery: () => query,
				fetcher: async () => {
					tokenRequests++;
					return tokenResponse({ access_token: jwt({ sub: 'account' }), token_type: 'Bearer' });
				},
			});
			try {
				await provider.createSession(['api://res/Read'], {});
				outcomes.push(`signed in after ${tokenRequests} token request(s)`);
			} catch (error) {
				outcomes.push(`${error instanceof OAuthClientError ? error.code : String(error)} after ${tokenRequests} token request(s)`);
			}
		}
		assert.deepStrictEqual(outcomes, [
			'iss_mismatch after 0 token request(s)',
			'iss_mismatch after 0 token request(s)',
			'iss_missing after 0 token request(s)',
			'iss_mismatch after 0 token request(s)',
			'authorization_denied after 0 token request(s)',
		]);
	});

	test('authenticates at the token endpoint with the recorded method', async () => {
		const requests: Record<string, { authorization: string | null; clientSecret: string | undefined; clientId: string | undefined }> = {};
		for (const method of ['client_secret_basic', 'client_secret_post', 'none'] as const) {
			const provider = createProvider({
				...servers.nonMicrosoft,
				resource,
				clientSecret: method === 'none' ? undefined : 's3cret',
				initialTokens: [expiredToken('api://res/Read')],
				fetcher: async (_input, init) => {
					const body = new URLSearchParams(String(init?.body));
					requests[method] = { authorization: new Headers(init?.headers).get('Authorization'), clientSecret: body.get('client_secret') ?? undefined, clientId: body.get('client_id') ?? undefined };
					return tokenResponse({ access_token: jwt({ sub: 'account' }), token_type: 'Bearer', expires_in: 3600 });
				},
			});
			provider.setTokenEndpointAuthMethod(method);
			await provider.getSessions(['api://res/Read'], { silent: true } satisfies IAuthenticationProviderSessionOptions);
		}
		assert.deepStrictEqual(requests, {
			client_secret_basic: { authorization: `Basic ${encodeBase64(VSBuffer.fromString('client-id:s3cret'))}`, clientSecret: undefined, clientId: 'client-id' },
			client_secret_post: { authorization: null, clientSecret: 's3cret', clientId: 'client-id' },
			none: { authorization: null, clientSecret: undefined, clientId: 'client-id' },
		});
	});

	test('a client with a secret and no recorded method uses client_secret_basic unless only client_secret_post is supported', () => {
		const basic = createProvider({ ...servers.nonMicrosoft, resource, clientSecret: 's3cret' });
		const post = createProvider({ ...servers.nonMicrosoft, serverMetadata: { ...servers.nonMicrosoft.serverMetadata, token_endpoint_auth_methods_supported: ['client_secret_post'] }, resource, clientSecret: 's3cret' });
		const publicClient = createProvider({ ...servers.nonMicrosoft, resource });
		assert.deepStrictEqual([basic.tokenEndpointAuthMethod, post.tokenEndpointAuthMethod, publicClient.tokenEndpointAuthMethod], ['client_secret_basic', 'client_secret_post', 'none']);
	});

	test('logs neither the code, the verifier, the client secret nor any token', async () => {
		const lines: string[] = [];
		const logger = new class extends NullLogger {
			override trace(message: string) { lines.push(message); }
			override debug(message: string) { lines.push(message); }
			override info(message: string) { lines.push(message); }
			override warn(message: string) { lines.push(message); }
			override error(message: string | Error) { lines.push(String(message)); }
		}();
		const accessToken = jwt({ sub: 'account', secret: 'access-token-value' });
		let verifier = '';
		const provider = createProvider({
			...servers.nonMicrosoft,
			resource,
			clientSecret: 'client-secret-value',
			logger,
			redirectQuery: () => 'code=authorization-code-value',
			fetcher: async (_input, init) => {
				verifier = new URLSearchParams(String(init?.body)).get('code_verifier') ?? '';
				return tokenResponse({ access_token: accessToken, token_type: 'Bearer', refresh_token: 'refresh-token-value', id_token: jwt({ sub: 'id-token-value' }), expires_in: 3600 });
			},
		});

		await provider.createSession(['api://res/Read'], {});
		const leaked = ['authorization-code-value', verifier, 'client-secret-value', accessToken, 'refresh-token-value'].filter(secret => lines.some(line => line.includes(secret)));
		assert.ok(verifier.length > 0 && lines.length > 0);
		assert.deepStrictEqual(leaked, []);
	});

	test('does not rotate the client while silently refreshing a token', async () => {
		let fetchCalls = 0;
		const fetcher: typeof fetch = async () => {
			fetchCalls++;
			return new Response(JSON.stringify({ error: 'invalid_client' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		};
		const provider = createProvider({
			authorizationServer: 'https://mcp.example.com',
			serverMetadata: {
				issuer: 'https://mcp.example.com',
				response_types_supported: ['code'],
				token_endpoint: 'https://mcp.example.com/token',
			},
			resource: 'https://mcp.example.com/resource',
			initialTokens: [{
				access_token: jwt({ sub: 'account' }),
				token_type: 'Bearer',
				scope: '',
				expires_in: 1,
				refresh_token: 'refresh-token',
				created_at: 0,
			}],
			fetcher,
		});

		const sessions = await provider.getSessions([], { silent: true } satisfies IAuthenticationProviderSessionOptions);

		assert.deepStrictEqual({
			sessions,
			fetchCalls,
			generateNewClientIdCalls: provider.generateNewClientIdCalls,
			clientId: provider.clientId,
		}, {
			sessions: [],
			fetchCalls: 1,
			generateNewClientIdCalls: 0,
			clientId: 'client-id',
		});
	});

	test('a refresh follows the rules of the code grant and of the OAuth client: HTTP 200 with a non-empty bearer token', async () => {
		const token = (body: object, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		const fresh = jwt({ sub: 'account', jti: 'fresh' });
		const responses: Record<string, () => Response> = {
			'200, bearer in any case': token({ access_token: fresh, token_type: 'bearer', expires_in: 3600 }),
			'400 with a token body': token({ access_token: fresh, token_type: 'Bearer' }, 400),
			'201': token({ access_token: fresh, token_type: 'Bearer' }, 201),
			'200, DPoP': token({ access_token: fresh, token_type: 'DPoP' }),
			'200, empty token': token({ access_token: '', token_type: 'Bearer' }),
		};
		const refreshed: Record<string, number> = {};
		const granted: Record<string, string> = {};
		for (const [name, respond] of Object.entries(responses)) {
			const refreshing = createProvider({ ...servers.nonMicrosoft, resource, initialTokens: [expiredToken('api://res/Read')], fetcher: async () => respond() });
			refreshed[name] = (await refreshing.getSessions(['api://res/Read'], { silent: true } satisfies IAuthenticationProviderSessionOptions)).length;
			const signingIn = createProvider({ ...servers.nonMicrosoft, resource, redirectQuery: () => 'code=authorization-code', fetcher: async () => respond() });
			try {
				await signingIn.createSession(['api://res/Read'], {});
				granted[name] = 'signed in';
			} catch (error) {
				granted[name] = error instanceof OAuthClientError ? error.code : 'failed';
			}
		}
		assert.deepStrictEqual({ refreshed, granted }, {
			refreshed: { '200, bearer in any case': 1, '400 with a token body': 0, '201': 0, '200, DPoP': 0, '200, empty token': 0 },
			granted: { '200, bearer in any case': 'signed in', '400 with a token body': 'failed', '201': 'failed', '200, DPoP': 'token_request_failed', '200, empty token': 'token_request_failed' },
		});
	});

	/** The provider's `fetch` against the in-memory authorization server of the OAuth client's tests. */
	function fixtureFetch(fixture: IOAuthFixture): typeof fetch {
		return async (input, init) => {
			const headers: Record<string, string> = {};
			new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
			const response = await fixture.fetch(String(input), { method: init?.method, headers, body: typeof init?.body === 'string' ? init.body : undefined, redirect: 'manual' });
			return new Response(await response.text(), { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'text/plain' } });
		};
	}

	/** The browser for the fixture: its authorization endpoint redirects at once, and the redirect page hands the query to the callback. */
	function fixtureRedirect(fixture: IOAuthFixture): (authorizationUrl: URL) => Promise<string> {
		return async authorizationUrl => {
			const response = await fixture.fetch(authorizationUrl.toString(), { method: 'GET', redirect: 'manual' });
			return new URL(response.headers.get('location')!).search.substring(1);
		};
	}

	test('against the OAuth client\'s fixture: the code grant (PKCE, iss, state, resource, client authentication), a refresh, and a new registration after invalid_client', async () => {
		const fixture = createOAuthFixture({
			as: {
				tokenEndpointAuthMethodsSupported: ['client_secret_basic', 'none'],
				clients: { 'client-id': { clientSecret: 's3cret', tokenEndpointAuthMethod: 'client_secret_basic' } },
				requireKnownClient: true,
				// Within the provider's refresh margin, so the next lookup refreshes.
				tokenLifetimeSeconds: 60,
			},
		});
		const create = (clientSecret: string) => createProvider({ authorizationServer: fixture.issuer, serverMetadata: fixture.as.metadata(), resource: fixture.resource, clientSecret, requireAdvertisedPkce: true, fetcher: fixtureFetch(fixture), redirectQuery: fixtureRedirect(fixture) });

		const provider = create('s3cret');
		const signedIn = await provider.createSession(['mcp.read'], {});
		const [refreshed] = await provider.getSessions(['mcp.read'], { silent: true } satisfies IAuthenticationProviderSessionOptions);

		// A stale secret: the token endpoint answers invalid_client, the provider registers anew and the next sign-in uses that client.
		const stale = create('stale-secret');
		stale.registerForReal = true;
		await assert.rejects(stale.createSession(['mcp.read'], {}));
		const reRegistered = await stale.createSession(['mcp.read'], {});

		assert.deepStrictEqual({
			violations: fixture.as.violations,
			authorizationRequests: fixture.as.authorizationRequests.map(r => ({ client: r.query.client_id, method: r.query.code_challenge_method, resource: r.query.resource })),
			tokenRequests: fixture.as.tokenRequests.map(r => ({ grant: r.body.grant_type, client: r.clientId, auth: r.authMethod, resource: r.body.resource })),
			issued: [signedIn, refreshed, reRegistered].map(session => fixture.as.issuedTokens.has(session.accessToken)),
			refreshedIsNew: refreshed.accessToken !== signedIn.accessToken,
			registrations: fixture.as.registrations.length,
			staleClient: stale.clientId,
		}, {
			violations: [],
			authorizationRequests: [
				{ client: 'client-id', method: 'S256', resource: fixture.resource },
				{ client: 'client-id', method: 'S256', resource: fixture.resource },
				{ client: fixture.as.registeredClientIds[0], method: 'S256', resource: fixture.resource },
			],
			tokenRequests: [
				{ grant: 'authorization_code', client: 'client-id', auth: 'client_secret_basic', resource: fixture.resource },
				{ grant: 'refresh_token', client: 'client-id', auth: 'client_secret_basic', resource: fixture.resource },
				{ grant: 'authorization_code', client: 'client-id', auth: 'client_secret_basic', resource: fixture.resource },
				// The new registration is a public client: the server supports `none`.
				{ grant: 'authorization_code', client: fixture.as.registeredClientIds[0], auth: 'none', resource: fixture.resource },
			],
			issued: [true, true, true],
			refreshedIsNew: true,
			registrations: 1,
			staleClient: fixture.as.registeredClientIds[0],
		});
	});

	test('against the OAuth client\'s fixture: a client ID metadata document client the authorization server refuses registers another way, as the OAuth client does; other refused clients stay refused', async () => {
		const cimdUrl = 'https://vscode.dev/oauth/client-metadata.json';
		const cimdFixture = createOAuthFixture({ as: { clientIdMetadataDocumentSupported: true, rejectCimdClientAt: 'authorize' } });
		const cimd = createProvider({ authorizationServer: cimdFixture.issuer, serverMetadata: cimdFixture.as.metadata(), resource: cimdFixture.resource, clientId: cimdUrl, requireAdvertisedPkce: true, fetcher: fixtureFetch(cimdFixture), redirectQuery: fixtureRedirect(cimdFixture) });
		cimd.registerForReal = true;
		const outcome = (promise: Promise<unknown>) => promise.then(() => 'signed in', (error: unknown) => error instanceof OAuthClientError ? error.code : 'try again');
		const refused = await outcome(cimd.createSession(['mcp.read'], {}));
		const session = await cimd.createSession(['mcp.read'], {});

		// A client that is no metadata document: refusing it is terminal, nothing is registered.
		const knownOnly = createOAuthFixture({ as: { requireKnownClient: true } });
		const plain = createProvider({ authorizationServer: knownOnly.issuer, serverMetadata: knownOnly.as.metadata(), resource: knownOnly.resource, requireAdvertisedPkce: true, fetcher: fixtureFetch(knownOnly), redirectQuery: fixtureRedirect(knownOnly) });
		plain.registerForReal = true;

		assert.deepStrictEqual({
			refused,
			clients: cimdFixture.as.authorizationRequests.map(r => r.query.client_id),
			registrations: cimdFixture.as.registrations.length,
			issued: cimdFixture.as.issuedTokens.has(session.accessToken),
			clientId: cimd.clientId,
			plain: await outcome(plain.createSession(['mcp.read'], {})),
			plainRegistrations: knownOnly.as.registrations.length,
		}, {
			refused: 'try again',
			clients: [cimdUrl, cimdFixture.as.registeredClientIds[0]],
			registrations: 1,
			issued: true,
			clientId: cimdFixture.as.registeredClientIds[0],
			plain: 'authorization_denied',
			plainRegistrations: 0,
		});
	});

	test('against the OAuth client\'s fixture: the code grant and a refresh send the resource indicator the OAuth client sends: without protected resource metadata the MCP server URL the request names, slash-less for a bare origin; a published resource less its fragment', async () => {
		const cases: Array<{ name: string; serverUrl: string; published?: string; requested?: string }> = [
			// No protected resource metadata (the 2025-03-26 default endpoints, or authorization server metadata at the origin):
			// the request names the transport's canonical URI.
			{ name: 'no metadata, path', serverUrl: 'https://mcp.example.test/mcp', requested: 'https://mcp.example.test/mcp' },
			{ name: 'no metadata, bare origin', serverUrl: 'https://mcp.example.test', requested: 'https://mcp.example.test/' },
			// Published metadata wins over the requested resource; a fragment is never sent (RFC 8707 section 2).
			{ name: 'published with a fragment', serverUrl: 'https://mcp.example.test/mcp', published: 'https://mcp.example.test/mcp#tools', requested: 'https://mcp.example.test/mcp#tools' },
			{ name: 'published, another requested', serverUrl: 'https://mcp.example.test/mcp', published: 'https://mcp.example.test/mcp', requested: 'https://other.example.test/mcp' },
		];
		const outcomes: Record<string, unknown> = {};
		for (const { name, serverUrl, published, requested } of cases) {
			// Within the provider's refresh margin, so the next lookup refreshes.
			const fixture = createOAuthFixture({ rs: { resource: serverUrl }, as: { tokenLifetimeSeconds: 60 } });
			const provider = createProvider({ authorizationServer: fixture.issuer, serverMetadata: fixture.as.metadata(), resource: published, requireAdvertisedPkce: true, fetcher: fixtureFetch(fixture), redirectQuery: fixtureRedirect(fixture) });
			const session = await provider.createSession(['mcp.read'], { resource: requested });
			const [refreshed] = await provider.getSessions(['mcp.read'], { silent: true, resource: requested } satisfies IAuthenticationProviderSessionOptions);
			outcomes[name] = {
				authorize: fixture.as.authorizationRequests.map(r => r.query.resource),
				token: fixture.as.tokenRequests.map(r => `${r.body.grant_type} ${r.body.resource}`),
				issued: [session, refreshed].map(s => fixture.as.issuedTokens.has(s?.accessToken ?? '')),
			};
		}
		assert.deepStrictEqual(outcomes, {
			'no metadata, path': { authorize: ['https://mcp.example.test/mcp'], token: ['authorization_code https://mcp.example.test/mcp', 'refresh_token https://mcp.example.test/mcp'], issued: [true, true] },
			'no metadata, bare origin': { authorize: ['https://mcp.example.test'], token: ['authorization_code https://mcp.example.test', 'refresh_token https://mcp.example.test'], issued: [true, true] },
			'published with a fragment': { authorize: ['https://mcp.example.test/mcp'], token: ['authorization_code https://mcp.example.test/mcp', 'refresh_token https://mcp.example.test/mcp'], issued: [true, true] },
			'published, another requested': { authorize: ['https://mcp.example.test/mcp'], token: ['authorization_code https://mcp.example.test/mcp', 'refresh_token https://mcp.example.test/mcp'], issued: [true, true] },
		});
		// The same values as the OAuth client's.
		assert.deepStrictEqual(
			cases.map(({ published, requested }) => resourceIndicatorFor(canonicalResourceUri(published ?? requested!), published)),
			['https://mcp.example.test/mcp', 'https://mcp.example.test', 'https://mcp.example.test/mcp', 'https://mcp.example.test/mcp'],
		);
	});

	test('a new registration after invalid_client goes to an HTTPS or loopback registration endpoint only, unless the MCP server allows plain HTTP', async () => {
		const allowed = { [MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION]: true };
		const outcomes: Record<string, unknown> = {};
		for (const [name, registrationEndpoint, requestOptions] of [
			['cleartext', 'http://as.example.test/register', {}],
			['cleartext, allowed', 'http://as.example.test/register', allowed],
			['loopback', 'http://127.0.0.1:4711/register', {}],
		] as const) {
			const fixture = createOAuthFixture({ as: { clients: { 'client-id': { clientSecret: 's3cret', tokenEndpointAuthMethod: 'client_secret_basic' } }, requireKnownClient: true } });
			const origin = new URL(registrationEndpoint).origin;
			fixture.router.handle(origin, request => request.url.pathname === '/register' ? { status: 201, body: { client_id: 'registered-client', token_endpoint_auth_method: 'none' } } : undefined);
			// A stale secret: the token endpoint answers invalid_client and the provider registers anew.
			const logged: string[] = [];
			const logger = new class extends NullLogger {
				override info(message: string) { logged.push(message); }
			}();
			const provider = createProvider({ authorizationServer: fixture.issuer, serverMetadata: { ...fixture.as.metadata(), registration_endpoint: registrationEndpoint }, resource: fixture.resource, clientSecret: 'stale-secret', fetcher: fixtureFetch(fixture), redirectQuery: fixtureRedirect(fixture), logger });
			provider.registerForReal = true;
			// Without a registration the provider asks the user for a client, which this test's main thread cannot answer.
			await assert.rejects(provider.createSession(['mcp.read'], requestOptions));
			outcomes[name] = {
				registrationRequests: fixture.requests.filter(r => r.url.startsWith(origin)).length,
				clientId: provider.clientId,
				// The reason, localized like the provider's other refusals.
				refusedAsInsecure: logged.some(line => line.includes(`The registration endpoint '${registrationEndpoint}' is not served over HTTPS, so no client is registered there.`)),
			};
		}
		assert.deepStrictEqual(outcomes, {
			'cleartext': { registrationRequests: 0, clientId: 'client-id', refusedAsInsecure: true },
			'cleartext, allowed': { registrationRequests: 1, clientId: 'registered-client', refusedAsInsecure: false },
			'loopback': { registrationRequests: 1, clientId: 'registered-client', refusedAsInsecure: false },
		});
	});

	test('a provider shared by an mcp.json server and the agent host applies the rules of the caller of each request: plain-HTTP registration and the PKCE check', async () => {
		const allowInsecure = { [MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION]: true };
		const requirePkce = { [MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION]: true };
		const registrationEndpoint = 'http://as.example.test/register';
		const outcomes: Record<string, unknown> = {};
		// Created for an mcp.json server with `oauth.allowInsecureHttp` (whose own requests say so), then reused by the agent host.
		for (const [name, requestOptions] of [['agent host', {}], ['mcp.json server', allowInsecure]] as const) {
			const fixture = createOAuthFixture({ as: { clients: { 'client-id': { clientSecret: 's3cret', tokenEndpointAuthMethod: 'client_secret_basic' } }, requireKnownClient: true } });
			fixture.router.handle('http://as.example.test', request => request.url.pathname === '/register' ? { status: 201, body: { client_id: 'registered-client', token_endpoint_auth_method: 'none' } } : undefined);
			const shared = createProvider({ authorizationServer: fixture.issuer, serverMetadata: { ...fixture.as.metadata(), registration_endpoint: registrationEndpoint }, resource: fixture.resource, clientSecret: 'stale-secret', requireAdvertisedPkce: true, fetcher: fixtureFetch(fixture), redirectQuery: fixtureRedirect(fixture) });
			shared.registerForReal = true;
			await assert.rejects(shared.createSession(['mcp.read'], requestOptions));
			outcomes[name] = fixture.requests.filter(r => r.url.startsWith('http://as.example.test')).length;
		}
		// Created by the agent host (no PKCE rule), then reused by an mcp.json server, whose requests require advertised PKCE S256;
		// a provider created for an mcp.json server keeps its rule for the agent host's requests (the stricter rule wins).
		const withoutPkce: IAuthorizationServerMetadata = { ...servers.nonMicrosoft.serverMetadata, code_challenge_methods_supported: undefined };
		const pkceOutcome = async (createdForMcpJson: boolean, requestOptions: object) => {
			const opened: string[] = [];
			const provider = createProvider({ ...servers.nonMicrosoft, serverMetadata: withoutPkce, resource, requireAdvertisedPkce: createdForMcpJson, onDidOpenUri: uri => opened.push(uri) });
			return provider.createSession(['mcp.read'], requestOptions).then(() => 'signed in', (error: unknown) => error instanceof OAuthClientError ? error.code : `browser opened ${opened.length}`);
		};
		outcomes.pkce = {
			agentHostProviderForMcpJson: await pkceOutcome(false, requirePkce),
			agentHostProviderForAgentHost: await pkceOutcome(false, {}),
			mcpJsonProviderForAgentHost: await pkceOutcome(true, {}),
		};
		assert.deepStrictEqual(outcomes, {
			'agent host': 0,
			'mcp.json server': 1,
			pkce: { agentHostProviderForMcpJson: 'pkce_unsupported', agentHostProviderForAgentHost: 'browser opened 1', mcpJsonProviderForAgentHost: 'pkce_unsupported' },
		});
	});

	test('without protected resource metadata, the sessions of a provider are bound to the MCP server they were issued for: same-origin servers do not share or refresh each other\'s tokens', async () => {
		const serverA = 'https://mcp.example.test/a';
		const serverB = 'https://mcp.example.test/b';
		// Within the provider's refresh margin, so every lookup refreshes.
		const fixture = createOAuthFixture({ as: { tokenLifetimeSeconds: 60 } });
		const persisted: IAuthorizationToken[][] = [];
		// A token stored before tokens were bound (it carries no resource) still serves any server, as before.
		const unbound: IAuthorizationToken = { access_token: jwt({ sub: 'legacy' }), token_type: 'Bearer', scope: 'mcp.legacy', created_at: 0 };
		const provider = createProvider({ authorizationServer: fixture.issuer, serverMetadata: fixture.as.metadata(), resource: undefined, initialTokens: [unbound], requireAdvertisedPkce: true, fetcher: fixtureFetch(fixture), redirectQuery: fixtureRedirect(fixture), onDidPersist: tokens => persisted.push(tokens) });

		const a = await provider.createSession(['mcp.read'], { resource: serverA });
		const forB = await provider.getSessions(['mcp.read'], { silent: true, resource: serverB } satisfies IAuthenticationProviderSessionOptions);
		const b = await provider.createSession(['mcp.read'], { resource: serverB });
		const [refreshedA] = await provider.getSessions(['mcp.read'], { silent: true, resource: serverA } satisfies IAuthenticationProviderSessionOptions);
		const [refreshedB] = await provider.getSessions(['mcp.read'], { silent: true, resource: serverB } satisfies IAuthenticationProviderSessionOptions);
		const legacyForA = await provider.getSessions(['mcp.legacy'], { silent: true, resource: serverA } satisfies IAuthenticationProviderSessionOptions);
		const legacyForB = await provider.getSessions(['mcp.legacy'], { silent: true, resource: serverB } satisfies IAuthenticationProviderSessionOptions);

		const resourceOf = (session: { accessToken: string } | undefined) => session && fixture.as.issuedTokens.get(session.accessToken)?.resource;
		assert.deepStrictEqual({
			forB: forB.length,
			issued: [a, b, refreshedA, refreshedB].map(resourceOf),
			refreshes: fixture.as.tokenRequests.filter(r => r.body.grant_type === 'refresh_token').map(r => r.body.resource),
			legacy: [legacyForA.length, legacyForB.length],
			stored: persisted.at(-1)?.map(token => `${token.scope} ${token.resource}`).sort(),
			all: (await provider.getSessions(undefined, {})).length,
		}, {
			forB: 0,
			issued: [serverA, serverB, serverA, serverB],
			// A's refresh token is never sent with B's resource.
			refreshes: [serverA, serverB],
			legacy: [1, 1],
			stored: ['mcp.legacy undefined', `mcp.read ${serverA}`, `mcp.read ${serverB}`],
			all: 3,
		});
	});

	test('refresh sends scope without resource for Microsoft auth, and resource without scope otherwise', async () => {
		const results: Record<string, { body: Record<string, string>; scopes: (readonly string[])[] }> = {};
		for (const [name, server] of Object.entries(servers)) {
			const bodies: Record<string, string>[] = [];
			const fetcher: typeof fetch = async (_input, init) => {
				bodies.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
				return new Response(JSON.stringify({
					access_token: jwt({ sub: 'account' }),
					token_type: 'Bearer',
					expires_in: 3600,
					refresh_token: 'new-refresh',
				}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			};
			const provider = createProvider({
				...server,
				resource,
				initialTokens: [{
					access_token: jwt({ sub: 'account', jti: 'expired' }),
					token_type: 'Bearer',
					scope: 'api://res/Read',
					expires_in: 1,
					refresh_token: 'refresh-token',
					created_at: 0,
				}],
				fetcher,
			});

			const sessions = await provider.getSessions(['api://res/Read'], { silent: true } satisfies IAuthenticationProviderSessionOptions);
			results[name] = { body: bodies[0], scopes: sessions.map(session => session.scopes) };
		}

		const refreshBase = { client_id: 'client-id', grant_type: 'refresh_token', refresh_token: 'refresh-token' };
		assert.deepStrictEqual(results, {
			entra: {
				body: { ...refreshBase, scope: 'api://res/Read offline_access' },
				scopes: [['api://res/Read']],
			},
			nonMicrosoft: {
				body: { ...refreshBase, resource },
				scopes: [['api://res/Read']],
			},
			entraWithForeignTokenEndpoint: {
				body: { ...refreshBase, resource },
				scopes: [['api://res/Read']],
			},
		});
	});

	test('authorization URL requests offline_access when advertised and omits resource for Microsoft auth', async () => {
		const results: Record<string, { scope: string | null; resource: string | null; prompt: string | null }> = {};
		for (const [name, server] of Object.entries(servers)) {
			const openedUris: string[] = [];
			const provider = createProvider({
				...server,
				resource,
				onDidOpenUri: uri => openedUris.push(uri),
			});

			await assert.rejects(provider.createSession(['api://res/Read'], {}));

			const params = new URL(openedUris[0]).searchParams;
			results[name] = {
				scope: params.get('scope'),
				resource: params.get('resource'),
				prompt: params.get('prompt'),
			};
		}

		assert.deepStrictEqual(results, {
			entra: { scope: 'api://res/Read offline_access', resource: null, prompt: null },
			nonMicrosoft: { scope: 'api://res/Read offline_access', resource, prompt: null },
			entraWithForeignTokenEndpoint: { scope: 'api://res/Read offline_access', resource, prompt: null },
		});
	});
});

suite('ExtHostAuthentication - dynamic providers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface IMainThreadRecord {
		/** The client id of each dynamic provider registered with the main thread. */
		readonly registeredClients: Array<string | undefined>;
		/** The authorization servers the user was asked to provide a client for. */
		readonly prompts: string[];
	}

	function createExtHostAuthentication(opened: string[] = []): { extHostAuthentication: ExtHostAuthentication; record: IMainThreadRecord } {
		const record: IMainThreadRecord = { registeredClients: [], prompts: [] };
		const proxy = new class extends mock<Proxied<MainThreadAuthenticationShape>>() {
			override $registerDynamicAuthenticationProvider = async (details: IRegisterDynamicAuthenticationProviderDetails): Promise<void> => { record.registeredClients.push(details.clientId); };
			override $promptForClientRegistration = async (authorizationServer: string) => { record.prompts.push(authorizationServer); return { clientId: 'prompted-client' }; };
			override $setSessionsForDynamicAuthProvider = (): Promise<void> => Promise.resolve();
			override $sendDidChangeSessions = (): Promise<void> => Promise.resolve();
			override $waitForUriHandler = (): Promise<UriComponents> => new Promise<UriComponents>(() => { });
		}();
		const rpc = new class extends mock<IExtHostRpcService>() {
			override getProxy<T>(): Proxied<T> {
				return proxy as unknown as Proxied<T>;
			}
		}();
		const initData = new class extends mock<IExtHostInitDataService>() {
			override environment = { appUriScheme: 'vscode', appName: 'Test' } as IExtHostInitDataService['environment'];
		}();
		const extHostWindow = new class extends mock<IExtHostWindow>() {
			override async openUri(uri: string | URI): Promise<boolean> {
				opened.push(uri.toString());
				return false;
			}
		}();
		const extHostUrls = new class extends mock<IExtHostUrlsService>() {
			override async createAppUri(uri: URI): Promise<URI> {
				return uri;
			}
		}();
		const extHostProgress = new class extends mock<IExtHostProgress>() {
			override async withProgressFromSource<R>(_source: string | INotificationSource, _options: ProgressOptions, task: (progress: Progress<IProgressStepDto>, token: CancellationToken) => Thenable<R>): Promise<R> {
				return task(new Progress<IProgressStepDto>(() => { }), CancellationToken.None);
			}
		}();
		const loggerService = new class extends mock<ILoggerService>() {
			override createLogger(): ILogger {
				return new NullLogger();
			}
		}();
		return { extHostAuthentication: new ExtHostAuthentication(rpc, initData, extHostWindow, extHostUrls, extHostProgress, loggerService, new NullLogService()), record };
	}

	test('only a provider registered for an MCP server refuses an authorization server that does not advertise PKCE S256', async () => {
		const opened: string[] = [];
		const { extHostAuthentication } = createExtHostAuthentication(opened);
		const withoutPkce: IAuthorizationServerMetadata = {
			issuer: 'https://auth.example.com',
			authorization_endpoint: 'https://auth.example.com/authorize',
			token_endpoint: 'https://auth.example.com/token',
			response_types_supported: ['code'],
		};

		const outcomes: string[] = [];
		for (const options of [{ requireAdvertisedPkce: true }, undefined]) {
			const id = await extHostAuthentication.$registerDynamicAuthProvider(URI.parse('https://auth.example.com').toJSON(), withoutPkce, { resource: 'https://mcp.example.com/mcp' }, 'client-id', undefined, [], undefined, options);
			try {
				await extHostAuthentication.$createSession(id, ['mcp.read'], {});
				outcomes.push('signed in');
			} catch (error) {
				outcomes.push(error instanceof OAuthClientError ? error.code : 'no token');
			}
			await extHostAuthentication.$onDidUnregisterAuthenticationProvider(id);
		}
		assert.deepStrictEqual({
			outcomes,
			authorizationRequests: opened.map(uri => new URL(uri).searchParams.get('code_challenge_method')),
		}, {
			// The MCP-server provider refuses before any request; the other sends S256 regardless (the test browser then "fails to open").
			outcomes: ['pkce_unsupported', 'no token'],
			authorizationRequests: ['S256'],
		});
	});

	test('a provider without a client registers dynamically only at an HTTPS or loopback registration endpoint, unless the MCP server allows plain HTTP; otherwise it asks for a client', async () => {
		const { extHostAuthentication, record } = createExtHostAuthentication();
		const metadata = (registrationEndpoint: string): IAuthorizationServerMetadata => ({
			issuer: 'https://auth.example.com',
			authorization_endpoint: 'https://auth.example.com/authorize',
			token_endpoint: 'https://auth.example.com/token',
			registration_endpoint: registrationEndpoint,
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
		});
		const cases: Array<[string, IRegisterDynamicAuthProviderOptions | undefined]> = [
			['http://auth.example.com/register', { requireAdvertisedPkce: true }],
			['http://auth.example.com/register', { requireAdvertisedPkce: true, allowInsecureHttp: true }],
			['http://localhost:4711/register', undefined],
			['https://auth.example.com/register', undefined],
		];
		// The registration of `$registerDynamicAuthProvider` uses the global fetch.
		const registrations: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async input => {
			registrations.push(String(input));
			return new Response(JSON.stringify({ client_id: 'registered-client' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
		};
		try {
			for (const [registrationEndpoint, options] of cases) {
				const id = await extHostAuthentication.$registerDynamicAuthProvider(URI.parse('https://auth.example.com').toJSON(), metadata(registrationEndpoint), { resource: 'https://mcp.example.com/mcp' }, undefined, undefined, [], undefined, options);
				await extHostAuthentication.$onDidUnregisterAuthenticationProvider(id);
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
		assert.deepStrictEqual({ registrations, ...record }, {
			registrations: ['http://auth.example.com/register', 'http://localhost:4711/register', 'https://auth.example.com/register'],
			// Nothing is sent to the plain-HTTP endpoint: the user is asked for a client instead.
			prompts: ['https://auth.example.com/'],
			registeredClients: ['prompted-client', 'registered-client', 'registered-client', 'registered-client'],
		});
	});
});

suite('Account Icon Revival', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const iconComponents: UriComponents = { scheme: 'https', authority: 'example.com', path: '/avatar.png', query: '', fragment: '' };

	test('reviveAccountIcon revives a present icon into a URI and leaves a missing icon undefined', () => {
		const withIcon: { id: string; label: string; icon?: UriComponents } = { id: 'account-with-icon', label: 'Has Icon', icon: iconComponents };
		const withoutIcon: { id: string; label: string; icon?: UriComponents } = { id: 'account-without-icon', label: 'No Icon' };

		assert.deepStrictEqual(
			[reviveAccountIcon(withIcon), reviveAccountIcon(withoutIcon)],
			[
				{ ...withIcon, icon: URI.from(iconComponents) },
				{ ...withoutIcon, icon: undefined }
			]
		);
	});
});
