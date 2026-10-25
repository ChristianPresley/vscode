/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_AUTH_FLOW_PORT } from '../../../base/common/oauth.js';
import { createHeadlessRedirectAuthorize, IOAuthFetch, IOAuthFetchInit, IOAuthFetchResponse, IOAuthPreRegisteredClient, OAuthClient, OAuthGrant, OAuthLogLevel, requestIdJag } from '../../../base/common/oauthClient.js';
import { IOAuthDpopProver, OAuthDpopProver } from '../../../base/common/oauthDpop.js';
import { importPkcs8PrivateKey, isJwsAlgorithm } from '../../../base/common/oauthJose.js';
import { IMcpAccessTokenBinding } from '../common/extHost.protocol.js';
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
 * `http://localhost`, so plain HTTP is allowed. The scenarios of the
 * authorization extensions run the grant of a machine client
 * ({@link conformanceGrantFor}), and every scenario can get DPoP-bound tokens
 * when its server accepts them.
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
	/** The grant of a machine client ({@link conformanceGrantFor}); the authorization code grant by default. */
	readonly grant?: OAuthGrant;
	/** The key DPoP-bound tokens are requested with. */
	readonly dpop?: IOAuthDpopProver;
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
		grant: options.grant,
		dpop: options.dpop,
		fetch: fetchImpl,
		log: log ? (level, message) => log(level, `[MCP ${options.protocolVersion}] ${message}`) : undefined,
	});
}

/**
 * The token source the conformance client's in-process main thread asks: every
 * `$getTokenFromServerMetadata` call of the transport becomes an
 * {@link OAuthClient.acquireToken}, so registration, the grant (the
 * authorization code grant with PKCE and `iss` validation, or a machine
 * client's), refresh and re-registration are the client's. A DPoP-bound token
 * is reported bound to `dpop`'s key, which the transport then proves
 * possession of for each request.
 */
export function createConformanceTokenSource(client: OAuthClient, dpop?: OAuthDpopProver): IConformanceTokenSource {
	const bound = new Set<string>();
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
				dpop: details.dpop,
			});
			if (authorization.tokenType === 'DPoP') {
				bound.add(authorization.accessToken);
			}
			return authorization.accessToken;
		},
		async getBinding(accessToken): Promise<IMcpAccessTokenBinding | undefined> {
			return dpop && bound.has(accessToken) ? { dpopKey: dpop.privateJwk } : undefined;
		},
	};
}

function contextString(context: IConformanceContext, key: string): string | undefined {
	const value = context.raw[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The grant of a machine client that a scenario of the authorization
 * extensions gives the client the credentials for in its context; `undefined`
 * (the authorization code grant) for every other scenario:
 *
 * - `private_key_pem` (`auth/client-credentials-jwt`): the client credentials
 *   grant with `private_key_jwt`, signed with `signing_algorithm`;
 * - `auth/client-credentials-basic`: the client credentials grant with the
 *   `client_secret`;
 * - `valid_jwt` (`auth/wif-jwt-bearer`): a JWT authorization grant with the
 *   workload identity JWT, without a client, as workload identity federation
 *   needs none;
 * - `idp_id_token` (`auth/enterprise-managed-authorization`): a JWT
 *   authorization grant whose assertion is the ID-JAG the identity provider
 *   issues for the ID token ({@link requestIdJag}), with the client of the
 *   resource authorization server (`client_id`, `client_secret`). The ID
 *   token stands in for the single sign-on, which the product's
 *   enterprise-managed provider runs.
 */
export async function conformanceGrantFor(scenario: string, context: IConformanceContext, fetchImpl: IOAuthFetch = nodeOAuthFetch): Promise<OAuthGrant | undefined> {
	const clientId = context.client_id;
	const privateKeyPem = contextString(context, 'private_key_pem');
	if (privateKeyPem && clientId) {
		const algorithm = contextString(context, 'signing_algorithm') ?? 'ES256';
		if (!isJwsAlgorithm(algorithm)) {
			throw new Error(`The signing_algorithm ${algorithm} of the scenario is not supported`);
		}
		return { kind: 'client_credentials', credentials: { clientId, privateKey: await importPkcs8PrivateKey(privateKeyPem, algorithm) } };
	}
	if (scenario.startsWith('auth/client-credentials') && clientId && context.client_secret) {
		return { kind: 'client_credentials', credentials: { clientId, clientSecret: context.client_secret } };
	}
	const workloadJwt = contextString(context, 'valid_jwt');
	if (workloadJwt) {
		return { kind: 'jwt_bearer', assertion: async () => workloadJwt };
	}
	const idToken = contextString(context, 'idp_id_token');
	const idpTokenEndpoint = contextString(context, 'idp_token_endpoint');
	const idpClientId = contextString(context, 'idp_client_id');
	if (idToken && idpTokenEndpoint && idpClientId) {
		return {
			kind: 'jwt_bearer',
			assertion: request => requestIdJag({
				tokenEndpoint: idpTokenEndpoint,
				client: { clientId: idpClientId },
				idToken,
				audience: request.serverMetadata.issuer,
				resource: request.resource,
				scopes: request.scopes,
				fetch: fetchImpl,
			}),
			client: clientId && context.client_secret ? { clientId, clientSecret: context.client_secret } : clientId ? { clientId } : undefined,
		};
	}
	return undefined;
}
