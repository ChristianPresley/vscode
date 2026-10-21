/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mcpToolNameOf, mcpToolsOf } from './agent';
import { startsWithOthers } from './config';
import { modernRequest, openListenStream, rawModernPost } from './gatewayClients';
import { E2eHarness, sleep, waitFor } from './harness';
import { describeWireCalls, SUBSCRIPTION_ID_META } from './mcpLog';
import { assert, ITestCase, SkipError } from './runner';
import { expectToolText, mutated, TYPED_CALL_TOOL, wireCallSucceeded } from './testHelpers';

/**
 * The gateway (`vscode.lm.startMcpGateway()`, VS Code as an MCP server for local clients) with raw
 * clients: the route shape, tools/list on every route, a call to a gRPC upstream, the request
 * checks (Host/Origin, unknown route, Mcp-Name, requestState), dispose, the listen stream and the
 * rate limits.
 */

const ROUTE_ADDRESS = /^http:\/\/127\.0\.0\.1:\d+\/gateway\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function serverOf(gateway: vscode.McpGateway, label: string): vscode.McpGatewayServer {
	const server = gateway.servers.find(s => s.label === label);
	assert(server, `The gateway does not expose ${label}; it has ${JSON.stringify(gateway.servers.map(s => s.label))}`);
	return server;
}

function errorOf(message: { error?: { code: number; message: string; data?: unknown } } | undefined): { code?: number; message?: string; data?: unknown } {
	return message?.error ?? {};
}

export function gatewayTests(h: E2eHarness, getGateway: () => Promise<vscode.McpGateway>): ITestCase[] {
	const url = async (label: string) => serverOf(await getGateway(), label).address.toString(true);
	return [
		{
			name: 'gateway routes: every server the suite starts (gRPC and API servers included) has its own http://127.0.0.1:<port>/gateway/<uuid> route, one port, unique ids',
			group: 'gateway',
			fn: async ctx => {
				const gateway = await getGateway();
				const addresses = gateway.servers.map(s => ({ label: s.label, address: s.address.toString(true) }));
				ctx.details.routes = addresses;
				const bad = addresses.filter(a => !ROUTE_ADDRESS.test(a.address));
				assert(!bad.length, `routes that are not http://127.0.0.1:<port>/gateway/<uuid>: ${JSON.stringify(bad)}`);
				const ids = addresses.map(a => ROUTE_ADDRESS.exec(a.address)![1]);
				assert(new Set(ids).size === ids.length, `route ids are not unique: ${JSON.stringify(ids)}`);
				const ports = new Set(addresses.map(a => new URL(a.address).port));
				assert(ports.size === 1, `the routes use ${ports.size} ports: ${JSON.stringify([...ports])}`);
				for (const label of h.servers.filter(startsWithOthers).map(s => s.label)) {
					assert(addresses.some(a => a.label === label), `the gateway does not expose ${label}`);
				}
			},
		},
		{
			name: 'gateway tools/list on every route: each route lists exactly the tools VS Code has for that server',
			group: 'gateway',
			fn: async ctx => {
				await h.startServers();
				const gateway = await getGateway();
				const differences: string[] = [];
				const counts: Record<string, number> = {};
				for (const server of h.servers.filter(startsWithOthers)) {
					const list = await modernRequest(serverOf(gateway, server.label).address.toString(true), 'tools/list');
					const tools = (list.response?.result?.tools ?? []) as { name?: string; serverToolName?: string }[];
					const listed = new Set(tools.map(t => t.serverToolName ?? t.name ?? ''));
					const known = new Set(mcpToolsOf(server.label).map(mcpToolNameOf));
					counts[server.label] = listed.size;
					const missing = [...known].filter(n => !listed.has(n));
					const extra = [...listed].filter(n => !known.has(n));
					if (list.status !== 200 || missing.length || extra.length) {
						differences.push(`${server.label}: status ${list.status}, missing ${JSON.stringify(missing.slice(0, 5))}, extra ${JSON.stringify(extra.slice(0, 5))}`);
					}
				}
				ctx.details.counts = counts;
				assert(!differences.length, `routes whose tools/list differs from VS Code's tools: ${JSON.stringify(differences)}`);
			},
		},
		{
			name: 'gateway to a gRPC upstream (zig-grpc-typed route): tools/call greet through the gateway returns the result, and greet reached the typed server as a CallTool',
			group: 'gateway',
			fn: async ctx => {
				await h.requireServer('zig-grpc-typed');
				const wireBefore = h.wireLog('zig-grpc-typed').length;
				const call = await modernRequest(await url('zig-grpc-typed'), 'tools/call', { name: 'greet', arguments: { name: 'gateway-typed' } });
				const text = JSON.stringify(call.response?.result ?? call.response);
				ctx.details.call = { status: call.status, result: call.response?.result, error: call.response?.error };
				assert(text.includes('Hello, gateway-typed!'), `tools/call through the gateway answered ${text.slice(0, 300)}`);
				const wire = await waitFor('the CallTool of greet in the wire log', 10_000, () => {
					const events = h.wireLog('zig-grpc-typed');
					return events.slice(wireBefore).some(e => e.event === 'call' && e.path === TYPED_CALL_TOOL && wireCallSucceeded(events, e)) ? events : undefined;
				}, 250);
				ctx.details.wireCalls = describeWireCalls(wire.slice(wireBefore));
			},
		},
		{
			name: 'gateway Host/Origin checks: a foreign Host or Origin is refused with 403 and -32600 (DNS rebinding), a loopback Origin is accepted',
			group: 'gateway',
			fn: async ctx => {
				const route = await url('zig-http');
				const port = new URL(route).port;
				const benign = mutated(h, 'gateway-benign');
				const badHost = await rawModernPost(route, 'server/discover', {}, { host: benign ? `127.0.0.1:${port}` : 'evil.example' });
				const badOrigin = await rawModernPost(route, 'server/discover', {}, { origin: benign ? `http://127.0.0.1:${port}` : 'http://evil.example' });
				const goodOrigin = await rawModernPost(route, 'server/discover', {}, { origin: `http://127.0.0.1:${port}` });
				ctx.details.answers = { badHost: [badHost.status, badHost.message?.error], badOrigin: [badOrigin.status, badOrigin.message?.error], goodOrigin: goodOrigin.status };
				for (const [what, answer] of [['Host: evil.example', badHost], ['Origin: http://evil.example', badOrigin]] as const) {
					assert(answer.status === 403 && errorOf(answer.message).code === -32600, `${what} was answered ${answer.status} ${answer.body.slice(0, 200)}, expected 403 with -32600`);
				}
				assert(goodOrigin.status === 200, `a loopback Origin was answered ${goodOrigin.status} ${goodOrigin.body.slice(0, 200)}`);
			},
		},
		{
			name: 'gateway unknown route: a request to /gateway/<an id no route has> is 404 with -32601 "Gateway route not found"',
			group: 'gateway',
			fn: async ctx => {
				const route = new URL(await url('zig-http'));
				const unknown = mutated(h, 'gateway-benign') ? route.toString() : `${route.origin}/gateway/00000000-0000-4000-8000-000000000000`;
				const answer = await modernRequest(unknown, 'server/discover');
				ctx.details.answer = { status: answer.status, error: answer.response?.error };
				assert(answer.status === 404 && answer.response?.error?.code === -32601 && /route not found/i.test(answer.response.error.message), `an unknown route was answered ${answer.status} ${JSON.stringify(answer.response)}`);
			},
		},
		{
			name: 'gateway header check: a tools/call whose Mcp-Name header names another tool is 400 with -32020 (Header mismatch)',
			group: 'gateway',
			fn: async ctx => {
				const headers: Record<string, string> = mutated(h, 'gateway-benign') ? {} : { 'mcp-name': 'test_image_content' };
				const answer = await modernRequest(await url('zig-http'), 'tools/call', { name: 'test_simple_text', arguments: {} }, { headers });
				ctx.details.answer = { status: answer.status, error: answer.response?.error };
				assert(answer.status === 400 && answer.response?.error?.code === -32020 && /Header mismatch: Mcp-Name/.test(answer.response.error.message), `a mismatching Mcp-Name was answered ${answer.status} ${JSON.stringify(answer.response)}`);
			},
		},
		{
			name: 'gateway requestState check: a tools/call with a requestState the gateway did not seal is refused with -32602 (reason invalid_request_state) before it reaches the server',
			group: 'gateway',
			fn: async ctx => {
				const params = mutated(h, 'gateway-benign') ? { name: 'test_simple_text', arguments: {} } : { name: 'test_simple_text', arguments: {}, requestState: 'AAAA', inputResponses: {} };
				const answer = await modernRequest(await url('zig-http'), 'tools/call', params);
				ctx.details.answer = { status: answer.status, error: answer.response?.error };
				const data = answer.response?.error?.data as { reason?: string } | undefined;
				assert(answer.response?.error?.code === -32602 && data?.reason === 'invalid_request_state', `a foreign requestState was answered ${answer.status} ${JSON.stringify(answer.response)}`);
			},
		},
		{
			name: 'gateway dispose: after McpGateway.dispose() the routes of that gateway answer 404 while the other gateway keeps working',
			group: 'gateway',
			fn: async ctx => {
				const other = await vscode.lm.startMcpGateway();
				assert(other, 'vscode.lm.startMcpGateway() returned undefined');
				const route = serverOf(other, 'zig-http').address.toString(true);
				const before = await modernRequest(route, 'server/discover');
				assert(before.status === 200, `the new gateway's route answered ${before.status}`);
				if (!mutated(h, 'gateway-benign')) {
					other.dispose();
				}
				const after = await waitFor('the 404 of the disposed route', 10_000, async () => {
					const answer = await modernRequest(route, 'server/discover');
					return answer.status === 404 ? answer : undefined;
				}, 500).catch(() => undefined);
				ctx.details.after = after && { status: after.status, error: after.response?.error };
				assert(after?.response?.error?.code === -32601, `the disposed gateway's route still answers: ${JSON.stringify(ctx.details.after)}`);
				const alive = await modernRequest(await url('zig-http'), 'server/discover');
				assert(alive.status === 200, `the other gateway's route answered ${alive.status} after the dispose`);
			},
		},
		{
			name: 'gateway listen stream (zig-http-gw route): subscriptions/listen is acknowledged with its id, and when the server\'s tool list changes the stream carries notifications/tools/list_changed with that subscriptionId; the route then lists test_hidden_tool',
			group: 'gateway',
			fn: async ctx => {
				const label = 'zig-http-gw';
				await h.requireServer(label);
				const route = await url(label);
				const stream = openListenStream(route, { toolsListChanged: true });
				try {
					const status = await stream.status;
					assert(status === 200, `subscriptions/listen was answered ${status}`);
					const ack = await waitFor('the acknowledgement of the listen stream', 10_000, () => stream.messages.find(m => m.method === 'notifications/subscriptions/acknowledged'), 200);
					const ackId = ((ack.params as Record<string, unknown> | undefined)?._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID_META];
					ctx.details.ack = ack;
					assert(ackId === stream.requestId, `the acknowledgement carries subscriptionId ${JSON.stringify(ackId)}, the listen request id is ${stream.requestId}`);
					if (!mutated(h, 'gateway-listen-no-trigger')) {
						await expectToolText(h, ctx, label, 'test_trigger_tool_change', {}, ['Tool list changed']);
					}
					const changed = await waitFor('notifications/tools/list_changed on the gateway stream', 30_000, () => stream.messages.find(m => m.method === 'notifications/tools/list_changed'), 250);
					const id = ((changed.params as Record<string, unknown> | undefined)?._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID_META];
					ctx.details.changed = changed;
					assert(id === stream.requestId, `notifications/tools/list_changed carries subscriptionId ${JSON.stringify(id)}, the listen request id is ${stream.requestId}`);
					const list = await modernRequest(route, 'tools/list');
					const names = ((list.response?.result?.tools ?? []) as { name?: string }[]).map(t => t.name);
					assert(names.includes('test_hidden_tool'), `after the change the route lists ${JSON.stringify(names)}`);
				} finally {
					stream.close();
				}
			},
		},
		{
			name: 'gateway rate limits (zig-http route): a burst of 130 concurrent tools/call from one client exceeds its bucket (burst 100): the excess is refused with -32603, data.reason rate_limited, scope client and a retryAfterMs, and a call after that wait works',
			group: 'gateway',
			requires: 'gateway-rate-limits',
			fn: async ctx => {
				const route = await url('zig-http');
				const clientInfo = { name: 'mcp-e2e-rate-limit', version: String(Date.now()) };
				const call = () => modernRequest(route, 'tools/call', { name: 'test_simple_text', arguments: {} }, { clientInfo });
				const answers = [];
				if (mutated(h, 'gateway-rate-slow')) {
					for (let i = 0; i < 130; i++) {
						answers.push(await call());
						await sleep(30);
					}
				} else {
					answers.push(...await Promise.all(Array.from({ length: 130 }, call)));
				}
				const limited = answers.filter(a => (a.response?.error?.data as { reason?: string } | undefined)?.reason === 'rate_limited');
				const succeeded = answers.filter(a => JSON.stringify(a.response?.result ?? {}).includes('This is a simple text response'));
				const first = limited[0]?.response?.error;
				const data = first?.data as { scope?: string; retryAfterMs?: number; method?: string } | undefined;
				ctx.details.counts = { limited: limited.length, succeeded: succeeded.length, other: answers.length - limited.length - succeeded.length };
				ctx.details.firstLimited = first;
				if (!limited.length) {
					throw new SkipError(`none of 130 concurrent tools/call was rate limited (${succeeded.length} succeeded): this build has no gateway rate limits`);
				}
				assert(first?.code === -32603 && data?.scope === 'client' && data.method === 'tools/call' && (data.retryAfterMs ?? 0) > 0, `the refusal was ${JSON.stringify(first)}`);
				assert(succeeded.length >= 90 && succeeded.length <= 110, `${succeeded.length} of the 130 calls succeeded, expected about the burst of 100`);
				await sleep(Math.max(...limited.map(a => (a.response?.error?.data as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 0)) + 200);
				const later = await call();
				assert(JSON.stringify(later.response?.result ?? {}).includes('This is a simple text response'), `the call after the wait was answered ${JSON.stringify(later.response)}`);
			},
		},
	];
}
