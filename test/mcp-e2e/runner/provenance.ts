/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What a run tests, for <run dir>/provenance.json (runner/summarize.ts prints it): the installed
// package and commit, the build-info.json of the build that produced it (when it is that package),
// a content hash of test/mcp-e2e as the container saw it, the mutations of the run, and what this
// build is expected to support (its tests must not skip; see MCP_E2E_EXPECT_* in run-suite.sh).
//
// Usage: node runner/provenance.ts --product <product.json> --deb <file> --suite <test/mcp-e2e dir>
//        [--build-info <build-info.json>] [--clone <git clone of the product>]

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The last commit without the gateway's gRPC listener and the round-U gRPC changes (the m8 package). */
export const LAST_COMMIT_WITHOUT_GATEWAY_GRPC = '6201d830320f2cb4d704087c81b331580fb5d640';
/** Folders of test/mcp-e2e that are build output or installed dependencies, not the suite. */
const EXCLUDED_DIRS = new Set(['node_modules', 'out']);

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

/** SHA-256 over every file of the suite (sorted relative paths, each path and its bytes); line endings are kept as they are. */
export function suiteHash(root: string): { sha256: string; files: number } {
	const files = listFiles(root).sort();
	const hash = crypto.createHash('sha256');
	for (const rel of files) {
		hash.update(rel);
		hash.update('\0');
		hash.update(fs.readFileSync(path.join(root, rel)));
		hash.update('\0');
	}
	return { sha256: hash.digest('hex'), files: files.length };
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
	const suite = argValue(args, '--suite');
	if (!productFile || !deb || !suite) {
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
	const old = isAncestorOrSame(argValue(args, '--clone'), commit, LAST_COMMIT_WITHOUT_GATEWAY_GRPC);
	const mutations = (process.env.MCP_E2E_MUTATIONS ?? '').split(',').map(s => s.trim()).filter(Boolean);
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
		suite: suiteHash(suite),
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
