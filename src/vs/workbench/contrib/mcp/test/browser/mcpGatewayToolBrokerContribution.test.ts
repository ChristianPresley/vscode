/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isDisposable } from '../../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { McpGatewayToolBrokerChannelName } from '../../../../../platform/mcp/common/mcpGateway.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { McpGatewayToolBrokerContribution } from '../../browser/mcpGatewayToolBrokerContribution.js';
import { McpGatewayToolBrokerChannel } from '../../common/mcpGatewayToolBrokerChannel.js';
import { TestMcpService } from '../common/testMcpService.js';

suite('Workbench - McpGatewayToolBrokerContribution (browser)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function remoteAgent(connected: boolean, registered: [string, IServerChannel<unknown>][]): IRemoteAgentService {
		const connection = new class extends mock<IRemoteAgentConnection>() {
			override registerChannel<T extends IServerChannel<unknown>>(channelName: string, channel: T): void {
				registered.push([channelName, channel]);
			}
		};
		return new class extends mock<IRemoteAgentService>() {
			override getConnection() { return connected ? connection : null; }
		};
	}

	test('the broker channel it registers for the remote gateway is disposed with the contribution', () => {
		const registered: [string, IServerChannel<unknown>][] = [];
		const contribution = new McpGatewayToolBrokerContribution(remoteAgent(true, registered), new TestMcpService(), new NullLogService());
		assert.deepStrictEqual(registered.map(([name, channel]) => [name, channel instanceof McpGatewayToolBrokerChannel]), [[McpGatewayToolBrokerChannelName, true]]);
		// The workbench disposes the contributions that are disposable at shutdown; the leak check of this suite fails if the channel outlives it.
		assert.ok(isDisposable(contribution));
		contribution.dispose();
	});

	test('without a remote connection nothing is registered', () => {
		const registered: [string, IServerChannel<unknown>][] = [];
		const contribution = new McpGatewayToolBrokerContribution(remoteAgent(false, registered), new TestMcpService(), new NullLogService());
		assert.deepStrictEqual(registered, []);
		contribution.dispose();
	});
});
