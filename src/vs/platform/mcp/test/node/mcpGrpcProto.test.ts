/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { IFieldDescriptor, IMessageDescriptor } from '../../../../base/common/protobuf/codec.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { JSON_RPC_MESSAGE, MCP_ENUMS, MCP_MESSAGES, TUNNEL_CALL_PATH, TUNNEL_PACKAGE, TYPED_PACKAGE, TYPED_PATH_PREFIX, TYPED_RPCS } from '../../common/mcpGrpcProto.js';

//#region A small proto3 parser

interface IParsedField {
	readonly name: string;
	readonly number: number;
	/** The type as written, or the key type of a map. */
	readonly type: string;
	readonly label?: 'optional' | 'repeated';
	readonly mapValueType?: string;
	readonly oneof?: string;
	readonly deprecated: boolean;
}

interface IParsedMessage {
	/** Dotted name relative to the package, e.g. `Prompt.Argument`. */
	readonly name: string;
	readonly fields: IParsedField[];
	readonly reserved: string[];
}

interface IParsedEnum {
	readonly name: string;
	readonly values: Record<string, number>;
}

interface IParsedRpc {
	readonly name: string;
	readonly request: string;
	readonly requestStream: boolean;
	readonly response: string;
	readonly responseStream: boolean;
}

interface IParsedFile {
	package: string;
	readonly messages: Map<string, IParsedMessage>;
	readonly enums: Map<string, IParsedEnum>;
	readonly services: Map<string, IParsedRpc[]>;
}

const SCALARS = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);

function tokenize(text: string): string[] {
	const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
	const tokens: string[] = [];
	const pattern = /"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_.]*|-?\d+|[{}();=\[\]<>,]/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(withoutComments)) !== null) {
		tokens.push(match[0]);
	}
	return tokens;
}

class ProtoParser {

	private readonly tokens: string[];
	private index = 0;
	readonly file: IParsedFile = { package: '', messages: new Map(), enums: new Map(), services: new Map() };

	constructor(text: string) {
		this.tokens = tokenize(text);
	}

	private peek(): string | undefined {
		return this.tokens[this.index];
	}

	private next(): string {
		const token = this.tokens[this.index++];
		assert.ok(token !== undefined, 'unexpected end of proto');
		return token;
	}

	private expect(token: string): void {
		const actual = this.next();
		assert.strictEqual(actual, token, `expected '${token}' at token ${this.index - 1}`);
	}

	private skipStatement(): void {
		while (this.next() !== ';') { /* consume */ }
	}

	/** Reads `[opt = value, ...]` and returns whether `deprecated = true` is among the options. */
	private readOptions(): boolean {
		if (this.peek() !== '[') {
			return false;
		}
		this.expect('[');
		let deprecated = false;
		while (this.peek() !== ']') {
			const name = this.next();
			this.expect('=');
			const value = this.next();
			if (name === 'deprecated' && value === 'true') {
				deprecated = true;
			}
			if (this.peek() === ',') {
				this.next();
			}
		}
		this.expect(']');
		return deprecated;
	}

	parse(): IParsedFile {
		while (this.peek() !== undefined) {
			const token = this.next();
			switch (token) {
				case 'syntax':
					this.expect('=');
					assert.strictEqual(this.next(), '"proto3"');
					this.expect(';');
					break;
				case 'package':
					this.file.package = this.next();
					this.expect(';');
					break;
				case 'import':
				case 'option':
					this.skipStatement();
					break;
				case 'message':
					this.parseMessage([]);
					break;
				case 'enum':
					this.parseEnum([]);
					break;
				case 'service':
					this.parseService();
					break;
				case ';':
					break;
				default:
					assert.fail(`unexpected top-level token '${token}'`);
			}
		}
		return this.file;
	}

	private parseMessage(scope: readonly string[]): void {
		const name = this.next();
		const path = [...scope, name];
		const message: IParsedMessage = { name: path.join('.'), fields: [], reserved: [] };
		this.file.messages.set(message.name, message);
		this.expect('{');
		this.parseBody(path, message, undefined);
		this.expect('}');
	}

	private parseBody(path: readonly string[], message: IParsedMessage, oneof: string | undefined): void {
		while (this.peek() !== '}') {
			const token = this.next();
			switch (token) {
				case 'message':
					assert.strictEqual(oneof, undefined, 'a nested message inside a oneof');
					this.parseMessage(path);
					break;
				case 'enum':
					assert.strictEqual(oneof, undefined, 'an enum inside a oneof');
					this.parseEnum(path);
					break;
				case 'oneof': {
					const oneofName = this.next();
					this.expect('{');
					this.parseBody(path, message, oneofName);
					this.expect('}');
					break;
				}
				case 'reserved': {
					const parts: string[] = [];
					while (this.peek() !== ';') {
						parts.push(this.next());
					}
					this.expect(';');
					message.reserved.push(parts.join(' '));
					break;
				}
				case 'option':
					this.skipStatement();
					break;
				case ';':
					break;
				case 'map': {
					this.expect('<');
					const keyType = this.next();
					this.expect(',');
					const valueType = this.next();
					this.expect('>');
					const fieldName = this.next();
					this.expect('=');
					const number = Number(this.next());
					const deprecated = this.readOptions();
					this.expect(';');
					message.fields.push({ name: fieldName, number, type: keyType, mapValueType: valueType, deprecated });
					break;
				}
				default: {
					let label: 'optional' | 'repeated' | undefined;
					let type = token;
					if (token === 'optional' || token === 'repeated') {
						label = token;
						type = this.next();
					}
					const fieldName = this.next();
					this.expect('=');
					const number = Number(this.next());
					const deprecated = this.readOptions();
					this.expect(';');
					message.fields.push({ name: fieldName, number, type, label, oneof, deprecated });
				}
			}
		}
	}

	private parseEnum(scope: readonly string[]): void {
		const name = [...scope, this.next()].join('.');
		const values: Record<string, number> = {};
		this.expect('{');
		while (this.peek() !== '}') {
			const token = this.next();
			if (token === 'option' || token === 'reserved') {
				this.skipStatement();
				continue;
			}
			if (token === ';') {
				continue;
			}
			this.expect('=');
			values[token] = Number(this.next());
			this.readOptions();
			this.expect(';');
		}
		this.expect('}');
		this.file.enums.set(name, { name, values });
	}

	private parseService(): void {
		const name = this.next();
		const rpcs: IParsedRpc[] = [];
		this.file.services.set(name, rpcs);
		this.expect('{');
		while (this.peek() !== '}') {
			const token = this.next();
			if (token === 'option') {
				this.skipStatement();
				continue;
			}
			if (token === ';') {
				continue;
			}
			assert.strictEqual(token, 'rpc');
			const rpcName = this.next();
			this.expect('(');
			let requestStream = false;
			let request = this.next();
			if (request === 'stream') {
				requestStream = true;
				request = this.next();
			}
			this.expect(')');
			this.expect('returns');
			this.expect('(');
			let responseStream = false;
			let response = this.next();
			if (response === 'stream') {
				responseStream = true;
				response = this.next();
			}
			this.expect(')');
			if (this.peek() === '{') {
				this.expect('{');
				while (this.peek() !== '}') {
					this.skipStatement();
				}
				this.expect('}');
			} else {
				this.expect(';');
			}
			rpcs.push({ name: rpcName, request, requestStream, response, responseStream });
		}
		this.expect('}');
	}
}

type ResolvedType =
	| { readonly kind: 'scalar'; readonly name: string }
	| { readonly kind: 'message'; readonly fullName: string }
	| { readonly kind: 'enum'; readonly name: string; readonly values: Record<string, number> };

/** Resolves a type as written in `scope` (a dotted message name) against the parsed file, like protoc does: innermost scope first. */
function resolveType(file: IParsedFile, scope: string, type: string): ResolvedType {
	if (SCALARS.has(type)) {
		return { kind: 'scalar', name: type };
	}
	if (type.startsWith('google.protobuf.')) {
		return { kind: 'message', fullName: type };
	}
	const parts = scope.split('.');
	for (let depth = parts.length; depth >= 0; depth--) {
		const candidate = [...parts.slice(0, depth), type].join('.');
		if (file.messages.has(candidate)) {
			return { kind: 'message', fullName: `${file.package}.${candidate}` };
		}
		const enumeration = file.enums.get(candidate);
		if (enumeration) {
			return { kind: 'enum', name: candidate, values: enumeration.values };
		}
	}
	assert.fail(`cannot resolve type '${type}' in ${scope}`);
}

//#endregion

suite('MCP - gRPC proto descriptors', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const fixtureRoot = FileAccess.asFileUri('vs/platform/mcp/test/node/fixtures/grpc').fsPath;
	const read = (file: string) => readFileSync(join(fixtureRoot, file), 'utf8');
	const messagesProto = new ProtoParser(read('mcp_messages.proto')).parse();
	const serviceProto = new ProtoParser(read('mcp.proto')).parse();
	const tunnelProto = new ProtoParser(read('mcp_zig_transport_v1.proto')).parse();

	test('the parser reads the vendored files', () => {
		assert.strictEqual(messagesProto.package, TYPED_PACKAGE);
		assert.strictEqual(serviceProto.package, TYPED_PACKAGE);
		assert.strictEqual(tunnelProto.package, TUNNEL_PACKAGE);
		assert.ok(messagesProto.messages.size > 40, `parsed ${messagesProto.messages.size} messages`);
		assert.ok(messagesProto.enums.size === 8, `parsed ${messagesProto.enums.size} enums`);
		assert.ok(messagesProto.messages.has('Prompt.Argument'), 'nested messages are scoped');
		assert.ok(messagesProto.enums.has('Icon.Theme'), 'nested enums are scoped');
	});

	test('every message of mcp_messages.proto has a descriptor and vice versa', () => {
		assert.deepStrictEqual(Object.keys(MCP_MESSAGES).sort(), [...messagesProto.messages.keys()].sort());
		for (const [name, descriptor] of Object.entries(MCP_MESSAGES)) {
			assert.strictEqual(descriptor.name, `${TYPED_PACKAGE}.${name}`, `descriptor name of ${name}`);
		}
	});

	test('every enum of mcp_messages.proto has a value table and vice versa', () => {
		assert.deepStrictEqual(Object.keys(MCP_ENUMS).sort(), [...messagesProto.enums.keys()].sort());
		for (const [name, values] of Object.entries(MCP_ENUMS)) {
			assert.deepStrictEqual({ ...values }, messagesProto.enums.get(name)!.values, `values of ${name}`);
		}
	});

	function checkFieldType(parsedType: string, field: Omit<IFieldDescriptor, 'name' | 'number'>, scope: string, what: string): void {
		const resolved = resolveType(messagesProto, scope, parsedType);
		switch (resolved.kind) {
			case 'scalar':
				assert.strictEqual(field.kind, resolved.name, `kind of ${what}`);
				assert.strictEqual(field.message, undefined, `${what} has no message`);
				assert.strictEqual(field.enum, undefined, `${what} has no enum table`);
				break;
			case 'message':
				assert.strictEqual(field.kind, 'message', `kind of ${what}`);
				assert.ok(field.message, `${what} has a message descriptor`);
				assert.strictEqual(field.message().name, resolved.fullName, `message type of ${what}`);
				break;
			case 'enum':
				assert.strictEqual(field.kind, 'enum', `kind of ${what}`);
				assert.deepStrictEqual(field.enum ? { ...field.enum } : undefined, resolved.values, `enum table of ${what}`);
				assert.strictEqual(field.enum, MCP_ENUMS[resolved.name], `${what} shares the ${resolved.name} table`);
				break;
		}
	}

	for (const [name, parsed] of messagesProto.messages) {
		test(`${name} matches the proto`, () => {
			const descriptor: IMessageDescriptor = MCP_MESSAGES[name];
			assert.ok(descriptor, `${name} has a descriptor`);
			assert.deepStrictEqual(descriptor.fields.map(f => f.name).sort(), parsed.fields.map(f => f.name).sort(), `field names of ${name}`);
			const numbers = descriptor.fields.map(f => f.number);
			assert.deepStrictEqual(numbers, [...numbers].sort((a, b) => a - b), `fields of ${name} are listed by number`);
			for (const parsedField of parsed.fields) {
				const field = descriptor.fields.find(f => f.name === parsedField.name)!;
				const what = `${name}.${parsedField.name}`;
				assert.strictEqual(field.number, parsedField.number, `number of ${what}`);
				assert.strictEqual(field.deprecated === true, parsedField.deprecated, `deprecation of ${what}`);
				assert.strictEqual(field.oneof, parsedField.oneof, `oneof of ${what}`);
				if (parsedField.mapValueType !== undefined) {
					assert.ok(field.map, `${what} is a map`);
					assert.strictEqual(field.kind, 'message', `map ${what} is a message field`);
					assert.strictEqual(field.repeated, undefined, `map ${what} is not repeated`);
					assert.strictEqual(field.presence, undefined, `map ${what} has no explicit presence`);
					assert.strictEqual(field.map.key, parsedField.type, `key kind of ${what}`);
					assert.strictEqual(field.map.value.number, 2, `value number of ${what}`);
					checkFieldType(parsedField.mapValueType, field.map.value, name, `${what} value`);
					continue;
				}
				assert.strictEqual(field.map, undefined, `${what} is not a map`);
				assert.strictEqual(field.repeated === true, parsedField.label === 'repeated', `repeated of ${what}`);
				assert.strictEqual(field.presence, parsedField.label === 'optional' ? 'explicit' : undefined, `presence of ${what}`);
				checkFieldType(parsedField.type, field, name, what);
			}
		});
	}

	test('the typed service matches mcp.proto', () => {
		const rpcs = serviceProto.services.get('Mcp');
		assert.ok(rpcs, 'mcp.proto declares the Mcp service');
		assert.strictEqual(serviceProto.services.size, 1);
		assert.deepStrictEqual(TYPED_RPCS.map(r => r.name), rpcs.map(r => r.name));
		assert.strictEqual(TYPED_PATH_PREFIX, `/${TYPED_PACKAGE}.Mcp/`);
		for (const parsed of rpcs) {
			const rpc = TYPED_RPCS.find(r => r.name === parsed.name)!;
			assert.strictEqual(parsed.requestStream, false, `${parsed.name} is unary`);
			assert.strictEqual(parsed.responseStream, false, `${parsed.name} is unary`);
			assert.strictEqual(rpc.request, MCP_MESSAGES[parsed.request], `request of ${parsed.name}`);
			assert.strictEqual(rpc.response, MCP_MESSAGES[parsed.response], `response of ${parsed.name}`);
			assert.strictEqual(rpc.path, `/${TYPED_PACKAGE}.Mcp/${parsed.name}`);
		}
		// The routing metadata of the service comments.
		assert.deepStrictEqual(TYPED_RPCS.filter(r => r.routingKey !== undefined).map(r => [r.name, r.routingKey]), [
			['ReadResource', 'mcp_resource'],
			['GetPrompt', 'mcp_prompt'],
			['CallTool', 'mcp_tool'],
			['Complete', 'mcp_resource'],
		]);
	});

	test('the tunnel matches mcp_zig_transport_v1.proto', () => {
		const message = tunnelProto.messages.get('JsonRpcMessage');
		assert.ok(message, 'the tunnel declares JsonRpcMessage');
		assert.strictEqual(tunnelProto.messages.size, 1);
		assert.deepStrictEqual(message.fields, [{ name: 'jsonrpc', number: 1, type: 'bytes', label: undefined, oneof: undefined, deprecated: false }]);
		assert.deepStrictEqual(message.reserved, ['2 to 15']);
		assert.strictEqual(JSON_RPC_MESSAGE.name, `${TUNNEL_PACKAGE}.JsonRpcMessage`);
		assert.deepStrictEqual(JSON_RPC_MESSAGE.fields, [{ name: 'jsonrpc', number: 1, kind: 'bytes' }]);
		const rpcs = tunnelProto.services.get('Mcp');
		assert.ok(rpcs, 'the tunnel declares the Mcp service');
		assert.deepStrictEqual(rpcs, [{ name: 'Call', request: 'JsonRpcMessage', requestStream: false, response: 'JsonRpcMessage', responseStream: true }]);
		assert.strictEqual(TUNNEL_CALL_PATH, `/${TUNNEL_PACKAGE}.Mcp/Call`);
	});
});
