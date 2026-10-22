/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { mcpToolNameOf } from './agent';
import { modernRequest } from './gatewayClients';
import { E2eHarness, waitFor } from './harness';
import { CLIENT_CAPABILITIES_META, ILoggedMessage, LISTEN_ACK, loggedMessages, responseTo, SUBSCRIPTION_ID_META } from './mcpLog';
import { assert, ITestCase } from './runner';
import type { GatewayRouteOf } from './testsAgent';
import { errorText, expectToolText, mcpResourceUri } from './testHelpers';

/**
 * Resources through VS Code's `mcp-resource:` file system: a subscription and its
 * `notifications/resources/updated` (zig-sdk's `test_trigger_resource_update` announces
 * `test://watched-resource`), the error of a resource the server does not have, and the fixture
 * of the MCP Apps extension (zig-sdk's `--apps`: a tool that names a `ui://` view).
 */

/** The resource that `test_trigger_resource_update` reports as updated (its text stays `watched`). */
const WATCHED_RESOURCE = 'test://watched-resource';
const WATCHED_TEXT = 'watched';
/** A resource no zig server has. */
const MISSING_RESOURCE = 'test://no-such-resource';
const RESOURCES_UPDATED = 'notifications/resources/updated';
/** The MCP Apps extension: its id in `capabilities.extensions`, the MIME type of a view, and the fixture of `--apps`. */
const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const APP_MIME = 'text/html;profile=mcp-app';
const APP_TOOL = 'test_app_tool';
const APP_VIEW = 'ui://conformance/view';

interface IListedTool {
	readonly name?: string;
	readonly _meta?: { readonly ui?: { readonly resourceUri?: unknown } };
}

function metaOf(message: ILoggedMessage): Record<string, unknown> | undefined {
	return message.message.params?._meta as Record<string, unknown> | undefined;
}

/** The `resources/read` requests of `uri` that VS Code sent from `fromOffset` on. */
function sentReads(logText: string, fromOffset: number, uri: string): ILoggedMessage[] {
	return loggedMessages(logText, fromOffset).filter(m => m.direction === 'sent' && m.message.method === 'resources/read' && m.message.params?.uri === uri);
}

export function resourceTests(h: E2eHarness): ITestCase[] {
	const label = 'zig-http';
	return [
		{
			name: `resources/updated (${label}): a file watcher on the mcp-resource URI of ${WATCHED_RESOURCE} makes VS Code subscribe to it on an acknowledged subscriptions/listen stream; test_trigger_resource_update sends ${RESOURCES_UPDATED} on that stream, the watcher reports a change of the resource, and the next read reaches the server again`,
			group: 'resources',
			fn: async ctx => {
				await h.requireServer(label);
				const uri = mcpResourceUri(h, label, WATCHED_RESOURCE);
				ctx.details.uri = uri.toString();
				const from = h.serverLog(label).length;
				const first = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
				ctx.details.firstRead = first;
				assert(first === WATCHED_TEXT, `${WATCHED_RESOURCE} read ${JSON.stringify(first)}`);
				// The watcher's base is the resource itself: VS Code watches exactly that URI, which
				// subscribes it (mcpResourceFilesystem.ts `watch`); `**` also matches the base path.
				const changes: { uri: string; at: number }[] = [];
				const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(uri, '**'), true, false, true);
				try {
					watcher.onDidChange(changed => changes.push({ uri: changed.toString(), at: Date.now() }));
					// VS Code's resources stream: a subscriptions/listen naming the resource, acknowledged with its id.
					const listen = await h.waitForLog(label, `an acknowledged subscriptions/listen with resourceSubscriptions [${WATCHED_RESOURCE}]`, logText => {
						const messages = loggedMessages(logText, from);
						const request = messages.filter(m => m.direction === 'sent' && m.message.method === 'subscriptions/listen'
							&& ((m.message.params?.notifications as { resourceSubscriptions?: unknown } | undefined)?.resourceSubscriptions as unknown[] | undefined)?.includes(WATCHED_RESOURCE)).at(-1);
						if (!request) {
							return { ok: false as const, reason: `VS Code sent no subscriptions/listen with resourceSubscriptions naming ${WATCHED_RESOURCE}` };
						}
						const ack = messages.find(m => m.offset > request.offset && m.direction === 'received' && m.message.method === LISTEN_ACK && metaOf(m)?.[SUBSCRIPTION_ID_META] === request.message.id);
						return ack
							? { ok: true as const, details: { id: request.message.id, notifications: request.message.params?.notifications, acknowledged: ack.message.params?.notifications } }
							: { ok: false as const, reason: `the server has not acknowledged the resources stream (id ${JSON.stringify(request.message.id)})` };
					}, 20_000);
					ctx.details.listen = listen;
					const triggered = h.serverLog(label).length;
					const triggeredAt = Date.now();
					await expectToolText(h, ctx, label, 'test_trigger_resource_update', {}, ['Resource updated']);
					const updated = await h.waitForLog(label, `${RESOURCES_UPDATED} for ${WATCHED_RESOURCE}`, logText => {
						const notification = loggedMessages(logText, triggered).find(m => m.direction === 'received' && m.message.method === RESOURCES_UPDATED);
						return notification ? { ok: true as const, details: notification.message } : { ok: false as const, reason: `the server sent no ${RESOURCES_UPDATED} after the trigger` };
					});
					ctx.details.updated = updated;
					assert(updated.params?.uri === WATCHED_RESOURCE, `${RESOURCES_UPDATED} names ${JSON.stringify(updated.params?.uri)}`);
					const subscriptionId = (updated.params?._meta as Record<string, unknown> | undefined)?.[SUBSCRIPTION_ID_META];
					assert(subscriptionId === listen.id, `${RESOURCES_UPDATED} carries subscriptionId ${JSON.stringify(subscriptionId)}, VS Code's resources stream has id ${JSON.stringify(listen.id)}`);
					// What an extension sees: a change event of the watched resource.
					const change = await waitFor('the change event of the file watcher', 15_000, () => changes.find(c => c.uri === uri.toString()), 100);
					ctx.details.changeEventAfterMs = change.at - triggeredAt;
					// The update dropped VS Code's cached read: reading again asks the server.
					const reread = h.serverLog(label).length;
					const second = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
					ctx.details.secondRead = second;
					assert(second === WATCHED_TEXT, `the second read of ${WATCHED_RESOURCE} gave ${JSON.stringify(second)}`);
					const reads = await h.waitForLog(label, `the second resources/read of ${WATCHED_RESOURCE}`, logText => {
						const sent = sentReads(logText, reread, WATCHED_RESOURCE);
						return sent.length ? { ok: true as const, details: sent.length } : { ok: false as const, reason: `VS Code answered the read after ${RESOURCES_UPDATED} without asking the server` };
					});
					ctx.details.readsAfterUpdate = reads;
				} finally {
					watcher.dispose();
				}
			},
		},
		// Over Streamable HTTP the zig server answers this -32602 with HTTP 400 and the error in the body,
		// which VS Code's HTTP transport delivers as the server's JSON-RPC answer once the server speaks 2026-07-28.
		...(['zig-stdio', 'zig-http'] as const).map((server): ITestCase => ({
			name: `resources (${server}): reading ${MISSING_RESOURCE}, which the server does not have, fails with FileSystemError FileNotFound (the server answers resources/read with -32602${server === 'zig-http' ? ' in the body of an HTTP 400' : ''})`,
			group: 'resources',
			fn: async ctx => {
				await h.requireServer(server);
				const uri = mcpResourceUri(h, server, MISSING_RESOURCE);
				ctx.details.uri = uri.toString();
				const from = h.serverLog(server).length;
				const error = await Promise.resolve(vscode.workspace.fs.readFile(uri)).then(data => ({ read: new TextDecoder().decode(data) }), (e: unknown) => e);
				ctx.details.error = error instanceof vscode.FileSystemError ? { name: error.name, code: error.code, message: error.message } : errorText(error);
				// The server's answer that VS Code turned into the error.
				ctx.details.serverAnswer = await h.waitForLog(server, `the answer to resources/read ${MISSING_RESOURCE}`, logText => {
					const request = sentReads(logText, from, MISSING_RESOURCE)[0];
					const answer = request && responseTo(loggedMessages(logText, from), request);
					return answer ? { ok: true as const, details: answer.message.error ?? answer.message.result } : { ok: false as const, reason: `no answered resources/read of ${MISSING_RESOURCE} in VS Code's MCP log` };
				});
				assert(error instanceof vscode.FileSystemError && error.code === 'FileNotFound', `reading ${MISSING_RESOURCE} gave ${JSON.stringify(ctx.details.error)}, expected a FileSystemError with code FileNotFound`);
			},
		})),
	];
}

export function appsTests(h: E2eHarness, routeOf: GatewayRouteOf): ITestCase[] {
	const label = 'zig-apps';
	return [
		{
			name: `MCP Apps (${label}, --apps): VS Code declares ${UI_EXTENSION} in the tools/list that lists ${APP_TOOL} with _meta.ui.resourceUri ${APP_VIEW}, the server announced the extension, VS Code keeps the metadata (its gateway route lists it), the tool runs, and the view reads through the mcp-resource file system as ${APP_MIME} HTML`,
			group: 'apps',
			fn: async ctx => {
				await h.requireServer(label);
				const tools = await h.waitForTools(label);
				assert(tools.some(t => mcpToolNameOf(t) === APP_TOOL), `${label} has no ${APP_TOOL} in vscode.lm.tools: ${JSON.stringify(tools.map(mcpToolNameOf))}`);
				// The server's side of the handshake: server/discover announces the extension.
				const messages = loggedMessages(h.serverLog(label));
				const discover = messages.find(m => m.direction === 'sent' && m.message.method === 'server/discover');
				const discovered = discover && responseTo(messages, discover);
				const announced = (discovered?.message.result?.capabilities as { extensions?: Record<string, unknown> } | undefined)?.extensions?.[UI_EXTENSION];
				ctx.details.announced = announced;
				assert(announced !== undefined, `${label} did not announce ${UI_EXTENSION} in server/discover: ${JSON.stringify(discovered?.message.result?.capabilities)}`);
				// The tools/list whose answer has the tool with its view, and what VS Code declared in it.
				const listed = await h.waitForLog(label, `${APP_TOOL} in an answer to tools/list`, logText => {
					const all = loggedMessages(logText);
					for (const request of all.filter(m => m.direction === 'sent' && m.message.method === 'tools/list')) {
						const tool = ((responseTo(all, request)?.message.result?.tools ?? []) as IListedTool[]).find(t => t.name === APP_TOOL);
						if (tool) {
							return { ok: true as const, details: { request: request.message, tool } };
						}
					}
					return { ok: false as const, reason: `no answer to tools/list has ${APP_TOOL}` };
				});
				const declared = ((listed.request.params?._meta as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META] as { extensions?: Record<string, { mimeTypes?: unknown[] }> } | undefined)?.extensions?.[UI_EXTENSION];
				ctx.details.declared = declared;
				ctx.details.listedMeta = listed.tool._meta;
				assert(declared?.mimeTypes?.includes(APP_MIME), `VS Code's tools/list does not declare ${UI_EXTENSION} with ${APP_MIME}: ${JSON.stringify(listed.request.params?._meta)}`);
				assert(listed.tool._meta?.ui?.resourceUri === APP_VIEW, `the server listed ${APP_TOOL} with _meta ${JSON.stringify(listed.tool._meta)}, expected ui.resourceUri ${APP_VIEW}`);
				// VS Code's own definition of the tool, as its gateway publishes it: the view is kept.
				const route = await routeOf(label, 'http');
				assert(route, `the gateway has no route for ${label}`);
				const list = await modernRequest(route, 'tools/list');
				const published = ((list.response?.result?.tools ?? []) as IListedTool[]).find(t => t.name === APP_TOOL);
				ctx.details.gatewayMeta = published?._meta;
				assert(published?._meta?.ui?.resourceUri === APP_VIEW, `the gateway route lists ${APP_TOOL} as ${JSON.stringify(published)}, expected _meta.ui.resourceUri ${APP_VIEW}`);
				await expectToolText(h, ctx, label, APP_TOOL, {}, ['A result for the view']);
				// The view, through VS Code's file system of MCP resources.
				const view = mcpResourceUri(h, label, APP_VIEW);
				ctx.details.viewUri = view.toString();
				const from = h.serverLog(label).length;
				const html = new TextDecoder().decode(await vscode.workspace.fs.readFile(view));
				ctx.details.view = html.slice(0, 300);
				assert(html.startsWith('<!doctype html>') && html.includes('The view of test_app_tool'), `${APP_VIEW} read ${JSON.stringify(html.slice(0, 300))}`);
				const mimeType = await h.waitForLog(label, `the answer to resources/read ${APP_VIEW}`, logText => {
					const request = sentReads(logText, from, APP_VIEW)[0];
					const answer = request && responseTo(loggedMessages(logText, from), request);
					const contents = answer?.message.result?.contents as { mimeType?: string }[] | undefined;
					return contents ? { ok: true as const, details: contents[0]?.mimeType } : { ok: false as const, reason: `no answered resources/read of ${APP_VIEW} in VS Code's MCP log` };
				});
				ctx.details.viewMimeType = mimeType;
				assert(mimeType === APP_MIME, `the server answered the read of ${APP_VIEW} with MIME type ${JSON.stringify(mimeType)}, expected ${APP_MIME}`);
			},
		},
	];
}
