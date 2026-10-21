/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ProgressOptions } from 'vscode';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { IAuthorizationServerMetadata, IAuthorizationTokenResponse, OAuthClientError } from '../../../../base/common/oauth.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, NullLogger } from '../../../../platform/log/common/log.js';
import { INotificationSource } from '../../../../platform/notification/common/notification.js';
import { Progress } from '../../../../platform/progress/common/progress.js';
import { Proxied } from '../../../services/extensions/common/proxyIdentifier.js';
import { IProgressStepDto, MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import { MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION } from '../../common/mcpOAuthClientFactory.js';
import { NodeDynamicAuthProvider } from '../../node/extHostAuthentication.js';
import { ILoopbackServer, IOAuthResult } from '../../node/loopbackServer.js';

/** A loopback server that answers the flow with one prepared authorization response. */
class StubLoopbackServer implements ILoopbackServer {
	readonly state = 'state-sent';
	readonly redirectUri = 'http://127.0.0.1:33418/';
	started = false;

	constructor(private readonly _response: (sentState: string) => IOAuthResult) { }

	async start(): Promise<void> {
		this.started = true;
	}

	async stop(): Promise<void> { }

	waitForOAuthResponse(): Promise<IOAuthResult> {
		return Promise.resolve(this._response(this.state));
	}
}

suite('NodeDynamicAuthProvider - loopback flow', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const issuer = 'https://auth.example.com';
	const serverMetadata: IAuthorizationServerMetadata = {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		response_types_supported: ['code'],
		code_challenge_methods_supported: ['S256'],
		authorization_response_iss_parameter_supported: true,
	};

	class TestNodeDynamicAuthProvider extends NodeDynamicAuthProvider {
		response: (sentState: string) => IOAuthResult = () => ({});
		readonly servers: StubLoopbackServer[] = [];
		readonly exchanged: Array<{ code: string; redirectUri: string }> = [];

		protected override _createLoopbackServer(): ILoopbackServer {
			const server = new StubLoopbackServer(this.response);
			this.servers.push(server);
			return server;
		}

		protected override async exchangeCodeForToken(code: string, _codeVerifier: string, redirectUri: string): Promise<IAuthorizationTokenResponse> {
			this.exchanged.push({ code, redirectUri });
			return { access_token: 'access-token', token_type: 'Bearer' };
		}
	}

	function createProvider(response: (sentState: string) => IOAuthResult, metadata: IAuthorizationServerMetadata = serverMetadata): { provider: TestNodeDynamicAuthProvider; opened: URL[] } {
		const opened: URL[] = [];
		const loggerService = new class extends mock<ILoggerService>() {
			override createLogger(): ILogger {
				return new NullLogger();
			}
		}();
		const proxy = new class extends mock<Proxied<MainThreadAuthenticationShape>>() {
			override $setSessionsForDynamicAuthProvider = (): Promise<void> => Promise.resolve();
			// Only redirects the browser back to the app; it never settles here.
			override $waitForUriHandler = (): Promise<UriComponents> => new Promise<UriComponents>(() => { });
			override $showContinueNotification = (): Promise<boolean> => Promise.resolve(false);
		}();
		const extHostWindow = new class extends mock<IExtHostWindow>() {
			override async openUri(uri: string | URI): Promise<boolean> {
				opened.push(new URL(uri.toString()));
				return true;
			}
		}();
		const extHostUrls = new class extends mock<IExtHostUrlsService>() {
			override async createAppUri(uri: URI): Promise<URI> {
				return uri;
			}
		}();
		const initData = new class extends mock<IExtHostInitDataService>() {
			override environment = { appUriScheme: 'vscode', appName: 'Test' } as IExtHostInitDataService['environment'];
			override remote = { isRemote: false, authority: undefined, connectionData: null } as IExtHostInitDataService['remote'];
		}();
		const extHostProgress = new class extends mock<IExtHostProgress>() {
			override async withProgressFromSource<R>(_source: string | INotificationSource, _options: ProgressOptions, task: (progress: Progress<IProgressStepDto>, token: CancellationToken) => Thenable<R>): Promise<R> {
				return task(new Progress<IProgressStepDto>(() => { }), CancellationToken.None);
			}
		}();
		const provider = disposables.add(new TestNodeDynamicAuthProvider(
			extHostWindow,
			extHostUrls,
			initData,
			extHostProgress,
			loggerService,
			proxy,
			URI.parse(issuer),
			metadata,
			{ resource: 'https://mcp.example.com/mcp' },
			'client-id',
			undefined,
			disposables.add(new Emitter()),
			[],
		));
		provider.response = response;
		return { provider, opened };
	}

	test('validates iss, then state, then an error before the code is exchanged', async () => {
		const cases: Array<[string, (sentState: string) => IOAuthResult]> = [
			['valid', state => ({ code: 'the-code', state, iss: issuer })],
			// A foreign issuer is rejected before anything else, its error included.
			['foreign issuer with an error', state => ({ error: 'access_denied', errorDescription: 'Call 555-0100', state, iss: 'https://evil.example.com' })],
			['foreign issuer with a forged state', () => ({ code: 'the-code', state: 'forged', iss: 'https://evil.example.com' })],
			['missing iss although advertised', state => ({ code: 'the-code', state })],
			// The state is checked before an error.
			['forged state with an error', () => ({ error: 'access_denied', state: 'forged', iss: issuer })],
			['forged state', () => ({ code: 'the-code', state: 'forged', iss: issuer })],
			// Only once iss and state are valid is the authorization server's error surfaced.
			['error', state => ({ error: 'access_denied', errorDescription: 'Not today', state, iss: issuer })],
		];
		const outcomes: Record<string, string> = {};
		for (const [name, response] of cases) {
			const { provider, opened } = createProvider(response);
			let outcome: string;
			try {
				await provider.createSession(['mcp.read'], {});
				outcome = 'signed in';
			} catch (error) {
				outcome = error instanceof OAuthClientError ? error.code : `unexpected: ${String(error)}`;
				if (error instanceof OAuthClientError && error.code === 'authorization_denied') {
					outcome += ` (${error.message.includes('Not today') ? 'with' : 'without'} the description)`;
				}
			}
			const authorizationRequest = opened[0];
			outcomes[name] = `${outcome}; ${provider.exchanged.length} exchange(s); state sent: ${authorizationRequest?.searchParams.get('state') === provider.servers[0]?.state}; redirect: ${authorizationRequest?.searchParams.get('redirect_uri')}`;
		}
		const exchanged = '1 exchange(s); state sent: true; redirect: http://127.0.0.1:33418/';
		const refused = '0 exchange(s); state sent: true; redirect: http://127.0.0.1:33418/';
		assert.deepStrictEqual(outcomes, {
			'valid': `signed in; ${exchanged}`,
			'foreign issuer with an error': `iss_mismatch; ${refused}`,
			'foreign issuer with a forged state': `iss_mismatch; ${refused}`,
			'missing iss although advertised': `iss_missing; ${refused}`,
			'forged state with an error': `state_mismatch; ${refused}`,
			'forged state': `state_mismatch; ${refused}`,
			'error': `authorization_denied (with the description); ${refused}`,
		});
	});

	test('the device authorization endpoint follows the rule of the authorization and token endpoints: HTTPS or loopback, unless the MCP server allows plain HTTP', async () => {
		const requested: string[] = [];
		const originalFetch = globalThis.fetch;
		// The device flow uses the global fetch; any answer is a failed request, which is enough to see where it went.
		globalThis.fetch = async input => {
			requested.push(String(input));
			return new Response('{}', { status: 400, headers: { 'Content-Type': 'application/json' } });
		};
		const outcomes: Record<string, string> = {};
		try {
			for (const [name, endpoint, options] of [
				['cleartext', 'http://auth.example.com/device', {}],
				['cleartext, allowed', 'http://auth.example.com/device', { [MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION]: true }],
				['loopback', 'http://127.0.0.1:4711/device', {}],
				['https', `${issuer}/device`, {}],
			] as const) {
				// Without an authorization endpoint the device code flow is the only one.
				const { provider } = createProvider(() => ({}), { issuer, token_endpoint: `${issuer}/token`, device_authorization_endpoint: endpoint, response_types_supported: ['code'] });
				const before = requested.length;
				const outcome = await provider.createSession(['mcp.read'], options).then(() => 'signed in', (error: unknown) => error instanceof OAuthClientError ? `${error.code} (${error.message})` : 'request failed');
				outcomes[name] = `${outcome}, ${requested.slice(before).join(' ') || 'nothing requested'}`;
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
		assert.deepStrictEqual(outcomes, {
			// The message is the user's to read: the localized one of the extension host's providers.
			'cleartext': `insecure_endpoint (The device authorization endpoint 'http://auth.example.com/device' is not served over HTTPS, so no device code is requested there.), nothing requested`,
			'cleartext, allowed': 'request failed, http://auth.example.com/device',
			'loopback': 'request failed, http://127.0.0.1:4711/device',
			'https': `request failed, ${issuer}/device`,
		});
	});
});
