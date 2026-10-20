/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../objects.js';
import { isHighSurrogate, isLowSurrogate } from '../strings.js';
import { checkFormat } from './formats.js';
import type { JsonSchemaDialect } from './index.js';

//#region Shared types

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Escapes a single JSON pointer reference token (RFC 6901). */
export function escapePointerToken(token: string): string {
	return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Unescapes a single JSON pointer reference token (RFC 6901). */
export function unescapePointerToken(token: string): string {
	return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** A schema document: the root schema or one of the supplied remote documents. */
export interface ISchemaDocument {
	/** Retrieval URI of the document (synthetic for the root schema without `$id`). */
	readonly uri: string;
	readonly raw: unknown;
	readonly dialect: JsonSchemaDialect;
	readonly isRoot: boolean;
}

/** A schema resource: a (sub)schema with its own base URI, established by `$id`. */
export interface ISchemaResource {
	readonly baseUri: string;
	readonly dialect: JsonSchemaDialect;
	readonly document: ISchemaDocument;
	readonly rootRaw: unknown;
	/** JSON pointer of the resource root within its document. */
	readonly rootPointer: string;
	readonly rootDepth: number;
	/** Plain-name fragments (`$anchor`, `$dynamicAnchor`, draft-07 `$id: '#name'`). */
	readonly anchors: Map<string, SchemaNode>;
	readonly dynamicAnchors: Map<string, SchemaNode>;
}

export interface IPatternProperty {
	readonly source: string;
	readonly regex: RegExp;
	readonly node: SchemaNode;
}

/**
 * A compiled schema object. Keyword values are pre-parsed so that evaluation
 * does not need to look at the raw schema again.
 */
export class SchemaNode {
	public readonly resource: ISchemaResource;
	/** JSON pointer of this schema within its document. */
	public readonly pointer: string;
	public readonly depth: number;

	/** Set for boolean schemas. */
	public bool: boolean | undefined;

	// Core
	public ref: SchemaNode | undefined;
	public dynamicRef: SchemaNode | undefined;
	/** Set when `$dynamicRef` is subject to dynamic scope resolution (its anchor name). */
	public dynamicRefAnchor: string | undefined;
	public dynamicAnchor: string | undefined;

	// Validation: any
	public types: readonly string[] | undefined;
	public enum: readonly unknown[] | undefined;
	public hasConst = false;
	public constValue: unknown;

	// Validation: numbers
	public minimum: number | undefined;
	public maximum: number | undefined;
	public exclusiveMinimum: number | undefined;
	public exclusiveMaximum: number | undefined;
	public multipleOf: number | undefined;

	// Validation: strings
	public minLength: number | undefined;
	public maxLength: number | undefined;
	public pattern: RegExp | undefined;
	public format: string | undefined;

	// Validation and applicators: objects
	public required: readonly string[] | undefined;
	public minProperties: number | undefined;
	public maxProperties: number | undefined;
	public dependentRequired: ReadonlyMap<string, readonly string[]> | undefined;
	public properties: ReadonlyMap<string, SchemaNode> | undefined;
	public patternProperties: readonly IPatternProperty[] | undefined;
	public additionalProperties: SchemaNode | undefined;
	public unevaluatedProperties: SchemaNode | undefined;
	public propertyNames: SchemaNode | undefined;
	public dependentSchemas: ReadonlyMap<string, SchemaNode> | undefined;

	// Validation and applicators: arrays
	public minItems: number | undefined;
	public maxItems: number | undefined;
	public uniqueItems = false;
	public minContains: number | undefined;
	public maxContains: number | undefined;
	/** `prefixItems` (2020-12) or tuple-form `items` (draft-07). */
	public tupleItems: readonly SchemaNode[] | undefined;
	/** `items` (2020-12) or `additionalItems` (draft-07): applies to items past the tuple. */
	public restItems: SchemaNode | undefined;
	public unevaluatedItems: SchemaNode | undefined;
	public contains: SchemaNode | undefined;

	// In-place applicators
	public allOf: readonly SchemaNode[] | undefined;
	public anyOf: readonly SchemaNode[] | undefined;
	public oneOf: readonly SchemaNode[] | undefined;
	public not: SchemaNode | undefined;
	public if: SchemaNode | undefined;
	public then: SchemaNode | undefined;
	public else: SchemaNode | undefined;

	constructor(resource: ISchemaResource, pointer: string, depth: number) {
		this.resource = resource;
		this.pointer = pointer;
		this.depth = depth;
	}

	/** Whether this schema needs to track which properties/items its applicators evaluated. */
	get needsAnnotations(): boolean {
		return this.unevaluatedProperties !== undefined || this.unevaluatedItems !== undefined;
	}
}

//#endregion

//#region Keyword parsing (compile time)

export interface IKeywordCompileContext {
	readonly dialect: JsonSchemaDialect;
	/** Compiles a subschema found at `pointerSuffix` (e.g. `/properties/foo`) below the current schema. */
	child(raw: unknown, pointerSuffix: string): SchemaNode;
	/** Compiles a guarded regular expression; reports a compile error and returns undefined if rejected. */
	pattern(source: string, pointerSuffix: string): RegExp | undefined;
	/** Registers a reference to be resolved once the whole document has been walked. */
	ref(node: SchemaNode, keyword: '$ref' | '$dynamicRef', value: string): void;
	/** Reports an `invalid-schema` error at `pointerSuffix` below the current schema. */
	invalid(pointerSuffix: string, message: string): void;
}

const SIMPLE_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);

function isSchemaLike(value: unknown): value is boolean | JsonObject {
	return typeof value === 'boolean' || isJsonObject(value);
}

/**
 * Reads the keywords of `raw` into `node`, compiling subschemas through `ctx`.
 * Unknown keywords are ignored; keywords of the other dialect are ignored as well.
 */
export function parseKeywords(raw: JsonObject, node: SchemaNode, ctx: IKeywordCompileContext): void {
	const is07 = ctx.dialect === 'draft-07';
	// In draft-07, all siblings of `$ref` are ignored. They are still compiled so that
	// identifiers inside them are registered, but their results are not attached.
	const refOnly = is07 && typeof raw.$ref === 'string';
	const target = refOnly ? new SchemaNode(node.resource, node.pointer, node.depth) : node;

	const get = (key: string): unknown => hasOwn(raw, key) ? raw[key] : undefined;
	const invalid = (key: string, message: string) => ctx.invalid('/' + escapePointerToken(key), message);
	const number = (key: string): number | undefined => {
		const value = get(key);
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== 'number') {
			invalid(key, `'${key}' must be a number`);
			return undefined;
		}
		return value;
	};
	const nonNegativeInteger = (key: string): number | undefined => {
		const value = number(key);
		if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
			invalid(key, `'${key}' must be a non-negative integer`);
			return undefined;
		}
		return value;
	};
	const stringArray = (key: string, value: unknown = get(key)): string[] | undefined => {
		if (value === undefined) {
			return undefined;
		}
		if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
			invalid(key, `'${key}' must be an array of strings`);
			return undefined;
		}
		return value;
	};
	const subschema = (key: string): SchemaNode | undefined => {
		const value = get(key);
		if (value === undefined) {
			return undefined;
		}
		if (!isSchemaLike(value)) {
			invalid(key, `'${key}' must be a schema`);
			return undefined;
		}
		return ctx.child(value, '/' + escapePointerToken(key));
	};
	const subschemaArray = (key: string): SchemaNode[] | undefined => {
		const value = get(key);
		if (value === undefined) {
			return undefined;
		}
		if (!Array.isArray(value) || value.some(item => !isSchemaLike(item))) {
			invalid(key, `'${key}' must be an array of schemas`);
			return undefined;
		}
		return value.map((item, index) => ctx.child(item, `/${escapePointerToken(key)}/${index}`));
	};
	const subschemaMap = (key: string): Map<string, SchemaNode> | undefined => {
		const value = get(key);
		if (value === undefined) {
			return undefined;
		}
		if (!isJsonObject(value)) {
			invalid(key, `'${key}' must be an object of schemas`);
			return undefined;
		}
		const result = new Map<string, SchemaNode>();
		for (const name of Object.keys(value)) {
			const item = value[name];
			if (!isSchemaLike(item)) {
				invalid(key, `'${key}/${name}' must be a schema`);
				continue;
			}
			result.set(name, ctx.child(item, `/${escapePointerToken(key)}/${escapePointerToken(name)}`));
		}
		return result;
	};

	// Core: references
	const ref = get('$ref');
	if (ref !== undefined) {
		if (typeof ref !== 'string') {
			invalid('$ref', `'$ref' must be a string`);
		} else {
			ctx.ref(node, '$ref', ref);
		}
	}
	if (!is07) {
		const dynamicRef = get('$dynamicRef');
		if (dynamicRef !== undefined) {
			if (typeof dynamicRef !== 'string') {
				invalid('$dynamicRef', `'$dynamicRef' must be a string`);
			} else {
				ctx.ref(target, '$dynamicRef', dynamicRef);
			}
		}
	}

	// Definitions are compiled so that identifiers inside them are registered.
	if (!is07) {
		subschemaMap('$defs');
	}
	subschemaMap('definitions');

	// Validation: any type
	const type = get('type');
	if (type !== undefined) {
		const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type : undefined;
		if (!types || types.some(t => typeof t !== 'string' || !SIMPLE_TYPES.has(t))) {
			invalid('type', `'type' must be a known type name or an array of type names`);
		} else {
			target.types = types;
		}
	}
	const enumValue = get('enum');
	if (enumValue !== undefined) {
		if (!Array.isArray(enumValue)) {
			invalid('enum', `'enum' must be an array`);
		} else {
			target.enum = enumValue;
		}
	}
	const constValue = get('const');
	if (constValue !== undefined) {
		target.hasConst = true;
		target.constValue = constValue;
	}

	// Validation: numbers
	target.minimum = number('minimum');
	target.maximum = number('maximum');
	const exclusiveMinimum = get('exclusiveMinimum');
	if (is07 && typeof exclusiveMinimum === 'boolean') {
		if (exclusiveMinimum) {
			target.exclusiveMinimum = target.minimum;
			target.minimum = undefined;
		}
	} else {
		target.exclusiveMinimum = number('exclusiveMinimum');
	}
	const exclusiveMaximum = get('exclusiveMaximum');
	if (is07 && typeof exclusiveMaximum === 'boolean') {
		if (exclusiveMaximum) {
			target.exclusiveMaximum = target.maximum;
			target.maximum = undefined;
		}
	} else {
		target.exclusiveMaximum = number('exclusiveMaximum');
	}
	const multipleOf = number('multipleOf');
	if (multipleOf !== undefined) {
		if (multipleOf <= 0) {
			invalid('multipleOf', `'multipleOf' must be greater than 0`);
		} else {
			target.multipleOf = multipleOf;
		}
	}

	// Validation: strings
	target.minLength = nonNegativeInteger('minLength');
	target.maxLength = nonNegativeInteger('maxLength');
	const pattern = get('pattern');
	if (pattern !== undefined) {
		if (typeof pattern !== 'string') {
			invalid('pattern', `'pattern' must be a string`);
		} else {
			target.pattern = ctx.pattern(pattern, '/pattern');
		}
	}
	const format = get('format');
	if (format !== undefined) {
		if (typeof format !== 'string') {
			invalid('format', `'format' must be a string`);
		} else {
			target.format = format;
		}
	}

	// Validation and applicators: objects
	target.required = stringArray('required');
	target.minProperties = nonNegativeInteger('minProperties');
	target.maxProperties = nonNegativeInteger('maxProperties');
	target.properties = subschemaMap('properties');
	const patternProperties = get('patternProperties');
	if (patternProperties !== undefined) {
		if (!isJsonObject(patternProperties)) {
			invalid('patternProperties', `'patternProperties' must be an object of schemas`);
		} else {
			const result: IPatternProperty[] = [];
			for (const source of Object.keys(patternProperties)) {
				const item = patternProperties[source];
				if (!isSchemaLike(item)) {
					invalid('patternProperties', `'patternProperties/${source}' must be a schema`);
					continue;
				}
				const regex = ctx.pattern(source, '/patternProperties/' + escapePointerToken(source));
				const child = ctx.child(item, '/patternProperties/' + escapePointerToken(source));
				if (regex) {
					result.push({ source, regex, node: child });
				}
			}
			target.patternProperties = result;
		}
	}
	target.additionalProperties = subschema('additionalProperties');
	target.propertyNames = subschema('propertyNames');
	if (is07) {
		const dependencies = get('dependencies');
		if (dependencies !== undefined) {
			if (!isJsonObject(dependencies)) {
				invalid('dependencies', `'dependencies' must be an object`);
			} else {
				const dependentRequired = new Map<string, readonly string[]>();
				const dependentSchemas = new Map<string, SchemaNode>();
				for (const name of Object.keys(dependencies)) {
					const item = dependencies[name];
					if (Array.isArray(item)) {
						const names = stringArray('dependencies', item);
						if (names) {
							dependentRequired.set(name, names);
						}
					} else if (isSchemaLike(item)) {
						dependentSchemas.set(name, ctx.child(item, '/dependencies/' + escapePointerToken(name)));
					} else {
						invalid('dependencies', `'dependencies/${name}' must be a schema or an array of strings`);
					}
				}
				target.dependentRequired = dependentRequired.size ? dependentRequired : undefined;
				target.dependentSchemas = dependentSchemas.size ? dependentSchemas : undefined;
			}
		}
	} else {
		const dependentRequired = get('dependentRequired');
		if (dependentRequired !== undefined) {
			if (!isJsonObject(dependentRequired)) {
				invalid('dependentRequired', `'dependentRequired' must be an object of string arrays`);
			} else {
				const result = new Map<string, readonly string[]>();
				for (const name of Object.keys(dependentRequired)) {
					const names = stringArray('dependentRequired', dependentRequired[name]);
					if (names) {
						result.set(name, names);
					}
				}
				target.dependentRequired = result;
			}
		}
		target.dependentSchemas = subschemaMap('dependentSchemas');
		target.unevaluatedProperties = subschema('unevaluatedProperties');
	}

	// Validation and applicators: arrays
	target.minItems = nonNegativeInteger('minItems');
	target.maxItems = nonNegativeInteger('maxItems');
	const uniqueItems = get('uniqueItems');
	if (uniqueItems !== undefined) {
		if (typeof uniqueItems !== 'boolean') {
			invalid('uniqueItems', `'uniqueItems' must be a boolean`);
		} else {
			target.uniqueItems = uniqueItems;
		}
	}
	target.contains = subschema('contains');
	if (is07) {
		const items = get('items');
		if (items !== undefined) {
			if (Array.isArray(items)) {
				target.tupleItems = subschemaArray('items');
				target.restItems = subschema('additionalItems');
			} else if (isSchemaLike(items)) {
				target.restItems = ctx.child(items, '/items');
			} else {
				invalid('items', `'items' must be a schema or an array of schemas`);
			}
		}
	} else {
		target.tupleItems = subschemaArray('prefixItems');
		target.restItems = subschema('items');
		target.minContains = nonNegativeInteger('minContains');
		target.maxContains = nonNegativeInteger('maxContains');
		target.unevaluatedItems = subschema('unevaluatedItems');
		// Only compiled so that identifiers inside are registered; content keywords are annotations.
		subschema('contentSchema');
	}

	// In-place applicators
	target.allOf = subschemaArray('allOf');
	target.anyOf = subschemaArray('anyOf');
	target.oneOf = subschemaArray('oneOf');
	target.not = subschema('not');
	target.if = subschema('if');
	target.then = subschema('then');
	target.else = subschema('else');
}

//#endregion

//#region Evaluation (validate time)

/** Properties and items of one instance location that successful applicators have evaluated. */
export class Annotations {
	public properties: Set<string> | undefined;
	public items: Set<number> | undefined;
	public allItems = false;

	addProperty(key: string): void {
		(this.properties ??= new Set()).add(key);
	}

	hasProperty(key: string): boolean {
		return this.properties?.has(key) ?? false;
	}

	addItem(index: number): void {
		(this.items ??= new Set()).add(index);
	}

	hasItem(index: number): boolean {
		return this.allItems || (this.items?.has(index) ?? false);
	}

	merge(other: Annotations): void {
		if (other.properties) {
			for (const key of other.properties) {
				this.addProperty(key);
			}
		}
		if (other.allItems) {
			this.allItems = true;
		} else if (other.items) {
			for (const index of other.items) {
				this.addItem(index);
			}
		}
	}
}

export interface IEvalContext {
	readonly assertFormats: boolean;
	/** Accounts for one keyword evaluation against the budget. */
	tick(): void;
	/** Evaluates `node` against the same instance location (in-place applicators). */
	evaluate(node: SchemaNode, instance: unknown, instancePath: string, out: Annotations | undefined): boolean;
	/** Evaluates `node` against a child instance location (properties, items, ...). */
	evaluateChild(node: SchemaNode, instance: unknown, instancePath: string): boolean;
	/** Follows a `$ref`/`$dynamicRef` to `target` for the same instance location. */
	followRef(target: SchemaNode, instance: unknown, instancePath: string, out: Annotations | undefined): boolean;
	/** Resolves a `$dynamicRef` that initially resolved to `initial` against the current dynamic scope. */
	resolveDynamicRef(initial: SchemaNode, anchor: string | undefined): SchemaNode;
	error(node: SchemaNode, keyword: string, instancePath: string, message: string): void;
	/** Starts a trial evaluation whose errors may be discarded; returns a mark for `endTrial`. */
	beginTrial(): number;
	endTrial(mark: number, keepErrors: boolean): void;
}

type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' | 'unknown';

function jsonTypeOf(value: unknown): JsonType {
	switch (typeof value) {
		case 'string': return 'string';
		case 'number': return 'number';
		case 'boolean': return 'boolean';
		case 'object':
			return value === null ? 'null' : Array.isArray(value) ? 'array' : 'object';
		default:
			return 'unknown';
	}
}

function matchesType(types: readonly string[], instance: unknown, kind: JsonType): boolean {
	for (const type of types) {
		if (type === kind) {
			return true;
		}
		if (type === 'integer' && kind === 'number' && Number.isInteger(instance)) {
			return true;
		}
	}
	return false;
}

/** Counts Unicode code points (not UTF-16 code units). */
function codePointLength(value: string): number {
	let count = 0;
	for (let i = 0; i < value.length; i++) {
		if (isHighSurrogate(value.charCodeAt(i)) && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
			i++;
		}
		count++;
	}
	return count;
}

function isMultipleOf(value: number, divisor: number): boolean {
	if (Number.isInteger(value) && Number.isInteger(divisor)) {
		return value % divisor === 0;
	}
	const quotient = value / divisor;
	if (!Number.isFinite(quotient)) {
		return false;
	}
	// Tolerate floating point error relative to the magnitude of the quotient.
	return Math.abs(quotient - Math.round(quotient)) <= 1e-9 * Math.max(1, Math.abs(quotient));
}

function childPath(instancePath: string, key: string | number): string {
	return typeof key === 'number' ? `${instancePath}/${key}` : `${instancePath}/${escapePointerToken(key)}`;
}

function hasDuplicateItems(items: readonly unknown[]): boolean {
	const primitives = new Set<string>();
	const composites: unknown[] = [];
	for (const item of items) {
		if (typeof item === 'object' && item !== null) {
			if (composites.some(other => equals(other, item))) {
				return true;
			}
			composites.push(item);
		} else {
			const key = `${typeof item}:${String(item)}`;
			if (primitives.has(key)) {
				return true;
			}
			primitives.add(key);
		}
	}
	return false;
}

/**
 * Evaluates all keywords of `node` against `instance`. Annotations of successful
 * applicators are recorded into `out` (when the caller is interested).
 */
export function evaluateKeywords(node: SchemaNode, instance: unknown, path: string, ctx: IEvalContext, out: Annotations | undefined): boolean {
	if (node.bool !== undefined) {
		ctx.tick();
		if (!node.bool) {
			ctx.error(node, 'false', path, 'is not allowed by a false schema');
		}
		return node.bool;
	}

	const local = node.needsAnnotations ? new Annotations() : out;
	const kind = jsonTypeOf(instance);
	let valid = true;

	if (node.types) {
		ctx.tick();
		if (!matchesType(node.types, instance, kind)) {
			ctx.error(node, 'type', path, `must be of type ${node.types.join(' or ')}`);
			valid = false;
		}
	}
	if (node.enum) {
		ctx.tick();
		if (!node.enum.some(candidate => equals(candidate, instance))) {
			ctx.error(node, 'enum', path, 'must be one of the allowed values');
			valid = false;
		}
	}
	if (node.hasConst) {
		ctx.tick();
		if (!equals(node.constValue, instance)) {
			ctx.error(node, 'const', path, 'must be equal to the constant value');
			valid = false;
		}
	}

	switch (kind) {
		case 'number':
			valid = evaluateNumber(node, instance as number, path, ctx) && valid;
			break;
		case 'string':
			valid = evaluateString(node, instance as string, path, ctx) && valid;
			break;
		case 'array':
			valid = evaluateArray(node, instance as unknown[], path, ctx, local) && valid;
			break;
		case 'object':
			valid = evaluateObject(node, instance as JsonObject, path, ctx, local) && valid;
			break;
	}

	// In-place applicators
	if (node.allOf) {
		ctx.tick();
		for (const sub of node.allOf) {
			if (!ctx.evaluate(sub, instance, path, local)) {
				valid = false;
			}
		}
	}
	if (node.anyOf) {
		ctx.tick();
		const mark = ctx.beginTrial();
		let anyValid = false;
		for (const sub of node.anyOf) {
			const branch = local ? new Annotations() : undefined;
			if (ctx.evaluate(sub, instance, path, branch)) {
				anyValid = true;
				if (branch) {
					local!.merge(branch);
				}
			}
		}
		ctx.endTrial(mark, !anyValid);
		if (!anyValid) {
			ctx.error(node, 'anyOf', path, 'must match at least one schema in anyOf');
			valid = false;
		}
	}
	if (node.oneOf) {
		ctx.tick();
		const mark = ctx.beginTrial();
		let matches = 0;
		let matched: Annotations | undefined;
		for (const sub of node.oneOf) {
			const branch = local ? new Annotations() : undefined;
			if (ctx.evaluate(sub, instance, path, branch)) {
				matches++;
				matched = branch;
			}
		}
		ctx.endTrial(mark, matches === 0);
		if (matches !== 1) {
			ctx.error(node, 'oneOf', path, matches === 0 ? 'must match exactly one schema in oneOf' : 'must match exactly one schema in oneOf but matched more than one');
			valid = false;
		} else if (matched) {
			local!.merge(matched);
		}
	}
	if (node.not) {
		ctx.tick();
		const mark = ctx.beginTrial();
		const inner = ctx.evaluate(node.not, instance, path, undefined);
		ctx.endTrial(mark, false);
		if (inner) {
			ctx.error(node, 'not', path, 'must not match the schema in not');
			valid = false;
		}
	}
	if (node.if) {
		ctx.tick();
		const mark = ctx.beginTrial();
		const branch = local ? new Annotations() : undefined;
		const condition = ctx.evaluate(node.if, instance, path, branch);
		ctx.endTrial(mark, false);
		if (condition) {
			if (branch) {
				local!.merge(branch);
			}
			if (node.then && !ctx.evaluate(node.then, instance, path, local)) {
				valid = false;
			}
		} else if (node.else && !ctx.evaluate(node.else, instance, path, local)) {
			valid = false;
		}
	}
	if (node.dependentSchemas && kind === 'object') {
		ctx.tick();
		for (const [key, sub] of node.dependentSchemas) {
			if (hasOwn(instance as object, key) && !ctx.evaluate(sub, instance, path, local)) {
				valid = false;
			}
		}
	}
	if (node.ref) {
		ctx.tick();
		if (!ctx.followRef(node.ref, instance, path, local)) {
			valid = false;
		}
	}
	if (node.dynamicRef) {
		ctx.tick();
		if (!ctx.followRef(ctx.resolveDynamicRef(node.dynamicRef, node.dynamicRefAnchor), instance, path, local)) {
			valid = false;
		}
	}

	// Unevaluated locations: must run after every other keyword, including references.
	if (node.unevaluatedProperties && kind === 'object' && local) {
		ctx.tick();
		const object = instance as JsonObject;
		for (const key of Object.keys(object)) {
			if (!local.hasProperty(key)) {
				if (!ctx.evaluateChild(node.unevaluatedProperties, object[key], childPath(path, key))) {
					ctx.error(node, 'unevaluatedProperties', path, `must not have unevaluated property '${key}'`);
					valid = false;
				}
				local.addProperty(key);
			}
		}
	}
	if (node.unevaluatedItems && kind === 'array' && local) {
		ctx.tick();
		const array = instance as unknown[];
		for (let i = 0; i < array.length; i++) {
			if (!local.hasItem(i)) {
				if (!ctx.evaluateChild(node.unevaluatedItems, array[i], childPath(path, i))) {
					ctx.error(node, 'unevaluatedItems', path, `must not have unevaluated item at index ${i}`);
					valid = false;
				}
			}
		}
		local.allItems = true;
	}

	if (valid && out && local !== out) {
		out.merge(local!);
	}
	return valid;
}

function evaluateNumber(node: SchemaNode, value: number, path: string, ctx: IEvalContext): boolean {
	let valid = true;
	if (node.minimum !== undefined) {
		ctx.tick();
		if (value < node.minimum) {
			ctx.error(node, 'minimum', path, `must be >= ${node.minimum}`);
			valid = false;
		}
	}
	if (node.maximum !== undefined) {
		ctx.tick();
		if (value > node.maximum) {
			ctx.error(node, 'maximum', path, `must be <= ${node.maximum}`);
			valid = false;
		}
	}
	if (node.exclusiveMinimum !== undefined) {
		ctx.tick();
		if (value <= node.exclusiveMinimum) {
			ctx.error(node, 'exclusiveMinimum', path, `must be > ${node.exclusiveMinimum}`);
			valid = false;
		}
	}
	if (node.exclusiveMaximum !== undefined) {
		ctx.tick();
		if (value >= node.exclusiveMaximum) {
			ctx.error(node, 'exclusiveMaximum', path, `must be < ${node.exclusiveMaximum}`);
			valid = false;
		}
	}
	if (node.multipleOf !== undefined) {
		ctx.tick();
		if (!isMultipleOf(value, node.multipleOf)) {
			ctx.error(node, 'multipleOf', path, `must be a multiple of ${node.multipleOf}`);
			valid = false;
		}
	}
	return valid;
}

function evaluateString(node: SchemaNode, value: string, path: string, ctx: IEvalContext): boolean {
	let valid = true;
	if (node.minLength !== undefined || node.maxLength !== undefined) {
		ctx.tick();
		const length = codePointLength(value);
		if (node.minLength !== undefined && length < node.minLength) {
			ctx.error(node, 'minLength', path, `must be at least ${node.minLength} characters long`);
			valid = false;
		}
		if (node.maxLength !== undefined && length > node.maxLength) {
			ctx.error(node, 'maxLength', path, `must be at most ${node.maxLength} characters long`);
			valid = false;
		}
	}
	if (node.pattern) {
		ctx.tick();
		if (!node.pattern.test(value)) {
			ctx.error(node, 'pattern', path, `must match pattern '${node.pattern.source}'`);
			valid = false;
		}
	}
	if (node.format !== undefined && ctx.assertFormats) {
		ctx.tick();
		if (!checkFormat(node.format, value)) {
			ctx.error(node, 'format', path, `must be a valid '${node.format}'`);
			valid = false;
		}
	}
	return valid;
}

function evaluateArray(node: SchemaNode, array: readonly unknown[], path: string, ctx: IEvalContext, local: Annotations | undefined): boolean {
	let valid = true;
	if (node.minItems !== undefined) {
		ctx.tick();
		if (array.length < node.minItems) {
			ctx.error(node, 'minItems', path, `must have at least ${node.minItems} items`);
			valid = false;
		}
	}
	if (node.maxItems !== undefined) {
		ctx.tick();
		if (array.length > node.maxItems) {
			ctx.error(node, 'maxItems', path, `must have at most ${node.maxItems} items`);
			valid = false;
		}
	}
	if (node.uniqueItems) {
		ctx.tick();
		if (hasDuplicateItems(array)) {
			ctx.error(node, 'uniqueItems', path, 'must not have duplicate items');
			valid = false;
		}
	}
	let tupleLength = 0;
	if (node.tupleItems) {
		ctx.tick();
		tupleLength = node.tupleItems.length;
		const count = Math.min(array.length, tupleLength);
		for (let i = 0; i < count; i++) {
			if (!ctx.evaluateChild(node.tupleItems[i], array[i], childPath(path, i))) {
				valid = false;
			}
			local?.addItem(i);
		}
	}
	if (node.restItems) {
		ctx.tick();
		for (let i = tupleLength; i < array.length; i++) {
			if (!ctx.evaluateChild(node.restItems, array[i], childPath(path, i))) {
				valid = false;
			}
		}
		if (local) {
			local.allItems = true;
		}
	}
	if (node.contains) {
		ctx.tick();
		let count = 0;
		for (let i = 0; i < array.length; i++) {
			const mark = ctx.beginTrial();
			const matched = ctx.evaluateChild(node.contains, array[i], childPath(path, i));
			ctx.endTrial(mark, false);
			if (matched) {
				count++;
				local?.addItem(i);
			}
		}
		const minContains = node.minContains ?? 1;
		if (count < minContains) {
			ctx.error(node, 'contains', path, minContains === 1 ? 'must contain at least one item matching the contains schema' : `must contain at least ${minContains} items matching the contains schema`);
			valid = false;
		}
		if (node.maxContains !== undefined && count > node.maxContains) {
			ctx.error(node, 'maxContains', path, `must contain at most ${node.maxContains} items matching the contains schema`);
			valid = false;
		}
	}
	return valid;
}

function evaluateObject(node: SchemaNode, object: JsonObject, path: string, ctx: IEvalContext, local: Annotations | undefined): boolean {
	let valid = true;
	const keys = Object.keys(object);
	if (node.required) {
		ctx.tick();
		for (const key of node.required) {
			if (!hasOwn(object, key)) {
				ctx.error(node, 'required', path, `must have required property '${key}'`);
				valid = false;
			}
		}
	}
	if (node.minProperties !== undefined) {
		ctx.tick();
		if (keys.length < node.minProperties) {
			ctx.error(node, 'minProperties', path, `must have at least ${node.minProperties} properties`);
			valid = false;
		}
	}
	if (node.maxProperties !== undefined) {
		ctx.tick();
		if (keys.length > node.maxProperties) {
			ctx.error(node, 'maxProperties', path, `must have at most ${node.maxProperties} properties`);
			valid = false;
		}
	}
	if (node.dependentRequired) {
		ctx.tick();
		for (const [key, dependencies] of node.dependentRequired) {
			if (hasOwn(object, key)) {
				for (const dependency of dependencies) {
					if (!hasOwn(object, dependency)) {
						ctx.error(node, 'dependentRequired', path, `must have property '${dependency}' when property '${key}' is present`);
						valid = false;
					}
				}
			}
		}
	}
	if (node.properties || node.patternProperties || node.additionalProperties) {
		ctx.tick();
		for (const key of keys) {
			let evaluated = false;
			const property = node.properties?.get(key);
			if (property) {
				if (!ctx.evaluateChild(property, object[key], childPath(path, key))) {
					valid = false;
				}
				evaluated = true;
			}
			if (node.patternProperties) {
				for (const patternProperty of node.patternProperties) {
					if (patternProperty.regex.test(key)) {
						if (!ctx.evaluateChild(patternProperty.node, object[key], childPath(path, key))) {
							valid = false;
						}
						evaluated = true;
					}
				}
			}
			if (!evaluated && node.additionalProperties) {
				if (!ctx.evaluateChild(node.additionalProperties, object[key], childPath(path, key))) {
					ctx.error(node, 'additionalProperties', path, `must not have additional property '${key}'`);
					valid = false;
				}
				evaluated = true;
			}
			if (evaluated) {
				local?.addProperty(key);
			}
		}
	}
	if (node.propertyNames) {
		ctx.tick();
		for (const key of keys) {
			if (!ctx.evaluateChild(node.propertyNames, key, path)) {
				ctx.error(node, 'propertyNames', path, `property name '${key}' is invalid`);
				valid = false;
			}
		}
	}
	return valid;
}

//#endregion
