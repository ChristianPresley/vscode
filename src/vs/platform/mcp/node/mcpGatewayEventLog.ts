/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../base/common/uuid.js';

/** The most SSE events one legacy session keeps for `Last-Event-ID` replay. */
export const MAX_REPLAY_EVENTS = 256;
/** The most event data (characters of JSON) one legacy session keeps for replay. */
export const MAX_REPLAY_DATA_LENGTH = 4 * 1024 * 1024;

/**
 * The two kinds of legacy SSE stream: the response stream of a POST, which
 * is complete once the POST's requests are answered (or cancelled), and a
 * standalone GET stream, which is never complete (a client that resumes it
 * keeps receiving the session's messages that belong to no request).
 */
export type McpGatewayStreamKind = 'request' | 'standalone';

/** An HTTP response that carries the events of one stream. */
export interface IMcpGatewaySseConnection {
	/** Whether events written now reach the client. */
	readonly isOpen: boolean;
	/** Writes one event on the response. */
	writeEvent(id: string, data: string): void;
	/** Ends the response: the stream it carries is complete. */
	end(): void;
}

export interface IMcpGatewayStreamInfo {
	readonly id: string;
	readonly kind: McpGatewayStreamKind;
	/** A request stream whose request is over: nothing follows its logged events. */
	readonly complete: boolean;
}

export interface IMcpGatewayReplayOutcome {
	/** The number of logged events written on the connection. */
	readonly replayed: number;
	/** Events of the stream after the cursor were dropped from the bounded log. */
	readonly truncated: boolean;
}

interface IStreamEntry {
	readonly id: string;
	readonly kind: McpGatewayStreamKind;
	connection: IMcpGatewaySseConnection | undefined;
	complete: boolean;
	/** How many of the log's events belong to this stream. */
	events: number;
	/** The highest sequence number of this stream that the bounded log dropped. */
	droppedThrough: number;
}

interface ILoggedEvent {
	readonly stream: IStreamEntry;
	readonly seq: number;
	readonly id: string;
	readonly data: string;
}

export interface IMcpGatewayEventLogOptions {
	/** The first part of every event id; random by default, so ids are unique across sessions. */
	readonly idPrefix?: string;
	readonly maxEvents?: number;
	readonly maxDataLength?: number;
}

const EVENT_ID = /^([0-9A-Za-z]+)-(\d+)-(\d+)$/;

/**
 * The SSE streams of one legacy session and the bounded replay log behind
 * SEP-1699 resumability. Every message written on a stream goes through
 * {@link write}: it is logged with an event id of the form
 * `<log>-<stream>-<seq>` (unique, the session's log and the stream
 * recognisable from the id alone)
 * and written on the HTTP response that carries the stream at that moment,
 * if any. A client that lost a stream (or whose stream the server closed to
 * make it poll) sends `GET` with `Last-Event-ID`; the new response is
 * {@link connect connected} to the stream, gets the logged events after that
 * id, then carries the stream on. Events of one stream are never replayed on
 * another. The log keeps at most {@link MAX_REPLAY_EVENTS} events and
 * {@link MAX_REPLAY_DATA_LENGTH} characters of data, dropping the oldest, and
 * forgets streams that can no longer be resumed usefully.
 */
export class McpGatewayEventLog {
	private readonly _streams = new Map<string, IStreamEntry>();
	private readonly _events: ILoggedEvent[] = [];
	private _dataLength = 0;
	private _nextStream = 1;
	private _nextSeq = 1;
	private _latestStandalone: IStreamEntry | undefined;
	private readonly _prefix: string;
	private readonly _maxEvents: number;
	private readonly _maxDataLength: number;

	constructor(options: IMcpGatewayEventLogOptions = {}) {
		this._prefix = options.idPrefix ?? generateUuid().replace(/-/g, '').substring(0, 12);
		this._maxEvents = options.maxEvents ?? MAX_REPLAY_EVENTS;
		this._maxDataLength = options.maxDataLength ?? MAX_REPLAY_DATA_LENGTH;
	}

	/** The number of logged events (diagnostics and tests). */
	get eventCount(): number {
		return this._events.length;
	}

	/** The number of streams the log still knows (diagnostics and tests). */
	get streamCount(): number {
		return this._streams.size;
	}

	/** The most recently opened or resumed standalone stream: where messages that belong to no request are kept while no GET stream is open. */
	get latestStandalone(): string | undefined {
		return this._latestStandalone?.id;
	}

	/** Whether any stream is carried by an open response. */
	get hasOpenConnection(): boolean {
		for (const stream of this._streams.values()) {
			if (stream.connection?.isOpen) {
				return true;
			}
		}
		return false;
	}

	/** Starts a stream, carried by `connection` from now on; returns its id. */
	open(kind: McpGatewayStreamKind, connection?: IMcpGatewaySseConnection): string {
		const entry: IStreamEntry = { id: String(this._nextStream++), kind, connection, complete: false, events: 0, droppedThrough: 0 };
		this._streams.set(entry.id, entry);
		if (kind === 'standalone') {
			this._setLatestStandalone(entry);
		}
		return entry.id;
	}

	/** A fresh event id of the stream that carries no message (a priming event): a cursor to resume from. */
	cursor(streamId: string): string {
		return this._eventId(streamId, this._nextSeq++);
	}

	/**
	 * Logs a message of a stream and writes it on the response that carries
	 * the stream, if one is open. Returns the event id, or undefined when the
	 * stream is unknown (it was forgotten) or complete.
	 */
	write(streamId: string, message: object): string | undefined {
		const stream = this._streams.get(streamId);
		if (!stream || stream.complete) {
			return undefined;
		}
		const seq = this._nextSeq++;
		const event: ILoggedEvent = { stream, seq, id: this._eventId(streamId, seq), data: JSON.stringify(message) };
		this._events.push(event);
		this._dataLength += event.data.length;
		stream.events++;
		if (stream.connection?.isOpen) {
			stream.connection.writeEvent(event.id, event.data);
		}
		this._evict();
		return event.id;
	}

	/** The stream an event id of this log belongs to; undefined for anything else (another session's id, a forgotten stream, garbage). */
	find(eventId: string): IMcpGatewayStreamInfo | undefined {
		const parsed = this._parse(eventId);
		return parsed ? { id: parsed.stream.id, kind: parsed.stream.kind, complete: parsed.stream.complete } : undefined;
	}

	/** The response that carries the stream now, if any. */
	connectionOf(streamId: string): IMcpGatewaySseConnection | undefined {
		return this._streams.get(streamId)?.connection;
	}

	/**
	 * `connection` carries the stream from now on. With `afterEventId` (the
	 * client's `Last-Event-ID`), the logged events of the stream after it are
	 * written on the connection first; a complete request stream then ends
	 * the connection, since nothing more will come.
	 */
	connect(streamId: string, connection: IMcpGatewaySseConnection, afterEventId?: string): IMcpGatewayReplayOutcome {
		const stream = this._streams.get(streamId);
		if (!stream) {
			return { replayed: 0, truncated: false };
		}
		stream.connection = connection;
		if (stream.kind === 'standalone') {
			this._setLatestStandalone(stream);
		}
		let replayed = 0;
		let truncated = false;
		const after = afterEventId === undefined ? undefined : this._parse(afterEventId);
		if (after && after.stream === stream) {
			truncated = stream.droppedThrough > after.seq;
			for (const event of this._events) {
				if (event.stream === stream && event.seq > after.seq && connection.isOpen) {
					connection.writeEvent(event.id, event.data);
					replayed++;
				}
			}
		}
		if (stream.complete) {
			stream.connection = undefined;
			connection.end();
			this._prune(stream);
		}
		return { replayed, truncated };
	}

	/** `connection` no longer carries the stream (it closed, or the server ended it for polling). */
	disconnect(streamId: string, connection: IMcpGatewaySseConnection): void {
		const stream = this._streams.get(streamId);
		if (stream && stream.connection === connection) {
			stream.connection = undefined;
			this._prune(stream);
		}
	}

	/** A request stream is over: the response that carries it ends, and a later resume gets the logged events and ends. */
	complete(streamId: string): void {
		const stream = this._streams.get(streamId);
		if (!stream || stream.kind !== 'request' || stream.complete) {
			return;
		}
		stream.complete = true;
		const connection = stream.connection;
		stream.connection = undefined;
		connection?.end();
		this._prune(stream);
	}

	/** Ends every response that carries a stream (the session is over). */
	endAll(): void {
		for (const stream of [...this._streams.values()]) {
			const connection = stream.connection;
			stream.connection = undefined;
			connection?.end();
		}
	}

	private _eventId(streamId: string, seq: number): string {
		return `${this._prefix}-${streamId}-${seq}`;
	}

	private _parse(eventId: string): { readonly stream: IStreamEntry; readonly seq: number } | undefined {
		const match = EVENT_ID.exec(eventId.trim());
		if (!match || match[1] !== this._prefix) {
			return undefined;
		}
		const stream = this._streams.get(match[2]);
		const seq = Number(match[3]);
		if (!stream || !Number.isSafeInteger(seq) || seq >= this._nextSeq) {
			return undefined;
		}
		return { stream, seq };
	}

	private _setLatestStandalone(stream: IStreamEntry): void {
		const previous = this._latestStandalone;
		this._latestStandalone = stream;
		if (previous && previous !== stream) {
			this._prune(previous);
		}
	}

	private _evict(): void {
		while (this._events.length > this._maxEvents || (this._dataLength > this._maxDataLength && this._events.length > 1)) {
			const dropped = this._events.shift()!;
			this._dataLength -= dropped.data.length;
			dropped.stream.events--;
			dropped.stream.droppedThrough = Math.max(dropped.stream.droppedThrough, dropped.seq);
			this._prune(dropped.stream);
		}
	}

	/**
	 * Forgets a stream nobody can usefully resume any more: no response carries
	 * it, none of its events are logged, and it is either a complete request
	 * stream or a standalone stream that is not the latest one.
	 */
	private _prune(stream: IStreamEntry): void {
		if (stream.connection || stream.events > 0) {
			return;
		}
		const finished = stream.kind === 'request' ? stream.complete : stream !== this._latestStandalone;
		if (finished) {
			this._streams.delete(stream.id);
		}
	}
}
