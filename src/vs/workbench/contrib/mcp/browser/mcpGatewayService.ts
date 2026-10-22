/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMcpGatewayCreateOptions, IMcpGatewayServerInfo, McpGatewayChannelName } from '../../../../platform/mcp/common/mcpGateway.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { IMcpGatewayResult, IWorkbenchMcpGatewayService, mcpGatewayCreateArgs, reviveMcpGatewayServers } from '../common/mcpGatewayService.js';

/**
 * Browser implementation of the MCP Gateway Service.
 *
 * In browser/serverless web environments without a remote connection,
 * there is no Node.js process available to create an HTTP server.
 *
 * When running with a remote connection, the gateway is created on the
 * remote server via IPC.
 */
export class BrowserMcpGatewayService implements IWorkbenchMcpGatewayService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async createGateway(inRemote: boolean, chatSessionResource?: URI, options?: IMcpGatewayCreateOptions): Promise<IMcpGatewayResult | undefined> {
		this._logService.debug(`[McpGateway][BrowserWorkbench] createGateway requested (inRemote=${inRemote}, grpc=${options?.grpc === true})`);

		// Browser can only create gateways in remote environment
		if (!inRemote) {
			this._logService.info('[McpGateway][BrowserWorkbench] Cannot create local gateway in browser environment');
			return undefined;
		}

		const connection = this._remoteAgentService.getConnection();
		if (!connection) {
			this._logService.info('[McpGateway][BrowserWorkbench] No remote connection available (serverless web)');
			return undefined;
		}

		this._logService.info('[McpGateway][BrowserWorkbench] Creating remote gateway via remote server');
		// Use the remote server's gateway service
		return connection.withChannel(McpGatewayChannelName, async channel => {
			const info = await channel.call<{ gatewayId: string; servers: readonly IMcpGatewayServerInfo[] }>(
				'createGateway',
				mcpGatewayCreateArgs(chatSessionResource, options)
			);
			const servers = reviveMcpGatewayServers(info.servers);
			this._logService.info(`[McpGateway][BrowserWorkbench] Remote gateway created with ${servers.length} server(s)`);

			const onDidChangeServers = Event.map(
				Event.filter(
					channel.listen<{ gatewayId: string; servers: readonly IMcpGatewayServerInfo[] }>('onDidChangeGatewayServers'),
					e => e.gatewayId === info.gatewayId,
				),
				e => reviveMcpGatewayServers(e.servers),
			);

			return {
				servers,
				onDidChangeServers,
				dispose: () => {
					this._logService.info(`[McpGateway][BrowserWorkbench] Disposing remote gateway: ${info.gatewayId}`);
					void channel.call('disposeGateway', info.gatewayId).then(undefined, error => {
						this._logService.warn(`[McpGateway][BrowserWorkbench] Failed to dispose remote gateway: ${info.gatewayId}`, error);
					});
				}
			};
		});
	}
}
