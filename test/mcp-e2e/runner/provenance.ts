/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a run tests, for <run dir>/provenance.json (runner/summarize.ts prints it): the installed
// package and commit, the build-info.json of the build that produced it (when it is that package),
// a content hash of test/mcp-e2e as the container saw it and the same hash of test/mcp-e2e as
// committed at the installed commit (so a run on an uncommitted suite shows), the mutations of the
// run, and what this build is expected to support (its tests must not skip; see MCP_E2E_EXPECT_*
// in run-suite.sh).
//
// Usage: node runner/provenance.ts --product <product.json> --deb <file> --suite <test/mcp-e2e dir>
//        [--build-info <build-info.json>] [--clone <git clone of the product>]
// Environment (set by run-e2e.ps1 from the checkout the suite is mounted from): E2E_SUITE_HEAD (its
// HEAD commit), E2E_SUITE_DIRTY (1 when test/mcp-e2e has uncommitted changes there).

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The last commit without the gateway's gRPC listener and the round-U gRPC changes (the m8 package). */
export const LAST_COMMIT_WITHOUT_GATEWAY_GRPC = '6201d830320f2cb4d704087c81b331580fb5d640';
/** Folders of test/mcp-e2e that are build output or installed dependencies, not the suite. */
const EXCLUDED_DIRS = new Set(['node_modules', 'out']);
/** Where the suite lives in the repository. */
const SUITE_PATH = 'test/mcp-e2e';

function argValue(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

function listFiles(root: string, dir = ''): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (!EXCLUDED_DIRS.has(entry.name)) {
				out.push(...listFiles(root, rel));
			}
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

/**
 * The bytes with every CRLF turned into LF. A Windows checkout has CRLF in the working tree where
 * the git blobs have LF (`* text=auto`), so the hash must not depend on the line endings.
 */
export function withLfLineEndings(bytes: Buffer): Buffer {
	if (!bytes.includes(0x0d)) {
		return bytes;
	}
	const out = Buffer.alloc(bytes.length);
	let n = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 0x0d || bytes[i + 1] !== 0x0a) {
			out[n++] = bytes[i];
		}
	}
	return out.subarray(0, n);
}

/** SHA-256 over the files (sorted relative paths, each path and its bytes with LF line endings). */
function hashFiles(files: readonly string[], read: (rel: string) => Buffer): { sha256: string; files: number } {
	const sorted = [...files].sort();
	const hash = crypto.createHash('sha256');
	for (const rel of sorted) {
		hash.update(rel);
		hash.update('\0');
		hash.update(withLfLineEndings(read(rel)));
		hash.update('\0');
	}
	return { sha256: hash.digest('hex'), files: sorted.length };
}

/** The content hash of the suite folder (every file except `node_modules` and `out`), independent of line endings. */
export function suiteHash(root: string): { sha256: string; files: number } {
	return hashFiles(listFiles(root), rel => fs.readFileSync(path.join(root, rel)));
}

/** The suite as committed: its hash, or why there is none. */
export interface ICommittedSuite {
	readonly commit: string;
	readonly sha256: string | undefined;
	readonly files: number;
	readonly error?: string;
}

/**
 * The same hash over the git blobs of test/mcp-e2e at `commit` in the clone: equal to
 * {@link suiteHash} exactly when the mounted suite is the committed one. Without a hash (and with
 * the reason) when the clone cannot tell: no clone, or it does not have the commit.
 */
export function committedSuiteHash(clone: string | undefined, commit: string): ICommittedSuite {
	const failed = (error: string): ICommittedSuite => ({ commit, sha256: undefined, files: 0, error });
	if (!clone || !commit) {
		return failed('no clone of the product or no installed commit');
	}
	const git = (args: readonly string[]) => execFileSync('git', ['-c', 'safe.directory=*', '-C', clone, ...args], { maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
	let listing: string;
	try {
		listing = git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', SUITE_PATH]).toString('utf8');
	} catch (e) {
		return failed(`git ls-tree ${commit.slice(0, 11)} failed: ${String((e as { stderr?: Buffer }).stderr ?? e).trim().split('\n')[0]}`);
	}
	const blobs = new Map<string, string>();
	for (const entry of listing.split('\0').filter(Boolean)) {
		// <mode> <type> <object>\t<path>; symbolic links (120000) and submodules are not files of the suite.
		const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(entry);
		if (!match || match[2] !== 'blob' || match[1] === '120000') {
			continue;
		}
		const rel = match[4].slice(SUITE_PATH.length + 1);
		if (rel.split('/').slice(0, -1).some(dir => EXCLUDED_DIRS.has(dir))) {
			continue;
		}
		blobs.set(rel, match[3]);
	}
	if (!blobs.size) {
		return failed(`${SUITE_PATH} is not in commit ${commit.slice(0, 11)}`);
	}
	return { commit, ...hashFiles([...blobs.keys()], rel => git(['cat-file', 'blob', blobs.get(rel)!])) };
}

function fileSha256(file: string): string {
	const hash = crypto.createHash('sha256');
	const fd = fs.openSync(file, 'r');
	try {
		const buffer = Buffer.alloc(1 << 20);
		for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
			hash.update(buffer.subarray(0, n));
		}
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest('hex');
}

/** Whether `commit` is `ancestor` or one of its ancestors in the clone; `undefined` when git cannot tell. */
function isAncestorOrSame(clone: string | undefined, commit: string, ancestor: string): boolean | undefined {
	if (!clone || !commit) {
		return undefined;
	}
	try {
		execFileSync('git', ['-c', 'safe.directory=*', '-C', clone, 'merge-base', '--is-ancestor', commit, ancestor], { stdio: 'ignore' });
		return true;
	} catch (e) {
		const status = (e as { status?: number }).status;
		return status === 1 ? false : undefined;
	}
}

function main(args: readonly string[]): void {
	const productFile = argValue(args, '--product');
	const deb = argValue(args, '--deb');
	const suiteDir = argValue(args, '--suite');
	if (!productFile || !deb || !suiteDir) {
		console.error('usage: provenance.ts --product <product.json> --deb <file> --suite <dir> [--build-info <file>] [--clone <dir>]');
		process.exitCode = 2;
		return;
	}
	const product = JSON.parse(fs.readFileSync(productFile, 'utf8')) as { commit?: string; date?: string; nameLong?: string; applicationName?: string };
	const appPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(productFile), 'package.json'), 'utf8')) as { version?: string };
	const buildInfoFile = argValue(args, '--build-info');
	let buildInfo: Record<string, unknown> | undefined;
	if (buildInfoFile && fs.existsSync(buildInfoFile)) {
		const parsed = JSON.parse(fs.readFileSync(buildInfoFile, 'utf8')) as Record<string, unknown>;
		// Only the build that produced this very package.
		buildInfo = parsed.deb === path.basename(deb) ? parsed : undefined;
	}
	const commit = product.commit ?? '';
	const clone = argValue(args, '--clone');
	const old = isAncestorOrSame(clone, commit, LAST_COMMIT_WITHOUT_GATEWAY_GRPC);
	const mutations = (process.env.MCP_E2E_MUTATIONS ?? '').split(',').map(s => s.trim()).filter(Boolean);
	const suite = suiteHash(suiteDir);
	const committedSuite = committedSuiteHash(clone, commit);
	// The checkout the suite was mounted from (run-e2e.ps1): its HEAD and whether test/mcp-e2e had
	// uncommitted changes there.
	const suiteHead = process.env.E2E_SUITE_HEAD || undefined;
	const suiteDirty = process.env.E2E_SUITE_DIRTY === undefined || process.env.E2E_SUITE_DIRTY === '' ? undefined : process.env.E2E_SUITE_DIRTY === '1';
	console.log(JSON.stringify({
		commit,
		commitDate: product.date,
		version: appPackage.version,
		product: product.nameLong,
		deb: path.basename(deb),
		debPath: deb,
		debBytes: fs.statSync(deb).size,
		debSha256: fileSha256(deb),
		buildInfo,
		buildCommitMatches: buildInfo ? buildInfo.commit === commit : undefined,
		// Line endings normalized to LF in both hashes, so a Windows checkout hashes like its commit.
		suite: { ...suite, lineEndings: 'lf' },
		committedSuite,
		suiteMatchesCommit: committedSuite.sha256 === undefined ? undefined : committedSuite.sha256 === suite.sha256,
		suiteCheckout: suiteHead === undefined && suiteDirty === undefined ? undefined : { head: suiteHead, uncommittedChanges: suiteDirty },
		mutations,
		expect: {
			// A build at or before the m8 package has no gateway gRPC listener and no gateway rate
			// limits: those tests may skip there (and only there).
			gatewayGrpc: old !== true,
			gatewayRateLimits: old !== true,
			gatewayGrpcReason: old === undefined ? 'the clone does not know the commit: expected (strict)' : old ? `at or before ${LAST_COMMIT_WITHOUT_GATEWAY_GRPC.slice(0, 11)}` : `after ${LAST_COMMIT_WITHOUT_GATEWAY_GRPC.slice(0, 11)}`,
		},
	}, null, '\t'));
}

if (import.meta.main) {
	main(process.argv.slice(2));
}
