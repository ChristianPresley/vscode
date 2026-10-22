/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { toolPickerLabels } from '../../../browser/actions/chatToolPicker.js';
import { IToolData, ToolDataSource } from '../../../common/tools/languageModelToolsService.js';

suite('chatToolPicker - tool labels', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const mcpSource: ToolDataSource = { type: 'mcp', label: 'Everything', serverLabel: 'mcp-conformance-test-server', instructions: undefined, collectionId: 'c', definitionId: 'd' };

	function tool(overrides: Partial<IToolData>): IToolData {
		return { id: 'mcp_everything_echo', source: mcpSource, displayName: 'echo', toolReferenceName: 'echo', modelDescription: 'Echoes back the input', ...overrides };
	}

	test('an MCP tool with a title is listed by its title, with the reference name in its description', () => {
		assert.deepStrictEqual(toolPickerLabels(tool({ displayName: 'Echo Tool' })), { label: 'Echo Tool', description: 'echo - Echoes back the input' });
		assert.deepStrictEqual(toolPickerLabels(tool({ displayName: 'Echo Tool', userDescription: 'Repeats text' })), { label: 'Echo Tool', description: 'echo - Repeats text' });
		assert.deepStrictEqual(toolPickerLabels(tool({ displayName: 'Echo Tool', modelDescription: '' })), { label: 'Echo Tool', description: 'echo' });
	});

	test('an MCP tool without a title of its own keeps its reference name as label', () => {
		assert.deepStrictEqual(toolPickerLabels(tool({})), { label: 'echo', description: 'Echoes back the input' });
		assert.deepStrictEqual(toolPickerLabels(tool({ toolReferenceName: undefined, displayName: 'Echo Tool' })), { label: 'Echo Tool', description: 'Echoes back the input' });
	});

	test('other tools keep their reference name as label', () => {
		assert.deepStrictEqual(toolPickerLabels(tool({ source: ToolDataSource.Internal, displayName: 'Codebase', toolReferenceName: 'codebase', modelDescription: 'Search the codebase' })), { label: 'codebase', description: 'Search the codebase' });
	});
});
