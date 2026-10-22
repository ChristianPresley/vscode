/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';

/**
 * Seals the `requestState` the gateway hands to a client between MRTR rounds.
 *
 * The state is opaque to the client and must come back unmodified on the
 * retry: it is encrypted with AES-256-GCM under a per-process key, bound to
 * the request method, the target (tool/prompt/resource name) and a principal
 * (the route) through the additional authenticated data, and it expires.
 * Format: `v1.` + base64url(nonce || ciphertext || tag).
 */
export const SEALED_STATE_PREFIX = 'v1.';
export const SEALED_STATE_TTL_MS = 600_000;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface ISealedStateAad {
	readonly method: string;
	readonly target: string;
	readonly principal: string;
}

export class McpGatewaySealedState {
	constructor(
		private readonly _key: Uint8Array = randomBytes(KEY_BYTES),
		private readonly _ttlMs: number = SEALED_STATE_TTL_MS,
		private readonly _now: () => number = Date.now,
	) {
		if (_key.length !== KEY_BYTES) {
			throw new Error(`Sealed state key must be ${KEY_BYTES} bytes`);
		}
	}

	/** Seals `state` for `aad`. The expiry is part of the sealed payload so it cannot be extended by the client. */
	seal(state: string, aad: ISealedStateAad): string {
		const nonce = randomBytes(NONCE_BYTES);
		const cipher = createCipheriv('aes-256-gcm', this._key, nonce);
		cipher.setAAD(encodeAad(aad));
		const payload = Buffer.from(JSON.stringify({ e: this._now() + this._ttlMs, s: state }), 'utf8');
		const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
		const tag = cipher.getAuthTag();
		return SEALED_STATE_PREFIX + Buffer.concat([nonce, ciphertext, tag]).toString('base64url');
	}

	/**
	 * Unseals a value produced by {@link seal} for the same `aad`. Throws a
	 * `-32602` {@link McpGatewayRpcError} when the value is malformed, was
	 * tampered with, belongs to another request or has expired.
	 */
	unseal(sealed: string, aad: ISealedStateAad): string {
		const fail = () => new McpGatewayRpcError(MCP.INVALID_PARAMS, 'Invalid or expired requestState', { reason: 'invalid_request_state' });
		if (typeof sealed !== 'string' || !sealed.startsWith(SEALED_STATE_PREFIX)) {
			throw fail();
		}
		const body = sealed.substring(SEALED_STATE_PREFIX.length);
		if (!/^[A-Za-z0-9_-]+$/.test(body)) {
			throw fail();
		}
		const bytes = Buffer.from(body, 'base64url');
		if (bytes.length < NONCE_BYTES + TAG_BYTES) {
			throw fail();
		}
		const nonce = bytes.subarray(0, NONCE_BYTES);
		const tag = bytes.subarray(bytes.length - TAG_BYTES);
		const ciphertext = bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES);
		let payload: string;
		try {
			const decipher = createDecipheriv('aes-256-gcm', this._key, nonce);
			decipher.setAAD(encodeAad(aad));
			decipher.setAuthTag(tag);
			payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
		} catch {
			throw fail();
		}
		let parsed: { e?: unknown; s?: unknown };
		try {
			parsed = JSON.parse(payload);
		} catch {
			throw fail();
		}
		if (typeof parsed.e !== 'number' || typeof parsed.s !== 'string' || this._now() > parsed.e) {
			throw fail();
		}
		return parsed.s;
	}
}

function encodeAad(aad: ISealedStateAad): Buffer {
	// Length-prefixed fields: no separator ambiguity between method/target/principal.
	const parts = [aad.method, aad.target, aad.principal].map(part => Buffer.from(part, 'utf8'));
	const out: Buffer[] = [];
	for (const part of parts) {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(part.length, 0);
		out.push(length, part);
	}
	return Buffer.concat(out);
}
