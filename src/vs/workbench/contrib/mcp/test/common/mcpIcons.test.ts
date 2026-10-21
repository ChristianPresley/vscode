/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogger } from '../../../../../platform/log/common/log.js';
import { McpIcons, parseAndValidateMcpIcon } from '../../common/mcpIcons.js';
import { McpServerTransportGrpc, McpServerTransportHTTP, McpServerTransportStdio, McpServerTransportType } from '../../common/mcpTypes.js';

const createHttpLaunch = (url: string): McpServerTransportHTTP => ({
	type: McpServerTransportType.HTTP,
	uri: URI.parse(url),
	headers: []
});

const createStdioLaunch = (): McpServerTransportStdio => ({
	type: McpServerTransportType.Stdio,
	cwd: undefined,
	command: 'cmd',
	args: [],
	env: {},
	envFile: undefined,
	sandbox: undefined
});

suite('MCP Icons', () => {
	suite('parseAndValidateMcpIcon', () => {
		ensureNoDisposablesAreLeakedInTestSuite();

		test('includes supported icons and sorts sizes ascending', () => {
			const logger = new NullLogger();
			const launch = createHttpLaunch('https://example.com');

			const result = parseAndValidateMcpIcon({
				icons: [
					{ src: 'ftp://example.com/ignored.png', mimeType: 'image/png' },
					{ src: 'data:image/png;base64,AAA', mimeType: 'image/png', sizes: ['64x64', '16x16'] },
					{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['128x128'] }
				]
			}, launch, logger);

			assert.strictEqual(result.length, 2);
			assert.strictEqual((result[0].src as URI).toString(true), 'data:image/png;base64,AAA');
			assert.deepStrictEqual(result[0].sizes.map(s => s.width), [16, 64]);
			assert.strictEqual(result[1].src.toString(), 'https://example.com/icon.png');
			assert.deepStrictEqual(result[1].sizes, [{ width: 128, height: 128 }]);
		});

		test('drops icons whose MIME type is not on the allow list, declared or derived from the file name, SVG among them', () => {
			const launch = createHttpLaunch('https://example.com');
			const result = parseAndValidateMcpIcon({
				icons: [
					{ src: 'https://example.com/script.svg', mimeType: 'image/svg+xml', sizes: ['16x16'] },
					{ src: 'https://example.com/undeclared.svg', sizes: ['16x16'] },
					{ src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', mimeType: 'image/svg+xml', sizes: ['16x16'] },
					{ src: 'https://example.com/looks-like.png', mimeType: 'text/html', sizes: ['16x16'] },
					{ src: 'https://example.com/icon.bmp', mimeType: 'image/bmp', sizes: ['16x16'] },
					{ src: 'https://example.com/no-extension', sizes: ['16x16'] },
					{ src: 'https://example.com/derived.webp', sizes: ['24x24'] },
					{ src: 'https://example.com/declared.png', mimeType: 'IMAGE/PNG', sizes: ['32x32'] },
				]
			}, launch, new NullLogger());

			assert.deepStrictEqual(result.map(icon => icon.src.toString(true)), ['https://example.com/derived.webp', 'https://example.com/declared.png']);
		});

		test('drops an icon when any type it states is off the allow list: a declared type does not hide the media type of a data: URI or the type of its file name', () => {
			const launch = createHttpLaunch('https://example.com');
			const result = parseAndValidateMcpIcon({
				icons: [
					{ src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', mimeType: 'image/png', sizes: ['16x16'] },
					{ src: 'https://example.com/evil.svg', mimeType: 'image/png', sizes: ['16x16'] },
					{ src: 'https://example.com/evil.svg?v=1', mimeType: 'image/png', sizes: ['16x16'] },
					{ src: 'data:text/html;base64,PGI+PC9iPg==', mimeType: 'image/gif', sizes: ['16x16'] },
					{ src: 'data:;base64,AAA', mimeType: 'image/png', sizes: ['16x16'] },
					{ src: 'data:image/png;base64,AAA', sizes: ['20x20'] },
					{ src: 'data:IMAGE/PNG;base64,AAA', mimeType: 'image/png', sizes: ['24x24'] },
					{ src: 'https://example.com/photo.jpg', mimeType: 'image/jpeg', sizes: ['28x28'] },
					{ src: 'https://example.com/icon.png?v=2', sizes: ['32x32'] },
				]
			}, launch, new NullLogger());

			assert.deepStrictEqual(result.map(icon => icon.src.toString(true)), [
				'data:image/png;base64,AAA',
				'data:IMAGE/PNG;base64,AAA',
				'https://example.com/photo.jpg',
				'https://example.com/icon.png?v=2',
			]);
		});

		test('requires http transport with matching authority for remote icons', () => {
			const logger = new NullLogger();
			const httpLaunch = createHttpLaunch('https://example.com');
			const stdioLaunch = createStdioLaunch();

			const icons = {
				icons: [
					{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['64x64'] },
					{ src: 'https://other.com/icon.png', mimeType: 'image/png', sizes: ['64x64'] }
				]
			};

			const httpResult = parseAndValidateMcpIcon(icons, httpLaunch, logger);
			assert.deepStrictEqual(httpResult.map(icon => icon.src.toString()), ['https://example.com/icon.png']);

			const stdioResult = parseAndValidateMcpIcon(icons, stdioLaunch, logger);
			assert.strictEqual(stdioResult.length, 0);
		});

		test('accepts remote icons from the host name of a grpc server', () => {
			const grpcLaunch: McpServerTransportGrpc = { type: McpServerTransportType.Grpc, uri: URI.parse('grpcs://example.com:50051'), headers: [] };
			const result = parseAndValidateMcpIcon({
				icons: [
					{ src: 'https://example.com/icon.png', mimeType: 'image/png', sizes: ['64x64'] },
					{ src: 'http://example.com:8080/icon.png', mimeType: 'image/png', sizes: ['64x64'] },
					{ src: 'https://other.com/icon.png', mimeType: 'image/png', sizes: ['64x64'] },
					{ src: 'file:///tmp/icon.png', mimeType: 'image/png', sizes: ['32x32'] },
				]
			}, grpcLaunch, new NullLogger());

			assert.deepStrictEqual(result.map(icon => icon.src.toString(true)), ['https://example.com/icon.png', 'http://example.com:8080/icon.png']);
		});

		test('accepts file icons only for stdio transport', () => {
			const logger = new NullLogger();
			const stdioLaunch = createStdioLaunch();
			const httpLaunch = createHttpLaunch('https://example.com');

			const icons = {
				icons: [
					{ src: 'file:///tmp/icon.png', mimeType: 'image/png', sizes: ['32x32'] }
				]
			};

			const stdioResult = parseAndValidateMcpIcon(icons, stdioLaunch, logger);
			assert.strictEqual(stdioResult.length, 1);
			assert.strictEqual(stdioResult[0].src.scheme, 'file');

			const httpResult = parseAndValidateMcpIcon(icons, httpLaunch, logger);
			assert.strictEqual(httpResult.length, 0);
		});
	});

	suite('McpIcons', () => {
		ensureNoDisposablesAreLeakedInTestSuite();

		test('getUrl returns undefined when no icons are available', () => {
			const icons = McpIcons.fromParsed(undefined);
			assert.strictEqual(icons.getUrl(16), undefined);
		});

		test('getUrl prefers theme-specific icons and keeps light fallback', () => {
			const logger = new NullLogger();
			const launch = createHttpLaunch('https://example.com');
			const parsed = parseAndValidateMcpIcon({
				icons: [
					{ src: 'https://example.com/dark.png', mimeType: 'image/png', sizes: ['16x16', '48x48'], theme: 'dark' },
					{ src: 'https://example.com/any.png', mimeType: 'image/png', sizes: ['24x24'] },
					{ src: 'https://example.com/light.png', mimeType: 'image/png', sizes: ['64x64'], theme: 'light' }
				]
			}, launch, logger);
			const icons = McpIcons.fromParsed(parsed);
			const result = icons.getUrl(32);

			assert.ok(result);
			assert.strictEqual(result!.dark.toString(), 'https://example.com/dark.png');
			assert.strictEqual(result!.light?.toString(), 'https://example.com/light.png');
		});

		test('getUrl falls back to any-theme icons when no exact size exists', () => {
			const logger = new NullLogger();
			const launch = createHttpLaunch('https://example.com');
			const parsed = parseAndValidateMcpIcon({
				icons: [
					{ src: 'https://example.com/dark.png', mimeType: 'image/png', sizes: ['16x16'], theme: 'dark' },
					{ src: 'https://example.com/any.png', mimeType: 'image/png', sizes: ['64x64'] }
				]
			}, launch, logger);
			const icons = McpIcons.fromParsed(parsed);
			const result = icons.getUrl(60);

			assert.ok(result);
			assert.strictEqual(result!.dark.toString(), 'https://example.com/any.png');
			assert.strictEqual(result!.light, undefined);
		});

		test('getUrl reuses light icons when dark theme assets are missing', () => {
			const logger = new NullLogger();
			const launch = createHttpLaunch('https://example.com');
			const parsed = parseAndValidateMcpIcon({
				icons: [
					{ src: 'https://example.com/light.png', mimeType: 'image/png', sizes: ['32x32'], theme: 'light' }
				]
			}, launch, logger);
			const icons = McpIcons.fromParsed(parsed);
			const result = icons.getUrl(16);

			assert.ok(result);
			assert.strictEqual(result!.dark.toString(), 'https://example.com/light.png');
			assert.strictEqual(result!.light?.toString(), 'https://example.com/light.png');
		});
	});
});
