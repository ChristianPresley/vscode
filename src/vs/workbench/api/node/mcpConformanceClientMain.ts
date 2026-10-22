/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The MCP conformance client entry point. The official suite runs it as
//   node out/vs/workbench/api/node/mcpConformanceClientMain.js <server-url>
// with the scenario in MCP_CONFORMANCE_SCENARIO (see mcpConformanceClient.ts).

import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

// This standalone process isn't bootstrapped via bootstrap-esm.ts, so we must
// set _VSCODE_FILE_ROOT ourselves so that FileAccess can resolve module paths.
// This file lives at out/vs/workbench/api/node/ - the root is `out/`.
globalThis._VSCODE_FILE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

import { join } from '../../../base/common/path.js';
import { ConformanceExitCode, main } from './mcpConformanceClient.js';

/** The suite's own per-scenario timeout is 30s by default; this process never outlives it by much. */
const WATCHDOG_MS = 55_000;
/** Open streams must not keep the process alive once the scenario is done. */
const EXIT_GUARD_MS = 250;
const WATCHDOG_EXIT_CODE = 3;
/**
 * When set, the process records its PID in this directory while it runs. The
 * suite spawns the client through a shell and on timeout kills only the shell,
 * which on Windows leaves the client running, so the harness
 * (test/mcp-conformance/run.ts) kills the PIDs still listed after each run.
 */
const PID_DIR_ENV = 'VSCODE_MCP_CONFORMANCE_PID_DIR';

function writeStderr(line: string): void {
	process.stderr.write(line);
}

const pidDir = process.env[PID_DIR_ENV];
const pidFile = pidDir ? join(pidDir, `${process.pid}.pid`) : undefined;
const pidRecorded: Promise<boolean> = pidDir && pidFile
	? fs.mkdir(pidDir, { recursive: true }).then(() => fs.writeFile(pidFile, String(process.pid))).then(() => true, (error: unknown) => {
		writeStderr(`[mcp-conformance] cannot record the PID in ${pidDir}: ${error instanceof Error ? error.message : String(error)}\n`);
		return false;
	})
	: Promise.resolve(false);

/** Removes the PID file before the process exits: a PID left in the directory names a client still running. */
async function removePidFile(): Promise<void> {
	if (pidFile && await pidRecorded) {
		await fs.unlink(pidFile).catch(() => { /* already removed */ });
	}
}

// The suite reads stdout as the client's output and requires it to be empty:
// everything that would go there goes to stderr instead.
console.log = (...args: unknown[]) => { console.error(...args); };
console.info = (...args: unknown[]) => { console.error(...args); };

process.on('uncaughtException', error => {
	writeStderr(`[mcp-conformance] uncaught exception: ${error.stack ?? error.message}\n`);
	process.exitCode = ConformanceExitCode.Failed;
});
process.on('unhandledRejection', reason => {
	writeStderr(`[mcp-conformance] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});

/** A timer that fires without keeping the process alive. */
function unrefTimeout(callback: () => void, ms: number): TimeoutHandle {
	const timer = setTimeout(callback, ms);
	(timer as unknown as NodeJS.Timeout).unref?.();
	return timer;
}

const watchdog = unrefTimeout(() => {
	writeStderr(`[mcp-conformance] watchdog: the scenario did not finish within ${WATCHDOG_MS}ms\n`);
	removePidFile().finally(() => process.exit(WATCHDOG_EXIT_CODE));
}, WATCHDOG_MS);

main(process.argv.slice(2), process.env, { writeStderr }).then(async code => {
	process.exitCode = code;
	clearTimeout(watchdog);
	await removePidFile();
	unrefTimeout(() => process.exit(code), EXIT_GUARD_MS);
}, async (error: unknown) => {
	writeStderr(`[mcp-conformance] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	await removePidFile();
	process.exit(ConformanceExitCode.Failed);
});
