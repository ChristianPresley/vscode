/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LogLevel } from '../../../../../platform/log/common/log.js';
import { McpHeaderAnnotation } from '../../../../../platform/mcp/common/mcpHttpHeaders.js';
import { META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_LOG_LEVEL, META_PROTOCOL_VERSION } from '../../../../../platform/mcp/common/mcpProtocolVersions.js';
import { MCP } from '../../../../../platform/mcp/common/modelContextProtocol.js';
import { McpTasks } from '../../../../../platform/mcp/common/modelContextProtocolTasks.js';
import { buildClientCapabilities, buildEnvelope, buildRequestMeta, getResultType, IMcpRequestMetaBase, isAcceptableElicitationUrl, LISTEN_ACK_TIMEOUT_MS, LISTEN_BACKOFF_MS, LISTEN_MAX_BACKOFF_MS, LISTEN_STABLE_MS, mapLogLevelToMcp, MAX_MRTR_ROUNDS, MCP_UI_EXTENSION_ID, parseInputRequiredResult, PROBE_TIMEOUT_MS, validateElicitFormContent } from '../../common/mcpProtocolMeta.js';
import { McpClientError } from '../../common/mcpTypes.js';

suite('Workbench - MCP - Protocol Meta', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const uiExtension = { [MCP_UI_EXTENSION_ID]: { mimeTypes: ['text/html;profile=mcp-app'] } };

	suite('buildClientCapabilities', () => {
		test('modern declares roots, form and url elicitation, sampling with tools and the ui extension', () => {
			const capabilities = buildClientCapabilities('modern', { sampling: true, samplingTools: true, elicitation: true });
			assert.deepStrictEqual(capabilities, {
				roots: {},
				extensions: uiExtension,
				sampling: { tools: {} },
				elicitation: { form: {}, url: {} },
			});
		});

		test('modern omits sampling and elicitation when the client does not handle them', () => {
			const capabilities = buildClientCapabilities('modern', { sampling: false, elicitation: false });
			assert.deepStrictEqual(capabilities, { roots: {}, extensions: uiExtension });
		});

		test('modern declares sampling without tools when tool use is not offered', () => {
			const capabilities = buildClientCapabilities('modern', { sampling: true, samplingTools: false, elicitation: false });
			assert.deepStrictEqual(capabilities.sampling, {});
		});

		test('modern declares the tasks extension only when asked', () => {
			const without = buildClientCapabilities('modern', { sampling: false, elicitation: false });
			assert.deepStrictEqual(Object.keys(without.extensions ?? {}), [MCP_UI_EXTENSION_ID]);

			const withTasks = buildClientCapabilities('modern', { sampling: false, elicitation: false, tasks: true });
			assert.deepStrictEqual(withTasks.extensions, { ...uiExtension, [McpTasks.EXTENSION_ID]: {} });
		});

		test('legacy matches the initialize capabilities exactly with sampling and elicitation', () => {
			const capabilities = buildClientCapabilities('legacy', { sampling: true, samplingTools: true, elicitation: true });
			assert.deepStrictEqual(capabilities, {
				roots: { listChanged: true },
				sampling: { tools: {} },
				elicitation: { form: {}, url: {} },
				tasks: {
					list: {},
					cancel: {},
					requests: {
						sampling: { createMessage: {} },
						elicitation: { create: {} },
					},
				},
				extensions: uiExtension,
			});
		});

		test('legacy matches the initialize capabilities exactly without sampling and elicitation', () => {
			const capabilities = buildClientCapabilities('legacy', { sampling: false, elicitation: false });
			assert.deepStrictEqual(capabilities, {
				roots: { listChanged: true },
				sampling: undefined,
				elicitation: undefined,
				tasks: {
					list: {},
					cancel: {},
					requests: {
						sampling: undefined,
						elicitation: undefined,
					},
				},
				extensions: uiExtension,
			});
		});

		test('legacy declares sampling without tools when tool use is not offered and ignores the tasks option', () => {
			const capabilities = buildClientCapabilities('legacy', { sampling: true, samplingTools: false, elicitation: false, tasks: true });
			assert.deepStrictEqual(capabilities.sampling, {});
			assert.deepStrictEqual(capabilities.extensions, uiExtension);
		});
	});

	suite('buildRequestMeta', () => {
		const base: IMcpRequestMetaBase = {
			protocolVersion: '2026-07-28',
			clientInfo: { name: 'Client', version: '1.2.3' },
			clientCapabilities: { roots: {} },
			logLevel: 'info',
		};

		test('stamps the reserved keys', () => {
			assert.deepStrictEqual(buildRequestMeta(base), {
				[META_PROTOCOL_VERSION]: '2026-07-28',
				[META_CLIENT_CAPABILITIES]: { roots: {} },
				[META_CLIENT_INFO]: { name: 'Client', version: '1.2.3' },
				[META_LOG_LEVEL]: 'info',
			});
		});

		test('keeps the caller keys but the reserved keys win', () => {
			const callerMeta = {
				progressToken: 'tok-1',
				[META_PROTOCOL_VERSION]: '1999-01-01',
				[META_CLIENT_INFO]: { name: 'Spoofed', version: '0' },
				[META_CLIENT_CAPABILITIES]: { sampling: {} },
				[META_LOG_LEVEL]: 'emergency',
			};
			const meta = buildRequestMeta(base, callerMeta);
			assert.strictEqual(meta.progressToken, 'tok-1');
			assert.strictEqual(meta[META_PROTOCOL_VERSION], '2026-07-28');
			assert.deepStrictEqual(meta[META_CLIENT_INFO], { name: 'Client', version: '1.2.3' });
			assert.deepStrictEqual(meta[META_CLIENT_CAPABILITIES], { roots: {} });
			assert.strictEqual(meta[META_LOG_LEVEL], 'info');
			// the caller's object is left alone
			assert.strictEqual(callerMeta[META_PROTOCOL_VERSION], '1999-01-01');
		});

		test('omits the log level when the base has none, even if the caller set one', () => {
			const meta = buildRequestMeta({ ...base, logLevel: undefined }, { [META_LOG_LEVEL]: 'debug', traceparent: 'tp' });
			assert.strictEqual(Object.prototype.hasOwnProperty.call(meta, META_LOG_LEVEL), false);
			assert.strictEqual(meta.traceparent, 'tp');
		});
	});

	suite('getResultType', () => {
		test('reads the resultType of a modern result', () => {
			assert.strictEqual(getResultType({ resultType: 'input_required' }), 'input_required');
			assert.strictEqual(getResultType({ resultType: 'complete', tools: [] }), 'complete');
			assert.strictEqual(getResultType({ resultType: 'something-new' }), 'something-new');
		});

		test('an absent or malformed resultType means complete', () => {
			assert.strictEqual(getResultType({}), 'complete');
			assert.strictEqual(getResultType({ tools: [] }), 'complete');
			assert.strictEqual(getResultType({ resultType: 42 }), 'complete');
			assert.strictEqual(getResultType(null), 'complete');
			assert.strictEqual(getResultType(undefined), 'complete');
			assert.strictEqual(getResultType('complete'), 'complete');
		});
	});

	suite('parseInputRequiredResult', () => {
		const elicit: MCP.InputRequest = { method: 'elicitation/create', params: { mode: 'form', message: 'm', requestedSchema: { type: 'object', properties: {} } } };

		const expectInvalid = (result: unknown, reason: 'invalid-result-type' | 'invalid-input-request', messagePart: string) => {
			const parsed = parseInputRequiredResult(result);
			assert.ok(parsed instanceof McpClientError, `expected an error for ${JSON.stringify(result)}`);
			assert.strictEqual(parsed.reason, reason);
			assert.ok(parsed.message.includes(messagePart), `"${parsed.message}" should mention "${messagePart}"`);
		};

		test('accepts a result with input requests and request state', () => {
			const parsed = parseInputRequiredResult({ resultType: 'input_required', inputRequests: { e1: elicit, r1: { method: 'roots/list' } }, requestState: 'state-1' });
			assert.ok(!(parsed instanceof McpClientError));
			assert.deepStrictEqual(Object.keys(parsed.inputRequests), ['e1', 'r1']);
			assert.strictEqual(parsed.inputRequests.e1.method, 'elicitation/create');
			assert.strictEqual(parsed.requestState, 'state-1');
		});

		test('accepts request state alone (load shedding) and input requests alone', () => {
			const stateOnly = parseInputRequiredResult({ resultType: 'input_required', requestState: 'opaque' });
			assert.ok(!(stateOnly instanceof McpClientError));
			assert.deepStrictEqual(stateOnly.inputRequests, {});
			assert.strictEqual(stateOnly.requestState, 'opaque');

			const requestsOnly = parseInputRequiredResult({ resultType: 'input_required', inputRequests: { s: { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } } } });
			assert.ok(!(requestsOnly instanceof McpClientError));
			assert.strictEqual(requestsOnly.requestState, undefined);
			assert.strictEqual(requestsOnly.inputRequests.s.method, 'sampling/createMessage');
		});

		test('rejects a result that is not input_required', () => {
			expectInvalid({ resultType: 'complete' }, 'invalid-result-type', 'input_required');
			expectInvalid({}, 'invalid-result-type', 'input_required');
			expectInvalid(null, 'invalid-result-type', 'input_required');
		});

		test('rejects a result missing both inputRequests and requestState', () => {
			expectInvalid({ resultType: 'input_required' }, 'invalid-input-request', 'inputRequests or requestState');
			expectInvalid({ resultType: 'input_required', inputRequests: {} }, 'invalid-input-request', 'inputRequests or requestState');
		});

		test('rejects an unsupported input method', () => {
			expectInvalid({ resultType: 'input_required', inputRequests: { t: { method: 'tools/call', params: {} } } }, 'invalid-input-request', 'tools/call');
		});

		test('rejects a non-string requestState', () => {
			expectInvalid({ resultType: 'input_required', requestState: 42 }, 'invalid-input-request', 'requestState');
			expectInvalid({ resultType: 'input_required', requestState: { nested: true }, inputRequests: { e1: elicit } }, 'invalid-input-request', 'requestState');
		});

		test('rejects non-object inputRequests', () => {
			expectInvalid({ resultType: 'input_required', inputRequests: 'nope' }, 'invalid-input-request', 'inputRequests must be an object');
			expectInvalid({ resultType: 'input_required', inputRequests: [elicit] }, 'invalid-input-request', 'inputRequests must be an object');
			expectInvalid({ resultType: 'input_required', inputRequests: null, requestState: 's' }, 'invalid-input-request', 'inputRequests must be an object');
		});

		test('rejects malformed individual requests', () => {
			expectInvalid({ resultType: 'input_required', inputRequests: { e1: 'elicitation/create' } }, 'invalid-input-request', 'e1');
			expectInvalid({ resultType: 'input_required', inputRequests: { e1: { params: {} } } }, 'invalid-input-request', 'e1');
			expectInvalid({ resultType: 'input_required', inputRequests: { e1: { method: 'elicitation/create', params: 'form' } } }, 'invalid-input-request', 'invalid params');
		});
	});

	suite('mapLogLevelToMcp', () => {
		test('maps every VS Code level', () => {
			assert.strictEqual(mapLogLevelToMcp(LogLevel.Trace), 'debug');
			assert.strictEqual(mapLogLevelToMcp(LogLevel.Debug), 'debug');
			assert.strictEqual(mapLogLevelToMcp(LogLevel.Info), 'info');
			assert.strictEqual(mapLogLevelToMcp(LogLevel.Warning), 'warning');
			assert.strictEqual(mapLogLevelToMcp(LogLevel.Error), 'error');
			assert.strictEqual(mapLogLevelToMcp(LogLevel.Off), 'emergency');
		});
	});

	suite('validateElicitFormContent', () => {
		const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name'] };

		test('accepts content matching the requested schema', () => {
			const validation = validateElicitFormContent({ name: 'Ada', age: 36 }, schema);
			assert.deepStrictEqual(validation, { ok: true, content: { name: 'Ada', age: 36 } });
		});

		test('rejects content that does not match the schema', () => {
			const wrongType = validateElicitFormContent({ name: 42 }, schema);
			assert.strictEqual(wrongType.ok, false);
			assert.ok(!wrongType.ok && wrongType.message.includes('/name'), 'the message names the failing property');

			const missing = validateElicitFormContent({ age: 1 }, schema);
			assert.strictEqual(missing.ok, false);
		});

		test('accepts anything when the schema does not compile', () => {
			const validation = validateElicitFormContent({ whatever: ['x'] }, { type: 5 });
			assert.deepStrictEqual(validation, { ok: true, content: { whatever: ['x'] } });
		});

		test('treats missing content as an empty object', () => {
			const optional = validateElicitFormContent(undefined, { type: 'object', properties: { note: { type: 'string' } } });
			assert.deepStrictEqual(optional, { ok: true, content: {} });

			const required = validateElicitFormContent(undefined, schema);
			assert.strictEqual(required.ok, false);
		});

		test('rejects content that is not an object', () => {
			for (const content of ['text', 42, null, ['a'], true]) {
				const validation = validateElicitFormContent(content, schema);
				assert.strictEqual(validation.ok, false, `content ${JSON.stringify(content)}`);
				assert.ok(!validation.ok && validation.message.includes('must be an object'));
			}
		});
	});

	suite('isAcceptableElicitationUrl', () => {
		test('accepts https', () => {
			const check = isAcceptableElicitationUrl('https://Example.COM/auth?x=1');
			assert.deepStrictEqual(check, { ok: true, isIdn: false, hostname: 'example.com' });
		});

		test('accepts http to loopback hosts only', () => {
			for (const url of ['http://localhost:3000/cb', 'http://127.0.0.1/cb', 'http://127.42.0.7:8080/', 'http://[::1]:3000/cb']) {
				assert.strictEqual(isAcceptableElicitationUrl(url).ok, true, url);
			}
			const remote = isAcceptableElicitationUrl('http://example.com/cb');
			assert.strictEqual(remote.ok, false);
			assert.strictEqual(remote.hostname, 'example.com');
			assert.ok(remote.reason?.includes('http'), remote.reason);
		});

		test('rejects URLs carrying credentials', () => {
			for (const url of ['https://user:secret@example.com/', 'https://user@example.com/', 'http://user:pw@localhost/']) {
				const check = isAcceptableElicitationUrl(url);
				assert.strictEqual(check.ok, false, url);
				assert.ok(check.reason?.includes('credentials'), check.reason);
			}
		});

		test('rejects other schemes', () => {
			const check = isAcceptableElicitationUrl('ftp://example.com/file');
			assert.strictEqual(check.ok, false);
			assert.ok(check.reason?.includes('ftp'), check.reason);
			assert.strictEqual(isAcceptableElicitationUrl('javascript:alert(1)').ok, false);
		});

		test('detects internationalized domain names', () => {
			const punycode = isAcceptableElicitationUrl('https://xn--bcher-kva.example/');
			assert.strictEqual(punycode.ok, true);
			assert.strictEqual(punycode.isIdn, true);
			assert.strictEqual(punycode.hostname, 'xn--bcher-kva.example');

			const unicode = isAcceptableElicitationUrl('https://bücher.example/');
			assert.strictEqual(unicode.ok, true);
			assert.strictEqual(unicode.isIdn, true);

			assert.strictEqual(isAcceptableElicitationUrl('https://plain.example/').isIdn, false);
		});

		test('rejects invalid URLs', () => {
			assert.deepStrictEqual(isAcceptableElicitationUrl('not a url'), { ok: false, isIdn: false, hostname: '', reason: 'not a valid URL' });
			assert.strictEqual(isAcceptableElicitationUrl('').ok, false);
		});
	});

	suite('buildEnvelope', () => {
		const annotations = new Map<string, readonly McpHeaderAnnotation[]>([
			['geo', [
				{ header: 'Region', path: ['region'], type: 'string' },
				{ header: 'Retries', path: ['opts', 'retries'], type: 'integer' },
				{ header: 'Dry-Run', path: ['dryRun'], type: 'boolean' },
			]],
		]);

		test('modern tools/call carries Mcp-Method, Mcp-Name and the annotated parameters', () => {
			const envelope = buildEnvelope('request', 7, '2026-07-28', 'tools/call', { name: 'geo', arguments: { region: 'eu-west', opts: { retries: 3 }, dryRun: false, other: 'ignored' } }, annotations, 5000);
			assert.deepStrictEqual(envelope, {
				kind: 'request',
				requestId: 7,
				protocolVersion: '2026-07-28',
				method: 'tools/call',
				headers: {
					'Mcp-Method': 'tools/call',
					'Mcp-Name': 'geo',
					'Mcp-Param-Region': 'eu-west',
					'Mcp-Param-Retries': '3',
					'Mcp-Param-Dry-Run': 'false',
				},
				deadlineMs: 5000,
			});
		});

		test('annotated parameters absent from the arguments produce no header', () => {
			const envelope = buildEnvelope('request', 1, '2026-07-28', 'tools/call', { name: 'geo', arguments: { region: 'us' } }, annotations);
			assert.deepStrictEqual(envelope.headers, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'geo', 'Mcp-Param-Region': 'us' });
		});

		test('a tool without annotations carries only the standard headers', () => {
			const envelope = buildEnvelope('request', 2, '2026-07-28', 'tools/call', { name: 'echo', arguments: { region: 'eu' } }, annotations);
			assert.deepStrictEqual(envelope.headers, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' });
			assert.strictEqual(envelope.deadlineMs, undefined);
		});

		test('non-ASCII names are sentinel-encoded', () => {
			const envelope = buildEnvelope('request', 3, '2026-07-28', 'tools/call', { name: 'héllo', arguments: {} });
			const name = envelope.headers?.['Mcp-Name'];
			assert.ok(name?.startsWith('=?base64?') && name.endsWith('?='), name);
		});

		test('prompts/get and resources/read mirror their name and uri', () => {
			assert.deepStrictEqual(buildEnvelope('request', 4, '2026-07-28', 'prompts/get', { name: 'summarize' }).headers, { 'Mcp-Method': 'prompts/get', 'Mcp-Name': 'summarize' });
			assert.deepStrictEqual(buildEnvelope('request', 5, '2026-07-28', 'resources/read', { uri: 'file:///a.txt' }).headers, { 'Mcp-Method': 'resources/read', 'Mcp-Name': 'file:///a.txt' });
			assert.deepStrictEqual(buildEnvelope('request', 6, '2026-07-28', 'tools/list', {}).headers, { 'Mcp-Method': 'tools/list' });
		});

		test('notifications carry no headers', () => {
			const cancelled = buildEnvelope('notification', undefined, '2026-07-28', 'notifications/cancelled', { requestId: 1 });
			assert.deepStrictEqual(cancelled, { kind: 'notification', requestId: undefined, protocolVersion: '2026-07-28', method: 'notifications/cancelled', headers: undefined, deadlineMs: undefined });
			assert.strictEqual(buildEnvelope('notification', undefined, '2026-07-28', 'notifications/roots/list_changed', undefined).headers, undefined);
		});

		test('legacy traffic carries no headers', () => {
			const envelope = buildEnvelope('request', 8, '2025-11-25', 'tools/call', { name: 'geo', arguments: { region: 'eu' } }, annotations);
			assert.deepStrictEqual(envelope, { kind: 'request', requestId: 8, protocolVersion: '2025-11-25', method: 'tools/call', headers: undefined, deadlineMs: undefined });
		});

		test('listen streams keep their kind and id', () => {
			const envelope = buildEnvelope('listen', 9, '2026-07-28', 'subscriptions/listen', { notifications: { toolsListChanged: true } });
			assert.strictEqual(envelope.kind, 'listen');
			assert.strictEqual(envelope.requestId, 9);
			assert.deepStrictEqual(envelope.headers, { 'Mcp-Method': 'subscriptions/listen' });
		});
	});

	test('constants match the protocol engine contract', () => {
		assert.strictEqual(MAX_MRTR_ROUNDS, 10);
		assert.strictEqual(PROBE_TIMEOUT_MS, 10_000);
		assert.strictEqual(LISTEN_ACK_TIMEOUT_MS, 10_000);
		assert.strictEqual(LISTEN_BACKOFF_MS, 500);
		assert.strictEqual(LISTEN_MAX_BACKOFF_MS, 30_000);
		assert.strictEqual(LISTEN_STABLE_MS, 10_000);
	});
});
