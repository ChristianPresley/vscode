/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { buildMirroredHeaders, collectHeaderAnnotations, compareHeaderToBody, decodeHeaderValue, encodeHeaderValue, extractHeaderValues, isHeaderSafeAscii, isValidHeaderAnnotation, lowercaseHeaders, MAX_HEADER_ANNOTATIONS, McpUnsafeIntegerError, mcpNameForRequest, trimOws, valueAtPath, valueToHeaderString, verifyMirroredHeaders } from '../../common/mcpHttpHeaders.js';

suite('MCP - HttpHeaders', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('value encoding', () => {
		test('plain ASCII values travel verbatim', () => {
			assert.strictEqual(encodeHeaderValue('us-west1'), 'us-west1');
			assert.strictEqual(encodeHeaderValue('us west 1'), 'us west 1');
			assert.strictEqual(encodeHeaderValue(''), '');
			assert.strictEqual(encodeHeaderValue('42'), '42');
			assert.strictEqual(isHeaderSafeAscii('a~!b'), true);
		});

		test('spec examples are Base64-encoded with the sentinel', () => {
			assert.strictEqual(encodeHeaderValue('Hello, 世界'), '=?base64?SGVsbG8sIOS4lueVjA==?=');
			assert.strictEqual(encodeHeaderValue(' padded '), '=?base64?IHBhZGRlZCA=?=');
			assert.strictEqual(encodeHeaderValue('line1\nline2'), '=?base64?bGluZTEKbGluZTI=?=');
			assert.strictEqual(encodeHeaderValue('=?base64?literal?='), '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
		});

		test('leading, trailing and tab whitespace, CR/LF and control characters need encoding', () => {
			assert.strictEqual(isHeaderSafeAscii(' us-west1'), false);
			assert.strictEqual(isHeaderSafeAscii('us-west1 '), false);
			assert.strictEqual(isHeaderSafeAscii('\tus-west1'), false);
			assert.strictEqual(isHeaderSafeAscii('a\tb'), false);
			assert.strictEqual(isHeaderSafeAscii('a\r\nb'), false);
			assert.strictEqual(isHeaderSafeAscii('a\u0001b'), false);
			assert.strictEqual(isHeaderSafeAscii('a\u007fb'), false);
			assert.ok(encodeHeaderValue('\tus-west1').startsWith('=?base64?'));
		});

		test('decoding round-trips every encoded value and keeps literals', () => {
			for (const value of ['us-west1', '', 'Hello, 世界', ' padded ', 'line1\nline2', '=?base64?literal?=', '\tx', 'a\tb']) {
				const decoded = decodeHeaderValue(encodeHeaderValue(value));
				assert.deepStrictEqual(decoded, { kind: 'value', value }, JSON.stringify(value));
			}
			assert.deepStrictEqual(decodeHeaderValue('SGVsbG8='), { kind: 'value', value: 'SGVsbG8=' });
			assert.deepStrictEqual(decodeHeaderValue('=?base64?SGVsbG8='), { kind: 'value', value: '=?base64?SGVsbG8=' });
		});

		test('decoding is strict RFC 4648: padding required, alphabet only, length multiple of four', () => {
			assert.deepStrictEqual(decodeHeaderValue('=?base64?SGVsbG8=?='), { kind: 'value', value: 'Hello' });
			assert.strictEqual(decodeHeaderValue('=?base64?SGVsbG8?=').kind, 'error', 'unpadded');
			assert.strictEqual(decodeHeaderValue('=?base64?SGVs!!!bG8=?=').kind, 'error', 'non-alphabet');
			assert.strictEqual(decodeHeaderValue('=?base64?SGVsbG8-?=').kind, 'error', 'url-safe alphabet');
			assert.strictEqual(decodeHeaderValue('=?base64?S?=').kind, 'error', 'bad length');
			assert.deepStrictEqual(decodeHeaderValue('=?base64??='), { kind: 'value', value: '' });
		});

		test('trimOws strips SP and HTAB from both ends only', () => {
			assert.strictEqual(trimOws('  tools/list\t'), 'tools/list');
			assert.strictEqual(trimOws('us west 1'), 'us west 1');
			assert.strictEqual(trimOws(''), '');
		});
	});

	suite('annotation validation', () => {
		const schema = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, ...extra });

		test('collects valid annotations with their paths and types', () => {
			const result = collectHeaderAnnotations(schema({
				region: { type: 'string', 'x-mcp-header': 'Region' },
				priority: { type: 'integer', 'x-mcp-header': 'Priority' },
				verbose: { type: 'boolean', 'x-mcp-header': 'Verbose' },
				query: { type: 'string' },
				nested: { type: 'object', properties: { deep: { type: 'string', 'x-mcp-header': 'Deep' } } },
			}));
			assert.deepStrictEqual(result, {
				kind: 'valid',
				annotations: [
					{ header: 'Region', path: ['region'], type: 'string' },
					{ header: 'Priority', path: ['priority'], type: 'integer' },
					{ header: 'Verbose', path: ['verbose'], type: 'boolean' },
					{ header: 'Deep', path: ['nested', 'deep'], type: 'string' },
				],
			});
			assert.deepStrictEqual(collectHeaderAnnotations({ type: 'object' }), { kind: 'valid', annotations: [] });
			assert.deepStrictEqual(collectHeaderAnnotations(undefined), { kind: 'valid', annotations: [] });
		});

		test('rejects the suite\'s invalid annotation shapes', () => {
			const problem = (s: unknown) => { const r = collectHeaderAnnotations(s); return r.kind === 'invalid' ? r.problem : 'valid'; };
			assert.strictEqual(problem(schema({ value: { type: 'string', 'x-mcp-header': '' } })), 'invalid-name');
			assert.strictEqual(problem(schema({ value: { type: 'string', 'x-mcp-header': 'My Region' } })), 'invalid-name');
			assert.strictEqual(problem(schema({ value: { type: 'string', 'x-mcp-header': 'Region:Primary' } })), 'invalid-name');
			assert.strictEqual(problem(schema({ value: { type: 'string', 'x-mcp-header': 'Reg\u0001ion' } })), 'invalid-name');
			assert.strictEqual(problem(schema({ value: { type: 'string', 'x-mcp-header': 'Région' } })), 'invalid-name');
			assert.strictEqual(problem(schema({ value: { type: 'string', 'x-mcp-header': 42 } })), 'not-string');
			assert.strictEqual(problem(schema({ data: { type: 'object', 'x-mcp-header': 'Data' } })), 'not-primitive');
			assert.strictEqual(problem(schema({ items: { type: 'array', items: { type: 'string' }, 'x-mcp-header': 'Items' } })), 'not-primitive');
			assert.strictEqual(problem(schema({ nil: { type: 'null', 'x-mcp-header': 'Nil' } })), 'not-primitive');
			assert.strictEqual(problem(schema({ n: { type: 'number', 'x-mcp-header': 'N' } })), 'not-primitive');
			assert.strictEqual(problem(schema({ n: { type: ['string', 'null'], 'x-mcp-header': 'N' } })), 'not-primitive');
			assert.strictEqual(problem(schema({ n: { 'x-mcp-header': 'N' } })), 'not-primitive');
			assert.strictEqual(problem(schema({ a: { type: 'string', 'x-mcp-header': 'Region' }, b: { type: 'string', 'x-mcp-header': 'Region' } })), 'duplicate');
			assert.strictEqual(problem(schema({ a: { type: 'string', 'x-mcp-header': 'MyField' }, b: { type: 'string', 'x-mcp-header': 'myfield' } })), 'duplicate');
		});

		test('rejects annotations that are not reachable through properties only', () => {
			const problem = (s: unknown) => { const r = collectHeaderAnnotations(s); return r.kind === 'invalid' ? r.problem : 'valid'; };
			assert.strictEqual(problem({ type: 'string', 'x-mcp-header': 'Root' }), 'not-reachable');
			assert.strictEqual(problem(schema({ list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } })), 'not-reachable');
			assert.strictEqual(problem(schema({}, { anyOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] })), 'not-reachable');
			assert.strictEqual(problem(schema({}, { allOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] })), 'not-reachable');
			assert.strictEqual(problem(schema({}, { if: { properties: { a: { type: 'string', 'x-mcp-header': 'A' } } } })), 'not-reachable');
			assert.strictEqual(problem(schema({ a: { $ref: '#/$defs/x' } }, { $defs: { x: { type: 'string', 'x-mcp-header': 'A' } } })), 'not-reachable');
			assert.strictEqual(problem(schema({}, { patternProperties: { '^a': { type: 'string', 'x-mcp-header': 'A' } } })), 'not-reachable');
			assert.strictEqual(problem(schema({}, { additionalProperties: { type: 'string', 'x-mcp-header': 'A' } })), 'not-reachable');
			assert.strictEqual(problem(schema({ a: { type: 'string', not: { type: 'string', 'x-mcp-header': 'A' } } })), 'not-reachable');
		});

		test('ignores x-mcp-header keys inside instance data keywords', () => {
			const result = collectHeaderAnnotations(schema({
				a: { type: 'object', default: { 'x-mcp-header': 'ignored' }, examples: [{ 'x-mcp-header': 'ignored' }], enum: [{ 'x-mcp-header': 1 }] },
				b: { type: 'string', const: 'x-mcp-header' },
			}));
			assert.deepStrictEqual(result, { kind: 'valid', annotations: [] });
		});

		test('caps the annotation count and the nesting depth', () => {
			const properties: Record<string, unknown> = {};
			for (let i = 0; i <= MAX_HEADER_ANNOTATIONS; i++) {
				properties[`p${i}`] = { type: 'string', 'x-mcp-header': `H${i}` };
			}
			const tooMany = collectHeaderAnnotations(schema(properties));
			assert.strictEqual(tooMany.kind, 'invalid');
			assert.strictEqual(tooMany.kind === 'invalid' && tooMany.problem, 'too-many');

			let deep: Record<string, unknown> = { type: 'string' };
			for (let i = 0; i < 70; i++) {
				deep = { type: 'object', properties: { n: deep } };
			}
			const tooDeep = collectHeaderAnnotations(deep);
			assert.strictEqual(tooDeep.kind === 'invalid' && tooDeep.problem, 'too-deep');
		});

		test('isValidHeaderAnnotation accepts RFC 9110 tokens only', () => {
			assert.strictEqual(isValidHeaderAnnotation('Region'), true);
			assert.strictEqual(isValidHeaderAnnotation('X-Tenant_id.v2~'), true);
			assert.strictEqual(isValidHeaderAnnotation(''), false);
			assert.strictEqual(isValidHeaderAnnotation('a b'), false);
			assert.strictEqual(isValidHeaderAnnotation('a:b'), false);
			assert.strictEqual(isValidHeaderAnnotation('a(b)'), false);
			assert.strictEqual(isValidHeaderAnnotation('aé'), false);
		});
	});

	suite('mirroring', () => {
		const annotations = [
			{ header: 'Region', path: ['region'], type: 'string' as const },
			{ header: 'Priority', path: ['priority'], type: 'integer' as const },
			{ header: 'Verbose', path: ['verbose'], type: 'boolean' as const },
			{ header: 'Debug', path: ['debug'], type: 'boolean' as const },
			{ header: 'EmptyVal', path: ['empty_val'], type: 'string' as const },
			{ header: 'Method', path: ['method_val'], type: 'string' as const },
			{ header: 'NonAscii', path: ['non_ascii_val'], type: 'string' as const },
			{ header: 'Whitespace', path: ['whitespace_val'], type: 'string' as const },
			{ header: 'Tab', path: ['tab_val'], type: 'string' as const },
			{ header: 'CrLf', path: ['crlf_val'], type: 'string' as const },
			{ header: 'Deep', path: ['nested', 'deep'], type: 'string' as const },
		];

		test('extracts, converts and encodes annotated values; omits null, absent and unannotated ones', () => {
			const headers = extractHeaderValues({
				region: 'us-west1',
				priority: 42,
				verbose: false,
				debug: true,
				empty_val: '',
				method_val: 'test-method',
				non_ascii_val: 'Hello, 世界',
				whitespace_val: ' padded ',
				tab_val: '\tx',
				crlf_val: 'a\r\nb',
				float_val: 3.14159,
				query: 'SELECT 1',
				nested: { deep: null },
			}, annotations);
			assert.deepStrictEqual(headers, {
				'Mcp-Param-Region': 'us-west1',
				'Mcp-Param-Priority': '42',
				'Mcp-Param-Verbose': 'false',
				'Mcp-Param-Debug': 'true',
				'Mcp-Param-EmptyVal': '',
				'Mcp-Param-Method': 'test-method',
				'Mcp-Param-NonAscii': '=?base64?SGVsbG8sIOS4lueVjA==?=',
				'Mcp-Param-Whitespace': '=?base64?IHBhZGRlZCA=?=',
				'Mcp-Param-Tab': '=?base64?CXg=?=',
				'Mcp-Param-CrLf': '=?base64?YQ0KYg==?=',
			});
		});

		test('valueToHeaderString follows the spec conversions and rejects unsafe integers', () => {
			assert.strictEqual(valueToHeaderString('x', 'H'), 'x');
			assert.strictEqual(valueToHeaderString(-7, 'H'), '-7');
			assert.strictEqual(valueToHeaderString(true, 'H'), 'true');
			assert.strictEqual(valueToHeaderString(null, 'H'), undefined);
			assert.strictEqual(valueToHeaderString(undefined, 'H'), undefined);
			assert.strictEqual(valueToHeaderString({ a: 1 }, 'H'), undefined);
			assert.strictEqual(valueToHeaderString(Number.MAX_SAFE_INTEGER, 'H'), '9007199254740991');
			assert.throws(() => valueToHeaderString(Number.MAX_SAFE_INTEGER + 2, 'H'), McpUnsafeIntegerError);
		});

		test('valueAtPath reads nested values and treats null as absent', () => {
			assert.strictEqual(valueAtPath({ a: { b: 1 } }, ['a', 'b']), 1);
			assert.strictEqual(valueAtPath({ a: { b: null } }, ['a', 'b']), undefined);
			assert.strictEqual(valueAtPath({ a: 'x' }, ['a', 'b']), undefined);
			assert.strictEqual(valueAtPath(undefined, ['a']), undefined);
		});

		test('mcpNameForRequest picks name, uri or taskId by method', () => {
			assert.strictEqual(mcpNameForRequest('tools/call', { name: 'get_weather' }), 'get_weather');
			assert.strictEqual(mcpNameForRequest('prompts/get', { name: 'p' }), 'p');
			assert.strictEqual(mcpNameForRequest('resources/read', { uri: 'file:///a b.txt?x=1' }), 'file:///a b.txt?x=1');
			assert.strictEqual(mcpNameForRequest('tasks/get', { taskId: 't1' }), 't1');
			assert.strictEqual(mcpNameForRequest('tools/list', { cursor: 'x' }), undefined);
			assert.strictEqual(mcpNameForRequest('tools/call', { name: 42 }), undefined);
		});

		test('buildMirroredHeaders emits Mcp-Method, Mcp-Name and Mcp-Param headers', () => {
			assert.deepStrictEqual(buildMirroredHeaders('tools/list', {}), { 'Mcp-Method': 'tools/list' });
			assert.deepStrictEqual(buildMirroredHeaders('resources/read', { uri: 'test://static text' }), { 'Mcp-Method': 'resources/read', 'Mcp-Name': 'test://static text' });
			assert.deepStrictEqual(buildMirroredHeaders('tools/call', { name: 'get-weather' }), { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get-weather' });
			assert.deepStrictEqual(buildMirroredHeaders('tools/call', { name: 'wéather' }), { 'Mcp-Method': 'tools/call', 'Mcp-Name': '=?base64?d8OpYXRoZXI=?=' });
			assert.deepStrictEqual(
				buildMirroredHeaders('tools/call', { name: 'execute_sql', arguments: { region: 'us-west1', query: 'SELECT 1' } }, [{ header: 'Region', path: ['region'], type: 'string' }]),
				{ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'execute_sql', 'Mcp-Param-Region': 'us-west1' },
			);
			// Annotations only apply to tools/call.
			assert.deepStrictEqual(buildMirroredHeaders('prompts/get', { name: 'p', arguments: { region: 'x' } }, [{ header: 'Region', path: ['region'], type: 'string' }]), { 'Mcp-Method': 'prompts/get', 'Mcp-Name': 'p' });
		});

		test('compareHeaderToBody compares strings exactly and numbers numerically', () => {
			assert.strictEqual(compareHeaderToBody('us-west1', 'us-west1'), true);
			assert.strictEqual(compareHeaderToBody('US-WEST1', 'us-west1'), false);
			assert.strictEqual(compareHeaderToBody('42', 42), true);
			assert.strictEqual(compareHeaderToBody('42.0', 42), true);
			assert.strictEqual(compareHeaderToBody('43', 42), false);
			assert.strictEqual(compareHeaderToBody('', 42), false);
			assert.strictEqual(compareHeaderToBody('true', true), true);
			assert.strictEqual(compareHeaderToBody('True', true), false);
			assert.strictEqual(compareHeaderToBody('x', { a: 1 }), false);
		});
	});

	suite('server verification', () => {
		const schema = {
			type: 'object',
			properties: {
				region: { type: 'string', 'x-mcp-header': 'Region' },
				priority: { type: 'integer', 'x-mcp-header': 'Priority' },
				verbose: { type: 'boolean', 'x-mcp-header': 'Verbose' },
				query: { type: 'string' },
			},
		};
		const params = { name: 'execute_sql', arguments: { region: 'us-west1', priority: 42, verbose: null, query: 'SELECT 1' } };
		const good = lowercaseHeaders({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'execute_sql', 'Mcp-Param-Region': 'us-west1', 'Mcp-Param-Priority': '42' });

		test('accepts a consistent request', () => {
			assert.strictEqual(verifyMirroredHeaders(good, 'tools/call', params, schema, { protocolVersion: '2026-07-28' }), undefined);
			assert.strictEqual(verifyMirroredHeaders({ 'mcp-method': 'tools/list' }, 'tools/list', { cursor: '' }, undefined), undefined);
		});

		test('tolerates optional whitespace around standard header values', () => {
			assert.strictEqual(verifyMirroredHeaders({ ...good, 'mcp-method': ' tools/call\t', 'mcp-name': '  execute_sql ' }, 'tools/call', params, schema), undefined);
		});

		test('rejects missing or mismatched standard headers', () => {
			const msg = (r: ReturnType<typeof verifyMirroredHeaders>) => (assert.ok(r && r.code === -32020), r!.message);
			assert.match(msg(verifyMirroredHeaders({}, 'tools/list', {}, undefined, { protocolVersion: '2026-07-28' })), /MCP-Protocol-Version header is missing/);
			assert.match(msg(verifyMirroredHeaders({ 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/list' }, 'tools/list', {}, undefined, { protocolVersion: '2026-07-28' })), /does not match body value/);
			assert.match(msg(verifyMirroredHeaders({}, 'tools/list', {})), /Mcp-Method header is missing/);
			assert.match(msg(verifyMirroredHeaders({ 'mcp-method': 'TOOLS/LIST' }, 'tools/list', {})), /does not match body method/);
			assert.match(msg(verifyMirroredHeaders({ 'mcp-method': 'tools/call' }, 'tools/call', params)), /Mcp-Name header is missing/);
			assert.match(msg(verifyMirroredHeaders({ 'mcp-method': 'tools/call', 'mcp-name': 'other' }, 'tools/call', params)), /Mcp-Name header value 'other' does not match body value 'execute_sql'/);
			assert.match(msg(verifyMirroredHeaders({ 'mcp-method': 'tools/call', 'mcp-name': '=?base64?SGVsbG8?=' }, 'tools/call', params)), /invalid encoding/);
			assert.match(msg(verifyMirroredHeaders({ 'mcp-method': 'tools/call', 'mcp-name': 'exec\u0001' }, 'tools/call', params)), /invalid characters/);
		});

		test('decodes sentinel values before comparing', () => {
			const headers = lowercaseHeaders({ 'Mcp-Method': 'resources/read', 'Mcp-Name': '=?base64?dGVzdDovL3N0YXRpYyB0ZXh0?=' });
			assert.strictEqual(verifyMirroredHeaders(headers, 'resources/read', { uri: 'test://static text' }), undefined);
		});

		test('rejects custom header problems per the spec table', () => {
			const msg = (r: ReturnType<typeof verifyMirroredHeaders>) => (assert.ok(r && r.code === -32020), r!.message);
			const without = (name: string) => { const h = { ...good }; delete h[name]; return h; };
			assert.match(msg(verifyMirroredHeaders(without('mcp-param-region'), 'tools/call', params, schema)), /Mcp-Param-Region header is missing/);
			assert.match(msg(verifyMirroredHeaders({ ...good, 'mcp-param-region': 'eu-west1' }, 'tools/call', params, schema)), /Mcp-Param-Region header value 'eu-west1' does not match the body/);
			assert.match(msg(verifyMirroredHeaders({ ...good, 'mcp-param-priority': '43' }, 'tools/call', params, schema)), /Mcp-Param-Priority header value '43' does not match the body/);
			assert.match(msg(verifyMirroredHeaders({ ...good, 'mcp-param-verbose': 'true' }, 'tools/call', params, schema)), /Mcp-Param-Verbose is present but the body has no value/);
			assert.match(msg(verifyMirroredHeaders({ ...good, 'mcp-param-region': 'us\u0007west' }, 'tools/call', params, schema)), /Mcp-Param-Region has invalid characters/);
			assert.match(msg(verifyMirroredHeaders({ ...good, 'mcp-param-region': '=?base64?dXM?=' }, 'tools/call', params, schema)), /Mcp-Param-Region has an invalid encoding/);
			const unsafe = { ...params, arguments: { ...params.arguments, priority: Number.MAX_SAFE_INTEGER + 2 } };
			assert.match(msg(verifyMirroredHeaders({ ...good, 'mcp-param-priority': '9007199254740993' }, 'tools/call', unsafe, schema)), /outside the safe range/);
		});

		test('ignores unknown Mcp-Param headers and schemas with invalid annotations', () => {
			assert.strictEqual(verifyMirroredHeaders({ ...good, 'mcp-param-other': 'x' }, 'tools/call', params, schema), undefined);
			const invalidSchema = { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'a' } } };
			assert.strictEqual(verifyMirroredHeaders({ 'mcp-method': 'tools/call', 'mcp-name': 'execute_sql' }, 'tools/call', params, invalidSchema), undefined);
		});

		test('lowercaseHeaders lowercases names and drops undefined values', () => {
			assert.deepStrictEqual(lowercaseHeaders({ 'Mcp-Method': 'x', 'X-Empty': undefined }), { 'mcp-method': 'x' });
		});
	});
});
