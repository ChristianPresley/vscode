/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { compileJsonSchema, isCompiledJsonSchema } from '../../../../base/common/jsonSchemaValidator/index.js';
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

/**
 * Checks the content a user supplied for a form elicitation against the
 * schema the server requested. A schema that does not compile is treated
 * as "accept anything" (the server asked for it; it can validate again).
 */
export function validateElicitFormContent(content: unknown, requestedSchema: unknown): ElicitFormContentValidation {
	const value = content === undefined ? {} : content;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, message: 'Elicitation content must be an object' };
	}
	const compiled = compileJsonSchema(requestedSchema);
	if (!isCompiledJsonSchema(compiled)) {
		return { ok: true, content: value as Record<string, unknown> };
	}
	const result = compiled.validate(value);
	if (!result.valid) {
		return { ok: false, message: result.errors.map(e => `${e.instancePath || '/'}: ${e.message}`).join('; ') };
	}
	return { ok: true, content: value as Record<string, unknown> };
}

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
