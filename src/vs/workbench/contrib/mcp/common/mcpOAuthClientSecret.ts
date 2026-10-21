/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A client secret as stored for a pre-registered MCP OAuth client (under
 * `mcpOAuthClientSecretStorageKey`), bound to the issuer it was first used
 * with. The *Set Client Secret* command and the main thread's token
 * acquisition both read and write this form.
 */
export interface IMcpStoredClientSecret {
	readonly clientSecret?: string;
	/** The issuer the credentials were bound to; `undefined` until their first successful use. */
	readonly issuer?: string;
}

/**
 * Reads a stored client secret: `{ clientSecret, issuer }` JSON, or (as written
 * by older versions) the bare secret, which is not bound to an issuer yet.
 */
export function parseStoredClientSecret(value: string | undefined): IMcpStoredClientSecret | undefined {
	if (value === undefined || value.length === 0) {
		return undefined;
	}
	if (value.startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				const record = parsed as { readonly clientSecret?: unknown; readonly issuer?: unknown };
				const issuer = typeof record.issuer === 'string' ? record.issuer : undefined;
				const clientSecret = typeof record.clientSecret === 'string' ? record.clientSecret : undefined;
				if (Object.prototype.hasOwnProperty.call(parsed, 'issuer') || Object.prototype.hasOwnProperty.call(parsed, 'clientSecret')) {
					return { clientSecret, issuer };
				}
			}
		} catch {
			// a bare secret that happens to start with a brace
		}
	}
	return { clientSecret: value };
}

/** The stored form of {@link IMcpStoredClientSecret}. */
export function serializeStoredClientSecret(secret: IMcpStoredClientSecret): string {
	return JSON.stringify({ clientSecret: secret.clientSecret, issuer: secret.issuer });
}
