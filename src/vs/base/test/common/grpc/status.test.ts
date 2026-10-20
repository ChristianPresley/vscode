/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { GrpcStatus, decodeBinaryMetadata, decodeGrpcMessage, encodeBinaryMetadata, encodeGrpcMessage, grpcStatusForHttpStatus, grpcStatusForJsonRpcCode, grpcStatusName, jsonRpcCodeForGrpcStatus, parseGrpcStatus } from '../../../common/grpc/status.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';

suite('gRPC status helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('grpcStatusName', () => {
		assert.strictEqual(grpcStatusName(GrpcStatus.OK), 'OK');
		assert.strictEqual(grpcStatusName(GrpcStatus.UNIMPLEMENTED), 'UNIMPLEMENTED');
		assert.strictEqual(grpcStatusName(GrpcStatus.UNAUTHENTICATED), 'UNAUTHENTICATED');
	});

	test('parseGrpcStatus accepts 0..16 and rejects everything else', () => {
		assert.strictEqual(parseGrpcStatus('0'), GrpcStatus.OK);
		assert.strictEqual(parseGrpcStatus('12'), GrpcStatus.UNIMPLEMENTED);
		assert.strictEqual(parseGrpcStatus('16'), GrpcStatus.UNAUTHENTICATED);
		assert.strictEqual(parseGrpcStatus('17'), undefined);
		assert.strictEqual(parseGrpcStatus('x'), undefined);
		assert.strictEqual(parseGrpcStatus(''), undefined);
		assert.strictEqual(parseGrpcStatus('-1'), undefined);
		assert.strictEqual(parseGrpcStatus('1.0'), undefined);
		assert.strictEqual(parseGrpcStatus(' 1'), undefined);
		assert.strictEqual(parseGrpcStatus(undefined), undefined);
	});

	test('grpcStatusForHttpStatus follows the protocol mapping', () => {
		assert.strictEqual(grpcStatusForHttpStatus(200), GrpcStatus.OK);
		assert.strictEqual(grpcStatusForHttpStatus(400), GrpcStatus.INTERNAL);
		assert.strictEqual(grpcStatusForHttpStatus(401), GrpcStatus.UNAUTHENTICATED);
		assert.strictEqual(grpcStatusForHttpStatus(403), GrpcStatus.PERMISSION_DENIED);
		assert.strictEqual(grpcStatusForHttpStatus(404), GrpcStatus.UNIMPLEMENTED);
		assert.strictEqual(grpcStatusForHttpStatus(429), GrpcStatus.UNAVAILABLE);
		assert.strictEqual(grpcStatusForHttpStatus(502), GrpcStatus.UNAVAILABLE);
		assert.strictEqual(grpcStatusForHttpStatus(503), GrpcStatus.UNAVAILABLE);
		assert.strictEqual(grpcStatusForHttpStatus(504), GrpcStatus.UNAVAILABLE);
		assert.strictEqual(grpcStatusForHttpStatus(500), GrpcStatus.UNKNOWN);
		assert.strictEqual(grpcStatusForHttpStatus(302), GrpcStatus.UNKNOWN);
	});

	test('grpcStatusForJsonRpcCode', () => {
		for (const binding of ['tunnel', 'typed'] as const) {
			assert.strictEqual(grpcStatusForJsonRpcCode(-32601, binding), GrpcStatus.UNIMPLEMENTED);
			for (const code of [-32700, -32600, -32602, -32020, -32021, -32022]) {
				assert.strictEqual(grpcStatusForJsonRpcCode(code, binding), GrpcStatus.INVALID_ARGUMENT, `${code} (${binding})`);
			}
		}
		assert.strictEqual(grpcStatusForJsonRpcCode(-32603, 'tunnel'), GrpcStatus.UNKNOWN);
		assert.strictEqual(grpcStatusForJsonRpcCode(-32000, 'tunnel'), GrpcStatus.UNKNOWN);
		assert.strictEqual(grpcStatusForJsonRpcCode(1, 'tunnel'), GrpcStatus.UNKNOWN);
		assert.strictEqual(grpcStatusForJsonRpcCode(-32603, 'typed'), GrpcStatus.INTERNAL);
		assert.strictEqual(grpcStatusForJsonRpcCode(-32000, 'typed'), GrpcStatus.INTERNAL);
		assert.strictEqual(grpcStatusForJsonRpcCode(1, 'typed'), GrpcStatus.INTERNAL);
	});

	test('jsonRpcCodeForGrpcStatus', () => {
		assert.strictEqual(jsonRpcCodeForGrpcStatus(GrpcStatus.INVALID_ARGUMENT), -32602);
		assert.strictEqual(jsonRpcCodeForGrpcStatus(GrpcStatus.UNIMPLEMENTED), -32601);
		assert.strictEqual(jsonRpcCodeForGrpcStatus(GrpcStatus.NOT_FOUND), -32600);
		for (const status of [GrpcStatus.OK, GrpcStatus.CANCELLED, GrpcStatus.DEADLINE_EXCEEDED, GrpcStatus.UNAVAILABLE, GrpcStatus.UNAUTHENTICATED, GrpcStatus.PERMISSION_DENIED]) {
			assert.strictEqual(jsonRpcCodeForGrpcStatus(status), undefined, grpcStatusName(status));
		}
		for (const status of [GrpcStatus.UNKNOWN, GrpcStatus.ALREADY_EXISTS, GrpcStatus.RESOURCE_EXHAUSTED, GrpcStatus.FAILED_PRECONDITION, GrpcStatus.ABORTED, GrpcStatus.OUT_OF_RANGE, GrpcStatus.INTERNAL, GrpcStatus.DATA_LOSS]) {
			assert.strictEqual(jsonRpcCodeForGrpcStatus(status), -32603, grpcStatusName(status));
		}
	});

	test('grpc-message percent-encoding round trip', () => {
		assert.strictEqual(encodeGrpcMessage('plain ascii'), 'plain ascii');
		assert.strictEqual(encodeGrpcMessage('100%'), '100%25');
		assert.strictEqual(encodeGrpcMessage('ünicode'), '%C3%BCnicode');
		assert.strictEqual(encodeGrpcMessage('tab\there\nnewline'), 'tab%09here%0Anewline');
		assert.strictEqual(encodeGrpcMessage('\x7f'), '%7F');

		for (const text of ['', 'plain ascii', '100%', 'ünicode', 'emoji \u{1F600} done', '%41 already escaped', 'tab\there\nnewline']) {
			assert.strictEqual(decodeGrpcMessage(encodeGrpcMessage(text)), text, JSON.stringify(text));
		}
	});

	test('grpc-message decoding keeps malformed escapes verbatim', () => {
		assert.strictEqual(decodeGrpcMessage('%'), '%');
		assert.strictEqual(decodeGrpcMessage('%4'), '%4');
		assert.strictEqual(decodeGrpcMessage('%zz'), '%zz');
		assert.strictEqual(decodeGrpcMessage('50%%20off'), '50% off');
		assert.strictEqual(decodeGrpcMessage('%41%'), 'A%');
		assert.strictEqual(decodeGrpcMessage('lower %c3%bc hex'), 'lower ü hex');
		assert.strictEqual(decodeGrpcMessage('no escapes'), 'no escapes');
	});

	test('binary metadata is unpadded base64 and decodes padded or unpadded', () => {
		const value = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01]);
		const encoded = encodeBinaryMetadata(value);
		assert.strictEqual(encoded, '3q2+7wE');
		assert.ok(!encoded.endsWith('='));
		assert.deepStrictEqual(Array.from(decodeBinaryMetadata(encoded)), Array.from(value));
		assert.deepStrictEqual(Array.from(decodeBinaryMetadata('3q2+7wE=')), Array.from(value));
		assert.deepStrictEqual(Array.from(decodeBinaryMetadata('3q2+7w==')), [0xde, 0xad, 0xbe, 0xef]);
		assert.deepStrictEqual(Array.from(decodeBinaryMetadata('3q2+7w')), [0xde, 0xad, 0xbe, 0xef]);
		assert.strictEqual(encodeBinaryMetadata(new Uint8Array(0)), '');
		assert.strictEqual(decodeBinaryMetadata('').byteLength, 0);
	});
});
