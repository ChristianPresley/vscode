/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests of the harness with the suite stubbed out: how the options map to the
 * suite's flags, the not-scored loop, timeouts, the baseline refusal on CI,
 * the leftover-client kill, the output parsing, the baseline update and the
 * matrix check. Run with `node --test test/mcp-conformance/run.test.ts`.
 */

import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, suite, test } from 'node:test';
import {
	applyTimingReruns, BaselineUpdater, checkMatrix, CLIENT_MAIN, clientCommand, countChecks, countClientTimeouts, createKillTree, DEFAULT_OUT, DEFAULT_TIMEOUT_MS,
	entryScenario, failingCheckIds, HERE, type IBaselineEntries, type ICheckMatrixInput, type IHarnessDeps, type IInvocation, type IInvocationResult,
	INVOCATION_TIMEOUT_FACTOR, type IOptions, isExitCrashAfterPassingVerdict, type IPlanContext, type IRequirementSet, type ISuiteRun, killLeftovers, main, type Env, parseArgs,
	parseBaselineFile, parseBaselineVerdict, parseCounts, parseMatrix, parseReadyLine, parseRequirementSet, PID_DIR_ENV, planLeg, planScenario, planScored,
	planUnscored, readResults, resultScenario, ROOT, runInvocation, scoredBaseline, SUITE_BIN, UNSCORED_BASELINE, updatedEntries,
} from './run.ts';

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

	test('the server leg is skipped unless asked for or given a URL', () => {
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
		assert.strictEqual(clientCommand(path.join(path.sep, 'repo')), `node ${path.join(path.sep, 'repo', CLIENT_MAIN).split(path.sep).join('/')}`);
		assert.strictEqual(clientCommand(path.join(path.sep, 'my repo')), `node ${CLIENT_MAIN}`);
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

	function input(overrides: Partial<ICheckMatrixInput> = {}): ICheckMatrixInput {
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
			requirementFiles: new Map([['requirements-2026-07-28.json', { requirements: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] }]]),
			requirementTests: {
				harness: '@modelcontextprotocol/conformance@0.2.0-alpha.11',
				requirements: 'requirements-2026-07-28.json',
				mappings: [
					{ id: 'r1', status: 'tested', tests: ['conformance:client/tools_call', 'src/a.test.ts:some test'] },
					{ id: 'r2', status: 'gap', reason: 'M5' },
				],
			},
			pinnedSuiteVersion: '0.2.0-alpha.11',
			fileExists: file => file === 'src/a.test.ts',
			...overrides,
		};
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

	test('tested requirements cite existing files and driven scenarios; the others need a reason', () => {
		const problems = checkMatrix(input({
			requirementTests: {
				harness: '@modelcontextprotocol/conformance@0.1.0',
				requirements: 'requirements-2026-07-28.json',
				mappings: [
					{ id: 'r1', tests: ['src/missing.test.ts', 'conformance:client/auth/metadata-default', 'conformance:server/tools-list'] },
					{ id: 'r2', status: 'gap' },
					{ id: 'r3', status: 'tested' },
					{ id: 'r4', status: 'maybe', reason: 'x' },
					{ id: 'r1', status: 'n-a', reason: 'x' },
				],
			},
		}));
		assert.deepStrictEqual(problems, [
			'requirement-tests.json: harness @modelcontextprotocol/conformance@0.1.0 is not the pinned @modelcontextprotocol/conformance@0.2.0-alpha.11',
			'requirement-tests.json: r1 cites src/missing.test.ts, which does not exist',
			'requirement-tests.json: r1 cites conformance:client/auth/metadata-default, which no driven requirement-matrix.md row covers',
			'requirement-tests.json: r2 is gap without a reason',
			'requirement-tests.json: r3 is tested but cites no test',
			'requirement-tests.json: r4 is not a requirement of requirements-2026-07-28.json',
			'requirement-tests.json: r4: status maybe is not one of tested, gap, n-a',
			'requirement-tests.json: r1 is mapped twice',
		]);
	});

	test('the requirement sets parse the way the suite writes them', () => {
		const set = parseRequirementSet('2026-07-28', 'server:\n  - tools-list\nclient:\n  - tools_call\nnot_scored:\n  - scenario: auth/dpop\n    leg: client\n    reason: extension\n  - scenario: bogus\n');
		assert.deepStrictEqual(set, { revision: '2026-07-28', server: ['tools-list'], client: ['tools_call'], notScored: [{ scenario: 'auth/dpop', leg: 'client', reason: 'extension' }] });
		assert.throws(() => parseRequirementSet('2026-07-28', 'client: tools_call\n'), /must be a list of strings/);
		assert.deepStrictEqual(parseBaselineFile('# only a comment\n'), { client: [], server: [] });
	});
});

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
});
