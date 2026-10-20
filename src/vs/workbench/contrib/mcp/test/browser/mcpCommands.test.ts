/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { constObservable } from '../../../../../base/common/observable.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { McpServerStatus } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IMcpServerConfiguration } from '../../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IInputOptions, IQuickInputService, IQuickPickItem, QuickPickInput } from '../../../../../platform/quickinput/common/quickInput.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { IChatWidgetService } from '../../../chat/browser/chat.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IMcpWorkspaceInstallTargetService } from '../../../../services/mcp/common/mcpWorkspaceInstallTargetService.js';
import { McpAddConfigurationCommand } from '../../browser/mcpCommandsAddConfiguration.js';
import { IAgentHostCustomizationService } from '../../../chat/browser/agentSessions/agentHost/agentHostCustomizationService.js';
import { AICustomizationManagementCommands, AICustomizationManagementSection } from '../../../chat/common/aiCustomizationWorkspaceService.js';
import { ContributionEnablementState } from '../../../chat/common/enablement.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { findLocalMcpServer, McpBrowseCommand, McpBrowsePageCommand, ShowInstalledMcpServersCommand } from '../../browser/mcpCommands.js';
import { IMcpServer, IMcpService, InstalledMcpServersViewId } from '../../common/mcpTypes.js';

type AgentHostMcpServer = ReturnType<IAgentHostCustomizationService['getMcpServers']>[number];

class TestMcpServer extends mock<IMcpServer>() {
	override readonly definition;
	override readonly enablement = constObservable(ContributionEnablementState.EnabledProfile);

	constructor(id: string, label: string) {
		super();
		this.definition = { id, label };
	}
}

class TestMcpService extends mock<IMcpService>() {
	override readonly servers;

	constructor(servers: readonly IMcpServer[]) {
		super();
		this.servers = constObservable(servers);
	}
}

function agentHostServer(id: string, name: string): AgentHostMcpServer {
	return {
		id,
		name,
		enabled: true,
		status: McpServerStatus.Ready,
		state: { kind: McpServerStatus.Ready },
		setEnabled() { },
		start: async () => { },
		stop: async () => { },
	};
}

suite('MCP commands', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('findLocalMcpServer matches exact, unambiguous definition IDs and labels', () => {
		const byId = new TestMcpServer('extension.server', 'Extension Server');
		const byLabel = new TestMcpServer('other.server', 'Other Server');
		const duplicateLabel = new TestMcpServer('duplicate.server', 'Duplicate');
		const otherDuplicateLabel = new TestMcpServer('other.duplicate.server', 'Duplicate');
		const service = new TestMcpService([byId, byLabel, duplicateLabel, otherDuplicateLabel]);

		assert.deepStrictEqual({
			byId: findLocalMcpServer(service, agentHostServer('session-id/extension.server', 'Different Name'))?.definition.id,
			byLabel: findLocalMcpServer(service, agentHostServer('unmatched', 'Other Server'))?.definition.id,
			caseMismatch: findLocalMcpServer(service, agentHostServer('unmatched', 'other server'))?.definition.id,
			ambiguousLabel: findLocalMcpServer(service, agentHostServer('unmatched', 'Duplicate'))?.definition.id,
			unmatched: findLocalMcpServer(service, agentHostServer('unmatched', 'Missing'))?.definition.id,
		}, {
			byId: 'extension.server',
			byLabel: 'other.server',
			caseMismatch: undefined,
			ambiguousLabel: undefined,
			unmatched: undefined,
		});
	});

	suite('add server', () => {
		interface IAddServerRun {
			readonly serverTypes: { readonly label: string; readonly iconClass: string | undefined }[];
			readonly urlValidation: (string | undefined)[];
			readonly telemetry: unknown[];
			readonly agentHostAdds: unknown[];
			readonly error: string | undefined;
		}

		/** Runs the Add Server command, picking gRPC and then {@link installTarget}, with {@link answers} to its inputs. */
		async function runAddServer(answers: (string | undefined)[], installTarget?: string): Promise<IAddServerRun> {
			const instantiationService = store.add(new TestInstantiationService());
			const serverTypes: { label: string; iconClass: string | undefined }[] = [];
			const urlValidation: (string | undefined)[] = [];
			const telemetry: unknown[] = [];
			const agentHostAdds: unknown[] = [];
			let pickCount = 0;
			instantiationService.stub(IQuickInputService, upcastPartial<IQuickInputService>({
				pick: (async (picks: QuickPickInput<IQuickPickItem>[]) => {
					const items = picks.filter((item): item is IQuickPickItem => item.type !== 'separator');
					if (pickCount++ === 0) {
						serverTypes.push(...items.map(item => ({ label: item.label, iconClass: item.iconClass })));
						return items.find(item => item.label === 'gRPC');
					}
					return items.find(item => item.label === installTarget);
				}) as IQuickInputService['pick'],
				input: async (options?: IInputOptions) => {
					if (options?.validateInput && urlValidation.length === 0) {
						for (const value of ['grpc://localhost:50051', 'GRPCS://example.com', '${input:url}', 'https://example.com/mcp', 'localhost:50051']) {
							const result = await options.validateInput(value);
							urlValidation.push(typeof result === 'string' || result === undefined || result === null ? result ?? undefined : result.content);
						}
					}
					return answers.shift();
				},
			}));
			instantiationService.stub(ICommandService, upcastPartial<ICommandService>({ executeCommand: async () => undefined }));
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(ITelemetryService, upcastPartial<ITelemetryService>({ publicLog2: (event: string, data?: unknown) => { telemetry.push([event, data]); } }));
			instantiationService.stub(IChatWidgetService, upcastPartial<IChatWidgetService>({
				lastFocusedWidget: { viewModel: { sessionResource: URI.from({ scheme: 'agent-host-copilotcli', path: '/session' }) } } as unknown as IChatWidgetService['lastFocusedWidget'],
				getAllWidgets: () => [],
			}));
			instantiationService.stub(IWorkbenchEnvironmentService, upcastPartial<IWorkbenchEnvironmentService>({ remoteAuthority: undefined }));
			instantiationService.stub(IWorkspaceContextService, upcastPartial<IWorkspaceContextService>({ getWorkbenchState: () => WorkbenchState.EMPTY }));
			instantiationService.stub(IMcpWorkspaceInstallTargetService, upcastPartial<IMcpWorkspaceInstallTargetService>({ getTargets: () => [] }));
			instantiationService.stub(IAgentHostCustomizationService, upcastPartial<IAgentHostCustomizationService>({
				addMcpServer: (session: URI, name: string, config: IMcpServerConfiguration) => { agentHostAdds.push({ session: session.toString(), name, config }); },
			}));

			let error: string | undefined;
			try {
				await instantiationService.createInstance(McpAddConfigurationCommand, undefined).run();
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			return { serverTypes, urlValidation, telemetry, agentHostAdds, error };
		}

		const invalidGrpcUrl = 'The URL must start with \'grpc://\' or \'grpcs://\'.';

		test('offers gRPC with an icon and validates grpc:// and grpcs:// URLs', async () => {
			const result = await runAddServer(['  grpcs://localhost:50051  ', undefined]);

			assert.deepStrictEqual({
				serverTypes: result.serverTypes.filter(type => type.iconClass !== undefined).map(type => type.label),
				grpcIcon: result.serverTypes.find(type => type.label === 'gRPC')?.iconClass,
				urlValidation: result.urlValidation,
				telemetry: result.telemetry,
				error: result.error,
			}, {
				serverTypes: ['Command (stdio)', 'HTTP (HTTP or Server-Sent Events)', 'gRPC'],
				grpcIcon: 'codicon codicon-plug',
				urlValidation: [undefined, undefined, undefined, invalidGrpcUrl, invalidGrpcUrl],
				telemetry: [['mcp.addserver', { packageType: 'grpc' }]],
				error: undefined,
			});
		});

		test('rejects adding a gRPC server to an agent session', async () => {
			const result = await runAddServer(['grpcs://localhost:50051', 'grpc-server'], 'Add to Current Agent Session');

			assert.deepStrictEqual({ agentHostAdds: result.agentHostAdds, error: result.error }, {
				agentHostAdds: [],
				error: 'gRPC servers cannot be added to an agent session. Add it to a VS Code configuration file instead.',
			});
		});
	});

	test('browse command opens the MCP customizations marketplace', async () => {
		const instantiationService = store.add(new TestInstantiationService());
		const calls: { id: string; args: unknown[] }[] = [];
		instantiationService.stub(ICommandService, new class extends mock<ICommandService>() {
			override executeCommand<R = unknown>(id: string, ...args: unknown[]): Promise<R | undefined> {
				calls.push({ id, args });
				return Promise.resolve(undefined);
			}
		}());

		await instantiationService.invokeFunction(accessor => new McpBrowseCommand().run(accessor));

		assert.deepStrictEqual(calls, [{
			id: AICustomizationManagementCommands.OpenMarketplace,
			args: [AICustomizationManagementSection.McpServers],
		}]);
	});

	test('extensions browse action searches for MCP servers', async () => {
		const instantiationService = store.add(new TestInstantiationService());
		const searches: string[] = [];
		instantiationService.stub(IExtensionsWorkbenchService, new class extends mock<IExtensionsWorkbenchService>() {
			override openSearch(searchValue: string): Promise<void> {
				searches.push(searchValue);
				return Promise.resolve();
			}
		}());

		await instantiationService.invokeFunction(accessor => new McpBrowsePageCommand().run(accessor));

		assert.deepStrictEqual(searches, ['@mcp ']);
	});

	test('show installed resets the Extensions search before opening the view', async () => {
		const instantiationService = store.add(new TestInstantiationService());
		const calls: string[] = [];
		instantiationService.stub(IExtensionsWorkbenchService, new class extends mock<IExtensionsWorkbenchService>() {
			override openSearch(searchValue: string): Promise<void> {
				calls.push(`search:${searchValue}`);
				return Promise.resolve();
			}
		}());
		instantiationService.stub(IViewsService, upcastPartial<IViewsService>({
			openView: async id => {
				calls.push(`view:${id}`);
				return null;
			}
		}));

		await instantiationService.invokeFunction(accessor => new ShowInstalledMcpServersCommand().run(accessor));

		assert.deepStrictEqual(calls, ['search:', `view:${InstalledMcpServersViewId}`]);
	});
});
