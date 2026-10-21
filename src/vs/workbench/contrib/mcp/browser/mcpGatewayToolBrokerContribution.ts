/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { McpGatewayToolBrokerChannelName } from '../../../../platform/mcp/common/mcpGateway.js';
import { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';
import { IMcpService } from '../common/mcpTypes.js';
import { McpGatewayToolBrokerChannel } from '../common/mcpGatewayToolBrokerChannel.js';

/** Serves the tool broker to the remote gateway; the channel (its listeners and resource subscriptions) lives as long as the contribution. */
export class McpGatewayToolBrokerContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@IRemoteAgentService remoteAgentService: IRemoteAgentService,
		@IMcpService mcpService: IMcpService,
		@ILogService logService: ILogService,
	) {
		super();
		const connection = remoteAgentService.getConnection();
		if (connection) {
			connection.registerChannel(McpGatewayToolBrokerChannelName, this._register(new McpGatewayToolBrokerChannel(mcpService, logService)));
		}
	}
}
