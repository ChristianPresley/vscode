/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../common/buffer.js';
import { IAuthorizationProtectedResourceMetadata, IAuthorizationServerMetadata, isValidClientMetadataUrl } from '../../common/oauth.js';
import { IOAuthFetch, IOAuthFetchResponse } from '../../common/oauthClient.js';

/**
 * An in-memory OAuth authorization server and protected resource behind an
 * {@link IOAuthFetch}, mirroring the client authorization fixtures of the MCP
 * conformance suite: protected resource metadata at the path-based, root or a
 * custom location, authorization server metadata at the RFC 8414 / OpenID
 * Connect locations (with or without an issuer path), Client ID Metadata
 * Document and Dynamic Client Registration clients, an authorization endpoint
 * that redirects immediately with `code`, `state` and `iss`, a token endpoint
 * with `client_secret_basic` / `client_secret_post` / `none`, PKCE `S256` and
 * `resource` verification, refresh tokens, and configurable misbehaviours.
 * Redirects are never followed; the client is expected to read `Location`.
 */

//#region router

export interface IRecordedRequest {
	readonly method: string;
	readonly url: string;
	/** Header names are lowercased. */
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly status: number;
}

export interface IFixtureRequest {
	readonly method: string;
	readonly url: URL;
	/** Header names are lowercased. */
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
	/** The body parsed as `application/x-www-form-urlencoded`. */
	form(): URLSearchParams;
	/** The body parsed as JSON. */
	json(): unknown;
}

export interface IFixtureResponse {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	/** A string is sent verbatim; anything else is JSON-encoded. */
	readonly body?: unknown;
}

export type FixtureHandler = (request: IFixtureRequest) => IFixtureResponse | undefined | Promise<IFixtureResponse | undefined>;

export interface IFixtureRouter {
	readonly fetch: IOAuthFetch;
	/** Every request that went through the router, in order. */
	readonly requests: IRecordedRequest[];
	/** Serves an origin (`https://host[:port]`); a later handler for the same origin is consulted first and falls back to the earlier one. */
	handle(origin: string, handler: FixtureHandler): void;
}

export function createFixtureRouter(): IFixtureRouter {
	const handlers = new Map<string, FixtureHandler>();
	const requests: IRecordedRequest[] = [];
	const fetch: IOAuthFetch = async (url, init) => {
		if (init.signal?.aborted) {
			throw new Error(`Request to ${url} was aborted`);
		}
		const parsed = new URL(url);
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(init.headers ?? {})) {
			headers[name.toLowerCase()] = value;
		}
		const request: IFixtureRequest = {
			method: (init.method ?? 'GET').toUpperCase(),
			url: parsed,
			headers,
			body: init.body,
			form: () => new URLSearchParams(init.body ?? ''),
			json: () => JSON.parse(init.body ?? 'null'),
		};
		const handler = handlers.get(parsed.origin);
		const result = (handler && await handler(request)) ?? { status: 404, body: { error: 'not_found', error_description: `${request.method} ${parsed.pathname} is not served` } };
		requests.push({ method: request.method, url, headers, body: init.body, status: result.status });
		return toResponse(result);
	};
	const handle = (origin: string, handler: FixtureHandler): void => {
		const previous = handlers.get(origin);
		handlers.set(origin, previous ? async request => (await handler(request)) ?? previous(request) : handler);
	};
	return { fetch, requests, handle };
}

function toResponse(result: IFixtureResponse): IOAuthFetchResponse {
	const text = result.body === undefined ? '' : typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(result.headers ?? {})) {
		headers[name.toLowerCase()] = value;
	}
	if (result.body !== undefined && typeof result.body !== 'string' && !headers['content-type']) {
		headers['content-type'] = 'application/json';
	}
	return {
		status: result.status,
		statusText: '',
		headers: { get: name => headers[name.toLowerCase()] ?? null },
		text: async () => text,
		json: async () => JSON.parse(text),
	};
}

/** Builds a `Bearer k="v", ...` challenge; parameters with an undefined value are left out. */
export function bearerChallenge(params: Record<string, string | undefined>): string {
	const parts = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([k, v]) => `${k}="${v}"`);
	return parts.length > 0 ? `Bearer ${parts.join(', ')}` : 'Bearer';
}

//#endregion

//#region authorization server

export type FixtureIssBehaviour = 'correct' | 'wrong' | 'normalized' | 'omit' | { readonly custom: string };

export interface IFixtureClient {
	readonly clientSecret?: string;
	readonly tokenEndpointAuthMethod: string;
}

export interface IOAuthAuthorizationServerFixtureOptions {
	/** The issuer identifier; may carry a path (`https://as.example.test/tenant1`). Defaults to `https://as.example.test`. */
	readonly issuer?: string;
	/** The `issuer` written into the metadata document when it should differ from the real one (attacker, trailing slash). */
	readonly advertisedIssuer?: string;
	/** Where the metadata document is served; defaults to `oauth` (RFC 8414 with path insertion). */
	readonly metadataLocation?: 'oauth' | 'oidc' | 'oidc-appended';
	/** Serve no metadata document at all (2025-03-26 endpoint fallback); defaults to true. */
	readonly serveMetadata?: boolean;
	/** Record a request to the root RFC 8414 path as a violation when the issuer has a path. */
	readonly trapRootMetadata?: boolean;
	/** Advertise the endpoints over plain `http://`. */
	readonly insecureEndpoints?: boolean;
	readonly scopesSupported?: readonly string[];
	readonly grantTypesSupported?: readonly string[];
	/** Defaults to `['none']`. */
	readonly tokenEndpointAuthMethodsSupported?: readonly string[];
	/** `null` omits the field. Defaults to `['S256']`. */
	readonly codeChallengeMethodsSupported?: readonly string[] | null;
	/** `null` omits the field. Defaults to `true`. */
	readonly issParameterSupported?: boolean | null;
	/** What `iss` the authorization redirect carries. Defaults to `correct`. */
	readonly issInRedirect?: FixtureIssBehaviour;
	readonly clientIdMetadataDocumentSupported?: boolean;
	readonly disableDynamicRegistration?: boolean;
	/** Reject Client ID Metadata Document clients with `invalid_client` at the given step. */
	readonly rejectCimdClientAt?: 'authorize' | 'token';
	/** Statically known clients (pre-registration), keyed by client id. */
	readonly clients?: Readonly<Record<string, IFixtureClient>>;
	/** Reject client ids that were neither registered nor configured (and are not acceptable CIMD ids). */
	readonly requireKnownClient?: boolean;
	/** Seconds an access token lives; defaults to 3600. */
	readonly tokenLifetimeSeconds?: number;
	/** Defaults to true. */
	readonly issueRefreshTokens?: boolean;
	/** Whether the token response echoes `scope`; defaults to true. */
	readonly echoScope?: boolean;
	/** Narrows the scopes actually granted. */
	readonly grantScopes?: (requested: readonly string[]) => readonly string[];
	/** Prefix for issued token ids, to tell servers apart. */
	readonly tokenPrefix?: string;
}

export interface IFixtureAuthorizationRequest {
	readonly query: Readonly<Record<string, string>>;
	readonly scopes: readonly string[];
}

export interface IFixtureTokenRequest {
	readonly body: Readonly<Record<string, string>>;
	readonly authorizationHeader?: string;
	/** `client_secret_basic`, `client_secret_post` or `none`, as observed. */
	readonly authMethod: string;
	/** The client id that authenticated (from the header or the body). */
	readonly clientId: string | undefined;
}

export interface IFixtureIssuedToken {
	readonly clientId: string;
	readonly scopes: readonly string[];
	readonly resource: string | undefined;
}

export interface IOAuthAuthorizationServerFixture {
	readonly issuer: string;
	readonly metadata: () => IAuthorizationServerMetadata;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly registrationEndpoint: string;
	/** Paths of metadata documents requested, in order. */
	readonly metadataRequests: string[];
	readonly authorizationRequests: IFixtureAuthorizationRequest[];
	readonly tokenRequests: IFixtureTokenRequest[];
	/** Dynamic registration request bodies. */
	readonly registrations: Array<Readonly<Record<string, unknown>>>;
	/** Registered client ids, in order. */
	readonly registeredClientIds: string[];
	/** Rule violations observed (requests the client must not make). */
	readonly violations: string[];
	readonly issuedTokens: Map<string, IFixtureIssuedToken>;
	verifyToken(accessToken: string): IFixtureIssuedToken | undefined;
	/** Invalidates every access and refresh token issued so far. */
	revokeAll(): void;
}

const ROOT_OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';
const ROOT_OIDC_METADATA_PATH = '/.well-known/openid-configuration';

export function createAuthorizationServerFixture(router: IFixtureRouter, options: IOAuthAuthorizationServerFixtureOptions = {}): IOAuthAuthorizationServerFixture {
	const issuer = options.issuer ?? 'https://as.example.test';
	const issuerUrl = new URL(issuer);
	const prefix = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/$/, '');
	const endpointOrigin = options.insecureEndpoints ? `http://${issuerUrl.host}` : issuerUrl.origin;
	const metadataLocation = options.metadataLocation ?? 'oauth';
	const metadataPath = metadataLocation === 'oauth' ? `${ROOT_OAUTH_METADATA_PATH}${prefix}`
		: metadataLocation === 'oidc' ? `${ROOT_OIDC_METADATA_PATH}${prefix}`
			: `${prefix}${ROOT_OIDC_METADATA_PATH}`;
	const supportedAuthMethods = options.tokenEndpointAuthMethodsSupported ?? ['none'];
	const tokenPrefix = options.tokenPrefix ?? 'token';

	const authorizationEndpoint = `${endpointOrigin}${prefix}/authorize`;
	const tokenEndpoint = `${endpointOrigin}${prefix}/token`;
	const registrationEndpoint = `${endpointOrigin}${prefix}/register`;

	const clients = new Map<string, IFixtureClient>(Object.entries(options.clients ?? {}));
	const codes = new Map<string, { challenge: string | undefined; redirectUri: string; resource: string | undefined; clientId: string; scopes: readonly string[] }>();
	const refreshTokens = new Map<string, IFixtureIssuedToken>();
	const fixture: IOAuthAuthorizationServerFixture = {
		issuer,
		metadata,
		authorizationEndpoint,
		tokenEndpoint,
		registrationEndpoint,
		metadataRequests: [],
		authorizationRequests: [],
		tokenRequests: [],
		registrations: [],
		registeredClientIds: [],
		violations: [],
		issuedTokens: new Map(),
		verifyToken: accessToken => fixture.issuedTokens.get(accessToken),
		revokeAll: () => { fixture.issuedTokens.clear(); refreshTokens.clear(); },
	};
	let counter = 0;

	function metadata(): IAuthorizationServerMetadata {
		const document: IAuthorizationServerMetadata = {
			issuer: options.advertisedIssuer ?? issuer,
			authorization_endpoint: authorizationEndpoint,
			token_endpoint: tokenEndpoint,
			response_types_supported: ['code'],
			grant_types_supported: [...(options.grantTypesSupported ?? ['authorization_code', 'refresh_token'])],
			token_endpoint_auth_methods_supported: [...supportedAuthMethods],
		};
		if (!options.disableDynamicRegistration) {
			document.registration_endpoint = registrationEndpoint;
		}
		if (options.codeChallengeMethodsSupported !== null) {
			document.code_challenge_methods_supported = [...(options.codeChallengeMethodsSupported ?? ['S256'])];
		}
		if (options.issParameterSupported !== null) {
			document.authorization_response_iss_parameter_supported = options.issParameterSupported ?? true;
		}
		if (options.scopesSupported) {
			document.scopes_supported = [...options.scopesSupported];
		}
		if (options.clientIdMetadataDocumentSupported !== undefined) {
			document.client_id_metadata_document_supported = options.clientIdMetadataDocumentSupported;
		}
		if (metadataLocation !== 'oauth') {
			document.jwks_uri = `${endpointOrigin}/.well-known/jwks.json`;
		}
		return document;
	}

	function isCimdClientId(clientId: string): boolean {
		return options.clientIdMetadataDocumentSupported === true && isValidClientMetadataUrl(clientId);
	}

	function issValue(): string | undefined {
		const behaviour = options.issInRedirect ?? 'correct';
		if (typeof behaviour === 'object') {
			return behaviour.custom;
		}
		switch (behaviour) {
			case 'correct': return options.advertisedIssuer ?? issuer;
			case 'wrong': return 'https://evil.example.com';
			case 'normalized': return `${options.advertisedIssuer ?? issuer}/`;
			case 'omit': return undefined;
		}
	}

	function redirect(redirectUri: string, params: Record<string, string | undefined>): IFixtureResponse {
		const location = new URL(redirectUri);
		for (const [name, value] of Object.entries(params)) {
			if (value !== undefined) {
				location.searchParams.set(name, value);
			}
		}
		return { status: 302, headers: { Location: location.toString() } };
	}

	function oauthError(status: number, error: string, description: string): IFixtureResponse {
		return { status, body: { error, error_description: description } };
	}

	function authenticateClient(request: IFixtureRequest): { clientId: string | undefined; method: string; secret: string | undefined; failure?: IFixtureResponse } {
		const form = request.form();
		const header = request.headers.authorization;
		let clientId: string | undefined;
		let secret: string | undefined;
		let method: string;
		if (header?.startsWith('Basic ')) {
			method = 'client_secret_basic';
			const decoded = decodeBase64(header.substring(6)).toString();
			const colon = decoded.indexOf(':');
			if (colon < 0) {
				return { clientId: undefined, method, secret: undefined, failure: oauthError(401, 'invalid_client', 'Malformed Basic credentials') };
			}
			clientId = decodeURIComponent(decoded.substring(0, colon));
			secret = decodeURIComponent(decoded.substring(colon + 1));
		} else if (form.has('client_secret')) {
			method = 'client_secret_post';
			clientId = form.get('client_id') ?? undefined;
			secret = form.get('client_secret') ?? undefined;
		} else {
			method = 'none';
			clientId = form.get('client_id') ?? undefined;
		}
		if (!supportedAuthMethods.includes(method)) {
			return { clientId, method, secret, failure: oauthError(401, 'invalid_client', `The token endpoint does not support ${method}`) };
		}
		if (clientId === undefined) {
			return { clientId, method, secret, failure: oauthError(401, 'invalid_client', 'No client_id') };
		}
		const known = clients.get(clientId);
		if (known) {
			if (known.clientSecret !== undefined && known.clientSecret !== secret) {
				return { clientId, method, secret, failure: oauthError(401, 'invalid_client', 'Invalid client credentials') };
			}
			if (known.clientSecret === undefined && method !== 'none') {
				return { clientId, method, secret, failure: oauthError(401, 'invalid_client', 'Public client presented credentials') };
			}
		} else if (isCimdClientId(clientId)) {
			if (options.rejectCimdClientAt === 'token') {
				return { clientId, method, secret, failure: oauthError(401, 'invalid_client', 'Client ID metadata documents are not accepted') };
			}
		} else if (options.requireKnownClient) {
			return { clientId, method, secret, failure: oauthError(401, 'invalid_client', `Unknown client ${clientId}`) };
		}
		return { clientId, method, secret };
	}

	async function s256(verifier: string): Promise<string> {
		const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
		return encodeBase64(VSBuffer.wrap(new Uint8Array(digest)), false, true);
	}

	function issueTokens(clientId: string, scopes: readonly string[], resource: string | undefined): IFixtureResponse {
		counter++;
		const accessToken = `${tokenPrefix}-access-${counter}`;
		const granted = options.grantScopes ? options.grantScopes(scopes) : scopes;
		fixture.issuedTokens.set(accessToken, { clientId, scopes: granted, resource });
		const body: Record<string, unknown> = { access_token: accessToken, token_type: 'Bearer', expires_in: options.tokenLifetimeSeconds ?? 3600 };
		if (options.issueRefreshTokens !== false) {
			const refreshToken = `${tokenPrefix}-refresh-${counter}`;
			refreshTokens.set(refreshToken, { clientId, scopes: granted, resource });
			body.refresh_token = refreshToken;
		}
		if (options.echoScope !== false && granted.length > 0) {
			body.scope = granted.join(' ');
		}
		return { status: 200, body };
	}

	async function handle(request: IFixtureRequest): Promise<IFixtureResponse | undefined> {
		const path = request.url.pathname;
		if (request.method === 'GET' && path === metadataPath && options.serveMetadata !== false) {
			fixture.metadataRequests.push(path);
			return { status: 200, body: metadata() };
		}
		if (request.method === 'GET' && (path === ROOT_OAUTH_METADATA_PATH || path === ROOT_OIDC_METADATA_PATH || path.startsWith(`${ROOT_OAUTH_METADATA_PATH}/`) || path.startsWith(`${ROOT_OIDC_METADATA_PATH}/`) || path.endsWith(ROOT_OIDC_METADATA_PATH))) {
			fixture.metadataRequests.push(path);
			if (options.trapRootMetadata && prefix && (path === ROOT_OAUTH_METADATA_PATH || path === ROOT_OIDC_METADATA_PATH)) {
				fixture.violations.push(`authorization server metadata requested at the root path ${path} although the issuer has the path ${prefix}`);
			}
			return undefined;
		}
		if (request.method === 'GET' && path === `${prefix}/authorize`) {
			const query: Record<string, string> = {};
			request.url.searchParams.forEach((value, name) => { query[name] = value; });
			const scopes = query.scope ? query.scope.split(' ').filter(s => s.length > 0) : [];
			fixture.authorizationRequests.push({ query, scopes });
			const redirectUri = query.redirect_uri;
			if (!redirectUri) {
				return oauthError(400, 'invalid_request', 'redirect_uri is required');
			}
			const clientId = query.client_id ?? '';
			if (isCimdClientId(clientId) && options.rejectCimdClientAt === 'authorize') {
				return redirect(redirectUri, { error: 'invalid_client', error_description: 'Client ID metadata documents are not accepted', state: query.state, iss: issValue() });
			}
			if (options.requireKnownClient && !clients.has(clientId) && !isCimdClientId(clientId)) {
				return redirect(redirectUri, { error: 'invalid_client', error_description: `Unknown client ${clientId}`, state: query.state, iss: issValue() });
			}
			counter++;
			const code = `${tokenPrefix}-code-${counter}`;
			codes.set(code, { challenge: query.code_challenge, redirectUri, resource: query.resource, clientId, scopes });
			return redirect(redirectUri, { code, state: query.state, iss: issValue() });
		}
		if (request.method === 'POST' && path === `${prefix}/token`) {
			const form = request.form();
			const body: Record<string, string> = {};
			form.forEach((value, name) => { body[name] = value; });
			const auth = authenticateClient(request);
			fixture.tokenRequests.push({ body, authorizationHeader: request.headers.authorization, authMethod: auth.method, clientId: auth.clientId });
			if (auth.failure) {
				return auth.failure;
			}
			const clientId = auth.clientId!;
			switch (body.grant_type) {
				case 'authorization_code': {
					const pending = body.code ? codes.get(body.code) : undefined;
					if (!pending) {
						return oauthError(400, 'invalid_grant', 'Unknown authorization code');
					}
					codes.delete(body.code);
					if (pending.clientId !== clientId) {
						return oauthError(400, 'invalid_grant', 'The code was issued to another client');
					}
					if (pending.redirectUri !== body.redirect_uri) {
						return oauthError(400, 'invalid_grant', 'redirect_uri does not match');
					}
					if (!pending.challenge || !body.code_verifier || await s256(body.code_verifier) !== pending.challenge) {
						return oauthError(400, 'invalid_grant', 'PKCE verification failed');
					}
					if (!body.resource) {
						return oauthError(400, 'invalid_target', 'resource is required');
					}
					if (pending.resource !== body.resource) {
						return oauthError(400, 'invalid_target', 'resource does not match the authorization request');
					}
					return issueTokens(clientId, pending.scopes, body.resource);
				}
				case 'refresh_token': {
					const previous = body.refresh_token ? refreshTokens.get(body.refresh_token) : undefined;
					if (!previous || previous.clientId !== clientId) {
						return oauthError(400, 'invalid_grant', 'Unknown refresh token');
					}
					refreshTokens.delete(body.refresh_token);
					return issueTokens(clientId, previous.scopes, body.resource ?? previous.resource);
				}
				default:
					return oauthError(400, 'unsupported_grant_type', `Unsupported grant_type ${body.grant_type}`);
			}
		}
		if (request.method === 'POST' && path === `${prefix}/register` && !options.disableDynamicRegistration) {
			const body = request.json() as Record<string, unknown>;
			fixture.registrations.push(body);
			const requestedMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'client_secret_basic';
			if (!supportedAuthMethods.includes(requestedMethod)) {
				return oauthError(400, 'invalid_client_metadata', `token_endpoint_auth_method ${requestedMethod} is not supported`);
			}
			counter++;
			const clientId = `${tokenPrefix}-dcr-client-${counter}`;
			const clientSecret = requestedMethod === 'none' ? undefined : `${tokenPrefix}-dcr-secret-${counter}`;
			clients.set(clientId, { clientSecret, tokenEndpointAuthMethod: requestedMethod });
			fixture.registeredClientIds.push(clientId);
			return {
				status: 201,
				body: {
					client_id: clientId,
					...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
					client_name: body.client_name ?? 'test-client',
					redirect_uris: body.redirect_uris ?? [],
					token_endpoint_auth_method: requestedMethod,
				},
			};
		}
		return undefined;
	}

	router.handle(issuerUrl.origin, handle);
	if (endpointOrigin !== issuerUrl.origin) {
		router.handle(endpointOrigin, handle);
	}
	return fixture;
}

//#endregion

//#region resource server

export interface IFixtureResourceRequest {
	readonly request: IFixtureRequest;
	readonly accessToken: string | undefined;
	/** The token's grant when it is valid. */
	readonly grant: IFixtureIssuedToken | undefined;
	/** The protected resource metadata URL for challenges. */
	readonly metadataUrl: string | undefined;
}

export interface IOAuthResourceServerFixtureOptions {
	/** The MCP server URL; defaults to `https://mcp.example.test/mcp`. */
	readonly resource?: string;
	/** The `authorization_servers` of the protected resource metadata. */
	readonly authorizationServers: readonly string[] | (() => readonly string[]);
	/** Where the protected resource metadata is served; defaults to `path`. */
	readonly prmLocation?: 'path' | 'root' | 'custom' | 'none';
	/** Advertise the metadata URL in `WWW-Authenticate`; defaults to true. */
	readonly prmInWwwAuthenticate?: boolean;
	/** Include the required scopes in the 401 challenge; defaults to false. */
	readonly scopeInWwwAuthenticate?: boolean;
	/** Record a request to the root metadata location as a violation. */
	readonly trapRootPrm?: boolean;
	/** Overrides the `resource` written into the metadata. */
	readonly prmResource?: string;
	readonly scopesSupported?: readonly string[];
	/** Scopes a token must hold to be accepted; defaults to none. */
	readonly requiredScopes?: readonly string[];
	readonly verifyToken: (accessToken: string) => IFixtureIssuedToken | undefined;
	/** Replaces the default authorization check; returning `undefined` serves the resource. */
	readonly authorize?: (context: IFixtureResourceRequest) => IFixtureResponse | undefined;
}

export interface IFixtureResourceAccess {
	readonly accessToken: string | undefined;
	readonly status: number;
}

export interface IOAuthResourceServerFixture {
	readonly resource: string;
	readonly metadataUrl: string | undefined;
	readonly metadata: () => IAuthorizationProtectedResourceMetadata;
	/** Paths of protected resource metadata documents requested, in order. */
	readonly prmRequests: string[];
	/** Requests to the resource itself with the bearer token they carried. */
	readonly accesses: IFixtureResourceAccess[];
	readonly violations: string[];
}

const PRM_ROOT_PATH = '/.well-known/oauth-protected-resource';
const PRM_CUSTOM_PATH = '/custom/metadata/location.json';

export function createResourceServerFixture(router: IFixtureRouter, options: IOAuthResourceServerFixtureOptions): IOAuthResourceServerFixture {
	const resource = options.resource ?? 'https://mcp.example.test/mcp';
	const resourceUrl = new URL(resource);
	const location = options.prmLocation ?? 'path';
	const metadataPath = location === 'path' ? `${PRM_ROOT_PATH}${resourceUrl.pathname}` : location === 'root' ? PRM_ROOT_PATH : location === 'custom' ? PRM_CUSTOM_PATH : undefined;
	const metadataUrl = metadataPath === undefined ? undefined : `${resourceUrl.origin}${metadataPath}`;
	const fixture: IOAuthResourceServerFixture = { resource, metadataUrl, metadata, prmRequests: [], accesses: [], violations: [] };

	function metadata(): IAuthorizationProtectedResourceMetadata {
		const servers = typeof options.authorizationServers === 'function' ? options.authorizationServers() : options.authorizationServers;
		const document: IAuthorizationProtectedResourceMetadata = {
			resource: options.prmResource ?? (location === 'root' ? resourceUrl.origin : resource),
			authorization_servers: [...servers],
		};
		if (options.scopesSupported) {
			document.scopes_supported = [...options.scopesSupported];
		}
		return document;
	}

	function challenge(status: number, params: Record<string, string | undefined>, error: string, description: string): IFixtureResponse {
		const header = bearerChallenge({ ...params, resource_metadata: options.prmInWwwAuthenticate !== false ? metadataUrl : undefined });
		return { status, headers: { 'WWW-Authenticate': header }, body: { error, error_description: description } };
	}

	function defaultAuthorize(context: IFixtureResourceRequest): IFixtureResponse | undefined {
		const required = options.requiredScopes ?? [];
		if (context.accessToken === undefined) {
			return challenge(401, { scope: options.scopeInWwwAuthenticate && required.length > 0 ? required.join(' ') : undefined }, 'invalid_token', 'Missing Authorization header');
		}
		if (!context.grant) {
			return challenge(401, { error: 'invalid_token', scope: options.scopeInWwwAuthenticate && required.length > 0 ? required.join(' ') : undefined }, 'invalid_token', 'The access token is not valid');
		}
		if (!required.every(scope => context.grant!.scopes.includes(scope))) {
			return challenge(403, { error: 'insufficient_scope', scope: required.join(' ') }, 'insufficient_scope', 'The access token lacks the required scope');
		}
		return undefined;
	}

	router.handle(resourceUrl.origin, request => {
		const path = request.url.pathname;
		if (request.method === 'GET' && (path === PRM_ROOT_PATH || path.startsWith(`${PRM_ROOT_PATH}/`) || path === PRM_CUSTOM_PATH)) {
			fixture.prmRequests.push(path);
			if (options.trapRootPrm && path === PRM_ROOT_PATH && metadataPath !== PRM_ROOT_PATH) {
				fixture.violations.push(`protected resource metadata requested at the root location although it is served at ${metadataPath}`);
			}
			return path === metadataPath ? { status: 200, body: metadata() } : undefined;
		}
		if (path === resourceUrl.pathname) {
			const header = request.headers.authorization;
			const accessToken = header?.startsWith('Bearer ') ? header.substring(7) : undefined;
			const grant = accessToken === undefined ? undefined : options.verifyToken(accessToken);
			const context: IFixtureResourceRequest = { request, accessToken, grant, metadataUrl };
			const rejection = (options.authorize ?? defaultAuthorize)(context);
			const response = rejection ?? { status: 200, body: { ok: true } };
			fixture.accesses.push({ accessToken, status: response.status });
			return response;
		}
		return undefined;
	});
	return fixture;
}

//#endregion

//#region composite

export interface IOAuthFixtureOptions {
	readonly as?: IOAuthAuthorizationServerFixtureOptions;
	readonly rs?: Omit<IOAuthResourceServerFixtureOptions, 'authorizationServers' | 'verifyToken'> & Partial<Pick<IOAuthResourceServerFixtureOptions, 'authorizationServers' | 'verifyToken'>>;
}

export interface IOAuthFixture {
	readonly fetch: IOAuthFetch;
	readonly requests: IRecordedRequest[];
	readonly issuer: string;
	readonly resource: string;
	readonly router: IFixtureRouter;
	readonly as: IOAuthAuthorizationServerFixture;
	readonly rs: IOAuthResourceServerFixture;
}

/** An authorization server plus a protected resource that names it, behind one fetch. */
export function createOAuthFixture(options: IOAuthFixtureOptions = {}): IOAuthFixture {
	const router = createFixtureRouter();
	const as = createAuthorizationServerFixture(router, options.as);
	const rs = createResourceServerFixture(router, {
		authorizationServers: [as.issuer],
		verifyToken: token => as.verifyToken(token),
		...options.rs,
	});
	return { fetch: router.fetch, requests: router.requests, issuer: as.issuer, resource: rs.resource, router, as, rs };
}

//#endregion
