/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { distinct, equals as arraysEqual } from '../../../../base/common/arrays.js';
import { assertNever } from '../../../../base/common/assert.js';
import { decodeHex, encodeHex, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { JsonRpcId } from '../../../../base/common/jsonRpcProtocol.js';
import { McpProtocolEra } from '../../../../platform/mcp/common/mcpProtocolVersions.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { equals as objectsEqual } from '../../../../base/common/objects.js';
import { IObservable, ObservableMap } from '../../../../base/common/observable.js';
import { IIterativePager } from '../../../../base/common/paging.js';
import { isEqual } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { Location } from '../../../../editor/common/languages.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMcpGalleryManifest, McpGalleryManifestStatus } from '../../../../platform/mcp/common/mcpGalleryManifest.js';
import { IGalleryMcpServer, IGalleryMcpServerConfiguration, IInstallableMcpServer, IQueryOptions } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpDevModeConfig, IMcpGrpcServerTlsConfiguration, IMcpSandboxConfiguration, IMcpServerConfiguration, McpGrpcBinding, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { McpResourceFormat } from '../../../../platform/mcp/common/mcpWorkspaceConfiguration.js';
import { McpSkills } from '../../../../platform/mcp/common/modelContextProtocolSkills.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceFolder, IWorkspaceFolderData } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLocalMcpServer, IWorkbencMcpServerInstallOptions, WORKSPACE_FOLDER_CONFIG_ID_PREFIX } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { ContributionEnablementState, IEnablementModel } from '../../chat/common/enablement.js';
import { ToolProgress } from '../../chat/common/tools/languageModelToolsService.js';
import { ExternalDiscoverySource, IMcpServerSamplingConfiguration } from './mcpConfiguration.js';
import { McpServerRequestHandler } from './mcpServerRequestHandler.js';
import { McpLoadedSkill } from './mcpSkills.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';
import { UriTemplate } from '../../../../base/common/uriTemplate.js';

export const extensionMcpCollectionPrefix = 'ext.';

/**
 * Prefix of the collection id used for MCP servers configured via the various
 * `mcp.json`-style config files (user, remote user, workspace, and
 * `.vscode/mcp.json` workspace-folder configs). The suffix is the
 * {@link IMcpConfigPath.id} of the originating config path.
 */
export const MCP_CONFIGURATION_COLLECTION_ID_PREFIX = 'mcp.config.';
export const MCP_PLUGIN_COLLECTION_ID_PREFIX = 'plugin.';
export const CURSOR_WORKSPACE_MCP_COLLECTION_ID_PREFIX = 'cursor-workspace.';

export const enum McpCollectionProvenance {
	UserProfile = 'userProfile', // User profile `mcp.json`.
	RemoteUser = 'remoteUser', // Remote user profile `mcp.json`.
	WorkspaceConfiguration = 'workspaceConfiguration', // The `settings.mcp` section of a `.code-workspace` file.
	WorkspaceFolderConfiguration = 'workspaceFolderConfiguration', // `<workspace>/.vscode/mcp.json`.
	WorkspaceDotMcp = 'workspaceDotMcp', // `<workspace>/.mcp.json`.
	ExternalConfiguration = 'externalConfiguration', // Claude Desktop, GitHub Copilot, Windsurf, or Cursor user/workspace configuration.
	Extension = 'extension', // An extension-provided `McpServerDefinitionProvider`.
	Plugin = 'plugin', // An agent plugin's `.mcp.json`.
}

/** Returns the collection provenance represented by a VS Code configuration target. */
export function getMcpCollectionProvenance(target: ConfigurationTarget | undefined): McpCollectionProvenance | undefined {
	switch (target) {
		case ConfigurationTarget.USER:
		case ConfigurationTarget.USER_LOCAL:
			return McpCollectionProvenance.UserProfile;
		case ConfigurationTarget.USER_REMOTE:
			return McpCollectionProvenance.RemoteUser;
		case ConfigurationTarget.WORKSPACE:
			return McpCollectionProvenance.WorkspaceConfiguration;
		case ConfigurationTarget.WORKSPACE_FOLDER:
			return McpCollectionProvenance.WorkspaceFolderConfiguration;
		default:
			return undefined;
	}
}

/**
 * Prefix of the collection id used for MCP servers discovered from folder-root
 * `.mcp.json` files (Claude-style `{ "mcpServers": { ... } }`). The suffix is
 * the workspace folder index.
 */
export { WORKSPACE_ROOT_MCP_COLLECTION_ID_PREFIX as WORKSPACE_DOT_MCP_COLLECTION_ID_PREFIX } from '../../../../platform/mcp/common/mcpWorkspaceConfiguration.js';

export function extensionPrefixedIdentifier(identifier: ExtensionIdentifier, id: string): string {
	return ExtensionIdentifier.toKey(identifier) + '/' + id;
}

/**
 * An McpCollection contains McpServers. There may be multiple collections for
 * different locations servers are discovered.
 */
export interface McpCollectionDefinition {
	/** Origin authority from which this collection was discovered. */
	readonly remoteAuthority: string | null;
	/** Globally-unique, stable ID for this definition */
	readonly id: string;
	/** Broad origin category; external product identity is recorded separately in {@link discoverySource}. */
	readonly provenance?: McpCollectionProvenance;
	/** Exact external product when {@link provenance} is `ExternalConfiguration`. */
	readonly discoverySource?: ExternalDiscoverySource;
	/** Human-readable label for the definition */
	readonly label: string;
	/** Definitions this collection contains. */
	readonly serverDefinitions: IObservable<readonly McpServerDefinition[]>;
	/**
	 * Trust behavior of the servers. `Trusted` means it will run without a prompt, always.
	 * `TrustedOnNonce` means it will run without a prompt as long as the nonce matches.
	 */
	readonly trustBehavior: McpServerTrust.Kind.Trusted | McpServerTrust.Kind.TrustedOnNonce;
	/** Scope where associated collection info should be stored. */
	readonly scope: StorageScope;
	/** Configuration target where configuration related to this server should be stored. */
	readonly configTarget: ConfigurationTarget;
	/** Root-level sandbox settings from the mcp config file. */
	readonly sandbox?: IMcpSandboxConfiguration;

	/** Resolves a server definition. If present, always called before a server starts. */
	resolveServerLanch?(definition: McpServerDefinition): Promise<McpServerLaunch | undefined>;

	/** For lazy-loaded collections only: */
	readonly lazy?: {
		/** True if `serverDefinitions` were loaded from the cache */
		isCached: boolean;
		/** Triggers a load of the real server definition, which should be pushed to the IMcpRegistry. If not this definition will be removed. */
		load(): Promise<void>;
		/** Called after `load()` if the extension is not found. */
		removed?(): void;
	};

	readonly source?: IWorkbenchMcpServer | ExtensionIdentifier;

	/** Sort order of the collection. Lower values have higher priority. */
	readonly order: number;

	readonly presentation?: {
		/** Place where this collection is configured, used in workspace trust prompts and "show config" */
		readonly origin?: URI;
	};
}

export const enum McpCollectionSortOrder {
	WorkspaceFolder = 0,
	Workspace = 100,
	User = 200,
	Extension = 300,
	Plugin = 350,
	Filesystem = 400,

	RemoteBoost = -50,
}

export namespace McpCollectionDefinition {
	export interface FromExtHost {
		readonly id: string;
		readonly label: string;
		readonly isTrustedByDefault: boolean;
		readonly scope: StorageScope;
		readonly canResolveLaunch: boolean;
		readonly extensionId: string;
		readonly configTarget: ConfigurationTarget;
	}

	export function equals(a: McpCollectionDefinition, b: McpCollectionDefinition): boolean {
		return a.id === b.id
			&& a.remoteAuthority === b.remoteAuthority
			&& a.label === b.label
			&& a.provenance === b.provenance
			&& a.discoverySource === b.discoverySource
			&& a.trustBehavior === b.trustBehavior
			&& objectsEqual(a.sandbox, b.sandbox);
	}

	/**
	 * Returns `true` when the collection was discovered from the workspace (its
	 * config target is the workspace or a workspace folder). This is
	 * intentionally based on the config target and not the storage scope:
	 * extension-contributed collections use a workspace storage scope but are
	 * configured at the user level, so they are not workspace-discovered.
	 */
	export function isWorkspaceDiscovered(collection: McpCollectionDefinition): boolean {
		return collection.configTarget === ConfigurationTarget.WORKSPACE
			|| collection.configTarget === ConfigurationTarget.WORKSPACE_FOLDER;
	}

	/**
	 * Returns `true` when the collection originates from a `.vscode/mcp.json`
	 * workspace-folder config, identified by its collection id prefix (the
	 * shared `mcp.config.` prefix plus the workspace-folder config id).
	 */
	export function isVscodeMcpJson(collection: McpCollectionDefinition): boolean {
		return collection.id.startsWith(`${MCP_CONFIGURATION_COLLECTION_ID_PREFIX}${WORKSPACE_FOLDER_CONFIG_ID_PREFIX}`);
	}
}

export interface McpServerDefinition {
	/** Globally-unique, stable ID for this definition */
	readonly id: string;
	/** Human-readable label for the definition */
	readonly label: string;
	/** Descriptor defining how the configuration should be launched. */
	readonly launch: McpServerLaunch;
	/** Default working directory when {@link launch} does not specify one. */
	readonly defaultCwd?: URI;
	/** Explicit roots. If undefined, all workspace folders. */
	readonly roots?: URI[] | undefined;
	/** If set, allows configuration variables to be resolved in the {@link launch} with the given context */
	readonly variableReplacement?: McpServerDefinitionVariableReplacement;
	/**
	 * If set, `${VAR}` environment variable references in the {@link launch}, as written when
	 * servers are migrated to `.mcp.json` or the Copilot user configuration, are expanded with
	 * the environment of the extension host that runs or connects to the server.
	 */
	readonly environmentVariableExpansion?: McpServerEnvironmentVariableExpansion;
	/** Nonce used for caching the server. Changing the nonce will indicate that tools need to be refreshed. */
	readonly cacheNonce: string;
	/**
	 * An optional protocol revision the user pinned in the configuration. The
	 * client skips era detection and speaks that revision (non-strict: it still
	 * falls back when the server rejects it).
	 */
	readonly protocolVersionHint?: string;
	/** Dev mode configuration for the server */
	readonly devMode?: IMcpDevModeConfig;
	/** Optional server version metadata from the source configuration. */
	readonly version?: string;
	/** Optional gallery metadata from the source configuration. */
	readonly gallery?: boolean | string;
	/** Static description of server tools/data, used to hydrate the cache. */
	readonly staticMetadata?: McpServerStaticMetadata;
	/** Indicates if the sandbox is enabled for this server. */
	readonly sandboxEnabled?: boolean;


	readonly presentation?: {
		/** Sort order of the definition. */
		readonly order?: number;
		/** Place where this server is configured, used in workspace trust prompts and "show config" */
		readonly origin?: Location;
	};
}

export const enum McpServerStaticToolAvailability {
	/** Tool is expected to be present as soon as the server is started. */
	Initial,
	/** Tool may be present later. */
	Dynamic,
}

export interface McpServerStaticMetadata {
	tools?: { availability: McpServerStaticToolAvailability; definition: MCPLegacy.Tool }[];
	instructions?: string;
	capabilities?: MCPLegacy.ServerCapabilities;
	serverInfo?: MCPLegacy.Implementation;
}

/**
 * Structural equality that compares URI values by their normalized identity
 * instead of their enumerable lazy-cache fields.
 */
function objectsEqualWithUris(one: unknown, other: unknown): boolean {
	if (one === other) {
		return true;
	}
	if (URI.isUri(one) || URI.isUri(other)) {
		return URI.isUri(one) && URI.isUri(other) && isEqual(one, other);
	}
	if (one === null || one === undefined || other === null || other === undefined) {
		return false;
	}
	if (typeof one !== typeof other || typeof one !== 'object') {
		return false;
	}
	if (Array.isArray(one) !== Array.isArray(other)) {
		return false;
	}
	if (Array.isArray(one) && Array.isArray(other)) {
		return arraysEqual(one, other, objectsEqualWithUris);
	}

	const oneKeys: string[] = [];
	for (const key in one) {
		oneKeys.push(key);
	}
	oneKeys.sort();

	const otherKeys: string[] = [];
	for (const key in other) {
		otherKeys.push(key);
	}
	otherKeys.sort();

	if (!arraysEqual(oneKeys, otherKeys)) {
		return false;
	}
	for (const key of oneKeys) {
		if (!objectsEqualWithUris(Reflect.get(one, key), Reflect.get(other, key))) {
			return false;
		}
	}
	return true;
}

export namespace McpServerDefinition {
	export interface Serialized {
		readonly id: string;
		readonly label: string;
		readonly cacheNonce: string;
		readonly protocolVersionHint?: string;
		readonly launch: McpServerLaunch.Serialized;
		readonly defaultCwd?: UriComponents;
		readonly variableReplacement?: McpServerDefinitionVariableReplacement.Serialized;
		readonly environmentVariableExpansion?: McpServerEnvironmentVariableExpansion;
		readonly staticMetadata?: McpServerStaticMetadata;
		readonly sandboxEnabled?: boolean;
		readonly version?: string;
		readonly gallery?: boolean | string;
	}

	export function toSerialized(def: McpServerDefinition): McpServerDefinition.Serialized {
		return def;
	}

	export function fromSerialized(def: McpServerDefinition.Serialized): McpServerDefinition {
		return {
			id: def.id,
			label: def.label,
			cacheNonce: def.cacheNonce,
			protocolVersionHint: def.protocolVersionHint,
			staticMetadata: def.staticMetadata,
			launch: McpServerLaunch.fromSerialized(def.launch),
			defaultCwd: def.defaultCwd ? URI.revive(def.defaultCwd) : undefined,
			sandboxEnabled: def.sandboxEnabled,
			version: def.version,
			gallery: def.gallery,
			variableReplacement: def.variableReplacement ? McpServerDefinitionVariableReplacement.fromSerialized(def.variableReplacement) : undefined,
			environmentVariableExpansion: def.environmentVariableExpansion,
		};
	}

	export function equals(a: McpServerDefinition, b: McpServerDefinition): boolean {
		return a.id === b.id
			&& a.label === b.label
			&& a.cacheNonce === b.cacheNonce
			&& isEqual(a.defaultCwd, b.defaultCwd)
			&& arraysEqual(a.roots, b.roots, (a, b) => a.toString() === b.toString())
			&& objectsEqualWithUris(a.launch, b.launch)
			&& objectsEqualWithUris(a.presentation, b.presentation)
			&& objectsEqualWithUris(a.variableReplacement, b.variableReplacement)
			&& objectsEqual(a.environmentVariableExpansion, b.environmentVariableExpansion)
			&& objectsEqual(a.devMode, b.devMode)
			&& a.version === b.version
			&& a.gallery === b.gallery
			&& a.sandboxEnabled === b.sandboxEnabled;

	}
}


/**
 * Expands `${VAR}` and `${VAR:-default}` references with the Copilot CLI's rules, for
 * servers from a workspace `.mcp.json` or the Copilot user configuration. VS Code variables
 * with an argument, such as `${input:x}` or `${env:X}`, are not interpreted.
 */
export interface McpServerEnvironmentVariableExpansion {
	/**
	 * The unexpanded URL of an HTTP server. `URI` normalization would encode or
	 * lowercase references such as `${HOST}`, so the URL is expanded from this
	 * string rather than from the launch's `uri`.
	 */
	readonly url?: string;
}

export interface McpServerDefinitionVariableReplacement {
	section?: string; // e.g. 'mcp'
	folder?: IWorkspaceFolderData;
	target: ConfigurationTarget;
}

export namespace McpServerDefinitionVariableReplacement {
	export interface Serialized {
		target: ConfigurationTarget;
		section?: string;
		folder?: { name: string; index: number; uri: UriComponents };
	}

	export function toSerialized(def: McpServerDefinitionVariableReplacement): McpServerDefinitionVariableReplacement.Serialized {
		return def;
	}

	export function fromSerialized(def: McpServerDefinitionVariableReplacement.Serialized): McpServerDefinitionVariableReplacement {
		return {
			section: def.section,
			folder: def.folder ? { ...def.folder, uri: URI.revive(def.folder.uri) } : undefined,
			target: def.target,
		};
	}
}

/** An observable of the auto-starting servers. When 'starting' is empty, the operation is complete. */
export interface IAutostartResult {
	working: boolean;
	starting: McpDefinitionReference[];
	serversRequiringInteraction: Array<McpDefinitionReference & { errorMessage?: string }>;
}

export namespace IAutostartResult {
	export const Empty: IAutostartResult = { working: false, starting: [], serversRequiringInteraction: [] };
}

export interface IMcpService {
	_serviceBrand: undefined;
	readonly servers: IObservable<readonly IMcpServer[]>;

	/** The enablement model for MCP servers. */
	readonly enablementModel: IEnablementModel;

	/** Resets the cached tools. */
	resetCaches(): void;

	/** Resets trusted MCP servers. */
	resetTrust(): void;

	/** Set if there are extensions that register MCP servers that have never been activated. */
	readonly lazyCollectionState: IObservable<{ state: LazyCollectionState; collections: McpCollectionDefinition[] }>;

	/** Auto-starts pending servers based on user settings. */
	autostart(token?: CancellationToken): IObservable<IAutostartResult>;

	/** Cancels any current autostart @internal */
	cancelAutostart(): void;

	/** Activates extension-providing MCP servers that have not yet been discovered. */
	activateCollections(): Promise<void>;
}

export const enum LazyCollectionState {
	HasUnknown,
	LoadingUnknown,
	AllKnown,
}

export const IMcpService = createDecorator<IMcpService>('IMcpService');

export interface McpCollectionReference {
	id: string;
	label: string;
	order: number;
	presentation?: McpCollectionDefinition['presentation'];
}

export interface McpDefinitionReference {
	id: string;
	label: string;
}

export class McpStartServerInteraction {
	/** @internal */
	public readonly participants = new ObservableMap</* server definition ID */ string, { s: 'unknown' | 'resolved' } | { s: 'waiting'; definition: McpServerDefinition; collection: McpCollectionDefinition }>();
	choice?: Promise<string[] | undefined>;
}

export interface IMcpServerStartOpts {
	/**
	 * Automatically trust if changed. This should ONLY be set for afforances that
	 * ensure the user sees the config before it gets started (e.g. code lenses)
	 */
	autoTrustChanges?: boolean;
	/**
	 * When to trigger the trust prompt.
	 * - only-new: only prompt for servers that are not previously explicitly untrusted (default)
	 * - all-untrusted: prompt for all servers that are not trusted
	 * - never: don't prompt, fail silently when trying to start an untrusted server
	 */
	promptType?: 'only-new' | 'all-untrusted' | 'never';
	/** True if th servre should be launched with debugging. */
	debug?: boolean;
	/** Correlate multiple interactions such that any trust prompts are presented in combination. */
	interaction?: McpStartServerInteraction;
	/**
	 * If true, throw an error if any user interaction would be required during startup.
	 * This includes variable resolution, trust prompts, and authentication prompts.
	 */
	errorOnUserInteraction?: boolean;
}

export namespace McpServerTrust {
	export const enum Kind {
		/** The server is trusted */
		Trusted,
		/** The server is trusted as long as its nonce matches */
		TrustedOnNonce,
		/** The server trust was denied. */
		Untrusted,
		/** The server is not yet trusted or untrusted. */
		Unknown,
	}
}

export interface IMcpServer extends IDisposable {
	readonly collection: McpCollectionReference;
	readonly definition: McpDefinitionReference;
	readonly enablement: IObservable<ContributionEnablementState>;
	readonly connection: IObservable<IMcpServerConnection | undefined>;
	readonly connectionState: IObservable<McpConnectionState>;
	readonly serverMetadata: IObservable<{
		serverName?: string;
		serverInstructions?: string;
		icons: IMcpIcons;
	} | undefined>;

	/**
	 * Full definition as it exists in the MCP registry. Unlike the references
	 * in `collection` and `definition`, this may change over time.
	 */
	readDefinitions(): IObservable<{ server: McpServerDefinition | undefined; collection: McpCollectionDefinition | undefined }>;

	showOutput(preserveFocus?: boolean): Promise<void>;
	/**
	 * Starts the server and returns its resulting state. One of:
	 * - Running, if all good
	 * - Error, if the server failed to start
	 * - Stopped, if the server was disposed or the user cancelled the launch
	 */
	start(opts?: IMcpServerStartOpts): Promise<McpConnectionState>;
	stop(): Promise<void>;

	readonly cacheState: IObservable<McpServerCacheState>;
	readonly tools: IObservable<readonly IMcpTool[]>;
	readonly prompts: IObservable<readonly IMcpPrompt[]>;
	readonly capabilities: IObservable<McpCapability | undefined>;

	/**
	 * Lists all resources on the server.
	 */
	resources(token?: CancellationToken): AsyncIterable<IMcpResource[]>;

	/**
	 * List resource templates on the server.
	 */
	resourceTemplates(token?: CancellationToken): Promise<IMcpResourceTemplate[]>;

	/**
	 * Lists the skills of a server that declares the Skills extension
	 * (`skills/list`); empty for other servers. Entries that are invalid are
	 * left out. No skill file is read: a skill is fetched when it is loaded.
	 */
	skills(token?: CancellationToken): Promise<IMcpSkill[]>;

	/**
	 * Fetches the current entry of a skill given only its `SKILL.md` URI,
	 * listed or not (`skills/get`). No skill file is read.
	 */
	getSkill(uri: string, token?: CancellationToken): Promise<IMcpSkill>;

	/**
	 * Loads a skill given only its `SKILL.md` URI, listed or not: fetches its
	 * current entry (`skills/get`), then reads and verifies the `SKILL.md`.
	 */
	loadSkill(uri: string, token?: CancellationToken): Promise<McpLoadedSkill>;
}

/** A skill a server lists (Skills extension, SEP-2640). Its identity is the server and the `SKILL.md` URI, never the name. */
export interface IMcpSkill {
	readonly server: IMcpServer;
	/** The validated entry the skill is loaded from. */
	readonly entry: McpSkills.Skill;
	/** The URI of the skill's `SKILL.md` on the server. */
	readonly uri: string;
	readonly name: string;
	/** The name, qualified by the skill path when several entries of the listing share it. */
	readonly displayName: string;
	readonly description: string;
	/** Reads and verifies the skill's `SKILL.md` against this entry. */
	load(token?: CancellationToken): Promise<McpLoadedSkill>;
}

/**
 * A representation of an MCP resource. The `uri` is namespaced to VS Code and
 * can be used in filesystem APIs.
 */
export interface IMcpResource {
	/** Identifier for the file in VS Code and operable with filesystem API */
	readonly uri: URI;
	/** Identifier of the file as given from the MCP server. */
	readonly mcpUri: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly sizeInBytes?: number;
	readonly icons: IMcpIcons;
}

export interface IMcpResourceTemplate {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly template: UriTemplate;
	readonly icons: IMcpIcons;

	/** Gets string completions for the given template part. */
	complete(templatePart: string, prefix: string, alreadyResolved: Record<string, string | string[]>, token: CancellationToken): Promise<string[]>;

	/** Gets the resolved URI from template parts. */
	resolveURI(vars: Record<string, unknown>): URI;
}

export const isMcpResourceTemplate = (obj: IMcpResource | IMcpResourceTemplate): obj is IMcpResourceTemplate => {
	return (obj as IMcpResourceTemplate).template !== undefined;
};
export const isMcpResource = (obj: IMcpResource | IMcpResourceTemplate): obj is IMcpResource => {
	return (obj as IMcpResource).mcpUri !== undefined;
};

export const enum McpServerCacheState {
	/** Tools have not been read before */
	Unknown,
	/** Tools were read from the cache */
	Cached,
	/** Tools were read from the cache or live, but they may be outdated. */
	Outdated,
	/** Tools are refreshing for the first time */
	RefreshingFromUnknown,
	/** Tools are refreshing and the current tools are cached */
	RefreshingFromCached,
	/** Tool state is live, server is connected */
	Live,
}

export interface IMcpPrompt {
	readonly id: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly arguments: readonly MCPLegacy.PromptArgument[];

	/** Gets string completions for the given prompt part. */
	complete(argument: string, prefix: string, alreadyResolved: Record<string, string>, token: CancellationToken): Promise<string[]>;

	resolve(args: Record<string, string | undefined>, token?: CancellationToken): Promise<IMcpPromptMessage[]>;
}

export const mcpPromptReplaceSpecialChars = (s: string) => s.replace(/[^a-z0-9_.-]/gi, '_');

export const mcpPromptPrefix = (definition: McpDefinitionReference) =>
	`/mcp.` + mcpPromptReplaceSpecialChars(definition.label);

export interface IMcpPromptMessage extends MCPLegacy.PromptMessage { }

export interface IMcpToolCallContext {
	chatSessionResource: URI | undefined;
	chatRequestId?: string;
	/**
	 * Optional W3C trace context `traceparent` value to forward to the MCP server
	 * via `_meta.traceparent` on the JSON-RPC `tools/call` request (MCP SEP-414).
	 */
	traceparent?: string;
	/** Optional W3C trace context `tracestate` value paired with {@link traceparent}. */
	tracestate?: string;
}

/**
 * Visibility of an MCP tool, based on the MCP Apps `_meta.ui.visibility` field.
 * @see https://github.com/anthropics/mcp/blob/main/apps.md
 */
export const enum McpToolVisibility {
	/** Tool is visible to and callable by the language model */
	Model = 1 << 0,
	/** Tool is callable by the MCP App UI */
	App = 1 << 1,
}

/**
 * Serializable data for MCP App UI rendering.
 * This contains all the information needed to render an MCP App webview.
 *
 * The transport for the App's sub-RPCs (`tools/call`, `resources/read`,
 * `sampling/createMessage`, …) is determined by the discriminator:
 *
 * - `local`: resolves the MCP server via {@link IMcpService} from
 *   `serverDefinitionId` + `collectionId`. Used for locally-configured
 *   MCP servers.
 * - `agentHost`: resolves `connectionAuthority` to the owning Agent Host
 *   connection and routes on the AHP `mcp://` side `channel`. Used for MCP
 *   servers owned by an agent host.
 */
export type IMcpToolCallUIData =
	| {
		readonly kind: 'local';
		/** URI of the UI resource for rendering (e.g., "ui://weather-server/dashboard") */
		readonly resourceUri: string;
		/** Reference to the server definition for reconnection */
		readonly serverDefinitionId: string;
		/** Reference to the collection containing the server */
		readonly collectionId: string;
	}
	| {
		readonly kind: 'agentHost';
		/** URI of the UI resource for rendering (e.g., "ui://weather-server/dashboard") */
		readonly resourceUri: string;
		/** Sanitized connection identifier used to route App sub-RPCs. */
		readonly connectionAuthority: string;
		/** AHP `mcp://` channel URI for the originating server. */
		readonly channel: string;
		/** Stable identifier for the originating server (used as webview origin key). */
		readonly serverId: string;
	};

export interface IMcpTool {

	readonly id: string;
	/** Name for #referencing in chat */
	readonly referenceName: string;
	readonly icons: IMcpIcons;
	readonly definition: MCPLegacy.Tool;
	/** Visibility of the tool (Model, App, or both). Defaults to Model | App. */
	readonly visibility: McpToolVisibility;
	/** Optional UI resource URI for MCP App rendering */
	readonly uiResourceUri?: string;

	/**
	 * Calls a tool
	 * @throws {@link MpcResponseError} if the tool fails to execute
	 * @throws {@link McpConnectionFailedError} if the connection to the server fails
	 */
	call(params: Record<string, unknown>, context?: IMcpToolCallContext, token?: CancellationToken): Promise<MCPLegacy.CallToolResult>;

	/**
	 * Identical to {@link call}, but reports progress.
	 */
	callWithProgress(params: Record<string, unknown>, progress: ToolProgress, context?: IMcpToolCallContext, token?: CancellationToken): Promise<MCPLegacy.CallToolResult>;
}

export const enum McpServerTransportType {
	/** A command-line MCP server communicating over standard in/out */
	Stdio = 1 << 0,
	/** An MCP server that uses Server-Sent Events */
	HTTP = 1 << 1,
	/** An MCP server reached over gRPC (HTTP/2), through the JSON-RPC tunnel or the typed service */
	Grpc = 1 << 2,
}

/**
 * MCP server launched on the command line which communicated over stdio.
 * https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#stdio
 */
export interface McpServerTransportStdio {
	readonly type: McpServerTransportType.Stdio;
	readonly cwd: string | undefined;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Record<string, string | number | null>;
	readonly envFile: string | undefined;
	readonly sandbox: IMcpSandboxConfiguration | undefined;
}

export interface McpServerTransportHTTPAuthentication {
	/**
	 * Authentication provider ID to use to get a session for the initial MCP server connection.
	 */
	readonly providerId: string;
	/**
	 * Scopes to use to get a session for the initial MCP server connection.
	 */
	readonly scopes: string[];
}

export interface McpServerTransportHTTPOAuth {
	readonly clientId?: string;
	/**
	 * (Preview) When true, the MCP server uses enterprise-managed authentication via the configured
	 * SSO issuer (see `mcp.enterpriseManagedAuth.idp`). Tokens are obtained through OAuth Identity
	 * Assertion Authorization Grant (ID-JAG) so that, after a one-time sign-in, subsequent enterprise-managed
	 * servers connect silently.
	 */
	readonly enterpriseManaged?: boolean;
	/**
	 * How VS Code obtains tokens: a user signs in (`authorization_code`, the default), or VS Code
	 * authenticates as a machine client, with its pre-registered credentials (`client_credentials`)
	 * or a workload identity JWT (`workload_identity`).
	 */
	readonly grant?: 'authorization_code' | 'client_credentials' | 'workload_identity';
	/** For `client_credentials`: a PKCS #8 PEM private key file for `private_key_jwt` client authentication. */
	readonly privateKeyFile?: string;
	/** The JWS algorithm of {@link privateKeyFile}'s key; `ES256` by default. */
	readonly signingAlgorithm?: string;
	/** The key ID (`kid`) the authorization server knows {@link privateKeyFile}'s key by. */
	readonly keyId?: string;
	/** The `aud` of the client assertion: the issuer identifier (the default) or the token endpoint URL. */
	readonly clientAssertionAudience?: 'issuer' | 'token_endpoint';
	/** For `workload_identity`: the file the workload platform writes the workload JWT to; it is read for each token request. */
	readonly workloadIdentityTokenFile?: string;
	/**
	 * Whether VS Code requests DPoP-bound tokens (RFC 9449) from an authorization server that supports
	 * them: `true` always, `false` never; by default only when the MCP server requires them.
	 */
	readonly dpop?: boolean;
}

/**
 * Returns the secret-storage key under which an MCP server OAuth client secret is stored.
 * Scoped by the MCP server URL AND the OAuth client_id so that two servers sharing the same
 * client_id string (e.g. against different authorization servers) cannot clobber each other's
 * secret, and so the key is stable across mcp.json configurations that happen to share a label
 * (e.g. user mcp.json vs. workspace mcp.json). Set by the "Set Client Secret" code lens in
 * mcp.json and read at authentication time so that client secrets are never stored in
 * plain-text config files.
 */
export function mcpOAuthClientSecretStorageKey(mcpServerUrl: string, clientId: string): string {
	return `${mcpOAuthClientSecretStorageKeyPrefix}${mcpServerUrl}:${clientId}`;
}

const mcpOAuthClientSecretStorageKeyPrefix = 'mcp.oauth.clientSecret:';

/**
 * Whether a secret-storage key is one under which {@link mcpOAuthClientSecretStorageKey} stores an MCP
 * server OAuth client secret.
 */
export function isMcpOAuthClientSecretStorageKey(key: string): boolean {
	return key.startsWith(mcpOAuthClientSecretStorageKeyPrefix);
}

/**
 * MCP server launched on the command line which communicated over SSE or Streamable HTTP.
 * https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#http-with-sse
 * https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
 */
export interface McpServerTransportHTTP {
	readonly type: McpServerTransportType.HTTP;
	readonly transport?: 'sse' | 'streamable-http';
	readonly uri: URI;
	/** Additional headers are restricted to the configured URI's origin. */
	readonly headers: [string, string][];
	readonly oauth?: McpServerTransportHTTPOAuth;
	/**
	 * @deprecated this was originally used for step-auth auth but a different approach was used instead
	 * so it's effectively dead code.
	 */
	readonly authentication?: McpServerTransportHTTPAuthentication;
}

/**
 * MCP server reached over gRPC on a `grpc://` (plaintext HTTP/2) or `grpcs://`
 * (TLS) endpoint. The {@link binding} selects the zig-sdk JSON-RPC tunnel
 * (`/mcp.zig.transport.v1.Mcp/Call`), Google's typed `model_context_protocol.Mcp`
 * service, or `auto` (the default), which is the tunnel: only `typed` speaks
 * the typed service.
 */
export interface McpServerTransportGrpc {
	readonly type: McpServerTransportType.Grpc;
	readonly uri: URI;
	/** Additional metadata sent with every call, restricted to the configured URI's authority. */
	readonly headers: [string, string][];
	readonly tls?: IMcpGrpcServerTlsConfiguration;
	readonly binding?: McpGrpcBinding;
	/**
	 * The deadline in milliseconds of every call except the `subscriptions/listen`
	 * stream, which never has one. Unset (or not a positive number): 60 seconds for
	 * `server/discover` and the list, read, prompt and completion requests, and no
	 * deadline for `tools/call`, the retries of `input_required` rounds and other requests.
	 */
	readonly deadlineMs?: number;
	/**
	 * Interval in milliseconds between HTTP/2 keep-alive pings, sent only while a
	 * call is open, raised to at least 300000 (5 minutes) and doubled for the
	 * next connection after a `too_many_pings`; 0 sends none. Unset (or not a
	 * number of milliseconds): a ping every 310000 ms only while a
	 * `subscriptions/listen` stream is open.
	 */
	readonly keepAliveMs?: number;
	readonly oauth?: McpServerTransportHTTPOAuth;
}

export type McpServerLaunch =
	| McpServerTransportStdio
	| McpServerTransportHTTP
	| McpServerTransportGrpc;

export namespace McpServerLaunch {
	export type Serialized =
		| { type: McpServerTransportType.HTTP; transport?: 'sse' | 'streamable-http'; uri: UriComponents; headers: [string, string][]; oauth?: McpServerTransportHTTPOAuth; authentication?: McpServerTransportHTTPAuthentication }
		| { type: McpServerTransportType.Grpc; uri: UriComponents; headers: [string, string][]; tls?: IMcpGrpcServerTlsConfiguration; binding?: McpGrpcBinding; deadlineMs?: number; keepAliveMs?: number; oauth?: McpServerTransportHTTPOAuth }
		| { type: McpServerTransportType.Stdio; cwd: string | undefined; command: string; args: readonly string[]; env: Record<string, string | number | null>; envFile: string | undefined; sandbox: IMcpSandboxConfiguration | undefined };

	export function toSerialized(launch: McpServerLaunch): McpServerLaunch.Serialized {
		return launch;
	}

	/** Whether a URI scheme is one a gRPC launch accepts: `grpc` (plaintext HTTP/2) or `grpcs` (TLS). */
	export function isGrpcScheme(scheme: string): boolean {
		return scheme === 'grpc' || scheme === 'grpcs';
	}

	/**
	 * Validates that {@link uri} is a `grpc://` or `grpcs://` endpoint and returns it,
	 * throwing a user-facing error otherwise.
	 */
	export function validateGrpcUri(uri: URI): URI {
		if (!isGrpcScheme(uri.scheme)) {
			throw new Error(localize('mcp.grpc.invalidScheme', "The URL of a gRPC MCP server must start with 'grpc://' or 'grpcs://', but was '{0}'.", uri.toString(true)));
		}
		return uri;
	}

	/**
	 * Whether a network resource (an icon, an `http:` link) at {@link authority} belongs to
	 * the server of {@link launch}. HTTP servers match by authority (host and port). gRPC
	 * servers match by host name, since their HTTP/2 port does not serve web resources.
	 * Stdio servers have no network authority and never match.
	 */
	export function isServerNetworkAuthority(launch: McpServerLaunch, authority: string): boolean {
		switch (launch.type) {
			case McpServerTransportType.HTTP:
				return launch.uri.authority.toLowerCase() === authority.toLowerCase();
			case McpServerTransportType.Grpc:
				return authorityHostname(launch.uri.authority) === authorityHostname(authority);
			default:
				return false;
		}
	}

	/** The host name of a URI authority, without user info or port; IPv6 literals keep their brackets. */
	function authorityHostname(authority: string): string {
		const host = authority.slice(authority.lastIndexOf('@') + 1);
		const end = host.startsWith('[') ? host.indexOf(']') + 1 : host.lastIndexOf(':');
		return (end > 0 ? host.slice(0, end) : host).toLowerCase();
	}

	export function fromSerialized(launch: McpServerLaunch.Serialized): McpServerLaunch {
		switch (launch.type) {
			case McpServerTransportType.HTTP:
				return { type: launch.type, transport: launch.transport, uri: URI.revive(launch.uri), headers: launch.headers, oauth: launch.oauth, authentication: launch.authentication };
			case McpServerTransportType.Grpc:
				return {
					type: launch.type,
					uri: validateGrpcUri(URI.revive(launch.uri)),
					headers: launch.headers,
					tls: launch.tls,
					binding: launch.binding,
					deadlineMs: launch.deadlineMs,
					keepAliveMs: launch.keepAliveMs,
					oauth: launch.oauth,
				};
			case McpServerTransportType.Stdio:
				return {
					type: launch.type,
					cwd: launch.cwd,
					command: launch.command,
					args: launch.args,
					env: launch.env,
					envFile: launch.envFile,
					sandbox: launch.sandbox
				};
		}
	}

	/** Converts an MCP server configuration into the shared launch representation. */
	export function fromServerConfiguration(configuration: IMcpServerConfiguration, sandbox?: IMcpSandboxConfiguration): McpServerLaunch | undefined {
		if (configuration.type === McpServerType.LOCAL) {
			return {
				type: McpServerTransportType.Stdio,
				command: configuration.command,
				args: configuration.args ? [...configuration.args] : [],
				env: configuration.env ? { ...configuration.env } : {},
				envFile: configuration.envFile,
				cwd: configuration.cwd,
				sandbox: mergeSandboxConfiguration(sandbox, configuration.sandbox),
			};
		}

		if (configuration.type === McpServerType.GRPC) {
			// An invalid URL (including a non-gRPC scheme) makes the configuration unusable, which callers
			// report like any other invalid configuration rather than failing the whole discovery pass.
			try {
				return {
					type: McpServerTransportType.Grpc,
					uri: validateGrpcUri(URI.parse(configuration.url)),
					headers: Object.entries(configuration.headers ?? {}),
					tls: configuration.tls,
					binding: configuration.binding,
					deadlineMs: configuration.deadlineMs,
					keepAliveMs: configuration.keepAliveMs,
					oauth: configuration.oauth,
				};
			} catch {
				return undefined;
			}
		}

		try {
			return {
				type: McpServerTransportType.HTTP,
				...(configuration.transport === 'sse' ? { transport: 'sse' as const } : {}),
				uri: URI.parse(configuration.url),
				headers: Object.entries(configuration.headers ?? {}),
				oauth: configuration.oauth,
			};
		} catch {
			return undefined;
		}
	}

	export async function hash(launch: McpServerLaunch): Promise<string> {
		const nonce = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(launch)));
		return encodeHex(VSBuffer.wrap(new Uint8Array(nonce)));
	}

	function mergeSandboxConfiguration(root: IMcpSandboxConfiguration | undefined, server: IMcpSandboxConfiguration | undefined): IMcpSandboxConfiguration | undefined {
		if (!root) {
			return server;
		}
		return {
			network: {
				allowedDomains: distinct(server?.network?.allowedDomains ?? []),
				deniedDomains: distinct([...(root.network?.deniedDomains ?? []), ...(server?.network?.deniedDomains ?? [])]),
			},
			filesystem: {
				allowWrite: distinct(server?.filesystem?.allowWrite ?? []),
				denyRead: distinct([...(root.filesystem?.denyRead ?? []), ...(server?.filesystem?.denyRead ?? [])]),
				denyWrite: distinct([...(root.filesystem?.denyWrite ?? []), ...(server?.filesystem?.denyWrite ?? [])]),
			},
		};
	}
}

/**
 * An instance that manages a connection to an MCP server. It can be started,
 * stopped, and restarted. Once started and in a running state, it will
 * eventually build a {@link IMcpServerConnection.handler}.
 */
export interface IMcpPotentialSandboxBlock {
	readonly kind: 'network' | 'filesystem';
	readonly message: string;
	readonly host?: string;
	readonly path?: string;
}

export interface IMcpServerConnection extends IDisposable {
	readonly definition: McpServerDefinition;
	readonly state: IObservable<McpConnectionState>;
	readonly handler: IObservable<McpServerRequestHandler | undefined>;
	readonly onPotentialSandboxBlock: Event<IMcpPotentialSandboxBlock>;

	/**
	 * Resolved launch definition. Might not match the `definition.launch` due to
	 * resolution logic in extension-provided MCPs.
	 */
	readonly launchDefinition: McpServerLaunch;

	/**
	 * Starts the server if it's stopped. Returns a promise that resolves once
	 * server exits a 'starting' state.
	 */
	start(methods: IMcpClientMethods, hints?: IMcpNegotiationHints): Promise<McpConnectionState>;

	/**
	 * Stops the server.
	 */
	stop(): Promise<void>;
}

/** Client methods whose implementations are passed through the server connection. */
export interface IMcpClientMethods {
	/** Handler for `sampling/createMessage` (a server request in the legacy era, an input request in the modern era). */
	createMessageRequestHandler?(req: MCPLegacy.CreateMessageRequest['params'], token?: CancellationToken, context?: IMcpToolCallContext): Promise<MCPLegacy.CreateMessageResult>;
	/** Handler for `elicitation/create` (a server request in the legacy era, an input request in the modern era). */
	elicitationRequestHandler?(req: MCPLegacy.ElicitRequest['params'], token?: CancellationToken, context?: IMcpToolCallContext, options?: IMcpElicitOptions): Promise<MCPLegacy.ElicitResult>;
}

/**
 * Hints the protocol engine uses when it connects. Without hints it probes:
 * `server/discover` first, then the legacy `initialize` handshake.
 */
export interface IMcpNegotiationHints {
	/** The era the server spoke last time (from the metadata cache). Skips the probe; a failure re-probes. */
	readonly era?: McpProtocolEra;
	/** The revision to speak (from the cache or a configured pin). */
	readonly protocolVersion?: string;
	/**
	 * Never fall back to the other era. Used by the conformance client, which
	 * must speak exactly the revision the suite requested.
	 */
	readonly strict?: boolean;
}

/**
 * Transport-level metadata the protocol engine attaches to every message it
 * sends. Transports that need it (Streamable HTTP, gRPC) derive their wire
 * behaviour from it: the protocol era from `protocolVersion`, the mirrored
 * HTTP headers, deadlines. A message sent without an envelope is treated as
 * legacy (2025-11-25) traffic and goes on the wire exactly as before.
 */
export interface IMcpMessageEnvelope {
	readonly kind: 'request' | 'notification' | 'listen';
	/** The JSON-RPC id for requests and listen streams. */
	readonly requestId?: JsonRpcId;
	/** The protocol revision the message is sent under. */
	readonly protocolVersion: string;
	readonly method: string;
	/** Mirrored `Mcp-*` headers computed by the engine (modern HTTP and gRPC only). */
	readonly headers?: Readonly<Record<string, string>>;
	/** A per-request deadline for transports that support one (gRPC). */
	readonly deadlineMs?: number;
}

/**
 * Reported by a transport when a request can no longer be answered by the
 * peer: the engine fails the pending request locally. Transports never
 * synthesize JSON-RPC error messages for these conditions.
 */
export interface IMcpRequestAbort {
	readonly requestId: JsonRpcId;
	readonly reason:
	/** A modern probe hit a legacy server (recognized by its HTTP status/body). */
	| 'legacy-probe'
	/** The HTTP response status does not carry a JSON-RPC message. */
	| 'http-status'
	/** The response stream ended before the response arrived. */
	| 'stream-closed'
	/** The request could not be sent or the connection failed. */
	| 'transport-error'
	/** A gRPC status-only failure (no `mcp-error-*` trailers). */
	| 'grpc-status'
	/** The per-request deadline elapsed. */
	| 'deadline'
	/** The message cannot be expressed on this transport. */
	| 'unexpressible';
	readonly message?: string;
	readonly httpStatus?: number;
	readonly grpcStatus?: number;
}

/**
 * McpConnectionState is the state of the underlying connection and is
 * communicated e.g. from the extension host to the renderer.
 */
export namespace McpConnectionState {
	export const enum Kind {
		Stopped,
		Starting,
		Running,
		Error,
	}

	export const toString = (s: McpConnectionState): string => {
		switch (s.state) {
			case Kind.Stopped:
				return localize('mcpstate.stopped', 'Stopped');
			case Kind.Starting:
				return localize('mcpstate.starting', 'Starting');
			case Kind.Running:
				return localize('mcpstate.running', 'Running');
			case Kind.Error:
				return localize('mcpstate.error', 'Error {0}', s.message);
			default:
				assertNever(s);
		}
	};

	export const toKindString = (s: McpConnectionState.Kind): string => {
		switch (s) {
			case Kind.Stopped:
				return 'stopped';
			case Kind.Starting:
				return 'starting';
			case Kind.Running:
				return 'running';
			case Kind.Error:
				return 'error';
			default:
				assertNever(s);
		}
	};

	/** Returns if the MCP state is one where starting a new server is valid */
	export const canBeStarted = (s: Kind) => s === Kind.Error || s === Kind.Stopped;

	/** Gets whether the state is a running state. */
	export const isRunning = (s: McpConnectionState) => !canBeStarted(s.state);

	export interface Stopped {
		readonly state: Kind.Stopped;
		readonly reason?: 'needs-user-interaction';
	}

	export interface Starting {
		readonly state: Kind.Starting;
	}

	export interface Running {
		readonly state: Kind.Running;
	}

	export interface Error {
		readonly state: Kind.Error;
		readonly code?: string;
		readonly shouldRetry?: boolean;
		readonly message: string;
	}
}

export type McpConnectionState =
	| McpConnectionState.Stopped
	| McpConnectionState.Starting
	| McpConnectionState.Running
	| McpConnectionState.Error;

export class MpcResponseError extends Error {
	constructor(message: string, public readonly code: number, public readonly data: unknown) {
		super(`MPC ${code}: ${message}`);
	}
}

export type McpClientErrorReason =
	/** The stdio server answered neither `server/discover` nor `initialize` within the probe timeout. */
	| 'probe-timeout'
	/** The server advertises no revision the client speaks. */
	| 'no-supported-version'
	/** A result carried an unknown `resultType`. */
	| 'invalid-result-type'
	/** The server kept asking for input beyond the round limit. */
	| 'too-many-rounds'
	/** The server asked for an input kind the client did not declare. */
	| 'undeclared-input-request'
	/** An `input_required` result was malformed. */
	| 'invalid-input-request'
	/** The user's elicitation answer does not match the requested schema. */
	| 'invalid-elicit-content'
	/** The server requires client capabilities the client did not declare (-32021); the message names them. */
	| 'missing-capability'
	/** The transport reported that the request can no longer be answered. */
	| 'request-aborted';

/** A failure of the client protocol engine itself (as opposed to an error the server returned). */
export class McpClientError extends Error {
	constructor(public readonly reason: McpClientErrorReason, message: string, public readonly detail?: unknown) {
		super(message);
		this.name = 'McpClientError';
	}
}

export class McpConnectionFailedError extends Error { }

export class UserInteractionRequiredError extends Error {
	private static readonly prefix = 'User interaction required: ';

	public static is(error: Error): boolean {
		return error.message.startsWith(this.prefix);
	}

	constructor(public readonly reason: string) {
		super(`${UserInteractionRequiredError.prefix}${reason}`);
	}
}

export interface IMcpConfigPath {
	id: string;
	collectionId?: string;
	format?: McpResourceFormat;
	provenance?: McpCollectionProvenance;
	key: 'userLocalValue' | 'userRemoteValue' | 'workspaceValue' | 'workspaceFolderValue';
	label: string;
	scope: StorageScope;
	target: ConfigurationTarget;
	order: number;
	remoteAuthority?: string;
	uri: URI | undefined;
	section?: string[];
	workspaceFolder?: IWorkspaceFolder;
}

export interface IMcpServerContainer extends IDisposable {
	mcpServer: IWorkbenchMcpServer | null;
	update(): void;
}

export interface IMcpServerEditorOptions extends IEditorOptions {
	tab?: McpServerEditorTab;
	sideByside?: boolean;
}

export const enum McpServerEnablementState {
	Disabled,
	DisabledByAccess,
	DisabledProfile,
	DisabledWorkspace,
	Enabled,
}

export const enum McpServerInstallState {
	Installing,
	Installed,
	Uninstalling,
	Uninstalled
}

export const enum McpServerEditorTab {
	Readme = 'readme',
	Manifest = 'manifest',
	Configuration = 'configuration',
}

export type McpServerEnablementStatus = {
	readonly state: McpServerEnablementState;
	readonly message?: {
		readonly severity: Severity;
		readonly text: IMarkdownString;
	};
};

export interface IWorkbenchMcpServer {
	readonly gallery: IGalleryMcpServer | undefined;
	readonly local: IWorkbenchLocalMcpServer | undefined;
	readonly installable: IInstallableMcpServer | undefined;
	readonly installState: McpServerInstallState;
	readonly runtimeStatus: McpServerEnablementStatus | undefined;
	readonly id: string;
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly icon?: {
		readonly dark: string;
		readonly light: string;
	};
	readonly codicon?: string;
	readonly publisherUrl?: string;
	readonly publisherDisplayName?: string;
	readonly starsCount?: number;
	readonly license?: string;
	readonly repository?: string;
	readonly config?: IMcpServerConfiguration | undefined;
	readonly readmeUrl?: URI;
	getReadme(token: CancellationToken): Promise<string>;
	getManifest(token: CancellationToken): Promise<IGalleryMcpServerConfiguration>;
}

export const IMcpWorkbenchService = createDecorator<IMcpWorkbenchService>('IMcpWorkbenchService');

/** A server configuration read from its file, together with how to write changes back. */
export interface IEditableMcpServerConfiguration {
	readonly config: IMcpServerConfiguration;
	/** Format of the file, which limits the properties that can be stored. */
	readonly format: McpResourceFormat;
	/** Writes {@link config} over {@link previous}, the configuration that was edited. */
	save(previous: IMcpServerConfiguration, config: IMcpServerConfiguration): Promise<void>;
}
export interface IMcpWorkbenchService {
	readonly _serviceBrand: undefined;
	readonly onChange: Event<IWorkbenchMcpServer | undefined>;
	readonly onReset: Event<void>;
	readonly local: readonly IWorkbenchMcpServer[];
	/** Resolves after the initial installed MCP server query attempt completes. Never rejects. */
	readonly whenInitialLocalMcpServersLoaded: Promise<void>;
	/** Returns enabled VS Code-format servers after name precedence; root files are discovered independently. */
	getEnabledLocalMcpServers(): IWorkbenchLocalMcpServer[];
	queryLocal(): Promise<IWorkbenchMcpServer[]>;
	queryGallery(options?: IQueryOptions, token?: CancellationToken, manifest?: IMcpGalleryManifest): Promise<IIterativePager<IWorkbenchMcpServer>>;
	getMcpServerFromGallery(name: string, manifest?: IMcpGalleryManifest): Promise<IWorkbenchMcpServer | undefined>;
	canInstall(mcpServer: IWorkbenchMcpServer): true | IMarkdownString;
	install(server: IWorkbenchMcpServer, installOptions?: IWorkbencMcpServerInstallOptions): Promise<IWorkbenchMcpServer>;
	uninstall(mcpServer: IWorkbenchMcpServer): Promise<void>;
	/**
	 * Resolves the configuration of server {@link name} for editing when {@link source} is a file
	 * shared with other MCP clients: a workspace root `.mcp.json` or the Copilot CLI's global
	 * `mcp-config.json`. Returns undefined for any other source, including VS Code's own `mcp.json`.
	 */
	resolveEditableMcpServerConfiguration(source: URI, name: string): Promise<IEditableMcpServerConfiguration | undefined>;
	getMcpConfigPath(arg: IWorkbenchLocalMcpServer): IMcpConfigPath | undefined;
	getMcpConfigPath(arg: URI): Promise<IMcpConfigPath | undefined>;
	openSearch(searchValue: string, preserveFocus?: boolean): Promise<void>;
	open(extension: IWorkbenchMcpServer | string, options?: IMcpServerEditorOptions): Promise<void>;
}

export class McpServerContainers extends Disposable {
	constructor(
		private readonly containers: IMcpServerContainer[],
		@IMcpWorkbenchService mcpWorkbenchService: IMcpWorkbenchService
	) {
		super();
		this._register(mcpWorkbenchService.onChange(this.update, this));
	}

	set mcpServer(extension: IWorkbenchMcpServer | null) {
		this.containers.forEach(c => c.mcpServer = extension);
	}

	update(server: IWorkbenchMcpServer | undefined): void {
		for (const container of this.containers) {
			if (server && container.mcpServer) {
				if (server.id === container.mcpServer.id) {
					container.mcpServer = server;
				}
			} else {
				container.update();
			}
		}
	}
}

export const McpServersGalleryStatusContext = new RawContextKey<string>('mcpServersGalleryStatus', McpGalleryManifestStatus.Unavailable);
export const HasInstalledMcpServersContext = new RawContextKey<boolean>('hasInstalledMcpServers', true);
export const InstalledMcpServersViewId = 'workbench.views.mcp.installed';

export namespace McpResourceURI {
	export const scheme = 'mcp-resource';

	// Random placeholder for empty authorities, otherwise they're represente as
	// `scheme//path/here` in the URI which would get normalized to `scheme/path/here`.
	const emptyAuthorityPlaceholder = 'dylo78gyp'; // chosen by a fair dice roll. Guaranteed to be random.

	export function fromServer(def: McpDefinitionReference, resourceURI: URI | string): URI {
		if (typeof resourceURI === 'string') {
			resourceURI = URI.parse(resourceURI);
		}
		return resourceURI.with({
			scheme,
			authority: encodeHex(VSBuffer.fromString(def.id)),
			path: ['', resourceURI.scheme, resourceURI.authority || emptyAuthorityPlaceholder].join('/') + resourceURI.path,
		});
	}

	export function toServer(uri: URI | string): { definitionId: string; resourceURL: URL } {
		if (typeof uri === 'string') {
			uri = URI.parse(uri);
		}
		if (uri.scheme !== scheme) {
			throw new Error(`Invalid MCP resource URI: ${uri.toString()}`);
		}
		const parts = uri.path.split('/');
		if (parts.length < 3) {
			throw new Error(`Invalid MCP resource URI: ${uri.toString()}`);
		}
		const [, serverScheme, authority, ...path] = parts;

		// URI cannot correctly stringify empty authorities (#250905) so we use URL instead to construct
		const url = new URL(`${serverScheme}://${authority.toLowerCase() === emptyAuthorityPlaceholder ? '' : authority}`);
		url.pathname = path.length ? ('/' + path.join('/')) : '';
		url.search = uri.query;
		url.hash = uri.fragment;

		return {
			definitionId: decodeHex(uri.authority).toString(),
			resourceURL: url,
		};
	}

}

/** Warning: this enum is cached in `mcpServer.ts` and all changes MUST only be additive. */
export const enum McpCapability {
	Logging = 1 << 0,
	Completions = 1 << 1,
	Prompts = 1 << 2,
	PromptsListChanged = 1 << 3,
	Resources = 1 << 4,
	ResourcesSubscribe = 1 << 5,
	ResourcesListChanged = 1 << 6,
	Tools = 1 << 7,
	ToolsListChanged = 1 << 8,
	/** The server speaks a stateless (2026-07-28 or later) revision. */
	StatelessProtocol = 1 << 9,
	/** The server declares the Skills extension (`io.modelcontextprotocol/skills`, SEP-2640). */
	Skills = 1 << 10,
	/** The server declares the Skills extension with `directoryRead: true` (`resources/directory/read`). */
	SkillsDirectoryRead = 1 << 11,
}

export interface ISamplingOptions {
	server: IMcpServer;
	isDuringToolCall: boolean;
	params: MCPLegacy.CreateMessageRequest['params'];
}

export interface ISamplingResult {
	sample: MCPLegacy.CreateMessageResult;
}

export interface IMcpSamplingService {
	_serviceBrand: undefined;

	sample(opts: ISamplingOptions, token?: CancellationToken): Promise<ISamplingResult>;

	/** Whether MCP sampling logs are available for this server */
	hasLogs(server: IMcpServer): boolean;
	/** Gets a text report of the MCP server's sampling usage */
	getLogText(server: IMcpServer): string;

	getConfig(server: IMcpServer): IMcpServerSamplingConfiguration;
	updateConfig(server: IMcpServer, mutate: (r: IMcpServerSamplingConfiguration) => unknown): Promise<IMcpServerSamplingConfiguration>;
}

export const IMcpSamplingService = createDecorator<IMcpSamplingService>('IMcpServerSampling');

export class McpError extends Error {
	public static methodNotFound(method: string) {
		return new McpError(MCPLegacy.METHOD_NOT_FOUND, `Method not found: ${method}`);
	}

	public static notAllowed() {
		return new McpError(-32000, 'The user has denied permission to call this method.');
	}

	public static unknown(e: Error) {
		const mcpError = new McpError(MCPLegacy.INTERNAL_ERROR, `Unknown error: ${e.stack}`);
		mcpError.cause = e;
		return mcpError;
	}

	constructor(
		public readonly code: number,
		message: string,
		public readonly data?: unknown
	) {
		super(message);
	}
}

export const enum McpToolName {
	Prefix = 'mcp_',
	MaxPrefixLen = 18,
	MaxLength = 64,
}


export interface IMcpElicitationService {
	_serviceBrand: undefined;

	/**
	 * Elicits a response from the user. The `context` is optional and can be used
	 * to provide additional information about the request.
	 *
	 * @param context Context for the elicitation, e.g. chat session ID.
	 * @param elicitation Request to elicit a response.
	 * @returns A promise that resolves to an {@link ElicitationResult}.
	 */
	elicit(server: IMcpServer, context: IMcpToolCallContext | undefined, elicitation: MCPLegacy.ElicitRequest['params'], token: CancellationToken, options?: IMcpElicitOptions): Promise<ElicitResult>;
}

export interface IMcpElicitOptions {
	/**
	 * The same URL elicitation is being asked for again after the user already
	 * opened it (a modern server re-asked in a later round): show a "Continue"
	 * affordance instead of opening the URL again.
	 */
	readonly resume?: boolean;
}

export const enum ElicitationKind {
	Form,
	URL,
}

export interface IUrlModeElicitResult extends IDisposable {
	kind: ElicitationKind.URL;
	value: MCPLegacy.ElicitResult;
	/**
	 * Waits until the server tells us the elicitation is completed before resolving.
	 * Rejects with a CancellationError if the server stops before elicitation is
	 * complete, or if the token is cancelled.
	 */
	wait: Promise<void>;
}

export interface IFormModeElicitResult extends IDisposable {
	kind: ElicitationKind.Form;
	value: MCPLegacy.ElicitResult;
}

export type ElicitResult = IUrlModeElicitResult | IFormModeElicitResult;

export const IMcpElicitationService = createDecorator<IMcpElicitationService>('IMcpElicitationService');

export const McpToolResourceLinkMimeType = 'application/vnd.code.resource-link';

export interface IMcpToolResourceLinkContents {
	uri: UriComponents;
	underlyingMimeType?: string;
}

export interface IMcpIcons {
	/** Gets the image URI appropriate to the approximate display size */
	getUrl(size: number): { dark: URI; light?: URI } | undefined;
}
