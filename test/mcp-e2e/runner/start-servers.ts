/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Starts the network MCP servers of config/servers.json inside the test container (the stdio
// servers are spawned by VS Code itself) and waits until each one accepts connections.
//
// Usage: node runner/start-servers.ts start <log dir> [--zig <binary>] [--everything <entry point>] [--tls-dir <dir>]
//        node runner/start-servers.ts stop <log dir>

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { activeMutations, readServers, resolvePlaceholders } from './servers.ts';

/** The mutations of runner/mutations.ts that runner/http-fault-proxy.ts applies (--mutate). */
const HTTP_PROXY_MUTATIONS = ['strip-tasks', 'drop-tasks-cancel', 'drop-listen-ack', 'drop-progress', 'strip-mcp-param'];
import { ensureTestCa } from './test-ca.ts';

function canConnect(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect({ host: '127.0.0.1', port });
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => resolve(false));
		socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
	});
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await canConnect(port)) {
			return true;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	return false;
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!await canConnect(port)) {
			return true;
		}
		await new Promise(r => setTimeout(r, 200));
	}
	return false;
}

function argValue(args: readonly string[], name: string, fallback: string): string {
	const i = args.indexOf(name);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

/** Spawns one detached process (output into `<logDir>/<name>.log`) and waits until it listens on `port`. */
async function startProcess(logDir: string, name: string, command: string, args: readonly string[], port: number, env: Record<string, string> | undefined, pids: Record<string, number>): Promise<boolean> {
	if (await canConnect(port) && !await waitForPortFree(port, 10_000)) {
		console.error(`[start-servers] port ${port} of ${name} is already in use`);
		return false;
	}
	// A server of the previous start can leave its port unbindable for a while although nothing
	// listens any more (TIME_WAIT connections; the zig server binds without SO_REUSEADDR and exits
	// with AddressInUse, seen in run dbg-2 between the API and the UI suite). A process that exits
	// before it listens is started again until the port can be bound, for up to 90 s.
	const deadline = Date.now() + 90_000;
	for (let attempt = 1; ; attempt++) {
		const out = fs.openSync(path.join(logDir, `${name}.log`), 'a');
		const child = spawn(command, args, { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...env } });
		fs.closeSync(out);
		child.unref();
		pids[name] = child.pid ?? -1;
		let exitCode: number | null | undefined;
		const exited = new Promise<void>(resolve => child.once('exit', code => { exitCode = code; resolve(); }));
		const ok = await Promise.race([waitForPort(port, 30_000), exited.then(() => false)]);
		if (ok || exitCode === undefined || Date.now() > deadline) {
			console.log(`[start-servers] ${name}: ${command} ${args.join(' ')} (pid ${child.pid}) ${ok ? `listening on ${port}` : `NOT listening on ${port}${exitCode !== undefined ? ` (exited with ${exitCode})` : ''}`}${attempt > 1 ? ` after ${attempt} attempts` : ''}`);
			return ok;
		}
		console.log(`[start-servers] ${name}: exited with ${exitCode} before listening on ${port} (attempt ${attempt}); starting it again in 3 s`);
		await new Promise(r => setTimeout(r, 3000));
	}
}

async function start(logDir: string, args: readonly string[]): Promise<number> {
	const placeholders = {
		zig: argValue(args, '--zig', '/work/zig-sdk/zig-out/bin/mcp-conformance-server'),
		everything: argValue(args, '--everything', '/work/e2e-tools/node_modules/@modelcontextprotocol/server-everything/dist/index.js'),
	};
	const servers = readServers(argValue(args, '--servers', path.join(import.meta.dirname, '..', 'config', 'servers.json')));
	const tlsDir = path.resolve(argValue(args, '--tls-dir', '/tmp/e2e/tls'));
	const mutations = activeMutations();
	fs.mkdirSync(logDir, { recursive: true });
	const pids: Record<string, number> = {};
	let failures = 0;
	for (const server of servers) {
		if (!server.process) {
			continue;
		}
		const p = resolvePlaceholders(server.process, placeholders);
		// The server itself, or (for an entry without a command) another entry's server as the upstream.
		const upstream = p.command ? p.port : p.upstreamPort;
		if (p.command && (p.port === undefined || !await startProcess(logDir, server.label, p.command, p.args ?? [], p.port, p.env, pids))) {
			failures++;
			continue;
		}
		if (upstream === undefined) {
			console.error(`[start-servers] ${server.label}: neither a command with a port nor an upstreamPort`);
			failures++;
			continue;
		}
		if (p.grpcLogProxy) {
			// The server's side of the gRPC traffic: the zig-sdk server logs no requests.
			const proxyArgs = [path.join(import.meta.dirname, 'grpc-log-proxy.ts'), '--listen', String(p.grpcLogProxy.port), '--upstream', String(upstream), '--log', path.join(logDir, `${server.label}.wire.jsonl`)];
			if (p.grpcLogProxy.refuseTunnel && !mutations.has('grpc-allow-tunnel')) {
				proxyArgs.push('--refuse-tunnel');
			}
			if (p.grpcLogProxy.resetLimit) {
				proxyArgs.push('--rst-burst', String(p.grpcLogProxy.resetLimit.burst), '--rst-rate', String(p.grpcLogProxy.resetLimit.rate));
			}
			if (p.grpcLogProxy.tls) {
				// The CA that prepare-profile.ts created (a new one when it did not run).
				const ca = ensureTestCa(tlsDir);
				proxyArgs.push('--tls-cert', ca.serverCert, '--tls-key', ca.serverKey);
			}
			for (const spec of mutations.has('no-mangle') ? [] : p.grpcLogProxy.mangle ?? []) {
				proxyArgs.push('--mangle-mcp-name', spec);
			}
			for (const spec of mutations.has('no-hold') ? [] : p.grpcLogProxy.hold ?? []) {
				proxyArgs.push('--hold', spec);
			}
			if (!await startProcess(logDir, `${server.label}-proxy`, process.execPath, proxyArgs, p.grpcLogProxy.port, undefined, pids)) {
				failures++;
			}
		}
		if (p.httpProxy) {
			// The record of the HTTP requests, the injected faults and the HTTP mutations.
			const proxyArgs = [path.join(import.meta.dirname, 'http-fault-proxy.ts'), '--listen', String(p.httpProxy.port), '--upstream', String(upstream), '--log', path.join(logDir, `${server.label}.http.jsonl`)];
			for (const spec of mutations.has('no-faults') ? [] : p.httpProxy.faults ?? []) {
				proxyArgs.push('--fault', spec);
			}
			for (const name of HTTP_PROXY_MUTATIONS.filter(m => mutations.has(m))) {
				proxyArgs.push('--mutate', name);
			}
			if (!await startProcess(logDir, `${server.label}-http`, process.execPath, proxyArgs, p.httpProxy.port, undefined, pids)) {
				failures++;
			}
		}
		if (p.oauthFixture) {
			// The protected resource and authorization server in front of the server (its /mcp, or its gRPC port).
			const f = p.oauthFixture;
			const fixtureArgs = [path.join(import.meta.dirname, 'oauth-fixture.ts'), '--listen', String(f.port), '--log', path.join(logDir, `${server.label}.oauth.jsonl`)];
			fixtureArgs.push(...(f.grpcPort !== undefined ? ['--grpc-listen', String(f.grpcPort), '--grpc-upstream', String(upstream)] : ['--upstream', String(upstream)]));
			if (f.asPort !== undefined) {
				fixtureArgs.push('--as-port', String(f.asPort));
			}
			if (f.asPath) {
				fixtureArgs.push('--as-path', f.asPath);
			}
			if (f.prmPath) {
				fixtureArgs.push('--prm-path', f.prmPath);
			}
			fixtureArgs.push('--iss-mode', mutations.has('oauth-iss-ok') ? 'ok' : f.issMode ?? 'ok');
			if (!await startProcess(logDir, `${server.label}-oauth`, process.execPath, fixtureArgs, f.grpcPort ?? f.port, undefined, pids)) {
				failures++;
			}
		}
	}
	fs.writeFileSync(path.join(logDir, 'pids.json'), JSON.stringify(pids, null, '\t'));
	return failures ? 1 : 0;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Stops the servers of a previous start and waits until they are gone (SIGKILL after 5 s). */
async function stop(logDir: string): Promise<number> {
	const file = path.join(logDir, 'pids.json');
	if (!fs.existsSync(file)) {
		return 0;
	}
	const pids = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, number>;
	for (const [label, pid] of Object.entries(pids)) {
		try {
			process.kill(-pid, 'SIGTERM');
			console.log(`[start-servers] stopping ${label} (pid ${pid})`);
		} catch {
			// already gone
		}
	}
	const deadline = Date.now() + 5000;
	while (Object.values(pids).some(isAlive) && Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 100));
	}
	for (const pid of Object.values(pids).filter(isAlive)) {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			// gone in the meantime
		}
	}
	fs.rmSync(file);
	return 0;
}

const [command, logDir, ...rest] = process.argv.slice(2);
if (command === 'start' && logDir) {
	process.exitCode = await start(logDir, rest);
} else if (command === 'stop' && logDir) {
	process.exitCode = await stop(logDir);
} else {
	console.error('usage: start-servers.ts start|stop <log dir> [--zig <binary>] [--everything <entry point>] [--tls-dir <dir>]');
	process.exitCode = 2;
}
