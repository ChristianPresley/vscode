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
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IMcpGatewayServerInfo, McpGatewayChannelName } from '../../../../../platform/mcp/common/mcpGateway.js';
import { IRemoteAgentConnection, IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import { WorkbenchMcpGatewayService } from '../../electron-browser/mcpGatewayService.js';

interface IGatewayServersEvent {
	readonly gatewayId: string;
	readonly servers: readonly IMcpGatewayServerInfo[];
}

/** What crosses the IPC channel: plain JSON, URIs as components. */
function wire<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

/** A `McpGatewayChannelName` channel (of the main process or of the remote server) that records its calls. */
class RecordingChannel implements IChannel {
	readonly calls: [string, unknown][] = [];
	constructor(
		private readonly _name: string,
		private readonly _servers: readonly IMcpGatewayServerInfo[],
		private readonly _onDidChangeGatewayServers: Event<IGatewayServersEvent>,
	) { }

	async call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push([command, arg]);
		if (command === 'createGateway') {
			return wire({ gatewayId: `${this._name}-${this.calls.length}`, servers: this._servers }) as T;
		}
		return undefined as T;
	}

	listen<T>(event: string): Event<T> {
		assert.strictEqual(event, 'onDidChangeGatewayServers');
		return this._onDidChangeGatewayServers as Event<unknown> as Event<T>;
	}
}

suite('Workbench - WorkbenchMcpGatewayService (electron-browser)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const servers: IMcpGatewayServerInfo[] = [
		{ label: 'One', address: URI.parse('http://127.0.0.1:4100/gateway/r1'), grpcAddress: URI.parse('grpc://127.0.0.1:4101/r1') },
		{ label: 'Two', address: URI.parse('http://127.0.0.1:4100/gateway/r2') },
	];

	function setup(remote: boolean) {
		const onDidChange = store.add(new Emitter<IGatewayServersEvent>());
		const local = new RecordingChannel('local', servers, onDidChange.event);
		const remoteChannel = new RecordingChannel('remote', servers, onDidChange.event);
		const mainProcess = new class extends mock<IMainProcessService>() {
			override getChannel(channelName: string): IChannel {
				assert.strictEqual(channelName, McpGatewayChannelName);
				return local;
			}
		};
		const connection = new class extends mock<IRemoteAgentConnection>() {
			override withChannel<T extends IChannel, R>(channelName: string, callback: (channel: T) => Promise<R>): Promise<R> {
				assert.strictEqual(channelName, McpGatewayChannelName);
				return callback(remoteChannel as unknown as T);
			}
		};
		const remoteAgent = new class extends mock<IRemoteAgentService>() {
			override getConnection() { return remote ? connection : null; }
		};
		const service = new WorkbenchMcpGatewayService(mainProcess, remoteAgent, new NullLogService());
		return { service, local, remote: remoteChannel, onDidChange };
	}

	test('the local gateway (main process) asks for gRPC only when the caller does, and keeps grpcAddress through IPC', async () => {
		const { service, local, remote, onDidChange } = setup(true);
		const session = URI.parse('chat-session:/s1');

		const gateways = [
			await service.createGateway(false),
			await service.createGateway(false, session),
			await service.createGateway(false, undefined, { grpc: false }),
			await service.createGateway(false, undefined, { grpc: true }),
			await service.createGateway(false, session, { grpc: true }),
		];
		assert.deepStrictEqual(local.calls, [
			['createGateway', undefined],
			['createGateway', { chatSessionResource: 'chat-session:/s1' }],
			['createGateway', undefined],
			['createGateway', { grpc: true }],
			['createGateway', { chatSessionResource: 'chat-session:/s1', grpc: true }],
		]);
		assert.deepStrictEqual(remote.calls, [], 'a local gateway does not go to the remote server');

		const gateway = gateways[4];
		assert.ok(gateway);
		const [withGrpc, httpOnly] = gateway.servers;
		assert.ok(URI.isUri(withGrpc.address) && URI.isUri(withGrpc.grpcAddress), 'revived after the wire');
		assert.deepStrictEqual([withGrpc.grpcAddress.toString(true), httpOnly.grpcAddress], ['grpc://127.0.0.1:4101/r1', undefined]);

		const changes: (string | undefined)[][] = [];
		store.add(gateway.onDidChangeServers(changed => changes.push(changed.map(s => s.grpcAddress?.toString(true)))));
		onDidChange.fire(wire({ gatewayId: 'local-1', servers: [] }));
		onDidChange.fire(wire({ gatewayId: 'local-5', servers: [servers[1], servers[0]] }));
		assert.deepStrictEqual(changes, [[undefined, 'grpc://127.0.0.1:4101/r1']], 'only this gateway\'s changes, revived');

		for (const g of gateways) {
			g?.dispose();
		}
		await Promise.resolve();
		assert.deepStrictEqual(local.calls.slice(5), ['local-1', 'local-2', 'local-3', 'local-4', 'local-5'].map(id => ['disposeGateway', id]));
	});

	test('the remote gateway asks the remote server for gRPC only when the caller does; without a connection there is none', async () => {
		const { service, local, remote } = setup(true);
		const session = URI.parse('chat-session:/s2');

		const gateways = [
			await service.createGateway(true),
			await service.createGateway(true, session),
			await service.createGateway(true, undefined, { grpc: false }),
			await service.createGateway(true, undefined, { grpc: true }),
			await service.createGateway(true, session, { grpc: true }),
		];
		assert.deepStrictEqual(remote.calls, [
			['createGateway', undefined],
			['createGateway', { chatSessionResource: 'chat-session:/s2' }],
			['createGateway', undefined],
			['createGateway', { grpc: true }],
			['createGateway', { chatSessionResource: 'chat-session:/s2', grpc: true }],
		]);
		assert.deepStrictEqual(local.calls, [], 'a remote gateway does not go to the main process');
		assert.strictEqual(gateways[4]?.servers[0].grpcAddress?.toString(true), 'grpc://127.0.0.1:4101/r1');
		for (const g of gateways) {
			g?.dispose();
		}

		const disconnected = setup(false);
		assert.strictEqual(await disconnected.service.createGateway(true, session, { grpc: true }), undefined);
		assert.deepStrictEqual([disconnected.local.calls, disconnected.remote.calls], [[], []]);
	});
});
