/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The throw-away certificate authority of the grpcs:// tests, generated with openssl at run time
// (nothing of it is in the repository): `ca.pem` (what mcp.json's `tls.ca` points at), and the
// server certificate `server.pem` (CN localhost, SAN DNS:localhost, IP:127.0.0.1, IP:::1) with
// its key `server-key.pem`, which runner/grpc-log-proxy.ts serves. Valid for two days.
//
// Usage: node runner/test-ca.ts <dir>   (creates the files unless they exist; prints the paths)

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ITestCa {
	readonly dir: string;
	/** The CA certificate (PEM): `tls.ca` of the grpcs:// servers. */
	readonly caCert: string;
	/** The server certificate (PEM, leaf only) and its key: the TLS front end of the proxy. */
	readonly serverCert: string;
	readonly serverKey: string;
}

export function testCaPaths(dir: string): ITestCa {
	return {
		dir,
		caCert: path.join(dir, 'ca.pem'),
		serverCert: path.join(dir, 'server.pem'),
		serverKey: path.join(dir, 'server-key.pem'),
	};
}

function openssl(args: readonly string[], cwd: string): void {
	execFileSync(process.env.MCP_E2E_OPENSSL ?? 'openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Creates the CA and the server certificate in `dir` unless all three files are there. */
export function ensureTestCa(dir: string): ITestCa {
	const paths = testCaPaths(dir);
	if ([paths.caCert, paths.serverCert, paths.serverKey].every(f => fs.existsSync(f))) {
		return paths;
	}
	fs.mkdirSync(dir, { recursive: true });
	const caKey = path.join(dir, 'ca-key.pem');
	const csr = path.join(dir, 'server.csr');
	const ext = path.join(dir, 'server.ext');
	const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
	openssl(['req', '-x509', ...ec, '-keyout', caKey, '-out', paths.caCert, '-days', '2', '-subj', '/CN=MCP E2E throw-away test CA',
		'-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], dir);
	openssl(['req', ...ec, '-keyout', paths.serverKey, '-out', csr, '-subj', '/CN=localhost'], dir);
	fs.writeFileSync(ext, [
		'basicConstraints=critical,CA:FALSE',
		'keyUsage=critical,digitalSignature',
		'extendedKeyUsage=serverAuth',
		'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
		'',
	].join('\n'));
	openssl(['x509', '-req', '-in', csr, '-CA', paths.caCert, '-CAkey', caKey, '-set_serial', String(Date.now()), '-days', '2', '-sha256', '-extfile', ext, '-out', paths.serverCert], dir);
	// The CA key is not needed any more: nothing else can be signed with this CA.
	for (const f of [caKey, csr, ext]) {
		fs.rmSync(f, { force: true });
	}
	return paths;
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir) {
		console.error('usage: test-ca.ts <dir>');
		process.exitCode = 2;
	} else {
		console.log(JSON.stringify(ensureTestCa(path.resolve(dir)), null, '\t'));
	}
}
