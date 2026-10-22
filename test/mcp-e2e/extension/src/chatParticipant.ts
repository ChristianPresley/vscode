/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { mcpToolId, mcpToolNameOf, mcpToolsOf, resultToText, runAgent, vscodeAgentTools } from './agent';
import { appendJsonLine } from './config';
import { E2eHarness } from './harness';
import { log } from './runner';

/**
 * The chat participant `@e2e` (stable API `vscode.chat.createChatParticipant`, contribution
 * `chatParticipants`): MCP tool calls made from a chat request, with the request's
 * `toolInvocationToken`, so the chat view shows them as tool invocations of that request. It needs
 * no Copilot sign-in: `call` uses no model, `ask` uses the llama.cpp model.
 *
 * - `@e2e /call <server> <tool> [<JSON object>]`: calls one tool of a server directly
 *   (`vscode.lm.invokeTool`, no model) and shows its result. Without arguments the input is `{}`.
 * - `@e2e /ask [<server>] <task>`: the llama agent loop (agent.ts) with the tools referenced with
 *   `#` in the request, or else every MCP tool of `<server>`; the model picks the calls.
 * - `@e2e /tools <server>`: lists the MCP tools of a server (the names `/call` takes).
 *
 * The command may also be the first word without the slash (`@e2e call zig-stdio ...`). `<server>`
 * is a label of config/servers.json; a server that is not running is started first.
 */

/** The participant's id (package.json `chatParticipants`) and the name users address it with. */
export const CHAT_PARTICIPANT_ID = 'mcp-e2e.e2e';
export const CHAT_PARTICIPANT_NAME = 'e2e';

/** One MCP tool call the participant made for a chat request. */
export interface IChatToolCallRecord {
	readonly server: string | undefined;
	readonly tool: string;
	readonly toolId: string;
	readonly input: unknown;
	readonly resultText: string;
	readonly error?: string;
}

/** What the participant did for one chat request (also appended to `chat-requests.jsonl` of the results). */
export interface IChatRequestRecord {
	readonly time: string;
	readonly command: string;
	readonly prompt: string;
	/** Whether the request carried a `toolInvocationToken` (its tool calls then belong to the request). */
	readonly hasToolInvocationToken: boolean;
	readonly toolReferences: readonly string[];
	readonly model: string;
	readonly server?: string;
	readonly calls: readonly IChatToolCallRecord[];
	readonly answer?: string;
	readonly error?: string;
}

/** The requests the participant handled in this extension host, in order (the API suite's smoke test reads them). */
export const chatRequests: IChatRequestRecord[] = [];

const USAGE = [
	'`@e2e` calls MCP tools for the end-to-end tests:',
	'',
	'- `/call <server> <tool> [<JSON object>]`: call one tool directly (no model), for example `/call zig-stdio greet {"name": "Ada"}`',
	'- `/ask [<server>] <task>`: the llama.cpp model calls the tools referenced with `#`, or else the MCP tools of `<server>`',
	'- `/tools <server>`: list the MCP tools of a server',
].join('\n');

class UsageError extends Error { }

/** The command (the slash command, or else the first word) and the rest of the prompt. */
function parseRequest(request: vscode.ChatRequest): { command: string; args: string } {
	if (request.command) {
		return { command: request.command, args: request.prompt.trim() };
	}
	const match = /^\s*\/?(\S+)\s*([\s\S]*)$/.exec(request.prompt);
	return { command: match?.[1] ?? '', args: match?.[2].trim() ?? '' };
}

export function registerChatParticipant(harness: E2eHarness): vscode.Disposable {
	const isServer = (label: string) => harness.servers.some(s => s.label === label);

	/** The MCP tools of a server, which is started when it has none yet. */
	const toolsOf = async (server: string, stream: vscode.ChatResponseStream): Promise<vscode.LanguageModelToolInformation[]> => {
		if (!isServer(server)) {
			throw new UsageError(`Unknown server \`${server}\`; the servers are ${harness.servers.map(s => `\`${s.label}\``).join(', ')}.`);
		}
		let tools = mcpToolsOf(server);
		if (!tools.length) {
			stream.progress(`Starting ${server}`);
			await harness.startServer(server, 60_000);
			tools = mcpToolsOf(server);
		}
		if (!tools.length) {
			throw new Error(`${server} has no tools (it did not start).`);
		}
		return tools;
	};

	const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
		const { command, args } = parseRequest(request);
		const calls: IChatToolCallRecord[] = [];
		const record = (fields: { server?: string; answer?: string; error?: string }): IChatRequestRecord => {
			const entry: IChatRequestRecord = {
				time: new Date().toISOString(),
				command,
				prompt: request.prompt,
				hasToolInvocationToken: request.toolInvocationToken !== undefined,
				toolReferences: request.toolReferences.map(r => r.name),
				model: `${request.model.vendor}/${request.model.id}`,
				calls,
				...fields,
			};
			chatRequests.push(entry);
			appendJsonLine(path.join(harness.env.resultsDir, 'chat-requests.jsonl'), entry);
			log(`@${CHAT_PARTICIPANT_NAME} ${command} ${args.slice(0, 120)}: ${fields.error ? `error ${fields.error}` : `${calls.length} call(s)`}`);
			return entry;
		};
		let server: string | undefined;
		try {
			switch (command) {
				case 'call': {
					const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(args);
					if (!match) {
						throw new UsageError('Usage: `/call <server> <tool> [<JSON object>]`');
					}
					server = match[1];
					const tool = match[2];
					let input: unknown;
					try {
						input = JSON.parse(match[3] ?? '{}');
					} catch (e) {
						throw new UsageError(`The arguments of \`${tool}\` are not JSON: ${e instanceof Error ? e.message : String(e)}`);
					}
					if (typeof input !== 'object' || input === null || Array.isArray(input)) {
						throw new UsageError(`The arguments of \`${tool}\` must be a JSON object.`);
					}
					const tools = await toolsOf(server, stream);
					const toolId = mcpToolId(tools, tool);
					if (!toolId) {
						throw new UsageError(`\`${server}\` has no tool \`${tool}\`; it has ${tools.map(t => `\`${mcpToolNameOf(t)}\``).join(', ')}.`);
					}
					stream.progress(`Calling ${tool} on ${server}`);
					try {
						const result = await vscode.lm.invokeTool(toolId, { input, toolInvocationToken: request.toolInvocationToken }, token);
						const resultText = resultToText(result);
						calls.push({ server, tool, toolId, input, resultText });
						stream.markdown(`\`${tool}\` on \`${server}\` returned:\n\n`);
						stream.markdown(new vscode.MarkdownString().appendCodeblock(resultText, 'text'));
					} catch (e) {
						calls.push({ server, tool, toolId, input, resultText: '', error: e instanceof Error ? e.message : String(e) });
						throw e;
					}
					record({ server });
					return { metadata: { command, server, calls } };
				}
				case 'ask': {
					const first = /^(\S+)\s*([\s\S]*)$/.exec(args);
					server = first && isServer(first[1]) ? first[1] : undefined;
					const task = server ? first![2].trim() : args;
					const referenced = request.toolReferences.map(r => vscode.lm.tools.find(t => t.name === r.name)).filter((t): t is vscode.LanguageModelToolInformation => !!t);
					const tools = referenced.length ? referenced : server ? await toolsOf(server, stream) : [];
					if (!tools.length || !task) {
						throw new UsageError('Usage: `/ask [<server>] <task>`, with the tools referenced with `#` or else a server whose tools the model may call.');
					}
					stream.progress(`Asking the llama.cpp model with ${tools.length} tool(s)`);
					const run = await runAgent(harness.env, task, { tools: vscodeAgentTools(tools, request.toolInvocationToken), label: `chat:${server ?? 'references'}`, token });
					calls.push(...run.calls.map(c => ({ server: c.serverLabel, tool: c.toolName, toolId: c.toolId, input: c.input, resultText: c.resultText, error: c.error })));
					stream.markdown(run.answer || '(the model gave no answer)');
					record({ server, answer: run.answer });
					return { metadata: { command, server, calls, answer: run.answer } };
				}
				case 'tools': {
					server = args.split(/\s+/)[0];
					if (!server) {
						throw new UsageError('Usage: `/tools <server>`');
					}
					const names = (await toolsOf(server, stream)).map(mcpToolNameOf).sort();
					stream.markdown(`\`${server}\` has ${names.length} tools:\n\n${names.map(n => `- \`${n}\``).join('\n')}\n`);
					record({ server });
					return { metadata: { command, server, tools: names } };
				}
				default:
					throw new UsageError(USAGE);
			}
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			if (e instanceof UsageError) {
				stream.markdown(message);
			}
			record({ server, error: message });
			return e instanceof UsageError ? { metadata: { command, error: message } } : { errorDetails: { message }, metadata: { command, server, calls, error: message } };
		}
	};

	const participant = vscode.chat.createChatParticipant(CHAT_PARTICIPANT_ID, handler);
	participant.iconPath = new vscode.ThemeIcon('beaker');
	return participant;
}
