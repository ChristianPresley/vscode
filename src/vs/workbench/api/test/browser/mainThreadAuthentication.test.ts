/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { Event } from '../../../../base/common/event.js';
import { IAuthorizationServerMetadata, OAuthClientError, OAuthTokenEndpointAuthMethod } from '../../../../base/common/oauth.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../platform/telemetry/common/telemetryUtils.js';
import { IURLHandler, IURLService } from '../../../../platform/url/common/url.js';
import { mcpOAuthClientSecretStorageKey } from '../../../contrib/mcp/common/mcpTypes.js';
import { IAuthenticationAccessService } from '../../../services/authentication/browser/authenticationAccessService.js';
import { IAuthenticationUsageService } from '../../../services/authentication/browser/authenticationUsageService.js';
import { AuthenticationSession, IAuthenticationExtensionsService, IAuthenticationProvider, IAuthenticationProviderHostDelegate, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IDynamicAuthenticationProviderClientRegistration, IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { Dto } from '../../../services/extensions/common/proxyIdentifier.js';
import { MainThreadAuthentication, reviveAuthenticationSession } from '../../browser/mainThreadAuthentication.js';
import { ExtHostAuthenticationShape, IRegisterDynamicAuthProviderOptions } from '../../common/extHost.protocol.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

suite('MainThreadAuthentication', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const iconComponents: UriComponents = { scheme: 'https', authority: 'example.com', path: '/avatar.png', query: '', fragment: '' };

	test('revives session URIs and preserves optional session fields', () => {
		const authorizationServer = URI.parse('https://enterprise.example.com/login/oauth');
		const withIcon: Dto<AuthenticationSession> = {
			id: 'session-with-icon',
			accessToken: 'token',
			scopes: ['scope'],
			account: { id: 'account-with-icon', label: 'Has Icon', icon: iconComponents },
			authorizationServer: authorizationServer.toJSON(),
			idToken: 'id-token',
			expiresAfter: 3600
		};
		const withoutIcon: Dto<AuthenticationSession> = {
			id: 'session-without-icon',
			accessToken: 'token',
			scopes: ['scope'],
			account: { id: 'account-without-icon', label: 'No Icon' }
		};

		assert.deepStrictEqual(
			[reviveAuthenticationSession(withIcon), reviveAuthenticationSession(withoutIcon)],
			[
				{ ...withIcon, account: { ...withIcon.account, icon: URI.from(iconComponents) }, authorizationServer },
				{ ...withoutIcon, account: { ...withoutIcon.account, icon: undefined }, authorizationServer: undefined }
			]
		);
	});
});

suite('MainThreadAuthentication - dynamic providers', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	interface IRegisterCall {
		readonly clientId: string | undefined;
		readonly clientSecret: string | undefined;
		readonly tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod | undefined;
	}

	function createHarness(options: { readonly stored?: IDynamicAuthenticationProviderClientRegistration; readonly clientIdMetadataUrl?: string; readonly input?: string; readonly urlService?: Partial<IURLService> } = {}) {
		const registerCalls: IRegisterCall[] = [];
		const registerOptions: Array<IRegisterDynamicAuthProviderOptions | undefined> = [];
		const xaaRegistrations: IAuthorizationServerMetadata[] = [];
		const stored: Array<{ providerId: string; clientId: string; clientSecret?: string; tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod }> = [];
		const secrets = new Map<string, string>();
		let delegate: IAuthenticationProviderHostDelegate | undefined;
		const proxy: Partial<ExtHostAuthenticationShape> = {
			async $registerDynamicAuthProvider(_authorizationServer, _serverMetadata, _resource, clientId, clientSecret, _initialTokens, tokenEndpointAuthMethod, registrationOptions) {
				registerCalls.push({ clientId, clientSecret, tokenEndpointAuthMethod });
				registerOptions.push(registrationOptions);
				return 'provider-id';
			},
			async $registerXaaAuthProvider(_issuer, serverMetadata) {
				xaaRegistrations.push(serverMetadata);
				return 'xaa-provider-id';
			},
		};
		const services = disposables.add(new TestInstantiationService());
		services.stub(IProductService, { authClientIdMetadataUrl: options.clientIdMetadataUrl });
		services.stub(IAuthenticationService, {
			onDidChangeSessions: Event.None,
			onDidUnregisterAuthenticationProvider: Event.None,
			declaredProviders: [],
			// The service owns registered providers.
			registerAuthenticationProvider(_id: string, provider: IAuthenticationProvider) { disposables.add(provider as IAuthenticationProvider & IDisposable); },
			registerAuthenticationProviderHostDelegate(d: IAuthenticationProviderHostDelegate) {
				delegate = d;
				return { dispose() { } };
			},
		});
		services.stub(IAuthenticationExtensionsService, { onDidChangeAccountPreference: Event.None });
		services.stub(IAuthenticationAccessService, {});
		services.stub(IAuthenticationUsageService, {});
		services.stub(IDialogService, {});
		services.stub(INotificationService, {});
		services.stub(IExtensionService, {});
		services.stub(ITelemetryService, NullTelemetryService);
		services.stub(IOpenerService, {});
		services.stub(ILogService, new NullLogService());
		services.stub(IURLService, options.urlService ?? {});
		services.stub(IClipboardService, {});
		services.stub(IQuickInputService, { async input() { return options.input; } });
		services.stub(IConfigurationService, { getValue: () => undefined });
		services.stub(ISecretStorageService, {
			async get(key: string) { return secrets.get(key); },
			async set(key: string, value: string) { secrets.set(key, value); },
			async delete(key: string) { secrets.delete(key); },
		});
		services.stub(IDynamicAuthenticationProviderStorageService, {
			onDidChangeTokens: Event.None,
			async getClientRegistration() { return options.stored; },
			async getSessionsForDynamicAuthProvider() { return undefined; },
			async storeClientRegistration(providerId: string, _authorizationServer: string, clientId: string, clientSecret?: string, _label?: string, tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod) {
				stored.push({ providerId, clientId, clientSecret, tokenEndpointAuthMethod });
			},
		});
		const mainThread = disposables.add(services.createInstance(MainThreadAuthentication, SingleProxyRPCProtocol(proxy)));
		if (!delegate) {
			throw new Error('the host delegate is not registered');
		}
		return { mainThread, delegate, registerCalls, registerOptions, xaaRegistrations, stored, secrets };
	}

	const metadata = (cimd: boolean): IAuthorizationServerMetadata => ({ issuer: 'https://as.example', response_types_supported: ['code'], client_id_metadata_document_supported: cimd });

	test('a stored registration hands its token endpoint authentication method to the extension host', async () => {
		const { delegate, registerCalls } = createHarness({ stored: { clientId: 'stored-client', clientSecret: 'stored-secret', tokenEndpointAuthMethod: 'client_secret_post' } });
		await delegate.create(URI.parse('https://as.example'), metadata(false), undefined);
		await delegate.create(URI.parse('https://as.example'), metadata(false), undefined, 'configured-client', 'configured-secret');
		assert.deepStrictEqual(registerCalls, [
			{ clientId: 'stored-client', clientSecret: 'stored-secret', tokenEndpointAuthMethod: 'client_secret_post' },
			// A configured client is not the stored registration: its method is chosen anew.
			{ clientId: 'configured-client', clientSecret: 'configured-secret', tokenEndpointAuthMethod: undefined },
		]);
	});

	test('a client ID metadata document URL is only used when it is a valid https URL with a path', async () => {
		const valid = createHarness({ clientIdMetadataUrl: 'https://vscode.dev/oauth/client-metadata.json' });
		await valid.delegate.create(URI.parse('https://as.example'), metadata(true), undefined);
		const invalid = createHarness({ clientIdMetadataUrl: 'http://vscode.dev/client-metadata.json' });
		await invalid.delegate.create(URI.parse('https://as.example'), metadata(true), undefined);
		const unsupported = createHarness({ clientIdMetadataUrl: 'https://vscode.dev/oauth/client-metadata.json' });
		await unsupported.delegate.create(URI.parse('https://as.example'), metadata(false), undefined);
		assert.deepStrictEqual([valid, invalid, unsupported].map(h => h.registerCalls[0]), [
			{ clientId: 'https://vscode.dev/oauth/client-metadata.json', clientSecret: undefined, tokenEndpointAuthMethod: 'none' },
			{ clientId: undefined, clientSecret: undefined, tokenEndpointAuthMethod: undefined },
			{ clientId: undefined, clientSecret: undefined, tokenEndpointAuthMethod: undefined },
		]);
	});

	test('registering and updating a dynamic provider persists its token endpoint authentication method', async () => {
		const { mainThread, stored } = createHarness();
		await mainThread.$registerDynamicAuthenticationProvider({ id: 'p', label: 'P', supportsMultipleAccounts: true, authorizationServer: URI.parse('https://as.example').toJSON(), clientId: 'c', clientSecret: 's', tokenEndpointAuthMethod: 'client_secret_basic' });
		assert.deepStrictEqual(stored, [{ providerId: 'p', clientId: 'c', clientSecret: 's', tokenEndpointAuthMethod: 'client_secret_basic' }]);
	});

	test('a prompted resource client secret is stored unbound, to be bound to an issuer on first use', async () => {
		const { mainThread, secrets } = createHarness({ input: '  typed-secret ' });
		assert.strictEqual(await mainThread.$promptForResourceClientSecret('resource-client', 'https://resource.example/mcp'), 'typed-secret');
		assert.deepStrictEqual(JSON.parse(secrets.get(mcpOAuthClientSecretStorageKey('https://resource.example/mcp', 'resource-client'))!), { clientSecret: 'typed-secret' });
	});

	test('a prompted resource client secret keeps the issuer binding its key already carries', async () => {
		const { mainThread, secrets } = createHarness({ input: 'typed-secret' });
		const key = mcpOAuthClientSecretStorageKey('https://resource.example/mcp', 'resource-client');
		secrets.set(key, JSON.stringify({ issuer: 'https://resource-as.example' }));
		await mainThread.$promptForResourceClientSecret('resource-client', 'https://resource.example/mcp');
		assert.deepStrictEqual(JSON.parse(secrets.get(key)!), { clientSecret: 'typed-secret', issuer: 'https://resource-as.example' });
	});

	test('concurrent URL handler sign-ins to one authorization server each receive the redirect carrying their own nonce', async () => {
		// The URL service hands a URI to the first handler that accepts it.
		const handlers = new Set<IURLHandler>();
		const urlService: Partial<IURLService> = {
			registerHandler(handler: IURLHandler): IDisposable {
				handlers.add(handler);
				return { dispose: () => handlers.delete(handler) };
			},
		};
		const open = async (uri: string): Promise<boolean> => {
			for (const handler of [...handlers]) {
				if (await handler.handleURL(URI.parse(uri))) {
					return true;
				}
			}
			return false;
		};
		const { mainThread } = createHarness({ urlService });
		const callback = (nonce: string) => URI.parse(`vscode://dynamicauthprovider/as.example/authorize?nonce=${nonce}`).toJSON();

		const first = mainThread.$waitForUriHandler(callback('first'));
		const second = mainThread.$waitForUriHandler(callback('second'));
		// The second flow's redirect arrives first; one without a nonce or with another belongs to neither.
		const handled = [
			await open('vscode://dynamicauthprovider/as.example/authorize?code=forged'),
			await open('vscode://dynamicauthprovider/as.example/authorize?nonce=third&code=forged'),
			await open('vscode://dynamicauthprovider/as.example/authorize?nonce=second&windowId=1&code=code-2'),
			await open('vscode://dynamicauthprovider/as.example/authorize?nonce=first&windowId=1&code=code-1'),
		];

		assert.deepStrictEqual({
			handled,
			first: (await first).query,
			second: (await second).query,
			handlersLeft: handlers.size,
		}, {
			handled: [false, false, true, true],
			first: 'nonce=first&windowId=1&code=code-1',
			second: 'nonce=second&windowId=1&code=code-2',
			handlersLeft: 0,
		});
	});

	test('a URL handler sign-in that gets no redirect gives up after 5 minutes and unregisters its handler', async () => {
		const clock = sinon.useFakeTimers();
		try {
			const handlers = new Set<IURLHandler>();
			const urlService: Partial<IURLService> = {
				registerHandler(handler: IURLHandler): IDisposable {
					handlers.add(handler);
					return { dispose: () => handlers.delete(handler) };
				},
			};
			const { mainThread } = createHarness({ urlService });
			let outcome: string | undefined;
			const waiting = mainThread.$waitForUriHandler(URI.parse('vscode://dynamicauthprovider/as.example/authorize?nonce=n').toJSON()).then(
				() => outcome = 'resolved',
				(error: Error) => outcome = error.message,
			);
			await clock.tickAsync(5 * 60 * 1000 - 1);
			const before = { outcome, handlers: handlers.size };
			await clock.tickAsync(1);
			await waiting;
			assert.deepStrictEqual({ before, after: { outcome, handlers: handlers.size } }, {
				before: { outcome: undefined, handlers: 1 },
				after: { outcome: 'Timed out waiting for URI handler', handlers: 0 },
			});
		} finally {
			clock.restore();
		}
	});

	test('an enterprise-managed sign-in only uses identity provider metadata whose issuer is the configured one', async () => {
		const outcomes: Record<string, string> = {};
		const cases: Record<string, { readonly configured: string; readonly published: string }> = {
			'bare origin, published without a slash': { configured: 'https://idp.example', published: 'https://idp.example' },
			'bare origin, published with a slash': { configured: 'https://idp.example', published: 'https://idp.example/' },
			'path, published as configured': { configured: 'https://idp.example/tenant', published: 'https://idp.example/tenant' },
			'path, published with a slash': { configured: 'https://idp.example/tenant', published: 'https://idp.example/tenant/' },
			'another issuer': { configured: 'https://idp.example', published: 'https://attacker.example' },
		};
		for (const [name, { configured, published }] of Object.entries(cases)) {
			const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () => new Response(JSON.stringify({
				issuer: published,
				authorization_endpoint: `${published.replace(/\/$/, '')}/authorize`,
				token_endpoint: `${published.replace(/\/$/, '')}/token`,
				response_types_supported: ['code'],
			}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
			try {
				const { delegate, xaaRegistrations } = createHarness();
				try {
					await delegate.createXaa!(URI.parse(configured));
					outcomes[name] = `registered with ${xaaRegistrations.map(m => m.token_endpoint).join()}`;
				} catch (error) {
					outcomes[name] = `${error instanceof OAuthClientError ? error.code : String(error)} (${xaaRegistrations.length} registered)`;
				}
			} finally {
				fetchStub.restore();
			}
		}
		assert.deepStrictEqual(outcomes, {
			'bare origin, published without a slash': 'registered with https://idp.example/token',
			'bare origin, published with a slash': 'registered with https://idp.example/token',
			'path, published as configured': 'registered with https://idp.example/tenant/token',
			'path, published with a slash': 'issuer_mismatch (0 registered)',
			'another issuer': 'issuer_mismatch (0 registered)',
		});
	});

	test('the PKCE and registration endpoint policies of a dynamic provider reach the extension host', async () => {
		const { delegate, registerOptions } = createHarness();
		await delegate.create(URI.parse('https://as.example'), metadata(false), undefined, undefined, undefined, { requireAdvertisedPkce: true });
		await delegate.create(URI.parse('https://as.example'), metadata(false), undefined);
		await delegate.create(URI.parse('https://as.example'), metadata(false), undefined, undefined, undefined, { requireAdvertisedPkce: true, allowInsecureHttp: true });
		await delegate.create(URI.parse('https://as.example'), metadata(false), undefined, undefined, undefined, { allowInsecureHttp: true });
		assert.deepStrictEqual(registerOptions, [{ requireAdvertisedPkce: true }, undefined, { requireAdvertisedPkce: true, allowInsecureHttp: true }, { allowInsecureHttp: true }]);
	});
});
