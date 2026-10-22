/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { constObservable, waitForState } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatMcpAppModel } from '../../../chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppModel.js';
import { IChatToolInvocationSerialized } from '../../../chat/common/chatService/chatService.js';
import { IChatResponseResourceFileSystemProvider } from '../../../chat/common/widget/chatResponseResourceFileSystemProvider.js';
import { IWebviewElement, IWebviewService, WebviewMessageReceivedEvent } from '../../../webview/browser/webview.js';
import { McpToolCallUI } from '../../browser/mcpToolCallUI.js';
import { McpServerRequestHandler } from '../../common/mcpServerRequestHandler.js';
import { IMcpSamplingService, IMcpServer, IMcpServerConnection, IMcpService, IMcpTool, IMcpToolCallUIData, McpConnectionState, McpServerCacheState, McpToolVisibility } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';

type Era = 'modern' | 'legacy';

/** What an App must see for a tools/call result, whichever revision the server speaks. */
const appToolResult: MCPLegacy.CallToolResult = {
	content: [{ type: 'text', text: 'Sunny, 21 C' }],
	structuredContent: { temperature: 21 },
	isError: false,
	_meta: { 'com.example/requestId': 'r-1' },
};

/** What an App must see for a resources/read result, whichever revision the server speaks. */
const appResourceResult: MCPLegacy.ReadResourceResult = {
	contents: [{ uri: 'ui://weather/forecast.json', mimeType: 'application/json', text: '{"days":3}' }],
	_meta: { 'com.example/requestId': 'r-2' },
};

/** Results as each server sends them: a 2026-07-28 server adds `resultType` and the cache hints. */
const serverResults = {
	legacy: { tool: appToolResult, resource: appResourceResult },
	modern: {
		tool: { ...appToolResult, resultType: 'complete', ttlMs: 60000 },
		resource: { ...appResourceResult, resultType: 'complete', ttlMs: 60000, cacheScope: 'private' },
	},
} satisfies Record<Era, { tool: MCPLegacy.CallToolResult; resource: MCPLegacy.ReadResourceResult }>;

const appHtml = { uri: 'ui://weather/app', mimeType: 'text/html;profile=mcp-app', text: '<html><body>weather</body></html>' };

suite('McpToolCallUI', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** The tools/call and resources/read results an App gets through {@link McpToolCallUI}. */
	async function appView(ui: McpToolCallUI) {
		return {
			tool: await ui.callTool('get_weather', { city: 'Paris' }, CancellationToken.None),
			resource: await ui.readResource(appResourceResult.contents[0].uri, CancellationToken.None),
		};
	}

	function agentHostServices(era: Era) {
		const onMcpNotification = store.add(new Emitter<{ channel: string; method: string; params?: Record<string, unknown> }>());
		const connection = upcastPartial<IAgentConnection>({
			onMcpNotification: onMcpNotification.event,
			handleMcpRequest: async (_channel, method, params) => {
				if (method === 'tools/call') {
					return serverResults[era].tool;
				}
				return params?.uri === appHtml.uri ? { contents: [appHtml] } : serverResults[era].resource;
			},
		});
		return store.add(new TestInstantiationService(new ServiceCollection(
			[IAgentHostConnectionsService, upcastPartial<IAgentHostConnectionsService>({
				onDidChangeConnections: Event.None,
				getConnectionByAuthority: authority => authority === 'remote-host' ? connection : undefined,
			})],
			[IThemeService, new TestThemeService()],
		)));
	}

	const agentHostUiData: Extract<IMcpToolCallUIData, { kind: 'agentHost' }> = {
		kind: 'agentHost',
		resourceUri: appHtml.uri,
		connectionAuthority: 'remote-host',
		channel: 'mcp://copilotcli/session/weather',
		serverId: 'weather',
	};

	test('callTool and readResource give an App the 2025-11-25 shape of a modern and a legacy result (Agent Host)', async () => {
		const seen: Record<string, unknown> = {};
		for (const era of ['modern', 'legacy'] as const) {
			seen[era] = await appView(store.add(agentHostServices(era).createInstance(McpToolCallUI, agentHostUiData)));
		}
		assert.deepStrictEqual(seen, {
			modern: { tool: appToolResult, resource: appResourceResult },
			legacy: { tool: appToolResult, resource: appResourceResult },
		});
	});

	test('callTool and readResource give an App the 2025-11-25 shape of a modern and a legacy result (local server)', async () => {
		const seen: Record<string, unknown> = {};
		for (const era of ['modern', 'legacy'] as const) {
			const tool = upcastPartial<IMcpTool>({
				definition: { name: 'get_weather', inputSchema: { type: 'object' } },
				visibility: McpToolVisibility.Model | McpToolVisibility.App,
				call: async () => serverResults[era].tool,
			});
			const handler = upcastPartial<McpServerRequestHandler>({ readResource: async () => serverResults[era].resource });
			const server = upcastPartial<IMcpServer>({
				definition: { id: 'weather', label: 'Weather' },
				collection: { id: 'collection', label: 'Collection', order: 0 },
				start: async () => ({ state: McpConnectionState.Kind.Running }),
				connection: constObservable(upcastPartial<IMcpServerConnection>({ handler: constObservable(handler) })),
				connectionState: constObservable<McpConnectionState>({ state: McpConnectionState.Kind.Running }),
				cacheState: constObservable(McpServerCacheState.Live),
				tools: constObservable([tool]),
			});
			const instantiationService = store.add(new TestInstantiationService(new ServiceCollection(
				[IMcpService, upcastPartial<IMcpService>({ servers: constObservable([server]) })],
				[IMcpSamplingService, upcastPartial<IMcpSamplingService>({})],
				[IThemeService, new TestThemeService()],
			)));
			seen[era] = await appView(store.add(instantiationService.createInstance(McpToolCallUI, {
				kind: 'local',
				resourceUri: appHtml.uri,
				serverDefinitionId: 'weather',
				collectionId: 'collection',
			})));
		}
		assert.deepStrictEqual(seen, {
			modern: { tool: appToolResult, resource: appResourceResult },
			legacy: { tool: appToolResult, resource: appResourceResult },
		});
	});

	test('the tool-result notification and the tools/call and resources/read responses reach the App webview in the 2025-11-25 shape for a modern and a legacy server', async () => {
		const seen: Record<string, unknown> = {};
		for (const era of ['modern', 'legacy'] as const) {
			const onMessage = store.add(new Emitter<WebviewMessageReceivedEvent>());
			const onDidPost = store.add(new Emitter<void>());
			const posted: { id?: number; method?: string; params?: unknown; result?: unknown }[] = [];
			const webview = upcastPartial<IWebviewElement>({
				onMessage: onMessage.event,
				mountTo: () => { },
				setHtml: () => { },
				dispose: () => { },
				postMessage: async message => {
					posted.push(message);
					onDidPost.fire();
					return true;
				},
			});
			const instantiationService = agentHostServices(era);
			instantiationService.set(IWebviewService, upcastPartial<IWebviewService>({ createWebviewElement: () => webview }));
			instantiationService.set(IStorageService, store.add(new InMemoryStorageService()));
			instantiationService.set(IChatWidgetService, upcastPartial<IChatWidgetService>({}));
			instantiationService.set(IChatResponseResourceFileSystemProvider, upcastPartial<IChatResponseResourceFileSystemProvider>({}));
			instantiationService.set(ILogService, new NullLogService());
			instantiationService.set(IProductService, upcastPartial<IProductService>({ nameLong: 'Code - OSS', version: '1.0.0' }));
			instantiationService.set(IOpenerService, upcastPartial<IOpenerService>({}));

			const invocation = upcastPartial<IChatToolInvocationSerialized>({
				kind: 'toolInvocationSerialized',
				toolCallId: `call-${era}`,
				toolId: 'get_weather',
				resultDetails: { input: '{"city":"Paris"}', output: [], mcpOutput: serverResults[era].tool },
			});
			const model = store.add(instantiationService.createInstance(ChatMcpAppModel, invocation, {
				...agentHostUiData,
				input: '{"city":"Paris"}',
				sessionResource: URI.parse('vscode-chat-session://local/session'),
			}, document.createElement('div'), constObservable(400), constObservable(600)));
			await waitForState(model.loadState, state => state.status === 'loaded');

			const fromApp = (id: number, method: string, params: unknown) => onMessage.fire({ message: { jsonrpc: '2.0', id, method, params } });
			fromApp(1, 'ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'weather', version: '1' }, appCapabilities: {} });
			fromApp(2, 'tools/call', { name: 'get_weather', arguments: { city: 'Paris' } });
			fromApp(3, 'resources/read', { uri: appResourceResult.contents[0].uri });

			const toolResult = () => posted.find(m => m.method === 'ui/notifications/tool-result');
			const response = (id: number) => posted.find(m => m.id === id);
			while (!toolResult() || !response(2) || !response(3)) {
				await Event.toPromise(onDidPost.event);
			}
			seen[era] = { toolResult: toolResult()?.params, tool: response(2)?.result, resource: response(3)?.result };
		}
		assert.deepStrictEqual(seen, {
			modern: { toolResult: appToolResult, tool: appToolResult, resource: appResourceResult },
			legacy: { toolResult: appToolResult, tool: appToolResult, resource: appResourceResult },
		});
	});

	test('routes Agent Host requests through the connection authority', async () => {
		const calls: Array<{ connection: string; channel: string; method: string; params: Record<string, unknown> | undefined }> = [];
		const connection = (name: string) => {
			const onMcpNotification = store.add(new Emitter<{ channel: string; method: string; params?: Record<string, unknown> }>());
			return {
				value: upcastPartial<IAgentConnection>({
					onMcpNotification: onMcpNotification.event,
					handleMcpRequest: async (channel, method, params) => {
						calls.push({ connection: name, channel, method, params });
						return {
							contents: [{
								uri: 'ui://github-mcp-server/get-me',
								mimeType: 'text/html',
								text: `<html>${name}</html>`,
							}],
						};
					},
				}),
				notify: (channel: string, method: string) => onMcpNotification.fire({ channel, method }),
			};
		};
		const ambient = connection('ambient');
		const originalRemote = connection('remote-1');
		let remote = originalRemote;
		const onDidChangeConnections = store.add(new Emitter<void>());
		const connectionsService = upcastPartial<IAgentHostConnectionsService>({
			onDidChangeConnections: onDidChangeConnections.event,
			getConnectionByAuthority: authority => authority === 'remote-host' ? remote.value : authority === 'local' ? ambient.value : undefined,
		});
		const instantiationService = store.add(new TestInstantiationService(new ServiceCollection(
			[IAgentHostConnectionsService, connectionsService],
			[IThemeService, new TestThemeService()],
		)));
		const channel = 'mcp://copilotcli/ahp-chat%3A%2F%2Fdefault%2Fsession/GitHub';
		const ui = store.add(instantiationService.createInstance(McpToolCallUI, {
			kind: 'agentHost',
			resourceUri: 'ui://github-mcp-server/get-me',
			connectionAuthority: 'remote-host',
			channel,
			serverId: 'github',
		}));
		const notifications: Array<{ method: string; params?: unknown }> = [];
		store.add(ui.onNotification(notification => notifications.push(notification)));

		const first = await ui.loadResource(CancellationToken.None);
		originalRemote.notify(channel, 'notifications/first');
		remote = connection('remote-2');
		onDidChangeConnections.fire();
		originalRemote.notify(channel, 'notifications/stale');
		remote.notify('mcp://other', 'notifications/wrong-channel');
		remote.notify(channel, 'notifications/second');
		const second = await ui.readResource('ui://github-mcp-server/details', CancellationToken.None);

		assert.deepStrictEqual({
			first: first.html,
			second: second.contents[0],
			calls,
			notifications,
		}, {
			first: '<html>remote-1</html>',
			second: {
				uri: 'ui://github-mcp-server/get-me',
				mimeType: 'text/html',
				text: '<html>remote-2</html>',
			},
			calls: [
				{
					connection: 'remote-1',
					channel,
					method: 'resources/read',
					params: { uri: 'ui://github-mcp-server/get-me' },
				},
				{
					connection: 'remote-2',
					channel,
					method: 'resources/read',
					params: { uri: 'ui://github-mcp-server/details' },
				},
			],
			notifications: [
				{ method: 'notifications/first', params: undefined },
				{ method: 'notifications/second', params: undefined },
			],
		});
	});

	test('preserves remote MCP resource provenance across denied loads, retry and restored render data', async () => {
		const channel = 'mcp://opaque-host-defined-channel/github';
		const resourceUri = 'ui://github-mcp-server/get-me';
		const uiData: IMcpToolCallUIData = {
			kind: 'agentHost',
			resourceUri,
			connectionAuthority: 'remote-host',
			channel,
			serverId: 'github',
		};
		const calls: { channel: string; method: string; params: Record<string, unknown> | undefined }[] = [];
		let denied = true;
		const onMcpNotification = store.add(new Emitter<{ channel: string; method: string; params?: Record<string, unknown> }>());
		const connection = upcastPartial<IAgentConnection>({
			onMcpNotification: onMcpNotification.event,
			handleMcpRequest: async (channel, method, params) => {
				calls.push({ channel, method, params });
				if (denied) {
					throw new Error('MCP app resource is not allowed');
				}
				return { contents: [{ uri: resourceUri, text: '<html>GitHub profile</html>', mimeType: 'text/html;profile=mcp-app' }] };
			},
		});
		const onDidChangeConnections = store.add(new Emitter<void>());
		const instantiationService = store.add(new TestInstantiationService(new ServiceCollection(
			[IAgentHostConnectionsService, upcastPartial<IAgentHostConnectionsService>({
				onDidChangeConnections: onDidChangeConnections.event,
				getConnectionByAuthority: authority => authority === 'remote-host' ? connection : undefined,
			})],
			[IThemeService, new TestThemeService()],
		)));
		const ui = store.add(instantiationService.createInstance(McpToolCallUI, uiData));
		await assert.rejects(ui.loadResource(CancellationToken.None), /MCP app resource is not allowed/);
		denied = false;
		const retried = await ui.loadResource(CancellationToken.None);
		ui.dispose();
		const restored = store.add(instantiationService.createInstance(McpToolCallUI, { ...uiData }));
		const loaded = await restored.loadResource(CancellationToken.None);
		assert.deepStrictEqual({ retried, loaded, calls }, {
			retried: { html: '<html>GitHub profile</html>', mimeType: 'text/html;profile=mcp-app' },
			loaded: { html: '<html>GitHub profile</html>', mimeType: 'text/html;profile=mcp-app' },
			calls: Array.from({ length: 3 }, () => ({ channel, method: 'resources/read', params: { uri: resourceUri } })),
		});
	});
});
