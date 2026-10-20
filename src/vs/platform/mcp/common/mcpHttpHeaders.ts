/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';

/**
 * The header-mirroring rules of the MCP 2026-07-28 Streamable HTTP transport
 * (SEP-2243): the request method, the target name/uri and every tool
 * parameter annotated with `x-mcp-header` travel as HTTP headers next to the
 * JSON-RPC body so that intermediaries can route without parsing the body.
 *
 * This module is the single implementation shared by the client transports,
 * the conformance client and the gateway (server side). It is pure: no I/O,
 * no DOM, no Node.
 */

export const MCP_PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version';
export const MCP_METHOD_HEADER = 'Mcp-Method';
export const MCP_NAME_HEADER = 'Mcp-Name';
export const MCP_PARAM_HEADER_PREFIX = 'Mcp-Param-';
export const BASE64_SENTINEL_START = '=?base64?';
export const BASE64_SENTINEL_END = '?=';

/** The largest number of `x-mcp-header` annotations one input schema may carry. */
export const MAX_HEADER_ANNOTATIONS = 64;
/** The deepest schema nesting the annotation walk follows. */
export const MAX_HEADER_SCHEMA_DEPTH = 64;

/**
 * True when `value` can travel as a header value verbatim: only visible ASCII
 * and spaces, no tabs, no whitespace at either end and not shaped like the
 * Base64 sentinel. Everything else must be sentinel-encoded. The empty
 * string is plain.
 */
export function isHeaderSafeAscii(value: string): boolean {
	if (value.length === 0) {
		return true;
	}
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	if (value[0] === ' ' || value[value.length - 1] === ' ') {
		return false;
	}
	return !isSentinelShaped(value);
}

function isSentinelShaped(value: string): boolean {
	return value.startsWith(BASE64_SENTINEL_START) && value.endsWith(BASE64_SENTINEL_END) && value.length >= BASE64_SENTINEL_START.length + BASE64_SENTINEL_END.length;
}

/**
 * Encodes a header value: plain values are returned as-is, everything else
 * becomes `=?base64?{base64 of UTF-8}?=`.
 */
export function encodeHeaderValue(value: string): string {
	if (isHeaderSafeAscii(value)) {
		return value;
	}
	return BASE64_SENTINEL_START + encodeBase64(VSBuffer.fromString(value), true, false) + BASE64_SENTINEL_END;
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/;

/**
 * Decodes a header value. Values without the full sentinel wrapper are
 * literals. Sentinel values must be canonical RFC 4648 Base64 (standard
 * alphabet, mandatory padding, length multiple of four).
 */
export type McpDecodedHeaderValue =
	| { readonly kind: 'value'; readonly value: string }
	| { readonly kind: 'error'; readonly error: string };

export function decodeHeaderValue(raw: string): McpDecodedHeaderValue {
	if (!isSentinelShaped(raw)) {
		return { kind: 'value', value: raw };
	}
	const body = raw.substring(BASE64_SENTINEL_START.length, raw.length - BASE64_SENTINEL_END.length);
	if (body.length % 4 !== 0 || !STRICT_BASE64.test(body)) {
		return { kind: 'error', error: 'invalid Base64 encoding' };
	}
	try {
		return { kind: 'value', value: decodeBase64(body).toString() };
	} catch {
		return { kind: 'error', error: 'invalid Base64 encoding' };
	}
}

/** Strips optional whitespace (SP / HTAB) from both ends of a raw header value. */
export function trimOws(raw: string): string {
	let start = 0;
	let end = raw.length;
	while (start < end && (raw[start] === ' ' || raw[start] === '\t')) {
		start++;
	}
	while (end > start && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) {
		end--;
	}
	return raw.substring(start, end);
}

/**
 * True when `value` has only the characters an HTTP field value may carry
 * (RFC 9110 section 5.5): visible ASCII, space and horizontal tab.
 */
export function isFieldValue(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
			return false;
		}
	}
	return true;
}

/** True for a `tchar` of RFC 9110 section 5.6.2. */
function isTokenChar(code: number): boolean {
	if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
		return true;
	}
	switch (code) {
		case 0x21: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x2a: case 0x2b:
		case 0x2d: case 0x2e: case 0x5e: case 0x5f: case 0x60: case 0x7c: case 0x7e:
			return true;
		default:
			return false;
	}
}

/** True when `name` is a non-empty HTTP token (the only legal shape of an `x-mcp-header` value). */
export function isValidHeaderAnnotation(name: string): boolean {
	if (name.length === 0) {
		return false;
	}
	for (let i = 0; i < name.length; i++) {
		if (!isTokenChar(name.charCodeAt(i))) {
			return false;
		}
	}
	return true;
}

export function headerNameForParam(name: string): string {
	return MCP_PARAM_HEADER_PREFIX + name;
}

export type McpHeaderPrimitiveType = 'string' | 'integer' | 'boolean';

/** One `x-mcp-header` annotation reachable from the schema root through `properties` keys only. */
export interface McpHeaderAnnotation {
	/** The name part of the `Mcp-Param-{name}` header, as written in the schema. */
	readonly header: string;
	/** The property names from the arguments root to the annotated property. */
	readonly path: readonly string[];
	readonly type: McpHeaderPrimitiveType;
}

export type McpHeaderAnnotationProblem =
	| 'not-string'
	| 'invalid-name'
	| 'not-primitive'
	| 'duplicate'
	| 'not-reachable'
	| 'too-many'
	| 'too-deep';

export type McpHeaderAnnotations =
	| { readonly kind: 'valid'; readonly annotations: readonly McpHeaderAnnotation[] }
	| { readonly kind: 'invalid'; readonly problem: McpHeaderAnnotationProblem; readonly annotation?: string; readonly message: string };

const PROBLEM_TEXT: Record<McpHeaderAnnotationProblem, string> = {
	'not-string': 'the x-mcp-header value is not a string',
	'invalid-name': 'the x-mcp-header value is empty or is not an HTTP token',
	'not-primitive': 'the annotated property does not have the type string, integer or boolean',
	'duplicate': 'two x-mcp-header values are equal without regard to case',
	'not-reachable': 'the annotation is not on a property reached through properties keywords only',
	'too-many': 'the schema has too many x-mcp-header annotations',
	'too-deep': 'the schema is nested too deeply',
};

/** Keywords whose operand is instance data, never a schema. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', 'x-mcp-header']);
/** Keywords whose operand is an object of subschemas under free-form names. */
const SCHEMA_MAP_KEYWORDS = new Set(['patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies', 'dependentRequired']);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds and validates every `x-mcp-header` annotation of a tool input schema.
 * The walk visits every subschema; an annotation is valid only on a property
 * reached from the root through a chain of `properties` keywords. A chain
 * through `items`, a composition keyword, `if`/`then`/`else`, `$ref` targets
 * or any other keyword makes the annotation (and thus the tool) invalid.
 */
export function collectHeaderAnnotations(inputSchema: unknown): McpHeaderAnnotations {
	const found: McpHeaderAnnotation[] = [];
	let invalid: { problem: McpHeaderAnnotationProblem; annotation?: string } | undefined;

	const fail = (problem: McpHeaderAnnotationProblem, annotation?: string) => {
		if (!invalid) {
			invalid = { problem, annotation };
		}
	};

	const record = (node: Record<string, unknown>, annotation: unknown, path: readonly string[], reachable: boolean) => {
		const name = typeof annotation === 'string' ? annotation : undefined;
		if (!reachable || path.length === 0) {
			return fail('not-reachable', name);
		}
		if (name === undefined) {
			return fail('not-string');
		}
		if (!isValidHeaderAnnotation(name)) {
			return fail('invalid-name', name);
		}
		const type = node.type;
		if (type !== 'string' && type !== 'integer' && type !== 'boolean') {
			return fail('not-primitive', name);
		}
		const lower = name.toLowerCase();
		if (found.some(f => f.header.toLowerCase() === lower)) {
			return fail('duplicate', name);
		}
		if (found.length >= MAX_HEADER_ANNOTATIONS) {
			return fail('too-many', name);
		}
		found.push({ header: name, path: [...path], type });
	};

	/** `path` is the chain of property names to `node`, or undefined when another keyword is on the way. */
	const walk = (node: unknown, path: readonly string[] | undefined, depth: number) => {
		if (invalid || !isObject(node)) {
			return;
		}
		if (depth >= MAX_HEADER_SCHEMA_DEPTH) {
			return fail('too-deep');
		}
		if (Object.prototype.hasOwnProperty.call(node, 'x-mcp-header')) {
			record(node, node['x-mcp-header'], path ?? [], path !== undefined);
		}
		for (const [key, value] of Object.entries(node)) {
			if (DATA_KEYWORDS.has(key)) {
				continue;
			}
			if (key === 'properties' || SCHEMA_MAP_KEYWORDS.has(key)) {
				if (!isObject(value)) {
					continue;
				}
				for (const [entryName, entryValue] of Object.entries(value)) {
					const childPath = key === 'properties' && path !== undefined ? [...path, entryName] : undefined;
					walk(entryValue, childPath, depth + 1);
				}
				continue;
			}
			if (Array.isArray(value)) {
				for (const item of value) {
					walk(item, undefined, depth + 1);
				}
			} else if (isObject(value)) {
				walk(value, undefined, depth + 1);
			}
		}
	};

	walk(inputSchema, [], 0);
	if (invalid) {
		const { problem, annotation } = invalid;
		return { kind: 'invalid', problem, annotation, message: PROBLEM_TEXT[problem] };
	}
	return { kind: 'valid', annotations: found };
}

/** The value at `path` in a tool call's arguments; `undefined` when a step is missing, not an object, or the value is `null`. */
export function valueAtPath(args: unknown, path: readonly string[]): unknown {
	let current: unknown = args;
	for (const key of path) {
		if (!isObject(current)) {
			return undefined;
		}
		current = current[key];
	}
	return current === null ? undefined : current;
}

export class McpUnsafeIntegerError extends Error {
	constructor(public readonly header: string, public readonly value: number) {
		super(`The value of ${headerNameForParam(header)} (${value}) is an integer outside the safe range`);
	}
}

/**
 * Converts a mirrored parameter value to its header string: strings as-is,
 * integers in decimal, booleans lowercase. Returns `undefined` for values the
 * client must not mirror (null, undefined, non-primitives). Throws
 * {@link McpUnsafeIntegerError} for integers outside the safe range.
 */
export function valueToHeaderString(value: unknown, header: string): string | undefined {
	switch (typeof value) {
		case 'string':
			return value;
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) {
				return undefined;
			}
			if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
				throw new McpUnsafeIntegerError(header, value);
			}
			return String(value);
		default:
			return undefined;
	}
}

/** The `Mcp-Param-*` header values for one call: header name (as annotated) to encoded value. */
export function extractHeaderValues(args: unknown, annotations: readonly McpHeaderAnnotation[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const annotation of annotations) {
		const text = valueToHeaderString(valueAtPath(args, annotation.path), annotation.header);
		if (text !== undefined) {
			result[headerNameForParam(annotation.header)] = encodeHeaderValue(text);
		}
	}
	return result;
}

/** Compares a decoded header value with the body value it mirrors (numbers numerically). */
export function compareHeaderToBody(decoded: string, bodyValue: unknown): boolean {
	switch (typeof bodyValue) {
		case 'string':
			return decoded === bodyValue;
		case 'boolean':
			return decoded === (bodyValue ? 'true' : 'false');
		case 'number': {
			if (decoded.trim().length === 0) {
				return false;
			}
			const parsed = Number(decoded);
			return Number.isFinite(parsed) && parsed === bodyValue;
		}
		default:
			return false;
	}
}

/** The `Mcp-Name` source value of a request, when the method has one. */
export function mcpNameForRequest(method: string, params: unknown): string | undefined {
	if (!isObject(params)) {
		return undefined;
	}
	switch (method) {
		case 'tools/call':
		case 'prompts/get': {
			const name = params.name;
			return typeof name === 'string' ? name : undefined;
		}
		case 'resources/read': {
			const uri = params.uri;
			return typeof uri === 'string' ? uri : undefined;
		}
		case 'tasks/get':
		case 'tasks/update':
		case 'tasks/cancel': {
			const taskId = params.taskId;
			return typeof taskId === 'string' ? taskId : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Builds the standard and custom mirrored headers for one request.
 * `annotations` are the valid annotations of the called tool (tools/call only).
 */
export function buildMirroredHeaders(method: string, params: unknown, annotations?: readonly McpHeaderAnnotation[]): Record<string, string> {
	const headers: Record<string, string> = { [MCP_METHOD_HEADER]: method };
	const name = mcpNameForRequest(method, params);
	if (name !== undefined) {
		headers[MCP_NAME_HEADER] = encodeHeaderValue(name);
	}
	if (method === 'tools/call' && annotations && annotations.length > 0 && isObject(params)) {
		Object.assign(headers, extractHeaderValues(params.arguments, annotations));
	}
	return headers;
}

export interface IMcpHeaderMismatch {
	readonly code: -32020;
	readonly message: string;
}

export interface IVerifyMirroredHeadersOptions {
	/**
	 * When set, the `MCP-Protocol-Version` header must be present and equal to
	 * this value (the body's `_meta` protocol version).
	 */
	readonly protocolVersion?: string;
}

const mismatch = (message: string): IMcpHeaderMismatch => ({ code: -32020, message: `Header mismatch: ${message}` });

/**
 * Server-side verification of the mirrored headers against the request body.
 * `headers` are the raw request headers with lowercase names; `inputSchema`
 * is the called tool's input schema for `tools/call` (when the tool exists).
 * Returns `undefined` when the request is consistent, else the `-32020` error.
 */
export function verifyMirroredHeaders(headers: Readonly<Record<string, string>>, method: string, params: unknown, inputSchema?: unknown, options?: IVerifyMirroredHeadersOptions): IMcpHeaderMismatch | undefined {
	if (options?.protocolVersion !== undefined) {
		const raw = headers[MCP_PROTOCOL_VERSION_HEADER.toLowerCase()];
		if (raw === undefined) {
			return mismatch(`the ${MCP_PROTOCOL_VERSION_HEADER} header is missing`);
		}
		const version = trimOws(raw);
		if (!isHeaderSafeAscii(version)) {
			return mismatch(`${MCP_PROTOCOL_VERSION_HEADER} has an invalid value`);
		}
		if (version !== options.protocolVersion) {
			return mismatch(`${MCP_PROTOCOL_VERSION_HEADER} header value '${version}' does not match body value '${options.protocolVersion}'`);
		}
	}

	const rawMethod = headers[MCP_METHOD_HEADER.toLowerCase()];
	if (rawMethod === undefined) {
		return mismatch(`the ${MCP_METHOD_HEADER} header is missing`);
	}
	if (!isFieldValue(rawMethod)) {
		return mismatch(`${MCP_METHOD_HEADER} has invalid characters`);
	}
	const headerMethod = trimOws(rawMethod);
	if (headerMethod !== method) {
		return mismatch(`${MCP_METHOD_HEADER} header value '${headerMethod}' does not match body method '${method}'`);
	}

	const bodyName = mcpNameForRequest(method, params);
	const nameApplies = method === 'tools/call' || method === 'prompts/get' || method === 'resources/read' || method === 'tasks/get' || method === 'tasks/update' || method === 'tasks/cancel';
	if (nameApplies) {
		const rawName = headers[MCP_NAME_HEADER.toLowerCase()];
		if (rawName === undefined) {
			return mismatch(`the ${MCP_NAME_HEADER} header is missing`);
		}
		if (!isFieldValue(rawName)) {
			return mismatch(`${MCP_NAME_HEADER} has invalid characters`);
		}
		const decoded = decodeHeaderValue(trimOws(rawName));
		if (decoded.kind === 'error') {
			return mismatch(`${MCP_NAME_HEADER} header has an invalid encoding`);
		}
		if (bodyName !== undefined && decoded.value !== bodyName) {
			return mismatch(`${MCP_NAME_HEADER} header value '${decoded.value}' does not match body value '${bodyName}'`);
		}
	}

	if (method === 'tools/call' && inputSchema !== undefined) {
		const collected = collectHeaderAnnotations(inputSchema);
		// A tool with invalid annotations cannot be mirrored; registration should have rejected it.
		const annotations = collected.kind === 'valid' ? collected.annotations : [];
		const args = isObject(params) ? params.arguments : undefined;
		for (const annotation of annotations) {
			const headerName = headerNameForParam(annotation.header);
			const raw = headers[headerName.toLowerCase()];
			if (raw !== undefined && !isFieldValue(raw)) {
				return mismatch(`${headerName} has invalid characters`);
			}
			const bodyValue = valueAtPath(args, annotation.path);
			if (bodyValue === undefined) {
				if (raw !== undefined) {
					return mismatch(`${headerName} is present but the body has no value`);
				}
				continue;
			}
			if (typeof bodyValue === 'number' && Number.isInteger(bodyValue) && !Number.isSafeInteger(bodyValue)) {
				return mismatch(`the value of ${headerName} is an integer outside the safe range`);
			}
			if (raw === undefined) {
				return mismatch(`the ${headerName} header is missing`);
			}
			const decoded = decodeHeaderValue(trimOws(raw));
			if (decoded.kind === 'error') {
				return mismatch(`${headerName} has an invalid encoding`);
			}
			if (!compareHeaderToBody(decoded.value, bodyValue)) {
				return mismatch(`${headerName} header value '${decoded.value}' does not match the body`);
			}
		}
	}

	return undefined;
}

/** Returns a copy of `headers` with lowercase names (later duplicates win). */
export function lowercaseHeaders(headers: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined) {
			out[name.toLowerCase()] = value;
		}
	}
	return out;
}
