/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IChannel, IPCServer, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import { ILogger, ILoggerService } from '../../log/common/log.js';
import { IMcpGatewayInfo, IMcpGatewayInvokeContext, IMcpGatewayServerCapabilities, IMcpGatewayServerDescriptor, IMcpGatewayServerInfo, IMcpGatewayService, IMcpGatewayToolInvoker, McpGatewayToolBrokerChannelName } from '../common/mcpGateway.js';
import { MCP } from '../common/modelContextProtocol.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';

/** `onToolProgress` from the workbench's tool broker channel (see `McpGatewayToolBrokerChannel`). */
interface IBrokerToolProgressEvent {
	readonly callId: string;
	readonly progress: number;
	readonly total?: number;
	readonly message?: string;
}

/** `onToolLog` from the workbench's tool broker channel. */
interface IBrokerToolLogEvent {
	readonly callId: string;
	readonly level: MCP.LoggingLevel;
	readonly data: unknown;
	readonly logger?: string;
}

/** `onDidUpdateResource` from the workbench's tool broker channel. */
interface IBrokerResourceUpdateEvent {
	readonly serverId: string;
	readonly uri: string;
}

/**
 * IPC channel for the MCP Gateway service, used by the remote server.
 *
 * This channel tracks which client (identified by reconnectionToken) creates gateways,
 * enabling cleanup when a client disconnects.
 */
export class McpGatewayChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	private readonly _onDidChangeGatewayServers = this._register(new Emitter<{ gatewayId: string; servers: readonly IMcpGatewayServerInfo[] }>());
	private readonly _gatewayDisposables = this._register(new DisposableMap<string, DisposableStore>());
	/** Tracks which gateways belong to which client for cleanup on disconnect */
	private readonly _clientGateways = new Map<TContext, Set<string>>();

	constructor(
		private readonly _ipcServer: IPCServer<TContext>,
		@IMcpGatewayService private readonly mcpGatewayService: IMcpGatewayService,
		@ILoggerService private readonly _loggerService: ILoggerService,
	) {
		super();
		this._register(_ipcServer.onDidRemoveConnection(c => {
			this._loggerService.getLogger('mcpGateway')?.info(`[McpGateway][Channel] Client disconnected: ${c.ctx}, cleaning up gateways`);
			mcpGatewayService.disposeGatewaysForClient(c.ctx);

			// Clean up per-gateway change-event forwarders for this client
			const gatewaysForClient = this._clientGateways.get(c.ctx);
			if (gatewaysForClient) {
				for (const gatewayId of gatewaysForClient) {
					this._gatewayDisposables.deleteAndDispose(gatewayId);
				}
				this._clientGateways.delete(c.ctx);
			}
		}));
	}

	listen<T>(_ctx: TContext, event: string): Event<T> {
		if (event === 'onDidChangeGatewayServers') {
			return this._onDidChangeGatewayServers.event as Event<T>;
		}
		throw new Error(`Invalid listen: ${event}`);
	}

	async call<T>(ctx: TContext, command: string, args?: unknown): Promise<T> {
		const logger = this._loggerService.getLogger('mcpGateway');
		logger?.debug(`[McpGateway][Channel] IPC call: ${command} from client ${ctx}`);

		switch (command) {
			case 'createGateway': {
				const { chatSessionResource } = (args as { chatSessionResource?: string } | undefined) ?? {};
				const brokerChannel = ipcChannelForContext(this._ipcServer, ctx);

				// Fetch initial server list before creating the gateway (IPC is async, but the invoker interface is sync)
				const currentServers = await brokerChannel.call<readonly IMcpGatewayServerDescriptor[]>('listServers');

				const gatewayStore = new DisposableStore();
				let result: IMcpGatewayInfo;
				try {
					const invoker = this._createInvoker(ctx, brokerChannel, currentServers, chatSessionResource, gatewayStore, logger);
					result = await this.mcpGatewayService.createGateway(ctx, invoker);
				} catch (error) {
					gatewayStore.dispose();
					throw error;
				}
				// Forward server change events via IPC
				gatewayStore.add(result.onDidChangeServers(servers => {
					this._onDidChangeGatewayServers.fire({ gatewayId: result.gatewayId, servers });
				}));
				this._gatewayDisposables.set(result.gatewayId, gatewayStore);

				// Track client → gateway for disconnect cleanup
				let gatewaysForClient = this._clientGateways.get(ctx);
				if (!gatewaysForClient) {
					gatewaysForClient = new Set<string>();
					this._clientGateways.set(ctx, gatewaysForClient);
				}
				gatewaysForClient.add(result.gatewayId);

				logger?.info(`[McpGateway][Channel] Gateway created: ${result.gatewayId} with ${result.servers.length} server(s) for client ${ctx}`);
				// eslint-disable-next-line local/code-no-dangerous-type-assertions
				return { gatewayId: result.gatewayId, servers: result.servers } as T;
			}
			case 'disposeGateway': {
				const gatewayId = args as string;
				logger?.info(`[McpGateway][Channel] Disposing gateway: ${gatewayId} for client ${ctx}`);
				this._gatewayDisposables.deleteAndDispose(gatewayId);

				// Remove from client tracking
				const gatewaysForClient = this._clientGateways.get(ctx);
				if (gatewaysForClient) {
					gatewaysForClient.delete(gatewayId);
					if (gatewaysForClient.size === 0) {
						this._clientGateways.delete(ctx);
					}
				}

				await this.mcpGatewayService.disposeGateway(gatewayId);
				return undefined as T;
			}
		}

		throw new Error(`Invalid call: ${command}`);
	}

	/**
	 * Builds the gateway's invoker on top of the client's tool broker channel.
	 * Progress and log notifications of tool calls arrive as broker events
	 * keyed by a call id this side generates; the listeners live in
	 * `gatewayStore` and route them to the in-flight call's context. They are
	 * per gateway rather than per call because every `listen` on a routed
	 * `IPCServer` channel keeps an emitter for the server's lifetime.
	 */
	private _createInvoker(ctx: TContext, brokerChannel: IChannel, initialServers: readonly IMcpGatewayServerDescriptor[], gatewayChatSessionResource: string | undefined, gatewayStore: DisposableStore, logger: ILogger | undefined): IMcpGatewayToolInvoker {
		let currentServers = initialServers;
		const inFlightCalls = new Map<string, IMcpGatewayInvokeContext>();
		gatewayStore.add(brokerChannel.listen<IBrokerToolProgressEvent>('onToolProgress')(e => {
			inFlightCalls.get(e.callId)?.onProgress?.({ progress: e.progress, total: e.total, message: e.message });
		}));
		gatewayStore.add(brokerChannel.listen<IBrokerToolLogEvent>('onToolLog')(e => {
			inFlightCalls.get(e.callId)?.onLog?.(e.level, e.data, e.logger);
		}));

		const chatSessionResourceFor = (context: IMcpGatewayInvokeContext | undefined) => context?.chatSessionResource ?? gatewayChatSessionResource;
		const isClientConnected = () => this._ipcServer.connections.some(c => c.ctx === ctx);

		return {
			onDidChangeServers: Event.map(brokerChannel.listen<readonly IMcpGatewayServerDescriptor[]>('onDidChangeServers'), servers => {
				currentServers = servers;
				return servers;
			}),
			onDidChangeTools: brokerChannel.listen<void>('onDidChangeTools'),
			onDidChangeResources: brokerChannel.listen<void>('onDidChangeResources'),
			onDidChangePrompts: brokerChannel.listen<void>('onDidChangePrompts'),
			onDidUpdateResource: brokerChannel.listen<IBrokerResourceUpdateEvent>('onDidUpdateResource'),
			listServers: () => currentServers,
			getServerCapabilities: serverId => brokerChannel.call<IMcpGatewayServerCapabilities | undefined>('getServerCapabilities', { serverId }),
			listToolsForServer: serverId => brokerChannel.call<readonly MCPLegacy.Tool[]>('listToolsForServer', { serverId }),
			callToolForServer: async (serverId, name, callArgs, context) => {
				// Without a call id the broker does not observe the call's notifications at all.
				const callId = context?.onProgress || context?.onLog ? generateUuid() : undefined;
				if (callId !== undefined && context) {
					inFlightCalls.set(callId, context);
				}
				try {
					return await brokerChannel.call<MCPLegacy.CallToolResult>('callToolForServer', { serverId, name, args: callArgs, chatSessionResource: chatSessionResourceFor(context), callId }, context?.token);
				} finally {
					if (callId !== undefined) {
						inFlightCalls.delete(callId);
					}
				}
			},
			listResourcesForServer: serverId => brokerChannel.call<readonly MCPLegacy.Resource[]>('listResourcesForServer', { serverId }),
			readResourceForServer: (serverId, uri, context) => brokerChannel.call<MCPLegacy.ReadResourceResult>('readResourceForServer', { serverId, uri }, context?.token),
			listResourceTemplatesForServer: serverId => brokerChannel.call<readonly MCPLegacy.ResourceTemplate[]>('listResourceTemplatesForServer', { serverId }),
			listPromptsForServer: serverId => brokerChannel.call<readonly MCPLegacy.Prompt[]>('listPromptsForServer', { serverId }),
			getPromptForServer: (serverId, name, promptArgs, context) => brokerChannel.call<MCPLegacy.GetPromptResult>('getPromptForServer', { serverId, name, args: promptArgs, chatSessionResource: chatSessionResourceFor(context) }, context?.token),
			completeForServer: (serverId, params) => brokerChannel.call<MCPLegacy.CompleteResult>('completeForServer', { serverId, params }),
			subscribeResourceForServer: async (serverId, uri) => {
				const subscriptionId = await brokerChannel.call<string>('subscribeResourceForServer', { serverId, uri });
				return toDisposable(() => {
					// A disconnected client's broker closed its subscriptions itself; a call would wait for a client that never comes.
					if (!isClientConnected()) {
						return;
					}
					brokerChannel.call<void>('unsubscribeResourceForServer', { subscriptionId }).catch(error => {
						logger?.warn(`[McpGateway][Channel] Failed to unsubscribe resource '${uri}' on server '${serverId}' for client ${ctx}`, error);
					});
				});
			},
		};
	}
}

function ipcChannelForContext<TContext>(ipcServer: IPCServer<TContext>, ctx: TContext): IChannel {
	return ipcServer.getChannel(McpGatewayToolBrokerChannelName, client => client.ctx === ctx);
}
