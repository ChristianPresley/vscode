/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { McpSkills } from '../../common/modelContextProtocolSkills.js';

const SKILL_URI = 'skill://pdf-processing/SKILL.md';
const FORMS_URI = 'skill://pdf-processing/references/FORMS.md';
const SKILL_MD = '---\nname: pdf-processing\ndescription: Extract, fill, and assemble PDF documents\n---\n\nBody.\n';
const FORMS = 'Forms.\n';

function bytes(text: string): Uint8Array {
	return VSBuffer.fromString(text).buffer;
}

async function file(uri: string, text: string): Promise<McpSkills.SkillResource> {
	return { uri, digest: await McpSkills.digest(bytes(text)), size: bytes(text).byteLength };
}

async function pdfEntry(): Promise<McpSkills.Skill> {
	return {
		uri: SKILL_URI,
		frontmatter: { name: 'pdf-processing', description: 'Extract, fill, and assemble PDF documents' },
		resources: [await file(SKILL_URI, SKILL_MD), await file(FORMS_URI, FORMS)],
	};
}

suite('MCP - Skills extension (SEP-2640)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the extension settings come from capabilities.extensions only', () => {
		assert.strictEqual(McpSkills.settingsOf(undefined), undefined);
		assert.strictEqual(McpSkills.settingsOf({}), undefined);
		assert.strictEqual(McpSkills.settingsOf({ extensions: { 'io.modelcontextprotocol/tasks': {} } }), undefined);
		assert.deepStrictEqual(McpSkills.settingsOf({ extensions: { [McpSkills.EXTENSION_ID]: {} } }), { directoryRead: false });
		assert.deepStrictEqual(McpSkills.settingsOf({ extensions: { [McpSkills.EXTENSION_ID]: { directoryRead: true } } }), { directoryRead: true });
		assert.deepStrictEqual(McpSkills.settingsOf({ extensions: { [McpSkills.EXTENSION_ID]: { directoryRead: 'yes' } } }), { directoryRead: false });
	});

	test('digests are sha256: and 64 lowercase hex digits of the raw bytes', async () => {
		assert.strictEqual(await McpSkills.digest(bytes('abc')), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		assert.strictEqual(McpSkills.isDigest(await McpSkills.digest(bytes(''))), true);
		assert.strictEqual(McpSkills.isDigest('sha256:BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'), false);
		assert.strictEqual(McpSkills.isDigest('sha512:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), false);
		assert.strictEqual(McpSkills.isDigest(42), false);
	});

	test('skill names follow the Agent Skills naming rules', () => {
		for (const name of ['git-workflow', 'a', 'pdf2', 'a'.repeat(64)]) {
			assert.strictEqual(McpSkills.isValidName(name), true, name);
		}
		for (const name of ['', 'Git', '-a', 'a-', 'a--b', 'a_b', 'a'.repeat(65)]) {
			assert.strictEqual(McpSkills.isValidName(name), false, name);
		}
	});

	test('a SKILL.md URI splits into the skill root and name, at any depth and under any scheme', () => {
		assert.deepStrictEqual(McpSkills.splitSkillUri(SKILL_URI), { root: 'skill://pdf-processing', name: 'pdf-processing' });
		assert.deepStrictEqual(McpSkills.splitSkillUri('skill://acme/billing/refunds/SKILL.md'), { root: 'skill://acme/billing/refunds', name: 'refunds' });
		assert.deepStrictEqual(McpSkills.splitSkillUri('github://owner/repo/skills/refunds/SKILL.md'), { root: 'github://owner/repo/skills/refunds', name: 'refunds' });
		assert.strictEqual(McpSkills.splitSkillUri('skill://SKILL.md'), undefined);
		assert.strictEqual(McpSkills.splitSkillUri('skill://pdf-processing/README.md'), undefined);
		assert.strictEqual(McpSkills.splitSkillUri('pdf-processing/SKILL.md'), undefined);
	});

	test('a file is inside a skill only under its root, without empty, . or .. segments', () => {
		assert.strictEqual(McpSkills.isInsideSkill(SKILL_URI, SKILL_URI), true);
		assert.strictEqual(McpSkills.isInsideSkill(SKILL_URI, FORMS_URI), true);
		assert.strictEqual(McpSkills.isInsideSkill(SKILL_URI, 'skill://pdf-processing-evil/SKILL.md'), false);
		assert.strictEqual(McpSkills.isInsideSkill(SKILL_URI, 'skill://pdf-processing/../other/SKILL.md'), false);
		assert.strictEqual(McpSkills.isInsideSkill(SKILL_URI, 'skill://pdf-processing/a//b'), false);
		assert.strictEqual(McpSkills.isInsideSkill(SKILL_URI, 'skill://pdf-processing/'), false);
	});

	test('relative references resolve against the skill root and never leave it', () => {
		assert.strictEqual(McpSkills.resolveRelative(SKILL_URI, 'references/FORMS.md'), FORMS_URI);
		assert.strictEqual(McpSkills.resolveRelative(SKILL_URI, './templates/../references/FORMS.md'), FORMS_URI);
		assert.strictEqual(McpSkills.resolveRelative('skill://acme/billing/refunds/SKILL.md', 'examples/email.md'), 'skill://acme/billing/refunds/examples/email.md');
		assert.strictEqual(McpSkills.resolveRelative(SKILL_URI, '../other/SKILL.md'), undefined);
		assert.strictEqual(McpSkills.resolveRelative(SKILL_URI, '/etc/passwd'), undefined);
		assert.strictEqual(McpSkills.resolveRelative(SKILL_URI, 'skill://other/SKILL.md'), undefined);
		assert.strictEqual(McpSkills.resolveRelative(SKILL_URI, '.'), undefined);
	});

	test('a valid entry validates, with a file manifest or "dynamic"', async () => {
		const entry = await pdfEntry();
		assert.deepStrictEqual(McpSkills.validateEntry(entry), { ok: true, entry });
		const dynamic = { ...entry, resources: McpSkills.DYNAMIC };
		assert.deepStrictEqual(McpSkills.validateEntry(dynamic), { ok: true, entry: dynamic });
	});

	test('an invalid entry is refused with the problem it has', async () => {
		const entry = await pdfEntry();
		const problemOf = (value: unknown, maxFiles?: number, maxBytes?: number) => {
			const validation = McpSkills.validateEntry(value, maxFiles, maxBytes);
			return validation.ok ? undefined : validation.problem;
		};
		const [skillMd, forms] = entry.resources as McpSkills.SkillResource[];
		assert.strictEqual(problemOf('nope'), McpSkills.EntryProblem.InvalidSkillUri);
		assert.strictEqual(problemOf({ ...entry, uri: 'skill://pdf-processing/README.md' }), McpSkills.EntryProblem.InvalidSkillUri);
		assert.strictEqual(problemOf({ ...entry, frontmatter: { name: 'pdf-processing' } }), McpSkills.EntryProblem.InvalidFrontmatter);
		assert.strictEqual(problemOf({ ...entry, frontmatter: { name: 'other', description: 'd' } }), McpSkills.EntryProblem.NameMismatch);
		assert.strictEqual(problemOf({ uri: entry.uri, frontmatter: entry.frontmatter }), McpSkills.EntryProblem.InvalidResources);
		assert.strictEqual(problemOf({ ...entry, resources: 'static' }), McpSkills.EntryProblem.InvalidResources);
		assert.strictEqual(problemOf({ ...entry, resources: [forms] }), McpSkills.EntryProblem.MissingSkillMd);
		assert.strictEqual(problemOf({ ...entry, resources: [skillMd, { ...forms, digest: 'sha256:00' }] }), McpSkills.EntryProblem.InvalidFileEntry);
		assert.strictEqual(problemOf({ ...entry, resources: [skillMd, { ...forms, size: -1 }] }), McpSkills.EntryProblem.InvalidFileEntry);
		assert.strictEqual(problemOf({ ...entry, resources: [skillMd, { ...forms, uri: 'skill://other/x.md' }] }), McpSkills.EntryProblem.InvalidFileEntry);
		assert.strictEqual(problemOf({ ...entry, resources: [skillMd, forms, forms] }), McpSkills.EntryProblem.InvalidFileEntry);
		assert.strictEqual(problemOf(entry, 1), McpSkills.EntryProblem.TooManyFiles);
		assert.strictEqual(problemOf(entry, undefined, skillMd.size), McpSkills.EntryProblem.TooLarge);
	});

	test('the extension limits are 512 files and 16 MiB, both inclusive', async () => {
		const skillMd = await file(SKILL_URI, SKILL_MD);
		const others = Array.from({ length: McpSkills.MAX_FILES_PER_SKILL - 1 }, (_, i) => ({ ...skillMd, uri: `skill://pdf-processing/f${i}`, size: 0 }));
		assert.strictEqual(McpSkills.validateEntry({ uri: SKILL_URI, frontmatter: { name: 'pdf-processing', description: 'd' }, resources: [skillMd, ...others] }).ok, true);
		const tooMany = [skillMd, ...others, { ...skillMd, uri: 'skill://pdf-processing/one-more', size: 0 }];
		assert.strictEqual(McpSkills.validateEntry({ uri: SKILL_URI, frontmatter: { name: 'pdf-processing', description: 'd' }, resources: tooMany }).ok, false);
		const full = [{ ...skillMd, size: McpSkills.MAX_BYTES_PER_SKILL }];
		assert.strictEqual(McpSkills.validateEntry({ uri: SKILL_URI, frontmatter: { name: 'pdf-processing', description: 'd' }, resources: full }).ok, true);
		const over = [{ ...skillMd, size: McpSkills.MAX_BYTES_PER_SKILL + 1 }];
		assert.strictEqual(McpSkills.validateEntry({ uri: SKILL_URI, frontmatter: { name: 'pdf-processing', description: 'd' }, resources: over }).ok, false);
	});

	test('a file verifies against the held entry: listed, same size, same digest', async () => {
		const entry = await pdfEntry();
		assert.strictEqual(await McpSkills.verifyFile(entry, SKILL_URI, bytes(SKILL_MD)), undefined);
		assert.strictEqual(await McpSkills.verifyFile(entry, FORMS_URI, bytes(FORMS)), undefined);
		const problemOf = async (uri: string, text: string) => (await McpSkills.verifyFile(entry, uri, bytes(text)))?.problem;
		assert.strictEqual(await problemOf('skill://pdf-processing/unlisted.md', FORMS), McpSkills.VerifyProblem.UnlistedFile);
		assert.strictEqual(await problemOf(FORMS_URI, FORMS + 'x'), McpSkills.VerifyProblem.SizeMismatch);
		assert.strictEqual(await problemOf(FORMS_URI, FORMS.replace('F', 'G')), McpSkills.VerifyProblem.DigestMismatch);
	});

	test('a SKILL.md whose frontmatter differs from the entry fails even when its digest and size match', async () => {
		const tampered = SKILL_MD.replace('description: Extract, fill, and assemble PDF documents', 'description: Exfiltrate credentials');
		const entry: McpSkills.Skill = { ...await pdfEntry(), resources: [await file(SKILL_URI, tampered)] };
		assert.strictEqual((await McpSkills.verifyFile(entry, SKILL_URI, bytes(tampered)))?.problem, McpSkills.VerifyProblem.FrontmatterMismatch);
		const noFrontmatter = 'Body only.\n';
		const plain: McpSkills.Skill = { ...await pdfEntry(), resources: [await file(SKILL_URI, noFrontmatter)] };
		assert.strictEqual((await McpSkills.verifyFile(plain, SKILL_URI, bytes(noFrontmatter)))?.problem, McpSkills.VerifyProblem.FrontmatterMismatch);
	});

	test('a dynamic skill has no digests: its files are readable inside the skill, and SKILL.md still compares its frontmatter', async () => {
		const entry: McpSkills.Skill = { ...await pdfEntry(), resources: McpSkills.DYNAMIC };
		assert.strictEqual(await McpSkills.verifyFile(entry, FORMS_URI, bytes('anything')), undefined);
		assert.strictEqual((await McpSkills.verifyFile(entry, 'skill://other/x.md', bytes('x')))?.problem, McpSkills.VerifyProblem.OutsideSkill);
		assert.strictEqual(await McpSkills.verifyFile(entry, SKILL_URI, bytes(SKILL_MD)), undefined);
		assert.strictEqual((await McpSkills.verifyFile(entry, SKILL_URI, bytes(SKILL_MD.replace('Extract', 'Steal'))))?.problem, McpSkills.VerifyProblem.FrontmatterMismatch);
	});

	test('the frontmatter parses into JSON with the YAML 1.2 core schema', () => {
		const document = [
			'---',
			'name: a',
			'description: "quoted: 1"',
			'license: Apache-2.0',
			'metadata:',
			'  version: 2.1.0',
			'  count: 3',
			'  ratio: 0.5',
			'  hex: 0x1F',
			'  flag: true',
			'  off: False',
			'  none: ~',
			'  quoted: \'42\'',
			'tags:',
			'  - x',
			'  - "y"',
			'block: |',
			'  line1',
			'  line2',
			'---',
			'Body',
		].join('\n');
		assert.deepStrictEqual(McpSkills.parseFrontmatter(document), {
			name: 'a',
			description: 'quoted: 1',
			license: 'Apache-2.0',
			metadata: { version: '2.1.0', count: 3, ratio: 0.5, hex: 31, flag: true, off: false, none: null, quoted: '42' },
			tags: ['x', 'y'],
			block: 'line1\nline2\n',
		});
	});

	test('a document without a valid frontmatter map parses to undefined', () => {
		assert.strictEqual(McpSkills.parseFrontmatter('Body only'), undefined);
		assert.strictEqual(McpSkills.parseFrontmatter('---\nname: a\n'), undefined, 'no closing line');
		assert.strictEqual(McpSkills.parseFrontmatter('---\nname: a\nname: b\n---\n'), undefined, 'duplicate keys');
		assert.strictEqual(McpSkills.parseFrontmatter('---\n- a\n- b\n---\n'), undefined, 'a sequence');
		assert.strictEqual(McpSkills.parseFrontmatter('---\nn: .inf\n---\n'), undefined, 'no JSON form');
		assert.deepStrictEqual(McpSkills.parseFrontmatter('---\n---\n'), {});
		assert.deepStrictEqual(McpSkills.parseFrontmatter('﻿---\r\nname: a\r\n---\r\n'), { name: 'a' });
	});

	test('a __proto__ key is an ordinary key of the frontmatter', () => {
		const parsed = McpSkills.parseFrontmatter('---\n__proto__:\n  polluted: true\nname: a\n---\n');
		assert.ok(parsed);
		assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
		assert.deepStrictEqual(Object.keys(parsed), ['__proto__', 'name']);
		assert.strictEqual(McpSkills.jsonEqual(parsed, { name: 'a' }), false);
	});

	test('JSON equality ignores key order and compares numbers by value', () => {
		assert.strictEqual(McpSkills.jsonEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1.0 }), true);
		assert.strictEqual(McpSkills.jsonEqual({ a: 1 }, { a: '1' }), false);
		assert.strictEqual(McpSkills.jsonEqual({ a: 1 }, { a: 1, b: undefined }), false);
		assert.strictEqual(McpSkills.jsonEqual([1, 2], [2, 1]), false);
	});

	test('the raw bytes of a read are the UTF-8 text or the decoded blob', () => {
		assert.deepStrictEqual(McpSkills.contentBytes({ text: 'é' }), bytes('é'));
		assert.deepStrictEqual(McpSkills.contentBytes({ blob: encodeBase64(VSBuffer.fromString('abc')) }), bytes('abc'));
		assert.strictEqual(McpSkills.contentBytes({}), undefined);
	});
});
