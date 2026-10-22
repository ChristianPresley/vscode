/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readdirSync, readFileSync } from 'fs';
import { compileJsonSchema, ICompiledJsonSchema, isCompiledJsonSchema } from '../../../../base/common/jsonSchemaValidator/index.js';
import { FileAccess } from '../../../../base/common/network.js';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

/**
 * Every golden example shipped with the 2026-07-28 schema validates against
 * its `$defs` entry. This pins the vendored schema, the generated namespace
 * and the JSON Schema validator to each other: a validator regression or a
 * stale fixture shows up here.
 */
suite('MCP - 2026-07-28 golden examples', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const fixtureRoot = FileAccess.asFileUri('vs/platform/mcp/test/node/fixtures/mcp-schema-2026-07-28').fsPath;
	const schema = JSON.parse(readFileSync(join(fixtureRoot, 'schema.json'), 'utf8')) as { $schema: string; $defs: Record<string, unknown> };
	const compiled = new Map<string, ICompiledJsonSchema>();

	function schemaFor(typeName: string): ICompiledJsonSchema {
		let result = compiled.get(typeName);
		if (!result) {
			const document = { $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${typeName}` };
			const compiledOrErrors = compileJsonSchema(document);
			assert.ok(isCompiledJsonSchema(compiledOrErrors), `schema for ${typeName} compiles: ${JSON.stringify(compiledOrErrors)}`);
			result = compiledOrErrors;
			compiled.set(typeName, result);
		}
		return result;
	}

	const typeDirs = readdirSync(join(fixtureRoot, 'examples'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

	test('the fixture tree is populated', () => {
		assert.ok(typeDirs.length > 50, `found ${typeDirs.length} example types`);
		for (const typeName of typeDirs) {
			assert.ok(schema.$defs[typeName] !== undefined, `examples/${typeName} has a $defs entry`);
		}
	});

	for (const typeName of typeDirs) {
		const files = readdirSync(join(fixtureRoot, 'examples', typeName)).filter(f => f.endsWith('.json')).sort();
		for (const file of files) {
			test(`${typeName}/${file} validates`, () => {
				const example = JSON.parse(readFileSync(join(fixtureRoot, 'examples', typeName, file), 'utf8'));
				const result = schemaFor(typeName).validate(example);
				assert.ok(result.valid, `${typeName}/${file}: ${result.errors.map(e => `${e.instancePath} ${e.keyword}: ${e.message}`).join('; ')}`);
			});
		}
	}

	test('a broken example is rejected (negative control)', () => {
		assert.strictEqual(schemaFor('CallToolResult').validate({ content: 'not an array', resultType: 42 }).valid, false);
		assert.strictEqual(schemaFor('ClientCapabilities').validate({ roots: 'yes' }).valid, false);
		assert.strictEqual(schemaFor('DiscoverResult').validate({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: {} }).valid, false, 'ttlMs and cacheScope are required');
	});
});
