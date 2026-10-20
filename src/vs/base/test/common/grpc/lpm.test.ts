/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { GrpcFramingError, LengthPrefixedMessageReader, encodeLengthPrefixedMessage } from '../../../common/grpc/lpm.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';

suite('gRPC length-prefixed messages', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function bytes(...values: number[]): Uint8Array {
		return Uint8Array.from(values);
	}

	function concat(...parts: Uint8Array[]): Uint8Array {
		const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.byteLength;
		}
		return out;
	}

	function assertReason(fn: () => void, reason: GrpcFramingError['reason']) {
		assert.throws(fn, (error: unknown) => error instanceof GrpcFramingError && error.reason === reason);
	}

	test('encodes a 5-byte prefix with the compressed flag and big-endian length', () => {
		const framed = encodeLengthPrefixedMessage(bytes(1, 2, 3));
		assert.deepStrictEqual(Array.from(framed), [0, 0, 0, 0, 3, 1, 2, 3]);

		const empty = encodeLengthPrefixedMessage(new Uint8Array(0));
		assert.deepStrictEqual(Array.from(empty), [0, 0, 0, 0, 0]);

		const large = encodeLengthPrefixedMessage(new Uint8Array(0x01020304));
		assert.deepStrictEqual(Array.from(large.subarray(0, 5)), [0, 1, 2, 3, 4]);
	});

	test('decodes a message delivered in one chunk', () => {
		const reader = new LengthPrefixedMessageReader();
		const messages = reader.feed(encodeLengthPrefixedMessage(bytes(9, 8, 7)));
		assert.strictEqual(messages.length, 1);
		assert.deepStrictEqual(Array.from(messages[0]), [9, 8, 7]);
		reader.end();
	});

	test('decodes a message whose prefix and body are split across chunks', () => {
		const reader = new LengthPrefixedMessageReader();
		const framed = encodeLengthPrefixedMessage(bytes(10, 20, 30, 40));

		assert.deepStrictEqual(reader.feed(framed.subarray(0, 2)), []);
		assert.deepStrictEqual(reader.feed(framed.subarray(2, 6)), []);
		const messages = reader.feed(framed.subarray(6));
		assert.strictEqual(messages.length, 1);
		assert.deepStrictEqual(Array.from(messages[0]), [10, 20, 30, 40]);
		reader.end();
	});

	test('decodes two messages delivered in one chunk', () => {
		const reader = new LengthPrefixedMessageReader();
		const chunk = concat(encodeLengthPrefixedMessage(bytes(1)), encodeLengthPrefixedMessage(bytes(2, 3)));
		const messages = reader.feed(chunk);
		assert.strictEqual(messages.length, 2);
		assert.deepStrictEqual(Array.from(messages[0]), [1]);
		assert.deepStrictEqual(Array.from(messages[1]), [2, 3]);
		reader.end();
	});

	test('decodes a message that straddles the end of a chunk holding another message', () => {
		const reader = new LengthPrefixedMessageReader();
		const chunk = concat(encodeLengthPrefixedMessage(bytes(1)), encodeLengthPrefixedMessage(bytes(2, 3, 4)));
		const first = reader.feed(chunk.subarray(0, 9));
		assert.strictEqual(first.length, 1);
		const second = reader.feed(chunk.subarray(9));
		assert.strictEqual(second.length, 1);
		assert.deepStrictEqual(Array.from(second[0]), [2, 3, 4]);
		reader.end();
	});

	test('returned messages are copies that do not alias the chunk', () => {
		const reader = new LengthPrefixedMessageReader();
		const chunk = encodeLengthPrefixedMessage(bytes(5, 6));
		const [message] = reader.feed(chunk);
		chunk.fill(0);
		assert.deepStrictEqual(Array.from(message), [5, 6]);
	});

	test('decodes empty messages', () => {
		const reader = new LengthPrefixedMessageReader();
		const messages = reader.feed(encodeLengthPrefixedMessage(new Uint8Array(0)));
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].byteLength, 0);
	});

	test('rejects a message with the compressed flag set', () => {
		const reader = new LengthPrefixedMessageReader();
		assertReason(() => reader.feed(bytes(1, 0, 0, 0, 1, 42)), 'compressed');
	});

	test('rejects an oversize message from its prefix alone', () => {
		const reader = new LengthPrefixedMessageReader(16);
		assertReason(() => reader.feed(bytes(0, 0, 0, 0, 17)), 'message-too-large');
	});

	test('accepts a message exactly at the limit', () => {
		const reader = new LengthPrefixedMessageReader(4);
		const messages = reader.feed(encodeLengthPrefixedMessage(bytes(1, 2, 3, 4)));
		assert.strictEqual(messages.length, 1);
	});

	test('end() rejects a stream that stops mid-message', () => {
		const reader = new LengthPrefixedMessageReader();
		reader.feed(bytes(0, 0, 0, 0, 4, 1, 2));
		assertReason(() => reader.end(), 'truncated');
	});

	test('end() rejects a stream that stops mid-prefix', () => {
		const reader = new LengthPrefixedMessageReader();
		reader.feed(bytes(0, 0));
		assertReason(() => reader.end(), 'truncated');
	});

	test('end() accepts a stream that stops on a message boundary', () => {
		const reader = new LengthPrefixedMessageReader();
		reader.feed(encodeLengthPrefixedMessage(bytes(1)));
		reader.end();
	});
});
