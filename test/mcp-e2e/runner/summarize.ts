/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Prints the results of one run and writes <run dir>/summary.json and summary.md.
// Exit code: 0 when every test passed (or failed in an allowed group, or was skipped) and every
// screenshot of the UI suite and the policy phase passed its DOM checks, 1 when a test or a screenshot failed (a
// screenshot whose checks failed, a screenshot section that threw, or a screenshot the UI never
// showed; `visual` in MCP_E2E_ALLOW_FAIL reports them as allowed failures), 2 when a suite produced
// no results.
//
// Usage: node runner/summarize.ts <run dir> [--api-exit <code>] [--ui-exit <code>] [--policy-exit <code>]

import * as fs from 'node:fs';
import * as path from 'node:path';

interface ITestResult {
	readonly name: string;
	readonly group: string;
	readonly status: 'passed' | 'failed' | 'skipped';
	readonly allowedFailure: boolean;
	readonly ms: number;
	readonly error?: string;
	readonly skipReason?: string;
}

interface ISuiteResults {
	readonly suite: string;
	readonly tests: readonly ITestResult[];
	readonly summary: { readonly passed: number; readonly failed: number; readonly allowedFailures: number; readonly skipped: number };
	readonly screenshots?: readonly IScreenshotResult[];
}

interface IScreenshotResult {
	readonly file: string;
	readonly title: string;
	readonly ok: boolean;
	readonly checks?: Record<string, boolean>;
	readonly note?: string;
}

/** The screenshot failures do not fail the run when `visual` is an allowed group. */
const VISUAL_GROUP = 'visual';

function readSuite(file: string): ISuiteResults | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as ISuiteResults;
	} catch {
		return undefined;
	}
}

/** <run dir>/provenance.json of runner/provenance.ts. */
interface IProvenance {
	readonly commit: string;
	readonly version?: string;
	readonly deb: string;
	readonly debSha256: string;
	readonly buildInfo?: Record<string, unknown>;
	readonly buildCommitMatches?: boolean;
	readonly suite: { readonly sha256: string; readonly files: number };
	/** The same hash over test/mcp-e2e as committed at the installed commit (runner/provenance.ts). */
	readonly committedSuite?: { readonly commit: string; readonly sha256?: string; readonly files: number; readonly error?: string };
	readonly suiteMatchesCommit?: boolean;
	readonly suiteCheckout?: { readonly head?: string; readonly uncommittedChanges?: boolean };
	readonly mutations: readonly string[];
	readonly expect: { readonly gatewayGrpc: boolean; readonly gatewayRateLimits?: boolean; readonly gatewayGrpcReason: string };
}

function readProvenance(file: string): IProvenance | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as IProvenance;
	} catch {
		return undefined;
	}
}

function argValue(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Why the suite of the run is not test/mcp-e2e of the installed commit, from the checkout it was
 * mounted from: uncommitted changes there, a checkout of another commit, or else only that it differs.
 */
function suiteMismatchReason(provenance: IProvenance, commit: string): string {
	const checkout = provenance.suiteCheckout;
	const head = checkout?.head;
	const otherHead = head && !head.startsWith(commit) && !commit.startsWith(head) ? head.slice(0, 11) : undefined;
	if (checkout?.uncommittedChanges === true) {
		return `test/mcp-e2e has uncommitted changes${otherHead ? `, on a checkout of ${otherHead}, not of the installed commit` : ''}`;
	}
	return otherHead ? `the suite is test/mcp-e2e of ${otherHead}, not of the installed commit` : 'test/mcp-e2e differs from the installed commit\'s';
}

/** The committed suite and whether the run used it: only such a run can be reproduced from the commit. */
function committedSuiteLine(provenance: IProvenance): string {
	const committed = provenance.committedSuite;
	if (!committed) {
		return 'not recorded';
	}
	if (committed.sha256 === undefined) {
		return `unknown (${committed.error ?? 'no hash'}); suite matches commit: unknown`;
	}
	return `test/mcp-e2e at ${committed.commit.slice(0, 11)} sha256 ${committed.sha256} (${committed.files} files); suite matches commit: ${provenance.suiteMatchesCommit ? 'yes' : `NO (${suiteMismatchReason(provenance, committed.commit)})`}`;
}

function statusLabel(t: ITestResult): string {
	if (t.status === 'failed') {
		return t.allowedFailure ? 'FAIL (allowed)' : 'FAIL';
	}
	return t.status === 'passed' ? 'pass' : 'skip';
}

function firstLine(text: string | undefined): string {
	return (text ?? '').split('\n')[0].slice(0, 300);
}

function failedChecks(shot: IScreenshotResult): string {
	return Object.entries(shot.checks ?? {}).filter(([, ok]) => !ok).map(([name]) => name).join(', ');
}

function main(argv: readonly string[]): number {
	const allowFail = (process.env.MCP_E2E_ALLOW_FAIL ?? '').split(',').map(s => s.trim()).filter(Boolean);
	const runDir = argv[0];
	if (!runDir) {
		console.error('usage: summarize.ts <run dir> [--api-exit <code>] [--ui-exit <code>] [--policy-exit <code>]');
		return 2;
	}
	const suites: { name: string; file: string; exit: string | undefined }[] = [
		{ name: 'api', file: path.join(runDir, 'api', 'api-results.json'), exit: argValue(argv, '--api-exit') },
		{ name: 'ui', file: path.join(runDir, 'ui', 'ui-results.json'), exit: argValue(argv, '--ui-exit') },
		// The enterprise policy phase (ui/policy.ts).
		{ name: 'policy', file: path.join(runDir, 'policy', 'policy-results.json'), exit: argValue(argv, '--policy-exit') },
	];
	const md: string[] = [`# MCP end-to-end run ${path.basename(runDir)}`, ''];
	let code = 0;
	const summary: Record<string, unknown> = { run: path.basename(runDir) };
	// What was tested: the installed commit and package, and the content hash of test/mcp-e2e.
	const provenance = readProvenance(path.join(runDir, 'provenance.json'));
	if (provenance) {
		const lines = [
			`installed commit: ${provenance.commit} (${provenance.version ?? '?'}, ${provenance.deb}, sha256 ${provenance.debSha256.slice(0, 16)})`,
			`build-info: ${provenance.buildInfo ? `${String(provenance.buildInfo.branch)} ${String(provenance.buildInfo.commit)}${provenance.buildCommitMatches ? '' : ' (DOES NOT MATCH the installed commit)'}` : 'none for this package'}`,
			`suite: test/mcp-e2e sha256 ${provenance.suite.sha256} (${provenance.suite.files} files, line endings as LF)`,
			`committed suite: ${committedSuiteLine(provenance)}`,
			...(provenance.suiteCheckout ? [`suite checkout: HEAD ${provenance.suiteCheckout.head?.slice(0, 11) ?? '?'}, uncommitted changes in test/mcp-e2e: ${provenance.suiteCheckout.uncommittedChanges === undefined ? '?' : provenance.suiteCheckout.uncommittedChanges ? 'yes' : 'no'}`] : []),
			`expected on this build: gateway gRPC ${provenance.expect.gatewayGrpc ? 'yes' : 'no'}, gateway rate limits ${provenance.expect.gatewayRateLimits === false ? 'no' : 'yes'} (${provenance.expect.gatewayGrpcReason})`,
			...(provenance.mutations.length ? [`MUTATIONS: ${provenance.mutations.join(', ')} (tests are expected to fail)`] : []),
		];
		for (const line of lines) {
			console.log(line);
		}
		md.push(...lines.map(l => `- ${l}`), '');
		summary.provenance = provenance;
	} else {
		console.log('provenance: none (no provenance.json)');
		md.push('- provenance: none (no provenance.json)', '');
	}
	for (const suite of suites) {
		const results = readSuite(suite.file);
		if (!results) {
			if (suite.exit !== undefined && suite.exit !== '0') {
				console.log(`\n${suite.name}: NO RESULTS (exit ${suite.exit})`);
				md.push(`## ${suite.name}`, '', `No results (exit ${suite.exit}).`, '');
				summary[suite.name] = { error: `no results, exit ${suite.exit}` };
				code = Math.max(code, 2);
			}
			continue;
		}
		const s = results.summary;
		summary[suite.name] = s;
		console.log(`\n${suite.name}: ${s.passed} passed, ${s.failed} failed, ${s.allowedFailures} allowed failures, ${s.skipped} skipped`);
		md.push(`## ${suite.name}: ${s.passed} passed, ${s.failed} failed, ${s.allowedFailures} allowed failures, ${s.skipped} skipped`, '', '| Result | Group | Test | ms | Note |', '| --- | --- | --- | --- | --- |');
		for (const t of results.tests) {
			const note = t.status === 'failed' ? firstLine(t.error) : t.status === 'skipped' ? (t.skipReason ?? '') : '';
			console.log(`  ${statusLabel(t).padEnd(14)} ${t.group.padEnd(12)} ${t.name}${note ? `\n${' '.repeat(30)}${note}` : ''}`);
			md.push(`| ${statusLabel(t)} | ${t.group} | ${t.name} | ${t.ms} | ${note.replace(/\|/g, '\\|')} |`);
		}
		md.push('');
		const shots = results.screenshots ?? [];
		if (shots.length) {
			const failedShots = shots.filter(shot => !shot.ok);
			const allowed = allowFail.includes(VISUAL_GROUP);
			const label = (shot: IScreenshotResult) => shot.ok ? 'pass' : allowed ? 'FAIL (allowed)' : 'FAIL';
			console.log(`  screenshots: ${shots.length - failedShots.length} passed, ${failedShots.length} failed${allowed && failedShots.length ? ' (allowed)' : ''}`);
			md.push(`### ${suite.name} screenshots: ${shots.length - failedShots.length} passed, ${failedShots.length} failed`, '', '| Result | Screenshot | Title | Failed checks |', '| --- | --- | --- | --- |');
			for (const shot of shots) {
				const failed = shot.ok ? '' : `${failedChecks(shot) || 'n/a'}${shot.note ? `: ${firstLine(shot.note)}` : ''}`;
				console.log(`  ${label(shot).padEnd(14)} ${VISUAL_GROUP.padEnd(12)} ${shot.file || '(no file)'}: ${shot.title}${failed ? `\n${' '.repeat(30)}${failed}` : ''}`);
				md.push(`| ${label(shot)} | ${shot.file || '(none)'} | ${shot.title} | ${failed.replace(/\|/g, '\\|')} |`);
			}
			md.push('');
			summary[`${suite.name}Screenshots`] = { passed: shots.length - failedShots.length, failed: failedShots.length, allowed };
			if (failedShots.length && !allowed) {
				code = Math.max(code, 1);
			}
		}
		if (s.failed > 0) {
			code = Math.max(code, 1);
		}
	}
	fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ ...summary, exitCode: code }, null, '\t'));
	fs.writeFileSync(path.join(runDir, 'summary.md'), md.join('\n'));
	console.log(`\nverdict: ${code === 0 ? 'PASS' : 'FAIL'} (exit ${code})`);
	return code;
}

process.exitCode = main(process.argv.slice(2));
