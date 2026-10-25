/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthorizationServerMetadata } from './oauth.js';
import { base64UrlEncode, generateSigningKeyPair, IJwsSigningKey, importPrivateJwk, jwkThumbprint, JwsAlgorithm, publicJwkOf, sha256Base64Url, signJwt } from './oauthJose.js';

/**
 * OAuth 2.0 Demonstrating Proof of Possession (DPoP, RFC 9449) for the DPoP
 * extension of MCP (`io.modelcontextprotocol/auth/dpop`): access tokens bound
 * to a key pair of the client, which signs a fresh proof for every request
 * that carries one, and for every token request.
 */

/** The identifier of the extension (the one the MCP conformance suite uses). */
export const DPOP_EXTENSION_ID = 'io.modelcontextprotocol/auth/dpop';
/** The request header that carries a proof (RFC 9449 section 4.1). */
export const DPOP_HEADER = 'DPoP';
/** The response header that carries a server-supplied nonce (RFC 9449 sections 8 and 9). */
export const DPOP_NONCE_HEADER = 'DPoP-Nonce';
/** The `token_type` of a DPoP-bound access token and the scheme it is presented with (RFC 9449 sections 5 and 7.1). */
export const DPOP_SCHEME = 'DPoP';
/** The `typ` of a proof JWT (RFC 9449 section 4.2). */
export const DPOP_PROOF_TYPE = 'dpop+jwt';
/** The error with which a server asks for a proof that carries its nonce (RFC 9449 sections 8 and 9). */
export const USE_DPOP_NONCE_ERROR = 'use_dpop_nonce';
/** The algorithm of the proofs VS Code signs. */
export const DPOP_ALGORITHM: JwsAlgorithm = 'ES256';

/** Signs the DPoP proofs of one key pair and keeps the nonces servers supplied. */
export interface IOAuthDpopProver {
	readonly algorithm: JwsAlgorithm;
	/** The JWK SHA-256 thumbprint of the public key (RFC 7638): the `cnf.jkt` of the tokens bound to it, and the `dpop_jkt` of authorization requests (RFC 9449 section 10). */
	readonly thumbprint: string;
	/**
	 * A fresh proof (a new `jti`) for a request with this method to this URL;
	 * `accessToken` is the DPoP-bound token the request presents, whose hash
	 * goes into `ath` (RFC 9449 section 4.2). The proof carries the last nonce
	 * the origin of `url` supplied.
	 */
	createProof(method: string, url: string, accessToken?: string): Promise<string>;
	/** Keeps a nonce that a response from the origin of `url` supplied in `DPoP-Nonce`; an invalid value is ignored. */
	rememberNonce(url: string, nonce: string): void;
}

/**
 * The `htu` of a proof: the target URI of the request without its query and
 * fragment (RFC 9449 section 4.2).
 */
export function dpopTargetUri(url: string): string {
	const parsed = new URL(url);
	parsed.search = '';
	parsed.hash = '';
	return parsed.toString();
}

/** A nonce is a non-empty string of `NQCHAR`s (RFC 9449 section 8.1: `%x21 / %x23-5B / %x5D-7E`). */
export function isValidDpopNonce(nonce: string): boolean {
	return /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(nonce);
}

/**
 * Whether the authorization server accepts proofs of `algorithm`: it lists the
 * algorithm in `dpop_signing_alg_values_supported` (RFC 9449 section 5.1),
 * which the extension requires of a server that supports DPoP. VS Code asks
 * for DPoP-bound tokens only then; another server gets no proof and issues a
 * bearer token.
 */
export function authorizationServerSupportsDpop(metadata: Pick<IAuthorizationServerMetadata, 'dpop_signing_alg_values_supported'>, algorithm: JwsAlgorithm = DPOP_ALGORITHM): boolean {
	return Array.isArray(metadata.dpop_signing_alg_values_supported) && metadata.dpop_signing_alg_values_supported.includes(algorithm);
}

/** Whether a `token_type` names a DPoP-bound token (the type is case-insensitive, RFC 6749 section 5.1). */
export function isDpopTokenType(tokenType: unknown): boolean {
	return typeof tokenType === 'string' && tokenType.toLowerCase() === DPOP_SCHEME.toLowerCase();
}

/**
 * The DPoP key VS Code stored with a token (`dpop_jwk`, a private JWK) when the token is
 * DPoP-bound (its `token_type` is `DPoP`); `undefined` for a bearer token.
 */
export function storedDpopKey(token: { readonly token_type?: unknown; readonly dpop_jwk?: unknown }): JsonWebKey | undefined {
	return isDpopTokenType(token.token_type) && typeof token.dpop_jwk === 'object' && token.dpop_jwk !== null ? token.dpop_jwk as JsonWebKey : undefined;
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/** An ES256 {@link IOAuthDpopProver}; its private key is never extractable from the WebCrypto key it signs with. */
export class OAuthDpopProver implements IOAuthDpopProver {

	/** A prover with a new key pair; {@link privateJwk} is what a caller stores to use the key again. */
	static async generate(options?: { readonly now?: () => number }): Promise<OAuthDpopProver> {
		const { key, privateJwk, publicJwk } = await generateSigningKeyPair();
		return new OAuthDpopProver(key, publicJwk, await jwkThumbprint(publicJwk), privateJwk, options?.now);
	}

	/** A prover for a stored private JWK of {@link generate}. */
	static async fromPrivateJwk(privateJwk: JsonWebKey, options?: { readonly now?: () => number }): Promise<OAuthDpopProver> {
		const publicJwk = publicJwkOf(privateJwk);
		const key = await importPrivateJwk(privateJwk, DPOP_ALGORITHM);
		return new OAuthDpopProver(key, publicJwk, await jwkThumbprint(publicJwk), privateJwk, options?.now);
	}

	/** The last nonce of each origin. */
	private readonly nonces = new Map<string, string>();

	private constructor(
		private readonly key: IJwsSigningKey,
		private readonly publicJwk: JsonWebKey,
		readonly thumbprint: string,
		/** The private key as a JWK, to store with the tokens bound to it. */
		readonly privateJwk: JsonWebKey,
		private readonly now: () => number = () => Date.now(),
	) { }

	get algorithm(): JwsAlgorithm {
		return this.key.algorithm;
	}

	async createProof(method: string, url: string, accessToken?: string): Promise<string> {
		const claims: Record<string, unknown> = {
			jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
			htm: method.toUpperCase(),
			htu: dpopTargetUri(url),
			iat: Math.floor(this.now() / 1000),
		};
		const origin = originOf(url);
		const nonce = origin !== undefined ? this.nonces.get(origin) : undefined;
		if (nonce !== undefined) {
			claims.nonce = nonce;
		}
		if (accessToken !== undefined) {
			claims.ath = await sha256Base64Url(accessToken);
		}
		return signJwt(this.key, { typ: DPOP_PROOF_TYPE, jwk: this.publicJwk }, claims);
	}

	rememberNonce(url: string, nonce: string): void {
		const origin = originOf(url);
		if (origin !== undefined && isValidDpopNonce(nonce)) {
			this.nonces.set(origin, nonce);
		}
	}
}
