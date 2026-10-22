/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { McpGatewayToolBrokerChannelName } from '../../../../platform/mcp/common/mcpGateway.js';
import { IMcpService } from '../common/mcpTypes.js';
import { McpGatewayToolBrokerChannel } from '../common/mcpGatewayToolBrokerChannel.js';

/** Serves the tool broker to the local gateway; the channel (its listeners and resource subscriptions) lives as long as the contribution. */
export class McpGatewayToolBrokerContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IMcpService mcpService: IMcpService,
		@ILogService logService: ILogService,
	) {
		super();
		mainProcessService.registerChannel(McpGatewayToolBrokerChannelName, this._register(new McpGatewayToolBrokerChannel(mcpService, logService)));
	}
}
