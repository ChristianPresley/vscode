/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { mcpToolsOf, serverLabelOf } from './agent';
import { definitionIdOf, IE2eEnvironment, IE2eServer, readEnvironment, readServers, serverByLabel, startsWithOthers } from './config';
import { ILlamaRequestRecord } from './llamaProvider';
import { IHttpProxyEvent, IWireEvent, parseWireLog } from './mcpLog';
import { log } from './runner';

export interface IServerStartOutcome {
	readonly label: string;
	readonly definitionId: string;
	readonly ms: number;
	readonly tools: number;
	readonly error?: string;
	/** The last error, warning and connection state lines of the server's MCP log. */
	readonly logLines: readonly string[];
}

export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls `probe` until it returns a value (not `undefined`) or the time is up. */
export async function waitFor<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>, intervalMs = 250): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (; ;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
		}
		await sleep(intervalMs);
	}
}

function listFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFiles(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

/**
 * Shared state of one run: the configuration, the servers, the logs folder
 * of this window and helpers to start servers and read their logs.
 */
export class E2eHarness {
	readonly env: IE2eEnvironment;
	readonly servers: readonly IE2eServer[];
	private _startOutcomes: Promise<IServerStartOutcome[]> | undefined;

	constructor(private readonly _context: vscode.ExtensionContext) {
		this.env = readEnvironment();
		this.servers = readServers(this.env);
	}

	server(label: string): IE2eServer {
		return serverByLabel(this.servers, label);
	}

	/** `<logs>/<session>/window1`: the extension's log folder is `window1/exthost/<extension id>`. */
	get windowLogsDir(): string {
		return path.resolve(this._context.logUri.fsPath, '..', '..');
	}

	/** The log file of an MCP server (`mcpServer.<definition id>.log`, without the characters file names cannot have). */
	serverLogFile(label: string): string | undefined {
		const id = definitionIdOf(this.server(label)).replace(/[\\/:*?"<>|]/g, '');
		const name = `mcpServer.${id}.log`;
		return listFiles(path.resolve(this.windowLogsDir, '..')).find(f => path.basename(f) === name);
	}

	serverLog(label: string): string {
		const file = this.serverLogFile(label);
		return file ? fs.readFileSync(file, 'utf8') : '';
	}

	/** Waits until the server's log has a line matching `pattern` and returns the match. */
	waitForLogLine(label: string, pattern: RegExp, timeoutMs = 15_000): Promise<RegExpExecArray> {
		return waitFor(`a line matching ${pattern} in the log of ${label}`, timeoutMs, () => pattern.exec(this.serverLog(label)) ?? undefined, 500);
	}

	/**
	 * Polls the server's MCP log until `check` holds (the log is written with a delay) and
	 * returns its details, or fails with the last reason `check` gave.
	 */
	async waitForLog<T>(label: string, what: string, check: (logText: string) => { readonly ok: true; readonly details: T } | { readonly ok: false; readonly reason: string }, timeoutMs = 15_000): Promise<T> {
		let reason = 'not checked';
		try {
			return await waitFor(what, timeoutMs, () => {
				const result = check(this.serverLog(label));
				if (result.ok) {
					return result.details;
				}
				reason = result.reason;
				return undefined;
			}, 500);
		} catch {
			throw new Error(`${label}: ${what} did not happen within ${timeoutMs}ms: ${reason} (log ${this.serverLogFile(label) ?? 'missing'})`);
		}
	}

	/** The wire log of runner/grpc-log-proxy.ts for a server started behind it (`process.grpcLogProxy`, or that of `sharesProcessOf`). */
	wireLogFile(label: string): string {
		return path.join(this.env.serverLogsDir, `${this.server(label).sharesProcessOf ?? label}.wire.jsonl`);
	}

	/** The JSON lines of a log of the network servers (`<server logs>/<name>`); `[]` while it does not exist. */
	jsonLines<T>(name: string): T[] {
		const file = path.join(this.env.serverLogsDir, name);
		return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T) : [];
	}

	/** The request log of runner/http-fault-proxy.ts in front of a server (`process.httpProxy`). */
	httpLog(label: string): IHttpProxyEvent[] {
		return this.jsonLines<IHttpProxyEvent>(`${this.server(label).sharesProcessOf ?? label}.http.jsonl`);
	}

	wireLog(label: string): IWireEvent[] {
		const file = this.wireLogFile(label);
		if (!fs.existsSync(file)) {
			throw new Error(`no wire log ${file}: ${label} must be started behind runner/grpc-log-proxy.ts (process.grpcLogProxy in config/servers.json)`);
		}
		return parseWireLog(fs.readFileSync(file, 'utf8'));
	}

	llamaRequests(): ILlamaRequestRecord[] {
		const file = path.join(this.env.resultsDir, 'llama-requests.jsonl');
		if (!fs.existsSync(file)) {
			return [];
		}
		return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as ILlamaRequestRecord);
	}

	/** Starts the servers (once) and fails fast when this server did not come up. */
	async requireServer(label: string): Promise<IServerStartOutcome> {
		const outcome = (await this.startServers()).find(o => o.label === label);
		if (!outcome || outcome.tools === 0) {
			throw new Error(`${label} did not start: ${outcome?.error ?? 'unknown server'}; log: ${JSON.stringify(outcome?.logLines ?? [])}`);
		}
		return outcome;
	}

	/** The MCP tools of a server, once there is at least one (and `predicate` holds). */
	waitForTools(label: string, timeoutMs = 60_000, predicate: (tools: vscode.LanguageModelToolInformation[]) => boolean = () => true): Promise<vscode.LanguageModelToolInformation[]> {
		return waitFor(`the MCP tools of ${label}`, timeoutMs, () => {
			const tools = mcpToolsOf(label);
			return tools.length && predicate(tools) ? tools : undefined;
		});
	}

	/**
	 * Starts every configured server once (in parallel) and waits for its live tools. The negative
	 * entries (`expectConnectError`) and the UI-only ones (`suite: 'ui'`) are left to their tests.
	 */
	startServers(): Promise<IServerStartOutcome[]> {
		this._startOutcomes ??= this._startServers();
		return this._startOutcomes;
	}

	/**
	 * Starts one server and waits for its tools, retried until `timeoutMs`; `attemptMs` bounds
	 * each start command (which waits for the live tools).
	 */
	async startServer(label: string, timeoutMs = 60_000, attemptMs = 20_000): Promise<IServerStartOutcome> {
		const server = this.server(label);
		const definitionId = definitionIdOf(server);
		const started = Date.now();
		let error: string | undefined;
		let attempts = 0;
		// The command finds servers by definition id; right after startup the MCP service may not
		// have created the server yet (it collects definitions on a throttle), so start again until
		// the tools show up.
		for (const deadline = Date.now() + timeoutMs; ;) {
			attempts++;
			try {
				await Promise.race([
					vscode.commands.executeCommand('workbench.mcp.startServer', definitionId, { waitForLiveTools: true }),
					sleep(attemptMs),
				]);
				await this.waitForTools(server.label, 5_000);
				error = undefined;
				break;
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			if (Date.now() > deadline) {
				break;
			}
		}
		const logLines = this.serverLog(server.label).split('\n').filter(l => /\[(error|warning)\]|Connection state/.test(l)).slice(-4);
		const outcome: IServerStartOutcome = { label: server.label, definitionId, ms: Date.now() - started, tools: mcpToolsOf(server.label).length, error, logLines };
		log(`server ${server.label}: ${outcome.tools} tools after ${outcome.ms} ms and ${attempts} start attempt(s)${error ? ` (${error})` : ''}`);
		return outcome;
	}

	private async _startServers(): Promise<IServerStartOutcome[]> {
		// The provider-defined server shows up once the provider's first answer reached the editor.
		await waitFor('the E2E gRPC provider server definition', 30_000, () => vscode.lm.mcpServerDefinitions.some(d => d.label === 'zig-grpc-api') ? true : undefined).catch(e => log(String(e)));
		const outcomes = await Promise.all(this.servers.filter(startsWithOthers).map(server => this.startServer(server.label)));
		fs.mkdirSync(this.env.resultsDir, { recursive: true });
		const mcpTools = vscode.lm.tools.filter(t => t.tags.includes('mcp')).map(t => `${serverLabelOf(t) ?? '?'}: ${t.name}`);
		fs.writeFileSync(path.join(this.env.resultsDir, `server-start-${process.pid}.json`), JSON.stringify({ outcomes, mcpTools, definitions: vscode.lm.mcpServerDefinitions.map(d => d.label) }, null, '\t'));
		return outcomes;
	}
}
