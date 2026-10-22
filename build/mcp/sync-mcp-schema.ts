/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generates src/vs/platform/mcp/common/modelContextProtocol.ts (the `MCP` namespace) from the
// upstream Model Context Protocol `schema.ts` for the revision pinned below. The upstream file is
// vendored verbatim at build/mcp/mcp-schema-2026-07-28.ts so the generation is hermetic.
//
// Usage:
//   node build/mcp/sync-mcp-schema.ts [--source <schema.ts>]
//       Regenerate the namespace file in place.
//
//   node build/mcp/sync-mcp-schema.ts --check [--source <schema.ts>]
//       Regenerate in memory and compare with the committed file. Exit 1 on drift.
//
//   node build/mcp/sync-mcp-schema.ts --check --if-changed [--base <ref>]
//       CI mode: only run the check when the diff against `--base` (default origin/main)
//       touches the generator inputs or the generated file.
//
// Transformations applied to the upstream source:
//   1. 2-space indentation becomes tabs and the whole body is nested one level inside
//      `export namespace MCP { ... }`.
//   2. The Microsoft header, the eslint pragma and the hand-maintained `//#region proposals`
//      block of the existing file are preserved.
//   3. The result is formatted with the repository's tsfmt.json settings.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from '../lib/formatter.ts';

export const UPSTREAM_REPO = 'modelcontextprotocol/modelcontextprotocol';
export const UPSTREAM_COMMIT = '046fa30efd374370afb87ef830bd788eac5f217e';
export const UPSTREAM_REVISION = '2026-07-28';
export const UPSTREAM_PATH = `schema/${UPSTREAM_REVISION}/schema.ts`;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_SOURCE = path.join(REPO_ROOT, 'build', 'mcp', `mcp-schema-${UPSTREAM_REVISION}.ts`);
export const DEST = path.join(REPO_ROOT, 'src', 'vs', 'platform', 'mcp', 'common', 'modelContextProtocol.ts');

const toPosix = (p: string): string => p.split(path.sep).join('/');
const DEST_REL = toPosix(path.relative(REPO_ROOT, DEST));
const DEFAULT_SOURCE_REL = toPosix(path.relative(REPO_ROOT, DEFAULT_SOURCE));
const GENERATOR_REL = 'build/mcp/sync-mcp-schema.ts';
const FORMATTER_REL = 'build/lib/formatter.ts';
const TSFMT_REL = 'tsfmt.json';

/** Repo-relative paths whose change must keep the generated file in sync (the formatter shapes the output too). */
export const GENERATOR_INPUTS: readonly string[] = [DEST_REL, DEFAULT_SOURCE_REL, GENERATOR_REL, FORMATTER_REL, TSFMT_REL];

const COPYRIGHT_HEADER = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/`;

const ESLINT_PRAGMA = '/* eslint-disable local/code-no-unexternalized-strings */';

const PROPOSALS_START = '//#region proposals';
const PROPOSALS_END = '//#endregion';

export const DEFAULT_PROPOSALS_REGION = `${PROPOSALS_START}
/**
 * MCP protocol proposals.
 * - Proposals here MUST have an MCP PR linked to them
 * - Proposals here are subject to change and SHALL be removed when
 *   the upstream MCP PR is merged or closed.
 */
export namespace MCP {

	// Nothing, yet

}

${PROPOSALS_END}`;

/**
 * Extracts the hand-maintained proposals region (inclusive of its markers) from an existing
 * generated file. Falls back to the default empty region when the file has none.
 */
export function readProposalsRegion(existing: string | undefined): string {
	if (!existing) {
		return DEFAULT_PROPOSALS_REGION;
	}
	const text = existing.replace(/\r\n/g, '\n');
	const start = text.indexOf(PROPOSALS_START);
	if (start === -1) {
		return DEFAULT_PROPOSALS_REGION;
	}
	// Nested regions inside the proposals block are not supported; the first
	// closing marker after the start ends the region. A missing marker is a
	// corrupted file, never silently replaced by the empty default.
	const end = text.indexOf(PROPOSALS_END, start);
	if (end === -1) {
		throw new Error(`Unbalanced '${PROPOSALS_START}' block in ${DEST_REL}: no '${PROPOSALS_END}' follows it.`);
	}
	return text.substring(start, end + PROPOSALS_END.length);
}

/**
 * ESLint rules VS Code enables, for which an upstream `eslint-disable-next-line`
 * directive is meaningful. Directives for any other rule would be reported as
 * unused by the repository's lint gate and are dropped.
 */
const KEPT_ESLINT_DIRECTIVE_RULES: ReadonlySet<string> = new Set(['@typescript-eslint/no-explicit-any']);

const ESLINT_DIRECTIVE = /^\s*\/\/\s*eslint-disable-next-line\s+(.+?)\s*$/;

/** True when an upstream line is an eslint directive the generated file must not carry. */
export function isDroppedEslintDirective(line: string): boolean {
	const match = ESLINT_DIRECTIVE.exec(line);
	if (!match) {
		return false;
	}
	const rules = match[1].split(',').map(rule => rule.trim()).filter(Boolean);
	return !rules.every(rule => KEPT_ESLINT_DIRECTIVE_RULES.has(rule));
}

/** Converts leading 2-space indentation to tabs (a leftover odd space is kept). */
export function convertIndentation(line: string): string {
	const match = line.match(/^( +)/);
	if (!match) {
		return line;
	}
	const spaces = match[1].length;
	return '\t'.repeat(Math.floor(spaces / 2)) + ' '.repeat(spaces % 2) + line.slice(spaces);
}

/**
 * Produces the full contents of the generated namespace file from the upstream schema source.
 * The output uses `\n` line endings; git normalizes them on checkout.
 */
export function generateMcpNamespace(upstreamSource: string, proposalsRegion: string): string {
	const bodyLines = upstreamSource
		.replace(/\r\n/g, '\n')
		.replace(/\s+$/, '')
		.split('\n')
		.filter(line => !isDroppedEslintDirective(line))
		.map(line => line.replace(/\s+$/, ''))
		.map(line => (line.length === 0 ? '' : '\t' + convertIndentation(line)));

	const banner = `/**
 * Schema generated from the Model Context Protocol repository at
 * https://github.com/${UPSTREAM_REPO}/blob/${UPSTREAM_COMMIT}/${UPSTREAM_PATH}
 *
 * DO NOT EDIT within the namespace below. Regenerate with \`npm run mcp:sync-schema\`;
 * CI verifies the file with \`npm run mcp:check-schema\`.
 */`;

	const raw = [
		COPYRIGHT_HEADER,
		'',
		ESLINT_PRAGMA,
		'',
		proposalsRegion.replace(/\r\n/g, '\n'),
		'',
		banner,
		'export namespace MCP {',
		...bodyLines,
		'}',
		'',
	].join('\n');

	return format(DEST, raw).replace(/\r\n/g, '\n');
}

export interface ISyncArgs {
	readonly source: string;
	readonly check: boolean;
	readonly ifChanged: boolean;
	readonly base: string;
	readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): ISyncArgs {
	let source = DEFAULT_SOURCE;
	let check = false;
	let ifChanged = false;
	let base = 'origin/main';
	let help = false;
	const valueOf = (flag: string, index: number): string => {
		const value = argv[index];
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`Missing value for ${flag}`);
		}
		return value;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--source':
				source = path.resolve(valueOf(arg, ++i));
				break;
			case '--check':
				check = true;
				break;
			case '--if-changed':
				ifChanged = true;
				break;
			case '--base':
				base = valueOf(arg, ++i);
				break;
			case '--help':
			case '-h':
				help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { source, check, ifChanged, base, help };
}

/** Filters changed repo-relative paths down to the generator inputs. */
export function filterGeneratorInputs(changedPaths: readonly string[]): string[] {
	return changedPaths.filter(p => GENERATOR_INPUTS.includes(p));
}

/**
 * The refspec that makes `baseRef` available after a shallow fetch: a
 * remote-tracking name like `origin/main` is fetched as the remote branch
 * into the same remote-tracking ref; anything else (a SHA, a tag, a local
 * branch name) is fetched as given.
 */
export function fetchRefspecFor(baseRef: string): string {
	const match = /^origin\/(.+)$/.exec(baseRef);
	return match ? `+refs/heads/${match[1]}:refs/remotes/origin/${match[1]}` : baseRef;
}

/** Returns the generator inputs changed between `baseRef` and HEAD. */
export function changedInputs(baseRef: string): string[] {
	const run = () => spawnSync('git', ['diff', '--name-only', baseRef, 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
	let r = run();
	if (r.status !== 0) {
		// The base commit may be absent in a shallow CI checkout; fetch it once, then retry.
		spawnSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', fetchRefspecFor(baseRef)], { cwd: REPO_ROOT, encoding: 'utf8' });
		r = run();
		if (r.status !== 0) {
			throw new Error(`git diff against '${baseRef}' failed:\n${r.stderr}`);
		}
	}
	return filterGeneratorInputs(r.stdout.split('\n').map(s => s.trim()).filter(Boolean));
}

function usage(): string {
	return [
		'Usage: node build/mcp/sync-mcp-schema.ts [--source <schema.ts>] [--check] [--if-changed] [--base <ref>]',
		'',
		`  Regenerates ${DEST_REL} from the upstream MCP schema (${UPSTREAM_REPO}@${UPSTREAM_COMMIT.slice(0, 8)}, ${UPSTREAM_PATH}).`,
		`  --source      Upstream schema.ts to read (default: ${DEFAULT_SOURCE_REL}).`,
		'  --check       Do not write; exit 1 when the committed file differs from the generated output.',
		'  --if-changed  With --check: skip unless the diff against --base touches the generator inputs.',
		'  --base <ref>  Base ref for --if-changed (default: origin/main).',
	].join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(usage());
		return 0;
	}

	if (args.ifChanged) {
		const changed = changedInputs(args.base);
		if (changed.length === 0) {
			console.log(`sync-mcp-schema: no generator inputs changed against ${args.base}; skipping.`);
			return 0;
		}
		console.log(`sync-mcp-schema: inputs changed: ${changed.join(', ')}`);
	}

	if (!existsSync(args.source)) {
		console.error(`sync-mcp-schema: source not found: ${args.source}`);
		return 1;
	}

	const upstream = readFileSync(args.source, 'utf8');
	const existing = existsSync(DEST) ? readFileSync(DEST, 'utf8') : undefined;
	const generated = generateMcpNamespace(upstream, readProposalsRegion(existing));

	if (args.check) {
		const normalizedExisting = (existing ?? '').replace(/\r\n/g, '\n');
		if (normalizedExisting === generated) {
			console.log(`sync-mcp-schema: ${DEST_REL} is in sync.`);
			return 0;
		}
		console.error(`sync-mcp-schema: ${DEST_REL} is out of date. Run \`npm run mcp:sync-schema\` and commit the result.`);
		return 1;
	}

	if (existing !== undefined && existing.replace(/\r\n/g, '\n') === generated) {
		console.log(`sync-mcp-schema: ${DEST_REL} already up to date.`);
		return 0;
	}
	writeFileSync(DEST, generated, 'utf8');
	console.log(`sync-mcp-schema: wrote ${DEST_REL}.`);
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		code => process.exit(code),
		err => {
			console.error(err instanceof Error ? err.stack ?? err.message : String(err));
			process.exit(1);
		},
	);
}
