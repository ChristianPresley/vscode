/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from './buffer.js';

/**
 * The JOSE pieces of VS Code's OAuth clients, on WebCrypto (`crypto.subtle`,
 * which browsers, Node and the extension host have): the compact serialization
 * of signed JWTs (RFC 7515, RFC 7519), public JWKs and their SHA-256
 * thumbprints (RFC 7517, RFC 7638), and the import of private keys. The
 * `private_key_jwt` client authentication (RFC 7523 section 2.2) and the DPoP
 * proofs (RFC 9449, `oauthDpop.ts`) are built on them.
 */

/** The asymmetric JWS algorithms the clients sign with (RFC 7518 section 3.1). */
export type JwsAlgorithm = 'ES256' | 'ES384' | 'RS256' | 'PS256';

export const JWS_ALGORITHMS: readonly JwsAlgorithm[] = ['ES256', 'ES384', 'RS256', 'PS256'];

export function isJwsAlgorithm(value: unknown): value is JwsAlgorithm {
	return typeof value === 'string' && (JWS_ALGORITHMS as readonly string[]).includes(value);
}

/** A private key and the algorithm it signs with. */
export interface IJwsSigningKey {
	readonly algorithm: JwsAlgorithm;
	readonly privateKey: CryptoKey;
}

interface IAlgorithmParams {
	readonly importParams: EcKeyImportParams | RsaHashedImportParams;
	readonly signParams: EcdsaParams | RsaPssParams | Algorithm;
}

function algorithmParams(algorithm: JwsAlgorithm): IAlgorithmParams {
	switch (algorithm) {
		case 'ES256': return { importParams: { name: 'ECDSA', namedCurve: 'P-256' }, signParams: { name: 'ECDSA', hash: 'SHA-256' } };
		case 'ES384': return { importParams: { name: 'ECDSA', namedCurve: 'P-384' }, signParams: { name: 'ECDSA', hash: 'SHA-384' } };
		case 'RS256': return { importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, signParams: { name: 'RSASSA-PKCS1-v1_5' } };
		case 'PS256': return { importParams: { name: 'RSA-PSS', hash: 'SHA-256' }, signParams: { name: 'RSA-PSS', saltLength: 32 } };
	}
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/** Base64url without padding (RFC 7515 section 2). */
export function base64UrlEncode(bytes: Uint8Array): string {
	return encodeBase64(VSBuffer.wrap(bytes), false, true);
}

function base64UrlJson(value: unknown): string {
	return base64UrlEncode(utf8(JSON.stringify(value)));
}

/**
 * Signs a JWT in the compact serialization. The header gets the key's `alg`;
 * an ECDSA signature is WebCrypto's IEEE P1363 form (R || S), which is the JWS
 * form (RFC 7518 section 3.4).
 */
export async function signJwt(key: IJwsSigningKey, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
	const signingInput = `${base64UrlJson({ ...header, alg: key.algorithm })}.${base64UrlJson(claims)}`;
	const signature = await crypto.subtle.sign(algorithmParams(key.algorithm).signParams, key.privateKey, utf8(signingInput));
	return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The base64url SHA-256 digest of a string's UTF-8 bytes: the DPoP `ath` of an access token (RFC 9449 section 4.2). */
export async function sha256Base64Url(text: string): Promise<string> {
	return base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text))));
}

const PKCS8_PEM = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s\\n]+)-----END PRIVATE KEY-----/;

/**
 * Imports a PKCS #8 private key (`-----BEGIN PRIVATE KEY-----`) for `algorithm`.
 * Line breaks inside the base64 body may be missing or written as `\n` (a key
 * pasted on one line). A SEC 1 (`EC PRIVATE KEY`), PKCS #1 (`RSA PRIVATE KEY`)
 * or encrypted key is refused with how to convert it.
 */
export async function importPkcs8PrivateKey(pem: string, algorithm: JwsAlgorithm): Promise<IJwsSigningKey> {
	const match = PKCS8_PEM.exec(pem);
	if (!match) {
		const kind = /-----BEGIN ([A-Z ]+)-----/.exec(pem)?.[1];
		throw new Error(kind
			? `The private key is a '${kind}' PEM; a PKCS #8 'PRIVATE KEY' is required (convert it with: openssl pkcs8 -topk8 -nocrypt -in key.pem)`
			: 'The private key is not a PEM-encoded PKCS #8 private key');
	}
	const body = match[1].replace(/\\n/g, '').replace(/\s+/g, '');
	const der = decodeBase64(body).buffer;
	const privateKey = await crypto.subtle.importKey('pkcs8', der as Uint8Array<ArrayBuffer>, algorithmParams(algorithm).importParams, false, ['sign']);
	return { algorithm, privateKey };
}

/** Imports a private JWK, for example one {@link generateSigningKeyPair} exported and VS Code stored. */
export async function importPrivateJwk(jwk: JsonWebKey, algorithm: JwsAlgorithm): Promise<IJwsSigningKey> {
	const privateKey = await crypto.subtle.importKey('jwk', jwk, algorithmParams(algorithm).importParams, false, ['sign']);
	return { algorithm, privateKey };
}

/** A new ES256 key pair: the signing key, its private JWK (for storage) and its public JWK. */
export async function generateSigningKeyPair(): Promise<{ readonly key: IJwsSigningKey; readonly privateJwk: JsonWebKey; readonly publicJwk: JsonWebKey }> {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
	// The private key is re-imported without extraction; the JWK is what VS Code stores.
	const key = await importPrivateJwk(privateJwk, 'ES256');
	return { key, privateJwk, publicJwk: publicJwkOf(privateJwk) };
}

/** The members of a JWK that the public key consists of, by key type; private members are dropped. */
const PUBLIC_MEMBERS: Readonly<Record<string, readonly (keyof JsonWebKey)[]>> = {
	EC: ['crv', 'kty', 'x', 'y'],
	RSA: ['e', 'kty', 'n'],
	OKP: ['crv', 'kty', 'x'],
};

/**
 * The public JWK of a (private or public) JWK: exactly the members RFC 7638
 * section 3.2 requires for its thumbprint, so it never carries a private one.
 */
export function publicJwkOf(jwk: JsonWebKey): JsonWebKey {
	const members = jwk.kty ? PUBLIC_MEMBERS[jwk.kty] : undefined;
	if (!members) {
		throw new Error(`Unsupported JWK key type '${jwk.kty}'`);
	}
	const result: Record<string, unknown> = {};
	for (const member of members) {
		if (typeof jwk[member] !== 'string') {
			throw new Error(`The JWK lacks its '${member}' member`);
		}
		result[member] = jwk[member];
	}
	return result as JsonWebKey;
}

/**
 * The JWK SHA-256 thumbprint (RFC 7638) in base64url: the digest of the
 * required public members in lexicographic order, without whitespace. It is
 * the `jkt` of a DPoP-bound token's `cnf` claim (RFC 9449 section 6).
 */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
	// `publicJwkOf` builds the object with the members in lexicographic order.
	return sha256Base64Url(JSON.stringify(publicJwkOf(jwk)));
}
