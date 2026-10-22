/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { eraForProtocolVersion, isModernProtocolVersion, isRecognizedModernError, LATEST_MCP_PROTOCOL_VERSION, LEGACY_MCP_PROTOCOL_VERSIONS, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, META_SUBSCRIPTION_ID, MODERN_MCP_PROTOCOL_VERSIONS, negotiateProtocolVersion, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';

suite('MCP - ProtocolVersions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('version lists agree with the generated schemas', () => {
		assert.strictEqual(LATEST_MCP_PROTOCOL_VERSION, MCP.LATEST_PROTOCOL_VERSION);
		assert.strictEqual(MODERN_MCP_PROTOCOL_VERSIONS[0], MCP.LATEST_PROTOCOL_VERSION);
		assert.strictEqual(LEGACY_MCP_PROTOCOL_VERSIONS[0], MCPLegacy.LATEST_PROTOCOL_VERSION);
		assert.deepStrictEqual(SUPPORTED_MCP_PROTOCOL_VERSIONS, [...MODERN_MCP_PROTOCOL_VERSIONS, ...LEGACY_MCP_PROTOCOL_VERSIONS]);
		assert.deepStrictEqual(LEGACY_MCP_PROTOCOL_VERSIONS, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
	});

	test('eraForProtocolVersion classifies every supported version', () => {
		assert.strictEqual(eraForProtocolVersion('2026-07-28'), 'modern');
		assert.strictEqual(eraForProtocolVersion('2025-11-25'), 'legacy');
		assert.strictEqual(eraForProtocolVersion('2024-10-07'), 'legacy');
		assert.strictEqual(eraForProtocolVersion('1999-01-01'), undefined);
		assert.strictEqual(isModernProtocolVersion('2026-07-28'), true);
		assert.strictEqual(isModernProtocolVersion('2025-11-25'), false);
	});

	test('negotiateProtocolVersion prefers modern, then legacy, else nothing', () => {
		assert.deepStrictEqual(negotiateProtocolVersion(['2025-11-25', '2026-07-28']), { era: 'modern', version: '2026-07-28' });
		assert.deepStrictEqual(negotiateProtocolVersion(['2025-11-25']), { era: 'legacy', version: '2025-11-25' });
		assert.deepStrictEqual(negotiateProtocolVersion(['2024-11-05', '2025-06-18']), { era: 'legacy', version: '2025-06-18' });
		assert.strictEqual(negotiateProtocolVersion(['2030-01-01']), undefined);
		assert.strictEqual(negotiateProtocolVersion([]), undefined);
	});

	test('meta keys use the reserved MCP prefix', () => {
		assert.strictEqual(META_PROTOCOL_VERSION, 'io.modelcontextprotocol/protocolVersion');
		assert.strictEqual(META_CLIENT_CAPABILITIES, 'io.modelcontextprotocol/clientCapabilities');
		assert.strictEqual(META_SUBSCRIPTION_ID, 'io.modelcontextprotocol/subscriptionId');
	});

	test('isRecognizedModernError accepts only the modern-only codes and 404 + method-not-found', () => {
		const error = (code: number) => ({ jsonrpc: '2.0', id: 1, error: { code, message: 'x' } });
		assert.strictEqual(isRecognizedModernError(400, error(MCP.HEADER_MISMATCH)), true);
		assert.strictEqual(isRecognizedModernError(400, error(MCP.MISSING_REQUIRED_CLIENT_CAPABILITY)), true);
		assert.strictEqual(isRecognizedModernError(400, error(MCP.UNSUPPORTED_PROTOCOL_VERSION)), true);
		assert.strictEqual(isRecognizedModernError(404, error(MCP.METHOD_NOT_FOUND)), true);
		assert.strictEqual(isRecognizedModernError(405, [error(MCP.UNSUPPORTED_PROTOCOL_VERSION)]), true);

		assert.strictEqual(isRecognizedModernError(400, error(MCP.METHOD_NOT_FOUND)), false, '-32601 without 404 is a legacy probe');
		assert.strictEqual(isRecognizedModernError(400, error(-32000)), false, 'Server not initialized is legacy');
		assert.strictEqual(isRecognizedModernError(400, error(MCP.INVALID_PARAMS)), false);
		assert.strictEqual(isRecognizedModernError(400, error(MCP.INVALID_REQUEST)), false);
		assert.strictEqual(isRecognizedModernError(404, 'Not Found'), false);
		assert.strictEqual(isRecognizedModernError(400, { error: { code: 'nope' } }), false);
		assert.strictEqual(isRecognizedModernError(400, null), false);
		assert.strictEqual(isRecognizedModernError(undefined, error(MCP.METHOD_NOT_FOUND)), false);
	});
});
