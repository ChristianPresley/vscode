/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import * as nls from '../../../nls.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { MainContext, MainThreadAuthenticationShape, ExtHostAuthenticationShape, IRegisterDynamicAuthProviderOptions } from './extHost.protocol.js';
import { Proxied } from '../../services/extensions/common/proxyIdentifier.js';
import { Disposable, ProgressLocation } from './extHostTypes.js';
import { IExtensionDescription, ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { getAuthenticationSessionRequestKey, IAuthenticationGetSessionsOptions, IAuthenticationProviderSessionOptions, INTERNAL_AUTH_PROVIDER_PREFIX } from '../../services/authentication/common/authentication.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { AuthorizationErrorType, buildClientAuthentication, canonicalResourceUri, createPkcePair, fetchDynamicRegistration, getClaimsFromJWT, IAuthorizationJWTClaims, IAuthorizationProtectedResourceMetadata, IAuthorizationRedirectParams, IAuthorizationServerMetadata, IAuthorizationTokenResponse, isAuthorizationErrorResponse, isAuthorizationTokenResponse, isValidClientMetadataUrl, OAuthClientError, OAuthTokenEndpointAuthMethod, parseAuthorizationRedirect, pkceSupported, selectRegistrationAuthMethod, selectTokenEndpointAuthMethod, validateIssuerParameter } from '../../../base/common/oauth.js';
import { isSecureOAuthEndpoint, redact, resourceIndicatorFor } from '../../../base/common/oauthClient.js';
import { authorizationServerSupportsDpop, DPOP_HEADER, DPOP_NONCE_HEADER, isDpopTokenType, OAuthDpopProver, storedDpopKey, USE_DPOP_NONCE_ERROR } from '../../../base/common/oauthDpop.js';
import { MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION, MCP_OAUTH_DPOP_SESSION_OPTION, MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION } from './mcpOAuthClientFactory.js';
import { IExtHostWindow } from './extHostWindow.js';
import { IExtHostInitDataService } from './extHostInitDataService.js';
import { ILogger, ILoggerService, ILogService } from '../../../platform/log/common/log.js';
import { autorun, derivedOpts, IObservable, ISettableObservable, observableValue } from '../../../base/common/observable.js';
import { stringHash } from '../../../base/common/hash.js';
import { DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { IExtHostUrlsService } from './extHostUrls.js';
import { equals as arraysEqual } from '../../../base/common/arrays.js';
import { IExtHostProgress } from './extHostProgress.js';
import { NotificationTelemetryId } from '../../../platform/notification/common/notificationTelemetry.js';
import { IProgressStep } from '../../../platform/progress/common/progress.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { raceCancellationError, SequencerByKey } from '../../../base/common/async.js';
import { XaaifyAuthProvider } from './extHostXaaAuthProvider.js';

export interface IExtHostAuthentication extends ExtHostAuthentication { }
export const IExtHostAuthentication = createDecorator<IExtHostAuthentication>('IExtHostAuthentication');

interface ProviderWithMetadata {
	label: string;
	provider: vscode.AuthenticationProvider;
	disposable?: vscode.Disposable;
	options: vscode.AuthenticationProviderOptions;
}

/**
 * The account icon is a {@link vscode.Uri} that does not survive being sent over the RPC boundary,
 * so it needs to be revived when an account is received from the main thread.
 */
export function reviveAccountIcon<T extends { readonly icon?: vscode.Uri | UriComponents }>(account: T): T & { readonly icon?: vscode.Uri } {
	return { ...account, icon: URI.revive(account.icon) };
}

/**
 * The rule of the OAuth client's metadata validation for the authorization and token endpoints,
 * applied to the endpoints the providers here call themselves: HTTPS or loopback, unless the MCP
 * server's `oauth.allowInsecureHttp` allows plain HTTP. Anything else is a terminal
 * `insecure_endpoint` {@link OAuthClientError}, with a message the user may see.
 */
export function assertSecureAuthEndpoint(url: string, endpoint: 'registration' | 'deviceAuthorization', allowInsecureHttp: boolean | undefined): void {
	if (isSecureOAuthEndpoint(url, allowInsecureHttp)) {
		return;
	}
	throw new OAuthClientError('insecure_endpoint', endpoint === 'registration'
		? nls.localize('insecureRegistrationEndpoint', "The registration endpoint '{0}' is not served over HTTPS, so no client is registered there.", url)
		: nls.localize('insecureDeviceAuthorizationEndpoint', "The device authorization endpoint '{0}' is not served over HTTPS, so no device code is requested there.", url));
}

function getInteractiveOptionsForRequestKey(options: boolean | vscode.AuthenticationGetSessionPresentationOptions | undefined) {
	return typeof options === 'object'
		? { detail: options.detail, learnMore: options.learnMore?.toString() }
		: options;
}

export class ExtHostAuthentication implements ExtHostAuthenticationShape {

	declare _serviceBrand: undefined;

	protected readonly _dynamicAuthProviderCtor = DynamicAuthProvider;
	protected readonly _xaaAuthProviderCtor = XaaifyAuthProvider(DynamicAuthProvider);

	private _proxy: Proxied<MainThreadAuthenticationShape>;
	private _authenticationProviders: Map<string, ProviderWithMetadata> = new Map<string, ProviderWithMetadata>();
	private _providerOperations = new SequencerByKey<string>();

	private _onDidChangeSessions = new Emitter<vscode.AuthenticationSessionsChangeEvent & { extensionIdFilter?: string[] }>();
	private _getSessionTaskSingler = new TaskSingler<vscode.AuthenticationSession | undefined>();

	private _onDidDynamicAuthProviderTokensChange = new Emitter<{ authProviderId: string; clientId: string; tokens: IAuthorizationToken[] }>();

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@IExtHostInitDataService private readonly _initData: IExtHostInitDataService,
		@IExtHostWindow private readonly _extHostWindow: IExtHostWindow,
		@IExtHostUrlsService private readonly _extHostUrls: IExtHostUrlsService,
		@IExtHostProgress private readonly _extHostProgress: IExtHostProgress,
		@ILoggerService private readonly _extHostLoggerService: ILoggerService,
		@ILogService private readonly _logService: ILogService,
	) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadAuthentication);
	}

	/**
	 * This sets up an event that will fire when the auth sessions change with a built-in filter for the extensionId
	 * if a session change only affects a specific extension.
	 * @param extensionId The extension that is interested in the event.
	 * @returns An event with a built-in filter for the extensionId
	 */
	getExtensionScopedSessionsEvent(extensionId: string): Event<vscode.AuthenticationSessionsChangeEvent> {
		const normalizedExtensionId = extensionId.toLowerCase();
		return Event.chain(this._onDidChangeSessions.event, ($) => $
			.filter(e => !e.extensionIdFilter || e.extensionIdFilter.includes(normalizedExtensionId))
			.map(e => ({ provider: e.provider }))
		);
	}

	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions & ({ createIfNone: true } | { forceNewSession: true } | { forceNewSession: vscode.AuthenticationForceNewSessionOptions })): Promise<vscode.AuthenticationSession>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions & { forceNewSession: true }): Promise<vscode.AuthenticationSession>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions & { forceNewSession: vscode.AuthenticationForceNewSessionOptions }): Promise<vscode.AuthenticationSession>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions): Promise<vscode.AuthenticationSession | undefined>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions = {}): Promise<vscode.AuthenticationSession | undefined> {
		const extensionId = ExtensionIdentifier.toKey(requestingExtension.identifier);
		const singlerKey = JSON.stringify([extensionId, providerId, getAuthenticationSessionRequestKey(scopesOrRequest, {
			...options,
			account: options.account && { id: options.account.id, label: options.account.label },
			authorizationServer: URI.revive(options.authorizationServer),
			createIfNone: getInteractiveOptionsForRequestKey(options.createIfNone),
			forceNewSession: getInteractiveOptionsForRequestKey(options.forceNewSession)
		})]);

		return await this._getSessionTaskSingler.getOrCreate(singlerKey, async () => {
			await this._proxy.$ensureProvider(providerId);
			const extensionName = requestingExtension.displayName || requestingExtension.name;
			const session = await this._proxy.$getSession(providerId, scopesOrRequest, extensionId, extensionName, options);
			return session && {
				...session,
				account: reviveAccountIcon(session.account),
				authorizationServer: URI.revive(session.authorizationServer)
			};
		});
	}

	async getAccounts(providerId: string) {
		await this._proxy.$ensureProvider(providerId);
		const accounts = await this._proxy.$getAccounts(providerId);
		return accounts.map(account => reviveAccountIcon(account));
	}

	registerAuthenticationProvider(id: string, label: string, provider: vscode.AuthenticationProvider, options?: vscode.AuthenticationProviderOptions): vscode.Disposable {
		const disposables = new DisposableStore();
		// Capture changes before queueing, but forward them only after the main thread acknowledges registration.
		const bufferedSessionChanges = Event.buffer<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>(
			listener => provider.onDidChangeSessions(listener), 'authentication provider registration', false, [], disposables);
		const providerData: ProviderWithMetadata = { label, provider, disposable: disposables, options: options ?? { supportsMultipleAccounts: false } };
		// register
		void this._providerOperations.queue(id, async () => {
			// This use to be synchronous, but that wasn't an accurate representation because the main thread
			// may have unregistered the provider in the meantime. I don't see how this could really be done
			// synchronously, so we just say first one wins.
			if (this._authenticationProviders.get(id)) {
				disposables.dispose();
				this._logService.error(`An authentication provider with id '${id}' is already registered. The existing provider will not be replaced.`);
				return;
			}
			this._authenticationProviders.set(id, providerData);
			try {
				await this._proxy.$registerAuthenticationProvider({
					id,
					label,
					supportsMultipleAccounts: options?.supportsMultipleAccounts ?? false,
					supportedAuthorizationServers: options?.supportedAuthorizationServers,
					supportsChallenges: options?.supportsChallenges
				});
				disposables.add(bufferedSessionChanges(e => this._proxy.$sendDidChangeSessions(id, e)));
			} catch (error) {
				disposables.dispose();
				this._authenticationProviders.delete(id);
				this._logService.error(`Failed to register authentication provider '${id}'.`, error);
			}
		});

		// unregister
		return new Disposable(() => {
			void this._providerOperations.queue(id, async () => {
				if (this._authenticationProviders.get(id) === providerData) {
					disposables.dispose();
					this._authenticationProviders.delete(id);
					await this._proxy.$unregisterAuthenticationProvider(id);
				}
			});
		});
	}

	$createSession(providerId: string, scopes: string[], options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				options.authorizationServer = URI.revive(options.authorizationServer);
				if (options.account) {
					options.account = reviveAccountIcon(options.account);
				}
				return await providerData.provider.createSession(scopes, options);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$removeSession(providerId: string, sessionId: string): Promise<void> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				return await providerData.provider.removeSession(sessionId);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$getSessions(providerId: string, scopes: ReadonlyArray<string> | undefined, options: IAuthenticationGetSessionsOptions): Promise<ReadonlyArray<vscode.AuthenticationSession>> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				options.authorizationServer = URI.revive(options.authorizationServer);
				if (options.account) {
					options.account = reviveAccountIcon(options.account);
				}
				return await providerData.provider.getSessions(scopes, options);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$getSessionsFromChallenges(providerId: string, constraint: vscode.AuthenticationConstraint, options: vscode.AuthenticationProviderSessionOptions): Promise<ReadonlyArray<vscode.AuthenticationSession>> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				const provider = providerData.provider;
				// Check if provider supports challenges
				if (typeof provider.getSessionsFromChallenges === 'function') {
					options.authorizationServer = URI.revive(options.authorizationServer);
					if (options.account) {
						options.account = reviveAccountIcon(options.account);
					}
					return await provider.getSessionsFromChallenges(constraint, options);
				}
				throw new Error(`Authentication provider with handle: ${providerId} does not support getSessionsFromChallenges`);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$createSessionFromChallenges(providerId: string, constraint: vscode.AuthenticationConstraint, options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				const provider = providerData.provider;
				// Check if provider supports challenges
				if (typeof provider.createSessionFromChallenges === 'function') {
					options.authorizationServer = URI.revive(options.authorizationServer);
					if (options.account) {
						options.account = reviveAccountIcon(options.account);
					}
					return await provider.createSessionFromChallenges(constraint, options);
				}
				throw new Error(`Authentication provider with handle: ${providerId} does not support createSessionFromChallenges`);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$onDidChangeAuthenticationSessions(id: string, label: string, extensionIdFilter?: string[]) {
		// Don't fire events for the internal auth providers
		if (!id.startsWith(INTERNAL_AUTH_PROVIDER_PREFIX)) {
			this._onDidChangeSessions.fire({ provider: { id, label }, extensionIdFilter });
		}
		return Promise.resolve();
	}

	$onDidUnregisterAuthenticationProvider(id: string): Promise<void> {
		return this._providerOperations.queue(id, async () => {
			const providerData = this._authenticationProviders.get(id);
			if (providerData) {
				providerData.disposable?.dispose();
				this._authenticationProviders.delete(id);
			}
		});
	}

	async $registerDynamicAuthProvider(
		authorizationServerComponents: UriComponents,
		serverMetadata: IAuthorizationServerMetadata,
		resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined,
		clientId: string | undefined,
		clientSecret: string | undefined,
		initialTokens: IAuthorizationToken[] | undefined,
		tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod,
		options?: IRegisterDynamicAuthProviderOptions,
	): Promise<string> {
		if (!clientId) {
			const authorizationServer = URI.revive(authorizationServerComponents);
			tokenEndpointAuthMethod = undefined;
			if (serverMetadata.registration_endpoint) {
				try {
					// Client metadata is posted there and the response carries the client secret.
					assertSecureAuthEndpoint(serverMetadata.registration_endpoint, 'registration', options?.allowInsecureHttp);
					const registration = await fetchDynamicRegistration(serverMetadata, this._initData.environment.appName, resourceMetadata?.scopes_supported, {
						tokenEndpointAuthMethod: selectRegistrationAuthMethod(serverMetadata.token_endpoint_auth_methods_supported),
					});
					clientId = registration.client_id;
					clientSecret = registration.client_secret;
					tokenEndpointAuthMethod = selectTokenEndpointAuthMethod(registration.token_endpoint_auth_method, serverMetadata.token_endpoint_auth_methods_supported, registration.client_secret !== undefined);
				} catch (err) {
					this._logService.warn(`Dynamic registration failed for ${authorizationServer.toString()}: ${redact(err.message)}. Prompting user for client ID and client secret...`);
				}
			}
			// Still no client id so dynamic client registration was either not supported or failed
			if (!clientId) {
				this._logService.info(`Prompting user for client registration details for ${authorizationServer.toString()}`);
				const clientDetails = await this._proxy.$promptForClientRegistration(authorizationServer.toString());
				if (!clientDetails) {
					throw new Error('User did not provide client details');
				}
				clientId = clientDetails.clientId;
				clientSecret = clientDetails.clientSecret;
				this._logService.info(`User provided client registration for ${authorizationServer.toString()}`);
				if (clientSecret) {
					this._logService.trace(`User provided client secret for ${authorizationServer.toString()}`);
				} else {
					this._logService.trace(`User did not provide client secret for ${authorizationServer.toString()}`);
				}
			}
		}
		const provider = new this._dynamicAuthProviderCtor(
			this._extHostWindow,
			this._extHostUrls,
			this._initData,
			this._extHostProgress,
			this._extHostLoggerService,
			this._proxy,
			URI.revive(authorizationServerComponents),
			serverMetadata,
			resourceMetadata,
			clientId,
			clientSecret,
			this._onDidDynamicAuthProviderTokensChange,
			initialTokens || []
		);
		if (tokenEndpointAuthMethod) {
			provider.setTokenEndpointAuthMethod(tokenEndpointAuthMethod);
		}
		if (options?.requireAdvertisedPkce) {
			provider.requireAdvertisedPkce();
		}
		// `options.allowInsecureHttp` was the creator's rule for the registration above only: the provider is
		// shared with callers whose rule may differ, so it reads each caller's rule from its requests.

		// Use the sequencer to ensure dynamic provider registration is serialized
		await this._providerOperations.queue(provider.id, async () => {
			this._authenticationProviders.set(
				provider.id,
				{
					label: provider.label,
					provider,
					disposable: Disposable.from(
						provider,
						provider.onDidChangeSessions(e => this._proxy.$sendDidChangeSessions(provider.id, e)),
						provider.onDidChangeClientId(() => this._proxy.$sendDidChangeDynamicProviderInfo({
							providerId: provider.id,
							clientId: provider.clientId,
							clientSecret: provider.clientSecret,
							tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
						}))
					),
					options: { supportsMultipleAccounts: true }
				}
			);

			await this._proxy.$registerDynamicAuthenticationProvider({
				id: provider.id,
				label: provider.label,
				supportsMultipleAccounts: true,
				authorizationServer: authorizationServerComponents,
				resourceServer: resourceMetadata ? URI.parse(resourceMetadata.resource) : undefined,
				clientId: provider.clientId,
				clientSecret: provider.clientSecret,
				tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
			});
		});




		return provider.id;
	}

	async $registerXaaAuthProvider(
		issuerComponents: UriComponents,
		serverMetadata: IAuthorizationServerMetadata,
		clientId: string | undefined,
		clientSecret: string | undefined,
		initialTokens: IAuthorizationToken[] | undefined
	): Promise<string> {
		const issuer = URI.revive(issuerComponents);
		// XAA does not use Dynamic Client Registration — the IdP must already trust the requesting
		// app for the target audience(s). Always require an admin-provisioned client_id (and
		// typically client_secret).
		if (!clientId) {
			this._logService.info(`Prompting user for client registration details for XAA issuer ${issuer.toString()}`);
			const clientDetails = await this._proxy.$promptForClientRegistration(issuer.toString());
			if (!clientDetails) {
				throw new Error('User did not provide client details');
			}
			clientId = clientDetails.clientId;
			clientSecret = clientDetails.clientSecret;
		}
		const provider = new this._xaaAuthProviderCtor(
			this._extHostWindow,
			this._extHostUrls,
			this._initData,
			this._extHostProgress,
			this._extHostLoggerService,
			this._proxy,
			issuer,
			serverMetadata,
			/* resourceMetadata */ undefined,
			clientId,
			clientSecret,
			this._onDidDynamicAuthProviderTokensChange,
			initialTokens || []
		);

		await this._providerOperations.queue(provider.id, async () => {
			this._authenticationProviders.set(
				provider.id,
				{
					label: provider.label,
					provider,
					disposable: Disposable.from(
						provider,
						provider.onDidChangeSessions(e => this._proxy.$sendDidChangeSessions(provider.id, e)),
						provider.onDidChangeClientId(() => this._proxy.$sendDidChangeDynamicProviderInfo({
							providerId: provider.id,
							clientId: provider.clientId,
							clientSecret: provider.clientSecret
						}))
					),
					options: { supportsMultipleAccounts: true }
				}
			);

			await this._proxy.$registerDynamicAuthenticationProvider({
				id: provider.id,
				label: provider.label,
				supportsMultipleAccounts: true,
				authorizationServer: issuerComponents,
				resourceServer: undefined,
				clientId: provider.clientId,
				clientSecret: provider.clientSecret
			});
		});

		return provider.id;
	}

	async $onDidChangeDynamicAuthProviderTokens(authProviderId: string, clientId: string, tokens: IAuthorizationToken[]): Promise<void> {
		this._onDidDynamicAuthProviderTokensChange.fire({ authProviderId, clientId, tokens });
	}
}

class TaskSingler<T> {
	private _inFlightPromises = new Map<string, Promise<T>>();
	getOrCreate(key: string, promiseFactory: () => Promise<T>) {
		const inFlight = this._inFlightPromises.get(key);
		if (inFlight) {
			return inFlight;
		}

		const promise = promiseFactory().finally(() => this._inFlightPromises.delete(key));
		this._inFlightPromises.set(key, promise);

		return promise;
	}
}

// Mirrors `MICROSOFT_AUTH_HOSTNAMES` and the `is_microsoft_authorization_server` / `is_microsoft_auth_endpoint_aware`
// matching in github/copilot-agent-runtime `src/runtime/src/auth_base/microsoft.rs`; keep them in sync.
const MICROSOFT_AUTH_HOSTS = [
	'login.microsoftonline.com',
	'login.microsoftonline.de',
	'login.microsoftonline.us',
	'login.partner.microsoftonline.cn',
	'login.microsoft.com',
	'login.windows.net',
	'sts.windows.net',
];

/** The `nonce` parameter of a query string. */
function nonceOfQuery(query: string): string | undefined {
	return new URLSearchParams(query.startsWith('?') ? query.substring(1) : query).get('nonce') ?? undefined;
}

/**
 * The `nonce` of the callback URI a forwarded `state` names; `undefined` when it names none.
 *
 * On desktop the state is the app URI itself (`vscode://dynamicauthprovider/…?nonce=…`). On the web
 * and in remote-in-browser setups (Codespaces), `createAppUri` returns the workbench's callback page,
 * which carries the app URI's own query encoded in its `vscode-query` parameter
 * (`https://<host>/callback?vscode-reqid=…&vscode-scheme=…&vscode-query=nonce%3D…`; the page decodes
 * it and hands the URI handler the app URI): the nonce is read from there when it is present. The
 * state may arrive as sent (`URI.toString()` encodes the whole query once more) or decoded.
 */
function nonceOfCallbackUri(uri: string): string | undefined {
	let query: string;
	try {
		// `URI.parse` decodes the query once.
		query = URI.parse(uri).query;
	} catch {
		return undefined;
	}
	const params = new URLSearchParams(query);
	const appQuery = params.get('vscode-query');
	return appQuery !== null ? nonceOfQuery(appQuery) : params.get('nonce') ?? undefined;
}

function isMicrosoftAuthUrl(url: string | undefined): boolean {
	if (!url) {
		return false;
	}
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return false;
	}
	return MICROSOFT_AUTH_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

export class DynamicAuthProvider implements vscode.AuthenticationProvider {
	id: string;
	readonly label: string;

	private _onDidChangeSessions = new Emitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _onDidChangeClientId = new Emitter<void>();
	readonly onDidChangeClientId = this._onDidChangeClientId.event;

	private readonly _tokenStore: TokenStore;

	protected readonly _createFlows: Array<{
		label: string;
		handler: (scopes: string[], progress: vscode.Progress<{ message: string }>, token: vscode.CancellationToken) => Promise<IAuthorizationTokenResponse>;
	}>;

	protected readonly _logger: ILogger;
	protected readonly _isMicrosoftAuth: boolean;
	private readonly _disposable: DisposableStore;
	/** How the client authenticates at the token endpoint (RFC 6749 section 2.3). */
	protected _tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
	/** Whether the creator of the provider (an MCP server) refuses an authorization server that does not advertise PKCE `S256`. */
	private _requireAdvertisedPkce = false;
	/**
	 * The `resource` the request being served names (`options.resource` of {@link getSessions} and
	 * {@link createSession}): the MCP server URL when the server publishes no protected resource
	 * metadata. The extension host serializes the requests to a provider, so it belongs to one request.
	 */
	private _requestedResource: string | undefined;
	/**
	 * The endpoint policy of the request being served, read like {@link _requestedResource}: a
	 * provider is shared by every caller with the same authorization server and resource (servers
	 * in mcp.json, the agent host), so the policy of the caller applies, not the creator's. The
	 * workbench passes an MCP server's `oauth.allowInsecureHttp` and its PKCE rule as workbench-only
	 * session options ({@link MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION},
	 * {@link MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION}); any other request gets the strict
	 * endpoint rule.
	 */
	private _requestPolicy: { readonly allowInsecureHttp: boolean; readonly requireAdvertisedPkce: boolean; readonly dpop: boolean } = { allowInsecureHttp: false, requireAdvertisedPkce: false, dpop: false };
	/**
	 * The DPoP key of the sign-in in progress (RFC 9449): set when its request asks for a
	 * DPoP-bound token ({@link MCP_OAUTH_DPOP_SESSION_OPTION}) and the authorization server
	 * supports DPoP. The token requests of the sign-in prove possession of it, and a DPoP-bound
	 * token is stored with it.
	 */
	protected _signInDpopProver: OAuthDpopProver | undefined;

	constructor(
		@IExtHostWindow protected readonly _extHostWindow: IExtHostWindow,
		@IExtHostUrlsService protected readonly _extHostUrls: IExtHostUrlsService,
		@IExtHostInitDataService protected readonly _initData: IExtHostInitDataService,
		@IExtHostProgress private readonly _extHostProgress: IExtHostProgress,
		@ILoggerService loggerService: ILoggerService,
		protected readonly _proxy: Proxied<MainThreadAuthenticationShape>,
		readonly authorizationServer: URI,
		protected readonly _serverMetadata: IAuthorizationServerMetadata,
		protected readonly _resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined,
		protected _clientId: string,
		protected _clientSecret: string | undefined,
		onDidDynamicAuthProviderTokensChange: Emitter<{ authProviderId: string; clientId: string; tokens: IAuthorizationToken[] }>,
		initialTokens: IAuthorizationToken[],
		// Not `fetch` itself: called as a method, a browser's `fetch` throws "Illegal invocation".
		protected readonly _fetch: typeof fetch = (input, init) => fetch(input, init),
	) {
		const stringifiedServer = authorizationServer.toString(true);
		// Auth Provider Id is a combination of the authorization server and the resource, if provided.
		this.id = _resourceMetadata?.resource
			? stringifiedServer + ' ' + _resourceMetadata?.resource
			: stringifiedServer;
		// Auth Provider label is just the resource name if provided, otherwise the authority of the authorization server.
		this.label = _resourceMetadata?.resource_name ?? this.authorizationServer.authority;
		// Metadata is untrusted, so the token endpoint must also be Microsoft to earn Microsoft-specific treatment.
		this._isMicrosoftAuth = (isMicrosoftAuthUrl(stringifiedServer) || isMicrosoftAuthUrl(_serverMetadata.authorization_endpoint))
			&& isMicrosoftAuthUrl(_serverMetadata.token_endpoint);
		// A client without a recorded method is public without a secret, and uses the method the server supports with one.
		this._tokenEndpointAuthMethod = selectTokenEndpointAuthMethod(undefined, _serverMetadata.token_endpoint_auth_methods_supported, _clientSecret !== undefined);

		this._logger = loggerService.createLogger(this.id, { name: `Auth: ${this.label}` });
		this._disposable = new DisposableStore();
		this._disposable.add(this._onDidChangeSessions);
		this._disposable.add(this._onDidChangeClientId);
		const scopedEvent = Event.chain(onDidDynamicAuthProviderTokensChange.event, $ => $
			.filter(e => e.authProviderId === this.id && e.clientId === _clientId)
			.map(e => e.tokens)
		);
		this._tokenStore = this._disposable.add(new TokenStore(
			{
				onDidChange: scopedEvent,
				set: (tokens) => _proxy.$setSessionsForDynamicAuthProvider(this.id, this.clientId, tokens),
			},
			initialTokens,
			this._logger
		));
		this._disposable.add(this._tokenStore.onDidChangeSessions(e => this._onDidChangeSessions.fire(e)));
		// Will be extended later to support other flows
		this._createFlows = [];
		if (_serverMetadata.authorization_endpoint) {
			this._createFlows.push({
				label: nls.localize('url handler', "URL Handler"),
				handler: (scopes, progress, token) => this._createWithUrlHandler(scopes, progress, token)
			});
		}
	}

	get clientId(): string {
		return this._clientId;
	}

	get clientSecret(): string | undefined {
		return this._clientSecret;
	}

	get tokenEndpointAuthMethod(): OAuthTokenEndpointAuthMethod {
		return this._tokenEndpointAuthMethod;
	}

	/** Records the token endpoint authentication method the registration was made with. */
	setTokenEndpointAuthMethod(method: OAuthTokenEndpointAuthMethod): void {
		this._tokenEndpointAuthMethod = method;
	}

	/**
	 * Makes the authorization code flows refuse an authorization server that
	 * does not advertise PKCE `S256`: the rule for MCP servers, whose metadata
	 * the MCP transport produced (`oauth.pkce: "assume-supported"` in
	 * `mcp.json` makes it hand on metadata that advertises it). It applies to
	 * every request; a request can also ask for it on its own
	 * ({@link MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION}).
	 */
	requireAdvertisedPkce(): void {
		this._requireAdvertisedPkce = true;
	}

	/** Reads the resource and the endpoint policy of the request being served (see {@link _requestPolicy}). */
	private _beginRequest(options: { readonly resource?: unknown }): void {
		this._requestedResource = typeof options.resource === 'string' ? options.resource : undefined;
		const record = options as Record<string, unknown>;
		this._requestPolicy = {
			allowInsecureHttp: record[MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION] === true,
			requireAdvertisedPkce: record[MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION] === true,
			dpop: record[MCP_OAUTH_DPOP_SESSION_OPTION] === true,
		};
	}

	/**
	 * Binds the authorization code of the sign-in in progress to its DPoP key (`dpop_jkt`,
	 * RFC 9449 section 10), when it has one.
	 */
	protected _bindAuthorizationToDpopKey(authorizationUrl: URL): void {
		if (this._signInDpopProver) {
			authorizationUrl.searchParams.set('dpop_jkt', this._signInDpopProver.thumbprint);
		}
	}

	/**
	 * Sends a token request ({@link _buildTokenRequest}) with the provider's fetch. With a DPoP
	 * key it carries a fresh proof, and a `use_dpop_nonce` error is answered once with the
	 * server's nonce (RFC 9449 section 8). The body is parsed when it is JSON.
	 */
	protected async _postTokenRequest(params: Record<string, string>, prover: OAuthDpopProver | undefined): Promise<{ readonly response: Response; readonly result: unknown }> {
		const tokenEndpoint = this._serverMetadata.token_endpoint!;
		for (let attempt = 0; ; attempt++) {
			const request = this._buildTokenRequest(params);
			const headers: Record<string, string> = { ...request.headers };
			if (prover) {
				headers[DPOP_HEADER] = await prover.createProof('POST', tokenEndpoint);
			}
			const response = await this._fetch(tokenEndpoint, { method: 'POST', headers, body: request.body });
			const nonce = response.headers.get(DPOP_NONCE_HEADER);
			if (prover && nonce !== null) {
				prover.rememberNonce(tokenEndpoint, nonce);
			}
			let result: unknown;
			try {
				result = await response.json();
			} catch {
				result = undefined;
			}
			if (prover && attempt === 0 && nonce !== null && response.status === 400 && isAuthorizationErrorResponse(result) && result.error === USE_DPOP_NONCE_ERROR) {
				this._logger.info('The token endpoint asked for a DPoP nonce; sending the request again.');
				continue;
			}
			return { response, result };
		}
	}

	/**
	 * Whether the request being served may use a plain-HTTP endpoint on a non-loopback host for
	 * credentials (a new registration, the device authorization endpoint): an MCP server's
	 * `oauth.allowInsecureHttp`, passed by the workbench with each of its requests. Otherwise only
	 * HTTPS or loopback endpoints are used.
	 */
	protected get _allowsInsecureHttp(): boolean {
		return this._requestPolicy.allowInsecureHttp;
	}

	/**
	 * The authorization code flows always send an `S256` challenge. Only a
	 * provider for an MCP server ({@link requireAdvertisedPkce}), or a request
	 * for one, refuses an authorization server that does not advertise it;
	 * others (an identity provider such as Entra ID, which does not advertise
	 * `code_challenge_methods_supported`) only log the omission.
	 */
	protected _assertPkceSupported(): void {
		if (pkceSupported(this._serverMetadata)) {
			return;
		}
		if (this._requireAdvertisedPkce || this._requestPolicy.requireAdvertisedPkce) {
			throw new OAuthClientError('pkce_unsupported', nls.localize('pkceUnsupported', "The authorization server '{0}' does not advertise support for PKCE (S256), which is required to sign in securely.", this._serverMetadata.issuer));
		}
		this._logger.warn(`The authorization server ${this._serverMetadata.issuer} does not advertise PKCE S256 support; sending an S256 code challenge anyway.`);
	}

	/** Creates the PKCE verifier and its `S256` challenge (RFC 7636). */
	protected _createPkcePair(): Promise<{ verifier: string; challenge: string }> {
		return createPkcePair(
			bytes => crypto.getRandomValues(new Uint8Array(bytes)),
			async data => new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)),
		);
	}

	/**
	 * Validates an authorization response in the order RFC 9207 requires: the
	 * `iss` parameter first (it is compared to the recorded issuer by exact
	 * string equality), then the `state`, then an `error`. Returns the
	 * authorization code.
	 *
	 * @param expectedState The `state` the request carried, or whether the
	 * response returned it, for a redirect that delivers it in another form.
	 */
	protected _validateAuthorizationResponse(params: IAuthorizationRedirectParams, expectedState: string | ((params: IAuthorizationRedirectParams) => boolean)): string {
		const issError = validateIssuerParameter(this._serverMetadata.authorization_response_iss_parameter_supported, params.iss, this._serverMetadata.issuer);
		if (issError) {
			this._logger.error(`Rejecting the authorization response: ${issError.message}`);
			throw issError;
		}
		if (typeof expectedState === 'string' ? params.state !== expectedState : !expectedState(params)) {
			this._logger.error('Rejecting the authorization response: it does not carry the state of the request');
			throw new OAuthClientError('state_mismatch', nls.localize('authStateMismatch', "The authorization response does not carry the state of the request."));
		}
		if (params.error) {
			const reason = params.errorDescription ? `${params.error} (${params.errorDescription})` : params.error;
			throw new OAuthClientError('authorization_denied', nls.localize('authDenied', "The authorization server denied the request: {0}", reason), { error: params.error, errorDescription: params.errorDescription });
		}
		if (!params.code) {
			throw new OAuthClientError('authorization_denied', nls.localize('authNoCode', "Authentication failed: no authorization code was received."));
		}
		return params.code;
	}

	/** The token endpoint request: the grant's parameters plus the client authentication of {@link tokenEndpointAuthMethod}. */
	protected _buildTokenRequest(params: Record<string, string>): { headers: Record<string, string>; body: string } {
		const auth = buildClientAuthentication(this._tokenEndpointAuthMethod, this._clientId, this._clientSecret);
		const body = new URLSearchParams({ ...auth.body, ...params });
		return {
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Accept': 'application/json',
				...auth.headers,
			},
			body: body.toString(),
		};
	}

	/**
	 * The token response of the code grant and of a refresh, by the rule of the OAuth client
	 * (`OAuthClient`): HTTP 200 (RFC 6749 section 5.1) with a token response; `undefined` for any
	 * other, which the caller reports. A 200 response whose token is empty, or neither a `Bearer`
	 * token (RFC 6750) nor, for a request that proved possession of `prover`'s key, a `DPoP` token
	 * (RFC 9449), which VS Code cannot send, fails with a `token_request_failed`
	 * {@link OAuthClientError}. A DPoP-bound token is returned with its key (`dpop_jwk`), which it is
	 * stored with.
	 */
	protected _acceptTokenResponse(response: Response, result: unknown, prover?: OAuthDpopProver): IAuthorizationTokenResponse | undefined {
		if (response.status !== 200 || !isAuthorizationTokenResponse(result)) {
			return undefined;
		}
		if (typeof result.access_token !== 'string' || result.access_token.length === 0) {
			throw new OAuthClientError('token_request_failed', nls.localize('authNoAccessToken', "The token endpoint of '{0}' issued no usable access token.", this._serverMetadata.issuer));
		}
		if (prover && isDpopTokenType(result.token_type)) {
			const bound: IAuthorizationTokenResponse & Pick<IAuthorizationToken, 'dpop_jwk'> = { ...result, dpop_jwk: prover.privateJwk };
			return bound;
		}
		if (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer') {
			throw new OAuthClientError('token_request_failed', nls.localize('authUnsupportedTokenType', "The token endpoint of '{0}' issued an unsupported token type '{1}'.", this._serverMetadata.issuer, String(result.token_type)));
		}
		return result;
	}

	/**
	 * Whether `error` is the authorization server refusing this client as a Client ID Metadata
	 * Document client (`invalid_client` in the authorization response, after `iss` and `state` were
	 * validated): its `client_id` is a metadata document URL and the server advertises support.
	 */
	private _isRefusedClientIdMetadataDocument(error: OAuthClientError): boolean {
		const detail = error.detail as { readonly error?: unknown } | undefined;
		return error.code === 'authorization_denied'
			&& detail?.error === AuthorizationErrorType.InvalidClient
			&& this._serverMetadata.client_id_metadata_document_supported === true
			&& isValidClientMetadataUrl(this._clientId);
	}

	/** A loggable summary of a token response: never the tokens themselves. */
	protected _describeTokenResponse(token: IAuthorizationTokenResponse): string {
		return `token_type=${token.token_type}, scope=${token.scope ?? '(none)'}, expires_in=${token.expires_in ?? '(none)'}, refresh_token=${token.refresh_token ? 'present' : 'absent'}, id_token=${token.id_token ? 'present' : 'absent'}`;
	}

	/**
	 * The RFC 8707 resource indicator to send in the authorization and token requests, by the rule
	 * of the OAuth client (`resourceIndicatorFor`): the `resource` of the protected resource
	 * metadata as published, less any fragment; without metadata the resource the request names
	 * (the MCP server URL), slash-less for a bare origin. Omitted for Microsoft auth.
	 */
	protected get _resourceIndicator(): string | undefined {
		if (this._isMicrosoftAuth) {
			return undefined;
		}
		const published = this._resourceMetadata?.resource;
		const resource = published ?? this._requestedResource;
		if (resource === undefined) {
			return undefined;
		}
		try {
			return resourceIndicatorFor(canonicalResourceUri(resource), published);
		} catch {
			// Not a URL: metadata is sent as published, a requested resource not at all.
			return published;
		}
	}

	/**
	 * The scopes to send to the server, adding `offline_access` when the server advertises it.
	 * Empty scopes are left empty so servers can still apply their default scopes.
	 */
	protected _getRequestScopes(scopes: readonly string[]): string[] {
		if (scopes.length && this._serverMetadata.scopes_supported?.includes('offline_access') && !scopes.includes('offline_access')) {
			return [...scopes, 'offline_access'];
		}
		return [...scopes];
	}

	/**
	 * The resource the tokens of the request being served are bound to: without protected resource
	 * metadata a provider is keyed by its authorization server only, so the MCP servers of one origin
	 * share it, and each of their tokens is issued for one server's URL (RFC 8707). `undefined` when
	 * the provider is for one resource already (published metadata), or no resource is sent.
	 */
	private get _boundResource(): string | undefined {
		return this._resourceMetadata?.resource ? undefined : this._resourceIndicator;
	}

	/** Records on a token the resource it was issued for (see {@link _boundResource}). */
	private _bindToken(token: IAuthorizationTokenResponse, createdAt: number): IAuthorizationToken {
		return { ...token, created_at: createdAt, resource: this._boundResource };
	}

	/**
	 * Whether a stored token can serve the request: one bound to a resource serves only requests for
	 * that resource. A token stored without one (before tokens were bound, or by a provider for one
	 * resource) serves any.
	 */
	private _tokenServesRequest(token: IAuthorizationToken | undefined): boolean {
		const bound = this._boundResource;
		return bound === undefined || token?.resource === undefined || token.resource === bound;
	}

	async getSessions(scopes: readonly string[] | undefined, options: IAuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
		this._beginRequest(options);
		this._logger.info(`Getting sessions for scopes: ${scopes?.join(' ') ?? 'all'}`);
		if (!scopes) {
			return this._tokenStore.sessions;
		}
		// The oauth spec says tthat order doesn't matter so we sort the scopes for easy comparison
		// https://datatracker.ietf.org/doc/html/rfc6749#section-3.3
		// TODO@TylerLeonhardt: Do this for all scope handling in the auth APIs
		const sortedScopes = [...scopes].sort();
		const scopeStr = scopes.join(' ');
		const matching = () => {
			const tokens = new Map<string, IAuthorizationToken>(this._tokenStore.tokens.map(token => [token.access_token, token]));
			return this._tokenStore.sessions.filter(session => arraysEqual([...session.scopes].sort(), sortedScopes) && this._tokenServesRequest(tokens.get(session.accessToken)));
		};
		let sessions = matching();
		this._logger.info(`Found ${sessions.length} sessions for scopes: ${scopeStr}`);
		if (sessions.length) {
			const newTokens: IAuthorizationToken[] = [];
			const removedTokens: IAuthorizationToken[] = [];
			const tokenMap = new Map<string, IAuthorizationToken>(this._tokenStore.tokens.map(token => [token.access_token, token]));
			for (const session of sessions) {
				const token = tokenMap.get(session.accessToken);
				if (token && token.expires_in) {
					const now = Date.now();
					const expiresInMS = token.expires_in * 1000;
					// Check if the token is about to expire in 5 minutes or if it is expired
					if (now > token.created_at + expiresInMS - (5 * 60 * 1000)) {
						this._logger.info(`Token for session ${session.id} is about to expire, refreshing...`);
						removedTokens.push(token);
						if (!token.refresh_token) {
							// No refresh token available, cannot refresh
							this._logger.warn(`No refresh token available for scopes ${session.scopes.join(' ')}. Throwing away token.`);
							continue;
						}
						try {
							const newToken = await this.exchangeRefreshTokenForToken(token.refresh_token, session.scopes, options.silent !== true, storedDpopKey(token));
							// TODO@TylerLeonhardt: When the core scope handling doesn't care about order, this check should be
							// updated to not care about order
							if (newToken.scope !== scopeStr) {
								this._logger.warn(`Token scopes '${newToken.scope}' do not match requested scopes '${scopeStr}'. Overwriting token with what was requested...`);
								newToken.scope = scopeStr;
							}
							this._logger.info(`Successfully created a new token for scopes ${session.scopes.join(' ')}.`);
							newTokens.push(newToken);
						} catch (err) {
							this._logger.error(`Failed to refresh token: ${err}`);
						}

					}
				}
			}
			if (newTokens.length || removedTokens.length) {
				this._tokenStore.update({ added: newTokens, removed: removedTokens });
				// Since we updated the tokens, we need to re-filter the sessions
				// to get the latest state
				sessions = matching();
			}
			this._logger.info(`Found ${sessions.length} sessions for scopes: ${scopeStr}`);
			return sessions;
		}
		return [];
	}

	async createSession(scopes: string[], options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
		this._beginRequest(options);
		this._logger.info(`Creating session for scopes: ${scopes.join(' ')}`);
		this._signInDpopProver = this._requestPolicy.dpop && authorizationServerSupportsDpop(this._serverMetadata) ? await OAuthDpopProver.generate() : undefined;
		if (this._signInDpopProver) {
			this._logger.info('Requesting a DPoP-bound token.');
		}
		try {
			return await this._createSession(scopes);
		} finally {
			this._signInDpopProver = undefined;
		}
	}

	private async _createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
		let token: IAuthorizationTokenResponse | undefined;
		for (let i = 0; i < this._createFlows.length; i++) {
			const { handler } = this._createFlows[i];
			try {
				token = await this._extHostProgress.withProgressFromSource(
					{ label: this.label, id: this.id },
					{
						location: ProgressLocation.Notification,
						title: nls.localize('authenticatingTo', "Authenticating to '{0}'", this.label),
						cancellable: true
					},
					(progress, token) => handler(scopes, progress, token),
					NotificationTelemetryId.AuthenticationSignIn);
				if (token) {
					break;
				}
			} catch (err) {
				if (err instanceof OAuthClientError && this._isRefusedClientIdMetadataDocument(err)) {
					// As the OAuth client does: the authorization server advertises Client ID Metadata Documents but
					// did not accept ours, so the client registers another way (dynamically, else with the user's client).
					this._logger.warn(`The authorization server ${this._serverMetadata.issuer} refused the client ID metadata document client (${this._clientId}); registering another way.`);
					await this._generateNewClientId();
					throw new Error(`Client ID was invalid, generated a new one. Please try again.`);
				}
				if (err instanceof OAuthClientError) {
					// A protocol or security failure (PKCE unsupported, an issuer mismatch, ...) is not
					// something another flow fixes: surface it as is.
					this._logger.error(`Authentication failed: ${err.message}`);
					throw err;
				}
				const nextMode = this._createFlows[i + 1]?.label;
				if (!nextMode) {
					break; // No more flows to try
				}
				const message = isCancellationError(err)
					? nls.localize('userCanceledContinue', "Having trouble authenticating to '{0}'? Would you like to try a different way? ({1})", this.label, nextMode)
					: nls.localize('continueWith', "You have not yet finished authenticating to '{0}'. Would you like to try a different way? ({1})", this.label, nextMode);

				const result = await this._proxy.$showContinueNotification(message);
				if (!result) {
					throw new CancellationError();
				}
				this._logger.error(`Failed to create token via flow '${nextMode}': ${err}`);
			}
		}
		if (!token) {
			throw new Error('Failed to create authentication token');
		}
		if (token.scope !== scopes.join(' ')) {
			this._logger.warn(`Token scopes '${token.scope}' do not match requested scopes '${scopes.join(' ')}'. Overwriting token with what was requested...`);
			token.scope = scopes.join(' ');
		}

		// Store session for later retrieval, bound to the resource it was issued for
		this._tokenStore.update({ added: [this._bindToken(token, Date.now())], removed: [] });
		const session = this._tokenStore.sessions.find(t => t.accessToken === token.access_token)!;
		this._logger.info(`Created ${token.refresh_token ? 'refreshable' : 'non-refreshable'} session for scopes: ${token.scope}${token.expires_in ? ` that expires in ${token.expires_in} seconds` : ''}`);
		return session;
	}

	async removeSession(sessionId: string): Promise<void> {
		this._logger.info(`Removing session with id: ${sessionId}`);
		const session = this._tokenStore.sessions.find(session => session.id === sessionId);
		if (!session) {
			this._logger.error(`Session with id ${sessionId} not found`);
			return;
		}
		const token = this._tokenStore.tokens.find(token => token.access_token === session.accessToken);
		if (!token) {
			this._logger.error(`Failed to retrieve token for removed session: ${session.id}`);
			return;
		}
		this._tokenStore.update({ added: [], removed: [token] });
		this._logger.info(`Removed token for session: ${session.id} with scopes: ${session.scopes.join(' ')}`);
	}

	dispose(): void {
		this._disposable.dispose();
	}

	private async _createWithUrlHandler(scopes: string[], progress: vscode.Progress<IProgressStep>, token: vscode.CancellationToken): Promise<IAuthorizationTokenResponse> {
		if (!this._serverMetadata.authorization_endpoint) {
			throw new Error('Authorization Endpoint required');
		}
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}
		this._assertPkceSupported();

		// Generate PKCE code verifier (random string) and code challenge (SHA-256 hash of verifier)
		const { verifier: codeVerifier, challenge: codeChallenge } = await this._createPkcePair();

		// Generate a random state value to prevent CSRF
		const nonce = this.generateRandomString(32);
		const callbackUri = URI.parse(`${this._initData.environment.appUriScheme}://dynamicauthprovider/${this.authorizationServer.authority}/authorize?nonce=${nonce}`);
		let state: URI;
		try {
			state = await this._extHostUrls.createAppUri(callbackUri);
		} catch (error) {
			throw new Error(`Failed to create external URI: ${error}`);
		}

		// Prepare the authorization request URL
		const authorizationUrl = new URL(this._serverMetadata.authorization_endpoint);
		authorizationUrl.searchParams.append('client_id', this._clientId);
		authorizationUrl.searchParams.append('response_type', 'code');
		authorizationUrl.searchParams.append('state', state.toString());
		authorizationUrl.searchParams.append('code_challenge', codeChallenge);
		authorizationUrl.searchParams.append('code_challenge_method', 'S256');
		const scopeString = scopes.join(' ');
		const requestScopeString = this._getRequestScopes(scopes).join(' ');
		if (requestScopeString) {
			// If non-empty scopes are provided, include scope parameter in the request
			authorizationUrl.searchParams.append('scope', requestScopeString);
		}
		const resource = this._resourceIndicator;
		if (resource) {
			// If a resource is specified, include it in the request
			authorizationUrl.searchParams.append('resource', resource);
		}

		this._bindAuthorizationToDpopKey(authorizationUrl);

		// Use a redirect URI that matches what was registered during dynamic registration
		const redirectUri = 'https://vscode.dev/redirect';
		authorizationUrl.searchParams.append('redirect_uri', redirectUri);

		const promise = this.waitForAuthorizationCode(callbackUri, nonce);

		// Open the browser for user authorization
		this._logger.info(`Opening authorization URL for scopes: ${scopeString}`);
		this._logger.trace(`Authorization URL: ${authorizationUrl.toString()}`);
		const opened = await this._extHostWindow.openUri(authorizationUrl.toString(), {});
		if (!opened) {
			throw new CancellationError();
		}
		progress.report({
			message: nls.localize('completeAuth', "Complete the authentication in the browser window that has opened."),
		});

		// Wait for the authorization code via a redirect
		let code: string | undefined;
		try {
			const response = await raceCancellationError(promise, token);
			code = response.code;
		} catch (err) {
			if (isCancellationError(err)) {
				this._logger.info('Authorization code request was cancelled by the user.');
				throw err;
			}
			if (err instanceof OAuthClientError) {
				// The authorization response failed validation (iss, error): surfaced as is.
				throw err;
			}
			this._logger.error(`Failed to receive authorization code: ${err}`);
			throw new Error(`Failed to receive authorization code: ${err}`);
		}
		this._logger.info(`Authorization code received for scopes: ${scopeString}`);

		// Exchange the authorization code for tokens
		const tokenResponse = await this.exchangeCodeForToken(code, codeVerifier, redirectUri);
		return tokenResponse;
	}

	protected generateRandomString(length: number): string {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return Array.from(array)
			.map(b => b.toString(16).padStart(2, '0'))
			.join('')
			.substring(0, length);
	}

	private async waitForAuthorizationCode(callbackUri: URI, nonce: string): Promise<{ code: string }> {
		// The URI handler matches the callback's scheme, authority, path and nonce.
		const result = await this._proxy.$waitForUriHandler(callbackUri);
		const query = result.query || '';
		// RFC 9207: the issuer first, then the state, then an error; only then is the code used. The state
		// sent is the callback URI, and the redirect page delivers the response to that URI: the response
		// returned the state when it carries the callback's nonce, and any `state` it forwards names a
		// callback URI with the same nonce.
		this._validateAuthorizationResponse(parseAuthorizationRedirect(query), params => nonceOfQuery(query) === nonce && (params.state === undefined || nonceOfCallbackUri(params.state) === nonce));
		// Extract the code parameter directly from the query string. NOTE, URLSearchParams does not work here because
		// it will decode the query string and we need to keep it encoded.
		const codeMatch = /[?&]code=([^&]+)/.exec(query.startsWith('?') || query.startsWith('&') ? query : `?${query}`);
		if (!codeMatch || codeMatch.length < 2) {
			// No code parameter found in the query string
			throw new OAuthClientError('authorization_denied', 'Authentication failed: No authorization code received');
		}
		return { code: codeMatch[1] };
	}

	protected async exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<IAuthorizationTokenResponse> {
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}

		const params: Record<string, string> = {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			code_verifier: codeVerifier,
		};

		// Add resource indicator if available (RFC 8707)
		const resource = this._resourceIndicator;
		if (resource) {
			params.resource = resource;
		}

		this._logger.info(`Exchanging authorization code for token (${this._tokenEndpointAuthMethod} client authentication)...`);
		this._logger.trace(`Url: ${this._serverMetadata.token_endpoint}`);
		const prover = this._signInDpopProver;
		let response: Response;
		let result: unknown;
		try {
			({ response, result } = await this._postTokenRequest(params, prover));
		} catch (err) {
			this._logger.error(`Failed to exchange authorization code for token: ${redact(String(err))}`);
			throw new Error(`Failed to exchange authorization code for token: ${redact(String(err))}`);
		}
		const token = this._acceptTokenResponse(response, result, prover);
		if (token) {
			this._logger.info(`Successfully exchanged authorization code for token (${this._describeTokenResponse(token)}).`);
			return token;
		} else if (isAuthorizationErrorResponse(result) && result.error === AuthorizationErrorType.InvalidClient) {
			this._logger.warn(`Client ID (${this._clientId}) was invalid, generated a new one.`);
			await this._generateNewClientId();
			throw new Error(`Client ID was invalid, generated a new one. Please try again.`);
		}
		const description = isAuthorizationErrorResponse(result) ? `${result.error}${result.error_description ? ` (${result.error_description})` : ''}` : 'no error details';
		throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${redact(description)}`);
	}

	/**
	 * @param dpopKey The DPoP key the token being refreshed is bound to: a public client's refresh
	 * token is bound to it too (RFC 9449 section 5), so the request proves possession of it.
	 */
	protected async exchangeRefreshTokenForToken(refreshToken: string, scopes: readonly string[], allowClientRegistration: boolean, dpopKey?: JsonWebKey): Promise<IAuthorizationToken> {
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}

		const params: Record<string, string> = {
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		};

		if (this._isMicrosoftAuth) {
			const requestScopeString = this._getRequestScopes(scopes).join(' ');
			if (requestScopeString) {
				params.scope = requestScopeString;
			}
		}

		// Add resource indicator if available (RFC 8707)
		const resource = this._resourceIndicator;
		if (resource) {
			params.resource = resource;
		}

		this._logger.info(`Refreshing the ${dpopKey ? 'DPoP-bound ' : ''}token (${this._tokenEndpointAuthMethod} client authentication)...`);
		let prover: OAuthDpopProver | undefined;
		let response: Response;
		let result: unknown;
		try {
			prover = dpopKey ? await OAuthDpopProver.fromPrivateJwk(dpopKey) : undefined;
			({ response, result } = await this._postTokenRequest(params, prover));
		} catch (err) {
			throw new Error(`Failed to refresh the token: ${redact(String(err))}`);
		}

		// The rules of the code grant: an HTTP 200 response with a usable token, whatever else parses.
		const token = this._acceptTokenResponse(response, result, prover);
		if (token) {
			this._logger.info(`Refreshed the token (${this._describeTokenResponse(token)}).`);
			return this._bindToken(token, Date.now());
		} else if (isAuthorizationErrorResponse(result) && result.error === AuthorizationErrorType.InvalidClient) {
			if (!allowClientRegistration) {
				this._logger.warn(`Client ID (${this._clientId}) was invalid while silently refreshing the token.`);
				throw new Error(`Client ID was invalid while silently refreshing the token.`);
			}
			this._logger.warn(`Client ID (${this._clientId}) was invalid, generated a new one.`);
			await this._generateNewClientId();
			throw new Error(`Client ID was invalid, generated a new one. Please try again.`);
		}
		const description = isAuthorizationErrorResponse(result) ? `${result.error}${result.error_description ? ` (${result.error_description})` : ''}` : 'no error details';
		throw new Error(`Invalid authorization token response: ${response.status} - ${redact(description)}`);
	}

	protected async _generateNewClientId(): Promise<void> {
		try {
			const supported = this._serverMetadata.token_endpoint_auth_methods_supported;
			if (this._serverMetadata.registration_endpoint) {
				// Client metadata is posted there and the response carries the client secret.
				assertSecureAuthEndpoint(this._serverMetadata.registration_endpoint, 'registration', this._allowsInsecureHttp);
			}
			const registration = await fetchDynamicRegistration(this._serverMetadata, this._initData.environment.appName, this._resourceMetadata?.scopes_supported, {
				tokenEndpointAuthMethod: selectRegistrationAuthMethod(supported),
				// The provider's own fetch, as for its token requests.
				fetch: this._fetch,
			});
			this._clientId = registration.client_id;
			this._clientSecret = registration.client_secret;
			this._tokenEndpointAuthMethod = selectTokenEndpointAuthMethod(registration.token_endpoint_auth_method, supported, registration.client_secret !== undefined);
			this._onDidChangeClientId.fire();
		} catch (err) {
			// When DCR fails, try to prompt the user for a client ID and client secret
			this._logger.info(`Dynamic registration failed for ${this.authorizationServer.toString()}: ${redact(String(err))}. Prompting user for client ID and client secret.`);

			try {
				const clientDetails = await this._proxy.$promptForClientRegistration(this.authorizationServer.toString());
				if (!clientDetails) {
					throw new Error('User did not provide client details');
				}
				this._clientId = clientDetails.clientId;
				this._clientSecret = clientDetails.clientSecret;
				this._tokenEndpointAuthMethod = selectTokenEndpointAuthMethod(undefined, this._serverMetadata.token_endpoint_auth_methods_supported, clientDetails.clientSecret !== undefined);
				this._logger.info(`User provided client ID for ${this.authorizationServer.toString()}`);
				if (clientDetails.clientSecret) {
					this._logger.info(`User provided client secret for ${this.authorizationServer.toString()}`);
				} else {
					this._logger.info(`User did not provide client secret for ${this.authorizationServer.toString()} (optional)`);
				}

				this._onDidChangeClientId.fire();
			} catch (promptErr) {
				this._logger.error(`Failed to fetch new client ID and user did not provide one: ${redact(String(err))}`);
				throw new Error(`Failed to fetch new client ID and user did not provide one: ${redact(String(err))}`);
			}
		}
	}
}

export type IAuthorizationToken = IAuthorizationTokenResponse & {
	/**
	 * The time when the token was created, in milliseconds since the epoch.
	 */
	created_at: number;
	/**
	 * The RFC 8707 resource the token was issued for, when the provider serves several resources
	 * (it has no protected resource metadata): the token serves only requests for it. Absent for a
	 * token stored before tokens were bound.
	 */
	resource?: string;
	/**
	 * The private JWK of the DPoP key a `DPoP` token is bound to (RFC 9449): only that key can
	 * present the token and refresh it, so it is stored with it (in the secret storage).
	 */
	dpop_jwk?: JsonWebKey;
};

export class TokenStore implements Disposable {
	private readonly _tokensObservable: ISettableObservable<IAuthorizationToken[]>;
	private readonly _sessionsObservable: IObservable<vscode.AuthenticationSession[]>;

	private readonly _onDidChangeSessions = new Emitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _disposable: DisposableStore;

	constructor(
		private readonly _persistence: { onDidChange: Event<IAuthorizationToken[]>; set: (tokens: IAuthorizationToken[]) => void },
		initialTokens: IAuthorizationToken[],
		private readonly _logger: ILogger
	) {
		this._disposable = new DisposableStore();
		this._tokensObservable = observableValue<IAuthorizationToken[]>('tokens', initialTokens);
		this._sessionsObservable = derivedOpts(
			{ equalsFn: (a, b) => arraysEqual(a, b, (a, b) => a.accessToken === b.accessToken) },
			(reader) => this._tokensObservable.read(reader).map(t => this._getSessionFromToken(t))
		);
		this._disposable.add(this._registerChangeEventAutorun());
		this._disposable.add(this._persistence.onDidChange((tokens) => this._tokensObservable.set(tokens, undefined)));
	}

	get tokens(): IAuthorizationToken[] {
		return this._tokensObservable.get();
	}

	get sessions(): vscode.AuthenticationSession[] {
		return this._sessionsObservable.get();
	}

	dispose() {
		this._disposable.dispose();
	}

	update({ added, removed }: { added: IAuthorizationToken[]; removed: IAuthorizationToken[] }): void {
		this._logger.trace(`Updating tokens: added ${added.length}, removed ${removed.length}`);
		const currentTokens = [...this._tokensObservable.get()];
		for (const token of removed) {
			const index = currentTokens.findIndex(t => t.access_token === token.access_token);
			if (index !== -1) {
				currentTokens.splice(index, 1);
			}
		}
		for (const token of added) {
			const index = currentTokens.findIndex(t => t.access_token === token.access_token);
			if (index === -1) {
				currentTokens.push(token);
			} else {
				currentTokens[index] = token;
			}
		}
		if (added.length || removed.length) {
			this._tokensObservable.set(currentTokens, undefined);
			void this._persistence.set(currentTokens);
		}
		this._logger.trace(`Tokens updated: ${currentTokens.length} tokens stored.`);
	}

	private _registerChangeEventAutorun(): IDisposable {
		let previousSessions: vscode.AuthenticationSession[] = [];
		return autorun((reader) => {
			this._logger.trace('Checking for session changes...');
			const currentSessions = this._sessionsObservable.read(reader);
			if (previousSessions === currentSessions) {
				this._logger.trace('No session changes detected.');
				return;
			}

			if (!currentSessions || currentSessions.length === 0) {
				// If currentSessions is undefined, all previous sessions are considered removed
				this._logger.trace('All sessions removed.');
				if (previousSessions.length > 0) {
					this._onDidChangeSessions.fire({
						added: [],
						removed: previousSessions,
						changed: []
					});
					previousSessions = [];
				}
				return;
			}

			const added: vscode.AuthenticationSession[] = [];
			const removed: vscode.AuthenticationSession[] = [];

			// Find added sessions
			for (const current of currentSessions) {
				const exists = previousSessions.some(prev => prev.accessToken === current.accessToken);
				if (!exists) {
					added.push(current);
				}
			}

			// Find removed sessions
			for (const prev of previousSessions) {
				const exists = currentSessions.some(current => current.accessToken === prev.accessToken);
				if (!exists) {
					removed.push(prev);
				}
			}

			// Fire the event if there are any changes
			if (added.length > 0 || removed.length > 0) {
				this._logger.trace(`Sessions changed: added ${added.length}, removed ${removed.length}`);
				this._onDidChangeSessions.fire({ added, removed, changed: [] });
			}

			// Update previous sessions reference
			previousSessions = currentSessions;
		});
	}

	private _getSessionFromToken(token: IAuthorizationTokenResponse): vscode.AuthenticationSession {
		let claims: IAuthorizationJWTClaims | undefined;
		if (token.id_token) {
			try {
				claims = getClaimsFromJWT(token.id_token);
			} catch (e) {
				// log
			}
		}
		if (!claims) {
			try {
				claims = getClaimsFromJWT(token.access_token);
			} catch (e) {
				// log
			}
		}
		// An explicit empty `token.scope` is authoritative (createSession/refresh stamp the requested scopes onto the token); only fall back to the JWT claims when scope is genuinely absent.
		const scopes = token.scope !== undefined
			? (token.scope ? token.scope.split(' ') : [])
			: (claims?.scope ? claims.scope.split(' ') : []);
		return {
			id: stringHash(token.access_token, 0).toString(),
			accessToken: token.access_token,
			account: {
				id: claims?.sub || 'unknown',
				// TODO: Don't say MCP...
				label: claims?.preferred_username || claims?.name || claims?.email || 'MCP',
			},
			scopes: scopes,
			idToken: token.id_token
		};
	}
}
