/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Writes the user data folder of the test instance before VS Code starts:
//   <profile>/User/settings.json   auto-approval, sampling for the llama model, a quiet workbench
//   <profile>/User/mcp.json        the servers of config/servers.json (user level, so trusted)
//   <profile>/User/globalStorage/state.vscdb
//                                  the one-time opt-in of `chat.tools.global.autoApprove`
//                                  (otherwise a modal dialog asks for it on the first tool call)
//   <tls dir>/ca.pem, server.pem, server-key.pem
//                                  the throw-away CA of the grpcs:// servers (runner/test-ca.ts),
//                                  when an entry uses {tlsCa}; mcp.json gets the path of ca.pem
//
// Usage: node runner/prepare-profile.ts <profile dir> --zig <server binary> --everything <entry point> [--tls-dir <dir>]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activeMutations, readServers, resolvePlaceholders, samplingKeyOf, type IRunnerServer } from './servers.ts';
import { ensureTestCa } from './test-ca.ts';

/** `chat.tools.global.autoApprove` asks once before it takes effect; this application-scope key records the answer. */
export const AUTO_APPROVE_OPT_IN_KEY = 'chat.tools.global.autoApprove.optIn';
/** VS Code's identifier of the E2E extension's model. */
export const LLAMA_MODEL_IDENTIFIER = 'llamacpp/qwen3-8b';

/**
 * @param browser The program VS Code opens external URLs with (`workbench.externalBrowser`, a
 * restricted setting that only the user settings may set): the OAuth test's stand-in browser.
 */
export function settingsFor(servers: readonly IRunnerServer[], browser?: string, mutations: ReadonlySet<string> = new Set()): Record<string, unknown> {
	const sampling: Record<string, unknown> = {};
	for (const server of servers) {
		// Mutation sampling-deny: the gRPC tunnel server may not use the model outside chat.
		const denied = mutations.has('sampling-deny') && server.label === 'zig-grpc-tunnel';
		sampling[samplingKeyOf(server)] = { allowedDuringChat: !denied, allowedOutsideChat: !denied, allowedModels: [LLAMA_MODEL_IDENTIFIER] };
	}
	return {
		...(browser ? { 'workbench.externalBrowser': browser } : {}),
		// Tool calls from vscode.lm.invokeTool are approved without a confirmation dialog.
		'chat.tools.global.autoApprove': true,
		// Start configured servers when they are needed; the suite also starts them explicitly.
		'chat.mcp.autostart': 'newAndOutdated',
		// Only the servers of this run: no servers imported from other applications' configurations.
		'chat.mcp.discovery.enabled': false,
		'chat.mcp.serverSampling': sampling,
		// In-DOM dialogs and title bar, so that Playwright sees them under xvfb (no window manager).
		'window.titleBarStyle': 'custom',
		'window.dialogStyle': 'custom',
		'window.restoreWindows': 'none',
		'workbench.startupEditor': 'none',
		'workbench.tips.enabled': false,
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'workbench.enableExperiments': false,
		'security.workspace.trust.enabled': false,
		'telemetry.telemetryLevel': 'off',
		'update.mode': 'none',
		'extensions.autoCheckUpdates': false,
		'extensions.autoUpdate': false,
		'extensions.ignoreRecommendations': true,
		'git.openRepositoryInParentFolders': 'never',
		'files.simpleDialog.enable': true,
	};
}

export function mcpJsonFor(servers: readonly IRunnerServer[], placeholders: Record<string, string>, mutations: ReadonlySet<string> = new Set()): { servers: Record<string, unknown>; inputs: unknown[] } {
	const out: Record<string, unknown> = {};
	for (const server of servers) {
		if (server.mcp) {
			out[server.label] = mutateEntry(server.label, resolvePlaceholders(server.mcp, placeholders), placeholders, mutations);
		}
	}
	return { servers: out, inputs: [] };
}

/**
 * The mutations of runner/mutations.ts that change mcp.json (each must make a test fail):
 * no-tls-ca, trust-everything, no-insecure, pin-unpinned, unpin-legacy, sse-to-streamable, deadline-everywhere
 * (and sampling-deny in settingsFor).
 */
export function mutateEntry(label: string, entry: Record<string, unknown>, placeholders: Record<string, string>, mutations: ReadonlySet<string>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...entry };
	const tls = (typeof out.tls === 'object' && out.tls !== null ? { ...(out.tls as Record<string, unknown>) } : undefined);
	if (mutations.has('no-tls-ca') && tls && tls.ca !== undefined) {
		delete tls.ca;
		out.tls = tls;
	}
	if (mutations.has('no-insecure') && tls && tls.insecure !== undefined) {
		delete tls.insecure;
		out.tls = tls;
	}
	if (mutations.has('trust-everything') && (label === 'zig-grpcs-untrusted' || label === 'zig-grpcs-wrong-name')) {
		// The negative entries get the CA and the right server name: they connect.
		out.tls = { ca: placeholders.tlsCa };
	}
	if (mutations.has('pin-unpinned') && label === 'everything-unpinned') {
		out.protocolVersion = '2025-11-25';
	}
	if (mutations.has('unpin-legacy') && label === 'zig-http-pin-legacy') {
		delete out.protocolVersion;
	}
	if (mutations.has('sse-to-streamable') && label === 'everything-sse') {
		out.url = 'http://127.0.0.1:3301/mcp';
	}
	if (mutations.has('deadline-everywhere') && label === 'zig-grpcs') {
		out.deadlineMs = 60000;
	}
	return out;
}

export function seedApplicationStorage(file: string, entries: Record<string, string>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	try {
		db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
		const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
		for (const [key, value] of Object.entries(entries)) {
			insert.run(key, value);
		}
	} finally {
		db.close();
	}
}

function argValue(args: readonly string[], name: string, fallback: string): string {
	const i = args.indexOf(name);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

/**
 * Writes the executable that `workbench.externalBrowser` names: VS Code spawns `<program> <url>`,
 * and the wrapper runs runner/oauth-browser.ts with Node, logging to `logFile`.
 */
export function writeBrowserWrapper(file: string, logFile: string): void {
	const script = path.join(import.meta.dirname, 'oauth-browser.ts');
	const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `#!/bin/sh\n# The stand-in web browser of the MCP end-to-end run (runner/oauth-browser.ts).\nexec ${quote(process.execPath)} ${quote(script)} --log ${quote(logFile)} "$@"\n`);
	fs.chmodSync(file, 0o755);
}

function main(argv: readonly string[]): void {
	const profile = argv[0];
	if (!profile) {
		throw new Error('usage: prepare-profile.ts <profile dir> [--zig <binary>] [--everything <entry point>] [--servers <servers.json>] [--tls-dir <dir>] [--browser <wrapper> --browser-log <file.jsonl>]');
	}
	const browser = argValue(argv, '--browser', '');
	if (browser) {
		writeBrowserWrapper(path.resolve(browser), path.resolve(argValue(argv, '--browser-log', path.join(path.dirname(browser), 'oauth-browser.jsonl'))));
	}
	const serversFile = argValue(argv, '--servers', path.join(import.meta.dirname, '..', 'config', 'servers.json'));
	const tlsDir = path.resolve(argValue(argv, '--tls-dir', '/tmp/e2e/tls'));
	const servers = readServers(serversFile);
	// The CA is created here (before VS Code reads mcp.json) and reused by runner/start-servers.ts.
	const tlsCa = JSON.stringify(servers).includes('{tlsCa}') ? ensureTestCa(tlsDir).caCert : path.join(tlsDir, 'ca.pem');
	const placeholders = {
		zig: argValue(argv, '--zig', '/work/zig-sdk/zig-out/bin/mcp-conformance-server'),
		everything: argValue(argv, '--everything', '/work/e2e-tools/node_modules/@modelcontextprotocol/server-everything/dist/index.js'),
		tlsCa,
	};
	const mutations = activeMutations();
	const user = path.join(profile, 'User');
	fs.mkdirSync(user, { recursive: true });
	fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify(settingsFor(servers, browser ? path.resolve(browser) : undefined, mutations), null, '\t'));
	fs.writeFileSync(path.join(user, 'mcp.json'), JSON.stringify(mcpJsonFor(servers, placeholders, mutations), null, '\t'));
	seedApplicationStorage(path.join(user, 'globalStorage', 'state.vscdb'), { [AUTO_APPROVE_OPT_IN_KEY]: 'true' });
	console.log(`[prepare-profile] ${profile}: ${servers.filter(s => s.mcp).length} servers in mcp.json, settings.json, auto-approve opt-in${browser ? `, browser ${browser}` : ''}${tlsCa && fs.existsSync(tlsCa) ? `, test CA ${tlsCa}` : ''}${mutations.size ? `, mutations ${[...mutations].join(', ')}` : ''}`);
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
