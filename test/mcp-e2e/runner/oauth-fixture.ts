/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// MCP servers behind OAuth 2.1 for the sign-in tests: one process that is
//   - the protected resource:
//       Streamable HTTP at /mcp of --listen: a request without a valid bearer token gets 401 with
//       `WWW-Authenticate: Bearer resource_metadata="<PRM URL>", scope="mcp:tools"`; an authorized
//       one is forwarded to the upstream MCP server (--upstream, the zig-sdk server's /mcp);
//       and/or gRPC (h2c) on --grpc-listen: a call without a valid token ends trailers-only with
//       grpc-status 16 (UNAUTHENTICATED) and `www-authenticate: Bearer resource_metadata=...`; an
//       authorized one is forwarded to the upstream gRPC server (--grpc-upstream);
//     with RFC 9728 metadata on --listen at --prm-path (HTTP; default the well-known path) and
//     /.well-known/oauth-protected-resource/grpc (gRPC; resource https://127.0.0.1:<grpc port>/,
//     the identity VS Code gives a grpc:// server);
//   - the authorization server (issuer http://127.0.0.1:<--as-port><--as-path>, by default the
//     --listen origin): RFC 8414 metadata at /.well-known/oauth-authorization-server<as-path> (S256
//     only, `authorization_response_iss_parameter_supported: true`), dynamic client registration
//     (RFC 7591), /authorize that approves at once (302 to the redirect URI with `code`, `state` and,
//     per --iss-mode, the right `iss` (ok), a wrong one (wrong) or none (omit)), and /token that
//     checks the code, the client, the redirect URI, the PKCE verifier (S256) and the RFC 8707
//     `resource`. A token is valid only for the resource it was issued for.
//   - for the machine clients of the authorization extensions, also at /token:
//       the client credentials grant (`io.modelcontextprotocol/oauth-client-credentials`) of the
//       pre-registered client --machine-client, which authenticates with `private_key_jwt`
//       (RFC 7523 2.2): an ES256 client assertion signed with the key of --client-jwk (its `kid`),
//       `iss` = `sub` = the client id, `aud` the issuer, unexpired, a fresh `jti`, no secret;
//       the JWT authorization grant (RFC 7523 2.1) of a workload identity (`io.modelcontextprotocol/
//       auth/wif`): the fixture is the workload identity provider too, writes a signed JWT for the
//       workload to --workload-token-out at startup (its `aud` the issuer, or with
//       --workload-token-aud other another authorization server) and accepts only that one;
//   - DPoP (RFC 9449, `io.modelcontextprotocol/auth/dpop`) with --dpop required: the PRM sets
//     `dpop_bound_access_tokens_required`, the challenge is `DPoP ... algs="ES256"`, /token binds the
//     token to the key of a valid proof (`token_type: DPoP`) after one `use_dpop_nonce` round, and the
//     resource takes only a DPoP-bound token with a valid proof (its key, `ath`, `htm`, `htu`, a fresh
//     `jti`) after one `use_dpop_nonce` round of its own. --dpop optional: Bearer challenge, no PRM
//     flag, both kinds of token accepted. Off by default.
//
// Every request is one JSON line in the log (`event`: prm, as-metadata, register, authorize, token,
// mcp, grpc, not-found) with what was checked and the port and path it came to; tokens and codes are
// logged as their first 8 characters.
//
// Usage: node runner/oauth-fixture.ts --listen <port> --log <file.jsonl> [--upstream <port>]
//        [--as-port <port>] [--as-path </path>] [--prm-path </path>] [--iss-mode ok|wrong|omit]
//        [--grpc-listen <port> --grpc-upstream <port>] [--machine-client <client id> --client-jwk <file>]
//        [--workload-token-out <file> [--workload-token-aud issuer|other]] [--dpop off|optional|required]

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as http2 from 'node:http2';

const SCOPE = 'mcp:tools';
const RESOURCE_NAME = 'MCP E2E OAuth fixture';
const GRPC_PRM_PATH = '/.well-known/oauth-protected-resource/grpc';
const DEFAULT_PRM_PATH = '/.well-known/oauth-protected-resource/mcp';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const CLIENT_ASSERTION_TYPE_JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** The workload identity provider and workload of the JWT that --workload-token-out gets. */
const WORKLOAD_ISSUER = 'https://workload-identity.mcp-e2e.invalid';
const WORKLOAD_SUBJECT = 'system:serviceaccount:mcp-e2e:vscode';
/** The `aud` of the workload JWT with --workload-token-aud other: an authorization server that is not this one. */
const OTHER_AUDIENCE = 'https://another-authorization-server.mcp-e2e.invalid';
/** How far `iat` of a DPoP proof may be from the fixture's clock. */
const PROOF_IAT_WINDOW_SECONDS = 60;

function argValue(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

function base64url(bytes: Buffer): string {
	return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
	return base64url(crypto.randomBytes(24));
}

/** The S256 code challenge of a PKCE verifier (RFC 7636). */
export function s256(verifier: string): string {
	return base64url(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

function short(value: string | undefined): string | undefined {
	return value === undefined ? undefined : `${value.slice(0, 8)}...`;
}

/** A JWS in the compact serialization, decoded (not verified). */
interface IJws {
	readonly header: Record<string, unknown>;
	readonly claims: Record<string, unknown>;
	readonly signingInput: Buffer;
	readonly signature: Buffer;
}

function decodeJws(jwt: string | null | undefined): IJws | undefined {
	const parts = jwt?.split('.') ?? [];
	if (parts.length !== 3) {
		return undefined;
	}
	try {
		const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
		const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
		if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null) {
			return undefined;
		}
		return { header: header as Record<string, unknown>, claims: claims as Record<string, unknown>, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], 'base64url') };
	} catch {
		return undefined;
	}
}

/** Whether the ES256 signature of `jws` (IEEE P1363 r || s, as JWS has it) verifies with `key`. */
function es256Verifies(jws: IJws, key: crypto.KeyObject | crypto.JsonWebKey): boolean {
	try {
		const publicKey = key instanceof crypto.KeyObject ? key : crypto.createPublicKey({ key, format: 'jwk' });
		return crypto.verify('sha256', jws.signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jws.signature);
	} catch {
		return false;
	}
}

function signEs256(privateKey: crypto.KeyObject, header: Record<string, unknown>, claims: Record<string, unknown>): string {
	const input = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claims)))}`;
	return `${input}.${base64url(crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }))}`;
}

/** The RFC 7638 thumbprint of an EC public key: the `cnf.jkt` of a DPoP-bound token. */
function jwkThumbprint(jwk: Record<string, unknown>): string {
	return base64url(crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

function audiencesOf(claims: Record<string, unknown>): string[] {
	return (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).filter((a): a is string => typeof a === 'string');
}

/** The failed checks of a list, by name. */
function failedChecks(checks: Record<string, boolean>): string[] {
	return Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
}

type DpopMode = 'off' | 'optional' | 'required';

/**
 * A DPoP proof checked (RFC 9449 section 4.3): `none` without a `DPoP` header, `invalid` when a
 * check failed, `nonce` when only the server's nonce is missing (or stale), else `valid` with the
 * thumbprint of its key.
 */
interface IDpopCheck {
	readonly state: 'none' | 'invalid' | 'nonce' | 'valid';
	readonly failed: readonly string[];
	readonly jkt?: string;
	readonly jti?: string;
}

/**
 * Checks the `DPoP` header of a request with `method` to `htu` (the URL without query and
 * fragment): one proof, `typ` dpop+jwt, ES256 with a public EC key in its header that verifies the
 * signature, `htm`, `htu`, a recent `iat`, a `jti` not seen before; for a request to the resource
 * also `ath` (the hash of `accessToken`) and the key the token is bound to (`jkt`). A valid proof's
 * `jti` is remembered in `seen`.
 */
function checkDpopProof(header: string | string[] | undefined, method: string, htu: string, nonce: string, seen: Set<string>, bound?: { readonly accessToken: string; readonly jkt: string | undefined }): IDpopCheck {
	if (header === undefined) {
		return { state: 'none', failed: [] };
	}
	const jws = decodeJws(Array.isArray(header) ? header[0] : header);
	const jwk = typeof jws?.header.jwk === 'object' && jws.header.jwk !== null ? jws.header.jwk as Record<string, unknown> : undefined;
	const claims = jws?.claims ?? {};
	const jkt = jwk ? jwkThumbprint(jwk) : undefined;
	const jti = typeof claims.jti === 'string' ? claims.jti : undefined;
	const now = Math.floor(Date.now() / 1000);
	const checks: Record<string, boolean> = {
		oneProof: !Array.isArray(header) || header.length === 1,
		typDpopJwt: jws?.header.typ === 'dpop+jwt',
		algEs256: jws?.header.alg === 'ES256',
		publicEcKey: jwk?.kty === 'EC' && jwk.crv === 'P-256' && jwk.d === undefined,
		signature: !!jws && !!jwk && es256Verifies(jws, jwk as crypto.JsonWebKey),
		htm: claims.htm === method,
		htu: claims.htu === htu,
		iatRecent: typeof claims.iat === 'number' && Math.abs(now - claims.iat) <= PROOF_IAT_WINDOW_SECONDS,
		jtiFresh: jti !== undefined && jti.length > 0 && !seen.has(jti),
	};
	if (bound) {
		checks.ath = claims.ath === base64url(crypto.createHash('sha256').update(bound.accessToken, 'ascii').digest());
		checks.tokenKey = bound.jkt !== undefined && jkt === bound.jkt;
	}
	const failed = failedChecks(checks);
	if (failed.length) {
		return { state: 'invalid', failed, jkt, jti };
	}
	seen.add(jti!);
	return claims.nonce === nonce ? { state: 'valid', failed, jkt, jti } : { state: 'nonce', failed: ['nonce'], jkt, jti };
}

/** Whether a redirect URI is a loopback one that matches a registered URI apart from the port (RFC 8252 7.3). */
export function loopbackRedirectMatches(registered: readonly string[], redirectUri: string): boolean {
	let uri: URL;
	try {
		uri = new URL(redirectUri);
	} catch {
		return false;
	}
	return registered.some(r => {
		if (r === redirectUri) {
			return true;
		}
		try {
			const reg = new URL(r);
			return reg.protocol === 'http:' && uri.protocol === 'http:' && (reg.hostname === '127.0.0.1' || reg.hostname === '[::1]') && reg.hostname === uri.hostname && reg.pathname === uri.pathname;
		} catch {
			return false;
		}
	});
}

interface IClient {
	readonly clientId: string;
	readonly redirectUris: readonly string[];
}

interface ICode {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly codeChallenge: string;
	readonly resource: string | undefined;
	readonly scope: string | undefined;
	used: boolean;
}

function readBody(req: http.IncomingMessage | http2.ServerHttp2Stream): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
	res.end(JSON.stringify(body));
}

/** The JSON-RPC methods (and tool names) of an MCP request body, for the log. */
function jsonRpcSummary(body: Buffer): { methods: string[]; tools: string[] } {
	try {
		const parsed = JSON.parse(body.toString('utf8')) as unknown;
		const messages = (Array.isArray(parsed) ? parsed : [parsed]) as { method?: unknown; params?: { name?: unknown } }[];
		return {
			methods: messages.map(m => typeof m.method === 'string' ? m.method : '(response)'),
			tools: messages.filter(m => m.method === 'tools/call' && typeof m.params?.name === 'string').map(m => String(m.params!.name)),
		};
	} catch {
		return { methods: [], tools: [] };
	}
}

function normalizedRoute(pathname: string): string {
	// `/.well-known/oauth-authorization-server/` for an issuer with an empty path is the same document.
	return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

type IssMode = 'ok' | 'wrong' | 'omit';

function main(args: readonly string[]): void {
	const listen = Number(argValue(args, '--listen'));
	const upstreamText = argValue(args, '--upstream');
	const upstreamPort = upstreamText === undefined ? undefined : Number(upstreamText);
	const logFile = argValue(args, '--log');
	const asPort = Number(argValue(args, '--as-port') ?? listen);
	const asPath = (argValue(args, '--as-path') ?? '').replace(/\/+$/, '');
	const prmPath = argValue(args, '--prm-path') ?? DEFAULT_PRM_PATH;
	const issMode = (argValue(args, '--iss-mode') ?? 'ok') as IssMode;
	const grpcListenText = argValue(args, '--grpc-listen');
	const grpcListen = grpcListenText === undefined ? undefined : Number(grpcListenText);
	const grpcUpstream = Number(argValue(args, '--grpc-upstream'));
	const machineClientId = argValue(args, '--machine-client');
	const clientJwkFile = argValue(args, '--client-jwk');
	const workloadTokenOut = argValue(args, '--workload-token-out');
	const workloadTokenAud = argValue(args, '--workload-token-aud') ?? 'issuer';
	const dpopMode = (argValue(args, '--dpop') ?? 'off') as DpopMode;
	if (!Number.isInteger(listen) || !logFile || !Number.isInteger(asPort) || !['ok', 'wrong', 'omit'].includes(issMode)
		|| (upstreamPort !== undefined && !Number.isInteger(upstreamPort)) || (grpcListen !== undefined && (!Number.isInteger(grpcListen) || !Number.isInteger(grpcUpstream)))
		|| (machineClientId === undefined) !== (clientJwkFile === undefined) || !['issuer', 'other'].includes(workloadTokenAud) || !['off', 'optional', 'required'].includes(dpopMode)) {
		console.error('usage: oauth-fixture.ts --listen <port> --log <file.jsonl> [--upstream <port>] [--as-port <port>] [--as-path </path>] [--prm-path </path>] [--iss-mode ok|wrong|omit] [--grpc-listen <port> --grpc-upstream <port>] [--machine-client <client id> --client-jwk <file>] [--workload-token-out <file> [--workload-token-aud issuer|other]] [--dpop off|optional|required]');
		process.exitCode = 2;
		return;
	}
	const record = (entry: Record<string, unknown>) => fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
	const origin = `http://127.0.0.1:${listen}`;
	const issuer = `http://127.0.0.1:${asPort}${asPath}`;
	const httpResource = upstreamPort !== undefined ? `${origin}/mcp` : undefined;
	const grpcResource = grpcListen !== undefined ? `https://127.0.0.1:${grpcListen}/` : undefined;
	const resources = [httpResource, grpcResource].filter((r): r is string => r !== undefined);
	const httpPrmUrl = `${origin}${prmPath}`;
	const grpcPrmUrl = `${origin}${GRPC_PRM_PATH}`;
	const clients = new Map<string, IClient>();
	const codes = new Map<string, ICode>();
	/** The issued tokens; `jkt` is the thumbprint of the key a DPoP-bound one is bound to (`cnf.jkt`). */
	const tokens = new Map<string, { clientId: string; resource: string | undefined; jkt: string | undefined }>();
	let clientCount = 0;
	const issFor = (): string | undefined => issMode === 'ok' ? issuer : issMode === 'wrong' ? `${issuer}/not-the-issuer` : undefined;
	const tokenEndpoint = `${issuer}/token`;

	// The pre-registered machine client and its public key (`private_key_jwt`).
	const clientJwk = clientJwkFile !== undefined ? JSON.parse(fs.readFileSync(clientJwkFile, 'utf8')) as crypto.JsonWebKey & { kid?: string } : undefined;
	// The fixture as the workload identity provider: one signed JWT for the workload, valid for a day.
	let workloadKey: crypto.KeyObject | undefined;
	if (workloadTokenOut !== undefined) {
		const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
		workloadKey = pair.publicKey;
		const now = Math.floor(Date.now() / 1000);
		const jwt = signEs256(pair.privateKey, { alg: 'ES256', typ: 'JWT', kid: 'mcp-e2e-workload-identity' }, {
			iss: WORKLOAD_ISSUER, sub: WORKLOAD_SUBJECT, aud: workloadTokenAud === 'other' ? OTHER_AUDIENCE : issuer, iat: now, exp: now + 24 * 3600, jti: randomToken(),
		});
		fs.writeFileSync(`${workloadTokenOut}.tmp`, jwt + '\n', { mode: 0o600 });
		fs.renameSync(`${workloadTokenOut}.tmp`, workloadTokenOut);
	}
	// DPoP: one nonce for the authorization server and one for the resource, the `jti`s of the proofs seen.
	const asNonce = randomToken();
	const rsNonce = randomToken();
	const proofJtis = new Set<string>();
	const assertionJtis = new Set<string>();

	const asMetadata = {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: tokenEndpoint,
		registration_endpoint: `${issuer}/register`,
		scopes_supported: [SCOPE],
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', ...(machineClientId !== undefined ? ['client_credentials'] : []), ...(workloadKey ? [GRANT_JWT_BEARER] : [])],
		token_endpoint_auth_methods_supported: machineClientId !== undefined ? ['none', 'private_key_jwt'] : ['none'],
		...(machineClientId !== undefined ? { token_endpoint_auth_signing_alg_values_supported: ['ES256'] } : {}),
		...(dpopMode !== 'off' ? { dpop_signing_alg_values_supported: ['ES256'] } : {}),
		code_challenge_methods_supported: ['S256'],
		authorization_response_iss_parameter_supported: true,
	};
	const prmFor = (resource: string) => ({
		resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: RESOURCE_NAME,
		...(dpopMode === 'required' ? { dpop_signing_alg_values_supported: ['ES256'], dpop_bound_access_tokens_required: true } : {}),
	});
	/** The `WWW-Authenticate` of a refused request: DPoP when the resource requires DPoP-bound tokens (RFC 9449 section 7.1). */
	const challengeFor = (prmUrl: string, error?: { readonly code: string; readonly description: string }) => {
		const params = `resource_metadata="${prmUrl}", scope="${SCOPE}"${error ? `, error="${error.code}", error_description="${error.description}"` : ''}`;
		return dpopMode === 'required' ? `DPoP ${params}, algs="ES256"` : `Bearer ${params}`;
	};
	/**
	 * How a request presents its token: `none`, `not bearer` (another scheme), `unknown bearer`,
	 * `bearer for another resource`, `valid bearer` (an unbound token as Bearer), `bound token as
	 * bearer` (a DPoP-bound one as Bearer: refused, RFC 9449 section 7.1), and with the DPoP scheme
	 * `unknown dpop token`, `dpop token for another resource`, `unbound token as dpop`, `dpop proof
	 * missing`, `dpop proof invalid`, `dpop nonce missing` (valid but without the resource's
	 * nonce) or `valid dpop`. Which of them the resource takes: {@link accepted}.
	 */
	const tokenValidFor = (authorization: string | undefined, resource: string | undefined, request: { readonly proof: string | string[] | undefined; readonly method: string; readonly htu: string }): { bearer: string | undefined; state: string; scheme?: string; dpop?: IDpopCheck } => {
		const presented = /^(Bearer|DPoP) (\S+)$/i.exec(authorization ?? '');
		const scheme = presented?.[1].toLowerCase();
		const bearer = presented?.[2];
		const token = bearer === undefined ? undefined : tokens.get(bearer);
		if (authorization === undefined || bearer === undefined) {
			return { bearer, state: authorization === undefined ? 'none' : 'not bearer' };
		}
		if (scheme === 'bearer') {
			return { bearer, scheme, state: !token ? 'unknown bearer' : token.resource !== resource ? 'bearer for another resource' : token.jkt !== undefined ? 'bound token as bearer' : 'valid bearer' };
		}
		if (!token || token.resource !== resource || token.jkt === undefined) {
			return { bearer, scheme, state: !token ? 'unknown dpop token' : token.resource !== resource ? 'dpop token for another resource' : 'unbound token as dpop' };
		}
		const dpop = checkDpopProof(request.proof, request.method, request.htu, rsNonce, proofJtis, { accessToken: bearer, jkt: token.jkt });
		return { bearer, scheme, dpop, state: dpop.state === 'none' ? 'dpop proof missing' : dpop.state === 'invalid' ? 'dpop proof invalid' : dpop.state === 'nonce' ? 'dpop nonce missing' : 'valid dpop' };
	};
	const accepted = (state: string) => state === 'valid dpop' || (state === 'valid bearer' && dpopMode !== 'required');
	/** The challenge of a refused request: `use_dpop_nonce` with the resource's nonce, or the resource's challenge. */
	const refusalOf = (state: string, prmUrl: string): { wwwAuthenticate: string; nonce?: string } => {
		if (state === 'dpop nonce missing') {
			return { wwwAuthenticate: `DPoP error="use_dpop_nonce", error_description="the resource server requires a nonce in the DPoP proof"`, nonce: rsNonce };
		}
		if (state === 'dpop proof missing' || state === 'dpop proof invalid') {
			return { wwwAuthenticate: challengeFor(prmUrl, { code: 'invalid_dpop_proof', description: state }) };
		}
		if (state === 'bound token as bearer' || state === 'unbound token as dpop' || (state === 'valid bearer' && dpopMode === 'required')) {
			return { wwwAuthenticate: challengeFor(prmUrl, { code: 'invalid_token', description: state === 'valid bearer' ? 'a DPoP-bound token is required' : state }) };
		}
		return { wwwAuthenticate: challengeFor(prmUrl) };
	};

	// --- The authorization server (on its own port when --as-port differs) -----------------------
	const handleAs = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL, route: string, port: number): Promise<boolean> => {
		const at = { port, path: route };
		if (req.method === 'GET' && (route === `/.well-known/oauth-authorization-server${asPath}` || route === `/.well-known/openid-configuration${asPath}` || route === `${asPath}/.well-known/openid-configuration`)) {
			record({ event: 'as-metadata', ...at });
			sendJson(res, 200, asMetadata);
			return true;
		}
		if (req.method === 'POST' && route === `${asPath}/register`) {
			const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { redirect_uris?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown; client_name?: unknown };
			const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
			if (!redirectUris.length) {
				record({ event: 'register', ...at, ok: false, reason: 'no redirect_uris', body });
				sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
				return true;
			}
			const clientId = `mcp-e2e-client-${++clientCount}`;
			clients.set(clientId, { clientId, redirectUris });
			record({ event: 'register', ...at, ok: true, clientId, redirectUris, tokenEndpointAuthMethod: body.token_endpoint_auth_method, grantTypes: body.grant_types, clientName: body.client_name });
			sendJson(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] });
			return true;
		}
		if (req.method === 'GET' && route === `${asPath}/authorize`) {
			const p = url.searchParams;
			const clientId = p.get('client_id') ?? '';
			const redirectUri = p.get('redirect_uri') ?? '';
			const state = p.get('state') ?? undefined;
			const checks = {
				clientKnown: clients.has(clientId),
				responseTypeCode: p.get('response_type') === 'code',
				pkceS256: p.get('code_challenge_method') === 'S256' && !!p.get('code_challenge'),
				resourceMatches: resources.includes(p.get('resource') ?? ''),
				redirectUriRegistered: loopbackRedirectMatches(clients.get(clientId)?.redirectUris ?? [], redirectUri),
				statePresent: !!state,
			};
			const entry = { event: 'authorize', ...at, clientId, redirectUri, scope: p.get('scope'), resource: p.get('resource'), codeChallengeMethod: p.get('code_challenge_method'), state, checks, issMode };
			if (!checks.clientKnown || !checks.redirectUriRegistered) {
				// Never redirect to an unverified redirect URI (RFC 6749 4.1.2.1).
				record({ ...entry, ok: false });
				sendJson(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect_uri' });
				return true;
			}
			const location = new URL(redirectUri);
			const ok = Object.values(checks).every(Boolean);
			let code: string | undefined;
			if (ok) {
				code = randomToken();
				codes.set(code, { clientId, redirectUri, codeChallenge: p.get('code_challenge')!, resource: p.get('resource') ?? undefined, scope: p.get('scope') ?? undefined, used: false });
				location.searchParams.set('code', code);
			} else {
				location.searchParams.set('error', 'invalid_request');
				location.searchParams.set('error_description', `failed checks: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}`);
			}
			if (state !== undefined) {
				location.searchParams.set('state', state);
			}
			// RFC 9207: the metadata announces `iss` in the authorization response.
			const iss = issFor();
			if (iss !== undefined) {
				location.searchParams.set('iss', iss);
			}
			record({ ...entry, ok, code: short(code), iss: iss ?? null });
			res.writeHead(302, { location: location.toString(), 'cache-control': 'no-store' });
			res.end();
			return true;
		}
		if (req.method === 'POST' && route === `${asPath}/token`) {
			const p = new URLSearchParams((await readBody(req)).toString('utf8'));
			const grantType = p.get('grant_type');
			const resource = p.get('resource');
			const now = Math.floor(Date.now() / 1000);
			let checks: Record<string, boolean>;
			let details: Record<string, unknown>;
			let issued: { readonly subject: string; readonly resource: string | undefined; readonly scope: string; readonly redeem?: () => void };
			let error: string;
			if (grantType === 'client_credentials' && machineClientId !== undefined && clientJwk) {
				// The client credentials grant of the pre-registered client, authenticated with private_key_jwt (RFC 7523 section 2.2).
				const assertion = decodeJws(p.get('client_assertion'));
				const claims = assertion?.claims ?? {};
				const jti = typeof claims.jti === 'string' ? claims.jti : undefined;
				checks = {
					clientAssertionType: p.get('client_assertion_type') === CLIENT_ASSERTION_TYPE_JWT_BEARER,
					assertionAlgEs256: assertion?.header.alg === 'ES256',
					assertionKeyId: assertion?.header.kid === clientJwk.kid,
					assertionSignature: !!assertion && es256Verifies(assertion, clientJwk),
					assertionIssSubClient: claims.iss === machineClientId && claims.sub === machineClientId,
					assertionAudience: audiencesOf(claims).some(a => a === issuer || a === tokenEndpoint),
					assertionUnexpired: typeof claims.exp === 'number' && claims.exp > now && typeof claims.iat === 'number' && claims.iat <= now + PROOF_IAT_WINDOW_SECONDS,
					assertionJtiFresh: jti !== undefined && jti.length > 0 && !assertionJtis.has(jti),
					noClientSecret: req.headers.authorization === undefined && !p.has('client_secret'),
					clientIdOmittedOrMatches: !p.has('client_id') || p.get('client_id') === machineClientId,
					resourcePresent: resource !== null,
					resourceMatches: resources.includes(resource ?? ''),
				};
				if (jti !== undefined) {
					assertionJtis.add(jti);
				}
				details = { clientId: machineClientId, clientIdInBody: p.has('client_id'), assertion: assertion && { alg: assertion.header.alg, kid: assertion.header.kid, iss: claims.iss, sub: claims.sub, aud: claims.aud, lifetime: typeof claims.exp === 'number' && typeof claims.iat === 'number' ? claims.exp - claims.iat : undefined } };
				issued = { subject: machineClientId, resource: resource ?? undefined, scope: p.get('scope') ?? SCOPE };
				error = 'invalid_client';
			} else if (grantType === GRANT_JWT_BEARER && workloadKey) {
				// The JWT authorization grant (RFC 7523 section 2.1) with the workload identity JWT of --workload-token-out.
				const assertion = decodeJws(p.get('assertion'));
				const claims = assertion?.claims ?? {};
				checks = {
					assertionSignature: !!assertion && assertion.header.alg === 'ES256' && es256Verifies(assertion, workloadKey),
					assertionIssuer: claims.iss === WORKLOAD_ISSUER,
					assertionSubject: claims.sub === WORKLOAD_SUBJECT,
					assertionAudience: audiencesOf(claims).some(a => a === issuer || a === tokenEndpoint),
					assertionUnexpired: typeof claims.exp === 'number' && claims.exp > now,
					noClientAuthentication: req.headers.authorization === undefined && !p.has('client_secret') && !p.has('client_assertion'),
					resourcePresent: resource !== null,
					resourceMatches: resources.includes(resource ?? ''),
				};
				details = { clientId: p.get('client_id'), assertion: assertion && { alg: assertion.header.alg, iss: claims.iss, sub: claims.sub, aud: claims.aud } };
				issued = { subject: WORKLOAD_SUBJECT, resource: resource ?? undefined, scope: p.get('scope') ?? SCOPE };
				error = 'invalid_grant';
			} else {
				const code = p.get('code') ?? '';
				const stored = codes.get(code);
				const verifier = p.get('code_verifier') ?? '';
				checks = {
					grantAuthorizationCode: grantType === 'authorization_code',
					codeValid: !!stored && !stored.used,
					clientMatches: !!stored && p.get('client_id') === stored.clientId,
					redirectUriMatches: !!stored && p.get('redirect_uri') === stored.redirectUri,
					pkceVerified: !!stored && verifier.length >= 43 && s256(verifier) === stored.codeChallenge,
					resourcePresent: resource !== null,
					resourceMatches: resources.includes(resource ?? '') && (!stored || stored.resource === resource),
				};
				details = { clientId: p.get('client_id'), redirectUri: p.get('redirect_uri'), code: short(code), codeVerifierLength: verifier.length };
				issued = { subject: stored?.clientId ?? '', resource: stored?.resource, scope: stored?.scope ?? SCOPE, redeem: () => { stored!.used = true; } };
				error = grantType === 'authorization_code' ? 'invalid_grant' : 'unsupported_grant_type';
			}
			// DPoP (RFC 9449 section 5): a valid proof binds the token to its key; one without this server's nonce gets use_dpop_nonce (section 8).
			const dpop = dpopMode === 'off' ? undefined : checkDpopProof(req.headers.dpop, 'POST', `http://127.0.0.1:${port}${url.pathname}`, asNonce, proofJtis);
			const entry = { event: 'token', ...at, grantType, ...details, resource, scope: p.get('scope'), clientAuthorization: req.headers.authorization ? 'present' : 'none', dpop: dpop && { state: dpop.state, failed: dpop.failed }, checks };
			const failed = failedChecks(checks);
			if (failed.length) {
				record({ ...entry, ok: false, status: 400, error });
				sendJson(res, 400, { error, error_description: `failed checks: ${failed.join(', ')}` });
				return true;
			}
			if (dpop?.state === 'invalid' || dpop?.state === 'nonce') {
				const dpopError = dpop.state === 'nonce' ? 'use_dpop_nonce' : 'invalid_dpop_proof';
				record({ ...entry, ok: false, status: 400, error: dpopError });
				sendJson(res, 400, { error: dpopError, error_description: dpop.state === 'nonce' ? 'the authorization server requires a nonce in the DPoP proof' : `failed checks: ${dpop.failed.join(', ')}` }, dpop.state === 'nonce' ? { 'dpop-nonce': asNonce } : {});
				return true;
			}
			issued.redeem?.();
			const accessToken = randomToken();
			const jkt = dpop?.state === 'valid' ? dpop.jkt : undefined;
			tokens.set(accessToken, { clientId: issued.subject, resource: issued.resource, jkt });
			record({ ...entry, ok: true, status: 200, accessToken: short(accessToken), tokenType: jkt ? 'DPoP' : 'Bearer', jkt });
			sendJson(res, 200, { access_token: accessToken, token_type: jkt ? 'DPoP' : 'Bearer', expires_in: 3600, scope: issued.scope });
			return true;
		}
		return false;
	};

	// --- The protected resource over HTTP, and the PRM documents --------------------------------------
	const handleRs = async (req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<boolean> => {
		const at = { port: listen, path: route };
		if (req.method === 'GET' && httpResource && route === normalizedRoute(prmPath)) {
			record({ event: 'prm', ...at, resource: httpResource });
			sendJson(res, 200, prmFor(httpResource));
			return true;
		}
		if (req.method === 'GET' && grpcResource && route === GRPC_PRM_PATH) {
			record({ event: 'prm', ...at, resource: grpcResource });
			sendJson(res, 200, prmFor(grpcResource));
			return true;
		}
		if (route !== '/mcp' || !httpResource || upstreamPort === undefined) {
			return false;
		}
		const body = await readBody(req);
		const summary = jsonRpcSummary(body);
		const token = tokenValidFor(req.headers.authorization, httpResource, { proof: req.headers.dpop, method: req.method ?? 'GET', htu: `${origin}/mcp` });
		const entry = { event: 'mcp', ...at, httpMethod: req.method, methods: summary.methods, tools: summary.tools, authorization: token.state, scheme: token.scheme, token: short(token.bearer), dpopFailed: token.dpop?.failed.length ? token.dpop.failed : undefined, mcpProtocolVersion: req.headers['mcp-protocol-version'] };
		if (!accepted(token.state)) {
			const refusal = refusalOf(token.state, httpPrmUrl);
			record({ ...entry, status: 401, challenge: refusal.wwwAuthenticate.split(' ')[0], error: /error="([^"]+)"/.exec(refusal.wwwAuthenticate)?.[1] });
			res.writeHead(401, { 'www-authenticate': refusal.wwwAuthenticate, ...(refusal.nonce ? { 'dpop-nonce': refusal.nonce } : {}), 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid_token', error_description: 'a bearer token of this authorization server is required' }));
			return true;
		}
		// Forward to the upstream MCP server, response streamed back as it comes (JSON or SSE).
		const headers: http.OutgoingHttpHeaders = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (key !== 'authorization' && key !== 'dpop' && key !== 'host' && key !== 'connection' && key !== 'content-length' && value !== undefined) {
				headers[key] = value;
			}
		}
		headers['content-length'] = String(body.length);
		const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: '/mcp', method: req.method, headers }, upRes => {
			record({ ...entry, status: upRes.statusCode, contentType: upRes.headers['content-type'] });
			const outHeaders: http.OutgoingHttpHeaders = {};
			for (const [key, value] of Object.entries(upRes.headers)) {
				if (key !== 'connection' && key !== 'transfer-encoding' && value !== undefined) {
					outHeaders[key] = value;
				}
			}
			res.writeHead(upRes.statusCode ?? 502, outHeaders);
			upRes.pipe(res);
		});
		up.on('error', e => {
			record({ ...entry, status: 502, error: String(e) });
			if (!res.headersSent) {
				sendJson(res, 502, { error: String(e) });
			} else {
				res.destroy();
			}
		});
		res.on('close', () => up.destroy());
		up.end(body);
		return true;
	};

	const handler = (port: number, roles: { as: boolean; rs: boolean }) => async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
		const route = normalizedRoute(url.pathname);
		try {
			if (roles.rs && await handleRs(req, res, route)) {
				return;
			}
			if (roles.as && await handleAs(req, res, url, route, port)) {
				return;
			}
			record({ event: 'not-found', port, httpMethod: req.method, path: route });
			sendJson(res, 404, { error: 'not_found' });
		} catch (e) {
			record({ event: 'error', port, path: route, error: String(e) });
			if (!res.headersSent) {
				sendJson(res, 500, { error: String(e) });
			}
		}
	};

	const sameOrigin = asPort === listen;
	const rsServer = http.createServer(handler(listen, { as: sameOrigin, rs: true }));
	rsServer.listen(listen, '127.0.0.1', () => {
		console.log(`[oauth-fixture] resource ${resources.join(', ')} (PRM ${httpPrmUrl}), issuer ${issuer} (iss ${issMode}, grants ${asMetadata.grant_types_supported.join(' ')}, DPoP ${dpopMode}), log ${logFile}`);
		record({
			event: 'listening', resource: httpResource ?? grpcResource, resources, issuer, prmUrl: httpResource ? httpPrmUrl : grpcPrmUrl, issMode, listen, asPort, upstream: upstreamPort, grpcListen, grpcUpstream: grpcListen !== undefined ? grpcUpstream : undefined,
			grants: asMetadata.grant_types_supported, machineClient: machineClientId, workloadToken: workloadTokenOut && { file: workloadTokenOut, aud: workloadTokenAud === 'other' ? OTHER_AUDIENCE : issuer }, dpop: dpopMode,
		});
	});
	if (!sameOrigin) {
		http.createServer(handler(asPort, { as: true, rs: false })).listen(asPort, '127.0.0.1');
	}

	// --- The protected resource over gRPC (h2c) -----------------------------------------------------
	if (grpcListen !== undefined && grpcResource) {
		const upstreams = new WeakMap<http2.ServerHttp2Session, http2.ClientHttp2Session>();
		const grpc = http2.createServer();
		grpc.on('stream', (down, headers) => {
			const path = String(headers[':path'] ?? '');
			// A DPoP proof of a call names the HTTP/2 POST to the method's path (cleartext: http).
			const token = tokenValidFor(headers.authorization === undefined ? undefined : String(headers.authorization), grpcResource, { proof: headers.dpop, method: 'POST', htu: `http://127.0.0.1:${grpcListen}${path}` });
			const entry = { event: 'grpc', port: grpcListen, path, mcpMethod: headers['mcp-method'], mcpName: headers['mcp-name'], authorization: token.state, scheme: token.scheme, token: short(token.bearer), dpopFailed: token.dpop?.failed.length ? token.dpop.failed : undefined };
			down.on('error', () => undefined);
			if (!accepted(token.state)) {
				// A status-only UNAUTHENTICATED with the challenge, after the request (no message).
				const refusal = refusalOf(token.state, grpcPrmUrl);
				readBody(down).then(() => {
					if (!down.closed) {
						down.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '16', 'grpc-message': 'a bearer token of this authorization server is required', 'www-authenticate': refusal.wwwAuthenticate, ...(refusal.nonce ? { 'dpop-nonce': refusal.nonce } : {}) }, { endStream: true });
					}
					record({ ...entry, grpcStatus: '16', challenge: refusal.wwwAuthenticate.split(' ')[0], error: /error="([^"]+)"/.exec(refusal.wwwAuthenticate)?.[1] });
				}, () => undefined);
				return;
			}
			const session = down.session as http2.ServerHttp2Session;
			let upstream = upstreams.get(session);
			if (!upstream || upstream.closed || upstream.destroyed) {
				upstream = http2.connect(`http://127.0.0.1:${grpcUpstream}`);
				upstream.on('error', () => undefined);
				upstreams.set(session, upstream);
				const created = upstream;
				session.once('close', () => created.close());
			}
			const forward: http2.OutgoingHttpHeaders = {};
			for (const [key, value] of Object.entries(headers)) {
				if (!key.startsWith(':') && key !== 'authorization' && key !== 'dpop' && value !== undefined) {
					forward[key] = value;
				}
			}
			const up = upstream.request({ ...forward, ':method': 'POST', ':path': path });
			down.pipe(up);
			let trailers: http2.OutgoingHttpHeaders | undefined;
			up.on('response', (responseHeaders, flags) => {
				const out: http2.OutgoingHttpHeaders = { ':status': responseHeaders[':status'] ?? 200 };
				for (const [key, value] of Object.entries(responseHeaders)) {
					if (!key.startsWith(':') && value !== undefined) {
						out[key] = value;
					}
				}
				if (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) {
					down.respond(out, { endStream: true });
					record({ ...entry, grpcStatus: String(responseHeaders['grpc-status']) });
				} else {
					down.respond(out, { waitForTrailers: true });
				}
			});
			up.on('data', (chunk: Buffer) => {
				if (!down.closed) {
					down.write(chunk);
				}
			});
			up.on('trailers', (t: http2.IncomingHttpHeaders) => {
				trailers = {};
				for (const [key, value] of Object.entries(t)) {
					if (!key.startsWith(':') && value !== undefined) {
						trailers[key] = value;
					}
				}
			});
			down.on('wantTrailers', () => {
				const final = trailers ?? { 'grpc-status': '13' };
				down.sendTrailers(final);
				record({ ...entry, grpcStatus: String(final['grpc-status']) });
			});
			up.on('end', () => {
				if (down.headersSent && !down.writableEnded && !down.closed) {
					down.end();
				}
			});
			up.on('error', () => undefined);
			down.on('close', () => {
				if (!up.closed) {
					up.close(http2.constants.NGHTTP2_CANCEL);
				}
			});
		});
		grpc.listen(grpcListen, '127.0.0.1');
	}
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
