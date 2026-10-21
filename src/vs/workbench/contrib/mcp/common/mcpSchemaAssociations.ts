/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Extensions as JSONExtensions, IJSONContributionRegistry } from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUserDataProfile } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { mcpSchemaId } from '../../../services/configuration/common/configuration.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IRemoteUserDataProfilesService } from '../../../services/userDataProfile/common/remoteUserDataProfiles.js';

/**
 * Associates the MCP configuration schema with the user-level `mcp.json` files:
 * the one of the current profile (a `vscode-userdata:` resource) and, in a
 * remote window, the remote user one. The workspace files (`.vscode/mcp.json`)
 * and the `User` folder layout get theirs from the `jsonValidation` of the
 * configuration-editing extension; these exact resources also cover profiles
 * and user data folders that layout does not name.
 */
export class McpUserConfigurationSchemaAssociations extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.mcpUserConfigurationSchemaAssociations';

	private readonly _local = this._register(new MutableDisposable());
	private readonly _remote = this._register(new MutableDisposable());
	/** Bumped on each profile change, so that a late remote profile of an earlier one is ignored. */
	private _generation = 0;

	constructor(
		@IUserDataProfileService userDataProfileService: IUserDataProfileService,
		@IRemoteUserDataProfilesService private readonly _remoteUserDataProfilesService: IRemoteUserDataProfilesService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._associate(userDataProfileService.currentProfile);
		this._register(userDataProfileService.onDidChangeCurrentProfile(e => this._associate(e.profile)));
	}

	private _associate(profile: IUserDataProfile): void {
		const registry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);
		const generation = ++this._generation;
		// Clear first: the registry keeps one entry per resource, which disposing the old registration would remove.
		this._local.clear();
		this._local.value = registry.registerSchemaAssociation(mcpSchemaId, profile.mcpResource.toString());

		this._remote.clear();
		if (!this._environmentService.remoteAuthority) {
			return;
		}
		this._remoteUserDataProfilesService.getRemoteProfile(profile).then(remoteProfile => {
			if (generation === this._generation && !this._store.isDisposed) {
				this._remote.value = registry.registerSchemaAssociation(mcpSchemaId, remoteProfile.mcpResource.toString());
			}
		}, err => this._logService.trace('[MCP] No remote user configuration to associate the MCP schema with', err));
	}
}
