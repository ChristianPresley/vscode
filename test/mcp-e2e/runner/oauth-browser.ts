/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The "web browser" of the test container: VS Code opens external URLs with the program in
// `workbench.externalBrowser` (runner/prepare-profile.ts points it at a wrapper of this script).
// For an OAuth authorization URL it does what a user who approves does: it requests the URL (the
// fixture's /authorize approves at once and redirects), then follows the redirect to VS Code's
// loopback redirect URI, which takes the code. Any other URL (the URL-mode elicitation of the UI
// suite, https://url-elicitation.mcp-e2e.test/consent?id=<n>) is recorded with its query and never
// fetched. Every step is one JSON line in the log; codes are logged as their first 8 characters.
//
// Usage: node runner/oauth-browser.ts --log <file.jsonl> <url>

import * as fs from 'node:fs';
import * as path from 'node:path';

function isLoopback(url: URL): boolean {
	return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
}

function describeRedirect(location: string | null): Record<string, unknown> {
	if (!location) {
		return { location: null };
	}
	try {
		const url = new URL(location);
		const code = url.searchParams.get('code');
		return {
			origin: url.origin,
			pathname: url.pathname,
			params: [...url.searchParams.keys()],
			code: code ? `${code.slice(0, 8)}...` : undefined,
			state: url.searchParams.has('state'),
			iss: url.searchParams.get('iss') ?? undefined,
			error: url.searchParams.get('error') ?? undefined,
			errorDescription: url.searchParams.get('error_description') ?? undefined,
		};
	} catch {
		return { location };
	}
}

async function main(args: readonly string[]): Promise<number> {
	const logIndex = args.indexOf('--log');
	const logFile = logIndex !== -1 ? args[logIndex + 1] : undefined;
	const target = args.filter((_a, i) => logIndex === -1 || (i !== logIndex && i !== logIndex + 1)).at(-1);
	const record = (entry: Record<string, unknown>) => {
		const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
		if (logFile) {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			fs.appendFileSync(logFile, line + '\n');
		} else {
			console.log(line);
		}
	};
	if (!target) {
		record({ event: 'error', error: 'no URL' });
		return 2;
	}
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		record({ event: 'open', url: target, followed: false, reason: 'not a URL' });
		return 0;
	}
	if (!isLoopback(url)) {
		// Never fetch anything beyond loopback. What was opened is all a test needs (the URL elicitation).
		record({ event: 'open', origin: url.origin, pathname: url.pathname, search: url.search, followed: false, reason: 'not a loopback URL' });
		return 0;
	}
	// Mutation oauth-no-resource (runner/mutations.ts): the authorization request loses its RFC 8707 resource.
	const mutations = (process.env.MCP_E2E_MUTATIONS ?? '').split(',').map(s => s.trim());
	if (mutations.includes('oauth-no-resource') && url.searchParams.has('resource')) {
		url.searchParams.delete('resource');
		record({ event: 'mutation', name: 'oauth-no-resource' });
	}
	record({ event: 'open', origin: url.origin, pathname: url.pathname, params: [...url.searchParams.keys()], followed: true });
	try {
		const authorize = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
		const location = authorize.headers.get('location');
		record({ event: 'authorize-response', status: authorize.status, redirect: describeRedirect(location) });
		if (!location || authorize.status < 300 || authorize.status >= 400) {
			return 1;
		}
		const redirect = new URL(location, url);
		if (!isLoopback(redirect)) {
			record({ event: 'redirect', followed: false, reason: 'the redirect URI is not a loopback URL', origin: redirect.origin });
			return 1;
		}
		// VS Code's loopback server answers the code with a redirect to /done (/done?error=1 when it rejected the response).
		const callback = await fetch(redirect, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
		record({ event: 'redirect-response', status: callback.status, location: callback.headers.get('location') });
		return callback.status >= 200 && callback.status < 400 ? 0 : 1;
	} catch (e) {
		record({ event: 'error', error: String(e) });
		return 1;
	}
}

process.exitCode = await main(process.argv.slice(2));
