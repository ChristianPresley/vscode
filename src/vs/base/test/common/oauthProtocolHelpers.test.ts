/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeBase64 } from '../../common/buffer.js';
import { buildClientAuthentication, canonicalResourceUri, createPkcePair, fetchAuthorizationServerMetadata, fetchDynamicRegistration, IAuthorizationServerMetadata, isLoopbackUrl, issuerMatches, isValidClientMetadataUrl, OAuthClientError, OAuthIssuerMismatchError, parseAuthorizationRedirect, pkceSupported, selectRegistrationAuthMethod, selectTokenEndpointAuthMethod, validateIssuerParameter } from '../../common/oauth.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('OAuth - 2026-07-28 protocol helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('token endpoint authentication', () => {
		test('selectRegistrationAuthMethod prefers none, then basic, then post', () => {
			assert.strictEqual(selectRegistrationAuthMethod(undefined), 'none');
			assert.strictEqual(selectRegistrationAuthMethod([]), 'none');
			assert.strictEqual(selectRegistrationAuthMethod(['client_secret_basic', 'none']), 'none');
			assert.strictEqual(selectRegistrationAuthMethod(['client_secret_post', 'client_secret_basic']), 'client_secret_basic');
			assert.strictEqual(selectRegistrationAuthMethod(['client_secret_post']), 'client_secret_post');
			assert.strictEqual(selectRegistrationAuthMethod(['private_key_jwt']), 'none');
		});

		test('selectTokenEndpointAuthMethod honours the registered method, else derives it from the secret', () => {
			assert.strictEqual(selectTokenEndpointAuthMethod('client_secret_post', ['client_secret_basic'], true), 'client_secret_post');
			assert.strictEqual(selectTokenEndpointAuthMethod('none', undefined, true), 'none');
			assert.strictEqual(selectTokenEndpointAuthMethod('private_key_jwt', undefined, false), 'none');
			assert.strictEqual(selectTokenEndpointAuthMethod(undefined, undefined, false), 'none');
			assert.strictEqual(selectTokenEndpointAuthMethod(undefined, undefined, true), 'client_secret_basic');
			assert.strictEqual(selectTokenEndpointAuthMethod(undefined, ['client_secret_post'], true), 'client_secret_post');
			assert.strictEqual(selectTokenEndpointAuthMethod(undefined, ['client_secret_basic', 'client_secret_post'], true), 'client_secret_basic');
		});

		test('buildClientAuthentication encodes Basic credentials per RFC 6749 section 2.3.1', () => {
			const basic = buildClientAuthentication('client_secret_basic', 'my client', 's3cr:t/+');
			const [scheme, encoded] = basic.headers.Authorization.split(' ');
			assert.strictEqual(scheme, 'Basic');
			assert.strictEqual(decodeBase64(encoded).toString(), 'my%20client:s3cr%3At%2F%2B');
			assert.deepStrictEqual(basic.body, { client_id: 'my client' });

			const post = buildClientAuthentication('client_secret_post', 'id', 'secret');
			assert.deepStrictEqual(post, { headers: {}, body: { client_id: 'id', client_secret: 'secret' } });
			assert.deepStrictEqual(buildClientAuthentication('client_secret_post', 'id'), { headers: {}, body: { client_id: 'id' } });
			assert.deepStrictEqual(buildClientAuthentication('none', 'id', 'ignored'), { headers: {}, body: { client_id: 'id' } });
		});
	});

	suite('iss validation (RFC 9207 table)', () => {
		const issuer = 'https://auth.example.com/tenant';

		test('present iss is compared by exact string equality regardless of advertisement', () => {
			assert.strictEqual(validateIssuerParameter(true, issuer, issuer), undefined);
			assert.strictEqual(validateIssuerParameter(undefined, issuer, issuer), undefined);
			assert.strictEqual(validateIssuerParameter(false, issuer, issuer), undefined);
			for (const variant of [issuer + '/', 'HTTPS://auth.example.com/tenant', 'https://AUTH.example.com/tenant', 'https://auth.example.com:443/tenant', 'https://auth.example.com/ten%61nt', 'https://evil.example.com/tenant']) {
				const error = validateIssuerParameter(undefined, variant, issuer);
				assert.ok(error instanceof OAuthClientError, variant);
				assert.strictEqual(error.code, 'iss_mismatch', variant);
			}
		});

		test('absent iss is rejected only when the server advertised support', () => {
			const missing = validateIssuerParameter(true, undefined, issuer);
			assert.ok(missing instanceof OAuthClientError);
			assert.strictEqual(missing.code, 'iss_missing');
			assert.strictEqual(validateIssuerParameter(false, undefined, issuer), undefined);
			assert.strictEqual(validateIssuerParameter(undefined, undefined, issuer), undefined);
		});

		test('parseAuthorizationRedirect form-decodes the redirect query', () => {
			assert.deepStrictEqual(parseAuthorizationRedirect('?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example.com%2F'), { code: 'abc', state: 'xyz', iss: 'https://auth.example.com/', error: undefined, errorDescription: undefined, errorUri: undefined });
			assert.deepStrictEqual(parseAuthorizationRedirect(new URLSearchParams('error=access_denied&error_description=no+thanks&state=s')), { code: undefined, state: 's', iss: undefined, error: 'access_denied', errorDescription: 'no thanks', errorUri: undefined });
		});
	});

	suite('discovery issuer validation', () => {
		const metadataFor = (issuer: string): IAuthorizationServerMetadata => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ['code'] });
		const fetchReturning = (metadata: IAuthorizationServerMetadata) => async () => ({ status: 200, statusText: 'OK', json: async () => metadata, text: async () => JSON.stringify(metadata) });

		test('issuerMatches is exact unless trailing-slash tolerance is requested', () => {
			assert.strictEqual(issuerMatches('https://a.example.com', 'https://a.example.com'), true);
			assert.strictEqual(issuerMatches('https://a.example.com/', 'https://a.example.com'), false);
			assert.strictEqual(issuerMatches('https://a.example.com/', 'https://a.example.com', 'trailing-slash'), true);
			assert.strictEqual(issuerMatches('https://a.example.com', 'https://a.example.com/', 'trailing-slash'), true);
			assert.strictEqual(issuerMatches('https://A.example.com', 'https://a.example.com', 'trailing-slash'), false);
		});

		test('fetchAuthorizationServerMetadata rejects metadata whose issuer differs from the authorization server', async () => {
			const authorizationServer = 'https://auth.example.com';
			await assert.rejects(
				fetchAuthorizationServerMetadata(authorizationServer, { fetch: fetchReturning(metadataFor('https://other.example.com')), validateIssuer: true }),
				(err: unknown) => err instanceof AggregateError && err.errors.every(e => e instanceof OAuthIssuerMismatchError && e.expectedIssuer === authorizationServer && e.actualIssuer === 'https://other.example.com'),
			);
			await assert.rejects(fetchAuthorizationServerMetadata(authorizationServer, { fetch: fetchReturning(metadataFor('https://auth.example.com/')), validateIssuer: true }), AggregateError, 'trailing slash is a mismatch under exact comparison');
			const tolerated = await fetchAuthorizationServerMetadata(authorizationServer, { fetch: fetchReturning(metadataFor('https://auth.example.com/')), validateIssuer: true, issuerTolerance: 'trailing-slash' });
			assert.strictEqual(tolerated.metadata.issuer, 'https://auth.example.com/');
			const unchecked = await fetchAuthorizationServerMetadata(authorizationServer, { fetch: fetchReturning(metadataFor('https://other.example.com')) });
			assert.strictEqual(unchecked.metadata.issuer, 'https://other.example.com', 'validation is off by default');
			const exact = await fetchAuthorizationServerMetadata(authorizationServer, { fetch: fetchReturning(metadataFor(authorizationServer)), validateIssuer: true });
			assert.strictEqual(exact.metadata.issuer, authorizationServer);
		});
	});

	suite('registration options', () => {
		test('fetchDynamicRegistration registers the requested auth method, redirect URIs and client_uri', async () => {
			let captured: { url: string; body: Record<string, unknown> } | undefined;
			const fetchImpl = (async (url: string, init: RequestInit) => {
				captured = { url, body: JSON.parse(String(init.body)) };
				return { ok: true, json: async () => ({ client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'client_secret_basic' }) } as Response;
			}) as unknown as typeof fetch;
			const response = await fetchDynamicRegistration(
				{ issuer: 'https://auth.example.com', registration_endpoint: 'https://auth.example.com/register', response_types_supported: ['code'] },
				'Test Client',
				['a', 'b'],
				{ tokenEndpointAuthMethod: 'client_secret_basic', redirectUris: ['http://127.0.0.1:33418/'], clientUri: 'https://conformance-test.local', fetch: fetchImpl },
			);
			assert.strictEqual(response.client_id, 'c');
			assert.strictEqual(captured?.url, 'https://auth.example.com/register');
			assert.strictEqual(captured?.body.token_endpoint_auth_method, 'client_secret_basic');
			assert.deepStrictEqual(captured?.body.redirect_uris, ['http://127.0.0.1:33418/']);
			assert.strictEqual(captured?.body.client_uri, 'https://conformance-test.local');
			assert.strictEqual(captured?.body.scope, 'a b');
			assert.strictEqual(captured?.body.application_type, 'native');
		});
	});

	suite('URL helpers', () => {
		test('canonicalResourceUri lowercases scheme/host, drops default ports and fragments, keeps the path', () => {
			assert.strictEqual(canonicalResourceUri('HTTPS://MCP.Example.com:443/api/mcp#frag'), 'https://mcp.example.com/api/mcp');
			assert.strictEqual(canonicalResourceUri('https://mcp.example.com/mcp/'), 'https://mcp.example.com/mcp/');
			assert.strictEqual(canonicalResourceUri('http://localhost:3000/mcp?x=1'), 'http://localhost:3000/mcp?x=1');
		});

		test('isValidClientMetadataUrl requires https and a non-root path', () => {
			assert.strictEqual(isValidClientMetadataUrl('https://conformance-test.local/client-metadata.json'), true);
			assert.strictEqual(isValidClientMetadataUrl('https://app.example.com/oauth/client.json'), true);
			assert.strictEqual(isValidClientMetadataUrl('https://app.example.com'), false);
			assert.strictEqual(isValidClientMetadataUrl('https://app.example.com/'), false);
			assert.strictEqual(isValidClientMetadataUrl('http://app.example.com/client.json'), false);
			assert.strictEqual(isValidClientMetadataUrl('https://app.example.com/client.json#x'), false);
			assert.strictEqual(isValidClientMetadataUrl('https://user:pw@app.example.com/client.json'), false);
			assert.strictEqual(isValidClientMetadataUrl('not a url'), false);
		});

		test('isLoopbackUrl', () => {
			for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://127.1.2.3:8080/', 'http://[::1]:9/x', 'https://LOCALHOST/']) {
				assert.strictEqual(isLoopbackUrl(url), true, url);
			}
			for (const url of ['https://example.com', 'http://10.0.0.1/', 'http://localhost.evil.com/', 'nope']) {
				assert.strictEqual(isLoopbackUrl(url), false, url);
			}
		});
	});

	suite('PKCE', () => {
		test('pkceSupported requires S256 in code_challenge_methods_supported', () => {
			assert.strictEqual(pkceSupported({ issuer: 'x', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }), true);
			assert.strictEqual(pkceSupported({ issuer: 'x', response_types_supported: ['code'], code_challenge_methods_supported: ['plain'] }), false);
			assert.strictEqual(pkceSupported({ issuer: 'x', response_types_supported: ['code'] }), false);
		});

		test('createPkcePair derives the S256 challenge from the verifier with base64url and no padding', async () => {
			const random = (bytes: number) => new Uint8Array(bytes).map((_, i) => i * 7 % 256);
			const sha256 = async (data: Uint8Array) => {
				const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
				return new Uint8Array(digest);
			};
			const pair = await createPkcePair(random, sha256);
			assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
			assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
			const expected = await sha256(new TextEncoder().encode(pair.verifier));
			const expectedChallenge = btoa(String.fromCharCode(...expected)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			assert.strictEqual(pair.challenge, expectedChallenge);
		});
	});
});
