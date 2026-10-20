/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout } from '../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../platform/instantiation/common/serviceCollection.js';
import { ILogger, ILogService, LogLevel } from '../../../platform/log/common/log.js';
import { eraForProtocolVersion, LATEST_MCP_PROTOCOL_VERSION, McpProtocolEra } from '../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCPLegacy } from '../../../platform/mcp/common/modelContextProtocolLegacy.js';
import product from '../../../platform/product/common/product.js';
import { IProductService } from '../../../platform/product/common/productService.js';
import { validateElicitFormContent } from '../../contrib/mcp/common/mcpProtocolMeta.js';
import { McpServerRequestHandler } from '../../contrib/mcp/common/mcpServerRequestHandler.js';
import { McpTaskManager } from '../../contrib/mcp/common/mcpTaskManager.js';
import { IMcpClientMethods, McpServerTransportHTTP, McpServerTransportType } from '../../contrib/mcp/common/mcpTypes.js';
import { McpHTTPHandle } from '../common/extHostMcp.js';
import { CONFORMANCE_LAUNCH_OAUTH, createConformanceOAuthClient, createConformanceTokenSource } from './mcpConformanceOAuth.js';
import { ConformanceMainThreadMcp, IConformanceContext, IConformanceTokenSource, InProcessMcpTransport, parseConformanceContext, StderrLogger } from './mcpConformanceProxy.js';
import { IScenarioClient, resolveScenario, schemaDefaults } from './mcpConformanceScenarios.js';

/**
 * The MCP conformance client: the official suite spawns it as
 * `<command> <server-url>` with the scenario in `MCP_CONFORMANCE_SCENARIO`, and
 * it drives VS Code's real client code (the workbench protocol engine over the
 * extension-host Streamable HTTP transport) against the scenario server. It
 * writes nothing to stdout and exits 0 when the scenario ran.
 */

export const enum ConformanceExitCode {
	Ok = 0,
	Failed = 1,
	UnknownScenario = 2,
}

/** How long one request (and the handshake) may take before the client gives up on it. */
export const REQUEST_TIMEOUT_MS = 20_000;

export const SCENARIO_ENV = 'MCP_CONFORMANCE_SCENARIO';
export const CONTEXT_ENV = 'MCP_CONFORMANCE_CONTEXT';
export const PROTOCOL_VERSION_ENV = 'MCP_CONFORMANCE_PROTOCOL_VERSION';
/** `trace`, `debug`, `info`, `warn` or `error`; the default is `info`. */
export const LOG_LEVEL_ENV = 'MCP_CONFORMANCE_LOG_LEVEL';

export const DEFAULT_SCENARIO = 'tools_call';

export interface IConformanceArgs {
	readonly serverUrl: string;
	readonly scenario: string;
	readonly protocolVersion: string;
	readonly era: McpProtocolEra;
	readonly context: IConformanceContext;
	readonly logLevel: LogLevel;
}

export type ConformanceArgsResult =
	| { readonly ok: true; readonly args: IConformanceArgs }
	| { readonly ok: false; readonly error: string };

export type ConformanceEnv = Readonly<Record<string, string | undefined>>;

function parseLogLevel(value: string | undefined): LogLevel {
	switch (value?.toLowerCase()) {
		case 'trace': return LogLevel.Trace;
		case 'debug': return LogLevel.Debug;
		case 'warn':
		case 'warning': return LogLevel.Warning;
		case 'error': return LogLevel.Error;
		default: return LogLevel.Info;
	}
}

/**
 * Reads the server URL (the last argument) and the scenario, protocol version
 * and context from the environment, the way the suite passes them.
 */
export function parseArgs(argv: readonly string[], env: ConformanceEnv): ConformanceArgsResult {
	const positional = argv.filter(arg => !arg.startsWith('--'));
	const serverUrl = positional[positional.length - 1];
	if (!serverUrl) {
		return { ok: false, error: 'usage: mcpConformanceClientMain.js <server-url>' };
	}
	try {
		const parsed = new URL(serverUrl);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return { ok: false, error: `The server URL must be http(s): ${serverUrl}` };
		}
	} catch {
		return { ok: false, error: `The server URL is not a URL: ${serverUrl}` };
	}
	const protocolVersion = env[PROTOCOL_VERSION_ENV] || LATEST_MCP_PROTOCOL_VERSION;
	const era = eraForProtocolVersion(protocolVersion);
	if (!era) {
		return { ok: false, error: `${PROTOCOL_VERSION_ENV} names a revision this client does not speak: ${protocolVersion}` };
	}
	return {
		ok: true,
		args: {
			serverUrl,
			scenario: env[SCENARIO_ENV] || DEFAULT_SCENARIO,
			protocolVersion,
			era,
			context: parseConformanceContext(env[CONTEXT_ENV]),
			logLevel: parseLogLevel(env[LOG_LEVEL_ENV]),
		},
	};
}

export interface IConformanceServices extends IDisposable {
	readonly instantiationService: IInstantiationService;
	readonly logger: ILogger;
	readonly logService: ILogService;
}

/** The one stderr logger is also the log service the transport asks for its level. */
class StderrLogService extends StderrLogger implements ILogService {
	declare readonly _serviceBrand: undefined;
}

/** The minimal services the protocol engine and the transport need: the product and a stderr logger. */
export function createConformanceServices(logLevel: LogLevel, writeStderr: (line: string) => void): IConformanceServices {
	const disposables = new DisposableStore();
	const logService = disposables.add(new StderrLogService(writeStderr, logLevel));
	const logger: ILogger = logService;
	const productService: IProductService = { _serviceBrand: undefined, ...product };
	const services = new ServiceCollection();
	services.set(IProductService, productService);
	services.set(ILogService, logService);
	const instantiationService = disposables.add(new InstantiationService(services, true));
	return {
		instantiationService,
		logger,
		logService,
		dispose: () => disposables.dispose(),
	};
}

/** The sampling answer the client gives every server. */
export const SAMPLING_ANSWER: MCPLegacy.CreateMessageResult = {
	role: 'assistant',
	content: { type: 'text', text: 'Hello from the conformance client' },
	model: 'conformance-model',
	stopReason: 'endTurn',
};

/** The values the client fills into a form elicitation for the fields of these names that the schema has and that carry no default. */
const FORM_ANSWERS: Readonly<Record<string, unknown>> = { confirmed: true, name: 'Alice' };

/** The content the client submits for a form elicitation: the schema defaults, plus the fixed answers for the known fields. */
export function formElicitationContent(requestedSchema: unknown): Record<string, unknown> {
	const content: Record<string, unknown> = {};
	const properties = typeof requestedSchema === 'object' && requestedSchema !== null ? (requestedSchema as { properties?: unknown }).properties : undefined;
	if (typeof properties === 'object' && properties !== null) {
		for (const [name, value] of Object.entries(FORM_ANSWERS)) {
			if (Object.prototype.hasOwnProperty.call(properties, name)) {
				content[name] = value;
			}
		}
	}
	return { ...content, ...schemaDefaults(requestedSchema) };
}

/** How the client answers the server's input requests: forms with their defaults, URLs declined, sampling with a fixed answer. */
export function createClientMethods(logger: ILogger): IMcpClientMethods {
	return {
		async elicitationRequestHandler(req) {
			if (req.mode === 'url') {
				logger.info(`Declining the URL elicitation ${req.elicitationId} (${req.url})`);
				return { action: 'decline' };
			}
			const content = formElicitationContent(req.requestedSchema);
			const validation = validateElicitFormContent(content, req.requestedSchema);
			if (!validation.ok) {
				throw new Error(`The form answer does not match the requested schema: ${validation.message}`);
			}
			logger.info(`Accepting the form elicitation with ${JSON.stringify(validation.content)}`);
			return { action: 'accept', content: validation.content as MCPLegacy.ElicitResult['content'] };
		},
		async createMessageRequestHandler() {
			logger.info('Answering the sampling request');
			return SAMPLING_ANSWER;
		},
	};
}

export const CONFORMANCE_ROOTS: MCPLegacy.Root[] = [{ uri: 'file:///workspace', name: 'workspace' }];

/** Runs `fn` with a token that is cancelled after {@link REQUEST_TIMEOUT_MS}; a timeout rejects with a descriptive error. */
async function withRequestTimeout<T>(label: string, fn: (token: CancellationToken) => Promise<T>): Promise<T> {
	const cts = new CancellationTokenSource();
	let timedOut = false;
	const timer = disposableTimeout(() => {
		timedOut = true;
		cts.cancel();
	}, REQUEST_TIMEOUT_MS);
	try {
		return await fn(cts.token);
	} catch (e) {
		if (timedOut && e instanceof CancellationError) {
			throw new Error(`${label} did not complete within ${REQUEST_TIMEOUT_MS}ms`);
		}
		throw e;
	} finally {
		timer.dispose();
		cts.dispose();
	}
}

function createScenarioClient(handler: McpServerRequestHandler, context: IConformanceContext): IScenarioClient {
	return {
		context,
		listTools: () => withRequestTimeout('tools/list', token => handler.listTools(undefined, token)),
		callTool: (name, args) => withRequestTimeout(`tools/call ${name}`, token => handler.callTool({ name, arguments: args }, token)),
		listResources: () => withRequestTimeout('resources/list', token => handler.listResources(undefined, token)),
		readResource: uri => withRequestTimeout(`resources/read ${uri}`, token => handler.readResource({ uri }, token)),
		listPrompts: () => withRequestTimeout('prompts/list', token => handler.listPrompts(undefined, token)),
		getPrompt: (name, args) => withRequestTimeout(`prompts/get ${name}`, token => handler.getPrompt({ name, arguments: args }, token)),
	};
}

export interface IConformanceMainOptions {
	/** Receives every stderr line (defaults to `process.stderr`). */
	readonly writeStderr?: (line: string) => void;
	/** Bearer tokens for the authorization scenarios; defaults to the conformance OAuth client (mcpConformanceOAuth.ts). */
	readonly tokenSource?: IConformanceTokenSource;
	/** Overrides the transport handle (tests). */
	readonly createHandle?: (id: number, launch: McpServerTransportHTTP, proxy: ConformanceMainThreadMcp, logService: ILogService) => McpHTTPHandle;
}

const HANDLE_ID = 1;

/** Runs one scenario. Never writes to stdout; returns the process exit code. */
export async function main(argv: readonly string[], env: ConformanceEnv, options: IConformanceMainOptions = {}): Promise<ConformanceExitCode> {
	const writeStderr = options.writeStderr ?? (line => { process.stderr.write(line); });
	const parsed = parseArgs(argv, env);
	if (!parsed.ok) {
		writeStderr(`[mcp-conformance] ${parsed.error}\n`);
		return ConformanceExitCode.Failed;
	}
	const { args } = parsed;
	const driver = resolveScenario(args.scenario);
	if (!driver) {
		writeStderr(`[mcp-conformance] The scenario ${args.scenario} is not implemented by this client\n`);
		return ConformanceExitCode.UnknownScenario;
	}

	const services = createConformanceServices(args.logLevel, writeStderr);
	const disposables = new DisposableStore();
	disposables.add(services);
	const { logger, logService, instantiationService } = services;
	logger.info(`Scenario ${args.scenario} (${driver.description}) against ${args.serverUrl} at MCP ${args.protocolVersion}`);

	try {
		const proxy = disposables.add(new ConformanceMainThreadMcp());
		if (options.tokenSource) {
			proxy.tokenSource = options.tokenSource;
		} else {
			// Every authorization scenario runs through the product's OAuth rule set.
			const oauthClient = disposables.add(createConformanceOAuthClient({
				context: args.context,
				protocolVersion: args.protocolVersion,
				log: (level, message) => {
					switch (level) {
						case 'error': logger.error(`[oauth] ${message}`); break;
						case 'warn': logger.warn(`[oauth] ${message}`); break;
						default: logger.info(`[oauth] ${message}`); break;
					}
				},
			}));
			proxy.tokenSource = createConformanceTokenSource(oauthClient);
		}
		const launch: McpServerTransportHTTP = { type: McpServerTransportType.HTTP, uri: URI.parse(args.serverUrl), headers: [], oauth: CONFORMANCE_LAUNCH_OAUTH };
		const createHandle = options.createHandle ?? ((id, l, p, log) => new McpHTTPHandle(id, l, p, log, true));
		const transport = disposables.add(new InProcessMcpTransport(HANDLE_ID, proxy, () => createHandle(HANDLE_ID, launch, proxy, logService), message => logger.warn(message)));
		disposables.add(transport.onDidLog(e => {
			switch (e.level) {
				case LogLevel.Trace: logger.trace(e.message); break;
				case LogLevel.Debug: logger.debug(e.message); break;
				case LogLevel.Info: logger.info(e.message); break;
				case LogLevel.Warning: logger.warn(e.message); break;
				case LogLevel.Error: logger.error(e.message); break;
			}
		}));

		const taskManager = disposables.add(new McpTaskManager());
		const handler = await withRequestTimeout('the protocol handshake', token => McpServerRequestHandler.create(instantiationService, {
			launch: transport,
			logger,
			taskManager,
			transportType: McpServerTransportType.HTTP,
			negotiationHint: { era: args.era, protocolVersion: args.protocolVersion, strict: true },
			defaultServerInfo: { name: 'conformance-server', version: '0.0.0' },
			...createClientMethods(logger),
		}, token));
		disposables.add(handler);
		handler.roots = CONFORMANCE_ROOTS;

		await driver.run(createScenarioClient(handler, args.context));
		logger.info(`Scenario ${args.scenario} completed`);
		transport.stop();
		await transport.whenStopped();
		return ConformanceExitCode.Ok;
	} catch (e) {
		logger.error(`Scenario ${args.scenario} failed:`, e instanceof Error ? e : String(e));
		return ConformanceExitCode.Failed;
	} finally {
		disposables.dispose();
	}
}
