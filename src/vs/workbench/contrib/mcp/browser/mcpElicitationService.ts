/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../base/common/actions.js';
import { assertNever, softAssertNever } from '../../../../base/common/assert.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { isDefined } from '../../../../base/common/types.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { McpProtocolEra } from '../../../../platform/mcp/common/mcpProtocolVersions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ChatElicitationRequestPart } from '../../chat/common/model/chatProgressTypes/chatElicitationRequestPart.js';
import { ChatQuestionCarouselData } from '../../chat/common/model/chatProgressTypes/chatQuestionCarouselData.js';
import { ChatModel } from '../../chat/common/model/chatModel.js';
import { ElicitationState, IChatQuestion, IChatQuestionAnswers, IChatQuestionValidation, IChatService } from '../../chat/common/chatService/chatService.js';
import { checkElicitationSchema, isAcceptableElicitationUrl } from '../common/mcpProtocolMeta.js';
import { ElicitationKind, ElicitResult, IFormModeElicitResult, IMcpElicitationService, IMcpElicitOptions, IMcpServer, IMcpToolCallContext, IUrlModeElicitResult, McpConnectionState, MpcResponseError } from '../common/mcpTypes.js';
import { mcpServerToSourceData } from '../common/mcpTypesUtils.js';
import { MCPLegacy } from '../common/modelContextProtocolLegacy.js';

const noneItem: IQuickPickItem = { id: undefined, label: localize('mcp.elicit.enum.none', 'None'), description: localize('mcp.elicit.enum.none.description', 'No selection'), alwaysShow: true };

type Pre20251125ElicitationParams = Omit<MCPLegacy.ElicitRequestFormParams, 'mode'> & { mode?: undefined };

function isFormElicitation(params: MCPLegacy.ElicitRequest['params'] | Pre20251125ElicitationParams): params is (MCPLegacy.ElicitRequestFormParams | Pre20251125ElicitationParams) {
	return params.mode === 'form' || (params.mode === undefined && !!(params as Pre20251125ElicitationParams).requestedSchema);
}

function isUrlElicitation(params: MCPLegacy.ElicitRequest['params']): params is MCPLegacy.ElicitRequestURLParams {
	return params.mode === 'url';
}

function isLegacyTitledEnumSchema(schema: MCPLegacy.PrimitiveSchemaDefinition): schema is MCPLegacy.LegacyTitledEnumSchema & { enumNames: string[] } {
	const cast = schema as MCPLegacy.LegacyTitledEnumSchema;
	return cast.type === 'string' && Array.isArray(cast.enum) && Array.isArray(cast.enumNames);
}

function isUntitledEnumSchema(schema: MCPLegacy.PrimitiveSchemaDefinition): schema is MCPLegacy.LegacyTitledEnumSchema | MCPLegacy.UntitledSingleSelectEnumSchema {
	const cast = schema as MCPLegacy.LegacyTitledEnumSchema | MCPLegacy.UntitledSingleSelectEnumSchema;
	return cast.type === 'string' && Array.isArray(cast.enum);
}

function isTitledSingleEnumSchema(schema: MCPLegacy.PrimitiveSchemaDefinition): schema is MCPLegacy.TitledSingleSelectEnumSchema {
	const cast = schema as MCPLegacy.TitledSingleSelectEnumSchema;
	return cast.type === 'string' && Array.isArray(cast.oneOf);
}

function isUntitledMultiEnumSchema(schema: MCPLegacy.PrimitiveSchemaDefinition): schema is MCPLegacy.UntitledMultiSelectEnumSchema {
	const cast = schema as MCPLegacy.UntitledMultiSelectEnumSchema;
	return cast.type === 'array' && !!cast.items?.enum;
}

function isTitledMultiEnumSchema(schema: MCPLegacy.PrimitiveSchemaDefinition): schema is MCPLegacy.TitledMultiSelectEnumSchema {
	const cast = schema as MCPLegacy.TitledMultiSelectEnumSchema;
	return cast.type === 'array' && !!cast.items?.anyOf;
}

//#region pure helpers

/**
 * What the service does with a URL-mode elicitation: refuse it outright
 * (elicitation.mdx "Safe URL Handling"), ask the user to open the URL, or,
 * when a modern server re-asks for a URL the user already opened, ask the
 * user to continue once they are done there.
 */
export type UrlElicitationPlan =
	| { readonly kind: 'reject'; readonly url: string; readonly reason: string }
	| {
		readonly kind: 'open' | 'resume';
		readonly url: string;
		/** The host as the browser resolves it: lower-cased ASCII, punycode for an IDN. */
		readonly hostname: string;
		/** The Unicode form of the host when it carries non-ASCII; `undefined` for a plain ASCII host. */
		readonly unicodeHostname: string | undefined;
		/**
		 * Legacy servers follow an accepted URL elicitation with
		 * `notifications/elicitation/complete`; modern servers learn the outcome
		 * when the client re-sends the tool call, so there is nothing to wait for.
		 */
		readonly waitsForCompletion: boolean;
	};

export function resolveUrlElicitationPlan(params: { readonly url: string }, options: IMcpElicitOptions | undefined, era: McpProtocolEra | undefined): UrlElicitationPlan {
	const check = isAcceptableElicitationUrl(params.url);
	if (!check.ok) {
		return { kind: 'reject', url: params.url, reason: check.reason ?? 'the URL is not acceptable' };
	}
	return {
		kind: options?.resume ? 'resume' : 'open',
		url: params.url,
		hostname: check.hostname,
		unicodeHostname: check.isIdn ? punycodeHostnameToUnicode(check.hostname) : undefined,
		waitsForCompletion: era !== 'modern',
	};
}

/** A form elicitation that asks for consent alone: there are no properties to fill in. */
export function isEmptyFormSchema(params: { readonly requestedSchema?: { readonly properties?: Readonly<Record<string, unknown>> } }): boolean {
	const properties = params.requestedSchema?.properties;
	return !properties || Object.keys(properties).length === 0;
}

/** Every ASCII punctuation character: CommonMark lets each be backslash-escaped, and an escaped character is never syntax. */
const MARKDOWN_PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g;

/**
 * Server-provided text as Markdown that renders literally, so no link can
 * form in it: not `[text](url)` nor `<url>`, and not the bare `https://…`,
 * `www.…` and e-mail autolinks that {@link MarkdownString.appendText} lets
 * through. elicitation.mdx "Safe URL Handling": clients SHOULD NOT render
 * URLs as clickable in any field of an elicitation request, except the `url`
 * of a URL elicitation (which the consent prompt shows as code, not a link).
 */
export function literalMarkdown(text: string): MarkdownString {
	const paragraphs = text.split(/\r\n|\r|\n/).map(line => line
		.replace(MARKDOWN_PUNCTUATION, '\\$&')
		// leading whitespace would otherwise start an indented code block
		.replace(/^[ \t]+/, indent => '&nbsp;'.repeat(indent.length)));
	return new MarkdownString(paragraphs.join('\n\n'));
}

/** Whether `text` could render as a link when shown as Markdown: link or autolink syntax, a URL, a `www.` host or an e-mail address. */
export function mayRenderAsLink(text: string): boolean {
	return /[[<@]|:\/\/|www\./i.test(text);
}

/**
 * The consent prompt for a URL elicitation: the server's message, the full
 * URL, the host it resolves to and, for an internationalized host, both its
 * Unicode and punycode spellings with a warning.
 */
export function buildUrlElicitationMessage(message: string, plan: Extract<UrlElicitationPlan, { kind: 'open' | 'resume' }>): MarkdownString {
	const md = literalMarkdown(message);
	md.appendMarkdown('\n\n' + (plan.kind === 'resume'
		? localize('mcp.elicit.url.resume', 'You already opened this URL. Continue once you have finished there.')
		: localize('mcp.elicit.url.instruction', 'Open this URL?')));
	md.appendCodeblock('', plan.url);
	if (plan.unicodeHostname !== undefined && plan.unicodeHostname !== plan.hostname) {
		md.appendMarkdown('\n\n' + localize('mcp.elicit.url.host.idn', 'Host: `{0}` (`{1}`)', plan.unicodeHostname, plan.hostname));
	} else {
		md.appendMarkdown('\n\n' + localize('mcp.elicit.url.host', 'Host: `{0}`', plan.hostname));
	}
	if (plan.unicodeHostname !== undefined) {
		md.appendMarkdown('\n\n' + localize('mcp.elicit.url.idnWarning', 'Warning: this host uses an internationalized domain name, which can look like a different site. Check it carefully before opening.'));
	}
	return md;
}

const PUNYCODE_BASE = 36;
const PUNYCODE_TMIN = 1;
const PUNYCODE_TMAX = 26;
const PUNYCODE_SKEW = 38;
const PUNYCODE_DAMP = 700;
const PUNYCODE_INITIAL_BIAS = 72;
const PUNYCODE_INITIAL_N = 128;

function punycodeAdapt(delta: number, numPoints: number, firstTime: boolean): number {
	delta = firstTime ? Math.floor(delta / PUNYCODE_DAMP) : delta >> 1;
	delta += Math.floor(delta / numPoints);
	let k = 0;
	while (delta > ((PUNYCODE_BASE - PUNYCODE_TMIN) * PUNYCODE_TMAX) >> 1) {
		delta = Math.floor(delta / (PUNYCODE_BASE - PUNYCODE_TMIN));
		k += PUNYCODE_BASE;
	}
	return k + Math.floor((PUNYCODE_BASE - PUNYCODE_TMIN + 1) * delta / (delta + PUNYCODE_SKEW));
}

function punycodeDigit(charCode: number): number {
	if (charCode >= 48 && charCode <= 57) {
		return charCode - 22; // '0'..'9' → 26..35
	}
	if (charCode >= 65 && charCode <= 90) {
		return charCode - 65; // 'A'..'Z' → 0..25
	}
	if (charCode >= 97 && charCode <= 122) {
		return charCode - 97; // 'a'..'z' → 0..25
	}
	return PUNYCODE_BASE;
}

/** RFC 3492 decoding of one label (without its `xn--` prefix); `undefined` when the label is malformed. */
function decodePunycodeLabel(input: string): string | undefined {
	const output: number[] = [];
	const basicEnd = input.lastIndexOf('-');
	for (let j = 0; j < Math.max(basicEnd, 0); j++) {
		const charCode = input.charCodeAt(j);
		if (charCode >= 0x80) {
			return undefined;
		}
		output.push(charCode);
	}

	let n = PUNYCODE_INITIAL_N;
	let i = 0;
	let bias = PUNYCODE_INITIAL_BIAS;
	for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length;) {
		const oldI = i;
		let w = 1;
		for (let k = PUNYCODE_BASE; ; k += PUNYCODE_BASE) {
			if (index >= input.length) {
				return undefined;
			}
			const digit = punycodeDigit(input.charCodeAt(index++));
			if (digit >= PUNYCODE_BASE) {
				return undefined;
			}
			i += digit * w;
			const t = k <= bias ? PUNYCODE_TMIN : k >= bias + PUNYCODE_TMAX ? PUNYCODE_TMAX : k - bias;
			if (digit < t) {
				break;
			}
			w *= PUNYCODE_BASE - t;
		}
		const outLength = output.length + 1;
		bias = punycodeAdapt(i - oldI, outLength, oldI === 0);
		n += Math.floor(i / outLength);
		i %= outLength;
		if (n > 0x10FFFF) {
			return undefined;
		}
		output.splice(i++, 0, n);
	}
	return String.fromCodePoint(...output);
}

/**
 * The Unicode spelling of a hostname whose labels may be punycode (`xn--`).
 * Hostnames are case-insensitive, so punycode labels are decoded in lower
 * case; labels that do not decode are kept as they are.
 */
export function punycodeHostnameToUnicode(hostname: string): string {
	return hostname.split('.').map(label => {
		const lower = label.toLowerCase();
		if (!lower.startsWith('xn--')) {
			return label;
		}
		return decodePunycodeLabel(lower.slice(4)) ?? label;
	}).join('.');
}

/** The era the server negotiated, if it has a live protocol handler. */
function getServerEra(server: IMcpServer): McpProtocolEra | undefined {
	const handler = server.connection.get()?.handler.get();
	try {
		return handler?.era;
	} catch {
		return undefined; // not negotiated yet
	}
}

/** The revision the server negotiated, if it has a live protocol handler; it decides how its form schemas are read. */
function getServerProtocolVersion(server: IMcpServer): string | undefined {
	return server.connection.get()?.handler.get()?.currentProtocolVersion;
}

//#endregion

export class McpElicitationService implements IMcpElicitationService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IChatService private readonly _chatService: IChatService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILogService private readonly _logService: ILogService,
	) { }

	public elicit(server: IMcpServer, context: IMcpToolCallContext | undefined, elicitation: MCPLegacy.ElicitRequest['params'], token: CancellationToken, options?: IMcpElicitOptions): Promise<ElicitResult> {
		if (isFormElicitation(elicitation)) {
			return this._elicitForm(server, context, elicitation, token);
		} else if (isUrlElicitation(elicitation)) {
			return this._elicitUrl(server, context, elicitation, token, options);
		} else {
			softAssertNever(elicitation);
			return Promise.reject(new MpcResponseError('Unsupported elicitation type', MCPLegacy.INVALID_PARAMS, undefined));
		}
	}

	private async _elicitForm(server: IMcpServer, context: IMcpToolCallContext | undefined, elicitation: MCPLegacy.ElicitRequestFormParams | Pre20251125ElicitationParams, token: CancellationToken): Promise<IFormModeElicitResult> {
		// basic/index.mdx (2026-07-28): a schema that does not compile is rejected, not treated as
		// permissive. Nothing is shown: the answer could not be validated. Servers speaking
		// 2025-11-25 or older get their form as before, with a warning in the log.
		const schemaProblem = checkElicitationSchema(elicitation.requestedSchema, getServerProtocolVersion(server), warning => {
			this._logService.warn(`[MCP] The form elicitation from "${server.definition.label}": ${warning}`);
		});
		if (schemaProblem !== undefined) {
			this._logService.warn(`[MCP] Declined the form elicitation from "${server.definition.label}" because its requested schema does not compile: ${schemaProblem}`);
			return { kind: ElicitationKind.Form, value: { action: 'decline' }, dispose: () => { } };
		}

		if (isEmptyFormSchema(elicitation)) {
			return this._elicitConsent(server, context, elicitation, token);
		}

		const store = new DisposableStore();
		const value = await new Promise<MCPLegacy.ElicitResult>(resolve => {
			const chatModel = context?.chatSessionResource && this._chatService.getSession(context.chatSessionResource);
			if (chatModel instanceof ChatModel) {
				const request = chatModel.getRequests().at(-1);
				if (request) {
					const { questions, idToPropertyMap } = this._convertSchemaToQuestions(elicitation);
					const carousel = new ChatQuestionCarouselData(
						questions,
						/* allowSkip */ true,
						/* resolveId */ undefined,
						/* data */ undefined,
						/* isUsed */ undefined,
						/* message */ literalMarkdown(elicitation.message),
						/* source */ mcpServerToSourceData(server),
					);

					chatModel.acceptResponseProgress(request, carousel);

					store.add(token.onCancellationRequested(() => {
						carousel.completion.complete({ answers: undefined });
					}));

					carousel.completion.p.then(result => {
						if (!result.answers) {
							resolve({ action: 'cancel' });
						} else {
							const content = this._convertCarouselAnswersToElicitResult(
								result.answers,
								idToPropertyMap,
								elicitation.requestedSchema.properties,
							);
							resolve({ action: 'accept', content });
						}
					});
					return;
				}
			}

			// Fallback: no chat session → notification + quickpick
			const handle = this._notificationService.notify({
				message: elicitation.message,
				source: localize('mcp.elicit.source', 'MCP Server ({0})', server.definition.label),
				severity: Severity.Info,
				actions: {
					primary: [store.add(new Action('mcp.elicit.give', localize('mcp.elicit.give', 'Respond'), undefined, true, () => resolve(this._doElicitForm(elicitation, token))))],
					secondary: [store.add(new Action('mcp.elicit.cancel', localize('mcp.elicit.cancel', 'Cancel'), undefined, true, () => resolve({ action: 'decline' })))],
				}
			});
			store.add(handle.onDidClose(() => resolve({ action: 'cancel' })));
			store.add(token.onCancellationRequested(() => resolve({ action: 'cancel' })));
			store.add(toDisposable(() => handle.close()));

		}).finally(() => store.dispose());

		return { kind: ElicitationKind.Form, value, dispose: () => { } };
	}

	/**
	 * A form elicitation without properties asks for consent alone: Accept
	 * returns an empty content object, Decline and Cancel return their actions.
	 */
	private async _elicitConsent(server: IMcpServer, context: IMcpToolCallContext | undefined, elicitation: MCPLegacy.ElicitRequestFormParams | Pre20251125ElicitationParams, token: CancellationToken): Promise<IFormModeElicitResult> {
		const store = new DisposableStore();
		let part: ChatElicitationRequestPart | undefined;
		const value = await new Promise<MCPLegacy.ElicitResult>(resolve => {
			if (token.isCancellationRequested) {
				resolve({ action: 'cancel' });
				return;
			}

			const chatModel = context?.chatSessionResource && this._chatService.getSession(context.chatSessionResource);
			const request = chatModel instanceof ChatModel ? chatModel.getRequests().at(-1) : undefined;
			if (chatModel instanceof ChatModel && request) {
				const cancelAction = store.add(new Action('mcp.elicit.consent.cancel', localize('mcp.elicit.cancel', 'Cancel'), undefined, true));
				part = new ChatElicitationRequestPart(
					localize('mcp.elicit.consent.title', 'Confirmation Required'),
					literalMarkdown(elicitation.message),
					localize('msg.subtitle', "{0} (MCP Server)", server.definition.label),
					localize('mcp.elicit.consent.accept', 'Accept'),
					localize('mcp.elicit.consent.decline', 'Decline'),
					async selected => {
						if (selected === true) {
							resolve({ action: 'accept', content: {} });
							return ElicitationState.Accepted;
						}
						resolve({ action: 'cancel' });
						return ElicitationState.Rejected;
					},
					() => {
						resolve({ action: 'decline' });
						return Promise.resolve(ElicitationState.Rejected);
					},
					mcpServerToSourceData(server),
					[cancelAction],
				);
				chatModel.acceptResponseProgress(request, part);
				store.add(token.onCancellationRequested(() => {
					part?.hide();
					resolve({ action: 'cancel' });
				}));
				return;
			}

			// Fallback: no chat session → notification
			const handle = this._notificationService.notify({
				message: elicitation.message,
				source: localize('mcp.elicit.source', 'MCP Server ({0})', server.definition.label),
				severity: Severity.Info,
				actions: {
					primary: [store.add(new Action('mcp.elicit.consent.accept', localize('mcp.elicit.consent.accept', 'Accept'), undefined, true, () => resolve({ action: 'accept', content: {} })))],
					secondary: [
						store.add(new Action('mcp.elicit.consent.decline', localize('mcp.elicit.consent.decline', 'Decline'), undefined, true, () => resolve({ action: 'decline' }))),
						store.add(new Action('mcp.elicit.consent.cancel', localize('mcp.elicit.cancel', 'Cancel'), undefined, true, () => resolve({ action: 'cancel' }))),
					],
				}
			});
			store.add(handle.onDidClose(() => resolve({ action: 'cancel' })));
			store.add(token.onCancellationRequested(() => resolve({ action: 'cancel' })));
			store.add(toDisposable(() => handle.close()));
		}).finally(() => store.dispose());

		return { kind: ElicitationKind.Form, value, dispose: () => part?.hide() };
	}

	private async _elicitUrl(server: IMcpServer, context: IMcpToolCallContext | undefined, elicitation: MCPLegacy.ElicitRequestURLParams, token: CancellationToken, options: IMcpElicitOptions | undefined): Promise<IUrlModeElicitResult> {
		const plan = resolveUrlElicitationPlan(elicitation, options, getServerEra(server));
		if (plan.kind === 'reject') {
			// elicitation.mdx "Safe URL Handling": nothing is opened or shown for a URL we will not navigate to.
			this._logService.warn(`[MCP] Declined the URL elicitation from "${server.definition.label}" because ${plan.reason}: ${elicitation.url}`);
			return { kind: ElicitationKind.URL, value: { action: 'decline' }, wait: Promise.resolve(), dispose: () => { } };
		}

		const promiseStore = new DisposableStore();
		let part: ChatElicitationRequestPart | undefined;

		// Legacy servers tell us when the out-of-band interaction is complete. We
		// listen ahead of time in case e.g. a user manually opens the URL beforehand.
		// Modern servers learn the outcome on the retried tool call, so the wait
		// ends as soon as the user has answered.
		let completePromise: Promise<void> | undefined;
		if (plan.waitsForCompletion) {
			completePromise = new Promise<void>((resolve, reject) => {
				promiseStore.add(token.onCancellationRequested(() => reject(new CancellationError())));
				promiseStore.add(autorun(reader => {
					const cnx = server.connection.read(reader);
					const handler = cnx?.handler.read(reader);
					if (handler) {
						reader.store.add(handler.onDidReceiveElicitationCompleteNotification(e => {
							if (e.params.elicitationId === elicitation.elicitationId) {
								resolve();
							}
						}));
					} else if (!McpConnectionState.isRunning(server.connectionState.read(reader))) {
						reject(new CancellationError());
					}
				}));
			}).finally(() => promiseStore.dispose());
		}

		const answer = (): Promise<MCPLegacy.ElicitResult> => {
			if (token.isCancellationRequested) {
				return Promise.resolve({ action: 'cancel' });
			}
			// A resumed elicitation was already opened in an earlier round: consent alone is asked for.
			return plan.kind === 'resume' ? Promise.resolve({ action: 'accept' }) : this._doElicitUrl(elicitation, token);
		};

		const store = new DisposableStore();
		const value = await new Promise<MCPLegacy.ElicitResult>(resolve => {
			const chatModel = context?.chatSessionResource && this._chatService.getSession(context.chatSessionResource);
			if (chatModel instanceof ChatModel) {
				const request = chatModel.getRequests().at(-1);
				if (request) {
					const chatPart = new ChatElicitationRequestPart(
						localize('mcp.elicit.url.title', 'Authorization Required'),
						buildUrlElicitationMessage(elicitation.message, plan),
						localize('msg.subtitle', "{0} (MCP Server)", server.definition.label),
						plan.kind === 'resume'
							? localize('mcp.elicit.url.continue', 'Continue')
							: localize('mcp.elicit.url.open', 'Open {0}', plan.hostname),
						localize('mcp.elicit.reject', 'Cancel'),
						async () => {
							const result = await answer();
							resolve(result);
							completePromise?.then(() => chatPart.hide(), () => { /* cancelled or stopped; the part is disposed with the result */ });
							return result.action === 'accept' ? ElicitationState.Accepted : ElicitationState.Rejected;
						},
						() => {
							resolve({ action: 'decline' });
							return Promise.resolve(ElicitationState.Rejected);
						},
						mcpServerToSourceData(server),
					);
					part = chatPart;
					chatModel.acceptResponseProgress(request, chatPart);
					store.add(token.onCancellationRequested(() => {
						chatPart.hide();
						resolve({ action: 'cancel' });
					}));
				}
			} else {
				const handle = this._notificationService.notify({
					message: elicitation.message + ' ' + (plan.kind === 'resume'
						? localize('mcp.elicit.url.resume2', 'You already opened {0}. Continue once you have finished there.', elicitation.url)
						: localize('mcp.elicit.url.instruction2', 'This will open {0}', elicitation.url)),
					source: localize('mcp.elicit.source', 'MCP Server ({0})', server.definition.label),
					severity: Severity.Info,
					actions: {
						primary: [store.add(new Action('mcp.elicit.url.open2', plan.kind === 'resume' ? localize('mcp.elicit.url.continue', 'Continue') : localize('mcp.elicit.url.open2', 'Open URL'), undefined, true, () => resolve(answer())))],
						secondary: [store.add(new Action('mcp.elicit.cancel', localize('mcp.elicit.cancel', 'Cancel'), undefined, true, () => resolve({ action: 'decline' })))],
					}
				});
				store.add(handle.onDidClose(() => resolve({ action: 'cancel' })));
				store.add(token.onCancellationRequested(() => resolve({ action: 'cancel' })));
				// A secondary action (Cancel) or a cancelled call answers without closing the
				// notification, and its Open URL would still open the URL: close it once answered.
				store.add(toDisposable(() => handle.close()));
			}
		}).finally(() => store.dispose());

		return {
			kind: ElicitationKind.URL,
			value,
			wait: completePromise ?? Promise.resolve(),
			dispose: () => {
				promiseStore.dispose();
				part?.hide();
			},
		};
	}

	private async _doElicitUrl(elicitation: MCPLegacy.ElicitRequestURLParams, token: CancellationToken): Promise<MCPLegacy.ElicitResult> {
		if (token.isCancellationRequested) {
			return { action: 'cancel' };
		}

		try {
			if (await this._openerService.open(elicitation.url, { allowCommands: false })) {
				return { action: 'accept' };
			}
		} catch {
			// ignored
		}

		return { action: 'decline' };
	}

	private async _doElicitForm(elicitation: MCPLegacy.ElicitRequestFormParams | Pre20251125ElicitationParams, token: CancellationToken): Promise<MCPLegacy.ElicitResult> {
		const quickPick = this._quickInputService.createQuickPick<IQuickPickItem>();
		const store = new DisposableStore();

		try {
			const properties = Object.entries(elicitation.requestedSchema.properties);
			const requiredFields = new Set(elicitation.requestedSchema.required || []);
			const results: Record<string, string | number | boolean | string[]> = {};
			const backSnapshots: { value: string; validationMessage?: string }[] = [];

			quickPick.title = elicitation.message;
			quickPick.totalSteps = properties.length;
			quickPick.ignoreFocusOut = true;

			for (let i = 0; i < properties.length; i++) {
				const [propertyName, schema] = properties[i];
				const isRequired = requiredFields.has(propertyName);
				const restore = backSnapshots.at(i);

				store.clear();
				quickPick.step = i + 1;
				quickPick.title = schema.title || propertyName;
				quickPick.placeholder = this._getFieldPlaceholder(schema, isRequired);
				quickPick.value = restore?.value ?? '';
				quickPick.validationMessage = '';
				quickPick.buttons = i > 0 ? [this._quickInputService.backButton] : [];

				let result: { type: 'value'; value: string | number | boolean | undefined | string[] } | { type: 'back' } | { type: 'cancel' };
				if (schema.type === 'boolean') {
					result = await this._handleEnumField(quickPick, { enum: [{ const: 'true' }, { const: 'false' }], default: schema.default ? String(schema.default) : undefined }, isRequired, store, token);
					if (result.type === 'value') { result.value = result.value === 'true' ? true : false; }
				} else if (isLegacyTitledEnumSchema(schema)) {
					result = await this._handleEnumField(quickPick, { enum: schema.enum.map((v, i) => ({ const: v, title: schema.enumNames[i] })), default: schema.default }, isRequired, store, token);
				} else if (isUntitledEnumSchema(schema)) {
					result = await this._handleEnumField(quickPick, { enum: schema.enum.map(v => ({ const: v })), default: schema.default }, isRequired, store, token);
				} else if (isTitledSingleEnumSchema(schema)) {
					result = await this._handleEnumField(quickPick, { enum: schema.oneOf, default: schema.default }, isRequired, store, token);
				} else if (isTitledMultiEnumSchema(schema)) {
					result = await this._handleMultiEnumField(quickPick, { enum: schema.items.anyOf, default: schema.default }, isRequired, store, token);
				} else if (isUntitledMultiEnumSchema(schema)) {
					result = await this._handleMultiEnumField(quickPick, { enum: schema.items.enum.map(v => ({ const: v })), default: schema.default }, isRequired, store, token);
				} else {
					result = await this._handleInputField(quickPick, schema, isRequired, store, token);
					if (result.type === 'value' && (schema.type === 'number' || schema.type === 'integer')) {
						result.value = Number(result.value);
					}
				}

				if (result.type === 'back') {
					i -= 2;
					continue;
				}
				if (result.type === 'cancel') {
					return { action: 'cancel' };
				}

				backSnapshots[i] = { value: quickPick.value };

				if (result.value === undefined) {
					delete results[propertyName];
				} else {
					results[propertyName] = result.value;
				}
			}

			return {
				action: 'accept',
				content: results,
			};
		} finally {
			store.dispose();
			quickPick.dispose();
		}
	}

	private _getFieldPlaceholder(schema: MCPLegacy.PrimitiveSchemaDefinition, required: boolean): string {
		let placeholder = schema.description || '';
		if (!required) {
			placeholder = placeholder ? `${placeholder} (${localize('optional', 'Optional')})` : localize('optional', 'Optional');
		}
		return placeholder;
	}

	private async _handleEnumField(
		quickPick: IQuickPick<IQuickPickItem>,
		schema: { default?: string; enum: { const: string; title?: string }[] },
		required: boolean,
		store: DisposableStore,
		token: CancellationToken
	) {
		const items: IQuickPickItem[] = schema.enum.map(({ const: value, title }) => ({
			id: value,
			label: value,
			description: title,
		}));

		if (!required) {
			items.push(noneItem);
		}

		quickPick.canSelectMany = false;
		quickPick.items = items;
		if (schema.default !== undefined) {
			quickPick.activeItems = items.filter(item => item.id === schema.default);
		}

		return new Promise<{ type: 'value'; value: string | undefined } | { type: 'back' } | { type: 'cancel' }>(resolve => {
			store.add(token.onCancellationRequested(() => resolve({ type: 'cancel' })));
			store.add(quickPick.onDidAccept(() => {
				const selected = quickPick.selectedItems[0];
				if (selected) {
					resolve({ type: 'value', value: selected.id });
				}
			}));
			store.add(quickPick.onDidTriggerButton(() => resolve({ type: 'back' })));
			store.add(quickPick.onDidHide(() => resolve({ type: 'cancel' })));

			quickPick.show();
		});
	}

	private async _handleMultiEnumField(
		quickPick: IQuickPick<IQuickPickItem>,
		schema: { default?: string[]; enum: { const: string; title?: string }[] },
		required: boolean,
		store: DisposableStore,
		token: CancellationToken
	) {
		const items: IQuickPickItem[] = schema.enum.map(({ const: value, title }) => ({
			id: value,
			label: value,
			description: title,
			picked: !!schema.default?.includes(value),
			pickable: true,
		}));

		if (!required) {
			items.push(noneItem);
		}

		quickPick.canSelectMany = true;
		quickPick.items = items;

		return new Promise<{ type: 'value'; value: string[] | undefined } | { type: 'back' } | { type: 'cancel' }>(resolve => {
			store.add(token.onCancellationRequested(() => resolve({ type: 'cancel' })));
			store.add(quickPick.onDidAccept(() => {
				const selected = quickPick.selectedItems[0];
				if (selected.id === undefined) {
					resolve({ type: 'value', value: undefined });
				} else {
					resolve({ type: 'value', value: quickPick.selectedItems.map(i => i.id).filter(isDefined) });
				}
			}));
			store.add(quickPick.onDidTriggerButton(() => resolve({ type: 'back' })));
			store.add(quickPick.onDidHide(() => resolve({ type: 'cancel' })));

			quickPick.show();
		});
	}

	private async _handleInputField(
		quickPick: IQuickPick<IQuickPickItem>,
		schema: MCPLegacy.NumberSchema | MCPLegacy.StringSchema,
		required: boolean,
		store: DisposableStore,
		token: CancellationToken
	) {
		quickPick.canSelectMany = false;

		const updateItems = () => {
			const items: IQuickPickItem[] = [];
			if (quickPick.value) {
				const validation = this._validateInput(quickPick.value, schema);
				quickPick.validationMessage = validation.message;
				if (validation.isValid) {
					items.push({ id: '$current', label: `\u27A4 ${quickPick.value}` });
				}
			} else {
				quickPick.validationMessage = '';

				if (schema.default) {
					items.push({ id: '$default', label: `${schema.default}`, description: localize('mcp.elicit.useDefault', 'Default value') });
				}
			}


			if (quickPick.validationMessage) {
				quickPick.severity = Severity.Warning;
			} else {
				quickPick.severity = Severity.Ignore;
				if (!required) {
					items.push(noneItem);
				}
			}

			quickPick.items = items;
		};

		updateItems();

		return new Promise<{ type: 'value'; value: string | undefined } | { type: 'back' } | { type: 'cancel' }>(resolve => {
			if (token.isCancellationRequested) {
				resolve({ type: 'cancel' });
				return;
			}

			store.add(token.onCancellationRequested(() => resolve({ type: 'cancel' })));
			store.add(quickPick.onDidChangeValue(updateItems));
			store.add(quickPick.onDidAccept(() => {
				const id = quickPick.selectedItems[0].id;
				if (!id) {
					resolve({ type: 'value', value: undefined });
				} else if (id === '$default') {
					resolve({ type: 'value', value: String(schema.default) });
				} else if (!quickPick.validationMessage) {
					resolve({ type: 'value', value: quickPick.value });
				}
			}));
			store.add(quickPick.onDidTriggerButton(() => resolve({ type: 'back' })));
			store.add(quickPick.onDidHide(() => resolve({ type: 'cancel' })));

			quickPick.show();
		});
	}

	private _validateInput(value: string, schema: MCPLegacy.NumberSchema | MCPLegacy.StringSchema): { isValid: boolean; message?: string } {
		switch (schema.type) {
			case 'string':
				return this._validateString(value, schema);
			case 'number':
			case 'integer':
				return this._validateNumber(value, schema);
			default:
				assertNever(schema);
		}
	}

	private _validateString(value: string, schema: MCPLegacy.StringSchema): { isValid: boolean; parsedValue?: string; message?: string } {
		if (schema.minLength && value.length < schema.minLength) {
			return { isValid: false, message: localize('mcp.elicit.validation.minLength', 'Minimum length is {0}', schema.minLength) };
		}
		if (schema.maxLength && value.length > schema.maxLength) {
			return { isValid: false, message: localize('mcp.elicit.validation.maxLength', 'Maximum length is {0}', schema.maxLength) };
		}
		if (schema.format) {
			const formatValid = this._validateStringFormat(value, schema.format);
			if (!formatValid.isValid) {
				return formatValid;
			}
		}
		return { isValid: true, parsedValue: value };
	}

	private _validateStringFormat(value: string, format: string): { isValid: boolean; message?: string } {
		switch (format) {
			case 'email':
				return value.includes('@')
					? { isValid: true }
					: { isValid: false, message: localize('mcp.elicit.validation.email', 'Please enter a valid email address') };
			case 'uri':
				if (URL.canParse(value)) {
					return { isValid: true };
				} else {
					return { isValid: false, message: localize('mcp.elicit.validation.uri', 'Please enter a valid URI') };
				}
			case 'date': {
				const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
				if (!dateRegex.test(value)) {
					return { isValid: false, message: localize('mcp.elicit.validation.date', 'Please enter a valid date (YYYY-MM-DD)') };
				}
				const date = new Date(value);
				return !isNaN(date.getTime())
					? { isValid: true }
					: { isValid: false, message: localize('mcp.elicit.validation.date', 'Please enter a valid date (YYYY-MM-DD)') };
			}
			case 'date-time': {
				const dateTime = new Date(value);
				return !isNaN(dateTime.getTime())
					? { isValid: true }
					: { isValid: false, message: localize('mcp.elicit.validation.dateTime', 'Please enter a valid date-time') };
			}
			default:
				return { isValid: true };
		}
	}

	private _validateNumber(value: string, schema: MCPLegacy.NumberSchema): { isValid: boolean; parsedValue?: number; message?: string } {
		const parsed = Number(value);
		if (isNaN(parsed)) {
			return { isValid: false, message: localize('mcp.elicit.validation.number', 'Please enter a valid number') };
		}
		if (schema.type === 'integer' && !Number.isInteger(parsed)) {
			return { isValid: false, message: localize('mcp.elicit.validation.integer', 'Please enter a valid integer') };
		}
		if (schema.minimum !== undefined && parsed < schema.minimum) {
			return { isValid: false, message: localize('mcp.elicit.validation.minimum', 'Minimum value is {0}', schema.minimum) };
		}
		if (schema.maximum !== undefined && parsed > schema.maximum) {
			return { isValid: false, message: localize('mcp.elicit.validation.maximum', 'Maximum value is {0}', schema.maximum) };
		}
		return { isValid: true, parsedValue: parsed };
	}

	/**
	 * Converts an MCP elicitation schema into IChatQuestion[] for the carousel UI.
	 * Returns the questions and a map from question ID to schema property name.
	 */
	private _convertSchemaToQuestions(elicitation: MCPLegacy.ElicitRequestFormParams | Pre20251125ElicitationParams): { questions: IChatQuestion[]; idToPropertyMap: Map<string, string> } {
		const properties = Object.entries(elicitation.requestedSchema.properties);
		const requiredFields = new Set(elicitation.requestedSchema.required || []);
		const questions: IChatQuestion[] = [];
		const idToPropertyMap = new Map<string, string>();

		for (const [propertyName, schema] of properties) {
			const id = generateUuid();
			idToPropertyMap.set(id, propertyName);

			const title = schema.title || propertyName;
			const description = schema.description;
			const isRequired = requiredFields.has(propertyName);

			if (schema.type === 'boolean') {
				questions.push({
					id,
					type: 'singleSelect',
					title,
					description,
					required: isRequired,
					allowFreeformInput: false,
					options: [
						{ id: 'true', label: localize('mcp.elicit.true', 'True'), value: 'true' },
						{ id: 'false', label: localize('mcp.elicit.false', 'False'), value: 'false' },
					],
					defaultValue: schema.default !== undefined ? String(schema.default) : undefined,
				});
			} else if (isLegacyTitledEnumSchema(schema)) {
				questions.push({
					id,
					type: 'singleSelect',
					title,
					description,
					required: isRequired,
					allowFreeformInput: false,
					options: schema.enum.map((v, i) => ({
						id: v,
						label: schema.enumNames[i] ? `${v} - ${schema.enumNames[i]}` : v,
						value: v,
					})),
					defaultValue: schema.default,
				});
			} else if (isTitledSingleEnumSchema(schema)) {
				questions.push({
					id,
					type: 'singleSelect',
					title,
					description,
					required: isRequired,
					allowFreeformInput: false,
					options: schema.oneOf.map(({ const: value, title: optTitle }) => ({
						id: value,
						label: optTitle ? `${value} - ${optTitle}` : value,
						value,
					})),
					defaultValue: schema.default,
				});
			} else if (isUntitledEnumSchema(schema)) {
				questions.push({
					id,
					type: 'singleSelect',
					title,
					description,
					required: isRequired,
					allowFreeformInput: false,
					options: schema.enum.map(v => ({ id: v, label: v, value: v })),
					defaultValue: schema.default,
				});
			} else if (isTitledMultiEnumSchema(schema)) {
				questions.push({
					id,
					type: 'multiSelect',
					title,
					description,
					required: isRequired,
					allowFreeformInput: false,
					options: schema.items.anyOf.map(({ const: value, title: optTitle }) => ({
						id: value,
						label: optTitle ? `${value} - ${optTitle}` : value,
						value,
					})),
					defaultValue: schema.default,
				});
			} else if (isUntitledMultiEnumSchema(schema)) {
				questions.push({
					id,
					type: 'multiSelect',
					title,
					description,
					required: isRequired,
					allowFreeformInput: false,
					options: schema.items.enum.map(v => ({ id: v, label: v, value: v })),
					defaultValue: schema.default,
				});
			} else {
				// String, number, integer → text input with validation
				const validation: IChatQuestionValidation = {};
				if (schema.type === 'string') {
					if (schema.minLength !== undefined) { validation.minLength = schema.minLength; }
					if (schema.maxLength !== undefined) { validation.maxLength = schema.maxLength; }
					if (schema.format) { validation.format = schema.format; }
				} else if (schema.type === 'number' || schema.type === 'integer') {
					if (schema.minimum !== undefined) { validation.minimum = schema.minimum; }
					if (schema.maximum !== undefined) { validation.maximum = schema.maximum; }
					if (schema.type === 'integer') { validation.isInteger = true; }
				}

				questions.push({
					id,
					type: 'text',
					title,
					description,
					required: isRequired,
					defaultValue: schema.default !== undefined ? String(schema.default) : undefined,
					validation: Object.keys(validation).length > 0 ? validation : undefined,
				});
			}
		}

		// The carousel renders a question's title as Markdown (descriptions and
		// option labels as text). A title that could form a link is shown
		// literally instead; other titles keep their plain-text form, which the
		// answer summary shows as it is.
		for (const question of questions) {
			if (mayRenderAsLink(question.title)) {
				question.message = literalMarkdown(question.title);
			}
		}

		return { questions, idToPropertyMap };
	}

	/**
	 * Converts carousel answers (keyed by question ID) back into the
	 * MCP ElicitResult content format (keyed by schema property names),
	 * coercing types as needed.
	 */
	private _convertCarouselAnswersToElicitResult(
		answers: IChatQuestionAnswers,
		idToPropertyMap: Map<string, string>,
		schemaProperties: Record<string, MCPLegacy.PrimitiveSchemaDefinition>,
	): Record<string, string | number | boolean | string[]> {
		const content: Record<string, string | number | boolean | string[]> = {};

		for (const [questionId, answer] of Object.entries(answers)) {
			const propertyName = idToPropertyMap.get(questionId);
			if (!propertyName) {
				continue;
			}

			const schema = schemaProperties[propertyName];
			if (!schema) {
				continue;
			}

			// Extract the raw value from structured answers
			let rawValue: unknown = answer;
			if (typeof answer === 'object' && answer !== null) {
				const obj = answer as Record<string, unknown>;
				if ('selectedValue' in obj) {
					rawValue = obj.selectedValue;
				} else if ('selectedValues' in obj) {
					rawValue = obj.selectedValues;
				} else if ('freeformValue' in obj && obj.freeformValue) {
					rawValue = obj.freeformValue;
				}
			}

			if (rawValue === undefined || rawValue === null) {
				continue;
			}

			// Type coercion based on schema
			if (schema.type === 'boolean') {
				content[propertyName] = rawValue === 'true' || rawValue === true;
			} else if (schema.type === 'number' || schema.type === 'integer') {
				const num = Number(rawValue);
				if (!isNaN(num)) {
					content[propertyName] = num;
				}
			} else if (schema.type === 'array') {
				if (Array.isArray(rawValue)) {
					content[propertyName] = rawValue.map(v => String(v));
				}
			} else {
				content[propertyName] = String(rawValue);
			}
		}

		return content;
	}
}
