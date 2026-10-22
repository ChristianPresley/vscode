/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService, NullLoggerService } from '../../../log/common/log.js';
import { IMcpGatewaySingleServerInvoker, IMcpGatewayToolInvoker } from '../../common/mcpGateway.js';
import { McpGatewayRpcError } from '../../common/mcpGatewayProtocol.js';
import { LATEST_MCP_PROTOCOL_VERSION, META_SERVER_INFO } from '../../common/mcpProtocolVersions.js';
import { MCP } from '../../common/modelContextProtocol.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';
import { McpSkills } from '../../common/modelContextProtocolSkills.js';
import { CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../node/mcpGatewayConformanceInvoker.js';
import { IMcpGatewayDispatchContext, McpGatewayDispatcher, McpGatewayResourceNotFoundError } from '../../node/mcpGatewayDispatcher.js';
import { McpGatewaySealedState } from '../../node/mcpGatewaySealedState.js';
import { McpGatewayService } from '../../node/mcpGatewayService.js';
import { httpRequest, jsonOf, LEGACY_HEADERS, modernRequest } from './mcpGatewayTestUtils.js';

const SKILL: McpSkills.Skill = {
	uri: 'skill://git-workflow/SKILL.md',
	frontmatter: { name: 'git-workflow', description: 'Follow the team\'s Git conventions' },
	resources: [{ uri: 'skill://git-workflow/SKILL.md', digest: `sha256:${'a'.repeat(64)}`, size: 10 }],
};

const CHILDREN: MCPLegacy.Resource[] = [{ uri: 'skill://git-workflow/SKILL.md', name: 'git-workflow', mimeType: 'text/markdown' }];

function skillsInvoker(overrides: Partial<IMcpGatewaySingleServerInvoker> = {}): IMcpGatewaySingleServerInvoker {
	return {
		onDidChangeTools: Event.None,
		onDidChangeResources: Event.None,
		listTools: async () => [],
		callTool: async () => ({ content: [] }),
		listResources: async () => [],
		readResource: async uri => { throw new McpGatewayResourceNotFoundError(uri); },
		listResourceTemplates: async () => [],
		listSkills: async () => [SKILL],
		getSkill: async uri => uri === SKILL.uri ? SKILL : undefined,
		readDirectory: async uri => uri === 'skill://git-workflow' ? CHILDREN : undefined,
		...overrides,
	};
}

function context(era: 'modern' | 'legacy'): IMcpGatewayDispatchContext {
	return {
		era,
		protocolVersion: era === 'modern' ? LATEST_MCP_PROTOCOL_VERSION : '2025-11-25',
		requestId: 1,
		clientCapabilities: {},
		headers: {},
		token: CancellationToken.None,
		notify: () => { },
	};
}

async function assertRpcError(promise: Promise<unknown>, code: number): Promise<void> {
	await assert.rejects(promise, (error: unknown) => error instanceof McpGatewayRpcError && error.code === code);
}

suite('MCP - Gateway Skills extension (SEP-2640)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createDispatcher(invoker: IMcpGatewaySingleServerInvoker): McpGatewayDispatcher {
		return store.add(new McpGatewayDispatcher('route-1', new NullLogService(), invoker, new McpGatewaySealedState(), { serverInfo: CONFORMANCE_SERVER_INFO }));
	}

	test('an invoker that lists and gets skills makes the route declare the extension in both eras, inline and with resources', () => {
		const dispatcher = createDispatcher(skillsInvoker());
		const capabilities = dispatcher.serverCapabilities();
		assert.deepStrictEqual(capabilities.extensions, { [McpSkills.EXTENSION_ID]: { directoryRead: true } });
		assert.ok(capabilities.resources, 'a server declaring the extension declares resources');
		assert.deepStrictEqual(dispatcher.legacyInitializeCapabilities().extensions, { [McpSkills.EXTENSION_ID]: { directoryRead: true } });
		for (const era of ['modern', 'legacy'] as const) {
			for (const method of [McpSkills.METHOD_LIST, McpSkills.METHOD_GET, McpSkills.METHOD_DIRECTORY_READ]) {
				assert.strictEqual(dispatcher.supportsMethod(method, era), true, `${method} ${era}`);
			}
		}
	});

	test('without readDirectory the extension is an empty object and resources/directory/read is unknown', async () => {
		const dispatcher = createDispatcher(skillsInvoker({ readDirectory: undefined }));
		assert.deepStrictEqual(dispatcher.serverCapabilities().extensions, { [McpSkills.EXTENSION_ID]: {} });
		assert.strictEqual(dispatcher.supportsMethod(McpSkills.METHOD_DIRECTORY_READ, 'modern'), false);
		await assertRpcError(dispatcher.dispatch(context('modern'), McpSkills.METHOD_DIRECTORY_READ, { uri: 'skill://git-workflow' }), MCP.METHOD_NOT_FOUND);
	});

	test('the extension is not declared without both methods, or when the declared capabilities leave it out', async () => {
		for (const invoker of [skillsInvoker({ getSkill: undefined }), skillsInvoker({ listSkills: undefined }), skillsInvoker({ capabilities: { tools: {} } })]) {
			const dispatcher = createDispatcher(invoker);
			assert.strictEqual(dispatcher.serverCapabilities().extensions, undefined);
			await assertRpcError(dispatcher.dispatch(context('modern'), McpSkills.METHOD_LIST, {}), MCP.METHOD_NOT_FOUND);
		}
		const withoutDirectoryRead = createDispatcher(skillsInvoker({ capabilities: { skills: {} } }));
		assert.deepStrictEqual(withoutDirectoryRead.serverCapabilities().extensions, { [McpSkills.EXTENSION_ID]: {} });
	});

	test('skills/list: the entries, with the envelope and cache hints on the 2026-07-28 wire; a cursor is unknown', async () => {
		const dispatcher = createDispatcher(skillsInvoker());
		const modern = await dispatcher.dispatch(context('modern'), McpSkills.METHOD_LIST, {}) as McpSkills.ListSkillsResult;
		assert.deepStrictEqual(modern.skills, [SKILL]);
		assert.strictEqual(modern.resultType, 'complete');
		assert.strictEqual(typeof modern.ttlMs, 'number');
		assert.strictEqual(modern.cacheScope, 'private');
		assert.deepStrictEqual(modern._meta?.[META_SERVER_INFO], CONFORMANCE_SERVER_INFO);
		assert.deepStrictEqual(await dispatcher.dispatch(context('legacy'), McpSkills.METHOD_LIST, {}), { skills: [SKILL] });
		await assertRpcError(dispatcher.dispatch(context('modern'), McpSkills.METHOD_LIST, { cursor: 'x' }), MCP.INVALID_PARAMS);
	});

	test('skills/get: one entry without a cursor; an unknown or missing URI is -32602 in both eras', async () => {
		const dispatcher = createDispatcher(skillsInvoker());
		const result = await dispatcher.dispatch(context('modern'), McpSkills.METHOD_GET, { uri: SKILL.uri }) as McpSkills.GetSkillResult & { nextCursor?: unknown };
		assert.deepStrictEqual(result.skill, SKILL);
		assert.strictEqual(result.nextCursor, undefined);
		assert.strictEqual(typeof result.ttlMs, 'number');
		assert.strictEqual(result.cacheScope, 'private');
		for (const era of ['modern', 'legacy'] as const) {
			await assertRpcError(dispatcher.dispatch(context(era), McpSkills.METHOD_GET, { uri: 'skill://nope/SKILL.md' }), MCP.INVALID_PARAMS);
			await assertRpcError(dispatcher.dispatch(context(era), McpSkills.METHOD_GET, {}), MCP.INVALID_PARAMS);
		}
	});

	test('resources/directory/read: the children of a directory; anything else is -32602', async () => {
		const dispatcher = createDispatcher(skillsInvoker());
		const result = await dispatcher.dispatch(context('modern'), McpSkills.METHOD_DIRECTORY_READ, { uri: 'skill://git-workflow' }) as McpSkills.ReadDirectoryResult;
		assert.deepStrictEqual(result.resources, CHILDREN);
		assert.strictEqual(result.resultType, 'complete');
		await assertRpcError(dispatcher.dispatch(context('modern'), McpSkills.METHOD_DIRECTORY_READ, { uri: SKILL.uri }), MCP.INVALID_PARAMS);
		await assertRpcError(dispatcher.dispatch(context('legacy'), McpSkills.METHOD_DIRECTORY_READ, {}), MCP.INVALID_PARAMS);
		await assertRpcError(dispatcher.dispatch(context('modern'), McpSkills.METHOD_DIRECTORY_READ, { uri: 'skill://git-workflow', cursor: 'c' }), MCP.INVALID_PARAMS);
	});

	test('the conformance fixture serves skills whose files verify against their entries, and lists each SKILL.md as a resource', async () => {
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const dispatcher = createDispatcher(invoker);
		assert.deepStrictEqual(dispatcher.serverCapabilities().extensions?.[McpSkills.EXTENSION_ID], { directoryRead: true });
		const { skills } = await dispatcher.dispatch(context('modern'), McpSkills.METHOD_LIST, {}) as McpSkills.ListSkillsResult;
		assert.deepStrictEqual(skills.map(skill => skill.uri), ['skill://pdf-processing/SKILL.md', 'skill://acme/billing/refunds/SKILL.md']);
		const resources = await invoker.listResources();
		for (const skill of skills) {
			assert.strictEqual(McpSkills.validateEntry(skill).ok, true, skill.uri);
			const listed = resources.find(resource => resource.uri === skill.uri);
			assert.deepStrictEqual([listed?.name, listed?.description, listed?.mimeType], [skill.frontmatter.name, skill.frontmatter.description, 'text/markdown']);
			for (const file of skill.resources === McpSkills.DYNAMIC ? [] : skill.resources) {
				const read = await dispatcher.dispatch(context('modern'), 'resources/read', { uri: file.uri }) as MCPLegacy.ReadResourceResult;
				assert.strictEqual(await McpSkills.verifyFile(skill, file.uri, McpSkills.contentBytes(read.contents[0])!), undefined, file.uri);
			}
		}
		const root = await dispatcher.dispatch(context('modern'), McpSkills.METHOD_DIRECTORY_READ, { uri: 'skill://pdf-processing' }) as McpSkills.ReadDirectoryResult;
		assert.ok(root.resources.some(resource => resource.mimeType === McpSkills.DIRECTORY_MIME_TYPE), 'a subdirectory to descend into');
	});
});

suite('MCP - Gateway Skills extension over HTTP (SEP-2640)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a route passes the skills of its server through, and declares the extension only for a server that does', async () => {
		const capabilitiesRead = new DeferredPromise<void>();
		let capabilityCalls = 0;
		const invoker: IMcpGatewayToolInvoker = {
			onDidChangeServers: Event.None,
			onDidChangeTools: Event.None,
			onDidChangeResources: Event.None,
			listServers: () => [{ id: 'skilled', label: 'Skilled' }, { id: 'plain', label: 'Plain' }],
			getServerCapabilities: async serverId => {
				if (++capabilityCalls === 2) {
					capabilitiesRead.complete();
				}
				return serverId === 'skilled' ? { tools: {}, resources: {}, skills: { directoryRead: false } } : { tools: {}, resources: {} };
			},
			listToolsForServer: async () => [],
			callToolForServer: async () => ({ content: [] }),
			listResourcesForServer: async () => [],
			readResourceForServer: async (_serverId, uri) => ({ contents: [{ uri, text: '' }] }),
			listResourceTemplatesForServer: async () => [],
			listSkillsForServer: async serverId => serverId === 'skilled' ? [SKILL] : [],
			getSkillForServer: async (_serverId, uri) => uri === SKILL.uri ? SKILL : undefined,
			readDirectoryForServer: async () => CHILDREN,
		};
		const service = store.add(new McpGatewayService(store.add(new NullLoggerService())));
		const info = await service.createGateway('client-1', invoker);
		const [skilled, plain] = info.servers.map(server => server.address.toString(true));
		await capabilitiesRead.p;
		await timeout(0);

		const post = async (url: string, method: string, params: Record<string, unknown> = {}) => {
			const request = modernRequest(method, params);
			return jsonOf(await httpRequest(url, { method: 'POST', headers: request.headers, body: request.body })) as { result?: Record<string, unknown>; error?: { code: number } };
		};
		const discover = await post(skilled, 'server/discover');
		assert.deepStrictEqual((discover.result?.capabilities as MCP.ServerCapabilities).extensions, { [McpSkills.EXTENSION_ID]: {} });
		assert.deepStrictEqual((await post(skilled, McpSkills.METHOD_LIST)).result?.skills, [SKILL]);
		assert.deepStrictEqual((await post(skilled, McpSkills.METHOD_GET, { uri: SKILL.uri })).result?.skill, SKILL);
		assert.strictEqual((await post(skilled, McpSkills.METHOD_GET, { uri: 'skill://nope/SKILL.md' })).error?.code, MCP.INVALID_PARAMS);
		assert.strictEqual((await post(skilled, McpSkills.METHOD_DIRECTORY_READ, { uri: 'skill://git-workflow' })).error?.code, MCP.METHOD_NOT_FOUND, 'the server did not declare directoryRead');

		const init = jsonOf(await httpRequest(skilled, { headers: LEGACY_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })) as { result?: { capabilities?: MCPLegacy.ServerCapabilities } };
		assert.deepStrictEqual(init.result?.capabilities?.extensions, { [McpSkills.EXTENSION_ID]: {} });

		assert.strictEqual(((await post(plain, 'server/discover')).result?.capabilities as MCP.ServerCapabilities).extensions, undefined);
		assert.strictEqual((await post(plain, McpSkills.METHOD_LIST)).error?.code, MCP.METHOD_NOT_FOUND);
	});
});
