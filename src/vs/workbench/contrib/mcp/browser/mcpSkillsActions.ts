/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { AI_CUSTOMIZATION_ITEM_STORAGE_KEY, AI_CUSTOMIZATION_ITEM_TYPE_KEY, AICustomizationManagementItemMenuId } from '../../chat/browser/aiCustomization/aiCustomizationManagement.js';
import { PromptsType } from '../../chat/common/promptSyntax/promptTypes.js';
import { PromptsStorage } from '../../chat/common/promptSyntax/service/promptsService.js';
import { McpCommandIds } from '../common/mcpCommandIds.js';
import { McpSkillApprovals } from '../common/mcpSkillsChat.js';
import { McpResourceURI } from '../common/mcpTypes.js';

/**
 * The user's approvals of MCP-served skills (Skills extension, SEP-2640):
 * revoking one from the skill's row in the customization view, or all of them
 * from the command palette. A revoked skill asks for approval at its next load.
 */

/** The server and `SKILL.md` URI of a skill row: its URI is the skill's `mcp-resource:` URI. */
function skillOfRow(context: unknown): { serverId: string; uri: string } | undefined {
	const value = typeof context === 'object' && context !== null ? (context as { uri?: unknown }).uri : undefined;
	if (typeof value !== 'string') {
		return undefined;
	}
	try {
		const { definitionId, resourceURL } = McpResourceURI.toServer(URI.parse(value));
		return { serverId: definitionId, uri: resourceURL.toString() };
	} catch {
		return undefined;
	}
}

export class McpRevokeSkillApprovalAction extends Action2 {
	constructor() {
		super({
			id: McpCommandIds.RevokeSkillApproval,
			title: localize2('mcp.skills.revokeApproval', "Revoke Approval"),
		});
	}

	async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
		const notificationService = accessor.get(INotificationService);
		const skill = skillOfRow(context);
		if (!skill) {
			return;
		}
		const revoked = new McpSkillApprovals(accessor.get(IStorageService)).revoke(skill.serverId, skill.uri);
		notificationService.info(revoked
			? localize('mcp.skills.approvalRevoked', "The approval of the skill {0} is revoked. Its next load asks for your approval again.", skill.uri)
			: localize('mcp.skills.notApproved', "The skill {0} has no approval to revoke: its next load asks for your approval.", skill.uri));
	}
}

export class McpRevokeAllSkillApprovalsAction extends Action2 {
	constructor() {
		super({
			id: McpCommandIds.RevokeAllSkillApprovals,
			title: localize2('mcp.skills.revokeAllApprovals', "Revoke All Skill Approvals"),
			category: localize2('mcp.category', "MCP"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const approvals = new McpSkillApprovals(accessor.get(IStorageService));
		const count = approvals.approved().length;
		if (count === 0) {
			notificationService.info(localize('mcp.skills.noApprovals', "No skill from an MCP server is approved."));
			return;
		}
		const { confirmed } = await dialogService.confirm({
			message: localize('mcp.skills.revokeAllConfirm', "Revoke the approval of {0} skill(s) from MCP servers?", count),
			detail: localize('mcp.skills.revokeAllDetail', "Each of them asks for your approval again at its next load."),
			primaryButton: localize({ key: 'mcp.skills.revokeAllButton', comment: ['&& denotes a mnemonic'] }, "&&Revoke"),
		});
		if (confirmed) {
			approvals.revokeAll();
		}
	}
}

MenuRegistry.appendMenuItem(AICustomizationManagementItemMenuId, {
	command: { id: McpCommandIds.RevokeSkillApproval, title: localize('mcp.skills.revokeApproval', "Revoke Approval") },
	group: '5_toggle',
	order: 2,
	when: ContextKeyExpr.and(
		ContextKeyExpr.equals(AI_CUSTOMIZATION_ITEM_TYPE_KEY, PromptsType.skill),
		ContextKeyExpr.equals(AI_CUSTOMIZATION_ITEM_STORAGE_KEY, PromptsStorage.mcp),
	),
});
