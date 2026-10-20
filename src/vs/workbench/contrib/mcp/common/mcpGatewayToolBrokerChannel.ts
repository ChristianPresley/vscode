/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMcpGatewayServerCapabilities, IMcpGatewayServerDescriptor } from '../../../../platform/mcp/common/mcpGateway.js';
import { MCP } from '../../../../platform/mcp/common/modelContextProtocol.js';
import { MCPLegacy } from '../../../../platform/mcp/common/modelContextProtocolLegacy.js';
import { ToolProgress } from '../../chat/common/tools/languageModelToolsService.js';
import { McpServer } from './mcpServer.js';
import { McpServerRequestHandler } from './mcpServerRequestHandler.js';
import { IMcpServer, IMcpService, IMcpToolCallContext, McpCapability, McpServerCacheState, McpToolVisibility } from './mcpTypes.js';
import { startServerAndWaitForLiveTools } from './mcpTypesUtils.js';

interface ICallToolForServerArgs {
	serverId: string;
	name: string;
	args: Record<string, unknown>;
	chatSessionResource?: string;
	/** When set, the server's progress and log notifications for this call are forwarded as `onToolProgress` / `onToolLog`. */
	callId?: string;
}

interface IReadResourceForServerArgs {
	serverId: string;
	uri: string;
}

interface IServerIdArg {
	serverId: string;
}

interface IGetPromptForServerArgs {
	serverId: string;
	name: string;
	args?: Record<string, string>;
	chatSessionResource?: string;
}

interface ICompleteForServerArgs {
	serverId: string;
	params: MCPLegacy.CompleteRequest['params'];
}

interface ISubscribeResourceForServerArgs {
	serverId: string;
	uri: string;
}

interface IUnsubscribeResourceForServerArgs {
	subscriptionId: string;
}

/** Payload of the broker's `onToolProgress` event: a progress notification of an in-flight `callToolForServer`. */
export interface IMcpGatewayToolProgressEvent {
	readonly callId: string;
	readonly progress: number;
	readonly total?: number;
	readonly message?: string;
}

/** Payload of the broker's `onToolLog` event: a log notification received while `callToolForServer` was in flight. */
export interface IMcpGatewayToolLogEvent {
	readonly callId: string;
	readonly level: MCP.LoggingLevel;
	readonly data: unknown;
	readonly logger?: string;
}

/** Payload of the broker's `onDidUpdateResource` event. */
export interface IMcpGatewayResourceUpdateEvent {
	readonly serverId: string;
	readonly uri: string;
}

interface IResourceUpdateForwarder {
	readonly listener: IDisposable;
	refs: number;
}

export class McpGatewayToolBrokerChannel extends Disposable implements IServerChannel<unknown> {
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	private readonly _onDidChangeResources = this._register(new Emitter<void>());
	private readonly _onDidChangePrompts = this._register(new Emitter<void>());
	private readonly _onDidChangeServers = this._register(new Emitter<readonly IMcpGatewayServerDescriptor[]>());
	private readonly _onDidUpdateResource = this._register(new Emitter<IMcpGatewayResourceUpdateEvent>());
	private readonly _onToolProgress = this._register(new Emitter<IMcpGatewayToolProgressEvent>());
	private readonly _onToolLog = this._register(new Emitter<IMcpGatewayToolLogEvent>());

	/**
	 * Resource subscriptions opened through `subscribeResourceForServer`, keyed
	 * by the id handed to the caller. Each entry holds the handler subscription
	 * and a reference on the server's update forwarder; disposing the channel
	 * (the client went away) closes all of them.
	 */
	private readonly _resourceSubscriptions = this._register(new DisposableMap<string, DisposableStore>());
	/** One `onDidUpdateResource` listener per handler, shared by its subscriptions. */
	private readonly _resourceUpdateForwarders = new Map<McpServerRequestHandler, IResourceUpdateForwarder>();

	/**
	 * Per-server promise that races server startup against the grace period timeout.
	 * Once set for a server, subsequent list calls await the already-resolved promise
	 * and return immediately instead of waiting again.
	 *
	 * The `resolved` flag tracks whether the promise has settled. If a server's
	 * cacheState regresses to Unknown/Outdated after the promise resolved (e.g.
	 * after a cache reset), `_waitForStartup` discards the stale entry and creates
	 * a fresh race so the server gets another chance to start.
	 */
	private readonly _startupGrace = new Map<string, { promise: Promise<boolean>; resolved: boolean }>();

	constructor(
		private readonly _mcpService: IMcpService,
		private readonly _logService: ILogService,
		private readonly _startupGracePeriodMs = 5000,
	) {
		super();
		this._logService.debug('[McpGateway][ToolBroker] Initialized');

		let toolsInitialized = false;
		this._register(autorun(reader => {
			for (const server of this._mcpService.servers.read(reader)) {
				server.tools.read(reader);
			}

			if (toolsInitialized) {
				this._logService.debug('[McpGateway][ToolBroker] Tools changed, firing onDidChangeTools');
				this._onDidChangeTools.fire();
			} else {
				toolsInitialized = true;
			}
		}));

		let promptsInitialized = false;
		this._register(autorun(reader => {
			for (const server of this._mcpService.servers.read(reader)) {
				server.prompts.read(reader);
			}

			if (promptsInitialized) {
				this._logService.debug('[McpGateway][ToolBroker] Prompts changed, firing onDidChangePrompts');
				this._onDidChangePrompts.fire();
			} else {
				promptsInitialized = true;
			}
		}));

		let resourcesInitialized = false;
		this._register(autorun(reader => {
			for (const server of this._mcpService.servers.read(reader)) {
				server.capabilities.read(reader);
			}

			if (resourcesInitialized) {
				this._logService.debug('[McpGateway][ToolBroker] Resources changed, firing onDidChangeResources');
				this._onDidChangeResources.fire();
			} else {
				resourcesInitialized = true;
			}
		}));

		let serversInitialized = false;
		this._register(autorun(reader => {
			const servers = this._mcpService.servers.read(reader);

			if (serversInitialized) {
				this._logService.debug('[McpGateway][ToolBroker] Servers changed, firing onDidChangeServers');
				this._onDidChangeServers.fire(servers.map(s => ({ id: s.definition.id, label: s.definition.label })));
			} else {
				serversInitialized = true;
			}
		}));
	}

	override dispose(): void {
		super.dispose();
		// Subscriptions released their forwarder references above; anything left is defensive.
		for (const forwarder of this._resourceUpdateForwarders.values()) {
			forwarder.listener.dispose();
		}
		this._resourceUpdateForwarders.clear();
	}

	private _getServerById(serverId: string): IMcpServer | undefined {
		for (const server of this._mcpService.servers.get()) {
			if (server.definition.id === serverId) {
				return server;
			}
		}
		return undefined;
	}

	private _waitForStartup(server: IMcpServer): Promise<boolean> {
		const id = server.definition.id;
		const existing = this._startupGrace.get(id);
		// If the previous grace promise already resolved but the server is still
		// Unknown/Outdated, the entry is stale (e.g. caches were reset). Discard
		// it so we create a fresh race below.
		if (existing?.resolved) {
			const state = server.cacheState.get();
			if (state === McpServerCacheState.Unknown || state === McpServerCacheState.Outdated) {
				this._startupGrace.delete(id);
			}
		}
		if (!this._startupGrace.has(id)) {
			const entry: { promise: Promise<boolean>; resolved: boolean } = {
				promise: Promise.race([
					this._ensureServerReady(server),
					new Promise<boolean>(resolve => setTimeout(() => resolve(false), this._startupGracePeriodMs)),
				]),
				resolved: false,
			};
			entry.promise.then(() => { entry.resolved = true; });
			this._startupGrace.set(id, entry);
		}
		return this._startupGrace.get(id)!.promise;
	}

	private async _shouldUseCachedData(server: IMcpServer): Promise<boolean> {
		const cacheState = server.cacheState.get();
		if (cacheState === McpServerCacheState.Unknown || cacheState === McpServerCacheState.Outdated) {
			await this._waitForStartup(server);
			const newState = server.cacheState.get();
			return newState === McpServerCacheState.Live
				|| newState === McpServerCacheState.Cached
				|| newState === McpServerCacheState.RefreshingFromCached;
		}
		return cacheState === McpServerCacheState.Live
			|| cacheState === McpServerCacheState.Cached
			|| cacheState === McpServerCacheState.RefreshingFromCached;
	}

	listen<T>(_ctx: unknown, event: string): Event<T> {
		switch (event) {
			case 'onDidChangeTools':
				return this._onDidChangeTools.event as Event<T>;
			case 'onDidChangeResources':
				return this._onDidChangeResources.event as Event<T>;
			case 'onDidChangePrompts':
				return this._onDidChangePrompts.event as Event<T>;
			case 'onDidChangeServers':
				return this._onDidChangeServers.event as Event<T>;
			case 'onDidUpdateResource':
				return this._onDidUpdateResource.event as Event<T>;
			case 'onToolProgress':
				return this._onToolProgress.event as Event<T>;
			case 'onToolLog':
				return this._onToolLog.event as Event<T>;
		}

		throw new Error(`Invalid listen: ${event}`);
	}

	async call<T>(_ctx: unknown, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		this._logService.debug(`[McpGateway][ToolBroker] IPC call: ${command}`);

		switch (command) {
			case 'listServers': {
				const servers = this._listServers();
				return servers as T;
			}
			case 'getServerCapabilities': {
				const { serverId } = arg as IServerIdArg;
				const capabilities = await this._getServerCapabilities(serverId);
				return capabilities as T;
			}
			case 'listToolsForServer': {
				const { serverId } = arg as IServerIdArg;
				const tools = await this._listToolsForServer(serverId);
				return tools as T;
			}
			case 'callToolForServer': {
				const { serverId, name, args, chatSessionResource, callId } = arg as ICallToolForServerArgs;
				const result = await this._callToolForServer(serverId, name, args || {}, chatSessionResource, callId, cancellationToken);
				return result as T;
			}
			case 'listResourcesForServer': {
				const { serverId } = arg as IServerIdArg;
				const resources = await this._listResourcesForServer(serverId);
				return resources as T;
			}
			case 'readResourceForServer': {
				const { serverId, uri } = arg as IReadResourceForServerArgs;
				const result = await this._readResourceForServer(serverId, uri, cancellationToken);
				return result as T;
			}
			case 'listResourceTemplatesForServer': {
				const { serverId } = arg as IServerIdArg;
				const templates = await this._listResourceTemplatesForServer(serverId);
				return templates as T;
			}
			case 'listPromptsForServer': {
				const { serverId } = arg as IServerIdArg;
				const prompts = await this._listPromptsForServer(serverId);
				return prompts as T;
			}
			case 'getPromptForServer': {
				const { serverId, name, args, chatSessionResource } = arg as IGetPromptForServerArgs;
				const result = await this._getPromptForServer(serverId, name, args, chatSessionResource, cancellationToken);
				return result as T;
			}
			case 'completeForServer': {
				const { serverId, params } = arg as ICompleteForServerArgs;
				const result = await this._completeForServer(serverId, params, cancellationToken);
				return result as T;
			}
			case 'subscribeResourceForServer': {
				const { serverId, uri } = arg as ISubscribeResourceForServerArgs;
				const subscriptionId = await this._subscribeResourceForServer(serverId, uri, cancellationToken);
				return subscriptionId as T;
			}
			case 'unsubscribeResourceForServer': {
				const { subscriptionId } = arg as IUnsubscribeResourceForServerArgs;
				this._unsubscribeResourceForServer(subscriptionId);
				return undefined as T;
			}
		}

		throw new Error(`Invalid call: ${command}`);
	}

	private _listServers(): readonly IMcpGatewayServerDescriptor[] {
		const servers = this._mcpService.servers.get();
		const result: IMcpGatewayServerDescriptor[] = [];
		for (const server of servers) {
			result.push({ id: server.definition.id, label: server.definition.label });
		}
		this._logService.debug(`[McpGateway][ToolBroker] listServers result: ${result.length} server(s): [${result.map(s => s.label).join(', ')}]`);
		return result;
	}

	private async _getServerCapabilities(serverId: string): Promise<IMcpGatewayServerCapabilities | undefined> {
		const server = this._getServerById(serverId);
		if (!server) {
			this._logService.warn(`[McpGateway][ToolBroker] getServerCapabilities: unknown server '${serverId}'`);
			return undefined;
		}

		let capabilities = server.capabilities.get();
		if (capabilities === undefined) {
			// Not cached yet: give the server its startup grace period, then look again.
			await this._shouldUseCachedData(server);
			capabilities = server.capabilities.get();
		}
		if (capabilities === undefined) {
			this._logService.debug(`[McpGateway][ToolBroker] Server '${serverId}' capabilities are unknown`);
			return undefined;
		}

		return toGatewayCapabilities(capabilities);
	}

	private async _listToolsForServer(serverId: string): Promise<readonly MCPLegacy.Tool[]> {
		const server = this._getServerById(serverId);
		if (!server) {
			this._logService.warn(`[McpGateway][ToolBroker] listToolsForServer: unknown server '${serverId}'`);
			return [];
		}
		if (!await this._shouldUseCachedData(server)) {
			this._logService.debug(`[McpGateway][ToolBroker] Server '${serverId}' not ready, skipping tool listing`);
			return [];
		}
		const tools = server.tools.get()
			.filter(t => t.visibility & McpToolVisibility.Model)
			.map(t => t.definition);
		this._logService.debug(`[McpGateway][ToolBroker] listToolsForServer '${serverId}': ${tools.length} tool(s)`);
		return tools;
	}

	private async _callToolForServer(serverId: string, name: string, args: Record<string, unknown>, chatSessionResource: string | undefined, callId: string | undefined, token: CancellationToken): Promise<MCPLegacy.CallToolResult> {
		this._logService.debug(`[McpGateway][ToolBroker] callToolForServer '${serverId}' tool '${name}' with args: ${JSON.stringify(args)}`);

		const server = this._getServerById(serverId);
		if (!server) {
			throw new Error(`Unknown server: ${serverId}`);
		}

		const tool = server.tools.get().find(t =>
			t.definition.name === name && (t.visibility & McpToolVisibility.Model)
		);
		if (!tool) {
			throw new Error(`Unknown tool '${name}' on server '${serverId}'`);
		}

		const context = toToolCallContext(chatSessionResource);
		let result: MCPLegacy.CallToolResult;
		if (callId === undefined) {
			result = await tool.call(args, context, token);
		} else {
			const store = new DisposableStore();
			try {
				const progress = await this._observeToolCall(server, callId, store, token);
				result = await tool.callWithProgress(args, progress, context, token);
			} finally {
				store.dispose();
			}
		}
		this._logService.debug(`[McpGateway][ToolBroker] Tool '${name}' on '${serverId}' completed (isError=${result.isError ?? false}, content blocks=${result.content.length})`);
		return result;
	}

	/**
	 * Forwards the server's log notifications as `onToolLog` for as long as
	 * `store` lives, and returns the {@link ToolProgress} to call the tool with:
	 * it fires `onToolProgress` with the server's own progress numbers.
	 *
	 * The tool implementation reports progress synchronously from its listener
	 * on the handler's progress notifications, filtered by the call's progress
	 * token (which only it knows). Our listener on the same emitter is attached
	 * first, so when the tool reports, `pending` is the notification being
	 * delivered. `pending` only lives until the delivery is over, so a status
	 * message the tool reports later, outside of a notification, is never
	 * matched against another call's notification; the equality check guards
	 * the status messages reported during a delivery.
	 */
	private async _observeToolCall(server: IMcpServer, callId: string, store: DisposableStore, token: CancellationToken): Promise<ToolProgress> {
		let pending: MCPLegacy.ProgressNotificationParams | undefined;
		let lastProgress = 0;

		await McpServer.callOn(server, async handler => {
			store.add(handler.onDidReceiveProgressNotification(e => {
				const params = e.params;
				pending = params;
				queueMicrotask(() => {
					if (pending === params) {
						pending = undefined;
					}
				});
			}));
			store.add(handler.onDidReceiveLoggingNotification(e => {
				this._onToolLog.fire({ callId, level: e.level, data: e.data, logger: e.logger });
			}));
		}, token);

		return {
			report: step => {
				const message = typeof step.message === 'string' ? step.message : step.message?.value;
				const raw = pending;
				pending = undefined;
				if (raw && raw.message === message && progressFraction(raw) === step.progress) {
					lastProgress = raw.progress;
					this._onToolProgress.fire({ callId, progress: raw.progress, total: raw.total, message: raw.message });
				} else if (step.progress !== undefined) {
					// No matching notification (the handler changed underneath us): the 0-1 fraction is all we have.
					lastProgress = step.progress;
					this._onToolProgress.fire({ callId, progress: step.progress, total: 1, message });
				} else {
					// A status message of the tool call itself (input rounds, task state).
					this._onToolProgress.fire({ callId, progress: lastProgress, message });
				}
			},
		};
	}

	private async _listResourcesForServer(serverId: string): Promise<readonly MCPLegacy.Resource[]> {
		const server = this._getServerById(serverId);
		if (!server) {
			this._logService.warn(`[McpGateway][ToolBroker] listResourcesForServer: unknown server '${serverId}'`);
			return [];
		}
		if (!await this._shouldUseCachedData(server)) {
			return [];
		}

		const capabilities = server.capabilities.get();
		if (!capabilities || !(capabilities & McpCapability.Resources)) {
			this._logService.debug(`[McpGateway][ToolBroker] Server '${serverId}' has no resource capability`);
			return [];
		}

		try {
			const resources = await McpServer.callOn(server, h => h.listResources());
			this._logService.debug(`[McpGateway][ToolBroker] Server '${serverId}' listed ${resources.length} resource(s)`);
			return resources;
		} catch (error) {
			this._logService.warn(`[McpGateway][ToolBroker] Server '${serverId}' failed to list resources`, error);
			return [];
		}
	}

	private async _readResourceForServer(serverId: string, uri: string, token: CancellationToken): Promise<MCPLegacy.ReadResourceResult> {
		const server = this._getServerById(serverId);
		if (!server) {
			throw new Error(`Unknown server: ${serverId}`);
		}

		this._logService.debug(`[McpGateway][ToolBroker] readResourceForServer '${uri}' from server '${serverId}'`);
		const result = await McpServer.callOn(server, h => h.readResource({ uri }, token), token);
		this._logService.debug(`[McpGateway][ToolBroker] readResourceForServer returned ${result.contents.length} content(s)`);
		return result;
	}

	private async _listResourceTemplatesForServer(serverId: string): Promise<readonly MCPLegacy.ResourceTemplate[]> {
		const server = this._getServerById(serverId);
		if (!server) {
			this._logService.warn(`[McpGateway][ToolBroker] listResourceTemplatesForServer: unknown server '${serverId}'`);
			return [];
		}
		if (!await this._shouldUseCachedData(server)) {
			return [];
		}

		const capabilities = server.capabilities.get();
		if (!capabilities || !(capabilities & McpCapability.Resources)) {
			return [];
		}

		try {
			const resourceTemplates = await McpServer.callOn(server, h => h.listResourceTemplates());
			this._logService.debug(`[McpGateway][ToolBroker] Server '${serverId}' listed ${resourceTemplates.length} resource template(s)`);
			return resourceTemplates;
		} catch (error) {
			this._logService.warn(`[McpGateway][ToolBroker] Server '${serverId}' failed to list resource templates`, error);
			return [];
		}
	}

	private async _listPromptsForServer(serverId: string): Promise<readonly MCPLegacy.Prompt[]> {
		const server = this._getServerById(serverId);
		if (!server) {
			this._logService.warn(`[McpGateway][ToolBroker] listPromptsForServer: unknown server '${serverId}'`);
			return [];
		}
		if (!await this._shouldUseCachedData(server)) {
			return [];
		}

		const capabilities = server.capabilities.get();
		if (!capabilities || !(capabilities & McpCapability.Prompts)) {
			this._logService.debug(`[McpGateway][ToolBroker] Server '${serverId}' has no prompt capability`);
			return [];
		}

		try {
			const prompts = await McpServer.callOn(server, h => h.listPrompts());
			this._logService.debug(`[McpGateway][ToolBroker] Server '${serverId}' listed ${prompts.length} prompt(s)`);
			return prompts;
		} catch (error) {
			this._logService.warn(`[McpGateway][ToolBroker] Server '${serverId}' failed to list prompts`, error);
			return [];
		}
	}

	private async _getPromptForServer(serverId: string, name: string, args: Record<string, string> | undefined, chatSessionResource: string | undefined, token: CancellationToken): Promise<MCPLegacy.GetPromptResult> {
		const server = this._getServerById(serverId);
		if (!server) {
			throw new Error(`Unknown server: ${serverId}`);
		}

		this._logService.debug(`[McpGateway][ToolBroker] getPromptForServer '${name}' from server '${serverId}'`);
		const context = toToolCallContext(chatSessionResource);
		const result = await McpServer.callOn(server, h => h.getPrompt({ name, arguments: args }, token, context), token);
		this._logService.debug(`[McpGateway][ToolBroker] getPromptForServer '${name}' returned ${result.messages.length} message(s)`);
		return result;
	}

	private async _completeForServer(serverId: string, params: MCPLegacy.CompleteRequest['params'], token: CancellationToken): Promise<MCPLegacy.CompleteResult> {
		const server = this._getServerById(serverId);
		if (!server) {
			throw new Error(`Unknown server: ${serverId}`);
		}

		this._logService.debug(`[McpGateway][ToolBroker] completeForServer '${params.argument.name}' on server '${serverId}'`);
		return McpServer.callOn(server, h => h.complete(params, token), token);
	}

	private async _subscribeResourceForServer(serverId: string, uri: string, token: CancellationToken): Promise<string> {
		const server = this._getServerById(serverId);
		if (!server) {
			throw new Error(`Unknown server: ${serverId}`);
		}

		const subscriptionId = generateUuid();
		const store = new DisposableStore();
		try {
			await McpServer.callOn(server, async handler => {
				store.add(handler.subscribeResource(uri));
				store.add(this._acquireResourceUpdateForwarder(serverId, handler));
			}, token);
			if (this._store.isDisposed) {
				throw new Error('The tool broker was disposed');
			}
		} catch (error) {
			store.dispose();
			throw error;
		}

		this._resourceSubscriptions.set(subscriptionId, store);
		this._logService.debug(`[McpGateway][ToolBroker] subscribeResourceForServer '${uri}' on server '${serverId}': ${subscriptionId}`);
		return subscriptionId;
	}

	private _unsubscribeResourceForServer(subscriptionId: string): void {
		if (!this._resourceSubscriptions.has(subscriptionId)) {
			this._logService.debug(`[McpGateway][ToolBroker] unsubscribeResourceForServer: unknown subscription '${subscriptionId}'`);
			return;
		}
		this._resourceSubscriptions.deleteAndDispose(subscriptionId);
		this._logService.debug(`[McpGateway][ToolBroker] unsubscribeResourceForServer: closed '${subscriptionId}'`);
	}

	/**
	 * Forwards the handler's `onDidUpdateResource` as the broker's
	 * `onDidUpdateResource` while at least one subscription holds a reference,
	 * so a notification reaches the client once however many subscriptions
	 * the server has.
	 */
	private _acquireResourceUpdateForwarder(serverId: string, handler: McpServerRequestHandler): IDisposable {
		let forwarder = this._resourceUpdateForwarders.get(handler);
		if (!forwarder) {
			forwarder = {
				refs: 0,
				listener: handler.onDidUpdateResource(e => this._onDidUpdateResource.fire({ serverId, uri: e.uri })),
			};
			this._resourceUpdateForwarders.set(handler, forwarder);
		}
		const entry = forwarder;
		entry.refs++;
		return toDisposable(() => {
			if (--entry.refs === 0) {
				entry.listener.dispose();
				if (this._resourceUpdateForwarders.get(handler) === entry) {
					this._resourceUpdateForwarders.delete(handler);
				}
			}
		});
	}

	private async _ensureServerReady(server: IMcpServer): Promise<boolean> {
		const cacheState = server.cacheState.get();
		if (cacheState !== McpServerCacheState.Unknown && cacheState !== McpServerCacheState.Outdated) {
			return true;
		}

		this._logService.debug(`[McpGateway][ToolBroker] Server '${server.definition.id}' not ready (cacheState=${cacheState}), starting...`);
		try {
			const ready = await startServerAndWaitForLiveTools(server, {
				promptType: 'all-untrusted',
				errorOnUserInteraction: true,
			});
			this._logService.debug(`[McpGateway][ToolBroker] Server '${server.definition.id}' ready=${ready}`);
			return ready;
		} catch (error) {
			this._logService.warn(`[McpGateway][ToolBroker] Server '${server.definition.id}' failed to start`, error);
			return false;
		}
	}
}

function toToolCallContext(chatSessionResource: string | undefined): IMcpToolCallContext | undefined {
	return chatSessionResource ? { chatSessionResource: URI.parse(chatSessionResource) } : undefined;
}

/** The 0-1 fraction a tool reports for a progress notification; `undefined` without a total. */
function progressFraction(params: MCPLegacy.ProgressNotificationParams): number | undefined {
	return params.total !== undefined && params.progress !== undefined ? params.progress / params.total : undefined;
}

/** Maps the server's capability bits to what the gateway advertises; keys are left out rather than set to `undefined` so the DTO survives IPC unchanged. */
export function toGatewayCapabilities(capabilities: McpCapability): IMcpGatewayServerCapabilities {
	const result: { -readonly [K in keyof IMcpGatewayServerCapabilities]: IMcpGatewayServerCapabilities[K] } = {
		completions: !!(capabilities & McpCapability.Completions),
		logging: !!(capabilities & McpCapability.Logging),
	};
	if (capabilities & McpCapability.Tools) {
		result.tools = { listChanged: !!(capabilities & McpCapability.ToolsListChanged) };
	}
	if (capabilities & McpCapability.Prompts) {
		result.prompts = { listChanged: !!(capabilities & McpCapability.PromptsListChanged) };
	}
	if (capabilities & McpCapability.Resources) {
		result.resources = {
			subscribe: !!(capabilities & McpCapability.ResourcesSubscribe),
			listChanged: !!(capabilities & McpCapability.ResourcesListChanged),
		};
	}
	return result;
}
