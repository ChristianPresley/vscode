/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as proxyAgent from '@vscode/proxy-agent';
import assert from 'assert';
import * as fs from 'fs';
import * as http2 from 'http2';
import * as net from 'net';
import * as os from 'os';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { encodeLengthPrefixedMessage, LengthPrefixedMessageReader } from '../../../../base/common/grpc/lpm.js';
import { encodeBinaryMetadata, GrpcStatus } from '../../../../base/common/grpc/status.js';
import { join } from '../../../../base/common/path.js';
import { decodeMessage, encodeMessage } from '../../../../base/common/protobuf/codec.js';
import { decodeUtf8, encodeUtf8 } from '../../../../base/common/protobuf/wire.js';
import { URI } from '../../../../base/common/uri.js';
import { IGrpcCall, IGrpcCallOptions, IGrpcChannelOptions, IGrpcResponseHeaders, IGrpcTrailers } from '../../../../base/node/grpcChannel.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { LogLevel, NullLogger, NullLogService } from '../../../../platform/log/common/log.js';
import { JSON_RPC_MESSAGE, TUNNEL_CALL_PATH, typedRpcForMethod } from '../../../../platform/mcp/common/mcpGrpcProto.js';
import { decodeTypedRequest, encodeTypedResponse } from '../../../../platform/mcp/common/mcpGrpcTyped.js';
import product from '../../../../platform/product/common/product.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { generateSelfSignedCert, ISelfSignedCert } from '../../../../platform/tunnel/node/selfSignedCert.js';
import { McpServerRequestHandler } from '../../../contrib/mcp/common/mcpServerRequestHandler.js';
import { McpTaskManager } from '../../../contrib/mcp/common/mcpTaskManager.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpClientError, McpConnectionState, McpServerTransportGrpc, McpServerTransportType, MpcResponseError } from '../../../contrib/mcp/common/mcpTypes.js';
import { IMcpAuthenticationDetails, IMcpAuthenticationOptions, MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { CommonResponse } from '../../common/extHostMcp.js';
import { DEFAULT_GRPC_DEADLINE_MS, extensionHostProxyLookup, grpcDeadlineFor, IGrpcProxyLookup, IMcpGrpcChannel, IMcpGrpcHandleOptions, isLoopbackHost, mapGrpcTrailersToJsonRpc, McpGrpcHandle } from '../../node/extHostMcpGrpc.js';
import { GrpcTestTransport } from './extHostMcpGrpcTestUtils.js';

//#region Fakes

type JsonObject = Record<string, unknown>;

function tunnelPayload(message: unknown): Uint8Array {
	return encodeMessage(JSON_RPC_MESSAGE, { jsonrpc: encodeUtf8(JSON.stringify(message)) });
}

function tunnelRequest(payload: Uint8Array): JsonObject {
	const bytes = decodeMessage(JSON_RPC_MESSAGE, payload).jsonrpc;
	assert.ok(bytes instanceof Uint8Array);
	return JSON.parse(decodeUtf8(bytes));
}

/** A scripted call: the test pushes messages and finishes it with trailers. */
class FakeCall implements IGrpcCall {
	readonly responseHeaders: Promise<IGrpcResponseHeaders> = Promise.resolve({ httpStatus: 200, headers: {} });
	readonly trailers: Promise<IGrpcTrailers>;
	readonly messages: AsyncIterable<Uint8Array>;
	cancelled = false;

	private readonly _queue: Uint8Array[] = [];
	private _waiter: DeferredPromise<void> | undefined;
	private _ended: IGrpcTrailers | undefined;
	private readonly _trailers = new DeferredPromise<IGrpcTrailers>();

	constructor(
		readonly path: string,
		readonly metadata: Readonly<Record<string, string>>,
		readonly request: Uint8Array,
		readonly options: IGrpcCallOptions | undefined,
	) {
		this.trailers = this._trailers.p;
		this.messages = { [Symbol.asyncIterator]: () => this._iterate() };
	}

	get json(): JsonObject {
		return tunnelRequest(this.request);
	}

	push(payload: Uint8Array): void {
		this._queue.push(payload);
		this._wake();
	}

	finish(status: GrpcStatus = GrpcStatus.OK, raw: Record<string, string> = {}, message?: string): void {
		if (this._ended) {
			return;
		}
		this._ended = message === undefined ? { status, raw } : { status, raw, message };
		this._trailers.complete(this._ended);
		this._wake();
	}

	cancel(): void {
		if (!this._ended) {
			this.cancelled = true;
			this.finish(GrpcStatus.CANCELLED, {}, 'call cancelled');
		}
	}

	private _wake(): void {
		const waiter = this._waiter;
		this._waiter = undefined;
		waiter?.complete();
	}

	private async *_iterate(): AsyncGenerator<Uint8Array> {
		for (; ;) {
			const next = this._queue.shift();
			if (next) {
				yield next;
				continue;
			}
			if (this._ended) {
				if (this._ended.status !== GrpcStatus.OK) {
					throw new Error(`call ended with ${this._ended.status}`);
				}
				return;
			}
			this._waiter = new DeferredPromise<void>();
			await this._waiter.p;
		}
	}
}

class FakeChannel implements IMcpGrpcChannel {
	readonly calls: FakeCall[] = [];
	disposed = false;

	constructor(private readonly _respond: (call: FakeCall, index: number) => void) { }

	call(path: string, metadata: Readonly<Record<string, string>>, request: Uint8Array, options?: IGrpcCallOptions): IGrpcCall {
		const call = new FakeCall(path, { ...metadata }, request, options);
		const index = this.calls.push(call) - 1;
		this._respond(call, index);
		return call;
	}

	dispose(): void {
		this.disposed = true;
	}
}

function respondTunnel(call: FakeCall, ...messages: unknown[]): void {
	for (const message of messages) {
		call.push(tunnelPayload(message));
	}
	call.finish();
}

interface IHandleFixture {
	readonly handle: McpGrpcHandle;
	readonly channel: FakeChannel;
	readonly messages: JsonObject[];
	readonly aborts: IMcpRequestAbort[];
	readonly states: McpConnectionState[];
	readonly logs: { level: LogLevel; message: string }[];
	readonly tokenRequests: { details: IMcpAuthenticationDetails; options: IMcpAuthenticationOptions | undefined }[];
	channelOptions(): IGrpcChannelOptions | undefined;
}

interface IHandleSetup {
	readonly launch?: Partial<McpServerTransportGrpc>;
	readonly token?: (details: IMcpAuthenticationDetails, options: IMcpAuthenticationOptions | undefined) => string | undefined;
	readonly allowed?: (url: string) => string | undefined;
	readonly options?: IMcpGrpcHandleOptions;
	readonly channel?: FakeChannel;
}

function launchOf(overrides: Partial<McpServerTransportGrpc> = {}): McpServerTransportGrpc {
	return { type: McpServerTransportType.Grpc, uri: URI.parse('grpc://127.0.0.1:50051'), headers: [], ...overrides };
}

function createFixture(store: { add<T extends { dispose(): void }>(t: T): T }, respond: (call: FakeCall, index: number) => void, setup: IHandleSetup = {}): IHandleFixture {
	const messages: JsonObject[] = [];
	const aborts: IMcpRequestAbort[] = [];
	const states: McpConnectionState[] = [];
	const logs: { level: LogLevel; message: string }[] = [];
	const tokenRequests: { details: IMcpAuthenticationDetails; options: IMcpAuthenticationOptions | undefined }[] = [];
	const channel = setup.channel ?? new FakeChannel(respond);
	let channelOptions: IGrpcChannelOptions | undefined;
	const proxy = new class extends mock<MainThreadMcpShape>() {
		override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
		override $onDidReceiveMessage(_id: number, message: string): void { messages.push(JSON.parse(message)); }
		override $onDidAbortRequest(_id: number, abort: IMcpRequestAbort): void { aborts.push(abort); }
		override $onDidPublishLog(_id: number, level: LogLevel, message: string): void { logs.push({ level, message }); }
		override async $checkMcpServerAllowed(_id: number, url: string): Promise<string | undefined> { return setup.allowed?.(url); }
		override async $getTokenFromServerMetadata(_id: number, details: IMcpAuthenticationDetails, options?: IMcpAuthenticationOptions): Promise<string | undefined> {
			tokenRequests.push({ details, options });
			return setup.token?.(details, options);
		}
		override $logMcpAuthSetup(): void { }
	};
	const handle = store.add(new McpGrpcHandle(1, launchOf(setup.launch), proxy, new NullLogService(), false, {
		createChannel: options => {
			channelOptions = options;
			return channel;
		},
		proxyLookup: async () => ({}),
		...setup.options,
	}));
	return { handle, channel, messages, aborts, states, logs, tokenRequests, channelOptions: () => channelOptions };
}

const MODERN = '2026-07-28';

function envelope(method: string, requestId: number | undefined, overrides: Partial<IMcpMessageEnvelope> = {}): IMcpMessageEnvelope {
	return { kind: requestId === undefined ? 'notification' : 'request', requestId, protocolVersion: MODERN, method, ...overrides };
}

function request(id: number, method: string, params: unknown = {}): string {
	return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			assert.fail(`timed out waiting for ${what}`);
		}
		await timeout(5);
	}
}

function trailers(status: GrpcStatus, raw: Record<string, string> = {}, message?: string): IGrpcTrailers {
	return message === undefined ? { status, raw } : { status, raw, message };
}

function errorBin(error: JsonObject, id: unknown = null): string {
	return encodeBinaryMetadata(encodeUtf8(JSON.stringify({ jsonrpc: '2.0', id, error })));
}

function jsonResponse(url: string, status: number, body?: unknown): CommonResponse {
	const text = body === undefined ? '' : JSON.stringify(body);
	return {
		status,
		statusText: String(status),
		url,
		headers: new Headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		body: null,
		json: async () => JSON.parse(text),
		text: async () => text,
	};
}

//#endregion

suite('McpGrpcHandle', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('sends a request on the tunnel with the configured, mirrored and version metadata and delivers the stream', async () => {
		const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't', progress: 1 } };
		const response = { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [] } };
		const f = createFixture(store, call => respondTunnel(call, progress, response), { launch: { headers: [['X-Api-Key', 'secret-key']] } });

		const sent = request(1, 'tools/list');
		await f.handle.send(sent, envelope('tools/list', 1, { headers: { 'Mcp-Method': 'tools/list' } }));

		const [call] = f.channel.calls;
		assert.deepStrictEqual({
			path: call.path,
			metadata: call.metadata,
			request: call.json,
			deadlineMs: call.options?.deadlineMs,
			messages: f.messages,
			aborts: f.aborts,
			states: f.states,
			binding: f.handle.binding,
		}, {
			path: TUNNEL_CALL_PATH,
			metadata: { 'x-api-key': 'secret-key', 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
			request: JSON.parse(sent),
			deadlineMs: DEFAULT_GRPC_DEADLINE_MS,
			messages: [progress, response],
			aborts: [],
			states: [{ state: McpConnectionState.Kind.Running }],
			binding: 'tunnel',
		});
	});

	test('deadlines: 60 s for discover, list, read, prompts and completion; none for tools/call, retries and listen unless configured', () => {
		const table = [
			grpcDeadlineFor('server/discover', 'request', {}, undefined),
			grpcDeadlineFor('tools/list', 'request', {}, undefined),
			grpcDeadlineFor('resources/read', 'request', { uri: 'a' }, undefined),
			grpcDeadlineFor('prompts/get', 'request', { name: 'p' }, undefined),
			grpcDeadlineFor('completion/complete', 'request', {}, undefined),
			grpcDeadlineFor('tools/call', 'request', { name: 't' }, undefined),
			grpcDeadlineFor('prompts/get', 'request', { name: 'p', inputResponses: {} }, undefined),
			grpcDeadlineFor('prompts/get', 'request', { name: 'p', requestState: 's' }, undefined),
			grpcDeadlineFor('subscriptions/listen', 'listen', {}, undefined),
			grpcDeadlineFor('tools/call', 'request', { name: 't' }, 30_000),
			grpcDeadlineFor('tools/call', 'request', { name: 't', inputResponses: {} }, 30_000),
			grpcDeadlineFor('tools/list', 'request', {}, 30_000),
			grpcDeadlineFor('subscriptions/listen', 'listen', {}, 30_000),
			grpcDeadlineFor('tools/call', 'request', {}, 30_000, 5_000),
			grpcDeadlineFor('tasks/get', 'request', {}, undefined),
		];
		assert.deepStrictEqual(table, [60_000, 60_000, 60_000, 60_000, 60_000, undefined, undefined, undefined, undefined, 30_000, 30_000, 30_000, undefined, 5_000, undefined]);
	});

	test('tools/call gets no deadline by default and the configured one otherwise; listen never gets one', async () => {
		const respond = (call: FakeCall) => {
			const id = call.json.id;
			if (call.json.method === 'subscriptions/listen') {
				respondTunnel(call, { jsonrpc: '2.0', id, result: { resultType: 'complete' } });
			} else {
				respondTunnel(call, { jsonrpc: '2.0', id, result: { resultType: 'complete', content: [] } });
			}
		};
		const plain = createFixture(store, respond);
		await plain.handle.send(request(1, 'tools/call', { name: 't' }), envelope('tools/call', 1));
		const configured = createFixture(store, respond, { launch: { deadlineMs: 30_000 } });
		await configured.handle.send(request(1, 'tools/call', { name: 't' }), envelope('tools/call', 1));
		await configured.handle.send(request(2, 'subscriptions/listen', { notifications: {} }), envelope('subscriptions/listen', 2, { kind: 'listen' }));

		assert.deepStrictEqual([
			plain.channel.calls[0].options?.deadlineMs,
			configured.channel.calls[0].options?.deadlineMs,
			configured.channel.calls[1].options?.deadlineMs,
		], [undefined, 30_000, undefined]);
	});

	test('trailer mapping: mcp-error-bin, then mcp-error-code, then the status as an abort', () => {
		const bin = errorBin({ code: -32020, message: 'Header mismatch: mcp-name', data: { header: 'Mcp-Name' } });
		const huge = errorBin({ code: -32603, message: 'x'.repeat(5000) });
		const outcomes = [
			mapGrpcTrailersToJsonRpc(trailers(GrpcStatus.INVALID_ARGUMENT, { 'mcp-error-bin': bin, 'mcp-error-code': '-32602' }, 'ignored'), 7),
			mapGrpcTrailersToJsonRpc(trailers(GrpcStatus.INVALID_ARGUMENT, { 'mcp-error-code': '-32020' }, 'Header mismatch'), 7),
			mapGrpcTrailersToJsonRpc(trailers(GrpcStatus.INTERNAL, { 'mcp-error-bin': huge, 'mcp-error-code': '-32603' }, 'too big'), 'a'),
			mapGrpcTrailersToJsonRpc(trailers(GrpcStatus.INTERNAL, { 'mcp-error-bin': '%%%not base64', 'mcp-error-code': '-32603' }, 'bad bin'), 8),
			mapGrpcTrailersToJsonRpc(trailers(GrpcStatus.UNIMPLEMENTED, { 'mcp-error-code': 'nope' }, 'unknown path'), 9),
			mapGrpcTrailersToJsonRpc(trailers(GrpcStatus.UNAVAILABLE, {}, 'connection lost'), 10),
			mapGrpcTrailersToJsonRpc(trailers(GrpcStatus.DEADLINE_EXCEEDED), 11),
		];
		assert.deepStrictEqual(outcomes.map(o => o.kind === 'message' ? JSON.parse(o.message) : o.abort), [
			{ jsonrpc: '2.0', id: 7, error: { code: -32020, message: 'Header mismatch: mcp-name', data: { header: 'Mcp-Name' } } },
			{ jsonrpc: '2.0', id: 7, error: { code: -32020, message: 'Header mismatch' } },
			{ jsonrpc: '2.0', id: 'a', error: { code: -32603, message: 'too big' } },
			{ jsonrpc: '2.0', id: 8, error: { code: -32603, message: 'bad bin' } },
			{ reason: 'grpc-status', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: 'UNIMPLEMENTED: unknown path' },
			{ reason: 'grpc-status', grpcStatus: GrpcStatus.UNAVAILABLE, message: 'UNAVAILABLE: connection lost' },
			{ reason: 'grpc-status', grpcStatus: GrpcStatus.DEADLINE_EXCEEDED, message: 'DEADLINE_EXCEEDED' },
		]);
	});

	test('delivers trailer errors as messages with the request id and status-only failures as grpc-status aborts', async () => {
		const f = createFixture(store, (call, index) => {
			switch (index) {
				case 0: return call.finish(GrpcStatus.INVALID_ARGUMENT, { 'mcp-error-code': '-32020', 'mcp-error-bin': errorBin({ code: -32020, message: 'Header mismatch' }) }, 'Header mismatch');
				case 1: return call.finish(GrpcStatus.INVALID_ARGUMENT, {}, 'bad params');
				default: return call.finish(GrpcStatus.UNAVAILABLE, {}, 'connection lost');
			}
		}, { launch: { binding: 'tunnel' } });
		await f.handle.send(request(1, 'tools/call', { name: 't' }), envelope('tools/call', 1));
		await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
		await f.handle.send(request(3, 'tools/list'), envelope('tools/list', 3));

		assert.deepStrictEqual({ messages: f.messages, aborts: f.aborts }, {
			messages: [{ jsonrpc: '2.0', id: 1, error: { code: -32020, message: 'Header mismatch' } }],
			aborts: [
				{ requestId: 2, reason: 'grpc-status', grpcStatus: GrpcStatus.INVALID_ARGUMENT, message: 'INVALID_ARGUMENT: bad params' },
				{ requestId: 3, reason: 'grpc-status', grpcStatus: GrpcStatus.UNAVAILABLE, message: 'UNAVAILABLE: connection lost' },
			],
		});
	});

	test('a response stream that ends without the response aborts the request with stream-closed', async () => {
		const f = createFixture(store, call => respondTunnel(call, { jsonrpc: '2.0', method: 'notifications/progress', params: {} }));
		await f.handle.send(request(4, 'tools/call', { name: 't' }), envelope('tools/call', 4));
		assert.deepStrictEqual(f.aborts.map(a => [a.requestId, a.reason]), [[4, 'stream-closed']]);
	});

	test('cancelRequest resets the stream (RST_STREAM CANCEL) and reports nothing', async () => {
		const f = createFixture(store, () => { /* never answers */ });
		const sending = f.handle.send(request(5, 'tools/call', { name: 'slow' }), envelope('tools/call', 5));
		await waitFor(() => f.channel.calls.length === 1, 'the call');
		f.handle.cancelRequest(5);
		await sending;
		assert.deepStrictEqual({ cancelled: f.channel.calls[0].cancelled, messages: f.messages, aborts: f.aborts }, { cancelled: true, messages: [], aborts: [] });
	});

	test('listen: the acknowledgement arrives on the open stream; a cancel ends it quietly, a server close without a result aborts it', async () => {
		const ack = { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: { toolsListChanged: true } } };
		let closeByServer: (() => void) | undefined;
		const f = createFixture(store, (call, index) => {
			call.push(tunnelPayload(ack));
			if (index === 1) {
				closeByServer = () => call.finish();
			}
		});
		const first = f.handle.send(request(6, 'subscriptions/listen', { notifications: { toolsListChanged: true } }), envelope('subscriptions/listen', 6, { kind: 'listen' }));
		await waitFor(() => f.messages.length === 1, 'the acknowledgement');
		f.handle.cancelRequest(6);
		await first;

		const second = f.handle.send(request(7, 'subscriptions/listen', { notifications: { toolsListChanged: true } }), envelope('subscriptions/listen', 7, { kind: 'listen' }));
		await waitFor(() => f.messages.length === 2 && closeByServer !== undefined, 'the second acknowledgement');
		closeByServer!();
		await second;

		assert.deepStrictEqual({
			cancelled: f.channel.calls.map(c => c.cancelled),
			deadlines: f.channel.calls.map(c => c.options?.deadlineMs),
			messages: f.messages,
			aborts: f.aborts.map(a => [a.requestId, a.reason]),
		}, {
			cancelled: [true, false],
			deadlines: [undefined, undefined],
			messages: [ack, ack],
			aborts: [[7, 'stream-closed']],
		});
	});

	test('notifications travel as a call that the server answers with an empty stream', async () => {
		const f = createFixture(store, call => call.finish());
		await f.handle.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }), envelope('notifications/roots/list_changed', undefined));
		assert.deepStrictEqual({ path: f.channel.calls[0].path, request: f.channel.calls[0].json, messages: f.messages, aborts: f.aborts }, {
			path: TUNNEL_CALL_PATH,
			request: { jsonrpc: '2.0', method: 'notifications/roots/list_changed' },
			messages: [],
			aborts: [],
		});
	});

	test('typed binding: encodes the params, adds the routing metadata and decodes the response', async () => {
		const rpc = typedRpcForMethod('tools/call')!;
		const result = { resultType: 'complete', content: [{ type: 'text', text: 'echo: hi' }], structuredContent: { text: 'echo: hi' } };
		const f = createFixture(store, call => {
			call.push(encodeTypedResponse(rpc, result));
			call.finish();
		}, { launch: { binding: 'typed' } });
		await f.handle.send(request(8, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }), envelope('tools/call', 8, { headers: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' } }));

		const [call] = f.channel.calls;
		const params = decodeTypedRequest(rpc, call.request);
		assert.deepStrictEqual({
			path: call.path,
			metadata: call.metadata,
			name: params.name,
			arguments: params.arguments,
			deadlineMs: call.options?.deadlineMs,
			messages: f.messages,
		}, {
			path: '/model_context_protocol.Mcp/CallTool',
			metadata: { 'mcp-method': 'tools/call', 'mcp-name': 'echo', 'mcp-protocol-version': MODERN, 'mcp_tool': 'echo' },
			name: 'echo',
			arguments: { text: 'hi' },
			deadlineMs: undefined,
			messages: [{ jsonrpc: '2.0', id: 8, result }],
		});
	});

	test('typed binding: an input_required result travels with its input requests and the state', async () => {
		const rpc = typedRpcForMethod('tools/call')!;
		const result = {
			resultType: 'input_required',
			requestState: 'round-1',
			inputRequests: { user_name: { method: 'elicitation/create', params: { message: 'What is your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } },
		};
		const f = createFixture(store, (call, index) => {
			call.push(encodeTypedResponse(rpc, index === 0 ? result : { resultType: 'complete', content: [{ type: 'text', text: 'Hello, Ada!' }] }));
			call.finish();
		}, { launch: { binding: 'typed' } });
		await f.handle.send(request(1, 'tools/call', { name: 'greet' }), envelope('tools/call', 1));
		await f.handle.send(request(2, 'tools/call', { name: 'greet', requestState: 'round-1', inputResponses: { user_name: { action: 'accept', content: { name: 'Ada' } } } }), envelope('tools/call', 2));

		const retry = decodeTypedRequest(rpc, f.channel.calls[1].request);
		assert.deepStrictEqual({
			first: f.messages[0],
			retryState: retry.requestState,
			retryResponses: retry.inputResponses,
			second: f.messages[1],
		}, {
			first: { jsonrpc: '2.0', id: 1, result },
			retryState: 'round-1',
			retryResponses: { user_name: { action: 'accept', content: { name: 'Ada' } } },
			second: { jsonrpc: '2.0', id: 2, result: { resultType: 'complete', content: [{ type: 'text', text: 'Hello, Ada!' }] } },
		});
	});

	test('typed-only servers: server/discover is synthesized and subscriptions/listen answered with -32601, without a call', async () => {
		const f = createFixture(store, () => assert.fail('no call expected'), { launch: { binding: 'typed', uri: URI.parse('grpc://typed.example:50051') } });
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		await f.handle.send(request(2, 'subscriptions/listen', { notifications: {} }), envelope('subscriptions/listen', 2, { kind: 'listen' }));
		await f.handle.send(request(3, 'tasks/get', { taskId: 'x' }), envelope('tasks/get', 3));
		await f.handle.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }), envelope('notifications/roots/list_changed', undefined));

		assert.deepStrictEqual({ calls: f.channel.calls.length, messages: f.messages, aborts: f.aborts.map(a => [a.requestId, a.reason]) }, {
			calls: 0,
			messages: [
				{
					jsonrpc: '2.0', id: 1, result: {
						supportedVersions: [MODERN],
						capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
						ttlMs: 0,
						cacheScope: 'private',
						resultType: 'complete',
						_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'typed.example:50051', version: '' } },
					}
				},
				{ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'subscriptions/listen is not available on the typed gRPC binding', data: { vscodeTransportError: 'unsupported' } } },
			],
			aborts: [[3, 'unexpressible']],
		});
	});

	test('typed binding: params the messages cannot carry abort with unexpressible before a call', async () => {
		const f = createFixture(store, () => assert.fail('no call expected'), { launch: { binding: 'typed' } });
		await f.handle.send(request(1, 'tools/list', { cursor: 'page-2' }), envelope('tools/list', 1));
		assert.deepStrictEqual({
			calls: f.channel.calls.length,
			aborts: f.aborts.map(a => [a.requestId, a.reason]),
			warned: f.logs.some(l => l.level === LogLevel.Warning && /cannot send tools\/list/.test(l.message)),
		}, { calls: 0, aborts: [[1, 'unexpressible']], warned: true });
	});

	test('auto: a bare UNIMPLEMENTED on the tunnel switches to the typed binding for this and later requests', async () => {
		const listTools = typedRpcForMethod('tools/list')!;
		const f = createFixture(store, call => {
			if (call.path === TUNNEL_CALL_PATH) {
				call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'unknown service mcp.zig.transport.v1.Mcp');
			} else {
				call.push(encodeTypedResponse(listTools, { resultType: 'complete', tools: [{ name: 'echo', inputSchema: { type: 'object' } }], ttlMs: 0, cacheScope: 'private' }));
				call.finish();
			}
		});
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));

		assert.deepStrictEqual({
			paths: f.channel.calls.map(c => c.path),
			binding: f.handle.binding,
			discover: (f.messages[0].result as JsonObject).supportedVersions,
			tools: ((f.messages[1].result as JsonObject).tools as JsonObject[]).map(t => t.name),
			aborts: f.aborts,
		}, {
			paths: [TUNNEL_CALL_PATH, '/model_context_protocol.Mcp/ListTools'],
			binding: 'typed',
			discover: [MODERN],
			tools: ['echo'],
			aborts: [],
		});
	});

	test('auto: a tunnel -32601 with mcp-error-code is an ordinary error and keeps the tunnel', async () => {
		const f = createFixture(store, (call, index) => {
			if (index === 0) {
				call.finish(GrpcStatus.UNIMPLEMENTED, { 'mcp-error-code': '-32601' }, 'Method not found: resources/subscribe');
			} else {
				call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'later');
			}
		});
		await f.handle.send(request(1, 'resources/subscribe', { uri: 'a' }), envelope('resources/subscribe', 1));
		await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
		assert.deepStrictEqual({
			paths: f.channel.calls.map(c => c.path),
			binding: f.handle.binding,
			messages: f.messages,
			aborts: f.aborts.map(a => [a.requestId, a.reason, a.grpcStatus]),
		}, {
			paths: [TUNNEL_CALL_PATH, TUNNEL_CALL_PATH],
			binding: 'tunnel',
			messages: [{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: resources/subscribe' } }],
			aborts: [[2, 'grpc-status', GrpcStatus.UNIMPLEMENTED]],
		});
	});

	test('binding tunnel: a bare UNIMPLEMENTED is an abort, not a fallback', async () => {
		const f = createFixture(store, call => call.finish(GrpcStatus.UNIMPLEMENTED), { launch: { binding: 'tunnel' } });
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		assert.deepStrictEqual({ calls: f.channel.calls.length, aborts: f.aborts.map(a => [a.reason, a.grpcStatus]) }, { calls: 1, aborts: [['grpc-status', GrpcStatus.UNIMPLEMENTED]] });
	});

	test('auth: UNAUTHENTICATED discovers the metadata of the HTTPS identity and retries with a bearer token', async () => {
		const fetched: string[] = [];
		const prmUrl = 'https://auth.example/.well-known/oauth-protected-resource/mcp';
		const f = createFixture(store, (call, index) => {
			if (index === 0) {
				call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': `Bearer resource_metadata="${prmUrl}"` }, 'missing token');
			} else {
				respondTunnel(call, { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [] } });
			}
		}, {
			launch: { uri: URI.parse('grpc://127.0.0.1:50051') },
			token: () => 'token-1',
			options: {
				fetchMetadata: async url => {
					fetched.push(url);
					if (url === prmUrl) {
						return jsonResponse(url, 200, { resource: 'https://127.0.0.1:50051/', authorization_servers: ['https://auth.example'] });
					}
					if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
						return jsonResponse(url, 200, {
							issuer: 'https://auth.example',
							authorization_endpoint: 'https://auth.example/authorize',
							token_endpoint: 'https://auth.example/token',
							response_types_supported: ['code'],
							code_challenge_methods_supported: ['S256'],
						});
					}
					return jsonResponse(url, 404);
				},
			},
		});
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));

		assert.deepStrictEqual({
			fetchedPrm: fetched.includes(prmUrl),
			authorizationServer: URI.revive(f.tokenRequests[0]?.details.authorizationServer).toString(true),
			first: f.channel.calls[0].metadata.authorization,
			second: f.channel.calls[1].metadata.Authorization ?? f.channel.calls[1].metadata.authorization,
			messages: f.messages.length,
			aborts: f.aborts,
		}, {
			fetchedPrm: true,
			authorizationServer: 'https://auth.example/',
			first: undefined,
			second: 'Bearer token-1',
			messages: 1,
			aborts: [],
		});
	});

	test('a bearer token over cleartext grpc:// to another host is warned about once; loopback is not', async () => {
		assert.deepStrictEqual(['localhost', '127.0.0.1', '127.1.2.3', '::1', 'a.localhost', 'mcp.example', '10.0.0.1'].map(isLoopbackHost), [true, true, true, true, true, false, false]);
		let calls = 0;
		const f = createFixture(store, (call, index) => {
			calls++;
			if (index === 0) {
				call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': 'Bearer' });
			} else {
				respondTunnel(call, { jsonrpc: '2.0', id: index === 1 ? 1 : 2, result: { resultType: 'complete', tools: [] } });
			}
		}, {
			launch: { uri: URI.parse('grpc://mcp.example:50051') },
			token: () => 'token-2',
			options: { fetchMetadata: async url => jsonResponse(url, 404) },
		});
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
		const warnings = f.logs.filter(l => l.level === LogLevel.Warning && /cleartext/.test(l.message));
		assert.deepStrictEqual({ calls, warnings: warnings.length, token: f.channel.calls[2].metadata.Authorization ?? f.channel.calls[2].metadata.authorization }, { calls: 3, warnings: 1, token: 'Bearer token-2' });
	});

	test('a destination the policy denies stops the handle in the Error state', async () => {
		const f = createFixture(store, () => assert.fail('no call expected'), { allowed: () => 'blocked by policy' });
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		assert.deepStrictEqual({ calls: f.channel.calls.length, states: f.states }, {
			calls: 0,
			states: [{ state: McpConnectionState.Kind.Running }, { state: McpConnectionState.Kind.Error, message: 'blocked by policy' }],
		});
	});

	test('channel options: TLS for grpcs://, keepalive, and the system roots plus tls.ca', async () => {
		const f = createFixture(store, call => respondTunnel(call, { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [] } }), {
			launch: { uri: URI.parse('grpcs://user@secure.example:443'), keepAliveMs: 300_000, tls: { ca: '/certs/ca.pem', serverName: 'override.example' } },
			options: { readCaFile: async path => `PEM(${path})` },
		});
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		const options = f.channelOptions();
		assert.deepStrictEqual({ authority: options?.authority, secure: options?.secure, keepAlive: options?.keepAliveTimeMs, hasConnection: typeof options?.createConnection }, {
			authority: 'secure.example:443',
			secure: true,
			keepAlive: 300_000,
			hasConnection: 'function',
		});
	});

	test('the default proxy lookup reads the functions proxyResolver.ts puts on @vscode/proxy-agent', async () => {
		const agentModule = proxyAgent as unknown as { default?: Record<string, unknown> } & Record<string, unknown>;
		const target = agentModule.default ?? agentModule;
		const saved = { resolveProxyURL: target.resolveProxyURL, lookupProxyAuthorization: target.lookupProxyAuthorization };
		try {
			target.resolveProxyURL = async (url: string) => `http://proxy.example:3128/?for=${url}`;
			target.lookupProxyAuthorization = async () => 'Basic abc';
			const lookup = await extensionHostProxyLookup();
			assert.deepStrictEqual([
				await lookup.resolveProxyURL?.('https://mcp.example:443/'),
				await lookup.lookupProxyAuthorization?.('http://proxy.example:3128/', undefined, {}),
			], ['http://proxy.example:3128/?for=https://mcp.example:443/', 'Basic abc']);
		} finally {
			target.resolveProxyURL = saved.resolveProxyURL;
			target.lookupProxyAuthorization = saved.lookupProxyAuthorization;
		}
	});

	test('close cancels the open calls and reports Stopped', async () => {
		const f = createFixture(store, () => { /* never answers */ });
		const sending = f.handle.send(request(1, 'subscriptions/listen', { notifications: {} }), envelope('subscriptions/listen', 1, { kind: 'listen' }));
		await waitFor(() => f.channel.calls.length === 1, 'the listen call');
		await f.handle.close();
		await sending;
		assert.deepStrictEqual({ cancelled: f.channel.calls[0].cancelled, aborts: f.aborts, last: f.states.at(-1) }, { cancelled: true, aborts: [], last: { state: McpConnectionState.Kind.Stopped } });
	});
});

//#region Loopback HTTP/2

type StreamHandler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, request: JsonObject | undefined) => void;

function readRequest(stream: http2.ServerHttp2Stream): Promise<Uint8Array[]> {
	return new Promise((resolve, reject) => {
		const reader = new LengthPrefixedMessageReader(16 * 1024 * 1024);
		const messages: Uint8Array[] = [];
		stream.on('data', (chunk: Buffer) => {
			try {
				messages.push(...reader.feed(chunk));
			} catch (error) {
				reject(error);
			}
		});
		stream.on('end', () => resolve(messages));
	});
}

function respondGrpc(stream: http2.ServerHttp2Stream, messages: unknown[], trailerHeaders: http2.OutgoingHttpHeaders = {}): void {
	stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
	stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', ...trailerHeaders }));
	for (const message of messages) {
		stream.write(encodeLengthPrefixedMessage(tunnelPayload(message)));
	}
	stream.end();
}

interface ILoopbackServer {
	readonly port: number;
	readonly requests: http2.IncomingHttpHeaders[];
	handler: StreamHandler;
	close(): Promise<void>;
}

async function startServer(secure?: ISelfSignedCert): Promise<ILoopbackServer> {
	const sessions: http2.ServerHttp2Session[] = [];
	const requests: http2.IncomingHttpHeaders[] = [];
	const server = secure ? http2.createSecureServer({ key: secure.key, cert: secure.cert }) : http2.createServer();
	const result: ILoopbackServer = {
		port: 0,
		requests,
		handler: (stream, _headers, request) => respondGrpc(stream, [{ jsonrpc: '2.0', id: request?.id, result: { resultType: 'complete', tools: [] } }]),
		close: async () => {
			for (const session of sessions) {
				session.destroy();
			}
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
	server.on('session', session => sessions.push(session));
	server.on('stream', async (stream, headers) => {
		stream.on('error', () => { });
		requests.push(headers);
		const [payload] = await readRequest(stream);
		result.handler(stream, headers, payload ? tunnelRequest(payload) : undefined);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	return Object.assign(result, { port: address.port });
}

//#endregion

suite('McpGrpcHandle over loopback HTTP/2', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let cert: ISelfSignedCert;
	let tempDir: string;
	let caFile: string;
	const toClose: (() => Promise<void> | void)[] = [];

	suiteSetup(async () => {
		cert = await generateSelfSignedCert();
		tempDir = fs.mkdtempSync(join(os.tmpdir(), 'vscode-mcp-grpc-'));
		caFile = join(tempDir, 'ca.pem');
		fs.writeFileSync(caFile, cert.cert);
	});

	suiteTeardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	teardown(async () => {
		while (toClose.length) {
			await toClose.pop()!();
		}
	});

	function createRealHandle(launch: Partial<McpServerTransportGrpc>, proxyLookup: IGrpcProxyLookup = {}) {
		const messages: JsonObject[] = [];
		const aborts: IMcpRequestAbort[] = [];
		const proxy = new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(): void { }
			override $onDidReceiveMessage(_id: number, message: string): void { messages.push(JSON.parse(message)); }
			override $onDidAbortRequest(_id: number, abort: IMcpRequestAbort): void { aborts.push(abort); }
			override $onDidPublishLog(): void { }
			override async $checkMcpServerAllowed(): Promise<string | undefined> { return undefined; }
		};
		const handle = store.add(new McpGrpcHandle(1, launchOf(launch), proxy, new NullLogService(), false, { proxyLookup: async () => proxyLookup }));
		return { handle, messages, aborts };
	}

	test('grpc-timeout on the wire: none on tools/call, 1M on server/discover, 30S with deadlineMs 30000', async () => {
		const server = await startServer();
		toClose.push(() => server.close());
		const plain = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${server.port}`) });
		await plain.handle.send(request(1, 'tools/call', { name: 't' }), envelope('tools/call', 1));
		await plain.handle.send(request(2, 'server/discover'), envelope('server/discover', 2));
		const configured = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${server.port}`), deadlineMs: 30_000 });
		await configured.handle.send(request(3, 'tools/call', { name: 't' }), envelope('tools/call', 3));

		assert.deepStrictEqual({
			timeouts: server.requests.map(h => h['grpc-timeout']),
			paths: server.requests.map(h => h[':path']),
			te: server.requests.map(h => h.te),
			delivered: [...plain.messages, ...configured.messages].map(m => m.id),
		}, {
			timeouts: [undefined, '1M', '30S'],
			paths: [TUNNEL_CALL_PATH, TUNNEL_CALL_PATH, TUNNEL_CALL_PATH],
			te: ['trailers', 'trailers', 'trailers'],
			delivered: [1, 2, 3],
		});
	});

	test('a -32020 in the trailers arrives as a JSON-RPC error from a real stream', async () => {
		const server = await startServer();
		toClose.push(() => server.close());
		server.handler = stream => {
			const error = { code: -32020, message: 'Header mismatch: Mcp-Name header value \'x\' does not match body value \'y\'' };
			stream.respond({
				':status': 200,
				'content-type': 'application/grpc',
				'grpc-status': String(GrpcStatus.INVALID_ARGUMENT),
				'grpc-message': 'Header mismatch',
				'mcp-error-code': '-32020',
				'mcp-error-bin': errorBin(error, 1),
			}, { endStream: true });
		};
		const { handle, messages, aborts } = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${server.port}`) });
		await handle.send(request(1, 'tools/call', { name: 'y' }), envelope('tools/call', 1, { headers: { 'Mcp-Name': 'x' } }));
		assert.deepStrictEqual({ messages, aborts, sentName: server.requests[0]['mcp-name'] }, {
			messages: [{ jsonrpc: '2.0', id: 1, error: { code: -32020, message: 'Header mismatch: Mcp-Name header value \'x\' does not match body value \'y\'' } }],
			aborts: [],
			sentName: 'x',
		});
	});

	test('TLS: grpcs:// verifies the server with tls.ca and negotiates ALPN h2', async () => {
		const server = await startServer(cert);
		toClose.push(() => server.close());
		const { handle, messages, aborts } = createRealHandle({ uri: URI.parse(`grpcs://127.0.0.1:${server.port}`), tls: { ca: caFile } });
		await handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		assert.deepStrictEqual({ ids: messages.map(m => m.id), aborts, scheme: server.requests[0][':scheme'] }, { ids: [1], aborts: [], scheme: 'https' });
	});

	test('TLS: an untrusted certificate fails the call as UNAVAILABLE; tls.insecure accepts it', async () => {
		const server = await startServer(cert);
		toClose.push(() => server.close());
		const untrusted = createRealHandle({ uri: URI.parse(`grpcs://127.0.0.1:${server.port}`) });
		await untrusted.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		const insecure = createRealHandle({ uri: URI.parse(`grpcs://127.0.0.1:${server.port}`), tls: { insecure: true } });
		await insecure.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));

		assert.strictEqual(untrusted.messages.length, 0);
		assert.deepStrictEqual(untrusted.aborts.map(a => [a.reason, a.grpcStatus]), [['grpc-status', GrpcStatus.UNAVAILABLE]]);
		assert.match(untrusted.aborts[0].message ?? '', /certificate/i);
		assert.deepStrictEqual({ ids: insecure.messages.map(m => m.id), aborts: insecure.aborts, requests: server.requests.length }, { ids: [2], aborts: [], requests: 1 });
	});

	test('proxy: tunnels through an HTTP CONNECT proxy and answers its authentication challenge', async () => {
		const server = await startServer();
		toClose.push(() => server.close());
		const connects: string[] = [];
		const sockets: net.Socket[] = [];
		const proxyServer = net.createServer(client => {
			sockets.push(client);
			client.on('error', () => { });
			let buffered = Buffer.alloc(0);
			const onData = (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk]);
				const end = buffered.indexOf('\r\n\r\n');
				if (end === -1) {
					return;
				}
				client.removeListener('data', onData);
				const head = buffered.subarray(0, end).toString('latin1');
				const rest = buffered.subarray(end + 4);
				connects.push(head.split('\r\n')[0] + (/proxy-authorization: basic dxnlcjpwyxnz/i.test(head) ? ' (authorized)' : ''));
				if (!/proxy-authorization: Basic dXNlcjpwYXNz/i.test(head)) {
					client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
					return;
				}
				const target = /^CONNECT ([^\s]+) /.exec(head)![1];
				const colon = target.lastIndexOf(':');
				const upstream = net.connect(Number(target.slice(colon + 1)), target.slice(0, colon), () => {
					client.write('HTTP/1.1 200 Connection established\r\n\r\n');
					if (rest.length) {
						upstream.write(rest);
					}
					client.pipe(upstream);
					upstream.pipe(client);
				});
				sockets.push(upstream);
				upstream.on('error', () => client.destroy());
			};
			client.on('data', onData);
		});
		await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
		toClose.push(() => {
			for (const socket of sockets) {
				socket.destroy();
			}
			return new Promise<void>(resolve => proxyServer.close(() => resolve()));
		});
		const proxyAddress = proxyServer.address();
		assert.ok(proxyAddress && typeof proxyAddress === 'object');

		const lookups: (string | string[] | undefined)[] = [];
		const { handle, messages, aborts } = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${server.port}`) }, {
			resolveProxyURL: async () => `http://127.0.0.1:${proxyAddress.port}`,
			lookupProxyAuthorization: async (_url, challenge) => {
				lookups.push(challenge);
				return challenge ? 'Basic dXNlcjpwYXNz' : undefined;
			},
		});
		await handle.send(request(1, 'tools/list'), envelope('tools/list', 1));

		assert.deepStrictEqual({ connects, lookups, ids: messages.map(m => m.id), aborts }, {
			connects: [`CONNECT 127.0.0.1:${server.port} HTTP/1.1`, `CONNECT 127.0.0.1:${server.port} HTTP/1.1 (authorized)`],
			lookups: [undefined, 'Basic realm="test"'],
			ids: [1],
			aborts: [],
		});
	});
});

suite('McpGrpcHandle under the protocol engine', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const discoverResult = { resultType: 'complete', supportedVersions: [MODERN], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' };

	async function connectEngine(respond: (call: FakeCall, request: JsonObject) => void): Promise<McpServerRequestHandler> {
		const channel = new FakeChannel(call => respond(call, call.json));
		const transport = store.add(new GrpcTestTransport(launchOf({ binding: 'tunnel' }), { createChannel: () => channel }));
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		const instantiationService = store.add(new InstantiationService(new ServiceCollection([IProductService, productService]), true));
		return store.add(await McpServerRequestHandler.create(instantiationService, {
			launch: transport,
			logger: new NullLogger(),
			taskManager: store.add(new McpTaskManager()),
			transportType: McpServerTransportType.Grpc,
		}));
	}

	test('a status-only failure with a JSON-RPC equivalent rejects with MpcResponseError, a transport status with request-aborted', async () => {
		const handler = await connectEngine((call, req) => {
			if (req.method === 'server/discover') {
				return respondTunnel(call, { jsonrpc: '2.0', id: req.id, result: discoverResult });
			}
			switch ((req.params as JsonObject).name) {
				case 'invalid': return call.finish(GrpcStatus.INVALID_ARGUMENT, {}, 'bad arguments');
				case 'missing': return call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'no such method');
				default: return call.finish(GrpcStatus.UNAVAILABLE, {}, 'connection lost');
			}
		});
		assert.strictEqual(handler.negotiated.protocolVersion, MODERN);
		const outcomes: unknown[] = [];
		for (const name of ['invalid', 'missing', 'unavailable']) {
			try {
				await handler.callTool({ name, arguments: {} });
				outcomes.push('resolved');
			} catch (e) {
				outcomes.push(e instanceof MpcResponseError ? { code: e.code, data: e.data } : e instanceof McpClientError ? { reason: e.reason, grpcStatus: (e.detail as IMcpRequestAbort).grpcStatus } : String(e));
			}
		}
		assert.deepStrictEqual(outcomes, [
			{ code: -32602, data: { grpcStatus: GrpcStatus.INVALID_ARGUMENT } },
			{ code: -32601, data: { grpcStatus: GrpcStatus.UNIMPLEMENTED } },
			{ reason: 'request-aborted', grpcStatus: GrpcStatus.UNAVAILABLE },
		]);
	});
});
