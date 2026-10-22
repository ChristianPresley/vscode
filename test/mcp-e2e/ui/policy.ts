/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The enterprise policy phase: MCP policy delivered by a real policy source. It runs after the API
// and UI suites in the same test container (containers/run-suite.sh), so nothing else sees the policy.
//
// VS Code on Linux reads its policies from /etc/vscode/policy.json (src/vs/code/electron-main/main.ts
// registers FilePolicyService for LINUX_SYSTEM_POLICY_FILE_PATH, for every product). The phase writes
// that file with ChatAllowedMcpServers, the policy of chat.mcp.allowedServers, allowing two of the
// three servers of its own small mcp.json:
//   zig-http            by its name (serverName): it runs;
//   zig-grpcs-insecure  by its grpcs:// URL (serverUrl): the allow list lets it through, but its
//                       `tls.insecure` is denied while the allow list comes from a policy
//                       (mainThreadMcp.ts _checkInsecureGrpc, 'mcp.grpc.insecureDenied'): Error state,
//                       and VS Code never connects;
//   zig-stdio           not in the list: Error state with the policy message, never launched.
// It launches the installed VS Code once more (ui/visual.ts `launch`) with a fresh user data folder
// holding that mcp.json and the E2E extension, which starts no server itself here
// (MCP_E2E_START_SERVERS=0) and defines no API servers (MCP_E2E_SERVERS: config/servers.json reduced
// to the three), starts the three servers, takes the screenshots 27 to 27c with their DOM checks,
// closes VS Code and removes the policy file. The tests are decided from what the window showed, the
// MCP logs of the window, the logs of the network servers and the configuration as the extension API
// reports it. Results: <results>/policy-results.json (the shape of ui-results.json), and the policy
// file, the mcp.json and the servers.json of the phase. Mutations (runner/mutations.ts): no-policy-file
// writes no policy file, allow-list-in-settings puts the allow list into the user settings instead.
//
// Environment: as ui/visual.ts (MCP_E2E_USER_DATA is the phase's own copy of the run's profile, whose
// User/mcp.json this driver reduces to the three servers), plus MCP_E2E_SERVER_LOGS (the logs of
// runner/start-servers.ts, whose servers must run).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Page } from 'playwright';
import { clearNotifications, closeTransientUi, command, control, dismissDialogs, env, escapeRegExp, launch, listTextScrolled, screenshots, serverLog, shot, sleep, userDefinitionId, visibleText, waitForControl, waitUntil, type ITestResult } from './visual.ts';

/** LINUX_SYSTEM_POLICY_FILE_PATH (src/vs/base/common/policy.ts): the only policy file VS Code reads on Linux. */
const POLICY_FILE = '/etc/vscode/policy.json';
/** The policy of the setting (chat.shared.contribution.ts). */
const POLICY_NAME = 'ChatAllowedMcpServers';
const SETTING = 'chat.mcp.allowedServers';

/** Allowed by its name. */
const BY_NAME = 'zig-http';
/** Allowed by its grpcs:// URL, denied for `tls.insecure`. */
const BY_URL = 'zig-grpcs-insecure';
/** Not in the allow list. */
const NOT_LISTED = 'zig-stdio';
const LABELS = [BY_NAME, NOT_LISTED, BY_URL] as const;
const GROUP = 'policy';
/** The group of a test when not {@link GROUP}: the tls.insecure denial needs the gRPC transport. */
const GROUP_OF: Readonly<Record<string, string>> = {};
/** The mutations of runner/mutations.ts this driver applies: no-policy-file, allow-list-in-settings. */
const MUTATIONS = new Set((process.env.MCP_E2E_MUTATIONS ?? '').split(',').map(s => s.trim()).filter(Boolean));

/** allowedMcpServersService.ts, McpServerAllowResult.NotAllowed. */
const NOT_ALLOWED = /This Model Context Protocol server is not in the list of servers allowed by your organization/;
/** mainThreadMcp.ts 'mcp.grpc.insecureDenied' (the backticks around tls.insecure are optional: the quick pick may render them). */
const INSECURE_DENIED = new RegExp(`The MCP server '${escapeRegExp(BY_URL)}' turns off TLS certificate verification \\(\`?tls\\.insecure\`?\\), which is not allowed while your organization manages the allowed MCP servers`);
/** mainThreadMcp.ts 'mcp.grpc.insecureWarning': the path without an allow list defined by policy. */
const INSECURE_WARNING = /TLS certificate verification is turned off for the MCP server/;

const TEST_NAMES = {
	byName: `enterprise policy (${POLICY_NAME} in ${POLICY_FILE}): ${BY_NAME}, allowed by its name, runs and lists its tools`,
	notListed: `enterprise policy (${POLICY_NAME}): ${NOT_LISTED}, not in the allow list, is in the Error state with the policy message and is never launched`,
	insecure: `enterprise policy (${POLICY_NAME}): ${BY_URL}, allowed by its grpcs:// URL, is denied for tls.insecure (Error state with the policy message, no warning, no connection)`,
	source: `enterprise policy (${POLICY_NAME}): ${SETTING} is the policy value (extension API configuration inspect; no user or workspace value)`,
};
(GROUP_OF as Record<string, string>)[TEST_NAMES.insecure] = 'grpc';
/** The start of the phase (run-suite.sh), before the network servers were restarted for it. */
const PHASE_START = process.env.MCP_E2E_PHASE_START ? Date.parse(process.env.MCP_E2E_PHASE_START) : undefined;
const SHOTS = {
	list: { file: '27-policy-list-servers.png', title: 'MCP: List Servers under an enterprise policy' },
	output: { file: '27b-policy-output-insecure.png', title: 'MCP output channel: tls.insecure denied by the enterprise policy' },
	diagnostics: { file: '27c-policy-diagnostics.png', title: 'Developer: Policy Diagnostics with the MCP allow list' },
};

const tests: ITestResult[] = [];

function log(message: string): void {
	console.log(`[policy] ${message}`);
}

/** The JSON lines of a log of the network servers; a line that does not parse (still being written) is skipped. */
function serverJsonLines(name: string): Record<string, unknown>[] {
	const dir = process.env.MCP_E2E_SERVER_LOGS ?? path.join(env.results, '..', 'servers');
	let text = '';
	try {
		text = fs.readFileSync(path.join(dir, name), 'utf8');
	} catch {
		return [];
	}
	const out: Record<string, unknown>[] = [];
	for (const line of text.split('\n')) {
		try {
			if (line.trim()) {
				out.push(JSON.parse(line) as Record<string, unknown>);
			}
		} catch {
			// a partial line
		}
	}
	return out;
}

/** The `Connection state: ...` lines of a server's MCP log in this window. */
function connectionStates(label: string): string[] {
	return serverLog(label).split('\n').filter(l => /Connection state: /.test(l)).map(l => l.replace(/^.*Connection state: /, '').trim());
}

/** A row of MCP: List Servers by its label ("<label><State> ..."), not a row of a longer label. */
function rowOf(rows: readonly string[], label: string): string {
	return rows.find(r => new RegExp(`^${escapeRegExp(label)}(?![-a-z0-9_.])`).test(r.trim()))?.trim() ?? '';
}

function stateOf(rows: readonly string[], label: string): string {
	return rowOf(rows, label).slice(label.length).trim();
}

function record(name: string, started: number, checks: Record<string, boolean>, details: Record<string, unknown>): void {
	const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([check]) => check);
	const status = failed.length ? 'failed' : 'passed';
	const group = GROUP_OF[name] ?? GROUP;
	tests.push({
		name, group, status, allowedFailure: status === 'failed' && env.allowFail.includes(group), ms: Date.now() - started,
		error: failed.length ? `failed checks: ${failed.join('; ')}` : undefined, details: { checks, ...details },
	});
	log(`${status.toUpperCase()} ${name}${failed.length ? `: ${failed.join('; ')}` : ''}`);
}

interface IPhase {
	/** The value of the policy: the allow list. */
	readonly allowList: readonly Record<string, string>[];
	/** The text of the policy file. */
	readonly policyText: string;
	/** Every label of config/servers.json (to check that no other server shows up). */
	readonly allLabels: readonly string[];
	/** The server whose process (and wire log) the TLS front end of BY_URL is. */
	readonly tlsProcess: string;
	readonly insecureEntry: Record<string, unknown>;
}

/**
 * Reduces config/servers.json (for the E2E extension) and the user mcp.json of the phase's profile
 * to the three servers, and returns the policy. The mcp.json entries are the run's own (resolved
 * paths, any mutation applied), so the grpcs:// URL of the allow list is that of the entry.
 */
function preparePhase(): IPhase {
	const serversFile = path.join(env.extension, '..', 'config', 'servers.json');
	const all = (JSON.parse(fs.readFileSync(serversFile, 'utf8')) as { servers: { label: string; sharesProcessOf?: string }[] }).servers;
	const servers = LABELS.map(label => {
		const server = all.find(s => s.label === label);
		if (!server) {
			throw new Error(`no server ${label} in ${serversFile}`);
		}
		return server;
	});
	const phaseServers = path.join(env.results, 'servers.json');
	fs.writeFileSync(phaseServers, JSON.stringify({ servers }, null, '\t'));
	// Read by the E2E extension in the launched window (childEnvironment copies process.env).
	process.env.MCP_E2E_SERVERS = phaseServers;
	process.env.MCP_E2E_START_SERVERS = '0';

	const mcpJsonFile = path.join(env.userData, 'User', 'mcp.json');
	const profile = JSON.parse(fs.readFileSync(mcpJsonFile, 'utf8')) as { servers: Record<string, Record<string, unknown>> };
	const entries: Record<string, Record<string, unknown>> = {};
	for (const label of LABELS) {
		if (!profile.servers[label]) {
			throw new Error(`no server ${label} in ${mcpJsonFile}`);
		}
		entries[label] = profile.servers[label];
	}
	fs.writeFileSync(mcpJsonFile, JSON.stringify({ servers: entries, inputs: [] }, null, '\t'));
	fs.copyFileSync(mcpJsonFile, path.join(env.results, 'mcp.json'));

	const url = entries[BY_URL].url;
	if (typeof url !== 'string' || !url.startsWith('grpcs://')) {
		throw new Error(`${BY_URL} has no grpcs:// url in ${mcpJsonFile}: ${JSON.stringify(entries[BY_URL])}`);
	}
	const allowList: Record<string, string>[] = [{ serverName: BY_NAME }, { serverUrl: url }];
	// A policy value is a string, a number or a boolean; for an array setting the policy's type is
	// 'string' (configurations.ts toPolicyDefinitionType) and PolicyConfiguration parses the JSON in
	// it, as for the Windows registry and macOS profiles (the Linux template of build/lib/policies has
	// "" for such a policy). So the value is the JSON of the allow list, as a string.
	const policyText = `${JSON.stringify({ [POLICY_NAME]: JSON.stringify(allowList) }, null, '\t')}\n`;
	return {
		allowList, policyText, allLabels: all.map(s => s.label),
		tlsProcess: servers.find(s => s.label === BY_URL)?.sharesProcessOf ?? BY_URL,
		insecureEntry: entries[BY_URL],
	};
}

/** One `workbench.mcp.startServer` with `waitForLiveTools` (it returns once the tools are live or the server is in the Error state). */
async function startServer(label: string, timeoutMs: number): Promise<string | undefined> {
	try {
		const result = await control<{ ok: boolean; error?: string }>('POST', '/command', { command: 'workbench.mcp.startServer', args: [userDefinitionId(label), { waitForLiveTools: true }] }, timeoutMs);
		return result.ok ? undefined : result.error;
	} catch (e) {
		return String(e);
	}
}

/** Runs one part of the window's checks; an error is recorded and does not stop the other parts. */
async function part(page: Page, name: string, errors: Record<string, string>, fn: () => Promise<void>): Promise<void> {
	try {
		await dismissDialogs(page);
		await clearNotifications();
		await fn();
	} catch (e) {
		errors[name] = e instanceof Error ? (e.stack ?? e.message) : String(e);
		log(`${name} failed: ${errors[name]}`);
		await page.screenshot({ path: path.join(env.screenshots, `zz-error-policy-${name.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
	} finally {
		await closeTransientUi(page);
	}
}

/** What the window showed and returned, read while it runs; the tests are decided once it is closed. */
interface IObserved {
	httpTools: string[];
	startErrors: Record<string, string | undefined>;
	rows: string[];
	config?: { value?: unknown; inspect?: Record<string, unknown> };
}

async function runWindow(phase: IPhase, observed: IObserved, errors: Record<string, string>): Promise<void> {
	const { app, page } = await launch();
	try {
		await waitForControl(240_000);
		await dismissDialogs(page);
		// The Chat view opens in the secondary side bar on first start; the screenshots do not need it.
		await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
		await sleep(1000);

		await part(page, 'start servers', errors, async () => {
			// zig-http first, until its tools are live: right after startup the MCP service may not have
			// created the servers yet (the command then does nothing). Then the two blocked ones, once each.
			observed.httpTools = await waitUntil(120_000, async () => {
				observed.startErrors[BY_NAME] = await startServer(BY_NAME, 30_000);
				const tools = await control<string[]>('GET', `/tools?server=${encodeURIComponent(BY_NAME)}`);
				return tools.length ? tools : undefined;
			}, 1000) ?? [];
			for (let attempt = 0; attempt < 3 && !connectionStates(BY_URL).some(s => s.startsWith('Error')); attempt++) {
				observed.startErrors[BY_URL] = await startServer(BY_URL, 30_000);
				await waitUntil(15_000, () => connectionStates(BY_URL).some(s => s.startsWith('Error')), 500);
			}
			observed.startErrors[NOT_LISTED] = await startServer(NOT_LISTED, 30_000);
			await sleep(1000);
		});

		await part(page, 'list servers', errors, async () => {
			const read = async () => (await listTextScrolled(page, '.quick-input-widget')).split('\n');
			const settled = (rows: string[]) => /^Running\b/.test(stateOf(rows, BY_NAME)) && /^Error\b/.test(stateOf(rows, NOT_LISTED)) && /^Error\b/.test(stateOf(rows, BY_URL));
			await command('workbench.mcp.listServer', [], false);
			await sleep(1500);
			const rows = await waitUntil(20_000, async () => {
				const r = await read();
				return settled(r) ? r : undefined;
			}, 1000) ?? await read();
			observed.rows = rows;
			const others = phase.allLabels.filter(l => !(LABELS as readonly string[]).includes(l) && rowOf(rows, l));
			await shot(page, SHOTS.list.file, SHOTS.list.title,
				`MCP: List Servers in a window whose policy file ${POLICY_FILE} sets ${POLICY_NAME} to [{ "serverName": "${BY_NAME}" }, { "serverUrl": "${phase.allowList[1].serverUrl}" }]: ${BY_NAME} Running; ${NOT_LISTED} in the Error state with "This Model Context Protocol server is not in the list of servers allowed by your organization. ..."; ${BY_URL} in the Error state with "The MCP server '${BY_URL}' turns off TLS certificate verification (\`tls.insecure\`), which is not allowed while your organization manages the allowed MCP servers."; no other server.`,
				{
					[`${BY_NAME} Running`]: /^Running\b/.test(stateOf(rows, BY_NAME)),
					[`${NOT_LISTED} in the Error state`]: /^Error\b/.test(stateOf(rows, NOT_LISTED)),
					[`${NOT_LISTED}: the message of a server not in the allow list`]: NOT_ALLOWED.test(rowOf(rows, NOT_LISTED)),
					[`${BY_URL} in the Error state`]: /^Error\b/.test(stateOf(rows, BY_URL)),
					[`${BY_URL}: the tls.insecure policy message`]: INSECURE_DENIED.test(rowOf(rows, BY_URL)),
					'no other configured server listed': others.length === 0,
				}, rows.join('\n').slice(0, 1200));
			await page.keyboard.press('Escape');
		});

		await part(page, 'output', errors, async () => {
			// The output channel of the denied gRPC server, filtered to its connection states.
			await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
			await command('workbench.mcp.showOutput', [userDefinitionId(BY_URL)]);
			await sleep(2000);
			const filter = page.locator('.part.panel input[placeholder^="Filter"]').first();
			await filter.fill('Connection state', { timeout: 5000 }).catch(() => undefined);
			await sleep(1500);
			const text = await visibleText(page, '.part.panel');
			const states = connectionStates(BY_URL);
			await shot(page, SHOTS.output.file, SHOTS.output.title,
				`The output channel "MCP: ${BY_URL}" filtered to "Connection state": Starting and Running (the gRPC launch reports Running before its first call, which the allow list check refuses), then the Error state with the policy message "The MCP server '${BY_URL}' turns off TLS certificate verification (\`tls.insecure\`), which is not allowed while your organization manages the allowed MCP servers.". No "TLS certificate verification is turned off ..." warning: under a policy allow list VS Code denies instead of warning.`,
				{
					// The Output view wraps long lines (wordWrap on), each piece its own row: join them first.
					'the Error line with the policy message shown': /Connection state: Error/.test(text.replace(/\n/g, '')) && INSECURE_DENIED.test(text.replace(/\n/g, '')),
					'the last connection state in the log is that Error': INSECURE_DENIED.test(states.at(-1) ?? '') && /^Error\b/.test(states.at(-1) ?? ''),
					'no tls.insecure warning in the log': !INSECURE_WARNING.test(serverLog(BY_URL)),
				}, `${states.join('\n')}\n---\n${text}`.slice(0, 800));
			await filter.fill('').catch(() => undefined);
			await command('workbench.action.closePanel').catch(() => undefined);
		});

		await part(page, 'configuration', errors, async () => {
			observed.config = await control<{ value?: unknown; inspect?: Record<string, unknown> }>('GET', `/config?key=${encodeURIComponent(SETTING)}`);
		});

		await part(page, 'policy diagnostics', errors, async () => {
			// Developer: Policy Diagnostics opens its report (Markdown, an untitled document) in the preview.
			const ran = await control<{ ok: boolean; error?: string }>('POST', '/command', { command: 'workbench.action.showPolicyDiagnostics', args: [] }, 90_000)
				.then(r => r.ok ? undefined : r.error ?? 'failed', (e: unknown) => String(e));
			const report = await waitUntil(15_000, async () => (await control<{ uri: string; text: string }[]>('GET', `/documents?contains=${encodeURIComponent('# VS Code Policy Diagnostics')}`))[0], 1000);
			// The rendered report is the inner frame of the preview's webview.
			const frame = await waitUntil(20_000, async () => {
				for (const f of page.frames().filter(f => f !== page.mainFrame())) {
					const text = await f.locator('body').innerText({ timeout: 1000 }).catch(() => '');
					if (text.includes('VS Code Policy Diagnostics') && text.includes('Applied Policy')) {
						return f;
					}
				}
				return undefined;
			}, 1000);
			if (frame) {
				await frame.getByRole('heading', { name: 'Applied Policy' }).first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
				await sleep(1000);
			}
			const rendered = frame ? await frame.locator('body').innerText({ timeout: 5000 }).catch(() => '') : await visibleText(page, '.part.editor');
			await clearNotifications();
			// The Applied Policy table: Setting Key | Policy Name | Policy Source | ...
			const sourceRow = /\|\s*chat\.mcp\.allowedServers\s*\|\s*ChatAllowedMcpServers\s*\|\s*Device\s*\|/;
			const renderedRow = /chat\.mcp\.allowedServers\s+ChatAllowedMcpServers\s+Device\b/;
			const appliedAt = rendered.indexOf('Applied Policy');
			await shot(page, SHOTS.diagnostics.file, SHOTS.diagnostics.title,
				`Developer: Policy Diagnostics (its Markdown report in the preview), scrolled to "Applied Policy": the row "${SETTING} | ${POLICY_NAME} | Device" (Device: the policy file, not an account or managed settings).`,
				{
					'Policy Diagnostics ran': ran === undefined,
					'the report lists the setting as applied by the policy, source Device': !!report && sourceRow.test(report.text),
					'the rendered report shows that row': renderedRow.test(rendered),
				}, `${ran ? `error: ${ran}\n` : ''}${report ? report.uri : '(no report document)'}\n---\n${appliedAt === -1 ? rendered.slice(0, 300) : rendered.slice(appliedAt, appliedAt + 500)}`.slice(0, 800));
			// The report stays open: closing its untitled (unsaved) document would ask whether to save it.
		});
	} finally {
		await app.close().catch(() => undefined);
	}
}

async function main(): Promise<number> {
	fs.mkdirSync(env.results, { recursive: true });
	fs.mkdirSync(env.screenshots, { recursive: true });
	// This phase's screenshots of an earlier run (the UI suite clears the folder when it runs).
	for (const f of fs.readdirSync(env.screenshots)) {
		if (/^(27[a-z]?-policy-|zz-error-policy-).*\.png$/.test(f)) {
			fs.rmSync(path.join(env.screenshots, f));
		}
	}
	const startedAt = new Date();
	const started = Date.now();
	const errors: Record<string, string> = {};
	const observed: IObserved = { httpTools: [], startErrors: {}, rows: [] };
	let phase: IPhase | undefined;
	let fatal: string | undefined;
	let createdDir = false;
	let wrotePolicy = false;
	let wireFrom = 0;
	let httpFrom = 0;
	try {
		if (fs.existsSync(POLICY_FILE)) {
			throw new Error(`${POLICY_FILE} exists before the phase; it is left alone and the phase does not run`);
		}
		phase = preparePhase();
		wireFrom = serverJsonLines(`${phase.tlsProcess}.wire.jsonl`).length;
		httpFrom = serverJsonLines(`${BY_NAME}.http.jsonl`).length;
		fs.writeFileSync(path.join(env.results, 'policy.json'), phase.policyText);
		if (MUTATIONS.has('allow-list-in-settings')) {
			// Mutation allow-list-in-settings (runner/mutations.ts): the same allow list as a user setting.
			const settingsFile = path.join(env.userData, 'User', 'settings.json');
			const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
			fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, [SETTING]: phase.allowList }, null, '\t'));
			log(`mutation allow-list-in-settings: ${SETTING} set in ${settingsFile}, no policy file`);
		} else if (MUTATIONS.has('no-policy-file')) {
			log(`mutation no-policy-file: ${POLICY_FILE} is not written`);
		} else {
			createdDir = !fs.existsSync(path.dirname(POLICY_FILE));
			fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
			fs.writeFileSync(POLICY_FILE, phase.policyText);
			wrotePolicy = true;
			log(`${POLICY_FILE}:\n${phase.policyText}`);
		}
		await runWindow(phase, observed, errors);
	} catch (e) {
		fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
		log(`FATAL ${fatal}`);
	} finally {
		if (wrotePolicy) {
			fs.rmSync(POLICY_FILE, { force: true });
			if (createdDir) {
				try {
					fs.rmdirSync(path.dirname(POLICY_FILE));
				} catch {
					// not empty
				}
			}
		}
	}

	if (phase) {
		const insecureStates = connectionStates(BY_URL);
		const stdioStates = connectionStates(NOT_LISTED);
		const wire = serverJsonLines(`${phase.tlsProcess}.wire.jsonl`);
		// The listening entry of the TLS front end restarted for this phase (the log is appended to across the run).
		const listenedAt = PHASE_START === undefined ? -1 : wire.findIndex(e => e.event === 'listening' && Date.parse(String(e.t)) >= PHASE_START);
		const contacts = wire.slice(listenedAt >= 0 ? listenedAt : wireFrom).filter(e => e.event === 'connection' || e.event === 'tls-error');
		const httpRequests = serverJsonLines(`${BY_NAME}.http.jsonl`).slice(httpFrom).filter(e => e.event === 'request').length;
		const rows = observed.rows;

		record(TEST_NAMES.byName, started, {
			[`${BY_NAME} lists its tools`]: observed.httpTools.length > 0,
			[`${BY_NAME} Running in MCP: List Servers`]: /^Running\b/.test(stateOf(rows, BY_NAME)),
			[`the proxy of ${BY_NAME} got VS Code's requests`]: httpRequests > 0,
		}, { tools: observed.httpTools.length, row: rowOf(rows, BY_NAME), httpRequests, startError: observed.startErrors[BY_NAME], connectionStates: connectionStates(BY_NAME) });

		record(TEST_NAMES.notListed, started, {
			[`${NOT_LISTED} in the Error state in MCP: List Servers`]: /^Error\b/.test(stateOf(rows, NOT_LISTED)),
			'the message of a server not in the allow list': NOT_ALLOWED.test(rowOf(rows, NOT_LISTED)),
			[`${NOT_LISTED} never launched (no connection state in its MCP log)`]: stdioStates.length === 0,
		}, { row: rowOf(rows, NOT_LISTED), connectionStates: stdioStates, startError: observed.startErrors[NOT_LISTED] });

		record(TEST_NAMES.insecure, started, {
			[`${BY_URL} has tls.insecure in the phase's mcp.json`]: (phase.insecureEntry.tls as { insecure?: unknown } | undefined)?.insecure === true,
			[`${BY_URL} in the Error state in MCP: List Servers`]: /^Error\b/.test(stateOf(rows, BY_URL)),
			'the tls.insecure policy message in MCP: List Servers': INSECURE_DENIED.test(rowOf(rows, BY_URL)),
			'its MCP log ends in the Error state with that message': /^Error\b/.test(insecureStates.at(-1) ?? '') && INSECURE_DENIED.test(insecureStates.at(-1) ?? ''),
			'no tls.insecure warning in its MCP log': !INSECURE_WARNING.test(serverLog(BY_URL)),
			[`the TLS front end (${phase.tlsProcess}.wire.jsonl) was restarted and listening for this phase`]: listenedAt >= 0,
			'VS Code never connected to it (no connection, no TLS handshake)': contacts.length === 0,
		}, { row: rowOf(rows, BY_URL), connectionStates: insecureStates, contacts: contacts.slice(0, 5), phaseStart: process.env.MCP_E2E_PHASE_START, startError: observed.startErrors[BY_URL] });

		const inspect = observed.config?.inspect;
		const userSettings = (() => {
			try {
				return fs.readFileSync(path.join(env.userData, 'User', 'settings.json'), 'utf8');
			} catch {
				return '';
			}
		})();
		record(TEST_NAMES.source, started, {
			'the configuration answered': !!observed.config,
			'the effective value is the allow list of the policy': isDeepStrictEqual(observed.config?.value, phase.allowList),
			// The extension API reports the policy value as the default (extHostConfiguration.ts inspect);
			// the registered default is null.
			'inspect: defaultValue is the policy value': isDeepStrictEqual(inspect?.defaultValue, phase.allowList),
			'inspect: no user, workspace or folder value': !!inspect && inspect.globalValue === undefined && inspect.workspaceValue === undefined && inspect.workspaceFolderValue === undefined,
			[`the user settings.json does not set ${SETTING}`]: !userSettings.includes(SETTING),
		}, { config: observed.config, expected: phase.allowList });
	}

	// A test or screenshot that a failure before it kept from happening fails too.
	const stopped = fatal ?? Object.entries(errors).map(([name, error]) => `${name}: ${error.split('\n')[0]}`).join('; ');
	for (const name of Object.values(TEST_NAMES)) {
		if (!tests.some(t => t.name === name)) {
			const group = GROUP_OF[name] ?? GROUP;
			tests.push({ name, group, status: 'failed', allowedFailure: env.allowFail.includes(group), ms: 0, error: `not reached: ${stopped.split('\n')[0]}`, details: {} });
		}
	}
	for (const { file, title } of Object.values(SHOTS)) {
		if (!screenshots.some(s => s.file === file)) {
			screenshots.push({ file, title, expect: '', ok: false, checks: { 'screenshot taken': false }, note: `not taken: ${stopped.split('\n')[0]}` });
		}
	}
	if (fatal) {
		tests.push({ name: 'enterprise policy: the driver ran to the end', group: GROUP, status: 'failed', allowedFailure: false, ms: Date.now() - started, error: fatal, details: {} });
	}

	const summary = {
		passed: tests.filter(t => t.status === 'passed').length,
		failed: tests.filter(t => t.status === 'failed' && !t.allowedFailure).length,
		allowedFailures: tests.filter(t => t.status === 'failed' && t.allowedFailure).length,
		skipped: tests.filter(t => t.status === 'skipped').length,
		screenshotFailures: screenshots.filter(s => !s.ok).length,
	};
	fs.writeFileSync(path.join(env.results, 'policy-results.json'), JSON.stringify({
		suite: 'policy', startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
		environment: { app: env.app, policyFile: POLICY_FILE, policy: phase?.policyText, wrotePolicy, servers: LABELS, mutations: [...MUTATIONS], partErrors: errors },
		tests, summary, screenshots,
	}, null, '\t'));
	log(`policy phase: ${summary.passed} passed, ${summary.failed} failed, ${summary.allowedFailures} allowed failures, ${screenshots.length} screenshots (${summary.screenshotFailures} failed)`);
	return summary.failed || (summary.screenshotFailures && !env.allowFail.includes('visual')) ? 1 : 0;
}

process.exitCode = await main();
