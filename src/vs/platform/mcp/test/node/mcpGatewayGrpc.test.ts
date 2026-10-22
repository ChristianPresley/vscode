/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http2 from 'http2';
import * as net from 'net';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { encodeLengthPrefixedMessage } from '../../../../base/common/grpc/lpm.js';
import { GrpcStatus, decodeBinaryMetadata, decodeGrpcMessage } from '../../../../base/common/grpc/status.js';
import { decodeMessage, encodeMessage } from '../../../../base/common/protobuf/codec.js';
import { decodeUtf8, encodeUtf8 } from '../../../../base/common/protobuf/wire.js';
import { GrpcChannel, IGrpcCallOptions, IGrpcChannelOptions, IGrpcTrailers } from '../../../../base/node/grpcChannel.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILoggerService, NullLogger, NullLoggerService } from '../../../log/common/log.js';
import { IMcpGatewayInputRequired, IMcpGatewayInvokeContext, IMcpGatewayServerDescriptor, IMcpGatewayServerInfo, IMcpGatewayService, IMcpGatewayToolInvoker } from '../../common/mcpGateway.js';
import { JSON_RPC_MESSAGE, MCP_ERROR_BIN_TRAILER, MCP_ERROR_CODE_TRAILER, MCP_PROTOCOL_VERSION_METADATA, TUNNEL_CALL_PATH, TYPED_RPCS, TypedRpcName } from '../../common/mcpGrpcProto.js';
import { decodeTypedResponse, encodeTypedRequest, routingMetadataFor } from '../../common/mcpGrpcTyped.js';
import { buildMirroredHeaders, MCP_PROTOCOL_VERSION_HEADER } from '../../common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_CLIENT_INFO, META_SERVER_INFO, META_SUBSCRIPTION_ID } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { CONFORMANCE_HIDDEN_TOOL, CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { GRPC_ROUTE_METADATA_KEY, IMcpGatewayGrpcListenerOptions, isLoopbackAuthority, McpGatewayGrpcListener } from '../../node/mcpGatewayGrpc.js';
import { McpGatewayRoute } from '../../node/mcpGatewayRoute.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';
import { McpGatewayService, mcpGatewayServiceDescriptor } from '../../node/mcpGatewayService.js';
import { httpRequest, jsonOf, modernMeta, modernRequest } from './mcpGatewayTestUtils.js';

type Json = Record<string, unknown>;

/** Records every line it is given (with its arguments), and the warnings apart (the destructiveHint note is one). */
class RecordingLogger extends NullLogger {
	readonly lines: string[] = [];
	readonly debugLines: string[] = [];
	readonly warnings: string[] = [];
	override trace(message: string, ...args: unknown[]): void {
		this._record(message, args);
	}
	override debug(message: string, ...args: unknown[]): void {
		this.debugLines.push(message);
		this._record(message, args);
	}
	override info(message: string, ...args: unknown[]): void {
		this._record(message, args);
	}
	override warn(message: string, ...args: unknown[]): void {
		this.warnings.push(message);
		this._record(message, args);
	}
	override error(message: string | Error, ...args: unknown[]): void {
		this._record(message, args);
	}
	private _record(message: string | Error, args: unknown[]): void {
		this.lines.push([message, ...args].map(logText).join(' '));
	}
}

function logText(part: unknown): string {
	if (part instanceof Error) {
		return `${part.message}\n${part.stack}`;
	}
	if (typeof part === 'string') {
		return part;
	}
	try {
		return JSON.stringify(part) ?? String(part);
	} catch {
		return String(part);
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

/** The route of the listener suite; every call names it unless a test says otherwise. */
const ROUTE_A = 'route-a';
const ROUTE_A_METADATA: Readonly<Record<string, string>> = { [GRPC_ROUTE_METADATA_KEY]: ROUTE_A };

/** A well-formed 2026-07-28 tunnel call: `_meta` in the params, the mirrored metadata and the route (route-a unless `metadata` names another). */
function tunnelRequest(method: string, params: Json = {}, options: { id?: number | string; capabilities?: MCP.ClientCapabilities; metadata?: Record<string, string> } = {}): ITunnelRequest {
	const fullParams = { ...params, _meta: { ...modernMeta(options.capabilities ?? {}), ...(params._meta as Json | undefined) } };
	return {
		body: { jsonrpc: '2.0', id: options.id ?? 1, method, params: fullParams },
		metadata: lowercase({ ...ROUTE_A_METADATA, [MCP_PROTOCOL_VERSION_HEADER]: LATEST_MCP_PROTOCOL_VERSION, ...buildMirroredHeaders(method, fullParams), ...options.metadata }),
	};
}

/** The request without the route metadata. */
function withoutRoute<T extends { readonly metadata: Record<string, string> }>(request: T): T {
	const { [GRPC_ROUTE_METADATA_KEY]: _route, ...metadata } = request.metadata;
	return { ...request, metadata };
}

interface IRawGrpcOutcome {
	readonly headers: http2.IncomingHttpHeaders;
	readonly trailers: http2.IncomingHttpHeaders | undefined;
	readonly body: Buffer;
}

/** A raw HTTP/2 gRPC call, to see whether a status came trailers-only. */
function rawGrpcCall(port: number, path: string, metadata: Record<string, string>, payload: Uint8Array): Promise<IRawGrpcOutcome> {
	return new Promise((resolve, reject) => {
		const session = http2.connect(`http://127.0.0.1:${port}`);
		session.on('error', reject);
		const stream = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/grpc', 'te': 'trailers', ...metadata });
		let headers: http2.IncomingHttpHeaders = {};
		let trailers: http2.IncomingHttpHeaders | undefined;
		const chunks: Buffer[] = [];
		stream.on('response', h => { headers = h; });
		stream.on('trailers', t => { trailers = t; });
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', () => { /* the outcome is in the headers */ });
		stream.on('close', () => {
			session.close();
			resolve({ headers, trailers, body: Buffer.concat(chunks) });
		});
		const framed = encodeLengthPrefixedMessage(payload);
		stream.end(Buffer.from(framed.buffer, framed.byteOffset, framed.byteLength));
	});
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

/**
 * A typed call on `gatewayRoute` (route-a by default, none when null)
 * unless `metadata` names another route; `routing` adds the RPC's routing
 * metadata (`mcp_tool`, ...).
 */
async function runTyped(channel: GrpcChannel, name: TypedRpcName, params: Json, metadata: Record<string, string> = {}, routing = true, gatewayRoute: string | null = ROUTE_A): Promise<ITypedOutcome> {
	const rpc = rpcNamed(name);
	const routeMetadata: Record<string, string> = gatewayRoute === null ? {} : { [GRPC_ROUTE_METADATA_KEY]: gatewayRoute };
	const call = channel.call(rpc.path, { ...routeMetadata, [MCP_PROTOCOL_VERSION_METADATA]: LATEST_MCP_PROTOCOL_VERSION, ...(routing ? routingMetadataFor(rpc, params) : {}), ...metadata }, encodeTypedRequest(rpc, params));
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

	test('the tunnel serves server/discover on the route the call names', async () => {
		const { messages, trailers } = await runTunnel(channel(), tunnelRequest('server/discover', {}, { metadata: { [GRPC_ROUTE_METADATA_KEY]: route.routeId } }));
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.strictEqual(messages.length, 1);
		const result = messages[0].result as Json;
		assert.deepStrictEqual(result.supportedVersions, [LATEST_MCP_PROTOCOL_VERSION]);
		assert.deepStrictEqual((result._meta as Json)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
	});

	test('by default a call must name its route, even when the listener serves one: missing or unknown is NOT_FOUND, trailers only, before the message is read', async () => {
		assert.strictEqual(listener.routeCount, 1);
		const ch = channel();
		const missing = await runTunnel(ch, withoutRoute(tunnelRequest('server/discover')));
		assert.deepStrictEqual([missing.trailers.status, missing.messages], [GrpcStatus.NOT_FOUND, []]);
		assert.match(missing.trailers.message ?? '', new RegExp(GRPC_ROUTE_METADATA_KEY));
		const typedMissing = await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 1, b: 2 } }, {}, true, null);
		assert.deepStrictEqual([typedMissing.trailers.status, typedMissing.result], [GrpcStatus.NOT_FOUND, undefined]);
		const blank = await runTyped(ch, 'ListTools', {}, {}, true, ' ');
		assert.strictEqual(blank.trailers.status, GrpcStatus.NOT_FOUND, 'a blank route is no route');

		// Not even decoded: a payload that is no message at all is NOT_FOUND too, never INVALID_ARGUMENT.
		const variants: Record<string, string>[] = [{}, { [GRPC_ROUTE_METADATA_KEY]: 'no-such-route' }];
		for (const metadata of variants) {
			const raw = await rawGrpcCall(port, TUNNEL_CALL_PATH, metadata, new Uint8Array([0xff]));
			assert.strictEqual(raw.headers['grpc-status'], String(GrpcStatus.NOT_FOUND), JSON.stringify(metadata));
			assert.strictEqual(raw.trailers, undefined, 'trailers only');
			assert.strictEqual(raw.body.byteLength, 0);
			const typedRpc = rpcNamed('ListTools');
			const typedRaw = await rawGrpcCall(port, typedRpc.path, metadata, new Uint8Array([0xff]));
			assert.strictEqual(typedRaw.headers['grpc-status'], String(GrpcStatus.NOT_FOUND));
			assert.strictEqual(typedRaw.trailers, undefined);
		}
		const unknown = await rawGrpcCall(port, TUNNEL_CALL_PATH, { [GRPC_ROUTE_METADATA_KEY]: 'no-such-route' }, tunnelPayload(tunnelRequest('server/discover').body));
		assert.match(decodeGrpcMessage(String(unknown.headers['grpc-message'])), /Unknown gateway route/);
	});

	test('allowDefaultRoute (test fixtures only): a call without the route metadata reaches the only route; two routes or an unknown route are NOT_FOUND', async () => {
		const fixture = store.add(new McpGatewayGrpcListener(logger, { allowDefaultRoute: true, server: { shutdownGraceMs: 100 } }));
		fixture.registerTunnelService();
		fixture.registerTypedService();
		const only = store.add(fixture.addRoute(route.routeId, route.dispatcher, invoker));
		const fixturePort = await fixture.listen();
		try {
			const ch = store.add(new GrpcChannel({ authority: `127.0.0.1:${fixturePort}`, secure: false }));
			const discovered = await runTunnel(ch, withoutRoute(tunnelRequest('server/discover')));
			assert.strictEqual(discovered.trailers.status, GrpcStatus.OK);
			assert.deepStrictEqual(((discovered.messages[0].result as Json)._meta as Json)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
			const typed = await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 40, b: 2 } }, {}, true, null);
			assert.strictEqual(firstText(typed.result), '42');
			assert.strictEqual((await runTunnel(ch, tunnelRequest('server/discover', {}, { metadata: { [GRPC_ROUTE_METADATA_KEY]: 'no-such-route' } }))).trailers.status, GrpcStatus.NOT_FOUND);

			const other = store.add(new McpGatewayRoute('route-b', logger, invoker, sealedState, 'second'));
			const second = store.add(fixture.addRoute(other.routeId, other.dispatcher, invoker));
			const ambiguous = await runTunnel(ch, withoutRoute(tunnelRequest('server/discover')));
			assert.strictEqual(ambiguous.trailers.status, GrpcStatus.NOT_FOUND, 'no default with two routes');
			second.dispose();
			only.dispose();
			assert.strictEqual((await runTunnel(ch, withoutRoute(tunnelRequest('server/discover')))).trailers.status, GrpcStatus.NOT_FOUND, 'no default without routes');
		} finally {
			await fixture.close();
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

		const initialize = await runTunnel(channel(), { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } } }, metadata: { ...ROUTE_A_METADATA } });
		assert.strictEqual(initialize.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(errorBin(initialize.trailers).error.code, MCP.UNSUPPORTED_PROTOCOL_VERSION);

		// The version metadata is judged before the missing _meta and the other mirrored metadata.
		for (const version of ['2099-01-01', '2025-11-25']) {
			const noMeta = await runTunnel(channel(), { body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, metadata: { ...ROUTE_A_METADATA, 'mcp-protocol-version': version } });
			assert.strictEqual(noMeta.trailers.status, GrpcStatus.INVALID_ARGUMENT, version);
			const error = errorBin(noMeta.trailers).error;
			assert.deepStrictEqual([error.code, error.data?.supported, error.data?.requested], [MCP.UNSUPPORTED_PROTOCOL_VERSION, [LATEST_MCP_PROTOCOL_VERSION], version]);
		}
	});

	test('malformed and unexpected tunnel messages', async () => {
		const ch = channel();
		const unknown = await runTunnel(ch, tunnelRequest('nothing/here'));
		assert.strictEqual(unknown.trailers.status, GrpcStatus.UNIMPLEMENTED);
		assert.strictEqual(errorBin(unknown.trailers).error.code, MCP.METHOD_NOT_FOUND);

		const notification = await runTunnel(ch, { body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, metadata: { ...ROUTE_A_METADATA } });
		assert.strictEqual(notification.trailers.status, GrpcStatus.OK);
		assert.deepStrictEqual(notification.messages, []);

		const parse = await runTunnel(ch, { body: '{"jsonrpc":', metadata: { ...ROUTE_A_METADATA } });
		assert.strictEqual(parse.trailers.status, GrpcStatus.INVALID_ARGUMENT);
		assert.strictEqual(errorBin(parse.trailers).error.code, MCP.PARSE_ERROR);
		assert.strictEqual(errorBin(parse.trailers).id, null);

		const batch = await runTunnel(ch, { body: [tunnelRequest('tools/list').body], metadata: { ...ROUTE_A_METADATA } });
		assert.strictEqual(errorBin(batch.trailers).error.code, MCP.INVALID_REQUEST);
		const response = await runTunnel(ch, { body: { jsonrpc: '2.0', id: 1, result: {} }, metadata: { ...ROUTE_A_METADATA } });
		assert.strictEqual(errorBin(response.trailers).error.code, MCP.INVALID_REQUEST);

		const notAMessage = ch.call(TUNNEL_CALL_PATH, ROUTE_A_METADATA, new Uint8Array([0xff, 0xff, 0xff]));
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

		// The route is gone: NOT_FOUND.
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
		const { trailers } = await runTunnel(channel(), tunnelRequest('tools/call', { name: 'block', arguments: {} }, { metadata: { [GRPC_ROUTE_METADATA_KEY]: secondRoute.routeId } }), { deadlineMs: 100 });
		assert.strictEqual(trailers.status, GrpcStatus.DEADLINE_EXCEEDED);
		await second.cancelled.p;
	});

	test('several routes: a call names its route, else NOT_FOUND before the dispatcher sees it', async () => {
		const other = addSecondRoute();
		const ch = channel();
		const missing = await runTunnel(ch, withoutRoute(tunnelRequest('server/discover')));
		assert.strictEqual(missing.trailers.status, GrpcStatus.NOT_FOUND);
		assert.match(missing.trailers.message ?? '', new RegExp(GRPC_ROUTE_METADATA_KEY));

		// An unknown route is refused before the message is even decoded.
		const unknown = ch.call(TUNNEL_CALL_PATH, { [GRPC_ROUTE_METADATA_KEY]: 'no-such-route' }, new Uint8Array([0xff]));
		assert.strictEqual((await unknown.trailers).status, GrpcStatus.NOT_FOUND);

		const typedMissing = await runTyped(ch, 'ListTools', {}, {}, true, null);
		assert.strictEqual(typedMissing.trailers.status, GrpcStatus.NOT_FOUND);

		const first = await runTunnel(ch, tunnelRequest('server/discover'));
		assert.deepStrictEqual(((first.messages[0].result as Json)._meta as Json)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);

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
		const call = ch.call(TUNNEL_CALL_PATH, ROUTE_A_METADATA, new Uint8Array(4 * 1024 * 1024 + 1));
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

	test('a typed client without _meta, the RPC\'s routing metadata or mirrored headers gets the defaults (it only names the gateway route)', async () => {
		const ch = channel();
		const rpc = rpcNamed('CallTool');
		const call = ch.call(rpc.path, ROUTE_A_METADATA, encodeTypedRequest(rpc, { name: 'test_simple_text' }));
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

	test('a request over the route\'s rate limit ends with RESOURCE_EXHAUSTED on both bindings, -32603 rate_limited in mcp-error-bin', async () => {
		const limited = store.add(new McpGatewayRoute('route-limited', logger, invoker, sealedState, 'limited', { serverInfo: CONFORMANCE_SERVER_INFO, rateLimits: { toolCalls: { perSecond: 0.001, burst: 1 }, completions: false } }));
		store.add(listener.addRoute(limited.routeId, limited.dispatcher, invoker));
		const metadata = { [GRPC_ROUTE_METADATA_KEY]: limited.routeId };
		const ch = channel();
		const assertRateLimited = (trailers: IGrpcTrailers, id: unknown) => {
			assert.strictEqual(trailers.status, GrpcStatus.RESOURCE_EXHAUSTED);
			assert.strictEqual(trailers.raw[MCP_ERROR_CODE_TRAILER], String(MCP.INTERNAL_ERROR));
			const response = errorBin(trailers);
			assert.strictEqual(response.id, id);
			assert.strictEqual(response.error.data?.reason, 'rate_limited');
			assert.ok(typeof response.error.data?.retryAfterMs === 'number');
		};

		// Tunnel: the first call runs, the second is refused before it runs (no messages, trailers only).
		const first = await runTunnel(ch, tunnelRequest('tools/call', { name: 'add', arguments: { a: 1, b: 2 } }, { id: 1, metadata }));
		assert.strictEqual(first.trailers.status, GrpcStatus.OK);
		assert.strictEqual(firstText(first.messages[first.messages.length - 1].result as Json), '3');
		const refused = await runTunnel(ch, tunnelRequest('tools/call', { name: 'add', arguments: { a: 1, b: 2 } }, { id: 2, metadata }));
		assert.deepStrictEqual(refused.messages, []);
		assertRateLimited(refused.trailers, 2);
		// Another client (its own client info) is not limited by the first; other methods are not limited.
		const otherClient = await runTunnel(ch, tunnelRequest('tools/call', { name: 'add', arguments: { a: 1, b: 2 }, _meta: { [META_CLIENT_INFO]: { name: 'other', version: '1' } } }, { id: 3, metadata }));
		assert.strictEqual(otherClient.trailers.status, GrpcStatus.OK);
		assert.strictEqual((await runTunnel(ch, tunnelRequest('tools/list', {}, { id: 4, metadata }))).trailers.status, GrpcStatus.OK);

		// Typed: the same, with the error in the trailers only.
		assert.strictEqual(firstText((await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 2, b: 2 } }, {}, true, limited.routeId)).result), '4');
		const typed = await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 2, b: 2 } }, {}, true, limited.routeId);
		assert.strictEqual(typed.result, undefined);
		assertRateLimited(typed.trailers, null);
		// The default route keeps its own (default) limits.
		assert.strictEqual((await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 2, b: 2 } })).trailers.status, GrpcStatus.OK);
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

	// ---- request log ----------------------------------------------------------------

	test('each request is logged at debug with its route, binding and method, then its status; never a metadata value or an argument', async () => {
		const token = 'Bearer grpc-log-test-token';
		const argument = 'grpc-log-test-argument';
		const prefix = `[McpGateway][gRPC][route ${ROUTE_A}]`;
		const ch = channel();

		const tunnel = await runTunnel(ch, tunnelRequest('tools/call', { name: 'add', arguments: { a: 40, b: 2, note: argument } }, { id: 7, metadata: { authorization: token } }));
		assert.strictEqual(firstText(tunnel.messages[tunnel.messages.length - 1].result as Json), '42');
		const typed = await runTyped(ch, 'CallTool', { name: 'add', arguments: { a: 2, b: 2, note: argument } }, { authorization: token });
		assert.strictEqual(firstText(typed.result), '4');
		assert.ok(logger.debugLines.includes(`${prefix} <-- tunnel tools/call (id=7)`), logger.debugLines.join('\n'));
		assert.ok(logger.debugLines.includes(`${prefix} --> tunnel tools/call (id=7): OK`), logger.debugLines.join('\n'));
		assert.ok(logger.debugLines.includes(`${prefix} <-- typed CallTool`), logger.debugLines.join('\n'));
		assert.ok(logger.debugLines.includes(`${prefix} --> typed CallTool: OK`), logger.debugLines.join('\n'));

		// Errors: a tunnel error response still ends with status 0; a typed one ends with its status. Both name the JSON-RPC code.
		await runTunnel(ch, tunnelRequest('tools/call', { name: 'no_such_tool', arguments: {} }, { id: 8, metadata: { authorization: token } }));
		assert.ok(logger.debugLines.includes(`${prefix} --> tunnel tools/call (id=8): OK, JSON-RPC error ${MCP.INVALID_PARAMS}`), logger.debugLines.join('\n'));
		await runTyped(ch, 'ListTools', {}, { authorization: token, [MCP_PROTOCOL_VERSION_METADATA]: '2025-11-25' });
		assert.ok(logger.debugLines.includes(`${prefix} --> typed ListTools: INVALID_ARGUMENT, JSON-RPC error ${MCP.UNSUPPORTED_PROTOCOL_VERSION}`), logger.debugLines.join('\n'));

		// A listen stream the client resets ends as cancelled.
		const uri = 'test://watched-resource';
		const listen = tunnelRequest('subscriptions/listen', { notifications: { resourceSubscriptions: [uri] } }, { id: 'listen-9', metadata: { authorization: token } });
		const call = ch.call(TUNNEL_CALL_PATH, listen.metadata, tunnelPayload(listen.body));
		const ack = decodeTunnel((await call.messages[Symbol.asyncIterator]().next()).value);
		assert.strictEqual(ack.method, 'notifications/subscriptions/acknowledged');
		call.cancel();
		await call.trailers;
		await invoker.unsubscribed.p;
		assert.ok(logger.debugLines.includes(`${prefix} <-- tunnel subscriptions/listen (id=listen-9)`), logger.debugLines.join('\n'));
		assert.ok(logger.debugLines.includes(`${prefix} --> tunnel subscriptions/listen (id=listen-9): cancelled`), logger.debugLines.join('\n'));

		const leaked = logger.lines.filter(line => line.includes('grpc-log-test'));
		assert.deepStrictEqual(leaked, [], 'no log line carries the authorization metadata or a tool argument');
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

	/** A tool invoker whose servers change when the test fires `servers`. */
	function changingInvoker(initial: readonly IMcpGatewayServerDescriptor[]): { invoker: IMcpGatewayToolInvoker; servers: Emitter<readonly IMcpGatewayServerDescriptor[]> } {
		const servers = store.add(new Emitter<readonly IMcpGatewayServerDescriptor[]>());
		return { invoker: { ...toolInvoker(), listServers: () => initial, onDidChangeServers: servers.event }, servers };
	}

	function channelTo(authority: string): GrpcChannel {
		return store.add(new GrpcChannel({ authority, secure: false }));
	}

	/** The route id of a gateway server's HTTP address (`/gateway/<routeId>`). */
	function httpRouteOf(server: IMcpGatewayServerInfo): string {
		return server.address.path.substring(server.address.path.lastIndexOf('/') + 1);
	}

	/** Whether nothing accepts connections on `127.0.0.1:<port>` any more. */
	function isPortClosed(port: number): Promise<boolean> {
		return new Promise(resolve => {
			const socket = net.connect(port, '127.0.0.1');
			socket.once('connect', () => {
				socket.destroy();
				resolve(false);
			});
			socket.once('error', () => resolve(true));
		});
	}

	/**
	 * Records the service's gRPC listeners. With `gated` set, each bind waits
	 * until the test completes its release; `failBinds` makes that many of
	 * the next binds fail.
	 */
	class TestGrpcService extends McpGatewayService {
		readonly listeners: McpGatewayGrpcListener[] = [];
		readonly releases: DeferredPromise<void>[] = [];
		readonly disposals: DeferredPromise<void>[] = [];
		gated = false;
		failBinds = 0;
		private readonly _onDidCreateListener = store.add(new Emitter<void>());
		protected override _createGrpcListener(options: IMcpGatewayGrpcListenerOptions): McpGatewayGrpcListener {
			const listener = super._createGrpcListener(options);
			const release = new DeferredPromise<void>();
			if (!this.gated) {
				release.complete();
			}
			const fails = this.failBinds > 0;
			if (fails) {
				this.failBinds--;
			}
			const disposal = new DeferredPromise<void>();
			const listen = listener.listen.bind(listener);
			listener.listen = async (listenPort?: number, host?: string) => {
				if (fails) {
					await release.p;
					throw new Error('the test refuses to bind the gRPC port');
				}
				const bound = await listen(listenPort, host);
				await release.p;
				return bound;
			};
			const dispose = listener.dispose.bind(listener);
			listener.dispose = () => {
				dispose();
				disposal.complete();
			};
			this.listeners.push(listener);
			this.releases.push(release);
			this.disposals.push(disposal);
			this._onDidCreateListener.fire();
			return listener;
		}
		async listenerCreated(count: number): Promise<void> {
			while (this.listeners.length < count) {
				await Event.toPromise(this._onDidCreateListener.event);
			}
		}
		releaseAll(): void {
			for (const release of this.releases) {
				release.complete();
			}
		}
	}

	/** Records the service's warnings. */
	class RecordingLoggerService extends NullLoggerService {
		readonly logger = new RecordingLogger();
		protected override doCreateLogger(): RecordingLogger {
			return this.logger;
		}
	}

	test('without { grpc: true } a gateway opens no gRPC port, also on a service configured for gRPC, and its servers have no grpcAddress', async () => {
		const service = store.add(new TestGrpcService(store.add(new NullLoggerService()), { grpc: true }));
		const gateway = await service.createGateway('client', toolInvoker());
		assert.strictEqual(gateway.servers.length, 2);
		assert.ok(gateway.servers.every(server => !Object.prototype.hasOwnProperty.call(server, 'grpcAddress')), 'no grpcAddress key');
		assert.deepStrictEqual([service.grpcPort, service.listeners.length], [undefined, 0], 'no gRPC listener was even created, so no port listens');
		const http = await httpRequest(gateway.servers[0].address.toString(true), modernRequest('tools/call', { name: 'tool_one', arguments: {} }));
		assert.deepStrictEqual((jsonOf(http) as { result?: Json }).result?.content, [{ type: 'text', text: 'one:tool_one' }], 'served over HTTP');

		// The same for a route, and for a change of the gateway's servers.
		const handle = store.add(await service.createRoute('plain', store.add(new McpGatewayConformanceInvoker())));
		assert.strictEqual(handle.grpcAddress, undefined);
		const { invoker, servers } = changingInvoker([]);
		const growing = await service.createGateway('client-2', invoker);
		const changed = Event.toPromise(growing.onDidChangeServers);
		servers.fire([{ id: 'one', label: 'Server One' }]);
		assert.strictEqual((await changed)[0].grpcAddress, undefined);
		assert.deepStrictEqual([service.grpcPort, service.listeners.length], [undefined, 0]);
		await service.disposeGateway(gateway.gatewayId);
		await service.disposeGateway(growing.gatewayId);
	});

	test('{ grpc: true } opens the listener and advertises grpcAddress; a second gateway reuses it; disposing the last one closes the port while HTTP gateways keep theirs', async () => {
		const service = store.add(new TestGrpcService(store.add(new NullLoggerService()), { grpc: true }));
		const httpOnly = await service.createGateway('client-http', toolInvoker());
		const first = await service.createGateway('client-a', toolInvoker(), { grpc: true });
		const grpcPort = service.grpcPort;
		assert.ok(grpcPort !== undefined && grpcPort !== service.port);
		assert.strictEqual(service.listeners.length, 1);
		assert.strictEqual(first.servers.length, 2);
		const ch = channelTo(`127.0.0.1:${grpcPort}`);
		for (const server of first.servers) {
			const grpcAddress = server.grpcAddress;
			assert.ok(grpcAddress);
			assert.strictEqual(grpcAddress.scheme, 'grpc');
			assert.strictEqual(grpcAddress.authority, `127.0.0.1:${grpcPort}`);
			const routeId = grpcAddress.path.substring(1);
			assert.strictEqual(routeId, httpRouteOf(server), 'the gRPC route is the HTTP route');
			const serverId = server.label === 'Server One' ? 'one' : 'two';
			const { result, trailers } = await runTyped(ch, 'CallTool', { name: `tool_${serverId}` }, { [GRPC_ROUTE_METADATA_KEY]: routeId });
			assert.strictEqual(trailers.status, GrpcStatus.OK);
			assert.strictEqual(firstText(result), `${serverId}:tool_${serverId}`);
		}

		const second = await service.createGateway('client-b', toolInvoker(), { grpc: true });
		assert.strictEqual(service.listeners.length, 1, 'the second gateway reuses the listener');
		assert.ok(second.servers.every(server => server.grpcAddress?.authority === `127.0.0.1:${grpcPort}`));
		assert.ok(httpOnly.servers.every(server => server.grpcAddress === undefined));

		await service.disposeGateway(first.gatewayId);
		assert.strictEqual(service.grpcPort, grpcPort, 'open while a gateway that asked for gRPC lives');
		assert.strictEqual(service.disposals[0].isSettled, false);
		await service.disposeGateway(second.gatewayId);
		assert.strictEqual(service.grpcPort, undefined);
		assert.strictEqual(service.disposals[0].isSettled, true, 'the listener was disposed with the last gateway that asked for gRPC');
		await service.listeners[0].close(); // The shutdown its disposal began.
		assert.strictEqual(await isPortClosed(grpcPort), true, 'the gRPC port is closed');

		// HTTP keeps serving the gateway that did not ask for gRPC.
		assert.ok(service.port !== undefined);
		const http = await httpRequest(httpOnly.servers[1].address.toString(true), modernRequest('tools/call', { name: 'tool_two', arguments: {} }));
		assert.deepStrictEqual((jsonOf(http) as { result?: Json }).result?.content, [{ type: 'text', text: 'two:tool_two' }]);

		// The next request opens a new listener.
		const third = await service.createGateway('client-c', toolInvoker(), { grpc: true });
		assert.strictEqual(service.listeners.length, 2);
		assert.ok(third.servers.every(server => server.grpcAddress?.authority === `127.0.0.1:${service.grpcPort}`));
		await service.disposeGateway(third.gatewayId);
		await service.disposeGateway(httpOnly.gatewayId);
		assert.deepStrictEqual([service.port, service.grpcPort], [undefined, undefined]);
	});

	test('a route that did not ask for gRPC is NOT_FOUND over gRPC, trailers only, exactly like an unknown route', async () => {
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService()), { grpc: true }));
		const httpOnly = await service.createGateway('client-http', toolInvoker());
		const withGrpc = await service.createGateway('client-grpc', toolInvoker(), { grpc: true });
		// One created while the listener runs, and a route.
		const httpOnlyLater = await service.createGateway('client-http-later', toolInvoker());
		const httpOnlyRoute = store.add(await service.createRoute('http only', store.add(new McpGatewayConformanceInvoker())));
		assert.ok([...httpOnlyLater.servers.map(server => server.grpcAddress), httpOnlyRoute.grpcAddress].every(address => address === undefined));
		const port = service.grpcPort;
		assert.ok(port !== undefined);
		const listTools = rpcNamed('ListTools');
		const call = (routeId: string, path: string, payload: Uint8Array) => rawGrpcCall(port, path, { [GRPC_ROUTE_METADATA_KEY]: routeId, [MCP_PROTOCOL_VERSION_METADATA]: LATEST_MCP_PROTOCOL_VERSION }, payload);
		const notServed = [httpRouteOf(httpOnly.servers[0]), httpRouteOf(httpOnlyLater.servers[1]), httpOnlyRoute.routeId];
		for (const routeId of [...notServed, 'no-such-route']) {
			for (const [path, payload] of [[listTools.path, encodeTypedRequest(listTools, {})], [TUNNEL_CALL_PATH, tunnelPayload(tunnelRequest('server/discover').body)]] as const) {
				const outcome = await call(routeId, path, payload);
				assert.strictEqual(outcome.headers['grpc-status'], String(GrpcStatus.NOT_FOUND), `${routeId} ${path}`);
				assert.strictEqual(outcome.trailers, undefined, 'trailers only');
				assert.strictEqual(outcome.body.byteLength, 0);
				assert.strictEqual(decodeGrpcMessage(String(outcome.headers['grpc-message'])), `Unknown gateway route '${routeId}'`);
			}
		}
		// The route itself serves HTTP, and the gateway that asked is served over gRPC.
		const http = await httpRequest(httpOnly.servers[0].address.toString(true), modernRequest('tools/list'));
		assert.deepStrictEqual(((jsonOf(http) as { result?: Json }).result?.tools as { name: string }[]).map(tool => tool.name), ['tool_one']);
		const served = await runTyped(channelTo(`127.0.0.1:${port}`), 'ListTools', {}, {}, true, withGrpc.servers[0].grpcAddress!.path.substring(1));
		assert.deepStrictEqual((served.result?.tools as { name: string }[]).map(tool => tool.name), ['tool_one']);
		await service.disposeGateway(httpOnly.gatewayId);
		await service.disposeGateway(httpOnlyLater.gatewayId);
		await service.disposeGateway(withGrpc.gatewayId);
	});

	test('createRoute with { grpc: true } returns the gRPC address; even a single route needs the route metadata unless a fixture allows the default; without the option or the configuration there is none', async () => {
		const withGrpc = store.add(new McpGatewayService(store.add(new NullLoggerService()), { grpc: true }));
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const handle = store.add(await withGrpc.createRoute('conformance', invoker, { serverInfo: CONFORMANCE_SERVER_INFO }, { grpc: true }));
		assert.strictEqual(handle.grpcAddress?.toString(true), `grpc://127.0.0.1:${withGrpc.grpcPort}/${handle.routeId}`);
		const ch = channelTo(`127.0.0.1:${withGrpc.grpcPort}`);
		const anonymous = await runTunnel(ch, withoutRoute(tunnelRequest('server/discover')));
		assert.strictEqual(anonymous.trailers.status, GrpcStatus.NOT_FOUND, 'the product listener has no default route');
		const { messages, trailers } = await runTunnel(ch, tunnelRequest('server/discover', {}, { metadata: { [GRPC_ROUTE_METADATA_KEY]: handle.grpcAddress!.path.substring(1) } }));
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.deepStrictEqual(((messages[0].result as Json)._meta as Json)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);

		// The fixture's only gRPC route is the default; a route that did not ask for gRPC does not count.
		const fixture = store.add(new McpGatewayService(store.add(new NullLoggerService()), { grpc: { allowDefaultRoute: true } }));
		const fixtureHandle = store.add(await fixture.createRoute('fixture', invoker, { serverInfo: CONFORMANCE_SERVER_INFO }, { grpc: true }));
		const httpOnlyHandle = store.add(await fixture.createRoute('http only', invoker, { serverInfo: { name: 'http-only', version: '1.0.0' } }));
		assert.ok(fixtureHandle.grpcAddress);
		assert.strictEqual(httpOnlyHandle.grpcAddress, undefined);
		const fixtureChannel = channelTo(`127.0.0.1:${fixture.grpcPort}`);
		const defaulted = await runTunnel(fixtureChannel, withoutRoute(tunnelRequest('server/discover')));
		assert.strictEqual(defaulted.trailers.status, GrpcStatus.OK, 'the fixture\'s only gRPC route is the default');
		assert.deepStrictEqual(((defaulted.messages[0].result as Json)._meta as Json)[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);

		// Asking for gRPC does nothing on a service that is not configured for it (logged).
		const loggerService = store.add(new RecordingLoggerService());
		const plain = store.add(new McpGatewayService(loggerService));
		const plainHandle = store.add(await plain.createRoute('plain', invoker, undefined, { grpc: true }));
		assert.strictEqual(plainHandle.grpcAddress, undefined);
		assert.strictEqual(plain.grpcPort, undefined);
		assert.ok(loggerService.logger.warnings.some(warning => warning.includes('does not serve gRPC')), loggerService.logger.warnings.join('\n'));
		const off = store.add(new McpGatewayService(store.add(new NullLoggerService()), { grpc: false }));
		assert.strictEqual(store.add(await off.createRoute('off', invoker, undefined, { grpc: true })).grpcAddress, undefined);
		assert.strictEqual(off.grpcPort, undefined);
	});

	test('the product registration (mcpGatewayServiceDescriptor({ grpc: true }), as electron-main and the remote server use it) opens no gRPC port until a gateway asks for it, then advertises gRPC and requires the route', async () => {
		const loggerService = store.add(new NullLoggerService());
		const instantiation = new InstantiationService(new ServiceCollection([ILoggerService, loggerService], [IMcpGatewayService, mcpGatewayServiceDescriptor({ grpc: true })]), true);
		try {
			const service = instantiation.invokeFunction(accessor => accessor.get(IMcpGatewayService));
			assert.ok(service instanceof McpGatewayService);
			const plain = await service.createGateway('client', toolInvoker());
			assert.ok(plain.servers.every(server => server.grpcAddress === undefined));
			assert.strictEqual(service.grpcPort, undefined, 'a gateway that does not ask (every Copilot CLI session today) opens no gRPC port');

			const gateway = await service.createGateway('client', toolInvoker(), { grpc: true });
			assert.ok(gateway.servers.every(server => server.grpcAddress?.scheme === 'grpc'));
			const ch = channelTo(gateway.servers[0].grpcAddress!.authority);
			assert.strictEqual((await runTyped(ch, 'ListTools', {}, {}, true, null)).trailers.status, GrpcStatus.NOT_FOUND);
			const listed = await runTyped(ch, 'ListTools', {}, {}, true, gateway.servers[1].grpcAddress!.path.substring(1));
			assert.deepStrictEqual((listed.result?.tools as { name: string }[]).map(tool => tool.name), ['tool_two']);
			await service.disposeGateway(gateway.gatewayId);
			assert.strictEqual(service.grpcPort, undefined);
			await service.disposeGateway(plain.gatewayId);
		} finally {
			instantiation.dispose();
		}
	});

	test('concurrent first requests for gRPC wait for one listener start and share the listener', async () => {
		const service = store.add(new TestGrpcService(store.add(new NullLoggerService()), { grpc: true }));
		service.gated = true;
		try {
			const gateway = service.createGateway('client', toolInvoker(), { grpc: true });
			const route = service.createRoute('route', store.add(new McpGatewayConformanceInvoker()), undefined, { grpc: true });
			const other = service.createGateway('client-2', toolInvoker(), { grpc: true });
			await service.listenerCreated(1);
			await timeout(20);
			assert.strictEqual(service.listeners.length, 1, 'one start, while it binds');
			service.releases[0].complete();
			const [first, handle, second] = await Promise.all([gateway, route, other]);
			store.add(handle);
			assert.strictEqual(service.listeners.length, 1, 'one listener');
			const authority = `127.0.0.1:${service.grpcPort}`;
			assert.deepStrictEqual(
				[...first.servers, ...second.servers].map(server => server.grpcAddress?.authority).concat(handle.grpcAddress?.authority),
				[authority, authority, authority, authority, authority],
			);
			assert.strictEqual(service.listeners[0].routeCount, 5);
			await service.disposeGateway(first.gatewayId);
			await service.disposeGateway(second.gatewayId);
		} finally {
			service.releaseAll();
		}
	});

	test('a request that stops waiting for the gRPC listener does not close it under another request that still waits', async () => {
		const service = store.add(new TestGrpcService(store.add(new NullLoggerService()), { grpc: true }));
		service.gated = true;
		try {
			// A gateway without servers asks for gRPC: the listener opens for it, and closes since it serves no route.
			const { invoker, servers } = changingInvoker([]);
			const leaving = service.createGateway('client-leaving', invoker, { grpc: true });
			await service.listenerCreated(1);
			service.releases[0].complete();
			const leavingGateway = await leaving;
			await service.disposals[0].p;
			assert.strictEqual(service.grpcPort, undefined, 'no gRPC route, no listener');

			// Its first server starts the listener again; a second gateway waits for the same start.
			servers.fire([{ id: 'one', label: 'Server One' }]);
			await service.listenerCreated(2);
			const staying = service.createGateway('client-staying', toolInvoker(), { grpc: true });
			await timeout(20);
			// The first gateway goes away while the listener binds (its HTTP server stops too: no route is left).
			await service.disposeGateway(leavingGateway.gatewayId);
			assert.strictEqual(service.port, undefined);
			service.releases[1].complete();
			const stayingGateway = await staying;

			assert.strictEqual(service.listeners.length, 2, 'the waiting gateway got the listener of the shared start, not a third one');
			assert.strictEqual(service.disposals[1].isSettled, false);
			assert.strictEqual(service.grpcPort, service.listeners[1].port);
			const grpcAddress = stayingGateway.servers[0].grpcAddress;
			assert.strictEqual(grpcAddress?.authority, `127.0.0.1:${service.grpcPort}`);
			const typed = await runTyped(channelTo(grpcAddress.authority), 'CallTool', { name: 'tool_one' }, {}, true, grpcAddress.path.substring(1));
			assert.strictEqual(firstText(typed.result), 'one:tool_one');
			await service.disposeGateway(stayingGateway.gatewayId);
			assert.deepStrictEqual([service.port, service.grpcPort], [undefined, undefined]);
		} finally {
			service.releaseAll();
		}
	});

	test('when the gRPC listener cannot open, the gateway that asked is served over HTTP only (logged), and the next request opens it', async () => {
		const loggerService = store.add(new RecordingLoggerService());
		const service = store.add(new TestGrpcService(loggerService, { grpc: true }));
		service.failBinds = 1;
		const degraded = await service.createGateway('client-a', toolInvoker(), { grpc: true });
		assert.strictEqual(degraded.servers.length, 2);
		assert.ok(degraded.servers.every(server => server.grpcAddress === undefined), 'no grpcAddress');
		assert.strictEqual(service.grpcPort, undefined);
		assert.strictEqual(service.disposals[0].isSettled, true, 'the listener that could not bind was disposed');
		assert.ok(loggerService.logger.warnings.some(warning => warning.includes('serving HTTP only') && warning.includes('the test refuses to bind')), loggerService.logger.warnings.join('\n'));
		const http = await httpRequest(degraded.servers[0].address.toString(true), modernRequest('tools/call', { name: 'tool_one', arguments: {} }));
		assert.deepStrictEqual((jsonOf(http) as { result?: Json }).result?.content, [{ type: 'text', text: 'one:tool_one' }]);

		const next = await service.createGateway('client-b', toolInvoker(), { grpc: true });
		assert.strictEqual(service.listeners.length, 2);
		assert.ok(next.servers.every(server => server.grpcAddress?.authority === `127.0.0.1:${service.grpcPort}`));
		// The degraded gateway stays HTTP only: its routes are not on the new listener.
		const notServed = await runTyped(channelTo(`127.0.0.1:${service.grpcPort}`), 'ListTools', {}, {}, true, httpRouteOf(degraded.servers[0]));
		assert.strictEqual(notServed.trailers.status, GrpcStatus.NOT_FOUND);
		await service.disposeGateway(degraded.gatewayId);
		await service.disposeGateway(next.gatewayId);
	});

	test('a request that reaches the gRPC listener only after a start failed begins a new start', async () => {
		const service = store.add(new TestGrpcService(store.add(new NullLoggerService()), { grpc: true }));
		service.gated = true;
		service.failBinds = 1;
		try {
			// The first request waits for a start that will fail.
			const failing = service.createGateway('client-a', toolInvoker(), { grpc: true });
			await service.listenerCreated(1);
			service.gated = false;
			// The HTTP server stops (its last route goes), so the second request first waits for the HTTP server to start again.
			(await service.createRoute('http only', store.add(new McpGatewayConformanceInvoker()))).dispose();
			assert.strictEqual(service.port, undefined);
			const later = service.createGateway('client-b', toolInvoker(), { grpc: true });
			service.releases[0].complete();
			const [degraded, served] = await Promise.all([failing, later]);
			assert.ok(degraded.servers.every(server => server.grpcAddress === undefined), 'the request that waited for the failed start is served over HTTP only');
			assert.strictEqual(service.listeners.length, 2, 'the later request did not take the failed start for its own');
			assert.ok(served.servers.every(server => server.grpcAddress?.authority === `127.0.0.1:${service.grpcPort}`));
			await service.disposeGateway(degraded.gatewayId);
			await service.disposeGateway(served.gatewayId);
		} finally {
			service.releaseAll();
		}
	});

	test('replacing the last server of a gateway served over gRPC keeps its listener; losing every server closes it', async () => {
		const service = store.add(new TestGrpcService(store.add(new NullLoggerService()), { grpc: true }));
		const { invoker, servers } = changingInvoker([{ id: 'one', label: 'Server One' }]);
		const gateway = await service.createGateway('client', invoker, { grpc: true });
		const grpcPort = service.grpcPort;
		assert.ok(grpcPort !== undefined);

		const replaced = Event.toPromise(gateway.onDidChangeServers);
		servers.fire([{ id: 'two', label: 'Server Two' }]);
		const [server] = await replaced;
		assert.strictEqual(service.listeners.length, 1, 'no second listener');
		assert.strictEqual(service.disposals[0].isSettled, false);
		assert.strictEqual(server.grpcAddress?.authority, `127.0.0.1:${grpcPort}`, 'same port');
		const typed = await runTyped(channelTo(server.grpcAddress.authority), 'CallTool', { name: 'tool_two' }, {}, true, server.grpcAddress.path.substring(1));
		assert.strictEqual(firstText(typed.result), 'two:tool_two');

		const emptied = Event.toPromise(gateway.onDidChangeServers);
		servers.fire([]);
		assert.deepStrictEqual(await emptied, []);
		assert.strictEqual(service.grpcPort, undefined, 'no gRPC route is left');
		assert.strictEqual(service.disposals[0].isSettled, true);
		await service.disposeGateway(gateway.gatewayId);
	});

	test('a gateway created without servers gets working routes later, even after another gateway\'s disposal stopped the server', async () => {
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService()), { grpc: true }));
		const { invoker, servers: onDidChangeServers } = changingInvoker([]);
		const emptyGateway = await service.createGateway('client-empty', invoker, { grpc: true });
		assert.deepStrictEqual(emptyGateway.servers, []);
		const other = await service.createGateway('client-other', toolInvoker(), { grpc: true });
		await service.disposeGateway(other.gatewayId);
		assert.strictEqual(service.port, undefined, 'the last route stopped the server although the empty gateway lives on');
		assert.strictEqual(service.grpcPort, undefined);

		const changed = Event.toPromise(emptyGateway.onDidChangeServers);
		onDidChangeServers.fire([{ id: 'one', label: 'Server One' }]);
		const servers = await changed;
		assert.strictEqual(servers.length, 1);
		const port = service.port;
		const grpcPort = service.grpcPort;
		assert.ok(port !== undefined && grpcPort !== undefined, 'the server and the gRPC listener run again');
		const [server] = servers;
		const grpcAddress = server.grpcAddress;
		assert.ok(grpcAddress);
		assert.strictEqual(server.address.authority, `127.0.0.1:${port}`, 'never http://127.0.0.1:undefined');
		assert.strictEqual(grpcAddress.authority, `127.0.0.1:${grpcPort}`);

		// Both addresses serve the server.
		const http = await httpRequest(server.address.toString(true), modernRequest('tools/call', { name: 'tool_one', arguments: {} }));
		assert.deepStrictEqual((jsonOf(http) as { result?: Json }).result?.content, [{ type: 'text', text: 'one:tool_one' }]);
		const typed = await runTyped(channelTo(grpcAddress.authority), 'CallTool', { name: 'tool_one' }, {}, true, grpcAddress.path.substring(1));
		assert.strictEqual(firstText(typed.result), 'one:tool_one');

		await service.disposeGateway(emptyGateway.gatewayId);
		assert.deepStrictEqual([service.port, service.grpcPort], [undefined, undefined]);
	});

	test('a gateway disposed while a change of its servers starts the server again leaves no server running', async () => {
		const service = store.add(new TestGrpcService(store.add(new NullLoggerService()), { grpc: true }));
		service.gated = true;
		try {
			const route = service.createRoute('a', store.add(new McpGatewayConformanceInvoker()), undefined, { grpc: true });
			await service.listenerCreated(1);
			service.releases[0].complete();
			const handle = await route;
			const { invoker, servers } = changingInvoker([]);
			const gateway = await service.createGateway('client', invoker, { grpc: true });
			handle.dispose();
			assert.deepStrictEqual([service.port, service.grpcPort], [undefined, undefined], 'the last route stopped the server and the gRPC listener');

			// A change of the gateway's servers starts both again; the gateway goes away while its gRPC listener binds.
			servers.fire([{ id: 'one', label: 'Server One' }]);
			await service.listenerCreated(2);
			await service.disposeGateway(gateway.gatewayId);
			service.releases[1].complete();
			await service.disposals[1].p;
			await timeout(50);
			assert.strictEqual(service.listeners.length, 2, 'no further start for a gateway that is gone');
			assert.deepStrictEqual([service.port, service.grpcPort], [undefined, undefined], 'nothing listens without a route');
		} finally {
			service.releaseAll();
		}
	});

	test('disposing the service while the gRPC listener binds closes the listener and fails the request', async () => {
		const service = new TestGrpcService(store.add(new NullLoggerService()), { grpc: true });
		service.gated = true;
		let disposed = false;
		try {
			const pending = service.createGateway('client', toolInvoker(), { grpc: true });
			await service.listenerCreated(1);
			service.dispose();
			disposed = true;
			service.releases[0].complete();
			await assert.rejects(pending, /disposed/);
			await service.disposals[0].p;
			assert.strictEqual(service.grpcPort, undefined);
			await service.listeners[0].close();
			assert.strictEqual(service.listeners[0].port, undefined, 'the listener stopped listening');
		} finally {
			service.releaseAll();
			if (!disposed) {
				service.dispose();
			}
		}
	});
});
