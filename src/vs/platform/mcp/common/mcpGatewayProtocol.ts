/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IJsonRpcError, IJsonRpcRequest, JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { isHeaderSafeAscii, MCP_PROTOCOL_VERSION_HEADER, trimOws, verifyMirroredHeaders } from './mcpHttpHeaders.js';
import { eraForProtocolVersion, LEGACY_MCP_PROTOCOL_VERSIONS, META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_LOG_LEVEL, META_PROGRESS_TOKEN, META_PROTOCOL_VERSION, META_SERVER_INFO, McpProtocolEra, MODERN_MCP_PROTOCOL_VERSIONS } from './mcpProtocolVersions.js';
import { MCP } from './modelContextProtocol.js';

/**
 * Pure helpers for VS Code acting as an MCP *server* (the gateway): how a
 * request is classified into a protocol era, how a modern request's `_meta`
 * is validated, how JSON-RPC errors map to HTTP statuses, how results get
 * their modern envelope and which hosts/origins a loopback gateway accepts.
 * No I/O, no Node, no DOM.
 */

export const GATEWAY_SERVER_INFO: MCP.Implementation = { name: 'VS Code MCP Gateway', version: '1.0.0' };

export class McpGatewayRpcError extends Error {
	constructor(
		public readonly code: number,
		message: string,
		public readonly data?: unknown,
	) {
		super(message);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMeta(body: unknown): Record<string, unknown> | undefined {
	if (!isObject(body)) {
		return undefined;
	}
	const params = body.params;
	if (!isObject(params)) {
		return undefined;
	}
	const meta = params._meta;
	return isObject(meta) ? meta : undefined;
}

/**
 * Classifies one incoming message. A message is modern when its `_meta`
 * carries a protocol version (any string: an unsupported one is still a
 * modern request that gets `-32022`), or when the `MCP-Protocol-Version`
 * header names a modern revision. Everything else (`initialize`, session
 * traffic, legacy notifications) is legacy.
 */
export function classifyEra(headers: Readonly<Record<string, string>>, body: unknown): McpProtocolEra {
	const meta = readMeta(body);
	if (meta && typeof meta[META_PROTOCOL_VERSION] === 'string') {
		return 'modern';
	}
	const header = headers[MCP_PROTOCOL_VERSION_HEADER.toLowerCase()];
	if (header !== undefined && eraForProtocolVersion(header.trim()) === 'modern') {
		return 'modern';
	}
	return 'legacy';
}

/**
 * The version is judged before the rest of a request whose `_meta` carries no
 * protocol version: an `MCP-Protocol-Version` header that is well formed and
 * names none of `supported` gets `-32022` with `data.supported` /
 * `data.requested`, before the era is selected and before the missing `_meta`
 * or the other mirrored headers are reported. When `_meta` carries a version,
 * the modern checks compare it with the header (a disagreement is `-32020`).
 * A missing or malformed header is left to the other checks.
 */
export function unsupportedProtocolVersionHeader(headers: Readonly<Record<string, string>>, body: unknown, supported: readonly string[]): McpGatewayRpcError | undefined {
	const raw = headers[MCP_PROTOCOL_VERSION_HEADER.toLowerCase()];
	if (raw === undefined) {
		return undefined;
	}
	const meta = readMeta(body);
	if (meta && typeof meta[META_PROTOCOL_VERSION] === 'string') {
		return undefined;
	}
	const version = trimOws(raw);
	if (version.length === 0 || !isHeaderSafeAscii(version) || supported.includes(version)) {
		return undefined;
	}
	return new McpGatewayRpcError(MCP.UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version '${version}'`, { supported: [...supported], requested: version });
}

const LOGGING_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);

export interface IModernRequestMeta {
	readonly protocolVersion: string;
	readonly clientCapabilities: MCP.ClientCapabilities;
	readonly clientInfo?: MCP.Implementation;
	readonly logLevel?: MCP.LoggingLevel;
	readonly progressToken?: MCP.ProgressToken;
}

export type ModernRequestMetaValidation =
	| { readonly ok: true; readonly meta: IModernRequestMeta }
	| { readonly ok: false; readonly error: McpGatewayRpcError };

/**
 * Validates the per-request `_meta` of a modern request in the order the
 * specification and the conformance suite expect:
 * 1. `params._meta` must be an object (`-32602`),
 * 2. the protocol version must be present (`-32602`) and supported (`-32022`
 *    with `data.supported` / `data.requested`),
 * 3. `clientCapabilities` must be an object (`-32602`),
 * 4. `clientInfo` and `logLevel` are optional but must be well-formed when present.
 */
export function validateModernRequestMeta(request: IJsonRpcRequest): ModernRequestMetaValidation {
	const meta = readMeta(request);
	if (!meta) {
		return { ok: false, error: new McpGatewayRpcError(MCP.INVALID_PARAMS, `Missing params._meta on ${request.method}`) };
	}
	const protocolVersion = meta[META_PROTOCOL_VERSION];
	if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
		return { ok: false, error: new McpGatewayRpcError(MCP.INVALID_PARAMS, `Missing _meta["${META_PROTOCOL_VERSION}"] on ${request.method}`) };
	}
	if (!MODERN_MCP_PROTOCOL_VERSIONS.includes(protocolVersion)) {
		return {
			ok: false,
			error: new McpGatewayRpcError(MCP.UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version '${protocolVersion}'`, { supported: [...MODERN_MCP_PROTOCOL_VERSIONS], requested: protocolVersion }),
		};
	}
	const clientCapabilities = meta[META_CLIENT_CAPABILITIES];
	if (!isObject(clientCapabilities)) {
		return { ok: false, error: new McpGatewayRpcError(MCP.INVALID_PARAMS, `Missing _meta["${META_CLIENT_CAPABILITIES}"] on ${request.method}`) };
	}
	const clientInfoRaw = meta[META_CLIENT_INFO];
	let clientInfo: MCP.Implementation | undefined;
	if (clientInfoRaw !== undefined) {
		if (!isObject(clientInfoRaw) || typeof clientInfoRaw.name !== 'string' || typeof clientInfoRaw.version !== 'string') {
			return { ok: false, error: new McpGatewayRpcError(MCP.INVALID_PARAMS, `Invalid _meta["${META_CLIENT_INFO}"] on ${request.method}`) };
		}
		clientInfo = clientInfoRaw as unknown as MCP.Implementation;
	}
	const logLevelRaw = meta[META_LOG_LEVEL];
	let logLevel: MCP.LoggingLevel | undefined;
	if (logLevelRaw !== undefined) {
		if (typeof logLevelRaw !== 'string' || !LOGGING_LEVELS.has(logLevelRaw)) {
			return { ok: false, error: new McpGatewayRpcError(MCP.INVALID_PARAMS, `Invalid _meta["${META_LOG_LEVEL}"] on ${request.method}`) };
		}
		logLevel = logLevelRaw as MCP.LoggingLevel;
	}
	const progressTokenRaw = meta[META_PROGRESS_TOKEN];
	const progressToken = typeof progressTokenRaw === 'string' || typeof progressTokenRaw === 'number' ? progressTokenRaw : undefined;
	return { ok: true, meta: { protocolVersion, clientCapabilities: clientCapabilities as MCP.ClientCapabilities, clientInfo, logLevel, progressToken } };
}

/**
 * Verifies the mirrored headers of a modern request against its body.
 * `inputSchema` is the called tool's input schema for `tools/call`.
 */
export function validateStandardHeaders(headers: Readonly<Record<string, string>>, request: IJsonRpcRequest, protocolVersion: string, inputSchema?: unknown): McpGatewayRpcError | undefined {
	const mismatch = verifyMirroredHeaders(headers, request.method, request.params, inputSchema, { protocolVersion });
	return mismatch ? new McpGatewayRpcError(mismatch.code, mismatch.message) : undefined;
}

/**
 * The HTTP status that accompanies a JSON-RPC error response. Modern
 * requests surface protocol-level failures as 4xx; application errors
 * (tool failures, internal errors) stay 200 with the error in the body.
 */
export function httpStatusForRpcError(era: McpProtocolEra, code: number): number {
	if (code === MCP.PARSE_ERROR) {
		return 400;
	}
	if (era === 'legacy') {
		return 200;
	}
	switch (code) {
		case MCP.INVALID_REQUEST:
		case MCP.INVALID_PARAMS:
		case MCP.HEADER_MISMATCH:
		case MCP.MISSING_REQUIRED_CLIENT_CAPABILITY:
		case MCP.UNSUPPORTED_PROTOCOL_VERSION:
			return 400;
		case MCP.METHOD_NOT_FOUND:
			return 404;
		default:
			return 200;
	}
}

/** Methods whose results carry `ttlMs` / `cacheScope`. */
const CACHEABLE_METHODS: ReadonlySet<string> = new Set(['server/discover', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read']);

export interface IMcpGatewayCacheHint {
	readonly ttlMs: number;
	readonly cacheScope: 'public' | 'private';
}

export function isCacheableMethod(method: string): boolean {
	return CACHEABLE_METHODS.has(method);
}

/**
 * Completes a result for the modern wire: `resultType` defaults to
 * `complete`, `_meta` gains the server info, and cacheable methods get a
 * cache hint when the result has none. Existing values are never
 * overwritten (a retry result keeps its own `ttlMs`, an `input_required`
 * result keeps its type).
 */
export function applyModernEnvelope<T extends object>(method: string, result: T, serverInfo: MCP.Implementation = GATEWAY_SERVER_INFO, cacheHint?: IMcpGatewayCacheHint): T & MCP.Result {
	const source = result as Record<string, unknown>;
	const out: Record<string, unknown> = { ...source };
	if (typeof out.resultType !== 'string') {
		out.resultType = 'complete';
	}
	const meta = isObject(out._meta) ? { ...out._meta } : {};
	if (meta[META_SERVER_INFO] === undefined) {
		meta[META_SERVER_INFO] = serverInfo;
	}
	out._meta = meta;
	if (CACHEABLE_METHODS.has(method) && out.resultType === 'complete') {
		if (typeof out.ttlMs !== 'number' || out.ttlMs < 0) {
			out.ttlMs = Math.max(0, cacheHint?.ttlMs ?? 0);
		}
		if (out.cacheScope !== 'public' && out.cacheScope !== 'private') {
			out.cacheScope = cacheHint?.cacheScope ?? 'private';
		}
	}
	return out as T & MCP.Result;
}

export function isInputRequiredResult(obj: unknown): obj is MCP.InputRequiredResult {
	return isObject(obj) && obj.resultType === 'input_required';
}

/** Validates the `inputResponses` a client attaches to an MRTR retry: an object of result objects. */
export function validateInputResponses(value: unknown): McpGatewayRpcError | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isObject(value)) {
		return new McpGatewayRpcError(MCP.INVALID_PARAMS, 'inputResponses must be an object');
	}
	for (const [key, response] of Object.entries(value)) {
		if (!isObject(response)) {
			return new McpGatewayRpcError(MCP.INVALID_PARAMS, `inputResponses["${key}"] must be an object`);
		}
	}
	return undefined;
}

export type McpInputRequestCapability = 'elicitation' | 'elicitation.url' | 'sampling' | 'sampling.tools' | 'sampling.context' | 'roots';

function isPresent(value: unknown): boolean {
	return value !== undefined && value !== null;
}

/**
 * Every client capability an input request needs before a server may issue
 * it; undefined for a method that is no input request. A
 * `sampling/createMessage` with `tools` or `toolChoice` also needs
 * `sampling.tools` (client/sampling: servers MUST NOT send tool-enabled
 * sampling requests to clients that did not declare it), and one with an
 * `includeContext` other than `none` also needs `sampling.context` (the
 * deprecated values SHOULD NOT be used without it).
 */
export function requiredCapabilitiesForInputRequest(method: string, params: unknown): readonly McpInputRequestCapability[] | undefined {
	switch (method) {
		case 'elicitation/create':
			return [isObject(params) && params.mode === 'url' ? 'elicitation.url' : 'elicitation'];
		case 'sampling/createMessage': {
			const required: McpInputRequestCapability[] = ['sampling'];
			if (isObject(params)) {
				if (isPresent(params.includeContext) && params.includeContext !== 'none') {
					required.push('sampling.context');
				}
				if (isPresent(params.tools) || isPresent(params.toolChoice)) {
					required.push('sampling.tools');
				}
			}
			return required;
		}
		case 'roots/list':
			return ['roots'];
		default:
			return undefined;
	}
}

export function hasClientCapability(capabilities: MCP.ClientCapabilities | undefined, key: McpInputRequestCapability): boolean {
	if (!capabilities) {
		return false;
	}
	switch (key) {
		case 'elicitation':
			return capabilities.elicitation !== undefined;
		case 'elicitation.url':
			return capabilities.elicitation?.url !== undefined;
		case 'sampling':
			return capabilities.sampling !== undefined;
		case 'sampling.tools':
			return isObject(capabilities.sampling) && capabilities.sampling.tools !== undefined;
		case 'sampling.context':
			return isObject(capabilities.sampling) && capabilities.sampling.context !== undefined;
		case 'roots':
			return capabilities.roots !== undefined;
	}
}

/**
 * The `ClientCapabilities` shape of a list of capabilities, as a `-32021`
 * error names them in `data.requiredCapabilities` (`sampling.tools` and
 * `sampling.context` merge into one `sampling` object).
 */
export function clientCapabilitiesOf(capabilities: readonly McpInputRequestCapability[]): MCP.ClientCapabilities {
	const out: MCP.ClientCapabilities = {};
	for (const capability of capabilities) {
		switch (capability) {
			case 'elicitation':
				out.elicitation ??= {};
				break;
			case 'elicitation.url':
				out.elicitation = { ...out.elicitation, url: {} };
				break;
			case 'sampling':
				out.sampling ??= {};
				break;
			case 'sampling.tools':
				out.sampling = { ...out.sampling, tools: {} };
				break;
			case 'sampling.context':
				out.sampling = { ...out.sampling, context: {} };
				break;
			case 'roots':
				out.roots ??= {};
				break;
		}
	}
	return out;
}

const SUBSCRIPTION_FILTER_FLAGS = ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'] as const;

/**
 * The most distinct URIs one `subscriptions/listen` filter may subscribe to
 * (each one is a subscription the gateway opens on the server behind it), as
 * the zig-sdk's `max_resource_subscription_uris`.
 */
export const MAX_LISTEN_RESOURCE_SUBSCRIPTIONS = 1024;

/** The most characters of a `subscriptions/listen` filter as compact JSON, as the zig-sdk's `max_filter_bytes`. */
export const MAX_LISTEN_FILTER_LENGTH = 64 * 1024;

/**
 * Checks a `subscriptions/listen` filter: an object whose list flags, when
 * present, are booleans and whose `resourceSubscriptions`, when present, is
 * an array of strings (unknown keys are ignored; `-32602` otherwise), within
 * the gateway's limits ({@link MAX_LISTEN_RESOURCE_SUBSCRIPTIONS} distinct
 * URIs, {@link MAX_LISTEN_FILTER_LENGTH} characters; `-32603` otherwise, as
 * for too many open streams). Returns the error to answer, or undefined.
 */
export function validateSubscriptionFilter(value: unknown): McpGatewayRpcError | undefined {
	if (!isObject(value)) {
		return new McpGatewayRpcError(MCP.INVALID_PARAMS, 'subscriptions/listen needs a notifications filter object');
	}
	for (const flag of SUBSCRIPTION_FILTER_FLAGS) {
		if (value[flag] !== undefined && typeof value[flag] !== 'boolean') {
			return new McpGatewayRpcError(MCP.INVALID_PARAMS, `notifications.${flag} must be a boolean`);
		}
	}
	const uris = value.resourceSubscriptions;
	if (uris !== undefined && (!Array.isArray(uris) || !uris.every(uri => typeof uri === 'string'))) {
		return new McpGatewayRpcError(MCP.INVALID_PARAMS, 'notifications.resourceSubscriptions must be an array of strings');
	}
	const distinct = Array.isArray(uris) ? new Set(uris).size : 0;
	if (distinct > MAX_LISTEN_RESOURCE_SUBSCRIPTIONS) {
		return new McpGatewayRpcError(MCP.INTERNAL_ERROR, `Too many resource subscriptions in one subscriptions/listen filter: ${distinct} (limit ${MAX_LISTEN_RESOURCE_SUBSCRIPTIONS})`);
	}
	const length = JSON.stringify(value).length;
	if (length > MAX_LISTEN_FILTER_LENGTH) {
		return new McpGatewayRpcError(MCP.INTERNAL_ERROR, `The subscriptions/listen filter is too large: ${length} characters (limit ${MAX_LISTEN_FILTER_LENGTH})`);
	}
	return undefined;
}

/**
 * The filter a server honours for a `subscriptions/listen` request: every
 * requested kind the server can actually produce (per its capabilities).
 * Defensive about the shape: a flag counts only when it is `true`, and only
 * the string entries of an actual `resourceSubscriptions` array are kept,
 * each URI once (one subscription per URI).
 */
export function honorSubscriptionFilter(requested: MCP.SubscriptionFilter, serverCapabilities: MCP.ServerCapabilities): MCP.SubscriptionFilter {
	const honoured: MCP.SubscriptionFilter = {};
	if (!isObject(requested)) {
		return honoured;
	}
	if (requested.toolsListChanged === true && serverCapabilities.tools?.listChanged) {
		honoured.toolsListChanged = true;
	}
	if (requested.promptsListChanged === true && serverCapabilities.prompts?.listChanged) {
		honoured.promptsListChanged = true;
	}
	if (requested.resourcesListChanged === true && serverCapabilities.resources?.listChanged) {
		honoured.resourcesListChanged = true;
	}
	const requestedUris: unknown = requested.resourceSubscriptions;
	const uris = Array.isArray(requestedUris) ? [...new Set(requestedUris.filter((uri): uri is string => typeof uri === 'string'))] : [];
	if (uris.length > 0 && serverCapabilities.resources?.subscribe) {
		honoured.resourceSubscriptions = uris;
	}
	return honoured;
}

/** The 2025-11-25 transports' generic error code for a refused HTTP request (`Bad Request: …`, `Conflict: …`). */
export const LEGACY_TRANSPORT_ERROR = -32000;

/**
 * The 2025-11-25 rule for the `MCP-Protocol-Version` header of a session's
 * requests after `initialize` (POST, GET and DELETE): an absent header is
 * allowed (the version negotiated by `initialize` applies), a revision of the
 * `initialize` era is accepted (as the TypeScript SDK does, a supported value
 * other than the negotiated one is not refused), and anything else, an
 * invalid or unsupported value, MUST be answered with 400 Bad Request.
 */
export function validateLegacyProtocolVersionHeader(headers: Readonly<Record<string, string>>): McpGatewayRpcError | undefined {
	const raw = headers[MCP_PROTOCOL_VERSION_HEADER.toLowerCase()];
	if (raw === undefined) {
		return undefined;
	}
	const version = raw.trim();
	if (LEGACY_MCP_PROTOCOL_VERSIONS.includes(version)) {
		return undefined;
	}
	return new McpGatewayRpcError(LEGACY_TRANSPORT_ERROR, `Bad Request: Unsupported protocol version: ${JSON.stringify(raw)} (supported versions: ${LEGACY_MCP_PROTOCOL_VERSIONS.join(', ')})`);
}

/** The first legacy revision whose clients accept SSE events with empty `data` (SEP-1699 priming events). */
export const FIRST_PRIMING_PROTOCOL_VERSION = '2025-11-25';

/**
 * Whether a legacy session may get SSE priming events (an `id`, a `retry` and
 * empty `data`): only from 2025-11-25 on. Older clients try to parse the empty
 * data as JSON, so their streams get a comment instead and are not closed for
 * polling. Revisions are dates, so they compare as strings.
 */
export function legacyVersionSupportsPriming(protocolVersion: string | undefined): boolean {
	return protocolVersion !== undefined && LEGACY_MCP_PROTOCOL_VERSIONS.includes(protocolVersion) && protocolVersion >= FIRST_PRIMING_PROTOCOL_VERSION;
}

/**
 * Who sent a stateless (2026-07-28) message, for `notifications/cancelled`:
 * the client's key (its address and its `_meta` client info), its address
 * alone, and whether the message named the client (carried client info).
 */
export interface IMcpGatewayMessageSender {
	readonly key: string;
	readonly peer: string;
	readonly named: boolean;
}

/** Something a cancellation can reach (an in-flight request, a listen stream), with the sender of the request that opened it. */
export interface IMcpGatewayCancellable {
	/** The {@link IMcpGatewayMessageSender.key} of the request. */
	readonly owner: string | undefined;
	/** The {@link IMcpGatewayMessageSender.peer} of the request. */
	readonly peer: string | undefined;
}

/**
 * The entries with one request id that a `notifications/cancelled` of
 * `sender` reaches. A cancellation that names its client reaches only that
 * client's entries. Notifications need not carry `_meta` while requests
 * SHOULD carry the client info, so one that names no client may come from
 * any client of its address, one that names itself in its requests or one
 * that never does: it reaches the entries of the one client of its address
 * that has entries with the id, and when several clients of the address
 * have one (a client without client info among them or not), it is
 * ambiguous and reaches none (it never cancels another client's request).
 */
export function cancellationTargets<T extends IMcpGatewayCancellable>(entries: Iterable<T>, sender: IMcpGatewayMessageSender): T[] {
	const candidates = [...entries];
	if (sender.named) {
		return candidates.filter(entry => entry.owner === sender.key);
	}
	const sameAddress = candidates.filter(entry => entry.peer === sender.peer);
	return new Set(sameAddress.map(entry => entry.owner)).size === 1 ? sameAddress : [];
}

/** The `_meta` client info of a message (request or notification), when it is well-formed. */
export function clientInfoFromMeta(body: unknown): MCP.Implementation | undefined {
	const info = readMeta(body)?.[META_CLIENT_INFO];
	return isObject(info) && typeof info.name === 'string' && typeof info.version === 'string' ? info as unknown as MCP.Implementation : undefined;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(hostHeader: string): string {
	const host = hostHeader.trim().toLowerCase();
	if (host.startsWith('[')) {
		// Bracketed IPv6 literal, optionally followed by a port.
		const end = host.indexOf(']');
		return end === -1 ? host : host.substring(0, end + 1);
	}
	const firstColon = host.indexOf(':');
	if (firstColon !== -1 && firstColon === host.lastIndexOf(':')) {
		// Exactly one colon: a host followed by a port.
		return host.substring(0, firstColon);
	}
	// No colon (a plain host) or several colons (a bare IPv6 literal).
	return host;
}

/**
 * True when a `Host` header names the local machine. The gateway binds to
 * the loopback interface only, so any other host indicates a DNS-rebinding
 * attempt and the request is refused.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
	if (hostHeader === undefined) {
		return false;
	}
	const host = hostnameOf(hostHeader);
	if (LOOPBACK_HOSTS.has(host)) {
		return true;
	}
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * True when a request's `Origin` is absent (non-browser client) or names a
 * loopback origin. Browser pages from any other origin are refused.
 */
export function isAllowedOrigin(originHeader: string | undefined): boolean {
	if (originHeader === undefined || originHeader === '') {
		return true;
	}
	if (originHeader === 'null') {
		return false;
	}
	try {
		const url = new URL(originHeader);
		return isLoopbackHost(url.host);
	} catch {
		return false;
	}
}

/** A JSON-RPC error response; `id` is `null` when the request could not be read. */
export interface IMcpGatewayErrorResponse {
	readonly jsonrpc: '2.0';
	readonly id: JsonRpcId | null;
	readonly error: IJsonRpcError;
}

export function errorResponse(id: JsonRpcId | null, code: number, message: string, data?: unknown): IMcpGatewayErrorResponse {
	return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}
