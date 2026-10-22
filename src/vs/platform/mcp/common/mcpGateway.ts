/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { MCP } from './modelContextProtocol.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';
import { McpSkills } from './modelContextProtocolSkills.js';

export const IMcpGatewayService = createDecorator<IMcpGatewayService>('IMcpGatewayService');

export const McpGatewayChannelName = 'mcpGateway';
export const McpGatewayToolBrokerChannelName = 'mcpGatewayToolBroker';

export interface IMcpGatewayServerDescriptor {
	readonly id: string;
	readonly label: string;
}

export interface IMcpGatewayServerInfo {
	readonly label: string;
	readonly address: URI;
	/**
	 * The gRPC endpoint of the same server, only for a gateway created with
	 * `{ grpc: true }` ({@link IMcpGatewayCreateOptions.grpc}) whose gRPC
	 * listener could open: `grpc://127.0.0.1:<port>/<routeId>`. A client
	 * connects to the authority (cleartext HTTP/2, loopback only) and calls
	 * the JSON-RPC tunnel `mcp.zig.transport.v1.Mcp/Call` or the typed
	 * service `model_context_protocol.Mcp`; every call must carry the route
	 * id (the path without its leading slash) as the `mcp-gateway-route`
	 * metadata, else it ends with NOT_FOUND. The route id is the same as in
	 * the HTTP `address`, and as there it is what keeps other local
	 * processes out.
	 */
	readonly grpcAddress?: URI;
}

/** Options of {@link IMcpGatewayService.createGateway}. */
export interface IMcpGatewayCreateOptions {
	/**
	 * Also serve the gateway's servers over gRPC (loopback, cleartext h2c;
	 * the JSON-RPC tunnel and the typed binding): they then carry a
	 * `grpcAddress`. The gRPC listener opens for the first route that asks
	 * for it and closes after the last one; without this option (the
	 * default) a gateway is served over HTTP only and opens no gRPC port.
	 * When the listener cannot open, the gateway is still created, served
	 * over HTTP only (no `grpcAddress`; the reason is logged), and a later
	 * request tries again. A gateway service that is not configured for gRPC
	 * ignores it.
	 */
	readonly grpc?: boolean;
}

/** The argument of the `createGateway` call of the {@link McpGatewayChannelName} channel. */
export interface IMcpGatewayCreateArgs {
	/** The chat session the gateway's tool calls belong to (a URI string). */
	readonly chatSessionResource?: string;
	/** {@link IMcpGatewayCreateOptions.grpc} */
	readonly grpc?: boolean;
}

/** What the gateway advertises for a server; derived from the invoker when it does not say. */
export interface IMcpGatewayServerCapabilities {
	readonly tools?: { readonly listChanged?: boolean };
	readonly prompts?: { readonly listChanged?: boolean };
	readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
	readonly completions?: boolean;
	readonly logging?: boolean;
	/** The Skills extension (`io.modelcontextprotocol/skills`, SEP-2640) and its `directoryRead` setting. */
	readonly skills?: { readonly directoryRead?: boolean };
}

export interface IMcpGatewayCacheHints {
	readonly ttlMs: number;
	readonly cacheScope: 'public' | 'private';
}

/**
 * Returned by an invoker when the upstream server needs input (elicitation,
 * sampling, roots) before it can finish: the gateway answers it through the
 * client (2026-07-28: an `input_required` result with a sealed
 * `requestState`; 2025-11-25: server→client requests on the client's stream).
 */
export interface IMcpGatewayInputRequired {
	readonly resultType: 'input_required';
	readonly inputRequests?: MCP.InputRequests;
	/** The upstream's opaque state; the gateway seals it before it leaves the process. */
	readonly requestState?: string;
}

export interface IMcpGatewayProgress {
	readonly progress: number;
	readonly total?: number;
	readonly message?: string;
}

/** Per-request context the gateway hands to an invoker. */
export interface IMcpGatewayInvokeContext {
	readonly protocolVersion: string;
	readonly clientCapabilities: MCP.ClientCapabilities;
	readonly clientInfo?: MCP.Implementation;
	readonly logLevel?: MCP.LoggingLevel;
	/** The client's answers to a previous `input_required` round. */
	readonly inputResponses?: MCP.InputResponses;
	/** The upstream's opaque state from the previous round (already unsealed). */
	readonly requestState?: string;
	readonly progressToken?: MCP.ProgressToken;
	readonly onProgress?: (progress: IMcpGatewayProgress) => void;
	readonly onLog?: (level: MCP.LoggingLevel, data: unknown, logger?: string) => void;
	/**
	 * 2025-11-25 sessions (SEP-1699 polling): ends the request's SSE response
	 * stream now, with a `retry` hint, while the request keeps running; what it
	 * produces afterwards (its result included) is replayed when the client
	 * reconnects with `Last-Event-ID`. Absent when the connection cannot resume.
	 */
	readonly closeSseStream?: () => void;
	readonly token: CancellationToken;
	readonly chatSessionResource?: string;
}

export interface IMcpGatewaySingleServerInvoker {
	readonly onDidChangeTools: Event<void>;
	readonly onDidChangeResources: Event<void>;
	readonly onDidChangePrompts?: Event<void>;
	readonly onDidUpdateResource?: Event<{ readonly uri: string }>;
	/** Advertised capabilities; derived from the available methods when undefined. */
	readonly capabilities?: IMcpGatewayServerCapabilities;
	readonly instructions?: string;
	readonly cacheHints?: IMcpGatewayCacheHints;
	listTools(): Promise<readonly MCPLegacy.Tool[]>;
	callTool(name: string, args: Record<string, unknown>, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.CallToolResult | IMcpGatewayInputRequired>;
	listResources(): Promise<readonly MCPLegacy.Resource[]>;
	readResource(uri: string, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.ReadResourceResult | IMcpGatewayInputRequired>;
	listResourceTemplates(): Promise<readonly MCPLegacy.ResourceTemplate[]>;
	listPrompts?(): Promise<readonly MCPLegacy.Prompt[]>;
	getPrompt?(name: string, args: Record<string, string> | undefined, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.GetPromptResult | IMcpGatewayInputRequired>;
	complete?(params: MCPLegacy.CompleteRequest['params'], context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.CompleteResult>;
	/** Starts forwarding `onDidUpdateResource` for a URI until the disposable is disposed. */
	subscribeResource?(uri: string): Promise<IDisposable>;
	/** Skills extension (SEP-2640): the entries of the server's skills (`skills/list`). With {@link getSkill}, the gateway serves the extension. */
	listSkills?(): Promise<readonly McpSkills.Skill[]>;
	/** Skills extension: the current entry of one skill by its `SKILL.md` URI; undefined when the server serves no such skill. */
	getSkill?(uri: string): Promise<McpSkills.Skill | undefined>;
	/** Skills extension, `directoryRead`: the direct children of a directory resource; undefined when the URI is not a directory. */
	readDirectory?(uri: string): Promise<readonly MCPLegacy.Resource[] | undefined>;
}

export interface IMcpGatewayToolInvoker {
	readonly onDidChangeServers: Event<readonly IMcpGatewayServerDescriptor[]>;
	readonly onDidChangeTools: Event<void>;
	readonly onDidChangeResources: Event<void>;
	readonly onDidChangePrompts?: Event<void>;
	readonly onDidUpdateResource?: Event<{ readonly serverId: string; readonly uri: string }>;
	listServers(): readonly IMcpGatewayServerDescriptor[];
	getServerCapabilities?(serverId: string): Promise<IMcpGatewayServerCapabilities | undefined>;
	listToolsForServer(serverId: string): Promise<readonly MCPLegacy.Tool[]>;
	callToolForServer(serverId: string, name: string, args: Record<string, unknown>, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.CallToolResult | IMcpGatewayInputRequired>;
	listResourcesForServer(serverId: string): Promise<readonly MCPLegacy.Resource[]>;
	readResourceForServer(serverId: string, uri: string, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.ReadResourceResult | IMcpGatewayInputRequired>;
	listResourceTemplatesForServer(serverId: string): Promise<readonly MCPLegacy.ResourceTemplate[]>;
	listPromptsForServer?(serverId: string): Promise<readonly MCPLegacy.Prompt[]>;
	getPromptForServer?(serverId: string, name: string, args: Record<string, string> | undefined, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.GetPromptResult | IMcpGatewayInputRequired>;
	completeForServer?(serverId: string, params: MCPLegacy.CompleteRequest['params']): Promise<MCPLegacy.CompleteResult>;
	subscribeResourceForServer?(serverId: string, uri: string): Promise<IDisposable>;
	listSkillsForServer?(serverId: string): Promise<readonly McpSkills.Skill[]>;
	getSkillForServer?(serverId: string, uri: string): Promise<McpSkills.Skill | undefined>;
	readDirectoryForServer?(serverId: string, uri: string): Promise<readonly MCPLegacy.Resource[] | undefined>;
}

export interface IMcpGatewayDto {
	readonly servers: readonly IMcpGatewayServerInfo[];

	readonly gatewayId: string;
}

export interface IMcpGatewayInfo extends IMcpGatewayDto {
	readonly onDidChangeServers: Event<readonly IMcpGatewayServerInfo[]>;
}

export interface IMcpGatewayService {
	readonly _serviceBrand: undefined;

	disposeGatewaysForClient<TContext>(context: TContext): void;

	createGateway<TContext>(context: TContext, toolInvoker?: IMcpGatewayToolInvoker, options?: IMcpGatewayCreateOptions): Promise<IMcpGatewayInfo>;

	disposeGateway(gatewayId: string): Promise<void>;
}
