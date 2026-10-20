/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { IJsonRpcRequest, JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewayCacheHints, IMcpGatewayInputRequired, IMcpGatewayInvokeContext, IMcpGatewayServerCapabilities, IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { applyModernEnvelope, GATEWAY_SERVER_INFO, hasClientCapability, honorSubscriptionFilter, IModernRequestMeta, McpGatewayRpcError, McpInputRequestCapability, requiredCapabilityForInputRequest, validateInputResponses, validateModernRequestMeta, validateStandardHeaders } from '../common/mcpGatewayProtocol.js';
import { LATEST_MCP_PROTOCOL_VERSION, McpProtocolEra } from '../common/mcpProtocolVersions.js';
import { MCP } from '../common/modelContextProtocol.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';
import { McpGatewaySealedState } from './mcpGatewaySealedState.js';

/** The most input rounds the gateway runs for one request. */
export const MAX_GATEWAY_INPUT_ROUNDS = 10;

export const DEFAULT_CACHE_HINTS: IMcpGatewayCacheHints = { ttlMs: 0, cacheScope: 'private' };

/** The 2025-11-25 "resource not found" code (replaced by -32602 in 2026-07-28). */
const LEGACY_RESOURCE_NOT_FOUND = -32002;

/** The invoker's "I need input" result. */
export function isGatewayInputRequired(value: unknown): value is IMcpGatewayInputRequired {
	return typeof value === 'object' && value !== null && (value as { resultType?: unknown }).resultType === 'input_required';
}

/** A resource that does not exist: -32602 on the 2026-07-28 wire, -32002 on the legacy wire. */
export class McpGatewayResourceNotFoundError extends McpGatewayRpcError {
	constructor(uri: string) {
		super(MCP.INVALID_PARAMS, `Resource not found: ${uri}`, { uri });
	}
}

export interface IMcpGatewayNotification {
	readonly method: string;
	readonly params?: object;
}

/** Everything the dispatcher knows about one incoming request. */
export interface IMcpGatewayDispatchContext {
	readonly era: McpProtocolEra;
	readonly protocolVersion: string;
	readonly requestId: JsonRpcId;
	/** Modern: from `_meta`; legacy: from the session's `initialize`. */
	readonly clientCapabilities: MCP.ClientCapabilities;
	readonly clientInfo?: MCP.Implementation;
	/** Modern: from `_meta`; legacy: the session's `logging/setLevel` level. */
	readonly logLevel?: MCP.LoggingLevel;
	readonly progressToken?: MCP.ProgressToken;
	/** Lowercased transport headers (HTTP) or metadata (gRPC) of the request. */
	readonly headers: Readonly<Record<string, string>>;
	readonly token: CancellationToken;
	/** Sends a notification on the request's own stream (progress, log, elicitation complete). */
	notify(notification: IMcpGatewayNotification): void;
	/** Legacy sessions: sends a server→client request on the client's stream and resolves with its result. */
	sendServerRequest?(request: IMcpGatewayNotification): Promise<unknown>;
	readonly chatSessionResource?: string;
}

export interface IMcpGatewayDispatcherOptions {
	/** Overrides the capabilities the gateway advertises (the conformance fixture advertises everything). */
	readonly capabilities?: IMcpGatewayServerCapabilities;
	readonly serverInfo?: MCP.Implementation;
	readonly cacheHints?: IMcpGatewayCacheHints;
	readonly instructions?: string;
}

export type ModernRequestPreparation =
	| { readonly ok: true; readonly meta: IModernRequestMeta }
	| { readonly ok: false; readonly error: McpGatewayRpcError };

const LOG_LEVEL_ORDER: readonly MCP.LoggingLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

function logLevelAtLeast(level: MCP.LoggingLevel, threshold: MCP.LoggingLevel | undefined): boolean {
	if (!threshold) {
		return true;
	}
	return LOG_LEVEL_ORDER.indexOf(level) >= LOG_LEVEL_ORDER.indexOf(threshold);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `ClientCapabilities` shape a `-32021` error names as `data.requiredCapabilities`. */
export function requiredCapabilitiesFor(capability: McpInputRequestCapability): MCP.ClientCapabilities {
	switch (capability) {
		case 'elicitation':
			return { elicitation: {} };
		case 'elicitation.url':
			return { elicitation: { url: {} } };
		case 'sampling':
			return { sampling: {} };
		case 'roots':
			return { roots: {} };
	}
}

/**
 * One method table for both protocol eras. The transports (HTTP route, gRPC
 * listener) parse and validate the frame, the session keeps the legacy state,
 * and everything about what a method does lives here: capability gating,
 * input rounds (passed through to modern clients with a sealed
 * `requestState`, bridged as server→client requests for legacy clients),
 * progress and log forwarding, and the 2026-07-28 result envelope.
 */
export class McpGatewayDispatcher extends Disposable {
	private _toolSchemas: Map<string, unknown> | undefined;
	private readonly _serverInfo: MCP.Implementation;

	constructor(
		private readonly _routeId: string,
		private readonly _logger: ILogger,
		private readonly _invoker: IMcpGatewaySingleServerInvoker,
		private readonly _sealedState: McpGatewaySealedState,
		private readonly _options: IMcpGatewayDispatcherOptions = {},
	) {
		super();
		this._serverInfo = _options.serverInfo ?? GATEWAY_SERVER_INFO;
		this._register(_invoker.onDidChangeTools(() => { this._toolSchemas = undefined; }));
	}

	get serverInfo(): MCP.Implementation {
		return this._serverInfo;
	}

	get cacheHints(): IMcpGatewayCacheHints {
		return this._options.cacheHints ?? this._invoker.cacheHints ?? DEFAULT_CACHE_HINTS;
	}

	/** The capabilities the gateway advertises for this server, in the 2026-07-28 shape. */
	serverCapabilities(): MCP.ServerCapabilities {
		const declared = this._options.capabilities ?? this._invoker.capabilities;
		const caps: MCP.ServerCapabilities = {};
		caps.tools = { listChanged: declared?.tools?.listChanged ?? true };
		caps.resources = {
			subscribe: declared?.resources?.subscribe ?? !!this._invoker.subscribeResource,
			listChanged: declared?.resources?.listChanged ?? true,
		};
		if (declared?.prompts || (!declared && this._invoker.listPrompts)) {
			caps.prompts = { listChanged: declared?.prompts?.listChanged ?? true };
		}
		if (declared?.completions ?? !!this._invoker.complete) {
			caps.completions = {};
		}
		if (declared?.logging ?? true) {
			caps.logging = {};
		}
		return caps;
	}

	/** The legacy `initialize` capabilities; completions/logging/subscribe are always announced so legacy SDK clients allow the calls. */
	legacyInitializeCapabilities(): MCPLegacy.ServerCapabilities {
		const caps = this.serverCapabilities();
		return {
			tools: { listChanged: true },
			resources: { subscribe: true, listChanged: true },
			prompts: { listChanged: true },
			logging: {},
			completions: {},
			...(caps.extensions ? { extensions: caps.extensions as MCPLegacy.ServerCapabilities['extensions'] } : {}),
		};
	}

	discoverResult(): MCP.DiscoverResult {
		const hints = this.cacheHints;
		const result: MCP.DiscoverResult = {
			resultType: 'complete',
			supportedVersions: [LATEST_MCP_PROTOCOL_VERSION],
			capabilities: this.serverCapabilities(),
			ttlMs: hints.ttlMs,
			cacheScope: hints.cacheScope,
		};
		const instructions = this._options.instructions ?? this._invoker.instructions;
		if (instructions) {
			result.instructions = instructions;
		}
		return applyModernEnvelope('server/discover', result, this._serverInfo, hints);
	}

	honoredFilter(requested: MCP.SubscriptionFilter): MCP.SubscriptionFilter {
		return honorSubscriptionFilter(requested, this.serverCapabilities());
	}

	/** Whether the method is served by {@link dispatch} in the given era (listen and the legacy session methods are the transport's). */
	supportsMethod(method: string, era: McpProtocolEra): boolean {
		switch (method) {
			case 'server/discover':
				return era === 'modern';
			case 'tools/list':
			case 'tools/call':
			case 'resources/list':
			case 'resources/templates/list':
			case 'resources/read':
				return true;
			case 'prompts/list':
			case 'prompts/get':
				return !!this.serverCapabilities().prompts;
			case 'completion/complete':
				return !!this.serverCapabilities().completions;
			case 'ping':
				return era === 'legacy';
			default:
				return false;
		}
	}

	/**
	 * Validates a modern request before it is dispatched: the `_meta` keys and
	 * the mirrored headers (including `Mcp-Param-*` for annotated tool
	 * arguments). Errors map to HTTP 400 on the HTTP transport.
	 */
	async prepareModernRequest(headers: Readonly<Record<string, string>>, request: IJsonRpcRequest): Promise<ModernRequestPreparation> {
		const meta = validateModernRequestMeta(request);
		if (!meta.ok) {
			if (meta.error.code === MCP.UNSUPPORTED_PROTOCOL_VERSION) {
				// A header that disagrees with the body is a mismatch before the version is judged.
				const requested = (meta.error.data as { requested: string }).requested;
				const headerError = validateStandardHeaders(headers, request, requested);
				if (headerError) {
					return { ok: false, error: headerError };
				}
			}
			return meta;
		}
		let inputSchema: unknown;
		if (request.method === 'tools/call' && isObject(request.params) && typeof request.params.name === 'string') {
			inputSchema = await this._toolInputSchema(request.params.name);
		}
		const headerError = validateStandardHeaders(headers, request, meta.meta.protocolVersion, inputSchema);
		if (headerError) {
			return { ok: false, error: headerError };
		}
		return meta;
	}

	/** Runs a request. Returns the result object (enveloped for modern clients); throws {@link McpGatewayRpcError}. */
	async dispatch(ctx: IMcpGatewayDispatchContext, method: string, params: unknown): Promise<object> {
		if (!this.supportsMethod(method, ctx.era)) {
			throw new McpGatewayRpcError(MCP.METHOD_NOT_FOUND, `Method not found: ${method}`);
		}
		const result = await this._dispatchInner(ctx, method, isObject(params) ? params : {});
		return ctx.era === 'modern' ? applyModernEnvelope(method, result, this._serverInfo, this.cacheHints) : result;
	}

	private async _dispatchInner(ctx: IMcpGatewayDispatchContext, method: string, params: Record<string, unknown>): Promise<object> {
		switch (method) {
			case 'server/discover':
				return this.discoverResult();
			case 'ping':
				return {};
			case 'tools/list': {
				this._checkCursor(params);
				const tools = await this._invoke(ctx, () => this._invoker.listTools());
				this._toolSchemas = new Map(tools.map(t => [t.name, t.inputSchema]));
				return { tools: [...tools] } satisfies MCPLegacy.ListToolsResult;
			}
			case 'tools/call': {
				if (typeof params.name !== 'string') {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing tool name');
				}
				if (params.arguments !== undefined && !isObject(params.arguments)) {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Invalid tool call arguments');
				}
				const name = params.name;
				const args = isObject(params.arguments) ? params.arguments : {};
				return this._withInputRounds(ctx, method, name, params, invokeCtx => this._invoker.callTool(name, args, invokeCtx));
			}
			case 'prompts/list': {
				this._checkCursor(params);
				const prompts = await this._invoke(ctx, () => this._invoker.listPrompts!());
				return { prompts: [...prompts] } satisfies MCPLegacy.ListPromptsResult;
			}
			case 'prompts/get': {
				if (typeof params.name !== 'string') {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing prompt name');
				}
				if (params.arguments !== undefined && !isObject(params.arguments)) {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Invalid prompt arguments');
				}
				const name = params.name;
				const args = isObject(params.arguments) ? params.arguments as Record<string, string> : undefined;
				return this._withInputRounds(ctx, method, name, params, invokeCtx => this._invoker.getPrompt!(name, args, invokeCtx));
			}
			case 'resources/list': {
				this._checkCursor(params);
				const resources = await this._invoke(ctx, () => this._invoker.listResources());
				return { resources: [...resources] } satisfies MCPLegacy.ListResourcesResult;
			}
			case 'resources/templates/list': {
				this._checkCursor(params);
				const resourceTemplates = await this._invoke(ctx, () => this._invoker.listResourceTemplates());
				return { resourceTemplates: [...resourceTemplates] } satisfies MCPLegacy.ListResourceTemplatesResult;
			}
			case 'resources/read': {
				if (typeof params.uri !== 'string') {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing resource URI');
				}
				const uri = params.uri;
				return this._withInputRounds(ctx, method, uri, params, invokeCtx => this._invoker.readResource(uri, invokeCtx));
			}
			case 'completion/complete': {
				if (!isObject(params.ref) || !isObject(params.argument)) {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing completion ref or argument');
				}
				const completeParams = params as unknown as MCPLegacy.CompleteRequest['params'];
				return this._invoke(ctx, () => this._invoker.complete!(completeParams, this._invokeContext(ctx, method, undefined, undefined)));
			}
			default:
				throw new McpGatewayRpcError(MCP.METHOD_NOT_FOUND, `Method not found: ${method}`);
		}
	}

	/** The gateway never issues cursors, so any cursor value (an empty string included) is unknown. */
	private _checkCursor(params: Record<string, unknown>): void {
		if (params.cursor !== undefined) {
			throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Invalid cursor', { cursor: params.cursor });
		}
	}

	private async _toolInputSchema(name: string): Promise<unknown> {
		if (!this._toolSchemas) {
			try {
				const tools = await this._invoker.listTools();
				this._toolSchemas = new Map(tools.map(t => [t.name, t.inputSchema]));
			} catch (e) {
				this._logger.warn(`[McpGateway][route ${this._routeId}] Could not list tools to verify headers: ${e}`);
				return undefined;
			}
		}
		return this._toolSchemas.get(name);
	}

	private _invokeContext(ctx: IMcpGatewayDispatchContext, _method: string, inputResponses: MCP.InputResponses | undefined, requestState: string | undefined): IMcpGatewayInvokeContext {
		return {
			protocolVersion: ctx.protocolVersion,
			clientCapabilities: ctx.clientCapabilities,
			clientInfo: ctx.clientInfo,
			logLevel: ctx.logLevel,
			inputResponses,
			requestState,
			progressToken: ctx.progressToken,
			onProgress: ctx.progressToken === undefined ? undefined : progress => {
				const params: Record<string, unknown> = { progressToken: ctx.progressToken, progress: progress.progress };
				if (progress.total !== undefined) {
					params.total = progress.total;
				}
				if (progress.message !== undefined) {
					params.message = progress.message;
				}
				ctx.notify({ method: 'notifications/progress', params });
			},
			onLog: (level, data, logger) => {
				// 2026-07-28: a request without `_meta.logLevel` gets no log notifications at all.
				if (ctx.era === 'modern' && ctx.logLevel === undefined) {
					return;
				}
				if (!this.serverCapabilities().logging || !logLevelAtLeast(level, ctx.logLevel)) {
					return;
				}
				const params: Record<string, unknown> = { level, data };
				if (logger !== undefined) {
					params.logger = logger;
				}
				ctx.notify({ method: 'notifications/message', params });
			},
			token: ctx.token,
			chatSessionResource: ctx.chatSessionResource,
		};
	}

	private async _invoke<T>(ctx: IMcpGatewayDispatchContext, fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			throw this._mapError(ctx, e);
		}
	}

	private _mapError(ctx: IMcpGatewayDispatchContext, error: unknown): McpGatewayRpcError {
		if (error instanceof McpGatewayResourceNotFoundError && ctx.era === 'legacy') {
			return new McpGatewayRpcError(LEGACY_RESOURCE_NOT_FOUND, error.message, error.data);
		}
		if (error instanceof McpGatewayRpcError) {
			return error;
		}
		if (error instanceof CancellationError || ctx.token.isCancellationRequested) {
			return new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'The request was cancelled');
		}
		this._logger.error(`[McpGateway][route ${this._routeId}] Invocation failed`, error);
		return new McpGatewayRpcError(ctx.era === 'legacy' ? MCPLegacy.INVALID_PARAMS : MCP.INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
	}

	/**
	 * Runs a request that may need input. Modern clients get the
	 * `input_required` result back with the upstream state sealed; legacy
	 * clients are asked through server→client requests and the request is
	 * re-run with their answers until it completes.
	 */
	private async _withInputRounds<T extends object>(ctx: IMcpGatewayDispatchContext, method: string, target: string, params: Record<string, unknown>, invoke: (invokeCtx: IMcpGatewayInvokeContext) => Promise<T | IMcpGatewayInputRequired>): Promise<T | MCP.InputRequiredResult> {
		const responsesError = validateInputResponses(params.inputResponses);
		if (responsesError) {
			throw responsesError;
		}
		let inputResponses = params.inputResponses as MCP.InputResponses | undefined;
		let requestState: string | undefined;
		if (params.requestState !== undefined) {
			if (typeof params.requestState !== 'string') {
				throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'requestState must be a string', { reason: 'invalid_request_state' });
			}
			requestState = this._sealedState.unseal(params.requestState, { method, target, principal: this._routeId });
		}
		const aad = { method, target, principal: this._routeId };
		const askedUrlElicitations = new Set<string>();
		/** Legacy bridge: the connection-unique `elicitationId` the gateway gave each URL-mode input request key. */
		const urlElicitationIds = new Map<string, string>();

		for (let round = 0; ; round++) {
			const result = await this._invoke(ctx, () => invoke(this._invokeContext(ctx, method, inputResponses, requestState)));
			if (!isGatewayInputRequired(result)) {
				for (const elicitationId of askedUrlElicitations) {
					// The upstream no longer waits for the out-of-band flow: tell the legacy client.
					ctx.notify({ method: 'notifications/elicitation/complete', params: { elicitationId } });
				}
				return result;
			}
			const inputRequests = result.inputRequests ?? {};
			for (const [key, request] of Object.entries(inputRequests)) {
				const capability = requiredCapabilityForInputRequest(request.method, request.params);
				if (!capability) {
					throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `Upstream asked for an unsupported input request (${request.method}) in "${key}"`);
				}
				if (!hasClientCapability(ctx.clientCapabilities, capability)) {
					throw new McpGatewayRpcError(MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, `This request needs the client capability "${capability}", which the client did not declare`, { requiredCapabilities: requiredCapabilitiesFor(capability), capability, inputRequest: key });
				}
			}

			if (ctx.era === 'modern') {
				const out: MCP.InputRequiredResult = { resultType: 'input_required' };
				if (Object.keys(inputRequests).length > 0) {
					out.inputRequests = inputRequests;
				}
				if (result.requestState !== undefined) {
					out.requestState = this._sealedState.seal(result.requestState, aad);
				}
				return out;
			}

			// Legacy: ask the client ourselves and go again.
			if (!ctx.sendServerRequest) {
				throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'The upstream server needs input, but this connection cannot carry server requests');
			}
			if (round + 1 >= MAX_GATEWAY_INPUT_ROUNDS) {
				throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `The upstream server asked for input more than ${MAX_GATEWAY_INPUT_ROUNDS} times`);
			}
			const answers: MCP.InputResponses = {};
			const stillAsked = new Set<string>();
			for (const [key, request] of Object.entries(inputRequests)) {
				let requestParams: Record<string, unknown> = isObject(request.params) ? request.params as Record<string, unknown> : {};
				if (request.method === 'elicitation/create' && requestParams.mode === 'url') {
					// 2025-11-25 URL elicitations carry an id the client correlates `notifications/elicitation/complete` with;
					// the gateway assigns its own so ids never collide on the client's connection.
					let elicitationId = urlElicitationIds.get(key);
					if (elicitationId === undefined) {
						elicitationId = generateUuid();
						urlElicitationIds.set(key, elicitationId);
					}
					requestParams = { ...requestParams, elicitationId };
					stillAsked.add(elicitationId);
					askedUrlElicitations.add(elicitationId);
				}
				const answer = await ctx.sendServerRequest({ method: request.method, params: requestParams });
				if (!isObject(answer)) {
					throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `The client answered ${request.method} with a non-object result`);
				}
				answers[key] = answer as unknown as MCP.InputResponse;
			}
			for (const elicitationId of askedUrlElicitations) {
				if (!stillAsked.has(elicitationId)) {
					askedUrlElicitations.delete(elicitationId);
					ctx.notify({ method: 'notifications/elicitation/complete', params: { elicitationId } });
				}
			}
			inputResponses = answers;
			requestState = result.requestState;
		}
	}
}
