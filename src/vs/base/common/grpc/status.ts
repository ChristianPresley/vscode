/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer, decodeBase64, encodeBase64 } from '../buffer.js';

/**
 * gRPC status codes, see https://grpc.io/docs/guides/status-codes/.
 */
export const enum GrpcStatus {
	OK = 0,
	CANCELLED = 1,
	UNKNOWN = 2,
	INVALID_ARGUMENT = 3,
	DEADLINE_EXCEEDED = 4,
	NOT_FOUND = 5,
	ALREADY_EXISTS = 6,
	PERMISSION_DENIED = 7,
	RESOURCE_EXHAUSTED = 8,
	FAILED_PRECONDITION = 9,
	ABORTED = 10,
	OUT_OF_RANGE = 11,
	UNIMPLEMENTED = 12,
	INTERNAL = 13,
	UNAVAILABLE = 14,
	DATA_LOSS = 15,
	UNAUTHENTICATED = 16,
}

const statusNames: readonly string[] = [
	'OK',
	'CANCELLED',
	'UNKNOWN',
	'INVALID_ARGUMENT',
	'DEADLINE_EXCEEDED',
	'NOT_FOUND',
	'ALREADY_EXISTS',
	'PERMISSION_DENIED',
	'RESOURCE_EXHAUSTED',
	'FAILED_PRECONDITION',
	'ABORTED',
	'OUT_OF_RANGE',
	'UNIMPLEMENTED',
	'INTERNAL',
	'UNAVAILABLE',
	'DATA_LOSS',
	'UNAUTHENTICATED',
];

/**
 * The maximum number of bytes of a `grpc-message` trailer value that callers
 * should produce; longer messages may be truncated by intermediaries.
 */
export const GRPC_MESSAGE_MAX_BYTES = 1024;

export function grpcStatusName(status: GrpcStatus): string {
	return statusNames[status] ?? `UNKNOWN_STATUS_${status}`;
}

/**
 * Parses a `grpc-status` trailer value; anything other than `'0'`..`'16'`
 * yields `undefined`.
 */
export function parseGrpcStatus(text: string | undefined): GrpcStatus | undefined {
	if (text === undefined || !/^\d{1,2}$/.test(text)) {
		return undefined;
	}
	const value = Number(text);
	return value >= 0 && value < statusNames.length ? value : undefined;
}

/**
 * Maps an HTTP status to a gRPC status for responses that carry no
 * `grpc-status`, following the mapping in the gRPC HTTP/2 protocol.
 */
export function grpcStatusForHttpStatus(httpStatus: number): GrpcStatus {
	switch (httpStatus) {
		case 200: return GrpcStatus.OK;
		case 400: return GrpcStatus.INTERNAL;
		case 401: return GrpcStatus.UNAUTHENTICATED;
		case 403: return GrpcStatus.PERMISSION_DENIED;
		case 404: return GrpcStatus.UNIMPLEMENTED;
		case 429:
		case 502:
		case 503:
		case 504:
			return GrpcStatus.UNAVAILABLE;
		default:
			return GrpcStatus.UNKNOWN;
	}
}

/**
 * Maps a JSON-RPC error code to a gRPC status. The `tunnel` binding carries
 * opaque JSON-RPC traffic and reports unknown codes as UNKNOWN; the `typed`
 * binding exposes individual methods and reports them as INTERNAL.
 */
export function grpcStatusForJsonRpcCode(code: number, binding: 'tunnel' | 'typed'): GrpcStatus {
	switch (code) {
		case -32601:
			return GrpcStatus.UNIMPLEMENTED;
		case -32700:
		case -32600:
		case -32602:
		case -32020:
		case -32021:
		case -32022:
			return GrpcStatus.INVALID_ARGUMENT;
		default:
			return binding === 'tunnel' ? GrpcStatus.UNKNOWN : GrpcStatus.INTERNAL;
	}
}

/**
 * Maps a gRPC status to a JSON-RPC error code, or `undefined` for statuses
 * that have no JSON-RPC error equivalent (success, cancellation, deadlines
 * and transport or authentication failures).
 */
export function jsonRpcCodeForGrpcStatus(status: GrpcStatus): number | undefined {
	switch (status) {
		case GrpcStatus.INVALID_ARGUMENT:
			return -32602;
		case GrpcStatus.UNIMPLEMENTED:
			return -32601;
		case GrpcStatus.NOT_FOUND:
			return -32600;
		case GrpcStatus.OK:
		case GrpcStatus.CANCELLED:
		case GrpcStatus.DEADLINE_EXCEEDED:
		case GrpcStatus.UNAVAILABLE:
		case GrpcStatus.UNAUTHENTICATED:
		case GrpcStatus.PERMISSION_DENIED:
			return undefined;
		default:
			return -32603;
	}
}

const PERCENT = 0x25;
const HEX = '0123456789ABCDEF';

/**
 * Percent-encodes a `grpc-message` value: every UTF-8 byte outside the
 * printable ASCII range 0x20-0x7E, and `%` itself, becomes `%XX`.
 */
export function encodeGrpcMessage(text: string): string {
	const bytes = VSBuffer.fromString(text).buffer;
	let out = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		const byte = bytes[i];
		if (byte >= 0x20 && byte <= 0x7e && byte !== PERCENT) {
			out += String.fromCharCode(byte);
		} else {
			out += '%' + HEX[byte >>> 4] + HEX[byte & 0x0f];
		}
	}
	return out;
}

function hexValue(code: number): number {
	if (code >= 0x30 && code <= 0x39) {
		return code - 0x30;
	}
	if (code >= 0x41 && code <= 0x46) {
		return code - 0x41 + 10;
	}
	if (code >= 0x61 && code <= 0x66) {
		return code - 0x61 + 10;
	}
	return -1;
}

/**
 * Decodes a percent-encoded `grpc-message` value. Malformed escapes are
 * kept verbatim rather than rejected, as the protocol requires.
 */
export function decodeGrpcMessage(text: string): string {
	if (text.indexOf('%') === -1) {
		return text;
	}
	let out = '';
	let escaped: number[] = [];
	const flush = () => {
		if (escaped.length) {
			out += VSBuffer.wrap(Uint8Array.from(escaped)).toString();
			escaped = [];
		}
	};
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '%' && i + 2 < text.length) {
			const hi = hexValue(text.charCodeAt(i + 1));
			const lo = hexValue(text.charCodeAt(i + 2));
			if (hi >= 0 && lo >= 0) {
				escaped.push((hi << 4) | lo);
				i += 2;
				continue;
			}
		}
		flush();
		out += char;
	}
	flush();
	return out;
}

/**
 * Encodes the value of a `-bin` metadata entry as unpadded base64.
 */
export function encodeBinaryMetadata(bytes: Uint8Array): string {
	return encodeBase64(VSBuffer.wrap(bytes), false);
}

/**
 * Decodes the value of a `-bin` metadata entry; both padded and unpadded
 * base64 are accepted.
 */
export function decodeBinaryMetadata(value: string): Uint8Array {
	return decodeBase64(value.trim()).buffer;
}
