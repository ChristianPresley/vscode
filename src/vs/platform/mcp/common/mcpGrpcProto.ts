/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hand-written protobuf descriptors for the two gRPC bindings of MCP:
 *
 * - The JSON-RPC tunnel of `mcp_zig_transport_v1.proto` (one `Call` carries
 *   one JSON-RPC request and streams back its notifications and response).
 * - The typed service `model_context_protocol.Mcp` of the Google Cloud proto
 *   files (`mcp.proto` and `mcp_messages.proto`, release v0.2.0).
 *
 * The descriptors transcribe the vendored proto files under
 * `src/vs/platform/mcp/test/node/fixtures/grpc/`; a node test parses those
 * files and checks every field here against them. Fields are listed by field
 * number so that the codec writes them in canonical order.
 */

import { IFieldDescriptor, IMessageDescriptor, MapKeyKind, ScalarKind } from '../../../base/common/protobuf/codec.js';
import { DURATION, STRUCT } from '../../../base/common/protobuf/wellKnown.js';

//#region Constants

/** The proto package of the tunnel. */
export const TUNNEL_PACKAGE = 'mcp.zig.transport.v1';
/** The full name of the tunnel service. */
export const TUNNEL_SERVICE = `${TUNNEL_PACKAGE}.Mcp`;
/** The HTTP/2 path of the tunnel's only method. */
export const TUNNEL_CALL_PATH = `/${TUNNEL_SERVICE}/Call`;

/** The proto package of the typed binding. */
export const TYPED_PACKAGE = 'model_context_protocol';
/** The full name of the typed service. */
export const TYPED_SERVICE = `${TYPED_PACKAGE}.Mcp`;
/** The HTTP/2 path prefix of the typed service; the RPC name follows. */
export const TYPED_PATH_PREFIX = `/${TYPED_SERVICE}/`;

/** The content type both bindings send. Servers accept any `application/grpc` type. */
export const GRPC_CONTENT_TYPE = 'application/grpc+proto';

/** Trailer with the JSON-RPC error code in decimal, as in the reference transport. */
export const MCP_ERROR_CODE_TRAILER = 'mcp-error-code';
/** Trailer with the JSON-RPC error response, base64 (a zig-sdk extension). */
export const MCP_ERROR_BIN_TRAILER = 'mcp-error-bin';
/** The largest `mcp-error-bin` value a server sends; a larger error response travels without it. */
export const MAX_ERROR_BIN_BYTES = 4096;
/** Request metadata with the protocol version of the body. */
export const MCP_PROTOCOL_VERSION_METADATA = 'mcp-protocol-version';

/** Routing metadata of the typed binding (from the proto service comments). */
export type TypedRoutingKey = 'mcp_tool' | 'mcp_prompt' | 'mcp_resource';

//#endregion

//#region Tunnel

/** `mcp.zig.transport.v1.JsonRpcMessage`: `{ jsonrpc: Uint8Array }` (UTF-8 JSON text). */
export const JSON_RPC_MESSAGE: IMessageDescriptor = {
	name: `${TUNNEL_PACKAGE}.JsonRpcMessage`,
	fields: [
		{ name: 'jsonrpc', number: 1, kind: 'bytes' },
	],
};

//#endregion

//#region Enums

export const PROTOCOL_VERSION = Object.freeze({
	VERSION_UNKNOWN: 0,
	VERSION_20250326: 1,
	VERSION_20250618: 2,
	VERSION_20251125: 3,
	VERSION_20260728: 4,
});

export const RESULT_TYPE = Object.freeze({
	RESULT_TYPE_UNSPECIFIED: 0,
	RESULT_TYPE_COMPLETE: 1,
	RESULT_TYPE_INPUT_REQUIRED: 2,
});

export const CACHE_SCOPE = Object.freeze({
	CACHE_SCOPE_UNSPECIFIED: 0,
	CACHE_SCOPE_PUBLIC: 1,
	CACHE_SCOPE_PRIVATE: 2,
});

export const ROLE = Object.freeze({
	ROLE_UNKNOWN: 0,
	ROLE_USER: 1,
	ROLE_ASSISTANT: 2,
});

export const ICON_THEME = Object.freeze({
	THEME_UNSPECIFIED: 0,
	THEME_LIGHT: 1,
	THEME_DARK: 2,
});

export const INCLUDE_CONTEXT = Object.freeze({
	NONE: 0,
	THIS_SERVER: 1,
	ALL_SERVERS: 2,
});

export const STRING_FORMAT = Object.freeze({
	FORMAT_UNKNOWN: 0,
	FORMAT_EMAIL: 1,
	FORMAT_URI: 2,
	FORMAT_DATE: 3,
	FORMAT_DATE_TIME: 4,
});

export const ELICIT_RESULT_TYPE = Object.freeze({
	UNKNOWN: 0,
	TYPE_ACCEPT: 1,
	TYPE_DECLINE: 2,
	TYPE_CANCEL: 3,
});

/** Every enum of `mcp_messages.proto`, keyed by its name relative to the package (nested enums use dots). */
export const MCP_ENUMS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
	'ProtocolVersion': PROTOCOL_VERSION,
	'ResultType': RESULT_TYPE,
	'CacheScope': CACHE_SCOPE,
	'Role': ROLE,
	'Icon.Theme': ICON_THEME,
	'SamplingCreateMessageRequest.IncludeContext': INCLUDE_CONTEXT,
	'PrimitiveSchemaDefinition.StringSchema.Format': STRING_FORMAT,
	'ElicitResult.Type': ELICIT_RESULT_TYPE,
});

//#endregion

//#region Descriptor helpers

type FieldExtras = Omit<IFieldDescriptor, 'name' | 'number' | 'kind' | 'message' | 'map'>;

const registry: Record<string, IMessageDescriptor> = {};

/** Defines a message of the `model_context_protocol` package; `name` is relative to the package. */
function define(name: string, fields: readonly IFieldDescriptor[]): IMessageDescriptor {
	const descriptor: IMessageDescriptor = { name: `${TYPED_PACKAGE}.${name}`, fields };
	Object.defineProperty(registry, name, { value: descriptor, enumerable: true, writable: false, configurable: false });
	return descriptor;
}

function scalar(name: string, number: number, kind: Exclude<ScalarKind, 'message' | 'enum'>, extras?: FieldExtras): IFieldDescriptor {
	return { name, number, kind, ...extras };
}

function enumeration(name: string, number: number, values: Readonly<Record<string, number>>, extras?: FieldExtras): IFieldDescriptor {
	return { name, number, kind: 'enum', enum: values, ...extras };
}

function message(name: string, number: number, descriptor: () => IMessageDescriptor, extras?: FieldExtras): IFieldDescriptor {
	return { name, number, kind: 'message', message: descriptor, ...extras };
}

function mapOf(name: string, number: number, key: MapKeyKind, value: Omit<IFieldDescriptor, 'name' | 'number'>): IFieldDescriptor {
	return { name, number, kind: 'message', map: { key, value: { ...value, name: 'value', number: 2 } } };
}

const struct = (name: string, number: number, extras?: FieldExtras) => message(name, number, () => STRUCT, extras);
const duration = (name: string, number: number) => message(name, number, () => DURATION);

//#endregion

//#region Messages (mcp_messages.proto)

export const INPUT_REQUEST = define('InputRequest', [
	message('sampling_create_message', 8, () => SAMPLING_CREATE_MESSAGE_REQUEST, { deprecated: true }),
	message('list_roots_request', 9, () => LIST_ROOTS_REQUEST, { deprecated: true }),
	scalar('notify_on_root_list_update', 10, 'bool', { deprecated: true }),
	message('elicit_request', 11, () => ELICIT_REQUEST),
]);

export const INPUT_RESPONSE = define('InputResponse', [
	message('sampling_create_message_result', 7, () => SAMPLING_CREATE_MESSAGE_RESULT, { deprecated: true }),
	message('root_list_result', 8, () => LIST_ROOTS_RESULT, { deprecated: true }),
	message('elicit_result', 9, () => ELICIT_RESULT),
]);

export const REQUEST_FIELDS = define('RequestFields', [
	struct('metadata', 1),
	mapOf('input_responses', 6, 'string', { kind: 'message', message: () => INPUT_RESPONSE }),
	struct('resume_data', 7, { deprecated: true }),
	scalar('request_state', 8, 'string', { presence: 'explicit' }),
]);

export const RESPONSE_FIELDS = define('ResponseFields', [
	scalar('instructions', 1, 'string'),
	struct('metadata', 2),
	mapOf('input_requests', 7, 'string', { kind: 'message', message: () => INPUT_REQUEST }),
	struct('resume_data', 8, { deprecated: true }),
	enumeration('result_type', 9, RESULT_TYPE),
	scalar('request_state', 10, 'string', { presence: 'explicit' }),
]);

export const ANNOTATIONS = define('Annotations', [
	enumeration('audience', 1, ROLE, { repeated: true }),
	scalar('priority', 2, 'float', { presence: 'explicit' }),
	scalar('last_modified', 3, 'string', { presence: 'explicit' }),
]);

export const ICON = define('Icon', [
	scalar('src', 1, 'string'),
	scalar('mime_type', 2, 'string'),
	scalar('sizes', 3, 'string', { repeated: true }),
	enumeration('theme', 4, ICON_THEME),
]);

export const TEXT_CONTENT = define('TextContent', [
	scalar('text', 1, 'string'),
	message('annotations', 2, () => ANNOTATIONS),
	struct('metadata', 3),
]);

export const IMAGE_CONTENT = define('ImageContent', [
	scalar('data', 1, 'bytes'),
	scalar('mime_type', 2, 'string'),
	message('annotations', 3, () => ANNOTATIONS),
	struct('metadata', 4),
]);

export const AUDIO_CONTENT = define('AudioContent', [
	scalar('data', 1, 'bytes'),
	scalar('mime_type', 2, 'string'),
	message('annotations', 3, () => ANNOTATIONS),
	struct('metadata', 4),
]);

export const LIST_ROOTS_REQUEST = define('ListRootsRequest', []);

export const LIST_ROOTS_RESULT_ROOT = define('ListRootsResult.Root', [
	scalar('uri', 1, 'string'),
	scalar('name', 2, 'string'),
]);

export const LIST_ROOTS_RESULT = define('ListRootsResult', [
	message('roots', 1, () => LIST_ROOTS_RESULT_ROOT, { repeated: true }),
]);

export const SAMPLING_MESSAGE = define('SamplingMessage', [
	enumeration('role', 1, ROLE),
	message('text', 2, () => TEXT_CONTENT),
	message('image', 3, () => IMAGE_CONTENT),
	message('audio', 4, () => AUDIO_CONTENT),
]);

export const MODEL_HINT = define('SamplingCreateMessageRequest.ModelPreferences.ModelHint', [
	scalar('name', 1, 'string'),
]);

export const MODEL_PREFERENCES = define('SamplingCreateMessageRequest.ModelPreferences', [
	message('hints', 1, () => MODEL_HINT, { repeated: true }),
	scalar('intelligence_priority', 2, 'float', { presence: 'explicit' }),
	scalar('speed_priority', 3, 'float', { presence: 'explicit' }),
	scalar('cost_priority', 4, 'float', { presence: 'explicit' }),
]);

export const SAMPLING_CREATE_MESSAGE_REQUEST = define('SamplingCreateMessageRequest', [
	message('messages', 1, () => SAMPLING_MESSAGE, { repeated: true }),
	message('model_preferences', 2, () => MODEL_PREFERENCES),
	scalar('system_prompt', 3, 'string'),
	enumeration('include_context', 4, INCLUDE_CONTEXT),
	scalar('temperature', 5, 'float', { presence: 'explicit' }),
	scalar('max_tokens', 6, 'int32'),
	scalar('stop_sequence', 7, 'string', { repeated: true }),
]);

export const SAMPLING_CREATE_MESSAGE_RESULT = define('SamplingCreateMessageResult', [
	message('message', 1, () => SAMPLING_MESSAGE),
	scalar('model', 2, 'string'),
	scalar('stop_reason', 3, 'string'),
]);

export const STRING_SCHEMA = define('PrimitiveSchemaDefinition.StringSchema', [
	scalar('title', 1, 'string'),
	scalar('description', 2, 'string'),
	scalar('min_length', 3, 'uint64', { presence: 'explicit' }),
	scalar('max_length', 4, 'uint64', { presence: 'explicit' }),
	enumeration('format', 5, STRING_FORMAT),
	scalar('default_value', 6, 'string', { presence: 'explicit' }),
]);

export const DOUBLE_RANGE = define('PrimitiveSchemaDefinition.NumberSchema.DoubleRange', [
	scalar('minimum', 1, 'double', { presence: 'explicit' }),
	scalar('maximum', 2, 'double', { presence: 'explicit' }),
]);

export const INTEGER_RANGE = define('PrimitiveSchemaDefinition.NumberSchema.IntegerRange', [
	scalar('minimum', 1, 'int64', { presence: 'explicit' }),
	scalar('maximum', 2, 'int64', { presence: 'explicit' }),
]);

export const NUMBER_SCHEMA = define('PrimitiveSchemaDefinition.NumberSchema', [
	scalar('title', 1, 'string'),
	scalar('description', 2, 'string'),
	scalar('minimum', 3, 'uint64', { deprecated: true }),
	scalar('maximum', 4, 'uint64', { deprecated: true }),
	message('double_range', 5, () => DOUBLE_RANGE),
	message('integer_range', 6, () => INTEGER_RANGE),
	scalar('default_number', 7, 'double', { presence: 'explicit' }),
	scalar('default_integer', 8, 'int64', { presence: 'explicit' }),
]);

export const BOOLEAN_SCHEMA = define('PrimitiveSchemaDefinition.BooleanSchema', [
	scalar('title', 1, 'string'),
	scalar('description', 2, 'string'),
	scalar('default', 3, 'bool'),
]);

export const ENUM_MULTI_SELECT = define('PrimitiveSchemaDefinition.EnumSchema.MultiSelect', [
	scalar('default_items', 1, 'string', { repeated: true }),
	scalar('min_items', 2, 'uint32', { presence: 'explicit' }),
	scalar('max_items', 3, 'uint32', { presence: 'explicit' }),
]);

export const ENUM_SINGLE_SELECT = define('PrimitiveSchemaDefinition.EnumSchema.SingleSelect', [
	scalar('default_item', 1, 'string', { presence: 'explicit' }),
]);

export const ENUM_SCHEMA = define('PrimitiveSchemaDefinition.EnumSchema', [
	scalar('title', 1, 'string'),
	scalar('description', 2, 'string'),
	scalar('enum_list', 3, 'string', { repeated: true }),
	scalar('enum_names', 4, 'string', { repeated: true }),
	message('single_select', 5, () => ENUM_SINGLE_SELECT),
	message('multi_select', 6, () => ENUM_MULTI_SELECT),
]);

export const PRIMITIVE_SCHEMA_DEFINITION = define('PrimitiveSchemaDefinition', [
	message('string_schema', 1, () => STRING_SCHEMA),
	message('number_schema', 2, () => NUMBER_SCHEMA),
	message('boolean_schema', 3, () => BOOLEAN_SCHEMA),
	message('enum_schema', 4, () => ENUM_SCHEMA),
]);

export const ELICIT_URL_MODE = define('ElicitRequest.UrlMode', [
	scalar('id', 1, 'string'),
	scalar('url', 2, 'string'),
]);

export const ELICIT_REQUEST = define('ElicitRequest', [
	scalar('message', 1, 'string'),
	mapOf('requested_schema', 2, 'string', { kind: 'message', message: () => PRIMITIVE_SCHEMA_DEFINITION }),
	scalar('required_fields', 3, 'string', { repeated: true }),
	message('url_mode', 4, () => ELICIT_URL_MODE),
]);

export const ELICIT_RESULT = define('ElicitResult', [
	enumeration('type', 1, ELICIT_RESULT_TYPE),
	struct('content', 2),
]);

export const RESOURCE = define('Resource', [
	scalar('uri', 1, 'string'),
	scalar('name', 2, 'string'),
	scalar('description', 3, 'string'),
	scalar('mime_type', 4, 'string'),
	message('annotations', 5, () => ANNOTATIONS),
	scalar('size', 6, 'uint64'),
	scalar('title', 7, 'string'),
	message('icons', 8, () => ICON, { repeated: true }),
	struct('metadata', 9),
]);

export const LIST_RESOURCES_REQUEST = define('ListResourcesRequest', [
	message('common', 1, () => REQUEST_FIELDS),
]);

export const LIST_RESOURCES_RESPONSE = define('ListResourcesResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	message('resources', 2, () => RESOURCE, { repeated: true }),
	duration('ttl', 3),
	enumeration('cache_scope', 4, CACHE_SCOPE),
]);

export const RESOURCE_CONTENTS = define('ResourceContents', [
	scalar('uri', 1, 'string'),
	scalar('mime_type', 2, 'string'),
	scalar('text', 3, 'string'),
	scalar('blob', 4, 'bytes'),
	struct('metadata', 5),
]);

export const READ_RESOURCE_REQUEST = define('ReadResourceRequest', [
	message('common', 1, () => REQUEST_FIELDS),
	scalar('uri', 2, 'string'),
]);

export const READ_RESOURCE_RESPONSE = define('ReadResourceResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	message('resource', 2, () => RESOURCE_CONTENTS, { repeated: true }),
	duration('ttl', 3),
	enumeration('cache_scope', 4, CACHE_SCOPE),
]);

export const RESOURCE_TEMPLATE = define('ResourceTemplate', [
	scalar('uri_template', 1, 'string'),
	scalar('name', 2, 'string'),
	scalar('description', 3, 'string'),
	scalar('mime_type', 4, 'string'),
	message('annotations', 5, () => ANNOTATIONS),
	scalar('title', 6, 'string'),
	message('icons', 7, () => ICON, { repeated: true }),
	struct('metadata', 8),
]);

export const LIST_RESOURCE_TEMPLATES_REQUEST = define('ListResourceTemplatesRequest', [
	message('common', 1, () => REQUEST_FIELDS),
]);

export const LIST_RESOURCE_TEMPLATES_RESPONSE = define('ListResourceTemplatesResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	message('resource_templates', 2, () => RESOURCE_TEMPLATE, { repeated: true }),
	duration('ttl', 3),
	enumeration('cache_scope', 4, CACHE_SCOPE),
]);

export const PROMPT_ARGUMENT = define('Prompt.Argument', [
	scalar('name', 1, 'string'),
	scalar('description', 2, 'string'),
	scalar('required', 3, 'bool'),
	scalar('title', 4, 'string'),
]);

export const PROMPT = define('Prompt', [
	scalar('name', 1, 'string'),
	scalar('description', 2, 'string'),
	message('arguments', 3, () => PROMPT_ARGUMENT, { repeated: true }),
	scalar('title', 4, 'string'),
	message('icons', 5, () => ICON, { repeated: true }),
	struct('metadata', 6),
]);

export const LIST_PROMPTS_REQUEST = define('ListPromptsRequest', [
	message('common', 1, () => REQUEST_FIELDS),
]);

export const LIST_PROMPTS_RESPONSE = define('ListPromptsResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	message('prompts', 2, () => PROMPT, { repeated: true }),
	duration('ttl', 3),
	enumeration('cache_scope', 4, CACHE_SCOPE),
]);

export const EMBEDDED_RESOURCE = define('EmbeddedResource', [
	message('contents', 1, () => RESOURCE_CONTENTS),
	message('annotations', 2, () => ANNOTATIONS),
	struct('metadata', 3),
]);

export const PROMPT_MESSAGE = define('PromptMessage', [
	enumeration('role', 1, ROLE),
	message('text', 2, () => TEXT_CONTENT),
	message('image', 3, () => IMAGE_CONTENT),
	message('audio', 4, () => AUDIO_CONTENT),
	message('embedded_resource', 5, () => EMBEDDED_RESOURCE),
	message('resource_link', 6, () => RESOURCE),
]);

export const GET_PROMPT_REQUEST = define('GetPromptRequest', [
	message('common', 1, () => REQUEST_FIELDS),
	scalar('name', 2, 'string'),
	mapOf('arguments', 3, 'string', { kind: 'string' }),
]);

export const GET_PROMPT_RESPONSE = define('GetPromptResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	scalar('description', 2, 'string'),
	message('messages', 3, () => PROMPT_MESSAGE, { repeated: true }),
]);

export const TOOL_ANNOTATIONS = define('ToolAnnotations', [
	scalar('title', 1, 'string'),
	scalar('read_only_hint', 2, 'bool'),
	scalar('destructive_hint', 3, 'bool'),
	scalar('idempotent_hint', 4, 'bool'),
	scalar('open_world_hint', 5, 'bool'),
]);

export const TOOL = define('Tool', [
	scalar('name', 1, 'string'),
	scalar('description', 2, 'string'),
	struct('input_schema', 3),
	message('annotations', 4, () => TOOL_ANNOTATIONS),
	struct('output_schema', 5),
	scalar('title', 6, 'string'),
	message('icons', 7, () => ICON, { repeated: true }),
	struct('metadata', 8),
]);

export const LIST_TOOLS_REQUEST = define('ListToolsRequest', [
	message('common', 1, () => REQUEST_FIELDS),
]);

export const LIST_TOOLS_RESPONSE = define('ListToolsResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	message('tools', 2, () => TOOL, { repeated: true }),
	duration('ttl', 3),
	enumeration('cache_scope', 4, CACHE_SCOPE),
]);

export const CALL_TOOL_REQUEST_REQUEST = define('CallToolRequest.Request', [
	scalar('name', 1, 'string'),
	struct('arguments', 2),
]);

export const CALL_TOOL_REQUEST = define('CallToolRequest', [
	message('common', 1, () => REQUEST_FIELDS),
	message('request', 2, () => CALL_TOOL_REQUEST_REQUEST),
]);

export const CALL_TOOL_RESPONSE_CONTENT = define('CallToolResponse.Content', [
	message('text', 1, () => TEXT_CONTENT),
	message('image', 2, () => IMAGE_CONTENT),
	message('audio', 3, () => AUDIO_CONTENT),
	message('embedded_resource', 4, () => EMBEDDED_RESOURCE),
	message('resource_link', 7, () => RESOURCE),
]);

export const CALL_TOOL_RESPONSE = define('CallToolResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	message('content', 2, () => CALL_TOOL_RESPONSE_CONTENT, { repeated: true }),
	struct('structured_content', 3),
	scalar('is_error', 4, 'bool'),
]);

export const RESOURCE_REFERENCE = define('ResourceReference', [
	scalar('uri', 1, 'string'),
]);

export const PROMPT_REFERENCE = define('PromptReference', [
	scalar('name', 1, 'string'),
	scalar('title', 2, 'string'),
]);

export const COMPLETION_ARGUMENT = define('CompletionRequest.Argument', [
	scalar('name', 1, 'string'),
	scalar('value', 2, 'string'),
]);

export const COMPLETION_CONTEXT = define('CompletionRequest.Context', [
	mapOf('arguments', 1, 'string', { kind: 'string' }),
]);

export const COMPLETION_REQUEST = define('CompletionRequest', [
	message('common', 1, () => REQUEST_FIELDS),
	message('resource_reference', 2, () => RESOURCE_REFERENCE),
	message('prompt_reference', 3, () => PROMPT_REFERENCE),
	message('argument', 4, () => COMPLETION_ARGUMENT),
	message('context', 5, () => COMPLETION_CONTEXT),
]);

export const COMPLETION_RESPONSE = define('CompletionResponse', [
	message('common', 1, () => RESPONSE_FIELDS),
	scalar('values', 2, 'string', { repeated: true }),
	scalar('total_matches', 3, 'int64', { presence: 'explicit' }),
	scalar('has_more', 4, 'bool'),
]);

/**
 * Every message of `mcp_messages.proto`, keyed by its name relative to the
 * package (nested messages use dots, e.g. `Prompt.Argument`).
 */
export const MCP_MESSAGES: Readonly<Record<string, IMessageDescriptor>> = Object.freeze(registry);

//#endregion

//#region Service

export type TypedRpcName =
	| 'ListResources'
	| 'ReadResource'
	| 'ListResourceTemplates'
	| 'ListPrompts'
	| 'GetPrompt'
	| 'ListTools'
	| 'CallTool'
	| 'Complete';

export interface ITypedRpc {
	readonly name: TypedRpcName;
	/** The HTTP/2 path, `TYPED_PATH_PREFIX` followed by the name. */
	readonly path: string;
	/** The MCP method the RPC carries. */
	readonly jsonRpcMethod: string;
	readonly request: IMessageDescriptor;
	readonly response: IMessageDescriptor;
	/** The routing metadata the client adds, when the RPC has one. */
	readonly routingKey?: TypedRoutingKey;
}

function rpc(name: TypedRpcName, jsonRpcMethod: string, request: IMessageDescriptor, response: IMessageDescriptor, routingKey?: TypedRoutingKey): ITypedRpc {
	return Object.freeze({ name, path: TYPED_PATH_PREFIX + name, jsonRpcMethod, request, response, routingKey });
}

/** The eight unary RPCs of `model_context_protocol.Mcp`, in proto order. */
export const TYPED_RPCS: readonly ITypedRpc[] = Object.freeze([
	rpc('ListResources', 'resources/list', LIST_RESOURCES_REQUEST, LIST_RESOURCES_RESPONSE),
	rpc('ReadResource', 'resources/read', READ_RESOURCE_REQUEST, READ_RESOURCE_RESPONSE, 'mcp_resource'),
	rpc('ListResourceTemplates', 'resources/templates/list', LIST_RESOURCE_TEMPLATES_REQUEST, LIST_RESOURCE_TEMPLATES_RESPONSE),
	rpc('ListPrompts', 'prompts/list', LIST_PROMPTS_REQUEST, LIST_PROMPTS_RESPONSE),
	rpc('GetPrompt', 'prompts/get', GET_PROMPT_REQUEST, GET_PROMPT_RESPONSE, 'mcp_prompt'),
	rpc('ListTools', 'tools/list', LIST_TOOLS_REQUEST, LIST_TOOLS_RESPONSE),
	rpc('CallTool', 'tools/call', CALL_TOOL_REQUEST, CALL_TOOL_RESPONSE, 'mcp_tool'),
	rpc('Complete', 'completion/complete', COMPLETION_REQUEST, COMPLETION_RESPONSE, 'mcp_resource'),
]);

const rpcsByMethod = new Map(TYPED_RPCS.map(r => [r.jsonRpcMethod, r] as const));
const rpcsByPath = new Map(TYPED_RPCS.map(r => [r.path, r] as const));

/** The typed RPC that carries `jsonRpcMethod`, or `undefined` for a method without one (e.g. `server/discover`). */
export function typedRpcForMethod(jsonRpcMethod: string): ITypedRpc | undefined {
	return rpcsByMethod.get(jsonRpcMethod);
}

/** The typed RPC served at `path`, or `undefined` for any other path (including the tunnel's). */
export function typedRpcForPath(path: string): ITypedRpc | undefined {
	return rpcsByPath.get(path);
}

//#endregion
