/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64, encodeBase64, VSBuffer } from '../../common/buffer.js';
import { authorizationServerSupportsDpop, dpopTargetUri, isDpopTokenType, isValidDpopNonce, OAuthDpopProver, storedDpopKey } from '../../common/oauthDpop.js';
import { generateSigningKeyPair, importPkcs8PrivateKey, importPrivateJwk, jwkThumbprint, publicJwkOf, sha256Base64Url, signJwt } from '../../common/oauthJose.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

interface IDecodedJwt {
	readonly header: Record<string, unknown>;
	readonly claims: Record<string, unknown>;
}

function decodePart(part: string): Record<string, unknown> {
	return JSON.parse(decodeBase64(part).toString());
}

/** Verifies an ES256 JWS with a public JWK and decodes it. */
async function verifyEs256Jwt(jwt: string, publicJwk: JsonWebKey): Promise<IDecodedJwt> {
	const [header, claims, signature] = jwt.split('.');
	const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
	const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decodeBase64(signature).buffer as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${header}.${claims}`) as Uint8Array<ArrayBuffer>);
	assert.ok(verified, 'the JWS signature verifies');
	return { header: decodePart(header), claims: decodePart(claims) };
}

async function pkcs8Pem(params: EcKeyGenParams | RsaHashedKeyGenParams): Promise<{ readonly pem: string; readonly publicKey: CryptoKey }> {
	const pair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']) as CryptoKeyPair;
	const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	const body = encodeBase64(VSBuffer.wrap(der)).replace(/(.{64})/g, '$1\n');
	return { pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

suite('oauthJose', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('jwkThumbprint is the RFC 7638 thumbprint (the example of section 3.1)', async () => {
		const jwk: JsonWebKey = {
			kty: 'RSA',
			n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
			e: 'AQAB',
			alg: 'RS256',
		};
		assert.strictEqual(await jwkThumbprint(jwk), 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
	});

	test('publicJwkOf keeps exactly the required public members, never a private one', async () => {
		const { privateJwk, publicJwk } = await generateSigningKeyPair();
		assert.ok(privateJwk.d, 'the private JWK has its private member');
		assert.deepStrictEqual(Object.keys(publicJwk), ['crv', 'kty', 'x', 'y']);
		assert.deepStrictEqual(publicJwkOf({ ...privateJwk, alg: 'ES256', key_ops: ['sign'] }), publicJwk);
		assert.throws(() => publicJwkOf({ kty: 'oct', k: 'secret' }), /Unsupported JWK key type 'oct'/);
		assert.throws(() => publicJwkOf({ kty: 'EC', crv: 'P-256', x: 'x' }), /lacks its 'y' member/);
	});

	test('signJwt signs the compact serialization with the key\'s algorithm, and the signature verifies', async () => {
		const { key, privateJwk, publicJwk } = await generateSigningKeyPair();
		const jwt = await signJwt(key, { typ: 'JWT', alg: 'none' }, { sub: 'me', n: 1 });
		const { header, claims } = await verifyEs256Jwt(jwt, publicJwk);
		assert.deepStrictEqual({ header, claims }, { header: { typ: 'JWT', alg: 'ES256' }, claims: { sub: 'me', n: 1 } });
		assert.ok(!/[+/=]/.test(jwt), 'base64url without padding');
		// A stored private JWK signs as the original key does.
		const restored = await importPrivateJwk(privateJwk, 'ES256');
		await verifyEs256Jwt(await signJwt(restored, {}, { a: 'b' }), publicJwk);
	});

	test('importPkcs8PrivateKey reads a PKCS #8 PEM, also on one line or with escaped line breaks', async () => {
		const { pem, publicKey } = await pkcs8Pem({ name: 'ECDSA', namedCurve: 'P-256' });
		const publicJwk = publicJwkOf(await crypto.subtle.exportKey('jwk', publicKey));
		for (const form of [pem, pem.replace(/\n/g, ''), pem.replace(/\n/g, '\\n')]) {
			const key = await importPkcs8PrivateKey(form, 'ES256');
			await verifyEs256Jwt(await signJwt(key, {}, { iss: 'client' }), publicJwk);
		}
	});

	test('importPkcs8PrivateKey reads an RSA key for RS256', async () => {
		const { pem, publicKey } = await pkcs8Pem({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' });
		const key = await importPkcs8PrivateKey(pem, 'RS256');
		const jwt = await signJwt(key, {}, { iss: 'client' });
		const [header, claims, signature] = jwt.split('.');
		assert.strictEqual(decodePart(header).alg, 'RS256');
		assert.ok(await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, publicKey, decodeBase64(signature).buffer as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${header}.${claims}`) as Uint8Array<ArrayBuffer>));
	});

	test('importPkcs8PrivateKey refuses another PEM type with how to convert it, and text that is no PEM', async () => {
		await assert.rejects(importPkcs8PrivateKey('-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----', 'ES256'), /'EC PRIVATE KEY' PEM; a PKCS #8 'PRIVATE KEY' is required \(convert it with: openssl pkcs8 -topk8 -nocrypt/);
		await assert.rejects(importPkcs8PrivateKey('not a key', 'ES256'), /not a PEM-encoded PKCS #8 private key/);
	});

	test('sha256Base64Url is the DPoP ath of RFC 9449 section 4.2', async () => {
		// The access token and ath of the example in RFC 9449 section 7.1.
		assert.strictEqual(await sha256Base64Url('Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU'), 'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo');
	});
});

suite('oauthDpop', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a proof has the DPoP header and claims of RFC 9449 section 4.2, and a fresh jti each time', async () => {
		const prover = await OAuthDpopProver.generate({ now: () => 1_700_000_000_123 });
		const publicJwk = publicJwkOf(prover.privateJwk);
		const first = await verifyEs256Jwt(await prover.createProof('post', 'https://mcp.example.test/mcp?session=1#frag', 'access-token'), publicJwk);
		const second = await verifyEs256Jwt(await prover.createProof('GET', 'https://mcp.example.test/mcp'), publicJwk);

		assert.deepStrictEqual(first.header, { typ: 'dpop+jwt', jwk: publicJwk, alg: 'ES256' });
		assert.strictEqual(await jwkThumbprint(first.header.jwk as JsonWebKey), prover.thumbprint);
		assert.deepStrictEqual({ ...first.claims, jti: typeof first.claims.jti }, {
			jti: 'string',
			htm: 'POST',
			htu: 'https://mcp.example.test/mcp',
			iat: 1_700_000_000,
			ath: await sha256Base64Url('access-token'),
		});
		assert.strictEqual(second.claims.ath, undefined, 'no ath without an access token');
		assert.notStrictEqual(first.claims.jti, second.claims.jti);
	});

	test('a nonce goes into the proofs to the origin that supplied it', async () => {
		const prover = await OAuthDpopProver.generate();
		const publicJwk = publicJwkOf(prover.privateJwk);
		prover.rememberNonce('https://as.example.test/token', 'nonce-1');
		prover.rememberNonce('https://as.example.test/token', 'bad"nonce');
		const nonceOf = async (url: string) => (await verifyEs256Jwt(await prover.createProof('POST', url), publicJwk)).claims.nonce;
		assert.deepStrictEqual([await nonceOf('https://as.example.test/other'), await nonceOf('https://mcp.example.test/mcp')], ['nonce-1', undefined]);
		prover.rememberNonce('https://as.example.test/', 'nonce-2');
		assert.strictEqual(await nonceOf('https://as.example.test/token'), 'nonce-2');
	});

	test('a prover restored from its private JWK has the same key', async () => {
		const prover = await OAuthDpopProver.generate();
		const restored = await OAuthDpopProver.fromPrivateJwk(prover.privateJwk);
		assert.strictEqual(restored.thumbprint, prover.thumbprint);
		await verifyEs256Jwt(await restored.createProof('POST', 'https://mcp.example.test/mcp'), publicJwkOf(prover.privateJwk));
	});

	test('the helpers: target URI, nonce syntax, metadata, token type, stored key', () => {
		assert.strictEqual(dpopTargetUri('https://Mcp.Example.test:443/a/b?c=d#e'), 'https://mcp.example.test/a/b');
		assert.deepStrictEqual(['abc', 'a b', '', 'x\\y', 'x"y', '!#[]~'].map(isValidDpopNonce), [true, false, false, false, false, true]);
		assert.deepStrictEqual([
			authorizationServerSupportsDpop({ dpop_signing_alg_values_supported: ['RS256', 'ES256'] }),
			authorizationServerSupportsDpop({ dpop_signing_alg_values_supported: ['RS256'] }),
			authorizationServerSupportsDpop({}),
		], [true, false, false]);
		assert.deepStrictEqual(['DPoP', 'dpop', 'Bearer', undefined].map(isDpopTokenType), [true, true, false, false]);
		const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' };
		assert.deepStrictEqual([
			storedDpopKey({ token_type: 'DPoP', dpop_jwk: jwk }),
			storedDpopKey({ token_type: 'Bearer', dpop_jwk: jwk }),
			storedDpopKey({ token_type: 'DPoP' }),
		], [jwk, undefined, undefined]);
	});
});
