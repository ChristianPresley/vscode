/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-checks VS Code's hand-written descriptors and codec against
 * protobufjs on the vendored proto files: for a set of fixture messages the
 * bytes both encoders produce are equal, and what each decoder reads from
 * the other's bytes is equal after canonicalization.
 *
 * Run `npm run transpile-client` in the repository root first: the codec is
 * imported from `out/`.
 */

import assert from 'node:assert';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as protobuf from 'protobufjs';
import { decodeMessage, encodeMessage } from '../../../out/vs/base/common/protobuf/codec.js';
import { DURATION, STRUCT, jsonToStruct } from '../../../out/vs/base/common/protobuf/wellKnown.js';
import { JSON_RPC_MESSAGE, MCP_MESSAGES } from '../../../out/vs/platform/mcp/common/mcpGrpcProto.js';
import type { IMessageDescriptor } from '../../../src/vs/base/common/protobuf/codec.ts';
import { FIXTURE_PROTO_DIR } from './fixtureServer.ts';

type JsonObject = Record<string, unknown>;

const root = new protobuf.Root();
root.loadSync([path.join(FIXTURE_PROTO_DIR, 'mcp.proto'), path.join(FIXTURE_PROTO_DIR, 'mcp_zig_transport_v1.proto')], { keepCase: true });
root.resolveAll();

//#region Canonical form

const snakeCase = (key: string) => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/** A 64-bit integer as a Number when it is safe, else a BigInt. */
function canonicalInteger(value: bigint): number | bigint {
	return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/**
 * The shape both decoders agree on: snake_case keys (protobufjs defines the
 * well-known types with camelCase names), Long and BigInt as Number/BigInt,
 * bytes as hex, unset fields dropped.
 */
export function toCanonical(value: unknown): unknown {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (typeof value === 'bigint') {
		return canonicalInteger(value);
	}
	if (protobuf.util.Long.isLong(value)) {
		return canonicalInteger(BigInt((value as protobuf.Long).toString()));
	}
	if (value instanceof Uint8Array) {
		return `bytes:${Buffer.from(value).toString('hex')}`;
	}
	if (Array.isArray(value)) {
		return value.map(toCanonical);
	}
	if (typeof value === 'object') {
		const out: JsonObject = {};
		for (const [key, entry] of Object.entries(value as JsonObject)) {
			const canonical = toCanonical(entry);
			if (canonical !== undefined) {
				out[snakeCase(key)] = canonical;
			}
		}
		return out;
	}
	return value;
}

/** Renames the well-known-type keys of a codec-shaped object to the camelCase names protobufjs expects. */
const WKT_KEYS: Record<string, string> = { null_value: 'nullValue', number_value: 'numberValue', string_value: 'stringValue', bool_value: 'boolValue', struct_value: 'structValue', list_value: 'listValue', type_url: 'typeUrl' };

function toProtobufjsObject(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(toProtobufjsObject);
	}
	if (typeof value === 'bigint') {
		// protobufjs reads 64-bit integers from strings; Long.fromValue does not take a BigInt.
		return value.toString();
	}
	if (value instanceof Uint8Array || typeof value !== 'object' || value === null) {
		return value;
	}
	const out: JsonObject = {};
	for (const [key, entry] of Object.entries(value as JsonObject)) {
		out[WKT_KEYS[key] ?? key] = toProtobufjsObject(entry);
	}
	return out;
}

//#endregion

//#region Fixtures

interface IFixture {
	readonly name: string;
	readonly descriptor: IMessageDescriptor;
	readonly object: JsonObject;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const struct = (json: JsonObject) => jsonToStruct(json);

const fixtures: IFixture[] = [
	{
		name: 'a Struct with null, zero, false and the empty string',
		descriptor: MCP_MESSAGES.CallToolRequest,
		object: {
			common: { metadata: struct({ a: null, b: 0, c: false, d: '' }) },
			request: { name: 'test-tool', arguments: struct({ a: null, b: 0, c: false, d: '', nested: { list: [1, 'two', [], {}] } }) },
		},
	},
	{
		name: 'a tools list with icons, schemas, hints, ttl and cache scope',
		descriptor: MCP_MESSAGES.ListToolsResponse,
		object: {
			common: { result_type: 1, metadata: struct({ 'io.modelcontextprotocol/serverInfo': { name: 's', version: '1' } }) },
			tools: [{
				name: 'add', title: 'Add', description: 'Adds',
				input_schema: struct({ type: 'object', properties: { a: { type: 'integer', minimum: 0 } }, required: ['a'], additionalProperties: false }),
				output_schema: struct({ type: 'object' }),
				annotations: { title: 'T', read_only_hint: true, destructive_hint: true, open_world_hint: true },
				icons: [{ src: 'https://x.example/i.png', mime_type: 'image/png', sizes: ['48x48', 'any'], theme: 2 }],
				metadata: struct({ k: 'v' }),
			}],
			ttl: { seconds: 1n, nanos: 500000000 },
			cache_scope: 1,
		},
	},
	{
		name: 'a tool result with every content block',
		descriptor: MCP_MESSAGES.CallToolResponse,
		object: {
			common: { result_type: 1 },
			content: [
				{ text: { text: 'hi', annotations: { audience: [1, 2], priority: 0.5, last_modified: '2026-01-01T00:00:00Z' }, metadata: struct({ x: 1 }) } },
				{ image: { data: utf8('iVBORw0KGgo='), mime_type: 'image/png' } },
				{ audio: { data: utf8('UklGRg=='), mime_type: 'audio/wav' } },
				{ embedded_resource: { contents: { uri: 'test://b', mime_type: 'application/octet-stream', blob: utf8('AAEC') } } },
				{ resource_link: { uri: 'test://l', name: 'l', size: 42n } },
			],
			structured_content: struct({ sum: 42, items: [1.5, 'x', null, true] }),
			is_error: true,
		},
	},
	{
		name: 'an input required result with every elicitation schema',
		descriptor: MCP_MESSAGES.ReadResourceResponse,
		object: {
			common: {
				result_type: 2,
				request_state: 'opaque',
				input_requests: {
					form: {
						elicit_request: {
							message: 'Who?',
							requested_schema: {
								name: { string_schema: { title: 'Name', min_length: 1n, max_length: 40n, format: 1, default_value: 'a@b.example' } },
								age: { number_schema: { integer_range: { minimum: -5n, maximum: 150n }, default_integer: 30n } },
								ratio: { number_schema: { double_range: { minimum: 0.5 }, default_number: 1.5 } },
								ok: { boolean_schema: { default: true } },
								tags: { enum_schema: { enum_list: ['x', 'y'], enum_names: ['X', 'Y'], multi_select: { default_items: ['x'], min_items: 1, max_items: 2 } } },
								color: { enum_schema: { enum_list: ['red'], single_select: { default_item: 'red' } } },
							},
							required_fields: ['name'],
						},
					},
					link: { elicit_request: { message: 'Sign in', url_mode: { id: 'link', url: 'https://x.example/auth' } } },
					sample: {
						sampling_create_message: {
							messages: [{ role: 1, text: { text: 'Hi' } }],
							model_preferences: { hints: [{ name: 'claude' }], cost_priority: 0.25, speed_priority: 0.5, intelligence_priority: 1 },
							system_prompt: 'Be brief',
							include_context: 1,
							// Exactly representable as a 32-bit float, so the fixture equals its decoding.
							temperature: 0.75,
							max_tokens: 100,
							stop_sequence: ['END'],
						},
					},
					roots: { list_roots_request: {} },
				},
			},
		},
	},
	{
		name: 'request fields with every input response and an empty optional string',
		descriptor: MCP_MESSAGES.GetPromptRequest,
		object: {
			common: {
				request_state: '',
				input_responses: {
					e: { elicit_result: { type: 1, content: struct({ name: 'Bob', n: 3 }) } },
					s: { sampling_create_message_result: { message: { role: 2, text: { text: 'Paris' } }, model: 'm1', stop_reason: 'endTurn' } },
					r: { root_list_result: { roots: [{ uri: 'file:///a', name: 'A' }, { uri: 'file:///b' }] } },
				},
			},
			name: 'p',
			arguments: { arg1: 'x', arg2: '' },
		},
	},
	{
		name: 'a completion with a zero optional int64 and a negative int32',
		descriptor: MCP_MESSAGES.CompletionResponse,
		object: { common: { result_type: 1 }, values: ['a', 'b'], total_matches: 0n, has_more: true },
	},
	{
		name: 'a sampling request with a negative max_tokens',
		descriptor: MCP_MESSAGES.SamplingCreateMessageRequest,
		object: { max_tokens: -1 },
	},
	{
		name: 'a completion request with both references and a context map',
		descriptor: MCP_MESSAGES.CompletionRequest,
		object: { resource_reference: { uri: 'test://t/{id}' }, prompt_reference: { name: 'p', title: 'P' }, argument: { name: 'id', value: '1' }, context: { arguments: { b: 'y' } } },
	},
	{
		name: 'a tunnel message',
		descriptor: JSON_RPC_MESSAGE,
		object: { jsonrpc: utf8(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} })) },
	},
	{
		name: 'the well-known Struct and Duration descriptors',
		descriptor: MCP_MESSAGES.ListPromptsResponse,
		object: { common: { metadata: struct({}) }, ttl: { seconds: -1n, nanos: -500000000 } },
	},
];

//#endregion

const WELL_KNOWN: Record<string, IMessageDescriptor> = { 'google.protobuf.Struct': STRUCT, 'google.protobuf.Duration': DURATION };

test('the vendored proto files load with protobufjs', () => {
	assert.ok(root.lookupType('model_context_protocol.CallToolRequest'));
	assert.ok(root.lookupType('mcp.zig.transport.v1.JsonRpcMessage'));
	assert.ok(root.lookupService('model_context_protocol.Mcp').methodsArray.length === 8);
	for (const name of Object.keys(WELL_KNOWN)) {
		assert.ok(root.lookupType(name), `${name} is available`);
	}
});

for (const fixture of fixtures) {
	test(`${fixture.name} round-trips byte-equal with protobufjs (${fixture.descriptor.name})`, () => {
		const Type = root.lookupType(fixture.descriptor.name);
		const theirMessage = Type.fromObject(toProtobufjsObject(fixture.object) as JsonObject);
		const theirBytes = Buffer.from(Type.encode(theirMessage).finish());
		const ourBytes = Buffer.from(encodeMessage(fixture.descriptor, fixture.object));
		assert.strictEqual(ourBytes.toString('hex'), theirBytes.toString('hex'), 'the encoders produce the same bytes');

		const theirObject = Type.toObject(Type.decode(ourBytes), { defaults: false });
		const ourObject = decodeMessage(fixture.descriptor, theirBytes);
		assert.deepStrictEqual(toCanonical(ourObject), toCanonical(theirObject), 'the decoders read the same message');
		assert.deepStrictEqual(toCanonical(ourObject), toCanonical(fixture.object), 'the message survives the round trip');
	});
}

test('every descriptor names a type protobufjs knows, with the same fields', () => {
	for (const [key, descriptor] of Object.entries(MCP_MESSAGES)) {
		const Type = root.lookupType(descriptor.name);
		assert.strictEqual(Type.fullName, `.${descriptor.name}`, key);
		const theirs = Type.fieldsArray.map(field => [field.name, field.id, field.repeated || field.map ? 'repeated' : field.optional && field.partOf !== null ? 'optional' : '', field.map ? 'map' : ''].join(':')).sort();
		const ours = descriptor.fields.map(field => [field.name, field.number, field.repeated || field.map ? 'repeated' : field.presence === 'explicit' ? 'optional' : '', field.map ? 'map' : ''].join(':')).sort();
		assert.deepStrictEqual(ours, theirs, `fields of ${key}`);
	}
});
