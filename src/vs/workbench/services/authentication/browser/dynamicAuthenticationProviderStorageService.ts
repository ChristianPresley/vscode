/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderInfo, DynamicAuthenticationProviderTokensChangeEvent, IDynamicAuthenticationProviderClientRegistration } from '../common/dynamicAuthenticationProviderStorage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IAuthorizationTokenResponse, isAuthorizationTokenResponse, OAuthTokenEndpointAuthMethod } from '../../../../base/common/oauth.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Queue } from '../../../../base/common/async.js';

export class DynamicAuthenticationProviderStorageService extends Disposable implements IDynamicAuthenticationProviderStorageService {
	declare readonly _serviceBrand: undefined;

	private static readonly PROVIDERS_STORAGE_KEY = 'dynamicAuthProviders';

	private readonly _onDidChangeTokens = this._register(new Emitter<DynamicAuthenticationProviderTokensChangeEvent>());
	readonly onDidChangeTokens: Event<DynamicAuthenticationProviderTokensChangeEvent> = this._onDidChangeTokens.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Listen for secret storage changes and emit events for dynamic auth provider token changes
		const queue = new Queue<void>();
		this._register(this.secretStorageService.onDidChangeSecret(async (key: string) => {
			let payload: { isDynamicAuthProvider: boolean; authProviderId: string; clientId: string } | undefined;
			try {
				payload = JSON.parse(key);
			} catch (error) {
				// Ignore errors... must not be a dynamic auth provider
			}
			if (payload?.isDynamicAuthProvider) {
				void queue.queue(async () => {
					const tokens = await this.getSessionsForDynamicAuthProvider(payload.authProviderId, payload.clientId);
					this._onDidChangeTokens.fire({
						authProviderId: payload.authProviderId,
						clientId: payload.clientId,
						tokens
					});
				});
			}
		}));
	}

	async getClientRegistration(providerId: string): Promise<IDynamicAuthenticationProviderClientRegistration | undefined> {
		// First try new combined SecretStorage format
		const key = `dynamicAuthProvider:clientRegistration:${providerId}`;
		const credentialsValue = await this.secretStorageService.get(key);
		if (credentialsValue) {
			try {
				const credentials: unknown = JSON.parse(credentialsValue);
				const registration = toClientRegistration(credentials);
				if (registration && (registration.clientId || registration.clientSecret)) {
					return registration;
				}
			} catch {
				await this.secretStorageService.delete(key);
			}
		}

		// Just grab the client id from the provider
		const providers = this._getStoredProviders();
		const provider = providers.find(p => p.providerId === providerId);
		return provider?.clientId ? { clientId: provider.clientId } : undefined;
	}

	getClientId(providerId: string): string | undefined {
		// For backward compatibility, try old storage format first
		const providers = this._getStoredProviders();
		const provider = providers.find(p => p.providerId === providerId);
		return provider?.clientId;
	}

	async storeClientRegistration(providerId: string, authorizationServer: string, clientId: string, clientSecret?: string, label?: string, tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod): Promise<void> {
		// Store provider information for backward compatibility and UI display
		this._trackProvider(providerId, authorizationServer, clientId, label);

		// Store the client ID, secret and token endpoint authentication method together in SecretStorage
		const key = `dynamicAuthProvider:clientRegistration:${providerId}`;
		const credentials: IDynamicAuthenticationProviderClientRegistration = { clientId, clientSecret, tokenEndpointAuthMethod };
		await this.secretStorageService.set(key, JSON.stringify(credentials));
	}

	private _trackProvider(providerId: string, authorizationServer: string, clientId: string, label?: string): void {
		const providers = this._getStoredProviders();

		// Check if provider already exists
		const existingProviderIndex = providers.findIndex(p => p.providerId === providerId);
		if (existingProviderIndex === -1) {
			// Add new provider with provided or default info
			const newProvider: DynamicAuthenticationProviderInfo = {
				providerId,
				label: label || providerId, // Use provided label or providerId as default
				authorizationServer,
				clientId
			};
			providers.push(newProvider);
			this._storeProviders(providers);
		} else {
			const existingProvider = providers[existingProviderIndex];
			// Create new provider object with updated info
			const updatedProvider: DynamicAuthenticationProviderInfo = {
				providerId,
				label: label || existingProvider.label,
				authorizationServer,
				clientId
			};
			providers[existingProviderIndex] = updatedProvider;
			this._storeProviders(providers);
		}
	}

	private _getStoredProviders(): DynamicAuthenticationProviderInfo[] {
		const stored = this.storageService.get(DynamicAuthenticationProviderStorageService.PROVIDERS_STORAGE_KEY, StorageScope.APPLICATION, '[]');
		try {
			const providerInfos = JSON.parse(stored);
			// MIGRATION: remove after an iteration or 2
			for (const providerInfo of providerInfos) {
				if (!providerInfo.authorizationServer) {
					providerInfo.authorizationServer = providerInfo.issuer;
				}
			}
			return providerInfos;
		} catch {
			return [];
		}
	}

	private _storeProviders(providers: DynamicAuthenticationProviderInfo[]): void {
		this.storageService.store(
			DynamicAuthenticationProviderStorageService.PROVIDERS_STORAGE_KEY,
			JSON.stringify(providers),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE
		);
	}

	getInteractedProviders(): ReadonlyArray<DynamicAuthenticationProviderInfo> {
		return this._getStoredProviders();
	}

	async removeDynamicProvider(providerId: string): Promise<void> {
		// Get provider info before removal for secret cleanup
		const providers = this._getStoredProviders();
		const providerInfo = providers.find(p => p.providerId === providerId);

		// Remove from stored providers
		const filteredProviders = providers.filter(p => p.providerId !== providerId);
		this._storeProviders(filteredProviders);

		// Remove sessions from secret storage if we have the provider info
		if (providerInfo) {
			const secretKey = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: providerId, clientId: providerInfo.clientId });
			await this.secretStorageService.delete(secretKey);
		}

		// Remove client credentials from new SecretStorage format
		const credentialsKey = `dynamicAuthProvider:clientRegistration:${providerId}`;
		await this.secretStorageService.delete(credentialsKey);
	}

	async getSessionsForDynamicAuthProvider(authProviderId: string, clientId: string): Promise<(IAuthorizationTokenResponse & { created_at: number })[] | undefined> {
		const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId, clientId });
		const value = await this.secretStorageService.get(key);
		if (value) {
			const parsed = JSON.parse(value);
			if (!Array.isArray(parsed) || !parsed.every((t) => typeof t.created_at === 'number' && isAuthorizationTokenResponse(t))) {
				// The data may hold tokens: only its shape is logged.
				this.logService.error(`Invalid session data for ${authProviderId} (${clientId}) in secret storage: ${Array.isArray(parsed) ? `an array of ${parsed.length}` : typeof parsed}`);
				await this.secretStorageService.delete(key);
				return undefined;
			}
			return parsed;
		}
		return undefined;
	}

	async setSessionsForDynamicAuthProvider(authProviderId: string, clientId: string, sessions: (IAuthorizationTokenResponse & { created_at: number })[]): Promise<void> {
		const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId, clientId });
		const value = JSON.stringify(sessions);
		await this.secretStorageService.set(key, value);
		// Never the tokens themselves: a summary of what was stored.
		this.logService.trace(`Set session data for ${authProviderId} (${clientId}) in secret storage: ${sessions.length} session(s)`, sessions.map(describeStoredToken));
	}
}

const TOKEN_ENDPOINT_AUTH_METHODS: readonly OAuthTokenEndpointAuthMethod[] = ['none', 'client_secret_basic', 'client_secret_post'];

/** Reads a stored registration; one stored by an older version has no `tokenEndpointAuthMethod`. */
function toClientRegistration(value: unknown): IDynamicAuthenticationProviderClientRegistration | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as { readonly clientId?: unknown; readonly clientSecret?: unknown; readonly tokenEndpointAuthMethod?: unknown };
	const method = TOKEN_ENDPOINT_AUTH_METHODS.find(m => m === record.tokenEndpointAuthMethod);
	return {
		clientId: typeof record.clientId === 'string' ? record.clientId : undefined,
		clientSecret: typeof record.clientSecret === 'string' ? record.clientSecret : undefined,
		...(method ? { tokenEndpointAuthMethod: method } : {}),
	};
}

/** A loggable summary of a stored token response. */
function describeStoredToken(token: IAuthorizationTokenResponse & { created_at: number }): string {
	return `token_type=${token.token_type}, scope=${token.scope ?? '(none)'}, created_at=${token.created_at}, expires_in=${token.expires_in ?? '(none)'}, refresh_token=${token.refresh_token ? 'present' : 'absent'}`;
}

registerSingleton(IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderStorageService, InstantiationType.Delayed);
