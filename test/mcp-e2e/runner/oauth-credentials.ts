/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The throw-away credentials of the OAuth machine clients (the client credentials grant with
// `private_key_jwt`), generated at run time (nothing of it is in the repository) next to the test
// CA: the ES256 key pair `client-key.pem` (PKCS#8, what mcp.json's `oauth.privateKeyFile` points
// at) and `client-key.jwk.json` (its public JWK with the key id, which runner/oauth-fixture.ts
// trusts). The fixture writes its workload identity JWTs (`oauth.workloadIdentityTokenFile`) into
// the same folder. runner/prepare-profile.ts creates them before VS Code reads mcp.json
// (`{oauthCredentials}`), runner/start-servers.ts reuses them.
//
// Usage: node runner/oauth-credentials.ts <dir>   (creates the files unless they exist; prints the paths)

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The `kid` of the client key: mcp.json's `oauth.keyId`, which the fixture checks in the assertion's header. */
export const CLIENT_KEY_ID = 'mcp-e2e-client-key';

export interface IOAuthCredentials {
	readonly dir: string;
	/** The private key (PKCS#8 PEM): `oauth.privateKeyFile` of the machine clients. */
	readonly clientKey: string;
	/** Its public JWK (with `kid`): the key the fixture verifies the client assertions with. */
	readonly clientJwk: string;
}

/** The folder of the credentials (`{oauthCredentials}`): `oauth/` in the folder of the test CA. */
export function oauthCredentialsDir(tlsDir: string): string {
	return path.join(tlsDir, 'oauth');
}

export function oauthCredentialPaths(dir: string): IOAuthCredentials {
	return { dir, clientKey: path.join(dir, 'client-key.pem'), clientJwk: path.join(dir, 'client-key.jwk.json') };
}

/** Creates the client key pair in `dir` unless both files are there. */
export function ensureOAuthCredentials(dir: string): IOAuthCredentials {
	const paths = oauthCredentialPaths(dir);
	if (fs.existsSync(paths.clientKey) && fs.existsSync(paths.clientJwk)) {
		return paths;
	}
	fs.mkdirSync(dir, { recursive: true });
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	fs.writeFileSync(paths.clientKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
	fs.writeFileSync(paths.clientJwk, JSON.stringify({ ...publicKey.export({ format: 'jwk' }), kid: CLIENT_KEY_ID, alg: 'ES256', use: 'sig' }, null, '\t'));
	return paths;
}

if (import.meta.main) {
	const dir = process.argv[2];
	if (!dir) {
		console.error('usage: oauth-credentials.ts <dir>');
		process.exitCode = 2;
	} else {
		console.log(JSON.stringify(ensureOAuthCredentials(path.resolve(dir)), null, '\t'));
	}
}
