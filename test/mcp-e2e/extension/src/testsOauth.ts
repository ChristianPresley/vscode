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
 */

/** One line of the log of runner/oauth-fixture.ts. */
interface IOAuthFixtureEvent {
	readonly event: 'listening' | 'prm' | 'as-metadata' | 'register' | 'authorize' | 'token' | 'mcp' | 'grpc' | 'not-found' | 'error';
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
	/** `mcp`, `grpc`: `none`, `not bearer`, `unknown bearer`, `bearer for another resource` or `valid bearer`. */
	readonly authorization?: string;
	readonly methods?: readonly string[];
	readonly tools?: readonly string[];
	readonly mcpName?: string;
}

/** One line of the log of runner/oauth-browser.ts. */
interface IOAuthBrowserEvent {
	readonly event: 'open' | 'mutation' | 'authorize-response' | 'redirect-response' | 'redirect' | 'error';
	readonly status?: number;
	readonly location?: string | null;
	readonly redirect?: { readonly iss?: string; readonly state?: boolean; readonly code?: string; readonly error?: string; readonly errorDescription?: string };
}

const BROWSER_LOG = 'oauth-browser.jsonl';

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
