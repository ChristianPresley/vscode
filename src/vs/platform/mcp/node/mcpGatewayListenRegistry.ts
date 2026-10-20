/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogger } from '../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { META_SUBSCRIPTION_ID } from '../common/mcpProtocolVersions.js';
import { MCP } from '../common/modelContextProtocol.js';
import { IMcpGatewayNotification, McpGatewayDispatcher } from './mcpGatewayDispatcher.js';

/** The most `subscriptions/listen` streams one route keeps open at a time. */
export const MAX_LISTEN_STREAMS = 64;

/** The response stream of one `subscriptions/listen` request. */
export interface IMcpGatewayListenStream {
	notify(notification: IMcpGatewayNotification): void;
	/** Writes the final (graceful) result of the listen request and closes the stream. */
	complete(result: object): void;
}

interface IListenEntry {
	readonly requestId: JsonRpcId;
	/** Who opened the stream (see the route's client key); a cancellation of another client does not reach it. */
	readonly owner: string | undefined;
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
	register(requestId: JsonRpcId, requested: MCP.SubscriptionFilter, stream: IMcpGatewayListenStream, owner?: string): IDisposable {
		if (this._entries.size >= MAX_LISTEN_STREAMS) {
			throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, `Too many open subscriptions/listen streams (limit ${MAX_LISTEN_STREAMS})`);
		}
		const filter = this._dispatcher.honoredFilter(requested);
		const entry: IListenEntry = { requestId, owner, filter, stream, subscriptions: new DisposableStore(), closed: false };
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
	 * Closes every stream opened with this request id gracefully, only those
	 * of `owner` when it is given; returns false when none is open.
	 */
	close(requestId: JsonRpcId, owner?: string): boolean {
		const entries = this._find(requestId).filter(entry => owner === undefined || entry.owner === owner);
		for (const entry of entries) {
			this._close(entry);
		}
		return entries.length > 0;
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

	private _close(entry: IListenEntry): void {
		if (entry.closed) {
			return;
		}
		entry.closed = true;
		this._entries.delete(entry);
		entry.subscriptions.dispose();
		entry.registration?.dispose();
		this._logger.debug(`[McpGateway][listen ${String(entry.requestId)}] Closed (open streams: ${this._entries.size})`);
		entry.stream.complete({ resultType: 'complete', _meta: { [META_SUBSCRIPTION_ID]: entry.requestId } });
	}
}
