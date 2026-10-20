/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { SyncDescriptor } from '../../instantiation/common/descriptors.js';
import { ILogger, ILoggerService } from '../../log/common/log.js';
import { IMcpGatewayInfo, IMcpGatewayServerCapabilities, IMcpGatewayServerDescriptor, IMcpGatewayServerInfo, IMcpGatewayService, IMcpGatewaySingleServerInvoker, IMcpGatewayToolInvoker } from '../common/mcpGateway.js';
import { errorResponse, isAllowedOrigin, isLoopbackHost } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';
import { IMcpGatewayDispatcherOptions } from './mcpGatewayDispatcher.js';
import { McpGatewayGrpcListener } from './mcpGatewayGrpc.js';
import { McpGatewayRoute } from './mcpGatewayRoute.js';
import { McpGatewaySealedState } from './mcpGatewaySealedState.js';

/** Extra hosts and origins the gateway accepts besides the loopback ones (for instance a forwarded port). */
export interface IMcpGatewayServiceOptions {
	/** `Host` header values (hostname, optionally with a port) to accept in addition to loopback hosts. */
	readonly allowedHosts?: readonly string[];
	/** `Origin` header values to accept in addition to loopback origins. */
	readonly allowedOrigins?: readonly string[];
	/**
	 * Also serves every route over gRPC (the JSON-RPC tunnel and the typed
	 * binding) on a loopback listener next to the HTTP port; the servers then
	 * advertise a `grpcAddress` (`grpc://127.0.0.1:<port>/<routeId>`, see
	 * {@link McpGatewayGrpcListener}).
	 */
	readonly grpc?: boolean;
}

/** A route created with {@link McpGatewayService.createRoute}; disposing it removes the route. */
export interface IMcpGatewayRouteHandle extends IDisposable {
	readonly routeId: string;
	readonly address: URI;
	/** The gRPC address of the route, when the gateway serves gRPC. */
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
	private readonly _logger: ILogger;
	private readonly _sealedState = getProcessSealedState();
	private readonly _allowedHosts: ReadonlySet<string>;
	private readonly _allowedOrigins: ReadonlySet<string>;
	private readonly _grpc: boolean;
	private _grpcListener: McpGatewayGrpcListener | undefined;

	constructor(
		@ILoggerService loggerService: ILoggerService,
		options: IMcpGatewayServiceOptions = {},
	) {
		super();
		this._logger = this._register(loggerService.createLogger('mcpGateway', { name: 'MCP Gateway', logLevel: 'always' }));
		this._allowedHosts = new Set((options.allowedHosts ?? []).map(host => host.trim().toLowerCase()));
		this._allowedOrigins = new Set((options.allowedOrigins ?? []).map(origin => origin.trim().toLowerCase()));
		this._grpc = options.grpc === true;
		this._logger.info('[McpGatewayService] Initialized');
	}

	/** The port the HTTP server listens on, when it runs. */
	get port(): number | undefined {
		return this._port;
	}

	/** The port of the gRPC listener, when the gateway serves gRPC and runs. */
	get grpcPort(): number | undefined {
		return this._grpcListener?.port;
	}

	/** A route by id (diagnostics and tests). */
	getRoute(routeId: string): McpGatewayRoute | undefined {
		return this._routes.get(routeId);
	}

	async createGateway(clientId: unknown, toolInvoker?: IMcpGatewayToolInvoker): Promise<IMcpGatewayInfo> {
		// Ensure server is running
		await this._ensureServer();

		if (this._port === undefined) {
			throw new Error('[McpGatewayService] Server failed to start, port is undefined');
		}

		if (!toolInvoker) {
			throw new Error('[McpGatewayService] Tool invoker is required to create gateway');
		}

		const gatewayId = generateUuid();
		const routeIds = new Set<string>();
		const serverRouteMap = new Map<string, string>();
		this._gatewayRoutes.set(gatewayId, routeIds);
		this._gatewayServerRoutes.set(gatewayId, serverRouteMap);

		const disposables = new DisposableStore();
		this._gatewayDisposables.set(gatewayId, disposables);

		try {
			// Create initial server routes
			const serverDescriptors = toolInvoker.listServers();
			const servers: IMcpGatewayServerInfo[] = [];
			for (const descriptor of serverDescriptors) {
				const serverInfo = this._createRouteForServer(gatewayId, descriptor.id, descriptor.label, toolInvoker, routeIds, serverRouteMap);
				servers.push(serverInfo);
			}

			// Track client ownership
			if (clientId) {
				this._gatewayToClient.set(gatewayId, clientId);
				this._logger.info(`[McpGatewayService] Created gateway ${gatewayId} with ${servers.length} server(s) for client ${clientId}`);
			} else {
				this._logger.warn(`[McpGatewayService] Created gateway ${gatewayId} with ${servers.length} server(s) without client tracking`);
			}

			// Listen for server changes to dynamically add/remove routes
			const onDidChangeServers = disposables.add(new Emitter<readonly IMcpGatewayServerInfo[]>());
			disposables.add(toolInvoker.onDidChangeServers(newDescriptors => {
				this._refreshGatewayServers(gatewayId, newDescriptors, toolInvoker, routeIds, serverRouteMap, onDidChangeServers);
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
	 * server info, capabilities, cache hints and instructions.
	 */
	async createRoute(label: string, invoker: IMcpGatewaySingleServerInvoker, dispatcherOptions?: IMcpGatewayDispatcherOptions): Promise<IMcpGatewayRouteHandle> {
		await this._ensureServer();
		if (this._port === undefined) {
			throw new Error('[McpGatewayService] Server failed to start, port is undefined');
		}
		const routeId = generateUuid();
		const route = new McpGatewayRoute(routeId, this._logger, invoker, this._sealedState, label, dispatcherOptions);
		this._routes.set(routeId, route);
		const store = new DisposableStore();
		this._routeDisposables.set(routeId, store);
		this._serveOverGrpc(route, invoker, store);
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

	private _refreshGatewayServers(
		gatewayId: string,
		newDescriptors: readonly IMcpGatewayServerDescriptor[],
		toolInvoker: IMcpGatewayToolInvoker,
		routeIds: Set<string>,
		serverRouteMap: Map<string, string>,
		onDidChangeServers: Emitter<readonly IMcpGatewayServerInfo[]>,
	): void {
		// Bail out if the gateway has been disposed
		if (!this._gatewayRoutes.has(gatewayId)) {
			return;
		}

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

		// Add routes for new servers, and update labels for existing ones.
		for (const descriptor of newDescriptors) {
			if (!existingServerIds.has(descriptor.id)) {
				this._createRouteForServer(gatewayId, descriptor.id, descriptor.label, toolInvoker, routeIds, serverRouteMap);
				continue;
			}

			const routeId = serverRouteMap.get(descriptor.id);
			const route = routeId ? this._routes.get(routeId) : undefined;
			if (route && route.label !== descriptor.label) {
				route.label = descriptor.label;
			}
		}

		const updatedServers = this._getGatewayServers(gatewayId);
		this._logger.info(`[McpGatewayService] Gateway ${gatewayId} servers changed: ${updatedServers.length} server(s)`);
		onDidChangeServers.fire(updatedServers);
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
	): IMcpGatewayServerInfo {
		const routeId = generateUuid();
		const store = new DisposableStore();
		const singleServerInvoker = this._createSingleServerInvoker(serverId, toolInvoker, store);

		const route = new McpGatewayRoute(routeId, this._logger, singleServerInvoker, this._sealedState, label);
		this._routes.set(routeId, route);
		this._routeDisposables.set(routeId, store);
		this._serveOverGrpc(route, singleServerInvoker, store);
		routeIds.add(routeId);
		serverRouteMap.set(serverId, routeId);

		const info = this._serverInfoOf(label, routeId);
		this._logger.info(`[McpGatewayService] Created route ${routeId} for server '${label}' (${serverId}) at ${info.address}${info.grpcAddress ? ` and ${info.grpcAddress}` : ''}`);

		return info;
	}

	/** Serves the route on the gRPC listener (when there is one) until `store` is disposed. */
	private _serveOverGrpc(route: McpGatewayRoute, invoker: IMcpGatewaySingleServerInvoker, store: DisposableStore): void {
		if (this._grpcListener) {
			store.add(this._grpcListener.addRoute(route.routeId, route.dispatcher, invoker));
		}
	}

	private _serverInfoOf(label: string, routeId: string): IMcpGatewayServerInfo {
		const address = this._addressOf(routeId);
		const grpcAddress = this._grpcAddressOf(routeId);
		return grpcAddress ? { label, address, grpcAddress } : { label, address };
	}

	/**
	 * `grpc://127.0.0.1:<port>/<routeId>`: the authority is the channel's
	 * target and the path names the route, which a call sends as the
	 * `mcp-gateway-route` metadata.
	 */
	private _grpcAddressOf(routeId: string): URI | undefined {
		const port = this._grpcListener?.port;
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

	private async _ensureServer(): Promise<void> {
		// If server is already starting, wait for it (the HTTP port listens before the gRPC listener does)
		if (this._serverStartPromise) {
			return this._serverStartPromise;
		}

		if (this._server?.listening) {
			return;
		}

		this._serverStartPromise = this._startServer();
		try {
			await this._serverStartPromise;
		} finally {
			this._serverStartPromise = undefined;
		}
	}

	private async _startServer(): Promise<void> {
		const { createServer } = await import('http'); // Lazy due to https://github.com/nodejs/node/issues/59686
		const deferredPromise = new DeferredPromise<void>();

		const server = createServer((req, res) => {
			this._handleRequest(req, res);
		});
		this._server = server;

		const portTimeout = setTimeout(() => {
			deferredPromise.error(new Error('[McpGatewayService] Timeout waiting for server to start'));
		}, 5000);

		server.on('listening', () => {
			const address = server.address();
			if (typeof address === 'string') {
				this._port = parseInt(address);
			} else if (address instanceof Object) {
				this._port = address.port;
			} else {
				clearTimeout(portTimeout);
				deferredPromise.error(new Error('[McpGatewayService] Unable to determine port'));
				return;
			}

			clearTimeout(portTimeout);
			this._logger.info(`[McpGatewayService] Server started on port ${this._port}`);
			deferredPromise.complete();
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

		await deferredPromise.p;
		if (this._grpc) {
			await this._startGrpcListener();
		}
	}

	/** The gRPC listener next to the HTTP port; the gateway keeps serving HTTP when it cannot start. */
	private async _startGrpcListener(): Promise<void> {
		const listener = new McpGatewayGrpcListener(this._logger);
		listener.registerTunnelService();
		listener.registerTypedService();
		try {
			const port = await listener.listen();
			if (this._store.isDisposed || !this._server) {
				// Stopped while the listener started.
				listener.dispose();
				return;
			}
			this._grpcListener = listener;
			this._logger.info(`[McpGatewayService] gRPC listener started on ${listener.addresses.join(', ')} (port ${port})`);
		} catch (error) {
			this._logger.error(`[McpGatewayService] Could not start the gRPC listener: ${error}`);
			listener.dispose();
		}
	}

	private _stopServer(): void {
		const server = this._server;
		if (!server) {
			return;
		}

		this._logger.info('[McpGatewayService] Stopping server (no more routes)');

		// End the long-lived streams first: listen streams get their graceful result, sessions their end.
		for (const route of this._routes.values()) {
			route.closeAllConnections();
		}
		// gRPC: graceful listen results, then GOAWAY to every connection.
		this._grpcListener?.dispose();
		this._grpcListener = undefined;
		server.close(err => {
			if (err) {
				this._logger.error(`[McpGatewayService] Error closing server: ${err}`);
			} else {
				this._logger.info('[McpGatewayService] Server stopped');
			}
		});
		server.closeAllConnections();

		this._server = undefined;
		this._port = undefined;
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
		for (const routeId of [...this._routes.keys()]) {
			this._disposeRoute(routeId);
		}
		this._routes.clear();
		this._gatewayRoutes.clear();
		this._gatewayServerRoutes.clear();
		this._gatewayToClient.clear();
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
 * `services.set(IMcpGatewayService, mcpGatewayServiceDescriptor({ allowedHosts: [...] }))`.
 * `new SyncDescriptor(McpGatewayService)` keeps the default, loopback-only gateway.
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
