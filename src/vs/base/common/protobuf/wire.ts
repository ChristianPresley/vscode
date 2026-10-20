/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A dependency-free implementation of the protobuf wire format
 * (https://protobuf.dev/programming-guides/encoding/).
 *
 * This module only deals with the byte level: tags, varints, fixed-width
 * values and length-delimited payloads. Mapping those onto typed fields is the
 * job of `codec.ts`.
 */

export const enum WireType {
	Varint = 0,
	Fixed64 = 1,
	LengthDelimited = 2,
	StartGroup = 3,
	EndGroup = 4,
	Fixed32 = 5,
}

export type ProtoDecodeErrorReason =
	| 'truncated'
	| 'malformed'
	| 'varint-too-long'
	| 'unknown-wire-type'
	| 'illegal-field-number'
	| 'group-mismatch'
	| 'invalid-utf8';

export class ProtoDecodeError extends Error {
	constructor(
		public readonly reason: ProtoDecodeErrorReason,
		message: string,
	) {
		super(message);
		this.name = 'ProtoDecodeError';
	}
}

/** Largest legal field number (2^29 - 1). */
const MAX_FIELD_NUMBER = 536870911;
/** Varints are at most ten bytes long on the wire. */
const MAX_VARINT_BYTES = 10;

const TWO_POW_32 = 4294967296;
const UINT64_MASK = (1n << 64n) - 1n;

//#region UTF-8

let utf8Encoder: TextEncoder | undefined;
let utf8Decoder: TextDecoder | undefined;

/** Encodes a string as UTF-8. */
export function encodeUtf8(value: string): Uint8Array {
	utf8Encoder ??= new TextEncoder();
	return utf8Encoder.encode(value);
}

/**
 * Decodes UTF-8 bytes into a string. Throws a {@link ProtoDecodeError} with
 * reason `invalid-utf8` on an invalid byte sequence. A leading byte-order mark
 * is kept as part of the string (protobuf strings are opaque).
 */
export function decodeUtf8(bytes: Uint8Array): string {
	utf8Decoder ??= new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	try {
		return utf8Decoder.decode(bytes);
	} catch {
		throw new ProtoDecodeError('invalid-utf8', 'Invalid UTF-8 sequence in string field');
	}
}

//#endregion

//#region Varint helpers

/** Returns the number of bytes needed to encode `v` as an (unsigned) varint. */
export function varintLength(v: number | bigint): number {
	if (typeof v === 'number' && v >= 0 && v <= Number.MAX_SAFE_INTEGER) {
		let length = 1;
		while (v >= 0x80) {
			v = Math.floor(v / 0x80);
			length++;
		}
		return length;
	}
	let b = BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(v));
	let length = 1;
	while (b > 0x7Fn) {
		b >>= 7n;
		length++;
	}
	return length;
}

export function zigzagEncode32(v: number): number {
	return ((v << 1) ^ (v >> 31)) >>> 0;
}

export function zigzagDecode32(v: number): number {
	return (v >>> 1) ^ -(v & 1);
}

export function zigzagEncode64(v: bigint): bigint {
	return BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));
}

export function zigzagDecode64(v: bigint): bigint {
	return BigInt.asIntN(64, (v >> 1n) ^ -(v & 1n));
}

//#endregion

//#region Writer

export class ProtoWriter {

	private _buffer: Uint8Array;
	private _view: DataView;
	private _length = 0;

	constructor(initialCapacity = 256) {
		this._buffer = new Uint8Array(Math.max(16, initialCapacity));
		this._view = new DataView(this._buffer.buffer);
	}

	private _ensure(extra: number): void {
		const required = this._length + extra;
		if (required <= this._buffer.length) {
			return;
		}
		let capacity = this._buffer.length * 2;
		while (capacity < required) {
			capacity *= 2;
		}
		const next = new Uint8Array(capacity);
		next.set(this._buffer.subarray(0, this._length));
		this._buffer = next;
		this._view = new DataView(next.buffer);
	}

	private _writeVarintAt(offset: number, v: number): number {
		while (v >= 0x80) {
			this._buffer[offset++] = (v % 0x80) | 0x80;
			v = Math.floor(v / 0x80);
		}
		this._buffer[offset++] = v;
		return offset;
	}

	/**
	 * Writes a varint. Negative numbers/bigints are written as their 64-bit
	 * two's complement (ten bytes), matching `int32`/`int64` semantics.
	 */
	varint(v: number | bigint): this {
		this._ensure(MAX_VARINT_BYTES);
		if (typeof v === 'number' && v >= 0 && v <= Number.MAX_SAFE_INTEGER && Number.isInteger(v)) {
			if (v < TWO_POW_32) {
				let n = v >>> 0;
				while (n >= 0x80) {
					this._buffer[this._length++] = (n & 0x7F) | 0x80;
					n >>>= 7;
				}
				this._buffer[this._length++] = n;
			} else {
				this._length = this._writeVarintAt(this._length, v);
			}
			return this;
		}
		let b = BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(v));
		while (b > 0x7Fn) {
			this._buffer[this._length++] = Number(b & 0x7Fn) | 0x80;
			b >>= 7n;
		}
		this._buffer[this._length++] = Number(b);
		return this;
	}

	sint32(v: number): this {
		return this.varint(zigzagEncode32(v));
	}

	sint64(v: bigint | number): this {
		return this.varint(zigzagEncode64(typeof v === 'bigint' ? v : BigInt(v)));
	}

	fixed32(v: number): this {
		this._ensure(4);
		this._view.setUint32(this._length, v >>> 0, true);
		this._length += 4;
		return this;
	}

	fixed64(v: bigint | number): this {
		this._ensure(8);
		this._view.setBigUint64(this._length, BigInt.asUintN(64, typeof v === 'bigint' ? v : BigInt(v)), true);
		this._length += 8;
		return this;
	}

	float(v: number): this {
		this._ensure(4);
		this._view.setFloat32(this._length, v, true);
		this._length += 4;
		return this;
	}

	double(v: number): this {
		this._ensure(8);
		this._view.setFloat64(this._length, v, true);
		this._length += 8;
		return this;
	}

	bool(v: boolean): this {
		this._ensure(1);
		this._buffer[this._length++] = v ? 1 : 0;
		return this;
	}

	tag(field: number, wireType: WireType): this {
		if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD_NUMBER) {
			throw new RangeError(`Illegal protobuf field number ${field}`);
		}
		return this.varint(field * 8 + wireType);
	}

	bytes(field: number, value: Uint8Array): this {
		this.tag(field, WireType.LengthDelimited);
		this.varint(value.length);
		return this.raw(value);
	}

	string(field: number, value: string): this {
		return this.bytes(field, encodeUtf8(value));
	}

	packed(field: number, kind: 'varint' | 'sint32' | 'sint64' | 'fixed32' | 'fixed64' | 'float' | 'double' | 'bool', values: readonly (number | bigint | boolean)[]): this {
		return this._lengthDelimited(field, () => {
			for (const value of values) {
				switch (kind) {
					case 'varint': this.varint(value as number | bigint); break;
					case 'sint32': this.sint32(value as number); break;
					case 'sint64': this.sint64(value as number | bigint); break;
					case 'fixed32': this.fixed32(value as number); break;
					case 'fixed64': this.fixed64(value as number | bigint); break;
					case 'float': this.float(value as number); break;
					case 'double': this.double(value as number); break;
					case 'bool': this.bool(value as boolean); break;
				}
			}
		});
	}

	/** Writes a length-delimited embedded message produced by `write`. */
	nested(field: number, write: (writer: ProtoWriter) => void): this {
		return this._lengthDelimited(field, () => write(this));
	}

	/**
	 * Writes a tag, reserves one byte for the length, runs `write` and then
	 * patches the length in, shifting the payload when the length needs more
	 * than one byte. This avoids copying nested payloads once per level.
	 */
	private _lengthDelimited(field: number, write: () => void): this {
		this.tag(field, WireType.LengthDelimited);
		const lengthOffset = this._length;
		this._ensure(1);
		this._length++;
		const start = this._length;
		write();
		const size = this._length - start;
		const lengthBytes = varintLength(size);
		if (lengthBytes > 1) {
			this._ensure(lengthBytes - 1);
			this._buffer.copyWithin(start + lengthBytes - 1, start, this._length);
			this._length += lengthBytes - 1;
		}
		this._writeVarintAt(lengthOffset, size);
		return this;
	}

	raw(bytes: Uint8Array): this {
		this._ensure(bytes.length);
		this._buffer.set(bytes, this._length);
		this._length += bytes.length;
		return this;
	}

	/** Returns a copy of everything written so far. */
	finish(): Uint8Array {
		return this._buffer.slice(0, this._length);
	}
}

//#endregion

//#region Reader

export interface IProtoField {
	readonly field: number;
	readonly wireType: WireType;
	/** Set for {@link WireType.Varint}; the raw unsigned 64-bit value. */
	readonly varint?: bigint;
	/** Set for {@link WireType.Fixed32}; the raw unsigned 32-bit value. */
	readonly fixed32?: number;
	/** Set for {@link WireType.Fixed64}; the raw unsigned 64-bit value. */
	readonly fixed64?: bigint;
	/**
	 * Set for {@link WireType.LengthDelimited} (the payload, a view into the
	 * input) and for {@link WireType.StartGroup} (the whole group from its start
	 * tag through its matching end tag, so that `ProtoWriter.raw` re-emits it).
	 */
	readonly bytes?: Uint8Array;
}

export class ProtoReader {

	private readonly _bytes: Uint8Array;
	private readonly _view: DataView;
	private _offset = 0;

	constructor(bytes: Uint8Array) {
		this._bytes = bytes;
		this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	get eof(): boolean {
		return this._offset >= this._bytes.length;
	}

	/** The current read position, in bytes from the start of the input. */
	get offset(): number {
		return this._offset;
	}

	/**
	 * Reads the next field. Groups are consumed as a whole (including nested
	 * groups) and returned as a single {@link WireType.StartGroup} field.
	 */
	next(): IProtoField | undefined {
		if (this.eof) {
			return undefined;
		}
		const start = this._offset;
		const tag = this._readTag();
		const field = tag.field;
		const wireType = tag.wireType;
		switch (wireType) {
			case WireType.Varint:
				return { field, wireType, varint: this.varint() };
			case WireType.Fixed64:
				return { field, wireType, fixed64: this.fixed64() };
			case WireType.LengthDelimited:
				return { field, wireType, bytes: this.bytes() };
			case WireType.Fixed32:
				return { field, wireType, fixed32: this.fixed32() };
			case WireType.StartGroup:
				this._skipGroup(field);
				return { field, wireType, bytes: this._bytes.subarray(start, this._offset) };
			case WireType.EndGroup:
				throw new ProtoDecodeError('group-mismatch', `Unexpected end-group tag for field ${field} at offset ${start}`);
			default:
				throw new ProtoDecodeError('unknown-wire-type', `Unknown wire type ${wireType} for field ${field} at offset ${start}`);
		}
	}

	/** Reads a raw varint at the current position (used for packed fields). */
	varint(): bigint {
		const bytes = this._bytes;
		const end = bytes.length;
		let offset = this._offset;
		// The first seven bytes (49 bits) fit a double exactly; only longer
		// varints need bigint arithmetic.
		let lo = 0;
		let multiplier = 1;
		let i = 0;
		for (; i < 7; i++) {
			if (offset >= end) {
				throw this._truncated('varint');
			}
			const b = bytes[offset++];
			lo += (b & 0x7F) * multiplier;
			if (b < 0x80) {
				this._offset = offset;
				return BigInt(lo);
			}
			multiplier *= 0x80;
		}
		let value = BigInt(lo);
		let shift = 49n;
		for (; i < MAX_VARINT_BYTES; i++) {
			if (offset >= end) {
				throw this._truncated('varint');
			}
			const b = bytes[offset++];
			value |= BigInt(b & 0x7F) << shift;
			if (b < 0x80) {
				this._offset = offset;
				return value & UINT64_MASK;
			}
			shift += 7n;
		}
		throw new ProtoDecodeError('varint-too-long', `Varint at offset ${this._offset} is longer than ${MAX_VARINT_BYTES} bytes`);
	}

	/** Reads a raw little-endian fixed32 at the current position. */
	fixed32(): number {
		if (this._offset + 4 > this._bytes.length) {
			throw this._truncated('fixed32');
		}
		const value = this._view.getUint32(this._offset, true);
		this._offset += 4;
		return value;
	}

	/** Reads a raw little-endian fixed64 at the current position. */
	fixed64(): bigint {
		if (this._offset + 8 > this._bytes.length) {
			throw this._truncated('fixed64');
		}
		const value = this._view.getBigUint64(this._offset, true);
		this._offset += 8;
		return value;
	}

	/** Reads a raw little-endian IEEE 754 single at the current position. */
	float(): number {
		if (this._offset + 4 > this._bytes.length) {
			throw this._truncated('float');
		}
		const value = this._view.getFloat32(this._offset, true);
		this._offset += 4;
		return value;
	}

	/** Reads a raw little-endian IEEE 754 double at the current position. */
	double(): number {
		if (this._offset + 8 > this._bytes.length) {
			throw this._truncated('double');
		}
		const value = this._view.getFloat64(this._offset, true);
		this._offset += 8;
		return value;
	}

	/** Reads a length-prefixed payload at the current position (a view, not a copy). */
	bytes(): Uint8Array {
		const length = this._readVarintNumber();
		if (this._offset + length > this._bytes.length) {
			throw this._truncated(`length-delimited payload of ${length} bytes`);
		}
		const value = this._bytes.subarray(this._offset, this._offset + length);
		this._offset += length;
		return value;
	}

	private _truncated(what: string): ProtoDecodeError {
		return new ProtoDecodeError('truncated', `Truncated ${what} at offset ${this._offset} (input is ${this._bytes.length} bytes)`);
	}

	/**
	 * Reads a varint as a number. Only used for tags and lengths, which are
	 * always far below 2^53 when valid.
	 */
	private _readVarintNumber(): number {
		const bytes = this._bytes;
		const end = bytes.length;
		let value = 0;
		let multiplier = 1;
		for (let i = 0; i < MAX_VARINT_BYTES; i++) {
			if (this._offset >= end) {
				throw this._truncated('varint');
			}
			const b = bytes[this._offset++];
			value += (b & 0x7F) * multiplier;
			if (b < 0x80) {
				return value;
			}
			multiplier *= 0x80;
		}
		throw new ProtoDecodeError('varint-too-long', `Varint at offset ${this._offset} is longer than ${MAX_VARINT_BYTES} bytes`);
	}

	private _readTag(): { field: number; wireType: number } {
		const start = this._offset;
		const tag = this._readVarintNumber();
		const field = Math.floor(tag / 8);
		if (field < 1 || field > MAX_FIELD_NUMBER) {
			throw new ProtoDecodeError('illegal-field-number', `Illegal field number ${field} at offset ${start}`);
		}
		return { field, wireType: tag % 8 };
	}

	/** Skips to just past the end-group tag matching the start-group tag already read for `field`. */
	private _skipGroup(field: number): void {
		const stack: number[] = [field];
		while (stack.length > 0) {
			if (this.eof) {
				throw this._truncated(`group for field ${stack[stack.length - 1]}`);
			}
			const start = this._offset;
			const tag = this._readTag();
			switch (tag.wireType) {
				case WireType.Varint:
					this.varint();
					break;
				case WireType.Fixed64:
					this.fixed64();
					break;
				case WireType.LengthDelimited:
					this.bytes();
					break;
				case WireType.Fixed32:
					this.fixed32();
					break;
				case WireType.StartGroup:
					stack.push(tag.field);
					break;
				case WireType.EndGroup:
					if (stack[stack.length - 1] !== tag.field) {
						throw new ProtoDecodeError('group-mismatch', `End-group tag for field ${tag.field} at offset ${start} does not match open group for field ${stack[stack.length - 1]}`);
					}
					stack.pop();
					break;
				default:
					throw new ProtoDecodeError('unknown-wire-type', `Unknown wire type ${tag.wireType} for field ${tag.field} at offset ${start}`);
			}
		}
	}
}

//#endregion
