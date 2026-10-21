/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise, raceTimeout, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableValue, waitForState } from '../../../../../base/common/observable.js';
import { isWeb } from '../../../../../base/common/platform.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILoggerService, NullLogger, NullLogService } from '../../../../../platform/log/common/log.js';
import { AllowedMcpServersService } from '../../../../../platform/mcp/common/allowedMcpServersService.js';
import { IAllowedMcpServersService, mcpAccessConfig, McpAccessValue, mcpAllowedServersConfig, mcpAutoStartConfig, McpAutoStartValue, mcpDeniedServersConfig } from '../../../../../platform/mcp/common/mcpManagement.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService, NullTelemetryServiceShape } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ConfigurationResolverExpression } from '../../../../services/configurationResolver/common/configurationResolverExpression.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { TestContextService, TestLoggerService, TestProductService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IMcpRegistry } from '../../common/mcpRegistryTypes.js';
import { McpServerConnection } from '../../common/mcpServerConnection.js';
import { McpService } from '../../common/mcpService.js';
import { IMcpServer, IMcpTool, McpCapability, McpClientError, McpConnectionState, McpServerDefinition, McpServerLaunch, McpServerTransportType, MpcResponseError } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { ITestMcpTransportOptions, TestMcpMessageTransport, TestMcpRegistry } from './mcpRegistryTypes.js';
import { McpServerRequestHandler } from '../../common/mcpServerRequestHandler.js';
import { McpServer, McpServerMetadataCache } from '../../common/mcpServer.js';
import { MCP } from '../../../../../platform/mcp/common/modelContextProtocol.js';
import { IJsonRpcRequest, JsonRpcMessage } from '../../../../../base/common/jsonRpcProtocol.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { INotification, INotificationHandle, INotificationService, IPromptChoice, NoOpNotification, NotificationMessage, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { runWithFakedTimers } from '../../../../../base/test/common/virtualScheduling/runWithFakedTimers.js';
import { TOOL_LIST_CHANGE_GRACE_MS } from '../../common/mcpProtocolMeta.js';
import { DEFAULT_PATTERN_ANALYSIS_BUDGET, getPatternAnalysisRunCount } from '../../../../../base/common/jsonSchemaValidator/compile.js';
import { analyzeRegexCost } from '../../../../../base/common/jsonSchemaValidator/regexCost.js';

/** Exposes the user-scoped metadata cache for assertions. */
class TestableMcpService extends McpService {
	getCachedEntry(definitionId: string): ReturnType<McpServerMetadataCache['get']> {
		return this.userCache.get(definitionId);
	}

	/** Replaces the cached entry with a copy of it, as a new window restores it from storage. */
	restoreCachedEntry(definitionId: string): void {
		const entry = this.userCache.get(definitionId);
		assert.ok(entry, 'a cached entry');
		this.userCache.store(definitionId, JSON.parse(JSON.stringify(entry)));
	}
}

suite('Workbench - MCP - McpService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const createMcpService = (allowedMcpServersService?: IAllowedMcpServersService, overrides: { readonly notificationService?: INotificationService; readonly telemetryService?: ITelemetryService } = {}) => {
		const storageService = store.add(new TestStorageService());
		const services = new ServiceCollection(
			[IFileService, { registerProvider: () => { } }],
			[IStorageService, storageService],
			[ILoggerService, store.add(new TestLoggerService())],
			[IWorkspaceContextService, new TestContextService()],
			[IWorkbenchEnvironmentService, {}],
			[ITelemetryService, overrides.telemetryService ?? NullTelemetryService],
			[IProductService, TestProductService],
			[IAllowedMcpServersService, allowedMcpServersService ?? { _serviceBrand: undefined, onDidChangeAllowedMcpServers: Event.None, isAllowed: () => true, isServerAllowedBeforeResolution: () => true, isServerAllowed: () => true }],
			[INotificationService, overrides.notificationService ?? new TestNotificationService()],
		);

		const parentInstantiationService = store.add(new TestInstantiationService(services));
		const registry = new TestMcpRegistry(parentInstantiationService);
		const instantiationService = store.add(parentInstantiationService.createChild(new ServiceCollection([IMcpRegistry, registry])));
		const configurationService = new TestConfigurationService({ [mcpAutoStartConfig]: McpAutoStartValue.NewAndOutdated });
		const mcpService = store.add(new TestableMcpService(instantiationService, registry, new NullLogService(), configurationService, storageService));
		return { mcpService, registry, instantiationService };
	};

	const setServerDefinition = (registry: TestMcpRegistry, definition: McpServerDefinition) => {
		const collection = registry.collections.get()[0];
		registry.collections.set([{
			...collection,
			serverDefinitions: observableValue('serverDefinitions', [definition])
		}], undefined);
	};

	suite('URL policy resolution', () => {
		const createPolicyServer = (definitionUrl: string, resolvedUrl = definitionUrl, requiresActivation = false) => {
			const configurationService = new TestConfigurationService({
				[mcpAllowedServersConfig]: [{ serverUrl: 'https://trusted.example/mcp' }],
				[mcpDeniedServersConfig]: [{ serverUrl: 'https://blocked.example/*' }],
			});
			const allowedMcpServersService = store.add(new AllowedMcpServersService(configurationService));
			const { mcpService, registry, instantiationService } = createMcpService(allowedMcpServersService);
			const definition: McpServerDefinition = {
				id: 'test-server',
				label: 'Test Server',
				launch: { type: McpServerTransportType.HTTP, uri: URI.parse(definitionUrl), headers: [] },
				cacheNonce: 'a',
			};
			setServerDefinition(registry, definition);
			const activation = { done: true, calls: 0 };
			if (requiresActivation) {
				const collection = registry.collections.get()[0];
				registry.collections.set([{ ...collection, lazy: { isCached: true, load: async () => { } } }], undefined);
				instantiationService.stub(IExtensionService, new class extends mock<IExtensionService>() {
					override activationEventIsDone(): boolean { return activation.done; }
					override async activateByEvent(): Promise<void> { activation.calls++; activation.done = true; }
				});
			}

			const inputChanges = store.add(new Emitter<void>());
			registry.onDidChangeInputs = inputChanges.event;
			const resolutionResult: { url: string; beforeResolve?: () => Promise<void>; cancelled?: boolean } = { url: resolvedUrl };
			const resolution = sinon.stub(registry, 'resolveConnection').callsFake(async options => {
				await resolutionResult.beforeResolve?.();
				if (resolutionResult.cancelled) {
					return undefined;
				}
				return store.add(instantiationService.createInstance(
					McpServerConnection,
					registry.collections.get()[0],
					definition,
					registry.delegates.get()[0],
					{ type: McpServerTransportType.HTTP, uri: URI.parse(resolutionResult.url), headers: [] },
					new NullLogger(),
					true,
					options.taskManager,
				));
			});
			store.add(toDisposable(() => resolution.restore()));

			const transports: TestMcpMessageTransport[] = [];
			registry.makeTestTransport = () => {
				const transport = store.add(new TestMcpMessageTransport());
				transports.push(transport);
				transport.setResponder('tools/list', message => ({
					jsonrpc: MCPLegacy.JSONRPC_VERSION,
					id: (message as MCPLegacy.JSONRPCRequest).id,
					result: { tools: [] },
				}));
				return transport;
			};
			mcpService.updateCollectedServers();
			return { server: mcpService.servers.get()[0], configurationService, resolution, resolutionResult, transports, registry, mcpService, definition, inputChanges, activation };
		};

		const setDeniedUrls = async (configurationService: TestConfigurationService, urls: string[]) => {
			await configurationService.setUserConfiguration(mcpDeniedServersConfig, urls.map(serverUrl => ({ serverUrl })));
			configurationService.onDidChangeConfigurationEmitter.fire({
				source: ConfigurationTarget.USER,
				affectedKeys: new Set([mcpDeniedServersConfig]),
				change: { keys: [mcpDeniedServersConfig], overrides: [] },
				affectsConfiguration: key => key === mcpDeniedServersConfig,
			});
		};

		const provideCachedMetadata = (registry: TestMcpRegistry) => {
			const createTransport = registry.makeTestTransport;
			registry.makeTestTransport = () => {
				const transport = createTransport();
				transport.setResponder('initialize', message => ({
					jsonrpc: MCPLegacy.JSONRPC_VERSION,
					id: (message as MCPLegacy.JSONRPCRequest).id,
					result: {
						protocolVersion: MCPLegacy.LATEST_PROTOCOL_VERSION,
						serverInfo: { name: 'Policy Fixture', version: '1.0.0' },
						capabilities: { tools: {}, prompts: {} },
					}
				}));
				transport.setResponder('tools/list', message => ({
					jsonrpc: MCPLegacy.JSONRPC_VERSION, id: (message as MCPLegacy.JSONRPCRequest).id,
					result: { tools: [{ name: 'cached_tool', inputSchema: { type: 'object', properties: {} } }] },
				}));
				transport.setResponder('prompts/list', message => ({
					jsonrpc: MCPLegacy.JSONRPC_VERSION, id: (message as MCPLegacy.JSONRPCRequest).id,
					result: { prompts: [{ name: 'cached_prompt' }] },
				}));
				return transport;
			};
		};

		const createBlockedInputServer = async () => {
			const context = createPolicyServer('https://${input:host}/mcp', 'https://trusted.example/mcp');
			const { server, registry, configurationService } = context;
			provideCachedMetadata(registry);
			await configurationService.setUserConfiguration(mcpAllowedServersConfig, [
				{ serverUrl: 'https://trusted.example/mcp' },
				{ serverUrl: 'https://changed.example/mcp' },
			]);
			await server.start({ promptType: 'never', errorOnUserInteraction: true });
			await Promise.all([
				waitForState(server.tools, tools => tools.length === 1),
				waitForState(server.prompts, prompts => prompts.length === 1),
			]);
			await setDeniedUrls(configurationService, ['https://trusted.example/*']);
			const snapshot = () => ({
				state: server.connectionState.get().state,
				connected: !!server.connection.get(),
				tools: server.tools.get().length,
				prompts: server.prompts.get().length,
			});
			return { ...context, snapshot };
		};

		test('retains a resolved policy block and suppresses cached metadata after disposal', async () => {
			const { server, configurationService, registry, definition } = createPolicyServer('https://${input:host}/mcp', 'https://trusted.example/mcp');
			provideCachedMetadata(registry);
			await server.start({ promptType: 'never', errorOnUserInteraction: true });
			await Promise.all([
				waitForState(server.tools, tools => tools.length === 1),
				waitForState(server.prompts, prompts => prompts.length === 1),
			]);
			const snapshot = () => ({
				state: server.connectionState.get().state,
				connected: !!server.connection.get(),
				tools: server.tools.get().length,
				prompts: server.prompts.get().length,
			});
			const before = snapshot();
			await setDeniedUrls(configurationService, ['https://trusted.example/*']);
			const blocked = snapshot();
			setServerDefinition(registry, { ...definition, launch: { ...definition.launch } });
			const equivalentDefinition = snapshot();
			await setDeniedUrls(configurationService, []);
			const allowedAgain = snapshot();

			assert.deepStrictEqual({ before, blocked, equivalentDefinition, allowedAgain }, {
				before: { state: McpConnectionState.Kind.Running, connected: true, tools: 1, prompts: 1 },
				blocked: { state: McpConnectionState.Kind.Error, connected: false, tools: 0, prompts: 0 },
				equivalentDefinition: { state: McpConnectionState.Kind.Error, connected: false, tools: 0, prompts: 0 },
				allowedAgain: { state: McpConnectionState.Kind.Stopped, connected: false, tools: 1, prompts: 1 },
			});
		});

		for (const inputAction of ['edit', 'reset'] as const) {
			test(`explicit retry re-resolves a blocked server after saved input ${inputAction}`, async () => {
				const { server, registry, definition, resolution, resolutionResult, inputChanges, transports, snapshot } = await createBlockedInputServer();
				const resolving = new DeferredPromise<void>();
				const resume = new DeferredPromise<void>();
				resolutionResult.beforeResolve = async () => {
					void resolving.complete();
					await resume.p;
				};
				const changedInput = async () => {
					resolutionResult.url = 'https://changed.example/mcp';
					inputChanges.fire();
				};
				const edit = sinon.stub(registry, 'editSavedInput').callsFake(changedInput);
				store.add(toDisposable(() => edit.restore()));
				const clear = sinon.stub(registry, 'clearSavedInputs').callsFake(changedInput);
				store.add(toDisposable(() => clear.restore()));
				if (inputAction === 'edit') {
					await registry.editSavedInput('${input:host}', undefined, 'mcp', ConfigurationTarget.USER);
				} else {
					await registry.clearSavedInputs(StorageScope.PROFILE, '${input:host}');
				}
				const afterInputChange = snapshot();
				const quiet = await server.start({ promptType: 'never', errorOnUserInteraction: true });
				const quietResolutions = resolution.callCount;
				const pending = server.start({ promptType: 'all-untrusted' });
				const enteredResolution = await raceTimeout(resolving.p.then(() => true), 1000) ?? false;
				const duringResolution = snapshot();
				await resume.complete();
				const retried = await pending;
				const connection = server.connection.get();
				if (connection) {
					await waitForState(connection.handler, Boolean);
				}

				const blocked = { state: McpConnectionState.Kind.Error, connected: false, tools: 0, prompts: 0 };
				assert.deepStrictEqual({
					definitionUnchanged: registry.collections.get()[0].serverDefinitions.get()[0] === definition,
					afterInputChange,
					quiet: quiet.state,
					quietResolutions,
					enteredResolution,
					duringResolution,
					retried: retried.state,
					afterRetry: snapshot(),
					resolutions: resolution.callCount,
					transports: transports.length,
				}, {
					definitionUnchanged: true,
					afterInputChange: blocked,
					quiet: McpConnectionState.Kind.Error,
					quietResolutions: 1,
					enteredResolution: true,
					duringResolution: blocked,
					retried: McpConnectionState.Kind.Running,
					afterRetry: { state: McpConnectionState.Kind.Running, connected: true, tools: 1, prompts: 1 },
					resolutions: 2,
					transports: 2,
				});
			});
		}

		test('cancelled and repeatedly denied input retries keep cached metadata blocked', async () => {
			const { server, registry, resolution, resolutionResult, inputChanges, transports, snapshot } = await createBlockedInputServer();
			const resolving = new DeferredPromise<void>();
			const resume = new DeferredPromise<void>();
			const clear = sinon.stub(registry, 'clearSavedInputs').callsFake(async () => inputChanges.fire());
			store.add(toDisposable(() => clear.restore()));
			await registry.clearSavedInputs(StorageScope.PROFILE, '${input:host}');
			resolutionResult.beforeResolve = async () => {
				void resolving.complete();
				await resume.p;
			};
			resolutionResult.cancelled = true;
			const pending = server.start({ promptType: 'all-untrusted' });
			const enteredResolution = await raceTimeout(resolving.p.then(() => true), 1000) ?? false;
			const duringResolution = snapshot();
			await resume.complete();
			const cancelled = await pending;
			const afterCancellation = snapshot();
			resolutionResult.beforeResolve = undefined;
			resolutionResult.cancelled = false;
			const denied = await server.start({ promptType: 'all-untrusted' });

			const blocked = { state: McpConnectionState.Kind.Error, connected: false, tools: 0, prompts: 0 };
			assert.deepStrictEqual({
				enteredResolution,
				duringResolution,
				cancelled: cancelled.state,
				afterCancellation,
				denied: denied.state,
				afterDenial: snapshot(),
				resolutions: resolution.callCount,
				transports: transports.length,
			}, {
				enteredResolution: true,
				duringResolution: blocked,
				cancelled: McpConnectionState.Kind.Stopped,
				afterCancellation: blocked,
				denied: McpConnectionState.Kind.Error,
				afterDenial: blocked,
				resolutions: 3,
				transports: 1,
			});
		});

		for (const variable of ['${input:host}', '${command:resolveHost}']) {
			for (const retained of [false, true]) {
				for (const [reason, key, value] of [
					['disabled access', mcpAccessConfig, McpAccessValue.None],
					['denied name', mcpDeniedServersConfig, [{ serverName: 'Test Server' }]],
					['unlisted name', mcpAllowedServersConfig, [{ serverName: 'Another Server' }]],
				] as const) {
					test(`${reason} prevents startup side effects for ${variable} with retained identity ${retained}`, async () => {
						const { server, configurationService, resolution, resolutionResult, transports, activation } = createPolicyServer(`https://${variable}/mcp`, 'https://blocked.example/mcp', true);
						if (retained) {
							await server.start({ promptType: 'never', errorOnUserInteraction: true });
						}
						await configurationService.setUserConfiguration(key, value);
						configurationService.onDidChangeConfigurationEmitter.fire({
							source: ConfigurationTarget.USER,
							affectedKeys: new Set([key]),
							change: { keys: [key], overrides: [] },
							affectsConfiguration: candidate => candidate === key,
						});
						activation.done = false;
						const resolveInputs = sinon.stub().resolves();
						resolutionResult.beforeResolve = resolveInputs;
						const result = await server.start({ promptType: 'all-untrusted' });
						assert.deepStrictEqual({
							state: result.state,
							activations: activation.calls,
							resolutions: resolution.callCount,
							inputResolutions: resolveInputs.callCount,
							transports: transports.length,
							tools: server.tools.get().length,
							prompts: server.prompts.get().length,
						}, {
							state: McpConnectionState.Kind.Error,
							activations: 0,
							resolutions: retained ? 1 : 0,
							inputResolutions: 0,
							transports: 0,
							tools: 0,
							prompts: 0,
						});
					});
				}
			}
		}

		for (const transportType of [McpServerTransportType.HTTP, McpServerTransportType.Stdio]) {
			test(`discovery handles repeated incomplete markers without URL rules for transport ${transportType}`, () => {
				const configurationService = new TestConfigurationService();
				const allowedMcpServersService = store.add(new AllowedMcpServersService(configurationService));
				const { mcpService, registry } = createMcpService(allowedMcpServersService);
				const markers = '${'.repeat(32 * 1024);
				const launch: McpServerLaunch = transportType === McpServerTransportType.HTTP
					? { type: McpServerTransportType.HTTP, uri: URI.parse(`https://trusted.example/mcp#${markers}`), headers: [] }
					: { type: McpServerTransportType.Stdio, command: 'echo', args: [markers], env: {}, envFile: undefined, cwd: undefined, sandbox: undefined };
				setServerDefinition(registry, { id: 'test-server', label: 'Test Server', cacheNonce: 'a', launch });
				const stopwatch = StopWatch.create();
				mcpService.updateCollectedServers();
				const elapsed = stopwatch.elapsed();
				assert.ok(elapsed < 1000, `Discovery took ${elapsed}ms for 64 KiB of incomplete markers`);
				assert.strictEqual(mcpService.servers.get()[0].connectionState.get().state, McpConnectionState.Kind.Stopped);
			});
		}

		test('a gRPC definition is checked against the URL rules by its grpc:// or grpcs:// URL', () => {
			const configurationService = new TestConfigurationService({ [mcpDeniedServersConfig]: [{ serverUrl: 'grpcs://blocked.example:*' }] });
			const allowedMcpServersService = store.add(new AllowedMcpServersService(configurationService));
			const { mcpService, registry } = createMcpService(allowedMcpServersService);
			const states: McpConnectionState.Kind[] = [];
			for (const url of ['grpcs://blocked.example:443', 'grpcs://other.example:443']) {
				setServerDefinition(registry, { id: 'grpc-server', label: 'gRPC Server', cacheNonce: url, launch: { type: McpServerTransportType.Grpc, uri: URI.parse(url), headers: [] } });
				mcpService.updateCollectedServers();
				states.push(mcpService.servers.get()[0].connectionState.get().state);
			}
			assert.deepStrictEqual(states, [McpConnectionState.Kind.Error, McpConnectionState.Kind.Stopped]);
		});

		test('a changed definition releases the retained resolved policy block', async () => {
			const { server, registry, definition, transports } = createPolicyServer('https://${input:host}/mcp', 'https://blocked.example/mcp');
			const result = await server.start({ promptType: 'never', errorOnUserInteraction: true });
			const blocked = server.connectionState.get().state;
			setServerDefinition(registry, {
				...definition,
				cacheNonce: 'b',
				launch: { type: McpServerTransportType.HTTP, uri: URI.parse('https://trusted.example/mcp'), headers: [] }
			});
			assert.deepStrictEqual({
				result: result.state,
				blocked,
				changed: server.connectionState.get().state,
				transports: transports.length,
			}, {
				result: McpConnectionState.Kind.Error,
				blocked: McpConnectionState.Kind.Error,
				changed: McpConnectionState.Kind.Stopped,
				transports: 0,
			});
		});

		test('reverting a changed definition does not restore a stale resolved policy block', async () => {
			const { server, registry, definition, resolution, resolutionResult, transports } = createPolicyServer('https://${input:host}/mcp', 'https://blocked.example/mcp');
			const initial = await server.start({ promptType: 'never', errorOnUserInteraction: true });
			setServerDefinition(registry, {
				...definition,
				cacheNonce: 'b',
				launch: { type: McpServerTransportType.HTTP, uri: URI.parse('https://${input:otherHost}/mcp'), headers: [] }
			});
			const changed = server.connectionState.get().state;
			resolutionResult.url = 'https://trusted.example/mcp';
			setServerDefinition(registry, { ...definition, launch: { ...definition.launch } });
			const reverted = server.connectionState.get().state;
			const retried = await server.start({ promptType: 'never', errorOnUserInteraction: true });

			assert.deepStrictEqual({
				initial: initial.state,
				changed,
				reverted,
				retried: retried.state,
				resolutions: resolution.callCount,
				transports: transports.length,
			}, {
				initial: McpConnectionState.Kind.Error,
				changed: McpConnectionState.Kind.Stopped,
				reverted: McpConnectionState.Kind.Stopped,
				retried: McpConnectionState.Kind.Running,
				resolutions: 2,
				transports: 1,
			});
		});

		test('definition changes during a live connection invalidate its retained identity', async () => {
			const { server, configurationService, registry, definition, resolution, transports } = createPolicyServer('https://${input:host}/mcp', 'https://trusted.example/mcp');
			const initial = await server.start({ promptType: 'never', errorOnUserInteraction: true });
			setServerDefinition(registry, {
				...definition,
				cacheNonce: 'b',
				launch: { type: McpServerTransportType.HTTP, uri: URI.parse('https://${input:otherHost}/mcp'), headers: [] }
			});
			setServerDefinition(registry, { ...definition, launch: { ...definition.launch } });
			const reverted = server.connectionState.get().state;
			await setDeniedUrls(configurationService, ['https://trusted.example/*']);
			const revoked = { state: server.connectionState.get().state, connected: !!server.connection.get() };
			const retried = await server.start({ promptType: 'never', errorOnUserInteraction: true });

			assert.deepStrictEqual({
				initial: initial.state,
				reverted,
				revoked,
				retried: retried.state,
				resolutions: resolution.callCount,
				transports: transports.length,
			}, {
				initial: McpConnectionState.Kind.Running,
				reverted: McpConnectionState.Kind.Running,
				revoked: { state: McpConnectionState.Kind.Stopped, connected: false },
				retried: McpConnectionState.Kind.Error,
				resolutions: 2,
				transports: 1,
			});
		});

		test('policy revocation during Starting settles startup and permits a later retry', async () => {
			const { server, configurationService, registry, transports } = createPolicyServer('https://${input:host}/mcp', 'https://trusted.example/mcp');
			const starting = new DeferredPromise<void>();
			registry.delegates.set([{
				...registry.delegates.get()[0],
				start: () => {
					const transport = registry.makeTestTransport();
					if (transports.length === 1) {
						void starting.complete();
					} else {
						transport.setConnectionState({ state: McpConnectionState.Kind.Running });
					}
					return transport;
				},
			}], undefined);

			const pending = server.start({ promptType: 'never', errorOnUserInteraction: true });
			await starting.p;
			await setDeniedUrls(configurationService, ['https://trusted.example/*']);
			const revoked = await raceTimeout(pending, 1000);
			assert.ok(revoked, 'Startup must settle when policy disposes a Starting connection');
			const blocked = server.connectionState.get().state;
			await setDeniedUrls(configurationService, []);
			const retried = await raceTimeout(server.start({ promptType: 'never', errorOnUserInteraction: true }), 1000);
			assert.deepStrictEqual({
				revoked: revoked.state,
				blocked,
				retried: retried?.state,
				transports: transports.length,
			}, {
				revoked: McpConnectionState.Kind.Error,
				blocked: McpConnectionState.Kind.Error,
				retried: McpConnectionState.Kind.Running,
				transports: 2,
			});
		});

		for (const [host, reason] of [
			['attacker.example', 'not in the list of servers allowed by your organization'],
			['blocked.example', 'blocked by your organization'],
		]) {
			test(`blocks a non-variable fragment at rest for ${host}`, async () => {
				const url = `https://${host}/mcp#\${`;
				const { server, resolution, transports } = createPolicyServer(url);
				const beforeStart = server.connectionState.get().state;
				const result = await server.start({ promptType: 'never', errorOnUserInteraction: true });

				assert.deepStrictEqual({
					unresolvedVariables: [...ConfigurationResolverExpression.parse(url).unresolved()].length,
					beforeStart,
					blocked: result.state === McpConnectionState.Kind.Error && result.message.includes(reason),
					resolutions: resolution.callCount,
					transports: transports.length,
				}, {
					unresolvedVariables: 0,
					beforeStart: McpConnectionState.Kind.Error,
					blocked: true,
					resolutions: 0,
					transports: 0,
				});
			});

			for (const fragment of ['${', '${input:literal}']) {
				test(`blocks the resolved launch for ${host} with fragment ${fragment}`, async () => {
					const { server, resolution, transports } = createPolicyServer('https://${input:host}/mcp', `https://${host}/mcp#${fragment}`);
					const beforeStart = server.connectionState.get().state;
					const result = await server.start({ promptType: 'never', errorOnUserInteraction: true });

					assert.deepStrictEqual({
						beforeStart,
						blocked: result.state === McpConnectionState.Kind.Error && result.message.includes(reason),
						resolutions: resolution.callCount,
						transports: transports.length,
						connected: server.connection.get() !== undefined,
					}, {
						beforeStart: McpConnectionState.Kind.Stopped,
						blocked: true,
						resolutions: 1,
						transports: 0,
						connected: false,
					});
				});
			}
		}

		for (const url of ['https://trusted.example/mcp', 'https://trusted.example/mcp#${']) {
			test(`preserves unresolved definitions that resolve to ${url}`, async () => {
				const { server, resolution, transports } = createPolicyServer('https://${input:host}/mcp', url);
				const beforeStart = server.connectionState.get().state;
				const result = await server.start({ promptType: 'never', errorOnUserInteraction: true });
				const launch = server.connection.get()?.launchDefinition;

				assert.deepStrictEqual({
					beforeStart,
					afterStart: result.state,
					resolutions: resolution.callCount,
					transports: transports.length,
					resolvedUrl: launch?.type === McpServerTransportType.HTTP ? launch.uri.toString(true) : undefined,
				}, {
					beforeStart: McpConnectionState.Kind.Stopped,
					afterStart: McpConnectionState.Kind.Running,
					resolutions: 1,
					transports: 1,
					resolvedUrl: url,
				});
			});
		}

		test('stops a resolved URL with a literal variable marker when policy denies it', async () => {
			const { server, configurationService } = createPolicyServer('https://${input:host}/mcp', 'https://trusted.example/mcp#${input:literal}');
			const result = await server.start({ promptType: 'never', errorOnUserInteraction: true });
			const connection = server.connection.get();

			await configurationService.setUserConfiguration(mcpDeniedServersConfig, [{ serverUrl: 'https://trusted.example/*' }]);
			configurationService.onDidChangeConfigurationEmitter.fire({
				source: ConfigurationTarget.USER,
				affectedKeys: new Set([mcpDeniedServersConfig]),
				change: { keys: [mcpDeniedServersConfig], overrides: [] },
				affectsConfiguration: key => key === mcpDeniedServersConfig,
			});

			assert.deepStrictEqual({
				started: result.state,
				connected: server.connection.get() !== undefined,
				connectionState: connection?.state.get().state,
			}, {
				started: McpConnectionState.Kind.Running,
				connected: false,
				connectionState: McpConnectionState.Kind.Stopped,
			});
		});
	});

	test('first autostart waits for discovery and loads the newly discovered server tools', async () => {
		const { mcpService, registry } = createMcpService();
		const collection = registry.collections.get()[0];
		registry.collections.set([], undefined);
		const initialDiscovery = new DeferredPromise<void>();
		const discoveryStub = sinon.stub(registry, 'discoverCollections').callsFake(async () => {
			await initialDiscovery.p;
			registry.collections.set([collection], undefined);
			return [collection];
		});
		store.add(toDisposable(() => discoveryStub.restore()));
		registry.makeTestTransport = () => {
			const transport = new TestMcpMessageTransport();
			transport.setResponder('tools/list', message => ({
				jsonrpc: MCPLegacy.JSONRPC_VERSION,
				id: (message as MCPLegacy.JSONRPCRequest).id,
				result: { tools: [{ name: 'search_index', inputSchema: { type: 'object' } }] },
			}));
			return transport;
		};

		const autostart = mcpService.autostart();
		const beforeDiscovery = {
			working: autostart.get().working,
			serverCount: mcpService.servers.get().length,
		};
		await initialDiscovery.complete();
		const result = await waitForState(autostart, state => !state.working);

		assert.deepStrictEqual({
			beforeDiscovery,
			requiringInteraction: result.serversRequiringInteraction,
			servers: mcpService.servers.get().map(server => ({
				state: server.connectionState.get().state,
				toolCount: server.tools.get().length,
			})),
		}, {
			beforeDiscovery: { working: true, serverCount: 0 },
			requiringInteraction: [],
			servers: [{ state: McpConnectionState.Kind.Running, toolCount: 1 }],
		});
	});

	test('does not notify servers observers when the collection is unchanged', () => {
		const { mcpService, registry } = createMcpService();
		mcpService.updateCollectedServers();

		const observedServerCounts: number[] = [];
		store.add(autorun(reader => observedServerCounts.push(mcpService.servers.read(reader).length)));

		registry.collections.set([...registry.collections.get()], undefined);
		mcpService.updateCollectedServers();
		registry.collections.set([], undefined);
		mcpService.updateCollectedServers();

		assert.deepStrictEqual(observedServerCounts, [1, 0]);
	});

	test('does not stop a running server when an equivalent HTTP definition is published', async () => {
		const { mcpService, registry } = createMcpService();
		registry.makeTestTransport = () => {
			const transport = new TestMcpMessageTransport();
			transport.setResponder('tools/list', message => ({
				jsonrpc: MCPLegacy.JSONRPC_VERSION,
				id: (message as MCPLegacy.JSONRPCRequest).id,
				result: { tools: [] }
			}));
			return transport;
		};

		const uri = URI.parse('https://example.com/mcp');
		setServerDefinition(registry, {
			id: 'test-server',
			label: 'Test Server',
			launch: { type: McpServerTransportType.HTTP, uri, headers: [] },
			cacheNonce: 'a',
		});
		mcpService.updateCollectedServers();

		const server = mcpService.servers.get()[0];
		await server.start({ promptType: 'never', errorOnUserInteraction: true });
		await timeout(0);
		const stopStub = sinon.stub(server, 'stop').resolves();
		store.add(toDisposable(() => stopStub.restore()));
		// Populate the live definition's enumerable URI cache before publishing a fresh equivalent definition.
		uri.toString();

		setServerDefinition(registry, {
			id: 'test-server',
			label: 'Test Server',
			launch: { type: McpServerTransportType.HTTP, uri: URI.parse('https://example.com/mcp'), headers: [] },
			cacheNonce: 'a',
		});
		mcpService.updateCollectedServers();

		assert.deepStrictEqual({
			sameServer: mcpService.servers.get()[0] === server,
			stopCalls: stopStub.callCount,
		}, {
			sameServer: true,
			stopCalls: 0,
		});

		setServerDefinition(registry, {
			id: 'test-server',
			label: 'Test Server',
			launch: { type: McpServerTransportType.HTTP, uri: URI.parse('https://example.com/changed'), headers: [] },
			cacheNonce: 'a',
		});
		mcpService.updateCollectedServers();

		assert.strictEqual(stopStub.callCount, 1);
	});

	suite('2026-07-28 servers', () => {
		const calcTool: MCPLegacy.Tool = {
			name: 'calc',
			description: 'Adds numbers',
			inputSchema: { type: 'object', properties: {} },
			outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
		};

		interface IModernServerOptions {
			readonly transport?: ITestMcpTransportOptions;
			readonly tools?: MCPLegacy.Tool[];
			readonly listHint?: { ttlMs: number; cacheScope: 'public' | 'private' };
			readonly callResult?: MCPLegacy.CallToolResult;
		}

		const modernResult = (request: IJsonRpcRequest, result: object): JsonRpcMessage => ({ jsonrpc: MCP.JSONRPC_VERSION, id: request.id, result: { resultType: 'complete', ...result } });

		/** A service whose test server speaks 2026-07-28; every connection gets a fresh transport. */
		const createModernServer = (options: IModernServerOptions = {}) => {
			const { mcpService, registry } = createMcpService();
			const transports: TestMcpMessageTransport[] = [];
			registry.makeTestTransport = () => {
				const transport = new TestMcpMessageTransport({ era: 'modern', ...options.transport });
				transports.push(transport);
				transport.setResponder('tools/list', req => modernResult(req, { tools: options.tools ?? [], ...options.listHint }));
				transport.setResponder('prompts/list', req => modernResult(req, { prompts: [] }));
				transport.setResponder('tools/call', req => modernResult(req, options.callResult ?? { content: [] }));
				return transport;
			};
			mcpService.updateCollectedServers();
			return { mcpService, registry, server: mcpService.servers.get()[0], transports };
		};

		const startAndWaitForHandler = async (server: IMcpServer): Promise<McpServerRequestHandler> => {
			const state = await server.start({ promptType: 'never', errorOnUserInteraction: true });
			assert.strictEqual(state.state, McpConnectionState.Kind.Running);
			const connection = server.connection.get();
			assert.ok(connection, 'the server has a connection');
			const handler = await waitForState(connection.handler, Boolean);
			assert.ok(handler);
			return handler;
		};

		test('a 2026-07-28 server has the StatelessProtocol capability', async () => {
			const { server, transports } = createModernServer();
			const handler = await startAndWaitForHandler(server);
			assert.strictEqual(handler.era, 'modern');
			const capabilities = await waitForState(server.capabilities, c => c !== undefined);
			assert.ok(capabilities !== undefined);
			assert.strictEqual(capabilities & McpCapability.StatelessProtocol, McpCapability.StatelessProtocol);
			assert.strictEqual(capabilities & McpCapability.ToolsListChanged, McpCapability.ToolsListChanged);
			assert.strictEqual(capabilities & McpCapability.Completions, McpCapability.Completions);
			assert.strictEqual(transports[0].getSentRequests('initialize').length, 0);
		});

		test('a legacy server has no StatelessProtocol capability', async () => {
			const { mcpService, registry } = createMcpService();
			registry.makeTestTransport = () => {
				const transport = new TestMcpMessageTransport();
				transport.setResponder('tools/list', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: { tools: [] } }));
				return transport;
			};
			mcpService.updateCollectedServers();
			const server = mcpService.servers.get()[0];
			const handler = await startAndWaitForHandler(server);
			assert.strictEqual(handler.era, 'legacy');
			const capabilities = await waitForState(server.capabilities, c => c !== undefined);
			assert.strictEqual((capabilities ?? 0) & McpCapability.StatelessProtocol, 0);
			assert.deepStrictEqual(mcpService.getCachedEntry('test-server')?.protocol, { era: 'legacy', version: '2025-11-25' });
		});

		test('the cache remembers the protocol and the list freshness, and the next connection uses them as hints', async () => {
			const { mcpService, server, transports } = createModernServer({ tools: [calcTool], listHint: { ttlMs: 60_000, cacheScope: 'public' } });
			const first = await startAndWaitForHandler(server);
			await waitForState(server.tools, tools => tools.length === 1);

			const entry = mcpService.getCachedEntry('test-server');
			assert.deepStrictEqual(entry?.protocol, { era: 'modern', version: '2026-07-28' });
			assert.strictEqual(entry?.freshness?.tools?.ttlMs, 60_000);
			assert.strictEqual(entry?.freshness?.tools?.cacheScope, 'public');
			assert.strictEqual(typeof entry?.freshness?.tools?.receivedAt, 'number');
			assert.strictEqual(entry?.freshness?.prompts, undefined, 'a list without a hint stores no freshness');
			assert.strictEqual(first.lastNegotiation?.usedHint, false);

			await server.stop();
			const second = await startAndWaitForHandler(server);
			assert.notStrictEqual(second, first);
			assert.strictEqual(second.era, 'modern');
			assert.strictEqual(second.lastNegotiation?.usedHint, true);
			assert.strictEqual(transports.length, 2);
			// a modern hint pins the revision but server/discover is still needed for the capabilities
			assert.strictEqual(transports[1].getSentRequests('server/discover').length, 1);
			assert.strictEqual(transports[1].getSentRequests('initialize').length, 0);
		});

		/** Replaces the test server's definition with one that pins `protocolVersion` to `pin` (none when undefined); the launch and its nonce stay. */
		const setPin = (mcpService: McpService, registry: TestMcpRegistry, pin: string | undefined) => {
			const current = registry.collections.get()[0].serverDefinitions.get()[0];
			setServerDefinition(registry, { ...current, protocolVersionHint: pin });
			mcpService.updateCollectedServers();
		};
		const sentVersion = (request: IJsonRpcRequest | undefined) => (request?.params as { protocolVersion?: string } | undefined)?.protocolVersion;

		test('a pinned revision the server rejects falls back to negotiation, and the next start uses the negotiated revision instead of the pin', async () => {
			// The server speaks only 2026-07-28: it answers initialize with -32601.
			const { mcpService, registry, transports } = createModernServer({ tools: [calcTool], callResult: { content: [{ type: 'text', text: '3' }], structuredContent: { sum: 3 } } });
			setPin(mcpService, registry, '2025-11-25');
			const server = mcpService.servers.get()[0];
			assert.ok(server instanceof McpServer);
			const info = sinon.spy(server.logger, 'info');
			const bypassLogs = () => info.getCalls().map(call => String(call.args[0])).filter(message => message.includes('did not accept the configured protocolVersion'));

			const first = await startAndWaitForHandler(server);
			assert.deepStrictEqual({ era: first.era, version: first.protocolVersion }, { era: 'modern', version: '2026-07-28' });
			assert.deepStrictEqual(transports[0].getSentRequests().slice(0, 2).map(r => r.method), ['initialize', 'server/discover'], 'the pin first, then negotiation');
			assert.strictEqual(sentVersion(transports[0].getSentRequests('initialize')[0]), '2025-11-25');
			const [tool] = await waitForState(server.tools, tools => tools.length === 1);
			assert.deepStrictEqual((await tool.call({})).structuredContent, { sum: 3 }, 'the tools work over the negotiated revision');
			assert.deepStrictEqual(mcpService.getCachedEntry('test-server')?.protocol, { era: 'modern', version: '2026-07-28', pin: '2025-11-25' });
			assert.deepStrictEqual(bypassLogs(), [], 'the first start sends the pin, so nothing is bypassed yet');

			await server.stop();
			const second = await startAndWaitForHandler(server);
			assert.deepStrictEqual({ era: second.era, version: second.protocolVersion }, { era: 'modern', version: '2026-07-28' });
			assert.strictEqual(transports.length, 2);
			assert.strictEqual(transports[1].getSentRequests('initialize').length, 0, 'the rejected pin is not sent again');
			assert.strictEqual(transports[1].getSentRequests('server/discover').length, 1);
			assert.deepStrictEqual(bypassLogs(), ['Using MCP 2026-07-28, negotiated when the server did not accept the configured protocolVersion 2025-11-25; the pin is tried again when it or the server\'s connection settings change, or after MCP: Reset Cached Tools'], 'the log says that the configured pin is bypassed');

			// MCP: Reset Cached Tools forgets the negotiated revision: the pin is sent again.
			await server.stop();
			mcpService.resetCaches();
			await startAndWaitForHandler(server);
			assert.strictEqual(transports.length, 3);
			assert.deepStrictEqual(transports[2].getSentRequests().slice(0, 2).map(r => r.method), ['initialize', 'server/discover']);
			assert.strictEqual(sentVersion(transports[2].getSentRequests('initialize')[0]), '2025-11-25');
			assert.strictEqual(bypassLogs().length, 1, 'no bypass after the reset');
			info.restore();
		});

		test('a revision negotiated under another pin is no hint: a new pin is sent first, and without the pin the server is probed again', async () => {
			// A server that speaks both eras: it also accepts initialize.
			const { mcpService, registry, transports } = createModernServer();
			const makeModern = registry.makeTestTransport;
			registry.makeTestTransport = () => {
				const transport = makeModern();
				transport.setResponder('initialize', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: transport.defaultInitializeResult() }));
				return transport;
			};
			const server = mcpService.servers.get()[0];

			// Unpinned: probed, 2026-07-28.
			assert.strictEqual((await startAndWaitForHandler(server)).era, 'modern');
			assert.deepStrictEqual(mcpService.getCachedEntry('test-server')?.protocol, { era: 'modern', version: '2026-07-28' });
			await server.stop();

			// Pinned: the cached revision was negotiated without the pin, so the pin is sent; the server accepts it.
			setPin(mcpService, registry, '2025-11-25');
			const pinned = await startAndWaitForHandler(server);
			assert.deepStrictEqual({ era: pinned.era, version: pinned.protocolVersion }, { era: 'legacy', version: '2025-11-25' });
			assert.strictEqual(transports[1].getSentRequests()[0].method, 'initialize');
			assert.strictEqual(sentVersion(transports[1].getSentRequests('initialize')[0]), '2025-11-25');
			assert.strictEqual(transports[1].getSentRequests('server/discover').length, 0);
			assert.deepStrictEqual(mcpService.getCachedEntry('test-server')?.protocol, { era: 'legacy', version: '2025-11-25', pin: '2025-11-25' });
			await server.stop();

			// Unpinned again: the cached 2025-11-25 belonged to the pin, so it does not keep the server on the legacy revision.
			setPin(mcpService, registry, undefined);
			const unpinned = await startAndWaitForHandler(server);
			assert.strictEqual(unpinned.era, 'modern');
			assert.strictEqual(transports[2].getSentRequests()[0].method, 'server/discover');
			assert.strictEqual(transports[2].getSentRequests('initialize').length, 0);
		});

		test('a cached revision used without a pin, or for a pin the server accepted, is no bypassed pin: nothing is logged', async () => {
			// A server that speaks both eras: it also accepts initialize.
			const { mcpService, registry, transports } = createModernServer();
			const makeModern = registry.makeTestTransport;
			registry.makeTestTransport = () => {
				const transport = makeModern();
				transport.setResponder('initialize', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: transport.defaultInitializeResult() }));
				return transport;
			};
			const server = mcpService.servers.get()[0];
			assert.ok(server instanceof McpServer);
			const info = sinon.spy(server.logger, 'info');
			const bypassLogs = () => info.getCalls().map(call => String(call.args[0])).filter(message => message.includes('did not accept the configured protocolVersion'));
			try {
				// Unpinned, twice: the second start uses the cached 2026-07-28.
				await startAndWaitForHandler(server);
				await server.stop();
				const cachedUnpinned = await startAndWaitForHandler(server);
				assert.deepStrictEqual({ era: cachedUnpinned.era, usedHint: cachedUnpinned.lastNegotiation?.usedHint }, { era: 'modern', usedHint: true });
				await server.stop();

				// Pinned to a revision the server accepts, twice: the second start uses the 2025-11-25 cached for the pin.
				setPin(mcpService, registry, '2025-11-25');
				await startAndWaitForHandler(server);
				await server.stop();
				const cachedPinned = await startAndWaitForHandler(server);
				assert.deepStrictEqual({ era: cachedPinned.era, version: cachedPinned.protocolVersion, usedHint: cachedPinned.lastNegotiation?.usedHint }, { era: 'legacy', version: '2025-11-25', usedHint: true });
				assert.deepStrictEqual(mcpService.getCachedEntry('test-server')?.protocol, { era: 'legacy', version: '2025-11-25', pin: '2025-11-25' });
				assert.strictEqual(transports.length, 4);
				assert.strictEqual(transports[3].getSentRequests('server/discover').length, 0, 'the cached legacy revision skips the probe');

				assert.deepStrictEqual(bypassLogs(), []);
			} finally {
				info.restore();
			}
		});

		for (const cacheScope of ['public', 'private'] as const) {
			test(`a fresh ${cacheScope} tool list is ${cacheScope === 'public' ? 'reused' : 're-listed'} on reconnect`, async () => {
				const { server, transports } = createModernServer({ tools: [calcTool], listHint: { ttlMs: 60_000, cacheScope } });
				await startAndWaitForHandler(server);
				await waitForState(server.tools, tools => tools.length === 1);
				assert.strictEqual(transports[0].getSentRequests('tools/list').length, 1);

				await server.stop();
				await startAndWaitForHandler(server);
				await timeout(0);
				assert.strictEqual(transports[1].getSentRequests('tools/list').length, cacheScope === 'public' ? 0 : 1);
				assert.deepStrictEqual(server.tools.get().map(t => t.definition.name), ['calc']);
			});
		}

		test('an expired public tool list is re-listed on reconnect', async () => {
			const { server, transports } = createModernServer({ tools: [calcTool], listHint: { ttlMs: 0, cacheScope: 'public' } });
			await startAndWaitForHandler(server);
			await waitForState(server.tools, tools => tools.length === 1);
			await server.stop();
			await startAndWaitForHandler(server);
			await timeout(0);
			assert.strictEqual(transports[1].getSentRequests('tools/list').length, 1);
		});

		test('stopping a server while its tool and prompt lists are pending leaves no unhandled rejection', async () => {
			const unhandled: unknown[] = [];
			const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
			const onBrowserUnhandledRejection = (event: PromiseRejectionEvent) => onUnhandledRejection(event.reason);
			if (isWeb) {
				globalThis.addEventListener('unhandledrejection', onBrowserUnhandledRejection);
			} else {
				process.on('unhandledRejection', onUnhandledRejection);
			}
			try {
				const { mcpService, registry } = createMcpService();
				const toolsListed = new DeferredPromise<void>();
				const promptsListed = new DeferredPromise<void>();
				registry.makeTestTransport = () => {
					const transport = new TestMcpMessageTransport({ era: 'modern' });
					// tools/list and prompts/list are never answered: both stay pending.
					transport.setResponder('tools/list', () => { toolsListed.complete(); return undefined; });
					transport.setResponder('prompts/list', () => { promptsListed.complete(); return undefined; });
					return transport;
				};
				mcpService.updateCollectedServers();
				const server = mcpService.servers.get()[0];
				await startAndWaitForHandler(server);
				await Promise.all([toolsListed.p, promptsListed.p]);

				await server.stop(); // disposes the handler, which cancels the pending lists
				await timeout(0);
				await timeout(0);
				assert.deepStrictEqual(unhandled.map(String), []);
			} finally {
				if (isWeb) {
					globalThis.removeEventListener('unhandledrejection', onBrowserUnhandledRejection);
				} else {
					process.off('unhandledRejection', onUnhandledRejection);
				}
			}
		});

		test('structured content that does not match the output schema rejects the tool call', async () => {
			const { server } = createModernServer({ tools: [calcTool], callResult: { content: [{ type: 'text', text: 'nope' }], structuredContent: { sum: 'not a number' } } });
			await startAndWaitForHandler(server);
			const [tool] = await waitForState(server.tools, tools => tools.length === 1);

			await assert.rejects(tool.call({}), (e: unknown) => e instanceof MpcResponseError && e.code === MCPLegacy.INVALID_PARAMS && e.code === -32602);
		});

		test('structured content matching the output schema is returned', async () => {
			const { server } = createModernServer({ tools: [calcTool], callResult: { content: [{ type: 'text', text: '3' }], structuredContent: { sum: 3 } } });
			await startAndWaitForHandler(server);
			const [tool] = await waitForState(server.tools, tools => tools.length === 1);

			const result = await tool.call({});
			assert.deepStrictEqual(result.structuredContent, { sum: 3 });
		});

		test('an isError result skips the output schema check', async () => {
			const { server } = createModernServer({ tools: [calcTool], callResult: { isError: true, content: [{ type: 'text', text: 'failed' }], structuredContent: { sum: 'n/a' } } });
			await startAndWaitForHandler(server);
			const [tool] = await waitForState(server.tools, tools => tools.length === 1);

			const result = await tool.call({});
			assert.strictEqual(result.isError, true);
		});

		for (const completions of [false, true]) {
			test(`prompt completion is ${completions ? 'requested from' : 'skipped for'} a server ${completions ? 'with' : 'without'} the completions capability`, async () => {
				const { mcpService, registry } = createMcpService();
				const transports: TestMcpMessageTransport[] = [];
				registry.makeTestTransport = () => {
					const transport = new TestMcpMessageTransport({ initializeResult: { capabilities: completions ? { tools: {}, prompts: {}, completions: {} } : { tools: {}, prompts: {} } } });
					transports.push(transport);
					transport.setResponder('tools/list', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: { tools: [] } }));
					transport.setResponder('prompts/list', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: { prompts: [{ name: 'greet', arguments: [{ name: 'who' }] }] } }));
					transport.setResponder('completion/complete', req => ({ jsonrpc: MCPLegacy.JSONRPC_VERSION, id: req.id, result: { completion: { values: ['Ada', 'Alan'] } } }));
					return transport;
				};
				mcpService.updateCollectedServers();
				const server = mcpService.servers.get()[0];
				await startAndWaitForHandler(server);
				const [prompt] = await waitForState(server.prompts, prompts => prompts.length === 1);

				const values = await prompt.complete('who', 'A', {}, CancellationToken.None);
				assert.deepStrictEqual(values, completions ? ['Ada', 'Alan'] : []);
				assert.strictEqual(transports[0].getSentRequests('completion/complete').length, completions ? 1 : 0);
			});
		}
	});

	suite('schemas by revision, protocol failures and tool refresh', () => {
		class RecordingNotificationService extends TestNotificationService {
			readonly prompts: { readonly severity: Severity; readonly message: NotificationMessage; readonly choices: IPromptChoice[] }[] = [];
			readonly notifications: INotification[] = [];
			override prompt(severity: Severity, message: NotificationMessage, choices: IPromptChoice[]): INotificationHandle {
				this.prompts.push({ severity, message, choices });
				return new NoOpNotification();
			}
			override notify(notification: INotification): INotificationHandle {
				this.notifications.push(notification);
				return new NoOpNotification();
			}
		}

		class RecordingTelemetryService extends NullTelemetryServiceShape {
			readonly events: { readonly name: string; readonly data: unknown }[] = [];
			override publicLog2(eventName?: string, data?: unknown): void {
				this.events.push({ name: eventName ?? '', data });
			}
		}

		type Era = 'legacy' | 'modern';
		const result = (era: Era, request: IJsonRpcRequest, value: object): JsonRpcMessage => ({ jsonrpc: MCP.JSONRPC_VERSION, id: request.id, result: era === 'modern' ? { resultType: 'complete', ...value } : value });
		const error = (request: IJsonRpcRequest, code: number, message: string, data?: unknown): JsonRpcMessage => ({ jsonrpc: MCP.JSONRPC_VERSION, id: request.id, error: { code, message, data } });

		/** Starts the test server speaking `era`; `configure` adds responders to each new transport. */
		const startServer = async (era: Era, configure: (transport: TestMcpMessageTransport) => void, overrides: { readonly notificationService?: INotificationService; readonly telemetryService?: ITelemetryService; readonly beforeStart?: (server: IMcpServer) => void } = {}) => {
			const { mcpService, registry } = createMcpService(undefined, overrides);
			const transports: TestMcpMessageTransport[] = [];
			registry.makeTestTransport = () => {
				const transport = new TestMcpMessageTransport({ era });
				transports.push(transport);
				transport.setResponder('prompts/list', req => result(era, req, { prompts: [] }));
				configure(transport);
				return transport;
			};
			mcpService.updateCollectedServers();
			const server = mcpService.servers.get()[0];
			overrides.beforeStart?.(server);
			const state = await server.start({ promptType: 'never', errorOnUserInteraction: true });
			assert.strictEqual(state.state, McpConnectionState.Kind.Running);
			const connection = server.connection.get();
			assert.ok(connection);
			const handler = await waitForState(connection.handler, Boolean);
			assert.strictEqual(handler?.era, era);
			return { server, transports };
		};

		const plainTool = (name: string, extra: Partial<MCPLegacy.Tool> = {}): MCPLegacy.Tool => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, ...extra });

		test('tool input schemas are read by the revision the server speaks', async () => {
			const tools: MCPLegacy.Tool[] = [
				// a pattern the backtracking guard rejects and one that needs the non-unicode mode: kept in both eras
				plainTool('host', { inputSchema: { type: 'object', properties: { host: { type: 'string', pattern: '^([a-z0-9-]+\\.)+[a-z]{2,}$' }, phone: { type: 'string', pattern: '^\\d{3}\\-\\d{4}$' } } } }),
				// draft-07 tuple items without $schema: kept for 2025-11-25 (read as draft-07), not a 2020-12 schema
				plainTool('tuple', { inputSchema: { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } } }),
				// an unsupported dialect: a warning for 2025-11-25, the tool is dropped for 2026-07-28
				plainTool('draft04', { inputSchema: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} } }),
				// a remote reference is refused in both eras
				plainTool('remote', { inputSchema: { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } } }),
				// an unresolved local reference: kept with a warning for 2025-11-25, as before; the tool is dropped for 2026-07-28
				plainTool('localRef', { inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } } }),
			];
			for (const [era, expected] of [['legacy', ['draft04', 'host', 'localRef', 'tuple']], ['modern', ['host']]] as const) {
				const notificationService = new RecordingNotificationService();
				const { server } = await startServer(era, transport => transport.setResponder('tools/list', req => result(era, req, { tools })), { notificationService });
				const listed = await waitForState(server.tools, t => t.length > 0);
				assert.deepStrictEqual(listed.map(t => t.definition.name), expected, era);
				assert.strictEqual(notificationService.notifications.length, 1, `${era}: the omitted tools are reported once`);
			}
		});

		test('the patterns of the schemas of one tool list share one analysis budget: many tools with distinct heavy patterns take no more analysis than one schema may', async () => {
			// A long alternation of distinct characters, among the slowest patterns to analyze (about 10 ms each); `i` makes it distinct.
			const prefix = `list${Date.now()}-`;
			const heavy = (i: number) => `^${prefix}${i}:(?:${Array.from({ length: 2000 }, (_, k) => String.fromCharCode(0x4e00 + 2 * k)).join('|')})$`.slice(0, 4096);
			const tools = Array.from({ length: 30 }, (_, i) => plainTool(`heavy${i}`, {
				inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: heavy(i) } } },
				outputSchema: { type: 'object', properties: { id: { type: 'string', pattern: heavy(i) } } },
			}));
			// The tools whose patterns the budget covers, in the order of the list (an output schema repeats its tool's pattern: free).
			let left = DEFAULT_PATTERN_ANALYSIS_BUDGET;
			let covered = 0;
			while (covered < tools.length && analyzeRegexCost(heavy(covered), true)!.work <= left) {
				left -= analyzeRegexCost(heavy(covered), true)!.work;
				covered++;
			}
			assert.ok(covered > 0 && covered < 20, `${covered} patterns fit in the budget`);

			let warn: sinon.SinonSpy | undefined;
			const { server } = await startServer('modern', transport => transport.setResponder('tools/list', req => result('modern', req, { tools })), {
				beforeStart: started => {
					assert.ok(started instanceof McpServer);
					warn = sinon.spy(started.logger, 'warn');
				},
			});
			try {
				const listed = await waitForState(server.tools, t => t.length > 0);
				assert.strictEqual(listed.length, tools.length, 'a pattern that is not checked does not drop its tool');
				const refused = (schema: string) => warn!.getCalls().map(call => String(call.args[0])).filter(message => message.includes(`parts of its ${schema} schema are not checked`) && message.includes('share a budget')).map(message => message.split(':')[0]);
				const expected = tools.slice(covered).map(t => `Tool ${t.name}`);
				assert.deepStrictEqual({ input: refused('input'), output: refused('output') }, { input: expected, output: expected });
			} finally {
				warn?.restore();
			}
		});

		/**
		 * Tools whose output schemas have distinct heavy patterns (about 10 ms of analysis each), one more than the
		 * budget of a list covers: the last one's pattern is beyond the budget. Every call answers with an `id` that
		 * matches none of the patterns.
		 */
		const toolsBeyondTheBudget = (name: string) => {
			const prefix = `${name}${Date.now()}-`;
			const heavy = (i: number) => `^${prefix}${i}:(?:${Array.from({ length: 2000 }, (_, k) => String.fromCharCode(0x4e00 + 2 * k)).join('|')})$`.slice(0, 4096);
			let left = DEFAULT_PATTERN_ANALYSIS_BUDGET;
			let covered = 0;
			for (let work = analyzeRegexCost(heavy(0), true)!.work; work <= left; work = analyzeRegexCost(heavy(covered), true)!.work) {
				left -= work;
				covered++;
			}
			assert.ok(covered > 0 && covered < 20, `${covered} patterns fit in the budget`);
			const tools = Array.from({ length: covered + 1 }, (_, i) => plainTool(`heavy${i}`, { outputSchema: { type: 'object', properties: { id: { type: 'string', pattern: heavy(i) } } } }));
			const configure = (transport: TestMcpMessageTransport, listHint?: object) => {
				transport.setResponder('tools/list', req => result('modern', req, { tools, ...listHint }));
				transport.setResponder('tools/call', req => result('modern', req, { content: [], structuredContent: { id: 'matches no pattern' } }));
			};
			return { tools, covered, configure };
		};

		/** Calls the tool beyond the budget and a covered one: only the covered one's result is checked. */
		const assertCallsCheckWhatTheListChecked = async (listed: readonly IMcpTool[], covered: number) => {
			const tool = (name: string) => {
				const found = listed.find(t => t.definition.name === name);
				assert.ok(found, name);
				return found;
			};
			const beyond = await tool(`heavy${covered}`).call({});
			assert.deepStrictEqual(beyond.structuredContent, { id: 'matches no pattern' }, 'the pattern the list does not check is not checked for a call either');
			await assert.rejects(tool('heavy0').call({}), (e: unknown) => e instanceof MpcResponseError && e.code === MCPLegacy.INVALID_PARAMS && e.message.includes('does not match its output schema'));
		};

		test('a call checks its result with the output schema as its list read it: a pattern beyond the budget of the list is not checked for a call either, a covered one is', async () => {
			const { tools, covered, configure } = toolsBeyondTheBudget('call');
			let warn: sinon.SinonSpy | undefined;
			const { server } = await startServer('modern', transport => configure(transport), {
				beforeStart: started => {
					assert.ok(started instanceof McpServer);
					warn = sinon.spy(started.logger, 'warn');
				},
			});
			try {
				const listed = await waitForState(server.tools, t => t.length === tools.length);
				const refused = warn!.getCalls().map(call => String(call.args[0])).filter(message => message.includes('parts of its output schema are not checked') && message.includes('share a budget'));
				assert.deepStrictEqual(refused.map(message => message.split(':')[0]), [`Tool heavy${covered}`]);
				const runs = getPatternAnalysisRunCount();
				await assertCallsCheckWhatTheListChecked(listed, covered);
				await assertCallsCheckWhatTheListChecked(listed, covered);
				assert.strictEqual(getPatternAnalysisRunCount(), runs, 'the calls use what the list compiled: they analyze no pattern');
			} finally {
				warn?.restore();
			}
		});

		test('a tool list restored from storage is read again as it was read: its calls check what the list checked', async () => {
			const { tools, covered, configure } = toolsBeyondTheBudget('restored');
			const { mcpService, registry } = createMcpService();
			const transports: TestMcpMessageTransport[] = [];
			registry.makeTestTransport = () => {
				const transport = new TestMcpMessageTransport({ era: 'modern' });
				transports.push(transport);
				transport.setResponder('prompts/list', req => result('modern', req, { prompts: [] }));
				// A public list that stays fresh: the next connection reuses the cached one.
				configure(transport, { ttlMs: 60_000, cacheScope: 'public' });
				return transport;
			};
			mcpService.updateCollectedServers();
			const server = mcpService.servers.get()[0];
			await server.start({ promptType: 'never', errorOnUserInteraction: true });
			await waitForState(server.tools, t => t.length === tools.length);
			await server.stop();

			mcpService.restoreCachedEntry(server.definition.id);
			const state = await server.start({ promptType: 'never', errorOnUserInteraction: true });
			assert.strictEqual(state.state, McpConnectionState.Kind.Running);
			const handler = await waitForState(server.connection.get()!.handler, Boolean);
			assert.strictEqual(handler?.era, 'modern');
			const listed = await waitForState(server.tools, t => t.length === tools.length);
			assert.deepStrictEqual(transports.map(t => t.getSentRequests('tools/list').length), [1, 0], 'the restored list is reused');
			// The first call reads the restored list again (an analysis remembered from the first reading is not run again);
			// the later calls use what that reading compiled.
			const runs = getPatternAnalysisRunCount();
			await assertCallsCheckWhatTheListChecked(listed, covered);
			assert.ok(getPatternAnalysisRunCount() - runs <= tools.length, `${getPatternAnalysisRunCount() - runs} analyses`);
			const reread = getPatternAnalysisRunCount();
			await assertCallsCheckWhatTheListChecked(listed, covered);
			assert.strictEqual(getPatternAnalysisRunCount(), reread, 'the later calls analyze no pattern');
		});

		test('an output schema that does not compile: the result of a 2025-11-25 server is used unchecked, a 2026-07-28 result becomes isError', async () => {
			const calc = plainTool('calc', { outputSchema: { type: 'object', properties: { sum: { $ref: 'https://example.com/number.json' } } } });
			for (const era of ['legacy', 'modern'] as const) {
				const { server } = await startServer(era, transport => {
					transport.setResponder('tools/list', req => result(era, req, { tools: [calc] }));
					transport.setResponder('tools/call', req => result(era, req, { content: [{ type: 'text', text: '3' }], structuredContent: { sum: 3 } }));
				});
				const [tool] = await waitForState(server.tools, t => t.length === 1);
				const callResult = await tool.call({});
				if (era === 'legacy') {
					assert.deepStrictEqual(callResult.structuredContent, { sum: 3 });
					assert.strictEqual(callResult.isError, undefined);
				} else {
					assert.strictEqual(callResult.isError, true);
					assert.strictEqual(callResult.structuredContent, undefined);
				}
			}
		});

		test('-32020, -32021 and -32022 that the retries do not resolve are shown once as a notification with Show Output and no raw JSON', async () => {
			const failures: [code: number, data: unknown, expected: string][] = [
				[MCP.MISSING_REQUIRED_CLIENT_CAPABILITY, { requiredCapabilities: { elicitation: { url: {} } } }, 'elicitation.url'],
				[MCP.HEADER_MISMATCH, undefined, 'tools/call'],
				[MCP.UNSUPPORTED_PROTOCOL_VERSION, { supported: ['2026-07-28'], requested: '2026-07-28' }, '2026-07-28'],
			];
			for (const [code, data, expected] of failures) {
				const notificationService = new RecordingNotificationService();
				const { server } = await startServer('modern', transport => {
					transport.setResponder('tools/list', req => result('modern', req, { tools: [plainTool('echo')] }));
					transport.setResponder('tools/call', req => error(req, code, `failure ${code}`, data));
				}, { notificationService });
				const [tool] = await waitForState(server.tools, t => t.length === 1);

				await assert.rejects(tool.call({}), (e: unknown) => code === MCP.MISSING_REQUIRED_CLIENT_CAPABILITY
					? e instanceof McpClientError && e.reason === 'missing-capability' && e.message.includes('elicitation.url')
					: e instanceof MpcResponseError && e.code === code);
				await assert.rejects(tool.call({}));

				assert.strictEqual(notificationService.prompts.length, 1, `${code}: shown once per connection`);
				const [prompt] = notificationService.prompts;
				const message = typeof prompt.message === 'string' ? prompt.message : String(prompt.message);
				assert.strictEqual(prompt.severity, Severity.Error);
				assert.ok(message.includes('Test Server') && message.includes(expected), message);
				assert.ok(!message.includes('{') && !message.includes(`failure ${code}`), `no raw JSON or server text: ${message}`);
				assert.deepStrictEqual(prompt.choices.map(c => c.label), ['Show Output']);
			}
		});

		test('the -32020 notification says what happened to the tool list: refreshed (tools/call), not refreshable, or not involved (other methods)', async () => {
			for (const scenario of ['refreshed', 'refresh-failed', 'prompts/get'] as const) {
				const notificationService = new RecordingNotificationService();
				let lists = 0;
				const { server } = await startServer('modern', transport => {
					transport.setResponder('tools/list', req => ++lists > 1 && scenario === 'refresh-failed'
						? error(req, MCP.INTERNAL_ERROR, 'Listing is down')
						: result('modern', req, { tools: [plainTool('echo')] }));
					transport.setResponder('tools/call', req => error(req, MCP.HEADER_MISMATCH, 'Header mismatch'));
					transport.setResponder('prompts/list', req => result('modern', req, { prompts: [{ name: 'greet' }] }));
					transport.setResponder('prompts/get', req => error(req, MCP.HEADER_MISMATCH, 'Header mismatch'));
				}, { notificationService });
				if (scenario === 'prompts/get') {
					const [prompt] = await waitForState(server.prompts, p => p.length === 1);
					await assert.rejects(prompt.resolve({}), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.HEADER_MISMATCH);
				} else {
					const [tool] = await waitForState(server.tools, t => t.length === 1);
					await assert.rejects(tool.call({}), (e: unknown) => e instanceof MpcResponseError && e.code === MCP.HEADER_MISMATCH);
				}

				assert.strictEqual(notificationService.prompts.length, 1, scenario);
				const prompt = notificationService.prompts[0];
				const message = typeof prompt.message === 'string' ? prompt.message : String(prompt.message);
				switch (scenario) {
					case 'refreshed':
						assert.ok(message.includes('tools/call') && message.includes('even after the tool list was refreshed'), message);
						break;
					case 'refresh-failed':
						assert.ok(message.includes('tools/call') && message.includes('could not be refreshed') && !message.includes('even after'), message);
						break;
					case 'prompts/get':
						assert.ok(message.includes('prompts/get') && !message.includes('tool list'), message);
						break;
				}
			}
		});

		test('a renegotiation during the probe is published to telemetry with the negotiation', async () => {
			const telemetryService = new RecordingTelemetryService();
			let probes = 0;
			await startServer('modern', transport => {
				transport.setResponder('server/discover', req => ++probes === 1
					? error(req, MCP.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: ['2026-07-28'] })
					: result('modern', req, transport.defaultDiscoverResult()));
				transport.setResponder('tools/list', req => result('modern', req, { tools: [] }));
			}, { telemetryService });
			const protocolEvents = telemetryService.events.filter(e => e.name === 'mcp/protocolRenegotiation' || e.name === 'mcp/protocolNegotiation');
			assert.deepStrictEqual(protocolEvents.map(e => e.name), ['mcp/protocolRenegotiation', 'mcp/protocolNegotiation']);
			assert.deepStrictEqual(protocolEvents[0].data, { code: MCP.UNSUPPORTED_PROTOCOL_VERSION, retried: true });
		});

		test('a tools/list_changed during a call is followed by a completed listing before the call resolves (#261611)', async () => {
			let lists = 0;
			const relist = new DeferredPromise<void>();
			const { server, transports } = await startServer('modern', transport => {
				transport.setResponder('tools/list', req => {
					if (++lists === 1) {
						return result('modern', req, { tools: [plainTool('a')] });
					}
					relist.p.then(() => transport.simulateReceiveMessage(result('modern', req, { tools: [plainTool('a'), plainTool('b')] })));
					return undefined;
				});
				transport.setResponder('tools/call', req => [
					{ jsonrpc: MCP.JSONRPC_VERSION, method: 'notifications/tools/list_changed' },
					result('modern', req, { content: [] }),
				]);
			});
			const [tool] = await waitForState(server.tools, t => t.length === 1);
			let settled = false;
			const call = tool.call({}).finally(() => settled = true);
			await timeout(TOOL_LIST_CHANGE_GRACE_MS + 50);
			assert.strictEqual(transports[0].getSentRequests('tools/list').length, 2, 'the change starts a listing');
			assert.strictEqual(settled, false, 'the call waits for the listing, past the grace window');
			relist.complete();
			await call;
			assert.deepStrictEqual(server.tools.get().map(t => t.definition.name), ['a', 'b'], 'the next model turn sees the new list');
		});

		test('a tools/list_changed that arrives after the call result is listed before the call resolves (#261611)', () => runWithFakedTimers({ maxTaskCount: 10_000 }, async () => {
			let lists = 0;
			const { server, transports } = await startServer('modern', transport => {
				transport.setResponder('tools/list', req => {
					const tools = ++lists === 1 ? [plainTool('login')] : [plainTool('login'), plainTool('secret')];
					setTimeout(() => transport.simulateReceiveMessage(result('modern', req, { tools })), 30);
					return undefined;
				});
				transport.setResponder('tools/call', req => {
					// the server announces the change on its listen stream after it answered the call
					const listenId = transport.getSentRequests('subscriptions/listen')[0].id;
					setTimeout(() => transport.simulateListenEvent(listenId, 'notifications/tools/list_changed'), 20);
					return result('modern', req, { content: [] });
				});
			});
			const [tool] = await waitForState(server.tools, t => t.length === 1);
			const started = Date.now();
			await tool.call({});
			assert.deepStrictEqual(server.tools.get().map(t => t.definition.name), ['login', 'secret'], 'the next model turn sees the new list');
			assert.strictEqual(transports[0].getSentRequests('tools/list').length, 2);
			assert.ok(Date.now() - started < TOOL_LIST_CHANGE_GRACE_MS, 'a completed re-list ends the wait before the grace window');
		}));

		test('without a change, the call of a server that announces changes waits the grace window; one that does not announce them does not wait', () => runWithFakedTimers({ maxTaskCount: 10_000 }, async () => {
			for (const era of ['modern', 'legacy'] as const) {
				const { server } = await startServer(era, transport => {
					transport.setResponder('tools/list', req => result(era, req, { tools: [plainTool('echo')] }));
					transport.setResponder('tools/call', req => result(era, req, { content: [] }));
				});
				const [tool] = await waitForState(server.tools, t => t.length === 1);
				const started = Date.now();
				await tool.call({});
				const waited = Date.now() - started;
				// the 2026-07-28 test server declares tools.listChanged; the 2025-11-25 one does not
				assert.ok(era === 'modern' ? waited >= TOOL_LIST_CHANGE_GRACE_MS : waited < TOOL_LIST_CHANGE_GRACE_MS, `${era}: waited ${waited} ms`);
			}
		}));

		test('waiting for the tool list does not hang when there is no live tool list', async () => {
			const { mcpService } = createMcpService();
			mcpService.updateCollectedServers();
			const server = mcpService.servers.get()[0] as McpServer;
			assert.strictEqual(await raceTimeout(server.awaitToolRefresh().then(() => true), 1000), true);
		});

		test('a cancelled tool call stops waiting for a tool list that does not complete (#261611)', async () => {
			let lists = 0;
			const started = await startServer('modern', transport => {
				// the re-list the change starts is never answered
				transport.setResponder('tools/list', req => ++lists === 1 ? result('modern', req, { tools: [plainTool('a')] }) : undefined);
				transport.setResponder('tools/call', req => [
					{ jsonrpc: MCP.JSONRPC_VERSION, method: 'notifications/tools/list_changed' },
					result('modern', req, { content: [] }),
				]);
			});
			const server = started.server as McpServer;
			const transports = started.transports;
			const [tool] = await waitForState(server.tools, t => t.length === 1);
			const refresh = sinon.spy(server, 'awaitToolRefresh');
			const cts = new CancellationTokenSource();
			try {
				const call = tool.call({}, undefined, cts.token);
				await timeout(TOOL_LIST_CHANGE_GRACE_MS + 50);
				assert.strictEqual(transports[0].getSentRequests('tools/list').length, 2, 'the change starts a listing');
				assert.strictEqual(refresh.firstCall?.args[0], cts.token, 'the call waits with its token');

				const waiting = server.awaitToolRefresh(cts.token);
				cts.cancel();
				await assert.rejects(call, (e: unknown) => isCancellationError(e));
				assert.strictEqual(await raceTimeout(Promise.all([refresh.firstCall.returnValue, waiting]).then(() => true), 1000), true, 'the waits end with the token');
				assert.strictEqual(await raceTimeout(server.awaitToolRefresh(cts.token).then(() => true), 1000), true, 'a cancelled token does not wait');
			} finally {
				refresh.restore();
				cts.dispose();
			}
		});
	});
});
