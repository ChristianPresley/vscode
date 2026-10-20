/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import assert from 'assert';
import { compileJsonSchema, isCompiledJsonSchema, JsonSchemaDialect } from '../../../common/jsonSchemaValidator/index.js';
import { FileAccess } from '../../../common/network.js';
import * as path from '../../../common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../common/utils.js';

interface ISuiteTest {
	readonly description: string;
	readonly data: unknown;
	readonly valid: boolean;
}

interface ISuiteGroup {
	readonly description: string;
	readonly schema: unknown;
	readonly tests: readonly ISuiteTest[];
}

interface ISkippedGroup {
	/** Test file, relative to the `tests` folder of the suite. */
	readonly file: string;
	/** Description of the test group that is skipped. */
	readonly description: string;
	readonly reason: string;
}

/**
 * Test groups of the official suite that are deliberately not supported.
 * Every entry must match exactly one group; the count is asserted below.
 */
const SKIPPED: readonly ISkippedGroup[] = [
	{ file: 'draft2020-12/vocabulary.json', description: 'schema that uses custom metaschema with with no validation vocabulary', reason: 'custom metaschemas with $vocabulary are not supported' },
	{ file: 'draft2020-12/vocabulary.json', description: 'ignore unrecognized optional vocabulary', reason: 'custom metaschemas with $vocabulary are not supported' },
];

/** The suite references its remote documents under this origin. */
const REMOTES_ORIGIN = 'http://localhost:1234/';

interface ISuiteRun {
	readonly passed: number;
	readonly skipped: number;
	readonly failures: readonly string[];
}

suite('JSON Schema Validator - official test suite', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const fixtures = FileAccess.asFileUri('vs/base/test/node/jsonSchemaValidator/fixtures/json-schema-test-suite').fsPath;
	const usedSkips = new Set<ISkippedGroup>();

	async function listFiles(directory: string): Promise<string[]> {
		const result: string[] = [];
		for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				result.push(...await listFiles(entryPath));
			} else if (entry.name.endsWith('.json')) {
				result.push(entryPath);
			}
		}
		return result.sort();
	}

	async function loadRemotes(): Promise<Map<string, unknown>> {
		const remotesDir = path.join(fixtures, 'remotes');
		const remotes = new Map<string, unknown>();
		const fallbacks = new Map<string, unknown>();
		for (const file of await listFiles(remotesDir)) {
			const relativePath = path.relative(remotesDir, file).replace(/\\/g, '/');
			const document = JSON.parse(await fs.promises.readFile(file, 'utf8'));
			remotes.set(REMOTES_ORIGIN + relativePath, document);
			if (relativePath.startsWith('draft2020-12/')) {
				fallbacks.set(REMOTES_ORIGIN + relativePath.substring('draft2020-12/'.length), document);
			}
		}
		for (const [uri, document] of fallbacks) {
			if (!remotes.has(uri)) {
				remotes.set(uri, document);
			}
		}
		return remotes;
	}

	async function runSuite(directory: string, dialect: JsonSchemaDialect, remotes: Map<string, unknown>): Promise<ISuiteRun> {
		const testsDir = path.join(fixtures, 'tests');
		const files = (await fs.promises.readdir(path.join(testsDir, directory)))
			.filter(name => name.endsWith('.json'))
			.sort()
			.map(name => path.join(testsDir, directory, name));
		const failures: string[] = [];
		let passed = 0;
		let skipped = 0;
		for (const file of files) {
			const relativeFile = path.relative(testsDir, file).replace(/\\/g, '/');
			const groups: ISuiteGroup[] = JSON.parse(await fs.promises.readFile(file, 'utf8'));
			for (const group of groups) {
				const skip = SKIPPED.find(entry => entry.file === relativeFile && entry.description === group.description);
				if (skip) {
					usedSkips.add(skip);
					skipped++;
					continue;
				}
				const compiled = compileJsonSchema(group.schema, { dialect, remoteDocuments: remotes });
				if (!isCompiledJsonSchema(compiled)) {
					failures.push(`${relativeFile} > ${group.description}: schema does not compile: ${compiled.map(error => `${error.code} at '${error.path}': ${error.message}`).join('; ')}`);
					continue;
				}
				for (const test of group.tests) {
					let valid: boolean;
					try {
						valid = compiled.validate(test.data).valid;
					} catch (error) {
						failures.push(`${relativeFile} > ${group.description} > ${test.description}: threw ${error}`);
						continue;
					}
					if (valid === test.valid) {
						passed++;
					} else {
						failures.push(`${relativeFile} > ${group.description} > ${test.description}: expected ${test.valid ? 'valid' : 'invalid'}`);
					}
				}
			}
		}
		return { passed, skipped, failures };
	}

	test('draft 2020-12 required tests', async () => {
		const run = await runSuite('draft2020-12', '2020-12', await loadRemotes());
		assert.deepStrictEqual(run.failures, []);
		assert.ok(run.passed > 1000, `expected the required suite to contain more than 1000 tests, ran ${run.passed}`);
	});

	test('draft 2020-12 optional tests', async () => {
		const run = await runSuite('draft2020-12/optional', '2020-12', await loadRemotes());
		assert.deepStrictEqual(run.failures, []);
		assert.ok(run.passed > 50, `expected the optional suite to contain more than 50 tests, ran ${run.passed}`);
	});

	test('draft-07 required tests', async () => {
		const run = await runSuite('draft7', 'draft-07', await loadRemotes());
		assert.deepStrictEqual(run.failures, []);
		assert.ok(run.passed > 900, `expected the required suite to contain more than 900 tests, ran ${run.passed}`);
	});

	test('every skipped entry matches exactly one test group', () => {
		assert.strictEqual(usedSkips.size, SKIPPED.length, `unused skip entries: ${SKIPPED.filter(entry => !usedSkips.has(entry)).map(entry => `${entry.file} > ${entry.description}`).join('; ')}`);
	});
});
