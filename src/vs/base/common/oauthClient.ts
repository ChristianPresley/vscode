/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from './async.js';
import { decodeBase64 } from './buffer.js';
import { CancellationToken } from './cancellation.js';
import { CancellationError, isCancellationError } from './errors.js';
import { Emitter, Event } from './event.js';
import { Disposable, DisposableStore } from './lifecycle.js';
import {
	AUTH_PROTECTED_RESOURCE_METADATA_DISCOVERY_PATH,
	buildClientAuthentication,
	canonicalResourceUri,
	createPkcePair,
	encodeRandomBase64Url,
	fetchAuthorizationServerMetadata,
	fetchDynamicRegistration,
	getDefaultMetadataForUrl,
	GRANT_TYPE_JWT_BEARER,
	GRANT_TYPE_TOKEN_EXCHANGE,
	IAuthorizationProtectedResourceMetadata,
	IAuthorizationRedirectParams,
	IAuthorizationServerMetadata,
	IFetchAuthorizationServerMetadataOptions,
	isAuthorizationErrorResponse,
	isAuthorizationProtectedResourceMetadata,
	isAuthorizationTokenResponse,
	isLoopbackUrl,
	isValidClientMetadataUrl,
	OAuthClientError,
	OAuthIssuerMismatchError,
	OAuthTokenEndpointAuthMethod,
	parseAuthorizationRedirect,
	parseWWWAuthenticateHeader,
	pkceSupported,
	selectRegistrationAuthMethod,
	selectTokenEndpointAuthMethod,
	TOKEN_TYPE_ID_JAG,
	TOKEN_TYPE_ID_TOKEN,
	validateIssuerParameter,
} from './oauth.js';
import { authorizationServerSupportsDpop, DPOP_HEADER, DPOP_NONCE_HEADER, DPOP_SCHEME, IOAuthDpopProver, isDpopTokenType, USE_DPOP_NONCE_ERROR } from './oauthDpop.js';
import { base64UrlEncode, IJwsSigningKey, signJwt } from './oauthJose.js';

/**
 * A UI-free OAuth 2.1 client implementing the MCP 2026-07-28 authorization
 * flow: protected resource metadata discovery (RFC 9728), authorization server
 * metadata discovery (RFC 8414 / OpenID Connect Discovery) with issuer
 * validation, client registration (pre-registered, Client ID Metadata
 * Documents, Dynamic Client Registration, or a prompt), the authorization code
 * grant with PKCE `S256`, RFC 8707 resource indicators, RFC 9207 `iss`
 * validation, token refresh and scope step-up. The browser interaction is
 * injected as an {@link OAuthAuthorizeStrategy} so the core can run headless.
 *
 * It also implements the authorization extensions of MCP for machine clients
 * ({@link OAuthGrant}): the client credentials grant
 * (`io.modelcontextprotocol/oauth-client-credentials`, with a client secret
 * or `private_key_jwt`) and the JWT authorization grant of RFC 7523 section
 * 2.1, whose assertion is a workload identity JWT
 * (`io.modelcontextprotocol/auth/wif`) or an ID-JAG of enterprise-managed
 * authorization ({@link requestIdJag}); and DPoP-bound tokens
 * (`io.modelcontextprotocol/auth/dpop`, RFC 9449) for every grant.
 */

//#region fetch

export interface IOAuthFetchInit {
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly body?: string;
	readonly signal?: AbortSignal;
	/** How redirects are handled; `manual` returns the 3xx response untouched. */
	readonly redirect?: 'follow' | 'manual' | 'error';
}

export interface IOAuthFetchResponse {
	readonly status: number;
	readonly statusText?: string;
	readonly headers: { get(name: string): string | null };
	text(): Promise<string>;
	json(): Promise<unknown>;
}

export type IOAuthFetch = (url: string, init: IOAuthFetchInit) => Promise<IOAuthFetchResponse>;

//#endregion

//#region storage

export type OAuthRegistrationKind = 'pre-registered' | 'cimd' | 'dcr' | 'prompt';

/** How an access token is presented: as a bearer token (RFC 6750), or bound to a DPoP key (RFC 9449). */
export type OAuthTokenType = 'Bearer' | 'DPoP';

/** What the client remembers about a resource, keyed by its canonical URI. */
export interface IOAuthClientRecord {
	/** The issuer of the authorization server the registration and tokens belong to. */
	readonly issuer: string;
	readonly registrationKind: OAuthRegistrationKind;
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
	readonly accessToken?: string;
	readonly refreshToken?: string;
	/** Milliseconds since the epoch at which the access token expires. */
	readonly expiresAt?: number;
	/** The scopes granted with the access token (or requested, when the server did not echo them). */
	readonly scopes?: readonly string[];
	/** Authorization requests made for the resource by this client instance. */
	readonly authorizationRequests: number;
	/** `DPoP` when the access token is bound to the key of {@link dpopThumbprint}; a bearer token otherwise. */
	readonly tokenType?: OAuthTokenType;
	/**
	 * The thumbprint of the DPoP key the token requests were made with. The
	 * tokens (a public client's refresh token too, RFC 9449 section 5) only work
	 * with that key, so a client with another key does not use them.
	 */
	readonly dpopThumbprint?: string;
}

export interface IOAuthClientStorage {
	get(key: string): Promise<IOAuthClientRecord | undefined>;
	set(key: string, record: IOAuthClientRecord): Promise<void>;
	delete(key: string): Promise<void>;
}

export class InMemoryOAuthClientStorage implements IOAuthClientStorage {
	private readonly records = new Map<string, IOAuthClientRecord>();

	get size(): number {
		return this.records.size;
	}

	async get(key: string): Promise<IOAuthClientRecord | undefined> {
		return this.records.get(key);
	}

	async set(key: string, record: IOAuthClientRecord): Promise<void> {
		this.records.set(key, record);
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}
}

//#endregion

//#region options

export interface IOAuthPreRegisteredClient {
	readonly clientId: string;
	readonly clientSecret?: string;
	/** The issuer the credentials were registered with; when omitted it is bound on first use. */
	readonly issuer?: string;
}

export interface IOAuthRegistrationOptions {
	/** Static credentials for the resource's authorization server; always preferred when present. */
	readonly preRegistered?: IOAuthPreRegisteredClient;
	/** The HTTPS URL of the Client ID Metadata Document, used when the authorization server advertises support. */
	readonly clientMetadataUrl?: string;
	/** Whether Dynamic Client Registration (RFC 7591) may be used; defaults to true. */
	readonly dynamic?: boolean;
	/** Asks the user for credentials when no other mechanism is available; `undefined` cancels. */
	readonly prompt?: () => Promise<{ clientId: string; clientSecret?: string } | undefined>;
}

export interface IOAuthAuthorizeRequest {
	readonly authorizationUrl: string;
	readonly state: string;
	readonly redirectUri: string;
	/** The issuer recorded from the validated metadata, to be compared with the redirect's `iss`. */
	readonly expectedIssuer: string;
	readonly issParameterSupported: boolean;
}

export type OAuthAuthorizeResult =
	/** The query string of the redirect that reached the redirect URI. */
	| { readonly query: string }
	| { readonly code: string; readonly state: string; readonly iss?: string };

/** Opens the authorization URL for the user and resolves with the redirect; headless tests resolve immediately. */
export type OAuthAuthorizeStrategy = (request: IOAuthAuthorizeRequest, token: CancellationToken) => Promise<OAuthAuthorizeResult>;

/**
 * The credentials of a pre-registered client: a secret, sent as the server
 * supports it (`client_secret_basic`, else `client_secret_post`), or a private
 * key for `private_key_jwt` (RFC 7523 section 2.2), which the client
 * credentials extension recommends.
 */
export type OAuthClientCredentials =
	| { readonly clientId: string; readonly clientSecret: string; readonly privateKey?: undefined }
	| { readonly clientId: string; readonly privateKey: IJwsSigningKey; readonly keyId?: string; readonly audience?: OAuthClientAssertionAudience; readonly clientSecret?: undefined };

/**
 * The `aud` of a `private_key_jwt` client assertion: the issuer identifier
 * (the default, which draft-ietf-oauth-rfc7523bis makes the only value), or
 * the token endpoint URL, which RFC 7523 section 3 also allows and some
 * authorization servers (Microsoft Entra ID) require.
 */
export type OAuthClientAssertionAudience = 'issuer' | 'token_endpoint';

/** What a JWT authorization grant's assertion is requested for. */
export interface IOAuthAssertionRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	/** The RFC 8707 `resource` of the token request. */
	readonly resource: string;
	readonly scopes?: readonly string[];
}

/** Supplies the assertion of a JWT authorization grant, for each token request. */
export type OAuthAssertionSource = (request: IOAuthAssertionRequest, token: CancellationToken) => Promise<string>;

/** How an {@link OAuthClient} obtains tokens. */
export type OAuthGrant =
	/** The authorization code grant with PKCE: a user signs in (the default). */
	| { readonly kind: 'authorization_code' }
	/** The client credentials grant of a pre-registered machine client (`io.modelcontextprotocol/oauth-client-credentials`). */
	| { readonly kind: 'client_credentials'; readonly credentials: OAuthClientCredentials }
	/**
	 * The JWT authorization grant (RFC 7523 section 2.1): a workload identity
	 * JWT (`io.modelcontextprotocol/auth/wif`), or the ID-JAG of
	 * enterprise-managed authorization. `client` authenticates the request
	 * (the client of the resource authorization server, for an ID-JAG), or
	 * only names a public client; without it the request names no client, as
	 * workload identity federation needs none.
	 */
	| { readonly kind: 'jwt_bearer'; readonly assertion: OAuthAssertionSource; readonly client?: OAuthClientCredentials | { readonly clientId: string; readonly clientSecret?: undefined; readonly privateKey?: undefined } };

export type OAuthGrantKind = OAuthGrant['kind'];

export type OAuthLogLevel = 'info' | 'warn' | 'error';

export interface IOAuthClientOptions {
	readonly clientName: string;
	readonly clientUri?: string;
	/** Redirect URIs to register; the first one is used in authorization requests. */
	readonly redirectUris: readonly string[];
	readonly registration: IOAuthRegistrationOptions;
	readonly authorize: OAuthAuthorizeStrategy;
	readonly storage?: IOAuthClientStorage;
	readonly fetch?: IOAuthFetch;
	readonly random?: (bytes: number) => Uint8Array;
	readonly sha256?: (data: Uint8Array) => Promise<Uint8Array>;
	readonly now?: () => number;
	/** Allow `http://` endpoints on non-loopback hosts; defaults to false. */
	readonly allowInsecureHttp?: boolean;
	/** Whether `S256` must be advertised in `code_challenge_methods_supported`; defaults to `require-advertised`. */
	readonly pkce?: 'require-advertised' | 'assume-supported';
	/** Challenges handled for a single {@link OAuthClient.fetchWithAuth} call; defaults to 3. */
	readonly maxChallengesPerRequest?: number;
	/** Authorization requests per resource for the lifetime of the client, the initial one included; defaults to 3. */
	readonly maxAuthorizationRequests?: number;
	/** Access tokens expiring within this many seconds are refreshed; defaults to 60. */
	readonly refreshMarginSeconds?: number;
	/** Request `offline_access` when the authorization server lists it in `scopes_supported`. */
	readonly requestOfflineAccess?: boolean;
	/** Fall back to the 2025-03-26 default endpoints at the resource origin when it serves no protected resource metadata. */
	readonly legacyDefaultEndpoints?: boolean;
	/** Headers sent with protected resource metadata requests to the resource's own origin. */
	readonly sameOriginHeaders?: Record<string, string>;
	/** How the client obtains tokens; the authorization code grant by default. */
	readonly grant?: OAuthGrant;
	/**
	 * Ask for DPoP-bound tokens (RFC 9449) with this key from an authorization
	 * server that lists its algorithm in `dpop_signing_alg_values_supported`:
	 * every token request carries a proof, and {@link OAuthClient.fetchWithAuth}
	 * presents a DPoP-bound token with the `DPoP` scheme and a fresh proof. A
	 * server that issues a bearer token anyway gets that token back as one.
	 */
	readonly dpop?: IOAuthDpopProver;
	/** Receives redacted diagnostics; secrets never reach it. */
	readonly log?: (level: OAuthLogLevel, message: string) => void;
}

//#endregion

//#region results

export interface IOAuthChallenge {
	readonly scheme: string;
	readonly resourceMetadataUrl?: string;
	readonly scope?: string;
	readonly error?: string;
	readonly errorDescription?: string;
}

export interface IOAuthDiscovery {
	/** The canonical resource URI (RFC 8707). */
	readonly resource: string;
	readonly challenge?: IOAuthChallenge;
	readonly resourceMetadata?: IAuthorizationProtectedResourceMetadata;
	readonly resourceMetadataUrl?: string;
	/** The selected `authorization_servers` entry (the resource origin for legacy defaults). */
	readonly authorizationServer: string;
	readonly serverMetadata: IAuthorizationServerMetadata;
	/** True when the 2025-03-26 default endpoints were synthesized because no metadata exists. */
	readonly legacyDefaults: boolean;
}

export interface IOAuthRegistration {
	readonly kind: OAuthRegistrationKind;
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
	/** A key for `private_key_jwt` (RFC 7523 section 2.2), which then authenticates the client instead of {@link tokenEndpointAuthMethod}. */
	readonly assertionKey?: { readonly key: IJwsSigningKey; readonly keyId?: string; readonly audience?: OAuthClientAssertionAudience };
}

export interface IOAuthTokenResult {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: number;
	readonly scopes?: readonly string[];
	/** `DPoP` for a token bound to the client's DPoP key; a bearer token when absent. */
	readonly tokenType?: OAuthTokenType;
	/** The thumbprint of the DPoP key the token request proved possession of, if it carried a proof. */
	readonly dpopThumbprint?: string;
}

export interface IOAuthAuthorization extends IOAuthTokenResult {
	readonly record: IOAuthClientRecord;
}

export interface IOAuthAcquireTokenRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resourceMetadata?: IAuthorizationProtectedResourceMetadata;
	readonly resource: string;
	/** Scopes demanded by the challenge; they take precedence over the resource's `scopes_supported`. */
	readonly scopes?: readonly string[];
	/** An access token the resource rejected; it is never returned again. */
	readonly rejectedToken?: string;
	/** Discard the stored registration and register anew. */
	readonly forceNewRegistration?: boolean;
	/**
	 * Ask for a DPoP-bound token, because the resource requires them ({@link resourceRequiresDpop}). It takes
	 * effect with a configured {@link IOAuthClientOptions.dpop} prover and an authorization server that
	 * supports its algorithm.
	 */
	readonly dpop?: boolean;
}

export interface IOAuthAuthorizationCodeGrantRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resource: string;
	/** The `resource` value to send; {@link resourceIndicatorFor} of `resource` by default. */
	readonly resourceIndicator?: string;
	readonly registration: IOAuthRegistration;
	readonly scopes?: readonly string[];
	/**
	 * Ask for a DPoP-bound token, because the resource requires them ({@link resourceRequiresDpop}). It takes
	 * effect with a configured {@link IOAuthClientOptions.dpop} prover and an authorization server that
	 * supports its algorithm.
	 */
	readonly dpop?: boolean;
}

export interface IOAuthRefreshRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resource: string;
	/** The `resource` value to send; {@link resourceIndicatorFor} of `resource` by default. */
	readonly resourceIndicator?: string;
	/** The client the refresh token was issued to; `undefined` for one issued without client identification (a workload identity grant). */
	readonly registration: IOAuthRegistration | undefined;
	readonly refreshToken: string;
	/** The scopes of the token being refreshed, recorded when the server does not echo them. */
	readonly scopes?: readonly string[];
	/**
	 * Ask for a DPoP-bound token, because the resource requires them ({@link resourceRequiresDpop}). It takes
	 * effect with a configured {@link IOAuthClientOptions.dpop} prover and an authorization server that
	 * supports its algorithm.
	 */
	readonly dpop?: boolean;
}

export interface IOAuthClientCredentialsGrantRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resource: string;
	/** The `resource` value to send; {@link resourceIndicatorFor} of `resource` by default. */
	readonly resourceIndicator?: string;
	readonly credentials: OAuthClientCredentials;
	readonly scopes?: readonly string[];
	/**
	 * Ask for a DPoP-bound token, because the resource requires them ({@link resourceRequiresDpop}). It takes
	 * effect with a configured {@link IOAuthClientOptions.dpop} prover and an authorization server that
	 * supports its algorithm.
	 */
	readonly dpop?: boolean;
}

export interface IOAuthJwtBearerGrantRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resource: string;
	/** The `resource` value to send; {@link resourceIndicatorFor} of `resource` by default. */
	readonly resourceIndicator?: string;
	/** The JWT presented as the grant (`assertion`). */
	readonly assertion: string;
	/** The client that authenticates the request; `undefined` names none. */
	readonly registration?: IOAuthRegistration;
	readonly scopes?: readonly string[];
	/**
	 * Ask for a DPoP-bound token, because the resource requires them ({@link resourceRequiresDpop}). It takes
	 * effect with a configured {@link IOAuthClientOptions.dpop} prover and an authorization server that
	 * supports its algorithm.
	 */
	readonly dpop?: boolean;
}

export interface IOAuthHandleChallengeOptions {
	/** The access token the request carried, if any. */
	readonly previousToken?: string;
	/** Additional scopes the caller needs. */
	readonly scopes?: readonly string[];
}

export interface IOAuthRecordChangeEvent {
	readonly resource: string;
	readonly record: IOAuthClientRecord | undefined;
}

//#endregion

//#region pure helpers

export const OFFLINE_ACCESS_SCOPE = 'offline_access';

export interface ISelectScopesInput {
	/** The `scope` parameter of the `WWW-Authenticate` challenge. */
	readonly challengeScope?: string;
	/** `scopes_supported` of the protected resource metadata. */
	readonly prmScopes?: readonly string[];
	/** Scopes previously requested or granted, kept on re-authorization. */
	readonly previous?: readonly string[];
	readonly requestOfflineAccess?: boolean;
	/** `scopes_supported` of the authorization server metadata. */
	readonly scopesSupported?: readonly string[];
}

/**
 * The scope selection strategy of the MCP authorization specification: the
 * challenge's `scope` is authoritative, otherwise the resource's
 * `scopes_supported`, otherwise the parameter is omitted. Previously held
 * scopes are kept (step-up union) and `offline_access` is appended only when
 * requested and listed by the authorization server.
 */
export function selectScopes(input: ISelectScopesInput): string[] | undefined {
	const challenged = splitScopes(input.challengeScope);
	const base = challenged.length > 0 ? challenged : input.prmScopes ?? [];
	const selected = unique([...(input.previous ?? []), ...base]);
	if (input.requestOfflineAccess && input.scopesSupported?.includes(OFFLINE_ACCESS_SCOPE) && !selected.includes(OFFLINE_ACCESS_SCOPE)) {
		selected.push(OFFLINE_ACCESS_SCOPE);
	}
	return selected.length > 0 ? selected : undefined;
}

/**
 * The RFC 8707 `resource` value of the authorization and token requests for
 * the resource whose canonical URI is `key`. The MCP authorization
 * specification aligns the canonical server URI with the `resource` of the
 * protected resource metadata (RFC 9728), so the `resource` the metadata
 * publishes is sent as written when it names this resource (`key` or its
 * origin), less any fragment (RFC 8707 section 2: the indicator MUST NOT
 * include one). Without metadata it is `key`, but a bare origin goes without
 * the trailing slash a URL parser adds (`https://mcp.example.com`, the form
 * the specification recommends). Stored records and request limits stay keyed
 * by `key`.
 */
export function resourceIndicatorFor(key: string, prmResource?: string): string {
	const url = new URL(key);
	if (prmResource !== undefined) {
		try {
			const named = canonicalResourceUri(prmResource);
			if (named === key || named === canonicalResourceUri(url.origin)) {
				// The fragment starts at the first `#` of a string that parses as a URL.
				const hash = prmResource.indexOf('#');
				return hash === -1 ? prmResource : prmResource.substring(0, hash);
			}
		} catch {
			// Not a URL: the metadata does not name this resource.
		}
	}
	return url.pathname === '/' && url.search === '' && key.endsWith('/') ? key.slice(0, -1) : key;
}

/**
 * The endpoint rule of the authorization flow: a URL that receives
 * credentials or client metadata, or that names the endpoints which do (an
 * issuer), is HTTPS or loopback, unless plain HTTP is explicitly allowed
 * (`allowInsecureHttp`, a development escape hatch).
 */
export function isSecureOAuthEndpoint(url: string, allowInsecureHttp = false): boolean {
	return url.startsWith('https://') || allowInsecureHttp || isLoopbackUrl(url);
}

/** Throws an `insecure_endpoint` {@link OAuthClientError} for a URL that breaks the rule of {@link isSecureOAuthEndpoint}. */
export function assertSecureOAuthEndpoint(url: string, what: string, allowInsecureHttp = false): void {
	if (!isSecureOAuthEndpoint(url, allowInsecureHttp)) {
		throw new OAuthClientError('insecure_endpoint', `The ${what} ${url} is not served over HTTPS`);
	}
}

/**
 * Extracts the OAuth challenge of a `WWW-Authenticate` header: its first
 * challenge of the `preferred` scheme, else its first one of the other. A
 * resource server that accepts DPoP-bound tokens challenges with the `DPoP`
 * scheme (RFC 9449 section 7.1), with the same parameters (`resource_metadata`,
 * `scope`, `error`) as a `Bearer` challenge (RFC 6750, RFC 9728); a client
 * that presented a DPoP-bound token prefers that one.
 */
export function parseOAuthChallenge(wwwAuthenticate: string | undefined, preferred: OAuthTokenType = 'Bearer'): IOAuthChallenge | undefined {
	if (!wwwAuthenticate) {
		return undefined;
	}
	const challenges = parseWWWAuthenticateHeader(wwwAuthenticate);
	const ofScheme = (scheme: string) => challenges.find(c => c.scheme.toLowerCase() === scheme.toLowerCase());
	const challenge = ofScheme(preferred) ?? ofScheme(preferred === 'Bearer' ? DPOP_SCHEME : 'Bearer');
	if (!challenge) {
		return undefined;
	}
	const param = (name: string): string | undefined => {
		const value = challenge.params[name];
		return value === undefined || value === '' ? undefined : value;
	};
	return {
		scheme: challenge.scheme,
		resourceMetadataUrl: param('resource_metadata'),
		scope: param('scope'),
		error: param('error'),
		errorDescription: param('error_description'),
	};
}

/**
 * Whether a resource requires DPoP-bound tokens (RFC 9449): its protected
 * resource metadata sets `dpop_bound_access_tokens_required` (RFC 9728
 * section 2), or it challenges with the `DPoP` scheme and not with `Bearer`
 * (section 7.1). VS Code asks for a DPoP-bound token by default only then: an
 * authorization server may support DPoP for resources that take bearer
 * tokens, and a resource that takes both is served best by a token every
 * client of the session can present (a bearer token).
 */
export function resourceRequiresDpop(wwwAuthenticate: string | undefined, resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined): boolean {
	if (resourceMetadata?.dpop_bound_access_tokens_required === true) {
		return true;
	}
	const schemes = wwwAuthenticate ? parseWWWAuthenticateHeader(wwwAuthenticate).map(c => c.scheme.toLowerCase()) : [];
	return schemes.includes(DPOP_SCHEME.toLowerCase()) && !schemes.includes('bearer');
}

const REDACTED = '[redacted]';

/**
 * Removes credentials from a diagnostic message: `Bearer`/`Basic`/`DPoP`
 * credentials (but not challenge parameters), `Location` values, and the
 * values of `code`, `code_verifier` and every `*token`, `*secret`,
 * `*password` and `*assertion` field (`access_token`, `refresh_token`,
 * `id_token`, `registration_access_token`, `client_secret`, ...) in query
 * strings, form bodies and JSON. Every log line of {@link OAuthClient}
 * passes through it.
 */
export function redact(text: string): string {
	return text
		// Everything after the scheme is a credential unless it is a known challenge parameter, or a
		// word of the message itself standing alone ("a bearer token", "asked for a DPoP nonce").
		.replace(/\b(Bearer|Basic|DPoP)\s+(?!(?:realm|scope|error|error_description|error_uri|resource_metadata|algs|charset)\s*=)(?!(?:tokens?|proofs?|nonces?|keys?|challenges?|schemes?|authentication)[.:)]?(?:[\s,;"'`]|$))[^\s,;"'`]+/gi, `$1 ${REDACTED}`)
		.replace(/\b(location)\s*[:=]\s*[^\s,;"'`]+/gi, `$1: ${REDACTED}`)
		.replace(/"([A-Za-z_]*(?:token|secret|password|assertion)|code|code_verifier)"\s*:\s*"[^"]*"/gi, `"$1":"${REDACTED}"`)
		.replace(/(^|[?&;,\s])([A-Za-z_]*(?:token|secret|password|assertion)|code|code_verifier)=[^&\s;"'`]*/gi, `$1$2=${REDACTED}`);
}

/**
 * An authorize strategy for headless use against authorization servers that
 * redirect immediately (test fixtures): it requests the authorization URL
 * without following redirects and returns the `Location` query.
 */
export function createHeadlessRedirectAuthorize(fetchImpl: IOAuthFetch): OAuthAuthorizeStrategy {
	return async (request, token) => {
		const store = new DisposableStore();
		try {
			const response = await fetchImpl(request.authorizationUrl, { method: 'GET', redirect: 'manual', signal: CancellationToken.toAbortSignal(token, store) });
			const location = response.headers.get('Location');
			if (response.status < 300 || response.status >= 400 || !location) {
				throw new OAuthClientError('authorization_denied', `The authorization endpoint answered ${response.status} instead of redirecting`);
			}
			return { query: new URL(location, request.authorizationUrl).search };
		} finally {
			store.dispose();
		}
	};
}

export interface IOAuthIdJagRequest {
	/** The token endpoint of the enterprise identity provider. */
	readonly tokenEndpoint: string;
	/** The client the user signed in to the identity provider with; it authenticates the exchange by `tokenEndpointAuthMethod` (`none` by default). */
	readonly client: { readonly clientId: string; readonly clientSecret?: string; readonly tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod };
	/** The ID token of the user's single sign-on, the `subject_token`. */
	readonly idToken: string;
	/** The issuer identifier of the resource authorization server, which redeems the ID-JAG. */
	readonly audience: string;
	/** The resource identifier of the MCP server (RFC 9728). */
	readonly resource?: string;
	readonly scopes?: readonly string[];
	readonly fetch: IOAuthFetch;
	readonly signal?: AbortSignal;
}

/**
 * Exchanges the ID token of a single sign-on for an Identity Assertion JWT
 * Authorization Grant (ID-JAG) at the enterprise identity provider: the token
 * exchange (RFC 8693) of enterprise-managed authorization, section 4 (the
 * `audience` is the resource authorization server, the `resource` the MCP
 * server). The ID-JAG is then the assertion of a JWT authorization grant at
 * the resource authorization server ({@link OAuthClient.jwtBearerGrant}).
 */
export async function requestIdJag(request: IOAuthIdJagRequest): Promise<string> {
	const auth = buildClientAuthentication(request.client.tokenEndpointAuthMethod ?? 'none', request.client.clientId, request.client.clientSecret);
	const params: Record<string, string> = {
		...auth.body,
		grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
		requested_token_type: TOKEN_TYPE_ID_JAG,
		subject_token: request.idToken,
		subject_token_type: TOKEN_TYPE_ID_TOKEN,
		audience: request.audience,
	};
	if (request.resource) {
		params.resource = request.resource;
	}
	if (request.scopes && request.scopes.length > 0) {
		params.scope = request.scopes.join(' ');
	}
	const response = await request.fetch(request.tokenEndpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', ...auth.headers },
		body: new URLSearchParams(params).toString(),
		signal: request.signal,
		// The body carries the user's ID token: a redirect would send it elsewhere.
		redirect: 'manual',
	});
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		payload = undefined;
	}
	const issued = typeof payload === 'object' && payload !== null ? payload as { readonly access_token?: unknown; readonly issued_token_type?: unknown } : undefined;
	if (response.status === 200 && typeof issued?.access_token === 'string' && issued.access_token.length > 0) {
		if (issued.issued_token_type !== undefined && issued.issued_token_type !== TOKEN_TYPE_ID_JAG) {
			throw new OAuthClientError('token_request_failed', `The identity provider issued a '${String(issued.issued_token_type)}' instead of an ID-JAG`);
		}
		return issued.access_token;
	}
	const failure = isAuthorizationErrorResponse(payload) ? payload : undefined;
	const description = failure ? `${failure.error}${failure.error_description ? ` (${failure.error_description})` : ''}` : 'no error details';
	throw new OAuthClientError('token_request_failed', `The ID-JAG token exchange at ${request.tokenEndpoint} failed with HTTP ${response.status}: ${redact(description)}`, { status: response.status, error: failure?.error, errorDescription: failure?.error_description });
}

/** Slack for the clock of the issuer of a workload identity JWT. */
const WORKLOAD_JWT_CLOCK_SKEW_SECONDS = 60;

function withoutTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Why a workload identity JWT must not be presented to an authorization
 * server, or `undefined` when it may be: it must be a signed JWT in the
 * compact serialization (not `alg: none`), not expired, and issued for this
 * authorization server (`aud` names its token endpoint, as workload identity
 * federation requires, or its issuer identifier). A file that holds anything
 * else, or a JWT for another audience, thus stays on the machine.
 */
export function workloadIdentityJwtProblem(jwt: string, serverMetadata: Pick<IAuthorizationServerMetadata, 'issuer' | 'token_endpoint'>, nowMs: number): string | undefined {
	const parts = jwt.split('.');
	if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
		return 'it is not a JWT in the compact serialization';
	}
	let header: unknown;
	let claims: unknown;
	try {
		header = JSON.parse(new TextDecoder().decode(decodeBase64(parts[0]).buffer));
		claims = JSON.parse(new TextDecoder().decode(decodeBase64(parts[1]).buffer));
	} catch {
		return 'its header or claims are not JSON';
	}
	const alg = typeof header === 'object' && header !== null ? (header as { readonly alg?: unknown }).alg : undefined;
	if (typeof alg !== 'string' || alg.toLowerCase() === 'none') {
		return 'it is not signed';
	}
	const { aud, exp } = (typeof claims === 'object' && claims !== null ? claims : {}) as { readonly aud?: unknown; readonly exp?: unknown };
	if (typeof exp !== 'number' || exp + WORKLOAD_JWT_CLOCK_SKEW_SECONDS <= nowMs / 1000) {
		return typeof exp === 'number' ? 'it has expired' : 'it has no expiration time';
	}
	const audiences = (Array.isArray(aud) ? aud : [aud]).filter((a): a is string => typeof a === 'string').map(withoutTrailingSlash);
	const accepted = [serverMetadata.issuer, serverMetadata.token_endpoint].filter((a): a is string => typeof a === 'string').map(withoutTrailingSlash);
	if (!audiences.some(a => accepted.includes(a))) {
		return `its audience is not the authorization server ${serverMetadata.issuer}`;
	}
	return undefined;
}

function splitScopes(scope: string | undefined): string[] {
	return scope ? scope.split(/\s+/).filter(s => s.length > 0) : [];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function isRedirectQuery(result: OAuthAuthorizeResult): result is { readonly query: string } {
	return typeof (result as { readonly query?: unknown }).query === 'string';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isInvalidClientError(error: unknown): boolean {
	if (!(error instanceof OAuthClientError)) {
		return false;
	}
	const detail = error.detail as { readonly error?: unknown } | undefined;
	return (error.code === 'token_request_failed' || error.code === 'authorization_denied') && detail?.error === 'invalid_client';
}

const AUTHORIZATION_CODE_GRANT: OAuthGrant = { kind: 'authorization_code' };

/** The `client_assertion_type` of a JWT client assertion (RFC 7523 section 2.2). */
export const CLIENT_ASSERTION_TYPE_JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** How long a `private_key_jwt` client assertion is valid; it is signed for each token request. */
const CLIENT_ASSERTION_LIFETIME_SECONDS = 300;

/**
 * The registration a machine client's token requests use: none without a
 * client, a key for `private_key_jwt`, a secret by the server's methods
 * (`client_secret_basic` unless it only supports `client_secret_post`), or
 * the id of a public client.
 */
function machineRegistration(client: OAuthClientCredentials | { readonly clientId: string; readonly clientSecret?: undefined; readonly privateKey?: undefined } | undefined, serverMetadata: IAuthorizationServerMetadata): IOAuthRegistration | undefined {
	if (!client) {
		return undefined;
	}
	if (client.privateKey) {
		return { kind: 'pre-registered', clientId: client.clientId, tokenEndpointAuthMethod: 'none', assertionKey: { key: client.privateKey, keyId: client.keyId, audience: client.audience } };
	}
	if (client.clientSecret !== undefined) {
		const supported = serverMetadata.token_endpoint_auth_methods_supported;
		if (supported && supported.length > 0 && !supported.includes('client_secret_basic') && !supported.includes('client_secret_post')) {
			throw new OAuthClientError('grant_unsupported', `The authorization server ${serverMetadata.issuer} accepts no client secret (token_endpoint_auth_methods_supported: ${supported.join(' ')})`);
		}
		return { kind: 'pre-registered', clientId: client.clientId, clientSecret: client.clientSecret, tokenEndpointAuthMethod: selectTokenEndpointAuthMethod(undefined, supported, true) };
	}
	return { kind: 'pre-registered', clientId: client.clientId, tokenEndpointAuthMethod: 'none' };
}

//#endregion

interface IResourceMetadataCandidate {
	readonly url: string;
	/** The canonical resource identifiers the metadata's `resource` may name. */
	readonly expected: readonly string[];
}

interface IRejectionStreak {
	/** The access token the last challenge handling issued. */
	readonly issued: string;
	/** Consecutive rejections leading up to it. */
	readonly count: number;
}

export class OAuthClient extends Disposable {

	private readonly _onDidChangeRecord = this._register(new Emitter<IOAuthRecordChangeEvent>());
	readonly onDidChangeRecord: Event<IOAuthRecordChangeEvent> = this._onDidChangeRecord.event;

	private readonly storage: IOAuthClientStorage;
	private readonly fetch: IOAuthFetch;
	private readonly random: (bytes: number) => Uint8Array;
	private readonly sha256: (data: Uint8Array) => Promise<Uint8Array>;
	private readonly now: () => number;
	private readonly maxChallengesPerRequest: number;
	private readonly maxAuthorizationRequests: number;
	private readonly refreshMarginMs: number;

	/** Authorization requests per canonical resource for the lifetime of the client. */
	private readonly authorizationRequests = new Map<string, number>();
	/** The scopes most recently requested at the authorization endpoint per resource. */
	private readonly lastRequestedScopes = new Map<string, readonly string[]>();
	private readonly rejections = new Map<string, IRejectionStreak>();
	/** The last assertion per resource that the authorization server refused; it is not presented again. */
	private readonly refusedAssertions = new Map<string, string>();

	constructor(private readonly options: IOAuthClientOptions) {
		super();
		if (options.redirectUris.length === 0) {
			throw new Error('OAuthClient requires at least one redirect URI');
		}
		this.storage = options.storage ?? new InMemoryOAuthClientStorage();
		this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.random = options.random ?? (bytes => crypto.getRandomValues(new Uint8Array(bytes)));
		this.sha256 = options.sha256 ?? (async data => new Uint8Array(await crypto.subtle.digest('SHA-256', data as ArrayBufferView<ArrayBuffer>)));
		this.now = options.now ?? (() => Date.now());
		this.maxChallengesPerRequest = options.maxChallengesPerRequest ?? 3;
		this.maxAuthorizationRequests = options.maxAuthorizationRequests ?? 3;
		this.refreshMarginMs = (options.refreshMarginSeconds ?? 60) * 1000;
	}

	//#region discovery

	/**
	 * Discovers the authorization server for a resource: the challenge's
	 * `resource_metadata`, then the path-based and root well-known protected
	 * resource metadata (RFC 9728), then the selected authorization server's
	 * metadata in the specification's discovery order with exact issuer
	 * validation. The authorization server and its authorization and token
	 * endpoints must be HTTPS (or loopback) and PKCE `S256` must be advertised
	 * unless configured otherwise. A registration endpoint is checked only
	 * where a client registers there.
	 */
	async discover(resource: string, wwwAuthenticate?: string, token: CancellationToken = CancellationToken.None): Promise<IOAuthDiscovery> {
		const key = canonicalResourceUri(resource);
		const challenge = parseOAuthChallenge(wwwAuthenticate);
		const store = new DisposableStore();
		try {
			const signal = CancellationToken.toAbortSignal(token, store);
			const prm = await this.discoverResourceMetadata(key, challenge?.resourceMetadataUrl, signal);
			if (!prm) {
				return this.discoverLegacy(key, challenge, signal);
			}
			const servers = prm.metadata.authorization_servers ?? [];
			if (servers.length === 0) {
				throw new OAuthClientError('discovery_failed', `The protected resource metadata at ${prm.url} lists no authorization servers`);
			}
			const record = await this.storage.get(key);
			const authorizationServer = record && servers.includes(record.issuer) ? record.issuer : servers[0];
			// Metadata fetched in cleartext could name any endpoints: the issuer follows the endpoint rule too.
			this.assertSecureEndpoint(authorizationServer, 'authorization server');
			const serverMetadata = await this.fetchServerMetadata(authorizationServer, signal);
			this.validateServerMetadata(serverMetadata);
			this.log('info', `discovered authorization server ${serverMetadata.issuer} for ${key} via ${prm.url}`);
			return { resource: key, challenge, resourceMetadata: prm.metadata, resourceMetadataUrl: prm.url, authorizationServer, serverMetadata, legacyDefaults: false };
		} finally {
			store.dispose();
		}
	}

	private async discoverLegacy(key: string, challenge: IOAuthChallenge | undefined, signal: AbortSignal): Promise<IOAuthDiscovery> {
		if (!this.options.legacyDefaultEndpoints) {
			throw new OAuthClientError('discovery_failed', `No protected resource metadata was found for ${key}`);
		}
		const origin = new URL(key).origin;
		this.assertSecureEndpoint(origin, 'authorization server');
		let serverMetadata: IAuthorizationServerMetadata;
		let legacyDefaults = false;
		try {
			serverMetadata = await this.fetchServerMetadata(origin, signal);
		} catch (error) {
			if (isCancellationError(error)) {
				throw error;
			}
			this.log('warn', `no authorization server metadata at ${origin}; using the 2025-03-26 default endpoints`);
			// There is no document to consult for PKCE support; the defaults are a
			// synthesized document and the authorization request always carries S256.
			serverMetadata = { ...getDefaultMetadataForUrl(new URL(origin)), code_challenge_methods_supported: ['S256'] };
			legacyDefaults = true;
		}
		this.validateServerMetadata(serverMetadata);
		return { resource: key, challenge, authorizationServer: origin, serverMetadata, legacyDefaults };
	}

	private async discoverResourceMetadata(key: string, challengeUrl: string | undefined, signal: AbortSignal): Promise<{ metadata: IAuthorizationProtectedResourceMetadata; url: string } | undefined> {
		const target = new URL(key);
		const originResource = canonicalResourceUri(target.origin);
		const rootUrl = `${target.origin}${AUTH_PROTECTED_RESOURCE_METADATA_DISCOVERY_PATH}`;
		const candidates: IResourceMetadataCandidate[] = [];
		if (challengeUrl) {
			candidates.push({ url: challengeUrl, expected: challengeUrl === rootUrl ? [key, originResource] : [key] });
		}
		if (target.pathname !== '/') {
			candidates.push({ url: `${rootUrl}${target.pathname}`, expected: [key] });
		}
		candidates.push({ url: rootUrl, expected: [key, originResource] });

		const tried = new Set<string>();
		let mismatch: OAuthClientError | undefined;
		for (const candidate of candidates) {
			if (tried.has(candidate.url)) {
				continue;
			}
			tried.add(candidate.url);
			try {
				const metadata = await this.fetchResourceMetadataFrom(candidate, target.origin, signal);
				return { metadata, url: candidate.url };
			} catch (error) {
				if (isCancellationError(error) || signal.aborted) {
					throw new CancellationError();
				}
				if (error instanceof OAuthClientError && error.code === 'resource_mismatch') {
					mismatch ??= error;
				}
				this.log('info', `protected resource metadata unavailable at ${candidate.url}: ${errorMessage(error)}`);
			}
		}
		if (mismatch) {
			throw mismatch;
		}
		return undefined;
	}

	private async fetchResourceMetadataFrom(candidate: IResourceMetadataCandidate, targetOrigin: string, signal: AbortSignal): Promise<IAuthorizationProtectedResourceMetadata> {
		const sameOrigin = new URL(candidate.url).origin === targetOrigin;
		const headers: Record<string, string> = { Accept: 'application/json', ...(sameOrigin ? this.options.sameOriginHeaders ?? {} : {}) };
		const response = await this.fetch(candidate.url, { method: 'GET', headers, signal });
		if (response.status !== 200) {
			throw new Error(`HTTP ${response.status}`);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error('the response is not JSON');
		}
		if (!isAuthorizationProtectedResourceMetadata(body)) {
			throw new Error('the response is not protected resource metadata');
		}
		let actual: string;
		try {
			actual = canonicalResourceUri(body.resource);
		} catch {
			throw new Error(`the resource '${body.resource}' is not a URL`);
		}
		if (!candidate.expected.includes(actual)) {
			throw new OAuthClientError('resource_mismatch', `The protected resource metadata at ${candidate.url} names resource '${body.resource}', expected ${candidate.expected.map(e => `'${e}'`).join(' or ')} (RFC 9728 section 3.3)`, { url: candidate.url, actual, expected: candidate.expected });
		}
		return body;
	}

	private async fetchServerMetadata(authorizationServer: string, signal: AbortSignal): Promise<IAuthorizationServerMetadata> {
		try {
			const { metadata } = await fetchAuthorizationServerMetadata(authorizationServer, { fetch: this.metadataFetcher(signal), validateIssuer: true, issuerTolerance: 'exact' });
			return metadata;
		} catch (error) {
			if (isCancellationError(error) || signal.aborted) {
				throw new CancellationError();
			}
			const errors: unknown[] = error instanceof AggregateError ? error.errors : [error];
			const mismatch = errors.find((e): e is OAuthIssuerMismatchError => e instanceof OAuthIssuerMismatchError);
			if (mismatch) {
				throw mismatch;
			}
			throw new OAuthClientError('discovery_failed', `Authorization server metadata for ${authorizationServer} could not be retrieved: ${errors.map(errorMessage).join('; ')}`, errors);
		}
	}

	/**
	 * The token endpoint is used by every grant and the authorization endpoint
	 * by the authorization code grant, so they are checked here (a machine
	 * client's grant needs no authorization endpoint and no PKCE). The
	 * registration endpoint is not: it is used only when a client registers
	 * dynamically, and a client that is pre-registered or uses a Client ID
	 * Metadata Document never contacts it, so it is checked where it is used
	 * (here {@link selectRegistration}; the extension host's dynamic
	 * authentication providers check it before they register). The same holds
	 * for the device authorization endpoint, which only the extension host's
	 * device code flow uses: it checks it, by the same rule, before its first
	 * request.
	 */
	private validateServerMetadata(metadata: IAuthorizationServerMetadata): void {
		if (this.grant.kind !== 'authorization_code') {
			if (!metadata.token_endpoint) {
				throw new OAuthClientError('discovery_failed', `The authorization server ${metadata.issuer} does not publish a token endpoint`);
			}
			this.assertSecureEndpoint(metadata.token_endpoint, 'token endpoint');
			return;
		}
		if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
			throw new OAuthClientError('discovery_failed', `The authorization server ${metadata.issuer} does not publish an authorization and a token endpoint`);
		}
		this.assertSecureEndpoint(metadata.authorization_endpoint, 'authorization endpoint');
		this.assertSecureEndpoint(metadata.token_endpoint, 'token endpoint');
		if (this.options.pkce !== 'assume-supported' && !pkceSupported(metadata)) {
			throw new OAuthClientError('pkce_unsupported', `The authorization server ${metadata.issuer} does not advertise the S256 PKCE method in code_challenge_methods_supported`);
		}
	}

	private get grant(): OAuthGrant {
		return this.options.grant ?? AUTHORIZATION_CODE_GRANT;
	}

	/**
	 * The prover of a token request that asks for a DPoP-bound token: the
	 * configured one, when the authorization server advertises its algorithm.
	 */
	private dpopFor(serverMetadata: IAuthorizationServerMetadata, wanted: boolean | undefined): IOAuthDpopProver | undefined {
		const prover = this.options.dpop;
		return wanted && prover && authorizationServerSupportsDpop(serverMetadata, prover.algorithm) ? prover : undefined;
	}

	private assertSecureEndpoint(url: string, what: string): void {
		assertSecureOAuthEndpoint(url, what, this.options.allowInsecureHttp);
	}

	private metadataFetcher(signal: AbortSignal): NonNullable<IFetchAuthorizationServerMetadataOptions['fetch']> {
		return async (url, init) => {
			const response = await this.fetch(url, { method: init.method, headers: init.headers, signal });
			return { status: response.status, statusText: response.statusText ?? '', json: () => response.json(), text: () => response.text() };
		};
	}

	private registrationFetcher(signal: AbortSignal): typeof fetch {
		const fetchImpl = this.fetch;
		const adapted = async (input: string | { toString(): string }, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
			const response = await fetchImpl(String(input), { method: init?.method, headers: init?.headers, body: init?.body, signal });
			return { ok: response.status >= 200 && response.status < 300, status: response.status, json: () => response.json(), text: () => response.text() };
		};
		return adapted as unknown as typeof fetch;
	}

	//#endregion

	//#region tokens

	/**
	 * Returns a usable access token for the resource: the stored one when it
	 * is valid, covers the scopes and was not rejected; otherwise a refreshed
	 * one; otherwise a new authorization code grant with the registration
	 * selected per the specification's priority order.
	 */
	async acquireToken(request: IOAuthAcquireTokenRequest, token: CancellationToken = CancellationToken.None): Promise<IOAuthAuthorization> {
		const key = canonicalResourceUri(request.resource);
		const resourceIndicator = resourceIndicatorFor(key, request.resourceMetadata?.resource);
		const { serverMetadata } = request;
		let record = await this.reconcileDpopKey(key, await this.reconcileIssuer(key, await this.storage.get(key), serverMetadata.issuer));
		const grant = this.grant;
		const scopes = selectScopes({
			challengeScope: request.scopes?.join(' '),
			prmScopes: request.resourceMetadata?.scopes_supported,
			// A machine client's grant has no user to keep signed in.
			requestOfflineAccess: grant.kind === 'authorization_code' && this.options.requestOfflineAccess,
			scopesSupported: serverMetadata.scopes_supported,
		});

		if (grant.kind !== 'authorization_code') {
			return this.acquireMachineToken(grant, key, resourceIndicator, request, record, scopes, token);
		}

		if (record && !request.forceNewRegistration) {
			if (record.accessToken && record.accessToken !== request.rejectedToken && !this.isExpired(record) && this.scopesCovered(scopes, record.scopes, true)) {
				return this.toAuthorization(record);
			}
			// A refresh never widens the grant, so it only helps when the scopes are known to be held.
			if (record.refreshToken && this.scopesCovered(scopes, record.scopes, false)) {
				try {
					const refreshed = await this.refresh({ serverMetadata, resource: key, resourceIndicator, registration: this.registrationOf(record), refreshToken: record.refreshToken, scopes: record.scopes, dpop: request.dpop || record.dpopThumbprint !== undefined }, token);
					record = await this.persist(key, { ...record, ...refreshed });
					return this.toAuthorization(record);
				} catch (error) {
					if (isCancellationError(error)) {
						throw error;
					}
					this.log('warn', `refreshing the token for ${key} failed, re-authorizing: ${errorMessage(error)}`);
				}
			}
		}

		let registration: IOAuthRegistration | undefined = record && !request.forceNewRegistration ? this.registrationOf(record) : undefined;
		let fromRecord = registration !== undefined;
		let excludeCimd = false;
		for (let attempt = 0; ; attempt++) {
			if (!registration) {
				registration = await this.selectRegistration(serverMetadata, scopes, excludeCimd, token);
				fromRecord = false;
			}
			try {
				const result = await this.authorizationCodeGrant({ serverMetadata, resource: key, resourceIndicator, registration, scopes, dpop: request.dpop }, token);
				record = await this.persist(key, {
					issuer: serverMetadata.issuer,
					registrationKind: registration.kind,
					clientId: registration.clientId,
					clientSecret: registration.clientSecret,
					tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
					...result,
					authorizationRequests: this.authorizationRequests.get(key) ?? 0,
				});
				return this.toAuthorization(record);
			} catch (error) {
				const canRetry = attempt === 0 && isInvalidClientError(error) && (registration.kind === 'cimd' || (fromRecord && registration.kind === 'dcr'));
				if (!canRetry) {
					throw error;
				}
				if (registration.kind === 'cimd') {
					// The server advertised Client ID Metadata Documents but did not accept ours:
					// the retry must pick another mechanism and the record will remember that.
					excludeCimd = true;
					if (!this.canRegisterWithout(serverMetadata)) {
						throw error;
					}
					this.log('warn', `the authorization server ${serverMetadata.issuer} rejected the client ID metadata document client; registering another way`);
				} else {
					this.log('warn', `the authorization server ${serverMetadata.issuer} no longer accepts the stored registration; registering again`);
				}
				registration = undefined;
			}
		}
	}

	/**
	 * The token of a machine client's grant: the stored one when it is valid,
	 * covers the scopes and was not rejected; otherwise a refreshed one (a
	 * server rarely issues a refresh token for these grants); otherwise a new
	 * grant. A refused grant is terminal: the client neither retries it nor
	 * falls back to another grant (workload identity federation), and a refused
	 * assertion is not sent again.
	 */
	private async acquireMachineToken(grant: Exclude<OAuthGrant, { readonly kind: 'authorization_code' }>, key: string, resourceIndicator: string, request: IOAuthAcquireTokenRequest, record: IOAuthClientRecord | undefined, scopes: string[] | undefined, token: CancellationToken): Promise<IOAuthAuthorization> {
		const { serverMetadata } = request;
		if (record?.accessToken && record.accessToken !== request.rejectedToken && !this.isExpired(record) && this.scopesCovered(scopes, record.scopes, true)) {
			return this.toAuthorization(record);
		}
		const registration = machineRegistration(grant.kind === 'client_credentials' ? grant.credentials : grant.client, serverMetadata);
		if (record?.refreshToken && this.scopesCovered(scopes, record.scopes, false)) {
			try {
				const refreshed = await this.refresh({ serverMetadata, resource: key, resourceIndicator, registration, refreshToken: record.refreshToken, scopes: record.scopes, dpop: request.dpop || record.dpopThumbprint !== undefined }, token);
				return this.toAuthorization(await this.persist(key, { ...record, ...refreshed }));
			} catch (error) {
				if (isCancellationError(error)) {
					throw error;
				}
				this.log('warn', `refreshing the token for ${key} failed, requesting a new one: ${errorMessage(error)}`);
			}
		}
		let result: IOAuthTokenResult;
		if (grant.kind === 'client_credentials') {
			result = await this.clientCredentialsGrant({ serverMetadata, resource: key, resourceIndicator, credentials: grant.credentials, scopes, dpop: request.dpop }, token);
		} else {
			const assertion = await raceCancellationError(grant.assertion({ serverMetadata, resource: resourceIndicator, scopes }, token), token);
			if (this.refusedAssertions.get(key) === assertion) {
				throw new OAuthClientError('token_request_failed', `Not presenting the assertion the authorization server ${serverMetadata.issuer} refused for ${key} again`);
			}
			try {
				result = await this.jwtBearerGrant({ serverMetadata, resource: key, resourceIndicator, assertion, registration, scopes, dpop: request.dpop }, token);
			} catch (error) {
				if (error instanceof OAuthClientError && error.code === 'token_request_failed') {
					this.refusedAssertions.set(key, assertion);
				}
				throw error;
			}
		}
		const stored = await this.persist(key, {
			issuer: serverMetadata.issuer,
			registrationKind: 'pre-registered',
			clientId: registration?.clientId ?? '',
			tokenEndpointAuthMethod: registration?.tokenEndpointAuthMethod ?? 'none',
			...result,
			authorizationRequests: this.authorizationRequests.get(key) ?? 0,
		});
		return this.toAuthorization(stored);
	}

	/**
	 * The client credentials grant (OAuth 2.1 section 4.2) of the
	 * `io.modelcontextprotocol/oauth-client-credentials` extension: a
	 * pre-registered client authenticates with `private_key_jwt` or its secret
	 * and asks for a token for the resource (RFC 8707). The server must list
	 * `client_credentials` in `grant_types_supported` when it lists grants.
	 */
	async clientCredentialsGrant(request: IOAuthClientCredentialsGrantRequest, token: CancellationToken = CancellationToken.None): Promise<IOAuthTokenResult> {
		const key = canonicalResourceUri(request.resource);
		const { serverMetadata } = request;
		this.validateMachineGrant(serverMetadata, 'client_credentials');
		const registration = machineRegistration(request.credentials, serverMetadata)!;
		const store = new DisposableStore();
		try {
			const signal = CancellationToken.toAbortSignal(token, store);
			this.log('info', `client credentials grant for ${key} at ${serverMetadata.issuer} (${registration.assertionKey ? 'private_key_jwt' : registration.tokenEndpointAuthMethod}, scope: ${request.scopes?.join(' ') ?? 'omitted'})`);
			const params: Record<string, string> = { grant_type: 'client_credentials', resource: request.resourceIndicator ?? resourceIndicatorFor(key) };
			if (request.scopes && request.scopes.length > 0) {
				params.scope = request.scopes.join(' ');
			}
			return await this.tokenRequest(serverMetadata, registration, params, request.scopes, this.dpopFor(serverMetadata, request.dpop), signal);
		} finally {
			store.dispose();
		}
	}

	/**
	 * The JWT authorization grant (RFC 7523 section 2.1): the assertion (a
	 * workload identity JWT, or an ID-JAG) is the grant, and the client
	 * authenticates only when `registration` is given. The server must list
	 * the grant type in `grant_types_supported` when it lists grants.
	 */
	async jwtBearerGrant(request: IOAuthJwtBearerGrantRequest, token: CancellationToken = CancellationToken.None): Promise<IOAuthTokenResult> {
		const key = canonicalResourceUri(request.resource);
		const { serverMetadata } = request;
		this.validateMachineGrant(serverMetadata, GRANT_TYPE_JWT_BEARER);
		const store = new DisposableStore();
		try {
			const signal = CancellationToken.toAbortSignal(token, store);
			this.log('info', `JWT authorization grant for ${key} at ${serverMetadata.issuer} (${request.registration ? `client ${request.registration.clientId}` : 'no client'}, scope: ${request.scopes?.join(' ') ?? 'omitted'})`);
			const params: Record<string, string> = { grant_type: GRANT_TYPE_JWT_BEARER, assertion: request.assertion, resource: request.resourceIndicator ?? resourceIndicatorFor(key) };
			if (request.scopes && request.scopes.length > 0) {
				params.scope = request.scopes.join(' ');
			}
			return await this.tokenRequest(serverMetadata, request.registration, params, request.scopes, this.dpopFor(serverMetadata, request.dpop), signal);
		} finally {
			store.dispose();
		}
	}

	private validateMachineGrant(serverMetadata: IAuthorizationServerMetadata, grantType: string): void {
		if (!serverMetadata.token_endpoint) {
			throw new OAuthClientError('discovery_failed', `The authorization server ${serverMetadata.issuer} does not publish a token endpoint`);
		}
		this.assertSecureEndpoint(serverMetadata.token_endpoint, 'token endpoint');
		const supported = serverMetadata.grant_types_supported;
		if (supported && supported.length > 0 && !supported.includes(grantType)) {
			throw new OAuthClientError('grant_unsupported', `The authorization server ${serverMetadata.issuer} does not support the ${grantType} grant (grant_types_supported: ${supported.join(' ')})`);
		}
	}

	/**
	 * Runs the authorization code grant with PKCE `S256`, the RFC 8707
	 * `resource` indicator and `state`, validates the redirect (RFC 9207 `iss`
	 * first, then `state`, then `error`) and redeems the code. Counts towards
	 * the per-resource authorization request limit.
	 */
	async authorizationCodeGrant(request: IOAuthAuthorizationCodeGrantRequest, token: CancellationToken = CancellationToken.None): Promise<IOAuthTokenResult> {
		const key = canonicalResourceUri(request.resource);
		const resourceIndicator = request.resourceIndicator ?? resourceIndicatorFor(key);
		const { serverMetadata, registration } = request;
		this.validateServerMetadata(serverMetadata);
		const authorizationEndpoint = serverMetadata.authorization_endpoint!;

		const made = this.authorizationRequests.get(key) ?? 0;
		if (made >= this.maxAuthorizationRequests) {
			throw new OAuthClientError('step_up_limit', `Not authorizing ${key} again: ${made} authorization requests were already made`);
		}
		this.authorizationRequests.set(key, made + 1);

		const store = new DisposableStore();
		try {
			const signal = CancellationToken.toAbortSignal(token, store);
			const pkce = await createPkcePair(this.random, this.sha256);
			const state = encodeRandomBase64Url(this.random(16));
			const redirectUri = this.options.redirectUris[0];
			const url = new URL(authorizationEndpoint);
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('client_id', registration.clientId);
			url.searchParams.set('redirect_uri', redirectUri);
			url.searchParams.set('code_challenge', pkce.challenge);
			url.searchParams.set('code_challenge_method', 'S256');
			url.searchParams.set('state', state);
			url.searchParams.set('resource', resourceIndicator);
			if (request.scopes && request.scopes.length > 0) {
				url.searchParams.set('scope', request.scopes.join(' '));
			}
			const prover = this.dpopFor(serverMetadata, request.dpop);
			if (prover) {
				// Binds the code to the key the token request proves possession of (RFC 9449 section 10).
				url.searchParams.set('dpop_jkt', prover.thumbprint);
			}
			this.lastRequestedScopes.set(key, request.scopes ?? []);
			this.log('info', `authorization request ${made + 1} for ${key} at ${serverMetadata.issuer} (${registration.kind} client, scope: ${request.scopes?.join(' ') ?? 'omitted'})`);

			// The strategy should observe the token itself; the race keeps the client from waiting on one that does not.
			const result = await raceCancellationError(this.options.authorize({
				authorizationUrl: url.toString(),
				state,
				redirectUri,
				expectedIssuer: serverMetadata.issuer,
				issParameterSupported: serverMetadata.authorization_response_iss_parameter_supported === true,
			}, token), token);
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			const params: IAuthorizationRedirectParams = isRedirectQuery(result) ? parseAuthorizationRedirect(result.query) : { code: result.code, state: result.state, iss: result.iss };

			// RFC 9207: the issuer is validated before anything else in the response is acted on.
			const issError = validateIssuerParameter(serverMetadata.authorization_response_iss_parameter_supported, params.iss, serverMetadata.issuer);
			if (issError) {
				throw issError;
			}
			if (params.state !== state) {
				throw new OAuthClientError('state_mismatch', 'The authorization response does not carry the state of the request');
			}
			if (params.error) {
				throw new OAuthClientError('authorization_denied', `The authorization server denied the request: ${params.error}${params.errorDescription ? ` (${params.errorDescription})` : ''}`, { error: params.error, errorDescription: params.errorDescription, errorUri: params.errorUri });
			}
			if (!params.code) {
				throw new OAuthClientError('authorization_denied', 'The authorization response carries no code');
			}

			return this.tokenRequest(serverMetadata, registration, {
				grant_type: 'authorization_code',
				code: params.code,
				redirect_uri: redirectUri,
				code_verifier: pkce.verifier,
				resource: resourceIndicator,
			}, request.scopes, prover, signal);
		} finally {
			store.dispose();
		}
	}

	/** Redeems a refresh token; the previous refresh token is kept when the server does not rotate it. */
	async refresh(request: IOAuthRefreshRequest, token: CancellationToken = CancellationToken.None): Promise<IOAuthTokenResult> {
		const key = canonicalResourceUri(request.resource);
		const tokenEndpoint = request.serverMetadata.token_endpoint;
		if (!tokenEndpoint) {
			throw new OAuthClientError('discovery_failed', `The authorization server ${request.serverMetadata.issuer} does not publish a token endpoint`);
		}
		this.assertSecureEndpoint(tokenEndpoint, 'token endpoint');
		const store = new DisposableStore();
		try {
			const signal = CancellationToken.toAbortSignal(token, store);
			this.log('info', `refreshing the token for ${key} at ${request.serverMetadata.issuer}`);
			const result = await this.tokenRequest(request.serverMetadata, request.registration, { grant_type: 'refresh_token', refresh_token: request.refreshToken, resource: request.resourceIndicator ?? resourceIndicatorFor(key) }, request.scopes, this.dpopFor(request.serverMetadata, request.dpop), signal);
			return { ...result, refreshToken: result.refreshToken ?? request.refreshToken };
		} finally {
			store.dispose();
		}
	}

	/**
	 * Sends a token request with the client's authentication (none without a
	 * registration) and, to an authorization server that supports DPoP, a
	 * proof. A `use_dpop_nonce` error is answered once with a proof that
	 * carries the server's nonce (RFC 9449 section 8). A `DPoP` token is
	 * accepted only when the request carried a proof.
	 */
	private async tokenRequest(serverMetadata: IAuthorizationServerMetadata, registration: IOAuthRegistration | undefined, params: Record<string, string>, requestedScopes: readonly string[] | undefined, prover: IOAuthDpopProver | undefined, signal: AbortSignal): Promise<IOAuthTokenResult> {
		const tokenEndpoint = serverMetadata.token_endpoint!;
		for (let attempt = 0; ; attempt++) {
			// A fresh client assertion and proof for each attempt: servers may refuse a `jti` they saw.
			const auth = await this.clientAuthentication(serverMetadata, registration);
			const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', ...auth.headers };
			if (prover) {
				headers[DPOP_HEADER] = await prover.createProof('POST', tokenEndpoint);
			}
			const response = await this.fetch(tokenEndpoint, {
				method: 'POST',
				headers,
				body: new URLSearchParams({ ...params, ...auth.body }).toString(),
				signal,
				// The body carries the client's credentials or assertion: a redirect would send them elsewhere.
				redirect: 'manual',
			});
			const nonce = response.headers.get(DPOP_NONCE_HEADER) ?? undefined;
			if (prover && nonce !== undefined) {
				prover.rememberNonce(tokenEndpoint, nonce);
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (response.status === 200 && isAuthorizationTokenResponse(payload)) {
				if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
					throw new OAuthClientError('token_request_failed', `The token endpoint ${tokenEndpoint} issued no usable access token`);
				}
				const dpopBound = prover !== undefined && isDpopTokenType(payload.token_type);
				if (!dpopBound && (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer')) {
					throw new OAuthClientError('token_request_failed', `The token endpoint ${tokenEndpoint} issued an unsupported token type '${String(payload.token_type)}'`);
				}
				if (prover && !dpopBound) {
					this.log('info', `the token endpoint ${tokenEndpoint} issued a bearer token for a request with a DPoP proof`);
				}
				return {
					accessToken: payload.access_token,
					refreshToken: payload.refresh_token,
					expiresAt: typeof payload.expires_in === 'number' ? this.now() + payload.expires_in * 1000 : undefined,
					scopes: payload.scope ? splitScopes(payload.scope) : requestedScopes,
					tokenType: dpopBound ? 'DPoP' : 'Bearer',
					dpopThumbprint: prover?.thumbprint,
				};
			}
			const failure = isAuthorizationErrorResponse(payload) ? payload : undefined;
			if (prover && attempt === 0 && failure?.error === USE_DPOP_NONCE_ERROR && nonce !== undefined) {
				this.log('info', `the token endpoint ${tokenEndpoint} asked for a DPoP nonce; sending the request again`);
				continue;
			}
			const description = failure ? `${failure.error}${failure.error_description ? ` (${failure.error_description})` : ''}` : 'no error details';
			this.log('warn', `token request to ${tokenEndpoint} failed with HTTP ${response.status}: ${description}`);
			throw new OAuthClientError('token_request_failed', `The token request to ${tokenEndpoint} failed with HTTP ${response.status}: ${description}`, { status: response.status, error: failure?.error, errorDescription: failure?.error_description });
		}
	}

	/**
	 * The client authentication of a token request (RFC 6749 section 2.3): the
	 * registration's method, or a client assertion for `private_key_jwt`
	 * (RFC 7523 section 2.2) whose `iss` and `sub` are the client id and whose
	 * `aud` is the issuer identifier (or the token endpoint, as configured); it then names the client by the assertion
	 * alone (the client credentials extension omits `client_id`). Nothing
	 * without a registration.
	 */
	private async clientAuthentication(serverMetadata: IAuthorizationServerMetadata, registration: IOAuthRegistration | undefined): Promise<{ headers: Record<string, string>; body: Record<string, string> }> {
		if (!registration) {
			return { headers: {}, body: {} };
		}
		if (!registration.assertionKey) {
			return buildClientAuthentication(registration.tokenEndpointAuthMethod, registration.clientId, registration.clientSecret);
		}
		const { key, keyId, audience } = registration.assertionKey;
		const methods = serverMetadata.token_endpoint_auth_methods_supported;
		if (methods && methods.length > 0 && !methods.includes('private_key_jwt')) {
			throw new OAuthClientError('grant_unsupported', `The authorization server ${serverMetadata.issuer} does not support private_key_jwt client authentication (token_endpoint_auth_methods_supported: ${methods.join(' ')})`);
		}
		const algorithms = serverMetadata.token_endpoint_auth_signing_alg_values_supported;
		if (algorithms && algorithms.length > 0 && !algorithms.includes(key.algorithm)) {
			throw new OAuthClientError('grant_unsupported', `The authorization server ${serverMetadata.issuer} does not accept ${key.algorithm} client assertions (token_endpoint_auth_signing_alg_values_supported: ${algorithms.join(' ')})`);
		}
		const issuedAt = Math.floor(this.now() / 1000);
		const assertion = await signJwt(key, keyId !== undefined ? { typ: 'JWT', kid: keyId } : { typ: 'JWT' }, {
			iss: registration.clientId,
			sub: registration.clientId,
			aud: audience === 'token_endpoint' ? serverMetadata.token_endpoint! : serverMetadata.issuer,
			iat: issuedAt,
			exp: issuedAt + CLIENT_ASSERTION_LIFETIME_SECONDS,
			jti: base64UrlEncode(this.random(16)),
		});
		return { headers: {}, body: { client_assertion_type: CLIENT_ASSERTION_TYPE_JWT_BEARER, client_assertion: assertion } };
	}

	//#endregion

	//#region registration

	private async selectRegistration(serverMetadata: IAuthorizationServerMetadata, scopes: readonly string[] | undefined, excludeCimd: boolean, token: CancellationToken): Promise<IOAuthRegistration> {
		const { preRegistered, clientMetadataUrl, dynamic, prompt } = this.options.registration;
		const supported = serverMetadata.token_endpoint_auth_methods_supported;
		if (preRegistered) {
			if (preRegistered.issuer !== undefined && preRegistered.issuer !== serverMetadata.issuer) {
				throw new OAuthClientError('issuer_not_registered', `The pre-registered client belongs to ${preRegistered.issuer}, but the resource names ${serverMetadata.issuer} as its authorization server`);
			}
			return { kind: 'pre-registered', clientId: preRegistered.clientId, clientSecret: preRegistered.clientSecret, tokenEndpointAuthMethod: selectTokenEndpointAuthMethod(undefined, supported, preRegistered.clientSecret !== undefined) };
		}
		if (clientMetadataUrl !== undefined && !excludeCimd && serverMetadata.client_id_metadata_document_supported === true) {
			if (!isValidClientMetadataUrl(clientMetadataUrl)) {
				throw new OAuthClientError('invalid_client_metadata_url', `The client metadata URL '${clientMetadataUrl}' must be an HTTPS URL with a path and without a fragment`);
			}
			return { kind: 'cimd', clientId: clientMetadataUrl, tokenEndpointAuthMethod: 'none' };
		}
		const registrationEndpoint = dynamic !== false ? serverMetadata.registration_endpoint : undefined;
		if (registrationEndpoint && !isSecureOAuthEndpoint(registrationEndpoint, this.options.allowInsecureHttp)) {
			// As the extension host's providers do: a registration endpoint the client may not post its
			// metadata to is skipped for the configured prompt; without one it is an `insecure_endpoint` error.
			if (!prompt) {
				this.assertSecureEndpoint(registrationEndpoint, 'registration endpoint');
			}
			this.log('warn', `the registration endpoint ${registrationEndpoint} is not served over HTTPS, asking for credentials`);
		} else if (registrationEndpoint) {
			const store = new DisposableStore();
			try {
				const signal = CancellationToken.toAbortSignal(token, store);
				const method = selectRegistrationAuthMethod(supported);
				const response = await fetchDynamicRegistration(serverMetadata, this.options.clientName, scopes ? [...scopes] : undefined, {
					tokenEndpointAuthMethod: method,
					redirectUris: this.options.redirectUris,
					clientUri: this.options.clientUri,
					fetch: this.registrationFetcher(signal),
				});
				this.log('info', `registered dynamically with ${serverMetadata.issuer}`);
				return {
					kind: 'dcr',
					clientId: response.client_id,
					clientSecret: response.client_secret,
					tokenEndpointAuthMethod: selectTokenEndpointAuthMethod(response.token_endpoint_auth_method, supported, response.client_secret !== undefined),
				};
			} catch (error) {
				if (isCancellationError(error) || token.isCancellationRequested) {
					throw new CancellationError();
				}
				if (!prompt) {
					throw new OAuthClientError('registration_failed', `Dynamic client registration with ${serverMetadata.issuer} failed: ${errorMessage(error)}`, error);
				}
				this.log('warn', `dynamic client registration with ${serverMetadata.issuer} failed, asking for credentials: ${errorMessage(error)}`);
			} finally {
				store.dispose();
			}
		}
		if (prompt) {
			const entered = await prompt();
			if (!entered) {
				throw new OAuthClientError('registration_failed', `No client credentials were provided for ${serverMetadata.issuer}`);
			}
			return { kind: 'prompt', clientId: entered.clientId, clientSecret: entered.clientSecret, tokenEndpointAuthMethod: selectTokenEndpointAuthMethod(undefined, supported, entered.clientSecret !== undefined) };
		}
		throw new OAuthClientError('registration_failed', `No client registration mechanism is available for ${serverMetadata.issuer}`);
	}

	private canRegisterWithout(serverMetadata: IAuthorizationServerMetadata): boolean {
		return (!!serverMetadata.registration_endpoint && this.options.registration.dynamic !== false) || !!this.options.registration.prompt;
	}

	//#endregion

	//#region challenges

	/**
	 * Handles a `WWW-Authenticate` challenge for a resource: discovery, then
	 * (in this order) forgetting a record bound to another issuer, refreshing,
	 * or re-authorizing. `insufficient_scope` steps up (never by refreshing)
	 * with the union of the granted, previously requested and demanded scopes.
	 * A rejected token is forgotten and replaced (by a refresh when possible);
	 * when the token issued in response is rejected as well, the second
	 * consecutive rejection drops the refresh token and registers the client
	 * anew.
	 */
	async handleChallenge(resource: string, wwwAuthenticate: string | undefined, options: IOAuthHandleChallengeOptions = {}, token: CancellationToken = CancellationToken.None): Promise<IOAuthAuthorization> {
		const key = canonicalResourceUri(resource);
		const discovery = await this.discover(key, wwwAuthenticate, token);
		const { serverMetadata, resourceMetadata, challenge } = discovery;
		let record = await this.reconcileIssuer(key, await this.storage.get(key), serverMetadata.issuer);
		const held = unique([...(record?.scopes ?? []), ...(options.scopes ?? [])]);
		const dpop = resourceRequiresDpop(wwwAuthenticate, resourceMetadata);

		if (challenge?.error === 'insufficient_scope') {
			// The union of the previously granted and requested scopes with the challenged ones (SEP-2350).
			const requested = this.lastRequestedScopes.get(key);
			const union = unique([...held, ...(requested ?? []), ...splitScopes(challenge.scope)]);
			const rejected = options.previousToken ?? record?.accessToken;
			if (rejected !== undefined && record?.accessToken === rejected && requested && union.every(scope => requested.includes(scope))) {
				throw new OAuthClientError('step_up_limit', `The resource ${key} still reports insufficient scope after a token was issued for every scope it demands (${union.join(' ')})`);
			}
			this.log('info', `stepping up ${key} to scope '${union.join(' ')}'`);
			const authorization = await this.acquireToken({ serverMetadata, resourceMetadata, resource: key, scopes: union, rejectedToken: rejected, dpop }, token);
			this.rejections.set(key, { issued: authorization.accessToken, count: 0 });
			return authorization;
		}

		let count = 0;
		let forceNewRegistration = false;
		const rejected = options.previousToken;
		if (rejected !== undefined && record && record.accessToken === rejected) {
			const streak = this.rejections.get(key);
			count = (streak?.issued === rejected ? streak.count : 0) + 1;
			forceNewRegistration = count >= 2;
			this.log('warn', `the resource ${key} rejected its access token (${count} in a row)${forceNewRegistration ? '; registering the client again' : ''}`);
			record = await this.persist(key, { ...record, accessToken: undefined, expiresAt: undefined, refreshToken: forceNewRegistration ? undefined : record.refreshToken });
		}
		const scopes = unique([...held, ...splitScopes(challenge?.scope)]);
		const authorization = await this.acquireToken({ serverMetadata, resourceMetadata, resource: key, scopes: scopes.length > 0 ? scopes : undefined, rejectedToken: rejected, forceNewRegistration, dpop }, token);
		this.rejections.set(key, { issued: authorization.accessToken, count });
		return authorization;
	}

	/**
	 * Sends a request with the resource's access token, handling up to
	 * {@link IOAuthClientOptions.maxChallengesPerRequest} challenges by
	 * (re-)authorizing, and returns the final response. A DPoP-bound token
	 * goes with the `DPoP` scheme and a fresh proof for each attempt (RFC 9449
	 * section 7.1); a `use_dpop_nonce` challenge is answered with a proof that
	 * carries the resource server's nonce (section 9), within the same limit.
	 */
	async fetchWithAuth(resource: string, url: string, init: IOAuthFetchInit = {}, token: CancellationToken = CancellationToken.None): Promise<IOAuthFetchResponse> {
		const key = canonicalResourceUri(resource);
		const store = new DisposableStore();
		try {
			const signal = init.signal ?? CancellationToken.toAbortSignal(token, store);
			let authorization: IOAuthTokenResult | undefined = await this.getAuthorization(key);
			for (let challenges = 0; ; challenges++) {
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(init.headers ?? {})) {
					const lower = name.toLowerCase();
					if (lower !== 'authorization' && lower !== DPOP_HEADER.toLowerCase()) {
						headers[name] = value;
					}
				}
				const accessToken = authorization?.accessToken;
				const prover = authorization?.tokenType === 'DPoP' ? this.options.dpop : undefined;
				if (accessToken && prover) {
					headers.Authorization = `${DPOP_SCHEME} ${accessToken}`;
					headers[DPOP_HEADER] = await prover.createProof(init.method ?? 'GET', url, accessToken);
				} else if (accessToken) {
					headers.Authorization = `Bearer ${accessToken}`;
				}
				if (token.isCancellationRequested) {
					throw new CancellationError();
				}
				let response: IOAuthFetchResponse;
				try {
					response = await this.fetch(url, { ...init, headers, signal });
				} catch (error) {
					throw token.isCancellationRequested ? new CancellationError() : error;
				}
				const nonce = response.headers.get(DPOP_NONCE_HEADER) ?? undefined;
				if (prover && nonce !== undefined) {
					prover.rememberNonce(url, nonce);
				}
				const header = response.headers.get('WWW-Authenticate') ?? undefined;
				const challenge = parseOAuthChallenge(header, prover ? 'DPoP' : 'Bearer');
				const challenged = response.status === 401
					? (challenge !== undefined || header === undefined)
					: response.status === 403 && challenge?.error === 'insufficient_scope';
				if (!challenged) {
					if (accessToken && response.status < 400) {
						this.rejections.delete(key);
					}
					return response;
				}
				if (challenges >= this.maxChallengesPerRequest) {
					throw new OAuthClientError('challenge_limit', `The resource ${key} kept challenging after ${challenges} authorization attempts`);
				}
				if (prover && response.status === 401 && challenge?.error === USE_DPOP_NONCE_ERROR && nonce !== undefined) {
					// The token stands: only the proof lacked the nonce.
					this.log('info', `the resource ${key} asked for a DPoP nonce; sending the request again`);
					continue;
				}
				authorization = await this.handleChallenge(key, header, { previousToken: accessToken }, token);
			}
		} finally {
			store.dispose();
		}
	}

	//#endregion

	//#region records

	/** The stored, unexpired access token for a resource that this client can present, without any network activity. */
	async getAuthorization(resource: string): Promise<IOAuthAuthorization | undefined> {
		const record = await this.storage.get(canonicalResourceUri(resource));
		return record?.accessToken && !this.isExpired(record) && this.holdsDpopKeyOf(record) ? this.toAuthorization(record) : undefined;
	}

	/** Whether the tokens of a record were requested with this client's DPoP key, or without any. */
	private holdsDpopKeyOf(record: IOAuthClientRecord): boolean {
		return record.dpopThumbprint === undefined || record.dpopThumbprint === this.options.dpop?.thumbprint;
	}

	/** Drops the tokens of a record that were requested with another DPoP key: only that key can use them. */
	private async reconcileDpopKey(key: string, record: IOAuthClientRecord | undefined): Promise<IOAuthClientRecord | undefined> {
		if (!record || this.holdsDpopKeyOf(record)) {
			return record;
		}
		this.log('info', `the stored tokens for ${key} are bound to another DPoP key; forgetting them`);
		return this.persist(key, { ...record, accessToken: undefined, refreshToken: undefined, expiresAt: undefined, tokenType: undefined, dpopThumbprint: undefined });
	}

	/** Drops the registration and tokens stored for a resource. */
	async forget(resource: string): Promise<void> {
		const key = canonicalResourceUri(resource);
		await this.storage.delete(key);
		this._onDidChangeRecord.fire({ resource: key, record: undefined });
	}

	/** Drops a record whose issuer no longer matches; pre-registered credentials bound to another issuer are an error instead. */
	private async reconcileIssuer(key: string, record: IOAuthClientRecord | undefined, issuer: string): Promise<IOAuthClientRecord | undefined> {
		if (!record || record.issuer === issuer) {
			return record;
		}
		const preRegistered = this.options.registration.preRegistered;
		if (record.registrationKind === 'pre-registered' && preRegistered && (preRegistered.issuer ?? record.issuer) !== issuer) {
			throw new OAuthClientError('issuer_not_registered', `The pre-registered client for ${key} belongs to ${record.issuer}, but the resource now names ${issuer} as its authorization server`);
		}
		this.log('info', `the authorization server for ${key} changed from ${record.issuer} to ${issuer}; forgetting the stored registration and tokens`);
		await this.forget(key);
		return undefined;
	}

	private async persist(key: string, record: IOAuthClientRecord): Promise<IOAuthClientRecord> {
		const stored: IOAuthClientRecord = { ...record, authorizationRequests: this.authorizationRequests.get(key) ?? 0 };
		await this.storage.set(key, stored);
		this._onDidChangeRecord.fire({ resource: key, record: stored });
		return stored;
	}

	private toAuthorization(record: IOAuthClientRecord): IOAuthAuthorization {
		return { accessToken: record.accessToken!, refreshToken: record.refreshToken, expiresAt: record.expiresAt, scopes: record.scopes, tokenType: record.tokenType, dpopThumbprint: record.dpopThumbprint, record };
	}

	private registrationOf(record: IOAuthClientRecord): IOAuthRegistration {
		return { kind: record.registrationKind, clientId: record.clientId, clientSecret: record.clientSecret, tokenEndpointAuthMethod: record.tokenEndpointAuthMethod };
	}

	private isExpired(record: IOAuthClientRecord): boolean {
		return record.expiresAt !== undefined && record.expiresAt - this.refreshMarginMs <= this.now();
	}

	/**
	 * True when every requested scope is held. The scopes of a grant made
	 * without a `scope` parameter whose response did not echo one are unknown;
	 * they are assumed to cover only when `assumeUnknownCovers` is set.
	 */
	private scopesCovered(requested: readonly string[] | undefined, held: readonly string[] | undefined, assumeUnknownCovers: boolean): boolean {
		if (!requested || requested.length === 0) {
			return true;
		}
		if (!held) {
			return assumeUnknownCovers;
		}
		return requested.every(scope => held.includes(scope));
	}

	//#endregion

	private log(level: OAuthLogLevel, message: string): void {
		this.options.log?.(level, redact(message));
	}
}
