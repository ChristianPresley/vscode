/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Converts `docs/spec/requirements.zon` of zig-sdk (the normative sentences
 * of the MCP specification, one per entry) to
 * `test/mcp-conformance/requirements-<revision>.json`.
 *
 *   node test/mcp-conformance/tools/convert-requirements.ts [--zig-sdk <checkout>] [--commit <rev>]
 *
 * The file is read from the checkout's git history at `--commit` (default
 * `HEAD`), so the result does not depend on the working tree of the checkout.
 * `run.ts check-matrix` converts the commit the JSON names again and fails when
 * the result differs from the committed file.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #region ZON

/** An enum literal of a ZON document (`.must`). */
export class ZonEnum {
	readonly name: string;
	constructor(name: string) {
		this.name = name;
	}
}

export type ZonValue = string | number | ZonEnum | readonly ZonValue[] | { readonly [field: string]: ZonValue };

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/**
 * Parses the subset of ZON that the zig-sdk extraction writes: structs
 * (`.{ .field = value, … }`), tuples (`.{ value, … }`), string literals, enum
 * literals, decimal integers and `//` comments.
 *
 * A Zig string literal is a sequence of bytes: `\xNN` is one byte, and
 * consecutive escapes form one UTF-8 sequence (`\xe2\x80\x94` is an em dash),
 * so a literal is collected as bytes and decoded as UTF-8 at its end.
 */
export function parseZon(text: string): ZonValue {
	let index = 0;

	const fail = (message: string): never => {
		const line = text.slice(0, index).split('\n').length;
		throw new Error(`requirements.zon:${line}: ${message}`);
	};

	const skip = () => {
		for (; ;) {
			while (index < text.length && /\s/.test(text[index])) {
				index++;
			}
			if (text.startsWith('//', index)) {
				const end = text.indexOf('\n', index);
				index = end === -1 ? text.length : end + 1;
			} else {
				return;
			}
		}
	};

	const identifier = (): string => {
		const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index, index + 256));
		if (!match) {
			fail('expected an identifier');
		}
		index += match![0].length;
		return match![0];
	};

	const string = (): string => {
		index++; // the opening quote
		const bytes: number[] = [];
		for (; ;) {
			if (index >= text.length || text[index] === '\n') {
				fail('unterminated string literal');
			}
			const char = text[index];
			if (char === '"') {
				index++;
				break;
			}
			if (char !== '\\') {
				const codePoint = text.codePointAt(index)!;
				const encoded = String.fromCodePoint(codePoint);
				bytes.push(...encoder.encode(encoded));
				index += encoded.length;
				continue;
			}
			const escape = text[index + 1];
			index += 2;
			switch (escape) {
				case 'n': bytes.push(0x0a); break;
				case 'r': bytes.push(0x0d); break;
				case 't': bytes.push(0x09); break;
				case '\\': bytes.push(0x5c); break;
				case '\'': bytes.push(0x27); break;
				case '"': bytes.push(0x22); break;
				case 'x': {
					const hex = text.slice(index, index + 2);
					if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
						fail(`invalid \\x escape \\x${hex}`);
					}
					bytes.push(parseInt(hex, 16));
					index += 2;
					break;
				}
				case 'u': {
					const match = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(index, index + 8));
					if (!match) {
						fail('invalid \\u escape');
					}
					bytes.push(...encoder.encode(String.fromCodePoint(parseInt(match![1], 16))));
					index += match![0].length;
					break;
				}
				default:
					fail(`unknown escape \\${escape}`);
			}
		}
		try {
			return utf8.decode(new Uint8Array(bytes));
		} catch {
			return fail('a string literal is not valid UTF-8');
		}
	};

	const value = (): ZonValue => {
		skip();
		const char = text[index];
		if (char === '"') {
			return string();
		}
		if (/[-0-9]/.test(char ?? '')) {
			const match = /^-?\d+/.exec(text.slice(index, index + 32));
			if (!match) {
				fail('expected a number');
			}
			index += match![0].length;
			return Number(match![0]);
		}
		if (char !== '.') {
			return fail(`unexpected ${char === undefined ? 'end of input' : JSON.stringify(char)}`);
		}
		index++;
		if (text[index] !== '{') {
			return new ZonEnum(identifier());
		}
		index++;
		skip();
		if (text[index] === '}') {
			index++;
			return [];
		}
		// a struct when the first item is `.name =`, a tuple otherwise
		const isStruct = /^\.[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text.slice(index, index + 256));
		const fields: Record<string, ZonValue> = {};
		const items: ZonValue[] = [];
		for (; ;) {
			skip();
			if (text[index] === '}') {
				index++;
				break;
			}
			if (isStruct) {
				if (text[index] !== '.') {
					fail('expected a field');
				}
				index++;
				const name = identifier();
				skip();
				if (text[index] !== '=') {
					fail(`expected = after .${name}`);
				}
				index++;
				if (Object.prototype.hasOwnProperty.call(fields, name)) {
					fail(`.${name} is set twice`);
				}
				fields[name] = value();
			} else {
				items.push(value());
			}
			skip();
			if (text[index] === ',') {
				index++;
			} else if (text[index] !== '}') {
				fail('expected , or }');
			}
		}
		return isStruct ? fields : items;
	};

	const result = value();
	skip();
	if (index !== text.length) {
		fail('unexpected text after the document');
	}
	return result;
}

// #endregion

// #region conversion

/** Where the requirements come from: the zig-sdk release whose extraction they are. */
export interface IRequirementsSource {
	readonly version: string;
	readonly commit: string;
}

export const ZIG_SDK = {
	name: 'ChristianPresley/zig-sdk',
	repo: 'https://github.com/ChristianPresley/zig-sdk',
	path: 'docs/spec/requirements.zon',
	license: 'Apache-2.0',
} as const;

const LEVELS = ['must', 'must_not', 'should', 'should_not', 'may'];
const PARTIES = ['client', 'server', 'both', 'authorization_server'];

function isFields(value: ZonValue | undefined): value is { readonly [field: string]: ZonValue } {
	return typeof value === 'object' && !Array.isArray(value) && !(value instanceof ZonEnum);
}

function stringField(entry: { readonly [field: string]: ZonValue }, field: string, where: string): string {
	const value = entry[field];
	if (typeof value !== 'string') {
		throw new Error(`${where}: .${field} must be a string`);
	}
	return value;
}

function enumField(entry: { readonly [field: string]: ZonValue }, field: string, allowed: readonly string[], where: string): string {
	const value = entry[field];
	if (!(value instanceof ZonEnum) || !allowed.includes(value.name)) {
		throw new Error(`${where}: .${field} must be one of ${allowed.map(name => `.${name}`).join(', ')}`);
	}
	return value.name;
}

/** The specification revision of a requirements document, from the last segment of its `.path` (`docs/specification/2026-07-28`). */
export function requirementsRevision(path: string): string {
	const revision = path.split('/').pop() ?? '';
	if (!/^\d{4}-\d{2}-\d{2}$/.test(revision)) {
		throw new Error(`.path ${path} does not end in a specification revision`);
	}
	return revision;
}

/** Converts the text of `requirements.zon` to the object of `requirements-<revision>.json`; field order and values are exactly the extraction's. */
export function convertRequirements(zonText: string, source: IRequirementsSource): Record<string, unknown> {
	const document = parseZon(zonText);
	if (!isFields(document)) {
		throw new Error('requirements.zon is not a struct');
	}
	const header = (field: string) => stringField(document, field, 'requirements.zon');
	const specPath = header('path');
	const revision = requirementsRevision(specPath);
	const entries = document.requirements;
	if (!Array.isArray(entries)) {
		throw new Error('requirements.zon: .requirements must be a tuple');
	}
	const ids = new Set<string>();
	const requirements = entries.map((entry: ZonValue, index: number) => {
		if (!isFields(entry)) {
			throw new Error(`requirements.zon: requirement ${index} is not a struct`);
		}
		const id = stringField(entry, 'id', `requirement ${index}`);
		if (ids.has(id)) {
			throw new Error(`requirements.zon: ${id} is listed twice`);
		}
		ids.add(id);
		const line = entry.line;
		const keywords = entry.keywords;
		if (typeof line !== 'number' || !Array.isArray(keywords) || keywords.some((keyword: ZonValue) => typeof keyword !== 'string')) {
			throw new Error(`requirements.zon: ${id} needs a .line number and a tuple of .keywords strings`);
		}
		return {
			id,
			page: stringField(entry, 'page', id),
			line,
			section: stringField(entry, 'section', id),
			anchor: stringField(entry, 'anchor', id),
			level: enumField(entry, 'level', LEVELS, id),
			keywords: [...keywords as readonly string[]],
			party: enumField(entry, 'party', PARTIES, id),
			text: stringField(entry, 'text', id),
		};
	});
	return {
		$comment: `The normative sentences of the MCP ${revision} specification, one entry per sentence: id, page, line, section, anchor, level (must, must_not, should, should_not, may), the RFC 2119 keywords, party (client, server, both, authorization_server) and the quoted text. Generated by node test/mcp-conformance/tools/convert-requirements.ts from ${ZIG_SDK.path} of ${ZIG_SDK.name} at the commit in source (${ZIG_SDK.license}); do not edit by hand. The quoted sentences are from the specification pages at the commit in specification. requirement-tests.json maps every id; node test/mcp-conformance/run.ts check-matrix checks both files, and that this file is what the converter produces from the commit in source when a zig-sdk checkout is available.`,
		revision,
		source: {
			name: ZIG_SDK.name,
			repo: ZIG_SDK.repo,
			version: source.version,
			commit: source.commit,
			path: ZIG_SDK.path,
			license: ZIG_SDK.license,
		},
		specification: {
			repo: header('repo'),
			commit: header('commit'),
			path: specPath,
			license: 'MIT AND Apache-2.0',
			site: `https://modelcontextprotocol.io/specification/${revision}`,
		},
		requirements,
	};
}

/** The text of the JSON file: tab-indented, with a final newline. */
export function formatRequirementsJson(converted: Record<string, unknown>): string {
	return JSON.stringify(converted, undefined, '\t') + '\n';
}

// #endregion

// #region zig-sdk checkout

/** The zig-sdk checkout: `ZIG_SDK_DIR`, else `zig-sdk` next to the repository. */
export function zigSdkCheckout(root: string, env: Readonly<Record<string, string | undefined>>): string {
	return env.ZIG_SDK_DIR ? path.resolve(env.ZIG_SDK_DIR) : path.resolve(root, '..', 'zig-sdk');
}

type GitFn = (cwd: string, args: readonly string[]) => { readonly status: number | null; readonly stdout: Buffer };

const defaultGit: GitFn = (cwd, args) => {
	const result = spawnSync('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
	return { status: result.error ? null : result.status, stdout: result.stdout ?? Buffer.alloc(0) };
};

export type ZonRead = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'unavailable'; readonly reason: string };

/** `requirements.zon` at a commit of the checkout (read-only `git show`), or why it cannot be read. */
export function readZonAtCommit(checkout: string, commit: string, git: GitFn = defaultGit): ZonRead {
	const shown = git(checkout, ['show', `${commit}:${ZIG_SDK.path}`]);
	if (shown.status !== 0) {
		return { kind: 'unavailable', reason: `${checkout} is not a zig-sdk checkout with commit ${commit}` };
	}
	try {
		return { kind: 'text', text: utf8.decode(shown.stdout) };
	} catch {
		return { kind: 'unavailable', reason: `${ZIG_SDK.path} at ${commit} is not valid UTF-8` };
	}
}

// #endregion

// #region main

function main(argv: readonly string[]): number {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const harness = path.resolve(here, '..');
	const root = path.resolve(harness, '..', '..');
	let checkout = zigSdkCheckout(root, process.env);
	let commit = 'HEAD';
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--zig-sdk' && argv[i + 1] !== undefined) {
			checkout = path.resolve(argv[++i]);
		} else if (argv[i] === '--commit' && argv[i + 1] !== undefined) {
			commit = argv[++i];
		} else {
			console.error('Usage: node test/mcp-conformance/tools/convert-requirements.ts [--zig-sdk <checkout>] [--commit <rev>]');
			return 2;
		}
	}
	const resolved = defaultGit(checkout, ['rev-parse', `${commit}^{commit}`]);
	if (resolved.status !== 0) {
		console.error(`${checkout} has no commit ${commit}`);
		return 1;
	}
	const sha = resolved.stdout.toString('utf8').trim();
	const tag = defaultGit(checkout, ['describe', '--tags', '--exact-match', sha]);
	const zon = readZonAtCommit(checkout, sha);
	if (zon.kind === 'unavailable') {
		console.error(zon.reason);
		return 1;
	}
	const converted = convertRequirements(zon.text, { version: tag.status === 0 ? tag.stdout.toString('utf8').trim() : sha, commit: sha });
	const target = path.join(harness, `requirements-${String(converted.revision)}.json`);
	writeFileSync(target, formatRequirementsJson(converted));
	console.log(`wrote ${path.relative(root, target)}: ${(converted.requirements as unknown[]).length} requirements from ${ZIG_SDK.path} at ${sha}`);
	return 0;
}

function isEntryPoint(): boolean {
	if (process.argv[1] === undefined) {
		return false;
	}
	const invoked = path.resolve(process.argv[1]);
	const self = fileURLToPath(import.meta.url);
	return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

if (isEntryPoint()) {
	process.exitCode = main(process.argv.slice(2));
}

// #endregion
