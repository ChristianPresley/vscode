/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Descriptors for the `google.protobuf` well-known types used by the MCP gRPC
 * surface, plus conversions between them and native JavaScript values.
 */

import { IMessageDescriptor, ProtoCodecError } from './codec.js';

//#region Descriptors

const NULL_VALUE = Object.freeze({ NULL_VALUE: 0 });

/** `google.protobuf.Struct`: `{ fields?: { [key: string]: Value } }`. */
export const STRUCT: IMessageDescriptor = {
	name: 'google.protobuf.Struct',
	fields: [
		{ name: 'fields', number: 1, kind: 'message', map: { key: 'string', value: { name: 'value', number: 2, kind: 'message', message: () => VALUE } } },
	],
};

/** `google.protobuf.Value`: exactly one of the `kind` members is present. */
export const VALUE: IMessageDescriptor = {
	name: 'google.protobuf.Value',
	fields: [
		{ name: 'null_value', number: 1, kind: 'enum', oneof: 'kind', enum: NULL_VALUE },
		{ name: 'number_value', number: 2, kind: 'double', oneof: 'kind' },
		{ name: 'string_value', number: 3, kind: 'string', oneof: 'kind' },
		{ name: 'bool_value', number: 4, kind: 'bool', oneof: 'kind' },
		{ name: 'struct_value', number: 5, kind: 'message', oneof: 'kind', message: () => STRUCT },
		{ name: 'list_value', number: 6, kind: 'message', oneof: 'kind', message: () => LIST_VALUE },
	],
};

/** `google.protobuf.ListValue`: `{ values?: Value[] }`. */
export const LIST_VALUE: IMessageDescriptor = {
	name: 'google.protobuf.ListValue',
	fields: [
		{ name: 'values', number: 1, kind: 'message', repeated: true, message: () => VALUE },
	],
};

/** `google.protobuf.Duration`: `{ seconds?: bigint, nanos?: number }`. */
export const DURATION: IMessageDescriptor = {
	name: 'google.protobuf.Duration',
	fields: [
		{ name: 'seconds', number: 1, kind: 'int64' },
		{ name: 'nanos', number: 2, kind: 'int32' },
	],
};

/** `google.protobuf.Timestamp`: `{ seconds?: bigint, nanos?: number }`. */
export const TIMESTAMP: IMessageDescriptor = {
	name: 'google.protobuf.Timestamp',
	fields: [
		{ name: 'seconds', number: 1, kind: 'int64' },
		{ name: 'nanos', number: 2, kind: 'int32' },
	],
};

/** `google.protobuf.Any`: `{ type_url?: string, value?: Uint8Array }`. */
export const ANY: IMessageDescriptor = {
	name: 'google.protobuf.Any',
	fields: [
		{ name: 'type_url', number: 1, kind: 'string' },
		{ name: 'value', number: 2, kind: 'bytes' },
	],
};

/** `google.protobuf.Empty`. */
export const EMPTY: IMessageDescriptor = {
	name: 'google.protobuf.Empty',
	fields: [],
};

//#endregion

//#region Struct / Value <-> JSON

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defineOwn(target: object, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Converts a JSON object into the decoded-message shape of {@link STRUCT}.
 * Properties holding `undefined` are skipped.
 */
export function jsonToStruct(json: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	let count = 0;
	for (const key of Object.keys(json)) {
		const value = json[key];
		if (value === undefined) {
			continue;
		}
		defineOwn(fields, key, jsonToValue(value));
		count++;
	}
	return count > 0 ? { fields } : {};
}

/** Converts a decoded {@link STRUCT} message back into a JSON object. */
export function structToJson(struct: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const fields = struct.fields;
	if (fields === undefined) {
		return result;
	}
	if (!isObject(fields)) {
		throw new ProtoCodecError('invalid-value', 'Struct.fields must be an object');
	}
	for (const key of Object.keys(fields)) {
		const value = fields[key];
		if (!isObject(value)) {
			throw new ProtoCodecError('invalid-value', `Struct field '${key}' must be a Value message`);
		}
		defineOwn(result, key, valueToJson(value));
	}
	return result;
}

/**
 * Converts a JSON value into the decoded-message shape of {@link VALUE}
 * (ProtoJSON mapping): null, booleans, numbers, strings, arrays and objects.
 */
export function jsonToValue(json: unknown): Record<string, unknown> {
	switch (typeof json) {
		case 'boolean':
			return { bool_value: json };
		case 'number':
			if (!Number.isFinite(json)) {
				throw new ProtoCodecError('invalid-value', `Value cannot hold ${json}`);
			}
			if (Number.isInteger(json) && !Number.isSafeInteger(json)) {
				throw new ProtoCodecError('invalid-value', `Integer ${json} is outside the exactly representable range of a double`);
			}
			return { number_value: json };
		case 'string':
			return { string_value: json };
		case 'object':
			if (json === null) {
				return { null_value: 0 };
			}
			if (Array.isArray(json)) {
				return { list_value: json.length > 0 ? { values: json.map(element => jsonToValue(element === undefined ? null : element)) } : {} };
			}
			return { struct_value: jsonToStruct(json as Record<string, unknown>) };
		default:
			throw new ProtoCodecError('invalid-value', `Value cannot hold a ${typeof json}`);
	}
}

/** Converts a decoded {@link VALUE} message back into a JSON value. */
export function valueToJson(value: Readonly<Record<string, unknown>>): unknown {
	if (hasOwn(value, 'null_value')) {
		return null;
	}
	if (hasOwn(value, 'number_value')) {
		const number = value.number_value;
		if (typeof number !== 'number') {
			throw new ProtoCodecError('invalid-value', 'Value.number_value must be a number');
		}
		if (!Number.isFinite(number)) {
			throw new ProtoCodecError('invalid-value', `Value.number_value ${number} cannot be represented in JSON`);
		}
		// Whole doubles are JSON integers; normalize -0 to 0 as JSON.stringify does.
		return number === 0 ? 0 : number;
	}
	if (hasOwn(value, 'string_value')) {
		const string = value.string_value;
		if (typeof string !== 'string') {
			throw new ProtoCodecError('invalid-value', 'Value.string_value must be a string');
		}
		return string;
	}
	if (hasOwn(value, 'bool_value')) {
		const bool = value.bool_value;
		if (typeof bool !== 'boolean') {
			throw new ProtoCodecError('invalid-value', 'Value.bool_value must be a boolean');
		}
		return bool;
	}
	if (hasOwn(value, 'struct_value')) {
		const struct = value.struct_value;
		if (!isObject(struct)) {
			throw new ProtoCodecError('invalid-value', 'Value.struct_value must be a Struct message');
		}
		return structToJson(struct);
	}
	if (hasOwn(value, 'list_value')) {
		const list = value.list_value;
		if (!isObject(list)) {
			throw new ProtoCodecError('invalid-value', 'Value.list_value must be a ListValue message');
		}
		const values = list.values;
		if (values === undefined) {
			return [];
		}
		if (!Array.isArray(values)) {
			throw new ProtoCodecError('invalid-value', 'ListValue.values must be an array');
		}
		return values.map(element => {
			if (!isObject(element)) {
				throw new ProtoCodecError('invalid-value', 'ListValue.values elements must be Value messages');
			}
			return valueToJson(element);
		});
	}
	// A Value with no kind set is treated as null, like an absent field.
	return null;
}

//#endregion

//#region Duration / Timestamp

const NANOS_PER_MS = 1_000_000;
const MAX_NANOS = 999_999_999;

function toSeconds(seconds: bigint | number | undefined, what: string): bigint {
	if (seconds === undefined) {
		return 0n;
	}
	if (typeof seconds === 'bigint') {
		return seconds;
	}
	if (!Number.isSafeInteger(seconds)) {
		throw new ProtoCodecError('invalid-value', `${what}.seconds must be an integer, got ${seconds}`);
	}
	return BigInt(seconds);
}

function toNanos(nanos: number | undefined, what: string): number {
	if (nanos === undefined) {
		return 0;
	}
	if (!Number.isInteger(nanos) || nanos < -MAX_NANOS || nanos > MAX_NANOS) {
		throw new ProtoCodecError('invalid-value', `${what}.nanos must be an integer within +/-${MAX_NANOS}, got ${nanos}`);
	}
	return nanos;
}

/**
 * Converts milliseconds into a `google.protobuf.Duration`. Negative durations
 * yield `seconds` and `nanos` of the same sign, as the proto requires.
 */
export function msToDuration(ms: number): { seconds: bigint; nanos: number } {
	if (!Number.isFinite(ms)) {
		throw new ProtoCodecError('invalid-value', `Duration cannot hold ${ms} ms`);
	}
	let seconds = Math.trunc(ms / 1000);
	let nanos = Math.round((ms - seconds * 1000) * NANOS_PER_MS);
	if (nanos > MAX_NANOS) {
		seconds += 1;
		nanos -= 1_000_000_000;
	} else if (nanos < -MAX_NANOS) {
		seconds -= 1;
		nanos += 1_000_000_000;
	}
	return { seconds: BigInt(seconds), nanos: nanos === 0 ? 0 : nanos };
}

/** Converts a `google.protobuf.Duration` into milliseconds. */
export function durationToMs(duration: { seconds?: bigint | number; nanos?: number }): number {
	const seconds = toSeconds(duration.seconds, 'Duration');
	const nanos = toNanos(duration.nanos, 'Duration');
	if ((seconds > 0n && nanos < 0) || (seconds < 0n && nanos > 0)) {
		throw new ProtoCodecError('invalid-value', `Duration.seconds (${seconds}) and Duration.nanos (${nanos}) must have the same sign`);
	}
	return Number(seconds) * 1000 + nanos / NANOS_PER_MS;
}

/** Converts a `Date` into a `google.protobuf.Timestamp` (`nanos` is always non-negative). */
export function dateToTimestamp(date: Date): { seconds: bigint; nanos: number } {
	const ms = date.getTime();
	if (!Number.isFinite(ms)) {
		throw new ProtoCodecError('invalid-value', 'Timestamp cannot hold an invalid Date');
	}
	const seconds = Math.floor(ms / 1000);
	const nanos = Math.round((ms - seconds * 1000) * NANOS_PER_MS);
	return { seconds: BigInt(seconds), nanos };
}

/** Converts a `google.protobuf.Timestamp` into a `Date`, truncating sub-millisecond precision. */
export function timestampToDate(ts: { seconds?: bigint | number; nanos?: number }): Date {
	const seconds = toSeconds(ts.seconds, 'Timestamp');
	const nanos = toNanos(ts.nanos, 'Timestamp');
	if (nanos < 0) {
		throw new ProtoCodecError('invalid-value', `Timestamp.nanos must not be negative, got ${nanos}`);
	}
	return new Date(Number(seconds) * 1000 + Math.floor(nanos / NANOS_PER_MS));
}

//#endregion
