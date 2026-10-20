/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The mapping between MCP JSON-RPC params/results (2026-07-28 schema) and
 * the typed messages of `model_context_protocol.Mcp`, in both directions.
 *
 * The client encodes params into a request message and decodes a response
 * message into a result; a gateway does the reverse. The mapping follows the
 * reference transport (`mcp-grpc-transport-py`) and the zig-sdk:
 *
 * - `_meta` of the params and of the result travels in `common.metadata`.
 * - JSON values (tool arguments, schemas, `structuredContent`, `_meta`)
 *   travel as `google.protobuf.Struct`; `ttlMs` as a `Duration`.
 * - The `bytes` fields (`data` of image and audio blocks, `blob` of a
 *   resource) carry the base64 text of MCP, not the decoded octets.
 * - Absent proto3 scalars are omitted in JSON so that VS Code's defaults
 *   apply. This is lossy where MCP's default is not the proto3 default:
 *   `destructiveHint: false` arrives as an absent hint (which MCP reads as
 *   `true`), `openWorldHint: false` likewise, an empty `blob` arrives as an
 *   empty `text`, and `priority` keeps about seven digits (32-bit float).
 * - The messages mark choices with "exactly one of these fields", not with
 *   `oneof`; a decoded message with two members set is rejected.
 *
 * The conversion is strict: a part of MCP the messages cannot carry throws
 * {@link McpUnexpressibleError} (kind `unexpressible`) rather than being
 * dropped, and a value without the shape of its MCP type or of its message
 * throws it with kind `invalid`. Malformed protobuf propagates as the codec's
 * own decode error.
 */

import { decodeMessage, encodeMessage, IMessageDescriptor, ProtoCodecError } from '../../../base/common/protobuf/codec.js';
import { durationToMs, jsonToStruct, msToDuration, structToJson } from '../../../base/common/protobuf/wellKnown.js';
import { decodeUtf8, encodeUtf8 } from '../../../base/common/protobuf/wire.js';
import { CACHE_SCOPE, ELICIT_RESULT_TYPE, ICON_THEME, INCLUDE_CONTEXT, ITypedRpc, RESULT_TYPE, ROLE, STRING_FORMAT } from './mcpGrpcProto.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_SERVER_INFO } from './mcpProtocolVersions.js';
import { MCP } from './modelContextProtocol.js';

//#region Errors

export type McpUnexpressibleKind =
	/** The MCP value is valid, but the typed messages have no field for a part of it. */
	| 'unexpressible'
	/** The value does not have the shape of its MCP type or of its message. */
	| 'invalid';

export class McpUnexpressibleError extends Error {
	constructor(
		public readonly kind: McpUnexpressibleKind,
		public readonly reason: string,
	) {
		super(kind === 'unexpressible' ? `The typed gRPC binding cannot carry ${reason}` : `Invalid typed gRPC message: ${reason}`);
		this.name = 'McpUnexpressibleError';
	}
}

function unexpressible(reason: string): McpUnexpressibleError {
	return new McpUnexpressibleError('unexpressible', reason);
}

function invalid(reason: string): McpUnexpressibleError {
	return new McpUnexpressibleError('invalid', reason);
}

//#endregion

//#region Entry points

type JsonObject = Record<string, unknown>;
/** A message object in the shape the codec produces and consumes. */
type Msg = Record<string, unknown>;

/** Encodes the JSON-RPC params of `rpc.jsonRpcMethod` as the request message of `rpc`. */
export function encodeTypedRequest(rpc: ITypedRpc, params: unknown): Uint8Array {
	return encode(rpc.request, paramsToMessage(rpc, params));
}

/** Decodes the request message of `rpc` into the JSON-RPC params of `rpc.jsonRpcMethod`. */
export function decodeTypedRequest(rpc: ITypedRpc, bytes: Uint8Array): Record<string, unknown> {
	return messageToParams(rpc, decodeMessage(rpc.request, bytes));
}

/** Encodes the JSON-RPC result of `rpc.jsonRpcMethod` as the response message of `rpc`. */
export function encodeTypedResponse(rpc: ITypedRpc, result: unknown): Uint8Array {
	return encode(rpc.response, resultToMessage(rpc, result));
}

/** Decodes the response message of `rpc` into the JSON-RPC result of `rpc.jsonRpcMethod` (2026-07-28 shape). */
export function decodeTypedResponse(rpc: ITypedRpc, bytes: Uint8Array): Record<string, unknown> {
	return messageToResult(rpc, decodeMessage(rpc.response, bytes));
}

/**
 * The routing metadata a client adds to a call of `rpc`: `mcp_tool` with
 * the tool name, `mcp_prompt` with the prompt name, `mcp_resource` with the
 * resource URI, or (for `Complete`) `mcp_resource` with the URI of a resource
 * reference or the name of a prompt reference. Empty when the RPC has none
 * or the params do not carry the value.
 */
export function routingMetadataFor(rpc: ITypedRpc, params: unknown): Record<string, string> {
	const key = rpc.routingKey;
	if (key === undefined || !isObject(params)) {
		return {};
	}
	let value: unknown;
	switch (rpc.name) {
		case 'CallTool':
		case 'GetPrompt':
			value = params.name;
			break;
		case 'ReadResource':
			value = params.uri;
			break;
		case 'Complete': {
			const ref = params.ref;
			if (isObject(ref)) {
				value = ref.type === 'ref/resource' ? ref.uri : ref.type === 'ref/prompt' ? ref.name : undefined;
			}
			break;
		}
	}
	return typeof value === 'string' ? { [key]: value } : {};
}

/**
 * The typed binding has no `server/discover`. A client synthesizes the
 * discover result of a typed server: every capability the eight RPCs cover,
 * the one protocol revision the binding speaks, and the authority as the
 * server name.
 */
export function synthesizeDiscoverResult(authority: string): MCP.DiscoverResult {
	return {
		supportedVersions: [LATEST_MCP_PROTOCOL_VERSION],
		capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
		ttlMs: 0,
		cacheScope: 'private',
		resultType: 'complete',
		_meta: { [META_SERVER_INFO]: { name: authority, version: '' } },
	};
}

function encode(descriptor: IMessageDescriptor, message: Msg): Uint8Array {
	try {
		return encodeMessage(descriptor, message);
	} catch (err) {
		if (err instanceof ProtoCodecError) {
			switch (err.reason) {
				case 'too-deep':
				case 'too-many-elements':
					throw unexpressible(err.message);
				default:
					throw invalid(err.message);
			}
		}
		throw err;
	}
}

//#endregion

//#region JSON helpers (MCP side)

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Defines an own enumerable property, so that keys such as `__proto__` cannot alter the prototype. */
function defineOwn(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** The value of `key`. A JSON null counts as an absent field. */
function fieldOf(o: JsonObject, key: string): unknown {
	const value = hasOwn(o, key) ? o[key] : undefined;
	return value === null ? undefined : value;
}

/** Refuses a key that the message of `what` has no field for. */
function checkKeys(o: JsonObject, allowed: readonly string[], what: string): void {
	for (const key of Object.keys(o)) {
		if (!allowed.includes(key)) {
			throw unexpressible(`the field ${key} of ${what}`);
		}
	}
}

function asObject(value: unknown, what: string): JsonObject {
	if (!isObject(value)) {
		throw invalid(`${what} is not an object`);
	}
	return value;
}

function asArray(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) {
		throw invalid(`${what} is not an array`);
	}
	return value;
}

function asString(value: unknown, what: string): string {
	if (typeof value !== 'string') {
		throw invalid(`${what} is not a string`);
	}
	return value;
}

function asBool(value: unknown, what: string): boolean {
	if (typeof value !== 'boolean') {
		throw invalid(`${what} is not a boolean`);
	}
	return value;
}

function asNumber(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw invalid(`${what} is not a number`);
	}
	return value;
}

function asInteger(value: unknown, what: string): number {
	const number = asNumber(value, what);
	if (!Number.isInteger(number)) {
		throw unexpressible(`${what} is not an integer`);
	}
	if (!Number.isSafeInteger(number)) {
		throw unexpressible(`${what} is outside the safe integer range`);
	}
	return number;
}

function reqString(o: JsonObject, key: string, what: string): string {
	const value = fieldOf(o, key);
	if (value === undefined) {
		throw invalid(`${what} has no ${key}`);
	}
	return asString(value, `${what}.${key}`);
}

/** Proto3 does not tell an empty string from an absent one: an absent field is `''`. */
function optString(o: JsonObject, key: string, what: string): string {
	const value = fieldOf(o, key);
	return value === undefined ? '' : asString(value, `${what}.${key}`);
}

function stringList(value: unknown, what: string): string[] {
	return asArray(value, what).map(item => asString(item, `an item of ${what}`));
}

function float32Of(value: unknown, what: string): number {
	const single = Math.fround(asNumber(value, what));
	if (!Number.isFinite(single)) {
		throw unexpressible(`${what} is outside the range of a float`);
	}
	return single;
}

function uint32Of(value: unknown, what: string): number {
	const integer = asInteger(value, what);
	if (integer < 0 || integer > 0xffffffff) {
		throw unexpressible(`${what} is outside the range from 0 to 2^32`);
	}
	return integer;
}

function uint64Of(value: unknown, what: string): number {
	const integer = asInteger(value, what);
	if (integer < 0) {
		throw invalid(`${what} is negative`);
	}
	return integer;
}

/** A JSON object that travels as a `Struct`. */
function structOf(value: unknown, what: string): Msg {
	if (!isObject(value)) {
		throw invalid(`${what} is not an object`);
	}
	try {
		return jsonToStruct(value);
	} catch (err) {
		if (err instanceof ProtoCodecError) {
			throw unexpressible(`${what}: ${err.message}`);
		}
		throw err;
	}
}

function metaOf(o: JsonObject): Msg | undefined {
	const meta = fieldOf(o, '_meta');
	return meta === undefined ? undefined : structOf(meta, '_meta');
}

function stringEntries(value: unknown, what: string): Record<string, string> {
	const o = asObject(value, what);
	const out: Record<string, string> = {};
	for (const key of Object.keys(o)) {
		defineOwn(out, key, asString(o[key], `a value of ${what}`));
	}
	return out;
}

//#endregion

//#region Message helpers (proto side)

function getString(m: Msg, key: string): string {
	const value = m[key];
	if (value === undefined) {
		return '';
	}
	if (typeof value !== 'string') {
		throw invalid(`${key} is not a string`);
	}
	return value;
}

function getBool(m: Msg, key: string): boolean {
	const value = m[key];
	if (value === undefined) {
		return false;
	}
	if (typeof value !== 'boolean') {
		throw invalid(`${key} is not a boolean`);
	}
	return value;
}

/** A 32-bit integer, float, double or enum field. */
function getNumber(m: Msg, key: string): number | undefined {
	const value = m[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'number') {
		throw invalid(`${key} is not a number`);
	}
	return value;
}

/** A 64-bit integer field, as a safe JavaScript integer. */
function getInteger(m: Msg, key: string): number | undefined {
	const value = m[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === 'bigint') {
		if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw invalid(`${key} is outside the safe integer range`);
		}
		return Number(value);
	}
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw invalid(`${key} is not an integer`);
	}
	return value;
}

function getMessage(m: Msg, key: string): Msg | undefined {
	const value = m[key];
	if (value === undefined) {
		return undefined;
	}
	if (!isObject(value)) {
		throw invalid(`${key} is not a message`);
	}
	return value;
}

function getList(m: Msg, key: string): unknown[] {
	const value = m[key];
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw invalid(`${key} is not repeated`);
	}
	return value;
}

function getMessages(m: Msg, key: string): Msg[] {
	return getList(m, key).map(item => {
		if (!isObject(item)) {
			throw invalid(`an element of ${key} is not a message`);
		}
		return item;
	});
}

function getStrings(m: Msg, key: string): string[] {
	return getList(m, key).map(item => {
		if (typeof item !== 'string') {
			throw invalid(`an element of ${key} is not a string`);
		}
		return item;
	});
}

function getBytes(m: Msg, key: string): Uint8Array | undefined {
	const value = m[key];
	if (value === undefined) {
		return undefined;
	}
	if (!(value instanceof Uint8Array)) {
		throw invalid(`${key} is not bytes`);
	}
	return value;
}

function getMap(m: Msg, key: string): Record<string, unknown> {
	const value = m[key];
	if (value === undefined) {
		return {};
	}
	if (!isObject(value)) {
		throw invalid(`${key} is not a map`);
	}
	return value;
}

function countPresent(m: Msg, keys: readonly string[]): number {
	let count = 0;
	for (const key of keys) {
		if (m[key] !== undefined) {
			count++;
		}
	}
	return count;
}

function putText(out: JsonObject, key: string, text: string): void {
	if (text.length > 0) {
		out[key] = text;
	}
}

function putMeta(out: JsonObject, m: Msg): void {
	const metadata = getMessage(m, 'metadata');
	if (metadata) {
		out._meta = structToJson(metadata);
	}
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/;

/** The text of a `bytes` field that carries MCP base64. */
function base64Text(bytes: Uint8Array, what: string): string {
	let text: string;
	try {
		text = decodeUtf8(bytes);
	} catch {
		throw invalid(`${what} is not base64 text`);
	}
	if (!BASE64.test(text)) {
		throw invalid(`${what} is not base64 text`);
	}
	return text;
}

/**
 * The JSON number of a 32-bit float: the shortest decimal that rounds back
 * to the same float, so that `0.3` stays `0.3` and not `0.30000001192092896`.
 */
function float32ToJson(value: number): number {
	if (!Number.isFinite(value)) {
		throw invalid('a float that is not finite');
	}
	for (let digits = 1; digits <= 9; digits++) {
		const candidate = Number(value.toPrecision(digits));
		if (Math.fround(candidate) === value) {
			return candidate;
		}
	}
	return value;
}

function enumName(table: Readonly<Record<string, number>>, value: number | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	for (const name of Object.keys(table)) {
		if (table[name] === value) {
			return name;
		}
	}
	return undefined;
}

//#endregion

//#region Simple types

function roleToPb(value: unknown, what: string): number {
	const role = asString(value, what);
	switch (role) {
		case 'user': return ROLE.ROLE_USER;
		case 'assistant': return ROLE.ROLE_ASSISTANT;
		default: throw invalid(`the role ${role}`);
	}
}

function roleJson(value: number | undefined): MCP.Role {
	switch (value) {
		case ROLE.ROLE_USER: return 'user';
		case ROLE.ROLE_ASSISTANT: return 'assistant';
		default: throw invalid(`the role ${value}`);
	}
}

function annotationsToPb(value: unknown): Msg {
	const o = asObject(value, 'annotations');
	checkKeys(o, ['audience', 'priority', 'lastModified'], 'annotations');
	const out: Msg = {};
	const audience = fieldOf(o, 'audience');
	if (audience !== undefined) {
		out.audience = asArray(audience, 'annotations.audience').map(role => roleToPb(role, 'a role'));
	}
	const priority = fieldOf(o, 'priority');
	if (priority !== undefined) {
		out.priority = float32Of(priority, 'annotations.priority');
	}
	const lastModified = fieldOf(o, 'lastModified');
	if (lastModified !== undefined) {
		out.last_modified = asString(lastModified, 'annotations.lastModified');
	}
	return out;
}

function annotationsJson(m: Msg): JsonObject {
	const out: JsonObject = {};
	const audience = getList(m, 'audience');
	if (audience.length > 0) {
		out.audience = audience.map(role => {
			if (typeof role !== 'number') {
				throw invalid('a role that is not a number');
			}
			return roleJson(role);
		});
	}
	const priority = getNumber(m, 'priority');
	if (priority !== undefined) {
		out.priority = float32ToJson(priority);
	}
	if (m.last_modified !== undefined) {
		out.lastModified = getString(m, 'last_modified');
	}
	return out;
}

function iconsToPb(value: unknown): Msg[] {
	return asArray(value, 'icons').map(item => {
		const o = asObject(item, 'an icon');
		checkKeys(o, ['src', 'mimeType', 'sizes', 'theme'], 'an icon');
		const icon: Msg = { src: reqString(o, 'src', 'an icon'), mime_type: optString(o, 'mimeType', 'an icon') };
		const sizes = fieldOf(o, 'sizes');
		if (sizes !== undefined) {
			icon.sizes = stringList(sizes, 'icon sizes');
		}
		const theme = fieldOf(o, 'theme');
		if (theme !== undefined) {
			const name = asString(theme, 'an icon theme');
			switch (name) {
				case 'light': icon.theme = ICON_THEME.THEME_LIGHT; break;
				case 'dark': icon.theme = ICON_THEME.THEME_DARK; break;
				default: throw invalid(`the icon theme ${name}`);
			}
		}
		return icon;
	});
}

function iconsJson(icons: readonly Msg[]): JsonObject[] {
	return icons.map(icon => {
		const out: JsonObject = { src: getString(icon, 'src') };
		putText(out, 'mimeType', getString(icon, 'mime_type'));
		const sizes = getStrings(icon, 'sizes');
		if (sizes.length > 0) {
			out.sizes = sizes;
		}
		const theme = getNumber(icon, 'theme');
		switch (theme) {
			case undefined:
			case ICON_THEME.THEME_UNSPECIFIED:
				break;
			case ICON_THEME.THEME_LIGHT: out.theme = 'light'; break;
			case ICON_THEME.THEME_DARK: out.theme = 'dark'; break;
			default: throw invalid(`the icon theme ${theme}`);
		}
		return out;
	});
}

function ttlToPb(o: JsonObject): Msg | undefined {
	const value = fieldOf(o, 'ttlMs');
	if (value === undefined) {
		return undefined;
	}
	return msToDuration(Math.max(asInteger(value, 'ttlMs'), 0));
}

function cacheScopeToPb(o: JsonObject): number {
	const value = fieldOf(o, 'cacheScope');
	if (value === undefined) {
		return CACHE_SCOPE.CACHE_SCOPE_UNSPECIFIED;
	}
	const scope = asString(value, 'cacheScope');
	switch (scope) {
		case 'public': return CACHE_SCOPE.CACHE_SCOPE_PUBLIC;
		case 'private': return CACHE_SCOPE.CACHE_SCOPE_PRIVATE;
		default: throw invalid(`the cache scope ${scope}`);
	}
}

function putCache(out: JsonObject, m: Msg): void {
	const ttl = getMessage(m, 'ttl');
	if (ttl) {
		const seconds = ttl.seconds;
		const nanos = ttl.nanos;
		if (seconds !== undefined && typeof seconds !== 'bigint') {
			throw invalid('a malformed ttl');
		}
		if (nanos !== undefined && typeof nanos !== 'number') {
			throw invalid('a malformed ttl');
		}
		let ms: number;
		try {
			ms = durationToMs({ seconds, nanos });
		} catch {
			throw invalid('a malformed ttl');
		}
		if (ms < 0) {
			throw invalid('a negative ttl');
		}
		out.ttlMs = Math.trunc(ms);
	}
	const scope = getNumber(m, 'cache_scope');
	switch (scope) {
		case undefined:
		case CACHE_SCOPE.CACHE_SCOPE_UNSPECIFIED:
			break;
		case CACHE_SCOPE.CACHE_SCOPE_PUBLIC: out.cacheScope = 'public'; break;
		case CACHE_SCOPE.CACHE_SCOPE_PRIVATE: out.cacheScope = 'private'; break;
		default: throw invalid(`the cache scope ${scope}`);
	}
}

//#endregion

//#region Content

const CONTENT_KINDS = ['text', 'image', 'audio', 'embedded_resource', 'resource_link'] as const;

/** A `CallToolResponse.Content` message (also the content part of a `PromptMessage`). */
function contentToPb(value: unknown): Msg {
	const o = asObject(value, 'a content block');
	const type = reqString(o, 'type', 'a content block');
	switch (type) {
		case 'text': {
			checkKeys(o, ['type', 'text', 'annotations', '_meta'], 'a text content block');
			const text: Msg = { text: reqString(o, 'text', 'a text content block') };
			const annotations = fieldOf(o, 'annotations');
			if (annotations !== undefined) {
				text.annotations = annotationsToPb(annotations);
			}
			const metadata = metaOf(o);
			if (metadata) {
				text.metadata = metadata;
			}
			return { text };
		}
		case 'image':
			return { image: mediaToPb(o) };
		case 'audio':
			return { audio: mediaToPb(o) };
		case 'resource': {
			checkKeys(o, ['type', 'resource', 'annotations', '_meta'], 'an embedded resource');
			const resource = fieldOf(o, 'resource');
			if (resource === undefined) {
				throw invalid('an embedded resource has no resource');
			}
			const embedded: Msg = { contents: resourceContentsToPb(resource) };
			const annotations = fieldOf(o, 'annotations');
			if (annotations !== undefined) {
				embedded.annotations = annotationsToPb(annotations);
			}
			const metadata = metaOf(o);
			if (metadata) {
				embedded.metadata = metadata;
			}
			return { embedded_resource: embedded };
		}
		case 'resource_link':
			return { resource_link: resourceToPb(o, true) };
		default:
			throw unexpressible(`a content block of the type ${type}`);
	}
}

function mediaToPb(o: JsonObject): Msg {
	checkKeys(o, ['type', 'data', 'mimeType', 'annotations', '_meta'], 'an image or audio content block');
	const media: Msg = {
		data: encodeUtf8(reqString(o, 'data', 'an image or audio content block')),
		mime_type: reqString(o, 'mimeType', 'an image or audio content block'),
	};
	const annotations = fieldOf(o, 'annotations');
	if (annotations !== undefined) {
		media.annotations = annotationsToPb(annotations);
	}
	const metadata = metaOf(o);
	if (metadata) {
		media.metadata = metadata;
	}
	return media;
}

function contentJson(m: Msg): JsonObject {
	const kinds = countPresent(m, CONTENT_KINDS);
	if (kinds !== 1) {
		throw invalid(`a content block with ${kinds} kinds`);
	}
	const text = getMessage(m, 'text');
	if (text) {
		const out: JsonObject = { type: 'text', text: getString(text, 'text') };
		putAnnotationsAndMeta(out, text);
		return out;
	}
	const image = getMessage(m, 'image');
	const audio = getMessage(m, 'audio');
	const media = image ?? audio;
	if (media) {
		const data = getBytes(media, 'data') ?? new Uint8Array(0);
		const out: JsonObject = {
			type: image ? 'image' : 'audio',
			data: base64Text(data, 'the data of an image or audio block'),
			mimeType: getString(media, 'mime_type'),
		};
		putAnnotationsAndMeta(out, media);
		return out;
	}
	const embedded = getMessage(m, 'embedded_resource');
	if (embedded) {
		const contents = getMessage(embedded, 'contents');
		if (!contents) {
			throw invalid('an embedded resource has no contents');
		}
		const out: JsonObject = { type: 'resource', resource: resourceContentsJson(contents) };
		putAnnotationsAndMeta(out, embedded);
		return out;
	}
	return resourceJson(getMessage(m, 'resource_link')!, true);
}

function putAnnotationsAndMeta(out: JsonObject, m: Msg): void {
	const annotations = getMessage(m, 'annotations');
	if (annotations) {
		out.annotations = annotationsJson(annotations);
	}
	putMeta(out, m);
}

function resourceContentsToPb(value: unknown): Msg {
	const o = asObject(value, 'resource contents');
	checkKeys(o, ['uri', 'mimeType', '_meta', 'text', 'blob'], 'resource contents');
	const text = fieldOf(o, 'text');
	const blob = fieldOf(o, 'blob');
	if ((text === undefined) === (blob === undefined)) {
		throw invalid('resource contents need exactly one of text and blob');
	}
	const out: Msg = {
		uri: reqString(o, 'uri', 'resource contents'),
		mime_type: optString(o, 'mimeType', 'resource contents'),
		text: text === undefined ? '' : asString(text, 'the text of a resource'),
		blob: encodeUtf8(blob === undefined ? '' : asString(blob, 'the blob of a resource')),
	};
	const metadata = metaOf(o);
	if (metadata) {
		out.metadata = metadata;
	}
	return out;
}

function resourceContentsJson(m: Msg): JsonObject {
	const text = getString(m, 'text');
	const blob = getBytes(m, 'blob') ?? new Uint8Array(0);
	if (text.length > 0 && blob.length > 0) {
		throw invalid('resource contents with text and blob');
	}
	const out: JsonObject = { uri: getString(m, 'uri') };
	putText(out, 'mimeType', getString(m, 'mime_type'));
	putMeta(out, m);
	// As in the reference transport: a blob that is not empty, else the text.
	if (blob.length > 0) {
		out.blob = base64Text(blob, 'the blob of a resource');
	} else {
		out.text = text;
	}
	return out;
}

const RESOURCE_KEYS = ['name', 'title', 'icons', 'uri', 'description', 'mimeType', 'annotations', 'size', '_meta'];
const RESOURCE_LINK_KEYS = [...RESOURCE_KEYS, 'type'];

function resourceToPb(o: JsonObject, link: boolean): Msg {
	const what = link ? 'a resource link' : 'a resource';
	checkKeys(o, link ? RESOURCE_LINK_KEYS : RESOURCE_KEYS, what);
	const out: Msg = {
		uri: reqString(o, 'uri', what),
		name: reqString(o, 'name', what),
		title: optString(o, 'title', what),
		description: optString(o, 'description', what),
		mime_type: optString(o, 'mimeType', what),
	};
	const annotations = fieldOf(o, 'annotations');
	if (annotations !== undefined) {
		out.annotations = annotationsToPb(annotations);
	}
	const size = fieldOf(o, 'size');
	if (size !== undefined) {
		out.size = uint64Of(size, `${what}.size`);
	}
	const icons = fieldOf(o, 'icons');
	if (icons !== undefined) {
		out.icons = iconsToPb(icons);
	}
	const metadata = metaOf(o);
	if (metadata) {
		out.metadata = metadata;
	}
	return out;
}

function resourceJson(m: Msg, link: boolean): JsonObject {
	const out: JsonObject = {};
	if (link) {
		out.type = 'resource_link';
	}
	out.name = getString(m, 'name');
	putText(out, 'title', getString(m, 'title'));
	const icons = getMessages(m, 'icons');
	if (icons.length > 0) {
		out.icons = iconsJson(icons);
	}
	out.uri = getString(m, 'uri');
	putText(out, 'description', getString(m, 'description'));
	putText(out, 'mimeType', getString(m, 'mime_type'));
	const annotations = getMessage(m, 'annotations');
	if (annotations) {
		out.annotations = annotationsJson(annotations);
	}
	const size = getInteger(m, 'size');
	if (size !== undefined && size > 0) {
		out.size = size;
	}
	putMeta(out, m);
	return out;
}

//#endregion

//#region Tools, prompts and templates

function toolToPb(value: unknown): Msg {
	const o = asObject(value, 'a tool');
	checkKeys(o, ['name', 'title', 'icons', 'description', 'inputSchema', 'outputSchema', 'annotations', '_meta'], 'a tool');
	const inputSchema = fieldOf(o, 'inputSchema');
	if (inputSchema === undefined) {
		throw invalid('a tool has no inputSchema');
	}
	const out: Msg = {
		name: reqString(o, 'name', 'a tool'),
		title: optString(o, 'title', 'a tool'),
		description: optString(o, 'description', 'a tool'),
		input_schema: structOf(inputSchema, 'inputSchema'),
	};
	const icons = fieldOf(o, 'icons');
	if (icons !== undefined) {
		out.icons = iconsToPb(icons);
	}
	const metadata = metaOf(o);
	if (metadata) {
		out.metadata = metadata;
	}
	const outputSchema = fieldOf(o, 'outputSchema');
	if (outputSchema !== undefined) {
		out.output_schema = structOf(outputSchema, 'outputSchema');
	}
	const annotations = fieldOf(o, 'annotations');
	if (annotations !== undefined) {
		const ao = asObject(annotations, 'tool annotations');
		checkKeys(ao, ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'], 'tool annotations');
		const hint = (key: string) => {
			const value = fieldOf(ao, key);
			return value === undefined ? false : asBool(value, key);
		};
		out.annotations = {
			title: optString(ao, 'title', 'tool annotations'),
			read_only_hint: hint('readOnlyHint'),
			destructive_hint: hint('destructiveHint'),
			idempotent_hint: hint('idempotentHint'),
			open_world_hint: hint('openWorldHint'),
		};
	}
	return out;
}

function toolJson(m: Msg): JsonObject {
	const out: JsonObject = { name: getString(m, 'name') };
	putText(out, 'title', getString(m, 'title'));
	const icons = getMessages(m, 'icons');
	if (icons.length > 0) {
		out.icons = iconsJson(icons);
	}
	putText(out, 'description', getString(m, 'description'));
	const inputSchema = getMessage(m, 'input_schema');
	out.inputSchema = inputSchema ? structToJson(inputSchema) : { type: 'object' };
	const outputSchema = getMessage(m, 'output_schema');
	if (outputSchema) {
		out.outputSchema = structToJson(outputSchema);
	}
	const annotations = getMessage(m, 'annotations');
	if (annotations) {
		// A false hint is the proto3 default, thus the same as an absent hint.
		const ao: JsonObject = {};
		putText(ao, 'title', getString(annotations, 'title'));
		if (getBool(annotations, 'read_only_hint')) {
			ao.readOnlyHint = true;
		}
		if (getBool(annotations, 'destructive_hint')) {
			ao.destructiveHint = true;
		}
		if (getBool(annotations, 'idempotent_hint')) {
			ao.idempotentHint = true;
		}
		if (getBool(annotations, 'open_world_hint')) {
			ao.openWorldHint = true;
		}
		out.annotations = ao;
	}
	putMeta(out, m);
	return out;
}

function promptToPb(value: unknown): Msg {
	const o = asObject(value, 'a prompt');
	checkKeys(o, ['name', 'title', 'icons', 'description', 'arguments', '_meta'], 'a prompt');
	const out: Msg = {
		name: reqString(o, 'name', 'a prompt'),
		title: optString(o, 'title', 'a prompt'),
		description: optString(o, 'description', 'a prompt'),
	};
	const icons = fieldOf(o, 'icons');
	if (icons !== undefined) {
		out.icons = iconsToPb(icons);
	}
	const metadata = metaOf(o);
	if (metadata) {
		out.metadata = metadata;
	}
	const args = fieldOf(o, 'arguments');
	if (args !== undefined) {
		out.arguments = asArray(args, 'prompt arguments').map(item => {
			const ao = asObject(item, 'a prompt argument');
			checkKeys(ao, ['name', 'title', 'description', 'required'], 'a prompt argument');
			const required = fieldOf(ao, 'required');
			return {
				name: reqString(ao, 'name', 'a prompt argument'),
				title: optString(ao, 'title', 'a prompt argument'),
				description: optString(ao, 'description', 'a prompt argument'),
				required: required === undefined ? false : asBool(required, 'required'),
			};
		});
	}
	return out;
}

function promptJson(m: Msg): JsonObject {
	const out: JsonObject = { name: getString(m, 'name') };
	putText(out, 'title', getString(m, 'title'));
	const icons = getMessages(m, 'icons');
	if (icons.length > 0) {
		out.icons = iconsJson(icons);
	}
	putText(out, 'description', getString(m, 'description'));
	const args = getMessages(m, 'arguments');
	if (args.length > 0) {
		out.arguments = args.map(arg => {
			const ao: JsonObject = { name: getString(arg, 'name') };
			putText(ao, 'title', getString(arg, 'title'));
			putText(ao, 'description', getString(arg, 'description'));
			if (getBool(arg, 'required')) {
				ao.required = true;
			}
			return ao;
		});
	}
	putMeta(out, m);
	return out;
}

function templateToPb(value: unknown): Msg {
	const o = asObject(value, 'a resource template');
	checkKeys(o, ['name', 'title', 'icons', 'uriTemplate', 'description', 'mimeType', 'annotations', '_meta'], 'a resource template');
	const out: Msg = {
		uri_template: reqString(o, 'uriTemplate', 'a resource template'),
		name: reqString(o, 'name', 'a resource template'),
		title: optString(o, 'title', 'a resource template'),
		description: optString(o, 'description', 'a resource template'),
		mime_type: optString(o, 'mimeType', 'a resource template'),
	};
	const annotations = fieldOf(o, 'annotations');
	if (annotations !== undefined) {
		out.annotations = annotationsToPb(annotations);
	}
	const icons = fieldOf(o, 'icons');
	if (icons !== undefined) {
		out.icons = iconsToPb(icons);
	}
	const metadata = metaOf(o);
	if (metadata) {
		out.metadata = metadata;
	}
	return out;
}

function templateJson(m: Msg): JsonObject {
	const out: JsonObject = { name: getString(m, 'name') };
	putText(out, 'title', getString(m, 'title'));
	const icons = getMessages(m, 'icons');
	if (icons.length > 0) {
		out.icons = iconsJson(icons);
	}
	out.uriTemplate = getString(m, 'uri_template');
	putText(out, 'description', getString(m, 'description'));
	putText(out, 'mimeType', getString(m, 'mime_type'));
	const annotations = getMessage(m, 'annotations');
	if (annotations) {
		out.annotations = annotationsJson(annotations);
	}
	putMeta(out, m);
	return out;
}

function promptMessageToPb(value: unknown): Msg {
	const o = asObject(value, 'a prompt message');
	checkKeys(o, ['role', 'content'], 'a prompt message');
	const content = fieldOf(o, 'content');
	if (content === undefined) {
		throw invalid('a prompt message has no content');
	}
	const role = fieldOf(o, 'role');
	if (role === undefined) {
		throw invalid('a prompt message has no role');
	}
	return { role: roleToPb(role, 'a role'), ...contentToPb(content) };
}

function promptMessageJson(m: Msg): JsonObject {
	const content: Msg = {};
	for (const kind of CONTENT_KINDS) {
		if (m[kind] !== undefined) {
			content[kind] = m[kind];
		}
	}
	return { role: roleJson(getNumber(m, 'role')), content: contentJson(content) };
}

//#endregion

//#region Input requests and input responses

function inputRequestsToPb(value: unknown): Record<string, Msg> {
	const o = asObject(value, 'inputRequests');
	const out: Record<string, Msg> = {};
	for (const key of Object.keys(o)) {
		defineOwn(out, key, inputRequestToPb(key, o[key]));
	}
	return out;
}

function inputRequestToPb(key: string, value: unknown): Msg {
	const o = asObject(value, 'an input request');
	checkKeys(o, ['method', 'params'], 'an input request');
	const method = reqString(o, 'method', 'an input request');
	const params = fieldOf(o, 'params');
	switch (method) {
		case 'elicitation/create':
			if (params === undefined) {
				throw invalid('an elicitation request has no params');
			}
			return { elicit_request: elicitToPb(key, params) };
		case 'sampling/createMessage':
			if (params === undefined) {
				throw invalid('a sampling request has no params');
			}
			return { sampling_create_message: samplingRequestToPb(params) };
		case 'roots/list':
			if (params !== undefined && Object.keys(asObject(params, 'the params of roots/list')).length > 0) {
				throw unexpressible('the params of a roots/list input request');
			}
			return { list_roots_request: {} };
		default:
			throw unexpressible(`an input request of the method ${method}`);
	}
}

function inputRequestsJson(entries: Record<string, unknown>): JsonObject {
	const out: JsonObject = {};
	for (const key of Object.keys(entries)) {
		const entry = entries[key];
		if (!isObject(entry)) {
			throw invalid(`the input request ${key} is empty`);
		}
		defineOwn(out, key, inputRequestJson(entry));
	}
	return out;
}

function inputRequestJson(m: Msg): JsonObject {
	const kinds = countPresent(m, ['elicit_request', 'sampling_create_message', 'list_roots_request']);
	if (kinds !== 1) {
		throw invalid(`an input request with ${kinds} kinds`);
	}
	const elicit = getMessage(m, 'elicit_request');
	if (elicit) {
		return { method: 'elicitation/create', params: elicitJson(elicit) };
	}
	const sampling = getMessage(m, 'sampling_create_message');
	if (sampling) {
		return { method: 'sampling/createMessage', params: samplingRequestJson(sampling) };
	}
	return { method: 'roots/list' };
}

function inputResponsesToPb(value: unknown): Record<string, Msg> {
	const o = asObject(value, 'inputResponses');
	const out: Record<string, Msg> = {};
	for (const key of Object.keys(o)) {
		defineOwn(out, key, inputResponseToPb(o[key]));
	}
	return out;
}

/**
 * The keys of an input response tell its kind: `action` marks an elicitation
 * result, `model` a sampling result and `roots` a roots result.
 */
function inputResponseToPb(value: unknown): Msg {
	const o = asObject(value, 'an input response');
	if (hasOwn(o, 'action')) {
		checkKeys(o, ['action', 'content'], 'an elicitation result');
		const action = reqString(o, 'action', 'an elicitation result');
		let type: number;
		switch (action) {
			case 'accept': type = ELICIT_RESULT_TYPE.TYPE_ACCEPT; break;
			case 'decline': type = ELICIT_RESULT_TYPE.TYPE_DECLINE; break;
			case 'cancel': type = ELICIT_RESULT_TYPE.TYPE_CANCEL; break;
			default: throw invalid(`the elicitation action ${action}`);
		}
		const result: Msg = { type };
		const content = fieldOf(o, 'content');
		if (content !== undefined) {
			result.content = structOf(content, 'the content of an elicitation result');
		}
		return { elicit_result: result };
	}
	if (hasOwn(o, 'model')) {
		checkKeys(o, ['role', 'content', 'model', 'stopReason'], 'a sampling result');
		return {
			sampling_create_message_result: {
				message: samplingMessageToPb(o),
				model: reqString(o, 'model', 'a sampling result'),
				stop_reason: optString(o, 'stopReason', 'a sampling result'),
			},
		};
	}
	if (hasOwn(o, 'roots')) {
		checkKeys(o, ['roots'], 'a roots result');
		const roots = asArray(o.roots, 'roots').map(item => {
			const ro = asObject(item, 'a root');
			checkKeys(ro, ['uri', 'name'], 'a root');
			return { uri: reqString(ro, 'uri', 'a root'), name: optString(ro, 'name', 'a root') };
		});
		return { root_list_result: { roots } };
	}
	throw unexpressible('an input response that is not an elicitation, sampling or roots result');
}

function inputResponsesJson(entries: Record<string, unknown>): JsonObject {
	const out: JsonObject = {};
	for (const key of Object.keys(entries)) {
		const entry = entries[key];
		if (!isObject(entry)) {
			throw invalid(`the input response ${key} is empty`);
		}
		defineOwn(out, key, inputResponseJson(entry));
	}
	return out;
}

function inputResponseJson(m: Msg): JsonObject {
	const kinds = countPresent(m, ['elicit_result', 'sampling_create_message_result', 'root_list_result']);
	if (kinds !== 1) {
		throw invalid(`an input response with ${kinds} kinds`);
	}
	const elicit = getMessage(m, 'elicit_result');
	if (elicit) {
		const type = getNumber(elicit, 'type');
		let action: string;
		switch (type) {
			case ELICIT_RESULT_TYPE.TYPE_ACCEPT: action = 'accept'; break;
			case ELICIT_RESULT_TYPE.TYPE_DECLINE: action = 'decline'; break;
			case ELICIT_RESULT_TYPE.TYPE_CANCEL: action = 'cancel'; break;
			default: throw invalid(`the elicitation result type ${type}`);
		}
		const out: JsonObject = { action };
		const content = getMessage(elicit, 'content');
		if (content) {
			out.content = structToJson(content);
		}
		return out;
	}
	const sampling = getMessage(m, 'sampling_create_message_result');
	if (sampling) {
		const message = getMessage(sampling, 'message');
		if (!message) {
			throw invalid('a sampling result has no message');
		}
		const out: JsonObject = {
			role: roleJson(getNumber(message, 'role')),
			content: samplingContentJson(message),
			model: getString(sampling, 'model'),
		};
		putText(out, 'stopReason', getString(sampling, 'stop_reason'));
		return out;
	}
	const roots = getMessages(getMessage(m, 'root_list_result')!, 'roots').map(root => {
		const ro: JsonObject = { uri: getString(root, 'uri') };
		putText(ro, 'name', getString(root, 'name'));
		return ro;
	});
	return { roots };
}

//#endregion

//#region Sampling

/**
 * A sampling message of MCP: `role` and `content`, one text, image or audio
 * block. A list with one block counts as that block; tool-use and tool-result
 * blocks have no field.
 */
function samplingMessageToPb(o: JsonObject): Msg {
	let content = fieldOf(o, 'content');
	if (content === undefined) {
		throw invalid('a sampling message has no content');
	}
	if (Array.isArray(content)) {
		if (content.length !== 1) {
			throw unexpressible(`a sampling message with ${content.length} content blocks`);
		}
		content = content[0];
	}
	const block = contentToPb(content);
	if (block.embedded_resource !== undefined || block.resource_link !== undefined) {
		throw invalid('a sampling message with a resource block');
	}
	const role = fieldOf(o, 'role');
	if (role === undefined) {
		throw invalid('a sampling message has no role');
	}
	return { role: roleToPb(role, 'a role'), ...block };
}

function samplingContentJson(m: Msg): JsonObject {
	const content: Msg = {};
	for (const kind of ['text', 'image', 'audio']) {
		if (m[kind] !== undefined) {
			content[kind] = m[kind];
		}
	}
	return contentJson(content);
}

function samplingRequestToPb(value: unknown): Msg {
	const o = asObject(value, 'sampling params');
	checkKeys(o, ['messages', 'modelPreferences', 'systemPrompt', 'includeContext', 'temperature', 'maxTokens', 'stopSequences'], 'sampling params');
	const messages = fieldOf(o, 'messages');
	if (messages === undefined) {
		throw invalid('sampling params have no messages');
	}
	const out: Msg = {
		messages: asArray(messages, 'sampling messages').map(item => {
			const mo = asObject(item, 'a sampling message');
			checkKeys(mo, ['role', 'content'], 'a sampling message');
			return samplingMessageToPb(mo);
		}),
		system_prompt: optString(o, 'systemPrompt', 'sampling params'),
	};
	const preferences = fieldOf(o, 'modelPreferences');
	if (preferences !== undefined) {
		const po = asObject(preferences, 'model preferences');
		checkKeys(po, ['hints', 'costPriority', 'speedPriority', 'intelligencePriority'], 'model preferences');
		const prefs: Msg = {};
		const hints = fieldOf(po, 'hints');
		if (hints !== undefined) {
			prefs.hints = asArray(hints, 'model hints').map(item => {
				const ho = asObject(item, 'a model hint');
				checkKeys(ho, ['name'], 'a model hint');
				return { name: optString(ho, 'name', 'a model hint') };
			});
		}
		const cost = fieldOf(po, 'costPriority');
		if (cost !== undefined) {
			prefs.cost_priority = float32Of(cost, 'costPriority');
		}
		const speed = fieldOf(po, 'speedPriority');
		if (speed !== undefined) {
			prefs.speed_priority = float32Of(speed, 'speedPriority');
		}
		const intelligence = fieldOf(po, 'intelligencePriority');
		if (intelligence !== undefined) {
			prefs.intelligence_priority = float32Of(intelligence, 'intelligencePriority');
		}
		out.model_preferences = prefs;
	}
	const includeContext = fieldOf(o, 'includeContext');
	if (includeContext !== undefined) {
		const name = asString(includeContext, 'includeContext');
		switch (name) {
			case 'none': out.include_context = INCLUDE_CONTEXT.NONE; break;
			case 'thisServer': out.include_context = INCLUDE_CONTEXT.THIS_SERVER; break;
			case 'allServers': out.include_context = INCLUDE_CONTEXT.ALL_SERVERS; break;
			default: throw invalid(`the includeContext value ${name}`);
		}
	}
	const temperature = fieldOf(o, 'temperature');
	if (temperature !== undefined) {
		out.temperature = float32Of(temperature, 'temperature');
	}
	const maxTokens = fieldOf(o, 'maxTokens');
	if (maxTokens === undefined) {
		throw invalid('sampling params have no maxTokens');
	}
	const tokens = asInteger(maxTokens, 'maxTokens');
	if (tokens < -2147483648 || tokens > 2147483647) {
		throw unexpressible(`maxTokens ${tokens} outside the range of a 32-bit integer`);
	}
	out.max_tokens = tokens;
	const stopSequences = fieldOf(o, 'stopSequences');
	if (stopSequences !== undefined) {
		out.stop_sequence = stringList(stopSequences, 'stopSequences');
	}
	return out;
}

function samplingRequestJson(m: Msg): JsonObject {
	const out: JsonObject = {
		messages: getMessages(m, 'messages').map(message => ({ role: roleJson(getNumber(message, 'role')), content: samplingContentJson(message) })),
	};
	const preferences = getMessage(m, 'model_preferences');
	if (preferences) {
		const po: JsonObject = {};
		const hints = getMessages(preferences, 'hints');
		if (hints.length > 0) {
			po.hints = hints.map(hint => {
				const ho: JsonObject = {};
				putText(ho, 'name', getString(hint, 'name'));
				return ho;
			});
		}
		const cost = getNumber(preferences, 'cost_priority');
		if (cost !== undefined) {
			po.costPriority = float32ToJson(cost);
		}
		const speed = getNumber(preferences, 'speed_priority');
		if (speed !== undefined) {
			po.speedPriority = float32ToJson(speed);
		}
		const intelligence = getNumber(preferences, 'intelligence_priority');
		if (intelligence !== undefined) {
			po.intelligencePriority = float32ToJson(intelligence);
		}
		out.modelPreferences = po;
	}
	putText(out, 'systemPrompt', getString(m, 'system_prompt'));
	const includeContext = getNumber(m, 'include_context');
	switch (includeContext) {
		case undefined:
		case INCLUDE_CONTEXT.NONE:
			break;
		case INCLUDE_CONTEXT.THIS_SERVER: out.includeContext = 'thisServer'; break;
		case INCLUDE_CONTEXT.ALL_SERVERS: out.includeContext = 'allServers'; break;
		default: throw invalid(`the includeContext value ${includeContext}`);
	}
	const temperature = getNumber(m, 'temperature');
	if (temperature !== undefined) {
		out.temperature = float32ToJson(temperature);
	}
	out.maxTokens = getNumber(m, 'max_tokens') ?? 0;
	const stopSequences = getStrings(m, 'stop_sequence');
	if (stopSequences.length > 0) {
		out.stopSequences = stopSequences;
	}
	return out;
}

//#endregion

//#region Elicitation

/**
 * The params of an elicitation. A URL elicitation puts the key of the input
 * request in `UrlMode.id` (or the `elicitationId` of the params, when set).
 */
function elicitToPb(key: string, value: unknown): Msg {
	const o = asObject(value, 'elicitation params');
	const mode = optString(o, 'mode', 'elicitation params');
	if (mode === 'url') {
		checkKeys(o, ['mode', 'message', 'url', 'elicitationId'], 'URL elicitation params');
		const id = fieldOf(o, 'elicitationId');
		return {
			message: reqString(o, 'message', 'elicitation params'),
			url_mode: { id: id === undefined ? key : asString(id, 'elicitationId'), url: reqString(o, 'url', 'URL elicitation params') },
		};
	}
	if (mode.length > 0 && mode !== 'form') {
		throw invalid(`the elicitation mode ${mode}`);
	}
	checkKeys(o, ['mode', 'message', 'requestedSchema'], 'form elicitation params');
	const requested = fieldOf(o, 'requestedSchema');
	if (requested === undefined) {
		throw invalid('form elicitation params have no requestedSchema');
	}
	const schema = asObject(requested, 'requestedSchema');
	checkKeys(schema, ['type', 'properties', 'required'], 'requestedSchema');
	const type = fieldOf(schema, 'type');
	if (type !== undefined && asString(type, 'requestedSchema.type') !== 'object') {
		throw invalid('requestedSchema.type is not object');
	}
	const out: Msg = { message: reqString(o, 'message', 'elicitation params') };
	const properties = fieldOf(schema, 'properties');
	if (properties !== undefined) {
		const props = asObject(properties, 'requestedSchema.properties');
		const entries: Record<string, Msg> = {};
		for (const name of Object.keys(props)) {
			defineOwn(entries, name, primitiveToPb(props[name]));
		}
		out.requested_schema = entries;
	}
	const required = fieldOf(schema, 'required');
	if (required !== undefined) {
		out.required_fields = stringList(required, 'requestedSchema.required');
	}
	return out;
}

function elicitJson(m: Msg): JsonObject {
	const urlMode = getMessage(m, 'url_mode');
	if (urlMode) {
		const out: JsonObject = { mode: 'url', message: getString(m, 'message'), url: getString(urlMode, 'url') };
		putText(out, 'elicitationId', getString(urlMode, 'id'));
		return out;
	}
	const properties: JsonObject = {};
	const entries = getMap(m, 'requested_schema');
	for (const name of Object.keys(entries)) {
		const entry = entries[name];
		if (!isObject(entry)) {
			throw invalid(`the schema of ${name} is empty`);
		}
		defineOwn(properties, name, primitiveJson(entry));
	}
	const schema: JsonObject = { type: 'object', properties };
	const required = getStrings(m, 'required_fields');
	if (required.length > 0) {
		schema.required = required;
	}
	return { message: getString(m, 'message'), requestedSchema: schema };
}

/** A `PrimitiveSchemaDefinition`: one of the four kinds, with the four SEP-1330 enum shapes. */
function primitiveToPb(value: unknown): Msg {
	const o = asObject(value, 'a property schema');
	const type = reqString(o, 'type', 'a property schema');
	const title = optString(o, 'title', 'a property schema');
	const description = optString(o, 'description', 'a property schema');
	const defaultValue = fieldOf(o, 'default');
	if (type === 'boolean') {
		checkKeys(o, ['type', 'title', 'description', 'default'], 'a boolean schema');
		return { boolean_schema: { title, description, default: defaultValue === undefined ? false : asBool(defaultValue, 'a boolean default') } };
	}
	if (type === 'number' || type === 'integer') {
		checkKeys(o, ['type', 'title', 'description', 'minimum', 'maximum', 'default'], 'a number schema');
		const schema: Msg = { title, description };
		const minimum = fieldOf(o, 'minimum');
		const maximum = fieldOf(o, 'maximum');
		if (type === 'integer') {
			// The range message is present, also without bounds: it marks the type integer.
			const range: Msg = {};
			if (minimum !== undefined) {
				range.minimum = asInteger(minimum, 'an integer minimum');
			}
			if (maximum !== undefined) {
				range.maximum = asInteger(maximum, 'an integer maximum');
			}
			schema.integer_range = range;
			if (defaultValue !== undefined) {
				schema.default_integer = asInteger(defaultValue, 'an integer default');
			}
		} else {
			const range: Msg = {};
			if (minimum !== undefined) {
				range.minimum = asNumber(minimum, 'a minimum');
			}
			if (maximum !== undefined) {
				range.maximum = asNumber(maximum, 'a maximum');
			}
			schema.double_range = range;
			if (defaultValue !== undefined) {
				schema.default_number = asNumber(defaultValue, 'a number default');
			}
		}
		return { number_schema: schema };
	}
	if (type === 'array') {
		checkKeys(o, ['type', 'title', 'description', 'minItems', 'maxItems', 'items', 'default'], 'a multi-select enum schema');
		const itemsValue = fieldOf(o, 'items');
		if (itemsValue === undefined) {
			throw invalid('a multi-select enum schema has no items');
		}
		const items = asObject(itemsValue, 'items');
		const schema: Msg = { title, description };
		if (hasOwn(items, 'anyOf')) {
			checkKeys(items, ['anyOf'], 'the items of a titled multi-select enum');
			titledOptions(items.anyOf, schema);
		} else {
			checkKeys(items, ['type', 'enum'], 'the items of a multi-select enum');
			const itemType = fieldOf(items, 'type');
			if (itemType !== undefined && asString(itemType, 'items.type') !== 'string') {
				throw unexpressible('a multi-select enum of a type other than string');
			}
			const list = fieldOf(items, 'enum');
			if (list === undefined) {
				throw invalid('a multi-select enum has no enum');
			}
			schema.enum_list = stringList(list, 'enum');
		}
		const multi: Msg = {};
		if (defaultValue !== undefined) {
			multi.default_items = stringList(defaultValue, 'a multi-select default');
		}
		const minItems = fieldOf(o, 'minItems');
		if (minItems !== undefined) {
			multi.min_items = uint32Of(minItems, 'minItems');
		}
		const maxItems = fieldOf(o, 'maxItems');
		if (maxItems !== undefined) {
			multi.max_items = uint32Of(maxItems, 'maxItems');
		}
		schema.multi_select = multi;
		return { enum_schema: schema };
	}
	if (type !== 'string') {
		throw unexpressible(`a property schema of the type ${type}`);
	}
	if (hasOwn(o, 'oneOf') || hasOwn(o, 'enum')) {
		const schema: Msg = { title, description };
		if (hasOwn(o, 'oneOf')) {
			checkKeys(o, ['type', 'title', 'description', 'oneOf', 'default'], 'a titled enum schema');
			titledOptions(o.oneOf, schema);
		} else {
			checkKeys(o, ['type', 'title', 'description', 'enum', 'enumNames', 'default'], 'an enum schema');
			const list = stringList(o.enum, 'enum');
			schema.enum_list = list;
			const names = fieldOf(o, 'enumNames');
			if (names !== undefined) {
				const enumNames = stringList(names, 'enumNames');
				if (enumNames.length !== list.length) {
					throw invalid('enumNames and enum have different lengths');
				}
				schema.enum_names = enumNames;
			}
		}
		const single: Msg = {};
		if (defaultValue !== undefined) {
			single.default_item = asString(defaultValue, 'an enum default');
		}
		schema.single_select = single;
		return { enum_schema: schema };
	}
	checkKeys(o, ['type', 'title', 'description', 'minLength', 'maxLength', 'format', 'default'], 'a string schema');
	const schema: Msg = { title, description };
	const minLength = fieldOf(o, 'minLength');
	if (minLength !== undefined) {
		schema.min_length = uint64Of(minLength, 'minLength');
	}
	const maxLength = fieldOf(o, 'maxLength');
	if (maxLength !== undefined) {
		schema.max_length = uint64Of(maxLength, 'maxLength');
	}
	const format = fieldOf(o, 'format');
	if (format !== undefined) {
		const name = asString(format, 'format');
		switch (name) {
			case 'email': schema.format = STRING_FORMAT.FORMAT_EMAIL; break;
			case 'uri': schema.format = STRING_FORMAT.FORMAT_URI; break;
			case 'date': schema.format = STRING_FORMAT.FORMAT_DATE; break;
			case 'date-time': schema.format = STRING_FORMAT.FORMAT_DATE_TIME; break;
			default: throw unexpressible(`the string format ${name}`);
		}
	}
	if (defaultValue !== undefined) {
		schema.default_value = asString(defaultValue, 'a string default');
	}
	return { string_schema: schema };
}

/** `oneOf` or `anyOf` options with `const` and `title`. */
function titledOptions(value: unknown, schema: Msg): void {
	const values: string[] = [];
	const names: string[] = [];
	for (const option of asArray(value, 'enum options')) {
		const oo = asObject(option, 'an enum option');
		checkKeys(oo, ['const', 'title'], 'an enum option');
		values.push(reqString(oo, 'const', 'an enum option'));
		names.push(reqString(oo, 'title', 'an enum option'));
	}
	schema.enum_list = values;
	schema.enum_names = names;
}

function primitiveJson(m: Msg): JsonObject {
	const kinds = countPresent(m, ['string_schema', 'number_schema', 'boolean_schema', 'enum_schema']);
	if (kinds !== 1) {
		throw invalid(`a property schema with ${kinds} kinds`);
	}
	const out: JsonObject = {};
	const string = getMessage(m, 'string_schema');
	if (string) {
		out.type = 'string';
		putText(out, 'title', getString(string, 'title'));
		putText(out, 'description', getString(string, 'description'));
		const minLength = getInteger(string, 'min_length');
		if (minLength !== undefined) {
			out.minLength = minLength;
		}
		const maxLength = getInteger(string, 'max_length');
		if (maxLength !== undefined) {
			out.maxLength = maxLength;
		}
		const format = getNumber(string, 'format');
		switch (format) {
			case undefined:
			case STRING_FORMAT.FORMAT_UNKNOWN:
				break;
			case STRING_FORMAT.FORMAT_EMAIL: out.format = 'email'; break;
			case STRING_FORMAT.FORMAT_URI: out.format = 'uri'; break;
			case STRING_FORMAT.FORMAT_DATE: out.format = 'date'; break;
			case STRING_FORMAT.FORMAT_DATE_TIME: out.format = 'date-time'; break;
			default: throw invalid(`the string format ${format}`);
		}
		if (string.default_value !== undefined) {
			out.default = getString(string, 'default_value');
		}
		return out;
	}
	const number = getMessage(m, 'number_schema');
	if (number) {
		const integerRange = getMessage(number, 'integer_range');
		const doubleRange = getMessage(number, 'double_range');
		if (integerRange && doubleRange) {
			throw invalid('a number schema with two ranges');
		}
		out.type = integerRange ? 'integer' : 'number';
		putText(out, 'title', getString(number, 'title'));
		putText(out, 'description', getString(number, 'description'));
		if (integerRange) {
			const minimum = getInteger(integerRange, 'minimum');
			if (minimum !== undefined) {
				out.minimum = minimum;
			}
			const maximum = getInteger(integerRange, 'maximum');
			if (maximum !== undefined) {
				out.maximum = maximum;
			}
		} else if (doubleRange) {
			const minimum = getNumber(doubleRange, 'minimum');
			if (minimum !== undefined) {
				out.minimum = minimum;
			}
			const maximum = getNumber(doubleRange, 'maximum');
			if (maximum !== undefined) {
				out.maximum = maximum;
			}
		} else {
			// The deprecated unsigned bounds of older producers.
			const minimum = getInteger(number, 'minimum');
			if (minimum !== undefined && minimum > 0) {
				out.minimum = minimum;
			}
			const maximum = getInteger(number, 'maximum');
			if (maximum !== undefined && maximum > 0) {
				out.maximum = maximum;
			}
		}
		const defaultInteger = getInteger(number, 'default_integer');
		const defaultNumber = getNumber(number, 'default_number');
		if (defaultInteger !== undefined) {
			out.default = defaultInteger;
		} else if (defaultNumber !== undefined) {
			out.default = defaultNumber;
		}
		return out;
	}
	const boolean = getMessage(m, 'boolean_schema');
	if (boolean) {
		out.type = 'boolean';
		putText(out, 'title', getString(boolean, 'title'));
		putText(out, 'description', getString(boolean, 'description'));
		if (getBool(boolean, 'default')) {
			out.default = true;
		}
		return out;
	}
	const enumSchema = getMessage(m, 'enum_schema')!;
	const list = getStrings(enumSchema, 'enum_list');
	const names = getStrings(enumSchema, 'enum_names');
	if (names.length > 0 && names.length !== list.length) {
		throw invalid('enum_names and enum_list have different lengths');
	}
	const titled = names.length > 0;
	const options = () => list.map((value, i) => ({ const: value, title: names[i] }));
	const multi = getMessage(enumSchema, 'multi_select');
	const single = getMessage(enumSchema, 'single_select');
	if (multi && single) {
		throw invalid('an enum schema with single_select and multi_select');
	}
	if (multi) {
		out.type = 'array';
		putText(out, 'title', getString(enumSchema, 'title'));
		putText(out, 'description', getString(enumSchema, 'description'));
		const minItems = getNumber(multi, 'min_items');
		if (minItems !== undefined) {
			out.minItems = minItems;
		}
		const maxItems = getNumber(multi, 'max_items');
		if (maxItems !== undefined) {
			out.maxItems = maxItems;
		}
		out.items = titled ? { anyOf: options() } : { type: 'string', enum: list };
		const defaults = getStrings(multi, 'default_items');
		if (defaults.length > 0) {
			out.default = defaults;
		}
	} else {
		out.type = 'string';
		putText(out, 'title', getString(enumSchema, 'title'));
		putText(out, 'description', getString(enumSchema, 'description'));
		if (titled) {
			out.oneOf = options();
		} else {
			out.enum = list;
		}
		if (single && single.default_item !== undefined) {
			out.default = getString(single, 'default_item');
		}
	}
	return out;
}

//#endregion

//#region Requests

const COMMON_PARAM_KEYS = ['_meta', 'inputResponses', 'requestState'];

function requestFieldsToPb(o: JsonObject): Msg | undefined {
	const common: Msg = {};
	let any = false;
	const metadata = metaOf(o);
	if (metadata) {
		common.metadata = metadata;
		any = true;
	}
	const responses = fieldOf(o, 'inputResponses');
	if (responses !== undefined) {
		common.input_responses = inputResponsesToPb(responses);
		any = true;
	}
	const state = fieldOf(o, 'requestState');
	if (state !== undefined) {
		common.request_state = asString(state, 'requestState');
		any = true;
	}
	return any ? common : undefined;
}

function withCommon(common: Msg | undefined, rest: Msg): Msg {
	return common ? { common, ...rest } : rest;
}

function paramsToMessage(rpc: ITypedRpc, params: unknown): Msg {
	const o = asObject(params ?? {}, 'params');
	const common = requestFieldsToPb(o);
	switch (rpc.name) {
		case 'ListResources':
		case 'ListResourceTemplates':
		case 'ListPrompts':
		case 'ListTools': {
			checkKeys(o, [...COMMON_PARAM_KEYS, 'cursor'], `the params of ${rpc.jsonRpcMethod}`);
			const cursor = fieldOf(o, 'cursor');
			if (cursor !== undefined && asString(cursor, 'cursor').length > 0) {
				throw unexpressible('a cursor: the typed binding has no pagination');
			}
			return withCommon(common, {});
		}
		case 'ReadResource':
			checkKeys(o, [...COMMON_PARAM_KEYS, 'uri'], 'the params of resources/read');
			return withCommon(common, { uri: reqString(o, 'uri', 'the params of resources/read') });
		case 'GetPrompt': {
			checkKeys(o, [...COMMON_PARAM_KEYS, 'name', 'arguments'], 'the params of prompts/get');
			const out: Msg = { name: reqString(o, 'name', 'the params of prompts/get') };
			const args = fieldOf(o, 'arguments');
			if (args !== undefined) {
				out.arguments = stringEntries(args, 'prompt arguments');
			}
			return withCommon(common, out);
		}
		case 'CallTool': {
			checkKeys(o, [...COMMON_PARAM_KEYS, 'name', 'arguments'], 'the params of tools/call');
			const request: Msg = { name: reqString(o, 'name', 'the params of tools/call') };
			const args = fieldOf(o, 'arguments');
			if (args !== undefined) {
				request.arguments = structOf(args, 'tool arguments');
			}
			return withCommon(common, { request });
		}
		case 'Complete': {
			checkKeys(o, [...COMMON_PARAM_KEYS, 'ref', 'argument', 'context'], 'the params of completion/complete');
			const out: Msg = {};
			const refValue = fieldOf(o, 'ref');
			if (refValue === undefined) {
				throw invalid('a completion request has no ref');
			}
			const ref = asObject(refValue, 'ref');
			const refType = reqString(ref, 'type', 'ref');
			if (refType === 'ref/prompt') {
				checkKeys(ref, ['type', 'name', 'title'], 'a prompt reference');
				out.prompt_reference = { name: reqString(ref, 'name', 'a prompt reference'), title: optString(ref, 'title', 'a prompt reference') };
			} else if (refType === 'ref/resource') {
				checkKeys(ref, ['type', 'uri'], 'a resource reference');
				out.resource_reference = { uri: reqString(ref, 'uri', 'a resource reference') };
			} else {
				throw invalid(`the reference type ${refType}`);
			}
			const argValue = fieldOf(o, 'argument');
			if (argValue === undefined) {
				throw invalid('a completion request has no argument');
			}
			const arg = asObject(argValue, 'argument');
			checkKeys(arg, ['name', 'value'], 'a completion argument');
			out.argument = { name: reqString(arg, 'name', 'a completion argument'), value: reqString(arg, 'value', 'a completion argument') };
			const context = fieldOf(o, 'context');
			if (context !== undefined) {
				const co = asObject(context, 'context');
				checkKeys(co, ['arguments'], 'a completion context');
				const args = fieldOf(co, 'arguments');
				out.context = args === undefined ? {} : { arguments: stringEntries(args, 'context arguments') };
			}
			return withCommon(common, out);
		}
	}
}

function messageToParams(rpc: ITypedRpc, m: Msg): JsonObject {
	const out: JsonObject = {};
	const common = getMessage(m, 'common');
	if (common) {
		putMeta(out, common);
		const responses = getMap(common, 'input_responses');
		if (Object.keys(responses).length > 0) {
			out.inputResponses = inputResponsesJson(responses);
		}
		if (common.request_state !== undefined) {
			out.requestState = getString(common, 'request_state');
		}
	}
	switch (rpc.name) {
		case 'ListResources':
		case 'ListResourceTemplates':
		case 'ListPrompts':
		case 'ListTools':
			break;
		case 'ReadResource': {
			const uri = getString(m, 'uri');
			if (uri.length === 0) {
				throw invalid('Missing resource URI');
			}
			out.uri = uri;
			break;
		}
		case 'GetPrompt': {
			const name = getString(m, 'name');
			if (name.length === 0) {
				throw invalid('Missing prompt name');
			}
			out.name = name;
			const args = getMap(m, 'arguments');
			if (Object.keys(args).length > 0) {
				out.arguments = stringMapJson(args);
			}
			break;
		}
		case 'CallTool': {
			const request = getMessage(m, 'request');
			const name = request ? getString(request, 'name') : '';
			if (!request || name.length === 0) {
				throw invalid('Missing tool name');
			}
			out.name = name;
			const args = getMessage(request, 'arguments');
			if (args) {
				out.arguments = structToJson(args);
			}
			break;
		}
		case 'Complete': {
			const resource = getMessage(m, 'resource_reference');
			const prompt = getMessage(m, 'prompt_reference');
			if (resource && prompt) {
				throw invalid('A completion request has two references');
			}
			if (prompt) {
				const ref: JsonObject = { type: 'ref/prompt', name: getString(prompt, 'name') };
				putText(ref, 'title', getString(prompt, 'title'));
				out.ref = ref;
			} else if (resource) {
				out.ref = { type: 'ref/resource', uri: getString(resource, 'uri') };
			} else {
				throw invalid('A completion request has no reference');
			}
			const arg = getMessage(m, 'argument');
			if (!arg) {
				throw invalid('A completion request has no argument');
			}
			out.argument = { name: getString(arg, 'name'), value: getString(arg, 'value') };
			const context = getMessage(m, 'context');
			if (context) {
				const co: JsonObject = {};
				const args = getMap(context, 'arguments');
				if (Object.keys(args).length > 0) {
					co.arguments = stringMapJson(args);
				}
				out.context = co;
			}
			break;
		}
	}
	return out;
}

function stringMapJson(entries: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(entries)) {
		const value = entries[key];
		if (typeof value !== 'string') {
			throw invalid(`the value of ${key} is not a string`);
		}
		defineOwn(out, key, value);
	}
	return out;
}

//#endregion

//#region Results

const COMMON_RESULT_KEYS = ['_meta', 'resultType'];
const LIST_RESULT_KEYS = [...COMMON_RESULT_KEYS, 'ttlMs', 'cacheScope'];

function listOf<T>(o: JsonObject, key: string, convert: (value: unknown) => T): T[] {
	const value = fieldOf(o, key);
	if (value === undefined) {
		throw invalid(`the result has no ${key}`);
	}
	return asArray(value, key).map(convert);
}

function cacheable(o: JsonObject, common: Msg, rest: Msg): Msg {
	const out: Msg = { common, ...rest };
	const ttl = ttlToPb(o);
	if (ttl) {
		out.ttl = ttl;
	}
	out.cache_scope = cacheScopeToPb(o);
	return out;
}

function resultToMessage(rpc: ITypedRpc, result: unknown): Msg {
	const o = asObject(result, 'the result');
	const typeValue = fieldOf(o, 'resultType');
	const resultType = typeValue === undefined ? 'complete' : asString(typeValue, 'resultType');
	const common: Msg = { result_type: RESULT_TYPE.RESULT_TYPE_COMPLETE };
	const metadata = metaOf(o);
	if (metadata) {
		common.metadata = metadata;
	}
	if (resultType === 'input_required') {
		checkKeys(o, [...COMMON_RESULT_KEYS, 'inputRequests', 'requestState'], 'an input required result');
		common.result_type = RESULT_TYPE.RESULT_TYPE_INPUT_REQUIRED;
		const requests = fieldOf(o, 'inputRequests');
		if (requests !== undefined) {
			common.input_requests = inputRequestsToPb(requests);
		}
		const state = fieldOf(o, 'requestState');
		if (state !== undefined) {
			common.request_state = asString(state, 'requestState');
		}
		return { common };
	}
	if (resultType !== 'complete') {
		throw unexpressible(`a result of the type ${resultType}`);
	}
	switch (rpc.name) {
		case 'ListTools':
			checkKeys(o, [...LIST_RESULT_KEYS, 'tools'], 'the tools/list result');
			return cacheable(o, common, { tools: listOf(o, 'tools', toolToPb) });
		case 'ListResources':
			checkKeys(o, [...LIST_RESULT_KEYS, 'resources'], 'the resources/list result');
			return cacheable(o, common, { resources: listOf(o, 'resources', item => resourceToPb(asObject(item, 'a resource'), false)) });
		case 'ListResourceTemplates':
			checkKeys(o, [...LIST_RESULT_KEYS, 'resourceTemplates'], 'the resources/templates/list result');
			return cacheable(o, common, { resource_templates: listOf(o, 'resourceTemplates', templateToPb) });
		case 'ListPrompts':
			checkKeys(o, [...LIST_RESULT_KEYS, 'prompts'], 'the prompts/list result');
			return cacheable(o, common, { prompts: listOf(o, 'prompts', promptToPb) });
		case 'ReadResource':
			checkKeys(o, [...LIST_RESULT_KEYS, 'contents'], 'the resources/read result');
			return cacheable(o, common, { resource: listOf(o, 'contents', resourceContentsToPb) });
		case 'GetPrompt':
			checkKeys(o, [...COMMON_RESULT_KEYS, 'description', 'messages'], 'the prompts/get result');
			return { common, description: optString(o, 'description', 'the prompts/get result'), messages: listOf(o, 'messages', promptMessageToPb) };
		case 'CallTool': {
			checkKeys(o, [...COMMON_RESULT_KEYS, 'content', 'structuredContent', 'isError'], 'the tools/call result');
			const out: Msg = { common, content: listOf(o, 'content', contentToPb) };
			const structured = fieldOf(o, 'structuredContent');
			if (structured !== undefined) {
				if (!isObject(structured)) {
					throw unexpressible('structuredContent that is not a JSON object');
				}
				out.structured_content = structOf(structured, 'structuredContent');
			}
			const isError = fieldOf(o, 'isError');
			if (isError !== undefined) {
				out.is_error = asBool(isError, 'isError');
			}
			return out;
		}
		case 'Complete': {
			checkKeys(o, [...COMMON_RESULT_KEYS, 'completion'], 'the completion/complete result');
			const completionValue = fieldOf(o, 'completion');
			if (completionValue === undefined) {
				throw invalid('the result has no completion');
			}
			const completion = asObject(completionValue, 'completion');
			checkKeys(completion, ['values', 'total', 'hasMore'], 'a completion');
			const values = fieldOf(completion, 'values');
			if (values === undefined) {
				throw invalid('a completion has no values');
			}
			const out: Msg = { common, values: stringList(values, 'completion values') };
			const total = fieldOf(completion, 'total');
			if (total !== undefined) {
				out.total_matches = asInteger(total, 'completion total');
			}
			const hasMore = fieldOf(completion, 'hasMore');
			if (hasMore !== undefined) {
				out.has_more = asBool(hasMore, 'hasMore');
			}
			return out;
		}
	}
}

function messageToResult(rpc: ITypedRpc, m: Msg): JsonObject {
	const out: JsonObject = {};
	const common = getMessage(m, 'common') ?? {};
	const resultType = getNumber(common, 'result_type');
	switch (resultType) {
		case undefined:
		case RESULT_TYPE.RESULT_TYPE_UNSPECIFIED:
		case RESULT_TYPE.RESULT_TYPE_COMPLETE:
			// An unset result type counts as complete.
			break;
		case RESULT_TYPE.RESULT_TYPE_INPUT_REQUIRED: {
			out.resultType = 'input_required';
			putMeta(out, common);
			const requests = getMap(common, 'input_requests');
			if (Object.keys(requests).length > 0) {
				out.inputRequests = inputRequestsJson(requests);
			}
			if (common.request_state !== undefined) {
				out.requestState = getString(common, 'request_state');
			}
			return out;
		}
		default:
			throw invalid(`the result type ${enumName(RESULT_TYPE, resultType) ?? resultType}`);
	}
	out.resultType = 'complete';
	putMeta(out, common);
	switch (rpc.name) {
		case 'ListTools':
			out.tools = getMessages(m, 'tools').map(toolJson);
			putCache(out, m);
			break;
		case 'ListResources':
			out.resources = getMessages(m, 'resources').map(resource => resourceJson(resource, false));
			putCache(out, m);
			break;
		case 'ListResourceTemplates':
			out.resourceTemplates = getMessages(m, 'resource_templates').map(templateJson);
			putCache(out, m);
			break;
		case 'ListPrompts':
			out.prompts = getMessages(m, 'prompts').map(promptJson);
			putCache(out, m);
			break;
		case 'ReadResource':
			out.contents = getMessages(m, 'resource').map(resourceContentsJson);
			putCache(out, m);
			break;
		case 'GetPrompt':
			putText(out, 'description', getString(m, 'description'));
			out.messages = getMessages(m, 'messages').map(promptMessageJson);
			break;
		case 'CallTool': {
			out.content = getMessages(m, 'content').map(contentJson);
			const structured = getMessage(m, 'structured_content');
			if (structured) {
				out.structuredContent = structToJson(structured);
			}
			if (getBool(m, 'is_error')) {
				out.isError = true;
			}
			break;
		}
		case 'Complete': {
			const completion: JsonObject = { values: getStrings(m, 'values') };
			const total = getInteger(m, 'total_matches');
			if (total !== undefined) {
				completion.total = total;
			}
			if (getBool(m, 'has_more')) {
				completion.hasMore = true;
			}
			out.completion = completion;
			break;
		}
	}
	return out;
}

//#endregion
