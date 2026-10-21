/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthorizationProtectedResourceMetadata, IAuthorizationServerMetadata } from '../../../base/common/oauth.js';
import { IOAuthClientOptions, IOAuthClientStorage, IOAuthFetch, IOAuthRegistrationOptions, OAuthAuthorizeStrategy, OAuthClient, OAuthLogLevel, selectScopes } from '../../../base/common/oauthClient.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../platform/mcp/common/mcpPlatformTypes.js';
import { WORKBENCH_ONLY_SESSION_OPTION_PREFIX } from '../../services/authentication/common/authentication.js';

/**
 * The one rule set of VS Code's MCP authorization clients. The extension-host
 * Streamable HTTP transport (discovery), the main thread's token acquisition
 * and the conformance client all take their limits and policies from here, so
 * what the official conformance suite measures is what the product does.
 */

/** Authorization requests per resource for the lifetime of the process: the initial one and two step-ups. */
export const MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS = 3;

/** Challenges (401 / 403 `insufficient_scope`) one request handles before its response is returned as is. */
export const MCP_OAUTH_MAX_CHALLENGE_CYCLES = 3;

/** Consecutive rejections (401) of freshly issued tokens after which the client registers anew. */
export const MCP_OAUTH_REJECTIONS_BEFORE_REREGISTRATION = 2;

/** The per-server authorization policy, from the `oauth` object of a server in `mcp.json`. */
export interface IMcpOAuthServerPolicy {
	/** Whether `S256` must be advertised in `code_challenge_methods_supported`. */
	readonly pkce: 'require-advertised' | 'assume-supported';
	/** Allow `http://` endpoints on non-loopback hosts. */
	readonly allowInsecureHttp: boolean;
	/** The issuer pre-registered credentials are bound to, when configured. */
	readonly authorizationServer?: string;
}

/**
 * The session option with which the workbench hands a server's `oauth.allowInsecureHttp` to the
 * enterprise-managed (XAA) provider, whose resource authorization server endpoints then follow the
 * same rule as the transport's discovery, and to a dynamic provider, which may then register anew
 * or use a device authorization endpoint over plain HTTP for that request. Extensions cannot set
 * it: workbench-only options are removed from their requests.
 */
export const MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION = `${WORKBENCH_ONLY_SESSION_OPTION_PREFIX}McpOAuthAllowInsecureHttp`;

/**
 * The session option with which the workbench asks a dynamic provider to refuse, for that request,
 * an authorization server that does not advertise PKCE `S256` (the rule for mcp.json servers): a
 * provider is shared with callers whose rule may differ. Workbench-only, like
 * {@link MCP_OAUTH_ALLOW_INSECURE_HTTP_SESSION_OPTION}.
 */
export const MCP_OAUTH_REQUIRE_ADVERTISED_PKCE_SESSION_OPTION = `${WORKBENCH_ONLY_SESSION_OPTION_PREFIX}McpOAuthRequireAdvertisedPkce`;

/** Resolves the policy of a server: its `oauth` escape hatches over the defaults (PKCE required, HTTPS or loopback only). */
export function resolveMcpOAuthPolicy(config: IMcpRemoteServerOAuthConfiguration | undefined, defaults: Partial<IMcpOAuthServerPolicy> = {}): IMcpOAuthServerPolicy {
	return {
		pkce: config?.pkce === 'assume-supported' || config?.pkce === 'require-advertised' ? config.pkce : (defaults.pkce ?? 'require-advertised'),
		allowInsecureHttp: typeof config?.allowInsecureHttp === 'boolean' ? config.allowInsecureHttp : (defaults.allowInsecureHttp ?? false),
		authorizationServer: typeof config?.authorizationServer === 'string' && config.authorizationServer.length > 0 ? config.authorizationServer : defaults.authorizationServer,
	};
}

export interface IMcpOAuthClientFactoryOptions {
	readonly clientName: string;
	readonly clientUri?: string;
	readonly redirectUris: readonly string[];
	readonly registration: IOAuthRegistrationOptions;
	readonly authorize: OAuthAuthorizeStrategy;
	readonly policy: IMcpOAuthServerPolicy;
	readonly storage?: IOAuthClientStorage;
	readonly fetch?: IOAuthFetch;
	/** Headers sent with protected resource metadata requests to the resource's own origin. */
	readonly sameOriginHeaders?: Record<string, string>;
	/** Synthesize the 2025-03-26 default endpoints for servers that serve no protected resource metadata. */
	readonly legacyDefaultEndpoints?: boolean;
	readonly log?: (level: OAuthLogLevel, message: string) => void;
}

/**
 * The {@link IOAuthClientOptions} of every MCP OAuth client: the specification's
 * limits (three challenges per request, three authorization requests per
 * resource), `offline_access` only when the authorization server lists it, and
 * the server's PKCE and transport policy.
 */
export function mcpOAuthClientOptions(options: IMcpOAuthClientFactoryOptions): IOAuthClientOptions {
	return {
		clientName: options.clientName,
		clientUri: options.clientUri,
		redirectUris: options.redirectUris,
		registration: options.registration,
		authorize: options.authorize,
		storage: options.storage,
		fetch: options.fetch,
		sameOriginHeaders: options.sameOriginHeaders,
		log: options.log,
		pkce: options.policy.pkce,
		allowInsecureHttp: options.policy.allowInsecureHttp,
		maxChallengesPerRequest: MCP_OAUTH_MAX_CHALLENGE_CYCLES,
		maxAuthorizationRequests: MCP_OAUTH_MAX_AUTHORIZATION_REQUESTS,
		requestOfflineAccess: true,
		legacyDefaultEndpoints: options.legacyDefaultEndpoints ?? false,
	};
}

/** Creates an {@link OAuthClient} with the MCP rule set. */
export function createMcpOAuthClient(options: IMcpOAuthClientFactoryOptions): OAuthClient {
	return new OAuthClient(mcpOAuthClientOptions(options));
}

export interface IMcpAuthorizationScopesInput {
	/** The scopes of the `WWW-Authenticate` challenge, or the scopes a step-up computed. */
	readonly challengeScopes?: readonly string[];
	readonly resourceMetadata?: IAuthorizationProtectedResourceMetadata;
	readonly serverMetadata: IAuthorizationServerMetadata;
}

/**
 * The scopes VS Code requests for an MCP server: the challenge's, otherwise the
 * protected resource's `scopes_supported`; only a server without protected
 * resource metadata (2025-03-26) falls back to the authorization server's
 * `scopes_supported`. Otherwise no scope is requested.
 */
export function selectMcpAuthorizationScopes(input: IMcpAuthorizationScopesInput): string[] {
	const selected = selectScopes({ challengeScope: input.challengeScopes?.join(' '), prmScopes: input.resourceMetadata?.scopes_supported });
	if (selected) {
		return selected;
	}
	if (!input.resourceMetadata && input.serverMetadata.scopes_supported) {
		return [...input.serverMetadata.scopes_supported];
	}
	return [];
}

/**
 * The scopes earlier versions requested where {@link selectMcpAuthorizationScopes}
 * now requests none: a server with protected resource metadata that declares
 * no `scopes_supported` and did not challenge for scopes used to get the
 * authorization server's `scopes_supported`, and its sessions were stored
 * with them. `undefined` for every other server.
 */
export function previousMcpAuthorizationFallbackScopes(input: IMcpAuthorizationScopesInput): string[] | undefined {
	if (!input.resourceMetadata || input.challengeScopes?.length || input.resourceMetadata.scopes_supported !== undefined || !input.serverMetadata.scopes_supported?.length) {
		return undefined;
	}
	return [...input.serverMetadata.scopes_supported];
}

/** How long one authorization metadata request (protected resource or authorization server metadata) may take. */
export const MCP_OAUTH_METADATA_TIMEOUT_MS = 30_000;
