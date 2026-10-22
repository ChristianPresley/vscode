/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getMediaMime } from '../../../../base/common/mime.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogger } from '../../../../platform/log/common/log.js';
import { Dto } from '../../../services/extensions/common/proxyIdentifier.js';
import { IMcpIcons, McpServerLaunch, McpServerTransportType } from './mcpTypes.js';
import { MCPLegacy } from './modelContextProtocolLegacy.js';

const mcpAllowableContentTypes: readonly string[] = [
	'image/webp',
	'image/png',
	'image/jpeg',
	'image/jpg',
	'image/gif'
];

const enum IconTheme {
	Light,
	Dark,
	Any,
}

interface IIcon {
	/** URI the image can be loaded from */
	src: URI;
	/** Theme for this icon. */
	theme: IconTheme;
	/** Sizes of the icon in ascending order. */
	sizes: { width: number; height: number }[];
}

export type ParsedMcpIcons = IIcon[];
export type StoredMcpIcons = Dto<IIcon>[];


/**
 * The MIME types an icon states: its declared `mimeType`, the media type of a
 * `data:` URI (`text/plain` when it names none, RFC 2397), and the type its
 * file name implies. A declared type does not override the others: an SVG
 * declared as `image/png` still states `image/svg+xml`.
 */
function statedMimeTypes(icon: MCPLegacy.Icon, uri: URI): string[] {
	const types: string[] = [];
	const declared = icon.mimeType?.trim().toLowerCase();
	if (declared) {
		types.push(declared);
	}
	if (uri.scheme === 'data') {
		const mediaType = /^\s*data:([^;,]*)/i.exec(icon.src)?.[1].trim().toLowerCase();
		types.push(mediaType || 'text/plain');
	} else {
		const derived = getMediaMime(uri.path);
		if (derived) {
			types.push(derived);
		}
	}
	return types;
}

function validateIcon(icon: MCPLegacy.Icon, launch: McpServerLaunch, logger: ILogger): URI | undefined {
	const uri = URI.parse(icon.src);
	// Every type the icon states must be on the allow list, and it must state one.
	const mimeTypes = statedMimeTypes(icon, uri);
	if (mimeTypes.length === 0 || !mimeTypes.every(mimeType => mcpAllowableContentTypes.includes(mimeType))) {
		logger.debug(`Ignoring icon with unsupported mime type: ${icon.src} (${mimeTypes.join(', ') || 'none'}), allowed: ${mcpAllowableContentTypes.join(', ')}`);
		return;
	}

	if (uri.scheme === 'data') {
		return uri;
	}

	if (uri.scheme === 'https' || uri.scheme === 'http') {
		// Remote icons are trusted by host: HTTP servers by authority, gRPC servers by host name.
		if (launch.type !== McpServerTransportType.HTTP && launch.type !== McpServerTransportType.Grpc) {
			logger.debug(`Ignoring icon with HTTP/HTTPS URL: ${icon.src} as the MCP server is not launched with a network transport.`);
			return;
		}

		if (!McpServerLaunch.isServerNetworkAuthority(launch, uri.authority)) {
			logger.debug(`Ignoring icon with untrusted authority: ${icon.src}, expected authority: ${launch.uri.authority.toLowerCase()}`);
			return;
		}

		return uri;
	}

	if (uri.scheme === 'file') {
		if (launch.type !== McpServerTransportType.Stdio) {
			logger.debug(`Ignoring icon with file URL: ${icon.src} as the MCP server is not launched as a local process.`);
			return;
		}

		return uri;
	}

	logger.debug(`Ignoring icon with unsupported scheme: ${icon.src}. Allowed: data:, http:, https:, file:`);
	return;
}

export function parseAndValidateMcpIcon(icons: MCPLegacy.Icons, launch: McpServerLaunch, logger: ILogger): ParsedMcpIcons {
	const result: ParsedMcpIcons = [];
	for (const icon of icons.icons || []) {
		const uri = validateIcon(icon, launch, logger);
		if (!uri) {
			continue;
		}

		// check for sizes as string for back-compat with early 2025-11-25 drafts
		const sizesArr = typeof icon.sizes === 'string' ? (icon.sizes as string).split(' ') : Array.isArray(icon.sizes) ? icon.sizes : [];
		result.push({
			src: uri,
			theme: icon.theme === 'light' ? IconTheme.Light : icon.theme === 'dark' ? IconTheme.Dark : IconTheme.Any,
			sizes: sizesArr.map(size => {
				const [widthStr, heightStr] = size.toLowerCase().split('x');
				return { width: Number(widthStr) || 0, height: Number(heightStr) || 0 };
			}).sort((a, b) => a.width - b.width)
		});
	}

	result.sort((a, b) => a.sizes[0]?.width - b.sizes[0]?.width);

	return result;
}

export class McpIcons implements IMcpIcons {
	public static fromStored(icons: StoredMcpIcons | undefined) {
		return McpIcons.fromParsed(icons?.map(i => ({ src: URI.revive(i.src), theme: i.theme, sizes: i.sizes })));
	}

	public static fromParsed(icons: ParsedMcpIcons | undefined) {
		return new McpIcons(icons || []);
	}

	protected constructor(private readonly _icons: IIcon[]) { }

	getUrl(size: number): { dark: URI; light?: URI } | undefined {
		const dark = this.getSizeWithTheme(size, IconTheme.Dark);
		if (dark?.theme === IconTheme.Any) {
			return { dark: dark.src };
		}

		const light = this.getSizeWithTheme(size, IconTheme.Light);
		if (!light && !dark) {
			return undefined;
		}

		return { dark: (dark || light)!.src, light: light?.src };
	}

	private getSizeWithTheme(size: number, theme: IconTheme): IIcon | undefined {
		let bestOfAnySize: IIcon | undefined;

		for (const icon of this._icons) {
			if (icon.theme === theme || icon.theme === IconTheme.Any || icon.theme === undefined) { // undefined check for back compat
				bestOfAnySize = icon;

				const matchingSize = icon.sizes.find(s => s.width >= size);
				if (matchingSize) {
					return { ...icon, sizes: [matchingSize] };
				}
			}
		}
		return bestOfAnySize;
	}
}
