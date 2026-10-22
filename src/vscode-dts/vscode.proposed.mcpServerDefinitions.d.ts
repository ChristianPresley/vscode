/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// https://github.com/microsoft/vscode/issues/288777 @DonJayamanne

	/**
	 * Represents a single MCP server exposed by the gateway via its own HTTP endpoint.
	 */
	export interface McpGatewayServer {
		/**
		 * The human-readable label of the MCP server.
		 */
		readonly label: string;

		/**
		 * The address of the HTTP MCP server endpoint.
		 * External processes can connect to this URI to interact with this MCP server.
		 */
		readonly address: Uri;

		/**
		 * The gRPC endpoint of the same MCP server:
		 * `grpc://127.0.0.1:<port>/<routeId>`. It is set only for gateways
		 * started with `{ grpc: true }` (see {@link McpGatewayStartOptions.grpc});
		 * the servers of other gateways have none.
		 *
		 * A gRPC client connects to the authority with cleartext HTTP/2 and
		 * calls either the JSON-RPC tunnel `mcp.zig.transport.v1.Mcp/Call` or
		 * the typed service `model_context_protocol.Mcp`. Every call must send
		 * the path without its leading slash as the `mcp-gateway-route`
		 * metadata; a call without it, or with an unknown route, fails with
		 * `NOT_FOUND`. The port is shared by all gateways started with
		 * `{ grpc: true }`, so, as with the route in {@link address}, the route
		 * id is what keeps other local processes away from this server.
		 */
		readonly grpcAddress?: Uri;
	}

	/**
	 * Options for {@link lm.startMcpGateway}.
	 */
	export interface McpGatewayStartOptions {
		/**
		 * Also serve this gateway over gRPC (loopback, cleartext h2c; the tunnel
		 * and the typed service). Its servers then carry
		 * {@link McpGatewayServer.grpcAddress `grpcAddress`}.
		 *
		 * Without it, the gateway is served over HTTP only and opens no gRPC
		 * port. If the gRPC listener cannot be opened, the gateway still starts,
		 * served over HTTP only: its servers have no `grpcAddress`.
		 */
		readonly grpc?: boolean;
	}

	/**
	 * Represents an MCP gateway that exposes MCP servers via HTTP.
	 * Each known MCP server gets its own HTTP endpoint. The gateway
	 * dynamically tracks server additions and removals.
	 */
	export interface McpGateway extends Disposable {
		/**
		 * The MCP servers currently exposed by the gateway.
		 * Each server has its own HTTP endpoint address.
		 */
		readonly servers: readonly McpGatewayServer[];

		/**
		 * Event that fires when the set of gateway servers changes.
		 * This can be due to MCP servers being added, removed, or restarted.
		 */
		readonly onDidChangeServers: Event<readonly McpGatewayServer[]>;
	}

	/**
	 * Namespace for language model related functionality.
	 */
	export namespace lm {
		/**
		 * All MCP server definitions known to the editor. This includes
		 * servers defined in user and workspace mcp.json files as well as those
		 * provided by extensions.
		 *
		 * Consumers should listen to {@link onDidChangeMcpServerDefinitions} and
		 * re-read this property when it fires.
		 */
		export const mcpServerDefinitions: readonly McpServerDefinition[];

		/**
		 * Event that fires when the set of MCP server definitions changes.
		 * This can be due to additions, deletions, or modifications of server
		 * definitions from any source.
		 */
		export const onDidChangeMcpServerDefinitions: Event<void>;

		/**
		 * Starts an MCP gateway that exposes MCP servers via HTTP endpoints.
		 *
		 * The gateway creates a localhost HTTP server where each MCP server known
		 * to the editor gets its own endpoint. External processes (such as CLI-based
		 * agent loops) can connect to these endpoints to interact with individual
		 * MCP servers.
		 *
		 * The HTTP server is shared among all gateways and is automatically torn down
		 * when the last gateway is disposed. Likewise, the gRPC listener opens only for
		 * gateways started with `{ grpc: true }` and is shared among them; it is open
		 * only while one of them has a server, so it closes when the last such server
		 * goes away (its gateway disposed, or the server removed) and opens again,
		 * possibly on another port, for the next one. Read
		 * {@link McpGatewayServer.grpcAddress `grpcAddress`} from the current
		 * {@link McpGateway.servers servers} rather than keeping it. The gateway
		 * dynamically tracks server additions and removals via
		 * {@link McpGateway.onDidChangeServers}.
		 *
		 * @param chatSessionResource Optional chat session resource URI to associate with this
		 * gateway. When provided, MCP tool calls made through this gateway will be associated
		 * with the chat session, enabling inline elicitation UI in the chat response.
		 * @param options Optional {@link McpGatewayStartOptions}, for instance `{ grpc: true }`
		 * to also serve the gateway over gRPC.
		 * @returns A promise that resolves to an {@link McpGateway} if successful,
		 * or `undefined` if no Node process is available (e.g., in serverless web environments).
		 */
		export function startMcpGateway(chatSessionResource?: Uri, options?: McpGatewayStartOptions): Thenable<McpGateway | undefined>;
	}
}
