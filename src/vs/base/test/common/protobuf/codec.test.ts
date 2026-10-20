/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DEFAULT_CODEC_LIMITS, decodeMessage, encodeMessage, IFieldDescriptor, IMessageDescriptor, ProtoCodecError, ProtoCodecErrorReason, ProtoMessage, ScalarKind, UNKNOWN_FIELDS } from '../../../common/protobuf/codec.js';
import { VALUE } from '../../../common/protobuf/wellKnown.js';
import { ProtoDecodeError, ProtoWriter, WireType } from '../../../common/protobuf/wire.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
}

function bytes(hexString: string): Uint8Array {
	const parts = hexString.trim().split(/\s+/).filter(p => p.length > 0);
	return Uint8Array.from(parts, p => parseInt(p, 16));
}

function concat(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function assertCodecError(fn: () => unknown, reason: ProtoCodecErrorReason): void {
	assert.throws(fn, (err: unknown) => err instanceof ProtoCodecError && err.reason === reason, `expected ProtoCodecError '${reason}'`);
}

const SCALAR_FIELDS: readonly IFieldDescriptor[] = [
	{ name: 'i32', number: 1, kind: 'int32' },
	{ name: 'i64', number: 2, kind: 'int64' },
	{ name: 'u32', number: 3, kind: 'uint32' },
	{ name: 'u64', number: 4, kind: 'uint64' },
	{ name: 's32', number: 5, kind: 'sint32' },
	{ name: 's64', number: 6, kind: 'sint64' },
	{ name: 'b', number: 7, kind: 'bool' },
	{ name: 'e', number: 8, kind: 'enum', enum: { ZERO: 0, ONE: 1, TWO: 2 } },
	{ name: 'f', number: 9, kind: 'float' },
	{ name: 'd', number: 10, kind: 'double' },
	{ name: 'f32', number: 11, kind: 'fixed32' },
	{ name: 'f64', number: 12, kind: 'fixed64' },
	{ name: 'sf32', number: 13, kind: 'sfixed32' },
	{ name: 'sf64', number: 14, kind: 'sfixed64' },
	{ name: 'str', number: 15, kind: 'string' },
	{ name: 'buf', number: 16, kind: 'bytes' },
];

const SCALARS: IMessageDescriptor = { name: 'Scalars', fields: SCALAR_FIELDS };

const REPEATED_SCALARS: IMessageDescriptor = {
	name: 'RepeatedScalars',
	fields: SCALAR_FIELDS.map(field => ({ ...field, repeated: true })),
};

const INNER: IMessageDescriptor = {
	name: 'Inner',
	fields: [
		{ name: 'a', number: 1, kind: 'int32' },
		{ name: 'b', number: 2, kind: 'string' },
		{ name: 'r', number: 3, kind: 'int32', repeated: true },
	],
};

const OUTER: IMessageDescriptor = {
	name: 'Outer',
	fields: [
		{ name: 'inner', number: 1, kind: 'message', message: () => INNER },
		{ name: 'items', number: 2, kind: 'message', repeated: true, message: () => INNER },
		{ name: 'names', number: 3, kind: 'string', repeated: true },
		{ name: 'blobs', number: 4, kind: 'bytes', repeated: true },
	],
};

const RECURSIVE: IMessageDescriptor = {
	name: 'Recursive',
	fields: [
		{ name: 'child', number: 1, kind: 'message', message: () => RECURSIVE },
	],
};

const INT32_FIELD: IMessageDescriptor = { name: 'Int32Field', fields: [{ name: 'a', number: 1, kind: 'int32' }] };
const EXPLICIT_INT32_FIELD: IMessageDescriptor = { name: 'ExplicitInt32Field', fields: [{ name: 'a', number: 1, kind: 'int32', presence: 'explicit' }] };
const REPEATED_INT32: IMessageDescriptor = { name: 'RepeatedInt32', fields: [{ name: 'v', number: 1, kind: 'int32', repeated: true }] };

function mapDescriptor(key: NonNullable<IFieldDescriptor['map']>['key'], value: Omit<IFieldDescriptor, 'name' | 'number'>): IMessageDescriptor {
	return {
		name: `Map<${key}, ${value.kind}>`,
		fields: [{ name: 'm', number: 1, kind: 'message', map: { key, value: { name: 'value', number: 2, ...value } } }],
	};
}

const STRING_STRING_MAP = mapDescriptor('string', { kind: 'string' });

suite('protobuf codec', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('scalars', () => {

		test('round trips a message with every scalar kind', () => {
			const value = {
				i32: -5,
				i64: -(2n ** 63n),
				u32: 4294967295,
				u64: 2n ** 64n - 1n,
				s32: -2147483648,
				s64: 2n ** 63n - 1n,
				b: true,
				e: 2,
				f: Math.fround(1.1),
				d: 1.1,
				f32: 4294967295,
				f64: 2n ** 64n - 1n,
				sf32: -2147483648,
				sf64: -(2n ** 63n),
				str: 'héllo 🌍',
				buf: Uint8Array.from([1, 2, 3]),
			};
			const encoded = encodeMessage(SCALARS, value);
			assert.deepStrictEqual(decodeMessage(SCALARS, encoded), value);
		});

		test('int32 150 in field 1 => 08 96 01 (encoding spec)', () => {
			assert.strictEqual(hex(encodeMessage(INT32_FIELD, { a: 150 })), '08 96 01');
			assert.deepStrictEqual(decodeMessage(INT32_FIELD, bytes('08 96 01')), { a: 150 });
		});

		test('negative int32 is a ten-byte varint and sint32 is zigzag-encoded (conformance ValidDataScalar.INT32 / SINT32)', () => {
			assert.strictEqual(hex(encodeMessage(SCALARS, { i32: -1 })), '08 ff ff ff ff ff ff ff ff ff 01');
			assert.strictEqual(hex(encodeMessage(SCALARS, { s32: -1 })), '28 01');
			assert.strictEqual(hex(encodeMessage(SCALARS, { s64: -1n })), '30 01');
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('08 ff ff ff ff ff ff ff ff ff 01 28 01 30 01')), { i32: -1, s32: -1, s64: -1n });
		});

		test('64-bit varint in an int32 field truncates to the low 32 bits (conformance ValidDataScalar.INT32)', () => {
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('08 81 80 80 80 10')), { i32: 1 }, '0x1_0000_0001 => 1');
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('08 ff ff ff ff 0f')), { i32: -1 }, '0xFFFF_FFFF => -1');
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('08 80 80 80 80 10')), { i32: 0 }, '0x1_0000_0000 => 0');
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('08 ff ff ff ff 07')), { i32: 2147483647 });
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('08 80 80 80 80 08')), { i32: -2147483648 });
		});

		test('64-bit varint in uint32 and enum fields truncates (conformance ValidDataScalar.UINT32 / ENUM)', () => {
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('18 81 80 80 80 10')), { u32: 1 });
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('18 ff ff ff ff 0f')), { u32: 4294967295 });
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('40 81 80 80 80 10')), { e: 1 });
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('40 ff ff ff ff ff ff ff ff ff 01')), { e: -1 });
		});

		test('sint32 truncates to 32 bits before zigzag decoding (conformance ValidDataScalar.SINT32)', () => {
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('28 83 80 80 80 10')), { s32: -2 });
		});

		test('bool 2 => true (conformance ValidDataScalar.BOOL)', () => {
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('38 02')), { b: true });
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('38 00')), { b: false });
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('38 ff ff ff ff ff ff ff ff ff 01')), { b: true });
		});

		test('unknown enum numbers pass through and enum names are accepted on encode', () => {
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('40 2a')), { e: 42 });
			assert.strictEqual(hex(encodeMessage(SCALARS, { e: 'TWO' })), '40 02');
			assert.strictEqual(hex(encodeMessage(SCALARS, { e: -1 })), '40 ff ff ff ff ff ff ff ff ff 01');
			assertCodecError(() => encodeMessage(SCALARS, { e: 'THREE' }), 'invalid-value');
		});

		test('float values are written as IEEE 754 singles', () => {
			const decoded = decodeMessage(SCALARS, encodeMessage(SCALARS, { f: 1.1, d: 1.1 }));
			assert.strictEqual(decoded.f, Math.fround(1.1));
			assert.notStrictEqual(decoded.f, 1.1);
			assert.strictEqual(decoded.d, 1.1);
			assert.strictEqual(hex(encodeMessage(SCALARS, { f: 1.5 })), '4d 00 00 c0 3f');
			assert.strictEqual(hex(encodeMessage(SCALARS, { d: 1.5 })), '51 00 00 00 00 00 00 f8 3f');
		});

		test('NaN and infinities round trip through float and double', () => {
			const decoded = decodeMessage(SCALARS, encodeMessage(SCALARS, { f: NaN, d: -Infinity }));
			assert.ok(Number.isNaN(decoded.f));
			assert.strictEqual(decoded.d, -Infinity);
		});

		test('fixed kinds use little-endian encodings', () => {
			assert.strictEqual(hex(encodeMessage(SCALARS, { f32: 1 })), '5d 01 00 00 00');
			assert.strictEqual(hex(encodeMessage(SCALARS, { f64: 1n })), '61 01 00 00 00 00 00 00 00');
			assert.strictEqual(hex(encodeMessage(SCALARS, { sf32: -1 })), '6d ff ff ff ff');
			assert.strictEqual(hex(encodeMessage(SCALARS, { sf64: -1 })), '71 ff ff ff ff ff ff ff ff');
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('6d ff ff ff ff 71 ff ff ff ff ff ff ff ff')), { sf32: -1, sf64: -1n });
		});

		test('int64 2^53 + 1 round trips as a bigint and is rejected as a number', () => {
			const value = 2n ** 53n + 1n;
			assert.deepStrictEqual(decodeMessage(SCALARS, encodeMessage(SCALARS, { i64: value })), { i64: value });
			assertCodecError(() => encodeMessage(SCALARS, { i64: 2 ** 53 + 1 }), 'invalid-value');
			assert.deepStrictEqual(decodeMessage(SCALARS, encodeMessage(SCALARS, { i64: 42 })), { i64: 42n }, 'safe integers are accepted');
			assert.deepStrictEqual(decodeMessage(SCALARS, encodeMessage(SCALARS, { u64: 42 })), { u64: 42n });
		});

		test('64-bit kinds reject out-of-range values', () => {
			assertCodecError(() => encodeMessage(SCALARS, { i64: 2n ** 63n }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { u64: -1n }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { u64: 2n ** 64n }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { u64: -1 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { i64: 1.5 }), 'invalid-value');
		});

		test('32-bit kinds reject non-integers and out-of-range values', () => {
			assertCodecError(() => encodeMessage(SCALARS, { i32: 1.5 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { i32: 2147483648 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { i32: 1n }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { u32: -1 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { u32: 4294967296 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { s32: 2147483648 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { f32: -1 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { sf32: 2147483648 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { i32: NaN }), 'invalid-value');
		});

		test('other kinds reject values of the wrong type', () => {
			assertCodecError(() => encodeMessage(SCALARS, { b: 1 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { str: 5 }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { buf: 'x' }), 'invalid-value');
			assertCodecError(() => encodeMessage(SCALARS, { f: '1' }), 'invalid-value');
			assertCodecError(() => encodeMessage(OUTER, { inner: 'x' }), 'invalid-value');
			assertCodecError(() => encodeMessage(OUTER, { inner: [] }), 'invalid-value');
			assertCodecError(() => encodeMessage(OUTER, { items: {} }), 'invalid-value');
			assertCodecError(() => encodeMessage(STRING_STRING_MAP, { m: [] }), 'invalid-value');
		});

		test('decoded strings must be valid UTF-8', () => {
			assert.throws(() => decodeMessage(SCALARS, bytes('7a 01 ff')), (err: unknown) => err instanceof ProtoDecodeError && err.reason === 'invalid-utf8');
		});

		test('decoded bytes are copies, not views into the input', () => {
			const input = bytes('82 01 03 01 02 03');
			const decoded = decodeMessage(SCALARS, input);
			assert.deepStrictEqual(decoded.buf, Uint8Array.from([1, 2, 3]));
			assert.notStrictEqual((decoded.buf as Uint8Array).buffer, input.buffer);
		});
	});

	suite('presence', () => {

		test('implicit-presence scalars with default values are omitted', () => {
			assert.strictEqual(hex(encodeMessage(SCALARS, { i32: 0, i64: 0n, u32: 0, u64: 0, s32: 0, s64: 0, b: false, e: 0, f: 0, d: 0, f32: 0, f64: 0n, sf32: 0, sf64: 0, str: '', buf: new Uint8Array(0) })), '');
			assert.strictEqual(hex(encodeMessage(INT32_FIELD, { a: 0 })), '');
			assert.strictEqual(hex(encodeMessage(SCALARS, { d: -0 })), '');
		});

		test('explicit optional int32 0 is written as 08 00', () => {
			assert.strictEqual(hex(encodeMessage(EXPLICIT_INT32_FIELD, { a: 0 })), '08 00');
			assert.strictEqual(hex(encodeMessage(EXPLICIT_INT32_FIELD, {})), '');
			assert.deepStrictEqual(decodeMessage(EXPLICIT_INT32_FIELD, bytes('08 00')), { a: 0 });
			assert.deepStrictEqual(decodeMessage(EXPLICIT_INT32_FIELD, bytes('')), {});
		});

		test('absent scalars stay absent on decode; implicit zero on the wire is still reported', () => {
			assert.deepStrictEqual(decodeMessage(SCALARS, new Uint8Array(0)), {});
			assert.deepStrictEqual(decodeMessage(INT32_FIELD, bytes('08 00')), { a: 0 });
		});

		test('undefined and null properties are treated as absent on encode', () => {
			assert.strictEqual(hex(encodeMessage(SCALARS, { i32: undefined, str: null })), '');
			assert.strictEqual(hex(encodeMessage(OUTER, { inner: null })), '');
		});

		test('empty embedded messages are present', () => {
			assert.strictEqual(hex(encodeMessage(OUTER, { inner: {} })), '0a 00');
			assert.deepStrictEqual(decodeMessage(OUTER, bytes('0a 00')), { inner: {} });
		});

		test('last one wins for repeated scalar occurrences (conformance ValidDataScalar.*.MultipleValuesForSameField)', () => {
			assert.deepStrictEqual(decodeMessage(INT32_FIELD, bytes('08 01 08 02 08 03')), { a: 3 });
			assert.deepStrictEqual(decodeMessage(SCALARS, bytes('7a 01 61 7a 01 62')), { str: 'b' });
		});
	});

	suite('oneof', () => {

		test('google.protobuf.Value cases: null => 08 00, 0 => 11 + 8 zero bytes, false => 20 00, "" => 1a 00', () => {
			assert.strictEqual(hex(encodeMessage(VALUE, { null_value: 0 })), '08 00');
			assert.strictEqual(hex(encodeMessage(VALUE, { number_value: 0 })), '11 00 00 00 00 00 00 00 00');
			assert.strictEqual(hex(encodeMessage(VALUE, { bool_value: false })), '20 00');
			assert.strictEqual(hex(encodeMessage(VALUE, { string_value: '' })), '1a 00');
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('08 00')), { null_value: 0 });
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('11 00 00 00 00 00 00 00 00')), { number_value: 0 });
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('20 00')), { bool_value: false });
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('1a 00')), { string_value: '' });
		});

		test('a later member replaces an earlier one (conformance ValidDataOneof.*.MultipleValuesForDifferentField)', () => {
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('1a 01 61 20 01')), { bool_value: true });
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('20 01 1a 01 61')), { string_value: 'a' });
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('2a 00 1a 01 61')), { string_value: 'a' }, 'a scalar replaces a message');
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('1a 01 61 2a 00')), { struct_value: {} }, 'a message replaces a scalar');
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('2a 00 32 00')), { list_value: {} }, 'a message replaces another message');
		});

		test('the same member twice keeps the last value (conformance ValidDataOneof.*.MultipleValuesForSameField)', () => {
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('1a 01 61 1a 01 62')), { string_value: 'b' });
			assert.deepStrictEqual(decodeMessage(VALUE, bytes('08 00 08 01')), { null_value: 1 });
		});

		test('the same message member twice is merged (conformance ValidDataOneof.MESSAGE.Merge)', () => {
			const first = encodeMessage(VALUE, { struct_value: { fields: { a: { number_value: 1 } } } });
			const second = encodeMessage(VALUE, { struct_value: { fields: { b: { bool_value: true } } } });
			assert.deepStrictEqual(decodeMessage(VALUE, concat(first, second)), {
				struct_value: { fields: { a: { number_value: 1 }, b: { bool_value: true } } },
			});
		});

		test('only one member is written when several are present in the object', () => {
			// Encoding does not enforce exclusivity; it writes what is there in declaration order,
			// so a decoder sees the last one. This documents the behaviour rather than prescribing it.
			const encoded = encodeMessage(VALUE, { bool_value: true, string_value: 'x' });
			assert.deepStrictEqual(decodeMessage(VALUE, encoded), { bool_value: true });
		});
	});

	suite('repeated', () => {

		test('repeated int32 concatenates packed and unpacked occurrences (conformance ValidDataRepeated.INT32.PackedInput / UnpackedInput)', () => {
			assert.deepStrictEqual(decodeMessage(REPEATED_INT32, bytes('0a 02 01 02 08 03 0a 01 04')), { v: [1, 2, 3, 4] });
			assert.deepStrictEqual(decodeMessage(REPEATED_INT32, bytes('08 03')), { v: [3] });
			assert.deepStrictEqual(decodeMessage(REPEATED_INT32, bytes('0a 00')), { v: [] }, 'an empty packed field still marks presence');
		});

		test('repeated packable scalars are written packed', () => {
			assert.strictEqual(hex(encodeMessage(REPEATED_INT32, { v: [3, 270, 86942] })), '0a 06 03 8e 02 9e a7 05');
			assert.strictEqual(hex(encodeMessage(REPEATED_INT32, { v: [] })), '');
			assert.strictEqual(hex(encodeMessage(REPEATED_INT32, { v: [0] })), '0a 01 00', 'default values are kept in repeated fields');
		});

		test('round trips every repeated scalar kind', () => {
			const value = {
				i32: [-1, 0, 2147483647],
				i64: [-(2n ** 63n), 0n, 2n ** 63n - 1n],
				u32: [0, 4294967295],
				u64: [0n, 2n ** 64n - 1n],
				s32: [-2147483648, -1, 0, 1],
				s64: [-(2n ** 63n), -1n, 0n, 1n],
				b: [true, false, true],
				e: [0, 1, 42],
				f: [Math.fround(0.1), 0, -1.5],
				d: [0.1, 0, -1.5],
				f32: [0, 4294967295],
				f64: [0n, 2n ** 64n - 1n],
				sf32: [-2147483648, 2147483647],
				sf64: [-(2n ** 63n), 2n ** 63n - 1n],
				str: ['', 'a', 'héllo'],
				buf: [new Uint8Array(0), Uint8Array.from([255])],
			};
			const encoded = encodeMessage(REPEATED_SCALARS, value);
			assert.deepStrictEqual(decodeMessage(REPEATED_SCALARS, encoded), value);
		});

		test('packed fixed-width and zigzag kinds decode from packed payloads (conformance ValidDataRepeated.*.PackedInput)', () => {
			assert.deepStrictEqual(decodeMessage(REPEATED_SCALARS, bytes('2a 02 01 02')), { s32: [-1, 1] });
			assert.deepStrictEqual(decodeMessage(REPEATED_SCALARS, bytes('5a 08 01 00 00 00 02 00 00 00')), { f32: [1, 2] });
			assert.deepStrictEqual(decodeMessage(REPEATED_SCALARS, bytes('4a 04 00 00 c0 3f')), { f: [1.5] });
			assert.deepStrictEqual(decodeMessage(REPEATED_SCALARS, bytes('52 08 00 00 00 00 00 00 f8 3f')), { d: [1.5] });
			assert.deepStrictEqual(decodeMessage(REPEATED_SCALARS, bytes('3a 03 01 00 02')), { b: [true, false, true] });
		});

		test('repeated strings, bytes and messages are never packed (conformance ValidDataRepeated.STRING / MESSAGE)', () => {
			assert.strictEqual(hex(encodeMessage(OUTER, { names: ['a', 'b'] })), '1a 01 61 1a 01 62');
			assert.strictEqual(hex(encodeMessage(OUTER, { blobs: [new Uint8Array(0), Uint8Array.from([1])] })), '22 00 22 01 01');
			assert.strictEqual(hex(encodeMessage(OUTER, { items: [{ a: 1 }, {}] })), '12 02 08 01 12 00');
			assert.deepStrictEqual(decodeMessage(OUTER, bytes('1a 01 61 1a 01 62 12 02 08 01 12 00')), { names: ['a', 'b'], items: [{ a: 1 }, {}] });
		});

		test('a truncated packed payload fails with a decode error', () => {
			assert.throws(() => decodeMessage(REPEATED_SCALARS, bytes('5a 03 01 00 00')), (err: unknown) => err instanceof ProtoDecodeError && err.reason === 'truncated');
		});
	});

	suite('nested messages', () => {

		test('nested round trip', () => {
			const value = {
				inner: { a: 1, b: 'x', r: [1, 2, 3] },
				items: [{ a: 2 }, { b: 'y' }, {}],
				names: ['n'],
			};
			assert.deepStrictEqual(decodeMessage(OUTER, encodeMessage(OUTER, value)), value);
		});

		test('embedded messages that appear twice are merged field by field (conformance ValidDataScalar.MESSAGE merge)', () => {
			const first = encodeMessage(OUTER, { inner: { a: 1, b: 'first', r: [1] } });
			const second = encodeMessage(OUTER, { inner: { b: 'second', r: [2, 3] } });
			assert.deepStrictEqual(decodeMessage(OUTER, concat(first, second)), { inner: { a: 1, b: 'second', r: [1, 2, 3] } });
		});

		test('merging is recursive', () => {
			const first = encodeMessage(RECURSIVE, { child: { child: {} } });
			const second = encodeMessage(RECURSIVE, { child: { child: { child: {} } } });
			assert.deepStrictEqual(decodeMessage(RECURSIVE, concat(first, second)), { child: { child: { child: {} } } });
		});

		test('typed decode', () => {
			interface IInner { a?: number; b?: string; r?: number[] }
			const decoded = decodeMessage<{ inner?: IInner }>(OUTER, encodeMessage(OUTER, { inner: { a: 7 } }));
			assert.strictEqual(decoded.inner?.a, 7);
		});
	});

	suite('unknown fields', () => {

		test('unknown field 99 is preserved byte-identical and re-emitted after the known fields', () => {
			const decoded = decodeMessage<ProtoMessage>(INT32_FIELD, bytes('98 06 05 08 07'));
			assert.strictEqual(decoded.a, 7);
			assert.strictEqual(hex(decoded[UNKNOWN_FIELDS]!), '98 06 05');
			assert.strictEqual(hex(encodeMessage(INT32_FIELD, decoded)), '08 07 98 06 05');
		});

		test('unknown fields of every wire type, including groups, are kept in order', () => {
			const input = bytes('10 01 0b 08 01 0c 1d 01 00 00 00 21 02 00 00 00 00 00 00 00 2a 01 61 08 09');
			const decoded = decodeMessage<ProtoMessage>(INT32_FIELD, input);
			assert.strictEqual(decoded.a, 9);
			assert.strictEqual(hex(decoded[UNKNOWN_FIELDS]!), '10 01 0b 08 01 0c 1d 01 00 00 00 21 02 00 00 00 00 00 00 00 2a 01 61');
			assert.strictEqual(hex(encodeMessage(INT32_FIELD, decoded)), '08 09 10 01 0b 08 01 0c 1d 01 00 00 00 21 02 00 00 00 00 00 00 00 2a 01 61');
		});

		test('a known field with the wrong wire type is kept as unknown', () => {
			const decoded = decodeMessage<ProtoMessage>(INT32_FIELD, bytes('0a 01 61 08 02'));
			assert.deepStrictEqual(Object.keys(decoded), ['a']);
			assert.strictEqual(decoded.a, 2);
			assert.strictEqual(hex(decoded[UNKNOWN_FIELDS]!), '0a 01 61');
			const repeated = decodeMessage<ProtoMessage>(OUTER, bytes('18 01'));
			assert.strictEqual(repeated.names, undefined);
			assert.strictEqual(hex(repeated[UNKNOWN_FIELDS]!), '18 01');
		});

		test('messages without unknown fields do not carry the symbol', () => {
			const decoded = decodeMessage<ProtoMessage>(INT32_FIELD, bytes('08 01'));
			assert.strictEqual(Object.prototype.hasOwnProperty.call(decoded, UNKNOWN_FIELDS), false);
		});

		test('unknown fields inside nested messages survive a round trip and merge', () => {
			const first = new ProtoWriter().nested(1, w => w.tag(1, WireType.Varint).varint(1).tag(50, WireType.Varint).varint(5)).finish();
			const second = new ProtoWriter().nested(1, w => w.tag(51, WireType.Varint).varint(6)).finish();
			const decoded = decodeMessage<{ inner: ProtoMessage }>(OUTER, concat(first, second));
			assert.strictEqual(decoded.inner.a, 1);
			assert.strictEqual(hex(decoded.inner[UNKNOWN_FIELDS]!), '90 03 05 98 03 06');
			assert.strictEqual(hex(encodeMessage(OUTER, decoded)), '0a 08 08 01 90 03 05 98 03 06');
		});

		test('unknown-field bytes that are not a Uint8Array are ignored on encode', () => {
			const value: ProtoMessage = { a: 1 };
			Object.defineProperty(value, UNKNOWN_FIELDS, { value: 'nope', enumerable: true });
			assert.strictEqual(hex(encodeMessage(INT32_FIELD, value)), '08 01');
		});
	});

	suite('maps', () => {

		test('map<string, string> round trip', () => {
			const value = { m: { a: 'x', b: '', '': 'empty key' } };
			const encoded = encodeMessage(STRING_STRING_MAP, value);
			assert.strictEqual(hex(encoded), '0a 06 0a 01 61 12 01 78 0a 05 0a 01 62 12 00 0a 0d 0a 00 12 09 65 6d 70 74 79 20 6b 65 79');
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, encoded), value);
		});

		test('an entry with a missing value decodes with the default (conformance ValidDataMap.STRING.STRING.MissingDefault)', () => {
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 03 0a 01 61')), { m: { a: '' } });
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 03 12 01 78')), { m: { '': 'x' } }, 'missing key');
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 00')), { m: { '': '' } }, 'empty entry');
		});

		test('duplicate keys: last wins (conformance ValidDataMap.STRING.STRING.DuplicateKey)', () => {
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 06 0a 01 61 12 01 78 0a 06 0a 01 61 12 01 79')), { m: { a: 'y' } });
		});

		test('duplicate key or value inside one entry: last wins (conformance ValidDataMap.*.DuplicateKeyInMapEntry / DuplicateValueInMapEntry)', () => {
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 09 0a 01 61 0a 01 62 12 01 78')), { m: { b: 'x' } });
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 09 0a 01 61 12 01 78 12 01 79')), { m: { a: 'y' } });
		});

		test('unknown fields inside a map entry are dropped', () => {
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 08 0a 01 61 12 01 78 18 01')), { m: { a: 'x' } });
		});

		test('map entries merge across occurrences (conformance ValidDataMap.*.Unordered)', () => {
			assert.deepStrictEqual(decodeMessage(STRING_STRING_MAP, bytes('0a 06 0a 01 62 12 01 79 0a 06 0a 01 61 12 01 78')), { m: { b: 'y', a: 'x' } });
		});

		test('numeric and boolean keys use their decimal / true-false string form', () => {
			const int32Map = mapDescriptor('int32', { kind: 'bool' });
			assert.deepStrictEqual(decodeMessage(int32Map, encodeMessage(int32Map, { m: { '-1': true, '7': false } })), { m: { '-1': true, '7': false } });
			assert.strictEqual(hex(encodeMessage(int32Map, { m: { '7': false } })), '0a 04 08 07 10 00', 'map entry values are always written');

			const boolMap = mapDescriptor('bool', { kind: 'int64' });
			assert.deepStrictEqual(decodeMessage(boolMap, encodeMessage(boolMap, { m: { true: 1n, false: -1 } })), { m: { true: 1n, false: -1n } });

			const int64Map = mapDescriptor('sint64', { kind: 'string' });
			assert.deepStrictEqual(decodeMessage(int64Map, encodeMessage(int64Map, { m: { '-9223372036854775808': 'min' } })), { m: { '-9223372036854775808': 'min' } });

			const uint32Map = mapDescriptor('fixed32', { kind: 'string' });
			assert.deepStrictEqual(decodeMessage(uint32Map, encodeMessage(uint32Map, { m: { '4294967295': 'max' } })), { m: { '4294967295': 'max' } });
		});

		test('invalid map keys are rejected', () => {
			const int32Map = mapDescriptor('int32', { kind: 'bool' });
			assertCodecError(() => encodeMessage(int32Map, { m: { x: true } }), 'invalid-value');
			assertCodecError(() => encodeMessage(int32Map, { m: { '1.5': true } }), 'invalid-value');
			assertCodecError(() => encodeMessage(int32Map, { m: { '2147483648': true } }), 'invalid-value');
			const boolMap = mapDescriptor('bool', { kind: 'int32' });
			assertCodecError(() => encodeMessage(boolMap, { m: { yes: 1 } }), 'invalid-value');
			const uint64Map = mapDescriptor('uint64', { kind: 'int32' });
			assertCodecError(() => encodeMessage(uint64Map, { m: { '-1': 1 } }), 'invalid-value');
		});

		test('map<string, message> round trip and missing message value', () => {
			const messageMap = mapDescriptor('string', { kind: 'message', message: () => INNER });
			const value = { m: { a: { a: 1, r: [2] }, b: {} } };
			assert.deepStrictEqual(decodeMessage(messageMap, encodeMessage(messageMap, value)), value);
			assert.deepStrictEqual(decodeMessage(messageMap, bytes('0a 03 0a 01 61')), { m: { a: {} } });
		});

		test('entries with undefined or null values are skipped on encode', () => {
			assert.strictEqual(hex(encodeMessage(STRING_STRING_MAP, { m: { a: undefined, b: null } })), '');
		});

		test('keys such as __proto__ become own properties', () => {
			const decoded = decodeMessage<{ m: Record<string, string> }>(STRING_STRING_MAP, encodeMessage(STRING_STRING_MAP, { m: Object.fromEntries([['__proto__', 'x']]) }));
			assert.strictEqual(Object.getPrototypeOf(decoded.m), Object.prototype);
			assert.deepStrictEqual(Object.keys(decoded.m), ['__proto__']);
			assert.strictEqual(Object.getOwnPropertyDescriptor(decoded.m, '__proto__')?.value, 'x');
		});
	});

	suite('limits', () => {

		function nestedValue(levels: number): Record<string, unknown> {
			let value: Record<string, unknown> = {};
			for (let i = 1; i < levels; i++) {
				value = { child: value };
			}
			return value;
		}

		function nestedBytes(levels: number): Uint8Array {
			let encoded: Uint8Array = new Uint8Array(0);
			for (let i = 1; i < levels; i++) {
				encoded = new ProtoWriter().bytes(1, encoded).finish();
			}
			return encoded;
		}

		test('depth 65 => too-deep, depth 64 is fine', () => {
			assert.deepStrictEqual(decodeMessage(RECURSIVE, encodeMessage(RECURSIVE, nestedValue(64))), nestedValue(64));
			assertCodecError(() => encodeMessage(RECURSIVE, nestedValue(65)), 'too-deep');
			assert.deepStrictEqual(decodeMessage(RECURSIVE, nestedBytes(64)), nestedValue(64));
			assertCodecError(() => decodeMessage(RECURSIVE, nestedBytes(65)), 'too-deep');
		});

		test('maxDepth can be overridden', () => {
			assert.deepStrictEqual(decodeMessage(RECURSIVE, nestedBytes(2), { maxDepth: 2 }), nestedValue(2));
			assertCodecError(() => decodeMessage(RECURSIVE, nestedBytes(3), { maxDepth: 2 }), 'too-deep');
			assertCodecError(() => encodeMessage(RECURSIVE, nestedValue(3), { maxDepth: 2 }), 'too-deep');
		});

		test('map entries count as a nesting level', () => {
			const messageMap = mapDescriptor('string', { kind: 'message', message: () => INNER });
			const value = { m: { a: {} } };
			assert.deepStrictEqual(decodeMessage(messageMap, encodeMessage(messageMap, value, { maxDepth: 3 }), { maxDepth: 3 }), value);
			assertCodecError(() => encodeMessage(messageMap, value, { maxDepth: 2 }), 'too-deep');
			assertCodecError(() => decodeMessage(messageMap, encodeMessage(messageMap, value), { maxDepth: 2 }), 'too-deep');
		});

		test('maxElements overflow => too-many-elements', () => {
			const limits = { maxElements: 3 };
			assert.deepStrictEqual(decodeMessage(REPEATED_INT32, encodeMessage(REPEATED_INT32, { v: [1, 2, 3] }, limits), limits), { v: [1, 2, 3] });
			assertCodecError(() => encodeMessage(REPEATED_INT32, { v: [1, 2, 3, 4] }, limits), 'too-many-elements');
			assertCodecError(() => decodeMessage(REPEATED_INT32, bytes('0a 04 01 02 03 04'), limits), 'too-many-elements');
			assertCodecError(() => decodeMessage(REPEATED_INT32, bytes('08 01 08 02 08 03 08 04'), limits), 'too-many-elements');
		});

		test('elements are counted across the whole message tree, including maps', () => {
			const limits = { maxElements: 3 };
			assertCodecError(() => encodeMessage(OUTER, { items: [{ r: [1, 2] }, {}] }, limits), 'too-many-elements');
			assertCodecError(() => encodeMessage(STRING_STRING_MAP, { m: { a: '', b: '', c: '', d: '' } }, limits), 'too-many-elements');
			assertCodecError(() => decodeMessage(STRING_STRING_MAP, encodeMessage(STRING_STRING_MAP, { m: { a: '', b: '', c: '', d: '' } }), limits), 'too-many-elements');
			assert.deepStrictEqual(decodeMessage(OUTER, encodeMessage(OUTER, { items: [{ r: [1] }, {}] }, limits), limits), { items: [{ r: [1] }, {}] });
		});

		test('the default limits are 64 levels and 262144 elements', () => {
			assert.deepStrictEqual({ ...DEFAULT_CODEC_LIMITS }, { maxDepth: 64, maxElements: 262144 });
		});
	});

	suite('descriptor errors', () => {

		test('an unknown field kind => unknown-field-kind', () => {
			const bogus: IMessageDescriptor = { name: 'Bogus', fields: [{ name: 'x', number: 1, kind: 'bogus' as ScalarKind }] };
			assertCodecError(() => encodeMessage(bogus, { x: 1 }), 'unknown-field-kind');
			assertCodecError(() => decodeMessage(bogus, bytes('08 01')), 'unknown-field-kind');
		});

		test('a message field without a message descriptor => unknown-field-kind', () => {
			const broken: IMessageDescriptor = { name: 'Broken', fields: [{ name: 'x', number: 1, kind: 'message' }] };
			assertCodecError(() => encodeMessage(broken, { x: {} }), 'unknown-field-kind');
			assertCodecError(() => decodeMessage(broken, bytes('0a 00')), 'unknown-field-kind');
		});

		test('ProtoCodecError carries the reason and a name', () => {
			try {
				encodeMessage(SCALARS, { i32: 'x' });
				assert.fail('expected an error');
			} catch (err) {
				assert.ok(err instanceof ProtoCodecError);
				assert.strictEqual(err.name, 'ProtoCodecError');
				assert.strictEqual(err.reason, 'invalid-value');
				assert.ok(err.message.includes('i32'));
			}
		});
	});
});
