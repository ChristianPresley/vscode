/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A descriptor-driven proto3 message codec on top of the wire format in
 * `wire.ts`. Messages are described with {@link IMessageDescriptor}s and are
 * represented as plain JavaScript objects:
 *
 * | proto kind                                       | JS value                              |
 * | ------------------------------------------------ | ------------------------------------- |
 * | int32, uint32, sint32, fixed32, sfixed32, enum   | number                                |
 * | float, double                                    | number                                |
 * | int64, uint64, sint64, fixed64, sfixed64         | bigint (number accepted on encode)    |
 * | bool                                             | boolean                               |
 * | string                                           | string                                |
 * | bytes                                            | Uint8Array                            |
 * | message                                          | object                                |
 * | repeated                                         | array                                 |
 * | map                                              | object keyed by the key's string form |
 *
 * Absent fields are absent properties. Unknown fields are kept, in order,
 * under {@link UNKNOWN_FIELDS} and re-emitted after the known fields.
 */

import { decodeUtf8, IProtoField, ProtoDecodeError, ProtoReader, ProtoWriter, WireType, zigzagDecode32, zigzagDecode64 } from './wire.js';

export type ScalarKind =
	| 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64'
	| 'bool' | 'enum' | 'float' | 'double'
	| 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64'
	| 'string' | 'bytes' | 'message';

export type MapKeyKind = Exclude<ScalarKind, 'float' | 'double' | 'bytes' | 'message' | 'enum'>;

export interface IFieldDescriptor {
	readonly name: string;
	readonly number: number;
	/** For map fields this should be `'message'` (map entries are messages). */
	readonly kind: ScalarKind;
	readonly repeated?: boolean;
	/** proto3 `optional`: the field is written even when it holds its default value. */
	readonly presence?: 'explicit';
	/** Name of the oneof this field belongs to. Members of a oneof have explicit presence. */
	readonly oneof?: string;
	/** For `kind: 'message'`; lazy so that descriptors may be recursive. */
	readonly message?: () => IMessageDescriptor;
	/** Marks a map field. The key is field 1 of the entry, `value` describes field 2 (`value.number` must be 2). */
	readonly map?: { readonly key: MapKeyKind; readonly value: IFieldDescriptor };
	/** Optional enum name -> number table for `kind: 'enum'`; names are accepted on encode. */
	readonly enum?: Readonly<Record<string, number>>;
	readonly deprecated?: boolean;
}

export interface IMessageDescriptor {
	readonly name: string;
	readonly fields: readonly IFieldDescriptor[];
}

export interface ICodecLimits {
	/** Maximum message nesting depth, counting the top-level message as 1 and map entries as a level. */
	readonly maxDepth: number;
	/** Maximum number of repeated and map elements in one message tree. */
	readonly maxElements: number;
}

export const DEFAULT_CODEC_LIMITS: ICodecLimits = Object.freeze({
	maxDepth: 64,
	maxElements: 262144,
});

/**
 * Key under which decoded messages carry the raw bytes of the fields that
 * their descriptor does not know about, in wire order.
 */
export const UNKNOWN_FIELDS: unique symbol = Symbol('protobuf.unknownFields');

export type ProtoCodecErrorReason = 'too-deep' | 'too-many-elements' | 'invalid-value' | 'unknown-field-kind';

export class ProtoCodecError extends Error {
	constructor(
		public readonly reason: ProtoCodecErrorReason,
		message: string,
	) {
		super(message);
		this.name = 'ProtoCodecError';
	}
}

/** A message object as produced by {@link decodeMessage}. */
export type ProtoMessage = Record<string, unknown> & { [UNKNOWN_FIELDS]?: Uint8Array };

//#region Shared helpers

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

interface ICodecContext {
	readonly limits: ICodecLimits;
	elements: number;
}

function createContext(limits: Partial<ICodecLimits> | undefined): ICodecContext {
	return { limits: { ...DEFAULT_CODEC_LIMITS, ...limits }, elements: 0 };
}

function checkDepth(name: string, depth: number, ctx: ICodecContext): void {
	if (depth > ctx.limits.maxDepth) {
		throw new ProtoCodecError('too-deep', `Message ${name} is nested deeper than ${ctx.limits.maxDepth} levels`);
	}
}

function countElements(ctx: ICodecContext, count: number): void {
	ctx.elements += count;
	if (ctx.elements > ctx.limits.maxElements) {
		throw new ProtoCodecError('too-many-elements', `Message tree holds more than ${ctx.limits.maxElements} repeated or map elements`);
	}
}

function hasOwn(obj: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/** Defines an own enumerable property, so that keys such as `__proto__` cannot alter the prototype. */
function defineOwn(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function wireTypeOf(kind: ScalarKind): WireType {
	switch (kind) {
		case 'int32': case 'int64': case 'uint32': case 'uint64': case 'sint32': case 'sint64': case 'bool': case 'enum':
			return WireType.Varint;
		case 'fixed32': case 'sfixed32': case 'float':
			return WireType.Fixed32;
		case 'fixed64': case 'sfixed64': case 'double':
			return WireType.Fixed64;
		case 'string': case 'bytes': case 'message':
			return WireType.LengthDelimited;
		default:
			throw new ProtoCodecError('unknown-field-kind', `Unknown field kind '${String(kind)}'`);
	}
}

function isPackable(kind: ScalarKind): boolean {
	return kind !== 'string' && kind !== 'bytes' && kind !== 'message';
}

function messageDescriptorOf(field: IFieldDescriptor): IMessageDescriptor {
	if (field.kind !== 'message' || !field.message) {
		throw new ProtoCodecError('unknown-field-kind', `Field ${field.name} (${field.number}) has kind '${field.kind}' but no message descriptor`);
	}
	return field.message();
}

function defaultValueOf(kind: ScalarKind): unknown {
	switch (kind) {
		case 'bool': return false;
		case 'string': return '';
		case 'bytes': return new Uint8Array(0);
		case 'message': return {};
		case 'int64': case 'uint64': case 'sint64': case 'fixed64': case 'sfixed64': return 0n;
		default: return 0;
	}
}

function isDefaultValue(kind: ScalarKind, value: unknown): boolean {
	switch (kind) {
		case 'bool': return value === false;
		case 'string': return value === '';
		case 'bytes': return value instanceof Uint8Array && value.length === 0;
		case 'message': return false;
		default: return value === 0 || value === 0n;
	}
}

interface IDescriptorIndex {
	readonly byNumber: ReadonlyMap<number, IFieldDescriptor>;
	readonly oneofs: ReadonlyMap<string, readonly IFieldDescriptor[]>;
	readonly mapKeys: ReadonlyMap<IFieldDescriptor, IFieldDescriptor>;
}

const descriptorIndexes = new WeakMap<IMessageDescriptor, IDescriptorIndex>();

function indexOf(descriptor: IMessageDescriptor): IDescriptorIndex {
	let index = descriptorIndexes.get(descriptor);
	if (!index) {
		const byNumber = new Map<number, IFieldDescriptor>();
		const oneofs = new Map<string, IFieldDescriptor[]>();
		const mapKeys = new Map<IFieldDescriptor, IFieldDescriptor>();
		for (const field of descriptor.fields) {
			byNumber.set(field.number, field);
			if (field.oneof !== undefined) {
				let members = oneofs.get(field.oneof);
				if (!members) {
					members = [];
					oneofs.set(field.oneof, members);
				}
				members.push(field);
			}
			if (field.map) {
				mapKeys.set(field, { name: 'key', number: 1, kind: field.map.key });
			}
		}
		index = { byNumber, oneofs, mapKeys };
		descriptorIndexes.set(descriptor, index);
	}
	return index;
}

//#endregion

//#region Encoding

function invalidValue(field: IFieldDescriptor, expected: string, value: unknown): ProtoCodecError {
	const actual = typeof value === 'bigint' ? `${value}n` : typeof value === 'object' ? (value === null ? 'null' : Array.isArray(value) ? 'array' : 'object') : String(value);
	return new ProtoCodecError('invalid-value', `Field ${field.name} (${field.number}) expects ${expected}, got ${actual}`);
}

function toInt32(field: IFieldDescriptor, value: unknown): number {
	if (typeof value === 'string' && field.kind === 'enum' && field.enum && hasOwn(field.enum, value)) {
		return field.enum[value];
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
		throw invalidValue(field, 'a 32-bit signed integer', value);
	}
	return value;
}

function toUint32(field: IFieldDescriptor, value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
		throw invalidValue(field, 'a 32-bit unsigned integer', value);
	}
	return value;
}

function toInt64(field: IFieldDescriptor, value: unknown): bigint {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value)) {
			throw invalidValue(field, 'a safe integer or bigint', value);
		}
		return BigInt(value);
	}
	if (typeof value !== 'bigint' || value < INT64_MIN || value > INT64_MAX) {
		throw invalidValue(field, 'a 64-bit signed integer', value);
	}
	return value;
}

function toUint64(field: IFieldDescriptor, value: unknown): bigint {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw invalidValue(field, 'a non-negative safe integer or bigint', value);
		}
		return BigInt(value);
	}
	if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) {
		throw invalidValue(field, 'a 64-bit unsigned integer', value);
	}
	return value;
}

function toFloat(field: IFieldDescriptor, value: unknown): number {
	if (typeof value !== 'number') {
		throw invalidValue(field, 'a number', value);
	}
	return value;
}

function toBool(field: IFieldDescriptor, value: unknown): boolean {
	if (typeof value !== 'boolean') {
		throw invalidValue(field, 'a boolean', value);
	}
	return value;
}

function toStringValue(field: IFieldDescriptor, value: unknown): string {
	if (typeof value !== 'string') {
		throw invalidValue(field, 'a string', value);
	}
	return value;
}

function toBytes(field: IFieldDescriptor, value: unknown): Uint8Array {
	if (!(value instanceof Uint8Array)) {
		throw invalidValue(field, 'a Uint8Array', value);
	}
	return value;
}

function toMessage(field: IFieldDescriptor, value: unknown): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw invalidValue(field, 'a message object', value);
	}
	return value;
}

/** Converts a scalar to the value the `ProtoWriter` expects for its packed kind. */
function toPackedValue(field: IFieldDescriptor, kind: ScalarKind, value: unknown): number | bigint | boolean {
	switch (kind) {
		case 'int32': case 'enum': case 'sint32': case 'sfixed32': return toInt32(field, value);
		case 'uint32': case 'fixed32': return toUint32(field, value);
		case 'int64': case 'sint64': case 'sfixed64': return toInt64(field, value);
		case 'uint64': case 'fixed64': return toUint64(field, value);
		case 'bool': return toBool(field, value);
		case 'float': case 'double': return toFloat(field, value);
		default: throw new ProtoCodecError('unknown-field-kind', `Field kind '${kind}' cannot be packed`);
	}
}

function packedKindOf(kind: ScalarKind): 'varint' | 'sint32' | 'sint64' | 'fixed32' | 'fixed64' | 'float' | 'double' | 'bool' {
	switch (kind) {
		case 'int32': case 'int64': case 'uint32': case 'uint64': case 'enum': return 'varint';
		case 'sint32': return 'sint32';
		case 'sint64': return 'sint64';
		case 'bool': return 'bool';
		case 'fixed32': case 'sfixed32': return 'fixed32';
		case 'fixed64': case 'sfixed64': return 'fixed64';
		case 'float': return 'float';
		case 'double': return 'double';
		default: throw new ProtoCodecError('unknown-field-kind', `Field kind '${kind}' cannot be packed`);
	}
}

function writeScalar(writer: ProtoWriter, field: IFieldDescriptor, kind: ScalarKind, value: unknown, depth: number, ctx: ICodecContext): void {
	const number = field.number;
	switch (kind) {
		case 'int32': case 'enum':
			writer.tag(number, WireType.Varint).varint(toInt32(field, value));
			break;
		case 'uint32':
			writer.tag(number, WireType.Varint).varint(toUint32(field, value));
			break;
		case 'sint32':
			writer.tag(number, WireType.Varint).sint32(toInt32(field, value));
			break;
		case 'int64':
			writer.tag(number, WireType.Varint).varint(toInt64(field, value));
			break;
		case 'uint64':
			writer.tag(number, WireType.Varint).varint(toUint64(field, value));
			break;
		case 'sint64':
			writer.tag(number, WireType.Varint).sint64(toInt64(field, value));
			break;
		case 'bool':
			writer.tag(number, WireType.Varint).bool(toBool(field, value));
			break;
		case 'fixed32':
			writer.tag(number, WireType.Fixed32).fixed32(toUint32(field, value));
			break;
		case 'sfixed32':
			writer.tag(number, WireType.Fixed32).fixed32(toInt32(field, value));
			break;
		case 'fixed64':
			writer.tag(number, WireType.Fixed64).fixed64(toUint64(field, value));
			break;
		case 'sfixed64':
			writer.tag(number, WireType.Fixed64).fixed64(toInt64(field, value));
			break;
		case 'float':
			writer.tag(number, WireType.Fixed32).float(toFloat(field, value));
			break;
		case 'double':
			writer.tag(number, WireType.Fixed64).double(toFloat(field, value));
			break;
		case 'string':
			writer.string(number, toStringValue(field, value));
			break;
		case 'bytes':
			writer.bytes(number, toBytes(field, value));
			break;
		case 'message': {
			const descriptor = messageDescriptorOf(field);
			const message = toMessage(field, value);
			writer.nested(number, w => writeMessage(w, descriptor, message, depth + 1, ctx));
			break;
		}
		default:
			throw new ProtoCodecError('unknown-field-kind', `Unknown field kind '${String(kind)}' on field ${field.name}`);
	}
}

/** Parses the string form of a map key back into the key's scalar value. */
function parseMapKey(field: IFieldDescriptor, kind: MapKeyKind, key: string): unknown {
	switch (kind) {
		case 'string':
			return key;
		case 'bool':
			if (key === 'true') { return true; }
			if (key === 'false') { return false; }
			throw invalidValue(field, `a map key of 'true' or 'false'`, key);
		case 'int32': case 'sint32': case 'sfixed32': case 'uint32': case 'fixed32': {
			if (!/^-?\d+$/.test(key)) {
				throw invalidValue(field, `an integer map key`, key);
			}
			const value = Number(key);
			return kind === 'uint32' || kind === 'fixed32' ? toUint32(field, value) : toInt32(field, value);
		}
		case 'int64': case 'sint64': case 'sfixed64': case 'uint64': case 'fixed64': {
			if (!/^-?\d+$/.test(key)) {
				throw invalidValue(field, `an integer map key`, key);
			}
			const value = BigInt(key);
			return kind === 'uint64' || kind === 'fixed64' ? toUint64(field, value) : toInt64(field, value);
		}
		default:
			throw new ProtoCodecError('unknown-field-kind', `Field kind '${String(kind)}' cannot be a map key`);
	}
}

function writeMap(writer: ProtoWriter, field: IFieldDescriptor, index: IDescriptorIndex, value: unknown, depth: number, ctx: ICodecContext): void {
	const map = field.map!;
	if (!isPlainObject(value)) {
		throw invalidValue(field, 'a map object', value);
	}
	const keyField = index.mapKeys.get(field)!;
	const valueField = map.value;
	const keys = Object.keys(value);
	countElements(ctx, keys.length);
	if (keys.length > 0) {
		checkDepth(`${field.name} entry`, depth + 1, ctx);
	}
	for (const key of keys) {
		const entryValue = value[key];
		if (entryValue === undefined || entryValue === null) {
			continue;
		}
		const parsedKey = parseMapKey(field, map.key, key);
		writer.nested(field.number, w => {
			writeScalar(w, keyField, keyField.kind, parsedKey, depth + 1, ctx);
			writeScalar(w, valueField, valueField.kind, entryValue, depth + 1, ctx);
		});
	}
}

function writeMessage(writer: ProtoWriter, descriptor: IMessageDescriptor, value: Readonly<Record<string, unknown>>, depth: number, ctx: ICodecContext): void {
	checkDepth(descriptor.name, depth, ctx);
	const index = indexOf(descriptor);
	for (const field of descriptor.fields) {
		const fieldValue = value[field.name];
		if (fieldValue === undefined || fieldValue === null) {
			continue;
		}
		if (field.map) {
			writeMap(writer, field, index, fieldValue, depth, ctx);
		} else if (field.repeated) {
			if (!Array.isArray(fieldValue)) {
				throw invalidValue(field, 'an array', fieldValue);
			}
			countElements(ctx, fieldValue.length);
			if (fieldValue.length === 0) {
				continue;
			}
			if (isPackable(field.kind)) {
				const packedKind = packedKindOf(field.kind);
				const values = fieldValue.map(element => toPackedValue(field, field.kind, element));
				writer.packed(field.number, packedKind, values);
			} else {
				for (const element of fieldValue) {
					writeScalar(writer, field, field.kind, element, depth, ctx);
				}
			}
		} else {
			const explicit = field.presence === 'explicit' || field.oneof !== undefined || field.kind === 'message';
			if (!explicit && isDefaultValue(field.kind, fieldValue)) {
				continue;
			}
			writeScalar(writer, field, field.kind, fieldValue, depth, ctx);
		}
	}
	const unknown = (value as ProtoMessage)[UNKNOWN_FIELDS];
	if (unknown instanceof Uint8Array && unknown.length > 0) {
		writer.raw(unknown);
	}
}

/**
 * Encodes `value` according to `descriptor`.
 *
 * Implicit-presence scalars holding their default value are omitted;
 * `presence: 'explicit'` fields and oneof members are written whenever the
 * property is present. Repeated packable scalars are written packed.
 */
export function encodeMessage(descriptor: IMessageDescriptor, value: Readonly<Record<string, unknown>>, limits?: Partial<ICodecLimits>): Uint8Array {
	const ctx = createContext(limits);
	const writer = new ProtoWriter();
	writeMessage(writer, descriptor, value, 1, ctx);
	return writer.finish();
}

//#endregion

//#region Decoding

const scratch = new DataView(new ArrayBuffer(8));

function fixed32ToFloat(bits: number): number {
	scratch.setUint32(0, bits, true);
	return scratch.getFloat32(0, true);
}

function fixed64ToDouble(bits: bigint): number {
	scratch.setBigUint64(0, bits, true);
	return scratch.getFloat64(0, true);
}

function varintToScalar(kind: ScalarKind, value: bigint): unknown {
	switch (kind) {
		case 'int32': case 'enum': return Number(BigInt.asIntN(32, value));
		case 'uint32': return Number(BigInt.asUintN(32, value));
		case 'sint32': return zigzagDecode32(Number(BigInt.asUintN(32, value)));
		case 'int64': return BigInt.asIntN(64, value);
		case 'uint64': return value;
		case 'sint64': return zigzagDecode64(value);
		case 'bool': return value !== 0n;
		default: throw new ProtoCodecError('unknown-field-kind', `Field kind '${kind}' is not varint-encoded`);
	}
}

function fixed32ToScalar(kind: ScalarKind, value: number): unknown {
	switch (kind) {
		case 'fixed32': return value;
		case 'sfixed32': return value | 0;
		case 'float': return fixed32ToFloat(value);
		default: throw new ProtoCodecError('unknown-field-kind', `Field kind '${kind}' is not fixed32-encoded`);
	}
}

function fixed64ToScalar(kind: ScalarKind, value: bigint): unknown {
	switch (kind) {
		case 'fixed64': return value;
		case 'sfixed64': return BigInt.asIntN(64, value);
		case 'double': return fixed64ToDouble(value);
		default: throw new ProtoCodecError('unknown-field-kind', `Field kind '${kind}' is not fixed64-encoded`);
	}
}

/** Converts a wire field whose wire type already matches `kind` into a scalar JS value. */
function readScalar(kind: ScalarKind, field: IProtoField): unknown {
	switch (field.wireType) {
		case WireType.Varint: return varintToScalar(kind, field.varint!);
		case WireType.Fixed32: return fixed32ToScalar(kind, field.fixed32!);
		case WireType.Fixed64: return fixed64ToScalar(kind, field.fixed64!);
		default:
			return kind === 'string' ? decodeUtf8(field.bytes!) : field.bytes!.slice();
	}
}

function readPacked(kind: ScalarKind, payload: Uint8Array, ctx: ICodecContext): unknown[] {
	const wireType = wireTypeOf(kind);
	// A packed run of fixed-width values holds a whole number of them: a
	// remainder is a bad length, not input that ends too early.
	const width = wireType === WireType.Fixed32 ? 4 : wireType === WireType.Fixed64 ? 8 : 0;
	if (width > 0 && payload.length % width !== 0) {
		throw new ProtoDecodeError('malformed', `Packed ${kind} payload of ${payload.length} bytes is not a multiple of ${width} bytes`);
	}
	const reader = new ProtoReader(payload);
	const values: unknown[] = [];
	while (!reader.eof) {
		countElements(ctx, 1);
		switch (wireType) {
			case WireType.Varint: values.push(varintToScalar(kind, reader.varint())); break;
			case WireType.Fixed32: values.push(fixed32ToScalar(kind, reader.fixed32())); break;
			default: values.push(fixed64ToScalar(kind, reader.fixed64())); break;
		}
	}
	return values;
}

function mapKeyToString(kind: MapKeyKind, key: unknown): string {
	switch (typeof key) {
		case 'string': return key;
		case 'boolean': return key ? 'true' : 'false';
		case 'bigint': return key.toString();
		case 'number': return String(key);
		default: throw new ProtoCodecError('unknown-field-kind', `Map key kind '${kind}' produced an unexpected value`);
	}
}

function readMapEntry(field: IFieldDescriptor, index: IDescriptorIndex, entry: Uint8Array, target: ProtoMessage, depth: number, ctx: ICodecContext): void {
	const map = field.map!;
	const keyField = index.mapKeys.get(field)!;
	const valueField = map.value;
	checkDepth(`${field.name} entry`, depth + 1, ctx);
	const keyWireType = wireTypeOf(keyField.kind);
	const valueWireType = wireTypeOf(valueField.kind);
	const reader = new ProtoReader(entry);
	let key: unknown = undefined;
	let value: unknown = undefined;
	while (!reader.eof) {
		const wireField = reader.next()!;
		if (wireField.field === 1 && wireField.wireType === keyWireType) {
			key = readScalar(keyField.kind, wireField);
		} else if (wireField.field === 2 && wireField.wireType === valueWireType) {
			if (valueField.kind === 'message') {
				const descriptor = messageDescriptorOf(valueField);
				value = readMessage(descriptor, wireField.bytes!, isPlainObject(value) ? value : {}, depth + 2, ctx);
			} else {
				value = readScalar(valueField.kind, wireField);
			}
		}
		// Other fields of a map entry are dropped, as protobuf does.
	}
	if (key === undefined) {
		key = defaultValueOf(keyField.kind);
	}
	if (value === undefined) {
		value = defaultValueOf(valueField.kind);
	}
	countElements(ctx, 1);
	const existing = target[field.name];
	const mapObject = isPlainObject(existing) ? existing : {};
	if (mapObject !== existing) {
		target[field.name] = mapObject;
	}
	defineOwn(mapObject, mapKeyToString(map.key, key), value);
}

function clearOneofSiblings(index: IDescriptorIndex, field: IFieldDescriptor, target: ProtoMessage): void {
	const members = index.oneofs.get(field.oneof!);
	if (!members) {
		return;
	}
	for (const member of members) {
		if (member !== field && hasOwn(target, member.name)) {
			delete target[member.name];
		}
	}
}

/** Returns false when the wire type does not fit the field, so the caller keeps it as unknown. */
function readField(field: IFieldDescriptor, index: IDescriptorIndex, wireField: IProtoField, target: ProtoMessage, depth: number, ctx: ICodecContext): boolean {
	if (field.map) {
		if (wireField.wireType !== WireType.LengthDelimited) {
			return false;
		}
		readMapEntry(field, index, wireField.bytes!, target, depth, ctx);
		return true;
	}

	const expectedWireType = wireTypeOf(field.kind);

	if (field.repeated) {
		let values: unknown[];
		if (wireField.wireType === WireType.LengthDelimited && expectedWireType !== WireType.LengthDelimited) {
			values = readPacked(field.kind, wireField.bytes!, ctx);
		} else if (wireField.wireType !== expectedWireType) {
			return false;
		} else {
			countElements(ctx, 1);
			values = [field.kind === 'message'
				? readMessage(messageDescriptorOf(field), wireField.bytes!, {}, depth + 1, ctx)
				: readScalar(field.kind, wireField)];
		}
		const existing = target[field.name];
		if (Array.isArray(existing)) {
			for (const value of values) {
				existing.push(value);
			}
		} else {
			target[field.name] = values;
		}
		return true;
	}

	if (wireField.wireType !== expectedWireType) {
		return false;
	}
	if (field.oneof !== undefined) {
		clearOneofSiblings(index, field, target);
	}
	if (field.kind === 'message') {
		const descriptor = messageDescriptorOf(field);
		const existing = target[field.name];
		if (isPlainObject(existing)) {
			readMessage(descriptor, wireField.bytes!, existing, depth + 1, ctx);
		} else {
			target[field.name] = readMessage(descriptor, wireField.bytes!, {}, depth + 1, ctx);
		}
	} else {
		target[field.name] = readScalar(field.kind, wireField);
	}
	return true;
}

function concatUnknown(existing: Uint8Array | undefined, chunks: readonly Uint8Array[]): Uint8Array {
	let length = existing ? existing.length : 0;
	for (const chunk of chunks) {
		length += chunk.length;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	if (existing) {
		result.set(existing, 0);
		offset = existing.length;
	}
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function readMessage(descriptor: IMessageDescriptor, bytes: Uint8Array, target: ProtoMessage, depth: number, ctx: ICodecContext): ProtoMessage {
	checkDepth(descriptor.name, depth, ctx);
	const index = indexOf(descriptor);
	const reader = new ProtoReader(bytes);
	let unknown: Uint8Array[] | undefined;
	while (!reader.eof) {
		const start = reader.offset;
		const wireField = reader.next()!;
		const field = index.byNumber.get(wireField.field);
		if (!field || !readField(field, index, wireField, target, depth, ctx)) {
			(unknown ??= []).push(bytes.subarray(start, reader.offset));
		}
	}
	if (unknown) {
		target[UNKNOWN_FIELDS] = concatUnknown(target[UNKNOWN_FIELDS], unknown);
	}
	return target;
}

/**
 * Decodes `bytes` according to `descriptor`.
 *
 * Absent fields stay absent (no proto3 defaults are filled in); repeated and
 * map fields are only present when at least one element was on the wire.
 * Repeated occurrences of an embedded message are merged, a later oneof member
 * replaces an earlier one and unknown fields are kept under
 * {@link UNKNOWN_FIELDS}.
 */
export function decodeMessage<T extends Record<string, unknown> = Record<string, unknown>>(descriptor: IMessageDescriptor, bytes: Uint8Array, limits?: Partial<ICodecLimits>): T {
	const ctx = createContext(limits);
	return readMessage(descriptor, bytes, {}, 1, ctx) as T;
}

//#endregion
