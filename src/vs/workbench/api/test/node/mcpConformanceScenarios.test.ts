/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { MCPLegacy } from '../../../../platform/mcp/common/modelContextProtocolLegacy.js';
import { IConformanceContext } from '../../node/mcpConformanceProxy.js';
import { argumentsForSchema, drivenScenarios, EXTENSION_CLIENT_SCENARIOS, IScenarioClient, MCP_REVISION_2025_11_25, MCP_REVISION_2026_07_28, resolveScenario, schemaDefaults, SCORED_CLIENT_SCENARIOS, UNSCORED_CLIENT_SCENARIOS } from '../../node/mcpConformanceScenarios.js';
import { McpSkills } from '../../../../platform/mcp/common/modelContextProtocolSkills.js';
import { McpLoadedSkill, McpSkillVerificationError } from '../../../contrib/mcp/common/mcpSkills.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

/** The SEP-1034 elicitation schema of the suite's elicitation-sep1034-client-defaults scenario. */
const SEP_1034_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string', description: 'User name', default: 'John Doe' },
		age: { type: 'integer', description: 'User age', default: 30 },
		score: { type: 'number', description: 'User score', default: 95.5 },
		status: { type: 'string', description: 'User status', enum: ['active', 'inactive', 'pending'], default: 'active' },
		verified: { type: 'boolean', description: 'Verification status', default: true },
	},
	required: [],
};

interface ICall {
	readonly method: string;
	readonly name?: string;
	readonly args?: unknown;
}

function tool(name: string, inputSchema: MCPLegacy.Tool['inputSchema'] = { type: 'object', properties: {}, required: [] }): MCPLegacy.Tool {
	return { name, inputSchema };
}

function fakeClient(options: { tools?: MCPLegacy.Tool[]; resources?: MCPLegacy.Resource[]; prompts?: MCPLegacy.Prompt[]; context?: Partial<IConformanceContext>; skills?: McpSkills.Skill[]; files?: Record<string, string> } = {}) {
	const calls: ICall[] = [];
	const client: IScenarioClient = {
		context: { raw: {}, ...options.context },
		async listTools() {
			calls.push({ method: 'tools/list' });
			return options.tools ?? [];
		},
		async callTool(name, args) {
			calls.push({ method: 'tools/call', name, args });
			return { content: [] };
		},
		async listResources() {
			calls.push({ method: 'resources/list' });
			return options.resources ?? [];
		},
		async readResource(uri) {
			calls.push({ method: 'resources/read', name: uri });
			return { contents: [] };
		},
		async listPrompts() {
			calls.push({ method: 'prompts/list' });
			return options.prompts ?? [];
		},
		async getPrompt(name, args) {
			calls.push({ method: 'prompts/get', name, args });
			return { messages: [] };
		},
		async listSkills() {
			calls.push({ method: 'skills/list' });
			return options.skills ?? [];
		},
		loadSkill(entry) {
			// The real loading path, over the fake server's files.
			return McpLoadedSkill.load({
				async readResource({ uri }) {
					calls.push({ method: 'resources/read', name: uri });
					const text = options.files?.[uri];
					return { contents: text === undefined ? [] : [{ uri, text }] };
				},
			}, entry);
		},
	};
	return { client, calls };
}

suite('MCP conformance - scenarios', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('schemaDefaults', () => {
		test('applies the SEP-1034 defaults of every primitive type', () => {
			assert.deepStrictEqual(schemaDefaults(SEP_1034_SCHEMA), { name: 'John Doe', age: 30, score: 95.5, status: 'active', verified: true });
		});

		test('skips properties without defaults and defaults of the wrong type', () => {
			assert.deepStrictEqual(schemaDefaults({
				type: 'object',
				properties: {
					confirmed: { type: 'boolean' },
					count: { type: 'integer', default: 'many' },
					flag: { type: 'boolean', default: 'yes' },
					mode: { type: 'string', enum: ['a', 'b'], default: 'c' },
					title: { type: 'string', default: 'x' },
					multi: { type: ['string', 'null'], default: 'y' },
				},
			}), { title: 'x', multi: 'y' });
		});

		test('is empty for anything that is not an object schema', () => {
			assert.deepStrictEqual(schemaDefaults(undefined), {});
			assert.deepStrictEqual(schemaDefaults('x'), {});
			assert.deepStrictEqual(schemaDefaults({ type: 'object' }), {});
		});
	});

	suite('argumentsForSchema', () => {
		test('fills every required property with a value of its type', () => {
			assert.deepStrictEqual(argumentsForSchema({
				type: 'object',
				properties: {
					region: { type: 'string' },
					a: { type: 'number' },
					b: { type: 'integer' },
					on: { type: 'boolean' },
					list: { type: 'array', items: { type: 'string' } },
					obj: { type: 'object' },
					nil: { type: 'null' },
					kind: { type: 'string', enum: ['x', 'y'] },
					preset: { type: 'string', default: 'd' },
					optional: { type: 'string' },
				},
				required: ['region', 'a', 'b', 'on', 'list', 'obj', 'nil', 'kind', 'preset', 'unknown'],
			}), { region: 'us-west1', a: 1, b: 1, on: true, list: [], obj: {}, nil: null, kind: 'x', preset: 'd', unknown: 'us-west1' });
		});

		test('is empty without required properties or for a non-object schema', () => {
			assert.deepStrictEqual(argumentsForSchema({ type: 'object', properties: { a: { type: 'string' } } }), {});
			assert.deepStrictEqual(argumentsForSchema(undefined), {});
		});
	});

	suite('scenario table', () => {
		test('matches the requirement sets of the suite', () => {
			const scored2026 = [...SCORED_CLIENT_SCENARIOS].filter(([, revisions]) => revisions.includes(MCP_REVISION_2026_07_28)).map(([name]) => name);
			const scored2025 = [...SCORED_CLIENT_SCENARIOS].filter(([, revisions]) => revisions.includes(MCP_REVISION_2025_11_25)).map(([name]) => name);
			assert.strictEqual(scored2026.length, 32);
			assert.strictEqual(scored2025.length, 18);
			assert.strictEqual(scored2026.filter(name => name.startsWith('auth/')).length, 25);
			assert.strictEqual(scored2025.filter(name => name.startsWith('auth/')).length, 14);
			assert.strictEqual(UNSCORED_CLIENT_SCENARIOS.length, 7);
		});

		test('every scored and unscored scenario has a driver', () => {
			for (const name of [...SCORED_CLIENT_SCENARIOS.keys(), ...UNSCORED_CLIENT_SCENARIOS]) {
				assert.ok(resolveScenario(name), `no driver for ${name}`);
			}
			assert.deepStrictEqual(drivenScenarios().filter(name => !SCORED_CLIENT_SCENARIOS.has(name) && !UNSCORED_CLIENT_SCENARIOS.includes(name) && !EXTENSION_CLIENT_SCENARIOS.includes(name)), []);
		});

		test('every extension scenario has its own driver', () => {
			for (const name of EXTENSION_CLIENT_SCENARIOS) {
				assert.strictEqual(resolveScenario(name)?.name, name);
			}
		});

		test('unknown scenarios have no driver and every auth scenario shares one', () => {
			assert.strictEqual(resolveScenario('no-such-scenario'), undefined);
			assert.strictEqual(resolveScenario('auth/some-future-scenario')?.name, 'auth/*');
			assert.strictEqual(resolveScenario('tools_call')?.name, 'tools_call');
		});
	});

	suite('drivers', () => {
		test('tools_call prefers test-tool and derives the arguments from the schema', async () => {
			const { client, calls } = fakeClient({ tools: [tool('add_numbers', { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] })] });
			await resolveScenario('tools_call')!.run(client);
			assert.deepStrictEqual(calls, [{ method: 'tools/list' }, { method: 'tools/call', name: 'add_numbers', args: { a: 1, b: 1 } }]);

			const preferred = fakeClient({ tools: [tool('other'), tool('test-tool', { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] })] });
			await resolveScenario('auth/metadata-default')!.run(preferred.client);
			assert.deepStrictEqual(preferred.calls[1], { method: 'tools/call', name: 'test-tool', args: { q: 'us-west1' } });
		});

		test('tools_call fails when the server lists no tools', async () => {
			const { client } = fakeClient();
			await assert.rejects(() => resolveScenario('tools_call')!.run(client), /lists no tools/);
		});

		test('sep-2322-client-request-state calls the four MRTR tools in order', async () => {
			const { client, calls } = fakeClient({ tools: [tool('test_mrtr_echo_state')] });
			await resolveScenario('sep-2322-client-request-state')!.run(client);
			assert.deepStrictEqual(calls.map(c => c.name ?? c.method), ['tools/list', 'test_mrtr_echo_state', 'test_mrtr_no_state', 'test_mrtr_unrelated', 'test_mrtr_no_result_type']);
		});

		test('http-standard-headers exercises every tool, resource and prompt', async () => {
			const { client, calls } = fakeClient({
				tools: [tool('test_headers'), tool('my-hyphenated-tool')],
				resources: [{ uri: 'file:///path/to/file%20name.txt', name: 'f' }, { uri: 'https://example.com/resource?id=123', name: 'r' }],
				prompts: [{ name: 'test_prompt' }],
			});
			await resolveScenario('http-standard-headers')!.run(client);
			assert.deepStrictEqual(calls.map(c => `${c.method} ${c.name ?? ''}`.trim()), [
				'tools/list', 'tools/call test_headers', 'tools/call my-hyphenated-tool',
				'resources/list', 'resources/read file:///path/to/file%20name.txt', 'resources/read https://example.com/resource?id=123',
				'prompts/list', 'prompts/get test_prompt',
			]);
		});

		test('http-custom-headers replays the context tool calls verbatim', async () => {
			const toolCalls = [
				{ name: 'test_custom_headers', arguments: { region: 'us-west1', priority: 42, verbose: false, non_ascii_val: 'Hello, 世界' } },
				{ name: 'test_custom_headers_null', arguments: { region: 'us-east1', priority: 1, verbose: null, query: 'SELECT 1' } },
			];
			const { client, calls } = fakeClient({ tools: [tool('test_custom_headers')], context: { toolCalls } });
			await resolveScenario('http-custom-headers')!.run(client);
			assert.deepStrictEqual(calls, [
				{ method: 'tools/list' },
				{ method: 'tools/call', name: 'test_custom_headers', args: toolCalls[0].arguments },
				{ method: 'tools/call', name: 'test_custom_headers_null', args: toolCalls[1].arguments },
			]);
		});

		test('http-custom-headers fails without a context', async () => {
			const { client } = fakeClient({ tools: [tool('test_custom_headers')] });
			await assert.rejects(() => resolveScenario('http-custom-headers')!.run(client), /toolCalls/);
		});

		test('http-invalid-tool-headers calls every tool the engine kept', async () => {
			const { client, calls } = fakeClient({ tools: [tool('valid_tool', { type: 'object', properties: { region: { type: 'string' } }, required: ['region'] })] });
			await resolveScenario('http-invalid-tool-headers')!.run(client);
			assert.deepStrictEqual(calls, [{ method: 'tools/list' }, { method: 'tools/call', name: 'valid_tool', args: { region: 'us-west1' } }]);
			await assert.rejects(() => resolveScenario('http-invalid-tool-headers')!.run(fakeClient().client), /dropped every tool/);
		});

		test('json-schema-2020-12-preservation echoes the focal input schema object as received', async () => {
			const inputSchema: MCPLegacy.Tool['inputSchema'] = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { name: { type: 'string' } }, required: [] };
			const { client, calls } = fakeClient({ tools: [tool('json_schema_echo'), tool('json_schema_2020_12_tool', inputSchema)] });
			await resolveScenario('json-schema-2020-12-preservation')!.run(client);
			assert.strictEqual(calls[1].name, 'json_schema_echo');
			assert.strictEqual((calls[1].args as { schema: unknown }).schema, inputSchema, 'the very object the server sent');
			await assert.rejects(() => resolveScenario('json-schema-2020-12-preservation')!.run(fakeClient({ tools: [tool('json_schema_echo')] }).client), /does not list/);
		});

		test('the listing-only scenarios list the tools and nothing else', async () => {
			for (const name of ['initialize', 'request-metadata', 'json-schema-ref-no-deref']) {
				const { client, calls } = fakeClient();
				await resolveScenario(name)!.run(client);
				assert.deepStrictEqual(calls, [{ method: 'tools/list' }], name);
			}
		});

		test('the elicitation and reconnection scenarios call their tool', async () => {
			const elicitation = fakeClient({ tools: [tool('test_client_elicitation_defaults')] });
			await resolveScenario('elicitation-sep1034-client-defaults')!.run(elicitation.client);
			assert.deepStrictEqual(elicitation.calls[1], { method: 'tools/call', name: 'test_client_elicitation_defaults', args: {} });
			const retry = fakeClient({ tools: [tool('test_reconnection')] });
			await resolveScenario('sse-retry')!.run(retry.client);
			assert.deepStrictEqual(retry.calls[1], { method: 'tools/call', name: 'test_reconnection', args: {} });
		});

		suite('Skills extension (SEP-2640)', () => {
			const SKILL_URI = 'skill://pdf-processing/SKILL.md';
			const FORMS_URI = 'skill://pdf-processing/references/FORMS.md';
			const SKILL_MD = ['---', 'name: pdf-processing', 'description: PDFs', '---', 'Body', ''].join('\n');
			const FORMS = 'Forms\n';

			async function entry(): Promise<McpSkills.Skill> {
				const file = async (uri: string, text: string) => ({ uri, digest: await McpSkills.digest(VSBuffer.fromString(text).buffer), size: VSBuffer.fromString(text).byteLength });
				return { uri: SKILL_URI, frontmatter: { name: 'pdf-processing', description: 'PDFs' }, resources: [await file(SKILL_URI, SKILL_MD), await file(FORMS_URI, FORMS)] };
			}

			test('no-prefetch lists the skills and reads no file', async () => {
				const { client, calls } = fakeClient({ skills: [await entry()], files: { [SKILL_URI]: SKILL_MD, [FORMS_URI]: FORMS } });
				await resolveScenario('sep-2640-client-no-prefetch')!.run(client);
				assert.deepStrictEqual(calls, [{ method: 'skills/list' }]);
				await assert.rejects(resolveScenario('sep-2640-client-no-prefetch')!.run(fakeClient().client), /no valid skill/);
			});

			test('the verify scenarios load the skill and read its supporting files when everything verifies', async () => {
				const { client, calls } = fakeClient({ skills: [await entry()], files: { [SKILL_URI]: SKILL_MD, [FORMS_URI]: FORMS } });
				await resolveScenario('sep-2640-client-verify-digest')!.run(client);
				assert.deepStrictEqual(calls.map(call => call.name ?? call.method), ['skills/list', SKILL_URI, FORMS_URI]);
			});

			test('a SKILL.md that fails verification ends the scenario before any supporting file is read', async () => {
				for (const [name, served] of [['digest', SKILL_MD.replace('Body', 'Evil')], ['size', SKILL_MD + 'more'], ['frontmatter', SKILL_MD.replace('PDFs', 'Evil')]]) {
					const { client, calls } = fakeClient({ skills: [await entry()], files: { [SKILL_URI]: served, [FORMS_URI]: FORMS } });
					await assert.rejects(resolveScenario(`sep-2640-client-verify-${name}`)!.run(client), McpSkillVerificationError);
					assert.deepStrictEqual(calls.map(call => call.name ?? call.method), ['skills/list', SKILL_URI], name);
				}
			});
		});
	});
});
