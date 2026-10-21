/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { IMcpE2eApi } from '../extension';
import { log, runSuite, writeResults } from '../runner';
import { apiTests } from '../scenarios';

export const EXTENSION_ID = 'vscode-e2e.mcp-e2e';

/**
 * The entry point of `--extensionTestsPath`: runs the API suite and writes
 * `api-results.json`. The returned promise rejects when a test failed that
 * is not in a group of MCP_E2E_ALLOW_FAIL, so the workbench exits with 1.
 */
export async function run(): Promise<void> {
	const startedAt = new Date();
	const extension = vscode.extensions.getExtension<IMcpE2eApi>(EXTENSION_ID);
	if (!extension) {
		throw new Error(`${EXTENSION_ID} is not loaded`);
	}
	const { harness } = await extension.activate();
	log(`API suite: ${harness.servers.length} servers, results in ${harness.env.resultsDir}`);

	// `chat.tools.global.autoApprove` (settings.json) takes effect after a one-time opt-in that is
	// kept in application storage. Storage is in memory while extension tests run, so the opt-in
	// that runner/prepare-profile.ts seeds is not read here; this context key is the one VS Code's
	// own API tests use to skip the opt-in dialog (extensions/vscode-api-tests).
	await vscode.commands.executeCommand('setContext', 'vscode.chat.tools.global.autoApprove.testMode', true);

	const results = await runSuite(harness.env, apiTests(harness));
	const written = writeResults(harness.env, 'api', startedAt, results, {
		vscodeVersion: vscode.version,
		appName: vscode.env.appName,
		allowFailGroups: harness.env.allowFailGroups,
		windowLogsDir: harness.windowLogsDir,
	});
	const { passed, failed, allowedFailures, skipped } = written.summary;
	log(`API suite: ${passed} passed, ${failed} failed, ${allowedFailures} allowed failures, ${skipped} skipped`);
	if (failed > 0) {
		throw new Error(`${failed} end-to-end test(s) failed`);
	}
}
