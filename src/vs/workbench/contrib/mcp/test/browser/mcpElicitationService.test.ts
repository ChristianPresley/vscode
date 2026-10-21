/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { renderMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IMarkdownString, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { McpProtocolEra } from '../../../../../platform/mcp/common/mcpProtocolVersions.js';
import { INotification, INotificationHandle, INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService, OpenExternalOptions, OpenInternalOptions } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { TestQuickInputService } from '../../../../test/browser/workbenchTestServices.js';
import { TestExtensionService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ElicitationState, IChatElicitationRequest, IChatService } from '../../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { ChatModel } from '../../../chat/common/model/chatModel.js';
import { ChatQuestionCarouselData } from '../../../chat/common/model/chatProgressTypes/chatQuestionCarouselData.js';
import { ChatAgentService, IChatAgentService } from '../../../chat/common/participants/chatAgents.js';
import { MockChatService } from '../../../chat/test/common/chatService/mockChatService.js';
import { buildUrlElicitationMessage, isEmptyFormSchema, literalMarkdown, mayRenderAsLink, McpElicitationService, punycodeHostnameToUnicode, resolveUrlElicitationPlan } from '../../browser/mcpElicitationService.js';
import { McpServerRequestHandler } from '../../common/mcpServerRequestHandler.js';
import { ElicitationKind, ElicitResult, IMcpServer, IMcpServerConnection, IMcpToolCallContext, IUrlModeElicitResult, McpConnectionState } from '../../common/mcpTypes.js';
import { MCPLegacy } from '../../common/modelContextProtocolLegacy.js';

class RecordingLogService extends NullLogService {
	readonly warnings: string[] = [];
	override warn(message: string): void {
		this.warnings.push(message);
	}
}

class RecordingNotificationService extends TestNotificationService {
	readonly notifications: INotification[] = [];
	override notify(notification: INotification): INotificationHandle {
		this.notifications.push(notification);
		return super.notify(notification);
	}
}

suite('McpElicitationService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** Renders Markdown through the renderer the chat uses (marked, with GFM autolinks). */
	function render(md: string | IMarkdownString): HTMLElement {
		return store.add(renderMarkdown(typeof md === 'string' ? new MarkdownString(md) : md)).element;
	}

	const countLinks = (element: HTMLElement) => element.getElementsByTagName('a').length;

	suite('resolveUrlElicitationPlan', () => {
		const url = (u: string, options?: { resume?: boolean }, era: McpProtocolEra | undefined = 'legacy') => resolveUrlElicitationPlan({ url: u }, options, era);

		test('accepts https and loopback http, declines everything else', () => {
			assert.deepStrictEqual([
				url('https://example.com/auth?x=1').kind,
				url('http://127.0.0.1:8080/callback').kind,
				url('http://localhost/callback').kind,
				url('http://example.com/auth').kind,
				url('https://user:secret@example.com/auth').kind,
				url('https://user@example.com/auth').kind,
				url('ftp://example.com/').kind,
				url('not a url').kind,
			], ['open', 'open', 'open', 'reject', 'reject', 'reject', 'reject', 'reject']);
		});

		test('names the reason a URL is rejected', () => {
			const scheme = url('http://example.com/auth');
			const credentials = url('https://user:secret@example.com/auth');
			assert.strictEqual(scheme.kind, 'reject');
			assert.strictEqual(credentials.kind, 'reject');
			assert.ok(scheme.reason.includes('scheme'), scheme.reason);
			assert.ok(credentials.reason.includes('credentials'), credentials.reason);
		});

		test('carries the host and both IDN spellings', () => {
			const plain = url('https://Example.com/auth');
			const unicode = url('https://bücher.example/login');
			const punycode = url('https://xn--mnchen-3ya.de/login');
			assert.strictEqual(plain.kind, 'open');
			assert.strictEqual(unicode.kind, 'open');
			assert.strictEqual(punycode.kind, 'open');
			assert.deepStrictEqual(
				[plain, unicode, punycode].map(p => [p.hostname, p.unicodeHostname]),
				[['example.com', undefined], ['xn--bcher-kva.example', 'bücher.example'], ['xn--mnchen-3ya.de', 'münchen.de']],
			);
		});

		test('resume asks for consent without opening again', () => {
			assert.strictEqual(url('https://example.com/auth', { resume: true }).kind, 'resume');
			assert.strictEqual(url('https://example.com/auth', { resume: false }).kind, 'open');
			assert.strictEqual(url('http://example.com/auth', { resume: true }).kind, 'reject');
		});

		test('only legacy servers are waited on for the completion notification', () => {
			const plan = (era: McpProtocolEra | undefined) => {
				const p = url('https://example.com/auth', undefined, era);
				return p.kind === 'reject' ? undefined : p.waitsForCompletion;
			};
			assert.deepStrictEqual([plan('legacy'), plan('modern'), plan(undefined)], [true, false, true]);
		});
	});

	suite('punycodeHostnameToUnicode', () => {
		test('decodes xn-- labels and leaves the rest alone', () => {
			assert.deepStrictEqual([
				punycodeHostnameToUnicode('xn--bcher-kva.example'),
				punycodeHostnameToUnicode('www.XN--MNCHEN-3YA.de'),
				punycodeHostnameToUnicode('xn--e1afmkfd.xn--p1ai'),
				punycodeHostnameToUnicode('example.com'),
				punycodeHostnameToUnicode('xn--!!!.example'),
			], ['bücher.example', 'www.münchen.de', 'пример.рф', 'example.com', 'xn--!!!.example']);
		});
	});

	suite('literalMarkdown', () => {
		const linkish = [
			'Sign in at https://evil.example/login',
			'or visit www.evil.example today',
			'write to admin@evil.example',
			'[Click here](https://evil.example/)',
			'![pixel](https://evil.example/pixel.png)',
			'<https://evil.example/>',
			'<a href="https://evil.example/">here</a>',
			'[terms]\n\n[terms]: https://evil.example/terms',
		];

		test('renders no link, autolink or image', () => {
			for (const text of linkish) {
				const element = render(literalMarkdown(text));
				assert.deepStrictEqual([countLinks(element), element.getElementsByTagName('img').length], [0, 0], text);
			}
		});

		test('the renderer links the same text when it is Markdown or appendText', () => {
			// Guards the test above: these do turn into links when not made literal.
			assert.strictEqual(countLinks(render(new MarkdownString().appendText('Sign in at https://evil.example/login'))), 1);
			assert.strictEqual(countLinks(render(new MarkdownString('[Click here](https://evil.example/)'))), 1);
		});

		test('shows the text as it is, one paragraph per line', () => {
			const lines = [
				'**not bold** _not emphasis_ `not code`',
				'# not a heading',
				'  - not a list item',
				'1. not a list',
				'> not a quote',
				'| not | a table |',
				'\\ $(not-an-icon) &amp; <b>not bold</b>',
			];
			const element = render(literalMarkdown(lines.join('\n')));
			assert.deepStrictEqual([...element.getElementsByTagName('p')].map(p => p.textContent?.replace(/\xa0/g, ' ')), lines);
			assert.deepStrictEqual(['strong', 'em', 'code', 'h1', 'li', 'blockquote', 'table', 'b'].map(tag => element.getElementsByTagName(tag).length), [0, 0, 0, 0, 0, 0, 0, 0]);
		});

		test('mayRenderAsLink spots link syntax, URLs, www hosts and e-mail addresses', () => {
			assert.deepStrictEqual(
				[...linkish, 'WWW.Example.org', 'ftp://example.org', 'Name', 'Age (years)', 'Note: optional', 'e.g. 42'].map(mayRenderAsLink),
				[true, true, true, true, true, true, true, true, true, true, false, false, false, false],
			);
		});
	});

	suite('buildUrlElicitationMessage', () => {
		test('shows the full URL and the host', () => {
			const plan = resolveUrlElicitationPlan({ url: 'https://example.com/auth?state=abc' }, undefined, 'modern');
			assert.strictEqual(plan.kind, 'open');
			const md = buildUrlElicitationMessage('Please sign in.', plan);
			const text = render(md).textContent ?? '';
			assert.ok(text.includes('Please sign in.'), text);
			assert.ok(text.includes('https://example.com/auth?state=abc'), text);
			assert.ok(md.value.includes('`example.com`'), md.value);
			assert.ok(!text.includes('internationalized'), text);
		});

		test('shows the server message literally and the URL as code, so nothing is a link', () => {
			const plan = resolveUrlElicitationPlan({ url: 'https://example.com/auth' }, undefined, 'modern');
			assert.strictEqual(plan.kind, 'open');
			const message = 'Sign in at [the portal](https://evil.example/) or https://evil.example/ instead.';
			const element = render(buildUrlElicitationMessage(message, plan));
			assert.strictEqual(countLinks(element), 0);
			assert.strictEqual(element.getElementsByTagName('p')[0]?.textContent, message);
			assert.ok([...element.getElementsByTagName('code')].some(code => code.textContent?.includes('https://example.com/auth')), element.innerHTML);
		});

		test('shows both spellings and a warning for an IDN host', () => {
			const plan = resolveUrlElicitationPlan({ url: 'https://bücher.example/login' }, undefined, 'modern');
			assert.strictEqual(plan.kind, 'open');
			const message = buildUrlElicitationMessage('Sign in.', plan).value;
			assert.ok(message.includes('`bücher.example`'), message);
			assert.ok(message.includes('`xn--bcher-kva.example`'), message);
			assert.ok(message.includes('internationalized domain name'), message);
		});

		test('tells a resumed elicitation apart', () => {
			const plan = resolveUrlElicitationPlan({ url: 'https://example.com/auth' }, { resume: true }, 'modern');
			assert.strictEqual(plan.kind, 'resume');
			const message = buildUrlElicitationMessage('Sign in.', plan).value;
			assert.ok(message.includes('already opened'), message);
			assert.ok(!message.includes('Open this URL?'), message);
		});
	});

	suite('isEmptyFormSchema', () => {
		test('is true without properties', () => {
			assert.deepStrictEqual([
				isEmptyFormSchema({ requestedSchema: { properties: {} } }),
				isEmptyFormSchema({ requestedSchema: {} }),
				isEmptyFormSchema({}),
				isEmptyFormSchema({ requestedSchema: { properties: { name: { type: 'string' } } } }),
			], [true, true, true, false]);
		});
	});

	suite('service', () => {
		let instantiationService: TestInstantiationService;
		let chatService: MockChatService;
		let logService: RecordingLogService;
		let notificationService: RecordingNotificationService;
		let opened: { target: string; options: OpenInternalOptions | OpenExternalOptions | undefined }[];
		let service: McpElicitationService;

		setup(() => {
			opened = [];
			instantiationService = store.add(new TestInstantiationService());
			chatService = new MockChatService();
			logService = new RecordingLogService();
			notificationService = new RecordingNotificationService();
			instantiationService.stub(IStorageService, store.add(new TestStorageService()));
			instantiationService.stub(ILogService, logService);
			instantiationService.stub(IExtensionService, new TestExtensionService());
			instantiationService.stub(IContextKeyService, new MockContextKeyService());
			instantiationService.stub(IChatAgentService, store.add(instantiationService.createInstance(ChatAgentService)));
			instantiationService.stub(IConfigurationService, new TestConfigurationService());
			instantiationService.stub(IChatService, chatService);
			instantiationService.stub(INotificationService, notificationService);
			instantiationService.stub(IQuickInputService, new TestQuickInputService());
			instantiationService.stub(IOpenerService, upcastPartial<IOpenerService>({
				open: async (target: URI | string, options?: OpenInternalOptions | OpenExternalOptions) => {
					opened.push({ target: String(target), options });
					return true;
				},
			}));
			service = instantiationService.createInstance(McpElicitationService);
		});

		function createServer(era: McpProtocolEra | undefined) {
			const onDidComplete = store.add(new Emitter<MCPLegacy.ElicitationCompleteNotification>());
			const handler = era === undefined ? undefined : upcastPartial<McpServerRequestHandler>({
				era,
				currentProtocolVersion: era === 'modern' ? '2026-07-28' : '2025-11-25',
				onDidReceiveElicitationCompleteNotification: onDidComplete.event,
			});
			const connection = upcastPartial<IMcpServerConnection>({ handler: constObservable(handler) });
			const server = upcastPartial<IMcpServer>({
				definition: { id: 'test-server', label: 'Test Server' },
				collection: { id: 'test-collection', label: 'Test Collection', order: 0 },
				connection: constObservable(connection),
				connectionState: constObservable<McpConnectionState>({ state: McpConnectionState.Kind.Running }),
				serverMetadata: constObservable(undefined),
			});
			return { server, onDidComplete };
		}

		function createChat() {
			const model = store.add(instantiationService.createInstance(ChatModel, undefined, { initialLocation: ChatAgentLocation.Chat, canUseTools: true }));
			chatService.addSession(model);
			const request = model.addRequest({ text: 'hello', parts: [] }, { variables: [] }, 0);
			const context: IMcpToolCallContext = { chatSessionResource: model.sessionResource };
			const parts = () => request.response?.response.value ?? [];
			const elicitationPart = () => parts().find((p): p is IChatElicitationRequest => p.kind === 'elicitation2');
			const carouselPart = () => parts().find((p): p is ChatQuestionCarouselData => p instanceof ChatQuestionCarouselData);
			return { model, context, parts, elicitationPart, carouselPart };
		}

		const urlElicitation = (url: string, elicitationId = 'elicit-1'): MCPLegacy.ElicitRequestURLParams => ({ mode: 'url', message: 'Please sign in.', url, elicitationId });

		const asUrl = (result: ElicitResult): IUrlModeElicitResult => {
			if (result.kind !== ElicitationKind.URL) {
				throw new Error('expected a URL-mode result');
			}
			return result;
		};

		const settles = async (promise: Promise<unknown>): Promise<boolean> => {
			let settled = false;
			promise.then(() => { settled = true; }, () => { settled = true; });
			await timeout(0);
			return settled;
		};

		test('opens an accepted https URL through the opener without bypassing trusted-domain checks', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('https://example.com/auth'), CancellationToken.None);
			const part = chat.elicitationPart();
			assert.ok(part, 'expected an elicitation part in the chat');
			assert.strictEqual(part.acceptButtonLabel, 'Open example.com');
			assert.strictEqual(opened.length, 0, 'nothing is opened before consent');

			await part.accept(true);
			const result = await pending;
			assert.deepStrictEqual(opened, [{ target: 'https://example.com/auth', options: { allowCommands: false } }]);
			assert.deepStrictEqual({ kind: result.kind, value: result.value, state: part.state.get() }, { kind: ElicitationKind.URL, value: { action: 'accept' }, state: ElicitationState.Accepted });
			result.dispose();
		});

		test('opens an accepted loopback http URL', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('http://127.0.0.1:8080/callback'), CancellationToken.None);
			await chat.elicitationPart()!.accept(true);
			const result = await pending;
			assert.deepStrictEqual(opened.map(o => o.target), ['http://127.0.0.1:8080/callback']);
			assert.deepStrictEqual(result.value, { action: 'accept' });
			result.dispose();
		});

		test('declines a plain http URL without showing or opening anything', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const result = asUrl(await service.elicit(server, chat.context, urlElicitation('http://example.com/auth'), CancellationToken.None));
			assert.deepStrictEqual({ kind: result.kind, value: result.value, parts: chat.parts().length, opened: opened.length }, { kind: ElicitationKind.URL, value: { action: 'decline' }, parts: 0, opened: 0 });
			assert.strictEqual(await settles(result.wait), true, 'wait is resolved for a declined URL');
			assert.strictEqual(logService.warnings.length, 1);
			assert.ok(logService.warnings[0].includes('scheme') && logService.warnings[0].includes('http://example.com/auth'), logService.warnings[0]);
			result.dispose();
		});

		test('declines a URL carrying credentials without opening anything', async () => {
			const { server } = createServer('legacy');
			const chat = createChat();
			const result = await service.elicit(server, chat.context, urlElicitation('https://user:secret@example.com/auth'), CancellationToken.None);
			assert.deepStrictEqual({ value: result.value, parts: chat.parts().length, opened: opened.length }, { value: { action: 'decline' }, parts: 0, opened: 0 });
			assert.ok(logService.warnings[0]?.includes('credentials'), logService.warnings.join('\n'));
			result.dispose();
		});

		test('shows both spellings of an internationalized host', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('https://bücher.example/login'), CancellationToken.None);
			const part = chat.elicitationPart()!;
			const message = typeof part.message === 'string' ? part.message : part.message.value;
			assert.ok(message.includes('https://bücher.example/login'), message);
			assert.ok(message.includes('`bücher.example`') && message.includes('`xn--bcher-kva.example`'), message);
			assert.ok(message.includes('internationalized domain name'), message);
			assert.strictEqual(part.acceptButtonLabel, 'Open xn--bcher-kva.example');

			await part.reject!();
			const result = await pending;
			assert.deepStrictEqual({ value: result.value, opened: opened.length }, { value: { action: 'decline' }, opened: 0 });
			result.dispose();
		});

		test('resume offers Continue and does not open the URL again', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('https://example.com/auth'), CancellationToken.None, { resume: true });
			const part = chat.elicitationPart()!;
			assert.strictEqual(part.acceptButtonLabel, 'Continue');
			await part.accept(true);
			const result = asUrl(await pending);
			assert.deepStrictEqual({ value: result.value, opened: opened.length, state: part.state.get() }, { value: { action: 'accept' }, opened: 0, state: ElicitationState.Accepted });
			assert.strictEqual(await settles(result.wait), true);
			result.dispose();
		});

		test('a modern server resolves wait as soon as the URL is accepted', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('https://example.com/auth'), CancellationToken.None);
			await chat.elicitationPart()!.accept(true);
			const result = asUrl(await pending);
			assert.strictEqual(await settles(result.wait), true);
			result.dispose();
		});

		test('a legacy server is waited on for notifications/elicitation/complete', async () => {
			const { server, onDidComplete } = createServer('legacy');
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('https://example.com/auth', 'elicit-42'), CancellationToken.None);
			const part = chat.elicitationPart()!;
			await part.accept(true);
			const result = asUrl(await pending);
			assert.deepStrictEqual(result.value, { action: 'accept' });
			assert.strictEqual(await settles(result.wait), false, 'wait stays pending until the server reports completion');

			onDidComplete.fire({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: 'other' } });
			assert.strictEqual(await settles(result.wait), false, 'another elicitation completing does not count');

			onDidComplete.fire({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: 'elicit-42' } });
			await result.wait;
			assert.strictEqual(part.isHidden?.get(), true, 'the part is hidden once the server reports completion');
			result.dispose();
		});

		test('a server without a negotiated era is treated as legacy', async () => {
			const { server } = createServer(undefined);
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('https://example.com/auth'), CancellationToken.None);
			await chat.elicitationPart()!.accept(true);
			const result = asUrl(await pending);
			assert.strictEqual(await settles(result.wait), false);
			result.dispose();
		});

		test('disposing the result hides the URL part', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const pending = service.elicit(server, chat.context, urlElicitation('https://example.com/auth'), CancellationToken.None);
			const part = chat.elicitationPart()!;
			await part.accept(true);
			const result = await pending;
			assert.strictEqual(part.isHidden?.get(), false);
			result.dispose();
			assert.strictEqual(part.isHidden?.get(), true);
		});

		test('cancelling the token hides the URL part and answers cancel', async () => {
			const { server } = createServer('modern');
			const chat = createChat();
			const cts = store.add(new CancellationTokenSource());
			const pending = service.elicit(server, chat.context, urlElicitation('https://example.com/auth'), cts.token);
			const part = chat.elicitationPart()!;
			cts.cancel();
			const result = await pending;
			assert.deepStrictEqual({ value: result.value, hidden: part.isHidden?.get(), opened: opened.length }, { value: { action: 'cancel' }, hidden: true, opened: 0 });
			result.dispose();
		});

		test('falls back to a notification without a chat session', async () => {
			const { server } = createServer('modern');
			const pending = service.elicit(server, undefined, urlElicitation('https://example.com/auth'), CancellationToken.None, { resume: true });
			assert.strictEqual(notificationService.notifications.length, 1);
			const notification = notificationService.notifications[0];
			assert.strictEqual(notification.actions?.primary?.[0].label, 'Continue');
			await notification.actions!.primary![0].run();
			const result = await pending;
			assert.deepStrictEqual({ value: result.value, opened: opened.length }, { value: { action: 'accept' }, opened: 0 });
			result.dispose();
		});

		suite('form without properties', () => {
			const consent: MCPLegacy.ElicitRequestFormParams = { mode: 'form', message: 'Delete the branch?', requestedSchema: { type: 'object', properties: {} } };

			test('Accept answers with empty content', async () => {
				const { server } = createServer('modern');
				const chat = createChat();
				const pending = service.elicit(server, chat.context, consent, CancellationToken.None);
				const part = chat.elicitationPart();
				assert.ok(part, 'expected a consent part rather than a question carousel');
				assert.strictEqual(chat.carouselPart(), undefined);
				assert.deepStrictEqual([part.acceptButtonLabel, part.rejectButtonLabel, part.moreActions?.map(a => a.label)], ['Accept', 'Decline', ['Cancel']]);
				await part.accept(true);
				const result = await pending;
				assert.deepStrictEqual({ kind: result.kind, value: result.value }, { kind: ElicitationKind.Form, value: { action: 'accept', content: {} } });
				result.dispose();
				assert.strictEqual(part.isHidden?.get(), true);
			});

			test('Decline answers decline', async () => {
				const { server } = createServer('legacy');
				const chat = createChat();
				const pending = service.elicit(server, chat.context, consent, CancellationToken.None);
				await chat.elicitationPart()!.reject!();
				const result = await pending;
				assert.deepStrictEqual(result.value, { action: 'decline' });
				result.dispose();
			});

			test('Cancel answers cancel', async () => {
				const { server } = createServer('legacy');
				const chat = createChat();
				const pending = service.elicit(server, chat.context, consent, CancellationToken.None);
				const part = chat.elicitationPart()!;
				await part.accept(part.moreActions![0]);
				const result = await pending;
				assert.deepStrictEqual(result.value, { action: 'cancel' });
				result.dispose();
			});

			test('a missing properties object is consent too', async () => {
				const { server } = createServer('legacy');
				const chat = createChat();
				const legacyParams = { message: 'Proceed?', requestedSchema: { type: 'object' } } as unknown as MCPLegacy.ElicitRequestFormParams;
				const pending = service.elicit(server, chat.context, legacyParams, CancellationToken.None);
				await chat.elicitationPart()!.accept(true);
				const result = await pending;
				assert.deepStrictEqual(result.value, { action: 'accept', content: {} });
				result.dispose();
			});

			test('falls back to a notification without a chat session', async () => {
				const { server } = createServer('modern');
				const first = service.elicit(server, undefined, consent, CancellationToken.None);
				const notification = notificationService.notifications[0];
				assert.deepStrictEqual([notification.actions?.primary?.map(a => a.label), notification.actions?.secondary?.map(a => a.label)], [['Accept'], ['Decline', 'Cancel']]);
				await notification.actions!.primary![0].run();
				assert.deepStrictEqual((await first).value, { action: 'accept', content: {} });

				const second = service.elicit(server, undefined, consent, CancellationToken.None);
				await notificationService.notifications[1].actions!.secondary![0].run();
				assert.deepStrictEqual((await second).value, { action: 'decline' });
			});
		});

		suite('form with properties', () => {
			test('pre-fills defaults (SEP-1034) and converts the answers', async () => {
				const { server } = createServer('modern');
				const chat = createChat();
				const params: MCPLegacy.ElicitRequestFormParams = {
					mode: 'form',
					message: 'Contact details',
					requestedSchema: {
						type: 'object',
						properties: {
							email: { type: 'string', format: 'email', default: 'user@example.com' },
							age: { type: 'integer', minimum: 18, default: 30 },
							subscribe: { type: 'boolean', default: true },
						},
						required: ['email'],
					},
				};
				const pending = service.elicit(server, chat.context, params, CancellationToken.None);
				const carousel = chat.carouselPart();
				assert.ok(carousel, 'expected a question carousel');
				assert.deepStrictEqual(carousel.questions.map(q => [q.type, q.title, q.defaultValue, q.required]), [
					['text', 'email', 'user@example.com', true],
					['text', 'age', '30', false],
					['singleSelect', 'subscribe', 'true', false],
				]);
				const [email, age, subscribe] = carousel.questions;
				carousel.completion.complete({ answers: { [email.id]: 'user@example.com', [age.id]: '42', [subscribe.id]: { selectedValue: 'false' } } });
				const result = await pending;
				assert.deepStrictEqual({ kind: result.kind, value: result.value }, { kind: ElicitationKind.Form, value: { action: 'accept', content: { email: 'user@example.com', age: 42, subscribe: false } } });
				result.dispose();
			});

			test('renders enum pickers (SEP-1330) for every enum shape', async () => {
				const { server } = createServer('modern');
				const chat = createChat();
				const params: MCPLegacy.ElicitRequestFormParams = {
					mode: 'form',
					message: 'Pick colors',
					requestedSchema: {
						type: 'object',
						properties: {
							legacy: { type: 'string', enum: ['red', 'green'], enumNames: ['Red', 'Green'], default: 'green' } as MCPLegacy.PrimitiveSchemaDefinition,
							plain: { type: 'string', enum: ['a', 'b'] },
							titled: { type: 'string', oneOf: [{ const: '#f00', title: 'Red' }, { const: '#0f0', title: 'Green' }], default: '#f00' },
							multiTitled: { type: 'array', items: { anyOf: [{ const: 'x', title: 'Ex' }, { const: 'y', title: 'Why' }] }, default: ['x'] },
							multiPlain: { type: 'array', items: { type: 'string', enum: ['p', 'q'] } },
						},
					},
				};
				const pending = service.elicit(server, chat.context, params, CancellationToken.None);
				const carousel = chat.carouselPart();
				assert.ok(carousel, 'expected a question carousel');
				assert.deepStrictEqual(carousel.questions.map(q => [q.type, q.options?.map(o => `${o.value}:${o.label}`), q.defaultValue]), [
					['singleSelect', ['red:red - Red', 'green:green - Green'], 'green'],
					['singleSelect', ['a:a', 'b:b'], undefined],
					['singleSelect', ['#f00:#f00 - Red', '#0f0:#0f0 - Green'], '#f00'],
					['multiSelect', ['x:x - Ex', 'y:y - Why'], ['x']],
					['multiSelect', ['p:p', 'q:q'], undefined],
				]);
				const [legacy, plain, titled, multiTitled, multiPlain] = carousel.questions;
				carousel.completion.complete({
					answers: {
						[legacy.id]: { selectedValue: 'red' },
						[plain.id]: { selectedValue: 'b' },
						[titled.id]: { selectedValue: '#0f0' },
						[multiTitled.id]: { selectedValues: ['x', 'y'] },
						[multiPlain.id]: { selectedValues: ['q'] },
					}
				});
				const result = await pending;
				assert.deepStrictEqual(result.value, { action: 'accept', content: { legacy: 'red', plain: 'b', titled: '#0f0', multiTitled: ['x', 'y'], multiPlain: ['q'] } });
				result.dispose();
			});

			test('skipping the carousel answers cancel', async () => {
				const { server } = createServer('legacy');
				const chat = createChat();
				const params: MCPLegacy.ElicitRequestFormParams = { mode: 'form', message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } };
				const pending = service.elicit(server, chat.context, params, CancellationToken.None);
				chat.carouselPart()!.completion.complete({ answers: undefined });
				const result = await pending;
				assert.deepStrictEqual(result.value, { action: 'cancel' });
				result.dispose();
			});
		});

		suite('no live links (Safe URL Handling)', () => {
			const message = 'Read [the terms](https://evil.example/terms) or https://evil.example/faq first.';

			test('a form shows its message and link-like titles literally', async () => {
				const { server } = createServer('modern');
				const chat = createChat();
				const params: MCPLegacy.ElicitRequestFormParams = {
					mode: 'form',
					message,
					requestedSchema: {
						type: 'object',
						properties: {
							page: { type: 'string', title: 'Your page at https://evil.example/me', description: 'See www.evil.example' },
							name: { type: 'string', title: 'Name' },
						},
					},
				};
				const pending = service.elicit(server, chat.context, params, CancellationToken.None);
				const carousel = chat.carouselPart();
				assert.ok(carousel?.message, 'expected a question carousel with a message');
				const renderedMessage = render(carousel.message);
				assert.deepStrictEqual([countLinks(renderedMessage), renderedMessage.textContent], [0, message]);

				const [page, name] = carousel.questions;
				assert.ok(page.message, 'a title that could form a link is given as literal Markdown');
				const renderedTitle = render(page.message);
				assert.deepStrictEqual([countLinks(renderedTitle), renderedTitle.textContent], [0, 'Your page at https://evil.example/me']);
				assert.deepStrictEqual([page.title, page.description, name.title, name.message], ['Your page at https://evil.example/me', 'See www.evil.example', 'Name', undefined]);

				carousel.completion.complete({ answers: undefined });
				(await pending).dispose();
			});

			test('a consent prompt shows its message literally', async () => {
				const { server } = createServer('legacy');
				const chat = createChat();
				const pending = service.elicit(server, chat.context, { mode: 'form', message, requestedSchema: { type: 'object', properties: {} } }, CancellationToken.None);
				const part = chat.elicitationPart();
				assert.ok(part, 'expected a consent part');
				const rendered = render(part.message);
				assert.deepStrictEqual([countLinks(rendered), rendered.textContent], [0, message]);
				await part.reject!();
				(await pending).dispose();
			});

			test('a URL elicitation shows its message literally and its URL as code', async () => {
				const { server } = createServer('modern');
				const chat = createChat();
				const pending = service.elicit(server, chat.context, { ...urlElicitation('https://example.com/auth'), message }, CancellationToken.None);
				const part = chat.elicitationPart();
				assert.ok(part, 'expected a URL consent part');
				const rendered = render(part.message);
				assert.strictEqual(countLinks(rendered), 0);
				assert.strictEqual(rendered.getElementsByTagName('p')[0]?.textContent, message);
				assert.ok([...rendered.getElementsByTagName('code')].some(code => code.textContent?.includes('https://example.com/auth')), rendered.innerHTML);
				await part.reject!();
				(await pending).dispose();
			});
		});

		suite('requested schema that does not compile', () => {
			const schemas: Record<string, unknown> = {
				'an unsupported dialect': { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: { name: { type: 'string' } } },
				'an unresolved remote $ref': { type: 'object', properties: { name: { $ref: 'https://evil.example/name.json' } } },
				'an invalid keyword value': { type: 'object', properties: { name: { type: 'string', minLength: -1 } } },
				'a consent form in an unsupported dialect': { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} },
			};

			test('a form whose requested schema does not compile is declined without showing anything, and the reason logged', async () => {
				for (const [label, requestedSchema] of Object.entries(schemas)) {
					const { server } = createServer('modern');
					const chat = createChat();
					const warningsBefore = logService.warnings.length;
					const params = { mode: 'form', message: 'Name?', requestedSchema } as unknown as MCPLegacy.ElicitRequestFormParams;
					const result = await service.elicit(server, chat.context, params, CancellationToken.None);
					assert.deepStrictEqual(
						{ kind: result.kind, value: result.value, parts: chat.parts().length, notifications: notificationService.notifications.length },
						{ kind: ElicitationKind.Form, value: { action: 'decline' }, parts: 0, notifications: 0 },
						label,
					);
					const warnings = logService.warnings.slice(warningsBefore);
					assert.strictEqual(warnings.length, 1, label);
					assert.ok(warnings[0].includes('does not compile'), warnings[0]);
					result.dispose();
				}
			});

			test('from a server speaking 2025-11-25, such a form is shown as before (not declined), with a warning in the log', async () => {
				for (const [label, requestedSchema] of Object.entries(schemas)) {
					const { server } = createServer('legacy');
					const chat = createChat();
					const warningsBefore = logService.warnings.length;
					const params = { mode: 'form', message: 'Name?', requestedSchema } as unknown as MCPLegacy.ElicitRequestFormParams;
					const pending = service.elicit(server, chat.context, params, CancellationToken.None);
					const carousel = chat.carouselPart();
					if (carousel) {
						carousel.completion.complete({ answers: { [carousel.questions[0].id]: 'Ada' } });
					} else {
						const consent = chat.elicitationPart();
						assert.ok(consent, `${label}: the form is shown`);
						await consent.accept(true);
					}
					const result = await pending;
					assert.strictEqual(result.value.action, 'accept', label);
					const warnings = logService.warnings.slice(warningsBefore);
					assert.strictEqual(warnings.length, 1, `${label}: ${warnings.join('\n')}`);
					result.dispose();
				}
			});

			test('a pattern that cannot be compiled does not decline a form', async () => {
				const { server } = createServer('modern');
				const chat = createChat();
				const params: MCPLegacy.ElicitRequestFormParams = { mode: 'form', message: 'Host?', requestedSchema: { type: 'object', properties: { host: { type: 'string', pattern: '^([a-z0-9-]+\\.)+[a-z]{2,}$' } } } as MCPLegacy.ElicitRequestFormParams['requestedSchema'] };
				const pending = service.elicit(server, chat.context, params, CancellationToken.None);
				const carousel = chat.carouselPart();
				assert.ok(carousel, 'expected a question carousel');
				assert.strictEqual(logService.warnings.length, 1, 'the unchecked pattern is logged');
				carousel.completion.complete({ answers: { [carousel.questions[0].id]: 'a.example' } });
				const result = await pending;
				assert.deepStrictEqual(result.value, { action: 'accept', content: { host: 'a.example' } });
				result.dispose();
			});

			test('a draft-07 schema still compiles and is shown, as for 2025-11-25 servers', async () => {
				const { server } = createServer('legacy');
				const chat = createChat();
				const params = {
					mode: 'form',
					message: 'Name?',
					requestedSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
				} as unknown as MCPLegacy.ElicitRequestFormParams;
				const pending = service.elicit(server, chat.context, params, CancellationToken.None);
				const carousel = chat.carouselPart();
				assert.ok(carousel, 'expected a question carousel');
				assert.strictEqual(logService.warnings.length, 0);
				carousel.completion.complete({ answers: { [carousel.questions[0].id]: 'Ada' } });
				const result = await pending;
				assert.deepStrictEqual(result.value, { action: 'accept', content: { name: 'Ada' } });
				result.dispose();
			});
		});
	});
});
