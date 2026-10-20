/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `grpc-timeout` header: 1-8 ASCII digits followed by a unit, where the
 * unit is one of `H` (hours), `M` (minutes), `S` (seconds), `m` (milliseconds),
 * `u` (microseconds) or `n` (nanoseconds).
 */

const MAX_TIMEOUT_VALUE = 99_999_999;

interface ITimeoutUnit {
	readonly unit: string;
	readonly ms: number;
}

/** Units this encoder emits, finest first. */
const encodeUnits: readonly ITimeoutUnit[] = [
	{ unit: 'm', ms: 1 },
	{ unit: 'S', ms: 1_000 },
	{ unit: 'M', ms: 60_000 },
	{ unit: 'H', ms: 3_600_000 },
];

const parseUnits: ReadonlyMap<string, number> = new Map<string, number>([
	['H', 3_600_000],
	['M', 60_000],
	['S', 1_000],
	['m', 1],
	['u', 1 / 1_000],
	['n', 1 / 1_000_000],
]);

/**
 * Formats a duration in milliseconds as a `grpc-timeout` value. The value is
 * rounded up to whole milliseconds and expressed in the coarsest unit that
 * represents it exactly; when that needs more than 8 digits the next coarser
 * unit is used (rounding up), saturating at `99999999H`. Non-positive values
 * yield `0S`.
 */
export function formatGrpcTimeout(ms: number): string {
	if (!(ms > 0)) {
		return '0S';
	}
	const value = Math.ceil(ms);
	let index = 0;
	for (let i = encodeUnits.length - 1; i > 0; i--) {
		if (value % encodeUnits[i].ms === 0) {
			index = i;
			break;
		}
	}
	let scaled = value / encodeUnits[index].ms;
	while (scaled > MAX_TIMEOUT_VALUE && index < encodeUnits.length - 1) {
		index++;
		scaled = Math.ceil(value / encodeUnits[index].ms);
	}
	if (scaled > MAX_TIMEOUT_VALUE) {
		return `${MAX_TIMEOUT_VALUE}H`;
	}
	return `${scaled}${encodeUnits[index].unit}`;
}

/**
 * Parses a `grpc-timeout` value into milliseconds. Sub-millisecond values
 * round up to the next millisecond. Throws on malformed input.
 */
export function parseGrpcTimeout(text: string): number {
	const match = /^(\d{1,8})([HMSmun])$/.exec(text);
	if (!match) {
		throw new Error(`Invalid grpc-timeout value: '${text}'`);
	}
	const factor = parseUnits.get(match[2]);
	if (factor === undefined) {
		throw new Error(`Invalid grpc-timeout unit: '${match[2]}'`);
	}
	return Math.ceil(Number(match[1]) * factor);
}
