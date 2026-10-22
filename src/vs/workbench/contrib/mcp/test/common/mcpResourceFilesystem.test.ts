/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Barrier, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { consumeStream } from '../../../../../base/common/stream.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IJsonRpcRequest } from '../../../../../base/common/jsonRpcProtocol.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileChangeType, FileSystemProviderErrorCode, FileType, IFileChange, IFileService, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILoggerService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IAllowedMcpServersService } from '../../../../../platform/mcp/common/mcpManagement.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { TestContextService, TestLoggerService, TestProductService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { RESOURCE_READ_CACHE_MS } from '../../common/mcpProtocolMeta.js';
import { IMcpRegistry } from '../../common/mcpRegistryTypes.js';
import { McpResourceFilesystem, readCacheDuration } from '../../common/mcpResourceFilesystem.js';
import { McpService } from '../../common/mcpService.js';
import { IMcpService } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { TestMcpMessageTransport, TestMcpRegistry } from './mcpRegistryTypes.js';


suite('Workbench - MCP - ResourceFilesystem', () => {

	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	let transport: TestMcpMessageTransport;
	let fs: McpResourceFilesystem;

	setup(() => {
		const storageService = ds.add(new TestStorageService());
		const services = new ServiceCollection(
			[IFileService, { registerProvider: () => { } }],
			[IStorageService, storageService],
			[ILoggerService, ds.add(new TestLoggerService())],
			[IWorkspaceContextService, new TestContextService()],
			[IWorkbenchEnvironmentService, {}],
			[ITelemetryService, NullTelemetryService],
			[IProductService, TestProductService],
			[IAllowedMcpServersService, { _serviceBrand: undefined, onDidChangeAllowedMcpServers: Event.None, isAllowed: () => true, isServerAllowedBeforeResolution: () => true, isServerAllowed: () => true }],
		);

		const parentInsta1 = ds.add(new TestInstantiationService(services));
		const registry = new TestMcpRegistry(parentInsta1);

		const parentInsta2 = ds.add(parentInsta1.createChild(new ServiceCollection([IMcpRegistry, registry])));
		const mcpService = ds.add(new McpService(parentInsta2, registry, new NullLogService(), new TestConfigurationService(), storageService));
		mcpService.updateCollectedServers();

		const instaService = ds.add(parentInsta2.createChild(new ServiceCollection(
			[IMcpRegistry, registry],
			[IMcpService, mcpService],
		)));

		fs = ds.add(instaService.createInstance(McpResourceFilesystem));

		transport = ds.add(new TestMcpMessageTransport());
		registry.makeTestTransport = () => transport;
	});

	test('reads a basic file', async () => {
		transport.setResponder('resources/read', msg => {
			const request = msg as { id: string | number; params: { uri: string } };
			assert.strictEqual(request.params.uri, 'custom://hello/world.txt');
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {
					contents: [{ uri: request.params.uri, text: 'Hello World' }],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		const response = await fs.readFile(URI.parse('mcp-resource://746573742D736572766572/custom/hello/world.txt'));
		assert.strictEqual(new TextDecoder().decode(response), 'Hello World');
	});

	test('stat returns file information', async () => {
		transport.setResponder('resources/read', msg => {
			const request = msg as { id: string | number; params: { uri: string } };
			assert.strictEqual(request.params.uri, 'custom://hello/world.txt');
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {
					contents: [{ uri: request.params.uri, text: 'Hello World' }],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		const fileStats = await fs.stat(URI.parse('mcp-resource://746573742D736572766572/custom/hello/world.txt'));
		assert.strictEqual(fileStats.type, FileType.File);
		assert.strictEqual(fileStats.size, 'Hello World'.length);
	});

	test('stat returns directory information', async () => {
		transport.setResponder('resources/read', msg => {
			const request = msg as { id: string | number; params: { uri: string } };
			assert.strictEqual(request.params.uri, 'custom://hello');
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {
					contents: [
						{ uri: 'custom://hello/file1.txt', text: 'File 1' },
						{ uri: 'custom://hello/file2.txt', text: 'File 2' },
					],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		const dirStats = await fs.stat(URI.parse('mcp-resource://746573742D736572766572/custom/hello/'));
		assert.strictEqual(dirStats.type, FileType.Directory);
		// Size should be sum of all file contents in the directory
		assert.strictEqual(dirStats.size, 'File 1'.length + 'File 2'.length);
	});

	test('stat throws FileNotFound for nonexistent resources', async () => {
		transport.setResponder('resources/read', msg => {
			const request = msg as { id: string | number };
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {
					contents: [],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		await assert.rejects(
			() => fs.stat(URI.parse('mcp-resource://746573742D736572766572/custom/nonexistent.txt')),
			(err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.FileNotFound
		);
	});

	test('readdir returns directory contents', async () => {
		transport.setResponder('resources/read', msg => {
			const request = msg as { id: string | number; params: { uri: string } };
			assert.strictEqual(request.params.uri, 'custom://hello/dir');
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {
					contents: [
						{ uri: 'custom://hello/dir/file1.txt', text: 'File 1' },
						{ uri: 'custom://hello/dir/file2.txt', text: 'File 2' },
						{ uri: 'custom://hello/dir/subdir/file3.txt', text: 'File 3' },
					],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		const dirEntries = await fs.readdir(URI.parse('mcp-resource://746573742D736572766572/custom/hello/dir/'));
		assert.deepStrictEqual(dirEntries, [
			['file1.txt', FileType.File],
			['file2.txt', FileType.File],
			['subdir', FileType.Directory],
		]);
	});

	test('readdir throws when reading a file as directory', async () => {
		transport.setResponder('resources/read', msg => {
			const request = msg as { id: string | number; params: { uri: string } };
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {
					contents: [{ uri: request.params.uri, text: 'This is a file' }],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		await assert.rejects(
			() => fs.readdir(URI.parse('mcp-resource://746573742D736572766572/custom/hello/file.txt')),
			(err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.FileNotADirectory
		);
	});

	test('watch file emits change events', async () => {
		// Set up the responder for resource reading
		transport.setResponder('resources/read', msg => {
			const request = msg as { id: string | number; params: { uri: string } };
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {
					contents: [{ uri: request.params.uri, text: 'File content' }],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		const didSubscribe = new Barrier();

		// Set up the responder for resource subscription
		transport.setResponder('resources/subscribe', msg => {
			const request = msg as { id: string | number };
			didSubscribe.open();
			return {
				id: request.id,
				jsonrpc: '2.0',
				result: {},
			};
		});

		const uri = URI.parse('mcp-resource://746573742D736572766572/custom/hello/file.txt');
		const fileChanges: IFileChange[] = [];

		// Create a listener for file change events
		const disposable = fs.onDidChangeFile(events => {
			fileChanges.push(...events);
		});

		// Start watching the file
		const watchDisposable = fs.watch(uri, { excludes: [], recursive: false });

		// Simulate a file update notification from the server
		await didSubscribe.wait();
		await timeout(10); // wait for listeners to attach

		transport.simulateReceiveMessage({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: {
				uri: 'custom://hello/file.txt',
			},
		});
		transport.simulateReceiveMessage({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: {
				uri: 'custom://hello/unrelated.txt',
			},
		});

		// Check that we received a file change event
		assert.strictEqual(fileChanges.length, 1);
		assert.strictEqual(fileChanges[0].type, FileChangeType.UPDATED);
		assert.strictEqual(fileChanges[0].resource.toString(), uri.toString());

		// Clean up
		disposable.dispose();
		watchDisposable.dispose();
	});

	suite('read cache', () => {
		const fileUri = URI.parse('mcp-resource://746573742D736572766572/custom/hello/file.txt');
		let version: number;

		setup(() => {
			version = 0;
			transport.setResponder('resources/read', msg => {
				const request = msg as { id: string | number; params: { uri: string } };
				return { id: request.id, jsonrpc: '2.0', result: { contents: [{ uri: request.params.uri, text: `v${++version}` }] } satisfies MCPLegacy.ReadResourceResult };
			});
		});

		const read = async () => new TextDecoder().decode(await fs.readFile(fileUri));
		const reads = () => transport.getSentRequests('resources/read').length;

		test('a stat followed by a read costs one request', async () => {
			await fs.stat(fileUri);
			assert.strictEqual(await read(), 'v1');
			assert.strictEqual(reads(), 1);
		});

		const readStream = (token: CancellationToken) => consumeStream(fs.readFileStream(fileUri, {}, token), chunks => new TextDecoder().decode(VSBuffer.concat(chunks.map(chunk => VSBuffer.wrap(chunk))).buffer));

		test('a reader of a settled read adds its token to nothing: the read can no longer be cancelled and its token pool is gone', async () => {
			assert.strictEqual(await read(), 'v1');
			const warnings: unknown[][] = [];
			const warn = console.warn;
			console.warn = (...args: unknown[]) => warnings.push(args);
			try {
				const cts = ds.add(new CancellationTokenSource());
				assert.strictEqual(await readStream(cts.token), 'v1', 'the cached read is reused');
				cts.cancel();
			} finally {
				console.warn = warn;
			}
			assert.deepStrictEqual(warnings.map(args => String(args[0]).split('\n')[0]), [], 'nothing is added to a disposed store');
			assert.strictEqual(reads(), 1);
		});

		test('a read is cancelled when every reader cancels, and a cancelled read is not reused', async () => {
			let answer: (() => void) | undefined;
			transport.setResponder('resources/read', msg => {
				const request = msg as { id: string | number; params: { uri: string } };
				answer = () => transport.simulateReceiveMessage({ id: request.id, jsonrpc: '2.0', result: { contents: [{ uri: request.params.uri, text: `v${++version}` }] } });
				return undefined;
			});
			// A transport-level cancellation, or `notifications/cancelled` (this test server speaks 2025-11-25).
			const cancellations = () => transport.getCancelledRequests().length + transport.getSentMessages().filter(m => (m as { method?: string }).method === 'notifications/cancelled').length;
			const first = ds.add(new CancellationTokenSource());
			const second = ds.add(new CancellationTokenSource());
			const reading = [readStream(first.token), readStream(second.token)];
			await waitForSentRead(1);
			first.cancel();
			await timeout(0);
			assert.strictEqual(cancellations(), 0, 'one reader still waits');
			second.cancel();
			for (const result of reading) {
				await assert.rejects(result);
			}
			assert.strictEqual(cancellations(), 1, 'the request is cancelled');

			const next = read();
			await waitForSentRead(2);
			answer!();
			assert.strictEqual(await next, 'v1', 'the next reader asks again instead of getting the cancellation');
		});

		async function waitForSentRead(count: number): Promise<void> {
			for (let i = 0; reads() < count; i++) {
				assert.ok(i < 100, `expected ${count} resources/read requests`);
				await timeout(1);
			}
		}

		test('notifications/resources/updated for the resource drops the cached read at once', async () => {
			assert.strictEqual(await read(), 'v1');
			transport.simulateReceiveMessage({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'custom://hello/other.txt' } });
			assert.strictEqual(await read(), 'v1', 'an update of another resource keeps it');
			transport.simulateReceiveMessage({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'custom://hello/file.txt' } });
			assert.strictEqual(await read(), 'v2');
			assert.strictEqual(reads(), 2);
		});

		test('notifications/resources/list_changed drops the cached reads at once', async () => {
			assert.strictEqual(await read(), 'v1');
			transport.simulateReceiveMessage({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
			assert.strictEqual(await read(), 'v2');
			assert.strictEqual(reads(), 2);
		});

		test('the cache lifetime is the server ttlMs clamped to 3-60 s; no ttlMs and ttlMs 0 get the floor', () => {
			assert.deepStrictEqual(
				[undefined, 'soon', Number.NaN, 0, 1000, 3000, 15_000, 60_000, 3_600_000, -5].map(readCacheDuration),
				[3000, 3000, 3000, 3000, 3000, 3000, 15_000, 60_000, 60_000, 3000],
			);
		});

		test('the lifetime starts with the request: a read that never settles is joined for at most the ceiling', () => runWithFakedTimers({ maxTaskCount: 10_000 }, async () => {
			const requested = ds.add(new Emitter<IJsonRpcRequest>());
			transport.setResponder('resources/read', req => {
				requested.fire(req);
				return undefined; // the server never answers on its own
			});
			const answer = (req: IJsonRpcRequest, text: string) => transport.simulateReceiveMessage({ jsonrpc: '2.0', id: req.id, result: { contents: [{ uri: 'custom://hello/file.txt', text }] } });

			const firstRequest = Event.toPromise(requested.event);
			const first = read();
			const firstSent = await firstRequest;
			await timeout(RESOURCE_READ_CACHE_MS[1] - 1000);
			const joined = read();
			await timeout(10);
			assert.strictEqual(reads(), 1, 'joined while within the ceiling');

			await timeout(2000);
			const freshRequest = Event.toPromise(requested.event);
			const fresh = read();
			const freshSent = await freshRequest;
			assert.strictEqual(reads(), 2, 'a new read after the ceiling');

			answer(firstSent, 'late1');
			answer(freshSent, 'late2');
			assert.deepStrictEqual(await Promise.all([first, joined, fresh]), ['late1', 'late1', 'late2']);
		}));

		test('a slow read is reused only for what is left of its lifetime once it completes', () => runWithFakedTimers({ maxTaskCount: 10_000 }, async () => {
			transport.setResponder('resources/read', req => {
				setTimeout(() => transport.simulateReceiveMessage({ jsonrpc: '2.0', id: req.id, result: { contents: [{ uri: 'custom://hello/file.txt', text: `v${++version}` }] } }), RESOURCE_READ_CACHE_MS[0] + 1000);
				return undefined;
			});
			assert.strictEqual(await read(), 'v1'); // took longer than the floor
			assert.strictEqual(await read(), 'v2', 'expired at once');
			assert.strictEqual(reads(), 2);
		}));
	});

	suite('reads answered after an input round', () => {
		const fileUri = URI.parse('mcp-resource://746573742D736572766572/custom/hello/file.txt');
		let retried: Emitter<IJsonRpcRequest>;

		setup(() => {
			retried = ds.add(new Emitter<IJsonRpcRequest>());
			// A 2026-07-28 server that asks for the roots before every read and holds the retry until the test answers it.
			transport = ds.add(new TestMcpMessageTransport({ era: 'modern' }));
			transport.setResponder('resources/read', req => {
				if ((req.params as { inputResponses?: unknown }).inputResponses === undefined) {
					return { jsonrpc: '2.0', id: req.id, result: { resultType: 'input_required', inputRequests: { r1: { method: 'roots/list' } } } };
				}
				retried.fire(req);
				return undefined;
			});
		});

		const answer = (req: IJsonRpcRequest, text: string) => transport.simulateReceiveMessage({ jsonrpc: '2.0', id: req.id, result: { resultType: 'complete', contents: [{ uri: 'custom://hello/file.txt', text }], ttlMs: 60_000, cacheScope: 'public' } });
		const read = async () => new TextDecoder().decode(await fs.readFile(fileUri));
		const fresh = () => transport.getSentRequests('resources/read').filter(r => (r.params as { inputResponses?: unknown }).inputResponses === undefined).length;

		test('are not reused, even with a ttlMs', async () => {
			const firstRetry = Event.toPromise(retried.event);
			const first = read();
			answer(await firstRetry, 'one');
			assert.strictEqual(await first, 'one');

			const secondRetry = Event.toPromise(retried.event);
			const second = read();
			answer(await secondRetry, 'two');
			assert.strictEqual(fresh(), 2, 'the second read reaches the server');
			assert.strictEqual(await second, 'two');
		});

		test('are not joined once the server asked for input', async () => {
			const firstRetry = Event.toPromise(retried.event);
			const first = read();
			const firstSent = await firstRetry; // the first read now depends on the answers

			const statRetry = Event.toPromise(retried.event);
			const stat = fs.stat(fileUri);
			const statSent = await statRetry;
			assert.strictEqual(fresh(), 2);
			answer(firstSent, 'one');
			answer(statSent, 'two');
			assert.strictEqual(await first, 'one');
			assert.strictEqual((await stat).size, 'two'.length);
		});
	});

	suite('resources/read errors', () => {
		const missingUri = URI.parse('mcp-resource://746573742D736572766572/custom/hello/missing.txt');

		for (const [code, era] of [[-32602, '2026-07-28'], [-32002, '2025-11-25 and older']] as const) {
			test(`${code} (${era}) maps to FileNotFound`, async () => {
				transport.setResponder('resources/read', msg => ({ id: (msg as { id: number }).id, jsonrpc: '2.0', error: { code, message: 'Resource not found' } }));
				await assert.rejects(() => fs.readFile(missingUri), (err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.FileNotFound);
				await assert.rejects(() => fs.stat(missingUri), (err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.FileNotFound);
			});
		}

		test('other errors are not reported as FileNotFound', async () => {
			transport.setResponder('resources/read', msg => ({ id: (msg as { id: number }).id, jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } }));
			await assert.rejects(() => fs.readFile(missingUri), (err: Error) => toFileSystemProviderErrorCode(err) !== FileSystemProviderErrorCode.FileNotFound);
		});
	});

	test('read blob resource', async () => {
		const blobBase64 = 'SGVsbG8gV29ybGQgYXMgQmxvYg=='; // "Hello World as Blob" in base64

		transport.setResponder('resources/read', msg => {
			const params = (msg as { id: string | number; params: { uri: string } });
			assert.strictEqual(params.params.uri, 'custom://hello/blob.bin');
			return {
				id: params.id,
				jsonrpc: '2.0',
				result: {
					contents: [{ uri: params.params.uri, blob: blobBase64 }],
				} satisfies MCPLegacy.ReadResourceResult
			};
		});

		const response = await fs.readFile(URI.parse('mcp-resource://746573742D736572766572/custom/hello/blob.bin'));
		assert.strictEqual(new TextDecoder().decode(response), 'Hello World as Blob');
	});

	test('throws error for write operations', async () => {
		const uri = URI.parse('mcp-resource://746573742D736572766572/custom/hello/file.txt');

		await assert.rejects(
			async () => fs.writeFile(uri, new Uint8Array(), { create: true, overwrite: true, atomic: false, unlock: false }),
			(err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.NoPermissions
		);

		await assert.rejects(
			async () => fs.delete(uri, { recursive: false, useTrash: false, atomic: false }),
			(err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.NoPermissions
		);

		await assert.rejects(
			async () => fs.mkdir(uri),
			(err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.NoPermissions
		);

		await assert.rejects(
			async () => fs.rename(uri, URI.parse('mcp-resource://746573742D736572766572/custom/hello/newfile.txt'), { overwrite: false }),
			(err: Error) => toFileSystemProviderErrorCode(err) === FileSystemProviderErrorCode.NoPermissions
		);
	});
});
