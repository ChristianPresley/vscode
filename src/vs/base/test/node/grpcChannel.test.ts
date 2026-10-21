/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http2 from 'http2';
import * as net from 'net';
import * as sinon from 'sinon';
import { DeferredPromise, timeout } from '../../common/async.js';
import { DEFAULT_MAX_GRPC_MESSAGE_BYTES, LengthPrefixedMessageReader, encodeLengthPrefixedMessage } from '../../common/grpc/lpm.js';
import { GrpcStatus, decodeBinaryMetadata, encodeBinaryMetadata, encodeGrpcMessage } from '../../common/grpc/status.js';
import { parseGrpcTimeout } from '../../common/grpc/timeout.js';
import { GrpcCallError, GrpcChannel, IGrpcCall, IGrpcChannelOptions, parseGrpcAuthority } from '../../node/grpcChannel.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';
import { Http2FrameType, startHttp2FrameProxy } from './http2FrameProxy.js';

type StreamHandler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, flags: number) => void;

const { NGHTTP2_CANCEL, NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM, NGHTTP2_ENHANCE_YOUR_CALM, NGHTTP2_INTERNAL_ERROR } = http2.constants;
const GRPC_HEADERS = { ':status': 200, 'content-type': 'application/grpc' };

function text(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function fromBytes(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function headerValue(value: string | string[] | number | undefined): string | undefined {
	return value === undefined ? undefined : Array.isArray(value) ? value.join(', ') : String(value);
}

/** Replies with a complete gRPC response: headers, the messages, then trailers. */
function respondGrpc(stream: http2.ServerHttp2Stream, options: { headers?: http2.OutgoingHttpHeaders; messages?: Uint8Array[]; trailers?: http2.OutgoingHttpHeaders } = {}): void {
	stream.respond({ ...GRPC_HEADERS, ...options.headers }, { waitForTrailers: true });
	stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', ...options.trailers }));
	for (const message of options.messages ?? []) {
		stream.write(encodeLengthPrefixedMessage(message));
	}
	stream.end();
}

/** Collects the length-prefixed messages of a request body. */
function readRequest(stream: http2.ServerHttp2Stream): Promise<Uint8Array[]> {
	return new Promise((resolve, reject) => {
		const reader = new LengthPrefixedMessageReader(16 * 1024 * 1024);
		const messages: Uint8Array[] = [];
		stream.on('data', (chunk: Buffer) => {
			try {
				messages.push(...reader.feed(chunk));
			} catch (error) {
				reject(error);
			}
		});
		stream.on('end', () => resolve(messages));
	});
}

function onceClosed(stream: http2.ServerHttp2Stream): Promise<number> {
	return new Promise(resolve => stream.on('close', () => resolve(stream.rstCode)));
}

async function collect(call: IGrpcCall): Promise<Uint8Array[]> {
	const messages: Uint8Array[] = [];
	for await (const message of call.messages) {
		messages.push(message);
	}
	return messages;
}

async function collectError(call: IGrpcCall): Promise<GrpcCallError> {
	try {
		await collect(call);
	} catch (error) {
		assert.ok(error instanceof GrpcCallError, `expected a GrpcCallError, got ${String(error)}`);
		return error;
	}
	assert.fail('expected the message iteration to throw');
}

suite('GrpcChannel', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let server: http2.Http2Server;
	let authority: string;
	let sessions: http2.ServerHttp2Session[];
	let handler: StreamHandler;

	setup(async () => {
		sessions = [];
		handler = () => { };
		server = http2.createServer();
		server.on('session', session => sessions.push(session));
		server.on('stream', (stream, headers, flags) => {
			stream.on('error', () => { });
			handler(stream, headers, flags);
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		assert.ok(address && typeof address === 'object');
		authority = `127.0.0.1:${address.port}`;
	});

	teardown(async () => {
		for (const session of sessions) {
			session.destroy();
		}
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	function createChannel(options: Partial<IGrpcChannelOptions> = {}): GrpcChannel {
		return store.add(new GrpcChannel({ authority, secure: false, ...options }));
	}

	test('unary call round trips the request and sends the gRPC request headers', async () => {
		handler = async (stream, headers) => {
			const [request] = await readRequest(stream);
			const echo = {
				method: headers[':method'],
				scheme: headers[':scheme'],
				path: headers[':path'],
				authority: headers[':authority'],
				te: headers.te,
				contentType: headers['content-type'],
				encoding: headerValue(headers['grpc-encoding']),
				acceptEncoding: headerValue(headers['grpc-accept-encoding']),
				userAgent: headers['user-agent'],
				custom: headerValue(headers['x-custom-header']),
				timeout: headerValue(headers['grpc-timeout']),
				body: fromBytes(request),
			};
			respondGrpc(stream, { messages: [text(JSON.stringify(echo))] });
		};

		const channel = createChannel({ userAgent: 'test-agent/1.0' });
		const call = channel.call('/test.Service/Echo', { 'X-Custom-Header': 'Custom Value' }, text('hello'));

		const responseHeaders = await call.responseHeaders;
		assert.strictEqual(responseHeaders.httpStatus, 200);
		assert.strictEqual(responseHeaders.headers['content-type'], 'application/grpc');

		const messages = await collect(call);
		assert.strictEqual(messages.length, 1);
		const echo = JSON.parse(fromBytes(messages[0]));
		assert.strictEqual(echo.method, 'POST');
		assert.strictEqual(echo.scheme, 'http');
		assert.strictEqual(echo.path, '/test.Service/Echo');
		assert.strictEqual(echo.authority, authority);
		assert.strictEqual(echo.te, 'trailers');
		assert.strictEqual(echo.contentType, 'application/grpc+proto');
		assert.strictEqual(echo.encoding, 'identity');
		assert.strictEqual(echo.acceptEncoding, 'identity');
		assert.strictEqual(echo.userAgent, 'test-agent/1.0');
		assert.strictEqual(echo.custom, 'Custom Value');
		assert.strictEqual(echo.timeout, undefined);
		assert.strictEqual(echo.body, 'hello');

		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.strictEqual(trailers.raw['grpc-status'], '0');
		assert.strictEqual(channel.isConnected, true);
		assert.strictEqual(sessions.length, 1);
	});

	test('server streaming delivers every message in order', async () => {
		handler = stream => respondGrpc(stream, { messages: [text('one'), text('two'), text('three')] });

		const call = createChannel().call('/test.Service/Stream', {}, new Uint8Array(0));
		const messages = (await collect(call)).map(fromBytes);
		assert.deepStrictEqual(messages, ['one', 'two', 'three']);
		assert.strictEqual((await call.trailers).status, GrpcStatus.OK);
	});

	test('a second call reuses the session', async () => {
		handler = stream => respondGrpc(stream, { messages: [text('ok')] });
		const channel = createChannel();
		await collect(channel.call('/test.Service/One', {}, new Uint8Array(0)));
		await collect(channel.call('/test.Service/Two', {}, new Uint8Array(0)));
		assert.strictEqual(sessions.length, 1);
	});

	test('trailers-only response maps grpc-status and decodes grpc-message', async () => {
		handler = stream => stream.respond({
			...GRPC_HEADERS,
			'grpc-status': '12',
			'grpc-message': encodeGrpcMessage('method not found: ü'),
		}, { endStream: true });

		const call = createChannel().call('/test.Service/Missing', {}, new Uint8Array(0));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.UNIMPLEMENTED);
		assert.strictEqual(trailers.message, 'method not found: ü');
		assert.strictEqual(trailers.raw['grpc-status'], '12');

		const responseHeaders = await call.responseHeaders;
		assert.strictEqual(responseHeaders.httpStatus, 200);
		assert.strictEqual(responseHeaders.headers['grpc-status'], '12');

		const error = await collectError(call);
		assert.strictEqual(error.status, GrpcStatus.UNIMPLEMENTED);
		assert.strictEqual(error.httpStatus, 200);
		assert.strictEqual(error.message, 'method not found: ü');
	});

	test('error trailers after messages surface the status', async () => {
		handler = stream => respondGrpc(stream, {
			messages: [text('partial')],
			trailers: { 'grpc-status': '9', 'grpc-message': 'precondition%20failed' },
		});

		const call = createChannel().call('/test.Service/Fail', {}, new Uint8Array(0));
		const received: string[] = [];
		let thrown: unknown;
		try {
			for await (const message of call.messages) {
				received.push(fromBytes(message));
			}
		} catch (error) {
			thrown = error;
		}
		assert.deepStrictEqual(received, ['partial']);
		assert.ok(thrown instanceof GrpcCallError);
		assert.strictEqual(thrown.status, GrpcStatus.FAILED_PRECONDITION);
		assert.strictEqual(thrown.message, 'precondition failed');
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.FAILED_PRECONDITION);
		assert.strictEqual(trailers.message, 'precondition failed');
	});

	test('cancel() resets the stream and reports CANCELLED', async () => {
		let closed: Promise<number> | undefined;
		handler = stream => {
			closed = onceClosed(stream);
			stream.respond(GRPC_HEADERS);
		};

		const call = createChannel().call('/test.Service/Hang', {}, new Uint8Array(0));
		await call.responseHeaders;
		call.cancel();

		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.CANCELLED);
		assert.strictEqual(trailers.message, 'call cancelled');
		assert.ok(closed);
		assert.strictEqual(await closed, NGHTTP2_CANCEL);
		const error = await collectError(call);
		assert.strictEqual(error.status, GrpcStatus.CANCELLED);
	});

	test('cancelling before the stream opens reports CANCELLED', async () => {
		const call = createChannel().call('/test.Service/Hang', {}, new Uint8Array(0));
		call.cancel();
		assert.strictEqual((await call.trailers).status, GrpcStatus.CANCELLED);
		await assert.rejects(call.responseHeaders, (error: unknown) => error instanceof GrpcCallError && error.status === GrpcStatus.CANCELLED);
	});

	test('an abort signal cancels the call', async () => {
		let closed: Promise<number> | undefined;
		handler = stream => {
			closed = onceClosed(stream);
			stream.respond(GRPC_HEADERS);
		};

		const controller = new AbortController();
		const call = createChannel().call('/test.Service/Hang', {}, new Uint8Array(0), { signal: controller.signal });
		await call.responseHeaders;
		controller.abort();

		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.CANCELLED);
		assert.strictEqual(trailers.message, 'call aborted');
		assert.ok(closed);
		assert.strictEqual(await closed, NGHTTP2_CANCEL);
	});

	test('returning early from the message iteration cancels the call', async () => {
		let closed: Promise<number> | undefined;
		handler = stream => {
			closed = onceClosed(stream);
			stream.respond(GRPC_HEADERS);
			stream.write(encodeLengthPrefixedMessage(text('first')));
		};

		const call = createChannel().call('/test.Service/Stream', {}, new Uint8Array(0));
		for await (const message of call.messages) {
			assert.strictEqual(fromBytes(message), 'first');
			break;
		}
		assert.strictEqual((await call.trailers).status, GrpcStatus.CANCELLED);
		assert.ok(closed);
		assert.strictEqual(await closed, NGHTTP2_CANCEL);
	});

	test('deadline sends grpc-timeout and fails locally with DEADLINE_EXCEEDED', async () => {
		let closed: Promise<number> | undefined;
		handler = (stream, headers) => {
			closed = onceClosed(stream);
			stream.respond({ ...GRPC_HEADERS, 'x-echo-grpc-timeout': headerValue(headers['grpc-timeout']) ?? 'missing' });
		};

		const call = createChannel().call('/test.Service/Slow', {}, new Uint8Array(0), { deadlineMs: 50 });
		const responseHeaders = await call.responseHeaders;
		assert.strictEqual(responseHeaders.headers['x-echo-grpc-timeout'], '50m');

		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.DEADLINE_EXCEEDED);
		assert.strictEqual(trailers.message, 'deadline of 50m exceeded');
		assert.ok(closed);
		assert.strictEqual(await closed, NGHTTP2_CANCEL);
	});

	test('a response message over the receive limit fails with RESOURCE_EXHAUSTED', async () => {
		handler = stream => respondGrpc(stream, { messages: [new Uint8Array(5 * 1024 * 1024)] });

		const call = createChannel().call('/test.Service/Big', {}, new Uint8Array(0));
		const error = await collectError(call);
		assert.strictEqual(error.status, GrpcStatus.RESOURCE_EXHAUSTED);
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.RESOURCE_EXHAUSTED);
		assert.ok(trailers.message?.includes('message too large'), trailers.message);
	});

	test('a request message over the send limit fails without connecting', async () => {
		const call = createChannel({ maxSendMessageBytes: 16 }).call('/test.Service/Big', {}, new Uint8Array(17));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.RESOURCE_EXHAUSTED);
		assert.ok(trailers.message?.includes('request message too large'), trailers.message);
		assert.strictEqual(sessions.length, 0);
	});

	test('an early response followed by RST_STREAM(NO_ERROR) keeps the response', async () => {
		let closed: Promise<number> | undefined;
		handler = stream => {
			closed = onceClosed(stream);
			// Reply without reading the (large) request body, then reset the
			// stream once the trailers are on the wire.
			stream.respond(GRPC_HEADERS, { waitForTrailers: true });
			stream.on('wantTrailers', () => {
				stream.sendTrailers({ 'grpc-status': '0' });
				setImmediate(() => stream.close(NGHTTP2_NO_ERROR));
			});
			stream.write(encodeLengthPrefixedMessage(text('early')));
			stream.end();
		};

		const call = createChannel().call('/test.Service/Early', {}, new Uint8Array(1024 * 1024));
		const messages = (await collect(call)).map(fromBytes);
		assert.deepStrictEqual(messages, ['early']);
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.ok(closed);
		assert.strictEqual(await closed, NGHTTP2_NO_ERROR);
	});

	test('2,000 sequential calls on one channel: no completed stream is reset, so the server\'s rapid-reset protection never closes the session', async function () {
		this.timeout(60_000);
		handler = stream => {
			stream.on('data', () => { });
			stream.on('end', () => respondGrpc(stream, { messages: [text('ok')] }));
		};
		const proxy = await startHttp2FrameProxy(Number(authority.split(':')[1]));
		try {
			const channel = createChannel({ authority: `127.0.0.1:${proxy.port}` });
			const failures: string[] = [];
			for (let i = 0; i < 2000 && failures.length === 0; i++) {
				const call = channel.call('/test.Service/Echo', {}, text('x'));
				await collect(call).catch(() => undefined);
				const trailers = await call.trailers;
				if (trailers.status !== GrpcStatus.OK) {
					failures.push(`call ${i}: ${trailers.status} ${trailers.message}`);
				}
			}
			assert.deepStrictEqual({
				failures,
				sessions: sessions.length,
				resetsFromClient: proxy.fromClient.filter(f => f.type === Http2FrameType.RstStream).length,
				goaways: proxy.fromServer.filter(f => f.type === Http2FrameType.GoAway).length,
			}, { failures: [], sessions: 1, resetsFromClient: 0, goaways: 0 });
		} finally {
			await proxy.close();
		}
	});

	test('complete headers-only answers (trailers-only, HTTP 401) are not reset; a cancelled open call still is, with CANCEL', async () => {
		handler = (stream, headers) => {
			stream.on('data', () => { });
			switch (headers[':path']) {
				case '/test.Service/TrailersOnly':
					stream.respond({ ...GRPC_HEADERS, 'grpc-status': String(GrpcStatus.NOT_FOUND) }, { endStream: true });
					break;
				case '/test.Service/Unauthorized':
					stream.respond({ ':status': 401, 'www-authenticate': 'Bearer' }, { endStream: true });
					break;
				default:
					stream.respond(GRPC_HEADERS);
			}
		};
		const proxy = await startHttp2FrameProxy(Number(authority.split(':')[1]));
		try {
			const channel = createChannel({ authority: `127.0.0.1:${proxy.port}` });
			const statuses: GrpcStatus[] = [];
			for (const path of ['/test.Service/TrailersOnly', '/test.Service/Unauthorized', '/test.Service/TrailersOnly', '/test.Service/Unauthorized']) {
				statuses.push((await channel.call(path, {}, text('x')).trailers).status);
			}
			const hanging = channel.call('/test.Service/Hang', {}, text('x'));
			await hanging.responseHeaders;
			hanging.cancel();
			await hanging.trailers;
			await timeout(20); // the reset reaches the proxy
			assert.deepStrictEqual({
				statuses,
				resets: proxy.fromClient.filter(f => f.type === Http2FrameType.RstStream).map(f => f.errorCode),
			}, {
				statuses: [GrpcStatus.NOT_FOUND, GrpcStatus.UNAUTHENTICATED, GrpcStatus.NOT_FOUND, GrpcStatus.UNAUTHENTICATED],
				resets: [NGHTTP2_CANCEL],
			});
		} finally {
			await proxy.close();
		}
	});

	test('a complete early response while the request is still being sent: the client stops sending with RST_STREAM(CANCEL) when the server does not reset', async () => {
		// A peer that answers trailers-only at once, never reads the request (no WINDOW_UPDATE) and never resets.
		const received: { type: number; streamId: number; errorCode?: number }[] = [];
		const sockets: net.Socket[] = [];
		const raw = net.createServer(socket => {
			sockets.push(socket);
			socket.on('error', () => { });
			socket.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])); // SETTINGS
			socket.write(Buffer.from([0, 0, 0, 4, 1, 0, 0, 0, 0])); // SETTINGS ACK
			let buffered = Buffer.alloc(0);
			let preface = true;
			socket.on('data', (chunk: Buffer) => {
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
					const streamId = buffered.readUInt32BE(5) & 0x7fffffff;
					received.push({ type, streamId, ...(type === Http2FrameType.RstStream ? { errorCode: buffered.readUInt32BE(9) } : {}) });
					buffered = buffered.subarray(9 + length);
					if (type === Http2FrameType.Headers) {
						// :status 200 (static index 8), content-type: application/grpc (indexed name 31), grpc-status: 0 (a new name).
						const block = Buffer.concat([
							Buffer.from([0x88, 0x5f, 16]), Buffer.from('application/grpc'),
							Buffer.from([0x00, 11]), Buffer.from('grpc-status'), Buffer.from([1]), Buffer.from('0'),
						]);
						const frame = Buffer.concat([Buffer.from([0, 0, block.length, 1, 0x5 /* END_STREAM | END_HEADERS */, 0, 0, 0, 0]), block]);
						frame.writeUInt32BE(streamId, 5);
						socket.write(frame);
					}
				}
			});
		});
		await new Promise<void>(resolve => raw.listen(0, '127.0.0.1', resolve));
		try {
			const address = raw.address();
			assert.ok(address && typeof address === 'object');
			const trailers = await createChannel({ authority: `127.0.0.1:${address.port}` }).call('/test.Service/Early', {}, new Uint8Array(1024 * 1024)).trailers;
			await timeout(20); // the reset reaches the peer
			assert.deepStrictEqual({ status: trailers.status, resets: received.filter(f => f.type === Http2FrameType.RstStream) }, {
				status: GrpcStatus.OK,
				resets: [{ type: Http2FrameType.RstStream, streamId: 1, errorCode: NGHTTP2_CANCEL }],
			});
		} finally {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>(resolve => raw.close(() => resolve()));
		}
	});

	test('reconnects after the server sends GOAWAY', async () => {
		handler = stream => respondGrpc(stream, { messages: [text('ok')] });
		const channel = createChannel();

		await collect(channel.call('/test.Service/One', {}, new Uint8Array(0)));
		assert.strictEqual(sessions.length, 1);

		const serverClosed = new Promise<void>(resolve => sessions[0].on('close', resolve));
		sessions[0].close();
		await serverClosed;

		const second = channel.call('/test.Service/Two', {}, new Uint8Array(0));
		assert.deepStrictEqual((await collect(second)).map(fromBytes), ['ok']);
		assert.strictEqual((await second.trailers).status, GrpcStatus.OK);
		assert.strictEqual(sessions.length, 2);
	});

	test('a call in flight when GOAWAY arrives completes, later calls reconnect', async () => {
		handler = stream => {
			stream.session?.goaway();
			respondGrpc(stream, { messages: [text('ok')] });
		};
		const channel = createChannel();

		const first = channel.call('/test.Service/One', {}, new Uint8Array(0));
		assert.deepStrictEqual((await collect(first)).map(fromBytes), ['ok']);
		assert.strictEqual((await first.trailers).status, GrpcStatus.OK);
		assert.strictEqual(channel.isConnected, false);

		const second = channel.call('/test.Service/Two', {}, new Uint8Array(0));
		assert.deepStrictEqual((await collect(second)).map(fromBytes), ['ok']);
		assert.strictEqual(sessions.length, 2);
	});

	test('HTTP 404 without grpc-status maps to UNIMPLEMENTED', async () => {
		handler = stream => {
			stream.respond({ ':status': 404, 'content-type': 'text/plain' });
			stream.end('not found');
		};

		const call = createChannel().call('/test.Service/Missing', {}, new Uint8Array(0));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.UNIMPLEMENTED);
		assert.strictEqual(trailers.message, 'HTTP status 404');
		assert.strictEqual(trailers.httpStatus, 404);
		assert.strictEqual(trailers.raw['grpc-status'], undefined);
		assert.strictEqual((await call.responseHeaders).httpStatus, 404);
		const error = await collectError(call);
		assert.strictEqual(error.httpStatus, 404);
	});

	test('the trailers carry the HTTP status: 200 for a gRPC answer, none when no response arrived', async () => {
		handler = stream => stream.respond({ ...GRPC_HEADERS, 'grpc-status': '12' }, { endStream: true });
		const answered = await createChannel().call('/test.Service/Missing', {}, new Uint8Array(0)).trailers;

		const probe = net.createServer();
		await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
		const address = probe.address();
		assert.ok(address && typeof address === 'object');
		await new Promise<void>(resolve => probe.close(() => resolve()));
		const refused = await createChannel({ authority: `127.0.0.1:${address.port}` }).call('/test.Service/Nobody', {}, new Uint8Array(0)).trailers;

		assert.deepStrictEqual([
			{ status: answered.status, httpStatus: answered.httpStatus, grpcStatus: answered.raw['grpc-status'] },
			{ status: refused.status, httpStatus: refused.httpStatus },
		], [
			{ status: GrpcStatus.UNIMPLEMENTED, httpStatus: 200, grpcStatus: '12' },
			{ status: GrpcStatus.UNAVAILABLE, httpStatus: undefined },
		]);
	});

	test('HTTP 503 without grpc-status maps to UNAVAILABLE', async () => {
		handler = stream => stream.respond({ ':status': 503 }, { endStream: true });

		const call = createChannel().call('/test.Service/Down', {}, new Uint8Array(0));
		assert.strictEqual((await call.trailers).status, GrpcStatus.UNAVAILABLE);
	});

	test('HTTP 401 exposes www-authenticate in the response headers', async () => {
		handler = stream => stream.respond({ ':status': 401, 'www-authenticate': 'Bearer realm="vscode"' }, { endStream: true });

		const call = createChannel().call('/test.Service/Secret', {}, new Uint8Array(0));
		const responseHeaders = await call.responseHeaders;
		assert.strictEqual(responseHeaders.httpStatus, 401);
		assert.strictEqual(responseHeaders.headers['www-authenticate'], 'Bearer realm="vscode"');
		assert.strictEqual((await call.trailers).status, GrpcStatus.UNAUTHENTICATED);
	});

	test('a message with the compressed flag set fails with INTERNAL', async () => {
		handler = stream => {
			stream.respond(GRPC_HEADERS, { waitForTrailers: true });
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
			stream.write(Uint8Array.from([1, 0, 0, 0, 1, 42]));
			stream.end();
		};

		const call = createChannel().call('/test.Service/Compressed', {}, new Uint8Array(0));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.INTERNAL);
		assert.ok(trailers.message?.includes('unsupported encoding'), trailers.message);
	});

	test('a response with a non-identity grpc-encoding fails with INTERNAL', async () => {
		handler = stream => respondGrpc(stream, { headers: { 'grpc-encoding': 'gzip' }, messages: [text('x')] });

		const call = createChannel().call('/test.Service/Gzip', {}, new Uint8Array(0));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.INTERNAL);
		assert.strictEqual(trailers.message, `unsupported encoding 'gzip'`);
	});

	test('a 200 response that ends without grpc-status maps to UNKNOWN', async () => {
		handler = stream => {
			stream.respond(GRPC_HEADERS);
			stream.end(encodeLengthPrefixedMessage(text('no trailers')));
		};

		const call = createChannel().call('/test.Service/NoStatus', {}, new Uint8Array(0));
		assert.deepStrictEqual((await collect(call).catch(() => [])).length, 0);
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.UNKNOWN);
		assert.strictEqual(trailers.message, 'missing status');
	});

	test('large unary call: 300 KiB request and 3 MiB response', async () => {
		const requestSize = 300 * 1024;
		const responseSize = 3 * 1024 * 1024;
		handler = async stream => {
			const [request] = await readRequest(stream);
			assert.strictEqual(request.byteLength, requestSize);
			assert.strictEqual(request[0], 0);
			assert.strictEqual(request[requestSize - 1], (requestSize - 1) & 0xff);
			const response = new Uint8Array(responseSize);
			for (let i = 0; i < responseSize; i++) {
				response[i] = (i * 7) & 0xff;
			}
			respondGrpc(stream, { messages: [response] });
		};

		const request = new Uint8Array(requestSize);
		for (let i = 0; i < requestSize; i++) {
			request[i] = i & 0xff;
		}
		const call = createChannel().call('/test.Service/Large', {}, request);
		const messages = await collect(call);
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0].byteLength, responseSize);
		assert.strictEqual(messages[0][1], 7);
		assert.strictEqual(messages[0][responseSize - 1], ((responseSize - 1) * 7) & 0xff);
		assert.strictEqual((await call.trailers).status, GrpcStatus.OK);
	});

	test('binary metadata round trips through -bin headers and trailers', async () => {
		const token = Uint8Array.from([0, 1, 2, 253, 254, 255]);
		handler = (stream, headers) => {
			const received = decodeBinaryMetadata(headerValue(headers['x-token-bin']) ?? '');
			respondGrpc(stream, {
				messages: [text(String(received.byteLength))],
				trailers: { 'x-echo-bin': encodeBinaryMetadata(received) },
			});
		};

		const call = createChannel().call('/test.Service/Bin', { 'X-Token-Bin': encodeBinaryMetadata(token) }, new Uint8Array(0));
		assert.deepStrictEqual((await collect(call)).map(fromBytes), ['6']);
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.deepStrictEqual(Array.from(decodeBinaryMetadata(trailers.raw['x-echo-bin'])), Array.from(token));
	});

	test('losing the connection mid-call fails with UNAVAILABLE and the next call reconnects', async () => {
		handler = stream => {
			stream.respond(GRPC_HEADERS);
			setImmediate(() => stream.session?.destroy());
		};

		const channel = createChannel();
		const call = channel.call('/test.Service/Drop', {}, new Uint8Array(0));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.UNAVAILABLE);
		assert.ok(trailers.message?.startsWith('connection lost'), trailers.message);
		assert.strictEqual(channel.isConnected, false);

		handler = stream => respondGrpc(stream, { messages: [text('back')] });
		const second = channel.call('/test.Service/Again', {}, new Uint8Array(0));
		assert.deepStrictEqual((await collect(second)).map(fromBytes), ['back']);
		assert.strictEqual(sessions.length, 2);
	});

	test('a refused connection fails with UNAVAILABLE', async () => {
		const probe = net.createServer();
		await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
		const address = probe.address();
		assert.ok(address && typeof address === 'object');
		await new Promise<void>(resolve => probe.close(() => resolve()));

		const call = createChannel({ authority: `127.0.0.1:${address.port}` }).call('/test.Service/Nobody', {}, new Uint8Array(0));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.UNAVAILABLE);
		await assert.rejects(call.responseHeaders, (error: unknown) => error instanceof GrpcCallError && error.status === GrpcStatus.UNAVAILABLE);
	});

	test('keepalive pings keep the session usable', async () => {
		handler = stream => respondGrpc(stream, { messages: [text('ok')] });
		const channel = createChannel({ keepAliveTimeMs: 10, keepAliveTimeoutMs: 1000 });

		await collect(channel.call('/test.Service/One', {}, new Uint8Array(0)));
		await timeout(60);
		assert.strictEqual(channel.isConnected, true);
		await collect(channel.call('/test.Service/Two', {}, new Uint8Array(0)));
		assert.strictEqual(sessions.length, 1);
	});

	test('createConnection supplies the socket', async () => {
		handler = stream => respondGrpc(stream, { messages: [text('tunnelled')] });
		let target: { host: string; port: number } | undefined;
		const channel = createChannel({
			createConnection: async t => {
				target = t;
				const socket = net.connect(t.port, t.host);
				await new Promise<void>(resolve => socket.once('connect', resolve));
				return socket;
			},
		});

		const call = channel.call('/test.Service/Proxy', {}, new Uint8Array(0));
		assert.deepStrictEqual((await collect(call)).map(fromBytes), ['tunnelled']);
		assert.deepStrictEqual(target, { host: '127.0.0.1', port: Number(authority.split(':')[1]) });
	});

	test('an explicit port is kept even when it is the default of the other scheme: grpcs://h:80 and grpc://h:443', async () => {
		const targets: { host: string; port: number }[] = [];
		const connectTo = async (channelAuthority: string, secure: boolean) => {
			const channel = createChannel({
				authority: channelAuthority,
				secure,
				createConnection: async target => {
					targets.push(target);
					throw new Error('not connecting');
				},
			});
			return (await channel.call('/test.Service/Where', {}, new Uint8Array(0)).trailers).status;
		};
		const statuses = [
			await connectTo('h.example:80', true),
			await connectTo('h.example:443', false),
			await connectTo('h.example', true),
			await connectTo('h.example', false),
			await connectTo('[::1]:8443', true),
			await connectTo('[::1]', false),
		];
		assert.deepStrictEqual(targets, [
			{ host: 'h.example', port: 80 },
			{ host: 'h.example', port: 443 },
			{ host: 'h.example', port: 443 },
			{ host: 'h.example', port: 80 },
			{ host: '::1', port: 8443 },
			{ host: '::1', port: 80 },
		]);
		assert.ok(statuses.every(s => s === GrpcStatus.UNAVAILABLE));
	});

	test('an internationalized host connects and is sent as :authority by its ASCII form, keeping an explicit port', async () => {
		const port = Number(authority.split(':')[1]);
		const authorities: (string | undefined)[] = [];
		handler = (stream, headers) => {
			authorities.push(headerValue(headers[':authority']));
			respondGrpc(stream, { messages: [text('idn')] });
		};
		const targets: { host: string; port: number }[] = [];
		const channel = createChannel({
			authority: `user@Bücher.example:${port}`,
			createConnection: async target => {
				targets.push(target);
				// DNS would resolve the A-labels; the test server is on the loopback address.
				const socket = net.connect(port, '127.0.0.1');
				await new Promise<void>(resolve => socket.once('connect', resolve));
				return socket;
			},
		});

		assert.deepStrictEqual((await collect(channel.call('/test.Service/Idn', {}, new Uint8Array(0)))).map(fromBytes), ['idn']);
		const parse = (value: string, secure: boolean) => {
			try {
				return parseGrpcAuthority(value, secure);
			} catch {
				return 'invalid';
			}
		};
		assert.deepStrictEqual({
			targets,
			authorities,
			parsed: [parse('bücher.example:80', true), parse('münchen.de', false), parse('[::1]:443', false), parse('bad host.example:443', true)],
		}, {
			targets: [{ host: 'xn--bcher-kva.example', port }],
			authorities: [`xn--bcher-kva.example:${port}`],
			parsed: [{ host: 'xn--bcher-kva.example', port: 80 }, { host: 'xn--mnchen-3ya.de', port: 80 }, { host: '::1', port: 443 }, 'invalid'],
		});
	});

	test('parseGrpcAuthority rejects authorities that do not name a host and a port', () => {
		const outcomes = ['h.example:', 'h.example:99999', 'h.example:8x', '::1', '[::1', '[::1]x', ':443'].map(value => {
			try {
				return parseGrpcAuthority(value, true);
			} catch {
				return 'invalid';
			}
		});
		assert.deepStrictEqual(outcomes, [{ host: 'h.example', port: 443 }, 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
	});

	test('close() cancels in-flight calls and the next call reconnects', async () => {
		handler = stream => stream.respond(GRPC_HEADERS);
		const channel = createChannel();
		const hanging = channel.call('/test.Service/Hang', {}, new Uint8Array(0));
		await hanging.responseHeaders;

		channel.close();
		const trailers = await hanging.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.CANCELLED);
		assert.strictEqual(trailers.message, 'channel closed');
		assert.strictEqual(channel.isConnected, false);

		handler = stream => respondGrpc(stream, { messages: [text('ok')] });
		await collect(channel.call('/test.Service/Again', {}, new Uint8Array(0)));
		assert.strictEqual(sessions.length, 2);
	});

	test('calls after dispose fail with UNAVAILABLE', async () => {
		const channel = createChannel();
		channel.dispose();
		const trailers = await channel.call('/test.Service/Late', {}, new Uint8Array(0)).trailers;
		assert.strictEqual(trailers.status, GrpcStatus.UNAVAILABLE);
		assert.strictEqual(sessions.length, 0);
	});

	test('the session advertises push disabled, a 1 MiB stream window and an 8 KiB header list, and opens a 4 MiB session window', async () => {
		handler = stream => respondGrpc(stream, { messages: [text('ok')] });
		await collect(createChannel().call('/test.Service/Settings', {}, new Uint8Array(0)));
		const [session] = sessions;
		const settings = session.remoteSettings;
		assert.deepStrictEqual({
			enablePush: settings.enablePush,
			initialWindowSize: settings.initialWindowSize,
			maxHeaderListSize: settings.maxHeaderListSize,
			// What the server may still send on the session: the 4 MiB window less the unacknowledged bytes of the reply.
			sessionWindow: (session.state.remoteWindowSize ?? 0) > 4 * 1024 * 1024 - 1024,
		}, {
			enablePush: false,
			initialWindowSize: 1024 * 1024,
			maxHeaderListSize: 8 * 1024,
			sessionWindow: true,
		});
	});

	test('a stream refused with REFUSED_STREAM is retried once transparently; a second refusal fails with UNAVAILABLE', async () => {
		const paths: string[] = [];
		handler = (stream, headers) => {
			paths.push(String(headers[':path']));
			if (headers[':path'] === '/test.Service/Refused' || paths.length === 1) {
				stream.close(NGHTTP2_REFUSED_STREAM);
			} else {
				respondGrpc(stream, { messages: [text('second attempt')] });
			}
		};
		const channel = createChannel();
		const retried = channel.call('/test.Service/Once', {}, text('request'));
		const retriedMessages = (await collect(retried)).map(fromBytes);
		const refused = await channel.call('/test.Service/Refused', {}, new Uint8Array(0)).trailers;
		assert.deepStrictEqual({
			retriedMessages,
			retried: (await retried.trailers).status,
			refused: [refused.status, refused.message],
			paths,
		}, {
			retriedMessages: ['second attempt'],
			retried: GrpcStatus.OK,
			refused: [GrpcStatus.UNAVAILABLE, 'stream refused by the server'],
			paths: ['/test.Service/Once', '/test.Service/Once', '/test.Service/Refused', '/test.Service/Refused'],
		});
	});

	test('REFUSED_STREAM after the response headers is not retried: the server has seen the request', async () => {
		// Node's server ends a stream before resetting it once it has responded, so a peer
		// that writes the frames itself: HEADERS (:status 200), then RST_STREAM(REFUSED_STREAM).
		const requestStreams: number[] = [];
		const sockets: net.Socket[] = [];
		const raw = net.createServer(socket => {
			sockets.push(socket);
			socket.on('error', () => { });
			socket.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])); // SETTINGS
			socket.write(Buffer.from([0, 0, 0, 4, 1, 0, 0, 0, 0])); // SETTINGS ACK
			let buffered = Buffer.alloc(0);
			let preface = true;
			socket.on('data', (chunk: Buffer) => {
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
					const streamId = buffered.readUInt32BE(5) & 0x7fffffff;
					buffered = buffered.subarray(9 + length);
					if (type === 1) { // HEADERS: a request
						requestStreams.push(streamId);
						const headers = Buffer.from([0, 0, 1, 1, 4, 0, 0, 0, 0, 0x88]); // END_HEADERS, :status 200 (static index 8)
						headers.writeUInt32BE(streamId, 5);
						const reset = Buffer.from([0, 0, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, NGHTTP2_REFUSED_STREAM]);
						reset.writeUInt32BE(streamId, 5);
						socket.write(Buffer.concat([headers, reset]));
					}
				}
			});
		});
		await new Promise<void>(resolve => raw.listen(0, '127.0.0.1', resolve));
		try {
			const address = raw.address();
			assert.ok(address && typeof address === 'object');
			const trailers = await createChannel({ authority: `127.0.0.1:${address.port}` }).call('/test.Service/Answered', {}, new Uint8Array(0)).trailers;
			await timeout(20); // a retry would have reached the peer by now
			assert.deepStrictEqual({ status: trailers.status, message: trailers.message, httpStatus: trailers.httpStatus, requestStreams }, {
				status: GrpcStatus.UNAVAILABLE,
				message: 'stream refused by the server',
				httpStatus: 200,
				requestStreams: [1],
			});
		} finally {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>(resolve => raw.close(() => resolve()));
		}
	});

	test('GOAWAY below an in-flight stream: the lower stream finishes on the old session, the higher one is retried on a new session', async () => {
		const seen: { path: string; session: number }[] = [];
		const pending: { stream: http2.ServerHttp2Stream; path: string }[] = [];
		handler = (stream, headers) => {
			const path = String(headers[':path']);
			const session = sessions.indexOf(stream.session as http2.ServerHttp2Session);
			seen.push({ path, session });
			if (session > 0) {
				respondGrpc(stream, { messages: [text(`${path} on the new session`)] });
				return;
			}
			pending.push({ stream, path });
			if (pending.length === 2) {
				// The server processes the first stream only.
				stream.session!.goaway(NGHTTP2_NO_ERROR, pending[0].stream.id!);
				respondGrpc(pending[0].stream, { messages: [text(`${pending[0].path} on the old session`)] });
			}
		};
		const channel = createChannel();
		const first = channel.call('/test.Service/First', {}, new Uint8Array(0));
		await timeout(20); // the first stream gets the lower id
		const second = channel.call('/test.Service/Second', {}, new Uint8Array(0));
		const [firstMessages, secondMessages] = await Promise.all([collect(first), collect(second)]);
		assert.deepStrictEqual({
			first: firstMessages.map(fromBytes),
			second: secondMessages.map(fromBytes),
			statuses: [(await first.trailers).status, (await second.trailers).status],
			seen,
		}, {
			first: ['/test.Service/First on the old session'],
			second: ['/test.Service/Second on the new session'],
			statuses: [GrpcStatus.OK, GrpcStatus.OK],
			seen: [
				{ path: '/test.Service/First', session: 0 },
				{ path: '/test.Service/Second', session: 0 },
				{ path: '/test.Service/Second', session: 1 },
			],
		});
	});

	test('a transparent retry sends what is left of the deadline as grpc-timeout', async () => {
		const timeouts: string[] = [];
		handler = (stream, headers) => {
			timeouts.push(headerValue(headers['grpc-timeout']) ?? 'none');
			if (timeouts.length === 1) {
				setTimeout(() => stream.close(NGHTTP2_REFUSED_STREAM), 150);
			} else {
				respondGrpc(stream, { messages: [text('ok')] });
			}
		};
		const call = createChannel().call('/test.Service/Retry', {}, new Uint8Array(0), { deadlineMs: 10_000 });
		await collect(call);
		const retryMs = parseGrpcTimeout(timeouts[1]);
		assert.deepStrictEqual({ first: timeouts[0], status: (await call.trailers).status, retryIsLess: retryMs <= 10_000 - 100 && retryMs > 5_000 }, { first: '10S', status: GrpcStatus.OK, retryIsLess: true });
	});

	test('a session closing before the deferred outcome of its refused stream retries the call exactly once', async () => {
		let requests = 0;
		handler = stream => {
			requests++;
			if (requests === 2) {
				stream.close(NGHTTP2_REFUSED_STREAM);
			} else {
				respondGrpc(stream, { messages: [text(`answer ${requests}`)] });
			}
		};
		const channel = createChannel();
		await collect(channel.call('/test.Service/Warmup', {}, new Uint8Array(0)));

		// eslint-disable-next-line local/code-no-bracket-notation-for-identifiers -- Reach the client session to reproduce an event order the network rarely produces.
		const session = channel['current']!.session;
		const request = session.request.bind(session);
		session.request = (headers, options) => {
			const stream = request(headers, options);
			// Registered before the call's own listener: the session's 'close' runs
			// before the deferred outcome of the refused stream.
			stream.once('close', () => session.emit('close'));
			return stream;
		};

		const call = channel.call('/test.Service/Refused', {}, new Uint8Array(0));
		const messages = (await collect(call).catch(e => [text(String(e))])).map(fromBytes);
		await timeout(20); // a stale outcome or a second retry would show by now
		assert.deepStrictEqual({ messages, status: (await call.trailers).status, requests, sessions: sessions.length }, { messages: ['answer 3'], status: GrpcStatus.OK, requests: 3, sessions: 2 });
	});

	test('close() cancels a call whose retry waits for a new connection, and nothing more is sent', async () => {
		let requests = 0;
		handler = stream => {
			if (++requests === 1) {
				respondGrpc(stream, { messages: [text('warmup')] });
			} else {
				// GOAWAY below the stream: the call must be retried on a new session.
				stream.session!.goaway(NGHTTP2_NO_ERROR, 1);
			}
		};
		const gate = new DeferredPromise<void>();
		const secondConnection = new DeferredPromise<void>();
		let connections = 0;
		const channel = createChannel({
			createConnection: async target => {
				if (++connections === 2) {
					secondConnection.complete();
					await gate.p;
				}
				const socket = net.connect(target.port, target.host);
				await new Promise<void>(resolve => socket.once('connect', resolve));
				return socket;
			},
		});
		await collect(channel.call('/test.Service/Warmup', {}, new Uint8Array(0)));
		const call = channel.call('/test.Service/Retry', {}, new Uint8Array(0));
		await secondConnection.p;
		channel.close();
		const trailers = await call.trailers;
		gate.complete();
		await timeout(50);
		assert.deepStrictEqual({ status: trailers.status, message: trailers.message, requests }, { status: GrpcStatus.CANCELLED, message: 'channel closed', requests: 2 });
	});

	test('RST_STREAM ENHANCE_YOUR_CALM maps to RESOURCE_EXHAUSTED and other reset codes to INTERNAL', async () => {
		handler = (stream, headers) => stream.close(headers[':path'] === '/test.Service/Calm' ? NGHTTP2_ENHANCE_YOUR_CALM : NGHTTP2_INTERNAL_ERROR);
		const channel = createChannel();
		const calm = await channel.call('/test.Service/Calm', {}, new Uint8Array(0)).trailers;
		const internal = await channel.call('/test.Service/Internal', {}, new Uint8Array(0)).trailers;
		assert.deepStrictEqual([[calm.status, calm.message], [internal.status, internal.message]], [
			[GrpcStatus.RESOURCE_EXHAUSTED, 'stream reset by the server (ENHANCE_YOUR_CALM)'],
			[GrpcStatus.INTERNAL, `stream reset by the server (code ${NGHTTP2_INTERNAL_ERROR})`],
		]);
	});

	test('HTTP 415 without grpc-status maps to UNKNOWN', async () => {
		handler = stream => stream.respond({ ':status': 415, 'content-type': 'text/plain' }, { endStream: true });
		const trailers = await createChannel().call('/test.Service/Media', {}, new Uint8Array(0)).trailers;
		assert.deepStrictEqual({ status: trailers.status, message: trailers.message, httpStatus: trailers.httpStatus }, { status: GrpcStatus.UNKNOWN, message: 'HTTP status 415', httpStatus: 415 });
	});

	test('a keepalive PING that is not acknowledged in time destroys the session and fails the open call with UNAVAILABLE', async () => {
		// A peer that completes the HTTP/2 handshake and then never answers anything, PINGs included.
		const sockets: net.Socket[] = [];
		const silent = net.createServer(socket => {
			sockets.push(socket);
			socket.on('error', () => { });
			socket.on('data', () => { });
			socket.write(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0, 0])); // SETTINGS
			socket.write(Buffer.from([0, 0, 0, 4, 1, 0, 0, 0, 0])); // SETTINGS ACK
		});
		await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
		try {
			const address = silent.address();
			assert.ok(address && typeof address === 'object');
			const channel = createChannel({ authority: `127.0.0.1:${address.port}`, keepAliveTimeMs: 20, keepAliveTimeoutMs: 50 });
			const trailers = await channel.call('/test.Service/Hang', {}, new Uint8Array(0)).trailers;
			assert.deepStrictEqual({ status: trailers.status, message: trailers.message, connected: channel.isConnected }, {
				status: GrpcStatus.UNAVAILABLE,
				message: 'connection lost: keepalive ping not acknowledged within 50ms',
				connected: false,
			});
		} finally {
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise<void>(resolve => silent.close(() => resolve()));
		}
	});

	test('a zero or negative keepalive interval sends no pings', async () => {
		let pings = 0;
		server.on('session', session => session.on('ping', () => pings++));
		handler = stream => respondGrpc(stream, { messages: [text('ok')] });
		for (const keepAliveTimeMs of [0, -1, Number.NaN]) {
			await collect(createChannel({ keepAliveTimeMs }).call('/test.Service/Quiet', {}, new Uint8Array(0)));
		}
		await timeout(50);
		assert.strictEqual(pings, 0);
	});

	test('a keepalive interval or a deadline beyond what a timer can wait (2^31 ms) fires neither at once', async () => {
		let pings = 0;
		server.on('session', session => session.on('ping', () => pings++));
		handler = stream => stream.respond(GRPC_HEADERS); // and never ends
		const channel = createChannel({ keepAliveTimeMs: 2 ** 31, longLivedKeepAliveTimeMs: 2 ** 32 });
		const call = channel.call('/test.Service/Hang', {}, new Uint8Array(0), { deadlineMs: 2 ** 31, longLived: true });
		await call.responseHeaders;
		// Node fires a timer over 2^31-1 ms after 1 ms: the call would be over and the pings counted by now.
		const outcome = await Promise.race([call.trailers.then(t => `settled: ${t.status} ${t.message}`), timeout(50).then(() => 'open')]);
		call.cancel();
		assert.deepStrictEqual({ outcome, pings }, { outcome: 'open', pings: 0 });
	});

	test('a deadline beyond what a timer can wait is reached in steps of at most 2^31-1 ms', async () => {
		const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		try {
			// A connection that never opens: only the deadline can end the call.
			const channel = createChannel({ createConnection: () => new Promise(() => { }) });
			const call = channel.call('/test.Service/Never', {}, new Uint8Array(0), { deadlineMs: 2 ** 31 + 1000 });
			let settled: GrpcStatus | undefined;
			call.trailers.then(t => settled = t.status);
			await clock.tickAsync(2 ** 31 - 1);
			const afterFirstStep = settled;
			await clock.tickAsync(1001);
			assert.deepStrictEqual({ afterFirstStep, settled }, { afterFirstStep: undefined, settled: GrpcStatus.DEADLINE_EXCEEDED });
		} finally {
			clock.restore();
		}
	});

	test('a long-lived call keeps the session pinged at longLivedKeepAliveTimeMs while it is open, and only then; keepAliveTimeMs pings while any call is open, never an idle session', async () => {
		let pings = 0;
		server.on('session', session => session.on('ping', () => pings++));
		let listening: http2.ServerHttp2Stream | undefined;
		handler = (stream, headers) => {
			if (headers[':path'] === '/test.Service/Listen') {
				listening = stream;
				stream.respond(GRPC_HEADERS, { waitForTrailers: true });
				stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
			} else {
				respondGrpc(stream, { messages: [text('ok')] });
			}
		};
		/** Waits until `count` pings more than `base` arrived (timers run late on a busy machine). */
		const pingsAfter = async (base: number, count: number) => {
			for (const start = Date.now(); pings - base < count; await timeout(5)) {
				assert.ok(Date.now() - start < 5000, `${count} pings expected, ${pings - base} arrived`);
			}
		};
		const channel = createChannel({ longLivedKeepAliveTimeMs: 10 });
		await collect(channel.call('/test.Service/Unary', {}, new Uint8Array(0)));
		await timeout(60);
		const beforeListen = pings;

		const listen = channel.call('/test.Service/Listen', {}, new Uint8Array(0), { longLived: true });
		await listen.responseHeaders;
		await pingsAfter(beforeListen, 3);

		assert.ok(listening);
		listening.end();
		await listen.trailers;
		await timeout(100); // a ping already on the way is answered
		const atClose = pings;
		await timeout(150);
		const afterClose = pings - atClose;

		// keepAliveTimeMs pings while any call is open (here the listen call, not long-lived) and stops
		// when the last one closes: an idle connection is not pinged (grpc-js's permit_without_calls off).
		const always = createChannel({ keepAliveTimeMs: 10, longLivedKeepAliveTimeMs: 60_000 });
		await collect(always.call('/test.Service/Unary', {}, new Uint8Array(0)));
		await timeout(30); // a ping already on the way is answered
		const atIdle = pings;
		await timeout(150);
		const idle = pings - atIdle;
		const open = always.call('/test.Service/Listen', {}, new Uint8Array(0));
		await open.responseHeaders;
		await pingsAfter(pings, 3);
		const openListen: http2.ServerHttp2Stream | undefined = listening;
		assert.ok(openListen);
		openListen.end();
		await open.trailers;
		await timeout(100);
		const atSecondClose = pings;
		await timeout(150);
		assert.deepStrictEqual({ beforeListen, afterClose, idle, afterSecondClose: pings - atSecondClose }, { beforeListen: 0, afterClose: 0, idle: 0, afterSecondClose: 0 });
	});

	test('a session that received GOAWAY keeps the calls it drains alive: with keepalive frames while they are open, and only then', async () => {
		// Node closes a session at once on GOAWAY and sends no PING on it; the channel sends an empty SETTINGS
		// frame instead, which the server acknowledges the same way.
		let keepAlives = 0;
		server.on('session', session => {
			session.on('ping', () => keepAlives++);
			session.on('remoteSettings', () => keepAlives++);
		});
		let listening: http2.ServerHttp2Stream | undefined;
		handler = stream => {
			listening = stream;
			stream.respond(GRPC_HEADERS, { waitForTrailers: true });
			stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
		};
		const keepAlivesAfter = async (base: number, count: number) => {
			for (const start = Date.now(); keepAlives - base < count; await timeout(5)) {
				assert.ok(Date.now() - start < 5000, `${count} keepalives expected, ${keepAlives - base} arrived`);
			}
		};
		for (const options of [{ longLivedKeepAliveTimeMs: 10 }, { keepAliveTimeMs: 10 }]) {
			const channel = createChannel({ ...options, keepAliveTimeoutMs: 1000 });
			const listen = channel.call('/test.Service/Listen', {}, new Uint8Array(0), { longLived: true });
			await listen.responseHeaders;
			await keepAlivesAfter(keepAlives, 2);
			assert.ok(listening?.session);
			// A graceful GOAWAY that lets the open stream finish (grpc-core MAX_CONNECTION_AGE, a proxy draining).
			listening.session.goaway(http2.constants.NGHTTP2_NO_ERROR, listening.id ?? 1);
			await timeout(50);
			const atGoaway = keepAlives;
			await keepAlivesAfter(atGoaway, 3);
			assert.strictEqual(channel.isConnected, false, 'no new call goes to the draining session');

			listening.end();
			const trailers = await listen.trailers;
			assert.strictEqual(trailers.status, GrpcStatus.OK, JSON.stringify(options));
			await timeout(50);
			const atEnd = keepAlives;
			await timeout(100);
			assert.strictEqual(keepAlives - atEnd, 0, `no keepalive once the drained call ended (${JSON.stringify(options)})`);
		}
	});

	test('a GOAWAY too_many_pings (ENHANCE_YOUR_CALM) doubles the keepalive interval of the next session, as grpc-js does', async () => {
		// The interval is read from the channel's keepalive timer, not from the gaps between the pings the server
		// receives: a stall of the event loop between a send and its receipt would shorten such a gap. Only the
		// timers the channel module starts count (the stack of each call names the module that made it): Node,
		// the test runner or another module may start timers in the same process meanwhile, as this test does.
		const realSetInterval = globalThis.setInterval;
		const channelIntervals: (number | undefined)[] = [];
		const setIntervalStub = sinon.stub(globalThis, 'setInterval').callsFake((callback, delay, ...args) => {
			if (/[\\/]base[\\/]node[\\/]grpcChannel\.js:\d+:\d+/.test(new Error().stack ?? '')) {
				channelIntervals.push(delay);
			}
			return realSetInterval(callback, delay, ...args);
		});
		try {
			clearInterval(setInterval(() => { }, 40)); // a timer of another module, with the same interval
			const pings = new Map<http2.ServerHttp2Session, number>();
			let hanging: http2.ServerHttp2Stream | undefined;
			server.on('session', session => {
				pings.set(session, 0);
				session.on('ping', () => {
					const count = (pings.get(session) ?? 0) + 1;
					pings.set(session, count);
					if (pings.size === 1 && count === 4) {
						// as grpc-core does on the third ping strike; the open stream is not refused (so not retried)
						session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM, hanging?.id ?? 1, Buffer.from('too_many_pings'));
					}
				});
			});
			handler = stream => {
				hanging = stream;
				stream.respond(GRPC_HEADERS); // and never ends
			};
			const channel = createChannel({ keepAliveTimeMs: 40, keepAliveTimeoutMs: 1000 });
			const first = await channel.call('/test.Service/Hang', {}, new Uint8Array(0)).trailers;
			assert.strictEqual(first.status, GrpcStatus.UNAVAILABLE, first.message);

			const second = channel.call('/test.Service/Hang', {}, new Uint8Array(0));
			await second.responseHeaders;
			for (const start = Date.now(); (Array.from(pings.values())[1] ?? 0) < 2; await timeout(10)) {
				assert.ok(Date.now() - start < 5000, 'the second session pings');
			}
			second.cancel();
			assert.deepStrictEqual(channelIntervals, [40, 80], 'the keepalive interval of the first session, then of the second');
			assert.ok(setIntervalStub.callCount > channelIntervals.length, 'the timer of the test went through the stub too');
		} finally {
			setIntervalStub.restore();
		}
	});

	test('two concurrent 4 MiB responses arrive complete', async () => {
		const size = DEFAULT_MAX_GRPC_MESSAGE_BYTES;
		handler = (stream, headers) => {
			const fill = headers[':path'] === '/test.Service/A' ? 0xa : 0xb;
			respondGrpc(stream, { messages: [new Uint8Array(size).fill(fill)] });
		};
		const channel = createChannel();
		const [a, b] = await Promise.all(['/test.Service/A', '/test.Service/B'].map(path => collect(channel.call(path, {}, new Uint8Array(0)))));
		const summary = (messages: Uint8Array[]) => messages.map(m => ({ length: m.byteLength, first: m[0], last: m[m.byteLength - 1] }));
		assert.deepStrictEqual([summary(a), summary(b), sessions.length], [[{ length: size, first: 0xa, last: 0xa }], [{ length: size, first: 0xb, last: 0xb }], 1]);
	});

	test('custom metadata: an ascii header comes back in the response headers and a -bin header in the trailers (0xababab)', async () => {
		handler = (stream, headers) => respondGrpc(stream, {
			headers: { 'x-grpc-test-echo-initial': headerValue(headers['x-grpc-test-echo-initial']) ?? 'missing' },
			messages: [text('ok')],
			trailers: { 'x-grpc-test-echo-trailing-bin': headerValue(headers['x-grpc-test-echo-trailing-bin']) ?? '' },
		});
		const call = createChannel().call('/test.Service/Metadata', {
			'x-grpc-test-echo-initial': 'test_initial_metadata_value',
			'x-grpc-test-echo-trailing-bin': encodeBinaryMetadata(Uint8Array.from([0xab, 0xab, 0xab])),
		}, new Uint8Array(0));
		await collect(call);
		const trailers = await call.trailers;
		assert.deepStrictEqual({
			initial: (await call.responseHeaders).headers['x-grpc-test-echo-initial'],
			trailing: Array.from(decodeBinaryMetadata(trailers.raw['x-grpc-test-echo-trailing-bin'])),
		}, { initial: 'test_initial_metadata_value', trailing: [0xab, 0xab, 0xab] });
	});
});
