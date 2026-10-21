/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeMessage, encodeMessage } from '../../../../base/common/protobuf/codec.js';
import { jsonToStruct } from '../../../../base/common/protobuf/wellKnown.js';
import { ProtoDecodeError, decodeUtf8 } from '../../../../base/common/protobuf/wire.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CALL_TOOL_RESPONSE, ITypedRpc, LIST_TOOLS_REQUEST, LIST_TOOLS_RESPONSE, RESULT_TYPE, TUNNEL_CALL_PATH, TYPED_PATH_PREFIX, TYPED_RPCS, typedRpcForMethod, typedRpcForPath } from '../../common/mcpGrpcProto.js';
import { decodeTypedRequest, decodeTypedResponse, decodeTypedServerIdentity, encodeTypedRequest, encodeTypedResponse, McpUnexpressibleError, McpUnexpressibleKind, routingMetadataFor, synthesizeDiscoverResult } from '../../common/mcpGrpcTyped.js';

function rpcOf(method: string): ITypedRpc {
	const rpc = typedRpcForMethod(method);
	assert.ok(rpc, `${method} has a typed RPC`);
	return rpc;
}

/** The server encodes a result, the client decodes it. */
function resultRoundTrip(method: string, result: unknown): Record<string, unknown> {
	const rpc = rpcOf(method);
	return decodeTypedResponse(rpc, encodeTypedResponse(rpc, result));
}

/** The client encodes params, the server decodes them. */
function paramsRoundTrip(method: string, params: unknown): Record<string, unknown> {
	const rpc = rpcOf(method);
	return decodeTypedRequest(rpc, encodeTypedRequest(rpc, params));
}

function expectResult(method: string, result: Record<string, unknown>, expected: Record<string, unknown> = { resultType: 'complete', ...result }): void {
	assert.deepStrictEqual(resultRoundTrip(method, result), expected);
}

function expectParams(method: string, params: Record<string, unknown>, expected: Record<string, unknown> = params): void {
	assert.deepStrictEqual(paramsRoundTrip(method, params), expected);
}

function assertUnexpressible(fn: () => unknown, kind: McpUnexpressibleKind, reason: string): void {
	// a function, not an arrow: the browser test runner's assert tries the validator as a class (instanceof) first
	assert.throws(fn, function (err: unknown) {
		assert.ok(err instanceof McpUnexpressibleError, `expected McpUnexpressibleError, got ${String(err)}`);
		assert.strictEqual(err.kind, kind, `kind of '${err.reason}'`);
		assert.ok(err.reason.includes(reason), `reason '${err.reason}' includes '${reason}'`);
		return true;
	});
}

const PNG = 'iVBORw0KGgo=';

suite('MCP - gRPC typed binding', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('the RPC table', () => {
		test('has the eight RPCs of the proto service with their methods and routing keys', () => {
			assert.strictEqual(TYPED_RPCS.length, 8);
			assert.deepStrictEqual(TYPED_RPCS.map(r => [r.name, r.jsonRpcMethod, r.routingKey]), [
				['ListResources', 'resources/list', undefined],
				['ReadResource', 'resources/read', 'mcp_resource'],
				['ListResourceTemplates', 'resources/templates/list', undefined],
				['ListPrompts', 'prompts/list', undefined],
				['GetPrompt', 'prompts/get', 'mcp_prompt'],
				['ListTools', 'tools/list', undefined],
				['CallTool', 'tools/call', 'mcp_tool'],
				['Complete', 'completion/complete', 'mcp_resource'],
			]);
			for (const rpc of TYPED_RPCS) {
				assert.strictEqual(rpc.path, `${TYPED_PATH_PREFIX}${rpc.name}`);
				assert.strictEqual(typedRpcForMethod(rpc.jsonRpcMethod), rpc);
				assert.strictEqual(typedRpcForPath(rpc.path), rpc);
			}
			assert.strictEqual(rpcOf('tools/call').path, '/model_context_protocol.Mcp/CallTool');
			assert.strictEqual(typedRpcForMethod('server/discover'), undefined);
			assert.strictEqual(typedRpcForMethod('subscriptions/listen'), undefined);
			assert.strictEqual(typedRpcForPath('/model_context_protocol.Mcp/Initialize'), undefined);
			assert.strictEqual(typedRpcForPath(TUNNEL_CALL_PATH), undefined);
		});
	});

	suite('results survive a round trip', () => {
		test('tools/list', () => {
			expectResult('tools/list', {
				_meta: { 'io.modelcontextprotocol/serverInfo': { name: 's', version: '1' } },
				ttlMs: 1500,
				cacheScope: 'public',
				tools: [
					{
						name: 'add', title: 'Add', description: 'Adds',
						icons: [{ src: 'https://x.example/i.png', mimeType: 'image/png', sizes: ['48x48', 'any'], theme: 'dark' }],
						inputSchema: { type: 'object', properties: { a: { type: 'integer', minimum: 0 }, b: { type: 'number', maximum: 2.5 } }, required: ['a'], additionalProperties: false },
						outputSchema: { type: 'object', properties: { sum: { type: 'integer' } } },
						annotations: { title: 'T', readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: true },
						_meta: { k: 'v' },
					},
					{ name: 'min', inputSchema: { type: 'object' } },
				],
			});
		});

		test('resources/list, resources/templates/list and prompts/list', () => {
			expectResult('resources/list', {
				ttlMs: 0, cacheScope: 'private',
				resources: [
					{ name: 'r', title: 'R', uri: 'test://r', description: 'd', mimeType: 'text/plain', annotations: { audience: ['assistant'], priority: 0.5, lastModified: '2026-09-30T00:00:00Z' }, size: 12, icons: [{ src: 'data:image/png;base64,AA==' }], _meta: { x: [1, 2] } },
					{ name: 'b', uri: 'test://b' },
				],
			});
			expectResult('resources/templates/list', {
				resourceTemplates: [{ name: 't', title: 'T', uriTemplate: 'test://t/{id}', description: 'd', mimeType: 'application/json', annotations: { priority: 1 }, _meta: { y: true } }],
			});
			expectResult('prompts/list', {
				ttlMs: 60000,
				prompts: [{ name: 'p', title: 'P', description: 'd', arguments: [{ name: 'a', title: 'A', description: 'first', required: true }, { name: 'b' }], _meta: { z: null } }],
			});
		});

		test('tools/call with every content block, structuredContent and isError', () => {
			const result = {
				_meta: { trace: 't1' },
				content: [
					{ type: 'text', text: 'hi', annotations: { audience: ['user', 'assistant'], priority: 0.3, lastModified: '2026-01-01T00:00:00Z' }, _meta: { x: 1 } },
					{ type: 'image', data: PNG, mimeType: 'image/png', annotations: { priority: 0.75 } },
					{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav', _meta: { seconds: 1.5 } },
					{ type: 'resource', resource: { uri: 'test://e', mimeType: 'text/plain', text: 'embedded', _meta: { m: 'n' } }, annotations: { priority: 1 }, _meta: { e: 1 } },
					{ type: 'resource', resource: { uri: 'test://b', mimeType: 'application/octet-stream', blob: 'AAEC' } },
					{ type: 'resource_link', name: 'l', uri: 'test://l', title: 'Link', description: 'd', mimeType: 'text/html', size: 42, annotations: { audience: ['user'] }, icons: [{ src: 'https://x.example/l.svg', theme: 'light' }], _meta: { l: 2 } },
				],
				structuredContent: { sum: 42, items: [1.5, 'x', null, true, { deep: [[]] }] },
				isError: true,
			};
			expectResult('tools/call', result);

			// The bytes fields carry the base64 text, as in the reference transport.
			const message = decodeMessage(CALL_TOOL_RESPONSE, encodeTypedResponse(rpcOf('tools/call'), result));
			const content = message.content as Record<string, Record<string, unknown>>[];
			assert.strictEqual(decodeUtf8(content[1].image.data as Uint8Array), PNG);
			assert.strictEqual(decodeUtf8(content[2].audio.data as Uint8Array), 'UklGRg==');
			assert.strictEqual(decodeUtf8((content[4].embedded_resource.contents as Record<string, unknown>).blob as Uint8Array), 'AAEC');
			assert.strictEqual((message.common as Record<string, unknown>).result_type, RESULT_TYPE.RESULT_TYPE_COMPLETE);
			assert.strictEqual(message.is_error, true);
		});

		test('resources/read, prompts/get and completion/complete', () => {
			expectResult('resources/read', {
				ttlMs: 2001, cacheScope: 'public',
				contents: [
					{ uri: 'test://t', mimeType: 'text/plain', text: 'hello' },
					{ uri: 'test://b', mimeType: 'image/png', blob: PNG, _meta: { k: 1 } },
					{ uri: 'test://empty', text: '' },
				],
			});
			expectResult('prompts/get', {
				description: 'A prompt',
				messages: [
					{ role: 'user', content: { type: 'text', text: 'Describe' } },
					{ role: 'assistant', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
					{ role: 'user', content: { type: 'resource', resource: { uri: 'test://r', text: 'body' } } },
					{ role: 'user', content: { type: 'resource_link', name: 'n', uri: 'test://n' } },
				],
			});
			expectResult('completion/complete', { completion: { values: ['a', 'b'], total: 10, hasMore: true } });
			expectResult('completion/complete', { completion: { values: [] } });
		});

		test('input_required results with elicitation, sampling and roots requests', () => {
			const form = {
				message: 'Who?',
				requestedSchema: {
					type: 'object',
					properties: {
						name: { type: 'string', title: 'Name', description: 'Your name', minLength: 1, maxLength: 40, format: 'email', default: 'a@b.example' },
						age: { type: 'integer', minimum: 0, maximum: 150, default: 30 },
						ratio: { type: 'number', minimum: 0.5, default: 1.5 },
						plain: { type: 'integer' },
						ok: { type: 'boolean', title: 'OK', default: true },
						color: { type: 'string', enum: ['red', 'blue'], default: 'red' },
						size: { type: 'string', title: 'Size', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
						tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['x', 'y'] }, default: ['x'] },
						titled: { type: 'array', items: { anyOf: [{ const: 'p', title: 'P' }] } },
					},
					required: ['name'],
				},
			};
			const sampling = {
				messages: [
					{ role: 'user', content: { type: 'text', text: 'Hi' } },
					{ role: 'assistant', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
				],
				modelPreferences: { hints: [{ name: 'claude' }], costPriority: 0.25, speedPriority: 0.5, intelligencePriority: 1 },
				systemPrompt: 'Be brief',
				includeContext: 'thisServer',
				temperature: 0.7,
				maxTokens: 100,
				stopSequences: ['END'],
			};
			const result = {
				resultType: 'input_required',
				_meta: { m: 1 },
				requestState: 'opaque-state',
				inputRequests: {
					form: { method: 'elicitation/create', params: form },
					link: { method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', url: 'https://x.example/auth' } },
					sample: { method: 'sampling/createMessage', params: sampling },
					roots: { method: 'roots/list' },
				},
			};
			// The key of a URL elicitation travels in UrlMode.id and comes back as elicitationId.
			const expected = {
				...result,
				inputRequests: {
					...result.inputRequests,
					link: { method: 'elicitation/create', params: { mode: 'url', message: 'Sign in', url: 'https://x.example/auth', elicitationId: 'link' } },
				},
			};
			assert.deepStrictEqual(resultRoundTrip('tools/call', result), expected);
			assert.deepStrictEqual(resultRoundTrip('tools/call', expected), expected);
			expectResult('resources/read', { resultType: 'input_required', requestState: 'only-state' }, { resultType: 'input_required', requestState: 'only-state' });
		});

		test('a sampling message with a one-element content list arrives as that block', () => {
			const decoded = resultRoundTrip('tools/list', {
				resultType: 'input_required',
				inputRequests: { s: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }] }], maxTokens: 1 } } },
			});
			assert.deepStrictEqual(decoded, {
				resultType: 'input_required',
				inputRequests: { s: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'one' } }], maxTokens: 1 } } },
			});
		});
	});

	suite('params survive a round trip', () => {
		test('every method', () => {
			expectParams('tools/list', {
				_meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: {} }, 'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' }, progressToken: 7 },
			});
			expectParams('resources/list', {});
			expectParams('resources/templates/list', { _meta: { a: 1 } });
			expectParams('prompts/list', { _meta: {} });
			expectParams('resources/read', { _meta: { a: 1 }, uri: 'test://r' });
			expectParams('prompts/get', { name: 'p', arguments: { arg1: 'x', arg2: '' } });
			expectParams('tools/call', {
				_meta: { progressToken: 'p' },
				name: 'add',
				arguments: { a: 1, b: { c: [true, null, 's', 2.5] } },
				requestState: 'st',
				inputResponses: {
					e: { action: 'accept', content: { name: 'Bob', n: 3, tags: ['x'] } },
					d: { action: 'decline' },
					s: { role: 'assistant', content: { type: 'text', text: 'Paris' }, model: 'm1', stopReason: 'endTurn' },
					r: { roots: [{ uri: 'file:///a', name: 'A' }, { uri: 'file:///b' }] },
				},
			});
			expectParams('tools/call', { name: 'no_arguments' });
			expectParams('tools/call', { name: 'empty_arguments', arguments: {} });
			expectParams('completion/complete', { ref: { type: 'ref/prompt', name: 'p', title: 'P' }, argument: { name: 'a', value: 'x' }, context: { arguments: { b: 'y' } } });
			expectParams('completion/complete', { ref: { type: 'ref/resource', uri: 'test://t/{id}' }, argument: { name: 'id', value: '1' } });
		});

		test('an empty cursor and null fields count as absent', () => {
			expectParams('tools/list', { cursor: '', _meta: null }, {});
		});
	});

	suite('the typed binding refuses what the messages cannot carry', () => {
		test('results', () => {
			const cases: [string, Record<string, unknown>, string][] = [
				['tools/call', { content: [], structuredContent: [1, 2] }, 'structuredContent that is not a JSON object'],
				['tools/call', { resultType: 'task', task: {} }, 'a result of the type task'],
				['tools/list', { tools: [], nextCursor: 'abc' }, 'the field nextCursor of the tools/list result'],
				['tools/list', { tools: [{ name: 't', inputSchema: {}, execution: {} }] }, 'the field execution of a tool'],
				['tools/call', { content: [{ type: 'tool_use', id: '1', name: 't', input: {} }] }, 'a content block of the type tool_use'],
				['tools/call', { content: [], structuredContent: { n: 9007199254740993 } }, 'structuredContent'],
				['tools/call', { resultType: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1, tools: [] } } } }, 'the field tools of sampling params'],
				['tools/call', { resultType: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1, toolChoice: { mode: 'auto' } } } } }, 'the field toolChoice of sampling params'],
				['tools/call', { resultType: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: { messages: [{ role: 'assistant', content: { type: 'tool_use', id: '1', name: 't', input: {} } }], maxTokens: 1 } } } }, 'a content block of the type tool_use'],
				['tools/call', { resultType: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: [] }], maxTokens: 1 } } } }, 'a sampling message with 0 content blocks'],
				['tools/call', { resultType: 'input_required', inputRequests: { f: { method: 'elicitation/create', params: { message: 'm', requestedSchema: { $schema: 'x', type: 'object', properties: {} } } } } }, 'the field $schema of requestedSchema'],
				['tools/call', { resultType: 'input_required', inputRequests: { f: { method: 'elicitation/create', params: { message: 'm', requestedSchema: { type: 'object', properties: { o: { type: 'object' } } } } } } }, 'a property schema of the type object'],
				['tools/call', { resultType: 'input_required', inputRequests: { p: { method: 'ping' } } }, 'an input request of the method ping'],
				['resources/list', { resources: [{ name: 'r', uri: 'u', annotations: { priority: 1e40 } }] }, 'annotations.priority is outside the range of a float'],
			];
			for (const [method, result, reason] of cases) {
				assertUnexpressible(() => encodeTypedResponse(rpcOf(method), result), 'unexpressible', reason);
			}
		});

		test('params', () => {
			const cases: [string, Record<string, unknown>, string][] = [
				['prompts/list', { cursor: 'abc' }, 'a cursor: the typed binding has no pagination'],
				['tools/call', { name: 't', arguments: { big: -9007199254740993 } }, 'tool arguments'],
				['tools/call', { name: 't', inputResponses: { e: { action: 'accept', _meta: {} } } }, 'the field _meta of an elicitation result'],
				['tools/call', { name: 't', inputResponses: { s: { role: 'user', content: [], model: 'm' } } }, 'a sampling message with 0 content blocks'],
				['tools/call', { name: 't', inputResponses: { x: { something: 1 } } }, 'an input response that is not an elicitation, sampling or roots result'],
				['tools/call', { name: 't', task: {} }, 'the field task of the params of tools/call'],
			];
			for (const [method, params, reason] of cases) {
				assertUnexpressible(() => encodeTypedRequest(rpcOf(method), params), 'unexpressible', reason);
			}
		});

		test('values without the shape of their MCP type are invalid', () => {
			assertUnexpressible(() => encodeTypedResponse(rpcOf('tools/call'), { content: [{ type: 'text' }] }), 'invalid', 'a text content block has no text');
			assertUnexpressible(() => encodeTypedResponse(rpcOf('resources/read'), { contents: [{ uri: 'u', text: 'a', blob: 'b' }] }), 'invalid', 'exactly one of text and blob');
			assertUnexpressible(() => encodeTypedResponse(rpcOf('tools/list'), { tools: [{ name: 't' }] }), 'invalid', 'a tool has no inputSchema');
			assertUnexpressible(() => encodeTypedRequest(rpcOf('completion/complete'), { ref: { type: 'ref/other' }, argument: { name: 'a', value: 'b' } }), 'invalid', 'the reference type ref/other');
			assertUnexpressible(() => encodeTypedRequest(rpcOf('tools/call'), 'params'), 'invalid', 'params is not an object');
		});
	});

	suite('decoding rejects invalid messages', () => {
		test('missing required parts', () => {
			assertUnexpressible(() => decodeTypedRequest(rpcOf('tools/call'), new Uint8Array(0)), 'invalid', 'Missing tool name');
			// request = 2 {} with an empty name.
			assertUnexpressible(() => decodeTypedRequest(rpcOf('tools/call'), Uint8Array.of(0x12, 0x00)), 'invalid', 'Missing tool name');
			assertUnexpressible(() => decodeTypedRequest(rpcOf('resources/read'), new Uint8Array(0)), 'invalid', 'Missing resource URI');
			assertUnexpressible(() => decodeTypedRequest(rpcOf('prompts/get'), new Uint8Array(0)), 'invalid', 'Missing prompt name');
			// argument = 4 {} without a reference.
			assertUnexpressible(() => decodeTypedRequest(rpcOf('completion/complete'), Uint8Array.of(0x22, 0x00)), 'invalid', 'A completion request has no reference');
			// common = 1 { result_type = 9: 7 }: a result type MCP does not have.
			assertUnexpressible(() => decodeTypedResponse(rpcOf('tools/list'), Uint8Array.of(0x0a, 0x02, 0x48, 0x07)), 'invalid', 'the result type 7');
			// content = 2 { image = 2 { data = 1 "!!" } }: image data that is not base64 text.
			assertUnexpressible(() => decodeTypedResponse(rpcOf('tools/call'), Uint8Array.of(0x12, 0x06, 0x12, 0x04, 0x0a, 0x02, 0x21, 0x21)), 'invalid', 'the data of an image or audio block is not base64 text');
		});

		test('malformed protobuf is a decode error, not a conversion error', () => {
			assert.throws(() => decodeTypedRequest(rpcOf('tools/list'), Uint8Array.of(0x0a, 0x05)), function (err: unknown) { return err instanceof ProtoDecodeError && err.reason === 'truncated'; });
		});

		test('a choice with two members gives invalid', () => {
			const callTool = rpcOf('tools/call');
			const listTools = rpcOf('tools/list');
			assertUnexpressible(() => decodeTypedResponse(callTool, encodeMessage(CALL_TOOL_RESPONSE, { content: [{ text: {}, image: {} }] })), 'invalid', 'a content block with 2 kinds');
			assertUnexpressible(() => decodeTypedResponse(listTools, encodeMessage(LIST_TOOLS_RESPONSE, {
				common: { result_type: RESULT_TYPE.RESULT_TYPE_INPUT_REQUIRED, input_requests: { k: { list_roots_request: {}, elicit_request: {} } } },
			})), 'invalid', 'an input request with 2 kinds');
			assertUnexpressible(() => decodeTypedRequest(listTools, encodeMessage(LIST_TOOLS_REQUEST, {
				common: { input_responses: { k: { root_list_result: {}, elicit_result: {} } } },
			})), 'invalid', 'an input response with 2 kinds');
			assertUnexpressible(() => decodeTypedResponse(listTools, encodeMessage(LIST_TOOLS_RESPONSE, {
				common: { result_type: RESULT_TYPE.RESULT_TYPE_INPUT_REQUIRED, input_requests: { k: { elicit_request: { requested_schema: { p: { string_schema: {}, boolean_schema: {} } } } } } },
			})), 'invalid', 'a property schema with 2 kinds');
			assertUnexpressible(() => decodeTypedResponse(listTools, encodeMessage(LIST_TOOLS_RESPONSE, {
				common: { result_type: RESULT_TYPE.RESULT_TYPE_INPUT_REQUIRED, input_requests: { k: { elicit_request: { requested_schema: { p: { number_schema: { double_range: {}, integer_range: {} } } } } } } },
			})), 'invalid', 'a number schema with two ranges');
		});
	});

	suite('the lossy parts of the mapping', () => {
		test('absent proto3 scalars are omitted so that MCP defaults apply', () => {
			// A false hint and the proto3 default are the same: the receiver sees an absent hint (and MCP's default is true).
			assert.deepStrictEqual(resultRoundTrip('tools/list', {
				tools: [{ name: 't', inputSchema: { type: 'object' }, annotations: { destructiveHint: false, openWorldHint: false } }],
			}), { resultType: 'complete', tools: [{ name: 't', inputSchema: { type: 'object' }, annotations: {} }] });
			// Empty optional strings and false booleans are absent on arrival.
			assert.deepStrictEqual(resultRoundTrip('prompts/list', {
				prompts: [{ name: 'p', title: '', description: '', arguments: [{ name: 'a', required: false }] }],
			}), { resultType: 'complete', prompts: [{ name: 'p', arguments: [{ name: 'a' }] }] });
			// An unset ttl and cache scope stay absent; a boolean default false is no default.
			assert.deepStrictEqual(resultRoundTrip('tools/call', {
				resultType: 'input_required',
				inputRequests: { f: { method: 'elicitation/create', params: { mode: 'form', message: 'm', requestedSchema: { type: 'object', properties: { b: { type: 'boolean', default: false } } } } } },
			}), {
				resultType: 'input_required',
				inputRequests: { f: { method: 'elicitation/create', params: { message: 'm', requestedSchema: { type: 'object', properties: { b: { type: 'boolean' } } } } } },
			});
		});

		test('an empty blob arrives as an empty text', () => {
			assert.deepStrictEqual(resultRoundTrip('resources/read', { contents: [{ uri: 'test://x', blob: '' }] }), { resultType: 'complete', contents: [{ uri: 'test://x', text: '' }] });
		});

		test('the legacy enumNames form arrives as oneOf', () => {
			assert.deepStrictEqual(resultRoundTrip('tools/call', {
				resultType: 'input_required',
				inputRequests: { f: { method: 'elicitation/create', params: { message: 'm', requestedSchema: { type: 'object', properties: { e: { type: 'string', enum: ['a'], enumNames: ['A'] } } } } } },
			}), {
				resultType: 'input_required',
				inputRequests: { f: { method: 'elicitation/create', params: { message: 'm', requestedSchema: { type: 'object', properties: { e: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] } } } } } },
			});
		});

		test('priorities are 32-bit floats with the shortest round-trip decimal', () => {
			const priorityOf = (priority: number) => {
				const decoded = resultRoundTrip('resources/list', { resources: [{ name: 'n', uri: 'u', annotations: { priority } }] });
				const resources = decoded.resources as { annotations: { priority: number } }[];
				return resources[0].annotations.priority;
			};
			assert.strictEqual(priorityOf(0.123456789), 0.12345679);
			assert.strictEqual(priorityOf(0.3), 0.3);
			assert.strictEqual(priorityOf(1), 1);
			assert.strictEqual(priorityOf(0), 0);
			assert.strictEqual(Math.fround(priorityOf(0.1)), Math.fround(0.1));
		});
	});

	suite('routing metadata', () => {
		test('names the tool, the prompt, the resource or the completion reference', () => {
			assert.deepStrictEqual(routingMetadataFor(rpcOf('tools/call'), { name: 'add' }), { mcp_tool: 'add' });
			assert.deepStrictEqual(routingMetadataFor(rpcOf('prompts/get'), { name: 'p' }), { mcp_prompt: 'p' });
			assert.deepStrictEqual(routingMetadataFor(rpcOf('resources/read'), { uri: 'test://r' }), { mcp_resource: 'test://r' });
			assert.deepStrictEqual(routingMetadataFor(rpcOf('completion/complete'), { ref: { type: 'ref/prompt', name: 'p' } }), { mcp_resource: 'p' });
			assert.deepStrictEqual(routingMetadataFor(rpcOf('completion/complete'), { ref: { type: 'ref/resource', uri: 'test://t/{id}' } }), { mcp_resource: 'test://t/{id}' });
			assert.deepStrictEqual(routingMetadataFor(rpcOf('completion/complete'), { ref: { type: 'ref/other' } }), {});
			assert.deepStrictEqual(routingMetadataFor(rpcOf('tools/list'), {}), {});
			assert.deepStrictEqual(routingMetadataFor(rpcOf('tools/call'), { name: 7 }), {});
			assert.deepStrictEqual(routingMetadataFor(rpcOf('tools/call'), undefined), {});
		});
	});

	suite('server/discover', () => {
		test('is synthesized from the authority', () => {
			assert.deepStrictEqual(synthesizeDiscoverResult('mcp.example:50051'), {
				supportedVersions: ['2026-07-28'],
				capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
				ttlMs: 0,
				cacheScope: 'private',
				resultType: 'complete',
				_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'mcp.example:50051', version: '' } },
			});
		});

		test('takes serverInfo and instructions from what a typed response told', () => {
			const serverInfo = { name: 'mcp-conformance-test-server', version: '0.1.0', title: 'Conformance' };
			assert.deepStrictEqual(synthesizeDiscoverResult('127.0.0.1:50052', { serverInfo, instructions: 'Use echo.' }), {
				supportedVersions: ['2026-07-28'],
				capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
				ttlMs: 0,
				cacheScope: 'private',
				resultType: 'complete',
				instructions: 'Use echo.',
				_meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
			});
			assert.deepStrictEqual(synthesizeDiscoverResult('127.0.0.1:50052', { instructions: 'Use echo.' })._meta, { 'io.modelcontextprotocol/serverInfo': { name: '127.0.0.1:50052', version: '' } });
		});
	});

	suite('decodeTypedServerIdentity', () => {
		const listTools = () => rpcOf('tools/list');
		const withCommon = (common: Record<string, unknown>) => encodeMessage(LIST_TOOLS_RESPONSE, { common, tools: [] });

		test('reads serverInfo from common.metadata and instructions from common.instructions', () => {
			const serverInfo = { name: 'mcp-conformance-test-server', version: '0.1.0', icons: [{ src: 'https://example.com/i.png' }] };
			assert.deepStrictEqual(decodeTypedServerIdentity(listTools(), withCommon({
				instructions: 'Use echo.',
				metadata: jsonToStruct({ 'io.modelcontextprotocol/serverInfo': serverInfo, other: 1 }),
			})), { serverInfo, instructions: 'Use echo.' });
		});

		test('a server encoding its _meta the way encodeTypedResponse does is understood', () => {
			const serverInfo = { name: 'typed', version: '2' };
			const bytes = encodeTypedResponse(listTools(), { resultType: 'complete', tools: [], ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } });
			assert.deepStrictEqual(decodeTypedServerIdentity(listTools(), bytes), { serverInfo });
		});

		test('leaves out what is absent, empty or not of its MCP shape', () => {
			const meta = (info: unknown) => withCommon({ metadata: jsonToStruct({ 'io.modelcontextprotocol/serverInfo': info }) });
			assert.deepStrictEqual([
				decodeTypedServerIdentity(listTools(), encodeMessage(LIST_TOOLS_RESPONSE, { tools: [] })),
				decodeTypedServerIdentity(listTools(), withCommon({ instructions: '' })),
				decodeTypedServerIdentity(listTools(), meta({ name: '', version: '1' })),
				decodeTypedServerIdentity(listTools(), meta({ version: '1' })),
				decodeTypedServerIdentity(listTools(), meta('a string')),
				decodeTypedServerIdentity(listTools(), meta({ name: 'no-version' })),
				decodeTypedServerIdentity(listTools(), new Uint8Array([0xff, 0xff, 0xff])),
			], [{}, {}, {}, {}, {}, { serverInfo: { name: 'no-version', version: '' } }, {}]);
		});
	});
});
