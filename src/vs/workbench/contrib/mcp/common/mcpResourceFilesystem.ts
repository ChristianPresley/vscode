/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sumBy } from '../../../../base/common/arrays.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { decodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken, CancellationTokenPool, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Lazy } from '../../../../base/common/lazy.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { autorun } from '../../../../base/common/observable.js';
import { newWriteableStream, ReadableStreamEvents } from '../../../../base/common/stream.js';
import { equalsIgnoreCase } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { createFileSystemProviderError, FileChangeType, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileReadStreamOptions, IFileService, IFileSystemProviderWithFileAtomicReadCapability, IFileSystemProviderWithFileReadStreamCapability, IFileSystemProviderWithFileReadWriteCapability, IFileWriteOptions, IStat, IWatchOptions } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWebContentExtractorService } from '../../../../platform/webContentExtractor/common/webContentExtractor.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { MCP } from '../../../../platform/mcp/common/modelContextProtocol.js';
import { RESOURCE_READ_CACHE_MS } from './mcpProtocolMeta.js';
import { McpServer } from './mcpServer.js';
import { McpServerRequestHandler } from './mcpServerRequestHandler.js';
import { IMcpService, McpCapability, McpResourceURI, MpcResponseError } from './mcpTypes.js';
import { canLoadMcpNetworkResourceDirectly } from './mcpTypesUtils.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';

interface IReadData {
	contents: (MCPLegacy.TextResourceContents | MCPLegacy.BlobResourceContents)[];
	resourceURI: URL;
	forSameURI: (MCPLegacy.TextResourceContents | MCPLegacy.BlobResourceContents)[];
	/** How long the read may be reused (see {@link readCacheDuration}). */
	cacheMs: number;
}

/**
 * How long a resource read is reused, counted from the request: the server's
 * `ttlMs` clamped to {@link RESOURCE_READ_CACHE_MS} (at least 3 s, so a stat
 * followed by a read costs one request; at most 60 s). Legacy results carry
 * no `ttlMs`; they and results with `ttlMs: 0` get the floor. A read answered
 * after an input round is not reused at all (see `McpResourceFilesystem`).
 */
export function readCacheDuration(ttlMs: unknown): number {
	const [floor, ceiling] = RESOURCE_READ_CACHE_MS;
	if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
		return floor;
	}
	return Math.min(Math.max(ttlMs, floor), ceiling);
}

interface IMomentaryRead {
	/**
	 * The readers' tokens; the request is cancelled when all of them are. It is
	 * disposed when the read settles, after which a reader of the cached result
	 * has nothing left to cancel and is not added.
	 */
	readonly pool: CancellationTokenPool;
	/** Whether the read is still pending. */
	pending: boolean;
	readonly promise: Promise<IReadData>;
	/** The expiry timer and the change listeners of the entry; disposed when the entry is dropped. */
	readonly store: DisposableStore;
}

/** The "Resource not found" error code of 2025-11-25 and older (server/resources.mdx, "Error Handling"). */
const LEGACY_RESOURCE_NOT_FOUND = -32002;

/** -32602 (2026-07-28) and -32002 (2025-11-25 and older) answer a read of a resource the server does not have. */
function isResourceNotFound(error: unknown): boolean {
	return error instanceof MpcResponseError && (error.code === MCP.INVALID_PARAMS || error.code === LEGACY_RESOURCE_NOT_FOUND);
}

export class McpResourceFilesystem extends Disposable implements IWorkbenchContribution,
	IFileSystemProviderWithFileReadWriteCapability,
	IFileSystemProviderWithFileAtomicReadCapability,
	IFileSystemProviderWithFileReadStreamCapability {
	/** Defer getting the MCP service since this is a BlockRestore and no need to make it unnecessarily. */
	private readonly _mcpServiceLazy = new Lazy(() => this._instantiationService.invokeFunction(a => a.get(IMcpService)));

	/**
	 * For many file operations we re-read the resources quickly (e.g. stat
	 * before reading the file) and would prefer to avoid spamming the MCP
	 * with multiple reads. This is a short-duration cache to solve that. An
	 * entry's lifetime starts with its request: a pending read is joined for
	 * at most the ceiling of {@link RESOURCE_READ_CACHE_MS} (so a read that
	 * never settles is not reused forever), and a completed one is reused for
	 * what is left of {@link readCacheDuration}. It is dropped at once when the
	 * server reports the resource updated or the resource list changed, and as
	 * soon as the server asks for input: such a read depends on the answers,
	 * which are not part of the cache key, so it is neither joined from then on
	 * nor reused (caching.mdx, "Cache Key").
	 */
	private readonly _momentaryCache = new ResourceMap<IMomentaryRead>();

	private get _mcpService() {
		return this._mcpServiceLazy.value;
	}

	public readonly onDidChangeCapabilities = Event.None;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	public readonly onDidChangeFile = this._onDidChangeFile.event;

	public readonly capabilities: FileSystemProviderCapabilities = FileSystemProviderCapabilities.None
		| FileSystemProviderCapabilities.Readonly
		| FileSystemProviderCapabilities.PathCaseSensitive
		| FileSystemProviderCapabilities.FileReadStream
		| FileSystemProviderCapabilities.FileAtomicRead
		| FileSystemProviderCapabilities.FileReadWrite;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IFileService private readonly _fileService: IFileService,
		@IWebContentExtractorService private readonly _webContentExtractorService: IWebContentExtractorService,
	) {
		super();
		this._register(this._fileService.registerProvider(McpResourceURI.scheme, this));
	}

	//#region Filesystem API

	public async readFile(resource: URI): Promise<Uint8Array> {
		return this._readFile(resource);
	}

	public readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		const stream = newWriteableStream<Uint8Array>(data => VSBuffer.concat(data.map(data => VSBuffer.wrap(data))).buffer);

		this._readFile(resource, token).then(
			data => {
				if (opts.position) {
					data = data.slice(opts.position);
				}

				if (opts.length) {
					data = data.slice(0, opts.length);
				}

				stream.end(data);
			},
			err => stream.error(err),
		);

		return stream;
	}

	public watch(uri: URI, _opts: IWatchOptions): IDisposable {
		const { resourceURI, server } = this._decodeURI(uri);
		const cap = server.capabilities.get();
		if (cap !== undefined && !(cap & McpCapability.ResourcesSubscribe)) {
			return Disposable.None;
		}

		server.start();

		const store = new DisposableStore();
		let watchedOnHandler: McpServerRequestHandler | undefined;
		const watchListener = store.add(new MutableDisposable());
		const callCts = store.add(new MutableDisposable<CancellationTokenSource>());
		store.add(autorun(reader => {
			const connection = server.connection.read(reader);
			if (!connection) {
				return;
			}

			const handler = connection.handler.read(reader);
			if (!handler || watchedOnHandler === handler) {
				return;
			}

			callCts.value?.dispose(true);
			callCts.value = new CancellationTokenSource();
			watchedOnHandler = handler;

			const subscription = new DisposableStore();
			subscription.add(handler.subscribeResource(resourceURI.toString()));
			subscription.add(handler.onDidUpdateResource(e => {
				if (equalsUrlPath(e.uri, resourceURI)) {
					this._evict(uri); // the re-read that follows must reach the server
					this._onDidChangeFile.fire([{ resource: uri, type: FileChangeType.UPDATED }]);
				}
			}));
			watchListener.value = subscription;
		}));

		return store;
	}

	public async stat(resource: URI): Promise<IStat> {
		const { forSameURI, contents } = await this._readURI(resource);
		if (!contents.length) {
			throw createFileSystemProviderError(`File not found`, FileSystemProviderErrorCode.FileNotFound);
		}

		return {
			ctime: 0,
			mtime: 0,
			size: sumBy(contents, c => contentToBuffer(c).byteLength),
			type: forSameURI.length ? FileType.File : FileType.Directory,
		};
	}

	public async readdir(resource: URI): Promise<[string, FileType][]> {
		const { forSameURI, contents, resourceURI } = await this._readURI(resource);
		if (forSameURI.length > 0) {
			throw createFileSystemProviderError(`File is not a directory`, FileSystemProviderErrorCode.FileNotADirectory);
		}
		const resourcePathParts = resourceURI.pathname.split('/');

		const output = new Map<string, FileType>();
		for (const content of contents) {
			const contentURI = URI.parse(content.uri);
			const contentPathParts = contentURI.path.split('/');

			// Skip contents that are not in the same directory
			if (contentPathParts.length <= resourcePathParts.length || !resourcePathParts.every((part, index) => equalsIgnoreCase(part, contentPathParts[index]))) {
				continue;
			}

			// nested resource in a directory, just emit a directory to output
			else if (contentPathParts.length > resourcePathParts.length + 1) {
				output.set(contentPathParts[resourcePathParts.length], FileType.Directory);
			}

			else {
				// resource in the same directory, emit the file
				const name = contentPathParts[contentPathParts.length - 1];
				output.set(name, contentToBuffer(content).byteLength > 0 ? FileType.File : FileType.Directory);
			}
		}

		return [...output];
	}

	public mkdir(resource: URI): Promise<void> {
		throw createFileSystemProviderError('write is not supported', FileSystemProviderErrorCode.NoPermissions);
	}
	public writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		throw createFileSystemProviderError('write is not supported', FileSystemProviderErrorCode.NoPermissions);
	}
	public delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		throw createFileSystemProviderError('delete is not supported', FileSystemProviderErrorCode.NoPermissions);
	}
	public rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		throw createFileSystemProviderError('rename is not supported', FileSystemProviderErrorCode.NoPermissions);
	}

	//#endregion

	private async _readFile(resource: URI, token?: CancellationToken): Promise<Uint8Array> {
		const { forSameURI, contents } = await this._readURI(resource, token);

		// MCP does not distinguish between files and directories, and says that
		// servers should just return multiple when 'reading' a directory.
		if (!forSameURI.length) {
			if (!contents.length) {
				throw createFileSystemProviderError(`File not found`, FileSystemProviderErrorCode.FileNotFound);
			} else {
				throw createFileSystemProviderError(`File is a directory`, FileSystemProviderErrorCode.FileIsADirectory);
			}
		}

		return contentToBuffer(forSameURI[0]);
	}

	private _decodeURI(uri: URI) {
		let definitionId: string;
		let resourceURL: URL;
		try {
			({ definitionId, resourceURL } = McpResourceURI.toServer(uri));
		} catch (e) {
			throw createFileSystemProviderError(String(e), FileSystemProviderErrorCode.FileNotFound);
		}

		if (resourceURL.pathname.endsWith('/')) {
			resourceURL.pathname = resourceURL.pathname.slice(0, -1);
		}

		const server = this._mcpService.servers.get().find(s => s.definition.id === definitionId);
		if (!server) {
			throw createFileSystemProviderError(`MCP server ${definitionId} not found`, FileSystemProviderErrorCode.FileNotFound);
		}

		const cap = server.capabilities.get();
		if (cap !== undefined && !(cap & McpCapability.Resources)) {
			throw createFileSystemProviderError(`MCP server ${definitionId} does not support resources`, FileSystemProviderErrorCode.FileNotFound);
		}

		return { definitionId, resourceURI: resourceURL, server };
	}

	private async _readURI(uri: URI, token?: CancellationToken) {
		const cached = this._momentaryCache.get(uri);
		if (cached) {
			if (cached.pending) {
				cached.pool.add(token || CancellationToken.None);
			}
			return cached.promise;
		}

		// The request (and the pool its readers cancel it through) lives until the read settles, even
		// when the entry is dropped earlier; the entry's store only holds what makes it reusable.
		const request = this._store.add(new DisposableStore());
		const pool = request.add(new CancellationTokenPool());
		pool.add(token || CancellationToken.None);
		const store = this._store.add(new DisposableStore());
		const requestedAt = Date.now();

		const expiry = store.add(new MutableDisposable());
		const expireAfter = (lifetimeMs: number) => {
			if (store.isDisposed) {
				return;
			}
			const remaining = lifetimeMs - (Date.now() - requestedAt);
			if (remaining <= 0) {
				this._evict(uri, store);
			} else {
				expiry.value = disposableTimeout(() => this._evict(uri, store), remaining);
			}
		};
		expireAfter(RESOURCE_READ_CACHE_MS[1]);

		let answeredAfterInput = false;
		const promise = this._readURIInner(uri, pool.token, (handler, resourceURI) => {
			if (store.isDisposed) {
				return;
			}
			store.add(handler.onDidUpdateResource(e => {
				if (equalsUrlPath(e.uri, resourceURI)) {
					this._evict(uri, store);
				}
			}));
			store.add(handler.onDidChangeResourceList(() => this._evict(uri, store)));
		}, () => {
			answeredAfterInput = true;
			this._evict(uri, store);
		});
		const entry: IMomentaryRead = { pool, pending: true, promise, store };
		this._momentaryCache.set(uri, entry);

		const settled = () => {
			entry.pending = false;
			this._store.delete(request);
		};
		promise.then(data => {
			settled();
			if (answeredAfterInput) {
				this._evict(uri, store);
			} else {
				expireAfter(data.cacheMs);
			}
		}, () => {
			// Every reader cancelled: that is no answer of the server, so a later reader asks again.
			const cancelled = pool.token.isCancellationRequested;
			settled();
			if (cancelled) {
				this._evict(uri, store);
			} else {
				expireAfter(RESOURCE_READ_CACHE_MS[0]);
			}
		});

		return promise;
	}

	/** Drops the cached read of `uri` (only the one owning `entryStore`, when given). */
	private _evict(uri: URI, entryStore?: DisposableStore): void {
		const current = this._momentaryCache.get(uri);
		if (current && (!entryStore || current.store === entryStore)) {
			this._momentaryCache.delete(uri);
			this._store.delete(current.store);
		}
	}

	/** @param onInputRequired Called when the server asks for input before it answers the read. */
	private async _readURIInner(uri: URI, token: CancellationToken | undefined, onHandler: (handler: McpServerRequestHandler, resourceURI: URL) => void, onInputRequired: () => void): Promise<IReadData> {
		const { resourceURI, server } = this._decodeURI(uri);
		const matchedServer = this._mcpService.servers.get().find(s => s.definition.id === server.definition.id);

		//check for http/https resources and use web content extractor service to fetch the contents.
		if (canLoadMcpNetworkResourceDirectly(resourceURI, matchedServer)) {
			const extractURI = URI.parse(resourceURI.toString());
			const result = (await this._webContentExtractorService.extract([extractURI], { followRedirects: false })).at(0);
			if (result?.status === 'ok') {
				return {
					contents: [{ uri: resourceURI.toString(), text: result.result }],
					resourceURI,
					forSameURI: [{ uri: resourceURI.toString(), text: result.result }],
					cacheMs: readCacheDuration(undefined),
				};
			}
		}

		let res: MCPLegacy.ReadResourceResult & { ttlMs?: unknown };
		try {
			res = await McpServer.callOn(server, r => {
				onHandler(r, resourceURI);
				return r.readResource({ uri: resourceURI.toString() }, token, undefined, onInputRequired);
			}, token);
		} catch (e) {
			if (isResourceNotFound(e)) {
				throw createFileSystemProviderError(e instanceof Error ? e.message : String(e), FileSystemProviderErrorCode.FileNotFound);
			}
			throw e;
		}
		return {
			contents: res.contents,
			resourceURI,
			forSameURI: res.contents.filter(c => equalsUrlPath(c.uri, resourceURI)),
			cacheMs: readCacheDuration(res.ttlMs),
		};
	}
}

function equalsUrlPath(a: string, b: URL): boolean {
	// MCP doesn't specify either way, but underlying systems may can be case-sensitive.
	// It's better to treat case-sensitive paths as case-insensitive than vise-versa.
	return equalsIgnoreCase(new URL(a).pathname, b.pathname);
}

function contentToBuffer(content: MCPLegacy.TextResourceContents | MCPLegacy.BlobResourceContents): Uint8Array {
	if ('text' in content) {
		return VSBuffer.fromString(content.text).buffer;
	} else if ('blob' in content) {
		return decodeBase64(content.blob).buffer;
	} else {
		throw createFileSystemProviderError('Unknown content type', FileSystemProviderErrorCode.Unknown);
	}
}
