/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IJsonSchemaCompileError, IJsonSchemaCompileOptions, JsonSchemaCompileErrorCode, JsonSchemaDialect } from './index.js';
import { escapePointerToken, hasOwn, IGuardedPattern, IKeywordCompileContext, isJsonObject, ISchemaDocument, ISchemaResource, JsonObject, parseKeywords, SchemaNode, unescapePointerToken } from './keywords.js';
import { analyzeRegexCost, estimateRegexCost, IRegexCost, MAX_DEGREE, regexStepBound } from './regexCost.js';

export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_SUBSCHEMAS = 4096;
export const DEFAULT_MAX_REF_HOPS = 64;
export const DEFAULT_MAX_PATTERN_LENGTH = 4096;
export const DEFAULT_EVAL_BUDGET = 100_000;
/**
 * The work the backtracking analysis of the patterns of one compilation may
 * take (in the units of `analyzeRegexCost`, 10 to 50 ns each): about 0.1 s at
 * most. 4096 distinct patterns of the usual kind (a semver, a date, a UUID)
 * take about a million; one adversarial pattern of 4096 characters up to about
 * 850 000 (the heaviest known: 2040 distinct characters, each with `*`), so a
 * schema of a single pattern is always analyzed.
 */
export const DEFAULT_PATTERN_ANALYSIS_BUDGET = 2_000_000;

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
	/** Set when an unsupported `$schema` is tolerated (`unsupportedDialect: 'warn'`) and the default dialect is used instead. */
	readonly warning?: IJsonSchemaCompileError;
}

/** Determines the dialect of a schema document from `$schema`, falling back to the configured default. */
export function detectDialect(schema: unknown, options: IJsonSchemaCompileOptions | undefined, pathPrefix = ''): IDialectDetection {
	const defaultDialect = options?.dialect ?? '2020-12';
	if (isJsonObject(schema) && schema.$schema !== undefined) {
		const value = schema.$schema;
		const dialect = typeof value === 'string' ? dialectOfSchemaUri(value) : undefined;
		if (!dialect) {
			const problem = { code: 'unsupported-dialect' as const, path: pathPrefix + '/$schema', message: `Unsupported JSON Schema dialect '${String(value)}'; supported are '${DIALECT_2020_12_URI}' and '${DIALECT_DRAFT_07_URI}#'` };
			if (options?.unsupportedDialect === 'warn') {
				return { dialect: defaultDialect, warning: { ...problem, message: `${problem.message}; validating as ${defaultDialect}` } };
			}
			return { error: problem };
		}
		return { dialect };
	}
	return { dialect: defaultDialect };
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

/** What the scan knows about the body of a group (at any depth). */
interface IRegexGroupScan {
	/** It contains an alternation (`|`). */
	alternation: boolean;
	/** It contains an unbounded quantifier (`*`, `+`, `{n,}`). */
	unbounded: boolean;
	/**
	 * How many ways its bounded quantifiers can split a match (the product of
	 * their numbers of repetition counts); 1 when its length is fixed.
	 */
	choices: number;
}

/**
 * The most ways a repeated group of varying, bounded length may split a
 * match (e.g. `(\d{1,3}\.){3}` has 3^3 = 27); backtracking tries them all at
 * every position.
 */
const MAX_REPEATED_GROUP_CHOICES = 256;

/** The deepest nesting of groups (lookarounds included) the guard accepts; the cost analysis recurses into each. */
const MAX_GROUP_NESTING = 64;

/**
 * Scans an ECMAScript pattern for constructs that are never compiled, whether
 * or not `RegExp` accepts them: back-references, lookbehind assertions,
 * groups nested more than {@link MAX_GROUP_NESTING} deep, and repetitions
 * whose backtracking can explode. A single `RegExp.test` cannot
 * be interrupted (no time budget reaches into it), so the guard refuses the
 * repetitions it cannot prove linear rather than only those it can prove
 * harmful: a repeated group with an alternation (e.g. `(a|a)*`, `(a|b){2}`),
 * a repeated group of unbounded length (e.g. `(a+)+`, `(a*){2}`), a group of
 * varying length repeated without bound (e.g. `(ab?)*`), and one repeated so
 * often that it can split a match in more than
 * {@link MAX_REPEATED_GROUP_CHOICES} ways (e.g. `(a{1,2}){9}`). A pattern
 * with such a construct is not asserted. What the guard accepts can still
 * backtrack polynomially (e.g. `a*a*`, `a*.{99999}`, or a long sequence tried
 * at every position): {@link patternInputLimit} bounds the steps of one test
 * of such a pattern and limits the strings it is tested on accordingly.
 */
export function findUnsafeRegexConstruct(source: string): string | undefined {
	const newFrame = (): IRegexGroupScan => ({ alternation: false, unbounded: false, choices: 1 });
	const frames: IRegexGroupScan[] = [newFrame()];
	/** The group that just closed; the choices it adds to its parent depend on the quantifier that may follow. */
	let lastClosedGroup: IRegexGroupScan | undefined;
	const addLastClosedGroup = (choices = lastClosedGroup?.choices ?? 1) => {
		frames[frames.length - 1].choices *= choices;
		lastClosedGroup = undefined;
	};
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
			addLastClosedGroup();
			continue;
		}
		if (ch === '[') {
			inClass = true;
			i++;
			addLastClosedGroup();
			continue;
		}
		if (ch === '|') {
			addLastClosedGroup();
			frames[frames.length - 1].alternation = true;
			i++;
			continue;
		}
		if (ch === '(') {
			if (source.startsWith('(?<=', i) || source.startsWith('(?<!', i)) {
				return 'lookbehind assertions are not supported';
			}
			addLastClosedGroup();
			frames.push(newFrame());
			if (frames.length > MAX_GROUP_NESTING + 1) {
				return `groups nested more than ${MAX_GROUP_NESTING} deep are not supported`;
			}
			// Skip the group prefix, whose `?` is not a quantifier: `(?:`, `(?=`, `(?!`, `(?<name>`, `(?ims-ims:`.
			if (source[i + 1] !== '?') {
				i++;
			} else if (source[i + 2] === ':' || source[i + 2] === '=' || source[i + 2] === '!') {
				i += 3;
			} else {
				const end = source.indexOf(source[i + 2] === '<' ? '>' : ':', i + 2);
				i = end < 0 ? source.length : end + 1;
			}
			continue;
		}
		if (ch === ')') {
			if (frames.length === 1) {
				return undefined; // unbalanced; RegExp reports the syntax error
			}
			addLastClosedGroup();
			const closed = frames.pop()!;
			const parent = frames[frames.length - 1];
			parent.alternation ||= closed.alternation;
			parent.unbounded ||= closed.unbounded;
			lastClosedGroup = closed;
			i++;
			continue;
		}
		let quantifier = false;
		let min = 0;
		let max = 0;
		if (ch === '*' || ch === '+') {
			quantifier = true;
			min = ch === '*' ? 0 : 1;
			max = Infinity;
			i++;
		} else if (ch === '?') {
			quantifier = true;
			max = 1;
			i++;
		} else if (ch === '{') {
			const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i));
			if (match) {
				quantifier = true;
				min = Number(match[1]);
				max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
				i += match[0].length;
			} else {
				i++;
			}
		} else {
			i++;
		}
		if (!quantifier) {
			addLastClosedGroup();
			continue;
		}
		if (source[i] === '?') {
			i++; // lazy modifier
		}
		const counts = max - min + 1; // Infinity for an unbounded quantifier
		const group = lastClosedGroup;
		if (group && max > 1) {
			if (group.alternation) {
				return 'a repeated group with alternatives is not supported (it can backtrack exponentially)';
			}
			if (group.unbounded) {
				return max === Infinity ? 'nested unbounded quantifiers are not supported' : 'a repeated group of unbounded length is not supported (its backtracking grows with the input)';
			}
			if (group.choices > 1) {
				const choices = group.choices ** max * counts;
				if (!(choices <= MAX_REPEATED_GROUP_CHOICES)) {
					return max === Infinity
						? 'a group whose length varies, repeated without bound, is not supported (it can backtrack exponentially)'
						: 'a group whose length varies is repeated too often (it can backtrack exponentially)';
				}
				addLastClosedGroup(choices);
				continue;
			}
		}
		if (max === Infinity) {
			frames[frames.length - 1].unbounded = true;
			addLastClosedGroup();
		} else {
			addLastClosedGroup((lastClosedGroup?.choices ?? 1) * counts);
		}
	}
	return undefined;
}

/**
 * The most backtracking steps one test of a pattern may take (about 10 ms):
 * strings longer than what a pattern can test within it are not tested.
 */
const PATTERN_STEP_BUDGET = 10_000_000;

/**
 * The most steps per character of the input that one test of a pattern whose
 * time grows linearly may take (a megabyte then takes well under a second) for
 * the pattern to be tested on strings of any length.
 */
const MAX_STEPS_PER_CHARACTER = 256;

/**
 * A pattern that could only test shorter strings than this within
 * {@link PATTERN_STEP_BUDGET} is not asserted; this also refuses every pattern
 * whose time grows with the fourth or a higher power of the input length.
 */
const MIN_PATTERN_INPUT_LENGTH = 64;

/** The longest input whose bound on the steps of one test stays within `budget` (-1 when not even the empty one does). */
function longestInputWithin(cost: IRegexCost, budget: number): number {
	if (!(regexStepBound(cost, 0) <= budget)) {
		return -1;
	}
	let low = 0; // within the budget
	let high = 1;
	while (regexStepBound(cost, high) <= budget) {
		low = high;
		high *= 2;
		if (high > Number.MAX_SAFE_INTEGER) {
			return Infinity;
		}
	}
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (regexStepBound(cost, middle) <= budget) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return low;
}

function formatSteps(steps: number): string {
	return Number.isFinite(steps) ? String(Math.ceil(steps)) : 'too many';
}

/**
 * The longest string that one test of a pattern the guard accepted can check
 * within {@link PATTERN_STEP_BUDGET}, from the polynomial that bounds the steps
 * of its backtracking ({@link estimateRegexCost}, which reads the pattern in
 * the mode it compiled in, `unicode` for the `u` flag): `unlimited` for a
 * pattern whose time grows at most linearly with few steps per character (most
 * patterns), a length for one whose time grows faster (e.g.
 * `^[^@]+@[^@]+\.[^@]+$`, quadratic, or `^a*.{4000}!`), or a reason not to
 * assert it at all. The bound is for a backtracking matcher without the
 * optimizations that often make V8 faster, so it also holds where they do not
 * apply.
 */
export function patternInputLimit(source: string, unicode: boolean): PatternInputLimit {
	return inputLimitOf(estimateRegexCost(source, unicode));
}

export type PatternInputLimit =
	| { readonly kind: 'unlimited' }
	| { readonly kind: 'limited'; readonly maxInputLength: number; readonly cause: string }
	| { readonly kind: 'refused'; readonly cause: string };

function inputLimitOf(cost: IRegexCost): PatternInputLimit {
	const [constantSteps = 0, stepsPerCharacter = 0] = cost.coefficients;
	if (cost.degree <= 1 && stepsPerCharacter <= MAX_STEPS_PER_CHARACTER && constantSteps <= PATTERN_STEP_BUDGET) {
		return { kind: 'unlimited' };
	}
	const degree = cost.degree;
	const growth = degree === 2 ? 'the square of the input length' : degree === 3 ? 'the cube of the input length' : degree > MAX_DEGREE ? `the input length to a power above ${MAX_DEGREE}` : `the input length to the power ${degree}`;
	const cause = degree >= 2
		? `its backtracking can take time that grows with ${growth}`
		: stepsPerCharacter > MAX_STEPS_PER_CHARACTER
			? `its backtracking can take ${formatSteps(stepsPerCharacter)} steps for each character of the input`
			: `its backtracking can take ${formatSteps(constantSteps)} steps`;
	const maxInputLength = longestInputWithin(cost, PATTERN_STEP_BUDGET);
	if (!(maxInputLength >= MIN_PATTERN_INPUT_LENGTH)) {
		return { kind: 'refused', cause };
	}
	return { kind: 'limited', maxInputLength, cause };
}

interface IPatternAnalysis {
	readonly limit: PatternInputLimit;
	/** The work the analysis took, which a compilation that finds it here is charged all the same. */
	readonly work: number;
}

/** How many analyses {@link patternAnalyses} keeps (patterns have at most 4096 characters by default). */
const PATTERN_ANALYSIS_CACHE_SIZE = 256;

/**
 * The analyses of the most recently used patterns, by mode and source: a
 * schema is often compiled more than once (to check it, then to use it). A
 * compilation is charged the recorded work of an analysis it finds here, so
 * that what it asserts does not depend on what was compiled before.
 */
const patternAnalyses = new Map<string, IPatternAnalysis>();

function rememberPatternAnalysis(key: string, analysis: IPatternAnalysis): void {
	patternAnalyses.delete(key);
	if (patternAnalyses.size >= PATTERN_ANALYSIS_CACHE_SIZE) {
		const oldest = patternAnalyses.keys().next();
		if (!oldest.done) {
			patternAnalyses.delete(oldest.value);
		}
	}
	patternAnalyses.set(key, analysis);
}

/** How many backtracking analyses compilations have run (one found in {@link patternAnalyses} is not one). */
let patternAnalysisRuns = 0;

/** How many backtracking analyses of patterns compilations have run in this process: an analysis a compilation reuses (from an earlier one) is not counted. For tests. */
export function getPatternAnalysisRunCount(): number {
	return patternAnalysisRuns;
}

/**
 * A budget for the backtracking analysis of the patterns of several
 * compilations, which then share it as if they were one (see
 * `IJsonSchemaCompileOptions.sharedPatternAnalysisBudget`): what one of them
 * spends is gone for the others, and a pattern one of them has paid for (or
 * found beyond the budget) costs the others nothing (and is refused for them
 * too). Use one for a group of schemas whose total analysis time must be
 * bounded, such as the tool schemas of one list a server sends.
 */
export class PatternAnalysisBudget {
	/** What is left of {@link total}. */
	public workLeft: number;
	/** The limits of the patterns analyzed under this budget (undefined beyond it), by mode and source. */
	public readonly limits = new Map<string, PatternInputLimit | undefined>();

	constructor(public readonly total: number = DEFAULT_PATTERN_ANALYSIS_BUDGET) {
		this.workLeft = total;
	}
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
	/** Problems that do not prevent compilation (see {@link ICompiledJsonSchema.warnings}). */
	readonly warnings: IJsonSchemaCompileError[];
}

export function compileSchemaTree(schema: unknown, options: IJsonSchemaCompileOptions = {}): ICompileResult {
	const detection = detectDialect(schema, options);
	if (!detection.dialect) {
		return { tree: undefined, errors: [detection.error!], warnings: [] };
	}
	if (!isJsonObject(schema) && typeof schema !== 'boolean') {
		return { tree: undefined, errors: [{ code: 'invalid-schema', path: '', message: 'A schema must be an object or a boolean' }], warnings: [] };
	}
	const ctx = new CompileContext(options);
	if (detection.warning) {
		ctx.warnings.push(detection.warning);
	}
	const root = ctx.compileDocument(schema, ROOT_DOCUMENT_URI, detection.dialect, true);
	ctx.resolveReferences();
	ctx.checkReferenceChains();
	if (ctx.errors.length) {
		return { tree: undefined, errors: ctx.errors, warnings: ctx.warnings };
	}
	return { tree: { root, dialect: detection.dialect }, errors: [], warnings: ctx.warnings };
}

interface IPendingReference {
	readonly node: SchemaNode;
	readonly keyword: '$ref' | '$dynamicRef';
	readonly value: string;
}

class CompileContext {
	public readonly errors: IJsonSchemaCompileError[] = [];
	public readonly warnings: IJsonSchemaCompileError[] = [];

	private readonly maxDepth: number;
	private readonly maxSubschemas: number;
	private readonly maxRefHops: number;
	private readonly maxPatternLength: number;
	/**
	 * The budget of the analyses of the patterns: this compilation's own, or
	 * one it shares with others; its limits are those of the patterns analyzed
	 * under it (a repeated pattern costs nothing).
	 */
	private readonly patternAnalysis: PatternAnalysisBudget;
	private readonly sharesPatternAnalysis: boolean;
	private readonly unsupportedDialect: IJsonSchemaCompileOptions['unsupportedDialect'];
	private readonly tolerateLocalReferenceProblems: boolean;
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
		this.sharesPatternAnalysis = !!options.sharedPatternAnalysisBudget;
		this.patternAnalysis = options.sharedPatternAnalysisBudget ?? new PatternAnalysisBudget(options.patternAnalysisBudget ?? DEFAULT_PATTERN_ANALYSIS_BUDGET);
		this.unsupportedDialect = options.unsupportedDialect;
		this.tolerateLocalReferenceProblems = options.localReferenceProblems === 'warn';
		if (options.remoteDocuments) {
			for (const [uri, raw] of options.remoteDocuments) {
				this.remoteDocuments.set(normalizeUri(uri), raw);
			}
		}
	}

	private error(code: JsonSchemaCompileErrorCode, path: string, message: string): void {
		this.errors.push({ code, path, message });
	}

	private warning(code: JsonSchemaCompileErrorCode, path: string, message: string): void {
		this.warnings.push({ code, path, message });
	}

	/** A problem confined to a known document: an error, or a warning when such problems are tolerated (see `localReferenceProblems`). */
	private localProblem(code: JsonSchemaCompileErrorCode, path: string, message: string, whenTolerated: string): void {
		if (this.tolerateLocalReferenceProblems) {
			this.warning(code, path, `${message}; ${whenTolerated}`);
		} else {
			this.error(code, path, message);
		}
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
						const plainName = ANCHOR_PATTERN.test(fragment);
						this.localProblem('invalid-schema', this.pathIn(document, pointer + '/$id'), `'$id' must not contain a non-empty fragment`, plainName ? 'the fragment is read as an anchor' : 'the fragment is ignored');
						if (plainName && this.tolerateLocalReferenceProblems) {
							anchorFromId = fragment;
						}
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
					this.localProblem('invalid-schema', this.pathIn(document, pointer + '/$anchor'), `'$anchor' must be a plain name`, 'it is ignored');
				} else {
					resource.anchors.set(anchor, node);
				}
			}
			if (raw.$dynamicAnchor !== undefined) {
				const anchor = raw.$dynamicAnchor;
				if (typeof anchor !== 'string' || !ANCHOR_PATTERN.test(anchor)) {
					this.localProblem('invalid-schema', this.pathIn(document, pointer + '/$dynamicAnchor'), `'$dynamicAnchor' must be a plain name`, 'it is ignored');
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

	/**
	 * Compiles a `pattern` or a `patternProperties` key. Patterns are compiled
	 * with the `u` flag (code point semantics), and again without it when that
	 * is a syntax error: identity escapes such as `\-`, `\#` or `\:` are valid
	 * ECMA-262 without `u` and common in real schemas. A pattern that still
	 * does not compile, or that the backtracking guard rejects, is not
	 * asserted (it validates nothing) and is reported as a warning, so the
	 * rest of the schema stays usable. A pattern whose backtracking can take
	 * more than linear time (or many steps per character) is only tested on
	 * strings it can check within a step budget ({@link patternInputLimit},
	 * for the mode it compiled in), also with a warning. The analyses of the
	 * patterns of one compilation share a budget ({@link analyzePattern}): a
	 * pattern beyond it is not asserted either, with a warning. Only an
	 * over-long pattern (a limit) is an error.
	 */
	private compilePattern(source: string, path: string): IGuardedPattern | undefined {
		if (source.length > this.maxPatternLength) {
			this.error('invalid-pattern', path, `Pattern exceeds the maximum length of ${this.maxPatternLength} characters`);
			return undefined;
		}
		const problem = findUnsafeRegexConstruct(source);
		if (problem) {
			this.warning('invalid-pattern', path, `Pattern is not checked: ${problem}`);
			return undefined;
		}
		const regex = this.compileRegExp(source, path);
		if (!regex) {
			return undefined;
		}
		const limit = this.analyzePattern(source, regex.unicode);
		if (!limit) {
			this.warning('invalid-pattern', path, this.sharesPatternAnalysis
				? `Pattern is not checked: analyzing the backtracking of the patterns of the schemas that share a budget of ${this.patternAnalysis.total} steps takes more than that budget`
				: `Pattern is not checked: analyzing the backtracking of the patterns of the schema takes more than its budget of ${this.patternAnalysis.total} steps`);
			return undefined;
		}
		switch (limit.kind) {
			case 'unlimited':
				return { regex, maxInputLength: Infinity };
			case 'limited':
				this.warning('invalid-pattern', path, `Pattern is checked only for strings of at most ${limit.maxInputLength} characters: ${limit.cause}`);
				return { regex, maxInputLength: limit.maxInputLength };
			case 'refused':
				this.warning('invalid-pattern', path, `Pattern is not checked: ${limit.cause}`);
				return undefined;
		}
	}

	/**
	 * The {@link patternInputLimit} of a pattern, within the analysis budget of
	 * the compilation (or the one it shares with others): undefined for a
	 * pattern whose analysis does not fit in what is left of it, which also
	 * uses up the rest, so that every later pattern that needs an analysis is
	 * refused at once (an analysis that runs out stops there: the budget bounds
	 * the time). A pattern analyzed under the budget already costs nothing,
	 * and an analysis from an earlier compilation ({@link patternAnalyses})
	 * costs what it took, so the outcome depends on the schemas alone.
	 */
	private analyzePattern(source: string, unicode: boolean): PatternInputLimit | undefined {
		const key = (unicode ? 'u:' : '-:') + source;
		const budget = this.patternAnalysis;
		if (budget.limits.has(key)) {
			return budget.limits.get(key);
		}
		let analysis = patternAnalyses.get(key);
		if (!analysis && budget.workLeft > 0) {
			patternAnalysisRuns++;
			const result = analyzeRegexCost(source, unicode, budget.workLeft);
			if (result) {
				analysis = { limit: inputLimitOf(result.cost), work: result.work };
			}
		}
		let limit: PatternInputLimit | undefined;
		if (analysis && analysis.work <= budget.workLeft) {
			rememberPatternAnalysis(key, analysis);
			budget.workLeft -= analysis.work;
			limit = analysis.limit;
		} else {
			budget.workLeft = 0;
		}
		budget.limits.set(key, limit);
		return limit;
	}

	private compileRegExp(source: string, path: string): RegExp | undefined {
		let unicodeError: unknown;
		try {
			return new RegExp(source, 'u');
		} catch (error) {
			unicodeError = error;
		}
		try {
			return new RegExp(source);
		} catch {
			this.warning('invalid-pattern', path, `Pattern is not checked: it is not a valid regular expression (${unicodeError instanceof Error ? unicodeError.message : String(unicodeError)})`);
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
			this.unresolvedLocalReference(path, `Fragment of '${value}' is not correctly percent-encoded`);
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
			this.unresolvedLocalReference(path, `Cannot find anchor '${fragment}' in '${resource.baseUri}'`);
		}
		return anchor;
	}

	/** A reference into a known document that names no location of it. */
	private unresolvedLocalReference(path: string, message: string): void {
		this.localProblem('unresolved-ref', path, message, 'the reference is not checked');
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
				this.unresolvedLocalReference(path, `Cannot resolve JSON pointer '${pointer}' in '${resource.baseUri}'`);
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
			this.unresolvedLocalReference(path, `JSON pointer '${pointer}' in '${resource.baseUri}' does not point to a schema`);
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
		const detection = detectDialect(raw, { dialect: inheritedDialect, unsupportedDialect: this.unsupportedDialect }, uri + '#');
		if (!detection.dialect) {
			this.errors.push(detection.error!);
			return undefined;
		}
		if (detection.warning) {
			this.warnings.push(detection.warning);
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

/**
 * The 2020-12 metaschema without its rules for `$id` fragments and the form of
 * `$anchor` and `$dynamicAnchor`, which the compiler reports as tolerated
 * problems (see `localReferenceProblems`). The draft-07 metaschema has no such
 * rules.
 */
function lenientDraft202012Metaschema(): JsonObject {
	return {
		...DRAFT_2020_12_METASCHEMA,
		properties: {
			...DRAFT_2020_12_METASCHEMA.properties as JsonObject,
			$id: { $ref: '#/$defs/uriReferenceString' },
			$anchor: true,
			$dynamicAnchor: true,
		},
	};
}

/** @param tolerateLocalReferenceProblems The metaschema for `localReferenceProblems: 'warn'`. */
export function getMetaschemaDocument(dialect: JsonSchemaDialect, tolerateLocalReferenceProblems = false): JsonObject {
	if (dialect === 'draft-07') {
		return DRAFT_07_METASCHEMA;
	}
	return tolerateLocalReferenceProblems ? lenientDraft202012Metaschema() : DRAFT_2020_12_METASCHEMA;
}

//#endregion
