/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A foreign gRPC server for the interop checks, built on @grpc/grpc-js and
 * the vendored proto files. It serves both bindings on one port:
 *
 * - the JSON-RPC tunnel `mcp.zig.transport.v1.Mcp/Call` (server streaming),
 * - the typed service `model_context_protocol.Mcp` (eight unary RPCs),
 *
 * with a small fixed inventory: the echo tool `test-tool`, one prompt, one
 * static resource and a completion. Run with `npm run start-fixture`; the
 * server prints `READY:<port>` once it listens on 127.0.0.1.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The vendored proto files of `src/vs/platform/mcp/test/node/fixtures/grpc`. */
export const FIXTURE_PROTO_DIR = path.resolve(here, '../../../src/vs/platform/mcp/test/node/fixtures/grpc');

export const TUNNEL_SERVICE = 'mcp.zig.transport.v1.Mcp';
export const TYPED_SERVICE = 'model_context_protocol.Mcp';
export const PROTOCOL_VERSION = '2026-07-28';

const loaderOptions: protoLoader.Options = {
	keepCase: true,
	longs: String,
	enums: String,
	defaults: false,
	oneofs: true,
	includeDirs: [FIXTURE_PROTO_DIR],
};

/** The package definitions of both bindings, for servers and clients alike. */
export function loadDefinitions(): { typed: grpc.ServiceDefinition; tunnel: grpc.ServiceDefinition; typedClient: grpc.ServiceClientConstructor; tunnelClient: grpc.ServiceClientConstructor } {
	const typedPackage = grpc.loadPackageDefinition(protoLoader.loadSync(path.join(FIXTURE_PROTO_DIR, 'mcp.proto'), loaderOptions));
	const tunnelPackage = grpc.loadPackageDefinition(protoLoader.loadSync(path.join(FIXTURE_PROTO_DIR, 'mcp_zig_transport_v1.proto'), loaderOptions));
	const typedClient = (typedPackage.model_context_protocol as grpc.GrpcObject).Mcp as grpc.ServiceClientConstructor;
	const tunnelClient = (((tunnelPackage.mcp as grpc.GrpcObject).zig as grpc.GrpcObject).transport as grpc.GrpcObject).v1 as grpc.GrpcObject;
	const tunnelConstructor = tunnelClient.Mcp as grpc.ServiceClientConstructor;
	return { typed: typedClient.service, tunnel: tunnelConstructor.service, typedClient, tunnelClient: tunnelConstructor };
}

//#region google.protobuf.Struct in the object form of proto-loader

// protobufjs has its own definitions of the well-known types, with camelCase
// field names also with keepCase.
export function toValue(value: unknown): JsonObject {
	if (value === null || value === undefined) {
		return { nullValue: 'NULL_VALUE' };
	}
	if (Array.isArray(value)) {
		return { listValue: { values: value.map(toValue) } };
	}
	switch (typeof value) {
		case 'number': return { numberValue: value };
		case 'string': return { stringValue: value };
		case 'boolean': return { boolValue: value };
		default: return { structValue: toStruct(value as JsonObject) };
	}
}

export function toStruct(object: JsonObject): JsonObject {
	return { fields: Object.fromEntries(Object.entries(object).map(([key, value]) => [key, toValue(value)])) };
}

export function fromValue(value: JsonObject): unknown {
	switch (value.kind) {
		case 'nullValue': return null;
		case 'numberValue': return value.numberValue;
		case 'stringValue': return value.stringValue;
		case 'boolValue': return value.boolValue;
		case 'structValue': return fromStruct(value.structValue as JsonObject);
		case 'listValue': return (((value.listValue as JsonObject | undefined)?.values as JsonObject[] | undefined) ?? []).map(fromValue);
		default: throw new Error(`a Value without a kind: ${JSON.stringify(value)}`);
	}
}

export function fromStruct(struct: JsonObject | undefined): JsonObject {
	const fields = (struct?.fields as Record<string, JsonObject> | undefined) ?? {};
	return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromValue(value)]));
}

//#endregion

//#region The inventory

export const SERVER_INFO = { name: 'vscode-mcp-grpc-fixture', version: '0.0.1' };

export const TOOL = {
	name: 'test-tool',
	title: 'Test tool',
	description: 'Echoes its text argument.',
	// No x-mcp-header annotation: the tool call mirrors only Mcp-Method and Mcp-Name.
	inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The text to echo.' } }, required: ['text'] },
};

export const PROMPT = {
	name: 'test-prompt',
	title: 'Test prompt',
	description: 'A prompt with one argument.',
	arguments: [{ name: 'topic', description: 'The topic to write about.', required: true }],
};

export const RESOURCE = { uri: 'test://static-text', name: 'static-text', title: 'Static text', mimeType: 'text/plain' };
export const RESOURCE_TEXT = 'This is a static text resource';
export const COMPLETION_VALUES = ['alpha', 'beta', 'gamma'];

const serverMeta = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO };

function echoText(args: JsonObject | undefined): string {
	const text = args?.text;
	return `echo: ${typeof text === 'string' ? text : ''}`;
}

function completionsFor(argumentName: string, value: string): string[] {
	return argumentName === 'topic' ? COMPLETION_VALUES.filter(candidate => candidate.startsWith(value)) : [];
}

//#endregion

//#region Errors

function grpcStatusForCode(code: number, binding: 'tunnel' | 'typed'): grpc.status {
	switch (code) {
		case -32601:
			return grpc.status.UNIMPLEMENTED;
		case -32700:
		case -32600:
		case -32602:
		case -32020:
		case -32021:
		case -32022:
			return grpc.status.INVALID_ARGUMENT;
		default:
			return binding === 'tunnel' ? grpc.status.UNKNOWN : grpc.status.INTERNAL;
	}
}

/**
 * A JSON-RPC error in the trailers: `grpc-status` from the code, the message
 * in `grpc-message`, the code in `mcp-error-code` and the whole error
 * response in `mcp-error-bin` (when it is 4096 bytes or less).
 */
export function jsonRpcError(code: number, message: string, id: unknown, binding: 'tunnel' | 'typed'): grpc.ServiceError {
	const metadata = new grpc.Metadata();
	metadata.set('mcp-error-code', String(code));
	const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), 'utf8');
	if (response.length <= 4096) {
		metadata.set('mcp-error-bin', response);
	}
	return Object.assign(new Error(message), { code: grpcStatusForCode(code, binding), details: message, metadata });
}

//#endregion

//#region The typed service

type UnaryCall = grpc.ServerUnaryCall<JsonObject, JsonObject>;
type UnaryCallback = grpc.sendUnaryData<JsonObject>;

function responseFields(): JsonObject {
	return { result_type: 'RESULT_TYPE_COMPLETE', metadata: toStruct(serverMeta) };
}

/** The routing metadata is optional; when present it must equal the value in the message. */
function routingMismatch(call: UnaryCall, key: string, expected: string): grpc.ServiceError | undefined {
	const values = call.metadata.get(key);
	if (values.length === 0) {
		return undefined;
	}
	const actual = String(values[0]);
	return actual === expected ? undefined : jsonRpcError(-32020, `Header mismatch: ${key} '${actual}' does not match the request`, null, 'typed');
}

const typedHandlers: grpc.UntypedServiceImplementation = {
	ListResources(_call: UnaryCall, callback: UnaryCallback) {
		callback(null, {
			common: responseFields(),
			resources: [{ uri: RESOURCE.uri, name: RESOURCE.name, title: RESOURCE.title, mime_type: RESOURCE.mimeType }],
			ttl: { seconds: '0', nanos: 0 },
			cache_scope: 'CACHE_SCOPE_PRIVATE',
		});
	},
	ReadResource(call: UnaryCall, callback: UnaryCallback) {
		const uri = String(call.request.uri ?? '');
		const mismatch = routingMismatch(call, 'mcp_resource', uri);
		if (mismatch) {
			return callback(mismatch);
		}
		if (uri !== RESOURCE.uri) {
			return callback(jsonRpcError(-32602, `Unknown resource: ${uri}`, null, 'typed'));
		}
		callback(null, {
			common: responseFields(),
			resource: [{ uri: RESOURCE.uri, mime_type: RESOURCE.mimeType, text: RESOURCE_TEXT }],
			ttl: { seconds: '0', nanos: 0 },
			cache_scope: 'CACHE_SCOPE_PRIVATE',
		});
	},
	ListResourceTemplates(_call: UnaryCall, callback: UnaryCallback) {
		callback(null, { common: responseFields(), resource_templates: [], ttl: { seconds: '0', nanos: 0 }, cache_scope: 'CACHE_SCOPE_PRIVATE' });
	},
	ListPrompts(_call: UnaryCall, callback: UnaryCallback) {
		callback(null, {
			common: responseFields(),
			prompts: [{ name: PROMPT.name, title: PROMPT.title, description: PROMPT.description, arguments: PROMPT.arguments }],
			ttl: { seconds: '0', nanos: 0 },
			cache_scope: 'CACHE_SCOPE_PRIVATE',
		});
	},
	GetPrompt(call: UnaryCall, callback: UnaryCallback) {
		const name = String(call.request.name ?? '');
		const mismatch = routingMismatch(call, 'mcp_prompt', name);
		if (mismatch) {
			return callback(mismatch);
		}
		if (name !== PROMPT.name) {
			return callback(jsonRpcError(-32602, `Unknown prompt: ${name}`, null, 'typed'));
		}
		const args = (call.request.arguments as Record<string, string> | undefined) ?? {};
		callback(null, {
			common: responseFields(),
			description: PROMPT.description,
			messages: [{ role: 'ROLE_USER', text: { text: `Write about ${args.topic ?? ''}` } }],
		});
	},
	ListTools(_call: UnaryCall, callback: UnaryCallback) {
		callback(null, {
			common: responseFields(),
			tools: [{ name: TOOL.name, title: TOOL.title, description: TOOL.description, input_schema: toStruct(TOOL.inputSchema) }],
			ttl: { seconds: '0', nanos: 0 },
			cache_scope: 'CACHE_SCOPE_PRIVATE',
		});
	},
	CallTool(call: UnaryCall, callback: UnaryCallback) {
		const request = call.request.request as JsonObject | undefined;
		const name = String(request?.name ?? '');
		const mismatch = routingMismatch(call, 'mcp_tool', name);
		if (mismatch) {
			return callback(mismatch);
		}
		if (name !== TOOL.name) {
			return callback(jsonRpcError(-32602, `Unknown tool: ${name}`, null, 'typed'));
		}
		const text = echoText(fromStruct(request?.arguments as JsonObject | undefined));
		callback(null, {
			common: responseFields(),
			content: [{ text: { text } }],
			structured_content: toStruct({ text }),
		});
	},
	Complete(call: UnaryCall, callback: UnaryCallback) {
		const promptReference = call.request.prompt_reference as JsonObject | undefined;
		const resourceReference = call.request.resource_reference as JsonObject | undefined;
		const target = String(promptReference?.name ?? resourceReference?.uri ?? '');
		const mismatch = routingMismatch(call, 'mcp_resource', target);
		if (mismatch) {
			return callback(mismatch);
		}
		const argument = (call.request.argument as JsonObject | undefined) ?? {};
		const values = target === PROMPT.name ? completionsFor(String(argument.name ?? ''), String(argument.value ?? '')) : [];
		callback(null, { common: responseFields(), values, total_matches: String(values.length), has_more: false });
	},
};

//#endregion

//#region The tunnel

type TunnelMessage = { jsonrpc: Buffer | Uint8Array };
type TunnelCall = grpc.ServerWritableStream<TunnelMessage, TunnelMessage>;

export const DISCOVER_RESULT = {
	resultType: 'complete',
	supportedVersions: [PROTOCOL_VERSION],
	capabilities: { tools: {}, prompts: {}, resources: {}, completions: {} },
	ttlMs: 0,
	cacheScope: 'private',
	_meta: serverMeta,
};

function tunnelCall(call: TunnelCall): void {
	let message: JsonObject;
	try {
		message = JSON.parse(Buffer.from(call.request.jsonrpc).toString('utf8')) as JsonObject;
	} catch {
		call.emit('error', jsonRpcError(-32700, 'Parse error', null, 'tunnel'));
		return;
	}
	const id = message.id;
	const method = String(message.method ?? '');
	const params = (message.params as JsonObject | undefined) ?? {};
	const send = (payload: JsonObject) => call.write({ jsonrpc: Buffer.from(JSON.stringify(payload), 'utf8') });
	const respond = (result: JsonObject) => {
		send({ jsonrpc: '2.0', id, result });
		call.end();
	};
	const fail = (code: number, errorMessage: string) => {
		send({ jsonrpc: '2.0', id, error: { code, message: errorMessage } });
		call.end();
	};
	if (id === undefined || id === null) {
		// A notification: an empty stream and grpc-status 0.
		call.end();
		return;
	}
	switch (method) {
		case 'server/discover':
			respond(DISCOVER_RESULT);
			break;
		case 'tools/list':
			respond({ resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [TOOL], _meta: serverMeta });
			break;
		case 'tools/call': {
			const name = String(params.name ?? '');
			const mirrored = call.metadata.get('mcp-name');
			if (mirrored.length === 0 || String(mirrored[0]) !== name) {
				const detail = mirrored.length === 0 ? 'the Mcp-Name header is missing' : `Mcp-Name header value '${String(mirrored[0])}' does not match body value '${name}'`;
				call.emit('error', jsonRpcError(-32020, `Header mismatch: ${detail}`, id, 'tunnel'));
				return;
			}
			if (name !== TOOL.name) {
				fail(-32602, `Unknown tool: ${name}`);
				return;
			}
			const text = echoText(params.arguments as JsonObject | undefined);
			respond({ resultType: 'complete', content: [{ type: 'text', text }], structuredContent: { text }, _meta: serverMeta });
			break;
		}
		case 'subscriptions/listen': {
			// The acknowledgement first; then the stream stays open until the client cancels it.
			send({
				jsonrpc: '2.0',
				method: 'notifications/subscriptions/acknowledged',
				params: { _meta: { 'io.modelcontextprotocol/subscriptionId': id }, notifications: params.notifications ?? {} },
			});
			call.on('cancelled', () => { /* the client ended the subscription */ });
			break;
		}
		default:
			call.emit('error', jsonRpcError(-32601, `Method not found: ${method}`, id, 'tunnel'));
	}
}

//#endregion

export interface IFixtureServer {
	readonly port: number;
	readonly address: string;
	close(): Promise<void>;
}

/** Starts the fixture server on an ephemeral port of 127.0.0.1. */
export function startFixtureServer(): Promise<IFixtureServer> {
	const definitions = loadDefinitions();
	const server = new grpc.Server();
	server.addService(definitions.typed, typedHandlers);
	server.addService(definitions.tunnel, { Call: tunnelCall });
	return new Promise((resolve, reject) => {
		server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) => {
			if (err) {
				reject(err);
				return;
			}
			resolve({
				port,
				address: `127.0.0.1:${port}`,
				close: () => new Promise<void>(done => server.tryShutdown(() => done())),
			});
		});
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const fixture = await startFixtureServer();
	console.log(`READY:${fixture.port}`);
	const stop = () => fixture.close().then(() => process.exit(0));
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}
