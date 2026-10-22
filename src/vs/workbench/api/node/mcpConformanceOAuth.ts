/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_AUTH_FLOW_PORT } from '../../../base/common/oauth.js';
import { createHeadlessRedirectAuthorize, IOAuthFetch, IOAuthFetchInit, IOAuthFetchResponse, IOAuthPreRegisteredClient, OAuthClient, OAuthLogLevel } from '../../../base/common/oauthClient.js';
import { IMcpRemoteServerOAuthConfiguration } from '../../../platform/mcp/common/mcpPlatformTypes.js';
import { McpServerTransportHTTPOAuth } from '../../contrib/mcp/common/mcpTypes.js';
import { createMcpOAuthClient, resolveMcpOAuthPolicy } from '../common/mcpOAuthClientFactory.js';
import { IConformanceContext, IConformanceTokenSource } from './mcpConformanceProxy.js';

/**
 * The OAuth 2.1 client of the MCP conformance client: the product's rule set
 * ({@link createMcpOAuthClient}) with credentials from the scenario context,
 * the Client ID Metadata Document URL the suite expects, Dynamic Client
 * Registration, and a headless authorize step (the suite's authorization
 * server redirects immediately). The scenario servers listen on
 * `http://localhost`, so plain HTTP is allowed.
 */

/** The Client ID Metadata Document URL the `auth/basic-cimd` scenario expects as `client_id`. */
export const CONFORMANCE_CLIENT_METADATA_URL = 'https://conformance-test.local/client-metadata.json';

/** The redirect URI registered and sent in authorization requests; the headless authorize step never loads it. */
export const CONFORMANCE_REDIRECT_URI = `http://127.0.0.1:${DEFAULT_AUTH_FLOW_PORT}/`;

export const CONFORMANCE_CLIENT_NAME = 'VS Code MCP conformance client';

/**
 * The `oauth` policy of the conformance client's server launch: the scenario
 * servers may be plain-HTTP, so the transport's discovery allows HTTP like the
 * OAuth client does; PKCE stays required.
 */
const CONFORMANCE_OAUTH_CONFIGURATION: IMcpRemoteServerOAuthConfiguration = { allowInsecureHttp: true };
export const CONFORMANCE_LAUNCH_OAUTH: McpServerTransportHTTPOAuth = CONFORMANCE_OAUTH_CONFIGURATION;

export interface ICreateConformanceOAuthClientOptions {
	/** The scenario context; `client_id` and `client_secret` are pre-registered credentials. */
	readonly context?: IConformanceContext;
	readonly fetch?: IOAuthFetch;
	/** The protocol revision of the scenario; the client is the same for both. */
	readonly protocolVersion: string;
	/** Receives redacted diagnostics. */
	readonly log?: (level: OAuthLogLevel, message: string) => void;
}

/** Node's fetch behind the {@link IOAuthFetch} shape (redirects are followed unless the caller asks for `manual`). */
export const nodeOAuthFetch: IOAuthFetch = async (url: string, init: IOAuthFetchInit): Promise<IOAuthFetchResponse> => {
	const response = await fetch(url, {
		method: init.method,
		headers: init.headers,
		body: init.body,
		signal: init.signal,
		redirect: init.redirect,
	});
	return response;
};

function preRegisteredClient(context: IConformanceContext | undefined): IOAuthPreRegisteredClient | undefined {
	if (!context?.client_id) {
		return undefined;
	}
	return { clientId: context.client_id, clientSecret: context.client_secret };
}

/** Creates the conformance client's {@link OAuthClient}; the caller disposes it. */
export function createConformanceOAuthClient(options: ICreateConformanceOAuthClientOptions): OAuthClient {
	const fetchImpl = options.fetch ?? nodeOAuthFetch;
	const log = options.log;
	return createMcpOAuthClient({
		clientName: CONFORMANCE_CLIENT_NAME,
		clientUri: 'https://code.visualstudio.com',
		redirectUris: [CONFORMANCE_REDIRECT_URI],
		registration: {
			preRegistered: preRegisteredClient(options.context),
			clientMetadataUrl: CONFORMANCE_CLIENT_METADATA_URL,
			dynamic: true,
		},
		authorize: createHeadlessRedirectAuthorize(fetchImpl),
		// The scenario servers are plain-HTTP localhost servers; PKCE stays required.
		policy: resolveMcpOAuthPolicy(CONFORMANCE_OAUTH_CONFIGURATION),
		fetch: fetchImpl,
		log: log ? (level, message) => log(level, `[MCP ${options.protocolVersion}] ${message}`) : undefined,
	});
}

/**
 * The token source the conformance client's in-process main thread asks: every
 * `$getTokenFromServerMetadata` call of the transport becomes an
 * {@link OAuthClient.acquireToken}, so registration, the authorization code
 * grant with PKCE and `iss` validation, refresh and re-registration are the
 * client's.
 */
export function createConformanceTokenSource(client: OAuthClient): IConformanceTokenSource {
	return {
		async getToken(details, options) {
			const resource = details.resource ?? details.resourceMetadata?.resource;
			if (!resource) {
				throw new Error('The transport named no protected resource to request a token for');
			}
			const authorization = await client.acquireToken({
				serverMetadata: details.authorizationServerMetadata,
				resourceMetadata: details.resourceMetadata,
				resource,
				scopes: details.scopes,
				rejectedToken: options?.rejectedToken,
				forceNewRegistration: options?.forceNewRegistration,
			});
			return authorization.accessToken;
		},
	};
}
