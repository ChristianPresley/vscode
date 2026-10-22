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
import { applyModernEnvelope, clientCapabilitiesOf, GATEWAY_SERVER_INFO, hasClientCapability, honorSubscriptionFilter, IModernRequestMeta, McpGatewayRpcError, McpInputRequestCapability, requiredCapabilitiesForInputRequest, unsupportedProtocolVersionHeader, validateInputResponses, validateModernRequestMeta, validateStandardHeaders } from '../common/mcpGatewayProtocol.js';
import { LATEST_MCP_PROTOCOL_VERSION, McpProtocolEra, MODERN_MCP_PROTOCOL_VERSIONS } from '../common/mcpProtocolVersions.js';
import { MCP_PROTOCOL_VERSION_HEADER, trimOws } from '../common/mcpHttpHeaders.js';
import { MCP } from '../common/modelContextProtocol.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';
import { McpSkills } from '../common/modelContextProtocolSkills.js';
import { McpTasks } from '../common/modelContextProtocolTasks.js';
import { IMcpGatewayRateLimits, McpGatewayRateLimitedError, McpGatewayRateLimiter } from './mcpGatewayRateLimit.js';
import { McpGatewaySealedState } from './mcpGatewaySealedState.js';
import { clientDeclaresTasks, IMcpGatewayTaskInvokeContext, IMcpGatewayTaskOptions, IMcpGatewayTaskOrigin, IMcpGatewayTaskRunInput, isStartTaskResult, McpGatewayTaskBody, McpGatewayTaskStore, missingTasksExtensionError, taskOptionsOf, taskOriginOf, taskSupportOf, withoutTaskSupport } from './mcpGatewayTasks.js';

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
	/** 2025-11-25 sessions: closes the request's SSE stream for polling (see {@link IMcpGatewayInvokeContext.closeSseStream}). */
	readonly closeSseStream?: () => void;
	readonly chatSessionResource?: string;
	/**
	 * Who sent the request, for the rate limits ({@link IMcpGatewayDispatcherOptions.rateLimits}):
	 * requests with the same key share their buckets. Undefined: the route's one shared key.
	 */
	readonly clientKey?: string;
}

export interface IMcpGatewayDispatcherOptions {
	/** Overrides the capabilities the gateway advertises (the conformance fixture advertises everything). */
	readonly capabilities?: IMcpGatewayServerCapabilities;
	readonly serverInfo?: MCP.Implementation;
	readonly cacheHints?: IMcpGatewayCacheHints;
	readonly instructions?: string;
	/**
	 * Serves the Tasks extension (`io.modelcontextprotocol/tasks`) on the
	 * 2026-07-28 wire; defaults to the invoker's own task options (an
	 * {@link IMcpGatewayTaskCapableInvoker}). Without either, no task is created.
	 */
	readonly tasks?: IMcpGatewayTaskOptions;
	/**
	 * The per-client limits of `tools/call` and `completion/complete` on this
	 * route, for both eras and every transport; absent limits have their
	 * defaults (`DEFAULT_MCP_GATEWAY_RATE_LIMITS`). A request over its
	 * limit gets {@link McpGatewayRateLimitedError} and never reaches the server.
	 */
	readonly rateLimits?: IMcpGatewayRateLimits;
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

/**
 * The `-32021` error of an input request that needs client capabilities the
 * client did not declare: `data.requiredCapabilities` lists the missing ones
 * (basic: "lists the missing capabilities"). 2025-11-25 sessions get the same
 * error, before the gateway sends anything to the client: the bridge never
 * asks a client for what it cannot answer.
 */
export function missingClientCapabilityError(method: string, inputRequest: string, missing: readonly McpInputRequestCapability[]): McpGatewayRpcError {
	const names = missing.map(capability => `"${capability}"`).join(', ');
	return new McpGatewayRpcError(
		MCP.MISSING_REQUIRED_CLIENT_CAPABILITY,
		`The upstream server asked the client for ${method} ("${inputRequest}"), which needs the client ${missing.length === 1 ? 'capability' : 'capabilities'} ${names}; the client did not declare ${missing.length === 1 ? 'it' : 'them'}`,
		{ requiredCapabilities: clientCapabilitiesOf(missing), capability: missing[missing.length - 1], inputRequest },
	);
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
	private _tools: Map<string, MCPLegacy.Tool> | undefined;
	private readonly _serverInfo: MCP.Implementation;
	/** The tasks of this route; undefined when the route serves no Tasks extension. */
	private readonly _tasks: McpGatewayTaskStore | undefined;
	private readonly _rateLimiter: McpGatewayRateLimiter;

	constructor(
		private readonly _routeId: string,
		private readonly _logger: ILogger,
		private readonly _invoker: IMcpGatewaySingleServerInvoker,
		private readonly _sealedState: McpGatewaySealedState,
		private readonly _options: IMcpGatewayDispatcherOptions = {},
	) {
		super();
		this._serverInfo = _options.serverInfo ?? GATEWAY_SERVER_INFO;
		this._rateLimiter = new McpGatewayRateLimiter(_options.rateLimits);
		this._register(_invoker.onDidChangeTools(() => { this._tools = undefined; }));
		const taskOptions = _options.tasks ?? taskOptionsOf(_invoker);
		this._tasks = taskOptions ? this._register(new McpGatewayTaskStore(taskOptions, _logger, `[McpGateway][route ${_routeId}]`)) : undefined;
	}

	/** The task store of the route (tests and diagnostics); undefined without the Tasks extension. */
	get tasks(): McpGatewayTaskStore | undefined {
		return this._tasks;
	}

	get serverInfo(): MCP.Implementation {
		return this._serverInfo;
	}

	get cacheHints(): IMcpGatewayCacheHints {
		return this._options.cacheHints ?? this._invoker.cacheHints ?? DEFAULT_CACHE_HINTS;
	}

	/**
	 * The capabilities the gateway advertises for this server, in the
	 * 2026-07-28 shape. One rule for both eras (`server/discover` and the
	 * legacy `initialize`): a capability is advertised exactly when the
	 * gateway serves its methods ({@link supportsMethod}). Declared
	 * capabilities (dispatcher options, then the invoker's) win; otherwise
	 * they are derived from the invoker's methods. A declared capability
	 * whose method the invoker lacks is served empty (no prompts, no
	 * completion values) rather than refused.
	 */
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
		const extensions: Record<string, MCP.JSONObject> = {};
		if (this._tasks) {
			// SEP-2663: under `extensions`, never the 2025-11-25 `capabilities.tasks` slot.
			extensions[McpTasks.EXTENSION_ID] = {};
		}
		const skills = this._skillsSettings();
		if (skills) {
			// SEP-2640: the settings sit inline under the id; an empty object declares no optional feature.
			extensions[McpSkills.EXTENSION_ID] = skills.directoryRead ? { directoryRead: true } : {};
		}
		if (Object.keys(extensions).length > 0) {
			caps.extensions = extensions;
		}
		return caps;
	}

	/**
	 * The Skills extension (SEP-2640) is served when the invoker can list and
	 * get skills, and, if it reports capabilities, reports the extension
	 * (the gateway passes the upstream server's skills through). Declaring it
	 * commits the route to `skills/list` and `skills/get`; `directoryRead`
	 * additionally needs `readDirectory`. `resources` is always advertised.
	 */
	private _skillsSettings(): McpSkills.ServerSettings | undefined {
		const declared = this._options.capabilities ?? this._invoker.capabilities;
		if (!this._invoker.listSkills || !this._invoker.getSkill || (declared && !declared.skills)) {
			return undefined;
		}
		return { directoryRead: !!this._invoker.readDirectory && (declared ? !!declared.skills?.directoryRead : true) };
	}

	/**
	 * The legacy `initialize` capabilities: the same ones as
	 * {@link serverCapabilities}, in the 2025-11-25 shape. SDK clients that
	 * enforce capabilities then allow exactly the calls the gateway serves
	 * (`logging/setLevel` with `logging`, `resources/subscribe` with
	 * `resources.subscribe`, `completion/complete` with `completions`). The
	 * Tasks extension is a 2026-07-28 surface (its methods are not served to
	 * legacy sessions), so it is not announced here.
	 */
	legacyInitializeCapabilities(): MCPLegacy.ServerCapabilities {
		const caps = this.serverCapabilities();
		const legacy: MCPLegacy.ServerCapabilities = {};
		if (caps.tools) {
			legacy.tools = { listChanged: caps.tools.listChanged };
		}
		if (caps.resources) {
			legacy.resources = { subscribe: caps.resources.subscribe, listChanged: caps.resources.listChanged };
		}
		if (caps.prompts) {
			legacy.prompts = { listChanged: caps.prompts.listChanged };
		}
		if (caps.logging) {
			legacy.logging = {};
		}
		if (caps.completions) {
			legacy.completions = {};
		}
		const extensions = caps.extensions ? Object.entries(caps.extensions).filter(([id]) => id !== McpTasks.EXTENSION_ID) : [];
		if (extensions.length > 0) {
			legacy.extensions = Object.fromEntries(extensions) as MCPLegacy.ServerCapabilities['extensions'];
		}
		return legacy;
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
			case 'tasks/get':
			case 'tasks/update':
			case 'tasks/cancel':
				// `tasks/list` and `tasks/result` were removed by SEP-2663: -32601 like any unknown method.
				return era === 'modern' && !!this._tasks;
			case McpSkills.METHOD_LIST:
			case McpSkills.METHOD_GET:
				return !!this._skillsSettings();
			case McpSkills.METHOD_DIRECTORY_READ:
				return !!this._skillsSettings()?.directoryRead;
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
		// A version header of another revision on a body without a _meta version (the gRPC
		// tunnel, where no era is chosen first) gets -32022 rather than the missing _meta.
		const headerVersionError = unsupportedProtocolVersionHeader(headers, request, MODERN_MCP_PROTOCOL_VERSIONS);
		if (headerVersionError) {
			return { ok: false, error: headerVersionError };
		}
		const meta = validateModernRequestMeta(request);
		if (!meta.ok) {
			if (meta.error.code === MCP.UNSUPPORTED_PROTOCOL_VERSION) {
				// An unsupported revision is judged before the other mirrored headers, so a
				// client of another revision learns the supported ones and can renegotiate
				// (the order of zig-sdk 0.6.0). A version header that is missing, malformed
				// or disagrees with the body is still a mismatch first.
				const requested = (meta.error.data as { requested: string }).requested;
				const rawVersion = headers[MCP_PROTOCOL_VERSION_HEADER.toLowerCase()];
				if (rawVersion === undefined || trimOws(rawVersion) !== requested) {
					const headerError = validateStandardHeaders(headers, request, requested);
					if (headerError) {
						return { ok: false, error: headerError };
					}
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

	/** The rate limits of the route (tests and diagnostics). */
	get rateLimiter(): McpGatewayRateLimiter {
		return this._rateLimiter;
	}

	/**
	 * Runs a request. Returns the result object (enveloped for modern
	 * clients); throws {@link McpGatewayRpcError}, and
	 * {@link McpGatewayRateLimitedError} before anything runs when the
	 * client is over the method's rate limit.
	 */
	async dispatch(ctx: IMcpGatewayDispatchContext, method: string, params: unknown): Promise<object> {
		if (!this.supportsMethod(method, ctx.era)) {
			throw new McpGatewayRpcError(MCP.METHOD_NOT_FOUND, `Method not found: ${method}`);
		}
		const decision = this._rateLimiter.take(method, ctx.clientKey ?? '');
		if (!decision.admitted) {
			if (decision.first) {
				this._logger.warn(decision.scope === 'route'
					? `[McpGateway][route ${this._routeId}] Rate limit: the route is over its route-wide limit, refusing ${method} requests of every client for now (retry in ${decision.retryAfterMs} ms)`
					: `[McpGateway][route ${this._routeId}] Rate limit: refusing ${method} requests of a client for now (retry in ${decision.retryAfterMs} ms)`);
			}
			throw new McpGatewayRateLimitedError(method, decision.retryAfterMs, decision.scope);
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
				this._tools = new Map(tools.map(t => [t.name, t]));
				// The gateway runs tasks on the 2026-07-28 wire only: legacy sessions see no task support.
				const listed = ctx.era === 'legacy' && this._tasks ? tools.map(withoutTaskSupport) : tools;
				return { tools: [...listed] } satisfies MCPLegacy.ListToolsResult;
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
				const tasks = this._tasks;
				const taskSupport = tasks && ctx.era === 'modern' ? taskSupportOf(await this._toolDefinition(name)) : undefined;
				// Per request (SEP-2575): the extension in this request's `_meta.clientCapabilities` opts in.
				const optedIn = !!taskSupport && clientDeclaresTasks(ctx.clientCapabilities);
				if (taskSupport === 'required' && !optedIn) {
					throw missingTasksExtensionError();
				}
				return this._withInputRounds(ctx, method, name, params, async (invokeCtx): Promise<MCPLegacy.CallToolResult | McpTasks.CreateTaskResult | IMcpGatewayInputRequired> => {
					const result = await this._invoker.callTool(name, args, invokeCtx);
					if (!isStartTaskResult(result)) {
						return result;
					}
					if (tasks && optedIn) {
						// The task outlives this request: its body keeps copies of plain values, never the request context.
						return tasks.create(name, this._taskBody(name, args, taskOriginOf(invokeCtx)), { inputResponses: invokeCtx.inputResponses, requestState: invokeCtx.requestState });
					}
					// No task for this request: the body runs at once, inside the request.
					const synthetic: IMcpGatewayTaskInvokeContext = { ...invokeCtx, task: { taskId: generateUuid(), synthetic: true } };
					const body = await this._invoker.callTool(name, args, synthetic);
					if (isStartTaskResult(body)) {
						throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `The tool ${name} asked for a task inside its task`);
					}
					return body;
				});
			}
			case 'tasks/get':
			case 'tasks/update':
			case 'tasks/cancel':
				return this._dispatchTaskMethod(ctx, method, params);
			case 'prompts/list': {
				this._checkCursor(params);
				const listPrompts = this._invoker.listPrompts;
				// Prompts are advertised (declared) but the invoker cannot list them: there are none.
				const prompts = listPrompts ? await this._invoke(ctx, () => listPrompts.call(this._invoker)) : [];
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
				const getPrompt = this._invoker.getPrompt;
				if (!getPrompt) {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, `Unknown prompt: ${name}`);
				}
				return this._withInputRounds(ctx, method, name, params, invokeCtx => getPrompt.call(this._invoker, name, args, invokeCtx));
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
			case McpSkills.METHOD_LIST: {
				this._checkCursor(params);
				const listSkills = this._invoker.listSkills!;
				const skills = await this._invoke(ctx, () => listSkills.call(this._invoker));
				return { skills: [...skills] } satisfies Pick<McpSkills.ListSkillsResult, 'skills'>;
			}
			case McpSkills.METHOD_GET: {
				if (typeof params.uri !== 'string') {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing skill URI');
				}
				const uri = params.uri;
				const getSkill = this._invoker.getSkill!;
				const skill = await this._invoke(ctx, () => getSkill.call(this._invoker, uri));
				if (!skill) {
					// The code `resources/read` uses for an unknown resource, in both eras (SEP-2640).
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, `Unknown skill: ${uri}`, { uri });
				}
				return { skill } satisfies Pick<McpSkills.GetSkillResult, 'skill'>;
			}
			case McpSkills.METHOD_DIRECTORY_READ: {
				if (typeof params.uri !== 'string') {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing directory URI');
				}
				this._checkCursor(params);
				const uri = params.uri;
				const readDirectory = this._invoker.readDirectory!;
				const resources = await this._invoke(ctx, () => readDirectory.call(this._invoker, uri));
				if (!resources) {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, `Not a directory resource: ${uri}`, { uri });
				}
				return { resources: [...resources] };
			}
			case 'completion/complete': {
				if (!isObject(params.ref) || !isObject(params.argument)) {
					throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing completion ref or argument');
				}
				const completeParams = params as unknown as MCPLegacy.CompleteRequest['params'];
				const complete = this._invoker.complete;
				if (!complete) {
					// Completions are advertised (declared) but the invoker cannot complete: no suggestions.
					return { completion: { values: [], total: 0, hasMore: false } } satisfies MCPLegacy.CompleteResult;
				}
				return this._invoke(ctx, () => complete.call(this._invoker, completeParams, this._invokeContext(ctx, method, undefined, undefined)));
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
		return (await this._toolDefinition(name))?.inputSchema;
	}

	/** The listed definition of a tool (header annotations, task support); undefined when the tools cannot be listed. */
	private async _toolDefinition(name: string): Promise<MCPLegacy.Tool | undefined> {
		if (!this._tools) {
			try {
				const tools = await this._invoker.listTools();
				this._tools = new Map(tools.map(t => [t.name, t]));
			} catch (e) {
				this._logger.warn(`[McpGateway][route ${this._routeId}] Could not list tools to verify headers: ${e}`);
				return undefined;
			}
		}
		return this._tools.get(name);
	}

	/** `tasks/get`, `tasks/update` and `tasks/cancel`: gated on the extension in this request's `_meta.clientCapabilities`. */
	private _dispatchTaskMethod(ctx: IMcpGatewayDispatchContext, method: string, params: Record<string, unknown>): object {
		const tasks = this._tasks;
		if (!tasks) {
			throw new McpGatewayRpcError(MCP.METHOD_NOT_FOUND, `Method not found: ${method}`);
		}
		if (!clientDeclaresTasks(ctx.clientCapabilities)) {
			throw missingTasksExtensionError();
		}
		const taskId = params.taskId;
		if (typeof taskId !== 'string') {
			throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Missing taskId');
		}
		switch (method) {
			case 'tasks/get':
				return tasks.get(taskId);
			case 'tasks/update': {
				const responsesError = validateInputResponses(params.inputResponses);
				if (responsesError) {
					throw responsesError;
				}
				tasks.update(taskId, (params.inputResponses ?? {}) as MCP.InputResponses);
				return {};
			}
			default:
				tasks.cancel(taskId);
				return {};
		}
	}

	/**
	 * The body of a task, kept by the task store until the task's TTL. Built in
	 * its own method so that the closure's scope holds only these arguments:
	 * a closure created inside {@link _dispatchInner} would keep that
	 * function's whole scope alive, the dispatch context (`notify`, headers,
	 * the response stream) included.
	 */
	private _taskBody(name: string, args: Record<string, unknown>, origin: IMcpGatewayTaskOrigin): McpGatewayTaskBody {
		return run => this._runTaskBody(name, args, origin, run);
	}

	/**
	 * One run of a task body: the tool again, inside its task, with the answers
	 * collected so far. Its progress and log messages have no stream to go to
	 * (the request that created the task is over) and are dropped. An input
	 * request the creating client cannot answer fails the task with `-32021`.
	 */
	private async _runTaskBody(name: string, args: Record<string, unknown>, origin: IMcpGatewayTaskOrigin, run: IMcpGatewayTaskRunInput): Promise<MCPLegacy.CallToolResult | IMcpGatewayInputRequired> {
		const context: IMcpGatewayTaskInvokeContext = {
			...origin,
			inputResponses: run.inputResponses,
			requestState: run.requestState,
			token: run.token,
			task: { taskId: run.taskId, synthetic: false },
		};
		const result = await this._invoker.callTool(name, args, context);
		if (isGatewayInputRequired(result)) {
			this._checkInputRequests(origin.clientCapabilities, result.inputRequests ?? {});
		}
		return result;
	}

	/**
	 * Every input request must be one the client can answer: else `-32603`
	 * (unknown kind) or `-32021` ({@link missingClientCapabilityError}), for
	 * instance a tool-enabled sampling request to a client without
	 * `sampling.tools`.
	 */
	private _checkInputRequests(clientCapabilities: MCP.ClientCapabilities, inputRequests: MCP.InputRequests): void {
		for (const [key, request] of Object.entries(inputRequests)) {
			const required = requiredCapabilitiesForInputRequest(request.method, request.params);
			if (!required) {
				throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `Upstream asked for an unsupported input request (${request.method}) in "${key}"`);
			}
			const missing = required.filter(capability => !hasClientCapability(clientCapabilities, capability));
			if (missing.length > 0) {
				throw missingClientCapabilityError(request.method, key, missing);
			}
		}
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
			closeSseStream: ctx.closeSseStream,
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
			this._checkInputRequests(ctx.clientCapabilities, inputRequests);

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
