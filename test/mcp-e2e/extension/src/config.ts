/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * How a server of config/servers.json is reached. `grpc-auto-typed`: `binding: auto` in front of a
 * server that refuses the tunnel (a typed-only server: VS Code must not connect); `grpcs`: gRPC over TLS.
 */
export type E2eTransport = 'stdio' | 'http' | 'sse' | 'grpc-tunnel' | 'grpc-typed' | 'grpc-auto' | 'grpc-auto-typed' | 'grpcs';

/** Why a negative entry of config/servers.json must fail to connect. */
export type E2eConnectError = 'untrusted-certificate' | 'certificate-name' | 'tunnel-unimplemented';

/** One server of config/servers.json (the fields the extension uses). */
export interface IE2eServer {
	readonly label: string;
	readonly transport: E2eTransport;
	readonly era: 'modern' | 'legacy';
	readonly protocolVersion: string;
	readonly family: 'zig' | 'everything';
	readonly grpc?: boolean;
	readonly pinned?: boolean;
	readonly mcp?: { readonly type: string; readonly url?: string; readonly protocolVersion?: string; readonly deadlineMs?: number };
	/** An API definition (vscode.McpGrpcServerDefinition) of the E2E extension's provider. */
	readonly provider?: { readonly url: string; readonly binding?: 'auto' | 'tunnel' | 'typed'; readonly tls?: { readonly ca?: string; readonly serverName?: string; readonly insecure?: boolean } };
	/**
	 * `grpcLogProxy`: VS Code connects to runner/grpc-log-proxy.ts, which records the calls in `<label>.wire.jsonl`;
	 * `httpProxy`: to runner/http-fault-proxy.ts, which records the requests in `<label>.http.jsonl`;
	 * `oauthFixture`: to runner/oauth-fixture.ts (`<label>.oauth.jsonl`).
	 */
	readonly process?: {
		readonly port?: number;
		readonly upstreamPort?: number;
		readonly grpcLogProxy?: { readonly port: number; readonly refuseTunnel?: boolean; readonly tls?: boolean; readonly resetLimit?: { readonly burst: number; readonly rate: number }; readonly mangle?: readonly string[]; readonly hold?: readonly string[] };
		readonly httpProxy?: { readonly port: number; readonly faults?: readonly string[] };
		readonly oauthFixture?: { readonly port: number; readonly asPort?: number; readonly asPath?: string; readonly prmPath?: string; readonly issMode?: string; readonly grpcPort?: number };
	};
	/** Started only by its own test (not with the others, no negotiation row). */
	readonly ownTest?: boolean;
	/**
	 * A negative entry that VS Code must fail to connect to; the value names the failure
	 * (`untrusted-certificate`, `certificate-name`, `tunnel-unimplemented`: `binding: auto` in front
	 * of a server without the JSON-RPC tunnel). It is not started with the others, has no
	 * negotiation row, and its own test starts it.
	 */
	readonly expectConnectError?: E2eConnectError;
	/** The label of the entry whose process (and wire log) this entry shares. */
	readonly sharesProcessOf?: string;
	/** `ui`: only the UI suite starts this server (its OAuth sign-in asks for consent in a dialog). */
	readonly suite?: 'ui';
}

/** Whether `startServers` starts the server with the others (not a negative entry, not one its own test starts, not a UI-only one). */
export function startsWithOthers(server: IE2eServer): boolean {
	return !server.expectConnectError && !server.ownTest && server.suite !== 'ui';
}

/** The environment the run scripts hand to the extension (all optional, with container defaults). */
export interface IE2eEnvironment {
	/** llama.cpp's OpenAI-compatible base URL. */
	readonly llamaUrl: string;
	/** Where results, the llama request log and the tool transcripts go. */
	readonly resultsDir: string;
	/** config/servers.json. */
	readonly serversFile: string;
	/** The logs of the network servers (runner/start-servers.ts), including the wire logs of the gRPC log proxy. */
	readonly serverLogsDir: string;
	/** The workspace folder the window was opened on, when the run scripts say. */
	readonly workspace: string | undefined;
	/** The loopback port of the UI-mode control server, when the Playwright driver runs. */
	readonly controlPort: number | undefined;
	/** Test groups whose failures are reported but do not fail the run (for example `grpc`). */
	readonly allowFailGroups: readonly string[];
	/** Only run the tests whose name contains one of these strings. */
	readonly only: readonly string[];
	/**
	 * The features the installed build is expected to have (run-suite.sh sets them from the installed
	 * commit, runner/provenance.ts). A test that requires one of them must not skip; a test that
	 * requires none never may. Unset means expected (strict).
	 */
	readonly expected: ReadonlySet<E2eFeature>;
	/** The mutations of runner/mutations.ts of this run (MCP_E2E_MUTATIONS); a few are applied by the tests themselves. */
	readonly mutations: ReadonlySet<string>;
	/** The throw-away CA of the grpcs:// servers (MCP_E2E_TLS_DIR/ca.pem), for the API definitions. */
	readonly tlsCa: string | undefined;
}

/** Features that older builds lack: only a test that requires one of them, on a build without it, may skip. */
export type E2eFeature = 'gateway-grpc' | 'gateway-rate-limits';

function list(value: string | undefined): string[] {
	return (value ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function expectedFeatures(): Set<E2eFeature> {
	const expected = new Set<E2eFeature>();
	if (process.env.MCP_E2E_EXPECT_GATEWAY_GRPC !== '0') {
		expected.add('gateway-grpc');
	}
	if (process.env.MCP_E2E_EXPECT_GATEWAY_RATE_LIMITS !== '0') {
		expected.add('gateway-rate-limits');
	}
	return expected;
}

export function readEnvironment(): IE2eEnvironment {
	const port = Number(process.env.MCP_E2E_CONTROL_PORT);
	const resultsDir = process.env.MCP_E2E_RESULTS_DIR ?? '/tmp/mcp-e2e/results';
	return {
		llamaUrl: (process.env.MCP_E2E_LLAMA_URL ?? 'http://llama-e2e:8080').replace(/\/+$/, ''),
		resultsDir,
		serversFile: process.env.MCP_E2E_SERVERS ?? path.join(__dirname, '..', '..', 'config', 'servers.json'),
		serverLogsDir: process.env.MCP_E2E_SERVER_LOGS ?? path.join(resultsDir, '..', 'servers'),
		workspace: process.env.MCP_E2E_WORKSPACE || undefined,
		controlPort: Number.isInteger(port) && port > 0 ? port : undefined,
		allowFailGroups: list(process.env.MCP_E2E_ALLOW_FAIL),
		only: list(process.env.MCP_E2E_ONLY),
		expected: expectedFeatures(),
		mutations: new Set(list(process.env.MCP_E2E_MUTATIONS)),
		tlsCa: process.env.MCP_E2E_TLS_DIR ? path.join(process.env.MCP_E2E_TLS_DIR, 'ca.pem') : undefined,
	};
}

export function readServers(env: IE2eEnvironment): IE2eServer[] {
	const parsed = JSON.parse(fs.readFileSync(env.serversFile, 'utf8')) as { servers: IE2eServer[] };
	return parsed.servers;
}

export function serverByLabel(servers: readonly IE2eServer[], label: string): IE2eServer {
	const server = servers.find(s => s.label === label);
	if (!server) {
		throw new Error(`No server '${label}' in config/servers.json`);
	}
	return server;
}

/** The definition id VS Code gives a server of the user-level mcp.json (`mcp.config.usrlocal.<label>`). */
export function userConfigDefinitionId(label: string): string {
	return `mcp.config.usrlocal.${label}`;
}

/** The definition id of a server returned by this extension's definition provider. */
export function providerDefinitionId(label: string): string {
	return `vscode-e2e.mcp-e2e/${label}`;
}

export function definitionIdOf(server: IE2eServer): string {
	return server.provider ? providerDefinitionId(server.label) : userConfigDefinitionId(server.label);
}

/** The key of `chat.mcp.serverSampling` for a server (`<collection label>: <server label>`). */
export function samplingKeyOf(server: IE2eServer): string {
	return server.provider ? `E2E gRPC provider: ${server.label}` : `Global in Code - OSS: ${server.label}`;
}

export function appendJsonLine(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(value) + '\n');
}
