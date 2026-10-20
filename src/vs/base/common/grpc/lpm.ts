/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * gRPC length-prefixed message (LPM) framing, as described in the
 * gRPC-over-HTTP/2 protocol: every message is preceded by a 1-byte
 * compressed flag and a 4-byte big-endian payload length.
 */

export const DEFAULT_MAX_GRPC_MESSAGE_BYTES = 4 * 1024 * 1024;

const PREFIX_BYTES = 5;

export type GrpcFramingErrorReason = 'compressed' | 'message-too-large' | 'truncated';

export class GrpcFramingError extends Error {
	constructor(public readonly reason: GrpcFramingErrorReason, message: string) {
		super(message);
		this.name = 'GrpcFramingError';
	}
}

/**
 * Frames a single payload as an uncompressed length-prefixed message.
 */
export function encodeLengthPrefixedMessage(payload: Uint8Array): Uint8Array {
	const framed = new Uint8Array(PREFIX_BYTES + payload.byteLength);
	framed[0] = 0; // compressed flag
	framed[1] = (payload.byteLength >>> 24) & 0xff;
	framed[2] = (payload.byteLength >>> 16) & 0xff;
	framed[3] = (payload.byteLength >>> 8) & 0xff;
	framed[4] = payload.byteLength & 0xff;
	framed.set(payload, PREFIX_BYTES);
	return framed;
}

/**
 * Incrementally decodes length-prefixed messages from a byte stream whose
 * chunk boundaries are unrelated to message boundaries.
 */
export class LengthPrefixedMessageReader {

	private readonly pending: Uint8Array[] = [];
	private pendingBytes = 0;

	constructor(private readonly maxMessageBytes: number = DEFAULT_MAX_GRPC_MESSAGE_BYTES) { }

	/**
	 * Feeds a chunk and returns every message completed by it. Each returned
	 * message is a copy that does not alias the chunk.
	 */
	feed(chunk: Uint8Array): Uint8Array[] {
		if (chunk.byteLength > 0) {
			this.pending.push(chunk);
			this.pendingBytes += chunk.byteLength;
		}

		const messages: Uint8Array[] = [];
		while (this.pendingBytes >= PREFIX_BYTES) {
			const prefix = this.peek(PREFIX_BYTES);
			const compressed = prefix[0];
			const length = ((prefix[1] << 24) >>> 0) + (prefix[2] << 16) + (prefix[3] << 8) + prefix[4];
			if (compressed !== 0) {
				throw new GrpcFramingError('compressed', 'unsupported encoding: compressed message received');
			}
			if (length > this.maxMessageBytes) {
				throw new GrpcFramingError('message-too-large', `message too large: ${length} bytes exceeds the limit of ${this.maxMessageBytes} bytes`);
			}
			if (this.pendingBytes < PREFIX_BYTES + length) {
				break;
			}
			this.consume(PREFIX_BYTES);
			messages.push(this.take(length));
		}
		return messages;
	}

	/**
	 * Signals the end of the stream; throws when bytes of an incomplete
	 * message remain buffered.
	 */
	end(): void {
		if (this.pendingBytes > 0) {
			const remaining = this.pendingBytes;
			this.pending.length = 0;
			this.pendingBytes = 0;
			throw new GrpcFramingError('truncated', `stream ended with ${remaining} bytes of an incomplete message`);
		}
	}

	private peek(count: number): Uint8Array {
		const first = this.pending[0];
		if (first.byteLength >= count) {
			return first.subarray(0, count);
		}
		const out = new Uint8Array(count);
		let offset = 0;
		for (const chunk of this.pending) {
			const needed = count - offset;
			if (chunk.byteLength >= needed) {
				out.set(chunk.subarray(0, needed), offset);
				break;
			}
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}

	private take(count: number): Uint8Array {
		const out = new Uint8Array(count);
		let offset = 0;
		while (offset < count) {
			const chunk = this.pending[0];
			const needed = count - offset;
			if (chunk.byteLength <= needed) {
				out.set(chunk, offset);
				offset += chunk.byteLength;
				this.pending.shift();
			} else {
				out.set(chunk.subarray(0, needed), offset);
				this.pending[0] = chunk.subarray(needed);
				offset += needed;
			}
		}
		this.pendingBytes -= count;
		return out;
	}

	private consume(count: number): void {
		let remaining = count;
		while (remaining > 0) {
			const chunk = this.pending[0];
			if (chunk.byteLength <= remaining) {
				remaining -= chunk.byteLength;
				this.pending.shift();
			} else {
				this.pending[0] = chunk.subarray(remaining);
				remaining = 0;
			}
		}
		this.pendingBytes -= count;
	}
}
