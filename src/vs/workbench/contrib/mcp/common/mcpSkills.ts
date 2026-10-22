/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { McpSkills } from '../../../../platform/mcp/common/modelContextProtocolSkills.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';

/**
 * The host side of the Skills extension (`io.modelcontextprotocol/skills`,
 * SEP-2640): loading a skill from its entry and reading its files, each read
 * verified against the entry (listed, size, digest and, for `SKILL.md`, the
 * frontmatter). Nothing here reads ahead of need: a `SKILL.md` is read when
 * the skill is loaded and a supporting file when it is read.
 */

/** What the loader needs from a connection: `resources/read`. */
export interface IMcpSkillResourceReader {
	readResource(params: { uri: string }, token: CancellationToken): Promise<MCPLegacy.ReadResourceResult>;
}

/** A skill that cannot be loaded, or a file whose content must not be used. */
export class McpSkillVerificationError extends Error {
	constructor(
		public readonly problem: McpSkills.EntryProblem | McpSkills.VerifyProblem,
		public readonly detail: string,
		message: string,
	) {
		super(message);
		this.name = 'McpSkillVerificationError';
	}
}

function entryError(problem: McpSkills.EntryProblem, detail: string): McpSkillVerificationError {
	return new McpSkillVerificationError(problem, detail, localize('mcp.skills.invalidEntry', 'The skill cannot be loaded because its entry is invalid: {0}', detail));
}

function verifyError(failure: McpSkills.IVerifyFailure): McpSkillVerificationError {
	return new McpSkillVerificationError(failure.problem, failure.detail, localize('mcp.skills.verificationFailed', 'The skill file failed verification and was not used: {0}', failure.detail));
}

/**
 * A loaded skill: the window in which the host acts on it. It holds the
 * entry it was loaded from, and resolves every read of the skill's files to
 * that entry's manifest; a file the entry does not list is a verification
 * failure. To reach a file the server added later, load the skill again from
 * a refreshed entry (`skills/get`).
 */
export class McpLoadedSkill {
	/**
	 * Validates the entry, then reads and verifies its `SKILL.md`. Throws
	 * {@link McpSkillVerificationError} when the entry is invalid or the
	 * content fails verification; nothing is read for an invalid entry.
	 */
	public static async load(reader: IMcpSkillResourceReader, entry: unknown, token: CancellationToken = CancellationToken.None): Promise<McpLoadedSkill> {
		const validation = McpSkills.validateEntry(entry);
		if (!validation.ok) {
			throw entryError(validation.problem, validation.detail);
		}
		const skill = new McpLoadedSkill(reader, validation.entry);
		const bytes = await skill._read(validation.entry.uri, token);
		skill.instructions = VSBuffer.wrap(bytes).toString();
		return skill;
	}

	/** The text of the verified `SKILL.md`. */
	public instructions = '';
	/** Bytes read under this load; a dynamic skill is held to the extension's total-size limit. */
	private _bytesRead = 0;

	private constructor(
		private readonly _reader: IMcpSkillResourceReader,
		public readonly entry: McpSkills.Skill,
	) { }

	public get name(): string {
		return String(this.entry.frontmatter.name);
	}

	/** The skill's root directory (the `SKILL.md` URI without `/SKILL.md`). */
	public get root(): string {
		return McpSkills.splitSkillUri(this.entry.uri)!.root;
	}

	/**
	 * Reads a file of the skill, by URI or by a reference relative to the
	 * skill's root (`references/GUIDE.md`), verified against the held entry.
	 */
	public readFile(uriOrReference: string, token: CancellationToken = CancellationToken.None): Promise<Uint8Array> {
		const uri = uriOrReference.includes('://') ? uriOrReference : McpSkills.resolveRelative(this.entry.uri, uriOrReference);
		if (uri === undefined) {
			return Promise.reject(verifyError({ problem: McpSkills.VerifyProblem.OutsideSkill, detail: `${uriOrReference} is outside the skill ${this.entry.uri}` }));
		}
		return this._read(uri, token);
	}

	private async _read(uri: string, token: CancellationToken): Promise<Uint8Array> {
		// Refused before anything is sent: an unlisted file is a changed skill, not a read.
		const readable = McpSkills.checkReadable(this.entry, uri);
		if (readable) {
			throw verifyError(readable);
		}
		const result = await this._reader.readResource({ uri }, token);
		const contents = result.contents.find(c => c.uri === uri) ?? (result.contents.length === 1 ? result.contents[0] : undefined);
		const bytes = contents && McpSkills.contentBytes(contents);
		if (!bytes) {
			throw verifyError({ problem: McpSkills.VerifyProblem.NoContent, detail: `the server returned no content for ${uri}` });
		}
		if (this.entry.resources === McpSkills.DYNAMIC && this._bytesRead + bytes.byteLength > McpSkills.MAX_BYTES_PER_SKILL) {
			throw entryError(McpSkills.EntryProblem.TooLarge, `${this.entry.uri}: more than ${McpSkills.MAX_BYTES_PER_SKILL} bytes read`);
		}
		const failure = await McpSkills.verifyFile(this.entry, uri, bytes);
		if (failure) {
			throw verifyError(failure);
		}
		this._bytesRead += bytes.byteLength;
		return bytes;
	}
}

/**
 * Display names for a listing whose names may collide: a name shared by
 * several entries is qualified with the entries' distinguishing path
 * (`acme/billing/refunds`), never dropped. Keyed by the entry URI.
 */
export function skillDisplayNames(entries: readonly McpSkills.Skill[]): Map<string, string> {
	const byName = new Map<string, number>();
	for (const entry of entries) {
		const name = String(entry.frontmatter.name);
		byName.set(name, (byName.get(name) ?? 0) + 1);
	}
	const out = new Map<string, string>();
	for (const entry of entries) {
		const name = String(entry.frontmatter.name);
		const path = McpSkills.splitSkillUri(entry.uri)?.root;
		const qualified = path ? path.slice(path.indexOf('://') + 3) : entry.uri;
		out.set(entry.uri, (byName.get(name) ?? 0) > 1 ? qualified : name);
	}
	return out;
}
