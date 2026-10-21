/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mcpToolNameOf, mcpToolsOf } from './agent';
import { definitionIdOf } from './config';
import { E2eHarness, sleep } from './harness';
import { canonicalJson, IHttpProxyEvent, ILoggedMessage, loggedMessages, responseTo, sentMethods, taskResultText, taskRunOf, taskStatusOf } from './mcpLog';
import { assert, ITestCase } from './runner';
import { errorText, expectToolText, invokeMcpTool, isCancellation, mutated, NEGOTIATED } from './testHelpers';

/**
 * The 2026-07-28 protocol details beyond the happy path: progress, cancellation, the error paths
 * injected by runner/http-fault-proxy.ts (zig-http-faults, zig-http-renegotiate), the HTTP request
 * shape VS Code sends (the record of zig-http's proxy), Mcp-Param headers, the 2020-12 schema
 * tool, the protocolVersion pin, the legacy SSE fallback, task failures and the cached era hint.
 */

const FAULTS = 'zig-http-faults';
const RENEGOTIATE = 'zig-http-renegotiate';

function requestsOf(events: readonly IHttpProxyEvent[]): IHttpProxyEvent[] {
	return events.filter(e => e.event === 'request');
}

/**
 * The line VS Code writes into the MCP log of `label` (after offset `from`), or a failure that
 * shows the last error and state lines. The log file is flushed asynchronously: the line can
 * land after the call that wrote it has settled (runs final-r1 and final-r3: the -32022 line was
 * logged in the same millisecond as the answer, but the file had nothing yet 4 ms later), so it is
 * polled for up to `timeoutMs`.
 */
async function logLine(h: E2eHarness, label: string, from: number, pattern: RegExp, what: string, timeoutMs = 10_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (; ;) {
		const log = h.serverLog(label).slice(from);
		const line = log.split('\n').find(l => pattern.test(l));
		if (line) {
			return line.slice(0, 500);
		}
		assert(Date.now() < deadline, `VS Code's MCP log has no line for ${what} (${pattern}) within ${timeoutMs} ms; its last error and state lines: ${JSON.stringify(log.split('\n').filter(l => /\[(error|warning)\]|Connection state/.test(l)).slice(-5))}`);
		await sleep(200);
	}
}

function progressTest(h: E2eHarness, label: string): ITestCase {
	return {
		name: `progress (${label}): the tools/call of test_tool_with_progress carries _meta.progressToken, and the three notifications/progress with that token (0, 50, 100 of 100: Starting, Halfway, Done) arrive before the result`,
		group: 'progress',
		fn: async ctx => {
			const from = h.serverLog(label).length;
			await expectToolText(h, ctx, label, 'test_tool_with_progress', {}, ['Progress complete']);
			const seen = await h.waitForLog(label, 'the answer to the tools/call of test_tool_with_progress', log => {
				const messages = loggedMessages(log, from);
				const call = messages.find(m => m.direction === 'sent' && m.message.method === 'tools/call' && m.message.params?.name === 'test_tool_with_progress');
				const response = call && responseTo(messages, call);
				return call && response ? { ok: true as const, details: { messages, call, response } } : { ok: false as const, reason: call ? 'no answer yet' : 'no tools/call of test_tool_with_progress' };
			});
			const token = (seen.call.message.params?._meta as Record<string, unknown> | undefined)?.progressToken;
			ctx.details.progressToken = token;
			assert(token !== undefined, `the tools/call carries no _meta.progressToken: ${JSON.stringify(seen.call.message.params?._meta)}`);
			const progress = seen.messages.filter(m => m.direction === 'received' && m.message.method === 'notifications/progress'
				&& m.offset > seen.call.offset && m.offset < seen.response.offset && (m.message.params as Record<string, unknown> | undefined)?.progressToken === token);
			const values = progress.map(p => { const params = p.message.params as Record<string, unknown>; return [params.progress, params.total, params.message]; });
			ctx.details.progress = values;
			assert(canonicalJson(values) === canonicalJson([[0, 100, 'Starting'], [50, 100, 'Halfway'], [100, 100, 'Done']]), `the notifications/progress with the call's token before its result were ${JSON.stringify(values)}`);
		},
	};
}

/** The tests of this module, in the order they run (after the transport, MRTR and task tests). */
export function protocolTests(h: E2eHarness): ITestCase[] {
	return [
		progressTest(h, 'zig-http'),
		progressTest(h, 'zig-stdio'),
		{
			name: 'cancel a request (everything-legacy, stdio, 2025-11-25): cancelling the invokeTool of trigger-long-running-operation after its first progress sends notifications/cancelled with its requestId, and invokeTool rejects within 2 s',
			group: 'cancellation',
			fn: async ctx => {
				const label = 'everything-legacy';
				const from = h.serverLog(label).length;
				const cts = new vscode.CancellationTokenSource();
				const invocation = invokeMcpTool(h, ctx, label, 'trigger-long-running-operation', { duration: 10, steps: 10 }, { token: cts.token });
				const callId = await h.waitForLog(label, 'the first progress of trigger-long-running-operation', log => {
					const messages = loggedMessages(log, from);
					const call = messages.find(m => m.direction === 'sent' && m.message.method === 'tools/call' && m.message.params?.name === 'trigger-long-running-operation');
					const progress = call && messages.find(m => m.offset > call.offset && m.direction === 'received' && m.message.method === 'notifications/progress');
					return call && progress ? { ok: true as const, details: call.message.id } : { ok: false as const, reason: call ? 'no notifications/progress yet' : 'no tools/call yet' };
				}, 20_000);
				const cancelledAt = Date.now();
				cts.cancel();
				const call = await invocation;
				const settleMs = Date.now() - cancelledAt;
				ctx.details.settleMs = settleMs;
				assert(call.error !== undefined && isCancellation(call.error), `invokeTool did not reject with a cancellation: ${call.error === undefined ? `resolved with ${JSON.stringify(call.text.slice(0, 200))}` : errorText(call.error)}`);
				assert(settleMs < 2000, `invokeTool settled ${settleMs} ms after the cancellation`);
				const cancelled = await h.waitForLog(label, 'the notifications/cancelled of the call', log => {
					const message = loggedMessages(log, from).find(m => m.direction === 'sent' && m.message.method === 'notifications/cancelled');
					return message ? { ok: true as const, details: message.message.params } : { ok: false as const, reason: 'VS Code sent no notifications/cancelled' };
				});
				ctx.details.cancelled = cancelled;
				assert(cancelled?.requestId === callId, `notifications/cancelled names requestId ${JSON.stringify(cancelled?.requestId)}, the call was ${JSON.stringify(callId)}`);
			},
		},
		{
			name: 'legacy HTTP+SSE (everything-sse): the Streamable HTTP probe fails, VS Code falls back to the legacy SSE transport (its log says so), negotiates 2025-11-25 and echo works',
			group: 'negotiation',
			fn: async ctx => {
				const label = 'everything-sse';
				await expectToolText(h, ctx, label, 'echo', { message: 'sse-legacy-ok' }, ['Echo: sse-legacy-ok']);
				ctx.details.fallback = await logLine(h, label, 0, /\d{3} status sending message to \S+, will attempt to fall back to legacy SSE/, 'the fallback to legacy SSE');
				const log = h.serverLog(label);
				const negotiated = NEGOTIATED.exec(log);
				ctx.details.negotiated = negotiated?.[0];
				assert(negotiated?.[1] === '2025-11-25' && negotiated[2] === 'legacy', `${label} negotiated ${negotiated?.[0]}`);
			},
		},

		// --- Error paths of 2026-07-28 (runner/http-fault-proxy.ts) -----------------------------
		{
			name: `-32021 (${FAULTS}): a tools/call answered with MISSING_REQUIRED_CLIENT_CAPABILITY (elicitation.url) rejects invokeTool with the missing capability named, and VS Code logs it`,
			group: 'errors',
			fn: async ctx => {
				const from = h.serverLog(FAULTS).length;
				const call = await invokeMcpTool(h, ctx, FAULTS, 'test_audio_content', {});
				assert(call.error !== undefined, `invokeTool resolved: ${JSON.stringify(call.text.slice(0, 200))}`);
				assert(/does not declare for tools\/call: elicitation\.url/.test(errorText(call.error)), `invokeTool rejected with ${errorText(call.error)}`);
				ctx.details.logLine = await logLine(h, FAULTS, from, /The server requires client capabilities this client does not declare for tools\/call: elicitation\.url \(-32021: /, 'the -32021 error');
				assert(requestsOf(h.httpLog(FAULTS)).some(e => e.fault === 'missing-capability:test_audio_content' && e.status === 400), 'the proxy did not inject the -32021 answer');
			},
		},
		{
			name: `unknown resultType (${FAULTS}): a tools/call result with resultType "bogus" rejects invokeTool`,
			group: 'errors',
			fn: async ctx => {
				const call = await invokeMcpTool(h, ctx, FAULTS, 'test_embedded_resource', {});
				assert(call.error !== undefined, `invokeTool resolved: ${JSON.stringify(call.text.slice(0, 200))}`);
				assert(errorText(call.error).includes('Unexpected resultType "bogus" for tools/call'), `invokeTool rejected with ${errorText(call.error)}`);
				assert(requestsOf(h.httpLog(FAULTS)).some(e => e.fault === 'result-type:test_embedded_resource'), 'the proxy did not rewrite the resultType');
			},
		},
		{
			name: `outputSchema (${FAULTS}): structuredContent that does not match the tool's outputSchema rejects invokeTool; matching structuredContent becomes the result (as JSON)`,
			group: 'errors',
			fn: async ctx => {
				const mismatch = await invokeMcpTool(h, ctx, FAULTS, 'test_simple_text', {});
				assert(mismatch.error !== undefined, `invokeTool resolved although the structuredContent does not match the outputSchema: ${JSON.stringify(mismatch.text.slice(0, 200))}`);
				assert(/does not match its output schema/.test(errorText(mismatch.error)), `invokeTool rejected with ${errorText(mismatch.error)}`);
				const match = await expectToolText(h, ctx, FAULTS, 'greet', { name: 'schema' }, ['Hello, schema!', '"greeting"']);
				assert(match.text.trim().startsWith('{'), `the result of a tool with structuredContent is not its JSON: ${JSON.stringify(match.text.slice(0, 200))}`);
			},
		},
		{
			name: `-32022 for the revision in use (${FAULTS}): VS Code does not renegotiate when the server only offers 2026-07-28, logs the rejection and rejects invokeTool; the next call works`,
			group: 'errors',
			fn: async ctx => {
				const from = h.serverLog(FAULTS).length;
				const call = await invokeMcpTool(h, ctx, FAULTS, 'test_image_content', {});
				assert(call.error !== undefined, `invokeTool resolved: ${JSON.stringify(call.text.slice(0, 200))}`);
				assert(/-32022/.test(errorText(call.error)), `invokeTool rejected with ${errorText(call.error)}`);
				ctx.details.logLine = await logLine(h, FAULTS, from, /The server rejected tools\/call for the protocol revision 2026-07-28 \(-32022: .*\); it supports 2026-07-28/, 'the -32022 rejection');
				const methods = sentMethods(h.serverLog(FAULTS), from);
				assert(!methods.includes('server/discover') && !methods.includes('initialize'), `VS Code renegotiated after a -32022 that offered only the revision in use: ${JSON.stringify(methods)}`);
				await expectToolText(h, ctx, FAULTS, 'test_image_content', {}, ['image/png']);
			},
		},
		{
			name: `empty-string nextCursor (${FAULTS}): tools/list answered with nextCursor "" is followed by exactly one tools/list with cursor "", and the tools of both pages are listed`,
			group: 'errors',
			fn: async ctx => {
				await h.requireServer(FAULTS);
				const requests = requestsOf(h.httpLog(FAULTS)).filter(e => e.messages?.length === 1 && e.messages[0].method === 'tools/list');
				const firstPages = requests.filter(e => e.messages?.[0].cursor === undefined);
				const secondPages = requests.filter(e => e.messages?.[0].cursor === '');
				ctx.details.toolsList = { firstPages: firstPages.length, secondPages: secondPages.length, other: requests.length - firstPages.length - secondPages.length };
				assert(firstPages.length >= 1 && secondPages.length >= 1, `the proxy saw ${firstPages.length} first and ${secondPages.length} second pages of tools/list`);
				assert(secondPages.length === firstPages.length && requests.length === firstPages.length * 2, `each listing must be exactly two pages: ${JSON.stringify(ctx.details.toolsList)}`);
				const names = mcpToolsOf(FAULTS).map(mcpToolNameOf);
				ctx.details.tools = names.length;
				for (const name of ['test_simple_text', 'test_image_content', 'test_tool_with_task', 'greet']) {
					assert(names.includes(name), `${name} (${name === 'test_simple_text' || name === 'test_image_content' ? 'first' : 'second'} page) is not among the tools of ${FAULTS}: ${JSON.stringify(names)}`);
				}
				const sentCursor = loggedMessages(h.serverLog(FAULTS)).some(m => m.direction === 'sent' && m.message.method === 'tools/list' && m.message.params?.cursor === '');
				assert(sentCursor, 'VS Code\'s MCP log has no tools/list with cursor ""');
			},
		},
		{
			name: `-32022 renegotiate and retry (${RENEGOTIATE}): a tools/call rejected with -32022 offering only 2025-11-25 makes VS Code switch to the 2025-11-25 handshake and retry, and invokeTool returns the result`,
			group: 'errors',
			timeoutMs: 240_000,
			fn: async ctx => {
				const outcome = await h.startServer(RENEGOTIATE, 60_000);
				ctx.details.outcome = outcome;
				assert(outcome.tools > 0, `${RENEGOTIATE} did not start: ${outcome.error}`);
				const from = h.serverLog(RENEGOTIATE).length;
				const httpFrom = h.httpLog(RENEGOTIATE).length;
				await expectToolText(h, ctx, RENEGOTIATE, 'greet', { name: 'renegotiate' }, ['Hello, renegotiate!'], { require: false });
				ctx.details.logLine = await logLine(h, RENEGOTIATE, from, /The server only speaks MCP 2025-11-25; switching to the legacy handshake/, 'the switch to 2025-11-25');
				const requests = requestsOf(h.httpLog(RENEGOTIATE).slice(httpFrom));
				ctx.details.requests = requests.map(e => `${e.messages?.map(m => m.method).join(',')} ${e.status} ${e.fault ?? e.bridged ?? ''}`);
				const fault = requests.findIndex(e => e.fault === 'version-legacy:greet');
				const initialize = requests.findIndex((e, i) => i > fault && e.bridged === 'initialize');
				const retry = requests.findIndex((e, i) => i > initialize && e.bridged === 'forwarded as 2026-07-28' && e.messages?.[0].name === 'greet' && e.status === 200);
				assert(fault !== -1 && initialize !== -1 && retry !== -1, `expected the -32022, then initialize, then the retried tools/call of greet: ${JSON.stringify(ctx.details.requests)}`);
			},
		},

		// --- The HTTP requests VS Code sends (zig-http's proxy) and the Mcp-Param headers --------
		{
			name: 'HTTP requests (zig-http, recorded by its proxy): every request is a POST without Mcp-Session-Id, with MCP-Protocol-Version 2026-07-28, Mcp-Method equal to the body method and Mcp-Name equal to the tool, prompt or task it names',
			group: 'negotiation',
			fn: async ctx => {
				const requests = requestsOf(h.httpLog('zig-http'));
				ctx.details.requests = requests.length;
				assert(requests.length > 10, `the proxy of zig-http recorded only ${requests.length} requests`);
				const notPost = requests.filter(e => e.httpMethod !== 'POST');
				assert(!notPost.length, `${notPost.length} requests were not POST: ${JSON.stringify(notPost.slice(0, 3).map(e => `${e.httpMethod} ${e.path}`))}`);
				const sessions = requests.filter(e => e.headers?.['mcp-session-id'] !== undefined);
				assert(!sessions.length, `${sessions.length} requests carried Mcp-Session-Id to a 2026-07-28 server`);
				const problems: string[] = [];
				const methods = new Set<string>();
				for (const e of requests) {
					const m = e.messages?.length === 1 ? e.messages[0] : undefined;
					if (!m || m.id === undefined || m.method === '(response)') {
						continue;
					}
					methods.add(m.method);
					const headers = e.headers ?? {};
					if (headers['mcp-protocol-version'] !== '2026-07-28') {
						problems.push(`#${e.n} ${m.method}: MCP-Protocol-Version ${headers['mcp-protocol-version']}`);
					}
					if (headers['mcp-method'] !== m.method) {
						problems.push(`#${e.n} ${m.method}: Mcp-Method ${headers['mcp-method']}`);
					}
					const named = m.method === 'tools/call' || m.method === 'prompts/get' ? m.name : m.method.startsWith('tasks/') ? m.taskId : undefined;
					if (named !== undefined && headers['mcp-name'] !== named) {
						problems.push(`#${e.n} ${m.method}: Mcp-Name ${headers['mcp-name']}, expected ${named}`);
					}
				}
				ctx.details.methods = [...methods];
				assert(!problems.length, `mirrored headers that do not match the body: ${JSON.stringify(problems.slice(0, 8))}`);
				for (const method of ['server/discover', 'tools/list', 'tools/call', 'subscriptions/listen', 'tasks/get']) {
					assert(methods.has(method), `no ${method} went through the proxy of zig-http (seen: ${JSON.stringify([...methods])})`);
				}
			},
		},
		{
			name: 'Mcp-Param headers (zig-http): test_x_mcp_header (x-mcp-header Region, Priority, Verbose) gets Mcp-Param-Region/-Priority/-Verbose from its arguments and echoes them, without a -32020',
			group: 'negotiation',
			fn: async ctx => {
				const from = h.serverLog('zig-http').length;
				await expectToolText(h, ctx, 'zig-http', 'test_x_mcp_header', { region: 'eu-west', priority: 7, verbose: true }, ['region=eu-west priority=7 verbose=true']);
				const request = requestsOf(h.httpLog('zig-http')).filter(e => e.messages?.[0]?.name === 'test_x_mcp_header').at(-1);
				ctx.details.headers = request?.headers;
				assert(request?.headers?.['mcp-param-region'] === 'eu-west' && request.headers['mcp-param-priority'] === '7' && request.headers['mcp-param-verbose'] === 'true', `the tools/call carried ${JSON.stringify(request?.headers)}`);
				assert(!/-32020/.test(h.serverLog('zig-http').slice(from)), 'the call met a -32020 header mismatch');
			},
		},
		{
			name: 'JSON Schema 2020-12 (zig-http): json_schema_2020_12_tool ($defs, $ref, if/then/else) is listed, no tool is dropped for an invalid schema, and a valid input is echoed',
			group: 'transport',
			fn: async ctx => {
				await h.requireServer('zig-http');
				const names = mcpToolsOf('zig-http').map(mcpToolNameOf);
				assert(names.includes('json_schema_2020_12_tool'), `json_schema_2020_12_tool is not among the tools of zig-http: ${JSON.stringify(names)}`);
				const invalid = /invalid JSON (schemas|parameters)|parts of its input schema are not checked/.exec(h.serverLog('zig-http'));
				assert(!invalid, `VS Code's MCP log of zig-http says ${JSON.stringify(invalid?.[0])}`);
				await expectToolText(h, ctx, 'zig-http', 'json_schema_2020_12_tool', { name: 'Ada', contactMethod: 'email', email: 'ada@example.com' }, ['ada@example.com', 'Ada']);
			},
		},

		// --- Tasks: the failure states -----------------------------------------------------------
		{
			name: 'tasks failing_job (zig-http): a task that ends in a tool error completes with isError, and invokeTool resolves with the error text',
			group: 'tasks',
			fn: async ctx => {
				const from = h.serverLog('zig-http').length;
				const call = await invokeMcpTool(h, ctx, 'zig-http', 'failing_job', {});
				assert(call.error === undefined, `invokeTool rejected: ${errorText(call.error)}`);
				assert(call.text.includes('The job failed as designed'), `failing_job returned ${JSON.stringify(call.text)}`);
				const run = await h.waitForLog('zig-http', 'the task of failing_job', log => {
					const r = taskRunOf(log, from, 'failing_job');
					return r.ok && taskStatusOf(r.details.polls.at(-1)?.response) !== 'completed' ? { ok: false as const, reason: 'not completed yet' } : r;
				});
				const final = run.polls.at(-1)?.response?.message.result?.result as { isError?: boolean } | undefined;
				ctx.details.final = final;
				assert(final?.isError === true, `the completed task's result is not isError: ${JSON.stringify(final)}`);
			},
		},
		{
			name: 'tasks protocol_error_job (zig-http): a task that ends in a protocol error is failed with -32603 and invokeTool rejects with its message',
			group: 'tasks',
			fn: async ctx => {
				const from = h.serverLog('zig-http').length;
				const call = await invokeMcpTool(h, ctx, 'zig-http', 'protocol_error_job', {});
				assert(call.error !== undefined, `invokeTool resolved: ${JSON.stringify(call.text.slice(0, 200))}`);
				assert(errorText(call.error).includes('The job hit an internal error as designed'), `invokeTool rejected with ${errorText(call.error)}`);
				const run = await h.waitForLog('zig-http', 'the failed task of protocol_error_job', log => {
					const r = taskRunOf(log, from, 'protocol_error_job');
					return r.ok && taskStatusOf(r.details.polls.at(-1)?.response) !== 'failed' ? { ok: false as const, reason: `last status ${taskStatusOf(r.details.polls.at(-1)?.response)}` } : r;
				});
				const error = run.polls.at(-1)?.response?.message.result?.error as { code?: number } | undefined;
				ctx.details.error = error;
				assert(error?.code === -32603, `the failed task carries ${JSON.stringify(error)}, expected code -32603`);
				assert(!taskResultText(run.polls.at(-1)?.response), 'the failed task carries a result');
			},
		},

		// --- The protocolVersion pin, as documented ------------------------------------------------
		{
			name: 'protocolVersion pin to a revision the server rejects (zig-http-pin-legacy: 2025-11-25 pinned, the server speaks only 2026-07-28 over Streamable HTTP): as documented, VS Code tries initialize first, then falls back to negotiation and connects with 2026-07-28',
			group: 'negotiation',
			timeoutMs: 120_000,
			fn: async ctx => {
				const label = 'zig-http-pin-legacy';
				const outcome = await h.startServer(label, 40_000, 20_000);
				ctx.details.outcome = outcome;
				const log = h.serverLog(label);
				const messages = loggedMessages(log);
				const methods = sentMethods(log);
				ctx.details.firstMethods = methods.slice(0, 6);
				const initialize = messages.find(m => m.direction === 'sent' && m.message.method === 'initialize');
				ctx.details.initializeVersion = initialize?.message.params?.protocolVersion;
				assert(methods[0] === 'initialize' && initialize?.message.params?.protocolVersion === '2025-11-25', `the pin did not make VS Code start with initialize 2025-11-25: ${JSON.stringify(methods.slice(0, 4))}`);
				const discover = methods.indexOf('server/discover');
				assert(discover > 0, `after the rejected initialize VS Code did not fall back to negotiation (no server/discover; the mcp.json description says "A pinned revision the server rejects still falls back to negotiation"); state lines: ${JSON.stringify(log.split('\n').filter(l => /Connection state|\[(error|warning)\]/.test(l)).slice(-4))}`);
				const negotiated = NEGOTIATED.exec(log);
				assert(negotiated?.[1] === '2026-07-28', `${label} negotiated ${negotiated?.[0] ?? 'nothing'}`);
				assert(outcome.tools > 0, `${label} has no tools: ${outcome.error}`);
				await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response'], { require: false });
			},
		},
	];
}

/** The cached era hint: restarts at the end of the suite (after the negotiation rows). */
export function restartTests(h: E2eHarness): ITestCase[] {
	const restart = async (label: string) => {
		if (mutated(h, 'era-cache-reset')) {
			// Mutation: the cache is gone, so the hint cannot skip the probe.
			await vscode.commands.executeCommand('workbench.mcp.resetCachedTools');
		}
		await vscode.commands.executeCommand('workbench.mcp.restartServer', definitionIdOf(h.server(label)));
	};
	const afterRestart = (label: string, from: number, method: string) => h.waitForLog(label, `the ${method} after the restart`, log => {
		const methods = sentMethods(log, from);
		return methods.includes(method) ? { ok: true as const, details: methods } : { ok: false as const, reason: `sent after the restart: ${JSON.stringify(methods)}` };
	}, 30_000);
	return [
		...(['everything-legacy', 'everything-unpinned'] as const).map((label): ITestCase => ({
			name: `cached era hint (${label}): after workbench.mcp.restartServer VS Code sends initialize at once, without the server/discover probe, and echo works`,
			group: 'negotiation',
			fn: async ctx => {
				await h.requireServer(label);
				const from = h.serverLog(label).length;
				await restart(label);
				const methods = await afterRestart(label, from, 'initialize');
				ctx.details.methods = methods.slice(0, 6);
				assert(!methods.includes('server/discover'), `VS Code probed ${label} again after the restart: ${JSON.stringify(methods.slice(0, 6))}`);
				await expectToolText(h, ctx, label, 'echo', { message: 'after-restart' }, ['Echo: after-restart']);
			},
		})),
		{
			name: 'cached era hint (zig-http): a 2026-07-28 server is sent server/discover again after workbench.mcp.restartServer (no initialize)',
			group: 'negotiation',
			fn: async ctx => {
				const label = 'zig-http';
				await h.requireServer(label);
				const from = h.serverLog(label).length;
				await restart(label);
				const methods = await afterRestart(label, from, 'server/discover');
				ctx.details.methods = methods.slice(0, 6);
				assert(!methods.includes('initialize'), `VS Code sent initialize to a 2026-07-28 server after the restart: ${JSON.stringify(methods.slice(0, 6))}`);
				await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response']);
			},
		},
	];
}

/** The answer of a JSON-RPC request in a log, for tests that read single exchanges. */
export function answerOf(log: string, method: string, predicate: (m: ILoggedMessage) => boolean = () => true): { request: ILoggedMessage; response: ILoggedMessage | undefined } | undefined {
	const messages = loggedMessages(log);
	const request = messages.find(m => m.direction === 'sent' && m.message.method === method && predicate(m));
	return request ? { request, response: responseTo(messages, request) } : undefined;
}
