/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type * as http2 from 'http2';
import type * as tls from 'tls';
import { encodeLengthPrefixedMessage, LengthPrefixedMessageReader } from '../../../../base/common/grpc/lpm.js';
import { GrpcStatus } from '../../../../base/common/grpc/status.js';
import { GrpcChannel, IGrpcChannelOptions, IGrpcTrailers } from '../../../../base/node/grpcChannel.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { generateSelfSignedCert, ISelfSignedCert } from '../../../tunnel/node/selfSignedCert.js';

/**
 * The TLS path of the channel itself: `secure: true` with its `tls` options
 * and no `createConnection`, so that `http2.connect('https://...')` makes the
 * connection. The server is a loopback HTTP/2 server with a self-signed
 * certificate for the IP address 127.0.0.1 (subject CN=TunnelProxy, no DNS
 * name). base/test cannot import the certificate generator from
 * platform/tunnel, so these tests live here.
 */

interface IServedRequest {
	readonly scheme: string | undefined;
	readonly alpn: string | undefined;
	readonly request: string;
}

interface IUnaryResult {
	readonly trailers: IGrpcTrailers;
	readonly messages: readonly string[];
}

suite('GrpcChannel over TLS', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let http2Module: typeof http2;
	let cert: ISelfSignedCert;
	let server: http2.Http2SecureServer;
	let authority: string;
	let sessions: http2.ServerHttp2Session[];
	let served: IServedRequest[];
	let servernames: string[];

	suiteSetup(async () => {
		// Loaded lazily, as the channel does.
		http2Module = await import('http2');
		cert = await generateSelfSignedCert();
	});

	setup(async () => {
		sessions = [];
		served = [];
		servernames = [];
		server = http2Module.createSecureServer({
			key: cert.key,
			cert: cert.cert,
			SNICallback: (servername: string, callback: (error: Error | null, context?: tls.SecureContext) => void) => {
				servernames.push(servername);
				callback(null, undefined); // the default context
			},
		});
		server.on('session', session => sessions.push(session));
		server.on('stream', (stream, headers) => {
			stream.on('error', () => { });
			const reader = new LengthPrefixedMessageReader(1024);
			const messages: Uint8Array[] = [];
			stream.on('data', (chunk: Buffer) => messages.push(...reader.feed(chunk)));
			stream.on('end', () => {
				const request = messages.length > 0 ? new TextDecoder().decode(messages[0]) : '';
				served.push({ scheme: headers[':scheme'], alpn: stream.session?.alpnProtocol, request });
				stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
				stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
				stream.end(encodeLengthPrefixedMessage(new TextEncoder().encode(`echo ${request}`)));
			});
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

	/** Makes one unary call on a new secure channel; a failed call has no messages and its status in the trailers. */
	async function unary(tlsOptions: IGrpcChannelOptions['tls'], request: string): Promise<IUnaryResult> {
		const channel = store.add(new GrpcChannel({ authority, secure: true, tls: tlsOptions }));
		const call = channel.call('/test.Service/Echo', {}, new TextEncoder().encode(request));
		const trailers = await call.trailers;
		const messages: string[] = [];
		if (trailers.status === GrpcStatus.OK) {
			for await (const message of call.messages) {
				messages.push(new TextDecoder().decode(message));
			}
		}
		return { trailers, messages };
	}

	test('tls.ca trusts the server: the call succeeds over ALPN h2 with :scheme https', async () => {
		const single = await unary({ ca: cert.cert }, 'one');
		const list = await unary({ ca: [cert.cert] }, 'two');

		assert.deepStrictEqual({
			statuses: [single.trailers.status, list.trailers.status],
			messages: [...single.messages, ...list.messages],
			served,
			servernames,
		}, {
			statuses: [GrpcStatus.OK, GrpcStatus.OK],
			messages: ['echo one', 'echo two'],
			served: [
				{ scheme: 'https', alpn: 'h2', request: 'one' },
				{ scheme: 'https', alpn: 'h2', request: 'two' },
			],
			// An IP address is not sent as the TLS server name.
			servernames: [],
		});
	});

	test('without tls.ca the untrusted certificate fails the call as UNAVAILABLE with the certificate error', async () => {
		const result = await unary(undefined, 'one');

		assert.deepStrictEqual({ status: result.trailers.status, messages: result.messages, served }, { status: GrpcStatus.UNAVAILABLE, messages: [], served: [] });
		assert.match(result.trailers.message ?? '', /self[- ]signed certificate/i);
	});

	test('tls.rejectUnauthorized: false accepts the untrusted certificate', async () => {
		const result = await unary({ rejectUnauthorized: false }, 'one');

		assert.deepStrictEqual({ status: result.trailers.status, messages: result.messages, served }, {
			status: GrpcStatus.OK,
			messages: ['echo one'],
			served: [{ scheme: 'https', alpn: 'h2', request: 'one' }],
		});
	});

	test('tls.servername is the SNI and the name the certificate is checked against', async () => {
		// The certificate has no DNS name, so Node checks a host name against its subject CN (TunnelProxy).
		const matching = await unary({ ca: cert.cert, servername: 'TunnelProxy' }, 'one');
		const other = await unary({ ca: cert.cert, servername: 'override.example' }, 'two');

		assert.deepStrictEqual({
			statuses: [matching.trailers.status, other.trailers.status],
			messages: [...matching.messages, ...other.messages],
			served: served.map(r => r.request),
			servernames,
		}, {
			statuses: [GrpcStatus.OK, GrpcStatus.UNAVAILABLE],
			messages: ['echo one'],
			served: ['one'],
			servernames: ['TunnelProxy', 'override.example'],
		});
		// The CA is trusted: only the name fails the second connection.
		assert.match(other.trailers.message ?? '', /override\.example/);
		assert.doesNotMatch(other.trailers.message ?? '', /self[- ]signed/i);
	});
});
