/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';
import { McpSkills } from './modelContextProtocolSkills.js';

/**
 * A set of skills held in memory and served the way the Skills extension
 * (SEP-2640) maps them onto resources: every file is a resource under
 * `<scheme>://<skill-path>/<file-path>`, the entries carry the digest and
 * size of each file, and every directory level of a skill is a directory
 * resource (`inode/directory`) for `resources/directory/read`.
 */

/** A file of a skill other than `SKILL.md`. */
export interface IMcpSkillFileDefinition {
	/** The path relative to the skill's root, `/`-separated. */
	readonly path: string;
	readonly content: string;
	/** Derived from the file extension when absent. */
	readonly mimeType?: string;
}

export interface IMcpSkillDefinition {
	/** Defaults to `skill`. */
	readonly scheme?: string;
	/** The organizational prefix of the skill path (`acme/billing`), without slashes at the ends. */
	readonly prefix?: string;
	/** The text of `SKILL.md`; its frontmatter `name` is the last segment of the skill path. */
	readonly skillMd: string;
	readonly files?: readonly IMcpSkillFileDefinition[];
}

interface IStoredFile {
	readonly uri: string;
	readonly mimeType: string;
	readonly text: string;
	readonly resource: MCPLegacy.Resource;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
	md: McpSkills.SKILL_MD_MIME_TYPE,
	py: 'text/x-python',
	json: 'application/json',
	txt: 'text/plain',
};

function mimeTypeOf(path: string): string {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	return MIME_TYPES[extension] ?? 'text/plain';
}

function basename(uri: string): string {
	return uri.slice(uri.lastIndexOf('/') + 1);
}

export class McpSkillCatalog {
	/**
	 * Builds the catalog: checks each definition (a valid name equal to the
	 * last path segment, a parseable frontmatter with a description, clean
	 * file paths, no duplicate skill) and computes the digests. Throws on the
	 * first invalid definition.
	 */
	public static async create(definitions: readonly IMcpSkillDefinition[]): Promise<McpSkillCatalog> {
		const entries: McpSkills.Skill[] = [];
		const files = new Map<string, IStoredFile>();
		const directories = new Map<string, Map<string, MCPLegacy.Resource>>();

		const addToDirectory = (directory: string, child: MCPLegacy.Resource) => {
			let children = directories.get(directory);
			if (!children) {
				children = new Map();
				directories.set(directory, children);
			}
			children.set(child.uri, child);
		};

		for (const definition of definitions) {
			const frontmatter = McpSkills.parseFrontmatter(definition.skillMd);
			const name = frontmatter?.name;
			if (!frontmatter || typeof name !== 'string' || !McpSkills.isValidName(name) || typeof frontmatter.description !== 'string') {
				throw new Error('A skill needs a frontmatter with a valid name and a description');
			}
			const prefix = definition.prefix ? `${definition.prefix}/` : '';
			const root = `${definition.scheme ?? McpSkills.DEFAULT_SCHEME}://${prefix}${name}`;
			const uri = `${root}/${McpSkills.SKILL_MD}`;
			if (entries.some(entry => entry.uri === uri)) {
				throw new Error(`Duplicate skill ${uri}`);
			}
			const sources = [{ path: McpSkills.SKILL_MD, content: definition.skillMd, mimeType: McpSkills.SKILL_MD_MIME_TYPE }, ...(definition.files ?? [])];
			const manifest: McpSkills.SkillResource[] = [];
			for (const source of sources) {
				const fileUri = `${root}/${source.path}`;
				if (!McpSkills.isInsideSkill(uri, fileUri) || manifest.some(file => file.uri === fileUri)) {
					throw new Error(`Invalid file path ${source.path} in ${uri}`);
				}
				const bytes = VSBuffer.fromString(source.content).buffer;
				manifest.push({ uri: fileUri, digest: await McpSkills.digest(bytes), size: bytes.byteLength });
				const mimeType = source.mimeType ?? mimeTypeOf(source.path);
				const resource: MCPLegacy.Resource = fileUri === uri
					// SKILL.md: the resource metadata comes from its frontmatter.
					? { uri: fileUri, name, description: frontmatter.description, mimeType }
					: { uri: fileUri, name: basename(fileUri), mimeType };
				files.set(fileUri, { uri: fileUri, mimeType, text: source.content, resource });

				// Every directory level between the skill root and the file is a directory resource.
				let directory = fileUri.slice(0, fileUri.lastIndexOf('/'));
				addToDirectory(directory, resource);
				while (directory !== root) {
					const child: MCPLegacy.Resource = { uri: directory, name: basename(directory), mimeType: McpSkills.DIRECTORY_MIME_TYPE };
					directory = directory.slice(0, directory.lastIndexOf('/'));
					addToDirectory(directory, child);
				}
			}
			entries.push({ uri, frontmatter, resources: manifest });
		}
		return new McpSkillCatalog(entries, files, directories);
	}

	private constructor(
		/** The entries, in definition order. */
		public readonly entries: readonly McpSkills.Skill[],
		private readonly _files: ReadonlyMap<string, IStoredFile>,
		private readonly _directories: ReadonlyMap<string, ReadonlyMap<string, MCPLegacy.Resource>>,
	) { }

	/** Every file of every skill as a resource; `SKILL.md` carries the skill's name and description. */
	public resources(): MCPLegacy.Resource[] {
		return [...this._files.values()].map(file => file.resource);
	}

	public getSkill(uri: string): McpSkills.Skill | undefined {
		return this.entries.find(entry => entry.uri === uri);
	}

	/** The `resources/read` result of a skill file; undefined when the catalog has no such file. */
	public read(uri: string): MCPLegacy.ReadResourceResult | undefined {
		const file = this._files.get(uri);
		return file ? { contents: [{ uri, mimeType: file.mimeType, text: file.text }] } : undefined;
	}

	/** The direct children of a directory resource; undefined when the URI is not a directory. */
	public readDirectory(uri: string): MCPLegacy.Resource[] | undefined {
		const children = this._directories.get(uri);
		return children ? [...children.values()] : undefined;
	}
}
