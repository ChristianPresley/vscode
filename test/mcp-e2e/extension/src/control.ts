/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';
import { mcpToolsOf } from './agent';
import { E2eHarness } from './harness';
import { log, runTest } from './runner';
import { uiScenarios } from './scenarios';

/** The cursor marker of `POST /editor`. */
const CURSOR = '$CURSOR$';

/**
 * The UI-mode control server (loopback only). The Playwright driver uses it
 * to wait until the servers run, to run the scenarios that need UI input
 * (it answers the elicitation UI while the request is open), and to execute
 * workbench commands that have no UI entry point (for example opening the
 * output channel of one MCP server).
 *
 * - `GET /ready` -> `{ ready, outcomes }`
 * - `GET /tools?server=<label>` -> the tool ids of a server
 * - `POST /scenario { id }` -> the test result of a UI scenario
 * - `POST /command { command, args, wait? }` -> `{ ok, result | error }` (`wait: false` answers at once)
 * - `POST /open { path }` -> opens a file in an editor
 * - `POST /editor { text }` -> replaces the active editor's text, cursor at `$CURSOR$`
 */
export function startControlServer(h: E2eHarness, port: number): vscode.Disposable {
	const scenarios = uiScenarios(h);
	let ready = false;
	h.startServers().then(() => { ready = true; }, e => log(`starting the servers failed: ${e}`));

	const readBody = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			try {
				const text = Buffer.concat(chunks).toString('utf8');
				resolve(text ? JSON.parse(text) as Record<string, unknown> : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});

	const send = (res: http.ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body, (_k, v: unknown) => v instanceof Uint8Array ? `<${v.byteLength} bytes>` : v));
	};

	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (req.method === 'GET' && url.pathname === '/ready') {
				send(res, 200, { ready, outcomes: ready ? await h.startServers() : undefined });
			} else if (req.method === 'GET' && url.pathname === '/scenarios') {
				// The id and test name of every UI scenario (the driver filters MCP_E2E_ONLY by both).
				send(res, 200, [...scenarios].map(([id, test]) => ({ id, name: test.name })));
			} else if (req.method === 'GET' && url.pathname === '/tools') {
				send(res, 200, mcpToolsOf(url.searchParams.get('server') ?? '').map(t => t.name));
			} else if (req.method === 'POST' && url.pathname === '/scenario') {
				const { id } = await readBody(req);
				const test = typeof id === 'string' ? scenarios.get(id) : undefined;
				if (!test) {
					send(res, 404, { error: `unknown scenario ${String(id)}; known: ${[...scenarios.keys()].join(', ')}` });
					return;
				}
				send(res, 200, await runTest(test, h.env));
			} else if (req.method === 'POST' && url.pathname === '/command') {
				const { command, args, wait } = await readBody(req);
				const running = Promise.resolve(vscode.commands.executeCommand(String(command), ...(Array.isArray(args) ? args : [])));
				if (wait === false) {
					// Commands that open a quick pick only resolve once it closes.
					running.catch(e => log(`command ${String(command)} failed: ${e}`));
					send(res, 200, { ok: true, result: null });
					return;
				}
				try {
					const result: unknown = await running;
					send(res, 200, { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
				} catch (e) {
					send(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
				}
			} else if (req.method === 'POST' && url.pathname === '/open') {
				const { path } = await readBody(req);
				const editor = await vscode.window.showTextDocument(vscode.Uri.file(String(path)), { preview: false });
				send(res, 200, { ok: true, uri: editor.document.uri.toString(), languageId: editor.document.languageId });
			} else if (req.method === 'POST' && url.pathname === '/editor') {
				// Replaces the text of the active editor (without saving) and puts the cursor at the `$CURSOR$` marker.
				const { text } = await readBody(req);
				const editor = vscode.window.activeTextEditor;
				if (!editor || typeof text !== 'string') {
					send(res, 400, { error: 'no active text editor or no text' });
					return;
				}
				const offset = text.indexOf(CURSOR);
				const content = text.replace(CURSOR, '');
				const doc = editor.document;
				await editor.edit(b => b.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content));
				const position = doc.positionAt(offset === -1 ? content.length : offset);
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position));
				send(res, 200, { ok: true, uri: doc.uri.toString(), line: position.line, character: position.character });
			} else {
				send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
			}
		} catch (e) {
			send(res, 500, { error: e instanceof Error ? e.stack : String(e) });
		}
	});
	server.listen(port, '127.0.0.1', () => log(`control server on http://127.0.0.1:${port}`));
	return new vscode.Disposable(() => server.close());
}
