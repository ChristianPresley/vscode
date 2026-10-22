/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The UI suite: Playwright launches the installed VS Code (`_electron.launch`) with the E2E
// extension in UI mode, takes the screenshots listed in visual-verification.md, and runs the
// scenarios that need UI input (elicitation answered in the notification and quick input).
// Runs inside the test container under xvfb-run (see containers/run-suite.sh).
//
// Order: the screenshot sections that need no tool call, then the scenarios (elicitation, tasks,
// OAuth; the Accounts menu right after the zig-oauth sign-in), then the sections that call tools
// from the chat view through the E2E extension's `@e2e` participant. A chat request starts the MCP
// servers that never ran (chat.mcp.autostart), the OAuth ones included, so no chat request may come
// before the OAuth scenarios.
//
// Environment: MCP_E2E_APP (the Electron binary), MCP_E2E_USER_DATA, MCP_E2E_EXTENSIONS,
// MCP_E2E_EXTENSION (the E2E extension folder), MCP_E2E_WORKSPACE, MCP_E2E_RESULTS_DIR,
// MCP_E2E_SCREENSHOTS, MCP_E2E_PLAYWRIGHT (the folder Playwright is installed in),
// MCP_E2E_CONTROL_PORT (default 47811), MCP_E2E_ONLY (comma-separated: scenario ids or test names,
// `screenshots` for every screenshot section, `shot:<section name>` for one).
//
// The enterprise policy phase (ui/policy.ts) reuses `launch` and the helpers exported here.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';

export interface ITestResult {
	name: string;
	group: string;
	status: 'passed' | 'failed' | 'skipped';
	allowedFailure: boolean;
	ms: number;
	error?: string;
	skipReason?: string;
	details: Record<string, unknown>;
}

export interface IScreenshot {
	readonly file: string;
	readonly title: string;
	/** What must be visible (the rows of visual-verification.md). */
	readonly expect: string;
	/** Whether the automatic DOM checks found what the screenshot is about. */
	readonly ok: boolean;
	readonly checks: Record<string, boolean>;
	readonly note?: string;
}

export const env = {
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
export const screenshots: IScreenshot[] = [];
/** Modal dialogs that showed up outside a scenario (and were dismissed). */
const unexpectedDialogs: string[] = [];

function log(message: string): void {
	console.log(`[ui] ${message}`);
}

export function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

export async function control<T>(method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
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

export async function command(id: string, args: unknown[] = [], wait = true): Promise<void> {
	const result = await control<{ ok: boolean; error?: string }>('POST', '/command', { command: id, args, wait });
	if (!result.ok) {
		throw new Error(`${id} failed: ${result.error}`);
	}
}

export async function waitForControl(timeoutMs: number): Promise<unknown> {
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

export async function visibleText(page: Page, selector: string): Promise<string> {
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
 * exist in the DOM), read while scrolling the list (from its top) that holds the first row containing
 * `anchor` (default: the first row); scrolls back to the top afterwards.
 */
export async function listTextScrolled(page: Page, container: string, anchor?: string, maxSteps = 40): Promise<string> {
	const rows = page.locator(`${container} .monaco-list-row`);
	const anchorRow = anchor ? rows.filter({ hasText: anchor }).first() : rows.first();
	if (!await anchorRow.count()) {
		return '';
	}
	// One entry per row (its lines joined), so that the parts of a row stay together.
	const seen = new Set<string>();
	const list = scrollableOf(anchorRow);
	try {
		await wheelList(list, -1_000_000);
		let unchanged = 0;
		for (let i = 0; i < maxSteps && unchanged < 2; i++) {
			const before = seen.size;
			const n = await rows.count();
			for (let r = 0; r < n; r++) {
				const row = rows.nth(r);
				if (await row.isVisible()) {
					seen.add((await row.innerText()).replace(/\u00a0/g, ' ').replace(/\s*\n\s*/g, ' '));
				}
			}
			unchanged = seen.size === before ? unchanged + 1 : 0;
			await wheelList(list, 200);
		}
		await wheelList(list, -1_000_000);
	} catch {
		// a list that cannot be scrolled: what was read so far
	}
	return [...seen].join('\n');
}

/** The scrollable element of the monaco list that contains `row`. */
function scrollableOf(row: Locator): Locator {
	return row.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " monaco-scrollable-element ")][1]');
}

/**
 * Scrolls a monaco list by `deltaY` pixels with a wheel event dispatched on its scrollable
 * element: the mouse wheel of Playwright scrolls whatever is under the pointer, and Chromium
 * splits a large delta, so neither reliably reaches the list (seen in run dbg-1: 01 never got past
 * the first rows, and 05b found everything-legacy out of view).
 */
async function wheelList(list: Locator, deltaY: number): Promise<void> {
	await list.evaluate((el, dy) => {
		// Runs in the page (the runner's tsconfig has no DOM types).
		const wheel = (globalThis as unknown as { WheelEvent: new (type: string, init: object) => unknown }).WheelEvent;
		(el as unknown as { dispatchEvent(event: unknown): boolean }).dispatchEvent(new wheel('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true }));
	}, deltaY);
	await sleep(250);
}

/** Whether `row` lies inside the visible box of `list`. */
async function inView(row: Locator, list: Locator): Promise<boolean> {
	const [r, l] = await Promise.all([row.boundingBox(), list.boundingBox()]);
	return !!r && !!l && r.y >= l.y - 1 && r.y + r.height <= l.y + l.height + 1;
}

/** The row in `container` that contains `text`, scrolled into view (the lists are virtualized). */
async function rowWithText(page: Page, container: string, text: string, maxSteps = 40): Promise<Locator> {
	const rows = page.locator(`${container} .monaco-list-row`);
	const row = rows.filter({ hasText: text }).first();
	if (!await rows.count()) {
		return row;
	}
	const list = scrollableOf(rows.first());
	await wheelList(list, -1_000_000);
	for (let i = 0; i < maxSteps && !(await row.count() && await inView(row, list)); i++) {
		await wheelList(list, await row.count() ? 40 : 200);
	}
	return row;
}

/** Records and dismisses a modal dialog (none is expected outside the scenarios). */
export async function dismissDialogs(page: Page): Promise<void> {
	const dialog = page.locator('.monaco-dialog-box');
	for (let i = 0; i < 3 && await dialog.isVisible(); i++) {
		const text = await dialog.innerText();
		unexpectedDialogs.push(text.slice(0, 300));
		log(`dismissing an unexpected dialog: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
		await page.keyboard.press('Escape');
		await sleep(500);
	}
}

export async function shot(page: Page, file: string, title: string, expect: string, checks: Record<string, boolean>, note?: string): Promise<void> {
	const target = path.join(env.screenshots, file);
	await page.screenshot({ path: target });
	const ok = Object.values(checks).every(Boolean);
	screenshots.push({ file, title, expect, ok, checks, note });
	log(`screenshot ${file}: ${ok ? 'checks ok' : `checks FAILED ${JSON.stringify(checks)}`}${note ? ` (${note})` : ''}`);
}

export async function closeTransientUi(page: Page): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press('Escape');
		await sleep(150);
	}
}

/** Clears notifications so that the next screenshot shows only what it is about. */
export async function clearNotifications(): Promise<void> {
	await command('notifications.clearAll').catch(() => undefined);
}

/** Polls `probe` until it returns a truthy value (returned) or `timeoutMs` passed (`undefined`). */
export async function waitUntil<T>(timeoutMs: number, probe: () => T | undefined | false | Promise<T | undefined | false>, stepMs = 250): Promise<T | undefined> {
	for (const deadline = Date.now() + timeoutMs; ;) {
		const value = await probe();
		if (value) {
			return value;
		}
		if (Date.now() >= deadline) {
			return undefined;
		}
		await sleep(stepMs);
	}
}

// --- What the screenshot sections read from the run's own files ------------------------------------

/** The definition id of a server of the user-level mcp.json (extension/src/config.ts userConfigDefinitionId). */
export function userDefinitionId(label: string): string {
	return `mcp.config.usrlocal.${label}`;
}

/** The user-level mcp.json with the servers of the run (runner/prepare-profile.ts). The driver never saves it. */
function userMcpJson(): string {
	return path.join(env.userData, 'User', 'mcp.json');
}

/** One JSON-RPC message of an MCP server log, by its line in the log. */
interface ILoggedMessage {
	readonly line: number;
	/** `[editor -> server]` (true) or `[server -> editor]`. */
	readonly sent: boolean;
	readonly message: {
		readonly id?: unknown;
		readonly method?: string;
		readonly params?: Record<string, unknown>;
		readonly result?: Record<string, unknown>;
		readonly error?: { readonly code?: number; readonly message?: string };
	};
}

/** The MCP log of a server of this window (`<logs>/<session>/window1/mcpServer.<definition id>.log`), '' before it exists. */
export function serverLog(label: string): string {
	const logs = path.join(env.userData, 'logs');
	const name = `mcpServer.${userDefinitionId(label)}.log`;
	let files: string[] = [];
	try {
		files = fs.readdirSync(logs, { recursive: true, encoding: 'utf8' }).filter(f => path.basename(f) === name);
	} catch {
		// no logs yet
	}
	return files.map(f => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n');
}

/** The JSON-RPC messages of an MCP log (`--log debug` writes every one on its own line). */
function loggedMessages(logText: string): ILoggedMessage[] {
	const out: ILoggedMessage[] = [];
	logText.split('\n').forEach((line, index) => {
		const match = /\[(editor -> server|server -> editor)\] (\{.*\})\s*$/.exec(line);
		if (match) {
			try {
				out.push({ line: index, sent: match[1] === 'editor -> server', message: JSON.parse(match[2]) });
			} catch {
				// not one complete message
			}
		}
	});
	return out;
}

/** The number of complete lines of a server's MCP log: the index of the next line it writes. */
function serverLogLines(label: string): number {
	return Math.max(0, serverLog(label).split('\n').length - 1);
}

/** The answer to the first `resources/read` of `uri` that VS Code sent to the server from line `from` on. */
function resourceReadAnswer(label: string, from: number, uri: string): ILoggedMessage | undefined {
	const messages = loggedMessages(serverLog(label)).filter(m => m.line >= from);
	const request = messages.find(m => m.sent && m.message.method === 'resources/read' && m.message.params?.uri === uri);
	return request && messages.find(m => !m.sent && m.line > request.line && m.message.id === request.message.id && !m.message.method);
}

/** The `url` of the last URL-mode `elicitation/create` that the server asked for in an `input_required` answer. */
function lastElicitationUrl(label: string): string | undefined {
	for (const m of loggedMessages(serverLog(label)).reverse()) {
		const requests = m.sent ? undefined : m.message.result?.inputRequests;
		for (const request of Object.values(typeof requests === 'object' && requests !== null ? requests as Record<string, { method?: string; params?: { mode?: string; url?: unknown } }> : {})) {
			if (request?.method === 'elicitation/create' && request.params?.mode === 'url' && typeof request.params.url === 'string') {
				return request.params.url;
			}
		}
	}
	return undefined;
}

/** The host of a URL, or '' when it does not parse. */
function hostOf(url: string | undefined): string {
	try {
		return url ? new URL(url).host : '';
	} catch {
		return '';
	}
}

// --- Chat: requests to the E2E extension's `@e2e` participant (extension/src/chatParticipant.ts) ----

/** What the participant recorded for a request (IChatRequestRecord, one line of chat-requests.jsonl). */
interface IChatRecord {
	readonly command: string;
	readonly server?: string;
	readonly model: string;
	readonly hasToolInvocationToken: boolean;
	readonly calls: readonly { readonly tool: string; readonly resultText: string; readonly error?: string }[];
	readonly error?: string;
}

function chatRecords(): IChatRecord[] {
	try {
		return fs.readFileSync(path.join(env.results, 'chat-requests.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as IChatRecord);
	} catch {
		return [];
	}
}

/** The chat view (the secondary side bar). */
const CHAT = '.part.auxiliarybar';

/**
 * Puts `query` into a new chat (Ask mode, the llama.cpp model of the E2E extension) and submits it,
 * as extension/src/testsChat.ts does: `chat.open` only fills the input, because submitting through
 * it waits for a default chat agent, which only a signed-in Copilot registers. Answers at once (the
 * request may wait for input in the chat); returns the number of participant records before it.
 */
async function sendChat(query: string): Promise<number> {
	const before = chatRecords().length;
	await command('workbench.action.chat.newChat');
	await command('workbench.action.chat.open', [{ query, isPartialQuery: true, mode: 'ask', modelSelector: { vendor: 'llamacpp', id: 'qwen3-8b' } }]);
	await sleep(500);
	await command('workbench.action.chat.submit', [], false);
	return before;
}

/** The participant's record of the request sent after `before` records, once it finished. */
function chatRecordAfter(before: number, timeoutMs: number): Promise<IChatRecord | undefined> {
	return waitUntil(timeoutMs, () => chatRecords()[before]);
}

/** The text of the tool invocation parts of the chat view. */
async function toolInvocationText(page: Page): Promise<string> {
	return visibleText(page, `${CHAT} .chat-tool-invocation-part`);
}

/** Expands the "Completed <n> steps" disclosure of a finished response, so that its tool invocation shows. */
async function expandCompletedSteps(page: Page): Promise<void> {
	const disclosure = page.locator(CHAT).getByText(/^Completed \d+ steps?\b/).first();
	if (await disclosure.isVisible().catch(() => false)) {
		await disclosure.click({ timeout: 5000 }).catch(() => undefined);
		await sleep(1000);
	}
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
	/** What the driver chose for each notification: its button, or `More Actions... > <item>`. */
	notificationActions: string[];
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
	/** Taken at the first form step whose title matches `step`. */
	readonly onStep?: IScenarioShot & { readonly step: RegExp };
	readonly onNotification?: IScenarioShot;
	/** Taken when the first dialog that {@link IScenarioHooks.dialogButton} answers shows. */
	readonly onDialog?: IScenarioShot;
	/** The answers of this scenario (default {@link ANSWERS}). */
	readonly answers?: Answers;
	/** The button to click in a modal dialog of the scenario, by the dialog's text; other dialogs are dismissed. */
	readonly dialogButton?: (text: string) => string | undefined;
	/**
	 * Instead of the notification's button, run this action of its "More Actions..." menu (where a
	 * notification keeps its secondary actions, such as the Cancel of a URL elicitation).
	 */
	readonly notificationMenuItem?: string;
	/** A check of the UI trace once the scenario passed: the reason it fails, or `undefined`. */
	readonly checkTrace?: (trace: IElicitationTrace) => string | undefined;
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function answerUi(page: Page, label: string, done: () => boolean, hooks: IScenarioHooks): Promise<IElicitationTrace> {
	const answers = hooks.answers ?? ANSWERS;
	const trace: IElicitationTrace = { notifications: [], notificationActions: [], dialogs: [], answeredDialogs: [], steps: [], stalls: [] };
	let lastAction = Date.now();
	let stalls = 0;
	let formShot = false;
	let stepShot = false;
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
		const respondLabel = /^(Respond|Accept|Open URL|Continue)$/;
		const respond = page.locator('.notification-toast .monaco-button', { hasText: respondLabel });
		if (await respond.count() && await respond.first().isVisible()) {
			const message = await visibleText(page, '.notification-toast .notification-list-item-message');
			trace.notifications.push(message);
			if (!notificationShot && hooks.onNotification) {
				notificationShot = true;
				await hooks.onNotification.take();
			}
			const item = hooks.notificationMenuItem;
			if (item !== undefined) {
				// The toast's toolbar (with the gear of More Actions...) only shows while the pointer is on it.
				const toast = page.locator('.notification-toast', { has: page.locator('.monaco-button', { hasText: respondLabel }) }).first();
				try {
					await toast.hover({ timeout: 5000 });
					await toast.locator('.codicon-notifications-configure').first().click({ timeout: 5000 });
					await page.locator('.context-view .monaco-menu .action-item', { hasText: new RegExp(`^\\s*${escapeRegExp(item)}\\s*$`) }).first().click({ timeout: 5000 });
					trace.notificationActions.push(`More Actions... > ${item}`);
				} catch (e) {
					trace.stalls.push({ notificationMenuItem: item, error: String(e).slice(0, 300) });
					await page.keyboard.press('Escape');
				}
			} else {
				trace.notificationActions.push((await respond.first().innerText()).trim());
				await respond.first().click();
			}
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
			if (!stepShot && hooks.onStep?.step.test(title)) {
				stepShot = true;
				await hooks.onStep.take();
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
	for (const hook of [hooks.onNotification, hooks.onFirstForm, hooks.onStep, hooks.onDialog]) {
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

export async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
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

/** Whether MCP_E2E_ONLY selects the screenshot section `name` (`screenshots` selects every section, `shot:<name>` one). */
function wantsSection(name: string): boolean {
	return !env.only.length || env.only.includes('screenshots') || env.only.includes(`shot:${name}`);
}

/** Runs one screenshot section; a failure is recorded and does not stop the other sections. */
async function section(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
	if (!wantsSection(name)) {
		return;
	}
	try {
		await dismissDialogs(page);
		// A leftover toast (such as "It is not recommended to run Code - OSS as root user") would cover the screenshot.
		await clearNotifications();
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
		// A row reads "<label><State> <source>" ("zig-stdioRunning", "zig-grpc-apiRunning E2E gRPC
		// provider"): the label is followed by the capitalized state, never by a character of a
		// longer label ("zig-grpcs" must not match "zig-grpcs-sni").
		const rowOf = (label: string) => rows.find(r => new RegExp(`^${escapeRegExp(label)}(?![-a-z0-9_.])`).test(r.trim()));
		const checks: Record<string, boolean> = {};
		for (const server of configuredServers()) {
			const row = rowOf(server.label);
			const running = !!row && /^Running\b/.test(row.trim().slice(server.label.length));
			checks[server.startsWithOthers ? `${server.label} Running` : `${server.label} not running`] = !!row && running === server.startsWithOthers;
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
			'The expanded everything-legacy lists its tools with their descriptions, labelled by title next to the reference name ("Echo Tool echo", "Get Sum Tool get-sum", ...).',
			{ 'tools of everything-legacy listed by title and reference name': /Echo Tool\s*echo/.test(tools) && /Get Sum Tool\s*get-sum/.test(tools) }, tools.slice(0, 600));
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

	await section(page, 'cached era hint', async () => {
		// MCP: Restart Server of the legacy stdio server: the cached era hint makes VS Code send
		// initialize at once, without the server/discover probe of the first start.
		const label = 'everything-legacy';
		const from = serverLogLines(label);
		await command('workbench.mcp.restartServer', [userDefinitionId(label)]);
		const negotiated = await waitUntil(30_000, () => serverLog(label).split('\n').slice(from).some(l => /Negotiated MCP 2025-11-25/.test(l)), 500);
		const sent = loggedMessages(serverLog(label)).filter(m => m.line >= from && m.sent).map(m => m.message.method);
		await command('workbench.mcp.showOutput', [userDefinitionId(label)]);
		await sleep(2000);
		const filter = page.locator('.part.panel input[placeholder^="Filter"]').first();
		await filter.fill(`${OUTPUT_FILTER},Connection state`, { timeout: 5000 }).catch(() => undefined);
		await sleep(1500);
		await command('workbench.action.toggleMaximizedPanel').catch(() => undefined);
		await sleep(1500);
		const text = await visibleText(page, '.part.panel');
		await shot(page, '07b-output-legacy-restart.png', `MCP output channel of ${label} after a restart`,
			`The output of "MCP: ${label}" (filtered to the negotiation and the connection state) after MCP: Restart Server: the first start probed with server/discover before initialize; after the restart (Stopped, Starting, Running) VS Code sends initialize at once (the cached era hint) and negotiates 2025-11-25 again.`,
			{
				'negotiated again after the restart': !!negotiated,
				'initialize without a server/discover probe after the restart': sent.includes('initialize') && !sent.includes('server/discover'),
			}, `${sent.join(', ')}\n---\n${text.slice(0, 400)}`);
		await filter.fill('').catch(() => undefined);
		await command('workbench.action.toggleMaximizedPanel').catch(() => undefined);
	});
	await command('workbench.action.closePanel').catch(() => undefined);

	await section(page, 'mcp.json completions', async () => {
		// The workspace mcp.json (run-suite.sh writes it without servers), then the user-level mcp.json
		// (the one with the servers of the run); the edits below are never saved. Both files have the
		// MCP schema (extensions/configuration-editing associates .vscode/mcp.json and
		// %APP_SETTINGS_HOME%/mcp.json), so both offer "grpc".
		const newServer = (properties: string) => `{\n\t"servers": {\n\t\t"e2e-new": {\n${properties}\n\t\t}\n\t}\n}\n`;
		const typeText = newServer('\t\t\t"url": "grpc://127.0.0.1:50051",\n\t\t\t"type": "$CURSOR$"');
		const workspaceMcpJson = path.join(env.workspace, '.vscode', 'mcp.json');
		/** Replaces the text of the open mcp.json and opens the completion list at the cursor until it offers one of `words`. */
		const suggestShot = async (file: string, title: string, text: string, expect: string, words: readonly string[], offers: (suggest: string, word: string) => boolean = (s, w) => s.includes(w)) => {
			await control('POST', '/editor', { text });
			await command('workbench.action.focusActiveEditorGroup').catch(() => undefined);
			// The JSON language server may still be starting: trigger the suggestions until they show.
			let suggest = '';
			for (let attempt = 0; attempt < 5 && !words.some(w => offers(suggest, w)); attempt++) {
				await sleep(1500);
				await command('editor.action.triggerSuggest').catch(() => undefined);
				await sleep(2000);
				suggest = await visibleText(page, '.suggest-widget');
			}
			await shot(page, file, title, expect, Object.fromEntries(words.map(w => [`suggests ${w}`, offers(suggest, w)])), suggest.slice(0, 300));
			await page.keyboard.press('Escape');
		};
		await control('POST', '/open', { path: workspaceMcpJson });
		await sleep(1500);
		await suggestShot('08-mcp-json-type-completion.png', 'mcp.json completion of "type"', typeText, 'mcp.json: a new server with a grpc:// url and the completion list of "type" open, offering "grpc".', ['grpc']);
		await suggestShot('09-mcp-json-binding-completion.png', 'mcp.json completion of "binding"', newServer('\t\t\t"type": "grpc",\n\t\t\t"url": "grpc://127.0.0.1:50051",\n\t\t\t"binding": "$CURSOR$"'), 'mcp.json: a grpc server with the completion list of "binding" open: "auto" (marked Default value), "tunnel" and "typed".', ['auto', 'tunnel', 'typed']);

		// A grpc server with an http:// url: the schema's pattern marks the url, and the hover over it says why.
		const rule = 'The URL must start with \'grpc://\' or \'grpcs://\'.';
		await control('POST', '/editor', { text: newServer('\t\t\t"type": "grpc",\n\t\t\t"url": "http://127.0.$CURSOR$0.1:50051"') });
		await command('workbench.action.focusActiveEditorGroup').catch(() => undefined);
		let hover = '';
		for (let attempt = 0; attempt < 6 && !hover.includes(rule); attempt++) {
			await sleep(1500);
			await command('editor.action.showHover').catch(() => undefined);
			await sleep(1500);
			hover = await visibleText(page, '.monaco-hover');
		}
		// JSON schema problems are warnings: a warning squiggle under the url and one warning in the status bar.
		const squiggles = await page.locator('.part.editor .squiggly-warning, .part.editor .squiggly-error').count();
		const problems = await visibleText(page, '.statusbar #status\\.problems');
		await shot(page, '16-mcp-json-grpc-url-problem.png', 'mcp.json: an http:// url for a grpc server',
			'mcp.json: a grpc server whose url is http://127.0.0.1:50051. The url has a problem squiggle (a schema warning, counted in the status bar) and its hover says "The URL must start with \'grpc://\' or \'grpcs://\'." (the pattern of the grpc server schema) above the url\'s description.',
			{ 'hover names the grpc:// rule': hover.includes(rule), 'problem squiggle under the url': squiggles > 0 }, `${squiggles} squiggle(s); status bar: ${problems.replace(/\s+/g, ' ')}; hover: ${hover}`.slice(0, 400));
		await page.keyboard.press('Escape');

		// Inside "tls": the properties of the TLS settings.
		await suggestShot('17-mcp-json-tls-completion.png', 'mcp.json completion inside "tls"', newServer('\t\t\t"type": "grpc",\n\t\t\t"url": "grpcs://localhost:50056",\n\t\t\t"tls": { $CURSOR$ }'),
			'mcp.json: a grpcs:// server with the completion list open inside "tls": { }, offering ca, insecure and serverName.',
			['ca', 'insecure', 'serverName'], (s, w) => new RegExp(`^${w}\\b`, 'm').test(s));

		// Close the workspace file unchanged, then the same edit in the user-level one.
		await command('workbench.action.revertAndCloseActiveEditor').catch(() => undefined);
		await control('POST', '/open', { path: userMcpJson() });
		await sleep(1500);
		await suggestShot('08b-user-mcp-json-type-completion.png', 'user-level mcp.json completion of "type"', typeText, 'The user-level mcp.json: the same new server, the completion list of "type" open, offering "grpc" (the schema is associated with the user-level file too).', ['grpc']);
		await command('workbench.action.revertAndCloseActiveEditor').catch(() => undefined);
	});

	await section(page, 'code lens', async () => {
		// The user-level mcp.json as saved (MCP: Open User Configuration, not edited; the code lenses
		// belong to the file as the MCP registry knows it, its vscode-userdata: URI, so a file: editor of
		// the same path has none). The view starts at zig-grpc-auto-typed, which the suite never starts
		// ("Start"), above zig-grpcs (Running: "Stop", "Restart" and its tool count). Then zig-grpcs
		// restarts and must list the same tools, none twice.
		const restarted = 'zig-grpcs';
		const lines = fs.readFileSync(userMcpJson(), 'utf8').split('\n');
		await command('workbench.mcp.openUserMcpJson', [{ legacy: true }]);
		await sleep(2500);
		await command('workbench.action.focusActiveEditorGroup').catch(() => undefined);
		// revealLine counts from 0; one line above the server's key so that its lens is in view.
		await command('revealLine', [{ lineNumber: Math.max(0, lines.findIndex(l => l.includes('"zig-grpc-auto-typed"')) - 1), at: 'top' }]);
		await sleep(2500);
		/** The code lens right above the line of `"<label>":` (a lens is drawn in a view zone above its line). */
		const lensAbove = async (label: string): Promise<string> => {
			const lineBox = await page.locator('.part.editor .view-line', { hasText: `"${label}"` }).first().boundingBox();
			const lenses = page.locator('.part.editor .codelens-decoration');
			let best: { text: string; distance: number } | undefined;
			for (let i = 0; lineBox && i < await lenses.count(); i++) {
				const box = await lenses.nth(i).boundingBox();
				if (box && box.y < lineBox.y && (!best || lineBox.y - box.y < best.distance)) {
					best = { text: (await lenses.nth(i).innerText()).replace(/ /g, ' ').replace(/\s+/g, ' ').trim(), distance: lineBox.y - box.y };
				}
			}
			return best?.text ?? '';
		};
		const toolCount = (lens: string) => /(\d+) tools?\b/.exec(lens)?.[1];
		const toolIds = () => control<string[]>('GET', `/tools?server=${encodeURIComponent(restarted)}`);
		const stopped = await lensAbove('zig-grpc-auto-typed');
		const running = await lensAbove(restarted);
		const idsBefore = await toolIds();
		await shot(page, '18-mcp-json-code-lens.png', 'mcp.json code lens of gRPC servers',
			'The user-level mcp.json: the code lens above zig-grpc-auto-typed (never started) offers Start; above zig-grpcs (running) it shows Running, Stop, Restart and the tool count.',
			{
				'Start above a stopped grpc server': /\bStart\b/.test(stopped),
				'Running, Stop and Restart above a running grpc server': /\bRunning\b/.test(running) && /\bStop\b/.test(running) && /\bRestart\b/.test(running),
				'tool count shown': !!toolCount(running),
			}, `zig-grpc-auto-typed: ${stopped}\n${restarted}: ${running}\nvscode.lm.tools: ${idsBefore.length}`);

		// Everything after the restart is read from the log from here on, so that the state from before
		// the restart (the old lens, the cached tools) cannot satisfy it.
		const from = serverLogLines(restarted);
		await command('workbench.mcp.restartServer', [userDefinitionId(restarted)]);
		const logSinceRestart = () => serverLog(restarted).split('\n').slice(from);
		// The restart in the log: Stopped, then Running, then "Discovered <n> tools", the answer to the
		// restarted connection's own tools/list.
		const discovered = await waitUntil(30_000, () => {
			const lines = logSinceRestart();
			const stopped = lines.findIndex(l => /Connection state: Stopped/.test(l));
			const runningAt = stopped === -1 ? -1 : lines.findIndex((l, i) => i > stopped && /Connection state: Running/.test(l));
			return runningAt === -1 ? undefined : lines.slice(runningAt + 1).find(l => /Discovered \d+ tools/.test(l))?.replace(/^.*(Discovered \d+ tools).*$/, '$1');
		}, 250);
		// "Discovered" is logged before VS Code validates the list and before the list reaches the
		// extension host: poll the tool ids until three reads 500 ms apart agree.
		const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
		const reads: string[][] = [];
		const stableIds = discovered ? await waitUntil(15_000, async () => {
			reads.push(await toolIds());
			const last = reads.slice(-3);
			return last.length === 3 && last[0].length > 0 && last.every(ids => sameIds(ids, last[0])) ? last[0] : undefined;
		}, 500) : undefined;
		const idsAfter = stableIds ?? reads.at(-1) ?? await toolIds();
		// The lens: well past the code lens debounce by now; wait until it shows the restarted server
		// Running with the count of the tools VS Code now has.
		const after = await waitUntil(10_000, async () => {
			const lens = await lensAbove(restarted);
			return /\bRunning\b/.test(lens) && toolCount(lens) === String(idsAfter.length) ? lens : undefined;
		}, 500) ?? await lensAbove(restarted);
		const restartLines = logSinceRestart().filter(l => /Connection state: (Stopped|Running)/.test(l)).map(l => l.replace(/^.*Connection state: /, '').trim());
		await shot(page, '18b-mcp-json-code-lens-after-restart.png', 'mcp.json code lens after a restart',
			`The same view after MCP: Restart Server of ${restarted}: Running again with the same tool count; VS Code lists the same tools as before, none twice.`,
			{
				'the server restarted (Stopped, then Running in its log after the restart command)': restartLines.includes('Stopped') && restartLines.lastIndexOf('Running') > restartLines.indexOf('Stopped'),
				'the restarted connection listed its tools (Discovered after Running)': !!discovered,
				'Running again': /\bRunning\b/.test(after),
				'same tool count in the code lens': !!toolCount(after) && toolCount(after) === toolCount(running),
				'same tools in vscode.lm.tools, none twice': idsAfter.length === idsBefore.length && new Set(idsAfter).size === idsAfter.length && idsBefore.every(id => idsAfter.includes(id)),
			}, `before: ${running} (${idsBefore.length} tools)\nafter: ${after} (${idsAfter.length} tools, ${reads.length} reads after "${discovered ?? 'no Discovered line'}")\nstates since the restart: ${restartLines.join(', ')}`);
		await command('workbench.action.closeActiveEditor').catch(() => undefined);
		await command('workbench.action.closePanel').catch(() => undefined);
	});

	await section(page, 'add server', async () => {
		// Nothing is added: the flow stops at the destination picker. Both mcp.json files must be unchanged.
		const workspaceMcpJson = path.join(env.workspace, '.vscode', 'mcp.json');
		const unchanged = [userMcpJson(), workspaceMcpJson].map(f => [f, fs.readFileSync(f, 'utf8')] as const);
		await command('workbench.action.closePanel').catch(() => undefined);
		await command('workbench.mcp.addConfiguration', [], false);
		await sleep(2500);
		const text = await visibleText(page, '.quick-input-widget');
		await shot(page, '10-add-server-quickpick.png', 'MCP: Add Server', 'The MCP: Add Server quick pick lists the server types, including a gRPC entry.', { 'gRPC entry': /grpc/i.test(text) }, text.slice(0, 400));

		// gRPC: the URL step refuses an http:// URL.
		const input = page.locator('.quick-input-widget .quick-input-box input');
		await input.fill('gRPC');
		await sleep(500);
		await page.keyboard.press('Enter');
		await sleep(1500);
		await input.fill('http://127.0.0.1:50051');
		await sleep(1500);
		const urlStep = await visibleText(page, '.quick-input-widget');
		const urlAria = await input.getAttribute('aria-label') ?? '';
		await shot(page, '19-add-server-grpc-url.png', 'MCP: Add Server, the gRPC URL',
			'After choosing gRPC: the step "Enter gRPC Server URL" with an http:// URL typed in, refused with "The URL must start with \'grpc://\' or \'grpcs://\'."; the input has an accessible label.',
			{
				'gRPC URL step': /Enter gRPC Server URL|URL of the gRPC MCP server/.test(urlStep),
				'http:// refused': urlStep.includes('The URL must start with \'grpc://\' or \'grpcs://\'.'),
				'input labelled for screen readers': urlAria.trim().length > 0,
			}, `aria-label: ${urlAria}\n${urlStep}`.slice(0, 500));

		// A grpcs:// URL, the suggested server id, then the destination.
		await input.fill('grpcs://localhost:50056');
		await sleep(500);
		await page.keyboard.press('Enter');
		await sleep(1500);
		const idStep = await visibleText(page, '.quick-input-widget');
		await page.keyboard.press('Enter');
		const destination = await waitUntil(10_000, async () => {
			const text = await visibleText(page, '.quick-input-widget');
			return /^Global/m.test(text) ? text : undefined;
		}, 500) ?? await visibleText(page, '.quick-input-widget');
		await shot(page, '19b-add-server-destination.png', 'MCP: Add Server, the destination',
			'After the URL and the server id: the destination picker "Select the configuration target" offers Global and Workspace. The driver cancels there, so nothing is written.',
			{
				'server id asked first': /Enter Server ID|Unique identifier/.test(idStep),
				'Global offered': /^Global/m.test(destination),
				'Workspace offered': /^Workspace/m.test(destination),
				'no mcp.json changed': unchanged.every(([f, t]) => fs.readFileSync(f, 'utf8') === t),
			}, `${idStep.slice(0, 120)}\n---\n${destination}`.slice(0, 500));
		await page.keyboard.press('Escape');
	});

	await section(page, 'server detail', async () => {
		// The MCP server detail of Agent Customizations (Chat: Open Customizations, a modal editor) for a
		// gRPC server of the user mcp.json: the list of MCP servers, searched for the server, then its
		// detail. The detail offers the configuration form (browser/mcpServerConfigurationForm.ts, with
		// the gRPC fields and their accessible labels) only for servers of the files shared with other
		// clients (a workspace .mcp.json, Copilot's mcp-config.json), which cannot hold gRPC servers, so a
		// gRPC server shows its read-only definition and "Edit Configuration" (visual-verification.md).
		const label = 'zig-grpcs';
		await command('aiCustomization.openManagementEditor', ['mcpServers']);
		await sleep(3000);
		try {
			// Every section of the editor has its own search box; the MCP Servers one is the visible one.
			const search = page.getByPlaceholder('Type to search...').filter({ visible: true }).first();
			await search.fill(label, { timeout: 10_000 });
			await sleep(1500);
			// A row reads "<name><the file it is configured in>"; zig-grpcs-sni and the others do not match.
			const row = page.locator('.monaco-list-row', { hasText: new RegExp(`(^|\\s)${escapeRegExp(label)}\\s*/tmp/`) }).first();
			await row.click({ timeout: 10_000 });
			await sleep(2500);
			const definition = (await visibleText(page, '.monaco-editor .view-lines')).replace(/\s+/g, ' ');
			const edit = await page.locator('.monaco-button', { hasText: /^Edit Configuration$/ }).filter({ visible: true }).count();
			const labels = ['gRPC service binding', 'Path to the TLS certificate authority bundle', 'Host name checked against the TLS server certificate', 'Skip TLS server certificate verification'];
			const fields = (await Promise.all(labels.map(async l => await page.locator(`[aria-label="${l}"]`).filter({ visible: true }).count() > 0))).filter(Boolean).length;
			await shot(page, '19c-mcp-server-detail-grpc.png', 'Agent Customizations: the detail of a gRPC server',
				`Agent Customizations, MCP Servers, searched for ${label}: the detail of the server shows its definition from the user mcp.json (type grpc, the grpcs:// url, tls.ca) read-only, with "Edit Configuration" (which opens the file). No configuration form: the detail offers it only for the files shared with other clients, which cannot hold gRPC servers.`,
				{ [`the definition of ${label}`]: definition.includes(`"${label}"`) && definition.includes('"type": "grpc"') && definition.includes('grpcs://localhost:50056'), 'Edit Configuration offered': edit > 0 },
				`gRPC form fields shown: ${fields} of ${labels.length}\n${definition}`.slice(0, 500));
		} finally {
			await page.keyboard.press('Escape');
			await command('workbench.action.closeActiveEditor').catch(() => undefined);
			await sleep(500);
		}
	});

	await section(page, 'tls insecure', async () => {
		// The one-time warning of a server with tls.insecure (mainThreadMcp.ts _checkInsecureGrpc) in its output.
		const label = 'zig-grpcs-insecure';
		const warning = new RegExp(`TLS certificate verification is turned off for the MCP server '${escapeRegExp(label)}' \\(\`tls\\.insecure\`\\)`);
		await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
		await command('workbench.mcp.showOutput', [userDefinitionId(label)]);
		await sleep(2000);
		const filter = page.locator('.part.panel input[placeholder^="Filter"]').first();
		await filter.fill('tls.insecure', { timeout: 5000 }).catch(() => undefined);
		await sleep(1500);
		const text = await visibleText(page, '.part.panel');
		const logged = serverLog(label).split('\n').filter(l => warning.test(l));
		await shot(page, '20-output-tls-insecure.png', 'MCP output channel: the tls.insecure warning',
			`The output channel "MCP: ${label}" filtered to "tls.insecure": the warning "TLS certificate verification is turned off for the MCP server '${label}' (\`tls.insecure\`). Only use this for local development.", logged once.`,
			{ 'warning shown': warning.test(text), 'logged once': logged.length === 1, 'logged as a warning': logged.every(l => /\[warning\]/.test(l)) },
			`${logged.length} line(s) in the log\n${text}`.slice(0, 500));
		await filter.fill('').catch(() => undefined);
		await command('workbench.action.closePanel').catch(() => undefined);
	});

	await section(page, 'policy', async () => {
		// chat.mcp.deniedServers (the setting behind the ChatDeniedMcpServers policy) with the URL of a
		// running gRPC server: VS Code stops it and shows it in the Error state. The settings are restored.
		const label = 'zig-grpc-soak';
		const settingsFile = path.join(env.userData, 'User', 'settings.json');
		const original = fs.readFileSync(settingsFile, 'utf8');
		const setSettings = async (text: string) => {
			await control('POST', '/open', { path: settingsFile });
			await sleep(1000);
			await control('POST', '/editor', { text });
			await command('workbench.action.files.save');
			await sleep(500);
			await command('workbench.action.closeActiveEditor').catch(() => undefined);
		};
		const denied = { ...JSON.parse(original) as Record<string, unknown>, 'chat.mcp.deniedServers': [{ serverUrl: 'grpc://127.0.0.1:50055*' }] };
		await setSettings(`${JSON.stringify(denied, undefined, '\t')}\n`);
		try {
			const rowOf = (rows: string[]) => rows.find(r => new RegExp(`^${escapeRegExp(label)}(?![-a-z0-9_.])`).test(r.trim()));
			const listRows = async () => (await listTextScrolled(page, '.quick-input-widget')).split('\n');
			await command('workbench.mcp.listServer', [], false);
			await sleep(1500);
			await page.locator('.quick-input-widget .quick-input-box input').fill('zig-grpc');
			// The deny list applies when the configuration changes; the row follows the state.
			const rows = await waitUntil(15_000, async () => {
				const r = await listRows();
				return /^Error\b/.test(rowOf(r)?.trim().slice(label.length) ?? '') ? r : undefined;
			}, 1000) ?? await listRows();
			const row = rowOf(rows)?.trim() ?? '';
			await shot(page, '21-policy-denied-grpc.png', 'MCP: List Servers with a denied gRPC server',
				`MCP: List Servers (filtered to "zig-grpc") after chat.mcp.deniedServers is set to [{ "serverUrl": "grpc://127.0.0.1:50055*" }]: ${label} is in the Error state with the policy message "This Model Context Protocol server is blocked by your organization's policy. ..."; the other gRPC servers still run.`,
				{
					[`${label} in the Error state`]: /^Error\b/.test(row.slice(label.length)),
					'the policy message': /blocked by your organization's policy/.test(row),
					'the other gRPC servers still Running': rows.some(r => /^zig-grpc-tunnel\s*Running/.test(r.trim())),
				}, rows.join('\n').slice(0, 800));
			await page.keyboard.press('Escape');
		} finally {
			await setSettings(original);
		}
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

/**
 * The Accounts menu right after the OAuth scenario of zig-oauth: its account, then Sign Out (with the
 * confirmation), after which the account is gone and VS Code stops the server. Runs before the other
 * OAuth scenarios, whose accounts would carry the same label (the fixture's resource name).
 */
async function accountsPart(page: Page): Promise<void> {
	await section(page, 'accounts', async () => {
		const account = 'MCP (MCP E2E OAuth fixture)';
		const openAccounts = async () => {
			await page.locator('.part.activitybar .codicon-accounts-view-bar-icon').first().click({ timeout: 10_000 });
			await sleep(1500);
		};
		const menuText = () => visibleText(page, '.context-view .monaco-menu');
		await openAccounts();
		const menu = await menuText();
		await page.locator('.context-view .monaco-menu .action-item', { hasText: account }).first().hover({ timeout: 5000 });
		await sleep(1500);
		const submenu = await menuText();
		await shot(page, '25-accounts-signed-in.png', 'Accounts menu after the MCP OAuth sign-in',
			`The Accounts menu after the sign-in of zig-oauth: the account "${account}" (the account label of a token without an ID token, the resource name of the protected resource) with its submenu: Manage Trusted MCP Servers, Manage Dynamic Authentication Providers..., Sign Out.`,
			{ 'account of the sign-in listed': menu.includes(account), 'Sign Out offered': /\bSign Out\b/.test(submenu), 'Manage Trusted MCP Servers offered': submenu.includes('Manage Trusted MCP Servers') }, submenu.slice(0, 500));
		const from = serverLogLines('zig-oauth');
		await page.locator('.context-view .monaco-menu .action-item', { hasText: /^\s*Sign Out\s*$/ }).last().click({ timeout: 5000 });
		const dialog = page.locator('.monaco-dialog-box');
		await dialog.waitFor({ state: 'visible', timeout: 10_000 });
		const question = (await dialog.innerText()).replace(/\s+/g, ' ');
		await dialog.locator('.monaco-button', { hasText: /^Sign Out$/ }).first().click();
		// The session is gone: VS Code revalidates the servers that used it and stops zig-oauth.
		const stopped = await waitUntil(20_000, () => serverLog('zig-oauth').split('\n').slice(from).find(l => /Authentication session for .* removed, stopping server/.test(l)), 500);
		await openAccounts();
		const after = await menuText();
		await shot(page, '25b-accounts-signed-out.png', 'Accounts menu after Sign Out',
			`The Accounts menu after Sign Out of "${account}" (confirmed in the dialog): the account is gone, and VS Code stopped zig-oauth ("Authentication session for MCP E2E OAuth fixture removed, stopping server").`,
			{ 'the sign-out asked for confirmation': /Sign out/i.test(question), 'account gone': !after.includes(account), 'zig-oauth stopped': !!stopped }, `${question}\n---\n${after}\n---\n${stopped ?? ''}`.slice(0, 500));
		await page.keyboard.press('Escape');
	});
}

/**
 * The sections that call MCP tools from the chat view (the `@e2e` participant passes the request's
 * toolInvocationToken, so each call is a tool invocation of the request). After the OAuth scenarios:
 * a chat request autostarts the servers that never ran.
 */
async function chatPart(page: Page): Promise<void> {
	/** Opens the chat view maximized for `fn` and restores the layout afterwards. */
	const inChat = async (fn: () => Promise<void>) => {
		await command('workbench.action.chat.open');
		await command('workbench.action.maximizeAuxiliaryBar').catch(() => undefined);
		try {
			await fn();
		} finally {
			await command('workbench.action.restoreAuxiliaryBar').catch(() => undefined);
			await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
		}
	};

	await section(page, 'resources', async () => {
		// MCP: Browse Resources of zig-http, from its server options (the command without a server
		// lists the resources of every server and starts the ones that never ran, the OAuth ones too).
		const label = 'zig-http';
		const watched = 'test://watched-resource';
		await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
		await command('workbench.mcp.serverOptions', [userDefinitionId(label)], false);
		await sleep(2000);
		const options = await visibleText(page, '.quick-input-widget');
		await shot(page, '22-server-options.png', 'MCP server options (the actions of a server)',
			`The options of the running ${label} (the server's context actions, also behind its "More..." code lens and the List Servers entry): Stop Server, Restart Server, Show Configuration, Show Output, Configure Model Access, Browse Resources.`,
			Object.fromEntries(['Stop Server', 'Restart Server', 'Show Output', 'Browse Resources'].map(a => [`offers ${a}`, options.includes(a)])), options.slice(0, 400));
		const input = page.locator('.quick-input-widget .quick-input-box input');
		await input.fill('Browse Resources');
		await sleep(500);
		await page.keyboard.press('Enter');
		await sleep(2500);
		await input.fill('Watched');
		await sleep(1500);
		const picker = await visibleText(page, '.quick-input-widget');
		await shot(page, '22b-resources-browse.png', 'MCP: Browse Resources',
			`MCP: Browse Resources of ${label} (Server Options > Browse Resources), filtered to "Watched": "Watched Resource" with its URI ${watched}.`,
			{ 'the watched resource listed with its URI': picker.includes('Watched Resource') && picker.includes(watched) }, picker.slice(0, 400));
		const from = serverLogLines(label);
		await page.keyboard.press('Enter');
		await sleep(2500);
		// An editor of a resource outside the workspace is watched (editorService.ts), which subscribes
		// to it: a subscriptions/listen naming it, acknowledged by the server.
		const subscribed = await waitUntil(20_000, () => {
			const messages = loggedMessages(serverLog(label)).filter(m => m.line >= from);
			const listen = messages.find(m => m.sent && m.message.method === 'subscriptions/listen' && JSON.stringify(m.message.params?.notifications ?? {}).includes(watched));
			return listen && messages.some(m => !m.sent && m.line > listen.line && m.message.method === 'notifications/subscriptions/acknowledged') ? listen : undefined;
		}, 500);
		// The update, triggered from chat; then the server's notification and VS Code's read of the resource.
		const triggered = serverLogLines(label);
		const record = await chatRecordAfter(await sendChat(`@e2e /call ${label} test_trigger_resource_update {}`), 60_000);
		const reread = await waitUntil(20_000, () => {
			const messages = loggedMessages(serverLog(label)).filter(m => m.line >= triggered);
			const updated = messages.find(m => !m.sent && m.message.method === 'notifications/resources/updated' && m.message.params?.uri === watched);
			return updated && messages.find(m => m.sent && m.line > updated.line && m.message.method === 'resources/read' && m.message.params?.uri === watched);
		}, 500);
		await command('workbench.action.closeAuxiliaryBar').catch(() => undefined);
		await command('workbench.mcp.showOutput', [userDefinitionId(label)]);
		await sleep(2000);
		const filter = page.locator('.part.panel input[placeholder^="Filter"]').first();
		await filter.fill('watched-resource', { timeout: 5000 }).catch(() => undefined);
		await sleep(1500);
		const content = await visibleText(page, '.part.editor .view-lines');
		const output = await visibleText(page, '.part.panel');
		await shot(page, '22c-resource-updated.png', 'A watched MCP resource after resources/updated',
			`The editor of ${watched} (from Browse Resources) with the output of ${label} filtered to "watched-resource": the read, VS Code's subscriptions/listen naming the resource, the server's notifications/resources/updated after test_trigger_resource_update (called from chat), and VS Code reading the resource again for the open editor.`,
			{
				'the editor shows the resource': content.includes('watched'),
				'subscribed (an acknowledged subscriptions/listen naming the resource)': !!subscribed,
				'the trigger ran from chat': !!record?.calls.some(c => c.tool === 'test_trigger_resource_update' && c.resultText.includes('Resource updated')),
				'read again after notifications/resources/updated': !!reread,
				'the output shows the update': output.includes('notifications/resources/updated'),
			}, output.slice(0, 600));
		await filter.fill('').catch(() => undefined);
		await command('workbench.action.closePanel').catch(() => undefined);
		await command('workbench.action.closeActiveEditor').catch(() => undefined);
	});

	await section(page, 'missing resource', async () => {
		// A resource the servers do not have, opened like any mcp-resource URI. The server's -32602 is
		// FileNotFound over stdio, and over Streamable HTTP too, where it comes in the body of an HTTP 400.
		const missing = 'test://no-such-resource';
		const fileNotFound = 'The editor could not be opened because the file was not found.';
		for (const [label, file, transport] of [['zig-stdio', '22d-resource-not-found.png', 'stdio'], ['zig-http', '22e-resource-not-found-http.png', 'Streamable HTTP, the -32602 in the body of an HTTP 400']] as const) {
			const from = serverLogLines(label);
			const uri = { scheme: 'mcp-resource', authority: Buffer.from(userDefinitionId(label), 'utf8').toString('hex'), path: '/test/no-such-resource' };
			// _workbench.open: what vscode.open runs, with the URI's components (the control server passes JSON).
			await command('_workbench.open', [uri, [-1, { pinned: true }]]);
			await sleep(3000);
			const text = (await visibleText(page, '.part.editor')).replace(/\s+/g, ' ');
			const answer = resourceReadAnswer(label, from, missing);
			await shot(page, file, `A missing MCP resource (${label})`,
				`The editor of ${missing} on ${label} (${transport}): the server answers resources/read with -32602, and the editor says "${fileNotFound}"`,
				{ 'rendered as file not found': text.includes(fileNotFound), 'the server answered -32602': answer?.message.error?.code === -32602 },
				`${text.slice(0, 300)}\nanswer: ${JSON.stringify(answer?.message.error ?? answer?.message.result ?? null)}`.slice(0, 500));
			await command('workbench.action.closeActiveEditor').catch(() => undefined);
		}
	});

	await section(page, 'protocol errors', () => inChat(async () => {
		// Each request fails with a 2026-07-28 error that VS Code could not recover from: one
		// notification per kind and connection, in words, with "Show Output" and no raw JSON
		// (McpServer._notifyProtocolFailure); the chat shows the failed request.
		for (const [label, tool, file, title, expect, words] of [
			['zig-http-faults', 'test_audio_content', '23-notification-32021.png', 'Notification of -32021 (a missing client capability)',
				'@e2e /call zig-http-faults test_audio_content: the fault proxy answers -32021 for elicitation.url. The error notification names the server and the capability, with a Show Output button and no raw JSON.',
				['zig-http-faults', 'requires client capabilities', 'elicitation.url']],
			['zig-http-faults', 'test_image_content', '23b-notification-32022.png', 'Notification of -32022 (an unsupported protocol revision)',
				'@e2e /call zig-http-faults test_image_content: the fault proxy answers -32022 offering only 2026-07-28, the revision in use. The notification names the server, the rejected revision and the supported ones (data.supported), with Show Output and no raw JSON.',
				['zig-http-faults', 'rejected the MCP revision 2026-07-28', 'It supports 2026-07-28']],
			['zig-grpc-mismatch', 'test_simple_text', '23c-notification-32020-chat.png', 'Notification and chat error of -32020 over gRPC',
				'@e2e /call zig-grpc-mismatch test_simple_text: the proxy rewrites mcp-name, so both the call and its retry after the re-list end with -32020 in the gRPC trailers. The notification says the headers do not match even after the tool list was refreshed (Show Output, no raw JSON); the chat shows the tool call and the request\'s error.',
				['zig-grpc-mismatch', 'headers do not match', 'even after the tool list was refreshed']],
		] as const) {
			await clearNotifications();
			const record = await chatRecordAfter(await sendChat(`@e2e /call ${label} ${tool} {}`), 90_000);
			const toast = page.locator('.notification-toast', { hasText: label }).first();
			await toast.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
			// The toast slides in.
			await sleep(1500);
			const message = (await toast.locator('.notification-list-item-message').innerText().catch(() => '')).replace(/ /g, ' ');
			const buttons = (await toast.locator('.monaco-button').allInnerTexts().catch(() => [] as string[])).map(b => b.trim());
			const chat = await visibleText(page, CHAT);
			const checks: Record<string, boolean> = Object.fromEntries(words.map(w => [`message says "${w}"`, message.includes(w)]));
			checks['Show Output button'] = buttons.includes('Show Output');
			checks['no raw JSON in the message'] = !!message && !/[{}]|jsonrpc|"code"/.test(message);
			checks['the chat request failed'] = !!record?.error && !!record.calls[0]?.error;
			if (label === 'zig-grpc-mismatch') {
				checks['the tool call is in the chat'] = (await toolInvocationText(page)).includes(tool);
				checks['the chat shows the -32020 error'] = /-32020|header/i.test(chat);
			}
			await shot(page, file, title, expect, checks, `${message}\n[${buttons.join(', ')}]\n---\n${chat}`.slice(0, 700));
		}
	}));

	await section(page, 'chat mrtr', () => inChat(async () => {
		// One tool invocation across the rounds of an input_required result: the form in the chat
		// (the question carousel), llama sampling and roots, then the final result.
		const tool = 'test_input_required_result_multiple_inputs';
		const from = serverLogLines('zig-http');
		const before = await sendChat(`@e2e /call zig-http ${tool} {}`);
		const carousel = page.locator(`${CHAT} .chat-question-carousel-container`).last();
		await carousel.waitFor({ state: 'visible', timeout: 60_000 });
		const form = await visibleText(page, `${CHAT} .chat-question-carousel-container`);
		await shot(page, '24-chat-mrtr-form.png', 'An MRTR elicitation in chat',
			`@e2e /call zig-http ${tool}: the server answers input_required with an elicitation, a sampling request and a roots request; the elicitation is a form in the chat ("What is your name?").`,
			{ 'the form asks for the name': /What is your name\?/.test(form), 'the tool invocation is running': (await toolInvocationText(page)).includes(tool) }, form.slice(0, 400));
		await carousel.locator('input[type="text"], textarea').first().fill('Ada Lovelace');
		await sleep(300);
		await carousel.locator('.monaco-button', { hasText: /^Submit$/ }).first().click();
		const progress = new Set<string>();
		const record = await waitUntil(120_000, async () => {
			const status = (await toolInvocationText(page)).split('\n').find(l => /Round \d+|answered/.test(l));
			if (status) {
				progress.add(status);
			}
			return chatRecords()[before];
		}, 200);
		await sleep(1000);
		await expandCompletedSteps(page);
		const calls = loggedMessages(serverLog('zig-http')).filter(m => m.line >= from && m.sent && m.message.method === 'tools/call' && m.message.params?.name === tool);
		const parts = await page.locator(`${CHAT} .chat-tool-invocation-part`).filter({ visible: true }).count();
		const invocation = await toolInvocationText(page);
		const chat = await visibleText(page, CHAT);
		await shot(page, '24b-chat-mrtr-result.png', 'An MRTR tool call in chat, answered',
			`The same request after the form was submitted, its steps expanded: one tool invocation of ${tool}, labelled with its last progress message "Round 1: answered 3 input request(s)" (the elicitation, the llama sampling and the roots request of the round), followed by the form's answer (Q: name, A: Ada Lovelace); the participant shows the result, which combines the three answers ("Ada Lovelace: model llamacpp/qwen3-8b, 1 roots"). VS Code sent the tools/call twice: the input_required round, then the retry with the input responses.`,
			{
				'one tool invocation with the round': parts === 1 && invocation.includes('Round 1: answered 3 input request(s)'),
				'the form and its answer in the response': /Q:\s*name\s*A:\s*Ada Lovelace/.test(chat),
				'the final result': !!record?.calls[0]?.resultText.includes('Ada Lovelace: model llamacpp/qwen3-8b, 1 roots') && chat.includes('Ada Lovelace: model llamacpp/qwen3-8b, 1 roots'),
				'two tools/call (the round and the retry)': calls.length === 2 && !!calls[1].message.params?.inputResponses,
			}, `progress seen: ${[...progress].join(' | ') || 'none'}\n---\n${chat}`.slice(0, 700));
	}));

	await section(page, 'chat iserror', () => inChat(async () => {
		// The participant shows the result's text; the invocation itself is marked failed (chat-tool-call-error).
		const record = await chatRecordAfter(await sendChat('@e2e /call zig-http test_error_handling {}'), 60_000);
		await sleep(1000);
		await expandCompletedSteps(page);
		const failed = await page.locator(`${CHAT} .chat-tool-invocation-part.chat-tool-call-error`).filter({ visible: true }).count();
		const chat = await visibleText(page, CHAT);
		await shot(page, '24c-chat-tool-iserror.png', 'A tool result with isError in chat',
			'@e2e /call zig-http test_error_handling, its steps expanded: the server returns a result with isError ("Tool execution failed as requested"); the tool invocation is shown as failed (error icon), and the participant shows the text.',
			{ 'the result came back': !!record?.calls[0]?.resultText.includes('Tool execution failed as requested'), 'the invocation is shown as failed': failed === 1 },
			chat.slice(0, 600));
	}));

	await section(page, 'chat task', () => inChat(async () => {
		// A task-backed tool with an input round first (MRTR form in the chat), then polled to its result.
		const tool = 'test_tool_with_task';
		const from = serverLogLines('zig-http');
		const before = await sendChat(`@e2e /call zig-http ${tool} {}`);
		const carousel = page.locator(`${CHAT} .chat-question-carousel-container`).last();
		await carousel.waitFor({ state: 'visible', timeout: 60_000 });
		await carousel.locator('input[type="text"], textarea').first().fill('Ada Lovelace');
		await sleep(300);
		await carousel.locator('.monaco-button', { hasText: /^Submit$/ }).first().click();
		const record = await chatRecordAfter(before, 120_000);
		await sleep(1000);
		await expandCompletedSteps(page);
		const polls = loggedMessages(serverLog('zig-http')).filter(m => m.line >= from && m.sent && m.message.method === 'tasks/get').length;
		const chat = await visibleText(page, CHAT);
		await shot(page, '24d-chat-task-input-round.png', 'A task-backed tool with an input round in chat',
			`@e2e /call zig-http ${tool}: the input round (the name, answered in the chat form) resolved, the retried tools/call became a task that VS Code polled with tasks/get, and the invocation shows the task's result "Hello, Ada Lovelace! The task is done.".`,
			{ 'the task result': !!record?.calls[0]?.resultText.includes('Hello, Ada Lovelace! The task is done.') && chat.includes('Hello, Ada Lovelace! The task is done.'), 'VS Code polled the task': polls > 0 },
			`${polls} tasks/get\n---\n${chat}`.slice(0, 600));
	}));

	await section(page, 'chat cancel', () => inChat(async () => {
		// A long task (slow_compute, 60 s): its invocation while VS Code polls, then the chat request cancelled.
		const tool = 'slow_compute';
		const from = serverLogLines('zig-http');
		const before = await sendChat(`@e2e /call zig-http ${tool} {"seconds": 60, "label": "chat"}`);
		const taskId = await waitUntil(60_000, () => {
			const poll = loggedMessages(serverLog('zig-http')).find(m => m.line >= from && m.sent && m.message.method === 'tasks/get');
			return poll && String(poll.message.params?.taskId ?? '');
		}, 500);
		await sleep(2500);
		const running = await toolInvocationText(page);
		await shot(page, '24e-chat-task-running.png', 'A running task-backed tool in chat',
			`@e2e /call zig-http ${tool} {"seconds": 60}: the call became a task (${taskId ?? 'no task'}) and VS Code polls it with tasks/get; the invocation shows that the tool is running.`,
			{ 'the task was created and polled': !!taskId, 'the invocation is running': running.includes(tool) && !chatRecords()[before] }, running.slice(0, 400));
		await command('workbench.action.chat.cancel');
		const record = await chatRecordAfter(before, 30_000);
		const cancelled = await waitUntil(15_000, () => loggedMessages(serverLog('zig-http')).find(m => m.line >= from && m.sent && m.message.method === 'tasks/cancel' && String(m.message.params?.taskId) === taskId), 500);
		await sleep(1000);
		const chat = await visibleText(page, CHAT);
		await shot(page, '24f-chat-task-cancelled.png', 'A task-backed tool cancelled from chat',
			`The same request after Cancel in the chat view: VS Code sent tasks/cancel for ${taskId ?? 'the task'} and the request ended without a result.`,
			{ 'tasks/cancel sent for the task': !!cancelled, 'the request ended': !!record, 'no result': !record?.calls[0]?.resultText.includes('computed') },
			`${JSON.stringify(record?.calls ?? null).slice(0, 200)}\n---\n${chat}`.slice(0, 600));
	}));

	await section(page, 'chat app', () => inChat(async () => {
		// An MCP App: test_app_tool names the view ui://conformance/view in _meta.ui.resourceUri, which
		// the chat renders in a webview inside the tool invocation (chatMcpAppSubPart.ts).
		const record = await chatRecordAfter(await sendChat('@e2e /call zig-apps test_app_tool {}'), 60_000);
		const app = page.locator(`${CHAT} .mcp-app-part`).first();
		await app.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
		const view = await waitUntil(20_000, async () => {
			for (const frame of page.frames()) {
				const text = await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '');
				if (text.includes('The view of test_app_tool')) {
					return text;
				}
			}
			return undefined;
		}, 1000);
		const appError = await visibleText(page, `${CHAT} .mcp-app-error`);
		const chat = await visibleText(page, CHAT);
		await shot(page, '24g-chat-mcp-app.png', 'An MCP App in chat',
			'@e2e /call zig-apps test_app_tool: the tool invocation renders the MCP App ui://conformance/view in a webview ("The view of test_app_tool.").',
			{ 'the tool ran': !!record?.calls[0]?.resultText.includes('A result for the view'), 'the app part is shown': await app.isVisible().catch(() => false), 'the view is rendered': !!view },
			`${appError ? `error: ${appError}\n` : ''}${view ?? ''}\n---\n${chat}`.slice(0, 600));
	}));
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

		// Each section checks MCP_E2E_ONLY itself (wantsSection).
		const sectionsPart = (name: string, part: (page: Page) => Promise<void>) => part(page).catch(async (e: unknown) => {
			log(`${name} failed: ${e instanceof Error ? e.stack : String(e)}`);
			screenshots.push({ file: '', title: name, expect: '', ok: false, checks: { [`${name} ran to the end`]: false }, note: e instanceof Error ? e.message : String(e) });
			await page.screenshot({ path: path.join(env.screenshots, `zz-${name}-error.png`) }).catch(() => undefined);
		});
		await sectionsPart('screenshots', screenshotsPart);

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
			// An enum of the same form (oneOf with titles): a picker of the values, each with its title.
			onStep: {
				step: /^Titled Single Select Enum \(/,
				file: '14b-elicitation-form-enum.png',
				title: 'Legacy elicitation/create form: an enum',
				take: async () => {
					const text = await visibleText(page, '.quick-input-widget');
					await shot(page, '14b-elicitation-form-enum.png', 'Legacy elicitation/create form: an enum',
						'Step 11 of the server-everything form, "Titled Single Select Enum" (oneOf with titles): a picker of the values hero-1, hero-2, hero-3, each with its title (Superman, Green Lantern, Wonder Woman) next to it, and None.',
						{ 'enum step shown': /Titled Single Select Enum \(11\/\d+\)/.test(text), 'titles offered with their values': /hero-1\s*Superman/.test(text) && /hero-3\s*Wonder Woman/.test(text) }, text.slice(0, 300));
				},
			},
		});
		// A URL-mode elicitation outside chat (the fault proxy of zig-http-faults asks for one before every
		// call of test_tool_with_logging): a notification "<message> This will open <url>" with Open URL.
		// Open URL goes to the opener, whose link protection asks "Do you want Code - OSS to open the
		// external website?" (the host is not a trusted domain); Open hands the URL to the stand-in browser
		// (workbench.externalBrowser, runner/oauth-browser.ts), which records it and fetches nothing.
		const urlServer = 'zig-http-faults';
		const openWebsite = (text: string) => /open the external website/.test(text);
		await runUiScenario(page, 'url-elicitation-accept', {
			dialogButton: text => openWebsite(text) ? 'Open' : undefined,
			checkTrace: trace => trace.notificationActions.join() === 'Open URL' && trace.answeredDialogs.length === 1 && openWebsite(trace.answeredDialogs[0].text) && trace.answeredDialogs[0].button === 'Open'
				? undefined
				: `expected Open URL in one notification, then Open in one link protection dialog: ${JSON.stringify({ notificationActions: trace.notificationActions, answeredDialogs: trace.answeredDialogs })}`,
			onNotification: {
				file: '26-elicitation-url-notification.png',
				title: 'URL elicitation outside chat',
				take: async () => {
					// The URL the server asked for, from VS Code's MCP log (written shortly after the answer arrived).
					const url = await waitUntil(5000, () => lastElicitationUrl(urlServer));
					const toast = page.locator('.notification-toast', { hasText: 'MCP E2E URL elicitation' }).first();
					const message = (await toast.locator('.notification-list-item-message').innerText().catch(() => '')).replace(/ /g, ' ');
					const toastText = (await toast.innerText().catch(() => '')).replace(/ /g, ' ');
					const buttons = (await toast.locator('.monaco-button').allInnerTexts().catch(() => [] as string[])).map(b => b.trim());
					await shot(page, '26-elicitation-url-notification.png', 'URL elicitation outside chat',
						'A notification from "MCP Server (zig-http-faults)": the server\'s message "MCP E2E URL elicitation: consent for test_tool_with_logging (round <n>)", then "This will open https://url-elicitation.mcp-e2e.test/consent?id=<n>" (the full URL, with its host), and an Open URL button.', {
						'the server\'s message': message.includes('MCP E2E URL elicitation: consent for test_tool_with_logging'),
						'the full URL the server sent': !!url && message.includes(`This will open ${url}`),
						'the host of the URL': !!hostOf(url) && message.includes(hostOf(url)),
						'source MCP Server (zig-http-faults)': toastText.includes(`MCP Server (${urlServer})`),
						'Open URL button': buttons.includes('Open URL'),
					}, `${url ?? '(no URL elicitation in the MCP log)'}\n${toastText}`.slice(0, 400));
				},
			},
			onDialog: {
				file: '26b-elicitation-url-open-website.png',
				title: 'URL elicitation: the link protection prompt',
				take: async () => {
					const url = lastElicitationUrl(urlServer);
					const text = (await visibleText(page, '.monaco-dialog-box')).replace(/\s+/g, ' ');
					const buttons = (await page.locator('.monaco-dialog-box .monaco-button').allInnerTexts().catch(() => [] as string[])).map(b => b.trim());
					await shot(page, '26b-elicitation-url-open-website.png', 'URL elicitation: the link protection prompt',
						'After Open URL: the modal dialog "Do you want Code - OSS to open the external website?" with the full URL (url-elicitation.mcp-e2e.test is not a trusted domain) and the buttons Open, Copy, Configure Trusted Domains and Cancel.', {
						'asks to open the external website': openWebsite(text),
						'the full URL': !!url && text.includes(url),
						'Open button': buttons.includes('Open'),
						'Cancel button': buttons.includes('Cancel'),
					}, `${url ?? '(no URL elicitation in the MCP log)'}\n${text}`.slice(0, 400));
				},
			},
		});
		// Declined: Cancel, a secondary action of the notification (its More Actions... menu), answers
		// decline; nothing is opened, so there is no link protection dialog either.
		await runUiScenario(page, 'url-elicitation-decline', {
			notificationMenuItem: 'Cancel',
			checkTrace: trace => trace.notificationActions.join() === 'More Actions... > Cancel' && !trace.dialogs.length
				? undefined
				: `expected Cancel from the More Actions... menu of one notification and no dialog: ${JSON.stringify({ notificationActions: trace.notificationActions, dialogs: trace.dialogs, stalls: trace.stalls })}`,
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
		// The account of that sign-in in the Accounts menu, and Sign Out (before the other sign-ins,
		// whose accounts have the same label).
		if (tests.some(t => t.name === scenarioNames.get('oauth') && t.status === 'passed')) {
			await sectionsPart('accounts', accountsPart);
		}
		// The negative sign-ins (an authorization response with a wrong iss, or none) and the sign-in
		// over gRPC; each server asks for its own consent.
		const consent = (text: string) => /wants to authenticate to/.test(text) ? 'Allow' : undefined;
		const consentAsked = (trace: IElicitationTrace) => trace.answeredDialogs.length >= 1 ? undefined : 'the sign-in never asked for consent';
		await runUiScenario(page, 'oauth-iss-wrong', { dialogButton: consent, checkTrace: consentAsked });
		await runUiScenario(page, 'oauth-iss-omit', { dialogButton: consent, checkTrace: consentAsked });
		await runUiScenario(page, 'oauth-grpc', { dialogButton: consent, checkTrace: trace => trace.answeredDialogs.length === 1 ? undefined : `expected exactly one consent dialog for the gRPC sign-in, answered ${trace.answeredDialogs.length}` });

		// Last: the tool calls from the chat view (a chat request autostarts every server that never ran).
		await dismissDialogs(page);
		await clearNotifications();
		await sectionsPart('chat', chatPart);
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

// ui/policy.ts imports the launch and the helpers of this driver.
if (import.meta.main) {
	process.exitCode = await main();
}
