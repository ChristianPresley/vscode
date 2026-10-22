/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';

/** The HTTP/2 frame types the proxy counts. */
export enum Http2FrameType {
	Data = 0x0,
	Headers = 0x1,
	RstStream = 0x3,
	Ping = 0x6,
	GoAway = 0x7,
}

/** One frame header as it crossed the proxy. */
export interface IHttp2Frame {
	readonly type: number;
	readonly flags: number;
	readonly streamId: number;
	/** The error code of an RST_STREAM. */
	readonly errorCode?: number;
}

export interface IHttp2FrameProxy {
	/** The port to connect to instead of the target's. */
	readonly port: number;
	/** The frames the client sent, in order. */
	readonly fromClient: readonly IHttp2Frame[];
	/** The frames the server sent, in order. */
	readonly fromServer: readonly IHttp2Frame[];
	close(): Promise<void>;
}

/** Parses the frames of one direction of an HTTP/2 connection (the client's starts with the 24-byte preface). */
function frameParser(hasPreface: boolean, onFrame: (frame: IHttp2Frame) => void): (chunk: Buffer) => void {
	let buffered = Buffer.alloc(0);
	let preface = hasPreface;
	return chunk => {
		buffered = Buffer.concat([buffered, chunk]);
		if (preface) {
			if (buffered.length < 24) {
				return;
			}
			buffered = buffered.subarray(24);
			preface = false;
		}
		while (buffered.length >= 9 && buffered.length >= 9 + buffered.readUIntBE(0, 3)) {
			const length = buffered.readUIntBE(0, 3);
			const type = buffered[3];
			const frame: IHttp2Frame = {
				type,
				flags: buffered[4],
				streamId: buffered.readUInt32BE(5) & 0x7fffffff,
				...(type === Http2FrameType.RstStream && length >= 4 ? { errorCode: buffered.readUInt32BE(9) } : {}),
			};
			buffered = buffered.subarray(9 + length);
			onFrame(frame);
		}
	};
}

/**
 * A TCP proxy in front of a cleartext HTTP/2 server on the loopback
 * interface that records the frame headers going each way, for what Node's
 * `http2` does not report (whether a peer sent an RST_STREAM on a stream
 * that also closed normally, for instance).
 */
export async function startHttp2FrameProxy(targetPort: number): Promise<IHttp2FrameProxy> {
	const sockets = new Set<net.Socket>();
	const fromClient: IHttp2Frame[] = [];
	const fromServer: IHttp2Frame[] = [];
	const server = net.createServer(client => {
		const upstream = net.connect(targetPort, '127.0.0.1');
		for (const socket of [client, upstream]) {
			// Forward each chunk at once, as the HTTP/2 endpoints do (Node's http2 disables
			// Nagle's algorithm on its sockets): with Nagle, a small write waits for the ACK
			// of the previous one, which Linux delays by 40 ms on the loopback interface, so
			// each call through the proxy would take some 40 ms there.
			socket.setNoDelay(true);
			sockets.add(socket);
			socket.on('error', () => { /* the other side is closed below */ });
			socket.on('close', () => sockets.delete(socket));
		}
		const parseClient = frameParser(true, frame => fromClient.push(frame));
		const parseServer = frameParser(false, frame => fromServer.push(frame));
		client.on('data', (chunk: Buffer) => {
			parseClient(chunk);
			upstream.write(chunk);
		});
		upstream.on('data', (chunk: Buffer) => {
			parseServer(chunk);
			client.write(chunk);
		});
		client.on('close', () => upstream.destroy());
		upstream.on('close', () => client.destroy());
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address !== 'object') {
		throw new Error('the proxy has no port');
	}
	return {
		port: address.port,
		fromClient,
		fromServer,
		close: async () => {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}
