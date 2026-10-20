/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MCPLegacy } from '../../../platform/mcp/common/modelContextProtocolLegacy.js';
import { IConformanceContext } from './mcpConformanceProxy.js';

/**
 * What the conformance client does in each scenario of the official suite
 * (`@modelcontextprotocol/conformance`). A driver only decides which requests
 * to make; the protocol engine and the transport do the rest, which is what
 * the suite measures.
 */

export const MCP_REVISION_2026_07_28 = '2026-07-28';
export const MCP_REVISION_2025_11_25 = '2025-11-25';

/** The requests a driver can make. The client wraps the protocol engine behind this so drivers stay testable. */
export interface IScenarioClient {
	readonly context: IConformanceContext;
	listTools(): Promise<MCPLegacy.Tool[]>;
	callTool(name: string, args?: Record<string, unknown>): Promise<MCPLegacy.CallToolResult>;
	listResources(): Promise<MCPLegacy.Resource[]>;
	readResource(uri: string): Promise<MCPLegacy.ReadResourceResult>;
	listPrompts(): Promise<MCPLegacy.Prompt[]>;
	getPrompt(name: string, args?: Record<string, string>): Promise<MCPLegacy.GetPromptResult>;
}

export interface IScenarioDriver {
	readonly name: string;
	readonly description: string;
	run(client: IScenarioClient): Promise<void>;
}

const BOTH_REVISIONS: readonly string[] = [MCP_REVISION_2026_07_28, MCP_REVISION_2025_11_25];
const ONLY_2026: readonly string[] = [MCP_REVISION_2026_07_28];
const ONLY_2025: readonly string[] = [MCP_REVISION_2025_11_25];

/**
 * The client scenarios the requirement sets score, with the revisions that
 * require them (`requirements/<revision>.yaml` of the suite).
 */
export const SCORED_CLIENT_SCENARIOS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
	['initialize', ONLY_2025],
	['tools_call', BOTH_REVISIONS],
	['elicitation-sep1034-client-defaults', ONLY_2025],
	['sse-retry', ONLY_2025],
	['request-metadata', ONLY_2026],
	['sep-2322-client-request-state', ONLY_2026],
	['http-standard-headers', ONLY_2026],
	['http-custom-headers', ONLY_2026],
	['http-invalid-tool-headers', ONLY_2026],
	['json-schema-ref-no-deref', ONLY_2026],
	['auth/metadata-default', BOTH_REVISIONS],
	['auth/metadata-var1', BOTH_REVISIONS],
	['auth/metadata-var2', BOTH_REVISIONS],
	['auth/metadata-var3', BOTH_REVISIONS],
	['auth/basic-cimd', BOTH_REVISIONS],
	['auth/scope-from-www-authenticate', BOTH_REVISIONS],
	['auth/scope-from-scopes-supported', BOTH_REVISIONS],
	['auth/scope-omitted-when-undefined', BOTH_REVISIONS],
	['auth/scope-step-up', BOTH_REVISIONS],
	['auth/scope-retry-limit', BOTH_REVISIONS],
	['auth/token-endpoint-auth-basic', BOTH_REVISIONS],
	['auth/token-endpoint-auth-post', BOTH_REVISIONS],
	['auth/token-endpoint-auth-none', BOTH_REVISIONS],
	['auth/pre-registration', BOTH_REVISIONS],
	['auth/resource-mismatch', ONLY_2026],
	['auth/offline-access-scope', ONLY_2026],
	['auth/offline-access-not-supported', ONLY_2026],
	['auth/authorization-server-migration', ONLY_2026],
	['auth/iss-supported', ONLY_2026],
	['auth/iss-not-advertised', ONLY_2026],
	['auth/iss-supported-missing', ONLY_2026],
	['auth/iss-wrong-issuer', ONLY_2026],
	['auth/iss-unexpected', ONLY_2026],
	['auth/iss-normalized', ONLY_2026],
	['auth/metadata-issuer-mismatch', ONLY_2026],
]);

/** The client scenarios both requirement sets run without scoring (extensions and later additions). */
export const UNSCORED_CLIENT_SCENARIOS: readonly string[] = [
	'auth/client-credentials-jwt',
	'auth/client-credentials-basic',
	'auth/enterprise-managed-authorization',
	'auth/dpop',
	'auth/dpop-nonce',
	'auth/wif-jwt-bearer',
	'json-schema-2020-12-preservation',
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaType(schema: Record<string, unknown>): string | undefined {
	const type = schema.type;
	if (typeof type === 'string') {
		return type;
	}
	if (Array.isArray(type)) {
		return type.find((t): t is string => typeof t === 'string' && t !== 'null') ?? undefined;
	}
	return undefined;
}

/**
 * The `default` values of an elicitation schema's properties (SEP-1034): the
 * values a client submits for the fields the user did not fill in.
 */
export function schemaDefaults(requestedSchema: unknown): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};
	if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) {
		return defaults;
	}
	for (const [name, property] of Object.entries(requestedSchema.properties)) {
		if (!isRecord(property) || property.default === undefined) {
			continue;
		}
		const value = property.default;
		switch (schemaType(property)) {
			case 'boolean':
				if (typeof value === 'boolean') {
					defaults[name] = value;
				}
				break;
			case 'number':
			case 'integer':
				if (typeof value === 'number') {
					defaults[name] = value;
				}
				break;
			case 'string':
				if (typeof value === 'string' && (!Array.isArray(property.enum) || property.enum.includes(value))) {
					defaults[name] = value;
				}
				break;
			default:
				defaults[name] = value;
		}
	}
	return defaults;
}

/** A plausible value for one input-schema property. */
function sampleValue(property: Record<string, unknown> | undefined): unknown {
	if (property?.default !== undefined) {
		return property.default;
	}
	if (Array.isArray(property?.enum) && property.enum.length > 0) {
		return property.enum[0];
	}
	switch (property ? schemaType(property) : undefined) {
		case 'number':
		case 'integer':
			return 1;
		case 'boolean':
			return true;
		case 'array':
			return [];
		case 'object':
			return {};
		case 'null':
			return null;
		default:
			return 'us-west1';
	}
}

/**
 * Arguments that satisfy a tool's input schema: every required property gets
 * its default, its first enum member or a sample value of its type.
 */
export function argumentsForSchema(inputSchema: unknown): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (!isRecord(inputSchema)) {
		return args;
	}
	const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
	const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((name): name is string => typeof name === 'string') : [];
	for (const name of required) {
		const property = properties[name];
		args[name] = sampleValue(isRecord(property) ? property : undefined);
	}
	return args;
}

function pickTool(tools: readonly MCPLegacy.Tool[], preferred: string): MCPLegacy.Tool | undefined {
	return tools.find(tool => tool.name === preferred) ?? tools[0];
}

/** Lists the tools and calls `preferred` (or the first tool) with arguments derived from its schema. */
function listAndCall(name: string, description: string, preferred: string): IScenarioDriver {
	return {
		name,
		description,
		async run(client) {
			const tools = await client.listTools();
			const tool = pickTool(tools, preferred);
			if (!tool) {
				throw new Error('The server lists no tools');
			}
			await client.callTool(tool.name, argumentsForSchema(tool.inputSchema));
		},
	};
}

const toolsCall = listAndCall('tools_call', 'Lists the tools and calls test-tool (or the first tool) with arguments that satisfy its schema', 'test-tool');

const authorized = listAndCall('auth/*', 'Lists the tools and calls test-tool; the transport answers the authorization challenges on the way', 'test-tool');

const initialize: IScenarioDriver = {
	name: 'initialize',
	description: 'Connects (the engine does the initialize handshake) and lists the tools',
	async run(client) {
		await client.listTools();
	},
};

const requestMetadata: IScenarioDriver = {
	name: 'request-metadata',
	description: 'Connects (server/discover, retried after the simulated version rejection) and lists the tools',
	async run(client) {
		await client.listTools();
	},
};

const requestState: IScenarioDriver = {
	name: 'sep-2322-client-request-state',
	description: 'Calls the four MRTR tools in turn: echoed requestState, omitted requestState, an unrelated call, a result without resultType',
	async run(client) {
		await client.listTools();
		for (const name of ['test_mrtr_echo_state', 'test_mrtr_no_state', 'test_mrtr_unrelated', 'test_mrtr_no_result_type']) {
			await client.callTool(name, {});
		}
	},
};

const standardHeaders: IScenarioDriver = {
	name: 'http-standard-headers',
	description: 'Calls every tool, reads every resource and gets every prompt so each method carries Mcp-Method and Mcp-Name',
	async run(client) {
		for (const tool of await client.listTools()) {
			await client.callTool(tool.name, argumentsForSchema(tool.inputSchema));
		}
		for (const resource of await client.listResources()) {
			await client.readResource(resource.uri);
		}
		for (const prompt of await client.listPrompts()) {
			await client.getPrompt(prompt.name);
		}
	},
};

const customHeaders: IScenarioDriver = {
	name: 'http-custom-headers',
	description: 'Replays the tool calls of the scenario context verbatim; the engine mirrors the annotated parameters into Mcp-Param headers',
	async run(client) {
		await client.listTools();
		const calls = client.context.toolCalls;
		if (!calls || calls.length === 0) {
			throw new Error('MCP_CONFORMANCE_CONTEXT carries no toolCalls to replay');
		}
		for (const call of calls) {
			await client.callTool(call.name, call.arguments);
		}
	},
};

const invalidToolHeaders: IScenarioDriver = {
	name: 'http-invalid-tool-headers',
	description: 'Calls every tool the engine kept; the ones with invalid x-mcp-header annotations were dropped from the listing',
	async run(client) {
		const tools = await client.listTools();
		if (tools.length === 0) {
			throw new Error('The engine dropped every tool');
		}
		for (const tool of tools) {
			await client.callTool(tool.name, argumentsForSchema(tool.inputSchema));
		}
	},
};

const refNoDeref: IScenarioDriver = {
	name: 'json-schema-ref-no-deref',
	description: 'Lists the tools; the engine never fetches a network $ref of an input schema',
	async run(client) {
		await client.listTools();
	},
};

export const JSON_SCHEMA_2020_12_TOOL = 'json_schema_2020_12_tool';
export const JSON_SCHEMA_ECHO_TOOL = 'json_schema_echo';

const schemaPreservation: IScenarioDriver = {
	name: 'json-schema-2020-12-preservation',
	description: 'Echoes the focal tool\'s inputSchema back exactly as received so the suite can see which keywords survived',
	async run(client) {
		const tools = await client.listTools();
		const focal = tools.find(tool => tool.name === JSON_SCHEMA_2020_12_TOOL);
		if (!focal) {
			throw new Error(`The server does not list ${JSON_SCHEMA_2020_12_TOOL}`);
		}
		await client.callTool(JSON_SCHEMA_ECHO_TOOL, { schema: focal.inputSchema });
	},
};

const elicitationDefaults: IScenarioDriver = {
	name: 'elicitation-sep1034-client-defaults',
	description: 'Calls the elicitation tool; the client accepts the form with the schema defaults',
	async run(client) {
		const tools = await client.listTools();
		const tool = pickTool(tools, 'test_client_elicitation_defaults');
		if (!tool) {
			throw new Error('The server lists no tools');
		}
		await client.callTool(tool.name, argumentsForSchema(tool.inputSchema));
	},
};

const sseRetry: IScenarioDriver = {
	name: 'sse-retry',
	description: 'Calls the reconnection tool and waits for its result; the transport resumes the closed stream after the advertised retry delay',
	async run(client) {
		const tools = await client.listTools();
		const tool = pickTool(tools, 'test_reconnection');
		if (!tool) {
			throw new Error('The server lists no tools');
		}
		await client.callTool(tool.name, argumentsForSchema(tool.inputSchema));
	},
};

const DRIVERS: ReadonlyMap<string, IScenarioDriver> = new Map<string, IScenarioDriver>([
	[initialize.name, initialize],
	[toolsCall.name, toolsCall],
	[elicitationDefaults.name, elicitationDefaults],
	[sseRetry.name, sseRetry],
	[requestMetadata.name, requestMetadata],
	[requestState.name, requestState],
	[standardHeaders.name, standardHeaders],
	[customHeaders.name, customHeaders],
	[invalidToolHeaders.name, invalidToolHeaders],
	[refNoDeref.name, refNoDeref],
	[schemaPreservation.name, schemaPreservation],
]);

/** The driver for a scenario name; every `auth/*` scenario shares the authorized driver. */
export function resolveScenario(name: string): IScenarioDriver | undefined {
	const driver = DRIVERS.get(name);
	if (driver) {
		return driver;
	}
	if (name.startsWith('auth/')) {
		return authorized;
	}
	return undefined;
}

/** Every scenario name the client drives (for the requirement matrix). */
export function drivenScenarios(): readonly string[] {
	const names = new Set<string>([...DRIVERS.keys()]);
	for (const name of [...SCORED_CLIENT_SCENARIOS.keys(), ...UNSCORED_CLIENT_SCENARIOS]) {
		if (resolveScenario(name)) {
			names.add(name);
		}
	}
	return [...names].sort();
}
