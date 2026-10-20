/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseConformanceMainArgs } from '../../node/mcpGatewayConformanceArgs.js';

suite('MCP - GatewayConformanceMain arguments', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('defaults', () => {
		assert.deepStrictEqual(parseConformanceMainArgs([]), { ok: true, options: { urlFile: undefined, logFile: undefined, quiet: false, help: false } });
	});

	test('every flag, in both spellings', () => {
		assert.deepStrictEqual(parseConformanceMainArgs(['--url-file', 'u.txt', '--log', 'g.log', '--quiet']), { ok: true, options: { urlFile: 'u.txt', logFile: 'g.log', quiet: true, help: false } });
		assert.deepStrictEqual(parseConformanceMainArgs(['--url-file=C:\\tmp\\u=1.txt', '--log=/tmp/g.log']), { ok: true, options: { urlFile: 'C:\\tmp\\u=1.txt', logFile: '/tmp/g.log', quiet: false, help: false } });
		assert.deepStrictEqual(parseConformanceMainArgs(['-h']), { ok: true, options: { urlFile: undefined, logFile: undefined, quiet: false, help: true } });
	});

	test('missing values and unknown arguments are errors', () => {
		for (const argv of [['--url-file'], ['--log', '--quiet'], ['--url-file='], ['--quiet=yes'], ['--port', '3000'], ['extra']]) {
			const parsed = parseConformanceMainArgs(argv);
			assert.strictEqual(parsed.ok, false, argv.join(' '));
		}
	});
});
