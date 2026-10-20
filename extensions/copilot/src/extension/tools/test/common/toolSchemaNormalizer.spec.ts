/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test, vi } from 'vitest';
import { CHAT_MODEL } from '../../../../platform/configuration/common/configurationService';
import { JsonSchema } from '../../../../platform/configuration/common/jsonSchema';
import { OpenAiFunctionTool } from '../../../../platform/networking/common/fetch';
import { normalizeToolSchema } from '../../common/toolSchemaNormalizer';

describe('ToolSchemaNormalizer', () => {
	const makeTool = (properties: Record<string, JsonSchema>): OpenAiFunctionTool[] => [{
		type: 'function',
		function: {
			name: 'test',
			description: 'test',
			parameters: {
				type: 'object',
				properties,
			}
		}
	}];

	/** A named tool whose parameters are given in full, so tests can set `$schema`, `$defs` and other root keywords. */
	const namedTool = (name: string, parameters: object): OpenAiFunctionTool => ({
		type: 'function',
		function: { name, description: 'test', parameters },
	});

	/** Runs the normalizer and collects what it fixed and dropped. */
	const normalize = (family: string, tools: OpenAiFunctionTool[]) => {
		const fixes: string[] = [];
		const drops: [tool: string, reason: string][] = [];
		const result = normalizeToolSchema(family, tools, (_tool, rule) => fixes.push(rule), (tool, reason) => drops.push([tool, reason]));
		return { result, fixes, drops, names: result?.map(t => t.function.name) };
	};

	test('drops a tool with invalid primitive types and keeps the rest', () => {
		const { names, drops } = normalize(CHAT_MODEL.GPT41, [
			namedTool('first', { type: 'object', properties: { foo: { type: 'string' } } }),
			namedTool('broken', { type: 'object', properties: { foo: { type: 'text', description: 'foo' } } }),
			namedTool('last', { type: 'object', properties: { bar: { type: 'number' } } }),
		]);

		expect(names).toEqual(['first', 'last']);
		expect(drops).toHaveLength(1);
		expect(drops[0][0]).toBe('broken');
		expect(drops[0][1]).toMatch(/do not match JSON schema/);
	});

	test('returns undefined when every tool is dropped', () => {
		const { result, drops } = normalize(CHAT_MODEL.GPT41, [
			namedTool('broken', { type: 'object', properties: { foo: { type: 'text' } } }),
		]);

		expect(result).toBeUndefined();
		expect(drops.map(([tool]) => tool)).toEqual(['broken']);
	});

	test('defaults array items to any when they are missing', () => {
		const { result, fixes, drops } = normalize(CHAT_MODEL.GPT41, makeTool({
			foo: {
				type: 'array',
			}
		}));

		expect(drops).toEqual([]);
		expect((result![0].function.parameters as any).properties.foo).toEqual({ type: 'array', items: {} });
		expect(fixes).toContain('array schema has no items; defaulting to any');
	});

	test('keeps a 2020-12 schema using $defs, $ref and prefixItems', () => {
		const parameters = {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			properties: {
				point: { $ref: '#/$defs/point' },
				pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: false },
			},
			$defs: {
				point: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
			},
		};
		const { result, fixes, drops } = normalize(CHAT_MODEL.CLAUDE_SONNET, [
			namedTool('modern', parameters),
			namedTool('modernWithHash', { ...parameters, $schema: 'https://json-schema.org/draft/2020-12/schema#' }),
		]);

		expect(drops).toEqual([]);
		expect(fixes).toEqual([]);
		expect(result).toHaveLength(2);
		expect(result![0].function.parameters).toEqual(parameters);
	});

	test('validates schemas that declare draft-07 against the draft-07 meta schema', () => {
		const { names, fixes, drops } = normalize(CHAT_MODEL.GPT41, [
			namedTool('tuple', {
				$schema: 'http://json-schema.org/draft-07/schema#',
				type: 'object',
				properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } },
			}),
			namedTool('invalid', {
				$schema: 'http://json-schema.org/draft-07/schema#',
				type: 'object',
				properties: { foo: { type: 'text' } },
			}),
		]);

		expect(names).toEqual(['tuple']);
		expect(drops).toEqual([['invalid', expect.stringMatching(/do not match JSON schema \(draft-07\)/)]]);
		// The dialect was declared, so no 2020-12 attempt was reported.
		expect(fixes).not.toContainEqual(expect.stringMatching(/draft-07/));
	});

	test('falls back to draft-07 for undeclared schemas that are only valid draft-07', () => {
		const { result, fixes, drops } = normalize(CHAT_MODEL.GPT41, makeTool({
			pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
		}));

		expect(drops).toEqual([]);
		expect(result).toHaveLength(1);
		expect(fixes).toContainEqual(expect.stringMatching(/not valid JSON Schema 2020-12 \([\s\S]*\) but is valid draft-07/));
	});

	test('drops tools that declare an unsupported JSON Schema dialect', () => {
		const { names, drops } = normalize(CHAT_MODEL.GPT41, [
			namedTool('old', { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', properties: {} }),
			namedTool('fine', { type: 'object', properties: {} }),
		]);

		expect(names).toEqual(['fine']);
		expect(drops).toEqual([['old', 'unsupported JSON Schema dialect https://json-schema.org/draft/2019-09/schema']]);
	});

	test('drops tools with a remote $ref without fetching it', () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access is not allowed in this test'));
		try {
			const { names, drops } = normalize(CHAT_MODEL.GPT41, [
				namedTool('remote', {
					$schema: 'https://json-schema.org/draft/2020-12/schema',
					type: 'object',
					properties: { thing: { $ref: 'https://example.com/schemas/thing.json' } },
				}),
				namedTool('remoteDraft07', {
					$schema: 'http://json-schema.org/draft-07/schema#',
					type: 'object',
					properties: { thing: { $ref: 'thing.json#/definitions/thing' } },
				}),
				namedTool('local', {
					type: 'object',
					properties: { thing: { $ref: '#/$defs/thing' } },
					$defs: { thing: { type: 'string' } },
				}),
			]);

			expect(names).toEqual(['local']);
			expect(drops).toEqual([
				['remote', expect.stringContaining(`remote $ref 'https://example.com/schemas/thing.json'`)],
				['remoteDraft07', expect.stringContaining(`remote $ref 'thing.json#/definitions/thing'`)],
			]);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test('applies GPT-4 rules to sub-schemas under 2020-12 keywords', () => {
		const { result, fixes, drops } = normalize(CHAT_MODEL.GPT41, [namedTool('nested', {
			type: 'object',
			properties: {
				pair: { type: 'array', prefixItems: [{ type: 'string', pattern: '^a' }] },
				point: { $ref: '#/$defs/point' },
			},
			$defs: {
				point: {
					type: 'object',
					description: 'p'.repeat(2000),
					properties: { x: { type: 'number', minimum: 0 } },
					required: ['x', 'missing'],
				},
			},
			dependentSchemas: {
				pair: { properties: { label: { type: 'string', maxLength: 3 } } },
			},
		})]);

		expect(drops).toEqual([]);
		expect(result![0].function.parameters).toEqual({
			type: 'object',
			properties: {
				pair: { type: 'array', prefixItems: [{ type: 'string' }], items: {} },
				point: { $ref: '#/$defs/point' },
			},
			$defs: {
				point: {
					type: 'object',
					description: 'p'.repeat(1024),
					properties: { x: { type: 'number' } },
					required: ['x'],
				},
			},
			dependentSchemas: {
				pair: { properties: { label: { type: 'string' } } },
			},
		});
		expect(fixes).toEqual(expect.arrayContaining([
			`object has unsupported schema keyword 'pattern'`,
			`object has unsupported schema keyword 'minimum'`,
			`object has unsupported schema keyword 'maxLength'`,
			'object description is too long (truncated to 1024 chars)',
			`object has required property 'missing' that is not defined`,
		]));
	});

	test('applies Gemini and required-property rules under unevaluated and propertyNames keywords', () => {
		const { result, drops } = normalize(CHAT_MODEL.GEMINI_FLASH, [namedTool('nested', {
			type: 'object',
			properties: {},
			propertyNames: { type: ['string', 'null'] },
			unevaluatedProperties: {
				type: 'object',
				properties: { a: { type: ['number', 'null'] } },
				required: ['a', 'missing'],
			},
			unevaluatedItems: { type: ['boolean', 'null'] },
		})]);

		expect(drops).toEqual([]);
		expect(result![0].function.parameters).toEqual({
			type: 'object',
			properties: {},
			propertyNames: { type: 'string', nullable: true },
			unevaluatedProperties: {
				type: 'object',
				properties: { a: { type: 'number', nullable: true } },
				required: ['a'],
			},
			unevaluatedItems: { type: 'boolean', nullable: true },
		});
	});

	test('trims extra properties', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo: {
				type: 'array',
				items: { type: 'string' },
				minItems: 2,
				maxItems: 2,
			}
		}));

		expect(schema![0].function.parameters).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "foo": {
			      "items": {
			        "type": "string",
			      },
			      "type": "array",
			    },
			  },
			  "type": "object",
			}
		`);
	});

	test('does not fail on "in true""', () => {
		normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo: {
				type: 'array',
				items: true
			}
		}));
	});

	test('removes undefined required properties', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			foo1: {
				type: 'object',
			},
			foo2: {
				type: 'object',
				properties: { a: { type: 'string' } },
			},
			foo3: {
				type: 'object',
				properties: { a: { type: 'string' }, b: { type: 'string' } },
				required: ['a', 'b', 'c'],
			}
		}));


		expect(schema![0].function.parameters).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "foo1": {
			      "type": "object",
			    },
			    "foo2": {
			      "properties": {
			        "a": {
			          "type": "string",
			        },
			      },
			      "type": "object",
			    },
			    "foo3": {
			      "properties": {
			        "a": {
			          "type": "string",
			        },
			        "b": {
			          "type": "string",
			        },
			      },
			      "required": [
			        "a",
			        "b",
			      ],
			      "type": "object",
			    },
			  },
			  "type": "object",
			}
		`);
	});


	test('ensures object parameters', () => {
		const n1: any = normalizeToolSchema(CHAT_MODEL.GPT41, [{
			type: 'function',
			function: {
				name: 'noParams',
				description: 'test',
			}
		}, {
			type: 'function',
			function: {
				name: 'wrongType',
				description: 'test',
				parameters: { type: 'string' },
			}
		}, {
			type: 'function',
			function: {
				name: 'missingProps',
				description: 'test',
				parameters: { type: 'object' },
			}
		}]);

		expect(n1).toMatchInlineSnapshot(`
			[
			  {
			    "function": {
			      "description": "test",
			      "name": "noParams",
			    },
			    "type": "function",
			  },
			  {
			    "function": {
			      "description": "test",
			      "name": "wrongType",
			      "parameters": {
			        "properties": {},
			        "type": "object",
			      },
			    },
			    "type": "function",
			  },
			  {
			    "function": {
			      "description": "test",
			      "name": "missingProps",
			      "parameters": {
			        "properties": {},
			        "type": "object",
			      },
			    },
			    "type": "function",
			  },
			]
		`);
	});

	test('normalizes arrays for draft 2020-12', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.CLAUDE_37_SONNET, makeTool({
			foo: {
				type: 'array',
				items: [{ type: 'string' }, { type: 'number' }],
				minItems: 2,
				maxItems: 2,
			},
			bar: {
				type: 'array',
				items: { type: 'string' },
				minItems: 2,
				maxItems: 2,
			}
		}));

		expect(schema![0]).toMatchInlineSnapshot(`
			{
			  "function": {
			    "description": "test",
			    "name": "test",
			    "parameters": {
			      "properties": {
			        "bar": {
			          "items": {
			            "type": "string",
			          },
			          "maxItems": 2,
			          "minItems": 2,
			          "type": "array",
			        },
			        "foo": {
			          "items": {
			            "anyOf": [
			              {
			                "type": "string",
			              },
			              {
			                "type": "number",
			              },
			            ],
			          },
			          "maxItems": 2,
			          "minItems": 2,
			          "type": "array",
			        },
			      },
			      "type": "object",
			    },
			  },
			  "type": "function",
			}
		`);
	});

	test('converts nullable types to OpenAPI format for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_FLASH, makeTool({
			nullableString: {
				type: ['string', 'null'] as any,
				description: 'A nullable string',
			},
			nullableNumber: {
				type: ['number', 'null'] as any,
				description: 'A nullable number',
			},
			regularString: {
				type: 'string',
				description: 'A regular string',
			}
		}));

		expect(schema![0].function.parameters).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "nullableNumber": {
			      "description": "A nullable number",
			      "nullable": true,
			      "type": "number",
			    },
			    "nullableString": {
			      "description": "A nullable string",
			      "nullable": true,
			      "type": "string",
			    },
			    "regularString": {
			      "description": "A regular string",
			      "type": "string",
			    },
			  },
			  "type": "object",
			}
		`);
	});

	test('converts nullable types in nested objects for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_25_PRO, makeTool({
			person: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
					},
					email: {
						type: ['string', 'null'] as any,
						description: 'Optional email',
					},
					age: {
						type: ['integer', 'null'] as any,
					}
				}
			}
		}));

		const personProp = (schema![0].function.parameters as any).properties.person;
		expect(personProp.properties.email).toEqual({
			type: 'string',
			nullable: true,
			description: 'Optional email',
		});
		expect(personProp.properties.age).toEqual({
			type: 'integer',
			nullable: true,
		});
		expect(personProp.properties.name).toEqual({
			type: 'string',
		});
	});

	test('converts nullable types in array items for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_20_PRO, makeTool({
			items: {
				type: 'array',
				items: {
					type: ['string', 'null'] as any,
					description: 'Nullable array items',
				}
			}
		}));

		const itemsProp = (schema![0].function.parameters as any).properties.items;
		expect(itemsProp.items).toEqual({
			type: 'string',
			nullable: true,
			description: 'Nullable array items',
		});
	});

	test('does not convert nullable types for non-Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GPT41, makeTool({
			nullableString: {
				type: ['string', 'null'] as any,
				description: 'A nullable string',
			}
		}));

		// For non-Gemini models, the type array should remain unchanged
		expect((schema![0].function.parameters as any).properties.nullableString.type).toEqual(['string', 'null']);
		expect((schema![0].function.parameters as any).properties.nullableString.nullable).toBeUndefined();
	});

	test('handles multi-type union with null for Gemini models', () => {
		const schema = normalizeToolSchema(CHAT_MODEL.GEMINI_FLASH, makeTool({
			multiType: {
				type: ['string', 'number', 'null'] as any,
				description: 'Multi-type with null',
			}
		}));

		// When there are multiple non-null types, we can't use nullable keyword
		// so we just remove null from the union
		expect((schema![0].function.parameters as any).properties.multiType.type).toEqual(['string', 'number']);
		expect((schema![0].function.parameters as any).properties.multiType.nullable).toBeUndefined();
	});
});
