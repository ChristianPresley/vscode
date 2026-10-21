/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as proxyAgent from '@vscode/proxy-agent';
import assert from 'assert';
import * as fs from 'fs';
import * as http2 from 'http2';
import { createRequire } from 'module'; // not 'node:module': the Electron unit-test renderer maps built-ins by their unprefixed names
import * as net from 'net';
import * as os from 'os';
import * as tls from 'tls';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { encodeLengthPrefixedMessage, LengthPrefixedMessageReader } from '../../../../base/common/grpc/lpm.js';
import { encodeBinaryMetadata, GrpcStatus, grpcStatusForHttpStatus } from '../../../../base/common/grpc/status.js';
import { observableValue } from '../../../../base/common/observable.js';
import { join } from '../../../../base/common/path.js';
import { decodeMessage, encodeMessage } from '../../../../base/common/protobuf/codec.js';
import { jsonToStruct } from '../../../../base/common/protobuf/wellKnown.js';
import { decodeUtf8, encodeUtf8 } from '../../../../base/common/protobuf/wire.js';
import { URI } from '../../../../base/common/uri.js';
import { IGrpcCall, IGrpcCallOptions, IGrpcChannelOptions, IGrpcResponseHeaders, IGrpcTrailers } from '../../../../base/node/grpcChannel.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, LogLevel, NullLogger, NullLogService } from '../../../../platform/log/common/log.js';
import { JSON_RPC_MESSAGE, TUNNEL_CALL_PATH, typedRpcForMethod } from '../../../../platform/mcp/common/mcpGrpcProto.js';
import { decodeTypedRequest, encodeTypedResponse } from '../../../../platform/mcp/common/mcpGrpcTyped.js';
import product from '../../../../platform/product/common/product.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { generateSelfSignedCert, ISelfSignedCert } from '../../../../platform/tunnel/node/selfSignedCert.js';
import { IMcpHostDelegate } from '../../../contrib/mcp/common/mcpRegistryTypes.js';
import { McpServerConnection } from '../../../contrib/mcp/common/mcpServerConnection.js';
import { McpServerRequestHandler } from '../../../contrib/mcp/common/mcpServerRequestHandler.js';
import { McpTaskManager } from '../../../contrib/mcp/common/mcpTaskManager.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpClientError, McpCollectionDefinition, McpConnectionState, McpServerDefinition, McpServerLaunch, McpServerTransportGrpc, McpServerTransportType, McpServerTrust, MpcResponseError } from '../../../contrib/mcp/common/mcpTypes.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { IMcpAuthenticationDetails, IMcpAuthenticationOptions, MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { CommonResponse, ExtHostMcpService } from '../../common/extHostMcp.js';
import { McpGrpcBinding, McpGrpcServerDefinition, McpHttpServerDefinition } from '../../common/extHostTypes.js';
import { IExtHostVariableResolverProvider } from '../../common/extHostVariableResolverService.js';
import { IExtHostWorkspace } from '../../common/extHostWorkspace.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';
import { createGrpcConnectionFactory, DEFAULT_GRPC_DEADLINE_MS, DEFAULT_GRPC_LISTEN_KEEPALIVE_MS, extensionHostProxyLookup, grpcDeadlineFor, grpcKeepAliveFor, IGrpcConnectionFactoryOptions, IGrpcProxyLookup, IMcpGrpcChannel, IMcpGrpcHandleOptions, isLoopbackHost, mapGrpcTrailersToJsonRpc, MAX_GRPC_TIMER_MS, McpGrpcHandle, MIN_GRPC_KEEPALIVE_MS } from '../../node/extHostMcpGrpc.js';
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

	/** Ends the call as a gRPC server does: HTTP 200 and its own `grpc-status`. */
	finish(status: GrpcStatus = GrpcStatus.OK, raw: Record<string, string> = {}, message?: string): void {
		const trailers: IGrpcTrailers = { status, raw: { 'grpc-status': String(status), ...raw }, httpStatus: 200 };
		this._end(message === undefined ? trailers : { ...trailers, message });
	}

	/** Ends the call as the channel reports a non-gRPC HTTP response: the status mapped from the HTTP status. */
	finishHttp(httpStatus: number, headers: Record<string, string> = {}): void {
		this._end({ status: grpcStatusForHttpStatus(httpStatus), message: `HTTP status ${httpStatus}`, raw: headers, httpStatus });
	}

	/** Ends the call as the channel reports a transport failure: a synthesized status and no HTTP response. */
	failTransport(status: GrpcStatus, message: string): void {
		this._end({ status, message, raw: {} });
	}

	private _end(trailers: IGrpcTrailers): void {
		if (this._ended) {
			return;
		}
		this._ended = trailers;
		this._trailers.complete(this._ended);
		this._wake();
	}

	cancel(): void {
		if (!this._ended) {
			this.cancelled = true;
			this._end({ status: GrpcStatus.CANCELLED, raw: {}, message: 'call cancelled' });
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
	readonly logService?: ILogService;
}

/** A log service at trace level: the handle logs its calls. */
class TraceLogService extends NullLogService {
	override getLevel(): LogLevel {
		return LogLevel.Trace;
	}
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
	const handle = store.add(new McpGrpcHandle(1, launchOf(setup.launch), proxy, setup.logService ?? new NullLogService(), false, {
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

/** The fix the error of a connection to a gRPC server without the JSON-RPC tunnel names, for a configuration and for an extension's definition. */
const NO_TUNNEL_FIX = `If it only offers Google's typed MCP service, set "binding": "typed" in its configuration, or, if an extension provides the server, ask its author to use McpGrpcBinding.Typed.`;

/**
 * The error of a connection to a gRPC server that does not serve the JSON-RPC
 * tunnel (English, as tests run without translations): with the server's
 * `grpc-message`, when it sent one, in place of the claim that the tunnel is missing.
 */
function noTunnelMessage(authority: string, serverMessage?: string): string {
	return serverMessage
		? `The gRPC server at ${authority} answered a call to the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp) with UNIMPLEMENTED: "${serverMessage}". ${NO_TUNNEL_FIX}`
		: `The gRPC server at ${authority} does not implement the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp). ${NO_TUNNEL_FIX}`;
}

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

function redirectResponse(url: string, status: number, location: string): CommonResponse {
	return { status, statusText: String(status), url, headers: new Headers({ location }), body: null, json: async () => ({}), text: async () => '' };
}

/** A metadata request that never answers: it rejects with the reason of its signal once that aborts. */
function hangUntilAborted(signal: AbortSignal, signals: AbortSignal[]): Promise<CommonResponse> {
	signals.push(signal);
	return new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
		} else {
			signal.addEventListener('abort', () => reject(signal.reason), { once: true });
		}
	});
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

	test('typed-only servers: server/discover is synthesized (named after the authority when ListTools tells no serverInfo) and subscriptions/listen answered with -32601', async () => {
		const f = createFixture(store, call => {
			assert.strictEqual(call.path, '/model_context_protocol.Mcp/ListTools', 'only the serverInfo probe of the discover makes a call');
			call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'no tools here');
		}, { launch: { binding: 'typed', uri: URI.parse('grpc://typed.example:50051') } });
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		await f.handle.send(request(2, 'subscriptions/listen', { notifications: {} }), envelope('subscriptions/listen', 2, { kind: 'listen' }));
		await f.handle.send(request(3, 'tasks/get', { taskId: 'x' }), envelope('tasks/get', 3));
		await f.handle.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }), envelope('notifications/roots/list_changed', undefined));

		assert.deepStrictEqual({
			calls: f.channel.calls.length,
			messages: f.messages,
			aborts: f.aborts.map(a => [a.requestId, a.reason]),
			// A client notification has no typed RPC: it is dropped (no call, no abort) with a Debug line.
			dropped: f.logs.filter(l => /notification/.test(l.message)).map(l => [l.level, l.message]),
		}, {
			calls: 1,
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
			dropped: [[LogLevel.Debug, 'The typed gRPC binding has no RPC for the notification notifications/roots/list_changed; dropping it']],
		});
	});

	test('typed-only servers: the synthesized server/discover takes serverInfo and instructions from the first ListTools response, once per connection', async () => {
		const listTools = typedRpcForMethod('tools/list')!;
		const serverInfo = { name: 'mcp-conformance-test-server', version: '0.1.0', title: 'Conformance' };
		const f = createFixture(store, call => {
			call.push(encodeMessage(listTools.response, {
				common: { instructions: 'Call echo to repeat text.', metadata: jsonToStruct({ 'io.modelcontextprotocol/serverInfo': serverInfo }) },
				tools: [{ name: 'echo', input_schema: jsonToStruct({ type: 'object' }) }],
			}));
			call.finish();
		}, { launch: { binding: 'typed', uri: URI.parse('grpc://127.0.0.1:50052') } });
		const discoverMeta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'vscode', version: '1' } };
		await f.handle.send(request(1, 'server/discover', { _meta: discoverMeta }), envelope('server/discover', 1, { headers: { 'Mcp-Method': 'server/discover' } }));
		await f.handle.send(request(2, 'server/discover', { _meta: discoverMeta }), envelope('server/discover', 2, { headers: { 'Mcp-Method': 'server/discover' } }));

		const [probe] = f.channel.calls;
		assert.deepStrictEqual({
			calls: f.channel.calls.map(c => c.path),
			metadata: probe.metadata,
			probeParams: decodeTypedRequest(listTools, probe.request),
			deadlineMs: probe.options?.deadlineMs,
			results: f.messages.map(m => {
				const result = m.result as JsonObject;
				return { id: m.id, serverInfo: (result._meta as JsonObject)['io.modelcontextprotocol/serverInfo'], instructions: result.instructions };
			}),
			aborts: f.aborts,
		}, {
			calls: ['/model_context_protocol.Mcp/ListTools'],
			metadata: { 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
			probeParams: { _meta: discoverMeta },
			deadlineMs: DEFAULT_GRPC_DEADLINE_MS,
			results: [
				{ id: 1, serverInfo, instructions: 'Call echo to repeat text.' },
				{ id: 2, serverInfo, instructions: 'Call echo to repeat text.' },
			],
			aborts: [],
		});
	});

	test('typed-only servers: a ListTools response without serverInfo names the server after its authority', async () => {
		const listTools = typedRpcForMethod('tools/list')!;
		const f = createFixture(store, call => {
			call.push(encodeTypedResponse(listTools, { resultType: 'complete', tools: [], ttlMs: 0, cacheScope: 'private' }));
			call.finish();
		}, { launch: { binding: 'typed', uri: URI.parse('grpc://127.0.0.1:50052') } });
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		const result = f.messages[0].result as JsonObject;
		assert.deepStrictEqual({ serverInfo: (result._meta as JsonObject)['io.modelcontextprotocol/serverInfo'], instructions: result.instructions, logged: f.logs.some(l => /carries no serverInfo/.test(l.message)) }, {
			serverInfo: { name: '127.0.0.1:50052', version: '' },
			instructions: undefined,
			logged: true,
		});
	});

	test('typed-only servers: cancelling the discover cancels its serverInfo probe and delivers nothing', async () => {
		const f = createFixture(store, () => { /* never answers */ }, { launch: { binding: 'typed' } });
		const sending = f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		await waitFor(() => f.channel.calls.length === 1, 'the probe');
		f.handle.cancelRequest(1);
		await sending;
		assert.deepStrictEqual({ cancelled: f.channel.calls[0].cancelled, messages: f.messages, aborts: f.aborts }, { cancelled: true, messages: [], aborts: [] });
	});

	test('typed-only servers: a serverInfo probe that meets a declined sign-in fails the discover; after a sign-in the next discover probes again', async () => {
		const listTools = typedRpcForMethod('tools/list')!;
		const serverInfo = { name: 'typed-server', version: '1.0.0' };
		let signedIn = false;
		const f = createFixture(store, call => {
			if ((call.metadata.Authorization ?? call.metadata.authorization) === 'Bearer token-1') {
				call.push(encodeMessage(listTools.response, { common: { metadata: jsonToStruct({ 'io.modelcontextprotocol/serverInfo': serverInfo }) }, tools: [] }));
				call.finish();
			} else {
				call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': 'Bearer' }, 'sign in first');
			}
		}, {
			launch: { binding: 'typed', uri: URI.parse('grpc://127.0.0.1:50052') },
			token: () => signedIn ? 'token-1' : undefined,
			options: { fetchMetadata: async url => jsonResponse(url, 404) },
		});
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		const declined = { messages: [...f.messages], aborts: [...f.aborts] };
		signedIn = true;
		await f.handle.send(request(2, 'server/discover'), envelope('server/discover', 2));

		assert.deepStrictEqual({
			declined,
			signedIn: f.messages.map(m => ({ id: m.id, serverInfo: ((m.result as JsonObject)._meta as JsonObject)['io.modelcontextprotocol/serverInfo'] })),
			aborts: f.aborts.length,
			states: f.states.map(s => s.state),
		}, {
			declined: { messages: [], aborts: [{ requestId: 1, reason: 'grpc-status', grpcStatus: GrpcStatus.UNAUTHENTICATED, message: 'UNAUTHENTICATED: sign in first' }] },
			signedIn: [{ id: 2, serverInfo }],
			aborts: 1,
			states: [McpConnectionState.Kind.Running],
		});
	});

	test('typed-only servers: a serverInfo probe that cannot reach the server, or gets an HTTP answer, fails the discover', async () => {
		const unreachable = createFixture(store, call => call.failTransport(GrpcStatus.UNAVAILABLE, 'connection failed: connect ECONNREFUSED 127.0.0.1:50052'), { launch: { binding: 'typed' } });
		await unreachable.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		const timedOut = createFixture(store, call => call.failTransport(GrpcStatus.DEADLINE_EXCEEDED, 'deadline of 1M exceeded'), { launch: { binding: 'typed' } });
		await timedOut.handle.send(request(2, 'server/discover'), envelope('server/discover', 2));
		const web = createFixture(store, call => call.finishHttp(502), { launch: { binding: 'typed' } });
		await web.handle.send(request(3, 'server/discover'), envelope('server/discover', 3));

		assert.deepStrictEqual({
			messages: [...unreachable.messages, ...timedOut.messages, ...web.messages],
			aborts: [...unreachable.aborts, ...timedOut.aborts, ...web.aborts],
		}, {
			messages: [],
			aborts: [
				{ requestId: 1, reason: 'grpc-status', grpcStatus: GrpcStatus.UNAVAILABLE, message: 'UNAVAILABLE: connection failed: connect ECONNREFUSED 127.0.0.1:50052' },
				{ requestId: 2, reason: 'grpc-status', grpcStatus: GrpcStatus.DEADLINE_EXCEEDED, message: 'DEADLINE_EXCEEDED: deadline of 1M exceeded' },
				{ requestId: 3, reason: 'http-status', httpStatus: 502, grpcStatus: GrpcStatus.UNAVAILABLE, message: 'HTTP status 502 instead of a gRPC response (UNAVAILABLE)' },
			],
		});
	});

	test('keepAliveMs: 0 is off, below 300000 is raised to it, beyond a timer is cut, unset or invalid keeps listen streams alive; a deadlineMs that is not positive is ignored; a warning each', async () => {
		const listenDefault = { longLivedKeepAliveTimeMs: DEFAULT_GRPC_LISTEN_KEEPALIVE_MS };
		assert.deepStrictEqual(
			[undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1, 30_000, MIN_GRPC_KEEPALIVE_MS, 600_000, 2 ** 31].map(grpcKeepAliveFor),
			[listenDefault, {}, listenDefault, listenDefault, listenDefault, { keepAliveTimeMs: 300_000 }, { keepAliveTimeMs: 300_000 }, { keepAliveTimeMs: 300_000 }, { keepAliveTimeMs: 600_000 }, { keepAliveTimeMs: MAX_GRPC_TIMER_MS }],
		);
		assert.deepStrictEqual([DEFAULT_GRPC_LISTEN_KEEPALIVE_MS, MAX_GRPC_TIMER_MS], [310_000, 2 ** 31 - 1]);
		assert.deepStrictEqual(
			[0, -5, Number.NaN, 5_000].map(configured => [grpcDeadlineFor('tools/call', 'request', { name: 't' }, configured), grpcDeadlineFor('tools/list', 'request', {}, configured)]),
			[[undefined, 60_000], [undefined, 60_000], [undefined, 60_000], [5_000, 5_000]],
		);
		const respond = (call: FakeCall) => respondTunnel(call, { jsonrpc: '2.0', id: call.json.id, result: { resultType: 'complete', content: [], tools: [] } });
		const outcomes: unknown[] = [];
		for (const launch of [{ keepAliveMs: 30_000, deadlineMs: 0 }, { keepAliveMs: 0, deadlineMs: -1 }, { keepAliveMs: -1 }, { keepAliveMs: 2 ** 31 }, { keepAliveMs: 600_000, deadlineMs: 5_000 }]) {
			const f = createFixture(store, respond, { launch });
			await f.handle.send(request(1, 'tools/call', { name: 't' }), envelope('tools/call', 1));
			await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
			outcomes.push({
				keepAlive: [f.channelOptions()?.keepAliveTimeMs, f.channelOptions()?.longLivedKeepAliveTimeMs],
				deadlines: f.channel.calls.map(c => c.options?.deadlineMs),
				warnings: f.logs.filter(l => l.level === LogLevel.Warning).map(l => l.message),
				userAgent: f.channelOptions()?.userAgent,
			});
		}
		const userAgent = `grpc-node-vscode/${product.version} (${product.nameLong})`;
		assert.deepStrictEqual(outcomes, [
			{
				keepAlive: [300_000, undefined],
				deadlines: [undefined, 60_000],
				warnings: [
					'deadlineMs 0 is not a positive number of milliseconds; it is ignored',
					'keepAliveMs 30000 is below the 300000 ms that gRPC servers allow by default; a keepalive ping is sent every 300000 ms instead',
				],
				userAgent,
			},
			{
				keepAlive: [undefined, undefined],
				deadlines: [undefined, 60_000],
				warnings: ['deadlineMs -1 is not a positive number of milliseconds; it is ignored'],
				userAgent,
			},
			{
				keepAlive: [undefined, DEFAULT_GRPC_LISTEN_KEEPALIVE_MS],
				deadlines: [undefined, 60_000],
				warnings: ['keepAliveMs -1 is not a number of milliseconds (0 turns keepalive pings off); it is ignored'],
				userAgent,
			},
			{
				keepAlive: [MAX_GRPC_TIMER_MS, undefined],
				deadlines: [undefined, 60_000],
				warnings: [`keepAliveMs ${2 ** 31} is longer than a timer can wait; a keepalive ping is sent every ${MAX_GRPC_TIMER_MS} ms instead`],
				userAgent,
			},
			{ keepAlive: [600_000, undefined], deadlines: [5_000, 5_000], warnings: [], userAgent },
		]);
	});

	test('listen streams are long-lived calls, so the connection is kept alive while one is open; no other call is', async () => {
		const f = createFixture(store, call => {
			if (call.json.method !== 'subscriptions/listen') {
				respondTunnel(call, { jsonrpc: '2.0', id: call.json.id, result: { resultType: 'complete', tools: [] } });
			}
		});
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		const listening = f.handle.send(request(2, 'subscriptions/listen', { notifications: {} }), envelope('subscriptions/listen', 2, { kind: 'listen' }));
		await waitFor(() => f.channel.calls.length === 2, 'the listen call');
		await f.handle.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), envelope('notifications/initialized', undefined));
		await f.handle.close();
		await listening;
		assert.deepStrictEqual({
			channel: [f.channelOptions()?.keepAliveTimeMs, f.channelOptions()?.longLivedKeepAliveTimeMs],
			calls: f.channel.calls.map(c => [c.json.method, c.options?.longLived ?? false, c.options?.deadlineMs]),
		}, {
			channel: [undefined, DEFAULT_GRPC_LISTEN_KEEPALIVE_MS],
			calls: [['tools/list', false, 60_000], ['subscriptions/listen', true, undefined], ['notifications/initialized', false, undefined]],
		});
	});

	test('trace logs blank the credential metadata and the values of the configured headers', async () => {
		const f = createFixture(store, (call, index) => {
			if (index === 0) {
				call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': 'Bearer' });
			} else {
				respondTunnel(call, { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [] } });
			}
		}, {
			launch: { headers: [['X-Api-Key', 'secret-key'], ['Cookie', 'session=abc']] },
			token: () => 'token-1',
			options: { fetchMetadata: async url => jsonResponse(url, 404) },
			logService: new TraceLogService(),
		});
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1, { headers: { 'Mcp-Method': 'tools/list' } }));
		const traced = f.logs.filter(l => l.level === LogLevel.Trace && l.message.startsWith('Calling ')).map(l => JSON.parse(l.message.slice(l.message.indexOf('{'), l.message.lastIndexOf('}') + 1)));
		assert.deepStrictEqual({
			traced,
			sent: f.channel.calls.map(c => c.metadata['x-api-key']),
			leaked: f.logs.some(l => /secret-key|session=abc|token-1/.test(l.message)),
		}, {
			traced: [
				{ 'x-api-key': '***', 'cookie': '***', 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN },
				{ 'x-api-key': '***', 'cookie': '***', 'mcp-method': 'tools/list', 'mcp-protocol-version': MODERN, 'authorization': '***' },
			],
			sent: ['secret-key', 'secret-key'],
			leaked: false,
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

	test('auto is the tunnel: a gRPC server\'s bare UNIMPLEMENTED on server/discover fails it with the typed-binding hint and sends no typed RPC, as with tunnel or no binding', async () => {
		const outcomes: unknown[] = [];
		for (const binding of [undefined, 'auto', 'tunnel'] as const) {
			const f = createFixture(store, call => call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'unknown service mcp.zig.transport.v1.Mcp'), { launch: { binding } });
			await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
			await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
			outcomes.push({
				binding,
				speaks: f.handle.binding,
				paths: f.channel.calls.map(c => c.path),
				messages: f.messages,
				aborts: f.aborts,
				warned: f.logs.some(l => l.level === LogLevel.Warning && l.message === '127.0.0.1:50051 answered server/discover on the JSON-RPC tunnel with UNIMPLEMENTED: unknown service mcp.zig.transport.v1.Mcp'),
			});
		}
		const expected = (binding: string | undefined) => ({
			binding,
			speaks: 'tunnel',
			// Only the tunnel: no ListTools probe and no other typed call.
			paths: [TUNNEL_CALL_PATH, TUNNEL_CALL_PATH],
			messages: [],
			aborts: [
				{ requestId: 1, reason: 'transport-error', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: noTunnelMessage('127.0.0.1:50051', 'unknown service mcp.zig.transport.v1.Mcp') },
				// Any other request keeps the ordinary mapping of a status-only failure.
				{ requestId: 2, reason: 'grpc-status', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: 'UNIMPLEMENTED: unknown service mcp.zig.transport.v1.Mcp' },
			],
			warned: true,
		});
		assert.deepStrictEqual(outcomes, [expected(undefined), expected('auto'), expected('tunnel')]);
	});

	test('auto: only a bare UNIMPLEMENTED gets the typed-binding hint; any other status a gRPC server answers server/discover with, and an UNIMPLEMENTED with a JSON-RPC error in mcp-error-bin alone, keep the ordinary mapping', async () => {
		const others: readonly [GrpcStatus, string][] = [
			[GrpcStatus.CANCELLED, 'CANCELLED'],
			[GrpcStatus.UNKNOWN, 'UNKNOWN'],
			[GrpcStatus.INVALID_ARGUMENT, 'INVALID_ARGUMENT'],
			[GrpcStatus.DEADLINE_EXCEEDED, 'DEADLINE_EXCEEDED'],
			[GrpcStatus.NOT_FOUND, 'NOT_FOUND'],
			[GrpcStatus.ALREADY_EXISTS, 'ALREADY_EXISTS'],
			[GrpcStatus.PERMISSION_DENIED, 'PERMISSION_DENIED'],
			[GrpcStatus.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED'],
			[GrpcStatus.FAILED_PRECONDITION, 'FAILED_PRECONDITION'],
			[GrpcStatus.ABORTED, 'ABORTED'],
			[GrpcStatus.OUT_OF_RANGE, 'OUT_OF_RANGE'],
			[GrpcStatus.INTERNAL, 'INTERNAL'],
			[GrpcStatus.UNAVAILABLE, 'UNAVAILABLE'],
			[GrpcStatus.DATA_LOSS, 'DATA_LOSS'],
			// The final UNAUTHENTICATED of a challenge the user declines to sign in for.
			[GrpcStatus.UNAUTHENTICATED, 'UNAUTHENTICATED'],
		];
		const hinted = (f: IHandleFixture) => f.aborts.some(a => a.message?.includes(NO_TUNNEL_FIX)) || f.logs.some(l => /answered server\/discover on the JSON-RPC tunnel/.test(l.message));
		const outcomes: unknown[] = [];
		for (const [status] of others) {
			const f = createFixture(store, call => call.finish(status, status === GrpcStatus.UNAUTHENTICATED ? { 'www-authenticate': 'Bearer' } : {}, 'not today'), {
				launch: { binding: 'auto' },
				options: { fetchMetadata: async url => jsonResponse(url, 404) },
			});
			await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
			outcomes.push({ paths: f.channel.calls.map(c => c.path), messages: f.messages, aborts: f.aborts, hinted: hinted(f) });
		}
		const bin = createFixture(store, call => call.finish(GrpcStatus.UNIMPLEMENTED, { 'mcp-error-bin': errorBin({ code: -32601, message: 'Method not found: server/discover' }, 1) }, 'Method not found'), { launch: { binding: 'auto' } });
		await bin.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		outcomes.push({ paths: bin.channel.calls.map(c => c.path), messages: bin.messages, aborts: bin.aborts, hinted: hinted(bin) });

		assert.deepStrictEqual(outcomes, [
			...others.map(([status, name]) => ({
				// The tunnel only: no ListTools probe and no other typed call.
				paths: [TUNNEL_CALL_PATH],
				messages: [],
				aborts: [{ requestId: 1, reason: 'grpc-status', grpcStatus: status, message: `${name}: not today` }],
				hinted: false,
			})),
			{
				paths: [TUNNEL_CALL_PATH],
				messages: [{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: server/discover' } }],
				aborts: [],
				hinted: false,
			},
		]);
	});

	test('auto: the typed-binding hint and its warning name the server by host and port, without the user info of the URI', async () => {
		const f = createFixture(store, call => call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'unknown service'), { launch: { uri: URI.parse('grpc://alice:s3cret-token@127.0.0.1:50051') } });
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		assert.deepStrictEqual({
			aborts: f.aborts,
			warnings: f.logs.filter(l => l.level === LogLevel.Warning).map(l => l.message),
			userInfoShown: /alice|s3cret/.test(JSON.stringify([f.aborts, f.logs, f.states, f.messages])),
		}, {
			aborts: [{ requestId: 1, reason: 'transport-error', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: noTunnelMessage('127.0.0.1:50051', 'unknown service') }],
			warnings: ['127.0.0.1:50051 answered server/discover on the JSON-RPC tunnel with UNIMPLEMENTED: unknown service'],
			userInfoShown: false,
		});
	});

	test('auto: the typed-binding hint quotes the server\'s grpc-message (a bare UNIMPLEMENTED can have another cause, such as zig-sdk\'s "Compression is not supported"), says the tunnel is missing only without one, and names the fix for a configuration and for an extension\'s McpGrpcServerDefinition', async () => {
		const outcomes: unknown[] = [];
		for (const grpcMessage of ['Compression is not supported', '  unknown service mcp.zig.transport.v1.Mcp\n', undefined, '', '   ']) {
			const f = createFixture(store, call => call.finish(GrpcStatus.UNIMPLEMENTED, {}, grpcMessage));
			await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
			outcomes.push(f.aborts.map(a => [a.reason, a.message]));
		}
		// Literal texts: the GitHub issue quotes them.
		const fix = 'If it only offers Google\'s typed MCP service, set "binding": "typed" in its configuration, or, if an extension provides the server, ask its author to use McpGrpcBinding.Typed.';
		const missing = `The gRPC server at 127.0.0.1:50051 does not implement the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp). ${fix}`;
		assert.deepStrictEqual(outcomes, [
			[['transport-error', `The gRPC server at 127.0.0.1:50051 answered a call to the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp) with UNIMPLEMENTED: "Compression is not supported". ${fix}`]],
			[['transport-error', `The gRPC server at 127.0.0.1:50051 answered a call to the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp) with UNIMPLEMENTED: "unknown service mcp.zig.transport.v1.Mcp". ${fix}`]],
			[['transport-error', missing]],
			[['transport-error', missing]],
			[['transport-error', missing]],
		]);
	});

	test('auto: a tunnel -32601 with mcp-error-code is an ordinary error (server/discover included) and keeps the tunnel', async () => {
		const f = createFixture(store, (call, index) => {
			if (index === 0) {
				call.finish(GrpcStatus.UNIMPLEMENTED, { 'mcp-error-code': '-32601' }, 'Method not found: server/discover');
			} else if (index === 1) {
				call.finish(GrpcStatus.UNIMPLEMENTED, { 'mcp-error-code': '-32601' }, 'Method not found: resources/subscribe');
			} else {
				call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'later');
			}
		});
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		await f.handle.send(request(2, 'resources/subscribe', { uri: 'a' }), envelope('resources/subscribe', 2));
		await f.handle.send(request(3, 'tools/list'), envelope('tools/list', 3));
		assert.deepStrictEqual({
			paths: f.channel.calls.map(c => c.path),
			binding: f.handle.binding,
			messages: f.messages,
			aborts: f.aborts.map(a => [a.requestId, a.reason, a.grpcStatus]),
		}, {
			paths: [TUNNEL_CALL_PATH, TUNNEL_CALL_PATH, TUNNEL_CALL_PATH],
			binding: 'tunnel',
			messages: [
				{ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: server/discover' } },
				{ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found: resources/subscribe' } },
			],
			aborts: [[3, 'grpc-status', GrpcStatus.UNIMPLEMENTED]],
		});
	});

	test('auto: an HTTP 404 (no gRPC server answered) is a transport failure, without the typed-binding hint', async () => {
		const f = createFixture(store, call => call.finishHttp(404, { 'content-type': 'text/html' }));
		await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
		await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
		const http404 = { reason: 'http-status', httpStatus: 404, grpcStatus: GrpcStatus.UNIMPLEMENTED, message: 'HTTP status 404 instead of a gRPC response (UNIMPLEMENTED)' };
		assert.deepStrictEqual({
			paths: f.channel.calls.map(c => c.path),
			binding: f.handle.binding,
			messages: f.messages,
			aborts: f.aborts,
		}, {
			paths: [TUNNEL_CALL_PATH, TUNNEL_CALL_PATH],
			binding: 'tunnel',
			messages: [],
			aborts: [{ requestId: 1, ...http404 }, { requestId: 2, ...http404 }],
		});
	});

	test('a non-200 HTTP status is an http-status abort on either binding; JSON-RPC errors in its headers still arrive', async () => {
		const outcomes = [
			mapGrpcTrailersToJsonRpc({ status: GrpcStatus.UNAVAILABLE, message: 'HTTP status 502', raw: {}, httpStatus: 502 }, 1),
			mapGrpcTrailersToJsonRpc({ status: GrpcStatus.PERMISSION_DENIED, message: 'blocked by the gateway', raw: { 'grpc-status': '7' }, httpStatus: 403 }, 2),
			mapGrpcTrailersToJsonRpc({ status: GrpcStatus.INVALID_ARGUMENT, message: 'Header mismatch', raw: { 'grpc-status': '3', 'mcp-error-code': '-32020' }, httpStatus: 400 }, 3),
			mapGrpcTrailersToJsonRpc({ status: GrpcStatus.UNIMPLEMENTED, message: 'no such service', raw: { 'grpc-status': '12' }, httpStatus: 200 }, 4),
		];
		const typed = createFixture(store, call => call.finishHttp(503), { launch: { binding: 'typed' } });
		await typed.handle.send(request(5, 'tools/list'), envelope('tools/list', 5));

		assert.deepStrictEqual({ outcomes: outcomes.map(o => o.kind === 'message' ? JSON.parse(o.message) : o.abort), typed: typed.aborts }, {
			outcomes: [
				{ reason: 'http-status', httpStatus: 502, grpcStatus: GrpcStatus.UNAVAILABLE, message: 'HTTP status 502 instead of a gRPC response (UNAVAILABLE)' },
				{ reason: 'http-status', httpStatus: 403, grpcStatus: GrpcStatus.PERMISSION_DENIED, message: 'HTTP status 403 instead of a gRPC response (PERMISSION_DENIED): blocked by the gateway' },
				{ jsonrpc: '2.0', id: 3, error: { code: -32020, message: 'Header mismatch' } },
				{ reason: 'grpc-status', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: 'UNIMPLEMENTED: no such service' },
			],
			typed: [{ requestId: 5, reason: 'http-status', httpStatus: 503, grpcStatus: GrpcStatus.UNAVAILABLE, message: 'HTTP status 503 instead of a gRPC response (UNAVAILABLE)' }],
		});
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

	test('auth: metadata redirects are followed by the handle, and the configured headers never follow one to another origin', async () => {
		const identity = 'https://127.0.0.1:50051';
		const fetched: { url: string; headers: Record<string, string>; redirect: string; method: string }[] = [];
		const f = createFixture(store, (call, index) => {
			if (index === 0) {
				call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': 'Bearer' }, 'missing token');
			} else {
				respondTunnel(call, { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [] } });
			}
		}, {
			launch: { headers: [['X-Api-Key', 'secret-key']] },
			token: () => 'token-1',
			options: {
				fetchMetadata: async (url, init) => {
					fetched.push({ url, headers: Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value])), redirect: init.redirect, method: init.method });
					switch (url) {
						// Same origin first: the headers stay. Then to another origin (cleartext, even): they go.
						case `${identity}/.well-known/oauth-protected-resource`: return redirectResponse(url, 302, '/moved/prm');
						case `${identity}/moved/prm`: return redirectResponse(url, 307, 'http://elsewhere.example/prm');
						case 'http://elsewhere.example/prm': return redirectResponse(url, 308, `${identity}/back`);
						case `${identity}/back`: return jsonResponse(url, 200, { resource: `${identity}/`, authorization_servers: ['https://auth.example'] });
						case 'https://auth.example/.well-known/oauth-authorization-server': return jsonResponse(url, 200, {
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

		assert.deepStrictEqual(fetched.slice(0, 4).map(r => ({
			url: r.url,
			apiKey: r.headers['x-api-key'],
			version: r.headers['mcp-protocol-version'],
			accept: r.headers.accept,
			agent: r.headers['user-agent'] === `${product.nameLong}/${product.version}`,
			redirect: r.redirect,
		})), [
			{ url: `${identity}/.well-known/oauth-protected-resource`, apiKey: 'secret-key', version: MODERN, accept: 'application/json', agent: true, redirect: 'manual' },
			{ url: `${identity}/moved/prm`, apiKey: 'secret-key', version: MODERN, accept: 'application/json', agent: true, redirect: 'manual' },
			{ url: 'http://elsewhere.example/prm', apiKey: undefined, version: MODERN, accept: 'application/json', agent: true, redirect: 'manual' },
			// Back on the identity: what was dropped stays dropped.
			{ url: `${identity}/back`, apiKey: undefined, version: MODERN, accept: 'application/json', agent: true, redirect: 'manual' },
		]);
		assert.deepStrictEqual({
			apiKeyAt: fetched.filter(r => r.headers['x-api-key'] !== undefined).map(r => new URL(r.url).origin),
			second: f.channel.calls[1]?.metadata.Authorization ?? f.channel.calls[1]?.metadata.authorization,
			aborts: f.aborts,
		}, { apiKeyAt: [identity, identity], second: 'Bearer token-1', aborts: [] });
	});

	test('auth: a metadata redirect to a non-http(s) target and an endless redirect chain are not followed', async () => {
		const fetched: string[] = [];
		const f = createFixture(store, () => { }, {
			options: {
				fetchMetadata: async url => {
					fetched.push(url);
					return url.includes('loop') ? redirectResponse(url, 302, `/loop/${fetched.length}`) : redirectResponse(url, 302, 'file:///etc/passwd');
				},
			},
		});
		// eslint-disable-next-line local/code-no-bracket-notation-for-identifiers -- Exercise the private metadata request without an authorization round.
		const fetchMetadata = (url: string) => f.handle['_fetchMetadata'](url, { method: 'GET', headers: {} }, undefined);
		await assert.rejects(fetchMetadata('https://127.0.0.1:50051/.well-known/oauth-protected-resource'), /non-http\(s\) target \(file:\)/);
		const looping = await fetchMetadata('https://127.0.0.1:50051/loop/0');
		assert.deepStrictEqual({ status: looping.status, requests: fetched.length }, { status: 302, requests: 1 + 6 });
	});

	test('auth: disposing the handle aborts a hanging metadata request', async () => {
		const signals: AbortSignal[] = [];
		const f = createFixture(store, call => call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': 'Bearer' }), {
			options: { fetchMetadata: (_url, init) => hangUntilAborted(init.signal, signals) },
		});
		const sending = f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		await waitFor(() => signals.length === 1, 'the metadata request');
		f.handle.dispose();
		await sending;
		assert.deepStrictEqual({
			aborted: signals.map(s => s.aborted),
			reason: (signals[0].reason as Error | undefined)?.name,
			aborts: f.aborts,
			messages: f.messages,
		}, { aborted: [true], reason: 'AbortError', aborts: [], messages: [] });
	});

	test('auth: cancelling the request aborts its discovery fetch, and the handle stays usable', async () => {
		const signals: AbortSignal[] = [];
		const f = createFixture(store, (call, index) => {
			if (index === 0) {
				call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': 'Bearer' });
			} else {
				respondTunnel(call, { jsonrpc: '2.0', id: call.json.id, result: { resultType: 'complete', tools: [] } });
			}
		}, {
			// The default 30 s timeout of a metadata request: only the cancellation can end it in time.
			options: { fetchMetadata: (_url, init) => hangUntilAborted(init.signal, signals) },
		});
		const sending = f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		await waitFor(() => signals.length === 1, 'the metadata request');
		f.handle.cancelRequest(1);
		await waitFor(() => signals[0].aborted, 'the metadata request to be aborted', 2000);
		await sending;
		await f.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
		assert.deepStrictEqual({
			reason: (signals[0].reason as Error | undefined)?.name,
			metadataRequests: signals.length,
			calls: f.channel.calls.length,
			messages: f.messages.map(m => m.id),
			aborts: f.aborts,
			states: f.states.map(s => s.state),
		}, {
			reason: 'AbortError',
			metadataRequests: 1,
			calls: 2,
			messages: [2],
			aborts: [],
			states: [McpConnectionState.Kind.Running],
		});
	});

	test('auth: a metadata request is aborted after its timeout, so a hanging discovery ends', async () => {
		const signals: AbortSignal[] = [];
		const f = createFixture(store, call => call.finish(GrpcStatus.UNAUTHENTICATED, { 'www-authenticate': 'Bearer' }), {
			options: { metadataTimeoutMs: 20, fetchMetadata: (_url, init) => hangUntilAborted(init.signal, signals) },
		});
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		assert.ok(signals.length > 0);
		assert.deepStrictEqual({
			reasons: [...new Set(signals.map(s => (s.reason as Error | undefined)?.name))],
			ended: f.aborts.length + f.messages.length + f.states.filter(s => s.state === McpConnectionState.Kind.Error).length > 0,
		}, { reasons: ['TimeoutError'], ended: true });
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

	test('channel options: TLS for grpcs://, keepalive, tls.ca and the certificate authorities of the extension host', async () => {
		let connection: IGrpcConnectionFactoryOptions | undefined;
		const caPaths: string[] = [];
		const f = createFixture(store, call => respondTunnel(call, { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [] } }), {
			launch: { uri: URI.parse('grpcs://user@secure.example:443'), keepAliveMs: 300_000, tls: { ca: '/certs/ca.pem', serverName: 'override.example' } },
			options: {
				readCaFile: async path => {
					caPaths.push(path);
					return `PEM(${path})`;
				},
				createConnectionFactory: options => {
					connection = options;
					return createGrpcConnectionFactory(options);
				},
				proxyLookup: async () => ({ loadCaCertificates: async () => ['SYSTEM-CA'] }),
			},
		});
		await f.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		const options = f.channelOptions();
		assert.deepStrictEqual({
			authority: options?.authority,
			secure: options?.secure,
			keepAlive: options?.keepAliveTimeMs,
			hasConnection: typeof options?.createConnection,
			caPaths,
			ca: connection?.ca,
			roots: await connection?.loadRootCertificates?.(),
			servername: connection?.servername,
			rejectUnauthorized: connection?.rejectUnauthorized,
			connectionSecure: connection?.secure,
		}, {
			authority: 'secure.example:443',
			secure: true,
			keepAlive: 300_000,
			hasConnection: 'function',
			caPaths: ['/certs/ca.pem'],
			ca: ['PEM(/certs/ca.pem)'],
			roots: ['SYSTEM-CA'],
			servername: 'override.example',
			rejectUnauthorized: true,
			connectionSecure: true,
		});
	});

	test('TLS trusts what the extension host\'s fetch trusts (the system certificates with http.systemCertificates), and tls.ca on top of it', async () => {
		const loadedTls = createRequire(import.meta.url)('tls') as { connect: typeof tls.connect };
		const originalConnect = loadedTls.connect;
		const seen: (readonly string[] | undefined)[] = [];
		loadedTls.connect = ((options: tls.ConnectionOptions) => {
			seen.push(options.ca === undefined ? undefined : [...(options.ca as string[])]);
			throw new Error('not connecting');
		}) as typeof tls.connect;
		try {
			const system = async () => [...tls.rootCertificates, 'SYSTEM-CA'];
			const off = async () => undefined;
			const warnings: string[] = [];
			const cases: [IGrpcConnectionFactoryOptions['ca'], IGrpcConnectionFactoryOptions['loadRootCertificates']][] = [
				[undefined, system],
				[['TLS-CA'], system],
				[['TLS-CA'], off],
				[undefined, off],
				[['TLS-CA'], undefined],
				[undefined, async () => { throw new Error('the store is locked'); }],
			];
			for (const [ca, loadRootCertificates] of cases) {
				const connect = createGrpcConnectionFactory({ secure: true, ca, loadRootCertificates, log: (_level, message) => warnings.push(message) });
				await assert.rejects(connect({ host: '127.0.0.1', port: 1 }), /not connecting/);
			}
			const roots = [...tls.rootCertificates];
			assert.deepStrictEqual({ seen, warnings }, {
				seen: [
					[...roots, 'SYSTEM-CA'],
					[...roots, 'SYSTEM-CA', 'TLS-CA'],
					[...roots, 'TLS-CA'],
					// Nothing to add: the extension host's tls.connect applies its own defaults.
					undefined,
					[...roots, 'TLS-CA'],
					undefined,
				],
				warnings: ['Could not load the system certificates, verifying with Node\'s bundled roots only: the store is locked'],
			});
		} finally {
			loadedTls.connect = originalConnect;
		}
	});

	test('loadFetchCaCertificates: the bundled roots and the additional certificates under either http.systemCertificates version, nothing when it is off', async function () {
		// proxyResolver.js pulls in the extension host's static `node:` imports, which the Electron unit-test
		// renderer cannot resolve, so it is imported here (not at the top of the file) and only under Node.
		if (process.versions.electron) {
			this.skip();
		}
		const { loadFetchCaCertificates } = await import('../../node/proxyResolver.js');
		const outcomes: (readonly string[] | undefined)[] = [];
		for (const [v1, v2] of [[true, false], [false, true], [false, false]]) {
			proxyAgent.resetCaches();
			outcomes.push(await loadFetchCaCertificates({
				addCertificatesV1: () => v1,
				addCertificatesV2: () => v2,
				loadSystemCertificatesFromNode: () => false,
				loadAdditionalCertificates: async () => ['OS-CA'],
			}));
		}
		proxyAgent.resetCaches();
		assert.deepStrictEqual(outcomes, [[...tls.rootCertificates, 'OS-CA'], [...tls.rootCertificates, 'OS-CA'], undefined]);
	});

	test('connections honour http.proxySupport: off connects directly without resolving a proxy', async () => {
		const target = net.createServer(socket => socket.end());
		await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
		// A proxy that refuses every CONNECT: only a connection that skips it succeeds.
		const refusingProxy = net.createServer(socket => {
			socket.on('error', () => { });
			socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
		});
		await new Promise<void>(resolve => refusingProxy.listen(0, '127.0.0.1', resolve));
		try {
			const address = target.address();
			const proxyAddress = refusingProxy.address();
			assert.ok(address && typeof address === 'object' && proxyAddress && typeof proxyAddress === 'object');
			const resolved: string[] = [];
			const lookup = (support: string): IGrpcProxyLookup => ({
				getProxySupport: () => support,
				resolveProxyURL: async url => {
					resolved.push(`${support} ${url}`);
					return `http://127.0.0.1:${proxyAddress.port}`;
				},
			});
			const connect = (support: string) => createGrpcConnectionFactory({ secure: false, proxy: lookup(support), connectTimeoutMs: 5000 })({ host: '127.0.0.1', port: address.port });

			const direct = await connect('off');
			direct.destroy();
			const outcomes: string[] = [];
			for (const support of ['override', 'fallback', 'on']) {
				outcomes.push(await connect(support).then(socket => { socket.destroy(); return 'connected'; }, () => 'refused by the proxy'));
			}
			assert.deepStrictEqual({ resolved, outcomes }, {
				resolved: [`override http://127.0.0.1:${address.port}/`, `fallback http://127.0.0.1:${address.port}/`, `on http://127.0.0.1:${address.port}/`],
				outcomes: ['refused by the proxy', 'refused by the proxy', 'refused by the proxy'],
			});
		} finally {
			await new Promise<void>(resolve => target.close(() => resolve()));
			await new Promise<void>(resolve => refusingProxy.close(() => resolve()));
		}
	});

	test('the default proxy lookup reads the functions proxyResolver.ts puts on @vscode/proxy-agent', async () => {
		const agentModule = proxyAgent as unknown as { default?: Record<string, unknown> } & Record<string, unknown>;
		const target = agentModule.default ?? agentModule;
		const saved = { resolveProxyURL: target.resolveProxyURL, lookupProxyAuthorization: target.lookupProxyAuthorization, getProxySupport: target.getProxySupport, loadCaCertificates: target.loadCaCertificates };
		try {
			target.resolveProxyURL = async (url: string) => `http://proxy.example:3128/?for=${url}`;
			target.lookupProxyAuthorization = async () => 'Basic abc';
			let support = 'override';
			target.getProxySupport = () => support;
			target.loadCaCertificates = async () => ['SYSTEM-CA'];
			const lookup = await extensionHostProxyLookup();
			const before = lookup.getProxySupport?.();
			support = 'off';
			assert.deepStrictEqual([
				await lookup.resolveProxyURL?.('https://mcp.example:443/'),
				await lookup.lookupProxyAuthorization?.('http://proxy.example:3128/', undefined, {}),
				before,
				// Read live: a change of the setting applies to the next connection.
				lookup.getProxySupport?.(),
				await lookup.loadCaCertificates?.(),
			], ['http://proxy.example:3128/?for=https://mcp.example:443/', 'Basic abc', 'override', 'off', ['SYSTEM-CA']]);
		} finally {
			target.resolveProxyURL = saved.resolveProxyURL;
			target.lookupProxyAuthorization = saved.lookupProxyAuthorization;
			target.getProxySupport = saved.getProxySupport;
			target.loadCaCertificates = saved.loadCaCertificates;
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
	/** The SNI of every TLS handshake that sent one, seen before the certificate is checked. */
	readonly servernames: string[];
	handler: StreamHandler;
	close(): Promise<void>;
}

async function startServer(secure?: ISelfSignedCert): Promise<ILoopbackServer> {
	const sessions: http2.ServerHttp2Session[] = [];
	const requests: http2.IncomingHttpHeaders[] = [];
	const servernames: string[] = [];
	const server = secure ? http2.createSecureServer({
		key: secure.key,
		cert: secure.cert,
		SNICallback: (servername: string, callback: (error: Error | null, context?: tls.SecureContext) => void) => {
			servernames.push(servername);
			callback(null, undefined); // the default context
		},
	}) : http2.createServer();
	const result: ILoopbackServer = {
		port: 0,
		requests,
		servernames,
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
		result.handler(stream, headers, payload && headers[':path'] === TUNNEL_CALL_PATH ? tunnelRequest(payload) : undefined);
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

	test('TLS: tls.serverName is the SNI and the name the certificate is checked against', async () => {
		const server = await startServer(cert);
		toClose.push(() => server.close());
		// The certificate is for 127.0.0.1 and trusted through tls.ca: only the name can fail it.
		const { handle, messages, aborts } = createRealHandle({ uri: URI.parse(`grpcs://127.0.0.1:${server.port}`), tls: { ca: caFile, serverName: 'override.example' } });
		await handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		await waitFor(() => server.servernames.length > 0, 'the TLS connection');

		assert.deepStrictEqual({ servernames: server.servernames, messages, aborts: aborts.map(a => [a.reason, a.grpcStatus]), requests: server.requests.length }, {
			servernames: ['override.example'],
			messages: [],
			aborts: [['grpc-status', GrpcStatus.UNAVAILABLE]],
			requests: 0,
		});
		assert.match(aborts[0].message ?? '', /override\.example/);
		assert.doesNotMatch(aborts[0].message ?? '', /self[- ]signed|unable to verify/i);
	});

	test('TLS: a server certificate from the system store (http.systemCertificates) is trusted without tls.ca, and together with a tls.ca for another authority', async function () {
		// The "other authority" is a second generateSelfSignedCert certificate, with the same subject (CN=TunnelProxy)
		// as the server's: OpenSSL tries every certificate of that name as the issuer, Electron's BoringSSL only one.
		if (process.versions.electron) {
			this.skip();
		}
		const server = await startServer(cert);
		toClose.push(() => server.close());
		// What the extension host's fetch trusts: here, the bundled roots and the server's certificate as if from the OS store.
		const systemStore: IGrpcProxyLookup = { loadCaCertificates: async () => [...tls.rootCertificates, cert.cert] };
		const otherCaFile = join(tempDir, 'other-ca.pem');
		fs.writeFileSync(otherCaFile, (await generateSelfSignedCert()).cert);

		const withoutCa = createRealHandle({ uri: URI.parse(`grpcs://127.0.0.1:${server.port}`) }, systemStore);
		await withoutCa.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		const withOtherCa = createRealHandle({ uri: URI.parse(`grpcs://127.0.0.1:${server.port}`), tls: { ca: otherCaFile } }, systemStore);
		await withOtherCa.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));
		const storeOff = createRealHandle({ uri: URI.parse(`grpcs://127.0.0.1:${server.port}`), tls: { ca: otherCaFile } }, { loadCaCertificates: async () => undefined });
		await storeOff.handle.send(request(3, 'tools/list'), envelope('tools/list', 3));

		assert.deepStrictEqual({
			withoutCa: { ids: withoutCa.messages.map(m => m.id), aborts: withoutCa.aborts },
			withOtherCa: { ids: withOtherCa.messages.map(m => m.id), aborts: withOtherCa.aborts },
			storeOff: { ids: storeOff.messages.map(m => m.id), aborts: storeOff.aborts.map(a => [a.reason, a.grpcStatus]) },
			requests: server.requests.length,
		}, {
			withoutCa: { ids: [1], aborts: [] },
			withOtherCa: { ids: [2], aborts: [] },
			storeOff: { ids: [], aborts: [['grpc-status', GrpcStatus.UNAVAILABLE]] },
			requests: 2,
		});
	});

	test('TLS: an HTTPS proxy is verified against the certificate authorities of the extension host', async () => {
		const server = await startServer();
		toClose.push(() => server.close());
		// An HTTPS CONNECT proxy whose certificate only the system store (as the extension host loads it) trusts.
		const proxySockets: net.Socket[] = [];
		const connects: string[] = [];
		const proxy = tls.createServer({ key: cert.key, cert: cert.cert }, socket => {
			proxySockets.push(socket);
			socket.on('error', () => { });
			socket.once('data', (head: Buffer) => {
				connects.push(head.toString('latin1').split('\r\n')[0]);
				const upstream = net.connect(server.port, '127.0.0.1', () => {
					socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
					socket.pipe(upstream);
					upstream.pipe(socket);
				});
				proxySockets.push(upstream);
				upstream.on('error', () => socket.destroy());
			});
		});
		await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
		toClose.push(async () => {
			for (const socket of proxySockets) {
				socket.destroy();
			}
			await new Promise<void>(resolve => proxy.close(() => resolve()));
		});
		const address = proxy.address();
		assert.ok(address && typeof address === 'object');
		const lookup = (loadCaCertificates: IGrpcProxyLookup['loadCaCertificates']): IGrpcProxyLookup => ({
			resolveProxyURL: async () => `https://127.0.0.1:${address.port}`,
			loadCaCertificates,
		});

		const trusted = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${server.port}`) }, lookup(async () => [...tls.rootCertificates, cert.cert]));
		await trusted.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		const untrusted = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${server.port}`) }, lookup(async () => undefined));
		await untrusted.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));

		assert.deepStrictEqual({
			trusted: { ids: trusted.messages.map(m => m.id), aborts: trusted.aborts },
			untrusted: { ids: untrusted.messages.map(m => m.id), aborts: untrusted.aborts.map(a => [a.reason, a.grpcStatus]) },
			connects,
			requests: server.requests.length,
		}, {
			trusted: { ids: [1], aborts: [] },
			untrusted: { ids: [], aborts: [['grpc-status', GrpcStatus.UNAVAILABLE]] },
			connects: [`CONNECT 127.0.0.1:${server.port} HTTP/1.1`],
			requests: 1,
		});
		assert.match(untrusted.aborts[0].message ?? '', /self[- ]signed|unable to verify|certificate/i);
	});

	test('auto: an HTTP 404 of a plain HTTP/2 server is a transport failure; a typed-only server\'s HTTP 200 UNIMPLEMENTED fails the discover with the hint, and only binding typed calls its typed service', async () => {
		const web = await startServer();
		toClose.push(() => web.close());
		web.handler = stream => {
			stream.respond({ ':status': 404, 'content-type': 'text/html' });
			stream.end('<h1>Not Found</h1>');
		};
		const plain = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${web.port}`) });
		await plain.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));

		const typedOnly = await startServer();
		toClose.push(() => typedOnly.close());
		typedOnly.handler = (stream, headers) => {
			if (headers[':path'] === TUNNEL_CALL_PATH) {
				stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': String(GrpcStatus.UNIMPLEMENTED), 'grpc-message': 'unknown service' }, { endStream: true });
				return;
			}
			const listTools = typedRpcForMethod('tools/list')!;
			stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
			stream.end(encodeLengthPrefixedMessage(encodeTypedResponse(listTools, { resultType: 'complete', tools: [], ttlMs: 0, cacheScope: 'private' })));
		};
		const grpcServer = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${typedOnly.port}`) });
		await grpcServer.handle.send(request(2, 'server/discover'), envelope('server/discover', 2));
		await grpcServer.handle.send(request(3, 'tools/list'), envelope('tools/list', 3));
		const autoPaths = typedOnly.requests.map(h => h[':path']);
		const typed = createRealHandle({ uri: URI.parse(`grpc://127.0.0.1:${typedOnly.port}`), binding: 'typed' });
		await typed.handle.send(request(4, 'tools/list'), envelope('tools/list', 4));

		assert.deepStrictEqual({
			webPaths: web.requests.map(h => h[':path']),
			webBinding: plain.handle.binding,
			webAborts: plain.aborts,
			webMessages: plain.messages,
			autoPaths,
			autoBinding: grpcServer.handle.binding,
			autoMessages: grpcServer.messages,
			autoAborts: grpcServer.aborts,
			typedPaths: typedOnly.requests.slice(autoPaths.length).map(h => h[':path']),
			typedIds: typed.messages.map(m => m.id),
			typedAborts: typed.aborts,
		}, {
			webPaths: [TUNNEL_CALL_PATH],
			webBinding: 'tunnel',
			webAborts: [{ requestId: 1, reason: 'http-status', httpStatus: 404, grpcStatus: GrpcStatus.UNIMPLEMENTED, message: 'HTTP status 404 instead of a gRPC response (UNIMPLEMENTED)' }],
			webMessages: [],
			autoPaths: [TUNNEL_CALL_PATH, TUNNEL_CALL_PATH],
			autoBinding: 'tunnel',
			autoMessages: [],
			autoAborts: [
				{ requestId: 2, reason: 'transport-error', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: noTunnelMessage(`127.0.0.1:${typedOnly.port}`, 'unknown service') },
				{ requestId: 3, reason: 'grpc-status', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: 'UNIMPLEMENTED: unknown service' },
			],
			typedPaths: ['/model_context_protocol.Mcp/ListTools'],
			typedIds: [4],
			typedAborts: [],
		});
	});

	test('IDN hosts: net.connect, the proxy lookup, CONNECT, the TLS servername and :authority use the ASCII form', async () => {
		const idn = 'bücher.example';
		const ascii = 'xn--bcher-kva.example';

		// Directly over grpc://: net.connect (through the module loader, as the handle loads it) gets the A-labels.
		const plainServer = await startServer();
		toClose.push(() => plainServer.close());
		const loadedNet = createRequire(import.meta.url)('net') as { connect: typeof net.connect };
		const originalConnect = loadedNet.connect;
		const connectHosts: (string | undefined)[] = [];
		loadedNet.connect = ((options: net.TcpNetConnectOpts) => {
			connectHosts.push(options.host);
			// DNS would resolve the A-labels; the test server is on the loopback address.
			return originalConnect({ ...options, host: '127.0.0.1' });
		}) as typeof net.connect;
		let direct: ReturnType<typeof createRealHandle>;
		try {
			direct = createRealHandle({ uri: URI.parse(`grpc://${idn}:${plainServer.port}`) });
			await direct.handle.send(request(1, 'tools/list'), envelope('tools/list', 1));
		} finally {
			loadedNet.connect = originalConnect;
		}

		// grpcs:// through a CONNECT proxy: the proxy lookup, the CONNECT authority and the SNI get them too.
		const tlsServer = await startServer(cert);
		toClose.push(() => tlsServer.close());
		const connects: string[] = [];
		const sockets: net.Socket[] = [];
		const proxyServer = net.createServer(client => {
			sockets.push(client);
			client.on('error', () => { });
			client.once('data', (chunk: Buffer) => {
				const head = chunk.toString('latin1');
				connects.push(head.split('\r\n')[0]);
				const upstream = net.connect(tlsServer.port, '127.0.0.1', () => {
					client.write('HTTP/1.1 200 Connection established\r\n\r\n');
					client.pipe(upstream);
					upstream.pipe(client);
				});
				sockets.push(upstream);
				upstream.on('error', () => client.destroy());
			});
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
		const resolved: string[] = [];
		// The certificate is for 127.0.0.1: tls.insecure lets the call complete, the SNI is seen before the check.
		const secure = createRealHandle({ uri: URI.parse(`grpcs://${idn}:${tlsServer.port}`), tls: { insecure: true } }, {
			resolveProxyURL: async url => {
				resolved.push(url);
				return `http://127.0.0.1:${proxyAddress.port}`;
			},
		});
		await secure.handle.send(request(2, 'tools/list'), envelope('tools/list', 2));

		assert.deepStrictEqual({
			connectHosts,
			directAuthority: plainServer.requests.map(h => h[':authority']),
			directIds: direct.messages.map(m => m.id),
			resolved,
			connects,
			servernames: tlsServer.servernames,
			secureAuthority: tlsServer.requests.map(h => h[':authority']),
			secureIds: secure.messages.map(m => m.id),
			aborts: [...direct.aborts, ...secure.aborts],
		}, {
			connectHosts: [ascii],
			directAuthority: [`${ascii}:${plainServer.port}`],
			directIds: [1],
			resolved: [`https://${ascii}:${tlsServer.port}/`],
			connects: [`CONNECT ${ascii}:${tlsServer.port} HTTP/1.1`],
			servernames: [ascii],
			secureAuthority: [`${ascii}:${tlsServer.port}`],
			secureIds: [2],
			aborts: [],
		});
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

	async function connectEngine(respond: (call: FakeCall, request: JsonObject) => void, binding: McpServerTransportGrpc['binding'] = 'tunnel'): Promise<McpServerRequestHandler> {
		const channel = new FakeChannel(call => respond(call, call.json));
		const transport = store.add(new GrpcTestTransport(launchOf({ binding }), { createChannel: () => channel }));
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		const instantiationService = store.add(new InstantiationService(new ServiceCollection([IProductService, productService]), true));
		return store.add(await McpServerRequestHandler.create(instantiationService, {
			launch: transport,
			logger: new NullLogger(),
			taskManager: store.add(new McpTaskManager()),
			transportType: McpServerTransportType.Grpc,
		}));
	}

	test('a non-MCP HTTP/2 endpoint (HTTP 404) fails the connection instead of switching to the typed binding', async () => {
		const paths: string[] = [];
		await assert.rejects(connectEngine(call => {
			paths.push(call.path);
			call.finishHttp(404);
		}, 'auto'), (e: unknown) => {
			assert.ok(e instanceof McpClientError, `expected an McpClientError, got ${e}`);
			assert.deepStrictEqual({ reason: e.reason, abort: e.detail }, {
				reason: 'request-aborted',
				abort: { requestId: (e.detail as IMcpRequestAbort).requestId, reason: 'http-status', httpStatus: 404, grpcStatus: GrpcStatus.UNIMPLEMENTED, message: 'HTTP status 404 instead of a gRPC response (UNIMPLEMENTED)' },
			});
			return true;
		});
		// No typed fallback and no legacy initialize: the probe was the only call.
		assert.deepStrictEqual(paths, [TUNNEL_CALL_PATH]);
	});

	test('auto against a gRPC server without the tunnel: the handshake fails with the typed-binding hint, without a typed call or initialize', async () => {
		const paths: string[] = [];
		await assert.rejects(connectEngine(call => {
			paths.push(call.path);
			call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'unknown service mcp.zig.transport.v1.Mcp');
		}, 'auto'), (e: unknown) => {
			assert.ok(e instanceof McpClientError, `expected an McpClientError, got ${e}`);
			// The connection shows this message in its Error state (McpServerConnection takes the message of the failed handshake).
			assert.deepStrictEqual({ reason: e.reason, message: e.message, abort: e.detail }, {
				reason: 'request-aborted',
				message: noTunnelMessage('127.0.0.1:50051', 'unknown service mcp.zig.transport.v1.Mcp'),
				abort: { requestId: (e.detail as IMcpRequestAbort).requestId, reason: 'transport-error', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: noTunnelMessage('127.0.0.1:50051', 'unknown service mcp.zig.transport.v1.Mcp') },
			});
			return true;
		});
		assert.deepStrictEqual(paths, [TUNNEL_CALL_PATH]);
	});

	test('auto against a gRPC server without the tunnel: the server connection ends in the Error state with the hint and the server\'s grpc-message (also for another cause, such as "Compression is not supported"), and its output logs it', async () => {
		const outcomes: unknown[] = [];
		for (const grpcMessage of ['unknown service mcp.zig.transport.v1.Mcp', 'Compression is not supported', undefined]) {
			const launch = launchOf({ binding: 'auto' });
			const transport = store.add(new GrpcTestTransport(launch, { createChannel: () => new FakeChannel(call => call.finish(GrpcStatus.UNIMPLEMENTED, {}, grpcMessage)) }));
			const delegate: IMcpHostDelegate = {
				priority: 0,
				waitForInitialProviderPromises: async () => { },
				canStart: () => true,
				substituteVariables: async (_definition, resolved) => resolved,
				expandEnvironmentVariables: async (_definition, resolved) => resolved,
				start: () => transport,
			};
			const errors: string[] = [];
			const logger = new class extends NullLogger {
				override error(message: string | Error): void {
					errors.push(message instanceof Error ? message.message : message);
				}
			};
			const collection: McpCollectionDefinition = {
				id: 'grpc-collection',
				label: 'gRPC',
				remoteAuthority: null,
				serverDefinitions: observableValue('servers', []),
				trustBehavior: McpServerTrust.Kind.Trusted,
				scope: StorageScope.APPLICATION,
				configTarget: ConfigurationTarget.USER,
				order: 0,
			};
			const definition: McpServerDefinition = { id: 'grpc-server', label: 'gRPC server', cacheNonce: 'a', launch };
			const productService: IProductService = { _serviceBrand: undefined, ...product };
			const instantiationService = store.add(new InstantiationService(new ServiceCollection([IProductService, productService]), true));
			const connection = store.add(new McpServerConnection(collection, definition, delegate, launch, logger, false, store.add(new McpTaskManager()), instantiationService));

			await connection.start({});
			await waitFor(() => connection.state.get().state === McpConnectionState.Kind.Error, 'the Error state');
			outcomes.push({ state: connection.state.get(), logged: errors });
		}
		assert.deepStrictEqual(outcomes, ['unknown service mcp.zig.transport.v1.Mcp', 'Compression is not supported', undefined].map(grpcMessage => ({
			state: { state: McpConnectionState.Kind.Error, message: noTunnelMessage('127.0.0.1:50051', grpcMessage) },
			logged: [noTunnelMessage('127.0.0.1:50051', grpcMessage)],
		})));
	});

	test('auto against a tunnel server without server/discover (-32601 in mcp-error-code): the ordinary fallback to initialize, on the tunnel', async () => {
		const calls: { path: string; method: unknown }[] = [];
		const handler = await connectEngine((call, req) => {
			calls.push({ path: call.path, method: req.method });
			if (req.method === 'server/discover') {
				return call.finish(GrpcStatus.UNIMPLEMENTED, { 'mcp-error-code': '-32601' }, 'Method not found: server/discover');
			}
			if (req.method === 'initialize') {
				return respondTunnel(call, { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy-tunnel', version: '1.0.0' } } });
			}
			respondTunnel(call);
		}, 'auto');
		assert.deepStrictEqual({
			era: handler.negotiated.era,
			server: handler.serverInfo.name,
			first: calls.slice(0, 2),
			typed: calls.filter(c => c.path !== TUNNEL_CALL_PATH),
		}, {
			era: 'legacy',
			server: 'legacy-tunnel',
			first: [{ path: TUNNEL_CALL_PATH, method: 'server/discover' }, { path: TUNNEL_CALL_PATH, method: 'initialize' }],
			typed: [],
		});
	});

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

suite('ExtHostMcpService - the mcpGrpcServerDefinition proposal', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IUpsert {
		readonly collectionId: string;
		readonly launchTypes: McpServerTransportType[];
		readonly labels: string[];
	}

	class ErrorCapturingLogService extends NullLogService {
		readonly errors: string[] = [];
		override error(message: string | Error): void {
			this.errors.push(String(message));
		}
	}

	function createService(upserts: IUpsert[], logService: ILogService = new NullLogService()): ExtHostMcpService {
		const proxy = new class extends mock<MainThreadMcpShape>() {
			override $upsertMcpCollection(collection: McpCollectionDefinition.FromExtHost, servers: McpServerDefinition.Serialized[]): void {
				upserts.push({ collectionId: collection.id, launchTypes: servers.map(s => s.launch.type), labels: servers.map(s => s.label) });
			}
			override $deleteMcpCollection(): void { }
		};
		const initData = new class extends mock<IExtHostInitDataService>() {
			override readonly remote = { isRemote: false, authority: undefined, connectionData: null };
		};
		return store.add(new ExtHostMcpService(SingleProxyRPCProtocol(proxy), logService, initData, new class extends mock<IExtHostWorkspace>() { }, new class extends mock<IExtHostVariableResolverProvider>() { }));
	}

	function extensionWith(enabledApiProposals: string[]): IExtensionDescription {
		return {
			...nullExtensionDescription,
			identifier: new ExtensionIdentifier('vscode.grpc-provider'),
			enabledApiProposals,
			contributes: { mcpServerDefinitionProviders: [{ id: 'servers', label: 'Servers' }] },
		};
	}

	const httpDefinition = () => new McpHttpServerDefinition('server', URI.parse('https://mcp.example/mcp'));
	const grpcDefinition = () => new McpGrpcServerDefinition('server', URI.parse('grpc://mcp.example:50051'));

	/** Runs `run` and returns the promise rejections nobody handled meanwhile (provider updates run detached). */
	async function unhandledRejectionsOf(run: () => Promise<void>): Promise<unknown[]> {
		const reasons: unknown[] = [];
		const listener = (reason: unknown) => reasons.push(reason);
		const saved = process.listeners('unhandledRejection');
		process.removeAllListeners('unhandledRejection');
		process.on('unhandledRejection', listener);
		try {
			await run();
			await timeout(20);
		} finally {
			process.removeListener('unhandledRejection', listener);
			for (const handler of saved) {
				process.on('unhandledRejection', handler);
			}
		}
		return reasons;
	}

	test('a gRPC definition from resolveMcpServerDefinition needs the proposal too', async () => {
		const launches: unknown[] = [];
		for (const proposals of [[], ['mcpGrpcServerDefinition']]) {
			const upserts: IUpsert[] = [];
			const service = createService(upserts);
			store.add(service.registerMcpConfigurationProvider(extensionWith(proposals), 'servers', {
				provideMcpServerDefinitions: () => [httpDefinition()],
				resolveMcpServerDefinition: () => grpcDefinition(),
			}));
			await service.$waitForInitialCollectionProviders();
			assert.deepStrictEqual(upserts.map(u => u.launchTypes), [[McpServerTransportType.HTTP]]);
			launches.push(await service.$resolveMcpLaunch(upserts[0].collectionId, 'server').then(launch => launch?.type, (e: Error) => e.message.includes('CANNOT use API proposal: mcpGrpcServerDefinition') ? 'proposal error' : e.message));
		}
		assert.deepStrictEqual(launches, ['proposal error', McpServerTransportType.Grpc]);
	});

	test('a gRPC definition from provideMcpServerDefinitions needs the proposal', async function () {
		// The rejection is observed through process 'unhandledRejection'; in the Electron unit-test renderer it
		// goes to the window's 'unhandledrejection' event instead, which the runner reports as an unexpected error.
		if (process.versions.electron) {
			this.skip();
		}
		const outcomes: unknown[] = [];
		for (const proposals of [[], ['mcpGrpcServerDefinition']]) {
			const upserts: IUpsert[] = [];
			const service = createService(upserts);
			const rejections = await unhandledRejectionsOf(async () => {
				store.add(service.registerMcpConfigurationProvider(extensionWith(proposals), 'servers', { provideMcpServerDefinitions: () => [grpcDefinition()] }));
				await service.$waitForInitialCollectionProviders();
			});
			outcomes.push({
				upserts: upserts.map(u => u.launchTypes),
				rejections: rejections.map(r => r instanceof Error && r.message.includes('CANNOT use API proposal: mcpGrpcServerDefinition') ? 'proposal error' : String(r)),
			});
		}
		assert.deepStrictEqual(outcomes, [
			{ upserts: [], rejections: ['proposal error'] },
			{ upserts: [[McpServerTransportType.Grpc]], rejections: [] },
		]);
	});

	test('a gRPC definition whose URI is not grpc:// or grpcs:// is left out with an error, and the other servers of the provider stay', async () => {
		const upserts: IUpsert[] = [];
		const log = new ErrorCapturingLogService();
		const service = createService(upserts, log);
		const rejections = await unhandledRejectionsOf(async () => {
			store.add(service.registerMcpConfigurationProvider(extensionWith(['mcpGrpcServerDefinition']), 'servers', {
				provideMcpServerDefinitions: () => [
					new McpGrpcServerDefinition('good', URI.parse('grpcs://mcp.example:443')),
					new McpGrpcServerDefinition('bad', URI.parse('https://mcp.example/mcp')),
					new McpHttpServerDefinition('http', URI.parse('https://mcp.example/mcp')),
				],
			}));
			await service.$waitForInitialCollectionProviders();
		});
		const resolved = await service.$resolveMcpLaunch(upserts[0].collectionId, 'bad');
		assert.deepStrictEqual({
			upserts: upserts.map(u => ({ types: u.launchTypes, labels: u.labels })),
			rejections,
			resolved,
			errors: log.errors.map(e => e.includes(`'bad'`) && e.includes('https://mcp.example/mcp') && e.includes('grpc://')),
		}, {
			upserts: [{ types: [McpServerTransportType.Grpc, McpServerTransportType.HTTP], labels: ['good', 'http'] }],
			rejections: [],
			resolved: undefined,
			errors: [true],
		});
	});

	test('a resolved gRPC definition whose URI is not grpc:// or grpcs:// fails the launch of that server with the reason', async () => {
		const upserts: IUpsert[] = [];
		const service = createService(upserts);
		store.add(service.registerMcpConfigurationProvider(extensionWith(['mcpGrpcServerDefinition']), 'servers', {
			provideMcpServerDefinitions: () => [httpDefinition()],
			resolveMcpServerDefinition: () => new McpGrpcServerDefinition('server', URI.parse('https://mcp.example:50051')),
		}));
		await service.$waitForInitialCollectionProviders();
		await assert.rejects(service.$resolveMcpLaunch(upserts[0].collectionId, 'server'), (e: Error) => {
			assert.strictEqual(e.message, `The URL of a gRPC MCP server must start with 'grpc://' or 'grpcs://', but was 'https://mcp.example:50051/'.`);
			return true;
		});
	});

	test('keepAliveMs of a McpGrpcServerDefinition reaches the launch, with the meaning it has in mcp.json', async () => {
		const upserts: IUpsert[] = [];
		const service = createService(upserts);
		const withKeepAlive = (label: string, keepAliveMs: number | undefined) => {
			const definition = new McpGrpcServerDefinition(label, URI.parse('grpcs://mcp.example:443'));
			definition.keepAliveMs = keepAliveMs;
			return definition;
		};
		store.add(service.registerMcpConfigurationProvider(extensionWith(['mcpGrpcServerDefinition']), 'servers', {
			provideMcpServerDefinitions: () => [withKeepAlive('off', 0), withKeepAlive('while-calls', 600_000), withKeepAlive('default', undefined)],
		}));
		await service.$waitForInitialCollectionProviders();
		const keepAlives: unknown[] = [];
		for (const label of ['off', 'while-calls', 'default']) {
			const launch = await service.$resolveMcpLaunch(upserts[0].collectionId, label);
			const keepAliveMs = launch?.type === McpServerTransportType.Grpc ? launch.keepAliveMs : 'not a gRPC launch';
			keepAlives.push({ label, keepAliveMs, channel: typeof keepAliveMs === 'string' ? undefined : grpcKeepAliveFor(keepAliveMs) });
		}
		assert.deepStrictEqual(keepAlives, [
			{ label: 'off', keepAliveMs: 0, channel: {} },
			{ label: 'while-calls', keepAliveMs: 600_000, channel: { keepAliveTimeMs: 600_000 } },
			{ label: 'default', keepAliveMs: undefined, channel: { longLivedKeepAliveTimeMs: DEFAULT_GRPC_LISTEN_KEEPALIVE_MS } },
		]);
	});

	test('a McpGrpcServerDefinition with the default binding or McpGrpcBinding.Auto against a server without the tunnel fails with the hint that names McpGrpcBinding.Typed, the fix only its extension can make', async () => {
		const upserts: IUpsert[] = [];
		const service = createService(upserts);
		store.add(service.registerMcpConfigurationProvider(extensionWith(['mcpGrpcServerDefinition']), 'servers', {
			provideMcpServerDefinitions: () => [
				new McpGrpcServerDefinition('default', URI.parse('grpcs://mcp.example:443')),
				new McpGrpcServerDefinition('auto', URI.parse('grpcs://mcp.example:443'), undefined, undefined, undefined, McpGrpcBinding.Auto),
			],
		}));
		await service.$waitForInitialCollectionProviders();
		const outcomes: unknown[] = [];
		for (const label of ['default', 'auto']) {
			const serialized = await service.$resolveMcpLaunch(upserts[0].collectionId, label);
			const launch = serialized && McpServerLaunch.fromSerialized(serialized);
			assert.ok(launch?.type === McpServerTransportType.Grpc, `expected a gRPC launch, got ${JSON.stringify(serialized)}`);
			const f = createFixture(store, call => call.finish(GrpcStatus.UNIMPLEMENTED, {}, 'unknown service'), { launch });
			await f.handle.send(request(1, 'server/discover'), envelope('server/discover', 1));
			outcomes.push({
				label,
				binding: launch.binding,
				speaks: f.handle.binding,
				paths: f.channel.calls.map(c => c.path),
				aborts: f.aborts,
				namesTheApiFix: f.aborts.length > 0 && f.aborts.every(a => a.message?.includes('McpGrpcBinding.Typed')),
			});
		}
		assert.deepStrictEqual(outcomes, [undefined, 'auto'].map((binding, i) => ({
			label: ['default', 'auto'][i],
			binding,
			speaks: 'tunnel',
			paths: [TUNNEL_CALL_PATH],
			aborts: [{ requestId: 1, reason: 'transport-error', grpcStatus: GrpcStatus.UNIMPLEMENTED, message: noTunnelMessage('mcp.example:443', 'unknown service') }],
			namesTheApiFix: true,
		})));
	});
});
