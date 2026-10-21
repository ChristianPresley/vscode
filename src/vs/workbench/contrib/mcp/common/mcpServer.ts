/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableProducer, disposableTimeout, raceCancellationError, Sequencer } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { normalizeDriveLetter } from '../../../../base/common/labels.js';
import { Disposable, DisposableStore, IDisposable, IReference, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { LRUCache } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { mapValues } from '../../../../base/common/objects.js';
import { autorun, autorunSelfDisposable, derived, derivedDisposable, disposableObservableValue, IDerivedReader, IObservable, IReader, ITransaction, observableFromEvent, ObservablePromise, observableSignalFromEvent, observableValue, transaction } from '../../../../base/common/observable.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { createURITransformer } from '../../../../base/common/uriTransformer.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICompiledJsonSchema, IJsonSchemaCompileError, isCompiledJsonSchema, PatternAnalysisBudget } from '../../../../base/common/jsonSchemaValidator/index.js';
import { localize } from '../../../../nls.js';
import { hasConfigurationVariable } from '../../../../platform/configuration/common/configurationVariables.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMcpServerIdentity } from '../../../../platform/mcp/common/allowedMcpServers.js';
import { IAllowedMcpServersService } from '../../../../platform/mcp/common/mcpManagement.js';
import { ILogger, ILoggerService } from '../../../../platform/log/common/log.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { McpProtocolEra } from '../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../platform/mcp/common/modelContextProtocol.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IOutputService } from '../../../services/output/common/output.js';
import { chatSessionResourceToId } from '../../chat/common/model/chatUri.js';
import { ToolProgress } from '../../chat/common/tools/languageModelToolsService.js';
import { mcpActivationEvent } from './mcpConfiguration.js';
import { McpDevModeServerAttache } from './mcpDevMode.js';
import { McpIcons, parseAndValidateMcpIcon, StoredMcpIcons } from './mcpIcons.js';
import { IMcpRegistry } from './mcpRegistryTypes.js';
import { IMcpSandboxService } from './mcpSandboxService.js';
import { checkServerToolSchemas, checkStructuredContent, describeCompileErrors, MAX_CACHED_LIST_TTL_MS, McpProtocolEvent, readsSchemasLeniently, TOOL_LIST_CHANGE_GRACE_MS } from './mcpProtocolMeta.js';
import { IMcpCacheHint, IMcpListResult, McpProtocolFailure, McpServerRequestHandler } from './mcpServerRequestHandler.js';
import { McpTaskManager } from './mcpTaskManager.js';
import { ElicitationKind, extensionMcpCollectionPrefix, IMcpElicitationService, IMcpIcons, IMcpNegotiationHints, IMcpPotentialSandboxBlock, IMcpPrompt, IMcpPromptMessage, IMcpResource, IMcpResourceTemplate, IMcpSamplingService, IMcpServer, IMcpServerConnection, IMcpServerStartOpts, IMcpTool, IMcpToolCallContext, McpCapability, McpCollectionDefinition, McpCollectionReference, McpConnectionFailedError, McpConnectionState, McpDefinitionReference, mcpPromptReplaceSpecialChars, McpResourceURI, McpServerCacheState, McpServerDefinition, McpServerLaunch, McpServerStaticToolAvailability, McpServerTransportType, McpToolName, McpToolVisibility, MpcResponseError, UserInteractionRequiredError } from './mcpTypes.js';
import { ContributionEnablementState, IEnablementModel } from '../../chat/common/enablement.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';
import { McpApps } from './modelContextProtocolApps.js';
import { UriTemplate } from '../../../../base/common/uriTemplate.js';

type ServerBootData = {
	supportsLogging: boolean;
	supportsPrompts: boolean;
	supportsResources: boolean;
	toolCount: number;
	serverName: string;
	serverVersion: string;
};
type ServerBootClassification = {
	owner: 'connor4312';
	comment: 'Details the capabilities of the MCP server';
	supportsLogging: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether the server supports logging' };
	supportsPrompts: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether the server supports prompts' };
	supportsResources: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether the server supports resource' };
	toolCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The number of tools the server advertises' };
	serverName: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The name of the MCP server' };
	serverVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The version of the MCP server' };
};

type ElicitationTelemetryData = {
	serverName: string;
	serverVersion: string;
};

type ElicitationTelemetryClassification = {
	owner: 'connor4312';
	comment: 'Triggered when elictation is requested';
	serverName: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The name of the MCP server' };
	serverVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The version of the MCP server' };
};

type ProtocolNegotiationData = {
	era: string;
	protocolVersion: string;
	transport: string;
	durationMs: number;
	probeTimedOut: boolean;
	usedHint: boolean;
};
type ProtocolNegotiationClassification = {
	owner: 'connor4312';
	comment: 'Reports which MCP protocol revision a server negotiated';
	era: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the server speaks the stateless (modern) or the initialize-based (legacy) protocol' };
	protocolVersion: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The negotiated MCP revision' };
	transport: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The transport kind (stdio, http, grpc)' };
	durationMs: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'How long the negotiation took' };
	probeTimedOut: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'Whether the server/discover probe timed out before the fallback' };
	usedHint: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether a cached or configured revision hint skipped the probe' };
};

type ProtocolRenegotiationData = {
	code: number;
	retried: boolean;
};
type ProtocolRenegotiationClassification = {
	owner: 'connor4312';
	comment: 'Reports a server rejecting the protocol revision mid-session';
	code: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'The JSON-RPC error code that triggered the renegotiation' };
	retried: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether a common revision was found and the request retried' };
};

type MrtrRoundData = {
	method: string;
	rounds: number;
	inputKinds: string;
};
type MrtrRoundClassification = {
	owner: 'connor4312';
	comment: 'Reports a request that needed input rounds (elicitation, sampling, roots) before completing';
	method: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The MCP method that needed input' };
	rounds: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'How many input rounds were answered' };
	inputKinds: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The input request methods answered, comma separated' };
};

type ListenReconnectData = {
	stream: string;
	reason: string;
	backoffMs: number;
};
type ListenReconnectClassification = {
	owner: 'connor4312';
	comment: 'Reports a subscriptions/listen stream reconnecting';
	stream: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Which listen stream reconnected (lists or resources)' };
	reason: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'Why the stream was reconnected' };
	backoffMs: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The backoff delay before reconnecting' };
};

export type McpServerInstallData = {
	serverName: string;
	source: 'gallery' | 'local';
	scope: string;
	success: boolean;
	error?: string;
	hasInputs: boolean;
};

export type McpServerInstallClassification = {
	owner: 'connor4312';
	comment: 'MCP server installation event tracking';
	serverName: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The name of the MCP server being installed' };
	source: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Installation source (gallery or local)' };
	scope: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Installation scope (user, workspace, etc.)' };
	success: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether installation succeeded' };
	error?: { classification: 'CallstackOrException'; purpose: 'FeatureInsight'; comment: 'Error message if installation failed' };
	hasInputs: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Whether the server requires input configuration' };
};

type ServerBootState = {
	state: string;
	time: number;
};
type ServerBootStateClassification = {
	owner: 'connor4312';
	comment: 'Details the capabilities of the MCP server';
	state: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The server outcome' };
	time: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Duration in milliseconds to reach that state' };
};

type StoredMcpPrompt = MCPLegacy.Prompt & { _icons: StoredMcpIcons };

interface IToolCacheEntry {
	readonly serverName: string | undefined;
	readonly serverInstructions: string | undefined;
	readonly serverIcons: StoredMcpIcons;

	readonly trustedAtNonce: string | undefined;

	readonly nonce: string | undefined;
	/** Cached tools so we can show what's available before it's started */
	readonly tools: readonly ValidatedMcpTool[];
	/** Cached prompts */
	readonly prompts: readonly StoredMcpPrompt[] | undefined;
	/** Cached capabilities */
	readonly capabilities: McpCapability | undefined;
	/** The protocol era and revision the server spoke last time; used as a negotiation hint. */
	readonly protocol: IStoredProtocol | undefined;
	/** When the cached lists were received and the server's caching hints for them (2026-07-28 servers). */
	readonly freshness: IStoredFreshness | undefined;
}

interface IStoredProtocol {
	readonly era: McpProtocolEra;
	readonly version: string;
	/**
	 * The `protocolVersion` pinned in the configuration when this revision was
	 * negotiated. The revision differs from the pin when the server rejected it.
	 */
	readonly pin?: string;
}

interface IStoredListFreshness {
	readonly receivedAt: number;
	readonly ttlMs: number;
	readonly cacheScope: 'public' | 'private';
}

interface IStoredFreshness {
	readonly tools?: IStoredListFreshness;
	readonly prompts?: IStoredListFreshness;
}

function toStoredFreshness(hint: IMcpCacheHint): IStoredListFreshness | undefined {
	return hint.ttlMs !== undefined && hint.cacheScope !== undefined ? { receivedAt: hint.receivedAt, ttlMs: hint.ttlMs, cacheScope: hint.cacheScope } : undefined;
}

/** A cached public list may be reused while the server's TTL (capped at a day) has not elapsed. */
function isFreshList(freshness: IStoredListFreshness | undefined, now = Date.now()): boolean {
	return !!freshness && freshness.cacheScope === 'public' && now - freshness.receivedAt < Math.min(freshness.ttlMs, MAX_CACHED_LIST_TTL_MS);
}

const emptyToolEntry: IToolCacheEntry = {
	serverName: undefined,
	serverIcons: [],
	serverInstructions: undefined,
	trustedAtNonce: undefined,
	nonce: undefined,
	tools: [],
	prompts: undefined,
	capabilities: undefined,
	protocol: undefined,
	freshness: undefined,
};

interface IServerCacheEntry {
	readonly servers: readonly McpServerDefinition.Serialized[];
}

const toolInvalidCharRe = /[^a-z0-9_-]/gi;

export class McpServerMetadataCache extends Disposable {
	private didChange = false;
	private readonly cache = new LRUCache<string, IToolCacheEntry>(128);
	private readonly extensionServers = new Map</* collection ID */string, IServerCacheEntry>();

	constructor(
		scope: StorageScope,
		@IStorageService storageService: IStorageService,
	) {
		super();

		type StoredType = {
			extensionServers: [string, IServerCacheEntry][];
			serverTools: [string, IToolCacheEntry][];
		};

		const storageKey = 'mcpToolCache';
		this._register(storageService.onWillSaveState(() => {
			if (this.didChange) {
				storageService.store(storageKey, {
					extensionServers: [...this.extensionServers],
					serverTools: this.cache.toJSON(),
				} satisfies StoredType, scope, StorageTarget.MACHINE);
				this.didChange = false;
			}
		}));

		try {
			const cached: StoredType | undefined = storageService.getObject(storageKey, scope);
			this.extensionServers = new Map(cached?.extensionServers ?? []);
			cached?.serverTools?.forEach(([k, v]) => this.cache.set(k, v));
		} catch {
			// ignored
		}
	}

	/** Resets the cache for primitives and extension servers */
	reset() {
		this.cache.clear();
		this.extensionServers.clear();
		this.didChange = true;
	}

	/** Gets cached primitives for a server (used before a server is running) */
	get(definitionId: string) {
		return this.cache.get(definitionId);
	}

	/** Sets cached primitives for a server */
	store(definitionId: string, entry: Partial<IToolCacheEntry>): void {
		const prev = this.get(definitionId) || emptyToolEntry;
		this.cache.set(definitionId, { ...prev, ...entry });
		this.didChange = true;
	}

	/** Gets cached servers for a collection (used for extensions, before the extension activates) */
	getServers(collectionId: string) {
		return this.extensionServers.get(collectionId);
	}

	/** Sets cached servers for a collection */
	storeServers(collectionId: string, entry: IServerCacheEntry | undefined): void {
		if (entry) {
			this.extensionServers.set(collectionId, entry);
		} else {
			this.extensionServers.delete(collectionId);
		}
		this.didChange = true;
	}
}

/**
 * Shared across all {@link McpServer}s. Each server `take`s the name it wants
 * to base its tool prefix on (announced `serverInfo.title`/`name` when known,
 * otherwise the mcp.json key) and gets back a stable, collision-resolved prefix
 * observable. When a server's preferred name changes (e.g. after the live
 * `serverInfo` arrives), it simply takes again and disposes the previous
 * reference; other servers that share the name keep the suffix they were
 * already assigned. See #299749.
 */
export class McpPrefixGenerator {
	private readonly _buckets = new Map<string, { usedIndexes: Set<number>; size: number }>();

	take(name: string): IReference<string> {
		const safeName = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, McpToolName.MaxPrefixLen - McpToolName.Prefix.length - 1);
		let bucket = this._buckets.get(safeName);
		if (!bucket) {
			bucket = { usedIndexes: new Set(), size: 0 };
			this._buckets.set(safeName, bucket);
		}

		let index = 1;
		while (bucket.usedIndexes.has(index)) {
			index++;
		}
		bucket.usedIndexes.add(index);
		bucket.size++;

		// Trim safeName for this output if a multi-digit suffix would push us past
		// MaxPrefixLen. The bucket is keyed on the un-trimmed safeName so collisions
		// are still detected consistently across indexes.
		const suffix = (index === 1 ? '' : String(index)) + '_';
		const maxNameLen = McpToolName.MaxPrefixLen - McpToolName.Prefix.length - suffix.length;
		const prefix = McpToolName.Prefix + safeName.slice(0, maxNameLen) + suffix;

		return {
			object: prefix,
			dispose: () => {
				bucket!.usedIndexes.delete(index);
				bucket!.size--;
				if (bucket!.size === 0) {
					this._buckets.delete(safeName);
				}
			},
		};
	}
}

type ValidatedMcpTool = MCPLegacy.Tool & {
	_icons: StoredMcpIcons;

	/**
	 * Tool name as published by the MCP server. This may
	 * be different than the one in {@link definition} due to name normalization
	 * in {@link McpServer._getValidatedTools}.
	 */
	serverToolName: string;

	/**
	 * Visibility of the tool, parsed from `_meta.ui.visibility`.
	 * Defaults to Model | App if not specified.
	 */
	visibility: McpToolVisibility;

	/**
	 * UI resource URI if this tool has an associated MCP App UI.
	 * Parsed from `_meta.ui.resourceUri`.
	 */
	uiResourceUri?: string;
};

interface StoredServerMetadata {
	readonly serverName: string | undefined;
	readonly serverInstructions: string | undefined;
	readonly serverIcons: StoredMcpIcons | undefined;
}

interface ServerMetadata {
	readonly serverName: string | undefined;
	readonly serverInstructions: string | undefined;
	readonly icons: IMcpIcons;
}

class CachedPrimitive<T, C> {
	/**
	 * @param _definitionId Server definition ID
	 * @param _cache Metadata cache instance
	 * @param _fromStaticDefinition Static definition that came with the server.
	 * This should ONLY have a value if it should be used instead of whatever
	 * is currently in the cache.
	 * @param _fromCache Pull the value from the cache entry.
	 * @param _toT Transform the value to the observable type.
	 * @param defaultValue Default value if no cache entry.
	 */
	constructor(
		private readonly _definitionId: string,
		private readonly _cache: McpServerMetadataCache,
		private readonly _fromStaticDefinition: IObservable<C | undefined> | undefined,
		private readonly _fromCache: (entry: IToolCacheEntry) => C,
		private readonly _toT: (values: C, reader: IDerivedReader<void>) => T,
		private readonly defaultValue: C,
	) { }

	public get fromCache(): { nonce: string | undefined; data: C } | undefined {
		const c = this._cache.get(this._definitionId);
		return c ? { data: this._fromCache(c), nonce: c.nonce } : undefined;
	}

	public hasStaticDefinition(reader: IReader | undefined) {
		return !!this._fromStaticDefinition?.read(reader);
	}

	public readonly fromServerPromise = observableValue<ObservablePromise<{
		readonly data: C;
		readonly nonce: string | undefined;
	}> | undefined>(this, undefined);

	private readonly fromServer = derived(reader => this.fromServerPromise.read(reader)?.promiseResult.read(reader)?.data);

	public readonly value: IObservable<T> = derived(reader => {
		const serverTools = this.fromServer.read(reader);
		const definitions = serverTools?.data ?? this._fromStaticDefinition?.read(reader) ?? this.fromCache?.data ?? this.defaultValue;
		return this._toT(definitions, reader);
	});
}

export class McpServer extends Disposable implements IMcpServer {
	/** Shared task manager that survives reconnections */
	private readonly _taskManager = this._register(new McpTaskManager());

	/**
	 * Helper function to call the function on the handler once it's online. The
	 * connection started if it is not already.
	 */
	public static async callOn<R>(server: IMcpServer, fn: (handler: McpServerRequestHandler, connection: IMcpServerConnection) => Promise<R>, token: CancellationToken = CancellationToken.None): Promise<R> {
		await server.start({ promptType: 'all-untrusted' }); // idempotent

		let ranOnce = false;
		let d: IDisposable;

		const callPromise = new Promise<R>((resolve, reject) => {

			d = autorun(reader => {
				if (ranOnce) {
					return;
				}

				const connection = server.connection.read(reader);
				if (!connection) {
					// No live connection: the server may be blocked by policy (its connection is torn
					// down while blocked) or stopped. Surface the terminal state instead of waiting forever.
					const state = server.connectionState.read(reader);
					if (state.state === McpConnectionState.Kind.Error) {
						reject(new McpConnectionFailedError(`MCP server could not be started: ${state.message}`));
					} else if (state.state === McpConnectionState.Kind.Stopped) {
						reject(new McpConnectionFailedError('MCP server has stopped'));
					}
					return;
				}

				const handler = connection.handler.read(reader);
				if (!handler) {
					const state = connection.state.read(reader);
					if (state.state === McpConnectionState.Kind.Error) {
						reject(new McpConnectionFailedError(`MCP server could not be started: ${state.message}`));
						return;
					} else if (state.state === McpConnectionState.Kind.Stopped) {
						reject(new McpConnectionFailedError('MCP server has stopped'));
						return;
					} else {
						// keep waiting for handler
						return;
					}
				}

				resolve(fn(handler, connection));
				ranOnce = true; // aggressive prevent multiple racey calls, don't dispose because autorun is sync
			});
		});

		return raceCancellationError(callPromise, token).finally(() => d.dispose());
	}

	public readonly collection: McpCollectionReference;
	private readonly _connectionSequencer = new Sequencer();
	private readonly _connection = this._register(disposableObservableValue<IMcpServerConnection | undefined>(this, undefined));
	private readonly _resolvedPolicyIdentity = observableValue<{ definition: McpServerDefinition; identity: IMcpServerIdentity } | undefined>(this, undefined);

	public readonly connection = this._connection;

	private readonly _policyEpoch: IObservable<void>;
	/** Retains policy enforcement for the last resolved launch while its definition is unchanged. */
	private readonly _policyBlock: IObservable<McpConnectionState.Error | undefined>;
	public readonly connectionState: IObservable<McpConnectionState> = derived(reader => this._policyBlock.read(reader) ?? this._connection.read(reader)?.state.read(reader) ?? { state: McpConnectionState.Kind.Stopped });


	private readonly _capabilities: CachedPrimitive<number | undefined, number | undefined>;
	public get capabilities() {
		return this._capabilities.value;
	}

	private readonly _tools: CachedPrimitive<readonly IMcpTool[], readonly ValidatedMcpTool[]>;
	/** Cached tools are suppressed while the server is blocked by policy so they cannot be listed, referenced, or executed. */
	private readonly _gatedTools: IObservable<readonly IMcpTool[]> = derived(reader => this._policyBlock.read(reader) ? [] : this._tools.value.read(reader));
	public get tools() {
		return this._gatedTools;
	}

	private readonly _prompts: CachedPrimitive<readonly IMcpPrompt[], readonly StoredMcpPrompt[]>;
	/** Cached prompts are suppressed while the server is blocked by policy. */
	private readonly _gatedPrompts: IObservable<readonly IMcpPrompt[]> = derived(reader => this._policyBlock.read(reader) ? [] : this._prompts.value.read(reader));
	public get prompts() {
		return this._gatedPrompts;
	}

	private readonly _serverMetadata: CachedPrimitive<ServerMetadata, StoredServerMetadata | undefined>;
	public get serverMetadata() {
		return this._serverMetadata.value;
	}

	public get trustedAtNonce() {
		return this._primitiveCache.get(this.definition.id)?.trustedAtNonce;
	}

	public set trustedAtNonce(nonce: string | undefined) {
		this._primitiveCache.store(this.definition.id, { trustedAtNonce: nonce });
	}

	private readonly _fullDefinitions: IObservable<{
		server: McpServerDefinition | undefined;
		collection: McpCollectionDefinition | undefined;
	}>;

	public readonly cacheState = derived(reader => {
		const currentNonce = () => this._fullDefinitions.read(reader)?.server?.cacheNonce;
		const stateWhenServingFromCache = () => {
			if (this._tools.hasStaticDefinition(reader)) {
				return McpServerCacheState.Cached;
			}

			if (!this._tools.fromCache) {
				return McpServerCacheState.Unknown;
			}

			return currentNonce() === this._tools.fromCache.nonce ? McpServerCacheState.Cached : McpServerCacheState.Outdated;
		};

		const fromServer = this._tools.fromServerPromise.read(reader);
		const connectionState = this.connectionState.read(reader);
		const isIdle = McpConnectionState.canBeStarted(connectionState.state) || !fromServer;
		if (isIdle) {
			return stateWhenServingFromCache();
		}

		const fromServerResult = fromServer?.promiseResult.read(reader);
		if (!fromServerResult) {
			return this._tools.fromCache ? McpServerCacheState.RefreshingFromCached : McpServerCacheState.RefreshingFromUnknown;
		}

		if (fromServerResult.error) {
			return stateWhenServingFromCache();
		}

		return fromServerResult.data?.nonce === currentNonce() ? McpServerCacheState.Live : McpServerCacheState.Outdated;
	});

	public get logger(): ILogger {
		return this._logger;
	}

	private readonly _loggerId: string;
	private readonly _logger: ILogger;
	private _lastModeDebugged = false;
	private _isQuietStart = false;
	private _isSandboxSuggestionDialogVisible = false;
	private _potentialSandboxBlocks: IMcpPotentialSandboxBlock[] = [];
	private _potentialSandboxBlockListener = this._register(new MutableDisposable<IDisposable>());
	/** Count of running tool calls, used to detect if sampling is during an LM call */
	public runningToolCalls = new Set<IMcpToolCallContext>();

	public readonly enablement: IObservable<ContributionEnablementState>;

	constructor(
		initialCollection: McpCollectionDefinition,
		public readonly definition: McpDefinitionReference,
		explicitRoots: URI[] | undefined,
		private readonly _requiresExtensionActivation: boolean | undefined,
		private readonly _primitiveCache: McpServerMetadataCache,
		prefixGenerator: McpPrefixGenerator,
		enablementModel: IEnablementModel,
		@IMcpRegistry private readonly _mcpRegistry: IMcpRegistry,
		@IAllowedMcpServersService private readonly _allowedMcpServersService: IAllowedMcpServersService,
		@IWorkspaceContextService workspacesService: IWorkspaceContextService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILoggerService private readonly _loggerService: ILoggerService,
		@IOutputService private readonly _outputService: IOutputService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IMcpSamplingService private readonly _samplingService: IMcpSamplingService,
		@IMcpElicitationService private readonly _elicitationService: IMcpElicitationService,
		@IMcpSandboxService private readonly _mcpSandboxService: IMcpSandboxService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();

		this.collection = initialCollection;
		this._fullDefinitions = this._mcpRegistry.getServerDefinition(this.collection, this.definition);
		this.enablement = derived(r => enablementModel.readEnabled(definition.id, r));

		this._policyEpoch = observableSignalFromEvent(this, this._allowedMcpServersService.onDidChangeAllowedMcpServers);
		this._policyBlock = derived<McpConnectionState.Error | undefined>(this, reader => {
			this._policyEpoch.read(reader);
			const connection = this._connection.read(reader);
			if (connection) {
				// Authoritative: the connection carries the fully resolved launch.
				return this._evaluatePolicy(this._identityFromLaunch(connection.launchDefinition));
			}
			const definition = this._fullDefinitions.read(reader).server;
			const resolved = this._resolvedPolicyIdentity.read(reader);
			if (resolved && definition && McpServerDefinition.equals(resolved.definition, definition)) {
				return this._evaluatePolicy(resolved.identity);
			}
			const launch = definition?.launch;
			if (!launch) {
				return undefined;
			}
			return this._evaluatePolicy(this._identityFromLaunch(launch), 'definition');
		});

		this._register(autorun(reader => {
			const resolved = this._resolvedPolicyIdentity.read(reader);
			const definition = this._fullDefinitions.read(reader).server;
			// A reverted definition must not revive an identity from before its last change.
			if (resolved && (!definition || !McpServerDefinition.equals(resolved.definition, definition))) {
				this._resolvedPolicyIdentity.set(undefined, undefined);
			}

			if (this._policyBlock.read(reader) && this._connection.read(undefined)) {
				this._connection.set(undefined, undefined); // disposes and stops the connection
			}
		}));

		this._loggerId = `mcpServer.${definition.id}`;
		this._logger = this._register(_loggerService.createLogger(this._loggerId, { hidden: true, name: `MCP: ${definition.label}` }));

		const that = this;
		this._register(this._instantiationService.createInstance(McpDevModeServerAttache, this, { get lastModeDebugged() { return that._lastModeDebugged; } }));

		// If the logger is disposed but not deregistered, then the disposed instance
		// is reused and no-ops. todo@sandy081 this seems like a bug.
		this._register(toDisposable(() => _loggerService.deregisterLogger(this._loggerId)));

		// 1. Reflect workspaces into the MCP roots
		const workspaces = explicitRoots
			? observableValue(this, explicitRoots.map(uri => ({ uri, name: basename(uri) })))
			: observableFromEvent(
				this,
				workspacesService.onDidChangeWorkspaceFolders,
				() => workspacesService.getWorkspace().folders,
			);

		const uriTransformer = environmentService.remoteAuthority ? createURITransformer(environmentService.remoteAuthority) : undefined;

		this._register(autorun(reader => {
			const cnx = this._connection.read(reader)?.handler.read(reader);
			if (!cnx) {
				return;
			}

			cnx.roots = workspaces.read(reader)
				.filter(w => w.uri.authority === (initialCollection.remoteAuthority || ''))
				.map(w => {
					let uri = URI.from(uriTransformer?.transformIncoming(w.uri) ?? w.uri);
					if (uri.scheme === Schemas.file) { // #271812
						uri = URI.file(normalizeDriveLetter(uri.fsPath, true));
					}

					return { name: w.name, uri: uri.toString() };
				});
		}));

		// 2. Populate this.tools when we connect to a server.
		this._register(autorun(reader => {
			const cnx = this._connection.read(reader);
			const handler = cnx?.handler.read(reader);
			if (handler) {
				this._populateLiveData(handler, cnx?.definition.cacheNonce, cnx?.definition.protocolVersionHint, reader.store);
			} else if (this._tools) {
				this.resetLiveData();
			}
		}));

		this._register(autorun(reader => {
			const cnx = this._connection.read(reader);
			this._potentialSandboxBlockListener.value = cnx?.onPotentialSandboxBlock(block => this.recordPotentialSandboxBlock(block));
		}));

		const staticMetadata = derived(reader => {
			const def = this._fullDefinitions.read(reader).server;
			return def && def.cacheNonce !== this._tools.fromCache?.nonce ? def.staticMetadata : undefined;
		});

		this._serverMetadata = new CachedPrimitive<ServerMetadata, StoredServerMetadata | undefined>(
			this.definition.id,
			this._primitiveCache,
			staticMetadata.map(m => m ? this._toStoredMetadata(m?.serverInfo, m?.instructions) : undefined),
			(entry) => ({ serverName: entry.serverName, serverInstructions: entry.serverInstructions, serverIcons: entry.serverIcons }),
			(entry) => ({ serverName: entry?.serverName, serverInstructions: entry?.serverInstructions, icons: McpIcons.fromStored(entry?.serverIcons) }),
			undefined,
		);

		// Form the tool prefix from the server-announced name when known so that
		// registry-style mcp.json keys like `io.github.upstash/context7` don't end
		// up in `mcp_io_github_ups_*` truncated names. See #299749.
		const preferredName = derived(reader => this._serverMetadata.value.read(reader)?.serverName || this.definition.label);
		const prefixRef = derivedDisposable(reader => prefixGenerator.take(preferredName.read(reader)));
		const toolPrefix = prefixRef.map(ref => ref.object);

		// 3. Publish tools
		this._tools = new CachedPrimitive<readonly IMcpTool[], readonly ValidatedMcpTool[]>(
			this.definition.id,
			this._primitiveCache,
			staticMetadata
				.map(m => {
					const tools = m?.tools?.filter(t => t.availability === McpServerStaticToolAvailability.Initial).map(t => t.definition);
					// The revision is not known before the server starts: read the static schemas leniently (the live list replaces them).
					return tools?.length ? new ObservablePromise(this._getValidatedTools(tools, MCPLegacy.LATEST_PROTOCOL_VERSION)) : undefined;
				})
				.map((o, reader) => o?.promiseResult.read(reader)?.data),
			(entry) => entry.tools,
			(entry, reader) => entry.map(def => this._instantiationService.createInstance(McpTool, this, toolPrefix.read(reader), def, entry)).sort((a, b) => a.compare(b)),
			[],
		);

		// 4. Publish prompts
		this._prompts = new CachedPrimitive<readonly IMcpPrompt[], readonly StoredMcpPrompt[]>(
			this.definition.id,
			this._primitiveCache,
			undefined,
			(entry) => entry.prompts || [],
			(entry) => entry.map(e => new McpPrompt(this, e)),
			[],
		);

		this._capabilities = new CachedPrimitive<number | undefined, number | undefined>(
			this.definition.id,
			this._primitiveCache,
			staticMetadata.map(m => m?.capabilities !== undefined ? encodeCapabilities(m.capabilities) : undefined),
			(entry) => entry.capabilities,
			(entry) => entry,
			undefined,
		);

		// Hold the prefix for the lifetime of the server so its tool name stays
		// stable even when no one is currently observing the tools list.
		prefixRef.recomputeInitiallyAndOnChange(this._store);
	}

	public readDefinitions(): IObservable<{ server: McpServerDefinition | undefined; collection: McpCollectionDefinition | undefined }> {
		return this._fullDefinitions;
	}

	public showOutput(preserveFocus?: boolean) {
		this._loggerService.setVisibility(this._loggerId, true);
		return this._outputService.showChannel(this._loggerId, preserveFocus);
	}

	public resources(token?: CancellationToken): AsyncIterable<IMcpResource[]> {
		const cts = new CancellationTokenSource(token);
		return new AsyncIterableProducer<IMcpResource[]>(async emitter => {
			await McpServer.callOn(this, async (handler) => {
				for await (const resource of handler.listResourcesIterable({}, cts.token)) {
					emitter.emitOne(resource.map(r => new McpResource(this, r, McpIcons.fromParsed(this._parseIcons(r)))));
					if (cts.token.isCancellationRequested) {
						return;
					}
				}
			});
		}, () => cts.dispose(true));
	}

	public resourceTemplates(token?: CancellationToken): Promise<IMcpResourceTemplate[]> {
		return McpServer.callOn(this, async (handler) => {
			const templates = await handler.listResourceTemplates({}, token);
			return templates.map(t => new McpResourceTemplate(this, t, McpIcons.fromParsed(this._parseIcons(t))));
		}, token);
	}

	/** The transport name reported in protocol events. */
	private static _transportName(type: McpServerTransportType | undefined): 'stdio' | 'http' | 'grpc' {
		switch (type) {
			case McpServerTransportType.HTTP:
				return 'http';
			case McpServerTransportType.Grpc:
				return 'grpc';
			default:
				return 'stdio';
		}
	}

	private _identityFromLaunch(launch: McpServerLaunch | undefined): IMcpServerIdentity {
		if (launch?.type === McpServerTransportType.HTTP || launch?.type === McpServerTransportType.Grpc) {
			return { name: this.definition.label, url: launch.uri.toString(true) };
		}
		if (launch?.type === McpServerTransportType.Stdio) {
			// `launch.command`/`launch.args` are typed as non-nullable but can be `undefined` at
			// runtime when they originate from user/discovery configuration that omitted the field.
			// When `command` is present, build the full command line (defaulting `args` to an empty
			// array and dropping any non-string entries); the produced `IMcpServerIdentity.command`
			// then never contains a non-string entry, which would otherwise break policy matching and
			// the unresolved-variable check. Use a string check so a valid-but-empty command string is
			// preserved while malformed non-string command values are dropped. When `command` is absent
			// the full command line is unknown, so omit the field entirely rather than matching on args
			// alone (which could collide with unrelated servers).
			return typeof launch.command === 'string'
				? { name: this.definition.label, command: [launch.command, ...(launch.args ?? []).filter(arg => typeof arg === 'string')] }
				: { name: this.definition.label };
		}
		return { name: this.definition.label };
	}

	private _evaluatePolicy(identity: IMcpServerIdentity, phase: 'definition' | 'resolved' = 'resolved'): McpConnectionState.Error | undefined {
		const allowed = phase === 'definition'
			? this._allowedMcpServersService.isServerAllowedBeforeResolution(identity)
			: this._allowedMcpServersService.isServerAllowed(identity);
		return allowed === true ? undefined : { state: McpConnectionState.Kind.Error, message: allowed.value };
	}

	/** Whether policy URL/command fields contain unresolved configuration variables; the server name is literal. */
	private static _hasUnresolvedVariables(identity: IMcpServerIdentity): boolean {
		return (identity.url !== undefined && hasConfigurationVariable(identity.url))
			|| (identity.command?.some(hasConfigurationVariable) ?? false);
	}

	public start({ interaction, autoTrustChanges, promptType, debug, errorOnUserInteraction }: IMcpServerStartOpts = {}): Promise<McpConnectionState> {
		interaction?.participants.set(this.definition.id, { s: 'unknown' });

		return this._connectionSequencer.queue<McpConnectionState>(async () => {
			const preStartBlock = this._policyBlock.get();
			if (preStartBlock) {
				const definition = this._fullDefinitions.get().server;
				const identity = definition && this._identityFromLaunch(definition.launch);
				const canResolveAgain = !errorOnUserInteraction && this._resolvedPolicyIdentity.get()
					&& identity && McpServer._hasUnresolvedVariables(identity) && !this._evaluatePolicy(identity, 'definition');
				// Keep cached metadata blocked while an interactive retry resolves the current inputs.
				if (!canResolveAgain) {
					return preStartBlock;
				}
			}

			const activationEvent = mcpActivationEvent(this.collection.id.slice(extensionMcpCollectionPrefix.length));
			if (this._requiresExtensionActivation && !this._extensionService.activationEventIsDone(activationEvent)) {
				await this._extensionService.activateByEvent(activationEvent);
				await Promise.all(this._mcpRegistry.delegates.get()
					.map(r => r.waitForInitialProviderPromises()));
				// This can happen if the server was created from a cached MCP server seen
				// from an extension, but then it wasn't registered when the extension activated.
				if (this._store.isDisposed) {
					return { state: McpConnectionState.Kind.Stopped };
				}
			}

			let connection = this._connection.get();
			this._isQuietStart = !!errorOnUserInteraction;
			if (connection && McpConnectionState.canBeStarted(connection.state.get().state)) {
				connection.dispose();
				connection = undefined;
				this._connection.set(connection, undefined);
			}

			if (!connection) {
				this._lastModeDebugged = !!debug;
				const that = this;
				connection = await this._mcpRegistry.resolveConnection({
					interaction,
					autoTrustChanges,
					promptType,
					trustNonceBearer: {
						get trustedAtNonce() { return that.trustedAtNonce; },
						set trustedAtNonce(nonce: string | undefined) { that.trustedAtNonce = nonce; }
					},
					logger: this._logger,
					collectionRef: this.collection,
					definitionRef: this.definition,
					debug,
					errorOnUserInteraction,
					taskManager: this._taskManager,
				});
				if (!connection) {
					return { state: McpConnectionState.Kind.Stopped };
				}

				if (this._store.isDisposed) {
					connection.dispose();
					return { state: McpConnectionState.Kind.Stopped };
				}

				const resolvedPolicyIdentity = { definition: connection.definition, identity: this._identityFromLaunch(connection.launchDefinition) };
				transaction(tx => {
					this._resolvedPolicyIdentity.set(resolvedPolicyIdentity, tx);
					this._connection.set(connection, tx);
				});

				if (connection.definition.devMode) {
					this.showOutput();
				}
			}

			// Check the local resolved connection: reactive policy enforcement may already have cleared `_connection`.
			const resolvedBlock = this._evaluatePolicy(this._identityFromLaunch(connection.launchDefinition));
			if (resolvedBlock) {
				this._connection.set(undefined, undefined); // dispose the just-resolved connection
				return resolvedBlock;
			}

			this._potentialSandboxBlocks.length = 0;

			const start = Date.now();
			let state = await connection.start({
				createMessageRequestHandler: (params, token) => this._samplingService.sample({
					isDuringToolCall: this.runningToolCalls.size > 0,
					server: this,
					params,
				}, token).then(r => r.sample),
				elicitationRequestHandler: async (req, token, context, options) => {
					const serverInfo = connection.handler.get()?.serverInfo;
					if (serverInfo) {
						this._telemetryService.publicLog2<ElicitationTelemetryData, ElicitationTelemetryClassification>('mcp.elicitationRequested', {
							serverName: serverInfo.name,
							serverVersion: serverInfo.version,
						});
					}

					const r = await this._elicitationService.elicit(this, context ?? Iterable.first(this.runningToolCalls), req, token || CancellationToken.None, options);
					r.dispose();
					return r.value;
				}
			}, this._negotiationHints(connection));

			const policyBlock = this._policyBlock.get();
			if (policyBlock) {
				return policyBlock;
			}

			this._telemetryService.publicLog2<ServerBootState, ServerBootStateClassification>('mcp/serverBootState', {
				state: McpConnectionState.toKindString(state.state),
				time: Date.now() - start,
			});

			// MCP servers that need auth can 'start' but will stop with an interaction-needed
			// error they first make a request. In this case, wait until the handler fully
			// initializes before resolving (throwing if it ends up needing auth)
			if (errorOnUserInteraction && state.state === McpConnectionState.Kind.Running) {
				let disposable: IDisposable;
				state = await new Promise<McpConnectionState>((resolve, reject) => {
					disposable = autorun(reader => {
						const handler = connection.handler.read(reader);
						if (handler) {
							resolve(state);
						}

						const s = connection.state.read(reader);
						if (s.state === McpConnectionState.Kind.Stopped && s.reason === 'needs-user-interaction') {
							reject(new UserInteractionRequiredError('auth'));
						}

						if (!McpConnectionState.isRunning(s)) {
							resolve(s);
						}
					});
				}).finally(() => disposable.dispose());
			}

			if (state.state === McpConnectionState.Kind.Error) {
				let disposable: IDisposable;
				state = await new Promise<McpConnectionState>((resolve, reject) => {
					disposable = autorun(reader => {
						const cnx = this._connection.read(reader);
						const state = cnx?.state.read(reader);
						if (cnx && state?.state === McpConnectionState.Kind.Error) {
							if (!this._isQuietStart) {
								this.showInteractiveError(cnx, state, this._lastModeDebugged);
							} else {
								reject(new UserInteractionRequiredError('start'));
							}
						}
					});
				}).finally(() => disposable.dispose());
			}

			return state;
		}).finally(() => {
			interaction?.participants.set(this.definition.id, { s: 'resolved' });
		});
	}

	private showInteractiveError(cnx: IMcpServerConnection, error: McpConnectionState.Error, debug?: boolean) {
		if (cnx.definition.sandboxEnabled) {
			if (!this.showSandboxConfigSuggestionFromPotentialBlocks(cnx, this._potentialSandboxBlocks)) {
				this._notificationService.warn(localize('mcpServerError', 'The MCP server {0} could not be started: {1}', cnx.definition.label, error.message));
			}
			return;
		}
		if (error.code === 'ENOENT' && cnx.launchDefinition.type === McpServerTransportType.Stdio) {
			let docsLink: string | undefined;
			switch (cnx.launchDefinition.command) {
				case 'uvx':
					docsLink = `https://aka.ms/vscode-mcp-install/uvx`;
					break;
				case 'npx':
					docsLink = `https://aka.ms/vscode-mcp-install/npx`;
					break;
				case 'dnx':
					docsLink = `https://aka.ms/vscode-mcp-install/dnx`;
					break;
				case 'dotnet':
					docsLink = `https://aka.ms/vscode-mcp-install/dotnet`;
					break;
			}

			const options: IPromptChoice[] = [{
				label: localize('mcp.command.showOutput', "Show Output"),
				run: () => this.showOutput(),
			}];

			if (cnx.definition.devMode?.debug?.type === 'debugpy' && debug) {
				this._notificationService.prompt(Severity.Error, localize('mcpDebugPyHelp', 'The command "{0}" was not found. You can specify the path to debugpy in the `dev.debug.debugpyPath` option.', cnx.launchDefinition.command, cnx.definition.label), [...options, {
					label: localize('mcpViewDocs', 'View Docs'),
					run: () => this._openerService.open(URI.parse('https://aka.ms/vscode-mcp-install/debugpy')),
				}]);
				return;
			}

			if (docsLink) {
				options.push({
					label: localize('mcpServerInstall', 'Install {0}', cnx.launchDefinition.command),
					run: () => this._openerService.open(URI.parse(docsLink)),
				});
			}

			this._notificationService.prompt(Severity.Error, localize('mcpServerNotFound', 'The command "{0}" needed to run {1} was not found.', cnx.launchDefinition.command, cnx.definition.label), options);
		} else {
			this._notificationService.warn(localize('mcpServerError', 'The MCP server {0} could not be started: {1}', cnx.definition.label, error.message));
		}
	}

	/**
	 * Tells the user about a request that failed with -32020, -32021 or -32022
	 * after the automatic recovery, in words and with the output channel one
	 * click away (the details, including the server's error, are logged there).
	 */
	private _notifyProtocolFailure(failure: McpProtocolFailure): void {
		this._notificationService.prompt(Severity.Error, McpServer._describeProtocolFailure(this.definition.label, failure), [{
			label: localize('mcp.command.showOutput', "Show Output"),
			run: () => this.showOutput(),
		}]);
	}

	private static _describeProtocolFailure(label: string, failure: McpProtocolFailure): string {
		switch (failure.kind) {
			case 'header-mismatch':
				switch (failure.refresh) {
					case 'refreshed':
						return localize('mcp.protocolFailure.headerMismatchRefreshed', "The MCP server {0} rejected a {1} request because its headers do not match the request, even after the tool list was refreshed.", label, failure.method);
					case 'failed':
						return localize('mcp.protocolFailure.headerMismatchRefreshFailed', "The MCP server {0} rejected a {1} request because its headers do not match the request, and the tool list could not be refreshed to retry it.", label, failure.method);
					case 'none':
						return localize('mcp.protocolFailure.headerMismatch', "The MCP server {0} rejected a {1} request because its headers do not match the request.", label, failure.method);
				}
			case 'missing-capability':
				return failure.capabilities.length
					? localize('mcp.protocolFailure.missingCapability', "The MCP server {0} requires client capabilities that VS Code does not provide for a {1} request: {2}.", label, failure.method, failure.capabilities.join(', '))
					: localize('mcp.protocolFailure.missingCapabilityUnnamed', "The MCP server {0} requires a client capability that VS Code does not provide for a {1} request.", label, failure.method);
			case 'unsupported-version':
				return failure.supported.length
					? localize('mcp.protocolFailure.unsupportedVersion', "The MCP server {0} rejected the MCP revision {1}. It supports {2}, and VS Code could not switch to a revision both speak.", label, failure.requested, failure.supported.join(', '))
					: localize('mcp.protocolFailure.unsupportedVersionUnnamed', "The MCP server {0} rejected the MCP revision {1} without naming one it supports.", label, failure.requested);
		}
	}

	public showSandboxConfigSuggestionFromPotentialBlocks(cnx: IMcpServerConnection, potentialBlocks: readonly IMcpPotentialSandboxBlock[]): boolean {
		if (!cnx.definition.sandboxEnabled || !potentialBlocks.length || this._isSandboxSuggestionDialogVisible) {
			return false;
		}
		if (this._isQuietStart) {
			throw new UserInteractionRequiredError('sandbox-suggestion');
		}

		const launch = this._fullDefinitions.get().server?.launch ?? cnx.definition.launch;
		const existingSandboxConfig = launch.type === McpServerTransportType.Stdio ? launch.sandbox : undefined;
		const suggestion = this._mcpSandboxService.getSandboxConfigSuggestionMessage(cnx.definition.label, potentialBlocks, existingSandboxConfig);
		if (!suggestion) {
			// clear potential blocks as there are no suggestions for them.
			this._removePotentialSandboxBlocks(potentialBlocks);
			return false;
		}

		this._confirmAndApplySandboxConfigSuggestion(cnx, potentialBlocks, suggestion);
		return true;
	}

	private _confirmAndApplySandboxConfigSuggestion(cnx: IMcpServerConnection, potentialBlocks: readonly IMcpPotentialSandboxBlock[], suggestion: NonNullable<ReturnType<IMcpSandboxService['getSandboxConfigSuggestionMessage']>>): void {
		const mcpResource = cnx.definition.presentation?.origin?.uri ?? this.collection.presentation?.origin;
		const configTarget = this._fullDefinitions.get().collection?.configTarget;
		this._isSandboxSuggestionDialogVisible = true;

		void this._dialogService.confirm({
			type: 'warning',
			message: localize('mcpSandboxSuggestion.confirm.message', "Update sandbox configuration in mcp.json for {0}?", cnx.definition.label),
			detail: suggestion.message,
			primaryButton: localize('mcpSandboxSuggestion.confirm.yes', "Yes"),
			cancelButton: localize('mcpSandboxSuggestion.confirm.no', "No"),
		}).then(async result => {
			if (!result.confirmed) {
				return;
			}

			if (!mcpResource || configTarget === undefined) {
				this._notificationService.warn(localize('mcpSandboxSuggestion.apply.unavailable', "Couldn't determine where to update sandbox configuration for {0}.", cnx.definition.label));
				return;
			}

			try {
				const updated = await this._mcpSandboxService.applySandboxConfigSuggestion(cnx.definition, mcpResource, configTarget, potentialBlocks, suggestion.sandboxConfig);
				if (updated) {
					this._removePotentialSandboxBlocks(potentialBlocks);
					this._notificationService.info(localize('mcpSandboxSuggestion.apply.success', "Updated sandbox configuration for {0} in mcp.json. Restart server.", cnx.definition.label));
				}
			} catch (e) {
				this._notificationService.error(localize('mcpSandboxSuggestion.apply.error', "Failed to update sandbox configuration for {0}: {1}", cnx.definition.label, e instanceof Error ? e.message : String(e)));
			}
		}).finally(() => {
			this._isSandboxSuggestionDialogVisible = false;
		});
	}

	public recordPotentialSandboxBlock(block: IMcpPotentialSandboxBlock): void {
		this._potentialSandboxBlocks.push(block);
		if (this._potentialSandboxBlocks.length > 200) {
			this._potentialSandboxBlocks.splice(0, this._potentialSandboxBlocks.length - 200);
		}

		const connection = this._connection.get();
		if (connection?.state.get().state === McpConnectionState.Kind.Running) {
			this.showSandboxConfigSuggestionFromPotentialBlocks(connection, this._potentialSandboxBlocks);
		}
	}

	private _removePotentialSandboxBlocks(blocks: readonly IMcpPotentialSandboxBlock[]): void {
		if (!blocks.length || !this._potentialSandboxBlocks.length) {
			return;
		}

		const toRemove = new Set(blocks);
		this._potentialSandboxBlocks = this._potentialSandboxBlocks.filter(block => !toRemove.has(block));
	}

	public stop(): Promise<void> {
		return this._connection.get()?.stop() || Promise.resolve();
	}

	/**
	 * Waits, after a tool call, until the live tool list is current for the
	 * next model turn (#261611). Every `tools/list_changed` replaces the
	 * listing at once, so a change announced during the call is covered by
	 * waiting for the current listing. A change announced after the result
	 * (on a stream not ordered with the call's response, or by a server that
	 * notifies after it answers) is covered by a grace window of
	 * {@link TOOL_LIST_CHANGE_GRACE_MS} for servers that announce tool list
	 * changes: the wait ends when the window passes with the listing complete,
	 * or earlier when a listing started after the call completes. Resolves at
	 * once when there is no live tool list (the server stopped), instead of
	 * waiting for the next connection, and as soon as `token` (the tool call's)
	 * is cancelled: the request no longer needs the next turn's list.
	 */
	public awaitToolRefresh(token: CancellationToken = CancellationToken.None): Promise<void> {
		if (token.isCancellationRequested) {
			return Promise.resolve();
		}
		const listingAtResult = this._tools.fromServerPromise.get();
		const capabilities = this.capabilities.get();
		const announcesChanges = capabilities === undefined || !!(capabilities & McpCapability.ToolsListChanged);
		const graceOver = observableValue(this, !announcesChanges);
		const store = new DisposableStore();
		if (announcesChanges) {
			store.add(disposableTimeout(() => graceOver.set(true, undefined), TOOL_LIST_CHANGE_GRACE_MS));
		}
		return new Promise<void>(resolve => {
			let settled = false;
			const finish = () => {
				if (!settled) {
					settled = true;
					store.dispose();
					resolve();
				}
			};
			store.add(token.onCancellationRequested(finish));
			const waiting = autorunSelfDisposable(reader => {
				const listing = this._tools.fromServerPromise.read(reader);
				const current = !listing || (!!listing.promiseResult.read(reader) && (graceOver.read(reader) || listing !== listingAtResult));
				if (current) {
					reader.dispose();
					finish();
				}
			});
			if (settled) {
				waiting.dispose();
			} else {
				store.add(waiting);
			}
		});
	}

	private resetLiveData() {
		transaction(tx => {
			this._tools.fromServerPromise.set(undefined, tx);
			this._prompts.fromServerPromise.set(undefined, tx);
		});
	}

	/** The output schemas of the tools of the lists read in this process, as the list read them (see {@link listedOutputSchema}). */
	private readonly _listedOutputSchemas = new WeakMap<ValidatedMcpTool, { readonly protocolVersion: string | undefined; readonly output: ICompiledJsonSchema | IJsonSchemaCompileError[] | undefined }>();

	/**
	 * The output schema of `tool`, a tool of `list`, as that list is read for
	 * `protocolVersion` (see `checkServerToolSchemas`): what the calls of the
	 * tool check their results with. The schemas of a list share one pattern
	 * analysis budget, and a pattern the list does not check because of it is
	 * not checked for a call either. A list read in this process kept what it
	 * compiled. A list that was not (one restored from storage), or that was
	 * read for another revision, is read again, whole and once, in the same
	 * way: this gives what the first reading gave, except that the tools
	 * dropped from the list for their input schemas no longer take their share
	 * of the budget. Calls thus compile nothing once their list is read, and
	 * reading it costs no more than reading a list does.
	 */
	public listedOutputSchema(list: readonly ValidatedMcpTool[], tool: ValidatedMcpTool, protocolVersion: string | undefined): ICompiledJsonSchema | IJsonSchemaCompileError[] | undefined {
		const recorded = this._listedOutputSchemas.get(tool);
		if (recorded && recorded.protocolVersion === protocolVersion) {
			return recorded.output;
		}
		const patternAnalysis = new PatternAnalysisBudget();
		for (const listed of list.includes(tool) ? list : [tool]) {
			this._listedOutputSchemas.set(listed, { protocolVersion, output: checkServerToolSchemas(listed, protocolVersion, patternAnalysis).output });
		}
		return this._listedOutputSchemas.get(tool)?.output;
	}

	/**
	 * @param protocolVersion The revision the server speaks: it decides how the
	 * tool's schemas are read (see `checkServerSchemaDocument`).
	 * @param patternAnalysis The budget of the backtracking analysis of the
	 * patterns of the schemas of the whole list, so that a list of many tools
	 * with distinct adversarial patterns takes no more time than one schema may.
	 */
	private async _normalizeTool(originalTool: MCPLegacy.Tool, protocolVersion: string | undefined, patternAnalysis: PatternAnalysisBudget): Promise<ValidatedMcpTool | { error: string[] }> {
		// Parse MCP Apps UI metadata from _meta.ui
		const uiMeta = originalTool._meta?.ui as McpApps.McpUiToolMeta | undefined;

		// Compute visibility from _meta.ui.visibility, defaulting to Model | App
		let visibility: McpToolVisibility = McpToolVisibility.Model | McpToolVisibility.App;
		if (uiMeta?.visibility && Array.isArray(uiMeta.visibility)) {
			visibility &= 0;

			if (uiMeta.visibility.includes('model')) {
				visibility |= McpToolVisibility.Model;
			}
			if (uiMeta.visibility.includes('app')) {
				visibility |= McpToolVisibility.App;
			}
		}

		const tool: ValidatedMcpTool = {
			...originalTool,
			serverToolName: originalTool.name,
			_icons: this._parseIcons(originalTool),
			visibility,
			uiResourceUri: uiMeta?.resourceUri,
		};
		if (!tool.description) {
			// Ensure a description is provided for each tool, #243919
			this._logger.warn(`Tool ${tool.name} does not have a description. Tools must be accurately described to be called`);
			tool.description = '<empty>';
		}

		if (toolInvalidCharRe.test(tool.name)) {
			this._logger.warn(`Tool ${JSON.stringify(tool.name)} is invalid. Tools names may only contain [a-z0-9_-]`);
			tool.name = tool.name.replace(toolInvalidCharRe, '_');
		}

		// Per MCP spec, properties is optional. But JSON Schema Draft 7 requires
		// it for object types. Normalize the schema to include an empty properties
		// object if not present. https://github.com/microsoft/vscode/issues/251723
		if (tool.inputSchema && !tool.inputSchema.properties) {
			tool.inputSchema = { ...tool.inputSchema, properties: {} };
		}

		// The schema must be a valid JSON Schema 2020-12 or draft-07 document. For a
		// 2026-07-28 server other dialects are rejected; older servers keep the
		// lenient reading they had. Remote references and limits are rejected for
		// every server. A pattern that cannot be compiled is not checked (a warning).
		const { input: check, output } = checkServerToolSchemas(tool, protocolVersion, patternAnalysis);
		// The calls of the tool check their results with this compilation (see listedOutputSchema).
		this._listedOutputSchemas.set(tool, { protocolVersion, output });
		if (check.warnings.length) {
			this._logger.warn(`Tool ${tool.name}: parts of its input schema are not checked: ${describeCompileErrors(check.warnings)}`);
		}
		if (output) {
			if (!isCompiledJsonSchema(output)) {
				this._logger.warn(readsSchemasLeniently(protocolVersion)
					? `Tool ${tool.name}: its output schema does not compile, so its structured results are not checked: ${describeCompileErrors(output)}`
					: `Tool ${tool.name}: its output schema does not compile, so its structured results will be discarded: ${describeCompileErrors(output)}`);
			} else if (output.warnings.length) {
				this._logger.warn(`Tool ${tool.name}: parts of its output schema are not checked: ${describeCompileErrors(output.warnings)}`);
			}
		}
		if (!check.errors.length) {
			return tool;
		}

		return { error: check.errors.map(p => p.message + (p.path ? ` (at ${p.path})` : '')) };
	}

	private async _getValidatedTools(tools: MCPLegacy.Tool[], protocolVersion: string | undefined): Promise<ValidatedMcpTool[]> {
		let error = '';

		const patternAnalysis = new PatternAnalysisBudget();
		const validations = await Promise.all(tools.map(t => this._normalizeTool(t, protocolVersion, patternAnalysis)));
		const validated: ValidatedMcpTool[] = [];
		for (const [i, result] of validations.entries()) {
			if ('error' in result) {
				error += localize('mcpBadSchema.tool', 'Tool `{0}` has invalid JSON parameters:', tools[i].name) + '\n';
				for (const message of result.error) {
					error += `\t- ${message}\n`;
				}
				error += `\t- Schema: ${JSON.stringify(tools[i].inputSchema)}\n\n`;
			} else {
				validated.push(result);
			}
		}

		if (error) {
			this._logger.warn(`${tools.length - validated.length} tools have invalid JSON schemas and will be omitted`);
			warnInvalidTools(this._instantiationService, this.definition.label, error);
		}

		return validated;
	}

	/**
	 * Parses incoming MCP icons and returns the resulting 'stored' record. Note
	 * that this requires an active MCP server connection since we validate
	 * against some of that connection's data. The icons may however be stored
	 * and rehydrated later.
	 */
	private _parseIcons(icons: MCPLegacy.Icons) {
		const cnx = this._connection.get();
		if (!cnx) {
			return [];
		}

		return parseAndValidateMcpIcon(icons, cnx.launchDefinition, this._logger);
	}

	/**
	 * Wraps a list from the server for its observable, which keeps the outcome
	 * (an error included). The wrapper's own promise is never awaited, so its
	 * rejection is handled here: a list cancelled because the handler went away
	 * (a disconnect, a stop) is expected, other failures are logged.
	 */
	private _observeList<T>(what: string, promise: Promise<T>): ObservablePromise<T> {
		const observable = new ObservablePromise(promise);
		observable.promise.catch(error => {
			if (!isCancellationError(error)) {
				this._logger.error(`Failed to list the ${what} of the server: ${error}`);
			}
		});
		return observable;
	}

	private _setServerTools(nonce: string | undefined, toolsPromise: Promise<IMcpListResult<MCPLegacy.Tool>>, tx: ITransaction | undefined, handler: McpServerRequestHandler) {
		const toolPromiseSafe = toolsPromise.then(async ({ items: tools, cacheHint }) => {
			this._logger.info(`Discovered ${tools.length} tools`);
			const data = await this._getValidatedTools(tools, handler.currentProtocolVersion);
			const freshness = { ...this._primitiveCache.get(this.definition.id)?.freshness, tools: toStoredFreshness(cacheHint) };
			this._primitiveCache.store(this.definition.id, { tools: data, nonce, freshness });
			return { data, nonce };
		});
		this._tools.fromServerPromise.set(this._observeList('tools', toolPromiseSafe), tx);
		return toolPromiseSafe;
	}

	private _reuseCachedTools(nonce: string | undefined, tools: readonly ValidatedMcpTool[], tx: ITransaction | undefined) {
		this._logger.info(`Reusing ${tools.length} cached tools (still fresh per the server's caching hint)`);
		const promise = Promise.resolve({ data: tools, nonce });
		this._tools.fromServerPromise.set(new ObservablePromise(promise), tx);
		return promise;
	}

	private _setServerPrompts(nonce: string | undefined, promptsPromise: Promise<IMcpListResult<MCPLegacy.Prompt>>, tx: ITransaction | undefined) {
		const promptsPromiseSafe = promptsPromise.then(({ items, cacheHint }): { data: StoredMcpPrompt[]; nonce: string | undefined } => {
			const data: StoredMcpPrompt[] = items.map(prompt => ({
				...prompt,
				_icons: this._parseIcons(prompt)
			}));
			const freshness = { ...this._primitiveCache.get(this.definition.id)?.freshness, prompts: toStoredFreshness(cacheHint) };
			this._primitiveCache.store(this.definition.id, { prompts: data, nonce, freshness });
			return { data, nonce };
		});

		this._prompts.fromServerPromise.set(this._observeList('prompts', promptsPromiseSafe), tx);
		return promptsPromiseSafe;
	}

	private _reuseCachedPrompts(nonce: string | undefined, prompts: readonly StoredMcpPrompt[], tx: ITransaction | undefined) {
		const promise = Promise.resolve({ data: prompts as StoredMcpPrompt[], nonce });
		this._prompts.fromServerPromise.set(new ObservablePromise(promise), tx);
		return promise;
	}

	/**
	 * The era/revision hint for the next connection; the probe is skipped when it
	 * is right. The cached revision is used when it was negotiated for the same
	 * launch and the same `protocolVersion` pin: a pin the server rejected is not
	 * sent again until the pin or the launch changes (the log says so on every
	 * such start). Otherwise a configured pin is used, and without one the server
	 * is probed.
	 */
	private _negotiationHints(connection: IMcpServerConnection): IMcpNegotiationHints | undefined {
		const pin = connection.definition.protocolVersionHint;
		const cached = this._primitiveCache.get(this.definition.id);
		if (cached?.protocol && cached.nonce === connection.definition.cacheNonce && cached.protocol.pin === pin) {
			// Logged only when the hint is used: start() also gets here for a connection that already runs.
			if (pin !== undefined && cached.protocol.version !== pin && McpConnectionState.canBeStarted(connection.state.get().state)) {
				this._logger.info(`Using MCP ${cached.protocol.version}, negotiated when the server did not accept the configured protocolVersion ${pin}; the pin is tried again when it or the server's connection settings change, or after MCP: Reset Cached Tools`);
			}
			return { era: cached.protocol.era, protocolVersion: cached.protocol.version };
		}
		return pin ? { protocolVersion: pin } : undefined;
	}

	private _publishProtocolEvent(event: McpProtocolEvent, transport: string) {
		switch (event.kind) {
			case 'negotiation':
				this._telemetryService.publicLog2<ProtocolNegotiationData, ProtocolNegotiationClassification>('mcp/protocolNegotiation', {
					era: event.era,
					protocolVersion: event.protocolVersion,
					transport,
					durationMs: event.durationMs,
					probeTimedOut: event.probeTimedOut,
					usedHint: event.usedHint,
				});
				break;
			case 'renegotiation':
				this._telemetryService.publicLog2<ProtocolRenegotiationData, ProtocolRenegotiationClassification>('mcp/protocolRenegotiation', { code: event.code, retried: event.retried });
				break;
			case 'mrtr':
				this._telemetryService.publicLog2<MrtrRoundData, MrtrRoundClassification>('mcp/mrtrRound', { method: event.method, rounds: event.rounds, inputKinds: event.inputKinds.join(',') });
				break;
			case 'listen-reconnect':
				this._telemetryService.publicLog2<ListenReconnectData, ListenReconnectClassification>('mcp/listenReconnect', { stream: event.stream, reason: event.reason, backoffMs: event.backoffMs });
				break;
		}
	}

	private _toStoredMetadata(serverInfo?: MCPLegacy.Implementation, instructions?: string): StoredServerMetadata {
		return {
			serverName: serverInfo ? serverInfo.title || serverInfo.name : undefined,
			serverInstructions: instructions,
			serverIcons: serverInfo ? this._parseIcons(serverInfo) : undefined,
		};
	}

	private _setServerMetadata(
		nonce: string | undefined,
		{ serverInfo, instructions, capabilities, protocol }: { serverInfo: MCP.Implementation; instructions: string | undefined; capabilities: MCP.ServerCapabilities; protocol: IStoredProtocol },
		tx: ITransaction | undefined,
	) {
		const serverMetadata: StoredServerMetadata = this._toStoredMetadata(serverInfo, instructions);
		this._serverMetadata.fromServerPromise.set(ObservablePromise.resolved({ nonce, data: serverMetadata }), tx);

		const capabilitiesEncoded = encodeCapabilities(capabilities, protocol.era);
		this._capabilities.fromServerPromise.set(ObservablePromise.resolved({ data: capabilitiesEncoded, nonce }), tx);
		this._primitiveCache.store(this.definition.id, { ...serverMetadata, nonce, capabilities: capabilitiesEncoded, protocol });
	}

	/** @param pin The `protocolVersion` pinned when the connection started; stored with the negotiated revision. */
	private _populateLiveData(handler: McpServerRequestHandler, cacheNonce: string | undefined, pin: string | undefined, store: DisposableStore) {
		const cts = new CancellationTokenSource();
		store.add(toDisposable(() => cts.dispose(true)));

		const transport = McpServer._transportName(this._connection.get()?.launchDefinition.type);
		// The handshake's events (probe renegotiations, then the negotiation) fired before we could subscribe.
		for (const event of handler.handshakeEvents) {
			this._publishProtocolEvent(event, transport);
		}
		store.add(handler.onDidReportProtocolEvent(e => this._publishProtocolEvent(e, transport)));

		// -32020/-32021/-32022 the handler could not recover from: tell the user once per kind and connection.
		const reportedFailures = new Set<McpProtocolFailure['kind']>();
		store.add(handler.onDidReportProtocolFailure(failure => {
			if (!reportedFailures.has(failure.kind)) {
				reportedFailures.add(failure.kind);
				this._notifyProtocolFailure(failure);
			}
		}));

		// A public list the server allowed us to cache is reused while it is fresh (2026-07-28 servers);
		// private lists and lists without a hint are always fetched again.
		const cached = this._primitiveCache.get(this.definition.id);
		const cacheIsForThisServer = !!cached && cached.nonce === cacheNonce && handler.era === 'modern';
		const emptyHint: IMcpCacheHint = { receivedAt: Date.now(), ttlMs: undefined, cacheScope: undefined };

		const updateTools = (tx: ITransaction | undefined, force = false) => {
			if (!force && cacheIsForThisServer && isFreshList(cached.freshness?.tools) && cached.tools.length) {
				handler.seedToolHeaderAnnotations(cached.tools.map(t => ({ ...t, name: t.serverToolName ?? t.name })));
				return this._reuseCachedTools(cacheNonce, cached.tools, tx);
			}
			const toolPromise = handler.capabilities.tools ? handler.listToolsEx({}, cts.token) : Promise.resolve<IMcpListResult<MCPLegacy.Tool>>({ items: [], cacheHint: emptyHint });
			return this._setServerTools(cacheNonce, toolPromise, tx, handler);
		};

		const updatePrompts = (tx: ITransaction | undefined, force = false) => {
			if (!force && cacheIsForThisServer && isFreshList(cached.freshness?.prompts) && cached.prompts) {
				return this._reuseCachedPrompts(cacheNonce, cached.prompts, tx);
			}
			const promptsPromise = handler.capabilities.prompts ? handler.listPromptsEx({}, cts.token) : Promise.resolve<IMcpListResult<MCPLegacy.Prompt>>({ items: [], cacheHint: emptyHint });
			return this._setServerPrompts(cacheNonce, promptsPromise, tx);
		};

		store.add(handler.onDidChangeToolList(() => {
			this._logger.info('Tool list changed, refreshing tools...');
			// Replaces the listing at once: awaitToolRefresh waits for this one (#261611).
			updateTools(undefined, true);
		}));

		store.add(handler.onDidChangePromptList(() => {
			this._logger.info('Prompts list changed, refreshing prompts...');
			updatePrompts(undefined, true);
		}));

		transaction(tx => {
			const protocol: IStoredProtocol = pin ? { era: handler.era, version: handler.protocolVersion, pin } : { era: handler.era, version: handler.protocolVersion };
			this._setServerMetadata(cacheNonce, { serverInfo: handler.serverInfo, instructions: handler.serverInstructions, capabilities: handler.capabilities, protocol }, tx);
			updatePrompts(tx);
			const toolUpdate = updateTools(tx);

			toolUpdate.then(tools => {
				this._telemetryService.publicLog2<ServerBootData, ServerBootClassification>('mcp/serverBoot', {
					supportsLogging: !!handler.capabilities.logging,
					supportsPrompts: !!handler.capabilities.prompts,
					supportsResources: !!handler.capabilities.resources,
					toolCount: tools.data.length,
					serverName: handler.serverInfo.name,
					serverVersion: handler.serverInfo.version,
				});
			}, () => {
				// No boot event without a tool list; the failure (if not a cancellation) is logged by _observeList.
			});
		});
	}
}

class McpPrompt implements IMcpPrompt {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly title?: string;
	readonly arguments: readonly MCPLegacy.PromptArgument[];
	readonly icons: IMcpIcons;

	constructor(
		private readonly _server: McpServer,
		private readonly _definition: StoredMcpPrompt,
	) {
		this.id = mcpPromptReplaceSpecialChars(this._server.definition.label + '.' + _definition.name);
		this.name = _definition.name;
		this.title = _definition.title;
		this.description = _definition.description;
		this.arguments = _definition.arguments || [];
		this.icons = McpIcons.fromStored(this._definition._icons);
	}

	async resolve(args: Record<string, string>, token?: CancellationToken): Promise<IMcpPromptMessage[]> {
		const result = await McpServer.callOn(this._server, h => h.getPrompt({ name: this._definition.name, arguments: args }, token), token);
		return result.messages;
	}

	async complete(argument: string, prefix: string, alreadyResolved: Record<string, string>, token?: CancellationToken): Promise<string[]> {
		if (!serverMayComplete(this._server)) {
			return [];
		}
		const result = await McpServer.callOn(this._server, h => h.complete({
			ref: { type: 'ref/prompt', name: this._definition.name },
			argument: { name: argument, value: prefix },
			context: { arguments: alreadyResolved },
		}, token), token);
		return result.completion.values;
	}
}

/** Completions are only requested from servers that advertise the capability (unknown capabilities allow the attempt). */
function serverMayComplete(server: McpServer): boolean {
	const capabilities = server.capabilities.get();
	return capabilities === undefined || !!(capabilities & McpCapability.Completions);
}

type EncodableCapabilities = {
	readonly logging?: object;
	readonly completions?: object;
	readonly prompts?: { readonly listChanged?: boolean };
	readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
	readonly tools?: { readonly listChanged?: boolean };
};

function encodeCapabilities(cap: EncodableCapabilities, era?: McpProtocolEra): McpCapability {
	let out = 0;
	if (era === 'modern') { out |= McpCapability.StatelessProtocol; }
	if (cap.logging) { out |= McpCapability.Logging; }
	if (cap.completions) { out |= McpCapability.Completions; }
	if (cap.prompts) {
		out |= McpCapability.Prompts;
		if (cap.prompts.listChanged) {
			out |= McpCapability.PromptsListChanged;
		}
	}
	if (cap.resources) {
		out |= McpCapability.Resources;
		if (cap.resources.subscribe) {
			out |= McpCapability.ResourcesSubscribe;
		}
		if (cap.resources.listChanged) {
			out |= McpCapability.ResourcesListChanged;
		}
	}
	if (cap.tools) {
		out |= McpCapability.Tools;
		if (cap.tools.listChanged) {
			out |= McpCapability.ToolsListChanged;
		}
	}
	return out;
}

export class McpTool implements IMcpTool {

	readonly id: string;
	readonly referenceName: string;
	readonly icons: IMcpIcons;
	readonly visibility: McpToolVisibility;

	public get definition(): MCPLegacy.Tool { return this._definition; }
	public get uiResourceUri(): string | undefined { return this._definition.uiResourceUri; }

	/**
	 * @param _list The tool list the definition belongs to: the output schema
	 * is read as the list reads it (see {@link McpServer.listedOutputSchema}).
	 */
	constructor(
		private readonly _server: McpServer,
		idPrefix: string,
		private readonly _definition: ValidatedMcpTool,
		private readonly _list: readonly ValidatedMcpTool[],
		@IMcpElicitationService private readonly _elicitationService: IMcpElicitationService,
	) {
		this.referenceName = _definition.name.replaceAll('.', '_');
		this.id = (idPrefix + _definition.name).replaceAll('.', '_').slice(0, McpToolName.MaxLength);
		this.icons = McpIcons.fromStored(this._definition._icons);
		this.visibility = _definition.visibility ?? (McpToolVisibility.Model | McpToolVisibility.App);
	}

	async call(params: Record<string, unknown>, context?: IMcpToolCallContext, token?: CancellationToken): Promise<MCPLegacy.CallToolResult> {
		if (context) { this._server.runningToolCalls.add(context); }
		try {
			return await this._callWithProgress(params, undefined, context, token);
		} finally {
			if (context) { this._server.runningToolCalls.delete(context); }
		}
	}

	async callWithProgress(params: Record<string, unknown>, progress: ToolProgress, context?: IMcpToolCallContext, token?: CancellationToken): Promise<MCPLegacy.CallToolResult> {
		if (context) { this._server.runningToolCalls.add(context); }
		try {
			return await this._callWithProgress(params, progress, context, token);
		} finally {
			if (context) { this._server.runningToolCalls.delete(context); }
		}
	}

	_callWithProgress(params: Record<string, unknown>, progress: ToolProgress | undefined, context?: IMcpToolCallContext, token = CancellationToken.None, allowRetry = true): Promise<MCPLegacy.CallToolResult> {
		// serverToolName is always set now, but older cache entries (from 1.99-Insiders) may not have it.
		const name = this._definition.serverToolName ?? this._definition.name;
		const progressToken = progress ? generateUuid() : undefined;
		const store = new DisposableStore();

		return McpServer.callOn(this._server, async h => {
			if (progress) {
				store.add(h.onDidReceiveProgressNotification((e) => {
					if (e.params.progressToken === progressToken) {
						progress.report({
							message: e.params.message,
							progress: e.params.total !== undefined && e.params.progress !== undefined ? e.params.progress / e.params.total : undefined,
						});
					}
				}));
			}

			const meta: Record<string, unknown> = { progressToken };
			if (context?.chatSessionResource) {
				meta['vscode.conversationId'] = chatSessionResourceToId(context.chatSessionResource);
			}
			if (context?.chatRequestId) {
				meta['vscode.requestId'] = context.chatRequestId;
			}
			// Propagate W3C trace context to the MCP server (MCP SEP-414) so server-side
			// spans can be correlated with the client trace.
			if (context?.traceparent) {
				meta['traceparent'] = context.traceparent;
				if (context.tracestate) {
					meta['tracestate'] = context.tracestate;
				}
			}

			const taskHint = this._definition.execution?.taskSupport;
			// 2025-11-25: the client asks for a task (`task` param) where the server and the tool allow it.
			// 2026-07-28 (Tasks extension, SEP-2663): the server decides; the client opts in per request
			// unless the tool forbids tasks (the 2026-07-28 tool schema has no `execution`, so most
			// servers do not publish `taskSupport` and their task tools would otherwise get -32021).
			const shouldUseTask = h.era === 'modern'
				? h.supportsModernTasks && taskHint !== 'forbidden'
				: h.legacyCapabilities?.tasks?.requests?.tools?.call !== undefined && (taskHint === 'required' || taskHint === 'optional');

			try {
				const result = this._checkStructuredContent(await h.callTool({
					name,
					arguments: params,
					task: shouldUseTask ? {} : undefined,
					_meta: meta,
				}, token, progress ? (message) => progress.report({ message }) : undefined, context), h);

				// Wait for tools to refresh for dynamic servers (#261611), unless the request is cancelled
				await this._server.awaitToolRefresh(token);

				return result;
			} catch (err) {
				// Handle URL elicitation required error (a 2025-11-25 mechanism; modern servers ask through input_required)
				if (err instanceof MpcResponseError && err.code === MCPLegacy.URL_ELICITATION_REQUIRED && allowRetry && h.era === 'legacy') {
					await this._handleElicitationErr(err, context, token);
					return this._callWithProgress(params, progress, context, token, false);
				}

				const state = this._server.connectionState.get();
				if (allowRetry && state.state === McpConnectionState.Kind.Error && state.shouldRetry) {
					return this._callWithProgress(params, progress, context, token, false);
				} else {
					throw err;
				}
			} finally {
				store.dispose();
			}
		}, token);
	}

	/**
	 * Checks `structuredContent` against the tool's `outputSchema`, as its list
	 * reads it: a mismatch is a server-side protocol error; an output schema
	 * that does not compile turns the result into an `isError` result for the
	 * model.
	 */
	private _checkStructuredContent(result: MCPLegacy.CallToolResult, handler: McpServerRequestHandler): MCPLegacy.CallToolResult {
		const protocolVersion = handler.currentProtocolVersion;
		const check = checkStructuredContent(this._definition.name, this._definition.outputSchema, result, protocolVersion, () => this._server.listedOutputSchema(this._list, this._definition, protocolVersion));
		switch (check.kind) {
			case 'ok':
				return result;
			case 'unchecked':
				handler.logger.warn(`Cannot validate the structured content of tool "${this._definition.name}": ${check.problem}`);
				return result;
			case 'invalid-schema':
				handler.logger.warn(`Discarded the result of tool "${this._definition.name}" because its output schema does not compile: ${check.problem}`);
				return check.result;
			case 'mismatch':
				throw new MpcResponseError(localize('mcp.outputSchemaMismatch', "The result of tool \"{0}\" does not match its output schema: {1}", this._definition.name, check.detail), MCPLegacy.INVALID_PARAMS, { errors: check.errors });
		}
	}

	private async _handleElicitationErr(err: MpcResponseError, context: IMcpToolCallContext | undefined, token: CancellationToken) {
		const elicitations = (err.data as MCPLegacy.URLElicitationRequiredError['error']['data'])?.elicitations;
		if (Array.isArray(elicitations) && elicitations.length > 0) {
			for (const elicitation of elicitations) {
				const elicitResult = await this._elicitationService.elicit(this._server, context, elicitation, token);

				try {
					if (elicitResult.value.action !== 'accept') {
						throw err;
					}

					if (elicitResult.kind === ElicitationKind.URL) {
						await elicitResult.wait;
					}
				} finally {
					elicitResult.dispose();
				}
			}
		}
	}

	compare(other: IMcpTool): number {
		return this._definition.name.localeCompare(other.definition.name);
	}
}

function warnInvalidTools(instaService: IInstantiationService, serverName: string, errorText: string) {
	instaService.invokeFunction((accessor) => {
		const notificationService = accessor.get(INotificationService);
		const editorService = accessor.get(IEditorService);
		notificationService.notify({
			severity: Severity.Warning,
			message: localize('mcpBadSchema', 'MCP server `{0}` has tools with invalid parameters which will be omitted.', serverName),
			actions: {
				primary: [{
					class: undefined,
					enabled: true,
					id: 'mcpBadSchema.show',
					tooltip: '',
					label: localize('mcpBadSchema.show', 'Show'),
					run: () => {
						editorService.openEditor({
							resource: undefined,
							contents: errorText,
						});
					}
				}]
			}
		});
	});
}

class McpResource implements IMcpResource {
	readonly uri: URI;
	readonly mcpUri: string;
	readonly name: string;
	readonly description: string | undefined;
	readonly mimeType: string | undefined;
	readonly sizeInBytes: number | undefined;
	readonly title: string | undefined;

	constructor(
		server: McpServer,
		original: MCPLegacy.Resource,
		public readonly icons: IMcpIcons,
	) {
		this.mcpUri = original.uri;
		this.title = original.title;
		this.uri = McpResourceURI.fromServer(server.definition, original.uri);
		this.name = original.name;
		this.description = original.description;
		this.mimeType = original.mimeType;
		this.sizeInBytes = original.size;
	}
}

class McpResourceTemplate implements IMcpResourceTemplate {
	readonly name: string;
	readonly title?: string | undefined;
	readonly description?: string;
	readonly mimeType?: string;
	readonly template: UriTemplate;

	constructor(
		private readonly _server: McpServer,
		private readonly _definition: MCPLegacy.ResourceTemplate,
		public readonly icons: IMcpIcons,
	) {
		this.name = _definition.name;
		this.description = _definition.description;
		this.mimeType = _definition.mimeType;
		this.title = _definition.title;
		this.template = UriTemplate.parse(_definition.uriTemplate);
	}

	public resolveURI(vars: Record<string, unknown>): URI {
		const serverUri = this.template.resolve(vars);
		return McpResourceURI.fromServer(this._server.definition, serverUri);
	}

	async complete(templatePart: string, prefix: string, alreadyResolved: Record<string, string | string[]>, token?: CancellationToken): Promise<string[]> {
		if (!serverMayComplete(this._server)) {
			return [];
		}
		const result = await McpServer.callOn(this._server, h => h.complete({
			ref: { type: 'ref/resource', uri: this._definition.uriTemplate },
			argument: { name: templatePart, value: prefix },
			context: {
				arguments: mapValues(alreadyResolved, v => Array.isArray(v) ? v.join('/') : v),
			},
		}, token), token);
		return result.completion.values;
	}
}
