/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The mutation runs: each changes the environment of the run (not the product) the way a broken
// product would show itself, and names the tests that must then fail. A run with
// MCP_E2E_MUTATIONS=<name> (run-e2e.ps1 -Mutate <name>) applies it; `check` verifies the result.
// Where a mutation is applied: prepare-profile.ts (mcp.json, settings), start-servers.ts (the proxy
// and fixture flags), runner/http-fault-proxy.ts (--mutate), runner/oauth-browser.ts, the test
// itself (extension/src, testHelpers.mutated), or the policy phase (ui/policy.ts).
//
// Usage: node runner/mutations.ts list            the table with the exact commands (Markdown)
//        node runner/mutations.ts json            the same as JSON (run-mutations.ps1 reads it)
//        node runner/mutations.ts check <run dir> <name>   exit 0 when every test it names failed

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface IMutation {
	readonly name: string;
	/** What it simulates. */
	readonly summary: string;
	readonly appliedBy: 'prepare-profile' | 'start-servers' | 'http-fault-proxy' | 'oauth-browser' | 'test' | 'policy';
	/** Substrings of the names of the tests that must fail (each must match at least one failed test). */
	readonly mustFail: readonly string[];
	/** The -Only filter of the run (comma-separated substrings). */
	readonly only: string;
	/** Which suites the run needs (`policy`: only the policy phase, which `-Only policy` selects alone). */
	readonly suites: 'api' | 'ui' | 'both' | 'policy';
}

export const MUTATIONS: readonly IMutation[] = [
	{ name: 'strip-tasks', appliedBy: 'http-fault-proxy', suites: 'both', only: 'tasks', summary: 'zig-http\'s proxy removes the Tasks extension from the _meta client capabilities: no task is ever created', mustFail: ['tasks (zig-http): slow_compute', 'tasks cancel (zig-http)', 'tasks failing_job', 'tasks protocol_error_job', 'tasks with an input round', 'tasks with input inside the task'] },
	{ name: 'drop-tasks-cancel', appliedBy: 'http-fault-proxy', suites: 'api', only: 'tasks cancel', summary: 'tasks/cancel is answered by the proxy and never reaches the server', mustFail: ['tasks cancel (zig-http)'] },
	{ name: 'drop-listen-ack', appliedBy: 'http-fault-proxy', suites: 'api', only: 'listen (zig-http),listen prompts', summary: 'the server\'s notifications/subscriptions/acknowledged never reaches VS Code', mustFail: ['listen (zig-http)', 'listen prompts (zig-http)'] },
	{ name: 'drop-progress', appliedBy: 'http-fault-proxy', suites: 'api', only: 'progress (zig-http)', summary: 'the notifications/progress of a tools/call never reach VS Code', mustFail: ['progress (zig-http)'] },
	{ name: 'strip-mcp-param', appliedBy: 'http-fault-proxy', suites: 'api', only: 'Mcp-Param headers', summary: 'the Mcp-Param-* headers are removed on the way to the server', mustFail: ['Mcp-Param headers (zig-http)'] },
	{ name: 'no-faults', appliedBy: 'start-servers', suites: 'api', only: 'zig-http-faults,zig-http-renegotiate', summary: 'the fault proxies inject nothing: every error path is the happy path', mustFail: ['-32021 (zig-http-faults)', 'unknown resultType (zig-http-faults)', 'outputSchema (zig-http-faults)', '-32022 for the revision in use', 'empty-string nextCursor', '-32022 renegotiate and retry'] },
	{ name: 'no-tls-ca', appliedBy: 'prepare-profile', suites: 'both', only: 'gRPC over TLS (zig-grpcs,tls.serverName,request_state over gRPC with TLS', summary: 'mcp.json loses tls.ca: the throw-away CA is not trusted', mustFail: ['gRPC over TLS (zig-grpcs', 'tls.serverName (zig-grpcs-sni', 'mrtr request_state over gRPC with TLS'] },
	{ name: 'trust-everything', appliedBy: 'prepare-profile', suites: 'api', only: 'gRPC over TLS, negative', summary: 'the negative grpcs:// entries get the CA and no wrong server name: they connect', mustFail: ['negative (zig-grpcs-untrusted)', 'negative (zig-grpcs-wrong-name)'] },
	{ name: 'no-insecure', appliedBy: 'prepare-profile', suites: 'api', only: 'tls.insecure', summary: 'zig-grpcs-insecure loses tls.insecure', mustFail: ['tls.insecure (zig-grpcs-insecure'] },
	{ name: 'deadline-everywhere', appliedBy: 'prepare-profile', suites: 'api', only: 'default deadlines', summary: 'zig-grpcs gets deadlineMs 60000, so tools/call and the rest carry a deadline', mustFail: ['default deadlines'] },
	{ name: 'pin-unpinned', appliedBy: 'prepare-profile', suites: 'api', only: 'negotiation everything-unpinned', summary: 'everything-unpinned is pinned to 2025-11-25: no probe', mustFail: ['negotiation everything-unpinned'] },
	{ name: 'unpin-legacy', appliedBy: 'prepare-profile', suites: 'api', only: 'protocolVersion pin', summary: 'zig-http-pin-legacy loses its pin: VS Code probes first', mustFail: ['protocolVersion pin to a revision the server rejects'] },
	{ name: 'sse-to-streamable', appliedBy: 'prepare-profile', suites: 'api', only: 'legacy HTTP+SSE', summary: 'everything-sse points at a Streamable HTTP server: no SSE fallback', mustFail: ['legacy HTTP+SSE (everything-sse)'] },
	{ name: 'sampling-deny', appliedBy: 'prepare-profile', suites: 'api', only: 'mrtr sampling (zig-grpc-tunnel)', summary: 'zig-grpc-tunnel may not use the model: the sampling round is declined', mustFail: ['mrtr sampling (zig-grpc-tunnel)'] },
	{ name: 'no-mangle', appliedBy: 'start-servers', suites: 'api', only: '-32020 over gRPC', summary: 'the proxy of zig-grpc-mismatch rewrites no mcp-name: no -32020', mustFail: ['-32020 over gRPC, once', '-32020 over gRPC, always'] },
	{ name: 'no-hold', appliedBy: 'start-servers', suites: 'api', only: 'deadlineMs,cancel an in-flight gRPC call', summary: 'the proxy of zig-grpc-deadline holds nothing: the call completes before the deadline and the cancellation', mustFail: ['deadlineMs (zig-grpc-deadline', 'cancel an in-flight gRPC call'] },
	{ name: 'grpc-allow-tunnel', appliedBy: 'start-servers', suites: 'api', only: 'binding auto against a typed-only server', summary: 'the proxy of zig-grpc-auto-typed serves the tunnel: binding auto connects', mustFail: ['gRPC binding auto against a typed-only server'] },
	{ name: 'api-binding-typed', appliedBy: 'test', suites: 'api', only: 'API definition, binding Auto', summary: 'the extension defines zig-grpc-api with binding Typed instead of Auto', mustFail: ['API definition, binding Auto (zig-grpc-api)'] },
	{ name: 'oauth-no-resource', appliedBy: 'oauth-browser', suites: 'ui', only: 'oauth (zig-oauth,oauth over gRPC', summary: 'the authorization request loses its RFC 8707 resource on the way to the authorization server', mustFail: ['oauth (zig-oauth', 'oauth over gRPC (zig-grpc-oauth)'] },
	{ name: 'no-url-elicitation', appliedBy: 'start-servers', suites: 'ui', only: 'url-elicitation', summary: 'the proxy of zig-http-faults asks for no URL-mode elicitation: test_tool_with_logging runs at once', mustFail: ['elicitation url mode (zig-http-faults)', 'elicitation url mode declined (zig-http-faults)'] },
	{ name: 'oauth-iss-ok', appliedBy: 'start-servers', suites: 'ui', only: 'oauth RFC 9207', summary: 'the iss fixtures send the right iss: the sign-in succeeds', mustFail: ['oauth RFC 9207 (zig-oauth-iss-wrong)', 'oauth RFC 9207 (zig-oauth-iss-omit)'] },
	{ name: 'era-cache-reset', appliedBy: 'test', suites: 'api', only: 'cached era hint', summary: 'the tool cache (with the era hints) is reset before each restart', mustFail: ['cached era hint (everything-legacy)', 'cached era hint (everything-unpinned)'] },
	{ name: 'gateway-benign', appliedBy: 'test', suites: 'api', only: 'gateway Host/Origin,gateway unknown route,gateway header check,gateway requestState,gateway dispose', summary: 'the gateway tests send valid requests (and do not dispose) where they send invalid ones', mustFail: ['gateway Host/Origin checks', 'gateway unknown route', 'gateway header check', 'gateway requestState check', 'gateway dispose'] },
	{ name: 'gateway-listen-no-trigger', appliedBy: 'test', suites: 'api', only: 'gateway listen stream', summary: 'the tool list of zig-http-gw does not change', mustFail: ['gateway listen stream'] },
	{ name: 'gateway-rate-slow', appliedBy: 'test', suites: 'api', only: 'gateway rate limits', summary: 'the 130 calls are sent one after another, slower than the refill', mustFail: ['gateway rate limits'] },
	{ name: 'no-policy-file', appliedBy: 'policy', suites: 'policy', only: 'policy', summary: 'the policy phase writes no /etc/vscode/policy.json: VS Code applies no allow list', mustFail: ['zig-stdio, not in the allow list', 'zig-grpcs-insecure, allowed by its grpcs:// URL', 'chat.mcp.allowedServers is the policy value'] },
	{ name: 'allow-list-in-settings', appliedBy: 'policy', suites: 'policy', only: 'policy', summary: 'the same allow list comes from the user settings.json instead of the policy file: zig-stdio stays blocked, but tls.insecure is only warned about', mustFail: ['zig-grpcs-insecure, allowed by its grpcs:// URL', 'chat.mcp.allowedServers is the policy value'] },
];

/** The run-e2e.ps1 command of a mutation run. */
export function commandOf(m: IMutation): string {
	const parts = ['pwsh -File test\\mcp-e2e\\run-e2e.ps1', '-SkipBuild'];
	parts.push('-Mutate', m.name);
	parts.push('-Only', `'${m.only}'`);
	if (m.suites === 'api') {
		parts.push('-SkipUi');
	} else if (m.suites === 'ui') {
		parts.push('-SkipApi');
	}
	parts.push('-RunId', `mut-${m.name}`);
	return parts.join(' ');
}

interface ITestRow {
	readonly name: string;
	readonly status: string;
	readonly error?: string;
}

/** Whether every test the mutation names failed in the run (and which did not). */
export function checkRun(runDir: string, m: IMutation): { ok: boolean; lines: string[] } {
	const tests: ITestRow[] = [];
	for (const suite of ['api', 'ui', 'policy']) {
		try {
			tests.push(...(JSON.parse(fs.readFileSync(path.join(runDir, suite, `${suite}-results.json`), 'utf8')) as { tests: ITestRow[] }).tests);
		} catch {
			// that suite did not run
		}
	}
	const lines: string[] = [];
	let ok = true;
	for (const expected of m.mustFail) {
		const matching = tests.filter(t => t.name.includes(expected));
		const failed = matching.filter(t => t.status === 'failed');
		if (!matching.length) {
			ok = false;
			lines.push(`MISSING  ${expected}: no test of the run matches`);
		} else if (!failed.length) {
			ok = false;
			lines.push(`SURVIVED ${expected}: ${matching.map(t => t.status).join(', ')}`);
		} else {
			lines.push(`killed   ${expected}: ${(failed[0].error ?? '').split('\n')[0].slice(0, 200)}`);
		}
	}
	return { ok, lines };
}

function main(argv: readonly string[]): number {
	const [command, ...rest] = argv;
	if (command === 'list') {
		console.log('| Mutation | Applied by | Simulates | Must fail | Command |');
		console.log('| --- | --- | --- | --- | --- |');
		for (const m of MUTATIONS) {
			console.log(`| \`${m.name}\` | ${m.appliedBy} | ${m.summary} | ${m.mustFail.map(t => `"${t}"`).join(', ')} | \`${commandOf(m)}\` |`);
		}
		return 0;
	}
	if (command === 'json') {
		console.log(JSON.stringify(MUTATIONS.map(m => ({ ...m, command: commandOf(m) })), null, '\t'));
		return 0;
	}
	if (command === 'check' && rest.length === 2) {
		const m = MUTATIONS.find(x => x.name === rest[1]);
		if (!m) {
			console.error(`unknown mutation ${rest[1]}`);
			return 2;
		}
		const { ok, lines } = checkRun(rest[0], m);
		console.log(`${m.name}: ${ok ? 'KILLED (every named test failed)' : 'NOT KILLED'}`);
		for (const line of lines) {
			console.log(`  ${line}`);
		}
		return ok ? 0 : 1;
	}
	console.error('usage: mutations.ts list | json | check <run dir> <name>');
	return 2;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}
