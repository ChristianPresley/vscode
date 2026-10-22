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
import { MCPLegacy } from '../../../../../platform/mcp/common/modelContextProtocolLegacy.js';
import { McpTasks } from '../../../../../platform/mcp/common/modelContextProtocolTasks.js';
import { isCompiledJsonSchema, PatternAnalysisBudget } from '../../../../../base/common/jsonSchemaValidator/index.js';
import { buildClientCapabilities, buildEnvelope, buildRequestMeta, checkElicitationSchema, checkServerSchemaDocument, checkServerToolSchemas, checkStructuredContent, compileServerSchema, getResultType, IMcpRequestMetaBase, isAcceptableElicitationUrl, LISTEN_ACK_TIMEOUT_MS, LISTEN_BACKOFF_MS, LISTEN_MAX_BACKOFF_MS, LISTEN_STABLE_MS, mapLogLevelToMcp, MAX_MRTR_ROUNDS, MCP_UI_EXTENSION_ID, parseInputRequiredResult, PROBE_TIMEOUT_MS, readsSchemasLeniently, validateElicitFormContent } from '../../common/mcpProtocolMeta.js';
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

		test('rejects any content when the schema does not compile', () => {
			for (const requestedSchema of [{ type: 5 }, { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }, { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } }]) {
				const validation = validateElicitFormContent({ whatever: ['x'] }, requestedSchema);
				assert.strictEqual(validation.ok, false, JSON.stringify(requestedSchema));
				assert.ok(!validation.ok && validation.message.startsWith('The requested schema does not compile: '), !validation.ok ? validation.message : '');
			}
		});

		test('accepts any content for a schema that does not compile from a server speaking 2025-11-25 or older, as before', () => {
			for (const protocolVersion of ['2025-11-25', '2025-06-18']) {
				const validation = validateElicitFormContent({ whatever: ['x'] }, { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } }, protocolVersion);
				assert.deepStrictEqual(validation, { ok: true, content: { whatever: ['x'] } }, protocolVersion);
			}
			assert.strictEqual(validateElicitFormContent({ whatever: ['x'] }, { type: 5 }, '2026-07-28').ok, false);
			// a schema that compiles is still enforced for every revision
			assert.strictEqual(validateElicitFormContent({ name: 42 }, schema, '2025-11-25').ok, false);
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

	suite('checkElicitationSchema', () => {
		test('names why a schema does not compile', () => {
			const dialect = checkElicitationSchema({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} });
			const remoteRef = checkElicitationSchema({ type: 'object', properties: { name: { $ref: 'https://example.com/name.json' } } });
			const invalid = checkElicitationSchema({ type: 'object', properties: { name: { type: 'text' } } });
			assert.ok(dialect?.includes('draft-04'), dialect);
			assert.ok(remoteRef?.includes('https://example.com/name.json'), remoteRef);
			assert.ok(invalid?.includes('/properties/name'), invalid);
		});

		test('accepts 2020-12 and draft-07 schemas, and no schema', () => {
			assert.deepStrictEqual([
				checkElicitationSchema({ type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] }),
				checkElicitationSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} }),
				checkElicitationSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { ok: { type: 'boolean' } } }),
				checkElicitationSchema({ type: 'object', properties: { color: { type: 'string', enum: ['r', 'g'], enumNames: ['Red', 'Green'] } } }),
				checkElicitationSchema(undefined),
			], [undefined, undefined, undefined, undefined, undefined]);
		});

		test('a 2026-07-28 server\'s form is declined; the same form from a 2025-11-25 or older server is shown with a warning', () => {
			const schemas = [
				{ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} },
				{ type: 'object', properties: { name: { $ref: 'https://example.com/name.json' } } },
			];
			for (const requestedSchema of schemas) {
				assert.ok(checkElicitationSchema(requestedSchema, '2026-07-28'), JSON.stringify(requestedSchema));
				for (const protocolVersion of ['2025-11-25', '2025-03-26']) {
					const warnings: string[] = [];
					assert.strictEqual(checkElicitationSchema(requestedSchema, protocolVersion, w => warnings.push(w)), undefined, `${protocolVersion} ${JSON.stringify(requestedSchema)}`);
					assert.strictEqual(warnings.length, 1, warnings.join('\n'));
				}
			}
		});

		test('a pattern that cannot be compiled is a warning, not a reason to decline', () => {
			for (const pattern of ['^([a-z0-9-]+\\.)+[a-z]{2,}$', '(']) {
				const warnings: string[] = [];
				const problem = checkElicitationSchema({ type: 'object', properties: { host: { type: 'string', pattern } } }, '2026-07-28', w => warnings.push(w));
				assert.strictEqual(problem, undefined, pattern);
				assert.strictEqual(warnings.length, 1, pattern);
				assert.ok(warnings[0].includes('/properties/host/pattern'), warnings[0]);
			}
			const identityEscapes: string[] = [];
			assert.strictEqual(checkElicitationSchema({ type: 'object', properties: { phone: { type: 'string', pattern: '^\\d{3}\\-\\d{4}$' } } }, '2026-07-28', w => identityEscapes.push(w)), undefined);
			assert.deepStrictEqual(identityEscapes, [], 'a pattern that only needs non-unicode mode compiles without a warning');
		});
	});

	suite('server schemas by revision', () => {
		const tuple = { type: 'array', items: [{ type: 'number' }], additionalItems: false };
		const anchored = { type: 'object', $defs: { n: { $anchor: 'num', type: 'number' } }, properties: { a: { $ref: '#num' } } };
		const remoteRef = { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } };
		const draft04 = { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: { a: { type: 'number' } } };

		test('only the initialize revisions read schemas leniently', () => {
			assert.deepStrictEqual(
				[undefined, '2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05', 'not-a-revision'].map(readsSchemasLeniently),
				[false, false, true, true, true, false],
			);
		});

		test('2026-07-28: 2020-12 by default; an unsupported dialect is an error', () => {
			const compiled = compileServerSchema(draft04, '2026-07-28');
			assert.ok(!isCompiledJsonSchema(compiled));
			assert.deepStrictEqual(compiled.map(e => e.code), ['unsupported-dialect']);
			assert.ok(checkServerSchemaDocument(tuple, '2026-07-28').errors.length > 0, 'draft-07 tuple items are not a 2020-12 schema');
			const defaulted = compileServerSchema({ type: 'object' }, '2026-07-28');
			assert.ok(isCompiledJsonSchema(defaulted) && defaulted.dialect === '2020-12');
		});

		test('2025-11-25 and older: an unsupported dialect is a warning and the schema is read in the default dialect', () => {
			for (const [protocolVersion, dialect] of [['2025-11-25', '2020-12'], ['2025-06-18', 'draft-07']] as const) {
				const compiled = compileServerSchema(draft04, protocolVersion);
				assert.ok(isCompiledJsonSchema(compiled), protocolVersion);
				assert.strictEqual(compiled.dialect, dialect);
				assert.deepStrictEqual(compiled.warnings.map(w => w.code), ['unsupported-dialect']);
				assert.strictEqual(compiled.validate({ a: 'x' }).valid, false);
				const check = checkServerSchemaDocument(draft04, protocolVersion);
				assert.deepStrictEqual(check.errors, []);
				assert.deepStrictEqual(check.warnings.map(w => w.code), ['unsupported-dialect']);
			}
		});

		test('2025-11-25 and older: a schema that does not compile in the default dialect is read in the other one', () => {
			for (const protocolVersion of ['2025-11-25', '2025-06-18']) {
				const compiledTuple = compileServerSchema(tuple, protocolVersion);
				assert.ok(isCompiledJsonSchema(compiledTuple), protocolVersion);
				assert.strictEqual(compiledTuple.dialect, 'draft-07');
				assert.strictEqual(compiledTuple.validate([1]).valid, true);
				assert.strictEqual(compiledTuple.validate(['x']).valid, false);
				assert.strictEqual(compiledTuple.validate([1, 2]).valid, false);
				assert.deepStrictEqual(checkServerSchemaDocument(tuple, protocolVersion).errors, [], protocolVersion);

				const compiledAnchor = compileServerSchema(anchored, protocolVersion);
				assert.ok(isCompiledJsonSchema(compiledAnchor), protocolVersion);
				assert.strictEqual(compiledAnchor.dialect, '2020-12');
				assert.strictEqual(compiledAnchor.validate({ a: 'x' }).valid, false);
				assert.deepStrictEqual(checkServerSchemaDocument(anchored, protocolVersion).errors, [], protocolVersion);
			}
			// a schema that names its dialect is read in it, and only in it
			const named = compileServerSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...tuple }, '2025-06-18');
			assert.ok(!isCompiledJsonSchema(named));
		});

		test('2025-11-25 and older: the reading in the other dialect analyzes patterns under the budget the schema shares', () => {
			// A pattern that only the reading in the other dialect reaches. The shared budget is spent (that of a long tool
			// list), so the pattern is not checked; a reading with a budget of its own would analyze it and check it.
			const pattern = '^[a-z]+-retried$';
			const cases = [
				['2025-11-25', { type: 'array', items: [{ type: 'string', pattern }], additionalItems: false }, ['NOT'], 'draft-07'],
				['2025-06-18', { type: 'object', $defs: { s: { $anchor: 'str', type: 'string', pattern } }, properties: { a: { $ref: '#str' } } }, { a: 'NOT' }, '2020-12'],
			] as const;
			for (const [protocolVersion, schema, instance, dialect] of cases) {
				const own = compileServerSchema(schema, protocolVersion);
				assert.ok(isCompiledJsonSchema(own) && own.dialect === dialect, protocolVersion);
				assert.strictEqual(own.validate(instance).valid, false, `${protocolVersion}: checked under a budget of its own`);

				const shared = compileServerSchema(schema, protocolVersion, new PatternAnalysisBudget(0));
				assert.ok(isCompiledJsonSchema(shared) && shared.dialect === dialect, protocolVersion);
				assert.strictEqual(shared.validate(instance).valid, true, `${protocolVersion}: not checked under the spent shared budget`);
				assert.ok(shared.warnings.some(w => w.message.includes('share a budget')), `${protocolVersion}: ${JSON.stringify(shared.warnings)}`);

				const check = checkServerSchemaDocument(schema, protocolVersion, new PatternAnalysisBudget(0));
				assert.deepStrictEqual(check.errors, [], protocolVersion);
				assert.ok(check.warnings.some(w => w.message.includes('share a budget')), `${protocolVersion}: ${JSON.stringify(check.warnings)}`);
			}
		});

		test('2025-11-25 and older: problems confined to a tool input schema are warnings, as before 2026-07-28 support', () => {
			const dialect2020 = 'https://json-schema.org/draft/2020-12/schema';
			const schemas = {
				// unresolved in either dialect
				localRef: { type: 'object', properties: { a: { $ref: '#/$defs/missing' }, n: { type: 'number' } } },
				// a schema that names its dialect is read only in it
				idFragment: { $schema: dialect2020, type: 'object', $id: 'https://example.com/tool#input', properties: {} },
				badAnchor: { $schema: dialect2020, type: 'object', $defs: { n: { $anchor: '1-not-a-name', type: 'number' } }, properties: {} },
			};
			for (const [name, schema] of Object.entries(schemas)) {
				for (const protocolVersion of [undefined, '2026-07-28']) {
					assert.ok(checkServerSchemaDocument(schema, protocolVersion).errors.length > 0, `${name} ${protocolVersion}: an error`);
				}
				for (const protocolVersion of ['2025-11-25', '2025-06-18', '2024-11-05']) {
					const check = checkServerSchemaDocument(schema, protocolVersion);
					assert.deepStrictEqual(check.errors, [], `${name} ${protocolVersion}`);
					assert.strictEqual(check.warnings.length, 1, `${name} ${protocolVersion}: ${JSON.stringify(check.warnings)}`);
				}
			}
			// a schema the strict reading accepts in the other dialect keeps that reading, without a warning
			assert.deepStrictEqual(checkServerSchemaDocument({ type: 'object', definitions: { n: { $id: '#num', type: 'number' } }, properties: { a: { $ref: '#num' } } }, '2025-11-25'), { errors: [], warnings: [] });
		});

		test('remote references stay errors for every revision', () => {
			for (const protocolVersion of [undefined, '2026-07-28', '2025-11-25', '2024-11-05']) {
				const compiled = compileServerSchema(remoteRef, protocolVersion);
				assert.ok(!isCompiledJsonSchema(compiled) && compiled.some(e => e.code === 'remote-ref'), String(protocolVersion));
				assert.ok(checkServerSchemaDocument(remoteRef, protocolVersion).errors.some(e => e.code === 'remote-ref'), String(protocolVersion));
			}
		});
	});

	suite('checkStructuredContent', () => {
		const outputSchema = { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] };
		const draft04 = { $schema: 'http://json-schema.org/draft-04/schema#', ...outputSchema };
		const remoteRef = { type: 'object', properties: { sum: { $ref: 'https://example.com/number.json' } } };
		const result = (structuredContent?: unknown, isError?: boolean): MCPLegacy.CallToolResult => ({ content: [{ type: 'text', text: 'done' }], structuredContent: structuredContent as MCPLegacy.CallToolResult['structuredContent'], isError });

		test('checks nothing without an output schema, without structured content or for an error result', () => {
			assert.deepStrictEqual([
				checkStructuredContent('calc', undefined, result({ sum: 'x' })),
				checkStructuredContent('calc', outputSchema, result(undefined)),
				checkStructuredContent('calc', draft04, result(undefined)),
				checkStructuredContent('calc', outputSchema, result({ sum: 'x' }, true)),
				checkStructuredContent('calc', draft04, result({ sum: 3 }, true)),
			].map(c => c.kind), ['ok', 'ok', 'ok', 'ok', 'ok']);
		});

		test('accepts content matching a 2020-12 or a draft-07 output schema', () => {
			assert.deepStrictEqual([
				checkStructuredContent('calc', outputSchema, result({ sum: 3 })),
				checkStructuredContent('calc', { $schema: 'http://json-schema.org/draft-07/schema#', ...outputSchema }, result({ sum: 3 })),
			].map(c => c.kind), ['ok', 'ok']);
		});

		test('reports content that does not match the output schema', () => {
			const check = checkStructuredContent('calc', outputSchema, result({ sum: 'three' }));
			assert.strictEqual(check.kind, 'mismatch');
			assert.ok(check.kind === 'mismatch' && check.detail.includes('/sum') && check.errors.length > 0, JSON.stringify(check));
		});

		test('an output schema that does not compile replaces the result with an isError result that says why', () => {
			for (const [schema, expected] of [[draft04, 'draft-04'], [remoteRef, 'https://example.com/number.json'], [{ type: 'object', properties: { sum: { type: 'decimal' } } }, '/properties/sum']] as const) {
				const check = checkStructuredContent('calc', schema, result({ sum: 3 }));
				assert.strictEqual(check.kind, 'invalid-schema', JSON.stringify(schema));
				if (check.kind !== 'invalid-schema') {
					continue;
				}
				assert.ok(check.problem.includes(expected), check.problem);
				assert.deepStrictEqual(Object.keys(check.result).sort(), ['content', 'isError'], 'the unvalidated content is dropped');
				assert.strictEqual(check.result.isError, true);
				const [block] = check.result.content;
				assert.ok(block.type === 'text' && block.text.includes('"calc"') && block.text.includes(check.problem), JSON.stringify(block));
			}
		});

		test('the same output schemas leave the result of a 2025-11-25 or older server unchecked, as before', () => {
			for (const protocolVersion of ['2025-11-25', '2025-06-18']) {
				const unchecked = checkStructuredContent('calc', remoteRef, result({ sum: 3 }), protocolVersion);
				assert.strictEqual(unchecked.kind, 'unchecked', protocolVersion);
				assert.ok(unchecked.kind === 'unchecked' && unchecked.problem.includes('https://example.com/number.json'));
				// a tolerated dialect is still checked
				assert.strictEqual(checkStructuredContent('calc', draft04, result({ sum: 3 }), protocolVersion).kind, 'ok');
				assert.strictEqual(checkStructuredContent('calc', draft04, result({ sum: 'three' }), protocolVersion).kind, 'mismatch');
			}
			assert.strictEqual(checkStructuredContent('calc', remoteRef, result({ sum: 3 }), '2026-07-28').kind, 'invalid-schema');
		});

		test('an output schema with a pattern that cannot be compiled still checks the rest', () => {
			const schema = { type: 'object', properties: { host: { type: 'string', pattern: '^([a-z0-9-]+\\.)+[a-z]{2,}$' }, port: { type: 'integer' } }, required: ['port'] };
			assert.strictEqual(checkStructuredContent('net', schema, result({ host: 'not a host!', port: 80 }), '2026-07-28').kind, 'ok');
			assert.strictEqual(checkStructuredContent('net', schema, result({ host: 'a.example', port: 'x' }), '2026-07-28').kind, 'mismatch');
		});

		test('checks with the output schema as its tool list read it: a pattern beyond the budget of the list is not checked, one it covers is', () => {
			const schema = { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z]+-listed$' } } };
			const tool = { inputSchema: { type: 'object' }, outputSchema: schema };
			const unmatched = result({ id: 'NOT' });

			// The list's budget is spent: the pattern is not checked for the list, nor for a call.
			const beyond = checkServerToolSchemas(tool, '2026-07-28', new PatternAnalysisBudget(0)).output;
			assert.ok(beyond && isCompiledJsonSchema(beyond) && beyond.warnings.some(w => w.message.includes('share a budget')), JSON.stringify(beyond));
			assert.strictEqual(checkStructuredContent('ids', schema, unmatched, '2026-07-28', () => beyond).kind, 'ok');

			// The list's budget covers it: checked for the list and for a call.
			const covered = checkServerToolSchemas(tool, '2026-07-28', new PatternAnalysisBudget()).output;
			assert.ok(covered && isCompiledJsonSchema(covered) && covered.warnings.length === 0, JSON.stringify(covered));
			assert.strictEqual(checkStructuredContent('ids', schema, unmatched, '2026-07-28', () => covered).kind, 'mismatch');

			// Without the list's reading the schema is compiled on its own, under a budget of its own.
			assert.strictEqual(checkStructuredContent('ids', schema, unmatched, '2026-07-28').kind, 'mismatch');
			assert.strictEqual(checkStructuredContent('ids', schema, unmatched, '2026-07-28', () => undefined).kind, 'mismatch');
			assert.strictEqual(checkStructuredContent('ids', schema, result({ id: 'abc-listed' }), '2026-07-28', () => covered).kind, 'ok');
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
