/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { compileSchemaTree, DEFAULT_EVAL_BUDGET, DEFAULT_MAX_REF_HOPS, DEFAULT_MAX_SUBSCHEMAS, detectDialect, dialectOfSchemaUri, getMetaschemaDocument, PatternAnalysisBudget } from './compile.js';
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
	/**
	 * How a `$schema` naming a dialect other than 2020-12 or draft-07 is treated:
	 * `'error'` (the default) fails compilation with `unsupported-dialect`;
	 * `'warn'` validates the schema in {@link dialect} and reports an
	 * `unsupported-dialect` warning.
	 */
	unsupportedDialect?: 'error' | 'warn';
	/**
	 * How problems confined to the documents the validator has (the schema,
	 * a supplied remote document, a built-in metaschema) are treated: a
	 * `$ref` or `$dynamicRef` to a location such a document does not have (an
	 * unknown anchor, a JSON pointer that leads nowhere), a `$id` with a
	 * non-empty fragment, and a `$anchor` or `$dynamicAnchor` that is not a
	 * plain name. `'error'` (the default) fails compilation; `'warn'` reports
	 * each as a warning and validates what can be validated: such a reference
	 * asserts nothing, a plain-name `$id` fragment names its schema (as in
	 * draft-07) and any other one is ignored, and such an anchor is ignored. A
	 * reference to a document the validator does not have stays a
	 * `remote-ref` error.
	 */
	localReferenceProblems?: 'error' | 'warn';
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
	/**
	 * Maximum work of the backtracking analysis of the `pattern` and
	 * `patternProperties` regular expressions of one compilation (a repeated
	 * pattern is analyzed once), in steps of about 10 to 50 ns; a pattern
	 * beyond it is not asserted (an `invalid-pattern` warning). Defaults to
	 * 2000000. Ignored with {@link sharedPatternAnalysisBudget}.
	 */
	patternAnalysisBudget?: number;
	/**
	 * A budget for the backtracking analysis of the patterns that this
	 * compilation shares with others (see {@link PatternAnalysisBudget}), in
	 * place of its own {@link patternAnalysisBudget}: compiling many schemas
	 * with distinct patterns (the tools a server lists) then takes no more
	 * analysis time than one schema may. A pattern beyond what is left of it
	 * is not asserted (an `invalid-pattern` warning).
	 */
	sharedPatternAnalysisBudget?: PatternAnalysisBudget;
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
	/**
	 * Problems that did not prevent compilation: a `pattern` or
	 * `patternProperties` key that cannot be compiled or is rejected by the
	 * backtracking guard (`invalid-pattern`; that keyword asserts nothing), or
	 * whose bound on the backtracking steps of one test grows faster than
	 * linearly with the input (or by many steps per character), so that only
	 * strings up to the length named in the warning are tested (also
	 * `invalid-pattern`; nothing is asserted about longer ones), or that
	 * would take the analysis of the patterns beyond its budget (also
	 * `invalid-pattern`, see
	 * {@link IJsonSchemaCompileOptions.patternAnalysisBudget} and
	 * {@link IJsonSchemaCompileOptions.sharedPatternAnalysisBudget}), a
	 * tolerated unsupported `$schema` (`unsupported-dialect`), or a tolerated
	 * local reference problem (`unresolved-ref`, `invalid-schema`; see
	 * {@link IJsonSchemaCompileOptions.localReferenceProblems}).
	 */
	readonly warnings: readonly IJsonSchemaCompileError[];
	/** @throws {JsonSchemaBudgetExceededError} when the evaluation or time budget is exceeded. */
	validate(instance: unknown): IJsonSchemaValidationResult;
}

export { JsonSchemaBudgetExceededError, PatternAnalysisBudget };

/** The supported dialect a `$schema` URI names, if any. */
export { dialectOfSchemaUri };

class CompiledJsonSchema implements ICompiledJsonSchema {
	public readonly dialect: JsonSchemaDialect;
	public readonly warnings: readonly IJsonSchemaCompileError[];
	private readonly root: SchemaNode;
	private readonly options: IValidateInstanceOptions;

	constructor(root: SchemaNode, dialect: JsonSchemaDialect, warnings: readonly IJsonSchemaCompileError[], options: IJsonSchemaCompileOptions) {
		this.root = root;
		this.dialect = dialect;
		this.warnings = warnings;
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
	return new CompiledJsonSchema(result.tree.root, result.tree.dialect, result.warnings, options);
}

export function isCompiledJsonSchema(result: ICompiledJsonSchema | IJsonSchemaCompileError[]): result is ICompiledJsonSchema {
	return !Array.isArray(result);
}

const metaschemaValidators = new Map<string, ICompiledJsonSchema>();

/** @param tolerateLocalReferenceProblems Leave `$id` fragments and the form of anchors to the compiler (see {@link IJsonSchemaCompileOptions.localReferenceProblems}). */
function getMetaschemaValidator(dialect: JsonSchemaDialect, tolerateLocalReferenceProblems: boolean): ICompiledJsonSchema {
	const key = `${dialect}${tolerateLocalReferenceProblems ? '/lenient' : ''}`;
	let validator = metaschemaValidators.get(key);
	if (!validator) {
		// Validating a document costs a few dozen evaluations per subschema.
		const compiled = compileJsonSchema(getMetaschemaDocument(dialect, tolerateLocalReferenceProblems), { evalBudget: DEFAULT_MAX_SUBSCHEMAS * 512 });
		if (!isCompiledJsonSchema(compiled)) {
			throw new Error(`The embedded ${dialect} metaschema does not compile: ${compiled.map(error => error.message).join('; ')}`);
		}
		validator = compiled;
		metaschemaValidators.set(key, validator);
	}
	return validator;
}

export interface IJsonSchemaDocumentCheck {
	/** Why the document cannot be used; empty when it can. */
	readonly errors: IJsonSchemaCompileError[];
	/** Problems that do not prevent its use (see {@link ICompiledJsonSchema.warnings}). */
	readonly warnings: IJsonSchemaCompileError[];
}

/** Validates a schema document itself against the (embedded, trimmed) 2020-12 or draft-07 metaschema and the compile rules. */
export function validateJsonSchemaDocument(schema: unknown, options: IJsonSchemaCompileOptions = {}): IJsonSchemaCompileError[] {
	return checkJsonSchemaDocument(schema, options).errors;
}

/** {@link validateJsonSchemaDocument}, also returning the warnings of a document that can be used. */
export function checkJsonSchemaDocument(schema: unknown, options: IJsonSchemaCompileOptions = {}): IJsonSchemaDocumentCheck {
	const detection = detectDialect(schema, options);
	if (!detection.dialect) {
		return { errors: [detection.error!], warnings: [] };
	}
	const errors: IJsonSchemaCompileError[] = [];
	try {
		for (const error of getMetaschemaValidator(detection.dialect, options.localReferenceProblems === 'warn').validate(schema).errors) {
			errors.push({ code: 'invalid-schema', path: error.instancePath, message: `${error.message} (${error.keyword})` });
		}
	} catch (error) {
		if (!(error instanceof JsonSchemaBudgetExceededError)) {
			throw error;
		}
		errors.push({ code: 'too-many-subschemas', path: '', message: 'Schema is too large to be validated against the metaschema' });
	}
	const compiled = compileSchemaTree(schema, options);
	for (const error of compiled.errors) {
		if (!errors.some(existing => existing.code === error.code && existing.path === error.path)) {
			errors.push(error);
		}
	}
	return { errors, warnings: compiled.warnings };
}
