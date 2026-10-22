/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ContributionEnablementState } from '../../../chat/common/enablement.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMcpGatewayServerCapabilities, IMcpGatewayServerDescriptor } from '../../../../../platform/mcp/common/mcpGateway.js';
import { MCP } from '../../../../../platform/mcp/common/modelContextProtocol.js';
import { McpSkills } from '../../../../../platform/mcp/common/modelContextProtocolSkills.js';
import { ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { IMcpGatewayResourceUpdateEvent, IMcpGatewayToolLogEvent, IMcpGatewayToolProgressEvent, McpGatewayToolBrokerChannel } from '../../common/mcpGatewayToolBrokerChannel.js';
import { McpServerRequestHandler } from '../../common/mcpServerRequestHandler.js';
import { IMcpIcons, IMcpServer, IMcpServerConnection, IMcpSkill, IMcpTool, IMcpToolCallContext, McpCapability, McpConnectionState, McpServerCacheState, McpServerDefinition, McpServerTransportType, McpToolVisibility, MpcResponseError } from '../../common/mcpTypes.js';
import { TestMcpService } from './testMcpService.js';

suite('McpGatewayToolBrokerChannel', () => {
	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	test('lists model-visible tools for a specific server', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const serverA = createServer('collectionA', 'serverA', [
			createTool('mcp_serverA_echo', async () => ({ content: [{ type: 'text', text: 'A' }] })),
			createTool('app-only', async () => ({ content: [{ type: 'text', text: 'A2' }] }), McpToolVisibility.App),
		]);
		const serverB = createServer('collectionB', 'serverB', [
			createTool('mcp_serverB_echo', async () => ({ content: [{ type: 'text', text: 'B' }] })),
		]);

		mcpService.servers.set([serverA, serverB], undefined);

		const resultA = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
		assert.deepStrictEqual(resultA.map(t => t.name), ['mcp_serverA_echo']);

		const resultB = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverB' });
		assert.deepStrictEqual(resultB.map(t => t.name), ['mcp_serverB_echo']);

		channel.dispose();
	});

	test('lists tools without the fields VS Code adds to validated tools', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());
		const tool = createTool('mcp_serverA_echo', async () => ({ content: [{ type: 'text', text: 'A' }] }));
		// What McpServer._getValidatedTools stores as the definition of a tool.
		const definition = { ...createToolDefinition('mcp_serverA_echo'), serverToolName: 'echo', _icons: [], visibility: McpToolVisibility.Model, uiResourceUri: undefined };
		mcpService.servers.set([createServer('collectionA', 'serverA', [{ ...tool, definition }])], undefined);

		const tools = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
		assert.deepStrictEqual(tools, [createToolDefinition('mcp_serverA_echo')]);

		channel.dispose();
	});

	test('routes tool calls to specific server', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const invoked: string[] = [];
		const serverA = createServer('collectionA', 'serverA', [
			createTool('mcp_serverA_echo', async args => {
				invoked.push(`A:${String(args.name)}`);
				return { content: [{ type: 'text', text: 'from A' }] };
			}),
		]);
		const serverB = createServer('collectionB', 'serverB', [
			createTool('mcp_serverB_echo', async args => {
				invoked.push(`B:${String(args.name)}`);
				return { content: [{ type: 'text', text: 'from B' }] };
			}),
		]);

		mcpService.servers.set([serverA, serverB], undefined);

		const resultA = await channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', {
			serverId: 'serverA',
			name: 'mcp_serverA_echo',
			args: { name: 'one' },
		});
		const resultB = await channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', {
			serverId: 'serverB',
			name: 'mcp_serverB_echo',
			args: { name: 'two' },
		});

		assert.deepStrictEqual(invoked, ['A:one', 'B:two']);
		assert.strictEqual((resultA.content[0] as MCPLegacy.TextContent).text, 'from A');
		assert.strictEqual((resultB.content[0] as MCPLegacy.TextContent).text, 'from B');

		channel.dispose();
	});

	test('emits onDidChangeTools when tool lists change', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());
		const server = createServer('collectionA', 'serverA', [
			createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] })),
		]);

		mcpService.servers.set([server], undefined);

		let events = 0;
		const disposable = channel.listen<void>(undefined, 'onDidChangeTools')(() => {
			events++;
		});

		server.toolsValue.set([
			createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] })),
			createTool('echo2', async () => ({ content: [{ type: 'text', text: 'A2' }] })),
		], undefined);

		assert.ok(events >= 1);

		disposable.dispose();
		channel.dispose();
	});

	test('does not start server when cache state is live', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const server = createServer(
			'collectionA',
			'serverA',
			[createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] }))],
			McpServerCacheState.Live,
		);

		mcpService.servers.set([server], undefined);
		await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });

		assert.strictEqual(server.startCalls, 0);
		channel.dispose();
	});

	test('starts server when cache state is unknown', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const server = createServer(
			'collectionA',
			'serverA',
			[createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] }))],
			McpServerCacheState.Unknown,
		);

		mcpService.servers.set([server], undefined);
		const tools = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });

		// Server started during the grace period; tools are now available.
		assert.strictEqual(server.startCalls, 1);
		assert.deepStrictEqual(tools.map(t => t.name), ['echo']);
		channel.dispose();
	});

	test('starts server and waits within grace period when cache state is outdated', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const server = createServer(
			'collectionA',
			'serverA',
			[createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] }))],
			McpServerCacheState.Outdated,
		);

		mcpService.servers.set([server], undefined);
		const tools = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });

		// Outdated server gets the same grace period as Unknown — started and tools returned.
		assert.strictEqual(server.startCalls, 1);
		assert.deepStrictEqual(tools.map(t => t.name), ['echo']);
		channel.dispose();
	});

	test('returns empty tools and does not re-wait if server does not start within grace period', () => {
		return runWithFakedTimers({ useFakeTimers: true }, async () => {
			const mcpService = new TestMcpService();
			const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService(), 100);

			const server = createNeverStartingServer(
				'collectionA',
				'serverA',
				[createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] }))],
			);

			mcpService.servers.set([server], undefined);

			// First call: waits up to the grace period, server never starts → empty result.
			const tools = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(tools, []);

			// Second call: grace-period promise already resolved; returns immediately without re-waiting.
			const tools2 = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(tools2, []);

			channel.dispose();
		});
	});

	test('invalidates stale grace entry when cacheState regresses to Unknown after timeout', () => {
		return runWithFakedTimers({ useFakeTimers: true }, async () => {
			const mcpService = new TestMcpService();
			const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService(), 100);

			const server = createNeverStartingServer(
				'collectionA',
				'serverA',
				[createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] }))],
			);

			mcpService.servers.set([server], undefined);

			// First call: grace period elapses, server never starts → empty.
			const tools1 = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(tools1, []);
			assert.strictEqual(server.startCalls, 1);

			// Simulate a cache reset: server goes back to Unknown.
			server.cacheStateValue.set(McpServerCacheState.Unknown, undefined);

			// Make the server succeed this time.
			server.startBehavior = 'succeed';

			// Second call: stale grace entry should be discarded, a new grace race starts,
			// and the server successfully starts → tools returned.
			const tools2 = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(tools2.map(t => t.name), ['echo']);
			assert.strictEqual(server.startCalls, 2);

			channel.dispose();
		});
	});

	test('does not invalidate grace entry when cacheState is not Unknown/Outdated', () => {
		return runWithFakedTimers({ useFakeTimers: true }, async () => {
			const mcpService = new TestMcpService();
			const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService(), 100);

			const server = createServer(
				'collectionA',
				'serverA',
				[createTool('echo', async () => ({ content: [{ type: 'text', text: 'A' }] }))],
				McpServerCacheState.Unknown,
			);

			mcpService.servers.set([server], undefined);

			// First call: server starts successfully during grace period.
			const tools1 = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(tools1.map(t => t.name), ['echo']);
			assert.strictEqual(server.startCalls, 1);

			// Second call: cacheState is now Live (server started), grace entry should NOT
			// be invalidated, so no additional start call is made.
			const tools2 = await channel.call<readonly MCPLegacy.Tool[]>(undefined, 'listToolsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(tools2.map(t => t.name), ['echo']);
			assert.strictEqual(server.startCalls, 1);

			channel.dispose();
		});
	});

	test('listServers returns all servers regardless of cache state', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const liveServer = createServer('collectionA', 'serverA', [], McpServerCacheState.Live);
		const unknownServer = createServer('collectionB', 'serverB', [], McpServerCacheState.Unknown);

		mcpService.servers.set([liveServer, unknownServer], undefined);

		const servers = await channel.call<readonly IMcpGatewayServerDescriptor[]>(undefined, 'listServers');
		assert.deepStrictEqual(servers, [
			{ id: 'serverA', label: 'serverA' },
			{ id: 'serverB', label: 'serverB' },
		]);

		channel.dispose();
	});

	test('forwards chatSessionResource as tool call context', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const receivedContexts: (IMcpToolCallContext | undefined)[] = [];
		const server = createServer('collectionA', 'serverA', [
			createToolWithContextCapture('echo', receivedContexts, async () => ({ content: [{ type: 'text', text: 'ok' }] })),
		]);

		mcpService.servers.set([server], undefined);

		const sessionUri = 'vscode-chat-session://test/session-123';
		await channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', {
			serverId: 'serverA',
			name: 'echo',
			args: { input: 'hello' },
			chatSessionResource: sessionUri,
		});

		assert.strictEqual(receivedContexts.length, 1);
		assert.ok(receivedContexts[0]);
		assert.strictEqual(receivedContexts[0]!.chatSessionResource!.toString(), URI.parse(sessionUri).toString());

		channel.dispose();
	});

	test('passes undefined context when chatSessionResource is omitted', async () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

		const receivedContexts: (IMcpToolCallContext | undefined)[] = [];
		const server = createServer('collectionA', 'serverA', [
			createToolWithContextCapture('echo', receivedContexts, async () => ({ content: [{ type: 'text', text: 'ok' }] })),
		]);

		mcpService.servers.set([server], undefined);

		await channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', {
			serverId: 'serverA',
			name: 'echo',
			args: { input: 'hello' },
		});

		assert.strictEqual(receivedContexts.length, 1);
		assert.strictEqual(receivedContexts[0], undefined);

		channel.dispose();
	});

	test('emits onDidChangeServers with descriptors when servers change', () => {
		const mcpService = new TestMcpService();
		const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());
		const serverA = createServer('collectionA', 'serverA', []);

		mcpService.servers.set([serverA], undefined);

		const received: (readonly IMcpGatewayServerDescriptor[])[] = [];
		const disposable = channel.listen<readonly IMcpGatewayServerDescriptor[]>(undefined, 'onDidChangeServers')(e => {
			received.push(e);
		});

		// Add a second server
		const serverB = createServer('collectionB', 'serverB', []);
		mcpService.servers.set([serverA, serverB], undefined);

		assert.strictEqual(received.length, 1);
		assert.deepStrictEqual(received[0], [
			{ id: 'serverA', label: 'serverA' },
			{ id: 'serverB', label: 'serverB' },
		]);

		// Remove the first server
		mcpService.servers.set([serverB], undefined);

		assert.strictEqual(received.length, 2);
		assert.deepStrictEqual(received[1], [
			{ id: 'serverB', label: 'serverB' },
		]);

		disposable.dispose();
		channel.dispose();
	});

	test('cancels the tool call when the IPC token is cancelled', async () => {
		const mcpService = new TestMcpService();
		const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

		let observedToken: CancellationToken | undefined;
		const server = createServer('collectionA', 'serverA', [
			createTool('hang', (_args, token) => new Promise<MCPLegacy.CallToolResult>((_resolve, reject) => {
				observedToken = token;
				ds.add(token.onCancellationRequested(() => reject(new CancellationError())));
			})),
		]);
		mcpService.servers.set([server], undefined);

		const cts = ds.add(new CancellationTokenSource());
		const call = channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', { serverId: 'serverA', name: 'hang', args: {} }, cts.token);
		assert.strictEqual(observedToken, cts.token);

		cts.cancel();
		await assert.rejects(call, err => isCancellationError(err));
	});

	test('rejects calls for unknown servers and tools', async () => {
		const mcpService = new TestMcpService();
		const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));
		const handler = ds.add(new StubRequestHandler());
		mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler })], undefined);

		await assert.rejects(channel.call(undefined, 'callToolForServer', { serverId: 'nope', name: 'x', args: {} }), /Unknown server: nope/);
		await assert.rejects(channel.call(undefined, 'callToolForServer', { serverId: 'serverA', name: 'x', args: {} }), /Unknown tool 'x' on server 'serverA'/);
		await assert.rejects(channel.call(undefined, 'getPromptForServer', { serverId: 'nope', name: 'p' }), /Unknown server: nope/);
		await assert.rejects(channel.call(undefined, 'completeForServer', { serverId: 'nope', params: completeParams }), /Unknown server: nope/);
		await assert.rejects(channel.call(undefined, 'subscribeResourceForServer', { serverId: 'nope', uri: 'file:///a' }), /Unknown server: nope/);
		await assert.rejects(channel.call(undefined, 'noSuchCommand'), /Invalid call: noSuchCommand/);
		assert.throws(() => channel.listen(undefined, 'noSuchEvent'), /Invalid listen: noSuchEvent/);
	});

	suite('capabilities', () => {
		test('maps the capability bits to the gateway capabilities', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const full = createServer('collectionA', 'serverA', [], McpServerCacheState.Live, {
				capabilities: McpCapability.Tools | McpCapability.ToolsListChanged | McpCapability.Prompts | McpCapability.Resources | McpCapability.ResourcesSubscribe | McpCapability.Completions,
			});
			const minimal = createServer('collectionB', 'serverB', [], McpServerCacheState.Live, {
				capabilities: McpCapability.Logging | McpCapability.PromptsListChanged,
			});
			mcpService.servers.set([full, minimal], undefined);

			const fullCapabilities = await channel.call<IMcpGatewayServerCapabilities | undefined>(undefined, 'getServerCapabilities', { serverId: 'serverA' });
			assert.deepStrictEqual(fullCapabilities, {
				completions: true,
				logging: false,
				tools: { listChanged: true },
				prompts: { listChanged: false },
				resources: { subscribe: true, listChanged: false },
			});

			// The listChanged bit alone does not advertise prompts.
			const minimalCapabilities = await channel.call<IMcpGatewayServerCapabilities | undefined>(undefined, 'getServerCapabilities', { serverId: 'serverB' });
			assert.deepStrictEqual(minimalCapabilities, { completions: false, logging: true });

			const unknownServer = await channel.call<IMcpGatewayServerCapabilities | undefined>(undefined, 'getServerCapabilities', { serverId: 'nope' });
			assert.strictEqual(unknownServer, undefined);
		});

		test('starts a server whose capabilities are not cached yet', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const server = createServer('collectionA', 'serverA', [], McpServerCacheState.Unknown, {
				capabilitiesOnStart: McpCapability.Tools | McpCapability.Resources,
			});
			mcpService.servers.set([server], undefined);

			const capabilities = await channel.call<IMcpGatewayServerCapabilities | undefined>(undefined, 'getServerCapabilities', { serverId: 'serverA' });
			assert.strictEqual(server.startCalls, 1);
			assert.deepStrictEqual(capabilities, {
				completions: false,
				logging: false,
				tools: { listChanged: false },
				resources: { subscribe: false, listChanged: false },
			});
		});

		test('returns undefined when the capabilities stay unknown', () => {
			return runWithFakedTimers({ useFakeTimers: true }, async () => {
				const mcpService = new TestMcpService();
				const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService(), 100));

				const server = createNeverStartingServer('collectionA', 'serverA', []);
				mcpService.servers.set([server], undefined);

				const capabilities = await channel.call<IMcpGatewayServerCapabilities | undefined>(undefined, 'getServerCapabilities', { serverId: 'serverA' });
				assert.strictEqual(capabilities, undefined);
			});
		});
	});

	suite('prompts', () => {
		test('lists prompts from servers that advertise them', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handlerA = ds.add(new StubRequestHandler());
			handlerA.prompts = [{ name: 'summarize', description: 'Summarizes' }, { name: 'review' }];
			const handlerB = ds.add(new StubRequestHandler());
			handlerB.prompts = [{ name: 'hidden' }];

			const withPrompts = createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler: handlerA, capabilities: McpCapability.Prompts });
			const withoutPrompts = createServer('collectionB', 'serverB', [], McpServerCacheState.Live, { handler: handlerB, capabilities: McpCapability.Tools });
			mcpService.servers.set([withPrompts, withoutPrompts], undefined);

			const promptsA = await channel.call<readonly MCPLegacy.Prompt[]>(undefined, 'listPromptsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(promptsA.map(p => p.name), ['summarize', 'review']);

			const promptsB = await channel.call<readonly MCPLegacy.Prompt[]>(undefined, 'listPromptsForServer', { serverId: 'serverB' });
			assert.deepStrictEqual(promptsB, []);
			assert.strictEqual(handlerB.calls.length, 0, 'a server without the capability is not asked');

			const unknown = await channel.call<readonly MCPLegacy.Prompt[]>(undefined, 'listPromptsForServer', { serverId: 'nope' });
			assert.deepStrictEqual(unknown, []);
		});

		test('returns no prompts when listing fails', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			handler.failure = new Error('boom');
			mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler, capabilities: McpCapability.Prompts })], undefined);

			const prompts = await channel.call<readonly MCPLegacy.Prompt[]>(undefined, 'listPromptsForServer', { serverId: 'serverA' });
			assert.deepStrictEqual(prompts, []);
		});

		test('gets a prompt with its arguments and chat session context', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			handler.promptResult = { description: 'A prompt', messages: [{ role: 'user', content: { type: 'text', text: 'Summarize {{topic}}' } }] };
			mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler, capabilities: McpCapability.Prompts })], undefined);

			const sessionUri = 'vscode-chat-session://test/session-1';
			const cts = ds.add(new CancellationTokenSource());
			const result = await channel.call<MCPLegacy.GetPromptResult>(undefined, 'getPromptForServer', {
				serverId: 'serverA',
				name: 'summarize',
				args: { topic: 'MCP' },
				chatSessionResource: sessionUri,
			}, cts.token);

			assert.deepStrictEqual(result, handler.promptResult);
			assert.strictEqual(handler.calls.length, 1);
			const call = handler.calls[0];
			assert.strictEqual(call.method, 'getPrompt');
			assert.deepStrictEqual(call.params, { name: 'summarize', arguments: { topic: 'MCP' } });
			assert.strictEqual(call.token, cts.token);
			assert.strictEqual(call.context?.chatSessionResource?.toString(), URI.parse(sessionUri).toString());

			// Without a chat session there is no context.
			await channel.call<MCPLegacy.GetPromptResult>(undefined, 'getPromptForServer', { serverId: 'serverA', name: 'summarize' });
			assert.deepStrictEqual(handler.calls[1].params, { name: 'summarize', arguments: undefined });
			assert.strictEqual(handler.calls[1].context, undefined);
		});

		test('emits onDidChangePrompts when a prompt list changes', () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));
			const server = createServer('collectionA', 'serverA', []);
			mcpService.servers.set([server], undefined);

			let events = 0;
			ds.add(channel.listen<void>(undefined, 'onDidChangePrompts')(() => events++));

			server.promptsValue.set([], undefined);
			assert.strictEqual(events, 1);
		});
	});

	test('completes through the server', async () => {
		const mcpService = new TestMcpService();
		const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

		const handler = ds.add(new StubRequestHandler());
		handler.completeResult = { completion: { values: ['MCP', 'MCP Apps'], hasMore: false } };
		mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler, capabilities: McpCapability.Completions })], undefined);

		const cts = ds.add(new CancellationTokenSource());
		const result = await channel.call<MCPLegacy.CompleteResult>(undefined, 'completeForServer', { serverId: 'serverA', params: completeParams }, cts.token);

		assert.deepStrictEqual(result, handler.completeResult);
		assert.strictEqual(handler.calls.length, 1);
		assert.strictEqual(handler.calls[0].method, 'complete');
		assert.deepStrictEqual(handler.calls[0].params, completeParams);
		assert.strictEqual(handler.calls[0].token, cts.token);
	});

	suite('Skills extension (SEP-2640)', () => {
		const ENTRY: McpSkills.Skill = { uri: 'skill://git/SKILL.md', frontmatter: { name: 'git', description: 'Git' }, resources: McpSkills.DYNAMIC };

		test('getServerCapabilities reports the extension and its directoryRead setting from the capability bits of the server', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));
			mcpService.servers.set([
				createServer('c', 'skills', [], McpServerCacheState.Live, { capabilities: McpCapability.Resources | McpCapability.Skills }),
				createServer('c', 'directories', [], McpServerCacheState.Live, { capabilities: McpCapability.Resources | McpCapability.Skills | McpCapability.SkillsDirectoryRead }),
				createServer('c', 'plain', [], McpServerCacheState.Live, { capabilities: McpCapability.Resources }),
			], undefined);
			const skillsOf = async (serverId: string) => (await channel.call<IMcpGatewayServerCapabilities>(undefined, 'getServerCapabilities', { serverId })).skills;
			assert.deepStrictEqual(await skillsOf('skills'), { directoryRead: false });
			assert.deepStrictEqual(await skillsOf('directories'), { directoryRead: true });
			assert.strictEqual(await skillsOf('plain'), undefined);
		});

		test('listSkillsForServer passes the listed entries on, and nothing for a server without the extension', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));
			const skill = { entry: ENTRY } as IMcpSkill;
			mcpService.servers.set([
				createServer('c', 'skills', [], McpServerCacheState.Live, { capabilities: McpCapability.Skills, skills: [skill] }),
				createServer('c', 'plain', [], McpServerCacheState.Live, { capabilities: McpCapability.Resources, skills: [skill] }),
			], undefined);
			assert.deepStrictEqual(await channel.call(undefined, 'listSkillsForServer', { serverId: 'skills' }), [ENTRY]);
			assert.deepStrictEqual(await channel.call(undefined, 'listSkillsForServer', { serverId: 'plain' }), []);
		});

		test('getSkillForServer validates the entry of the server; an unknown skill or an invalid entry is undefined', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));
			const handler = ds.add(new StubRequestHandler());
			mcpService.servers.set([createServer('c', 'skills', [], McpServerCacheState.Live, { handler, capabilities: McpCapability.Skills })], undefined);

			handler.skill = ENTRY;
			assert.deepStrictEqual(await channel.call(undefined, 'getSkillForServer', { serverId: 'skills', uri: ENTRY.uri }), ENTRY);
			assert.deepStrictEqual(handler.calls.map(call => [call.method, call.params]), [['getSkill', { uri: ENTRY.uri }]]);
			handler.skill = { ...ENTRY, resources: 'static' };
			assert.strictEqual(await channel.call(undefined, 'getSkillForServer', { serverId: 'skills', uri: ENTRY.uri }), undefined);
			handler.skill = undefined;
			assert.strictEqual(await channel.call(undefined, 'getSkillForServer', { serverId: 'skills', uri: 'skill://nope/SKILL.md' }), undefined);
			handler.failure = new MpcResponseError('boom', MCP.INTERNAL_ERROR, undefined);
			await assert.rejects(channel.call(undefined, 'getSkillForServer', { serverId: 'skills', uri: ENTRY.uri }), /boom/);
		});

		test('readDirectoryForServer passes the children on; a URI that is not a directory is undefined', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));
			const handler = ds.add(new StubRequestHandler());
			mcpService.servers.set([createServer('c', 'skills', [], McpServerCacheState.Live, { handler, capabilities: McpCapability.Skills | McpCapability.SkillsDirectoryRead })], undefined);
			handler.directory = [{ uri: 'skill://git/SKILL.md', name: 'git' }];
			assert.deepStrictEqual(await channel.call(undefined, 'readDirectoryForServer', { serverId: 'skills', uri: 'skill://git' }), handler.directory);
			handler.directory = undefined;
			assert.strictEqual(await channel.call(undefined, 'readDirectoryForServer', { serverId: 'skills', uri: ENTRY.uri }), undefined);
		});
	});

	test('readResourceForServer passes the IPC token to the handler', async () => {
		const mcpService = new TestMcpService();
		const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

		const handler = ds.add(new StubRequestHandler());
		mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler, capabilities: McpCapability.Resources })], undefined);

		const cts = ds.add(new CancellationTokenSource());
		const result = await channel.call<MCPLegacy.ReadResourceResult>(undefined, 'readResourceForServer', { serverId: 'serverA', uri: 'file:///a.txt' }, cts.token);

		assert.deepStrictEqual(result.contents.map(c => c.uri), ['file:///a.txt']);
		assert.deepStrictEqual(handler.calls[0].params, { uri: 'file:///a.txt' });
		assert.strictEqual(handler.calls[0].token, cts.token);
	});

	suite('resource subscriptions', () => {
		test('keeps the handler subscription until unsubscribed and forwards updates once', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler, capabilities: McpCapability.Resources | McpCapability.ResourcesSubscribe })], undefined);

			const updates: IMcpGatewayResourceUpdateEvent[] = [];
			ds.add(channel.listen<IMcpGatewayResourceUpdateEvent>(undefined, 'onDidUpdateResource')(e => updates.push(e)));

			const first = await channel.call<string>(undefined, 'subscribeResourceForServer', { serverId: 'serverA', uri: 'file:///a' });
			const second = await channel.call<string>(undefined, 'subscribeResourceForServer', { serverId: 'serverA', uri: 'file:///b' });
			assert.strictEqual(typeof first, 'string');
			assert.notStrictEqual(first, second);
			assert.deepStrictEqual(handler.subscriptions.map(s => s.uri), ['file:///a', 'file:///b']);

			// One notification reaches the client once however many subscriptions the server has.
			handler.fireResourceUpdated('file:///a');
			assert.deepStrictEqual(updates, [{ serverId: 'serverA', uri: 'file:///a' }]);

			await channel.call(undefined, 'unsubscribeResourceForServer', { subscriptionId: first });
			assert.deepStrictEqual(handler.subscriptions.map(s => s.disposed), [true, false]);

			handler.fireResourceUpdated('file:///b');
			assert.strictEqual(updates.length, 2);

			await channel.call(undefined, 'unsubscribeResourceForServer', { subscriptionId: second });
			assert.deepStrictEqual(handler.subscriptions.map(s => s.disposed), [true, true]);

			handler.fireResourceUpdated('file:///b');
			assert.strictEqual(updates.length, 2, 'no forwarding without subscriptions');

			// Unsubscribing twice, or an id that never existed, is a no-op.
			await channel.call(undefined, 'unsubscribeResourceForServer', { subscriptionId: second });
			await channel.call(undefined, 'unsubscribeResourceForServer', { subscriptionId: 'nope' });
		});

		test('tags updates with the server they come from', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handlerA = ds.add(new StubRequestHandler());
			const handlerB = ds.add(new StubRequestHandler());
			mcpService.servers.set([
				createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler: handlerA }),
				createServer('collectionB', 'serverB', [], McpServerCacheState.Live, { handler: handlerB }),
			], undefined);

			const updates: IMcpGatewayResourceUpdateEvent[] = [];
			ds.add(channel.listen<IMcpGatewayResourceUpdateEvent>(undefined, 'onDidUpdateResource')(e => updates.push(e)));

			await channel.call<string>(undefined, 'subscribeResourceForServer', { serverId: 'serverA', uri: 'file:///a' });
			await channel.call<string>(undefined, 'subscribeResourceForServer', { serverId: 'serverB', uri: 'file:///b' });

			handlerB.fireResourceUpdated('file:///b');
			handlerA.fireResourceUpdated('file:///a');
			assert.deepStrictEqual(updates, [
				{ serverId: 'serverB', uri: 'file:///b' },
				{ serverId: 'serverA', uri: 'file:///a' },
			]);
		});

		test('closes open subscriptions when the broker is disposed', async () => {
			const mcpService = new TestMcpService();
			const channel = new McpGatewayToolBrokerChannel(mcpService, new NullLogService());

			const handler = ds.add(new StubRequestHandler());
			mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler })], undefined);

			await channel.call<string>(undefined, 'subscribeResourceForServer', { serverId: 'serverA', uri: 'file:///a' });
			assert.deepStrictEqual(handler.subscriptions.map(s => s.disposed), [false]);

			channel.dispose();
			assert.deepStrictEqual(handler.subscriptions.map(s => s.disposed), [true]);
		});

		test('releases the handler subscription when subscribing fails', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			handler.failure = new Error('subscribe failed');
			mcpService.servers.set([createServer('collectionA', 'serverA', [], McpServerCacheState.Live, { handler })], undefined);

			await assert.rejects(channel.call<string>(undefined, 'subscribeResourceForServer', { serverId: 'serverA', uri: 'file:///a' }), /subscribe failed/);
		});
	});

	suite('tool call notifications', () => {
		test('forwards progress and logs keyed by the call id while the call is in flight', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			const server = createServer('collectionA', 'serverA', [
				createProgressTool('slow', handler, async (_args, progressToken, progress) => {
					handler.fireProgress({ progressToken, progress: 1, total: 4, message: 'one' });
					handler.fireProgress({ progressToken: 'another-call', progress: 9, total: 10, message: 'other' });
					handler.fireLog({ level: 'info', data: { step: 1 }, logger: 'stub' });
					handler.fireProgress({ progressToken, progress: 2, message: 'two' });
					// A status message of the call itself, outside of any notification.
					progress.report({ message: 'Round 1: answered 1 input request(s)' });
					handler.fireLog({ level: 'warning', data: 'careful' });
					return { content: [{ type: 'text', text: 'done' }] };
				}),
			], McpServerCacheState.Live, { handler });
			mcpService.servers.set([server], undefined);

			const progressEvents: IMcpGatewayToolProgressEvent[] = [];
			const logEvents: IMcpGatewayToolLogEvent[] = [];
			ds.add(channel.listen<IMcpGatewayToolProgressEvent>(undefined, 'onToolProgress')(e => progressEvents.push(e)));
			ds.add(channel.listen<IMcpGatewayToolLogEvent>(undefined, 'onToolLog')(e => logEvents.push(e)));

			const result = await channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', { serverId: 'serverA', name: 'slow', args: {}, callId: 'call-1' });
			assert.strictEqual((result.content[0] as MCPLegacy.TextContent).text, 'done');

			assert.deepStrictEqual(progressEvents, [
				{ callId: 'call-1', progress: 1, total: 4, message: 'one' },
				{ callId: 'call-1', progress: 2, total: undefined, message: 'two' },
				{ callId: 'call-1', progress: 2, message: 'Round 1: answered 1 input request(s)' },
			]);
			assert.deepStrictEqual(logEvents, [
				{ callId: 'call-1', level: 'info', data: { step: 1 }, logger: 'stub' },
				{ callId: 'call-1', level: 'warning', data: 'careful', logger: undefined },
			]);

			// Once the call finished, the server's notifications are no longer the call's.
			handler.fireProgress({ progressToken: 'whatever', progress: 3 });
			handler.fireLog({ level: 'error', data: 'late' });
			assert.strictEqual(progressEvents.length, 3);
			assert.strictEqual(logEvents.length, 2);
		});

		test('keeps concurrent calls apart', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			const gates = new Map<string, { token: string; release: () => void }>();
			const server = createServer('collectionA', 'serverA', [
				createProgressTool('gated', handler, (args, progressToken) => new Promise<MCPLegacy.CallToolResult>(resolve => {
					gates.set(String(args.id), { token: progressToken, release: () => resolve({ content: [{ type: 'text', text: String(args.id) }] }) });
				})),
			], McpServerCacheState.Live, { handler });
			mcpService.servers.set([server], undefined);

			const progressEvents: IMcpGatewayToolProgressEvent[] = [];
			ds.add(channel.listen<IMcpGatewayToolProgressEvent>(undefined, 'onToolProgress')(e => progressEvents.push(e)));

			const first = channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', { serverId: 'serverA', name: 'gated', args: { id: 'a' }, callId: 'call-a' });
			const second = channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', { serverId: 'serverA', name: 'gated', args: { id: 'b' }, callId: 'call-b' });
			await Event.toPromise(Event.filter(handler.onDidChangeGates, () => gates.size === 2));

			handler.fireProgress({ progressToken: gates.get('b')!.token, progress: 1, total: 2, message: 'b first' });
			handler.fireProgress({ progressToken: gates.get('a')!.token, progress: 5, message: 'then a' });
			assert.deepStrictEqual(progressEvents, [
				{ callId: 'call-b', progress: 1, total: 2, message: 'b first' },
				{ callId: 'call-a', progress: 5, total: undefined, message: 'then a' },
			]);

			gates.get('a')!.release();
			gates.get('b')!.release();
			assert.deepStrictEqual((await Promise.all([first, second])).map(r => (r.content[0] as MCPLegacy.TextContent).text), ['a', 'b']);
		});

		test('does not attribute another call\'s notification to a later status message', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			const gates = new Map<string, { token: string; progress: ToolProgress; release: () => void }>();
			const server = createServer('collectionA', 'serverA', [
				createProgressTool('gated', handler, (args, progressToken, progress) => new Promise<MCPLegacy.CallToolResult>(resolve => {
					gates.set(String(args.id), { token: progressToken, progress, release: () => resolve({ content: [] }) });
				})),
			], McpServerCacheState.Live, { handler });
			mcpService.servers.set([server], undefined);

			const progressEvents: IMcpGatewayToolProgressEvent[] = [];
			ds.add(channel.listen<IMcpGatewayToolProgressEvent>(undefined, 'onToolProgress')(e => progressEvents.push(e)));

			const first = channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', { serverId: 'serverA', name: 'gated', args: { id: 'a' }, callId: 'call-a' });
			const second = channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', { serverId: 'serverA', name: 'gated', args: { id: 'b' }, callId: 'call-b' });
			await Event.toPromise(Event.filter(handler.onDidChangeGates, () => gates.size === 2));

			// b's notification also reaches a's observer, which must not keep it once the delivery is over.
			handler.fireProgress({ progressToken: gates.get('b')!.token, progress: 3, message: 'Working' });
			await Promise.resolve();
			gates.get('a')!.progress.report({ message: 'Working' });

			assert.deepStrictEqual(progressEvents, [
				{ callId: 'call-b', progress: 3, total: undefined, message: 'Working' },
				{ callId: 'call-a', progress: 0, message: 'Working' },
			]);

			gates.get('a')!.release();
			gates.get('b')!.release();
			await Promise.all([first, second]);
		});

		test('cancels an observed call through the IPC token', async () => {
			const mcpService = new TestMcpService();
			const channel = ds.add(new McpGatewayToolBrokerChannel(mcpService, new NullLogService()));

			const handler = ds.add(new StubRequestHandler());
			const server = createServer('collectionA', 'serverA', [
				createProgressTool('hang', handler, (_args, _progressToken, _progress, token) => new Promise<MCPLegacy.CallToolResult>((_resolve, reject) => {
					ds.add(token.onCancellationRequested(() => reject(new CancellationError())));
				})),
			], McpServerCacheState.Live, { handler });
			mcpService.servers.set([server], undefined);

			const cts = ds.add(new CancellationTokenSource());
			const call = channel.call<MCPLegacy.CallToolResult>(undefined, 'callToolForServer', { serverId: 'serverA', name: 'hang', args: {}, callId: 'call-1' }, cts.token);
			await Event.toPromise(handler.onDidChangeGates);
			cts.cancel();
			await assert.rejects(call, err => isCancellationError(err));

			// The call's listeners are gone.
			handler.fireLog({ level: 'info', data: 'late' });
			assert.strictEqual(handler.loggingListeners, 0);
		});
	});
});

const completeParams: MCPLegacy.CompleteRequest['params'] = {
	ref: { type: 'ref/prompt', name: 'summarize' },
	argument: { name: 'topic', value: 'M' },
};

interface IStubHandlerCall {
	readonly method: string;
	readonly params: unknown;
	readonly token: CancellationToken | undefined;
	readonly context: IMcpToolCallContext | undefined;
}

/** The parts of `McpServerRequestHandler` the broker talks to, with the server's notifications under test control. */
class StubRequestHandler extends Disposable {
	private readonly _onDidReceiveProgressNotification = this._register(new Emitter<MCPLegacy.ProgressNotification>());
	readonly onDidReceiveProgressNotification = this._onDidReceiveProgressNotification.event;
	private readonly _onDidReceiveLoggingNotification = this._register(new Emitter<MCP.LoggingMessageNotificationParams>());
	readonly onDidReceiveLoggingNotification = this._onDidReceiveLoggingNotification.event;
	private readonly _onDidUpdateResource = this._register(new Emitter<MCP.ResourceUpdatedNotificationParams>());
	readonly onDidUpdateResource = this._onDidUpdateResource.event;
	/** Fires whenever a gated tool call of a test reached its gate. */
	private readonly _onDidChangeGates = this._register(new Emitter<void>());
	readonly onDidChangeGates = this._onDidChangeGates.event;

	readonly calls: IStubHandlerCall[] = [];
	readonly subscriptions: { readonly uri: string; disposed: boolean }[] = [];
	prompts: MCPLegacy.Prompt[] = [];
	promptResult: MCPLegacy.GetPromptResult = { messages: [] };
	completeResult: MCPLegacy.CompleteResult = { completion: { values: [] } };
	/** When set, every request fails with it. */
	failure: Error | undefined;

	get loggingListeners(): number {
		return this._onDidReceiveLoggingNotification.hasListeners() ? 1 : 0;
	}

	asHandler(): McpServerRequestHandler {
		return this as unknown as McpServerRequestHandler;
	}

	fireProgress(params: MCPLegacy.ProgressNotificationParams): void {
		this._onDidReceiveProgressNotification.fire({ jsonrpc: MCPLegacy.JSONRPC_VERSION, method: 'notifications/progress', params });
	}

	fireLog(params: MCP.LoggingMessageNotificationParams): void {
		this._onDidReceiveLoggingNotification.fire(params);
	}

	fireResourceUpdated(uri: string): void {
		this._onDidUpdateResource.fire({ uri });
	}

	gateReached(): void {
		this._onDidChangeGates.fire();
	}

	listPrompts(): Promise<MCPLegacy.Prompt[]> {
		return this._record('listPrompts', undefined, undefined, undefined, () => this.prompts);
	}

	getPrompt(params: MCPLegacy.GetPromptRequest['params'], token?: CancellationToken, context?: IMcpToolCallContext): Promise<MCPLegacy.GetPromptResult> {
		return this._record('getPrompt', params, token, context, () => this.promptResult);
	}

	complete(params: MCPLegacy.CompleteRequest['params'], token?: CancellationToken): Promise<MCPLegacy.CompleteResult> {
		return this._record('complete', params, token, undefined, () => this.completeResult);
	}

	readResource(params: MCPLegacy.ReadResourceRequest['params'], token?: CancellationToken): Promise<MCPLegacy.ReadResourceResult> {
		return this._record('readResource', params, token, undefined, () => ({ contents: [{ uri: params.uri, text: 'hello' }] }));
	}

	listResources(): Promise<MCPLegacy.Resource[]> {
		return this._record('listResources', undefined, undefined, undefined, () => []);
	}

	listResourceTemplates(): Promise<MCPLegacy.ResourceTemplate[]> {
		return this._record('listResourceTemplates', undefined, undefined, undefined, () => []);
	}

	/** The entry `skills/get` answers with; undefined: the server answers -32602. */
	skill: unknown;
	/** The children `resources/directory/read` answers with; undefined: the server answers -32602. */
	directory: MCPLegacy.Resource[] | undefined;

	getSkill(params: { uri: string }, token?: CancellationToken): Promise<unknown> {
		return this._record('getSkill', params, token, undefined, () => {
			if (this.skill === undefined) {
				throw new MpcResponseError('Unknown skill', MCP.INVALID_PARAMS, undefined);
			}
			return this.skill;
		});
	}

	readDirectory(params: { uri: string }, token?: CancellationToken): Promise<MCPLegacy.Resource[]> {
		return this._record('readDirectory', params, token, undefined, () => {
			if (this.directory === undefined) {
				throw new MpcResponseError('Not a directory', MCP.INVALID_PARAMS, undefined);
			}
			return this.directory;
		});
	}

	subscribeResource(uri: string): IDisposable {
		if (this.failure) {
			throw this.failure;
		}
		const subscription = { uri, disposed: false };
		this.subscriptions.push(subscription);
		return toDisposable(() => { subscription.disposed = true; });
	}

	private _record<T>(method: string, params: unknown, token: CancellationToken | undefined, context: IMcpToolCallContext | undefined, result: () => T): Promise<T> {
		this.calls.push({ method, params, token, context });
		return this.failure ? Promise.reject(this.failure) : new Promise<T>(resolve => resolve(result()));
	}
}

interface IServerOptions {
	/** Installs a live connection whose handler is this stub. */
	readonly handler?: StubRequestHandler;
	readonly capabilities?: McpCapability;
	/** Capabilities the server learns when it starts. */
	readonly capabilitiesOnStart?: McpCapability;
	/** What `skills()` lists. */
	readonly skills?: readonly IMcpSkill[];
}

type TestServer = IMcpServer & {
	readonly toolsValue: ReturnType<typeof observableValue<readonly IMcpTool[]>>;
	readonly promptsValue: ReturnType<typeof observableValue<readonly never[]>>;
	readonly startCalls: number;
};

function createDefinition(definitionId: string): McpServerDefinition {
	return {
		id: definitionId,
		label: definitionId,
		cacheNonce: 'nonce',
		launch: { type: McpServerTransportType.Stdio, cwd: undefined, command: 'stub', args: [], env: {}, envFile: undefined, sandbox: undefined },
	};
}

function createConnection(owner: object, definition: McpServerDefinition, handler: StubRequestHandler): IMcpServerConnection {
	return {
		definition,
		state: observableValue(owner, { state: McpConnectionState.Kind.Running }),
		handler: observableValue(owner, handler.asHandler()),
		onPotentialSandboxBlock: Event.None,
		launchDefinition: definition.launch,
		start: async () => ({ state: McpConnectionState.Kind.Running }),
		stop: async () => { },
		dispose: () => { },
	};
}

function createServer(
	collectionId: string,
	definitionId: string,
	initialTools: readonly IMcpTool[],
	initialCacheState: McpServerCacheState = McpServerCacheState.Live,
	options: IServerOptions = {},
): TestServer {
	const owner = {};
	const definition = createDefinition(definitionId);
	const tools = observableValue<readonly IMcpTool[]>(owner, initialTools);
	const prompts = observableValue<readonly never[]>(owner, []);
	const connectionState = observableValue<McpConnectionState>(owner, { state: McpConnectionState.Kind.Running });
	const cacheState = observableValue<McpServerCacheState>(owner, initialCacheState);
	const capabilities = observableValue<McpCapability | undefined>(owner, options.capabilities);
	let startCalls = 0;

	return {
		collection: { id: collectionId, label: collectionId, order: 0 },
		definition: { id: definitionId, label: definitionId },
		connection: observableValue(owner, options.handler ? createConnection(owner, definition, options.handler) : undefined),
		connectionState,
		enablement: observableValue(owner, ContributionEnablementState.EnabledProfile),
		serverMetadata: observableValue(owner, undefined),
		readDefinitions: () => observableValue(owner, { server: undefined, collection: undefined }),
		showOutput: async () => { },
		start: async () => {
			startCalls++;
			cacheState.set(McpServerCacheState.Live, undefined);
			if (options.capabilitiesOnStart !== undefined) {
				capabilities.set(options.capabilitiesOnStart, undefined);
			}
			return { state: McpConnectionState.Kind.Running };
		},
		stop: async () => { },
		cacheState,
		tools,
		prompts,
		capabilities,
		resources: () => (async function* () { })(),
		resourceTemplates: async () => [],
		skills: async () => [...options.skills ?? []],
		getSkill: async () => { throw new Error('not used'); },
		loadSkill: async () => { throw new Error('not used'); },
		dispose: () => { },
		toolsValue: tools,
		promptsValue: prompts,
		get startCalls() { return startCalls; },
	};
}

function createNeverStartingServer(
	collectionId: string,
	definitionId: string,
	initialTools: readonly IMcpTool[],
): IMcpServer & { startCalls: number; startBehavior: 'hang' | 'succeed'; cacheStateValue: ReturnType<typeof observableValue<McpServerCacheState>> } {
	const owner = {};
	const tools = observableValue<readonly IMcpTool[]>(owner, initialTools);
	const connectionState = observableValue<McpConnectionState>(owner, { state: McpConnectionState.Kind.Running });
	const cacheState = observableValue<McpServerCacheState>(owner, McpServerCacheState.Unknown);
	let startCalls = 0;
	let startBehavior: 'hang' | 'succeed' = 'hang';

	const result: IMcpServer & { startCalls: number; startBehavior: 'hang' | 'succeed'; cacheStateValue: ReturnType<typeof observableValue<McpServerCacheState>> } = {
		collection: { id: collectionId, label: collectionId, order: 0 },
		definition: { id: definitionId, label: definitionId },
		connection: observableValue(owner, undefined),
		connectionState,
		enablement: observableValue(owner, ContributionEnablementState.EnabledProfile),
		serverMetadata: observableValue(owner, undefined),
		readDefinitions: () => observableValue(owner, { server: undefined, collection: undefined }),
		showOutput: async () => { },
		start: async () => {
			startCalls++;
			if (result.startBehavior === 'succeed') {
				cacheState.set(McpServerCacheState.Live, undefined);
				return { state: McpConnectionState.Kind.Running };
			}
			// Never resolves — simulates a server that hangs on startup.
			return new Promise<McpConnectionState>(() => { });
		},
		stop: async () => { },
		cacheState,
		tools,
		prompts: observableValue(owner, []),
		capabilities: observableValue(owner, undefined),
		resources: () => (async function* () { })(),
		resourceTemplates: async () => [],
		skills: async () => [],
		getSkill: async () => { throw new Error('not used'); },
		loadSkill: async () => { throw new Error('not used'); },
		dispose: () => { },
		get startCalls() { return startCalls; },
		get startBehavior() { return startBehavior; },
		set startBehavior(v) { startBehavior = v; },
		cacheStateValue: cacheState,
	};
	return result;
}

function createToolDefinition(name: string): MCPLegacy.Tool {
	return {
		name,
		description: `Tool ${name}`,
		inputSchema: {
			type: 'object',
			properties: {
				input: { type: 'string' },
			},
		},
	};
}

function createToolWithContextCapture(
	name: string,
	receivedContexts: (IMcpToolCallContext | undefined)[],
	call: (params: Record<string, unknown>) => Promise<MCPLegacy.CallToolResult>,
	visibility: McpToolVisibility = McpToolVisibility.Model,
): IMcpTool {
	return {
		id: `tool_${name}`,
		referenceName: name,
		icons: {} as IMcpIcons,
		definition: createToolDefinition(name),
		visibility,
		uiResourceUri: undefined,
		call: (params: Record<string, unknown>, context, _token) => {
			receivedContexts.push(context);
			return call(params);
		},
		callWithProgress: (params: Record<string, unknown>, _progress, context, _token = CancellationToken.None) => {
			receivedContexts.push(context);
			return call(params);
		},
	};
}

function createTool(name: string, call: (params: Record<string, unknown>, token: CancellationToken) => Promise<MCPLegacy.CallToolResult>, visibility: McpToolVisibility = McpToolVisibility.Model): IMcpTool {
	return {
		id: `tool_${name}`,
		referenceName: name,
		icons: {} as IMcpIcons,
		definition: createToolDefinition(name),
		visibility,
		uiResourceUri: undefined,
		call: (params: Record<string, unknown>, _context, token = CancellationToken.None) => call(params, token),
		callWithProgress: (params: Record<string, unknown>, _progress, _context, token = CancellationToken.None) => call(params, token),
	};
}

/**
 * A tool that behaves like `McpTool` with regard to progress: it reports the
 * server's progress notifications carrying the token of its own request.
 * The implementation gets that token so it can fire notifications as the
 * server would, and signals the stub's gate when it starts.
 */
function createProgressTool(
	name: string,
	handler: StubRequestHandler,
	call: (params: Record<string, unknown>, progressToken: string, progress: ToolProgress, token: CancellationToken) => Promise<MCPLegacy.CallToolResult>,
): IMcpTool {
	const noProgress: ToolProgress = { report: () => { } };
	return {
		id: `tool_${name}`,
		referenceName: name,
		icons: {} as IMcpIcons,
		definition: createToolDefinition(name),
		visibility: McpToolVisibility.Model,
		uiResourceUri: undefined,
		call: (params: Record<string, unknown>, _context, token = CancellationToken.None) => call(params, generateUuid(), noProgress, token),
		callWithProgress: async (params: Record<string, unknown>, progress, _context, token = CancellationToken.None) => {
			const progressToken = generateUuid();
			const listener = handler.onDidReceiveProgressNotification(e => {
				if (e.params.progressToken === progressToken) {
					progress.report({
						message: e.params.message,
						progress: e.params.total !== undefined && e.params.progress !== undefined ? e.params.progress / e.params.total : undefined,
					});
				}
			});
			try {
				const result = call(params, progressToken, progress, token);
				handler.gateReached();
				return await result;
			} finally {
				listener.dispose();
			}
		},
	};
}
