/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { upcast } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogger, ILoggerService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TestLoggerService, TestProductService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IMcpHostDelegate } from '../../common/mcpRegistryTypes.js';
import { IMcpServerRequestHandlerOptions, McpProtocolFailure, McpServerRequestHandler, McpTask } from '../../common/mcpServerRequestHandler.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpClientError, McpConnectionState, McpServerDefinition, McpServerLaunch, McpServerTransportType, MpcResponseError } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { TEST_MODERN_SERVER_INFO, TestMcpMessageTransport } from './mcpRegistryTypes.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { McpTaskManager } from '../../common/mcpTaskManager.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { IJsonRpcRequest, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, JsonRpcId, JsonRpcMessage } from '../../../../../base/common/jsonRpcProtocol.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_LOG_LEVEL, META_PROTOCOL_VERSION, MODERN_MCP_PROTOCOL_VERSIONS } from '../../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../../platform/mcp/common/modelContextProtocol.js';
import { buildClientCapabilities, McpProtocolEvent } from '../../common/mcpProtocolMeta.js';
import { GrpcStatus } from '../../../../../base/common/grpc/status.js';

class TestMcpHostDelegate extends Disposable implements IMcpHostDelegate {
	private readonly _transport: TestMcpMessageTransport;

	priority = 0;

	constructor() {
		super();
		this._transport = this._register(new TestMcpMessageTransport());
	}


	substituteVariables(serverDefinition: McpServerDefinition, launch: McpServerLaunch): Promise<McpServerLaunch> {
		return Promise.resolve(launch);
	}

	expandEnvironmentVariables(serverDefinition: McpServerDefinition, launch: McpServerLaunch): Promise<McpServerLaunch> {
		return Promise.resolve(launch);
	}

	canStart(): boolean {
		return true;
	}

	start(): TestMcpMessageTransport {
		return this._transport;
	}

	getTransport(): TestMcpMessageTransport {
		return this._transport;
	}

	waitForInitialProviderPromises(): Promise<void> {
		return Promise.resolve();
	}
}

suite('Workbench - MCP - ServerRequestHandler', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let delegate: TestMcpHostDelegate;
	let transport: TestMcpMessageTransport;
	let handler: McpServerRequestHandler;
	let cts: CancellationTokenSource;

	setup(async () => {
		delegate = store.add(new TestMcpHostDelegate());
		transport = delegate.getTransport();
		cts = store.add(new CancellationTokenSource());

		// Setup test services
		const services = new ServiceCollection(
			[ILoggerService, store.add(new TestLoggerService())],
			[IOutputService, upcast({ showChannel: () => { } })],
			[IStorageService, store.add(new TestStorageService())],
			[IProductService, TestProductService],
		);

		instantiationService = store.add(new TestInstantiationService(services));

		transport.setConnectionState({ state: McpConnectionState.Kind.Running });

		// Manually create the handler since we need the transport already set up
		const logger = store.add((instantiationService.get(ILoggerService) as TestLoggerService)
			.createLogger('mcpServerTest', { hidden: true, name: 'MCP Test' }));

		// Start the handler creation
		const handlerPromise = McpServerRequestHandler.create(instantiationService, { logger, launch: transport, taskManager: store.add(new McpTaskManager()) }, cts.token);

		handler = await handlerPromise;
		store.add(handler);
	});

	test('sends initialize with the 2025-11-25 protocol version on the legacy wire', () => {
		const sentRequests = transport.getSentRequests();
		// The modern probe goes first; a legacy server rejects it and the handshake follows.
		assert.strictEqual(sentRequests[0].method, 'server/discover');
		const initializeRequest = sentRequests[1] as MCPLegacy.JSONRPCRequest;
		assert.strictEqual(initializeRequest.method, 'initialize');
		assert.strictEqual(handler.era, 'legacy');
		assert.strictEqual(handler.protocolVersion, '2025-11-25');
		// The literal is intentional: the wire version must not change when the generated schema moves on.
		assert.strictEqual(initializeRequest.params?.protocolVersion, '2025-11-25');
		assert.strictEqual(MCPLegacy.LATEST_PROTOCOL_VERSION, '2025-11-25');
	});

	test('should send and receive JSON-RPC requests', async () => {
		// Setup request
		const requestPromise = handler.listResources();

		// Get the sent message and verify it
		const sentMessages = transport.getSentMessages();
		assert.strictEqual(sentMessages.length, 4); // discover + initialize + initialized + listResources

		// Verify listResources request format
		const listResourcesRequest = sentMessages[3] as MCPLegacy.JSONRPCRequest;
		assert.strictEqual(listResourcesRequest.method, 'resources/list');
		assert.strictEqual(listResourcesRequest.jsonrpc, MCPLegacy.JSONRPC_VERSION);
		assert.ok(typeof listResourcesRequest.id === 'number');

		// Simulate server response with mock resources that match the expected Resource interface
		transport.simulateReceiveMessage({
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: listResourcesRequest.id,
			result: {
				resources: [
					{ uri: 'resource1', type: 'text/plain', name: 'Test Resource 1' },
					{ uri: 'resource2', type: 'text/plain', name: 'Test Resource 2' }
				]
			}
		});

		// Verify the result
		const resources = await requestPromise;
		assert.strictEqual(resources.length, 2);
		assert.strictEqual(resources[0].uri, 'resource1');
		assert.strictEqual(resources[1].name, 'Test Resource 2');
	});

	test('should handle paginated requests', async () => {
		// Setup request
		const requestPromise = handler.listResources();

		// Get the first request and respond with pagination
		const sentMessages = transport.getSentMessages();
		const listResourcesRequest = sentMessages[3] as MCPLegacy.JSONRPCRequest;

		// Send first page with nextCursor
		transport.simulateReceiveMessage({
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: listResourcesRequest.id,
			result: {
				resources: [
					{ uri: 'resource1', type: 'text/plain', name: 'Test Resource 1' }
				],
				nextCursor: 'page2'
			}
		});

		// Clear the sent messages to only capture the next page request
		transport.clearSentMessages();

		// Wait a bit to allow the handler to process and send the next request
		await new Promise(resolve => setTimeout(resolve, 0));

		// Get the second request and verify cursor is included
		const sentMessages2 = transport.getSentMessages();
		assert.strictEqual(sentMessages2.length, 1);

		const listResourcesRequest2 = sentMessages2[0] as MCPLegacy.JSONRPCRequest;
		assert.strictEqual(listResourcesRequest2.method, 'resources/list');
		assert.deepStrictEqual(listResourcesRequest2.params, { cursor: 'page2' });

		// Send final page with no nextCursor
		transport.simulateReceiveMessage({
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: listResourcesRequest2.id,
			result: {
				resources: [
					{ uri: 'resource2', type: 'text/plain', name: 'Test Resource 2' }
				]
			}
		});

		// Verify the combined result
		const resources = await requestPromise;
		assert.strictEqual(resources.length, 2);
		assert.strictEqual(resources[0].uri, 'resource1');
		assert.strictEqual(resources[1].uri, 'resource2');
	});

	test('should handle error responses', async () => {
		// Setup request
		const requestPromise = handler.readResource({ uri: 'non-existent' });

		// Get the sent message
		const sentMessages = transport.getSentMessages();
		const readResourceRequest = sentMessages[3] as MCPLegacy.JSONRPCRequest; // [0] is server/discover, [1] initialize, [2] notifications/initialized

		// Simulate error response
		transport.simulateReceiveMessage({
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: readResourceRequest.id,
			error: {
				code: MCPLegacy.METHOD_NOT_FOUND,
				message: 'Resource not found'
			}
		});

		// Verify the error is thrown correctly
		try {
			await requestPromise;
			assert.fail('Expected error was not thrown');
		} catch (e: unknown) {
			assert.strictEqual((e as Error).message, 'MPC -32601: Resource not found');
			assert.strictEqual((e as { code: number }).code, MCPLegacy.METHOD_NOT_FOUND);
		}
	});

	test('should handle server requests', async () => {
		// Simulate ping request from server
		const pingRequest: MCPLegacy.JSONRPCRequest & MCPLegacy.PingRequest = {
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: 100,
			method: 'ping'
		};

		transport.simulateReceiveMessage(pingRequest);

		// The handler should have sent a response
		const sentMessages = transport.getSentMessages();
		const pingResponse = sentMessages.find(m =>
			'id' in m && m.id === pingRequest.id && 'result' in m
		) as MCPLegacy.JSONRPCResultResponse;

		assert.ok(pingResponse, 'No ping response was sent');
		assert.deepStrictEqual(pingResponse.result, {});
	});

	test('should handle roots list requests', async () => {
		// Set roots
		handler.roots = [
			{ uri: 'file:///test/root1', name: 'Root 1' },
			{ uri: 'file:///test/root2', name: 'Root 2' }
		];

		// Simulate roots/list request from server
		const rootsRequest: MCPLegacy.JSONRPCRequest & MCPLegacy.ListRootsRequest = {
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: 101,
			method: 'roots/list'
		};

		transport.simulateReceiveMessage(rootsRequest);

		// The handler should have sent a response
		const sentMessages = transport.getSentMessages();
		const rootsResponse = sentMessages.find(m =>
			'id' in m && m.id === rootsRequest.id && 'result' in m
		) as MCPLegacy.JSONRPCResultResponse;

		assert.ok(rootsResponse, 'No roots/list response was sent');
		assert.strictEqual((rootsResponse.result as MCPLegacy.ListRootsResult).roots.length, 2);
		assert.strictEqual((rootsResponse.result as MCPLegacy.ListRootsResult).roots[0].uri, 'file:///test/root1');
	});

	test('should handle server notifications', async () => {
		let progressNotificationReceived = false;
		store.add(handler.onDidReceiveProgressNotification(notification => {
			progressNotificationReceived = true;
			assert.strictEqual(notification.method, 'notifications/progress');
			assert.strictEqual(notification.params.progressToken, 'token1');
			assert.strictEqual(notification.params.progress, 50);
		}));

		// Simulate progress notification with correct format
		const progressNotification: MCPLegacy.JSONRPCNotification & MCPLegacy.ProgressNotification = {
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			method: 'notifications/progress',
			params: {
				progressToken: 'token1',
				progress: 50,
				total: 100
			}
		};

		transport.simulateReceiveMessage(progressNotification);
		assert.strictEqual(progressNotificationReceived, true);
	});

	test('should handle cancellation', async () => {
		// Setup a new cancellation token source for this specific test
		const testCts = store.add(new CancellationTokenSource());
		const requestPromise = handler.listResources(undefined, testCts.token);

		// Get the request ID
		const sentMessages = transport.getSentMessages();
		const listResourcesRequest = sentMessages[3] as MCPLegacy.JSONRPCRequest;
		const requestId = listResourcesRequest.id;

		// Cancel the request
		testCts.cancel();

		// Check that a cancellation notification was sent
		const cancelNotification = transport.getSentMessages().find(m =>
			!('id' in m) &&
			'method' in m &&
			m.method === 'notifications/cancelled' &&
			'params' in m &&
			m.params && (m.params as { requestId?: unknown }).requestId === requestId
		);

		assert.ok(cancelNotification, 'No cancellation notification was sent');

		// Verify the promise was cancelled
		try {
			await requestPromise;
			assert.fail('Promise should have been cancelled');
		} catch (e) {
			assert.strictEqual(e.name, 'Canceled');
		}
	});

	test('a cancelled notification from the server never cancels a client request with the same id', async () => {
		// notifications/cancelled names a request of its sender: here, a server request that may
		// already be answered (a late cancel). The client's own request with the same id keeps running.
		const requestPromise = handler.listResources();
		const listResourcesRequest = transport.getSentMessages()[3] as MCPLegacy.JSONRPCRequest;
		const requestId = listResourcesRequest.id;

		const cancelledNotification: MCPLegacy.JSONRPCNotification & MCPLegacy.CancelledNotification = {
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			method: 'notifications/cancelled',
			params: { requestId },
		};
		transport.simulateReceiveMessage(cancelledNotification);
		await timeout(0);

		transport.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: requestId, result: { resources: [{ uri: 'resource1', name: 'Still answered' }] } });
		const resources = await requestPromise;
		assert.deepStrictEqual(resources.map(r => r.name), ['Still answered']);
	});

	test('a late cancel of a completed sampling request leaves the client request with the same id running', async () => {
		const sampling = sinon.stub().resolves({ role: 'assistant', content: { type: 'text', text: 'done' }, model: 'm' });
		const legacy = store.add(new TestMcpMessageTransport());
		legacy.setConnectionState({ state: McpConnectionState.Kind.Running });
		const logger = store.add((instantiationService.get(ILoggerService) as TestLoggerService).createLogger('mcpServerTestLate', { hidden: true, name: 'MCP Test' }));
		const legacyHandler = store.add(await McpServerRequestHandler.create(instantiationService, { logger, launch: legacy, taskManager: store.add(new McpTaskManager()), createMessageRequestHandler: sampling }));

		const call = legacyHandler.callTool({ name: 'echo', arguments: {} });
		const callId = legacy.getSentRequests('tools/call')[0].id;
		// The server asks for sampling with the same numeric id and the client answers it…
		legacy.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: callId, method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } });
		await timeout(0);
		assert.ok(legacy.getSentMessages().some(m => isJsonRpcResponse(m) && m.id === callId), 'the sampling request was answered');
		// …then cancels it late: the pending tools/call must not be cancelled.
		legacy.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: callId } });
		await timeout(0);
		legacy.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: callId, result: { content: [{ type: 'text', text: 'call result' }] } });
		const result = await call;
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'call result' }]);
	});

	test('should dispose properly and cancel pending requests', async () => {
		// Setup multiple requests
		const request1 = handler.listResources();
		const request2 = handler.listTools();

		// Dispose the handler
		handler.dispose();

		// Verify all promises were cancelled
		try {
			await request1;
			assert.fail('Promise 1 should have been cancelled');
		} catch (e) {
			assert.strictEqual(e.name, 'Canceled');
		}

		try {
			await request2;
			assert.fail('Promise 2 should have been cancelled');
		} catch (e) {
			assert.strictEqual(e.name, 'Canceled');
		}
	});

	test('should handle connection error by cancelling requests', async () => {
		// Setup request
		const requestPromise = handler.listResources();

		// Simulate connection error
		transport.setConnectionState({
			state: McpConnectionState.Kind.Error,
			message: 'Connection lost'
		});

		// Verify the promise was cancelled
		try {
			await requestPromise;
			assert.fail('Promise should have been cancelled');
		} catch (e) {
			assert.strictEqual(e.name, 'Canceled');
		}
	});

	test('callTool forwards _meta.traceparent to the JSON-RPC payload (MCP SEP-414)', async () => {
		const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
		const tracestate = 'rojo=00f067aa0ba902b7';

		const callPromise = handler.callTool({
			name: 'echo',
			arguments: { hello: 'world' },
			_meta: { traceparent, tracestate, progressToken: 'tok-1' },
		});

		const sentMessages = transport.getSentMessages();
		const callRequest = sentMessages[3] as MCPLegacy.JSONRPCRequest & MCPLegacy.CallToolRequest;
		assert.strictEqual(callRequest.method, 'tools/call');
		assert.deepStrictEqual(callRequest.params._meta, {
			traceparent,
			tracestate,
			progressToken: 'tok-1',
		});

		transport.simulateReceiveMessage({
			jsonrpc: MCPLegacy.JSONRPC_VERSION,
			id: callRequest.id,
			result: { content: [] },
		});

		await callPromise;
	});
});

suite.skip('Workbench - MCP - McpTask', () => { // TODO@connor4312 https://github.com/microsoft/vscode/issues/280126
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let clock: sinon.SinonFakeTimers;

	setup(() => {
		clock = sinon.useFakeTimers();
	});

	teardown(() => {
		clock.restore();
	});

	function createTask(overrides: Partial<MCPLegacy.Task> = {}): MCPLegacy.Task {
		return {
			taskId: 'task1',
			status: 'working',
			createdAt: new Date().toISOString(),
			lastUpdatedAt: new Date().toISOString(),
			ttl: null,
			...overrides
		};
	}

	test('should resolve when task completes', async () => {
		const getTaskResultStub = sinon.stub().resolves({ content: [{ type: 'text', text: 'result' }] });
		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: sinon.stub().resolves(createTask({ status: 'completed' })),
			getTaskResult: getTaskResultStub
		});

		const task = store.add(new McpTask(createTask()));
		task.setHandler(mockHandler);

		// Advance time to trigger polling
		await clock.tickAsync(2000);

		// Update to completed state
		task.onDidUpdateState(createTask({ status: 'completed' }));

		const result = await task.result;
		assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'result' }] });
		assert.ok(getTaskResultStub.calledWith({ taskId: 'task1' }));
	});

	test('should poll for task updates', async () => {
		const getTaskStub = sinon.stub();
		getTaskStub.onCall(0).resolves(createTask({ status: 'working' }));
		getTaskStub.onCall(1).resolves(createTask({ status: 'working' }));
		getTaskStub.onCall(2).resolves(createTask({ status: 'completed' }));

		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub,
			getTaskResult: sinon.stub().resolves({ content: [{ type: 'text', text: 'result' }] })
		});

		const task = store.add(new McpTask(createTask({ pollInterval: 1000 })));
		task.setHandler(mockHandler);

		// First poll
		await clock.tickAsync(1000);
		assert.strictEqual(getTaskStub.callCount, 1);

		// Second poll
		await clock.tickAsync(1000);
		assert.strictEqual(getTaskStub.callCount, 2);

		// Third poll - completes
		await clock.tickAsync(1000);
		assert.strictEqual(getTaskStub.callCount, 3);

		const result = await task.result;
		assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'result' }] });
	});

	test('should use default poll interval if not specified', async () => {
		const getTaskStub = sinon.stub();
		getTaskStub.resolves(createTask({ status: 'working' }));

		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub,
		});

		const task = store.add(new McpTask(createTask()));
		task.setHandler(mockHandler);

		// Default poll interval is 2000ms
		await clock.tickAsync(2000);
		assert.strictEqual(getTaskStub.callCount, 1);

		await clock.tickAsync(2000);
		assert.strictEqual(getTaskStub.callCount, 2);

		task.dispose();
	});

	test('should reject when task fails', async () => {
		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: sinon.stub().resolves(createTask({
				status: 'failed',
				statusMessage: 'Something went wrong'
			}))
		});

		const task = store.add(new McpTask(createTask()));
		task.setHandler(mockHandler);

		// Update to failed state
		task.onDidUpdateState(createTask({
			status: 'failed',
			statusMessage: 'Something went wrong'
		}));

		await assert.rejects(
			task.result,
			(error: Error) => {
				assert.ok(error.message.includes('Task task1 failed'));
				assert.ok(error.message.includes('Something went wrong'));
				return true;
			}
		);
	});

	test('should cancel when task is cancelled', async () => {
		const task = store.add(new McpTask(createTask()));

		// Update to cancelled state
		task.onDidUpdateState(createTask({ status: 'cancelled' }));

		await assert.rejects(
			task.result,
			(error: Error) => {
				assert.strictEqual(error.name, 'Canceled');
				return true;
			}
		);
	});

	test('should cancel when cancellation token is triggered', async () => {
		const cts = store.add(new CancellationTokenSource());
		const task = store.add(new McpTask(createTask(), cts.token));

		// Cancel the token
		cts.cancel();

		await assert.rejects(
			task.result,
			(error: Error) => {
				assert.strictEqual(error.name, 'Canceled');
				return true;
			}
		);
	});

	test('should handle TTL expiration', async () => {
		const now = Date.now();
		clock.setSystemTime(now);

		const task = store.add(new McpTask(createTask({ ttl: 5000 })));

		// Advance time past TTL
		await clock.tickAsync(6000);

		await assert.rejects(
			task.result,
			(error: Error) => {
				assert.strictEqual(error.name, 'Canceled');
				return true;
			}
		);
	});

	test('should stop polling when in terminal state', async () => {
		const getTaskStub = sinon.stub();
		getTaskStub.resolves(createTask({ status: 'completed' }));

		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub,
			getTaskResult: sinon.stub().resolves({ content: [{ type: 'text', text: 'result' }] })
		});

		const task = store.add(new McpTask(createTask({ pollInterval: 1000 })));
		task.setHandler(mockHandler);

		// Update to completed state immediately
		task.onDidUpdateState(createTask({ status: 'completed' }));

		await task.result;

		// Advance time - should not poll anymore
		const initialCallCount = getTaskStub.callCount;
		await clock.tickAsync(5000);
		assert.strictEqual(getTaskStub.callCount, initialCallCount);
	});

	test('should handle handler reconnection', async () => {
		const getTaskStub1 = sinon.stub();
		getTaskStub1.resolves(createTask({ status: 'working' }));

		const mockHandler1 = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub1,
		});

		const task = store.add(new McpTask(createTask({ pollInterval: 1000 })));
		task.setHandler(mockHandler1);

		// First poll with handler1
		await clock.tickAsync(1000);
		assert.strictEqual(getTaskStub1.callCount, 1);

		// Switch to a new handler
		const getTaskStub2 = sinon.stub();
		getTaskStub2.resolves(createTask({ status: 'completed' }));

		const mockHandler2 = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub2,
			getTaskResult: sinon.stub().resolves({ content: [{ type: 'text', text: 'result' }] })
		});

		task.setHandler(mockHandler2);

		// Second poll with handler2
		await clock.tickAsync(1000);
		assert.strictEqual(getTaskStub1.callCount, 1); // No more calls to old handler
		assert.strictEqual(getTaskStub2.callCount, 1); // New handler is called

		const result = await task.result;
		assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'result' }] });
	});

	test('should not poll when handler is undefined', async () => {
		const task = store.add(new McpTask(createTask({ pollInterval: 1000 })));

		// Advance time - should not crash
		await clock.tickAsync(5000);

		// Now set a handler and it should start polling
		const getTaskStub = sinon.stub();
		getTaskStub.resolves(createTask({ status: 'completed' }));

		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub,
			getTaskResult: sinon.stub().resolves({ content: [{ type: 'text', text: 'result' }] })
		});

		task.setHandler(mockHandler);
		await clock.tickAsync(1000);
		assert.strictEqual(getTaskStub.callCount, 1);

		task.dispose();
	});

	test('should handle input_required state', async () => {
		const getTaskStub = sinon.stub();
		// getTask call returns completed (triggered by input_required handling)
		getTaskStub.resolves(createTask({ status: 'completed' }));

		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub,
			getTaskResult: sinon.stub().resolves({ content: [{ type: 'text', text: 'result' }] })
		});

		const task = store.add(new McpTask(createTask({ pollInterval: 1000 })));
		task.setHandler(mockHandler);

		// Update to input_required - this triggers a getTask call
		task.onDidUpdateState(createTask({ status: 'input_required' }));

		// Allow the promise to settle
		await clock.tickAsync(0);

		// Verify getTask was called
		assert.strictEqual(getTaskStub.callCount, 1);

		// Once getTask resolves with completed, should fetch result
		const result = await task.result;
		assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'result' }] });
	});

	test('should handle getTask returning cancelled during polling', async () => {
		const getTaskStub = sinon.stub();
		getTaskStub.resolves(createTask({ status: 'cancelled' }));

		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub,
		});

		const task = store.add(new McpTask(createTask({ pollInterval: 1000 })));
		task.setHandler(mockHandler);

		// Advance time to trigger polling
		await clock.tickAsync(1000);

		await assert.rejects(
			task.result,
			(error: Error) => {
				assert.strictEqual(error.name, 'Canceled');
				return true;
			}
		);
	});

	test('should return correct task id', () => {
		const task = store.add(new McpTask(createTask({ taskId: 'my-task-id' })));
		assert.strictEqual(task.id, 'my-task-id');
	});

	test('should dispose cleanly', async () => {
		const getTaskStub = sinon.stub();
		getTaskStub.resolves(createTask({ status: 'working' }));

		const mockHandler = upcastPartial<McpServerRequestHandler>({
			getTask: getTaskStub,
		});

		const task = store.add(new McpTask(createTask({ pollInterval: 1000 })));
		task.setHandler(mockHandler);

		// Poll once
		await clock.tickAsync(1000);
		const callCountBeforeDispose = getTaskStub.callCount;

		// Dispose
		task.dispose();

		// Advance time - should not poll anymore
		await clock.tickAsync(5000);
		assert.strictEqual(getTaskStub.callCount, callCountBeforeDispose);
	});
});

//#region dual-era engine helpers

interface ITestServices {
	readonly instantiationService: TestInstantiationService;
	readonly logger: ILogger;
}

function createTestServices(store: Pick<DisposableStore, 'add'>): ITestServices {
	const services = new ServiceCollection(
		[ILoggerService, store.add(new TestLoggerService())],
		[IOutputService, upcast({ showChannel: () => { } })],
		[IStorageService, store.add(new TestStorageService())],
		[IProductService, TestProductService],
	);
	const instantiationService = store.add(new TestInstantiationService(services));
	const logger = store.add((instantiationService.get(ILoggerService) as TestLoggerService).createLogger('mcpServerTest', { hidden: true, name: 'MCP Test' }));
	return { instantiationService, logger };
}

/** Marks the transport as running and starts the negotiation; the caller owns the handler. */
function beginConnect(store: Pick<DisposableStore, 'add'>, services: ITestServices, transport: TestMcpMessageTransport, options: Partial<IMcpServerRequestHandlerOptions> = {}, token = CancellationToken.None): Promise<McpServerRequestHandler> {
	transport.setConnectionState({ state: McpConnectionState.Kind.Running });
	return McpServerRequestHandler.create(services.instantiationService, {
		logger: services.logger,
		launch: transport,
		taskManager: store.add(new McpTaskManager()),
		...options,
	}, token);
}

/** Negotiates a handler over the transport and registers it in the store. */
async function connect(store: Pick<DisposableStore, 'add'>, services: ITestServices, transport: TestMcpMessageTransport, options: Partial<IMcpServerRequestHandlerOptions> = {}): Promise<McpServerRequestHandler> {
	return store.add(await beginConnect(store, services, transport, options));
}

/** A test transport that signals every message it sends and every request it cancels. */
class SignallingTransport extends TestMcpMessageTransport {
	private readonly _onDidSend = this._register(new Emitter<JsonRpcMessage>());
	readonly onDidSend = this._onDidSend.event;
	private readonly _onDidCancel = this._register(new Emitter<JsonRpcId>());
	readonly onDidCancel = this._onDidCancel.event;

	override send(message: JsonRpcMessage, envelope?: IMcpMessageEnvelope): void {
		super.send(message, envelope);
		this._onDidSend.fire(message);
	}

	override cancelRequest(requestId: JsonRpcId): void {
		super.cancelRequest(requestId);
		this._onDidCancel.fire(requestId);
	}

	/** Resolves with the `count`-th request for the method once it was sent. */
	requestSent(method: string, count: number): Promise<IJsonRpcRequest> {
		const nth = () => this.getSentRequests(method)[count - 1];
		if (nth()) {
			return Promise.resolve(nth());
		}
		return Event.toPromise(Event.filter(this.onDidSend, () => !!nth())).then(nth);
	}

	/** Resolves once the request was cancelled through the transport. */
	requestCancelled(requestId: JsonRpcId): Promise<void> {
		if (this.getCancelledRequests().includes(requestId)) {
			return Promise.resolve();
		}
		return Event.toPromise(Event.filter(this.onDidCancel, id => id === requestId)).then(() => undefined);
	}
}

const completeResult = (request: IJsonRpcRequest, result: object): JsonRpcMessage => ({ jsonrpc: MCP.JSONRPC_VERSION, id: request.id, result: { resultType: 'complete', ...result } });
const errorResult = (request: IJsonRpcRequest, code: number, message: string, data?: unknown): JsonRpcMessage => ({ jsonrpc: MCP.JSONRPC_VERSION, id: request.id, error: data === undefined ? { code, message } : { code, message, data } });
const inputRequiredResult = (request: IJsonRpcRequest, inputRequests: MCP.InputRequests, requestState?: string): JsonRpcMessage => ({ jsonrpc: MCP.JSONRPC_VERSION, id: request.id, result: requestState === undefined ? { resultType: 'input_required', inputRequests } : { resultType: 'input_required', inputRequests, requestState } });
const paramsOf = (request: IJsonRpcRequest): Record<string, unknown> => (request.params ?? {}) as Record<string, unknown>;
const sentMethods = (transport: TestMcpMessageTransport): string[] => transport.getSentMessages().flatMap(m => isJsonRpcRequest(m) || isJsonRpcNotification(m) ? [m.method] : []);
const isCancelled = (e: unknown): boolean => e instanceof CancellationError;
/** Never resolves; rejects with a cancellation once the token is cancelled, releasing its listener. */
const rejectWhenCancelled = (token: CancellationToken): Promise<never> => new Promise<never>((_resolve, reject) => {
	const listener = token.onCancellationRequested(() => {
		listener.dispose();
		reject(new CancellationError());
	});
});

const ECHO_TOOL: MCPLegacy.Tool = { name: 'echo', description: 'Echoes its input', inputSchema: { type: 'object', properties: {} } };
const FORM_ELICITATION: MCP.InputRequests = { e1: { method: 'elicitation/create', params: { mode: 'form', message: 'm', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } } };
const ROOTS_INPUT: MCP.InputRequests = { r1: { method: 'roots/list' } };

//#endregion

suite('Workbench - MCP - ServerRequestHandler - era negotiation', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let services: ITestServices;

	setup(() => {
		services = createTestServices(store);
	});

	test('a modern server is adopted from server/discover without initialize', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport);

		assert.strictEqual(handler.era, 'modern');
		assert.strictEqual(handler.protocolVersion, '2026-07-28');
		assert.strictEqual(LATEST_MCP_PROTOCOL_VERSION, '2026-07-28');
		assert.deepStrictEqual(handler.negotiated, { era: 'modern', protocolVersion: '2026-07-28' });
		assert.strictEqual(transport.getSentRequests('server/discover').length, 1);
		assert.strictEqual(transport.getSentRequests('initialize').length, 0);
		assert.strictEqual(sentMethods(transport).includes('notifications/initialized'), false);
		assert.deepStrictEqual(handler.serverInfo, TEST_MODERN_SERVER_INFO);
		assert.deepStrictEqual(handler.capabilities, transport.defaultDiscoverResult().capabilities);
		assert.deepStrictEqual(handler.discoverResult?.supportedVersions, ['2026-07-28']);
		assert.strictEqual(handler.legacyCapabilities, undefined);
		assert.strictEqual(handler.discoverCacheHint?.ttlMs, 60_000);
		assert.strictEqual(handler.discoverCacheHint?.cacheScope, 'public');
		assert.strictEqual(typeof handler.discoverCacheHint?.receivedAt, 'number');
		assert.strictEqual(handler.lastNegotiation?.era, 'modern');
		assert.strictEqual(handler.lastNegotiation?.usedHint, false);
		assert.strictEqual(handler.lastNegotiation?.probeTimedOut, false);
		assert.ok(handler.subscriptions, 'modern servers get a subscription manager');
	});

	test('a modern server without serverInfo shows the configured default and its instructions', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern', discoverResult: { _meta: undefined, instructions: 'Be brief.', ttlMs: -1, cacheScope: undefined } }));
		const handler = await connect(store, services, transport, { defaultServerInfo: { name: 'Configured Name', version: '' } });

		assert.deepStrictEqual(handler.serverInfo, { name: 'Configured Name', version: '' });
		assert.strictEqual(handler.serverInstructions, 'Be brief.');
		assert.deepStrictEqual(handler.discoverCacheHint, { receivedAt: handler.discoverCacheHint?.receivedAt, ttlMs: undefined, cacheScope: undefined });
	});

	test('discover() re-fetches server/discover for modern servers only', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport);
		transport.setResponder('server/discover', req => completeResult(req, { ...transport.defaultDiscoverResult(), ttlMs: 5, cacheScope: 'private', instructions: 'updated' }));

		const result = await handler.discover();
		assert.strictEqual(result?.instructions, 'updated');
		assert.strictEqual(handler.serverInstructions, 'updated');
		assert.strictEqual(handler.discoverCacheHint?.ttlMs, 5);
		assert.strictEqual(handler.discoverCacheHint?.cacheScope, 'private');
		assert.strictEqual(transport.getSentRequests('server/discover').length, 2);

		const legacy = store.add(new TestMcpMessageTransport());
		const legacyHandler = await connect(store, services, legacy);
		assert.strictEqual(await legacyHandler.discover(), undefined);
		assert.strictEqual(legacy.getSentRequests('server/discover').length, 1);
	});

	test('a legacy server rejects the probe and gets the initialize handshake', async () => {
		const capabilities: MCPLegacy.ServerCapabilities = { tools: { listChanged: true }, prompts: {}, resources: { subscribe: true, listChanged: false }, logging: {}, completions: {}, experimental: { x: {} } };
		const transport = store.add(new TestMcpMessageTransport({ initializeResult: { capabilities, instructions: 'legacy instructions' } }));
		transport.setResponder('logging/setLevel', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: {} }));
		const handler = await connect(store, services, transport);

		assert.deepStrictEqual(sentMethods(transport).slice(0, 3), ['server/discover', 'initialize', 'notifications/initialized']);
		assert.strictEqual(handler.era, 'legacy');
		assert.strictEqual(handler.protocolVersion, '2025-11-25');
		assert.deepStrictEqual(handler.negotiated, { era: 'legacy', protocolVersion: '2025-11-25' });
		assert.deepStrictEqual(handler.capabilities, {
			experimental: { x: {} },
			logging: {},
			completions: {},
			prompts: { listChanged: undefined },
			resources: { subscribe: true, listChanged: false },
			tools: { listChanged: true },
		});
		assert.deepStrictEqual(handler.legacyCapabilities, capabilities);
		assert.strictEqual(handler.serverInstructions, 'legacy instructions');
		assert.deepStrictEqual(handler.serverInfo, { name: 'Test MCP Server', version: '1.0.0' });
		assert.strictEqual(handler.discoverResult, undefined);
		assert.strictEqual(handler.discoverCacheHint, undefined);
		assert.strictEqual(handler.subscriptions, undefined);
		assert.strictEqual(handler.lastNegotiation?.era, 'legacy');
		assert.strictEqual(handler.lastNegotiation?.usedHint, false);
		// the log level is forwarded to legacy servers that support logging
		assert.deepStrictEqual(transport.getSentRequests('logging/setLevel').map(paramsOf), [{ level: 'info' }]);
	});

	for (const supported of ['2025-11-25', '2025-06-18']) {
		test(`-32022 on server/discover naming ${supported} pins the initialize handshake to it`, async () => {
			const transport = store.add(new TestMcpMessageTransport({ initializeResult: { protocolVersion: supported } }));
			transport.setResponder('server/discover', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: [supported] }));
			const handler = await connect(store, services, transport);

			const initialize = transport.getSentRequests('initialize');
			assert.strictEqual(initialize.length, 1);
			assert.strictEqual(paramsOf(initialize[0]).protocolVersion, supported);
			assert.strictEqual(handler.era, 'legacy');
			assert.strictEqual(handler.protocolVersion, supported);
		});
	}

	test('-32022 on server/discover with no shared revision rejects with no-supported-version', async () => {
		const transport = store.add(new TestMcpMessageTransport());
		transport.setResponder('server/discover', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['1999-01-01', 'not-a-version'] }));

		await assert.rejects(beginConnect(store, services, transport), (e: unknown) => e instanceof McpClientError && e.reason === 'no-supported-version');
		assert.strictEqual(transport.getSentRequests('initialize').length, 0);
	});

	test('-32020 and -32021 on server/discover are surfaced, not treated as a legacy server', async () => {
		for (const code of [MCP.HEADER_MISMATCH, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY]) {
			const transport = store.add(new TestMcpMessageTransport());
			transport.setResponder('server/discover', req => errorResult(req, code, 'rejected'));
			await assert.rejects(beginConnect(store, services, transport), (e: unknown) => e instanceof MpcResponseError && e.code === code);
			assert.strictEqual(transport.getSentRequests('initialize').length, 0, `${code} must not fall back`);
		}
	});

	test('a legacy hint skips the probe', async () => {
		const transport = store.add(new TestMcpMessageTransport());
		const handler = await connect(store, services, transport, { negotiationHint: { era: 'legacy', protocolVersion: '2025-11-25' } });

		assert.strictEqual(transport.getSentRequests('server/discover').length, 0);
		assert.deepStrictEqual(sentMethods(transport), ['initialize', 'notifications/initialized']);
		assert.strictEqual(paramsOf(transport.getSentRequests('initialize')[0]).protocolVersion, '2025-11-25');
		assert.strictEqual(handler.era, 'legacy');
		assert.strictEqual(handler.lastNegotiation?.usedHint, true);
	});

	test('a legacy hint that the server rejects re-probes', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport, { negotiationHint: { era: 'legacy' } });

		assert.deepStrictEqual(sentMethods(transport).slice(0, 2), ['initialize', 'server/discover']);
		assert.strictEqual(handler.era, 'modern');
		assert.strictEqual(handler.lastNegotiation?.usedHint, true);
	});

	suite('a pinned legacy revision the server rejects', () => {
		const pin = { protocolVersion: '2025-11-25' } as const;

		test('over HTTP (-32020, the zig server\'s answer to a 2025-11-25 initialize): re-probes with server/discover and negotiates 2026-07-28', async () => {
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			transport.setResponder('initialize', req => errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch: the Mcp-Method header is missing'));
			const warn = sinon.spy(services.logger, 'warn');
			try {
				const handler = await connect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: pin });

				assert.deepStrictEqual(sentMethods(transport).slice(0, 2), ['initialize', 'server/discover']);
				assert.strictEqual(paramsOf(transport.getSentRequests('initialize')[0]).protocolVersion, '2025-11-25');
				assert.deepStrictEqual(handler.negotiated, { era: 'modern', protocolVersion: '2026-07-28' });
				assert.strictEqual(sentMethods(transport).includes('notifications/initialized'), false);
				assert.ok(handler.subscriptions, 'the modern subscriptions run');
				assert.ok(warn.getCalls().some(call => String(call.args[0]).startsWith('The server rejected MCP 2025-11-25 (MPC -32020: Header mismatch')), JSON.stringify(warn.getCalls().map(call => call.args[0])));
			} finally {
				warn.restore();
			}
		});

		test('over stdio (-32601 naming its versions, the zig server\'s answer): re-probes with server/discover', async () => {
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			transport.setResponder('initialize', req => errorResult(req, MCP.METHOD_NOT_FOUND, 'Method not found: initialize. This server supports MCP 2026-07-28 only. Use server/discover.', { supportedVersions: ['2026-07-28'] }));
			const handler = await connect(store, services, transport, { transportType: McpServerTransportType.Stdio, negotiationHint: pin });

			assert.deepStrictEqual(sentMethods(transport).slice(0, 2), ['initialize', 'server/discover']);
			assert.deepStrictEqual(handler.negotiated, { era: 'modern', protocolVersion: '2026-07-28' });
		});

		test('-32022 naming a modern revision: server/discover is probed with it and the renegotiation is reported', async () => {
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			transport.setResponder('initialize', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version 2025-11-25', { supported: ['2026-07-28'], requested: '2025-11-25' }));
			const handler = await connect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: pin });

			assert.deepStrictEqual(sentMethods(transport).slice(0, 2), ['initialize', 'server/discover']);
			assert.strictEqual(transport.getSentEnvelope('server/discover')?.protocolVersion, '2026-07-28');
			assert.deepStrictEqual(handler.negotiated, { era: 'modern', protocolVersion: '2026-07-28' });
			assert.deepStrictEqual(handler.handshakeEvents.map(e => e.kind), ['renegotiation', 'negotiation']);
			assert.deepStrictEqual(handler.handshakeEvents[0], { kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: true });
		});

		test('-32022 naming another legacy revision: the handshake is retried with it, without a probe', async () => {
			const transport = store.add(new TestMcpMessageTransport({ initializeResult: { protocolVersion: '2025-06-18' } }));
			transport.setResponder('initialize', req => paramsOf(req).protocolVersion === '2025-06-18'
				? { jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: transport.defaultInitializeResult() }
				: errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2025-06-18'], requested: '2025-11-25' }));
			const handler = await connect(store, services, transport, { negotiationHint: pin });

			assert.deepStrictEqual(transport.getSentRequests('initialize').map(r => paramsOf(r).protocolVersion), ['2025-11-25', '2025-06-18']);
			assert.strictEqual(transport.getSentRequests('server/discover').length, 0);
			assert.deepStrictEqual(handler.negotiated, { era: 'legacy', protocolVersion: '2025-06-18' });
			assert.deepStrictEqual(handler.handshakeEvents[0], { kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: true });
		});

		test('-32022 naming no other shared revision: the server is probed from the start', async () => {
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			transport.setResponder('initialize', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2025-11-25', '2099-01-01'], requested: '2025-11-25' }));
			const handler = await connect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: pin });

			assert.deepStrictEqual(sentMethods(transport).slice(0, 2), ['initialize', 'server/discover']);
			assert.strictEqual(transport.getSentEnvelope('server/discover')?.protocolVersion, '2026-07-28');
			assert.strictEqual(handler.era, 'modern');
			assert.deepStrictEqual(handler.handshakeEvents[0], { kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: false });
		});

		test('a strict pin is never renegotiated: the rejection is surfaced and nothing else is sent', async () => {
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			transport.setResponder('initialize', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2026-07-28'], requested: '2025-11-25' }));
			await assert.rejects(
				beginConnect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: { ...pin, strict: true } }),
				(e: unknown) => e instanceof MpcResponseError && e.code === MCP.UNSUPPORTED_PROTOCOL_VERSION,
			);
			assert.deepStrictEqual(sentMethods(transport), ['initialize']);
		});

		/** Answers `initialize` the way the HTTP transport does after a 4xx without a 2026-07-28 body whose HTTP+SSE fallback failed too. */
		const abortInitializeAfterFailedFallback = (transport: TestMcpMessageTransport) => transport.setResponder('initialize', req => {
			setTimeout(() => transport.simulateAbort({ requestId: req.id, reason: 'http-status', httpStatus: 400, message: '400 status sending message to http://127.0.0.1/mcp, and the fallback to legacy SSE failed: 405 status connecting to http://127.0.0.1/mcp as SSE: ' }));
			return undefined;
		});

		test('over HTTP, a 4xx without a 2026-07-28 body whose HTTP+SSE fallback fails too (the transport aborts the initialize): re-probes with server/discover', async () => {
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			abortInitializeAfterFailedFallback(transport);
			const handler = await connect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: pin });

			assert.deepStrictEqual(sentMethods(transport).slice(0, 2), ['initialize', 'server/discover']);
			assert.deepStrictEqual(handler.negotiated, { era: 'modern', protocolVersion: '2026-07-28' });
		});

		test('a strict pin whose initialize the transport aborts fails with the abort and sends nothing else', async () => {
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			abortInitializeAfterFailedFallback(transport);
			await assert.rejects(
				beginConnect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: { ...pin, strict: true } }),
				(e: unknown) => e instanceof McpClientError && e.reason === 'request-aborted' && e.message.includes('the fallback to legacy SSE failed'),
			);
			assert.deepStrictEqual(sentMethods(transport), ['initialize']);
		});

		for (const [name, hint] of [['a cached legacy revision', { era: 'legacy', protocolVersion: '2025-11-25' }], ['a pinned legacy revision', pin]] as const) {
			test(`${name} whose initialize the transport cannot deliver (transport-error: a server that cannot be reached) fails the start with that error, without a probe`, async () => {
				// A server that would answer the probe: the failure must come from the unreachable initialize alone.
				const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
				transport.setResponder('initialize', req => {
					setTimeout(() => transport.simulateAbort({ requestId: req.id, reason: 'transport-error', message: 'fetch failed: connect ECONNREFUSED 127.0.0.1:39899' }));
					return undefined;
				});
				const warn = sinon.spy(services.logger, 'warn');
				try {
					await assert.rejects(
						beginConnect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: hint }),
						(e: unknown) => e instanceof McpClientError && e.reason === 'request-aborted' && (e.detail as IMcpRequestAbort).reason === 'transport-error' && e.message.includes('ECONNREFUSED'),
					);
					assert.deepStrictEqual(sentMethods(transport), ['initialize']);
					assert.ok(!warn.getCalls().some(call => String(call.args[0]).startsWith('The server rejected')), JSON.stringify(warn.getCalls().map(call => call.args[0])));
				} finally {
					warn.restore();
				}
			});
		}

		test('a pinned revision that a stdio server rejects before it exits fails the start with the rejection: nothing is sent to the stopped server', async () => {
			// The server would answer a probe; once the launch stopped, no request may go out (the pending ones were cancelled already).
			const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
			transport.setResponder('initialize', req => {
				setTimeout(() => {
					transport.simulateReceiveMessage(errorResult(req, -32602, 'Unsupported protocol version'));
					transport.setConnectionState({ state: McpConnectionState.Kind.Stopped });
				});
				return undefined;
			});
			await assert.rejects(
				beginConnect(store, services, transport, { transportType: McpServerTransportType.Stdio, negotiationHint: pin }),
				(e: unknown) => e instanceof MpcResponseError && e.code === -32602,
			);
			assert.deepStrictEqual(sentMethods(transport), ['initialize']);
		});

		test('over HTTP+SSE (the fallback worked, then the server rejected the pin): the probe is aborted with legacy-probe and the newest legacy revision is tried', async () => {
			const transport = store.add(new TestMcpMessageTransport());
			transport.setResponder('initialize', req => paramsOf(req).protocolVersion === '2024-11-05'
				? errorResult(req, -32602, 'Unsupported protocol version')
				: { jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: transport.defaultInitializeResult() });
			transport.setResponder('server/discover', req => {
				setTimeout(() => transport.simulateAbort({ requestId: req.id, reason: 'legacy-probe', message: 'The server uses the legacy HTTP+SSE transport' }));
				return undefined;
			});
			const handler = await connect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: { protocolVersion: '2024-11-05' } });

			assert.deepStrictEqual(sentMethods(transport).slice(0, 3), ['initialize', 'server/discover', 'initialize']);
			assert.deepStrictEqual(transport.getSentRequests('initialize').map(r => paramsOf(r).protocolVersion), ['2024-11-05', '2025-11-25']);
			assert.deepStrictEqual(handler.negotiated, { era: 'legacy', protocolVersion: '2025-11-25' });
		});

		test('-32022 naming a modern revision other than the newest: server/discover is probed with that revision', async () => {
			// Today 2026-07-28 is the only modern revision, so a second (older) one is added for this test.
			const modern = MODERN_MCP_PROTOCOL_VERSIONS as string[];
			modern.push('2026-01-15');
			try {
				const transport = store.add(new TestMcpMessageTransport({ era: 'modern', discoverResult: { supportedVersions: ['2026-01-15'] } }));
				transport.setResponder('initialize', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version 2025-11-25', { supported: ['2026-01-15'], requested: '2025-11-25' }));
				const handler = await connect(store, services, transport, { transportType: McpServerTransportType.HTTP, negotiationHint: pin });

				const discover = transport.getSentRequests('server/discover');
				assert.strictEqual(discover.length, 1, 'probed once, with the offered revision');
				assert.strictEqual(transport.getSentEnvelope('server/discover')?.protocolVersion, '2026-01-15');
				assert.strictEqual((paramsOf(discover[0])._meta as Record<string, unknown>)[META_PROTOCOL_VERSION], '2026-01-15');
				assert.deepStrictEqual(handler.negotiated, { era: 'modern', protocolVersion: '2026-01-15' });
			} finally {
				modern.splice(modern.indexOf('2026-01-15'), 1);
			}
			assert.deepStrictEqual(MODERN_MCP_PROTOCOL_VERSIONS, ['2026-07-28']);
		});
	});

	test('a modern hint is used as-is and still discovers', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport, { negotiationHint: { era: 'modern', protocolVersion: '2026-07-28' } });

		assert.strictEqual(handler.era, 'modern');
		assert.strictEqual(transport.getSentRequests('server/discover').length, 1);
		assert.strictEqual(transport.getSentRequests('initialize').length, 0);
		assert.strictEqual(handler.lastNegotiation?.usedHint, true);
	});

	test('a strict modern hint against a server without server/discover speaks the revision with no capabilities', async () => {
		const transport = store.add(new TestMcpMessageTransport()); // answers server/discover with -32601
		const handler = await connect(store, services, transport, { negotiationHint: { era: 'modern', strict: true } });

		assert.strictEqual(handler.era, 'modern');
		assert.strictEqual(handler.protocolVersion, '2026-07-28');
		assert.deepStrictEqual(handler.capabilities, {});
		assert.deepStrictEqual(sentMethods(transport), ['server/discover']);
		assert.strictEqual(handler.discoverCacheHint, undefined);
		assert.deepStrictEqual(handler.serverInfo, { name: 'MCP Server', version: '' });
		assert.ok(handler.subscriptions, 'the manager exists but has nothing to listen for');
	});

	test('a strict modern hint rejects a server that only speaks a legacy revision', async () => {
		const transport = store.add(new TestMcpMessageTransport());
		transport.setResponder('server/discover', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2025-11-25'] }));

		await assert.rejects(beginConnect(store, services, transport, { negotiationHint: { era: 'modern', strict: true } }), (e: unknown) => e instanceof McpClientError && e.reason === 'no-supported-version');
		assert.strictEqual(transport.getSentRequests('initialize').length, 0);
	});

	test('the probe reports its renegotiation as not retried for a strict modern hint against a legacy-only server, and as retried without strict', async () => {
		// The probe runs inside create(), before anyone can subscribe to the handler: observe every emitter instead.
		const fire = sinon.spy(Emitter.prototype, 'fire');
		const renegotiations = () => fire.getCalls()
			.map(call => call.args[0] as unknown)
			.filter(e => typeof e === 'object' && e !== null && (e as Partial<McpProtocolEvent>).kind === 'renegotiation');
		const legacyOnly = (req: IJsonRpcRequest) => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2025-11-25'] });
		try {
			const strict = store.add(new TestMcpMessageTransport());
			strict.setResponder('server/discover', legacyOnly);
			await assert.rejects(beginConnect(store, services, strict, { negotiationHint: { era: 'modern', strict: true } }), (e: unknown) => e instanceof McpClientError && e.reason === 'no-supported-version');
			assert.deepStrictEqual(renegotiations(), [{ kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: false }]);
			assert.strictEqual(strict.getSentRequests('server/discover').length, 1);
			assert.strictEqual(strict.getSentRequests('initialize').length, 0);

			fire.resetHistory();
			const lenient = store.add(new TestMcpMessageTransport());
			lenient.setResponder('server/discover', legacyOnly);
			const handler = await connect(store, services, lenient, { negotiationHint: { era: 'modern' } });
			assert.strictEqual(handler.era, 'legacy');
			assert.deepStrictEqual(renegotiations(), [{ kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: true }]);
		} finally {
			fire.restore();
		}
	});

	test('the handshake events (probe renegotiations, then the negotiation) are kept for replay', async () => {
		// A server that rejects the first probe with -32022 and then accepts the offered revision.
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		let probes = 0;
		transport.setResponder('server/discover', req => ++probes === 1
			? errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2026-07-28'] })
			: completeResult(req, transport.defaultDiscoverResult()));
		const handler = await connect(store, services, transport);
		assert.strictEqual(handler.era, 'modern');
		assert.deepStrictEqual(handler.handshakeEvents.map(e => e.kind), ['renegotiation', 'negotiation']);
		assert.deepStrictEqual(handler.handshakeEvents[0], { kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: true });
		assert.strictEqual(handler.handshakeEvents[1], handler.lastNegotiation);

		// Events after the handshake are not added.
		transport.setResponder('tools/list', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2026-07-28'] }));
		await assert.rejects(handler.listTools());
		assert.strictEqual(handler.handshakeEvents.length, 2);
	});

	test('a legacy-probe abort from the transport falls back to initialize', async () => {
		const transport = store.add(new TestMcpMessageTransport());
		transport.setResponder('server/discover', undefined);
		const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.HTTP });

		const discover = transport.getSentRequests('server/discover');
		assert.strictEqual(discover.length, 1);
		assert.strictEqual(transport.getSentRequests('initialize').length, 0);
		transport.simulateAbort({ requestId: discover[0].id, reason: 'legacy-probe', httpStatus: 400, message: 'Server not initialized' });

		const handler = store.add(await pending);
		assert.strictEqual(handler.era, 'legacy');
		assert.strictEqual(transport.getSentRequests('initialize').length, 1);
		assert.strictEqual(handler.lastNegotiation?.probeTimedOut, false);
	});

	test('other transport aborts of the probe are surfaced', async () => {
		const transport = store.add(new TestMcpMessageTransport());
		transport.setResponder('server/discover', undefined);
		const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.HTTP });
		transport.simulateAbort({ requestId: transport.getSentRequests('server/discover')[0].id, reason: 'transport-error', message: 'ECONNREFUSED' });

		await assert.rejects(pending, (e: unknown) => e instanceof McpClientError && e.reason === 'request-aborted');
		assert.strictEqual(transport.getSentRequests('initialize').length, 0);
	});

	test('cancelling the token during the probe rejects with a cancellation', async () => {
		const transport = store.add(new TestMcpMessageTransport());
		transport.setResponder('server/discover', undefined);
		const cts = store.add(new CancellationTokenSource());
		const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.HTTP }, cts.token);
		cts.cancel();
		await assert.rejects(pending, isCancelled);
	});

	suite('stdio probe timeout', () => {
		let clock: sinon.SinonFakeTimers;

		setup(() => {
			clock = sinon.useFakeTimers();
		});

		teardown(() => {
			clock.restore();
		});

		test('a silent server gets initialize after the probe timeout', async () => {
			const transport = store.add(new TestMcpMessageTransport());
			transport.setResponder('server/discover', undefined);
			const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.Stdio, probeTimeoutMs: 100 });

			await clock.tickAsync(99);
			assert.deepStrictEqual(sentMethods(transport), ['server/discover']);
			await clock.tickAsync(1);
			assert.deepStrictEqual(sentMethods(transport), ['server/discover', 'initialize']);
			await clock.tickAsync(1); // the fake server answers on a timer

			const handler = store.add(await pending);
			assert.strictEqual(handler.era, 'legacy');
			assert.strictEqual(handler.protocolVersion, '2025-11-25');
			assert.strictEqual(handler.lastNegotiation?.probeTimedOut, true);
			assert.strictEqual(handler.lastNegotiation?.usedHint, false);
		});

		test('a late server/discover answer still wins after the probe timeout', async () => {
			const transport = store.add(new TestMcpMessageTransport());
			transport.setResponder('server/discover', undefined);
			transport.setResponder('initialize', undefined);
			const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.Stdio, probeTimeoutMs: 100 });

			await clock.tickAsync(100);
			assert.deepStrictEqual(sentMethods(transport), ['server/discover', 'initialize']);
			const discover = transport.getSentRequests('server/discover')[0];
			transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: discover.id, result: transport.defaultDiscoverResult() });
			await clock.tickAsync(0);

			const handler = store.add(await pending);
			assert.strictEqual(handler.era, 'modern');
			assert.strictEqual(handler.protocolVersion, '2026-07-28');
			assert.strictEqual(handler.lastNegotiation?.probeTimedOut, true);
			assert.strictEqual(sentMethods(transport).includes('notifications/initialized'), false);
			assert.strictEqual(transport.getSentRequests('subscriptions/listen').length, 1);
		});

		test('a server answering neither handshake rejects with probe-timeout once both fail', async () => {
			const transport = store.add(new TestMcpMessageTransport());
			// The discover answer is held back until the legacy handshake is in flight too.
			transport.setResponder('server/discover', undefined);
			transport.setResponder('initialize', req => errorResult(req, MCPLegacy.METHOD_NOT_FOUND, 'Method not found'));
			const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.Stdio, probeTimeoutMs: 100 });

			await clock.tickAsync(100);
			assert.deepStrictEqual(sentMethods(transport), ['server/discover', 'initialize']);
			await clock.tickAsync(1); // initialize is rejected
			transport.simulateReceiveMessage(errorResult(transport.getSentRequests('server/discover')[0], MCPLegacy.METHOD_NOT_FOUND, 'Method not found'));

			await assert.rejects(pending, (e: unknown) => e instanceof McpClientError && e.reason === 'probe-timeout');
		});

		test('the HTTP transport never times the probe out', async () => {
			const transport = store.add(new TestMcpMessageTransport());
			transport.setResponder('server/discover', undefined);
			const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.HTTP });

			await clock.tickAsync(60_000);
			assert.deepStrictEqual(sentMethods(transport), ['server/discover']);
			transport.simulateReceiveMessage(errorResult(transport.getSentRequests('server/discover')[0], MCPLegacy.METHOD_NOT_FOUND, 'Method not found'));
			await clock.tickAsync(1); // the fake server answers initialize on a timer
			const handler = store.add(await pending);
			assert.strictEqual(handler.era, 'legacy');
			assert.strictEqual(handler.lastNegotiation?.probeTimedOut, false);
		});

		test('the gRPC transport never times the probe out: every call is answered or aborted', async () => {
			const transport = store.add(new TestMcpMessageTransport());
			transport.setResponder('server/discover', undefined);
			const pending = beginConnect(store, services, transport, { transportType: McpServerTransportType.Grpc });

			await clock.tickAsync(60_000);
			assert.deepStrictEqual(sentMethods(transport), ['server/discover']);
			transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: transport.getSentRequests('server/discover')[0].id, result: transport.defaultDiscoverResult() });
			await clock.tickAsync(0);
			const handler = store.add(await pending);
			assert.strictEqual(handler.era, 'modern');
			assert.strictEqual(handler.lastNegotiation?.probeTimedOut, false);
			assert.strictEqual(sentMethods(transport).includes('initialize'), false);
		});
	});
});

suite('Workbench - MCP - ServerRequestHandler - modern requests', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let services: ITestServices;
	let transport: TestMcpMessageTransport;
	let handler: McpServerRequestHandler;

	setup(async () => {
		services = createTestServices(store);
		transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		transport.setResponder('tools/list', req => completeResult(req, { tools: [ECHO_TOOL] }));
		transport.setResponder('tools/call', req => completeResult(req, { content: [{ type: 'text', text: 'ok' }] }));
		handler = await connect(store, services, transport);
	});

	test('every request carries the protocol _meta', async () => {
		await handler.listTools();
		await handler.callTool({ name: 'echo', arguments: {}, _meta: { progressToken: 'tok-1' } });

		const requests = transport.getSentRequests();
		assert.deepStrictEqual(requests.map(r => r.method), ['server/discover', 'subscriptions/listen', 'tools/list', 'tools/call']);
		for (const request of requests) {
			const meta = paramsOf(request)._meta as Record<string, unknown> | undefined;
			assert.ok(meta, `${request.method} carries _meta`);
			assert.strictEqual(meta[META_PROTOCOL_VERSION], '2026-07-28', request.method);
			assert.deepStrictEqual(meta[META_CLIENT_INFO], { name: TestProductService.nameLong, version: TestProductService.version }, request.method);
			assert.deepStrictEqual(meta[META_CLIENT_CAPABILITIES], buildClientCapabilities('modern', { sampling: false, samplingTools: true, elicitation: false }), request.method);
			assert.strictEqual(meta[META_LOG_LEVEL], 'info', request.method);
		}
		// the caller's own meta survives
		const call = paramsOf(transport.getSentRequests('tools/call')[0])._meta as Record<string, unknown>;
		assert.strictEqual(call.progressToken, 'tok-1');
	});

	test('the declared capabilities follow the configured client methods', async () => {
		const other = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		await connect(store, services, other, { elicitationRequestHandler: async () => ({ action: 'decline' }), createMessageRequestHandler: async () => { throw new Error('unused'); } });
		const meta = paramsOf(other.getSentRequests('server/discover')[0])._meta as Record<string, unknown>;
		assert.deepStrictEqual(meta[META_CLIENT_CAPABILITIES], buildClientCapabilities('modern', { sampling: true, samplingTools: true, elicitation: true }));
	});

	test('setLevel changes the _meta log level of the following requests instead of calling logging/setLevel', async () => {
		await handler.setLevel({ level: 'warning' });
		await handler.listTools();
		assert.strictEqual(transport.getSentRequests('logging/setLevel').length, 0);
		const meta = paramsOf(transport.getSentRequests('tools/list')[0])._meta as Record<string, unknown>;
		assert.strictEqual(meta[META_LOG_LEVEL], 'warning');
	});

	test('tools/call envelopes mirror the method, the name and the annotated parameters', async () => {
		transport.setResponder('tools/list', req => completeResult(req, { tools: [{ name: 'geo', description: 'd', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, verbose: { type: 'boolean', 'x-mcp-header': 'Verbose' } } } }] }));
		await handler.listTools();
		await handler.callTool({ name: 'geo', arguments: { region: 'eu-west', verbose: true } });

		const envelope = transport.getSentEnvelope('tools/call');
		assert.strictEqual(envelope?.kind, 'request');
		assert.strictEqual(envelope?.protocolVersion, '2026-07-28');
		assert.strictEqual(envelope?.method, 'tools/call');
		assert.deepStrictEqual(envelope?.headers, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'geo', 'Mcp-Param-Region': 'eu-west', 'Mcp-Param-Verbose': 'true' });
		assert.deepStrictEqual(transport.getSentEnvelope('tools/list')?.headers, { 'Mcp-Method': 'tools/list' });
		assert.strictEqual(transport.getSentEnvelope('subscriptions/listen')?.kind, 'listen');
	});

	test('seeded header annotations are used before the first live listing', async () => {
		handler.seedToolHeaderAnnotations([{ name: 'geo', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } }]);
		await handler.callTool({ name: 'geo', arguments: { region: 'us' } });
		assert.deepStrictEqual(transport.getSentEnvelope('tools/call')?.headers, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'geo', 'Mcp-Param-Region': 'us' });
	});

	test('a result with an unknown resultType is rejected', async () => {
		transport.setResponder('tools/list', req => ({ jsonrpc: MCP.JSONRPC_VERSION, id: req.id, result: { resultType: 'partial', tools: [] } }));
		await assert.rejects(handler.listTools(), (e: unknown) => e instanceof McpClientError && e.reason === 'invalid-result-type');
	});

	test('a header mismatch on tools/call refreshes the tool list and retries once', async () => {
		let calls = 0;
		transport.setResponder('tools/call', req => ++calls === 1 ? errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch: Mcp-Param-Region is missing') : completeResult(req, { content: [{ type: 'text', text: 'second' }] }));
		let toolListChanges = 0;
		store.add(handler.onDidChangeToolList(() => toolListChanges++));

		const result = await handler.callTool({ name: 'echo', arguments: {} });
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'second' }]);
		assert.deepStrictEqual(sentMethods(transport).filter(m => m === 'tools/call' || m === 'tools/list'), ['tools/call', 'tools/list', 'tools/call']);
		assert.strictEqual(transport.getSentRequests('tools/call').length, 2);
		assert.strictEqual(toolListChanges, 1);
	});

	test('a second header mismatch is surfaced', async () => {
		transport.setResponder('tools/call', req => errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch'));
		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.HEADER_MISMATCH);
		assert.strictEqual(transport.getSentRequests('tools/call').length, 2);
		assert.strictEqual(transport.getSentRequests('tools/list').length, 1);
	});

	test('a header mismatch on other methods is not retried', async () => {
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));
		transport.setResponder('tools/list', req => errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch'));
		await assert.rejects(handler.listTools(), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.HEADER_MISMATCH);
		assert.strictEqual(transport.getSentRequests('tools/list').length, 1);
		assert.deepStrictEqual(failures, [{ kind: 'header-mismatch', method: 'tools/list', refresh: 'none' }], 'reported as not refreshed');
	});

	test('a header mismatch on tools/call whose tool re-list fails is reported as such, without a retry', async () => {
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));
		transport.setResponder('tools/call', req => errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch'));
		transport.setResponder('tools/list', req => errorResult(req, MCP.INTERNAL_ERROR, 'Listing is down'));
		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.HEADER_MISMATCH);
		assert.strictEqual(transport.getSentRequests('tools/call').length, 1);
		assert.deepStrictEqual(failures, [{ kind: 'header-mismatch', method: 'tools/call', refresh: 'failed' }]);
	});

	test('a header mismatch whose tool re-list is cancelled, by the call or by the connection going away, rejects with the cancellation and reports nothing', async () => {
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));
		transport.setResponder('tools/call', req => errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch'));

		// the user cancels the call while the re-list is pending
		const cts = store.add(new CancellationTokenSource());
		transport.setResponder('tools/list', () => {
			setTimeout(() => cts.cancel());
			return undefined;
		});
		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }, cts.token), (e: unknown) => e instanceof CancellationError);
		assert.deepStrictEqual(failures, [], 'a cancelled call is not a refresh failure');
		assert.strictEqual(transport.getSentRequests('tools/call').length, 1, 'and it is not retried');

		// a genuine failure afterwards is still reported
		transport.setResponder('tools/list', req => errorResult(req, MCP.INTERNAL_ERROR, 'Listing is down'));
		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.HEADER_MISMATCH);
		assert.deepStrictEqual(failures, [{ kind: 'header-mismatch', method: 'tools/call', refresh: 'failed' }]);

		// the connection goes away while the re-list is pending
		transport.setResponder('tools/list', () => {
			setTimeout(() => handler.dispose());
			return undefined;
		});
		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }), (e: unknown) => e instanceof CancellationError);
		assert.strictEqual(failures.length, 1);
	});

	test('an unsupported protocol version on a request renegotiates and retries once', async () => {
		let lists = 0;
		transport.setResponder('tools/list', req => ++lists === 1
			? errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2025-11-25'] })
			: ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: { tools: [ECHO_TOOL] } }));
		transport.setResponder('initialize', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: transport.defaultInitializeResult() }));
		const events: McpProtocolEvent[] = [];
		store.add(handler.onDidReportProtocolEvent(e => events.push(e)));
		const listenId = transport.getSentRequests('subscriptions/listen')[0].id;

		const tools = await handler.listTools();
		assert.deepStrictEqual(tools.map(t => t.name), ['echo']);
		assert.strictEqual(handler.era, 'legacy');
		assert.strictEqual(handler.protocolVersion, '2025-11-25');
		const listRequests = transport.getSentRequests('tools/list');
		assert.strictEqual(listRequests.length, 2);
		assert.strictEqual(Object.prototype.hasOwnProperty.call(paramsOf(listRequests[1]), '_meta'), false, 'the legacy retry carries no _meta');
		assert.strictEqual(transport.getSentEnvelope('tools/list')?.protocolVersion, '2025-11-25');
		assert.strictEqual(transport.getSentEnvelope('tools/list')?.headers, undefined);
		assert.deepStrictEqual(sentMethods(transport).filter(m => m === 'initialize' || m === 'notifications/initialized'), ['initialize', 'notifications/initialized']);
		assert.strictEqual(handler.subscriptions, undefined, 'the listen streams are torn down');
		assert.ok(transport.getCancelledRequests().includes(listenId), 'the lists stream is cancelled');
		assert.deepStrictEqual(events, [{ kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: true }]);
	});

	test('an unsupported protocol version naming the revision in use is surfaced', async () => {
		transport.setResponder('tools/list', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2026-07-28'] }));
		await assert.rejects(handler.listTools(), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.UNSUPPORTED_PROTOCOL_VERSION);
		assert.strictEqual(transport.getSentRequests('tools/list').length, 1);
		assert.strictEqual(handler.era, 'modern');
	});

	test('the renegotiation event reports retried: false when no retry happens', async () => {
		transport.setResponder('tools/list', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2026-07-28'] }));
		const events: McpProtocolEvent[] = [];
		store.add(handler.onDidReportProtocolEvent(e => events.push(e)));
		await assert.rejects(handler.listTools());
		assert.deepStrictEqual(events, [{ kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: false }]);
	});

	test('-32021 becomes a missing-capability client error naming the capabilities, and is reported', async () => {
		transport.setResponder('tools/call', req => errorResult(req, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, 'Missing required client capability', { requiredCapabilities: { elicitation: { url: {} }, sampling: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } }));
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));

		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }), (e: unknown) => {
			assert.ok(e instanceof McpClientError, String(e));
			assert.strictEqual(e.reason, 'missing-capability');
			assert.ok(e.message.includes('elicitation.url, sampling, extensions.io.modelcontextprotocol/tasks'), e.message);
			assert.ok(e.message.includes('tools/call'), e.message);
			assert.ok(!e.message.includes('{'), 'no raw JSON in the message');
			return true;
		});
		assert.deepStrictEqual(failures, [{ kind: 'missing-capability', method: 'tools/call', capabilities: ['elicitation.url', 'sampling', 'extensions.io.modelcontextprotocol/tasks'] }]);
		assert.strictEqual(transport.getSentRequests('tools/call').length, 1, '-32021 is not retried');
	});

	test('capability names from the server are reduced to plain names before they are shown', async () => {
		transport.setResponder('tools/call', req => errorResult(req, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, 'Missing', { requiredCapabilities: { '[open](command:workbench.action.quit)': {}, ['x'.repeat(300)]: {}, '()': {} } }));
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));
		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }));
		assert.strictEqual(failures.length, 1);
		const failure = failures[0];
		assert.ok(failure.kind === 'missing-capability');
		assert.deepStrictEqual(failure.capabilities, ['opencommand:workbench.action.quit', 'x'.repeat(100) + '…']);
	});

	test('a -32021 without data names no capability but is still a missing-capability error', async () => {
		transport.setResponder('tools/list', req => errorResult(req, MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, 'Missing required client capability'));
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));
		await assert.rejects(handler.listTools(), (e: unknown) => e instanceof McpClientError && e.reason === 'missing-capability');
		assert.deepStrictEqual(failures, [{ kind: 'missing-capability', method: 'tools/list', capabilities: [] }]);
	});

	test('-32020 and -32022 that the retries do not resolve are reported once each request', async () => {
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));

		transport.setResponder('tools/call', req => errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch'));
		await assert.rejects(handler.callTool({ name: 'echo', arguments: {} }), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.HEADER_MISMATCH);
		assert.deepStrictEqual(failures, [{ kind: 'header-mismatch', method: 'tools/call', refresh: 'refreshed' }], 'reported after the retry, not before');

		transport.setResponder('prompts/get', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2026-07-28', 'x'.repeat(500)] }));
		await assert.rejects(handler.getPrompt({ name: 'p' }), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.UNSUPPORTED_PROTOCOL_VERSION);
		assert.strictEqual(failures.length, 2);
		const versionFailure = failures[1];
		assert.ok(versionFailure.kind === 'unsupported-version');
		assert.strictEqual(versionFailure.method, 'prompts/get');
		assert.strictEqual(versionFailure.requested, '2026-07-28');
		assert.strictEqual(versionFailure.supported[0], '2026-07-28');
		assert.ok(versionFailure.supported[1].length <= 101, 'server-provided names are bounded');
	});

	test('a recovered -32020 or -32022 is not reported', async () => {
		const failures: McpProtocolFailure[] = [];
		store.add(handler.onDidReportProtocolFailure(f => failures.push(f)));
		let calls = 0;
		transport.setResponder('tools/call', req => ++calls === 1 ? errorResult(req, MCP.HEADER_MISMATCH, 'Header mismatch') : completeResult(req, { content: [] }));
		await handler.callTool({ name: 'echo', arguments: {} });
		assert.deepStrictEqual(failures, []);
	});

	test('a strict negotiation does not switch revisions on -32022', async () => {
		const strict = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const strictHandler = await connect(store, services, strict, { negotiationHint: { era: 'modern', protocolVersion: '2026-07-28', strict: true } });
		strict.setResponder('tools/list', req => errorResult(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2025-11-25'] }));
		const events: McpProtocolEvent[] = [];
		store.add(strictHandler.onDidReportProtocolEvent(e => events.push(e)));

		await assert.rejects(strictHandler.listTools(), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.UNSUPPORTED_PROTOCOL_VERSION);
		assert.strictEqual(strictHandler.era, 'modern');
		assert.strictEqual(strict.getSentRequests('tools/list').length, 1);
		assert.strictEqual(strict.getSentRequests('initialize').length, 0);
		assert.deepStrictEqual(events, [{ kind: 'renegotiation', code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: false }]);
	});

	test('pagination follows an empty-string cursor and stops when the cursor is absent', async () => {
		const cursors: unknown[] = [];
		transport.setResponder('tools/list', req => {
			const params = paramsOf(req);
			cursors.push(Object.prototype.hasOwnProperty.call(params, 'cursor') ? params.cursor : 'absent');
			return cursors.length === 1
				? completeResult(req, { tools: [{ ...ECHO_TOOL, name: 'a' }], nextCursor: '' })
				: completeResult(req, { tools: [{ ...ECHO_TOOL, name: 'b' }] });
		});

		const tools = await handler.listTools();
		assert.deepStrictEqual(tools.map(t => t.name), ['a', 'b']);
		assert.deepStrictEqual(cursors, ['absent', '']);
		assert.strictEqual(transport.getSentRequests('tools/list').length, 2);
	});

	test('a non-string cursor ends the listing', async () => {
		transport.setResponder('tools/list', req => completeResult(req, { tools: [ECHO_TOOL], nextCursor: 42 }));
		const tools = await handler.listTools();
		assert.strictEqual(tools.length, 1);
		assert.strictEqual(transport.getSentRequests('tools/list').length, 1);
	});

	test('listToolsEx drops tools with invalid x-mcp-header annotations and records them', async () => {
		const badTool: MCPLegacy.Tool = { name: 'bad', description: 'd', inputSchema: { type: 'object', properties: { p: { type: 'string', 'x-mcp-header': 'bad header' } } } };
		transport.setResponder('tools/list', req => completeResult(req, { tools: [ECHO_TOOL, badTool] }));

		const { items } = await handler.listToolsEx();
		assert.deepStrictEqual(items.map(t => t.name), ['echo']);
		assert.deepStrictEqual([...handler.droppedTools], ['bad']);

		// once the server fixes the tool it is listed again
		transport.setResponder('tools/list', req => completeResult(req, { tools: [{ ...badTool, inputSchema: { type: 'object', properties: { p: { type: 'string', 'x-mcp-header': 'Good' } } } }] }));
		const fixed = await handler.listToolsEx();
		assert.deepStrictEqual(fixed.items.map(t => t.name), ['bad']);
		assert.strictEqual(handler.droppedTools.size, 0);
	});

	test('legacy servers keep tools with invalid annotations', async () => {
		const legacy = store.add(new TestMcpMessageTransport());
		legacy.setResponder('tools/list', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: { tools: [{ name: 'bad', description: 'd', inputSchema: { type: 'object', properties: { p: { type: 'string', 'x-mcp-header': 'bad header' } } } }] } }));
		const legacyHandler = await connect(store, services, legacy);
		const { items, cacheHint } = await legacyHandler.listToolsEx();
		assert.deepStrictEqual(items.map(t => t.name), ['bad']);
		assert.strictEqual(legacyHandler.droppedTools.size, 0);
		assert.deepStrictEqual(cacheHint, { receivedAt: cacheHint.receivedAt, ttlMs: undefined, cacheScope: undefined });
	});

	test('listToolsEx collects the caching hint across pages', async () => {
		let page = 0;
		transport.setResponder('tools/list', req => ++page === 1
			? completeResult(req, { tools: [{ ...ECHO_TOOL, name: 'a' }], nextCursor: 'p2', ttlMs: 5000, cacheScope: 'public' })
			: completeResult(req, { tools: [{ ...ECHO_TOOL, name: 'b' }], ttlMs: 1000, cacheScope: 'private' }));

		const { items, cacheHint } = await handler.listToolsEx();
		assert.strictEqual(items.length, 2);
		assert.strictEqual(cacheHint.ttlMs, 1000, 'the shortest ttl wins');
		assert.strictEqual(cacheHint.cacheScope, 'private', 'private wins');

		transport.setResponder('tools/list', req => completeResult(req, { tools: [ECHO_TOOL], ttlMs: 60_000, cacheScope: 'public' }));
		const single = await handler.listToolsEx();
		assert.strictEqual(single.cacheHint.ttlMs, 60_000);
		assert.strictEqual(single.cacheHint.cacheScope, 'public');

		transport.setResponder('prompts/list', req => completeResult(req, { prompts: [{ name: 'p' }] }));
		const prompts = await handler.listPromptsEx();
		assert.deepStrictEqual(prompts.items.map(p => p.name), ['p']);
		assert.strictEqual(prompts.cacheHint.ttlMs, undefined);
	});

	test('cancellation uses the transport for HTTP', async () => {
		const http = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const httpHandler = await connect(store, services, http, { transportType: McpServerTransportType.HTTP });
		const cts = store.add(new CancellationTokenSource());
		const pending = httpHandler.callTool({ name: 'slow', arguments: {} }, cts.token);
		const request = http.getSentRequests('tools/call')[0];

		cts.cancel();
		await assert.rejects(pending, isCancelled);
		assert.deepStrictEqual(http.getCancelledRequests(), [request.id]);
		assert.strictEqual(sentMethods(http).includes('notifications/cancelled'), false);
	});

	test('cancellation sends notifications/cancelled for stdio', async () => {
		const stdio = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const stdioHandler = await connect(store, services, stdio, { transportType: McpServerTransportType.Stdio });
		const cts = store.add(new CancellationTokenSource());
		const pending = stdioHandler.callTool({ name: 'slow', arguments: {} }, cts.token);
		const request = stdio.getSentRequests('tools/call')[0];

		cts.cancel();
		await assert.rejects(pending, isCancelled);
		assert.deepStrictEqual(stdio.getCancelledRequests(), []);
		const cancelled = stdio.getSentMessages().filter(m => isJsonRpcNotification(m) && m.method === 'notifications/cancelled');
		assert.strictEqual(cancelled.length, 1);
		assert.deepStrictEqual((cancelled[0] as { params: unknown }).params, { requestId: request.id });
	});

	test('roots changes are not announced to modern servers', async () => {
		handler.roots = [{ uri: 'file:///root' }];
		assert.strictEqual(sentMethods(transport).includes('notifications/roots/list_changed'), false);
	});
});

suite('Workbench - MCP - ServerRequestHandler - input_required', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let services: ITestServices;
	let transport: SignallingTransport;
	let handler: McpServerRequestHandler;
	let elicitation: sinon.SinonStub;
	let sampling: sinon.SinonStub;

	setup(async () => {
		services = createTestServices(store);
		transport = store.add(new SignallingTransport({ era: 'modern' }));
		elicitation = sinon.stub().resolves({ action: 'accept', content: { name: 'Ada' } });
		sampling = sinon.stub().resolves({ role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'test-model' });
		handler = await connect(store, services, transport, { elicitationRequestHandler: elicitation, createMessageRequestHandler: sampling });
	});

	const nextRequest = (method: string, count: number): Promise<IJsonRpcRequest> => transport.requestSent(method, count);

	test('a form elicitation is answered and the call is retried with the responses and the state', async () => {
		const context = { chatSessionResource: undefined, chatRequestId: 'req-1' };
		const call = handler.callTool({ name: 'ask', arguments: { q: 1 } }, CancellationToken.None, undefined, context);
		const first = await nextRequest('tools/call', 1);
		transport.simulateInputRequired(first.id, FORM_ELICITATION, 'state-1');

		const second = await nextRequest('tools/call', 2);
		assert.notStrictEqual(second.id, first.id);
		assert.strictEqual(elicitation.callCount, 1);
		assert.deepStrictEqual(elicitation.firstCall.args[0], FORM_ELICITATION.e1.params);
		assert.strictEqual(elicitation.firstCall.args[2], context);
		assert.strictEqual(elicitation.firstCall.args[3], undefined, 'form elicitations carry no options');
		const params = paramsOf(second);
		assert.strictEqual(params.name, 'ask');
		assert.deepStrictEqual(params.arguments, { q: 1 });
		assert.deepStrictEqual(params.inputResponses, { e1: { action: 'accept', content: { name: 'Ada' } } });
		assert.strictEqual(params.requestState, 'state-1');
		assert.strictEqual(paramsOf(first).requestState, undefined);

		transport.simulateResult(second.id, { content: [{ type: 'text', text: 'done' }] });
		const result = await call;
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'done' }]);
	});

	test('a declined elicitation is passed through without validation', async () => {
		elicitation.resolves({ action: 'decline' });
		const call = handler.callTool({ name: 'ask', arguments: {} });
		transport.simulateInputRequired((await nextRequest('tools/call', 1)).id, FORM_ELICITATION);
		const second = await nextRequest('tools/call', 2);
		assert.deepStrictEqual(paramsOf(second).inputResponses, { e1: { action: 'decline' } });
		assert.strictEqual(Object.prototype.hasOwnProperty.call(paramsOf(second), 'requestState'), false);
		transport.simulateResult(second.id, { content: [] });
		await call;
	});

	test('sampling input requests are answered by the sampling handler', async () => {
		const call = handler.callTool({ name: 'ask', arguments: {} });
		const samplingParams: MCP.CreateMessageRequestParams = { messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }], maxTokens: 10 };
		transport.simulateInputRequired((await nextRequest('tools/call', 1)).id, { s1: { method: 'sampling/createMessage', params: samplingParams } }, 'state-2');

		const second = await nextRequest('tools/call', 2);
		assert.strictEqual(sampling.callCount, 1);
		assert.deepStrictEqual(sampling.firstCall.args[0], samplingParams);
		assert.deepStrictEqual(paramsOf(second).inputResponses, { s1: { role: 'assistant', content: { type: 'text', text: 'hi' }, model: 'test-model' } });
		assert.strictEqual(paramsOf(second).requestState, 'state-2');
		transport.simulateResult(second.id, { content: [] });
		await call;
	});

	test('roots input requests are answered from the handler roots', async () => {
		handler.roots = [{ uri: 'file:///workspace', name: 'workspace' }];
		const call = handler.callTool({ name: 'ask', arguments: {} });
		transport.simulateInputRequired((await nextRequest('tools/call', 1)).id, ROOTS_INPUT);

		const second = await nextRequest('tools/call', 2);
		assert.deepStrictEqual(paramsOf(second).inputResponses, { r1: { roots: [{ uri: 'file:///workspace', name: 'workspace' }] } });
		transport.simulateResult(second.id, { content: [] });
		await call;
	});

	test('several input requests in one round are answered together', async () => {
		handler.roots = [];
		const call = handler.callTool({ name: 'ask', arguments: {} });
		transport.simulateInputRequired((await nextRequest('tools/call', 1)).id, { ...ROOTS_INPUT, ...FORM_ELICITATION });
		const second = await nextRequest('tools/call', 2);
		assert.deepStrictEqual(Object.keys(paramsOf(second).inputResponses as object), ['r1', 'e1']);
		transport.simulateResult(second.id, { content: [] });
		await call;
	});

	test('an undeclared input kind rejects the call', async () => {
		const plain = store.add(new SignallingTransport({ era: 'modern' }));
		const plainHandler = await connect(store, services, plain);
		const call = plainHandler.callTool({ name: 'ask', arguments: {} });
		plain.simulateInputRequired((await plain.requestSent('tools/call', 1)).id, FORM_ELICITATION);

		await assert.rejects(call, (e: unknown) => e instanceof McpClientError && e.reason === 'undeclared-input-request');
		assert.strictEqual(plain.getSentRequests('tools/call').length, 1);

		const samplingCall = plainHandler.callTool({ name: 'ask', arguments: {} });
		plain.simulateInputRequired((await plain.requestSent('tools/call', 2)).id, { s: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } } });
		await assert.rejects(samplingCall, (e: unknown) => e instanceof McpClientError && e.reason === 'undeclared-input-request');
	});

	test('a malformed input_required result rejects the call', async () => {
		const call = handler.callTool({ name: 'ask', arguments: {} });
		const first = await nextRequest('tools/call', 1);
		transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: first.id, result: { resultType: 'input_required', inputRequests: { t: { method: 'tools/call' } } } });
		await assert.rejects(call, (e: unknown) => e instanceof McpClientError && e.reason === 'invalid-input-request');
	});

	test('more than ten rounds reject the call', async () => {
		transport.setResponder('tools/call', req => inputRequiredResult(req, {}, 'again'));
		const statuses: string[] = [];
		await assert.rejects(handler.callTool({ name: 'ask', arguments: {} }, CancellationToken.None, m => statuses.push(m)), (e: unknown) => e instanceof McpClientError && e.reason === 'too-many-rounds');
		assert.strictEqual(transport.getSentRequests('tools/call').length, 11);
		assert.strictEqual(statuses.length, 10);
		assert.strictEqual(statuses[0], 'Round 1: answered 0 input request(s)');
		// state-only rounds carry the state but no responses
		const last = paramsOf(transport.getSentRequests('tools/call')[10]);
		assert.strictEqual(last.requestState, 'again');
		assert.strictEqual(Object.prototype.hasOwnProperty.call(last, 'inputResponses'), false);
	});

	test('elicitation content that does not match the requested schema rejects the call', async () => {
		elicitation.resolves({ action: 'accept', content: { name: 42 } });
		const call = handler.callTool({ name: 'ask', arguments: {} });
		transport.simulateInputRequired((await nextRequest('tools/call', 1)).id, FORM_ELICITATION);
		await assert.rejects(call, (e: unknown) => e instanceof McpClientError && e.reason === 'invalid-elicit-content');
		assert.strictEqual(transport.getSentRequests('tools/call').length, 1);
	});

	test('a URL elicitation asked twice is resumed the second time', async () => {
		elicitation.resolves({ action: 'accept' });
		const urlRequest = (url: string): MCP.InputRequests => ({ u: { method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', url } } });
		let calls = 0;
		transport.setResponder('tools/call', req => {
			calls++;
			if (calls <= 2) {
				return inputRequiredResult(req, urlRequest('https://example.com/auth'), `s${calls}`);
			}
			if (calls === 3) {
				return inputRequiredResult(req, urlRequest('https://example.com/other'));
			}
			return completeResult(req, { content: [{ type: 'text', text: 'signed in' }] });
		});

		const result = await handler.callTool({ name: 'ask', arguments: {} });
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'signed in' }]);
		assert.strictEqual(elicitation.callCount, 3);
		assert.deepStrictEqual(elicitation.getCall(0).args[3], { resume: false });
		assert.deepStrictEqual(elicitation.getCall(1).args[3], { resume: true });
		assert.deepStrictEqual(elicitation.getCall(2).args[3], { resume: false }, 'another URL is a new elicitation');
		assert.deepStrictEqual(paramsOf(transport.getSentRequests('tools/call')[1]).inputResponses, { u: { action: 'accept' } });
	});

	test('a resource read answered after an input round is not cacheable', async () => {
		let reads = 0;
		transport.setResponder('resources/read', req => ++reads === 1
			? inputRequiredResult(req, ROOTS_INPUT)
			: completeResult(req, { contents: [{ uri: 'file:///x', text: 'hi' }], ttlMs: 60_000, cacheScope: 'public' }));

		const result = await handler.readResource({ uri: 'file:///x' });
		assert.strictEqual(reads, 2);
		assert.deepStrictEqual(result.contents, [{ uri: 'file:///x', text: 'hi' }]);
		assert.strictEqual((result as { ttlMs?: number }).ttlMs, 0);

		const direct = await handler.readResource({ uri: 'file:///x' });
		assert.strictEqual((direct as { ttlMs?: number }).ttlMs, 60_000, 'a read without rounds keeps the server ttl');
	});

	test('prompts are fetched through the same loop', async () => {
		let gets = 0;
		transport.setResponder('prompts/get', req => ++gets === 1
			? inputRequiredResult(req, FORM_ELICITATION, 'p-state')
			: completeResult(req, { messages: [{ role: 'user', content: { type: 'text', text: 'Hello Ada' } }] }));
		const result = await handler.getPrompt({ name: 'greet', arguments: { who: 'Ada' } });
		assert.strictEqual(result.messages.length, 1);
		const retry = paramsOf(transport.getSentRequests('prompts/get')[1]);
		assert.strictEqual(retry.requestState, 'p-state');
		assert.deepStrictEqual(retry.arguments, { who: 'Ada' });
		assert.deepStrictEqual(transport.getSentEnvelope('prompts/get')?.headers, { 'Mcp-Method': 'prompts/get', 'Mcp-Name': 'greet' });
	});

	test('reports an mrtr protocol event with the rounds and input kinds', async () => {
		const events: McpProtocolEvent[] = [];
		store.add(handler.onDidReportProtocolEvent(e => events.push(e)));
		let calls = 0;
		transport.setResponder('tools/call', req => {
			calls++;
			if (calls === 1) {
				return inputRequiredResult(req, { ...ROOTS_INPUT, s: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } } });
			}
			if (calls === 2) {
				return inputRequiredResult(req, FORM_ELICITATION);
			}
			return completeResult(req, { content: [] });
		});
		const statuses: string[] = [];

		await handler.callTool({ name: 'ask', arguments: {} }, CancellationToken.None, m => statuses.push(m));
		assert.deepStrictEqual(events, [{ kind: 'mrtr', method: 'tools/call', rounds: 2, inputKinds: ['roots/list', 'sampling/createMessage', 'elicitation/create'] }]);
		assert.deepStrictEqual(statuses, ['Round 1: answered 2 input request(s)', 'Round 2: answered 1 input request(s)']);

		// a call without rounds reports nothing
		await handler.callTool({ name: 'ask', arguments: {} });
		assert.strictEqual(events.length, 1);
	});

	test('cancelling the token while the retry is pending ends the loop', async () => {
		const cts = store.add(new CancellationTokenSource());
		const call = handler.callTool({ name: 'ask', arguments: {} }, cts.token);
		transport.simulateInputRequired((await nextRequest('tools/call', 1)).id, ROOTS_INPUT);
		const second = await nextRequest('tools/call', 2);

		cts.cancel();
		await assert.rejects(call, isCancelled);
		assert.ok(transport.getCancelledRequests().includes(second.id));

		// a late answer does not restart the loop
		transport.simulateInputRequired(second.id, ROOTS_INPUT);
		await timeout(5);
		assert.strictEqual(transport.getSentRequests('tools/call').length, 2);
	});

	test('cancelling the token while the user is asked ends the loop', async () => {
		const asked = new DeferredPromise<void>();
		elicitation.callsFake((_req: unknown, token: CancellationToken) => {
			asked.complete();
			return rejectWhenCancelled(token);
		});
		const cts = store.add(new CancellationTokenSource());
		const call = handler.callTool({ name: 'ask', arguments: {} }, cts.token);
		transport.simulateInputRequired((await nextRequest('tools/call', 1)).id, FORM_ELICITATION);
		await asked.p;

		cts.cancel();
		await assert.rejects(call, isCancelled);
		await timeout(5);
		assert.strictEqual(transport.getSentRequests('tools/call').length, 1);
	});
});

suite('Workbench - MCP - ServerRequestHandler - listen', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let services: ITestServices;
	let transport: SignallingTransport;
	let handler: McpServerRequestHandler;

	setup(async () => {
		services = createTestServices(store);
		transport = store.add(new SignallingTransport({ era: 'modern' }));
		handler = await connect(store, services, transport);
	});

	test('the lists stream is opened with the filter derived from the capabilities', () => {
		const listen = transport.getSentRequests('subscriptions/listen');
		assert.strictEqual(listen.length, 1);
		assert.deepStrictEqual(paramsOf(listen[0]).notifications, { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
		assert.ok(paramsOf(listen[0])._meta, 'listen requests carry _meta too');
		const envelope = transport.getSentEnvelope('subscriptions/listen');
		assert.strictEqual(envelope?.kind, 'listen');
		assert.strictEqual(envelope?.requestId, listen[0].id);
		assert.deepStrictEqual(envelope?.headers, { 'Mcp-Method': 'subscriptions/listen' });
	});

	test('only the kinds the server announces are requested', async () => {
		const partial = store.add(new TestMcpMessageTransport({ era: 'modern', discoverResult: { capabilities: { tools: { listChanged: true }, prompts: {}, resources: { subscribe: true } } } }));
		await connect(store, services, partial);
		assert.deepStrictEqual(paramsOf(partial.getSentRequests('subscriptions/listen')[0]).notifications, { toolsListChanged: true });

		const none = store.add(new TestMcpMessageTransport({ era: 'modern', discoverResult: { capabilities: { tools: {} } } }));
		await connect(store, services, none);
		assert.strictEqual(none.getSentRequests('subscriptions/listen').length, 0);
	});

	test('list change events on the stream fire the handler events', async () => {
		const listenId = transport.getSentRequests('subscriptions/listen')[0].id;
		const counts = { tools: 0, prompts: 0, resources: 0 };
		store.add(handler.onDidChangeToolList(() => counts.tools++));
		store.add(handler.onDidChangePromptList(() => counts.prompts++));
		store.add(handler.onDidChangeResourceList(() => counts.resources++));
		await timeout(1); // the acknowledgement arrives

		transport.simulateListenEvent(listenId, 'notifications/tools/list_changed');
		transport.simulateListenEvent(listenId, 'notifications/prompts/list_changed');
		transport.simulateListenEvent(listenId, 'notifications/resources/list_changed');
		await timeout(0);
		assert.deepStrictEqual(counts, { tools: 1, prompts: 1, resources: 1 });

		transport.simulateListenEvent(9999, 'notifications/tools/list_changed');
		await timeout(0);
		assert.strictEqual(counts.tools, 1, 'events of unknown streams are dropped');
	});

	test('subscribeResource opens a resources stream and routes updates', async () => {
		const updates: MCP.ResourceUpdatedNotificationParams[] = [];
		store.add(handler.onDidUpdateResource(e => updates.push(e)));

		const subscription = handler.subscribeResource('file:///a.txt');
		const resources = await transport.requestSent('subscriptions/listen', 2);
		assert.deepStrictEqual(paramsOf(resources).notifications, { resourceSubscriptions: ['file:///a.txt'] });
		assert.deepStrictEqual([...handler.subscriptions!.subscribedUris], ['file:///a.txt']);

		transport.simulateListenEvent(resources.id, 'notifications/resources/updated', { uri: 'file:///a.txt' });
		await timeout(0);
		assert.strictEqual(updates.length, 1);
		assert.strictEqual(updates[0].uri, 'file:///a.txt');

		subscription.dispose();
		await transport.requestCancelled(resources.id);
		assert.strictEqual(transport.getSentRequests('subscriptions/listen').length, 2);
		assert.strictEqual(transport.getSentRequests('resources/subscribe').length, 0);
		assert.strictEqual(transport.getSentRequests('resources/unsubscribe').length, 0);
	});

	test('a cancelled listen stream is reported and re-opened', async () => {
		const events: McpProtocolEvent[] = [];
		store.add(handler.onDidReportProtocolEvent(e => events.push(e)));
		const listenId = transport.getSentRequests('subscriptions/listen')[0].id;
		await timeout(1);

		transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: listenId } });
		await transport.requestSent('subscriptions/listen', 2);
		assert.deepStrictEqual(events, [{ kind: 'listen-reconnect', stream: 'lists', reason: 'cancelled by the server', backoffMs: 0 }]);
	});

	test('a legacy server gets resources/subscribe and resources/unsubscribe', async () => {
		const legacy = store.add(new TestMcpMessageTransport({ initializeResult: { capabilities: { resources: { subscribe: true } } } }));
		legacy.setResponder('resources/subscribe', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: {} }));
		legacy.setResponder('resources/unsubscribe', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: {} }));
		const legacyHandler = await connect(store, services, legacy);
		const updates: MCP.ResourceUpdatedNotificationParams[] = [];
		store.add(legacyHandler.onDidUpdateResource(e => updates.push(e)));

		const subscription = legacyHandler.subscribeResource('file:///a.txt');
		assert.deepStrictEqual(legacy.getSentRequests('resources/subscribe').map(paramsOf), [{ uri: 'file:///a.txt' }]);
		await timeout(5); // the server acknowledges

		legacy.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, method: 'notifications/resources/updated', params: { uri: 'file:///a.txt' } });
		assert.deepStrictEqual(updates, [{ uri: 'file:///a.txt' }]);

		subscription.dispose();
		subscription.dispose();
		assert.deepStrictEqual(legacy.getSentRequests('resources/unsubscribe').map(paramsOf), [{ uri: 'file:///a.txt' }]);
		assert.strictEqual(legacy.getSentRequests('subscriptions/listen').length, 0);
	});

	test('a legacy server gets the roots list_changed notification', async () => {
		const legacy = store.add(new TestMcpMessageTransport());
		const legacyHandler = await connect(store, services, legacy);
		legacy.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: 5, method: 'roots/list' });
		await timeout(0);
		legacyHandler.roots = [{ uri: 'file:///root' }];
		assert.strictEqual(sentMethods(legacy).includes('notifications/roots/list_changed'), true);
	});
});

suite('Workbench - MCP - ServerRequestHandler - errors and aborts', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let services: ITestServices;

	setup(() => {
		services = createTestServices(store);
	});

	test('a transport abort rejects the pending request with request-aborted', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport);
		const pending = handler.listTools();
		const request = transport.getSentRequests('tools/list')[0];

		transport.simulateAbort({ requestId: 12345, reason: 'stream-closed' }); // unknown ids are ignored
		transport.simulateAbort({ requestId: request.id, reason: 'stream-closed', message: 'The response stream ended' });
		await assert.rejects(pending, (e: unknown) => {
			assert.ok(e instanceof McpClientError);
			assert.strictEqual(e.reason, 'request-aborted');
			assert.strictEqual(e.message, 'The response stream ended');
			assert.strictEqual((e.detail as IMcpRequestAbort).reason, 'stream-closed');
			return true;
		});
		assert.strictEqual(sentMethods(transport).includes('notifications/cancelled'), false);
	});

	test('a gRPC status-only abort with a JSON-RPC equivalent is a protocol error; transport statuses stay request-aborted', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport);

		const invalid = handler.listTools();
		transport.simulateAbort({ requestId: transport.getSentRequests('tools/list')[0].id, reason: 'grpc-status', grpcStatus: GrpcStatus.INVALID_ARGUMENT, message: 'bad cursor' });
		await assert.rejects(invalid, (e: unknown) => {
			assert.ok(e instanceof MpcResponseError, String(e));
			assert.strictEqual(e.code, MCP.INVALID_PARAMS);
			assert.ok(e.message.includes('bad cursor'), e.message);
			assert.deepStrictEqual(e.data, { grpcStatus: GrpcStatus.INVALID_ARGUMENT });
			return true;
		});

		const unimplemented = handler.listPrompts();
		transport.simulateAbort({ requestId: transport.getSentRequests('prompts/list')[0].id, reason: 'grpc-status', grpcStatus: GrpcStatus.UNIMPLEMENTED });
		await assert.rejects(unimplemented, (e: unknown) => e instanceof MpcResponseError && e.code === MCP.METHOD_NOT_FOUND);

		const unavailable = handler.listResources();
		transport.simulateAbort({ requestId: transport.getSentRequests('resources/list')[0].id, reason: 'grpc-status', grpcStatus: GrpcStatus.UNAVAILABLE, message: 'connection reset' });
		await assert.rejects(unavailable, (e: unknown) => {
			assert.ok(e instanceof McpClientError, String(e));
			assert.strictEqual(e.reason, 'request-aborted');
			assert.strictEqual((e.detail as IMcpRequestAbort).grpcStatus, GrpcStatus.UNAVAILABLE);
			return true;
		});
	});

	test('an aborted request without a message gets a default one', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport);
		const pending = handler.listTools();
		transport.simulateAbort({ requestId: transport.getSentRequests('tools/list')[0].id, reason: 'deadline' });
		await assert.rejects(pending, (e: unknown) => e instanceof McpClientError && e.message.includes('deadline'));
	});

	test('a modern server may only send ping requests', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		await connect(store, services, transport);

		transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: 50, method: 'ping' });
		transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: 51, method: 'roots/list' });
		transport.simulateReceiveMessage({ jsonrpc: MCP.JSONRPC_VERSION, id: 52, method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } });
		await timeout(0);

		const responses = transport.getSentMessages().filter(isJsonRpcResponse);
		const byId = (id: number) => responses.find(r => r.id === id);
		assert.deepStrictEqual(byId(50), { jsonrpc: '2.0', id: 50, result: {} });
		assert.strictEqual((byId(51) as { error?: { code: number } } | undefined)?.error?.code, MCP.METHOD_NOT_FOUND);
		assert.strictEqual((byId(52) as { error?: { code: number } } | undefined)?.error?.code, MCP.METHOD_NOT_FOUND);
	});

	test('a cancelled notification from a legacy server cancels the server request handler', async () => {
		let seenToken: CancellationToken | undefined;
		const sampling = sinon.stub().callsFake((_req: unknown, token: CancellationToken) => {
			seenToken = token;
			return rejectWhenCancelled(token);
		});
		const transport = store.add(new TestMcpMessageTransport());
		const handler = await connect(store, services, transport, { createMessageRequestHandler: sampling });
		const cancelledNotifications: MCP.CancelledNotificationParams[] = [];
		store.add(handler.onDidReceiveCancelledNotification(e => cancelledNotifications.push(e)));

		transport.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: 77, method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } });
		await timeout(0);
		assert.ok(seenToken, 'the sampling handler was invoked');
		assert.strictEqual(seenToken.isCancellationRequested, false);

		transport.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: 77, reason: 'user' } });
		assert.strictEqual(seenToken.isCancellationRequested, true);
		assert.deepStrictEqual(cancelledNotifications, [{ requestId: 77, reason: 'user' }]);
		await timeout(0);
		assert.strictEqual(transport.getSentMessages().some(m => isJsonRpcResponse(m) && m.id === 77), false, 'no response is sent for a cancelled request');
	});

	test('a legacy server request for an undeclared client method gets -32601', async () => {
		const transport = store.add(new TestMcpMessageTransport());
		await connect(store, services, transport);
		transport.simulateReceiveMessage({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: 78, method: 'elicitation/create', params: { message: 'm', requestedSchema: { type: 'object', properties: {} } } });
		await timeout(0);
		const response = transport.getSentMessages().filter(isJsonRpcResponse).find(r => r.id === 78) as { error?: { code: number } } | undefined;
		assert.strictEqual(response?.error?.code, MCPLegacy.METHOD_NOT_FOUND);
	});

	test('requests after dispose are rejected with a cancellation', async () => {
		const transport = store.add(new TestMcpMessageTransport({ era: 'modern' }));
		const handler = await connect(store, services, transport);
		handler.dispose();
		await assert.rejects(handler.listTools(), isCancelled);
	});
});
