/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { startControlServer } from './control';
import { E2eHarness } from './harness';
import { LLAMA_VENDOR, LlamaChatProvider } from './llamaProvider';
import { log } from './runner';

export interface IMcpE2eApi {
	readonly harness: E2eHarness;
}

export function activate(context: vscode.ExtensionContext): IMcpE2eApi {
	const harness = new E2eHarness(context);
	log(`activated: llama=${harness.env.llamaUrl} results=${harness.env.resultsDir} control=${harness.env.controlPort ?? '-'} logs=${harness.windowLogsDir}`);

	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(LLAMA_VENDOR, new LlamaChatProvider(harness.env)));

	// The gRPC servers defined through the extension API (proposal mcpGrpcServerDefinition): binding
	// Auto against the tunnel server, Typed against the typed server, and TLS with the run's CA.
	const apiServers = harness.servers.filter(s => s.provider);
	if (apiServers.length) {
		const bindings = { auto: vscode.McpGrpcBinding.Auto, tunnel: vscode.McpGrpcBinding.Tunnel, typed: vscode.McpGrpcBinding.Typed };
		const definitions = apiServers.map(s => {
			const p = s.provider!;
			const tls = p.tls ? { ...p.tls, ...(p.tls.ca === '{tlsCa}' ? { ca: harness.env.tlsCa } : {}) } : undefined;
			// Mutation api-binding-typed (runner/mutations.ts): the Auto definition is Typed instead.
			const binding = harness.env.mutations.has('api-binding-typed') && (p.binding ?? 'auto') === 'auto' ? 'typed' : p.binding ?? 'auto';
			return new vscode.McpGrpcServerDefinition(s.label, vscode.Uri.parse(p.url), undefined, '1.0.0', tls, bindings[binding]);
		});
		context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('e2e-grpc', {
			provideMcpServerDefinitions: () => definitions,
		}));
	}

	if (harness.env.controlPort) {
		context.subscriptions.push(startControlServer(harness, harness.env.controlPort));
	}
	return { harness };
}

export function deactivate(): void { }
