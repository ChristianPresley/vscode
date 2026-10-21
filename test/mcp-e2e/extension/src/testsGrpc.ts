/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { E2eHarness, sleep, waitFor } from './harness';
import { canonicalJson, describeWireCalls, IWireEvent, loggedMessages, TUNNEL_CALL_PATH, TYPED_SERVICE_PREFIX } from './mcpLog';
import { assert, ITestCase } from './runner';
import { errorText, expectToolText, invokeMcpTool, isCancellation, TYPED_CALL_TOOL, TYPED_LIST_TOOLS, windowLogLines, wireCallSucceeded, wireEndOf } from './testHelpers';

/**
 * gRPC beyond the tool call: the API definitions (binding Auto, Typed and TLS through
 * vscode.McpGrpcServerDefinition), -32020 in the trailers (runner/grpc-log-proxy.ts
 * --mangle-mcp-name), the default deadlines and a configured one (--hold), cancellation of an
 * in-flight call (RST_STREAM CANCEL), tls.serverName and tls.insecure.
 */

const MISMATCH = 'zig-grpc-mismatch';
const DEADLINE = 'zig-grpc-deadline';
/** RST_STREAM error code CANCEL (RFC 9113 section 7). */
const RST_CANCEL = 8;

function toolCalls(events: readonly IWireEvent[], tool: string): IWireEvent[] {
	return events.filter(e => e.event === 'call' && e.path === TUNNEL_CALL_PATH && !!e.jsonRpcMethods?.includes('tools/call') && e.metadata?.['mcp-name'] === tool);
}

function tlsSessionsOf(events: readonly IWireEvent[]): Map<number, IWireEvent['tls']> {
	return new Map(events.filter(e => e.event === 'connection' && e.phase === 'open' && e.tls).map(e => [e.session ?? 0, e.tls]));
}

export function grpcTests(h: E2eHarness): ITestCase[] {
	return [
		// --- Definitions from the extension API --------------------------------------------------
		{
			name: 'API definition, binding Auto (zig-grpc-api): test_simple_text works, and the first call on the wire is the tunnel server/discover (Auto speaks the tunnel), with no typed RPC',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpc-api';
				await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response']);
				const wire = h.wireLog(label);
				const calls = wire.filter(e => e.event === 'call');
				ctx.details.wireCalls = describeWireCalls(wire).slice(0, 10);
				const first = calls[0];
				assert(first?.path === TUNNEL_CALL_PATH && canonicalJson(first.jsonRpcMethods) === canonicalJson(['server/discover']) && wireCallSucceeded(wire, first), `the first call was ${JSON.stringify(first)}, expected a successful tunnel server/discover`);
				const typed = calls.filter(c => c.path?.startsWith(TYPED_SERVICE_PREFIX));
				assert(!typed.length, `binding Auto sent typed RPCs: ${JSON.stringify(typed.slice(0, 3).map(c => c.path))}`);
			},
		},
		{
			name: 'API definition, binding Typed (zig-grpc-api-typed): greet arrives as a typed CallTool and VS Code sends the server no subscriptions/listen',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpc-api-typed';
				const wireBefore = h.wireLog(label).length;
				await expectToolText(h, ctx, label, 'greet', { name: 'api-typed' }, ['Hello, api-typed!']);
				const wire = await waitFor('the CallTool of greet in the wire log', 10_000, () => {
					const events = h.wireLog(label);
					return events.slice(wireBefore).some(e => e.event === 'call' && e.path === TYPED_CALL_TOOL && wireCallSucceeded(events, e)) ? events : undefined;
				}, 250);
				ctx.details.wireCalls = describeWireCalls(wire.slice(wireBefore));
				const sent = loggedMessages(h.serverLog(label)).filter(m => m.direction === 'sent').map(m => m.message.method);
				assert(!sent.includes('subscriptions/listen'), 'VS Code sent subscriptions/listen over the typed binding of the API definition');
			},
		},
		{
			name: 'API definition over TLS (zig-grpc-api-tls, tls.ca through the API): test_simple_text works over a TLS connection with SNI localhost',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpc-api-tls';
				assert(h.env.tlsCa, 'MCP_E2E_TLS_DIR is not set: the API definition has no CA');
				const wireBefore = h.wireLog(label).length;
				await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response']);
				const wire = h.wireLog(label);
				const sessions = tlsSessionsOf(wire);
				const call = wire.slice(wireBefore).find(e => e.event === 'call' && e.jsonRpcMethods?.includes('tools/call'));
				ctx.details.tls = call ? sessions.get(call.session ?? 0) : undefined;
				assert(call && sessions.get(call.session ?? 0)?.servername === 'localhost', `the tools/call did not come over a TLS connection with SNI localhost: ${JSON.stringify(ctx.details.tls)}`);
			},
		},

		{
			name: 'Mcp-Param metadata over the gRPC tunnel (zig-grpc-api): test_x_mcp_header gets mcp-param-region/-priority/-verbose from its arguments and echoes them, without a -32020',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpc-api';
				const wireBefore = h.wireLog(label).length;
				const from = h.serverLog(label).length;
				await expectToolText(h, ctx, label, 'test_x_mcp_header', { region: 'eu-west', priority: 7, verbose: true }, ['region=eu-west priority=7 verbose=true']);
				const call = toolCalls(h.wireLog(label).slice(wireBefore), 'test_x_mcp_header')[0];
				ctx.details.metadata = call?.metadata;
				assert(call?.metadata?.['mcp-param-region'] === 'eu-west' && call.metadata['mcp-param-priority'] === '7' && call.metadata['mcp-param-verbose'] === 'true', `the tools/call carried ${JSON.stringify(call?.metadata)}`);
				assert(!/-32020/.test(h.serverLog(label).slice(from)), 'the call met a -32020 header mismatch');
			},
		},

		// --- -32020 in the trailers --------------------------------------------------------------
		{
			name: `-32020 over gRPC, once (${MISMATCH}): a tools/call whose mcp-name metadata the proxy rewrote ends INVALID_ARGUMENT with mcp-error-code -32020; VS Code re-lists the tools and retries once, and greet works`,
			group: 'grpc',
			fn: async ctx => {
				await h.requireServer(MISMATCH);
				const wireBefore = h.wireLog(MISMATCH).length;
				const from = h.serverLog(MISMATCH).length;
				await expectToolText(h, ctx, MISMATCH, 'greet', { name: 'mismatch-once' }, ['Hello, mismatch-once!']);
				const wire = await waitFor('the retried tools/call of greet', 10_000, () => {
					const events = h.wireLog(MISMATCH);
					return toolCalls(events.slice(wireBefore), 'greet').some(c => wireCallSucceeded(events, c)) ? events : undefined;
				}, 250);
				const window = wire.slice(wireBefore);
				ctx.details.wireCalls = describeWireCalls(window);
				const calls = window.filter(e => e.event === 'call');
				const first = toolCalls(window, 'greet')[0];
				const firstEnd = first && wireEndOf(wire, first);
				assert(first?.mangled && firstEnd?.grpcStatus === '3' && firstEnd.mcpErrorCode === '-32020', `the first tools/call of greet ended with ${JSON.stringify(firstEnd)} (mangled ${JSON.stringify(first?.mangled)}), expected grpc-status 3 with mcp-error-code -32020`);
				const relist = calls.findIndex(c => c.jsonRpcMethods?.includes('tools/list'));
				const retry = calls.findIndex((c, i) => i > relist && toolCalls([c], 'greet').length === 1 && wireCallSucceeded(wire, c));
				assert(relist > calls.indexOf(first) && retry > relist, `expected the refused tools/call, a tools/list, then a successful tools/call: ${JSON.stringify(ctx.details.wireCalls)}`);
				const line = /The server reported a header mismatch for tools\/call; refreshing the tool list and retrying once/.exec(h.serverLog(MISMATCH).slice(from));
				ctx.details.logLine = line?.[0];
				assert(line, 'VS Code did not log the header mismatch and the retry');
			},
		},
		{
			name: `-32020 over gRPC, always (${MISMATCH}): when the retry meets -32020 too, invokeTool rejects with it after exactly two tools/call RPCs, and VS Code logs the rejection`,
			group: 'grpc',
			fn: async ctx => {
				await h.requireServer(MISMATCH);
				const wireBefore = h.wireLog(MISMATCH).length;
				const from = h.serverLog(MISMATCH).length;
				const call = await invokeMcpTool(h, ctx, MISMATCH, 'test_simple_text', {});
				assert(call.error !== undefined, `invokeTool resolved: ${JSON.stringify(call.text.slice(0, 200))}`);
				assert(/-32020/.test(errorText(call.error)), `invokeTool rejected with ${errorText(call.error)}`);
				await sleep(1000);
				const wire = h.wireLog(MISMATCH);
				const calls = toolCalls(wire.slice(wireBefore), 'test_simple_text');
				ctx.details.ends = calls.map(c => wireEndOf(wire, c));
				assert(calls.length === 2 && calls.every(c => wireEndOf(wire, c)?.mcpErrorCode === '-32020'), `expected exactly two tools/call RPCs, both refused with -32020: ${JSON.stringify(ctx.details.ends)}`);
				const line = /The server rejected tools\/call with a header mismatch \(-32020\): .*/.exec(h.serverLog(MISMATCH).slice(from));
				ctx.details.logLine = line?.[0];
				assert(line, 'VS Code did not log the rejected retry');
			},
		},

		// --- Deadlines ----------------------------------------------------------------------------
		{
			name: 'default deadlines (zig-grpc-typed, zig-grpcs wire logs): server/discover and the list RPCs carry grpc-timeout 1M (60 s), tools/call, CallTool and subscriptions/listen carry none',
			group: 'grpc',
			fn: async ctx => {
				await h.requireServer('zig-grpc-typed');
				await h.requireServer('zig-grpcs');
				// One tool call on each, so that the tool call RPCs are on the wire whatever else ran.
				await expectToolText(h, ctx, 'zig-grpc-typed', 'greet', { name: 'deadline-default' }, ['Hello, deadline-default!']);
				await expectToolText(h, ctx, 'zig-grpcs', 'test_simple_text', {}, ['This is a simple text response']);
				const calls = (label: string) => h.wireLog(label).filter(e => e.event === 'call');
				await waitFor('the tool calls in the wire logs', 10_000, () => calls('zig-grpc-typed').some(e => e.path === TYPED_CALL_TOOL) && calls('zig-grpcs').some(e => e.jsonRpcMethods?.includes('tools/call')) ? true : undefined, 250);
				const typed = calls('zig-grpc-typed');
				const tls = calls('zig-grpcs');
				const deadline = (e: IWireEvent) => e.metadata?.['grpc-timeout'];
				const listTools = typed.filter(e => e.path === TYPED_LIST_TOOLS);
				const callTool = typed.filter(e => e.path === TYPED_CALL_TOOL);
				const byMethod = (method: string) => tls.filter(e => e.jsonRpcMethods?.includes(method));
				ctx.details.deadlines = {
					ListTools: [...new Set(listTools.map(deadline))], CallTool: [...new Set(callTool.map(deadline))],
					discover: [...new Set(byMethod('server/discover').map(deadline))], toolsList: [...new Set(byMethod('tools/list').map(deadline))],
					toolsCall: [...new Set(byMethod('tools/call').map(deadline))], listen: [...new Set(byMethod('subscriptions/listen').map(deadline))],
				};
				assert(listTools.length && listTools.every(e => deadline(e) === '1M'), `typed ListTools deadlines: ${JSON.stringify(listTools.map(deadline))}`);
				assert(callTool.length && callTool.every(e => deadline(e) === undefined), `typed CallTool deadlines: ${JSON.stringify(callTool.map(deadline))}`);
				for (const method of ['server/discover', 'tools/list']) {
					assert(byMethod(method).length && byMethod(method).every(e => deadline(e) === '1M'), `${method} over the tunnel: ${JSON.stringify(byMethod(method).map(deadline))}`);
				}
				for (const method of ['tools/call', 'subscriptions/listen']) {
					assert(byMethod(method).length && byMethod(method).every(e => deadline(e) === undefined), `${method} over the tunnel carried a deadline: ${JSON.stringify(byMethod(method).map(deadline))}`);
				}
				assert(byMethod('subscriptions/listen').length > 0, 'no subscriptions/listen reached zig-grpcs');
			},
		},
		{
			name: `deadlineMs (${DEADLINE}: 1500, greet held 5 s by the proxy): invokeTool rejects with DEADLINE_EXCEEDED after about 1.5 s, the call carried grpc-timeout 1500m and was reset with CANCEL`,
			group: 'grpc',
			fn: async ctx => {
				await h.requireServer(DEADLINE);
				const wireBefore = h.wireLog(DEADLINE).length;
				const call = await invokeMcpTool(h, ctx, DEADLINE, 'greet', { name: 'deadline' });
				ctx.details.ms = call.ms;
				assert(call.error !== undefined, `invokeTool resolved: ${JSON.stringify(call.text)}`);
				assert(/DEADLINE_EXCEEDED|deadline of 1500m exceeded/.test(errorText(call.error)), `invokeTool rejected with ${errorText(call.error)}`);
				assert(call.ms >= 1300 && call.ms < 4000, `invokeTool settled after ${call.ms} ms, expected about 1500`);
				await sleep(500);
				const wire = h.wireLog(DEADLINE);
				const greet = toolCalls(wire.slice(wireBefore), 'greet')[0];
				ctx.details.call = greet;
				assert(greet?.metadata?.['grpc-timeout'] === '1500m' && greet.heldMs === 5000, `the tools/call carried grpc-timeout ${greet?.metadata?.['grpc-timeout']} (held ${greet?.heldMs})`);
				const reset = wire.find(e => e.event === 'rst' && e.from === 'client' && e.session === greet.session && e.stream === greet.h2Stream);
				assert(reset?.errorCode === RST_CANCEL, `the expired call was not reset with CANCEL: ${JSON.stringify(reset)}`);
			},
		},
		{
			name: `cancel an in-flight gRPC call (${DEADLINE}): cancelling the invokeTool of greet (held by the proxy) resets its stream with CANCEL at once, the connection stays, and the next call works on it`,
			group: 'grpc',
			fn: async ctx => {
				await h.requireServer(DEADLINE);
				const wireBefore = h.wireLog(DEADLINE).length;
				const cts = new vscode.CancellationTokenSource();
				const pending = invokeMcpTool(h, ctx, DEADLINE, 'greet', { name: 'cancel' }, { token: cts.token });
				await sleep(500);
				const cancelledAt = Date.now();
				cts.cancel();
				const call = await pending;
				ctx.details.settleMs = Date.now() - cancelledAt;
				assert(call.error !== undefined && isCancellation(call.error), `invokeTool did not reject with a cancellation: ${call.error === undefined ? JSON.stringify(call.text) : errorText(call.error)}`);
				assert(Date.now() - cancelledAt < 1000, `invokeTool settled ${Date.now() - cancelledAt} ms after the cancellation`);
				await expectToolText(h, ctx, DEADLINE, 'test_simple_text', {}, ['This is a simple text response']);
				const wire = h.wireLog(DEADLINE).slice(wireBefore);
				const greet = toolCalls(wire, 'greet')[0];
				const next = toolCalls(wire, 'test_simple_text')[0];
				const reset = wire.find(e => e.event === 'rst' && e.from === 'client' && greet && e.session === greet.session && e.stream === greet.h2Stream);
				ctx.details.wire = { greet, reset, next, connections: wire.filter(e => e.event === 'connection') };
				assert(reset?.errorCode === RST_CANCEL, `the cancelled call was not reset with CANCEL: ${JSON.stringify(reset)}`);
				assert(next && next.session === greet?.session, `the call after the cancellation used connection ${next?.session}, the cancelled one ${greet?.session}`);
				assert(!wire.some(e => e.event === 'connection'), 'a connection opened or closed around the cancellation');
			},
		},

		// --- tls.serverName and tls.insecure ----------------------------------------------------
		{
			name: 'tls.serverName (zig-grpcs-sni: grpcs://127.0.0.1 with serverName localhost and tls.ca): the handshake uses SNI localhost, the certificate is verified for it, and test_simple_text works',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpcs-sni';
				const wireBefore = h.wireLog(label).length;
				await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response']);
				const wire = h.wireLog(label);
				const sessions = tlsSessionsOf(wire);
				const call = wire.slice(wireBefore).find(e => e.event === 'call' && e.jsonRpcMethods?.includes('tools/call'));
				ctx.details.tls = call ? sessions.get(call.session ?? 0) : undefined;
				assert(call && sessions.get(call.session ?? 0)?.servername === 'localhost', `the tools/call did not come over a TLS connection with SNI localhost: ${JSON.stringify(ctx.details.tls)}`);
			},
		},
		{
			name: 'tls.insecure (zig-grpcs-insecure: no tls.ca): VS Code connects without verifying the certificate, test_simple_text works, and it warns that verification is off',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpcs-insecure';
				await expectToolText(h, ctx, label, 'test_simple_text', {}, ['This is a simple text response']);
				const pattern = /TLS certificate verification is turned off for the MCP server 'zig-grpcs-insecure'/;
				const lines = [...h.serverLog(label).split('\n').filter(l => pattern.test(l)).map(line => ({ file: 'mcp log', line })), ...windowLogLines(h, pattern)];
				ctx.details.warnings = lines.slice(0, 4);
				assert(lines.length > 0, 'VS Code did not warn that tls.insecure turns off certificate verification');
			},
		},
	];
}
