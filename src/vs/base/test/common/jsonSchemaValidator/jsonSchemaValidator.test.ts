/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DEFAULT_PATTERN_ANALYSIS_BUDGET, getPatternAnalysisRunCount } from '../../../common/jsonSchemaValidator/compile.js';
import { checkJsonSchemaDocument, compileJsonSchema, ICompiledJsonSchema, IJsonSchemaCompileOptions, isCompiledJsonSchema, JsonSchemaBudgetExceededError, JsonSchemaCompileErrorCode, PatternAnalysisBudget, validateJsonSchemaDocument } from '../../../common/jsonSchemaValidator/index.js';
import { analyzeRegexCost } from '../../../common/jsonSchemaValidator/regexCost.js';
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

		test('local reference problems can be tolerated as warnings, and the rest still validates', () => {
			const tolerant: IJsonSchemaCompileOptions = { localReferenceProblems: 'warn' };
			const sortedWarnings = (compiled: { readonly warnings: readonly { readonly code: string; readonly path: string }[] }) => compiled.warnings.map(w => `${w.code} ${w.path}`).sort();

			// a reference to a location the document does not have asserts nothing
			const refs = compile({ type: 'object', properties: { a: { $ref: '#/$defs/missing' }, b: { $ref: '#nowhere' }, c: { $ref: '#/properties/n/type' }, n: { type: 'integer' } } }, tolerant);
			assert.deepStrictEqual(sortedWarnings(refs), ['unresolved-ref /properties/a/$ref', 'unresolved-ref /properties/b/$ref', 'unresolved-ref /properties/c/$ref']);
			assertValid(refs, { a: 'anything', b: 1, c: null });
			assertInvalid(refs, { n: 'x' }, 'type');

			// a $id with a fragment: a plain name names its schema, anything else is ignored
			const ids = compile({
				$defs: { n: { $id: '#num', type: 'number' }, s: { $id: 'https://example.com/s.json#x/y', type: 'string' } },
				properties: { a: { $ref: '#num' }, s: { $ref: 'https://example.com/s.json' } },
			}, tolerant);
			assert.deepStrictEqual(sortedWarnings(ids), ['invalid-schema /$defs/n/$id', 'invalid-schema /$defs/s/$id']);
			assertInvalid(ids, { a: 'x' }, 'type');
			assertInvalid(ids, { s: 1 }, 'type');
			assertValid(ids, { a: 1, s: 'x' });

			// an anchor that is not a plain name is ignored
			const anchors = compile({ $anchor: '1bad', $dynamicAnchor: 'not a name', type: 'string' }, tolerant);
			assert.deepStrictEqual(sortedWarnings(anchors), ['invalid-schema /$anchor', 'invalid-schema /$dynamicAnchor']);
			assertInvalid(anchors, 1, 'type');

			// by default each is a compile error; a reference to another document stays one
			assert.deepStrictEqual(compileErrors({ properties: { c: { $ref: '#/properties/n/type' }, n: { type: 'integer' } } }), ['unresolved-ref']);
			assert.deepStrictEqual(compileErrors({ $defs: { n: { $id: '#num' } } }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors({ $dynamicAnchor: 'not a name' }), ['invalid-schema']);
			assert.deepStrictEqual(compileErrors({ $ref: 'https://example.com/other.json' }, tolerant), ['remote-ref']);
			assert.deepStrictEqual(compileErrors({ $ref: 'https://json-schema.org/draft/2020-12/schema#/$defs/missing', type: 5 }, tolerant), ['invalid-schema']);

			// the document check agrees: the metaschema leaves these to the compiler
			const document = { type: 'object', $id: 'urn:example:tool#input', $defs: { n: { $anchor: '1bad' } }, properties: { a: { $ref: '#/$defs/missing' } } };
			assert.ok(checkJsonSchemaDocument(document).errors.length > 0);
			const check = checkJsonSchemaDocument(document, tolerant);
			assert.deepStrictEqual(check.errors, []);
			assert.deepStrictEqual(sortedWarnings(check), ['invalid-schema /$defs/n/$anchor', 'invalid-schema /$id', 'unresolved-ref /properties/a/$ref']);
			assert.ok(checkJsonSchemaDocument({ type: 'object', properties: { a: { type: 5 } } }, tolerant).errors.some(e => e.path === '/properties/a/type'), 'other problems stay errors');
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
			assert.deepStrictEqual(compileErrors({ $schema: 'http://json-schema.org/draft-04/schema#' }, { unsupportedDialect: 'error' }), ['unsupported-dialect']);
			assert.strictEqual(compile({ $schema: 'https://json-schema.org/draft/2020-12/schema' }).dialect, '2020-12');
			assert.strictEqual(compile({}, draft7).dialect, 'draft-07');
			assert.strictEqual(compile({ $schema: 'https://json-schema.org/draft/2020-12/schema' }, draft7).dialect, '2020-12');
		});

		test('tolerates an unsupported dialect with a warning when asked to, validating in the default dialect', () => {
			const tolerant: IJsonSchemaCompileOptions = { dialect: 'draft-07', unsupportedDialect: 'warn' };
			const schema = compile({ $schema: 'http://json-schema.org/draft-04/schema#', items: [{ type: 'string' }], additionalItems: false }, tolerant);
			assert.strictEqual(schema.dialect, 'draft-07');
			assert.deepStrictEqual(schema.warnings.map(w => [w.code, w.path]), [['unsupported-dialect', '/$schema']]);
			assertValid(schema, ['a']);
			assertInvalid(schema, [1], 'type');
			assertInvalid(schema, ['a', 'b']);
			assert.strictEqual(compile({ $schema: 'https://json-schema.org/draft/2019-09/schema' }, { unsupportedDialect: 'warn' }).dialect, '2020-12');
			// a supplied remote document in an unsupported dialect is tolerated the same way
			const remoteDocuments = new Map<string, unknown>([['https://example.com/old.json', { $schema: 'http://json-schema.org/draft-04/schema#', type: 'integer' }]]);
			const withRemote = compile({ $ref: 'https://example.com/old.json' }, { ...tolerant, remoteDocuments });
			assert.deepStrictEqual(withRemote.warnings.map(w => w.code), ['unsupported-dialect']);
			assertInvalid(withRemote, 'x', 'type');
			assert.deepStrictEqual(compileErrors({ $ref: 'https://example.com/old.json' }, { remoteDocuments }), ['unsupported-dialect']);
			// the document check agrees
			const check = checkJsonSchemaDocument({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} }, tolerant);
			assert.deepStrictEqual(check.errors, []);
			assert.deepStrictEqual(check.warnings.map(w => w.code), ['unsupported-dialect']);
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

		test('regular expressions are guarded: a rejected pattern asserts nothing and is a warning', () => {
			const unsafe = [
				'(a+)+$', '(?:a*)*', '(a{2,}){3,}', '((ab)+c)*', '(a)\\1', '(?<n>a)\\k<n>', '(?<=a)b', '(?<!a)b',
				// a common hostname / e-mail domain pattern: nested unbounded quantifiers
				'^([a-z0-9-]+\\.)+[a-z]{2,}$',
				// groups nested so deep that analysing them could exhaust the stack (2000 levels did)
				'('.repeat(65) + 'a' + ')'.repeat(65), '('.repeat(2000) + ')'.repeat(2000),
			];
			for (const pattern of unsafe) {
				const schema = compile({ type: 'string', pattern, minLength: 2 });
				assert.deepStrictEqual(schema.warnings.map(w => [w.code, w.path]), [['invalid-pattern', '/pattern']], pattern);
				assertValid(schema, '!!'); // the pattern is not asserted…
				assertInvalid(schema, '!', 'minLength'); // …the other keywords are
				assertInvalid(schema, 1, 'type');
			}
			for (const safe of ['(a+)?', '(ab){2,5}', '(?<name>a+)b*', '^(?=a+)b+', '[(a+)]+', '\\(a+\\)+', '^(a+)(b+)$', '^\\d{3}-\\d{4}$', '(a+)(?:b)*', '('.repeat(64) + 'a' + ')'.repeat(64)]) {
				assert.deepStrictEqual(compile({ pattern: safe }).warnings, [], safe);
			}
			assert.deepStrictEqual(compile({ pattern: '('.repeat(65) + 'a' + ')'.repeat(65) }).warnings.map(w => w.message), ['Pattern is not checked: groups nested more than 64 deep are not supported']);
		});

		test('a repeated group with alternatives, or of varying length, is not asserted: a single RegExp.test cannot be interrupted', () => {
			const unsafe = [
				// overlapping alternatives under a quantifier backtrack exponentially (`^(a|a)*$` on `aaa…b`)
				'^(a|a)*$', '^(a|b)+$', '(a|b){2}', '((a|b)c)+', '(?:x(?:a|b)?)+', '(?<n>a|b)*',
				// a repeated group of unbounded length (polynomial or worse)
				'(a*){2}', '^(\\w+\\.){2}\\w+$',
				// a group whose length varies, repeated without bound or so often that it can split a match in more than 256 ways
				'(ab?)*', '(a?)+', '(a{1,2}){9}', '((a{1,2}){3}){3}', '(\\d{1,4}:){7}',
			];
			for (const pattern of unsafe) {
				const schema = compile({ type: 'string', pattern });
				assert.deepStrictEqual(schema.warnings.map(w => [w.code, w.path]), [['invalid-pattern', '/pattern']], pattern);
				assertInvalid(schema, 1, 'type');
			}
			// not asserted, so the instance that makes the pattern backtrack is answered at once
			const started = Date.now();
			assertValid(compile({ type: 'string', pattern: '^(a|a)*$' }), 'a'.repeat(40) + 'b');
			assert.ok(Date.now() - started < 1000);

			for (const safe of ['^(a|b)$', '(a|b)?', '^(\\+|-)?\\d+$', '([a-z]{2})+', '(?:ab)+', '^(a{1,2}){8}$', '^((a{1,2}){2}){2}$', '^(\\d{1,3}\\.){3}\\d{1,3}$', '^\\w+(?:\\.\\w+)?$']) {
				assert.deepStrictEqual(compile({ pattern: safe }).warnings, [], safe);
			}
			// Unanchored, the 256 splits are tried at every position: still asserted, on strings that one test can check within the step budget.
			assert.deepStrictEqual(compile({ pattern: '(a{1,2}){8}' }).warnings.map(w => w.message), ['Pattern is checked only for strings of at most 9763 characters: its backtracking can take 1024 steps for each character of the input']);
			const ipv4 = compile({ type: 'string', pattern: '^(\\d{1,3}\\.){3}\\d{1,3}$' });
			assertValid(ipv4, '10.0.0.1');
			assertInvalid(ipv4, '10.0.0', 'pattern');
		});

		test('polynomial backtracking is bounded: a pattern is not asserted, or only on strings it can test within the step budget', () => {
			const warningsOf = (pattern: string) => compile({ type: 'string', pattern }).warnings.map(w => w.message);
			// Loops whose give-backs let the next loop match again: one test of n characters costs about n^k steps.
			// Bounded loops multiply the splits instead (`a{0,30}` ten times: 31^9 per position).
			for (const pattern of ['^' + 'a*'.repeat(16) + '$', '^a*a*a*a*$', '\\d+\\d+\\d+$', '^a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?a{30}$', '^' + 'a{0,30}'.repeat(10) + '$']) {
				const schema = compile({ type: 'string', pattern, minLength: 2 });
				assert.deepStrictEqual(schema.warnings.map(w => [w.code, w.path, w.message.startsWith('Pattern is not checked: its backtracking can ')]), [['invalid-pattern', '/pattern', true]], pattern);
				assertValid(schema, 'a'.repeat(18) + '!'); // not asserted: the 8 s test of the review is answered at once
				assertInvalid(schema, '!', 'minLength');
			}
			assert.deepStrictEqual(warningsOf('\\d+\\d+\\d+$'), ['Pattern is not checked: its backtracking can take time that grows with the input length to the power 4']);
			assert.deepStrictEqual(warningsOf('^(a|a)*$'), ['Pattern is not checked: a repeated group with alternatives is not supported (it can backtrack exponentially)']);

			// Quadratic and cubic patterns are tested on strings up to the length the budget allows, and only on those.
			assert.deepStrictEqual(warningsOf('^[^@]+@[^@]+\\.[^@]+$'), ['Pattern is checked only for strings of at most 2234 characters: its backtracking can take time that grows with the square of the input length']);
			assert.deepStrictEqual(warningsOf('^a*a*a*$'), ['Pattern is checked only for strings of at most 169 characters: its backtracking can take time that grows with the cube of the input length']);
			assert.deepStrictEqual(warningsOf('a+b'), ['Pattern is checked only for strings of at most 2235 characters: its backtracking can take time that grows with the square of the input length'], 'an unanchored search retries at every position');
			const email = compile({ type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' });
			assertValid(email, 'user@example.com');
			assertInvalid(email, 'user@example', 'pattern');
			assertInvalid(email, 'a@' + '.'.repeat(2231) + '@', 'pattern'); // the longest string tested
			assertValid(email, 'a@' + '.'.repeat(2232) + '@'); // one character more is not tested
			const cubic = compile({ type: 'string', pattern: '^a*a*a*$' });
			let started = Date.now();
			assertInvalid(cubic, 'a'.repeat(168) + '!', 'pattern');
			assertValid(cubic, 'a'.repeat(5000) + '!');
			assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);

			// The same limit applies to patternProperties keys: a longer key may match, so nothing is asserted about it.
			const keyed = compile({ patternProperties: { 'x+y': { type: 'string' } }, additionalProperties: false });
			assert.deepStrictEqual(keyed.warnings.map(w => w.path), ['/patternProperties/x+y']);
			assertValid(keyed, { xy: 'v' });
			assertInvalid(keyed, { xy: 1 }, 'type');
			assertInvalid(keyed, { z: 'v' }, 'additionalProperties');
			assertValid(keyed, { ['x'.repeat(5000)]: 1 });

			// Common patterns whose time grows linearly are asserted on strings of any length, without a warning.
			const linear: [pattern: string, valid: string, invalid: string][] = [
				['^\\d+\\.\\d+\\.\\d+$', '1.22.333', '1.2'],
				['^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$', '1.0.0-rc.1+build.5', '01.0.0'],
				['^\\d{4}-\\d{2}-\\d{2}$', '2026-07-28', '2026-7-28'],
				['^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$', '2026-07-28T10:00:00.5Z', '2026-07-28T10:00'],
				['^[a-z][a-z0-9-]*$', 'my-server-2', '2-server'],
				['^https?://\\S+$', 'https://example.com/a', 'ftp://example.com'],
				['^\\s*\\S+\\s*$', '  token ', 'two words'],
				['^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', '123e4567-e89b-12d3-a456-426614174000', '123e4567'],
				['\\d+', 'abc1', 'abc'],
				['\\(a+\\)', 'x(aa)', '(aa'],
			];
			for (const [pattern, valid, invalid] of linear) {
				const schema = compile({ type: 'string', pattern });
				assert.deepStrictEqual(schema.warnings, [], pattern);
				assertValid(schema, valid);
				assertInvalid(schema, invalid, 'pattern');
			}
			started = Date.now();
			assertInvalid(compile({ type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }), '1'.repeat(1_000_000) + '!', 'pattern');
			assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
		});

		test('a pattern that compiles only without the u flag is costed as that mode reads it: \\u{N} repeats u, and a quantifier after an astral character repeats its trail surrogate', () => {
			const warningsOf = (pattern: string) => compile({ type: 'string', pattern }).warnings.map(w => w.message);
			// With the u flag `\u{0}` is a character between the loops; `\:` is a syntax error with it, so the
			// same loops without it are adjacent (`\u{0}` is `u` zero times), and `😀+` is `😀+`.
			const separated = '^' + 'u*\\u{0}'.repeat(5) + 'u*$';
			const adjacent = '^\\:?' + 'u*\\u{0}'.repeat(5) + 'u*$';
			const astral = '^\\:?' + '\u{1F600}+\\uDE00*x'.repeat(5) + '$';
			assert.deepStrictEqual(warningsOf(separated), []);
			assert.deepStrictEqual(warningsOf('^' + '\u{1F600}+\\uDE00*x'.repeat(5) + '$'), []);
			assert.deepStrictEqual(warningsOf(adjacent), ['Pattern is not checked: its backtracking can take time that grows with the input length to the power 6']);
			assert.deepStrictEqual(warningsOf(astral), ['Pattern is not checked: its backtracking can take time that grows with the input length to the power 6']);
			// The other escapes of that mode: `\p{N}` repeats `p`, and `\012` is a line feed.
			assert.deepStrictEqual(warningsOf('^\\:?p*\\p{99999}!'), ['Pattern is checked only for strings of at most 2234 characters: its backtracking can take time that grows with the square of the input length']);
			assert.deepStrictEqual(warningsOf('^\\:?\\012*\\n*$'), ['Pattern is checked only for strings of at most 1579 characters: its backtracking can take time that grows with the square of the input length']);

			// Not asserted, so the instances of the review (6 s and 15 s in one RegExp.test) are answered at once, also as keys.
			const started = Date.now();
			assertValid(compile({ type: 'string', pattern: adjacent }), 'u'.repeat(90) + '!');
			assertValid(compile({ type: 'string', pattern: astral }), ('\uD83D' + '\uDE00'.repeat(40) + 'x').repeat(5) + '!');
			const keyed = compile({ patternProperties: { [adjacent]: { type: 'string' } }, additionalProperties: false });
			assert.deepStrictEqual(keyed.warnings.map(w => w.code), ['invalid-pattern']);
			assertValid(keyed, { ['u'.repeat(60) + '!']: 1 });
			assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
			const unicode = compile({ type: 'string', pattern: separated });
			assertValid(unicode, 'uu\0u\0\0\0u\0');
			assertInvalid(unicode, 'u'.repeat(90) + '!', 'pattern');
		});

		test('long counts, lookaheads in loops and long sequences are costed: such a pattern is tested only on strings it can check within the step budget', () => {
			const square = (length: number) => `Pattern is checked only for strings of at most ${length} characters: its backtracking can take time that grows with the square of the input length`;
			const cases: [pattern: string, warning: string, longest: (length: number) => string][] = [
				// Each give-back of the loop runs the count, which scans what is left of the input (14 s for 120000 characters).
				['^a*.{99999999}!', square(3160), length => 'a'.repeat(length)],
				['^[a-z]*[a-z0-9]{50000}$', square(3160), length => 'a'.repeat(length)],
				['^a*[a!]{20000,20031}!', square(3145), length => 'a'.repeat(length)],
				// An unanchored search runs the count at every position.
				['.{99999}x', square(3161), length => 'a'.repeat(length)],
				// The lookahead scans again at every iteration of the loop around it, or at every give-back of the loop before it.
				['^(?:(?=.{99999}).)*$', square(3160), length => 'a'.repeat(length - 1) + '\n'],
				['^a*(?=a*)b', square(3160), length => 'a'.repeat(length)],
				// A sequence of 4000 characters is tried at every position (1.5 s for a megabyte).
				['.'.repeat(4000) + '!', 'Pattern is checked only for strings of at most 2497 characters: its backtracking can take 4002 steps for each character of the input', length => 'a'.repeat(length)],
			];
			for (const [pattern, warning, longest] of cases) {
				const schema = compile({ type: 'string', pattern });
				assert.deepStrictEqual(schema.warnings.map(w => w.message), [warning], pattern);
				const started = Date.now();
				assertInvalid(schema, longest(Number(/at most (\d+)/.exec(warning)![1])), 'pattern');
				assertValid(schema, longest(120_000)); // not tested
				assert.ok(Date.now() - started < 1000, `${pattern} took ${Date.now() - started} ms`);
			}
			// The loop that matches, and so ends the test, also scans at every iteration (about a second for a megabyte).
			const matching = compile({ type: 'string', pattern: '^(?:(?=.{1000}).)*' });
			assert.deepStrictEqual(matching.warnings.map(w => w.message), [square(3160)]);
			const started = Date.now();
			assertValid(matching, 'a'.repeat(1_000_000));
			assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);

			// Counts that no loop before them gives back to, and a loop of a fixed-length group, stay linear.
			const linear: [pattern: string, valid: string, invalid: string][] = [
				['^[a-f0-9]{64}$', 'a'.repeat(64), 'a'.repeat(63)],
				['^(?:a{40})*$', 'a'.repeat(80), 'a'.repeat(79)],
				['^(?=.*[A-Z])(?=.*\\d).{8,}$', 'Passw0rd', 'password'],
			];
			for (const [pattern, valid, invalid] of linear) {
				const schema = compile({ type: 'string', pattern });
				assert.deepStrictEqual(schema.warnings, [], pattern);
				assertValid(schema, valid);
				assertInvalid(schema, invalid, 'pattern');
			}
		});

		test('patterns that need the ECMA-262 identity escapes of non-unicode mode compile and assert', () => {
			// Each is a syntax error with the `u` flag ("Invalid escape") and valid without it.
			const cases: [pattern: string, valid: string, invalid: string][] = [
				['^\\d{3}\\-\\d{4}$', '555-1234', '5551234'],
				['^[a-zA-Z0-9\\-\\_]+$', 'a-b_C9', 'a b'],
				['^\\#[0-9a-f]{6}$', '#00ff00', '00ff00'],
				['^[\\w\\s\\,]+$', 'a, b', 'a;b'],
				['^[a-z]+\\=[0-9]+$', 'a=1', 'a1'],
				['^\\w+\\:\\d+$', 'host:8080', 'host8080'],
				['^\\@[a-z]+$', '@user', 'user'],
				['^[^\\"]*$', 'plain', 'say "hi"'],
			];
			for (const [pattern, valid, invalid] of cases) {
				assert.throws(() => new RegExp(pattern, 'u'), SyntaxError, `${pattern} is a syntax error with the u flag`);
				const schema = compile({ pattern });
				assert.deepStrictEqual(schema.warnings, [], pattern);
				assertValid(schema, valid);
				assertInvalid(schema, invalid, 'pattern');
			}
			// The same fallback applies to patternProperties keys.
			const keyed = compile({ patternProperties: { '^x\\-': { type: 'string' } }, additionalProperties: false });
			assert.deepStrictEqual(keyed.warnings, []);
			assertValid(keyed, { 'x-a': 'v' });
			assertInvalid(keyed, { 'x-a': 1 }, 'type');
			assertInvalid(keyed, { y: 'v' }, 'additionalProperties');
		});

		test('a pattern that compiles in neither mode is not asserted and the rest of the schema still validates', () => {
			const schema = compile({ type: 'object', properties: { id: { type: 'string', pattern: '[' }, n: { type: 'integer' } }, required: ['n'] });
			assert.deepStrictEqual(schema.warnings.map(w => [w.code, w.path]), [['invalid-pattern', '/properties/id/pattern']]);
			assertValid(schema, { id: 'anything', n: 1 });
			assertInvalid(schema, { id: 'x' }, 'required');
			assertInvalid(schema, { id: 5, n: 1 }, 'type');
			assertInvalid(schema, { id: 'x', n: 1.5 }, 'type');
		});

		test('a patternProperties key that cannot be used leaves no property to additionalProperties', () => {
			const schema = compile({ patternProperties: { '^x-': { type: 'string' }, '(a+)+': { type: 'number' } }, additionalProperties: false });
			assert.deepStrictEqual(schema.warnings.map(w => [w.code, w.path]), [['invalid-pattern', '/patternProperties/(a+)+']]);
			assertValid(schema, { 'x-a': 's', other: true }); // `other` may match the unusable pattern
			assertInvalid(schema, { 'x-a': 1 }, 'type'); // the usable pattern is still asserted
			const unevaluated = compile({ patternProperties: { '[': { type: 'string' } }, unevaluatedProperties: false });
			assert.deepStrictEqual(unevaluated.warnings.map(w => w.code), ['invalid-pattern']);
			assertValid(unevaluated, { a: 1 });
		});

		test('pattern limits stay compile errors', () => {
			assert.deepStrictEqual(compileErrors({ pattern: 'a'.repeat(5000) }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ pattern: 'a' }, { maxPatternLength: 0 }), ['invalid-pattern']);
			assert.deepStrictEqual(compileErrors({ patternProperties: { ['a'.repeat(5000)]: true } }), ['invalid-pattern']);
		});

		suite('the backtracking analysis of the patterns of one compilation has a budget', () => {
			/** A long alternation of distinct characters, the slowest kind of pattern to analyze (about 10 ms for 4096 characters); `i` makes it distinct. */
			const heavy = (i: number, prefix = '') => `^${prefix}${i}:(?:${Array.from({ length: 2000 }, (_, k) => String.fromCharCode(0x4e00 + 2 * k)).join('|')})$`.slice(0, 4096);
			const workOf = (pattern: string) => analyzeRegexCost(pattern, true)!.work;
			const budgetWarning = `Pattern is not checked: analyzing the backtracking of the patterns of the schema takes more than its budget of ${DEFAULT_PATTERN_ANALYSIS_BUDGET} steps`;
			const schemaOf = (patterns: readonly string[]) => ({ type: 'object', properties: Object.fromEntries(patterns.map((pattern, i) => [`p${i}`, { type: 'string', pattern }])) });

			test('many large patterns: those beyond the budget are not asserted, with a warning, and compiling stays fast', () => {
				// Patterns no earlier compilation analyzed, so that the first compilation below analyzes them.
				const prefix = `run${Date.now()}-`;
				const patterns = Array.from({ length: 300 }, (_, i) => heavy(i, prefix));
				// The patterns the budget covers, in the order of the schema.
				let left = DEFAULT_PATTERN_ANALYSIS_BUDGET;
				let analyzed = 0;
				while (analyzed < patterns.length && workOf(patterns[analyzed]) <= left) {
					left -= workOf(patterns[analyzed]);
					analyzed++;
				}
				assert.ok(analyzed > 0 && analyzed < 20, `${analyzed} patterns fit in the budget`);
				// The analyses a compilation runs: those that fit, and the one that runs out of what is left (if anything is).
				const runsPerCompilation = { first: analyzed + (left > 0 ? 1 : 0), later: left > 0 ? 1 : 0 };
				const schema = schemaOf(patterns);
				const started = Date.now();
				let runs = getPatternAnalysisRunCount();
				const compiled = compile(schema);
				const elapsed = Date.now() - started;
				assert.strictEqual(getPatternAnalysisRunCount() - runs, runsPerCompilation.first);
				// Without the budget, analyzing them takes about 4 s here (each compilation).
				assert.ok(elapsed < 1500, `took ${elapsed} ms`);
				const expected = patterns.slice(analyzed).map((_, i) => ['invalid-pattern', `/properties/p${analyzed + i}/pattern`, budgetWarning]);
				assert.deepStrictEqual(compiled.warnings.map(w => [w.code, w.path, w.message]), expected);
				const first = String.fromCharCode(0x4e00);
				assertValid(compiled, { p0: `${prefix}0:${first}` });
				assertInvalid(compiled, { p0: `${prefix}1:${first}` }, 'pattern');
				assertValid(compiled, { [`p${patterns.length - 1}`]: 'not asserted' });
				assertInvalid(compiled, { [`p${patterns.length - 1}`]: 1 }, 'type');

				// Compiled again (as the MCP schema checks do), the same patterns are asserted, and the analyses
				// are reused: a later compilation runs only the analysis that runs out (it is not kept), so it
				// takes about 10 ms, against 100 ms for the first one.
				for (let i = 0; i < 3; i++) {
					runs = getPatternAnalysisRunCount();
					assert.deepStrictEqual(compile(schema).warnings.map(w => [w.code, w.path, w.message]), expected);
					assert.strictEqual(getPatternAnalysisRunCount() - runs, runsPerCompilation.later, `compilation ${i + 2}`);
				}
			});

			test('a single pattern of the maximal length is always analyzed: the heaviest one known takes less than the budget', () => {
				// 2040 distinct characters, each with `*` (4082 characters): about 850 000 units, some 25 ms.
				const stars = `^${Array.from({ length: 2040 }, (_, k) => String.fromCharCode(0x4e00 + 2 * k) + '*').join('')}$`;
				assert.ok(stars.length <= 4096);
				const work = workOf(stars);
				assert.ok(work > 500_000 && work < DEFAULT_PATTERN_ANALYSIS_BUDGET / 2, `${work} units`);
				// Analyzed within the budget: refused for its backtracking, not for the budget.
				const messages = compile({ pattern: stars }).warnings.map(w => w.message);
				assert.ok(messages.length === 1 && messages[0].startsWith('Pattern is not checked: its backtracking can take '), JSON.stringify(messages));
			});

			test('compilations that share a budget count as one: what one spends is gone for the others, and a pattern one paid for is free for the others', () => {
				const prefix = `shared${Date.now()}-`;
				const patterns = Array.from({ length: 40 }, (_, i) => heavy(i, prefix));
				const sharedWarning = `Pattern is not checked: analyzing the backtracking of the patterns of the schemas that share a budget of ${DEFAULT_PATTERN_ANALYSIS_BUDGET} steps takes more than that budget`;
				// Alone, each schema of one pattern is analyzed within its own budget.
				for (const pattern of patterns.slice(0, 3)) {
					assert.deepStrictEqual(compile({ pattern }).warnings, []);
				}
				// Sharing one budget, the schemas after those it covers have their pattern refused.
				let left = DEFAULT_PATTERN_ANALYSIS_BUDGET;
				let covered = 0;
				while (covered < patterns.length && workOf(patterns[covered]) <= left) {
					left -= workOf(patterns[covered]);
					covered++;
				}
				assert.ok(covered >= 3 && covered < 20, `${covered} patterns fit in the budget`);
				const budget = new PatternAnalysisBudget();
				const runs = getPatternAnalysisRunCount();
				const outcomes = patterns.map(pattern => compile({ pattern }, { sharedPatternAnalysisBudget: budget }).warnings.map(w => w.message));
				assert.deepStrictEqual(outcomes, patterns.map((_, i) => i < covered ? [] : [sharedWarning]));
				// The three patterns compiled alone are not analyzed again, and nothing is once the budget is spent.
				assert.strictEqual(getPatternAnalysisRunCount() - runs, covered - 3 + (left > 0 ? 1 : 0));
				assert.strictEqual(budget.workLeft, 0);
				// Compiled again under the same budget, a pattern it paid for is still asserted, one it refused is still refused.
				const again = compile({ properties: { a: { pattern: patterns[0] }, b: { pattern: patterns[covered] } } }, { sharedPatternAnalysisBudget: budget });
				assert.deepStrictEqual(again.warnings.map(w => [w.path, w.message]), [['/properties/b/pattern', sharedWarning]]);
				assertInvalid(again, { a: 'x' }, 'pattern');
				// A per-compilation budget is ignored when a shared one is given.
				assert.deepStrictEqual(compile({ pattern: patterns[0] }, { sharedPatternAnalysisBudget: new PatternAnalysisBudget(), patternAnalysisBudget: 0 }).warnings, []);
			});

			test('a repeated pattern is analyzed once, and schemas of usual patterns stay within the budget', () => {
				// 4000 copies of the slowest pattern: about 48 s without the budget, all of it analyzing the same pattern again.
				// The run count decides; the time bound only catches that 48 s, since CI browsers are slower than this machine.
				const started = Date.now();
				const runs = getPatternAnalysisRunCount();
				const repeated = compile(schemaOf(Array.from({ length: 4000 }, () => heavy(0))));
				assert.ok(getPatternAnalysisRunCount() - runs <= 1, `${getPatternAnalysisRunCount() - runs} analyses`);
				assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
				assert.deepStrictEqual(repeated.warnings, []);
				assertInvalid(repeated, { p3999: '0:x' }, 'pattern');
				const usual = compile(schemaOf(Array.from({ length: 4000 }, (_, i) => `^${i}\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$`)));
				assert.deepStrictEqual(usual.warnings, []);
				assertValid(usual, { p3999: '3999.1.0-rc.1' });
				assertInvalid(usual, { p3999: '3999.01.0' }, 'pattern');
			});

			test('an analysis found from an earlier compilation is charged what it took, so the budget decides alone', () => {
				const pattern = heavy(1);
				const work = workOf(pattern);
				assert.deepStrictEqual(compile({ pattern }).warnings, []); // analyzed (and kept)
				const tight = (budget: number) => compile({ pattern }, { patternAnalysisBudget: budget }).warnings.map(w => w.message);
				assert.deepStrictEqual(tight(work - 1), [budgetWarning.replace(String(DEFAULT_PATTERN_ANALYSIS_BUDGET), String(work - 1))]);
				assert.deepStrictEqual(tight(work), []);
				// A pattern beyond the budget uses up the rest (its analysis stopped there): every later pattern that needs
				// an analysis is refused, even one that would fit in what was left; a repeat of one analyzed before is not.
				const later = compile({ properties: { a: { pattern }, b: { pattern: heavy(2) }, c: { pattern: '^x+$' }, d: { pattern } } }, { patternAnalysisBudget: work + workOf('^x+$') });
				assert.deepStrictEqual(later.warnings.map(w => w.path), ['/properties/b/pattern', '/properties/c/pattern']);
				assertInvalid(later, { d: '1:x' }, 'pattern');
			});
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
			assert.deepStrictEqual(validateJsonSchemaDocument({ pattern: 'a'.repeat(5000) }).map(error => error.code), ['invalid-pattern']);
			assert.deepStrictEqual(validateJsonSchemaDocument({ $id: 'urn:example:foo-bar-baz-qux#somepart' }).map(error => error.code), ['invalid-schema']);
			assert.ok(validateJsonSchemaDocument({ $schema: 'http://json-schema.org/draft-07/schema#', items: [5] }).some(error => error.code === 'invalid-schema'));
			assert.ok(validateJsonSchemaDocument(5).some(error => error.code === 'invalid-schema'));
		});

		test('a document with a pattern that cannot be used is accepted with a warning', () => {
			for (const pattern of ['(a+)+', '^([a-z0-9-]+\\.)+[a-z]{2,}$', '[']) {
				const schema = { type: 'object', properties: { host: { type: 'string', pattern } } };
				assert.deepStrictEqual(validateJsonSchemaDocument(schema), [], pattern);
				const check = checkJsonSchemaDocument(schema);
				assert.deepStrictEqual(check.errors, [], pattern);
				assert.deepStrictEqual(check.warnings.map(w => [w.code, w.path]), [['invalid-pattern', '/properties/host/pattern']], pattern);
			}
			assert.deepStrictEqual(checkJsonSchemaDocument({ type: 'string', pattern: '^\\d+\\-\\d+$' }), { errors: [], warnings: [] });
		});
	});

	test('isCompiledJsonSchema', () => {
		assert.strictEqual(isCompiledJsonSchema(compileJsonSchema({})), true);
		assert.strictEqual(isCompiledJsonSchema(compileJsonSchema({ type: 5 })), false);
	});
});
