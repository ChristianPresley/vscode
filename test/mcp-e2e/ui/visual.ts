/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The UI suite: Playwright launches the installed VS Code (`_electron.launch`) with the E2E
// extension in UI mode, takes the screenshots listed in visual-verification.md, and runs the
// scenarios that need UI input (elicitation answered in the notification and quick input).
// Runs inside the test container under xvfb-run (see containers/run-suite.sh).
//
// Environment: MCP_E2E_APP (the Electron binary), MCP_E2E_USER_DATA, MCP_E2E_EXTENSIONS,
// MCP_E2E_EXTENSION (the E2E extension folder), MCP_E2E_WORKSPACE, MCP_E2E_RESULTS_DIR,
// MCP_E2E_SCREENSHOTS, MCP_E2E_PLAYWRIGHT (the folder Playwright is installed in),
// MCP_E2E_CONTROL_PORT (default 47811), MCP_E2E_ONLY.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';

interface ITestResult {
	name: string;
	group: string;
	status: 'passed' | 'failed' | 'skipped';
	allowedFailure: boolean;
	ms: number;
	error?: string;
	skipReason?: string;
	details: Record<string, unknown>;
}

interface IScreenshot {
	readonly file: string;
	readonly title: string;
	/** What must be visible (the rows of visual-verification.md). */
	readonly expect: string;
	/** Whether the automatic DOM checks found what the screenshot is about. */
	readonly ok: boolean;
	readonly checks: Record<string, boolean>;
	readonly note?: string;
}

const env = {
	app: process.env.MCP_E2E_APP ?? '/usr/share/code-oss/code-oss',
	userData: process.env.MCP_E2E_USER_DATA ?? '/tmp/e2e/user-data-ui',
	extensions: process.env.MCP_E2E_EXTENSIONS ?? '/tmp/e2e/extensions',
	extension: process.env.MCP_E2E_EXTENSION ?? '/tmp/e2e-build/test/mcp-e2e/extension',
	workspace: process.env.MCP_E2E_WORKSPACE ?? '/tmp/e2e/workspace',
	results: process.env.MCP_E2E_RESULTS_DIR ?? '/tmp/e2e/results/ui',
	screenshots: process.env.MCP_E2E_SCREENSHOTS ?? '/vv',
	playwright: process.env.MCP_E2E_PLAYWRIGHT ?? '/work/e2e-tools',
	port: Number(process.env.MCP_E2E_CONTROL_PORT ?? 47811),
	only: (process.env.MCP_E2E_ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean),
	allowFail: (process.env.MCP_E2E_ALLOW_FAIL ?? '').split(',').map(s => s.trim()).filter(Boolean),
};

const requireFromTools = createRequire(path.join(env.playwright, 'package.json'));
const { _electron } = requireFromTools('playwright') as typeof import('playwright');

const WIDTH = 1600;
const HEIGHT = 1000;
const tests: ITestResult[] = [];
const screenshots: IScreenshot[] = [];
/** Modal dialogs that showed up outside a scenario (and were dismissed). */
const unexpectedDialogs: string[] = [];

function log(message: string): void {
	console.log(`[ui] ${message}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

async function control<T>(method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
	const res = await fetch(`http://127.0.0.1:${env.port}${route}`, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`${method} ${route}: ${res.status} ${text}`);
	}
	return JSON.parse(text) as T;
}

async function command(id: string, args: unknown[] = [], wait = true): Promise<void> {
	const result = await control<{ ok: boolean; error?: string }>('POST', '/command', { command: id, args, wait });
	if (!result.ok) {
		throw new Error(`${id} failed: ${result.error}`);
	}
}

async function waitForControl(timeoutMs: number): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const ready = await control<{ ready: boolean; outcomes?: unknown }>('GET', '/ready');
			if (ready.ready) {
				return ready.outcomes;
			}
			last = ready;
		} catch (e) {
			last = e;
		}
		await sleep(1000);
	}
	throw new Error(`the E2E extension's control server was not ready within ${timeoutMs}ms: ${String(last)}`);
}

async function visibleText(page: Page, selector: string): Promise<string> {
	const loc = page.locator(selector);
	const n = await loc.count();
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		if (await loc.nth(i).isVisible()) {
			// Monaco renders spaces as no-break spaces.
			out.push((await loc.nth(i).innerText()).replace(/\u00a0/g, ' '));
		}
	}
	return out.join('\n');
}

/**
 * The row texts (one line per row) of the virtualized lists in `container` (only the rows in view
 * exist in the DOM), read while scrolling with the mouse wheel over the first row that contains
 * `anchor` (default: the first row); scrolls back to the top afterwards.
 */
async function listTextScrolled(page: Page, container: string, anchor?: string, maxSteps = 10): Promise<string> {
	const rows = page.locator(`${container} .monaco-list-row`);
	const anchorRow = anchor ? rows.filter({ hasText: anchor }).first() : rows.first();
	if (!await anchorRow.count()) {
		return '';
	}
	// One entry per row (its lines joined), so that the parts of a row stay together.
	const seen = new Set<string>();
	try {
		await anchorRow.hover({ timeout: 3000 });
		for (let i = 0; i < maxSteps; i++) {
			const before = seen.size;
			const n = await rows.count();
			for (let r = 0; r < n; r++) {
				const row = rows.nth(r);
				if (await row.isVisible()) {
					seen.add((await row.innerText()).replace(/\u00a0/g, ' ').replace(/\s*\n\s*/g, ' '));
				}
			}
			if (i > 0 && seen.size === before) {
				break;
			}
			await page.mouse.wheel(0, 300);
			await sleep(300);
		}
		await page.mouse.wheel(0, -20_000);
		await sleep(300);
	} catch {
		// a list that cannot be hovered: what was read so far
	}
	return [...seen].join('\n');
}

/** The row in `container` that contains `text`, scrolled into the DOM (the lists are virtualized). */
async function rowWithText(page: Page, container: string, text: string, maxSteps = 10): Promise<Locator> {
	const rows = page.locator(`${container} .monaco-list-row`);
	const row = rows.filter({ hasText: text }).first();
	if (!await row.count()) {
		await rows.first().hover({ timeout: 3000 }).catch(() => undefined);
		for (let i = 0; i < maxSteps && !await row.count(); i++) {
			await page.mouse.wheel(0, 300);
			await sleep(300);
		}
	}
	return row;
}

/** Records and dismisses a modal dialog (none is expected outside the scenarios). */
async function dismissDialogs(page: Page): Promise<void> {
	const dialog = page.locator('.monaco-dialog-box');
	for (let i = 0; i < 3 && await dialog.isVisible(); i++) {
		const text = await dialog.innerText();
		unexpectedDialogs.push(text.slice(0, 300));
		log(`dismissing an unexpected dialog: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
		await page.keyboard.press('Escape');
		await sleep(500);
	}
}

async function shot(page: Page, file: string, title: string, expect: string, checks: Record<string, boolean>, note?: string): Promise<void> {
	const target = path.join(env.screenshots, file);
	await page.screenshot({ path: target });
	const ok = Object.values(checks).every(Boolean);
	screenshots.push({ file, title, expect, ok, checks, note });
	log(`screenshot ${file}: ${ok ? 'checks ok' : `checks FAILED ${JSON.stringify(checks)}`}${note ? ` (${note})` : ''}`);
}

async function closeTransientUi(page: Page): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press('Escape');
		await sleep(150);
	}
}

/** Clears notifications so that the next screenshot shows only what it is about. */
async function clearNotifications(): Promise<void> {
	await command('notifications.clearAll').catch(() => undefined);
}

// --- Elicitation: answer the notification and the quick input steps until the scenario ends -------

/** The answer for a quick input step by its title, or `undefined` to accept the default/first item. */
type Answers = (title: string) => string | undefined;

const ANSWERS: Answers = title => {
	switch (title.trim()) {
		case 'name':
		case 'String':
			return 'Ada Lovelace';
		case 'color':
			return 'teal';
		case 'value':
			return 'e2e-value';
		case 'confirm':
			return 'yes';
		default:
			return undefined;
	}
};

interface IElicitationTrace {
	notifications: string[];
	dialogs: string[];
	/** The dialogs a scenario's `dialogButton` answered (the OAuth consent). */
	answeredDialogs: { text: string; button: string }[];
	stalls: Record<string, unknown>[];
	steps: { title: string; answer: string | null; items: string }[];
}

/** A screenshot taken while a scenario shows its UI; when the UI never shows, the screenshot is recorded as failed. */
interface IScenarioShot {
	readonly file: string;
	readonly title: string;
	readonly take: () => Promise<void>;
}

interface IScenarioHooks {
	readonly onFirstForm?: IScenarioShot;
	readonly onNotification?: IScenarioShot;
	/** Taken when the first dialog that {@link IScenarioHooks.dialogButton} answers shows. */
	readonly onDialog?: IScenarioShot;
	/** The answers of this scenario (default {@link ANSWERS}). */
	readonly answers?: Answers;
	/** The button to click in a modal dialog of the scenario, by the dialog's text; other dialogs are dismissed. */
	readonly dialogButton?: (text: string) => string | undefined;
	/** A check of the UI trace once the scenario passed: the reason it fails, or `undefined`. */
	readonly checkTrace?: (trace: IElicitationTrace) => string | undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function answerUi(page: Page, label: string, done: () => boolean, hooks: IScenarioHooks): Promise<IElicitationTrace> {
	const answers = hooks.answers ?? ANSWERS;
	const trace: IElicitationTrace = { notifications: [], dialogs: [], answeredDialogs: [], steps: [], stalls: [] };
	let lastAction = Date.now();
	let stalls = 0;
	let formShot = false;
	let notificationShot = false;
	let dialogShot = false;
	const deadline = Date.now() + 200_000;
	while (!done() && Date.now() < deadline) {
		// The one-time opt-in of chat.tools.global.autoApprove; prepare-profile.ts seeds it, so this
		// only shows when the seeded application storage was not read.
		const dialog = page.locator('.monaco-dialog-box');
		if (await dialog.isVisible()) {
			const text = await dialog.innerText();
			trace.dialogs.push(text.slice(0, 200));
			const enable = dialog.locator('.monaco-button', { hasText: /^Enable$/ });
			const wanted = hooks.dialogButton?.(text);
			const button = wanted === undefined ? undefined : dialog.locator('.monaco-button', { hasText: new RegExp(`^${escapeRegExp(wanted)}$`) });
			if (wanted !== undefined && button && await button.count()) {
				if (!dialogShot && hooks.onDialog) {
					dialogShot = true;
					await hooks.onDialog.take();
				}
				await button.first().click();
				trace.answeredDialogs.push({ text: text.slice(0, 300), button: wanted });
				lastAction = Date.now();
			} else if (/auto approve/i.test(text) && await enable.count()) {
				await enable.first().click();
			} else {
				await page.keyboard.press('Escape');
			}
			await sleep(400);
			continue;
		}
		const respond = page.locator('.notification-toast .monaco-button', { hasText: /^(Respond|Accept|Open URL|Continue)$/ });
		if (await respond.count() && await respond.first().isVisible()) {
			const message = await visibleText(page, '.notification-toast .notification-list-item-message');
			trace.notifications.push(message);
			if (!notificationShot && hooks.onNotification) {
				notificationShot = true;
				await hooks.onNotification.take();
			}
			await respond.first().click();
			await sleep(400);
			lastAction = Date.now();
			continue;
		}
		const widget = page.locator('.quick-input-widget');
		if (await widget.isVisible()) {
			const title = (await visibleText(page, '.quick-input-widget .quick-input-title')).trim();
			const items = await visibleText(page, '.quick-input-widget .quick-input-list .monaco-list-row');
			if (!formShot && hooks.onFirstForm) {
				formShot = true;
				await hooks.onFirstForm.take();
			}
			// The title is the field title (or property name) followed by the step: "name (1/2)".
			const answer = answers(title.replace(/\s*\(\d+\/\d+\)$/, ''));
			trace.steps.push({ title, answer: answer ?? null, items: items.slice(0, 200) });
			const input = page.locator('.quick-input-widget .quick-input-box input');
			if (answer !== undefined) {
				await input.fill(answer);
				await sleep(250);
			}
			await page.keyboard.press('Enter');
			await sleep(500);
			lastAction = Date.now();
			continue;
		}
		if (Date.now() - lastAction > 30_000) {
			// Nothing to answer for 30 s: record what the window shows.
			lastAction = Date.now();
			const file = `zz-stall-${label.replace(/\W+/g, '-')}-${++stalls}.png`;
			await page.screenshot({ path: path.join(env.screenshots, file) }).catch(() => undefined);
			const state = {
				toasts: await page.locator('.notification-toast').count(),
				toastText: (await visibleText(page, '.notifications-toasts')).slice(0, 200),
				centerVisible: await page.locator('.notifications-center').isVisible().catch(() => false),
				quickInputVisible: await page.locator('.quick-input-widget').isVisible().catch(() => false),
			};
			trace.stalls.push({ file, ...state });
			log(`stalled in ${label}: ${JSON.stringify(state)}`);
		}
		await sleep(300);
	}
	return trace;
}

/** The test names of the UI scenarios by id (GET /scenarios), for MCP_E2E_ONLY. */
let scenarioNames: ReadonlyMap<string, string> = new Map();

async function runUiScenario(page: Page, id: string, hooks: IScenarioHooks = {}): Promise<void> {
	const name = scenarioNames.get(id) ?? id;
	if (env.only.length && !env.only.some(o => id.includes(o) || name.includes(o))) {
		return;
	}
	log(`scenario ${id}`);
	await closeTransientUi(page);
	await dismissDialogs(page);
	await clearNotifications();
	let finished = false;
	const started = Date.now();
	const pending = control<ITestResult>('POST', '/scenario', { id }, 300_000).then(r => r, (e: unknown): ITestResult => ({
		name: id, group: 'elicitation', status: 'failed', allowedFailure: false, ms: Date.now() - started, error: String(e), details: {},
	})).finally(() => { finished = true; });
	const trace = await answerUi(page, id, () => finished, hooks);
	const result = await pending;
	for (const hook of [hooks.onNotification, hooks.onFirstForm, hooks.onDialog]) {
		if (hook && !screenshots.some(s => s.file === hook.file)) {
			screenshots.push({ file: hook.file, title: hook.title, expect: '', ok: false, checks: { 'screenshot taken': false }, note: `the UI of ${id} never showed it` });
		}
	}
	result.details.ui = trace;
	if (result.status === 'passed' && !trace.notifications.length && !trace.steps.length && !trace.answeredDialogs.length) {
		result.status = 'failed';
		result.error = 'the scenario passed without any elicitation UI being answered';
	}
	const traceProblem = result.status === 'passed' ? hooks.checkTrace?.(trace) : undefined;
	if (traceProblem) {
		result.status = 'failed';
		result.error = traceProblem;
	}
	result.allowedFailure = result.status === 'failed' && env.allowFail.includes(result.group);
	tests.push(result);
	log(`${result.status.toUpperCase()} ${result.name}${result.error ? `: ${result.error.split('\n')[0]}` : ''}`);
	await closeTransientUi(page);
}

// --- The run -----------------------------------------------------------------------------------

function childEnvironment(extra: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return { ...out, ...extra };
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
	const args = [
		'--no-sandbox', '--disable-gpu', '--password-store=basic', '--log', 'debug', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
		`--user-data-dir=${env.userData}`, `--extensions-dir=${env.extensions}`,
		`--extensionDevelopmentPath=${env.extension}`,
		env.workspace,
	];
	const app = await _electron.launch({
		executablePath: env.app,
		args,
		env: childEnvironment({ MCP_E2E_CONTROL_PORT: String(env.port), MCP_E2E_RESULTS_DIR: env.results }),
		timeout: 120_000,
	});
	const page = await app.firstWindow({ timeout: 120_000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 120_000 });
	await app.evaluate(({ BrowserWindow }, size) => {
		for (const w of BrowserWindow.getAllWindows()) {
			w.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
		}
	}, { width: WIDTH, height: HEIGHT });
	await page.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => undefined);
	return { app, page };
}

/** Runs one screenshot section; a failure is recorded and does not stop the other sections. */
async function section(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await dismissDialogs(page);
		await fn();
	} catch (e) {
		log(`section ${name} failed: ${e instanceof Error ? e.stack : String(e)}`);
		screenshots.push({ file: '', title: name, expect: '', ok: false, checks: { 'section ran': false }, note: e instanceof Error ? e.message : String(e) });
		await page.screenshot({ path: path.join(env.screenshots, `zz-error-${name.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
	} finally {
		await closeTransientUi(page);
	}
}

/** A server of config/servers.json and whether the suite starts it with the others (extension/src/config.ts startsWithOthers). */
interface IConfiguredServer {
	readonly label: string;
	readonly startsWithOthers: boolean;
}

function configuredServers(): IConfiguredServer[] {
	const file = process.env.MCP_E2E_SERVERS ?? path.join(env.extension, '..', 'config', 'servers.json');
	const servers = (JSON.parse(fs.readFileSync(file, 'utf8')) as { servers: { label: string; expectConnectError?: string; ownTest?: boolean; suite?: string }[] }).servers;
	return servers.map(s => ({ label: s.label, startsWithOthers: !s.expectConnectError && !s.ownTest && s.suite !== 'ui' }));
}

/** The output view filter that leaves the negotiation lines of an MCP server log. */
const OUTPUT_FILTER = 'Negotiated,"method":"server/discover","method":"initialize"';

async function screenshotsPart(page: Page): Promise<void> {
	await section(page, 'servers view', async () => {
		await command('workbench.mcp.showInstalledServers');
		await sleep(3000);
		// The list is virtualized and has more rows than fit: read it scrolled through, then shoot the top.
		const text = `${await visibleText(page, '.part.sidebar')}\n${await listTextScrolled(page, '.part.sidebar', 'everything-')}`;
		await shot(page, '01-servers-extensions-view.png', 'MCP servers in the Extensions view',
			'The "MCP Servers - Installed" section of the Extensions view lists the servers of mcp.json by their configured names (as many as fit; the others further down).',
			{ 'zig-http listed': text.includes('zig-http'), 'everything-legacy listed': text.includes('everything-legacy'), 'zig-grpc-typed listed': text.includes('zig-grpc-typed') }, text.slice(0, 400));
	});

	await section(page, 'list servers', async () => {
		await command('workbench.mcp.listServer', [], false);
		await sleep(2500);
		const rows = (await listTextScrolled(page, '.quick-input-widget')).split('\n');
		// The state of each server by its row: Running for every server the suite starts, not running
		// for the ones only their own tests (or the OAuth scenarios, later) start.
		const rowOf = (label: string) => rows.find(r => new RegExp(`(^|[\\s(])${escapeRegExp(label)}($|[\\s,)·])`).test(r));
		const checks: Record<string, boolean> = {};
		for (const server of configuredServers()) {
			const row = rowOf(server.label);
			checks[server.startsWithOthers ? `${server.label} Running` : `${server.label} not running`] = !!row && (server.startsWithOthers ? /\bRunning\b/i.test(row) : !/\bRunning\b/i.test(row));
		}
		await shot(page, '02-servers-quickpick-state.png', 'MCP: List Servers',
			'The MCP: List Servers quick pick shows every server with its state: each server the suite starts Running; zig-oauth, zig-oauth-iss-*, zig-grpc-oauth (started by the OAuth scenarios after this screenshot), the negative entries and the ones only their own API tests start not running.',
			checks, rows.join('\n').slice(0, 1200));
	});

	for (const [label, file, expect] of [
		['zig-http', '03-server-editor-http.png', 'The server editor of zig-http: name, type http and the URL.'],
		['zig-grpc-tunnel', '04-server-editor-grpc.png', 'The server editor of zig-grpc-tunnel: type grpc, the grpc:// URL, "Transport: gRPC" and "Binding: tunnel".'],
	] as const) {
		await section(page, `server editor ${label}`, async () => {
			await command('workbench.mcp.showInstalledServers');
			await sleep(1500);
			const row = await rowWithText(page, '.part.sidebar', label);
			await row.click({ timeout: 10_000 });
			await sleep(2500);
			const editorText = await visibleText(page, '.part.editor');
			await shot(page, file, `MCP server editor of ${label}`, expect,
				label === 'zig-http'
					? { 'editor opened': editorText.includes(label), 'URL shown': editorText.includes('http://127.0.0.1:3000/mcp') }
					: { 'editor opened': editorText.includes(label), 'transport gRPC shown': /Transport:?\s*gRPC/i.test(editorText), 'binding shown': /Binding:?\s*tunnel/i.test(editorText) },
				editorText.slice(0, 300));
		});
	}

	await section(page, 'tools picker', async () => {
		await command('workbench.action.chat.open');
		await sleep(2000);
		await command('workbench.action.chat.configureTools', [], false);
		await sleep(2500);
		const servers = `${await visibleText(page, '.quick-input-widget')}\n${await listTextScrolled(page, '.quick-input-widget')}`;
		await shot(page, '05-tools-picker-servers.png', 'Configure Tools (chat): the MCP servers',
			'The Configure Tools picker lists every MCP server by its serverInfo name next to the configured name ("mcp-conformance-test-server zig-http", "Everything Reference Server everything-legacy"); the gRPC servers have no tools yet ("Update Tools").',
			{
				'serverInfo name of zig-http': /mcp-conformance-test-server\s*zig-http/.test(servers),
				'serverInfo name of everything-legacy': /Everything Reference Server\s*everything-legacy/.test(servers),
				// The typed binding names its server after the serverInfo of ListTools, not its address.
				'serverInfo name of zig-grpc-typed': /mcp-conformance-test-server\s*zig-grpc-typed/.test(servers),
			}, servers.slice(0, 600));
		// Expand one server so that its tools show (server-everything's tools also have titles).
		const twistie = (await rowWithText(page, '.quick-input-widget', 'everything-legacy')).locator('.monaco-tl-twistie');
		await twistie.click({ timeout: 5000 });
		await sleep(1000);
		const tools = await visibleText(page, '.quick-input-widget');
		await shot(page, '05b-tools-picker-tools.png', 'Configure Tools (chat): the tools of everything-legacy',
			'The expanded everything-legacy lists its tools with their descriptions, labelled by reference name ("echo", "get-sum", ...); the picker does not show the titles ("Echo Tool", "Get Sum Tool").',
			// Known product finding (visual-verification.md, 05b): the picker labels tools by reference
			// name, not by title; the check asserts what the product does, the row records the finding.
			{ 'tools of everything-legacy listed (by reference name; titles not shown: known finding)': /echo/.test(tools) && /get-sum/.test(tools) }, tools.slice(0, 600));
	});

	for (const [label, file, expect, initialize] of [
		['zig-http', '06-output-http-modern.png', 'The output of "MCP: zig-http" (filtered to the negotiation): the server/discover request and "Negotiated MCP 2026-07-28 (modern era)"; no initialize.', false],
		['everything-legacy', '07-output-legacy.png', 'The output of "MCP: everything-legacy" (filtered to the negotiation): the server/discover probe, then initialize and "Negotiated MCP 2025-11-25 (legacy era)".', true],
	] as const) {
		await section(page, `output ${label}`, async () => {
			await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
			await command('workbench.mcp.showOutput', [`mcp.config.usrlocal.${label}`]);
			await sleep(2000);
			const filter = page.locator('.part.panel input[placeholder^="Filter"]').first();
			await filter.fill(OUTPUT_FILTER, { timeout: 5000 }).catch(() => undefined);
			await sleep(1500);
			await command('workbench.action.toggleMaximizedPanel').catch(() => undefined);
			await sleep(1500);
			const text = await visibleText(page, '.part.panel');
			await shot(page, file, `MCP output channel of ${label}`, expect, {
				'negotiation line': /Negotiated MCP/.test(text),
				'server/discover shown': text.includes('server/discover'),
				[initialize ? 'initialize shown' : 'no initialize']: initialize === /"method":\s*"initialize"/.test(text),
			}, text.slice(0, 400));
			await filter.fill('').catch(() => undefined);
			await command('workbench.action.toggleMaximizedPanel').catch(() => undefined);
		});
	}
	await command('workbench.action.closePanel').catch(() => undefined);

	await section(page, 'mcp.json completions', async () => {
		// The workspace mcp.json (run-suite.sh writes it without servers); the edits below are never
		// saved. The MCP schema is associated with .vscode/mcp.json files; the user-level mcp.json of
		// this build gets no schema (word completions only), see visual-verification.md.
		await control('POST', '/open', { path: path.join(env.workspace, '.vscode', 'mcp.json') });
		await sleep(1500);
		for (const [file, text, expect, words] of [
			['08-mcp-json-type-completion.png', '{\n\t"servers": {\n\t\t"e2e-new": {\n\t\t\t"url": "grpc://127.0.0.1:50051",\n\t\t\t"type": "$CURSOR$"\n\t\t}\n\t}\n}\n', 'mcp.json: a new server with a grpc:// url and the completion list of "type" open, offering "grpc".', ['grpc']],
			['09-mcp-json-binding-completion.png', '{\n\t"servers": {\n\t\t"e2e-new": {\n\t\t\t"type": "grpc",\n\t\t\t"url": "grpc://127.0.0.1:50051",\n\t\t\t"binding": "$CURSOR$"\n\t\t}\n\t}\n}\n', 'mcp.json: a grpc server with the completion list of "binding" open: "auto" (marked Default value), "tunnel" and "typed".', ['auto', 'tunnel', 'typed']],
		] as const) {
			await control('POST', '/editor', { text });
			await command('workbench.action.focusActiveEditorGroup').catch(() => undefined);
			// The JSON language server may still be starting: trigger the suggestions until they show.
			let suggest = '';
			for (let attempt = 0; attempt < 5 && !words.some(w => suggest.includes(w)); attempt++) {
				await sleep(1500);
				await command('editor.action.triggerSuggest').catch(() => undefined);
				await sleep(2000);
				suggest = await visibleText(page, '.suggest-widget');
			}
			await shot(page, file, file.includes('type') ? 'mcp.json completion of "type"' : 'mcp.json completion of "binding"', expect,
				Object.fromEntries(words.map(w => [`suggests ${w}`, suggest.includes(w)])), suggest.slice(0, 300));
			await page.keyboard.press('Escape');
		}
		await command('workbench.action.revertAndCloseActiveEditor').catch(() => undefined);
	});

	await section(page, 'add server', async () => {
		await command('workbench.mcp.addConfiguration', [], false);
		await sleep(2500);
		const text = await visibleText(page, '.quick-input-widget');
		await shot(page, '10-add-server-quickpick.png', 'MCP: Add Server', 'The MCP: Add Server quick pick lists the server types, including a gRPC entry.', { 'gRPC entry': /grpc/i.test(text) }, text.slice(0, 400));
	});

	await section(page, 'prompts in chat', async () => {
		await command('workbench.action.chat.open');
		await sleep(1500);
		await command('workbench.action.chat.focusInput').catch(() => undefined);
		await sleep(500);
		await page.keyboard.type('/mcp.zig-http');
		await sleep(2500);
		const text = await visibleText(page, '.suggest-widget');
		await shot(page, '11-chat-mcp-prompts.png', 'MCP prompts as chat slash commands',
			'Typing "/mcp.zig-http" in the chat input suggests the prompts of zig-http (test_simple_prompt, test_prompt_with_arguments, ...).',
			{ 'prompt suggested': /test_simple_prompt|test_prompt_with_arguments/.test(text) }, text.slice(0, 400));
		await page.keyboard.press('Escape');
		await page.keyboard.press('Control+A');
		await page.keyboard.press('Backspace');
		await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
	});
}

async function main(): Promise<number> {
	fs.mkdirSync(env.results, { recursive: true });
	fs.mkdirSync(env.screenshots, { recursive: true });
	for (const f of fs.readdirSync(env.screenshots)) {
		if (f.endsWith('.png')) {
			fs.rmSync(path.join(env.screenshots, f));
		}
	}
	const startedAt = new Date();
	const { app, page } = await launch();
	let fatal: string | undefined;
	try {
		const outcomes = await waitForControl(240_000);
		scenarioNames = new Map((await control<{ id: string; name: string }[]>('GET', '/scenarios')).map(s => [s.id, s.name]));
		log(`servers: ${JSON.stringify(outcomes)}`);
		await dismissDialogs(page);
		// The Chat view opens in the secondary side bar on first start; the screenshots do not need it.
		await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
		await sleep(1000);

		if (!env.only.length || env.only.includes('screenshots')) {
			await screenshotsPart(page).catch(async (e: unknown) => {
				log(`screenshots failed: ${e instanceof Error ? e.stack : String(e)}`);
				screenshots.push({ file: '', title: 'screenshots', expect: '', ok: false, checks: { 'screenshots ran to the end': false }, note: e instanceof Error ? e.message : String(e) });
				await page.screenshot({ path: path.join(env.screenshots, 'zz-screenshots-error.png') }).catch(() => undefined);
			});
		}

		// 6. Elicitation and the UI-driven MRTR scenarios.
		await runUiScenario(page, 'test_elicitation_sep1034_defaults', {
			// Accept every default: nothing is typed, Enter takes the item marked "Default value".
			answers: () => undefined,
			onNotification: {
				file: '12-elicitation-notification.png',
				title: 'Elicitation request outside chat',
				take: async () => {
					const toast = page.locator('.notification-toast', { hasText: 'Confirm the defaults' }).first();
					const message = await visibleText(page, '.notification-toast .notification-list-item-message');
					const toastText = (await toast.innerText().catch(() => '')).replace(/ /g, ' ');
					const respond = await toast.locator('.monaco-button', { hasText: /^Respond$/ }).count();
					await shot(page, '12-elicitation-notification.png', 'Elicitation request outside chat', 'A notification from "MCP Server (zig-http)" with the message "Confirm the defaults" and a Respond button.', {
						'message "Confirm the defaults"': message.includes('Confirm the defaults'),
						'source MCP Server (zig-http)': /MCP Server \(zig-http\)/.test(toastText),
						'Respond button': respond > 0,
					}, toastText.slice(0, 300));
				},
			},
			onFirstForm: {
				file: '13-elicitation-form-defaults.png',
				title: 'Elicitation form with SEP-1034 defaults',
				take: async () => {
					const text = await visibleText(page, '.quick-input-widget');
					await shot(page, '13-elicitation-form-defaults.png', 'Elicitation form with SEP-1034 defaults', 'The quick input of the form: step 1 of 2 ("name") offers the default "anonymous" marked "Default value".', { 'default offered': text.includes('anonymous'), 'default marked': /Default value/i.test(text) }, text.slice(0, 300));
				},
			},
		});
		await runUiScenario(page, 'test_input_required_result_elicitation');
		await runUiScenario(page, 'test_elicitation');
		await runUiScenario(page, 'trigger-elicitation-request', {
			onFirstForm: {
				file: '14-elicitation-form-legacy.png',
				title: 'Legacy elicitation/create form (2025-11-25)',
				take: async () => {
					const text = await visibleText(page, '.quick-input-widget');
					await shot(page, '14-elicitation-form-legacy.png', 'Legacy elicitation/create form (2025-11-25)', 'The first step of the server-everything form ("String": your full, legal name).', { 'form shown': /String \(1\/\d+\)/.test(text) }, text.slice(0, 300));
				},
			},
		});
		await runUiScenario(page, 'test_input_required_result_request_state');
		// The same over the gRPC tunnel with TLS (zig-grpcs).
		await runUiScenario(page, 'test_input_required_result_request_state@zig-grpcs');
		await runUiScenario(page, 'test_input_required_result_multi_round');
		await runUiScenario(page, 'test_input_required_result_multiple_inputs');
		// The Tasks extension with an input round first (the name is entered in the form), and with
		// input inside the task (the confirmation, answered with tasks/update).
		await runUiScenario(page, 'test_tool_with_task');
		await runUiScenario(page, 'confirm_delete');
		// The OAuth sign-in of zig-oauth: the consent is a modal dialog ("The MCP Server Definition
		// 'zig-oauth' wants to authenticate to ..."), answered with Allow; the authorization URL goes to
		// the stand-in browser (workbench.externalBrowser, runner/oauth-browser.ts). Last, so that a
		// sign-in left open cannot block the other scenarios.
		await runUiScenario(page, 'oauth', {
			dialogButton: text => /wants to authenticate to/.test(text) ? 'Allow' : undefined,
			checkTrace: trace => trace.answeredDialogs.length === 1 ? undefined : `expected exactly one consent dialog for the sign-in, answered ${trace.answeredDialogs.length}: ${JSON.stringify(trace.answeredDialogs)}`,
			onDialog: {
				file: '15-oauth-consent-dialog.png',
				title: 'OAuth sign-in consent of an MCP server',
				take: async () => {
					const text = (await visibleText(page, '.monaco-dialog-box')).replace(/\s+/g, ' ');
					const buttons = await visibleText(page, '.monaco-dialog-box .monaco-button');
					await shot(page, '15-oauth-consent-dialog.png', 'OAuth sign-in consent of an MCP server', 'The modal dialog "The MCP Server Definition \'zig-oauth\' wants to authenticate to MCP E2E OAuth fixture." with the buttons Allow and Cancel.', {
						'names the server zig-oauth': text.includes('zig-oauth'),
						'asks to authenticate': /wants to authenticate to/.test(text),
						'Allow button': /\bAllow\b/.test(buttons),
						'Cancel button': /\bCancel\b/.test(buttons),
					}, text.slice(0, 300));
				},
			},
		});
		// The negative sign-ins (an authorization response with a wrong iss, or none) and the sign-in
		// over gRPC; each server asks for its own consent.
		const consent = (text: string) => /wants to authenticate to/.test(text) ? 'Allow' : undefined;
		const consentAsked = (trace: IElicitationTrace) => trace.answeredDialogs.length >= 1 ? undefined : 'the sign-in never asked for consent';
		await runUiScenario(page, 'oauth-iss-wrong', { dialogButton: consent, checkTrace: consentAsked });
		await runUiScenario(page, 'oauth-iss-omit', { dialogButton: consent, checkTrace: consentAsked });
		await runUiScenario(page, 'oauth-grpc', { dialogButton: consent, checkTrace: trace => trace.answeredDialogs.length === 1 ? undefined : `expected exactly one consent dialog for the gRPC sign-in, answered ${trace.answeredDialogs.length}` });
	} catch (e) {
		fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
		log(`FATAL ${fatal}`);
		await page.screenshot({ path: path.join(env.screenshots, 'zz-fatal.png') }).catch(() => undefined);
	} finally {
		await app.close().catch(() => undefined);
	}

	if (fatal) {
		tests.push({ name: 'ui: the driver ran to the end', group: 'ui', status: 'failed', allowedFailure: false, ms: 0, error: fatal, details: {} });
	}
	const summary = {
		passed: tests.filter(t => t.status === 'passed').length,
		failed: tests.filter(t => t.status === 'failed' && !t.allowedFailure).length,
		allowedFailures: tests.filter(t => t.status === 'failed' && t.allowedFailure).length,
		skipped: tests.filter(t => t.status === 'skipped').length,
		/** Screenshots whose DOM checks failed, sections that threw and screenshots the UI never showed. */
		screenshotFailures: screenshots.filter(s => !s.ok).length,
	};
	fs.writeFileSync(path.join(env.results, 'ui-results.json'), JSON.stringify({
		suite: 'ui', startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
		environment: { app: env.app, width: WIDTH, height: HEIGHT }, tests, summary, screenshots, unexpectedDialogs,
	}, null, '\t'));
	log(`UI suite: ${summary.passed} passed, ${summary.failed} failed, ${summary.allowedFailures} allowed failures, ${screenshots.length} screenshots (${summary.screenshotFailures} failed)`);
	return summary.failed || (summary.screenshotFailures && !env.allowFail.includes('visual')) ? 1 : 0;
}

process.exitCode = await main();
