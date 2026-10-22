/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { DeferredPromise, Sequencer } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { SyncDescriptor } from '../../instantiation/common/descriptors.js';
import { ILogger, ILoggerService } from '../../log/common/log.js';
import { IMcpGatewayCreateOptions, IMcpGatewayInfo, IMcpGatewayServerCapabilities, IMcpGatewayServerDescriptor, IMcpGatewayServerInfo, IMcpGatewayService, IMcpGatewaySingleServerInvoker, IMcpGatewayToolInvoker } from '../common/mcpGateway.js';
import { errorResponse, isAllowedOrigin, isLoopbackHost } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';
import { IMcpGatewayGrpcListenerOptions, McpGatewayGrpcListener } from './mcpGatewayGrpc.js';
import { IMcpGatewayRateLimits } from './mcpGatewayRateLimit.js';
import { IMcpGatewayRouteOptions, McpGatewayRoute } from './mcpGatewayRoute.js';
import { McpGatewaySealedState } from './mcpGatewaySealedState.js';

/** Extra hosts and origins the gateway accepts besides the loopback ones (for instance a forwarded port). */
export interface IMcpGatewayServiceOptions {
	/** `Host` header values (hostname, optionally with a port) to accept in addition to loopback hosts. */
	readonly allowedHosts?: readonly string[];
	/** `Origin` header values to accept in addition to loopback origins. */
	readonly allowedOrigins?: readonly string[];
	/**
	 * Lets the gateways and routes that ask for it (`{ grpc: true }` on
	 * {@link McpGatewayService.createGateway} or
	 * {@link McpGatewayService.createRoute}) be served over gRPC too (the
	 * JSON-RPC tunnel and the typed binding) on a loopback listener next to
	 * the HTTP port; their servers then advertise a `grpcAddress`
	 * (`grpc://127.0.0.1:<port>/<routeId>`, see {@link McpGatewayGrpcListener}).
	 * The option opens no port by itself: the listener opens with the first
	 * route that asks for gRPC and closes after the last one (and when the
	 * service is disposed); a route that did not ask is not on it (a call
	 * naming it is NOT_FOUND, as for an unknown route). Same trust model as
	 * HTTP: loopback only, the `:authority` checked, the route id required
	 * on every call (the `mcp-gateway-route` metadata). `true` serves with
	 * the defaults; an object sets listener options (test fixtures:
	 * {@link IMcpGatewayGrpcListenerOptions.allowDefaultRoute}, limits).
	 */
	readonly grpc?: boolean | IMcpGatewayGrpcListenerOptions;
	/**
	 * The per-client rate limits of `tools/call` and `completion/complete` on
	 * every route (HTTP for both protocol revisions, and gRPC). Absent limits
	 * have their defaults (`DEFAULT_MCP_GATEWAY_RATE_LIMITS`: 50 tool calls a
	 * second with bursts of 100, 20 completions a second with bursts of 40);
	 * `false` turns one off. A request over its limit is answered with
	 * `-32603` and `data: { reason: 'rate_limited', retryAfterMs, scope }`
	 * (gRPC: RESOURCE_EXHAUSTED); see `McpGatewayRateLimitedError`.
	 */
	readonly rateLimits?: IMcpGatewayRateLimits;
}

/** A route created with {@link McpGatewayService.createRoute}; disposing it removes the route. */
export interface IMcpGatewayRouteHandle extends IDisposable {
	readonly routeId: string;
	readonly address: URI;
	/** The gRPC address of the route, when it was created with `{ grpc: true }` and the gRPC listener runs. */
	readonly grpcAddress?: URI;
}

let processSealedState: McpGatewaySealedState | undefined;

/** The one sealing key of this process: every route seals `requestState` with it (bound to the route by the AAD). */
function getProcessSealedState(): McpGatewaySealedState {
	processSealedState ??= new McpGatewaySealedState();
	return processSealedState;
}

/**
 * Node.js implementation of the MCP Gateway Service.
 *
 * Creates and manages an HTTP server on localhost that provides MCP gateway endpoints.
 * The server is shared among all gateways and uses ref-counting for lifecycle management.
 * Every request passes the DNS-rebinding check (Host and Origin must be loopback or
 * explicitly allowed) before its route is looked up.
 *
 * The gRPC listener (when the service is configured for gRPC) has its own
 * lifecycle: it opens for the first route whose gateway (or `createRoute`)
 * asked for gRPC, is shared by every such route (concurrent first requests
 * wait for the same start), and closes once no such route exists and no
 * request waits for it.
 */
export class McpGatewayService extends Disposable implements IMcpGatewayService {
	declare readonly _serviceBrand: undefined;

	private _server: http.Server | undefined;
	private _port: number | undefined;
	/** All active routes keyed by their route UUID */
	private readonly _routes = new Map<string, McpGatewayRoute>();
	/** Maps gatewayId → set of route UUIDs belonging to that gateway */
	private readonly _gatewayRoutes = new Map<string, Set<string>>();
	/** Maps gatewayId → serverId → routeId for reverse lookup */
	private readonly _gatewayServerRoutes = new Map<string, Map<string, string>>();
	/** Maps gatewayId to clientId for tracking ownership */
	private readonly _gatewayToClient = new Map<string, unknown>();
	/** Per-gateway disposables (e.g. event listeners) */
	private readonly _gatewayDisposables = new Map<string, DisposableStore>();
	/** Per-route disposables (the single-server invoker's listeners) */
	private readonly _routeDisposables = new Map<string, DisposableStore>();
	private _serverStartPromise: Promise<void> | undefined;
	/**
	 * Counts starts and stops: a start whose generation is no longer current
	 * when one of its awaits resumes (a stop, maybe followed by another
	 * start, came in between) closes what it opened instead of adopting it.
	 */
	private _generation = 0;
	private readonly _logger: ILogger;
	private readonly _sealedState = getProcessSealedState();
	private readonly _allowedHosts: ReadonlySet<string>;
	private readonly _allowedOrigins: ReadonlySet<string>;
	/** The gRPC listener's options when the service may serve gRPC (gateways and routes still ask for it). */
	private readonly _grpcOptions: IMcpGatewayGrpcListenerOptions | undefined;
	/** The gRPC listener while a route is served over gRPC or a request waits for it. */
	private _grpcListener: McpGatewayGrpcListener | undefined;
	/** The start of the gRPC listener in flight; every request that waits for the listener shares it. */
	private _grpcStartPromise: Promise<void> | undefined;
	/** The requests (gateway or route creations, server changes of gRPC gateways) that wait for the gRPC listener: it is not stopped under them. */
	private _grpcWaiters = 0;
	/** The routes served over gRPC. */
	private readonly _grpcRoutes = new Set<string>();
	/** The gateways served over gRPC: the routes of their new servers are served over gRPC too. */
	private readonly _grpcGateways = new Set<string>();
	private readonly _rateLimits: IMcpGatewayRateLimits | undefined;

	constructor(
		@ILoggerService loggerService: ILoggerService,
		options: IMcpGatewayServiceOptions = {},
	) {
		super();
		this._logger = this._register(loggerService.createLogger('mcpGateway', { name: 'MCP Gateway', logLevel: 'always' }));
		this._allowedHosts = new Set((options.allowedHosts ?? []).map(host => host.trim().toLowerCase()));
		this._allowedOrigins = new Set((options.allowedOrigins ?? []).map(origin => origin.trim().toLowerCase()));
		this._grpcOptions = options.grpc === true ? {} : options.grpc || undefined;
		this._rateLimits = options.rateLimits;
		this._logger.info('[McpGatewayService] Initialized');
	}

	/** The port the HTTP server listens on, when it runs. */
	get port(): number | undefined {
		return this._port;
	}

	/** The port of the gRPC listener, while it runs (a route asked for gRPC). */
	get grpcPort(): number | undefined {
		return this._grpcListener?.port;
	}

	/** A route by id (diagnostics and tests). */
	getRoute(routeId: string): McpGatewayRoute | undefined {
		return this._routes.get(routeId);
	}

	async createGateway(clientId: unknown, toolInvoker?: IMcpGatewayToolInvoker, options?: IMcpGatewayCreateOptions): Promise<IMcpGatewayInfo> {
		if (!toolInvoker) {
			throw new Error('[McpGatewayService] Tool invoker is required to create gateway');
		}
		// Created in the turn in which the server (and the gRPC listener, when asked for) runs: a stop may come while a start resolves.
		const info = await this._whenListening(options?.grpc === true, () => true, grpc => this._createGatewayNow(clientId, toolInvoker, grpc));
		if (!info) {
			throw new Error('[McpGatewayService] Server failed to start, port is undefined');
		}
		return info;
	}

	private _createGatewayNow(clientId: unknown, toolInvoker: IMcpGatewayToolInvoker, grpc: boolean): IMcpGatewayInfo {
		const gatewayId = generateUuid();
		const routeIds = new Set<string>();
		const serverRouteMap = new Map<string, string>();
		this._gatewayRoutes.set(gatewayId, routeIds);
		this._gatewayServerRoutes.set(gatewayId, serverRouteMap);

		const disposables = new DisposableStore();
		this._gatewayDisposables.set(gatewayId, disposables);
		if (grpc) {
			this._grpcGateways.add(gatewayId);
		}

		try {
			// Create initial server routes
			const serverDescriptors = toolInvoker.listServers();
			const servers: IMcpGatewayServerInfo[] = [];
			for (const descriptor of serverDescriptors) {
				const serverInfo = this._createRouteForServer(gatewayId, descriptor.id, descriptor.label, toolInvoker, routeIds, serverRouteMap, grpc);
				servers.push(serverInfo);
			}

			// Track client ownership
			const served = grpc ? 'HTTP and gRPC' : 'HTTP';
			if (clientId) {
				this._gatewayToClient.set(gatewayId, clientId);
				this._logger.info(`[McpGatewayService] Created gateway ${gatewayId} with ${servers.length} server(s) over ${served} for client ${clientId}`);
			} else {
				this._logger.warn(`[McpGatewayService] Created gateway ${gatewayId} with ${servers.length} server(s) over ${served} without client tracking`);
			}

			// Listen for server changes to dynamically add/remove routes, one change after the other
			// (a change may wait for the server to start again).
			const onDidChangeServers = disposables.add(new Emitter<readonly IMcpGatewayServerInfo[]>());
			const refreshes = new Sequencer();
			disposables.add(toolInvoker.onDidChangeServers(newDescriptors => {
				refreshes.queue(() => this._refreshGatewayServers(gatewayId, newDescriptors, toolInvoker, routeIds, serverRouteMap, onDidChangeServers)).catch(error => {
					this._logger.error(`[McpGatewayService] Gateway ${gatewayId}: could not apply a change of its servers: ${error}`);
				});
			}));

			return {
				servers,
				onDidChangeServers: onDidChangeServers.event,
				gatewayId,
			};
		} catch (error) {
			// Clean up partially-created state on failure
			this._cleanupGateway(gatewayId);
			throw error;
		}
	}

	/**
	 * Serves one single-server invoker on its own route (the conformance
	 * fixture and tests use this; workbench gateways go through
	 * {@link createGateway}). `dispatcherOptions` can override the advertised
	 * server info, capabilities, cache hints and instructions, and the
	 * route's limits; `options.grpc` serves the route over gRPC too (as for
	 * {@link createGateway}).
	 */
	async createRoute(label: string, invoker: IMcpGatewaySingleServerInvoker, dispatcherOptions?: IMcpGatewayRouteOptions, options?: IMcpGatewayCreateOptions): Promise<IMcpGatewayRouteHandle> {
		const handle = await this._whenListening(options?.grpc === true, () => true, grpc => this._createRouteNow(label, invoker, dispatcherOptions, grpc));
		if (!handle) {
			throw new Error('[McpGatewayService] Server failed to start, port is undefined');
		}
		return handle;
	}

	private _createRouteNow(label: string, invoker: IMcpGatewaySingleServerInvoker, dispatcherOptions: IMcpGatewayRouteOptions | undefined, grpc: boolean): IMcpGatewayRouteHandle {
		const routeId = generateUuid();
		const route = new McpGatewayRoute(routeId, this._logger, invoker, this._sealedState, label, { ...dispatcherOptions, rateLimits: dispatcherOptions?.rateLimits ?? this._rateLimits });
		this._routes.set(routeId, route);
		const store = new DisposableStore();
		this._routeDisposables.set(routeId, store);
		this._serveOverGrpc(route, invoker, store, grpc);
		const address = this._addressOf(routeId);
		const grpcAddress = this._grpcAddressOf(routeId);
		this._logger.info(`[McpGatewayService] Created route ${routeId} for '${label}' at ${address}${grpcAddress ? ` and ${grpcAddress}` : ''}`);
		return {
			routeId,
			address,
			...(grpcAddress ? { grpcAddress } : {}),
			dispose: () => {
				this._disposeRoute(routeId);
				if (this._routes.size === 0) {
					this._stopServer();
				}
			},
		};
	}

	/**
	 * Applies a change of a gateway's servers. Routes for new servers are
	 * created only once the HTTP server (and, for a gateway served over gRPC,
	 * the gRPC listener) run: a gateway that had no routes does not keep the
	 * server alive, so another gateway's disposal may have stopped it, and a
	 * route created then would get the address `http://127.0.0.1:undefined/...`.
	 */
	private async _refreshGatewayServers(
		gatewayId: string,
		newDescriptors: readonly IMcpGatewayServerDescriptor[],
		toolInvoker: IMcpGatewayToolInvoker,
		routeIds: Set<string>,
		serverRouteMap: Map<string, string>,
		onDidChangeServers: Emitter<readonly IMcpGatewayServerInfo[]>,
	): Promise<void> {
		// Bail out if the gateway has been disposed
		if (!this._gatewayRoutes.has(gatewayId)) {
			return;
		}

		// A gateway served over gRPC holds the gRPC listener for the whole change:
		// replacing its last server must not close the listener and open another.
		const grpc = this._grpcGateways.has(gatewayId);
		if (grpc) {
			this._grpcWaiters++;
		}
		try {
			const newServerIds = new Set(newDescriptors.map(d => d.id));
			const existingServerIds = new Set(serverRouteMap.keys());

			// Remove routes for servers that are gone
			for (const serverId of existingServerIds) {
				if (!newServerIds.has(serverId)) {
					const routeId = serverRouteMap.get(serverId);
					if (routeId) {
						this._disposeRoute(routeId);
						routeIds.delete(routeId);
						serverRouteMap.delete(serverId);
					}
				}
			}

			// Update labels for existing servers.
			for (const descriptor of newDescriptors) {
				const routeId = existingServerIds.has(descriptor.id) ? serverRouteMap.get(descriptor.id) : undefined;
				const route = routeId ? this._routes.get(routeId) : undefined;
				if (route && route.label !== descriptor.label) {
					route.label = descriptor.label;
				}
			}

			// Add routes for new servers, on a running server.
			const added = newDescriptors.filter(descriptor => !existingServerIds.has(descriptor.id));
			if (added.length > 0) {
				try {
					// Created in the turn in which the server runs: a stop may come while a start resolves.
					// A start that a stop superseded is not begun again once the gateway is gone.
					await this._whenListening(grpc, () => this._gatewayRoutes.has(gatewayId), servedOverGrpc => {
						for (const descriptor of added) {
							this._createRouteForServer(gatewayId, descriptor.id, descriptor.label, toolInvoker, routeIds, serverRouteMap, servedOverGrpc);
						}
					});
				} catch (error) {
					if (this._store.isDisposed) {
						return;
					}
					this._logger.error(`[McpGatewayService] Gateway ${gatewayId}: the server could not start for ${added.length} new server(s): ${error}`);
				}
				if (!this._gatewayRoutes.has(gatewayId)) {
					return; // Disposed while the server started.
				}
			}

			const updatedServers = this._getGatewayServers(gatewayId);
			this._logger.info(`[McpGatewayService] Gateway ${gatewayId} servers changed: ${updatedServers.length} server(s)`);
			onDidChangeServers.fire(updatedServers);
		} finally {
			if (grpc) {
				this._grpcWaiters--;
				this._stopGrpcListenerIfUnused();
			}
		}
	}

	private _cleanupGateway(gatewayId: string): void {
		const routeIds = this._gatewayRoutes.get(gatewayId);
		if (routeIds) {
			for (const routeId of routeIds) {
				this._disposeRoute(routeId);
			}
		}
		this._gatewayRoutes.delete(gatewayId);
		this._gatewayServerRoutes.delete(gatewayId);
		this._gatewayToClient.delete(gatewayId);
		this._grpcGateways.delete(gatewayId);
		this._gatewayDisposables.get(gatewayId)?.dispose();
		this._gatewayDisposables.delete(gatewayId);
	}

	private _createRouteForServer(
		gatewayId: string,
		serverId: string,
		label: string,
		toolInvoker: IMcpGatewayToolInvoker,
		routeIds: Set<string>,
		serverRouteMap: Map<string, string>,
		grpc: boolean,
	): IMcpGatewayServerInfo {
		const routeId = generateUuid();
		const store = new DisposableStore();
		const singleServerInvoker = this._createSingleServerInvoker(serverId, toolInvoker, store);

		const route = new McpGatewayRoute(routeId, this._logger, singleServerInvoker, this._sealedState, label, { rateLimits: this._rateLimits });
		this._routes.set(routeId, route);
		this._routeDisposables.set(routeId, store);
		this._serveOverGrpc(route, singleServerInvoker, store, grpc);
		routeIds.add(routeId);
		serverRouteMap.set(serverId, routeId);

		const info = this._serverInfoOf(label, routeId);
		this._logger.info(`[McpGatewayService] Created route ${routeId} for server '${label}' (${serverId}) at ${info.address}${info.grpcAddress ? ` and ${info.grpcAddress}` : ''}`);

		return info;
	}

	/**
	 * Serves the route on the gRPC listener until `store` is disposed, when
	 * the route asked for gRPC and the listener runs. A route that did not
	 * ask is not on the listener: a call that names it is NOT_FOUND.
	 */
	private _serveOverGrpc(route: McpGatewayRoute, invoker: IMcpGatewaySingleServerInvoker, store: DisposableStore, grpc: boolean): void {
		const listener = this._grpcListener;
		if (grpc && listener) {
			store.add(listener.addRoute(route.routeId, route.dispatcher, invoker));
			this._grpcRoutes.add(route.routeId);
		}
	}

	private _serverInfoOf(label: string, routeId: string): IMcpGatewayServerInfo {
		const address = this._addressOf(routeId);
		const grpcAddress = this._grpcAddressOf(routeId);
		return grpcAddress ? { label, address, grpcAddress } : { label, address };
	}

	/**
	 * `grpc://127.0.0.1:<port>/<routeId>` for a route served over gRPC: the
	 * authority is the channel's target and the path names the route, which
	 * a call sends as the `mcp-gateway-route` metadata.
	 */
	private _grpcAddressOf(routeId: string): URI | undefined {
		const port = this._grpcRoutes.has(routeId) ? this._grpcListener?.port : undefined;
		return port === undefined ? undefined : URI.from({ scheme: 'grpc', authority: `127.0.0.1:${port}`, path: `/${routeId}` });
	}

	/**
	 * A single-server view of the aggregating invoker. The IPC invoker's
	 * optional methods may be absent; the dispatcher derives the advertised
	 * capabilities from what exists, unless the invoker reports them
	 * (`getServerCapabilities`, fetched once in the background).
	 */
	private _createSingleServerInvoker(serverId: string, toolInvoker: IMcpGatewayToolInvoker, store: DisposableStore): IMcpGatewaySingleServerInvoker {
		let capabilities: IMcpGatewayServerCapabilities | undefined;
		let disposed = false;
		store.add(toDisposable(() => { disposed = true; }));
		toolInvoker.getServerCapabilities?.(serverId).then(value => {
			if (!disposed) {
				capabilities = value;
			}
		}, error => {
			this._logger.warn(`[McpGatewayService] Could not read the capabilities of server ${serverId}: ${error}`);
		});

		const onDidUpdateResource = toolInvoker.onDidUpdateResource;
		const listPromptsForServer = toolInvoker.listPromptsForServer;
		const getPromptForServer = toolInvoker.getPromptForServer;
		const completeForServer = toolInvoker.completeForServer;
		const subscribeResourceForServer = toolInvoker.subscribeResourceForServer;

		return {
			onDidChangeTools: toolInvoker.onDidChangeTools,
			onDidChangeResources: toolInvoker.onDidChangeResources,
			onDidChangePrompts: toolInvoker.onDidChangePrompts,
			onDidUpdateResource: onDidUpdateResource ? Event.map(Event.filter(onDidUpdateResource, e => e.serverId === serverId), e => ({ uri: e.uri })) : undefined,
			get capabilities() {
				return capabilities;
			},
			listTools: () => toolInvoker.listToolsForServer(serverId),
			callTool: (name, args, context) => toolInvoker.callToolForServer(serverId, name, args, context),
			listResources: () => toolInvoker.listResourcesForServer(serverId),
			readResource: (uri, context) => toolInvoker.readResourceForServer(serverId, uri, context),
			listResourceTemplates: () => toolInvoker.listResourceTemplatesForServer(serverId),
			listPrompts: listPromptsForServer ? () => listPromptsForServer.call(toolInvoker, serverId) : undefined,
			getPrompt: getPromptForServer ? (name, args, context) => getPromptForServer.call(toolInvoker, serverId, name, args, context) : undefined,
			complete: completeForServer ? params => completeForServer.call(toolInvoker, serverId, params) : undefined,
			subscribeResource: subscribeResourceForServer ? uri => subscribeResourceForServer.call(toolInvoker, serverId, uri) : undefined,
		};
	}

	private _addressOf(routeId: string): URI {
		return URI.parse(`http://127.0.0.1:${this._port}/gateway/${routeId}`);
	}

	private _getGatewayServers(gatewayId: string): IMcpGatewayServerInfo[] {
		const serverRouteMap = this._gatewayServerRoutes.get(gatewayId);
		if (!serverRouteMap) {
			return [];
		}
		const servers: IMcpGatewayServerInfo[] = [];
		for (const [_serverId, routeId] of serverRouteMap) {
			const route = this._routes.get(routeId);
			if (route) {
				servers.push(this._serverInfoOf(route.label, routeId));
			}
		}
		return servers;
	}

	private _disposeRoute(routeId: string): void {
		const route = this._routes.get(routeId);
		if (route) {
			route.dispose();
			this._routes.delete(routeId);
			this._logger.info(`[McpGatewayService] Disposed route: ${routeId}`);
		}
		this._routeDisposables.get(routeId)?.dispose();
		this._routeDisposables.delete(routeId);
		if (this._grpcRoutes.delete(routeId)) {
			this._stopGrpcListenerIfUnused();
		}
	}

	async disposeGateway(gatewayId: string): Promise<void> {
		if (!this._gatewayRoutes.has(gatewayId)) {
			this._logger.warn(`[McpGatewayService] Attempted to dispose unknown gateway: ${gatewayId}`);
			return;
		}

		this._cleanupGateway(gatewayId);
		this._logger.info(`[McpGatewayService] Disposed gateway: ${gatewayId} (remaining routes: ${this._routes.size})`);

		// If no more routes, shut down the server
		if (this._routes.size === 0) {
			this._stopServer();
		}
	}

	disposeGatewaysForClient(clientId: unknown): void {
		const gatewaysToDispose: string[] = [];

		for (const [gatewayId, ownerClientId] of this._gatewayToClient) {
			if (ownerClientId === clientId) {
				gatewaysToDispose.push(gatewayId);
			}
		}

		if (gatewaysToDispose.length > 0) {
			this._logger.info(`[McpGatewayService] Disposing ${gatewaysToDispose.length} gateway(s) for disconnected client ${clientId}`);

			for (const gatewayId of gatewaysToDispose) {
				this._cleanupGateway(gatewayId);
			}

			// If no more routes, shut down the server
			if (this._routes.size === 0) {
				this._stopServer();
			}
		}
	}

	/** Whether the HTTP server listens. */
	private _isListening(): boolean {
		return this._serverStartPromise === undefined && !!this._server?.listening && this._port !== undefined;
	}

	/**
	 * Runs `create` in the turn in which the HTTP server listens and, when
	 * `grpc` is asked for (and the service may serve gRPC), the gRPC listener
	 * runs too: a stop may come while either starts. `create` learns whether
	 * the gRPC listener runs: one that cannot start is logged and `create`
	 * runs without it (served over HTTP only; the next request tries again).
	 * Resolves with `undefined`, without calling `create`, once `isWanted`
	 * says that the caller no longer needs the routes. While this waits for
	 * the gRPC listener, the listener is not stopped, so concurrent first
	 * requests share one start and one listener.
	 */
	private async _whenListening<T>(grpc: boolean, isWanted: () => boolean, create: (grpc: boolean) => T): Promise<T | undefined> {
		const grpcOptions = grpc ? this._grpcOptions : undefined;
		if (grpc && !grpcOptions) {
			this._logger.warn('[McpGatewayService] gRPC was asked for, but this gateway service does not serve gRPC: serving HTTP only');
		}
		let wantsGrpc = grpcOptions !== undefined;
		if (grpcOptions) {
			this._grpcWaiters++;
		}
		try {
			while (isWanted()) {
				if (!this._isListening()) {
					await this._ensureServer(isWanted);
				} else if (grpcOptions && wantsGrpc && !this._grpcListener) {
					try {
						await this._ensureGrpcListener(grpcOptions);
					} catch (error) {
						if (this._store.isDisposed) {
							throw error;
						}
						this._logger.warn(`[McpGatewayService] The gRPC listener could not start, serving HTTP only: ${error}`);
						wantsGrpc = false;
					}
				} else {
					return create(wantsGrpc);
				}
			}
			return undefined;
		} finally {
			if (grpcOptions) {
				this._grpcWaiters--;
				this._stopGrpcListenerIfUnused();
			}
		}
	}

	/**
	 * Resolves once the HTTP server runs. A start that a stop superseded
	 * resolves without a server: then this waits for (or begins) the current
	 * one, as long as `isWanted` says that the caller still needs a server
	 * (else it resolves without one: a gateway disposed while the server
	 * started must not start it again, since nothing would stop that server).
	 */
	private async _ensureServer(isWanted: () => boolean = () => true): Promise<void> {
		while (true) {
			if (this._store.isDisposed) {
				throw new Error('[McpGatewayService] The service is disposed');
			}
			let start = this._serverStartPromise;
			if (!start) {
				if (this._server?.listening && this._port !== undefined) {
					return;
				}
				if (!isWanted()) {
					return;
				}
				const generation = ++this._generation;
				const promise = this._startServer(generation);
				start = this._serverStartPromise = promise;
				const clear = () => {
					if (this._serverStartPromise === promise) {
						this._serverStartPromise = undefined;
					}
				};
				promise.then(clear, clear);
			}
			await start;
			if (this._serverStartPromise === undefined && this._server?.listening && this._port !== undefined) {
				return;
			}
		}
	}

	private async _startServer(generation: number): Promise<void> {
		const { createServer } = await import('http'); // Lazy due to https://github.com/nodejs/node/issues/59686
		if (generation !== this._generation) {
			return; // Stopped before anything was opened.
		}
		const deferredPromise = new DeferredPromise<number>();

		const server = createServer((req, res) => {
			this._handleRequest(req, res);
		});
		this._server = server;

		const portTimeout = setTimeout(() => {
			deferredPromise.error(new Error('[McpGatewayService] Timeout waiting for server to start'));
		}, 5000);

		server.on('listening', () => {
			const address = server.address();
			clearTimeout(portTimeout);
			if (typeof address === 'string') {
				deferredPromise.complete(parseInt(address));
			} else if (address instanceof Object) {
				deferredPromise.complete(address.port);
			} else {
				deferredPromise.error(new Error('[McpGatewayService] Unable to determine port'));
			}
		});

		server.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				this._logger.warn('[McpGatewayService] Port in use, retrying with random port...');
				// Try with a random port
				server.listen(0, '127.0.0.1');
				return;
			}
			clearTimeout(portTimeout);
			this._logger.error(`[McpGatewayService] Server error: ${err}`);
			deferredPromise.error(err);
		});

		// Use dynamic port assignment (port 0)
		server.listen(0, '127.0.0.1');

		let port: number;
		try {
			port = await deferredPromise.p;
		} catch (error) {
			if (this._server === server) {
				this._server = undefined;
			}
			server.close();
			throw error;
		}
		if (generation !== this._generation) {
			// Stopped while the port opened (a stop before `listening` cannot close it): close it now.
			this._logger.info(`[McpGatewayService] Closing the server on port ${port}: the gateway stopped while it started`);
			this._closeHttpServer(server);
			return;
		}
		this._port = port;
		this._logger.info(`[McpGatewayService] Server started on port ${port}`);
	}

	/**
	 * Settles with the start of the gRPC listener that is in flight, or one
	 * begun now (so concurrent callers share it); rejects when the listener
	 * could not listen, and a later call begins a new start. Called only by
	 * {@link _whenListening} while no listener runs: a start therefore always
	 * has a waiter, which stops the listener when it leaves and nothing uses
	 * it (also when the service was disposed while the listener bound).
	 */
	private _ensureGrpcListener(options: IMcpGatewayGrpcListenerOptions): Promise<void> {
		if (this._store.isDisposed) {
			return Promise.reject(new Error('[McpGatewayService] The service is disposed'));
		}
		if (!this._grpcStartPromise) {
			const promise = this._startGrpcListener(options);
			this._grpcStartPromise = promise;
			const clear = () => {
				if (this._grpcStartPromise === promise) {
					this._grpcStartPromise = undefined;
				}
			};
			promise.then(clear, clear);
		}
		return this._grpcStartPromise;
	}

	/** Opens the gRPC listener next to the HTTP port. */
	private async _startGrpcListener(options: IMcpGatewayGrpcListenerOptions): Promise<void> {
		const listener = this._createGrpcListener(options);
		let port: number;
		try {
			listener.registerTunnelService();
			listener.registerTypedService();
			port = await listener.listen();
		} catch (error) {
			this._logger.error(`[McpGatewayService] Could not start the gRPC listener: ${error}`);
			listener.dispose();
			throw error;
		}
		this._grpcListener = listener;
		this._logger.info(`[McpGatewayService] gRPC listener started on ${listener.addresses.join(', ')} (port ${port})`);
	}

	/** Creates the gRPC listener of a start (tests override it to control when it binds). */
	protected _createGrpcListener(options: IMcpGatewayGrpcListenerOptions): McpGatewayGrpcListener {
		return new McpGatewayGrpcListener(this._logger, options);
	}

	/** Stops the gRPC listener once no route is served over gRPC and no request waits for it. */
	private _stopGrpcListenerIfUnused(): void {
		if (this._grpcListener && this._grpcRoutes.size === 0 && this._grpcWaiters === 0) {
			this._stopGrpcListener(this._store.isDisposed ? 'the service is disposed' : 'no more gRPC routes');
		}
	}

	private _stopGrpcListener(reason: string): void {
		const listener = this._grpcListener;
		this._grpcListener = undefined;
		if (listener) {
			this._logger.info(`[McpGatewayService] Stopping the gRPC listener on port ${listener.port} (${reason})`);
			// Graceful listen results, then GOAWAY to every connection.
			listener.dispose();
		}
	}

	private _stopServer(): void {
		// Whatever start is in flight is superseded: it closes what it opens, and the next start begins afresh.
		this._generation++;
		this._serverStartPromise = undefined;
		const server = this._server;
		if (!server) {
			return;
		}

		this._logger.info('[McpGatewayService] Stopping server (no more routes)');

		// End the long-lived streams first: listen streams get their graceful result, sessions their end.
		for (const route of this._routes.values()) {
			route.closeAllConnections();
		}
		// The gRPC listener stopped with the last gRPC route (or stops once the requests that wait for it are done).
		if (server.listening) {
			this._closeHttpServer(server);
		} // else: the start that opens it closes it once it listens.

		this._server = undefined;
		this._port = undefined;
	}

	private _closeHttpServer(server: http.Server): void {
		server.close(err => {
			if (err) {
				this._logger.error(`[McpGatewayService] Error closing server: ${err}`);
			} else {
				this._logger.info('[McpGatewayService] Server stopped');
			}
		});
		server.closeAllConnections();
	}

	/** The DNS-rebinding check: a non-loopback Host or a foreign Origin is refused. */
	private _isAllowedRequest(req: http.IncomingMessage): boolean {
		const host = req.headers.host;
		const hostAllowed = isLoopbackHost(host) || (host !== undefined && (this._allowedHosts.has(host.trim().toLowerCase()) || this._allowedHosts.has(hostnameOf(host))));
		if (!hostAllowed) {
			return false;
		}
		const origin = req.headers.origin;
		return isAllowedOrigin(origin) || (origin !== undefined && this._allowedOrigins.has(origin.trim().toLowerCase()));
	}

	private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		if (!this._isAllowedRequest(req)) {
			this._logger.warn(`[McpGatewayService] ${req.method} refused: Host '${req.headers.host}', Origin '${req.headers.origin ?? ''}' is not allowed`);
			req.resume();
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(errorResponse(null, MCP.INVALID_REQUEST, 'Forbidden: the Host or Origin header is not allowed')));
			return;
		}

		let url: URL;
		try {
			url = new URL(req.url ?? '/', 'http://127.0.0.1');
		} catch {
			this._logger.warn(`[McpGatewayService] ${req.method} refused: the request target is not a valid URL`);
			req.resume();
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(errorResponse(null, MCP.INVALID_REQUEST, 'Bad request: invalid request target')));
			return;
		}
		const pathParts = url.pathname.split('/').filter(Boolean);

		this._logger.debug(`[McpGatewayService] ${req.method} ${url.pathname} (active routes: ${this._routes.size})`);

		// Expected path: /gateway/{routeId}
		if (pathParts.length === 2 && pathParts[0] === 'gateway') {
			const route = this._routes.get(pathParts[1]);
			if (route) {
				route.handleRequest(req, res);
				return;
			}
		}

		// Not found
		this._logger.warn(`[McpGatewayService] ${req.method} ${url.pathname}: route not found`);
		req.resume();
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(errorResponse(null, MCP.METHOD_NOT_FOUND, 'Gateway route not found')));
	}

	override dispose(): void {
		this._logger.info(`[McpGatewayService] Disposing service (routes: ${this._routes.size})`);
		this._stopServer();
		this._stopGrpcListener('the service is disposed');
		for (const routeId of [...this._routes.keys()]) {
			this._disposeRoute(routeId);
		}
		this._routes.clear();
		this._gatewayRoutes.clear();
		this._gatewayServerRoutes.clear();
		this._gatewayToClient.clear();
		this._grpcGateways.clear();
		for (const disposables of this._gatewayDisposables.values()) {
			disposables.dispose();
		}
		this._gatewayDisposables.clear();
		super.dispose();
	}
}

/** {@link McpGatewayService} with its options as the static argument that DI passes first. */
class ConfiguredMcpGatewayService extends McpGatewayService {
	constructor(options: IMcpGatewayServiceOptions, @ILoggerService loggerService: ILoggerService) {
		super(loggerService, options);
	}
}

/**
 * How DI registrations pass gateway options (the constructor's own options
 * argument follows an injected service, so it can only be given with `new`):
 * `services.set(IMcpGatewayService, mcpGatewayServiceDescriptor({ grpc: true }))`
 * is the product's gateway (electron-main and the remote server): HTTP, and
 * gRPC for the gateways that ask for it (an extension's
 * `vscode.lm.startMcpGateway(resource, { grpc: true })`; no gRPC port until
 * one does), both loopback only. `new SyncDescriptor(McpGatewayService)` is
 * the HTTP-only default.
 */
export function mcpGatewayServiceDescriptor(options: IMcpGatewayServiceOptions): SyncDescriptor<IMcpGatewayService> {
	return new SyncDescriptor(ConfiguredMcpGatewayService, [options]);
}

function hostnameOf(hostHeader: string): string {
	const host = hostHeader.trim().toLowerCase();
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		return end === -1 ? host : host.substring(0, end + 1);
	}
	const colon = host.indexOf(':');
	return colon !== -1 && colon === host.lastIndexOf(':') ? host.substring(0, colon) : host;
}
