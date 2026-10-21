/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { E2eHarness, waitFor } from './harness';
import { LLAMA_MODEL_ID, LLAMA_VENDOR } from './llamaProvider';
import { describeWireCalls, IWireEvent, lastInputResponses } from './mcpLog';
import { assert, ITestCase } from './runner';
import { expectToolText, TYPED_CALL_TOOL, wireCallSucceeded } from './testHelpers';

/**
 * Multi round-trip requests (input_required) without UI: sampling answered by the llama provider
 * and roots, over every transport that carries them (stdio, Streamable HTTP, the gRPC tunnel and
 * the typed binding). The tools are called directly; the model only answers the sampling request.
 */

export function samplingTest(h: E2eHarness, label: string): ITestCase {
	return {
		name: `mrtr sampling (${label}): test_input_required_result_sampling is answered by the llama provider`,
		group: h.server(label).grpc ? 'grpc' : 'mrtr',
		fn: async ctx => {
			const before = h.llamaRequests().length;
			const call = await expectToolText(h, ctx, label, 'test_input_required_result_sampling', {}, ['The model (']);
			const said = /The model \((.+?)\) said: ([\s\S]*)/.exec(call.text);
			ctx.details.samplingModel = said?.[1];
			assert(said?.[1].includes(LLAMA_MODEL_ID), `the sampling model was ${said?.[1]}, expected ${LLAMA_VENDOR}/${LLAMA_MODEL_ID}`);
			assert(/paris/i.test(said?.[2] ?? ''), `the sampled answer does not name Paris: ${JSON.stringify(said?.[2])}`);
			const sampled = h.llamaRequests().slice(before).filter(r => JSON.stringify(r.messages).includes('What is the capital of France?'));
			ctx.details.samplingRequests = sampled.map(r => ({ seq: r.seq, messages: r.messages, content: r.content }));
			assert(sampled.length >= 1, 'llama.cpp never received the sampling prompt "What is the capital of France?"');
		},
	};
}

/** The roots test; for a server behind runner/grpc-log-proxy.ts with the typed binding also the two CallTool RPCs. */
export function rootsTest(h: E2eHarness, label: string): ITestCase {
	const server = h.server(label);
	const typed = server.transport === 'grpc-typed';
	return {
		name: `mrtr roots (${label}): test_input_required_result_list_roots gets the opened workspace folder as the only root${typed ? ', in two typed CallTool RPCs without a deadline' : ''}`,
		group: server.grpc ? 'grpc' : 'mrtr',
		fn: async ctx => {
			const folders = vscode.workspace.workspaceFolders ?? [];
			ctx.details.workspaceFolders = folders.map(f => f.uri.toString());
			assert(folders.length === 1, `expected one workspace folder, the window has ${JSON.stringify(ctx.details.workspaceFolders)}`);
			const folder = folders[0];
			if (h.env.workspace) {
				assert(folder.uri.toString() === vscode.Uri.file(h.env.workspace).toString(), `the window's folder ${folder.uri.toString()} is not the workspace the run opened (${h.env.workspace})`);
			}
			await h.requireServer(label);
			const from = h.serverLog(label).length;
			const wireBefore = typed ? h.wireLog(label).length : 0;
			await expectToolText(h, ctx, label, 'test_input_required_result_list_roots', {}, ['The client has 1 root(s)']);
			// The tool only reports the count; the roots themselves are in the retry VS Code sent.
			const roots = await h.waitForLog(label, 'the roots/list answer in the tools/call retry', log => {
				const answer = lastInputResponses(log, 'test_input_required_result_list_roots', from)?.client_roots as { roots?: { uri?: string; name?: string }[] } | undefined;
				return answer?.roots ? { ok: true as const, details: answer.roots } : { ok: false as const, reason: `no inputResponses.client_roots.roots in a tools/call retry (${JSON.stringify(answer)})` };
			});
			ctx.details.roots = roots;
			assert(roots.length === 1 && roots[0].uri === folder.uri.toString(), `VS Code answered roots/list with ${JSON.stringify(roots)}, expected the one root ${folder.uri.toString()}`);
			assert(roots[0].name === folder.name, `the root is named ${JSON.stringify(roots[0].name)}, expected the folder name ${JSON.stringify(folder.name)}`);
			if (typed) {
				const isCall = (e: IWireEvent) => e.event === 'call' && e.path === TYPED_CALL_TOOL && (e.metadata?.['mcp-name'] ?? e.metadata?.mcp_tool) === 'test_input_required_result_list_roots';
				const wire = await waitFor('the two CallTool RPCs of the tool in the wire log', 10_000, () => {
					const events = h.wireLog(label);
					return events.slice(wireBefore).filter(e => isCall(e) && wireCallSucceeded(events, e)).length >= 2 ? events : undefined;
				}, 250).catch(() => h.wireLog(label));
				const calls = wire.slice(wireBefore).filter(isCall);
				ctx.details.wireCalls = describeWireCalls(wire.slice(wireBefore));
				assert(calls.length === 2 && calls.every(c => wireCallSucceeded(wire, c)), `expected two successful CallTool RPCs (the input round and the retry), got ${calls.length}: ${JSON.stringify(ctx.details.wireCalls)}`);
				const deadlines = calls.map(c => c.metadata?.['grpc-timeout']);
				assert(deadlines.every(d => d === undefined), `a tools/call (or its MRTR retry) carried a deadline: ${JSON.stringify(deadlines)}`);
			}
		},
	};
}
