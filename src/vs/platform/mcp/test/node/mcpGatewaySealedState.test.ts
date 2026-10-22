/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { randomBytes } from 'crypto';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { McpGatewaySealedState, SEALED_STATE_PREFIX, SEALED_STATE_TTL_MS } from '../../node/mcpGatewaySealedState.js';

suite('MCP - GatewaySealedState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const aad = { method: 'tools/call', target: 'echo', principal: 'route-1' };

	function assertInvalid(fn: () => unknown): void {
		assert.throws(fn, (err: unknown) => err instanceof McpGatewayRpcError && err.code === MCP.INVALID_PARAMS && (err.data as { reason: string }).reason === 'invalid_request_state');
	}

	test('round-trips state with the same key and AAD', () => {
		const sealer = new McpGatewaySealedState();
		const sealed = sealer.seal('{"round":1}', aad);
		assert.ok(sealed.startsWith(SEALED_STATE_PREFIX));
		assert.match(sealed.substring(SEALED_STATE_PREFIX.length), /^[A-Za-z0-9_-]+$/, 'base64url body');
		assert.strictEqual(sealer.unseal(sealed, aad), '{"round":1}');
	});

	test('each seal uses a fresh nonce', () => {
		const sealer = new McpGatewaySealedState();
		assert.notStrictEqual(sealer.seal('x', aad), sealer.seal('x', aad));
	});

	test('rejects tampering, truncation, malformed input and the wrong prefix', () => {
		const sealer = new McpGatewaySealedState();
		const sealed = sealer.seal('secret', aad);
		assertInvalid(() => sealer.unseal(sealed + 'TAMPERED', aad));
		assertInvalid(() => sealer.unseal(sealed.substring(0, sealed.length - 4), aad));
		assertInvalid(() => sealer.unseal(SEALED_STATE_PREFIX + 'not*base64url', aad));
		assertInvalid(() => sealer.unseal(SEALED_STATE_PREFIX + 'AAAA', aad));
		assertInvalid(() => sealer.unseal('v2.' + sealed.substring(3), aad));
		assertInvalid(() => sealer.unseal('', aad));
		assertInvalid(() => sealer.unseal(42 as unknown as string, aad));
		const bytes = Buffer.from(sealed.substring(3), 'base64url');
		bytes[20] ^= 0xff;
		const flipped = SEALED_STATE_PREFIX + bytes.toString('base64url');
		assertInvalid(() => sealer.unseal(flipped, aad));
	});

	test('binds the state to method, target and principal', () => {
		const sealer = new McpGatewaySealedState();
		const sealed = sealer.seal('state', aad);
		assertInvalid(() => sealer.unseal(sealed, { ...aad, method: 'prompts/get' }));
		assertInvalid(() => sealer.unseal(sealed, { ...aad, target: 'other' }));
		assertInvalid(() => sealer.unseal(sealed, { ...aad, principal: 'route-2' }));
		// Length-prefixed AAD: shifting bytes between fields must not collide.
		const a = sealer.seal('state', { method: 'ab', target: 'c', principal: 'p' });
		assertInvalid(() => sealer.unseal(a, { method: 'a', target: 'bc', principal: 'p' }));
	});

	test('rejects a value sealed under another key', () => {
		const a = new McpGatewaySealedState(randomBytes(32));
		const b = new McpGatewaySealedState(randomBytes(32));
		assertInvalid(() => b.unseal(a.seal('state', aad), aad));
	});

	test('expires after the TTL using the injected clock', () => {
		let now = 1_000_000;
		const sealer = new McpGatewaySealedState(randomBytes(32), SEALED_STATE_TTL_MS, () => now);
		const sealed = sealer.seal('state', aad);
		now += SEALED_STATE_TTL_MS;
		assert.strictEqual(sealer.unseal(sealed, aad), 'state');
		now += 1;
		assertInvalid(() => sealer.unseal(sealed, aad));
	});

	test('handles empty and large states', () => {
		const sealer = new McpGatewaySealedState();
		assert.strictEqual(sealer.unseal(sealer.seal('', aad), aad), '');
		const big = 'x'.repeat(4096);
		assert.strictEqual(sealer.unseal(sealer.seal(big, aad), aad), big);
	});

	test('requires a 32-byte key', () => {
		assert.throws(() => new McpGatewaySealedState(randomBytes(16)), /32 bytes/);
	});
});
