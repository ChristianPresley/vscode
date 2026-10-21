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
	for (const suite of ['api', 'ui']) {
		const results = readJson<{ tests: ITestRow[]; screenshots?: { ok: boolean }[] }>(path.join(dir, suite, `${suite}-results.json`));
		for (const t of results?.tests ?? []) {
			tests.set(`${suite}: ${t.name}`, t);
		}
		failedScreenshots += (results?.screenshots ?? []).filter(s => !s.ok).length;
	}
	const summary = readJson<{ exitCode?: number }>(path.join(dir, 'summary.json'));
	const provenance = readJson<{ commit?: string; suite?: { sha256?: string } }>(path.join(dir, 'provenance.json'));
	return { id, exitCode, summaryExit: summary?.exitCode, commit: provenance?.commit, suiteHash: provenance?.suite?.sha256, tests, failedScreenshots };
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
	md.push('', '| Run | Exit | Summary exit | Failed tests | Failed screenshots |', '| --- | --- | --- | --- | --- |');
	for (const r of runs) {
		const failed = [...r.tests.values()].filter(t => t.status === 'failed' && !t.allowedFailure).length;
		md.push(`| ${r.id} | ${r.exitCode ?? '?'} | ${r.summaryExit ?? 'no summary'} | ${failed} | ${r.failedScreenshots} |`);
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
		name, commits, suites, allPassed, unstable,
		runs: runs.map(r => ({ id: r.id, exitCode: r.exitCode, summaryExit: r.summaryExit, commit: r.commit, suiteHash: r.suiteHash, failedScreenshots: r.failedScreenshots })),
		tests: Object.fromEntries(names.map(test => [test, runs.map(r => cell(r.tests.get(test)))])),
	}, null, '\t'));
	console.log(md.join('\n'));
	return allPassed ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
