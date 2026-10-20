/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IJsonRpcErrorResponse, IJsonRpcSuccessResponse, JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../../common/mcpGateway.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { CONFORMANCE_HIDDEN_TOOL, CONFORMANCE_INSTRUCTIONS, CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { IMcpGatewayNotification, McpGatewayDispatcher } from '../../node/mcpGatewayDispatcher.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';
import { IMcpGatewayRequestBroker, IMcpGatewaySessionStream, isInitializeMessage, McpGatewaySession } from '../../node/mcpGatewaySession.js';

/** A session stream that records what it carries; server requests get their ids from the session. */
class TestStream extends Disposable implements IMcpGatewaySessionStream {
	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;
	private readonly _onDidSendRequest = this._register(new Emitter<void>());
	readonly notifications: IMcpGatewayNotification[] = [];
	readonly requests: Array<IMcpGatewayNotification & { readonly id: JsonRpcId }> = [];
	private _open = true;

	constructor(private readonly _broker: IMcpGatewayRequestBroker) {
		super();
	}

	get isOpen(): boolean {
		return this._open;
	}

	get methods(): string[] {
		return this.notifications.map(n => n.method);
	}

	notify(notification: IMcpGatewayNotification): void {
		this.notifications.push(notification);
	}

	sendRequest(request: IMcpGatewayNotification, token?: CancellationToken): Promise<unknown> {
		const pending = this._broker.createRequest(token);
		this.requests.push({ ...request, id: pending.id });
		this._onDidSendRequest.fire();
		return pending.result;
	}

	/** Resolves with the `index`-th server request once it has been sent. */
	async request(index: number): Promise<IMcpGatewayNotification & { readonly id: JsonRpcId }> {
		while (this.requests.length <= index) {
			await Event.toPromise(this._onDidSendRequest.event);
		}
		return this.requests[index];
	}

	end(): void {
		if (this._open) {
			this._open = false;
			this._onDidClose.fire();
		}
	}
}

suite('MCP - GatewaySession', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const logger = new NullLogService();

	function setup(invoker?: IMcpGatewaySingleServerInvoker) {
		const upstream = invoker ?? store.add(new McpGatewayConformanceInvoker());
		const dispatcher = store.add(new McpGatewayDispatcher('route-1', logger, upstream, new McpGatewaySealedState(), { serverInfo: CONFORMANCE_SERVER_INFO }));
		let disposed = 0;
		const session = store.add(new McpGatewaySession('session-1', logger, dispatcher, upstream, () => { disposed++; }));
		return { session, invoker: upstream, disposedCount: () => disposed };
	}

	async function initialize(session: McpGatewaySession, capabilities: MCP.ClientCapabilities = { sampling: {}, elicitation: {}, roots: {} }): Promise<void> {
		await session.handleIncoming({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'test-client', version: '1.0.0' } } });
		await session.handleIncoming({ jsonrpc: '2.0', method: 'notifications/initialized' });
	}

	function resultOf(responses: unknown[]): Record<string, unknown> {
		assert.strictEqual(responses.length, 1);
		const response = responses[0] as IJsonRpcSuccessResponse;
		assert.ok(response.result !== undefined, `expected a result, got ${JSON.stringify(response)}`);
		return response.result as Record<string, unknown>;
	}

	function errorOf(responses: unknown[]): IJsonRpcErrorResponse['error'] {
		assert.strictEqual(responses.length, 1);
		return (responses[0] as IJsonRpcErrorResponse).error;
	}

	test('initialize returns server info, capabilities (completions, logging, subscribe) and instructions', async () => {
		const { session } = setup();
		const responses = await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { sampling: {} }, clientInfo: { name: 'test-client', version: '1.0.0' } } });
		assert.strictEqual((responses[0] as IJsonRpcSuccessResponse).id, 1);
		const result = resultOf(responses) as unknown as MCPLegacy.InitializeResult;
		assert.deepStrictEqual(result, {
			protocolVersion: '2025-11-25',
			capabilities: {
				tools: { listChanged: true },
				resources: { subscribe: true, listChanged: true },
				prompts: { listChanged: true },
				logging: {},
				completions: {},
			},
			serverInfo: CONFORMANCE_SERVER_INFO,
			instructions: CONFORMANCE_INSTRUCTIONS,
		});
		assert.strictEqual(session.protocolVersion, '2025-11-25');
		assert.deepStrictEqual(session.clientCapabilities, { sampling: {} });
		assert.strictEqual(session.isInitialized, false, 'initialized only after notifications/initialized');
	});

	test('negotiates each supported legacy version and falls back to the latest otherwise', async () => {
		for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
			const { session } = setup();
			const result = resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {} } }));
			assert.strictEqual(result.protocolVersion, version);
		}
		for (const params of [{ protocolVersion: '2099-01-01', capabilities: {} }, { protocolVersion: 42 }, undefined]) {
			const { session } = setup();
			const result = resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'initialize', ...(params ? { params } : {}) }));
			assert.strictEqual(result.protocolVersion, '2025-11-25');
		}
	});

	test('rejects requests before notifications/initialized, except ping', async () => {
		const { session } = setup();
		assert.deepStrictEqual(resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'ping' })), {});
		const error = errorOf(await session.handleIncoming({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
		assert.strictEqual(error.code, MCP.INVALID_REQUEST);
	});

	test('serves the dispatcher methods with legacy shapes after initialization', async () => {
		const { session } = setup();
		await initialize(session);
		assert.ok(session.isInitialized);
		const tools = resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
		assert.ok((tools.tools as MCPLegacy.Tool[]).some(t => t.name === 'test_simple_text'));
		assert.strictEqual(tools.resultType, undefined, 'no 2026-07-28 envelope');
		const call = resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'test_simple_text', arguments: {} } }));
		assert.deepStrictEqual(call.content, [{ type: 'text', text: 'This is a simple text response for testing.' }]);
		const read = resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'test://template/123/data' } }));
		assert.ok(((read.contents as Array<{ text: string }>)[0].text).includes('123'));
		const missing = errorOf(await session.handleIncoming({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'test://missing' } }));
		assert.strictEqual(missing.code, -32002);
		const unknown = errorOf(await session.handleIncoming({ jsonrpc: '2.0', id: 7, method: 'server/discover' }));
		assert.strictEqual(unknown.code, MCP.METHOD_NOT_FOUND);
		// A batch yields the responses in order.
		const batch = await session.handleIncoming([{ jsonrpc: '2.0', id: 8, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/progress', params: {} }, { jsonrpc: '2.0', id: 9, method: 'ping' }]);
		assert.deepStrictEqual(batch.map(r => (r as IJsonRpcSuccessResponse).id), [8, 9]);
	});

	test('broadcasts list changes on its streams once initialized; closed streams are forgotten', async () => {
		const { session, invoker } = setup();
		const conformance = invoker as McpGatewayConformanceInvoker;
		const stream = store.add(new TestStream(session));
		session.attachStream(stream);
		conformance.setToolHidden(CONFORMANCE_HIDDEN_TOOL, false);
		assert.deepStrictEqual(stream.methods, [], 'nothing before initialization');
		await initialize(session);
		conformance.setToolHidden(CONFORMANCE_HIDDEN_TOOL, true);
		conformance.setPromptHidden('test_hidden_prompt', false);
		assert.deepStrictEqual(stream.methods, ['notifications/tools/list_changed', 'notifications/prompts/list_changed']);
		assert.strictEqual(session.streamCount, 1);
		stream.end();
		assert.strictEqual(session.streamCount, 0);
	});

	test('logging/setLevel is stored and filters the log notifications of later calls', async () => {
		const { session } = setup();
		await initialize(session);
		assert.strictEqual(errorOf(await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'logging/setLevel', params: { level: 'loud' } })).code, MCP.INVALID_PARAMS);
		assert.deepStrictEqual(resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 2, method: 'logging/setLevel', params: { level: 'warning' } })), {});
		assert.strictEqual(session.logLevel, 'warning');
		const quiet = store.add(new TestStream(session));
		await session.handleIncoming({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'test_tool_with_logging', arguments: {} } }, quiet);
		assert.deepStrictEqual(quiet.methods, []);
		await session.handleIncoming({ jsonrpc: '2.0', id: 4, method: 'logging/setLevel', params: { level: 'debug' } });
		const loud = store.add(new TestStream(session));
		await session.handleIncoming({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'test_tool_with_logging', arguments: {} } }, loud);
		assert.deepStrictEqual(loud.methods, ['notifications/message', 'notifications/message', 'notifications/message']);
	});

	test('progress notifications go to the request\'s own stream', async () => {
		const { session } = setup();
		await initialize(session);
		const sink = store.add(new TestStream(session));
		await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test_tool_with_progress', arguments: {}, _meta: { progressToken: 'tok' } } }, sink);
		assert.deepStrictEqual(sink.notifications.map(n => (n.params as { progress: number }).progress), [0, 50, 100]);
	});

	test('resources/subscribe forwards updates until resources/unsubscribe', async () => {
		const { session, invoker } = setup();
		const conformance = invoker as McpGatewayConformanceInvoker;
		await initialize(session);
		const stream = store.add(new TestStream(session));
		session.attachStream(stream);
		assert.deepStrictEqual(resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'test://watched-resource' } })), {});
		assert.strictEqual(conformance.subscriptionCount('test://watched-resource'), 1);
		conformance.touchResource('test://static-text');
		conformance.touchResource('test://watched-resource');
		assert.deepStrictEqual(stream.notifications, [{ method: 'notifications/resources/updated', params: { uri: 'test://watched-resource' } }]);
		assert.deepStrictEqual(resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 2, method: 'resources/unsubscribe', params: { uri: 'test://watched-resource' } })), {});
		assert.strictEqual(conformance.subscriptionCount('test://watched-resource'), 0);
		conformance.touchResource('test://watched-resource');
		assert.strictEqual(stream.notifications.length, 1);
		assert.strictEqual(errorOf(await session.handleIncoming({ jsonrpc: '2.0', id: 3, method: 'resources/subscribe', params: {} })).code, MCP.INVALID_PARAMS);
	});

	test('server→client requests go to the sink and resolve with the client\'s answer', async () => {
		const { session } = setup();
		await initialize(session);
		const sink = store.add(new TestStream(session));
		const call = session.handleIncoming({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'test_sampling', arguments: { prompt: 'Say hi' } } }, sink);
		const request = await sink.request(0);
		assert.strictEqual(request.method, 'sampling/createMessage');
		assert.deepStrictEqual((request.params as { messages: unknown }).messages, [{ role: 'user', content: { type: 'text', text: 'Say hi' } }]);
		assert.strictEqual(session.pendingRequestCount, 1);
		// The answer arrives on another POST.
		assert.deepStrictEqual(await session.handleIncoming({ jsonrpc: '2.0', id: request.id, result: { role: 'assistant', content: { type: 'text', text: 'Hi!' }, model: 'm', stopReason: 'endTurn' } }), []);
		const result = resultOf(await call);
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'LLM response: Hi!' }]);
		assert.strictEqual(session.pendingRequestCount, 0);
	});

	test('a client error answer fails the request; without the capability the call is -32021', async () => {
		const { session } = setup();
		await initialize(session, { elicitation: {} });
		const sink = store.add(new TestStream(session));
		const call = session.handleIncoming({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'test_elicitation', arguments: { message: 'Who?' } } }, sink);
		const elicitation = await sink.request(0);
		await session.handleIncoming({ jsonrpc: '2.0', id: elicitation.id, error: { code: -32600, message: 'User refused' } });
		assert.strictEqual(errorOf(await call).code, -32600);
		const noSampling = errorOf(await session.handleIncoming({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'test_sampling', arguments: { prompt: 'x' } } }, sink));
		assert.strictEqual(noSampling.code, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY);
	});

	test('notifications/cancelled and the POST\'s token cancel in-flight requests without a response', async () => {
		const { session } = setup();
		await initialize(session);
		const sink = store.add(new TestStream(session));
		// The request is in flight as soon as handleIncoming returns its promise.
		const call = session.handleIncoming({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'test_tool_with_progress', arguments: {} } }, sink);
		await session.handleIncoming({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow', reason: 'test' } });
		assert.deepStrictEqual(await call, []);

		const cts = new CancellationTokenSource();
		const viaToken = session.handleIncoming({ jsonrpc: '2.0', id: 'slow-2', method: 'tools/call', params: { name: 'test_sampling', arguments: { prompt: 'x' } } }, sink, {}, cts.token);
		await sink.request(0);
		cts.cancel();
		assert.deepStrictEqual(await viaToken, []);
		assert.strictEqual(session.pendingRequestCount, 0);
		cts.dispose();
	});

	test('dispose ends the streams, fails pending server requests and reports itself', async () => {
		const { session, disposedCount } = setup();
		await initialize(session);
		const stream = store.add(new TestStream(session));
		session.attachStream(stream);
		const call = session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test_sampling', arguments: { prompt: 'x' } } });
		await stream.request(0);
		session.dispose();
		assert.deepStrictEqual(await call, []);
		assert.strictEqual(stream.isOpen, false);
		assert.strictEqual(disposedCount(), 1);
	});

	test('a server request for an already-cancelled request is refused at once', async () => {
		const { session } = setup();
		const cts = new CancellationTokenSource();
		cts.cancel();
		await assert.rejects(session.createRequest(cts.token).result, (error: unknown) => error instanceof CancellationError);
		assert.strictEqual(session.pendingRequestCount, 0);
		cts.dispose();
	});

	test('isInitializeMessage recognizes single and batched initialize requests', () => {
		assert.strictEqual(isInitializeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }), true);
		assert.strictEqual(isInitializeMessage([{ jsonrpc: '2.0', id: 1, method: 'initialize' }]), true);
		assert.strictEqual(isInitializeMessage({ jsonrpc: '2.0', method: 'initialize' }), false);
		assert.strictEqual(isInitializeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), false);
	});
});
