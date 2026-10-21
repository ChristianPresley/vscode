/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IWorkbenchLocalMcpServer, LocalMcpServerScope } from '../../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { InstalledMcpServersDiscovery } from '../../common/discovery/installedMcpServersDiscovery.js';
import { IMcpRegistry } from '../../common/mcpRegistryTypes.js';
import { IMcpWorkbenchService, McpCollectionDefinition, McpServerDefinition, McpServerTransportType } from '../../common/mcpTypes.js';

suite('InstalledMcpServersDiscovery', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function local(name: string, config: IMcpServerConfiguration): IWorkbenchLocalMcpServer {
		return { id: `user/${name}`, name, config, mcpResource: URI.parse('test://user/mcp.json'), scope: LocalMcpServerScope.User, source: 'local' };
	}

	async function discover(servers: IWorkbenchLocalMcpServer[]): Promise<readonly McpServerDefinition[]> {
		const collections: McpCollectionDefinition[] = [];
		const workbenchService = upcastPartial<IMcpWorkbenchService>({
			onChange: Event.None,
			getEnabledLocalMcpServers: () => servers,
			// No configuration file: the definitions carry no file locations.
			getMcpConfigPath: (() => undefined) as unknown as IMcpWorkbenchService['getMcpConfigPath'],
		});
		const registry = upcastPartial<IMcpRegistry>({
			registerCollection: collection => {
				collections.push(collection);
				return Disposable.None;
			},
		});
		const discovery = store.add(new InstalledMcpServersDiscovery(workbenchService, registry, upcastPartial<ITextModelService>({}), new NullLogService()));
		discovery.start();
		for (let waited = 0; collections.length === 0; waited += 5) {
			assert.ok(waited < 5000, 'no collection was registered');
			await timeout(5);
		}
		return collections.flatMap(collection => collection.serverDefinitions.get());
	}

	test('a gRPC server keeps its protocolVersion as the hint and its transport settings in the launch, like an HTTP server', async () => {
		const definitions = await discover([
			local('grpc', { type: McpServerType.GRPC, url: 'grpcs://mcp.example:443', binding: 'typed', keepAliveMs: 0, deadlineMs: 30_000, tls: { serverName: 'mcp.internal' }, protocolVersion: '2025-11-25' }),
			local('http', { type: McpServerType.REMOTE, url: 'https://mcp.example/mcp', protocolVersion: '2025-06-18' }),
			local('grpc-default', { type: McpServerType.GRPC, url: 'grpc://127.0.0.1:50051' }),
		]);
		assert.deepStrictEqual(definitions.map(d => ({
			label: d.label,
			hint: d.protocolVersionHint,
			launch: d.launch.type === McpServerTransportType.Grpc
				? { uri: d.launch.uri.toString(true), binding: d.launch.binding, keepAliveMs: d.launch.keepAliveMs, deadlineMs: d.launch.deadlineMs, tls: d.launch.tls }
				: d.launch.type,
		})), [
			{ label: 'grpc', hint: '2025-11-25', launch: { uri: 'grpcs://mcp.example:443', binding: 'typed', keepAliveMs: 0, deadlineMs: 30_000, tls: { serverName: 'mcp.internal' } } },
			{ label: 'http', hint: '2025-06-18', launch: McpServerTransportType.HTTP },
			{ label: 'grpc-default', hint: undefined, launch: { uri: 'grpc://127.0.0.1:50051', binding: undefined, keepAliveMs: undefined, deadlineMs: undefined, tls: undefined } },
		]);
	});
});
