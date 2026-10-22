/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { E2eFeature, IE2eEnvironment } from './config';

/**
 * A small sequential test runner: the suite runs inside the extension host
 * (`--extensionTestsPath`) and in UI mode (driven by the Playwright script),
 * and the results of both have the same JSON shape (`<suite>-results.json`).
 */

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface ITestResult {
	readonly name: string;
	readonly group: string;
	readonly status: TestStatus;
	/** A failure in a group of MCP_E2E_ALLOW_FAIL: reported as failed, not counted against the run. */
	readonly allowedFailure: boolean;
	readonly ms: number;
	readonly error?: string;
	readonly skipReason?: string;
	readonly details: Record<string, unknown>;
}

export interface ISuiteResults {
	readonly suite: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly environment: Record<string, unknown>;
	readonly tests: readonly ITestResult[];
	readonly summary: { readonly passed: number; readonly failed: number; readonly allowedFailures: number; readonly skipped: number };
}

/**
 * Thrown by a test that cannot run on this build; the message says why. Only a test that
 * `requires` a feature the build is not expected to have may skip: any other skip is a failure.
 */
export class SkipError extends Error { }

export interface ITestContext {
	/** Free-form data recorded with the result (tool calls, answers, log lines). */
	readonly details: Record<string, unknown>;
	log(message: string): void;
}

export interface ITestCase {
	readonly name: string;
	/** `model`, `agent`, `chat`, `transport`, `grpc`, `negotiation`, `mrtr`, `sampling`, `listen`, `resources`, `apps`, `prompts`, `gateway`, `tasks`, `elicitation`, `oauth`. */
	readonly group: string;
	readonly timeoutMs?: number;
	/** The build feature the test needs; when the build is not expected to have it, a SkipError is a skip. */
	readonly requires?: E2eFeature;
	readonly fn: (ctx: ITestContext) => Promise<void>;
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

export function log(message: string): void {
	console.log(`[mcp-e2e] ${message}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`'${name}' timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runTest(test: ITestCase, env: IE2eEnvironment): Promise<ITestResult> {
	const details: Record<string, unknown> = {};
	const ctx: ITestContext = {
		details,
		log: message => log(`  ${message}`),
	};
	const started = Date.now();
	log(`RUN  ${test.name}`);
	try {
		await withTimeout(test.fn(ctx), test.timeoutMs ?? 180_000, test.name);
		const result: ITestResult = { name: test.name, group: test.group, status: 'passed', allowedFailure: false, ms: Date.now() - started, details };
		log(`PASS ${test.name} (${result.ms} ms)`);
		return result;
	} catch (e) {
		const ms = Date.now() - started;
		if (e instanceof SkipError && test.requires !== undefined && !env.expected.has(test.requires)) {
			log(`SKIP ${test.name}: ${e.message}`);
			return { name: test.name, group: test.group, status: 'skipped', allowedFailure: false, ms, skipReason: `${e.message} (${test.requires} is not expected on this build)`, details };
		}
		const error = e instanceof SkipError
			? `expected on this build${test.requires ? ` (${test.requires})` : ''}, but the test skipped: ${e.message}`
			: e instanceof Error ? (e.stack ?? e.message) : String(e);
		const allowedFailure = env.allowFailGroups.includes(test.group);
		log(`FAIL ${test.name}${allowedFailure ? ' (allowed by MCP_E2E_ALLOW_FAIL)' : ''}: ${e instanceof Error ? e.message : String(e)}`);
		return { name: test.name, group: test.group, status: 'failed', allowedFailure, ms, error, details };
	}
}

export function summarize(tests: readonly ITestResult[]): ISuiteResults['summary'] {
	return {
		passed: tests.filter(t => t.status === 'passed').length,
		failed: tests.filter(t => t.status === 'failed' && !t.allowedFailure).length,
		allowedFailures: tests.filter(t => t.status === 'failed' && t.allowedFailure).length,
		skipped: tests.filter(t => t.status === 'skipped').length,
	};
}

/** Strips the non-JSON parts (tool results hold class instances) before results are written. */
function jsonSafe(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value, (_key, v: unknown) => {
		if (v instanceof Uint8Array) {
			return `<${v.byteLength} bytes>`;
		}
		return v;
	}));
}

export function writeResults(env: IE2eEnvironment, suite: string, startedAt: Date, tests: readonly ITestResult[], environment: Record<string, unknown>): ISuiteResults {
	const results: ISuiteResults = {
		suite,
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		environment,
		tests: jsonSafe(tests) as ITestResult[],
		summary: summarize(tests),
	};
	fs.mkdirSync(env.resultsDir, { recursive: true });
	fs.writeFileSync(path.join(env.resultsDir, `${suite}-results.json`), JSON.stringify(results, null, '\t'));
	return results;
}

export async function runSuite(env: IE2eEnvironment, tests: readonly ITestCase[]): Promise<ITestResult[]> {
	const selected = env.only.length ? tests.filter(t => env.only.some(o => t.name.includes(o))) : tests;
	const results: ITestResult[] = [];
	for (const test of selected) {
		results.push(await runTest(test, env));
	}
	return results;
}
