/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { McpResourceFormat } from '../../../../../platform/mcp/common/mcpWorkspaceConfiguration.js';
import { formatMcpServerArgs, getMcpServerFormatError, getMcpServerFormCapabilities, McpServerFormKind, mergeMcpServerFormKeyValues, parseMcpServerArgs, toMcpServerConfiguration, toMcpServerFormState, validateMcpServerFormState } from '../../common/mcpServerConfigurationForm.js';

suite('MCP Server Configuration Form', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('args round trip between text and arrays', () => {
		assert.deepStrictEqual({
			simple: formatMcpServerArgs(['-y', '@scope/server', '/tmp']),
			withSpaces: formatMcpServerArgs(['--path', 'My Documents', '']),
			parsedSimple: parseMcpServerArgs('  -y   @scope/server /tmp '),
			parsedJson: parseMcpServerArgs('["--path", "My Documents", ""]'),
			parsedEmpty: parseMcpServerArgs('   '),
			invalidJson: parseMcpServerArgs('[1, 2]').error !== undefined,
		}, {
			simple: '-y @scope/server /tmp',
			withSpaces: '["--path","My Documents",""]',
			parsedSimple: { args: ['-y', '@scope/server', '/tmp'] },
			parsedJson: { args: ['--path', 'My Documents', ''] },
			parsedEmpty: { args: [] },
			invalidJson: true,
		});
	});

	test('local server edits preserve fields the form does not manage', () => {
		const original: IMcpServerConfiguration = {
			type: McpServerType.LOCAL,
			command: 'npx',
			args: ['-y', 'server'],
			env: { PORT: 3000, UNSET: null, TOKEN: '${input:token}' },
			sandboxEnabled: true,
			gallery: 'https://gallery/server',
		};
		const state = toMcpServerFormState(original);
		state.args = '-y server --verbose';
		state.env.push({ name: 'DEBUG', value: '1' }, { name: '', value: '' });
		state.cwd = '${workspaceFolder}';

		assert.deepStrictEqual(toMcpServerConfiguration(state, original), {
			type: McpServerType.LOCAL,
			command: 'npx',
			args: ['-y', 'server', '--verbose'],
			cwd: '${workspaceFolder}',
			env: { PORT: 3000, UNSET: null, TOKEN: '${input:token}', DEBUG: '1' },
			sandboxEnabled: true,
			gallery: 'https://gallery/server',
		});
	});

	test('switching to SSE keeps common fields and drops local ones', () => {
		const original: IMcpServerConfiguration = { type: McpServerType.LOCAL, command: 'node', args: ['server.js'], sandboxEnabled: true, version: '1.0.0' };
		const state = toMcpServerFormState(original);
		state.kind = McpServerFormKind.Sse;
		state.url = 'https://example.com/sse';
		state.headers = [{ name: 'Authorization', value: 'Bearer ${input:token}' }];

		assert.deepStrictEqual(toMcpServerConfiguration(state, original), {
			type: McpServerType.REMOTE,
			version: '1.0.0',
			url: 'https://example.com/sse',
			transport: 'sse',
			headers: { Authorization: 'Bearer ${input:token}' },
		});
	});

	test('grpc servers round trip binding and TLS and keep fields the form does not manage', () => {
		const original: IMcpServerConfiguration = {
			type: McpServerType.GRPC,
			url: 'grpcs://localhost:50051',
			headers: { Authorization: 'Bearer ${input:token}' },
			binding: 'tunnel',
			tls: { ca: '/certs/ca.pem', insecure: true },
			deadlineMs: 60000,
			keepAliveMs: 30000,
			oauth: { clientId: 'client' },
			protocolVersion: '2026-07-28',
		};
		const state = toMcpServerFormState(original);
		const initial = { ...state };
		state.binding = undefined;
		state.tlsCa = '';
		state.tlsInsecure = false;
		state.tlsServerName = ' mcp.internal ';

		assert.deepStrictEqual({
			initial: { kind: initial.kind, url: initial.url, binding: initial.binding, tlsCa: initial.tlsCa, tlsInsecure: initial.tlsInsecure, tlsServerName: initial.tlsServerName },
			unchanged: toMcpServerConfiguration(toMcpServerFormState(original), original),
			edited: toMcpServerConfiguration(state, original),
		}, {
			initial: { kind: McpServerFormKind.Grpc, url: 'grpcs://localhost:50051', binding: 'tunnel', tlsCa: '/certs/ca.pem', tlsInsecure: true, tlsServerName: '' },
			unchanged: original,
			edited: {
				type: McpServerType.GRPC,
				url: 'grpcs://localhost:50051',
				headers: { Authorization: 'Bearer ${input:token}' },
				tls: { serverName: 'mcp.internal' },
				deadlineMs: 60000,
				keepAliveMs: 30000,
				oauth: { clientId: 'client' },
				protocolVersion: '2026-07-28',
			},
		});
	});

	test('switching between HTTP and grpc keeps headers, OAuth and the protocol pin', () => {
		const http: IMcpServerConfiguration = { type: McpServerType.REMOTE, url: 'https://example.com/mcp', headers: { A: '1' }, oauth: { clientId: 'client' }, protocolVersion: '2025-11-25' };
		const toGrpc = toMcpServerFormState(http);
		toGrpc.kind = McpServerFormKind.Grpc;
		toGrpc.url = 'grpc://localhost:50051';
		toGrpc.binding = 'typed';

		const grpc: IMcpServerConfiguration = { type: McpServerType.GRPC, url: 'grpc://localhost:50051', binding: 'typed', tls: { insecure: true }, oauth: { clientId: 'client' } };
		const toHttp = toMcpServerFormState(grpc);
		toHttp.kind = McpServerFormKind.Http;
		toHttp.url = 'https://example.com/mcp';

		assert.deepStrictEqual({
			grpc: toMcpServerConfiguration(toGrpc, http),
			http: toMcpServerConfiguration(toHttp, grpc),
		}, {
			grpc: { type: McpServerType.GRPC, url: 'grpc://localhost:50051', headers: { A: '1' }, oauth: { clientId: 'client' }, protocolVersion: '2025-11-25', binding: 'typed' },
			http: { type: McpServerType.REMOTE, url: 'https://example.com/mcp', oauth: { clientId: 'client' } },
		});
	});

	test('validation requires a grpc:// or grpcs:// URL for grpc servers', () => {
		const validate = (url: string) => validateMcpServerFormState(toMcpServerFormState({ type: McpServerType.GRPC, url })).url !== undefined;
		assert.deepStrictEqual(
			['grpc://localhost:50051', 'GRPCS://example.com', '${input:url}', 'https://example.com/mcp', 'grpc:/missing', ''].map(validate),
			[false, false, false, true, true, true],
		);
	});

	test('grpc is only offered, and its options only stored, by the VS Code format', () => {
		const grpc: IMcpServerConfiguration = { type: McpServerType.GRPC, url: 'grpc://localhost:50051' };
		const http: IMcpServerConfiguration = { type: McpServerType.REMOTE, url: 'https://example.com/mcp' };
		assert.deepStrictEqual({
			kinds: [McpResourceFormat.Vscode, McpResourceFormat.WorkspaceRoot, McpResourceFormat.CopilotGlobal].map(format => {
				const capabilities = getMcpServerFormCapabilities(format);
				return { grpc: capabilities.kinds.includes(McpServerFormKind.Grpc), grpcOptions: capabilities.grpcOptions };
			}),
			vscodeError: getMcpServerFormatError('server', http, grpc, McpResourceFormat.Vscode),
			workspaceRootError: getMcpServerFormatError('server', http, grpc, McpResourceFormat.WorkspaceRoot) !== undefined,
			copilotGlobalError: getMcpServerFormatError('server', http, grpc, McpResourceFormat.CopilotGlobal) !== undefined,
		}, {
			kinds: [{ grpc: true, grpcOptions: true }, { grpc: false, grpcOptions: false }, { grpc: false, grpcOptions: false }],
			vscodeError: undefined,
			workspaceRootError: true,
			copilotGlobalError: true,
		});
	});

	test('file format checks only consider the edit', () => {
		const previous: IMcpServerConfiguration = { type: McpServerType.LOCAL, command: 'node', cwd: '/work' };
		assert.deepStrictEqual({
			unchangedCwd: getMcpServerFormatError('server', previous, { ...previous, env: { A: '1' } }, McpResourceFormat.WorkspaceRoot),
			changedCwd: getMcpServerFormatError('server', previous, { ...previous, cwd: '/other' }, McpResourceFormat.WorkspaceRoot) !== undefined,
			emptyCommand: getMcpServerFormatError('server', previous, { ...previous, command: ' ' }, McpResourceFormat.CopilotGlobal) !== undefined,
			inputVariable: getMcpServerFormatError('server', previous, { ...previous, env: { A: '${input:a}' } }, McpResourceFormat.CopilotGlobal) !== undefined,
			unchangedInputVariable: getMcpServerFormatError('server', { ...previous, env: { A: '${input:a}', B: '1' } }, { ...previous, env: { A: '${input:a}', B: '2' } }, McpResourceFormat.CopilotGlobal),
			unchangedInputArgument: getMcpServerFormatError('server', { ...previous, args: ['${input:a}'] }, { ...previous, args: ['${input:a}', '--verbose'] }, McpResourceFormat.CopilotGlobal),
			duplicatedInputArgument: getMcpServerFormatError('server', { ...previous, args: ['${input:a}'] }, { ...previous, args: ['${input:a}', '${input:a}'] }, McpResourceFormat.CopilotGlobal) !== undefined,
		}, {
			unchangedCwd: undefined,
			changedCwd: true,
			emptyCommand: true,
			inputVariable: true,
			unchangedInputVariable: undefined,
			unchangedInputArgument: undefined,
			duplicatedInputArgument: true,
		});
	});

	test('merging rows keeps the user\'s edits and takes every other change from the file', () => {
		const base = toMcpServerFormState({ type: McpServerType.LOCAL, command: 'node', env: { EDITED: '1', UNTOUCHED: '1', REMOVED_LOCALLY: '1', REMOVED_REMOTELY: '1', RENAMED: '1' } }).env;
		const local = base.map(row => ({ ...row }));
		local[0].value = 'mine';
		local[4].name = 'RENAMED_LOCALLY';
		local.splice(2, 1);
		local.push({ name: 'ADDED_LOCALLY', value: '1' });
		const remote = toMcpServerFormState({ type: McpServerType.LOCAL, command: 'node', env: { EDITED: 'theirs', UNTOUCHED: 'theirs', REMOVED_LOCALLY: 'theirs', RENAMED: 'theirs', ADDED_REMOTELY: '1', ADDED_LOCALLY: 'theirs' } }).env;

		assert.deepStrictEqual(mergeMcpServerFormKeyValues(base, local, remote).map(({ name, value }) => [name, value]), [
			['EDITED', 'mine'],
			['UNTOUCHED', 'theirs'],
			['RENAMED_LOCALLY', '1'],
			['ADDED_LOCALLY', '1'],
			['ADDED_REMOTELY', '1'],
		]);
	});

	test('validation reports missing and duplicate values', () => {
		const local = toMcpServerFormState({ type: McpServerType.LOCAL, command: '' });
		local.args = '[oops';
		local.env = [{ name: 'A', value: '1' }, { name: 'A', value: '2' }];

		const remote = toMcpServerFormState({ type: McpServerType.REMOTE, url: 'ftp://example.com' });
		remote.headers = [{ name: '', value: 'x' }];

		assert.deepStrictEqual({
			local: Object.keys(validateMcpServerFormState(local)),
			remote: Object.keys(validateMcpServerFormState(remote)),
			valid: validateMcpServerFormState(toMcpServerFormState({ type: McpServerType.REMOTE, url: 'https://example.com/mcp' })),
		}, {
			local: ['command', 'args', 'env'],
			remote: ['url', 'headers'],
			valid: {},
		});
	});
});
