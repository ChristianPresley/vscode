/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { asArray } from '../../../../base/common/arrays.js';
import { mapFindFirst } from '../../../../base/common/arraysFind.js';
import { Sequencer } from '../../../../base/common/async.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isDefined } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, getConfigValueInTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ChatConfiguration } from '../../chat/common/constants.js';
import { ChatImageMimeType, ChatMessageRole, IChatMessage, IChatMessagePart, IChatMessageToolResultPart, IChatResponsePart, ILanguageModelChatRequestOptions, ILanguageModelsService } from '../../chat/common/languageModels.js';
import { McpCommandIds } from './mcpCommandIds.js';
import { IMcpServerSamplingConfiguration, mcpServerSamplingSection } from './mcpConfiguration.js';
import { McpSamplingLog } from './mcpSamplingLog.js';
import { IMcpSamplingService, IMcpServer, ISamplingOptions, ISamplingResult, McpError } from './mcpTypes.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';

const enum ModelMatch {
	UnsureAllowedDuringChat,
	UnsureAllowedOutsideChat,
	NotAllowed,
	NoMatchingModel,
}

/**
 * Tool-selection modes of the language model API. This mirrors
 * `vscode.LanguageModelChatToolMode`: the request options are forwarded to the
 * model provider as-is, so the numeric values must stay in sync with it. The
 * enum lives in the extension host types, which a workbench contribution
 * cannot import.
 */
const enum LanguageModelChatToolMode {
	Auto = 1,
	Required = 2,
}

/** A tool offered to the language model, in the shape of `vscode.LanguageModelChatTool`. */
interface ILanguageModelChatToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema?: object;
}

/** A sampling request translated for the language model API. */
interface ISamplingLanguageModelRequest {
	readonly messages: IChatMessage[];
	readonly options: ILanguageModelChatRequestOptions;
}

export class McpSamplingService extends Disposable implements IMcpSamplingService {
	declare readonly _serviceBrand: undefined;

	private readonly _sessionSets = {
		allowedDuringChat: new Map<string, boolean>(),
		allowedOutsideChat: new Map<string, boolean>(),
	};

	private readonly _logs: McpSamplingLog;

	private readonly _modelSequencer = new Sequencer();

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
		@IInstantiationService instaService: IInstantiationService,
	) {
		super();
		this._logs = this._register(instaService.createInstance(McpSamplingLog));
	}

	async sample(opts: ISamplingOptions, token = CancellationToken.None): Promise<ISamplingResult> {
		// Translate (and validate) the request before any model is selected, so
		// that a malformed request is rejected without prompting the user.
		const { messages, options } = buildLanguageModelRequest(opts.params);

		const model = await this._modelSequencer.queue(() => this._getMatchingModel(opts));
		const response = await this._languageModelsService.sendChatRequest(model, undefined, messages, options, token);

		// Text and tool calls are the only response parts with a sampling
		// representation; other parts (data, thinking) are dropped.
		const blocks: MCPLegacy.SamplingMessageContentBlock[] = [];
		const streaming = (async () => {
			for await (const part of response.stream) {
				for (const p of asArray(part)) {
					appendResponsePart(blocks, p);
				}
			}
		})();

		try {
			await Promise.all([response.result, streaming]);
		} catch (err) {
			throw McpError.unknown(err);
		}

		const responseText = blocks.map(b => b.type === 'text' ? b.text : '').join('');
		this._logs.add(opts.server, opts.params.messages, responseText, model);

		const hasToolUse = blocks.some(b => b.type === 'tool_use');
		return {
			sample: {
				model,
				// A single block keeps the non-array shape so that servers which
				// do not use tools see the same wire format as before.
				content: blocks.length === 1 ? blocks[0] : blocks.length === 0 ? { type: 'text', text: '' } : blocks,
				role: 'assistant', // it came from the model!
				// The language model API does not report why generation ended, so
				// a response without tool calls is reported as a natural end of
				// turn; `maxTokens` and `stopSequence` cannot be distinguished.
				stopReason: hasToolUse ? 'toolUse' : 'endTurn',
			},
		};
	}

	hasLogs(server: IMcpServer): boolean {
		return this._logs.has(server);
	}

	getLogText(server: IMcpServer): string {
		return this._logs.getAsText(server);
	}

	private async _getMatchingModel(opts: ISamplingOptions): Promise<string> {
		const model = await this._getMatchingModelInner(opts.server, opts.isDuringToolCall, opts.params.modelPreferences);
		const globalAutoApprove = this._configurationService.getValue<boolean>(ChatConfiguration.GlobalAutoApprove);

		if (model === ModelMatch.UnsureAllowedDuringChat) {
			// In YOLO mode, auto-approve MCP sampling requests without prompting
			if (globalAutoApprove) {
				this._sessionSets.allowedDuringChat.set(opts.server.definition.id, true);
				return this._getMatchingModel(opts);
			}
			const retry = await this._showContextual(
				opts.isDuringToolCall,
				localize('mcp.sampling.allowDuringChat.title', 'Allow MCP tools from "{0}" to make LLM requests?', opts.server.definition.label),
				localize('mcp.sampling.allowDuringChat.desc', 'The MCP server "{0}" has issued a request to make a language model call. Do you want to allow it to make requests during chat?', opts.server.definition.label),
				this.allowButtons(opts.server, 'allowedDuringChat')
			);
			if (retry) {
				return this._getMatchingModel(opts);
			}
			throw McpError.notAllowed();
		} else if (model === ModelMatch.UnsureAllowedOutsideChat) {
			// In YOLO mode, auto-approve MCP sampling requests without prompting
			if (globalAutoApprove) {
				this._sessionSets.allowedOutsideChat.set(opts.server.definition.id, true);
				return this._getMatchingModel(opts);
			}
			const retry = await this._showContextual(
				opts.isDuringToolCall,
				localize('mcp.sampling.allowOutsideChat.title', 'Allow MCP server "{0}" to make LLM requests?', opts.server.definition.label),
				localize('mcp.sampling.allowOutsideChat.desc', 'The MCP server "{0}" has issued a request to make a language model call. Do you want to allow it to make requests, outside of tool calls during chat?', opts.server.definition.label),
				this.allowButtons(opts.server, 'allowedOutsideChat')
			);
			if (retry) {
				return this._getMatchingModel(opts);
			}
			throw McpError.notAllowed();
		} else if (model === ModelMatch.NotAllowed) {
			throw McpError.notAllowed();
		} else if (model === ModelMatch.NoMatchingModel) {
			const newlyPickedModels = opts.isDuringToolCall
				? await this._commandService.executeCommand<number>(McpCommandIds.ConfigureSamplingModels, opts.server)
				: await this._notify(
					localize('mcp.sampling.needsModels', 'MCP server "{0}" triggered a language model request, but it has no allowlisted models.', opts.server.definition.label),
					{
						[localize('configure', 'Configure')]: () => this._commandService.executeCommand<number>(McpCommandIds.ConfigureSamplingModels, opts.server),
						[localize('cancel', 'Cancel')]: () => Promise.resolve(undefined),
					}
				);
			if (newlyPickedModels) {
				return this._getMatchingModel(opts);
			}
			throw McpError.notAllowed();
		}

		return model;
	}

	private allowButtons(server: IMcpServer, key: 'allowedDuringChat' | 'allowedOutsideChat') {
		return {
			[localize('mcp.sampling.allow.inSession', 'Allow in this Session')]: async () => {
				this._sessionSets[key].set(server.definition.id, true);
				return true;
			},
			[localize('mcp.sampling.allow.always', 'Always')]: async () => {
				await this.updateConfig(server, c => c[key] = true);
				return true;
			},
			[localize('mcp.sampling.allow.notNow', 'Not Now')]: async () => {
				this._sessionSets[key].set(server.definition.id, false);
				return false;
			},
			[localize('mcp.sampling.allow.never', 'Never')]: async () => {
				await this.updateConfig(server, c => c[key] = false);
				return false;
			},
		};
	}

	private async _showContextual<T>(isDuringToolCall: boolean, title: string, message: string, buttons: Record<string, () => T>): Promise<Awaited<T> | undefined> {
		if (isDuringToolCall) {
			const result = await this._dialogService.prompt({
				type: 'question',
				title: title,
				message,
				buttons: Object.entries(buttons).map(([label, run]) => ({ label, run })),
			});
			return await result.result;
		} else {
			return await this._notify(message, buttons);
		}
	}

	private async _notify<T>(message: string, buttons: Record<string, () => T>): Promise<Awaited<T> | undefined> {
		return await new Promise<T | undefined>(resolve => {
			const handle = this._notificationService.prompt(
				Severity.Info,
				message,
				Object.entries(buttons).map(([label, action]) => ({
					label,
					run: () => resolve(action()),
				}))
			);
			Event.once(handle.onDidClose)(() => resolve(undefined));
		});
	}

	/**
	 * Gets the matching model for the MCP server in this context, or
	 * a reason why no model could be selected.
	 */
	private async _getMatchingModelInner(server: IMcpServer, isDuringToolCall: boolean, preferences: MCPLegacy.ModelPreferences | undefined): Promise<ModelMatch | string> {
		const config = this.getConfig(server);
		// 1. Ensure the server is allowed to sample in this context
		if (isDuringToolCall && !config.allowedDuringChat && !this._sessionSets.allowedDuringChat.has(server.definition.id)) {
			return config.allowedDuringChat === undefined ? ModelMatch.UnsureAllowedDuringChat : ModelMatch.NotAllowed;
		} else if (!isDuringToolCall && !config.allowedOutsideChat && !this._sessionSets.allowedOutsideChat.has(server.definition.id)) {
			return config.allowedOutsideChat === undefined ? ModelMatch.UnsureAllowedOutsideChat : ModelMatch.NotAllowed;
		}

		// 2. Get the configured models, or the default free model(s)
		const foundModelIds = config.allowedModels?.filter(m => !!this._languageModelsService.lookupLanguageModel(m)) || this._getDefaultModels();
		if (!foundModelIds.length) {
			return ModelMatch.NoMatchingModel;
		}

		// 3. If preferences are provided, try to match them from the allowed models
		if (preferences?.hints) {
			const found = mapFindFirst(preferences.hints, hint => foundModelIds.find(model => model.toLowerCase().includes(hint.name!.toLowerCase())));
			if (found) {
				return found;
			}
		}

		return foundModelIds[0]; // Return the first matching model
	}

	private _getDefaultModels() {
		const candidates = this._languageModelsService.getLanguageModelIds().map(m => {
			const model = this._languageModelsService.lookupLanguageModel(m);
			return model && !model.multiplierNumeric && !model.targetChatSessionType ? { model, id: m } : undefined;
		}).filter(isDefined);

		const someDefault = candidates.findIndex(c => Object.values(c.model.isDefaultForLocation).some(Boolean));
		if (someDefault !== -1) {
			[candidates[0], candidates[someDefault]] = [candidates[someDefault], candidates[0]];
		}

		return candidates.map(c => c.id);
	}

	private _configKey(server: IMcpServer) {
		return `${server.collection.label}: ${server.definition.label}`;
	}

	public getConfig(server: IMcpServer): IMcpServerSamplingConfiguration {
		return this._getConfig(server).value || {};
	}

	/**
	 * _getConfig reads the sampling config reads the `{ server: data }` mapping
	 * from the appropriate config. We read from the most specific possible
	 * config up to the default configuration location that the MCP server itself
	 * is defined in. We don't go further because then workspace-specific servers
	 * would get in the user settings which is not meaningful and could lead
	 * to confusion.
	 *
	 * todo@connor4312: generalize this for other esttings when we have them
	 */
	private _getConfig(server: IMcpServer) {
		const def = server.readDefinitions().get();
		const mostSpecificConfig = ConfigurationTarget.MEMORY;
		const leastSpecificConfig = def.collection?.configTarget || ConfigurationTarget.USER;
		const key = this._configKey(server);
		const resource = def.collection?.presentation?.origin;

		const configValue = this._configurationService.inspect<Record<string, IMcpServerSamplingConfiguration>>(mcpServerSamplingSection, { resource });
		for (let target = mostSpecificConfig; target >= leastSpecificConfig; target--) {
			const mapping = getConfigValueInTarget(configValue, target);
			const config = mapping?.[key];
			if (config) {
				return { value: config, key, mapping, target, resource };
			}
		}

		return { value: undefined, mapping: getConfigValueInTarget(configValue, leastSpecificConfig), key, target: leastSpecificConfig, resource };
	}

	public async updateConfig(server: IMcpServer, mutate: (r: IMcpServerSamplingConfiguration) => unknown) {
		const { value, mapping, key, target, resource } = this._getConfig(server);

		const newConfig = { ...value };
		mutate(newConfig);

		await this._configurationService.updateValue(
			mcpServerSamplingSection,
			{ ...mapping, [key]: newConfig },
			{ resource },
			target,
		);
		return newConfig;
	}
}

function invalidParams(message: string): McpError {
	return new McpError(MCPLegacy.INVALID_PARAMS, message);
}

/**
 * Translates a `sampling/createMessage` request into messages and options for
 * the language model API, validating the tool-use rules of the sampling
 * specification along the way. A violation rejects the request with
 * `INVALID_PARAMS`; the request handler turns that into the JSON-RPC error
 * (legacy servers) or a failed input round (modern servers).
 */
function buildLanguageModelRequest(params: MCPLegacy.CreateMessageRequestParams): ISamplingLanguageModelRequest {
	const messages: IChatMessage[] = [];
	/** Every `tool_use` id issued so far, to tell a stale reference from an unknown one. */
	const issuedToolUses = new Set<string>();
	/** The `tool_use` ids of the latest assistant message that still await a `tool_result`. */
	const pendingToolUses = new Set<string>();

	params.messages.forEach((message, index) => {
		const blocks = asArray(message.content);
		const toolResults = blocks.filter(b => b.type === 'tool_result');
		const toolUses = blocks.filter(b => b.type === 'tool_use');

		// A message carrying tool results must consist only of tool results, and
		// tool results (resp. tool uses) belong to the user (resp. assistant) role.
		if (toolResults.length && toolResults.length !== blocks.length) {
			throw invalidParams(`messages[${index}] mixes tool_result blocks with other content; a message with tool results must contain only tool results`);
		}
		if (toolResults.length && message.role !== 'user') {
			throw invalidParams(`messages[${index}] has role "${message.role}" but contains tool_result blocks, which must be sent in a user message`);
		}
		if (toolUses.length && message.role !== 'assistant') {
			throw invalidParams(`messages[${index}] has role "${message.role}" but contains tool_use blocks, which must be sent in an assistant message`);
		}

		// An assistant message with tool uses must be followed, before any other
		// message, by a user message answering each of them exactly once.
		if (pendingToolUses.size && !toolResults.length) {
			throw invalidParams(`messages[${index}] must contain the tool_result blocks for the preceding tool_use ${describeIds(pendingToolUses)}`);
		}
		for (const result of toolResults) {
			if (pendingToolUses.has(result.toolUseId)) {
				pendingToolUses.delete(result.toolUseId);
			} else if (issuedToolUses.has(result.toolUseId)) {
				throw invalidParams(`messages[${index}] contains a tool_result for "${result.toolUseId}", which was already answered`);
			} else {
				throw invalidParams(`messages[${index}] contains a tool_result for "${result.toolUseId}", which does not match a tool_use in an earlier assistant message`);
			}
		}
		if (toolResults.length && pendingToolUses.size) {
			throw invalidParams(`messages[${index}] is missing the tool_result blocks for tool_use ${describeIds(pendingToolUses)}`);
		}
		for (const use of toolUses) {
			if (issuedToolUses.has(use.id)) {
				throw invalidParams(`messages[${index}] reuses the tool_use id "${use.id}"`);
			}
			issuedToolUses.add(use.id);
			pendingToolUses.add(use.id);
		}

		const content = blocks.map(samplingBlockToMessagePart).filter(isDefined);
		if (content.length) {
			messages.push({
				role: message.role === 'assistant' ? ChatMessageRole.Assistant : ChatMessageRole.User,
				content,
			});
		}
	});

	if (pendingToolUses.size) {
		throw invalidParams(`The last assistant message contains tool_use ${describeIds(pendingToolUses)} without a following user message with the tool results`);
	}

	if (params.systemPrompt) {
		messages.unshift({ role: ChatMessageRole.System, content: [{ type: 'text', value: params.systemPrompt }] });
	}

	return { messages, options: buildToolOptions(params) };
}

function describeIds(ids: ReadonlySet<string>): string {
	return Array.from(ids, id => `"${id}"`).join(', ');
}

/**
 * Maps `tools` and `toolChoice` to the language model request options.
 *
 * The language model API knows the modes "auto" and "required" only. A
 * `toolChoice` of `none` is approximated by not offering any tools at all,
 * which is equivalent for the model: it cannot call a tool it was not given.
 * Without tools the options stay empty, as they were before tools existed.
 */
function buildToolOptions(params: MCPLegacy.CreateMessageRequestParams): ILanguageModelChatRequestOptions {
	const mode = params.toolChoice?.mode ?? 'auto';
	const tools = params.tools ?? [];
	if (mode === 'required' && !tools.length) {
		throw invalidParams('toolChoice.mode "required" needs at least one tool in "tools"');
	}
	if (mode === 'none' || !tools.length) {
		return {};
	}

	const definitions: ILanguageModelChatToolDefinition[] = tools.map(tool => ({
		name: tool.name,
		description: tool.description ?? '',
		inputSchema: tool.inputSchema,
	}));
	return {
		tools: definitions,
		toolMode: mode === 'required' ? LanguageModelChatToolMode.Required : LanguageModelChatToolMode.Auto,
	};
}

function samplingBlockToMessagePart(block: MCPLegacy.SamplingMessageContentBlock): IChatMessagePart | undefined {
	switch (block.type) {
		case 'text':
			return { type: 'text', value: block.text };
		case 'image':
		case 'audio':
			return { type: 'image_url', value: { mimeType: block.mimeType as ChatImageMimeType, data: decodeBase64(block.data) } };
		case 'tool_use':
			return { type: 'tool_use', toolCallId: block.id, name: block.name, parameters: block.input };
		case 'tool_result': {
			const part: IChatMessageToolResultPart = {
				type: 'tool_result',
				toolCallId: block.toolUseId,
				value: block.content.map(toolResultBlockToPart).filter(isDefined),
			};
			if (block.isError) {
				part.isError = true;
			}
			return part;
		}
		default:
			return undefined;
	}
}

function toolResultBlockToPart(block: MCPLegacy.ContentBlock): IChatMessageToolResultPart['value'][number] | undefined {
	switch (block.type) {
		case 'text':
			return { type: 'text', value: block.text };
		case 'image':
		case 'audio':
			return { type: 'data', mimeType: block.mimeType, data: decodeBase64(block.data) };
		case 'resource': {
			const resource: Partial<MCPLegacy.TextResourceContents & MCPLegacy.BlobResourceContents> = block.resource;
			if (typeof resource.text === 'string') {
				return { type: 'text', value: resource.text };
			}
			if (typeof resource.blob === 'string') {
				return { type: 'data', mimeType: resource.mimeType ?? 'application/octet-stream', data: decodeBase64(resource.blob) };
			}
			return undefined;
		}
		case 'resource_link':
			return { type: 'text', value: block.uri };
		default:
			return undefined;
	}
}

/** Appends a streamed response part to the sampling content, merging adjacent text. */
function appendResponsePart(blocks: MCPLegacy.SamplingMessageContentBlock[], part: IChatResponsePart): void {
	if (part.type === 'text') {
		const last = blocks.at(-1);
		if (last?.type === 'text') {
			last.text += part.value;
		} else {
			blocks.push({ type: 'text', text: part.value });
		}
	} else if (part.type === 'tool_use') {
		blocks.push({ type: 'tool_use', id: part.toolCallId, name: part.name, input: toToolInput(part.parameters) });
	}
}

/** Tool-call arguments arrive as a parsed object, or occasionally as their JSON text. */
function toToolInput(parameters: unknown): { [key: string]: unknown } {
	if (typeof parameters === 'string') {
		try {
			parameters = JSON.parse(parameters);
		} catch {
			return {};
		}
	}
	return typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters)
		? parameters as { [key: string]: unknown }
		: {};
}
