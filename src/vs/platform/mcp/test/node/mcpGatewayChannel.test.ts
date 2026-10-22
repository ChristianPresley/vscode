/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ChannelClient, ChannelServer, Client, IChannel, IMessagePassingProtocol, IPCServer, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLoggerService } from '../../../log/common/log.js';
import { IMcpGatewayCreateArgs, IMcpGatewayCreateOptions, IMcpGatewayDto, IMcpGatewayInfo, IMcpGatewayInvokeContext, IMcpGatewayProgress, IMcpGatewayServerCapabilities, IMcpGatewayServerDescriptor, IMcpGatewayServerInfo, IMcpGatewayService, IMcpGatewayToolInvoker, McpGatewayToolBrokerChannelName } from '../../common/mcpGateway.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { McpSkills } from '../../common/modelContextProtocolSkills.js';
import { McpGatewayChannel } from '../../node/mcpGatewayChannel.js';

suite('McpGatewayChannel', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	const serverA: IMcpGatewayServerDescriptor = { id: 'serverA', label: 'Server A' };
	const gatewaySession = 'vscode-chat-session://local/gateway';
	const callSession = 'vscode-chat-session://local/call';

	interface IFixture {
		readonly ipcServer: TestIPCServer;
		readonly gatewayService: TestGatewayService;
		readonly channel: McpGatewayChannel<string>;
	}

	function createFixture(): IFixture {
		const ipcServer = new TestIPCServer();
		const gatewayService = ds.add(new TestGatewayService());
		const channel = ds.add(new McpGatewayChannel<string>(ipcServer.asIPCServer(), gatewayService, ds.add(new NullLoggerService())));
		// Disposed after the channel, as in the processes that host it.
		ds.add(ipcServer);
		return { ipcServer, gatewayService, channel };
	}

	function connect(fixture: IFixture, ctx: string, servers: readonly IMcpGatewayServerDescriptor[] = [serverA]): TestBroker {
		const broker = ds.add(new TestBroker(servers));
		fixture.ipcServer.connect(ctx, broker);
		return broker;
	}

	async function createGateway(fixture: IFixture, ctx: string, chatSessionResource?: string): Promise<IMcpGatewayToolInvoker> {
		const before = fixture.gatewayService.invokers.length;
		await fixture.channel.call<IMcpGatewayDto>(ctx, 'createGateway', { chatSessionResource });
		assert.strictEqual(fixture.gatewayService.invokers.length, before + 1);
		return fixture.gatewayService.invokers[before];
	}

	test('creates the gateway on top of the calling client\'s broker', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');

		const dto = await fixture.channel.call<IMcpGatewayDto>('client1', 'createGateway', { chatSessionResource: gatewaySession });
		assert.deepStrictEqual(dto, { gatewayId: 'gateway-1', servers: fixture.gatewayService.servers });

		const invoker = fixture.gatewayService.invokers[0];
		assert.deepStrictEqual(invoker.listServers(), [serverA]);
		assert.deepStrictEqual(broker.calls.map(c => c.command), ['listServers']);
	});

	test('asks the gateway service for gRPC only when the client sent grpc: true', async () => {
		const fixture = createFixture();
		connect(fixture, 'client1');
		const variants: (IMcpGatewayCreateArgs | Record<string, unknown> | undefined)[] = [
			undefined,
			{},
			{ chatSessionResource: gatewaySession },
			{ grpc: false },
			{ grpc: 'true' },
			{ grpc: 1 },
			{ grpc: true },
			{ chatSessionResource: gatewaySession, grpc: true },
		];
		for (const args of variants) {
			await fixture.channel.call<IMcpGatewayDto>('client1', 'createGateway', args);
		}
		assert.deepStrictEqual(fixture.gatewayService.options, [undefined, undefined, undefined, undefined, undefined, undefined, { grpc: true }, { grpc: true }]);
	});

	test('forwards each command with its arguments and returns the broker\'s answer', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1', gatewaySession);

		const capabilities: IMcpGatewayServerCapabilities = { tools: { listChanged: true }, prompts: { listChanged: false }, completions: true, logging: false };
		const tool: MCPLegacy.Tool = { name: 'echo', inputSchema: { type: 'object' } };
		const resource: MCPLegacy.Resource = { uri: 'file:///a.txt', name: 'a.txt' };
		const template: MCPLegacy.ResourceTemplate = { uriTemplate: 'file:///{path}', name: 'files' };
		const prompt: MCPLegacy.Prompt = { name: 'summarize' };
		const promptResult: MCPLegacy.GetPromptResult = { messages: [{ role: 'user', content: { type: 'text', text: 'Summarize MCP' } }] };
		const completeResult: MCPLegacy.CompleteResult = { completion: { values: ['MCP'] } };
		const readResult: MCPLegacy.ReadResourceResult = { contents: [{ uri: 'file:///a.txt', text: 'hello' }] };
		const callResult: MCPLegacy.CallToolResult = { content: [{ type: 'text', text: 'echoed' }] };
		broker.answer('getServerCapabilities', capabilities);
		broker.answer('listToolsForServer', [tool]);
		broker.answer('listResourcesForServer', [resource]);
		broker.answer('listResourceTemplatesForServer', [template]);
		broker.answer('listPromptsForServer', [prompt]);
		broker.answer('getPromptForServer', promptResult);
		broker.answer('completeForServer', completeResult);
		broker.answer('readResourceForServer', readResult);
		broker.answer('callToolForServer', callResult);

		assert.deepStrictEqual(await invoker.getServerCapabilities!('serverA'), capabilities);
		assert.deepStrictEqual(await invoker.listToolsForServer('serverA'), [tool]);
		assert.deepStrictEqual(await invoker.listResourcesForServer('serverA'), [resource]);
		assert.deepStrictEqual(await invoker.listResourceTemplatesForServer('serverA'), [template]);
		assert.deepStrictEqual(await invoker.listPromptsForServer!('serverA'), [prompt]);
		assert.deepStrictEqual(await invoker.getPromptForServer!('serverA', 'summarize', { topic: 'MCP' }), promptResult);
		assert.deepStrictEqual(await invoker.completeForServer!('serverA', completeParams), completeResult);
		assert.deepStrictEqual(await invoker.readResourceForServer('serverA', 'file:///a.txt'), readResult);
		assert.deepStrictEqual(await invoker.callToolForServer('serverA', 'echo', { text: 'hi' }), callResult);

		assert.deepStrictEqual(broker.calls.slice(1).map(c => [c.command, c.arg]), [
			['getServerCapabilities', { serverId: 'serverA' }],
			['listToolsForServer', { serverId: 'serverA' }],
			['listResourcesForServer', { serverId: 'serverA' }],
			['listResourceTemplatesForServer', { serverId: 'serverA' }],
			['listPromptsForServer', { serverId: 'serverA' }],
			['getPromptForServer', { serverId: 'serverA', name: 'summarize', args: { topic: 'MCP' }, chatSessionResource: gatewaySession }],
			['completeForServer', { serverId: 'serverA', params: completeParams }],
			['readResourceForServer', { serverId: 'serverA', uri: 'file:///a.txt' }],
			// No call id: nobody asked for the call's notifications.
			['callToolForServer', { serverId: 'serverA', name: 'echo', args: { text: 'hi' }, chatSessionResource: gatewaySession }],
		]);
	});

	test('forwards the Skills extension commands; an unknown skill or directory stays undefined', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1');
		const skill: McpSkills.Skill = { uri: 'skill://git/SKILL.md', frontmatter: { name: 'git', description: 'Git conventions' }, resources: McpSkills.DYNAMIC };
		const children: MCPLegacy.Resource[] = [{ uri: 'skill://git/SKILL.md', name: 'git', mimeType: 'text/markdown' }];
		broker.answer('listSkillsForServer', [skill]);
		broker.answer('getSkillForServer', undefined);
		broker.answer('readDirectoryForServer', children);

		assert.deepStrictEqual(await invoker.listSkillsForServer!('serverA'), [skill]);
		assert.strictEqual(await invoker.getSkillForServer!('serverA', 'skill://nope/SKILL.md'), undefined);
		assert.deepStrictEqual(await invoker.readDirectoryForServer!('serverA', 'skill://git'), children);
		assert.deepStrictEqual(broker.calls.slice(1).map(c => [c.command, c.arg]), [
			['listSkillsForServer', { serverId: 'serverA' }],
			['getSkillForServer', { serverId: 'serverA', uri: 'skill://nope/SKILL.md' }],
			['readDirectoryForServer', { serverId: 'serverA', uri: 'skill://git' }],
		]);
	});

	test('a call\'s chat session takes precedence over the gateway\'s', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const withSession = await createGateway(fixture, 'client1', gatewaySession);
		const withoutSession = await createGateway(fixture, 'client1');

		await withSession.callToolForServer('serverA', 'echo', {}, createContext({ chatSessionResource: callSession }));
		await withSession.getPromptForServer!('serverA', 'summarize', undefined, createContext({ chatSessionResource: callSession }));
		await withoutSession.callToolForServer('serverA', 'echo', {}, createContext());
		await withoutSession.getPromptForServer!('serverA', 'summarize', undefined);

		assert.deepStrictEqual(broker.calls.filter(c => c.command !== 'listServers').map(c => c.arg), [
			{ serverId: 'serverA', name: 'echo', args: {}, chatSessionResource: callSession },
			{ serverId: 'serverA', name: 'summarize', chatSessionResource: callSession },
			{ serverId: 'serverA', name: 'echo', args: {} },
			{ serverId: 'serverA', name: 'summarize' },
		]);
	});

	test('routes progress and logs of a tool call to its context by call id', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1');

		broker.answers.set('callToolForServer', async arg => {
			const { callId } = arg as { callId: string };
			broker.fire('onToolProgress', { callId, progress: 1, total: 2, message: 'half' });
			broker.fire('onToolProgress', { callId: 'another-call', progress: 9, total: 10, message: 'other' });
			broker.fire('onToolLog', { callId, level: 'info', data: { step: 1 }, logger: 'server' });
			broker.fire('onToolLog', { callId: 'another-call', level: 'error', data: 'other' });
			return { content: [] };
		});

		const progress: IMcpGatewayProgress[] = [];
		const logs: [MCP.LoggingLevel, unknown, string | undefined][] = [];
		await invoker.callToolForServer('serverA', 'echo', {}, createContext({
			onProgress: p => progress.push(p),
			onLog: (level, data, logger) => logs.push([level, data, logger]),
		}));

		assert.deepStrictEqual(progress, [{ progress: 1, total: 2, message: 'half' }]);
		assert.deepStrictEqual(logs, [['info', { step: 1 }, 'server']]);

		// The broker got a call id, and the id is no longer routed once the call finished.
		const { callId } = broker.callsOf('callToolForServer')[0].arg as { callId: string };
		assert.strictEqual(typeof callId, 'string');
		broker.fire('onToolProgress', { callId, progress: 2, total: 2, message: 'late' });
		broker.fire('onToolLog', { callId, level: 'info', data: 'late' });
		assert.strictEqual(progress.length, 1);
		assert.strictEqual(logs.length, 1);
	});

	test('keeps concurrent tool calls apart', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1');

		const pending = new Map<string, { callId: string; release: () => void }>();
		broker.answers.set('callToolForServer', arg => new Promise(resolve => {
			const { name, callId } = arg as { name: string; callId: string };
			pending.set(name, { callId, release: () => resolve({ content: [{ type: 'text', text: name }] }) });
		}));

		const progressA: IMcpGatewayProgress[] = [];
		const logsB: unknown[] = [];
		const first = invoker.callToolForServer('serverA', 'a', {}, createContext({ onProgress: p => progressA.push(p) }));
		const second = invoker.callToolForServer('serverA', 'b', {}, createContext({ onLog: (_level, data) => logsB.push(data) }));
		await broker.whenCalled('callToolForServer', 2);

		const a = pending.get('a')!;
		const b = pending.get('b')!;
		assert.notStrictEqual(a.callId, b.callId);
		broker.fire('onToolProgress', { callId: b.callId, progress: 1 });
		broker.fire('onToolProgress', { callId: a.callId, progress: 2, total: 3, message: 'a' });
		broker.fire('onToolLog', { callId: a.callId, level: 'info', data: 'for a' });
		broker.fire('onToolLog', { callId: b.callId, level: 'info', data: 'for b' });

		assert.deepStrictEqual(progressA, [{ progress: 2, total: 3, message: 'a' }]);
		assert.deepStrictEqual(logsB, ['for b']);

		a.release();
		b.release();
		assert.deepStrictEqual((await Promise.all([first, second])).map(r => ((r as MCPLegacy.CallToolResult).content[0] as MCPLegacy.TextContent).text), ['a', 'b']);
	});

	test('passes the context\'s token across IPC', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1');

		const untilCancelled = (_arg: unknown, token: CancellationToken) => new Promise<never>((_resolve, reject) => {
			const listener = token.onCancellationRequested(() => {
				listener.dispose();
				reject(new CancellationError());
			});
		});
		broker.answers.set('callToolForServer', untilCancelled);
		broker.answers.set('readResourceForServer', untilCancelled);
		broker.answers.set('getPromptForServer', untilCancelled);

		const cts = ds.add(new CancellationTokenSource());
		const context = createContext({ token: cts.token, onProgress: () => { } });
		const calls = [
			invoker.callToolForServer('serverA', 'hang', {}, context),
			invoker.readResourceForServer('serverA', 'file:///a.txt', context),
			invoker.getPromptForServer!('serverA', 'summarize', undefined, context),
		];
		await broker.whenCalled('callToolForServer');
		await broker.whenCalled('readResourceForServer');
		await broker.whenCalled('getPromptForServer');

		const brokerTokens = broker.calls.filter(c => c.command !== 'listServers').map(c => c.token);
		assert.deepStrictEqual(brokerTokens.map(t => t.isCancellationRequested), [false, false, false]);

		cts.cancel();
		assert.deepStrictEqual(brokerTokens.map(t => t.isCancellationRequested), [true, true, true]);
		for (const call of calls) {
			await assert.rejects(call, (error: Error) => isCancellationError(error));
		}
	});

	test('forwards the broker\'s events', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1');

		const seen: string[] = [];
		const updates: { readonly serverId: string; readonly uri: string }[] = [];
		const servers: (readonly IMcpGatewayServerDescriptor[])[] = [];
		ds.add(invoker.onDidChangeTools(() => seen.push('tools')));
		ds.add(invoker.onDidChangeResources(() => seen.push('resources')));
		ds.add(invoker.onDidChangePrompts!(() => seen.push('prompts')));
		ds.add(invoker.onDidUpdateResource!(e => updates.push(e)));
		ds.add(invoker.onDidChangeServers(e => servers.push(e)));

		broker.fire('onDidChangePrompts');
		broker.fire('onDidChangeTools');
		broker.fire('onDidChangeResources');
		broker.fire('onDidUpdateResource', { serverId: 'serverA', uri: 'file:///a.txt' });
		const serverB: IMcpGatewayServerDescriptor = { id: 'serverB', label: 'Server B' };
		broker.fire('onDidChangeServers', [serverB]);

		assert.deepStrictEqual(seen, ['prompts', 'tools', 'resources']);
		assert.deepStrictEqual(updates, [{ serverId: 'serverA', uri: 'file:///a.txt' }]);
		assert.deepStrictEqual(servers, [[serverB]]);
		assert.deepStrictEqual(invoker.listServers(), [serverB]);
	});

	test('a resource subscription unsubscribes by id when disposed', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1');

		broker.answer('subscribeResourceForServer', 'subscription-1');
		const subscription = await invoker.subscribeResourceForServer!('serverA', 'file:///a.txt');
		assert.deepStrictEqual(broker.callsOf('subscribeResourceForServer').map(c => c.arg), [{ serverId: 'serverA', uri: 'file:///a.txt' }]);
		assert.deepStrictEqual(broker.callsOf('unsubscribeResourceForServer'), []);

		subscription.dispose();
		await broker.whenCalled('unsubscribeResourceForServer');
		assert.deepStrictEqual(broker.callsOf('unsubscribeResourceForServer').map(c => c.arg), [{ subscriptionId: 'subscription-1' }]);
	});

	test('does not unsubscribe through a client that disconnected', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		const invoker = await createGateway(fixture, 'client1');
		broker.answer('subscribeResourceForServer', 'subscription-1');
		const subscription = await invoker.subscribeResourceForServer!('serverA', 'file:///a.txt');

		fixture.ipcServer.disconnect('client1');
		assert.deepStrictEqual(fixture.gatewayService.disposedForClients, ['client1']);
		assert.ok(!broker.hasListeners('onToolProgress'));

		// A call would wait for the client to come back and reach whichever broker it brings.
		subscription.dispose();
		const reconnected = connect(fixture, 'client1');
		await timeout(0);
		assert.deepStrictEqual(reconnected.callsOf('unsubscribeResourceForServer'), []);
		assert.deepStrictEqual(broker.callsOf('unsubscribeResourceForServer'), []);
	});

	test('routes a gateway to the client that created it', async () => {
		const fixture = createFixture();
		const serverB: IMcpGatewayServerDescriptor = { id: 'serverB', label: 'Server B' };
		const first = connect(fixture, 'client1', [serverA]);
		const second = connect(fixture, 'client2', [serverB]);
		const invoker = await createGateway(fixture, 'client2');

		assert.deepStrictEqual(invoker.listServers(), [serverB]);
		await invoker.listToolsForServer('serverB');
		assert.deepStrictEqual(first.calls, []);
		assert.deepStrictEqual(second.calls.map(c => c.command), ['listServers', 'listToolsForServer']);

		let toolChanges = 0;
		ds.add(invoker.onDidChangeTools(() => toolChanges++));
		first.fire('onDidChangeTools');
		assert.strictEqual(toolChanges, 0);
		second.fire('onDidChangeTools');
		assert.strictEqual(toolChanges, 1);
	});

	test('releases the broker listeners with the gateway', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		await createGateway(fixture, 'client1');
		assert.ok(broker.hasListeners('onToolProgress'));
		assert.ok(broker.hasListeners('onToolLog'));

		await fixture.channel.call('client1', 'disposeGateway', 'gateway-1');
		assert.deepStrictEqual(fixture.gatewayService.disposedGateways, ['gateway-1']);
		assert.ok(!broker.hasListeners('onToolProgress'));
		assert.ok(!broker.hasListeners('onToolLog'));
	});

	test('releases the broker listeners when the gateway cannot be created', async () => {
		const fixture = createFixture();
		const broker = connect(fixture, 'client1');
		fixture.gatewayService.failure = new Error('no port');

		await assert.rejects(fixture.channel.call('client1', 'createGateway', {}), /no port/);
		assert.ok(!broker.hasListeners('onToolProgress'));
		assert.ok(!broker.hasListeners('onToolLog'));
	});

	test('a client that disconnects while its gateway is created leaves no gateway behind', async () => {
		const fixture = createFixture();
		connect(fixture, 'client1');
		const gate = new DeferredPromise<void>();
		fixture.gatewayService.gate = gate.p;

		const created = fixture.channel.call<IMcpGatewayDto>('client1', 'createGateway', { grpc: true });
		await fixture.gatewayService.firstCreateGateway.p;
		fixture.ipcServer.disconnect('client1');
		assert.deepStrictEqual([fixture.gatewayService.disposedForClients, fixture.gatewayService.disposedGateways], [['client1'], []], 'the disconnect cleanup ran before the gateway existed');

		gate.complete();
		await assert.rejects(created, isCancellationError);
		assert.deepStrictEqual(fixture.gatewayService.disposedGateways, ['gateway-1'], 'disposed once created, so its routes do not hold the ports open');

		// A gateway of a client that stays connected is kept.
		connect(fixture, 'client2');
		fixture.gatewayService.gate = undefined;
		await fixture.channel.call<IMcpGatewayDto>('client2', 'createGateway', {});
		assert.deepStrictEqual(fixture.gatewayService.disposedGateways, ['gateway-1']);
	});

	test('rejects unknown commands and events', async () => {
		const fixture = createFixture();
		await assert.rejects(fixture.channel.call('client1', 'noSuchCommand'), /Invalid call: noSuchCommand/);
		assert.throws(() => fixture.channel.listen('client1', 'noSuchEvent'), /Invalid listen: noSuchEvent/);
	});
});

const completeParams: MCPLegacy.CompleteRequest['params'] = {
	ref: { type: 'ref/prompt', name: 'summarize' },
	argument: { name: 'topic', value: 'M' },
};

function createContext(overrides: Partial<IMcpGatewayInvokeContext> = {}): IMcpGatewayInvokeContext {
	return {
		protocolVersion: '2026-07-28',
		clientCapabilities: {},
		token: CancellationToken.None,
		...overrides,
	};
}

/** Delivers messages synchronously, buffering them until the other side listens (as in the base IPC tests). */
class QueueProtocol implements IMessagePassingProtocol {
	private _buffering = true;
	private _buffers: VSBuffer[] = [];

	private readonly _onMessage = new Emitter<VSBuffer>({
		onDidAddFirstListener: () => {
			for (const buffer of this._buffers) {
				this._onMessage.fire(buffer);
			}
			this._buffers = [];
			this._buffering = false;
		},
		onDidRemoveLastListener: () => {
			this._buffering = true;
		},
	});
	readonly onMessage = this._onMessage.event;

	other: QueueProtocol | undefined;

	send(buffer: VSBuffer): void {
		this.other?._receive(buffer);
	}

	private _receive(buffer: VSBuffer): void {
		if (this._buffering) {
			this._buffers.push(buffer);
		} else {
			this._onMessage.fire(buffer);
		}
	}
}

/** A client connection: the server side's `ChannelClient` talks to the client's `ChannelServer`, which serves the broker. */
class TestConnection implements Client<string> {
	readonly channelClient: ChannelClient;
	private readonly _channelServer: ChannelServer<string>;

	constructor(readonly ctx: string, broker: IServerChannel<string>) {
		const serverSide = new QueueProtocol();
		const clientSide = new QueueProtocol();
		serverSide.other = clientSide;
		clientSide.other = serverSide;
		this.channelClient = new ChannelClient(serverSide);
		this._channelServer = new ChannelServer(clientSide, ctx);
		this._channelServer.registerChannel(McpGatewayToolBrokerChannelName, broker);
	}

	dispose(): void {
		this.channelClient.dispose();
		this._channelServer.dispose();
	}
}

/**
 * The parts of `IPCServer` the gateway channel uses. Each connection is real
 * IPC over an in-memory protocol pair, so arguments, results and events are
 * serialized and cancellation crosses the wire; only the routing to a client
 * is done here: the real server's routed events never dispose the
 * `EventMultiplexer.add` disposables of a connection when their last listener
 * goes away, which the leak check reports.
 */
class TestIPCServer extends Disposable {
	private readonly _connections = new Map<string, TestConnection>();
	private readonly _onDidAddConnection = this._register(new Emitter<TestConnection>());
	private readonly _onDidRemoveConnection = this._register(new Emitter<Client<string>>());
	readonly onDidRemoveConnection = this._onDidRemoveConnection.event;
	/** Calls waiting for a matching client to connect, as the real server's do. */
	private readonly _waitingCalls = this._register(new DisposableStore());

	get connections(): Client<string>[] {
		return [...this._connections.values()];
	}

	asIPCServer(): IPCServer<string> {
		return this as unknown as IPCServer<string>;
	}

	connect(ctx: string, broker: IServerChannel<string>): void {
		const connection = new TestConnection(ctx, broker);
		this._connections.set(ctx, connection);
		this._onDidAddConnection.fire(connection);
	}

	disconnect(ctx: string): void {
		const connection = this._connections.get(ctx);
		if (connection) {
			this._connections.delete(ctx);
			connection.dispose();
			this._onDidRemoveConnection.fire(connection);
		}
	}

	getChannel(channelName: string, filter: (client: Client<string>) => boolean): IChannel {
		const find = () => [...this._connections.values()].find(filter);
		const whenConnected = async (): Promise<TestConnection> => find() ?? Event.toPromise(Event.filter(this._onDidAddConnection.event, filter), this._waitingCalls);
		return {
			call<T>(command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T> {
				return whenConnected().then(connection => connection.channelClient.getChannel(channelName).call<T>(command, arg, cancellationToken));
			},
			listen<T>(event: string, arg?: unknown): Event<T> {
				return (listener, thisArgs, disposables) => {
					const connection = find();
					return connection ? connection.channelClient.getChannel(channelName).listen<T>(event, arg)(listener, thisArgs, disposables) : Disposable.None;
				};
			},
		};
	}

	override dispose(): void {
		for (const connection of this._connections.values()) {
			connection.dispose();
		}
		this._connections.clear();
		super.dispose();
	}
}

interface IBrokerCall {
	readonly command: string;
	readonly arg: unknown;
	readonly token: CancellationToken;
}

/** The workbench's tool broker as the gateway channel reaches it: records the calls and fires events on demand. */
class TestBroker extends Disposable implements IServerChannel<string> {
	private readonly _emitters = new Map<string, Emitter<unknown>>();
	private readonly _onDidCall = this._register(new Emitter<IBrokerCall>());

	readonly calls: IBrokerCall[] = [];
	/** Per-command answers; `listServers` answers with the servers, anything else without an answer with `undefined`. */
	readonly answers = new Map<string, (arg: unknown, token: CancellationToken) => Promise<unknown>>();

	constructor(servers: readonly IMcpGatewayServerDescriptor[]) {
		super();
		this.answer('listServers', servers);
	}

	answer(command: string, value: unknown): void {
		this.answers.set(command, async () => value);
	}

	callsOf(command: string): IBrokerCall[] {
		return this.calls.filter(c => c.command === command);
	}

	async whenCalled(command: string, count = 1): Promise<void> {
		if (this.callsOf(command).length < count) {
			await Event.toPromise(Event.filter(this._onDidCall.event, () => this.callsOf(command).length >= count));
		}
	}

	fire(event: string, data?: unknown): void {
		this._emitter(event).fire(data);
	}

	hasListeners(event: string): boolean {
		return this._emitter(event).hasListeners();
	}

	listen<T>(_ctx: string, event: string): Event<T> {
		return this._emitter(event).event as Event<T>;
	}

	call<T>(_ctx: string, command: string, arg?: unknown, token: CancellationToken = CancellationToken.None): Promise<T> {
		const call: IBrokerCall = { command, arg, token };
		this.calls.push(call);
		this._onDidCall.fire(call);
		const answer = this.answers.get(command);
		return (answer ? answer(arg, token) : Promise.resolve(undefined)) as Promise<T>;
	}

	private _emitter(event: string): Emitter<unknown> {
		let emitter = this._emitters.get(event);
		if (!emitter) {
			emitter = this._register(new Emitter<unknown>());
			this._emitters.set(event, emitter);
		}
		return emitter;
	}
}

class TestGatewayService extends Disposable implements IMcpGatewayService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeServers = this._register(new Emitter<readonly IMcpGatewayServerInfo[]>());
	readonly servers: readonly IMcpGatewayServerInfo[] = [{ label: 'Server A', address: URI.parse('http://127.0.0.1:1/gateway/route-a') }];
	readonly invokers: IMcpGatewayToolInvoker[] = [];
	/** The options of each `createGateway`, in order. */
	readonly options: (IMcpGatewayCreateOptions | undefined)[] = [];
	readonly disposedForClients: unknown[] = [];
	readonly disposedGateways: string[] = [];
	failure: Error | undefined;
	/** When set, `createGateway` waits for it once called, as the real one waits for the HTTP start and the gRPC bind. */
	gate: Promise<void> | undefined;
	/** Completes when `createGateway` is first called (before it waits for {@link gate}). */
	readonly firstCreateGateway = new DeferredPromise<void>();

	async createGateway<TContext>(_context: TContext, toolInvoker?: IMcpGatewayToolInvoker, options?: IMcpGatewayCreateOptions): Promise<IMcpGatewayInfo> {
		if (this.failure) {
			throw this.failure;
		}
		assert.ok(toolInvoker);
		this.invokers.push(toolInvoker);
		this.options.push(options);
		if (!this.firstCreateGateway.isSettled) {
			this.firstCreateGateway.complete();
		}
		const gatewayId = `gateway-${this.invokers.length}`;
		await this.gate;
		return { gatewayId, servers: this.servers, onDidChangeServers: this._onDidChangeServers.event };
	}

	disposeGatewaysForClient<TContext>(context: TContext): void {
		this.disposedForClients.push(context);
	}

	async disposeGateway(gatewayId: string): Promise<void> {
		this.disposedGateways.push(gatewayId);
	}
}
