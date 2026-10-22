/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MCP } from './modelContextProtocol.js';

/**
 * The newest Model Context Protocol revision VS Code implements.
 */
export const LATEST_MCP_PROTOCOL_VERSION = '2026-07-28';

/**
 * Revisions that use the stateless, `server/discover`-based protocol
 * (the "modern" era). Newest first.
 */
export const MODERN_MCP_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28'];

/**
 * Revisions that use the `initialize` handshake (the "legacy" era). Newest first.
 */
export const LEGACY_MCP_PROTOCOL_VERSIONS: readonly string[] = [
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
	'2024-10-07',
];

/**
 * Every revision VS Code can speak, newest first. Used for configuration
 * schemas and validation only; negotiation uses the per-era lists.
 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = [
	...MODERN_MCP_PROTOCOL_VERSIONS,
	...LEGACY_MCP_PROTOCOL_VERSIONS,
];

/**
 * The two protocol generations the client and gateway distinguish:
 * - `legacy`: `initialize` handshake, session state, server-initiated requests.
 * - `modern`: stateless, per-request `_meta`, `server/discover`, MRTR, `subscriptions/listen`.
 */
export type McpProtocolEra = 'legacy' | 'modern';

/**
 * Classifies a protocol version string. Unknown versions return `undefined`;
 * callers decide whether to treat them as the newest era they are above.
 */
export function eraForProtocolVersion(version: string): McpProtocolEra | undefined {
	if (MODERN_MCP_PROTOCOL_VERSIONS.includes(version)) {
		return 'modern';
	}
	if (LEGACY_MCP_PROTOCOL_VERSIONS.includes(version)) {
		return 'legacy';
	}
	return undefined;
}

export function isModernProtocolVersion(version: string): boolean {
	return eraForProtocolVersion(version) === 'modern';
}

/**
 * Picks the protocol version to use from a server's advertised list.
 * Prefers the newest mutually supported modern revision; falls back to the
 * newest mutually supported legacy revision (which requires the `initialize`
 * handshake); returns `undefined` when nothing overlaps.
 */
export function negotiateProtocolVersion(advertised: readonly string[]): { readonly era: McpProtocolEra; readonly version: string } | undefined {
	for (const version of MODERN_MCP_PROTOCOL_VERSIONS) {
		if (advertised.includes(version)) {
			return { era: 'modern', version };
		}
	}
	for (const version of LEGACY_MCP_PROTOCOL_VERSIONS) {
		if (advertised.includes(version)) {
			return { era: 'legacy', version };
		}
	}
	return undefined;
}

/** Reserved `_meta` key: the protocol revision a request is sent under (required on every modern request). */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** Reserved `_meta` key: the client's capabilities (required on every modern request). */
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
/** Reserved `_meta` key: the client's implementation info (SHOULD be sent on every modern request). */
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
/** Reserved `_meta` key: the minimum log level the client wants for this request. */
export const META_LOG_LEVEL = 'io.modelcontextprotocol/logLevel';
/** Reserved `_meta` key: the listen request id a notification belongs to. */
export const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';
/** Reserved `_meta` key: the server's implementation info on results. */
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
/** `_meta` key for progress notifications (both eras). */
export const META_PROGRESS_TOKEN = 'progressToken';

const MODERN_ONLY_ERROR_CODES: ReadonlySet<number> = new Set([
	MCP.HEADER_MISMATCH,
	MCP.MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP.UNSUPPORTED_PROTOCOL_VERSION,
]);

/**
 * Decides whether an HTTP error response body proves that the peer speaks the
 * modern protocol. Per the 2026-07-28 transport rules a client probing a server
 * with a modern request inspects 400/404/405 bodies: a JSON-RPC error with code
 * -32020/-32021/-32022, or a 404 carrying -32601 (unknown method), comes from a
 * modern server. Anything else (including -32000 "Server not initialized",
 * -32602 or -32600 from legacy servers, or a non-JSON body) means the server
 * is legacy and the client must fall back to `initialize`.
 */
export function isRecognizedModernError(httpStatus: number | undefined, body: unknown): boolean {
	const codes = collectErrorCodes(body);
	for (const code of codes) {
		if (MODERN_ONLY_ERROR_CODES.has(code)) {
			return true;
		}
		if (httpStatus === 404 && code === MCP.METHOD_NOT_FOUND) {
			return true;
		}
	}
	return false;
}

function collectErrorCodes(body: unknown): number[] {
	const messages = Array.isArray(body) ? body : [body];
	const codes: number[] = [];
	for (const message of messages) {
		if (typeof message !== 'object' || message === null) {
			continue;
		}
		const error = (message as { error?: unknown }).error;
		if (typeof error !== 'object' || error === null) {
			continue;
		}
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'number') {
			codes.push(code);
		}
	}
	return codes;
}
