/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The summary of the repetitions of run-e2e.ps1 -Repeat: one row per test with its result in every
// run, the provenance of each run (all must have tested the same commit and suite), and a strict
// verdict: PASS only when every run passed (exit code 0 and summary exit code 0).
// Writes <runs dir>/<name>.md and <name>.json.
//
// Usage: node runner/aggregate.ts <runs dir> <name> <run id>... [--exit-codes <c1,c2,...>]

import * as fs from 'node:fs';
import * as path from 'node:path';

interface ITestRow {
	readonly name: string;
	readonly group: string;
	readonly status: 'passed' | 'failed' | 'skipped';
	readonly allowedFailure: boolean;
	readonly error?: string;
	readonly skipReason?: string;
	readonly ms: number;
}

interface IRunData {
	readonly id: string;
	readonly exitCode: number | undefined;
	readonly summaryExit: number | undefined;
	readonly commit: string | undefined;
	readonly suiteHash: string | undefined;
	/** The hash of test/mcp-e2e as committed at the installed commit, and whether the run used exactly that. */
	readonly committedSuiteHash: string | undefined;
	readonly suiteMatchesCommit: boolean | undefined;
	/** Why the suite is not the committed one (runner/summarize.ts), when it is not. */
	readonly suiteMismatch: string | undefined;
	readonly tests: Map<string, ITestRow>;
	readonly failedScreenshots: number;
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

function readRun(runsDir: string, id: string, exitCode: number | undefined): IRunData {
	const dir = path.join(runsDir, id);
	const tests = new Map<string, ITestRow>();
	let failedScreenshots = 0;
	for (const suite of ['api', 'ui', 'policy']) {
		const results = readJson<{ tests: ITestRow[]; screenshots?: { ok: boolean }[] }>(path.join(dir, suite, `${suite}-results.json`));
		for (const t of results?.tests ?? []) {
			tests.set(`${suite}: ${t.name}`, t);
		}
		failedScreenshots += (results?.screenshots ?? []).filter(s => !s.ok).length;
	}
	const summary = readJson<{ exitCode?: number }>(path.join(dir, 'summary.json'));
	const provenance = readJson<{ commit?: string; suite?: { sha256?: string }; committedSuite?: { sha256?: string }; suiteMatchesCommit?: boolean; suiteCheckout?: { head?: string; uncommittedChanges?: boolean } }>(path.join(dir, 'provenance.json'));
	return {
		id, exitCode, summaryExit: summary?.exitCode, commit: provenance?.commit, suiteHash: provenance?.suite?.sha256,
		committedSuiteHash: provenance?.committedSuite?.sha256, suiteMatchesCommit: provenance?.suiteMatchesCommit,
		suiteMismatch: provenance?.suiteMatchesCommit === false ? suiteMismatchReason(provenance.suiteCheckout, provenance.commit ?? '') : undefined,
		tests, failedScreenshots,
	};
}

/** Why a run's suite is not test/mcp-e2e of the installed commit, from the checkout it was mounted from. */
function suiteMismatchReason(checkout: { head?: string; uncommittedChanges?: boolean } | undefined, commit: string): string {
	const head = checkout?.head;
	const otherHead = head && commit && !head.startsWith(commit) && !commit.startsWith(head) ? head.slice(0, 11) : undefined;
	if (checkout?.uncommittedChanges === true) {
		return `test/mcp-e2e has uncommitted changes${otherHead ? `, on a checkout of ${otherHead}, not of the installed commit` : ''}`;
	}
	return otherHead ? `the suite is test/mcp-e2e of ${otherHead}, not of the installed commit` : 'test/mcp-e2e differs from the installed commit\'s';
}

function yesNo(value: boolean | undefined): string {
	return value === undefined ? 'unknown' : value ? 'yes' : 'NO';
}

function cell(row: ITestRow | undefined): string {
	if (!row) {
		return 'missing';
	}
	if (row.status === 'failed') {
		return row.allowedFailure ? 'FAIL (allowed)' : 'FAIL';
	}
	return row.status === 'passed' ? 'pass' : 'skip';
}

function main(argv: readonly string[]): number {
	const exitIndex = argv.indexOf('--exit-codes');
	const exitCodes = exitIndex !== -1 ? (argv[exitIndex + 1] ?? '').split(',').map(Number) : [];
	const positional = argv.filter((_a, i) => exitIndex === -1 || (i !== exitIndex && i !== exitIndex + 1));
	const [runsDir, name, ...ids] = positional;
	if (!runsDir || !name || !ids.length) {
		console.error('usage: aggregate.ts <runs dir> <name> <run id>... [--exit-codes <c1,c2,...>]');
		return 2;
	}
	const runs = ids.map((id, i) => readRun(runsDir, id, Number.isFinite(exitCodes[i]) ? exitCodes[i] : undefined));
	const names = [...new Set(runs.flatMap(r => [...r.tests.keys()]))];
	const md: string[] = [`# MCP end-to-end: ${runs.length} runs (${name})`, ''];
	const commits = [...new Set(runs.map(r => r.commit ?? '?'))];
	const suites = [...new Set(runs.map(r => r.suiteHash ?? '?'))];
	md.push(`- installed commit: ${commits.join(', ')}${commits.length > 1 ? ' (DIFFERENT COMMITS)' : ''}`);
	md.push(`- suite sha256: ${suites.join(', ')}${suites.length > 1 ? ' (DIFFERENT SUITES)' : ''}`);
	// Only a run on the committed suite can be reproduced from the commit (line endings do not count).
	const committedSuites = [...new Set(runs.map(r => r.committedSuiteHash ?? '?'))];
	const suiteMatchesCommit = runs.every(r => r.suiteMatchesCommit === true) ? true : runs.some(r => r.suiteMatchesCommit === false) ? false : undefined;
	md.push(`- committed suite sha256 (test/mcp-e2e at the installed commit): ${committedSuites.join(', ')}`);
	md.push(`- suite matches commit: ${yesNo(suiteMatchesCommit)}${suiteMatchesCommit === false ? ' (some runs used a test/mcp-e2e that differs from the one at the installed commit: not reproducible from that commit alone)' : ''}`);
	md.push('', '| Run | Exit | Summary exit | Failed tests | Failed screenshots | Suite matches commit |', '| --- | --- | --- | --- | --- | --- |');
	for (const r of runs) {
		const failed = [...r.tests.values()].filter(t => t.status === 'failed' && !t.allowedFailure).length;
		md.push(`| ${r.id} | ${r.exitCode ?? '?'} | ${r.summaryExit ?? 'no summary'} | ${failed} | ${r.failedScreenshots} | ${yesNo(r.suiteMatchesCommit)}${r.suiteMismatch ? ` (${r.suiteMismatch})` : ''} |`);
	}
	md.push('', `| Test | ${runs.map(r => r.id).join(' | ')} | Stable |`, `| --- | ${runs.map(() => '---').join(' | ')} | --- |`);
	let unstable = 0;
	for (const test of names) {
		const cells = runs.map(r => cell(r.tests.get(test)));
		const stable = cells.every(c => c === cells[0]);
		unstable += stable ? 0 : 1;
		md.push(`| ${test.replace(/\|/g, '\\|')} | ${cells.join(' | ')} | ${stable ? 'yes' : 'NO'} |`);
	}
	const allPassed = runs.every(r => r.exitCode === 0 && r.summaryExit === 0) && commits.length === 1 && suites.length === 1;
	md.push('', `**verdict: ${allPassed ? 'PASS' : 'FAIL'}** (${runs.filter(r => r.exitCode === 0 && r.summaryExit === 0).length}/${runs.length} runs passed, ${unstable} tests with different results across runs)`);
	fs.writeFileSync(path.join(runsDir, `${name}.md`), md.join('\n') + '\n');
	fs.writeFileSync(path.join(runsDir, `${name}.json`), JSON.stringify({
		name, commits, suites, committedSuites, suiteMatchesCommit, allPassed, unstable,
		runs: runs.map(r => ({ id: r.id, exitCode: r.exitCode, summaryExit: r.summaryExit, commit: r.commit, suiteHash: r.suiteHash, committedSuiteHash: r.committedSuiteHash, suiteMatchesCommit: r.suiteMatchesCommit, suiteMismatch: r.suiteMismatch, failedScreenshots: r.failedScreenshots })),
		tests: Object.fromEntries(names.map(test => [test, runs.map(r => cell(r.tests.get(test)))])),
	}, null, '\t'));
	console.log(md.join('\n'));
	return allPassed ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
