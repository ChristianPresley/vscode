/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ProgressOptions } from 'vscode';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { IAuthorizationServerMetadata, OAuthClientError } from '../../../../base/common/oauth.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, NullLogger } from '../../../../platform/log/common/log.js';
import { INotificationSource } from '../../../../platform/notification/common/notification.js';
import { Progress } from '../../../../platform/progress/common/progress.js';
import { IAuthenticationProviderSessionOptions } from '../../../services/authentication/common/authentication.js';
import { DynamicAuthProvider, IAuthorizationToken, reviveAccountIcon, TokenStore } from '../../common/extHostAuthentication.js';
import { IProgressStepDto, MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
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

		protected override async _generateNewClientId(): Promise<void> {
			this.generateNewClientIdCalls++;
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
		readonly resource: string;
		readonly initialTokens?: IAuthorizationToken[];
		readonly fetcher?: typeof fetch;
		readonly onDidOpenUri?: (uri: string) => void;
		readonly clientSecret?: string;
		readonly logger?: ILogger;
		/** The query of the redirect the URI handler receives; without it the browser "fails to open". */
		readonly redirectQuery?: (authorizationUrl: URL) => string;
	}): TestDynamicAuthProvider {
		const loggerService = new class extends mock<ILoggerService>() {
			override createLogger(): ILogger {
				return options.logger ?? new NullLogger();
			}
		}();
		const opened = new DeferredPromise<URL>();
		const proxy = new class extends mock<Proxied<MainThreadAuthenticationShape>>() {
			override $setSessionsForDynamicAuthProvider = (): Promise<void> => Promise.resolve();
			// Never settles without a redirect, so an abandoned authorization flow leaves no rejected promise behind.
			override $waitForUriHandler = async (expected: UriComponents): Promise<UriComponents> => {
				const redirectQuery = options.redirectQuery;
				if (!redirectQuery) {
					return new Promise<UriComponents>(() => { });
				}
				return { ...expected, query: redirectQuery(await opened.p) };
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
				return uri;
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
		return disposables.add(new TestDynamicAuthProvider(
			extHostWindow,
			extHostUrls,
			initData,
			extHostProgress,
			loggerService,
			proxy,
			URI.parse(options.authorizationServer),
			options.serverMetadata,
			{ resource: options.resource },
			'client-id',
			options.clientSecret,
			disposables.add(new Emitter()),
			options.initialTokens ?? [],
			options.fetcher,
		));
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

	test('refuses the authorization code flow when PKCE S256 is not advertised', async () => {
		const openedUris: string[] = [];
		const withoutPkce: IAuthorizationServerMetadata = { ...servers.nonMicrosoft.serverMetadata, code_challenge_methods_supported: undefined };
		const provider = createProvider({ ...servers.nonMicrosoft, serverMetadata: withoutPkce, resource, onDidOpenUri: uri => openedUris.push(uri) });

		await expectOAuthError(provider.createSession(['api://res/Read'], {}), 'pkce_unsupported');
		assert.deepStrictEqual(openedUris, [], 'no authorization request is made');
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
