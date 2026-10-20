/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../base/common/collections.js';

export interface IMcpDevModeConfig {
	/** Pattern or list of glob patterns to watch relative to the workspace folder. */
	watch?: string | string[];
	/** Whether to debug the MCP server when it's started. */
	debug?: { type: 'node' } | { type: 'debugpy'; debugpyPath?: string };
}

export interface IMcpSandboxConfiguration {
	network?: {
		allowedDomains?: string[];
		deniedDomains?: string[];
	};
	filesystem?: {
		denyRead?: string[];
		allowWrite?: string[];
		denyWrite?: string[];
	};
}

export const enum McpServerVariableType {
	PROMPT = 'promptString',
	PICK = 'pickString',
}

export interface IMcpServerVariable {
	readonly id: string;
	readonly type: McpServerVariableType;
	readonly description: string;
	readonly password: boolean;
	readonly default?: string;
	readonly options?: readonly string[];
	readonly serverName?: string;
}

export const enum McpServerType {
	LOCAL = 'stdio',
	REMOTE = 'http',
	GRPC = 'grpc',
}

export interface ICommonMcpServerConfiguration {
	readonly type: McpServerType;
	readonly version?: string;
	readonly gallery?: boolean | string;
	/**
	 * A Model Context Protocol revision the user pinned for this server, one of
	 * `SUPPORTED_MCP_PROTOCOL_VERSIONS`. When unset, the newest revision both
	 * sides support is negotiated.
	 */
	readonly protocolVersion?: string;
}

export interface IMcpStdioServerConfiguration extends ICommonMcpServerConfiguration {
	readonly type: McpServerType.LOCAL;
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Record<string, string | number | null>;
	readonly envFile?: string;
	readonly cwd?: string;
	readonly sandboxEnabled?: boolean;
	/** Server-specific permissions, combined with root-level sandbox deny rules. */
	readonly sandbox?: IMcpSandboxConfiguration;
	readonly dev?: IMcpDevModeConfig;
}

export interface IMcpRemoteServerOAuthConfiguration {
	readonly clientId?: string;
}

export interface IMcpRemoteServerConfiguration extends ICommonMcpServerConfiguration {
	readonly type: McpServerType.REMOTE;
	readonly transport?: 'http' | 'sse';
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly oauth?: IMcpRemoteServerOAuthConfiguration;
	readonly dev?: IMcpDevModeConfig;
}

/** TLS settings of a {@link IMcpGrpcServerConfiguration}; only meaningful for `grpcs://` URLs. */
export interface IMcpGrpcServerTlsConfiguration {
	/** Path to a PEM-encoded certificate authority bundle that verifies the server certificate. */
	readonly ca?: string;
	/** Skips server certificate verification. */
	readonly insecure?: boolean;
	/** Overrides the host name checked against the server certificate (SNI). */
	readonly serverName?: string;
}

/**
 * The gRPC service binding to speak: the zig-sdk JSON-RPC tunnel
 * (`/mcp.zig.transport.v1.Mcp/Call`), Google's typed `model_context_protocol.Mcp`
 * service, or `auto`, which tries the tunnel first and falls back to the typed service.
 */
export type McpGrpcBinding = 'auto' | 'tunnel' | 'typed';

export interface IMcpGrpcServerConfiguration extends ICommonMcpServerConfiguration {
	readonly type: McpServerType.GRPC;
	/** A `grpc://` (plaintext HTTP/2) or `grpcs://` (TLS) URL. */
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly tls?: IMcpGrpcServerTlsConfiguration;
	readonly binding?: McpGrpcBinding;
	/** Per-call deadline in milliseconds. Unset means no deadline, including on `tools/call`. */
	readonly deadlineMs?: number;
	/** Interval in milliseconds between HTTP/2 keep-alive pings. Unset disables them. */
	readonly keepAliveMs?: number;
	readonly oauth?: IMcpRemoteServerOAuthConfiguration;
	readonly dev?: IMcpDevModeConfig;
}

export type IMcpServerConfiguration = IMcpStdioServerConfiguration | IMcpRemoteServerConfiguration | IMcpGrpcServerConfiguration;

export function isMcpStdioServerConfiguration(config: IMcpServerConfiguration): config is IMcpStdioServerConfiguration {
	return config.type === McpServerType.LOCAL;
}

export function isMcpRemoteServerConfiguration(config: IMcpServerConfiguration): config is IMcpRemoteServerConfiguration {
	return config.type === McpServerType.REMOTE;
}

export function isMcpGrpcServerConfiguration(config: IMcpServerConfiguration): config is IMcpGrpcServerConfiguration {
	return config.type === McpServerType.GRPC;
}

export interface IMcpServersConfiguration {
	servers?: IStringDictionary<IMcpServerConfiguration>;
	inputs?: IMcpServerVariable[];
}
