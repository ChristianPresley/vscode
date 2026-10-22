/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { appendJsonLine, IE2eEnvironment } from './config';
import { describeDataPart, LLAMA_VENDOR } from './llamaProvider';

/** One tool call of an agent run, with what the tool returned. */
export interface IAgentToolCall {
	readonly toolId: string;
	/** The tool name as the MCP server published it (the id without the server prefix). */
	readonly toolName: string;
	/** The mcp.json label of the server that published the tool, when VS Code reports it. */
	readonly serverLabel: string | undefined;
	readonly input: object;
	readonly resultText: string;
	readonly result: vscode.LanguageModelToolResult | undefined;
	readonly error: string | undefined;
}

export interface IAgentRun {
	readonly task: string;
	readonly answer: string;
	readonly calls: readonly IAgentToolCall[];
	readonly turns: number;
}

/** A tool offered to the model in an agent run: what the model sees, and how a call of it runs. */
export interface IAgentTool {
	/** The name the model sees and calls (VS Code's tool id, or the MCP name of a gateway tool). */
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object | undefined;
	/** The tool name as the MCP server published it. */
	readonly toolName: string;
	/** The mcp.json label of the server that published the tool (behind a gateway route: the upstream). */
	readonly serverLabel: string | undefined;
	invoke(input: object, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult>;
}

/**
 * VS Code's tools, each call made with `vscode.lm.invokeTool`. With the `toolInvocationToken` of a
 * chat request the calls belong to that request (the chat view shows them); without one they run
 * outside chat.
 */
export function vscodeAgentTools(tools: readonly vscode.LanguageModelToolInformation[], toolInvocationToken?: vscode.ChatParticipantToolToken): IAgentTool[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		toolName: mcpToolNameOf(tool),
		serverLabel: serverLabelOf(tool),
		invoke: (input, token) => vscode.lm.invokeTool(tool.name, { input, toolInvocationToken }, token),
	}));
}

export interface IAgentOptions {
	/** The tools offered to the model (MCP tools of one server, usually; see {@link vscodeAgentTools}). */
	readonly tools: readonly IAgentTool[];
	readonly maxTurns?: number;
	/** Require a tool call on the first turn (the model still picks which tool). Default true. */
	readonly requireToolOnFirstTurn?: boolean;
	readonly token?: vscode.CancellationToken;
	/** A label for the transcript file. */
	readonly label: string;
}

const SYSTEM_PREAMBLE = [
	'You are an automated test agent inside VS Code.',
	'Use exactly the tools that answer the task, call each one at most once, and pass only the arguments the task asks for.',
	'After the tool results arrive, answer in one or two short sentences and quote the relevant tool output verbatim.',
].join(' ');

/** The MCP server label of a tool: `source` (chatParticipantAdditions) is filled in for extensions with the chatParticipantPrivate proposal. */
export function serverLabelOf(tool: vscode.LanguageModelToolInformation): string | undefined {
	const source = tool.source;
	return source instanceof vscode.LanguageModelToolMCPSource ? source.label : undefined;
}

/** The MCP tools VS Code currently exposes for the server with this mcp.json label. */
export function mcpToolsOf(serverLabel: string): vscode.LanguageModelToolInformation[] {
	return vscode.lm.tools.filter(t => t.tags.includes('mcp') && serverLabelOf(t) === serverLabel);
}

/**
 * The tool name as the MCP server published it. `fullReferenceName` (chatParticipantPrivate) is
 * `<server>/<tool>`; the tool id is `mcp_<server prefix>_<tool>`, where the prefix comes from the
 * server's announced name and can itself contain underscores.
 */
export function mcpToolNameOf(tool: vscode.LanguageModelToolInformation): string {
	const full = tool.fullReferenceName;
	return full && full.includes('/') ? full.slice(full.lastIndexOf('/') + 1) : tool.name;
}

/** The tool id prefix VS Code chose for a server (`mcp_<name>_`), derived from one of its tools. */
export function toolPrefixOf(tools: readonly vscode.LanguageModelToolInformation[]): string | undefined {
	for (const tool of tools) {
		const name = mcpToolNameOf(tool);
		if (name !== tool.name && tool.name.endsWith(name)) {
			return tool.name.slice(0, tool.name.length - name.length);
		}
	}
	return undefined;
}

/** The tool id VS Code gives an MCP tool of a server (`<prefix><tool name>`). */
export function mcpToolId(tools: readonly vscode.LanguageModelToolInformation[], mcpName: string): string | undefined {
	return tools.find(t => mcpToolNameOf(t) === mcpName)?.name;
}

export function resultToText(result: vscode.LanguageModelToolResult | undefined): string {
	if (!result) {
		return '';
	}
	return result.content.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			return describeDataPart(part);
		}
		if (part instanceof vscode.LanguageModelPromptTsxPart) {
			return JSON.stringify(part.value);
		}
		return '';
	}).join('\n');
}

export async function selectLlamaModel(): Promise<vscode.LanguageModelChat> {
	const models = await vscode.lm.selectChatModels({ vendor: LLAMA_VENDOR });
	if (!models.length) {
		throw new Error(`vscode.lm.selectChatModels({ vendor: '${LLAMA_VENDOR}' }) returned no model`);
	}
	return models[0];
}

/**
 * The agent loop: the user task and the given tools go to the llama model;
 * every tool call it makes is executed with `vscode.lm.invokeTool` and the
 * results are fed back until the model answers without calling a tool.
 */
export async function runAgent(env: IE2eEnvironment, task: string, options: IAgentOptions): Promise<IAgentRun> {
	const model = await selectLlamaModel();
	const token = options.token ?? new vscode.CancellationTokenSource().token;
	const maxTurns = options.maxTurns ?? 4;
	const byName = new Map(options.tools.map(t => [t.name, t]));
	const chatTools: vscode.LanguageModelChatTool[] = options.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
	const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(`${SYSTEM_PREAMBLE}\n\nTask: ${task}`)];
	const calls: IAgentToolCall[] = [];
	const transcript = path.join(env.resultsDir, 'agent-transcripts.jsonl');

	for (let turn = 1; turn <= maxTurns; turn++) {
		const toolMode = turn === 1 && options.requireToolOnFirstTurn !== false ? vscode.LanguageModelChatToolMode.Required : vscode.LanguageModelChatToolMode.Auto;
		// The last turn gets no tools, so the model has to answer.
		const response = await model.sendRequest(messages, { tools: turn < maxTurns ? chatTools : undefined, toolMode, justification: 'MCP end-to-end test' }, token);
		const textParts: vscode.LanguageModelTextPart[] = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push(part);
			}
		}
		messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]));

		if (!toolCalls.length) {
			const run: IAgentRun = { task, answer: textParts.map(p => p.value).join('').trim(), calls, turns: turn };
			appendJsonLine(transcript, { label: options.label, task, answer: run.answer, turns: turn, calls: calls.map(c => ({ toolId: c.toolId, serverLabel: c.serverLabel, input: c.input, resultText: c.resultText, error: c.error })) });
			return run;
		}

		const results: vscode.LanguageModelToolResultPart[] = [];
		for (const call of toolCalls) {
			const tool = byName.get(call.name);
			let result: vscode.LanguageModelToolResult | undefined;
			let error: string | undefined;
			try {
				if (!tool) {
					throw new Error(`The model called '${call.name}', which is not one of the offered tools`);
				}
				result = await tool.invoke(call.input, token);
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			calls.push({
				toolId: call.name,
				toolName: tool?.toolName ?? call.name,
				serverLabel: tool?.serverLabel,
				input: call.input,
				resultText: resultToText(result),
				result,
				error,
			});
			results.push(new vscode.LanguageModelToolResultPart(call.callId, result ? result.content : [new vscode.LanguageModelTextPart(`Error: ${error}`)]));
		}
		messages.push(vscode.LanguageModelChatMessage.User(results));
	}
	throw new Error(`The model did not answer within ${maxTurns} turns`);
}
