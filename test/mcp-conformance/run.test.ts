/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests of the harness with the suite stubbed out: how the options map to the
 * suite's flags, the not-scored loop, timeouts, the baseline refusal on CI,
 * the leftover-client kill, the output parsing, the baseline update, the
 * matrix and requirement-mapping check and the rendering of the matrix; also
 * that the files naming the suite name its pinned version and that the CI
 * path filters of the MCP checks cover the MCP sources. Run with `node --test test/mcp-conformance/run.test.ts`.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, suite, test } from 'node:test';
import {
	applyTimingReruns, AUTHORIZATION_SERVER_SCENARIOS, BaselineUpdater, checkMatrix, CLIENT_MAIN, clientCommand, clientExitProblems, countChecks, countClientTimeouts, createKillTree, DEFAULT_OUT, DEFAULT_TIMEOUT_MS,
	entryScenario, extractTestNames, failingCheckIds, HERE, type IBaselineEntries, type ICheckMatrixInput, type IHarnessDeps, type IInvocation, type IInvocationResult,
	INVOCATION_TIMEOUT_FACTOR, type IOptions, isExitCrashAfterPassingVerdict, type IPlanContext, type IRequirementSet, type ISuiteRun, killLeftovers, main, type Env, nodeProcessFlags, parseArgs,
	parseBaselineFile, parseBaselineVerdict, parseClientExits, parseCounts, parseGatewayThreats, parseMatrix, parseReadyLine, parseRequirementSet, parseScenarioDrivers, parseSuiteInventory, PID_DIR_ENV, planLeg, planScenario, planScored,
	planUnscored, readCheckMatrixInput, readResults, renderConformanceMatrix, resultScenario, ROOT, runInvocation, scanTestDeclarations, scoredBaseline, skippedChecks, SUITE_BIN, SUITE_DIR, suiteProcessArgs, UNSCORED_BASELINE, updatedEntries,
	EXTENSION_SCENARIOS, type IExtensionRequirement, type IExtensionScenario,
} from './run.ts';
import { convertRequirements, formatRequirementsJson, parseZon, readZonAtCommit, requirementsRevision, ZonEnum, type ZonRead } from './tools/convert-requirements.ts';

const CWD = path.resolve(path.sep, 'work');

function options(argv: readonly string[], env: Env = {}): IOptions {
	const parsed = parseArgs(argv, env, CWD);
	assert.strictEqual(parsed.kind, 'options', parsed.kind === 'error' ? parsed.error : parsed.kind);
	return parsed.options;
}

function parseError(argv: readonly string[], env: Env = {}): string {
	const parsed = parseArgs(argv, env, CWD);
	assert.strictEqual(parsed.kind, 'error');
	return parsed.error;
}

const SETS: readonly IRequirementSet[] = [
	{
		revision: '2026-07-28',
		client: ['tools_call', 'request-metadata', 'auth/metadata-default'],
		server: ['server-stateless', 'tools-list'],
		notScored: [
			{ scenario: 'auth/dpop', leg: 'client', reason: 'extension' },
			{ scenario: 'json-schema-2020-12-preservation', leg: 'client', reason: 'added-after-release' },
			{ scenario: 'tasks-lifecycle', leg: 'server', reason: 'extension' },
		],
	},
	{
		revision: '2025-11-25',
		client: ['initialize', 'tools_call', 'sse-retry', 'auth/metadata-default'],
		server: ['server-initialize'],
		notScored: [
			{ scenario: 'auth/dpop', leg: 'client', reason: 'extension' },
			{ scenario: 'json-schema-2020-12-preservation', leg: 'client', reason: 'added-after-release' },
			{ scenario: 'server-sse-polling', leg: 'server', reason: 'pending' },
		],
	},
];

const BASELINES = path.resolve(path.sep, 'baselines');
const COMMAND = 'node /repo/out/vs/workbench/api/node/mcpConformanceClientMain.js';
const SERVER_URL = 'http://127.0.0.1:4321/mcp';

function context(argv: readonly string[], env: Env = {}): IPlanContext {
	return { options: options(argv, env), sets: SETS, baselineDir: BASELINES, clientCommand: COMMAND, serverUrl: SERVER_URL };
}

function flag(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

suite('options', () => {
	test('defaults: both revisions, the 60 s timeout, the .build results folder, the server leg on', () => {
		const parsed = options(['client']);
		assert.deepStrictEqual(parsed, {
			subcommand: 'client',
			revisions: ['2026-07-28', '2025-11-25'],
			unscored: false,
			scenario: undefined,
			specVersion: undefined,
			serverUrl: undefined,
			out: DEFAULT_OUT,
			timeout: DEFAULT_TIMEOUT_MS,
			updateBaseline: false,
			skipServer: false,
		});
		assert.strictEqual(DEFAULT_TIMEOUT_MS, 60_000);
		assert.strictEqual(DEFAULT_OUT, path.join(ROOT, '.build', 'conformance-results'));
	});

	test('--requirements selects revisions, in the given order, with or without =', () => {
		assert.deepStrictEqual(options(['client', '--requirements', '2026-07-28']).revisions, ['2026-07-28']);
		assert.deepStrictEqual(options(['all', '--requirements=2025-11-25,2026-07-28']).revisions, ['2025-11-25', '2026-07-28']);
		assert.match(parseError(['client', '--requirements', '2024-11-05']), /Unknown revision 2024-11-05/);
		assert.match(parseError(['client', '--requirements']), /--requirements needs a value/);
	});

	test('--scenario, --spec-version and --unscored', () => {
		const parsed = options(['client', '--scenario', 'tools_call', '--spec-version', '2025-11-25']);
		assert.strictEqual(parsed.scenario, 'tools_call');
		assert.strictEqual(parsed.specVersion, '2025-11-25');
		assert.match(parseError(['client', '--spec-version', '2025-11-25']), /--spec-version selects the revision of --scenario/);
		assert.match(parseError(['client', '--scenario', 'x', '--spec-version', 'draft']), /Unknown revision draft/);
		assert.match(parseError(['all', '--scenario', 'x']), /needs the client or server subcommand/);
		assert.match(parseError(['client', '--scenario', 'x', '--unscored']), /cannot be combined/);
		assert.strictEqual(options(['client', '--unscored']).unscored, true);
	});

	test('--timeout takes a positive integer', () => {
		assert.strictEqual(options(['client', '--timeout', '1234']).timeout, 1234);
		assert.strictEqual(options(['client', '--timeout=5']).timeout, 5);
		assert.match(parseError(['client', '--timeout', 'soon']), /--timeout takes a positive number/);
		assert.match(parseError(['client', '--timeout', '0']), /--timeout takes a positive number/);
	});

	test('the server leg runs by default; --skip-server skips it', () => {
		assert.strictEqual(options(['server']).skipServer, false);
		assert.strictEqual(options(['server', '--skip-server']).skipServer, true);
		assert.strictEqual(options(['server', '--skip-server=false']).skipServer, false);
		assert.strictEqual(options(['server', '--no-skip-server']).skipServer, false);
		assert.strictEqual(options(['server', '--server-url', SERVER_URL]).skipServer, false);
		assert.strictEqual(options(['server', '--server-url', SERVER_URL, '--skip-server']).skipServer, true);
		assert.match(parseError(['server', '--skip-server=maybe']), /takes true or false/);
		assert.match(parseError(['server', '--server-url', 'ftp://host/mcp']), /must be http\(s\)/);
		assert.match(parseError(['server', '--server-url', 'not a url']), /not a URL/);
	});

	test('--out resolves against the working directory', () => {
		assert.strictEqual(options(['client', '--out', 'results']).out, path.resolve(CWD, 'results'));
	});

	test('--update-baseline is refused when CI is set', () => {
		assert.strictEqual(options(['client', '--update-baseline']).updateBaseline, true);
		assert.match(parseError(['client', '--update-baseline'], { CI: 'false' }), /refused on CI/);
		assert.match(parseError(['client', '--update-baseline'], { CI: 'true' }), /refused on CI/);
		assert.match(parseError(['client', '--update-baseline'], { CI: '1' }), /refused on CI/);
	});

	test('help, unknown subcommands and options', () => {
		assert.deepStrictEqual(parseArgs(['--help'], {}, CWD), { kind: 'help' });
		assert.deepStrictEqual(parseArgs(['client', '-h'], {}, CWD), { kind: 'help' });
		assert.match(parseError([]), /Missing subcommand/);
		assert.match(parseError(['clients']), /Unknown subcommand: clients/);
		assert.match(parseError(['client', 'server']), /Unexpected argument: server/);
		assert.match(parseError(['client', '--suite', 'auth']), /Unknown option: --suite/);
	});
});

suite('flag mapping', () => {
	test('the client command is node with the absolute client path, or the root-relative one when the root has whitespace', () => {
		assert.strictEqual(clientCommand(path.join(path.sep, 'repo'), 'linux'), `node ${path.join(path.sep, 'repo', CLIENT_MAIN).split(path.sep).join('/')}`);
		assert.strictEqual(clientCommand(path.join(path.sep, 'my repo'), 'linux'), `node ${CLIENT_MAIN}`);
	});

	test('on Windows the suite, its client and the gateway fixture run with --no-wasm-dynamic-tiering (libuv aborts the exit otherwise); elsewhere without', () => {
		assert.deepStrictEqual(nodeProcessFlags('win32'), ['--no-wasm-dynamic-tiering']);
		assert.deepStrictEqual(nodeProcessFlags('linux'), []);
		assert.deepStrictEqual(nodeProcessFlags('darwin'), []);
		assert.strictEqual(clientCommand(path.join(path.sep, 'repo'), 'win32'), `node --no-wasm-dynamic-tiering ${path.join(path.sep, 'repo', CLIENT_MAIN).split(path.sep).join('/')}`);
		assert.strictEqual(clientCommand(path.join(path.sep, 'my repo'), 'win32'), `node --no-wasm-dynamic-tiering ${CLIENT_MAIN}`);
		assert.deepStrictEqual(suiteProcessArgs(['client', '--requirements', '2026-07-28'], 'win32'), ['--no-wasm-dynamic-tiering', SUITE_BIN, 'client', '--requirements', '2026-07-28']);
		assert.deepStrictEqual(suiteProcessArgs(['client'], 'linux'), [SUITE_BIN, 'client']);
		// Node refuses the flag in NODE_OPTIONS, which is why it goes on each command line.
		const refused = spawnSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: '--no-wasm-dynamic-tiering' }, encoding: 'utf8' });
		assert.notStrictEqual(refused.status, 0);
		assert.match(refused.stderr, /not allowed in NODE_OPTIONS/);
		assert.strictEqual(spawnSync(process.execPath, ['--no-wasm-dynamic-tiering', '-e', ''], { encoding: 'utf8' }).status, 0);
	});

	test('a scored client run is --requirements with the scored baseline and the timeout, never --scenario or --spec-version', () => {
		const invocations = planScored('client', context(['client', '--requirements', '2026-07-28', '--out', 'r']));
		assert.strictEqual(invocations.length, 1);
		const [scored] = invocations;
		assert.strictEqual(scored.kind, 'scored');
		assert.deepStrictEqual(scored.args, [
			'client',
			'--command', COMMAND,
			'--requirements', '2026-07-28',
			'--expected-failures', path.join(BASELINES, 'expected-failures-client-2026-07-28.yml'),
			'--timeout', '60000',
			'-o', path.join(CWD, 'r', 'client', '2026-07-28', 'scored'),
		]);
		assert.deepStrictEqual(scored.scope, SETS[0].client);
	});

	test('a timing scenario also runs alone, after the parallel run of its revision, against the scored baseline', () => {
		const invocations = planScored('client', context(['client']));
		assert.deepStrictEqual(invocations.map(invocation => `${invocation.kind} ${invocation.revision} ${invocation.scenario ?? ''}`), [
			'scored 2026-07-28 ',
			'scored 2025-11-25 ',
			'timing 2025-11-25 sse-retry',
		]);
		const timing = invocations[2].args;
		assert.strictEqual(flag(timing, '--scenario'), 'sse-retry');
		assert.strictEqual(flag(timing, '--spec-version'), '2025-11-25');
		assert.strictEqual(flag(timing, '--expected-failures'), path.join(BASELINES, scoredBaseline('client', '2025-11-25')));
		assert.ok(!timing.includes('--requirements'));
		assert.ok(!timing.includes('--force'));
	});

	test('the server leg points the suite at the server URL and passes no --timeout (the suite\'s server command has none)', () => {
		const [scored] = planScored('server', context(['server', '--requirements', '2025-11-25', '--timeout', '1000']));
		assert.deepStrictEqual(scored.args, [
			'server',
			'--url', SERVER_URL,
			'--requirements', '2025-11-25',
			'--expected-failures', path.join(BASELINES, 'expected-failures-server-2025-11-25.yml'),
			'-o', path.join(DEFAULT_OUT, 'server', '2025-11-25', 'scored'),
		]);
	});

	test('--scenario runs at every revision that lists it, with --spec-version and the scored baseline', () => {
		const invocations = planLeg('client', context(['client', '--scenario', 'tools_call']));
		assert.deepStrictEqual(invocations.map(invocation => invocation.revision), ['2026-07-28', '2025-11-25']);
		for (const invocation of invocations) {
			assert.strictEqual(invocation.kind, 'scenario');
			assert.strictEqual(flag(invocation.args, '--scenario'), 'tools_call');
			assert.strictEqual(flag(invocation.args, '--spec-version'), invocation.revision);
			assert.strictEqual(flag(invocation.args, '--expected-failures'), path.join(BASELINES, scoredBaseline('client', invocation.revision)));
			assert.ok(!invocation.args.includes('--requirements'));
			assert.ok(!invocation.args.includes('--force'));
		}
		assert.deepStrictEqual(planLeg('client', context(['client', '--scenario', 'initialize'])).map(invocation => invocation.revision), ['2025-11-25']);
	});

	test('--scenario of a not-scored scenario is forced and judged against the not-scored baseline', () => {
		const [invocation] = planScenario('client', 'auth/dpop', context(['client', '--scenario', 'auth/dpop', '--spec-version', '2025-11-25']));
		assert.strictEqual(invocation.revision, '2025-11-25');
		assert.ok(invocation.args.includes('--force'));
		assert.strictEqual(flag(invocation.args, '--expected-failures'), path.join(BASELINES, UNSCORED_BASELINE));
		assert.strictEqual(invocation.outDir, path.join(DEFAULT_OUT, 'client', '2025-11-25', 'scenario', 'auth-dpop'));
	});
});

suite('not-scored loop', () => {
	test('one forced invocation per not-scored scenario of every revision, against the not-scored baseline', () => {
		const invocations = planUnscored('client', context(['client', '--unscored', '--timeout', '777']));
		assert.deepStrictEqual(invocations.map(invocation => `${invocation.revision} ${invocation.scenario}`), [
			'2026-07-28 auth/dpop',
			'2026-07-28 json-schema-2020-12-preservation',
			'2025-11-25 auth/dpop',
			'2025-11-25 json-schema-2020-12-preservation',
		]);
		for (const invocation of invocations) {
			assert.strictEqual(invocation.kind, 'unscored');
			assert.deepStrictEqual(invocation.args, [
				'client',
				'--command', COMMAND,
				'--scenario', invocation.scenario,
				'--spec-version', invocation.revision,
				'--force',
				'--expected-failures', path.join(BASELINES, UNSCORED_BASELINE),
				'--timeout', '777',
				'-o', path.join(DEFAULT_OUT, 'client', invocation.revision, 'unscored', invocation.scenario?.replace('/', '-') ?? ''),
			]);
		}
	});

	test('the extension scenarios of a leg run forced at every selected revision after its not-scored ones, unless a set lists them', () => {
		const extensionScenarios: IExtensionScenario[] = [
			{ leg: 'client', scenario: 'sep-2640-client-no-prefetch', extension: 'SEP-2640' },
			{ leg: 'client', scenario: 'auth/dpop', extension: 'listed anyway' },
			{ leg: 'server', scenario: 'sep-2640-skills-enumeration', extension: 'SEP-2640' },
		];
		const ctx = { ...context(['client', '--unscored']), extensionScenarios };
		const invocations = planUnscored('client', ctx);
		assert.deepStrictEqual(invocations.map(invocation => `${invocation.revision} ${invocation.scenario}`), [
			'2026-07-28 auth/dpop',
			'2026-07-28 json-schema-2020-12-preservation',
			'2026-07-28 sep-2640-client-no-prefetch',
			'2025-11-25 auth/dpop',
			'2025-11-25 json-schema-2020-12-preservation',
			'2025-11-25 sep-2640-client-no-prefetch',
		]);
		const extension = invocations[2];
		assert.strictEqual(extension.kind, 'unscored');
		assert.ok(extension.args.includes('--force'));
		assert.strictEqual(flag(extension.args, '--spec-version'), '2026-07-28');
		assert.strictEqual(flag(extension.args, '--expected-failures'), path.join(BASELINES, UNSCORED_BASELINE));
		assert.deepStrictEqual(planUnscored('server', { ...context(['server', '--unscored', '--requirements', '2025-11-25']), extensionScenarios }).map(invocation => invocation.scenario), ['server-sse-polling', 'sep-2640-skills-enumeration']);
		assert.deepStrictEqual(EXTENSION_SCENARIOS.map(row => `${row.leg} ${row.scenario}`), [
			'client sep-2640-client-no-prefetch', 'client sep-2640-client-verify-digest', 'client sep-2640-client-verify-size', 'client sep-2640-client-verify-frontmatter',
			'server sep-2640-skills-enumeration', 'server sep-2640-skills-manifest', 'server sep-2640-skills-directory',
		]);
	});

	test('--unscored replaces the scored runs; all runs both; --requirements narrows the loop', () => {
		assert.ok(planLeg('client', context(['client', '--unscored'])).every(invocation => invocation.kind === 'unscored'));
		assert.deepStrictEqual(planLeg('client', context(['all'])).map(invocation => invocation.kind), ['scored', 'scored', 'timing', 'unscored', 'unscored', 'unscored', 'unscored']);
		assert.deepStrictEqual(planLeg('server', context(['server', '--unscored', '--requirements', '2025-11-25'])).map(invocation => invocation.scenario), ['server-sse-polling']);
	});
});

suite('timeouts', () => {
	test('every client invocation passes --timeout and gets a deadline of a few timeouts', () => {
		const ctx = context(['all', '--timeout', '1000']);
		const invocations = [...planLeg('client', ctx), ...planLeg('server', ctx)];
		for (const invocation of invocations) {
			assert.strictEqual(flag(invocation.args, '--timeout'), invocation.leg === 'client' ? '1000' : undefined, invocation.label);
			assert.strictEqual(invocation.deadlineMs, 1000 * INVOCATION_TIMEOUT_FACTOR);
		}
	});

	test('a client the suite timed out is counted', () => {
		assert.strictEqual(countClientTimeouts('Client timed out after 400ms\nok\n\u001b[31mClient timed out after 400ms\u001b[0m'), 2);
		assert.strictEqual(countClientTimeouts('all good'), 0);
	});
});

suite('leftover clients', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), 'mcp-conformance-run-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('on Windows the kill is taskkill /pid <pid> /T /F', () => {
		const calls: unknown[][] = [];
		const kills: unknown[][] = [];
		createKillTree('win32', (...args) => calls.push(args), (...args) => kills.push(args))(4242);
		assert.deepStrictEqual(calls, [['taskkill', ['/pid', '4242', '/T', '/F'], { stdio: 'ignore' }]]);
		assert.deepStrictEqual(kills, []);
	});

	test('elsewhere the kill is SIGKILL, and a process already gone is fine', () => {
		const calls: unknown[][] = [];
		const kills: unknown[][] = [];
		createKillTree('linux', (...args) => calls.push(args), (...args) => kills.push(args))(4242);
		assert.deepStrictEqual(kills, [[4242, 'SIGKILL']]);
		assert.deepStrictEqual(calls, []);
		createKillTree('linux', () => undefined, () => { throw new Error('ESRCH'); })(1);
	});

	test('the PIDs still running are killed and every PID file is removed', () => {
		writeFileSync(path.join(dir, '100.pid'), '100');
		writeFileSync(path.join(dir, '200.pid'), '200');
		writeFileSync(path.join(dir, 'notes.txt'), 'not a pid');
		const killed: number[] = [];
		const result = killLeftovers(dir, { isAlive: pid => pid === 200, killTree: pid => killed.push(pid), log: () => undefined });
		assert.deepStrictEqual(result, [200]);
		assert.deepStrictEqual(killed, [200]);
		assert.deepStrictEqual(readdirSync(dir), ['notes.txt']);
		assert.deepStrictEqual(killLeftovers(path.join(dir, 'missing'), { isAlive: () => true, killTree: () => assert.fail(), log: () => undefined }), []);
	});

	test('after each invocation the harness kills the clients the suite left behind', async () => {
		const invocation = planScored('client', { ...context(['client', '--requirements', '2026-07-28', '--out', dir]) })[0];
		const killed: number[] = [];
		let pidDir: string | undefined;
		const deps = stubDeps({
			runSuite: async (_args, env) => {
				pidDir = env[PID_DIR_ENV];
				assert.ok(pidDir && existsSync(pidDir), 'the PID directory exists before the suite starts');
				writeFileSync(path.join(pidDir, '31337.pid'), '31337'); // a client that outlived the suite
				return { exitCode: 0, output: 'Total: 3 passed, 0 failed, 0 warnings\n', timedOut: false };
			},
			isAlive: () => true,
			killTree: pid => killed.push(pid),
		});
		const result = await runInvocation(invocation, {}, deps);
		assert.deepStrictEqual(killed, [31337]);
		assert.ok(pidDir && !existsSync(pidDir), 'the PID directory is removed');
		assert.strictEqual(result.passed, true);
		assert.deepStrictEqual(result.counts, { passed: 3, failed: 0, warnings: 0 });
	});

	test('a suite killed for running past its deadline fails the invocation', async () => {
		const invocation = planScored('client', context(['client', '--requirements', '2026-07-28', '--out', dir]))[0];
		let deadline: number | undefined;
		const result = await runInvocation(invocation, {}, stubDeps({
			runSuite: async (_args, _env, timeoutMs) => {
				deadline = timeoutMs;
				return { exitCode: 1, output: '', timedOut: true };
			},
		}));
		assert.strictEqual(deadline, DEFAULT_TIMEOUT_MS * INVOCATION_TIMEOUT_FACTOR);
		assert.strictEqual(result.passed, false);
		assert.match(result.note ?? '', /did not finish in time/);
	});
});

const BASELINE_REPORT = [
	'Total: 10 passed, 4 failed, 1 warnings',
	'',
	'\u001b[33mExpected failures (in baseline):\u001b[0m',
	'  ~ auth/metadata-default:token-request',
	'  ~ auth/dpop',
	'',
	'\u001b[31mStale baseline entries (now passing - remove from baseline):\u001b[0m',
	'  ✓ auth/basic-cimd:cimd-client-id-used',
	'',
	'\u001b[31mUnexpected failures (not in baseline):\u001b[0m',
	'  ✗ sse-retry:client-sse-retry-timing',
	'',
	'\u001b[31mBaseline is stale: update your expected-failures file to remove passing entries.\u001b[0m',
].join('\n');

suite('suite output', () => {
	test('the baseline report', () => {
		assert.deepStrictEqual(parseBaselineVerdict(BASELINE_REPORT), {
			expected: ['auth/metadata-default:token-request', 'auth/dpop'],
			stale: ['auth/basic-cimd:cimd-client-id-used'],
			unexpected: ['sse-retry:client-sse-retry-timing'],
		});
		assert.deepStrictEqual(parseBaselineVerdict('✗ auth/dpop: 2 passed, 3 failed\n  ✗ auth/dpop (extension)\n'), { expected: [], stale: [], unexpected: [] });
	});

	test('the counts of a requirement run and of a single scenario', () => {
		assert.deepStrictEqual(parseCounts(BASELINE_REPORT), { passed: 10, failed: 4, warnings: 1 });
		assert.deepStrictEqual(parseCounts('Test Results:\nPassed: 3/4, 1 failed, 2 warnings\n'), { passed: 3, failed: 1, warnings: 2 });
		assert.deepStrictEqual(parseCounts('Total: 163 passed, 30 failed\n'), { passed: 163, failed: 30, warnings: undefined }, 'the server summary has no warnings');
		assert.strictEqual(parseCounts('nothing'), undefined);
	});

	test('a suite that aborts in libuv after a passing verdict passes; one that aborts before it does not', async () => {
		const passing = 'Passed: 3/3, 0 failed, 0 warnings\n\n\u001b[32mBaseline check passed: all failures are expected.\u001b[0m\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76\n';
		assert.strictEqual(isExitCrashAfterPassingVerdict(3221226505, passing), true);
		assert.strictEqual(isExitCrashAfterPassingVerdict(0, passing), false);
		assert.strictEqual(isExitCrashAfterPassingVerdict(3221226505, 'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)\nBaseline check passed: all failures are expected.\n'), false);
		assert.strictEqual(isExitCrashAfterPassingVerdict(1, 'Unexpected failures (not in baseline):\n  ✗ tasks-lifecycle\nAssertion failed: !(handle->flags & UV_HANDLE_CLOSING)\n'), false);

		const dir = mkdtempSync(path.join(tmpdir(), 'mcp-conformance-crash-'));
		try {
			const invocation = planScenario('server', 'json-schema-2020-12', context(['server', '--scenario', 'json-schema-2020-12', '--out', dir]))[0];
			const result = await runInvocation(invocation, {}, stubDeps({ runSuite: async () => ({ exitCode: 3221226505, output: passing, timedOut: false }) }));
			assert.strictEqual(result.passed, true);
			assert.match(result.note ?? '', /aborted in libuv/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the counts of the checks.json files, warnings included', () => {
		assert.deepStrictEqual(countChecks(new Map([
			['a', [{ id: '1', status: 'SUCCESS' }, { id: '2', status: 'FAILURE' }, { id: '3', status: 'INFO' }]],
			['b', [{ id: '1', status: 'WARNING' }, { id: '2', status: 'SUCCESS' }, { id: '3', status: 'SKIPPED' }]],
		])), { passed: 2, failed: 1, warnings: 1 });
		assert.strictEqual(countChecks(new Map()), undefined);
	});

	test('entries, check ids and result directories', () => {
		assert.strictEqual(entryScenario('auth/metadata-default:token-request'), 'auth/metadata-default');
		assert.strictEqual(entryScenario('auth/dpop'), 'auth/dpop');
		assert.deepStrictEqual(failingCheckIds([
			{ id: 'a', status: 'SUCCESS' }, { id: 'a', status: 'FAILURE' },
			{ id: 'b', status: 'WARNING' }, { id: 'c', status: 'SUCCESS' }, { id: 'd', status: 'INFO' }, { id: 'e', status: 'SKIPPED' },
		]), ['a', 'b']);
		assert.strictEqual(resultScenario(path.join('auth', 'metadata-default-2026-10-20T14-55-42-051Z'), 'client'), 'auth/metadata-default');
		assert.strictEqual(resultScenario('server-tools-list-2026-10-20T14-55-42-051Z', 'server'), 'tools-list');
		assert.strictEqual(resultScenario('json-schema-2020-12-preservation-2026-10-20T14-55-42-051Z', 'client'), 'json-schema-2020-12-preservation');
	});

	test('the READY line of the gateway fixture', () => {
		assert.strictEqual(parseReadyLine('READY:http://127.0.0.1:5000/mcp\n'), 'http://127.0.0.1:5000/mcp');
		assert.strictEqual(parseReadyLine('starting\r\nREADY:http://[::1]:1/mcp\r\n'), 'http://[::1]:1/mcp');
		assert.strictEqual(parseReadyLine('READY:'), undefined);
	});

	test('a scored run that fails only on a timing scenario passes when the scenario passes alone', () => {
		const make = (kind: IInvocation['kind'], scenario: string | undefined, passed: boolean, unexpected: string[] = []): IInvocationResult => ({
			invocation: { ...planScored('client', context(['client', '--requirements', '2025-11-25']))[0], kind, scenario },
			exitCode: passed ? 0 : 1,
			timedOut: false,
			counts: undefined,
			verdict: { expected: [], stale: [], unexpected },
			clientTimeouts: 0,
			clientExits: [],
			passed,
			note: undefined,
		});
		const scored = make('scored', undefined, false, ['sse-retry:client-sse-retry-timing']);
		applyTimingReruns([scored, make('timing', 'sse-retry', true)]);
		assert.strictEqual(scored.passed, true);
		assert.match(scored.note ?? '', /sse-retry/);

		const other = make('scored', undefined, false, ['sse-retry:client-sse-retry-timing', 'tools_call:tool-add-numbers']);
		applyTimingReruns([other, make('timing', 'sse-retry', true)]);
		assert.strictEqual(other.passed, false);

		const stillFailing = make('scored', undefined, false, ['sse-retry:client-sse-retry-timing']);
		applyTimingReruns([stillFailing, make('timing', 'sse-retry', false)]);
		assert.strictEqual(stillFailing.passed, false);

		const crashedClient = { ...make('scored', undefined, false, ['sse-retry:client-sse-retry-timing']), clientExits: ['the client of tools_call exited with code 1'] };
		applyTimingReruns([crashedClient, make('timing', 'sse-retry', true)]);
		assert.strictEqual(crashedClient.passed, false, 'a timing re-run never excuses a client exit');
	});
});

/** The report the suite writes for a client that exited non-zero (see the function that runs one client scenario in its dist/index.js). */
function clientExitReport(exitCode: number, client: { stdout?: string; stderr?: string }, timeoutMs?: number): string {
	return [
		`\nClient exited with code ${exitCode}\n`,
		client.stdout ? `\nStdout:\n${client.stdout}\n` : '',
		client.stderr ? `\nStderr:\n${client.stderr}\n` : '',
		timeoutMs !== undefined ? `\nClient timed out after ${timeoutMs}ms\n` : '',
	].join('');
}

suite('client exits', () => {
	const RETRY_LIMIT = { stdout: '', stderr: '[mcp-conformance] info: Scenario auth/scope-retry-limit against http://localhost:1/mcp\n[mcp-conformance] error: step_up_limit\n' };
	const TOOLS = { stdout: '', stderr: '[mcp-conformance] info: Scenario tools_call against http://localhost:2/mcp\nTypeError: boom\n    at x (file:///y.js:1:1)' };
	const DPOP = { stdout: 'unexpected stdout', stderr: '[mcp-conformance] info: Scenario auth/dpop against http://localhost:3/mcp\n' };
	const clients = new Map([['auth/scope-retry-limit', RETRY_LIMIT], ['tools_call', TOOLS], ['auth/dpop', DPOP], ['request-metadata', { stdout: '', stderr: '[mcp-conformance] info: Scenario request-metadata\n' }]]);

	test('each report is matched to its scenario by the output it quotes, interleaved with other scenarios', () => {
		const output = [
			'Running requirements 2026-07-28 (4 scenarios) in parallel...',
			'Starting scenario: tools_call',
			'Starting scenario: auth/scope-retry-limit',
			clientExitReport(1, RETRY_LIMIT),
			'Results saved to /out/auth/scope-retry-limit-2026-10-20T14-55-42-051Z',
			clientExitReport(1, DPOP),
			'\u001b[31m' + clientExitReport(134, TOOLS, 60000).replace(/\n/g, '\r\n') + '\u001b[0m',
			'Total: 3 passed, 0 failed, 0 warnings',
		].join('\n');
		assert.deepStrictEqual(parseClientExits(output, clients), [
			{ scenario: 'auth/scope-retry-limit', exitCode: 1, timedOut: false },
			{ scenario: 'tools_call', exitCode: 134, timedOut: true },
			{ scenario: 'auth/dpop', exitCode: 1, timedOut: false },
		]);
	});

	test('a report without output, and a timeout of a client that exited with 0, belong to no scenario', () => {
		assert.deepStrictEqual(parseClientExits(`${clientExitReport(3, {})}\nClient timed out after 400ms\n`, clients), [
			{ scenario: undefined, exitCode: 3, timedOut: false },
			{ scenario: undefined, exitCode: undefined, timedOut: true },
		]);
		assert.deepStrictEqual(parseClientExits('Total: 3 passed, 0 failed, 0 warnings\n', clients), []);
	});

	test('a non-zero exit fails unless the scenario allows a client error or is baselined whole; a timeout always fails', () => {
		const invocation = { scope: ['tools_call', 'auth/scope-retry-limit', 'request-metadata'], clientErrorAllowed: ['auth/scope-retry-limit'] };
		assert.deepStrictEqual(clientExitProblems([
			{ scenario: 'auth/scope-retry-limit', exitCode: 1, timedOut: false },
			{ scenario: 'tools_call', exitCode: 1, timedOut: false },
			{ scenario: 'auth/dpop', exitCode: 1, timedOut: false },
			{ scenario: 'request-metadata', exitCode: 0, timedOut: true },
		], invocation, new Set()), [
			'the client of tools_call exited with code 1',
			'the client of request-metadata timed out',
		], 'auth/dpop is outside the scope of the invocation: its own run judges it');
		assert.deepStrictEqual(clientExitProblems([{ scenario: 'auth/scope-retry-limit', exitCode: 1, timedOut: true }], invocation, new Set()), ['the client of auth/scope-retry-limit timed out']);
		assert.deepStrictEqual(clientExitProblems([{ scenario: 'tools_call', exitCode: 1, timedOut: true }], invocation, new Set(['tools_call'])), [], 'baselined whole');
		assert.deepStrictEqual(clientExitProblems([{ scenario: undefined, exitCode: 2, timedOut: false }, { scenario: undefined, exitCode: undefined, timedOut: true }], invocation, new Set()), [
			'a client (of a scenario the harness cannot tell) exited with code 2',
			'a client (of a scenario the harness cannot tell) timed out',
		]);
		assert.deepStrictEqual(clientExitProblems([{ scenario: undefined, exitCode: 1, timedOut: false }], { scope: ['auth/scope-retry-limit'], clientErrorAllowed: ['auth/scope-retry-limit'] }, new Set()), [], 'a single-scenario run owns every report');
		assert.deepStrictEqual(clientExitProblems([{ scenario: undefined, exitCode: 1, timedOut: false }], { scope: ['tools_call'], clientErrorAllowed: [] }, new Set()), ['the client of tools_call exited with code 1']);
	});

	test('the suite\'s scenarios that allow a client error are read from its bundle', () => {
		const bundle = 'var A=class{constructor(){this.name=`auth/scope-retry-limit`,this.source={introducedIn:`2025-11-25`},this.description=`x`,this.allowClientError=!0,this.checks=[]}async start(e){}};'
			+ 'var B=class extends C{constructor(...e){super(...e),this.name=`http-invalid-tool-headers`,this.allowClientError=!0}getChecks(){}};'
			+ 'var D=class{constructor(){this.name=`tools_call`,this.checks=[]}async start(){this.allowClientError=!0}};'
			+ 'var E=class{constructor(){this.name="initialize"}};';
		assert.deepStrictEqual([...parseSuiteInventory(bundle).clientErrorAllowed], ['auth/scope-retry-limit', 'http-invalid-tool-headers']);
	});

	test('a client that crashes after its checks are recorded fails the invocation, even when the suite passed it', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'mcp-conformance-exit-'));
		try {
			const ctx: IPlanContext = { ...context(['client', '--requirements', '2026-07-28', '--out', dir]), clientErrorAllowed: new Set(['auth/metadata-default']) };
			const [invocation] = planScored('client', ctx);
			assert.deepStrictEqual(invocation.clientErrorAllowed, ['auth/metadata-default']);
			const write = (scenario: string, client: { stdout: string; stderr: string }) => {
				const folder = path.join(invocation.outDir, `${scenario}-2026-10-20T14-55-42-051Z`);
				mkdirSync(folder, { recursive: true });
				writeFileSync(path.join(folder, 'checks.json'), JSON.stringify([{ id: 'x', status: 'SUCCESS' }]));
				writeFileSync(path.join(folder, 'stdout.txt'), client.stdout);
				writeFileSync(path.join(folder, 'stderr.txt'), client.stderr);
			};
			const passing = 'Total: 3 passed, 0 failed, 0 warnings\n\nBaseline check passed: all failures are expected.\n';
			const run = (output: string) => runInvocation(invocation, {}, stubDeps({
				runSuite: async () => {
					write('tools_call', TOOLS);
					write('auth/metadata-default', RETRY_LIMIT);
					return { exitCode: 0, output, timedOut: false };
				},
			}));

			const crashed = await run(clientExitReport(134, TOOLS) + passing);
			assert.strictEqual(crashed.passed, false);
			assert.deepStrictEqual(crashed.clientExits, ['the client of tools_call exited with code 134']);
			assert.match(crashed.note ?? '', /the client of tools_call exited with code 134/);

			const allowed = await run(clientExitReport(1, RETRY_LIMIT) + passing);
			assert.strictEqual(allowed.passed, true, 'auth/metadata-default allows a client error here');
			assert.deepStrictEqual(allowed.clientExits, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the server leg has no client to judge', async () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'mcp-conformance-exit-'));
		try {
			const [invocation] = planScored('server', context(['server', '--requirements', '2026-07-28', '--out', dir]));
			const result = await runInvocation(invocation, {}, stubDeps({ runSuite: async () => ({ exitCode: 0, output: clientExitReport(1, {}), timedOut: false }) }));
			assert.strictEqual(result.passed, true);
			assert.deepStrictEqual(result.clientExits, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('baseline updates', () => {
	test('per-check entries for failing scenarios, whole entries kept while failing, other scenarios untouched', () => {
		const after = updatedEntries(
			['auth/dpop', 'auth/metadata-default:token-request', 'auth/basic-cimd:cimd-client-id-used', 'other:check'],
			{
				scope: new Set(['auth/dpop', 'auth/metadata-default', 'auth/basic-cimd', 'tools_call']),
				failing: new Map([['auth/dpop', new Set(['x'])], ['auth/metadata-default', new Set(['token-request', 'client-registration'])]]),
			});
		assert.deepStrictEqual(after, ['auth/dpop', 'auth/metadata-default:client-registration', 'auth/metadata-default:token-request', 'other:check']);
	});

	test('the updater rewrites the leg of the file, keeps its comments, and merges runs that share it', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'mcp-conformance-baseline-'));
		try {
			const file = path.join(dir, UNSCORED_BASELINE);
			writeFileSync(file, '# header\nclient:\n  - auth/dpop\n# tasks go here\nserver: []\n');
			const results = (failing: boolean) => new Map([
				['auth/dpop', [{ id: 'dpop-check', status: failing ? 'FAILURE' : 'SUCCESS' }]],
				['json-schema-2020-12-preservation', [{ id: 'echo', status: failing ? 'WARNING' : 'SUCCESS' }]],
			]);
			const invocation = (scenario: string, revision: '2026-07-28' | '2025-11-25'): IInvocation => ({ ...planScenario('client', scenario, context(['client', '--scenario', scenario, '--spec-version', revision]))[0], baseline: file });
			const updater = new BaselineUpdater();
			assert.deepStrictEqual(updater.record(invocation('auth/dpop', '2026-07-28'), results(true)), []);
			assert.deepStrictEqual(updater.record(invocation('json-schema-2020-12-preservation', '2026-07-28'), results(false)), []);
			assert.deepStrictEqual(updater.record(invocation('json-schema-2020-12-preservation', '2025-11-25'), results(true)), []);
			assert.deepStrictEqual(updater.record(invocation('missing', '2025-11-25'), results(true)), ['missing']);
			const [change] = updater.write();
			assert.deepStrictEqual(change.added, ['json-schema-2020-12-preservation:echo']);
			assert.deepStrictEqual(change.removed, []);
			const text = readFileSync(file, 'utf8');
			assert.match(text, /^# header\n/);
			assert.match(text, /# tasks go here/);
			assert.deepStrictEqual(parseBaselineFile(text), { client: ['auth/dpop', 'json-schema-2020-12-preservation:echo'], server: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('results are read from the checks.json files of a results directory', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'mcp-conformance-results-'));
		try {
			mkdirSync(path.join(dir, 'auth', 'dpop-2026-10-20T14-55-42-051Z'), { recursive: true });
			writeFileSync(path.join(dir, 'auth', 'dpop-2026-10-20T14-55-42-051Z', 'checks.json'), JSON.stringify([{ id: 'a', status: 'FAILURE', name: 'A' }]));
			mkdirSync(path.join(dir, 'tools_call-2026-10-20T14-55-42-051Z'));
			writeFileSync(path.join(dir, 'tools_call-2026-10-20T14-55-42-051Z', 'checks.json'), JSON.stringify([{ id: 'b', status: 'SUCCESS' }, { bogus: true }]));
			assert.deepStrictEqual([...readResults(dir, 'client')].sort(), [
				['auth/dpop', [{ id: 'a', status: 'FAILURE', name: 'A' }]],
				['tools_call', [{ id: 'b', status: 'SUCCESS' }]],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('check-matrix', () => {
	const MATRIX = [
		'| Leg | Revision | Scenario | Scoring | Status | Notes |',
		'| --- | --- | --- | --- | --- | --- |',
		...SETS.flatMap(set => [
			...set.client.map(scenario => `| client | ${set.revision} | \`${scenario}\` | scored | ${scenario.startsWith('auth/') ? 'gap' : 'driven'} | |`),
			...set.server.map(scenario => `| server | ${set.revision} | \`${scenario}\` | scored | driven | |`),
			...set.notScored.map(entry => `| ${entry.leg} | ${set.revision} | \`${entry.scenario}\` | not-scored | ${entry.scenario === 'auth/dpop' ? 'gap' : 'driven'} | |`),
		]),
	].join('\n');

	const TEST_FILE = [
		'suite(\'s\', () => {',
		'\ttest(\'some test\', () => { });',
		'\ttest("a client\\\'s \\"quoted\\" test", () => { });',
		'\ttest(`a ${kind} template`, () => { });',
		'});',
	].join('\n');

	const REQUIREMENTS = {
		source: { name: 'example/sdk', repo: 'https://example.com/sdk', version: 'v1', path: 'requirements.zon', license: 'MIT' },
		specification: { commit: 'abc', site: 'https://example.com/spec' },
		requirements: [
			{ id: 'basic#001', page: 'basic', section: 'Messages', anchor: 'messages', level: 'must', party: 'both', text: 'Messages MUST be JSON-RPC.' },
			{ id: 'basic#002', page: 'basic', section: 'Messages', anchor: 'messages', level: 'should', party: 'client', text: 'Clients SHOULD do a | thing.' },
			{ id: 'basic#003', page: 'basic', section: 'Messages', anchor: '', level: 'may', party: 'server', text: 'Servers MAY <do> it.' },
			{ id: 'server/tools#001', page: 'server/tools', section: 'Tools', anchor: 'tools', level: 'must_not', party: 'server', text: 'Servers MUST NOT lie.' },
		],
	};

	function mappings(): Record<string, unknown>[] {
		return [
			{ id: 'basic#001', status: 'tested', tests: [{ file: 'src/a.test.ts', test: 'some test' }], scenarios: [{ leg: 'client', revision: '2026-07-28', scenario: 'tools_call' }] },
			{ id: 'basic#002', status: 'gap', reason: 'not yet' },
			{ id: 'basic#003', status: 'n-a', reason: 'does not apply' },
			{ id: 'server/tools#001', status: 'deviation', reason: 'on purpose', tests: [{ file: 'src/a.test.ts', test: 'a client\'s "quoted" test' }], scenarios: [{ leg: 'server', revision: '2026-07-28', scenario: 'tools-list', check: 'tools-list' }] },
		];
	}

	function input(overrides: Partial<ICheckMatrixInput> = {}, mappingList: Record<string, unknown>[] = mappings()): ICheckMatrixInput {
		const baselines = new Map<string, IBaselineEntries>([
			[scoredBaseline('client', '2026-07-28'), { client: ['auth/metadata-default:token-request'], server: [] }],
			[scoredBaseline('client', '2025-11-25'), { client: ['auth/metadata-default:token-request'], server: [] }],
			[scoredBaseline('server', '2026-07-28'), { client: [], server: [] }],
			[scoredBaseline('server', '2025-11-25'), { client: [], server: [] }],
			[UNSCORED_BASELINE, { client: ['auth/dpop'], server: [] }],
		]);
		return {
			matrix: parseMatrix(MATRIX),
			sets: SETS,
			baselines,
			requirementFiles: new Map([['requirements-2026-07-28.json', REQUIREMENTS]]),
			requirementTests: {
				harness: '@modelcontextprotocol/conformance@0.2.0-alpha.11',
				requirements: 'requirements-2026-07-28.json',
				mappings: mappingList,
			},
			pinnedSuiteVersion: '0.2.0-alpha.11',
			readFile: file => file === 'src/a.test.ts' ? TEST_FILE : undefined,
			suite: { checkIds: new Set(['tools-list', 'token-request']), scenarios: new Set(AUTHORIZATION_SERVER_SCENARIOS.map(row => row.scenario)), clientErrorAllowed: new Set() },
			...overrides,
		};
	}

	function withMappings(change: (list: Record<string, unknown>[]) => Record<string, unknown>[]): ICheckMatrixInput {
		return input({}, change(mappings()));
	}

	test('a consistent matrix has no problems', () => {
		assert.deepStrictEqual(checkMatrix(input()), []);
	});

	test('every scenario of both requirement sets needs one row', () => {
		const matrix = parseMatrix(MATRIX).filter(row => !(row.leg === 'server' && row.scenario === 'tools-list'));
		assert.deepStrictEqual(checkMatrix(input({ matrix })), ['requirement-matrix.md has no row for server 2026-07-28 tools-list']);
		const duplicated = [...parseMatrix(MATRIX), { ...parseMatrix(MATRIX)[0], line: 99 }];
		assert.match(checkMatrix(input({ matrix: duplicated })).join('\n'), /requirement-matrix.md:99: a second row for client 2026-07-28 tools_call/);
		const unknown = [...parseMatrix(MATRIX), { leg: 'client', revision: '2026-07-28', scenario: 'nope', scoring: 'scored', status: 'driven', notes: '', line: 98 }];
		assert.match(checkMatrix(input({ matrix: unknown })).join('\n'), /lists no client scenario nope/);
	});

	test('statuses and scoring must be valid and match the set', () => {
		const matrix = parseMatrix(MATRIX.replace('| client | 2026-07-28 | `tools_call` | scored | driven |', '| client | 2026-07-28 | `tools_call` | not-scored | done |'));
		const problems = checkMatrix(input({ matrix })).join('\n');
		assert.match(problems, /status done is not one of driven, gap, n-a/);
		assert.match(problems, /client 2026-07-28 tools_call is scored, not not-scored/);
	});

	test('a gap row needs a baseline entry, and a not-scored row must be driven or baselined', () => {
		const baselines = new Map(input().baselines);
		baselines.set(scoredBaseline('client', '2025-11-25'), { client: [], server: [] });
		baselines.set(UNSCORED_BASELINE, { client: [], server: [] });
		const problems = checkMatrix(input({ baselines }));
		assert.deepStrictEqual(problems.filter(problem => /gap/.test(problem)).length, 3);
		assert.ok(problems.some(problem => /client 2025-11-25 auth\/metadata-default is a gap but expected-failures-client-2025-11-25.yml has no client entry/.test(problem)));
		assert.ok(problems.some(problem => /the not-scored client 2026-07-28 auth\/dpop is neither driven nor baselined/.test(problem)));
	});

	test('baseline entries must name scenarios their file covers, and every baseline file must exist', () => {
		const baselines = new Map(input().baselines);
		baselines.set(scoredBaseline('client', '2026-07-28'), { client: ['auth/metadata-default:token-request', 'initialize:x'], server: [] });
		baselines.set(UNSCORED_BASELINE, { client: ['auth/dpop', 'tools_call'], server: [] });
		baselines.delete(scoredBaseline('server', '2025-11-25'));
		assert.deepStrictEqual(checkMatrix(input({ baselines })), [
			'expected-failures-server-2025-11-25.yml is missing',
			'expected-failures-client-2026-07-28.yml: initialize:x is not a scored client scenario of 2026-07-28',
			'expected-failures-unscored.yml: tools_call is not a not-scored client scenario',
		]);
	});

	test('a requirement without a mapping fails, whatever its level; a removed requirement leaves its mapping unknown', () => {
		assert.deepStrictEqual(checkMatrix(withMappings(list => list.filter(mapping => mapping.id !== 'basic#001'))), [
			'requirement-tests.json: the MUST requirement basic#001 is not mapped',
		]);
		assert.deepStrictEqual(checkMatrix(withMappings(list => list.filter(mapping => mapping.id !== 'basic#003'))), [
			'requirement-tests.json: the MAY requirement basic#003 is not mapped',
		]);
		const requirementFiles = new Map([['requirements-2026-07-28.json', { ...REQUIREMENTS, requirements: REQUIREMENTS.requirements.filter(requirement => requirement.id !== 'basic#002') }]]);
		assert.deepStrictEqual(checkMatrix(input({ requirementFiles })), ['requirement-tests.json: basic#002 is not a requirement of requirements-2026-07-28.json']);
	});

	test('a MUST or MUST NOT cannot be a gap; gap, n-a, partial and deviation need a reason', () => {
		const problems = checkMatrix(withMappings(list => [
			{ id: 'basic#001', status: 'gap', reason: 'later' },
			{ id: 'basic#002', status: 'gap' },
			{ id: 'basic#003', status: 'n-a', tests: [{ file: 'src/a.test.ts', test: 'some test' }] },
			{ id: 'server/tools#001', status: 'partial', tests: [{ file: 'src/a.test.ts', test: 'some test' }] },
			...list.slice(4),
		]));
		assert.deepStrictEqual(problems, [
			'requirement-tests.json: basic#001 is a MUST requirement and cannot be a gap: cite a test or a scenario, or give an n-a reason',
			'requirement-tests.json: basic#002 is gap without a reason',
			'requirement-tests.json: basic#003 is n-a without a reason',
			'requirement-tests.json: basic#003 is n-a but cites tests or scenarios',
			'requirement-tests.json: server/tools#001 is partial without a reason',
		]);
	});

	test('tested, partial and a deviation of a MUST cite something; a deviation of a SHOULD may cite nothing', () => {
		const problems = checkMatrix(withMappings(list => [
			{ id: 'basic#001', status: 'tested' },
			{ id: 'basic#002', status: 'deviation', reason: 'on purpose' },
			list[2],
			{ id: 'server/tools#001', status: 'deviation', reason: 'on purpose' },
		]));
		assert.deepStrictEqual(problems, [
			'requirement-tests.json: basic#001 is tested but cites no test or scenario',
			'requirement-tests.json: server/tools#001 is deviation but cites no test or scenario',
		]);
	});

	test('a cited test must be declared by the cited file, which must exist', () => {
		const problems = checkMatrix(withMappings(list => [
			{ ...list[0], tests: [{ file: 'src/a.test.ts', test: 'some other test' }, { file: 'src/missing.test.ts', test: 'some test' }, { file: 'src/a.test.ts', test: 'a ${kind} template' }, 'src/a.test.ts:some test'] },
			...list.slice(1),
		]));
		assert.deepStrictEqual(problems, [
			'requirement-tests.json: basic#001: a test must be { "file": "<repository-relative path>", "test": "<test name>" }, not "src/a.test.ts:some test"',
			'requirement-tests.json: basic#001 cites the test "some other test", which src/a.test.ts does not declare',
			'requirement-tests.json: basic#001 cites src/missing.test.ts, which does not exist',
		]);
	});

	test('a cited scenario must be listed by the requirement set of its leg and revision, have a driven row, and name a known check', () => {
		const problems = checkMatrix(withMappings(list => [
			{
				...list[0], scenarios: [
					{ leg: 'client', revision: '2026-07-28', scenario: 'initialize' },
					{ leg: 'server', revision: '2026-07-28', scenario: 'tools_call' },
					{ leg: 'client', revision: '2026-07-28', scenario: 'auth/metadata-default' },
					{ leg: 'client', revision: '2026-07-28', scenario: 'auth/metadata-default', check: 'token-request' },
					{ leg: 'client', revision: '2026-07-28', scenario: 'auth/metadata-default', check: 'pkce-s256-method-used' },
					{ leg: 'client', revision: '2026-07-28', scenario: 'tools_call', check: 'no-such-check' },
					{ leg: 'authorization', revision: '2026-07-28', scenario: 'authorization-code-grant' },
				],
			},
			...list.slice(1),
		]));
		assert.deepStrictEqual(problems, [
			'requirement-tests.json: basic#001: a scenario must be { "leg": "client" | "server", "revision": "2026-07-28" | "2025-11-25", "scenario": "<name>", "check"?: "<check id>" }, not {"leg":"authorization","revision":"2026-07-28","scenario":"authorization-code-grant"}',
			'requirement-tests.json: basic#001 cites the scenario client 2026-07-28 initialize, which requirements/2026-07-28.yaml does not list for the client leg',
			'requirement-tests.json: basic#001 cites the scenario server 2026-07-28 tools_call, which requirements/2026-07-28.yaml does not list for the server leg',
			'requirement-tests.json: basic#001 cites client 2026-07-28 auth/metadata-default, whose requirement-matrix.md row is gap (cite a check that is not baselined)',
			'requirement-tests.json: basic#001 cites client 2026-07-28 auth/metadata-default (token-request), whose requirement-matrix.md row is gap (cite a check that is not baselined)',
			'requirement-tests.json: basic#001 cites the check pkce-s256-method-used, which the suite does not define',
			'requirement-tests.json: basic#001 cites the check no-such-check, which the suite does not define',
		]);
	});

	test('the harness, the requirements file and the statuses must be valid; an id is mapped once', () => {
		const problems = checkMatrix(input({
			requirementTests: {
				harness: '@modelcontextprotocol/conformance@0.1.0',
				requirements: 'requirements-2026-07-28.json',
				mappings: [...mappings(), { id: 'basic#001', status: 'tested', tests: [{ file: 'src/a.test.ts', test: 'some test' }] }, { id: 'basic#004', status: 'maybe' }, { status: 'tested' }],
			},
		}));
		assert.deepStrictEqual(problems, [
			'requirement-tests.json: harness @modelcontextprotocol/conformance@0.1.0 is not the pinned @modelcontextprotocol/conformance@0.2.0-alpha.11',
			'requirement-tests.json: basic#004: status maybe is not one of tested, partial, deviation, gap, n-a',
			'requirement-tests.json: a mapping without an id',
			'requirement-tests.json: basic#001 is mapped twice',
		]);
		assert.deepStrictEqual(checkMatrix(input({ requirementTests: { harness: '@modelcontextprotocol/conformance@0.2.0-alpha.11', requirements: 'nope.json', mappings: [] } })), [
			'requirement-tests.json: requirements names nope.json, which is not a requirements file of this folder',
		]);
	});

	test('the suite must still define the authorization-server scenarios the matrix marks n/a', () => {
		assert.deepStrictEqual(checkMatrix(input({ suite: { checkIds: new Set(['tools-list']), scenarios: new Set(['authorization-code-grant']), clientErrorAllowed: new Set() } })), [
			'the suite defines no authorization-server scenario authorization-server-metadata-endpoint',
		]);
	});

	test('the rendered matrix must be current', () => {
		const rendered = renderConformanceMatrix(input());
		assert.deepStrictEqual(checkMatrix(input({ renderedMatrix: rendered })), []);
		assert.deepStrictEqual(checkMatrix(input({ renderedMatrix: rendered.replace(/\n/g, '\r\n') })), [], 'line endings do not matter');
		assert.deepStrictEqual(checkMatrix(input({ renderedMatrix: rendered.replace('Servers MUST NOT lie.', 'Servers MUST NOT fib.') })), ['docs/mcp-conformance-matrix.md is not current: run node test/mcp-conformance/run.ts render-matrix']);
		assert.deepStrictEqual(checkMatrix(input({ renderedMatrix: null })), ['docs/mcp-conformance-matrix.md is missing: run node test/mcp-conformance/run.ts render-matrix']);
		// a removed mapping changes the rendering too
		const withoutMapping = withMappings(list => list.filter(mapping => mapping.id !== 'server/tools#001'));
		assert.ok(checkMatrix({ ...withoutMapping, renderedMatrix: rendered }).includes('docs/mcp-conformance-matrix.md is not current: run node test/mcp-conformance/run.ts render-matrix'));
	});

	test('the typed-binding table names the tunnel and typed services that mcpGrpcProto.ts defines', () => {
		const proto = 'src/vs/platform/mcp/common/mcpGrpcProto.ts';
		const header = `| Feature | Tunnel (\`${sourceConstant(proto, 'TUNNEL_PACKAGE')}.Mcp\`) | Typed (\`${sourceConstant(proto, 'TYPED_PACKAGE')}.Mcp\`) |`;
		assert.ok(renderConformanceMatrix(input()).split('\n').includes(header), header);
	});

	test('the rendering has the summary, the deviations, the scenarios of every leg and revision, and one row per requirement', () => {
		const rendered = renderConformanceMatrix(input());
		assert.match(rendered, /^# MCP conformance matrix\n/);
		assert.match(rendered, /\| MUST NOT \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \|/);
		assert.match(rendered, /\| \*\*All\*\* \| 4 \| 1 \| 0 \| 1 \| 1 \| 1 \|/);
		assert.match(rendered, /\| `server\/tools#001` \| server \| MUST NOT \| Servers MUST NOT lie\. \| on purpose \|/);
		for (const heading of ['### Client leg, 2026-07-28 (5 scenarios)', '### Client leg, 2025-11-25 (6 scenarios)', '### Server leg, 2026-07-28 (3 scenarios)', '### Server leg, 2025-11-25 (2 scenarios)', '### Authorization-server leg', '### [basic](https://example.com/spec/basic) (3)', '### [server/tools](https://example.com/spec/server/tools) (1)']) {
			assert.ok(rendered.includes(heading), heading);
		}
		assert.match(rendered, /\| `tools_call` \| scored \| driven \| 1 \| +\|/);
		assert.match(rendered, /\| `authorization-code-grant` \| n\/a \|/);
		assert.match(rendered, /Clients SHOULD do a \\\| thing\. \| \*Reason:\* not yet \|/);
		assert.match(rendered, /Servers MAY &lt;do&gt; it\./);
		assert.match(rendered, /`a\.test\.ts` some test<br>conformance client 2026-07-28 `tools_call` \|/);
		assert.ok(rendered.endsWith('\n'));
	});

	test('test names are the string literals passed to test() and it(), with their escapes resolved', () => {
		assert.deepStrictEqual([...extractTestNames(TEST_FILE)], ['some test', 'a client\'s "quoted" test', 'a ${kind} template']);
		assert.deepStrictEqual([...extractTestNames('it(\'one\', () => {}); test.skip("two", () => {}); contest(\'no\'); test(name, () => {}); /abc/.test(\'x\');')], ['one']);
	});

	test('the test scan knows skipped and only tests, skipped suites, and ignores comments, strings and regular expressions', () => {
		const source = [
			'suite(\'runs\', () => {',
			'\ttest(\'a\', () => { const r = /[)(]/; assert.ok(r.test(\'(\')); });',
			'\ttest.skip(\'b\', () => { });',
			'\ttest.todo(\'c\');',
			'\ttest.only(\'d\', () => { });',
			'\t// test(\'commented\', () => { });',
			'\tconst text = \'test("in a string")\';',
			'\ttest(`e ${1 / 2} ${`nested ${\'(\'}`}`, () => { const x = 4 / 2 / 1; });',
			'\tsuite.skip(\'skipped suite\', () => {',
			'\t\ttest(\'f\', () => { suite(\'inner\', () => { test(\'g\', () => { }); }); });',
			'\t});',
			'\t(PORT ? suite : suite.skip)(\'chosen at run time\', function () {',
			'\t\ttest(\'h\', function () { this.skip(); });',
			'\t});',
			'\tsuite.only(\'only suite\', () => { it(\'i\', () => { }); });',
			'\ttest(\'j\', { skip: !ENABLED && \'set ENABLED\' }, () => { });',
			'});',
		].join('\n');
		assert.deepStrictEqual(scanTestDeclarations(source), [
			{ name: 'a', skipped: false, only: false },
			{ name: 'b', skipped: true, only: false },
			{ name: 'c', skipped: true, only: false },
			{ name: 'd', skipped: false, only: true },
			{ name: 'e ${1 / 2} ${`nested ${\'(\'}`}', skipped: false, only: false },
			{ name: 'f', skipped: true, only: false },
			{ name: 'g', skipped: true, only: false },
			{ name: 'h', skipped: false, only: false },
			{ name: 'i', skipped: false, only: true },
			{ name: 'j', skipped: false, only: false },
		]);
	});

	test('a cited test must run: not skipped, not in a skipped suite, not marked only', () => {
		const files = new Map([['src/b.test.ts', 'suite(\'s\', () => { test.skip(\'skipped\', () => { }); test.only(\'only\', () => { }); });\nsuite.skip(\'t\', () => { test(\'in a skipped suite\', () => { }); });\ntest(\'twice\', () => { });\nsuite.skip(\'u\', () => { test(\'twice\', () => { }); });']]);
		const cited = withMappings(list => [
			{ ...list[0], tests: [{ file: 'src/b.test.ts', test: 'skipped' }, { file: 'src/b.test.ts', test: 'only' }, { file: 'src/b.test.ts', test: 'in a skipped suite' }, { file: 'src/b.test.ts', test: 'twice' }] },
			...list.slice(1),
		]);
		const problems = checkMatrix({ ...cited, readFile: file => files.get(file) ?? (file === 'src/a.test.ts' ? TEST_FILE : undefined) });
		assert.deepStrictEqual(problems, [
			'requirement-tests.json: basic#001 cites the test "skipped", which src/b.test.ts skips (test.skip, test.todo or a suite.skip around it): a skipped test covers nothing',
			'requirement-tests.json: basic#001 cites the test "only", which src/b.test.ts marks .only (the test or its suite): remove the .only',
			'requirement-tests.json: basic#001 cites the test "in a skipped suite", which src/b.test.ts skips (test.skip, test.todo or a suite.skip around it): a skipped test covers nothing',
		], 'a name that also runs somewhere in the file is fine');
	});

	test('a driven row must have no baseline entries', () => {
		const baselines = new Map(input().baselines);
		baselines.set(scoredBaseline('server', '2026-07-28'), { client: [], server: ['tools-list:tools-list'] });
		assert.deepStrictEqual(checkMatrix(input({ baselines })), [
			'requirement-matrix.md:7: server 2026-07-28 tools-list is driven (every check passes) but expected-failures-server-2026-07-28.yml has server entries for it: make the row a gap or remove the entries',
		]);
	});

	test('a requirements file must be the conversion of its zig-sdk source at the commit it names; an unreadable source is a notice', () => {
		const zon = [
			'.{',
			'    .repo = "https://example.com/spec",',
			'    .commit = "abc",',
			'    .path = "docs/specification/2026-07-28",',
			'    .fixture = "f",',
			'    .requirements = .{',
			...REQUIREMENTS.requirements.map(requirement => `        .{ .id = "${requirement.id}", .page = "${requirement.page}", .line = 1, .section = "${requirement.section}", .anchor = "${requirement.anchor}", .level = .${requirement.level}, .keywords = .{"MUST"}, .party = .${requirement.party}, .text = "${requirement.text}" },`),
			'    },',
			'}',
		].join('\n');
		const source = { version: 'v1', commit: 'c0ffee' };
		const converted = convertRequirements(zon, source);
		const requirementFiles = new Map([['requirements-2026-07-28.json', converted]]);
		const sources = (text: string) => new Map<string, ZonRead>([['requirements-2026-07-28.json', { kind: 'text', text }]]);
		assert.deepStrictEqual(checkMatrix(input({ requirementFiles, requirementSources: sources(zon) })), []);
		const changed = checkMatrix(input({ requirementFiles, requirementSources: sources(zon.replace('Servers MUST NOT lie.', 'Servers MUST NOT fib.')) }));
		assert.strictEqual(changed.length, 1, changed.join('\n'));
		assert.match(changed[0], /^requirements-2026-07-28\.json is not what tools\/convert-requirements\.ts produces from docs\/spec\/requirements\.zon at c0ffee \(it differs in 1 requirement\(s\), e\.g\. server\/tools#001\): run node test\/mcp-conformance\/tools\/convert-requirements\.ts --commit c0ffee$/);
		const shorter = { ...converted, requirements: (converted.requirements as { id: string }[]).filter(requirement => requirement.id !== 'basic#002') };
		assert.match(checkMatrix(input({ requirementFiles: new Map([['requirements-2026-07-28.json', shorter]]), requirementSources: sources(zon) })).join('\n'), /\(it lacks 1 requirement\(s\), e\.g\. basic#002\)/);
		assert.match(checkMatrix(input({ requirementFiles, requirementSources: sources('.{ .oops') })).join('\n'), /does not convert/);
		const unavailable = input({ requirementFiles, requirementSources: new Map([['requirements-2026-07-28.json', { kind: 'unavailable', reason: 'there is no zig-sdk checkout at /x (set ZIG_SDK_DIR)' }]]) });
		assert.deepStrictEqual(checkMatrix(unavailable), []);
		assert.deepStrictEqual(skippedChecks(unavailable), ['notice: not checking that requirements-2026-07-28.json is the conversion of its zig-sdk source: there is no zig-sdk checkout at /x (set ZIG_SDK_DIR)']);
	});

	test('gateway-threats.md: every threat cites tests that run or driven scenarios', () => {
		const threats = [
			'# Threats',
			'',
			'## 1. Loopback only',
			'',
			'- `src/a.test.ts`: some test',
			'- conformance server 2026-07-28 `tools-list`',
			'',
			'## 2. Nothing cited',
			'',
			'Some prose.',
			'',
			'## 3. Wrong citations',
			'',
			'- `src/a.test.ts`: no such test',
			'- conformance client 2026-07-28 `auth/metadata-default`',
		].join('\n');
		assert.deepStrictEqual(parseGatewayThreats(threats).map(threat => [threat.title, threat.line, threat.tests.length, threat.scenarios.length]), [['1. Loopback only', 3, 1, 1], ['2. Nothing cited', 8, 0, 0], ['3. Wrong citations', 12, 1, 1]]);
		assert.deepStrictEqual(checkMatrix(input({ gatewayThreats: threats })), [
			'gateway-threats.md:8 (2. Nothing cited) cites no test or conformance scenario',
			'gateway-threats.md:12 (3. Wrong citations) cites the test "no such test", which src/a.test.ts does not declare',
			'gateway-threats.md:12 (3. Wrong citations) cites client 2026-07-28 auth/metadata-default, whose requirement-matrix.md row is gap, not driven',
		]);
		assert.deepStrictEqual(checkMatrix(input({ gatewayThreats: null })), ['gateway-threats.md is missing']);
	});

	test('the client\'s driver tables must list exactly the client scenarios of the requirement sets', () => {
		const drivers = (scored: string, unscored: string) => [
			'export const MCP_REVISION_2026_07_28 = \'2026-07-28\';',
			'export const MCP_REVISION_2025_11_25 = \'2025-11-25\';',
			'const BOTH: readonly string[] = [MCP_REVISION_2026_07_28, MCP_REVISION_2025_11_25];',
			'const ONLY_2026: readonly string[] = [MCP_REVISION_2026_07_28];',
			'const ONLY_2025: readonly string[] = [MCP_REVISION_2025_11_25];',
			`export const SCORED_CLIENT_SCENARIOS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([${scored}]);`,
			`export const UNSCORED_CLIENT_SCENARIOS: readonly string[] = [${unscored}];`,
		].join('\n');
		const matching = drivers('[\'tools_call\', BOTH], [\'request-metadata\', ONLY_2026], [\'auth/metadata-default\', BOTH], [\'initialize\', ONLY_2025], [\'sse-retry\', ONLY_2025],', '\'auth/dpop\', \'json-schema-2020-12-preservation\'');
		assert.deepStrictEqual(parseScenarioDrivers(matching)?.scored.get('initialize'), ['2025-11-25']);
		assert.deepStrictEqual(checkMatrix(input({ scenarioDrivers: matching })), []);
		assert.deepStrictEqual(checkMatrix(input({ scenarioDrivers: drivers('[\'tools_call\', ONLY_2026], [\'request-metadata\', BOTH], [\'auth/metadata-default\', BOTH], [\'initialize\', ONLY_2025], [\'sse-retry\', ONLY_2025]', '\'json-schema-2020-12-preservation\', \'auth/gone\'') })), [
			'src/vs/workbench/api/node/mcpConformanceScenarios.ts: UNSCORED_CLIENT_SCENARIOS does not list auth/dpop, which requirements/2026-07-28.yaml runs without scoring',
			'src/vs/workbench/api/node/mcpConformanceScenarios.ts: SCORED_CLIENT_SCENARIOS does not list tools_call for 2025-11-25, which requirements/2025-11-25.yaml scores',
			'src/vs/workbench/api/node/mcpConformanceScenarios.ts: UNSCORED_CLIENT_SCENARIOS does not list auth/dpop, which requirements/2025-11-25.yaml runs without scoring',
			'src/vs/workbench/api/node/mcpConformanceScenarios.ts: SCORED_CLIENT_SCENARIOS lists request-metadata for 2025-11-25, which requirements/2025-11-25.yaml does not score',
			'src/vs/workbench/api/node/mcpConformanceScenarios.ts: UNSCORED_CLIENT_SCENARIOS lists auth/gone, which no requirement set runs without scoring',
		]);
		assert.deepStrictEqual(checkMatrix(input({ scenarioDrivers: null })), ['src/vs/workbench/api/node/mcpConformanceScenarios.ts: no SCORED_CLIENT_SCENARIOS and UNSCORED_CLIENT_SCENARIOS tables to compare with the suite\'s requirement sets']);
	});

	test('the grpc_server.zig parity rows cite tests that run, and the rendering has the table', () => {
		const step = { step: '1. `:method`', zig: '405', gateway: '405', tests: [{ file: 'src/a.test.ts', test: 'some test' }] };
		assert.deepStrictEqual(checkMatrix(input({ grpcServerParity: [step] })), []);
		assert.deepStrictEqual(checkMatrix(input({ grpcServerParity: [{ ...step, tests: [{ file: 'src/a.test.ts', test: 'gone' }] }] })), [
			'the grpc_server.zig parity row 1. `:method` cites the test "gone", which src/a.test.ts does not declare',
		]);
		const rendered = renderConformanceMatrix(input());
		assert.ok(rendered.includes('## The gateway gRPC listener: `grpc_server.zig` parity'));
		assert.match(rendered, /\| 1\. `:method` \| not `POST`: HTTP 405 \| the same \(with `allow: POST`\) \| `grpcServer\.test\.ts` a request that is not a POST gets HTTP 405, one without a gRPC content type 415 \|/);
		assert.match(rendered, /\| `grpc_server\.zig` parity \(the gateway gRPC listener\) \| in \|/);
	});

	test('the suite inventory is read from the literal check ids and scenario names of its bundle', () => {
		const inventory = parseSuiteInventory('t.push({id:`tools-list`,name:`x`}); this.name=`server-stateless`; {id: \'MCP-Tools\'} this.name = "auth/dpop"');
		assert.deepStrictEqual([...inventory.checkIds], ['tools-list']);
		assert.deepStrictEqual([...inventory.scenarios], ['server-stateless', 'auth/dpop']);
	});

	test('the inventory also reads scenarios named through a table, with the table class\'s allowClientError, and checkId and SEP-numbered literals', () => {
		const bundle = [
			'const sn={digest:{scenario:`sep-2640-client-verify-digest`,checkId:`sep-2640-host-verify-digest`,description:`a {brace} and a quote \\` inside`},size:{scenario:`sep-2640-client-verify-size`,checkId:`size-check`}};',
			'var cn=class extends Bt{constructor(e){super(),this.allowClientError=!0,this.mode=e,this.name=sn[e].scenario,this.description=sn[e].description}entry(){return 1}};',
			'const tn={a:{scenario:`plain-one`}};var dn=class{constructor(e){this.name=tn[e].scenario}run(){return this.allowClientError=!0}};',
			'const Jr=`sep-2640-capability-directory-read-flag`;',
		].join('');
		const inventory = parseSuiteInventory(bundle);
		assert.deepStrictEqual([...inventory.scenarios].sort(), ['plain-one', 'sep-2640-client-verify-digest', 'sep-2640-client-verify-size']);
		assert.deepStrictEqual([...inventory.clientErrorAllowed].sort(), ['sep-2640-client-verify-digest', 'sep-2640-client-verify-size']);
		for (const id of ['sep-2640-host-verify-digest', 'size-check', 'sep-2640-capability-directory-read-flag']) {
			assert.ok(inventory.checkIds.has(id), id);
		}
	});

	suite('extension scenarios and requirements', () => {
		const EXTENSION: IExtensionScenario[] = [{ leg: 'server', scenario: 'sep-2640-skills-enumeration', extension: 'SEP-2640' }];
		const ROWS = ['2026-07-28', '2025-11-25'].map(revision => `| server | ${revision} | \`sep-2640-skills-enumeration\` | extension | driven | the fixture |`).join('\n');

		function extensionInput(overrides: Partial<ICheckMatrixInput> = {}, rows = ROWS): ICheckMatrixInput {
			const base = input();
			return input({
				matrix: parseMatrix(`${MATRIX}\n${rows}`),
				extensionScenarios: EXTENSION,
				suite: { ...base.suite!, scenarios: new Set([...base.suite!.scenarios, 'sep-2640-skills-enumeration']), checkIds: new Set([...base.suite!.checkIds, 'sep-2640-skills-get-no-cursor']) },
				...overrides,
			});
		}

		const REQUIREMENT: IExtensionRequirement = {
			id: 'SEP-2640#skills-get', extension: 'SEP-2640', anchor: 'retrieval', party: 'server', level: 'must', status: 'tested', text: 'Servers MUST answer -32602.',
			tests: [{ file: 'src/a.test.ts', test: 'some test' }],
			checks: [{ leg: 'server', scenario: 'sep-2640-skills-enumeration', check: 'sep-2640-skills-get-no-cursor' }],
		};

		test('an extension scenario needs a row per revision, scored extension, driven or baselined in the not-scored file', () => {
			assert.deepStrictEqual(checkMatrix(extensionInput()), []);
			assert.deepStrictEqual(checkMatrix(extensionInput({}, ROWS.split('\n')[0])), ['requirement-matrix.md has no row for server 2025-11-25 sep-2640-skills-enumeration']);
			assert.match(checkMatrix(extensionInput({}, ROWS.replace('| extension |', '| not-scored |'))).join('\n'), /server 2026-07-28 sep-2640-skills-enumeration is extension, not not-scored/);
			assert.match(checkMatrix(extensionInput({ extensionScenarios: undefined })).join('\n'), /requirements\/2026-07-28.yaml lists no server scenario sep-2640-skills-enumeration/);

			const baselines = new Map(input().baselines);
			baselines.set(UNSCORED_BASELINE, { client: ['auth/dpop'], server: ['sep-2640-skills-enumeration:some-check'] });
			assert.deepStrictEqual(checkMatrix(extensionInput({ baselines }, ROWS.replace(/driven/g, 'gap'))), []);
			assert.match(checkMatrix(extensionInput({ baselines })).join('\n'), /is driven \(every check passes\) but expected-failures-unscored.yml has server entries for it/);
			assert.match(checkMatrix(extensionInput({ baselines: input().baselines }, ROWS.replace(/driven/g, 'gap'))).join('\n'), /the extension server 2026-07-28 sep-2640-skills-enumeration is neither driven nor baselined/);
			assert.match(checkMatrix(extensionInput({ baselines, extensionScenarios: undefined, matrix: parseMatrix(MATRIX) })).join('\n'), /expected-failures-unscored.yml: sep-2640-skills-enumeration:some-check is not a not-scored server scenario/);
		});

		test('the suite must define every extension scenario', () => {
			assert.deepStrictEqual(checkMatrix(extensionInput({ suite: input().suite })), ['the suite defines no server extension scenario sep-2640-skills-enumeration']);
		});

		test('extension requirement rows cite running tests and checks of driven extension scenarios the suite defines', () => {
			assert.deepStrictEqual(checkMatrix(extensionInput({ extensionRequirements: [REQUIREMENT] })), []);
			const problems = checkMatrix(extensionInput({
				extensionRequirements: [
					REQUIREMENT,
					{ ...REQUIREMENT, tests: [], checks: [] },
					{ ...REQUIREMENT, id: 'SEP-2640#gap', status: 'gap', reason: 'later', tests: [], checks: [] },
					{ ...REQUIREMENT, id: 'SEP-2640#na', status: 'n-a' },
					{ ...REQUIREMENT, id: 'SEP-2640#wrong', tests: [{ file: 'src/a.test.ts', test: 'gone' }], checks: [{ leg: 'client', scenario: 'tools_call', check: 'x' }, { leg: 'server', scenario: 'sep-2640-skills-enumeration', check: 'no-such-check' }] },
				],
			}));
			assert.deepStrictEqual(problems, [
				'the extension requirement SEP-2640#skills-get is listed twice',
				'the extension requirement SEP-2640#skills-get is tested but cites no test or check',
				'the extension requirement SEP-2640#gap is a MUST requirement and cannot be a gap',
				'the extension requirement SEP-2640#na is n-a without a reason',
				'the extension requirement SEP-2640#na is n-a but cites tests or checks',
				'the extension requirement SEP-2640#wrong cites the test "gone", which src/a.test.ts does not declare',
				'the extension requirement SEP-2640#wrong cites client tools_call, which is not an extension scenario of the harness',
				'the extension requirement SEP-2640#wrong cites the check no-such-check, which the suite does not define',
			]);
			assert.deepStrictEqual(checkMatrix(extensionInput({ extensionRequirements: [REQUIREMENT] }, ROWS.replace('driven', 'n-a'))), [
				'requirement-matrix.md:19: the extension server 2026-07-28 sep-2640-skills-enumeration is neither driven nor baselined in expected-failures-unscored.yml',
				'the extension requirement SEP-2640#skills-get cites server 2026-07-28 sep-2640-skills-enumeration, whose requirement-matrix.md row is n-a, not driven',
			]);
		});

		test('the rendering has a section per extension with its scenario rows and requirement rows', () => {
			const rendered = renderConformanceMatrix(extensionInput({ extensionRequirements: [REQUIREMENT] }));
			assert.ok(rendered.includes('### Extension scenarios: SEP-2640'));
			assert.ok(rendered.includes('| server | 2025-11-25 | `sep-2640-skills-enumeration` | driven | the fixture |'));
			assert.ok(rendered.includes('| [`SEP-2640#skills-get`](https://modelcontextprotocol.io/seps/2640-skills-extension#retrieval) | server | MUST | tested | Servers MUST answer -32602. | `a.test.ts` some test<br>conformance server `sep-2640-skills-enumeration` (`sep-2640-skills-get-no-cursor`) |'));
			assert.ok(!renderConformanceMatrix(input()).includes('### Extension scenarios'));
		});

		test('the client driver table of extension scenarios must match the harness', () => {
			const drivers = (extension: string | undefined) => [
				'export const MCP_REVISION_2026_07_28 = \'2026-07-28\';',
				'export const MCP_REVISION_2025_11_25 = \'2025-11-25\';',
				'const BOTH: readonly string[] = [MCP_REVISION_2026_07_28, MCP_REVISION_2025_11_25];',
				'const ONLY_2026: readonly string[] = [MCP_REVISION_2026_07_28];',
				'const ONLY_2025: readonly string[] = [MCP_REVISION_2025_11_25];',
				'export const SCORED_CLIENT_SCENARIOS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([[\'tools_call\', BOTH], [\'request-metadata\', ONLY_2026], [\'auth/metadata-default\', BOTH], [\'initialize\', ONLY_2025], [\'sse-retry\', ONLY_2025]]);',
				'export const UNSCORED_CLIENT_SCENARIOS: readonly string[] = [\'auth/dpop\', \'json-schema-2020-12-preservation\'];',
				...(extension === undefined ? [] : [`export const EXTENSION_CLIENT_SCENARIOS: readonly string[] = [${extension}];`]),
			].join('\n');
			const extensionScenarios: IExtensionScenario[] = [{ leg: 'client', scenario: 'sep-2640-client-no-prefetch', extension: 'SEP-2640' }];
			assert.deepStrictEqual(parseScenarioDrivers(drivers('\'a\', \'b\''))?.extension, ['a', 'b']);
			assert.strictEqual(parseScenarioDrivers(drivers(undefined))?.extension, undefined);
			const matrix = parseMatrix(`${MATRIX}\n${['2026-07-28', '2025-11-25'].map(revision => `| client | ${revision} | \`sep-2640-client-no-prefetch\` | extension | driven | |`).join('\n')}`);
			const suite = { ...input().suite!, scenarios: new Set([...input().suite!.scenarios, 'sep-2640-client-no-prefetch']) };
			assert.deepStrictEqual(checkMatrix(input({ matrix, suite, extensionScenarios, scenarioDrivers: drivers('\'sep-2640-client-no-prefetch\'') })), []);
			assert.deepStrictEqual(checkMatrix(input({ matrix, suite, extensionScenarios, scenarioDrivers: drivers(undefined) })), [
				'src/vs/workbench/api/node/mcpConformanceScenarios.ts: EXTENSION_CLIENT_SCENARIOS does not list sep-2640-client-no-prefetch, which the harness runs as an extension scenario',
			]);
			assert.deepStrictEqual(checkMatrix(input({ scenarioDrivers: drivers('\'sep-2640-gone\'') })), [
				'src/vs/workbench/api/node/mcpConformanceScenarios.ts: EXTENSION_CLIENT_SCENARIOS lists sep-2640-gone, which is not an extension scenario of the harness (EXTENSION_SCENARIOS)',
			]);
		});
	});

	test('the requirement sets parse the way the suite writes them', () => {
		const set = parseRequirementSet('2026-07-28', 'server:\n  - tools-list\nclient:\n  - tools_call\nnot_scored:\n  - scenario: auth/dpop\n    leg: client\n    reason: extension\n  - scenario: bogus\n');
		assert.deepStrictEqual(set, { revision: '2026-07-28', server: ['tools-list'], client: ['tools_call'], notScored: [{ scenario: 'auth/dpop', leg: 'client', reason: 'extension' }] });
		assert.throws(() => parseRequirementSet('2026-07-28', 'client: tools_call\n'), /must be a list of strings/);
		assert.deepStrictEqual(parseBaselineFile('# only a comment\n'), { client: [], server: [] });
	});

	const installed = existsSync(SUITE_BIN);

	test('the repository\'s matrix, mapping and rendered matrix agree, and fail without one MUST mapping or one requirement', { skip: !installed && 'the suite is not installed' }, () => {
		const real = readCheckMatrixInput();
		assert.deepStrictEqual(checkMatrix(real), []);
		assert.ok(isRecord(real.requirementTests) && Array.isArray(real.requirementTests.mappings));
		const tests = real.requirementTests as { mappings: { id: string }[] };
		const file = real.requirementFiles.get('requirements-2026-07-28.json') as { requirements: { id: string; level: string }[] };
		const must = file.requirements.find(requirement => requirement.level === 'must')!;
		const withoutMust = { ...real, renderedMatrix: undefined, requirementTests: { ...tests, mappings: tests.mappings.filter(mapping => mapping.id !== must.id) } };
		assert.deepStrictEqual(checkMatrix(withoutMust), [`requirement-tests.json: the MUST requirement ${must.id} is not mapped`]);
		const withoutRow = { ...real, renderedMatrix: undefined, requirementSources: undefined, requirementFiles: new Map([['requirements-2026-07-28.json', { ...file, requirements: file.requirements.filter(requirement => requirement.id !== must.id) }]]) };
		assert.deepStrictEqual(checkMatrix(withoutRow), [`requirement-tests.json: ${must.id} is not a requirement of requirements-2026-07-28.json`]);
	});
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stubDeps(overrides: Partial<IHarnessDeps> = {}): IHarnessDeps {
	return {
		platform: 'win32',
		runSuite: async (): Promise<ISuiteRun> => ({ exitCode: 0, output: '', timedOut: false }),
		killTree: () => undefined,
		isAlive: () => false,
		startServer: async () => assert.fail('the server leg should not start'),
		log: () => undefined,
		...overrides,
	};
}

suite('main', () => {
	let out: string;
	beforeEach(() => {
		out = mkdtempSync(path.join(tmpdir(), 'mcp-conformance-main-'));
	});
	afterEach(() => {
		rmSync(out, { recursive: true, force: true });
	});

	test('--update-baseline on CI exits without running the suite', async () => {
		const logs: string[] = [];
		const code = await main(['client', '--update-baseline'], { CI: 'true' }, stubDeps({ runSuite: async () => assert.fail('must not run'), log: line => logs.push(line) }));
		assert.strictEqual(code, 2);
		assert.match(logs.join('\n'), /refused on CI/);
	});

	test('--help prints the usage', async () => {
		const logs: string[] = [];
		assert.strictEqual(await main(['--help'], {}, stubDeps({ log: line => logs.push(line) })), 0);
		assert.match(logs.join('\n'), /^Usage: node test\/mcp-conformance\/run.ts/);
	});

	const installed = existsSync(SUITE_BIN);

	test('--skip-server skips the server leg', { skip: !installed && 'the suite is not installed' }, async () => {
		const code = await main(['server', '--skip-server', '--out', out], {}, stubDeps({ runSuite: async () => assert.fail('must not run') }));
		assert.strictEqual(code, 0);
	});

	test('the server leg starts the gateway fixture, runs against its URL and stops it', { skip: !installed && 'the suite is not installed' }, async () => {
		const runs: (readonly string[])[] = [];
		let stopped = 0;
		const code = await main(['server', '--no-skip-server', '--requirements', '2026-07-28', '--out', out], {}, stubDeps({
			startServer: async logFile => {
				assert.strictEqual(logFile, path.join(out, 'gateway.log'));
				return { url: SERVER_URL, stop: async () => { stopped++; } };
			},
			runSuite: async args => {
				runs.push(args);
				return { exitCode: 0, output: 'Total: 1 passed, 0 failed, 0 warnings', timedOut: false };
			},
		}));
		assert.strictEqual(code, 0);
		assert.strictEqual(stopped, 1);
		assert.deepStrictEqual(runs.map(args => [args[0], flag(args, '--url'), flag(args, '--requirements'), flag(args, '--expected-failures')]), [
			['server', SERVER_URL, '2026-07-28', path.join(HERE, scoredBaseline('server', '2026-07-28'))],
		]);
		const summary = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
		assert.deepStrictEqual(summary.map((entry: { label: string; passed: boolean }) => [entry.label, entry.passed]), [['server 2026-07-28 (scored)', true]]);
	});

	test('a failing invocation fails the run; the timing scenario runs after the parallel run', { skip: (!installed || !existsSync(path.join(ROOT, CLIENT_MAIN))) && 'the suite or the client is not built' }, async () => {
		const runs: (readonly string[])[] = [];
		const code = await main(['client', '--requirements', '2025-11-25', '--out', out], {}, stubDeps({
			runSuite: async args => {
				runs.push(args);
				return args.includes('--requirements')
					? { exitCode: 1, output: 'Unexpected failures (not in baseline):\n  ✗ tools_call:tool-add-numbers\n', timedOut: false }
					: { exitCode: 0, output: '', timedOut: false };
			},
		}));
		assert.strictEqual(code, 1);
		assert.deepStrictEqual(runs.map(args => flag(args, '--requirements') ?? flag(args, '--scenario')), ['2025-11-25', 'sse-retry']);
		assert.strictEqual(flag(runs[0], '--command'), clientCommand(ROOT));
	});

	test('the installed suite: the scenarios that allow a client error are the ones that must refuse the server', { skip: !installed && 'the suite is not installed' }, () => {
		const inventory = parseSuiteInventory(readFileSync(path.join(SUITE_DIR, 'dist', 'index.js'), 'utf8'));
		assert.deepStrictEqual([...inventory.clientErrorAllowed].sort(), [
			'auth/iss-normalized', 'auth/iss-supported-missing', 'auth/iss-unexpected', 'auth/iss-wrong-issuer',
			'auth/metadata-issuer-mismatch', 'auth/resource-mismatch', 'auth/scope-retry-limit', 'http-invalid-tool-headers',
			'sep-2640-client-verify-digest', 'sep-2640-client-verify-frontmatter', 'sep-2640-client-verify-size',
		]);
		for (const { scenario } of EXTENSION_SCENARIOS) {
			assert.ok(inventory.scenarios.has(scenario), scenario);
		}
	});
});

suite('requirements conversion', () => {
	test('ZON: structs, tuples, enum literals, integers, comments and every string escape', () => {
		const document = parseZon([
			'// a comment',
			'.{',
			'    .text = "a \\"quote\\", a \\\\ backslash, \\x41, \\u{1F600}, tab\\tnewline\\n\\\'",',
			'    .dash = "x \\xe2\\x80\\x94 y \\xe2\\x88\\x922^53",',
			'    .raw = "already — UTF-8",',
			'    .level = .must_not,',
			'    .line = 42,',
			'    .list = .{ "MUST", "SHOULD", },',
			'    .empty = .{},',
			'    .nested = .{ .{ .a = 1 }, .{ .a = -2 } },',
			'}',
		].join('\n'));
		assert.deepStrictEqual(document, {
			text: 'a "quote", a \\ backslash, A, \u{1F600}, tab\tnewline\n\'',
			dash: 'x \u2014 y \u22122^53',
			raw: 'already \u2014 UTF-8',
			level: new ZonEnum('must_not'),
			line: 42,
			list: ['MUST', 'SHOULD'],
			empty: [],
			nested: [{ a: 1 }, { a: -2 }],
		});
	});

	test('ZON errors name the line', () => {
		assert.throws(() => parseZon('.{\n    .a = "\\xe2",\n}'), /requirements\.zon:2: a string literal is not valid UTF-8/);
		assert.throws(() => parseZon('.{\n    .a = "\\q",\n}'), /requirements\.zon:2: unknown escape \\q/);
		assert.throws(() => parseZon('.{ .a = 1, .a = 2 }'), /\.a is set twice/);
		assert.throws(() => parseZon('.{ .a = 1 } x'), /unexpected text after the document/);
		assert.throws(() => parseZon('.{ .a = "open'), /unterminated string literal/);
	});

	const ZON = [
		'// Generated by zig build extract-requirements. Do not edit.',
		'.{',
		'    .repo = "https://github.com/modelcontextprotocol/modelcontextprotocol",',
		'    .commit = "046fa30",',
		'    .path = "docs/specification/2026-07-28",',
		'    .fixture = "test/fixtures/mcp_spec_2026_07_28",',
		'    .requirements = .{',
		'        .{',
		'            .id = "basic#022-5fe4ec",',
		'            .page = "basic",',
		'            .line = 7,',
		'            .section = "Error Codes",',
		'            .anchor = "error-codes",',
		'            .level = .must_not,',
		'            .keywords = .{"MUST NOT"},',
		'            .party = .both,',
		'            .text = "Implementations MUST NOT emit `-32002` \\xe2\\x80\\x94 resource not found.",',
		'        },',
		'    },',
		'}',
		'',
	].join('\n');

	test('a requirements.zon converts to the JSON of the harness, multi-byte escapes decoded as UTF-8', () => {
		const converted = convertRequirements(ZON, { version: 'v0.5.2', commit: '03b8049' });
		assert.deepStrictEqual({ ...converted, $comment: undefined }, {
			$comment: undefined,
			revision: '2026-07-28',
			source: { name: 'ChristianPresley/zig-sdk', repo: 'https://github.com/ChristianPresley/zig-sdk', version: 'v0.5.2', commit: '03b8049', path: 'docs/spec/requirements.zon', license: 'Apache-2.0' },
			specification: { repo: 'https://github.com/modelcontextprotocol/modelcontextprotocol', commit: '046fa30', path: 'docs/specification/2026-07-28', license: 'MIT AND Apache-2.0', site: 'https://modelcontextprotocol.io/specification/2026-07-28' },
			requirements: [{ id: 'basic#022-5fe4ec', page: 'basic', line: 7, section: 'Error Codes', anchor: 'error-codes', level: 'must_not', keywords: ['MUST NOT'], party: 'both', text: 'Implementations MUST NOT emit `-32002` \u2014 resource not found.' }],
		});
		assert.match(String(converted.$comment), /^The normative sentences of the MCP 2026-07-28 specification, .* Generated by node test\/mcp-conformance\/tools\/convert-requirements\.ts /);
		const json = formatRequirementsJson(converted);
		assert.ok(json.endsWith('}\n') && json.includes('\n\t"revision": "2026-07-28",\n'));
		assert.ok(!/[\u0080-\u009f]/.test(json), 'no C1 characters (the mojibake of a per-byte decode)');
		assert.strictEqual(requirementsRevision('docs/specification/2025-11-25'), '2025-11-25');
		assert.throws(() => requirementsRevision('docs/specification/draft'), /does not end in a specification revision/);
	});

	test('the conversion refuses entries it cannot map', () => {
		assert.throws(() => convertRequirements(ZON.replace('.level = .must_not', '.level = .must_maybe'), { version: 'v', commit: 'c' }), /basic#022-5fe4ec: \.level must be one of/);
		assert.throws(() => convertRequirements(ZON.replace('.party = .both', '.party = "both"'), { version: 'v', commit: 'c' }), /\.party must be one of/);
		assert.throws(() => convertRequirements(ZON.replace('        },\n    },', '        },\n' + ZON.slice(ZON.indexOf('        .{'), ZON.indexOf('    },\n}')) + '    },'), { version: 'v', commit: 'c' }), /basic#022-5fe4ec is listed twice/);
	});

	test('the zon is read from the checkout\'s history at the commit, never from its working tree', () => {
		const calls: (readonly string[])[] = [];
		const read = readZonAtCommit('/zig-sdk', '03b8049', (cwd, args) => {
			calls.push([cwd, ...args]);
			return { status: 0, stdout: Buffer.from(ZON, 'utf8') };
		});
		assert.deepStrictEqual(calls, [['/zig-sdk', 'show', '03b8049:docs/spec/requirements.zon']]);
		assert.deepStrictEqual(read, { kind: 'text', text: ZON });
		assert.deepStrictEqual(readZonAtCommit('/zig-sdk', 'nope', () => ({ status: 128, stdout: Buffer.alloc(0) })), { kind: 'unavailable', reason: '/zig-sdk is not a zig-sdk checkout with commit nope' });
		assert.strictEqual(readZonAtCommit('/zig-sdk', 'c', () => ({ status: 0, stdout: Buffer.from([0x22, 0xe2, 0x22]) })).kind, 'unavailable');
	});

	test('the vendored requirements file is the conversion of the zig-sdk source it names', () => {
		const file = JSON.parse(readFileSync(path.join(HERE, 'requirements-2026-07-28.json'), 'utf8'));
		assert.ok(!/[\u0080-\u009f]/.test(JSON.stringify(file)), 'no mojibake');
		const zigSdk = process.env.ZIG_SDK_DIR ?? path.resolve(ROOT, '..', 'zig-sdk');
		const read = existsSync(zigSdk) ? readZonAtCommit(zigSdk, file.source.commit) : undefined;
		if (read?.kind !== 'text') {
			return; // no checkout: check-matrix reports a notice
		}
		assert.deepStrictEqual(convertRequirements(read.text, { version: file.source.version, commit: file.source.commit }), file);
	});
});

suite('wrapper scripts', () => {
	async function usage(): Promise<string[]> {
		const logs: string[] = [];
		assert.strictEqual(await main(['--help'], {}, stubDeps({ log: line => logs.push(line) })), 0);
		return logs.join('\n').split('\n');
	}

	test('scripts/test-mcp-conformance.sh and .bat take every subcommand of run.ts and describe the subcommands and options as its usage does', async () => {
		const lines = await usage();
		const subcommands = /<([^>]+)>/.exec(lines[0])?.[1].split('|') ?? [];
		assert.ok(subcommands.includes('render-matrix'), lines[0]);
		const described = lines.filter(line => line.startsWith('  '));
		for (const [name, unescape, accepted] of [
			['test-mcp-conformance.sh', (text: string) => text, (text: string) => /^case "\$1" in\r?\n\t([^)]+)\) ;;/m.exec(text)?.[1].split('|') ?? []],
			['test-mcp-conformance.bat', (text: string) => text.replace(/\^(.)/g, '$1'), (text: string) => [...text.matchAll(/^if \/i "%~1"=="([^"]+)" set SUBCOMMAND=1\r?$/gm)].map(match => match[1])],
		] as const) {
			const text = readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
			assert.deepStrictEqual(accepted(text), subcommands, `${name} passes every subcommand through`);
			const helpLines = text.split(/\r?\n/).map(line => /^\s*echo "?(.*?)"?$/.exec(line)?.[1]).filter((line): line is string => line !== undefined).map(unescape);
			assert.ok(helpLines.some(line => line.includes(`[${subcommands.join('|')}]`)), `${name}: the usage line names every subcommand`);
			assert.deepStrictEqual(described.filter(line => !helpLines.includes(line)), [], `${name}: help lines that differ from run.ts --help`);
		}
	});
});

suite('pinned suite version', () => {
	test('the files that name a version of the conformance suite name the one package.json pins', () => {
		const packageJson = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
		const pinned = packageJson.devDependencies['@modelcontextprotocol/conformance'];
		for (const file of ['src/vs/platform/mcp/test/node/fixtures/mcp-schema-2025-11-25/README.md', 'test/mcp-conformance/requirement-matrix.md']) {
			const named = [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(/@modelcontextprotocol\/conformance@(\d[^\s`'"),;]*)/g)].map(match => match[1]);
			assert.ok(named.length > 0, `${file} names the suite`);
			assert.deepStrictEqual([...new Set(named)], [pinned], file);
		}
	});
});

/** A string constant of a source file, read as text (the harness imports nothing outside its folder). */
function sourceConstant(file: string, name: string): string {
	const match = new RegExp(`export const ${name} = '([^']+)';`).exec(readFileSync(path.join(ROOT, file), 'utf8'));
	assert.ok(match, `${file} defines ${name}`);
	return match[1];
}

suite('gRPC docs', () => {
	const PROTO = 'src/vs/platform/mcp/common/mcpGrpcProto.ts';
	const DOCS = ['test/mcp-conformance/README.md', 'test/mcp-grpc/README.md', ...readdirSync(path.join(HERE, 'docs')).filter(name => name.endsWith('.md')).map(name => `test/mcp-conformance/docs/${name}`)];

	test('the docs name the tunnel package that mcpGrpcProto.ts defines', () => {
		const tunnel = sourceConstant(PROTO, 'TUNNEL_PACKAGE');
		const problems: string[] = [];
		for (const file of DOCS) {
			for (const match of readFileSync(path.join(ROOT, file), 'utf8').matchAll(/\bmcp(?:\.[a-z0-9_]+)+\.v\d+\b/g)) {
				if (match[0] !== tunnel) {
					problems.push(`${file}: ${match[0]} is not the tunnel package ${tunnel}`);
				}
			}
		}
		assert.deepStrictEqual(problems, []);
	});

	test('the docs describe keepAliveMs as the mcp.json schema and the code do: pings only while a call is open, 0 is off, unset pings only while a listen stream is open', () => {
		const grpc = readFileSync(path.join(ROOT, 'src/vs/workbench/api/node/extHostMcpGrpc.ts'), 'utf8');
		const min = /export const MIN_GRPC_KEEPALIVE_MS = ([\d_]+);/.exec(grpc);
		const extra = /export const DEFAULT_GRPC_LISTEN_KEEPALIVE_MS = MIN_GRPC_KEEPALIVE_MS \+ ([\d_]+);/.exec(grpc);
		assert.ok(min && extra, 'extHostMcpGrpc.ts defines the keepalive intervals');
		const listenMs = Number(min[1].replace(/_/g, '')) + Number(extra[1].replace(/_/g, ''));
		const unset = `a ping is sent every ${Math.floor(listenMs / 60_000)} minutes and ${listenMs % 60_000 / 1000} seconds only while a \`subscriptions/listen\` stream is open`;
		const entries: readonly [string, RegExp][] = [
			['src/vs/workbench/contrib/mcp/common/mcpConfiguration.ts', /'app\.mcp\.json\.grpc\.keepAliveMs', ".*$/m],
			['test/mcp-conformance/docs/release-notes.md', /^- `keepAliveMs`:.*$/m],
			['test/mcp-conformance/docs/vscode-docs-mcp.md', /^\| `keepAliveMs` \|.*$/m],
		];
		const problems: string[] = [];
		for (const [file, pattern] of entries) {
			const entry = pattern.exec(readFileSync(path.join(ROOT, file), 'utf8'))?.[0];
			if (!entry) {
				problems.push(`${file} does not document keepAliveMs`);
				continue;
			}
			for (const [what, text] of [['the default', unset], ['no pings on an idle connection', 'only while at least one call is open'], ['0 is off', '`0` sends no pings']]) {
				if (!entry.includes(text)) {
					problems.push(`${file}: ${what} (${text}) is missing`);
				}
			}
		}
		assert.deepStrictEqual(problems, []);
	});
});

suite('CI path filters', () => {
	const WORKFLOW = '.github/workflows/mcp-conformance.yml';
	const DETECT = '.github/actions/detect-changes/detect.ts';

	/** The paths of the `mcp` rule of detect-changes (read as text: the harness imports nothing outside its folder). */
	function mcpRule(): readonly string[] {
		const text = readFileSync(path.join(ROOT, DETECT), 'utf8');
		const rule = /\boutput: 'mcp',\s*paths: \[([^\]]*)\]/.exec(text);
		assert.ok(rule, `${DETECT} has an mcp rule`);
		const paths = [...rule[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(match => match[1]);
		assert.ok(paths.length > 0, `${DETECT}: the mcp rule lists paths`);
		return paths;
	}

	/** Whether a rule entry covers a file, as detect-changes matches them: an entry ending in `/` is a folder, any other one a file. */
	function matchesAny(file: string, entries: readonly string[]): boolean {
		return entries.some(entry => entry.endsWith('/') ? file.startsWith(entry) : file === entry);
	}

	/** The `on.push.paths` globs of the workflow. */
	function pushPaths(): string[] {
		const lines = readFileSync(path.join(ROOT, WORKFLOW), 'utf8').split(/\r?\n/);
		const push = lines.findIndex(line => /^ {2}push:\s*$/.test(line));
		const start = lines.findIndex((line, index) => index > push && /^ {4}paths:\s*$/.test(line));
		assert.ok(push !== -1 && start !== -1, `${WORKFLOW} has on.push.paths`);
		const globs: string[] = [];
		for (const line of lines.slice(start + 1)) {
			const entry = /^ {6}- '([^']+)'\s*$/.exec(line);
			if (!entry) {
				break;
			}
			globs.push(entry[1]);
		}
		return globs;
	}

	/** A GitHub Actions path glob (`**` any path, `*` any name) as a regular expression. */
	function globRegExp(glob: string): RegExp {
		const source = glob.split('**').map(part => part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
		return new RegExp(`^${source}$`);
	}

	/** A file that a rule entry covers: the entry itself, or a file inside it for a folder. */
	function sampleOf(entry: string): string {
		return entry.endsWith('/') ? `${entry}sub/file.ts` : entry;
	}

	/** The non-test TypeScript files under a repository folder. */
	function sourceFiles(folder: string): string[] {
		const files: string[] = [];
		const walk = (relative: string) => {
			for (const entry of readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
				const child = `${relative}/${entry.name}`;
				if (entry.isDirectory()) {
					if (entry.name !== 'test') {
						walk(child);
					}
				} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
					files.push(child);
				}
			}
		};
		walk(folder);
		return files;
	}

	/** The source files of src/vs that the mcp rule does not cover although every file that imports them is covered by it. */
	function importedOnlyByMcpCode(covered: (file: string) => boolean): string[] {
		const importers = new Map<string, Set<string>>();
		const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)'(\.{1,2}\/[^']+)'/g;
		for (const file of sourceFiles('src/vs')) {
			for (const match of readFileSync(path.join(ROOT, file), 'utf8').matchAll(IMPORT)) {
				const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])).replace(/\.js$/, '.ts');
				const set = importers.get(target) ?? new Set<string>();
				set.add(file);
				importers.set(target, set);
			}
		}
		return [...importers].filter(([target, from]) => target.endsWith('.ts') && !covered(target) && [...from].every(covered)).map(([target]) => target).sort();
	}

	test('the push paths of mcp-conformance.yml are the mcp rule of detect-changes', () => {
		const rule = mcpRule();
		const globs = pushPaths();
		const problems = [
			...rule.filter(entry => !globs.some(glob => globRegExp(glob).test(sampleOf(entry)))).map(entry => `${entry} is in the mcp rule but no push path matches it`),
			...globs.filter(glob => !rule.some(entry => globRegExp(glob).test(sampleOf(entry)))).map(glob => `push path ${glob} matches nothing of the mcp rule`),
		];
		assert.deepStrictEqual(problems, []);
	});

	test('the mcp rule and the push paths cover the MCP sources outside the MCP folders: the extension host\'s MCP files, the schema check, the shared parsers and what only MCP code imports', () => {
		const rule = mcpRule();
		const covered = (file: string) => matchesAny(file, rule);
		const required = new Set<string>([
			// Shared with other features; the Streamable HTTP transport parses its event streams with it.
			'src/vs/base/common/sseParser.ts',
		]);
		for (const file of sourceFiles('src/vs/workbench/api')) {
			if (/\/(mcp|extHostMcp|mainThreadMcp)[^/]*\.ts$/.test(file)) {
				required.add(file);
			}
		}
		const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
		const schemaCheck = packageJson.scripts['mcp:check-schema'] ?? '';
		for (const script of schemaCheck.matchAll(/\bbuild\/\S+\.ts\b/g)) {
			required.add(script[0]);
		}
		assert.ok([...required].some(file => file.startsWith('build/')), 'npm run mcp:check-schema runs a build script');
		for (const file of importedOnlyByMcpCode(covered)) {
			required.add(file);
		}
		const globs = pushPaths().map(globRegExp);
		const problems: string[] = [];
		for (const file of [...required].sort()) {
			assert.ok(existsSync(path.join(ROOT, file)), file);
			if (!covered(file)) {
				problems.push(`${file} is not in the mcp rule of ${DETECT}`);
			}
			if (!globs.some(glob => glob.test(file))) {
				problems.push(`${file} is not in the push paths of ${WORKFLOW}`);
			}
		}
		assert.deepStrictEqual(problems, []);
	});
});
