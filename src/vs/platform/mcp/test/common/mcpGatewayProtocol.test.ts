/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IJsonRpcRequest } from '../../../../base/common/jsonRpcProtocol.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyModernEnvelope, cancellationTargets, classifyEra, clientCapabilitiesOf, clientInfoFromMeta, errorResponse, GATEWAY_SERVER_INFO, hasClientCapability, honorSubscriptionFilter, httpStatusForRpcError, isAllowedOrigin, isCacheableMethod, isInputRequiredResult, isLoopbackHost, LEGACY_TRANSPORT_ERROR, legacyVersionSupportsPriming, MAX_LISTEN_FILTER_LENGTH, MAX_LISTEN_RESOURCE_SUBSCRIPTIONS, McpGatewayRpcError, requiredCapabilitiesForInputRequest, validateInputResponses, validateLegacyProtocolVersionHeader, validateModernRequestMeta, validateStandardHeaders, validateSubscriptionFilter } from '../../common/mcpGatewayProtocol.js';
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
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('elicitation/create', { mode: 'form' }), ['elicitation']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('elicitation/create', {}), ['elicitation']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('elicitation/create', { mode: 'url' }), ['elicitation.url']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', {}), ['sampling']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('roots/list', {}), ['roots']);
		assert.strictEqual(requiredCapabilitiesForInputRequest('tools/call', {}), undefined);

		assert.strictEqual(hasClientCapability({ elicitation: { form: {} } }, 'elicitation'), true);
		assert.strictEqual(hasClientCapability({ elicitation: { form: {} } }, 'elicitation.url'), false);
		assert.strictEqual(hasClientCapability({ elicitation: { url: {} } }, 'elicitation.url'), true);
		assert.strictEqual(hasClientCapability({ sampling: {} }, 'sampling'), true);
		assert.strictEqual(hasClientCapability({}, 'roots'), false);
		assert.strictEqual(hasClientCapability(undefined, 'roots'), false);
	});

	test('a tool-enabled sampling request needs sampling.tools, one with includeContext other than none needs sampling.context', () => {
		const messages = [{ role: 'user', content: { type: 'text', text: 'Weather?' } }];
		const tools = [{ name: 'get_weather', inputSchema: { type: 'object' } }];
		// client/sampling#007: tools or toolChoice make the request tool-enabled.
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', { messages, maxTokens: 10, tools }), ['sampling', 'sampling.tools']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', { messages, maxTokens: 10, toolChoice: { mode: 'none' } }), ['sampling', 'sampling.tools']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', { messages, maxTokens: 10, tools: [] }), ['sampling', 'sampling.tools'], 'an empty tools array is still a tool-enabled request');
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', { messages, maxTokens: 10, tools: null, toolChoice: null }), ['sampling'], 'null is absent');
		// client/sampling#009: the deprecated thisServer and allServers need sampling.context; none is the default.
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', { messages, maxTokens: 10, includeContext: 'none' }), ['sampling']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', { messages, maxTokens: 10, includeContext: 'thisServer' }), ['sampling', 'sampling.context']);
		assert.deepStrictEqual(requiredCapabilitiesForInputRequest('sampling/createMessage', { messages, maxTokens: 10, includeContext: 'allServers', tools }), ['sampling', 'sampling.context', 'sampling.tools']);

		assert.strictEqual(hasClientCapability({ sampling: {} }, 'sampling.tools'), false);
		assert.strictEqual(hasClientCapability({ sampling: { context: {} } }, 'sampling.tools'), false);
		assert.strictEqual(hasClientCapability({ sampling: { tools: {} } }, 'sampling.tools'), true);
		assert.strictEqual(hasClientCapability({ sampling: { tools: {} } }, 'sampling.context'), false);
		assert.strictEqual(hasClientCapability({ sampling: { context: {} } }, 'sampling.context'), true);
		assert.strictEqual(hasClientCapability({}, 'sampling.tools'), false);
		assert.strictEqual(hasClientCapability({ sampling: true } as unknown as MCP.ClientCapabilities, 'sampling.tools'), false, 'a malformed declaration declares no sub-capability');

		// -32021 data.requiredCapabilities: the sub-capabilities merge into one sampling object.
		assert.deepStrictEqual(clientCapabilitiesOf(['sampling.tools']), { sampling: { tools: {} } });
		assert.deepStrictEqual(clientCapabilitiesOf(['sampling', 'sampling.context', 'sampling.tools']), { sampling: { context: {}, tools: {} } });
		assert.deepStrictEqual(clientCapabilitiesOf(['elicitation', 'elicitation.url', 'roots']), { elicitation: { url: {} }, roots: {} });
		assert.deepStrictEqual(clientCapabilitiesOf([]), {});
	});

	test('validateSubscriptionFilter: booleans for the list flags, an array of strings for resourceSubscriptions', () => {
		for (const ok of [{}, { toolsListChanged: true }, { toolsListChanged: false, promptsListChanged: true, resourcesListChanged: true }, { resourceSubscriptions: [] }, { resourceSubscriptions: ['a://b'] }, { unknownKey: 'ignored' }]) {
			assert.strictEqual(validateSubscriptionFilter(ok), undefined, JSON.stringify(ok));
		}
		for (const bad of [undefined, null, 'all', [], ['toolsListChanged'], { toolsListChanged: 'yes' }, { promptsListChanged: 1 }, { resourcesListChanged: null }, { resourceSubscriptions: 'x' }, { resourceSubscriptions: [1] }, { resourceSubscriptions: ['a', null] }]) {
			const error = validateSubscriptionFilter(bad);
			assert.ok(error instanceof McpGatewayRpcError, JSON.stringify(bad));
			assert.strictEqual(error.code, MCP.INVALID_PARAMS);
		}
	});

	test('validateSubscriptionFilter: at most MAX_LISTEN_RESOURCE_SUBSCRIPTIONS distinct URIs and MAX_LISTEN_FILTER_LENGTH characters (-32603); honorSubscriptionFilter keeps each URI once', () => {
		const uris = (count: number) => Array.from({ length: count }, (_, i) => `test://r/${i}`);
		assert.strictEqual(validateSubscriptionFilter({ resourceSubscriptions: uris(MAX_LISTEN_RESOURCE_SUBSCRIPTIONS) }), undefined);
		assert.strictEqual(validateSubscriptionFilter({ resourceSubscriptions: [...uris(MAX_LISTEN_RESOURCE_SUBSCRIPTIONS), ...uris(10)] }), undefined, 'repeated URIs count once');
		const tooMany = validateSubscriptionFilter({ resourceSubscriptions: uris(MAX_LISTEN_RESOURCE_SUBSCRIPTIONS + 1) });
		assert.ok(tooMany instanceof McpGatewayRpcError);
		assert.strictEqual(tooMany.code, MCP.INTERNAL_ERROR);
		assert.match(tooMany.message, new RegExp(`limit ${MAX_LISTEN_RESOURCE_SUBSCRIPTIONS}`));
		const tooLarge = validateSubscriptionFilter({ resourceSubscriptions: [`test://${'x'.repeat(MAX_LISTEN_FILTER_LENGTH)}`] });
		assert.strictEqual(tooLarge?.code, MCP.INTERNAL_ERROR);
		assert.strictEqual(validateSubscriptionFilter({ toolsListChanged: true, padding: 'x'.repeat(MAX_LISTEN_FILTER_LENGTH) })?.code, MCP.INTERNAL_ERROR, 'unknown keys count towards the size');
		// A malformed filter is still -32602, whatever its size.
		assert.strictEqual(validateSubscriptionFilter({ resourceSubscriptions: [...uris(MAX_LISTEN_RESOURCE_SUBSCRIPTIONS + 1), 1] })?.code, MCP.INVALID_PARAMS);

		const caps: MCP.ServerCapabilities = { resources: { subscribe: true } };
		assert.deepStrictEqual(honorSubscriptionFilter({ resourceSubscriptions: ['a://b', 'c://d', 'a://b', 'a://b'] }, caps), { resourceSubscriptions: ['a://b', 'c://d'] });
	});

	test('honorSubscriptionFilter is defensive about malformed filters', () => {
		const caps: MCP.ServerCapabilities = { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { subscribe: true, listChanged: true } };
		assert.deepStrictEqual(honorSubscriptionFilter({ resourceSubscriptions: 'x' } as unknown as MCP.SubscriptionFilter, caps), {});
		assert.deepStrictEqual(honorSubscriptionFilter({ resourceSubscriptions: ['a://b', 1, null] } as unknown as MCP.SubscriptionFilter, caps), { resourceSubscriptions: ['a://b'] });
		assert.deepStrictEqual(honorSubscriptionFilter({ toolsListChanged: 'yes', promptsListChanged: 1 } as unknown as MCP.SubscriptionFilter, caps), {});
		assert.deepStrictEqual(honorSubscriptionFilter(null as unknown as MCP.SubscriptionFilter, caps), {});
	});

	test('validateLegacyProtocolVersionHeader: absent or a legacy revision passes, anything else is -32000', () => {
		assert.strictEqual(validateLegacyProtocolVersionHeader({}), undefined);
		for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', ' 2025-11-25 ']) {
			assert.strictEqual(validateLegacyProtocolVersionHeader({ 'mcp-protocol-version': version }), undefined, version);
		}
		for (const version of ['', 'garbage', '2099-01-01', '2026-07-28']) {
			assert.strictEqual(validateLegacyProtocolVersionHeader({ 'mcp-protocol-version': version })?.code, LEGACY_TRANSPORT_ERROR, version);
		}
	});

	test('legacyVersionSupportsPriming: only from 2025-11-25 on', () => {
		assert.deepStrictEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07', '2026-07-28', '9999-99-99', undefined].map(legacyVersionSupportsPriming), [true, false, false, false, false, false, false, false]);
	});

	test('clientInfoFromMeta reads a well-formed _meta client info', () => {
		assert.deepStrictEqual(clientInfoFromMeta({ params: { _meta: { [META_CLIENT_INFO]: { name: 'c', version: '1' } } } }), { name: 'c', version: '1' });
		for (const body of [undefined, {}, { params: {} }, { params: { _meta: { [META_CLIENT_INFO]: { name: 'c' } } } }, { params: { _meta: { [META_CLIENT_INFO]: 'c' } } }]) {
			assert.strictEqual(clientInfoFromMeta(body), undefined, JSON.stringify(body));
		}
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

	test('cancellationTargets: a named cancellation reaches its own client only; a nameless one the only client of its address with the id, never one of several', () => {
		const entry = (name: string, owner: string, peer: string) => ({ name, owner, peer });
		const named = { key: 'A', peer: 'here', named: true };
		const nameless = { key: 'nameless@here', peer: 'here', named: false };
		const names = (entries: readonly { name: string }[]) => entries.map(e => e.name);

		// A cancellation that names its client reaches exactly that client's entries, never by address.
		assert.deepStrictEqual(names(cancellationTargets([entry('a1', 'A', 'here'), entry('b1', 'B', 'here')], named)), ['a1']);
		assert.deepStrictEqual(names(cancellationTargets([entry('b1', 'B', 'here')], named)), []);

		// Without client info: a request that named its client is still reached when it is the only client of the address with the id.
		assert.deepStrictEqual(names(cancellationTargets([entry('a1', 'A', 'here'), entry('a2', 'A', 'here')], nameless)), ['a1', 'a2']);
		assert.deepStrictEqual(names(cancellationTargets([entry('x1', 'X', 'elsewhere')], nameless)), [], 'another address is never reached');
		assert.deepStrictEqual(names(cancellationTargets([entry('a1', 'A', 'here'), entry('x1', 'X', 'elsewhere')], nameless)), ['a1']);
		// Ambiguous: two clients of the address have the id.
		assert.deepStrictEqual(names(cancellationTargets([entry('a1', 'A', 'here'), entry('b1', 'B', 'here')], nameless)), []);
		// A client without client info is reached when it is the only client of the address with the id...
		assert.deepStrictEqual(names(cancellationTargets([entry('n1', 'nameless@here', 'here'), entry('n2', 'nameless@here', 'here')], nameless)), ['n1', 'n2']);
		// ...but its key matching the cancellation's is no proof that it sent it: A's notifications need not carry _meta either, so this is ambiguous too.
		assert.deepStrictEqual(names(cancellationTargets([entry('n1', 'nameless@here', 'here'), entry('a1', 'A', 'here')], nameless)), []);
		assert.deepStrictEqual(names(cancellationTargets([entry('a1', 'A', 'here'), entry('n1', 'nameless@here', 'here')], nameless)), []);
		// A named cancellation never reaches the nameless client's entries.
		assert.deepStrictEqual(names(cancellationTargets([entry('n1', 'nameless@here', 'here')], named)), []);
		// Entries without a sender (a transport that keeps none) are reached by no cancellation.
		assert.deepStrictEqual(names(cancellationTargets([{ name: 'anon', owner: undefined, peer: undefined }], nameless)), []);
	});

	test('errorResponse shapes', () => {
		assert.deepStrictEqual(errorResponse(7, -32601, 'nope'), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'nope' } });
		assert.deepStrictEqual(errorResponse(null, -32700, 'bad', { x: 1 }), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad', data: { x: 1 } } });
	});
});
