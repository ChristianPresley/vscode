/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { ResourceSet } from '../../../../../../base/common/map.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IProductService } from '../../../../../../platform/product/common/productService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { PromptsServiceCustomizationItemProvider } from '../../../browser/aiCustomization/promptsServiceCustomizationItemProvider.js';
import { IAICustomizationWorkspaceService } from '../../../common/aiCustomizationWorkspaceService.js';
import { PromptsType } from '../../../common/promptSyntax/promptTypes.js';
import { IAgentSkill, IPromptsService, PromptsStorage } from '../../../common/promptSyntax/service/promptsService.js';

suite('PromptsServiceCustomizationItemProvider - MCP-served skills', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function mcpSkill(serverId: string, serverLabel: string, name: string): IAgentSkill {
		const skillUri = `skill://${name}/SKILL.md`;
		return {
			uri: URI.from({ scheme: 'mcp-resource', authority: serverId, path: `/skill/${name}/SKILL.md` }),
			storage: PromptsStorage.mcp,
			name,
			description: `${name} skill`,
			disableModelInvocation: false,
			userInvocable: false,
			mcp: { serverId, serverLabel, skillUri },
		};
	}

	function provider(provided: IAgentSkill[], disabled: ResourceSet): PromptsServiceCustomizationItemProvider {
		const promptsService = new class extends mock<IPromptsService>() {
			override onDidChangeCustomAgents = Event.None;
			override onDidChangeSlashCommands = Event.None;
			override onDidChangeSkills = Event.None;
			override onDidChangeHooks = Event.None;
			override onDidChangeInstructions = Event.None;
			override onDidChangeAgentInstructions = Event.None;
			// chat lists the enabled skills only; the view asks the providers for all of them
			override async findAgentSkills() { return provided.filter(s => !disabled.has(s.uri)); }
			override async getProvidedAgentSkills() { return provided; }
			override async listPromptFiles() { return []; }
			override async listPromptFilesForStorage() { return []; }
			override async getCustomAgents() { return []; }
			override async getHooks() { return undefined; }
			override async getInstructionFiles() { return []; }
			override async getPromptSlashCommands() { return []; }
			override async listAgentInstructions() { return []; }
			override getDisabledPromptFiles() { return disabled; }
		};
		return new PromptsServiceCustomizationItemProvider(promptsService, new class extends mock<IAICustomizationWorkspaceService>() { }, new class extends mock<IProductService>() { }, new class extends mock<IWorkspaceContextService>() { });
	}

	test('lists each MCP-served skill once, in the MCP group, named with its server, read-only, the disabled ones included', async () => {
		const pdf = mcpSkill('server.a', 'Server A', 'pdf-processing');
		const refunds = mcpSkill('server.b', 'Server B', 'refunds');
		const disabled = new ResourceSet([refunds.uri]);
		const items = (await provider([pdf, refunds], disabled).provideChatSessionCustomizations(URI.parse('local:///session'), CancellationToken.None))
			.filter(item => item.type === PromptsType.skill);

		assert.deepStrictEqual(items.map(item => ({ uri: item.uri.toString(), name: item.name, source: item.source, groupKey: item.groupKey, enabled: item.enabled, badge: item.badge, badgeTooltip: item.badgeTooltip, userInvocable: item.userInvocable })), [
			{ uri: pdf.uri.toString(), name: 'pdf-processing', source: 'mcp', groupKey: 'mcp', enabled: true, badge: 'Server A', badgeTooltip: 'Served by the MCP server \'Server A\' as skill://pdf-processing/SKILL.md', userInvocable: false },
			{ uri: refunds.uri.toString(), name: 'refunds', source: 'mcp', groupKey: 'mcp', enabled: false, badge: 'Server B', badgeTooltip: 'Served by the MCP server \'Server B\' as skill://refunds/SKILL.md', userInvocable: false },
		]);
	});
});
