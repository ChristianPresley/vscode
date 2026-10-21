/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IJsonRpcErrorResponse, IJsonRpcSuccessResponse, JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { compileJsonSchema, isCompiledJsonSchema } from '../../../../base/common/jsonSchemaValidator/index.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { IMcpGatewayInvokeContext, IMcpGatewaySingleServerInvoker } from '../../common/mcpGateway.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { CONFORMANCE_HIDDEN_TOOL, CONFORMANCE_INSTRUCTIONS, CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { IMcpGatewayNotification, McpGatewayDispatcher } from '../../node/mcpGatewayDispatcher.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';
import { containsRequest, IMcpGatewayRequestBroker, IMcpGatewaySessionStream, isInitializeMessage, LEGACY_SESSION_IDLE_TIMEOUT_MS, MAX_LEGACY_RESOURCE_SUBSCRIPTIONS, MAX_LEGACY_SUBSCRIPTION_URI_LENGTH, McpGatewaySession } from '../../node/mcpGatewaySession.js';

/** Whether `value` is valid against `#/$defs/<typeName>` of a schema document. */
function compileAndValidate(schema: { readonly $schema: string; readonly $defs: Record<string, unknown> }, typeName: string, value: unknown): boolean {
	const compiled = compileJsonSchema({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${typeName}` });
	assert.ok(isCompiledJsonSchema(compiled));
	return compiled.validate(value).valid;
}

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

	async function initialize(session: McpGatewaySession, capabilities: MCP.ClientCapabilities = { sampling: {}, elicitation: {}, roots: {} }, protocolVersion = '2025-11-25'): Promise<void> {
		await session.handleIncoming({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion, capabilities, clientInfo: { name: 'test-client', version: '1.0.0' } } });
		await session.handleIncoming({ jsonrpc: '2.0', method: 'notifications/initialized' });
	}

	/** An invoker whose `wait` tool records its invoke context and runs until it is cancelled. */
	function waitingInvoker() {
		const started = store.add(new Emitter<IMcpGatewayInvokeContext | undefined>());
		const contexts: Array<IMcpGatewayInvokeContext | undefined> = [];
		const invoker: IMcpGatewaySingleServerInvoker = {
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			listTools: async () => [{ name: 'wait', description: 'Waits for cancellation', inputSchema: { type: 'object' } }],
			callTool: async (_name, _args, context) => {
				contexts.push(context);
				started.fire(context);
				await new Promise<void>(resolve => {
					if (!context || context.token.isCancellationRequested) {
						resolve();
						return;
					}
					const listener = context.token.onCancellationRequested(() => {
						listener.dispose();
						resolve();
					});
				});
				return { content: [{ type: 'text', text: 'finished' }] };
			},
			listResources: async () => [],
			readResource: async () => ({ contents: [] }),
			listResourceTemplates: async () => [],
		};
		const dispatcher = store.add(new McpGatewayDispatcher('route-1', logger, invoker, new McpGatewaySealedState()));
		const session = (id: string) => store.add(new McpGatewaySession(id, logger, dispatcher, invoker, () => { }));
		return { session, started: started.event, contexts };
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

	test('the answers to a 2025-11-25 session validate against the 2025-11-25 schema: initialize (with and without instructions, with a title), ping, tools/list', async () => {
		const fixtureRoot = FileAccess.asFileUri('vs/platform/mcp/test/node/fixtures/mcp-schema-2025-11-25').fsPath;
		const schema = JSON.parse(readFileSync(join(fixtureRoot, 'schema.json'), 'utf8')) as { $schema: string; $defs: Record<string, unknown> };
		const validatorOf = (typeName: string) => {
			assert.ok(schema.$defs[typeName], `the schema defines ${typeName}`);
			const compiled = compileJsonSchema({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${typeName}` });
			assert.ok(isCompiledJsonSchema(compiled), `${typeName} compiles: ${JSON.stringify(compiled)}`);
			return (value: unknown, what: string) => {
				const result = compiled.validate(value);
				assert.ok(result.valid, `${what} is a valid ${typeName}: ${result.errors.map(e => `${e.instancePath} ${e.keyword}: ${e.message}`).join('; ')}`);
			};
		};
		const initializeResult = validatorOf('InitializeResult');
		const resultResponse = validatorOf('JSONRPCResultResponse');

		const { session } = setup();
		const responses = await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { sampling: {} }, clientInfo: { name: 'test-client', version: '1.0.0' } } });
		resultResponse(responses[0], 'the initialize response');
		initializeResult(resultOf(responses), 'the result with instructions');

		// Without instructions, and with a server title.
		const bare: IMcpGatewaySingleServerInvoker = { onDidChangeTools: Event.None, onDidChangeResources: Event.None, listTools: async () => [], callTool: async () => ({ content: [] }), listResources: async () => [], readResource: async () => ({ contents: [] }), listResourceTemplates: async () => [] };
		const dispatcher = store.add(new McpGatewayDispatcher('route-2', logger, bare, new McpGatewaySealedState(), { serverInfo: { name: 'titled', title: 'Titled Server', version: '2.0.0' } }));
		const titled = store.add(new McpGatewaySession('session-2', logger, dispatcher, bare, () => { }));
		const titledResult = resultOf(await titled.handleIncoming({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }));
		assert.deepStrictEqual([titledResult.instructions, (titledResult.serverInfo as MCP.Implementation).title], [undefined, 'Titled Server']);
		initializeResult(titledResult, 'the result without instructions');

		await session.handleIncoming({ jsonrpc: '2.0', method: 'notifications/initialized' });
		const ping = await session.handleIncoming({ jsonrpc: '2.0', id: 2, method: 'ping' });
		resultResponse(ping[0], 'the ping response');
		validatorOf('EmptyResult')(resultOf(ping), 'the ping result');
		const tools = await session.handleIncoming({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
		resultResponse(tools[0], 'the tools/list response');
		validatorOf('ListToolsResult')(resultOf(tools), 'the tools/list result');

		// Negative control: the schema is strict enough to catch a broken result.
		assert.strictEqual(compileAndValidate(schema, 'InitializeResult', { protocolVersion: '2025-11-25', capabilities: {} }), false, 'serverInfo is required');
		assert.strictEqual(compileAndValidate(schema, 'InitializeResult', { ...resultOf(responses), serverInfo: { name: 'x' } }), false, 'serverInfo.version is required');
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

	test('a message that belongs to no request goes on one stream only: the most recent open GET stream', async () => {
		const { session, invoker } = setup();
		const conformance = invoker as McpGatewayConformanceInvoker;
		await initialize(session);
		const older = store.add(new TestStream(session));
		const newer = store.add(new TestStream(session));
		session.attachStream(older);
		session.attachStream(newer);
		conformance.setToolHidden(CONFORMANCE_HIDDEN_TOOL, false);
		assert.deepStrictEqual([older.methods, newer.methods], [[], ['notifications/tools/list_changed']]);
		newer.end();
		conformance.setPromptHidden('test_hidden_prompt', false);
		assert.deepStrictEqual([older.methods, newer.methods], [['notifications/prompts/list_changed'], ['notifications/tools/list_changed']], 'the older stream takes over once the newer one closed');
		await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: 'test://watched-resource' } });
		conformance.touchResource('test://watched-resource');
		assert.deepStrictEqual(older.methods, ['notifications/prompts/list_changed', 'notifications/resources/updated']);
		assert.strictEqual(newer.notifications.length, 1);
		older.end();
	});

	test('cancellation is scoped to the session: another session\'s request with the same id runs on', async () => {
		const { session, started } = waitingInvoker();
		const a = session('a');
		const b = session('b');
		await initialize(a);
		await initialize(b);
		const startedA = Event.toPromise(started);
		const callA = a.handleIncoming({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait', arguments: {} } }, store.add(new TestStream(a)));
		await startedA;
		const startedB = Event.toPromise(started);
		const callB = b.handleIncoming({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait', arguments: {} } }, store.add(new TestStream(b)));
		const contextB = await startedB;
		await b.handleIncoming({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
		assert.deepStrictEqual(await callB, [], 'session b\'s request was cancelled');
		assert.strictEqual(contextB?.token.isCancellationRequested, true);
		assert.strictEqual(a.cancelRequest(7), true, 'session a\'s request with the same id was still in flight');
		assert.deepStrictEqual(await callA, []);
	});

	test('the polling hook (closeSseStream) is offered from 2025-11-25 on, when the sink can close for polling', async () => {
		const run = async (version: string, closeForPolling: boolean) => {
			const { session, started } = waitingInvoker();
			const s = session('s');
			await initialize(s, {}, version);
			let closed = 0;
			const sink = store.add(new TestStream(s));
			const target = closeForPolling ? Object.assign(sink, { closeForPolling: () => { closed++; return true; } }) : sink;
			const cts = new CancellationTokenSource();
			const callStarted = Event.toPromise(started);
			const call = s.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: {} } }, target, {}, cts.token);
			const hook = (await callStarted)?.closeSseStream;
			hook?.();
			cts.cancel();
			await call;
			cts.dispose();
			return { offered: typeof hook === 'function', closed, priming: s.supportsPriming };
		};
		assert.deepStrictEqual(await run('2025-11-25', true), { offered: true, closed: 1, priming: true });
		assert.deepStrictEqual(await run('2025-06-18', true), { offered: false, closed: 0, priming: false });
		assert.deepStrictEqual(await run('2025-03-26', true), { offered: false, closed: 0, priming: false });
		assert.deepStrictEqual(await run('2025-11-25', false), { offered: false, closed: 0, priming: true }, 'a sink that cannot close for polling offers no hook');
	});

	test('an idle session expires; messages in flight and open responses keep it alive', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		const { session, disposedCount } = setup();
		await initialize(session);
		await timeout(LEGACY_SESSION_IDLE_TIMEOUT_MS - 1000);
		assert.strictEqual(disposedCount(), 0);
		// A request restarts the clock.
		await session.handleIncoming({ jsonrpc: '2.0', id: 1, method: 'ping' });
		await timeout(LEGACY_SESSION_IDLE_TIMEOUT_MS - 1000);
		assert.strictEqual(disposedCount(), 0);
		const stream = store.add(new TestStream(session));
		session.attachStream(stream);
		await timeout(LEGACY_SESSION_IDLE_TIMEOUT_MS * 2);
		assert.strictEqual(disposedCount(), 0, 'an open stream keeps the session');
		const otherResponse = new Emitter<void>();
		session.holdOpen(otherResponse.event);
		stream.end();
		await timeout(LEGACY_SESSION_IDLE_TIMEOUT_MS * 2);
		assert.strictEqual(disposedCount(), 0, 'another open response (a resumed request stream) keeps it too');
		otherResponse.fire();
		otherResponse.dispose();
		await timeout(LEGACY_SESSION_IDLE_TIMEOUT_MS - 1000);
		assert.strictEqual(disposedCount(), 0);
		await timeout(2000);
		assert.strictEqual(disposedCount(), 1, 'disposed once idle for the whole timeout');
	}));

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

	/** An invoker that records the upstream resource subscriptions it holds open. */
	function subscribingInvoker() {
		const open = new Set<string>();
		const invoker: IMcpGatewaySingleServerInvoker = {
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			capabilities: { resources: { subscribe: true } },
			listTools: async () => [],
			callTool: async () => ({ content: [] }),
			listResources: async () => [],
			readResource: async () => ({ contents: [] }),
			listResourceTemplates: async () => [],
			subscribeResource: async uri => {
				open.add(uri);
				return { dispose: () => open.delete(uri) };
			},
		};
		return { invoker, open };
	}

	test(`resources/subscribe: a session keeps at most ${MAX_LEGACY_RESOURCE_SUBSCRIPTIONS} subscriptions, also when they are opened concurrently (-32603); a repeated URI is no new one, an unsubscribe makes room`, async () => {
		const { invoker, open } = subscribingInvoker();
		const { session } = setup(invoker);
		await initialize(session);
		const subscribe = (id: number, uri: string) => session.handleIncoming({ jsonrpc: '2.0', id, method: 'resources/subscribe', params: { uri } });

		// All at once: the subscriptions still being opened count too.
		const answers = await Promise.all(Array.from({ length: MAX_LEGACY_RESOURCE_SUBSCRIPTIONS + 1 }, (_, i) => subscribe(i, `test://r/${i}`)));
		const refused = answers.filter(responses => (responses[0] as IJsonRpcErrorResponse).error !== undefined);
		assert.deepStrictEqual(refused.map(errorOf).map(error => error.code), [MCP.INTERNAL_ERROR]);
		assert.strictEqual(open.size, MAX_LEGACY_RESOURCE_SUBSCRIPTIONS);
		assert.ok(!open.has(`test://r/${MAX_LEGACY_RESOURCE_SUBSCRIPTIONS}`), 'the refused subscription never reached the server');

		assert.deepStrictEqual(resultOf(await subscribe(2000, 'test://r/0')), {}, 'a URI the session already watches');
		assert.strictEqual(errorOf(await subscribe(2001, 'test://another')).code, MCP.INTERNAL_ERROR);
		resultOf(await session.handleIncoming({ jsonrpc: '2.0', id: 2002, method: 'resources/unsubscribe', params: { uri: 'test://r/0' } }));
		assert.deepStrictEqual(resultOf(await subscribe(2003, 'test://another')), {});
		assert.deepStrictEqual([open.size, open.has('test://r/0'), open.has('test://another')], [MAX_LEGACY_RESOURCE_SUBSCRIPTIONS, false, true]);
	});

	test(`resources/subscribe: the subscribed URIs of a session add up to at most ${MAX_LEGACY_SUBSCRIPTION_URI_LENGTH} characters (-32603)`, async () => {
		const { invoker, open } = subscribingInvoker();
		const { session } = setup(invoker);
		await initialize(session);
		const subscribe = (id: number, uri: string) => session.handleIncoming({ jsonrpc: '2.0', id, method: 'resources/subscribe', params: { uri } });
		const prefix = 'test://long/';
		const first = prefix + 'a'.repeat(MAX_LEGACY_SUBSCRIPTION_URI_LENGTH - 20 - prefix.length);
		assert.deepStrictEqual(resultOf(await subscribe(1, first)), {});
		const tooLong = prefix + 'b'.repeat(21 - prefix.length);
		assert.strictEqual(errorOf(await subscribe(2, tooLong)).code, MCP.INTERNAL_ERROR);
		const fits = prefix + 'c'.repeat(20 - prefix.length);
		assert.deepStrictEqual(resultOf(await subscribe(3, fits)), {});
		assert.deepStrictEqual([...open], [first, fits]);
	});

	/** An invoker whose upstream subscriptions open only when the test settles them, one call at a time. */
	function slowSubscribingInvoker() {
		const open = new Set<string>();
		const calls: { readonly uri: string; readonly settle: DeferredPromise<void> }[] = [];
		const onDidCall = store.add(new Emitter<void>());
		const invoker: IMcpGatewaySingleServerInvoker = {
			...subscribingInvoker().invoker,
			subscribeResource: async uri => {
				const settle = new DeferredPromise<void>();
				calls.push({ uri, settle });
				onDidCall.fire();
				await settle.p;
				open.add(uri);
				return { dispose: () => open.delete(uri) };
			},
		};
		const whenCalled = async (count: number) => {
			while (calls.length < count) {
				await Event.toPromise(onDidCall.event);
			}
		};
		return { invoker, open, calls, whenCalled };
	}

	test('resources/subscribe again after an unsubscribe while the first is being opened shares its one upstream call: a failure fails both, a success keeps the subscription', async () => {
		const upstream = slowSubscribingInvoker();
		const { session } = setup(upstream.invoker);
		await initialize(session);
		const send = (id: number, method: string, uri: string) => session.handleIncoming({ jsonrpc: '2.0', id, method, params: { uri } });

		// subscribe, unsubscribe, subscribe again, then the server refuses the first subscription.
		const first = send(1, 'resources/subscribe', 'test://a');
		await upstream.whenCalled(1);
		assert.deepStrictEqual(resultOf(await send(2, 'resources/unsubscribe', 'test://a')), {});
		const again = send(3, 'resources/subscribe', 'test://a');
		await timeout(0);
		assert.strictEqual(upstream.calls.length, 1, 'no second upstream call for the same URI');
		upstream.calls[0].settle.error(new Error('upstream refused the first subscription'));
		assert.strictEqual(errorOf(await first).code, MCP.INTERNAL_ERROR);
		assert.strictEqual(errorOf(await again).code, MCP.INTERNAL_ERROR, 'the client learns that its last subscribe failed: it is not told {} for a subscription nobody holds');
		assert.strictEqual(upstream.open.size, 0);

		// The same, but the server accepts it: the client's last word was subscribe, so the subscription stays.
		const third = send(4, 'resources/subscribe', 'test://b');
		await upstream.whenCalled(2);
		resultOf(await send(5, 'resources/unsubscribe', 'test://b'));
		const fourth = send(6, 'resources/subscribe', 'test://b');
		upstream.calls[1].settle.complete();
		assert.deepStrictEqual([resultOf(await third), resultOf(await fourth)], [{}, {}]);
		assert.deepStrictEqual([upstream.calls.length, [...upstream.open]], [2, ['test://b']]);
		resultOf(await send(7, 'resources/unsubscribe', 'test://b'));
		assert.strictEqual(upstream.open.size, 0, 'and it is the session\'s subscription: unsubscribe closes it');

		// Unsubscribed while it opens, and not subscribed again: closed as soon as it opens.
		const fifth = send(8, 'resources/subscribe', 'test://c');
		await upstream.whenCalled(3);
		resultOf(await send(9, 'resources/unsubscribe', 'test://c'));
		upstream.calls[2].settle.complete();
		assert.deepStrictEqual([resultOf(await fifth), upstream.open.size], [{}, 0]);
	});

	test(`resources/subscribe: a subscription being opened keeps its slot after resources/unsubscribe until the server answers, so subscribe/unsubscribe churn keeps at most ${MAX_LEGACY_RESOURCE_SUBSCRIPTIONS} upstream calls in flight`, async () => {
		const upstream = slowSubscribingInvoker();
		const { session } = setup(upstream.invoker);
		await initialize(session);
		const send = (id: number, method: string, uri: string) => session.handleIncoming({ jsonrpc: '2.0', id, method, params: { uri } });

		const subscribes: Promise<unknown[]>[] = [];
		for (let i = 0; i < MAX_LEGACY_RESOURCE_SUBSCRIPTIONS; i++) {
			subscribes.push(send(2 * i, 'resources/subscribe', `test://churn/${i}`));
			await upstream.whenCalled(i + 1);
			resultOf(await send(2 * i + 1, 'resources/unsubscribe', `test://churn/${i}`));
		}
		assert.strictEqual(errorOf(await send(5000, 'resources/subscribe', 'test://churn/one-more')).code, MCP.INTERNAL_ERROR);
		assert.strictEqual(upstream.calls.length, MAX_LEGACY_RESOURCE_SUBSCRIPTIONS, 'the refused subscription never reached the server');

		for (const call of upstream.calls) {
			call.settle.complete();
		}
		for (const answer of await Promise.all(subscribes)) {
			assert.deepStrictEqual(resultOf(answer), {});
		}
		assert.strictEqual(upstream.open.size, 0, 'each was closed as soon as it opened');

		const late = send(5001, 'resources/subscribe', 'test://churn/one-more');
		await upstream.whenCalled(MAX_LEGACY_RESOURCE_SUBSCRIPTIONS + 1);
		upstream.calls[MAX_LEGACY_RESOURCE_SUBSCRIPTIONS].settle.complete();
		assert.deepStrictEqual([resultOf(await late), [...upstream.open]], [{}, ['test://churn/one-more']], 'the slots are free once the server answered');
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

	test('containsRequest tells request POSTs from notification and response POSTs', () => {
		assert.strictEqual(containsRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), true);
		assert.strictEqual(containsRequest([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'x', method: 'ping' }]), true);
		assert.strictEqual(containsRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), false);
		assert.strictEqual(containsRequest([{ jsonrpc: '2.0', id: 1, result: {} }]), false);
	});
});
