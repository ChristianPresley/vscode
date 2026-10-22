/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { IMcpGatewayCacheHints, IMcpGatewayInputRequired, IMcpGatewayInvokeContext, IMcpGatewayServerCapabilities, IMcpGatewaySingleServerInvoker } from '../common/mcpGateway.js';
import { McpGatewayRpcError } from '../common/mcpGatewayProtocol.js';
import { MCP } from '../common/modelContextProtocol.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';
import { McpSkills } from '../common/modelContextProtocolSkills.js';
import { IMcpSkillDefinition, McpSkillCatalog } from '../common/mcpSkillCatalog.js';
import { McpGatewayResourceNotFoundError } from './mcpGatewayDispatcher.js';
import { IMcpGatewayTaskCapableInvoker, IMcpGatewayTaskOptions, McpGatewayTaskSupport, startTaskResult, taskRunOf } from './mcpGatewayTasks.js';

/**
 * The "everything server" of the official MCP conformance suite, as a
 * gateway invoker: every tool, resource and prompt the suite's server
 * scenarios call, for both the 2026-07-28 wire (MRTR input rounds are
 * returned as {@link IMcpGatewayInputRequired}) and the 2025-11-25 wire
 * (the dispatcher bridges the same rounds into server→client requests).
 * Mirrors `conformance/everything_server.zig` of the zig SDK.
 */

export const CONFORMANCE_SERVER_INFO: MCP.Implementation = { name: 'mcp-conformance-test-server', version: '1.0.0' };

export const CONFORMANCE_INSTRUCTIONS = 'Everything server for the MCP conformance suite (VS Code MCP gateway fixture).';

export const CONFORMANCE_CAPABILITIES: IMcpGatewayServerCapabilities = {
	tools: { listChanged: true },
	prompts: { listChanged: true },
	resources: { subscribe: true, listChanged: true },
	completions: true,
	logging: true,
	skills: { directoryRead: true },
};

export const CONFORMANCE_CACHE_HINTS: IMcpGatewayCacheHints = { ttlMs: 60_000, cacheScope: 'public' };

/** The fixture serves the Tasks extension (SEP-2663) with these settings. */
export const CONFORMANCE_TASK_OPTIONS: IMcpGatewayTaskOptions = { ttlMs: 600_000, pollIntervalMs: 1000 };

/** A 1x1 PNG. */
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** An empty WAV file. */
const WAV_EMPTY = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/** The input schema of `json_schema_2020_12_tool` (SEP-1613 / SEP-2106 keyword preservation). */
export const JSON_SCHEMA_2020_12_TOOL_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	$defs: {
		address: {
			$anchor: 'addressDef',
			type: 'object',
			properties: {
				street: { type: 'string' },
				city: { type: 'string' },
			},
		},
	},
	properties: {
		name: { type: 'string' },
		address: { $ref: '#/$defs/address' },
		contactMethod: { type: 'string', enum: ['phone', 'email'] },
		phone: { type: 'string' },
		email: { type: 'string' },
	},
	allOf: [{ anyOf: [{ required: ['phone'] }, { required: ['email'] }] }],
	if: { properties: { contactMethod: { const: 'phone' } }, required: ['contactMethod'] },
	then: { required: ['phone'] },
	else: { required: ['email'] },
	additionalProperties: false,
} as const;

const TOOL = {
	simpleText: 'test_simple_text',
	imageContent: 'test_image_content',
	audioContent: 'test_audio_content',
	embeddedResource: 'test_embedded_resource',
	multipleContentTypes: 'test_multiple_content_types',
	errorHandling: 'test_error_handling',
	withProgress: 'test_tool_with_progress',
	withLogging: 'test_tool_with_logging',
	loggingTool: 'test_logging_tool',
	missingCapability: 'test_missing_capability',
	streamingElicitation: 'test_streaming_elicitation',
	sampling: 'test_sampling',
	elicitation: 'test_elicitation',
	elicitationEnums: 'test_elicitation_sep1330_enums',
	elicitationDefaults: 'test_elicitation_sep1034_defaults',
	triggerToolChange: 'test_trigger_tool_change',
	triggerPromptChange: 'test_trigger_prompt_change',
	hiddenTool: 'test_hidden_tool',
	irElicitation: 'test_input_required_result_elicitation',
	irSampling: 'test_input_required_result_sampling',
	irListRoots: 'test_input_required_result_list_roots',
	irRequestState: 'test_input_required_result_request_state',
	irMultipleInputs: 'test_input_required_result_multiple_inputs',
	irMultiRound: 'test_input_required_result_multi_round',
	irTamperedState: 'test_input_required_result_tampered_state',
	irCapabilities: 'test_input_required_result_capabilities',
	jsonSchema2020: 'json_schema_2020_12_tool',
	xMcpHeader: 'test_x_mcp_header',
	reconnection: 'test_reconnection',
	// The Tasks extension scenarios (SEP-2663).
	greet: 'greet',
	slowCompute: 'slow_compute',
	failingJob: 'failing_job',
	protocolErrorJob: 'protocol_error_job',
	confirmDelete: 'confirm_delete',
	multiInput: 'multi_input',
	toolWithTask: 'test_tool_with_task',
	// The gRPC interop fixture: the zig-sdk example client (`grpc_client`) calls `add(40, 2)`.
	add: 'add',
} as const;

const PROMPT = {
	simple: 'test_simple_prompt',
	withArguments: 'test_prompt_with_arguments',
	withEmbeddedResource: 'test_prompt_with_embedded_resource',
	withImage: 'test_prompt_with_image',
	inputRequired: 'test_input_required_result_prompt',
	hidden: 'test_hidden_prompt',
} as const;

const RESOURCE = {
	staticText: 'test://static-text',
	staticBinary: 'test://static-binary',
	watched: 'test://watched-resource',
} as const;

export const CONFORMANCE_RESOURCE_TEMPLATE = 'test://template/{id}/data';

/**
 * The skills the fixture serves (Skills extension, SEP-2640): a skill with
 * nested directories (so `resources/directory/read` has a subdirectory to
 * list) and one under an organizational prefix.
 */
export const CONFORMANCE_SKILLS: readonly IMcpSkillDefinition[] = [
	{
		skillMd: [
			'---',
			'name: pdf-processing',
			'description: Extract, fill, and assemble PDF documents',
			'license: Apache-2.0',
			'metadata:',
			'  version: 2.1.0',
			'---',
			'',
			'# PDF processing',
			'',
			'Fill forms with `references/FORMS.md` and pick a template from `templates/`.',
			'',
		].join('\n'),
		files: [
			{ path: 'references/FORMS.md', content: '# Forms\n\nHow to fill PDF forms.\n' },
			{ path: 'scripts/extract.py', content: 'print("extract")\n' },
			{ path: 'templates/invoice.md', content: '# Invoice\n' },
			{ path: 'templates/regional/eu-invoice.md', content: '# EU invoice\n' },
		],
	},
	{
		prefix: 'acme/billing',
		skillMd: '---\nname: refunds\ndescription: Process customer refund requests per company policy\n---\n\nFollow `examples/email.md`.\n',
		files: [{ path: 'examples/email.md', content: 'Dear customer,\n' }],
	},
];

/** Every tool the fixture registers (hidden ones included). */
export const CONFORMANCE_TOOL_NAMES: readonly string[] = Object.values(TOOL);
/** Every prompt the fixture registers (hidden ones included). */
export const CONFORMANCE_PROMPT_NAMES: readonly string[] = Object.values(PROMPT);
/** The concrete resources the fixture lists. */
export const CONFORMANCE_RESOURCE_URIS: readonly string[] = Object.values(RESOURCE);
/** Tools and prompts that only appear after a `test_trigger_*_change` call. */
export const CONFORMANCE_HIDDEN_TOOL = TOOL.hiddenTool;
export const CONFORMANCE_HIDDEN_PROMPT = PROMPT.hidden;

type ToolResult = MCPLegacy.CallToolResult | IMcpGatewayInputRequired;
type ToolHandler = (args: Record<string, unknown>, ctx: IMcpGatewayInvokeContext | undefined) => Promise<ToolResult>;

interface IToolEntry {
	readonly tool: MCPLegacy.Tool;
	readonly handler: ToolHandler;
}

const EMPTY_SCHEMA: MCPLegacy.Tool['inputSchema'] = { type: 'object', properties: {} };

function text(value: string): MCPLegacy.CallToolResult {
	return { content: [{ type: 'text', text: value }] };
}

function inputRequired(inputRequests: MCP.InputRequests, requestState?: string): IMcpGatewayInputRequired {
	return requestState === undefined ? { resultType: 'input_required', inputRequests } : { resultType: 'input_required', inputRequests, requestState };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function elicitForm(message: string, requestedSchema: object): MCP.ElicitRequest {
	return { method: 'elicitation/create', params: { message, requestedSchema: requestedSchema as MCP.ElicitRequestFormParams['requestedSchema'] } };
}

function stringSchema(property: string, required = true): object {
	return { type: 'object', properties: { [property]: { type: 'string' } }, ...(required ? { required: [property] } : {}) };
}

function sample(prompt: string, maxTokens = 100): MCP.CreateMessageRequest {
	return { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: prompt } }], maxTokens } };
}

function listRoots(): MCP.ListRootsRequest {
	return { method: 'roots/list', params: {} };
}

function responseOf(ctx: IMcpGatewayInvokeContext | undefined, key: string): Record<string, unknown> | undefined {
	const responses = ctx?.inputResponses as Readonly<Record<string, unknown>> | undefined;
	const value = responses?.[key];
	return isObject(value) ? value : undefined;
}

/** An `elicitation/create` answer: an object with an `action`. */
function elicitResponse(ctx: IMcpGatewayInvokeContext | undefined, key: string): { readonly action: string; readonly content?: Record<string, unknown> } | undefined {
	const value = responseOf(ctx, key);
	if (!value || typeof value.action !== 'string') {
		return undefined;
	}
	return { action: value.action, content: isObject(value.content) ? value.content : undefined };
}

/** A `sampling/createMessage` answer: a message with a `model`. */
function sampleResponse(ctx: IMcpGatewayInvokeContext | undefined, key: string): { readonly model: string; readonly text: string } | undefined {
	const value = responseOf(ctx, key);
	if (!value || value.content === undefined) {
		return undefined;
	}
	const content = value.content;
	const first = Array.isArray(content) ? content[0] : content;
	const answer = isObject(first) && typeof first.text === 'string' ? first.text : '(non-text)';
	return { model: typeof value.model === 'string' ? value.model : 'unknown', text: answer };
}

/** A `roots/list` answer: an object with a `roots` array. */
function rootsResponse(ctx: IMcpGatewayInvokeContext | undefined, key: string): readonly unknown[] | undefined {
	const value = responseOf(ctx, key);
	return value && Array.isArray(value.roots) ? value.roots : undefined;
}

function stateOf(ctx: IMcpGatewayInvokeContext | undefined): Record<string, unknown> | undefined {
	if (ctx?.requestState === undefined) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(ctx.requestState);
		return isObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function hasCapability(ctx: IMcpGatewayInvokeContext | undefined, key: 'elicitation' | 'sampling' | 'roots'): boolean {
	return ctx?.clientCapabilities?.[key] !== undefined;
}

/** How long `test_reconnection` works after closing its stream (the client reconnects meanwhile). */
export const RECONNECTION_DELAY_MS = 100;

async function delay(ms: number, token: CancellationToken | undefined): Promise<void> {
	await timeout(ms, token ?? CancellationToken.None);
}

/**
 * The conformance fixture invoker. Visibility toggles of the hidden tool and
 * prompt fire the list-changed events; {@link touchResource} fires a
 * resource update for subscribers.
 */
export class McpGatewayConformanceInvoker extends Disposable implements IMcpGatewaySingleServerInvoker, IMcpGatewayTaskCapableInvoker {
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;
	private readonly _onDidChangeResources = this._register(new Emitter<void>());
	readonly onDidChangeResources: Event<void> = this._onDidChangeResources.event;
	private readonly _onDidChangePrompts = this._register(new Emitter<void>());
	readonly onDidChangePrompts: Event<void> = this._onDidChangePrompts.event;
	private readonly _onDidUpdateResource = this._register(new Emitter<{ readonly uri: string }>());
	readonly onDidUpdateResource: Event<{ readonly uri: string }> = this._onDidUpdateResource.event;

	readonly capabilities = CONFORMANCE_CAPABILITIES;
	readonly instructions = CONFORMANCE_INSTRUCTIONS;
	readonly cacheHints = CONFORMANCE_CACHE_HINTS;
	readonly tasks = CONFORMANCE_TASK_OPTIONS;

	private readonly _tools = new Map<string, IToolEntry>();
	private readonly _hiddenTools = new Set<string>([TOOL.hiddenTool]);
	private readonly _hiddenPrompts = new Set<string>([PROMPT.hidden]);
	private readonly _subscriptions = new Map<string, number>();
	private _skills: Promise<McpSkillCatalog> | undefined;

	constructor() {
		super();
		this._registerTools();
	}

	// ---- test hooks -------------------------------------------------------------

	/** Fires `onDidUpdateResource` for a URI (subscribers get `notifications/resources/updated`). */
	touchResource(uri: string): void {
		this._onDidUpdateResource.fire({ uri });
	}

	/** Shows or hides a tool; a visibility change fires `onDidChangeTools`. */
	setToolHidden(name: string, hidden: boolean): void {
		if (this._hiddenTools.has(name) === hidden) {
			return;
		}
		if (hidden) {
			this._hiddenTools.add(name);
		} else {
			this._hiddenTools.delete(name);
		}
		this._onDidChangeTools.fire();
	}

	/** Shows or hides a prompt; a visibility change fires `onDidChangePrompts`. */
	setPromptHidden(name: string, hidden: boolean): void {
		if (this._hiddenPrompts.has(name) === hidden) {
			return;
		}
		if (hidden) {
			this._hiddenPrompts.add(name);
		} else {
			this._hiddenPrompts.delete(name);
		}
		this._onDidChangePrompts.fire();
	}

	isToolHidden(name: string): boolean {
		return this._hiddenTools.has(name);
	}

	isPromptHidden(name: string): boolean {
		return this._hiddenPrompts.has(name);
	}

	/** The number of open subscriptions to a URI (through `subscribeResource`). */
	subscriptionCount(uri: string): number {
		return this._subscriptions.get(uri) ?? 0;
	}

	// ---- tools ------------------------------------------------------------------

	async listTools(): Promise<readonly MCPLegacy.Tool[]> {
		return [...this._tools.values()].filter(entry => !this._hiddenTools.has(entry.tool.name)).map(entry => entry.tool);
	}

	async callTool(name: string, args: Record<string, unknown>, context?: IMcpGatewayInvokeContext): Promise<ToolResult> {
		const entry = this._tools.get(name);
		if (!entry || this._hiddenTools.has(name)) {
			throw new McpGatewayRpcError(MCP.INVALID_PARAMS, `Unknown tool: ${name}`);
		}
		return entry.handler(args, context);
	}

	private _addTool(name: string, description: string, handler: ToolHandler, inputSchema: MCPLegacy.Tool['inputSchema'] = EMPTY_SCHEMA, taskSupport?: McpGatewayTaskSupport): void {
		const tool: MCPLegacy.Tool = { name, description, inputSchema };
		if (taskSupport) {
			tool.execution = { taskSupport };
		}
		this._tools.set(name, { tool, handler });
	}

	private _registerTools(): void {
		this._addTool(TOOL.simpleText, 'Returns simple text content', async () => text('This is a simple text response for testing.'));
		this._addTool(TOOL.imageContent, 'Returns image content', async () => ({ content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }] }));
		this._addTool(TOOL.audioContent, 'Returns audio content', async () => ({ content: [{ type: 'audio', data: WAV_EMPTY, mimeType: 'audio/wav' }] }));
		this._addTool(TOOL.embeddedResource, 'Returns an embedded resource', async () => ({
			content: [{ type: 'resource', resource: { uri: 'test://embedded-resource', mimeType: 'text/plain', text: 'This is an embedded resource content.' } }],
		}));
		this._addTool(TOOL.multipleContentTypes, 'Returns text, image and resource content', async () => ({
			content: [
				{ type: 'text', text: 'Multiple content types test:' },
				{ type: 'image', data: PNG_1X1, mimeType: 'image/png' },
				{ type: 'resource', resource: { uri: 'test://mixed-content-resource', mimeType: 'application/json', text: '{"test":"data","value":123}' } },
			],
		}));
		this._addTool(TOOL.errorHandling, 'Always returns a tool error', async () => ({
			isError: true,
			content: [{ type: 'text', text: 'This tool intentionally returns an error for testing' }],
		}));
		this._addTool(TOOL.withProgress, 'Reports progress notifications', async (_args, ctx) => {
			for (const progress of [0, 50, 100]) {
				ctx?.onProgress?.({ progress, total: 100, message: `Completed step ${progress / 50 + 1} of 3` });
				if (progress < 100) {
					await delay(50, ctx?.token);
				}
			}
			return text('Progress test completed');
		});
		const withLogging: ToolHandler = async (_args, ctx) => {
			ctx?.onLog?.('info', 'Tool execution started', 'conformance-server');
			await delay(50, ctx?.token);
			ctx?.onLog?.('info', 'Tool processing data', 'conformance-server');
			await delay(50, ctx?.token);
			ctx?.onLog?.('info', 'Tool execution completed', 'conformance-server');
			return text('Logging test completed');
		};
		this._addTool(TOOL.withLogging, 'Sends log messages during execution', withLogging);
		this._addTool(TOOL.loggingTool, 'Sends log messages during execution', withLogging);
		this._addTool(TOOL.missingCapability, 'Needs the sampling capability of the client', async (_args, ctx) => {
			const answer = sampleResponse(ctx, 'sample');
			if (answer) {
				return text(`Sampled with model ${answer.model}`);
			}
			// Always asks: without the client's sampling capability the gateway answers -32021.
			return inputRequired({ sample: sample('Say hello') });
		});
		this._addTool(TOOL.streamingElicitation, 'Answers on a streamed response', async () => text('Streaming elicitation acknowledged'));
		this._addTool(TOOL.sampling, 'Requests LLM sampling from the client', async (args, ctx) => {
			const answer = sampleResponse(ctx, 'sample');
			if (answer) {
				return text(`LLM response: ${answer.text}`);
			}
			const prompt = typeof args.prompt === 'string' ? args.prompt : 'Say hello';
			return inputRequired({ sample: sample(prompt) });
		}, { type: 'object', properties: { prompt: { type: 'string', description: 'The prompt to send to the LLM' } }, required: ['prompt'] });
		this._addTool(TOOL.elicitation, 'Requests user input from the client', async (args, ctx) => {
			const answer = elicitResponse(ctx, 'input');
			if (answer) {
				return text(`User response: action=${answer.action}, content=${JSON.stringify(answer.content ?? {})}`);
			}
			const message = typeof args.message === 'string' ? args.message : 'Please provide your information';
			return inputRequired({
				input: elicitForm(message, {
					type: 'object',
					properties: {
						username: { type: 'string', description: 'User\'s response' },
						email: { type: 'string', description: 'User\'s email address' },
					},
					required: ['username', 'email'],
				}),
			});
		}, { type: 'object', properties: { message: { type: 'string', description: 'The message to show the user' } }, required: ['message'] });
		this._addTool(TOOL.elicitationEnums, 'Requests elicitation with every enum schema variant (SEP-1330)', async (_args, ctx) => {
			const answer = elicitResponse(ctx, 'enums');
			if (answer) {
				return text(`Elicitation completed: action=${answer.action}, content=${JSON.stringify(answer.content ?? {})}`);
			}
			return inputRequired({
				enums: elicitForm('Please choose from the enum fields', {
					type: 'object',
					properties: {
						untitledSingle: { type: 'string', enum: ['option1', 'option2', 'option3'] },
						titledSingle: { type: 'string', oneOf: [{ const: 'value1', title: 'First Option' }, { const: 'value2', title: 'Second Option' }, { const: 'value3', title: 'Third Option' }] },
						legacyEnum: { type: 'string', enum: ['opt1', 'opt2', 'opt3'], enumNames: ['Option One', 'Option Two', 'Option Three'] },
						untitledMulti: { type: 'array', items: { type: 'string', enum: ['option1', 'option2', 'option3'] } },
						titledMulti: { type: 'array', items: { anyOf: [{ const: 'value1', title: 'First Choice' }, { const: 'value2', title: 'Second Choice' }, { const: 'value3', title: 'Third Choice' }] } },
					},
				}),
			});
		});
		this._addTool(TOOL.elicitationDefaults, 'Requests elicitation with default values (SEP-1034)', async (_args, ctx) => {
			const answer = elicitResponse(ctx, 'defaults');
			if (answer) {
				return text(`Elicitation completed: action=${answer.action}, content=${JSON.stringify(answer.content ?? {})}`);
			}
			return inputRequired({
				defaults: elicitForm('Please review and update the form fields with defaults', {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'User name', default: 'John Doe' },
						age: { type: 'integer', description: 'User age', default: 30 },
						score: { type: 'number', description: 'User score', default: 95.5 },
						status: { type: 'string', description: 'User status', enum: ['active', 'inactive', 'pending'], default: 'active' },
						verified: { type: 'boolean', description: 'Verification status', default: true },
					},
				}),
			});
		});
		this._addTool(TOOL.triggerToolChange, 'Shows or hides test_hidden_tool (fires tools/list_changed)', async () => {
			this.setToolHidden(TOOL.hiddenTool, !this._hiddenTools.has(TOOL.hiddenTool));
			return text('Tool list changed');
		});
		this._addTool(TOOL.triggerPromptChange, 'Shows or hides test_hidden_prompt (fires prompts/list_changed)', async () => {
			this.setPromptHidden(PROMPT.hidden, !this._hiddenPrompts.has(PROMPT.hidden));
			return text('Prompt list changed');
		});
		this._addTool(TOOL.hiddenTool, 'Appears after test_trigger_tool_change', async () => text('hidden'));
		this._addTool(TOOL.reconnection, 'Closes the SSE stream mid-call so the client reconnects (SEP-1699 polling)', async (_args, ctx) => {
			// 2025-11-25 sessions: the response stream ends here; the result below is
			// replayed when the client reconnects with Last-Event-ID. Elsewhere a no-op.
			ctx?.closeSseStream?.();
			await delay(RECONNECTION_DELAY_MS, ctx?.token);
			return text('Reconnection test completed');
		});

		// ---- 2026-07-28 multi round-trip requests (SEP-2322) ----
		this._addTool(TOOL.irElicitation, 'MRTR: asks for a name through elicitation', async (_args, ctx) => {
			const answer = elicitResponse(ctx, 'user_name');
			if (answer) {
				const name = typeof answer.content?.name === 'string' ? answer.content.name : 'unknown';
				return text(answer.action === 'accept' ? `Hello, ${name}!` : 'The user declined');
			}
			return inputRequired({ user_name: elicitForm('What is your name?', stringSchema('name')) });
		});
		this._addTool(TOOL.irSampling, 'MRTR: asks the client\'s model a question', async (_args, ctx) => {
			const answer = sampleResponse(ctx, 'capital_question');
			if (answer) {
				return text(`The model (${answer.model}) said: ${answer.text}`);
			}
			return inputRequired({ capital_question: sample('What is the capital of France?') });
		});
		this._addTool(TOOL.irListRoots, 'MRTR: asks for the client\'s roots', async (_args, ctx) => {
			const roots = rootsResponse(ctx, 'client_roots');
			if (roots) {
				return text(`The client has ${roots.length} root(s)`);
			}
			return inputRequired({ client_roots: listRoots() });
		});
		this._addTool(TOOL.irRequestState, 'MRTR: round-trips an opaque requestState', async (_args, ctx) => {
			if (elicitResponse(ctx, 'confirm')) {
				const state = stateOf(ctx);
				return text(typeof state?.nonce === 'string' ? `state-ok ${state.nonce}` : 'state-missing');
			}
			return inputRequired({
				confirm: elicitForm('Please confirm', { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }),
			}, JSON.stringify({ nonce: 'request-state-nonce' }));
		});
		this._addTool(TOOL.irMultipleInputs, 'MRTR: asks for elicitation, sampling and roots at once', async (_args, ctx) => {
			const name = elicitResponse(ctx, 'user_name');
			const greeting = sampleResponse(ctx, 'greeting');
			const roots = rootsResponse(ctx, 'client_roots');
			if (name && greeting && roots) {
				const userName = typeof name.content?.name === 'string' ? name.content.name : 'unknown';
				return text(`${userName}: model ${greeting.model}, ${roots.length} roots`);
			}
			const requests: MCP.InputRequests = {};
			if (!name) {
				requests.user_name = elicitForm('What is your name?', stringSchema('name'));
			}
			if (!greeting) {
				requests.greeting = sample('Generate a greeting', 50);
			}
			if (!roots) {
				requests.client_roots = listRoots();
			}
			return inputRequired(requests, JSON.stringify({ phase: 'collect' }));
		});
		this._addTool(TOOL.irMultiRound, 'MRTR: three rounds with an evolving requestState', async (_args, ctx) => {
			const state = stateOf(ctx);
			const round = typeof state?.round === 'number' ? state.round : 0;
			const askName = () => inputRequired({ step1: elicitForm('Step 1: What is your name?', stringSchema('name')) }, JSON.stringify({ round: 1 }));
			if (round === 0) {
				return askName();
			}
			if (round === 1) {
				const answer = elicitResponse(ctx, 'step1');
				if (!answer) {
					return askName();
				}
				const name = typeof answer.content?.name === 'string' ? answer.content.name : 'someone';
				return inputRequired({ step2: elicitForm('Step 2: What is your favorite color?', stringSchema('color')) }, JSON.stringify({ round: 2, name }));
			}
			const answer = elicitResponse(ctx, 'step2');
			if (!answer) {
				return inputRequired({ step2: elicitForm('Step 2: What is your favorite color?', stringSchema('color')) }, JSON.stringify(state));
			}
			const color = typeof answer.content?.color === 'string' ? answer.content.color : '?';
			return text(`${typeof state?.name === 'string' ? state.name : 'someone'} likes ${color}`);
		});
		this._addTool(TOOL.irTamperedState, 'MRTR: integrity-protected requestState', async (_args, ctx) => {
			if (elicitResponse(ctx, 'confirm')) {
				return text('state accepted');
			}
			return inputRequired({
				confirm: elicitForm('Confirm?', { type: 'object', properties: { ok: { type: 'boolean' } } }),
			}, JSON.stringify({ secret: 'do-not-tamper' }));
		});
		this._addTool(TOOL.irCapabilities, 'MRTR: asks only for what the client declared', async (_args, ctx) => {
			const requests: MCP.InputRequests = {};
			if (hasCapability(ctx, 'elicitation') && !elicitResponse(ctx, 'user_name')) {
				requests.user_name = elicitForm('What is your name?', stringSchema('name'));
			}
			if (hasCapability(ctx, 'sampling') && !sampleResponse(ctx, 'greeting')) {
				requests.greeting = sample('Say hello');
			}
			if (hasCapability(ctx, 'roots') && !rootsResponse(ctx, 'client_roots')) {
				requests.client_roots = listRoots();
			}
			return Object.keys(requests).length > 0 ? inputRequired(requests) : text('All declared capabilities were used');
		});

		// ---- schema and header fixtures ----
		this._addTool(TOOL.jsonSchema2020, 'Tool with JSON Schema 2020-12 features', async args => text(JSON.stringify(args)), JSON_SCHEMA_2020_12_TOOL_SCHEMA as unknown as MCPLegacy.Tool['inputSchema']);
		this._addTool(TOOL.xMcpHeader, 'Tool whose arguments are mirrored into Mcp-Param headers (SEP-2243)', async args => {
			return text(`region=${String(args.region)} priority=${String(args.priority)} verbose=${String(args.verbose)}`);
		}, {
			type: 'object',
			properties: {
				region: { type: 'string', description: 'The region', 'x-mcp-header': 'Region' },
				priority: { type: 'integer', description: 'The priority', 'x-mcp-header': 'Priority' },
				verbose: { type: 'boolean', description: 'Verbose output', 'x-mcp-header': 'Verbose' },
			},
			required: ['region'],
		});

		// ---- gRPC interop (the zig-sdk `grpc_server` example's tool) ----
		this._addTool(TOOL.add, 'Add two integers.', async (args, ctx) => {
			if (typeof args.a !== 'number' || typeof args.b !== 'number' || !Number.isInteger(args.a) || !Number.isInteger(args.b)) {
				throw new McpGatewayRpcError(MCP.INVALID_PARAMS, 'add needs the integers a and b');
			}
			ctx?.onProgress?.({ progress: 1, total: 2, message: 'adding' });
			return text(String(args.a + args.b));
		}, { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] });

		this._registerTaskTools();
	}

	/**
	 * The fixtures of the Tasks extension scenarios (SEP-2663), as in the zig
	 * SDK's everything server. A task tool returns {@link startTaskResult}
	 * outside a task; the gateway then runs it again inside the task (or, for
	 * a client that did not opt in, at once) with {@link taskRunOf} set.
	 */
	private _registerTaskTools(): void {
		this._addTool(TOOL.greet, 'Greets by name (never a task)', async args => text(`Hello, ${typeof args.name === 'string' ? args.name : 'world'}!`), {
			type: 'object',
			properties: { name: { type: 'string', description: 'Who to greet' } },
		});
		this._addTool(TOOL.slowCompute, 'Sleeps for some seconds inside a task (0 seconds: answers at once)', async (args, ctx) => {
			const seconds = typeof args.seconds === 'number' && Number.isFinite(args.seconds) ? Math.max(0, args.seconds) : 0;
			const label = typeof args.label === 'string' ? args.label : 'job';
			if (!taskRunOf(ctx)) {
				// The immediate-result shortcut: nothing to wait for, no task.
				return seconds === 0 ? text(`computed ${label} after 0 s`) : startTaskResult();
			}
			// Cancellation (tasks/cancel) ends the sleep, and the task settles as cancelled.
			await delay(seconds * 1000, ctx?.token);
			return text(`computed ${label} after ${seconds} s`);
		}, {
			type: 'object',
			properties: {
				seconds: { type: 'number', description: 'How long to work' },
				label: { type: 'string', description: 'A label for the result' },
			},
		}, 'optional');
		this._addTool(TOOL.failingJob, 'A task that ends in a tool error', async (_args, ctx) => {
			if (!taskRunOf(ctx)) {
				return startTaskResult();
			}
			await delay(1000, ctx?.token);
			return { isError: true, content: [{ type: 'text', text: 'The job failed as designed' }] };
		}, EMPTY_SCHEMA, 'required');
		this._addTool(TOOL.protocolErrorJob, 'A task that ends in a protocol error', async (_args, ctx) => {
			if (!taskRunOf(ctx)) {
				return startTaskResult();
			}
			throw new McpGatewayRpcError(MCP.INTERNAL_ERROR, 'The job hit an internal error as designed');
		}, EMPTY_SCHEMA, 'optional');
		this._addTool(TOOL.confirmDelete, 'A task that asks for confirmation', async (args, ctx) => {
			if (!taskRunOf(ctx)) {
				return startTaskResult();
			}
			const filename = typeof args.filename === 'string' ? args.filename : 'file.txt';
			const answer = elicitResponse(ctx, 'confirm');
			if (answer) {
				return text(answer.action === 'accept' ? `Deleted ${filename}` : `Kept ${filename}`);
			}
			return inputRequired({ confirm: elicitForm(`Delete ${filename}?`, { type: 'object', properties: { confirm: { type: 'boolean', description: 'Confirm the deletion' } } }) });
		}, {
			type: 'object',
			properties: { filename: { type: 'string', description: 'The file to delete' } },
		}, 'optional');
		this._addTool(TOOL.multiInput, 'A task that asks two questions at once', async (_args, ctx) => {
			if (!taskRunOf(ctx)) {
				return startTaskResult();
			}
			const first = elicitResponse(ctx, 'first');
			const second = elicitResponse(ctx, 'second');
			if (first && second) {
				const nameOf = (answer: { readonly content?: Record<string, unknown> }) => typeof answer.content?.name === 'string' ? answer.content.name : 'unknown';
				return text(`${nameOf(first)} and ${nameOf(second)}`);
			}
			const requests: MCP.InputRequests = {};
			if (!first) {
				requests.first = elicitForm('First name?', stringSchema('name'));
			}
			if (!second) {
				requests.second = elicitForm('Second name?', stringSchema('name'));
			}
			return inputRequired(requests);
		}, EMPTY_SCHEMA, 'optional');
		this._addTool(TOOL.toolWithTask, 'Asks for a name (MRTR), then finishes in a task', async (_args, ctx) => {
			const answer = elicitResponse(ctx, 'user_name');
			if (!answer) {
				// Round one is an ordinary input_required result: no task yet.
				return inputRequired({ user_name: elicitForm('What is your name?', stringSchema('name')) });
			}
			if (!taskRunOf(ctx)) {
				return startTaskResult();
			}
			const name = typeof answer.content?.name === 'string' ? answer.content.name : 'unknown';
			return text(`Hello, ${name}! The task is done.`);
		}, EMPTY_SCHEMA, 'required');
	}

	// ---- resources --------------------------------------------------------------

	async listResources(): Promise<readonly MCPLegacy.Resource[]> {
		return [
			{ uri: RESOURCE.staticText, name: 'Static Text Resource', description: 'A static text resource for testing', mimeType: 'text/plain' },
			{ uri: RESOURCE.staticBinary, name: 'Static Binary Resource', description: 'A static binary resource (image) for testing', mimeType: 'image/png' },
			{ uri: RESOURCE.watched, name: 'Watched Resource', description: 'A resource subscribers get updates for', mimeType: 'text/plain' },
			...(await this._skillCatalog()).resources(),
		];
	}

	async listResourceTemplates(): Promise<readonly MCPLegacy.ResourceTemplate[]> {
		return [{ uriTemplate: CONFORMANCE_RESOURCE_TEMPLATE, name: 'Template Resource', description: 'A resource template with an id parameter', mimeType: 'application/json' }];
	}

	async readResource(uri: string): Promise<MCPLegacy.ReadResourceResult> {
		switch (uri) {
			case RESOURCE.staticText:
				return { contents: [{ uri, mimeType: 'text/plain', text: 'This is the content of the static text resource.' }] };
			case RESOURCE.staticBinary:
				return { contents: [{ uri, mimeType: 'image/png', blob: PNG_1X1 }] };
			case RESOURCE.watched:
				return { contents: [{ uri, mimeType: 'text/plain', text: 'Watched resource content' }] };
		}
		const match = /^test:\/\/template\/([^/]+)\/data$/.exec(uri);
		if (match) {
			const id = decodeURIComponent(match[1]);
			return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` }) }] };
		}
		const skillFile = (await this._skillCatalog()).read(uri);
		if (skillFile) {
			return skillFile;
		}
		throw new McpGatewayResourceNotFoundError(uri);
	}

	// ---- skills (SEP-2640) ------------------------------------------------------

	private _skillCatalog(): Promise<McpSkillCatalog> {
		this._skills ??= McpSkillCatalog.create(CONFORMANCE_SKILLS);
		return this._skills;
	}

	async listSkills(): Promise<readonly McpSkills.Skill[]> {
		return (await this._skillCatalog()).entries;
	}

	async getSkill(uri: string): Promise<McpSkills.Skill | undefined> {
		return (await this._skillCatalog()).getSkill(uri);
	}

	async readDirectory(uri: string): Promise<readonly MCPLegacy.Resource[] | undefined> {
		return (await this._skillCatalog()).readDirectory(uri);
	}

	async subscribeResource(uri: string): Promise<IDisposable> {
		this._subscriptions.set(uri, this.subscriptionCount(uri) + 1);
		return toDisposable(() => {
			const count = this.subscriptionCount(uri) - 1;
			if (count > 0) {
				this._subscriptions.set(uri, count);
			} else {
				this._subscriptions.delete(uri);
			}
		});
	}

	// ---- prompts ----------------------------------------------------------------

	async listPrompts(): Promise<readonly MCPLegacy.Prompt[]> {
		const prompts: MCPLegacy.Prompt[] = [
			{ name: PROMPT.simple, description: 'A simple prompt without arguments' },
			{
				name: PROMPT.withArguments, description: 'A prompt with arguments', arguments: [
					{ name: 'arg1', description: 'First test argument', required: true },
					{ name: 'arg2', description: 'Second test argument', required: true },
				]
			},
			{ name: PROMPT.withEmbeddedResource, description: 'A prompt with an embedded resource', arguments: [{ name: 'resourceUri', description: 'URI of the resource to embed', required: true }] },
			{ name: PROMPT.withImage, description: 'A prompt with image content' },
			{ name: PROMPT.inputRequired, description: 'A prompt that needs input from the client (MRTR)' },
			{ name: PROMPT.hidden, description: 'Appears after test_trigger_prompt_change' },
		];
		return prompts.filter(prompt => !this._hiddenPrompts.has(prompt.name));
	}

	async getPrompt(name: string, args: Record<string, string> | undefined, context?: IMcpGatewayInvokeContext): Promise<MCPLegacy.GetPromptResult | IMcpGatewayInputRequired> {
		if (this._hiddenPrompts.has(name)) {
			throw new McpGatewayRpcError(MCP.INVALID_PARAMS, `Unknown prompt: ${name}`);
		}
		switch (name) {
			case PROMPT.simple:
				return { description: 'A simple prompt', messages: [{ role: 'user', content: { type: 'text', text: 'This is a simple prompt for testing.' } }] };
			case PROMPT.withArguments:
				return { messages: [{ role: 'user', content: { type: 'text', text: `Prompt with arguments: arg1='${args?.arg1 ?? ''}', arg2='${args?.arg2 ?? ''}'` } }] };
			case PROMPT.withEmbeddedResource: {
				const uri = args?.resourceUri ?? 'test://example-resource';
				return {
					messages: [
						{ role: 'user', content: { type: 'resource', resource: { uri, mimeType: 'text/plain', text: 'Embedded resource content for testing.' } } },
						{ role: 'user', content: { type: 'text', text: 'Please process the embedded resource above.' } },
					],
				};
			}
			case PROMPT.withImage:
				return {
					messages: [
						{ role: 'user', content: { type: 'image', data: PNG_1X1, mimeType: 'image/png' } },
						{ role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } },
					],
				};
			case PROMPT.inputRequired: {
				const answer = elicitResponse(context, 'user_context');
				if (answer) {
					const value = typeof answer.content?.context === 'string' ? answer.content.context : '';
					return { messages: [{ role: 'user', content: { type: 'text', text: `Context: ${value}` } }] };
				}
				return inputRequired({ user_context: elicitForm('What context should the prompt use?', stringSchema('context')) });
			}
			case PROMPT.hidden:
				return { messages: [{ role: 'user', content: { type: 'text', text: 'hidden' } }] };
			default:
				throw new McpGatewayRpcError(MCP.INVALID_PARAMS, `Unknown prompt: ${name}`);
		}
	}

	async complete(params: MCPLegacy.CompleteRequest['params']): Promise<MCPLegacy.CompleteResult> {
		let candidates: readonly string[] = [];
		if (params.ref.type === 'ref/prompt' && params.ref.name === PROMPT.withArguments) {
			candidates = params.argument.name === 'arg1' ? ['paris', 'park', 'party'] : ['world', 'wonder'];
		} else if (params.ref.type === 'ref/resource' && params.argument.name === 'id') {
			candidates = ['1', '2', '3', '123'];
		}
		const values = candidates.filter(value => value.startsWith(params.argument.value));
		return { completion: { values, total: values.length, hasMore: false } };
	}
}
