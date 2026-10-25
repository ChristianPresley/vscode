/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'vscode' {

	// MCP servers reached over gRPC. Gated by the `mcpGrpcServerDefinition` API proposal.

	/**
	 * The gRPC service binding of a {@link McpGrpcServerDefinition}.
	 */
	export enum McpGrpcBinding {
		/**
		 * The JSON-RPC tunnel. The editor never switches to Google's typed service
		 * on its own; use {@link McpGrpcBinding.Typed Typed} for servers that only
		 * offer it. A server without the tunnel fails to start with an error that
		 * says so.
		 */
		Auto = 1,
		/**
		 * Send JSON-RPC messages through the zig-sdk tunnel service,
		 * `/mcp.zig.transport.v1.Mcp/Call`.
		 */
		Tunnel = 2,
		/**
		 * Call the methods of Google's typed `model_context_protocol.Mcp` service,
		 * for servers that do not offer the tunnel. The typed service carries no
		 * subscriptions, notifications, pagination beyond the first page or tasks.
		 */
		Typed = 3,
		/**
		 * Call the typed service for the methods it has, and send the rest through
		 * the tunnel on the same connection: discovery, subscriptions,
		 * notifications and extension methods such as the Skills extension's
		 * `skills/list`, `skills/get` and `resources/directory/read`. For servers
		 * that offer both services; with a server that has no tunnel it works as
		 * {@link McpGrpcBinding.Typed Typed}.
		 */
		TypedWithTunnel = 4,
	}

	/**
	 * McpGrpcServerDefinition represents an MCP server available over gRPC
	 * (HTTP/2). The editor connects to {@link McpHttpServerDefinition.uri},
	 * which must use the `grpc://` (plaintext) or `grpcs://` (TLS) scheme, and
	 * speaks the zig-sdk JSON-RPC tunnel service
	 * (`/mcp.zig.transport.v1.Mcp/Call`), or the typed
	 * `model_context_protocol.Mcp` service when {@link binding} is
	 * {@link McpGrpcBinding.Typed}.
	 *
	 * Because it extends {@link McpHttpServerDefinition}, instances can be
	 * returned from a {@link McpServerDefinitionProvider} wherever a
	 * {@link McpServerDefinition} is expected; the editor recognizes them by
	 * their class.
	 */
	export class McpGrpcServerDefinition extends McpHttpServerDefinition {
		/**
		 * TLS settings, only meaningful for `grpcs://` URIs.
		 */
		readonly tls?: {
			/**
			 * Path to a PEM-encoded certificate authority bundle that is trusted for
			 * the server certificate in addition to the certificate authorities that
			 * HTTPS requests use: the bundled roots and, when the
			 * `http.systemCertificates` setting is on, the operating system's
			 * certificate store.
			 */
			ca?: string;
			/**
			 * Skips verification of the server certificate. Only use this for local
			 * development.
			 */
			insecure?: boolean;
			/**
			 * The host name presented during the TLS handshake (SNI) and checked
			 * against the server certificate, when it differs from the host in the URI.
			 */
			serverName?: string;
		};

		/**
		 * The gRPC service binding the server implements. When unset,
		 * {@link McpGrpcBinding.Auto} is used, which is the JSON-RPC tunnel; only
		 * {@link McpGrpcBinding.Typed} calls the typed service.
		 */
		readonly binding?: McpGrpcBinding;

		/**
		 * The interval between HTTP/2 keep-alive pings in milliseconds, sent only
		 * while at least one call is open (an idle connection is not pinged, as
		 * gRPC clients do by default). gRPC servers allow one ping every 5 minutes
		 * by default and close the connection of a client that pings more often,
		 * so a value below 300000 is raised to it, and the interval is doubled for
		 * the next connection after a server answers with `too_many_pings`; `0`
		 * sends no pings at all. When unset, a ping is sent every 5 minutes and 10
		 * seconds only while a `subscriptions/listen` stream is open, so that a NAT
		 * or load balancer does not cut a stream that has no events for a while.
		 */
		keepAliveMs?: number;

		/**
		 * @param label The human-readable name of the server.
		 * @param uri The `grpc://` or `grpcs://` URI of the server.
		 * @param headers Optional additional metadata sent with every call to the server's authority.
		 * @param version Optional version identification for the server.
		 * @param tls Optional TLS settings for `grpcs://` URIs.
		 * @param binding Optional gRPC service binding; {@link McpGrpcBinding.Auto} when omitted.
		 */
		constructor(
			label: string,
			uri: Uri,
			headers?: Record<string, string>,
			version?: string,
			tls?: { ca?: string; insecure?: boolean; serverName?: string },
			binding?: McpGrpcBinding,
		);
	}
}
