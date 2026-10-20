/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IJsonRpcRequest } from '../../../../base/common/jsonRpcProtocol.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyModernEnvelope, classifyEra, errorResponse, GATEWAY_SERVER_INFO, hasClientCapability, honorSubscriptionFilter, httpStatusForRpcError, isAllowedOrigin, isCacheableMethod, isInputRequiredResult, isLoopbackHost, McpGatewayRpcError, requiredCapabilityForInputRequest, validateInputResponses, validateModernRequestMeta, validateStandardHeaders } from '../../common/mcpGatewayProtocol.js';
import { META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_LOG_LEVEL, META_PROTOCOL_VERSION, META_SERVER_INFO } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';

suite('MCP - GatewayProtocol', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const modernMeta = (extra: Record<string, unknown> = {}) => ({ [META_PROTOCOL_VERSION]: '2026-07-28', [META_CLIENT_CAPABILITIES]: {}, ...extra });
	const request = (method: string, params?: unknown): IJsonRpcRequest => ({ jsonrpc: '2.0', id: 1, method, params });

	suite('classifyEra', () => {
		test('a _meta protocol version makes a request modern even when unsupported', () => {
			assert.strictEqual(classifyEra({}, request('tools/list', { _meta: modernMeta() })), 'modern');
			assert.strictEqual(classifyEra({}, request('tools/list', { _meta: { [META_PROTOCOL_VERSION]: '2099-01-01' } })), 'modern');
		});

		test('a modern MCP-Protocol-Version header makes a request modern', () => {
			assert.strictEqual(classifyEra({ 'mcp-protocol-version': '2026-07-28' }, request('tools/list', {})), 'modern');
			assert.strictEqual(classifyEra({ 'mcp-protocol-version': ' 2026-07-28 ' }, request('tools/list')), 'modern');
		});

		test('initialize, legacy headers and bare messages are legacy', () => {
			assert.strictEqual(classifyEra({}, request('initialize', { protocolVersion: '2025-11-25' })), 'legacy');
			assert.strictEqual(classifyEra({ 'mcp-protocol-version': '2025-11-25' }, request('tools/list', {})), 'legacy');
			assert.strictEqual(classifyEra({ 'mcp-session-id': 'abc' }, { jsonrpc: '2.0', method: 'notifications/initialized' }), 'legacy');
			assert.strictEqual(classifyEra({}, 'not json'), 'legacy');
		});
	});

	suite('validateModernRequestMeta', () => {
		const code = (r: ReturnType<typeof validateModernRequestMeta>) => r.ok ? 'ok' : r.error.code;

		test('accepts well-formed meta and extracts the fields', () => {
			const result = validateModernRequestMeta(request('tools/list', { _meta: modernMeta({ [META_CLIENT_INFO]: { name: 'c', version: '1' }, [META_LOG_LEVEL]: 'debug', progressToken: 'p1' }) }));
			assert.ok(result.ok);
			assert.deepStrictEqual(result.meta, { protocolVersion: '2026-07-28', clientCapabilities: {}, clientInfo: { name: 'c', version: '1' }, logLevel: 'debug', progressToken: 'p1' });
		});

		test('rejects missing pieces with -32602 and unsupported versions with -32022', () => {
			assert.strictEqual(code(validateModernRequestMeta(request('tools/list'))), MCP.INVALID_PARAMS);
			assert.strictEqual(code(validateModernRequestMeta(request('tools/list', { _meta: {} }))), MCP.INVALID_PARAMS);
			assert.strictEqual(code(validateModernRequestMeta(request('tools/list', { _meta: { [META_PROTOCOL_VERSION]: '2026-07-28' } }))), MCP.INVALID_PARAMS);
			const unsupported = validateModernRequestMeta(request('tools/list', { _meta: modernMeta({ [META_PROTOCOL_VERSION]: '2099-01-01' }) }));
			assert.ok(!unsupported.ok);
			assert.strictEqual(unsupported.error.code, MCP.UNSUPPORTED_PROTOCOL_VERSION);
			assert.deepStrictEqual(unsupported.error.data, { supported: ['2026-07-28'], requested: '2099-01-01' });
		});

		test('rejects malformed optional fields', () => {
			assert.strictEqual(code(validateModernRequestMeta(request('tools/list', { _meta: modernMeta({ [META_CLIENT_INFO]: { name: 'c' } }) }))), MCP.INVALID_PARAMS);
			assert.strictEqual(code(validateModernRequestMeta(request('tools/list', { _meta: modernMeta({ [META_LOG_LEVEL]: 'verbose' }) }))), MCP.INVALID_PARAMS);
			assert.strictEqual(code(validateModernRequestMeta(request('tools/list', { _meta: modernMeta({ progressToken: { nope: true } }) }))), 'ok');
		});
	});

	test('validateStandardHeaders wraps the header codec with the body protocol version', () => {
		const req = request('tools/call', { _meta: modernMeta(), name: 'echo', arguments: {} });
		assert.strictEqual(validateStandardHeaders({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'echo' }, req, '2026-07-28'), undefined);
		const missing = validateStandardHeaders({ 'mcp-method': 'tools/call', 'mcp-name': 'echo' }, req, '2026-07-28');
		assert.ok(missing instanceof McpGatewayRpcError);
		assert.strictEqual(missing.code, MCP.HEADER_MISMATCH);
	});

	test('httpStatusForRpcError maps protocol failures to 4xx in the modern era only', () => {
		assert.strictEqual(httpStatusForRpcError('modern', MCP.HEADER_MISMATCH), 400);
		assert.strictEqual(httpStatusForRpcError('modern', MCP.MISSING_REQUIRED_CLIENT_CAPABILITY), 400);
		assert.strictEqual(httpStatusForRpcError('modern', MCP.UNSUPPORTED_PROTOCOL_VERSION), 400);
		assert.strictEqual(httpStatusForRpcError('modern', MCP.INVALID_PARAMS), 400);
		assert.strictEqual(httpStatusForRpcError('modern', MCP.INVALID_REQUEST), 400);
		assert.strictEqual(httpStatusForRpcError('modern', MCP.METHOD_NOT_FOUND), 404);
		assert.strictEqual(httpStatusForRpcError('modern', MCP.INTERNAL_ERROR), 200);
		assert.strictEqual(httpStatusForRpcError('modern', -32000), 200);
		assert.strictEqual(httpStatusForRpcError('legacy', MCP.METHOD_NOT_FOUND), 200);
		assert.strictEqual(httpStatusForRpcError('legacy', MCP.INVALID_PARAMS), 200);
		assert.strictEqual(httpStatusForRpcError('legacy', MCP.PARSE_ERROR), 400);
		assert.strictEqual(httpStatusForRpcError('modern', MCP.PARSE_ERROR), 400);
	});

	suite('applyModernEnvelope', () => {
		test('adds resultType, serverInfo and cache hints without overwriting', () => {
			const out = applyModernEnvelope('tools/list', { tools: [] }, undefined, { ttlMs: 30000, cacheScope: 'private' });
			assert.deepStrictEqual(out, { tools: [], resultType: 'complete', _meta: { [META_SERVER_INFO]: GATEWAY_SERVER_INFO }, ttlMs: 30000, cacheScope: 'private' });

			const kept = applyModernEnvelope('resources/read', { contents: [], resultType: 'complete', ttlMs: 5, cacheScope: 'public', _meta: { [META_SERVER_INFO]: { name: 'x', version: '2' }, other: 1 } }, { name: 'gw', version: '9' });
			assert.deepStrictEqual(kept, { contents: [], resultType: 'complete', ttlMs: 5, cacheScope: 'public', _meta: { [META_SERVER_INFO]: { name: 'x', version: '2' }, other: 1 } });
		});

		test('leaves non-cacheable methods and non-complete results without cache hints', () => {
			const call = applyModernEnvelope('tools/call', { content: [] });
			assert.deepStrictEqual(call, { content: [], resultType: 'complete', _meta: { [META_SERVER_INFO]: GATEWAY_SERVER_INFO } });
			const inputRequired = applyModernEnvelope('tools/call', { resultType: 'input_required', inputRequests: {} });
			assert.strictEqual(inputRequired.resultType, 'input_required');
			assert.strictEqual((inputRequired as Record<string, unknown>).ttlMs, undefined);
			const defaulted = applyModernEnvelope('server/discover', { supportedVersions: ['2026-07-28'], capabilities: {}, ttlMs: -5 });
			assert.strictEqual(defaulted.ttlMs, 0);
			assert.strictEqual(defaulted.cacheScope, 'private');
		});

		test('isCacheableMethod and isInputRequiredResult', () => {
			assert.strictEqual(isCacheableMethod('prompts/list'), true);
			assert.strictEqual(isCacheableMethod('tools/call'), false);
			assert.strictEqual(isInputRequiredResult({ resultType: 'input_required' }), true);
			assert.strictEqual(isInputRequiredResult({ resultType: 'complete' }), false);
			assert.strictEqual(isInputRequiredResult(null), false);
		});
	});

	test('validateInputResponses accepts objects of objects only', () => {
		assert.strictEqual(validateInputResponses(undefined), undefined);
		assert.strictEqual(validateInputResponses({ a: { action: 'accept' } }), undefined);
		assert.strictEqual(validateInputResponses([])?.code, MCP.INVALID_PARAMS);
		assert.strictEqual(validateInputResponses({ a: 'x' })?.code, MCP.INVALID_PARAMS);
	});

	test('input request capability mapping', () => {
		assert.strictEqual(requiredCapabilityForInputRequest('elicitation/create', { mode: 'form' }), 'elicitation');
		assert.strictEqual(requiredCapabilityForInputRequest('elicitation/create', {}), 'elicitation');
		assert.strictEqual(requiredCapabilityForInputRequest('elicitation/create', { mode: 'url' }), 'elicitation.url');
		assert.strictEqual(requiredCapabilityForInputRequest('sampling/createMessage', {}), 'sampling');
		assert.strictEqual(requiredCapabilityForInputRequest('roots/list', {}), 'roots');
		assert.strictEqual(requiredCapabilityForInputRequest('tools/call', {}), undefined);

		assert.strictEqual(hasClientCapability({ elicitation: { form: {} } }, 'elicitation'), true);
		assert.strictEqual(hasClientCapability({ elicitation: { form: {} } }, 'elicitation.url'), false);
		assert.strictEqual(hasClientCapability({ elicitation: { url: {} } }, 'elicitation.url'), true);
		assert.strictEqual(hasClientCapability({ sampling: {} }, 'sampling'), true);
		assert.strictEqual(hasClientCapability({}, 'roots'), false);
		assert.strictEqual(hasClientCapability(undefined, 'roots'), false);
	});

	test('honorSubscriptionFilter keeps only what the server can produce', () => {
		const caps: MCP.ServerCapabilities = { tools: { listChanged: true }, resources: { subscribe: true }, prompts: {} };
		assert.deepStrictEqual(honorSubscriptionFilter({ toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['a://b', 'c://d'] }, caps), { toolsListChanged: true, resourceSubscriptions: ['a://b', 'c://d'] });
		assert.deepStrictEqual(honorSubscriptionFilter({ toolsListChanged: false, resourceSubscriptions: [] }, caps), {});
		assert.deepStrictEqual(honorSubscriptionFilter({}, {}), {});
	});

	test('loopback host and origin checks', () => {
		for (const host of ['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:8080', '127.5.6.7:1', '[::1]', '[::1]:9', '::1', 'LOCALHOST']) {
			assert.strictEqual(isLoopbackHost(host), true, host);
		}
		for (const host of ['example.com', 'example.com:80', '10.0.0.1', '[2001:db8::1]', '2001:db8::1', 'localhost.evil.com', '']) {
			assert.strictEqual(isLoopbackHost(host), false, host);
		}
		assert.strictEqual(isLoopbackHost(undefined), false);

		assert.strictEqual(isAllowedOrigin(undefined), true);
		assert.strictEqual(isAllowedOrigin(''), true);
		assert.strictEqual(isAllowedOrigin('http://localhost:3000'), true);
		assert.strictEqual(isAllowedOrigin('http://127.0.0.1'), true);
		assert.strictEqual(isAllowedOrigin('http://[::1]:5'), true);
		assert.strictEqual(isAllowedOrigin('https://example.com'), false);
		assert.strictEqual(isAllowedOrigin('null'), false);
		assert.strictEqual(isAllowedOrigin('not a url'), false);
	});

	test('errorResponse shapes', () => {
		assert.deepStrictEqual(errorResponse(7, -32601, 'nope'), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'nope' } });
		assert.deepStrictEqual(errorResponse(null, -32700, 'bad', { x: 1 }), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad', data: { x: 1 } } });
	});
});
