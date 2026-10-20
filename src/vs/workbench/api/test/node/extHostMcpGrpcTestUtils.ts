/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { JsonRpcId, JsonRpcMessage } from '../../../../base/common/jsonRpcProtocol.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { mock } from '../../../../base/test/common/mock.js';
import { LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { IMcpMessageTransport } from '../../../contrib/mcp/common/mcpRegistryTypes.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpConnectionState, McpServerTransportGrpc } from '../../../contrib/mcp/common/mcpTypes.js';
import { MainThreadMcpShape } from '../../common/extHost.protocol.js';
import { IMcpGrpcHandleOptions, McpGrpcHandle } from '../../node/extHostMcpGrpc.js';

type JsonObject = Record<string, unknown>;

/**
 * Plugs a real {@link McpGrpcHandle} into the protocol engine in process, the
 * way `mainThreadMcp.ts` and the RPC do in the product, and records what
 * crosses it.
 */
export class GrpcTestTransport extends Disposable implements IMcpMessageTransport {
	private readonly _state = observableValue<McpConnectionState>(this, { state: McpConnectionState.Kind.Starting });
	readonly state = this._state;
	private readonly _onDidLog = this._register(new Emitter<{ level: LogLevel; message: string }>());
	readonly onDidLog = this._onDidLog.event;
	private readonly _onDidReceiveMessage = this._register(new Emitter<JsonRpcMessage>());
	readonly onDidReceiveMessage = this._onDidReceiveMessage.event;
	private readonly _onDidAbortRequest = this._register(new Emitter<IMcpRequestAbort>());
	readonly onDidAbortRequest = this._onDidAbortRequest.event;

	readonly received: JsonObject[] = [];
	readonly aborts: IMcpRequestAbort[] = [];
	readonly logs: string[] = [];
	readonly envelopes: IMcpMessageEnvelope[] = [];
	/** Rewrites the envelope of an outgoing message (to provoke a header mismatch). */
	tamper: ((message: JsonRpcMessage, envelope: IMcpMessageEnvelope | undefined) => IMcpMessageEnvelope | undefined) | undefined;
	readonly handle: McpGrpcHandle;

	constructor(launch: McpServerTransportGrpc, options: IMcpGrpcHandleOptions = {}) {
		super();
		const transport = this;
		const proxy = new class extends mock<MainThreadMcpShape>() {
			override $onDidChangeState(_id: number, state: McpConnectionState): void { transport._state.set(state, undefined); }
			override $onDidPublishLog(_id: number, level: LogLevel, message: string): void {
				transport.logs.push(message);
				transport._onDidLog.fire({ level, message });
			}
			override $onDidReceiveMessage(_id: number, message: string): void {
				transport.received.push(JSON.parse(message) as JsonObject);
				transport._onDidReceiveMessage.fire(JSON.parse(message) as JsonRpcMessage);
			}
			override $onDidAbortRequest(_id: number, abort: IMcpRequestAbort): void {
				transport.aborts.push(abort);
				transport._onDidAbortRequest.fire(abort);
			}
			override async $checkMcpServerAllowed(): Promise<string | undefined> { return undefined; }
			override async $getTokenFromServerMetadata(): Promise<string | undefined> { return undefined; }
			override $logMcpAuthSetup(): void { }
		};
		this.handle = this._register(new McpGrpcHandle(1, launch, proxy, new NullLogService(), true, { proxyLookup: async () => ({}), ...options }));
	}

	send(message: JsonRpcMessage, envelope?: IMcpMessageEnvelope): void {
		const sent = this.tamper?.(message, envelope) ?? envelope;
		if (sent) {
			this.envelopes.push(sent);
		}
		this.handle.send(JSON.stringify(message), sent).catch(err => this.logs.push(`send failed: ${err}`));
	}

	cancelRequest(requestId: JsonRpcId): void {
		this.handle.cancelRequest(requestId);
	}

	stop(): void {
		void this.handle.close();
	}
}
