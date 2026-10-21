/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceCancellationError } from './async.js';
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
	validateIssuerParameter,
} from './oauth.js';

/**
 * A UI-free OAuth 2.1 client implementing the MCP 2026-07-28 authorization
 * flow: protected resource metadata discovery (RFC 9728), authorization server
 * metadata discovery (RFC 8414 / OpenID Connect Discovery) with issuer
 * validation, client registration (pre-registered, Client ID Metadata
 * Documents, Dynamic Client Registration, or a prompt), the authorization code
 * grant with PKCE `S256`, RFC 8707 resource indicators, RFC 9207 `iss`
 * validation, token refresh and scope step-up. The browser interaction is
 * injected as an {@link OAuthAuthorizeStrategy} so the core can run headless.
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
}

export interface IOAuthTokenResult {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt?: number;
	readonly scopes?: readonly string[];
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
}

export interface IOAuthAuthorizationCodeGrantRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resource: string;
	/** The `resource` value to send; {@link resourceIndicatorFor} of `resource` by default. */
	readonly resourceIndicator?: string;
	readonly registration: IOAuthRegistration;
	readonly scopes?: readonly string[];
}

export interface IOAuthRefreshRequest {
	readonly serverMetadata: IAuthorizationServerMetadata;
	readonly resource: string;
	/** The `resource` value to send; {@link resourceIndicatorFor} of `resource` by default. */
	readonly resourceIndicator?: string;
	readonly registration: IOAuthRegistration;
	readonly refreshToken: string;
	/** The scopes of the token being refreshed, recorded when the server does not echo them. */
	readonly scopes?: readonly string[];
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

/** Extracts the first `Bearer` challenge of a `WWW-Authenticate` header. */
export function parseBearerChallenge(wwwAuthenticate: string | undefined): IOAuthChallenge | undefined {
	if (!wwwAuthenticate) {
		return undefined;
	}
	const challenge = parseWWWAuthenticateHeader(wwwAuthenticate).find(c => c.scheme.toLowerCase() === 'bearer');
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
		// Everything after the scheme is a credential unless it is a known challenge parameter.
		.replace(/\b(Bearer|Basic|DPoP)\s+(?!(?:realm|scope|error|error_description|error_uri|resource_metadata|algs|charset)\s*=)[^\s,;"'`]+/gi, `$1 ${REDACTED}`)
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
		const challenge = parseBearerChallenge(wwwAuthenticate);
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
	 * The authorization and token endpoints are used by every flow, so they are
	 * checked here. The registration endpoint is not: it is used only when a
	 * client registers dynamically, and a client that is pre-registered or uses
	 * a Client ID Metadata Document never contacts it, so it is checked where
	 * it is used (here {@link selectRegistration}; the extension host's dynamic
	 * authentication providers check it before they register). The same holds
	 * for the device authorization endpoint, which only the extension host's
	 * device code flow uses: it checks it, by the same rule, before its first
	 * request.
	 */
	private validateServerMetadata(metadata: IAuthorizationServerMetadata): void {
		if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
			throw new OAuthClientError('discovery_failed', `The authorization server ${metadata.issuer} does not publish an authorization and a token endpoint`);
		}
		this.assertSecureEndpoint(metadata.authorization_endpoint, 'authorization endpoint');
		this.assertSecureEndpoint(metadata.token_endpoint, 'token endpoint');
		if (this.options.pkce !== 'assume-supported' && !pkceSupported(metadata)) {
			throw new OAuthClientError('pkce_unsupported', `The authorization server ${metadata.issuer} does not advertise the S256 PKCE method in code_challenge_methods_supported`);
		}
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
		let record = await this.reconcileIssuer(key, await this.storage.get(key), serverMetadata.issuer);
		const scopes = selectScopes({
			challengeScope: request.scopes?.join(' '),
			prmScopes: request.resourceMetadata?.scopes_supported,
			requestOfflineAccess: this.options.requestOfflineAccess,
			scopesSupported: serverMetadata.scopes_supported,
		});

		if (record && !request.forceNewRegistration) {
			if (record.accessToken && record.accessToken !== request.rejectedToken && !this.isExpired(record) && this.scopesCovered(scopes, record.scopes, true)) {
				return this.toAuthorization(record);
			}
			// A refresh never widens the grant, so it only helps when the scopes are known to be held.
			if (record.refreshToken && this.scopesCovered(scopes, record.scopes, false)) {
				try {
					const refreshed = await this.refresh({ serverMetadata, resource: key, resourceIndicator, registration: this.registrationOf(record), refreshToken: record.refreshToken, scopes: record.scopes }, token);
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
				const result = await this.authorizationCodeGrant({ serverMetadata, resource: key, resourceIndicator, registration, scopes }, token);
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
		const tokenEndpoint = serverMetadata.token_endpoint!;

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

			return this.tokenRequest(tokenEndpoint, registration, {
				grant_type: 'authorization_code',
				code: params.code,
				redirect_uri: redirectUri,
				code_verifier: pkce.verifier,
				resource: resourceIndicator,
			}, request.scopes, signal);
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
			const result = await this.tokenRequest(tokenEndpoint, request.registration, { grant_type: 'refresh_token', refresh_token: request.refreshToken, resource: request.resourceIndicator ?? resourceIndicatorFor(key) }, request.scopes, signal);
			return { ...result, refreshToken: result.refreshToken ?? request.refreshToken };
		} finally {
			store.dispose();
		}
	}

	private async tokenRequest(tokenEndpoint: string, registration: IOAuthRegistration, params: Record<string, string>, requestedScopes: readonly string[] | undefined, signal: AbortSignal): Promise<IOAuthTokenResult> {
		const auth = buildClientAuthentication(registration.tokenEndpointAuthMethod, registration.clientId, registration.clientSecret);
		const response = await this.fetch(tokenEndpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', ...auth.headers },
			body: new URLSearchParams({ ...params, ...auth.body }).toString(),
			signal,
		});
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
			if (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer') {
				throw new OAuthClientError('token_request_failed', `The token endpoint ${tokenEndpoint} issued an unsupported token type '${String(payload.token_type)}'`);
			}
			return {
				accessToken: payload.access_token,
				refreshToken: payload.refresh_token,
				expiresAt: typeof payload.expires_in === 'number' ? this.now() + payload.expires_in * 1000 : undefined,
				scopes: payload.scope ? splitScopes(payload.scope) : requestedScopes,
			};
		}
		const failure = isAuthorizationErrorResponse(payload) ? payload : undefined;
		const description = failure ? `${failure.error}${failure.error_description ? ` (${failure.error_description})` : ''}` : 'no error details';
		this.log('warn', `token request to ${tokenEndpoint} failed with HTTP ${response.status}: ${description}`);
		throw new OAuthClientError('token_request_failed', `The token request to ${tokenEndpoint} failed with HTTP ${response.status}: ${description}`, { status: response.status, error: failure?.error, errorDescription: failure?.error_description });
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

		if (challenge?.error === 'insufficient_scope') {
			// The union of the previously granted and requested scopes with the challenged ones (SEP-2350).
			const requested = this.lastRequestedScopes.get(key);
			const union = unique([...held, ...(requested ?? []), ...splitScopes(challenge.scope)]);
			const rejected = options.previousToken ?? record?.accessToken;
			if (rejected !== undefined && record?.accessToken === rejected && requested && union.every(scope => requested.includes(scope))) {
				throw new OAuthClientError('step_up_limit', `The resource ${key} still reports insufficient scope after a token was issued for every scope it demands (${union.join(' ')})`);
			}
			this.log('info', `stepping up ${key} to scope '${union.join(' ')}'`);
			const authorization = await this.acquireToken({ serverMetadata, resourceMetadata, resource: key, scopes: union, rejectedToken: rejected }, token);
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
		const authorization = await this.acquireToken({ serverMetadata, resourceMetadata, resource: key, scopes: scopes.length > 0 ? scopes : undefined, rejectedToken: rejected, forceNewRegistration }, token);
		this.rejections.set(key, { issued: authorization.accessToken, count });
		return authorization;
	}

	/**
	 * Sends a request with the resource's bearer token, handling up to
	 * {@link IOAuthClientOptions.maxChallengesPerRequest} challenges by
	 * (re-)authorizing, and returns the final response.
	 */
	async fetchWithAuth(resource: string, url: string, init: IOAuthFetchInit = {}, token: CancellationToken = CancellationToken.None): Promise<IOAuthFetchResponse> {
		const key = canonicalResourceUri(resource);
		const store = new DisposableStore();
		try {
			const signal = init.signal ?? CancellationToken.toAbortSignal(token, store);
			let accessToken = (await this.getAuthorization(key))?.accessToken;
			for (let challenges = 0; ; challenges++) {
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(init.headers ?? {})) {
					if (name.toLowerCase() !== 'authorization') {
						headers[name] = value;
					}
				}
				if (accessToken) {
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
				const header = response.headers.get('WWW-Authenticate') ?? undefined;
				const challenge = parseBearerChallenge(header);
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
				const authorization = await this.handleChallenge(key, header, { previousToken: accessToken }, token);
				accessToken = authorization.accessToken;
			}
		} finally {
			store.dispose();
		}
	}

	//#endregion

	//#region records

	/** The stored, unexpired access token for a resource, without any network activity. */
	async getAuthorization(resource: string): Promise<IOAuthAuthorization | undefined> {
		const record = await this.storage.get(canonicalResourceUri(resource));
		return record?.accessToken && !this.isExpired(record) ? this.toAuthorization(record) : undefined;
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
		return { accessToken: record.accessToken!, refreshToken: record.refreshToken, expiresAt: record.expiresAt, scopes: record.scopes, record };
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
