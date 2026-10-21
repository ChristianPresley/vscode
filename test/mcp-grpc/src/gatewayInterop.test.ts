/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Foreign gRPC clients against VS Code's MCP gateway: the gateway's
 * conformance entry point (`out/vs/platform/mcp/node/mcpGatewayConformanceMain.js
 * --grpc`, one route on the conformance fixture) is started as a child
 * process, then
 *
 * - @grpc/grpc-js calls all eight typed RPCs (with routing metadata) and the
 *   tunnel (discover, list, call, listen) with the vendored proto files,
 * - the zig-sdk example client (`grpc_client`, tunnel only, calls `add`) runs
 *   against the default route when `MCP_ZIG_GRPC_CLIENT` names its binary,
 * - curl makes a raw HTTP/2 prior-knowledge tunnel call, as in the zig-sdk
 *   CI, when it has HTTP/2 (the request message is over 2^14 bytes, so its
 *   length is a three-byte varint), and the trailers must say
 *   `grpc-status: 0`.
 *
 * The conformance entry point is a test fixture: its listener lets calls
 * without the `mcp-gateway-route` metadata reach its only route
 * (`allowDefaultRoute`), which the zig-sdk client needs. The product's
 * listener requires the metadata on every call; the unit tests in
 * `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts` cover that mode.
 *
 * Needs `npm run transpile-client` first; runs only with
 * `MCP_GATEWAY_GRPC_INTEROP=1` so that `npm test` of this package does not
 * depend on the build.
 */

import assert from 'node:assert';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { fromStruct, loadDefinitions, PROTOCOL_VERSION, toStruct } from './fixtureServer.ts';

type JsonObject = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');
const GATEWAY_MAIN = path.join(REPO_ROOT, 'out/vs/platform/mcp/node/mcpGatewayConformanceMain.js');
const ENABLED = process.env.MCP_GATEWAY_GRPC_INTEROP === '1';
const ZIG_CLIENT = process.env.MCP_ZIG_GRPC_CLIENT;

const SERVER_INFO = { name: 'mcp-conformance-test-server', version: '1.0.0' };
const ROUTE_METADATA = 'mcp-gateway-route';

interface IGateway {
	readonly child: ChildProcessWithoutNullStreams;
	readonly url: string;
	readonly routeId: string;
	readonly port: number;
}

/** Starts the gateway and reads `READY:<url>` and `GRPC:<port>` from its stdout. */
function startGateway(): Promise<IGateway> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [GATEWAY_MAIN, '--grpc', '--quiet'], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`the gateway did not start within 30 s\nstdout: ${stdout}\nstderr: ${stderr}`));
		}, 30_000);
		child.stderr.on('data', chunk => { stderr += String(chunk); });
		child.stdout.on('data', chunk => {
			stdout += String(chunk);
			const url = /^READY:(\S+)$/m.exec(stdout)?.[1];
			const port = /^GRPC:(\d+)$/m.exec(stdout)?.[1];
			if (url && port) {
				clearTimeout(timer);
				const routeId = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
				resolve({ child, url, routeId, port: Number(port) });
			}
		});
		child.on('exit', code => {
			clearTimeout(timer);
			reject(new Error(`the gateway exited with ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
		});
	});
}

const requestMeta = {
	'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
	'io.modelcontextprotocol/clientInfo': { name: 'gateway-interop', version: '1' },
	'io.modelcontextprotocol/clientCapabilities': {},
};

let gateway: IGateway | undefined;
let typed: grpc.Client;
let tunnel: grpc.Client;

before(async () => {
	if (!ENABLED) {
		return;
	}
	assert.ok(existsSync(GATEWAY_MAIN), `${GATEWAY_MAIN} is missing: run npm run transpile-client first`);
	gateway = await startGateway();
	const definitions = loadDefinitions();
	typed = new definitions.typedClient(`127.0.0.1:${gateway.port}`, grpc.credentials.createInsecure());
	tunnel = new definitions.tunnelClient(`127.0.0.1:${gateway.port}`, grpc.credentials.createInsecure());
});

after(async () => {
	if (!gateway) {
		return;
	}
	typed.close();
	tunnel.close();
	const exited = new Promise<void>(resolve => gateway!.child.once('exit', () => resolve()));
	// The gateway shuts down when its stdin closes.
	gateway.child.stdin.end();
	const timer = setTimeout(() => gateway!.child.kill(), 5000);
	await exited;
	clearTimeout(timer);
});

function metadataOf(entries: Record<string, string>): grpc.Metadata {
	const metadata = new grpc.Metadata();
	for (const [key, value] of Object.entries(entries)) {
		metadata.set(key, value);
	}
	return metadata;
}

function callTyped(method: string, request: JsonObject, extra: Record<string, string> = {}): Promise<JsonObject> {
	return new Promise((resolve, reject) => {
		const invoke = (typed as unknown as Record<string, (request: JsonObject, metadata: grpc.Metadata, options: grpc.CallOptions, callback: grpc.requestCallback<JsonObject>) => void>)[method];
		const metadata = metadataOf({ 'mcp-protocol-version': PROTOCOL_VERSION, [ROUTE_METADATA]: gateway!.routeId, ...extra });
		invoke.call(typed, request, metadata, { deadline: Date.now() + 10_000 }, (err, response) => err ? reject(err) : resolve(response!));
	});
}

interface ITunnelOutcome {
	readonly messages: JsonObject[];
	readonly error?: grpc.ServiceError;
}

function callTunnel(method: string, params: JsonObject, extra: Record<string, string> = {}, onMessage?: (message: JsonObject, stream: grpc.ClientReadableStream<JsonObject>) => void): Promise<ITunnelOutcome> {
	return new Promise(resolve => {
		const request = { jsonrpc: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { ...requestMeta, ...(params._meta as JsonObject | undefined) } } }), 'utf8') };
		const invoke = (tunnel as unknown as Record<string, (request: JsonObject, metadata: grpc.Metadata) => grpc.ClientReadableStream<JsonObject>>).Call;
		const stream = invoke.call(tunnel, request, metadataOf({ 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': method, ...extra }));
		const messages: JsonObject[] = [];
		let error: grpc.ServiceError | undefined;
		let settled = false;
		const finish = () => {
			if (!settled) {
				settled = true;
				resolve({ messages, error });
			}
		};
		stream.on('data', (chunk: JsonObject) => {
			const message = JSON.parse(Buffer.from(chunk.jsonrpc as Uint8Array).toString('utf8')) as JsonObject;
			messages.push(message);
			onMessage?.(message, stream);
		});
		stream.on('error', (err: grpc.ServiceError) => { error = err; finish(); });
		stream.on('end', finish);
		stream.on('status', status => {
			if (status.code !== grpc.status.OK) {
				return;
			}
			// grpc-js reports the status after the last message; 'end' may follow it.
			setImmediate(finish);
		});
	});
}

function textOf(content: JsonObject[] | undefined): string | undefined {
	return ((content?.[0]?.text as JsonObject | undefined)?.text) as string | undefined;
}

test('grpc-js calls all eight typed RPCs of the gateway with routing metadata', { skip: !ENABLED && 'set MCP_GATEWAY_GRPC_INTEROP=1 after npm run transpile-client' }, async () => {
	const common = { metadata: toStruct(requestMeta) };

	const tools = await callTyped('ListTools', { common });
	const toolNames = (tools.tools as JsonObject[]).map(tool => tool.name);
	assert.ok(toolNames.includes('add'), `add is listed: ${toolNames.join(', ')}`);
	const responseCommon = tools.common as JsonObject;
	assert.strictEqual(responseCommon.result_type, 'RESULT_TYPE_COMPLETE');
	assert.deepStrictEqual(fromStruct(responseCommon.metadata as JsonObject)['io.modelcontextprotocol/serverInfo'], SERVER_INFO);

	const sum = await callTyped('CallTool', { common, request: { name: 'add', arguments: toStruct({ a: 40, b: 2 }) } }, { mcp_tool: 'add' });
	assert.strictEqual(textOf(sum.content as JsonObject[]), '42');

	const prompts = await callTyped('ListPrompts', { common });
	assert.ok((prompts.prompts as JsonObject[]).some(prompt => prompt.name === 'test_prompt_with_arguments'));
	const prompt = await callTyped('GetPrompt', { common, name: 'test_prompt_with_arguments', arguments: { arg1: 'a', arg2: 'b' } }, { mcp_prompt: 'test_prompt_with_arguments' });
	assert.strictEqual(textOf(prompt.messages as JsonObject[]), 'Prompt with arguments: arg1=\'a\', arg2=\'b\'');

	const resources = await callTyped('ListResources', { common });
	assert.ok((resources.resources as JsonObject[]).some(resource => resource.uri === 'test://static-text'));
	const read = await callTyped('ReadResource', { common, uri: 'test://static-text' }, { mcp_resource: 'test://static-text' });
	assert.strictEqual((read.resource as JsonObject[])[0].text, 'This is the content of the static text resource.');
	const templates = await callTyped('ListResourceTemplates', { common });
	assert.strictEqual((templates.resource_templates as JsonObject[])[0].uri_template, 'test://template/{id}/data');

	const completion = await callTyped('Complete', { common, prompt_reference: { name: 'test_prompt_with_arguments' }, argument: { name: 'arg1', value: 'pa' } }, { mcp_resource: 'test_prompt_with_arguments' });
	assert.deepStrictEqual(completion.values, ['paris', 'park', 'party']);
	assert.strictEqual(completion.total_matches, '3');
});

test('the typed service reports JSON-RPC errors and unknown routes in the trailers', { skip: !ENABLED && 'set MCP_GATEWAY_GRPC_INTEROP=1' }, async () => {
	await assert.rejects(callTyped('CallTool', { request: { name: 'add', arguments: toStruct({ a: 1, b: 2 }) } }, { mcp_tool: 'other' }), (err: grpc.ServiceError) => {
		assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
		assert.deepStrictEqual(err.metadata.get('mcp-error-code'), ['-32020']);
		const response = JSON.parse(Buffer.from(err.metadata.get('mcp-error-bin')[0]).toString('utf8')) as JsonObject;
		assert.strictEqual((response.error as JsonObject).code, -32020);
		return true;
	});
	await assert.rejects(callTyped('CallTool', { request: { name: 'no_such_tool' } }), (err: grpc.ServiceError) => {
		assert.strictEqual(err.code, grpc.status.INVALID_ARGUMENT);
		assert.deepStrictEqual(err.metadata.get('mcp-error-code'), ['-32602']);
		return true;
	});
	await assert.rejects(callTyped('ListTools', {}, { [ROUTE_METADATA]: 'no-such-route' }), (err: grpc.ServiceError) => {
		assert.strictEqual(err.code, grpc.status.NOT_FOUND);
		return true;
	});
});

test('grpc-js calls the tunnel: discover, list, call with progress, listen', { skip: !ENABLED && 'set MCP_GATEWAY_GRPC_INTEROP=1' }, async () => {
	const discover = await callTunnel('server/discover', {});
	assert.strictEqual(discover.error, undefined);
	const discovered = discover.messages.at(-1)?.result as JsonObject;
	assert.deepStrictEqual(discovered.supportedVersions, [PROTOCOL_VERSION]);
	assert.deepStrictEqual((discovered._meta as JsonObject)['io.modelcontextprotocol/serverInfo'], SERVER_INFO);

	const tools = await callTunnel('tools/list', {}, { [ROUTE_METADATA]: gateway!.routeId });
	assert.ok(((tools.messages.at(-1)?.result as JsonObject).tools as JsonObject[]).some(tool => tool.name === 'add'));

	const sum = await callTunnel('tools/call', { name: 'add', arguments: { a: 40, b: 2 }, _meta: { progressToken: 'p' } }, { 'mcp-name': 'add' });
	assert.strictEqual(sum.error, undefined);
	assert.deepStrictEqual(sum.messages.map(message => message.method ?? 'response'), ['notifications/progress', 'response']);
	assert.deepStrictEqual(((sum.messages[1].result as JsonObject).content as JsonObject[])[0], { type: 'text', text: '42' });

	const mismatch = await callTunnel('tools/call', { name: 'add', arguments: { a: 1, b: 1 } }, { 'mcp-name': 'other' });
	assert.strictEqual(mismatch.error?.code, grpc.status.INVALID_ARGUMENT);
	assert.deepStrictEqual(mismatch.error?.metadata.get('mcp-error-code'), ['-32020']);

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

test('the zig-sdk example client calls add on the default route', { skip: (!ENABLED || !ZIG_CLIENT) && 'set MCP_GATEWAY_GRPC_INTEROP=1 and MCP_ZIG_GRPC_CLIENT to the grpc_client binary' }, () => {
	const result = spawnSync(ZIG_CLIENT!, ['127.0.0.1', String(gateway!.port)], { encoding: 'utf8', timeout: 60_000 });
	const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
	assert.strictEqual(result.status, 0, output);
	assert.match(output, /server: mcp-conformance-test-server 1\.0\.0/);
	assert.match(output, /tool: add/);
	assert.match(output, /add\(40, 2\) = 42/);
});

/** Whether `curl` exists and speaks HTTP/2. */
function curlHasHttp2(): boolean {
	const result = spawnSync('curl', ['--version'], { encoding: 'utf8' });
	return result.status === 0 && /^Features:.*\bHTTP2\b/m.test(result.stdout ?? '');
}

/** A protobuf base-128 varint. */
function encodeVarint(value: number): Buffer {
	assert.ok(Number.isSafeInteger(value) && value >= 0, `a varint needs a non-negative integer: ${value}`);
	const bytes: number[] = [];
	let rest = value;
	while (rest >= 0x80) {
		bytes.push((rest % 0x80) | 0x80);
		rest = Math.floor(rest / 0x80);
	}
	bytes.push(rest);
	return Buffer.from(bytes);
}

/** Reads a varint at `offset`: its value and the offset after it. */
function decodeVarint(buffer: Buffer, offset: number): { readonly value: number; readonly next: number } {
	let value = 0;
	let factor = 1;
	for (let i = offset; i < buffer.length; i++) {
		value += (buffer[i] & 0x7f) * factor;
		if ((buffer[i] & 0x80) === 0) {
			return { value, next: i + 1 };
		}
		factor *= 0x80;
	}
	throw new Error('truncated varint');
}

/** `mcp.zig.transport.v1.JsonRpcMessage { bytes jsonrpc = 1; }` with a length prefix (5 bytes: flag, big-endian length). */
function framedJsonRpcMessage(json: string): Buffer {
	const body = Buffer.from(json, 'utf8');
	const message = Buffer.concat([Buffer.from([0x0a]), encodeVarint(body.length), body]);
	const prefix = Buffer.alloc(5);
	prefix.writeUInt32BE(message.length, 1);
	return Buffer.concat([prefix, message]);
}

/** The JSON-RPC messages of a tunnel response body (length-prefixed JsonRpcMessages). */
function unframeJsonRpcMessages(data: Buffer): JsonObject[] {
	const messages: JsonObject[] = [];
	for (let offset = 0; offset < data.length;) {
		assert.strictEqual(data[offset], 0, 'uncompressed');
		const length = data.readUInt32BE(offset + 1);
		const message = data.subarray(offset + 5, offset + 5 + length);
		assert.strictEqual(message[0], 0x0a, 'field 1, length-delimited');
		const { value, next } = decodeVarint(message, 1);
		messages.push(JSON.parse(message.subarray(next, next + value).toString('utf8')) as JsonObject);
		offset += 5 + length;
	}
	return messages;
}

test('the JsonRpcMessage length is a varint of any size', () => {
	assert.deepStrictEqual([...encodeVarint(0)], [0]);
	assert.deepStrictEqual([...encodeVarint(127)], [0x7f]);
	assert.deepStrictEqual([...encodeVarint(128)], [0x80, 0x01]);
	assert.deepStrictEqual([...encodeVarint(300)], [0xac, 0x02]);
	assert.deepStrictEqual([...encodeVarint(16_384)], [0x80, 0x80, 0x01], 'three bytes from 2^14 on');
	assert.deepStrictEqual([...encodeVarint(2 ** 32)], [0x80, 0x80, 0x80, 0x80, 0x10]);
	for (const size of [0, 1, 127, 128, 16_383, 16_384, 70_000]) {
		const json = JSON.stringify({ pad: 'x'.repeat(Math.max(0, size - 10)) });
		assert.deepStrictEqual(unframeJsonRpcMessages(framedJsonRpcMessage(json)), [JSON.parse(json)], `${json.length} bytes`);
	}
});

/** The header blocks of a `curl -D` dump: the response headers first, then the trailers (if any), each a name → value map. */
function headerBlocks(dump: string): Record<string, string>[] {
	return dump.split(/\r?\n\r?\n/).filter(block => block.trim().length > 0).map(block => {
		const fields: Record<string, string> = {};
		for (const line of block.split(/\r?\n/)) {
			const colon = line.indexOf(':');
			if (colon > 0) {
				fields[line.substring(0, colon).trim().toLowerCase()] = line.substring(colon + 1).trim();
			}
		}
		return fields;
	});
}

test('curl calls the tunnel over HTTP/2 with prior knowledge: messages, then grpc-status 0 in the trailers', { skip: (!ENABLED && 'set MCP_GATEWAY_GRPC_INTEROP=1') || (!curlHasHttp2() && 'curl without HTTP/2') }, () => {
	// Over 2^14 bytes, so that the JsonRpcMessage length takes a three-byte varint.
	const padding = 'p'.repeat(20_000);
	const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {}, 'test/padding': padding } } });
	assert.ok(json.length >= 1 << 14);
	const dir = mkdtempSync(path.join(tmpdir(), 'mcp-gateway-curl-'));
	try {
		const callFile = path.join(dir, 'call.bin');
		const responseFile = path.join(dir, 'response.bin');
		const headersFile = path.join(dir, 'headers.txt');
		writeFileSync(callFile, framedJsonRpcMessage(json));
		const result = spawnSync('curl', [
			'-s', '--http2-prior-knowledge', '-D', headersFile, '-o', responseFile, '-w', '%{http_code} %{content_type}',
			'-H', 'content-type: application/grpc+proto', '-H', 'te: trailers',
			'-H', `mcp-protocol-version: ${PROTOCOL_VERSION}`, '-H', 'mcp-method: server/discover',
			'-H', `${ROUTE_METADATA}: ${gateway!.routeId}`,
			'--data-binary', `@${callFile}`,
			`http://127.0.0.1:${gateway!.port}/mcp.zig.transport.v1.Mcp/Call`,
		], { encoding: 'utf8', timeout: 30_000 });
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout, '200 application/grpc+proto');
		const [headers, trailers] = headerBlocks(readFileSync(headersFile, 'utf8'));
		assert.strictEqual(headers['grpc-status'], undefined, 'not a trailers-only response');
		assert.ok(trailers, `curl reports the trailers: ${readFileSync(headersFile, 'utf8')}`);
		assert.strictEqual(trailers['grpc-status'], '0');
		const messages = unframeJsonRpcMessages(readFileSync(responseFile));
		assert.strictEqual(messages.length, 1);
		const discovered = messages[0].result as JsonObject;
		assert.deepStrictEqual(discovered.supportedVersions, [PROTOCOL_VERSION]);
		assert.deepStrictEqual((discovered._meta as JsonObject)['io.modelcontextprotocol/serverInfo'], SERVER_INFO);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
