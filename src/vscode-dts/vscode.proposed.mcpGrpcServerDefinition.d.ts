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
		 * Try the JSON-RPC tunnel first and fall back to the typed service.
		 */
		Auto = 1,
		/**
		 * Send JSON-RPC messages through the zig-sdk tunnel service,
		 * `/mcp.zig.transport.v1.Mcp/Call`.
		 */
		Tunnel = 2,
		/**
		 * Call the methods of Google's typed `model_context_protocol.Mcp` service.
		 */
		Typed = 3,
	}

	/**
	 * McpGrpcServerDefinition represents an MCP server available over gRPC
	 * (HTTP/2). The editor connects to {@link McpHttpServerDefinition.uri},
	 * which must use the `grpc://` (plaintext) or `grpcs://` (TLS) scheme, and
	 * speaks either the zig-sdk JSON-RPC tunnel service
	 * (`/mcp.zig.transport.v1.Mcp/Call`) or the typed
	 * `model_context_protocol.Mcp` service, depending on {@link binding}.
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
			 * Path to a PEM-encoded certificate authority bundle used to verify the
			 * server certificate, in addition to the system roots.
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
		 * {@link McpGrpcBinding.Auto} is used.
		 */
		readonly binding?: McpGrpcBinding;

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
