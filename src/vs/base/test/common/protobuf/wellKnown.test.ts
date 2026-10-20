/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeMessage, encodeMessage, IMessageDescriptor, ProtoCodecError, ProtoCodecErrorReason } from '../../../common/protobuf/codec.js';
import { ANY, dateToTimestamp, DURATION, durationToMs, EMPTY, jsonToStruct, jsonToValue, LIST_VALUE, msToDuration, STRUCT, structToJson, TIMESTAMP, timestampToDate, VALUE, valueToJson } from '../../../common/protobuf/wellKnown.js';
import { decodeUtf8, encodeUtf8 } from '../../../common/protobuf/wire.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
}

function bytes(hexString: string): Uint8Array {
	const parts = hexString.trim().split(/\s+/).filter(p => p.length > 0);
	return Uint8Array.from(parts, p => parseInt(p, 16));
}

function assertCodecError(fn: () => unknown, reason: ProtoCodecErrorReason): void {
	assert.throws(fn, (err: unknown) => err instanceof ProtoCodecError && err.reason === reason, `expected ProtoCodecError '${reason}'`);
}

function roundTripStruct(json: Record<string, unknown>): Record<string, unknown> {
	return structToJson(decodeMessage(STRUCT, encodeMessage(STRUCT, jsonToStruct(json))));
}

suite('protobuf well-known types', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('Struct / Value', () => {

		test('Struct { a: null, b: 0, c: false, d: "", e: [1, "x", { f: true }] } round trips through encode/decode', () => {
			const json = { a: null, b: 0, c: false, d: '', e: [1, 'x', { f: true }] };
			assert.deepStrictEqual(roundTripStruct(json), json);
		});

		test('jsonToStruct produces the decoded-message shape', () => {
			assert.deepStrictEqual(jsonToStruct({ a: null, b: 0, c: false, d: '', e: [1, 'x', { f: true }] }), {
				fields: {
					a: { null_value: 0 },
					b: { number_value: 0 },
					c: { bool_value: false },
					d: { string_value: '' },
					e: {
						list_value: {
							values: [
								{ number_value: 1 },
								{ string_value: 'x' },
								{ struct_value: { fields: { f: { bool_value: true } } } },
							],
						},
					},
				},
			});
		});

		test('empty containers match what the codec decodes', () => {
			assert.deepStrictEqual(jsonToStruct({}), {});
			assert.deepStrictEqual(jsonToStruct({ skipped: undefined }), {});
			assert.deepStrictEqual(jsonToValue([]), { list_value: {} });
			assert.deepStrictEqual(jsonToValue({}), { struct_value: {} });
			assert.deepStrictEqual(decodeMessage(STRUCT, encodeMessage(STRUCT, jsonToStruct({}))), {});
			assert.deepStrictEqual(decodeMessage(VALUE, encodeMessage(VALUE, jsonToValue([]))), { list_value: {} });
			assert.deepStrictEqual(structToJson({}), {});
			assert.deepStrictEqual(valueToJson({ list_value: {} }), []);
			assert.deepStrictEqual(valueToJson({ struct_value: {} }), {});
			assert.deepStrictEqual(roundTripStruct({ empty: {}, list: [], nested: { deeper: [[]] } }), { empty: {}, list: [], nested: { deeper: [[]] } });
		});

		test('Struct { a: 1 } bytes', () => {
			const encoded = encodeMessage(STRUCT, jsonToStruct({ a: 1 }));
			assert.strictEqual(hex(encoded), '0a 0e 0a 01 61 12 09 11 00 00 00 00 00 00 f0 3f');
			assert.deepStrictEqual(structToJson(decodeMessage(STRUCT, bytes('0a 0e 0a 01 61 12 09 11 00 00 00 00 00 00 f0 3f'))), { a: 1 });
		});

		test('undefined inside arrays becomes null, like JSON.stringify', () => {
			assert.deepStrictEqual(jsonToValue([undefined, 1]), { list_value: { values: [{ null_value: 0 }, { number_value: 1 }] } });
		});

		test('numbers: 0.3 stays 0.3 and 1e3 => 1000', () => {
			assert.deepStrictEqual(jsonToValue(0.3), { number_value: 0.3 });
			assert.strictEqual(valueToJson(jsonToValue(0.3)), 0.3);
			assert.strictEqual(valueToJson(jsonToValue(1e3)), 1000);
			assert.strictEqual(valueToJson({ number_value: 1e3 }), 1000);
			assert.strictEqual(valueToJson({ number_value: -0 }), 0);
			assert.ok(Object.is(valueToJson({ number_value: -0 }), 0));
			assert.strictEqual(valueToJson(jsonToValue(-1.25)), -1.25);
			assert.strictEqual(valueToJson(jsonToValue(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
			assert.strictEqual(valueToJson(jsonToValue(-Number.MAX_SAFE_INTEGER)), -Number.MAX_SAFE_INTEGER);
		});

		test('integers beyond ±2^53 throw invalid-value', () => {
			assertCodecError(() => jsonToValue(2 ** 53 + 1), 'invalid-value');
			assertCodecError(() => jsonToValue(2 ** 53), 'invalid-value');
			assertCodecError(() => jsonToValue(-(2 ** 53)), 'invalid-value');
			assertCodecError(() => jsonToStruct({ big: 1e20 }), 'invalid-value');
		});

		test('NaN and infinities are rejected in both directions', () => {
			assertCodecError(() => jsonToValue(NaN), 'invalid-value');
			assertCodecError(() => jsonToValue(Infinity), 'invalid-value');
			assertCodecError(() => valueToJson({ number_value: NaN }), 'invalid-value');
			assertCodecError(() => valueToJson({ number_value: Infinity }), 'invalid-value');
			assertCodecError(() => valueToJson({ number_value: -Infinity }), 'invalid-value');
		});

		test('non-JSON inputs are rejected', () => {
			assertCodecError(() => jsonToValue(undefined), 'invalid-value');
			assertCodecError(() => jsonToValue(1n), 'invalid-value');
			assertCodecError(() => jsonToValue(() => 1), 'invalid-value');
			assertCodecError(() => jsonToValue(Symbol('s')), 'invalid-value');
		});

		test('malformed Value messages are rejected', () => {
			assertCodecError(() => valueToJson({ number_value: '1' }), 'invalid-value');
			assertCodecError(() => valueToJson({ string_value: 1 }), 'invalid-value');
			assertCodecError(() => valueToJson({ bool_value: 'true' }), 'invalid-value');
			assertCodecError(() => valueToJson({ struct_value: 'x' }), 'invalid-value');
			assertCodecError(() => valueToJson({ list_value: [] }), 'invalid-value');
			assertCodecError(() => valueToJson({ list_value: { values: {} } }), 'invalid-value');
			assertCodecError(() => valueToJson({ list_value: { values: [1] } }), 'invalid-value');
			assertCodecError(() => structToJson({ fields: [] }), 'invalid-value');
			assertCodecError(() => structToJson({ fields: { a: 1 } }), 'invalid-value');
		});

		test('a Value with no kind set reads as null', () => {
			assert.strictEqual(valueToJson({}), null);
			assert.deepStrictEqual(structToJson(decodeMessage(STRUCT, bytes('0a 03 0a 01 61'))), { a: null });
		});

		test('nested and unusual keys round trip', () => {
			// A computed key creates an own `__proto__` property; a plain one would set the prototype.
			const json = {
				'': 'empty key',
				['__proto__']: { polluted: true },
				'unicode ✓': ['é', { 'nested key': null }],
				deep: { a: { b: { c: { d: [[[0.5]]] } } } },
			};
			assert.deepStrictEqual(Object.keys(json).sort(), ['', '__proto__', 'deep', 'unicode ✓']);
			const result = roundTripStruct(json);
			assert.deepStrictEqual(Object.keys(result).sort(), ['', '__proto__', 'deep', 'unicode ✓']);
			assert.deepStrictEqual(Object.getOwnPropertyDescriptor(result, '__proto__')?.value, { polluted: true });
			assert.strictEqual(Object.getPrototypeOf(result), Object.prototype);
			assert.deepStrictEqual(result.deep, json.deep);
			assert.deepStrictEqual(result['unicode ✓'], json['unicode ✓']);
		});

		test('descriptors reference each other lazily', () => {
			assert.strictEqual(STRUCT.fields[0].map?.value.message?.(), VALUE);
			assert.strictEqual(VALUE.fields.find(f => f.name === 'struct_value')?.message?.(), STRUCT);
			assert.strictEqual(VALUE.fields.find(f => f.name === 'list_value')?.message?.(), LIST_VALUE);
			assert.strictEqual(LIST_VALUE.fields[0].message?.(), VALUE);
			assert.ok(VALUE.fields.every(f => f.oneof === 'kind'));
			assert.deepStrictEqual(VALUE.fields.map(f => [f.name, f.number]), [['null_value', 1], ['number_value', 2], ['string_value', 3], ['bool_value', 4], ['struct_value', 5], ['list_value', 6]]);
		});
	});

	suite('Duration', () => {

		test('1500 ms => { 1n, 500000000 }, -1500 ms => { -1n, -500000000 }', () => {
			assert.deepStrictEqual(msToDuration(1500), { seconds: 1n, nanos: 500000000 });
			assert.deepStrictEqual(msToDuration(-1500), { seconds: -1n, nanos: -500000000 });
			assert.deepStrictEqual(msToDuration(0), { seconds: 0n, nanos: 0 });
			assert.deepStrictEqual(msToDuration(0.5), { seconds: 0n, nanos: 500000 });
			assert.deepStrictEqual(msToDuration(-0.5), { seconds: 0n, nanos: -500000 });
			assert.deepStrictEqual(msToDuration(60_000), { seconds: 60n, nanos: 0 });
			assert.deepStrictEqual(msToDuration(-0), { seconds: 0n, nanos: 0 });
		});

		test('sub-nanosecond rounding carries into seconds', () => {
			assert.deepStrictEqual(msToDuration(999.9999999999), { seconds: 1n, nanos: 0 });
			assert.deepStrictEqual(msToDuration(-999.9999999999), { seconds: -1n, nanos: 0 });
		});

		test('durationToMs', () => {
			assert.strictEqual(durationToMs({ seconds: 1n, nanos: 500000000 }), 1500);
			assert.strictEqual(durationToMs({ seconds: -1n, nanos: -500000000 }), -1500);
			assert.strictEqual(durationToMs({ seconds: 2 }), 2000);
			assert.strictEqual(durationToMs({ nanos: 1500000 }), 1.5);
			assert.strictEqual(durationToMs({}), 0);
			assert.strictEqual(durationToMs({ seconds: -1n }), -1000);
		});

		test('mixed signs are rejected', () => {
			assertCodecError(() => durationToMs({ seconds: 1n, nanos: -1 }), 'invalid-value');
			assertCodecError(() => durationToMs({ seconds: -1, nanos: 1 }), 'invalid-value');
		});

		test('nanos outside ±999,999,999 and non-integers are rejected', () => {
			assertCodecError(() => durationToMs({ seconds: 0n, nanos: 1_000_000_000 }), 'invalid-value');
			assertCodecError(() => durationToMs({ seconds: 0n, nanos: -1_000_000_000 }), 'invalid-value');
			assertCodecError(() => durationToMs({ seconds: 0n, nanos: 0.5 }), 'invalid-value');
			assertCodecError(() => durationToMs({ seconds: 1.5 }), 'invalid-value');
			assertCodecError(() => msToDuration(NaN), 'invalid-value');
			assertCodecError(() => msToDuration(Infinity), 'invalid-value');
		});

		test('round trips through the DURATION descriptor', () => {
			const encoded = encodeMessage(DURATION, msToDuration(1500));
			assert.strictEqual(hex(encoded), '08 01 10 80 ca b5 ee 01');
			assert.strictEqual(durationToMs(decodeMessage(DURATION, encoded)), 1500);
			assert.strictEqual(durationToMs(decodeMessage(DURATION, encodeMessage(DURATION, msToDuration(-1500)))), -1500);
			assert.strictEqual(durationToMs(decodeMessage(DURATION, encodeMessage(DURATION, msToDuration(0)))), 0);
			assert.strictEqual(hex(encodeMessage(DURATION, msToDuration(0))), '', 'a zero duration has no fields on the wire');
		});
	});

	suite('Timestamp', () => {

		test('Date round trip', () => {
			const date = new Date('2024-01-02T03:04:05.678Z');
			const ts = dateToTimestamp(date);
			assert.deepStrictEqual(ts, { seconds: 1704164645n, nanos: 678000000 });
			assert.strictEqual(timestampToDate(ts).getTime(), date.getTime());
			assert.deepStrictEqual(dateToTimestamp(new Date(0)), { seconds: 0n, nanos: 0 });
		});

		test('dates before the epoch keep nanos non-negative', () => {
			assert.deepStrictEqual(dateToTimestamp(new Date(-1500)), { seconds: -2n, nanos: 500000000 });
			assert.strictEqual(timestampToDate({ seconds: -2n, nanos: 500000000 }).getTime(), -1500);
		});

		test('nanos are truncated to milliseconds', () => {
			assert.strictEqual(timestampToDate({ seconds: 1n, nanos: 123456789 }).getTime(), 1123);
			assert.strictEqual(timestampToDate({ seconds: 1, nanos: 999999 }).getTime(), 1000);
			assert.strictEqual(timestampToDate({ seconds: 1n }).getTime(), 1000);
			assert.strictEqual(timestampToDate({}).getTime(), 0);
		});

		test('invalid values are rejected', () => {
			assertCodecError(() => dateToTimestamp(new Date(NaN)), 'invalid-value');
			assertCodecError(() => timestampToDate({ seconds: 0n, nanos: -1 }), 'invalid-value');
			assertCodecError(() => timestampToDate({ seconds: 0n, nanos: 1_000_000_000 }), 'invalid-value');
			assertCodecError(() => timestampToDate({ seconds: 0.5 }), 'invalid-value');
		});

		test('round trips through the TIMESTAMP descriptor', () => {
			const date = new Date('2001-09-09T01:46:40.123Z');
			const decoded = decodeMessage<{ seconds?: bigint; nanos?: number }>(TIMESTAMP, encodeMessage(TIMESTAMP, dateToTimestamp(date)));
			assert.deepStrictEqual(decoded, { seconds: 1000000000n, nanos: 123000000 });
			assert.strictEqual(timestampToDate(decoded).getTime(), date.getTime());
		});
	});

	suite('Any / Empty', () => {

		test('Any round trip', () => {
			const value = { type_url: 'type.googleapis.com/google.protobuf.Duration', value: encodeMessage(DURATION, msToDuration(1500)) };
			const decoded = decodeMessage<typeof value>(ANY, encodeMessage(ANY, value));
			assert.deepStrictEqual(decoded, value);
			assert.strictEqual(durationToMs(decodeMessage(DURATION, decoded.value)), 1500);
		});

		test('Empty encodes to zero bytes and decodes to an empty object', () => {
			assert.strictEqual(hex(encodeMessage(EMPTY, {})), '');
			assert.deepStrictEqual(decodeMessage(EMPTY, new Uint8Array(0)), {});
		});
	});

	suite('MCP-shaped messages', () => {

		// A slice of mcp_messages.proto covering the constructs it uses: nested
		// messages, repeated messages and enums, map<string, message>, proto3
		// optional, Struct, Duration and bytes.

		const ANNOTATIONS: IMessageDescriptor = {
			name: 'Annotations',
			fields: [
				{ name: 'audience', number: 1, kind: 'enum', repeated: true, enum: { ROLE_UNKNOWN: 0, ROLE_USER: 1, ROLE_ASSISTANT: 2 } },
				{ name: 'priority', number: 2, kind: 'float', presence: 'explicit' },
				{ name: 'last_modified', number: 3, kind: 'string', presence: 'explicit' },
			],
		};

		const ICON: IMessageDescriptor = {
			name: 'Icon',
			fields: [
				{ name: 'src', number: 1, kind: 'string' },
				{ name: 'mime_type', number: 2, kind: 'string' },
				{ name: 'sizes', number: 3, kind: 'string', repeated: true },
				{ name: 'theme', number: 4, kind: 'enum', enum: { THEME_UNSPECIFIED: 0, THEME_LIGHT: 1, THEME_DARK: 2 } },
			],
		};

		const TOOL_ANNOTATIONS: IMessageDescriptor = {
			name: 'ToolAnnotations',
			fields: [
				{ name: 'title', number: 1, kind: 'string' },
				{ name: 'read_only_hint', number: 2, kind: 'bool' },
				{ name: 'destructive_hint', number: 3, kind: 'bool' },
				{ name: 'idempotent_hint', number: 4, kind: 'bool' },
				{ name: 'open_world_hint', number: 5, kind: 'bool' },
			],
		};

		const TOOL: IMessageDescriptor = {
			name: 'Tool',
			fields: [
				{ name: 'name', number: 1, kind: 'string' },
				{ name: 'title', number: 6, kind: 'string' },
				{ name: 'description', number: 2, kind: 'string' },
				{ name: 'input_schema', number: 3, kind: 'message', message: () => STRUCT },
				{ name: 'output_schema', number: 5, kind: 'message', message: () => STRUCT },
				{ name: 'annotations', number: 4, kind: 'message', message: () => TOOL_ANNOTATIONS },
				{ name: 'icons', number: 7, kind: 'message', repeated: true, message: () => ICON },
				{ name: 'metadata', number: 8, kind: 'message', message: () => STRUCT },
			],
		};

		const INPUT_REQUEST: IMessageDescriptor = {
			name: 'InputRequest',
			fields: [
				{ name: 'elicit_request', number: 11, kind: 'message', message: () => ELICIT_REQUEST },
			],
		};

		const ELICIT_REQUEST: IMessageDescriptor = {
			name: 'ElicitRequest',
			fields: [
				{ name: 'message', number: 1, kind: 'string' },
				{ name: 'required_fields', number: 3, kind: 'string', repeated: true },
			],
		};

		const RESPONSE_FIELDS: IMessageDescriptor = {
			name: 'ResponseFields',
			fields: [
				{ name: 'instructions', number: 1, kind: 'string' },
				{ name: 'metadata', number: 2, kind: 'message', message: () => STRUCT },
				{ name: 'input_requests', number: 7, kind: 'message', map: { key: 'string', value: { name: 'value', number: 2, kind: 'message', message: () => INPUT_REQUEST } } },
				{ name: 'result_type', number: 9, kind: 'enum', enum: { RESULT_TYPE_UNSPECIFIED: 0, RESULT_TYPE_COMPLETE: 1, RESULT_TYPE_INPUT_REQUIRED: 2 } },
				{ name: 'request_state', number: 10, kind: 'string', presence: 'explicit' },
			],
		};

		const LIST_TOOLS_RESPONSE: IMessageDescriptor = {
			name: 'ListToolsResponse',
			fields: [
				{ name: 'common', number: 1, kind: 'message', message: () => RESPONSE_FIELDS },
				{ name: 'tools', number: 2, kind: 'message', repeated: true, message: () => TOOL },
				{ name: 'ttl', number: 3, kind: 'message', message: () => DURATION },
				{ name: 'cache_scope', number: 4, kind: 'enum', enum: { CACHE_SCOPE_UNSPECIFIED: 0, CACHE_SCOPE_PUBLIC: 1, CACHE_SCOPE_PRIVATE: 2 } },
			],
		};

		const TEXT_CONTENT: IMessageDescriptor = {
			name: 'TextContent',
			fields: [
				{ name: 'text', number: 1, kind: 'string' },
				{ name: 'annotations', number: 2, kind: 'message', message: () => ANNOTATIONS },
				{ name: 'metadata', number: 3, kind: 'message', message: () => STRUCT },
			],
		};

		const IMAGE_CONTENT: IMessageDescriptor = {
			name: 'ImageContent',
			fields: [
				{ name: 'data', number: 1, kind: 'bytes' },
				{ name: 'mime_type', number: 2, kind: 'string' },
				{ name: 'annotations', number: 3, kind: 'message', message: () => ANNOTATIONS },
			],
		};

		const CALL_TOOL_RESPONSE: IMessageDescriptor = {
			name: 'CallToolResponse',
			fields: [
				{ name: 'common', number: 1, kind: 'message', message: () => RESPONSE_FIELDS },
				{
					name: 'content', number: 2, kind: 'message', repeated: true, message: () => ({
						name: 'CallToolResponse.Content',
						fields: [
							{ name: 'text', number: 1, kind: 'message', message: () => TEXT_CONTENT },
							{ name: 'image', number: 2, kind: 'message', message: () => IMAGE_CONTENT },
						],
					}),
				},
				{ name: 'structured_content', number: 3, kind: 'message', message: () => STRUCT },
				{ name: 'is_error', number: 4, kind: 'bool' },
			],
		};

		const JSON_RPC_MESSAGE: IMessageDescriptor = {
			name: 'JsonRpcMessage',
			fields: [
				{ name: 'jsonrpc', number: 1, kind: 'bytes' },
			],
		};

		test('ListToolsResponse round trip', () => {
			const inputSchema = {
				type: 'object',
				properties: { path: { type: 'string', description: 'File path' }, recursive: { type: 'boolean', default: false } },
				required: ['path'],
				additionalProperties: false,
			};
			const value = {
				common: {
					instructions: 'Be nice.',
					metadata: jsonToStruct({ server: 'test', version: 1.5 }),
					input_requests: {
						'elicit-1': { elicit_request: { message: 'Need more', required_fields: ['a', 'b'] } },
						'elicit-2': { elicit_request: {} },
					},
					result_type: 2,
					request_state: '',
				},
				tools: [
					{
						name: 'read_file',
						title: 'Read a file',
						input_schema: jsonToStruct(inputSchema),
						annotations: { read_only_hint: true, idempotent_hint: true },
						icons: [{ src: 'icon.png', sizes: ['48x48', 'any'], theme: 2 }, { src: 'icon-light.svg', mime_type: 'image/svg+xml' }],
					},
					{ name: 'noop', input_schema: {} },
				],
				ttl: msToDuration(30_500),
				cache_scope: 1,
			};
			const decoded = decodeMessage<typeof value>(LIST_TOOLS_RESPONSE, encodeMessage(LIST_TOOLS_RESPONSE, value));
			assert.deepStrictEqual(decoded, value);
			assert.deepStrictEqual(structToJson(decoded.tools[0].input_schema), inputSchema);
			assert.strictEqual(durationToMs(decoded.ttl), 30_500);
		});

		test('CallToolResponse with text, image and structured content', () => {
			const value = {
				content: [
					{ text: { text: 'hello', annotations: { audience: [1, 2], priority: 0.5 } } },
					{ image: { data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mime_type: 'image/png', annotations: { priority: 0, last_modified: '' } } },
				],
				structured_content: jsonToStruct({ ok: true, items: [1, 2, 3], nothing: null }),
				is_error: false,
			};
			const encoded = encodeMessage(CALL_TOOL_RESPONSE, value);
			const decoded = decodeMessage<typeof value>(CALL_TOOL_RESPONSE, encoded);
			// is_error has implicit presence, so false is not on the wire; everything else round trips.
			assert.deepStrictEqual(decoded, { content: value.content, structured_content: value.structured_content });
			assert.deepStrictEqual(structToJson(decoded.structured_content), { ok: true, items: [1, 2, 3], nothing: null });
			assert.deepStrictEqual(decoded.content[1].image?.annotations, { priority: 0, last_modified: '' }, 'proto3 optional fields keep default values');
		});

		test('JsonRpcMessage { bytes jsonrpc = 1; reserved 2 to 15; } round trip', () => {
			const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
			const encoded = encodeMessage(JSON_RPC_MESSAGE, { jsonrpc: encodeUtf8(payload) });
			assert.strictEqual(hex(encoded.subarray(0, 2)), `0a ${payload.length.toString(16)}`);
			const decoded = decodeMessage<{ jsonrpc: Uint8Array }>(JSON_RPC_MESSAGE, encoded);
			assert.strictEqual(decodeUtf8(decoded.jsonrpc), payload);
		});
	});
});
