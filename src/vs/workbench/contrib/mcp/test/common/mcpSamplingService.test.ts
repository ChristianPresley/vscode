/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullCommandService } from '../../../../../platform/commands/test/common/nullCommandService.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ChatMessageRole, IChatMessage, IChatResponsePart, ILanguageModelChatMetadata, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelChatSelector, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { NullLanguageModelsService } from '../../../chat/test/common/languageModels.js';
import { mcpServerSamplingSection } from '../../common/mcpConfiguration.js';
import { McpSamplingService } from '../../common/mcpSamplingService.js';
import { IMcpServer, ISamplingOptions, McpError } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';

const TEST_MODEL = 'test-model';
const LAZY_MODEL = 'lazy/model';

/** Mirrors `vscode.LanguageModelChatToolMode`, which the service forwards numerically. */
const enum ToolMode {
	Auto = 1,
	Required = 2,
}

interface IRecordedRequest {
	readonly modelId: string;
	readonly messages: IChatMessage[];
	readonly options: ILanguageModelChatRequestOptions;
}

/** Records every chat request and answers it with scripted response parts. */
class RecordingLanguageModelsService extends NullLanguageModelsService {
	readonly requests: IRecordedRequest[] = [];
	scriptedParts: (IChatResponsePart | IChatResponsePart[])[] = [];

	private readonly _metadata: ILanguageModelChatMetadata = {
		extension: new ExtensionIdentifier('test.extension'),
		name: 'Test Model',
		id: TEST_MODEL,
		vendor: 'test',
		version: '1.0',
		family: 'test',
		maxInputTokens: 1000,
		maxOutputTokens: 1000,
		isDefaultForLocation: {},
		capabilities: { toolCalling: true },
	};

	override getLanguageModelIds(): string[] {
		return [TEST_MODEL];
	}

	override lookupLanguageModel(identifier: string): ILanguageModelChatMetadata | undefined {
		return identifier === TEST_MODEL || (identifier === LAZY_MODEL && this.lazyVendorResolved) ? this._metadata : undefined;
	}

	/** Whether the models of the vendor `lazy` were resolved: like a vendor no chat has asked for yet, its model is unknown until then. */
	lazyVendorResolved = false;

	override async selectLanguageModels(selector: ILanguageModelChatSelector): Promise<string[]> {
		if (selector.vendor === 'lazy') {
			this.lazyVendorResolved = true;
			return [LAZY_MODEL];
		}
		return [];
	}

	override async sendChatRequest(modelId: string, _from: ExtensionIdentifier | undefined, messages: IChatMessage[], options: ILanguageModelChatRequestOptions, _token: CancellationToken): Promise<ILanguageModelChatResponse> {
		this.requests.push({ modelId, messages, options });
		const parts = this.scriptedParts;
		return {
			stream: (async function* () {
				for (const part of parts) {
					yield part;
				}
			})(),
			result: Promise.resolve(undefined),
		};
	}
}

const weatherTool: MCPLegacy.Tool = {
	name: 'get_weather',
	description: 'Get current weather for a city',
	inputSchema: {
		type: 'object',
		properties: { city: { type: 'string' } },
		required: ['city'],
	},
};

const userText = (text: string): MCPLegacy.SamplingMessage => ({ role: 'user', content: { type: 'text', text } });

suite('MCP - Sampling Service', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const server = {
		definition: { id: 'test-server', label: 'Test Server' },
		collection: { id: 'test-collection', label: 'Test Collection' },
		readDefinitions: () => ({
			get: () => ({ server: undefined, collection: { scope: StorageScope.APPLICATION, configTarget: ConfigurationTarget.USER } }),
		}),
	} as unknown as IMcpServer;

	let languageModels: RecordingLanguageModelsService;
	let configuration: TestConfigurationService;
	let service: McpSamplingService;

	setup(() => {
		configuration = new TestConfigurationService();
		// Pre-approve the server so no allow prompt is shown, and pin the model.
		configuration.setUserConfiguration(mcpServerSamplingSection, {
			'Test Collection: Test Server': { allowedOutsideChat: true, allowedModels: [TEST_MODEL] },
		});

		languageModels = new RecordingLanguageModelsService();
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ILanguageModelsService, languageModels);
		instantiationService.stub(IConfigurationService, configuration);
		instantiationService.stub(IDialogService, new TestDialogService());
		instantiationService.stub(INotificationService, new TestNotificationService());
		instantiationService.stub(ICommandService, NullCommandService);
		instantiationService.stub(IStorageService, store.add(new TestStorageService()));
		service = store.add(instantiationService.createInstance(McpSamplingService));
	});

	function sample(params: Partial<MCPLegacy.CreateMessageRequestParams>): Promise<MCPLegacy.CreateMessageResult> {
		const opts: ISamplingOptions = {
			server,
			isDuringToolCall: false,
			params: { messages: [userText('hi')], maxTokens: 100, ...params },
		};
		return service.sample(opts, CancellationToken.None).then(r => r.sample);
	}

	function assertRejectsInvalidParams(promise: Promise<unknown>, messagePart: string): Promise<void> {
		return assert.rejects(promise, (err: unknown) => {
			assert.ok(err instanceof McpError, `expected an McpError, got ${String(err)}`);
			assert.strictEqual(err.code, MCPLegacy.INVALID_PARAMS);
			assert.ok(err.message.includes(messagePart), `unexpected message: ${err.message}`);
			return true;
		});
	}

	suite('tools and toolChoice', () => {
		test('maps tools to language model tool definitions with the auto mode by default', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({ tools: [weatherTool, { name: 'noop', inputSchema: { type: 'object' } }] });

			assert.strictEqual(languageModels.requests.length, 1);
			assert.deepStrictEqual(languageModels.requests[0].options, {
				modelOptions: { max_tokens: 100 },
				tools: [
					{ name: 'get_weather', description: 'Get current weather for a city', inputSchema: weatherTool.inputSchema },
					{ name: 'noop', description: '', inputSchema: { type: 'object' } },
				],
				toolMode: ToolMode.Auto,
			});
		});

		test('toolChoice auto uses the auto mode', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({ tools: [weatherTool], toolChoice: { mode: 'auto' } });
			assert.strictEqual(languageModels.requests[0].options.toolMode, ToolMode.Auto);
			assert.strictEqual(languageModels.requests[0].options.tools.length, 1);
		});

		test('toolChoice required uses the required mode', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({ tools: [weatherTool], toolChoice: { mode: 'required' } });
			assert.strictEqual(languageModels.requests[0].options.toolMode, ToolMode.Required);
			assert.strictEqual(languageModels.requests[0].options.tools.length, 1);
		});

		test('toolChoice none withholds the tools, as the language model API has no none mode', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({ tools: [weatherTool], toolChoice: { mode: 'none' } });
			assert.deepStrictEqual(languageModels.requests[0].options, { modelOptions: { max_tokens: 100 } });
		});

		test('toolChoice required without tools is rejected', async () => {
			await assertRejectsInvalidParams(sample({ toolChoice: { mode: 'required' } }), 'required');
			assert.strictEqual(languageModels.requests.length, 0);
		});

		test('a request without tools sends only the model options', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({});
			assert.deepStrictEqual(languageModels.requests[0].options, { modelOptions: { max_tokens: 100 } });
		});
	});

	suite('model options', () => {
		test('maxTokens is sent to the language model as the max_tokens model option', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({ maxTokens: 321 });
			await sample({ maxTokens: 7, tools: [weatherTool], toolChoice: { mode: 'required' } });
			assert.deepStrictEqual(languageModels.requests.map(r => r.options.modelOptions), [{ max_tokens: 321 }, { max_tokens: 7 }]);
			assert.strictEqual(languageModels.requests[1].options.toolMode, ToolMode.Required);
		});

		test('temperature, stopSequences and metadata are not sent', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({ maxTokens: 50, temperature: 0.2, stopSequences: ['END'], metadata: { k: 'v' } });
			assert.deepStrictEqual(languageModels.requests[0].options, { modelOptions: { max_tokens: 50 } });
		});

		test('a request without a numeric maxTokens is served without a limit', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			await sample({ maxTokens: undefined });
			await sample({ maxTokens: 'many' as unknown as number });
			assert.deepStrictEqual(languageModels.requests.map(r => r.options), [{}, {}]);
		});
	});

	suite('request messages', () => {
		test('maps assistant tool_use and user tool_result blocks to tool-call and tool-result parts', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			const png = 'iVBORw0KGgo=';
			await sample({
				systemPrompt: 'Be brief.',
				tools: [weatherTool],
				messages: [
					userText('Weather in Paris and London?'),
					{
						role: 'assistant',
						content: [
							{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
							{ type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'London' } },
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: '18°C' }, { type: 'image', mimeType: 'image/png', data: png }] },
							{ type: 'tool_result', toolUseId: 'call_2', content: [{ type: 'text', text: 'unavailable' }], isError: true },
						],
					},
					{ role: 'assistant', content: { type: 'text', text: 'Paris is warmer.' } },
					// A single tool result may also be sent as a bare block.
					{ role: 'assistant', content: { type: 'tool_use', id: 'call_3', name: 'get_weather', input: { city: 'Rome' } } },
					{ role: 'user', content: { type: 'tool_result', toolUseId: 'call_3', content: [{ type: 'resource', resource: { uri: 'file:///rome.txt', text: '25°C' } }] } },
				],
			});

			assert.deepStrictEqual(languageModels.requests[0].messages, [
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: 'Be brief.' }] },
				{ role: ChatMessageRole.User, content: [{ type: 'text', value: 'Weather in Paris and London?' }] },
				{
					role: ChatMessageRole.Assistant,
					content: [
						{ type: 'tool_use', toolCallId: 'call_1', name: 'get_weather', parameters: { city: 'Paris' } },
						{ type: 'tool_use', toolCallId: 'call_2', name: 'get_weather', parameters: { city: 'London' } },
					],
				},
				{
					role: ChatMessageRole.User,
					content: [
						{ type: 'tool_result', toolCallId: 'call_1', value: [{ type: 'text', value: '18°C' }, { type: 'data', mimeType: 'image/png', data: decodeBase64(png) }] },
						{ type: 'tool_result', toolCallId: 'call_2', value: [{ type: 'text', value: 'unavailable' }], isError: true },
					],
				},
				{ role: ChatMessageRole.Assistant, content: [{ type: 'text', value: 'Paris is warmer.' }] },
				{ role: ChatMessageRole.Assistant, content: [{ type: 'tool_use', toolCallId: 'call_3', name: 'get_weather', parameters: { city: 'Rome' } }] },
				{ role: ChatMessageRole.User, content: [{ type: 'tool_result', toolCallId: 'call_3', value: [{ type: 'text', value: '25°C' }] }] },
			]);
		});

		test('rejects a tool_result that references an unknown tool_use id', async () => {
			await assertRejectsInvalidParams(sample({
				messages: [
					userText('hi'),
					{ role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} } },
					{ role: 'user', content: { type: 'tool_result', toolUseId: 'call_404', content: [{ type: 'text', text: 'x' }] } },
				],
			}), 'call_404');
			assert.strictEqual(languageModels.requests.length, 0);
		});

		test('rejects a tool_result without any preceding tool_use', async () => {
			await assertRejectsInvalidParams(sample({
				messages: [{ role: 'user', content: { type: 'tool_result', toolUseId: 'call_1', content: [] } }],
			}), 'call_1');
			assert.strictEqual(languageModels.requests.length, 0);
		});

		test('rejects a user message mixing tool_result with other content', async () => {
			await assertRejectsInvalidParams(sample({
				messages: [
					userText('hi'),
					{ role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} } },
					{ role: 'user', content: [{ type: 'text', text: 'Here you go:' }, { type: 'tool_result', toolUseId: 'call_1', content: [] }] },
				],
			}), 'mixes tool_result');
			assert.strictEqual(languageModels.requests.length, 0);
		});

		test('rejects an assistant tool_use that the next message does not answer', async () => {
			await assertRejectsInvalidParams(sample({
				messages: [
					userText('hi'),
					{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} }, { type: 'tool_use', id: 'call_2', name: 'get_weather', input: {} }] },
					{ role: 'user', content: { type: 'tool_result', toolUseId: 'call_1', content: [] } },
					{ role: 'assistant', content: { type: 'text', text: 'done' } },
				],
			}), 'call_2');

			await assertRejectsInvalidParams(sample({
				messages: [
					userText('hi'),
					{ role: 'assistant', content: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} } },
				],
			}), 'call_1');
			assert.strictEqual(languageModels.requests.length, 0);
		});

		test('rejects tool blocks sent with the wrong role', async () => {
			await assertRejectsInvalidParams(sample({
				messages: [{ role: 'user', content: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} } }],
			}), 'tool_use');
			assert.strictEqual(languageModels.requests.length, 0);
		});
	});

	suite('response', () => {
		test('returns a plain text response as a single text block with endTurn', async () => {
			languageModels.scriptedParts = [{ type: 'text', value: 'Hello' }, [{ type: 'text', value: ', ' }, { type: 'text', value: 'world' }]];
			const result = await sample({});

			assert.deepStrictEqual(result, {
				model: TEST_MODEL,
				role: 'assistant',
				content: { type: 'text', text: 'Hello, world' },
				stopReason: 'endTurn',
			});
		});

		test('returns an empty text block when the model produced nothing', async () => {
			languageModels.scriptedParts = [];
			const result = await sample({});
			assert.deepStrictEqual(result.content, { type: 'text', text: '' });
			assert.strictEqual(result.stopReason, 'endTurn');
		});

		test('returns tool calls as ToolUseContent with stopReason toolUse', async () => {
			languageModels.scriptedParts = [
				{ type: 'text', value: 'Checking' },
				{ type: 'text', value: ' both.' },
				{ type: 'tool_use', toolCallId: 'call_1', name: 'get_weather', parameters: { city: 'Paris' } },
				{ type: 'tool_use', toolCallId: 'call_2', name: 'get_weather', parameters: '{"city":"London"}' },
			];
			const result = await sample({ tools: [weatherTool] });

			assert.deepStrictEqual(result, {
				model: TEST_MODEL,
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Checking both.' },
					{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
					{ type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'London' } },
				],
				stopReason: 'toolUse',
			});
		});

		test('returns a lone tool call as a single block', async () => {
			languageModels.scriptedParts = [{ type: 'tool_use', toolCallId: 'call_1', name: 'get_weather', parameters: { city: 'Paris' } }];
			const result = await sample({ tools: [weatherTool] });

			assert.deepStrictEqual(result.content, { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } });
			assert.strictEqual(result.stopReason, 'toolUse');
		});
	});

	suite('model resolution', () => {
		test('a configured model of a vendor that was not resolved yet is resolved, not reported missing', async () => {
			configuration.setUserConfiguration(mcpServerSamplingSection, {
				'Test Collection: Test Server': { allowedDuringChat: true, allowedModels: [LAZY_MODEL] },
			});
			languageModels.scriptedParts = [{ type: 'text', value: 'ok' }];
			const { sample: result } = await service.sample({ server, isDuringToolCall: true, params: { messages: [userText('hi')], maxTokens: 100 } }, CancellationToken.None);
			assert.strictEqual(languageModels.lazyVendorResolved, true);
			assert.strictEqual(result.model, LAZY_MODEL);
			assert.deepStrictEqual(languageModels.requests.map(r => r.modelId), [LAZY_MODEL]);
		});
	});
});
