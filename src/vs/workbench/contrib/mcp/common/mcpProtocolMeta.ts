/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { checkJsonSchemaDocument, compileJsonSchema, dialectOfSchemaUri, ICompiledJsonSchema, IJsonSchemaCompileError, IJsonSchemaCompileOptions, IJsonSchemaDocumentCheck, IJsonSchemaValidationError, isCompiledJsonSchema, JsonSchemaDialect, PatternAnalysisBudget } from '../../../../base/common/jsonSchemaValidator/index.js';
import { localize } from '../../../../nls.js';
import { LogLevel } from '../../../../platform/log/common/log.js';
import { isInputRequiredResult } from '../../../../platform/mcp/common/mcpGatewayProtocol.js';
import { buildMirroredHeaders, McpHeaderAnnotation } from '../../../../platform/mcp/common/mcpHttpHeaders.js';
import { eraForProtocolVersion, McpProtocolEra, META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_LOG_LEVEL, META_PROTOCOL_VERSION } from '../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../platform/mcp/common/modelContextProtocol.js';
import { McpTasks } from '../../../../platform/mcp/common/modelContextProtocolTasks.js';
import { MCPLegacy } from '../../../../platform/mcp/common/modelContextProtocolLegacy.js';
import { IMcpMessageEnvelope, McpClientError } from './mcpTypes.js';

/**
 * Pure helpers for the 2026-07-28 client protocol engine: what the client
 * declares, what it stamps on every request, how it reads results, and how
 * it checks the inputs a server asks for. No services, no I/O.
 */

/** Rounds of `input_required` the client answers for one request before giving up. */
export const MAX_MRTR_ROUNDS = 10;
/** How long a stdio server may stay silent on the `server/discover` probe before the client falls back to `initialize`. */
export const PROBE_TIMEOUT_MS = 10_000;
/** How long a listen stream may stay silent before its acknowledgement is considered lost. */
export const LISTEN_ACK_TIMEOUT_MS = 10_000;
export const LISTEN_BACKOFF_MS = 500;
export const LISTEN_MAX_BACKOFF_MS = 30_000;
/** A listen stream that survives this long resets the reconnection backoff. */
export const LISTEN_STABLE_MS = 10_000;
/** A cached public list is reused across reconnects for at most this long, whatever the server's `ttlMs`. */
export const MAX_CACHED_LIST_TTL_MS = 86_400_000;
/** Resource reads are coalesced for at least the floor and at most the ceiling, around the server's `ttlMs`. */
export const RESOURCE_READ_CACHE_MS: readonly [floor: number, ceiling: number] = [3000, 60_000];
/**
 * How long a tool call of a server that announces tool list changes waits
 * after its result for a `tools/list_changed` the call caused, before the next
 * model turn (#261611): such a notification can arrive after the result (a
 * listen or GET stream is not ordered with the call's response, and some
 * servers notify after they answer).
 */
export const TOOL_LIST_CHANGE_GRACE_MS = 100;

export const MCP_UI_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const MCP_UI_MIME_TYPES = ['text/html;profile=mcp-app'];

export interface IMcpClientCapabilityOptions {
	readonly sampling: boolean;
	/** Declare `sampling.tools` (tool-use during sampling). Only honoured when `sampling` is true. */
	readonly samplingTools?: boolean;
	readonly elicitation: boolean;
	/** Declare the `io.modelcontextprotocol/tasks` extension (modern era only). */
	readonly tasks?: boolean;
}

/** The capabilities VS Code declares for a given era. */
export function buildClientCapabilities(era: 'modern', opts: IMcpClientCapabilityOptions): MCP.ClientCapabilities;
export function buildClientCapabilities(era: 'legacy', opts: IMcpClientCapabilityOptions): MCPLegacy.ClientCapabilities;
export function buildClientCapabilities(era: McpProtocolEra, opts: IMcpClientCapabilityOptions): MCP.ClientCapabilities | MCPLegacy.ClientCapabilities;
export function buildClientCapabilities(era: McpProtocolEra, opts: IMcpClientCapabilityOptions): MCP.ClientCapabilities | MCPLegacy.ClientCapabilities {
	if (era === 'modern') {
		const extensions: Record<string, MCP.JSONObject> = { [MCP_UI_EXTENSION_ID]: { mimeTypes: MCP_UI_MIME_TYPES } };
		if (opts.tasks) {
			extensions[McpTasks.EXTENSION_ID] = {};
		}
		const capabilities: MCP.ClientCapabilities = { roots: {}, extensions };
		if (opts.sampling) {
			capabilities.sampling = opts.samplingTools ? { tools: {} } : {};
		}
		if (opts.elicitation) {
			capabilities.elicitation = { form: {}, url: {} };
		}
		return capabilities;
	}
	return {
		roots: { listChanged: true },
		sampling: opts.sampling ? (opts.samplingTools ? { tools: {} } : {}) : undefined,
		elicitation: opts.elicitation ? { form: {}, url: {} } : undefined,
		tasks: {
			list: {},
			cancel: {},
			requests: {
				sampling: opts.sampling ? { createMessage: {} } : undefined,
				elicitation: opts.elicitation ? { create: {} } : undefined,
			},
		},
		extensions: { [MCP_UI_EXTENSION_ID]: { mimeTypes: MCP_UI_MIME_TYPES } },
	};
}

export interface IMcpRequestMetaBase {
	readonly protocolVersion: string;
	readonly clientInfo: MCP.Implementation;
	readonly clientCapabilities: MCP.ClientCapabilities;
	readonly logLevel?: MCP.LoggingLevel;
}

/**
 * The `_meta` of a modern request: the caller's keys first, then the reserved
 * MCP keys, which always win.
 */
export function buildRequestMeta(base: IMcpRequestMetaBase, callerMeta?: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const meta: Record<string, unknown> = { ...callerMeta };
	meta[META_PROTOCOL_VERSION] = base.protocolVersion;
	meta[META_CLIENT_CAPABILITIES] = base.clientCapabilities;
	meta[META_CLIENT_INFO] = base.clientInfo;
	if (base.logLevel !== undefined) {
		meta[META_LOG_LEVEL] = base.logLevel;
	} else {
		delete meta[META_LOG_LEVEL];
	}
	return meta;
}

/** The `resultType` of a result; a legacy result without one is `complete`. */
export function getResultType(result: unknown): string {
	if (typeof result === 'object' && result !== null) {
		const resultType = (result as { resultType?: unknown }).resultType;
		if (typeof resultType === 'string') {
			return resultType;
		}
	}
	return 'complete';
}

const INPUT_REQUEST_METHODS: ReadonlySet<string> = new Set(['elicitation/create', 'sampling/createMessage', 'roots/list']);

export interface IParsedInputRequired {
	readonly inputRequests: Readonly<Record<string, MCP.InputRequest>>;
	readonly requestState: string | undefined;
}

/**
 * Validates an `input_required` result: `inputRequests` is a map of
 * well-formed requests with one of the three input methods, `requestState`
 * is a string when present, and at least one of the two is present.
 */
export function parseInputRequiredResult(result: unknown): IParsedInputRequired | McpClientError {
	if (!isInputRequiredResult(result)) {
		return new McpClientError('invalid-result-type', 'Expected an input_required result');
	}
	const invalid = (message: string) => new McpClientError('invalid-input-request', message, result);
	const requestState = result.requestState;
	if (requestState !== undefined && typeof requestState !== 'string') {
		return invalid('requestState must be a string');
	}
	const inputRequests: Record<string, MCP.InputRequest> = {};
	if (result.inputRequests !== undefined) {
		if (typeof result.inputRequests !== 'object' || result.inputRequests === null || Array.isArray(result.inputRequests)) {
			return invalid('inputRequests must be an object');
		}
		for (const [key, request] of Object.entries(result.inputRequests)) {
			if (typeof request !== 'object' || request === null || typeof (request as { method?: unknown }).method !== 'string') {
				return invalid(`inputRequests["${key}"] must be a request object`);
			}
			if (!INPUT_REQUEST_METHODS.has(request.method)) {
				return invalid(`inputRequests["${key}"] uses the unsupported method ${request.method}`);
			}
			if (request.params !== undefined && (typeof request.params !== 'object' || request.params === null)) {
				return invalid(`inputRequests["${key}"] has invalid params`);
			}
			inputRequests[key] = request;
		}
	}
	if (requestState === undefined && Object.keys(inputRequests).length === 0) {
		return invalid('An input_required result must carry inputRequests or requestState');
	}
	return { inputRequests, requestState };
}

/** Maps VS Code log levels to MCP logging levels. */
export function mapLogLevelToMcp(logLevel: LogLevel): MCP.LoggingLevel {
	switch (logLevel) {
		case LogLevel.Trace:
			return 'debug'; // MCP doesn't have trace, use debug
		case LogLevel.Debug:
			return 'debug';
		case LogLevel.Info:
			return 'info';
		case LogLevel.Warning:
			return 'warning';
		case LogLevel.Error:
			return 'error';
		case LogLevel.Off:
			return 'emergency';
		default:
			return 'info';
	}
}

export type ElicitFormContentValidation =
	| { readonly ok: true; readonly content: Record<string, unknown> }
	| { readonly ok: false; readonly message: string };

export function describeCompileErrors(errors: readonly IJsonSchemaCompileError[]): string {
	return errors.map(e => e.path ? `${e.message} (at ${e.path})` : e.message).join('; ');
}

function describeValidationErrors(errors: readonly IJsonSchemaValidationError[]): string {
	return errors.map(e => `${e.instancePath || '/'}: ${e.message}`).join('; ');
}

//#region Server schemas

/**
 * Whether the JSON Schemas of a server speaking `protocolVersion` are read
 * leniently: true for the `initialize` revisions (2025-11-25 and older),
 * false for 2026-07-28 and for an unknown revision.
 */
export function readsSchemasLeniently(protocolVersion: string | undefined): boolean {
	return protocolVersion !== undefined && eraForProtocolVersion(protocolVersion) === 'legacy';
}

interface IServerSchemaDialects {
	readonly options: IJsonSchemaCompileOptions;
	/** Tried for a schema that does not name a supported dialect and does not compile with {@link options}. */
	readonly alternative?: IJsonSchemaCompileOptions;
}

/**
 * How the schemas a server sends (tool input and output schemas, form
 * elicitations) are compiled for the revision it speaks.
 *
 * 2026-07-28 (basic/index.mdx "JSON Schema Usage"): 2020-12 unless `$schema`
 * says otherwise, and an unsupported dialect is an error.
 *
 * 2025-11-25 and older keep the behaviour from before 2026-07-28 support, when
 * no tool was refused for its dialect: an unsupported `$schema` is a warning
 * and the schema is read in the default dialect, and a schema that does not
 * compile in the default dialect is read in the other supported one (servers
 * of that era send both without `$schema`). The default is 2020-12 for
 * 2025-11-25, whose schema says so ("Defaults to JSON Schema 2020-12 when no
 * explicit `$schema` is provided"), and draft-07, which VS Code assumed, for
 * the older revisions.
 */
function serverSchemaDialects(protocolVersion: string | undefined): IServerSchemaDialects {
	if (protocolVersion === undefined || !readsSchemasLeniently(protocolVersion)) {
		return { options: { dialect: '2020-12', unsupportedDialect: 'error' } };
	}
	const dialect: JsonSchemaDialect = protocolVersion >= '2025-11-25' ? '2020-12' : 'draft-07';
	return {
		options: { dialect, unsupportedDialect: 'warn' },
		alternative: { dialect: dialect === '2020-12' ? 'draft-07' : '2020-12', unsupportedDialect: 'warn' },
	};
}

function namesSupportedDialect(schema: unknown): boolean {
	const declared = typeof schema === 'object' && schema !== null ? (schema as { $schema?: unknown }).$schema : undefined;
	return typeof declared === 'string' && dialectOfSchemaUri(declared) !== undefined;
}

/** The {@link serverSchemaDialects} of a revision, with the pattern analysis budget the schema shares with others, if any. */
function serverSchemaOptions(protocolVersion: string | undefined, sharedPatternAnalysisBudget: PatternAnalysisBudget | undefined): IServerSchemaDialects {
	const dialects = serverSchemaDialects(protocolVersion);
	if (!sharedPatternAnalysisBudget) {
		return dialects;
	}
	return {
		options: { ...dialects.options, sharedPatternAnalysisBudget },
		alternative: dialects.alternative && { ...dialects.alternative, sharedPatternAnalysisBudget },
	};
}

/**
 * Compiles a schema a server sent with the rules of its revision (see
 * {@link serverSchemaDialects}). `sharedPatternAnalysisBudget` bounds the
 * analysis of its patterns together with the other schemas that share it
 * (those of one tool list).
 */
export function compileServerSchema(schema: unknown, protocolVersion: string | undefined, sharedPatternAnalysisBudget?: PatternAnalysisBudget): ICompiledJsonSchema | IJsonSchemaCompileError[] {
	const { options, alternative } = serverSchemaOptions(protocolVersion, sharedPatternAnalysisBudget);
	const compiled = compileJsonSchema(schema, options);
	if (isCompiledJsonSchema(compiled) || !alternative || namesSupportedDialect(schema)) {
		return compiled;
	}
	const retried = compileJsonSchema(schema, alternative);
	return isCompiledJsonSchema(retried) ? retried : compiled;
}

/**
 * Checks a schema document a server sent (a tool's `inputSchema`) with the
 * rules of its revision (see {@link serverSchemaDialects}).
 *
 * 2025-11-25 and older: a tool was kept before 2026-07-28 support when its
 * input schema had a problem confined to the document (an unresolved local
 * `$ref`, a `$id` with a fragment, an anchor that is not a plain name), so a
 * schema that is otherwise usable is kept with such problems as warnings: the
 * reference asserts nothing and the identifier is ignored. This reading is
 * only tried after the strict one, in either dialect, failed. Remote
 * references and limits stay errors.
 *
 * `sharedPatternAnalysisBudget`: see {@link compileServerSchema}.
 */
export function checkServerSchemaDocument(schema: unknown, protocolVersion: string | undefined, sharedPatternAnalysisBudget?: PatternAnalysisBudget): IJsonSchemaDocumentCheck {
	const { options, alternative } = serverSchemaOptions(protocolVersion, sharedPatternAnalysisBudget);
	const check = checkJsonSchemaDocument(schema, options);
	if (!check.errors.length || !alternative) {
		return check;
	}
	const tryAlternative = !namesSupportedDialect(schema);
	if (tryAlternative) {
		const retried = checkJsonSchemaDocument(schema, alternative);
		if (!retried.errors.length) {
			return retried;
		}
	}
	const lenient = checkJsonSchemaDocument(schema, { ...options, localReferenceProblems: 'warn' });
	if (!lenient.errors.length || !tryAlternative) {
		return lenient;
	}
	const lenientAlternative = checkJsonSchemaDocument(schema, { ...alternative, localReferenceProblems: 'warn' });
	return lenientAlternative.errors.length ? lenient : lenientAlternative;
}

/** The schemas of a tool a server lists. */
export interface IServerToolSchemas {
	readonly inputSchema: unknown;
	readonly outputSchema?: unknown;
}

/** The schemas of a tool, as {@link checkServerToolSchemas} read them. */
export interface IServerToolSchemaCheck {
	/** See {@link checkServerSchemaDocument}. */
	readonly input: IJsonSchemaDocumentCheck;
	/** The compiled output schema, or why it does not compile (see {@link compileServerSchema}); undefined for a tool without one. */
	readonly output: ICompiledJsonSchema | IJsonSchemaCompileError[] | undefined;
}

function hasOutputSchema(outputSchema: unknown): boolean {
	return outputSchema !== undefined && outputSchema !== null;
}

/**
 * Reads the schemas of one tool of a list a server sent with the rules of its
 * revision: the input schema, then the output schema. The tools of a list are
 * read in the order of the list with one `sharedPatternAnalysisBudget`, so
 * that a list of many tools with distinct adversarial patterns takes no more
 * analysis than one schema may. The outcome depends only on the schemas,
 * their order and the revision (an analysis made earlier costs what it took),
 * so a list read again this way gets what it got the first time, the patterns
 * beyond its budget included.
 */
export function checkServerToolSchemas(tool: IServerToolSchemas, protocolVersion: string | undefined, sharedPatternAnalysisBudget: PatternAnalysisBudget): IServerToolSchemaCheck {
	return {
		input: checkServerSchemaDocument(tool.inputSchema, protocolVersion, sharedPatternAnalysisBudget),
		output: hasOutputSchema(tool.outputSchema) ? compileServerSchema(tool.outputSchema, protocolVersion, sharedPatternAnalysisBudget) : undefined,
	};
}

/**
 * Why the `requestedSchema` of a form elicitation cannot be used, or
 * `undefined` when it can (or is absent: such a form asks for consent
 * alone). 2026-07-28 (basic/index.mdx): an unsupported dialect MUST be
 * answered with an error, and a schema with an unresolved external `$ref`
 * SHOULD be rejected rather than treated as permissive, so the client
 * declines such a form instead of showing it unvalidated. A server speaking
 * 2025-11-25 or older gets its form shown as before, unvalidated, with a
 * warning. Problems that do not prevent the form (a `pattern` that is not
 * checked, a tolerated dialect) are reported through `onWarning`.
 */
export function checkElicitationSchema(requestedSchema: unknown, protocolVersion?: string, onWarning?: (message: string) => void): string | undefined {
	if (requestedSchema === undefined) {
		return undefined;
	}
	const compiled = compileServerSchema(requestedSchema, protocolVersion);
	if (isCompiledJsonSchema(compiled)) {
		if (compiled.warnings.length) {
			onWarning?.(describeCompileErrors(compiled.warnings));
		}
		return undefined;
	}
	if (readsSchemasLeniently(protocolVersion)) {
		onWarning?.(`the requested schema does not compile, so the answer is not checked against it: ${describeCompileErrors(compiled)}`);
		return undefined;
	}
	return describeCompileErrors(compiled);
}

/**
 * Checks the content a user supplied for a form elicitation against the
 * schema the server requested. A schema that does not compile rejects any
 * content: it cannot vouch for it (see {@link checkElicitationSchema}); for
 * a server speaking 2025-11-25 or older the content is accepted as before.
 */
export function validateElicitFormContent(content: unknown, requestedSchema: unknown, protocolVersion?: string): ElicitFormContentValidation {
	const value = content === undefined ? {} : content;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, message: 'Elicitation content must be an object' };
	}
	const compiled = compileServerSchema(requestedSchema, protocolVersion);
	if (!isCompiledJsonSchema(compiled)) {
		if (readsSchemasLeniently(protocolVersion)) {
			return { ok: true, content: value as Record<string, unknown> };
		}
		return { ok: false, message: `The requested schema does not compile: ${describeCompileErrors(compiled)}` };
	}
	const result = compiled.validate(value);
	if (!result.valid) {
		return { ok: false, message: describeValidationErrors(result.errors) };
	}
	return { ok: true, content: value as Record<string, unknown> };
}

export type StructuredContentCheck =
	/** Nothing to check, or the structured content matches the output schema. */
	| { readonly kind: 'ok' }
	/** The structured content does not match the output schema: a server-side protocol error. */
	| { readonly kind: 'mismatch'; readonly detail: string; readonly errors: readonly IJsonSchemaValidationError[] }
	/** The output schema does not compile (2026-07-28); `result` is the error result that replaces the unvalidated one. */
	| { readonly kind: 'invalid-schema'; readonly problem: string; readonly result: MCPLegacy.CallToolResult }
	/** The output schema does not compile (2025-11-25 and older): the result is used unchecked, as before. */
	| { readonly kind: 'unchecked'; readonly problem: string };

/**
 * Checks the `structuredContent` of a tool result against the tool's
 * `outputSchema`. Nothing is checked without a schema, for an `isError`
 * result or for a result without structured content. For a 2026-07-28
 * server, an output schema that does not compile (an unsupported dialect, an
 * unresolved external `$ref`) cannot vouch for the content, and
 * basic/index.mdx wants an error for an unsupported dialect and such schemas
 * rejected rather than treated as permissive: the result is replaced by an
 * `isError` result that tells the model why, instead of handing it
 * unvalidated structured content. For a server speaking 2025-11-25 or older
 * the result is used unchecked, as before.
 *
 * `listedOutputSchema` gives `outputSchema` as the tool list it came with read
 * it ({@link checkServerToolSchemas}), for `protocolVersion`: the patterns of
 * the schemas of a list share an analysis budget, and a pattern the list does
 * not check (one beyond that budget) must not be checked for a call either.
 * Without it, or when it gives nothing, the schema is compiled on its own.
 */
export function checkStructuredContent(toolName: string, outputSchema: unknown, result: MCPLegacy.CallToolResult, protocolVersion?: string, listedOutputSchema?: () => ICompiledJsonSchema | IJsonSchemaCompileError[] | undefined): StructuredContentCheck {
	if (!hasOutputSchema(outputSchema) || result.isError || result.structuredContent === undefined) {
		return { kind: 'ok' };
	}
	const compiled = listedOutputSchema?.() ?? compileServerSchema(outputSchema, protocolVersion);
	if (!isCompiledJsonSchema(compiled)) {
		const problem = describeCompileErrors(compiled);
		if (readsSchemasLeniently(protocolVersion)) {
			return { kind: 'unchecked', problem };
		}
		return {
			kind: 'invalid-schema',
			problem,
			result: {
				isError: true,
				content: [{ type: 'text', text: localize('mcp.outputSchemaInvalid', "The result of tool \"{0}\" was discarded: its output schema cannot be used to validate it ({1}).", toolName, problem) }],
			},
		};
	}
	const validation = compiled.validate(result.structuredContent);
	if (!validation.valid) {
		return { kind: 'mismatch', detail: describeValidationErrors(validation.errors), errors: validation.errors };
	}
	return { kind: 'ok' };
}

//#endregion

export interface IElicitationUrlCheck {
	/** https, or http to a loopback host, without credentials. */
	readonly ok: boolean;
	/** The host is an internationalized domain name (or carries non-ASCII): show both forms. */
	readonly isIdn: boolean;
	readonly hostname: string;
	readonly reason?: string;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The URL-mode elicitation safety check (elicitation.mdx: scheme, loopback and IDN rules). */
export function isAcceptableElicitationUrl(url: string): IElicitationUrlCheck {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, isIdn: false, hostname: '', reason: 'not a valid URL' };
	}
	const hostname = parsed.hostname.toLowerCase();
	const isIdn = hostname.includes('xn--') || /[^\x00-\x7f]/.test(url);
	if (parsed.username !== '' || parsed.password !== '') {
		return { ok: false, isIdn, hostname, reason: 'the URL carries credentials' };
	}
	if (parsed.protocol === 'https:') {
		return { ok: true, isIdn, hostname };
	}
	if (parsed.protocol === 'http:' && (LOOPBACK_HOSTS.has(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname))) {
		return { ok: true, isIdn, hostname };
	}
	return { ok: false, isIdn, hostname, reason: `the scheme ${parsed.protocol.replace(':', '')} is not allowed` };
}

/**
 * Builds the envelope for an outgoing message. Mirrored headers are computed
 * for modern messages only; legacy traffic carries the version alone.
 */
export function buildEnvelope(kind: IMcpMessageEnvelope['kind'], requestId: JsonRpcId | undefined, protocolVersion: string, method: string, params: unknown, annotations?: ReadonlyMap<string, readonly McpHeaderAnnotation[]>, deadlineMs?: number): IMcpMessageEnvelope {
	const modern = eraForProtocolVersion(protocolVersion) !== 'legacy';
	let headers: Record<string, string> | undefined;
	if (modern && method !== 'notifications/cancelled' && !method.startsWith('notifications/')) {
		const toolName = method === 'tools/call' && typeof params === 'object' && params !== null ? (params as { name?: unknown }).name : undefined;
		const toolAnnotations = typeof toolName === 'string' ? annotations?.get(toolName) : undefined;
		headers = buildMirroredHeaders(method, params, toolAnnotations);
	}
	return { kind, requestId, protocolVersion, method, headers, deadlineMs };
}

/** Events the engine reports for telemetry (published by the server wrapper, which owns the telemetry service). */
export type McpProtocolEvent =
	| { readonly kind: 'negotiation'; readonly era: McpProtocolEra; readonly protocolVersion: string; readonly durationMs: number; readonly probeTimedOut: boolean; readonly usedHint: boolean }
	| { readonly kind: 'renegotiation'; readonly code: number; readonly retried: boolean }
	| { readonly kind: 'mrtr'; readonly method: string; readonly rounds: number; readonly inputKinds: readonly string[] }
	| { readonly kind: 'listen-reconnect'; readonly stream: 'lists' | 'resources'; readonly reason: string; readonly backoffMs: number };
