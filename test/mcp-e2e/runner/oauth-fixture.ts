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
//
// Every request is one JSON line in the log (`event`: prm, as-metadata, register, authorize, token,
// mcp, grpc, not-found) with what was checked and the port and path it came to; tokens and codes are
// logged as their first 8 characters.
//
// Usage: node runner/oauth-fixture.ts --listen <port> --log <file.jsonl> [--upstream <port>]
//        [--as-port <port>] [--as-path </path>] [--prm-path </path>] [--iss-mode ok|wrong|omit]
//        [--grpc-listen <port> --grpc-upstream <port>]

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as http2 from 'node:http2';

const SCOPE = 'mcp:tools';
const RESOURCE_NAME = 'MCP E2E OAuth fixture';
const GRPC_PRM_PATH = '/.well-known/oauth-protected-resource/grpc';
const DEFAULT_PRM_PATH = '/.well-known/oauth-protected-resource/mcp';

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
	if (!Number.isInteger(listen) || !logFile || !Number.isInteger(asPort) || !['ok', 'wrong', 'omit'].includes(issMode)
		|| (upstreamPort !== undefined && !Number.isInteger(upstreamPort)) || (grpcListen !== undefined && (!Number.isInteger(grpcListen) || !Number.isInteger(grpcUpstream)))) {
		console.error('usage: oauth-fixture.ts --listen <port> --log <file.jsonl> [--upstream <port>] [--as-port <port>] [--as-path </path>] [--prm-path </path>] [--iss-mode ok|wrong|omit] [--grpc-listen <port> --grpc-upstream <port>]');
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
	const tokens = new Map<string, { clientId: string; resource: string | undefined }>();
	let clientCount = 0;
	const issFor = (): string | undefined => issMode === 'ok' ? issuer : issMode === 'wrong' ? `${issuer}/not-the-issuer` : undefined;

	const asMetadata = {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		registration_endpoint: `${issuer}/register`,
		scopes_supported: [SCOPE],
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code'],
		token_endpoint_auth_methods_supported: ['none'],
		code_challenge_methods_supported: ['S256'],
		authorization_response_iss_parameter_supported: true,
	};
	const prmFor = (resource: string) => ({ resource, authorization_servers: [issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: RESOURCE_NAME });
	const tokenValidFor = (authorization: string | undefined, resource: string | undefined): { bearer: string | undefined; state: string } => {
		const bearer = /^Bearer (\S+)$/i.exec(authorization ?? '')?.[1];
		const token = bearer === undefined ? undefined : tokens.get(bearer);
		return {
			bearer,
			state: authorization === undefined ? 'none' : bearer === undefined ? 'not bearer' : !token ? 'unknown bearer' : token.resource !== resource ? 'bearer for another resource' : 'valid bearer',
		};
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
			const code = p.get('code') ?? '';
			const stored = codes.get(code);
			const verifier = p.get('code_verifier') ?? '';
			const checks = {
				grantAuthorizationCode: grantType === 'authorization_code',
				codeValid: !!stored && !stored.used,
				clientMatches: !!stored && p.get('client_id') === stored.clientId,
				redirectUriMatches: !!stored && p.get('redirect_uri') === stored.redirectUri,
				pkceVerified: !!stored && verifier.length >= 43 && s256(verifier) === stored.codeChallenge,
				resourcePresent: p.get('resource') !== null,
				resourceMatches: resources.includes(p.get('resource') ?? '') && (!stored || stored.resource === p.get('resource')),
			};
			const entry = { event: 'token', ...at, grantType, clientId: p.get('client_id'), redirectUri: p.get('redirect_uri'), resource: p.get('resource'), code: short(code), codeVerifierLength: verifier.length, clientAuthorization: req.headers.authorization ? 'present' : 'none', checks };
			if (!Object.values(checks).every(Boolean)) {
				record({ ...entry, ok: false });
				sendJson(res, 400, { error: grantType === 'authorization_code' ? 'invalid_grant' : 'unsupported_grant_type', error_description: `failed checks: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(', ')}` });
				return true;
			}
			stored!.used = true;
			const accessToken = randomToken();
			tokens.set(accessToken, { clientId: stored!.clientId, resource: stored!.resource });
			record({ ...entry, ok: true, accessToken: short(accessToken) });
			sendJson(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: stored!.scope ?? SCOPE });
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
		const token = tokenValidFor(req.headers.authorization, httpResource);
		const entry = { event: 'mcp', ...at, httpMethod: req.method, methods: summary.methods, tools: summary.tools, authorization: token.state, token: short(token.bearer), mcpProtocolVersion: req.headers['mcp-protocol-version'] };
		if (token.state !== 'valid bearer') {
			record({ ...entry, status: 401 });
			res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${httpPrmUrl}", scope="${SCOPE}"`, 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'invalid_token', error_description: 'a bearer token of this authorization server is required' }));
			return true;
		}
		// Forward to the upstream MCP server, response streamed back as it comes (JSON or SSE).
		const headers: http.OutgoingHttpHeaders = {};
		for (const [key, value] of Object.entries(req.headers)) {
			if (key !== 'authorization' && key !== 'host' && key !== 'connection' && key !== 'content-length' && value !== undefined) {
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
		console.log(`[oauth-fixture] resource ${resources.join(', ')} (PRM ${httpPrmUrl}), issuer ${issuer} (iss ${issMode}), log ${logFile}`);
		record({ event: 'listening', resource: httpResource ?? grpcResource, resources, issuer, prmUrl: httpResource ? httpPrmUrl : grpcPrmUrl, issMode, listen, asPort, upstream: upstreamPort, grpcListen, grpcUpstream: grpcListen !== undefined ? grpcUpstream : undefined });
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
			const token = tokenValidFor(headers.authorization === undefined ? undefined : String(headers.authorization), grpcResource);
			const entry = { event: 'grpc', port: grpcListen, path, mcpMethod: headers['mcp-method'], mcpName: headers['mcp-name'], authorization: token.state, token: short(token.bearer) };
			down.on('error', () => undefined);
			if (token.state !== 'valid bearer') {
				// A status-only UNAUTHENTICATED with the challenge, after the request (no message).
				readBody(down).then(() => {
					if (!down.closed) {
						down.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '16', 'grpc-message': 'a bearer token of this authorization server is required', 'www-authenticate': `Bearer resource_metadata="${grpcPrmUrl}", scope="${SCOPE}"` }, { endStream: true });
					}
					record({ ...entry, grpcStatus: '16' });
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
				if (!key.startsWith(':') && key !== 'authorization' && value !== undefined) {
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
