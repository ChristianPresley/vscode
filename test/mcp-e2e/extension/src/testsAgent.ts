/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IAgentRun, IAgentTool, mcpToolNameOf, runAgent, toolPrefixOf, vscodeAgentTools } from './agent';
import { grpcTunnelCall, IJsonRpcResponse, modernRequest } from './gatewayClients';
import { E2eHarness, waitFor } from './harness';
import { describeWireCalls, loggedMessages, TUNNEL_CALL_PATH } from './mcpLog';
import { assert, ITestCase, ITestContext, SkipError } from './runner';
import { TYPED_CALL_TOOL, wireCallSucceeded } from './testHelpers';

/**
 * The agent tests: the llama model picks the tool and its arguments (the agent loop of agent.ts),
 * over stdio, the gRPC tunnel and typed bindings, and through the gateway (over HTTP and over its
 * gRPC listener). Every other test calls its tool directly.
 */

/** An expected substring, or a list of alternatives of which one must match (case-insensitive). */
type Expectation = string | RegExp | readonly (string | RegExp)[];

function matches(text: string, expectation: Expectation): boolean {
	const alternatives = Array.isArray(expectation) ? expectation : [expectation];
	return alternatives.some(a => typeof a === 'string' ? text.toLowerCase().includes(a.toLowerCase()) : a.test(text));
}

function describe(expectation: Expectation): string {
	return (Array.isArray(expectation) ? expectation : [expectation]).map(String).join(' | ');
}

export interface IToolScenario {
	readonly server: string;
	readonly task: string;
	/** The MCP tool name the model must call on that server. */
	readonly tool: string;
	/** The MCP tools offered to the model (default: every tool of the server); it must pick among them. */
	readonly offer?: readonly string[];
	/** What the tool result must contain. */
	readonly result?: readonly Expectation[];
	/** What the final answer must contain. */
	readonly answer?: readonly Expectation[];
	readonly maxTurns?: number;
}

/**
 * A short list of zig tools for the gRPC and gateway scenarios: the model still has to choose, but
 * among a few tools, so that what it picks depends on the task rather than on 40 tool definitions.
 */
const OFFERED_ZIG_TOOLS = ['test_simple_text', 'greet', 'test_image_content', 'test_embedded_resource', 'test_multiple_content_types'];

/**
 * Runs the agent loop with the given tools and checks that the model called the expected tool of
 * that server, that the tool result has the expected content, and that the answer reflects it.
 */
async function runAgentScenario(h: E2eHarness, ctx: ITestContext, s: IToolScenario, tools: readonly IAgentTool[], label: string): Promise<IAgentRun> {
	ctx.details.offered = tools.map(t => t.toolName);
	const run = await runAgent(h.env, s.task, { tools, label, maxTurns: s.maxTurns });
	ctx.details.task = s.task;
	ctx.details.answer = run.answer;
	ctx.details.calls = run.calls.map(c => ({ toolId: c.toolId, toolName: c.toolName, serverLabel: c.serverLabel, input: c.input, resultText: c.resultText, error: c.error }));
	const call = run.calls.find(c => c.toolName === s.tool && c.serverLabel === s.server);
	assert(call, `The model did not call ${s.tool} on ${s.server}; calls: ${JSON.stringify(run.calls.map(c => `${c.serverLabel}/${c.toolName}`))}`);
	assert(!call.error, `${s.tool} failed: ${call.error}`);
	for (const expectation of s.result ?? []) {
		assert(matches(call.resultText, expectation), `The result of ${s.tool} does not contain ${describe(expectation)}: ${JSON.stringify(call.resultText)}`);
	}
	for (const expectation of s.answer ?? []) {
		assert(matches(run.answer, expectation), `The answer does not contain ${describe(expectation)}: ${JSON.stringify(run.answer)}`);
	}
	return run;
}

/** The agent loop with VS Code's MCP tools of one server (all of them, or `s.offer`), each call through `vscode.lm.invokeTool`. */
export async function runToolScenario(h: E2eHarness, ctx: ITestContext, s: IToolScenario): Promise<IAgentRun> {
	await h.requireServer(s.server);
	const all = await h.waitForTools(s.server, 60_000);
	ctx.details.toolCount = all.length;
	ctx.details.toolPrefix = toolPrefixOf(all);
	const offered = s.offer ? all.filter(t => s.offer!.includes(mcpToolNameOf(t))) : all;
	assert(offered.length === (s.offer ?? all).length, `${s.server} lacks tools to offer: ${JSON.stringify(s.offer?.filter(n => !offered.some(t => mcpToolNameOf(t) === n)))}`);
	return runAgentScenario(h, ctx, s, vscodeAgentTools(offered), `${s.server}:${s.tool}`);
}

/** A test where the llama model picks the tool among those of a server: the prompt names the tool, and the model's choice is in the details (`calls`) either way. */
function agentTest(h: E2eHarness, name: string, s: IToolScenario): ITestCase {
	return { name, group: 'agent', fn: async ctx => { await runToolScenario(h, ctx, s); } };
}

/** The `tools/call` requests of `tool` that VS Code sent to a server after `fromOffset` of its MCP log. */
function sentToolCalls(logText: string, fromOffset: number, tool: string) {
	return loggedMessages(logText, fromOffset).filter(m => m.direction === 'sent' && m.message.method === 'tools/call' && m.message.params?.name === tool);
}

export function agentTests(h: E2eHarness): ITestCase[] {
	return [
		agentTest(h, 'agent (zig-stdio): the llama model picks test_simple_text among the tools of the server, and the answer quotes its text', {
			server: 'zig-stdio',
			task: 'Call the tool named test_simple_text (it takes no arguments) and tell me exactly what text it returned.',
			tool: 'test_simple_text',
			result: ['This is a simple text response'],
			answer: ['simple text response'],
		}),
		agentTest(h, 'agent (everything-legacy): the llama model picks get-sum with the arguments 17 and 25 and answers 42', {
			server: 'everything-legacy',
			task: 'What is 17 plus 25? Call the tool named get-sum with a=17 and b=25 and tell me the result.',
			tool: 'get-sum',
			result: ['The sum of 17 and 25 is 42'],
			answer: ['42'],
		}),
		{
			name: 'agent over gRPC tunnel (zig-grpc-tunnel): the llama model picks greet among five tools of the server, passes name Grace, the call goes over the tunnel, and the answer quotes "Hello, Grace!"',
			group: 'agent',
			fn: async ctx => {
				const label = 'zig-grpc-tunnel';
				await h.requireServer(label);
				const from = h.serverLog(label).length;
				await runToolScenario(h, ctx, {
					server: label,
					offer: OFFERED_ZIG_TOOLS,
					task: 'Greet the person named Grace: call the tool named greet with the argument name set to "Grace", then tell me exactly what the tool returned.',
					tool: 'greet',
					result: ['Hello, Grace!'],
					answer: ['Hello, Grace'],
				});
				// VS Code's side of the connection: the model's call went to this gRPC server.
				const sent = await h.waitForLog(label, 'the tools/call of greet in VS Code\'s MCP log', logText => {
					const calls = sentToolCalls(logText, from, 'greet');
					return calls.length ? { ok: true as const, details: calls.map(c => c.message.params?.arguments) } : { ok: false as const, reason: 'no tools/call of greet after the agent started' };
				});
				ctx.details.sentArguments = sent;
			},
		},
		{
			name: 'agent over gRPC typed (zig-grpc-typed): the llama model picks greet among five tools of the server, passes name Linus, the call reaches the server as a typed CallTool (nothing over the tunnel), and the answer quotes "Hello, Linus!"',
			group: 'agent',
			fn: async ctx => {
				const label = 'zig-grpc-typed';
				await h.requireServer(label);
				const wireBefore = h.wireLog(label).length;
				await runToolScenario(h, ctx, {
					server: label,
					offer: OFFERED_ZIG_TOOLS,
					task: 'Greet the person named Linus: call the tool named greet with the argument name set to "Linus", then tell me exactly what the tool returned.',
					tool: 'greet',
					result: ['Hello, Linus!'],
					answer: ['Hello, Linus'],
				});
				// The server's side: the model's call arrived as a typed CallTool.
				const wire = await waitFor('the typed CallTool of the model\'s greet in the wire log', 10_000, () => {
					const events = h.wireLog(label);
					return events.slice(wireBefore).some(e => e.event === 'call' && e.path === TYPED_CALL_TOOL && wireCallSucceeded(events, e)) ? events.slice(wireBefore) : undefined;
				}, 250);
				ctx.details.wireCalls = describeWireCalls(wire);
				const tunnel = wire.filter(e => e.event === 'call' && e.path === TUNNEL_CALL_PATH);
				assert(!tunnel.length, `JSON-RPC reached the typed server over the tunnel during the agent run: ${JSON.stringify(tunnel.map(c => c.jsonRpcMethods))}`);
			},
		},
	];
}

// --- Through the gateway ---------------------------------------------------------------------------

/** A client of one gateway route: one 2026-07-28 request, its final JSON-RPC answer. */
interface IRouteClient {
	readonly address: string;
	request(method: string, params: Record<string, unknown>): Promise<IJsonRpcResponse | undefined>;
}

function httpRoute(address: string): IRouteClient {
	return { address, request: async (method, params) => (await modernRequest(address, method, params)).response };
}

/** The gateway's gRPC listener, tunnel binding: the route is the last path segment of the address. */
function grpcRoute(address: string): IRouteClient {
	return {
		address,
		request: async (method, params) => {
			const exchange = await grpcTunnelCall(address, method, params);
			if (exchange.grpcStatus !== '0') {
				throw new Error(`${method} over the gateway's gRPC listener ended with grpc-status ${exchange.grpcStatus} ${exchange.grpcMessage ?? ''}`);
			}
			return exchange.messages.filter(m => m.id !== undefined && m.id !== null).at(-1);
		},
	};
}

/** A `tools/call` result of the gateway as a tool result for the model (text, the rest described). */
function toToolResult(result: Record<string, unknown> | undefined): vscode.LanguageModelToolResult {
	const content = Array.isArray(result?.content) ? result.content as { type?: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[] : [];
	return new vscode.LanguageModelToolResult(content.map(c => new vscode.LanguageModelTextPart(
		c.type === 'text' ? c.text ?? '' : c.type === 'resource' ? `[resource ${c.resource?.uri}] ${c.resource?.text ?? ''}` : `[${c.type} ${c.mimeType ?? ''}]`)));
}

/**
 * The tools of a gateway route as agent tools: listed with `tools/list` on the route and called with
 * `tools/call` there, so the model's call goes through the gateway (not through `vscode.lm`).
 */
async function gatewayAgentTools(route: IRouteClient, serverLabel: string, offer: readonly string[]): Promise<IAgentTool[]> {
	const list = await route.request('tools/list', {});
	const tools = (Array.isArray(list?.result?.tools) ? list.result.tools : []) as { name?: string; description?: string; inputSchema?: object }[];
	return tools.filter(t => t.name && offer.includes(t.name)).map((t): IAgentTool => ({
		name: t.name!,
		description: t.description ?? '',
		inputSchema: t.inputSchema,
		toolName: t.name!,
		serverLabel,
		invoke: async input => {
			const answer = await route.request('tools/call', { name: t.name, arguments: input });
			if (!answer?.result || answer.error || answer.result.isError === true) {
				throw new Error(`tools/call ${t.name} through the gateway route ${route.address} answered ${JSON.stringify(answer?.error ?? answer?.result ?? 'nothing')}`);
			}
			return toToolResult(answer.result);
		},
	}));
}

/** The address of a server's gateway route: over HTTP, or on the gateway's gRPC listener (`undefined` when this build has none). */
export type GatewayRouteOf = (label: string, kind: 'http' | 'grpc') => Promise<string | undefined>;

export function gatewayAgentTests(h: E2eHarness, routeOf: GatewayRouteOf): ITestCase[] {
	return [
		{
			name: 'agent through the gateway (HTTP route of zig-grpc-tunnel): the llama model gets the tools of the route from its tools/list, picks greet with name Ada, the call goes through the route to the gRPC server, and the answer quotes "Hello, Ada!"',
			group: 'agent',
			fn: async ctx => {
				const label = 'zig-grpc-tunnel';
				await h.requireServer(label);
				const address = await routeOf(label, 'http');
				assert(address, `the gateway has no route for ${label}`);
				ctx.details.route = address;
				const tools = await gatewayAgentTools(httpRoute(address), label, OFFERED_ZIG_TOOLS);
				assert(tools.length === OFFERED_ZIG_TOOLS.length, `the route lists ${JSON.stringify(tools.map(t => t.name))} of ${JSON.stringify(OFFERED_ZIG_TOOLS)}`);
				const from = h.serverLog(label).length;
				await runAgentScenario(h, ctx, {
					server: label,
					task: 'Greet the person named Ada: call the tool named greet with the argument name set to "Ada", then tell me exactly what the tool returned.',
					tool: 'greet',
					result: ['Hello, Ada!'],
					answer: ['Hello, Ada'],
				}, tools, `gateway-http:${label}:greet`);
				// The gateway forwarded the call over VS Code's connection to the gRPC server.
				ctx.details.upstreamArguments = await h.waitForLog(label, 'the forwarded tools/call of greet in VS Code\'s MCP log', logText => {
					const calls = sentToolCalls(logText, from, 'greet');
					return calls.length ? { ok: true as const, details: calls.map(c => c.message.params?.arguments) } : { ok: false as const, reason: 'no tools/call of greet reached the server after the agent started' };
				});
			},
		},
		{
			name: 'agent through the gateway over gRPC (gRPC listener, tunnel, route of zig-http): the llama model gets the tools of the route, picks test_simple_text, the call goes over gRPC through the gateway to the HTTP server, and the answer quotes its text',
			group: 'agent',
			requires: 'gateway-grpc',
			fn: async ctx => {
				const label = 'zig-http';
				await h.requireServer(label);
				const address = await routeOf(label, 'grpc');
				if (!address) {
					throw new SkipError('the gateway started with { grpc: true } reports no grpcAddress on this build (no gateway gRPC listener)');
				}
				ctx.details.route = address;
				const tools = await gatewayAgentTools(grpcRoute(address), label, OFFERED_ZIG_TOOLS);
				assert(tools.length === OFFERED_ZIG_TOOLS.length, `the route lists ${JSON.stringify(tools.map(t => t.name))} of ${JSON.stringify(OFFERED_ZIG_TOOLS)}`);
				const httpBefore = h.httpLog(label).length;
				await runAgentScenario(h, ctx, {
					server: label,
					task: 'Call the tool named test_simple_text (it takes no arguments) and tell me exactly what text it returned.',
					tool: 'test_simple_text',
					result: ['This is a simple text response'],
					answer: ['simple text response'],
				}, tools, `gateway-grpc:${label}:test_simple_text`);
				// The server's side (its HTTP proxy): the call arrived as a tools/call of test_simple_text.
				const forwarded = await waitFor('the forwarded tools/call in the zig-http request log', 10_000, () => {
					const events = h.httpLog(label).slice(httpBefore).filter(e => e.event === 'request' && e.messages?.some(m => m.method === 'tools/call' && m.name === 'test_simple_text'));
					return events.length ? events : undefined;
				}, 250);
				ctx.details.upstreamRequests = forwarded.map(e => ({ status: e.status, headers: e.headers, messages: e.messages }));
			},
		},
	];
}
