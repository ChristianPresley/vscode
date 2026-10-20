/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as net from 'net';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { GrpcStatus, decodeBinaryMetadata } from '../../../../base/common/grpc/status.js';
import { decodeMessage, encodeMessage } from '../../../../base/common/protobuf/codec.js';
import { decodeUtf8, encodeUtf8 } from '../../../../base/common/protobuf/wire.js';
import { GrpcChannel, IGrpcCallOptions, IGrpcChannelOptions, IGrpcTrailers } from '../../../../base/node/grpcChannel.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogger, NullLoggerService } from '../../../log/common/log.js';
import { IMcpGatewayInputRequired, IMcpGatewayInvokeContext, IMcpGatewayToolInvoker } from '../../common/mcpGateway.js';
import { JSON_RPC_MESSAGE, MCP_ERROR_BIN_TRAILER, MCP_ERROR_CODE_TRAILER, MCP_PROTOCOL_VERSION_METADATA, TUNNEL_CALL_PATH, TYPED_RPCS, TypedRpcName } from '../../common/mcpGrpcProto.js';
import { decodeTypedResponse, encodeTypedRequest, routingMetadataFor } from '../../common/mcpGrpcTyped.js';
import { buildMirroredHeaders, MCP_PROTOCOL_VERSION_HEADER } from '../../common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_SERVER_INFO, META_SUBSCRIPTION_ID } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { CONFORMANCE_HIDDEN_TOOL, CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { GRPC_ROUTE_METADATA_KEY, isLoopbackAuthority, McpGatewayGrpcListener } from '../../node/mcpGatewayGrpc.js';
import { McpGatewayRoute } from '../../node/mcpGatewayRoute.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';
import { McpGatewayService } from '../../node/mcpGatewayService.js';
import { modernMeta } from './mcpGatewayTestUtils.js';

type Json = Record<string, unknown>;

/** Records warnings (the destructiveHint note is one). */
class RecordingLogger extends NullLogger {
	readonly warnings: string[] = [];
	override warn(message: string): void {
		this.warnings.push(message);
	}
}

/** The conformance invoker plus a tool that waits for cancellation, one with `destructiveHint: false` and a task tool. */
class TestInvoker extends McpGatewayConformanceInvoker {
	readonly cancelled = new DeferredPromise<void>();
	readonly unsubscribed = new DeferredPromise<string>();

	override async subscribeResource(uri: string): Promise<IDisposable> {
		const subscription = await super.subscribeResource(uri);
		return toDisposable(() => {
			subscription.dispose();
			this.unsubscribed.complete(uri);
		});
	}

	override async listTools(): Promise<readonly MCPLegacy.Tool[]> {
		return [
			...await super.listTools(),
			{ name: 'safe_tool', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: false } },
			{ name: 'task_tool', inputSchema: { type: 'object', properties: {} }, execution: { taskSupport: 'optional' } },
		];
	}

	override async callTool(name: string, args: Record<string, unknown>, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.CallToolResult | IMcpGatewayInputRequired> {
		if (name === 'block') {
			try {
				await timeout(10_000, context?.token ?? CancellationToken.None);
			} finally {
				if (context?.token.isCancellationRequested) {
					this.cancelled.complete();
				}
			}
			return { content: [{ type: 'text', text: 'not cancelled' }] };
		}
		return super.callTool(name, args, context);
	}
}

function bytesOf(text: string): Uint8Array {
	return encodeUtf8(text);
}

function tunnelPayload(body: object | string): Uint8Array {
	return encodeMessage(JSON_RPC_MESSAGE, { jsonrpc: bytesOf(typeof body === 'string' ? body : JSON.stringify(body)) });
}

function decodeTunnel(payload: Uint8Array): Json {
	return JSON.parse(decodeUtf8(decodeMessage(JSON_RPC_MESSAGE, payload).jsonrpc as Uint8Array));
}

/** The JSON-RPC error response of `mcp-error-bin`. */
function errorBin(trailers: IGrpcTrailers): { id: unknown; error: { code: number; message: string; data?: Json } } {
	const bin = trailers.raw[MCP_ERROR_BIN_TRAILER];
	assert.ok(bin, `mcp-error-bin is present: ${JSON.stringify(trailers.raw)}`);
	return JSON.parse(VSBuffer.wrap(decodeBinaryMetadata(bin)).toString());
}

function lowercase(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

interface ITunnelRequest {
	readonly body: Json;
	readonly metadata: Record<string, string>;
}

/** A well-formed 2026-07-28 tunnel call: `_meta` in the params and the mirrored metadata. */
function tunnelRequest(method: string, params: Json = {}, options: { id?: number | string; capabilities?: MCP.ClientCapabilities; metadata?: Record<string, string> } = {}): ITunnelRequest {
	const fullParams = { ...params, _meta: { ...modernMeta(options.capabilities ?? {}), ...(params._meta as Json | undefined) } };
	return {
		body: { jsonrpc: '2.0', id: options.id ?? 1, method, params: fullParams },
		metadata: lowercase({ [MCP_PROTOCOL_VERSION_HEADER]: LATEST_MCP_PROTOCOL_VERSION, ...buildMirroredHeaders(method, fullParams), ...options.metadata }),
	};
}

interface ITunnelOutcome {
	readonly messages: Json[];
	readonly trailers: IGrpcTrailers;
}

async function runTunnel(channel: GrpcChannel, request: ITunnelRequest | { body: object | string; metadata: Record<string, string> }, options?: IGrpcCallOptions): Promise<ITunnelOutcome> {
	const call = channel.call(TUNNEL_CALL_PATH, request.metadata, tunnelPayload(request.body), options);
	const messages: Json[] = [];
	try {
		for await (const message of call.messages) {
			messages.push(decodeTunnel(message));
		}
	} catch {
		// The status is in the trailers.
	}
	return { messages, trailers: await call.trailers };
}

interface ITypedOutcome {
	readonly result: Json | undefined;
	readonly trailers: IGrpcTrailers;
}

function rpcNamed(name: TypedRpcName) {
	const rpc = TYPED_RPCS.find(r => r.name === name);
	assert.ok(rpc);
	return rpc;
}

async function runTyped(channel: GrpcChannel, name: TypedRpcName, params: Json, metadata: Record<string, string> = {}, routing = true): Promise<ITypedOutcome> {
	const rpc = rpcNamed(name);
	const call = channel.call(rpc.path, { [MCP_PROTOCOL_VERSION_METADATA]: LATEST_MCP_PROTOCOL_VERSION, ...(routing ? routingMetadataFor(rpc, params) : {}), ...metadata }, encodeTypedRequest(rpc, params));
	const payloads: Uint8Array[] = [];
	try {
		for await (const payload of call.messages) {
			payloads.push(payload);
		}
	} catch {
		// The status is in the trailers.
	}
	return { result: payloads.length ? decodeTypedResponse(rpc, payloads[0]) : undefined, trailers: await call.trailers };
}

function firstText(result: Json | undefined): string | undefined {
	const content = result?.content as { type: string; text?: string }[] | undefined;
	return content?.[0]?.text;
}

suite('MCP - Gateway gRPC listener', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const sealedState = new McpGatewaySealedState();

	let logger: RecordingLogger;
	let invoker: TestInvoker;
	let route: McpGatewayRoute;
	let listener: McpGatewayGrpcListener;
	let routeRegistration: { dispose(): void };
	let port: number;

	setup(async () => {
		logger = new RecordingLogger();
		invoker = store.add(new TestInvoker());
		route = store.add(new McpGatewayRoute('route-a', logger, invoker, sealedState, 'conformance', { serverInfo: CONFORMANCE_SERVER_INFO }));
		listener = store.add(new McpGatewayGrpcListener(logger, { server: { shutdownGraceMs: 100 } }));
		listener.registerTunnelService();
		listener.registerTypedService();
		routeRegistration = store.add(listener.addRoute(route.routeId, route.dispatcher, invoker));
		port = await listener.listen();
	});

	teardown(async () => {
		await listener.close();
	});

	function channel(options: Partial<IGrpcChannelOptions> = {}): GrpcChannel {
		return store.add(new GrpcChannel({ authority: `127.0.0.1:${port}`, secure: false, ...options }));
	}

	function addSecondRoute(): McpGatewayRoute {
		const other = store.add(new McpGatewayRoute('route-b', logger, invoker, sealedState, 'second', { serverInfo: { name: 'second-server', version: '2.0.0' } }));
		store.add(listener.addRoute(other.routeId, other.dispatcher, invoker));
		return other;
	}

	// ---- tunnel ---------------------------------------------------------------------

	test('the tunnel serves server/discover on the only route, with or without the route metadata', async () => {
		const ch = channel();
		const variants: Record<string, string>[] = [{}, { [GRPC_ROUTE_METADATA_KEY]: route.routeId }];
		for (const metadata of variants) {
			const { messages, trailers } = await runTunnel(ch, tunnelRequest('server/discover', {}, { metadata }));
			assert.strictEqual(trailers.status, GrpcStatus.OK);
			assert.strictEqual(messages.length, 1);
			const result = messages[0].result as Json;
			assert.deepStrictEqual(result.supportedVersions, [LATEST_MCP_PROTOCOL_VERSION]);
			assert.deepStrictEqual((result._meta as Json)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
		}
	});

	test('a tunnel call streams the request\'s notifications before its response', async () => {
		const { messages, trailers } = await runTunnel(channel(), tunnelRequest('tools/call', { name: 'add', arguments: { a: 40, b: 2 }, _meta: { progressToken: 'p1' } }, { id: 7 }));
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.deepStrictEqual(messages.map(m => m.method ?? 'response'), ['notifications/progress', 'response']);
		assert.deepStrictEqual(messages[0].params, { progressToken: 'p1', progress: 1, total: 2, message: 'adding' });
		assert.strictEqual(messages[1].id, 7);
		assert.strictEqual(firstText(messages[1].result as Json), '42');
	});

	test('an error of a request that ran is an error response with status 0', async () => {
		const { messages, trailers } = await runTunnel(channel(), tunnelRequest('tools/call', { name: 'no_such_tool', arguments: {} }));
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.strictEqual(messages.length, 1);
		assert.strictEqual((messages[0].error as Json).code, MCP.INVALID_PARAMS);
	});

	test('a header mismatch ends the call before the request runs: -32020 in mcp-error-bin', async () => {
		const request = tunnelRequest('tools/call', { name: 'add', arguments: { a: 1, b: 2 } }, { id: 'x1' });
		const metadata = { ...request.metadata };
		delete metadata['mcp-name'];
		const { messages, trailers } = await runTunnel(channel(), { body: request.body, metadata });
		assert.strictEqual(messages.length, 0);
		assert.strictEqual(trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(trailers.raw[MCP_ERROR_CODE_TRAILER], String(MCP.HEADER_MISMATCH));
		const response = errorBin(trailers);
		assert.strictEqual(response.id, 'x1');
		assert.strictEqual(response.error.code, MCP.HEADER_MISMATCH);
		assert.match(trailers.message ?? '', /Mcp-Name/);
	});

	test('an unsupported protocol version is -32022 with the supported versions', async () => {
		const request = tunnelRequest('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } }, { metadata: { 'mcp-protocol-version': '2099-01-01' } });
		const { trailers } = await runTunnel(channel(), request);
		assert.strictEqual(trailers.status, GrpcStatus.INVALID_ARGUMENT);
		const response = errorBin(trailers);
		assert.strictEqual(response.error.code, MCP.UNSUPPORTED_PROTOCOL_VERSION);
		assert.deepStrictEqual(response.error.data?.supported, [LATEST_MCP_PROTOCOL_VERSION]);

		const initialize = await runTunnel(channel(), { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } } }, metadata: {} });
		assert.strictEqual(initialize.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(errorBin(initialize.trailers).error.code, MCP.UNSUPPORTED_PROTOCOL_VERSION);
	});

	test('malformed and unexpected tunnel messages', async () => {
		const ch = channel();
		const unknown = await runTunnel(ch, tunnelRequest('nothing/here'));
		assert.strictEqual(unknown.trailers.status, GrpcStatus.UNIMPLEMENTED);
		assert.strictEqual(errorBin(unknown.trailers).error.code, MCP.METHOD_NOT_FOUND);

		const notification = await runTunnel(ch, { body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, metadata: {} });
		assert.strictEqual(notification.trailers.status, GrpcStatus.OK);
		assert.deepStrictEqual(notification.messages, []);

		const parse = await runTunnel(ch, { body: '{"jsonrpc":', metadata: {} });
		assert.strictEqual(parse.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(errorBin(parse.trailers).error.code, MCP.PARSE_ERROR);
		assert.strictEqual(errorBin(parse.trailers).id, null);

		const batch = await runTunnel(ch, { body: [tunnelRequest('tools/list').body], metadata: {} });
		assert.strictEqual(errorBin(batch.trailers).error.code, MCP.INVALID_REQUEST);
		const response = await runTunnel(ch, { body: { jsonrpc: '2.0', id: 1, result: {} }, metadata: {} });
		assert.strictEqual(errorBin(response.trailers).error.code, MCP.INVALID_REQUEST);

		const notAMessage = ch.call(TUNNEL_CALL_PATH, {}, new Uint8Array([0xff, 0xff, 0xff]));
		const trailers = await notAMessage.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.match(trailers.message ?? '', /JsonRpcMessage/);
	});

	test('subscriptions/listen acknowledges, forwards events and ends gracefully when the route goes away', async () => {
		const request = tunnelRequest('subscriptions/listen', { notifications: { toolsListChanged: true } }, { id: 'listen-1' });
		const call = channel().call(TUNNEL_CALL_PATH, request.metadata, tunnelPayload(request.body));
		const messages: Json[] = [];
		for await (const payload of call.messages) {
			const message = decodeTunnel(payload);
			messages.push(message);
			if (message.method === 'notifications/subscriptions/acknowledged') {
				invoker.setToolHidden(CONFORMANCE_HIDDEN_TOOL, false);
			} else if (message.method === 'notifications/tools/list_changed') {
				routeRegistration.dispose();
			}
		}
		assert.strictEqual((await call.trailers).status, GrpcStatus.OK);
		assert.deepStrictEqual(messages.map(m => m.method ?? 'result'), ['notifications/subscriptions/acknowledged', 'notifications/tools/list_changed', 'result']);
		assert.deepStrictEqual((messages[0].params as Json).notifications, { toolsListChanged: true });
		assert.strictEqual(((messages[1].params as Json)._meta as Json)[META_SUBSCRIPTION_ID], 'listen-1');
		assert.strictEqual(messages[2].id, 'listen-1');
		assert.strictEqual((messages[2].result as Json).resultType, 'complete');

		// The route is gone: NOT_FOUND, even for the only-route default.
		const after = await runTunnel(channel(), tunnelRequest('server/discover'));
		assert.strictEqual(after.trailers.status, GrpcStatus.NOT_FOUND);
	});

	test('a client reset ends a listen stream and its resource subscriptions', async () => {
		const uri = 'test://watched-resource';
		const request = tunnelRequest('subscriptions/listen', { notifications: { resourceSubscriptions: [uri] } });
		const call = channel().call(TUNNEL_CALL_PATH, request.metadata, tunnelPayload(request.body));
		const iterator = call.messages[Symbol.asyncIterator]();
		const ack = decodeTunnel((await iterator.next()).value);
		assert.strictEqual(ack.method, 'notifications/subscriptions/acknowledged');
		// The registry subscribes right after it sends the acknowledgement.
		assert.strictEqual(invoker.subscriptionCount(uri), 1);
		call.cancel();
		assert.strictEqual((await call.trailers).status, GrpcStatus.CANCELLED);
		assert.strictEqual(await invoker.unsubscribed.p, uri);
		assert.strictEqual(invoker.subscriptionCount(uri), 0);
	});

	test('a client reset and grpc-timeout cancel the request in the dispatcher', async () => {
		const reset = channel().call(TUNNEL_CALL_PATH, tunnelRequest('tools/call', { name: 'block', arguments: {} }).metadata, tunnelPayload(tunnelRequest('tools/call', { name: 'block', arguments: {} }).body));
		await timeout(50);
		reset.cancel();
		await invoker.cancelled.p;
		assert.strictEqual((await reset.trailers).status, GrpcStatus.CANCELLED);

		const second = store.add(new TestInvoker());
		const secondRoute = store.add(new McpGatewayRoute('route-deadline', logger, second, sealedState));
		routeRegistration.dispose();
		store.add(listener.addRoute(secondRoute.routeId, secondRoute.dispatcher, second));
		const { trailers } = await runTunnel(channel(), tunnelRequest('tools/call', { name: 'block', arguments: {} }), { deadlineMs: 100 });
		assert.strictEqual(trailers.status, GrpcStatus.DEADLINE_EXCEEDED);
		await second.cancelled.p;
	});

	test('several routes: a call names its route, else NOT_FOUND before the dispatcher sees it', async () => {
		const other = addSecondRoute();
		const ch = channel();
		const missing = await runTunnel(ch, tunnelRequest('server/discover'));
		assert.strictEqual(missing.trailers.status, GrpcStatus.NOT_FOUND);
		assert.match(missing.trailers.message ?? '', new RegExp(GRPC_ROUTE_METADATA_KEY));

		// An unknown route is refused before the message is even decoded.
		const unknown = ch.call(TUNNEL_CALL_PATH, { [GRPC_ROUTE_METADATA_KEY]: 'no-such-route' }, new Uint8Array([0xff]));
		assert.strictEqual((await unknown.trailers).status, GrpcStatus.NOT_FOUND);

		const typedMissing = await runTyped(ch, 'ListTools', {});
		assert.strictEqual(typedMissing.trailers.status, GrpcStatus.NOT_FOUND);

		const second = await runTunnel(ch, tunnelRequest('server/discover', {}, { metadata: { [GRPC_ROUTE_METADATA_KEY]: other.routeId } }));
		assert.strictEqual(second.trailers.status, GrpcStatus.OK);
		assert.deepStrictEqual(((second.messages[0].result as Json)._meta as Json)[META_SERVER_INFO], { name: 'second-server', version: '2.0.0' });
	});

	test('a foreign :authority is PERMISSION_DENIED', async () => {
		const ch = channel({
			authority: `evil.example:${port}`,
			createConnection: () => new Promise<net.Socket>((resolve, reject) => {
				const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
				socket.once('error', reject);
			}),
		});
		const { trailers } = await runTunnel(ch, tunnelRequest('server/discover'));
		assert.strictEqual(trailers.status, GrpcStatus.PERMISSION_DENIED);
		assert.ok(isLoopbackAuthority(`127.0.0.1:${port}`));
		assert.ok(isLoopbackAuthority('[::1]:1'));
		assert.ok(isLoopbackAuthority('localhost:1'));
		assert.ok(!isLoopbackAuthority(undefined));
		assert.ok(!isLoopbackAuthority('192.168.1.1:1'));
	});

	test('a request message over 4 MiB is RESOURCE_EXHAUSTED', async () => {
		const ch = channel({ maxSendMessageBytes: 8 * 1024 * 1024 });
		const call = ch.call(TUNNEL_CALL_PATH, {}, new Uint8Array(4 * 1024 * 1024 + 1));
		assert.strictEqual((await call.trailers).status, GrpcStatus.RESOURCE_EXHAUSTED);
	});

	test('input rounds: the sealed requestState continues on its own route only', async () => {
		const other = addSecondRoute();
		const ch = channel();
		const caps: MCP.ClientCapabilities = { elicitation: {} };
		const route = { [GRPC_ROUTE_METADATA_KEY]: 'route-a' };
		const first = await runTunnel(ch, tunnelRequest('tools/call', { name: 'test_input_required_result_request_state', arguments: {} }, { capabilities: caps, metadata: route }));
		const asked = first.messages[0].result as Json;
		assert.strictEqual(asked.resultType, 'input_required');
		assert.strictEqual(typeof asked.requestState, 'string');

		const answer = { name: 'test_input_required_result_request_state', arguments: {}, inputResponses: { confirm: { action: 'accept', content: { ok: true } } }, requestState: asked.requestState };
		const done = await runTunnel(ch, tunnelRequest('tools/call', answer, { capabilities: caps, metadata: route }));
		assert.strictEqual(firstText(done.messages[0].result as Json), 'state-ok request-state-nonce');

		const elsewhere = await runTunnel(ch, tunnelRequest('tools/call', answer, { capabilities: caps, metadata: { [GRPC_ROUTE_METADATA_KEY]: other.routeId } }));
		assert.strictEqual((elsewhere.messages[0].error as Json).code, MCP.INVALID_PARAMS);
	});

	// ---- typed ----------------------------------------------------------------------

	test('the typed service serves all eight RPCs with routing metadata', async () => {
		const ch = channel();
		const meta = { _meta: modernMeta() };

		const tools = await runTyped(ch, 'ListTools', meta);
		assert.strictEqual(tools.trailers.status, GrpcStatus.OK);
		const listed = tools.result?.tools as { name: string; execution?: unknown }[];
		assert.ok(listed.some(t => t.name === 'add'));
		// The typed binding has no task methods: task tools are listed as plain tools.
		const taskTool = listed.find(t => t.name === 'task_tool');
		assert.ok(taskTool);
		assert.strictEqual(taskTool.execution, undefined);

		const sum = await runTyped(ch, 'CallTool', { ...meta, name: 'add', arguments: { a: 40, b: 2 } });
		assert.strictEqual(sum.trailers.status, GrpcStatus.OK);
		assert.strictEqual(firstText(sum.result), '42');

		const prompts = await runTyped(ch, 'ListPrompts', meta);
		assert.ok((prompts.result?.prompts as { name: string }[]).some(p => p.name === 'test_prompt_with_arguments'));
		const prompt = await runTyped(ch, 'GetPrompt', { ...meta, name: 'test_prompt_with_arguments', arguments: { arg1: 'x', arg2: 'y' } });
		assert.strictEqual(prompt.trailers.status, GrpcStatus.OK);
		assert.match(JSON.stringify(prompt.result?.messages), /arg1='x', arg2='y'/);

		const resources = await runTyped(ch, 'ListResources', meta);
		assert.ok((resources.result?.resources as { uri: string }[]).some(r => r.uri === 'test://static-text'));
		const read = await runTyped(ch, 'ReadResource', { ...meta, uri: 'test://static-text' });
		assert.strictEqual(read.trailers.status, GrpcStatus.OK);
		assert.strictEqual((read.result?.contents as { text: string }[])[0].text, 'This is the content of the static text resource.');
		const templates = await runTyped(ch, 'ListResourceTemplates', meta);
		assert.strictEqual((templates.result?.resourceTemplates as { uriTemplate: string }[])[0].uriTemplate, 'test://template/{id}/data');

		const completion = await runTyped(ch, 'Complete', { ...meta, ref: { type: 'ref/prompt', name: 'test_prompt_with_arguments' }, argument: { name: 'arg1', value: 'pa' } });
		assert.strictEqual(completion.trailers.status, GrpcStatus.OK);
		assert.deepStrictEqual((completion.result?.completion as Json).values, ['paris', 'park', 'party']);
	});

	test('a typed client without _meta, routing or mirrored metadata gets the defaults', async () => {
		const ch = channel();
		const rpc = rpcNamed('CallTool');
		const call = ch.call(rpc.path, {}, encodeTypedRequest(rpc, { name: 'test_simple_text' }));
		const [payload] = await (async () => { const all: Uint8Array[] = []; for await (const p of call.messages) { all.push(p); } return all; })();
		assert.strictEqual((await call.trailers).status, GrpcStatus.OK);
		assert.strictEqual(firstText(decodeTypedResponse(rpc, payload)), 'This is a simple text response for testing.');
	});

	test('typed metadata that disagrees with the message is -32020, an unsupported version -32022', async () => {
		const ch = channel();
		const routing = await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 1, b: 1 } }, { mcp_tool: 'other' });
		assert.strictEqual(routing.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(routing.trailers.raw[MCP_ERROR_CODE_TRAILER], String(MCP.HEADER_MISMATCH));
		assert.strictEqual(errorBin(routing.trailers).error.code, MCP.HEADER_MISMATCH);

		const mirrored = await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 1, b: 1 } }, { 'mcp-method': 'tools/list' });
		assert.strictEqual(errorBin(mirrored.trailers).error.code, MCP.HEADER_MISMATCH);

		const version = await runTyped(ch, 'ListTools', { _meta: modernMeta() }, { [MCP_PROTOCOL_VERSION_METADATA]: '2025-11-25' });
		assert.strictEqual(errorBin(version.trailers).error.code, MCP.HEADER_MISMATCH, 'the header disagrees with _meta');

		const legacy = await runTyped(ch, 'ListTools', {}, { [MCP_PROTOCOL_VERSION_METADATA]: '2025-11-25' });
		assert.strictEqual(legacy.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		const response = errorBin(legacy.trailers);
		assert.strictEqual(response.error.code, MCP.UNSUPPORTED_PROTOCOL_VERSION);
		assert.deepStrictEqual(response.error.data?.supported, [LATEST_MCP_PROTOCOL_VERSION]);
	});

	test('a JSON-RPC error of a typed request ends the call with headers only', async () => {
		const ch = channel();
		const unknown = await runTyped(ch, 'CallTool', { name: 'no_such_tool' });
		assert.strictEqual(unknown.result, undefined);
		assert.strictEqual(unknown.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(errorBin(unknown.trailers).error.code, MCP.INVALID_PARAMS);

		const capability = await runTyped(ch, 'CallTool', { name: 'test_input_required_result_elicitation' });
		assert.strictEqual(errorBin(capability.trailers).error.code, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY);

		// A long message: grpc-message is cut to 1024 bytes and mcp-error-bin left out above 4096 bytes.
		const long = await runTyped(ch, 'CallTool', { name: 'x'.repeat(5000) }, {}, false);
		assert.strictEqual(long.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(long.trailers.raw[MCP_ERROR_CODE_TRAILER], String(MCP.INVALID_PARAMS));
		assert.strictEqual(long.trailers.raw[MCP_ERROR_BIN_TRAILER], undefined);
		assert.ok((long.trailers.message ?? '').length <= 1024);
	});

	test('typed input rounds carry the sealed requestState', async () => {
		const ch = channel();
		const meta = { _meta: modernMeta({ elicitation: {} }) };
		const first = await runTyped(ch, 'CallTool', { ...meta, name: 'test_input_required_result_request_state' });
		assert.strictEqual(first.trailers.status, GrpcStatus.OK);
		assert.strictEqual(first.result?.resultType, 'input_required');
		const requestState = first.result?.requestState;
		assert.strictEqual(typeof requestState, 'string');
		const done = await runTyped(ch, 'CallTool', { ...meta, name: 'test_input_required_result_request_state', inputResponses: { confirm: { action: 'accept', content: { ok: true } } }, requestState });
		assert.strictEqual(done.trailers.status, GrpcStatus.OK);
		assert.strictEqual(firstText(done.result), 'state-ok request-state-nonce');
	});

	test('destructiveHint: false, which the typed binding cannot carry, is logged once', async () => {
		const ch = channel();
		for (let i = 0; i < 2; i++) {
			assert.strictEqual((await runTyped(ch, 'ListTools', {})).trailers.status, GrpcStatus.OK);
		}
		assert.strictEqual(logger.warnings.filter(w => w.includes('destructiveHint')).length, 1);
		assert.match(logger.warnings.find(w => w.includes('destructiveHint')) ?? '', /safe_tool/);
	});

	test('subscriptions/listen is a tunnel call only', async () => {
		assert.ok(!TYPED_RPCS.some(rpc => rpc.jsonRpcMethod === 'subscriptions/listen'));
		const call = channel().call('/model_context_protocol.Mcp/Listen', {}, new Uint8Array(0));
		assert.strictEqual((await call.trailers).status, GrpcStatus.UNIMPLEMENTED);
	});
});

suite('MCP - Gateway service gRPC option', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function toolInvoker(): IMcpGatewayToolInvoker {
		return {
			onDidChangeServers: Event.None,
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			listServers: () => [{ id: 'one', label: 'Server One' }, { id: 'two', label: 'Server Two' }],
			listToolsForServer: async serverId => [{ name: `tool_${serverId}`, inputSchema: { type: 'object', properties: {} } }],
			callToolForServer: async (serverId, name) => ({ content: [{ type: 'text', text: `${serverId}:${name}` }] }),
			listResourcesForServer: async () => [],
			readResourceForServer: async uri => { throw new Error(`no ${uri}`); },
			listResourceTemplatesForServer: async () => [],
		};
	}

	test('every route is served over gRPC and advertises its grpcAddress', async () => {
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService()), { grpc: true }));
		const gateway = await service.createGateway('client', toolInvoker());
		const grpcPort = service.grpcPort;
		assert.ok(grpcPort !== undefined && grpcPort !== service.port);
		assert.strictEqual(gateway.servers.length, 2);
		const ch = store.add(new GrpcChannel({ authority: `127.0.0.1:${grpcPort}`, secure: false }));
		for (const server of gateway.servers) {
			const grpcAddress = server.grpcAddress;
			assert.ok(grpcAddress);
			assert.strictEqual(grpcAddress.scheme, 'grpc');
			assert.strictEqual(grpcAddress.authority, `127.0.0.1:${grpcPort}`);
			const routeId = grpcAddress.path.substring(1);
			assert.ok(server.address.path.endsWith(`/${routeId}`), 'the gRPC route is the HTTP route');
			const serverId = server.label === 'Server One' ? 'one' : 'two';
			const { result, trailers } = await runTyped(ch, 'CallTool', { name: `tool_${serverId}` }, { [GRPC_ROUTE_METADATA_KEY]: routeId });
			assert.strictEqual(trailers.status, GrpcStatus.OK);
			assert.strictEqual(firstText(result), `${serverId}:tool_${serverId}`);
		}
		await service.disposeGateway(gateway.gatewayId);
		assert.strictEqual(service.grpcPort, undefined);
	});

	test('createRoute returns the gRPC address; without the option there is none', async () => {
		const withGrpc = store.add(new McpGatewayService(store.add(new NullLoggerService()), { grpc: true }));
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const handle = store.add(await withGrpc.createRoute('conformance', invoker, { serverInfo: CONFORMANCE_SERVER_INFO }));
		assert.strictEqual(handle.grpcAddress?.toString(true), `grpc://127.0.0.1:${withGrpc.grpcPort}/${handle.routeId}`);
		const ch = store.add(new GrpcChannel({ authority: `127.0.0.1:${withGrpc.grpcPort}`, secure: false }));
		const { messages, trailers } = await runTunnel(ch, tunnelRequest('server/discover'));
		assert.strictEqual(trailers.status, GrpcStatus.OK, 'the only route is the default');
		assert.deepStrictEqual(((messages[0].result as Json)._meta as Json)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);

		const plain = store.add(new McpGatewayService(store.add(new NullLoggerService())));
		const plainHandle = store.add(await plain.createRoute('plain', invoker));
		assert.strictEqual(plainHandle.grpcAddress, undefined);
		assert.strictEqual(plain.grpcPort, undefined);
	});
});
