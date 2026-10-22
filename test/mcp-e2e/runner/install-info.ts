/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Prints install-info.json for containers/verify-install.sh: the installed package, the product
// metadata and what the smoke test of the running workbench reported.
//
// Usage: node runner/install-info.ts --product <product.json> --deb <file> --app <name> --smoke <json>
//        [--launch-exit <code>] [--apt-seconds <n>] [--launch-seconds <n>] [--total-seconds <n>]

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function arg(name: string): string {
	const i = process.argv.indexOf(name);
	if (i === -1 || i + 1 >= process.argv.length) {
		throw new Error(`missing ${name}`);
	}
	return process.argv[i + 1];
}

function optionalNumber(name: string): number | undefined {
	const i = process.argv.indexOf(name);
	return i !== -1 && i + 1 < process.argv.length ? Number(process.argv[i + 1]) : undefined;
}

const productJson = arg('--product');
const deb = arg('--deb');
const app = arg('--app');
const product = JSON.parse(fs.readFileSync(productJson, 'utf8')) as { applicationName: string; nameLong: string; commit: string; date: string };
const appPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(productJson), 'package.json'), 'utf8')) as { version: string };
const smoke: unknown = JSON.parse(fs.readFileSync(arg('--smoke'), 'utf8'));

console.log(JSON.stringify({
	deb: path.basename(deb),
	debBytes: fs.statSync(deb).size,
	packageVersion: execFileSync('dpkg-query', ['-W', '-f=${Version}', app]).toString(),
	applicationName: product.applicationName,
	nameLong: product.nameLong,
	version: appPackage.version,
	commit: product.commit,
	date: product.date,
	versionOutput: execFileSync(app, ['--no-sandbox', '--user-data-dir', '/tmp/u', '--version'], { env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } }).toString().trim().split('\n'),
	smoke,
	launchExitCode: optionalNumber('--launch-exit'),
	seconds: { aptInstall: optionalNumber('--apt-seconds'), workbenchLaunch: optionalNumber('--launch-seconds'), total: optionalNumber('--total-seconds') },
}, null, 2));
