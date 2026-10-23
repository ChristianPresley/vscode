/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { NullLogger } from '../../../../platform/log/common/log.js';
import { CONFORMANCE_SERVER_INFO, McpGatewayConformanceInvoker } from '../../../../platform/mcp/node/mcpGatewayConformanceInvoker.js';
import { McpGatewayGrpcListener } from '../../../../platform/mcp/node/mcpGatewayGrpc.js';
import { McpGatewayRoute } from '../../../../platform/mcp/node/mcpGatewayRoute.js';
import { McpGatewaySealedState } from '../../../../platform/mcp/node/mcpGatewaySealedState.js';
import { McpSkills } from '../../../../platform/mcp/common/modelContextProtocolSkills.js';
import product from '../../../../platform/product/common/product.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { McpServerRequestHandler } from '../../../contrib/mcp/common/mcpServerRequestHandler.js';
import { McpLoadedSkill } from '../../../contrib/mcp/common/mcpSkills.js';
import { McpTaskManager } from '../../../contrib/mcp/common/mcpTaskManager.js';
import { McpServerTransportGrpc, McpServerTransportType } from '../../../contrib/mcp/common/mcpTypes.js';
import { GrpcTestTransport } from './extHostMcpGrpcTestUtils.js';

/**
 * The Skills extension (SEP-2640) over gRPC, between the real client engine
 * and the real gateway listener, which serves both bindings on one port. The
 * typed service has no RPC for `skills/list`, `skills/get` or
 * `resources/directory/read`: `binding: 'typed-with-tunnel'` sends them on
 * the tunnel and keeps `resources/read` and `tools/call` typed.
 */
suite('MCP skills over gRPC (gateway listener)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const sealedState = new McpGatewaySealedState();
	let listener: McpGatewayGrpcListener;
	let port: number;

	setup(async () => {
		const logger = new NullLogger();
		const invoker = store.add(new McpGatewayConformanceInvoker());
		const route = store.add(new McpGatewayRoute('route-skills', logger, invoker, sealedState, 'skills', { serverInfo: CONFORMANCE_SERVER_INFO }));
		listener = store.add(new McpGatewayGrpcListener(logger, { allowDefaultRoute: true, server: { shutdownGraceMs: 100 } }));
		listener.registerTunnelService();
		listener.registerTypedService();
		store.add(listener.addRoute(route.routeId, route.dispatcher, invoker));
		port = await listener.listen();
	});

	teardown(async () => {
		await listener.close();
	});

	async function connect(binding: McpServerTransportGrpc['binding']): Promise<{ transport: GrpcTestTransport; handler: McpServerRequestHandler }> {
		const transport = store.add(new GrpcTestTransport({ type: McpServerTransportType.Grpc, uri: URI.parse(`grpc://127.0.0.1:${port}`), headers: [], binding }));
		const productService: IProductService = { _serviceBrand: undefined, ...product };
		const instantiationService = store.add(new InstantiationService(new ServiceCollection([IProductService, productService]), true));
		const handler = store.add(await McpServerRequestHandler.create(instantiationService, {
			launch: transport,
			logger: new NullLogger(),
			taskManager: store.add(new McpTaskManager()),
			transportType: McpServerTransportType.Grpc,
		}));
		return { transport, handler };
	}

	test('typed-with-tunnel: the extension is declared; skills are listed, fetched and their directories read on the tunnel, a skill loads and verifies through typed ReadResource', async () => {
		const { transport, handler } = await connect('typed-with-tunnel');
		assert.deepStrictEqual(handler.skillsSettings, { directoryRead: true });

		const entries = await handler.listSkills() as McpSkills.Skill[];
		const uris = entries.map(e => e.uri).sort();
		assert.deepStrictEqual(uris, ['skill://acme/billing/refunds/SKILL.md', 'skill://pdf-processing/SKILL.md']);
		const entry = await handler.getSkill({ uri: 'skill://pdf-processing/SKILL.md' }) as McpSkills.Skill;
		assert.strictEqual(entry.frontmatter.name, 'pdf-processing');
		const children = await handler.readDirectory({ uri: 'skill://pdf-processing/templates' });
		assert.deepStrictEqual(children.map(c => [c.uri, c.mimeType]).sort(), [
			['skill://pdf-processing/templates/invoice.md', 'text/markdown'],
			['skill://pdf-processing/templates/regional', McpSkills.DIRECTORY_MIME_TYPE],
		]);

		const skill = await McpLoadedSkill.load(handler, entry);
		assert.ok(skill.instructions.includes('# PDF processing'));
		assert.strictEqual(VSBuffer.wrap(await skill.readFile('references/FORMS.md')).toString(), '# Forms\n\nHow to fill PDF forms.\n');

		const tool = await handler.callTool({ name: 'test_simple_text', arguments: {} });
		assert.strictEqual(tool.isError ?? false, false);

		const methods = transport.envelopes.map(e => e.method);
		assert.ok(methods.includes('skills/list') && methods.includes('resources/directory/read'), `methods: ${methods.join(', ')}`);
		assert.deepStrictEqual(transport.aborts, []);
	});

	test('typed: a typed-only connection cannot see the extension (the synthesized discover declares none) and refuses skills/list locally', async () => {
		const { transport, handler } = await connect('typed');
		assert.strictEqual(handler.skillsSettings, undefined);
		await assert.rejects(handler.listSkills(), /does not declare the Skills extension/);
		assert.deepStrictEqual(transport.aborts, []);
	});
});
