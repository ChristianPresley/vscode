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
	/** The gRPC listener address (`grpc://127.0.0.1:<port>`) when the gateway opened one. */
	readonly grpcAddress?: URI;
}

/** What the gateway advertises for a server; derived from the invoker when it does not say. */
export interface IMcpGatewayServerCapabilities {
	readonly tools?: { readonly listChanged?: boolean };
	readonly prompts?: { readonly listChanged?: boolean };
	readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
	readonly completions?: boolean;
	readonly logging?: boolean;
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

	createGateway<TContext>(context: TContext, toolInvoker?: IMcpGatewayToolInvoker): Promise<IMcpGatewayInfo>;

	disposeGateway(gatewayId: string): Promise<void>;
}
