/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Interop of the gRPC transport against a real MCP server, through the whole
 * client: `McpGrpcHandle` (extension host) under `McpServerRequestHandler`
 * (the protocol engine). It runs only when `MCP_GRPC_INTEROP_PORT` names the
 * gRPC port of a server on 127.0.0.1 (`MCP_GRPC_INTEROP_HOST` overrides the
 * host), and covers the typed binding when `MCP_GRPC_INTEROP_TYPED=1`:
 *
 * - the grpc-js fixture: `node test/mcp-grpc/src/fixtureServer.ts` (prints `READY:<port>`);
 * - the zig-sdk conformance server: `mcp-conformance-server --port 3000 --grpc-port 50051 --grpc-typed`.
 *
 * The two peers have different inventories; a check that needs a tool the
 * peer does not have is skipped.
 */

import assert from 'assert';
import * as http2 from 'http2';
import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { NullLogger } from '../../../../platform/log/common/log.js';
import { McpGrpcBinding } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import product from '../../../../platform/product/common/product.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { buildClientCapabilities, buildEnvelope, buildRequestMeta } from '../../../contrib/mcp/common/mcpProtocolMeta.js';
import { McpServerRequestHandler } from '../../../contrib/mcp/common/mcpServerRequestHandler.js';
import { McpTaskManager } from '../../../contrib/mcp/common/mcpTaskManager.js';
import { IMcpClientMethods, McpServerTransportGrpc, McpServerTransportType, MpcResponseError } from '../../../contrib/mcp/common/mcpTypes.js';
import { MCPLegacy } from '../../../contrib/mcp/common/modelContextProtocolLegacy.js';
import { GrpcTestTransport } from './extHostMcpGrpcTestUtils.js';

const PORT = process.env.MCP_GRPC_INTEROP_PORT;
const HOST = process.env.MCP_GRPC_INTEROP_HOST || '127.0.0.1';
const TYPED = /^(1|true|yes)$/i.test(process.env.MCP_GRPC_INTEROP_TYPED ?? '');
const MODERN = '2026-07-28';
const TUNNEL_PATH = '/mcp.zig.transport.v1.Mcp/Call';


const answers: Readonly<Record<string, string>> = { name: 'Alice', color: 'blue' };

/** Answers forms with fixed values per field name, sampling with a fixed message. */
const clientMethods: IMcpClientMethods = {
	async elicitationRequestHandler(req) {
		if (req.mode === 'url') {
			return { action: 'decline' };
		}
		const content: Record<string, string | number | boolean> = {};
		const properties = (req.requestedSchema?.properties ?? {}) as Record<string, { type?: string }>;
		for (const [name, schema] of Object.entries(properties)) {
			content[name] = answers[name] ?? (schema.type === 'boolean' ? true : schema.type === 'number' || schema.type === 'integer' ? 1 : 'yes');
		}
		return { action: 'accept', content };
	},
	async createMessageRequestHandler() {
		return { role: 'assistant', content: { type: 'text', text: 'Paris' }, model: 'interop-model', stopReason: 'endTurn' };
	},
};

function textOf(result: MCPLegacy.CallToolResult): string {
	return result.content.map(c => c.type === 'text' ? c.text : '').join('');
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			assert.fail(`timed out waiting for ${what}`);
		}
		await timeout(10);
	}
}

/**
 * An h2c front that serves only the typed binding: the tunnel path answers a
 * trailers-only UNIMPLEMENTED (as a typed-only server does), every other path
 * is forwarded to the peer.
 */
async function startTypedOnlyFront(upstreamAuthority: string): Promise<{ port: number; close(): Promise<void> }> {
	const upstream = http2.connect(`http://${upstreamAuthority}`);
	upstream.on('error', () => { });
	const sessions: http2.ServerHttp2Session[] = [];
	const server = http2.createServer();
	server.on('session', session => sessions.push(session));
	server.on('stream', (stream, headers) => {
		stream.on('error', () => { });
		if (headers[':path'] === TUNNEL_PATH) {
			stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '12', 'grpc-message': 'unknown service mcp.zig.transport.v1.Mcp' }, { endStream: true });
			return;
		}
		const forwarded: http2.OutgoingHttpHeaders = {};
		for (const [name, value] of Object.entries(headers)) {
			if (!name.startsWith(':') || name === ':method' || name === ':path') {
				forwarded[name] = value;
			}
		}
		const call = upstream.request(forwarded);
		call.on('error', () => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
		let trailers: http2.IncomingHttpHeaders | undefined;
		call.on('response', response => {
			const out: http2.OutgoingHttpHeaders = {};
			for (const [name, value] of Object.entries(response)) {
				if (!name.startsWith(':') || name === ':status') {
					out[name] = value;
				}
			}
			if (call.endAfterHeaders) {
				stream.respond(out, { endStream: true });
			} else {
				stream.respond(out, { waitForTrailers: true });
			}
		});
		call.on('data', (chunk: Buffer) => stream.write(chunk));
		call.on('trailers', t => { trailers = t; });
		call.on('end', () => {
			if (!stream.headersSent || stream.writableEnded) {
				return;
			}
			stream.on('wantTrailers', () => {
				const out: http2.OutgoingHttpHeaders = {};
				for (const [name, value] of Object.entries(trailers ?? { 'grpc-status': '0' })) {
					if (!name.startsWith(':')) {
						out[name] = value;
					}
				}
				stream.sendTrailers(out);
			});
			stream.end();
		});
		stream.pipe(call);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	return {
		port: address.port,
		close: async () => {
			for (const session of sessions) {
				session.destroy();
			}
			upstream.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

(PORT ? suite : suite.skip)('McpGrpcHandle interop', function () {
	this.timeout(60_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const authority = `${HOST}:${PORT}`;

	function launchFor(binding: McpGrpcBinding, target = authority): McpServerTransportGrpc {
		return { type: McpServerTransportType.Grpc, uri: URI.parse(`grpc://${target}`), headers: [], binding };
	}

	async function connect(binding: McpGrpcBinding, target = authority): Promise<{ transport: GrpcTestTransport; handler: McpServerRequestHandler }> {
		const disposables = store.add(new DisposableStore());
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		const instantiationService = disposables.add(new InstantiationService(new ServiceCollection([IProductService, productService]), true));
		const transport = disposables.add(new GrpcTestTransport(launchFor(binding, target)));
		const taskManager = disposables.add(new McpTaskManager());
		const handler = await McpServerRequestHandler.create(instantiationService, {
			launch: transport,
			logger: new NullLogger(),
			taskManager,
			transportType: McpServerTransportType.Grpc,
			...clientMethods,
		}, CancellationToken.None);
		disposables.add(handler);
		handler.roots = [{ uri: 'file:///workspace', name: 'workspace' }];
		return { transport, handler };
	}

	/** The text tool of the peer and the arguments it needs. */
	function textTool(tools: readonly MCPLegacy.Tool[]): { name: string; args: Record<string, unknown>; expected: RegExp } {
		if (tools.some(t => t.name === 'test_simple_text')) {
			return { name: 'test_simple_text', args: {}, expected: /\S/ };
		}
		assert.ok(tools.some(t => t.name === 'test-tool'), `no known text tool in ${tools.map(t => t.name).join(', ')}`);
		return { name: 'test-tool', args: { text: 'over gRPC' }, expected: /^echo: over gRPC$/ };
	}

	test('tunnel: discover, cache hints, and a text tool call', async () => {
		const { transport, handler } = await connect('tunnel');
		const tools = await handler.listToolsEx();
		const tool = textTool(tools.items);
		const result = await handler.callTool({ name: tool.name, arguments: tool.args });

		assert.strictEqual(handler.negotiated.era, 'modern');
		assert.strictEqual(handler.negotiated.protocolVersion, MODERN);
		assert.ok(handler.discoverResult?.supportedVersions.includes(MODERN));
		assert.notStrictEqual(handler.serverInfo.name, 'MCP Server');
		assert.strictEqual(typeof handler.discoverCacheHint?.ttlMs, 'number');
		assert.ok(handler.discoverCacheHint?.cacheScope === 'private' || handler.discoverCacheHint?.cacheScope === 'public');
		assert.ok(tools.cacheHint.receivedAt > 0);
		assert.match(textOf(result), tool.expected);
		assert.strictEqual(result.isError ?? false, false);
		assert.strictEqual(transport.handle.binding, 'tunnel');
		assert.deepStrictEqual(transport.aborts, []);
		// tools/call goes out without grpc-timeout; the envelope of the call says so too.
		assert.ok(transport.envelopes.some(e => e.method === 'tools/call' && e.deadlineMs === undefined));
	});

	test('auto: picks the tunnel of a server that serves it', async () => {
		const { transport, handler } = await connect('auto');
		await handler.listTools();
		assert.strictEqual(transport.handle.binding, 'tunnel');
	});

	test('tunnel: image content', async function () {
		const { handler } = await connect('tunnel');
		const tools = await handler.listTools();
		if (!tools.some(t => t.name === 'test_image_content')) {
			this.skip();
		}
		const result = await handler.callTool({ name: 'test_image_content', arguments: {} });
		const image = result.content.find(c => c.type === 'image');
		assert.ok(image && image.type === 'image');
		assert.ok(image.data.length > 0);
		assert.match(image.mimeType, /^image\//);
	});

	test('tunnel: input_required rounds (elicitation, three rounds)', async function () {
		const { handler } = await connect('tunnel');
		const tools = await handler.listTools();
		if (!tools.some(t => t.name === 'test_input_required_result_multi_round')) {
			this.skip();
		}
		const single = await handler.callTool({ name: 'test_input_required_result_elicitation', arguments: {} });
		const multi = await handler.callTool({ name: 'test_input_required_result_multi_round', arguments: {} });
		assert.deepStrictEqual([textOf(single), textOf(multi)], ['Hello, Alice!', 'Alice likes blue']);
	});

	test('tunnel: the listen stream is acknowledged and a cancel ends it', async () => {
		const transport = store.add(new GrpcTestTransport(launchFor('tunnel')));
		const id = 9001;
		const params = {
			notifications: { toolsListChanged: true },
			_meta: buildRequestMeta({
				protocolVersion: MODERN,
				clientInfo: { name: 'vscode-grpc-interop', version: '0.0.1' },
				clientCapabilities: buildClientCapabilities('modern', { sampling: false, samplingTools: false, elicitation: false }),
			}),
		};
		const listening = transport.handle.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params }), buildEnvelope('listen', id, MODERN, 'subscriptions/listen', params));
		await waitFor(() => transport.received.some(m => m.method === 'notifications/subscriptions/acknowledged'), 'the acknowledgement');
		transport.handle.cancelRequest(id);
		await listening;
		assert.deepStrictEqual(transport.aborts, []);
		assert.ok(!transport.received.some(m => m.id === id), 'the cancelled stream delivers no result');
	});

	test('tunnel: a -32020 in the trailers surfaces as an MpcResponseError', async () => {
		const { transport, handler } = await connect('tunnel');
		const tool = textTool(await handler.listTools());
		transport.tamper = (_message, envelope) => envelope?.method === 'tools/call'
			? { ...envelope, headers: { ...envelope.headers, 'Mcp-Name': 'not-the-tool-name' } }
			: envelope;
		await assert.rejects(handler.callTool({ name: tool.name, arguments: tool.args }), (err: unknown) => {
			assert.ok(err instanceof MpcResponseError, `expected an MpcResponseError, got ${err}`);
			assert.strictEqual(err.code, -32020);
			return true;
		});
	});

	(TYPED ? suite : suite.skip)('typed binding', () => {

		test('the eight RPCs, with discover synthesized from the authority', async () => {
			const { transport, handler } = await connect('typed');
			const tools = await handler.listTools();
			const tool = textTool(tools);
			const call = await handler.callTool({ name: tool.name, arguments: tool.args });
			const prompts = await handler.listPrompts();
			const prompt = prompts.find(p => p.name === 'test_prompt_with_arguments') ?? prompts.find(p => p.name === 'test-prompt');
			assert.ok(prompt, `no known prompt in ${prompts.map(p => p.name).join(', ')}`);
			const promptArgs = Object.fromEntries((prompt.arguments ?? []).map(a => [a.name, 'gRPC']));
			const got = await handler.getPrompt({ name: prompt.name, arguments: promptArgs });
			const resources = await handler.listResources();
			const read = await handler.readResource({ uri: 'test://static-text' });
			const templates = await handler.listResourceTemplates();
			const completion = await handler.complete({ ref: { type: 'ref/prompt', name: prompt.name }, argument: { name: prompt.arguments?.[0]?.name ?? 'topic', value: 'a' } });

			assert.strictEqual(transport.handle.binding, 'typed');
			assert.strictEqual(handler.serverInfo.name === authority || handler.serverInfo.name.length > 0, true);
			assert.deepStrictEqual(handler.discoverResult?.supportedVersions, [MODERN]);
			assert.match(textOf(call), tool.expected);
			assert.ok(got.messages.length > 0);
			assert.ok(resources.some(r => r.uri === 'test://static-text'));
			const text = (read.contents[0] as { text?: unknown } | undefined)?.text;
			assert.ok(typeof text === 'string' && text.length > 0, `expected text contents, got ${JSON.stringify(read.contents)}`);
			assert.ok(Array.isArray(templates));
			assert.ok(Array.isArray(completion.completion.values));
			assert.deepStrictEqual(transport.aborts, []);
		});

		test('input_required rounds over CallTool', async function () {
			const { handler } = await connect('typed');
			const tools = await handler.listTools();
			if (!tools.some(t => t.name === 'test_input_required_result_elicitation')) {
				this.skip();
			}
			const result = await handler.callTool({ name: 'test_input_required_result_elicitation', arguments: {} });
			assert.strictEqual(textOf(result), 'Hello, Alice!');
		});

		test('auto falls back to the typed binding when the server has no tunnel', async () => {
			const front = await startTypedOnlyFront(authority);
			try {
				const { transport, handler } = await connect('auto', `127.0.0.1:${front.port}`);
				const tools = await handler.listTools();
				const tool = textTool(tools);
				const result = await handler.callTool({ name: tool.name, arguments: tool.args });
				assert.strictEqual(transport.handle.binding, 'typed');
				assert.deepStrictEqual(handler.discoverResult?.supportedVersions, [MODERN]);
				assert.match(textOf(result), tool.expected);
				assert.ok(transport.logs.some(l => /switching to the typed gRPC binding/.test(l)));
			} finally {
				await front.close();
			}
		});
	});
});
