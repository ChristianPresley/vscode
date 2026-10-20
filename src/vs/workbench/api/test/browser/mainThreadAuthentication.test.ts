/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../base/common/event.js';
import { IAuthorizationServerMetadata, OAuthTokenEndpointAuthMethod } from '../../../../base/common/oauth.js';
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
import { IURLService } from '../../../../platform/url/common/url.js';
import { mcpOAuthClientSecretStorageKey } from '../../../contrib/mcp/common/mcpTypes.js';
import { IAuthenticationAccessService } from '../../../services/authentication/browser/authenticationAccessService.js';
import { IAuthenticationUsageService } from '../../../services/authentication/browser/authenticationUsageService.js';
import { AuthenticationSession, IAuthenticationExtensionsService, IAuthenticationProvider, IAuthenticationProviderHostDelegate, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IDynamicAuthenticationProviderClientRegistration, IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { Dto } from '../../../services/extensions/common/proxyIdentifier.js';
import { MainThreadAuthentication, reviveAuthenticationSession } from '../../browser/mainThreadAuthentication.js';
import { ExtHostAuthenticationShape } from '../../common/extHost.protocol.js';
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

	function createHarness(options: { readonly stored?: IDynamicAuthenticationProviderClientRegistration; readonly clientIdMetadataUrl?: string; readonly input?: string } = {}) {
		const registerCalls: IRegisterCall[] = [];
		const stored: Array<{ providerId: string; clientId: string; clientSecret?: string; tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod }> = [];
		const secrets = new Map<string, string>();
		let delegate: IAuthenticationProviderHostDelegate | undefined;
		const proxy: Partial<ExtHostAuthenticationShape> = {
			async $registerDynamicAuthProvider(_authorizationServer, _serverMetadata, _resource, clientId, clientSecret, _initialTokens, tokenEndpointAuthMethod) {
				registerCalls.push({ clientId, clientSecret, tokenEndpointAuthMethod });
				return 'provider-id';
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
		services.stub(IURLService, {});
		services.stub(IClipboardService, {});
		services.stub(IQuickInputService, { async input() { return options.input; } });
		services.stub(IConfigurationService, {});
		services.stub(ISecretStorageService, {
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
		return { mainThread, delegate, registerCalls, stored, secrets };
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
});
