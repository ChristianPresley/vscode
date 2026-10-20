/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IMcpGatewayInputRequired, IMcpGatewayInvokeContext } from '../../common/mcpGateway.js';
import { McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { collectHeaderAnnotations } from '../../common/mcpHttpHeaders.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { CONFORMANCE_HIDDEN_PROMPT, CONFORMANCE_HIDDEN_TOOL, CONFORMANCE_PROMPT_NAMES, CONFORMANCE_RESOURCE_TEMPLATE, CONFORMANCE_RESOURCE_URIS, CONFORMANCE_SERVER_INFO, CONFORMANCE_TOOL_NAMES, JSON_SCHEMA_2020_12_TOOL_SCHEMA, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { isGatewayInputRequired, McpGatewayResourceNotFoundError } from '../../node/mcpGatewayDispatcher.js';

function invokeContext(overrides: Partial<IMcpGatewayInvokeContext> = {}): IMcpGatewayInvokeContext {
	return { protocolVersion: '2026-07-28', clientCapabilities: { elicitation: {}, sampling: {}, roots: {} }, token: CancellationToken.None, ...overrides };
}

function textOf(result: MCPLegacy.CallToolResult | IMcpGatewayInputRequired): string {
	assert.ok(!isGatewayInputRequired(result), 'expected a complete result');
	const first = result.content[0];
	return first?.type === 'text' ? first.text : '';
}

function inputRequestsOf(result: MCPLegacy.CallToolResult | MCPLegacy.GetPromptResult | IMcpGatewayInputRequired): MCP.InputRequests {
	assert.ok(isGatewayInputRequired(result), 'expected input_required');
	return result.inputRequests ?? {};
}

suite('MCP - GatewayConformanceInvoker', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('identifies as the conformance test server', () => {
		assert.deepStrictEqual(CONFORMANCE_SERVER_INFO, { name: 'mcp-conformance-test-server', version: '1.0.0' });
		const invoker = store.add(new McpGatewayConformanceInvoker());
		assert.deepStrictEqual(invoker.capabilities, { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { subscribe: true, listChanged: true }, completions: true, logging: true });
		assert.ok(invoker.instructions.length > 0);
		assert.ok(invoker.cacheHints.ttlMs >= 0);
	});

	test('every tool has a valid name (SEP-986), a description and an object schema', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		for (const name of CONFORMANCE_TOOL_NAMES) {
			assert.ok(name.length >= 1 && name.length <= 64 && !name.includes('/') && /^[A-Za-z0-9_.-]+$/.test(name), name);
		}
		invoker.setToolHidden(CONFORMANCE_HIDDEN_TOOL, false);
		const tools = await invoker.listTools();
		assert.deepStrictEqual(tools.map(t => t.name).sort(), [...CONFORMANCE_TOOL_NAMES].sort());
		for (const tool of tools) {
			assert.ok(tool.description, `${tool.name} has a description`);
			assert.strictEqual(tool.inputSchema.type, 'object', tool.name);
		}
		for (const name of ['test_simple_text', 'test_image_content', 'test_audio_content', 'test_embedded_resource', 'test_multiple_content_types', 'test_error_handling', 'test_tool_with_progress', 'test_tool_with_logging', 'test_sampling', 'test_elicitation', 'test_elicitation_sep1034_defaults', 'test_elicitation_sep1330_enums', 'test_missing_capability', 'test_streaming_elicitation', 'test_logging_tool', 'test_trigger_tool_change', 'test_trigger_prompt_change', 'json_schema_2020_12_tool', 'test_x_mcp_header']) {
			assert.ok(CONFORMANCE_TOOL_NAMES.includes(name), name);
		}
		assert.strictEqual(CONFORMANCE_TOOL_NAMES.filter(name => name.startsWith('test_input_required_result_')).length, 8);
	});

	test('visibility toggles fire the list-changed events only on a change', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		let tools = 0;
		let prompts = 0;
		store.add(invoker.onDidChangeTools(() => tools++));
		store.add(invoker.onDidChangePrompts(() => prompts++));
		assert.ok(!(await invoker.listTools()).some(t => t.name === CONFORMANCE_HIDDEN_TOOL));
		await assert.rejects(invoker.callTool(CONFORMANCE_HIDDEN_TOOL, {}), (e: unknown) => e instanceof McpGatewayRpcError && e.code === MCP.INVALID_PARAMS);
		invoker.setToolHidden(CONFORMANCE_HIDDEN_TOOL, true);
		assert.strictEqual(tools, 0);
		await invoker.callTool('test_trigger_tool_change', {});
		assert.strictEqual(tools, 1);
		assert.strictEqual(textOf(await invoker.callTool(CONFORMANCE_HIDDEN_TOOL, {})), 'hidden');
		await invoker.callTool('test_trigger_prompt_change', {});
		assert.strictEqual(prompts, 1);
		assert.ok((await invoker.listPrompts()).some(p => p.name === CONFORMANCE_HIDDEN_PROMPT));
		invoker.setPromptHidden(CONFORMANCE_HIDDEN_PROMPT, true);
		assert.strictEqual(prompts, 2);
		await assert.rejects(invoker.getPrompt(CONFORMANCE_HIDDEN_PROMPT, undefined), (e: unknown) => e instanceof McpGatewayRpcError);
	});

	test('content tools return the content types the suite checks', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const kinds = async (name: string) => {
			const result = await invoker.callTool(name, {});
			assert.ok(!isGatewayInputRequired(result));
			return result.content.map(c => c.type);
		};
		assert.deepStrictEqual(await kinds('test_simple_text'), ['text']);
		assert.deepStrictEqual(await kinds('test_image_content'), ['image']);
		assert.deepStrictEqual(await kinds('test_audio_content'), ['audio']);
		assert.deepStrictEqual(await kinds('test_embedded_resource'), ['resource']);
		assert.deepStrictEqual(await kinds('test_multiple_content_types'), ['text', 'image', 'resource']);
		const error = await invoker.callTool('test_error_handling', {});
		assert.ok(!isGatewayInputRequired(error) && error.isError === true);
		assert.strictEqual(textOf(await invoker.callTool('json_schema_2020_12_tool', { name: 'x' })), '{"name":"x"}');
		assert.strictEqual(textOf(await invoker.callTool('test_x_mcp_header', { region: 'eu', priority: 2, verbose: true })), 'region=eu priority=2 verbose=true');
		await assert.rejects(invoker.callTool('nope', {}), (e: unknown) => e instanceof McpGatewayRpcError && e.code === MCP.INVALID_PARAMS);
	});

	test('progress and log callbacks are driven through the invoke context', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const progress: number[] = [];
		const logs: string[] = [];
		await invoker.callTool('test_tool_with_progress', {}, invokeContext({ onProgress: p => progress.push(p.progress) }));
		await invoker.callTool('test_tool_with_logging', {}, invokeContext({ onLog: (level, data) => logs.push(`${level}:${data}`) }));
		assert.deepStrictEqual(progress, [0, 50, 100]);
		assert.deepStrictEqual(logs, ['info:Tool execution started', 'info:Tool processing data', 'info:Tool execution completed']);
	});

	test('the schema fixtures: JSON Schema 2020-12 keywords and x-mcp-header annotations', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const tools = await invoker.listTools();
		const schemaTool = tools.find(t => t.name === 'json_schema_2020_12_tool')!;
		assert.deepStrictEqual(schemaTool.inputSchema, JSON_SCHEMA_2020_12_TOOL_SCHEMA);
		const headerTool = tools.find(t => t.name === 'test_x_mcp_header')!;
		const annotations = collectHeaderAnnotations(headerTool.inputSchema);
		assert.strictEqual(annotations.kind, 'valid');
		assert.deepStrictEqual(annotations.kind === 'valid' ? annotations.annotations.map(a => a.header).sort() : [], ['Priority', 'Region', 'Verbose']);
		const annotated = tools.filter(t => Object.values(t.inputSchema.properties ?? {}).some(p => (p as Record<string, unknown>)['x-mcp-header'] !== undefined));
		assert.deepStrictEqual(annotated.map(t => t.name), ['test_x_mcp_header'], 'the suite picks the first annotated tool');
	});

	test('elicitation fixtures carry the SEP-1034 defaults and the five SEP-1330 enum shapes', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const defaults = inputRequestsOf(await invoker.callTool('test_elicitation_sep1034_defaults', {})).defaults as MCP.ElicitRequest;
		const props = (defaults.params as MCP.ElicitRequestFormParams).requestedSchema.properties as Record<string, { default?: unknown; type?: string }>;
		assert.deepStrictEqual(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, [v.type, v.default]])), {
			name: ['string', 'John Doe'], age: ['integer', 30], score: ['number', 95.5], status: ['string', 'active'], verified: ['boolean', true],
		});
		const enums = inputRequestsOf(await invoker.callTool('test_elicitation_sep1330_enums', {})).enums as MCP.ElicitRequest;
		assert.deepStrictEqual(Object.keys((enums.params as MCP.ElicitRequestFormParams).requestedSchema.properties), ['untitledSingle', 'titledSingle', 'legacyEnum', 'untitledMulti', 'titledMulti']);
		const done = await invoker.callTool('test_elicitation_sep1330_enums', {}, invokeContext({ inputResponses: { enums: { action: 'accept', content: { untitledSingle: 'option1' } } } }));
		assert.ok(textOf(done).startsWith('Elicitation completed: action=accept'));
	});

	test('the MRTR tools ask for the right inputs and complete with the answers', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const methods = (requests: MCP.InputRequests) => Object.fromEntries(Object.entries(requests).map(([k, v]) => [k, v.method]));
		assert.deepStrictEqual(methods(inputRequestsOf(await invoker.callTool('test_input_required_result_elicitation', {}))), { user_name: 'elicitation/create' });
		assert.deepStrictEqual(methods(inputRequestsOf(await invoker.callTool('test_input_required_result_sampling', {}))), { capital_question: 'sampling/createMessage' });
		assert.deepStrictEqual(methods(inputRequestsOf(await invoker.callTool('test_input_required_result_list_roots', {}))), { client_roots: 'roots/list' });
		assert.deepStrictEqual(methods(inputRequestsOf(await invoker.callTool('test_input_required_result_multiple_inputs', {}))), { user_name: 'elicitation/create', greeting: 'sampling/createMessage', client_roots: 'roots/list' });

		assert.strictEqual(textOf(await invoker.callTool('test_input_required_result_elicitation', {}, invokeContext({ inputResponses: { user_name: { action: 'accept', content: { name: 'Alice' } } } }))), 'Hello, Alice!');
		assert.strictEqual(textOf(await invoker.callTool('test_input_required_result_elicitation', {}, invokeContext({ inputResponses: { user_name: { action: 'decline' } } }))), 'The user declined');
		assert.ok(textOf(await invoker.callTool('test_input_required_result_sampling', {}, invokeContext({ inputResponses: { capital_question: { role: 'assistant', content: { type: 'text', text: 'Paris' }, model: 'm' } } }))).includes('Paris'));
		assert.strictEqual(textOf(await invoker.callTool('test_input_required_result_list_roots', {}, invokeContext({ inputResponses: { client_roots: { roots: [{ uri: 'file:///a' }] } } }))), 'The client has 1 root(s)');

		const state = await invoker.callTool('test_input_required_result_request_state', {});
		assert.ok(isGatewayInputRequired(state) && state.requestState === '{"nonce":"request-state-nonce"}');
		assert.strictEqual(textOf(await invoker.callTool('test_input_required_result_request_state', {}, invokeContext({ inputResponses: { confirm: { action: 'accept', content: { ok: true } } }, requestState: state.requestState }))), 'state-ok request-state-nonce');

		// Partial answers re-request only what is missing.
		const partial = await invoker.callTool('test_input_required_result_multiple_inputs', {}, invokeContext({ inputResponses: { client_roots: { roots: [] } } }));
		assert.deepStrictEqual(Object.keys(inputRequestsOf(partial)).sort(), ['greeting', 'user_name']);

		// Capability-aware requests.
		const none = await invoker.callTool('test_input_required_result_capabilities', {}, invokeContext({ clientCapabilities: {} }));
		assert.strictEqual(textOf(none), 'All declared capabilities were used');
		const roots = await invoker.callTool('test_input_required_result_capabilities', {}, invokeContext({ clientCapabilities: { roots: {} } }));
		assert.deepStrictEqual(Object.keys(inputRequestsOf(roots)), ['client_roots']);

		// The prompt also uses MRTR.
		const prompt = await invoker.getPrompt('test_input_required_result_prompt', undefined);
		assert.deepStrictEqual(Object.keys(inputRequestsOf(prompt)), ['user_context']);
		const promptDone = await invoker.getPrompt('test_input_required_result_prompt', undefined, invokeContext({ inputResponses: { user_context: { action: 'accept', content: { context: 'ctx' } } } }));
		assert.ok(!isGatewayInputRequired(promptDone));
		assert.deepStrictEqual(promptDone.messages[0].content, { type: 'text', text: 'Context: ctx' });
	});

	test('resources: the listed URIs, the template, not-found and updates', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		assert.deepStrictEqual((await invoker.listResources()).map(r => r.uri), CONFORMANCE_RESOURCE_URIS);
		assert.deepStrictEqual((await invoker.listResourceTemplates()).map(t => t.uriTemplate), [CONFORMANCE_RESOURCE_TEMPLATE]);
		const text = (await invoker.readResource('test://static-text')).contents[0] as { text?: string; mimeType?: string };
		assert.ok(text.text && text.mimeType === 'text/plain');
		const binary = (await invoker.readResource('test://static-binary')).contents[0] as { blob?: string; mimeType?: string };
		assert.ok(binary.blob && binary.blob.length > 0 && binary.mimeType === 'image/png');
		const templated = await invoker.readResource('test://template/123/data');
		assert.deepStrictEqual(JSON.parse((templated.contents[0] as { text: string }).text), { id: '123', templateTest: true, data: 'Data for ID: 123' });
		await assert.rejects(invoker.readResource('test://nope'), (e: unknown) => e instanceof McpGatewayResourceNotFoundError && (e.data as { uri: string }).uri === 'test://nope');

		const updates: string[] = [];
		store.add(invoker.onDidUpdateResource(e => updates.push(e.uri)));
		const subscription = await invoker.subscribeResource('test://watched-resource');
		assert.strictEqual(invoker.subscriptionCount('test://watched-resource'), 1);
		invoker.touchResource('test://watched-resource');
		subscription.dispose();
		assert.strictEqual(invoker.subscriptionCount('test://watched-resource'), 0);
		assert.deepStrictEqual(updates, ['test://watched-resource']);
	});

	test('prompts: the six prompts with descriptions, argument substitution and completion', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		invoker.setPromptHidden(CONFORMANCE_HIDDEN_PROMPT, false);
		const prompts = await invoker.listPrompts();
		assert.deepStrictEqual(prompts.map(p => p.name), CONFORMANCE_PROMPT_NAMES);
		assert.ok(prompts.every(p => p.description));
		const withArgs = await invoker.getPrompt('test_prompt_with_arguments', { arg1: 'testValue1', arg2: 'testValue2' });
		assert.ok(!isGatewayInputRequired(withArgs));
		const content = withArgs.messages[0].content;
		assert.ok(content.type === 'text' && content.text.includes('testValue1') && content.text.includes('testValue2'));
		const embedded = await invoker.getPrompt('test_prompt_with_embedded_resource', { resourceUri: 'test://x' });
		assert.ok(!isGatewayInputRequired(embedded) && embedded.messages.some(m => m.content.type === 'resource'));
		const image = await invoker.getPrompt('test_prompt_with_image', undefined);
		assert.ok(!isGatewayInputRequired(image) && image.messages.some(m => m.content.type === 'image'));
		await assert.rejects(invoker.getPrompt('nope', undefined), (e: unknown) => e instanceof McpGatewayRpcError && e.code === MCP.INVALID_PARAMS);

		const completion = await invoker.complete({ ref: { type: 'ref/prompt', name: 'test_prompt_with_arguments' }, argument: { name: 'arg1', value: 'par' } });
		assert.deepStrictEqual(completion, { completion: { values: ['paris', 'park', 'party'], total: 3, hasMore: false } });
		const none = await invoker.complete({ ref: { type: 'ref/prompt', name: 'test_simple_prompt' }, argument: { name: 'x', value: '' } });
		assert.deepStrictEqual(none.completion.values, []);
	});
});
