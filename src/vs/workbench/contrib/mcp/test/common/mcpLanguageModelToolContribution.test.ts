/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IImageResizeService } from '../../../../../platform/imageResize/common/imageResizeService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { TestProductService } from '../../../../test/common/workbenchTestServices.js';
import { ContributionEnablementState } from '../../../chat/common/enablement.js';
import { ILanguageModelToolsService, IToolData, IToolImpl, IToolResultInputOutputDetails, ToolDataSource, ToolSet } from '../../../chat/common/tools/languageModelToolsService.js';
import { MockLanguageModelToolsService } from '../../../chat/test/common/tools/mockLanguageModelToolsService.js';
import { McpLanguageModelToolContribution } from '../../common/mcpLanguageModelToolContribution.js';
import { IMcpRegistry } from '../../common/mcpRegistryTypes.js';
import { IMcpServer, IMcpService, IMcpTool, McpConnectionState, McpToolVisibility } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { TestMcpRegistry } from './mcpRegistryTypes.js';
import { TestMcpService } from './testMcpService.js';

class TestToolSet extends ToolSet implements IDisposable {
	constructor(id: string, referenceName: string, source: ToolDataSource) {
		super(id, referenceName, ThemeIcon.fromId(Codicon.mcp.id), source, undefined, undefined, undefined, undefined, undefined, new MockContextKeyService());
	}

	dispose(): void { }
}

/** Records the tools the contribution registers so their data and implementation can be inspected. */
class RecordingToolsService extends MockLanguageModelToolsService {
	readonly registered: { readonly data: IToolData; readonly impl: IToolImpl }[] = [];

	override registerTool(toolData: IToolData, tool: IToolImpl): IDisposable {
		const entry = { data: toolData, impl: tool };
		this.registered.push(entry);
		return toDisposable(() => {
			const index = this.registered.indexOf(entry);
			if (index >= 0) {
				this.registered.splice(index, 1);
			}
		});
	}

	override createToolSet(source: ToolDataSource = ToolDataSource.Internal, id = 'test-tool-set', referenceName = id): ToolSet & IDisposable {
		return new TestToolSet(id, referenceName, source);
	}
}

function makeTool(definition: MCPLegacy.Tool, result: MCPLegacy.CallToolResult, visibility = McpToolVisibility.Model | McpToolVisibility.App): IMcpTool {
	return upcastPartial<IMcpTool>({
		id: `mcp_test_${definition.name}`,
		referenceName: definition.name,
		icons: { getUrl: () => undefined },
		definition,
		visibility,
		call: async () => result,
		callWithProgress: async () => result,
	});
}

suite('Workbench - MCP - LanguageModelToolContribution', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const inputSchema = { type: 'object', properties: {} } as const;
	const okResult: MCPLegacy.CallToolResult = { content: [{ type: 'text', text: 'fine' }] };

	function createContribution(tools: IMcpTool[]) {
		const toolsService = store.add(new RecordingToolsService());
		const mcpService = new TestMcpService();
		const toolsObservable = observableValue<readonly IMcpTool[]>('tools', tools);
		const server = upcastPartial<IMcpServer>({
			collection: { id: 'test-collection', label: 'Test Collection', order: 0 },
			definition: { id: 'test-server', label: 'Test Server' },
			enablement: constObservable(ContributionEnablementState.EnabledProfile),
			serverMetadata: constObservable(undefined),
			tools: toolsObservable,
			connection: constObservable(undefined),
			connectionState: constObservable({ state: McpConnectionState.Kind.Stopped }),
		});
		mcpService.servers.set([server], undefined);

		const parent = store.add(new TestInstantiationService(new ServiceCollection(
			[ILanguageModelToolsService, toolsService],
			[IMcpService, mcpService],
			[ILifecycleService, upcastPartial<ILifecycleService>({ willShutdown: false })],
			[IConfigurationService, new TestConfigurationService()],
			[IProductService, TestProductService],
			[IFileService, upcastPartial<IFileService>({})],
			[IImageResizeService, upcastPartial<IImageResizeService>({})],
		)));
		const registry = new TestMcpRegistry(parent);
		const instantiationService = store.add(parent.createChild(new ServiceCollection([IMcpRegistry, registry])));
		store.add(instantiationService.createInstance(McpLanguageModelToolContribution));
		return { toolsService, toolsObservable };
	}

	test('the display name prefers title, then annotations.title, then name', () => {
		const { toolsService } = createContribution([
			makeTool({ name: 'with_title', title: 'Pretty Title', annotations: { title: 'Annotated Title' }, inputSchema }, okResult),
			makeTool({ name: 'with_annotation', annotations: { title: 'Annotated Title' }, inputSchema }, okResult),
			makeTool({ name: 'plain_name', inputSchema }, okResult),
			makeTool({ name: 'empty_title', title: '', annotations: { title: 'Fallback Title' }, inputSchema }, okResult),
		]);

		const names = new Map(toolsService.registered.map(r => [r.data.id, r.data.displayName]));
		assert.deepStrictEqual(names, new Map([
			['mcp_test_with_title', 'Pretty Title'],
			['mcp_test_with_annotation', 'Annotated Title'],
			['mcp_test_plain_name', 'plain_name'],
			['mcp_test_empty_title', 'Fallback Title'],
		]));
	});

	test('app-only tools are not registered with the language model', () => {
		const { toolsService } = createContribution([
			makeTool({ name: 'model_tool', inputSchema }, okResult),
			makeTool({ name: 'app_tool', inputSchema }, okResult, McpToolVisibility.App),
		]);
		assert.deepStrictEqual(toolsService.registered.map(r => r.data.id), ['mcp_test_model_tool']);
		assert.deepStrictEqual(toolsService.registered[0].data.source, { type: 'mcp', serverLabel: undefined, instructions: undefined, label: 'Test Server', collectionId: 'test-collection', definitionId: 'test-server' });
	});

	async function invoke(impl: IToolImpl, toolId: string) {
		return impl.invoke({ callId: 'call-1', toolId, parameters: { a: 1 }, context: undefined }, async () => 0, { report: () => { } }, CancellationToken.None);
	}

	test('invoke reports an isError result as a tool error carrying the first text', async () => {
		const { toolsService } = createContribution([
			makeTool({ name: 'failing', inputSchema }, { isError: true, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'The server could not do that' }, { type: 'text', text: 'second text' }] }),
		]);
		const [{ impl, data }] = toolsService.registered;

		const result = await invoke(impl, data.id);
		assert.strictEqual(result.toolResultError, 'The server could not do that');
		assert.strictEqual((result.toolResultDetails as IToolResultInputOutputDetails).isError, true);
		assert.strictEqual((result.toolResultDetails as IToolResultInputOutputDetails).input, JSON.stringify({ a: 1 }, undefined, 2));
		assert.deepStrictEqual(result.content.filter(c => c.kind === 'text').map(c => c.kind === 'text' ? c.value : undefined), ['The server could not do that', 'second text']);
	});

	test('invoke reports an isError result without text as a plain error', async () => {
		const { toolsService } = createContribution([
			makeTool({ name: 'silent_failure', inputSchema }, { isError: true, content: [] }),
			makeTool({ name: 'empty_text_failure', inputSchema }, { isError: true, content: [{ type: 'text', text: '' }] }),
		]);
		for (const { impl, data } of toolsService.registered) {
			const result = await invoke(impl, data.id);
			assert.strictEqual(result.toolResultError, true, data.id);
		}
	});

	test('invoke leaves toolResultError unset for successful results', async () => {
		const { toolsService } = createContribution([
			makeTool({ name: 'ok', inputSchema }, okResult),
			makeTool({ name: 'explicitly_ok', inputSchema }, { ...okResult, isError: false }),
		]);
		for (const { impl, data } of toolsService.registered) {
			const result = await invoke(impl, data.id);
			assert.strictEqual(result.toolResultError, undefined, data.id);
			assert.strictEqual((result.toolResultDetails as IToolResultInputOutputDetails).isError, false, data.id);
			assert.deepStrictEqual(result.content, [{ kind: 'text', audience: undefined, value: 'fine' }], data.id);
		}
	});

	test('structured content replaces the text for the model', async () => {
		const { toolsService } = createContribution([
			makeTool({ name: 'structured', inputSchema }, { content: [{ type: 'text', text: '{"n":1}' }], structuredContent: { n: 1 } }),
		]);
		const [{ impl, data }] = toolsService.registered;
		const result = await invoke(impl, data.id);
		assert.strictEqual(result.toolResultError, undefined);
		assert.deepStrictEqual(result.content.map(c => c.kind === 'text' ? c.value : c.kind), ['{"n":1}']);
	});

	test('tools are re-registered when the server tool list changes', () => {
		const { toolsService, toolsObservable } = createContribution([makeTool({ name: 'first', inputSchema }, okResult)]);
		assert.deepStrictEqual(toolsService.registered.map(r => r.data.id), ['mcp_test_first']);

		toolsObservable.set([makeTool({ name: 'second', inputSchema }, okResult)], undefined);
		assert.deepStrictEqual(toolsService.registered.map(r => r.data.id), ['mcp_test_second']);
	});
});
