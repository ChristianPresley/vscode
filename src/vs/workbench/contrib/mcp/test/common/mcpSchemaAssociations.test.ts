/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Extensions as JSONExtensions, IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IUserDataProfile, toUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { mcpSchemaId } from '../../../../services/configuration/common/configuration.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { DidChangeUserDataProfileEvent, IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { IRemoteUserDataProfilesService } from '../../../../services/userDataProfile/common/remoteUserDataProfiles.js';
import { McpUserConfigurationSchemaAssociations } from '../../common/mcpSchemaAssociations.js';

suite('McpUserConfigurationSchemaAssociations', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const registry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
	const associated = () => [...(registry.getSchemaAssociations()[mcpSchemaId] ?? [])];

	const cacheHome = URI.parse('vscode-userdata:/cache');
	const defaultProfile = toUserDataProfile('default', 'Default', URI.parse('vscode-userdata:/home/user/.config/Code/User'), cacheHome);
	const workProfile = toUserDataProfile('work', 'Work', URI.parse('vscode-userdata:/home/user/.config/Code/User/profiles/work'), cacheHome);
	const remoteDefault = toUserDataProfile('default', 'Default', URI.parse('vscode-remote://wsl+ubuntu/home/user/.vscode-server/data/User'), cacheHome);
	const remoteWork = toUserDataProfile('work', 'Work', URI.parse('vscode-remote://wsl+ubuntu/home/user/.vscode-server/data/User/profiles/work'), cacheHome);

	function create(options: { remoteAuthority?: string; remoteProfile?: (local: IUserDataProfile) => Promise<IUserDataProfile> } = {}) {
		const onDidChangeCurrentProfile = store.add(new Emitter<DidChangeUserDataProfileEvent>());
		const profileService = new class extends mock<IUserDataProfileService>() {
			override currentProfile: IUserDataProfile = defaultProfile;
			override readonly onDidChangeCurrentProfile = onDidChangeCurrentProfile.event;
		};
		const remoteProfiles = new class extends mock<IRemoteUserDataProfilesService>() {
			override getRemoteProfile(local: IUserDataProfile): Promise<IUserDataProfile> {
				return options.remoteProfile?.(local) ?? Promise.reject(new Error('no remote'));
			}
		};
		const environment = new class extends mock<IWorkbenchEnvironmentService>() {
			override readonly remoteAuthority = options.remoteAuthority;
		};
		const contribution = new McpUserConfigurationSchemaAssociations(profileService, remoteProfiles, environment, new NullLogService());
		const switchTo = (profile: IUserDataProfile) => {
			const previous = profileService.currentProfile;
			profileService.currentProfile = profile;
			onDidChangeCurrentProfile.fire({ previous, profile, join: () => { } });
		};
		return { contribution, switchTo };
	}

	test('associates the MCP schema with the user mcp.json of the current profile and follows profile changes', () => {
		const before = associated();
		const { contribution, switchTo } = create();
		const atStart = associated();
		switchTo(workProfile);
		const afterSwitch = associated();
		switchTo(workProfile);
		const afterSameProfile = associated();
		contribution.dispose();

		assert.deepStrictEqual({ atStart, afterSwitch, afterSameProfile, afterDispose: associated() }, {
			atStart: [...before, defaultProfile.mcpResource.toString()],
			afterSwitch: [...before, workProfile.mcpResource.toString()],
			afterSameProfile: [...before, workProfile.mcpResource.toString()],
			afterDispose: before,
		});
		assert.ok(atStart.includes('vscode-userdata:/home/user/.config/Code/User/mcp.json'));
	});

	test('in a remote window, also associates it with the remote user mcp.json', async () => {
		const before = associated();
		const { contribution, switchTo } = create({
			remoteAuthority: 'wsl+ubuntu',
			remoteProfile: async local => local.id === 'default' ? remoteDefault : remoteWork,
		});
		await timeout(0);
		const atStart = associated();
		switchTo(workProfile);
		await timeout(0);
		const afterSwitch = associated();
		contribution.dispose();

		assert.deepStrictEqual({ atStart, afterSwitch, afterDispose: associated() }, {
			atStart: [...before, defaultProfile.mcpResource.toString(), remoteDefault.mcpResource.toString()],
			afterSwitch: [...before, workProfile.mcpResource.toString(), remoteWork.mcpResource.toString()],
			afterDispose: before,
		});
		assert.strictEqual(URI.parse(atStart[atStart.length - 1]).path, '/home/user/.vscode-server/data/User/mcp.json');
	});

	test('a remote profile that resolves after a profile change is ignored', async () => {
		const before = associated();
		const late = new DeferredPromise<IUserDataProfile>();
		const { contribution, switchTo } = create({
			remoteAuthority: 'wsl+ubuntu',
			remoteProfile: local => local.id === 'default' ? late.p : Promise.resolve(remoteWork),
		});
		switchTo(workProfile);
		await timeout(0);
		late.complete(remoteDefault);
		await timeout(0);
		const associations = associated();
		contribution.dispose();
		assert.deepStrictEqual(associations, [...before, workProfile.mcpResource.toString(), remoteWork.mcpResource.toString()]);
	});

	test('without a remote profile service the local association stays', async () => {
		const before = associated();
		const { contribution } = create({ remoteAuthority: 'wsl+ubuntu' });
		await timeout(0);
		const associations = associated();
		contribution.dispose();
		assert.deepStrictEqual(associations, [...before, defaultProfile.mcpResource.toString()]);
	});
});
