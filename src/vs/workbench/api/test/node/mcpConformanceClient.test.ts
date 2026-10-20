/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as http from 'http';
import { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { LogLevel } from '../../../../platform/log/common/log.js';
import { ConformanceExitCode, CONTEXT_ENV, createClientMethods, createConformanceServices, formElicitationContent, LOG_LEVEL_ENV, main, parseArgs, PROTOCOL_VERSION_ENV, SAMPLING_ANSWER, SCENARIO_ENV } from '../../node/mcpConformanceClient.js';
import { StderrLogger } from '../../node/mcpConformanceProxy.js';

interface IRecordedRequest {
	readonly headers: http.IncomingHttpHeaders;
	readonly body: { readonly method?: string; readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown>; readonly _meta?: Record<string, unknown> } };
}

/** A tiny stateless Streamable HTTP server speaking 2026-07-28: server/discover, tools/list and tools/call. */
async function startModernServer(): Promise<{ url: string; requests: IRecordedRequest[]; close(): Promise<void> }> {
	const requests: IRecordedRequest[] = [];
	const { createServer } = await import('http');
	const server = createServer((req, res) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', chunk => { raw += chunk; });
		req.on('end', () => {
			const body = JSON.parse(raw);
			requests.push({ headers: req.headers, body });
			const reply = (result: object) => {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', ...result } }));
			};
			switch (body.method) {
				case 'server/discover':
					reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' });
					break;
				case 'tools/list':
					reply({ ttlMs: 0, cacheScope: 'private', tools: [{ name: 'add_numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] });
					break;
				case 'tools/call':
					reply({ content: [{ type: 'text', text: String(body.params.arguments.a + body.params.arguments.b) }] });
					break;
				default:
					res.writeHead(404, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: `Method not found: ${body.method}` } }));
			}
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		requests,
		close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(err => err ? reject(err) : resolve()); }),
	};
}

suite('MCP conformance - client', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('parseArgs', () => {
		test('needs a server URL as the last argument', () => {
			assert.deepStrictEqual(parseArgs([], {}), { ok: false, error: 'usage: mcpConformanceClientMain.js <server-url>' });
			assert.ok(!parseArgs(['--verbose'], {}).ok);
			assert.ok(!parseArgs(['not a url'], {}).ok);
			assert.ok(!parseArgs(['ftp://localhost/mcp'], {}).ok);
		});

		test('defaults to tools_call at the latest revision', () => {
			const result = parseArgs(['http://localhost:3000/mcp'], {});
			assert.ok(result.ok);
			assert.strictEqual(result.args.serverUrl, 'http://localhost:3000/mcp');
			assert.strictEqual(result.args.scenario, 'tools_call');
			assert.strictEqual(result.args.protocolVersion, '2026-07-28');
			assert.strictEqual(result.args.era, 'modern');
			assert.strictEqual(result.args.logLevel, LogLevel.Info);
			assert.deepStrictEqual(result.args.context, { raw: {} });
		});

		test('reads the scenario, revision, context and log level from the environment', () => {
			const result = parseArgs(['--flag', 'http://localhost:3000'], {
				[SCENARIO_ENV]: 'sse-retry',
				[PROTOCOL_VERSION_ENV]: '2025-11-25',
				[CONTEXT_ENV]: '{"name":"sse-retry","client_id":"c"}',
				[LOG_LEVEL_ENV]: 'debug',
			});
			assert.ok(result.ok);
			assert.strictEqual(result.args.scenario, 'sse-retry');
			assert.strictEqual(result.args.protocolVersion, '2025-11-25');
			assert.strictEqual(result.args.era, 'legacy');
			assert.strictEqual(result.args.logLevel, LogLevel.Debug);
			assert.strictEqual(result.args.context.client_id, 'c');
		});

		test('rejects revisions the client does not speak', () => {
			const result = parseArgs(['http://localhost:3000'], { [PROTOCOL_VERSION_ENV]: '2030-01-01' });
			assert.ok(!result.ok);
			assert.ok(result.error.includes('2030-01-01'));
		});
	});

	suite('client methods', () => {
		function methods() {
			const lines: string[] = [];
			const logger = store.add(new StderrLogger(line => lines.push(line), LogLevel.Trace));
			return { methods: createClientMethods(logger), lines };
		}

		test('the form content is the schema defaults plus the fixed answers for the fields the schema has', () => {
			assert.deepStrictEqual(formElicitationContent({ type: 'object', properties: { confirmed: { type: 'boolean' } } }), { confirmed: true });
			assert.deepStrictEqual(formElicitationContent({ type: 'object', properties: { name: { type: 'string', default: 'John Doe' }, age: { type: 'integer', default: 30 } } }), { name: 'John Doe', age: 30 });
			assert.deepStrictEqual(formElicitationContent({ type: 'object', properties: { name: { type: 'string' }, other: { type: 'string' } } }), { name: 'Alice' });
			assert.deepStrictEqual(formElicitationContent(undefined), {});
		});

		test('accepts form elicitations with validated content', async () => {
			const { methods: m } = methods();
			const result = await m.elicitationRequestHandler!({ message: 'confirm?', requestedSchema: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] } });
			assert.deepStrictEqual(result, { action: 'accept', content: { confirmed: true } });
		});

		test('fails loudly when the answer cannot satisfy the schema', async () => {
			const { methods: m } = methods();
			await assert.rejects(() => m.elicitationRequestHandler!({ message: 'n?', requestedSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } }), /does not match the requested schema/);
		});

		test('declines URL elicitations and answers sampling with the fixed message', async () => {
			const { methods: m, lines } = methods();
			assert.deepStrictEqual(await m.elicitationRequestHandler!({ mode: 'url', message: 'go', elicitationId: 'e1', url: 'https://example.com' }), { action: 'decline' });
			assert.ok(lines.some(line => line.includes('Declining the URL elicitation e1')));
			assert.deepStrictEqual(await m.createMessageRequestHandler!({ messages: [], maxTokens: 1 }), SAMPLING_ANSWER);
			assert.strictEqual(SAMPLING_ANSWER.model, 'conformance-model');
			assert.strictEqual(SAMPLING_ANSWER.stopReason, 'endTurn');
		});
	});

	suite('services', () => {
		test('provide the product and a stderr log service', () => {
			const lines: string[] = [];
			const services = store.add(createConformanceServices(LogLevel.Warning, line => lines.push(line)));
			services.logService.info('hidden');
			services.logService.warn('shown');
			assert.deepStrictEqual(lines, ['[mcp-conformance] warn: shown\n']);
			assert.strictEqual(services.logger.getLevel(), LogLevel.Warning);
		});
	});

	suite('main', () => {
		test('exits with Failed for bad arguments and UnknownScenario for scenarios it does not drive', async () => {
			const lines: string[] = [];
			assert.strictEqual(await main([], {}, { writeStderr: line => lines.push(line) }), ConformanceExitCode.Failed);
			assert.strictEqual(await main(['http://localhost:1'], { [SCENARIO_ENV]: 'no-such-scenario' }, { writeStderr: line => lines.push(line) }), ConformanceExitCode.UnknownScenario);
			assert.ok(lines[0].includes('usage'));
			assert.ok(lines[1].includes('no-such-scenario'));
		});

		test('exits with Failed when the server cannot be reached', async () => {
			const lines: string[] = [];
			const server = await startModernServer();
			await server.close();
			assert.strictEqual(await main([server.url], {}, { writeStderr: line => lines.push(line) }), ConformanceExitCode.Failed);
			assert.ok(lines.some(line => line.includes('failed')), lines.join(''));
		});

		test('drives tools_call over the real transport against a modern server', async () => {
			const server = await startModernServer();
			const lines: string[] = [];
			const stdoutWrite = process.stdout.write;
			let stdoutWrites = 0;
			process.stdout.write = ((...args: Parameters<typeof stdoutWrite>) => { stdoutWrites++; return stdoutWrite.apply(process.stdout, args); }) as typeof stdoutWrite;
			try {
				const code = await main([server.url], { [SCENARIO_ENV]: 'tools_call', [PROTOCOL_VERSION_ENV]: '2026-07-28', [LOG_LEVEL_ENV]: 'debug' }, { writeStderr: line => lines.push(line) });
				assert.strictEqual(code, ConformanceExitCode.Ok, lines.join(''));
			} finally {
				process.stdout.write = stdoutWrite;
				await server.close();
			}
			assert.strictEqual(stdoutWrites, 0, 'stdout stays empty');
			assert.deepStrictEqual(server.requests.map(r => r.body.method), ['server/discover', 'tools/list', 'tools/call']);
			const call = server.requests[2];
			assert.strictEqual(call.body.params?.name, 'add_numbers');
			assert.deepStrictEqual(call.body.params?.arguments, { a: 1, b: 1 });
			assert.strictEqual(call.headers['mcp-protocol-version'], '2026-07-28');
			assert.strictEqual(call.headers['mcp-method'], 'tools/call');
			assert.strictEqual(call.headers['mcp-name'], 'add_numbers');
			const meta = call.body.params?._meta;
			assert.ok(meta);
			assert.strictEqual(meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
			assert.ok(meta['io.modelcontextprotocol/clientCapabilities']);
			assert.ok(meta['io.modelcontextprotocol/clientInfo']);
			assert.ok(lines.some(line => line.includes('Negotiated MCP 2026-07-28 (modern era)')), lines.join(''));
			assert.ok(lines.some(line => line.includes('Scenario tools_call completed')), lines.join(''));
		});
	});
});
