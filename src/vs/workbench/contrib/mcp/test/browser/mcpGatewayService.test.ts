/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMcpGatewayServerInfo, McpGatewayChannelName } from '../../../../../platform/mcp/common/mcpGateway.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { BrowserMcpGatewayService } from '../../browser/mcpGatewayService.js';

interface IGatewayServersEvent {
	readonly gatewayId: string;
	readonly servers: readonly IMcpGatewayServerInfo[];
}

/** What crosses the IPC channel: plain JSON, URIs as components. */
function wire<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

suite('Workbench - BrowserMcpGatewayService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('the remote gateway\'s servers keep their grpcAddress through IPC, also when they change', async () => {
		const onDidChange = store.add(new Emitter<IGatewayServersEvent>());
		const calls: [string, unknown][] = [];
		const channel: IChannel = {
			call: async <T>(command: string, arg?: unknown): Promise<T> => {
				calls.push([command, arg]);
				if (command === 'createGateway') {
					return wire({
						gatewayId: 'gw-1',
						servers: [{ label: 'One', address: URI.parse('http://127.0.0.1:4100/gateway/r1'), grpcAddress: URI.parse('grpc://127.0.0.1:4101/r1') }],
					}) as T;
				}
				return undefined as T;
			},
			listen: <T>(event: string): Event<T> => {
				assert.strictEqual(event, 'onDidChangeGatewayServers');
				return onDidChange.event as Event<unknown> as Event<T>;
			},
		};
		const connection = new class extends mock<IRemoteAgentConnection>() {
			override withChannel<T extends IChannel, R>(channelName: string, callback: (channel: T) => Promise<R>): Promise<R> {
				assert.strictEqual(channelName, McpGatewayChannelName);
				return callback(channel as T);
			}
		};
		const remoteAgent = new class extends mock<IRemoteAgentService>() {
			override getConnection() { return connection; }
		};
		const service = new BrowserMcpGatewayService(remoteAgent, new NullLogService());

		assert.strictEqual(await service.createGateway(false), undefined, 'no local gateway in the browser');
		const gateway = await service.createGateway(true, URI.parse('chat-session:/s1'));
		assert.ok(gateway);
		assert.deepStrictEqual(calls[0], ['createGateway', { chatSessionResource: 'chat-session:/s1' }]);
		const [server] = gateway.servers;
		assert.ok(URI.isUri(server.address) && URI.isUri(server.grpcAddress));
		assert.strictEqual(server.grpcAddress.toString(true), 'grpc://127.0.0.1:4101/r1');

		const changes: (string | undefined)[][] = [];
		store.add(gateway.onDidChangeServers(servers => changes.push(servers.map(s => s.grpcAddress?.toString(true)))));
		onDidChange.fire(wire({ gatewayId: 'other', servers: [{ label: 'X', address: URI.parse('http://127.0.0.1:1/gateway/x') }] }));
		onDidChange.fire(wire({
			gatewayId: 'gw-1',
			servers: [
				{ label: 'One', address: URI.parse('http://127.0.0.1:4100/gateway/r1'), grpcAddress: URI.parse('grpc://127.0.0.1:4101/r1') },
				{ label: 'Two', address: URI.parse('http://127.0.0.1:4100/gateway/r2') },
			],
		}));
		assert.deepStrictEqual(changes, [['grpc://127.0.0.1:4101/r1', undefined]], 'only this gateway\'s changes, revived');

		gateway.dispose();
		await Promise.resolve();
		assert.deepStrictEqual(calls[1], ['disposeGateway', 'gw-1']);
	});

	test('the remote gateway asks the remote server for gRPC only when the caller does', async () => {
		const calls: [string, unknown][] = [];
		const channel: IChannel = {
			call: async <T>(command: string, arg?: unknown): Promise<T> => {
				calls.push([command, arg]);
				return wire({ gatewayId: `gw-${calls.length}`, servers: [] }) as T;
			},
			listen: <T>(): Event<T> => Event.None,
		};
		const connection = new class extends mock<IRemoteAgentConnection>() {
			override withChannel<T extends IChannel, R>(_channelName: string, callback: (channel: T) => Promise<R>): Promise<R> {
				return callback(channel as T);
			}
		};
		const remoteAgent = new class extends mock<IRemoteAgentService>() {
			override getConnection() { return connection; }
		};
		const service = new BrowserMcpGatewayService(remoteAgent, new NullLogService());
		const session = URI.parse('chat-session:/s1');

		const gateways = [
			await service.createGateway(true),
			await service.createGateway(true, session),
			await service.createGateway(true, undefined, { grpc: false }),
			await service.createGateway(true, undefined, { grpc: true }),
			await service.createGateway(true, session, { grpc: true }),
		];
		assert.deepStrictEqual(calls, [
			['createGateway', undefined],
			['createGateway', { chatSessionResource: 'chat-session:/s1' }],
			['createGateway', undefined],
			['createGateway', { grpc: true }],
			['createGateway', { chatSessionResource: 'chat-session:/s1', grpc: true }],
		]);
		assert.strictEqual(await service.createGateway(false, session, { grpc: true }), undefined, 'still no local gateway in the browser');
		for (const gateway of gateways) {
			gateway?.dispose();
		}
	});
});
