/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IMcpSkillDefinition, McpSkillCatalog } from '../../common/mcpSkillCatalog.js';
import { McpSkills } from '../../common/modelContextProtocolSkills.js';

const PDF: IMcpSkillDefinition = {
	skillMd: '---\nname: pdf-processing\ndescription: Extract PDF text\nmetadata:\n  version: 2.1.0\n---\nBody\n',
	files: [
		{ path: 'references/FORMS.md', content: 'Forms\n' },
		{ path: 'templates/regional/eu-invoice.md', content: 'EU\n' },
		{ path: 'scripts/extract.py', content: 'print(1)\n' },
	],
};

const REFUNDS: IMcpSkillDefinition = { prefix: 'acme/billing', skillMd: '---\nname: refunds\ndescription: Refunds\n---\n' };

suite('MCP - Skill catalog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('entries carry the verbatim frontmatter and a complete manifest whose digests and sizes match the served bytes', async () => {
		const catalog = await McpSkillCatalog.create([PDF, REFUNDS]);
		assert.deepStrictEqual(catalog.entries.map(entry => entry.uri), ['skill://pdf-processing/SKILL.md', 'skill://acme/billing/refunds/SKILL.md']);
		const [pdf] = catalog.entries;
		assert.deepStrictEqual(pdf.frontmatter, { name: 'pdf-processing', description: 'Extract PDF text', metadata: { version: '2.1.0' } });
		assert.ok(pdf.resources !== McpSkills.DYNAMIC);
		assert.deepStrictEqual(pdf.resources.map(file => file.uri), [
			'skill://pdf-processing/SKILL.md',
			'skill://pdf-processing/references/FORMS.md',
			'skill://pdf-processing/templates/regional/eu-invoice.md',
			'skill://pdf-processing/scripts/extract.py',
		]);
		for (const entry of catalog.entries) {
			assert.strictEqual(McpSkills.validateEntry(entry).ok, true, entry.uri);
			for (const file of entry.resources === McpSkills.DYNAMIC ? [] : entry.resources) {
				const read = catalog.read(file.uri);
				const bytes = McpSkills.contentBytes(read!.contents[0])!;
				assert.strictEqual(await McpSkills.verifyFile(entry, file.uri, bytes), undefined, file.uri);
			}
		}
		assert.deepStrictEqual(catalog.getSkill('skill://acme/billing/refunds/SKILL.md'), catalog.entries[1]);
		assert.strictEqual(catalog.getSkill('skill://refunds/SKILL.md'), undefined);
		assert.strictEqual(catalog.read('skill://pdf-processing/nope.md'), undefined);
	});

	test('every file is a resource; SKILL.md carries the frontmatter name and description and is text/markdown', async () => {
		const catalog = await McpSkillCatalog.create([PDF]);
		const resources = catalog.resources();
		assert.deepStrictEqual(resources[0], { uri: 'skill://pdf-processing/SKILL.md', name: 'pdf-processing', description: 'Extract PDF text', mimeType: 'text/markdown' });
		assert.deepStrictEqual(resources.slice(1).map(resource => [resource.name, resource.mimeType]), [['FORMS.md', 'text/markdown'], ['eu-invoice.md', 'text/markdown'], ['extract.py', 'text/x-python']]);
		assert.strictEqual(catalog.read('skill://pdf-processing/SKILL.md')?.contents[0].mimeType, 'text/markdown');
	});

	test('every directory level of a skill is a directory resource listing its direct children', async () => {
		const catalog = await McpSkillCatalog.create([PDF]);
		const children = (uri: string) => catalog.readDirectory(uri)?.map(resource => `${resource.uri} ${resource.mimeType}`);
		assert.deepStrictEqual(children('skill://pdf-processing'), [
			'skill://pdf-processing/SKILL.md text/markdown',
			'skill://pdf-processing/references inode/directory',
			'skill://pdf-processing/templates inode/directory',
			'skill://pdf-processing/scripts inode/directory',
		]);
		assert.deepStrictEqual(children('skill://pdf-processing/templates'), ['skill://pdf-processing/templates/regional inode/directory']);
		assert.deepStrictEqual(children('skill://pdf-processing/templates/regional'), ['skill://pdf-processing/templates/regional/eu-invoice.md text/markdown']);
		assert.strictEqual(catalog.readDirectory('skill://pdf-processing/SKILL.md'), undefined, 'a file is not a directory');
		assert.strictEqual(catalog.readDirectory('skill://pdf-processing/'), undefined, 'directory URIs have no trailing slash');
		assert.strictEqual(catalog.readDirectory('skill://acme'), undefined, 'the organizational prefix is outside every skill');
	});

	test('a definition with an invalid name, a missing description, a bad file path or a duplicate skill is refused', async () => {
		await assert.rejects(McpSkillCatalog.create([{ skillMd: '---\nname: Bad_Name\ndescription: d\n---\n' }]), /valid name/);
		await assert.rejects(McpSkillCatalog.create([{ skillMd: '---\nname: ok\n---\n' }]), /valid name and a description/);
		await assert.rejects(McpSkillCatalog.create([{ skillMd: '---\nname: ok\ndescription: d\n---\n', files: [{ path: '../escape.md', content: '' }] }]), /Invalid file path/);
		await assert.rejects(McpSkillCatalog.create([{ skillMd: '---\nname: ok\ndescription: d\n---\n', files: [{ path: 'SKILL.md', content: '' }] }]), /Invalid file path/);
		await assert.rejects(McpSkillCatalog.create([REFUNDS, REFUNDS]), /Duplicate skill/);
	});

	test('sizes count UTF-8 bytes, not characters', async () => {
		const catalog = await McpSkillCatalog.create([{ skillMd: '---\nname: unicode\ndescription: é\n---\n' }]);
		const [file] = catalog.entries[0].resources as McpSkills.SkillResource[];
		assert.strictEqual(file.size, VSBuffer.fromString('---\nname: unicode\ndescription: é\n---\n').byteLength);
		assert.notStrictEqual(file.size, '---\nname: unicode\ndescription: é\n---\n'.length);
	});
});
