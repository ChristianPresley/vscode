/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IExtensionManifest, IMcpCollectionContribution } from '../../../../platform/extensions/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { eraForProtocolVersion, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../../../platform/mcp/common/mcpProtocolVersions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { mcpSchemaId } from '../../../services/configuration/common/configuration.js';
import { inputsSchema } from '../../../services/configurationResolver/common/configurationResolverSchema.js';
import { Extensions, IExtensionFeaturesRegistry, IExtensionFeatureTableRenderer, IRenderedData, IRowData, ITableData } from '../../../services/extensionManagement/common/extensionFeatures.js';
import { IExtensionPointDescriptor } from '../../../services/extensions/common/extensionsRegistry.js';

const mcpActivationEventPrefix = 'onMcpCollection:';

/**
 * note: `contributedCollectionId` is _not_ the collection ID. The collection
 * ID is formed by passing the contributed ID through `extensionPrefixedIdentifier`
 */
export const mcpActivationEvent = (contributedCollectionId: string) =>
	mcpActivationEventPrefix + contributedCollectionId;

export const enum ExternalDiscoverySource {
	ClaudeDesktop = 'claude-desktop',
	Copilot = 'copilot',
	Windsurf = 'windsurf',
	CursorGlobal = 'cursor-global',
	CursorWorkspace = 'cursor-workspace',
}

export const allDiscoverySources = Object.keys({
	[ExternalDiscoverySource.ClaudeDesktop]: true,
	[ExternalDiscoverySource.Copilot]: true,
	[ExternalDiscoverySource.Windsurf]: true,
	[ExternalDiscoverySource.CursorGlobal]: true,
	[ExternalDiscoverySource.CursorWorkspace]: true,
} satisfies Record<ExternalDiscoverySource, true>) as ExternalDiscoverySource[];

/**
 * Default enablement for each {@link ExternalDiscoverySource}. The Copilot CLI
 * user configuration is on by default because MCP server migration moves user
 * servers there; other applications' configurations remain opt-in.
 */
export const defaultDiscoverySourceEnablement: Readonly<Record<ExternalDiscoverySource, boolean>> = {
	[ExternalDiscoverySource.ClaudeDesktop]: false,
	[ExternalDiscoverySource.Copilot]: true,
	[ExternalDiscoverySource.Windsurf]: false,
	[ExternalDiscoverySource.CursorGlobal]: false,
	[ExternalDiscoverySource.CursorWorkspace]: false,
};

/**
 * Returns whether a discovery source is enabled by a `chat.mcp.discovery.enabled`
 * value. The legacy boolean form applies to every source; sources not set in the
 * object form use {@link defaultDiscoverySourceEnablement}.
 */
export function isDiscoverySourceEnabled(value: unknown, discoverySource: ExternalDiscoverySource): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	const enabled = value && typeof value === 'object' ? (value as Partial<Record<ExternalDiscoverySource, unknown>>)[discoverySource] : undefined;
	return typeof enabled === 'boolean' ? enabled : defaultDiscoverySourceEnablement[discoverySource];
}

export const discoverySourceLabel: Record<ExternalDiscoverySource, string> = {
	[ExternalDiscoverySource.ClaudeDesktop]: localize('mcp.discovery.source.claude-desktop', "Claude Desktop"),
	[ExternalDiscoverySource.Copilot]: localize('mcp.discovery.source.copilot', "GitHub Copilot CLI"),
	[ExternalDiscoverySource.Windsurf]: localize('mcp.discovery.source.windsurf', "Windsurf"),
	[ExternalDiscoverySource.CursorGlobal]: localize('mcp.discovery.source.cursor-global', "Cursor (Global)"),
	[ExternalDiscoverySource.CursorWorkspace]: localize('mcp.discovery.source.cursor-workspace', "Cursor (Workspace)"),
};
export const discoverySourceSettingsLabel: Record<ExternalDiscoverySource, string> = {
	[ExternalDiscoverySource.ClaudeDesktop]: localize('mcp.discovery.source.claude-desktop.config', "Claude Desktop configuration (`claude_desktop_config.json`)"),
	[ExternalDiscoverySource.Copilot]: localize('mcp.discovery.source.copilot.config', "GitHub Copilot CLI configuration (`mcp-config.json` in `COPILOT_HOME`, or `~/.copilot/mcp-config.json` when unset)"),
	[ExternalDiscoverySource.Windsurf]: localize('mcp.discovery.source.windsurf.config', "Windsurf configurations (`~/.codeium/windsurf/mcp_config.json`)"),
	[ExternalDiscoverySource.CursorGlobal]: localize('mcp.discovery.source.cursor-global.config', "Cursor global configuration (`~/.cursor/mcp.json`)"),
	[ExternalDiscoverySource.CursorWorkspace]: localize('mcp.discovery.source.cursor-workspace.config', "Cursor workspace configuration (`.cursor/mcp.json`)"),
};

export const mcpConfigurationSection = 'mcp';
export const mcpDiscoverySection = 'chat.mcp.discovery.enabled';
export const mcpWorkspaceRootConfig = 'chat.mcp.workspaceRootConfig.enabled';
export const mcpServerSamplingSection = 'chat.mcp.serverSampling';
export const mcpServerCollisionBehaviorSection = 'chat.mcp.collisionBehavior';
/**
 * Configuration key for the enterprise-managed MCP IdP bag. The setting is
 * registered with `included: false` so it is hidden from the Settings UI and
 * settings.json IntelliSense; it is intended to be delivered through enterprise
 * policy (Windows Group Policy / macOS managed preferences / Linux
 * `/etc/vscode/policy.json`), with hand-editing of `settings.json` as a
 * developer escape hatch.
 */
export const mcpEnterpriseManagedAuthIdpSection = 'mcp.enterpriseManagedAuth.idp';

/**
 * Shape of the {@link mcpEnterpriseManagedAuthIdpSection} setting. All fields
 * are optional so partial configurations (e.g. just the issuer) remain valid.
 */
export interface IMcpEnterpriseManagedAuthIdpConfig {
	readonly issuer?: string;
	readonly clientId?: string;
	readonly clientSecret?: string;
}

export const enum McpCollisionBehavior {
	Disable = 'disable',
	Suffix = 'suffix',
}

export interface IMcpServerSamplingConfiguration {
	allowedDuringChat?: boolean;
	allowedOutsideChat?: boolean;
	allowedModels?: string[];
}

export const mcpSchemaExampleServers = {
	'mcp-server-time': {
		command: 'python',
		args: ['-m', 'mcp_server_time', '--local-timezone=America/Los_Angeles'],
		env: {},
	}
};

const httpSchemaExamples = {
	'my-mcp-server': {
		url: 'http://localhost:3001/mcp',
		headers: {},
	}
};

const grpcSchemaExamples = {
	'my-grpc-server': {
		type: 'grpc',
		url: 'grpcs://localhost:50051',
		binding: 'auto',
	}
};

/**
 * The `protocolVersion` property shared by every server kind: an optional pin to
 * one of the revisions VS Code can speak.
 */
const mcpProtocolVersionSchema: IJSONSchema = {
	type: 'string',
	enum: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
	enumDescriptions: SUPPORTED_MCP_PROTOCOL_VERSIONS.map(version => eraForProtocolVersion(version) === 'modern'
		? localize('app.mcp.json.protocolVersion.modern', "Revision {0}: stateless requests carrying their protocol metadata, `server/discover` and subscription-based notifications.", version)
		: localize('app.mcp.json.protocolVersion.legacy', "Revision {0}: the `initialize` handshake with a stateful session.", version)),
	markdownDescription: localize('app.mcp.json.protocolVersion', "Pins the Model Context Protocol revision used to talk to this server. By default, the newest revision both VS Code and the server support is negotiated. If the server rejects the pinned revision, VS Code negotiates a revision as it does without a pin, and uses that revision instead of the pin until the pin or the server's command, URL or other connection settings change, or until the **MCP: Reset Cached Tools** command runs."),
};

const mcpOAuthSchema: IJSONSchema = {
	type: 'object',
	description: localize('app.mcp.json.oauth', "OAuth configuration for authenticating with the server."),
	additionalProperties: false,
	minProperties: 1,
	properties: {
		clientId: {
			type: 'string',
			minLength: 1,
			markdownDescription: localize('app.mcp.json.oauth.clientId', "The OAuth client ID to use when authenticating with the server. When `enterpriseManaged` is `true`, this is the **resource** authorization server's client ID (the client trusted by the protected resource), not the IdP's. To set the matching client secret, use the *Set Client Secret* code lens above this field — secrets are stored in the OS secret store, not in this file.")
		},
		enterpriseManaged: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('app.mcp.json.oauth.enterpriseManaged', "(Preview) When set to `true`, this MCP server authenticates through the SSO issuer configured by `#mcp.enterpriseManagedAuth.idp#` using OAuth Identity Assertion Authorization Grant (ID-JAG). After a one-time sign-in, subsequent enterprise-managed servers connect silently. The IdP issuer and client credentials are read from the `#mcp.enterpriseManagedAuth.idp#` setting; the `clientId` on this server entry is passed to the resource authorization server.")
		},
		authorizationServer: {
			type: 'string',
			format: 'uri',
			markdownDescription: localize('app.mcp.json.oauth.authorizationServer', "The issuer URL of the authorization server that `clientId` and its client secret are registered with. When the server names a different authorization server, VS Code refuses to send these credentials to it. When omitted, the credentials are bound to the authorization server they are first used with.")
		},
		pkce: {
			type: 'string',
			enum: ['require-advertised', 'assume-supported'],
			default: 'require-advertised',
			enumDescriptions: [
				localize('app.mcp.json.oauth.pkce.requireAdvertised', "Only authorize against authorization servers that advertise the `S256` PKCE method."),
				localize('app.mcp.json.oauth.pkce.assumeSupported', "Use PKCE `S256` even when the authorization server does not advertise it. Only use this for servers known to support PKCE."),
			],
			markdownDescription: localize('app.mcp.json.oauth.pkce', "Whether the authorization server must advertise PKCE `S256` support in its metadata (`code_challenge_methods_supported`).")
		},
		allowInsecureHttp: {
			type: 'boolean',
			default: false,
			markdownDescription: localize('app.mcp.json.oauth.allowInsecureHttp', "Allow `http://` authorization server endpoints on hosts other than loopback. Only use this for local development; tokens and credentials are sent unencrypted.")
		}
	}
};

const mcpDevModeProps = (stdio: boolean): IJSONSchemaMap => ({
	dev: {
		type: 'object',
		markdownDescription: localize('app.mcp.dev', 'Enabled development mode for the server. When present, the server will be started eagerly and output will be included in its output. Properties inside the `dev` object can configure additional behavior.'),
		examples: [{ watch: 'src/**/*.ts', debug: { type: 'node' } }],
		properties: {
			watch: {
				description: localize('app.mcp.dev.watch', 'A glob pattern or list of glob patterns relative to the workspace folder to watch. The MCP server will be restarted when these files change.'),
				examples: ['src/**/*.ts'],
				oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
			},
			...(stdio && {
				debug: {
					markdownDescription: localize('app.mcp.dev.debug', 'If set, debugs the MCP server using the given runtime as it\'s started.'),
					oneOf: [
						{
							type: 'object',
							required: ['type'],
							properties: {
								type: {
									type: 'string',
									enum: ['node'],
									description: localize('app.mcp.dev.debug.type.node', "Debug the MCP server using Node.js.")
								}
							},
							additionalProperties: false
						},
						{
							type: 'object',
							required: ['type'],
							properties: {
								type: {
									type: 'string',
									enum: ['debugpy'],
									description: localize('app.mcp.dev.debug.type.python', "Debug the MCP server using Python and debugpy.")
								},
								debugpyPath: {
									type: 'string',
									description: localize('app.mcp.dev.debug.debugpyPath', "Path to the debugpy executable.")
								},
							},
							additionalProperties: false
						}
					]
				}
			})
		}
	}
});

const mcpSandboxSchema = (allowGrants: boolean): IJSONSchema => ({
	type: 'object',
	additionalProperties: false,
	properties: {
		network: {
			description: localize('app.mcp.json.sandbox.network', "Network access settings for the sandboxed server."),
			type: 'object',
			additionalProperties: false,
			properties: {
				...(allowGrants && {
					allowedDomains: {
						description: localize('app.mcp.json.sandbox.network.allowedDomains', "List of domains that the server is allowed to access. Wildcards are supported, e.g. `*.example.com`."),
						type: 'array',
						items: { type: 'string' },
						default: []
					},
				}),
				deniedDomains: {
					description: localize('app.mcp.json.sandbox.network.deniedDomains', "List of domains that the server is not allowed to access. e.g. `invalid.example.com`."),
					type: 'array',
					items: { type: 'string' },
					default: []
				}
			}
		},
		filesystem: {
			description: localize('app.mcp.json.sandbox.filesystem', "Filesystem access settings for the sandboxed server. Glob patterns are supported for Mac OS only."),
			type: 'object',
			additionalProperties: false,
			properties: {
				denyRead: {
					description: localize('app.mcp.json.sandbox.filesystem.denyRead', "List of file paths that the server is not allowed to read. By default, all files are allowed to be read. e.g. `~/src/secrets`."),
					type: 'array',
					items: { type: 'string' },
					default: []
				},
				...(allowGrants && {
					allowWrite: {
						description: localize('app.mcp.json.sandbox.filesystem.allowWrite', "List of file paths that the server is allowed to write to. e.g. `~/src/`."),
						type: 'array',
						items: { type: 'string' },
						default: []
					},
				}),
				denyWrite: {
					description: localize('app.mcp.json.sandbox.filesystem.denyWrite', "List of file paths that the server is not allowed to write to. e.g. `~/src/auth/`."),
					type: 'array',
					items: { type: 'string' },
					default: []
				}
			}
		}
	}
});

export const mcpStdioServerSchema: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	examples: [mcpSchemaExampleServers['mcp-server-time']],
	properties: {
		type: {
			type: 'string',
			enum: ['stdio'],
			description: localize('app.mcp.json.type', "The type of the server.")
		},
		sandboxEnabled: {
			type: 'boolean',
			default: false,
			description: localize('app.mcp.json.sandboxEnabled', "Whether to run the server in a sandboxed environment.")
		},
		sandbox: {
			...mcpSandboxSchema(true),
			description: localize('app.mcp.json.serverSandbox', "Sandbox filesystem and network permissions for this server only. Root-level sandbox deny rules also apply. Dialog approvals are saved here. Requires sandboxEnabled on macOS or Linux.")
		},
		command: {
			type: 'string',
			description: localize('app.mcp.json.command', "The command to run the server.")
		},
		cwd: {
			type: 'string',
			description: localize('app.mcp.json.cwd', "The working directory for the server command. Defaults to the workspace folder when run in a workspace."),
			examples: ['${workspaceFolder}'],
		},
		args: {
			type: 'array',
			description: localize('app.mcp.args.command', "Arguments passed to the server."),
			items: {
				type: 'string'
			},
		},
		envFile: {
			type: 'string',
			description: localize('app.mcp.envFile.command', "Path to a file containing environment variables for the server."),
			examples: ['${workspaceFolder}/.env'],
		},
		env: {
			description: localize('app.mcp.env.command', "Environment variables passed to the server."),
			additionalProperties: {
				anyOf: [
					{ type: 'null' },
					{ type: 'string' },
					{ type: 'number' },
				]
			}
		},
		protocolVersion: mcpProtocolVersionSchema,
		...mcpDevModeProps(true),
	}
};

export const mcpRemoteServerSchema: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['url'],
	examples: [httpSchemaExamples['my-mcp-server']],
	properties: {
		type: {
			type: 'string',
			enum: ['http', 'sse'],
			description: localize('app.mcp.json.type', "The type of the server.")
		},
		transport: {
			type: 'string',
			enum: ['http', 'sse'],
			description: localize('app.mcp.json.transport', "The HTTP transport to preserve when sharing this configuration with other MCP clients."),
		},
		url: {
			type: 'string',
			format: 'uri',
			pattern: '^https?:\\/\\/.+',
			patternErrorMessage: localize('app.mcp.json.url.pattern', "The URL must start with 'http://' or 'https://'."),
			description: localize('app.mcp.json.url', "The URL of the Streamable HTTP or SSE endpoint.")
		},
		headers: {
			type: 'object',
			description: localize('app.mcp.json.headers', "Additional headers sent to the server. These headers are not sent to a different origin, including across redirects."),
			additionalProperties: { type: 'string' },
		},
		oauth: mcpOAuthSchema,
		protocolVersion: mcpProtocolVersionSchema,
		...mcpDevModeProps(false),
	}
};

export const mcpGrpcServerSchema: IJSONSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['type', 'url'],
	examples: [grpcSchemaExamples['my-grpc-server']],
	properties: {
		type: {
			type: 'string',
			enum: ['grpc'],
			description: localize('app.mcp.json.type', "The type of the server.")
		},
		url: {
			type: 'string',
			format: 'uri',
			pattern: '^grpcs?:\\/\\/.+',
			patternErrorMessage: localize('app.mcp.json.grpc.url.pattern', "The URL must start with 'grpc://' or 'grpcs://'."),
			markdownDescription: localize('app.mcp.json.grpc.url', "The gRPC endpoint of the server: `grpc://host:port` for plaintext HTTP/2 or `grpcs://host:port` for TLS.")
		},
		headers: {
			type: 'object',
			description: localize('app.mcp.json.grpc.headers', "Additional metadata sent with every call. It is not sent to a different authority than the configured URL."),
			additionalProperties: { type: 'string' },
		},
		tls: {
			type: 'object',
			additionalProperties: false,
			markdownDescription: localize('app.mcp.json.grpc.tls', "TLS settings for `grpcs://` endpoints. The server certificate is verified against the same certificate authorities as HTTPS requests: the bundled roots and, when the `http.systemCertificates` setting is on, the operating system's certificate store."),
			properties: {
				ca: {
					type: 'string',
					markdownDescription: localize('app.mcp.json.grpc.tls.ca', "Path to a PEM-encoded certificate authority bundle that is trusted for the server certificate in addition to the bundled roots and, when the `http.systemCertificates` setting is on, the operating system's certificate store."),
					examples: ['${workspaceFolder}/certs/ca.pem'],
				},
				insecure: {
					type: 'boolean',
					default: false,
					description: localize('app.mcp.json.grpc.tls.insecure', "Skips verification of the server certificate. Only use this for local development."),
				},
				serverName: {
					type: 'string',
					description: localize('app.mcp.json.grpc.tls.serverName', "The host name presented during the TLS handshake (SNI) and checked against the server certificate, when it differs from the host in the URL."),
				},
			}
		},
		binding: {
			type: 'string',
			enum: ['auto', 'tunnel', 'typed'],
			default: 'auto',
			markdownEnumDescriptions: [
				localize('app.mcp.json.grpc.binding.auto', "The default: the JSON-RPC tunnel, exactly as `tunnel`. VS Code never switches to the typed service on its own."),
				localize('app.mcp.json.grpc.binding.tunnel', "Send the JSON-RPC messages through the `mcp.zig.transport.v1.Mcp/Call` tunnel."),
				localize('app.mcp.json.grpc.binding.typed', "Call the methods of Google's typed `model_context_protocol.Mcp` service, for a server that does not offer the tunnel. The typed service carries no subscriptions, notifications, pagination beyond the first page or tasks."),
			],
			markdownDescription: localize('app.mcp.json.grpc.binding', "The gRPC service the server implements. `auto` (the default) and `tunnel` send MCP's JSON-RPC messages through the `mcp.zig.transport.v1.Mcp/Call` tunnel; VS Code never switches to Google's typed `model_context_protocol.Mcp` service on its own. Set `typed` for a server that only offers the typed service: with `auto`, such a server fails to start with an error that says so."),
		},
		deadlineMs: {
			type: 'number',
			exclusiveMinimum: 0,
			maximum: 2147483647,
			markdownDescription: localize('app.mcp.json.grpc.deadlineMs', "The deadline for each call in milliseconds, sent as `grpc-timeout`; it must be greater than 0. It applies to every request except the `subscriptions/listen` stream, which never has one. When unset, only `server/discover`, `tools/list`, `prompts/list`, `prompts/get`, `resources/list`, `resources/templates/list`, `resources/read` and `completion/complete` get a deadline of 60 seconds; `tools/call`, the retries of `input_required` rounds and the other requests get none, so a tool that never returns keeps its request open until it is cancelled."),
		},
		keepAliveMs: {
			type: 'number',
			// Either 0 (off) or an interval a gRPC server accepts that a timer can wait.
			anyOf: [{ minimum: 300000, maximum: 2147483647 }, { const: 0 }],
			markdownDescription: localize('app.mcp.json.grpc.keepAliveMs', "The interval between HTTP/2 keep-alive pings in milliseconds, from `300000` (5 minutes: gRPC servers allow one ping every 5 minutes by default and close the connection of a client that pings more often) to `2147483647`. The pings are sent only while at least one call is open, as gRPC clients do by default: servers count a ping on an idle connection as abuse. If the server still answers with `too_many_pings`, the interval is doubled for the next connection. `0` sends no pings at all. When unset, a ping is sent every 5 minutes and 10 seconds only while a `subscriptions/listen` stream is open, so that a NAT or load balancer does not cut a stream that has no events for a while."),
		},
		oauth: mcpOAuthSchema,
		protocolVersion: mcpProtocolVersionSchema,
		...mcpDevModeProps(false),
	}
};

export const mcpServerSchema: IJSONSchema = {
	id: mcpSchemaId,
	type: 'object',
	title: localize('app.mcp.json.title', "Model Context Protocol Servers"),
	allowTrailingCommas: true,
	allowComments: true,
	additionalProperties: false,
	properties: {
		sandbox: {
			...mcpSandboxSchema(false),
			description: localize('app.mcp.json.sandbox', "Sandbox deny rules shared by all servers in this file. Allow rules are only supported in a server's sandbox property; root-level allow rules are ignored. Sandboxing requires sandboxEnabled at the server level on macOS or Linux.")
		},
		servers: {
			examples: [
				mcpSchemaExampleServers,
				httpSchemaExamples,
				grpcSchemaExamples,
			],
			additionalProperties: {
				oneOf: [
					mcpStdioServerSchema, mcpRemoteServerSchema, mcpGrpcServerSchema,
				]
			}
		},
		inputs: inputsSchema.definitions!.inputs
	}
};

export const mcpContributionPoint: IExtensionPointDescriptor<IMcpCollectionContribution[]> = {
	extensionPoint: 'mcpServerDefinitionProviders',
	activationEventsGenerator: function* (contribs) {
		for (const contrib of contribs) {
			if (contrib.id) {
				yield mcpActivationEvent(contrib.id);
			}
		}
	},
	jsonSchema: {
		description: localize('vscode.extension.contributes.mcp', 'Contributes Model Context Protocol servers. Users of this should also use `vscode.lm.registerMcpServerDefinitionProvider`.'),
		type: 'array',
		defaultSnippets: [{ body: [{ id: '', label: '' }] }],
		items: {
			additionalProperties: false,
			type: 'object',
			defaultSnippets: [{ body: { id: '', label: '' } }],
			properties: {
				id: {
					description: localize('vscode.extension.contributes.mcp.id', "Unique ID for the collection."),
					type: 'string'
				},
				label: {
					description: localize('vscode.extension.contributes.mcp.label', "Display name for the collection."),
					type: 'string'
				},
				when: {
					description: localize('vscode.extension.contributes.mcp.when', "Condition which must be true to enable this collection."),
					type: 'string'
				}
			}
		}
	}
};

class McpServerDefinitionsProviderRenderer extends Disposable implements IExtensionFeatureTableRenderer {

	readonly type = 'table';

	shouldRender(manifest: IExtensionManifest): boolean {
		return !!manifest.contributes?.mcpServerDefinitionProviders && Array.isArray(manifest.contributes.mcpServerDefinitionProviders) && manifest.contributes.mcpServerDefinitionProviders.length > 0;
	}

	render(manifest: IExtensionManifest): IRenderedData<ITableData> {
		const mcpServerDefinitionProviders = manifest.contributes?.mcpServerDefinitionProviders ?? [];
		const headers = [localize('id', "ID"), localize('name', "Name")];
		const rows: IRowData[][] = mcpServerDefinitionProviders
			.map(mcpServerDefinitionProvider => {
				return [
					new MarkdownString().appendMarkdown(`\`${mcpServerDefinitionProvider.id}\``),
					mcpServerDefinitionProvider.label
				];
			});

		return {
			data: {
				headers,
				rows
			},
			dispose: () => { }
		};
	}
}

Registry.as<IExtensionFeaturesRegistry>(Extensions.ExtensionFeaturesRegistry).registerExtensionFeature({
	id: mcpConfigurationSection,
	label: localize('mcpServerDefinitionProviders', "MCP Servers"),
	access: {
		canToggle: false
	},
	renderer: new SyncDescriptor(McpServerDefinitionsProviderRenderer),
});
