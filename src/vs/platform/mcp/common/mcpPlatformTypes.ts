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
	/**
	 * The issuer URL of the authorization server the pre-registered {@link clientId}
	 * (and its client secret) belongs to. A discovered issuer that differs is an
	 * error and no credentials are sent to it.
	 */
	readonly authorizationServer?: string;
	/**
	 * Escape hatch: `assume-supported` treats an authorization server that does not
	 * advertise the `S256` PKCE method in `code_challenge_methods_supported` as if it
	 * did. The default, `require-advertised`, refuses to authorize against it.
	 */
	readonly pkce?: 'require-advertised' | 'assume-supported';
	/**
	 * Escape hatch: allow `http://` authorization endpoints on non-loopback hosts.
	 * Defaults to false; loopback hosts are always allowed.
	 */
	readonly allowInsecureHttp?: boolean;
	/**
	 * `authorization_code` (the default: a user signs in), `client_credentials` (a pre-registered
	 * machine client, `io.modelcontextprotocol/oauth-client-credentials`) or `workload_identity`
	 * (a workload identity JWT, `io.modelcontextprotocol/auth/wif`).
	 */
	readonly grant?: 'authorization_code' | 'client_credentials' | 'workload_identity';
	/** For `client_credentials`: a PKCS #8 PEM private key file for `private_key_jwt`. */
	readonly privateKeyFile?: string;
	/** The JWS algorithm of the private key (`ES256`, `ES384`, `RS256` or `PS256`; `ES256` by default). */
	readonly signingAlgorithm?: string;
	/** The `kid` of the private key. */
	readonly keyId?: string;
	/** The `aud` of the client assertion: `issuer` (the default) or `token_endpoint`. */
	readonly clientAssertionAudience?: 'issuer' | 'token_endpoint';
	/** For `workload_identity`: the file that holds the workload JWT; it is read for each token request. */
	readonly workloadIdentityTokenFile?: string;
	/** Request DPoP-bound tokens (RFC 9449): `true` always, `false` never; by default when the server requires them. */
	readonly dpop?: boolean;
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
	/**
	 * Path to a PEM-encoded certificate authority bundle trusted for the server
	 * certificate in addition to the roots HTTPS requests use (the bundled roots
	 * and, with `http.systemCertificates`, the operating system store).
	 */
	readonly ca?: string;
	/** Skips server certificate verification. */
	readonly insecure?: boolean;
	/** Overrides the host name checked against the server certificate (SNI). */
	readonly serverName?: string;
}

/**
 * The gRPC service binding to speak: the zig-sdk JSON-RPC tunnel
 * (`/mcp.zig.transport.v1.Mcp/Call`), Google's typed `model_context_protocol.Mcp`
 * service, or `auto` (the default), which is the tunnel: the client never
 * switches to the typed service on its own, only `typed` speaks it.
 * `typed-with-tunnel` speaks the typed service for the methods it has an RPC
 * for and the tunnel for the rest (discovery, subscriptions, notifications and
 * extension methods such as the Skills extension's).
 */
export type McpGrpcBinding = 'auto' | 'tunnel' | 'typed' | 'typed-with-tunnel';

export interface IMcpGrpcServerConfiguration extends ICommonMcpServerConfiguration {
	readonly type: McpServerType.GRPC;
	/** A `grpc://` (plaintext HTTP/2) or `grpcs://` (TLS) URL. */
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly tls?: IMcpGrpcServerTlsConfiguration;
	readonly binding?: McpGrpcBinding;
	/**
	 * The deadline in milliseconds of every call except the `subscriptions/listen`
	 * stream, which never has one; greater than 0. Unset: 60 seconds for
	 * `server/discover` and the list, read, prompt and completion requests, and no
	 * deadline for `tools/call`, the retries of `input_required` rounds and other requests.
	 */
	readonly deadlineMs?: number;
	/**
	 * Interval in milliseconds between HTTP/2 keep-alive pings, at least 300000
	 * (5 minutes), sent only while a call is open (doubled for the next
	 * connection after a `too_many_pings`); 0 sends none. Unset: a ping every
	 * 310000 ms only while a `subscriptions/listen` stream is open.
	 */
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
