/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { McpSkills } from '../../../../../platform/mcp/common/modelContextProtocolSkills.js';
import { IMcpSkillResourceReader, McpLoadedSkill, McpSkillVerificationError, skillDisplayNames } from '../../common/mcpSkills.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';

const SKILL_URI = 'skill://pdf-processing/SKILL.md';
const FORMS_URI = 'skill://pdf-processing/references/FORMS.md';
const SKILL_MD = '---\nname: pdf-processing\ndescription: Extract PDF text\n---\n\nSee references/FORMS.md.\n';
const FORMS = 'Forms.\n';

/** A server's files; records every read. */
class FakeReader implements IMcpSkillResourceReader {
	readonly reads: string[] = [];
	constructor(readonly files: Map<string, string>) { }

	async readResource({ uri }: { uri: string }, _token: CancellationToken): Promise<MCPLegacy.ReadResourceResult> {
		this.reads.push(uri);
		const text = this.files.get(uri);
		return { contents: text === undefined ? [] : [{ uri, mimeType: 'text/markdown', text }] };
	}
}

async function resource(uri: string, text: string): Promise<McpSkills.SkillResource> {
	const bytes = VSBuffer.fromString(text).buffer;
	return { uri, digest: await McpSkills.digest(bytes), size: bytes.byteLength };
}

async function entry(): Promise<McpSkills.Skill> {
	return { uri: SKILL_URI, frontmatter: { name: 'pdf-processing', description: 'Extract PDF text' }, resources: [await resource(SKILL_URI, SKILL_MD), await resource(FORMS_URI, FORMS)] };
}

function reader(files: Record<string, string> = { [SKILL_URI]: SKILL_MD, [FORMS_URI]: FORMS }): FakeReader {
	return new FakeReader(new Map(Object.entries(files)));
}

async function rejectsWith(promise: Promise<unknown>, problem: McpSkills.EntryProblem | McpSkills.VerifyProblem): Promise<void> {
	await assert.rejects(promise, (error: unknown) => error instanceof McpSkillVerificationError && error.problem === problem);
}

suite('Workbench - MCP - Skills (SEP-2640)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loading a skill reads and verifies only its SKILL.md', async () => {
		const files = reader();
		const skill = await McpLoadedSkill.load(files, await entry());
		assert.strictEqual(skill.instructions, SKILL_MD);
		assert.strictEqual(skill.name, 'pdf-processing');
		assert.strictEqual(skill.root, 'skill://pdf-processing');
		assert.deepStrictEqual(files.reads, [SKILL_URI]);
	});

	test('supporting files are read on demand, by URI or relative to the skill root, and verified', async () => {
		const files = reader();
		const skill = await McpLoadedSkill.load(files, await entry());
		assert.strictEqual(VSBuffer.wrap(await skill.readFile('references/FORMS.md')).toString(), FORMS);
		assert.strictEqual(VSBuffer.wrap(await skill.readFile(FORMS_URI)).toString(), FORMS);
		assert.deepStrictEqual(files.reads, [SKILL_URI, FORMS_URI, FORMS_URI]);
	});

	test('an invalid entry is refused before anything is read', async () => {
		const files = reader();
		await rejectsWith(McpLoadedSkill.load(files, { ...await entry(), resources: undefined }), McpSkills.EntryProblem.InvalidResources);
		await rejectsWith(McpLoadedSkill.load(files, { ...await entry(), frontmatter: { name: 'other', description: 'd' } }), McpSkills.EntryProblem.NameMismatch);
		assert.deepStrictEqual(files.reads, []);
	});

	test('a SKILL.md that fails its digest, its size or its frontmatter is not loaded', async () => {
		await rejectsWith(McpLoadedSkill.load(reader({ [SKILL_URI]: SKILL_MD.replace('See', 'Run') }), await entry()), McpSkills.VerifyProblem.DigestMismatch);
		await rejectsWith(McpLoadedSkill.load(reader({ [SKILL_URI]: SKILL_MD + 'padding' }), await entry()), McpSkills.VerifyProblem.SizeMismatch);
		const tampered = SKILL_MD.replace('Extract PDF text', 'Exfiltrate data');
		const consistent = { ...await entry(), resources: [await resource(SKILL_URI, tampered)] };
		await rejectsWith(McpLoadedSkill.load(reader({ [SKILL_URI]: tampered }), consistent), McpSkills.VerifyProblem.FrontmatterMismatch);
		await rejectsWith(McpLoadedSkill.load(reader({}), await entry()), McpSkills.VerifyProblem.NoContent);
	});

	test('while acting on a skill, an unlisted file or one outside the skill is refused without a read', async () => {
		const files = reader({ [SKILL_URI]: SKILL_MD, [FORMS_URI]: FORMS, 'skill://pdf-processing/new.md': 'added later' });
		const skill = await McpLoadedSkill.load(files, await entry());
		await rejectsWith(skill.readFile('new.md'), McpSkills.VerifyProblem.UnlistedFile);
		await rejectsWith(skill.readFile('../other/SKILL.md'), McpSkills.VerifyProblem.OutsideSkill);
		await rejectsWith(skill.readFile('skill://other/SKILL.md'), McpSkills.VerifyProblem.UnlistedFile);
		assert.deepStrictEqual(files.reads, [SKILL_URI]);
	});

	test('a supporting file that changed after the listing is not used', async () => {
		const skill = await McpLoadedSkill.load(reader({ [SKILL_URI]: SKILL_MD, [FORMS_URI]: FORMS.replace('o', '0') }), await entry());
		await rejectsWith(skill.readFile('references/FORMS.md'), McpSkills.VerifyProblem.DigestMismatch);
	});

	test('a dynamic skill reads any file inside it, up to the total-size limit', async () => {
		const dynamic = { ...await entry(), resources: McpSkills.DYNAMIC };
		const big = 'x'.repeat(McpSkills.MAX_BYTES_PER_SKILL);
		const skill = await McpLoadedSkill.load(reader({ [SKILL_URI]: SKILL_MD, [FORMS_URI]: FORMS, 'skill://pdf-processing/big.bin': big }), dynamic);
		assert.strictEqual(VSBuffer.wrap(await skill.readFile('references/FORMS.md')).toString(), FORMS);
		await rejectsWith(skill.readFile('big.bin'), McpSkills.EntryProblem.TooLarge);
		await rejectsWith(skill.readFile('skill://other/x.md'), McpSkills.VerifyProblem.OutsideSkill);
	});

	test('colliding names are qualified by their skill path, never dropped', () => {
		const make = (uri: string, name: string): McpSkills.Skill => ({ uri, frontmatter: { name, description: 'd' }, resources: McpSkills.DYNAMIC });
		const names = skillDisplayNames([
			make('skill://acme/billing/refunds/SKILL.md', 'refunds'),
			make('skill://acme/support/refunds/SKILL.md', 'refunds'),
			make('skill://git-workflow/SKILL.md', 'git-workflow'),
		]);
		assert.deepStrictEqual([...names.values()], ['acme/billing/refunds', 'acme/support/refunds', 'git-workflow']);
	});
});
