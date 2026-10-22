/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A smoke test of the fixture server through @grpc/grpc-js clients: both
 * bindings answer, the inventory is what the interop checks expect, and the
 * JSON-RPC errors travel in the trailers.
 */

import assert from 'node:assert';
import { after, before, test } from 'node:test';
import * as grpc from '@grpc/grpc-js';
import { DISCOVER_RESULT, fromStruct, type IFixtureServer, loadDefinitions, PROMPT, PROTOCOL_VERSION, RESOURCE, RESOURCE_TEXT, SERVER_INFO, startFixtureServer, TOOL, toStruct } from './fixtureServer.ts';

type JsonObject = Record<string, unknown>;

const definitions = loadDefinitions();
let fixture: IFixtureServer;
let typed: grpc.Client;
let tunnel: grpc.Client;

before(async () => {
	fixture = await startFixtureServer();
	typed = new definitions.typedClient(fixture.address, grpc.credentials.createInsecure());
	tunnel = new definitions.tunnelClient(fixture.address, grpc.credentials.createInsecure());
});

after(async () => {
	typed.close();
	tunnel.close();
	await fixture.close();
});

const requestMeta = {
	'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
	'io.modelcontextprotocol/clientInfo': { name: 'fixture-smoke', version: '1' },
	'io.modelcontextprotocol/clientCapabilities': {},
};

function metadataOf(extra: Record<string, string>): grpc.Metadata {
	const metadata = new grpc.Metadata();
	metadata.set('mcp-protocol-version', PROTOCOL_VERSION);
	for (const [key, value] of Object.entries(extra)) {
		metadata.set(key, value);
	}
	return metadata;
}

function callTyped(method: string, request: JsonObject, extra: Record<string, string> = {}): Promise<JsonObject> {
	return new Promise((resolve, reject) => {
		const invoke = (typed as unknown as Record<string, (request: JsonObject, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<JsonObject>) => void>)[method];
		invoke.call(typed, request, metadataOf(extra), { deadline: Date.now() + 10000 }, (err, response) => err ? reject(err) : resolve(response!));
	});
}

interface ITunnelOutcome {
	readonly messages: JsonObject[];
	readonly error?: grpc.ServiceError;
}

function callTunnel(method: string, params: JsonObject, extra: Record<string, string> = {}, onMessage?: (message: JsonObject, stream: grpc.ClientReadableStream<JsonObject>) => void): Promise<ITunnelOutcome> {
	return new Promise(resolve => {
		const request = { jsonrpc: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: requestMeta } }), 'utf8') };
		const invoke = (tunnel as unknown as Record<string, (request: JsonObject, metadata: grpc.Metadata) => grpc.ClientReadableStream<JsonObject>>).Call;
		const stream = invoke.call(tunnel, request, metadataOf({ 'mcp-method': method, ...extra }));
		const messages: JsonObject[] = [];
		let error: grpc.ServiceError | undefined;
		stream.on('data', (chunk: JsonObject) => {
			const message = JSON.parse(Buffer.from(chunk.jsonrpc as Uint8Array).toString('utf8')) as JsonObject;
			messages.push(message);
			onMessage?.(message, stream);
		});
		stream.on('error', (err: grpc.ServiceError) => { error = err; });
		stream.on('end', () => resolve({ messages, error }));
		stream.on('close', () => resolve({ messages, error }));
	});
}

test('the typed service lists and calls the inventory', async () => {
	const tools = await callTyped('ListTools', { common: { metadata: toStruct(requestMeta) } });
	const toolList = tools.tools as JsonObject[];
	assert.deepStrictEqual(toolList.map(tool => tool.name), [TOOL.name]);
	assert.deepStrictEqual(fromStruct(toolList[0].input_schema as JsonObject), TOOL.inputSchema);
	const common = tools.common as JsonObject;
	assert.strictEqual(common.result_type, 'RESULT_TYPE_COMPLETE');
	assert.deepStrictEqual(fromStruct(common.metadata as JsonObject), { 'io.modelcontextprotocol/serverInfo': SERVER_INFO });
	assert.strictEqual(tools.cache_scope, 'CACHE_SCOPE_PRIVATE');

	const echo = await callTyped('CallTool', { common: { metadata: toStruct(requestMeta) }, request: { name: TOOL.name, arguments: toStruct({ text: 'hi' }) } }, { mcp_tool: TOOL.name });
	assert.strictEqual(((echo.content as JsonObject[])[0].text as JsonObject).text, 'echo: hi');
	assert.deepStrictEqual(fromStruct(echo.structured_content as JsonObject), { text: 'echo: hi' });

	const prompts = await callTyped('ListPrompts', {});
	assert.deepStrictEqual((prompts.prompts as JsonObject[]).map(prompt => prompt.name), [PROMPT.name]);
	const prompt = await callTyped('GetPrompt', { name: PROMPT.name, arguments: { topic: 'gRPC' } }, { mcp_prompt: PROMPT.name });
	assert.strictEqual(((prompt.messages as JsonObject[])[0].text as JsonObject).text, 'Write about gRPC');

	const resources = await callTyped('ListResources', {});
	assert.deepStrictEqual((resources.resources as JsonObject[]).map(resource => resource.uri), [RESOURCE.uri]);
	const read = await callTyped('ReadResource', { uri: RESOURCE.uri }, { mcp_resource: RESOURCE.uri });
	assert.strictEqual((read.resource as JsonObject[])[0].text, RESOURCE_TEXT);
	const templates = await callTyped('ListResourceTemplates', {});
	assert.deepStrictEqual(templates.resource_templates ?? [], []);

	const completion = await callTyped('Complete', { prompt_reference: { name: PROMPT.name }, argument: { name: 'topic', value: 'b' } }, { mcp_resource: PROMPT.name });
	assert.deepStrictEqual(completion.values, ['beta']);
	assert.strictEqual(completion.total_matches, '1');
});

test('the typed service puts JSON-RPC errors in the trailers', async () => {
	await assert.rejects(callTyped('CallTool', { request: { name: 'no-such-tool' } }), (err: grpc.ServiceError) => {
		assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
		assert.deepStrictEqual(err.metadata.get('mcp-error-code'), ['-32602']);
		return true;
	});
	await assert.rejects(callTyped('CallTool', { request: { name: TOOL.name } }, { mcp_tool: 'other' }), (err: grpc.ServiceError) => {
		assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
		assert.deepStrictEqual(err.metadata.get('mcp-error-code'), ['-32020']);
		const bin = err.metadata.get('mcp-error-bin')[0];
		const response = JSON.parse(Buffer.from(bin).toString('utf8')) as JsonObject;
		assert.strictEqual((response.error as JsonObject).code, -32020);
		return true;
	});
});

test('the tunnel answers discover, tools/list and tools/call', async () => {
	const discover = await callTunnel('server/discover', {});
	assert.strictEqual(discover.error, undefined);
	assert.deepStrictEqual(discover.messages.at(-1)?.result, DISCOVER_RESULT);

	const tools = await callTunnel('tools/list', {});
	assert.deepStrictEqual((tools.messages.at(-1)?.result as JsonObject).tools, [TOOL]);

	const echo = await callTunnel('tools/call', { name: TOOL.name, arguments: { text: 'there' } }, { 'mcp-name': TOOL.name });
	assert.deepStrictEqual((echo.messages.at(-1)?.result as JsonObject).content, [{ type: 'text', text: 'echo: there' }]);

	// An unknown tool is an ordinary error response on the stream, with grpc-status 0.
	const unknown = await callTunnel('tools/call', { name: 'nope' }, { 'mcp-name': 'nope' });
	assert.strictEqual(unknown.error, undefined);
	assert.strictEqual((unknown.messages.at(-1)?.error as JsonObject).code, -32602);
});

test('the tunnel reports a header mismatch in the trailers', async () => {
	const missing = await callTunnel('tools/call', { name: TOOL.name });
	assert.strictEqual(missing.messages.length, 0);
	assert.strictEqual(missing.error?.code, grpc.status.INVALID_ARGUMENT);
	assert.deepStrictEqual(missing.error?.metadata.get('mcp-error-code'), ['-32020']);
	const bin = missing.error?.metadata.get('mcp-error-bin')[0];
	assert.ok(bin, 'mcp-error-bin is present');
	assert.strictEqual(((JSON.parse(Buffer.from(bin).toString('utf8')) as JsonObject).error as JsonObject).code, -32020);

	const mismatch = await callTunnel('tools/call', { name: TOOL.name }, { 'mcp-name': 'other' });
	assert.deepStrictEqual(mismatch.error?.metadata.get('mcp-error-code'), ['-32020']);

	const unknownMethod = await callTunnel('nothing/here', {});
	assert.strictEqual(unknownMethod.error?.code, grpc.status.UNIMPLEMENTED);
	assert.deepStrictEqual(unknownMethod.error?.metadata.get('mcp-error-code'), ['-32601']);
});

test('the tunnel acknowledges a listen stream and keeps it open until cancelled', async () => {
	let acknowledged = false;
	const listen = await callTunnel('subscriptions/listen', { notifications: { toolsListChanged: true } }, {}, (message, stream) => {
		if (message.method === 'notifications/subscriptions/acknowledged') {
			acknowledged = true;
			stream.cancel();
		}
	});
	assert.ok(acknowledged, `the acknowledgement arrived: ${JSON.stringify(listen.messages)}`);
	assert.deepStrictEqual((listen.messages[0].params as JsonObject).notifications, { toolsListChanged: true });
	assert.strictEqual(listen.error?.code, grpc.status.CANCELLED);
});
