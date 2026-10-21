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
