/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { compileSchemaTree, DEFAULT_EVAL_BUDGET, DEFAULT_MAX_REF_HOPS, DEFAULT_MAX_SUBSCHEMAS, detectDialect, getMetaschemaDocument } from './compile.js';
import type { SchemaNode } from './keywords.js';
import { IValidateInstanceOptions, JsonSchemaBudgetExceededError, validateInstance } from './validate.js';

/**
 * A dependency-free JSON Schema validator supporting the 2020-12 (default) and
 * draft-07 dialects. It never fetches anything: a `$ref` to a document that is
 * not supplied through `remoteDocuments` is a compile error.
 */

export type JsonSchemaDialect = '2020-12' | 'draft-07';

export interface IJsonSchemaCompileOptions {
	/** Dialect used when the schema has no `$schema`. Defaults to `2020-12`. */
	dialect?: JsonSchemaDialect;
	/** Maximum nesting depth of subschemas. Defaults to 32. */
	maxDepth?: number;
	/** Maximum number of subschemas (including referenced remote documents). Defaults to 4096. */
	maxSubschemas?: number;
	/** Maximum number of consecutive `$ref` hops. Defaults to 64. */
	maxRefHops?: number;
	/** Maximum number of keyword evaluations per `validate` call. Defaults to 100000. */
	evalBudget?: number;
	/** Maximum length of a `pattern` or `patternProperties` regular expression. Defaults to 4096. */
	maxPatternLength?: number;
	/** Wall-clock budget per `validate` call. Unlimited by default. */
	timeBudgetMs?: number;
	/** Whether `format` is asserted; by default it is an annotation only. */
	assertFormats?: boolean;
	/** In-memory documents that `$ref` may resolve to, keyed by absolute URI. */
	remoteDocuments?: ReadonlyMap<string, unknown>;
}

export type JsonSchemaCompileErrorCode = 'remote-ref' | 'unsupported-dialect' | 'invalid-schema' | 'too-deep' | 'too-many-subschemas' | 'invalid-pattern' | 'unresolved-ref';

export interface IJsonSchemaCompileError {
	readonly code: JsonSchemaCompileErrorCode;
	/** JSON pointer into the schema. */
	readonly path: string;
	readonly message: string;
}

export interface IJsonSchemaValidationError {
	readonly instancePath: string;
	readonly schemaPath: string;
	readonly keyword: string;
	readonly message: string;
}

export interface IJsonSchemaValidationResult {
	readonly valid: boolean;
	readonly errors: readonly IJsonSchemaValidationError[];
}

export interface ICompiledJsonSchema {
	readonly dialect: JsonSchemaDialect;
	/** @throws {JsonSchemaBudgetExceededError} when the evaluation or time budget is exceeded. */
	validate(instance: unknown): IJsonSchemaValidationResult;
}

export { JsonSchemaBudgetExceededError };

class CompiledJsonSchema implements ICompiledJsonSchema {
	public readonly dialect: JsonSchemaDialect;
	private readonly root: SchemaNode;
	private readonly options: IValidateInstanceOptions;

	constructor(root: SchemaNode, dialect: JsonSchemaDialect, options: IJsonSchemaCompileOptions) {
		this.root = root;
		this.dialect = dialect;
		this.options = {
			evalBudget: options.evalBudget ?? DEFAULT_EVAL_BUDGET,
			timeBudgetMs: options.timeBudgetMs,
			maxRefHops: options.maxRefHops ?? DEFAULT_MAX_REF_HOPS,
			assertFormats: options.assertFormats ?? false,
		};
	}

	validate(instance: unknown): IJsonSchemaValidationResult {
		return validateInstance(this.root, instance, this.options);
	}
}

export function compileJsonSchema(schema: unknown, options: IJsonSchemaCompileOptions = {}): ICompiledJsonSchema | IJsonSchemaCompileError[] {
	const result = compileSchemaTree(schema, options);
	if (!result.tree) {
		return result.errors;
	}
	return new CompiledJsonSchema(result.tree.root, result.tree.dialect, options);
}

export function isCompiledJsonSchema(result: ICompiledJsonSchema | IJsonSchemaCompileError[]): result is ICompiledJsonSchema {
	return !Array.isArray(result);
}

const metaschemaValidators = new Map<JsonSchemaDialect, ICompiledJsonSchema>();

function getMetaschemaValidator(dialect: JsonSchemaDialect): ICompiledJsonSchema {
	let validator = metaschemaValidators.get(dialect);
	if (!validator) {
		// Validating a document costs a few dozen evaluations per subschema.
		const compiled = compileJsonSchema(getMetaschemaDocument(dialect), { evalBudget: DEFAULT_MAX_SUBSCHEMAS * 512 });
		if (!isCompiledJsonSchema(compiled)) {
			throw new Error(`The embedded ${dialect} metaschema does not compile: ${compiled.map(error => error.message).join('; ')}`);
		}
		validator = compiled;
		metaschemaValidators.set(dialect, validator);
	}
	return validator;
}

/** Validates a schema document itself against the (embedded, trimmed) 2020-12 or draft-07 metaschema and the compile rules. */
export function validateJsonSchemaDocument(schema: unknown, options: IJsonSchemaCompileOptions = {}): IJsonSchemaCompileError[] {
	const detection = detectDialect(schema, options);
	if (!detection.dialect) {
		return [detection.error!];
	}
	const errors: IJsonSchemaCompileError[] = [];
	try {
		for (const error of getMetaschemaValidator(detection.dialect).validate(schema).errors) {
			errors.push({ code: 'invalid-schema', path: error.instancePath, message: `${error.message} (${error.keyword})` });
		}
	} catch (error) {
		if (!(error instanceof JsonSchemaBudgetExceededError)) {
			throw error;
		}
		errors.push({ code: 'too-many-subschemas', path: '', message: 'Schema is too large to be validated against the metaschema' });
	}
	for (const error of compileSchemaTree(schema, options).errors) {
		if (!errors.some(existing => existing.code === error.code && existing.path === error.path)) {
			errors.push(error);
		}
	}
	return errors;
}
