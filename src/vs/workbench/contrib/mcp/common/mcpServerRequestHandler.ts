/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../../../../base/common/arrays.js';
import { assertNever, softAssertNever } from '../../../../base/common/assert.js';
import { DeferredPromise, disposableTimeout, IntervalTimer, isThenable } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Iterable } from '../../../../base/common/iterator.js';
import { JsonRpcError, JsonRpcProtocol } from '../../../../base/common/jsonRpcProtocol.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, ISettableObservable, ObservablePromise, observableValue, transaction } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { canLog, ILogger, log, LogLevel } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IMcpMessageTransport } from './mcpRegistryTypes.js';
import { IMcpTaskInternal, McpTaskManager } from './mcpTaskManager.js';
import { IMcpClientMethods, McpConnectionState, McpError, MpcResponseError } from './mcpTypes.js';
import { isTaskResult, translateMcpLogMessage } from './mcpTypesUtils.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';

export interface McpRoot {
	uri: string;
	name?: string;
}

export interface IMcpServerRequestHandlerOptions extends IMcpClientMethods {
	/** MCP message transport */
	launch: IMcpMessageTransport;
	/** Logger instance. */
	logger: ILogger;
	/** Log level MCP messages is logged at */
	requestLogLevel?: LogLevel;
	/** Task manager for server-side MCP tasks (shared across reconnections) */
	taskManager: McpTaskManager;
}

/**
 * Request handler for communicating with an MCP server.
 *
 * Handles sending requests and receiving responses, with automatic
 * handling of ping requests and typed client request methods.
 */
export class McpServerRequestHandler extends Disposable {
	private readonly _rpc: JsonRpcProtocol;

	private _hasAnnouncedRoots = false;
	private _roots: MCPLegacy.Root[] = [];

	public set roots(roots: MCPLegacy.Root[]) {
		if (!equals(this._roots, roots)) {
			this._roots = roots;
			if (this._hasAnnouncedRoots) {
				this.sendNotification({ method: 'notifications/roots/list_changed' });
				this._hasAnnouncedRoots = false;
			}
		}
	}

	private _serverInit!: MCPLegacy.InitializeResult;
	public get capabilities(): MCPLegacy.ServerCapabilities {
		return this._serverInit.capabilities;
	}

	public get serverInfo(): MCPLegacy.Implementation {
		return this._serverInit.serverInfo;
	}

	public get serverInstructions(): string | undefined {
		return this._serverInit.instructions;
	}

	// Event emitters for server notifications
	private readonly _onDidReceiveCancelledNotification = this._register(new Emitter<MCPLegacy.CancelledNotification>());
	readonly onDidReceiveCancelledNotification = this._onDidReceiveCancelledNotification.event;

	private readonly _onDidReceiveProgressNotification = this._register(new Emitter<MCPLegacy.ProgressNotification>());
	readonly onDidReceiveProgressNotification = this._onDidReceiveProgressNotification.event;

	private readonly _onDidReceiveElicitationCompleteNotification = this._register(new Emitter<MCPLegacy.ElicitationCompleteNotification>());
	readonly onDidReceiveElicitationCompleteNotification = this._onDidReceiveElicitationCompleteNotification.event;

	private readonly _onDidChangeResourceList = this._register(new Emitter<void>());
	readonly onDidChangeResourceList = this._onDidChangeResourceList.event;

	private readonly _onDidUpdateResource = this._register(new Emitter<MCPLegacy.ResourceUpdatedNotification>());
	readonly onDidUpdateResource = this._onDidUpdateResource.event;

	private readonly _onDidChangeToolList = this._register(new Emitter<void>());
	readonly onDidChangeToolList = this._onDidChangeToolList.event;

	private readonly _onDidChangePromptList = this._register(new Emitter<void>());
	readonly onDidChangePromptList = this._onDidChangePromptList.event;

	/**
	 * Connects to the MCP server and does the initialization handshake.
	 * @throws MpcResponseError if the server fails to initialize.
	 */
	public static async create(instaService: IInstantiationService, opts: IMcpServerRequestHandlerOptions, token?: CancellationToken) {
		const mcp = new McpServerRequestHandler(opts);
		const store = new DisposableStore();
		try {
			const timer = store.add(new IntervalTimer());
			timer.cancelAndSet(() => {
				opts.logger.info('Waiting for server to respond to `initialize` request...');
			}, 5000);

			await instaService.invokeFunction(async accessor => {
				const productService = accessor.get(IProductService);
				const initialized = await mcp.sendRequest<MCPLegacy.InitializeRequest, MCPLegacy.InitializeResult>({
					method: 'initialize',
					params: {
						protocolVersion: MCPLegacy.LATEST_PROTOCOL_VERSION,
						capabilities: {
							roots: { listChanged: true },
							sampling: opts.createMessageRequestHandler ? {} : undefined,
							elicitation: opts.elicitationRequestHandler ? { form: {}, url: {} } : undefined,
							tasks: {
								list: {},
								cancel: {},
								requests: {
									sampling: opts.createMessageRequestHandler ? { createMessage: {} } : undefined,
									elicitation: opts.elicitationRequestHandler ? { create: {} } : undefined,
								},
							},
							extensions: {
								'io.modelcontextprotocol/ui': {
									mimeTypes: ['text/html;profile=mcp-app']
								}
							}
						},
						clientInfo: {
							name: productService.nameLong,
							version: productService.version,
						}
					}
				}, token);
				mcp._serverInit = initialized;
				mcp._sendLogLevelToServer(opts.logger.getLevel());

				mcp.sendNotification<MCPLegacy.InitializedNotification>({
					method: 'notifications/initialized'
				});
			});

			return mcp;
		} catch (e) {
			mcp.dispose();
			throw e;
		} finally {
			store.dispose();
		}
	}

	public readonly logger: ILogger;
	private readonly _launch: IMcpMessageTransport;
	private readonly _requestLogLevel: LogLevel;
	private readonly _createMessageRequestHandler: IMcpServerRequestHandlerOptions['createMessageRequestHandler'];
	private readonly _elicitationRequestHandler: IMcpServerRequestHandlerOptions['elicitationRequestHandler'];
	private readonly _taskManager: McpTaskManager;

	protected constructor({
		launch,
		logger,
		createMessageRequestHandler,
		elicitationRequestHandler,
		requestLogLevel = LogLevel.Debug,
		taskManager,
	}: IMcpServerRequestHandlerOptions) {
		super();
		this._launch = launch;
		this.logger = logger;
		this._requestLogLevel = requestLogLevel;
		this._createMessageRequestHandler = createMessageRequestHandler;
		this._elicitationRequestHandler = elicitationRequestHandler;
		this._taskManager = taskManager;

		this._rpc = this._register(new JsonRpcProtocol(
			message => this.send(message as MCPLegacy.JSONRPCMessage),
			{
				handleRequest: (request, token) => this.handleServerRequest(request as MCPLegacy.JSONRPCRequest & MCPLegacy.ServerRequest, token),
				handleNotification: notification => this.handleServerNotification(notification as MCPLegacy.JSONRPCNotification & MCPLegacy.ServerNotification),
			}
		));

		// Attach this handler to the task manager
		this._taskManager.setHandler(this);
		this._register(this._taskManager.onDidUpdateTask(task => {
			this.send({
				jsonrpc: MCPLegacy.JSONRPC_VERSION,
				method: 'notifications/tasks/status',
				params: task
			} satisfies MCPLegacy.TaskStatusNotification);
		}));
		this._register(toDisposable(() => this._taskManager.setHandler(undefined)));

		this._register(launch.onDidReceiveMessage(message => {
			if (canLog(this.logger.getLevel(), this._requestLogLevel)) {
				log(this.logger, this._requestLogLevel, `[server -> editor] ${JSON.stringify(message)}`);
			}
			void this._rpc.handleMessage(message);
		}));
		this._register(autorun(reader => {
			const state = launch.state.read(reader).state;
			// the handler will get disposed when the launch stops, but if we're still
			// create()'ing we need to make sure to cancel the initialize request.
			if (state === McpConnectionState.Kind.Error || state === McpConnectionState.Kind.Stopped) {
				this.cancelAllRequests();
			}
		}));

		// Listen for log level changes and forward them to the MCP server
		this._register(logger.onDidChangeLogLevel((logLevel) => {
			this._sendLogLevelToServer(logLevel);
		}));
	}

	/**
	 * Send a client request to the server and return the response.
	 *
	 * @param request The request to send
	 * @param token Cancellation token
	 * @param timeoutMs Optional timeout in milliseconds
	 * @returns A promise that resolves with the response
	 */
	private async sendRequest<T extends MCPLegacy.ClientRequest, R extends MCPLegacy.ServerResult>(
		request: Pick<T, 'params' | 'method'>,
		token: CancellationToken = CancellationToken.None
	): Promise<R> {
		if (this._store.isDisposed) {
			return Promise.reject(new CancellationError());
		}

		return this._rpc.sendRequest<R>(
			request,
			token,
			id => this.sendNotification({ method: 'notifications/cancelled', params: { requestId: id } })
		).catch(error => {
			if (error instanceof JsonRpcError) {
				throw new MpcResponseError(error.message, error.code, error.data);
			}
			throw error;
		});
	}

	private send(mcp: MCPLegacy.JSONRPCMessage) {
		if (canLog(this.logger.getLevel(), this._requestLogLevel)) { // avoid building the string if we don't need to
			log(this.logger, this._requestLogLevel, `[editor -> server] ${JSON.stringify(mcp)}`);
		}

		this._launch.send(mcp);
	}

	/**
	 * Handles paginated requests by making multiple requests until all items are retrieved.
	 *
	 * @param method The method name to call
	 * @param getItems Function to extract the array of items from a result
	 * @param initialParams Initial parameters
	 * @param token Cancellation token
	 * @returns Promise with all items combined
	 */
	private async *sendRequestPaginated<T extends MCPLegacy.PaginatedRequest & MCPLegacy.ClientRequest, R extends MCPLegacy.PaginatedResult, I>(method: T['method'], getItems: (result: R) => I[], initialParams?: Omit<T['params'], 'jsonrpc' | 'id'>, token: CancellationToken = CancellationToken.None): AsyncIterable<I[]> {
		let nextCursor: MCPLegacy.Cursor | undefined = undefined;

		do {
			const params: T['params'] = {
				...initialParams,
				cursor: nextCursor
			};

			const result: R = await this.sendRequest<T, R>({ method, params }, token);
			yield getItems(result);
			nextCursor = result.nextCursor;
		} while (nextCursor !== undefined && !token.isCancellationRequested);
	}

	private sendNotification<N extends MCPLegacy.ClientNotification>(notification: Omit<N, 'jsonrpc'>): void {
		this.send({ ...notification, jsonrpc: MCPLegacy.JSONRPC_VERSION });
	}

	/**
	 * Handle incoming server requests
	 */
	private handleServerRequest(request: MCPLegacy.JSONRPCRequest & MCPLegacy.ServerRequest, token: CancellationToken): MCPLegacy.Result | Promise<MCPLegacy.Result> {
		const mapError = (error: unknown): JsonRpcError => {
			if (error instanceof McpError) {
				return new JsonRpcError(error.code, error.message, error.data);
			}

			this.logger.error(`Error handling request ${request.method}:`, error);
			const mcpError = McpError.unknown(error instanceof Error ? error : new Error(String(error)));
			return new JsonRpcError(mcpError.code, mcpError.message, mcpError.data);
		};

		try {
			let result: MCPLegacy.Result | Promise<MCPLegacy.Result>;
			if (request.method === 'ping') {
				result = this.handlePing(request);
			} else if (request.method === 'roots/list') {
				result = this.handleRootsList(request);
			} else if (request.method === 'sampling/createMessage' && this._createMessageRequestHandler) {
				// Check if this is a task-augmented request
				if (request.params.task) {
					const taskResult = this._taskManager.createTask(
						request.params.task.ttl ?? null,
						(token) => this._createMessageRequestHandler!(request.params, token)
					);
					taskResult._meta ??= {};
					taskResult._meta['io.modelcontextprotocol/related-task'] = { taskId: taskResult.task.taskId };
					result = taskResult;
				} else {
					result = this._createMessageRequestHandler(request.params, token);
				}
			} else if (request.method === 'elicitation/create' && this._elicitationRequestHandler) {
				// Check if this is a task-augmented request
				if (request.params.task) {
					const taskResult = this._taskManager.createTask(
						request.params.task.ttl ?? null,
						(token) => this._elicitationRequestHandler!(request.params, token)
					);
					taskResult._meta ??= {};
					taskResult._meta['io.modelcontextprotocol/related-task'] = { taskId: taskResult.task.taskId };
					result = taskResult;
				} else {
					result = this._elicitationRequestHandler(request.params, token);
				}
			} else if (request.method === 'tasks/get') {
				result = this._taskManager.getTask(request.params.taskId);
			} else if (request.method === 'tasks/result') {
				result = this._taskManager.getTaskResult(request.params.taskId);
			} else if (request.method === 'tasks/cancel') {
				result = this._taskManager.cancelTask(request.params.taskId);
			} else if (request.method === 'tasks/list') {
				result = this._taskManager.listTasks();
			} else {
				throw McpError.methodNotFound(request.method);
			}

			if (isThenable(result)) {
				return result.then(undefined, (error: unknown) => {
					throw mapError(error);
				});
			}

			return result;
		} catch (e) {
			throw mapError(e);
		}
	}
	/**
	 * Handle incoming server notifications
	 */
	private handleServerNotification(request: MCPLegacy.JSONRPCNotification & MCPLegacy.ServerNotification): void {
		try {
			switch (request.method) {
				case 'notifications/message':
					return this.handleLoggingNotification(request);
				case 'notifications/cancelled':
					this._onDidReceiveCancelledNotification.fire(request);
					return this.handleCancelledNotification(request);
				case 'notifications/progress':
					this._onDidReceiveProgressNotification.fire(request);
					return;
				case 'notifications/resources/list_changed':
					this._onDidChangeResourceList.fire();
					return;
				case 'notifications/resources/updated':
					this._onDidUpdateResource.fire(request);
					return;
				case 'notifications/tools/list_changed':
					this._onDidChangeToolList.fire();
					return;
				case 'notifications/prompts/list_changed':
					this._onDidChangePromptList.fire();
					return;
				case 'notifications/elicitation/complete':
					this._onDidReceiveElicitationCompleteNotification.fire(request);
					return;
				case 'notifications/tasks/status':
					this._taskManager.getClientTask(request.params.taskId)?.onDidUpdateState(request.params);
					return;
				default:
					softAssertNever(request);
			}
		} catch (error) {
			this.logger.error(`Error handling notification ${request.method}:`, error);
		}
	}

	private handleCancelledNotification(request: MCPLegacy.CancelledNotification): void {
		if (request.params.requestId) {
			this._rpc.cancelPendingRequest(request.params.requestId);
		}
	}

	private handleLoggingNotification(request: MCPLegacy.LoggingMessageNotification): void {
		translateMcpLogMessage(this.logger, request.params);
	}

	/**
	 * Send a response to a ping request
	 */
	private handlePing(_request: MCPLegacy.PingRequest): {} {
		return {};
	}

	/**
	 * Send a response to a roots/list request
	 */
	private handleRootsList(_request: MCPLegacy.ListRootsRequest): MCPLegacy.ListRootsResult {
		this._hasAnnouncedRoots = true;
		return { roots: this._roots };
	}

	private cancelAllRequests() {
		this._rpc.cancelAllRequests();
	}

	public override dispose(): void {
		this.cancelAllRequests();
		super.dispose();
	}

	/**
	 * Forwards log level changes to the MCP server if it supports logging
	 */
	private async _sendLogLevelToServer(logLevel: LogLevel): Promise<void> {
		try {
			// Only send if the server supports logging capabilities
			if (!this.capabilities.logging) {
				return;
			}

			await this.setLevel({ level: mapLogLevelToMcp(logLevel) });
		} catch (error) {
			this.logger.error(`Failed to set MCP server log level: ${error}`);
		}
	}

	/**
	 * Send an initialize request
	 */
	initialize(params: MCPLegacy.InitializeRequest['params'], token?: CancellationToken): Promise<MCPLegacy.InitializeResult> {
		return this.sendRequest<MCPLegacy.InitializeRequest, MCPLegacy.InitializeResult>({ method: 'initialize', params }, token);
	}

	/**
	 * List available resources
	 */
	listResources(params?: MCPLegacy.ListResourcesRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Resource[]> {
		return Iterable.asyncToArrayFlat(this.listResourcesIterable(params, token));
	}

	/**
	 * List available resources (iterable)
	 */
	listResourcesIterable(params?: MCPLegacy.ListResourcesRequest['params'], token?: CancellationToken): AsyncIterable<MCPLegacy.Resource[]> {
		return this.sendRequestPaginated<MCPLegacy.ListResourcesRequest, MCPLegacy.ListResourcesResult, MCPLegacy.Resource>('resources/list', result => result.resources, params, token);
	}

	/**
	 * Read a specific resource
	 */
	readResource(params: MCPLegacy.ReadResourceRequest['params'], token?: CancellationToken): Promise<MCPLegacy.ReadResourceResult> {
		return this.sendRequest<MCPLegacy.ReadResourceRequest, MCPLegacy.ReadResourceResult>({ method: 'resources/read', params }, token);
	}

	/**
	 * List available resource templates
	 */
	listResourceTemplates(params?: MCPLegacy.ListResourceTemplatesRequest['params'], token?: CancellationToken): Promise<MCPLegacy.ResourceTemplate[]> {
		return Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListResourceTemplatesRequest, MCPLegacy.ListResourceTemplatesResult, MCPLegacy.ResourceTemplate>('resources/templates/list', result => result.resourceTemplates, params, token));
	}

	/**
	 * Subscribe to resource updates
	 */
	subscribe(params: MCPLegacy.SubscribeRequest['params'], token?: CancellationToken): Promise<MCPLegacy.EmptyResult> {
		return this.sendRequest<MCPLegacy.SubscribeRequest, MCPLegacy.EmptyResult>({ method: 'resources/subscribe', params }, token);
	}

	/**
	 * Unsubscribe from resource updates
	 */
	unsubscribe(params: MCPLegacy.UnsubscribeRequest['params'], token?: CancellationToken): Promise<MCPLegacy.EmptyResult> {
		return this.sendRequest<MCPLegacy.UnsubscribeRequest, MCPLegacy.EmptyResult>({ method: 'resources/unsubscribe', params }, token);
	}

	/**
	 * List available prompts
	 */
	listPrompts(params?: MCPLegacy.ListPromptsRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Prompt[]> {
		return Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListPromptsRequest, MCPLegacy.ListPromptsResult, MCPLegacy.Prompt>('prompts/list', result => result.prompts, params, token));
	}

	/**
	 * Get a specific prompt
	 */
	getPrompt(params: MCPLegacy.GetPromptRequest['params'], token?: CancellationToken): Promise<MCPLegacy.GetPromptResult> {
		return this.sendRequest<MCPLegacy.GetPromptRequest, MCPLegacy.GetPromptResult>({ method: 'prompts/get', params }, token);
	}

	/**
	 * List available tools
	 */
	listTools(params?: MCPLegacy.ListToolsRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Tool[]> {
		return Iterable.asyncToArrayFlat(this.sendRequestPaginated<MCPLegacy.ListToolsRequest, MCPLegacy.ListToolsResult, MCPLegacy.Tool>('tools/list', result => result.tools, params, token));
	}

	/**
	 * Call a specific tool. Supports tasks automatically if `task` is set on the request.
	 */
	async callTool(params: MCPLegacy.CallToolRequest['params'] & MCPLegacy.Request['params'], token?: CancellationToken, onStatusMessage?: (message: string) => void): Promise<MCPLegacy.CallToolResult> {
		const response = await this.sendRequest<MCPLegacy.CallToolRequest, MCPLegacy.CallToolResult | MCPLegacy.CreateTaskResult>({ method: 'tools/call', params }, token);

		if (isTaskResult(response)) {
			const task = new McpTask<MCPLegacy.CallToolResult>(response.task, token, onStatusMessage);
			this._taskManager.adoptClientTask(task);
			task.setHandler(this);
			return task.result.finally(() => {
				this._taskManager.abandonClientTask(task.id);
			});
		}

		return response;

	}

	/**
	 * Set the logging level
	 */
	setLevel(params: MCPLegacy.SetLevelRequest['params'], token?: CancellationToken): Promise<MCPLegacy.EmptyResult> {
		return this.sendRequest<MCPLegacy.SetLevelRequest, MCPLegacy.EmptyResult>({ method: 'logging/setLevel', params }, token);
	}

	/**
	 * Find completions for an argument
	 */
	complete(params: MCPLegacy.CompleteRequest['params'], token?: CancellationToken): Promise<MCPLegacy.CompleteResult> {
		return this.sendRequest<MCPLegacy.CompleteRequest, MCPLegacy.CompleteResult>({ method: 'completion/complete', params }, token);
	}

	/**
	 * Get task status
	 */
	getTask(params: { taskId: string }, token?: CancellationToken): Promise<MCPLegacy.GetTaskResult> {
		return this.sendRequest<MCPLegacy.GetTaskRequest, MCPLegacy.GetTaskResult>({ method: 'tasks/get', params }, token);
	}

	/**
	 * Get task result
	 */
	getTaskResult(params: { taskId: string }, token?: CancellationToken): Promise<MCPLegacy.GetTaskPayloadResult> {
		return this.sendRequest<MCPLegacy.GetTaskPayloadRequest, MCPLegacy.GetTaskPayloadResult>({ method: 'tasks/result', params }, token);
	}

	/**
	 * Cancel a task
	 */
	cancelTask(params: { taskId: string }, token?: CancellationToken): Promise<MCPLegacy.CancelTaskResult> {
		return this.sendRequest<MCPLegacy.CancelTaskRequest, MCPLegacy.CancelTaskResult>({ method: 'tasks/cancel', params }, token);
	}

	/**
	 * List all tasks
	 */
	listTasks(params?: MCPLegacy.ListTasksRequest['params'], token?: CancellationToken): Promise<MCPLegacy.Task[]> {
		return Iterable.asyncToArrayFlat(
			this.sendRequestPaginated<MCPLegacy.ListTasksRequest, MCPLegacy.ListTasksResult, MCPLegacy.Task>(
				'tasks/list', result => result.tasks, params, token
			)
		);
	}
}

function isTaskInTerminalState(task: MCPLegacy.Task): boolean {
	return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

/**
 * Implementation of a task that handles polling, status notifications, and handler reconnections. It implements the task polling loop internally and can also be
 * updated externally via `onDidUpdateState`, when notifications are received
 * for example.
 * @internal
 */
export class McpTask<T extends MCPLegacy.Result> extends Disposable implements IMcpTaskInternal {
	private readonly promise = new DeferredPromise<T>();

	public get result(): Promise<T> {
		return this.promise.p;
	}

	public get id() {
		return this._task.taskId;
	}

	private _lastTaskState: ISettableObservable<MCPLegacy.Task>;
	private _handler = observableValue<McpServerRequestHandler | undefined>('mcpTaskHandler', undefined);

	constructor(
		private readonly _task: MCPLegacy.Task,
		_token: CancellationToken = CancellationToken.None,
		private readonly _onStatusMessage?: (message: string) => void,
	) {
		super();

		const expiresAt = _task.ttl ? (Date.now() + _task.ttl) : undefined;
		this._lastTaskState = observableValue('lastTaskState', this._task);

		const store = this._register(new DisposableStore());

		// Handle external cancellation token
		if (_token.isCancellationRequested) {
			this._lastTaskState.set({ ...this._task, status: 'cancelled' }, undefined);
		} else {
			store.add(_token.onCancellationRequested(() => {
				const current = this._lastTaskState.get();
				if (!isTaskInTerminalState(current)) {
					this._lastTaskState.set({ ...current, status: 'cancelled' }, undefined);
				}
			}));
		}

		// Handle TTL expiration with an explicit timeout
		if (expiresAt) {
			const ttlTimeout = expiresAt - Date.now();
			if (ttlTimeout <= 0) {
				this._lastTaskState.set({ ...this._task, status: 'cancelled', statusMessage: 'Task timed out.' }, undefined);
			} else {
				store.add(disposableTimeout(() => {
					const current = this._lastTaskState.get();
					if (!isTaskInTerminalState(current)) {
						this._lastTaskState.set({ ...current, status: 'cancelled', statusMessage: 'Task timed out.' }, undefined);
					}
				}, ttlTimeout));
			}
		}

		// A `tasks/result` call triggered by an input_required state.
		const inputRequiredLookup = observableValue<ObservablePromise<MCPLegacy.Task> | undefined>('activeResultLookup', undefined);

		// 1. Poll for task updates when the task isn't in a terminal state
		store.add(autorun(reader => {
			const current = this._lastTaskState.read(reader);
			if (isTaskInTerminalState(current)) {
				return;
			}

			// When a task goes into the input_required state, by spec we should call
			// `tasks/result` which can return an SSE stream of task updates. No need
			// to poll while such a lookup is going on, but once it resolves we should
			// clear and update our state.
			const lookup = inputRequiredLookup.read(reader);
			if (lookup) {
				const result = lookup.promiseResult.read(reader);
				return transaction(tx => {
					if (!result) {
						// still ongoing
					} else if (result.data) {
						inputRequiredLookup.set(undefined, tx);
						this._lastTaskState.set(result.data, tx);
					} else {
						inputRequiredLookup.set(undefined, tx);
						if (result.error instanceof McpError && result.error.code === MCPLegacy.INVALID_PARAMS) {
							this._lastTaskState.set({ ...current, status: 'cancelled' }, undefined);
						} else {
							// Maybe a connection error -- start polling again
							this._lastTaskState.set({ ...current, status: 'working' }, undefined);
						}
					}
				});
			}

			const handler = this._handler.read(reader);
			if (!handler) {
				return;
			}

			const pollInterval = _task.pollInterval ?? 2000;
			const cts = new CancellationTokenSource(_token);
			reader.store.add(toDisposable(() => cts.dispose(true)));
			reader.store.add(disposableTimeout(() => {
				handler.getTask({ taskId: current.taskId }, cts.token)
					.catch((e): MCPLegacy.Task | undefined => {
						if (e instanceof McpError && e.code === MCPLegacy.INVALID_PARAMS) {
							return { ...current, status: 'cancelled' };
						} else {
							return { ...current }; // errors are already logged, keep in current state
						}
					})
					.then(r => {
						if (r && !cts.token.isCancellationRequested) {
							this._lastTaskState.set(r, undefined);
						}
					});
			}, pollInterval));
		}));

		// 2. Get the result once it's available (or propagate errors). Trigger
		// input_required handling as needed. Only react when the status itself changes.
		const lastStatus = this._lastTaskState.map(task => task.status);
		store.add(autorun(reader => {
			const status = lastStatus.read(reader);
			if (status === 'failed') {
				const current = this._lastTaskState.read(undefined);
				this.promise.error(new Error(`Task ${current.taskId} failed: ${current.statusMessage ?? 'unknown error'}`));
				store.dispose();
			} else if (status === 'cancelled') {
				this.promise.cancel();
				store.dispose();
			} else if (status === 'input_required') {
				const handler = this._handler.read(reader);
				if (handler) {
					const current = this._lastTaskState.read(undefined);
					const cts = new CancellationTokenSource(_token);
					reader.store.add(toDisposable(() => cts.dispose(true)));
					inputRequiredLookup.set(new ObservablePromise<MCPLegacy.Task>(handler.getTask({ taskId: current.taskId }, cts.token)), undefined);
				}
			} else if (status === 'completed') {
				const handler = this._handler.read(reader);
				if (handler) {
					this.promise.settleWith(handler.getTaskResult({ taskId: _task.taskId }, _token) as Promise<T>);
					store.dispose();
				}
			} else if (status === 'working') {
				// no-op
			} else {
				softAssertNever(status);
			}
		}));
	}

	onDidUpdateState(task: MCPLegacy.Task) {
		this._lastTaskState.set(task, undefined);
		if (task.statusMessage && this._onStatusMessage) {
			this._onStatusMessage(task.statusMessage);
		}
	}

	setHandler(handler: McpServerRequestHandler | undefined): void {
		this._handler.set(handler, undefined);
	}
}

/**
 * Maps VSCode LogLevel to MCP LoggingLevel
 */
function mapLogLevelToMcp(logLevel: LogLevel): MCPLegacy.LoggingLevel {
	switch (logLevel) {
		case LogLevel.Trace:
			return 'debug'; // MCP doesn't have trace, use debug
		case LogLevel.Debug:
			return 'debug';
		case LogLevel.Info:
			return 'info';
		case LogLevel.Warning:
			return 'warning';
		case LogLevel.Error:
			return 'error';
		case LogLevel.Off:
			return 'emergency'; // MCP doesn't have off, use emergency
		default:
			return assertNever(logLevel); // Off and other levels are not supported
	}
}
