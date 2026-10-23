/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { compileJsonSchema, isCompiledJsonSchema } from '../../../../../base/common/jsonSchemaValidator/index.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mcpGrpcServerSchema, mcpServerSchema } from '../../common/mcpConfiguration.js';

suite('MCP configuration schema: gRPC servers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function validator() {
		const compiled = compileJsonSchema(mcpServerSchema);
		assert.ok(isCompiledJsonSchema(compiled), JSON.stringify(compiled));
		return (server: Record<string, unknown>) => compiled.validate({ servers: { server } }).valid;
	}

	test('a grpc:// or grpcs:// server with its options validates; another URL scheme or an unknown binding does not', () => {
		const isValid = validator();
		assert.deepStrictEqual({
			plaintext: isValid({ type: 'grpc', url: 'grpc://127.0.0.1:50051' }),
			tls: isValid({ type: 'grpc', url: 'grpcs://mcp.example:443', tls: { ca: '/certs/ca.pem', serverName: 'mcp.example' }, binding: 'typed', headers: { 'X-Api-Key': 'k' } }),
			http: isValid({ type: 'grpc', url: 'http://127.0.0.1:50051' }),
			binding: isValid({ type: 'grpc', url: 'grpc://127.0.0.1:50051', binding: 'json' }),
			// The other transports are unaffected.
			stdio: isValid({ command: 'node', args: ['server.js'] }),
			remote: isValid({ type: 'http', url: 'https://mcp.example/mcp' }),
		}, { plaintext: true, tls: true, http: false, binding: false, stdio: true, remote: true });
	});

	test('keepAliveMs is 0 (off) or from 300000 to what a timer can wait, deadlineMs greater than 0 and at most what a timer can wait', () => {
		const isValid = validator();
		const grpc = (options: Record<string, unknown>) => isValid({ type: 'grpc', url: 'grpc://127.0.0.1:50051', ...options });
		assert.deepStrictEqual({
			keepAlive: [-1, 0, 1, 30_000, 299_999, 300_000, 600_000, 2 ** 31 - 1, 2 ** 31, '300000'].map(keepAliveMs => grpc({ keepAliveMs })),
			deadline: [-1, 0, 1, 30_000, 2 ** 31 - 1, 2 ** 31].map(deadlineMs => grpc({ deadlineMs })),
		}, {
			keepAlive: [false, true, false, false, false, true, true, true, false, false],
			deadline: [false, false, true, true, true, false],
		});
		assert.deepStrictEqual([mcpGrpcServerSchema.properties!.deadlineMs.exclusiveMinimum, mcpGrpcServerSchema.properties!.deadlineMs.maximum], [0, 2 ** 31 - 1]);
	});

	test('binding: auto, the default, is documented as the tunnel; typed only for servers without it, never as a fallback', () => {
		const binding = mcpGrpcServerSchema.properties!.binding;
		const texts = [binding.markdownDescription ?? '', ...(binding.markdownEnumDescriptions ?? [])];
		assert.deepStrictEqual({
			enum: binding.enum,
			default: binding.default,
			auto: /^The default: the JSON-RPC tunnel, exactly as `tunnel`\. VS Code never switches to the typed service on its own\.$/.test(binding.markdownEnumDescriptions?.[0] ?? ''),
			typedOnRequest: /Set `typed` for a server that only offers the typed service/.test(binding.markdownDescription ?? ''),
			fallback: texts.some(text => /fall(s)? ?back|tries the tunnel first|(?<!never )switches to the typed/i.test(text)),
			typedWithTunnel: /the rest through the tunnel on the same connection/.test(binding.markdownEnumDescriptions?.[3] ?? ''),
		}, { enum: ['auto', 'tunnel', 'typed', 'typed-with-tunnel'], default: 'auto', auto: true, typedOnRequest: true, fallback: false, typedWithTunnel: true });
	});
});
