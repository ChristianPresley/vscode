/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../base/common/async.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { McpConnectionState, McpServerLaunch, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostVariableResolverProvider } from '../../common/extHostVariableResolverService.js';
import { IExtHostWorkspace } from '../../common/extHostWorkspace.js';
import { escapeCmdArg, NodeExtHostMpcService } from '../../node/extHostMcpNode.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

suite('extHostMcpNode - escapeCmdArg', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('wraps simple values in double quotes', () => {
		assert.strictEqual(escapeCmdArg('list'), '"list"');
		assert.strictEqual(escapeCmdArg('--prefix'), '"--prefix"');
		assert.strictEqual(escapeCmdArg(''), '""');
	});

	test('preserves paths with spaces', () => {
		assert.strictEqual(
			escapeCmdArg('C:\\Program Files\\nodejs\\npm.cmd'),
			'"C:\\Program Files\\nodejs\\npm.cmd"',
		);
	});

	test('preserves paths with parentheses without injecting ^', () => {
		// Regression: a previous fix prepended ^ to ( and ), which broke
		// resolution of paths like `C:\\Program Files (x86)\\nodejs\\npm.cmd`
		// because ^ is literal inside cmd.exe double quotes.
		assert.strictEqual(
			escapeCmdArg('C:\\Program Files (x86)\\nodejs\\npm.cmd'),
			'"C:\\Program Files (x86)\\nodejs\\npm.cmd"',
		);
	});

	test('neutralizes cmd.exe metacharacters inside quotes (CVE-2024-27980)', () => {
		// Vector 1: arg containing & must not break out of quotes.
		assert.strictEqual(escapeCmdArg('&calc.exe'), '"&calc.exe"');
		// Vector 2: workspace path expanded into an arg with & in directory name.
		assert.strictEqual(
			escapeCmdArg('C:\\work\\legitimate-repo&calc.exe'),
			'"C:\\work\\legitimate-repo&calc.exe"',
		);
		// Other metacharacters that are literal inside cmd double quotes.
		assert.strictEqual(escapeCmdArg('a|b'), '"a|b"');
		assert.strictEqual(escapeCmdArg('a<b>c'), '"a<b>c"');
		assert.strictEqual(escapeCmdArg('(group)'), '"(group)"');
		assert.strictEqual(escapeCmdArg('^carat'), '"^carat"');
	});

	test('does not add stray ^ to argument values', () => {
		// Regression: a previous fix wrote `"^&calc.exe"`, leaving a literal ^
		// in the value the spawned program received.
		assert.ok(
			!escapeCmdArg('&calc.exe').includes('^'),
			'cmd metachars must not be prefixed with ^ inside quotes',
		);
	});

	test('doubles embedded double quotes (cmd.exe convention)', () => {
		// Embedded `"` must become `""` so cmd.exe stays in quoted state and
		// any metacharacter that follows cannot be interpreted as an operator.
		assert.strictEqual(escapeCmdArg('a"b'), '"a""b"');
		assert.strictEqual(escapeCmdArg('"&calc"'), '"""&calc"""');
		// After replacement, the number of `"` in the wrapped output must be
		// even so cmd.exe's quote-state toggling never leaves a metacharacter
		// outside a quoted region.
		for (const input of ['"', '""', 'a"b', '"&calc"', 'a"&calc']) {
			const out = escapeCmdArg(input);
			const quoteCount = (out.match(/"/g) || []).length;
			assert.strictEqual(quoteCount % 2, 0, `quote count must be even for ${JSON.stringify(input)} -> ${out}`);
		}
	});
});

suite('NodeExtHostMpcService - launches that cannot start', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a stdio launch whose asynchronous start fails reports Error instead of staying in Starting', async () => {
		const states: McpConnectionState[] = [];
		const proxy = new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
		};
		const service = store.add(new NodeExtHostMpcService(SingleProxyRPCProtocol(proxy), new NullLogService(), new class extends mock<IExtHostInitDataService>() { }, new class extends mock<IExtHostWorkspace>() { }, new class extends mock<IExtHostVariableResolverProvider>() { }));
		// A malformed launch as it may arrive over the protocol: no environment object.
		const launch: McpServerLaunch.Serialized = JSON.parse('{"type":1,"command":"node","args":[],"env":null}');
		service.$startMcp(1, { launch });
		await timeout(0);
		assert.deepStrictEqual(states.map(s => s.state), [McpConnectionState.Kind.Error]);
	});
});

suite('NodeExtHostMpcService - stdio launches', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function waitUntil(condition: () => boolean, what: () => string): Promise<void> {
		for (let waited = 0; !condition(); waited += 10) {
			assert.ok(waited < 10_000, `timed out waiting for ${what()}`);
			await timeout(10);
		}
	}

	test('an envelope does not change what is written to the server, and $cancelRequest writes nothing and leaves the server running', async () => {
		const states: McpConnectionState[] = [];
		const received: string[] = [];
		const proxy = new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
			override $onDidReceiveMessage(_id: number, message: string): void { received.push(message); }
			override $onDidPublishLog(): void { }
		};
		const service = store.add(new NodeExtHostMpcService(SingleProxyRPCProtocol(proxy), new NullLogService(), new class extends mock<IExtHostInitDataService>() { }, new class extends mock<IExtHostWorkspace>() { }, new class extends mock<IExtHostVariableResolverProvider>() { }));
		// A server that answers every line it reads with that line, line break included, as a JSON string; it exits when its input ends.
		const script = [
			`let pending = '';`,
			`process.stdin.setEncoding('utf8');`,
			`process.stdin.on('data', chunk => { pending += chunk; for (let end = pending.indexOf('\\n'); end >= 0; end = pending.indexOf('\\n')) { process.stdout.write(JSON.stringify({ frame: pending.slice(0, end + 1) }) + '\\n'); pending = pending.slice(end + 1); } });`,
			`process.stdin.on('end', () => process.exit(0));`,
		].join(' ');
		// ELECTRON_RUN_AS_NODE lets the Electron test runner's executable run the script as Node does.
		const launch = McpServerLaunch.toSerialized({ type: McpServerTransportType.Stdio, command: process.execPath, args: ['-e', script], env: { ELECTRON_RUN_AS_NODE: '1' }, envFile: undefined, cwd: undefined, sandbox: undefined });
		service.$startMcp(1, { launch });
		await waitUntil(() => states.some(s => s.state === McpConnectionState.Kind.Running), () => `the server to run: ${JSON.stringify(states)}`);

		const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		service.$sendMessage(1, request, { kind: 'request', requestId: 1, protocolVersion: '2026-07-28', method: 'tools/list', headers: { 'Mcp-Method': 'tools/list' } });
		await waitUntil(() => received.length === 1, () => `the request to reach the server: ${JSON.stringify(received)}`);

		service.$cancelRequest(1, 1);
		service.$cancelRequest(1, 'never-sent');
		// Lines reach the server in order: anything the cancellation wrote would come before this one.
		const after = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
		service.$sendMessage(1, after, { kind: 'request', requestId: 2, protocolVersion: '2025-11-25', method: 'ping' });
		await waitUntil(() => received.length === 2, () => `the next request to reach the server: ${JSON.stringify(received)}`);

		assert.deepStrictEqual(received.map(line => JSON.parse(line).frame), [`${request}\n`, `${after}\n`]);
		assert.deepStrictEqual(states.map(s => s.state), [McpConnectionState.Kind.Starting, McpConnectionState.Kind.Running]);

		service.$stopMcp(1);
		await waitUntil(() => states.length > 2, () => `the server to stop: ${JSON.stringify(states)}`);
		assert.deepStrictEqual(states.slice(2), [{ state: McpConnectionState.Kind.Stopped }]);
	});
});

suite('NodeExtHostMpcService - gRPC launches', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a gRPC launch starts a gRPC handle, which checks its grpcs:// URL before every call', async () => {
		const states: McpConnectionState[] = [];
		const checked: string[] = [];
		const proxy = new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { states.push(state); }
			override $onDidPublishLog(): void { }
			override async $checkMcpServerAllowed(_id: number, url: string): Promise<string | undefined> {
				checked.push(url);
				return 'denied by the test policy'; // ends the call before any connection is made
			}
		};
		const service = store.add(new NodeExtHostMpcService(SingleProxyRPCProtocol(proxy), new NullLogService(), new class extends mock<IExtHostInitDataService>() { }, new class extends mock<IExtHostWorkspace>() { }, new class extends mock<IExtHostVariableResolverProvider>() { }));
		const launch = McpServerLaunch.toSerialized({ type: McpServerTransportType.Grpc, uri: URI.parse('grpcs://mcp.example:443'), headers: [], binding: 'tunnel' });
		service.$startMcp(1, { launch });
		service.$sendMessage(1, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { kind: 'request', requestId: 1, protocolVersion: '2026-07-28', method: 'tools/list' });
		for (let waited = 0; states.length < 2; waited += 5) {
			assert.ok(waited < 5000, `states: ${JSON.stringify(states)}`);
			await timeout(5);
		}
		assert.deepStrictEqual({ states, checked }, {
			states: [{ state: McpConnectionState.Kind.Running }, { state: McpConnectionState.Kind.Error, message: 'denied by the test policy' }],
			checked: ['grpcs://mcp.example:443'],
		});
	});
});
