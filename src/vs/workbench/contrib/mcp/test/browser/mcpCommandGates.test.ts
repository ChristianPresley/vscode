/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import * as mcpCommands from '../../browser/mcpCommands.js';
import * as mcpSkillsActions from '../../browser/mcpSkillsActions.js';

/**
 * The commands of the MCP contribution that the command palette offers. Each
 * one is hidden while AI features are disabled (`chat.disableAIFeatures`), as
 * the smoke test "Chat Disabled" requires, which runs only in the Electron
 * smoke suite: this test catches a new command without the gate on any
 * platform.
 */
suite('MCP command palette gates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('every MCP command in the command palette is hidden while AI features are disabled', () => {
		const ungated: string[] = [];
		let checked = 0;
		for (const exported of [...Object.values(mcpCommands), ...Object.values(mcpSkillsActions)]) {
			if (typeof exported !== 'function' || !(exported.prototype instanceof Action2)) {
				continue;
			}
			const action = new (exported as new () => Action2)();
			if (!action.desc.f1) {
				continue;
			}
			checked++;
			const keys = action.desc.precondition?.keys() ?? [];
			if (!keys.includes(ChatContextKeys.Setup.hidden.key) || !keys.includes(ChatContextKeys.Setup.disabledInWorkspace.key)) {
				ungated.push(action.desc.id);
			}
		}
		assert.ok(checked > 10, `found ${checked} palette commands`);
		assert.deepStrictEqual(ungated, []);
	});
});
