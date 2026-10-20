/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http2 from 'http2';
import { DeferredPromise, timeout } from '../../common/async.js';
import { encodeLengthPrefixedMessage } from '../../common/grpc/lpm.js';
import { GrpcStatus, decodeGrpcMessage } from '../../common/grpc/status.js';
import { GrpcChannel, GrpcCallError, IGrpcCall } from '../../node/grpcChannel.js';
import { GrpcCallHandler, GrpcServer, IGrpcServerCall, IGrpcServerOptions, truncateUtf8 } from '../../node/grpcServer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

const { NGHTTP2_NO_ERROR, NGHTTP2_ENHANCE_YOUR_CALM } = http2.constants;
const PATH = '/test.Service/Echo';

function text(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function fromBytes(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function framed(payload: Uint8Array): Buffer {
	const bytes = encodeLengthPrefixedMessage(payload);
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function collect(call: IGrpcCall): Promise<Uint8Array[]> {
	const messages: Uint8Array[] = [];
	for await (const message of call.messages) {
		messages.push(message);
	}
	return messages;
}

interface IRawOutcome {
	readonly headers: http2.IncomingHttpHeaders;
	readonly trailers: http2.IncomingHttpHeaders | undefined;
	readonly body: Buffer;
	readonly rstCode: number;
}

interface IRawOptions {
	readonly method?: string;
	readonly path?: string;
	readonly headers?: http2.OutgoingHttpHeaders;
	readonly body?: Uint8Array;
	/** Leaves the request open after the body (to see an early response). */
	readonly keepOpen?: boolean;
	readonly authority?: string;
}

/** A raw HTTP/2 request, for what a gRPC channel never sends. */
function rawCall(port: number, options: IRawOptions = {}): Promise<IRawOutcome> {
	return new Promise((resolve, reject) => {
		const session = http2.connect(`http://127.0.0.1:${port}`);
		session.on('error', reject);
		const stream = session.request({
			':method': options.method ?? 'POST',
			':path': options.path ?? PATH,
			':authority': options.authority ?? `127.0.0.1:${port}`,
			'content-type': 'application/grpc',
			'te': 'trailers',
			...options.headers,
		}, { endStream: false });
		let headers: http2.IncomingHttpHeaders = {};
		let trailers: http2.IncomingHttpHeaders | undefined;
		const chunks: Buffer[] = [];
		stream.on('response', h => { headers = h; });
		stream.on('trailers', t => { trailers = t; });
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', () => { /* the reset is reported by rstCode */ });
		stream.on('close', () => {
			const rstCode = stream.rstCode ?? -1;
			session.close();
			resolve({ headers, trailers, body: Buffer.concat(chunks), rstCode });
		});
		if (options.body) {
			stream.write(Buffer.from(options.body));
		}
		if (!options.keepOpen) {
			stream.end();
		}
	});
}

function statusOf(outcome: IRawOutcome): string | undefined {
	const value = outcome.trailers?.['grpc-status'] ?? outcome.headers['grpc-status'];
	return value === undefined ? undefined : String(value);
}

suite('GrpcServer', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let servers: GrpcServer[];

	setup(() => {
		servers = [];
	});

	teardown(async () => {
		await Promise.all(servers.map(server => server.close()));
	});

	async function startServer(handler: GrpcCallHandler, options: IGrpcServerOptions = {}, path = PATH): Promise<{ server: GrpcServer; port: number }> {
		const server = store.add(new GrpcServer({ shutdownGraceMs: 200, ...options }));
		servers.push(server);
		store.add(server.addService(path, handler));
		const port = await server.listen();
		return { server, port };
	}

	function channelFor(port: number): GrpcChannel {
		return store.add(new GrpcChannel({ authority: `127.0.0.1:${port}`, secure: false }));
	}

	/** Echoes the request with the metadata the handler saw. */
	const echoHandler: GrpcCallHandler = async call => {
		const request = await call.readRequest();
		if (!request) {
			return;
		}
		call.sendMessage(text(JSON.stringify({ body: fromBytes(request), metadata: call.metadata, authority: call.authority, path: call.path })));
		call.end(GrpcStatus.OK, undefined, { 'x-trailer': 'done' });
	};

	test('a unary call round trips the request, the metadata and the trailers', async () => {
		const { port } = await startServer(echoHandler);
		const call = channelFor(port).call(PATH, { 'x-custom': 'value' }, text('hello'));
		const headers = await call.responseHeaders;
		assert.strictEqual(headers.httpStatus, 200);
		assert.strictEqual(headers.headers['content-type'], 'application/grpc+proto');
		const [message] = await collect(call);
		const echo = JSON.parse(fromBytes(message));
		assert.strictEqual(echo.body, 'hello');
		assert.strictEqual(echo.metadata['x-custom'], 'value');
		assert.strictEqual(echo.metadata.te, 'trailers');
		assert.strictEqual(echo.authority, `127.0.0.1:${port}`);
		assert.strictEqual(echo.path, PATH);
		assert.strictEqual(echo.metadata[':path'], undefined);
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.OK);
		assert.strictEqual(trailers.raw['x-trailer'], 'done');
	});

	test('a streaming response carries every message before the trailers', async () => {
		const { port } = await startServer(async call => {
			await call.readRequest();
			for (let i = 0; i < 5; i++) {
				assert.ok(call.sendMessage(text(`m${i}`)));
				await timeout(1);
			}
			call.end(GrpcStatus.OK);
			assert.strictEqual(call.sendMessage(text('late')), false);
		});
		const call = channelFor(port).call(PATH, {}, text('go'));
		assert.deepStrictEqual((await collect(call)).map(fromBytes), ['m0', 'm1', 'm2', 'm3', 'm4']);
		assert.strictEqual((await call.trailers).status, GrpcStatus.OK);
	});

	test('an error before any message is a trailers-only response', async () => {
		const { port } = await startServer(call => {
			call.end(GrpcStatus.NOT_FOUND, 'no such thing: ü', { 'mcp-error-code': '-32601' });
		});
		const outcome = await rawCall(port, { body: framed(text('x')) });
		assert.strictEqual(outcome.headers[':status'], 200);
		assert.strictEqual(outcome.trailers, undefined, 'the status travels in the only header block');
		assert.strictEqual(outcome.headers['grpc-status'], '5');
		assert.strictEqual(decodeGrpcMessage(String(outcome.headers['grpc-message'])), 'no such thing: ü');
		assert.strictEqual(outcome.headers['mcp-error-code'], '-32601');
		assert.strictEqual(outcome.body.byteLength, 0);

		const call = channelFor(port).call(PATH, {}, text('x'));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.NOT_FOUND);
		assert.strictEqual(trailers.message, 'no such thing: ü');
	});

	test('grpc-message is cut to 1024 bytes of UTF-8', async () => {
		const { port } = await startServer(call => call.end(GrpcStatus.INTERNAL, 'é'.repeat(2000)));
		const trailers = await channelFor(port).call(PATH, {}, text('x')).trailers;
		assert.strictEqual(trailers.message, 'é'.repeat(512));
		assert.strictEqual(truncateUtf8('a😀b', 4), 'a');
		assert.strictEqual(truncateUtf8('a😀b', 5), 'a😀');
		assert.strictEqual(truncateUtf8('abc', 10), 'abc');
	});

	test('a request that is not a POST gets HTTP 405, one without a gRPC content type 415', async () => {
		let called = false;
		const { port } = await startServer(() => { called = true; });
		const get = await rawCall(port, { method: 'GET' });
		assert.strictEqual(get.headers[':status'], 405);
		assert.strictEqual(get.headers['grpc-status'], undefined);
		const json = await rawCall(port, { headers: { 'content-type': 'application/json' }, body: text('{}') });
		assert.strictEqual(json.headers[':status'], 415);
		assert.strictEqual(called, false);
	});

	test('an unknown path and a compressed encoding are UNIMPLEMENTED', async () => {
		let called = false;
		const { port } = await startServer(() => { called = true; });
		const unknown = await rawCall(port, { path: '/test.Service/Other', body: framed(text('x')) });
		assert.strictEqual(statusOf(unknown), String(GrpcStatus.UNIMPLEMENTED));
		assert.strictEqual(unknown.headers['grpc-accept-encoding'], 'identity');

		const gzip = await rawCall(port, { headers: { 'grpc-encoding': 'gzip' }, body: framed(text('x')) });
		assert.strictEqual(statusOf(gzip), String(GrpcStatus.UNIMPLEMENTED));
		assert.strictEqual(gzip.headers['grpc-accept-encoding'], 'identity');

		const compressedFlag = Buffer.from(framed(text('x')));
		compressedFlag[0] = 1;
		const flagged = await startServer(echoHandler, {}, '/test.Service/Flagged');
		const compressed = await rawCall(flagged.port, { path: '/test.Service/Flagged', body: compressedFlag });
		assert.strictEqual(statusOf(compressed), String(GrpcStatus.UNIMPLEMENTED));
		assert.strictEqual(called, false);
	});

	test('a refused :authority is PERMISSION_DENIED before the message is read', async () => {
		let called = false;
		const { port } = await startServer(call => {
			called = true;
			call.end(GrpcStatus.OK);
		}, { isAllowedAuthority: authority => authority?.startsWith('127.0.0.1:') === true });
		const outcome = await rawCall(port, { authority: 'evil.example:80', body: framed(text('x')) });
		assert.strictEqual(statusOf(outcome), String(GrpcStatus.PERMISSION_DENIED));
		assert.strictEqual(called, false);
		const ok = await channelFor(port).call(PATH, {}, text('x')).trailers;
		assert.strictEqual(ok.status, GrpcStatus.OK);
		assert.strictEqual(called, true);
	});

	test('a request message over the limit is RESOURCE_EXHAUSTED, also before the request ends (RST_STREAM NO_ERROR)', async () => {
		let called = 0;
		const { port } = await startServer(async call => {
			called++;
			await call.readRequest();
		}, { maxReceiveMessageBytes: 1024 });
		const call = channelFor(port).call(PATH, {}, new Uint8Array(2048));
		const trailers = await call.trailers;
		assert.strictEqual(trailers.status, GrpcStatus.RESOURCE_EXHAUSTED);
		assert.match(trailers.message ?? '', /2048 bytes exceeds the limit of 1024 bytes/);

		// The client announces a large message and keeps sending: the server answers early and resets with NO_ERROR.
		const prefix = Buffer.from([0, 0, 0x10, 0, 0]);
		const early = await rawCall(port, { body: prefix, keepOpen: true });
		assert.strictEqual(statusOf(early), String(GrpcStatus.RESOURCE_EXHAUSTED));
		assert.strictEqual(early.rstCode, NGHTTP2_NO_ERROR);
		assert.strictEqual(called, 2);
	});

	test('a response message over the send limit is RESOURCE_EXHAUSTED', async () => {
		let sent: boolean | undefined;
		const { port } = await startServer(async call => {
			await call.readRequest();
			sent = call.sendMessage(new Uint8Array(4096));
		}, { maxSendMessageBytes: 1024 });
		const trailers = await channelFor(port).call(PATH, {}, text('x')).trailers;
		assert.strictEqual(trailers.status, GrpcStatus.RESOURCE_EXHAUSTED);
		assert.strictEqual(sent, false);
	});

	test('a missing, second, or truncated request message is INVALID_ARGUMENT', async () => {
		const { port } = await startServer(echoHandler);
		const none = await rawCall(port);
		assert.strictEqual(statusOf(none), String(GrpcStatus.INVALID_ARGUMENT));
		assert.match(decodeGrpcMessage(String(none.headers['grpc-message'])), /no request message/);

		const two = await rawCall(port, { body: Buffer.concat([framed(text('a')), framed(text('b'))]) });
		assert.strictEqual(statusOf(two), String(GrpcStatus.INVALID_ARGUMENT));

		const truncated = await rawCall(port, { body: framed(text('abc')).subarray(0, 6) });
		assert.strictEqual(statusOf(truncated), String(GrpcStatus.INVALID_ARGUMENT));
		assert.match(decodeGrpcMessage(String(truncated.headers['grpc-message'])), /Truncated/);
	});

	test('grpc-timeout cancels the handler and ends the call with DEADLINE_EXCEEDED', async () => {
		const cancelled = new DeferredPromise<IGrpcServerCall>();
		const { port } = await startServer(async call => {
			await call.readRequest();
			call.sendMessage(text('first'));
			store.add(call.token.onCancellationRequested(() => cancelled.complete(call)));
		});
		const outcome = await rawCall(port, { headers: { 'grpc-timeout': '50m' }, body: framed(text('x')) });
		assert.strictEqual(statusOf(outcome), String(GrpcStatus.DEADLINE_EXCEEDED));
		const call = await cancelled.p;
		assert.strictEqual(call.isEnded, true);
		assert.strictEqual(call.timeoutMs, 50);

		const invalid = await rawCall(port, { headers: { 'grpc-timeout': 'soon' }, body: framed(text('x')) });
		assert.strictEqual(statusOf(invalid), String(GrpcStatus.INVALID_ARGUMENT));
	});

	test('RST_STREAM from the client cancels the call', async () => {
		const started = new DeferredPromise<IGrpcServerCall>();
		const cancelled = new DeferredPromise<void>();
		const { port } = await startServer(async call => {
			await call.readRequest();
			store.add(call.token.onCancellationRequested(() => cancelled.complete()));
			call.sendMessage(text('started'));
			started.complete(call);
		});
		const call = channelFor(port).call(PATH, {}, text('x'));
		const iterator = call.messages[Symbol.asyncIterator]();
		assert.strictEqual(fromBytes((await iterator.next()).value), 'started');
		const serverCall = await started.p;
		call.cancel();
		await cancelled.p;
		assert.strictEqual(serverCall.isEnded, true);
		assert.strictEqual(serverCall.sendMessage(text('late')), false);
		assert.strictEqual((await call.trailers).status, GrpcStatus.CANCELLED);
	});

	test('a handler that throws ends the call with INTERNAL', async () => {
		const { port } = await startServer(async call => {
			await call.readRequest();
			throw new Error('boom');
		});
		const trailers = await channelFor(port).call(PATH, {}, text('x')).trailers;
		assert.strictEqual(trailers.status, GrpcStatus.INTERNAL);
	});

	test('a header list over 8 KiB is reset with ENHANCE_YOUR_CALM', async () => {
		let called = false;
		const { port } = await startServer(() => { called = true; });
		const outcome = await rawCall(port, { headers: { 'x-large': 'a'.repeat(9000) }, body: framed(text('x')) });
		assert.strictEqual(outcome.rstCode, NGHTTP2_ENHANCE_YOUR_CALM);
		assert.strictEqual(called, false);
		const error = await collect(channelFor(port).call(PATH, { 'x-large': 'a'.repeat(9000) }, text('x'))).then(() => undefined, e => e);
		assert.ok(error instanceof GrpcCallError);
		assert.strictEqual(error.status, GrpcStatus.RESOURCE_EXHAUSTED);
	});

	test('the connection advertises the limits and no server push', async () => {
		const { port } = await startServer(echoHandler);
		const session = http2.connect(`http://127.0.0.1:${port}`);
		try {
			await new Promise<void>(resolve => session.once('remoteSettings', () => resolve()));
			const settings = session.remoteSettings;
			assert.strictEqual(settings.maxConcurrentStreams, 256);
			assert.strictEqual(settings.maxHeaderListSize, 8192);
			assert.strictEqual(settings.initialWindowSize, 1024 * 1024);
			assert.strictEqual(settings.enablePush, false);
		} finally {
			session.close();
		}
	});

	test('close() sends GOAWAY and lets the call in flight finish', async () => {
		const release = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		const { server, port } = await startServer(async call => {
			await call.readRequest();
			started.complete();
			await release.p;
			call.sendMessage(text('finished'));
			call.end(GrpcStatus.OK);
		}, { shutdownGraceMs: 5000 });
		const channel = channelFor(port);
		const call = channel.call(PATH, {}, text('x'));
		await started.p;
		const closed = server.close();
		await timeout(20);
		release.complete();
		assert.deepStrictEqual((await collect(call)).map(fromBytes), ['finished']);
		await closed;
		assert.strictEqual(server.port, undefined);
		const after = await channel.call(PATH, {}, text('x')).trailers;
		assert.strictEqual(after.status, GrpcStatus.UNAVAILABLE);
	});

	test('close() drops the connections whose calls outlive the grace period', async () => {
		const cancelled = new DeferredPromise<void>();
		const { server, port } = await startServer(async call => {
			await call.readRequest();
			call.sendMessage(text('open'));
			store.add(call.token.onCancellationRequested(() => cancelled.complete()));
		}, { shutdownGraceMs: 50 });
		const call = channelFor(port).call(PATH, {}, text('x'));
		const iterator = call.messages[Symbol.asyncIterator]();
		await iterator.next();
		await server.close();
		await cancelled.p;
		assert.notStrictEqual((await call.trailers).status, GrpcStatus.OK);
	});

	test('an idle connection is closed with GOAWAY', async () => {
		const { server, port } = await startServer(echoHandler, { idleTimeoutMs: 50 });
		const session = http2.connect(`http://127.0.0.1:${port}`);
		try {
			const goaway = new Promise<number>(resolve => session.once('goaway', code => resolve(code)));
			const stream = session.request({ ':method': 'POST', ':path': PATH, 'content-type': 'application/grpc', 'te': 'trailers' });
			stream.end(framed(text('x')));
			stream.resume();
			await new Promise<void>(resolve => stream.once('close', () => resolve()));
			assert.strictEqual(server.connectionCount, 1);
			assert.strictEqual(await goaway, NGHTTP2_NO_ERROR);
		} finally {
			session.close();
		}
		// A channel connects again for the next call.
		assert.strictEqual((await channelFor(port).call(PATH, {}, text('x')).trailers).status, GrpcStatus.OK);
	});

	test('listens on [::1] as well when the machine has IPv6', async function () {
		const { server, port } = await startServer(echoHandler);
		assert.strictEqual(server.addresses[0], `127.0.0.1:${port}`);
		if (!server.addresses.includes(`[::1]:${port}`)) {
			this.skip();
		}
		const channel = store.add(new GrpcChannel({ authority: `[::1]:${port}`, secure: false }));
		assert.strictEqual((await channel.call(PATH, {}, text('x')).trailers).status, GrpcStatus.OK);
	});

	test('a path can only have one handler, and a removed handler is UNIMPLEMENTED', async () => {
		const server = store.add(new GrpcServer());
		servers.push(server);
		const registration = server.addService(PATH, echoHandler);
		assert.throws(() => server.addService(PATH, echoHandler));
		const port = await server.listen();
		assert.strictEqual((await channelFor(port).call(PATH, {}, text('x')).trailers).status, GrpcStatus.OK);
		registration.dispose();
		assert.strictEqual((await channelFor(port).call(PATH, {}, text('x')).trailers).status, GrpcStatus.UNIMPLEMENTED);
	});
});
