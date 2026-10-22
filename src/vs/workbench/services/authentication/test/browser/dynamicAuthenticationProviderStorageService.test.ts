/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { DynamicAuthenticationProviderStorageService } from '../../browser/dynamicAuthenticationProviderStorageService.js';

suite('DynamicAuthenticationProviderStorageService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const providerId = 'https://as.example.com/ https://mcp.example.com/mcp';
	const registrationKey = `dynamicAuthProvider:clientRegistration:${providerId}`;

	function createService() {
		const secrets = disposables.add(new TestSecretStorageService());
		const traces: string[] = [];
		const logService = new class extends NullLogService {
			override trace(message: string, ...args: unknown[]): void {
				traces.push([message, ...args.map(arg => JSON.stringify(arg))].join(' '));
			}
			override error(message: string | Error, ...args: unknown[]): void {
				traces.push([String(message), ...args.map(arg => JSON.stringify(arg))].join(' '));
			}
		}();
		const service = disposables.add(new DynamicAuthenticationProviderStorageService(disposables.add(new TestStorageService()), secrets, logService));
		return { service, secrets, traces };
	}

	test('round-trips the token endpoint authentication method with the client registration', async () => {
		const { service } = createService();
		await service.storeClientRegistration(providerId, 'https://as.example.com/', 'client', 'secret', 'Label', 'client_secret_post');
		assert.deepStrictEqual(await service.getClientRegistration(providerId), { clientId: 'client', clientSecret: 'secret', tokenEndpointAuthMethod: 'client_secret_post' });
		await service.storeClientRegistration(providerId, 'https://as.example.com/', 'public-client');
		assert.deepStrictEqual(await service.getClientRegistration(providerId), { clientId: 'public-client', clientSecret: undefined });
		assert.deepStrictEqual(service.getInteractedProviders().map(p => [p.providerId, p.clientId, p.label]), [[providerId, 'public-client', 'Label']]);
	});

	test('loads registrations stored by older versions, without a method, and ignores an unknown method', async () => {
		const { service, secrets } = createService();
		await secrets.set(registrationKey, JSON.stringify({ clientId: 'old-client', clientSecret: 'old-secret' }));
		assert.deepStrictEqual(await service.getClientRegistration(providerId), { clientId: 'old-client', clientSecret: 'old-secret' });
		await secrets.set(registrationKey, JSON.stringify({ clientId: 'odd-client', tokenEndpointAuthMethod: 'private_key_jwt' }));
		assert.deepStrictEqual(await service.getClientRegistration(providerId), { clientId: 'odd-client', clientSecret: undefined });
		await secrets.set(registrationKey, 'not json');
		assert.strictEqual(await service.getClientRegistration(providerId), undefined);
		assert.strictEqual(await secrets.get(registrationKey), undefined, 'a corrupt registration is removed');
	});

	test('logs a summary of stored sessions, never their tokens', async () => {
		const { service, secrets, traces } = createService();
		await service.setSessionsForDynamicAuthProvider(providerId, 'client', [{ access_token: 'access-token-value', refresh_token: 'refresh-token-value', id_token: 'id-token-value', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1 }]);
		await secrets.set(JSON.stringify({ isDynamicAuthProvider: true, authProviderId: providerId, clientId: 'broken' }), JSON.stringify([{ access_token: 'broken-token-value' }]));
		assert.strictEqual(await service.getSessionsForDynamicAuthProvider(providerId, 'broken'), undefined);
		assert.ok(traces.length >= 2);
		const leaked = ['access-token-value', 'refresh-token-value', 'id-token-value', 'broken-token-value'].filter(secret => traces.some(line => line.includes(secret)));
		assert.deepStrictEqual(leaked, []);
	});
});
