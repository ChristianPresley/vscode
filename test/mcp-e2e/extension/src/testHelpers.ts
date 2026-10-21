/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { mcpToolId, resultToText } from './agent';
import { E2eHarness, sleep } from './harness';
import { IWireEvent, TYPED_SERVICE_PREFIX } from './mcpLog';
import { assert, ITestContext } from './runner';

/** Helpers shared by the test modules (scenarios.ts and tests*.ts). */

export const NEGOTIATED = /Negotiated MCP (\S+) \((\w+) era\)/;
export const TYPED_LIST_TOOLS = `${TYPED_SERVICE_PREFIX}ListTools`;
export const TYPED_CALL_TOOL = `${TYPED_SERVICE_PREFIX}CallTool`;

export function textOf(result: vscode.LanguageModelToolResult): string {
	return result.content.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('');
}

/** A cancelled `invokeTool`: the extension host rebuilds the main thread's CancellationError as an Error named `Canceled`. */
export function isCancellation(error: unknown): boolean {
	return error instanceof vscode.CancellationError || (error instanceof Error && (error.name === 'Canceled' || error.message === 'Canceled'));
}

export function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The MCP tool id of `tool` on a server, which must have it. */
export function toolIdOf(tools: readonly vscode.LanguageModelToolInformation[], label: string, tool: string): string {
	const id = mcpToolId(tools, tool);
	assert(id, `${label} has no ${tool} tool`);
	return id;
}

/** Whether a call of the wire log ended with grpc-status 0. */
export function wireCallSucceeded(events: readonly IWireEvent[], call: IWireEvent): boolean {
	return events.some(e => e.event === 'end' && e.session === call.session && e.stream === call.stream && e.grpcStatus === '0');
}

/** The `end` event of a call of the wire log. */
export function wireEndOf(events: readonly IWireEvent[], call: IWireEvent): IWireEvent | undefined {
	return events.find(e => e.event === 'end' && e.session === call.session && e.stream === call.stream);
}

export interface IDirectCall {
	readonly toolId: string;
	readonly result: vscode.LanguageModelToolResult | undefined;
	readonly text: string;
	readonly error: unknown;
	readonly ms: number;
}

export interface IDirectCallOptions {
	/** Start the server first with the others (default true; false for servers a test starts itself). */
	readonly require?: boolean;
	readonly token?: vscode.CancellationToken;
	readonly toolsTimeoutMs?: number;
}

/**
 * Calls an MCP tool of a server directly with `vscode.lm.invokeTool` (no model: the test decides the
 * tool and its input) and records the call in the test details. Never throws for the tool's own
 * failure: `error` has it.
 */
export async function invokeMcpTool(h: E2eHarness, ctx: ITestContext, label: string, tool: string, input: object, options: IDirectCallOptions = {}): Promise<IDirectCall> {
	if (options.require !== false) {
		await h.requireServer(label);
	}
	const toolId = toolIdOf(await h.waitForTools(label, options.toolsTimeoutMs ?? 60_000), label, tool);
	const started = Date.now();
	let result: vscode.LanguageModelToolResult | undefined;
	let error: unknown;
	try {
		result = await vscode.lm.invokeTool(toolId, { input, toolInvocationToken: undefined }, options.token);
	} catch (e) {
		error = e;
	}
	const call: IDirectCall = { toolId, result, text: resultToText(result), error, ms: Date.now() - started };
	const calls = (ctx.details.directCalls as unknown[] | undefined) ?? [];
	calls.push({ server: label, tool, input, text: call.text.slice(0, 2000), error: error === undefined ? undefined : errorText(error), ms: call.ms });
	ctx.details.directCalls = calls;
	return call;
}

/** Like {@link invokeMcpTool}, and the call must succeed with every expected substring in its text. */
export async function expectToolText(h: E2eHarness, ctx: ITestContext, label: string, tool: string, input: object, expected: readonly string[], options: IDirectCallOptions = {}): Promise<IDirectCall> {
	const call = await invokeMcpTool(h, ctx, label, tool, input, options);
	assert(call.error === undefined, `${tool} on ${label} failed: ${errorText(call.error)}`);
	for (const e of expected) {
		assert(call.text.includes(e), `${tool} on ${label} returned ${JSON.stringify(call.text.slice(0, 500))}, which does not contain ${JSON.stringify(e)}`);
	}
	return call;
}

/** Waits until `probe` is true, or fails with `what`. */
export async function eventually(what: string, timeoutMs: number, probe: () => boolean | Promise<boolean>, intervalMs = 250): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (; ;) {
		if (await probe()) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
		}
		await sleep(intervalMs);
	}
}

/** The lines of every log file of this window (`<logs>/<session>/window1/**`) that match `pattern`. */
export function windowLogLines(h: E2eHarness, pattern: RegExp): { file: string; line: string }[] {
	const out: { file: string; line: string }[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith('.log')) {
				for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
					if (pattern.test(line)) {
						out.push({ file: path.relative(h.windowLogsDir, full), line: line.slice(0, 500) });
					}
				}
			}
		}
	};
	walk(h.windowLogsDir);
	return out;
}

/** Whether a mutation of runner/mutations.ts that the test itself applies is active (MCP_E2E_MUTATIONS). */
export function mutated(h: E2eHarness, name: string): boolean {
	return h.env.mutations.has(name);
}
