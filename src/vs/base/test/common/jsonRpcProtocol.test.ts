/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../common/cancellation.js';
import { CancellationError } from '../../common/errors.js';
import { IJsonRpcNotification, IJsonRpcProtocolHandlers, IJsonRpcRequest, JsonRpcError, JsonRpcMessage, JsonRpcProtocol } from '../../common/jsonRpcProtocol.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('JsonRpcProtocol', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const createProtocol = (handlers: IJsonRpcProtocolHandlers = {}) => {
		const sentMessages: JsonRpcMessage[] = [];
		const protocol = new JsonRpcProtocol(message => sentMessages.push(message), handlers);
		store.add(protocol);
		return { protocol, sentMessages };
	};

	test('sendNotification adds jsonrpc envelope', () => {
		const { protocol, sentMessages } = createProtocol();

		protocol.sendNotification({ method: 'notify', params: { value: 1 } });

		assert.deepStrictEqual(sentMessages, [{
			jsonrpc: '2.0',
			method: 'notify',
			params: { value: 1 }
		}]);
	});

	test('sendRequest resolves on success response', async () => {
		const { protocol, sentMessages } = createProtocol();

		const requestPromise = protocol.sendRequest<string>({ method: 'echo', params: { value: 'ok' } });
		const outgoingRequest = sentMessages[0] as IJsonRpcRequest;

		const replies = await protocol.handleMessage({
			jsonrpc: '2.0',
			id: outgoingRequest.id,
			result: 'done'
		});

		const result = await requestPromise;
		assert.strictEqual(result, 'done');
		assert.deepStrictEqual(replies, []);
	});

	test('sendRequest rejects on error response', async () => {
		const { protocol, sentMessages } = createProtocol();

		const requestPromise = protocol.sendRequest({ method: 'fail' });
		const outgoingRequest = sentMessages[0] as IJsonRpcRequest;

		await protocol.handleMessage({
			jsonrpc: '2.0',
			id: outgoingRequest.id,
			error: {
				code: 123,
				message: 'Failure',
				data: { source: 'test' }
			}
		});

		await assert.rejects(requestPromise, error => {
			assert.ok(error instanceof JsonRpcError);
			assert.strictEqual(error.code, 123);
			assert.strictEqual(error.message, 'Failure');
			assert.deepStrictEqual(error.data, { source: 'test' });
			return true;
		});
	});

	test('sendRequest honors cancellation token and invokes onCancel', async () => {
		const { protocol, sentMessages } = createProtocol();
		const cts = new CancellationTokenSource();
		let canceledId: string | number | undefined;

		const requestPromise = protocol.sendRequest(
			{ method: 'cancel-me' },
			cts.token,
			id => canceledId = id,
		);
		const outgoingRequest = sentMessages[0] as IJsonRpcRequest;

		cts.cancel();

		await assert.rejects(requestPromise, error => error instanceof CancellationError);
		assert.strictEqual(canceledId, outgoingRequest.id);

		cts.dispose(true);
	});

	test('cancelPendingRequest rejects active request', async () => {
		const { protocol, sentMessages } = createProtocol();

		const requestPromise = protocol.sendRequest({ method: 'pending' });
		const outgoingRequest = sentMessages[0] as IJsonRpcRequest;
		protocol.cancelPendingRequest(outgoingRequest.id);

		await assert.rejects(requestPromise, error => error instanceof CancellationError);
	});

	test('handleRequest responds with method not found without handler', async () => {
		const { protocol, sentMessages } = createProtocol();

		const replies = await protocol.handleMessage({
			jsonrpc: '2.0',
			id: 7,
			method: 'unknown'
		});

		const expected = [{
			jsonrpc: '2.0',
			id: 7,
			error: {
				code: -32601,
				message: 'Method not found: unknown'
			}
		}];
		assert.deepStrictEqual(sentMessages, expected);
		assert.deepStrictEqual(replies, expected);
	});

	test('handleRequest responds with result and passes cancellation token', async () => {
		let receivedToken: CancellationToken | undefined;
		let wasCanceledDuringHandler: boolean | undefined;
		const { protocol, sentMessages } = createProtocol({
			handleRequest: async (request, token) => {
				receivedToken = token;
				wasCanceledDuringHandler = token.isCancellationRequested;
				return `${request.method}:ok`;
			}
		});

		const replies = await protocol.handleMessage({
			jsonrpc: '2.0',
			id: 9,
			method: 'compute'
		});

		assert.ok(receivedToken);
		assert.strictEqual(wasCanceledDuringHandler, false);
		const expected = [{
			jsonrpc: '2.0',
			id: 9,
			result: 'compute:ok'
		}];
		assert.deepStrictEqual(sentMessages, expected);
		assert.deepStrictEqual(replies, expected);
	});

	test('handleRequest serializes JsonRpcError and returns it', async () => {
		const { protocol, sentMessages } = createProtocol({
			handleRequest: () => {
				throw new JsonRpcError(88, 'bad request', { detail: true });
			}
		});

		const replies = await protocol.handleMessage({
			jsonrpc: '2.0',
			id: 'a',
			method: 'boom'
		});

		const expected = [{
			jsonrpc: '2.0',
			id: 'a',
			error: {
				code: 88,
				message: 'bad request',
				data: { detail: true }
			}
		}];
		assert.deepStrictEqual(sentMessages, expected);
		assert.deepStrictEqual(replies, expected);
	});

	test('handleRequest maps unknown errors to internal error and returns it', async () => {
		const { protocol, sentMessages } = createProtocol({
			handleRequest: () => {
				throw new Error('unexpected');
			}
		});

		const replies = await protocol.handleMessage({
			jsonrpc: '2.0',
			id: 'b',
			method: 'explode'
		});

		const expected = [{
			jsonrpc: '2.0',
			id: 'b',
			error: {
				code: -32603,
				message: 'unexpected'
			}
		}];
		assert.deepStrictEqual(sentMessages, expected);
		assert.deepStrictEqual(replies, expected);
	});

	test('handleMessage processes batch sequentially', async () => {
		const sequence: string[] = [];
		const gate = new DeferredPromise<void>();
		const { protocol } = createProtocol({
			handleRequest: async () => {
				sequence.push('request:start');
				await gate.p;
				sequence.push('request:end');
				return true;
			},
			handleNotification: () => {
				sequence.push('notification');
			}
		});

		const request: IJsonRpcRequest = {
			jsonrpc: '2.0',
			id: 1,
			method: 'first'
		};
		const notification: IJsonRpcNotification = {
			jsonrpc: '2.0',
			method: 'second'
		};

		const handlingPromise = protocol.handleMessage([request, notification]);
		assert.deepStrictEqual(sequence, ['request:start']);

		gate.complete();
		const replies = await handlingPromise;

		assert.deepStrictEqual(sequence, ['request:start', 'request:end', 'notification']);
		assert.deepStrictEqual(replies, [{ jsonrpc: '2.0', id: 1, result: true }]);
	});

	test('sendRequestWithId exposes the outgoing id and resolves like sendRequest', async () => {
		const { protocol, sentMessages } = createProtocol();

		const { id, result } = protocol.sendRequestWithId<string>({ method: 'echo' });
		assert.strictEqual((sentMessages[0] as IJsonRpcRequest).id, id);
		assert.strictEqual(protocol.hasPendingRequest(id), true);

		await protocol.handleMessage({ jsonrpc: '2.0', id, result: 'done' });
		assert.strictEqual(await result, 'done');
		assert.strictEqual(protocol.hasPendingRequest(id), false);
	});

	test('failPendingRequest rejects the pending request and ignores a later response', async () => {
		const { protocol, sentMessages } = createProtocol();

		const { id, result } = protocol.sendRequestWithId({ method: 'slow' });
		const error = new Error('transport closed');
		assert.strictEqual(protocol.failPendingRequest(id, error), true);
		assert.strictEqual(protocol.failPendingRequest(id, error), false, 'already failed');
		await assert.rejects(result, (err: unknown) => err === error);

		const replies = await protocol.handleMessage({ jsonrpc: '2.0', id, result: 'late' });
		assert.deepStrictEqual(replies, []);
		assert.strictEqual(sentMessages.length, 1, 'no further messages sent');
	});

	test('cancelIncomingRequest cancels the handler token and suppresses the response', async () => {
		const gate = new DeferredPromise<void>();
		let observedCancellation = false;
		const { protocol, sentMessages } = createProtocol({
			handleRequest: async (_request, token) => {
				store.add(token.onCancellationRequested(() => { observedCancellation = true; gate.complete(); }));
				await gate.p;
				throw new CancellationError();
			},
		});

		const handling = protocol.handleMessage({ jsonrpc: '2.0', id: 'req-1', method: 'work' });
		assert.strictEqual(protocol.cancelIncomingRequest('req-1'), true);
		assert.strictEqual(protocol.cancelIncomingRequest('req-1'), true, 'still in flight until the handler returns');
		const replies = await handling;

		assert.strictEqual(observedCancellation, true);
		assert.deepStrictEqual(replies, [], 'a cancelled request gets no response');
		assert.deepStrictEqual(sentMessages, []);
		assert.strictEqual(protocol.cancelIncomingRequest('req-1'), false, 'finished requests are forgotten');
		assert.strictEqual(protocol.cancelIncomingRequest('unknown'), false);
	});

	test('incoming and outgoing requests with the same id are independent', async () => {
		const gate = new DeferredPromise<string>();
		const { protocol, sentMessages } = createProtocol({ handleRequest: () => gate.p });

		const { id, result } = protocol.sendRequestWithId<string>({ method: 'out' });
		const handling = protocol.handleMessage({ jsonrpc: '2.0', id, method: 'in' });

		assert.strictEqual(protocol.cancelIncomingRequest(id), true);
		assert.strictEqual(protocol.hasPendingRequest(id), true, 'the outgoing request is untouched');
		gate.complete('ignored');
		assert.deepStrictEqual(await handling, []);

		await protocol.handleMessage({ jsonrpc: '2.0', id, result: 'ok' });
		assert.strictEqual(await result, 'ok');
		assert.strictEqual(sentMessages.length, 1);
	});

	test('cancelAllRequests also cancels in-flight incoming requests', async () => {
		const gate = new DeferredPromise<void>();
		let cancelled = false;
		const { protocol } = createProtocol({
			handleRequest: async (_request, token) => {
				store.add(token.onCancellationRequested(() => { cancelled = true; gate.complete(); }));
				await gate.p;
				return 'late';
			},
		});

		const handling = protocol.handleMessage({ jsonrpc: '2.0', id: 9, method: 'work' });
		protocol.cancelAllRequests();
		assert.deepStrictEqual(await handling, []);
		assert.strictEqual(cancelled, true);
	});
});
