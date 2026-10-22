/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { suite, test } from 'node:test';
import {
	DEFAULT_PROPOSALS_REGION,
	DEFAULT_SOURCE,
	DEST,
	GENERATOR_INPUTS,
	UPSTREAM_COMMIT,
	UPSTREAM_REVISION,
	convertIndentation,
	fetchRefspecFor,
	filterGeneratorInputs,
	generateMcpNamespace,
	isDroppedEslintDirective,
	parseArgs,
	readProposalsRegion,
} from '../sync-mcp-schema.ts';

const HEADER_FIRST_LINE = '/*---------------------------------------------------------------------------------------------';
const PRAGMA = '/* eslint-disable local/code-no-unexternalized-strings */';

suite('mcp schema generator', () => {
	test('convertIndentation turns 2-space indentation into tabs and keeps an odd space', () => {
		assert.strictEqual(convertIndentation('export const A = 1;'), 'export const A = 1;');
		assert.strictEqual(convertIndentation('  foo: string;'), '\tfoo: string;');
		assert.strictEqual(convertIndentation('    bar: number;'), '\t\tbar: number;');
		assert.strictEqual(convertIndentation(' * JSDoc continuation'), ' * JSDoc continuation');
		assert.strictEqual(convertIndentation('   * nested JSDoc'), '\t * nested JSDoc');
	});

	test('generateMcpNamespace wraps the upstream body and keeps header, pragma and proposals', () => {
		const upstream = [
			'/* JSON types */',
			'',
			'/**',
			' * @category Common Types',
			' */',
			'export type JSONValue =',
			'  string | number;',
			'',
			'/** @internal */',
			`export const LATEST_PROTOCOL_VERSION = "${UPSTREAM_REVISION}";`,
			'',
			'// eslint-disable-next-line @typescript-eslint/no-empty-object-type',
			'export interface Empty {}',
			'',
			'// eslint-disable-next-line @typescript-eslint/no-explicit-any',
			'export type Anything = any;',
			'',
			'export interface Foo {',
			'  /**',
			'   * doc',
			'   */',
			'  bar?: string;',
			'}',
			'',
		].join('\n');

		const out = generateMcpNamespace(upstream, DEFAULT_PROPOSALS_REGION);
		const lines = out.split('\n');

		assert.strictEqual(lines[0], HEADER_FIRST_LINE);
		assert.ok(out.includes(`\n${PRAGMA}\n`), 'pragma kept');
		assert.ok(out.includes(DEFAULT_PROPOSALS_REGION), 'proposals region kept verbatim');
		assert.ok(out.includes(`/${UPSTREAM_COMMIT}/`), 'banner cites the upstream commit');
		assert.ok(out.includes('\nexport namespace MCP {\n'), 'namespace wrapper');
		assert.ok(out.includes(`\n\texport const LATEST_PROTOCOL_VERSION = "${UPSTREAM_REVISION}";\n`), 'body nested one tab');
		assert.ok(out.includes('\n\texport interface Foo {\n\t\t/**\n\t\t * doc\n\t\t */\n\t\tbar?: string;\n\t}\n'), 'inner indentation converted');
		assert.ok(out.endsWith('\n}\n'), 'closing brace and trailing newline');
		assert.ok(!out.includes('no-empty-object-type'), 'directive for a rule VS Code does not enable is dropped');
		assert.ok(out.includes('\t// eslint-disable-next-line @typescript-eslint/no-explicit-any\n\texport type Anything = any;'), 'directive for an enabled rule is kept');
		assert.ok(!out.includes('\r'), 'LF only');
		assert.ok(!lines.some(line => line.startsWith('  ')), 'no 2-space indentation left');
	});

	test('readProposalsRegion extracts the region or falls back to the default', () => {
		const existing = `${HEADER_FIRST_LINE}\n\n${PRAGMA}\n\n//#region proposals\nexport namespace MCP {\n\texport const X = 1;\n}\n//#endregion\n\nexport namespace MCP {}\n`;
		assert.strictEqual(readProposalsRegion(existing), '//#region proposals\nexport namespace MCP {\n\texport const X = 1;\n}\n//#endregion');
		assert.strictEqual(readProposalsRegion(existing.replace(/\n/g, '\r\n')), '//#region proposals\nexport namespace MCP {\n\texport const X = 1;\n}\n//#endregion');
		assert.strictEqual(readProposalsRegion(undefined), DEFAULT_PROPOSALS_REGION);
		assert.strictEqual(readProposalsRegion('export namespace MCP {}'), DEFAULT_PROPOSALS_REGION);
		assert.throws(() => readProposalsRegion('//#region proposals\nexport namespace MCP {}\n'), /Unbalanced/);
	});

	test('isDroppedEslintDirective keeps only directives for enabled rules', () => {
		assert.strictEqual(isDroppedEslintDirective('// eslint-disable-next-line @typescript-eslint/no-explicit-any'), false);
		assert.strictEqual(isDroppedEslintDirective('  // eslint-disable-next-line @typescript-eslint/no-empty-object-type'), true);
		assert.strictEqual(isDroppedEslintDirective('// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type'), true);
		assert.strictEqual(isDroppedEslintDirective('export const x = 1; // eslint-disable-next-line foo'), false);
	});

	test('fetchRefspecFor maps remote-tracking bases to fetchable refspecs', () => {
		assert.strictEqual(fetchRefspecFor('origin/main'), '+refs/heads/main:refs/remotes/origin/main');
		assert.strictEqual(fetchRefspecFor('origin/release/1.0'), '+refs/heads/release/1.0:refs/remotes/origin/release/1.0');
		assert.strictEqual(fetchRefspecFor('696749ba603'), '696749ba603');
		assert.strictEqual(fetchRefspecFor('main'), 'main');
	});

	test('parseArgs understands every flag', () => {
		const defaults = parseArgs([]);
		assert.strictEqual(defaults.source, DEFAULT_SOURCE);
		assert.deepStrictEqual([defaults.check, defaults.ifChanged, defaults.help], [false, false, false]);
		assert.strictEqual(defaults.base, 'origin/main');

		const all = parseArgs(['--check', '--if-changed', '--base', 'main', '--source', 'schema.ts']);
		assert.deepStrictEqual([all.check, all.ifChanged, all.base], [true, true, 'main']);
		assert.ok(all.source.endsWith('schema.ts'));
		assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
		assert.throws(() => parseArgs(['--source']), /Missing value for --source/);
		assert.throws(() => parseArgs(['--base', '--check']), /Missing value for --base/);
	});

	test('filterGeneratorInputs keeps only the generator inputs', () => {
		assert.deepStrictEqual(filterGeneratorInputs([
			'src/vs/platform/mcp/common/modelContextProtocol.ts',
			'src/vs/platform/mcp/common/modelContextProtocolLegacy.ts',
			'build/mcp/mcp-schema-2026-07-28.ts',
			'build/mcp/sync-mcp-schema.ts',
			'tsfmt.json',
			'README.md',
		]), [
			'src/vs/platform/mcp/common/modelContextProtocol.ts',
			'build/mcp/mcp-schema-2026-07-28.ts',
			'build/mcp/sync-mcp-schema.ts',
			'tsfmt.json',
		]);
		assert.deepStrictEqual([...GENERATOR_INPUTS].sort(), [
			'build/lib/formatter.ts',
			'build/mcp/mcp-schema-2026-07-28.ts',
			'build/mcp/sync-mcp-schema.ts',
			'src/vs/platform/mcp/common/modelContextProtocol.ts',
			'tsfmt.json',
		]);
	});

	test('the committed namespace file is what the generator produces from the vendored schema', () => {
		const upstream = fs.readFileSync(DEFAULT_SOURCE, 'utf8');
		const committed = fs.readFileSync(DEST, 'utf8').replace(/\r\n/g, '\n');
		const generated = generateMcpNamespace(upstream, readProposalsRegion(committed));
		assert.strictEqual(committed, generated, 'run `npm run mcp:sync-schema` and commit the result');
	});
});
