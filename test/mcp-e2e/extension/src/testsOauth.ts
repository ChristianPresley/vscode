/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mcpToolsOf } from './agent';
import { definitionIdOf } from './config';
import { E2eHarness, sleep, waitFor } from './harness';
import { MODERN_VERSION } from './gatewayClients';
import { assert, ITestCase, ITestContext } from './runner';
import { expectToolText, NEGOTIATED, windowLogLines } from './testHelpers';

/**
 * OAuth 2.1 sign-in (UI suite: the consent is a modal dialog that the Playwright driver answers):
 * runner/oauth-fixture.ts as the protected resource and the authorization server, and
 * runner/oauth-browser.ts as the browser. See README.md "OAuth 2.1 sign-in".
 *
 * The machine clients of the authorization extensions (API suite: no browser, no consent): the
 * client credentials grant with `private_key_jwt`, the workload identity grant and DPoP, against
 * the same fixture. See README.md "OAuth machine clients".
 */

/** One line of the log of runner/oauth-fixture.ts. */
interface IOAuthFixtureEvent {
	readonly event: 'listening' | 'prm' | 'as-metadata' | 'register' | 'authorize' | 'token' | 'mcp' | 'grpc' | 'not-found' | 'error';
	readonly t?: string;
	readonly port?: number;
	readonly path?: string;
	readonly ok?: boolean;
	readonly status?: number;
	readonly grpcStatus?: string;
	readonly checks?: Record<string, boolean>;
	readonly resource?: string | null;
	readonly resources?: readonly string[];
	readonly issuer?: string;
	readonly prmUrl?: string;
	readonly asPort?: number;
	readonly iss?: string | null;
	readonly grantType?: string | null;
	readonly codeChallengeMethod?: string | null;
	/**
	 * `mcp`, `grpc`: `none`, `not bearer`, `unknown bearer`, `bearer for another resource`, `valid bearer`,
	 * `bound token as bearer`, `unknown dpop token`, `dpop token for another resource`, `unbound token as dpop`,
	 * `dpop proof missing`, `dpop proof invalid`, `dpop nonce missing` or `valid dpop`.
	 */
	readonly authorization?: string;
	/** `mcp`, `grpc`: the scheme the token came with (`bearer`, `dpop`). */
	readonly scheme?: string;
	/** `mcp`, `grpc`: the failed checks of the DPoP proof. */
	readonly dpopFailed?: readonly string[];
	/** A refusal: the scheme of its challenge (`Bearer`, `DPoP`) and its `error`; `token`: the OAuth error. */
	readonly challenge?: string;
	readonly error?: string;
	readonly methods?: readonly string[];
	readonly tools?: readonly string[];
	readonly mcpName?: string;
	/** `token`: what was issued (`Bearer`, `DPoP`), the thumbprint of the key it is bound to, the scope asked for. */
	readonly tokenType?: string;
	readonly jkt?: string;
	readonly scope?: string | null;
	/** `token`: the DPoP proof of the request (`none`, `invalid`, `nonce`, `valid`). */
	readonly dpop?: { readonly state: string; readonly failed: readonly string[] } | string;
	/** `token`: the client assertion (`private_key_jwt`) or the workload identity JWT, decoded. */
	readonly assertion?: { readonly alg?: string; readonly kid?: string; readonly iss?: string; readonly sub?: string; readonly aud?: unknown; readonly lifetime?: number };
	readonly clientIdInBody?: boolean;
	/** `listening`: the grants the authorization server offers, and the workload JWT it wrote. */
	readonly grants?: readonly string[];
	readonly workloadToken?: { readonly file: string; readonly aud: string };
}

/** One line of the log of runner/oauth-browser.ts, the stand-in browser of the run (`workbench.externalBrowser`). */
export interface IOAuthBrowserEvent {
	readonly event: 'open' | 'mutation' | 'authorize-response' | 'redirect-response' | 'redirect' | 'error';
	readonly status?: number;
	readonly location?: string | null;
	readonly redirect?: { readonly iss?: string; readonly state?: boolean; readonly code?: string; readonly error?: string; readonly errorDescription?: string };
	/** `open`: what VS Code opened (`search` only for a URL the browser does not follow: not loopback). */
	readonly origin?: string;
	readonly pathname?: string;
	readonly search?: string;
	readonly followed?: boolean;
}

export const BROWSER_LOG = 'oauth-browser.jsonl';

interface ISignIn {
	readonly fixture: () => IOAuthFixtureEvent[];
	readonly browser: () => IOAuthBrowserEvent[];
	readonly listening: IOAuthFixtureEvent;
	readonly tools: readonly vscode.LanguageModelToolInformation[];
}

/**
 * Starts the server with one start command (a second one could start a second sign-in) and waits
 * until it has tools or `settled` says the sign-in is over; the Playwright driver answers the
 * consent dialog meanwhile.
 */
async function signIn(h: E2eHarness, ctx: ITestContext, label: string, waitMs: number, settled?: (events: IOAuthFixtureEvent[], browser: IOAuthBrowserEvent[]) => boolean): Promise<ISignIn> {
	const fixtureLog = `${label}.oauth.jsonl`;
	const fixtureBefore = h.jsonLines<IOAuthFixtureEvent>(fixtureLog).length;
	const browserBefore = h.jsonLines<IOAuthBrowserEvent>(BROWSER_LOG).length;
	const listening = h.jsonLines<IOAuthFixtureEvent>(fixtureLog).find(e => e.event === 'listening');
	assert(listening?.issuer, `runner/oauth-fixture.ts is not running for ${label} (no listening line in ${fixtureLog})`);
	const fixture = () => h.jsonLines<IOAuthFixtureEvent>(fixtureLog).slice(fixtureBefore);
	const browser = () => h.jsonLines<IOAuthBrowserEvent>(BROWSER_LOG).slice(browserBefore);
	const started = Date.now();
	const start = Promise.resolve(vscode.commands.executeCommand('workbench.mcp.startServer', definitionIdOf(h.server(label)), { waitForLiveTools: true }))
		.then(() => 'resolved', (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`);
	const tools = await waitFor(`the tools of ${label} after the sign-in`, waitMs, () => {
		const list = mcpToolsOf(label);
		if (list.length) {
			return list;
		}
		return settled?.(fixture(), browser()) ? [] : undefined;
	}, 500).catch(() => []);
	ctx.details.startMs = Date.now() - started;
	ctx.details.startCommand = await Promise.race([start, sleep(1000).then(() => 'pending')]);
	ctx.details.fixture = fixture().map(e => ({ event: e.event, port: e.port, path: e.path, ok: e.ok, status: e.status ?? e.grpcStatus, authorization: e.authorization, methods: e.methods, checks: e.checks, resource: e.resource, iss: e.iss }));
	ctx.details.browser = browser();
	ctx.details.logLines = h.serverLog(label).split('\n').filter(l => /\[(error|warning)\]|Connection state/.test(l)).slice(-5);
	return { fixture, browser, listening, tools };
}

/** The checks of a successful sign-in, from the fixture's log, for an HTTP or a gRPC resource. */
function assertSignedIn(events: readonly IOAuthFixtureEvent[], resource: string, kind: 'mcp' | 'grpc'): void {
	const requests = events.filter(e => e.event === kind);
	const first = requests[0];
	assert(first?.authorization === 'none' && (kind === 'mcp' ? first.status === 401 : first.grpcStatus === '16'), `the first ${kind === 'mcp' ? 'MCP request' : 'gRPC call'} was ${JSON.stringify(first)}, expected one without a token, refused (${kind === 'mcp' ? '401' : 'grpc-status 16'})`);
	const register = events.find(e => e.event === 'register');
	assert(register?.ok, `the dynamic client registration failed or was not made: ${JSON.stringify(register)}`);
	const authorize = events.filter(e => e.event === 'authorize');
	assert(authorize.length === 1, `expected one authorization request, got ${authorize.length}: ${JSON.stringify(authorize)}`);
	const failed = Object.entries(authorize[0].checks ?? {}).filter(([, ok]) => !ok).map(([name]) => name);
	assert(authorize[0].ok && !failed.length, `the authorization request failed the checks ${JSON.stringify(failed)}: ${JSON.stringify(authorize[0])}`);
	assert(authorize[0].codeChallengeMethod === 'S256' && authorize[0].resource === resource, `the authorization request used code_challenge_method ${authorize[0].codeChallengeMethod} and resource ${authorize[0].resource}, expected S256 and ${resource}`);
	const tokens = events.filter(e => e.event === 'token');
	const granted = tokens.find(e => e.ok);
	assert(granted && tokens.length === 1, `expected one successful token request, got ${JSON.stringify(tokens)}`);
	assert(granted.grantType === 'authorization_code' && granted.checks?.pkceVerified && granted.checks.resourceMatches && granted.resource === resource, `the token request: ${JSON.stringify(granted)}`);
	const after = events.slice(events.indexOf(granted) + 1).filter(e => e.event === kind);
	const unauthorized = after.filter(e => e.authorization !== 'valid bearer');
	assert(after.length > 0 && !unauthorized.length, `${unauthorized.length} of the ${after.length} requests after the token request did not carry the issued bearer token: ${JSON.stringify(unauthorized.slice(0, 3))}`);
}

function issScenario(h: E2eHarness, label: 'zig-oauth-iss-wrong' | 'zig-oauth-iss-omit'): ITestCase {
	const mode = label === 'zig-oauth-iss-wrong' ? 'a wrong iss' : 'no iss although the metadata announces it';
	return {
		name: `oauth RFC 9207 (${label}): an authorization response with ${mode} is rejected: no token request, no tools, and VS Code logs the rejection`,
		group: 'oauth',
		timeoutMs: 200_000,
		fn: async ctx => {
			let settledAt: number | undefined;
			const run = await signIn(h, ctx, label, 120_000, (events, browser) => {
				// Over once VS Code's loopback server got the response; give VS Code 10 s to (wrongly) exchange the code.
				if (events.some(e => e.event === 'token')) {
					return true;
				}
				if (browser.some(e => e.event === 'redirect-response')) {
					settledAt ??= Date.now();
					return Date.now() - settledAt > 10_000;
				}
				return false;
			});
			const events = run.fixture();
			const authorize = events.find(e => e.event === 'authorize');
			assert(authorize?.ok, `the sign-in did not reach the authorization request: ${JSON.stringify(ctx.details.fixture)}`);
			const sentIss = run.browser().find(e => e.event === 'authorize-response')?.redirect?.iss;
			ctx.details.sentIss = sentIss ?? null;
			assert(label === 'zig-oauth-iss-wrong' ? sentIss !== undefined && sentIss !== run.listening.issuer : sentIss === undefined, `the fixture sent iss ${JSON.stringify(sentIss)} (issuer ${run.listening.issuer})`);
			assert(!events.some(e => e.event === 'token'), `VS Code exchanged the code although the authorization response had ${mode}: ${JSON.stringify(events.filter(e => e.event === 'token'))}`);
			assert(run.tools.length === 0 && mcpToolsOf(label).length === 0, `${label} has tools: the sign-in succeeded with ${mode}`);
			assert(events.filter(e => e.event === 'mcp').every(e => e.authorization !== 'valid bearer'), 'an MCP request carried a valid token');
			const rejected = windowLogLines(h, /Rejecting the authorization response/);
			ctx.details.rejected = rejected.slice(0, 3);
			assert(rejected.some(r => /\biss\b|issuer/i.test(r.line)), `VS Code did not log that it rejected the authorization response for its iss: ${JSON.stringify(rejected.slice(0, 3))}`);
		},
	};
}

/** The OAuth scenarios of the UI suite, by the id the Playwright driver runs them with. */
export function oauthScenarios(h: E2eHarness): Map<string, ITestCase> {
	const scenarios = new Map<string, ITestCase>();
	scenarios.set('oauth', {
		name: 'oauth (zig-oauth, resource and authorization server on different origins): 401 with resource_metadata at a custom path, RFC 9728 PRM from that URL, RFC 8414 metadata with path insertion on the AS origin, DCR, consent, PKCE S256, RFC 8707 resource, iss; afterwards every MCP request carries the bearer token and test_simple_text works',
		group: 'oauth',
		timeoutMs: 240_000,
		fn: async ctx => {
			const label = 'zig-oauth';
			const run = await signIn(h, ctx, label, 150_000);
			assert(run.tools.length > 0, `${label} has no tools after ${ctx.details.startMs} ms; fixture: ${JSON.stringify(ctx.details.fixture)}; browser: ${JSON.stringify(ctx.details.browser)}; log: ${JSON.stringify(ctx.details.logLines)}`);
			await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response'], { require: false });
			const events = await waitFor('the tools/call of test_simple_text in the fixture log', 10_000, () => {
				const list = run.fixture();
				return list.some(e => e.event === 'mcp' && e.tools?.includes('test_simple_text') && e.authorization === 'valid bearer') ? list : undefined;
			}, 250);
			const resource = run.listening.resource ?? '';
			assertSignedIn(events, resource, 'mcp');
			// Discovery driven by the challenge and the PRM: the PRM at the URL the challenge named
			// (not a well-known path), the authorization server metadata on the issuer's own origin
			// with the RFC 8414 path insertion (/.well-known/oauth-authorization-server/tenant).
			const prmUrl = new URL(run.listening.prmUrl ?? '');
			const issuer = new URL(run.listening.issuer ?? '');
			const prm = events.filter(e => e.event === 'prm');
			assert(prm[0]?.port === Number(prmUrl.port) && prm[0].path === prmUrl.pathname, `the first PRM request went to ${JSON.stringify(prm[0])}, expected ${prmUrl}`);
			const asMetadata = events.filter(e => e.event === 'as-metadata');
			assert(asMetadata[0]?.port === Number(issuer.port) && asMetadata[0].path === `/.well-known/oauth-authorization-server${issuer.pathname}`, `the first AS metadata request went to ${JSON.stringify(asMetadata[0])}, expected ${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`);
			for (const event of ['register', 'authorize', 'token'] as const) {
				const e = events.find(x => x.event === event);
				assert(e?.port === Number(issuer.port) && e.path?.startsWith(issuer.pathname), `${event} went to ${JSON.stringify(e && { port: e.port, path: e.path })}, expected the authorization server ${issuer.href}`);
			}
			// The redirect the browser followed carried iss; VS Code's loopback server took it (it checks the
			// state there, iss when it validates the response: the zig-oauth-iss-* scenarios fail on it).
			const redirect = run.browser().find(e => e.event === 'authorize-response')?.redirect;
			assert(redirect !== undefined && redirect.iss === run.listening.issuer && redirect.state && redirect.code, `the authorization response the browser followed was ${JSON.stringify(redirect)}, expected code, state and iss ${run.listening.issuer}`);
			const callback = run.browser().find(e => e.event === 'redirect-response');
			assert(callback?.status === 302 && callback.location === '/done', `VS Code's loopback redirect URI answered ${JSON.stringify(callback)}, expected a redirect to /done`);
			assert(events.some(e => e.event === 'mcp' && e.tools?.includes('test_simple_text') && e.status === 200), 'the tools/call of test_simple_text did not reach the server with the token');
			const negotiated = await h.waitForLogLine(label, NEGOTIATED);
			ctx.details.negotiated = negotiated[0];
			assert(negotiated[1] === MODERN_VERSION, `${label} negotiated ${negotiated[1]}`);
		},
	});
	scenarios.set('oauth-iss-wrong', issScenario(h, 'zig-oauth-iss-wrong'));
	scenarios.set('oauth-iss-omit', issScenario(h, 'zig-oauth-iss-omit'));
	scenarios.set('oauth-grpc', {
		name: 'oauth over gRPC (zig-grpc-oauth): a call without a token ends UNAUTHENTICATED with www-authenticate, VS Code signs in (PRM resource https://127.0.0.1:<port>/, S256, resource), and afterwards every call carries the bearer token and test_simple_text works',
		group: 'oauth',
		timeoutMs: 240_000,
		fn: async ctx => {
			const label = 'zig-grpc-oauth';
			const run = await signIn(h, ctx, label, 150_000);
			assert(run.tools.length > 0, `${label} has no tools after ${ctx.details.startMs} ms; fixture: ${JSON.stringify(ctx.details.fixture)}; browser: ${JSON.stringify(ctx.details.browser)}; log: ${JSON.stringify(ctx.details.logLines)}`);
			await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response'], { require: false });
			const events = await waitFor('the tools/call of test_simple_text in the fixture log', 10_000, () => {
				const list = run.fixture();
				return list.some(e => e.event === 'grpc' && e.mcpName === 'test_simple_text' && e.authorization === 'valid bearer') ? list : undefined;
			}, 250);
			const resource = `https://127.0.0.1:${new URL(h.server(label).mcp?.url ?? '').port}/`;
			const prm = events.find(e => e.event === 'prm');
			assert(prm?.resource === resource, `the PRM VS Code fetched names ${prm?.resource}, expected ${resource}`);
			assertSignedIn(events, resource, 'grpc');
		},
	});
	return scenarios;
}

// --- The machine clients of the authorization extensions (API suite) -------------------------------

/** The scope of the fixture's challenge, which a token request asks for. */
const FIXTURE_SCOPE = 'mcp:tools';
/** The client id and `kid` of the machine client (mcp.json `oauth.clientId`, `oauth.keyId`; runner/oauth-credentials.ts). */
const MACHINE_CLIENT_ID = 'mcp-e2e-machine';
const CLIENT_KEY_ID = 'mcp-e2e-client-key';
const GRANT_JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const WORKLOAD_SUBJECT = 'system:serviceaccount:mcp-e2e:vscode';
/** How a request with an accepted token shows in the fixture log. */
const VALID_TOKEN = new Set(['valid bearer', 'valid dpop']);

interface IMachineStart {
	readonly fixture: () => IOAuthFixtureEvent[];
	readonly listening: IOAuthFixtureEvent;
	/** The browser log lines since the start: a machine client opens none. */
	readonly browser: () => IOAuthBrowserEvent[];
}

/**
 * Starts a server whose `oauth.grant` is a machine grant and waits until a request with an
 * accepted token reached the fixture, or `settled` says the attempt is over. A server that ran
 * before (`chat.mcp.autostart`) is stopped first: a machine client's token lives with its
 * connection, so the start runs the grant again.
 */
async function machineStart(h: E2eHarness, ctx: ITestContext, label: string, waitMs: number, settled?: (events: IOAuthFixtureEvent[]) => boolean): Promise<IMachineStart> {
	const fixtureLog = `${label}.oauth.jsonl`;
	const listening = h.jsonLines<IOAuthFixtureEvent>(fixtureLog).find(e => e.event === 'listening');
	assert(listening?.issuer, `runner/oauth-fixture.ts is not running for ${label} (no listening line in ${fixtureLog})`);
	const id = definitionIdOf(h.server(label));
	await vscode.commands.executeCommand('workbench.mcp.stopServer', id);
	const fixtureBefore = h.jsonLines<IOAuthFixtureEvent>(fixtureLog).length;
	const browserBefore = h.jsonLines<IOAuthBrowserEvent>(BROWSER_LOG).length;
	const fixture = () => h.jsonLines<IOAuthFixtureEvent>(fixtureLog).slice(fixtureBefore);
	const browser = () => h.jsonLines<IOAuthBrowserEvent>(BROWSER_LOG).slice(browserBefore);
	const kind = h.server(label).grpc ? 'grpc' : 'mcp';
	const started = Date.now();
	const start = Promise.resolve(vscode.commands.executeCommand('workbench.mcp.startServer', id, { waitForLiveTools: true }))
		.then(() => 'resolved', (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`);
	await waitFor(`a request of ${label} with an accepted token`, waitMs, () => {
		const events = fixture();
		return events.some(e => e.event === kind && VALID_TOKEN.has(e.authorization ?? '')) || settled?.(events) ? true : undefined;
	}, 500).catch(() => undefined);
	ctx.details.startMs = Date.now() - started;
	ctx.details.startCommand = await Promise.race([start, sleep(1000).then(() => 'pending')]);
	ctx.details.fixture = fixture().map(e => ({
		event: e.event, port: e.port, path: e.path, ok: e.ok, status: e.status ?? e.grpcStatus, grantType: e.grantType, authorization: e.authorization, scheme: e.scheme, challenge: e.challenge, error: e.error,
		dpop: e.dpop, dpopFailed: e.dpopFailed, tokenType: e.tokenType, methods: e.methods, mcpName: e.mcpName, failed: e.checks && Object.entries(e.checks).filter(([, ok]) => !ok).map(([name]) => name), assertion: e.assertion,
	}));
	ctx.details.logLines = h.serverLog(label).split('\n').filter(l => /\[(error|warning)\]|Connection state/.test(l)).slice(-5);
	return { fixture, listening, browser };
}

/**
 * The checks of a machine client's grant, from the fixture's log: the first request without a
 * token is refused with the resource's challenge, VS Code reads the PRM and the authorization
 * server metadata, registers nothing and authorizes nothing (no browser), and its one grant (with
 * DPoP: after one `use_dpop_nonce` round) is issued for the resource and the challenge's scope.
 * Every request after it carries the token; with DPoP each one a valid proof (the resource asks
 * for its nonce once). Returns the token request that was granted.
 */
function assertMachineGrant(events: readonly IOAuthFixtureEvent[], browser: readonly IOAuthBrowserEvent[], resource: string, grantType: string, kind: 'mcp' | 'grpc', dpop: boolean): IOAuthFixtureEvent {
	const requests = events.filter(e => e.event === kind);
	const first = requests[0];
	assert(first?.authorization === 'none' && (kind === 'mcp' ? first.status === 401 : first.grpcStatus === '16') && first.challenge === (dpop ? 'DPoP' : 'Bearer'),
		`the first ${kind === 'mcp' ? 'MCP request' : 'gRPC call'} was ${JSON.stringify(first)}, expected one without a token, refused with a ${dpop ? 'DPoP' : 'Bearer'} challenge`);
	assert(events.some(e => e.event === 'prm' && e.resource === resource) && events.some(e => e.event === 'as-metadata'), `VS Code did not read the PRM of ${resource} and the authorization server metadata: ${JSON.stringify(events.filter(e => e.event === 'prm' || e.event === 'as-metadata'))}`);
	const interactive = events.filter(e => e.event === 'register' || e.event === 'authorize');
	assert(!interactive.length && !browser.length, `a machine client registered, authorized or opened a browser: ${JSON.stringify([...interactive, ...browser].slice(0, 3))}`);
	const tokens = events.filter(e => e.event === 'token');
	const granted = tokens.filter(e => e.ok);
	if (dpop) {
		const round = tokens[0];
		assert(tokens.length === 2 && round.error === 'use_dpop_nonce' && typeof round.dpop === 'object' && round.dpop.state === 'nonce' && granted.length === 1 && granted[0] === tokens[1],
			`expected a token request answered use_dpop_nonce, then one granted with the nonce: ${JSON.stringify(tokens)}`);
	} else {
		assert(tokens.length === 1 && granted.length === 1, `expected one successful token request, got ${JSON.stringify(tokens)}`);
	}
	const token = granted[0];
	assert(token.grantType === grantType && token.resource === resource && token.scope === FIXTURE_SCOPE, `the token request: grant ${token.grantType}, resource ${token.resource}, scope ${token.scope}; expected ${grantType}, ${resource}, ${FIXTURE_SCOPE}`);
	assert(token.tokenType === (dpop ? 'DPoP' : 'Bearer') && (!dpop || (typeof token.dpop === 'object' && token.dpop.state === 'valid' && !!token.jkt)), `the token request was issued a ${token.tokenType} token (proof ${JSON.stringify(token.dpop)}), expected ${dpop ? 'a DPoP-bound token for a valid proof' : 'a bearer token'}`);
	const presented = dpop ? 'valid dpop' : 'valid bearer';
	const after = events.slice(events.indexOf(token) + 1).filter(e => e.event === kind);
	// With DPoP the resource's first answer to the token is use_dpop_nonce; a request signed before VS Code had the nonce gets it too.
	const unexpected = after.filter(e => e.authorization !== presented && !(dpop && e.authorization === 'dpop nonce missing' && e.error === 'use_dpop_nonce'));
	assert(after.some(e => e.authorization === presented) && !unexpected.length, `${unexpected.length} of the ${after.length} requests after the token request did not carry the token${dpop ? ' with a valid proof' : ''}: ${JSON.stringify(unexpected.slice(0, 3))}`);
	if (dpop) {
		assert(after.some(e => e.authorization === 'dpop nonce missing'), `the resource asks for its DPoP nonce once, but no request after the token request was answered use_dpop_nonce: ${JSON.stringify(after.slice(0, 3))}`);
	}
	return token;
}

/** The tools/call of test_simple_text through VS Code, and its record in the fixture log with the token. */
async function callThroughFixture(h: E2eHarness, ctx: ITestContext, label: string, run: IMachineStart, dpop: boolean): Promise<IOAuthFixtureEvent[]> {
	await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response'], { require: false });
	const kind = h.server(label).grpc ? 'grpc' : 'mcp';
	const presented = dpop ? 'valid dpop' : 'valid bearer';
	return waitFor('the tools/call of test_simple_text in the fixture log', 10_000, () => {
		const list = run.fixture();
		return list.some(e => e.event === kind && e.authorization === presented && (kind === 'mcp' ? e.tools?.includes('test_simple_text') && e.status === 200 : e.mcpName === 'test_simple_text' && e.grpcStatus === '0')) ? list : undefined;
	}, 250);
}

/** A failed token request (one not answered `use_dpop_nonce`) ends the attempt: the scenario need not wait for a token. */
function tokenRefused(events: readonly IOAuthFixtureEvent[]): boolean {
	return events.some(e => e.event === 'token' && e.ok === false && e.error !== 'use_dpop_nonce');
}

/** The OAuth tests of the API suite: machine clients, which need neither a browser nor a consent. */
export function oauthMachineTests(h: E2eHarness): ITestCase[] {
	const httpResource = (label: string) => h.server(label).mcp?.url ?? '';
	const noTools = (label: string, ctx: ITestContext) => `${label} has no tools after ${ctx.details.startMs} ms; fixture: ${JSON.stringify(ctx.details.fixture)}; log: ${JSON.stringify(ctx.details.logLines)}`;
	return [
		{
			name: 'oauth client credentials (zig-oauth-client-credentials): a Bearer challenge, RFC 9728 PRM and RFC 8414 metadata, then the client credentials grant of the pre-registered client, authenticated with private_key_jwt (ES256 with its kid, iss = sub = the client id, aud the issuer, at most 5 minutes, no secret, no client_id), for the RFC 8707 resource and the scope of the challenge; no registration, no authorization request, no browser; afterwards every MCP request carries the token and test_simple_text works',
			group: 'oauth',
			timeoutMs: 120_000,
			fn: async ctx => {
				const label = 'zig-oauth-client-credentials';
				const run = await machineStart(h, ctx, label, 60_000, tokenRefused);
				assert(mcpToolsOf(label).length > 0, noTools(label, ctx));
				const events = await callThroughFixture(h, ctx, label, run, false);
				const token = assertMachineGrant(events, run.browser(), httpResource(label), 'client_credentials', 'mcp', false);
				const assertion = token.assertion;
				ctx.details.assertion = assertion;
				assert(assertion?.alg === 'ES256' && assertion.kid === CLIENT_KEY_ID && assertion.iss === MACHINE_CLIENT_ID && assertion.sub === MACHINE_CLIENT_ID && assertion.aud === run.listening.issuer,
					`the client assertion has ${JSON.stringify(assertion)}, expected ES256, kid ${CLIENT_KEY_ID}, iss and sub ${MACHINE_CLIENT_ID}, aud ${run.listening.issuer}`);
				assert(typeof assertion.lifetime === 'number' && assertion.lifetime > 0 && assertion.lifetime <= 300, `the client assertion is valid for ${assertion.lifetime} s, expected at most 300`);
				assert(token.clientIdInBody === false && token.checks?.noClientSecret, `the token request sent client_id (${token.clientIdInBody}) or a secret (${!token.checks?.noClientSecret}): the assertion alone names the client`);
				const negotiated = await h.waitForLogLine(label, NEGOTIATED);
				assert(negotiated[1] === MODERN_VERSION, `${label} negotiated ${negotiated[1]}`);
			},
		},
		{
			name: 'oauth workload identity (zig-oauth-wif): VS Code reads the workload JWT from oauth.workloadIdentityTokenFile and sends it in the JWT authorization grant (RFC 7523) without client authentication, for the resource and the scope of the challenge; the authorization server verifies it (the signature of the workload identity provider, iss, sub, aud the issuer, unexpired); afterwards every MCP request carries the token and test_simple_text works',
			group: 'oauth',
			timeoutMs: 120_000,
			fn: async ctx => {
				const label = 'zig-oauth-wif';
				const run = await machineStart(h, ctx, label, 60_000, tokenRefused);
				assert(mcpToolsOf(label).length > 0, noTools(label, ctx));
				const events = await callThroughFixture(h, ctx, label, run, false);
				const token = assertMachineGrant(events, run.browser(), httpResource(label), GRANT_JWT_BEARER, 'mcp', false);
				ctx.details.assertion = token.assertion;
				assert(token.assertion?.sub === WORKLOAD_SUBJECT && token.assertion.aud === run.listening.issuer && token.checks?.assertionSignature && token.checks.noClientAuthentication,
					`the JWT grant carried ${JSON.stringify(token.assertion)} (checks ${JSON.stringify(token.checks)}), expected the workload JWT of ${run.listening.workloadToken?.file} without client authentication`);
			},
		},
		{
			name: 'oauth workload identity, wrong audience (zig-oauth-wif-wrong-aud): the workload JWT names another authorization server as its audience: VS Code discovers the authorization server but does not send the JWT to it (no token request), the server gets no tools, and VS Code logs that the JWT is not sent because of its audience',
			group: 'oauth',
			timeoutMs: 120_000,
			fn: async ctx => {
				const label = 'zig-oauth-wif-wrong-aud';
				let discoveredAt: number | undefined;
				const run = await machineStart(h, ctx, label, 60_000, events => {
					// Over once VS Code read the authorization server metadata; give it 10 s to (wrongly) send the JWT.
					if (events.some(e => e.event === 'token')) {
						return true;
					}
					if (events.some(e => e.event === 'as-metadata')) {
						discoveredAt ??= Date.now();
						return Date.now() - discoveredAt > 10_000;
					}
					return false;
				});
				const events = run.fixture();
				assert(run.listening.workloadToken?.aud !== run.listening.issuer, `the fixture wrote a workload JWT for ${run.listening.workloadToken?.aud}, its own issuer: this scenario needs another audience`);
				assert(events.some(e => e.event === 'as-metadata'), `VS Code did not get as far as the authorization server metadata: ${JSON.stringify(ctx.details.fixture)}`);
				assert(!events.some(e => e.event === 'token'), `VS Code sent the workload JWT for ${run.listening.workloadToken?.aud} to ${run.listening.issuer}: ${JSON.stringify(events.filter(e => e.event === 'token'))}`);
				assert(mcpToolsOf(label).length === 0 && !events.some(e => e.event === 'mcp' && VALID_TOKEN.has(e.authorization ?? '')), `${label} has tools or a request with a token: the grant succeeded with a JWT for another audience`);
				const refused = windowLogLines(h, /workload identity JWT .* is not sent to/);
				ctx.details.refused = refused.slice(0, 3);
				assert(refused.some(r => /audience/.test(r.line)), `VS Code did not log that it does not send the workload JWT because of its audience: ${JSON.stringify(refused.slice(0, 3))}`);
			},
		},
		{
			name: 'oauth DPoP (zig-oauth-dpop): the resource requires DPoP-bound tokens (PRM dpop_bound_access_tokens_required, a DPoP challenge) and mcp.json does not set oauth.dpop: the client credentials token request carries a DPoP proof, answers the use_dpop_nonce of the authorization server once and gets a DPoP token bound to the key of the proof; every MCP request then carries Authorization: DPoP with a fresh proof (htm, htu, ath, the bound key), the use_dpop_nonce of the resource is answered, and test_simple_text works',
			group: 'oauth',
			timeoutMs: 120_000,
			fn: async ctx => {
				const label = 'zig-oauth-dpop';
				const run = await machineStart(h, ctx, label, 60_000, tokenRefused);
				assert(mcpToolsOf(label).length > 0, noTools(label, ctx));
				const events = await callThroughFixture(h, ctx, label, run, true);
				const token = assertMachineGrant(events, run.browser(), httpResource(label), 'client_credentials', 'mcp', true);
				ctx.details.jkt = token.jkt;
				// The authorization server is on its own origin, so its nonce is not the resource's.
				const issuer = new URL(run.listening.issuer ?? '');
				assert(token.port === Number(issuer.port) && issuer.port !== new URL(httpResource(label)).port, `the token request went to port ${token.port}, expected the authorization server on its own origin ${issuer.origin}`);
			},
		},
		{
			name: 'oauth DPoP over gRPC (zig-grpc-oauth-dpop): a call without a token ends UNAUTHENTICATED with a DPoP challenge; VS Code gets a DPoP-bound client credentials token (after the use_dpop_nonce of the authorization server) for the resource https://127.0.0.1:<port>/, and every call then carries Authorization: DPoP with a proof of its own (htu http://<authority>/<method path>), answers the use_dpop_nonce of the resource in the trailers, and test_simple_text works',
			group: 'oauth',
			timeoutMs: 120_000,
			fn: async ctx => {
				const label = 'zig-grpc-oauth-dpop';
				const run = await machineStart(h, ctx, label, 60_000, tokenRefused);
				assert(mcpToolsOf(label).length > 0, noTools(label, ctx));
				const events = await callThroughFixture(h, ctx, label, run, true);
				const resource = `https://127.0.0.1:${new URL(h.server(label).mcp?.url ?? '').port}/`;
				ctx.details.jkt = assertMachineGrant(events, run.browser(), resource, 'client_credentials', 'grpc', true).jkt;
			},
		},
	];
}
