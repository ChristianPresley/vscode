/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The MCP gateway as the official conformance suite's server under test: one
// gateway route bound to the conformance fixture invoker, on a random port.
// Start with: node out/vs/platform/mcp/node/mcpGatewayConformanceMain.js [--url-file <path>] [--log <path>] [--quiet] [--grpc]
// Prints `READY:<url>` on stdout (and nothing else) once it listens. With
// `--grpc` the route is also served on the gateway's gRPC listener (both
// bindings) and a second line `GRPC:<port>` follows `READY:<url>`.

import { fileURLToPath } from 'url';

// This standalone process isn't bootstrapped via bootstrap-esm.ts, so we must
// set _VSCODE_FILE_ROOT ourselves so that FileAccess can resolve module paths.
// This file lives at out/vs/platform/mcp/node/ - the root is `out/`.
globalThis._VSCODE_FILE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { AbstractLoggerService, AbstractMessageLogger, ILogger, ILoggerOptions, LogLevel, LogLevelToString } from '../../log/common/log.js';
import { CONFORMANCE_MAIN_USAGE, parseConformanceMainArgs } from './mcpGatewayConformanceArgs.js';
import { CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from './mcpGatewayConformanceInvoker.js';
import { McpGatewayService } from './mcpGatewayService.js';

/** Appends log lines to one file (`@vscode/spdlog` is built for Electron and does not load in plain Node). */
class FileMessageLogger extends AbstractMessageLogger {
	constructor(private readonly _stream: fs.WriteStream, private readonly _name: string, level: LogLevel) {
		super();
		this.setLevel(level);
	}

	protected log(level: LogLevel, message: string): void {
		if (!this._stream.writableEnded) {
			this._stream.write(`${new Date().toISOString()} [${LogLevelToString(level)}] [${this._name}] ${message}\n`);
		}
	}
}

/** A logger service over the OS temp directory whose loggers all write to one file. */
class ConformanceLoggerService extends AbstractLoggerService {
	constructor(private readonly _stream: fs.WriteStream, logLevel: LogLevel) {
		super(logLevel, URI.file(os.tmpdir()));
	}

	protected doCreateLogger(_resource: URI, logLevel: LogLevel, options?: ILoggerOptions): ILogger {
		return new FileMessageLogger(this._stream, options?.name ?? options?.id ?? 'log', logLevel);
	}
}

/** Serves the route over gRPC too (the gRPC interop checks); not part of the conformance suite's command line. */
const GRPC_FLAG = '--grpc';

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const grpc = argv.includes(GRPC_FLAG);
	const usage = `${CONFORMANCE_MAIN_USAGE} [${GRPC_FLAG}]`;
	const parsed = parseConformanceMainArgs(argv.filter(arg => arg !== GRPC_FLAG));
	if (!parsed.ok) {
		process.stderr.write(`${parsed.error}\n${usage}\n`);
		process.exit(2);
	}
	const options = parsed.options;
	if (options.help) {
		process.stderr.write(`${usage}\n`);
		process.exit(0);
	}
	const diagnostic = (message: string) => {
		if (!options.quiet) {
			process.stderr.write(`[McpGatewayConformance] ${message}\n`);
		}
	};

	const logFile = options.logFile ?? join(os.tmpdir(), `mcp-gateway-conformance-${process.pid}.log`);
	const logStream = fs.createWriteStream(logFile, { flags: 'a' });
	logStream.on('error', error => diagnostic(`Cannot write the log file ${logFile}: ${error.message}`));
	const loggerService = new ConformanceLoggerService(logStream, LogLevel.Trace);
	const service = new McpGatewayService(loggerService, { grpc });
	const invoker = new McpGatewayConformanceInvoker();
	const route = await service.createRoute('conformance', invoker, { serverInfo: CONFORMANCE_SERVER_INFO });
	const url = route.address.toString(true);

	if (options.urlFile) {
		await fs.promises.writeFile(options.urlFile, url, 'utf8');
	}
	diagnostic(`Listening on ${url} (log: ${logFile})`);
	process.stdout.write(`READY:${url}\n`);
	if (grpc) {
		const grpcPort = service.grpcPort;
		if (grpcPort === undefined) {
			process.stderr.write('[McpGatewayConformance] The gRPC listener did not start (see the log)\n');
			process.exit(1);
		}
		diagnostic(`gRPC on ${route.grpcAddress?.toString(true)}`);
		process.stdout.write(`GRPC:${grpcPort}\n`);
	}

	let shuttingDown = false;
	const shutdown = (reason: string) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		diagnostic(`Shutting down (${reason})`);
		route.dispose();
		service.dispose();
		invoker.dispose();
		loggerService.dispose();
		logStream.end(() => process.exit(0));
		// Do not hang on a log file that cannot be flushed.
		setTimeout(() => process.exit(0), 2000);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	if (await isPipe(0)) {
		// A parent that spawned us with a stdin pipe ends us by closing it.
		process.stdin.on('end', () => shutdown('stdin closed'));
		process.stdin.on('error', () => shutdown('stdin error'));
		process.stdin.resume();
	}
}

const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

/**
 * True when the file descriptor is a pipe or socket (a closed pipe means the
 * parent went away); false for a TTY, a file or the null device. On Windows
 * `isFIFO()` is false for pipes, so the mode bits are checked directly.
 */
function isPipe(fd: number): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		fs.fstat(fd, (error, stat) => {
			if (error) {
				resolve(false);
				return;
			}
			const type = stat.mode & S_IFMT;
			resolve(stat.isFIFO() || stat.isSocket() || type === S_IFIFO || type === S_IFSOCK);
		});
	});
}

main().catch(error => {
	process.stderr.write(`[McpGatewayConformance] Failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
