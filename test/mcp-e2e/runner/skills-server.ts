/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// An MCP server over stdio that serves skills (the Skills extension `io.modelcontextprotocol/skills`,
// SEP-2640) for the end-to-end run: neither the zig-sdk conformance server nor server-everything
// declares the extension. It speaks MCP 2026-07-28 (`server/discover`, every result complete with
// the server's identity in `_meta`) and answers a 2025-11-25 `initialize` too.
//
// It serves three skills, each file an ordinary resource under `skill://`:
//   pdf-processing        SKILL.md, references/FORMS.md, templates/invoice.md, templates/regional/eu-invoice.md
//   acme/billing/refunds  SKILL.md, examples/email.md (a nested path; the skill name is "refunds")
//   live-report           a dynamic skill ("resources": "dynamic"): its files are only found
//                         with resources/directory/read, which the server offers (directoryRead)
// The entries carry the SHA-256 digest and size of every file, so VS Code verifies each read.
//
// One JSON line per request is appended to the log file (--log): { "method", "uri"? }, so the
// suite can check what VS Code read and when (listing reads no file; a load reads SKILL.md only).
//
// It also has one tool, skills_info, so that the suite's server start, which waits for the live
// tools, sees it up.
//
// Usage: node runner/skills-server.ts [--log <file.jsonl>]

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as readline from 'readline';

const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
const SERVER_INFO = { name: 'mcp-e2e-skills', version: '1.0.0' };
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const DIRECTORY_MIME_TYPE = 'inode/directory';

interface ISkillDefinition {
	readonly root: string;
	readonly frontmatter: Record<string, string>;
	readonly body: string;
	readonly files: Record<string, string>;
	readonly dynamic?: boolean;
}

const SKILLS: readonly ISkillDefinition[] = [
	{
		root: 'skill://pdf-processing',
		frontmatter: { name: 'pdf-processing', description: 'Extract, fill, and assemble PDF documents' },
		body: '# PDF processing\n\nFill forms with `references/FORMS.md` and pick a template from `templates/`.\n\nE2E-MARKER: pdf-processing instructions.\n',
		files: {
			'references/FORMS.md': '# Forms\n\nE2E-MARKER: how to fill PDF forms.\n',
			'templates/invoice.md': '# Invoice\n',
			'templates/regional/eu-invoice.md': '# EU invoice\n',
		},
	},
	{
		root: 'skill://acme/billing/refunds',
		frontmatter: { name: 'refunds', description: 'Process customer refund requests per company policy' },
		body: 'Follow `examples/email.md`.\n',
		files: { 'examples/email.md': 'Dear customer,\n' },
	},
	{
		root: 'skill://live-report',
		frontmatter: { name: 'live-report', description: 'A report the server generates on each read' },
		body: '# Live report\n\nRead `data/summary.md` for the latest numbers.\n',
		files: { 'data/summary.md': '# Summary\n\nE2E-MARKER: generated summary.\n' },
		dynamic: true,
	},
];

function skillMd(skill: ISkillDefinition): string {
	const lines = Object.entries(skill.frontmatter).map(([key, value]) => `${key}: ${value}`);
	return `---\n${lines.join('\n')}\n---\n\n${skill.body}`;
}

/** Every file of every skill by URI. */
const FILES = new Map<string, string>();
for (const skill of SKILLS) {
	FILES.set(`${skill.root}/SKILL.md`, skillMd(skill));
	for (const [relative, text] of Object.entries(skill.files)) {
		FILES.set(`${skill.root}/${relative}`, text);
	}
}

function entryOf(skill: ISkillDefinition): Record<string, unknown> {
	const uri = `${skill.root}/SKILL.md`;
	const resources = skill.dynamic ? 'dynamic' : [...FILES].filter(([u]) => u.startsWith(`${skill.root}/`)).map(([u, text]) => {
		const bytes = Buffer.from(text, 'utf8');
		return { uri: u, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.byteLength };
	});
	return { uri, frontmatter: skill.frontmatter, resources };
}

function mimeTypeOf(uri: string): string {
	return uri.endsWith('.md') ? 'text/markdown' : 'text/plain';
}

/** The direct children of a directory URI: files and subdirectories. */
function childrenOf(dir: string): Record<string, unknown>[] | undefined {
	const prefix = `${dir.replace(/\/+$/, '')}/`;
	const children = new Map<string, boolean>();
	for (const uri of FILES.keys()) {
		if (uri.startsWith(prefix)) {
			const rest = uri.slice(prefix.length);
			const slash = rest.indexOf('/');
			children.set(prefix + (slash < 0 ? rest : rest.slice(0, slash)), slash >= 0);
		}
	}
	if (children.size === 0) {
		return undefined;
	}
	return [...children].map(([uri, directory]) => ({ uri, name: uri.slice(prefix.length), mimeType: directory ? DIRECTORY_MIME_TYPE : mimeTypeOf(uri) }));
}

class RpcError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

const capabilities = { resources: {}, tools: {}, extensions: { [SKILLS_EXTENSION]: { directoryRead: true } } };

function handle(method: string, params: Record<string, unknown>): Record<string, unknown> {
	switch (method) {
		case 'server/discover':
			return { supportedVersions: [PROTOCOL_VERSION], capabilities };
		case 'initialize':
			return { protocolVersion: LEGACY_VERSION, capabilities, serverInfo: SERVER_INFO };
		case 'ping':
			return {};
		case 'tools/list':
			// One tool, so that the suite's server start (which waits for the live tools) sees the server up.
			return { tools: [{ name: 'skills_info', description: 'Describes the skills this server serves', inputSchema: { type: 'object', properties: {} } }] };
		case 'tools/call':
			return { content: [{ type: 'text', text: `This server serves ${SKILLS.length} skills: ${SKILLS.map(s => s.frontmatter.name).join(', ')}` }] };
		case 'resources/list':
			return { resources: [...FILES.keys()].map(uri => ({ uri, name: uri.slice(uri.lastIndexOf('/') + 1), mimeType: mimeTypeOf(uri) })) };
		case 'resources/templates/list':
			return { resourceTemplates: [] };
		case 'resources/read': {
			const uri = String(params.uri);
			const text = FILES.get(uri);
			if (text === undefined) {
				throw new RpcError(-32602, `Resource not found: ${uri}`);
			}
			return { contents: [{ uri, mimeType: mimeTypeOf(uri), text }] };
		}
		case 'resources/directory/read': {
			const children = childrenOf(String(params.uri));
			if (!children) {
				throw new RpcError(-32602, `Directory not found: ${String(params.uri)}`);
			}
			return { resources: children };
		}
		case 'skills/list':
			return { skills: SKILLS.map(entryOf) };
		case 'skills/get': {
			const skill = SKILLS.find(s => `${s.root}/SKILL.md` === params.uri);
			if (!skill) {
				throw new RpcError(-32602, `Unknown skill: ${String(params.uri)}`);
			}
			return { skill: entryOf(skill) };
		}
		default:
			throw new RpcError(-32601, `Method not found: ${method}`);
	}
}

function argValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i !== -1 ? process.argv[i + 1] : undefined;
}

const logFile = argValue('--log');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
	let message: { id?: unknown; method?: unknown; params?: unknown };
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof message.method !== 'string') {
		return; // a response or a notification without a method
	}
	const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
	if (logFile) {
		fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), method: message.method, ...(typeof params.uri === 'string' ? { uri: params.uri } : {}) }) + '\n');
	}
	if (message.id === undefined) {
		return; // a notification
	}
	let reply: Record<string, unknown>;
	try {
		const result = handle(message.method, params);
		// The 2026-07-28 shape of every result; a 2025-11-25 client ignores the extra fields.
		reply = { jsonrpc: '2.0', id: message.id, result: { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: { [META_SERVER_INFO]: SERVER_INFO } } };
	} catch (e) {
		reply = { jsonrpc: '2.0', id: message.id, error: { code: e instanceof RpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } };
	}
	process.stdout.write(JSON.stringify(reply) + '\n');
});
