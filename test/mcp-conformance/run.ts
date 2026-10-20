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
 *   node test/mcp-conformance/run.ts client|server|all|check-matrix [options]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, parseDocument } from 'yaml';

export const REVISIONS = ['2026-07-28', '2025-11-25'] as const;
export type Revision = typeof REVISIONS[number];
export type Leg = 'client' | 'server';
export type Subcommand = 'client' | 'server' | 'all' | 'check-matrix';
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

export function scoredBaseline(leg: Leg, revision: Revision): string {
	return `expected-failures-${leg}-${revision}.yml`;
}

export function isRevision(value: string): value is Revision {
	return (REVISIONS as readonly string[]).includes(value);
}

const USAGE = [
	'Usage: node test/mcp-conformance/run.ts <client|server|all|check-matrix> [options]',
	'',
	'  client         run the scored client scenarios of each revision (--unscored: the not-scored loop instead)',
	'  server         the same for the server leg, against the gateway fixture (skipped by default)',
	'  all            both legs, scored and not scored',
	'  check-matrix   check requirement-matrix.md and requirement-tests.json against the suite and the baselines',
	'',
	'Options:',
	`  --requirements <rev>[,<rev>]  revisions to run (default: ${REVISIONS.join(',')})`,
	'  --unscored                    run the not-scored scenarios one by one (--force) instead of the scored sets',
	'  --scenario <name>             run one scenario of the leg (with --spec-version, or at every revision that lists it)',
	'  --spec-version <rev>          the revision of --scenario',
	'  --server-url <url>            run the server leg against this server instead of starting the gateway fixture',
	'  --skip-server[=true|false]    skip the server leg (default: true unless --server-url is given); --no-skip-server',
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

const SUBCOMMANDS: readonly Subcommand[] = ['client', 'server', 'all', 'check-matrix'];
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
	if (scenario !== undefined && (subcommand === 'all' || subcommand === 'check-matrix')) {
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
}

/**
 * The `--command` the suite spawns: `node <abs>/out/.../mcpConformanceClientMain.js`.
 * The suite splits the command on spaces, so a root with whitespace falls back
 * to the path relative to the root, which is the suite's working directory.
 */
export function clientCommand(root: string): string {
	const absolute = path.join(root, CLIENT_MAIN).split(path.sep).join('/');
	return /\s/.test(absolute) ? `node ${CLIENT_MAIN}` : `node ${absolute}`;
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
	const crashedAfterVerdict = !run.timedOut && isExitCrashAfterPassingVerdict(run.exitCode, run.output);
	return {
		invocation,
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		counts: countChecks(readResults(invocation.outDir, invocation.leg)) ?? parseCounts(run.output),
		verdict,
		clientTimeouts: countClientTimeouts(run.output),
		passed: (run.exitCode === 0 && !run.timedOut) || crashedAfterVerdict,
		note: run.timedOut ? 'the suite did not finish in time and was killed'
			: crashedAfterVerdict ? `the suite aborted in libuv while exiting (${run.exitCode}), after its baseline check passed` : undefined,
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

/**
 * A scored run that fails only on timing scenarios passes when those scenarios
 * pass when they run alone: in the parallel requirement run they compete with
 * every other scenario for the event loop.
 */
export function applyTimingReruns(results: readonly IInvocationResult[]): void {
	for (const scored of results) {
		if (scored.invocation.kind !== 'scored' || scored.passed || scored.timedOut) {
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
	/** Whether a repository-relative file exists. */
	readonly fileExists: (relativePath: string) => boolean;
}

function baselineFor(input: ICheckMatrixInput, file: string, leg: Leg): readonly string[] {
	const entries = input.baselines.get(file);
	return entries ? (leg === 'client' ? entries.client : entries.server) : [];
}

/** Checks the matrix and the requirement mapping; returns the problems found. */
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

	problems.push(...checkRequirementTests(input, rows));
	return problems;
}

function checkRequirementTests(input: ICheckMatrixInput, rows: ReadonlyMap<string, IMatrixRow>): string[] {
	const problems: string[] = [];
	const tests = input.requirementTests;
	if (!isRecord(tests)) {
		return [`${REQUIREMENT_TESTS_FILE} is not a JSON object`];
	}
	if (input.pinnedSuiteVersion !== undefined && tests.harness !== `@modelcontextprotocol/conformance@${input.pinnedSuiteVersion}`) {
		problems.push(`${REQUIREMENT_TESTS_FILE}: harness ${String(tests.harness)} is not the pinned @modelcontextprotocol/conformance@${input.pinnedSuiteVersion}`);
	}
	const requirementIds = new Set<string>();
	const requirementsFile = typeof tests.requirements === 'string' ? tests.requirements : '';
	const requirements = input.requirementFiles.get(requirementsFile);
	if (!isRecord(requirements) || !Array.isArray(requirements.requirements)) {
		problems.push(`${REQUIREMENT_TESTS_FILE}: requirements names ${requirementsFile || 'no file'}, which is not a requirements file of this folder`);
	} else {
		for (const requirement of requirements.requirements) {
			if (isRecord(requirement) && typeof requirement.id === 'string') {
				if (requirementIds.has(requirement.id)) {
					problems.push(`${requirementsFile}: ${requirement.id} is listed twice`);
				}
				requirementIds.add(requirement.id);
			} else {
				problems.push(`${requirementsFile}: a requirement without an id`);
			}
		}
	}
	const mappings = Array.isArray(tests.mappings) ? tests.mappings : [];
	if (!Array.isArray(tests.mappings)) {
		problems.push(`${REQUIREMENT_TESTS_FILE}: mappings must be a list`);
	}
	const mapped = new Set<string>();
	for (const mapping of mappings) {
		if (!isRecord(mapping) || typeof mapping.id !== 'string') {
			problems.push(`${REQUIREMENT_TESTS_FILE}: a mapping without an id`);
			continue;
		}
		const where = `${REQUIREMENT_TESTS_FILE}: ${mapping.id}`;
		if (mapped.has(mapping.id)) {
			problems.push(`${where} is mapped twice`);
		}
		mapped.add(mapping.id);
		if (requirementIds.size > 0 && !requirementIds.has(mapping.id)) {
			problems.push(`${where} is not a requirement of ${requirementsFile}`);
		}
		const status = mapping.status ?? 'tested';
		const citations = Array.isArray(mapping.tests) ? mapping.tests.filter((test): test is string => typeof test === 'string') : [];
		if (status === 'tested') {
			if (citations.length === 0) {
				problems.push(`${where} is tested but cites no test`);
			}
		} else if (status === 'gap' || status === 'n-a') {
			if (typeof mapping.reason !== 'string' || mapping.reason.trim() === '') {
				problems.push(`${where} is ${status} without a reason`);
			}
		} else {
			problems.push(`${where}: status ${String(status)} is not one of tested, gap, n-a`);
		}
		for (const citation of citations) {
			const conformance = /^conformance:(client|server)\/(.+)$/.exec(citation);
			if (conformance) {
				const driven = [...rows.values()].some(row => row.leg === conformance[1] && row.scenario === conformance[2] && row.status === 'driven');
				if (!driven) {
					problems.push(`${where} cites ${citation}, which no driven ${MATRIX_FILE} row covers`);
				}
				continue;
			}
			const file = citation.replace(/:.*$/, '');
			if (!input.fileExists(file)) {
				problems.push(`${where} cites ${file}, which does not exist`);
			}
		}
	}
	return problems;
}

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(file, 'utf8'));
}

export function runCheckMatrix(log: (line: string) => void, dir: string = HERE, root: string = ROOT, suiteDir: string = SUITE_DIR): number {
	const baselines = new Map<string, IBaselineEntries>();
	const requirementFiles = new Map<string, unknown>();
	for (const name of readdirSync(dir)) {
		if (/^expected-failures-.*\.yml$/.test(name)) {
			baselines.set(name, parseBaselineFile(readFileSync(path.join(dir, name), 'utf8')));
		} else if (/^requirements-.*\.json$/.test(name)) {
			requirementFiles.set(name, readJson(path.join(dir, name)));
		}
	}
	const packageJson = readJson(path.join(dir, 'package.json'));
	const devDependencies = isRecord(packageJson) && isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {};
	const pinned = devDependencies['@modelcontextprotocol/conformance'];
	const problems = checkMatrix({
		matrix: parseMatrix(readFileSync(path.join(dir, MATRIX_FILE), 'utf8')),
		sets: loadRequirementSets(suiteDir),
		baselines,
		requirementFiles,
		requirementTests: readJson(path.join(dir, REQUIREMENT_TESTS_FILE)),
		pinnedSuiteVersion: typeof pinned === 'string' ? pinned : undefined,
		fileExists: relativePath => existsSync(path.join(root, relativePath)),
	});
	for (const problem of problems) {
		log(`[check-matrix] ${problem}`);
	}
	log(problems.length === 0 ? '[check-matrix] the matrix, the baselines and the requirement mapping agree' : `[check-matrix] ${problems.length} problem(s)`);
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
		const child = spawn(process.execPath, [SUITE_BIN, ...args], { cwd: ROOT, env: env as Record<string, string>, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) {
				killTree(child.pid);
			}
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString();
			process.stdout.write(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString();
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
	const child = spawn(process.execPath, [main, '--log', logFile], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
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

	const sets = loadRequirementSets();
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
			const context: IPlanContext = { options, sets, baselineDir: HERE, clientCommand: clientCommand(ROOT), serverUrl };
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
