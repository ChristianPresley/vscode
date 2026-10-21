/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runs the official MCP conformance suite (`@modelcontextprotocol/conformance`)
 * against VS Code. The client leg has the suite spawn
 * `out/vs/workbench/api/node/mcpConformanceClientMain.js` for every client
 * scenario; the server leg points the suite at the MCP gateway fixture
 * `out/vs/platform/mcp/node/mcpGatewayConformanceMain.js`. See README.md.
 *
 *   node test/mcp-conformance/run.ts client|server|all|check-matrix|render-matrix [options]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, parseDocument } from 'yaml';
import { convertRequirements, readZonAtCommit, ZIG_SDK, zigSdkCheckout, type ZonRead } from './tools/convert-requirements.ts';

export const REVISIONS = ['2026-07-28', '2025-11-25'] as const;
export type Revision = typeof REVISIONS[number];
export type Leg = 'client' | 'server';
export type Subcommand = 'client' | 'server' | 'all' | 'check-matrix' | 'render-matrix';
export type Env = Readonly<Record<string, string | undefined>>;

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const SUITE_DIR = path.join(HERE, 'node_modules', '@modelcontextprotocol', 'conformance');
export const SUITE_BIN = path.join(SUITE_DIR, 'dist', 'index.js');
/** The client the suite spawns, relative to the repository root. */
export const CLIENT_MAIN = 'out/vs/workbench/api/node/mcpConformanceClientMain.js';
/** The gateway fixture the server leg runs against, relative to the repository root. */
export const SERVER_MAIN = 'out/vs/platform/mcp/node/mcpGatewayConformanceMain.js';
export const DEFAULT_OUT = path.join(ROOT, '.build', 'conformance-results');
export const DEFAULT_TIMEOUT_MS = 60_000;
/** How long the gateway fixture may take to print `READY:<url>`. */
export const READY_TIMEOUT_MS = 30_000;
/** One suite invocation may run this many per-scenario timeouts before the harness kills it. */
export const INVOCATION_TIMEOUT_FACTOR = 5;
/** Scenarios that measure timing: they also run alone, after the parallel requirement run of their revision. */
export const TIMING_SCENARIOS: ReadonlySet<string> = new Set(['sse-retry']);
/** Every client the suite spawns records its PID in this directory (see mcpConformanceClientMain.ts). */
export const PID_DIR_ENV = 'VSCODE_MCP_CONFORMANCE_PID_DIR';
export const UNSCORED_BASELINE = 'expected-failures-unscored.yml';
export const MATRIX_FILE = 'requirement-matrix.md';
export const REQUIREMENT_TESTS_FILE = 'requirement-tests.json';
/** The rendered conformance matrix, relative to this folder. */
export const RENDERED_MATRIX_FILE = 'docs/mcp-conformance-matrix.md';

export function scoredBaseline(leg: Leg, revision: Revision): string {
	return `expected-failures-${leg}-${revision}.yml`;
}

export function isRevision(value: string): value is Revision {
	return (REVISIONS as readonly string[]).includes(value);
}

const USAGE = [
	'Usage: node test/mcp-conformance/run.ts <client|server|all|check-matrix|render-matrix> [options]',
	'',
	'  client         run the scored client scenarios of each revision (--unscored: the not-scored loop instead)',
	'  server         the same for the server leg, against the gateway fixture (or --server-url)',
	'  all            both legs, scored and not scored',
	'  check-matrix   check requirement-matrix.md, requirement-tests.json and docs/mcp-conformance-matrix.md against the suite, the baselines and the tests',
	'  render-matrix  regenerate docs/mcp-conformance-matrix.md from the requirements, their mapping and requirement-matrix.md',
	'',
	'Options:',
	`  --requirements <rev>[,<rev>]  revisions to run (default: ${REVISIONS.join(',')})`,
	'  --unscored                    run the not-scored scenarios one by one (--force) instead of the scored sets',
	'  --scenario <name>             run one scenario of the leg (with --spec-version, or at every revision that lists it)',
	'  --spec-version <rev>          the revision of --scenario',
	'  --server-url <url>            run the server leg against this server instead of starting the gateway fixture',
	'  --skip-server[=true|false]    skip the server leg of server and all (default: false, the leg runs); --no-skip-server',
	'  --out <dir>                   results directory (default: .build/conformance-results)',
	`  --timeout <ms>                per-scenario timeout passed to the suite (default: ${DEFAULT_TIMEOUT_MS})`,
	'  --update-baseline             rewrite the expected-failures files from the observed results (refused when CI is set)',
	'  --help, -h                    show this help',
	'',
].join('\n');

// #region options

export interface IOptions {
	readonly subcommand: Subcommand;
	readonly revisions: readonly Revision[];
	readonly unscored: boolean;
	readonly scenario: string | undefined;
	readonly specVersion: Revision | undefined;
	readonly serverUrl: string | undefined;
	readonly out: string;
	readonly timeout: number;
	readonly updateBaseline: boolean;
	readonly skipServer: boolean;
}

export type ParseResult =
	| { readonly kind: 'options'; readonly options: IOptions }
	| { readonly kind: 'help' }
	| { readonly kind: 'error'; readonly error: string };

const SUBCOMMANDS: readonly Subcommand[] = ['client', 'server', 'all', 'check-matrix', 'render-matrix'];
const VALUE_FLAGS = new Set(['--requirements', '--scenario', '--spec-version', '--server-url', '--out', '--timeout']);
const BOOLEAN_FLAGS = new Set(['--unscored', '--update-baseline', '--skip-server', '--no-skip-server']);

function parseBoolean(flag: string, value: string | undefined): boolean | string {
	if (value === undefined || value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	return `${flag} takes true or false, not ${value}`;
}

/** Parses the command line. Relative `--out` paths resolve against `cwd`. */
export function parseArgs(argv: readonly string[], env: Env, cwd: string): ParseResult {
	let subcommand: Subcommand | undefined;
	const values = new Map<string, string>();
	const booleans = new Map<string, boolean>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			return { kind: 'help' };
		}
		if (!arg.startsWith('--')) {
			if (subcommand !== undefined) {
				return { kind: 'error', error: `Unexpected argument: ${arg}` };
			}
			if (!(SUBCOMMANDS as readonly string[]).includes(arg)) {
				return { kind: 'error', error: `Unknown subcommand: ${arg}` };
			}
			subcommand = arg as Subcommand;
			continue;
		}
		const eq = arg.indexOf('=');
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		if (VALUE_FLAGS.has(flag)) {
			const value = inline ?? argv[++i];
			if (value === undefined || (inline === undefined && value.startsWith('--'))) {
				return { kind: 'error', error: `${flag} needs a value` };
			}
			values.set(flag, value);
		} else if (BOOLEAN_FLAGS.has(flag)) {
			if (flag === '--no-skip-server') {
				if (inline !== undefined) {
					return { kind: 'error', error: '--no-skip-server takes no value' };
				}
				booleans.set('--skip-server', false);
				continue;
			}
			const parsed = parseBoolean(flag, inline);
			if (typeof parsed === 'string') {
				return { kind: 'error', error: parsed };
			}
			booleans.set(flag, parsed);
		} else {
			return { kind: 'error', error: `Unknown option: ${flag}` };
		}
	}
	if (subcommand === undefined) {
		return { kind: 'error', error: 'Missing subcommand' };
	}

	const revisions: Revision[] = [];
	for (const value of (values.get('--requirements') ?? REVISIONS.join(',')).split(',')) {
		const revision = value.trim();
		if (!isRevision(revision)) {
			return { kind: 'error', error: `Unknown revision ${revision}; known: ${REVISIONS.join(', ')}` };
		}
		if (!revisions.includes(revision)) {
			revisions.push(revision);
		}
	}

	const specVersion = values.get('--spec-version');
	if (specVersion !== undefined && !isRevision(specVersion)) {
		return { kind: 'error', error: `Unknown revision ${specVersion}; known: ${REVISIONS.join(', ')}` };
	}
	const scenario = values.get('--scenario');
	if (specVersion !== undefined && scenario === undefined) {
		return { kind: 'error', error: '--spec-version selects the revision of --scenario' };
	}
	const unscored = booleans.get('--unscored') ?? false;
	if (scenario !== undefined && (subcommand === 'all' || subcommand === 'check-matrix' || subcommand === 'render-matrix')) {
		return { kind: 'error', error: '--scenario needs the client or server subcommand' };
	}
	if (scenario !== undefined && unscored) {
		return { kind: 'error', error: '--scenario and --unscored cannot be combined' };
	}

	const timeoutText = values.get('--timeout') ?? String(DEFAULT_TIMEOUT_MS);
	const timeout = Number(timeoutText);
	if (!/^\d+$/.test(timeoutText) || timeout <= 0) {
		return { kind: 'error', error: `--timeout takes a positive number of milliseconds, not ${timeoutText}` };
	}

	const serverUrl = values.get('--server-url');
	if (serverUrl !== undefined) {
		let protocol: string;
		try {
			protocol = new URL(serverUrl).protocol;
		} catch {
			return { kind: 'error', error: `--server-url is not a URL: ${serverUrl}` };
		}
		if (protocol !== 'http:' && protocol !== 'https:') {
			return { kind: 'error', error: `--server-url must be http(s): ${serverUrl}` };
		}
	}

	const updateBaseline = booleans.get('--update-baseline') ?? false;
	if (updateBaseline && env.CI !== undefined && env.CI !== '') {
		return { kind: 'error', error: '--update-baseline is refused on CI (CI is set): update the baselines locally and commit them' };
	}

	const out = values.get('--out');
	return {
		kind: 'options',
		options: {
			subcommand,
			revisions,
			unscored,
			scenario,
			specVersion: specVersion as Revision | undefined,
			serverUrl,
			out: out === undefined ? DEFAULT_OUT : path.resolve(cwd, out),
			timeout,
			updateBaseline,
			skipServer: booleans.get('--skip-server') ?? false,
		},
	};
}

// #endregion

// #region requirement sets and baselines

export interface INotScored {
	readonly scenario: string;
	readonly leg: Leg;
	readonly reason: string;
}

export interface IRequirementSet {
	readonly revision: Revision;
	readonly server: readonly string[];
	readonly client: readonly string[];
	readonly notScored: readonly INotScored[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, what: string): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
		throw new Error(`${what} must be a list of strings`);
	}
	return value as string[];
}

/** Parses one `requirements/<revision>.yaml` of the suite. */
export function parseRequirementSet(revision: Revision, text: string): IRequirementSet {
	const parsed: unknown = parseYaml(text);
	if (!isRecord(parsed)) {
		throw new Error(`requirements/${revision}.yaml is not a mapping`);
	}
	const notScored: INotScored[] = [];
	for (const entry of Array.isArray(parsed.not_scored) ? parsed.not_scored : []) {
		if (isRecord(entry) && typeof entry.scenario === 'string' && (entry.leg === 'client' || entry.leg === 'server')) {
			notScored.push({ scenario: entry.scenario, leg: entry.leg, reason: typeof entry.reason === 'string' ? entry.reason : '' });
		}
	}
	return {
		revision,
		server: stringList(parsed.server, `requirements/${revision}.yaml server`),
		client: stringList(parsed.client, `requirements/${revision}.yaml client`),
		notScored,
	};
}

export function loadRequirementSets(suiteDir: string = SUITE_DIR): IRequirementSet[] {
	return REVISIONS.map(revision => parseRequirementSet(revision, readFileSync(path.join(suiteDir, 'requirements', `${revision}.yaml`), 'utf8')));
}

export function scoredScenarios(set: IRequirementSet, leg: Leg): readonly string[] {
	return leg === 'client' ? set.client : set.server;
}

export function notScoredScenarios(set: IRequirementSet, leg: Leg): readonly string[] {
	return set.notScored.filter(entry => entry.leg === leg).map(entry => entry.scenario);
}

export interface IBaselineEntries {
	readonly server: readonly string[];
	readonly client: readonly string[];
}

/** Parses an expected-failures file the way the suite does (`server` and `client` lists of `scenario` or `scenario:check-id`). */
export function parseBaselineFile(text: string): IBaselineEntries {
	const parsed: unknown = parseYaml(text);
	if (parsed === null || parsed === undefined) {
		return { server: [], client: [] };
	}
	if (!isRecord(parsed)) {
		throw new Error('An expected-failures file must be a mapping with server and/or client lists');
	}
	return { server: stringList(parsed.server, 'server'), client: stringList(parsed.client, 'client') };
}

/** The scenario an expected-failures entry (or a suite verdict line) names. */
export function entryScenario(entry: string): string {
	const colon = entry.indexOf(':');
	return colon === -1 ? entry : entry.slice(0, colon);
}

// #endregion

// #region invocations

export type InvocationKind = 'scored' | 'timing' | 'scenario' | 'unscored';

export interface IInvocation {
	readonly label: string;
	readonly leg: Leg;
	readonly revision: Revision;
	readonly kind: InvocationKind;
	/** The scenario of a single-scenario invocation. */
	readonly scenario: string | undefined;
	/** The absolute path of the expected-failures file. */
	readonly baseline: string;
	readonly outDir: string;
	/** The scenarios whose checks this invocation judges (and `--update-baseline` rewrites). */
	readonly scope: readonly string[];
	/** The suite's arguments. */
	readonly args: readonly string[];
	/** How long the whole invocation may take before the harness kills the suite. */
	readonly deadlineMs: number;
	/** The scenarios of the scope whose client may exit non-zero (`allowClientError` in the suite). */
	readonly clientErrorAllowed: readonly string[];
}

export interface IPlanContext {
	readonly options: IOptions;
	readonly sets: readonly IRequirementSet[];
	/** Where the expected-failures files live. */
	readonly baselineDir: string;
	/** The `--command` of the client leg. */
	readonly clientCommand: string;
	/** The `--url` of the server leg. */
	readonly serverUrl: string | undefined;
	/** The client scenarios of the suite that set `allowClientError` (from its bundle). */
	readonly clientErrorAllowed?: ReadonlySet<string>;
}

/**
 * The node flags of the processes the harness starts (the suite, the client the
 * suite starts, the gateway fixture) on Windows. Node's built-in `fetch` (undici)
 * parses HTTP with a WebAssembly module, and V8 keeps tiering its functions up on
 * background threads for a moment after the last response; when the process exits
 * meanwhile, libuv aborts on `!(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c)
 * although the run completed (Node 24 on Windows). `--no-wasm-dynamic-tiering`
 * turns that tier-up off. Node refuses the flag in `NODE_OPTIONS`, so it goes on
 * each command line.
 */
export function nodeProcessFlags(platform: string = process.platform): readonly string[] {
	return platform === 'win32' ? ['--no-wasm-dynamic-tiering'] : [];
}

/**
 * The `--command` the suite spawns: `node <abs>/out/.../mcpConformanceClientMain.js`,
 * with {@link nodeProcessFlags}. The suite splits the command on spaces, so a root
 * with whitespace falls back to the path relative to the root, which is the
 * suite's working directory.
 */
export function clientCommand(root: string, platform: string = process.platform): string {
	const absolute = path.join(root, CLIENT_MAIN).split(path.sep).join('/');
	return ['node', ...nodeProcessFlags(platform), /\s/.test(absolute) ? CLIENT_MAIN : absolute].join(' ');
}

/** The arguments of `node` for the suite process: {@link nodeProcessFlags}, the suite, then its own arguments. */
export function suiteProcessArgs(args: readonly string[], platform: string = process.platform): string[] {
	return [...nodeProcessFlags(platform), SUITE_BIN, ...args];
}

function legTarget(leg: Leg, context: IPlanContext): string[] {
	if (leg === 'client') {
		return ['--command', context.clientCommand];
	}
	if (context.serverUrl === undefined) {
		throw new Error('The server leg needs a server URL');
	}
	return ['--url', context.serverUrl];
}

/** The suite's `server` command has no `--timeout` option (it rejects unknown options), so only the client leg gets one. */
function timeoutArgs(leg: Leg, timeout: number): string[] {
	return leg === 'client' ? ['--timeout', String(timeout)] : [];
}

/** `--requirements <rev>` with the scored baseline: the suite runs the revision's scored and not-scored scenarios in parallel and judges the scored ones. */
export function scoredArgs(leg: Leg, revision: Revision, baseline: string, outDir: string, context: IPlanContext): string[] {
	return [leg, ...legTarget(leg, context), '--requirements', revision, '--expected-failures', baseline, ...timeoutArgs(leg, context.options.timeout), '-o', outDir];
}

/** One scenario at one revision; never combined with `--requirements`, which the suite rejects. */
export function scenarioArgs(leg: Leg, scenario: string, revision: Revision, force: boolean, baseline: string, outDir: string, context: IPlanContext): string[] {
	return [
		leg, ...legTarget(leg, context),
		'--scenario', scenario,
		'--spec-version', revision,
		...(force ? ['--force'] : []),
		'--expected-failures', baseline,
		...timeoutArgs(leg, context.options.timeout),
		'-o', outDir,
	];
}

function sanitize(scenario: string): string {
	return scenario.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function setFor(context: IPlanContext, revision: Revision): IRequirementSet {
	const set = context.sets.find(candidate => candidate.revision === revision);
	if (!set) {
		throw new Error(`No requirement set for ${revision}`);
	}
	return set;
}

function clientErrorAllowedIn(leg: Leg, scope: readonly string[], context: IPlanContext): string[] {
	return leg === 'client' ? scope.filter(scenario => context.clientErrorAllowed?.has(scenario)) : [];
}

function scenarioInvocation(leg: Leg, kind: InvocationKind, scenario: string, revision: Revision, context: IPlanContext): IInvocation {
	const scored = scoredScenarios(setFor(context, revision), leg).includes(scenario);
	const baseline = path.join(context.baselineDir, scored ? scoredBaseline(leg, revision) : UNSCORED_BASELINE);
	const outDir = path.join(context.options.out, leg, revision, kind === 'unscored' ? 'unscored' : 'scenario', sanitize(scenario));
	return {
		label: `${leg} ${revision} ${scenario}${kind === 'unscored' ? ' (not scored)' : ''}`,
		leg,
		revision,
		kind,
		scenario,
		baseline,
		outDir,
		scope: [scenario],
		args: scenarioArgs(leg, scenario, revision, !scored, baseline, outDir, context),
		deadlineMs: context.options.timeout * INVOCATION_TIMEOUT_FACTOR,
		clientErrorAllowed: clientErrorAllowedIn(leg, [scenario], context),
	};
}

/** The scored run of every selected revision, each followed by its timing scenarios alone. */
export function planScored(leg: Leg, context: IPlanContext): IInvocation[] {
	const invocations: IInvocation[] = [];
	for (const revision of context.options.revisions) {
		const set = setFor(context, revision);
		const baseline = path.join(context.baselineDir, scoredBaseline(leg, revision));
		const outDir = path.join(context.options.out, leg, revision, 'scored');
		invocations.push({
			label: `${leg} ${revision} (scored)`,
			leg,
			revision,
			kind: 'scored',
			scenario: undefined,
			baseline,
			outDir,
			scope: scoredScenarios(set, leg),
			args: scoredArgs(leg, revision, baseline, outDir, context),
			deadlineMs: context.options.timeout * INVOCATION_TIMEOUT_FACTOR,
			clientErrorAllowed: clientErrorAllowedIn(leg, scoredScenarios(set, leg), context),
		});
		for (const scenario of scoredScenarios(set, leg)) {
			if (TIMING_SCENARIOS.has(scenario)) {
				invocations.push(scenarioInvocation(leg, 'timing', scenario, revision, context));
			}
		}
	}
	return invocations;
}

/** One invocation per not-scored scenario of every selected revision, forced, against the not-scored baseline. */
export function planUnscored(leg: Leg, context: IPlanContext): IInvocation[] {
	const invocations: IInvocation[] = [];
	for (const revision of context.options.revisions) {
		for (const scenario of notScoredScenarios(setFor(context, revision), leg)) {
			invocations.push(scenarioInvocation(leg, 'unscored', scenario, revision, context));
		}
	}
	return invocations;
}

/** `--scenario`: at `--spec-version`, or at every selected revision that lists it (scored or not); forced and judged against the not-scored baseline where it is not scored. */
export function planScenario(leg: Leg, scenario: string, context: IPlanContext): IInvocation[] {
	const listing = (revision: Revision) => {
		const set = setFor(context, revision);
		return scoredScenarios(set, leg).includes(scenario) || notScoredScenarios(set, leg).includes(scenario);
	};
	let revisions: readonly Revision[];
	if (context.options.specVersion !== undefined) {
		revisions = [context.options.specVersion];
	} else {
		const listed = context.options.revisions.filter(listing);
		revisions = listed.length > 0 ? listed : context.options.revisions;
	}
	return revisions.map(revision => scenarioInvocation(leg, 'scenario', scenario, revision, context));
}

export function planLeg(leg: Leg, context: IPlanContext): IInvocation[] {
	const { options } = context;
	if (options.scenario !== undefined) {
		return planScenario(leg, options.scenario, context);
	}
	if (options.unscored) {
		return planUnscored(leg, context);
	}
	if (options.subcommand === 'all') {
		return [...planScored(leg, context), ...planUnscored(leg, context)];
	}
	return planScored(leg, context);
}

// #endregion

// #region suite output

export interface IBaselineVerdict {
	readonly expected: readonly string[];
	readonly stale: readonly string[];
	readonly unexpected: readonly string[];
}

export interface ICounts {
	readonly passed: number;
	readonly failed: number;
	/** The suite's server summary has no warning count. */
	readonly warnings: number | undefined;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, '');
}

/** Reads the suite's expected-failures report (`Expected failures`, `Stale baseline entries`, `Unexpected failures`). */
export function parseBaselineVerdict(output: string): IBaselineVerdict {
	const expected: string[] = [];
	const stale: string[] = [];
	const unexpected: string[] = [];
	let section: string[] | undefined;
	for (const line of stripAnsi(output).split(/\r?\n/)) {
		if (line.startsWith('Expected failures (in baseline)')) {
			section = expected;
		} else if (line.startsWith('Stale baseline entries')) {
			section = stale;
		} else if (line.startsWith('Unexpected failures (not in baseline)')) {
			section = unexpected;
		} else {
			const match = /^\s+[~✓✗] (\S+)\s*$/.exec(line);
			if (section && match) {
				section.push(match[1]);
			} else if (line.trim() !== '' || section === undefined) {
				section = undefined;
			}
		}
	}
	return { expected, stale, unexpected };
}

/**
 * The check counts of a run as the suite prints them: `Total: …` of a
 * requirement run (without warnings on the server leg), `Passed: …` of a
 * single scenario.
 */
export function parseCounts(output: string): ICounts | undefined {
	const text = stripAnsi(output);
	const total = /Total: (\d+) passed, (\d+) failed(?:, (\d+) warnings)?/.exec(text);
	if (total) {
		return { passed: Number(total[1]), failed: Number(total[2]), warnings: total[3] === undefined ? undefined : Number(total[3]) };
	}
	const single = /Passed: (\d+)\/\d+, (\d+) failed, (\d+) warnings/.exec(text);
	if (single) {
		return { passed: Number(single[1]), failed: Number(single[2]), warnings: Number(single[3]) };
	}
	return undefined;
}

export interface ICheck {
	readonly id: string;
	readonly status: string;
}

const SEVERITY: Readonly<Record<string, number>> = { FAILURE: 4, WARNING: 3, SUCCESS: 2, SKIPPED: 1 };

/** The check ids a scenario fails, with repeated ids collapsed to their most severe status (as the suite does); a WARNING counts as a failure against a baseline. */
export function failingCheckIds(checks: readonly ICheck[]): string[] {
	const worst = new Map<string, string>();
	for (const check of checks) {
		if (check.status === 'INFO') {
			continue;
		}
		const previous = worst.get(check.id);
		if (previous === undefined || (SEVERITY[check.status] ?? 0) > (SEVERITY[previous] ?? 0)) {
			worst.set(check.id, check.status);
		}
	}
	return [...worst].filter(([, status]) => status === 'FAILURE' || status === 'WARNING').map(([id]) => id).sort();
}

/** The scenario of a suite result directory (`<scenario>-<timestamp>` or `server-<scenario>-<timestamp>`, nested for `auth/…`). */
export function resultScenario(relativeDir: string, leg: Leg): string {
	let name = relativeDir.split(/[\\/]/).join('/').replace(/-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '');
	if (leg === 'server') {
		name = name.replace(/^server-/, '');
	}
	return name;
}

/** The checks of every scenario of a run, counted the way the suite's summary counts them (warnings included, which its server summary leaves out). */
export function countChecks(results: ReadonlyMap<string, readonly ICheck[]>): ICounts | undefined {
	if (results.size === 0) {
		return undefined;
	}
	let passed = 0;
	let failed = 0;
	let warnings = 0;
	for (const checks of results.values()) {
		for (const check of checks) {
			passed += check.status === 'SUCCESS' ? 1 : 0;
			failed += check.status === 'FAILURE' ? 1 : 0;
			warnings += check.status === 'WARNING' ? 1 : 0;
		}
	}
	return { passed, failed, warnings };
}

/** Reads every `checks.json` under a results directory: scenario → checks (the latest run of a scenario wins). */
export function readResults(outDir: string, leg: Leg): Map<string, ICheck[]> {
	const results = new Map<string, { readonly mtime: number; readonly checks: ICheck[] }>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name === 'checks.json') {
				const scenario = resultScenario(path.relative(outDir, dir), leg);
				const mtime = statSync(full).mtimeMs;
				const previous = results.get(scenario);
				if (!previous || previous.mtime < mtime) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(readFileSync(full, 'utf8'));
					} catch {
						continue; // a run the suite did not finish writing
					}
					const checks = Array.isArray(parsed) ? parsed.filter((check): check is ICheck => isRecord(check) && typeof check.id === 'string' && typeof check.status === 'string') : [];
					results.set(scenario, { mtime, checks });
				}
			}
		}
	};
	if (existsSync(outDir)) {
		walk(outDir);
	}
	return new Map([...results].map(([scenario, { checks }]) => [scenario, checks]));
}

/** Reads the `stdout.txt` and `stderr.txt` the suite saved for each client scenario under a results directory (the latest run of a scenario wins). */
export function readClientOutputs(outDir: string): Map<string, IClientOutput> {
	const outputs = new Map<string, { readonly mtime: number; readonly output: IClientOutput }>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name === 'stderr.txt') {
				const scenario = resultScenario(path.relative(outDir, dir), 'client');
				const mtime = statSync(full).mtimeMs;
				const previous = outputs.get(scenario);
				if (!previous || previous.mtime < mtime) {
					outputs.set(scenario, { mtime, output: { stdout: readOptionalFile(path.join(dir, 'stdout.txt')) ?? '', stderr: readOptionalFile(full) ?? '' } });
				}
			}
		}
	};
	if (existsSync(outDir)) {
		walk(outDir);
	}
	return new Map([...outputs].map(([scenario, { output }]) => [scenario, output]));
}

function readOptionalFile(file: string): string | undefined {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

// #endregion

// #region running

export interface ISuiteRun {
	readonly exitCode: number;
	/** stdout and stderr of the suite, as they arrived. */
	readonly output: string;
	readonly timedOut: boolean;
}

export interface IServerHandle {
	readonly url: string;
	stop(): Promise<void>;
}

export interface IHarnessDeps {
	readonly platform: string;
	/** Runs `node <suite> ...args` from the repository root. */
	runSuite(args: readonly string[], env: Env, timeoutMs: number): Promise<ISuiteRun>;
	/** Kills a process: the whole tree on Windows (`taskkill /T`), the process itself elsewhere. */
	killTree(pid: number): void;
	isAlive(pid: number): boolean;
	/** Starts the gateway fixture and resolves with the URL it prints as `READY:<url>`. */
	startServer(logFile: string): Promise<IServerHandle>;
	log(line: string): void;
}

export interface IInvocationResult {
	readonly invocation: IInvocation;
	readonly exitCode: number;
	readonly timedOut: boolean;
	readonly counts: ICounts | undefined;
	readonly verdict: IBaselineVerdict;
	readonly clientTimeouts: number;
	/** The client exits and timeouts that fail the invocation (see `clientExitProblems`). */
	readonly clientExits: readonly string[];
	/** Pass or fail after the timing re-runs are taken into account. */
	passed: boolean;
	note: string | undefined;
}

type SpawnSyncFn = (command: string, args: readonly string[], options: { readonly stdio: 'ignore' }) => unknown;
type KillFn = (pid: number, signal: string) => void;

/** `taskkill /pid <pid> /T /F` on Windows, SIGKILL elsewhere. */
export function createKillTree(platform: string, spawnSyncFn: SpawnSyncFn, killFn: KillFn): (pid: number) => void {
	return pid => {
		if (platform === 'win32') {
			spawnSyncFn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			try {
				killFn(pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}
	};
}

/**
 * Kills the clients the suite left behind. The suite spawns the client through
 * a shell and on timeout kills only the shell, which on Windows leaves the
 * client running. Every client writes `<pid>.pid` into the PID directory and
 * removes it when it exits, so what is left names a process still running.
 */
export function killLeftovers(pidDir: string, deps: Pick<IHarnessDeps, 'killTree' | 'isAlive' | 'log'>): number[] {
	const killed: number[] = [];
	if (!existsSync(pidDir)) {
		return killed;
	}
	for (const name of readdirSync(pidDir)) {
		const match = /^(\d+)\.pid$/.exec(name);
		if (!match) {
			continue;
		}
		const pid = Number(match[1]);
		if (deps.isAlive(pid)) {
			deps.log(`[mcp-conformance] killing the leftover client ${pid}`);
			deps.killTree(pid);
			killed.push(pid);
		}
		try {
			unlinkSync(path.join(pidDir, name));
		} catch {
			// the client removed it on its way out
		}
	}
	return killed;
}

export async function runInvocation(invocation: IInvocation, env: Env, deps: IHarnessDeps): Promise<IInvocationResult> {
	rmSync(invocation.outDir, { recursive: true, force: true });
	mkdirSync(invocation.outDir, { recursive: true });
	const pidDir = path.join(path.dirname(invocation.outDir), `.pids-${path.basename(invocation.outDir)}`);
	rmSync(pidDir, { recursive: true, force: true });
	mkdirSync(pidDir, { recursive: true });
	deps.log(`\n[mcp-conformance] ${invocation.label}: conformance ${invocation.args.join(' ')}`);
	let run: ISuiteRun;
	try {
		run = await deps.runSuite(invocation.args, { ...env, [PID_DIR_ENV]: pidDir }, invocation.deadlineMs);
	} finally {
		killLeftovers(pidDir, deps);
		rmSync(pidDir, { recursive: true, force: true });
	}
	const verdict = parseBaselineVerdict(run.output);
	// The suite's own process (not a client) aborting in libuv after its verdict; see isExitCrashAfterPassingVerdict.
	const crashedAfterVerdict = !run.timedOut && isExitCrashAfterPassingVerdict(run.exitCode, run.output);
	const clientExits = invocation.leg === 'client'
		? clientExitProblems(parseClientExits(run.output, readClientOutputs(invocation.outDir)), invocation, wholeScenarioEntries(invocation.baseline, invocation.leg))
		: [];
	const suitePassed = (run.exitCode === 0 && !run.timedOut) || crashedAfterVerdict;
	return {
		invocation,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		counts: countChecks(readResults(invocation.outDir, invocation.leg)) ?? parseCounts(run.output),
		verdict,
		clientTimeouts: countClientTimeouts(run.output),
		clientExits,
		passed: suitePassed && clientExits.length === 0,
		note: run.timedOut ? 'the suite did not finish in time and was killed'
			: [
				...(crashedAfterVerdict ? [`the suite aborted in libuv while exiting (${run.exitCode}), after its baseline check passed`] : []),
				...(clientExits.length > 0 ? [`${clientExits.join('; ')}: a client that exits non-zero or times out fails the run unless its scenario allows a client error or is baselined whole`] : []),
			].join('; ') || undefined,
	};
}

/**
 * On Windows the suite's process sometimes aborts in libuv while it exits
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit code
 * 0xC0000409), after it printed its verdict. The verdict is what counts.
 */
export function isExitCrashAfterPassingVerdict(exitCode: number, output: string): boolean {
	const text = stripAnsi(output);
	const verdictAt = text.lastIndexOf('Baseline check passed: all failures are expected.');
	return exitCode !== 0 && verdictAt !== -1 && text.indexOf('Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)', verdictAt) !== -1;
}

/** How many clients the suite killed for running past `--timeout`; with a baseline the suite judges only the checks, so the summary reports these. */
export function countClientTimeouts(output: string): number {
	return stripAnsi(output).match(/Client timed out after \d+ms/g)?.length ?? 0;
}

/** What the client of one scenario wrote, as the suite saved it in the scenario's result folder (`stdout.txt`, `stderr.txt`). */
export interface IClientOutput {
	readonly stdout: string;
	readonly stderr: string;
}

/** A client that exited non-zero or timed out, as the suite reported it; the scenario is undefined when the report cannot be matched to one. */
export interface IClientExit {
	readonly scenario: string | undefined;
	/** Undefined for a timeout the suite reported without an exit code. */
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
}

function normalizeOutput(text: string): string {
	return stripAnsi(text).replace(/\r/g, '');
}

/**
 * The client exits of a suite run. The suite judges a run with a baseline by
 * its checks alone, but it reports each client that exits non-zero on its
 * stderr, followed by the client's own output, which it also saves in the
 * scenario's result folder:
 *
 *     Client exited with code <n>
 *
 *     Stdout:            (when the client wrote any)
 *     <stdout.txt>
 *
 *     Stderr:            (when the client wrote any)
 *     <stderr.txt>
 *
 *     Client timed out after <ms>ms   (when it did)
 *
 * The lines of one report are written together, so a report is matched to
 * its scenario by the saved output it quotes. A timeout of a client that
 * exited with code 0 (the kill of its shell) is reported alone and cannot be
 * matched; nor can a report that quotes no output.
 */
export function parseClientExits(output: string, clients: ReadonlyMap<string, IClientOutput>): IClientExit[] {
	const text = normalizeOutput(output);
	const exits: IClientExit[] = [];
	const headers = [...text.matchAll(/^Client exited with code (-?\d+)$/gm)];
	const timeouts = [...text.matchAll(/^Client timed out after \d+ms$/gm)];
	const usedHeaders = new Set<number>();
	const usedTimeouts = new Set<number>();
	for (const [scenario, client] of clients) {
		const stdout = normalizeOutput(client.stdout);
		const stderr = normalizeOutput(client.stderr);
		if (stdout === '' && stderr === '') {
			continue;
		}
		const quoted = (stdout !== '' ? `\nStdout:\n${stdout}\n` : '') + (stderr !== '' ? `\nStderr:\n${stderr}\n` : '');
		for (const header of headers) {
			const start = header.index + header[0].length + 1;
			if (usedHeaders.has(header.index) || !text.startsWith(quoted, start)) {
				continue;
			}
			usedHeaders.add(header.index);
			const after = start + quoted.length;
			const timeout = timeouts.find(candidate => candidate.index === after + 1 && text[after] === '\n');
			if (timeout) {
				usedTimeouts.add(timeout.index);
			}
			exits.push({ scenario, exitCode: Number(header[1]), timedOut: timeout !== undefined });
			break;
		}
	}
	for (const header of headers) {
		if (!usedHeaders.has(header.index)) {
			exits.push({ scenario: undefined, exitCode: Number(header[1]), timedOut: false });
		}
	}
	for (const timeout of timeouts) {
		if (!usedTimeouts.has(timeout.index)) {
			exits.push({ scenario: undefined, exitCode: undefined, timedOut: true });
		}
	}
	return exits;
}

/** The whole-scenario entries of a baseline file for a leg (`scenario`, not `scenario:check`); a missing or unreadable file has none. */
function wholeScenarioEntries(file: string, leg: Leg): Set<string> {
	try {
		const entries = parseBaselineFile(readFileSync(file, 'utf8'));
		return new Set((leg === 'client' ? entries.client : entries.server).filter(entry => !entry.includes(':')));
	} catch {
		return new Set();
	}
}

/**
 * The client exits that fail an invocation: a client of a scenario the
 * invocation judges that timed out, or that exited non-zero although its
 * scenario does not allow a client error (`allowClientError` in the suite:
 * the client must refuse the server and exit with an error). A scenario its
 * baseline lists as a whole is exempt. An exit that cannot be matched to a
 * scenario fails the invocation, unless it judges one scenario only, which it
 * then belongs to.
 */
export function clientExitProblems(exits: readonly IClientExit[], invocation: Pick<IInvocation, 'scope' | 'clientErrorAllowed'>, wholeBaselined: ReadonlySet<string>): string[] {
	const problems: string[] = [];
	for (const exit of exits) {
		const scenario = exit.scenario ?? (invocation.scope.length === 1 ? invocation.scope[0] : undefined);
		if (scenario !== undefined && (!invocation.scope.includes(scenario) || wholeBaselined.has(scenario))) {
			continue;
		}
		const which = scenario === undefined ? 'a client (of a scenario the harness cannot tell)' : `the client of ${scenario}`;
		if (exit.timedOut) {
			problems.push(`${which} timed out`);
		} else if (exit.exitCode !== undefined && exit.exitCode !== 0 && (scenario === undefined || !invocation.clientErrorAllowed.includes(scenario))) {
			problems.push(`${which} exited with code ${exit.exitCode}`);
		}
	}
	return problems;
}

/**
 * A scored run that fails only on timing scenarios passes when those scenarios
 * pass when they run alone: in the parallel requirement run they compete with
 * every other scenario for the event loop.
 */
export function applyTimingReruns(results: readonly IInvocationResult[]): void {
	for (const scored of results) {
		if (scored.invocation.kind !== 'scored' || scored.passed || scored.timedOut || scored.clientExits.length > 0) {
			continue;
		}
		const entries = [...scored.verdict.unexpected, ...scored.verdict.stale];
		if (entries.length === 0) {
			continue;
		}
		const scenarios = new Set(entries.map(entryScenario));
		const reruns = results.filter(result => result.invocation.kind === 'timing' && result.invocation.leg === scored.invocation.leg && result.invocation.revision === scored.invocation.revision);
		const allTiming = [...scenarios].every(scenario => TIMING_SCENARIOS.has(scenario) && reruns.some(rerun => rerun.invocation.scenario === scenario && rerun.passed));
		if (allTiming) {
			scored.passed = true;
			scored.note = `only ${[...scenarios].join(', ')} failed in parallel; ${scenarios.size === 1 ? 'it passes' : 'they pass'} when run alone`;
		}
	}
}

// #endregion

// #region baseline updates

interface IObserved {
	readonly scope: Set<string>;
	readonly failing: Map<string, Set<string>>;
}

/** Collects what each invocation observed, per baseline file and leg, so a file shared by several runs is written once. */
export class BaselineUpdater {
	private readonly _observed = new Map<string, Map<Leg, IObserved>>();

	record(invocation: IInvocation, results: ReadonlyMap<string, readonly ICheck[]>): string[] {
		const missing: string[] = [];
		let byLeg = this._observed.get(invocation.baseline);
		if (!byLeg) {
			byLeg = new Map();
			this._observed.set(invocation.baseline, byLeg);
		}
		let observed = byLeg.get(invocation.leg);
		if (!observed) {
			observed = { scope: new Set(), failing: new Map() };
			byLeg.set(invocation.leg, observed);
		}
		for (const scenario of invocation.scope) {
			const checks = results.get(scenario);
			if (!checks) {
				missing.push(scenario);
				continue;
			}
			// a timing re-run replaces what the parallel run saw of its scenario
			if (invocation.kind === 'timing') {
				observed.failing.delete(scenario);
			}
			observed.scope.add(scenario);
			const ids = failingCheckIds(checks);
			if (ids.length > 0) {
				const set = observed.failing.get(scenario) ?? new Set<string>();
				for (const id of ids) {
					set.add(id);
				}
				observed.failing.set(scenario, set);
			}
		}
		return missing;
	}

	/** Rewrites the files; returns the entries added to and removed from each. */
	write(): { readonly file: string; readonly added: string[]; readonly removed: string[] }[] {
		const changes: { file: string; added: string[]; removed: string[] }[] = [];
		for (const [file, byLeg] of this._observed) {
			const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
			const document = parseDocument(text);
			const current = parseBaselineFile(text);
			const added: string[] = [];
			const removed: string[] = [];
			for (const [leg, observed] of byLeg) {
				const before = leg === 'client' ? current.client : current.server;
				const after = updatedEntries(before, observed);
				added.push(...after.filter(entry => !before.includes(entry)));
				removed.push(...before.filter(entry => !after.includes(entry)));
				document.set(leg, document.createNode(after));
			}
			writeFileSync(file, String(document));
			changes.push({ file, added, removed });
		}
		return changes;
	}
}

/**
 * The new entries of one leg: entries of scenarios outside the observed scope
 * stay; a scenario baselined as a whole stays whole while it still fails; any
 * other failing scenario is baselined per check.
 */
export function updatedEntries(before: readonly string[], observed: { readonly scope: ReadonlySet<string>; readonly failing: ReadonlyMap<string, ReadonlySet<string>> }): string[] {
	const after = new Set<string>(before.filter(entry => !observed.scope.has(entryScenario(entry))));
	for (const [scenario, ids] of observed.failing) {
		if (before.includes(scenario)) {
			after.add(scenario);
		} else {
			for (const id of ids) {
				after.add(`${scenario}:${id}`);
			}
		}
	}
	return [...after].sort();
}

// #endregion

// #region check-matrix

export type MatrixStatus = 'driven' | 'gap' | 'n-a';
export const MATRIX_STATUSES: readonly MatrixStatus[] = ['driven', 'gap', 'n-a'];

export interface IMatrixRow {
	readonly leg: string;
	readonly revision: string;
	readonly scenario: string;
	readonly scoring: string;
	readonly status: string;
	readonly notes: string;
	readonly line: number;
}

/** The rows of the matrix tables: `| leg | revision | scenario | scoring | status | notes |`. */
export function parseMatrix(text: string): IMatrixRow[] {
	const rows: IMatrixRow[] = [];
	text.split(/\r?\n/).forEach((line, index) => {
		if (!line.startsWith('|')) {
			return;
		}
		const cells = line.split('|').slice(1, -1).map(cell => cell.trim().replace(/^`(.*)`$/, '$1'));
		if (cells.length < 5 || (cells[0] !== 'client' && cells[0] !== 'server')) {
			return;
		}
		rows.push({ leg: cells[0], revision: cells[1], scenario: cells[2], scoring: cells[3], status: cells[4], notes: cells[5] ?? '', line: index + 1 });
	});
	return rows;
}

export interface ICheckMatrixInput {
	readonly matrix: readonly IMatrixRow[];
	readonly sets: readonly IRequirementSet[];
	/** Every expected-failures file by name. */
	readonly baselines: ReadonlyMap<string, IBaselineEntries>;
	/** `requirements-<revision>.json` contents by file name. */
	readonly requirementFiles: ReadonlyMap<string, unknown>;
	readonly requirementTests: unknown;
	/** The suite version package.json pins. */
	readonly pinnedSuiteVersion: string | undefined;
	/** The contents of a repository-relative file, or undefined when it does not exist. */
	readonly readFile: (relativePath: string) => string | undefined;
	/** The check ids and scenario names the suite defines, when it is installed; cited check ids must be among them. */
	readonly suite?: ISuiteInventory;
	/** The current docs/mcp-conformance-matrix.md (null when it is missing); undefined skips the currency check. */
	readonly renderedMatrix?: string | null;
	/** By requirements file: zig-sdk's `requirements.zon` at the commit the file's `source` names, or why it cannot be read; undefined skips the check. */
	readonly requirementSources?: ReadonlyMap<string, ZonRead>;
	/** The current gateway-threats.md (null when it is missing); undefined skips its check. */
	readonly gatewayThreats?: string | null;
	/** The grpc_server.zig parity steps whose test citations to check (the rendered matrix always shows GRPC_SERVER_PARITY). */
	readonly grpcServerParity?: readonly IGrpcServerParityStep[];
	/** The source of mcpConformanceScenarios.ts (null when it is missing); undefined skips the comparison of its driver tables with the suite. */
	readonly scenarioDrivers?: string | null;
}

export interface ISuiteInventory {
	readonly checkIds: ReadonlySet<string>;
	readonly scenarios: ReadonlySet<string>;
	/** The client scenarios that set `allowClientError`: their client is expected to exit non-zero (it must refuse the server). */
	readonly clientErrorAllowed: ReadonlySet<string>;
}

/**
 * The literal check ids (`id: '<check>'`) and scenario names
 * (`this.name = '<scenario>'`) of the suite's bundle, and the scenarios whose
 * constructor sets `this.allowClientError = true` (`!0` once minified).
 */
export function parseSuiteInventory(bundle: string): ISuiteInventory {
	const checkIds = new Set<string>();
	for (const match of bundle.matchAll(/\bid:\s*[`'"]([a-z0-9][a-z0-9_./-]*)[`'"]/g)) {
		checkIds.add(match[1]);
	}
	const scenarios = new Set<string>();
	const clientErrorAllowed = new Set<string>();
	const names = [...bundle.matchAll(/\bthis\.name\s*=\s*[`'"]([a-z0-9][a-z0-9_./-]*)[`'"]/g)];
	names.forEach((match, index) => {
		scenarios.add(match[1]);
		// the rest of the constructor: up to the next scenario name or the first method after the constructor's closing brace
		const end = names[index + 1]?.index ?? bundle.length;
		const rest = bundle.slice(match.index, Math.min(end, match.index + 8192));
		const constructorEnd = /\}\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\(/.exec(rest);
		if (/\bthis\.allowClientError\s*=\s*(?:!0|true)\b/.test(constructorEnd ? rest.slice(0, constructorEnd.index) : rest)) {
			clientErrorAllowed.add(match[1]);
		}
	});
	return { checkIds, scenarios, clientErrorAllowed };
}

function baselineFor(input: ICheckMatrixInput, file: string, leg: Leg): readonly string[] {
	const entries = input.baselines.get(file);
	return entries ? (leg === 'client' ? entries.client : entries.server) : [];
}

/** Checks the matrix, the requirement mapping and the rendered matrix; returns the problems found. */
export function checkMatrix(input: ICheckMatrixInput): string[] {
	const problems: string[] = [];
	const rows = new Map<string, IMatrixRow>();
	const legs: readonly Leg[] = ['client', 'server'];

	for (const file of [...REVISIONS.flatMap(revision => legs.map(leg => scoredBaseline(leg, revision))), UNSCORED_BASELINE]) {
		if (!input.baselines.has(file)) {
			problems.push(`${file} is missing`);
		}
	}

	for (const row of input.matrix) {
		const where = `${MATRIX_FILE}:${row.line}`;
		const key = `${row.leg} ${row.revision} ${row.scenario}`;
		if (rows.has(key)) {
			problems.push(`${where}: a second row for ${key}`);
			continue;
		}
		rows.set(key, row);
		if (!isRevision(row.revision)) {
			problems.push(`${where}: unknown revision ${row.revision}`);
			continue;
		}
		if (!(MATRIX_STATUSES as readonly string[]).includes(row.status)) {
			problems.push(`${where}: status ${row.status} is not one of ${MATRIX_STATUSES.join(', ')}`);
		}
		const set = input.sets.find(candidate => candidate.revision === row.revision);
		const leg = row.leg as Leg;
		const scored = set ? scoredScenarios(set, leg).includes(row.scenario) : false;
		const notScored = set ? notScoredScenarios(set, leg).includes(row.scenario) : false;
		if (!scored && !notScored) {
			problems.push(`${where}: requirements/${row.revision}.yaml lists no ${row.leg} scenario ${row.scenario}`);
			continue;
		}
		const scoring = scored ? 'scored' : 'not-scored';
		if (row.scoring !== scoring) {
			problems.push(`${where}: ${key} is ${scoring}, not ${row.scoring}`);
		}
		const baselineFile = scored ? scoredBaseline(leg, row.revision) : UNSCORED_BASELINE;
		const baselined = baselineFor(input, baselineFile, leg).some(entry => entryScenario(entry) === row.scenario);
		if (row.status === 'gap' && !baselined) {
			problems.push(`${where}: ${key} is a gap but ${baselineFile} has no ${row.leg} entry for it`);
		}
		if (row.status === 'driven' && baselined) {
			problems.push(`${where}: ${key} is driven (every check passes) but ${baselineFile} has ${row.leg} entries for it: make the row a gap or remove the entries`);
		}
		if (notScored && row.status !== 'driven' && !baselined) {
			problems.push(`${where}: the not-scored ${key} is neither driven nor baselined in ${UNSCORED_BASELINE}`);
		}
	}

	for (const set of input.sets) {
		for (const leg of legs) {
			for (const scenario of [...scoredScenarios(set, leg), ...notScoredScenarios(set, leg)]) {
				if (!rows.has(`${leg} ${set.revision} ${scenario}`)) {
					problems.push(`${MATRIX_FILE} has no row for ${leg} ${set.revision} ${scenario}`);
				}
			}
		}
	}

	// every baseline entry names a scenario its file covers
	for (const leg of legs) {
		for (const set of input.sets) {
			const file = scoredBaseline(leg, set.revision);
			for (const entry of baselineFor(input, file, leg)) {
				if (!scoredScenarios(set, leg).includes(entryScenario(entry))) {
					problems.push(`${file}: ${entry} is not a scored ${leg} scenario of ${set.revision}`);
				}
			}
		}
		for (const entry of baselineFor(input, UNSCORED_BASELINE, leg)) {
			if (!input.sets.some(set => notScoredScenarios(set, leg).includes(entryScenario(entry)))) {
				problems.push(`${UNSCORED_BASELINE}: ${entry} is not a not-scored ${leg} scenario`);
			}
		}
	}

	if (input.suite) {
		for (const { scenario } of AUTHORIZATION_SERVER_SCENARIOS) {
			if (!input.suite.scenarios.has(scenario)) {
				problems.push(`the suite defines no authorization-server scenario ${scenario}`);
			}
		}
	}

	const model = loadRequirementModel(input, problems);
	const checkTest = createTestCitationCheck(input.readFile);
	problems.push(...checkRequirementSources(input));
	problems.push(...checkRequirementTests(input, rows, model, checkTest));
	problems.push(...checkRenderedTestCitations(input.grpcServerParity ?? [], checkTest));
	problems.push(...checkGatewayThreats(input, rows, checkTest));
	problems.push(...checkScenarioDrivers(input));
	if (input.renderedMatrix !== undefined) {
		if (input.renderedMatrix === null) {
			problems.push(`${RENDERED_MATRIX_FILE} is missing: run node test/mcp-conformance/run.ts render-matrix`);
		} else if (normalizeNewlines(input.renderedMatrix) !== renderConformanceMatrix(input, model)) {
			problems.push(`${RENDERED_MATRIX_FILE} is not current: run node test/mcp-conformance/run.ts render-matrix`);
		}
	}
	return problems;
}

// #region requirement model

export type RequirementLevel = 'must' | 'must_not' | 'should' | 'should_not' | 'may';
export const REQUIREMENT_LEVELS: readonly RequirementLevel[] = ['must', 'must_not', 'should', 'should_not', 'may'];
export type RequirementParty = 'client' | 'server' | 'both' | 'authorization_server';
export const REQUIREMENT_PARTIES: readonly RequirementParty[] = ['client', 'server', 'both', 'authorization_server'];

/** One normative sentence of the specification (an entry of requirements-<revision>.json). */
export interface IRequirement {
	readonly id: string;
	readonly page: string;
	readonly section: string;
	readonly anchor: string;
	readonly level: RequirementLevel;
	readonly party: RequirementParty;
	readonly text: string;
}

/**
 * - `tested`: the cited tests or scenarios cover the requirement.
 * - `partial`: they cover a part of it; the reason names the rest.
 * - `deviation`: VS Code deliberately behaves otherwise; the reason explains it and the cited tests pin the behaviour (a MUST or MUST NOT needs at least one).
 * - `gap`: no automated test covers it; the reason says what VS Code does. Never a MUST or MUST NOT.
 * - `n-a`: it does not apply to VS Code; the reason says why.
 */
export type MappingStatus = 'tested' | 'partial' | 'deviation' | 'gap' | 'n-a';
export const MAPPING_STATUSES: readonly MappingStatus[] = ['tested', 'partial', 'deviation', 'gap', 'n-a'];

/** A test of this repository: a repository-relative file and the exact name its `test(...)` call gives. */
export interface ITestCitation {
	readonly file: string;
	readonly test: string;
}

/** A scenario of the suite at one revision, optionally narrowed to one of its checks. */
export interface IScenarioCitation {
	readonly leg: Leg;
	readonly revision: Revision;
	readonly scenario: string;
	readonly check?: string;
}

export interface IRequirementMapping {
	readonly id: string;
	readonly status: MappingStatus;
	readonly reason?: string;
	readonly note?: string;
	readonly tests: readonly ITestCitation[];
	readonly scenarios: readonly IScenarioCitation[];
}

export interface IRequirementModel {
	readonly requirementsFile: string;
	/** The `source` of the requirements file (where the extraction comes from), if any. */
	readonly source: Readonly<Record<string, unknown>>;
	readonly specification: Readonly<Record<string, unknown>>;
	readonly requirements: readonly IRequirement[];
	readonly mappings: readonly IRequirementMapping[];
	readonly harness: string;
}

/** The requirement levels that may never be a gap. */
export function isMustLevel(level: RequirementLevel): boolean {
	return level === 'must' || level === 'must_not';
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function loadRequirementModel(input: ICheckMatrixInput, problems: string[]): IRequirementModel {
	const tests = isRecord(input.requirementTests) ? input.requirementTests : {};
	if (!isRecord(input.requirementTests)) {
		problems.push(`${REQUIREMENT_TESTS_FILE} is not a JSON object`);
	}
	const harness = typeof tests.harness === 'string' ? tests.harness : '';
	if (input.pinnedSuiteVersion !== undefined && harness !== `@modelcontextprotocol/conformance@${input.pinnedSuiteVersion}`) {
		problems.push(`${REQUIREMENT_TESTS_FILE}: harness ${harness || String(tests.harness)} is not the pinned @modelcontextprotocol/conformance@${input.pinnedSuiteVersion}`);
	}

	const requirementsFile = typeof tests.requirements === 'string' ? tests.requirements : '';
	const file = input.requirementFiles.get(requirementsFile);
	const requirements: IRequirement[] = [];
	let source: Record<string, unknown> = {};
	let specification: Record<string, unknown> = {};
	if (!isRecord(file) || !Array.isArray(file.requirements)) {
		problems.push(`${REQUIREMENT_TESTS_FILE}: requirements names ${requirementsFile || 'no file'}, which is not a requirements file of this folder`);
	} else {
		source = isRecord(file.source) ? file.source : {};
		specification = isRecord(file.specification) ? file.specification : {};
		const ids = new Set<string>();
		file.requirements.forEach((entry: unknown, index: number) => {
			if (!isRecord(entry) || typeof entry.id !== 'string') {
				problems.push(`${requirementsFile}: requirement ${index} has no id`);
				return;
			}
			if (ids.has(entry.id)) {
				problems.push(`${requirementsFile}: ${entry.id} is listed twice`);
				return;
			}
			ids.add(entry.id);
			const level = REQUIREMENT_LEVELS.find(candidate => candidate === entry.level);
			const party = REQUIREMENT_PARTIES.find(candidate => candidate === entry.party);
			if (!level || !party || typeof entry.text !== 'string' || typeof entry.page !== 'string') {
				problems.push(`${requirementsFile}: ${entry.id} needs a page, a level (${REQUIREMENT_LEVELS.join(', ')}), a party (${REQUIREMENT_PARTIES.join(', ')}) and a text`);
				return;
			}
			requirements.push({
				id: entry.id,
				page: entry.page,
				section: typeof entry.section === 'string' ? entry.section : '',
				anchor: typeof entry.anchor === 'string' ? entry.anchor : '',
				level,
				party,
				text: entry.text,
			});
		});
	}

	const mappings: IRequirementMapping[] = [];
	if (!Array.isArray(tests.mappings)) {
		problems.push(`${REQUIREMENT_TESTS_FILE}: mappings must be a list`);
	}
	for (const entry of Array.isArray(tests.mappings) ? tests.mappings : []) {
		if (!isRecord(entry) || typeof entry.id !== 'string') {
			problems.push(`${REQUIREMENT_TESTS_FILE}: a mapping without an id`);
			continue;
		}
		const where = `${REQUIREMENT_TESTS_FILE}: ${entry.id}`;
		const status = MAPPING_STATUSES.find(candidate => candidate === (entry.status ?? 'tested'));
		if (!status) {
			problems.push(`${where}: status ${String(entry.status)} is not one of ${MAPPING_STATUSES.join(', ')}`);
			continue;
		}
		const citedTests: ITestCitation[] = [];
		for (const test of Array.isArray(entry.tests) ? entry.tests : []) {
			if (isRecord(test) && typeof test.file === 'string' && typeof test.test === 'string') {
				citedTests.push({ file: test.file, test: test.test });
			} else {
				problems.push(`${where}: a test must be { "file": "<repository-relative path>", "test": "<test name>" }, not ${JSON.stringify(test)}`);
			}
		}
		const citedScenarios: IScenarioCitation[] = [];
		for (const scenario of Array.isArray(entry.scenarios) ? entry.scenarios : []) {
			if (isRecord(scenario) && (scenario.leg === 'client' || scenario.leg === 'server') && typeof scenario.revision === 'string' && isRevision(scenario.revision) && typeof scenario.scenario === 'string' && (scenario.check === undefined || typeof scenario.check === 'string')) {
				citedScenarios.push({ leg: scenario.leg, revision: scenario.revision, scenario: scenario.scenario, ...(typeof scenario.check === 'string' ? { check: scenario.check } : {}) });
			} else {
				problems.push(`${where}: a scenario must be { "leg": "client" | "server", "revision": "${REVISIONS.join('" | "')}", "scenario": "<name>", "check"?: "<check id>" }, not ${JSON.stringify(scenario)}`);
			}
		}
		if ((entry.tests !== undefined && !Array.isArray(entry.tests)) || (entry.scenarios !== undefined && !Array.isArray(entry.scenarios))) {
			problems.push(`${where}: tests and scenarios must be lists`);
		}
		mappings.push({ id: entry.id, status, reason: optionalString(entry.reason), note: optionalString(entry.note), tests: citedTests, scenarios: citedScenarios });
	}
	return { requirementsFile, source, specification, requirements, mappings, harness };
}

/** A `test(...)` / `it(...)` call of a test file whose name is a literal. */
export interface ITestDeclaration {
	/** The literal with its quote and backslash escapes resolved; a template literal keeps its `${...}` placeholders. */
	readonly name: string;
	/** `test.skip`, `test.todo`, or a test inside `suite.skip(...)` / `describe.skip(...)`: it never runs. */
	readonly skipped: boolean;
	/** `test.only`, or a test inside `suite.only(...)`: committing it would stop every other test of the run. */
	readonly only: boolean;
}

interface IToken {
	readonly kind: 'identifier' | 'punctuation' | 'string' | 'template' | 'other';
	readonly value: string;
}

const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'void', 'delete', 'throw', 'yield', 'await', 'of']);

/** Splits TypeScript source into the tokens the test scan needs; comments, regular expressions and numbers are skipped or opaque. */
function tokenize(source: string): IToken[] {
	const tokens: IToken[] = [];
	let index = 0;
	/** The last token read, inside template substitutions too: it decides whether a slash starts a regular expression. */
	let last: IToken | undefined;
	const unescape = (raw: string) => raw.replace(/\\(['"`\\])/g, '$1');

	/** Skips a template literal from its opening backtick; returns its raw content. */
	const template = (): string => {
		const start = ++index;
		while (index < source.length) {
			const char = source[index];
			if (char === '\\') {
				index += 2;
			} else if (char === '`') {
				return source.slice(start, index++);
			} else if (char === '$' && source[index + 1] === '{') {
				index += 2;
				expression('}');
			} else {
				index++;
			}
		}
		return source.slice(start);
	};

	/** Scans tokens until the closing character at depth zero (the end of a template substitution). */
	const expression = (close: string) => {
		let depth = 0;
		while (index < source.length) {
			const token = next();
			if (token === undefined) {
				return;
			}
			if (token.kind === 'punctuation' && token.value === '{') {
				depth++;
			} else if (token.kind === 'punctuation' && token.value === close) {
				if (depth === 0) {
					return;
				}
				depth--;
			}
		}
	};

	const regexAllowed = () => {
		const previous = last;
		if (!previous) {
			return true;
		}
		if (previous.kind === 'identifier') {
			return KEYWORDS_BEFORE_EXPRESSION.has(previous.value);
		}
		return previous.kind === 'punctuation' && !(previous.value === ')' || previous.value === ']' || previous.value === '}');
	};

	const scan = (): IToken | undefined => {
		while (index < source.length) {
			const char = source[index];
			if (/\s/.test(char)) {
				index++;
			} else if (source.startsWith('//', index)) {
				const end = source.indexOf('\n', index);
				index = end === -1 ? source.length : end;
			} else if (source.startsWith('/*', index)) {
				const end = source.indexOf('*/', index + 2);
				index = end === -1 ? source.length : end + 2;
			} else {
				break;
			}
		}
		if (index >= source.length) {
			return undefined;
		}
		const char = source[index];
		if (char === '\'' || char === '"') {
			const start = ++index;
			while (index < source.length && source[index] !== char && source[index] !== '\n') {
				index += source[index] === '\\' ? 2 : 1;
			}
			return { kind: 'string', value: unescape(source.slice(start, index++)) };
		}
		if (char === '`') {
			return { kind: 'template', value: unescape(template()) };
		}
		const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(index, index + 256));
		if (word) {
			index += word[0].length;
			return { kind: 'identifier', value: word[0] };
		}
		const number = /^\d[\w.]*/.exec(source.slice(index, index + 64));
		if (number) {
			index += number[0].length;
			return { kind: 'other', value: number[0] };
		}
		if (char === '/' && regexAllowed()) {
			let inClass = false;
			index++;
			while (index < source.length && source[index] !== '\n') {
				const current = source[index];
				if (current === '\\') {
					index += 2;
					continue;
				}
				index++;
				if (current === '[') {
					inClass = true;
				} else if (current === ']') {
					inClass = false;
				} else if (current === '/' && !inClass) {
					break;
				}
			}
			while (index < source.length && /[a-z]/.test(source[index])) {
				index++;
			}
			return { kind: 'other', value: 'regex' };
		}
		index++;
		return { kind: 'punctuation', value: char };
	};

	const next = (): IToken | undefined => {
		const token = scan();
		if (token !== undefined) {
			last = token;
		}
		return token;
	};

	for (let token = next(); token !== undefined; token = next()) {
		tokens.push(token);
	}
	return tokens;
}

const TEST_FUNCTIONS = new Set(['test', 'it']);
const SUITE_FUNCTIONS = new Set(['suite', 'describe']);

/**
 * The tests a TypeScript test file declares with a literal name, and whether
 * each one runs: `test.skip`, `test.todo` and every test inside a
 * `suite.skip(...)` never run, and `.only` would narrow the whole run. A test
 * skipped at run time (`this.skip()`, `{ skip: condition }`, or a suite chosen
 * by an expression such as `(PORT ? suite : suite.skip)`) counts as running.
 */
export function scanTestDeclarations(source: string): ITestDeclaration[] {
	const tokens = tokenize(source);
	const declarations: ITestDeclaration[] = [];
	/** One entry per open parenthesis: whether it is the argument list of a skipped or an only suite. */
	const frames: { readonly skipped: boolean; readonly only: boolean }[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === 'punctuation' && token.value === ')') {
			frames.pop();
			continue;
		}
		if (token.kind === 'punctuation' && token.value === '(') {
			frames.push({ skipped: false, only: false });
			continue;
		}
		const previous = tokens[i - 1];
		if (token.kind !== 'identifier' || (previous?.kind === 'punctuation' && previous.value === '.')) {
			continue;
		}
		// the callee: `name` or `name.member`, followed by the argument list
		let member: string | undefined;
		let open = i + 1;
		if (tokens[open]?.value === '.' && tokens[open + 1]?.kind === 'identifier') {
			member = tokens[open + 1].value;
			open += 2;
		}
		if (tokens[open]?.kind !== 'punctuation' || tokens[open].value !== '(') {
			continue;
		}
		const isTest = TEST_FUNCTIONS.has(token.value);
		const isSuite = SUITE_FUNCTIONS.has(token.value);
		if ((!isTest && !isSuite) || (member !== undefined && member !== 'skip' && member !== 'only' && member !== 'todo')) {
			continue;
		}
		const enclosingSkipped = frames.some(frame => frame.skipped);
		const enclosingOnly = frames.some(frame => frame.only);
		i = open;
		frames.push({ skipped: isSuite && member === 'skip', only: isSuite && member === 'only' });
		const name = tokens[open + 1];
		if (isTest && (name?.kind === 'string' || name?.kind === 'template')) {
			declarations.push({ name: name.value, skipped: enclosingSkipped || member === 'skip' || member === 'todo', only: enclosingOnly || member === 'only' });
		}
	}
	return declarations;
}

/** The names of the tests of a file that run (see `scanTestDeclarations`). */
export function extractTestNames(source: string): Set<string> {
	return new Set(scanTestDeclarations(source).filter(declaration => !declaration.skipped && !declaration.only).map(declaration => declaration.name));
}

function describeScenario(citation: IScenarioCitation): string {
	return `${citation.leg} ${citation.revision} ${citation.scenario}${citation.check ? ` (${citation.check})` : ''}`;
}

/** Checks test citations against the files they name: the file exists and declares the test, which runs. Caches the scan per file. */
function createTestCitationCheck(readFile: (relativePath: string) => string | undefined): (where: string, citation: ITestCitation) => string | undefined {
	const declarations = new Map<string, ITestDeclaration[] | undefined>();
	return (where, test) => {
		if (!declarations.has(test.file)) {
			const text = readFile(test.file);
			declarations.set(test.file, text === undefined ? undefined : scanTestDeclarations(text));
		}
		const declared = declarations.get(test.file);
		const named = declared?.filter(declaration => declaration.name === test.test) ?? [];
		if (declared === undefined) {
			return `${where} cites ${test.file}, which does not exist`;
		}
		if (named.length === 0) {
			return `${where} cites the test "${test.test}", which ${test.file} does not declare`;
		}
		if (named.some(declaration => declaration.only)) {
			return `${where} cites the test "${test.test}", which ${test.file} marks .only (the test or its suite): remove the .only`;
		}
		if (named.every(declaration => declaration.skipped)) {
			return `${where} cites the test "${test.test}", which ${test.file} skips (test.skip, test.todo or a suite.skip around it): a skipped test covers nothing`;
		}
		return undefined;
	};
}

/** Each requirements file must be what tools/convert-requirements.ts produces from zig-sdk at the commit the file names. */
function checkRequirementSources(input: ICheckMatrixInput): string[] {
	const problems: string[] = [];
	for (const [file, read] of input.requirementSources ?? []) {
		const current = input.requirementFiles.get(file);
		if (read.kind !== 'text' || !isRecord(current)) {
			continue;
		}
		const source = isRecord(current.source) ? current.source : {};
		let converted: Record<string, unknown>;
		try {
			converted = convertRequirements(read.text, { version: String(source.version ?? ''), commit: String(source.commit ?? '') });
		} catch (error) {
			problems.push(`${file}: ${ZIG_SDK.path} at ${String(source.commit)} does not convert: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (isDeepStrictEqual(converted, current)) {
			continue;
		}
		const byId = (list: unknown) => new Map((Array.isArray(list) ? list as { id?: unknown }[] : []).map(entry => [String(entry.id), entry]));
		const expected = byId(converted.requirements);
		const actual = byId(current.requirements);
		const differing = [...expected].filter(([id, entry]) => actual.has(id) && !isDeepStrictEqual(entry, actual.get(id))).map(([id]) => id);
		const missing = [...expected.keys()].filter(id => !actual.has(id));
		const extra = [...actual.keys()].filter(id => !expected.has(id));
		const fields = Object.keys(converted).filter(key => key !== 'requirements' && !isDeepStrictEqual(converted[key], current[key]));
		const sample = (ids: readonly string[]) => `${ids.length} requirement(s), e.g. ${ids.slice(0, 5).join(', ')}`;
		const what = [
			...(fields.length > 0 ? [`the fields ${fields.join(', ')}`] : []),
			...(differing.length > 0 ? [`it differs in ${sample(differing)}`] : []),
			...(missing.length > 0 ? [`it lacks ${sample(missing)}`] : []),
			...(extra.length > 0 ? [`it has ${sample(extra)} the source does not`] : []),
		];
		problems.push(`${file} is not what tools/convert-requirements.ts produces from ${ZIG_SDK.path} at ${String(source.commit)} (${what.join('; ') || 'the layout'}): run node test/mcp-conformance/tools/convert-requirements.ts --commit ${String(source.commit)}`);
	}
	return problems;
}

/** The scenario drivers of the conformance client, relative to the repository root. */
export const SCENARIO_DRIVERS_FILE = 'src/vs/workbench/api/node/mcpConformanceScenarios.ts';

export interface IScenarioDrivers {
	/** `SCORED_CLIENT_SCENARIOS`: scenario → the revisions that score it. */
	readonly scored: ReadonlyMap<string, readonly string[]>;
	/** `UNSCORED_CLIENT_SCENARIOS`. */
	readonly unscored: readonly string[];
}

/**
 * Reads the driver tables of mcpConformanceScenarios.ts from its source (the
 * harness cannot import the workbench): the entries `['<scenario>', <REVISIONS>]`
 * of `SCORED_CLIENT_SCENARIOS`, where `<REVISIONS>` is a constant of the file
 * whose array names `MCP_REVISION_*` constants, and the strings of
 * `UNSCORED_CLIENT_SCENARIOS`. Undefined when the tables are not found.
 */
export function parseScenarioDrivers(source: string): IScenarioDrivers | undefined {
	const literal = (name: string) => new RegExp(`\\b${name}\\s*=\\s*'([^']+)'`).exec(source)?.[1];
	const revisionLists = new Map<string, string[]>();
	for (const match of source.matchAll(/\bconst (\w+): readonly string\[\] = \[([^\]]*)\];/g)) {
		const revisions = match[2].split(',').map(item => item.trim()).filter(item => item !== '').map(item => /^MCP_REVISION_\w+$/.test(item) ? literal(item) : undefined);
		if (revisions.length > 0 && revisions.every(revision => revision !== undefined)) {
			revisionLists.set(match[1], revisions as string[]);
		}
	}
	const scoredTable = /\bSCORED_CLIENT_SCENARIOS\b[^=]*=\s*new Map[^(]*\(\[([\s\S]*?)\]\);/.exec(source);
	const unscoredTable = /\bUNSCORED_CLIENT_SCENARIOS\b[^=]*=\s*\[([\s\S]*?)\];/.exec(source);
	if (!scoredTable || !unscoredTable) {
		return undefined;
	}
	const scored = new Map<string, readonly string[]>();
	for (const entry of scoredTable[1].matchAll(/\[\s*'([^']+)'\s*,\s*(\w+)\s*\]/g)) {
		const revisions = revisionLists.get(entry[2]);
		if (!revisions) {
			return undefined;
		}
		scored.set(entry[1], revisions);
	}
	const unscored = [...unscoredTable[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
	return { scored, unscored };
}

/** The driver tables of the conformance client must list exactly the client scenarios of the suite's requirement sets. */
function checkScenarioDrivers(input: ICheckMatrixInput): string[] {
	if (input.scenarioDrivers === undefined) {
		return [];
	}
	const drivers = input.scenarioDrivers === null ? undefined : parseScenarioDrivers(input.scenarioDrivers);
	if (!drivers) {
		return [`${SCENARIO_DRIVERS_FILE}: no SCORED_CLIENT_SCENARIOS and UNSCORED_CLIENT_SCENARIOS tables to compare with the suite's requirement sets`];
	}
	const problems: string[] = [];
	for (const set of input.sets) {
		for (const scenario of set.client) {
			if (!drivers.scored.get(scenario)?.includes(set.revision)) {
				problems.push(`${SCENARIO_DRIVERS_FILE}: SCORED_CLIENT_SCENARIOS does not list ${scenario} for ${set.revision}, which requirements/${set.revision}.yaml scores`);
			}
		}
		for (const scenario of notScoredScenarios(set, 'client')) {
			if (!drivers.unscored.includes(scenario)) {
				problems.push(`${SCENARIO_DRIVERS_FILE}: UNSCORED_CLIENT_SCENARIOS does not list ${scenario}, which requirements/${set.revision}.yaml runs without scoring`);
			}
		}
	}
	for (const [scenario, revisions] of drivers.scored) {
		for (const revision of revisions) {
			const set = input.sets.find(candidate => candidate.revision === revision);
			if (set && !set.client.includes(scenario)) {
				problems.push(`${SCENARIO_DRIVERS_FILE}: SCORED_CLIENT_SCENARIOS lists ${scenario} for ${revision}, which requirements/${revision}.yaml does not score`);
			}
		}
	}
	for (const scenario of drivers.unscored) {
		if (!input.sets.some(set => notScoredScenarios(set, 'client').includes(scenario))) {
			problems.push(`${SCENARIO_DRIVERS_FILE}: UNSCORED_CLIENT_SCENARIOS lists ${scenario}, which no requirement set runs without scoring`);
		}
	}
	return problems;
}

/** The file of the gateway's threat model, relative to this folder. */
export const GATEWAY_THREATS_FILE = 'gateway-threats.md';

export interface IGatewayThreat {
	readonly title: string;
	readonly line: number;
	readonly tests: readonly ITestCitation[];
	readonly scenarios: readonly IScenarioCitation[];
}

/**
 * The threats of gateway-threats.md: one `## ` section each, citing tests as
 * ``- `<file>`: <test name>`` and conformance scenarios as
 * ``- conformance <leg> <revision> `<scenario>` `` list items.
 */
export function parseGatewayThreats(text: string): IGatewayThreat[] {
	const threats: { title: string; line: number; tests: ITestCitation[]; scenarios: IScenarioCitation[] }[] = [];
	text.split(/\r?\n/).forEach((line, index) => {
		const heading = /^## (.+)$/.exec(line);
		if (heading) {
			threats.push({ title: heading[1].trim(), line: index + 1, tests: [], scenarios: [] });
			return;
		}
		const current = threats[threats.length - 1];
		const test = /^- `([^`]+\.ts)`: (.+)$/.exec(line);
		if (current && test) {
			current.tests.push({ file: test[1], test: test[2] });
			return;
		}
		const scenario = /^- conformance (client|server) (\S+) `([^`]+)`$/.exec(line);
		if (current && scenario && isRevision(scenario[2])) {
			current.scenarios.push({ leg: scenario[1] === 'client' ? 'client' : 'server', revision: scenario[2], scenario: scenario[3] });
		}
	});
	return threats;
}

function checkGatewayThreats(input: ICheckMatrixInput, rows: ReadonlyMap<string, IMatrixRow>, checkTest: (where: string, citation: ITestCitation) => string | undefined): string[] {
	if (input.gatewayThreats === undefined) {
		return [];
	}
	if (input.gatewayThreats === null) {
		return [`${GATEWAY_THREATS_FILE} is missing`];
	}
	const problems: string[] = [];
	const threats = parseGatewayThreats(input.gatewayThreats);
	if (threats.length === 0) {
		problems.push(`${GATEWAY_THREATS_FILE} has no threats (## sections)`);
	}
	for (const threat of threats) {
		const where = `${GATEWAY_THREATS_FILE}:${threat.line} (${threat.title})`;
		if (threat.tests.length + threat.scenarios.length === 0) {
			problems.push(`${where} cites no test or conformance scenario`);
		}
		for (const test of threat.tests) {
			const problem = checkTest(where, test);
			if (problem) {
				problems.push(problem);
			}
		}
		for (const citation of threat.scenarios) {
			const row = rows.get(`${citation.leg} ${citation.revision} ${citation.scenario}`);
			if (row?.status !== 'driven') {
				problems.push(`${where} cites ${describeScenario(citation)}, whose ${MATRIX_FILE} row is ${row?.status ?? 'missing'}, not driven`);
			}
		}
	}
	return problems;
}

/** The tests the rendered matrix cites outside the requirement rows (the grpc_server.zig parity table). */
function checkRenderedTestCitations(steps: readonly IGrpcServerParityStep[], checkTest: (where: string, citation: ITestCitation) => string | undefined): string[] {
	const problems: string[] = [];
	for (const row of steps) {
		for (const test of row.tests) {
			const problem = checkTest(`the grpc_server.zig parity row ${row.step}`, test);
			if (problem) {
				problems.push(problem);
			}
		}
	}
	return problems;
}

function checkRequirementTests(input: ICheckMatrixInput, rows: ReadonlyMap<string, IMatrixRow>, model: IRequirementModel, checkTest: (where: string, citation: ITestCitation) => string | undefined): string[] {
	const problems: string[] = [];
	const requirements = new Map(model.requirements.map(requirement => [requirement.id, requirement]));

	const mapped = new Set<string>();
	for (const mapping of model.mappings) {
		const where = `${REQUIREMENT_TESTS_FILE}: ${mapping.id}`;
		if (mapped.has(mapping.id)) {
			problems.push(`${where} is mapped twice`);
		}
		mapped.add(mapping.id);
		const requirement = requirements.get(mapping.id);
		if (!requirement && model.requirements.length > 0) {
			problems.push(`${where} is not a requirement of ${model.requirementsFile}`);
		}
		const cited = mapping.tests.length + mapping.scenarios.length;
		switch (mapping.status) {
			case 'tested':
				if (cited === 0) {
					problems.push(`${where} is tested but cites no test or scenario`);
				}
				break;
			case 'partial':
			case 'deviation':
				// A deviation of a SHOULD may have no test that pins it; a MUST always needs one.
				if (cited === 0 && (mapping.status === 'partial' || !requirement || isMustLevel(requirement.level))) {
					problems.push(`${where} is ${mapping.status} but cites no test or scenario`);
				}
				if (!mapping.reason) {
					problems.push(`${where} is ${mapping.status} without a reason`);
				}
				break;
			case 'gap':
				if (!mapping.reason) {
					problems.push(`${where} is gap without a reason`);
				}
				if (requirement && isMustLevel(requirement.level)) {
					problems.push(`${where} is a ${levelName(requirement.level)} requirement and cannot be a gap: cite a test or a scenario, or give an n-a reason`);
				}
				break;
			case 'n-a':
				if (!mapping.reason) {
					problems.push(`${where} is n-a without a reason`);
				}
				if (cited > 0) {
					problems.push(`${where} is n-a but cites tests or scenarios`);
				}
				break;
		}
		for (const test of mapping.tests) {
			const problem = checkTest(where, test);
			if (problem) {
				problems.push(problem);
			}
		}
		for (const citation of mapping.scenarios) {
			const set = input.sets.find(candidate => candidate.revision === citation.revision);
			const listed = set ? [...scoredScenarios(set, citation.leg), ...notScoredScenarios(set, citation.leg)].includes(citation.scenario) : false;
			if (!listed) {
				problems.push(`${where} cites the scenario ${describeScenario(citation)}, which requirements/${citation.revision}.yaml does not list for the ${citation.leg} leg`);
				continue;
			}
			const row = rows.get(`${citation.leg} ${citation.revision} ${citation.scenario}`);
			const baselineFile = set && scoredScenarios(set, citation.leg).includes(citation.scenario) ? scoredBaseline(citation.leg, citation.revision) : UNSCORED_BASELINE;
			const baselined = (entry: string) => entry === citation.scenario || (citation.check !== undefined && entry === `${citation.scenario}:${citation.check}`);
			const checkPasses = row?.status === 'gap' && citation.check !== undefined && !baselineFor(input, baselineFile, citation.leg).some(baselined);
			if (row && row.status !== 'driven' && !checkPasses) {
				problems.push(`${where} cites ${describeScenario(citation)}, whose ${MATRIX_FILE} row is ${row.status}${row.status === 'gap' ? ' (cite a check that is not baselined)' : ''}`);
			}
			if (citation.check !== undefined && input.suite && !input.suite.checkIds.has(citation.check)) {
				problems.push(`${where} cites the check ${citation.check}, which the suite does not define`);
			}
		}
	}

	for (const requirement of model.requirements) {
		if (!mapped.has(requirement.id)) {
			problems.push(`${REQUIREMENT_TESTS_FILE}: the ${levelName(requirement.level)} requirement ${requirement.id} is not mapped`);
		}
	}
	return problems;
}

// #endregion

// #region render-matrix

const LEVEL_NAMES: Readonly<Record<RequirementLevel, string>> = { must: 'MUST', must_not: 'MUST NOT', should: 'SHOULD', should_not: 'SHOULD NOT', may: 'MAY' };
const PARTY_NAMES: Readonly<Record<RequirementParty, string>> = { client: 'client', server: 'server', both: 'both', authorization_server: 'authorization server' };
const STATUS_NAMES: Readonly<Record<MappingStatus, string>> = { tested: 'tested', partial: 'partial', deviation: 'deviation', gap: 'gap', 'n-a': 'n/a' };

export function levelName(level: RequirementLevel): string {
	return LEVEL_NAMES[level];
}

/** The scenarios of the suite's `authorization` command. They test an authorization server, which VS Code is not. */
export const AUTHORIZATION_SERVER_SCENARIOS: readonly { readonly scenario: string; readonly reason: string }[] = [
	{ scenario: 'authorization-server-metadata-endpoint', reason: 'VS Code is an OAuth client and resource-server host, not an authorization server; the requirement sets have no authorization-server section.' },
	{ scenario: 'authorization-code-grant', reason: 'VS Code is an OAuth client and resource-server host, not an authorization server; the requirement sets have no authorization-server section.' },
];

/** Deliberate deviations that span several requirement rows or concern the suite rather than the specification. */
export const NOTED_DEVIATIONS: readonly { readonly title: string; readonly text: string }[] = [
	{
		title: 'The 3 s resource read-cache floor',
		text: 'The MCP resource file system coalesces reads of one resource for 3 seconds (`MOMENTARY_CACHE_DURATION` in `mcpResourceFilesystem.ts`), whatever `ttlMs` the server sent, also for `ttlMs: 0` or an absent hint, which the specification asks to treat as immediately stale. The floor keeps the editor, the file watcher and the chat attachments that read one resource at the same moment from issuing a request each. Results of input rounds are never cached. The caching rows `server/utilities/caching#011-98d047` and `#014-13ee1f` carry the deviation.',
	},
	{
		title: 'Tool names: the specification and the suite disagree',
		text: 'The specification says tool names SHOULD be 1 to 128 characters of `[A-Za-z0-9_.-]` (`server/tools#017-c37d16`, `#019-49087d`). The suite\'s `tools-name-format` check (part of `completion-complete`) fails a server whose tool names are not 1 to 64 characters of `[A-Za-z0-9_./-]`: stricter on the length, looser on `/`. The gateway serves the names of the servers behind it unchanged, so a name of 65 to 128 characters passes the specification and fails the suite. The conformance fixture uses names that satisfy both.',
	},
];

/** What each binding of the gRPC transport can carry. */
export const GRPC_BINDING_CAPABILITIES: readonly { readonly feature: string; readonly tunnel: string; readonly typed: string }[] = [
	{ feature: 'Requests and results of every method', tunnel: 'yes (JSON-RPC messages in `JsonRpcMessage.jsonrpc`)', typed: 'the eight RPCs of `model_context_protocol.Mcp`: `server/discover` (synthesized: it carries the `serverInfo` and `instructions` of the first typed ListTools response, else names the server after its authority), `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`, `completion/complete`' },
	{ feature: '`subscriptions/listen`', tunnel: 'yes (a server-streaming call)', typed: 'no: answered with -32601 without a call' },
	{ feature: 'List-changed notifications', tunnel: 'yes, on the listen stream', typed: 'no (no listen stream)' },
	{ feature: '`notifications/resources/updated`', tunnel: 'yes, on the listen stream', typed: 'no (no listen stream)' },
	{ feature: 'Pagination', tunnel: 'yes', typed: 'the first page only: a non-empty cursor is unexpressible' },
	{ feature: 'Progress and log notifications of a request', tunnel: 'yes, streamed before the response', typed: 'no' },
	{ feature: '`structuredContent` that is not a JSON object', tunnel: 'yes', typed: 'no: unexpressible' },
	{ feature: 'Tasks extension (`resultType: "task"`, `tasks/*`)', tunnel: 'yes', typed: 'no: a result of the type task is unexpressible' },
	{ feature: 'Input rounds (`input_required`, `requestState`)', tunnel: 'yes', typed: 'yes (elicitation, sampling with one content block per message, roots)' },
	{ feature: 'Errors', tunnel: '`mcp-error-bin` trailer (the JSON-RPC error), else `mcp-error-code`, else the gRPC status', typed: 'the same trailers; a JSON-RPC error ends the call with headers only' },
	{ feature: 'Lossy values', tunnel: 'none', typed: '`destructiveHint: false` and `openWorldHint: false` arrive absent, an empty `blob` arrives as an empty `text`, `priority` keeps a 32-bit float' },
];

/** Features and extensions around the specification, and whether VS Code implements them. */
export const FEATURE_ROWS: readonly { readonly feature: string; readonly status: string; readonly notes: string }[] = [
	{ feature: 'Sampling with tools (`sampling.tools`, `tools` and `toolChoice` in `sampling/createMessage`)', status: 'in', notes: 'The client declares `sampling.tools` when a language model with tool calling is offered and maps `tool_use` / `tool_result` blocks to the language model API (`mcpSamplingService.test.ts`).' },
	{ feature: 'Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663)', status: 'in', notes: 'Client: opt-in polling of `tasks/get` (`mcpModernTask.test.ts`). Gateway: `tasks/get`, `tasks/update`, `tasks/cancel` (M9); the suite\'s `tasks-*` server scenarios run not scored.' },
	{ feature: 'MCP Apps (`io.modelcontextprotocol/ui`)', status: 'in', notes: 'The client declares the extension on the 2026-07-28 wire and renders app-only tools in the chat, not for the language model.' },
	{ feature: 'Skills extension (`io.modelcontextprotocol/skills`, SEP-2640)', status: 'deferred', notes: 'Not implemented; deferred to a later milestone. The suite (since 0.2.0-alpha.12) has extension scenarios for it, `sep-2640-skills-directory`, `sep-2640-skills-enumeration`, `sep-2640-skills-manifest` (server) and `sep-2640-client-no-prefetch`, `sep-2640-client-verify-digest`, `sep-2640-client-verify-size`, `sep-2640-client-verify-frontmatter` (client), which no requirement set lists, so the harness does not run them.' },
	{ feature: 'OAuth client credentials (`auth/client-credentials-jwt`, `auth/client-credentials-basic`)', status: 'excluded', notes: 'An authorization extension for machine clients; VS Code signs in users. The scenarios run not scored and are baselined whole.' },
	{ feature: 'Enterprise-managed authorization (`auth/enterprise-managed-authorization`)', status: 'excluded', notes: 'The product has a preview of ID-JAG sign-in for enterprise-managed servers (`oauth.enterpriseManaged`), which the conformance client does not drive; the scenario is baselined whole in `expected-failures-unscored.yml`.' },
	{ feature: 'DPoP (`auth/dpop`, `auth/dpop-nonce`)', status: 'excluded', notes: 'Baselined whole in `expected-failures-unscored.yml`.' },
	{ feature: 'Workload identity federation (`auth/wif-jwt-bearer`)', status: 'excluded', notes: 'Baselined whole in `expected-failures-unscored.yml`.' },
	{ feature: 'gRPC transport (`grpc://`, `grpcs://`)', status: 'in', notes: 'Client: `McpGrpcHandle` with the tunnel and typed bindings (M8). Gateway: a gRPC listener for the routes of the gateways that ask for it (`startMcpGateway(resource, { grpc: true })`), open only while one of them has a server (M10).' },
	{ feature: '`grpc_server.zig` parity (the gateway gRPC listener)', status: 'in', notes: 'The listener checks a call in the order of zig-sdk\'s `src/grpc/transport/grpc_server.zig` (`handleStreamInner`): see the validation order below. The gateway has no authorization, so the loopback `:authority` check and the route lookup take the place of the authorization step.' },
];

/**
 * The validation order of a call to the gateway gRPC listener
 * (`GrpcServer` in `src/vs/base/node/grpcServer.ts`, routes in
 * `src/vs/platform/mcp/node/mcpGatewayGrpc.ts`) next to zig-sdk
 * `src/grpc/transport/grpc_server.zig` (v0.5.2, `handleStreamInner`).
 */
export interface IGrpcServerParityStep {
	readonly step: string;
	readonly zig: string;
	readonly gateway: string;
	readonly tests: readonly ITestCitation[];
}

export const GRPC_SERVER_PARITY: readonly IGrpcServerParityStep[] = [
	{
		step: 'Header list size',
		zig: 'a header block over the limit: `ENHANCE_YOUR_CALM` (HTTP/2 layer)',
		gateway: 'a header list over 8 KiB: the stream is reset with `ENHANCE_YOUR_CALM` before anything else (Node applies `SETTINGS_MAX_HEADER_LIST_SIZE` only after the settings acknowledgement)',
		tests: [{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'a header list over 8 KiB is reset with ENHANCE_YOUR_CALM' }],
	},
	{
		step: '1. `:method`',
		zig: 'not `POST`: HTTP 405',
		gateway: 'the same (with `allow: POST`)',
		tests: [{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'a request that is not a POST gets HTTP 405, one without a gRPC content type 415' }],
	},
	{
		step: '2. `content-type`',
		zig: 'not `application/grpc…` (case-insensitive prefix): HTTP 415',
		gateway: 'the same',
		tests: [{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'a request that is not a POST gets HTTP 405, one without a gRPC content type 415' }],
	},
	{
		step: '3. `:path`',
		zig: 'neither the tunnel method nor a typed RPC: trailers-only `UNIMPLEMENTED`',
		gateway: 'the same, with `grpc-accept-encoding: identity`',
		tests: [{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'an unknown path and a compressed encoding are UNIMPLEMENTED' }],
	},
	{
		step: '4. `grpc-encoding`',
		zig: 'not `identity`: trailers-only `UNIMPLEMENTED`',
		gateway: 'the same, with `grpc-accept-encoding: identity`',
		tests: [{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'an unknown path and a compressed encoding are UNIMPLEMENTED' }],
	},
	{
		step: '5. Authorization, before any look at the message',
		zig: 'the bearer token of `authorization` (resource server): a challenge, else the principal',
		gateway: 'no authorization (loopback only): a `:authority` that is not a loopback name (`localhost`, an address of `127.0.0.0/8`, `[::1]`) is `PERMISSION_DENIED`; then the route (`mcp-gateway-route` metadata) is looked up, missing or unknown `NOT_FOUND`, trailers only, before the message is read; the route id is the principal of the sealed `requestState`',
		tests: [
			{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'a refused :authority is PERMISSION_DENIED before the message is read' },
			{ file: 'src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts', test: 'a foreign :authority is PERMISSION_DENIED' },
			{ file: 'src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts', test: 'by default a call must name its route, even when the listener serves one: missing or unknown is NOT_FOUND, trailers only, before the message is read' },
			{ file: 'src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts', test: 'input rounds: the sealed requestState continues on its own route only' },
		],
	},
	{
		step: '`grpc-timeout`',
		zig: 'parsed without overflow (`99999999H`)',
		gateway: 'malformed: `INVALID_ARGUMENT`; beyond what a timer can wait: no deadline; else the deadline cancels the dispatcher request and ends the call with `DEADLINE_EXCEEDED`',
		tests: [
			{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'a grpc-timeout beyond what a timer can wait arms no deadline (3000000S, 99999999H)' },
			{ file: 'src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts', test: 'a client reset and grpc-timeout cancel the request in the dispatcher' },
		],
	},
	{
		step: '6. The message',
		zig: 'typed RPC: the typed handler; tunnel: the message, with nesting and size limits',
		gateway: 'over 4 MiB: `RESOURCE_EXHAUSTED`; a missing, second or truncated message: `INVALID_ARGUMENT`; then the typed or the tunnel handler',
		tests: [
			{ file: 'src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts', test: 'a request message over 4 MiB is RESOURCE_EXHAUSTED' },
			{ file: 'src/vs/base/test/node/grpcServer.test.ts', test: 'a missing, second, or truncated request message is INVALID_ARGUMENT' },
		],
	},
	{
		step: '7. Mirrored request metadata',
		zig: '`mcp-protocol-version`, `mcp-method`, `mcp-name` and `mcp-param-*` checked against the message: -32020',
		gateway: 'the same checks as the HTTP route (`prepareModernRequest`): -32020 or -32022 in `mcp-error-bin`, before the request runs',
		tests: [
			{ file: 'src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts', test: 'a header mismatch ends the call before the request runs: -32020 in mcp-error-bin' },
			{ file: 'src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts', test: 'typed metadata that disagrees with the message is -32020, an unsupported version -32022' },
		],
	},
];

function cell(text: string): string {
	return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function code(text: string): string {
	return '`' + text.replace(/`/g, '\'') + '`';
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

function scenarioKey(leg: Leg, revision: string, scenario: string): string {
	return `${leg} ${revision} ${scenario}`;
}

/** Renders docs/mcp-conformance-matrix.md. */
export function renderConformanceMatrix(input: ICheckMatrixInput, model: IRequirementModel = loadRequirementModel(input, [])): string {
	const mappings = new Map(model.mappings.map(mapping => [mapping.id, mapping]));
	const statusOf = (requirement: IRequirement): MappingStatus | undefined => mappings.get(requirement.id)?.status;
	const out: string[] = [];
	const push = (...lines: string[]) => out.push(...lines);
	const site = typeof model.specification.site === 'string' ? model.specification.site : 'https://modelcontextprotocol.io/specification/2026-07-28';
	const revision = typeof model.requirementsFile === 'string' ? model.requirementsFile.replace(/^requirements-(.*)\.json$/, '$1') : '';

	push(
		'# MCP conformance matrix',
		'',
		`<!-- Generated by \`node test/mcp-conformance/run.ts render-matrix\` from ${model.requirementsFile}, ${REQUIREMENT_TESTS_FILE} and ${MATRIX_FILE}. Do not edit: \`check-matrix\` fails when this file is not current. -->`,
		'',
		`How VS Code conforms to the [MCP ${revision} specification](${site}): every normative sentence of the specification with the tests and the conformance scenarios that cover it, the results of the official conformance suite (\`${model.harness}\`) per scenario, and the deliberate deviations. VS Code is measured in two roles: as an MCP **client** (the workbench protocol engine, the extension-host transports and the OAuth client) and as an MCP **server** (the MCP gateway that serves VS Code's MCP servers to Copilot CLI over HTTP and gRPC).`,
		'',
		`The requirements are the ${model.requirements.length} sentences of ${code(String(model.source.path ?? 'requirements.zon'))} of [${String(model.source.name ?? 'zig-sdk')}](${String(model.source.repo ?? '')}) ${String(model.source.version ?? '')} (${String(model.source.license ?? '')}), quoted from the specification at commit ${code(String(model.specification.commit ?? ''))}. A requirement's party says who it binds: the client, the server, both, or an authorization server.`,
		'',
		'## Summary',
		'',
	);

	const counts = (filter: (requirement: IRequirement) => boolean) => {
		const selected = model.requirements.filter(filter);
		return [String(selected.length), ...MAPPING_STATUSES.map(status => String(selected.filter(requirement => statusOf(requirement) === status).length))];
	};
	push(`| Level | Requirements | ${MAPPING_STATUSES.map(status => STATUS_NAMES[status]).join(' | ')} |`, `| --- | --- |${MAPPING_STATUSES.map(() => ' --- |').join('')}`);
	for (const level of REQUIREMENT_LEVELS) {
		push(`| ${LEVEL_NAMES[level]} | ${counts(requirement => requirement.level === level).join(' | ')} |`);
	}
	push(`| **All** | ${counts(() => true).join(' | ')} |`, '');
	push(`| Party | Requirements | ${MAPPING_STATUSES.map(status => STATUS_NAMES[status]).join(' | ')} |`, `| --- | --- |${MAPPING_STATUSES.map(() => ' --- |').join('')}`);
	for (const party of REQUIREMENT_PARTIES) {
		push(`| ${PARTY_NAMES[party]} | ${counts(requirement => requirement.party === party).join(' | ')} |`);
	}
	push('');

	push(
		'| Status | Meaning |',
		'| --- | --- |',
		'| tested | The cited tests or conformance scenarios cover the requirement. |',
		'| partial | The cited tests cover a part of the requirement; the reason names the part no test covers. |',
		'| deviation | VS Code deliberately behaves otherwise; the reason explains it and the cited tests pin the behaviour (a MUST or MUST NOT always cites one). |',
		'| gap | No automated test covers the requirement; the reason says what VS Code does. A MUST or MUST NOT is never a gap. |',
		'| n/a | The requirement does not apply to VS Code; the reason says why. |',
		'',
		'## Deliberate deviations',
		'',
	);
	for (const deviation of NOTED_DEVIATIONS) {
		push(`- **${deviation.title}.** ${deviation.text}`);
	}
	const deviations = model.requirements.filter(requirement => statusOf(requirement) === 'deviation');
	if (deviations.length > 0) {
		push('', '| ID | Party | Level | Requirement | Deviation |', '| --- | --- | --- | --- | --- |');
		for (const requirement of deviations) {
			push(`| ${code(requirement.id)} | ${PARTY_NAMES[requirement.party]} | ${LEVEL_NAMES[requirement.level]} | ${cell(requirement.text)} | ${cell(mappings.get(requirement.id)?.reason ?? '')} |`);
		}
	}
	push(
		'',
		'## Supported JSON Schema dialects',
		'',
		'VS Code validates schemas with its own validator (`src/vs/base/common/jsonSchemaValidator`):',
		'',
		'| Dialect | `$schema` | Support |',
		'| --- | --- | --- |',
		'| JSON Schema 2020-12 (the default) | absent, or `https://json-schema.org/draft/2020-12/schema` (with or without `#`) | The required tests of the official JSON Schema Test Suite pass, except the groups of its skip list (`jsonSchemaTestSuite.test.ts`); `format` is an annotation. |',
		'| JSON Schema draft-07 | `http://json-schema.org/draft-07/schema` or its `https` form (with or without `#`) | The required draft-07 tests pass, except the groups of the skip list; `$ref` siblings are ignored, as draft-07 says. |',
		'| Any other dialect | anything else | Rejected with an error that names the dialect. |',
		'',
		'A `$ref` to a network URI is never fetched: it is a compile error. Validation is bounded in depth, subschemas, reference hops, evaluation steps and time.',
		'',
		'## Features and extensions',
		'',
		'| Feature | Status | Notes |',
		'| --- | --- | --- |',
		...FEATURE_ROWS.map(row => `| ${cell(row.feature)} | ${row.status} | ${cell(row.notes)} |`),
		'',
		'## The typed gRPC binding',
		'',
		'A gRPC server is reached through one of two bindings (`binding` in `mcp.json`). `auto`, the default, is the tunnel, exactly as `tunnel`: MCP requires a custom transport to keep the JSON-RPC message format, so VS Code never switches to the typed service on its own and speaks it only with `binding: "typed"`. A gRPC server that answers the tunnel\'s `server/discover` with a bare `UNIMPLEMENTED` fails to start with an error that names `"binding": "typed"` (this supersedes decision 11 of the plan, a tunnel-first probe with a typed fallback). The tunnel carries every JSON-RPC message; the typed service of the reference proto carries less:',
		'',
		'| Feature | Tunnel (`mcp.zig.transport.v1.Mcp`) | Typed (`model_context_protocol.Mcp`) |',
		'| --- | --- | --- |',
		...GRPC_BINDING_CAPABILITIES.map(row => `| ${cell(row.feature)} | ${cell(row.tunnel)} | ${cell(row.typed)} |`),
		'',
		'## The gateway gRPC listener: `grpc_server.zig` parity',
		'',
		'How the gateway gRPC listener checks a call, step by step, next to zig-sdk\'s `src/grpc/transport/grpc_server.zig` (`handleStreamInner`), the gRPC server of the reference implementation. A call that fails a step gets that step\'s answer and goes no further. [gateway-threats.md](../gateway-threats.md) maps the threat model of zig-sdk to the gateway\'s tests.',
		'',
		'| Step | `grpc_server.zig` | Gateway | Tests |',
		'| --- | --- | --- | --- |',
		...GRPC_SERVER_PARITY.map(row => `| ${cell(row.step)} | ${cell(row.zig)} | ${cell(row.gateway)} | ${row.tests.map(test => `${code(test.file.replace(/^.*\//, ''))} ${cell(test.test)}`).join('<br>')} |`),
		'',
		'## Conformance scenarios',
		'',
		`Every scenario of the suite's requirement sets, per leg and revision, from ${MATRIX_FILE}: \`driven\` (a fixture of this repository runs it and every check passes), \`gap\` (it runs; its failing checks are baselined) or \`n-a\`. The last column counts the requirement rows that cite the scenario.`,
		'',
	);

	const citing = new Map<string, number>();
	for (const mapping of model.mappings) {
		for (const key of new Set(mapping.scenarios.map(citation => scenarioKey(citation.leg, citation.revision, citation.scenario)))) {
			citing.set(key, (citing.get(key) ?? 0) + 1);
		}
	}
	const legs: readonly Leg[] = ['client', 'server'];
	for (const leg of legs) {
		for (const set of input.sets) {
			const scenarios = [...scoredScenarios(set, leg), ...notScoredScenarios(set, leg)];
			push(`### ${leg === 'client' ? 'Client' : 'Server'} leg, ${set.revision} (${scenarios.length} scenarios)`, '', '| Scenario | Scoring | Status | Requirements | Notes |', '| --- | --- | --- | --- | --- |');
			for (const scenario of scenarios) {
				const row = input.matrix.find(candidate => candidate.leg === leg && candidate.revision === set.revision && candidate.scenario === scenario);
				const scoring = scoredScenarios(set, leg).includes(scenario) ? 'scored' : 'not scored';
				push(`| ${code(scenario)} | ${scoring} | ${row?.status ?? 'missing'} | ${citing.get(scenarioKey(leg, set.revision, scenario)) ?? 0} | ${cell(row?.notes ?? '')} |`);
			}
			push('');
		}
	}
	push('### Authorization-server leg', '', 'The suite\'s `authorization` command tests an authorization server. It is not run.', '', '| Scenario | Status | Reason |', '| --- | --- | --- |');
	for (const row of AUTHORIZATION_SERVER_SCENARIOS) {
		push(`| ${code(row.scenario)} | n/a | ${cell(row.reason)} |`);
	}
	push('', '## Requirements', '', 'One table per page of the specification. Test citations name the file under `src/` or `test/` and the test; scenario citations name the leg, the revision and the scenario (and a check of it).', '');

	const pages: string[] = [];
	for (const requirement of model.requirements) {
		if (!pages.includes(requirement.page)) {
			pages.push(requirement.page);
		}
	}
	for (const page of pages) {
		const rows = model.requirements.filter(requirement => requirement.page === page);
		push(`### [${page}](${site}/${page === 'index' ? '' : page}) (${rows.length})`, '', '| ID | Party | Level | Status | Requirement | Coverage |', '| --- | --- | --- | --- | --- | --- |');
		for (const requirement of rows) {
			const mapping = mappings.get(requirement.id);
			const coverage: string[] = [];
			for (const test of mapping?.tests ?? []) {
				coverage.push(`${code(test.file.replace(/^.*\//, ''))} ${cell(test.test)}`);
			}
			for (const citation of mapping?.scenarios ?? []) {
				coverage.push(`conformance ${citation.leg} ${citation.revision} ${code(citation.scenario)}${citation.check ? ` (${code(citation.check)})` : ''}`);
			}
			if (mapping?.reason) {
				coverage.push(`*${mapping.status === 'n-a' ? 'Not applicable' : 'Reason'}:* ${cell(mapping.reason)}`);
			}
			if (mapping?.note) {
				coverage.push(`*Note:* ${cell(mapping.note)}`);
			}
			const anchor = requirement.anchor ? `[${code(requirement.id.replace(/^.*#/, '#'))}](${site}/${page === 'index' ? '' : page}#${requirement.anchor})` : code(requirement.id);
			push(`| ${anchor} | ${PARTY_NAMES[requirement.party]} | ${LEVEL_NAMES[requirement.level]} | ${mapping ? STATUS_NAMES[mapping.status] : 'unmapped'} | ${cell(requirement.text)} | ${coverage.join('<br>')} |`);
		}
		push('');
	}
	return out.join('\n');
}

// #endregion

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(file, 'utf8'));
}

function readOptional(file: string): string | undefined {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * Reads every input of the matrix check from the harness folder, the
 * repository, the installed suite and, when there is one, the zig-sdk checkout
 * the requirements come from (`ZIG_SDK_DIR`, else `zig-sdk` next to the repository).
 */
export function readCheckMatrixInput(dir: string = HERE, root: string = ROOT, suiteDir: string = SUITE_DIR, zigSdk: string = zigSdkCheckout(root, process.env)): ICheckMatrixInput {
	const baselines = new Map<string, IBaselineEntries>();
	const requirementFiles = new Map<string, unknown>();
	for (const name of readdirSync(dir)) {
		if (/^expected-failures-.*\.yml$/.test(name)) {
			baselines.set(name, parseBaselineFile(readFileSync(path.join(dir, name), 'utf8')));
		} else if (/^requirements-.*\.json$/.test(name)) {
			requirementFiles.set(name, readJson(path.join(dir, name)));
		}
	}
	const requirementSources = new Map<string, ZonRead>();
	for (const [name, file] of requirementFiles) {
		const source = isRecord(file) && isRecord(file.source) ? file.source : undefined;
		if (typeof source?.commit === 'string') {
			requirementSources.set(name, existsSync(zigSdk) ? readZonAtCommit(zigSdk, source.commit) : { kind: 'unavailable', reason: `there is no zig-sdk checkout at ${zigSdk} (set ZIG_SDK_DIR)` });
		}
	}
	const packageJson = readJson(path.join(dir, 'package.json'));
	const devDependencies = isRecord(packageJson) && isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {};
	const pinned = devDependencies['@modelcontextprotocol/conformance'];
	const bundle = readOptional(path.join(suiteDir, 'dist', 'index.js'));
	return {
		matrix: parseMatrix(readFileSync(path.join(dir, MATRIX_FILE), 'utf8')),
		sets: loadRequirementSets(suiteDir),
		baselines,
		requirementFiles,
		requirementTests: readJson(path.join(dir, REQUIREMENT_TESTS_FILE)),
		pinnedSuiteVersion: typeof pinned === 'string' ? pinned : undefined,
		readFile: relativePath => readOptional(path.join(root, relativePath)),
		suite: bundle === undefined ? undefined : parseSuiteInventory(bundle),
		renderedMatrix: readOptional(path.join(dir, RENDERED_MATRIX_FILE)) ?? null,
		requirementSources,
		gatewayThreats: readOptional(path.join(dir, GATEWAY_THREATS_FILE)) ?? null,
		grpcServerParity: GRPC_SERVER_PARITY,
		scenarioDrivers: readOptional(path.join(root, SCENARIO_DRIVERS_FILE)) ?? null,
	};
}

/** Notices about checks that could not run: a requirements file whose zig-sdk source cannot be read. */
export function skippedChecks(input: ICheckMatrixInput): string[] {
	return [...input.requirementSources ?? []].flatMap(([file, read]) => read.kind === 'unavailable' ? [`notice: not checking that ${file} is the conversion of its zig-sdk source: ${read.reason}`] : []);
}

export function runCheckMatrix(log: (line: string) => void, dir: string = HERE, root: string = ROOT, suiteDir: string = SUITE_DIR): number {
	const input = readCheckMatrixInput(dir, root, suiteDir);
	for (const notice of skippedChecks(input)) {
		log(`[check-matrix] ${notice}`);
	}
	const problems = checkMatrix(input);
	for (const problem of problems) {
		log(`[check-matrix] ${problem}`);
	}
	log(problems.length === 0 ? '[check-matrix] the matrix, the baselines, the requirement mapping and the rendered matrix agree' : `[check-matrix] ${problems.length} problem(s)`);
	return problems.length === 0 ? 0 : 1;
}

/** Writes docs/mcp-conformance-matrix.md, then reports the problems of the mapping (the rendered file is current by construction). */
export function runRenderMatrix(log: (line: string) => void, dir: string = HERE, root: string = ROOT, suiteDir: string = SUITE_DIR): number {
	const input = readCheckMatrixInput(dir, root, suiteDir);
	const target = path.join(dir, RENDERED_MATRIX_FILE);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, renderConformanceMatrix(input));
	log(`[render-matrix] wrote ${path.relative(root, target)}`);
	const problems = checkMatrix({ ...input, renderedMatrix: undefined });
	for (const problem of problems) {
		log(`[render-matrix] ${problem}`);
	}
	return problems.length === 0 ? 0 : 1;
}

// #endregion

// #region main

/** The `READY:<url>` line of the gateway fixture, if the output has one yet. */
export function parseReadyLine(output: string): string | undefined {
	return /^READY:(\S+)\s*$/m.exec(output)?.[1];
}

function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === 'EPERM';
	}
}

function runSuiteProcess(args: readonly string[], env: Env, timeoutMs: number, killTree: (pid: number) => void): Promise<ISuiteRun> {
	return new Promise(resolve => {
		const child = spawn(process.execPath, suiteProcessArgs(args), { cwd: ROOT, env: env as Record<string, string>, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) {
				killTree(child.pid);
			}
		}, timeoutMs);
		// decoded as streams, so a character split across chunks stays whole (the client exits are matched by the output they quote)
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			output += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on('data', (chunk: string) => {
			output += chunk;
			process.stderr.write(chunk);
		});
		child.on('error', error => {
			clearTimeout(timer);
			resolve({ exitCode: -1, output: `${output}\n${error.message}`, timedOut });
		});
		child.on('close', code => {
			clearTimeout(timer);
			resolve({ exitCode: code ?? -1, output, timedOut });
		});
	});
}

function startGateway(logFile: string, killTree: (pid: number) => void): Promise<IServerHandle> {
	const main = path.join(ROOT, SERVER_MAIN);
	if (!existsSync(main)) {
		return Promise.reject(new Error(`${SERVER_MAIN} does not exist: run npm run transpile-client (the gateway fixture is milestone M6)`));
	}
	const child = spawn(process.execPath, [...nodeProcessFlags(), main, '--log', logFile], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
	const stop = () => new Promise<void>(resolve => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		const force = setTimeout(() => {
			if (child.pid !== undefined) {
				killTree(child.pid);
			}
		}, 5_000);
		child.once('exit', () => {
			clearTimeout(force);
			resolve();
		});
		child.stdin.end(); // the fixture exits on stdin EOF
		child.kill('SIGTERM');
	});
	return new Promise((resolve, reject) => {
		let output = '';
		const fail = (message: string) => {
			clearTimeout(timer);
			void stop().then(() => reject(new Error(message)));
		};
		const timer = setTimeout(() => fail(`the gateway fixture printed no READY:<url> within ${READY_TIMEOUT_MS}ms`), READY_TIMEOUT_MS);
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			const url = parseReadyLine(output);
			if (url !== undefined) {
				clearTimeout(timer);
				resolve({ url, stop });
			}
		});
		child.once('exit', code => fail(`the gateway fixture exited (${code}) before it was ready`));
		child.once('error', error => fail(`the gateway fixture did not start: ${error.message}`));
	});
}

export function defaultDeps(): IHarnessDeps {
	const killTree = createKillTree(process.platform, (command, args, options) => spawnSync(command, args, options), (pid, signal) => process.kill(pid, signal));
	return {
		platform: process.platform,
		runSuite: (args, env, timeoutMs) => runSuiteProcess(args, env, timeoutMs, killTree),
		killTree,
		isAlive: defaultIsAlive,
		startServer: logFile => startGateway(logFile, killTree),
		log: line => console.log(line),
	};
}

function formatCounts(counts: ICounts | undefined): string {
	return counts ? `${counts.passed} passed, ${counts.failed} failed, ${counts.warnings ?? '?'} warnings` : 'no counts';
}

function summarize(results: readonly IInvocationResult[], log: (line: string) => void): void {
	log('\n=== MCP conformance summary ===');
	for (const result of results) {
		const { invocation, verdict } = result;
		const baselined = verdict.expected.length > 0 ? `, ${verdict.expected.length} baselined` : '';
		const timeouts = result.clientTimeouts > 0 ? `, ${result.clientTimeouts} client timeout(s)` : '';
		log(`${result.passed ? 'PASS' : 'FAIL'}  ${invocation.label}: ${formatCounts(result.counts)}${baselined}${timeouts}${result.note ? ` (${result.note})` : ''}`);
		for (const entry of verdict.unexpected) {
			log(`        unexpected failure: ${entry}`);
		}
		for (const entry of verdict.stale) {
			log(`        stale baseline entry (now passing): ${entry}`);
		}
		for (const problem of result.clientExits) {
			log(`        client: ${problem}`);
		}
	}
}

export async function main(argv: readonly string[], env: Env, deps: IHarnessDeps = defaultDeps(), cwd: string = process.cwd()): Promise<number> {
	const parsed = parseArgs(argv, env, cwd);
	if (parsed.kind === 'help') {
		deps.log(USAGE);
		return 0;
	}
	if (parsed.kind === 'error') {
		deps.log(`${parsed.error}\n\n${USAGE}`);
		return 2;
	}
	const { options } = parsed;
	if (!existsSync(SUITE_BIN)) {
		deps.log(`The conformance suite is not installed: npm ci --prefix test/mcp-conformance --no-audit --no-fund`);
		return 2;
	}
	if (options.subcommand === 'check-matrix') {
		return runCheckMatrix(deps.log);
	}
	if (options.subcommand === 'render-matrix') {
		return runRenderMatrix(deps.log);
	}

	const sets = loadRequirementSets();
	const suite = parseSuiteInventory(readFileSync(SUITE_BIN, 'utf8'));
	const legs: readonly Leg[] = options.subcommand === 'all' ? ['client', 'server'] : [options.subcommand];
	const results: IInvocationResult[] = [];
	const updater = options.updateBaseline ? new BaselineUpdater() : undefined;
	let broken = false;
	mkdirSync(options.out, { recursive: true });

	for (const leg of legs) {
		let server: IServerHandle | undefined;
		if (leg === 'client') {
			if (!existsSync(path.join(ROOT, CLIENT_MAIN))) {
				deps.log(`${CLIENT_MAIN} does not exist: run npm run transpile-client`);
				return 2;
			}
		} else if (options.skipServer) {
			deps.log('[mcp-conformance] skipping the server leg (--skip-server)');
			continue;
		}
		let serverUrl = options.serverUrl;
		try {
			if (leg === 'server' && serverUrl === undefined) {
				server = await deps.startServer(path.join(options.out, 'gateway.log'));
				serverUrl = server.url;
				deps.log(`[mcp-conformance] the gateway fixture listens at ${serverUrl}`);
			}
			const context: IPlanContext = { options, sets, baselineDir: HERE, clientCommand: clientCommand(ROOT), serverUrl, clientErrorAllowed: suite.clientErrorAllowed };
			for (const invocation of planLeg(leg, context)) {
				if (!existsSync(invocation.baseline)) {
					if (!updater) {
						deps.log(`${path.relative(ROOT, invocation.baseline)} does not exist (create it, or run with --update-baseline)`);
						broken = true;
						continue;
					}
					writeFileSync(invocation.baseline, `${leg}: []\n`);
				}
				const result = await runInvocation(invocation, env, deps);
				results.push(result);
				if (updater) {
					const missing = updater.record(invocation, readResults(invocation.outDir, leg));
					if (missing.length > 0) {
						deps.log(`[mcp-conformance] no results for ${missing.join(', ')}: the baseline keeps their entries`);
						broken = true;
					}
				}
			}
		} catch (error) {
			deps.log(`[mcp-conformance] the ${leg} leg failed: ${error instanceof Error ? error.message : String(error)}`);
			broken = true;
		} finally {
			await server?.stop();
		}
	}

	applyTimingReruns(results);
	summarize(results, deps.log);
	writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(results.map(result => ({
		label: result.invocation.label,
		leg: result.invocation.leg,
		revision: result.invocation.revision,
		kind: result.invocation.kind,
		scenario: result.invocation.scenario,
		args: result.invocation.args,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		passed: result.passed,
		note: result.note,
		counts: result.counts,
		verdict: result.verdict,
		clientTimeouts: result.clientTimeouts,
		clientExits: result.clientExits,
	})), undefined, '\t'));

	if (updater) {
		for (const change of updater.write()) {
			const name = path.relative(ROOT, change.file);
			if (change.added.length === 0 && change.removed.length === 0) {
				deps.log(`[mcp-conformance] ${name}: unchanged`);
			}
			for (const entry of change.added) {
				deps.log(`[mcp-conformance] ${name}: + ${entry}`);
			}
			for (const entry of change.removed) {
				deps.log(`[mcp-conformance] ${name}: - ${entry}`);
			}
		}
		return broken || results.some(result => result.timedOut) ? 1 : 0;
	}
	return broken || results.some(result => !result.passed) ? 1 : 0;
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
	main(process.argv.slice(2), process.env).then(code => {
		process.exitCode = code;
	}, (error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}

// #endregion
