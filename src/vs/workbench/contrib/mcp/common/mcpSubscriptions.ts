/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILogger } from '../../../../platform/log/common/log.js';
import { META_SUBSCRIPTION_ID } from '../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../platform/mcp/common/modelContextProtocol.js';
import { LISTEN_ACK_TIMEOUT_MS, LISTEN_BACKOFF_MS, LISTEN_MAX_BACKOFF_MS, LISTEN_STABLE_MS } from './mcpProtocolMeta.js';
import { McpClientError, MpcResponseError } from './mcpTypes.js';

/** What the manager needs from the protocol engine. */
export interface IMcpListenHost {
	/** Sends `subscriptions/listen` and returns its id and the promise of its result (the stream's graceful end). */
	listen(filter: MCP.SubscriptionFilter): { readonly id: JsonRpcId; readonly result: Promise<MCP.SubscriptionsListenResult> };
	/** Cancels a listen request (the engine sends `notifications/cancelled` or aborts the transport stream). */
	cancel(id: JsonRpcId): void;
	readonly logger: ILogger;
}

export type McpListenStreamKind = 'lists' | 'resources';

export interface IMcpListenReconnect {
	readonly stream: McpListenStreamKind;
	readonly reason: string;
	readonly backoffMs: number;
}

interface IListFilter {
	readonly toolsListChanged?: boolean;
	readonly promptsListChanged?: boolean;
	readonly resourcesListChanged?: boolean;
}

/** The state of one listen stream (the lists stream or the resources stream). */
class ListenStream extends Disposable {
	private _id: JsonRpcId | undefined;
	private _acknowledged = false;
	private _everAcknowledged = false;
	private _backoffMs = 0;
	private _disabled = false;
	private _wanted = false;
	private _cancelledByUs = false;
	private readonly _run = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		readonly kind: McpListenStreamKind,
		private readonly _host: IMcpListenHost,
		private readonly _filterProvider: () => MCP.SubscriptionFilter | undefined,
		private readonly _onAcknowledged: (filter: MCP.SubscriptionFilter, isReconnect: boolean) => void,
		private readonly _onReconnect: (reconnect: IMcpListenReconnect) => void,
		private readonly _schedule: (fn: () => void, delayMs: number) => IDisposable,
	) {
		super();
	}

	get id(): JsonRpcId | undefined {
		return this._id;
	}

	get isActive(): boolean {
		return this._id !== undefined;
	}

	/** Starts or restarts the stream with the current filter; stops it when the filter is empty. */
	refresh(): void {
		if (this._disabled || this._store.isDisposed) {
			return;
		}
		const filter = this._filterProvider();
		this._wanted = filter !== undefined;
		if (!this._wanted) {
			this._stop();
			return;
		}
		// A running stream carries a filter; swap it by cancelling and opening a new one.
		this._stop();
		this._open(filter!);
	}

	/** The server cancelled or closed the stream; reconnect with backoff when it is still wanted. */
	handleCancelled(id: JsonRpcId): boolean {
		if (this._id !== id) {
			return false;
		}
		this._id = undefined;
		this._run.clear();
		this._reconnectLater('cancelled by the server');
		return true;
	}

	handleAcknowledged(filter: MCP.SubscriptionFilter): void {
		this._acknowledged = true;
		const isReconnect = this._everAcknowledged;
		this._everAcknowledged = true;
		this._run.value?.add(this._schedule(() => { this._backoffMs = 0; }, LISTEN_STABLE_MS));
		this._onAcknowledged(filter, isReconnect);
	}

	private _open(filter: MCP.SubscriptionFilter): void {
		const run = new DisposableStore();
		this._run.value = run;
		this._acknowledged = false;
		this._cancelledByUs = false;
		const { id, result } = this._host.listen(filter);
		this._id = id;
		run.add(this._schedule(() => {
			if (!this._acknowledged && this._id === id) {
				this._host.logger.warn(`[mcp] subscriptions/listen (${this.kind}) was not acknowledged within ${LISTEN_ACK_TIMEOUT_MS}ms; reconnecting`);
				this._cancelledByUs = true;
				this._host.cancel(id);
				this._id = undefined;
				this._reconnectLater('acknowledgement timeout');
			}
		}, LISTEN_ACK_TIMEOUT_MS));
		result.then(
			() => {
				if (this._id !== id) {
					return;
				}
				this._id = undefined;
				// A graceful close: the server is shedding load or restarting; reconnect at once.
				if (this._wanted && !this._store.isDisposed) {
					this._onReconnect({ stream: this.kind, reason: 'closed by the server', backoffMs: 0 });
					this.refresh();
				}
			},
			(err: unknown) => {
				if (this._id !== id) {
					return; // we replaced or stopped it ourselves
				}
				this._id = undefined;
				if (this._cancelledByUs || err instanceof CancellationError) {
					return;
				}
				if (err instanceof MpcResponseError) {
					// The server does not support this stream (for instance a typed-only gRPC server): never retry.
					this._disabled = true;
					this._host.logger.warn(`[mcp] subscriptions/listen (${this.kind}) rejected by the server (${err.code}: ${err.message}); live updates are disabled`);
					return;
				}
				const reason = err instanceof McpClientError ? err.reason : String(err);
				this._reconnectLater(reason);
			},
		);
	}

	private _stop(): void {
		const id = this._id;
		this._id = undefined;
		this._run.clear();
		if (id !== undefined) {
			this._cancelledByUs = true;
			this._host.cancel(id);
		}
	}

	private _reconnectLater(reason: string): void {
		if (!this._wanted || this._disabled || this._store.isDisposed) {
			return;
		}
		const delay = this._backoffMs;
		this._backoffMs = Math.min(this._backoffMs === 0 ? LISTEN_BACKOFF_MS : this._backoffMs * 2, LISTEN_MAX_BACKOFF_MS);
		this._onReconnect({ stream: this.kind, reason, backoffMs: delay });
		const run = new DisposableStore();
		this._run.value = run;
		run.add(this._schedule(() => this.refresh(), delay));
	}

	override dispose(): void {
		this._wanted = false;
		this._stop();
		super.dispose();
	}
}

/**
 * Owns the client's `subscriptions/listen` streams for one modern server:
 * one stream for list changes and one, swapped on change, for resource
 * subscriptions. Demultiplexes notifications by their `subscriptionId`,
 * reconnects with backoff, and compensates gaps by signalling a list change
 * after every reconnection.
 */
export class McpSubscriptionManager extends Disposable {
	private readonly _onDidChangeToolList = this._register(new Emitter<void>());
	readonly onDidChangeToolList = this._onDidChangeToolList.event;
	private readonly _onDidChangePromptList = this._register(new Emitter<void>());
	readonly onDidChangePromptList = this._onDidChangePromptList.event;
	private readonly _onDidChangeResourceList = this._register(new Emitter<void>());
	readonly onDidChangeResourceList = this._onDidChangeResourceList.event;
	private readonly _onDidUpdateResource = this._register(new Emitter<MCP.ResourceUpdatedNotification['params']>());
	readonly onDidUpdateResource = this._onDidUpdateResource.event;
	private readonly _onDidReconnect = this._register(new Emitter<IMcpListenReconnect>());
	readonly onDidReconnect = this._onDidReconnect.event;

	private _listFilter: IListFilter = {};
	private readonly _resourceRefs = new Map<string, number>();
	private readonly _lists: ListenStream;
	private readonly _resources: ListenStream;
	private readonly _resourceRefreshTimer = this._register(new MutableDisposable());

	constructor(
		host: IMcpListenHost,
		private readonly _schedule: (fn: () => void, delayMs: number) => IDisposable = (fn, delayMs) => {
			const handle = setTimeout(fn, delayMs);
			return toDisposable(() => clearTimeout(handle));
		},
	) {
		super();
		this._lists = this._register(new ListenStream('lists', host, () => this._currentListFilter(), (filter, isReconnect) => this._onListsAcknowledged(filter, isReconnect), r => this._onDidReconnect.fire(r), this._schedule));
		this._resources = this._register(new ListenStream('resources', host, () => this._currentResourceFilter(), () => { }, r => this._onDidReconnect.fire(r), this._schedule));
	}

	/** The URIs with live subscriptions. */
	get subscribedUris(): ReadonlySet<string> {
		return new Set(this._resourceRefs.keys());
	}

	/** Opens the lists stream for the kinds the server can produce. */
	start(filter: IListFilter): void {
		this._listFilter = filter;
		this._lists.refresh();
	}

	/** Re-opens the streams (after a transport restart the previous streams are gone). */
	restart(): void {
		this._lists.refresh();
		this._resources.refresh();
	}

	/** Subscribes to `resources/updated` for a URI (ref-counted; the resources stream is swapped after a short debounce). */
	subscribeResource(uri: string): IDisposable {
		this._resourceRefs.set(uri, (this._resourceRefs.get(uri) ?? 0) + 1);
		this._scheduleResourceRefresh();
		let disposed = false;
		return toDisposable(() => {
			if (disposed) {
				return;
			}
			disposed = true;
			const count = this._resourceRefs.get(uri) ?? 0;
			if (count <= 1) {
				this._resourceRefs.delete(uri);
			} else {
				this._resourceRefs.set(uri, count - 1);
			}
			this._scheduleResourceRefresh();
		});
	}

	/**
	 * Routes a server notification. Returns true when it belonged to one of the
	 * streams (including a notification for an unknown subscription, which is
	 * dropped). Notifications without a subscription id are not ours.
	 */
	handleNotification(notification: { method: string; params?: unknown }): boolean {
		const params = typeof notification.params === 'object' && notification.params !== null ? notification.params as Record<string, unknown> : undefined;
		const meta = params && typeof params._meta === 'object' && params._meta !== null ? params._meta as Record<string, unknown> : undefined;
		const subscriptionId = meta?.[META_SUBSCRIPTION_ID];
		if (subscriptionId === undefined) {
			return false;
		}
		const stream = this._streamFor(subscriptionId as JsonRpcId);
		if (!stream) {
			return true; // a stale stream's notification
		}
		switch (notification.method) {
			case 'notifications/subscriptions/acknowledged':
				stream.handleAcknowledged((params?.notifications ?? {}) as MCP.SubscriptionFilter);
				return true;
			case 'notifications/tools/list_changed':
				this._onDidChangeToolList.fire();
				return true;
			case 'notifications/prompts/list_changed':
				this._onDidChangePromptList.fire();
				return true;
			case 'notifications/resources/list_changed':
				this._onDidChangeResourceList.fire();
				return true;
			case 'notifications/resources/updated':
				if (params && typeof params.uri === 'string') {
					this._onDidUpdateResource.fire(params as unknown as MCP.ResourceUpdatedNotification['params']);
				}
				return true;
			default:
				return true;
		}
	}

	/** A server-sent `notifications/cancelled`: only listen ids are meaningful. Returns true when it was one of ours. */
	handleCancelled(requestId: JsonRpcId): boolean {
		return this._lists.handleCancelled(requestId) || this._resources.handleCancelled(requestId);
	}

	private _streamFor(id: JsonRpcId): ListenStream | undefined {
		if (this._lists.id === id) {
			return this._lists;
		}
		if (this._resources.id === id) {
			return this._resources;
		}
		return undefined;
	}

	private _currentListFilter(): MCP.SubscriptionFilter | undefined {
		const filter: MCP.SubscriptionFilter = {};
		if (this._listFilter.toolsListChanged) {
			filter.toolsListChanged = true;
		}
		if (this._listFilter.promptsListChanged) {
			filter.promptsListChanged = true;
		}
		if (this._listFilter.resourcesListChanged) {
			filter.resourcesListChanged = true;
		}
		return Object.keys(filter).length > 0 ? filter : undefined;
	}

	private _currentResourceFilter(): MCP.SubscriptionFilter | undefined {
		return this._resourceRefs.size > 0 ? { resourceSubscriptions: [...this._resourceRefs.keys()].sort() } : undefined;
	}

	private _scheduleResourceRefresh(): void {
		if (this._store.isDisposed) {
			return; // a subscription released after the manager: the disposed timer slot would leak the new timer
		}
		this._resourceRefreshTimer.value = this._schedule(() => this._resources.refresh(), 50);
	}

	private _onListsAcknowledged(filter: MCP.SubscriptionFilter, isReconnect: boolean): void {
		if (!isReconnect) {
			return;
		}
		// Changes may have happened while the stream was down: let listeners re-list.
		if (filter.toolsListChanged) {
			this._onDidChangeToolList.fire();
		}
		if (filter.promptsListChanged) {
			this._onDidChangePromptList.fire();
		}
		if (filter.resourcesListChanged) {
			this._onDidChangeResourceList.fire();
		}
	}
}
