/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CHAT_PARTICIPANT_NAME, chatRequests, IChatRequestRecord } from './chatParticipant';
import { E2eHarness, waitFor } from './harness';
import { LLAMA_MODEL_ID, LLAMA_VENDOR } from './llamaProvider';
import { loggedMessages } from './mcpLog';
import { assert, ITestCase, ITestContext } from './runner';
import { errorText } from './testHelpers';

/**
 * Smoke tests of the `@e2e` chat participant (chatParticipant.ts) through the chat view: a request
 * typed into the chat input and submitted, with the llama model selected, reaches the participant,
 * whose tool calls carry the request's toolInvocationToken. The UI suite screenshots the same.
 */

/**
 * Puts the query into the chat view's input (Ask mode, the llama model) and submits it, then waits
 * for the participant's record of the request. The query is not submitted by `chat.open` itself:
 * that waits for a default chat agent, which only a signed-in Copilot provides.
 */
async function sendChatRequest(ctx: ITestContext, query: string, timeoutMs: number): Promise<IChatRequestRecord> {
	const before = chatRequests.length;
	const steps: Record<string, unknown> = {};
	ctx.details.chat = steps;
	const step = async (name: string, command: string, ...args: unknown[]) => {
		try {
			await vscode.commands.executeCommand(command, ...args);
			steps[name] = 'ok';
		} catch (e) {
			steps[name] = errorText(e);
			throw new Error(`${command} failed: ${errorText(e)}`);
		}
	};
	await step('newChat', 'workbench.action.chat.newChat');
	await step('open', 'workbench.action.chat.open', { query, isPartialQuery: true, mode: 'ask', modelSelector: { vendor: LLAMA_VENDOR, id: LLAMA_MODEL_ID } });
	await step('submit', 'workbench.action.chat.submit');
	const record = await waitFor(`the @${CHAT_PARTICIPANT_NAME} participant's record of ${JSON.stringify(query)}`, timeoutMs, () => chatRequests.slice(before)[0], 250);
	ctx.details.record = record;
	return record;
}

/** VS Code's `tools/call` of `tool` to a server after `fromOffset` of its MCP log. */
function sentToolCall(logText: string, fromOffset: number, tool: string): boolean {
	return loggedMessages(logText, fromOffset).some(m => m.direction === 'sent' && m.message.method === 'tools/call' && m.message.params?.name === tool);
}

export function chatTests(h: E2eHarness): ITestCase[] {
	const label = 'zig-stdio';
	const model = `${LLAMA_VENDOR}/${LLAMA_MODEL_ID}`;
	return [
		{
			name: `chat participant (@${CHAT_PARTICIPANT_NAME} /call ${label} test_simple_text {}): a request submitted in the chat view with the llama model reaches the participant, which calls the tool with vscode.lm.invokeTool and the request's toolInvocationToken, and answers with its text`,
			group: 'chat',
			fn: async ctx => {
				await h.requireServer(label);
				const from = h.serverLog(label).length;
				const record = await sendChatRequest(ctx, `@${CHAT_PARTICIPANT_NAME} /call ${label} test_simple_text {}`, 60_000);
				assert(!record.error, `the participant failed: ${record.error}`);
				assert(record.command === 'call' && record.server === label, `the participant parsed ${JSON.stringify({ command: record.command, server: record.server })}`);
				assert(record.model === model, `the request came with the model ${record.model}, expected ${model}`);
				assert(record.hasToolInvocationToken, 'the chat request carried no toolInvocationToken');
				assert(record.calls.length === 1 && record.calls[0].tool === 'test_simple_text' && record.calls[0].resultText.includes('This is a simple text response'), `the participant's calls: ${JSON.stringify(record.calls)}`);
				await h.waitForLog(label, 'the participant\'s tools/call of test_simple_text', logText => sentToolCall(logText, from, 'test_simple_text')
					? { ok: true as const, details: true }
					: { ok: false as const, reason: 'no tools/call of test_simple_text after the chat request' });
			},
		},
		{
			name: `chat participant (@${CHAT_PARTICIPANT_NAME} /ask ${label} ...): the llama agent loop of a chat request picks test_simple_text among the tools of the server, calls it with the request's toolInvocationToken, and the answer quotes its text`,
			group: 'chat',
			fn: async ctx => {
				await h.requireServer(label);
				const from = h.serverLog(label).length;
				const record = await sendChatRequest(ctx, `@${CHAT_PARTICIPANT_NAME} /ask ${label} Call the tool named test_simple_text (it takes no arguments) and tell me exactly what text it returned.`, 120_000);
				assert(!record.error, `the participant failed: ${record.error}`);
				assert(record.command === 'ask' && record.server === label, `the participant parsed ${JSON.stringify({ command: record.command, server: record.server })}`);
				assert(record.hasToolInvocationToken, 'the chat request carried no toolInvocationToken');
				const call = record.calls.find(c => c.tool === 'test_simple_text' && c.server === label);
				assert(call && !call.error && call.resultText.includes('This is a simple text response'), `the model's calls: ${JSON.stringify(record.calls)}`);
				assert(/simple text response/i.test(record.answer ?? ''), `the answer does not quote the tool: ${JSON.stringify(record.answer)}`);
				await h.waitForLog(label, 'the model\'s tools/call of test_simple_text', logText => sentToolCall(logText, from, 'test_simple_text')
					? { ok: true as const, details: true }
					: { ok: false as const, reason: 'no tools/call of test_simple_text after the chat request' });
			},
		},
	];
}
