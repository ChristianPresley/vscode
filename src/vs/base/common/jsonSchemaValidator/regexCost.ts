/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A bound on the steps one `RegExp.test` of an ECMAScript pattern takes, for
 * patterns that `findUnsafeRegexConstruct` accepts (no back-references or
 * lookbehind, and no repeated group with alternatives, of unbounded length or
 * with too many ways to split a match).
 *
 * The bound is a polynomial in the length `n` of the input, for a matcher that
 * backtracks (as V8's does) and without the optimizations that often make V8
 * faster than that:
 * - Each character, class or assertion the pattern examines is a step, so a
 *   long sequence costs its length every time it is tried.
 * - A loop that may repeat {@link LONG_LOOP} times or more scans up to `n`
 *   characters, also one of a fixed count (`.{99999}`); a shorter one scans a
 *   constant number of them.
 * - A loop gives back what it matched one iteration at a time. When what
 *   follows it can start with a character the loop matched, each give-back
 *   runs the rest of the pattern again: in `^a*a*$` every split of a run of
 *   `a` is tried, about `n^2` steps, and `k` such loops cost `n^k`. Otherwise
 *   each give-back fails at its first character.
 * - A lookaround is matched on its own at every arrival: in a loop body it
 *   scans again at every iteration.
 * - A search that is not anchored at the start (`^`) is retried at every
 *   position.
 * The pattern is read in the mode it compiled in: without the `u` flag, `\u{3}`
 * is `u` three times, and a quantifier after an astral character repeats its
 * trail surrogate only.
 */

//#region Work

/**
 * The analysis meters its own work so that a caller can bound it (see
 * {@link analyzeRegexCost}): a unit is a node of the pattern parsed or
 * examined, a coefficient of a polynomial computed, or eight ranges of
 * character sets merged or compared (which take about as long; a unit is
 * 10 to 50 ns here). The analysis is synchronous, so one meter serves every
 * call.
 */
let workSpent = 0;
let workLimit = Infinity;

/** Thrown inside the analysis when it would do more work than it may; {@link analyzeRegexCost} catches it. */
class RegexCostWorkLimitError extends Error { }

function spend(units: number): void {
	workSpent += units;
	if (workSpent > workLimit) {
		throw new RegexCostWorkLimitError();
	}
}

//#endregion

/** Code point ranges `[lo0, hi0, lo1, hi1, …]`, sorted, disjoint and inclusive. */
type CharSet = readonly number[];

const MAX_CODE_POINT = 0x10FFFF;
const NOTHING: CharSet = [];
const ANY: CharSet = [0, MAX_CODE_POINT];
const DIGIT: CharSet = [0x30, 0x39];
const WORD: CharSet = [0x30, 0x39, 0x41, 0x5A, 0x5F, 0x5F, 0x61, 0x7A];
/** `\s`: WhiteSpace and LineTerminator of ECMA-262. */
const SPACE: CharSet = [0x09, 0x0D, 0x20, 0x20, 0xA0, 0xA0, 0x1680, 0x1680, 0x2000, 0x200A, 0x2028, 0x2029, 0x202F, 0x202F, 0x205F, 0x205F, 0x3000, 0x3000, 0xFEFF, 0xFEFF];
const LINE_TERMINATORS: CharSet = [0x0A, 0x0A, 0x0D, 0x0D, 0x2028, 0x2029];

function single(codePoint: number): CharSet {
	return [codePoint, codePoint];
}

function union(a: CharSet, b: CharSet): CharSet {
	if (!a.length) {
		return b;
	}
	if (!b.length) {
		return a;
	}
	// Merges the two sorted lists (linear time: the first sets of long alternations grow one range at a time).
	spend(1 + ((a.length + b.length) >> 4));
	const result: number[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		let lo: number;
		let hi: number;
		if (j >= b.length || (i < a.length && a[i] <= b[j])) {
			lo = a[i];
			hi = a[i + 1];
			i += 2;
		} else {
			lo = b[j];
			hi = b[j + 1];
			j += 2;
		}
		if (result.length && lo <= result[result.length - 1] + 1) {
			result[result.length - 1] = Math.max(result[result.length - 1], hi);
		} else {
			result.push(lo, hi);
		}
	}
	return result;
}

function complement(set: CharSet): CharSet {
	spend(1 + (set.length >> 4));
	const result: number[] = [];
	let next = 0;
	for (let i = 0; i < set.length; i += 2) {
		if (set[i] > next) {
			result.push(next, set[i] - 1);
		}
		next = set[i + 1] + 1;
	}
	if (next <= MAX_CODE_POINT) {
		result.push(next, MAX_CODE_POINT);
	}
	return result;
}

function intersects(a: CharSet, b: CharSet): boolean {
	spend(1 + ((a.length + b.length) >> 4));
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i + 1] < b[j]) {
			i += 2;
		} else if (b[j + 1] < a[i]) {
			j += 2;
		} else {
			return true;
		}
	}
	return false;
}

const DOT = complement(LINE_TERMINATORS);

//#region Parsing

type RegexNode =
	/** One character of the set. */
	| { readonly kind: 'char'; readonly set: CharSet }
	/** `^`, `$`, `\b` or `\B`. */
	| { readonly kind: 'assertion'; readonly start: boolean }
	/** `(?=…)`, `(?!…)` (and lookbehind, which the guard refuses before this runs). */
	| { readonly kind: 'lookaround'; readonly alternatives: readonly (readonly RegexNode[])[] }
	| { readonly kind: 'group'; readonly alternatives: readonly (readonly RegexNode[])[] }
	| { readonly kind: 'repeat'; readonly body: RegexNode; readonly min: number; readonly max: number };

/**
 * A permissive parser of ECMAScript pattern syntax into the few node kinds the
 * cost analysis needs, in the mode the pattern compiled in: with the `u` flag
 * a character is a code point, without it a UTF-16 code unit, and the escapes
 * of Annex B (`\u` that four hex digits do not follow, `\p`, legacy octal) are
 * read as that mode reads them. It never fails: what it does not understand is
 * read as a character that may be anything, which can only overestimate the
 * cost.
 */
class RegexParser {
	private i = 0;
	/** Inside a `(?i:…)` modifier group the case of characters does not matter: their sets are read as anything. */
	private ignoreCase = 0;

	constructor(private readonly source: string, private readonly unicode: boolean) { }

	parse(): (readonly RegexNode[])[] {
		const alternatives: RegexNode[][] = [];
		for (; ;) {
			alternatives.push(...this.alternatives());
			if (this.i >= this.source.length) {
				return alternatives;
			}
			this.i++; // an unbalanced `)`: a syntax error that RegExp reports
		}
	}

	private alternatives(): RegexNode[][] {
		const alternatives: RegexNode[][] = [[]];
		while (this.i < this.source.length && this.source[this.i] !== ')') {
			if (this.source[this.i] === '|') {
				this.i++;
				alternatives.push([]);
			} else {
				alternatives[alternatives.length - 1].push(this.term());
			}
		}
		return alternatives;
	}

	private term(): RegexNode {
		spend(1);
		let node = this.atom();
		for (let quantifier = this.quantifier(); quantifier; quantifier = this.quantifier()) {
			node = { kind: 'repeat', body: node, min: quantifier.min, max: quantifier.max };
		}
		return node;
	}

	private quantifier(): { min: number; max: number } | undefined {
		const ch = this.source[this.i];
		let result: { min: number; max: number } | undefined;
		if (ch === '*' || ch === '+' || ch === '?') {
			this.i++;
			result = { min: ch === '+' ? 1 : 0, max: ch === '?' ? 1 : Infinity };
		} else if (ch === '{') {
			const quantifier = /\{(\d+)(?:(,)(\d*))?\}/y;
			quantifier.lastIndex = this.i;
			const match = quantifier.exec(this.source);
			if (!match) {
				return undefined; // a literal `{` (without the `u` flag)
			}
			this.i += match[0].length;
			const min = Number(match[1]);
			result = { min, max: match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]) };
		}
		if (result && this.source[this.i] === '?') {
			this.i++; // lazy: the same splits are tried, in another order
		}
		return result;
	}

	private char(set: CharSet): RegexNode {
		return { kind: 'char', set: this.ignoreCase ? ANY : set };
	}

	private atom(): RegexNode {
		const ch = this.source[this.i];
		switch (ch) {
			case '(':
				return this.group();
			case '[':
				return this.char(this.characterClass());
			case '.':
				this.i++;
				return this.char(DOT);
			case '^':
			case '$':
				this.i++;
				return { kind: 'assertion', start: ch === '^' };
			case '\\': {
				const escape = this.escape(false);
				return escape === 'assertion' ? { kind: 'assertion', start: false } : this.char(escape);
			}
			default:
				return this.char(single(this.literal()));
		}
	}

	/** One character of the source: a code point with the `u` flag, a code unit (half of an astral character) without it. */
	private literal(): number {
		if (!this.unicode) {
			return this.source.charCodeAt(this.i++);
		}
		const codePoint = this.source.codePointAt(this.i)!;
		this.i += codePoint > 0xFFFF ? 2 : 1;
		return codePoint;
	}

	private group(): RegexNode {
		const source = this.source;
		let lookaround = false;
		let ignoreCase = false;
		if (source[this.i + 1] !== '?') {
			this.i++;
		} else if (source[this.i + 2] === ':') {
			this.i += 3;
		} else if (source[this.i + 2] === '=' || source[this.i + 2] === '!') {
			lookaround = true;
			this.i += 3;
		} else if (source[this.i + 2] === '<' && (source[this.i + 3] === '=' || source[this.i + 3] === '!')) {
			lookaround = true;
			this.i += 4;
		} else if (source[this.i + 2] === '<') {
			const end = source.indexOf('>', this.i + 3);
			this.i = end < 0 ? source.length : end + 1;
		} else {
			// Modifiers, `(?ims-ims:…)`.
			const end = source.indexOf(':', this.i + 2);
			const modifiers = end < 0 ? '' : source.slice(this.i + 2, end);
			ignoreCase = modifiers.split('-')[0].includes('i');
			this.i = end < 0 ? source.length : end + 1;
		}
		if (ignoreCase) {
			this.ignoreCase++;
		}
		const alternatives = this.alternatives();
		if (ignoreCase) {
			this.ignoreCase--;
		}
		if (source[this.i] === ')') {
			this.i++;
		}
		return lookaround ? { kind: 'lookaround', alternatives } : { kind: 'group', alternatives };
	}

	private characterClass(): CharSet {
		this.i++; // `[`
		const negated = this.source[this.i] === '^';
		if (negated) {
			this.i++;
		}
		let set: CharSet = NOTHING;
		while (this.i < this.source.length && this.source[this.i] !== ']') {
			const low = this.classAtom();
			if (this.source[this.i] === '-' && this.i + 1 < this.source.length && this.source[this.i + 1] !== ']') {
				this.i++;
				const high = this.classAtom();
				const from = singleCodePoint(low);
				const to = singleCodePoint(high);
				set = union(set, from !== undefined && to !== undefined && from <= to ? [from, to] : union(union(low, high), single(0x2D)));
			} else {
				set = union(set, low);
			}
		}
		this.i++; // `]`
		return negated ? complement(set) : set;
	}

	private classAtom(): CharSet {
		if (this.source[this.i] === '\\') {
			const escape = this.escape(true);
			return escape === 'assertion' ? ANY : escape;
		}
		return single(this.literal());
	}

	/** Reads an escape at `\`: the set of characters it matches, or `'assertion'` for `\b` and `\B` outside a class. */
	private escape(inClass: boolean): CharSet | 'assertion' {
		const source = this.source;
		this.i++; // `\`
		const ch = source[this.i];
		this.i++;
		switch (ch) {
			case 'd': return DIGIT;
			case 'D': return complement(DIGIT);
			case 'w': return WORD;
			case 'W': return complement(WORD);
			case 's': return SPACE;
			case 'S': return complement(SPACE);
			case 'b': return inClass ? single(0x08) : 'assertion';
			case 'B': return inClass ? single(0x42) : 'assertion';
			case 'n': return single(0x0A);
			case 'r': return single(0x0D);
			case 't': return single(0x09);
			case 'v': return single(0x0B);
			case 'f': return single(0x0C);
			case 'c': {
				const letter = source[this.i] ?? '';
				// A control letter; in a class without the `u` flag also a digit or `_` (Annex B).
				if (/[A-Za-z]/.test(letter) || (inClass && !this.unicode && /[0-9_]/.test(letter))) {
					this.i++;
					return single(letter.charCodeAt(0) % 32);
				}
				// Without the `u` flag, a `\` and then a `c` (Annex B); with it, a syntax error.
				this.i--;
				return single(0x5C);
			}
			case 'x': {
				const hex = /^[0-9A-Fa-f]{2}/.exec(source.slice(this.i, this.i + 2));
				if (hex) {
					this.i += 2;
					return single(parseInt(hex[0], 16));
				}
				return single(0x78);
			}
			case 'u': {
				if (this.unicode && source[this.i] === '{') {
					const end = source.indexOf('}', this.i);
					const digits = end < 0 ? '' : source.slice(this.i + 1, end);
					if (/^[0-9A-Fa-f]+$/.test(digits)) {
						this.i = end + 1;
						const codePoint = parseInt(digits, 16);
						return codePoint <= MAX_CODE_POINT ? single(codePoint) : ANY;
					}
					return ANY;
				}
				const unit = /^[0-9A-Fa-f]{4}/.exec(source.slice(this.i, this.i + 4));
				if (!unit) {
					// Without the `u` flag an identity escape: `\u{3}` is `u` three times.
					return single(0x75);
				}
				this.i += 4;
				const value = parseInt(unit[0], 16);
				const trail = this.unicode && value >= 0xD800 && value <= 0xDBFF ? /^\\u(d[c-f][0-9a-f]{2})/i.exec(source.slice(this.i, this.i + 6)) : null;
				if (trail) {
					// A surrogate pair: one code point with the `u` flag (without it, two code units, read one at a time).
					this.i += 6;
					return single(0x10000 + ((value - 0xD800) << 10) + (parseInt(trail[1], 16) - 0xDC00));
				}
				return single(value);
			}
			case 'p':
			case 'P':
				if (this.unicode && source[this.i] === '{') {
					// A Unicode property: its set is not known here.
					const end = source.indexOf('}', this.i);
					this.i = end < 0 ? source.length : end + 1;
					return ANY;
				}
				// Without the `u` flag an identity escape, and what follows is read on its own (`\p{3}` is `p` three times).
				return single(ch.charCodeAt(0));
			case 'k':
				if (source[this.i] === '<') {
					const end = source.indexOf('>', this.i);
					this.i = end < 0 ? source.length : end + 1;
				}
				return ANY;
			case undefined:
				return ANY;
			default:
				if (ch >= '0' && ch <= '9') {
					if (!this.unicode) {
						return single(this.legacyOctal(ch));
					}
					// `\0`, or a back-reference (which the guard refuses).
					return ch === '0' && !/[0-9]/.test(source[this.i] ?? '') ? single(0) : ANY;
				}
				// An identity escape; with the `u` flag a lead surrogate starts an astral character.
				this.i--;
				return single(this.literal());
		}
	}

	/**
	 * Without the `u` flag, the rest of an escape that starts with the digit
	 * `first`: a legacy octal escape (`\0`, `\12`, `\377`), or `8` or `9` (Annex
	 * B). Outside a class `\1` to `\9` may also be back-references, which the
	 * guard refuses.
	 */
	private legacyOctal(first: string): number {
		if (first === '8' || first === '9') {
			return first.charCodeAt(0);
		}
		let value = first.charCodeAt(0) - 0x30;
		const digits = first <= '3' ? 3 : 2;
		for (let count = 1; count < digits && /[0-7]/.test(this.source[this.i] ?? ''); count++) {
			value = value * 8 + this.source.charCodeAt(this.i) - 0x30;
			this.i++;
		}
		return value;
	}
}

function singleCodePoint(set: CharSet): number | undefined {
	return set.length === 2 && set[0] === set[1] ? set[0] : undefined;
}

//#endregion

//#region Polynomials

/**
 * A polynomial in the input length `n` with nonnegative coefficients: `p[i]`
 * multiplies `n^i`, with no trailing zero. One of a degree above
 * {@link MAX_DEGREE} is not kept: an `Infinity` at `MAX_DEGREE + 1` stands for
 * all of it (such a pattern is never asserted), which keeps the analysis of a
 * long pattern cheap.
 */
type Polynomial = readonly number[];

/** The highest degree the analysis keeps track of. */
export const MAX_DEGREE = 16;

const NO_STEPS: Polynomial = [];
/** `n`. */
const INPUT_LENGTH: Polynomial = [0, 1];
/** `n + 1`: the positions of the input, and the most stops of an unbounded loop. */
const POSITIONS: Polynomial = [1, 1];

function constant(value: number): Polynomial {
	return value ? [value] : NO_STEPS;
}

function normalized(p: number[]): Polynomial {
	if (p.length > MAX_DEGREE + 2) {
		p.length = MAX_DEGREE + 2;
		p[MAX_DEGREE + 1] = Infinity;
	}
	while (p.length && !p[p.length - 1]) {
		p.pop();
	}
	return p;
}

function add(a: Polynomial, b: Polynomial): Polynomial {
	if (!a.length) {
		return b;
	}
	if (!b.length) {
		return a;
	}
	spend(1 + Math.max(a.length, b.length));
	const result: number[] = [];
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		result.push((a[i] ?? 0) + (b[i] ?? 0));
	}
	return normalized(result);
}

function multiply(a: Polynomial, b: Polynomial): Polynomial {
	if (!a.length || !b.length) {
		return NO_STEPS;
	}
	spend(1 + a.length * b.length);
	const result: number[] = new Array(Math.min(a.length + b.length - 1, MAX_DEGREE + 2)).fill(0);
	for (let i = 0; i < a.length; i++) {
		for (let j = 0; j < b.length; j++) {
			if (a[i] && b[j]) { // never `0 * Infinity`
				result[Math.min(i + j, MAX_DEGREE + 1)] += i + j > MAX_DEGREE ? Infinity : a[i] * b[j];
			}
		}
	}
	return normalized(result);
}

//#endregion

//#region Cost

/** What the analysis knows about a suffix of the pattern: the part a match attempt still has to match. */
interface ISuffixCost {
	/** The characters the suffix may examine first (a lookaround's first ones included). */
	readonly first: CharSet;
	/** The suffix matches the empty string whatever the input. */
	readonly alwaysMatches: boolean;
	/** Matching the suffix ends the test: it runs to the end of the pattern, not of a lookaround or of an iteration of a loop. */
	readonly final: boolean;
	/** The steps an attempt takes when the character at its position is not one of {@link first}. */
	readonly failFast: number;
	/** A bound on the steps of one attempt to match the suffix (what an attempt that ends the test takes is in {@link IAnalysis.once}). */
	readonly steps: Polynomial;
}

/** The end of the pattern: reaching it ends the test. */
const END: ISuffixCost = { first: NOTHING, alwaysMatches: true, final: true, failFast: 0, steps: NO_STEPS };
/** The end of a lookaround's body, or of one iteration of a loop's body: the match goes on after it. */
const INNER_END: ISuffixCost = { first: NOTHING, alwaysMatches: true, final: false, failFast: 0, steps: NO_STEPS };

/**
 * A loop that may repeat this often or more (or give back this many
 * iterations) is counted as one that may repeat as often as the input is
 * long: `min(count, n) <= n`.
 */
const LONG_LOOP = 32;

interface IAnalysis {
	/**
	 * The steps of what at most one attempt per test takes: the loops of the
	 * attempt that succeeds and so ends the test (an unanchored `\d+` scans
	 * its digits once, not at every position).
	 */
	once: Polynomial;
}

interface IScope {
	readonly analysis: IAnalysis;
	/**
	 * The cost of one iteration of a repeated group's body is wanted: the
	 * iterations together consume at most the input, so the loops of the body
	 * are counted with their own (constant) counts.
	 */
	readonly inRepeatedBody: boolean;
}

function sequenceCost(nodes: readonly RegexNode[], next: ISuffixCost, scope: IScope): ISuffixCost {
	let cost = next;
	for (let i = nodes.length - 1; i >= 0; i--) {
		cost = nodeCost(nodes[i], cost, scope);
	}
	return cost;
}

/** Alternatives are tried in turn: every one of them may run its part and the rest of the pattern. */
function alternativesCost(alternatives: readonly (readonly RegexNode[])[], next: ISuffixCost, scope: IScope): ISuffixCost {
	if (alternatives.length === 1) {
		return sequenceCost(alternatives[0], next, scope);
	}
	let first = NOTHING;
	let alwaysMatches = false;
	let failFast = 0;
	let steps = NO_STEPS;
	for (const alternative of alternatives) {
		const cost = sequenceCost(alternative, next, scope);
		first = union(first, cost.first);
		alwaysMatches ||= cost.alwaysMatches;
		failFast += cost.failFast;
		steps = add(steps, cost.steps);
	}
	return { first, alwaysMatches, final: next.final, failFast, steps };
}

function nodeCost(node: RegexNode, next: ISuffixCost, scope: IScope): ISuffixCost {
	spend(1);
	switch (node.kind) {
		case 'char':
			return { first: node.set, alwaysMatches: false, final: next.final, failFast: 1, steps: add(constant(1), next.steps) };
		case 'assertion':
			return { first: next.first, alwaysMatches: false, final: next.final, failFast: 1 + next.failFast, steps: add(constant(1), next.steps) };
		case 'lookaround': {
			// Its body is matched on its own at every arrival (and never backtracked into) before the rest.
			const body = alternativesCost(node.alternatives, INNER_END, { analysis: scope.analysis, inRepeatedBody: false });
			return { first: union(body.first, next.first), alwaysMatches: false, final: next.final, failFast: body.failFast + next.failFast, steps: add(add(constant(1), body.steps), next.steps) };
		}
		case 'group':
			return alternativesCost(node.alternatives, next, scope);
		case 'repeat':
			return repeatCost(node.body, node.min, node.max, next, scope);
	}
}

/** The fewest characters one match of a node consumes. */
function minLength(node: RegexNode): number {
	spend(1);
	switch (node.kind) {
		case 'char':
			return 1;
		case 'assertion':
		case 'lookaround':
			return 0;
		case 'group': {
			let shortest = Infinity;
			for (const alternative of node.alternatives) {
				let length = 0;
				for (const child of alternative) {
					length += minLength(child);
				}
				shortest = Math.min(shortest, length);
			}
			return shortest;
		}
		case 'repeat':
			return node.min && node.min * minLength(node.body);
	}
}

/**
 * The number of ways one iteration of a loop's body can match. The guard only
 * lets a group repeat more than once when its length is fixed or bounded (no
 * unbounded loop and no alternatives inside), so that number is finite and
 * small.
 */
function choicesOf(node: RegexNode): number {
	spend(1);
	switch (node.kind) {
		case 'char':
		case 'assertion':
		case 'lookaround':
			return 1;
		case 'group': {
			let total = 0;
			for (const alternative of node.alternatives) {
				let product = 1;
				for (const child of alternative) {
					product *= choicesOf(child);
				}
				total += product;
			}
			return total;
		}
		case 'repeat': {
			const counts = node.max - node.min + 1;
			return choicesOf(node.body) ** Math.min(node.max, 64) * counts;
		}
	}
}

/**
 * The most iterations one arrival at a loop matches when it may repeat `count`
 * times: each consumes at least `bodyLength` characters, so a long loop runs at
 * most `n / bodyLength` of them. A body that may match nothing still runs its
 * `min` iterations, and then stops at the first that matches nothing.
 */
function iterationBound(count: number, min: number, bodyLength: number, scope: IScope): Polynomial {
	if (bodyLength === 0) {
		const rest = count - min;
		return add(constant(min), rest >= LONG_LOOP ? INPUT_LENGTH : constant(rest));
	}
	if (count >= LONG_LOOP && (!scope.inRepeatedBody || count === Infinity)) {
		return [0, 1 / bodyLength];
	}
	return constant(count);
}

function repeatCost(body: RegexNode, min: number, max: number, next: ISuffixCost, scope: IScope): ISuffixCost {
	if (max === 0) {
		return next;
	}
	if (max === 1) {
		const once = nodeCost(body, next, scope);
		if (min === 1) {
			return once;
		}
		// Optional: with the body, then without it.
		return { first: union(once.first, next.first), alwaysMatches: once.alwaysMatches || next.alwaysMatches, final: next.final, failFast: once.failFast + next.failFast, steps: add(once.steps, next.steps) };
	}
	// One iteration on its own, then the loop goes on: the cost of each, and what it may examine first.
	const iteration = nodeCost(body, INNER_END, { analysis: scope.analysis, inRepeatedBody: true });
	const bodyLength = minLength(body);
	const emptyIteration = bodyLength === 0;
	const first = min === 0 || emptyIteration ? union(iteration.first, next.first) : iteration.first;
	const alwaysMatches = (min === 0 || iteration.alwaysMatches) && next.alwaysMatches;
	const failFast = iteration.failFast + (min === 0 || emptyIteration ? next.failFast : 0);

	// The ways the iterations can split a match (the guard allows more than one only for a short loop): backtracking
	// tries them all, and a tree of them is at most twice as large as its leaves.
	const choices = choicesOf(body);
	const variations = choices === 1 ? 1 : choices ** max;
	const scan = (count: number) => choices === 1
		? multiply(iterationBound(count, min, bodyLength, scope), iteration.steps)
		: multiply(constant(2 * variations), iteration.steps);

	if (next.alwaysMatches) {
		// The loop is not given back: the rest matches after the greedy iterations.
		if (next.final) {
			// The arrival that matches `min` iterations ends the test (once); the others fail before.
			scope.analysis.once = add(scope.analysis.once, add(scan(max), next.steps));
			return { first, alwaysMatches, final: true, failFast, steps: scan(Math.max(min, 1)) };
		}
		return { first, alwaysMatches, final: false, failFast, steps: add(scan(max), next.steps) };
	}
	// Each give-back hands the rest of the pattern the start of an iteration: when the rest cannot start with
	// such a character (and no iteration may be empty), it fails at its first examination, and only the
	// arrival after the last iteration runs it.
	const rest = max - min;
	const stops = rest >= LONG_LOOP && (!scope.inRepeatedBody || rest === Infinity) ? [1, 1 / Math.max(bodyLength, 1)] : constant(rest + 1);
	const ambiguous = emptyIteration || intersects(iteration.first, next.first);
	const tries = ambiguous ? multiply(stops, next.steps) : add(multiply(stops, constant(next.failFast)), next.steps);
	return { first, alwaysMatches, final: next.final, failFast, steps: add(scan(max), multiply(constant(variations), tries)) };
}

//#endregion

export interface IRegexCost {
	/**
	 * The degree, in the length of the input, of the polynomial that bounds the
	 * steps of one test: 0 for a test that takes a constant time, 1 for one
	 * whose time grows linearly, `Infinity` for one above {@link MAX_DEGREE}.
	 */
	readonly degree: number;
	/** That polynomial: `coefficients[i]` multiplies the input length to the power `i`. */
	readonly coefficients: readonly number[];
}

/** The bound on the steps of one test of an input of `inputLength` characters. */
export function regexStepBound(cost: IRegexCost, inputLength: number): number {
	let steps = 0;
	let power = 1;
	for (const coefficient of cost.coefficients) {
		if (coefficient && power) { // never `Infinity * 0`
			steps += coefficient * power;
		}
		power *= inputLength;
	}
	return steps;
}

/** The characters that loops (repetitions that may match more than once) can consume. */
function loopCharacters(nodes: readonly RegexNode[], inLoop: boolean): CharSet {
	let set = NOTHING;
	for (const node of nodes) {
		spend(1);
		switch (node.kind) {
			case 'char':
				if (inLoop) {
					set = union(set, node.set);
				}
				break;
			case 'assertion':
				break;
			case 'lookaround':
			case 'group':
				for (const alternative of node.alternatives) {
					set = union(set, loopCharacters(alternative, inLoop));
				}
				break;
			case 'repeat':
				set = union(set, loopCharacters([node.body], inLoop || node.max > 1));
				break;
		}
	}
	return set;
}

/**
 * Bounds the backtracking steps of one test of a pattern the guard accepts
 * (see the description of this file), read as compiled with the `u` flag or
 * without it.
 */
export function estimateRegexCost(source: string, unicode: boolean): IRegexCost {
	return analyzeRegexCost(source, unicode)!.cost;
}

export interface IRegexCostAnalysis {
	readonly cost: IRegexCost;
	/** The work the analysis took (in the units of the meter at the top of this file); the same for the same pattern and mode. */
	readonly work: number;
}

/**
 * {@link estimateRegexCost} that stops once it has done `maxWork` units of
 * work: undefined then. The analysis of a pattern of 4096 characters takes up
 * to about 25 ms (some 850 000 units), so a caller that analyzes many of them
 * bounds their total.
 */
export function analyzeRegexCost(source: string, unicode: boolean, maxWork = Infinity): IRegexCostAnalysis | undefined {
	workSpent = 0;
	workLimit = maxWork;
	try {
		const cost = computeRegexCost(source, unicode);
		return { cost, work: workSpent };
	} catch (error) {
		if (error instanceof RegexCostWorkLimitError) {
			return undefined;
		}
		throw error;
	} finally {
		workSpent = 0;
		workLimit = Infinity;
	}
}

function computeRegexCost(source: string, unicode: boolean): IRegexCost {
	const alternatives = new RegexParser(source, unicode).parse();
	const analysis: IAnalysis = { once: NO_STEPS };
	const cost = alternativesCost(alternatives, END, { analysis, inRepeatedBody: false });
	const anchored = alternatives.every(alternative => alternative[0]?.kind === 'assertion' && alternative[0].start);
	// An unanchored search starts an attempt at every position, and the attempts may scan the same characters
	// again; unless every attempt starts with a character no loop consumes (`\(a+\)`): then the attempts that
	// get past their first character scan different stretches of the input with their loops (their constant
	// part is still paid at every position).
	const loops = loopCharacters(alternatives.flat(), false);
	const delimited = alternatives.every(alternative => alternative[0]?.kind === 'char' && !intersects(alternative[0].set, loops));
	let steps: Polynomial;
	if (anchored) {
		steps = cost.steps;
	} else if (delimited) {
		steps = add(multiply(POSITIONS, constant((cost.steps[0] ?? 0) + cost.failFast)), [0, ...cost.steps.slice(1)]);
	} else {
		steps = multiply(POSITIONS, cost.steps);
	}
	steps = add(steps, analysis.once);
	return { degree: steps.length > MAX_DEGREE + 1 ? Infinity : Math.max(steps.length - 1, 0), coefficients: steps };
}
