/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { appendJsonLine, IE2eEnvironment } from './config';

/** The vendor of the provider; `vscode.lm.selectChatModels({ vendor: LLAMA_VENDOR })` finds it. */
export const LLAMA_VENDOR = 'llamacpp';
/** The model id; VS Code's identifier for it is `llamacpp/qwen3-8b`. */
export const LLAMA_MODEL_ID = 'qwen3-8b';
/** The MIME type VS Code uses for an MCP resource link in a tool result. */
export const RESOURCE_LINK_MIME = 'application/vnd.code.resource-link';

/** An OpenAI chat-completions tool call. */
interface IOpenAiToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: { readonly name: string; readonly arguments: string };
}

/** An OpenAI chat-completions message. */
type OpenAiMessage =
	| { readonly role: 'system' | 'user'; readonly content: string }
	| { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: IOpenAiToolCall[] }
	| { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

interface IOpenAiTool {
	readonly type: 'function';
	readonly function: { readonly name: string; readonly description: string; readonly parameters: object };
}

interface IOpenAiResponse {
	readonly choices?: readonly {
		readonly finish_reason?: string;
		readonly message?: { readonly content?: string | null; readonly reasoning_content?: string | null; readonly tool_calls?: readonly IOpenAiToolCall[] };
	}[];
	readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
	readonly error?: { readonly message?: string };
}

/** One request the provider sent to llama.cpp, as written to `llama-requests.jsonl`. */
export interface ILlamaRequestRecord {
	readonly seq: number;
	readonly time: string;
	readonly ms: number;
	readonly messages: readonly OpenAiMessage[];
	readonly tools: readonly string[];
	readonly toolChoice: string;
	readonly content: string;
	readonly toolCalls: readonly { readonly name: string; readonly arguments: string }[];
	readonly finishReason: string | undefined;
	readonly error?: string;
}

function decodeData(part: vscode.LanguageModelDataPart): string {
	return new TextDecoder().decode(part.data);
}

/**
 * A text rendering of a data part for a text-only model: images become a
 * placeholder with their MIME type and size, resource links name the linked
 * resource (decoded from VS Code's `mcp-resource:` URI).
 */
export function describeDataPart(part: vscode.LanguageModelDataPart): string {
	if (part.mimeType === RESOURCE_LINK_MIME) {
		try {
			const link = JSON.parse(decodeData(part)) as { uri?: unknown; underlyingMimeType?: string };
			const uri = typeof link.uri === 'string' ? vscode.Uri.parse(link.uri) : vscode.Uri.from(link.uri as vscode.Uri);
			return `[resource ${originalResourceUri(uri)} (${link.underlyingMimeType ?? 'unknown type'})]`;
		} catch {
			return `[resource link]`;
		}
	}
	if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') {
		return decodeData(part);
	}
	return `[${part.mimeType.split('/')[0]} data, ${part.mimeType}, ${part.data.byteLength} bytes]`;
}

/** `mcp-resource://<hex id>/<scheme>/<authority>/<path>` back to `<scheme>://<authority>/<path>`. */
export function originalResourceUri(uri: vscode.Uri): string {
	if (uri.scheme !== 'mcp-resource') {
		return uri.toString(true);
	}
	const [, scheme, authority, ...rest] = uri.path.split('/');
	const host = authority === 'dylo78gyp' ? '' : authority;
	return `${scheme}://${host}${rest.length ? '/' + rest.join('/') : ''}`;
}

function toolResultText(content: readonly unknown[]): string {
	const out: string[] = [];
	for (const item of content) {
		if (item instanceof vscode.LanguageModelTextPart) {
			out.push(item.value);
		} else if (item instanceof vscode.LanguageModelDataPart) {
			out.push(describeDataPart(item));
		} else if (item instanceof vscode.LanguageModelPromptTsxPart) {
			out.push(JSON.stringify(item.value));
		}
	}
	return out.join('\n') || '(empty tool result)';
}

/** Maps the VS Code request messages to OpenAI chat-completions messages. */
export function toOpenAiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAiMessage[] {
	const out: OpenAiMessage[] = [];
	for (const message of messages) {
		const texts: string[] = [];
		const toolCalls: IOpenAiToolCall[] = [];
		const toolResults: OpenAiMessage[] = [];
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				texts.push(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({ role: 'tool', tool_call_id: part.callId, content: toolResultText(part.content) });
			} else if (part instanceof vscode.LanguageModelDataPart) {
				texts.push(describeDataPart(part));
			}
		}
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			out.push({ role: 'assistant', content: texts.join('') || null, tool_calls: toolCalls.length ? toolCalls : undefined });
		} else {
			out.push(...toolResults);
			if (texts.length) {
				// LanguageModelChatMessageRole.System (3) is a proposed role; anything that is not the user is a system prompt.
				out.push({ role: message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'system', content: texts.join('\n') });
			}
		}
	}
	return out;
}

function toOpenAiTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): IOpenAiTool[] | undefined {
	if (!tools?.length) {
		return undefined;
	}
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema && Object.keys(tool.inputSchema).length ? tool.inputSchema : { type: 'object', properties: {} },
		},
	}));
}

/** Qwen3 thinks in `<think>` blocks unless told not to; whatever is left of them is not part of the answer. */
function stripReasoning(content: string): string {
	return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function parseArguments(raw: string): object {
	if (!raw.trim()) {
		return {};
	}
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
}

/**
 * A {@link vscode.LanguageModelChatProvider} backed by llama.cpp's
 * OpenAI-compatible `/v1/chat/completions` endpoint, with tool calling.
 * Requests are not streamed; Qwen3's reasoning is turned off through
 * `chat_template_kwargs.enable_thinking` and the output is sampled
 * greedily so that runs are as repeatable as the model allows.
 */
export class LlamaChatProvider implements vscode.LanguageModelChatProvider {
	private _seq = 0;
	private readonly _logFile: string;

	constructor(private readonly _env: IE2eEnvironment) {
		this._logFile = path.join(_env.resultsDir, 'llama-requests.jsonl');
	}

	provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
		return [{
			id: LLAMA_MODEL_ID,
			name: 'Qwen3 8B (llama.cpp)',
			family: 'qwen3',
			version: 'Qwen3-8B-Q4_K_M',
			detail: 'llama.cpp',
			tooltip: `llama.cpp at ${this._env.llamaUrl}`,
			maxInputTokens: 12288,
			maxOutputTokens: 2048,
			capabilities: { toolCalling: true, imageInput: false },
		}];
	}

	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const seq = ++this._seq;
		const openAiMessages = toOpenAiMessages(messages);
		const tools = toOpenAiTools(options.tools);
		const toolChoice = tools ? (options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto') : 'none';
		const body = {
			model: model.id,
			messages: openAiMessages,
			tools,
			tool_choice: tools ? toolChoice : undefined,
			temperature: 0,
			seed: 42,
			max_tokens: Math.min(model.maxOutputTokens, 1024),
			chat_template_kwargs: { enable_thinking: false },
			stream: false,
		};

		const abort = new AbortController();
		const listener = token.onCancellationRequested(() => abort.abort());
		const started = Date.now();
		let response: IOpenAiResponse | undefined;
		let error: string | undefined;
		try {
			const res = await fetch(`${this._env.llamaUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: abort.signal,
			});
			const text = await res.text();
			try {
				response = JSON.parse(text) as IOpenAiResponse;
			} catch {
				error = `llama.cpp answered ${res.status} with a non-JSON body: ${text.slice(0, 500)}`;
			}
			if (!res.ok && !error) {
				error = `llama.cpp answered ${res.status}: ${response?.error?.message ?? text.slice(0, 500)}`;
			}
		} catch (e) {
			error = `llama.cpp request failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			listener.dispose();
		}

		const choice = response?.choices?.[0];
		const content = stripReasoning(choice?.message?.content ?? '');
		const toolCalls = choice?.message?.tool_calls ?? [];
		appendJsonLine(this._logFile, {
			seq,
			time: new Date(started).toISOString(),
			ms: Date.now() - started,
			messages: openAiMessages,
			tools: (tools ?? []).map(t => t.function.name),
			toolChoice,
			content,
			toolCalls: toolCalls.map(c => ({ name: c.function.name, arguments: c.function.arguments })),
			finishReason: choice?.finish_reason,
			error,
		} satisfies ILlamaRequestRecord);

		if (error) {
			throw new Error(error);
		}
		if (content) {
			progress.report(new vscode.LanguageModelTextPart(content));
		}
		for (const call of toolCalls) {
			progress.report(new vscode.LanguageModelToolCallPart(call.id || `call_${seq}_${call.function.name}`, call.function.name, parseArguments(call.function.arguments)));
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const value = typeof text === 'string' ? text : JSON.stringify(toOpenAiMessages([text]));
		return Math.ceil(value.length / 4);
	}
}
