/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMcpGatewayServerInfo } from '../../../../../platform/mcp/common/mcpGateway.js';
import { mcpGatewayCreateArgs, reviveMcpGatewayServers } from '../../common/mcpGatewayService.js';

/** What the servers look like after IPC (URIs as plain components). */
function overTheWire(servers: readonly IMcpGatewayServerInfo[]): readonly IMcpGatewayServerInfo[] {
	return JSON.parse(JSON.stringify(servers));
}

suite('Workbench - MCP gateway servers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reviveMcpGatewayServers revives both addresses; grpcAddress only when the gateway serves gRPC', () => {
		const servers = reviveMcpGatewayServers(overTheWire([
			{ label: 'With gRPC', address: URI.parse('http://127.0.0.1:4100/gateway/route-1'), grpcAddress: URI.parse('grpc://127.0.0.1:4101/route-1') },
			{ label: 'HTTP only', address: URI.parse('http://127.0.0.1:4100/gateway/route-2') },
		]));
		assert.strictEqual(servers.length, 2);
		const [withGrpc, httpOnly] = servers;
		assert.ok(URI.isUri(withGrpc.address) && URI.isUri(withGrpc.grpcAddress));
		assert.strictEqual(withGrpc.label, 'With gRPC');
		assert.strictEqual(withGrpc.address.toString(true), 'http://127.0.0.1:4100/gateway/route-1');
		assert.strictEqual(withGrpc.grpcAddress.toString(true), 'grpc://127.0.0.1:4101/route-1');
		assert.deepStrictEqual([withGrpc.grpcAddress.scheme, withGrpc.grpcAddress.authority, withGrpc.grpcAddress.path], ['grpc', '127.0.0.1:4101', '/route-1']);
		assert.ok(URI.isUri(httpOnly.address));
		assert.strictEqual(httpOnly.grpcAddress, undefined);
		assert.ok(!Object.prototype.hasOwnProperty.call(httpOnly, 'grpcAddress'), 'no grpcAddress key at all');
	});

	test('mcpGatewayCreateArgs asks for gRPC only with grpc: true, and sends nothing without a chat session or gRPC', () => {
		const session = URI.parse('chat-session:/s1');
		assert.deepStrictEqual([
			mcpGatewayCreateArgs(undefined, undefined),
			mcpGatewayCreateArgs(undefined, {}),
			mcpGatewayCreateArgs(undefined, { grpc: false }),
			mcpGatewayCreateArgs(session, undefined),
			mcpGatewayCreateArgs(session, { grpc: false }),
			mcpGatewayCreateArgs(undefined, { grpc: true }),
			mcpGatewayCreateArgs(session, { grpc: true }),
		], [
			undefined,
			undefined,
			undefined,
			{ chatSessionResource: 'chat-session:/s1' },
			{ chatSessionResource: 'chat-session:/s1' },
			{ grpc: true },
			{ chatSessionResource: 'chat-session:/s1', grpc: true },
		]);
	});
});
