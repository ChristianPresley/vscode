/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IJsonSchemaCompileError, IJsonSchemaCompileOptions, JsonSchemaCompileErrorCode, JsonSchemaDialect } from './index.js';
import { escapePointerToken, hasOwn, IKeywordCompileContext, isJsonObject, ISchemaDocument, ISchemaResource, JsonObject, parseKeywords, SchemaNode, unescapePointerToken } from './keywords.js';

export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_SUBSCHEMAS = 4096;
export const DEFAULT_MAX_REF_HOPS = 64;
export const DEFAULT_MAX_PATTERN_LENGTH = 4096;
export const DEFAULT_EVAL_BUDGET = 100_000;

/** Synthetic retrieval URI of the root schema; only used to resolve relative references. */
const ROOT_DOCUMENT_URI = 'vscode-json-schema:///root';
const DIALECT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';
const DIALECT_DRAFT_07_URI = 'http://json-schema.org/draft-07/schema';
const ANCHOR_PATTERN = /^[A-Za-z_][-A-Za-z0-9._]*$/;

//#region Dialects

export function dialectOfSchemaUri(uri: string): JsonSchemaDialect | undefined {
	switch (uri.replace(/#$/, '')) {
		case DIALECT_2020_12_URI:
			return '2020-12';
		case DIALECT_DRAFT_07_URI:
		case 'https://json-schema.org/draft-07/schema':
			return 'draft-07';
		default:
			return undefined;
	}
}

export interface IDialectDetection {
	readonly dialect?: JsonSchemaDialect;
	readonly error?: IJsonSchemaCompileError;
}

/** Determines the dialect of a schema document from `$schema`, falling back to the configured default. */
export function detectDialect(schema: unknown, options: IJsonSchemaCompileOptions | undefined, pathPrefix = ''): IDialectDetection {
	if (isJsonObject(schema) && schema.$schema !== undefined) {
		const value = schema.$schema;
		const dialect = typeof value === 'string' ? dialectOfSchemaUri(value) : undefined;
		if (!dialect) {
			return { error: { code: 'unsupported-dialect', path: pathPrefix + '/$schema', message: `Unsupported JSON Schema dialect '${String(value)}'; supported are '${DIALECT_2020_12_URI}' and '${DIALECT_DRAFT_07_URI}#'` } };
		}
		return { dialect };
	}
	return { dialect: options?.dialect ?? '2020-12' };
}

//#endregion

//#region URI helpers

function splitFragment(reference: string): [string, string | undefined] {
	const index = reference.indexOf('#');
	return index < 0 ? [reference, undefined] : [reference.slice(0, index), reference.slice(index + 1)];
}

function decodeFragment(fragment: string | undefined): string | undefined {
	if (!fragment) {
		return '';
	}
	try {
		return decodeURIComponent(fragment);
	} catch {
		return undefined;
	}
}

/** Resolves a URI reference (without fragment) against an absolute base URI; returns a normalized absolute URI. */
function resolveUri(reference: string, base: string): string | undefined {
	if (reference === '') {
		return base;
	}
	try {
		const url = new URL(reference, base);
		url.hash = '';
		return url.href.replace(/#$/, '');
	} catch {
		return undefined;
	}
}

function normalizeUri(uri: string): string {
	const [withoutFragment] = splitFragment(uri);
	try {
		const url = new URL(withoutFragment);
		url.hash = '';
		return url.href.replace(/#$/, '');
	} catch {
		return withoutFragment;
	}
}

//#endregion

//#region Regular expression guard

/**
 * Scans an ECMAScript pattern for constructs that are rejected regardless of
 * whether `RegExp` accepts them: back-references, lookbehind assertions and
 * nested unbounded quantifiers (e.g. `(a+)+`), which can cause catastrophic backtracking.
 */
export function findUnsafeRegexConstruct(source: string): string | undefined {
	const frames: { unbounded: boolean }[] = [{ unbounded: false }];
	let lastClosedGroup: { unbounded: boolean } | undefined;
	let inClass = false;
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (inClass) {
			if (ch === '\\') {
				i += 2;
			} else {
				if (ch === ']') {
					inClass = false;
				}
				i++;
			}
			continue;
		}
		if (ch === '\\') {
			const next = source[i + 1];
			if (next >= '1' && next <= '9') {
				return 'back-references are not supported';
			}
			if (next === 'k') {
				return 'named back-references are not supported';
			}
			i += 2;
			lastClosedGroup = undefined;
			continue;
		}
		if (ch === '[') {
			inClass = true;
			i++;
			lastClosedGroup = undefined;
			continue;
		}
		if (ch === '(') {
			if (source.startsWith('(?<=', i) || source.startsWith('(?<!', i)) {
				return 'lookbehind assertions are not supported';
			}
			frames.push({ unbounded: false });
			i++;
			lastClosedGroup = undefined;
			continue;
		}
		if (ch === ')') {
			if (frames.length === 1) {
				return undefined; // unbalanced; RegExp reports the syntax error
			}
			const closed = frames.pop()!;
			if (closed.unbounded) {
				frames[frames.length - 1].unbounded = true;
			}
			lastClosedGroup = closed;
			i++;
			continue;
		}
		let quantifier = false;
		let unbounded = false;
		if (ch === '*' || ch === '+') {
			quantifier = true;
			unbounded = true;
			i++;
		} else if (ch === '?') {
			quantifier = true;
			i++;
		} else if (ch === '{') {
			const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i));
			if (match) {
				quantifier = true;
				unbounded = match[2] !== undefined && match[3] === '';
				i += match[0].length;
			} else {
				i++;
			}
		} else {
			i++;
		}
		if (quantifier) {
			if (source[i] === '?') {
				i++; // lazy modifier
			}
			if (unbounded) {
				if (lastClosedGroup?.unbounded) {
					return 'nested unbounded quantifiers are not supported';
				}
				frames[frames.length - 1].unbounded = true;
			}
		}
		lastClosedGroup = undefined;
	}
	return undefined;
}

//#endregion

//#region Compilation

export interface ICompiledSchemaTree {
	readonly root: SchemaNode;
	readonly dialect: JsonSchemaDialect;
}

export interface ICompileResult {
	readonly tree: ICompiledSchemaTree | undefined;
	readonly errors: IJsonSchemaCompileError[];
}

export function compileSchemaTree(schema: unknown, options: IJsonSchemaCompileOptions = {}): ICompileResult {
	const detection = detectDialect(schema, options);
	if (!detection.dialect) {
		return { tree: undefined, errors: [detection.error!] };
	}
	if (!isJsonObject(schema) && typeof schema !== 'boolean') {
		return { tree: undefined, errors: [{ code: 'invalid-schema', path: '', message: 'A schema must be an object or a boolean' }] };
	}
	const ctx = new CompileContext(options);
	const root = ctx.compileDocument(schema, ROOT_DOCUMENT_URI, detection.dialect, true);
	ctx.resolveReferences();
	ctx.checkReferenceChains();
	if (ctx.errors.length) {
		return { tree: undefined, errors: ctx.errors };
	}
	return { tree: { root, dialect: detection.dialect }, errors: [] };
}

interface IPendingReference {
	readonly node: SchemaNode;
	readonly keyword: '$ref' | '$dynamicRef';
	readonly value: string;
}

class CompileContext {
	public readonly errors: IJsonSchemaCompileError[] = [];

	private readonly maxDepth: number;
	private readonly maxSubschemas: number;
	private readonly maxRefHops: number;
	private readonly maxPatternLength: number;
	private readonly remoteDocuments = new Map<string, unknown>();
	private readonly nodes = new Map<object, SchemaNode>();
	private readonly resources = new Map<string, ISchemaResource>();
	private readonly pendingReferences: IPendingReference[] = [];
	private nodeCount = 0;
	private tooDeepReported = false;
	private tooManyReported = false;

	constructor(options: IJsonSchemaCompileOptions) {
		this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
		this.maxSubschemas = options.maxSubschemas ?? DEFAULT_MAX_SUBSCHEMAS;
		this.maxRefHops = options.maxRefHops ?? DEFAULT_MAX_REF_HOPS;
		this.maxPatternLength = options.maxPatternLength ?? DEFAULT_MAX_PATTERN_LENGTH;
		if (options.remoteDocuments) {
			for (const [uri, raw] of options.remoteDocuments) {
				this.remoteDocuments.set(normalizeUri(uri), raw);
			}
		}
	}

	private error(code: JsonSchemaCompileErrorCode, path: string, message: string): void {
		this.errors.push({ code, path, message });
	}

	private pathIn(document: ISchemaDocument, pointer: string): string {
		return (document.isRoot ? '' : document.uri + '#') + pointer;
	}

	private pathOf(node: SchemaNode, suffix = ''): string {
		return this.pathIn(node.resource.document, node.pointer + suffix);
	}

	compileDocument(raw: unknown, uri: string, dialect: JsonSchemaDialect, isRoot: boolean): SchemaNode {
		const document: ISchemaDocument = { uri, raw, dialect, isRoot };
		return this.compileNode(raw, undefined, document, '', 0);
	}

	private createResource(baseUri: string, document: ISchemaDocument, rootRaw: unknown, rootPointer: string, rootDepth: number): ISchemaResource {
		const resource: ISchemaResource = { baseUri, dialect: document.dialect, document, rootRaw, rootPointer, rootDepth, anchors: new Map(), dynamicAnchors: new Map() };
		if (!this.resources.has(baseUri)) {
			this.resources.set(baseUri, resource);
		}
		return resource;
	}

	private compileNode(raw: unknown, parent: ISchemaResource | undefined, document: ISchemaDocument, pointer: string, depth: number): SchemaNode {
		const existing = isJsonObject(raw) ? this.nodes.get(raw) : undefined;
		if (existing) {
			return existing;
		}

		// `$id` establishes a new resource with its own base URI.
		let resource = parent;
		let anchorFromId: string | undefined;
		if (isJsonObject(raw) && raw.$id !== undefined && !(document.dialect === 'draft-07' && typeof raw.$ref === 'string')) {
			const id = raw.$id;
			if (typeof id !== 'string') {
				this.error('invalid-schema', this.pathIn(document, pointer + '/$id'), `'$id' must be a string`);
			} else {
				const [uriPart, fragment] = splitFragment(id);
				if (fragment) {
					if (document.dialect === 'draft-07' && uriPart === '' && ANCHOR_PATTERN.test(fragment)) {
						anchorFromId = fragment;
					} else {
						this.error('invalid-schema', this.pathIn(document, pointer + '/$id'), `'$id' must not contain a non-empty fragment`);
					}
				}
				if (uriPart !== '') {
					const baseUri = resolveUri(uriPart, parent?.baseUri ?? document.uri);
					if (baseUri === undefined) {
						this.error('invalid-schema', this.pathIn(document, pointer + '/$id'), `'$id' is not a valid URI reference`);
					} else {
						resource = this.createResource(baseUri, document, raw, pointer, depth);
					}
				}
			}
		}
		if (!resource) {
			resource = this.createResource(document.uri, document, raw, pointer, depth);
		}
		if (!parent && resource.baseUri !== document.uri && !this.resources.has(document.uri)) {
			// The document is also known under its retrieval URI.
			this.resources.set(document.uri, resource);
		}

		const node = new SchemaNode(resource, pointer, depth);
		if (typeof raw === 'boolean') {
			node.bool = raw;
			this.countNode(node);
			return node;
		}
		if (!isJsonObject(raw)) {
			this.error('invalid-schema', this.pathIn(document, pointer), 'A schema must be an object or a boolean');
			node.bool = false;
			return node;
		}

		this.nodes.set(raw, node);
		if (!this.countNode(node)) {
			return node;
		}
		if (depth > this.maxDepth) {
			if (!this.tooDeepReported) {
				this.tooDeepReported = true;
				this.error('too-deep', this.pathIn(document, pointer), `Schema nesting exceeds the maximum depth of ${this.maxDepth}`);
			}
			return node;
		}

		if (anchorFromId !== undefined) {
			resource.anchors.set(anchorFromId, node);
		}
		if (document.dialect === '2020-12') {
			if (raw.$anchor !== undefined) {
				const anchor = raw.$anchor;
				if (typeof anchor !== 'string' || !ANCHOR_PATTERN.test(anchor)) {
					this.error('invalid-schema', this.pathIn(document, pointer + '/$anchor'), `'$anchor' must be a plain name`);
				} else {
					resource.anchors.set(anchor, node);
				}
			}
			if (raw.$dynamicAnchor !== undefined) {
				const anchor = raw.$dynamicAnchor;
				if (typeof anchor !== 'string' || !ANCHOR_PATTERN.test(anchor)) {
					this.error('invalid-schema', this.pathIn(document, pointer + '/$dynamicAnchor'), `'$dynamicAnchor' must be a plain name`);
				} else {
					resource.anchors.set(anchor, node);
					resource.dynamicAnchors.set(anchor, node);
					node.dynamicAnchor = anchor;
				}
			}
		}

		parseKeywords(raw, node, this.keywordContext(node));
		return node;
	}

	private countNode(node: SchemaNode): boolean {
		if (++this.nodeCount > this.maxSubschemas) {
			if (!this.tooManyReported) {
				this.tooManyReported = true;
				this.error('too-many-subschemas', this.pathOf(node), `Schema has more than the maximum of ${this.maxSubschemas} subschemas`);
			}
			return false;
		}
		return true;
	}

	private keywordContext(node: SchemaNode): IKeywordCompileContext {
		return {
			dialect: node.resource.dialect,
			child: (raw, suffix) => this.compileNode(raw, node.resource, node.resource.document, node.pointer + suffix, node.depth + 1),
			pattern: (source, suffix) => this.compilePattern(source, this.pathOf(node, suffix)),
			ref: (owner, keyword, value) => this.pendingReferences.push({ node: owner, keyword, value }),
			invalid: (suffix, message) => this.error('invalid-schema', this.pathOf(node, suffix), message),
		};
	}

	private compilePattern(source: string, path: string): RegExp | undefined {
		if (source.length > this.maxPatternLength) {
			this.error('invalid-pattern', path, `Pattern exceeds the maximum length of ${this.maxPatternLength} characters`);
			return undefined;
		}
		const problem = findUnsafeRegexConstruct(source);
		if (problem) {
			this.error('invalid-pattern', path, `Pattern is not allowed: ${problem}`);
			return undefined;
		}
		try {
			return new RegExp(source, 'u');
		} catch (error) {
			this.error('invalid-pattern', path, `Pattern is invalid: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	resolveReferences(): void {
		// Resolving a reference may compile schemas on demand, which may add more references.
		for (let pending = this.pendingReferences.pop(); pending; pending = this.pendingReferences.pop()) {
			const target = this.resolveReference(pending);
			if (!target) {
				continue;
			}
			if (pending.keyword === '$ref') {
				pending.node.ref = target;
			} else {
				pending.node.dynamicRef = target;
				const fragment = decodeFragment(splitFragment(pending.value)[1]);
				// Dynamic scope resolution only applies when the initial target is a matching $dynamicAnchor.
				if (fragment && !fragment.startsWith('/') && target.dynamicAnchor === fragment) {
					pending.node.dynamicRefAnchor = fragment;
				}
			}
		}
	}

	private resolveReference(pending: IPendingReference): SchemaNode | undefined {
		const { node, keyword, value } = pending;
		const path = this.pathOf(node, '/' + keyword);
		const [uriPart, rawFragment] = splitFragment(value);
		const uri = resolveUri(uriPart, node.resource.baseUri);
		if (uri === undefined) {
			this.error('unresolved-ref', path, `Cannot resolve '${value}' against base URI '${node.resource.baseUri}'`);
			return undefined;
		}
		const resource = this.resources.get(uri) ?? this.loadDocument(uri, node.resource.dialect, path);
		if (!resource) {
			return undefined;
		}
		const fragment = decodeFragment(rawFragment);
		if (fragment === undefined) {
			this.error('unresolved-ref', path, `Fragment of '${value}' is not correctly percent-encoded`);
			return undefined;
		}
		if (fragment === '') {
			return this.compileNode(resource.rootRaw, resource, resource.document, resource.rootPointer, resource.rootDepth);
		}
		if (fragment.startsWith('/')) {
			return this.resolvePointer(resource, fragment, path);
		}
		const anchor = resource.anchors.get(fragment);
		if (!anchor) {
			this.error('unresolved-ref', path, `Cannot find anchor '${fragment}' in '${resource.baseUri}'`);
		}
		return anchor;
	}

	private resolvePointer(resource: ISchemaResource, pointer: string, path: string): SchemaNode | undefined {
		let current: unknown = resource.rootRaw;
		let contextResource = resource;
		let currentPointer = resource.rootPointer;
		let depth = resource.rootDepth;
		for (const token of pointer.slice(1).split('/').map(unescapePointerToken)) {
			if (isJsonObject(current) && hasOwn(current, token)) {
				current = current[token];
			} else if (Array.isArray(current) && /^(?:0|[1-9]\d*)$/.test(token) && Number(token) < current.length) {
				current = current[Number(token)];
			} else {
				this.error('unresolved-ref', path, `Cannot resolve JSON pointer '${pointer}' in '${resource.baseUri}'`);
				return undefined;
			}
			currentPointer += '/' + escapePointerToken(token);
			depth++;
			const known = isJsonObject(current) ? this.nodes.get(current) : undefined;
			if (known) {
				contextResource = known.resource;
				depth = known.depth;
			}
		}
		if (typeof current !== 'boolean' && !isJsonObject(current)) {
			this.error('unresolved-ref', path, `JSON pointer '${pointer}' in '${resource.baseUri}' does not point to a schema`);
			return undefined;
		}
		return this.compileNode(current, contextResource, contextResource.document, currentPointer, depth);
	}

	private loadDocument(uri: string, inheritedDialect: JsonSchemaDialect, path: string): ISchemaResource | undefined {
		let raw: unknown;
		if (METASCHEMAS.has(uri)) {
			raw = METASCHEMAS.get(uri);
		} else if (this.remoteDocuments.has(uri)) {
			raw = this.remoteDocuments.get(uri);
		} else {
			this.error('remote-ref', path, `Reference to '${uri}' cannot be resolved: references to remote documents are not supported`);
			return undefined;
		}
		const detection = detectDialect(raw, { dialect: inheritedDialect }, uri + '#');
		if (!detection.dialect) {
			this.errors.push(detection.error!);
			return undefined;
		}
		if (!isJsonObject(raw) && typeof raw !== 'boolean') {
			this.error('invalid-schema', uri + '#', 'A schema must be an object or a boolean');
			return undefined;
		}
		this.compileDocument(raw, uri, detection.dialect, false);
		return this.resources.get(uri);
	}

	/** Rejects `$ref` chains (and cycles) longer than `maxRefHops`, which could never terminate. */
	checkReferenceChains(): void {
		for (const node of this.nodes.values()) {
			let hops = 0;
			for (let current = node.ref; current; current = current.ref) {
				if (++hops > this.maxRefHops) {
					this.error('unresolved-ref', this.pathOf(node, '/$ref'), `'$ref' chain exceeds the maximum of ${this.maxRefHops} hops (possible reference cycle)`);
					return;
				}
			}
		}
	}
}

//#endregion

//#region Embedded metaschemas

/**
 * Trimmed 2020-12 metaschema: the core, applicator, unevaluated, validation,
 * meta-data, format and content vocabularies without `$vocabulary` machinery.
 */
const DRAFT_2020_12_METASCHEMA: JsonObject = {
	$schema: DIALECT_2020_12_URI,
	$id: DIALECT_2020_12_URI,
	$dynamicAnchor: 'meta',
	title: 'JSON Schema 2020-12 (trimmed)',
	type: ['object', 'boolean'],
	$defs: {
		schemaArray: { type: 'array', minItems: 1, items: { $dynamicRef: '#meta' } },
		nonNegativeInteger: { type: 'integer', minimum: 0 },
		nonNegativeIntegerDefault0: { $ref: '#/$defs/nonNegativeInteger', default: 0 },
		simpleTypes: { enum: ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'] },
		stringArray: { type: 'array', items: { type: 'string' }, uniqueItems: true, default: [] },
		anchorString: { type: 'string', pattern: '^[A-Za-z_][-A-Za-z0-9._]*$' },
		uriString: { type: 'string', format: 'uri' },
		uriReferenceString: { type: 'string', format: 'uri-reference' },
	},
	properties: {
		// core
		$id: { $ref: '#/$defs/uriReferenceString', $comment: 'Non-empty fragments not allowed.', pattern: '^[^#]*#?$' },
		$schema: { $ref: '#/$defs/uriString' },
		$ref: { $ref: '#/$defs/uriReferenceString' },
		$anchor: { $ref: '#/$defs/anchorString' },
		$dynamicRef: { $ref: '#/$defs/uriReferenceString' },
		$dynamicAnchor: { $ref: '#/$defs/anchorString' },
		$vocabulary: { type: 'object', propertyNames: { $ref: '#/$defs/uriString' }, additionalProperties: { type: 'boolean' } },
		$comment: { type: 'string' },
		$defs: { type: 'object', additionalProperties: { $dynamicRef: '#meta' } },
		// applicator
		prefixItems: { $ref: '#/$defs/schemaArray' },
		items: { $dynamicRef: '#meta' },
		contains: { $dynamicRef: '#meta' },
		additionalProperties: { $dynamicRef: '#meta' },
		properties: { type: 'object', additionalProperties: { $dynamicRef: '#meta' }, default: {} },
		patternProperties: { type: 'object', additionalProperties: { $dynamicRef: '#meta' }, propertyNames: { format: 'regex' }, default: {} },
		dependentSchemas: { type: 'object', additionalProperties: { $dynamicRef: '#meta' }, default: {} },
		propertyNames: { $dynamicRef: '#meta' },
		if: { $dynamicRef: '#meta' },
		then: { $dynamicRef: '#meta' },
		else: { $dynamicRef: '#meta' },
		allOf: { $ref: '#/$defs/schemaArray' },
		anyOf: { $ref: '#/$defs/schemaArray' },
		oneOf: { $ref: '#/$defs/schemaArray' },
		not: { $dynamicRef: '#meta' },
		// unevaluated
		unevaluatedItems: { $dynamicRef: '#meta' },
		unevaluatedProperties: { $dynamicRef: '#meta' },
		// validation
		type: {
			anyOf: [
				{ $ref: '#/$defs/simpleTypes' },
				{ type: 'array', items: { $ref: '#/$defs/simpleTypes' }, minItems: 1, uniqueItems: true },
			],
		},
		const: true,
		enum: { type: 'array', items: true },
		multipleOf: { type: 'number', exclusiveMinimum: 0 },
		maximum: { type: 'number' },
		exclusiveMaximum: { type: 'number' },
		minimum: { type: 'number' },
		exclusiveMinimum: { type: 'number' },
		maxLength: { $ref: '#/$defs/nonNegativeInteger' },
		minLength: { $ref: '#/$defs/nonNegativeIntegerDefault0' },
		pattern: { type: 'string', format: 'regex' },
		maxItems: { $ref: '#/$defs/nonNegativeInteger' },
		minItems: { $ref: '#/$defs/nonNegativeIntegerDefault0' },
		uniqueItems: { type: 'boolean', default: false },
		maxContains: { $ref: '#/$defs/nonNegativeInteger' },
		minContains: { $ref: '#/$defs/nonNegativeInteger', default: 1 },
		maxProperties: { $ref: '#/$defs/nonNegativeInteger' },
		minProperties: { $ref: '#/$defs/nonNegativeIntegerDefault0' },
		required: { $ref: '#/$defs/stringArray' },
		dependentRequired: { type: 'object', additionalProperties: { $ref: '#/$defs/stringArray' } },
		// meta-data
		title: { type: 'string' },
		description: { type: 'string' },
		default: true,
		deprecated: { type: 'boolean', default: false },
		readOnly: { type: 'boolean', default: false },
		writeOnly: { type: 'boolean', default: false },
		examples: { type: 'array', items: true },
		// format
		format: { type: 'string' },
		// content
		contentEncoding: { type: 'string' },
		contentMediaType: { type: 'string' },
		contentSchema: { $dynamicRef: '#meta' },
		// deprecated keywords kept for compatibility
		definitions: { $comment: '"definitions" has been replaced by "$defs".', type: 'object', additionalProperties: { $dynamicRef: '#meta' }, deprecated: true, default: {} },
		dependencies: {
			$comment: '"dependencies" has been split into "dependentSchemas" and "dependentRequired".',
			type: 'object',
			additionalProperties: { anyOf: [{ $dynamicRef: '#meta' }, { $ref: '#/$defs/stringArray' }] },
			deprecated: true,
			default: {},
		},
		$recursiveAnchor: { $ref: '#/$defs/anchorString', deprecated: true },
		$recursiveRef: { $ref: '#/$defs/uriReferenceString', deprecated: true },
	},
};

/** Trimmed draft-07 metaschema. */
const DRAFT_07_METASCHEMA: JsonObject = {
	$schema: DIALECT_DRAFT_07_URI + '#',
	$id: DIALECT_DRAFT_07_URI + '#',
	title: 'Core schema meta-schema (trimmed)',
	definitions: {
		schemaArray: { type: 'array', minItems: 1, items: { $ref: '#' } },
		nonNegativeInteger: { type: 'integer', minimum: 0 },
		nonNegativeIntegerDefault0: { allOf: [{ $ref: '#/definitions/nonNegativeInteger' }, { default: 0 }] },
		simpleTypes: { enum: ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'] },
		stringArray: { type: 'array', items: { type: 'string' }, uniqueItems: true, default: [] },
	},
	type: ['object', 'boolean'],
	properties: {
		$id: { type: 'string', format: 'uri-reference' },
		$schema: { type: 'string', format: 'uri' },
		$ref: { type: 'string', format: 'uri-reference' },
		$comment: { type: 'string' },
		title: { type: 'string' },
		description: { type: 'string' },
		default: true,
		readOnly: { type: 'boolean', default: false },
		writeOnly: { type: 'boolean', default: false },
		examples: { type: 'array', items: true },
		multipleOf: { type: 'number', exclusiveMinimum: 0 },
		maximum: { type: 'number' },
		exclusiveMaximum: { type: 'number' },
		minimum: { type: 'number' },
		exclusiveMinimum: { type: 'number' },
		maxLength: { $ref: '#/definitions/nonNegativeInteger' },
		minLength: { $ref: '#/definitions/nonNegativeIntegerDefault0' },
		pattern: { type: 'string', format: 'regex' },
		additionalItems: { $ref: '#' },
		items: { anyOf: [{ $ref: '#' }, { $ref: '#/definitions/schemaArray' }], default: true },
		maxItems: { $ref: '#/definitions/nonNegativeInteger' },
		minItems: { $ref: '#/definitions/nonNegativeIntegerDefault0' },
		uniqueItems: { type: 'boolean', default: false },
		contains: { $ref: '#' },
		maxProperties: { $ref: '#/definitions/nonNegativeInteger' },
		minProperties: { $ref: '#/definitions/nonNegativeIntegerDefault0' },
		required: { $ref: '#/definitions/stringArray' },
		additionalProperties: { $ref: '#' },
		definitions: { type: 'object', additionalProperties: { $ref: '#' }, default: {} },
		properties: { type: 'object', additionalProperties: { $ref: '#' }, default: {} },
		patternProperties: { type: 'object', additionalProperties: { $ref: '#' }, propertyNames: { format: 'regex' }, default: {} },
		dependencies: { type: 'object', additionalProperties: { anyOf: [{ $ref: '#' }, { $ref: '#/definitions/stringArray' }] } },
		propertyNames: { $ref: '#' },
		const: true,
		enum: { type: 'array', items: true },
		type: {
			anyOf: [
				{ $ref: '#/definitions/simpleTypes' },
				{ type: 'array', items: { $ref: '#/definitions/simpleTypes' }, minItems: 1, uniqueItems: true },
			],
		},
		format: { type: 'string' },
		contentMediaType: { type: 'string' },
		contentEncoding: { type: 'string' },
		if: { $ref: '#' },
		then: { $ref: '#' },
		else: { $ref: '#' },
		allOf: { $ref: '#/definitions/schemaArray' },
		anyOf: { $ref: '#/definitions/schemaArray' },
		oneOf: { $ref: '#/definitions/schemaArray' },
		not: { $ref: '#' },
	},
	default: true,
};

const METASCHEMAS = new Map<string, JsonObject>([
	[DIALECT_2020_12_URI, DRAFT_2020_12_METASCHEMA],
	[DIALECT_DRAFT_07_URI, DRAFT_07_METASCHEMA],
]);

export function getMetaschemaDocument(dialect: JsonSchemaDialect): JsonObject {
	return dialect === 'draft-07' ? DRAFT_07_METASCHEMA : DRAFT_2020_12_METASCHEMA;
}

//#endregion
