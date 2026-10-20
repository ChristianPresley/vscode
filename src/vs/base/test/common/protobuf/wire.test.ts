/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeUtf8, IProtoField, ProtoDecodeError, ProtoDecodeErrorReason, ProtoReader, ProtoWriter, varintLength, WireType, zigzagDecode32, zigzagDecode64, zigzagEncode32, zigzagEncode64 } from '../../../common/protobuf/wire.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
}

function bytes(hexString: string): Uint8Array {
	const parts = hexString.trim().split(/\s+/).filter(p => p.length > 0);
	return Uint8Array.from(parts, p => parseInt(p, 16));
}

function readAll(input: Uint8Array): IProtoField[] {
	const reader = new ProtoReader(input);
	const fields: IProtoField[] = [];
	for (let field = reader.next(); field; field = reader.next()) {
		fields.push(field);
	}
	return fields;
}

function assertDecodeError(fn: () => unknown, reason: ProtoDecodeErrorReason): void {
	assert.throws(fn, (err: unknown) => err instanceof ProtoDecodeError && err.reason === reason, `expected ProtoDecodeError '${reason}'`);
}

suite('protobuf wire', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('writer', () => {

		test('varint 300 => AC 02 (encoding spec, Base 128 Varints)', () => {
			assert.strictEqual(hex(new ProtoWriter().varint(300).finish()), 'ac 02');
			assert.strictEqual(hex(new ProtoWriter().varint(300n).finish()), 'ac 02');
			assert.strictEqual(hex(new ProtoWriter().varint(0).finish()), '00');
			assert.strictEqual(hex(new ProtoWriter().varint(1).finish()), '01');
			assert.strictEqual(hex(new ProtoWriter().varint(127).finish()), '7f');
			assert.strictEqual(hex(new ProtoWriter().varint(128).finish()), '80 01');
		});

		test('int32 -1 => ten bytes FF FF FF FF FF FF FF FF FF 01 (encoding spec, signed integers)', () => {
			assert.strictEqual(hex(new ProtoWriter().varint(-1).finish()), 'ff ff ff ff ff ff ff ff ff 01');
			assert.strictEqual(hex(new ProtoWriter().varint(-1n).finish()), 'ff ff ff ff ff ff ff ff ff 01');
		});

		test('varints above 2^32 and up to 2^64 - 1', () => {
			assert.strictEqual(hex(new ProtoWriter().varint(4294967296).finish()), '80 80 80 80 10');
			assert.strictEqual(hex(new ProtoWriter().varint(Number.MAX_SAFE_INTEGER).finish()), 'ff ff ff ff ff ff ff 0f');
			assert.strictEqual(hex(new ProtoWriter().varint(2n ** 64n - 1n).finish()), 'ff ff ff ff ff ff ff ff ff 01');
			assert.strictEqual(hex(new ProtoWriter().varint(2n ** 63n).finish()), '80 80 80 80 80 80 80 80 80 01');
		});

		test('sint32 -1 => 01, sint32 1 => 02 (encoding spec, ZigZag)', () => {
			assert.strictEqual(hex(new ProtoWriter().sint32(-1).finish()), '01');
			assert.strictEqual(hex(new ProtoWriter().sint32(1).finish()), '02');
			assert.strictEqual(hex(new ProtoWriter().sint32(0).finish()), '00');
			assert.strictEqual(hex(new ProtoWriter().sint32(-2).finish()), '03');
			assert.strictEqual(hex(new ProtoWriter().sint32(2147483647).finish()), 'fe ff ff ff 0f');
			assert.strictEqual(hex(new ProtoWriter().sint32(-2147483648).finish()), 'ff ff ff ff 0f');
		});

		test('sint64 -2^63 round trips', () => {
			const min = -(2n ** 63n);
			const encoded = new ProtoWriter().sint64(min).finish();
			assert.strictEqual(hex(encoded), 'ff ff ff ff ff ff ff ff ff 01');
			assert.strictEqual(zigzagDecode64(new ProtoReader(encoded).varint()), min);

			const max = 2n ** 63n - 1n;
			assert.strictEqual(zigzagDecode64(new ProtoReader(new ProtoWriter().sint64(max).finish()).varint()), max);
			assert.strictEqual(hex(new ProtoWriter().sint64(-1).finish()), '01');
		});

		test('fixed32 and fixed64 are little-endian', () => {
			assert.strictEqual(hex(new ProtoWriter().fixed32(0x12345678).finish()), '78 56 34 12');
			assert.strictEqual(hex(new ProtoWriter().fixed32(-1).finish()), 'ff ff ff ff');
			assert.strictEqual(hex(new ProtoWriter().fixed64(0x1122334455667788n).finish()), '88 77 66 55 44 33 22 11');
			assert.strictEqual(hex(new ProtoWriter().fixed64(1).finish()), '01 00 00 00 00 00 00 00');
			assert.strictEqual(hex(new ProtoWriter().fixed64(-1n).finish()), 'ff ff ff ff ff ff ff ff');
		});

		test('float 1.5 => 00 00 C0 3F, double 1.5 => 00 00 00 00 00 00 F8 3F', () => {
			assert.strictEqual(hex(new ProtoWriter().float(1.5).finish()), '00 00 c0 3f');
			assert.strictEqual(hex(new ProtoWriter().double(1.5).finish()), '00 00 00 00 00 00 f8 3f');
			assert.strictEqual(hex(new ProtoWriter().float(-0).finish()), '00 00 00 80');
		});

		test('bool', () => {
			assert.strictEqual(hex(new ProtoWriter().bool(true).bool(false).finish()), '01 00');
		});

		test('tag combines field number and wire type', () => {
			assert.strictEqual(hex(new ProtoWriter().tag(1, WireType.Varint).finish()), '08');
			assert.strictEqual(hex(new ProtoWriter().tag(2, WireType.LengthDelimited).finish()), '12');
			assert.strictEqual(hex(new ProtoWriter().tag(16, WireType.Varint).finish()), '80 01');
			assert.strictEqual(hex(new ProtoWriter().tag(536870911, WireType.Fixed32).finish()), 'fd ff ff ff 0f');
			assert.throws(() => new ProtoWriter().tag(0, WireType.Varint), RangeError);
			assert.throws(() => new ProtoWriter().tag(536870912, WireType.Varint), RangeError);
		});

		test('string field 2 "testing" => 12 07 74 65 73 74 69 6E 67 (encoding spec, length-delimited)', () => {
			assert.strictEqual(hex(new ProtoWriter().string(2, 'testing').finish()), '12 07 74 65 73 74 69 6e 67');
			assert.strictEqual(hex(new ProtoWriter().string(2, '').finish()), '12 00');
			assert.strictEqual(hex(new ProtoWriter().string(1, 'é').finish()), '0a 02 c3 a9');
		});

		test('bytes field', () => {
			assert.strictEqual(hex(new ProtoWriter().bytes(1, bytes('01 02 03')).finish()), '0a 03 01 02 03');
			assert.strictEqual(hex(new ProtoWriter().bytes(1, new Uint8Array(0)).finish()), '0a 00');
		});

		test('packed [3, 270, 86942] in field 6 => 32 06 03 8E 02 9E A7 05 (encoding spec, packed repeated)', () => {
			assert.strictEqual(hex(new ProtoWriter().packed(6, 'varint', [3, 270, 86942]).finish()), '32 06 03 8e 02 9e a7 05');
		});

		test('packed kinds', () => {
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'sint32', [-1, 1]).finish()), '0a 02 01 02');
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'sint64', [-1n, 1]).finish()), '0a 02 01 02');
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'fixed32', [1, 2]).finish()), '0a 08 01 00 00 00 02 00 00 00');
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'fixed64', [1n]).finish()), '0a 08 01 00 00 00 00 00 00 00');
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'float', [1.5]).finish()), '0a 04 00 00 c0 3f');
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'double', [1.5]).finish()), '0a 08 00 00 00 00 00 00 f8 3f');
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'bool', [true, false]).finish()), '0a 02 01 00');
			assert.strictEqual(hex(new ProtoWriter().packed(1, 'varint', []).finish()), '0a 00');
		});

		test('nested message Test3 { c: Test1 { a: 150 } } => 1A 03 08 96 01 (encoding spec, embedded messages)', () => {
			const encoded = new ProtoWriter().nested(3, w => w.tag(1, WireType.Varint).varint(150)).finish();
			assert.strictEqual(hex(encoded), '1a 03 08 96 01');
		});

		test('nested payloads longer than 127 bytes get a multi-byte length prefix', () => {
			const payload = new Uint8Array(300).fill(0x61);
			const encoded = new ProtoWriter().varint(7).nested(1, w => w.bytes(2, payload)).varint(9).finish();
			// 07 | 0a | len(303) = af 02 | 12 | len(300) = ac 02 | 300 x 61 | 09
			assert.strictEqual(encoded.length, 1 + 1 + 2 + 1 + 2 + 300 + 1);
			assert.strictEqual(hex(encoded.subarray(0, 7)), '07 0a af 02 12 ac 02');
			assert.strictEqual(encoded[encoded.length - 1], 9);
			const [outer] = readAll(encoded.subarray(1, encoded.length - 1));
			assert.strictEqual(outer.field, 1);
			assert.strictEqual(outer.bytes?.length, 303);
			const [inner] = readAll(outer.bytes!);
			assert.strictEqual(inner.field, 2);
			assert.deepStrictEqual(inner.bytes, payload);
		});

		test('deeply nested writes', () => {
			const encoded = new ProtoWriter().nested(1, w => w.nested(2, w2 => w2.nested(3, w3 => w3.tag(4, WireType.Varint).varint(1)))).finish();
			assert.strictEqual(hex(encoded), '0a 06 12 04 1a 02 20 01');
		});

		test('raw appends bytes verbatim and finish returns a copy', () => {
			const writer = new ProtoWriter(4);
			const encoded = writer.raw(bytes('01 02 03 04 05 06')).finish();
			assert.strictEqual(hex(encoded), '01 02 03 04 05 06');
			writer.varint(7);
			assert.strictEqual(hex(encoded), '01 02 03 04 05 06');
			assert.strictEqual(hex(writer.finish()), '01 02 03 04 05 06 07');
		});

		test('grows beyond the initial capacity', () => {
			const writer = new ProtoWriter(1);
			for (let i = 0; i < 1000; i++) {
				writer.varint(i);
			}
			const reader = new ProtoReader(writer.finish());
			for (let i = 0; i < 1000; i++) {
				assert.strictEqual(reader.varint(), BigInt(i));
			}
			assert.strictEqual(reader.eof, true);
		});
	});

	suite('helpers', () => {

		test('varintLength', () => {
			assert.strictEqual(varintLength(0), 1);
			assert.strictEqual(varintLength(127), 1);
			assert.strictEqual(varintLength(128), 2);
			assert.strictEqual(varintLength(300), 2);
			assert.strictEqual(varintLength(16383), 2);
			assert.strictEqual(varintLength(16384), 3);
			assert.strictEqual(varintLength(4294967295), 5);
			assert.strictEqual(varintLength(Number.MAX_SAFE_INTEGER), 8);
			assert.strictEqual(varintLength(-1), 10);
			assert.strictEqual(varintLength(-1n), 10);
			assert.strictEqual(varintLength(2n ** 64n - 1n), 10);
		});

		test('zigzag 32', () => {
			const cases: [number, number][] = [[0, 0], [-1, 1], [1, 2], [-2, 3], [2, 4], [2147483647, 4294967294], [-2147483648, 4294967295]];
			for (const [signed, encoded] of cases) {
				assert.strictEqual(zigzagEncode32(signed), encoded, `encode ${signed}`);
				assert.strictEqual(zigzagDecode32(encoded), signed, `decode ${encoded}`);
			}
		});

		test('zigzag 64', () => {
			const cases: [bigint, bigint][] = [[0n, 0n], [-1n, 1n], [1n, 2n], [-2n, 3n], [2n ** 63n - 1n, 2n ** 64n - 2n], [-(2n ** 63n), 2n ** 64n - 1n]];
			for (const [signed, encoded] of cases) {
				assert.strictEqual(zigzagEncode64(signed), encoded, `encode ${signed}`);
				assert.strictEqual(zigzagDecode64(encoded), signed, `decode ${encoded}`);
			}
		});

		test('decodeUtf8 round trips and rejects invalid sequences', () => {
			assert.strictEqual(decodeUtf8(new ProtoWriter().string(1, 'héllo 🌍').finish().subarray(2)), 'héllo 🌍');
			assert.strictEqual(decodeUtf8(bytes('ef bb bf 61')), '﻿a', 'a leading BOM is kept');
			assertDecodeError(() => decodeUtf8(bytes('ff')), 'invalid-utf8');
			assertDecodeError(() => decodeUtf8(bytes('c3 28')), 'invalid-utf8');
			assertDecodeError(() => decodeUtf8(bytes('ed a0 80')), 'invalid-utf8');
		});
	});

	suite('reader', () => {

		test('reads varint, fixed and length-delimited fields', () => {
			const input = new ProtoWriter()
				.tag(1, WireType.Varint).varint(150)
				.tag(2, WireType.Fixed64).fixed64(0x1122334455667788n)
				.string(3, 'testing')
				.tag(4, WireType.Fixed32).fixed32(0x12345678)
				.tag(5, WireType.Varint).varint(-1)
				.finish();
			assert.deepStrictEqual(readAll(input), [
				{ field: 1, wireType: WireType.Varint, varint: 150n },
				{ field: 2, wireType: WireType.Fixed64, fixed64: 0x1122334455667788n },
				{ field: 3, wireType: WireType.LengthDelimited, bytes: bytes('74 65 73 74 69 6e 67') },
				{ field: 4, wireType: WireType.Fixed32, fixed32: 0x12345678 },
				{ field: 5, wireType: WireType.Varint, varint: 2n ** 64n - 1n },
			]);
		});

		test('next returns undefined at eof and on empty input', () => {
			const reader = new ProtoReader(new Uint8Array(0));
			assert.strictEqual(reader.eof, true);
			assert.strictEqual(reader.next(), undefined);
			assert.strictEqual(reader.offset, 0);
		});

		test('length-delimited bytes are a view into the input, not a copy', () => {
			const input = bytes('0a 03 01 02 03');
			const [field] = readAll(input);
			assert.strictEqual(field.bytes!.buffer, input.buffer);
			assert.strictEqual(field.bytes!.byteOffset, 2);
			assert.strictEqual(hex(field.bytes!), '01 02 03');
		});

		test('reads from a subarray with a byte offset', () => {
			const backing = bytes('ff ff 0d 78 56 34 12 09 01 00 00 00 00 00 00 00');
			const fields = readAll(backing.subarray(2));
			assert.deepStrictEqual(fields, [
				{ field: 1, wireType: WireType.Fixed32, fixed32: 0x12345678 },
				{ field: 1, wireType: WireType.Fixed64, fixed64: 1n },
			]);
		});

		test('offset advances past each field', () => {
			const reader = new ProtoReader(bytes('08 96 01 12 02 61 62'));
			reader.next();
			assert.strictEqual(reader.offset, 3);
			reader.next();
			assert.strictEqual(reader.offset, 7);
			assert.strictEqual(reader.eof, true);
		});

		test('ten-byte varints are accepted, the eleventh byte is rejected (varint-too-long)', () => {
			const [tenBytes] = readAll(bytes('08 80 80 80 80 80 80 80 80 80 01'));
			assert.strictEqual(tenBytes.varint, 2n ** 63n);
			assertDecodeError(() => readAll(bytes('08 80 80 80 80 80 80 80 80 80 80 01')), 'varint-too-long');
			assertDecodeError(() => readAll(bytes('80 80 80 80 80 80 80 80 80 80 08')), 'varint-too-long');
		});

		test('bits above 64 in a ten-byte varint are dropped', () => {
			const [field] = readAll(bytes('08 ff ff ff ff ff ff ff ff ff 7f'));
			assert.strictEqual(field.varint, 2n ** 64n - 1n);
		});

		test('truncated varint => truncated', () => {
			assertDecodeError(() => readAll(bytes('08')), 'truncated');
			assertDecodeError(() => readAll(bytes('08 80')), 'truncated');
			assertDecodeError(() => readAll(bytes('80')), 'truncated');
		});

		test('truncated fixed32/fixed64 => truncated', () => {
			assertDecodeError(() => readAll(bytes('0d 01 02 03')), 'truncated');
			assertDecodeError(() => readAll(bytes('09 01 02 03 04 05 06 07')), 'truncated');
		});

		test('truncated length-delimited payload => truncated', () => {
			assertDecodeError(() => readAll(bytes('12 05 61 62')), 'truncated');
			assertDecodeError(() => readAll(bytes('12')), 'truncated');
			assertDecodeError(() => readAll(bytes('12 ff ff ff ff 0f')), 'truncated');
		});

		test('field number 0 => illegal-field-number', () => {
			assertDecodeError(() => readAll(bytes('00')), 'illegal-field-number');
			assertDecodeError(() => readAll(bytes('02 00')), 'illegal-field-number');
			assertDecodeError(() => readAll(bytes('08 01 00')), 'illegal-field-number');
		});

		test('field numbers above 2^29 - 1 => illegal-field-number', () => {
			assertDecodeError(() => readAll(bytes('80 80 80 80 10 00')), 'illegal-field-number');
		});

		test('wire types 6 and 7 => unknown-wire-type', () => {
			assertDecodeError(() => readAll(bytes('0e 00')), 'unknown-wire-type');
			assertDecodeError(() => readAll(bytes('0f 00')), 'unknown-wire-type');
		});

		test('a group 0B ... 0C is skipped as one unknown field carrying its raw bytes', () => {
			const input = bytes('0b 08 01 12 01 61 0c 10 02');
			const fields = readAll(input);
			assert.strictEqual(fields.length, 2);
			assert.strictEqual(fields[0].field, 1);
			assert.strictEqual(fields[0].wireType, WireType.StartGroup);
			assert.strictEqual(hex(fields[0].bytes!), '0b 08 01 12 01 61 0c');
			assert.strictEqual(fields[0].bytes!.buffer, input.buffer);
			assert.deepStrictEqual(fields[1], { field: 2, wireType: WireType.Varint, varint: 2n });
		});

		test('nested groups are skipped as a whole', () => {
			const fields = readAll(bytes('0b 13 08 01 14 0d 00 00 00 00 0c 08 05'));
			assert.strictEqual(fields.length, 2);
			assert.strictEqual(hex(fields[0].bytes!), '0b 13 08 01 14 0d 00 00 00 00 0c');
			assert.deepStrictEqual(fields[1], { field: 1, wireType: WireType.Varint, varint: 5n });
		});

		test('an empty group', () => {
			const fields = readAll(bytes('0b 0c'));
			assert.strictEqual(fields.length, 1);
			assert.strictEqual(hex(fields[0].bytes!), '0b 0c');
		});

		test('unmatched EndGroup => group-mismatch', () => {
			assertDecodeError(() => readAll(bytes('0c')), 'group-mismatch');
			assertDecodeError(() => readAll(bytes('08 01 0c')), 'group-mismatch');
		});

		test('EndGroup with a different field number => group-mismatch', () => {
			assertDecodeError(() => readAll(bytes('0b 14')), 'group-mismatch');
			assertDecodeError(() => readAll(bytes('0b 13 0c 14')), 'group-mismatch');
		});

		test('errors inside a group are reported with their own reason', () => {
			assertDecodeError(() => readAll(bytes('0b 08 01')), 'truncated');
			assertDecodeError(() => readAll(bytes('0b 00 0c')), 'illegal-field-number');
			assertDecodeError(() => readAll(bytes('0b 0e 0c')), 'unknown-wire-type');
			assertDecodeError(() => readAll(bytes('0b 12 05 61 0c')), 'truncated');
		});

		test('raw readers for packed payloads', () => {
			const reader = new ProtoReader(bytes('03 8e 02 9e a7 05 78 56 34 12 01 00 00 00 00 00 00 00 00 00 c0 3f 00 00 00 00 00 00 f8 3f'));
			assert.strictEqual(reader.varint(), 3n);
			assert.strictEqual(reader.varint(), 270n);
			assert.strictEqual(reader.varint(), 86942n);
			assert.strictEqual(reader.fixed32(), 0x12345678);
			assert.strictEqual(reader.fixed64(), 1n);
			assert.strictEqual(reader.float(), 1.5);
			assert.strictEqual(reader.double(), 1.5);
			assert.strictEqual(reader.eof, true);
			assertDecodeError(() => reader.varint(), 'truncated');
			assertDecodeError(() => reader.fixed32(), 'truncated');
			assertDecodeError(() => reader.fixed64(), 'truncated');
			assertDecodeError(() => reader.float(), 'truncated');
			assertDecodeError(() => reader.double(), 'truncated');
		});

		test('ProtoDecodeError carries the reason and a name', () => {
			try {
				readAll(bytes('00'));
				assert.fail('expected an error');
			} catch (err) {
				assert.ok(err instanceof ProtoDecodeError);
				assert.strictEqual(err.name, 'ProtoDecodeError');
				assert.strictEqual(err.reason, 'illegal-field-number');
				assert.ok(err.message.length > 0);
			}
		});
	});
});
