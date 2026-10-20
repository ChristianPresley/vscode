/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Command line of `mcpGatewayConformanceMain.js`, kept apart from the entry
 * point so it can be tested without starting a server.
 */

export const CONFORMANCE_MAIN_USAGE = 'Usage: node out/vs/platform/mcp/node/mcpGatewayConformanceMain.js [--url-file <path>] [--log <path>] [--quiet]';

export interface IMcpGatewayConformanceMainOptions {
	/** Where to write the server URL once it listens (in addition to `READY:<url>` on stdout). */
	readonly urlFile?: string;
	/** The file the gateway log goes to (default: a file in the OS temp directory). */
	readonly logFile?: string;
	/** No diagnostics on stderr. */
	readonly quiet: boolean;
	/** `--help`: print the usage and exit. */
	readonly help: boolean;
}

export type McpGatewayConformanceArgs =
	| { readonly ok: true; readonly options: IMcpGatewayConformanceMainOptions }
	| { readonly ok: false; readonly error: string };

const VALUE_FLAGS: ReadonlySet<string> = new Set(['--url-file', '--log']);

/** Parses `process.argv.slice(2)`: `--flag value` and `--flag=value` are both accepted. */
export function parseConformanceMainArgs(argv: readonly string[]): McpGatewayConformanceArgs {
	let urlFile: string | undefined;
	let logFile: string | undefined;
	let quiet = false;
	let help = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const equals = arg.indexOf('=');
		const flag = arg.startsWith('--') && equals !== -1 ? arg.substring(0, equals) : arg;
		let value: string | undefined;
		if (VALUE_FLAGS.has(flag)) {
			if (flag !== arg) {
				value = arg.substring(equals + 1);
			} else {
				value = argv[i + 1];
				if (value === undefined || value.startsWith('--')) {
					return { ok: false, error: `${flag} needs a value` };
				}
				i++;
			}
			if (value.length === 0) {
				return { ok: false, error: `${flag} needs a value` };
			}
		}
		switch (flag) {
			case '--url-file':
				urlFile = value;
				break;
			case '--log':
				logFile = value;
				break;
			case '--quiet':
				if (flag !== arg) {
					return { ok: false, error: '--quiet takes no value' };
				}
				quiet = true;
				break;
			case '--help':
			case '-h':
				help = true;
				break;
			default:
				return { ok: false, error: `Unknown argument: ${arg}` };
		}
	}
	return { ok: true, options: { urlFile, logFile, quiet, help } };
}
