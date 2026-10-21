/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { IMcpGatewayCancellable, McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { META_SUBSCRIPTION_ID } from '../common/mcpProtocolVersions.js';
import { MCP } from '../common/modelContextProtocol.js';
import { IMcpGatewayNotification, McpGatewayDispatcher } from './mcpGatewayDispatcher.js';

/** The most `subscriptions/listen` streams one route keeps open at a time. */
export const MAX_LISTEN_STREAMS = 64;

/** The response stream of one `subscriptions/listen` request. */
export interface IMcpGatewayListenStream {
	notify(notification: IMcpGatewayNotification): void;
	/** Writes the final (graceful) result of the listen request and closes the stream (the server ends the subscription). */
	complete(result: object): void;
	/**
	 * Closes the stream without a result: the client cancelled the listen
	 * request with `notifications/cancelled`, and a server SHOULD NOT answer a
	 * cancelled request (basic/patterns/cancellation). Only a stream that such
	 * a notification can reach has it (Streamable HTTP); the others are not
	 * among the {@link McpGatewayListenRegistry.cancellables} (a gRPC client
	 * cancels with RST_STREAM, which ends the call itself).
	 */
	cancel?(): void;
}

/** An open listen stream that a `notifications/cancelled` can reach ({@link McpGatewayListenRegistry.cancellables}). */
export interface IMcpGatewayListenCancellable extends IMcpGatewayCancellable {
	/** Closes the stream without a result ({@link IMcpGatewayListenStream.cancel}). */
	cancel(): void;
}

interface IListenEntry extends IMcpGatewayCancellable {
	readonly requestId: JsonRpcId;
	/** Who opened the stream (see the route's client key); a cancellation of another client does not reach it. */
	readonly owner: string | undefined;
	/** The address part of {@link owner} (the `peer` of the sender of the listen request). */
	readonly peer: string | undefined;
	readonly filter: MCP.SubscriptionFilter;
	readonly stream: IMcpGatewayListenStream;
	readonly subscriptions: DisposableStore;
	closed: boolean;
	/** The disposable `register` handed out; disposed when the stream closes for any reason. */
	registration?: IDisposable;
}

/**
 * The 2026-07-28 `subscriptions/listen` streams of one route. Each stream
 * gets its acknowledgement first, then only the notification kinds the
 * server honoured, every one tagged with the stream's subscription id (the
 * JSON-RPC id of the listen request). The protocol is stateless, so two
 * clients may well use the same request id: entries are kept per stream,
 * each with the key of the client that opened it.
 */
export class McpGatewayListenRegistry extends Disposable {
	private readonly _entries = new Set<IListenEntry>();

	constructor(
		private readonly _dispatcher: McpGatewayDispatcher,
		private readonly _invoker: IMcpGatewaySingleServerInvoker,
		private readonly _logger: ILogger,
	) {
		super();
		this._register(_invoker.onDidChangeTools(() => this._broadcast(e => !!e.filter.toolsListChanged, 'notifications/tools/list_changed', {})));
		this._register(_invoker.onDidChangeResources(() => this._broadcast(e => !!e.filter.resourcesListChanged, 'notifications/resources/list_changed', {})));
		if (_invoker.onDidChangePrompts) {
			this._register(_invoker.onDidChangePrompts(() => this._broadcast(e => !!e.filter.promptsListChanged, 'notifications/prompts/list_changed', {})));
		}
		if (_invoker.onDidUpdateResource) {
			this._register(_invoker.onDidUpdateResource(({ uri }) => this._broadcast(e => !!e.filter.resourceSubscriptions?.includes(uri), 'notifications/resources/updated', { uri })));
		}
	}

	/** The number of open streams. */
	get size(): number {
		return this._entries.size;
	}

	/** Whether a stream opened by a listen request with this id is open. */
	has(requestId: JsonRpcId): boolean {
		return this._find(requestId).length > 0;
	}

	/** The filter the (first) stream with this request id was acknowledged with. */
	filterOf(requestId: JsonRpcId): MCP.SubscriptionFilter | undefined {
		return this._find(requestId)[0]?.filter;
	}

	/**
	 * Opens a stream: acknowledges the honoured subset of `requested` first,
	 * then forwards matching notifications until the returned disposable is
	 * disposed (which writes the graceful completion result). Throws a
	 * `-32603` {@link McpGatewayRpcError} when {@link MAX_LISTEN_STREAMS}
	 * streams are already open.
	 */
	register(requestId: JsonRpcId, requested: MCP.SubscriptionFilter, stream: IMcpGatewayListenStream, owner?: string, peer?: string): IDisposable {
		if (this._entries.size >= MAX_LISTEN_STREAMS) {
			throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `Too many open subscriptions/listen streams (limit ${MAX_LISTEN_STREAMS})`);
		}
		const filter = this._dispatcher.honoredFilter(requested);
		const entry: IListenEntry = { requestId, owner, peer, filter, stream, subscriptions: new DisposableStore(), closed: false };
		this._entries.add(entry);
		stream.notify({ method: 'notifications/subscriptions/acknowledged', params: { _meta: { [META_SUBSCRIPTION_ID]: requestId }, notifications: filter } });
		this._logger.debug(`[McpGateway][listen ${String(requestId)}] Opened with filter ${JSON.stringify(filter)} (open streams: ${this._entries.size})`);
		for (const uri of filter.resourceSubscriptions ?? []) {
			this._subscribeResource(entry, uri);
		}
		entry.registration = toDisposable(() => this._close(entry));
		return entry.registration;
	}

	/**
	 * The open streams with this request id that a `notifications/cancelled`
	 * can reach (those with {@link IMcpGatewayListenStream.cancel}), each with
	 * its sender and a way to close it without a result. The route picks the
	 * targets among them and its requests in flight together
	 * (`cancellationTargets` of mcpGatewayProtocol.ts).
	 */
	cancellables(requestId: JsonRpcId): IMcpGatewayListenCancellable[] {
		return this._find(requestId)
			.filter(entry => entry.stream.cancel !== undefined)
			.map(entry => ({ owner: entry.owner, peer: entry.peer, cancel: () => this._close(entry, false) }));
	}

	/** Closes every stream gracefully (server shutdown). */
	closeAll(): void {
		for (const entry of [...this._entries]) {
			this._close(entry);
		}
	}

	override dispose(): void {
		this.closeAll();
		super.dispose();
	}

	private _find(requestId: JsonRpcId): IListenEntry[] {
		return [...this._entries].filter(entry => entry.requestId === requestId);
	}

	private _subscribeResource(entry: IListenEntry, uri: string): void {
		const subscribe = this._invoker.subscribeResource;
		if (!subscribe) {
			return;
		}
		subscribe.call(this._invoker, uri).then(subscription => {
			if (entry.closed) {
				subscription.dispose();
			} else {
				entry.subscriptions.add(subscription);
			}
		}, error => {
			this._logger.warn(`[McpGateway][listen ${String(entry.requestId)}] Could not subscribe to ${uri}: ${error}`);
		});
	}

	private _broadcast(matches: (entry: IListenEntry) => boolean, method: string, params: Record<string, unknown>): void {
		for (const entry of [...this._entries]) {
			if (!entry.closed && matches(entry)) {
				entry.stream.notify({ method, params: { ...params, _meta: { [META_SUBSCRIPTION_ID]: entry.requestId } } });
			}
		}
	}

	/** Closes a stream: with the graceful result when the server ends it, without one when the client cancelled it. */
	private _close(entry: IListenEntry, graceful = true): void {
		if (entry.closed) {
			return;
		}
		entry.closed = true;
		this._entries.delete(entry);
		entry.subscriptions.dispose();
		entry.registration?.dispose();
		this._logger.debug(`[McpGateway][listen ${String(entry.requestId)}] ${graceful ? 'Closed' : 'Cancelled by the client'} (open streams: ${this._entries.size})`);
		if (graceful) {
			entry.stream.complete({ resultType: 'complete', _meta: { [META_SUBSCRIPTION_ID]: entry.requestId } });
		} else {
			// Only reached through `cancellables`, which offers only streams that can be cancelled.
			entry.stream.cancel?.();
		}
	}
}
