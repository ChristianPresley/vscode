/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { GrpcStatus, encodeBinaryMetadata, grpcStatusForJsonRpcCode } from '../../../base/common/grpc/status.js';
import { IJsonRpcRequest, JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ProtoCodecError, decodeMessage, encodeMessage } from '../../../base/common/protobuf/codec.js';
import { decodeUtf8, encodeUtf8 } from '../../../base/common/protobuf/wire.js';
import { GrpcServer, GrpcServerLogLevel, IGrpcServerCall, IGrpcServerOptions } from '../../../base/node/grpcServer.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { applyModernEnvelope, errorResponse, IModernRequestMeta, isLoopbackHost, McpGatewayRpcError, validateModernRequestMeta, validateSubscriptionFilter } from '../common/mcpGatewayProtocol.js';
import { ITypedRpc, JSON_RPC_MESSAGE, MAX_ERROR_BIN_BYTES, MCP_ERROR_BIN_TRAILER, MCP_ERROR_CODE_TRAILER, MCP_PROTOCOL_VERSION_METADATA, TUNNEL_CALL_PATH, TYPED_RPCS } from '../common/mcpGrpcProto.js';
import { decodeTypedRequest, encodeTypedResponse, McpUnexpressibleError, routingMetadataFor } from '../common/mcpGrpcTyped.js';
import { MCP_METHOD_HEADER } from '../common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, MODERN_MCP_PROTOCOL_VERSIONS } from '../common/mcpProtocolVersions.js';
import { MCP } from '../common/modelContextProtocol.js';
import { IMcpGatewayDispatchContext, IMcpGatewayNotification, McpGatewayDispatcher } from './mcpGatewayDispatcher.js';
import { IMcpGatewayListenStream, McpGatewayListenRegistry } from './mcpGatewayListenRegistry.js';
import { notificationMessage } from './mcpGatewaySession.js';

/**
 * The MCP gateway as a gRPC server: one loopback listener next to the HTTP
 * port that serves both gRPC bindings of MCP on the dispatcher of each
 * route, so a request means the same over HTTP and gRPC (the sealed
 * `requestState` of an input round, for instance, is bound to the route on
 * both).
 *
 * - The JSON-RPC tunnel `mcp.zig.transport.v1.Mcp/Call`: one call carries one
 *   JSON-RPC message; the response stream carries the request's
 *   notifications, then its response. `subscriptions/listen` is one
 *   long-lived call.
 * - The typed service `model_context_protocol.Mcp` (eight unary RPCs).
 *
 * A call names its route with the {@link GRPC_ROUTE_METADATA_KEY} metadata;
 * a call without it goes to the only route when there is exactly one, so
 * unmodified clients (the zig-sdk example client, grpc-js) can connect to a
 * single-server gateway. The base server ({@link GrpcServer}) checks the
 * method, content type, path, encoding, `:authority` (loopback only) and
 * `grpc-timeout` first; then the route is looked up (NOT_FOUND) before the
 * dispatcher sees anything. Errors found before a request runs end the call
 * with headers only: `grpc-status` from the JSON-RPC code, `grpc-message`,
 * `mcp-error-code` and (up to 4096 bytes) `mcp-error-bin`. On the tunnel, an
 * error of a request that ran is an ordinary JSON-RPC error response with
 * status 0, as in the zig-sdk; the typed binding has no place for it but the
 * trailers.
 */

/** The request metadata that names the gateway route of a call. */
export const GRPC_ROUTE_METADATA_KEY = 'mcp-gateway-route';

export interface IMcpGatewayGrpcListenerOptions {
	/** Overrides of the transport limits (tests use small ones). */
	readonly server?: Omit<IGrpcServerOptions, 'isAllowedAuthority' | 'log'>;
}

interface IGrpcRoute {
	readonly routeId: string;
	readonly dispatcher: McpGatewayDispatcher;
	/** The `subscriptions/listen` streams of the route's tunnel calls. */
	readonly listen: McpGatewayListenRegistry;
}

type GrpcBinding = 'tunnel' | 'typed';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequest(message: unknown): message is IJsonRpcRequest {
	return isObject(message) && typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number');
}

function isNotification(message: unknown): boolean {
	return isObject(message) && typeof message.method === 'string' && message.id === undefined;
}

function isResponse(message: unknown): boolean {
	return isObject(message) && message.method === undefined && (message.result !== undefined || isObject(message.error));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A `:authority` of the local machine (`127.0.0.1` or another 127.0.0.0/8 address, `[::1]`, `localhost`; with or without a port), as the HTTP gateway's Host check. */
export function isLoopbackAuthority(authority: string | undefined): boolean {
	return isLoopbackHost(authority);
}

function encodeTunnelMessage(message: object): Uint8Array {
	return encodeMessage(JSON_RPC_MESSAGE, { jsonrpc: encodeUtf8(JSON.stringify(message)) });
}

function decodeTunnelMessage(payload: Uint8Array): string {
	const message = decodeMessage(JSON_RPC_MESSAGE, payload);
	const bytes = message.jsonrpc;
	return bytes instanceof Uint8Array ? decodeUtf8(bytes) : '';
}

/**
 * The typed binding has no task methods (and the `Tool` message no
 * `execution` field): a typed client sees the tools as plain tools, as a
 * 2025-11-25 client does.
 */
function withoutTaskExecution(rpc: ITypedRpc, result: object): object {
	const tools = rpc.name === 'ListTools' ? (result as { tools?: unknown }).tools : undefined;
	if (!Array.isArray(tools) || !tools.some(tool => isObject(tool) && tool.execution !== undefined)) {
		return result;
	}
	return {
		...result,
		tools: tools.map(tool => {
			if (!isObject(tool) || tool.execution === undefined) {
				return tool;
			}
			const { execution: _execution, ...rest } = tool;
			return rest;
		}),
	};
}

/**
 * The headers-only end of a call for a JSON-RPC error: the status from the
 * code (UNKNOWN on the tunnel, INTERNAL on the typed binding for codes
 * without a mapping), the message, `mcp-error-code`, and the error response
 * in `mcp-error-bin` when its unpadded base64 has at most
 * {@link MAX_ERROR_BIN_BYTES} bytes.
 */
export function endWithRpcError(call: IGrpcServerCall, binding: GrpcBinding, error: McpGatewayRpcError, id: JsonRpcId | null): void {
	const trailers: Record<string, string> = { [MCP_ERROR_CODE_TRAILER]: String(error.code) };
	const bin = encodeBinaryMetadata(VSBuffer.fromString(JSON.stringify(errorResponse(id, error.code, error.message, error.data))).buffer);
	if (bin.length <= MAX_ERROR_BIN_BYTES) {
		trailers[MCP_ERROR_BIN_TRAILER] = bin;
	}
	call.end(grpcStatusForJsonRpcCode(error.code, binding), error.message, trailers);
}

export class McpGatewayGrpcListener extends Disposable {
	private readonly _server: GrpcServer;
	private readonly _routes = new Map<string, IGrpcRoute>();
	private _nextTypedId = 1;
	private _warnedDestructiveHint = false;

	constructor(
		private readonly _logger: ILogger,
		options: IMcpGatewayGrpcListenerOptions = {},
	) {
		super();
		this._server = this._register(new GrpcServer({
			...options.server,
			isAllowedAuthority: isLoopbackAuthority,
			log: (level, message) => this._log(level, message),
		}));
	}

	/** The port of the listener, once {@link listen} resolved. */
	get port(): number | undefined {
		return this._server.port;
	}

	/** The `host:port` addresses the listener is bound to. */
	get addresses(): readonly string[] {
		return this._server.addresses;
	}

	get routeCount(): number {
		return this._routes.size;
	}

	/**
	 * Serves the JSON-RPC tunnel `mcp.zig.transport.v1.Mcp/Call` until the
	 * result or the listener is disposed.
	 */
	registerTunnelService(): IDisposable {
		return this._register(this._server.addService(TUNNEL_CALL_PATH, call => this._handleTunnel(call)));
	}

	/**
	 * Serves the eight unary RPCs of `model_context_protocol.Mcp` until the
	 * result or the listener is disposed.
	 */
	registerTypedService(): IDisposable {
		const store = this._register(new DisposableStore());
		for (const rpc of TYPED_RPCS) {
			store.add(this._server.addService(rpc.path, call => this._handleTyped(call, rpc)));
		}
		return store;
	}

	/**
	 * Serves a gateway route on the listener. Disposing the result closes its
	 * listen streams gracefully (their final result, then status 0) and
	 * removes the route; its later calls get NOT_FOUND.
	 */
	addRoute(routeId: string, dispatcher: McpGatewayDispatcher, invoker: IMcpGatewaySingleServerInvoker): IDisposable {
		if (this._routes.has(routeId)) {
			throw new Error(`The gRPC listener already serves route ${routeId}`);
		}
		const listen = new McpGatewayListenRegistry(dispatcher, invoker, this._logger);
		const route: IGrpcRoute = { routeId, dispatcher, listen };
		this._routes.set(routeId, route);
		return toDisposable(() => {
			if (this._routes.get(routeId) === route) {
				this._routes.delete(routeId);
			}
			listen.dispose();
		});
	}

	/** Listens on `127.0.0.1` (and `[::1]` when available); resolves with the port. */
	listen(port: number = 0, host: string = '127.0.0.1'): Promise<number> {
		return this._server.listen(port, host);
	}

	/** Ends the listen streams gracefully, then sends GOAWAY and stops listening. */
	async close(): Promise<void> {
		for (const route of this._routes.values()) {
			route.listen.closeAll();
		}
		await this._server.close();
	}

	override dispose(): void {
		for (const route of this._routes.values()) {
			route.listen.dispose();
		}
		this._routes.clear();
		super.dispose();
	}

	private _log(level: GrpcServerLogLevel, message: string): void {
		const text = `[McpGateway][gRPC] ${message}`;
		switch (level) {
			case 'trace': this._logger.trace(text); break;
			case 'debug': this._logger.debug(text); break;
			case 'info': this._logger.info(text); break;
			case 'warn': this._logger.warn(text); break;
			case 'error': this._logger.error(text); break;
		}
	}

	/** The route of a call, or undefined after ending the call with NOT_FOUND. */
	private _resolveRoute(call: IGrpcServerCall): IGrpcRoute | undefined {
		const requested = call.metadata[GRPC_ROUTE_METADATA_KEY]?.trim();
		if (requested) {
			const route = this._routes.get(requested);
			if (!route) {
				this._logger.warn(`[McpGateway][gRPC] ${call.path}: unknown route ${requested}`);
				call.end(GrpcStatus.NOT_FOUND, `Unknown gateway route '${requested}'`);
			}
			return route;
		}
		if (this._routes.size === 1) {
			return this._routes.values().next().value;
		}
		call.end(GrpcStatus.NOT_FOUND, this._routes.size === 0
			? 'The gateway serves no routes'
			: `The gateway serves ${this._routes.size} routes: name one with the '${GRPC_ROUTE_METADATA_KEY}' metadata`);
		return undefined;
	}

	private _dispatchContext(call: IGrpcServerCall, request: IJsonRpcRequest, meta: IModernRequestMeta, notify: (notification: IMcpGatewayNotification) => void): IMcpGatewayDispatchContext {
		return {
			era: 'modern',
			protocolVersion: meta.protocolVersion,
			requestId: request.id,
			clientCapabilities: meta.clientCapabilities,
			clientInfo: meta.clientInfo,
			logLevel: meta.logLevel,
			progressToken: meta.progressToken,
			headers: call.metadata,
			token: call.token,
			notify,
		};
	}

	// ---- tunnel -------------------------------------------------------------------

	private async _handleTunnel(call: IGrpcServerCall): Promise<void> {
		const route = this._resolveRoute(call);
		if (!route) {
			return;
		}
		const payload = await call.readRequest();
		if (!payload) {
			return;
		}
		let text: string;
		try {
			text = decodeTunnelMessage(payload);
		} catch (error) {
			call.end(GrpcStatus.INVALID_ARGUMENT, `The message is not a JsonRpcMessage: ${errorText(error)}`);
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch {
			endWithRpcError(call, 'tunnel', new McpGatewayRpcError(MCP.PARSE_ERROR, 'Parse error'), null);
			return;
		}
		if (Array.isArray(message)) {
			endWithRpcError(call, 'tunnel', new McpGatewayRpcError(MCP.INVALID_REQUEST, 'Batches are not accepted'), null);
			return;
		}
		if (isResponse(message)) {
			endWithRpcError(call, 'tunnel', new McpGatewayRpcError(MCP.INVALID_REQUEST, 'Clients do not send responses on this transport'), null);
			return;
		}
		if (isNotification(message)) {
			// Accepted and dropped, as on Streamable HTTP; a gRPC client cancels with RST_STREAM.
			this._logger.debug(`[McpGateway][gRPC][route ${route.routeId}] <-- notification ${(message as { method: string }).method}`);
			call.end(GrpcStatus.OK);
			return;
		}
		if (!isRequest(message)) {
			endWithRpcError(call, 'tunnel', new McpGatewayRpcError(MCP.INVALID_REQUEST, 'Invalid Request'), null);
			return;
		}
		const request = message;
		if (request.method === 'initialize') {
			// The gRPC bindings speak 2026-07-28 only; a 2025-11-25 client learns which version to use.
			const requested = isObject(request.params) && typeof request.params.protocolVersion === 'string' ? request.params.protocolVersion : 'unknown';
			endWithRpcError(call, 'tunnel', new McpGatewayRpcError(MCP.UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version '${requested}': the gRPC binding speaks ${MODERN_MCP_PROTOCOL_VERSIONS.join(', ')}`, { supported: [...MODERN_MCP_PROTOCOL_VERSIONS], requested }), request.id);
			return;
		}
		const prepared = await route.dispatcher.prepareModernRequest(call.metadata, request);
		if (call.isEnded) {
			return;
		}
		if (!prepared.ok) {
			this._logger.debug(`[McpGateway][gRPC][route ${route.routeId}] Rejected ${request.method}: ${prepared.error.code} ${prepared.error.message}`);
			endWithRpcError(call, 'tunnel', prepared.error, request.id);
			return;
		}
		const params = isObject(request.params) ? request.params : {};
		if (request.method === 'subscriptions/listen') {
			this._openListenStream(call, route, request, params);
			return;
		}
		if (!route.dispatcher.supportsMethod(request.method, 'modern')) {
			endWithRpcError(call, 'tunnel', new McpGatewayRpcError(MCP.METHOD_NOT_FOUND, `Method not found: ${request.method}`), request.id);
			return;
		}

		const context = this._dispatchContext(call, request, prepared.meta, notification => {
			call.sendMessage(encodeTunnelMessage(notificationMessage(notification)));
		});
		let response: object;
		try {
			const result = await route.dispatcher.dispatch(context, request.method, params);
			response = { jsonrpc: '2.0', id: request.id, result };
		} catch (error) {
			if (call.isEnded) {
				return;
			}
			if (!(error instanceof McpGatewayRpcError)) {
				this._logger.error(`[McpGateway][gRPC][route ${route.routeId}] ${request.method} failed`, error);
			}
			const rpcError = error instanceof McpGatewayRpcError ? error : new McpGatewayRpcError(MCP.INTERNAL_ERROR, errorText(error));
			response = errorResponse(request.id, rpcError.code, rpcError.message, rpcError.data);
		}
		if (call.isEnded) {
			// Cancelled (RST_STREAM, deadline): the base server has ended the call.
			return;
		}
		if (call.sendMessage(encodeTunnelMessage(response))) {
			call.end(GrpcStatus.OK);
		}
	}

	/** A `subscriptions/listen` call: the acknowledgement and the events are messages; the graceful result ends it with status 0. */
	private _openListenStream(call: IGrpcServerCall, route: IGrpcRoute, request: IJsonRpcRequest, params: Record<string, unknown>): void {
		const filterError = validateSubscriptionFilter(params.notifications);
		if (filterError) {
			endWithRpcError(call, 'tunnel', filterError, request.id);
			return;
		}
		const cancellation: { listener?: IDisposable } = {};
		const stream: IMcpGatewayListenStream = {
			notify: notification => {
				call.sendMessage(encodeTunnelMessage(notificationMessage(notification)));
			},
			complete: result => {
				cancellation.listener?.dispose();
				if (call.sendMessage(encodeTunnelMessage({ jsonrpc: '2.0', id: request.id, result: applyModernEnvelope('subscriptions/listen', result, route.dispatcher.serverInfo) }))) {
					call.end(GrpcStatus.OK);
				}
			},
		};
		let registration: IDisposable;
		try {
			registration = route.listen.register(request.id, params.notifications as MCP.SubscriptionFilter, stream);
		} catch (error) {
			const rpcError = error instanceof McpGatewayRpcError ? error : new McpGatewayRpcError(MCP.INTERNAL_ERROR, errorText(error));
			endWithRpcError(call, 'tunnel', rpcError, request.id);
			return;
		}
		if (call.isEnded) {
			registration.dispose();
			return;
		}
		this._logger.info(`[McpGateway][gRPC][route ${route.routeId}] Listen stream ${String(request.id)} opened`);
		// RST_STREAM (the client's way to end the stream) or a lost connection: no final result.
		cancellation.listener = call.token.onCancellationRequested(() => {
			cancellation.listener?.dispose();
			registration.dispose();
		});
	}

	// ---- typed --------------------------------------------------------------------

	private async _handleTyped(call: IGrpcServerCall, rpc: ITypedRpc): Promise<void> {
		const route = this._resolveRoute(call);
		if (!route) {
			return;
		}
		const payload = await call.readRequest();
		if (!payload) {
			return;
		}
		const fail = (code: number, message: string, data?: unknown) => endWithRpcError(call, 'typed', new McpGatewayRpcError(code, message, data), null);

		let params: Record<string, unknown>;
		try {
			params = decodeTypedRequest(rpc, payload);
		} catch (error) {
			if (error instanceof McpUnexpressibleError || error instanceof ProtoCodecError) {
				fail(MCP.INVALID_PARAMS, errorText(error));
			} else {
				fail(MCP.PARSE_ERROR, `The message is not a valid ${rpc.request.name}: ${errorText(error)}`);
			}
			return;
		}

		// The routing metadata is optional; when present it must agree with the message, as Mcp-Name does.
		const routingKey = rpc.routingKey;
		const routed = routingKey === undefined ? undefined : call.metadata[routingKey];
		if (routingKey !== undefined && routed !== undefined) {
			const expected = routingMetadataFor(rpc, params)[routingKey];
			if (expected === undefined || routed !== expected) {
				fail(MCP.HEADER_MISMATCH, `Header mismatch: ${routingKey} value '${routed}' does not match the message value '${expected ?? ''}'`);
				return;
			}
		}

		// Typed clients do not always send the `_meta` keys the gateway needs.
		const meta = isObject(params._meta) ? params._meta : {};
		params._meta = meta;
		const headerVersion = call.metadata[MCP_PROTOCOL_VERSION_METADATA]?.trim();
		const bodyVersion = meta[META_PROTOCOL_VERSION];
		if (bodyVersion === undefined) {
			meta[META_PROTOCOL_VERSION] = headerVersion || LATEST_MCP_PROTOCOL_VERSION;
		} else if (headerVersion !== undefined && headerVersion !== bodyVersion) {
			fail(MCP.HEADER_MISMATCH, `Header mismatch: ${MCP_PROTOCOL_VERSION_METADATA} value '${headerVersion}' does not match the _meta value '${String(bodyVersion)}'`);
			return;
		}
		if (meta[META_CLIENT_CAPABILITIES] === undefined) {
			meta[META_CLIENT_CAPABILITIES] = {};
		}

		const request: IJsonRpcRequest = { jsonrpc: '2.0', id: this._nextTypedId++, method: rpc.jsonRpcMethod, params };
		// A client that mirrors the HTTP headers (VS Code's own) has them verified; others send only the routing metadata.
		const prepared = call.metadata[MCP_METHOD_HEADER.toLowerCase()] !== undefined
			? await route.dispatcher.prepareModernRequest(call.metadata, request)
			: validateModernRequestMeta(request);
		if (call.isEnded) {
			return;
		}
		if (!prepared.ok) {
			this._logger.debug(`[McpGateway][gRPC][route ${route.routeId}] Rejected ${rpc.name}: ${prepared.error.code} ${prepared.error.message}`);
			endWithRpcError(call, 'typed', prepared.error, null);
			return;
		}
		if (!route.dispatcher.supportsMethod(rpc.jsonRpcMethod, 'modern')) {
			fail(MCP.METHOD_NOT_FOUND, `Method not found: ${rpc.jsonRpcMethod}`);
			return;
		}

		// A unary response has no place for the request's notifications (progress, logs).
		const context = this._dispatchContext(call, request, prepared.meta, () => { });
		let result: object;
		try {
			result = await route.dispatcher.dispatch(context, rpc.jsonRpcMethod, params);
		} catch (error) {
			if (call.isEnded) {
				return;
			}
			if (!(error instanceof McpGatewayRpcError)) {
				this._logger.error(`[McpGateway][gRPC][route ${route.routeId}] ${rpc.name} failed`, error);
			}
			endWithRpcError(call, 'typed', error instanceof McpGatewayRpcError ? error : new McpGatewayRpcError(MCP.INTERNAL_ERROR, errorText(error)), null);
			return;
		}
		if (call.isEnded) {
			return;
		}
		result = withoutTaskExecution(rpc, result);
		this._noteInexpressibleHints(rpc, result);
		let bytes: Uint8Array;
		try {
			bytes = encodeTypedResponse(rpc, result);
		} catch (error) {
			this._logger.warn(`[McpGateway][gRPC][route ${route.routeId}] The typed binding cannot express the ${rpc.jsonRpcMethod} result: ${errorText(error)}`);
			fail(MCP.INTERNAL_ERROR, errorText(error));
			return;
		}
		if (call.sendMessage(bytes)) {
			call.end(GrpcStatus.OK);
		}
	}

	/**
	 * Proto3 cannot tell `false` from an absent bool: `destructiveHint: false`
	 * reaches a typed client as an absent hint, which MCP reads as `true`.
	 * Logged once per listener.
	 */
	private _noteInexpressibleHints(rpc: ITypedRpc, result: object): void {
		if (this._warnedDestructiveHint || rpc.name !== 'ListTools') {
			return;
		}
		const tools = (result as { tools?: unknown }).tools;
		if (!Array.isArray(tools)) {
			return;
		}
		const tool = tools.find(t => isObject(t) && isObject(t.annotations) && t.annotations.destructiveHint === false);
		if (tool) {
			this._warnedDestructiveHint = true;
			this._logger.warn(`[McpGateway][gRPC] The typed binding cannot express destructiveHint: false (tool '${String((tool as { name?: unknown }).name)}' and possibly others): typed clients read the hint as true`);
		}
	}
}
