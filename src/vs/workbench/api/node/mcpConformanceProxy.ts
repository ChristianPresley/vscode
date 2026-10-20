/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { JsonRpcId, JsonRpcMessage } from '../../../base/common/jsonRpcProtocol.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../base/common/observable.js';
import { UriComponents } from '../../../base/common/uri.js';
import { AbstractLogger, LogLevel } from '../../../platform/log/common/log.js';
import { IMcpMessageTransport } from '../../contrib/mcp/common/mcpRegistryTypes.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpCollectionDefinition, McpConnectionState, McpServerDefinition } from '../../contrib/mcp/common/mcpTypes.js';
import { IAuthMetadataSource, IMcpAuthenticationDetails, IMcpAuthenticationOptions, MainThreadMcpShape } from '../common/extHost.protocol.js';
import { McpHTTPHandle } from '../common/extHostMcp.js';

/**
 * The pieces that let the official MCP conformance suite drive VS Code's real
 * client code in one node process: a `MainThreadMcpShape` that records what
 * the extension-host transport reports instead of forwarding it over RPC, a
 * transport adapter that plugs that handle into the workbench protocol engine,
 * a stderr logger and the scenario context the suite passes in.
 */

/** Supplies bearer tokens to the transport; the authorization milestone implements it, until then the client has none. */
export interface IConformanceTokenSource {
	getToken(details: IMcpAuthenticationDetails, options: IMcpAuthenticationOptions | undefined): Promise<string | undefined>;
}

export interface IConformanceStateEvent {
	readonly id: number;
	readonly state: McpConnectionState;
}

export interface IConformanceLogEvent {
	readonly id: number;
	readonly level: LogLevel;
	readonly message: string;
}

export interface IConformanceMessageEvent {
	readonly id: number;
	/** The raw JSON the transport received. */
	readonly message: string;
}

export interface IConformanceAbortEvent {
	readonly id: number;
	readonly abort: IMcpRequestAbort;
}

/**
 * The main-thread side of the MCP extension-host protocol, in process. The
 * transport handle calls the `$` methods; this records them as events.
 */
export class ConformanceMainThreadMcp extends Disposable implements MainThreadMcpShape {
	private readonly _onDidChangeState = this._register(new Emitter<IConformanceStateEvent>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidPublishLog = this._register(new Emitter<IConformanceLogEvent>());
	readonly onDidPublishLog = this._onDidPublishLog.event;

	private readonly _onDidReceiveMessage = this._register(new Emitter<IConformanceMessageEvent>());
	readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

	private readonly _onDidAbortRequest = this._register(new Emitter<IConformanceAbortEvent>());
	readonly onDidAbortRequest = this._onDidAbortRequest.event;

	/** How the transport discovered the authorization metadata, per `$logMcpAuthSetup` call. */
	readonly authSetups: IAuthMetadataSource[] = [];

	/** Set by the authorization milestone; without one every request goes out unauthenticated. */
	tokenSource: IConformanceTokenSource | undefined;

	async $checkMcpServerAllowed(_id: number, _url: string): Promise<string | undefined> {
		return undefined; // the conformance servers are always allowed
	}

	$onDidChangeState(id: number, state: McpConnectionState): void {
		this._onDidChangeState.fire({ id, state });
	}

	$onDidPublishLog(id: number, level: LogLevel, message: string): void {
		this._onDidPublishLog.fire({ id, level, message });
	}

	$onDidReceiveMessage(id: number, message: string): void {
		this._onDidReceiveMessage.fire({ id, message });
	}

	$onDidAbortRequest(id: number, abort: IMcpRequestAbort): void {
		this._onDidAbortRequest.fire({ id, abort });
	}

	$upsertMcpCollection(_collection: McpCollectionDefinition.FromExtHost, _servers: McpServerDefinition.Serialized[]): void {
		// collections are a workbench concept; the conformance client has one fixed server
	}

	$deleteMcpCollection(_collectionId: string): void {
		// see $upsertMcpCollection
	}

	async $getTokenFromServerMetadata(_id: number, authDetails: IMcpAuthenticationDetails, options?: IMcpAuthenticationOptions): Promise<string | undefined> {
		return this.tokenSource?.getToken(authDetails, options);
	}

	async $getTokenForProviderId(_id: number, _providerId: string, _scopes: string[], _options?: IMcpAuthenticationOptions): Promise<string | undefined> {
		return undefined; // no authentication providers outside the workbench
	}

	$logMcpAuthSetup(data: IAuthMetadataSource): void {
		this.authSetups.push(data);
	}

	$startMcpGateway(_chatSessionResource?: UriComponents): Promise<{ servers: { label: string; address: UriComponents }[]; gatewayId: string } | undefined> {
		return Promise.reject(new Error('The conformance client has no MCP gateway'));
	}

	$disposeMcpGateway(_gatewayId: string): void {
		throw new Error('The conformance client has no MCP gateway');
	}
}

/**
 * Adapts an extension-host {@link McpHTTPHandle} to the {@link IMcpMessageTransport}
 * the workbench protocol engine consumes, with no RPC in between.
 */
export class InProcessMcpTransport extends Disposable implements IMcpMessageTransport {
	private readonly _state = observableValue<McpConnectionState>(this, { state: McpConnectionState.Kind.Starting });
	readonly state: IObservable<McpConnectionState> = this._state;

	private readonly _onDidLog = this._register(new Emitter<{ level: LogLevel; message: string }>());
	readonly onDidLog = this._onDidLog.event;

	private readonly _onDidReceiveMessage = this._register(new Emitter<JsonRpcMessage>());
	readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

	private readonly _onDidAbortRequest = this._register(new Emitter<IMcpRequestAbort>());
	readonly onDidAbortRequest = this._onDidAbortRequest.event;

	private readonly _handle: McpHTTPHandle;
	private _stopping: Promise<void> | undefined;

	/**
	 * @param id The handle id the proxy events are filtered by.
	 * @param proxy The in-process main thread the handle reports to.
	 * @param createHandle Creates the handle once the proxy events are subscribed to (the handle reports its state from its constructor).
	 * @param diagnostic Receives transport-level problems that have no JSON-RPC representation (unparsable messages, failed sends).
	 */
	constructor(
		private readonly _id: number,
		proxy: ConformanceMainThreadMcp,
		createHandle: () => McpHTTPHandle,
		private readonly _diagnostic: (message: string) => void = () => { },
	) {
		super();
		this._register(proxy.onDidChangeState(e => {
			if (e.id === this._id) {
				this._state.set(e.state, undefined);
			}
		}));
		this._register(proxy.onDidPublishLog(e => {
			if (e.id === this._id) {
				this._onDidLog.fire({ level: e.level, message: e.message });
			}
		}));
		this._register(proxy.onDidReceiveMessage(e => {
			if (e.id === this._id) {
				this._deliver(e.message);
			}
		}));
		this._register(proxy.onDidAbortRequest(e => {
			if (e.id === this._id) {
				this._onDidAbortRequest.fire(e.abort);
			}
		}));
		this._handle = this._register(createHandle());
	}

	send(message: JsonRpcMessage, envelope?: IMcpMessageEnvelope): void {
		this._handle.send(JSON.stringify(message), envelope).catch((err: unknown) => {
			this._diagnostic(`Failed to send a message: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	cancelRequest(requestId: JsonRpcId): void {
		this._handle.cancelRequest(requestId);
	}

	stop(): void {
		this._stopping ??= this._handle.close()
			.catch((err: unknown) => this._diagnostic(`Failed to close the connection: ${err instanceof Error ? err.message : String(err)}`))
			.finally(() => this._handle.dispose());
	}

	/** Resolves once {@link stop} has closed the connection (a legacy session is ended with a DELETE). */
	whenStopped(): Promise<void> {
		return this._stopping ?? Promise.resolve();
	}

	private _deliver(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this._diagnostic(`Ignoring a message that is not JSON: ${raw.length > 200 ? raw.slice(0, 200) + '…' : raw}`);
			return;
		}
		const messages = Array.isArray(parsed) ? parsed : [parsed];
		for (const message of messages) {
			if (typeof message === 'object' && message !== null) {
				this._onDidReceiveMessage.fire(message as JsonRpcMessage);
			} else {
				this._diagnostic(`Ignoring a message that is not a JSON object: ${JSON.stringify(message)}`);
			}
		}
	}
}

const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
	// `Authorization: <scheme> <credentials>` in headers and header dumps
	{ pattern: /(\bAuthorization["']?\s*[:=]\s*["']?)[^"',\r\n}]+/gi, replacement: '$1***' },
	// bare credentials of the bearer-like schemes
	{ pattern: /(\b(?:Bearer|DPoP|Basic)\s+)[A-Za-z0-9\-._~+/]+=*/g, replacement: '$1***' },
	// JSON bodies of token and registration responses
	{ pattern: /("(?:client_secret|access_token|refresh_token|id_token)"\s*:\s*")[^"]*(")/g, replacement: '$1***$2' },
	// form-encoded and query-string parameters (`code=` is the authorization code)
	{ pattern: /(\b(?:client_secret|access_token|refresh_token|id_token|code)=)[^&\s"']+/g, replacement: '$1***' },
];

/** Blanks the credentials that may appear in transport logs. */
export function redactSecrets(text: string): string {
	let result = text;
	for (const { pattern, replacement } of SECRET_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}

function formatLogArgument(arg: unknown): string {
	if (arg instanceof Error) {
		return arg.stack ?? arg.message;
	}
	if (typeof arg === 'string') {
		return arg;
	}
	try {
		return JSON.stringify(arg) ?? String(arg);
	} catch {
		return String(arg);
	}
}

/**
 * A logger that writes to stderr only. The conformance suite owns stdout and
 * requires the client to leave it empty.
 */
export class StderrLogger extends AbstractLogger {
	constructor(
		private readonly _write: (line: string) => void = line => { process.stderr.write(line); },
		level: LogLevel = LogLevel.Info,
	) {
		super();
		this.setLevel(level);
	}

	trace(message: string, ...args: unknown[]): void {
		this._log(LogLevel.Trace, 'trace', message, args);
	}

	debug(message: string, ...args: unknown[]): void {
		this._log(LogLevel.Debug, 'debug', message, args);
	}

	info(message: string, ...args: unknown[]): void {
		this._log(LogLevel.Info, 'info', message, args);
	}

	warn(message: string, ...args: unknown[]): void {
		this._log(LogLevel.Warning, 'warn', message, args);
	}

	error(message: string | Error, ...args: unknown[]): void {
		this._log(LogLevel.Error, 'error', message, args);
	}

	flush(): void {
		// stderr writes are not buffered here
	}

	private _log(level: LogLevel, label: string, message: string | Error, args: unknown[]): void {
		if (!this.canLog(level)) {
			return;
		}
		const text = [formatLogArgument(message), ...args.map(formatLogArgument)].join(' ');
		this._write(`[mcp-conformance] ${label}: ${redactSecrets(text)}\n`);
	}
}

export interface IConformanceToolCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/**
 * The `MCP_CONFORMANCE_CONTEXT` the suite passes to scenarios that need data
 * from the client: pre-registered credentials for the authorization scenarios
 * and the tool calls to replay for `http-custom-headers`.
 */
export interface IConformanceContext {
	readonly client_id?: string;
	readonly client_secret?: string;
	readonly toolCalls?: readonly IConformanceToolCall[];
	/** Every key as the suite sent it; the authorization extensions add scenario-specific ones. */
	readonly raw: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses the context JSON; anything unparsable or malformed yields an empty context. */
export function parseConformanceContext(json: string | undefined): IConformanceContext {
	if (!json) {
		return { raw: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { raw: {} };
	}
	if (!isRecord(parsed)) {
		return { raw: {} };
	}
	const context: { -readonly [K in keyof IConformanceContext]: IConformanceContext[K] } = { raw: parsed };
	if (typeof parsed.client_id === 'string') {
		context.client_id = parsed.client_id;
	}
	if (typeof parsed.client_secret === 'string') {
		context.client_secret = parsed.client_secret;
	}
	if (Array.isArray(parsed.toolCalls)) {
		const toolCalls: IConformanceToolCall[] = [];
		for (const call of parsed.toolCalls) {
			if (isRecord(call) && typeof call.name === 'string') {
				toolCalls.push({ name: call.name, arguments: isRecord(call.arguments) ? call.arguments : {} });
			}
		}
		context.toolCalls = toolCalls;
	}
	return context;
}
