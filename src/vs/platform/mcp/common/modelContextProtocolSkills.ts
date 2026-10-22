/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { parse as parseYaml, YamlNode, YamlParseError } from '../../../base/common/yaml.js';
import { MCP } from './modelContextProtocol.js';

/**
 * The Skills extension of MCP (`io.modelcontextprotocol/skills`, SEP-2640).
 *
 * A skill is a directory of files with a `SKILL.md` at its root (the Agent
 * Skills format); the server serves each file as an ordinary resource. The
 * extension adds `skills/list` and `skills/get`, which return a skill's
 * entry (its verbatim frontmatter and the `{uri, digest, size}` manifest of
 * its files), and `resources/directory/read`, gated behind the
 * `directoryRead` setting. Only the server declares the extension; there is no
 * client declaration.
 *
 * The host rules live here too, so the client and the gateway apply the same
 * ones: an entry is validated before a skill is loaded, and every file a host
 * reads under an entry is verified against it (listed, size, SHA-256 digest
 * and, for `SKILL.md`, the frontmatter field by field).
 *
 * These shapes are hand-maintained from the extension specification; the core
 * schema in `modelContextProtocol.ts` does not contain them.
 */
export namespace McpSkills {
	/** The extension id used in the server's `capabilities.extensions`. */
	export const EXTENSION_ID = 'io.modelcontextprotocol/skills';

	export const METHOD_LIST = 'skills/list';
	export const METHOD_GET = 'skills/get';
	export const METHOD_DIRECTORY_READ = 'resources/directory/read';

	/** The MIME type of a directory resource. */
	export const DIRECTORY_MIME_TYPE = 'inode/directory';
	export const SKILL_MD = 'SKILL.md';
	export const SKILL_MD_MIME_TYPE = 'text/markdown';
	/** The scheme the extension recommends; no scheme is privileged. */
	export const DEFAULT_SCHEME = 'skill';
	/** The `resources` marker of a skill whose content is generated and has no digests. */
	export const DYNAMIC = 'dynamic';

	/** The most files one skill may have (`SKILL.md` included) for every conforming host to accept it. */
	export const MAX_FILES_PER_SKILL = 512;
	/** The largest total file size of one skill every conforming host accepts, in bytes (16 MiB). */
	export const MAX_BYTES_PER_SKILL = 16 * 1024 * 1024;

	/** One file of a skill: the digest and size cover its raw bytes. */
	export interface SkillResource {
		uri: string;
		/** `sha256:` and 64 lowercase hexadecimal digits. */
		digest: string;
		size: number;
	}

	/** The entry of one skill; `skills/list` and `skills/get` return the same shape. */
	export interface Skill {
		/** The URI of the skill's `SKILL.md`. */
		uri: string;
		/** The skill's `SKILL.md` frontmatter rendered verbatim as JSON. */
		frontmatter: MCP.JSONObject;
		/** The complete file manifest, or {@link DYNAMIC}. */
		resources: SkillResource[] | typeof DYNAMIC;
	}

	export interface ListSkillsRequestParams {
		cursor?: MCP.Cursor;
	}

	export interface ListSkillsResult extends MCP.Result {
		skills: Skill[];
		nextCursor?: MCP.Cursor;
		/** Required from 2026-07-28 (SEP-2549). */
		ttlMs?: number;
		cacheScope?: 'public' | 'private';
	}

	export interface GetSkillRequestParams {
		uri: string;
	}

	export interface GetSkillResult extends MCP.Result {
		skill: Skill;
		ttlMs?: number;
		cacheScope?: 'public' | 'private';
	}

	export interface ReadDirectoryRequestParams {
		uri: string;
		cursor?: MCP.Cursor;
	}

	/** The direct children of a directory resource; subdirectories carry {@link DIRECTORY_MIME_TYPE}. */
	export interface ReadDirectoryResult extends MCP.Result {
		resources: MCP.Resource[];
		nextCursor?: MCP.Cursor;
	}

	/** The extension settings in the server capabilities. */
	export interface ServerSettings {
		directoryRead?: boolean;
	}

	function isObject(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	/** The extension settings a server declared, or undefined when it does not declare the extension. */
	export function settingsOf(capabilities: { readonly extensions?: object } | undefined): ServerSettings | undefined {
		const extensions: unknown = capabilities?.extensions;
		if (!isObject(extensions) || !Object.prototype.hasOwnProperty.call(extensions, EXTENSION_ID)) {
			return undefined;
		}
		const settings = extensions[EXTENSION_ID];
		return isObject(settings) ? { directoryRead: settings.directoryRead === true } : {};
	}

	// -- Digests and paths --------------------------------------------------

	const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
	const NAME_PATTERN = /^(?!.*--)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

	/** The digest text of raw bytes: `sha256:` and 64 lowercase hexadecimal digits. */
	export async function digest(bytes: Uint8Array): Promise<string> {
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
		let hex = '';
		for (const byte of hash) {
			hex += byte.toString(16).padStart(2, '0');
		}
		return `sha256:${hex}`;
	}

	export function isDigest(text: unknown): text is string {
		return typeof text === 'string' && DIGEST_PATTERN.test(text);
	}

	/** Whether a skill name obeys the Agent Skills naming rules (1-64 of `a-z0-9-`, no leading, trailing or doubled hyphen). */
	export function isValidName(name: string): boolean {
		return NAME_PATTERN.test(name);
	}

	export interface ISkillPath {
		/** The skill's root directory: the `SKILL.md` URI without `/SKILL.md`. */
		readonly root: string;
		/** The last segment of the root: the skill name. */
		readonly name: string;
	}

	/** Splits a `SKILL.md` URI into its root directory and name; undefined when it is not one. */
	export function splitSkillUri(uri: string): ISkillPath | undefined {
		const sep = uri.indexOf('://');
		const suffix = `/${SKILL_MD}`;
		if (sep <= 0 || !uri.endsWith(suffix)) {
			return undefined;
		}
		const root = uri.slice(0, uri.length - suffix.length);
		const path = root.slice(sep + 3);
		const name = path.slice(path.lastIndexOf('/') + 1);
		return name.length > 0 ? { root, name } : undefined;
	}

	function isCleanPath(path: string): boolean {
		return path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
	}

	/** Whether `uri` is the skill's `SKILL.md` or a file inside its root directory. */
	export function isInsideSkill(skillUri: string, uri: string): boolean {
		if (uri === skillUri) {
			return true;
		}
		const skill = splitSkillUri(skillUri);
		return !!skill && uri.startsWith(`${skill.root}/`) && isCleanPath(uri.slice(skill.root.length + 1));
	}

	/**
	 * Resolves a relative reference of a skill (`references/GUIDE.md`) against
	 * the skill's root, as a file system path would resolve; undefined when the
	 * reference is absolute or leaves the skill.
	 */
	export function resolveRelative(skillUri: string, reference: string): string | undefined {
		const skill = splitSkillUri(skillUri);
		if (!skill || reference.length === 0 || reference.startsWith('/') || reference.includes('://')) {
			return undefined;
		}
		const segments: string[] = [];
		for (const segment of reference.split('/')) {
			if (segment === '' || segment === '.') {
				continue;
			}
			if (segment === '..') {
				if (segments.length === 0) {
					return undefined;
				}
				segments.pop();
				continue;
			}
			segments.push(segment);
		}
		return segments.length > 0 ? `${skill.root}/${segments.join('/')}` : undefined;
	}

	// -- Entry validation ---------------------------------------------------

	export const enum EntryProblem {
		InvalidSkillUri = 'invalidSkillUri',
		InvalidFrontmatter = 'invalidFrontmatter',
		NameMismatch = 'nameMismatch',
		InvalidResources = 'invalidResources',
		InvalidFileEntry = 'invalidFileEntry',
		MissingSkillMd = 'missingSkillMd',
		TooManyFiles = 'tooManyFiles',
		TooLarge = 'tooLarge',
	}

	export type EntryValidation =
		| { readonly ok: true; readonly entry: Skill }
		| { readonly ok: false; readonly problem: EntryProblem; readonly detail: string };

	function invalid(problem: EntryProblem, detail: string): EntryValidation {
		return { ok: false, problem, detail };
	}

	/**
	 * Checks a received entry against the extension's rules; a host MUST NOT
	 * load an entry that fails. The limits default to the extension's, the
	 * least a conforming host accepts.
	 */
	export function validateEntry(value: unknown, maxFiles = MAX_FILES_PER_SKILL, maxBytes = MAX_BYTES_PER_SKILL): EntryValidation {
		if (!isObject(value) || typeof value.uri !== 'string') {
			return invalid(EntryProblem.InvalidSkillUri, 'the entry has no uri');
		}
		const uri = value.uri;
		const skill = splitSkillUri(uri);
		if (!skill) {
			return invalid(EntryProblem.InvalidSkillUri, `${uri} is not the URI of a SKILL.md`);
		}
		const frontmatter = value.frontmatter;
		if (!isObject(frontmatter) || typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') {
			return invalid(EntryProblem.InvalidFrontmatter, `${uri}: the frontmatter has no string name and description`);
		}
		if (frontmatter.name !== skill.name) {
			return invalid(EntryProblem.NameMismatch, `${uri}: the skill path ends in "${skill.name}", the frontmatter name is "${frontmatter.name}"`);
		}
		const resources = value.resources;
		if (resources === DYNAMIC) {
			return { ok: true, entry: { uri, frontmatter: frontmatter as MCP.JSONObject, resources } };
		}
		if (!Array.isArray(resources)) {
			return invalid(EntryProblem.InvalidResources, `${uri}: resources is neither an array nor "${DYNAMIC}"`);
		}
		if (resources.length > maxFiles) {
			return invalid(EntryProblem.TooManyFiles, `${uri}: ${resources.length} files, more than ${maxFiles}`);
		}
		const files: SkillResource[] = [];
		const seen = new Set<string>();
		let total = 0;
		for (const file of resources) {
			if (!isObject(file) || typeof file.uri !== 'string' || !isDigest(file.digest) || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) {
				return invalid(EntryProblem.InvalidFileEntry, `${uri}: a resources entry is not a {uri, digest, size} triple`);
			}
			if (!isInsideSkill(uri, file.uri) || seen.has(file.uri)) {
				return invalid(EntryProblem.InvalidFileEntry, `${uri}: ${file.uri} is outside the skill or listed twice`);
			}
			seen.add(file.uri);
			total += file.size;
			files.push({ uri: file.uri, digest: file.digest, size: file.size });
		}
		if (!seen.has(uri)) {
			return invalid(EntryProblem.MissingSkillMd, `${uri}: resources does not list the SKILL.md`);
		}
		if (total > maxBytes) {
			return invalid(EntryProblem.TooLarge, `${uri}: ${total} bytes, more than ${maxBytes}`);
		}
		return { ok: true, entry: { uri, frontmatter: frontmatter as MCP.JSONObject, resources: files } };
	}

	/** The manifest entry of a file, or undefined when the entry does not list it (or is dynamic). */
	export function findFile(entry: Skill, uri: string): SkillResource | undefined {
		return entry.resources === DYNAMIC ? undefined : entry.resources.find(file => file.uri === uri);
	}

	// -- Verification -------------------------------------------------------

	export const enum VerifyProblem {
		/** The held entry does not list the file: equivalent to a digest mismatch. */
		UnlistedFile = 'unlistedFile',
		/** The URI is outside the skill (dynamic skills). */
		OutsideSkill = 'outsideSkill',
		SizeMismatch = 'sizeMismatch',
		DigestMismatch = 'digestMismatch',
		/** The frontmatter of the read `SKILL.md` differs from the entry's. */
		FrontmatterMismatch = 'frontmatterMismatch',
		/** The read returned no content for the URI. */
		NoContent = 'noContent',
	}

	export interface IVerifyFailure {
		readonly problem: VerifyProblem;
		readonly detail: string;
	}

	/** Whether a host acting on `entry` may read `uri` at all: listed in the manifest, or inside a dynamic skill. */
	export function checkReadable(entry: Skill, uri: string): IVerifyFailure | undefined {
		if (entry.resources === DYNAMIC) {
			return isInsideSkill(entry.uri, uri) ? undefined : { problem: VerifyProblem.OutsideSkill, detail: `${uri} is outside the skill ${entry.uri}` };
		}
		return findFile(entry, uri) ? undefined : { problem: VerifyProblem.UnlistedFile, detail: `${uri} is not listed in the resources of ${entry.uri}` };
	}

	/**
	 * Verifies the raw bytes of a file a host read under the held entry: the
	 * manifest, the size, the digest and, for `SKILL.md`, the frontmatter field
	 * by field. Undefined when the content may be used.
	 */
	export async function verifyFile(entry: Skill, uri: string, bytes: Uint8Array): Promise<IVerifyFailure | undefined> {
		const readable = checkReadable(entry, uri);
		if (readable) {
			return readable;
		}
		const file = findFile(entry, uri);
		if (file) {
			if (bytes.byteLength !== file.size) {
				return { problem: VerifyProblem.SizeMismatch, detail: `${uri} has ${bytes.byteLength} bytes, the entry lists ${file.size}` };
			}
			const actual = await digest(bytes);
			if (actual !== file.digest) {
				return { problem: VerifyProblem.DigestMismatch, detail: `${uri} has the digest ${actual}, the entry lists ${file.digest}` };
			}
		}
		if (uri === entry.uri) {
			const frontmatter = parseFrontmatter(VSBuffer.wrap(bytes).toString());
			if (!frontmatter || !jsonEqual(frontmatter, entry.frontmatter)) {
				return { problem: VerifyProblem.FrontmatterMismatch, detail: `the frontmatter of ${uri} differs from the entry's` };
			}
		}
		return undefined;
	}

	/** The raw bytes of a `resources/read` content item: the UTF-8 text, or the decoded blob. */
	export function contentBytes(contents: { readonly text?: unknown; readonly blob?: unknown }): Uint8Array | undefined {
		if (typeof contents.text === 'string') {
			return VSBuffer.fromString(contents.text).buffer;
		}
		if (typeof contents.blob === 'string') {
			try {
				return decodeBase64(contents.blob).buffer;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	/** Deep equality of JSON values: object keys in any order, numbers by value. */
	export function jsonEqual(a: unknown, b: unknown): boolean {
		if (a === b) {
			return true;
		}
		if (Array.isArray(a) || Array.isArray(b)) {
			return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
		}
		if (isObject(a) && isObject(b)) {
			const keys = Object.keys(a);
			return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key]));
		}
		return false;
	}

	// -- Frontmatter --------------------------------------------------------

	const FRONTMATTER_PATTERN = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

	/** The YAML text between the leading `---` lines of a `SKILL.md`; undefined without such a block. */
	export function frontmatterText(document: string): string | undefined {
		const text = document.charCodeAt(0) === 0xFEFF ? document.slice(1) : document;
		const match = FRONTMATTER_PATTERN.exec(text);
		return match ? match[1] ?? '' : undefined;
	}

	/**
	 * Parses the YAML frontmatter of a `SKILL.md` into a JSON object, plain
	 * scalars resolved with the YAML 1.2 core schema (null, booleans, numbers),
	 * so both sides get the object a YAML library gives. Undefined when there is
	 * no frontmatter, the YAML is invalid or not a map, or a value has no JSON
	 * form (`.inf`, `.nan`).
	 */
	export function parseFrontmatter(document: string): MCP.JSONObject | undefined {
		const text = frontmatterText(document);
		if (text === undefined) {
			return undefined;
		}
		if (text.trim().length === 0) {
			return {};
		}
		const errors: YamlParseError[] = [];
		const node = parseYaml(text, errors);
		if (errors.length > 0 || !node || node.type !== 'map') {
			return undefined;
		}
		const value = yamlToJson(node);
		return isObject(value) ? value as MCP.JSONObject : undefined;
	}

	const NULL_PATTERN = /^(?:~|null|Null|NULL|)$/;
	const TRUE_PATTERN = /^(?:true|True|TRUE)$/;
	const FALSE_PATTERN = /^(?:false|False|FALSE)$/;
	const INT_PATTERN = /^[-+]?[0-9]+$/;
	const OCTAL_PATTERN = /^0o[0-7]+$/;
	const HEX_PATTERN = /^0x[0-9a-fA-F]+$/;
	const FLOAT_PATTERN = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
	const SPECIAL_FLOAT_PATTERN = /^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

	/** A sentinel for a value that has no JSON form. */
	const NO_JSON = Symbol('noJson');

	function resolvePlainScalar(raw: string): MCP.JSONValue | typeof NO_JSON {
		if (NULL_PATTERN.test(raw)) {
			return null;
		}
		if (TRUE_PATTERN.test(raw)) {
			return true;
		}
		if (FALSE_PATTERN.test(raw)) {
			return false;
		}
		if (INT_PATTERN.test(raw)) {
			return Number.parseInt(raw, 10);
		}
		if (OCTAL_PATTERN.test(raw)) {
			return Number.parseInt(raw.slice(2), 8);
		}
		if (HEX_PATTERN.test(raw)) {
			return Number.parseInt(raw.slice(2), 16);
		}
		if (FLOAT_PATTERN.test(raw)) {
			return Number.parseFloat(raw);
		}
		if (SPECIAL_FLOAT_PATTERN.test(raw)) {
			return NO_JSON;
		}
		return raw;
	}

	function yamlToJson(node: YamlNode): MCP.JSONValue | typeof NO_JSON {
		switch (node.type) {
			case 'scalar':
				return node.format === 'none' ? resolvePlainScalar(node.value) : node.value;
			case 'sequence': {
				const items: MCP.JSONValue[] = [];
				for (const item of node.items) {
					const value = yamlToJson(item);
					if (value === NO_JSON) {
						return NO_JSON;
					}
					items.push(value);
				}
				return items;
			}
			case 'map': {
				const out: MCP.JSONObject = {};
				for (const property of node.properties) {
					const value = yamlToJson(property.value);
					if (value === NO_JSON) {
						return NO_JSON;
					}
					// `__proto__` is an ordinary key in YAML; a plain assignment would replace the prototype.
					Object.defineProperty(out, property.key.value, { value, enumerable: true, writable: true, configurable: true });
				}
				return out;
			}
		}
	}
}
