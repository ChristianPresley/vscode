/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonRpcId, JsonRpcMessage } from '../../../base/common/jsonRpcProtocol.js';
import { mapFindFirst } from '../../../base/common/arraysFind.js';
import { disposableTimeout, RunOnceScheduler } from '../../../base/common/async.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { autorun, ISettableObservable, observableValue } from '../../../base/common/observable.js';
import Severity from '../../../base/common/severity.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import * as nls from '../../../nls.js';
import { ContextKeyExpr, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IDialogService, IPromptButton } from '../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { LogLevel } from '../../../platform/log/common/log.js';
import { getMcpServerMatchers, IMcpServerMatcher } from '../../../platform/mcp/common/allowedMcpServers.js';
import { IAllowedMcpServersService, mcpAllowedServersConfig } from '../../../platform/mcp/common/mcpManagement.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { ISecretStorageService } from '../../../platform/secrets/common/secrets.js';
import { IMcpGatewayResultServer, IWorkbenchMcpGatewayService } from '../../contrib/mcp/common/mcpGatewayService.js';
import { IMcpMessageTransport, IMcpRegistry } from '../../contrib/mcp/common/mcpRegistryTypes.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, extensionPrefixedIdentifier, McpCollectionDefinition, McpCollectionProvenance, McpCollectionSortOrder, McpConnectionState, McpServerDefinition, McpServerLaunch, McpServerTransportType, McpServerTrust, mcpOAuthClientSecretStorageKey, UserInteractionRequiredError } from '../../contrib/mcp/common/mcpTypes.js';
import { IMcpEnterpriseManagedAuthIdpConfig, mcpEnterpriseManagedAuthIdpSection } from '../../contrib/mcp/common/mcpConfiguration.js';
import { IAuthenticationMcpAccessService } from '../../services/authentication/browser/authenticationMcpAccessService.js';
import { IAuthenticationMcpService } from '../../services/authentication/browser/authenticationMcpService.js';
import { IAuthenticationMcpUsageService } from '../../services/authentication/browser/authenticationMcpUsageService.js';
import { AuthenticationSession, AuthenticationSessionAccount, getDynamicAuthenticationProviderId, IAuthenticationProviderSessionOptions, IAuthenticationService } from '../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { canonicalResourceUri, OAuthClientError } from '../../../base/common/oauth.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../platform/mcp/common/mcpPlatformTypes.js';
import { parseStoredClientSecret, serializeStoredClientSecret } from '../../contrib/mcp/common/mcpOAuthClientSecret.js';
import { MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION, MCP_OAUTH_DPOP_SESSION_OPTION, MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION, previousMcpAuthorizationFallbackScopes, resolveMcpOAuthPolicy, selectMcpAuthorizationScopes } from '../common/mcpOAuthClientFactory.js';
import { storedDpopKey } from '../../../base/common/oauthDpop.js';
import { ExtensionHostKind, extensionHostKindToString } from '../../services/extensions/common/extensionHostKind.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { IExtHostContext, extHostNamedCustomer } from '../../services/extensions/common/extHostCustomers.js';
import { Proxied } from '../../services/extensions/common/proxyIdentifier.js';
import { ExtHostContext, ExtHostMcpShape, IMcpAccessTokenBinding, IMcpAuthenticationDetails, IMcpAuthenticationOptions, IAuthMetadataSource, IMcpGatewayServerDto, IMcpGatewayStartOptionsDto, IMcpRegisteredAuthorizationServer, MainContext, MainThreadMcpShape } from '../common/extHost.protocol.js';

/** A gateway server for the extension host; `grpcAddress` only when the gateway serves gRPC. */
function gatewayServerDto(server: IMcpGatewayResultServer): IMcpGatewayServerDto {
	return server.grpcAddress
		? { label: server.label, address: server.address, grpcAddress: server.grpcAddress }
		: { label: server.label, address: server.address };
}

/** Pre-registered credentials met an authorization server other than their own: nothing is sent. */
function issuerMismatchError(clientId: string, serverLabel: string, expectedIssuer: string, discoveredIssuer: string): OAuthClientError {
	return new OAuthClientError('issuer_not_registered', nls.localize('mcp.oauth.issuerMismatch', "The OAuth client '{0}' of the MCP server '{1}' is registered with the authorization server '{2}', but the server now names '{3}'. No credentials were sent. Update `oauth.clientId` (and `oauth.authorizationServer`) in the server's configuration to sign in with the new authorization server.", clientId, serverLabel, expectedIssuer, discoveredIssuer));
}

/** The protected resource of a dynamic provider, whose id is `<authorization server> <resource>`; `undefined` for one without. */
function dynamicProviderResource(provider: { readonly providerId: string; readonly authorizationServer: string }): string | undefined {
	const prefix = `${provider.authorizationServer} `;
	return provider.providerId.startsWith(prefix) ? provider.providerId.slice(prefix.length) : undefined;
}

function canonicalOrSelf(resource: string): string {
	try {
		return canonicalResourceUri(resource);
	} catch {
		return resource;
	}
}

/**
 * The HTTP identity of a resource URL: for a `unix://` or `pipe://` socket URL (the socket path
 * as its path, the HTTP route as its fragment) the `http://localhost/<route>` URL its requests
 * go to, as the extension host's Node transport rewrites them; any other URL itself.
 */
function httpIdentityOf(url: string): string {
	const uri = URI.parse(url);
	if (uri.scheme !== 'unix' && uri.scheme !== 'pipe') {
		return url;
	}
	const route = uri.fragment.startsWith('/') ? uri.fragment : `/${uri.fragment}`;
	return URI.from({ scheme: 'http', authority: 'localhost', path: route, query: uri.query }).toString(true);
}

/**
 * The protected resource (canonical) a launch discovers authorization metadata for: an HTTP
 * server's URL (a socket server's HTTP identity, {@link httpIdentityOf}), or a gRPC server's
 * HTTPS identity (`https://<host>:<port>/`, as the extension host's gRPC transport derives it);
 * `undefined` for stdio.
 */
function launchResource(launch: McpServerLaunch): string | undefined {
	try {
		if (launch.type === McpServerTransportType.HTTP) {
			return canonicalResourceUri(httpIdentityOf(launch.uri.toString(true)));
		}
		if (launch.type === McpServerTransportType.Grpc) {
			const authority = launch.uri.authority;
			return canonicalResourceUri(`https://${authority.slice(authority.lastIndexOf('@') + 1)}/`);
		}
	} catch {
		// Not a URL: the server has no resource of its own.
	}
	return undefined;
}

/**
 * The URL of an HTTP launch whose HTTP identity ({@link httpIdentityOf}) other launches can
 * share: every `unix://` or `pipe://` socket server with the same route maps to
 * `http://localhost/<route>`, and so does an HTTP server at `http://localhost` (port 80). Their
 * registrations, stored by that identity, cannot tell the servers apart. `undefined` for any
 * other launch, whose resource is its own.
 */
function sharedHttpIdentityOwner(launch: McpServerLaunch): string | undefined {
	if (launch.type !== McpServerTransportType.HTTP) {
		return undefined;
	}
	const url = launch.uri.toString(true);
	try {
		const identity = httpIdentityOf(url);
		if (identity !== url || new URL(identity).origin === 'http://localhost') {
			return url;
		}
	} catch {
		// Not a URL: the server has no resource of its own.
	}
	return undefined;
}

@extHostNamedCustomer(MainContext.MainThreadMcp)
export class MainThreadMcp extends Disposable implements MainThreadMcpShape {

	private _serverIdCounter = 0;

	private readonly _servers = new Map<number, ExtHostMcpServerLaunch>();
	private readonly _serverDefinitions = new Map<number, McpServerDefinition>();
	private readonly _serverRequestUrls = new Map<number, Set<string>>();
	/**
	 * The protected resources (canonical) each running server may look up registrations for: its
	 * URL, a gRPC server's HTTPS identity, and those its protected resource metadata named.
	 */
	private readonly _serverResources = new Map<number, Set<string>>();
	/** Running servers whose HTTP identity others can share ({@link sharedHttpIdentityOwner}), with their own URL. */
	private readonly _sharedIdentityServers = new Map<number, string>();
	/** The dynamic provider each server's last token came from: {@link $getAccessTokenBinding} reads the token's binding there. */
	private readonly _serverTokenProviders = new Map<number, string>();
	/**
	 * The dynamic providers each such URL obtained a token through in this window: the only
	 * registrations it learns of, since the stored ones are keyed by the shared identity.
	 */
	private readonly _sharedIdentityRegistrations = new Map<string, Set<string>>();
	/** Running gRPC servers whose launch sets `tls.insecure`. */
	private readonly _insecureGrpcServers = new Set<number>();
	/** Server definitions already warned about `tls.insecure` in this window. */
	private readonly _warnedInsecureGrpcDefinitions = new Set<string>();
	private readonly _serverAuthTracking = new McpServerAuthTracker();
	private readonly _proxy: Proxied<ExtHostMcpShape>;
	private readonly _collectionDefinitions = this._register(new DisposableMap<string, {
		servers: ISettableObservable<readonly McpServerDefinition[]>;
		dispose(): void;
	}>());
	private readonly _gateways = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		private readonly _extHostContext: IExtHostContext,
		@IMcpRegistry private readonly _mcpRegistry: IMcpRegistry,
		@IDialogService private readonly dialogService: IDialogService,
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
		@IAuthenticationMcpService private readonly authenticationMcpServersService: IAuthenticationMcpService,
		@IAuthenticationMcpAccessService private readonly authenticationMCPServerAccessService: IAuthenticationMcpAccessService,
		@IAuthenticationMcpUsageService private readonly authenticationMCPServerUsageService: IAuthenticationMcpUsageService,
		@IDynamicAuthenticationProviderStorageService private readonly _dynamicAuthenticationProviderStorageService: IDynamicAuthenticationProviderStorageService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IWorkbenchMcpGatewayService private readonly _mcpGatewayService: IWorkbenchMcpGatewayService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IAllowedMcpServersService private readonly _allowedMcpServersService: IAllowedMcpServersService,
	) {
		super();
		this._register(_authenticationService.onDidChangeSessions(e => this._onDidChangeAuthSessions(e.providerId, e.label)));
		const proxy = this._proxy = _extHostContext.getProxy(ExtHostContext.ExtHostMcp);
		this._register(this._allowedMcpServersService.onDidChangeAllowedMcpServers(() => {
			for (const [id, urls] of this._serverRequestUrls) {
				const definition = this._serverDefinitions.get(id);
				if (!definition) {
					continue;
				}
				for (const url of urls) {
					const allowed = this._allowedMcpServersService.isServerAllowed({ name: definition.label, url });
					if (allowed !== true) {
						this.$onDidChangeState(id, { state: McpConnectionState.Kind.Error, message: allowed.value });
						proxy.$stopMcp(id);
						break;
					}
				}
			}
		}));
		this._register(this._mcpRegistry.registerDelegate({
			// Prefer Node.js extension hosts when they're available. No CORS issues etc.
			priority: _extHostContext.extensionHostKind === ExtensionHostKind.LocalWebWorker ? 0 : 1,
			waitForInitialProviderPromises() {
				return proxy.$waitForInitialCollectionProviders();
			},
			canStart(collection, serverDefinition) {
				if (collection.remoteAuthority !== _extHostContext.remoteAuthority) {
					return false;
				}
				if (serverDefinition.launch.type === McpServerTransportType.Stdio && _extHostContext.extensionHostKind === ExtensionHostKind.LocalWebWorker) {
					return false;
				}
				// gRPC needs Node.js `http2`, which the web worker extension host does not have.
				if (serverDefinition.launch.type === McpServerTransportType.Grpc && _extHostContext.extensionHostKind === ExtensionHostKind.LocalWebWorker) {
					return false;
				}
				return true;
			},
			async substituteVariables(serverDefinition, launch) {
				const ser = await proxy.$substituteVariables(serverDefinition.variableReplacement?.folder?.uri, McpServerLaunch.toSerialized(launch));
				return McpServerLaunch.fromSerialized(ser);
			},
			async expandEnvironmentVariables(serverDefinition, launch) {
				if (!serverDefinition.environmentVariableExpansion) {
					return launch;
				}
				const ser = await proxy.$expandEnvironmentVariables(McpServerLaunch.toSerialized(launch), serverDefinition.environmentVariableExpansion);
				return McpServerLaunch.fromSerialized(ser);
			},
			start: (_collection, serverDefiniton, resolveLaunch, options) => {
				const id = ++this._serverIdCounter;
				const launch = new ExtHostMcpServerLaunch(
					_extHostContext.extensionHostKind,
					() => proxy.$stopMcp(id),
					(msg, envelope) => proxy.$sendMessage(id, JSON.stringify(msg), envelope),
					requestId => proxy.$cancelRequest(id, requestId),
				);
				this._servers.set(id, launch);
				this._serverDefinitions.set(id, serverDefiniton);
				const ownResource = launchResource(resolveLaunch);
				if (ownResource !== undefined) {
					this._serverResources.set(id, new Set([ownResource]));
				}
				const sharedIdentityOwner = sharedHttpIdentityOwner(resolveLaunch);
				if (sharedIdentityOwner !== undefined) {
					this._sharedIdentityServers.set(id, sharedIdentityOwner);
				}
				if (resolveLaunch.type === McpServerTransportType.HTTP) {
					this._serverRequestUrls.set(id, new Set([resolveLaunch.uri.toString(true)]));
				} else if (resolveLaunch.type === McpServerTransportType.Grpc) {
					// The allow list governs gRPC destinations by their grpc:// or grpcs:// URL, as HTTP ones by theirs.
					this._serverRequestUrls.set(id, new Set([resolveLaunch.uri.toString(true)]));
					if (resolveLaunch.tls?.insecure) {
						this._insecureGrpcServers.add(id);
					}
				}
				proxy.$startMcp(id, {
					launch: resolveLaunch,
					defaultCwd: serverDefiniton.defaultCwd ?? serverDefiniton.variableReplacement?.folder?.uri,
					errorOnUserInteraction: options?.errorOnUserInteraction,
				});

				return launch;
			},
		}));

		// Subscribe to MCP server definition changes and notify ext host
		const onDidChangeMcpServerDefinitionsTrigger = this._register(new RunOnceScheduler(() => this._publishServerDefinitions(), 500));
		this._register(autorun(reader => {
			const collections = this._mcpRegistry.collections.read(reader);
			// Read all server definitions to track changes
			for (const collection of collections) {
				collection.serverDefinitions.read(reader);
			}
			// Notify ext host that definitions changed (it will re-fetch if needed)
			if (!onDidChangeMcpServerDefinitionsTrigger.isScheduled()) {
				onDidChangeMcpServerDefinitionsTrigger.schedule();
			}
		}));

		onDidChangeMcpServerDefinitionsTrigger.schedule();
	}

	private _publishServerDefinitions() {
		const collections = this._mcpRegistry.collections.get();
		const allServers: McpServerDefinition.Serialized[] = [];

		for (const collection of collections) {
			const servers = collection.serverDefinitions.get();
			for (const server of servers) {
				allServers.push(McpServerDefinition.toSerialized(server));
			}
		}

		this._proxy.$onDidChangeMcpServerDefinitions(allServers);
	}

	$upsertMcpCollection(collection: McpCollectionDefinition.FromExtHost, serversDto: McpServerDefinition.Serialized[]): void {
		const servers = serversDto.map(McpServerDefinition.fromSerialized);
		const existing = this._collectionDefinitions.get(collection.id);
		if (existing) {
			existing.servers.set(servers, undefined);
		} else {
			const serverDefinitions = observableValue<readonly McpServerDefinition[]>('mcpServers', servers);
			const extensionId = new ExtensionIdentifier(collection.extensionId);
			const store = new DisposableStore();
			const handle = store.add(new MutableDisposable());
			const register = () => {
				handle.value ??= this._mcpRegistry.registerCollection({
					...collection,
					provenance: McpCollectionProvenance.Extension,
					source: extensionId,
					order: McpCollectionSortOrder.Extension,
					resolveServerLanch: collection.canResolveLaunch ? (async def => {
						const r = await this._proxy.$resolveMcpLaunch(collection.id, def.label);
						return r ? McpServerLaunch.fromSerialized(r) : undefined;
					}) : undefined,
					trustBehavior: collection.isTrustedByDefault ? McpServerTrust.Kind.Trusted : McpServerTrust.Kind.TrustedOnNonce,
					remoteAuthority: this._extHostContext.remoteAuthority,
					serverDefinitions,
				});
			};

			const whenClauseStr = mapFindFirst(this._extensionService.extensions, e =>
				ExtensionIdentifier.equals(extensionId, e.identifier)
					? e.contributes?.mcpServerDefinitionProviders?.find(p => extensionPrefixedIdentifier(extensionId, p.id) === collection.id)?.when
					: undefined);
			const whenClause = whenClauseStr && ContextKeyExpr.deserialize(whenClauseStr);

			if (!whenClause) {
				register();
			} else {
				const evaluate = () => {
					if (this._contextKeyService.contextMatchesRules(whenClause)) {
						register();
					} else {
						handle.clear();
					}
				};

				store.add(this._contextKeyService.onDidChangeContext(evaluate));
				evaluate();
			}

			this._collectionDefinitions.set(collection.id, {
				servers: serverDefinitions,
				dispose: () => store.dispose(),
			});
		}
	}

	$deleteMcpCollection(collectionId: string): void {
		this._collectionDefinitions.deleteAndDispose(collectionId);
	}

	async $checkMcpServerAllowed(id: number, url: string): Promise<string | undefined> {
		const definition = this._serverDefinitions.get(id);
		const urls = this._serverRequestUrls.get(id);
		if (!definition || !urls) {
			throw new CancellationError();
		}

		const allowed = this._allowedMcpServersService.isServerAllowed({ name: definition.label, url });
		if (allowed !== true) {
			return allowed.value;
		}

		if (this._insecureGrpcServers.has(id)) {
			const denied = this._checkInsecureGrpc(id, definition);
			if (denied !== undefined) {
				return denied;
			}
		}

		urls.add(url);
		return undefined;
	}

	/**
	 * `tls.insecure` turns off the verification of the server certificate. Under an allow list
	 * defined by policy it is denied; otherwise the server's log gets a warning once per window.
	 */
	private _checkInsecureGrpc(id: number, definition: McpServerDefinition): string | undefined {
		const policyAllowList = getMcpServerMatchers(this._configurationService.inspect<readonly IMcpServerMatcher[]>(mcpAllowedServersConfig).policyValue);
		if (policyAllowList !== undefined) {
			return nls.localize('mcp.grpc.insecureDenied', "The MCP server '{0}' turns off TLS certificate verification (`tls.insecure`), which is not allowed while your organization manages the allowed MCP servers.", definition.label);
		}
		if (!this._warnedInsecureGrpcDefinitions.has(definition.id)) {
			this._warnedInsecureGrpcDefinitions.add(definition.id);
			this._servers.get(id)?.pushLog(LogLevel.Warning, nls.localize('mcp.grpc.insecureWarning', "TLS certificate verification is turned off for the MCP server '{0}' (`tls.insecure`). Only use this for local development.", definition.label));
		}
		return undefined;
	}

	$onDidChangeState(id: number, update: McpConnectionState): void {
		const server = this._servers.get(id);
		if (!server) {
			return;
		}

		server.state.set(update, undefined);
		if (!McpConnectionState.isRunning(update)) {
			server.dispose();
			this._servers.delete(id);
			this._serverDefinitions.delete(id);
			this._serverRequestUrls.delete(id);
			this._serverResources.delete(id);
			this._sharedIdentityServers.delete(id);
			this._serverTokenProviders.delete(id);
			this._insecureGrpcServers.delete(id);
			this._serverAuthTracking.untrack(id);
		}
	}

	$onDidPublishLog(id: number, level: LogLevel, log: string): void {
		if (typeof level === 'string') {
			level = LogLevel.Info;
			log = level as unknown as string;
		}

		this._servers.get(id)?.pushLog(level, log);
	}

	$onDidReceiveMessage(id: number, message: string): void {
		this._servers.get(id)?.pushMessage(message);
	}

	$onDidAbortRequest(id: number, abort: IMcpRequestAbort): void {
		this._servers.get(id)?.pushAbort(abort);
	}

	async $getTokenForProviderId(id: number, providerId: string, scopes: string[], options: IMcpAuthenticationOptions = {}): Promise<string | undefined> {
		const server = this._serverDefinitions.get(id);
		if (!server) {
			return undefined;
		}
		return this._getSessionForProvider(id, server, providerId, scopes, { clientId: options.clientId }, options.errorOnUserInteraction);
	}

	async $getTokenFromServerMetadata(id: number, authDetails: IMcpAuthenticationDetails, { errorOnUserInteraction, forceNewRegistration, clientId, rejectedToken }: IMcpAuthenticationOptions = {}): Promise<string | undefined> {
		const server = this._serverDefinitions.get(id);
		if (!server) {
			return undefined;
		}
		const authorizationServer = URI.revive(authDetails.authorizationServer);
		const resourceServer = authDetails.resourceMetadata?.resource ? URI.parse(authDetails.resourceMetadata.resource) : undefined;
		if (authDetails.resourceMetadata?.resource) {
			// Its registrations may be looked up from now on ($getRegisteredAuthorizationServers).
			let resources = this._serverResources.get(id);
			if (!resources) {
				resources = new Set();
				this._serverResources.set(id, resources);
			}
			resources.add(canonicalOrSelf(authDetails.resourceMetadata.resource));
		}
		const scopesInput = { challengeScopes: authDetails.scopes, resourceMetadata: authDetails.resourceMetadata, serverMetadata: authDetails.authorizationServerMetadata };
		// The challenge's scopes, else the resource's; only a server without protected resource metadata falls back to the authorization server's.
		const resolvedScopes = selectMcpAuthorizationScopes(scopesInput);
		const launchOAuth = server.launch.type === McpServerTransportType.HTTP || server.launch.type === McpServerTransportType.Grpc ? server.launch.oauth as IMcpRemoteServerOAuthConfiguration | undefined : undefined;
		// The authorization server pre-registered credentials are configured for (`oauth.authorizationServer`).
		const policy = resolveMcpOAuthPolicy(launchOAuth);
		const configuredIssuer = policy.authorizationServer;

		// Enterprise-managed servers route through an XAA / ID-JAG provider keyed by the user-configured
		// SSO issuer instead of doing a per-server DCR against the resource's authorization server.
		if (authDetails.enterpriseManaged) {
			const resource = authDetails.resourceMetadata?.resource;
			if (!resource) {
				throw new Error(nls.localize('mcp.enterpriseManaged.missingResource', "The enterprise-managed MCP server '{0}' did not advertise a protected-resource metadata document with a 'resource' identifier.", server.label));
			}
			const resourceAuthServers = authDetails.resourceMetadata?.authorization_servers ?? [];
			if (resourceAuthServers.length === 0) {
				throw new Error(nls.localize('mcp.enterpriseManaged.missingAS', "The enterprise-managed MCP server '{0}' did not advertise an `authorization_servers` entry in its protected-resource metadata.", server.label));
			}
			// For XAA the scopes sent to the IdP token-exchange step are the *resource* scopes
			// (e.g. "todos.read mcp.access"), NOT the IdP login scopes (openid/offline_access/…).
			// `resolvedScopes` may have fallen through to `authorizationServerMetadata.scopes_supported`
			// which is the IdP's metadata — wrong for this step. Use only the scopes derived from the
			// WWW-Authenticate challenge or the resource's own metadata.
			const xaaScopes = authDetails.scopes ?? authDetails.resourceMetadata?.scopes_supported ?? [];
			const resourceClientId = clientId ?? authDetails.clientId;
			let clientSecretStorageKey: string | undefined;
			let resourceClientSecret: string | undefined;
			let boundIssuer: string | undefined;
			if (resourceClientId) {
				// Match the resource-scoped key used by $promptForResourceClientSecret.
				clientSecretStorageKey = mcpOAuthClientSecretStorageKey(resource, resourceClientId);
				try {
					const stored = parseStoredClientSecret(await this._secretStorageService.get(clientSecretStorageKey));
					resourceClientSecret = stored?.clientSecret;
					boundIssuer = stored?.issuer;
				} catch {
					// Best-effort lookup; fall through.
				}
			}
			// Per ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant), the token exchange
			// `audience` is the *authorization server* of the resource — the issuer that redeems the
			// ID-JAG assertion with the resource client's credentials. Those belong to one authorization
			// server: the configured one (`oauth.authorizationServer`) or the one they were first used
			// with. It is the audience when the resource lists it; otherwise the one discovery selected,
			// else the first listed one. Nothing is sent to another than the credentials' own.
			const expectedIssuer = configuredIssuer ?? boundIssuer;
			const discoveredIssuer = authDetails.authorizationServerMetadata.issuer;
			const audience = expectedIssuer !== undefined && resourceAuthServers.includes(expectedIssuer)
				? expectedIssuer
				: resourceAuthServers.includes(discoveredIssuer) ? discoveredIssuer : resourceAuthServers[0];
			if (resourceClientId && expectedIssuer !== undefined && expectedIssuer !== audience) {
				throw issuerMismatchError(resourceClientId, server.label, expectedIssuer, audience);
			}
			const issuer = this._ensureXaaIssuer();
			const xaaProviderId = await this._authenticationService.createOrGetXaaProvider(issuer);
			if (!xaaProviderId) {
				return undefined;
			}
			if (rejectedToken) {
				await this._removeRejectedSession(xaaProviderId, rejectedToken);
			}
			const xaaToken = await this._getSessionForProvider(id, server, xaaProviderId, xaaScopes, {
				authorizationServer: issuer, clientId: resourceClientId, resource, audience, clientSecretStorageKey,
				// The resource authorization server's endpoints follow the transport's rule, `oauth.allowInsecureHttp` included.
				allowInsecureHttp: policy.allowInsecureHttp || undefined,
			}, errorOnUserInteraction, resourceClientSecret);
			if (xaaToken && clientSecretStorageKey && boundIssuer === undefined) {
				// First successful use: bind the resource client's secret (looked up, or prompted for by the provider) to the audience.
				await this._bindClientSecret(clientSecretStorageKey, audience, resourceClientSecret);
			}
			return xaaToken;
		}

		let providerId = await this._authenticationService.getOrActivateProviderIdForServer(authorizationServer, resourceServer);

		const resolvedClientId = clientId ?? authDetails.clientId;
		const mcpServerUrl = server.launch.type === McpServerTransportType.HTTP || server.launch.type === McpServerTransportType.Grpc ? server.launch.uri.toString(true) : undefined;
		let clientSecretStorageKey: string | undefined;
		let clientSecret: string | undefined;
		let boundIssuer: string | undefined;
		let didLookupClientSecret = false;
		if (resolvedClientId && mcpServerUrl) {
			clientSecretStorageKey = mcpOAuthClientSecretStorageKey(mcpServerUrl, resolvedClientId);
			try {
				const stored = parseStoredClientSecret(await this._secretStorageService.get(clientSecretStorageKey));
				clientSecret = stored?.clientSecret;
				boundIssuer = stored?.issuer;
				didLookupClientSecret = true;
			} catch {
				// Best-effort lookup; proceed without a client secret.
			}
		}

		// Pre-registered credentials belong to one authorization server: the one configured
		// (`oauth.authorizationServer`) or the one they were first used with. Nothing is sent to another.
		if (resolvedClientId) {
			const expectedIssuer = configuredIssuer ?? boundIssuer;
			const discoveredIssuer = authDetails.authorizationServerMetadata.issuer;
			if (expectedIssuer !== undefined && expectedIssuer !== discoveredIssuer) {
				throw issuerMismatchError(resolvedClientId, server.label, expectedIssuer, discoveredIssuer);
			}
		}

		// If the user explicitly configured an OAuth client_id in mcp.json and the stored
		// client secret differs from what the existing provider was registered with, force a
		// re-registration so the new secret takes effect on subsequent token exchanges.
		// Without this, the user can never replace a cached client secret in the extension
		// host's DynamicAuthProvider after the provider has been registered.
		if (didLookupClientSecret && providerId && !forceNewRegistration && this._authenticationService.isDynamicAuthenticationProvider(providerId)) {
			const registered = await this._dynamicAuthenticationProviderStorageService.getClientRegistration(providerId);
			if (registered && registered.clientSecret !== clientSecret) {
				forceNewRegistration = true;
			}
		}

		if (forceNewRegistration && providerId) {
			if (!this._authenticationService.isDynamicAuthenticationProvider(providerId)) {
				throw new Error('Cannot force new registration for a non-dynamic authentication provider.');
			}
			this._authenticationService.unregisterAuthenticationProvider(providerId);
			// TODO: Encapsulate this and the unregister in one call in the auth service
			await this._dynamicAuthenticationProviderStorageService.removeDynamicProvider(providerId);
			providerId = undefined;
		}

		if (!providerId) {
			// The resource may have moved to another authorization server: the providers registered with
			// one it no longer lists must not be used again (SEP-2352).
			await this._removeStaleDynamicProviders(authorizationServer, authDetails.resourceMetadata);
			// The metadata comes from the MCP transport, which applied `oauth.pkce`: PKCE S256 must be advertised.
			// Its dynamic registration follows the transport's endpoint rule, `oauth.allowInsecureHttp` included.
			const provider = await this._authenticationService.createDynamicAuthenticationProvider(authorizationServer, authDetails.authorizationServerMetadata, authDetails.resourceMetadata, resolvedClientId, clientSecret, { requireAdvertisedPkce: true, ...(policy.allowInsecureHttp ? { allowInsecureHttp: true } : {}) });
			if (!provider) {
				return undefined;
			}
			providerId = provider.id;
		} else if (rejectedToken) {
			await this._removeRejectedSession(providerId, rejectedToken);
		}

		const token = await this._getSessionForProvider(id, server, providerId, resolvedScopes, {
			// The RFC 8707 resource: the one the metadata publishes, else the MCP server URL (the transport's canonical URI).
			authorizationServer, clientId: resolvedClientId, resource: authDetails.resourceMetadata?.resource ?? authDetails.resource, clientSecretStorageKey,
			// The provider may be shared with callers whose rules differ (the agent host): this server's rules go with each request.
			allowInsecureHttp: policy.allowInsecureHttp || undefined, requireAdvertisedPkce: true,
			dpop: authDetails.dpop,
		}, errorOnUserInteraction, clientSecret, previousMcpAuthorizationFallbackScopes(scopesInput));
		if (token) {
			this._serverTokenProviders.set(id, providerId);
		}
		if (token && clientSecretStorageKey && clientSecret !== undefined && boundIssuer === undefined) {
			// First successful use: bind the pre-registered credentials to this issuer.
			await this._bindClientSecret(clientSecretStorageKey, authDetails.authorizationServerMetadata.issuer, clientSecret);
		}
		const sharedIdentityOwner = this._sharedIdentityServers.get(id);
		if (token && sharedIdentityOwner !== undefined) {
			let own = this._sharedIdentityRegistrations.get(sharedIdentityOwner);
			if (!own) {
				own = new Set();
				this._sharedIdentityRegistrations.set(sharedIdentityOwner, own);
			}
			own.add(providerId);
		}
		return token;
	}

	/**
	 * Records the issuer pre-registered credentials were first used with (best
	 * effort). Without `clientSecret` the stored secret is bound, if it is still
	 * unbound: an enterprise-managed sign-in may just have prompted for it.
	 */
	private async _bindClientSecret(key: string, issuer: string, clientSecret?: string): Promise<void> {
		try {
			if (clientSecret === undefined) {
				const stored = parseStoredClientSecret(await this._secretStorageService.get(key));
				if (stored?.clientSecret === undefined || stored.issuer !== undefined) {
					return;
				}
				clientSecret = stored.clientSecret;
			}
			await this._secretStorageService.set(key, serializeStoredClientSecret({ clientSecret, issuer }));
		} catch {
			// Best effort: the credentials stay unbound and are bound on their next use.
		}
	}

	/**
	 * The authorization servers with a client registration (a dynamic
	 * authentication provider) for the protected resource at `resource`, the
	 * MCP server URL, or for its origin (a root protected resource metadata
	 * document may name the origin). The extension host's discovery prefers the
	 * first `authorization_servers` entry among them, so the choice of
	 * authorization server survives restarts.
	 *
	 * Only the server's own resource is answered: its URL, a gRPC server's
	 * HTTPS identity, or a resource its protected resource metadata named
	 * (seen in {@link $getTokenFromServerMetadata}); any other is `[]`, so a
	 * server learns nothing about the registrations of others. A server whose
	 * HTTP identity others can share (socket servers with the same route, an
	 * HTTP server at `http://localhost`) only learns of the registrations it
	 * obtained a token through itself in this window.
	 */
	async $getRegisteredAuthorizationServers(id: number, resource: string): Promise<IMcpRegisteredAuthorizationServer[]> {
		if (!this._serverDefinitions.has(id)) {
			return [];
		}
		const sharedIdentityOwner = this._sharedIdentityServers.get(id);
		const own = sharedIdentityOwner === undefined ? undefined : this._sharedIdentityRegistrations.get(sharedIdentityOwner) ?? new Set<string>();
		let candidates: string[];
		try {
			// A socket server's resource is its HTTP identity: its socket URL has no origin.
			const canonical = canonicalResourceUri(httpIdentityOf(resource));
			if (!this._serverResources.get(id)?.has(canonical)) {
				return [];
			}
			const origin = new URL(canonical).origin;
			candidates = origin === 'null' ? [canonical] : [canonical, canonicalResourceUri(origin)];
		} catch {
			return [];
		}
		const registered: IMcpRegisteredAuthorizationServer[] = [];
		for (const provider of this._dynamicAuthenticationProviderStorageService.getInteractedProviders()) {
			const providerResource = dynamicProviderResource(provider);
			if (providerResource !== undefined && candidates.includes(canonicalOrSelf(providerResource)) && (own === undefined || own.has(provider.providerId))) {
				registered.push({ authorizationServer: provider.authorizationServer, resource: providerResource });
			}
		}
		return registered;
	}

	/**
	 * The DPoP key a token of {@link $getTokenFromServerMetadata} is bound to: the dynamic provider
	 * the server's last token came from stores a DPoP-bound token with its key (in the secret
	 * storage). Only that provider's tokens are answered, so a server learns no other server's key;
	 * `undefined` for a bearer token.
	 */
	async $getAccessTokenBinding(id: number, accessToken: string): Promise<IMcpAccessTokenBinding | undefined> {
		const providerId = this._serverTokenProviders.get(id);
		if (providerId === undefined || !this._serverDefinitions.has(id)) {
			return undefined;
		}
		try {
			const registration = await this._dynamicAuthenticationProviderStorageService.getClientRegistration(providerId);
			if (registration?.clientId === undefined) {
				return undefined;
			}
			const tokens = await this._dynamicAuthenticationProviderStorageService.getSessionsForDynamicAuthProvider(providerId, registration.clientId);
			const stored = tokens?.find(token => token.access_token === accessToken);
			const dpopKey = stored ? storedDpopKey(stored) : undefined;
			return dpopKey ? { dpopKey } : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The client secret of a machine client (`oauth.grant` other than `authorization_code`), which
	 * the transport's grant authenticates with at the authorization server `issuer`: only for the
	 * server's own `oauth.clientId`, from the secret storage of the *Set Client Secret* code lens.
	 * As for a user's sign-in, the secret belongs to one authorization server: the configured one
	 * (`oauth.authorizationServer`) or the one it was first used with, to which an unbound secret is
	 * bound now; another gets an `issuer_not_registered` error and no secret.
	 */
	async $getMcpOAuthClientSecret(id: number, clientId: string, issuer: string): Promise<string | undefined> {
		const server = this._serverDefinitions.get(id);
		if (!server || (server.launch.type !== McpServerTransportType.HTTP && server.launch.type !== McpServerTransportType.Grpc)) {
			return undefined;
		}
		const oauth = server.launch.oauth as IMcpRemoteServerOAuthConfiguration | undefined;
		const policy = resolveMcpOAuthPolicy(oauth);
		if (policy.grant === 'authorization_code' || oauth?.clientId !== clientId) {
			return undefined;
		}
		const key = mcpOAuthClientSecretStorageKey(server.launch.uri.toString(true), clientId);
		let stored;
		try {
			stored = parseStoredClientSecret(await this._secretStorageService.get(key));
		} catch {
			return undefined;
		}
		if (stored?.clientSecret === undefined) {
			return undefined;
		}
		const expectedIssuer = policy.authorizationServer ?? stored.issuer;
		if (expectedIssuer !== undefined && expectedIssuer !== issuer) {
			throw issuerMismatchError(clientId, server.label, expectedIssuer, issuer);
		}
		if (stored.issuer === undefined) {
			await this._bindClientSecret(key, issuer, stored.clientSecret);
		}
		return stored.clientSecret;
	}

	/**
	 * Removes the session whose access token the MCP server rejected, so the
	 * provider cannot hand it out again. Sessions are looked up without a scope
	 * filter because the rejected token may have been issued for other scopes.
	 * Only per-resource (dynamic) providers are touched: a rejection by one MCP
	 * server must not sign the user out of a shared provider.
	 */
	private async _removeRejectedSession(providerId: string, rejectedToken: string): Promise<void> {
		if (!this._authenticationService.isDynamicAuthenticationProvider(providerId)) {
			return;
		}
		try {
			const sessions = await this._authenticationService.getSessions(providerId);
			const rejected = sessions.find(session => session.accessToken === rejectedToken);
			if (rejected) {
				await this._authenticationService.removeSession(providerId, rejected.id);
			}
		} catch {
			// The provider may be gone already; the new token request proceeds regardless.
		}
	}

	/**
	 * Unregisters the dynamic providers of this resource whose authorization
	 * server the resource no longer lists: their registration and tokens must
	 * not be reused once the resource names another one. The providers of an
	 * authorization server it still lists stay, so a restart (or switching back
	 * to it) reuses their registration.
	 */
	private async _removeStaleDynamicProviders(authorizationServer: URI, resourceMetadata: IMcpAuthenticationDetails['resourceMetadata']): Promise<void> {
		if (!resourceMetadata?.resource) {
			return;
		}
		try {
			const currentId = getDynamicAuthenticationProviderId(authorizationServer, resourceMetadata);
			const listed = new Set((resourceMetadata.authorization_servers ?? []).map(server => URI.parse(server).toString(true)));
			for (const stale of this._dynamicAuthenticationProviderStorageService.getInteractedProviders()) {
				if (stale.providerId === currentId || dynamicProviderResource(stale) !== resourceMetadata.resource || listed.has(stale.authorizationServer)) {
					continue;
				}
				if (this._authenticationService.isDynamicAuthenticationProvider(stale.providerId)) {
					this._authenticationService.unregisterAuthenticationProvider(stale.providerId);
				}
				await this._dynamicAuthenticationProviderStorageService.removeDynamicProvider(stale.providerId);
			}
		} catch {
			// Best effort: a stale provider only lingers in the accounts list.
		}
	}

	private _ensureXaaIssuer(): URI {
		const config = this._configurationService.getValue<IMcpEnterpriseManagedAuthIdpConfig | undefined>(mcpEnterpriseManagedAuthIdpSection) ?? {};
		const configuredIssuer = config.issuer?.trim();
		if (!configuredIssuer) {
			throw new Error(nls.localize('mcp.enterpriseManaged.issuerMissing', "Enterprise-managed MCP authentication requires `mcp.enterpriseManagedAuth.idp.issuer` to be configured. Set it via enterprise policy (Windows Group Policy / macOS managed preferences / Linux `/etc/vscode/policy.json`) or, for local testing, by hand-editing `settings.json`."));
		}
		let parsed: URI;
		try {
			parsed = URI.parse(configuredIssuer);
		} catch {
			throw new Error(nls.localize('mcp.enterpriseManaged.issuerInvalid', "Enterprise-managed MCP authentication requires `mcp.enterpriseManagedAuth.idp.issuer` to be a valid URL; got '{0}'.", configuredIssuer));
		}
		if (parsed.scheme !== 'https' && parsed.scheme !== 'http') {
			throw new Error(nls.localize('mcp.enterpriseManaged.issuerNotHttp', "Enterprise-managed MCP authentication requires `mcp.enterpriseManagedAuth.idp.issuer` to use the `https` or `http` scheme; got '{0}'.", configuredIssuer));
		}
		return parsed;
	}

	/**
	 * @param previousScopes The scopes earlier versions requested for this server
	 * (see {@link previousMcpAuthorizationFallbackScopes}): when no session has
	 * exactly `requestedScopes`, a session of the same provider with these is
	 * used instead of signing in again.
	 */
	private async _getSessionForProvider(
		serverId: number,
		server: McpServerDefinition,
		providerId: string,
		requestedScopes: string[],
		authContext: IMcpServerAuthContext,
		errorOnUserInteraction: boolean = false,
		clientSecret?: string,
		previousScopes?: string[],
	): Promise<string | undefined> {
		const { authorizationServer, clientId, resource, audience, allowInsecureHttp, requireAdvertisedPkce, dpop } = authContext;
		const providerOptions: IAuthenticationProviderSessionOptions = { authorizationServer, clientId, clientSecret, resource, audience };
		if (allowInsecureHttp) {
			providerOptions[MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION] = true;
		}
		if (dpop) {
			providerOptions[MCP_OAUTH_DPOP_SESSION_OPTION] = true;
		}
		if (requireAdvertisedPkce) {
			providerOptions[MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION] = true;
		}
		let scopes = requestedScopes;
		let sessions = await this._authenticationService.getSessions(providerId, scopes, { ...providerOptions, silent: errorOnUserInteraction }, true);
		if (!sessions.length && previousScopes?.length) {
			const previous = await this._authenticationService.getSessions(providerId, previousScopes, { ...providerOptions, silent: errorOnUserInteraction }, true);
			if (previous.length) {
				scopes = previousScopes;
				sessions = previous;
			}
		}
		// Only HTTP and gRPC servers authenticate, so the server URL is always known here. A token is only
		// released to a server whose current URL matches the one the user consented to, so changing the URL
		// while keeping the same id requires re-consent.
		if (server.launch.type !== McpServerTransportType.HTTP && server.launch.type !== McpServerTransportType.Grpc) {
			return undefined;
		}
		const mcpServerUrl = server.launch.uri.toString(true);
		const accountNamePreference = this.authenticationMcpServersService.getAccountPreference(server.id, providerId);
		let matchingAccountPreferenceSession: AuthenticationSession | undefined;
		if (accountNamePreference) {
			matchingAccountPreferenceSession = sessions.find(session => session.account.label === accountNamePreference);
		}
		const provider = this._authenticationService.getProvider(providerId);
		let session: AuthenticationSession;
		if (sessions.length) {
			// If we have an existing session preference, use that. If not, we'll return any valid session at the end of this function.
			if (matchingAccountPreferenceSession && this.authenticationMCPServerAccessService.isAccessAllowedForUrl(providerId, matchingAccountPreferenceSession.account.label, server.id, mcpServerUrl)) {
				this.authenticationMCPServerUsageService.addAccountUsage(providerId, matchingAccountPreferenceSession.account.label, scopes, server.id, server.label);
				this._serverAuthTracking.track(providerId, serverId, scopes, authContext);
				return matchingAccountPreferenceSession.accessToken;
			}
			// If we only have one account for a single auth provider, lets just check if it's allowed and return it if it is.
			if (!provider.supportsMultipleAccounts && this.authenticationMCPServerAccessService.isAccessAllowedForUrl(providerId, sessions[0].account.label, server.id, mcpServerUrl)) {
				this.authenticationMCPServerUsageService.addAccountUsage(providerId, sessions[0].account.label, scopes, server.id, server.label);
				this._serverAuthTracking.track(providerId, serverId, scopes, authContext);
				return sessions[0].accessToken;
			}
		}

		if (errorOnUserInteraction) {
			throw new UserInteractionRequiredError('authentication');
		}

		const isAllowed = await this.loginPrompt(server.label, provider.label, false);
		if (!isAllowed) {
			throw new Error('User did not consent to login.');
		}

		if (sessions.length) {
			if (provider.supportsMultipleAccounts && errorOnUserInteraction) {
				throw new UserInteractionRequiredError('authentication');
			}
			session = provider.supportsMultipleAccounts
				? await this.authenticationMcpServersService.selectSession(providerId, server.id, server.label, scopes, sessions, providerOptions)
				: sessions[0];
		}
		else {
			if (errorOnUserInteraction) {
				throw new UserInteractionRequiredError('authentication');
			}
			const accountToCreate: AuthenticationSessionAccount | undefined = matchingAccountPreferenceSession?.account;
			do {
				session = await this._authenticationService.createSession(
					providerId,
					scopes,
					{
						...providerOptions,
						activateImmediate: true,
						account: accountToCreate
					});
			} while (
				accountToCreate
				&& accountToCreate.label !== session.account.label
				&& !await this.continueWithIncorrectAccountPrompt(session.account.label, accountToCreate.label)
			);
		}

		this.authenticationMCPServerAccessService.updateAllowedMcpServers(providerId, session.account.label, [{ id: server.id, name: server.label, allowed: true, url: mcpServerUrl }]);
		this.authenticationMcpServersService.updateAccountPreference(server.id, providerId, session.account);
		this.authenticationMCPServerUsageService.addAccountUsage(providerId, session.account.label, scopes, server.id, server.label);
		this._serverAuthTracking.track(providerId, serverId, scopes, authContext);
		return session.accessToken;
	}

	private async continueWithIncorrectAccountPrompt(chosenAccountLabel: string, requestedAccountLabel: string): Promise<boolean> {
		const result = await this.dialogService.prompt({
			message: nls.localize('incorrectAccount', "Incorrect account detected"),
			detail: nls.localize('incorrectAccountDetail', "The chosen account, {0}, does not match the requested account, {1}.", chosenAccountLabel, requestedAccountLabel),
			type: Severity.Warning,
			cancelButton: true,
			buttons: [
				{
					label: nls.localize('keep', 'Keep {0}', chosenAccountLabel),
					run: () => chosenAccountLabel
				},
				{
					label: nls.localize('loginWith', 'Login with {0}', requestedAccountLabel),
					run: () => requestedAccountLabel
				}
			],
		});

		if (!result.result) {
			throw new CancellationError();
		}

		return result.result === chosenAccountLabel;
	}

	private async _onDidChangeAuthSessions(providerId: string, providerLabel: string): Promise<void> {
		const serversUsingProvider = this._serverAuthTracking.get(providerId);
		if (!serversUsingProvider) {
			return;
		}

		for (const { serverId, scopes, context } of serversUsingProvider) {
			const server = this._servers.get(serverId);
			const serverDefinition = this._serverDefinitions.get(serverId);

			if (!server || !serverDefinition) {
				continue;
			}

			// Only validate servers that are running
			const state = server.state.get();
			if (state.state !== McpConnectionState.Kind.Running) {
				continue;
			}

			try {
				// Replay the original context, but resolve the current secret so rotation takes effect.
				const clientSecret = context.clientSecretStorageKey
					? parseStoredClientSecret(await this._secretStorageService.get(context.clientSecretStorageKey))?.clientSecret
					: undefined;
				await this._getSessionForProvider(serverId, serverDefinition, providerId, scopes, context, true, clientSecret);
			} catch (e) {
				if (UserInteractionRequiredError.is(e)) {
					// Session is no longer valid, stop the server
					server.pushLog(LogLevel.Warning, nls.localize('mcpAuthSessionRemoved', "Authentication session for {0} removed, stopping server", providerLabel));
					server.stop();
				} else {
					server.pushLog(LogLevel.Warning, nls.localize('mcpAuthRevalidationFailed', "Unable to revalidate authentication for {0}.", providerLabel));
				}
			}
		}
	}

	$logMcpAuthSetup(data: IAuthMetadataSource): void {
		type McpAuthSetupClassification = {
			owner: 'TylerLeonhardt';
			comment: 'Tracks how MCP OAuth authentication setup was discovered and configured';
			resourceMetadataSource: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'How resource metadata was discovered (header, wellKnown, or none)' };
			serverMetadataSource: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'How authorization server metadata was discovered (resourceMetadata, wellKnown, or default)' };
		};
		this._telemetryService.publicLog2<IAuthMetadataSource, McpAuthSetupClassification>('mcp/authSetup', data);
	}

	async $startMcpGateway(chatSessionResource?: UriComponents, options?: IMcpGatewayStartOptionsDto): Promise<{ servers: IMcpGatewayServerDto[]; gatewayId: string } | undefined> {
		const result = await this._mcpGatewayService.createGateway(
			this._extHostContext.extensionHostKind === ExtensionHostKind.Remote,
			chatSessionResource ? URI.revive(chatSessionResource) : undefined,
			// Only an explicit opt-in opens the gateway's gRPC listener.
			options?.grpc === true ? { grpc: true } : undefined,
		);
		if (!result) {
			return undefined;
		}

		if (this._store.isDisposed) {
			result.dispose();
			return undefined;
		}

		const gatewayId = generateUuid();
		const store = new DisposableStore();
		store.add(result);
		store.add(result.onDidChangeServers(servers => {
			this._proxy.$onDidChangeGatewayServers(gatewayId, servers.map(gatewayServerDto));
		}));
		this._gateways.set(gatewayId, store);

		return {
			servers: result.servers.map(gatewayServerDto),
			gatewayId,
		};
	}

	$disposeMcpGateway(gatewayId: string): void {
		this._gateways.deleteAndDispose(gatewayId);
	}

	private async loginPrompt(mcpLabel: string, providerLabel: string, recreatingSession: boolean): Promise<boolean> {
		const message = recreatingSession
			? nls.localize('confirmRelogin', "The MCP Server Definition '{0}' wants you to authenticate to {1}.", mcpLabel, providerLabel)
			: nls.localize('confirmLogin', "The MCP Server Definition '{0}' wants to authenticate to {1}.", mcpLabel, providerLabel);

		const buttons: IPromptButton<boolean | undefined>[] = [
			{
				label: nls.localize({ key: 'allow', comment: ['&& denotes a mnemonic'] }, "&&Allow"),
				run() {
					return true;
				},
			}
		];
		const { result } = await this.dialogService.prompt({
			type: Severity.Info,
			message,
			buttons,
			cancelButton: true,
		});

		return result ?? false;
	}

	override dispose(): void {
		for (const server of this._servers.values()) {
			server.extHostDispose();
		}
		this._servers.clear();
		this._serverDefinitions.clear();
		this._serverRequestUrls.clear();
		this._serverResources.clear();
		this._sharedIdentityServers.clear();
		this._sharedIdentityRegistrations.clear();
		this._insecureGrpcServers.clear();
		this._serverAuthTracking.clear();
		super.dispose();
	}
}


class ExtHostMcpServerLaunch extends Disposable implements IMcpMessageTransport {
	public readonly state = observableValue<McpConnectionState>('mcpServerState', { state: McpConnectionState.Kind.Starting });

	private readonly _onDidLog = this._register(new Emitter<{ level: LogLevel; message: string }>());
	public readonly onDidLog = this._onDidLog.event;

	private readonly _onDidReceiveMessage = this._register(new Emitter<JsonRpcMessage>());
	public readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

	private readonly _onDidAbortRequest = this._register(new Emitter<IMcpRequestAbort>());
	public readonly onDidAbortRequest = this._onDidAbortRequest.event;

	pushLog(level: LogLevel, message: string): void {
		this._onDidLog.fire({ message, level });
	}

	pushAbort(abort: IMcpRequestAbort): void {
		this._onDidAbortRequest.fire(abort);
	}

	pushMessage(message: string): void {
		let parsed: JsonRpcMessage | JsonRpcMessage[] | undefined;
		try {
			parsed = JSON.parse(message);
		} catch (e) {
			this.pushLog(LogLevel.Warning, `Failed to parse message: ${JSON.stringify(message)}`);
		}

		if (parsed) {
			if (Array.isArray(parsed)) { // streamable HTTP supports batching
				parsed.forEach(p => this._onDidReceiveMessage.fire(p));
			} else {
				this._onDidReceiveMessage.fire(parsed);
			}
		}
	}

	constructor(
		extHostKind: ExtensionHostKind,
		public readonly stop: () => void,
		public readonly send: (message: JsonRpcMessage, envelope?: IMcpMessageEnvelope) => void,
		public readonly cancelRequest: (requestId: JsonRpcId) => void,
	) {
		super();

		this._register(disposableTimeout(() => {
			this.pushLog(LogLevel.Info, `Starting server from ${extensionHostKindToString(extHostKind)} extension host`);
		}));
	}

	public extHostDispose() {
		if (McpConnectionState.isRunning(this.state.get())) {
			this.pushLog(LogLevel.Warning, 'Extension host shut down, server will stop.');
			this.state.set({ state: McpConnectionState.Kind.Stopped }, undefined);
		}
		this.dispose();
	}

	public override dispose(): void {
		if (McpConnectionState.isRunning(this.state.get())) {
			this.stop();
		}

		super.dispose();
	}
}

/**
 * The context needed to re-acquire a token for a tracked MCP server, captured when the
 * session was first established. The tracker holds this opaquely and replays it verbatim on
 * re-validation so the silent token request targets the same authority / resource / audience
 * that the original sign-in used. Dropping the authorization server here would let the provider
 * fall back to a default authority (e.g. the Microsoft provider's `organizations` tenant) and
 * request a token against the wrong tenant.
 */
export interface IMcpServerAuthContext {
	readonly authorizationServer?: URI;
	readonly clientId?: string;
	readonly resource?: string;
	readonly audience?: string;
	/** The server's `oauth.allowInsecureHttp`, handed to the enterprise-managed or dynamic provider with each request. */
	readonly allowInsecureHttp?: boolean;
	/** Whether the dynamic provider refuses, for this server's requests, an authorization server that does not advertise PKCE `S256`. */
	readonly requireAdvertisedPkce?: boolean;
	/** Secret-storage reference; the secret itself is never retained here. */
	readonly clientSecretStorageKey?: string;
	/** Whether the dynamic provider requests a DPoP-bound token for this request (RFC 9449). */
	readonly dpop?: boolean;
}

/**
 * Tracks which MCP servers are using which authentication providers.
 * Organized by provider ID for efficient lookup when auth sessions change.
 */
export class McpServerAuthTracker {
	// Provider ID -> Array of tracked servers (serverId, scopes, and the auth context to replay)
	private readonly _tracking = new Map<string, Array<{ serverId: number; scopes: string[]; context: IMcpServerAuthContext }>>();

	/**
	 * Track authentication for a server with a specific provider.
	 * Replaces any existing tracking for this server/provider combination.
	 */
	track(providerId: string, serverId: number, scopes: string[], context: IMcpServerAuthContext): void {
		const servers = this._tracking.get(providerId) || [];
		const filtered = servers.filter(s => s.serverId !== serverId);
		filtered.push({ serverId, scopes, context });
		this._tracking.set(providerId, filtered);
	}

	/**
	 * Remove all authentication tracking for a server across all providers.
	 */
	untrack(serverId: number): void {
		for (const [providerId, servers] of this._tracking.entries()) {
			const filtered = servers.filter(s => s.serverId !== serverId);
			if (filtered.length === 0) {
				this._tracking.delete(providerId);
			} else {
				this._tracking.set(providerId, filtered);
			}
		}
	}

	/**
	 * Get all servers using a specific authentication provider.
	 */
	get(providerId: string): ReadonlyArray<{ serverId: number; scopes: string[]; context: IMcpServerAuthContext }> | undefined {
		return this._tracking.get(providerId);
	}

	/**
	 * Clear all tracking data.
	 */
	clear(): void {
		this._tracking.clear();
	}
}
