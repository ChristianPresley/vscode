/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMcpGatewayCreateArgs, IMcpGatewayCreateOptions, IMcpGatewayServerInfo } from '../../../../platform/mcp/common/mcpGateway.js';

export const IWorkbenchMcpGatewayService = createDecorator<IWorkbenchMcpGatewayService>('IWorkbenchMcpGatewayService');

/**
 * A single server entry exposed by the gateway at the workbench layer.
 */
export interface IMcpGatewayResultServer {
	readonly label: string;
	readonly address: URI;
	/**
	 * The gRPC endpoint of the same server, only for a gateway created with
	 * `{ grpc: true }`: `grpc://127.0.0.1:<port>/<routeId>`. Clients connect
	 * to the authority and must send the route id (the path without its
	 * slash) as the `mcp-gateway-route` metadata on every call (else NOT_FOUND).
	 */
	readonly grpcAddress?: URI;
}

/**
 * The servers of a gateway as they arrive over IPC from the main process or
 * the remote server (URIs as plain components): `grpcAddress` only when the
 * gateway serves gRPC.
 */
export function reviveMcpGatewayServers(servers: readonly IMcpGatewayServerInfo[]): IMcpGatewayResultServer[] {
	return servers.map(s => s.grpcAddress
		? { label: s.label, address: URI.revive(s.address), grpcAddress: URI.revive(s.grpcAddress) }
		: { label: s.label, address: URI.revive(s.address) });
}

/**
 * The argument of the `createGateway` IPC call (to the main process or the
 * remote server): `undefined` without a chat session and without gRPC, and
 * `grpc` only when the caller asked for it (`true`).
 */
export function mcpGatewayCreateArgs(chatSessionResource: URI | undefined, options: IMcpGatewayCreateOptions | undefined): IMcpGatewayCreateArgs | undefined {
	const grpc = options?.grpc === true;
	if (!chatSessionResource && !grpc) {
		return undefined;
	}
	return {
		...(chatSessionResource ? { chatSessionResource: chatSessionResource.toString() } : {}),
		...(grpc ? { grpc } : {}),
	};
}

/**
 * Result of creating an MCP gateway, which is itself disposable.
 */
export interface IMcpGatewayResult extends IDisposable {
	/**
	 * The servers currently exposed by this gateway.
	 */
	readonly servers: readonly IMcpGatewayResultServer[];

	/**
	 * Event that fires when the set of servers changes.
	 */
	readonly onDidChangeServers: Event<readonly IMcpGatewayResultServer[]>;
}

/**
 * Service that manages MCP gateway HTTP endpoints in the workbench.
 *
 * The gateway provides an HTTP server that external processes can connect
 * to in order to interact with MCP servers known to the editor. The server
 * is shared among all gateways and is automatically torn down when the
 * last gateway is disposed.
 */
export interface IWorkbenchMcpGatewayService {
	readonly _serviceBrand: undefined;

	/**
	 * Creates a new MCP gateway endpoint.
	 *
	 * The gateway is assigned a secure random route ID to make the endpoint
	 * URL unguessable without authentication.
	 *
	 * @param inRemote Whether to create the gateway in the remote environment.
	 * If true, the gateway is created on the remote server (requires a remote connection).
	 * If false, the gateway is created locally (requires a local Node process, e.g., desktop).
	 * @param chatSessionResource Optional chat session resource URI to associate with this
	 * gateway. When provided, MCP tool calls made through this gateway will be associated
	 * with the chat session, enabling inline elicitation UI instead of notification fallback.
	 * @param options `grpc: true` also serves the gateway's servers over gRPC
	 * (they then carry `grpcAddress`; see {@link IMcpGatewayCreateOptions.grpc}).
	 * Without it the gateway opens no gRPC port.
	 * @returns A promise that resolves to the gateway result if successful,
	 * or `undefined` if the requested environment is not available.
	 */
	createGateway(inRemote: boolean, chatSessionResource?: URI, options?: IMcpGatewayCreateOptions): Promise<IMcpGatewayResult | undefined>;
}
