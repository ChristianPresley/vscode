/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { compileJsonSchema, ICompiledJsonSchema, IJsonSchemaCompileOptions, isCompiledJsonSchema, JsonSchemaBudgetExceededError, JsonSchemaCompileErrorCode, validateJsonSchemaDocument } from '../../../common/jsonSchemaValidator/index.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';

suite('JSON Schema Validator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function compile(schema: unknown, options?: IJsonSchemaCompileOptions): ICompiledJsonSchema {
		const result = compileJsonSchema(schema, options);
		if (!isCompiledJsonSchema(result)) {
			throw new Error(`Schema does not compile: ${result.map(error => `${error.code} at '${error.path}': ${error.message}`).join('; ')}`);
		}
		return result;
	}

	function compileErrors(schema: unknown, options?: IJsonSchemaCompileOptions): JsonSchemaCompileErrorCode[] {
		const result = compileJsonSchema(schema, options);
		assert.ok(!isCompiledJsonSchema(result), 'expected compile errors');
		return result.map(error => error.code);
	}

	function assertValid(compiled: ICompiledJsonSchema, instance: unknown): void {
		const result = compiled.validate(instance);
		assert.ok(result.valid, `expected ${JSON.stringify(instance)} to be valid: ${result.errors.map(error => `${error.instancePath} ${error.message}`).join('; ')}`);
		assert.deepStrictEqual(result.errors, []);
	}

	function assertInvalid(compiled: ICompiledJsonSchema, instance: unknown, keyword?: string): void {
		const result = compiled.validate(instance);
		assert.ok(!result.valid, `expected ${JSON.stringify(instance)} to be invalid`);
		assert.ok(result.errors.length > 0, 'expected errors');
		if (keyword) {
			assert.ok(result.errors.some(error => error.keyword === keyword), `expected an error for '${keyword}', got ${result.errors.map(error => error.keyword).join(', ')}`);
		}
	}

	suite('keywords', () => {

		test('type, including integer', () => {
			const schema = compile({ type: 'integer' });
			assertValid(schema, 1);
			assertValid(schema, 1.0);
			assertValid(schema, -0);
			assertInvalid(schema, 1.5, 'type');
			assertInvalid(schema, '1', 'type');
			const union = compile({ type: ['string', 'null'] });
			assertValid(union, 'a');
			assertValid(union, null);
			assertInvalid(union, 1, 'type');
			assertInvalid(union, undefined, 'type');
		});

		test('enum and const use deep equality', () => {
			const schema = compile({ enum: [{ a: [1, { b: 2 }] }, 'x', null] });
			assertValid(schema, { a: [1, { b: 2 }] });
			assertValid(schema, null);
			assertInvalid(schema, { a: [1, { b: 3 }] }, 'enum');
			const constant = compile({ const: { a: 1, b: [true] } });
			assertValid(constant, { b: [true], a: 1 });
			assertInvalid(constant, { a: 1, b: [1] }, 'const');
		});

		test('object keywords', () => {
			const closed = compile({ type: 'object', additionalProperties: false });
			assertValid(closed, {});
			assertInvalid(closed, { a: 1 }, 'additionalProperties');

			const schema = compile({
				type: 'object',
				properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
				patternProperties: { '^x-': { type: 'boolean' } },
				additionalProperties: { type: 'null' },
				required: ['name'],
				minProperties: 1,
				maxProperties: 4,
				propertyNames: { maxLength: 5 },
				dependentRequired: { age: ['name'] },
				dependentSchemas: { age: { properties: { name: { minLength: 2 } } } },
			});
			assertValid(schema, { name: 'ab', age: 3, 'x-a': true, other: null });
			assertInvalid(schema, { age: 3 }, 'required');
			assertInvalid(schema, { name: 'ab', age: -1 }, 'minimum');
			assertInvalid(schema, { name: 'ab', 'x-a': 1 }, 'type');
			assertInvalid(schema, { name: 'ab', other: 1 }, 'additionalProperties');
			assertInvalid(schema, { name: 'ab', toolong: null }, 'propertyNames');
			assertInvalid(schema, { name: 'a', age: 1 }, 'minLength');
			assertInvalid(schema, { name: 'ab', a: null, b: null, c: null, d: null }, 'maxProperties');
		});

		test('unevaluatedProperties sees properties evaluated by nested applicators and references', () => {
			const schema = compile({
				$defs: { base: { properties: { base: true } } },
				$ref: '#/$defs/base',
				allOf: [{ properties: { a: true } }],
				anyOf: [{ properties: { b: true }, required: ['b'] }, { properties: { c: true }, required: ['c'] }],
				oneOf: [{ properties: { d: true }, required: ['d'] }, { properties: { e: true }, required: ['e'] }],
				if: { properties: { f: { const: 1 } }, required: ['f'] },
				then: { properties: { g: true } },
				else: { properties: { h: true } },
				dependentSchemas: { a: { properties: { i: true } } },
				unevaluatedProperties: false,
			});
			assertValid(schema, { base: 1, a: 1, b: 1, d: 1, f: 1, g: 1, i: 1 });
			assertValid(schema, { b: 1, d: 1, h: 1 });
			assertInvalid(schema, { b: 1, d: 1, c: 1, x: 1 }, 'unevaluatedProperties');
			assertInvalid(schema, { b: 1, d: 1, g: 1 }, 'unevaluatedProperties');
			assertInvalid(schema, { b: 1, d: 1, i: 1 }, 'unevaluatedProperties');
		});

		test('array keywords', () => {
			const schema = compile({
				type: 'array',
				prefixItems: [{ type: 'string' }, { type: 'integer' }],
				items: { type: 'boolean' },
				contains: { const: true },
				minContains: 1,
				maxContains: 2,
				minItems: 2,
				maxItems: 5,
				uniqueItems: true,
			});
			assertValid(schema, ['a', 1, true]);
			assertValid(schema, ['a', 1, true, false]);
			assertInvalid(schema, ['a', 1, 'b'], 'type');
			assertInvalid(schema, ['a', 1, false], 'contains');
			assertInvalid(schema, ['a'], 'minItems');
			assertInvalid(schema, ['a', 1, true, false, true, false], 'maxItems');
			const unique = compile({ uniqueItems: true });
			assertValid(unique, [1, '1', true, [1], { a: 1 }, { a: 2 }]);
			assertInvalid(unique, [{ a: [1] }, { a: [1] }], 'uniqueItems');
			assertInvalid(unique, [1, 1.0], 'uniqueItems');
			const unevaluated = compile({ allOf: [{ prefixItems: [true] }], contains: { type: 'string' }, unevaluatedItems: false });
			assertValid(unevaluated, [1, 'a']);
			assertInvalid(unevaluated, [1, 'a', 2], 'unevaluatedItems');
		});

		test('numeric keywords', () => {
			const schema = compile({ minimum: 1, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 11, multipleOf: 0.01 });
			assertValid(schema, 1);
			assertValid(schema, 1.23);
			assertValid(schema, 10);
			assertInvalid(schema, 0.5, 'minimum');
			assertInvalid(schema, 10.5, 'maximum');
			assertInvalid(schema, 1.005, 'multipleOf');
			const exclusive = compile({ exclusiveMinimum: 1, exclusiveMaximum: 2 });
			assertInvalid(exclusive, 1, 'exclusiveMinimum');
			assertInvalid(exclusive, 2, 'exclusiveMaximum');
			assertValid(exclusive, 1.5);
			const multiple = compile({ multipleOf: 1e-8 });
			assertValid(multiple, 12391239123);
			assertInvalid(compile({ type: 'integer', multipleOf: 0.123456789 }), 1e308, 'multipleOf');
		});

		test('string keywords count code points and use unicode regular expressions', () => {
			const length = compile({ minLength: 2, maxLength: 3 });
			assertValid(length, 'ab');
			assertValid(length, 'é🐲');
			assertValid(length, '🐲🐲🐲');
			assertInvalid(length, '🐲', 'minLength');
			assertInvalid(length, '🐲🐲🐲🐲', 'maxLength');
			const letters = compile({ pattern: '^\\p{Letter}+$' });
			assertValid(letters, 'é\u{1D4B3}');
			assertInvalid(letters, 'a1', 'pattern');
			assertInvalid(letters, '🐲', 'pattern');
			assertValid(compile({ pattern: 'b' }), 'abc');
			assertValid(compile({ pattern: '^🐲*$' }), '🐲🐲');
			assertInvalid(compile({ pattern: '^🐲*$' }), '🐉', 'pattern');
		});

		test('combinators and conditionals', () => {
			const schema = compile({
				allOf: [{ type: 'number' }, { minimum: 0 }],
				anyOf: [{ maximum: 5 }, { multipleOf: 10 }],
				oneOf: [{ multipleOf: 2 }, { multipleOf: 3 }],
				not: { const: 4 },
				if: { minimum: 10 },
				then: { maximum: 30 },
				else: { maximum: 3 },
			});
			assertValid(schema, 2);
			assertValid(schema, 20);
			assertInvalid(schema, -2, 'minimum');
			assertInvalid(schema, 4, 'not');
			assertInvalid(schema, 7, 'anyOf');
			assertInvalid(schema, 30, 'oneOf');
			assertInvalid(schema, 40, 'maximum');
			assertInvalid(schema, 'x', 'type');
		});

		test('$ref, $defs, $id and $anchor', () => {
			const schema = compile({
				$id: 'https://example.com/root.json',
				$defs: {
					positive: { $anchor: 'positive', type: 'integer', minimum: 1 },
					nested: { $id: 'nested/schema.json', $defs: { inner: { type: 'string' } }, $ref: '#/$defs/inner' },
				},
				properties: {
					a: { $ref: '#/$defs/positive' },
					b: { $ref: '#positive' },
					c: { $ref: 'nested/schema.json' },
					d: { $ref: 'https://example.com/nested/schema.json#/$defs/inner' },
					self: { $ref: 'root.json' },
				},
			});
			assertValid(schema, { a: 1, b: 2, c: 'x', d: 'y', self: { a: 3 } });
			assertInvalid(schema, { a: 0 }, 'minimum');
			assertInvalid(schema, { b: 'x' }, 'type');
			assertInvalid(schema, { c: 1 }, 'type');
			assertInvalid(schema, { self: { d: 1 } }, 'type');
			assert.deepStrictEqual(compileErrors({ $ref: '#/$defs/missing' }), ['unresolved-ref']);
			assert.deepStrictEqual(compileErrors({ $ref: '#missing' }), ['unresolved-ref']);
		});

		test('$ref applies alongside sibling keywords in 2020-12 and creates a new scope', () => {
			const schema = compile({ $defs: { a: { type: 'integer' } }, $ref: '#/$defs/a', minimum: 5 });
			assertValid(schema, 5);
			assertInvalid(schema, 4, 'minimum');
			assertInvalid(schema, 5.5, 'type');
			const scope = compile({ $defs: { a: { unevaluatedProperties: false } }, properties: { prop1: { type: 'string' } }, $ref: '#/$defs/a' });
			assertInvalid(scope, { prop1: 'match' }, 'unevaluatedProperties');
		});

		test('$dynamicRef resolves through the dynamic scope', () => {
			const schema = compile({
				$id: 'https://example.com/strict-tree',
				$dynamicAnchor: 'node',
				$ref: 'tree',
				unevaluatedProperties: false,
				$defs: {
					tree: {
						$id: 'tree',
						$dynamicAnchor: 'node',
						type: 'object',
						properties: { data: true, children: { type: 'array', items: { $dynamicRef: '#node' } } },
					},
				},
			});
			assertValid(schema, { children: [{ data: 1 }] });
			assertInvalid(schema, { children: [{ daat: 1 }] }, 'unevaluatedProperties');
		});

		test('format is an annotation unless assertFormats is set', () => {
			const schema = { type: 'string', format: 'email' };
			assertValid(compile(schema), 'not an email');
			const asserting = compile(schema, { assertFormats: true });
			assertValid(asserting, 'someone@example.com');
			assertInvalid(asserting, 'not an email', 'format');

			const check = (format: string, valid: string[], invalid: string[]) => {
				const compiled = compile({ format }, { assertFormats: true });
				for (const value of valid) {
					assertValid(compiled, value);
				}
				for (const value of invalid) {
					assertInvalid(compiled, value, 'format');
				}
			};
			check('date', ['2024-02-29', '1999-12-31'], ['2023-02-29', '2024-13-01', '2024-1-1']);
			check('time', ['23:59:60Z', '08:30:06.283185+01:00', '23:20:50.52z'], ['24:00:00Z', '12:00:60Z', '08:30:06']);
			check('date-time', ['1985-04-12T23:20:50.52Z', '1996-12-19t16:39:57-08:00'], ['1985-04-12', '1985-04-12T23:20:50.52', '1985-04-12 23:20:50.52']);
			check('uuid', ['2eb8aa08-aa98-11ea-b4aa-73b441d16380', '2EB8AA08-AA98-11EA-B4AA-73B441D16380'], ['2eb8aa08-aa98-11ea-b4aa-73b441d1638', 'not-a-uuid']);
			check('ipv4', ['192.168.0.1', '0.0.0.0'], ['256.0.0.1', '192.168.0', '087.10.0.1', '1.2.3.4.5']);
			check('ipv6', ['::1', '2001:db8::8a2e:370:7334', '::ffff:192.168.0.1', '1:2:3:4:5:6:7:8'], ['1:2:3:4:5:6:7', ':1', '1::2::3', '12345::']);
			check('uri', ['https://example.com/a?b#c', 'urn:isbn:0451450523', 'mailto:a@b.c'], ['/relative', 'not a uri', 'http://[::1']);
			check('uri-reference', ['https://example.com', '/relative/path', '#fragment', ''], ['has space', 'back\\slash']);
			check('regex', ['^a+$', '\\p{L}'], ['(', '[a-']);
			check('json-pointer', ['', '/a/b', '/a~0b/~1c'], ['a', '/a~2']);
			check('made-up-format', ['anything'], []);
			assertValid(compile({ format: 'date' }, { assertFormats: true }), 12);
		});

		test('reports instance and schema locations', () => {
			const schema = compile({ properties: { 'a/b': { items: { type: 'number' } } } });
			const result = schema.validate({ 'a/b': [1, 'x'] });
			assert.strictEqual(result.valid, false);
			assert.deepStrictEqual(result.errors.map(error => [error.instancePath, error.schemaPath, error.keyword]), [
				['/a~1b/1', '#/properties/a~1b/items/type', 'type'],
			]);
		});

		test('boolean schemas', () => {
			assertValid(compile(true), { anything: [1] });
			assertInvalid(compile(false), 1, 'false');
			assertValid(compile({ properties: { a: false } }), {});
			assertInvalid(compile({ properties: { a: false } }), { a: 1 }, 'false');
		});

		test('invalid keyword values are compile errors', () => {
			assert.deepStrictEqual(compileErrors({ type: 5 }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors({ type: 'array', items: 5 }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors({ minimum: '1' }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors({ required: [1] }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors({ properties: [] }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors({ $id: 'https://example.com/a#b' }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors([]), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors('string'), ['invalid-schema']);
		});
	});

	suite('draft-07', () => {

		const draft7 = { dialect: 'draft-07' } as const;

		test('is detected from $schema and supports tuple items with additionalItems', () => {
			const schema = compile({
				$schema: 'http://json-schema.org/draft-07/schema#',
				items: [{ type: 'string' }, { type: 'integer' }],
				additionalItems: { type: 'boolean' },
			});
			assert.strictEqual(schema.dialect, 'draft-07');
			assertValid(schema, ['a', 1, true, false]);
			assertValid(schema, ['a']);
			assertInvalid(schema, [1], 'type');
			assertInvalid(schema, ['a', 1, 'b'], 'type');
			const open = compile({ items: [{ type: 'string' }] }, draft7);
			assertValid(open, ['a', 1, {}]);
			const schemaItems = compile({ items: { type: 'string' }, additionalItems: false }, draft7);
			assertValid(schemaItems, ['a', 'b']);
			assertInvalid(schemaItems, ['a', 1], 'type');
		});

		test('supports boolean exclusiveMinimum and exclusiveMaximum', () => {
			const schema = compile({ minimum: 1, exclusiveMinimum: true, maximum: 5, exclusiveMaximum: true }, draft7);
			assertValid(schema, 2);
			assertInvalid(schema, 1, 'exclusiveMinimum');
			assertInvalid(schema, 5, 'exclusiveMaximum');
			const inclusive = compile({ minimum: 1, exclusiveMinimum: false }, draft7);
			assertValid(inclusive, 1);
			assertInvalid(inclusive, 0, 'minimum');
		});

		test('supports definitions, dependencies and ignores $ref siblings', () => {
			const schema = compile({
				definitions: { int: { type: 'integer' } },
				properties: { a: { $ref: '#/definitions/int', type: 'string' } },
				dependencies: { b: ['c'], d: { required: ['e'] } },
			}, draft7);
			assertValid(schema, { a: 1 });
			assertInvalid(schema, { a: 'x' }, 'type');
			assertInvalid(schema, { b: 1 }, 'dependentRequired');
			assertValid(schema, { b: 1, c: 1 });
			assertInvalid(schema, { d: 1 }, 'required');
			assertValid(schema, { d: 1, e: 1 });
			const anchor = compile({ allOf: [{ $ref: '#foo' }], definitions: { A: { $id: '#foo', type: 'integer' } } }, draft7);
			assertValid(anchor, 1);
			assertInvalid(anchor, 'a', 'type');
		});

		test('ignores 2020-12 keywords', () => {
			const schema = compile({ prefixItems: [{ type: 'string' }], unevaluatedProperties: false, dependentRequired: { a: ['b'] } }, draft7);
			assertValid(schema, [1]);
			assertValid(schema, { a: 1, x: 1 });
		});

		test('rejects unsupported dialects', () => {
			assert.deepStrictEqual(compileErrors({ $schema: 'https://json-schema.org/draft/2019-09/schema' }), ['unsupported-dialect']);
			assert.deepStrictEqual(compileErrors({ $schema: 'http://json-schema.org/draft-04/schema#' }), ['unsupported-dialect']);
			assert.deepStrictEqual(compileErrors({ $schema: 42 }), ['unsupported-dialect']);
			assert.strictEqual(compile({ $schema: 'https://json-schema.org/draft/2020-12/schema' }).dialect, '2020-12');
			assert.strictEqual(compile({}, draft7).dialect, 'draft-07');
			assert.strictEqual(compile({ $schema: 'https://json-schema.org/draft/2020-12/schema' }, draft7).dialect, '2020-12');
		});
	});

	suite('limits', () => {

		test('maxDepth', () => {
			let deep: Record<string, unknown> = { type: 'string' };
			for (let i = 0; i < 40; i++) {
				deep = { items: deep };
			}
			assert.deepStrictEqual(compileErrors(deep), ['too-deep']);
			assertValid(compile(deep, { maxDepth: 50 }), [[['x']]]);
		});

		test('maxSubschemas', () => {
			const properties: Record<string, unknown> = {};
			for (let i = 0; i < 10; i++) {
				properties[`p${i}`] = { type: 'string' };
			}
			assert.deepStrictEqual(compileErrors({ properties }, { maxSubschemas: 5 }), ['too-many-subschemas']);
			assertValid(compile({ properties }, { maxSubschemas: 11 }), { p1: 'x' });
			assert.deepStrictEqual(compileErrors({ properties }, { maxSubschemas: 10 }), ['too-many-subschemas']);
		});

		test('maxRefHops rejects reference chains and cycles at compile time', () => {
			const defs: Record<string, unknown> = { s0: { type: 'string' } };
			for (let i = 1; i <= 70; i++) {
				defs[`s${i}`] = { $ref: `#/$defs/s${i - 1}` };
			}
			assert.deepStrictEqual(compileErrors({ $defs: defs, $ref: '#/$defs/s70' }), ['unresolved-ref']);
			assertValid(compile({ $defs: defs, $ref: '#/$defs/s70' }, { maxRefHops: 100 }), 'x');
			assert.deepStrictEqual(compileErrors({ $ref: '#' }), ['unresolved-ref']);
			assert.deepStrictEqual(compileErrors({ $defs: { a: { $ref: '#/$defs/b' }, b: { $ref: '#/$defs/a' } }, $ref: '#/$defs/a' }), ['unresolved-ref']);
			// Recursion through instance children is fine.
			const tree = compile({ type: 'object', properties: { child: { $ref: '#' } } });
			assertValid(tree, { child: { child: { child: {} } } });
		});

		test('maxRefHops guards dynamic reference cycles at validation time', () => {
			const schema = compile({ $dynamicAnchor: 'self', $dynamicRef: '#self' });
			assert.throws(() => schema.validate(1), JsonSchemaBudgetExceededError);
		});

		test('evalBudget', () => {
			const schema = compile({ items: { type: 'integer' } }, { evalBudget: 50 });
			assertValid(schema, [1, 2, 3]);
			assert.throws(() => schema.validate(Array.from({ length: 100 }, (_, i) => i)), JsonSchemaBudgetExceededError);
			const generous = compile({ items: { type: 'integer' } });
			assertValid(generous, Array.from({ length: 10_000 }, (_, i) => i));
		});

		test('timeBudgetMs', () => {
			const schema = compile({ items: { type: 'integer' } }, { timeBudgetMs: 0 });
			assert.throws(() => schema.validate(Array.from({ length: 10_000 }, (_, i) => i)), JsonSchemaBudgetExceededError);
		});

		test('regular expressions are guarded', () => {
			assert.deepStrictEqual(compileErrors({ pattern: '(a+)+$' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '(?:a*)*' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '(a{2,}){3,}' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '((ab)+c)*' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '(a)\\1' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '(?<n>a)\\k<n>' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '(?<=a)b' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '(?<!a)b' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: '[' }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: 'a'.repeat(5000) }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ patternProperties: { '(a+)+': true } }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: 'a' }, { maxPatternLength: 0 }), ['invalid-pattern']);
			for (const safe of ['^(a|b)+$', '(a+)?', '(ab){2,5}', '(?<name>a+)b*', '(?=a+)b+', '[(a+)]+', '\\(a+\\)+', '(a+)(b+)', '^\\d{3}-\\d{4}$', '(a+)(?:b)*']) {
				compile({ pattern: safe });
			}
		});
	});

	suite('remote references', () => {

		test('a $ref to a remote document is a compile error and nothing is fetched', () => {
			const originalFetch = globalThis.fetch;
			let fetchCalls = 0;
			globalThis.fetch = () => {
				fetchCalls++;
				throw new Error('fetch must not be called');
			};
			try {
				assert.deepStrictEqual(compileErrors({ $ref: 'https://example.com/schema.json' }), ['remote-ref']);
				assert.deepStrictEqual(compileErrors({ properties: { a: { $ref: 'http://localhost:1234/integer.json#/$defs/x' } } }), ['remote-ref']);
				assert.deepStrictEqual(compileErrors({ $id: 'https://example.com/root.json', $ref: 'other.json' }), ['remote-ref']);
				assert.deepStrictEqual(compileErrors({ $ref: 'other.json' }), ['remote-ref']);
			} finally {
				globalThis.fetch = originalFetch;
			}
			assert.strictEqual(fetchCalls, 0);
		});

		test('remote documents supplied through options resolve', () => {
			const remoteDocuments = new Map<string, unknown>([
				['https://example.com/schemas/integer.json', { $id: 'https://example.com/schemas/integer.json', type: 'integer' }],
				['https://example.com/schemas/list.json', { $defs: { item: { $ref: 'integer.json' } }, type: 'array', items: { $ref: '#/$defs/item' } }],
				['https://example.com/schemas/draft7.json', { $schema: 'http://json-schema.org/draft-07/schema#', items: [{ $ref: 'integer.json' }], additionalItems: false }],
			]);
			const schema = compile({ properties: { list: { $ref: 'https://example.com/schemas/list.json' }, tuple: { $ref: 'https://example.com/schemas/draft7.json' } } }, { remoteDocuments });
			assertValid(schema, { list: [1, 2], tuple: [1] });
			assertInvalid(schema, { list: [1, 'x'] }, 'type');
			assertInvalid(schema, { tuple: [1, 2] }, 'false');
			assert.deepStrictEqual(compileErrors({ $ref: 'https://example.com/schemas/list.json#/$defs/missing' }, { remoteDocuments }), ['unresolved-ref']);
		});

		test('the metaschemas are built in', () => {
			const schema = compile({ $ref: 'https://json-schema.org/draft/2020-12/schema' });
			assertValid(schema, { $defs: { foo: { type: 'integer' } } });
			assertInvalid(schema, { $defs: { foo: { type: 1 } } });
			assertInvalid(schema, { minLength: -1 });
			const draft7 = compile({ $ref: 'http://json-schema.org/draft-07/schema#' }, { dialect: 'draft-07' });
			assertValid(draft7, { definitions: { foo: { type: 'integer' } } });
			assertInvalid(draft7, { definitions: { foo: { type: 1 } } });
		});
	});

	suite('validateJsonSchemaDocument', () => {

		test('accepts a typical tool input schema', () => {
			assert.deepStrictEqual(validateJsonSchemaDocument({
				type: 'object',
				properties: {
					path: { type: 'string', description: 'The file to read' },
					lines: { type: 'integer', minimum: 1, default: 100 },
					mode: { type: 'string', enum: ['text', 'binary'] },
					tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
				},
				required: ['path'],
				additionalProperties: false,
			}), []);
			assert.deepStrictEqual(validateJsonSchemaDocument(true), []);
			assert.deepStrictEqual(validateJsonSchemaDocument({ $schema: 'http://json-schema.org/draft-07/schema#', items: [{ type: 'string' }] }), []);
		});

		test('rejects invalid documents', () => {
			const arrayErrors = validateJsonSchemaDocument({ type: 'array', items: 5 });
			assert.ok(arrayErrors.length > 0);
			assert.ok(arrayErrors.every(error => error.code === 'invalid-schema'));
			assert.ok(arrayErrors.some(error => error.path === '/items'), JSON.stringify(arrayErrors));
			const typeErrors = validateJsonSchemaDocument({ type: 5 });
			assert.ok(typeErrors.length > 0);
			assert.ok(typeErrors.some(error => error.code === 'invalid-schema' && error.path === '/type'), JSON.stringify(typeErrors));
			assert.deepStrictEqual(validateJsonSchemaDocument({ $schema: 'https://json-schema.org/draft/2019-09/schema' }).map(error => error.code), ['unsupported-dialect']);
			assert.deepStrictEqual(validateJsonSchemaDocument({ $ref: 'https://example.com/other.json' }).map(error => error.code), ['remote-ref']);
			assert.deepStrictEqual(validateJsonSchemaDocument({ pattern: '(a+)+' }).map(error => error.code), ['invalid-pattern']);
			assert.deepStrictEqual(validateJsonSchemaDocument({ $id: 'urn:example:foo-bar-baz-qux#somepart' }).map(error => error.code), ['invalid-schema']);
			assert.ok(validateJsonSchemaDocument({ $schema: 'http://json-schema.org/draft-07/schema#', items: [5] }).some(error => error.code === 'invalid-schema'));
			assert.ok(validateJsonSchemaDocument(5).some(error => error.code === 'invalid-schema'));
		});
	});

	test('isCompiledJsonSchema', () => {
		assert.strictEqual(isCompiledJsonSchema(compileJsonSchema({})), true);
		assert.strictEqual(isCompiledJsonSchema(compileJsonSchema({ type: 5 })), false);
	});
});
