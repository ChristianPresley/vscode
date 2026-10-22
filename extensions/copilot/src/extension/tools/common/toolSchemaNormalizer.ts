/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Ajv, { ErrorObject, Options as AjvOptions, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import { ArrayJsonSchema, JsonSchema, ObjectJsonSchema } from '../../../platform/configuration/common/jsonSchema';
import { jsonSchemaDraft7 } from '../../../platform/configuration/common/jsonSchemaDraft7';
import { isGeminiFamily } from '../../../platform/endpoint/common/chatModelCapabilities';
import { OpenAiFunctionDef, OpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { deepClone } from '../../../util/vs/base/common/objects';

/**
 * Normalizes tool schema for various model restrictions. This is a hack
 * just to avoid issues with certain model constraints, which currently result
 * in CAPI returning a blank 400 error. This is a terrible experience in the
 * extensible MCP scenario, so here we _try_ to normalize known cases to
 * avoid that (though there may certainly be unknown cases).
 *
 * Tool schemas are validated against the JSON Schema dialect their `$schema`
 * names: JSON Schema 2020-12 (the default when `$schema` is absent, per MCP
 * 2026-07-28) or draft-07. A tool whose schema cannot be normalized (it does
 * not validate against its dialect, names an unsupported dialect, or
 * references a remote schema) is dropped from the returned list and reported
 * through `onDrop`; all other tools are kept. Returns `undefined` when no
 * tools remain.
 */
export function normalizeToolSchema(family: string, tools: OpenAiFunctionTool[] | undefined, onFix?: (tool: string, rule: string) => void, onDrop?: (tool: string, reason: string) => void): OpenAiFunctionTool[] | undefined {
	if (!tools?.length) {
		return undefined;
	}

	const output: OpenAiFunctionTool[] = [];
	for (const tool of tools) {
		try {
			const cloned = deepClone(tool);
			const didFix = (msg: string) => onFix?.(cloned.function.name, msg);
			for (const rule of fnRules) {
				rule(family, cloned.function, didFix);
			}

			if (cloned.function.parameters) {
				for (const rule of jsonSchemaRules) {
					rule(family, cloned.function.parameters, didFix);
				}
			}

			output.push(cloned);
		} catch (e) {
			onDrop?.(tool.function.name, e instanceof Error ? e.message : String(e));
		}
	}

	return output.length ? output : undefined;
}


const fnRules: ((family: string, node: OpenAiFunctionDef, didFix: (message: string) => void) => void)[] = [
	(_family, n, didFix) => {
		if (n.parameters === undefined) {
			return;
		}

		if (!n.parameters || (n.parameters as ObjectJsonSchema).type !== 'object') {
			n.parameters = { type: 'object', properties: {} } satisfies ObjectJsonSchema;
			didFix('schema must be an object if present');
		}

		const obj = n.parameters as ObjectJsonSchema;
		if (!obj.properties) {
			obj.properties = {};
			didFix('schema must have a properties object');
		}
	},
	(_family, n, didFix) => {
		if (!n.description) {
			n.description = 'No description provided';
			didFix('schema description may not be empty');
		}
	},
];

const enum JsonSchemaDialect {
	Draft07 = 'draft-07',
	Draft2020_12 = '2020-12',
}

const jsonSchema2020_12MetaSchemaId = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Returns the dialect named by the schema's `$schema`, or `undefined` when
 * there is none (in which case the caller defaults to 2020-12). Throws for
 * any dialect we cannot validate.
 */
function getDeclaredDialect(schema: JsonSchema): JsonSchemaDialect | undefined {
	const declared = (schema as { $schema?: unknown }).$schema;
	if (typeof declared !== 'string' || !declared) {
		return undefined;
	}

	// Accept http(s) and an optional trailing `#` on both dialect URIs.
	switch (declared.trim().replace(/^https?:\/\//, '').replace(/#$/, '')) {
		case 'json-schema.org/draft/2020-12/schema':
			return JsonSchemaDialect.Draft2020_12;
		case 'json-schema.org/draft-07/schema':
			return JsonSchemaDialect.Draft07;
		default:
			throw new Error(`unsupported JSON Schema dialect ${declared}`);
	}
}

const ajvOptions: AjvOptions = {
	coerceTypes: true,
	strictTypes: true,
	allowUnionTypes: true,
};

// Both validators get the same formats the draft-07 meta schema has always
// needed. Neither Ajv instance sets `loadSchema`: tool schemas are only ever
// validated as instances of a meta schema, never compiled, so no `$ref` they
// contain is ever resolved or fetched.
function addFormats<T extends Ajv>(ajv: T): T {
	ajv.addFormat('uri', (value) => URL.canParse(value));
	ajv.addFormat('regex', (value) => typeof value === 'string');
	return ajv;
}

const draft07Validator = new Lazy<ValidateFunction>(() => addFormats(new Ajv(ajvOptions)).compile(jsonSchemaDraft7));

const draft2020_12Validator = new Lazy<ValidateFunction>(() => {
	// Ajv2020 bundles the 2020-12 meta schema (and its vocabularies) and
	// registers it under its canonical `$id`, so no copy needs to ship here.
	const validate = addFormats(new Ajv2020(ajvOptions)).getSchema(jsonSchema2020_12MetaSchemaId);
	if (!validate) {
		throw new Error(`Ajv2020 did not register the ${jsonSchema2020_12MetaSchemaId} meta schema`);
	}
	return validate;
});

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
	return (errors ?? []).map(e => e.instancePath + ' ' + e.message).join('\n');
}


const jsonSchemaRules: ((family: string, node: JsonSchema, didFix: (message: string) => void) => void)[] = [
	(_family, schema, didFix) => {
		const declared = getDeclaredDialect(schema);
		if (declared === JsonSchemaDialect.Draft07) {
			if (!draft07Validator.value(schema)) {
				throw new Error('tool parameters do not match JSON schema (draft-07): ' + formatAjvErrors(draft07Validator.value.errors));
			}
			return;
		}

		if (draft2020_12Validator.value(schema)) {
			return;
		}
		const errors2020 = formatAjvErrors(draft2020_12Validator.value.errors);

		// A schema without `$schema` defaults to 2020-12, but servers written
		// before that was the default commonly use draft-07 constructs (tuple
		// `items`, say) without declaring a dialect. Keep those working.
		if (declared === undefined && draft07Validator.value(schema)) {
			didFix(`schema is not valid JSON Schema 2020-12 (${errors2020}) but is valid draft-07; treating it as draft-07`);
			return;
		}

		throw new Error('tool parameters do not match JSON schema (2020-12): ' + errors2020);
	},
	(_family, schema) => {
		// Meta schema validation only checks that a `$ref` is a string; it is
		// never resolved. Anything but a local pointer would need a network
		// fetch to mean anything to us or the model, so refuse it outright.
		forEachSchemaNode(schema, n => {
			for (const keyword of ['$ref', '$dynamicRef'] as const) {
				const ref = (n as SchemaRecord)[keyword];
				if (typeof ref === 'string' && !ref.startsWith('#')) {
					throw new Error(`tool parameters contain a remote ${keyword} '${ref}', which is not supported`);
				}
			}
		});
	},
	(_family, schema, didFix) => {
		forEachSchemaNode(schema, n => {
			if ('type' in n && n.type === 'array' && (n as ArrayJsonSchema).items === undefined) {
				(n as ArrayJsonSchema).items = {};
				didFix('array schema has no items; defaulting to any');
			}
		});
	},
	(family, schema, onFix) => {
		if (!isGpt4ish(family)) { return; }

		forEachSchemaNode(schema, n => {
			if ('description' in n && n.description && n.description.length > gpt4oMaxStringLength) {
				n.description = n.description.substring(0, gpt4oMaxStringLength);
				onFix(`object description is too long (truncated to ${gpt4oMaxStringLength} chars)`);
			}
		});
	},
	(family, schema, onFix) => {
		if (!isGpt4ish(family)) { return; }

		forEachSchemaNode(schema, n => {
			for (const key of Object.keys(n)) {
				if (gpt4oUnsupportedSchemaKeywords.has(key)) {
					delete (n as SchemaRecord)[key];
					onFix(`object has unsupported schema keyword '${key}'`);
				}
			}
		});
	},
	(_family, schema, onFix) => {
		// validated this fails both for claude and 4o
		const unsupported = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else'];
		for (const key of unsupported) {
			if (schema.hasOwnProperty(key)) {
				onFix(`object has unsupported top-level schema keyword '${key}'`);
				delete (schema as SchemaRecord)[key];
			}
		}
	},
	(_family, schema, onFix) => {
		forEachSchemaNode(schema, n => {
			if ((n as ObjectJsonSchema).type === 'object') {
				const obj = n as ObjectJsonSchema;
				if (obj.properties && typeof obj.properties === 'object' && obj.required && Array.isArray(obj.required)) {
					obj.required = obj.required.filter(key => {
						if (obj.properties![key] === undefined) {
							onFix(`object has required property '${key}' that is not defined`);
							return false;
						}
						return true;
					});
				}
			}
		});
	},

	(family, schema, onFix) => {
		if (!isDraft2020_12Schema(family)) {
			return;
		}
		forEachSchemaNode(schema, n => {
			if ((n as ArrayJsonSchema).type === 'array') {
				const obj = n as ArrayJsonSchema;
				if (obj.items && Array.isArray(obj.items)) {
					onFix(`array schema has items as an array, which is not supported in Draft 2020-12`);
					obj.items = { anyOf: obj.items } satisfies JsonSchema;
				}
			}
		});
	},
	(family, schema, onFix) => {
		// Gemini models require nullable types to use OpenAPI 3.0 nullable keyword instead of JSON Schema union types
		if (!isGeminiFamily(family) && !family.toLowerCase().includes('gemini')) {
			return;
		}
		forEachSchemaNode(schema, n => {
			const node = n as SchemaRecord;
			if (Array.isArray(node.type)) {
				const types = node.type as string[];
				const hasNull = types.includes('null');
				const nonNullTypes = types.filter(t => t !== 'null');

				if (hasNull && nonNullTypes.length === 1) {
					// Convert ["string", "null"] to { type: "string", nullable: true }
					node.type = nonNullTypes[0];
					node.nullable = true;
					onFix(`converted nullable type array to OpenAPI nullable keyword for Gemini compatibility`);
				} else if (hasNull && nonNullTypes.length > 1) {
					// For multiple non-null types with null, we can't easily convert, so we remove null.
					// This changes the schema semantics: the field is no longer nullable and values of `null`
					// will fail validation. This is a limitation, but better than a blank 400 error from the model.
					node.type = nonNullTypes;
					onFix(`removed null from multi-type union for Gemini compatibility; this makes the field non-nullable and may cause validation errors for callers that pass null`);
				}
			}
		});
	},
];

/** A schema node viewed as a plain record, for keywords `JsonSchema` does not model (2020-12 ones in particular). */
type SchemaRecord = { [keyword: string]: unknown };

/**
 * Calls `fn` on the schema and then on every sub-schema reachable through
 * draft-07 and 2020-12 applicator keywords (depth first; `fn` runs on a node
 * before its children are collected, so keywords `fn` deletes are not
 * traversed). Booleans and non-schema values (e.g. the string arrays
 * `dependencies` may hold) are skipped.
 */
function forEachSchemaNode(input: unknown, fn: (node: JsonSchema) => void): void {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return;
	}

	fn(input as JsonSchema);

	for (const child of getSubSchemas(input as SchemaRecord)) {
		forEachSchemaNode(child, fn);
	}
}

function getSubSchemas(schema: SchemaRecord): unknown[] {
	const children: unknown[] = [];
	// Keywords whose value maps names to schemas.
	for (const keyword of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']) {
		const map = schema[keyword];
		if (map && typeof map === 'object' && !Array.isArray(map)) {
			children.push(...Object.values(map));
		}
	}
	// Keywords whose value is a schema or (draft-07 `items`) a list of schemas.
	for (const keyword of ['items', 'prefixItems', 'anyOf', 'allOf', 'oneOf']) {
		const value = schema[keyword];
		if (Array.isArray(value)) {
			children.push(...value);
		} else if (value !== undefined) {
			children.push(value);
		}
	}
	// Keywords whose value is a single schema.
	for (const keyword of ['additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else']) {
		if (schema[keyword] !== undefined) {
			children.push(schema[keyword]);
		}
	}
	return children;
}

// Whether the model is a GPT-4 family model.
const isGpt4ish = (family: string) => family.startsWith('gpt-4');
// Whether the model is a model known to follow JSON Schema Draft 2020-12, (versus Draft 7).
const isDraft2020_12Schema = (family: string) => family.startsWith('gpt-4') || family.startsWith('claude-') || family.startsWith('o4');

const gpt4oMaxStringLength = 1024;

// Keywords in schema that gpt-4o does not support. From Toby at Github who wrote a normalizer
// https://gist.github.com/toby/dfe40041ae5b02d44ea21321b9f7dfd2
const gpt4oUnsupportedSchemaKeywords = new Set([
	'minLength',
	'maxLength',
	'pattern',
	'default',
	'format',
	'minimum',
	'maximum',
	'multipleOf',
	'patternProperties',
	'unevaluatedProperties',
	'propertyNames',
	'minProperties',
	'maxProperties',
	'unevaluatedItems',
	'contains',
	'minContains',
	'maxContains',
	'minItems',
	'maxItems',
	'uniqueItems'
]);
