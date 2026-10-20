/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { formatGrpcTimeout, parseGrpcTimeout } from '../../../common/grpc/timeout.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';

suite('gRPC timeout header', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formatGrpcTimeout uses the coarsest exact unit', () => {
		assert.strictEqual(formatGrpcTimeout(30000), '30S');
		assert.strictEqual(formatGrpcTimeout(50), '50m');
		assert.strictEqual(formatGrpcTimeout(1500), '1500m');
		assert.strictEqual(formatGrpcTimeout(60_000), '1M');
		assert.strictEqual(formatGrpcTimeout(90_000), '90S');
		assert.strictEqual(formatGrpcTimeout(3_600_000), '1H');
		assert.strictEqual(formatGrpcTimeout(1), '1m');
	});

	test('formatGrpcTimeout rounds up to the next millisecond', () => {
		assert.strictEqual(formatGrpcTimeout(0.2), '1m');
		assert.strictEqual(formatGrpcTimeout(1499.001), '1500m');
		assert.strictEqual(formatGrpcTimeout(123456.789), '123457m');
	});

	test('formatGrpcTimeout falls back to a coarser unit when the value exceeds 8 digits', () => {
		assert.strictEqual(formatGrpcTimeout(99_999_999), '99999999m');
		assert.strictEqual(formatGrpcTimeout(100_000_000), '100000S');
		assert.strictEqual(formatGrpcTimeout(123456789.123), '123457S');
		assert.strictEqual(formatGrpcTimeout(99_999_999_001), '1666667M');
	});

	test('formatGrpcTimeout saturates', () => {
		assert.strictEqual(formatGrpcTimeout(Number.MAX_SAFE_INTEGER), '99999999H');
		assert.strictEqual(formatGrpcTimeout(Number.POSITIVE_INFINITY), '99999999H');
		assert.strictEqual(formatGrpcTimeout(99_999_999 * 3_600_000), '99999999H');
	});

	test('formatGrpcTimeout handles non-positive values', () => {
		assert.strictEqual(formatGrpcTimeout(0), '0S');
		assert.strictEqual(formatGrpcTimeout(-5), '0S');
		assert.strictEqual(formatGrpcTimeout(Number.NaN), '0S');
	});

	test('parseGrpcTimeout parses each unit', () => {
		assert.strictEqual(parseGrpcTimeout('2H'), 7_200_000);
		assert.strictEqual(parseGrpcTimeout('3M'), 180_000);
		assert.strictEqual(parseGrpcTimeout('30S'), 30_000);
		assert.strictEqual(parseGrpcTimeout('1500m'), 1500);
		assert.strictEqual(parseGrpcTimeout('2000u'), 2);
		assert.strictEqual(parseGrpcTimeout('3000000n'), 3);
		assert.strictEqual(parseGrpcTimeout('0S'), 0);
		assert.strictEqual(parseGrpcTimeout('99999999S'), 99_999_999_000);
	});

	test('parseGrpcTimeout rounds sub-millisecond values up', () => {
		assert.strictEqual(parseGrpcTimeout('1u'), 1);
		assert.strictEqual(parseGrpcTimeout('1n'), 1);
		assert.strictEqual(parseGrpcTimeout('1500u'), 2);
	});

	test('parseGrpcTimeout rejects malformed values', () => {
		for (const text of ['', 'm', '123456789S', '10x', '10', '-1S', '1.5S', ' 1S', '1S ', '1s', '1 S']) {
			assert.throws(() => parseGrpcTimeout(text), JSON.stringify(text));
		}
	});

	test('round trip', () => {
		for (const ms of [1, 50, 1500, 30000, 60_000, 3_600_000, 99_999_999]) {
			assert.strictEqual(parseGrpcTimeout(formatGrpcTimeout(ms)), ms);
		}
	});
});
