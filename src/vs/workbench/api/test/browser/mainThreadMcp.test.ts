/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { URI } from '../../../../base/common/uri.js';
import { mock } from '../../../../base/test/common/mock.js';
import { createAuthorizationServerFixture, createOAuthFixture, IOAuthFixture, IOAuthFixtureOptions } from '../../../../base/test/common/oauthClientFixture.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ConfigurationTarget, IConfigurationOverrides, IConfigurationService, IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { TestInstantiationService } from '../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { IMcpServerMatcher } from '../../../../platform/mcp/common/allowedMcpServers.js';
import { AllowedMcpServersService } from '../../../../platform/mcp/common/allowedMcpServersService.js';
import { IMcpGatewayCreateOptions } from '../../../../platform/mcp/common/mcpGateway.js';
import { IAllowedMcpServersService, mcpAccessConfig, mcpAllowedServersConfig, mcpDeniedServersConfig, McpAccessValue } from '../../../../platform/mcp/common/mcpManagement.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IMcpGatewayResult, IMcpGatewayResultServer, IWorkbenchMcpGatewayService } from '../../../contrib/mcp/common/mcpGatewayService.js';
import { IMcpHostDelegate, IMcpRegistry } from '../../../contrib/mcp/common/mcpRegistryTypes.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpCollectionDefinition, McpCollectionSortOrder, McpConnectionState, McpServerDefinition, McpServerLaunch, McpServerTransportHTTP, McpServerTransportType, McpServerTrust, mcpOAuthClientSecretStorageKey, UserInteractionRequiredError } from '../../../contrib/mcp/common/mcpTypes.js';
import { IAuthorizationProtectedResourceMetadata, IAuthorizationServerMetadata, OAuthClientError } from '../../../../base/common/oauth.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { mcpEnterpriseManagedAuthIdpSection } from '../../../contrib/mcp/common/mcpConfiguration.js';
import { IAuthenticationMcpAccessService } from '../../../services/authentication/browser/authenticationMcpAccessService.js';
import { IAuthenticationMcpService } from '../../../services/authentication/browser/authenticationMcpService.js';
import { IAuthenticationMcpUsageService } from '../../../services/authentication/browser/authenticationMcpUsageService.js';
import { AuthenticationSession, AuthenticationSessionsChangeEvent, IAuthenticationGetSessionsOptions, IAuthenticationProvider, IAuthenticationService, IAuthenticationWwwAuthenticateRequest, IDynamicAuthenticationProviderOptions } from '../../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { ExtensionHostKind } from '../../../services/extensions/common/extensionHostKind.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { TestExtensionService } from '../../../test/common/workbenchTestServices.js';
import { IMcpServerAuthContext, MainThreadMcp, McpServerAuthTracker } from '../../browser/mainThreadMcp.js';
import { ExtHostContext, ExtHostMcpShape, IMcpAuthenticationDetails, IMcpGatewayServerDto, IMcpGatewayStartOptionsDto, MainContext } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { CommonRequestInit, CommonResponse, createAuthMetadata, ExtHostMcpService, McpHTTPHandle } from '../../common/extHostMcp.js';
import { MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION, MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION } from '../../common/mcpOAuthClientFactory.js';
import { IExtHostVariableResolverProvider } from '../../common/extHostVariableResolverService.js';
import { IExtHostWorkspace } from '../../common/extHostWorkspace.js';
import { SingleProxyRPCProtocol, TestRPCProtocol } from '../common/testRPCProtocol.js';

function createMainThreadMcp(disposables: Pick<DisposableStore, 'add'>, proxy: Partial<ExtHostMcpShape>, registry: IMcpRegistry, configure?: (services: TestInstantiationService) => void, extensionHostKind?: ExtensionHostKind): MainThreadMcp {
	const services = disposables.add(new TestInstantiationService());
	services.stub(IMcpRegistry, registry);
	services.stub(IDialogService, {});
	services.stub(IAuthenticationService, { onDidChangeSessions: Event.None });
	services.stub(IAuthenticationMcpService, {});
	services.stub(IAuthenticationMcpAccessService, {});
	services.stub(IAuthenticationMcpUsageService, {});
	services.stub(IDynamicAuthenticationProviderStorageService, {});
	services.stub(IExtensionService, new TestExtensionService());
	services.stub(IContextKeyService, {});
	services.stub(ITelemetryService, {});
	services.stub(IWorkbenchMcpGatewayService, {});
	services.stub(IConfigurationService, {});
	services.stub(ISecretStorageService, {});
	services.stub(IAllowedMcpServersService, {
		onDidChangeAllowedMcpServers: Event.None,
		isServerAllowed: () => true,
	});
	configure?.(services);
	const context = SingleProxyRPCProtocol(proxy);
	return disposables.add(services.createInstance(MainThreadMcp, extensionHostKind === undefined ? context : { ...context, extensionHostKind }));
}

suite('MainThreadMcp - McpServerAuthTracker', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Builds a representative auth context. Defaults model a tenant-specific Entra sign-in so tests
	 * assert that the authorization server / resource survive tracking (the values that were dropped
	 * on re-validation in #324925).
	 */
	function ctx(overrides: Partial<IMcpServerAuthContext> = {}): IMcpServerAuthContext {
		return {
			authorizationServer: URI.parse('https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111'),
			clientId: 'client-a',
			resource: 'api://33333333-3333-3333-3333-333333333333',
			audience: undefined,
			...overrides,
		};
	}

	test('retains the full auth context per tracked server and groups by provider', () => {
		const tracker = new McpServerAuthTracker();
		const first = ctx();
		const second = ctx({
			clientId: 'client-b',
			authorizationServer: URI.parse('https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222'),
		});

		tracker.track('microsoft', 1, ['scope.a'], first);
		tracker.track('microsoft', 2, ['scope.b'], second);

		assert.deepStrictEqual(tracker.get('microsoft'), [
			{ serverId: 1, scopes: ['scope.a'], context: first },
			{ serverId: 2, scopes: ['scope.b'], context: second },
		]);
	});

	test('re-tracking the same server replaces its context without duplicating', () => {
		const tracker = new McpServerAuthTracker();
		tracker.track('microsoft', 1, ['scope.a'], ctx());
		const updated = ctx({ authorizationServer: URI.parse('https://login.microsoftonline.com/44444444-4444-4444-4444-444444444444') });
		tracker.track('microsoft', 1, ['scope.a'], updated);

		assert.deepStrictEqual(tracker.get('microsoft'), [
			{ serverId: 1, scopes: ['scope.a'], context: updated },
		]);
	});

	test('untrack removes a server across every provider and drops empty provider buckets', () => {
		const tracker = new McpServerAuthTracker();
		tracker.track('microsoft', 1, ['scope.a'], ctx());
		tracker.track('github', 1, ['repo'], ctx({ authorizationServer: undefined, resource: undefined }));
		tracker.track('microsoft', 2, ['scope.b'], ctx());

		tracker.untrack(1);

		assert.strictEqual(tracker.get('github'), undefined, 'empty provider bucket is removed');
		assert.deepStrictEqual(tracker.get('microsoft'), [
			{ serverId: 2, scopes: ['scope.b'], context: ctx() },
		]);
	});

	test('clear removes all tracking', () => {
		const tracker = new McpServerAuthTracker();
		tracker.track('microsoft', 1, ['scope.a'], ctx());
		tracker.clear();

		assert.strictEqual(tracker.get('microsoft'), undefined);
	});
});

suite('MainThreadMcp - launch', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards the definition default cwd to the extension host', () => {
		let startOptions: Parameters<ExtHostMcpShape['$startMcp']>[1] | undefined;
		const proxy: Partial<ExtHostMcpShape> = {
			$startMcp(_id, options) {
				startOptions = options;
			},
			$stopMcp() { },
			$sendMessage() { },
			$onDidChangeMcpServerDefinitions() { },
		};

		let capturedDelegate: IMcpHostDelegate | undefined;
		const mcpRegistry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate(delegate: IMcpHostDelegate) {
				capturedDelegate = delegate;
				return { dispose() { } };
			}
		};

		createMainThreadMcp(disposables, proxy, mcpRegistry);

		const launch: McpServerLaunch = {
			type: McpServerTransportType.HTTP,
			uri: URI.parse('https://myserver.example/mcp'),
			headers: [],
		};
		const defaultCwd = URI.parse('vscode-remote://ssh-remote+linux/home/test/workspace');
		const serverDefinition: McpServerDefinition = {
			id: 'my-server',
			label: 'My Server',
			launch,
			defaultCwd,
			cacheNonce: 'nonce-1',
			variableReplacement: {
				folder: { uri: URI.file('/fallback'), name: 'fallback', index: 0 },
				target: ConfigurationTarget.WORKSPACE_FOLDER,
			},
		};
		const collection: McpCollectionDefinition = {
			remoteAuthority: 'ssh-remote+linux',
			id: 'collection-1',
			label: 'Collection',
			serverDefinitions: observableValue<readonly McpServerDefinition[]>('serverDefinitions', [serverDefinition]),
			trustBehavior: McpServerTrust.Kind.Trusted,
			scope: StorageScope.WORKSPACE,
			configTarget: ConfigurationTarget.WORKSPACE_FOLDER,
			order: McpCollectionSortOrder.WorkspaceFolder,
		};

		assert.ok(capturedDelegate);
		capturedDelegate.start(collection, serverDefinition, launch, {});
		assert.ok(startOptions?.defaultCwd);
		assert.strictEqual(URI.revive(startOptions.defaultCwd).toString(), defaultCwd.toString());
	});

	test('expands environment variables in the extension host only for flagged definitions', async () => {
		const requests: Parameters<ExtHostMcpShape['$expandEnvironmentVariables']>[] = [];
		const proxy: Partial<ExtHostMcpShape> = {
			async $expandEnvironmentVariables(launch, expansion) {
				requests.push([launch, expansion]);
				return { ...launch, uri: URI.parse('https://expanded.example/mcp').toJSON(), headers: [['Authorization', 'Bearer expanded']] } as McpServerLaunch.Serialized;
			},
			$onDidChangeMcpServerDefinitions() { },
		};

		let capturedDelegate: IMcpHostDelegate | undefined;
		const mcpRegistry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate(delegate: IMcpHostDelegate) {
				capturedDelegate = delegate;
				return { dispose() { } };
			}
		};
		createMainThreadMcp(disposables, proxy, mcpRegistry);
		assert.ok(capturedDelegate);

		const url = 'https://${HOST}/mcp';
		const launch: McpServerLaunch = { type: McpServerTransportType.HTTP, uri: URI.parse(url), headers: [['Authorization', 'Bearer ${TOKEN}']] };
		const definition: McpServerDefinition = { id: 'server', label: 'Server', launch, cacheNonce: 'nonce' };
		const unflagged = await capturedDelegate.expandEnvironmentVariables(definition, launch);
		const expanded = await capturedDelegate.expandEnvironmentVariables({ ...definition, environmentVariableExpansion: { url } }, launch);

		assert.deepStrictEqual({
			unflaggedIsSame: unflagged === launch,
			requests: requests.map(([, expansion]) => expansion),
			expanded: expanded.type === McpServerTransportType.HTTP ? { isUri: URI.isUri(expanded.uri), url: expanded.uri.toString(true), headers: expanded.headers } : undefined,
		}, {
			unflaggedIsSame: true,
			requests: [{ url }],
			expanded: { isUri: true, url: 'https://expanded.example/mcp', headers: [['Authorization', 'Bearer expanded']] },
		});
	});
});

suite('MainThreadMcp - transport seam', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards envelopes and cancellations to the extension host and surfaces aborts', () => {
		const sent: { id: number; message: string; envelope: IMcpMessageEnvelope | undefined }[] = [];
		const cancelled: { id: number; requestId: JsonRpcId }[] = [];
		const proxy: Partial<ExtHostMcpShape> = {
			$startMcp() { },
			$stopMcp() { },
			$sendMessage(id, message, envelope) { sent.push({ id, message, envelope }); },
			$cancelRequest(id, requestId) { cancelled.push({ id, requestId }); },
			$onDidChangeMcpServerDefinitions() { },
		};
		let capturedDelegate: IMcpHostDelegate | undefined;
		const mcpRegistry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate(delegate: IMcpHostDelegate) {
				capturedDelegate = delegate;
				return { dispose() { } };
			}
		};
		const mainThread = createMainThreadMcp(disposables, proxy, mcpRegistry);
		assert.ok(capturedDelegate);

		const launch: McpServerLaunch = { type: McpServerTransportType.HTTP, uri: URI.parse('https://myserver.example/mcp'), headers: [] };
		const serverDefinition: McpServerDefinition = { id: 'seam-server', label: 'Seam', launch, cacheNonce: 'nonce-seam' };
		const collection: McpCollectionDefinition = {
			remoteAuthority: null,
			id: 'collection-seam',
			label: 'Collection',
			serverDefinitions: observableValue<readonly McpServerDefinition[]>('serverDefinitions', [serverDefinition]),
			trustBehavior: McpServerTrust.Kind.Trusted,
			scope: StorageScope.WORKSPACE,
			configTarget: ConfigurationTarget.WORKSPACE_FOLDER,
			order: McpCollectionSortOrder.WorkspaceFolder,
		};
		const transport = disposables.add(capturedDelegate.start(collection, serverDefinition, launch, {}));

		const envelope: IMcpMessageEnvelope = { kind: 'request', requestId: 3, protocolVersion: '2026-07-28', method: 'tools/list', headers: { 'Mcp-Method': 'tools/list' } };
		transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, envelope);
		transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		assert.deepStrictEqual(sent.map(s => s.envelope), [envelope, undefined]);
		assert.strictEqual(sent[0].message, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));

		transport.cancelRequest!(3);
		assert.deepStrictEqual(cancelled, [{ id: sent[0].id, requestId: 3 }]);

		const aborts: IMcpRequestAbort[] = [];
		disposables.add(transport.onDidAbortRequest!(abort => aborts.push(abort)));
		mainThread.$onDidAbortRequest(sent[0].id, { requestId: 3, reason: 'legacy-probe', httpStatus: 400 });
		mainThread.$onDidAbortRequest(sent[0].id + 1000, { requestId: 3, reason: 'legacy-probe' });
		assert.deepStrictEqual(aborts, [{ requestId: 3, reason: 'legacy-probe', httpStatus: 400 }]);
	});
});

suite('MainThreadMcp - re-validation', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	async function assertRevalidationContext(enterpriseManaged: boolean, clientId: string | undefined): Promise<void> {
		const authorizationServer = URI.parse('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47');
		const configuredIssuer = URI.parse('https://sso.example/issuer');
		const resource = 'https://resource.example/mcp';
		const serverUrl = 'https://myserver.example/mcp';
		const audience = enterpriseManaged ? 'https://resource-as.example' : undefined;
		const secretStorageKey = clientId ? mcpOAuthClientSecretStorageKey(enterpriseManaged ? resource : serverUrl, clientId) : undefined;
		const secrets = new Map<string, string>();
		if (secretStorageKey) {
			secrets.set(secretStorageKey, 'original-secret');
		}
		const secretStorageReads: string[] = [];
		const session: AuthenticationSession = {
			id: 'session-1',
			accessToken: 'access-token',
			account: { id: 'account-1', label: 'user@contoso.com' },
			scopes: ['scope.read'],
		};

		const getSessionsOptions: Array<IAuthenticationGetSessionsOptions | undefined> = [];
		let revalidated = new DeferredPromise<void>();

		const onDidChangeSessions = disposables.add(new Emitter<{ providerId: string; label: string; event: AuthenticationSessionsChangeEvent }>());

		const authenticationService = new class extends mock<IAuthenticationService>() {
			override readonly onDidChangeSessions = onDidChangeSessions.event;
			override async getOrActivateProviderIdForServer(): Promise<string | undefined> {
				return 'test-provider';
			}
			override async createOrGetXaaProvider(): Promise<string | undefined> {
				return 'test-provider';
			}
			override isDynamicAuthenticationProvider(): boolean {
				return false;
			}
			override getProvider(id: string): IAuthenticationProvider {
				return new class extends mock<IAuthenticationProvider>() {
					override readonly id = id;
					override readonly label = 'Test Provider';
					override readonly supportsMultipleAccounts = false;
				};
			}
			override async getSessions(_id: string, _scopes?: ReadonlyArray<string> | IAuthenticationWwwAuthenticateRequest, options?: IAuthenticationGetSessionsOptions): Promise<ReadonlyArray<AuthenticationSession>> {
				getSessionsOptions.push(options);
				if (getSessionsOptions.length > 1) {
					revalidated.complete();
				}
				return [session];
			}
		};

		const proxy: Partial<ExtHostMcpShape> = {
			$startMcp() { },
			$stopMcp() { },
			$sendMessage() { },
			$onDidChangeMcpServerDefinitions() { },
		};

		let capturedDelegate: IMcpHostDelegate | undefined;
		const mcpRegistry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate(delegate: IMcpHostDelegate) {
				capturedDelegate = delegate;
				return { dispose() { } };
			}
		};
		const configurationService = new TestConfigurationService({
			[mcpEnterpriseManagedAuthIdpSection]: { issuer: configuredIssuer.toString(true) }
		});
		disposables.add(configurationService.onDidChangeConfigurationEmitter);

		const mainThreadMcp = createMainThreadMcp(disposables, proxy, mcpRegistry, services => {
			services.stub(IAuthenticationService, authenticationService);
			services.stub(IAuthenticationMcpService, { getAccountPreference: () => undefined });
			services.stub(IAuthenticationMcpAccessService, { isAccessAllowedForUrl: () => true });
			services.stub(IAuthenticationMcpUsageService, { addAccountUsage() { } });
			services.stub(IConfigurationService, configurationService);
			services.stub(ISecretStorageService, {
				async get(key: string) {
					secretStorageReads.push(key);
					return secrets.get(key);
				}
			});
		});

		// Register a running HTTP server via the host delegate (the only path into the private maps).
		const launch: McpServerLaunch = { type: McpServerTransportType.HTTP, uri: URI.parse(serverUrl), headers: [] };
		const serverDefinition: McpServerDefinition = { id: 'my-server', label: 'My Server', launch, cacheNonce: 'nonce-1' };
		const collection: McpCollectionDefinition = {
			remoteAuthority: null,
			id: 'collection-1',
			label: 'Collection',
			serverDefinitions: observableValue<readonly McpServerDefinition[]>('serverDefinitions', [serverDefinition]),
			trustBehavior: McpServerTrust.Kind.Trusted,
			scope: StorageScope.WORKSPACE,
			configTarget: ConfigurationTarget.USER,
			order: McpCollectionSortOrder.Extension,
		};
		assert.ok(capturedDelegate, 'the MCP host delegate is registered');
		capturedDelegate.start(collection, serverDefinition, launch, {});
		mainThreadMcp.$onDidChangeState(1, { state: McpConnectionState.Kind.Running });

		const authDetails: IMcpAuthenticationDetails = {
			authorizationServer,
			authorizationServerMetadata: { issuer: authorizationServer.toString(), response_types_supported: ['code'], scopes_supported: ['scope.read'] },
			resourceMetadata: { resource, scopes_supported: ['scope.read'], authorization_servers: ['https://resource-as.example'] },
			scopes: ['scope.read'],
			clientId,
			enterpriseManaged,
		};
		await mainThreadMcp.$getTokenFromServerMetadata(1, authDetails, {});

		for (const secret of ['rotated-secret', undefined]) {
			if (secretStorageKey) {
				if (secret === undefined) {
					secrets.delete(secretStorageKey);
				} else {
					secrets.set(secretStorageKey, secret);
				}
			}
			revalidated = new DeferredPromise<void>();
			onDidChangeSessions.fire({ providerId: 'test-provider', label: 'Test Provider', event: { added: undefined, removed: undefined, changed: undefined } });
			await revalidated.p;
		}

		const expectedSecrets = clientId ? ['original-secret', 'rotated-secret', undefined] : [undefined, undefined, undefined];
		assert.deepStrictEqual({ getSessionsOptions, secretStorageReads }, {
			getSessionsOptions: expectedSecrets.map((clientSecret, index) => ({
				authorizationServer: enterpriseManaged ? configuredIssuer : authorizationServer,
				clientId,
				clientSecret,
				resource,
				audience,
				// The dynamic provider's PKCE rule goes with every request, replays included.
				...(enterpriseManaged ? {} : { [MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION]: true }),
				silent: index > 0,
			})),
			secretStorageReads: secretStorageKey ? [secretStorageKey, secretStorageKey, secretStorageKey] : [],
		});
	}

	test('replays the tracked auth context with a rotated or removed client secret (#324925)', async () => {
		await assertRevalidationContext(false, 'client-abc');
	});

	test('replays XAA resource auth context with a rotated or removed client secret', async () => {
		await assertRevalidationContext(true, 'resource-client');
	});

	test('revalidates clients without a secret-storage key without reading secret storage', async () => {
		await assertRevalidationContext(false, undefined);
	});
});

suite('MainThreadMcp - authorization rules', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const serverUrl = 'https://myserver.example/mcp';
	const asA = 'https://as-a.example';
	const asB = 'https://as-b.example';

	interface IAuthHarness {
		readonly mainThreadMcp: MainThreadMcp;
		readonly secrets: Map<string, string>;
		readonly getSessionsCalls: Array<{ id: string; scopes: ReadonlyArray<string> | IAuthenticationWwwAuthenticateRequest | undefined }>;
		readonly getSessionsOptions: Array<IAuthenticationGetSessionsOptions | undefined>;
		readonly removed: Array<[string, string]>;
		readonly unregistered: string[];
		readonly removedProviders: string[];
		readonly created: string[];
		readonly createdOptions: Array<IDynamicAuthenticationProviderOptions | undefined>;
	}

	function createHarness(options: {
		readonly providerId?: string;
		readonly dynamic?: boolean;
		readonly sessions?: AuthenticationSession[];
		/** The sessions of the provider that have exactly these scopes; overrides {@link sessions}. */
		readonly sessionsFor?: (scopes: ReadonlyArray<string> | IAuthenticationWwwAuthenticateRequest | undefined) => AuthenticationSession[];
		/** Runs on every session lookup (a provider that prompts for a secret, for example). */
		readonly onGetSessions?: (secrets: Map<string, string>) => void;
		readonly oauth?: McpServerTransportHTTP['oauth'];
		readonly interactedProviders?: string[];
		/** The server's launch; an HTTP launch of {@link serverUrl} by default. */
		readonly launch?: McpServerLaunch;
		/** Further servers, started after it with the ids 2, 3, ... */
		readonly moreLaunches?: readonly McpServerLaunch[];
	} = {}): IAuthHarness {
		const secrets = new Map<string, string>();
		const getSessionsCalls: IAuthHarness['getSessionsCalls'] = [];
		const getSessionsOptions: IAuthHarness['getSessionsOptions'] = [];
		const removed: Array<[string, string]> = [];
		const unregistered: string[] = [];
		const removedProviders: string[] = [];
		const created: string[] = [];
		const createdOptions: IAuthHarness['createdOptions'] = [];
		const sessions = options.sessions ?? [{ id: 'session-1', accessToken: 'access-token', account: { id: 'a', label: 'user' }, scopes: [] }];
		const authenticationService = new class extends mock<IAuthenticationService>() {
			override readonly onDidChangeSessions = Event.None;
			override async getOrActivateProviderIdForServer(): Promise<string | undefined> { return options.providerId; }
			override async createOrGetXaaProvider(): Promise<string | undefined> { return 'xaa-provider'; }
			override isDynamicAuthenticationProvider(): boolean { return options.dynamic ?? true; }
			override getProvider(id: string): IAuthenticationProvider {
				return new class extends mock<IAuthenticationProvider>() {
					override readonly id = id;
					override readonly label = 'Test Provider';
					override readonly supportsMultipleAccounts = false;
				};
			}
			override async getSessions(id: string, scopes?: ReadonlyArray<string> | IAuthenticationWwwAuthenticateRequest, sessionOptions?: IAuthenticationGetSessionsOptions): Promise<ReadonlyArray<AuthenticationSession>> {
				getSessionsCalls.push({ id, scopes });
				getSessionsOptions.push(sessionOptions);
				options.onGetSessions?.(secrets);
				return options.sessionsFor ? options.sessionsFor(scopes) : sessions;
			}
			override async removeSession(id: string, sessionId: string): Promise<void> { removed.push([id, sessionId]); }
			override unregisterAuthenticationProvider(id: string): void { unregistered.push(id); }
			override async createDynamicAuthenticationProvider(authorizationServer: URI, _serverMetadata: IAuthorizationServerMetadata, _resource: IAuthorizationProtectedResourceMetadata | undefined, _clientId?: string, _clientSecret?: string, providerOptions?: IDynamicAuthenticationProviderOptions): Promise<IAuthenticationProvider | undefined> {
				const id = `${authorizationServer.toString(true)} ${serverUrl}`;
				created.push(id);
				createdOptions.push(providerOptions);
				return this.getProvider(id);
			}
		};
		const configurationService = new TestConfigurationService({ [mcpEnterpriseManagedAuthIdpSection]: { issuer: 'https://sso.example/issuer' } });
		disposables.add(configurationService.onDidChangeConfigurationEmitter);
		const mcpRegistry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			delegate: IMcpHostDelegate | undefined;
			override registerDelegate(delegate: IMcpHostDelegate) {
				this.delegate = delegate;
				return { dispose() { } };
			}
		};
		const mainThreadMcp = createMainThreadMcp(disposables, { $startMcp() { }, $stopMcp() { }, $sendMessage() { }, $onDidChangeMcpServerDefinitions() { } }, mcpRegistry, services => {
			services.stub(IAuthenticationService, authenticationService);
			services.stub(IAuthenticationMcpService, { getAccountPreference: () => undefined });
			services.stub(IAuthenticationMcpAccessService, { isAccessAllowedForUrl: () => true });
			services.stub(IAuthenticationMcpUsageService, { addAccountUsage() { } });
			services.stub(IConfigurationService, configurationService);
			services.stub(ISecretStorageService, {
				async get(key: string) { return secrets.get(key); },
				async set(key: string, value: string) { secrets.set(key, value); },
			});
			services.stub(IDynamicAuthenticationProviderStorageService, {
				getInteractedProviders: () => (options.interactedProviders ?? []).map(providerId => ({ providerId, label: providerId, authorizationServer: providerId.split(' ')[0], clientId: 'c' })),
				async removeDynamicProvider(providerId: string) { removedProviders.push(providerId); },
				async getClientRegistration() { return undefined; },
			});
		});
		const launch: McpServerLaunch = options.launch ?? { type: McpServerTransportType.HTTP, uri: URI.parse(serverUrl), headers: [], oauth: options.oauth };
		const serverDefinition: McpServerDefinition = { id: 'my-server', label: 'My Server', launch, cacheNonce: 'nonce-1' };
		const collection: McpCollectionDefinition = {
			remoteAuthority: null,
			id: 'collection-1',
			label: 'Collection',
			serverDefinitions: observableValue<readonly McpServerDefinition[]>('serverDefinitions', [serverDefinition]),
			trustBehavior: McpServerTrust.Kind.Trusted,
			scope: StorageScope.WORKSPACE,
			configTarget: ConfigurationTarget.USER,
			order: McpCollectionSortOrder.Extension,
		};
		mcpRegistry.delegate!.start(collection, serverDefinition, launch, {});
		mainThreadMcp.$onDidChangeState(1, { state: McpConnectionState.Kind.Running });
		(options.moreLaunches ?? []).forEach((more, index) => {
			const definition: McpServerDefinition = { id: `my-server-${index + 2}`, label: `My Server ${index + 2}`, launch: more, cacheNonce: 'nonce-1' };
			mcpRegistry.delegate!.start(collection, definition, more, {});
			mainThreadMcp.$onDidChangeState(index + 2, { state: McpConnectionState.Kind.Running });
		});
		return { mainThreadMcp, secrets, getSessionsCalls, getSessionsOptions, removed, unregistered, removedProviders, created, createdOptions };
	}

	function details(issuer: string, overrides: Partial<IMcpAuthenticationDetails> = {}): IMcpAuthenticationDetails {
		return {
			authorizationServer: URI.parse(issuer).toJSON(),
			authorizationServerMetadata: { issuer, response_types_supported: ['code'], scopes_supported: ['as.scope'] },
			resourceMetadata: { resource: serverUrl, authorization_servers: [issuer] },
			scopes: undefined,
			resource: serverUrl,
			...overrides,
		};
	}

	test('a rejected token removes its session, looked up without a scope filter', async () => {
		const sessions: AuthenticationSession[] = [
			{ id: 'old', accessToken: 'rejected-token', account: { id: 'a', label: 'user' }, scopes: ['x'] },
			{ id: 'other', accessToken: 'other-token', account: { id: 'a', label: 'user' }, scopes: [] },
		];
		const { mainThreadMcp, getSessionsCalls, removed } = createHarness({ providerId: 'dynamic-provider', sessions });
		await mainThreadMcp.$getTokenFromServerMetadata(1, details(asA), { rejectedToken: 'rejected-token' });
		assert.deepStrictEqual({ firstLookup: getSessionsCalls[0], removed }, { firstLookup: { id: 'dynamic-provider', scopes: undefined }, removed: [['dynamic-provider', 'old']] });
	});

	test('a rejection never removes the session of a shared, non-dynamic provider', async () => {
		const { mainThreadMcp, removed } = createHarness({ providerId: 'github', dynamic: false });
		await mainThreadMcp.$getTokenFromServerMetadata(1, details(asA), { rejectedToken: 'access-token' });
		assert.deepStrictEqual(removed, []);
	});

	test('scopes fall back to the authorization server only for servers without protected resource metadata', async () => {
		const withPrm = createHarness({ providerId: 'p' });
		await withPrm.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA), {});
		const withoutPrm = createHarness({ providerId: 'p' });
		await withoutPrm.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { resourceMetadata: undefined }), {});
		const challenged = createHarness({ providerId: 'p' });
		await challenged.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { scopes: ['challenge.scope'] }), {});
		assert.deepStrictEqual([withPrm, withoutPrm, challenged].map(h => h.getSessionsCalls[0].scopes), [[], ['as.scope'], ['challenge.scope']]);
	});

	test('pre-registered credentials are bound to the issuer of their first successful use and never sent to another', async () => {
		const harness = createHarness({ providerId: 'p' });
		const key = mcpOAuthClientSecretStorageKey(serverUrl, 'static-client');
		harness.secrets.set(key, 'static-secret');
		await harness.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { clientId: 'static-client' }), {});
		assert.deepStrictEqual(JSON.parse(harness.secrets.get(key)!), { clientSecret: 'static-secret', issuer: asA });

		const lookups = harness.getSessionsCalls.length;
		await assert.rejects(harness.mainThreadMcp.$getTokenFromServerMetadata(1, details(asB, { clientId: 'static-client' }), {}), (error: unknown) => {
			assert.ok(error instanceof OAuthClientError && error.code === 'issuer_not_registered');
			assert.ok(error.message.includes(asA) && error.message.includes(asB), error.message);
			return true;
		});
		assert.strictEqual(harness.getSessionsCalls.length, lookups, 'nothing was requested from the other authorization server');
	});

	test('a configured oauth.authorizationServer binds the client from the start', async () => {
		const oauthConfig: IMcpRemoteServerOAuthConfiguration = { clientId: 'static-client', authorizationServer: asA };
		const { mainThreadMcp, getSessionsCalls } = createHarness({ providerId: 'p', oauth: oauthConfig });
		await assert.rejects(mainThreadMcp.$getTokenFromServerMetadata(1, details(asB, { clientId: 'static-client' }), {}), /registered with the authorization server/);
		assert.deepStrictEqual(getSessionsCalls, []);
		await mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { clientId: 'static-client' }), {});
		assert.strictEqual(getSessionsCalls.length, 1);
	});

	test('a new authorization server for the resource retires the dynamic provider of the previous one', async () => {
		const stale = `${URI.parse(asA).toString(true)} ${serverUrl}`;
		const unrelated = `${URI.parse(asA).toString(true)} https://other.example/mcp`;
		const { mainThreadMcp, unregistered, removedProviders, created } = createHarness({ providerId: undefined, interactedProviders: [stale, unrelated] });
		await mainThreadMcp.$getTokenFromServerMetadata(1, details(asB), {});
		assert.deepStrictEqual({ unregistered, removedProviders, created }, { unregistered: [stale], removedProviders: [stale], created: [`${URI.parse(asB).toString(true)} ${serverUrl}`] });
	});

	test('the authorization server choice survives a restart: a still-listed one with a registration is reused and its provider kept', async () => {
		// Signed in while the resource listed [AS-A]; it now lists [AS-B, AS-A], and the window restarted (no provider is registered yet).
		const registeredA = `${URI.parse(asA).toString(true)} ${serverUrl}`;
		const originWide = `${URI.parse(asB).toString(true)} https://myserver.example/`;
		const otherResource = `${URI.parse(asB).toString(true)} https://other.example/mcp`;
		const { mainThreadMcp, unregistered, removedProviders, created, createdOptions } = createHarness({ providerId: undefined, interactedProviders: [registeredA, originWide, otherResource] });

		const registered = await mainThreadMcp.$getRegisteredAuthorizationServers(1, serverUrl);
		// The extension host's discovery picks the first listed authorization server among them: AS-A.
		await mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { resourceMetadata: { resource: serverUrl, authorization_servers: [asB, asA] } }), {});
		assert.deepStrictEqual({ registered, unregistered, removedProviders, created, createdOptions }, {
			registered: [
				{ authorizationServer: URI.parse(asA).toString(true), resource: serverUrl },
				// A root protected resource metadata document may name the origin.
				{ authorizationServer: URI.parse(asB).toString(true), resource: 'https://myserver.example/' },
			],
			unregistered: [],
			removedProviders: [],
			// The provider is recreated from its stored registration; it requires PKCE S256 to be advertised.
			created: [registeredA],
			createdOptions: [{ requireAdvertisedPkce: true }],
		});
		assert.deepStrictEqual(await mainThreadMcp.$getRegisteredAuthorizationServers(2, serverUrl), [], 'an unknown server has no registrations');
	});

	test('registered authorization servers are only looked up for the server\'s own resource', async () => {
		const ownRegistration = `${URI.parse(asA).toString(true)} ${serverUrl}`;
		const otherRegistration = `${URI.parse(asB).toString(true)} https://other.example/mcp`;
		const originRegistration = `${URI.parse(asB).toString(true)} https://myserver.example/`;
		const interactedProviders = [ownRegistration, otherRegistration, originRegistration, `${URI.parse(asA).toString(true)} https://identity.example:8443/`];
		const http = createHarness({ providerId: undefined, interactedProviders });
		const lookup = async (harness: IAuthHarness, resource: string) => (await harness.mainThreadMcp.$getRegisteredAuthorizationServers(1, resource)).map(r => `${r.authorizationServer} ${r.resource}`);

		const own = await lookup(http, serverUrl);
		const other = await lookup(http, 'https://other.example/mcp');
		const originBefore = await lookup(http, 'https://myserver.example/');
		// The server's protected resource metadata names its origin.
		await http.mainThreadMcp.$getTokenFromServerMetadata(1, details(asB, { resourceMetadata: { resource: 'https://myserver.example/', authorization_servers: [asB] } }), {});
		const originAfter = await lookup(http, 'https://myserver.example/');

		// A gRPC server's own resource is its HTTPS identity.
		const grpc = createHarness({ providerId: undefined, interactedProviders, launch: { type: McpServerTransportType.Grpc, uri: URI.parse('grpcs://user@identity.example:8443'), headers: [] } });
		const identity = await lookup(grpc, 'https://identity.example:8443');
		const grpcOther = await lookup(grpc, serverUrl);

		assert.deepStrictEqual({ own, other, originBefore, originAfter, identity, grpcOther }, {
			own: [ownRegistration, originRegistration],
			other: [],
			originBefore: [],
			originAfter: [originRegistration],
			identity: [`${URI.parse(asA).toString(true)} https://identity.example:8443/`],
			grpcOther: [],
		});
	});

	test('a unix:// or pipe:// HTTP server\'s registered authorization servers are looked up for its HTTP identity, and only those it used itself', async () => {
		// The Node transport sends a socket server's requests to http://localhost/<fragment>; its metadata names that resource.
		const ownRegistration = `${URI.parse(asA).toString(true)} http://localhost/mcp`;
		const originRegistration = `${URI.parse(asB).toString(true)} http://localhost/`;
		const otherRegistration = `${URI.parse(asA).toString(true)} http://localhost/other`;
		const interactedProviders = [ownRegistration, originRegistration, otherRegistration];
		const unixUrl = 'unix:///tmp/mcp.sock#/mcp';
		const pipeUrl = 'pipe:///%5C%5C.%5Cpipe%5Cmcp#/mcp';
		const otherSocketUrl = 'unix:///tmp/other.sock#/mcp';
		const localhostUrl = 'http://localhost/mcp';
		const httpLaunch = (url: string): McpServerLaunch => ({ type: McpServerTransportType.HTTP, uri: URI.parse(url), headers: [] });
		// Four servers whose HTTP identity is http://localhost/mcp: the stored registrations cannot tell them apart.
		const harness = createHarness({ providerId: ownRegistration, interactedProviders, launch: httpLaunch(unixUrl), moreLaunches: [pipeUrl, otherSocketUrl, localhostUrl].map(httpLaunch) });
		const lookup = async (id: number, resource: string) => (await harness.mainThreadMcp.$getRegisteredAuthorizationServers(id, resource)).map(r => `${r.authorizationServer} ${r.resource}`);

		const before = await lookup(1, URI.parse(unixUrl).toString(true));
		// The unix server signs in through the registration of its HTTP identity.
		await harness.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { resourceMetadata: { resource: 'http://localhost/mcp', authorization_servers: [asA] } }), {});

		assert.deepStrictEqual({
			before,
			// The extension host asks with the launch URL; the HTTP identity itself is the same resource.
			unix: await lookup(1, URI.parse(unixUrl).toString(true)),
			unixIdentity: await lookup(1, 'http://localhost/mcp'),
			otherRoute: await lookup(1, 'unix:///tmp/mcp.sock#/other'),
			otherResource: await lookup(1, 'https://myserver.example/mcp'),
			// The others share the identity, not the registrations the unix server used.
			pipe: await lookup(2, URI.parse(pipeUrl).toString(true)),
			otherSocket: await lookup(3, URI.parse(otherSocketUrl).toString(true)),
			localhost: await lookup(4, localhostUrl),
		}, {
			before: [],
			unix: [ownRegistration],
			unixIdentity: [ownRegistration],
			otherRoute: [],
			otherResource: [],
			pipe: [],
			otherSocket: [],
			localhost: [],
		});
	});

	test('signing in with another listed authorization server keeps the registration of one the resource still lists', async () => {
		const registeredA = `${URI.parse(asA).toString(true)} ${serverUrl}`;
		const { mainThreadMcp, unregistered, removedProviders, created } = createHarness({ providerId: undefined, interactedProviders: [registeredA] });
		await mainThreadMcp.$getTokenFromServerMetadata(1, details(asB, { resourceMetadata: { resource: serverUrl, authorization_servers: [asB, asA] } }), {});
		assert.deepStrictEqual({ unregistered, removedProviders, created }, { unregistered: [], removedProviders: [], created: [`${URI.parse(asB).toString(true)} ${serverUrl}`] });
	});

	test('a session stored with the previous scope fallback is reused instead of signing in again', async () => {
		// Earlier versions requested the authorization server's scopes_supported for a resource that declares none.
		const legacy: AuthenticationSession = { id: 'legacy', accessToken: 'legacy-token', account: { id: 'a', label: 'user' }, scopes: ['as.scope'] };
		const sessionsFor = (scopes: ReadonlyArray<string> | IAuthenticationWwwAuthenticateRequest | undefined) => Array.isArray(scopes) && scopes.length === 1 && scopes[0] === 'as.scope' ? [legacy] : [];
		const reused = createHarness({ providerId: 'p', sessionsFor });
		const token = await reused.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA), { errorOnUserInteraction: true });

		// A resource that declares its scopes never fell back: no lookup with the authorization server's scopes.
		const declared = createHarness({ providerId: 'p', sessionsFor });
		await assert.rejects(declared.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { resourceMetadata: { resource: serverUrl, authorization_servers: [asA], scopes_supported: ['rs.scope'] } }), { errorOnUserInteraction: true }), (error: unknown) => error instanceof Error && UserInteractionRequiredError.is(error));

		assert.deepStrictEqual({
			token,
			reusedLookups: reused.getSessionsCalls.map(call => call.scopes),
			declaredLookups: declared.getSessionsCalls.map(call => call.scopes),
		}, {
			token: 'legacy-token',
			reusedLookups: [[], ['as.scope']],
			declaredLookups: [['rs.scope']],
		});
	});

	function enterpriseDetails(authorizationServers: string[], discovered = authorizationServers[0], overrides: Partial<IMcpAuthenticationDetails> = {}): IMcpAuthenticationDetails {
		return details(discovered, { enterpriseManaged: true, clientId: 'resource-client', resourceMetadata: { resource: serverUrl, authorization_servers: authorizationServers }, ...overrides });
	}

	test('enterprise-managed: the resource client secret is bound to the audience on first use and never sent to another', async () => {
		const harness = createHarness({ providerId: 'p' });
		const key = mcpOAuthClientSecretStorageKey(serverUrl, 'resource-client');
		harness.secrets.set(key, 'resource-secret');
		await harness.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asA]), {});
		const bound = JSON.parse(harness.secrets.get(key)!);
		// A new authorization server in front: the bound one is still listed, so it stays the audience.
		await harness.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asB, asA], asB), {});
		const lookups = harness.getSessionsCalls.length;
		// The bound authorization server is gone: nothing is sent.
		await assert.rejects(harness.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asB]), {}), (error: unknown) => {
			assert.ok(error instanceof OAuthClientError && error.code === 'issuer_not_registered');
			assert.ok(error.message.includes(asA) && error.message.includes(asB), error.message);
			return true;
		});
		assert.deepStrictEqual({
			bound,
			audiences: harness.getSessionsOptions.map(o => o?.audience),
			secrets: harness.getSessionsOptions.map(o => o?.clientSecret),
			lookupsAfterMismatch: harness.getSessionsCalls.length - lookups,
		}, {
			bound: { clientSecret: 'resource-secret', issuer: asA },
			audiences: [asA, asA],
			secrets: ['resource-secret', 'resource-secret'],
			lookupsAfterMismatch: 0,
		});
	});

	test('enterprise-managed: a secret the provider prompted for is bound on first use, and a configured oauth.authorizationServer is the audience', async () => {
		const key = mcpOAuthClientSecretStorageKey(serverUrl, 'resource-client');
		// The XAA provider prompts for the resource client secret during the lookup, which stores it unbound.
		const prompted = createHarness({ providerId: 'p', onGetSessions: secrets => secrets.set(key, JSON.stringify({ clientSecret: 'prompted-secret' })) });
		await prompted.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asA]), {});

		const oauth: IMcpRemoteServerOAuthConfiguration = { clientId: 'resource-client', authorizationServer: asB };
		const configured = createHarness({ providerId: 'p', oauth });
		await configured.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asA, asB], asA), {});
		await assert.rejects(configured.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asA]), {}), /registered with the authorization server/);

		assert.deepStrictEqual({
			prompted: JSON.parse(prompted.secrets.get(key)!),
			configuredAudiences: configured.getSessionsOptions.map(o => o?.audience),
		}, {
			prompted: { clientSecret: 'prompted-secret', issuer: asA },
			configuredAudiences: [asB],
		});
	});

	test('enterprise-managed: the server\'s oauth.allowInsecureHttp reaches the XAA provider as a workbench-only session option', async () => {
		const oauth: IMcpRemoteServerOAuthConfiguration = { allowInsecureHttp: true };
		const allowed = createHarness({ providerId: 'p', oauth });
		await allowed.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asA]), {});
		const strict = createHarness({ providerId: 'p' });
		await strict.mainThreadMcp.$getTokenFromServerMetadata(1, enterpriseDetails([asA]), {});
		// A dynamic provider gets the server's rules with each request too: it may be shared with callers whose rules
		// differ (the agent host), and uses them for a new registration, the device flow and the PKCE check.
		const dynamic = createHarness({ providerId: 'p', oauth });
		await dynamic.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA), {});
		const strictDynamic = createHarness({ providerId: 'p' });
		await strictDynamic.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA), {});
		const option = (harness: IAuthHarness, key = MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION) => harness.getSessionsOptions.map(o => o?.[key]);
		assert.deepStrictEqual(
			{ allowed: option(allowed), strict: option(strict), dynamic: option(dynamic), strictDynamic: option(strictDynamic) },
			{ allowed: [true], strict: [undefined], dynamic: [true], strictDynamic: [undefined] },
		);
		// PKCE S256 must be advertised for the dynamic provider's requests; the identity provider of XAA is not held to it.
		const pkce = (harness: IAuthHarness) => option(harness, MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION);
		assert.deepStrictEqual({ xaa: pkce(allowed), dynamic: pkce(dynamic), strictDynamic: pkce(strictDynamic) }, { xaa: [undefined], dynamic: [true], strictDynamic: [true] });
	});

	test('a dynamic provider registers by the transport\'s endpoint rule, and is asked for the MCP server URL as the resource when the server publishes no protected resource metadata', async () => {
		const oauth: IMcpRemoteServerOAuthConfiguration = { allowInsecureHttp: true };
		const lenient = createHarness({ providerId: undefined, oauth });
		// The protected resource metadata names the origin: its resource is the one sent.
		await lenient.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { resourceMetadata: { resource: 'https://myserver.example/', authorization_servers: [asA] } }), {});
		const strict = createHarness({ providerId: undefined });
		// No metadata (the 2025-03-26 default endpoints): the transport's canonical URI of the server.
		await strict.mainThreadMcp.$getTokenFromServerMetadata(1, details(asA, { resourceMetadata: undefined, resource: serverUrl }), {});
		assert.deepStrictEqual({
			lenient: { created: lenient.createdOptions, resource: lenient.getSessionsOptions.map(o => o?.resource) },
			strict: { created: strict.createdOptions, resource: strict.getSessionsOptions.map(o => o?.resource) },
		}, {
			lenient: { created: [{ requireAdvertisedPkce: true, allowInsecureHttp: true }], resource: ['https://myserver.example/'] },
			strict: { created: [{ requireAdvertisedPkce: true }], resource: [serverUrl] },
		});
	});

	//#region Driven by the shared OAuth fixture (oauthClientFixture.ts), as the OAuthClient and DynamicAuthProvider suites are

	/** A fixture whose protected resource is this suite's server, behind AS-A unless `options.as` names another issuer. */
	function fixtureFor(options: IOAuthFixtureOptions = {}): IOAuthFixture {
		return createOAuthFixture({ as: { issuer: asA, ...options.as }, rs: { resource: serverUrl, ...options.rs } });
	}

	/**
	 * The authentication details the transport sends for the fixture's server: a request without a token (or with
	 * `accessToken`) is challenged, and the transport's discovery reads the protected resource and authorization
	 * server metadata through `fixture.fetch`.
	 */
	async function discover(fixture: IOAuthFixture, accessToken?: string): Promise<IMcpAuthenticationDetails> {
		const challenged = await fixture.fetch(fixture.resource, { method: 'POST', headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
		assert.strictEqual(challenged.status, 401);
		const challengeHeaders = new Headers();
		const wwwAuthenticate = challenged.headers.get('www-authenticate');
		if (wwwAuthenticate !== null) {
			challengeHeaders.set('WWW-Authenticate', wwwAuthenticate);
		}
		const metadata = await createAuthMetadata(fixture.resource, challengeHeaders, {
			fetch: async (url, init) => {
				const response = await fixture.fetch(url, { method: init.method, headers: init.headers, signal: init.signal });
				const headers = new Headers();
				const contentType = response.headers.get('content-type');
				if (contentType !== null) {
					headers.set('Content-Type', contentType);
				}
				return { status: response.status, statusText: response.statusText ?? '', headers, url, json: () => response.json(), text: () => response.text() };
			},
			log: () => { },
		});
		// What the transport's _requestToken sends, less the launch's oauth settings.
		return {
			authorizationServer: metadata.authorizationServer.toJSON(),
			authorizationServerMetadata: metadata.serverMetadata,
			resourceMetadata: metadata.resourceMetadata,
			scopes: metadata.scopes,
			resource: metadata.resource,
		};
	}

	/** The paths of the metadata documents the fixture served, in order. */
	function servedMetadata(fixture: IOAuthFixture): string[] {
		return fixture.requests.filter(r => r.status === 200 && r.method === 'GET').map(r => new URL(r.url).pathname);
	}

	test('with the shared OAuth fixture: the challenge\'s scopes are requested, else the resource\'s, and the authorization server\'s only without protected resource metadata', async () => {
		const run = async (fixture: IOAuthFixture) => {
			const harness = createHarness({ providerId: 'p' });
			await harness.mainThreadMcp.$getTokenFromServerMetadata(1, await discover(fixture), {});
			return { lookups: harness.getSessionsCalls.map(call => call.scopes), served: servedMetadata(fixture) };
		};
		const as = { scopesSupported: ['as.scope'] };
		const resourceScopes = ['mcp.read', 'mcp.write'];
		assert.deepStrictEqual({
			resourceScopes: await run(fixtureFor({ as, rs: { scopesSupported: resourceScopes } })),
			challenged: await run(fixtureFor({ as, rs: { scopesSupported: resourceScopes, requiredScopes: ['mcp.write'], scopeInWwwAuthenticate: true } })),
			noResourceScopes: await run(fixtureFor({ as })),
			// A 2025-03-26 server: no protected resource metadata, its authorization server at its origin.
			noResourceMetadata: await run(fixtureFor({ as: { ...as, issuer: 'https://myserver.example' }, rs: { prmLocation: 'none' } })),
		}, {
			resourceScopes: { lookups: [resourceScopes], served: ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'] },
			challenged: { lookups: [['mcp.write']], served: ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'] },
			noResourceScopes: { lookups: [[]], served: ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'] },
			noResourceMetadata: { lookups: [['as.scope']], served: ['/.well-known/oauth-authorization-server'] },
		});
	});

	test('with the shared OAuth fixture: the token the resource rejected removes its session, looked up without a scope filter, and another session\'s token is returned', async () => {
		const fixture = fixtureFor({ rs: { scopesSupported: ['mcp.read'] } });
		const sessions: AuthenticationSession[] = [
			{ id: 'old', accessToken: 'rejected-token', account: { id: 'a', label: 'user' }, scopes: ['mcp.read'] },
			{ id: 'other', accessToken: 'other-token', account: { id: 'a', label: 'user' }, scopes: ['mcp.read'] },
		];
		// The provider forgets a removed session.
		const harness: IAuthHarness = createHarness({ providerId: 'dynamic-provider', sessionsFor: () => sessions.filter(s => !harness.removed.some(([, id]) => id === s.id)) });
		const details = await discover(fixture, 'rejected-token');
		const token = await harness.mainThreadMcp.$getTokenFromServerMetadata(1, details, { rejectedToken: 'rejected-token' });
		assert.deepStrictEqual({ accesses: fixture.rs.accesses, lookups: harness.getSessionsCalls, removed: harness.removed, token }, {
			accesses: [{ accessToken: 'rejected-token', status: 401 }],
			lookups: [{ id: 'dynamic-provider', scopes: undefined }, { id: 'dynamic-provider', scopes: ['mcp.read'] }],
			removed: [['dynamic-provider', 'old']],
			token: 'other-token',
		});
	});

	test('with the shared OAuth fixture: pre-registered credentials stay bound to the authorization server of their first use when the resource moves to another', async () => {
		let authorizationServers = [asA];
		const fixture = fixtureFor({ rs: { authorizationServers: () => authorizationServers } });
		const otherServer = createAuthorizationServerFixture(fixture.router, { issuer: asB });
		const harness = createHarness({ providerId: 'p' });
		const key = mcpOAuthClientSecretStorageKey(serverUrl, 'static-client');
		harness.secrets.set(key, 'static-secret');
		// The extension host adds the configured oauth.clientId to what discovery found.
		const signIn = async () => harness.mainThreadMcp.$getTokenFromServerMetadata(1, { ...await discover(fixture), clientId: 'static-client' }, {});

		const token = await signIn();
		const bound = JSON.parse(harness.secrets.get(key)!);
		const lookups = harness.getSessionsCalls.length;
		authorizationServers = [asB];
		await assert.rejects(signIn(), (error: unknown) => {
			assert.ok(error instanceof OAuthClientError && error.code === 'issuer_not_registered', String(error));
			assert.ok(error.message.includes(asA) && error.message.includes(asB), error.message);
			return true;
		});
		assert.deepStrictEqual({
			token,
			bound,
			lookupsAfterMove: harness.getSessionsCalls.length - lookups,
			// Each issuer came from its own authorization server's metadata document.
			metadataRequests: [fixture.as.metadataRequests, otherServer.metadataRequests],
		}, {
			token: 'access-token',
			bound: { clientSecret: 'static-secret', issuer: asA },
			lookupsAfterMove: 0,
			metadataRequests: [['/.well-known/oauth-authorization-server'], ['/.well-known/oauth-authorization-server']],
		});
	});

	//#endregion
});

suite('MainThreadMcp - request policy', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();
	const initialUrl = 'https://allowed.example/mcp';
	const redirectedUrl = 'https://redirected.example/mcp';
	const name = 'Configured MCP Server';

	function createConnection(options: {
		allowed?: readonly IMcpServerMatcher[];
		denied?: readonly IMcpServerMatcher[];
		access?: McpAccessValue;
		destination?: string;
	} = {}) {
		const configuration = new TestConfigurationService({
			[mcpAllowedServersConfig]: options.allowed,
			[mcpDeniedServersConfig]: options.denied,
			[mcpAccessConfig]: options.access,
		});
		disposables.add(configuration.onDidChangeConfigurationEmitter);
		const policy = disposables.add(new AllowedMcpServersService(configuration));
		const stopped: number[] = [];
		const requests: string[] = [];
		let delegate: IMcpHostDelegate | undefined;
		const registry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate(value: IMcpHostDelegate) {
				delegate = value;
				return { dispose() { } };
			}
		};
		const mainThread = createMainThreadMcp(disposables, {
			$startMcp() { },
			$stopMcp(id) {
				stopped.push(id);
				httpHandle.dispose();
			},
			$sendMessage() { },
			$onDidChangeMcpServerDefinitions() { },
		}, registry, services => {
			services.stub(IConfigurationService, configuration);
			services.stub(IAllowedMcpServersService, policy);
		});
		const launch = { type: McpServerTransportType.HTTP, uri: URI.parse(initialUrl), headers: [] } satisfies McpServerLaunch;
		const definition: McpServerDefinition = { id: 'server', label: name, cacheNonce: 'nonce', launch };
		const collection: McpCollectionDefinition = {
			id: 'collection',
			label: 'Collection',
			remoteAuthority: null,
			serverDefinitions: observableValue<readonly McpServerDefinition[]>('definitions', [definition]),
			trustBehavior: McpServerTrust.Kind.Trusted,
			scope: StorageScope.WORKSPACE,
			configTarget: ConfigurationTarget.USER,
			order: McpCollectionSortOrder.WorkspaceFolder,
		};
		assert.ok(delegate);
		const transport = delegate.start(collection, definition, launch);
		const destination = options.destination ?? redirectedUrl;
		const httpHandle = disposables.add(new class extends McpHTTPHandle {
			protected override async _fetchInternal(url: string, _init?: CommonRequestInit): Promise<CommonResponse> {
				requests.push(url);
				return url === initialUrl
					? new Response(null, { status: 307, headers: { location: destination } })
					: new Response(null, { status: 202 });
			}
		}(1, launch, mainThread, new NullLogService()));
		return {
			mainThread, policy, transport, stopped, requests,
			// eslint-disable-next-line local/code-no-bracket-notation-for-identifiers -- Exercise the private request boundary without widening the transport API.
			fetch: () => httpHandle['_fetch'](initialUrl, { method: 'POST', headers: {} }),
			async denyDestination() {
				await configuration.setUserConfiguration(mcpDeniedServersConfig, [{ serverUrl: destination }]);
				configuration.onDidChangeConfigurationEmitter.fire({
					source: ConfigurationTarget.USER,
					affectedKeys: new Set([mcpDeniedServersConfig]),
					change: { keys: [mcpDeniedServersConfig], overrides: [] },
					affectsConfiguration: section => section === mcpDeniedServersConfig,
				});
			},
		};
	}

	for (const destination of [redirectedUrl, 'https://allowed.example/private']) {
		test(`enforces URL denials before dispatch to ${destination}`, async () => {
			const { fetch, policy, requests, transport } = createConnection({ denied: [{ serverUrl: destination }], destination });
			assert.strictEqual(policy.isServerAllowed({ name, url: initialUrl }), true);
			const denial = policy.isServerAllowed({ name, url: destination });
			assert.notStrictEqual(denial, true);
			assert.ok(denial !== true);
			await assert.rejects(fetch(), { message: denial.value });
			assert.deepStrictEqual({ requests, state: transport.state.get() }, {
				requests: [initialUrl],
				state: { state: McpConnectionState.Kind.Error, message: denial.value },
			});
		});
	}

	test('requires a URL-allowlisted redirect destination to be separately allowed', async () => {
		const { fetch, requests } = createConnection({ allowed: [{ serverUrl: initialUrl }] });
		await assert.rejects(fetch(), /not in the list of servers allowed/);
		assert.deepStrictEqual(requests, [initialUrl]);
	});

	test('preserves the configured server name for destination policy decisions', async () => {
		const { fetch, requests } = createConnection({ allowed: [{ serverName: name }] });
		await fetch();
		assert.deepStrictEqual(requests, [initialUrl, redirectedUrl]);
	});

	test('a destination denial overrides a matching server name allowlist', async () => {
		const { fetch, requests } = createConnection({ allowed: [{ serverName: name }], denied: [{ serverUrl: redirectedUrl }] });
		await assert.rejects(fetch(), /blocked by your organization's policy/);
		assert.deepStrictEqual(requests, [initialUrl]);
	});

	test('allows explicitly permitted redirect destinations', async () => {
		const { fetch, requests } = createConnection({ allowed: [{ serverUrl: initialUrl }, { serverUrl: redirectedUrl }] });
		await fetch();
		assert.deepStrictEqual(requests, [initialUrl, redirectedUrl]);
	});

	test('enforces global MCP disablement before dispatch', async () => {
		const { fetch, requests } = createConnection({ access: McpAccessValue.None });
		await assert.rejects(fetch(), /Model Context Protocol servers are disabled/);
		assert.deepStrictEqual(requests, []);
	});

	test('enforces configured server name denials before dispatch', async () => {
		const { fetch, requests } = createConnection({ denied: [{ serverName: name }] });
		await assert.rejects(fetch(), /blocked by your organization's policy/);
		assert.deepStrictEqual(requests, []);
	});

	test('stops an active redirected transport when destination policy is revoked', async () => {
		const { fetch, denyDestination, stopped, requests, transport } = createConnection();
		await fetch();
		await denyDestination();
		assert.deepStrictEqual({ stopped, state: transport.state.get().state, requests }, {
			stopped: [1],
			state: McpConnectionState.Kind.Error,
			requests: [initialUrl, redirectedUrl],
		});
	});

	test('does not dispatch using a removed connection', async () => {
		const { mainThread, fetch, requests } = createConnection();
		mainThread.$onDidChangeState(1, { state: McpConnectionState.Kind.Stopped });
		await assert.rejects(fetch(), isCancellationError);
		assert.deepStrictEqual(requests, []);
	});
});

suite('MainThreadMcp - gRPC', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	/** A configuration whose `inspect` reports the given values as policy values. */
	class PolicyConfigurationService extends TestConfigurationService {
		constructor(configuration: Record<string, unknown>, private readonly _policy: Record<string, unknown>) {
			super(configuration);
		}

		override inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
			const value = super.inspect<T>(key, overrides);
			return Object.prototype.hasOwnProperty.call(this._policy, key) ? { ...value, policyValue: this._policy[key] as T } : value;
		}
	}

	function grpcLaunch(url: string, tls?: { insecure?: boolean }): McpServerLaunch {
		return { type: McpServerTransportType.Grpc, uri: URI.parse(url), headers: [], tls };
	}

	function collectionOf(definitions: McpServerDefinition[]): McpCollectionDefinition {
		return {
			id: 'collection-grpc',
			label: 'Collection',
			remoteAuthority: null,
			serverDefinitions: observableValue<readonly McpServerDefinition[]>('definitions', definitions),
			trustBehavior: McpServerTrust.Kind.Trusted,
			scope: StorageScope.WORKSPACE,
			configTarget: ConfigurationTarget.USER,
			order: McpCollectionSortOrder.WorkspaceFolder,
		};
	}

	function create(options: { allowed?: readonly IMcpServerMatcher[]; policyAllowed?: readonly IMcpServerMatcher[]; extensionHostKind?: ExtensionHostKind } = {}) {
		const configuration = new PolicyConfigurationService(
			{ [mcpAllowedServersConfig]: options.policyAllowed ?? options.allowed },
			options.policyAllowed ? { [mcpAllowedServersConfig]: options.policyAllowed } : {},
		);
		disposables.add(configuration.onDidChangeConfigurationEmitter);
		const policy = disposables.add(new AllowedMcpServersService(configuration));
		const started: Parameters<ExtHostMcpShape['$startMcp']>[] = [];
		const stopped: number[] = [];
		let delegate: IMcpHostDelegate | undefined;
		const registry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate(value: IMcpHostDelegate) {
				delegate = value;
				return { dispose() { } };
			}
		};
		const mainThread = createMainThreadMcp(disposables, {
			$startMcp(...args) { started.push(args); },
			$stopMcp(id) { stopped.push(id); },
			$sendMessage() { },
			$onDidChangeMcpServerDefinitions() { },
		}, registry, services => {
			services.stub(IConfigurationService, configuration);
			services.stub(IAllowedMcpServersService, policy);
		}, options.extensionHostKind);
		assert.ok(delegate);
		return {
			mainThread, delegate, started, stopped, policy,
			/** Denies `serverUrl` in the user's `chat.mcp.deniedServers`, as an administrator or the user would. */
			async denyUrl(serverUrl: string) {
				await configuration.setUserConfiguration(mcpDeniedServersConfig, [{ serverUrl }]);
				configuration.onDidChangeConfigurationEmitter.fire({
					source: ConfigurationTarget.USER,
					affectedKeys: new Set([mcpDeniedServersConfig]),
					change: { keys: [mcpDeniedServersConfig], overrides: [] },
					affectsConfiguration: section => section === mcpDeniedServersConfig,
				});
			},
		};
	}

	test('gRPC servers start on Node.js extension hosts only', () => {
		const grpc: McpServerDefinition = { id: 'grpc', label: 'gRPC', cacheNonce: 'n', launch: grpcLaunch('grpc://127.0.0.1:50051') };
		const http: McpServerDefinition = { id: 'http', label: 'HTTP', cacheNonce: 'n', launch: { type: McpServerTransportType.HTTP, uri: URI.parse('https://example.com/mcp'), headers: [] } };
		const web = create({ extensionHostKind: ExtensionHostKind.LocalWebWorker });
		const node = create({ extensionHostKind: ExtensionHostKind.LocalProcess });
		assert.deepStrictEqual({
			webGrpc: web.delegate.canStart(collectionOf([grpc]), grpc),
			webHttp: web.delegate.canStart(collectionOf([http]), http),
			nodeGrpc: node.delegate.canStart(collectionOf([grpc]), grpc),
		}, { webGrpc: false, webHttp: true, nodeGrpc: true });
	});

	test('the allow list governs gRPC destinations by their URL', async () => {
		const { mainThread, delegate, started } = create({ allowed: [{ serverUrl: 'grpc://allowed.example:50051' }] });
		const allowed: McpServerDefinition = { id: 'a', label: 'Allowed', cacheNonce: 'n', launch: grpcLaunch('grpc://allowed.example:50051') };
		const other: McpServerDefinition = { id: 'b', label: 'Other', cacheNonce: 'n', launch: grpcLaunch('grpc://other.example:50051') };
		disposables.add(delegate.start(collectionOf([allowed, other]), allowed, allowed.launch));
		disposables.add(delegate.start(collectionOf([allowed, other]), other, other.launch));

		assert.strictEqual(await mainThread.$checkMcpServerAllowed(1, 'grpc://allowed.example:50051'), undefined);
		assert.match(await mainThread.$checkMcpServerAllowed(2, 'grpc://other.example:50051') ?? '', /not in the list of servers allowed/);
		assert.deepStrictEqual(started.map(([id, opts]) => [id, opts.launch.type]), [[1, McpServerTransportType.Grpc], [2, McpServerTransportType.Grpc]]);
	});

	test('a policy change that denies the URL of a running gRPC server stops it with the policy message, and only that server', async () => {
		const { mainThread, delegate, stopped, policy, denyUrl } = create();
		const denied: McpServerDefinition = { id: 'a', label: 'Denied', cacheNonce: 'n', launch: grpcLaunch('grpc://allowed.example:50051') };
		const other: McpServerDefinition = { id: 'b', label: 'Other', cacheNonce: 'n', launch: grpcLaunch('grpcs://other.example:50051') };
		const deniedTransport = disposables.add(delegate.start(collectionOf([denied, other]), denied, denied.launch));
		const otherTransport = disposables.add(delegate.start(collectionOf([denied, other]), other, other.launch));
		mainThread.$onDidChangeState(1, { state: McpConnectionState.Kind.Running });
		mainThread.$onDidChangeState(2, { state: McpConnectionState.Kind.Running });
		const before = await mainThread.$checkMcpServerAllowed(1, 'grpc://allowed.example:50051');

		await denyUrl('grpc://allowed.example:50051');

		const denial = policy.isServerAllowed({ name: denied.label, url: 'grpc://allowed.example:50051' });
		assert.ok(denial !== true, 'the URL is denied now');
		assert.deepStrictEqual({
			before,
			stopped,
			denied: deniedTransport.state.get(),
			other: otherTransport.state.get(),
			// The extension host's next check (its per-call check) of the stopped server is cancelled: the main thread forgot it.
			nextCheck: await mainThread.$checkMcpServerAllowed(1, 'grpc://allowed.example:50051').then(() => 'allowed', (e: unknown) => isCancellationError(e) ? 'cancelled' : String(e)),
			otherCheck: await mainThread.$checkMcpServerAllowed(2, 'grpcs://other.example:50051'),
		}, {
			before: undefined,
			stopped: [1],
			denied: { state: McpConnectionState.Kind.Error, message: denial.value },
			other: { state: McpConnectionState.Kind.Running },
			nextCheck: 'cancelled',
			otherCheck: undefined,
		});
	});

	test('tls.insecure is denied under an allow list defined by policy', async () => {
		const { mainThread, delegate } = create({ policyAllowed: [{ serverName: 'Insecure' }] });
		const insecure: McpServerDefinition = { id: 'i', label: 'Insecure', cacheNonce: 'n', launch: grpcLaunch('grpcs://dev.example:50051', { insecure: true }) };
		const verified: McpServerDefinition = { id: 'v', label: 'Insecure', cacheNonce: 'n', launch: grpcLaunch('grpcs://dev.example:50051') };
		disposables.add(delegate.start(collectionOf([insecure]), insecure, insecure.launch));
		disposables.add(delegate.start(collectionOf([verified]), verified, verified.launch));

		assert.match(await mainThread.$checkMcpServerAllowed(1, 'grpcs://dev.example:50051') ?? '', /tls\.insecure/);
		assert.strictEqual(await mainThread.$checkMcpServerAllowed(2, 'grpcs://dev.example:50051'), undefined);
	});

	test('tls.insecure without a policy allow list is allowed with a warning once per server', async () => {
		const { mainThread, delegate } = create();
		const insecure: McpServerDefinition = { id: 'i', label: 'Insecure', cacheNonce: 'n', launch: grpcLaunch('grpcs://dev.example:50051', { insecure: true }) };
		const logs: string[] = [];
		const first = disposables.add(delegate.start(collectionOf([insecure]), insecure, insecure.launch));
		disposables.add(first.onDidLog(e => e.level === LogLevel.Warning && logs.push(e.message)));
		assert.strictEqual(await mainThread.$checkMcpServerAllowed(1, 'grpcs://dev.example:50051'), undefined);
		assert.strictEqual(await mainThread.$checkMcpServerAllowed(1, 'grpcs://dev.example:50051'), undefined);
		mainThread.$onDidChangeState(1, { state: McpConnectionState.Kind.Stopped });
		const second = disposables.add(delegate.start(collectionOf([insecure]), insecure, insecure.launch));
		disposables.add(second.onDidLog(e => e.level === LogLevel.Warning && logs.push(e.message)));
		assert.strictEqual(await mainThread.$checkMcpServerAllowed(2, 'grpcs://dev.example:50051'), undefined);
		assert.strictEqual(logs.length, 1);
		assert.match(logs[0], /tls\.insecure/);
	});

	//#region Authorization of gRPC servers

	const grpcUrl = 'grpcs://secure.example:8443';
	/** The HTTPS identity the gRPC transport discovers authorization metadata for. */
	const httpsIdentity = 'https://secure.example:8443/';
	const issuer = 'https://auth.example';

	/** A started gRPC server (id 1) whose provider holds one session, with `isAccessAllowedForUrl` answering from `allowedUrls`. */
	function createAuthorized(allowedUrls: readonly string[]) {
		const accessChecks: string[] = [];
		const secrets = new Map<string, string>();
		let delegate: IMcpHostDelegate | undefined;
		const registry = new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate(value: IMcpHostDelegate) {
				delegate = value;
				return { dispose() { } };
			}
		};
		const mainThread = createMainThreadMcp(disposables, { $startMcp() { }, $stopMcp() { }, $sendMessage() { }, $onDidChangeMcpServerDefinitions() { } }, registry, services => {
			services.stub(IAuthenticationService, new class extends mock<IAuthenticationService>() {
				override readonly onDidChangeSessions = Event.None;
				override async getOrActivateProviderIdForServer(): Promise<string | undefined> { return 'dynamic-provider'; }
				override isDynamicAuthenticationProvider(): boolean { return true; }
				override getProvider(id: string): IAuthenticationProvider {
					return new class extends mock<IAuthenticationProvider>() {
						override readonly id = id;
						override readonly label = 'Test Provider';
						override readonly supportsMultipleAccounts = false;
					};
				}
				override async getSessions(): Promise<ReadonlyArray<AuthenticationSession>> {
					return [{ id: 'session', accessToken: 'grpc-token', account: { id: 'a', label: 'user' }, scopes: [] }];
				}
			});
			services.stub(IAuthenticationMcpService, { getAccountPreference: () => undefined });
			services.stub(IAuthenticationMcpAccessService, {
				isAccessAllowedForUrl: (_providerId: string, _account: string, _serverId: string, url: string | undefined) => {
					accessChecks.push(String(url));
					return url !== undefined && allowedUrls.includes(url);
				},
			});
			services.stub(IAuthenticationMcpUsageService, { addAccountUsage() { } });
			services.stub(ISecretStorageService, {
				async get(key: string) { return secrets.get(key); },
				async set(key: string, value: string) { secrets.set(key, value); },
			});
			services.stub(IDynamicAuthenticationProviderStorageService, {
				getInteractedProviders: () => [],
				async removeDynamicProvider() { },
				async getClientRegistration() { return undefined; },
			});
		});
		assert.ok(delegate);
		const definition: McpServerDefinition = { id: 'grpc-server', label: 'gRPC Server', cacheNonce: 'n', launch: grpcLaunch(grpcUrl) };
		disposables.add(delegate.start(collectionOf([definition]), definition, definition.launch, {}));
		mainThread.$onDidChangeState(1, { state: McpConnectionState.Kind.Running });
		return { mainThread, accessChecks, secrets };
	}

	function grpcDetails(overrides: Partial<IMcpAuthenticationDetails> = {}): IMcpAuthenticationDetails {
		return {
			authorizationServer: URI.parse(issuer).toJSON(),
			authorizationServerMetadata: { issuer, response_types_supported: ['code'] },
			resourceMetadata: { resource: httpsIdentity, authorization_servers: [issuer] },
			scopes: undefined,
			resource: httpsIdentity,
			...overrides,
		};
	}

	test('a token is released to a gRPC server only for the grpc(s):// URL the user consented to, not its HTTPS identity', async () => {
		const consented = createAuthorized([grpcUrl]);
		const token = await consented.mainThread.$getTokenFromServerMetadata(1, grpcDetails(), { errorOnUserInteraction: true });

		const identityOnly = createAuthorized([httpsIdentity]);
		await assert.rejects(identityOnly.mainThread.$getTokenFromServerMetadata(1, grpcDetails(), { errorOnUserInteraction: true }), (e: unknown) => e instanceof Error && UserInteractionRequiredError.is(e));

		assert.deepStrictEqual({ token, checked: consented.accessChecks, checkedIdentityOnly: identityOnly.accessChecks }, {
			token: 'grpc-token',
			checked: [grpcUrl],
			checkedIdentityOnly: [grpcUrl],
		});
	});

	test('pre-registered credentials of a gRPC server are kept under its grpc(s):// URL', async () => {
		const { mainThread, secrets } = createAuthorized([grpcUrl]);
		const key = mcpOAuthClientSecretStorageKey(grpcUrl, 'static-client');
		secrets.set(key, 'static-secret');
		const token = await mainThread.$getTokenFromServerMetadata(1, grpcDetails({ clientId: 'static-client' }), {});
		assert.deepStrictEqual({ token, keys: [...secrets.keys()], stored: JSON.parse(secrets.get(key)!) }, {
			token: 'grpc-token',
			keys: [key],
			// Bound to the issuer of its first use, as for HTTP servers.
			stored: { clientSecret: 'static-secret', issuer },
		});
	});

	//#endregion
});

suite('MainThreadMcp - gateway', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const WITH_GRPC: IMcpGatewayResultServer = { label: 'With gRPC', address: URI.parse('http://127.0.0.1:4100/gateway/r1'), grpcAddress: URI.parse('grpc://127.0.0.1:4101/r1') };
	const HTTP_ONLY: IMcpGatewayResultServer = { label: 'HTTP only', address: URI.parse('http://127.0.0.1:4100/gateway/r2') };

	/** A workbench gateway service whose gateway the test controls. */
	function gatewayService() {
		const created: { inRemote: boolean; chatSessionResource: string | undefined; options?: IMcpGatewayCreateOptions }[] = [];
		const onDidChangeServers = disposables.add(new Emitter<readonly IMcpGatewayResultServer[]>());
		let disposed = 0;
		const service = new class extends mock<IWorkbenchMcpGatewayService>() {
			override async createGateway(inRemote: boolean, chatSessionResource?: URI, options?: IMcpGatewayCreateOptions): Promise<IMcpGatewayResult | undefined> {
				created.push({ inRemote, chatSessionResource: chatSessionResource?.toString(), ...(options ? { options } : {}) });
				return { servers: [WITH_GRPC, HTTP_ONLY], onDidChangeServers: onDidChangeServers.event, dispose: () => { disposed++; } };
			}
		};
		return { service, created, onDidChangeServers, disposedCount: () => disposed };
	}

	function emptyRegistry(): IMcpRegistry {
		return new class extends mock<IMcpRegistry>() {
			override readonly collections = observableValue<readonly McpCollectionDefinition[]>('collections', []);
			override registerDelegate() {
				return { dispose() { } };
			}
		};
	}

	test('$startMcpGateway sends grpcAddress only for servers that have one, forwards server changes and disposes the gateway', async () => {
		const gateway = gatewayService();
		const changes: [string, IMcpGatewayServerDto[]][] = [];
		const mainThread = createMainThreadMcp(disposables, {
			$onDidChangeMcpServerDefinitions() { },
			$onDidChangeGatewayServers(gatewayId, servers) { changes.push([gatewayId, servers]); },
		}, emptyRegistry(), services => services.stub(IWorkbenchMcpGatewayService, gateway.service));

		const result = await mainThread.$startMcpGateway(URI.parse('chat-session:/s1').toJSON());
		assert.ok(result);
		assert.deepStrictEqual(gateway.created, [{ inRemote: false, chatSessionResource: 'chat-session:/s1' }]);
		const [withGrpc, httpOnly] = result.servers;
		assert.deepStrictEqual([URI.revive(withGrpc.address).toString(true), withGrpc.grpcAddress && URI.revive(withGrpc.grpcAddress).toString(true)], ['http://127.0.0.1:4100/gateway/r1', 'grpc://127.0.0.1:4101/r1']);
		assert.ok(!Object.prototype.hasOwnProperty.call(httpOnly, 'grpcAddress'), 'no grpcAddress key for an HTTP-only server');

		gateway.onDidChangeServers.fire([HTTP_ONLY, WITH_GRPC]);
		assert.strictEqual(changes.length, 1);
		assert.strictEqual(changes[0][0], result.gatewayId);
		assert.deepStrictEqual(changes[0][1].map(s => s.grpcAddress && URI.revive(s.grpcAddress).toString(true)), [undefined, 'grpc://127.0.0.1:4101/r1']);

		mainThread.$disposeMcpGateway(result.gatewayId);
		assert.strictEqual(gateway.disposedCount(), 1);
		gateway.onDidChangeServers.fire([WITH_GRPC]);
		assert.strictEqual(changes.length, 1, 'no changes after disposal');
	});

	test('a remote extension host asks for the gateway in the remote environment', async () => {
		const gateway = gatewayService();
		const mainThread = createMainThreadMcp(disposables, { $onDidChangeMcpServerDefinitions() { } }, emptyRegistry(), services => services.stub(IWorkbenchMcpGatewayService, gateway.service), ExtensionHostKind.Remote);
		const result = await mainThread.$startMcpGateway();
		assert.ok(result);
		assert.deepStrictEqual(gateway.created, [{ inRemote: true, chatSessionResource: undefined }]);
		mainThread.$disposeMcpGateway(result.gatewayId);
	});

	test('$startMcpGateway asks the workbench gateway service for gRPC only with grpc: true', async () => {
		const gateway = gatewayService();
		const mainThread = createMainThreadMcp(disposables, { $onDidChangeMcpServerDefinitions() { } }, emptyRegistry(), services => services.stub(IWorkbenchMcpGatewayService, gateway.service));
		const session = URI.parse('chat-session:/s3').toJSON();
		// A value that crossed the protocol from an extension that passed something other than a boolean.
		const notABoolean: unknown = { grpc: 'yes' };
		const results = [
			await mainThread.$startMcpGateway(session, undefined),
			await mainThread.$startMcpGateway(session, {}),
			await mainThread.$startMcpGateway(session, { grpc: false }),
			await mainThread.$startMcpGateway(session, notABoolean as IMcpGatewayStartOptionsDto),
			await mainThread.$startMcpGateway(session, { grpc: true }),
			await mainThread.$startMcpGateway(undefined, { grpc: true }),
		];
		assert.deepStrictEqual(gateway.created, [
			{ inRemote: false, chatSessionResource: 'chat-session:/s3' },
			{ inRemote: false, chatSessionResource: 'chat-session:/s3' },
			{ inRemote: false, chatSessionResource: 'chat-session:/s3' },
			{ inRemote: false, chatSessionResource: 'chat-session:/s3' },
			{ inRemote: false, chatSessionResource: 'chat-session:/s3', options: { grpc: true } },
			{ inRemote: false, chatSessionResource: undefined, options: { grpc: true } },
		]);
		for (const result of results) {
			assert.ok(result);
			mainThread.$disposeMcpGateway(result.gatewayId);
		}
		assert.strictEqual(gateway.disposedCount(), results.length);
	});

	test('through the extension host protocol: vscode.McpGatewayServer gets URIs and grpcAddress, also on changes', async () => {
		const gateway = gatewayService();
		const rpc = new TestRPCProtocol();
		const mainThread = createMainThreadMcp(disposables, rpc.getProxy(ExtHostContext.ExtHostMcp), emptyRegistry(), services => services.stub(IWorkbenchMcpGatewayService, gateway.service));
		rpc.set(MainContext.MainThreadMcp, mainThread);
		const extHost = disposables.add(new ExtHostMcpService(rpc, new NullLogService(), new class extends mock<IExtHostInitDataService>() { }, new class extends mock<IExtHostWorkspace>() { }, new class extends mock<IExtHostVariableResolverProvider>() { }));
		rpc.set(ExtHostContext.ExtHostMcp, extHost);

		const api = await extHost.startMcpGateway(URI.parse('chat-session:/s2'), undefined);
		assert.ok(api);
		assert.deepStrictEqual(gateway.created, [{ inRemote: false, chatSessionResource: 'chat-session:/s2' }]);
		const [withGrpc, httpOnly] = api.servers;
		assert.ok(URI.isUri(withGrpc.address) && URI.isUri(withGrpc.grpcAddress), 'revived after the wire');
		assert.strictEqual(withGrpc.grpcAddress.toString(true), 'grpc://127.0.0.1:4101/r1');
		assert.strictEqual(withGrpc.address.toString(true), 'http://127.0.0.1:4100/gateway/r1');
		assert.deepStrictEqual([httpOnly.label, httpOnly.grpcAddress], ['HTTP only', undefined]);

		const changed = new Promise<typeof api.servers>(resolve => {
			const listener = api.onDidChangeServers(servers => {
				listener.dispose();
				resolve(servers);
			});
		});
		gateway.onDidChangeServers.fire([HTTP_ONLY, WITH_GRPC]);
		const servers = await changed;
		assert.deepStrictEqual(servers.map(s => [s.label, s.grpcAddress?.toString(true)]), [['HTTP only', undefined], ['With gRPC', 'grpc://127.0.0.1:4101/r1']]);
		assert.ok(servers.every(s => URI.isUri(s.address)));
		assert.deepStrictEqual(api.servers.map(s => s.label), ['HTTP only', 'With gRPC'], 'the gateway object follows the changes');

		api.dispose();
		await rpc.sync();
		assert.strictEqual(gateway.disposedCount(), 1);
	});

	test('through the extension host protocol: vscode.lm.startMcpGateway(resource, { grpc: true }) reaches the gateway service, other values do not ask for gRPC', async () => {
		const gateway = gatewayService();
		const rpc = new TestRPCProtocol();
		const mainThread = createMainThreadMcp(disposables, rpc.getProxy(ExtHostContext.ExtHostMcp), emptyRegistry(), services => services.stub(IWorkbenchMcpGatewayService, gateway.service));
		rpc.set(MainContext.MainThreadMcp, mainThread);
		const extHost = disposables.add(new ExtHostMcpService(rpc, new NullLogService(), new class extends mock<IExtHostInitDataService>() { }, new class extends mock<IExtHostWorkspace>() { }, new class extends mock<IExtHostVariableResolverProvider>() { }));
		rpc.set(ExtHostContext.ExtHostMcp, extHost);

		const session = URI.parse('chat-session:/s4');
		// Extensions written in JavaScript can pass anything.
		const notABoolean: unknown = { grpc: 1 };
		const apis = [
			await extHost.startMcpGateway(session, { grpc: true }),
			await extHost.startMcpGateway(undefined, { grpc: true }),
			// What the API factory forwards for vscode.lm.startMcpGateway(session).
			await extHost.startMcpGateway(session, undefined),
			await extHost.startMcpGateway(session, {}),
			await extHost.startMcpGateway(session, { grpc: false }),
			await extHost.startMcpGateway(session, notABoolean as Parameters<ExtHostMcpService['startMcpGateway']>[1]),
		];
		assert.deepStrictEqual(gateway.created, [
			{ inRemote: false, chatSessionResource: 'chat-session:/s4', options: { grpc: true } },
			{ inRemote: false, chatSessionResource: undefined, options: { grpc: true } },
			{ inRemote: false, chatSessionResource: 'chat-session:/s4' },
			{ inRemote: false, chatSessionResource: 'chat-session:/s4' },
			{ inRemote: false, chatSessionResource: 'chat-session:/s4' },
			{ inRemote: false, chatSessionResource: 'chat-session:/s4' },
		]);
		for (const api of apis) {
			assert.ok(api);
			api.dispose();
		}
		await rpc.sync();
		assert.strictEqual(gateway.disposedCount(), apis.length);
	});

	test('through the extension host protocol: the extension host sends { grpc: true } or no options, whatever object an extension passes', async () => {
		const gateway = gatewayService();
		const rpc = new TestRPCProtocol();
		const mainThread = createMainThreadMcp(disposables, rpc.getProxy(ExtHostContext.ExtHostMcp), emptyRegistry(), services => services.stub(IWorkbenchMcpGatewayService, gateway.service));
		// The options as they arrive in the renderer, before the main thread's own check.
		const received: unknown[] = [];
		const startMcpGateway = mainThread.$startMcpGateway.bind(mainThread);
		mainThread.$startMcpGateway = (chatSessionResource, options) => {
			received.push(options);
			return startMcpGateway(chatSessionResource, options);
		};
		rpc.set(MainContext.MainThreadMcp, mainThread);
		const extHost = disposables.add(new ExtHostMcpService(rpc, new NullLogService(), new class extends mock<IExtHostInitDataService>() { }, new class extends mock<IExtHostWorkspace>() { }, new class extends mock<IExtHostVariableResolverProvider>() { }));
		rpc.set(ExtHostContext.ExtHostMcp, extHost);

		const session = URI.parse('chat-session:/s5');
		// Extensions written in JavaScript can pass anything: other keys and values are not sent over the protocol.
		const options = (value: unknown) => value as Parameters<ExtHostMcpService['startMcpGateway']>[1];
		const apis = [
			await extHost.startMcpGateway(session, options({ grpc: 'yes', extra: 1 })),
			await extHost.startMcpGateway(session, options({ grpc: true, extra: 1, nested: { deep: [1, 2] } })),
			await extHost.startMcpGateway(session, options({ extra: 1 })),
		];
		assert.deepStrictEqual(received, [undefined, { grpc: true }, undefined]);
		for (const api of apis) {
			assert.ok(api);
			api.dispose();
		}
		await rpc.sync();
		assert.strictEqual(gateway.disposedCount(), apis.length);
	});
});
