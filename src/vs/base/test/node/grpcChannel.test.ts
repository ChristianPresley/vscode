/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http2 from 'http2';
import * as net from 'net';
import { timeout } from '../../common/async.js';
import { LengthPrefixedMessageReader, encodeLengthPrefixedMessage } from '../../common/grpc/lpm.js';
import { GrpcStatus, decodeBinaryMetadata, encodeBinaryMetadata, encodeGrpcMessage } from '../../common/grpc/status.js';
import { GrpcCallError, GrpcChannel, IGrpcCall, IGrpcChannelOptions } from '../../node/grpcChannel.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

type StreamHandler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, flags: number) => void;

const { NGHTTP2_CANCEL, NGHTTP2_NO_ERROR } = http2.constants;
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
		assert.strictEqual((await call.responseHeaders).httpStatus, 404);
		const error = await collectError(call);
		assert.strictEqual(error.httpStatus, 404);
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
});
