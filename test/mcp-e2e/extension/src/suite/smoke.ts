/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * The install check of containers/verify-install.sh: records what the
 * running product reports and resolves, so the workbench exits with 0.
 * Writes the JSON to MCP_E2E_SMOKE_RESULT (default /tmp/e2e-smoke-result.json).
 */
export async function run(): Promise<void> {
	const info = {
		version: vscode.version,
		appName: vscode.env.appName,
		appHost: vscode.env.appHost,
		uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? 'desktop' : 'web',
		language: vscode.env.language,
		extensions: vscode.extensions.all.length,
		builtinMcp: vscode.extensions.all.filter(e => /mcp/i.test(e.id)).map(e => e.id),
		hasLmApi: typeof vscode.lm === 'object',
		hasMcpGateway: typeof vscode.lm.startMcpGateway === 'function',
		hasGrpcDefinition: typeof vscode.McpGrpcServerDefinition === 'function',
	};
	fs.writeFileSync(process.env.MCP_E2E_SMOKE_RESULT ?? '/tmp/e2e-smoke-result.json', JSON.stringify(info, null, 2));
	console.log('[e2e-smoke] ' + JSON.stringify(info));
}
