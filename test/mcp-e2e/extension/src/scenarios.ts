/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mcpToolNameOf, mcpToolsOf, selectLlamaModel, toolPrefixOf } from './agent';
import { definitionIdOf, startsWithOthers } from './config';
import { decodeCallToolResponse, decodeListToolsResponse, encodeCallToolRequest, grpcTunnelCall, grpcUnaryCall, IHttpExchange, LEGACY_VERSION, LegacySession, modernRequest, MODERN_VERSION, TYPED_PATH_PREFIX } from './gatewayClients';
import { E2eHarness, sleep, waitFor } from './harness';
import { LLAMA_MODEL_ID, LLAMA_VENDOR } from './llamaProvider';
import { canonicalJson, checkListenDelivery, declaresTasks, describeWireCalls, ILoggedExchange, ITaskRun, IWireEvent, lastInputResponses, LogCheck, loggedMessages, responseTo, sentMethods, TASKS_EXTENSION, taskResultText, taskRunOf, taskStatusOf, TUNNEL_CALL_PATH, TYPED_SERVICE_PREFIX } from './mcpLog';
import { assert, ITestCase, ITestContext, SkipError } from './runner';
import { errorText, expectToolText, invokeMcpTool, isCancellation, NEGOTIATED, textOf, toolIdOf, TYPED_CALL_TOOL, TYPED_LIST_TOOLS, wireCallSucceeded, wireEndOf } from './testHelpers';
import { agentTests, gatewayAgentTests, GatewayRouteOf } from './testsAgent';
import { chatTests } from './testsChat';
import { gatewayRestartTests, gatewayTests } from './testsGateway';
import { grpcTests } from './testsGrpc';
import { rootsTest, samplingTest } from './testsMrtr';
import { oauthScenarios } from './testsOauth';
import { protocolTests, restartTests } from './testsProtocol';
import { appsTests, resourceTests } from './testsResources';

/** A tool call made directly (no model): the tool, its input and what its result must contain. */
function callTest(h: E2eHarness, name: string, group: string, label: string, tool: string, input: object, expected: readonly string[]): ITestCase {
	return { name, group, fn: async ctx => { await expectToolText(h, ctx, label, tool, input, expected); } };
}

/** The tools every server of a family must list (a schema regression drops single tools, not all). */
const REQUIRED_TOOLS: Record<'zig' | 'everything', readonly string[]> = {
	zig: ['test_simple_text', 'greet', 'test_x_mcp_header', 'json_schema_2020_12_tool', 'slow_compute', 'test_input_required_result_sampling'],
	everything: ['echo', 'get-sum', 'trigger-sampling-request'],
};

/** The notifications the listen tests wait for (one constant each, so that a mutation test can change them). */
const TOOLS_LIST_CHANGED = 'notifications/tools/list_changed';
const PROMPTS_LIST_CHANGED = 'notifications/prompts/list_changed';

/** The server whose task tests run: Streamable HTTP, 2026-07-28, the Tasks extension in its server/discover. */
const TASK_SERVER = 'zig-http';
/** The `_meta` client capabilities of a request that may ask about tasks (`tasks/*` need the extension). */
const TASKS_CAPABILITIES = { extensions: { [TASKS_EXTENSION]: {} } };

/** VS Code only asks for a task when the server announced the extension in its server/discover answer. */
function assertDiscoverOffersTasks(h: E2eHarness, label: string): void {
	const messages = loggedMessages(h.serverLog(label));
	const request = messages.find(m => m.direction === 'sent' && m.message.method === 'server/discover');
	const answer = request && responseTo(messages, request);
	const extensions = (answer?.message.result?.capabilities as { extensions?: Record<string, unknown> } | undefined)?.extensions;
	assert(extensions?.[TASKS_EXTENSION] !== undefined, `${label} did not announce ${TASKS_EXTENSION} in server/discover (capabilities ${JSON.stringify(answer?.message.result?.capabilities)}); the task tests need a server that does`);
}

/** The task run of `tool` once its last `tasks/get` answered `completed`. */
function completedTaskRun(logText: string, fromOffset: number, tool: string): LogCheck<ITaskRun> {
	const run = taskRunOf(logText, fromOffset, tool);
	if (!run.ok) {
		return run;
	}
	const last = run.details.polls.at(-1);
	return taskStatusOf(last?.response) === 'completed'
		? run
		: { ok: false, reason: `the last tasks/get of task ${run.details.taskId} answered ${taskStatusOf(last?.response) ?? '(nothing yet)'} after ${run.details.polls.length} poll(s)` };
}

function describeTaskRun(run: ITaskRun): Record<string, unknown> {
	const exchange = (e: ILoggedExchange) => ({ id: e.request.message.id, answer: e.response?.message.result?.resultType ?? e.response?.message.result?.status ?? e.response?.message.error });
	return { taskId: run.taskId, calls: run.calls.map(exchange), created: run.created.result, polls: run.polls.map(p => taskStatusOf(p.response) ?? '(no answer)'), cancels: run.cancels.map(exchange) };
}

/** What the MCP log of a negative grpcs:// entry must name (Node's TLS errors, as the gRPC channel reports them). */
const CERTIFICATE_ERRORS: Record<'untrusted-certificate' | 'certificate-name', RegExp> = {
	'untrusted-certificate': /unable to verify the first certificate|unable to get local issuer certificate|self[- ]signed certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/i,
	'certificate-name': /does not match certificate's altnames|ERR_TLS_CERT_ALTNAME_INVALID/i,
};
/** What the MCP log of `binding: auto` against a server without the tunnel must name: the fix, `"binding": "typed"`. */
const BINDING_TYPED_HINT = /["']?binding["']?\s*:\s*["']?typed\b/i;
/** The `tls.serverName` of the zig-grpcs-wrong-name entry, which the server certificate does not cover. */
const WRONG_SERVER_NAME = 'wrong-name.mcp-e2e.test';
/** The sequential calls of the gRPC soak test: above the ~1,000 resets after which nghttp2 ends a session. */
const SOAK_CALLS = 1200;

/**
 * Waits for the `tools/call` retry of a multi round-trip tool in the server's MCP log and checks
 * the `inputResponses[key]` VS Code sent: what the server received, whatever the tool echoes.
 */
async function assertSubmitted(h: E2eHarness, ctx: ITestContext, label: string, tool: string, fromOffset: number, key: string, expected: unknown): Promise<void> {
	const submitted = await h.waitForLog(label, `the tools/call retry of ${tool} with inputResponses.${key}`, log => {
		const responses = lastInputResponses(log, tool, fromOffset);
		return responses?.[key] === undefined
			? { ok: false as const, reason: `no tools/call retry of ${tool} with inputResponses.${key} (inputResponses: ${JSON.stringify(responses)})` }
			: { ok: true as const, details: responses[key] };
	});
	ctx.details.submitted = submitted;
	assert(canonicalJson(submitted) === canonicalJson(expected), `VS Code submitted inputResponses.${key} = ${JSON.stringify(submitted)}, expected ${JSON.stringify(expected)}`);
}

function negotiationTest(h: E2eHarness, label: string): ITestCase {
	const server = h.server(label);
	// Only an explicit `binding: typed` speaks the typed service (`binding: auto` is the tunnel).
	const typed = server.transport === 'grpc-typed';
	const unpinnedHttp = server.era === 'legacy' && !server.pinned && server.transport === 'http';
	return {
		name: `negotiation ${label}: ${server.protocolVersion} (${server.era} era)${server.pinned ? ', pinned' : ''}${unpinnedHttp ? ', the HTTP probe refused' : ''}${typed ? ', server/discover answered by the typed binding (none on the wire), ListTools reached the server' : ''}`,
		group: server.grpc ? 'grpc' : 'negotiation',
		fn: async ctx => {
			// The servers start before the rows run in a full run; with -Only the row starts them itself.
			await h.requireServer(label);
			const file = h.serverLogFile(label);
			ctx.details.logFile = file;
			const match = await h.waitForLogLine(label, NEGOTIATED);
			ctx.details.negotiated = match[0];
			assert(match[1] === server.protocolVersion && match[2] === server.era, `${label} negotiated ${match[1]} (${match[2]}), expected ${server.protocolVersion} (${server.era})`);
			const methods = sentMethods(h.serverLog(label));
			ctx.details.firstMethods = methods.slice(0, 6);
			const discover = methods.indexOf('server/discover');
			const initialize = methods.indexOf('initialize');
			if (server.era === 'modern') {
				assert(discover !== -1, `${label}: no server/discover in the request log (is the window started with --log debug?)`);
				assert(initialize === -1, `${label}: a modern server got an initialize request`);
			} else if (server.pinned) {
				assert(initialize !== -1, `${label}: no initialize in the request log`);
				assert(discover === -1, `${label}: the pinned server was probed with server/discover`);
				// The initialize VS Code sent (not any message of the log, the server's answer included).
				const sent = loggedMessages(h.serverLog(label)).find(m => m.direction === 'sent' && m.message.method === 'initialize');
				ctx.details.initializeVersion = sent?.message.params?.protocolVersion;
				assert(sent?.message.params?.protocolVersion === '2025-11-25', `${label}: VS Code's initialize asked for ${JSON.stringify(sent?.message.params?.protocolVersion)}, expected the pinned 2025-11-25`);
			} else {
				assert(discover !== -1 && initialize > discover, `${label}: expected the server/discover probe and then initialize, got ${JSON.stringify(methods.slice(0, 6))}`);
				// Why VS Code fell back: the probe's answer (a JSON-RPC error over stdio, an HTTP refusal
				// otherwise) and the line that says so; a fallback after a timeout would log neither.
				const fellBack = /Server does not speak MCP 2026-07-28 \((.*)\); using the legacy initialize handshake/.exec(h.serverLog(label));
				ctx.details.fallback = fellBack?.[0];
				if (server.transport === 'stdio') {
					const messages = loggedMessages(h.serverLog(label));
					const probe = messages.find(m => m.direction === 'sent' && m.message.method === 'server/discover');
					const answer = probe && responseTo(messages, probe);
					ctx.details.probeAnswer = answer?.message.error;
					assert((answer?.message.error as { code?: number } | undefined)?.code === -32601, `${label}: the legacy server answered server/discover with ${JSON.stringify(answer?.message)}, expected -32601`);
					assert(fellBack && fellBack[1].startsWith('-32601'), `${label}: VS Code did not log the fallback for the -32601 ("Server does not speak MCP 2026-07-28 (-32601: ...)"): ${JSON.stringify(fellBack?.[0])}`);
				}
				if (unpinnedHttp) {
					// Over Streamable HTTP the legacy server refuses the probe with an HTTP error and no
					// JSON-RPC answer; that refusal (not a timeout) is what makes VS Code fall back.
					const messages = loggedMessages(h.serverLog(label));
					const probe = messages.find(m => m.direction === 'sent' && m.message.method === 'server/discover');
					const answer = probe && responseTo(messages, probe);
					ctx.details.probeAnswer = answer?.message;
					assert(!answer?.message.result, `${label}: the legacy server answered server/discover with a result: ${JSON.stringify(answer?.message)}`);
					const refused = /\b\d{3} status for a 2026-07-28 request\b.*/.exec(h.serverLog(label));
					ctx.details.probeRefused = refused?.[0];
					assert(refused, `${label}: VS Code's log does not say that the HTTP server refused the 2026-07-28 probe ("<status> status for a 2026-07-28 request ...")`);
					assert(fellBack, `${label}: VS Code did not log why it fell back ("Server does not speak MCP 2026-07-28 (...); using the legacy initialize handshake")`);
				}
			}
			if (typed) {
				// VS Code's log has the server/discover exchange, but the typed service has no discover
				// RPC: the binding answers it, so nothing of it may reach the server. The wire log of
				// runner/grpc-log-proxy.ts is the server's side.
				const messages = loggedMessages(h.serverLog(label));
				const request = messages.find(m => m.direction === 'sent' && m.message.method === 'server/discover');
				const answer = request && responseTo(messages, request);
				ctx.details.discoverAnswer = answer?.message.result;
				assert(Array.isArray(answer?.message.result?.supportedVersions), `${label}: no answer to server/discover in VS Code's MCP log`);
				// The synthesized answer names the server after the serverInfo of its ListTools response,
				// not after its address.
				const serverInfo = (answer?.message.result?._meta as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/serverInfo'] as { name?: string } | undefined;
				assert(serverInfo?.name === 'mcp-conformance-test-server', `${label}: the synthesized server/discover names the server ${JSON.stringify(serverInfo)}, expected mcp-conformance-test-server`);
				const wire = h.wireLog(label);
				ctx.details.wireCalls = describeWireCalls(wire).slice(0, 20);
				const tunnel = wire.filter(e => e.event === 'call' && e.path === TUNNEL_CALL_PATH);
				assert(!tunnel.length, `${label}: JSON-RPC reached the server over the tunnel ${JSON.stringify(tunnel.map(c => c.jsonRpcMethods ?? c.metadata))}; the typed binding must answer server/discover itself`);
				const listTools = wire.filter(e => e.event === 'call' && e.path === TYPED_LIST_TOOLS);
				assert(listTools.some(c => wireCallSucceeded(wire, c)), `${label}: no successful ListTools reached the server; calls: ${JSON.stringify(ctx.details.wireCalls)}`);
			}
		},
	};
}

/** A gateway server with the gRPC address of the gateway's listener (set for a gateway started with `{ grpc: true }`). */
type GrpcGatewayServer = vscode.McpGatewayServer & { readonly grpcAddress?: vscode.Uri };

function gatewayServer(gateway: vscode.McpGateway, label: string): GrpcGatewayServer {
	const server = gateway.servers.find(s => s.label === label);
	assert(server, `The gateway does not expose ${label}; it has ${JSON.stringify(gateway.servers.map(s => s.label))}`);
	return server;
}

/** `McpGatewayStartOptions` of the mcpServerDefinitions proposal: `grpc: true` opens (or joins) the gateway's gRPC listener. */
interface IMcpGatewayStartOptions {
	readonly grpc?: boolean;
}

/**
 * `vscode.lm.startMcpGateway(chatSessionResource?, options?)`. Typed here because the extension is
 * compiled against the vscode.d.ts of the commit under test, which may predate the options.
 */
function startMcpGateway(options?: IMcpGatewayStartOptions): Thenable<vscode.McpGateway | undefined> {
	const start = vscode.lm.startMcpGateway as (chatSessionResource?: vscode.Uri, options?: IMcpGatewayStartOptions) => Thenable<vscode.McpGateway | undefined>;
	return start.call(vscode.lm, undefined, options);
}

/** The route id of a gateway address: its last path segment (`/gateway/<routeId>` over HTTP, `/<routeId>` over gRPC). */
function routeIdOf(address: vscode.Uri): string | undefined {
	return address.path.split('/').filter(Boolean).at(-1);
}

function resultText(exchange: IHttpExchange): string {
	const content = exchange.response?.result?.content;
	return Array.isArray(content) ? content.map(c => (c as { text?: string }).text ?? '').join('\n') : '';
}

/** The tests that run in the extension host under `--extensionTestsPath`. */
export function apiTests(h: E2eHarness): ITestCase[] {
	// Two gateways: the HTTP one (started without options: no gRPC listener of its own) and, for the
	// gRPC tests, one started with `{ grpc: true }`.
	let gateway: vscode.McpGateway | undefined;
	const getGateway = async () => {
		gateway ??= await startMcpGateway();
		assert(gateway, 'vscode.lm.startMcpGateway() returned undefined');
		return gateway;
	};
	let grpcGateway: vscode.McpGateway | undefined;
	const getGrpcGateway = async () => {
		grpcGateway ??= await startMcpGateway({ grpc: true });
		assert(grpcGateway, 'vscode.lm.startMcpGateway(undefined, { grpc: true }) returned undefined');
		return grpcGateway;
	};
	/** The address of a server's route on the HTTP gateway, or on the gRPC listener of the opted-in one. */
	const routeOf: GatewayRouteOf = async (label, kind) => kind === 'http'
		? gatewayServer(await getGateway(), label).address.toString(true)
		: gatewayServer(await getGrpcGateway(), label).grpcAddress?.toString(true);

	/**
	 * Every server lists the tools of its family: not just some tools (a schema regression drops
	 * single ones). A server may add tools after the first tools/list and announce them with
	 * notifications/tools/list_changed (server-everything registers trigger-sampling-request once it
	 * has handled notifications/initialized, which can come after its answer to the first
	 * tools/list: runs final-r2 and final-r3), so a missing tool is waited for up to 15 s, and the
	 * tools that came late are recorded in the details.
	 */
	const assertRequiredTools = async (ctx: { details: Record<string, unknown> }, labels: readonly string[]) => {
		const missingNow = () => labels.flatMap(label => {
			const names = new Set(mcpToolsOf(label).map(mcpToolNameOf));
			return REQUIRED_TOOLS[h.server(label).family].filter(tool => !names.has(tool)).map(tool => `${label}: ${tool}`);
		});
		const late = missingNow();
		const deadline = Date.now() + 15_000;
		let missing = late;
		while (missing.length && Date.now() < deadline) {
			await sleep(250);
			missing = missingNow();
		}
		if (late.length) {
			ctx.details.lateTools = late.filter(t => !missing.includes(t));
		}
		assert(!missing.length, `tools missing from servers that started: ${JSON.stringify(missing)}`);
	};

	const tests: ITestCase[] = [
		{
			name: 'model: the llama.cpp provider is selectable and answers',
			group: 'model',
			fn: async ctx => {
				const model = await selectLlamaModel();
				ctx.details.model = { id: model.id, vendor: model.vendor, family: model.family, name: model.name, maxInputTokens: model.maxInputTokens };
				assert(model.vendor === LLAMA_VENDOR && model.id === LLAMA_MODEL_ID, `unexpected model ${model.vendor}/${model.id}`);
				const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('Reply with the single word READY and nothing else.')], {});
				let text = '';
				for await (const chunk of response.text) {
					text += chunk;
				}
				ctx.details.answer = text;
				assert(/ready/i.test(text), `unexpected answer ${JSON.stringify(text)}`);
			},
		},
		{
			name: 'servers: every configured server starts and lists its tools',
			group: 'transport',
			fn: async ctx => {
				const outcomes = await h.startServers();
				ctx.details.outcomes = outcomes;
				const broken = outcomes.filter(o => !h.server(o.label).grpc && (o.error || o.tools === 0));
				assert(!broken.length, `servers without tools: ${JSON.stringify(broken)}`);
				await assertRequiredTools(ctx, outcomes.filter(o => !h.server(o.label).grpc).map(o => o.label));
			},
		},
		{
			name: 'servers: the gRPC servers start and list their tools',
			group: 'grpc',
			fn: async ctx => {
				const outcomes = (await h.startServers()).filter(o => h.server(o.label).grpc);
				ctx.details.outcomes = outcomes;
				const broken = outcomes.filter(o => o.error || o.tools === 0);
				assert(!broken.length, `gRPC servers without tools: ${JSON.stringify(broken)}`);
				await assertRequiredTools(ctx, outcomes.map(o => o.label));
			},
		},

		// --- The model picks the tool (the agent loop; testsAgent.ts) -----------------------------------
		...agentTests(h),
		// --- The @e2e chat participant in the chat view (testsChat.ts) --------------------------------
		...chatTests(h),

		// --- One tool call per transport and era (called directly) -------------------------------------
		callTest(h, 'tool call over stdio (zig-stdio, 2026-07-28): test_simple_text', 'transport', 'zig-stdio', 'test_simple_text', {}, ['This is a simple text response']),
		callTest(h, 'tool call over Streamable HTTP (zig-http, 2026-07-28): test_image_content', 'transport', 'zig-http', 'test_image_content', {}, ['image/png']),
		callTest(h, 'tool call over gRPC tunnel (zig-grpc-tunnel, 2026-07-28): test_multiple_content_types', 'grpc', 'zig-grpc-tunnel', 'test_multiple_content_types', {}, ['Text content', 'image/png', 'test://mixed-content-resource']),
		callTest(h, 'tool call over gRPC typed (zig-grpc-typed, 2026-07-28): test_embedded_resource', 'grpc', 'zig-grpc-typed', 'test_embedded_resource', {}, ['test://embedded-resource']),
		callTest(h, 'tool call over stdio to a legacy server (everything-legacy, 2025-11-25 fallback): get-sum', 'transport', 'everything-legacy', 'get-sum', { a: 17, b: 25 }, ['The sum of 17 and 25 is 42']),
		callTest(h, 'tool call over Streamable HTTP to a pinned server (everything-pinned, protocolVersion 2025-11-25): echo', 'transport', 'everything-pinned', 'echo', { message: 'pinned-legacy-ok' }, ['Echo: pinned-legacy-ok']),
		callTest(h, 'tool call over Streamable HTTP to an unpinned legacy server (everything-unpinned, server/discover probe refused, 2025-11-25 fallback): echo', 'transport', 'everything-unpinned', 'echo', { message: 'unpinned-legacy-ok' }, ['Echo: unpinned-legacy-ok']),

		// --- input_required (multi round-trip requests) without UI ---------------------------------
		samplingTest(h, 'zig-http'),
		samplingTest(h, 'zig-grpc-tunnel'),
		rootsTest(h, 'zig-stdio'),
		rootsTest(h, 'zig-grpc-typed'),
		{
			name: 'legacy sampling (everything-legacy): trigger-sampling-request is answered by the llama provider',
			group: 'sampling',
			fn: async ctx => {
				const before = h.llamaRequests().length;
				const call = await expectToolText(h, ctx, 'everything-legacy', 'trigger-sampling-request', { prompt: 'Name the largest planet of the solar system in one word.', maxTokens: 100 }, ['LLM sampling result']);
				assert(call.text.includes(`${LLAMA_VENDOR}/${LLAMA_MODEL_ID}`), `the sampling result does not name the llama model: ${call.text}`);
				assert(/jupiter/i.test(call.text), `the sampled answer does not name Jupiter: ${call.text}`);
				const sampled = h.llamaRequests().slice(before).filter(r => JSON.stringify(r.messages).includes('Resource trigger-sampling-request context:'));
				ctx.details.samplingRequests = sampled.map(r => ({ seq: r.seq, messages: r.messages, content: r.content }));
				assert(sampled.length >= 1, 'llama.cpp never received the server\'s sampling/createMessage prompt');
			},
		},
		// --- Tasks extension (SEP-2663) -------------------------------------------------------------
		{
			name: `tasks (${TASK_SERVER}): slow_compute runs as a task: tools/call declares the Tasks extension, the answer is resultType "task", VS Code polls tasks/get until completed and the result reaches invokeTool`,
			group: 'tasks',
			fn: async ctx => {
				await h.requireServer(TASK_SERVER);
				const slow = toolIdOf(await h.waitForTools(TASK_SERVER), TASK_SERVER, 'slow_compute');
				assertDiscoverOffersTasks(h, TASK_SERVER);
				const from = h.serverLog(TASK_SERVER).length;
				const started = Date.now();
				const text = textOf(await vscode.lm.invokeTool(slow, { input: { seconds: 2, label: 'e2e-task' }, toolInvocationToken: undefined }));
				ctx.details.ms = Date.now() - started;
				ctx.details.result = text;
				// Without the task, the server runs slow_compute inline and answers the same text: the
				// task itself is only visible in VS Code's MCP log.
				assert(text.includes('computed e2e-task after 2 s'), `slow_compute returned ${JSON.stringify(text)}`);
				const run = await h.waitForLog(TASK_SERVER, 'the completed task of slow_compute', logText => completedTaskRun(logText, from, 'slow_compute'));
				ctx.details.task = describeTaskRun(run);
				assert(run.calls.length === 1, `VS Code sent ${run.calls.length} tools/call requests of slow_compute, expected one`);
				assert(run.polls.length >= 1 && run.polls.every(p => declaresTasks(p.request.message)), `the tasks/get requests (${run.polls.length}) must declare ${TASKS_EXTENSION}`);
				assert(taskResultText(run.polls.at(-1)!.response).includes('computed e2e-task after 2 s'), `the completed task carries ${JSON.stringify(run.polls.at(-1)!.response?.message.result)}`);
				assert(!run.cancels.length, `VS Code sent tasks/cancel for a task that completed: ${JSON.stringify(run.cancels.map(c => c.request.message))}`);
			},
		},
		{
			name: `tasks cancel (${TASK_SERVER}): cancelling the invokeTool of a running slow_compute task sends tasks/cancel once, invokeTool rejects at once, and the server reports the task cancelled`,
			group: 'tasks',
			fn: async ctx => {
				await h.requireServer(TASK_SERVER);
				const slow = toolIdOf(await h.waitForTools(TASK_SERVER), TASK_SERVER, 'slow_compute');
				const from = h.serverLog(TASK_SERVER).length;
				const cts = new vscode.CancellationTokenSource();
				const invocation = Promise.resolve(vscode.lm.invokeTool(slow, { input: { seconds: 60, label: 'e2e-cancel' }, toolInvocationToken: undefined }, cts.token))
					.then(result => ({ ok: true as const, text: textOf(result) }), (error: unknown) => ({ ok: false as const, error }));
				// Cancel while VS Code polls the task (it exists on the server and runs for a minute).
				const created = await h.waitForLog(TASK_SERVER, 'the first tasks/get of the slow_compute task', logText => {
					const run = taskRunOf(logText, from, 'slow_compute');
					return run.ok && !run.details.polls.length ? { ok: false as const, reason: `no tasks/get for task ${run.details.taskId} yet` } : run;
				}, 30_000);
				const cancelledAt = Date.now();
				cts.cancel();
				const outcome = await Promise.race([invocation, sleep(15_000).then(() => undefined)]);
				ctx.details.settledAfterMs = Date.now() - cancelledAt;
				assert(outcome, 'invokeTool did not settle within 15 s of the cancellation');
				assert(!outcome.ok, `invokeTool resolved after the cancellation: ${outcome.ok ? JSON.stringify(outcome.text) : ''}`);
				ctx.details.error = outcome.error instanceof Error ? { name: outcome.error.name, message: outcome.error.message } : String(outcome.error);
				assert(isCancellation(outcome.error), `invokeTool rejected with ${JSON.stringify(ctx.details.error)}, expected a cancellation`);
				const run = await h.waitForLog(TASK_SERVER, 'the answered tasks/cancel of the task', logText => {
					const r = taskRunOf(logText, from, 'slow_compute');
					if (!r.ok) {
						return r;
					}
					const cancel = r.details.cancels[0];
					return cancel?.response ? r : { ok: false as const, reason: cancel ? 'no answer to tasks/cancel yet' : `VS Code sent no tasks/cancel for task ${r.details.taskId}` };
				});
				ctx.details.task = describeTaskRun(run);
				assert(run.taskId === created.taskId, `the cancelled task ${run.taskId} is not the one VS Code polled (${created.taskId})`);
				assert(run.cancels.length === 1, `VS Code sent ${run.cancels.length} tasks/cancel requests for the task, expected one`);
				assert(declaresTasks(run.cancels[0].request.message), `tasks/cancel does not declare ${TASKS_EXTENSION}`);
				assert(!run.cancels[0].response?.message.error, `tasks/cancel failed: ${JSON.stringify(run.cancels[0].response?.message.error)}`);
				// The server's side: the task is cancelled (not still working, not completed).
				const state = await modernRequest(h.server(TASK_SERVER).mcp?.url ?? '', 'tasks/get', { taskId: run.taskId }, { clientCapabilities: TASKS_CAPABILITIES });
				ctx.details.serverTask = state.response?.result ?? state.response?.error;
				assert(state.response?.result?.status === 'cancelled', `the server reports task ${run.taskId} as ${JSON.stringify(ctx.details.serverTask)}, expected status cancelled`);
			},
		},

		// --- More of the 2026-07-28 protocol (testsProtocol.ts) --------------------------------------
		...protocolTests(h),

		// --- Subscriptions / listen ---------------------------------------------------------------
		...(['zig-stdio', 'zig-http', 'zig-grpc-tunnel'] as const).map((label): ITestCase => ({
			name: `listen (${label}): VS Code's subscriptions/listen is acknowledged, test_trigger_tool_change sends tools/list_changed on that stream, VS Code re-lists and test_hidden_tool appears without a restart`,
			group: h.server(label).grpc ? 'grpc' : 'listen',
			fn: async ctx => {
				await h.requireServer(label);
				const tools = await h.waitForTools(label);
				const hidden = `${toolPrefixOf(tools)}test_hidden_tool`;
				assert(!tools.some(t => t.name === hidden), `${hidden} is visible before the trigger`);
				const from = h.serverLog(label).length;
				await expectToolText(h, ctx, label, 'test_trigger_tool_change', {}, ['Tool list changed']);
				// The delivery itself, from VS Code's MCP log: the notification on the listen stream
				// (its subscriptionId is the id of VS Code's subscriptions/listen) and VS Code's re-list.
				ctx.details.delivery = await h.waitForLog(label, 'the tools/list_changed delivery', log => checkListenDelivery(log, from, 'tools', 'test_hidden_tool', TOOLS_LIST_CHANGED));
				const started = Date.now();
				await waitFor(`${hidden} in vscode.lm.tools`, 30_000, () => mcpToolsOf(label).some(t => t.name === hidden) ? true : undefined);
				ctx.details.hiddenToolAppearedAfterMs = Date.now() - started;
				assert(!h.serverLog(label).slice(from).includes('Connection state: Starting'), `${label} was restarted after the trigger`);
				const result = await vscode.lm.invokeTool(hidden, { input: {}, toolInvocationToken: undefined });
				const text = result.content.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('');
				assert(text.includes('hidden'), `${hidden} returned ${JSON.stringify(text)}`);
			},
		})),
		{
			name: 'gRPC typed (zig-grpc-typed): VS Code sends no subscriptions/listen to the typed server and tool calls still work',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpc-typed';
				await h.requireServer(label);
				const tools = await h.waitForTools(label, 30_000);
				ctx.details.toolCount = tools.length;
				const greet = toolIdOf(tools, label, 'greet');
				const wireBefore = h.wireLog(label).length;
				const result = await vscode.lm.invokeTool(greet, { input: { name: 'typed' }, toolInvocationToken: undefined });
				const text = result.content.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('');
				assert(text.includes('Hello, typed!'), `greet returned ${JSON.stringify(text)}`);
				// VS Code's MCP log, once it has the greet call (so it is current up to this test): a
				// listen would have been sent right after server/discover, long before.
				const sent = await h.waitForLog(label, 'the greet tools/call in the MCP log', log => {
					const messages = loggedMessages(log).filter(m => m.direction === 'sent');
					return messages.some(m => m.message.method === 'tools/call' && m.message.params?.name === 'greet')
						? { ok: true as const, details: messages.map(m => m.message.method ?? '(response)') }
						: { ok: false as const, reason: 'no tools/call of greet in the MCP log' };
				});
				ctx.details.sentMethods = [...new Set(sent)];
				assert(!sent.includes('subscriptions/listen'), `VS Code sent subscriptions/listen to the typed server: ${JSON.stringify(ctx.details.sentMethods)}`);
				// The server's side: greet arrived as a typed CallTool, and nothing went over the
				// JSON-RPC tunnel (the only way a listen stream could reach this server).
				const wire = await waitFor('the CallTool of greet in the wire log', 10_000, () => {
					const events = h.wireLog(label);
					return events.slice(wireBefore).some(e => e.event === 'call' && e.path === TYPED_CALL_TOOL && wireCallSucceeded(events, e)) ? events : undefined;
				}, 250);
				ctx.details.wireCalls = describeWireCalls(wire);
				const tunnel = wire.filter(e => e.event === 'call' && e.path === TUNNEL_CALL_PATH);
				assert(!tunnel.length, `JSON-RPC reached the typed server over the tunnel: ${JSON.stringify(tunnel.map(c => c.jsonRpcMethods ?? c.metadata))}`);
			},
		},

		{
			name: 'gRPC binding auto against a typed-only server (zig-grpc-auto-typed): the tunnel answers a bare UNIMPLEMENTED, VS Code must not connect, must name "binding": "typed" as the fix, and must send no typed RPC',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpc-auto-typed';
				const wireBefore = h.wireLog(label).length;
				// binding auto speaks only the tunnel; the typed service stays behind an explicit
				// binding: typed. The proxy forwards the typed RPCs, so a fallback would succeed here.
				const outcome = await h.startServer(label, 20_000, 10_000);
				ctx.details.outcome = outcome;
				assert(outcome.tools === 0, `${label} listed ${outcome.tools} tools: binding auto connected to a server without the tunnel`);
				ctx.details.errorLine = await h.waitForLog(label, 'the error that names "binding": "typed"', logText => {
					const line = logText.split('\n').find(l => BINDING_TYPED_HINT.test(l));
					return line
						? { ok: true as const, details: line.slice(0, 500) }
						: { ok: false as const, reason: `no line names "binding": "typed" as the fix; the last error and state lines: ${JSON.stringify(logText.split('\n').filter(l => /\[(error|warning)\]|Connection state/.test(l)).slice(-5))}` };
				}, 30_000);
				ctx.details.stateLines = h.serverLog(label).split('\n').filter(l => /Connection state/.test(l)).slice(-3);
				// The server's side: only tunnel calls (the server/discover probes of the start attempts),
				// each refused by the proxy, and no typed RPC at all.
				const wire = h.wireLog(label);
				const calls = wire.slice(wireBefore).filter(e => e.event === 'call');
				ctx.details.wireCalls = describeWireCalls(wire.slice(wireBefore));
				const typedCalls = wire.filter(e => e.event === 'call' && e.path?.startsWith(TYPED_SERVICE_PREFIX));
				assert(!typedCalls.length, `binding auto sent ${typedCalls.length} typed RPCs (${JSON.stringify(typedCalls.slice(0, 3).map(c => c.path))}); only binding: typed may`);
				assert(calls.length > 0, `no call reached ${label}: VS Code did not try the tunnel`);
				const notProbe = calls.filter(c => c.path !== TUNNEL_CALL_PATH || canonicalJson(c.jsonRpcMethods) !== canonicalJson(['server/discover']));
				assert(!notProbe.length, `besides the server/discover probes VS Code sent ${JSON.stringify(notProbe.slice(0, 3).map(c => `${c.path} ${JSON.stringify(c.jsonRpcMethods ?? [])}`))}`);
				const unrefused = calls.filter(c => { const end = wireEndOf(wire, c); return end?.grpcStatus !== '12' || end.refused !== true; });
				assert(!unrefused.length, `${unrefused.length} tunnel calls did not end with the proxy's UNIMPLEMENTED (12): ${JSON.stringify(unrefused.slice(0, 3).map(c => wireEndOf(wire, c)))}`);
			},
		},
		{
			name: 'gRPC over TLS (zig-grpcs, grpcs://localhost, tls.ca = the run\'s throw-away CA): the server starts, test_simple_text works, and the call arrived over TLS with SNI localhost and ALPN h2',
			group: 'grpc',
			fn: async ctx => {
				const label = 'zig-grpcs';
				await h.requireServer(label);
				const id = toolIdOf(await h.waitForTools(label, 30_000), label, 'test_simple_text');
				const text = textOf(await vscode.lm.invokeTool(id, { input: {}, toolInvocationToken: undefined }));
				ctx.details.result = text;
				assert(text.includes('This is a simple text response'), `test_simple_text returned ${JSON.stringify(text)}`);
				const wire = await waitFor('the tools/call of test_simple_text in the wire log', 10_000, () => {
					const events = h.wireLog(label);
					return events.some(e => e.event === 'call' && e.jsonRpcMethods?.includes('tools/call') && wireCallSucceeded(events, e)) ? events : undefined;
				}, 250);
				const tlsSessions = wire.filter(e => e.event === 'connection' && e.phase === 'open' && e.tls);
				ctx.details.tlsSessions = tlsSessions.map(e => ({ session: e.session, tls: e.tls }));
				const call = wire.find(e => e.event === 'call' && e.jsonRpcMethods?.includes('tools/call'));
				const session = tlsSessions.find(e => e.session === call?.session);
				assert(session?.tls?.servername === 'localhost' && session.tls.alpn === 'h2', `the tools/call came over connection ${call?.session}, whose TLS handshake was ${JSON.stringify(session?.tls)}; expected SNI localhost and ALPN h2`);
			},
		},
		...(['zig-grpcs-untrusted', 'zig-grpcs-wrong-name'] as const).map((label): ITestCase => {
			const kind = h.server(label).expectConnectError === 'certificate-name' ? 'certificate-name' : 'untrusted-certificate';
			const expected = CERTIFICATE_ERRORS[kind];
			return {
				name: kind === 'certificate-name'
					? `gRPC over TLS, negative (${label}): tls.serverName ${WRONG_SERVER_NAME} is not in the certificate: VS Code must not connect, its MCP log names the host name mismatch, and the handshake used that SNI`
					: `gRPC over TLS, negative (${label}): no tls.ca, so the throw-away CA is not trusted: VS Code must not connect and its MCP log names the certificate error`,
				group: 'grpc',
				fn: async ctx => {
					const wireBefore = h.wireLog(label).length;
					const outcome = await h.startServer(label, 20_000, 10_000);
					ctx.details.outcome = outcome;
					assert(outcome.tools === 0, `${label} listed ${outcome.tools} tools: VS Code connected although the certificate must be refused`);
					ctx.details.errorLine = await h.waitForLog(label, `a line matching ${expected}`, logText => {
						const line = logText.split('\n').find(l => expected.test(l));
						return line
							? { ok: true as const, details: line.slice(0, 500) }
							: { ok: false as const, reason: `no line names the certificate error; the last error and state lines: ${JSON.stringify(logText.split('\n').filter(l => /\[(error|warning)\]|Connection state/.test(l)).slice(-5))}` };
					}, 30_000);
					// The server's side: the client gave up on the certificate, either in the handshake (a
					// tls-error) or right after it (a TLS connection closed before any HTTP/2 request).
					const events = h.wireLog(label).slice(wireBefore);
					const tlsErrors = events.filter(e => e.event === 'tls-error');
					const opened = events.filter(e => e.event === 'connection' && e.phase === 'open' && e.tls);
					const abandoned = events.filter(e => e.event === 'connection' && e.phase === 'close' && opened.some(o => o.session === e.session) && !e.frames?.fromClient.HEADERS);
					ctx.details.server = { tlsErrors: tlsErrors.slice(0, 5), opened: opened.slice(0, 5).map(o => ({ session: o.session, tls: o.tls })), abandoned: abandoned.length };
					assert(tlsErrors.length + abandoned.length > 0, `the TLS front end of ${h.server(label).sharesProcessOf} saw no refused handshake while ${label} started`);
					if (kind === 'certificate-name') {
						const names = [...tlsErrors.map(e => e.servername), ...opened.map(o => o.tls?.servername)];
						assert(names.includes(WRONG_SERVER_NAME), `no handshake with SNI ${WRONG_SERVER_NAME}: VS Code did not use tls.serverName (${JSON.stringify(names)})`);
						const sessions = opened.filter(o => o.tls?.servername === WRONG_SERVER_NAME).map(o => o.session);
						const calls = events.filter(e => e.event === 'call' && sessions.includes(e.session));
						assert(!calls.length, `VS Code made ${calls.length} gRPC calls over a connection with the wrong server name: ${JSON.stringify(calls.slice(0, 2))}`);
					}
				},
			};
		}),
		{
			name: `gRPC soak (zig-grpc-soak): ${SOAK_CALLS} sequential greet calls on one VS Code gRPC channel through a Node http2 peer all succeed on one HTTP/2 session, without RST_STREAM from VS Code and without GOAWAY`,
			group: 'grpc',
			timeoutMs: 900_000,
			fn: async ctx => {
				const label = 'zig-grpc-soak';
				await h.requireServer(label);
				const greet = toolIdOf(await h.waitForTools(label, 30_000), label, 'greet');
				const wireBefore = h.wireLog(label).length;
				// Without the refill (config/servers.json): a session that sees 1000 resets ends, however slow the calls.
				ctx.details.resetLimit = h.wireLog(label).find(e => e.event === 'listening')?.resetLimit;
				const started = Date.now();
				let failure: string | undefined;
				let succeeded = 0;
				for (let i = 1; i <= SOAK_CALLS && !failure; i++) {
					try {
						const text = textOf(await vscode.lm.invokeTool(greet, { input: { name: `soak-${i}` }, toolInvocationToken: undefined }));
						if (text.includes(`Hello, soak-${i}!`)) {
							succeeded = i;
						} else {
							failure = `call ${i} returned ${JSON.stringify(text.slice(0, 200))}`;
						}
					} catch (e) {
						failure = `call ${i} failed: ${e instanceof Error ? e.message : String(e)}`;
					}
				}
				const ms = Date.now() - started;
				ctx.details.succeeded = succeeded;
				ctx.details.ms = ms;
				ctx.details.callsPerSecond = Math.round(succeeded / Math.max(ms / 1000, 0.001) * 10) / 10;
				// The mean time per call as invokeTool sees it (recorded, no threshold).
				ctx.details.meanMsPerCall = succeeded ? Math.round(ms / succeeded * 10) / 10 : undefined;
				// The proxy's record of the soak, also when a call failed (it says why).
				const isGreet = (e: IWireEvent) => e.event === 'call' && e.path === TUNNEL_CALL_PATH && !!e.jsonRpcMethods?.includes('tools/call');
				const wire = await waitFor(`${succeeded} greet calls in the wire log`, 15_000, () => {
					const events = h.wireLog(label).slice(wireBefore);
					return events.filter(isGreet).length >= succeeded ? events : undefined;
				}, 500).catch(() => h.wireLog(label).slice(wireBefore));
				const calls = wire.filter(isGreet);
				const sessions = [...new Set(calls.map(c => c.session))];
				const resets = wire.filter(e => e.event === 'rst' && e.from === 'client');
				const greetStreams = new Set(calls.map(c => `${c.session}/${c.h2Stream}`));
				const callResets = resets.filter(e => greetStreams.has(`${e.session}/${e.stream}`));
				const goaways = wire.filter(e => e.event === 'goaway');
				const sessionErrors = wire.filter(e => e.event === 'session-error');
				const connections = wire.filter(e => e.event === 'connection');
				ctx.details.wire = {
					greetCalls: calls.length,
					sessions,
					clientResets: resets.length,
					clientResetsOfCompletedCalls: callResets.filter(e => e.afterEnd).length,
					firstResets: resets.slice(0, 3),
					goaways: goaways.slice(0, 4),
					sessionErrors: sessionErrors.slice(0, 3),
					connections: connections.slice(0, 4),
				};
				const resetNote = `the proxy saw ${resets.length} RST_STREAM from VS Code (${callResets.filter(e => e.afterEnd).length} for completed calls) and GOAWAY ${JSON.stringify(goaways.slice(0, 2).map(g => ({ from: g.from, errorCode: g.errorCode })))}`;
				assert(!failure, `${failure} after ${succeeded} successful calls (${ctx.details.callsPerSecond} calls/s); ${resetNote}`);
				assert(calls.length >= SOAK_CALLS, `the proxy recorded ${calls.length} greet calls, expected ${SOAK_CALLS}`);
				assert(sessions.length === 1, `the ${calls.length} calls used ${sessions.length} HTTP/2 sessions (${JSON.stringify(sessions)}), expected one`);
				assert(!callResets.length, `VS Code reset ${callResets.length} of the ${calls.length} call streams (${callResets.filter(e => e.afterEnd).length} after the call had completed; first: ${JSON.stringify(callResets.slice(0, 2))}); ${resetNote}`);
				assert(!resets.length, `VS Code sent ${resets.length} RST_STREAM frames during the soak (first: ${JSON.stringify(resets.slice(0, 2))})`);
				assert(!goaways.length, `GOAWAY during the soak: ${JSON.stringify(goaways.slice(0, 4))}`);
				assert(!sessionErrors.length, `HTTP/2 session errors during the soak: ${JSON.stringify(sessionErrors.slice(0, 3))}`);
				assert(!connections.length, `connections opened or closed during the soak: ${JSON.stringify(connections.slice(0, 4))}`);
			},
		},

		// --- More gRPC: API definitions, -32020, deadlines, cancellation, TLS options (testsGrpc.ts) --
		...grpcTests(h),

		// --- Resources and prompts ------------------------------------------------------------------
		{
			name: 'resources (zig-http): test://static-text and test://static-binary through the mcp-resource file system',
			group: 'resources',
			fn: async ctx => {
				await h.requireServer('zig-http');
				const authority = Buffer.from(definitionIdOf(h.server('zig-http')), 'utf8').toString('hex');
				const text = vscode.Uri.from({ scheme: 'mcp-resource', authority, path: '/test/static-text' });
				const binary = vscode.Uri.from({ scheme: 'mcp-resource', authority, path: '/test/static-binary' });
				ctx.details.uris = [text.toString(), binary.toString()];
				const textContent = new TextDecoder().decode(await vscode.workspace.fs.readFile(text));
				ctx.details.text = textContent;
				assert(textContent === 'This is a static text resource', `unexpected content ${JSON.stringify(textContent)}`);
				const png = await vscode.workspace.fs.readFile(binary);
				ctx.details.binaryBytes = png.byteLength;
				assert(png.byteLength > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'test://static-binary is not a PNG');
			},
		},
		...resourceTests(h),
		...appsTests(h, routeOf),
		{
			name: 'prompts (zig-http through the gateway, 2026-07-28): prompts/list and prompts/get test_prompt_with_arguments',
			group: 'prompts',
			fn: async ctx => {
				const server = gatewayServer(await getGateway(), 'zig-http');
				const list = await modernRequest(server.address.toString(true), 'prompts/list');
				const names = ((list.response?.result?.prompts ?? []) as { name: string }[]).map(p => p.name);
				ctx.details.prompts = names;
				assert(names.includes('test_prompt_with_arguments'), `prompts/list has no test_prompt_with_arguments: ${JSON.stringify(list.response)}`);
				const get = await modernRequest(server.address.toString(true), 'prompts/get', { name: 'test_prompt_with_arguments', arguments: { arg1: 'alpha', arg2: 'beta' } });
				const text = JSON.stringify(get.response?.result?.messages ?? get.response);
				ctx.details.messages = get.response?.result?.messages;
				assert(text.includes('Prompt with arg1=alpha and arg2=beta'), `unexpected prompts/get answer ${text}`);
			},
		},
		{
			// The gateway forwards every prompts/list live, so it proves nothing about the listen
			// stream: the delivery is VS Code's (its MCP log); the gateway listen stream has its own test.
			name: 'listen prompts (zig-http): VS Code\'s subscriptions/listen is acknowledged, test_trigger_prompt_change sends prompts/list_changed on that stream, and VS Code re-lists test_hidden_prompt',
			group: 'listen',
			fn: async ctx => {
				await h.requireServer('zig-http');
				const from = h.serverLog('zig-http').length;
				await expectToolText(h, ctx, 'zig-http', 'test_trigger_prompt_change', {}, ['Prompt list changed']);
				ctx.details.delivery = await h.waitForLog('zig-http', 'the prompts/list_changed delivery', log => checkListenDelivery(log, from, 'prompts', 'test_hidden_prompt', PROMPTS_LIST_CHANGED));
			},
		},

		// --- Gateway --------------------------------------------------------------------------------
		...gatewayTests(h, getGateway),
		{
			name: 'gateway gRPC opt-in: a gateway started without { grpc: true } reports no grpcAddress and its routes are not reachable over the gRPC listener; one started with it has a grpcAddress for every server',
			group: 'grpc',
			requires: 'gateway-grpc',
			fn: async ctx => {
				const plain = await getGateway();
				const withAddress = plain.servers.filter(s => (s as GrpcGatewayServer).grpcAddress !== undefined);
				ctx.details.plain = plain.servers.map(s => ({ label: s.label, address: s.address.toString(true), grpcAddress: (s as GrpcGatewayServer).grpcAddress?.toString(true) }));
				assert(!withAddress.length, `the gateway started without { grpc: true } reports a grpcAddress for ${JSON.stringify(withAddress.map(s => s.label))}: the gRPC listener must open only on request`);
				const opted = await getGrpcGateway();
				ctx.details.opted = opted.servers.map(s => ({ label: s.label, address: s.address.toString(true), grpcAddress: (s as GrpcGatewayServer).grpcAddress?.toString(true) }));
				const grpc = gatewayServer(opted, 'zig-http');
				if (!grpc.grpcAddress) {
					throw new SkipError('the gateway started with { grpc: true } reports no grpcAddress either: this build serves no gateway gRPC listener');
				}
				const missing = opted.servers.filter(s => (s as GrpcGatewayServer).grpcAddress === undefined);
				assert(!missing.length, `the gateway started with { grpc: true } reports no grpcAddress for ${JSON.stringify(missing.map(s => s.label))}`);
				// A route of the plain gateway on the opted-in gateway's listener must be NOT_FOUND. That only
				// means something when a route id is the same over HTTP and gRPC, as on the opted-in gateway.
				const sameIds = routeIdOf(grpc.address) === routeIdOf(grpc.grpcAddress);
				ctx.details.routeIdsShared = sameIds;
				const plainRoute = routeIdOf(gatewayServer(plain, 'zig-http').address);
				if (sameIds && plainRoute) {
					const listener = grpc.grpcAddress.with({ path: `/${plainRoute}` }).toString(true);
					const probe = await grpcTunnelCall(listener, 'server/discover');
					ctx.details.plainRouteOverGrpc = { address: listener, grpcStatus: probe.grpcStatus, grpcMessage: probe.grpcMessage };
					assert(probe.grpcStatus === '5', `the route of the plain gateway answered over the gRPC listener with grpc-status ${probe.grpcStatus} ${probe.grpcMessage}, expected NOT_FOUND (5)`);
				}
			},
		},
		{
			name: `gateway 2026-07-28 client (zig-http): server/discover then tools/call test_simple_text`,
			group: 'gateway',
			fn: async ctx => {
				const url = gatewayServer(await getGateway(), 'zig-http').address.toString(true);
				const discover = await modernRequest(url, 'server/discover');
				ctx.details.discover = { status: discover.status, contentType: discover.contentType, result: discover.response?.result, error: discover.response?.error };
				assert(discover.status === 200, `server/discover answered ${discover.status}: ${JSON.stringify(discover.response)}`);
				const versions = discover.response?.result?.supportedVersions;
				assert(Array.isArray(versions) && versions.includes(MODERN_VERSION), `server/discover did not offer ${MODERN_VERSION}: ${JSON.stringify(discover.response)}`);
				const call = await modernRequest(url, 'tools/call', { name: 'test_simple_text', arguments: {} });
				ctx.details.call = { status: call.status, result: call.response?.result, error: call.response?.error };
				assert(resultText(call).includes('This is a simple text response'), `tools/call answered ${JSON.stringify(call.response)}`);
			},
		},
		{
			name: `gateway 2025-11-25 client (zig-http): initialize session then tools/call test_simple_text`,
			group: 'gateway',
			fn: async ctx => {
				const session = new LegacySession(gatewayServer(await getGateway(), 'zig-http').address.toString(true));
				try {
					const init = await session.initialize();
					ctx.details.initialize = { status: init.status, sessionId: session.sessionId, result: init.response?.result, error: init.response?.error };
					assert(init.response?.result?.protocolVersion === LEGACY_VERSION, `initialize answered ${JSON.stringify(init.response)}`);
					assert(session.sessionId, 'the gateway did not assign an Mcp-Session-Id');
					const call = await session.request('tools/call', { name: 'test_simple_text', arguments: {} });
					ctx.details.call = { status: call.status, result: call.response?.result, error: call.response?.error };
					assert(resultText(call).includes('This is a simple text response'), `tools/call answered ${JSON.stringify(call.response)}`);
				} finally {
					await session.close();
				}
			},
		},
		{
			name: `gateway 2026-07-28 client (everything-legacy): tools/call get-sum on a legacy upstream`,
			group: 'gateway',
			fn: async ctx => {
				const url = gatewayServer(await getGateway(), 'everything-legacy').address.toString(true);
				const call = await modernRequest(url, 'tools/call', { name: 'get-sum', arguments: { a: 2, b: 3 } });
				ctx.details.call = { status: call.status, result: call.response?.result, error: call.response?.error };
				assert(resultText(call).includes('The sum of 2 and 3 is 5'), `tools/call answered ${JSON.stringify(call.response)}`);
			},
		},
		{
			name: 'gateway over gRPC (started with { grpc: true }, grpcAddress, tunnel): NOT_FOUND without mcp-gateway-route, then server/discover and tools/call test_simple_text with the route id',
			group: 'grpc',
			requires: 'gateway-grpc',
			fn: async ctx => {
				const server = gatewayServer(await getGrpcGateway(), 'zig-http');
				if (!server.grpcAddress) {
					throw new SkipError('vscode.lm.startMcpGateway(undefined, { grpc: true }) reports no grpcAddress on this build (the gateway serves no gRPC listener)');
				}
				const address = server.grpcAddress.toString(true);
				ctx.details.grpcAddress = address;
				// The product listener has no default route: a call without mcp-gateway-route is refused.
				const unrouted = await grpcTunnelCall(address, 'server/discover', {}, { sendRoute: false });
				ctx.details.unrouted = { grpcStatus: unrouted.grpcStatus, grpcMessage: unrouted.grpcMessage };
				assert(unrouted.grpcStatus === '5', `a call without the mcp-gateway-route metadata ended with grpc-status ${unrouted.grpcStatus} ${unrouted.grpcMessage}, expected NOT_FOUND (5)`);
				const discover = await grpcTunnelCall(address, 'server/discover');
				ctx.details.discover = discover;
				assert(discover.grpcStatus === '0', `server/discover over gRPC: status ${discover.grpcStatus} ${discover.grpcMessage}`);
				const discovered = discover.messages.filter(m => m.id !== undefined).at(-1)?.result?.supportedVersions;
				assert(Array.isArray(discovered) && discovered.includes(MODERN_VERSION), `server/discover over gRPC answered ${JSON.stringify(discover.messages)}, expected supportedVersions with ${MODERN_VERSION}`);
				const call = await grpcTunnelCall(address, 'tools/call', { name: 'test_simple_text', arguments: {} });
				ctx.details.call = call;
				const final = call.messages.filter(m => m.id !== undefined).at(-1);
				assert(JSON.stringify(final?.result ?? {}).includes('This is a simple text response'), `tools/call over gRPC answered ${JSON.stringify(call)}`);
			},
		},
		{
			name: 'gateway over gRPC (started with { grpc: true }, grpcAddress, typed service model_context_protocol.Mcp): NOT_FOUND without mcp-gateway-route, then ListTools and CallTool test_simple_text with the route id, and a CallTool whose mcp_tool routing metadata names another tool is refused with -32020',
			group: 'grpc',
			requires: 'gateway-grpc',
			fn: async ctx => {
				const server = gatewayServer(await getGrpcGateway(), 'zig-http');
				if (!server.grpcAddress) {
					throw new SkipError('vscode.lm.startMcpGateway(undefined, { grpc: true }) reports no grpcAddress on this build (the gateway serves no gRPC listener)');
				}
				const address = server.grpcAddress.toString(true);
				ctx.details.grpcAddress = address;
				const listPath = `${TYPED_PATH_PREFIX}ListTools`;
				const callPath = `${TYPED_PATH_PREFIX}CallTool`;
				const unrouted = await grpcUnaryCall(address, listPath, Buffer.alloc(0), { sendRoute: false });
				ctx.details.unrouted = { grpcStatus: unrouted.grpcStatus, grpcMessage: unrouted.grpcMessage };
				assert(unrouted.grpcStatus === '5', `a typed ListTools without mcp-gateway-route ended with grpc-status ${unrouted.grpcStatus} ${unrouted.grpcMessage}, expected NOT_FOUND (5)`);
				const list = await grpcUnaryCall(address, listPath, Buffer.alloc(0));
				const names = list.messages.length === 1 ? decodeListToolsResponse(list.messages[0]) : [];
				ctx.details.list = { grpcStatus: list.grpcStatus, grpcMessage: list.grpcMessage, messages: list.messages.length, tools: names.length };
				assert(list.grpcStatus === '0' && names.includes('test_simple_text'), `typed ListTools answered ${JSON.stringify(ctx.details.list)} with tools ${JSON.stringify(names.slice(0, 10))}`);
				const call = await grpcUnaryCall(address, callPath, encodeCallToolRequest('test_simple_text'), { metadata: { 'mcp_tool': 'test_simple_text' } });
				const decoded = call.messages.length === 1 ? decodeCallToolResponse(call.messages[0]) : undefined;
				ctx.details.call = { grpcStatus: call.grpcStatus, grpcMessage: call.grpcMessage, result: decoded };
				assert(call.grpcStatus === '0' && decoded && !decoded.isError && decoded.texts.join('\n').includes('This is a simple text response'), `typed CallTool answered ${JSON.stringify(ctx.details.call)}`);
				const mismatch = await grpcUnaryCall(address, callPath, encodeCallToolRequest('test_simple_text'), { metadata: { 'mcp_tool': 'test_image_content' } });
				ctx.details.mismatch = { grpcStatus: mismatch.grpcStatus, grpcMessage: mismatch.grpcMessage, mcpErrorCode: mismatch.trailers['mcp-error-code'], messages: mismatch.messages.length };
				assert(mismatch.grpcStatus === '3' && mismatch.trailers['mcp-error-code'] === '-32020' && !mismatch.messages.length, `a CallTool whose mcp_tool metadata does not match the tool answered ${JSON.stringify(ctx.details.mismatch)}, expected INVALID_ARGUMENT (3) with mcp-error-code -32020 and no message`);
			},
		},

		// --- The model picks a tool of a gateway route (testsAgent.ts) ---------------------------------
		...gatewayAgentTests(h, routeOf),
	];

	// --- Protocol negotiation: read back from the MCP server logs --------------------------------
	// (not for the negative entries, which never negotiate, the ones their own tests start, nor the
	// UI-only ones, which this suite does not start)
	for (const server of h.servers.filter(startsWithOthers)) {
		tests.push(negotiationTest(h, server.label));
	}
	// Last: restarts (the cached era hint), after every row has read the first negotiation.
	tests.push(...restartTests(h));
	// After the restarts: the gateway routes of restarted servers (testsGateway.ts).
	tests.push(...gatewayRestartTests(h, routeOf));
	return tests;
}

/**
 * The scenarios the Playwright driver runs through the control server, because they need UI input
 * (the elicitation forms, the OAuth consent). The tools are called directly; the driver answers
 * the notification and quick input meanwhile.
 */
export function uiScenarios(h: E2eHarness): Map<string, ITestCase> {
	const scenarios = new Map<string, ITestCase>();
	const direct = (id: string, name: string, label: string, tool: string, expected: readonly string[], group = 'elicitation') =>
		scenarios.set(id, { name, group, timeoutMs: 240_000, fn: async ctx => { await expectToolText(h, ctx, label, tool, {}, expected); } });
	direct('test_input_required_result_elicitation', 'elicitation mrtr (zig-http): test_input_required_result_elicitation returns the submitted name', 'zig-http', 'test_input_required_result_elicitation', ['Hello, Ada Lovelace!']);
	// The two tools below only echo the action ("Defaults accept", "Elicitation accept"); the values
	// VS Code submitted are checked in the tools/call retry it sent (its MCP log).
	scenarios.set('test_elicitation_sep1034_defaults', {
		name: 'elicitation mrtr SEP-1034 defaults (zig-http): test_elicitation_sep1034_defaults accepts the defaults and submits name=anonymous, count=1',
		group: 'elicitation',
		timeoutMs: 240_000,
		fn: async ctx => {
			const from = h.serverLog('zig-http').length;
			await expectToolText(h, ctx, 'zig-http', 'test_elicitation_sep1034_defaults', {}, ['Defaults accept']);
			await assertSubmitted(h, ctx, 'zig-http', 'test_elicitation_sep1034_defaults', from, 'defaults', { action: 'accept', content: { name: 'anonymous', count: 1 } });
		},
	});
	scenarios.set('test_elicitation', {
		name: 'elicitation (zig-stdio): test_elicitation submits the entered value e2e-value',
		group: 'elicitation',
		timeoutMs: 240_000,
		fn: async ctx => {
			const from = h.serverLog('zig-stdio').length;
			await expectToolText(h, ctx, 'zig-stdio', 'test_elicitation', {}, ['Elicitation accept']);
			await assertSubmitted(h, ctx, 'zig-stdio', 'test_elicitation', from, 'input', { action: 'accept', content: { value: 'e2e-value' } });
		},
	});
	direct('trigger-elicitation-request', 'elicitation legacy elicitation/create (everything-legacy): trigger-elicitation-request returns the submitted values', 'everything-legacy', 'trigger-elicitation-request', ['Ada Lovelace']);
	direct('test_input_required_result_request_state', 'mrtr request_state (zig-http): test_input_required_result_request_state echoes the state', 'zig-http', 'test_input_required_result_request_state', ['state-ok request-state-nonce']);
	direct('test_input_required_result_request_state@zig-grpcs', 'mrtr request_state over gRPC with TLS (zig-grpcs): test_input_required_result_request_state echoes the state', 'zig-grpcs', 'test_input_required_result_request_state', ['state-ok request-state-nonce'], 'grpc');
	direct('test_input_required_result_multi_round', 'mrtr multi_round (zig-http): test_input_required_result_multi_round combines three rounds', 'zig-http', 'test_input_required_result_multi_round', ['Ada Lovelace likes teal']);
	direct('test_input_required_result_multiple_inputs', 'mrtr multiple_inputs (zig-http): elicitation, llama sampling and roots in one round', 'zig-http', 'test_input_required_result_multiple_inputs', [`Ada Lovelace: model ${LLAMA_VENDOR}/${LLAMA_MODEL_ID}, 1 roots`]);
	scenarios.set('test_tool_with_task', {
		name: `tasks with an input round (${TASK_SERVER}): test_tool_with_task asks for the name (MRTR elicitation), the retried tools/call becomes a task, and VS Code polls it to the result`,
		group: 'tasks',
		timeoutMs: 240_000,
		fn: async ctx => {
			const from = h.serverLog(TASK_SERVER).length;
			await expectToolText(h, ctx, TASK_SERVER, 'test_tool_with_task', {}, ['Hello, Ada Lovelace! The task is done.']);
			const run = await h.waitForLog(TASK_SERVER, 'the completed task of test_tool_with_task', logText => completedTaskRun(logText, from, 'test_tool_with_task'));
			ctx.details.task = describeTaskRun(run);
			// The input round first: an input_required answer, then the retry with the submitted name,
			// which the server answered with the task.
			assert(run.calls.length === 2, `expected two tools/call requests of test_tool_with_task (the input round, then the retry), got ${run.calls.length}`);
			assert(run.calls[0].response?.message.result?.resultType === 'input_required', `the first tools/call was answered with ${JSON.stringify(run.calls[0].response?.message.result?.resultType ?? run.calls[0].response?.message.error)}, expected input_required`);
			const submitted = (run.calls[1].request.message.params?.inputResponses as Record<string, unknown> | undefined)?.user_name;
			ctx.details.submitted = submitted;
			assert(canonicalJson(submitted) === canonicalJson({ action: 'accept', content: { name: 'Ada Lovelace' } }), `the retry submitted inputResponses.user_name = ${JSON.stringify(submitted)}`);
			assert(taskResultText(run.polls.at(-1)!.response).includes('Hello, Ada Lovelace! The task is done.'), `the completed task carries ${JSON.stringify(run.polls.at(-1)!.response?.message.result)}`);
		},
	});
	scenarios.set('confirm_delete', {
		name: `tasks with input inside the task (${TASK_SERVER}): confirm_delete runs as a task that asks for confirmation (tasks/get status input_required), VS Code answers with tasks/update and the task completes with "Deleted e2e.txt"`,
		group: 'tasks',
		timeoutMs: 240_000,
		fn: async ctx => {
			const from = h.serverLog(TASK_SERVER).length;
			const call = await invokeMcpTool(h, ctx, TASK_SERVER, 'confirm_delete', { filename: 'e2e.txt' });
			assert(call.error === undefined && call.text.includes('Deleted e2e.txt'), `confirm_delete returned ${call.error === undefined ? JSON.stringify(call.text) : errorText(call.error)}`);
			const run = await h.waitForLog(TASK_SERVER, 'the completed task of confirm_delete', logText => completedTaskRun(logText, from, 'confirm_delete'));
			ctx.details.task = { ...describeTaskRun(run), updates: run.updates.map(u => u.request.message.params) };
			assert(run.polls.some(p => taskStatusOf(p.response) === 'input_required'), `no tasks/get answered input_required: ${JSON.stringify(run.polls.map(p => taskStatusOf(p.response)))}`);
			assert(run.updates.length === 1 && !run.updates[0].response?.message.error, `expected one answered tasks/update, got ${JSON.stringify(run.updates.map(u => ({ params: u.request.message.params, error: u.response?.message.error })))}`);
			const confirm = (run.updates[0].request.message.params?.inputResponses as Record<string, unknown> | undefined)?.confirm;
			assert(canonicalJson(confirm) === canonicalJson({ action: 'accept', content: { confirm: 'yes' } }), `tasks/update submitted inputResponses.confirm = ${JSON.stringify(confirm)}`);
			assert(taskResultText(run.polls.at(-1)!.response).includes('Deleted e2e.txt'), `the completed task carries ${JSON.stringify(run.polls.at(-1)!.response?.message.result)}`);
		},
	});
	for (const [id, test] of oauthScenarios(h)) {
		scenarios.set(id, test);
	}
	return scenarios;
}
