/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// config/servers.json for the runner scripts (the extension reads it with its own copy of the types).

import * as fs from 'node:fs';

export interface IRunnerServer {
	readonly label: string;
	readonly transport: string;
	readonly era: 'modern' | 'legacy';
	readonly protocolVersion: string;
	readonly family: string;
	readonly grpc?: boolean;
	readonly pinned?: boolean;
	readonly mcp?: Record<string, unknown>;
	readonly process?: {
		/** The server process; without one, the proxy or fixture below runs in front of `upstreamPort`. */
		readonly command?: string;
		readonly args?: readonly string[];
		readonly env?: Record<string, string>;
		readonly port?: number;
		/** The port of another entry's server that the proxy or fixture of this entry forwards to. */
		readonly upstreamPort?: number;
		/** Start runner/grpc-log-proxy.ts on this port in front of the server; it writes `<label>.wire.jsonl`. */
		readonly grpcLogProxy?: {
			readonly port: number;
			/** Answer the JSON-RPC tunnel with UNIMPLEMENTED (a typed-only server as far as the client can tell). */
			readonly refuseTunnel?: boolean;
			/** Terminate TLS with the server certificate of runner/test-ca.ts (`grpcs://`). */
			readonly tls?: boolean;
			/** nghttp2's stream reset rate limit of the proxy (`--rst-burst`, `--rst-rate`); default 1000 and 33/s. */
			readonly resetLimit?: { readonly burst: number; readonly rate: number };
			/** `--mangle-mcp-name` specs (`<tool>=<value>[:once]`). */
			readonly mangle?: readonly string[];
			/** `--hold` specs (`<tool>=<ms>`). */
			readonly hold?: readonly string[];
		};
		/** Start runner/http-fault-proxy.ts on this port in front of the server's /mcp; it writes `<label>.http.jsonl`. */
		readonly httpProxy?: { readonly port: number; readonly faults?: readonly string[] };
		/** Start runner/oauth-fixture.ts in front of the server; it writes `<label>.oauth.jsonl`. */
		readonly oauthFixture?: {
			readonly port: number;
			readonly asPort?: number;
			readonly asPath?: string;
			readonly prmPath?: string;
			readonly issMode?: 'ok' | 'wrong' | 'omit';
			/** A gRPC front on this port instead of the Streamable HTTP /mcp (the upstream is a gRPC port). */
			readonly grpcPort?: number;
		};
	};
	readonly provider?: { readonly url: string; readonly binding?: string; readonly tls?: Record<string, unknown> };
	/** A negative entry: VS Code must fail to connect (no process of its own; it shares another entry's port). */
	readonly expectConnectError?: string;
	readonly ownTest?: boolean;
	readonly suite?: 'ui';
}

export function readServers(file: string): IRunnerServer[] {
	return (JSON.parse(fs.readFileSync(file, 'utf8')) as { servers: IRunnerServer[] }).servers;
}

/** Replaces `{name}` in every string of a JSON value. */
export function resolvePlaceholders<T>(value: T, placeholders: Record<string, string>): T {
	return JSON.parse(JSON.stringify(value), (_key, v: unknown) => typeof v === 'string'
		? v.replace(/\{(\w+)\}/g, (m, name: string) => placeholders[name] ?? m)
		: v) as T;
}

/** The key of `chat.mcp.serverSampling` (`<collection label>: <server label>`). */
export function samplingKeyOf(server: IRunnerServer): string {
	return server.provider ? `E2E gRPC provider: ${server.label}` : `Global in Code - OSS: ${server.label}`;
}

/** The mutations of runner/mutations.ts that this run applies (MCP_E2E_MUTATIONS). */
export function activeMutations(): Set<string> {
	return new Set((process.env.MCP_E2E_MUTATIONS ?? '').split(',').map(s => s.trim()).filter(Boolean));
}
