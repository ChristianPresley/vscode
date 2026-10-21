/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as proxyAgent from '@vscode/proxy-agent';
import { readFile } from 'fs/promises';
import { createRequire } from 'module'; // not 'node:module': the Electron unit-test renderer maps built-ins by their unprefixed names
import { homedir } from 'os';
import type * as netType from 'net';
import type * as tlsType from 'tls';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { GrpcStatus, decodeBinaryMetadata, grpcStatusName } from '../../../base/common/grpc/status.js';
import { JsonRpcId } from '../../../base/common/jsonRpcProtocol.js';
import { untildify } from '../../../base/common/labels.js';
import { OAuthClientError } from '../../../base/common/oauth.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { decodeMessage, encodeMessage } from '../../../base/common/protobuf/codec.js';
import { decodeUtf8, encodeUtf8 } from '../../../base/common/protobuf/wire.js';
import { GrpcChannel, IGrpcCall, IGrpcCallOptions, IGrpcChannelOptions, IGrpcTrailers } from '../../../base/node/grpcChannel.js';
import { localize } from '../../../nls.js';
import { canLog, ILogService, LogLevel } from '../../../platform/log/common/log.js';
import { JSON_RPC_MESSAGE, MAX_ERROR_BIN_BYTES, MCP_ERROR_BIN_TRAILER, MCP_ERROR_CODE_TRAILER, MCP_PROTOCOL_VERSION_METADATA, TUNNEL_CALL_PATH, typedRpcForMethod } from '../../../platform/mcp/common/mcpGrpcProto.js';
import { decodeTypedResponse, decodeTypedServerIdentity, encodeTypedRequest, ITypedServerIdentity, McpUnexpressibleError, routingMetadataFor, synthesizeDiscoverResult } from '../../../platform/mcp/common/mcpGrpcTyped.js';
import { buildMirroredHeaders, isHeaderSafeAscii } from '../../../platform/mcp/common/mcpHttpHeaders.js';
import { LATEST_MCP_PROTOCOL_VERSION } from '../../../platform/mcp/common/mcpProtocolVersions.js';
import product from '../../../platform/product/common/product.js';
import { IMcpMessageEnvelope, IMcpRequestAbort, McpConnectionState, McpServerTransportGrpc } from '../../contrib/mcp/common/mcpTypes.js';
import { MainThreadMcpShape } from '../common/extHost.protocol.js';
import { CommonResponse, IMcpExtHostHandle, McpAuthHeaderProvider, stripCrossOriginHeaders } from '../common/extHostMcp.js';
import { MCP_OAUTH_MAX_CHALLENGE_CYCLES } from '../common/mcpOAuthClientFactory.js';

/**
 * The gRPC transport of MCP in the extension host. One {@link McpGrpcHandle}
 * owns one HTTP/2 channel to the server and speaks one of two bindings:
 *
 * - the zig-sdk JSON-RPC tunnel `/mcp.zig.transport.v1.Mcp/Call`: one call per
 *   JSON-RPC request; the response stream carries the related notifications
 *   and the response (a `subscriptions/listen` call stays open for its events);
 * - Google's typed service `model_context_protocol.Mcp`: eight unary RPCs that
 *   carry the list, read, get, call and complete methods as typed messages.
 *
 * `binding: 'auto'` (the default) is the tunnel, exactly as `binding: 'tunnel'`:
 * a custom transport of MCP keeps JSON-RPC, so the handle never switches to the
 * typed service on its own, and speaks it only with an explicit
 * `binding: 'typed'`. A gRPC server (HTTP 200) that answers the tunnel's
 * `server/discover` with a bare UNIMPLEMENTED does not serve the tunnel: the
 * discover, and with it the connection, fails with {@link noTunnelMessage},
 * which names the typed binding; any other HTTP status is a transport failure
 * (`http-status`). A typed-only server has no `server/discover` and no
 * `subscriptions/listen`: on the typed binding the handle answers the first
 * with a synthesized result (with the `serverInfo` and `instructions` of the
 * server's first ListTools response) and the second with -32601.
 *
 * As on the other transports, the handle never invents JSON-RPC errors for
 * transport conditions: a JSON-RPC error the server put in the trailers
 * (`mcp-error-bin`, else `mcp-error-code`) is delivered as a message, and a
 * status-only failure is reported as an {@link IMcpRequestAbort} with reason
 * `grpc-status`, which the protocol engine maps to an error.
 */

//#region Helpers

const nodeRequire = createRequire(import.meta.url);

/** `net` through the module loader, so that the extension host's network patches apply. */
function loadNet(): typeof netType {
	return nodeRequire('net');
}

/** `tls` through the module loader, so that the extension host's certificate patches apply. */
function loadTls(): typeof tlsType {
	return nodeRequire('tls');
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function requestKey(id: JsonRpcId): string {
	return `${typeof id}:${id}`;
}

function stringifyError(err: unknown): string {
	if (!(err instanceof Error)) {
		return String(err);
	}
	let msg = err.message || String(err);
	let cause: unknown = err.cause;
	for (let depth = 0; cause !== undefined && depth < 5; depth++) {
		msg += `: ${cause instanceof Error ? (cause.message || String(cause)) : String(cause)}`;
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return msg;
}

/** True when `text` (one JSON-RPC message or a batch) carries the response to `requestId`. */
function isResponseFor(text: string, requestId: JsonRpcId): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	const messages = Array.isArray(parsed) ? parsed : [parsed];
	return messages.some(message => isObject(message) && message.id === requestId && (hasOwn(message, 'result') || hasOwn(message, 'error')));
}

/** The host of a URI authority, without user info, port or IPv6 brackets. */
function authorityHost(authority: string): string {
	const host = authority.slice(authority.lastIndexOf('@') + 1);
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		return end > 0 ? host.slice(1, end) : host;
	}
	const colon = host.lastIndexOf(':');
	return colon >= 0 ? host.slice(0, colon) : host;
}

/** Whether `host` (without brackets) names the local machine. */
export function isLoopbackHost(host: string): boolean {
	const lower = host.toLowerCase();
	return lower === 'localhost' || lower.endsWith('.localhost') || lower === '::1' || /^127(\.\d{1,3}){3}$/.test(lower);
}

//#endregion

//#region Deadlines

/** The deadline of the calls that get one by default (the request timeout of the zig-sdk client). */
export const DEFAULT_GRPC_DEADLINE_MS = 60_000;

/**
 * The shortest keepalive interval the handle uses. grpc-core and grpc-js
 * servers allow one PING every 5 minutes by default and answer more frequent
 * ones with GOAWAY `too_many_pings` (ENHANCE_YOUR_CALM), which ends every
 * call on the connection.
 */
export const MIN_GRPC_KEEPALIVE_MS = 300_000;

/**
 * The keepalive interval of a connection while it carries a
 * `subscriptions/listen` stream, when `keepAliveMs` is unset: a stream that
 * has no events for minutes is otherwise cut by the idle timeout of a NAT or
 * load balancer. It is 10 s above {@link MIN_GRPC_KEEPALIVE_MS}, so that
 * timer and network jitter never make a PING arrive early for the ping
 * policy of the server (a "ping strike"; the third ends the connection).
 */
export const DEFAULT_GRPC_LISTEN_KEEPALIVE_MS = MIN_GRPC_KEEPALIVE_MS + 10_000;

/** The longest delay a timer can wait (2^31-1 ms, about 24.8 days): the largest `keepAliveMs` and `deadlineMs` of the schema. */
export const MAX_GRPC_TIMER_MS = 2_147_483_647;

/** Whether a configured `deadlineMs` is usable: a positive, finite number. */
function isValidDeadline(ms: number | undefined): ms is number {
	return typeof ms === 'number' && Number.isFinite(ms) && ms > 0;
}

/** Whether a configured `keepAliveMs` is usable: 0 (no pings) or a positive, finite number. */
function isValidKeepAlive(ms: number | undefined): ms is number {
	return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
}

/**
 * The keepalive of the connection for a configured `keepAliveMs`, the same
 * in mcp.json and in `McpGrpcServerDefinition`: `0` sends no PINGs at all; a
 * positive value sends one at that interval only while at least one call is
 * open (the channel sends none on an idle connection, whose PINGs gRPC
 * servers count as strikes, and doubles the interval for the next connection
 * after a `too_many_pings` GOAWAY), raised to {@link MIN_GRPC_KEEPALIVE_MS}
 * and cut to {@link MAX_GRPC_TIMER_MS}; unset (or a value that is not a
 * number of milliseconds, which is ignored) sends one every
 * {@link DEFAULT_GRPC_LISTEN_KEEPALIVE_MS} only while a
 * `subscriptions/listen` stream is open.
 */
export function grpcKeepAliveFor(configuredMs: number | undefined): Pick<IGrpcChannelOptions, 'keepAliveTimeMs' | 'longLivedKeepAliveTimeMs'> {
	if (!isValidKeepAlive(configuredMs)) {
		return { longLivedKeepAliveTimeMs: DEFAULT_GRPC_LISTEN_KEEPALIVE_MS };
	}
	if (configuredMs === 0) {
		return {};
	}
	return { keepAliveTimeMs: Math.min(Math.max(configuredMs, MIN_GRPC_KEEPALIVE_MS), MAX_GRPC_TIMER_MS) };
}

/** Whether a call is a `subscriptions/listen` stream: it gets no deadline, and the connection is kept alive while it is open. */
function isListenCall(method: string, kind: IMcpMessageEnvelope['kind'] | undefined): boolean {
	return kind === 'listen' || method === 'subscriptions/listen';
}

/** The methods that are bounded by {@link DEFAULT_GRPC_DEADLINE_MS} unless a deadline is configured. */
const DEFAULT_DEADLINE_METHODS: ReadonlySet<string> = new Set([
	'server/discover',
	'tools/list',
	'prompts/list',
	'prompts/get',
	'resources/list',
	'resources/templates/list',
	'resources/read',
	'completion/complete',
]);

/** A retry of an `input_required` round carries the answers or the server's state. */
function isInputRequiredRetry(params: unknown): boolean {
	return isObject(params) && (hasOwn(params, 'inputResponses') || hasOwn(params, 'requestState'));
}

/**
 * The deadline of a call, sent as `grpc-timeout`. A `subscriptions/listen`
 * stream never gets one. Otherwise the deadline of the envelope wins, then the
 * configured `deadlineMs` (when it is a positive number; any other value is
 * treated as unset, since a zero deadline would fail every call at once);
 * without either only the discover, list, read, prompt and completion methods
 * are bounded (60 s), so that `tools/call` and the retries of `input_required`
 * rounds can take as long as they need.
 */
export function grpcDeadlineFor(method: string, kind: IMcpMessageEnvelope['kind'] | undefined, params: unknown, configuredMs: number | undefined, envelopeMs?: number): number | undefined {
	if (isListenCall(method, kind)) {
		return undefined;
	}
	if (envelopeMs !== undefined) {
		return envelopeMs;
	}
	if (isValidDeadline(configuredMs)) {
		return configuredMs;
	}
	if (isInputRequiredRetry(params)) {
		return undefined;
	}
	return DEFAULT_DEADLINE_METHODS.has(method) ? DEFAULT_GRPC_DEADLINE_MS : undefined;
}

//#endregion

//#region Trailers

/** What a failed call means for its request: a JSON-RPC message from the server, or an abort. */
export type GrpcTrailerOutcome =
	| { readonly kind: 'message'; readonly message: string }
	| { readonly kind: 'abort'; readonly abort: Omit<IMcpRequestAbort, 'requestId'> };

/** The error object of a base64 JSON-RPC error response of at most {@link MAX_ERROR_BIN_BYTES}, or `undefined`. */
function parseErrorBin(value: string): JsonObject | undefined {
	let bytes: Uint8Array;
	try {
		bytes = decodeBinaryMetadata(value);
	} catch {
		return undefined;
	}
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_ERROR_BIN_BYTES) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeUtf8(bytes));
	} catch {
		return undefined;
	}
	if (!isObject(parsed) || !isObject(parsed.error)) {
		return undefined;
	}
	const { code, message } = parsed.error;
	if (typeof code !== 'number' || !Number.isSafeInteger(code) || typeof message !== 'string') {
		return undefined;
	}
	const error: JsonObject = { code, message };
	if (hasOwn(parsed.error, 'data')) {
		error.data = parsed.error.data;
	}
	return error;
}

/**
 * Maps the trailers of a failed call to its outcome, in the order of the
 * zig-sdk client: the JSON-RPC error response in `mcp-error-bin` (at most
 * 4096 bytes), else the code in `mcp-error-code` with `grpc-message`, both
 * delivered as an error response with the id of the request; else the status
 * alone, which is an abort with reason `grpc-status` (the protocol engine maps
 * INVALID_ARGUMENT, UNIMPLEMENTED, NOT_FOUND and the other statuses with a
 * JSON-RPC equivalent to an error, and keeps CANCELLED, DEADLINE_EXCEEDED,
 * UNAVAILABLE, UNAUTHENTICATED and PERMISSION_DENIED as transport failures).
 */
export function mapGrpcTrailersToJsonRpc(trailers: IGrpcTrailers, requestId: JsonRpcId): GrpcTrailerOutcome {
	const bin = trailers.raw[MCP_ERROR_BIN_TRAILER];
	if (bin !== undefined) {
		const error = parseErrorBin(bin);
		if (error) {
			return { kind: 'message', message: JSON.stringify({ jsonrpc: '2.0', id: requestId, error }) };
		}
	}
	const codeText = trailers.raw[MCP_ERROR_CODE_TRAILER]?.trim();
	if (codeText !== undefined && /^-?\d{1,16}$/.test(codeText)) {
		const code = Number(codeText);
		if (Number.isSafeInteger(code)) {
			const message = trailers.message ?? grpcStatusName(trailers.status);
			return { kind: 'message', message: JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code, message } }) };
		}
	}
	const name = grpcStatusName(trailers.status);
	if (trailers.httpStatus !== undefined && trailers.httpStatus !== 200) {
		// Not a gRPC answer (a web server, or an intermediary refusing the call): a transport
		// failure, never the JSON-RPC error a gRPC status-only failure may stand for.
		const synthesized = `HTTP status ${trailers.httpStatus}`;
		return {
			kind: 'abort',
			abort: {
				reason: 'http-status',
				httpStatus: trailers.httpStatus,
				grpcStatus: trailers.status,
				message: `${synthesized} instead of a gRPC response (${name})${trailers.message && trailers.message !== synthesized ? `: ${trailers.message}` : ''}`,
			},
		};
	}
	return {
		kind: 'abort',
		abort: { reason: 'grpc-status', grpcStatus: trailers.status, message: trailers.message ? `${name}: ${trailers.message}` : name },
	};
}

/** Whether the trailers carry a JSON-RPC error of the server (so the path is an MCP endpoint). */
function hasMcpError(trailers: IGrpcTrailers): boolean {
	return trailers.raw[MCP_ERROR_CODE_TRAILER] !== undefined || trailers.raw[MCP_ERROR_BIN_TRAILER] !== undefined;
}

/**
 * Whether the peer answered as a gRPC server: HTTP 200 with a `grpc-status`
 * of its own. Only such an UNIMPLEMENTED means the tunnel is missing; the
 * channel also maps an HTTP 404 of a web server to UNIMPLEMENTED.
 */
function answeredAsGrpcServer(trailers: IGrpcTrailers): boolean {
	return trailers.httpStatus === 200 && trailers.raw['grpc-status'] !== undefined;
}

/**
 * Whether the trailers of a tunnel `server/discover` say that the server does
 * not serve the tunnel: a gRPC server's bare UNIMPLEMENTED, without the
 * `mcp-error-code` or `mcp-error-bin` of a JSON-RPC error (a tunnel server
 * answers a method it does not know with -32601 in `mcp-error-code`).
 */
function isMissingTunnel(trailers: IGrpcTrailers): boolean {
	return trailers.status === GrpcStatus.UNIMPLEMENTED && !hasMcpError(trailers) && answeredAsGrpcServer(trailers);
}

/**
 * The error of a connection whose server does not serve the JSON-RPC tunnel.
 * `binding: 'auto'` never switches to the typed binding (Google's typed
 * service keeps no JSON-RPC, which MCP asks of custom transports), so the
 * message names the setting that does, both in a configuration and in the
 * `McpGrpcServerDefinition` of an extension (whose users cannot change it).
 * UNIMPLEMENTED only says that the server has no such method, and its
 * `grpc-message` says more (another gRPC service listening on that port
 * names the service it does not know), so when the server sent one it is
 * part of the message instead of the claim that the tunnel is missing.
 */
function noTunnelMessage(authority: string, serverMessage: string | undefined): string {
	const reason = serverMessage?.trim();
	if (reason) {
		return localize('mcpGrpc.noTunnelWithReason', "The gRPC server at {0} answered a call to the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp) with UNIMPLEMENTED: \"{1}\". If it only offers Google's typed MCP service, set \"binding\": \"typed\" in its configuration, or, if an extension provides the server, ask its author to use McpGrpcBinding.Typed.", authority, reason);
	}
	return localize('mcpGrpc.noTunnel', "The gRPC server at {0} does not implement the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp). If it only offers Google's typed MCP service, set \"binding\": \"typed\" in its configuration, or, if an extension provides the server, ask its author to use McpGrpcBinding.Typed.", authority);
}

/**
 * The HTTP status of an authorization challenge: 401 for a status-only
 * UNAUTHENTICATED, 403 for a status-only PERMISSION_DENIED (the channel maps
 * an HTTP 401/403 response to these), else `undefined`.
 */
function authChallengeStatus(trailers: IGrpcTrailers): 401 | 403 | undefined {
	if (hasMcpError(trailers)) {
		return undefined;
	}
	return trailers.status === GrpcStatus.UNAUTHENTICATED ? 401 : trailers.status === GrpcStatus.PERMISSION_DENIED ? 403 : undefined;
}

/**
 * Whether a failed call never reached an answer of the MCP server: it was
 * cancelled, ran out of time, lost or could not open its connection, met an
 * authorization challenge (a status-only UNAUTHENTICATED or PERMISSION_DENIED)
 * or got an HTTP answer that is not gRPC. A JSON-RPC error of the server in
 * the trailers is an answer.
 */
function isCallFailure(trailers: IGrpcTrailers): boolean {
	if (hasMcpError(trailers)) {
		return false;
	}
	if (trailers.httpStatus !== undefined && trailers.httpStatus !== 200) {
		return true;
	}
	switch (trailers.status) {
		case GrpcStatus.CANCELLED:
		case GrpcStatus.DEADLINE_EXCEEDED:
		case GrpcStatus.UNAVAILABLE:
		case GrpcStatus.UNAUTHENTICATED:
		case GrpcStatus.PERMISSION_DENIED:
			return true;
		default:
			return false;
	}
}

//#endregion

//#region Connections

/** Proxy resolution and certificates of the extension host (`@vscode/proxy-agent` as patched by `proxyResolver.ts`). */
export interface IGrpcProxyLookup {
	resolveProxyURL?(url: string): Promise<string | undefined>;
	lookupProxyAuthorization?(proxyURL: string, proxyAuthenticate: string | string[] | undefined, state: Record<string, unknown>): Promise<string | undefined>;
	/** The `http.proxySupport` setting of the extension host (`override`, `fallback`, `on` or `off`). */
	getProxySupport?(): string | undefined;
	/**
	 * The certificate authorities the `fetch` of the extension host (and so
	 * Streamable HTTP) verifies servers with: Node's bundled roots and the
	 * certificates of the operating system store, when `http.systemCertificates`
	 * is on; `undefined` when it is off (Node's bundled roots alone).
	 */
	loadCaCertificates?(): Promise<readonly string[] | undefined>;
}

export interface IGrpcConnectionFactoryOptions {
	readonly secure: boolean;
	/** PEM certificates trusted for the server in addition to the roots (`tls.ca`). */
	readonly ca?: readonly string[];
	/**
	 * The roots that verify the server and an HTTPS proxy, read for each
	 * connection ({@link IGrpcProxyLookup.loadCaCertificates}); without them,
	 * or when it resolves `undefined`, Node's bundled roots.
	 */
	readonly loadRootCertificates?: () => Promise<readonly string[] | undefined>;
	/** Defaults to true; false skips the verification of the server certificate. */
	readonly rejectUnauthorized?: boolean;
	/** The TLS server name (SNI and certificate check); defaults to the host when it is not an IP address. */
	readonly servername?: string;
	readonly proxy?: IGrpcProxyLookup;
	readonly log?: (level: LogLevel, message: string) => void;
	/** Each connection step (TCP, proxy CONNECT, TLS) fails after this long; defaults to 30 s. */
	readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_PROXY_RESPONSE_HEAD_BYTES = 16 * 1024;
const MAX_PROXY_AUTH_ATTEMPTS = 3;

function connectPlain(net: typeof netType, host: string, port: number, timeoutMs: number): Promise<netType.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out connecting to ${host}:${port}`));
		}, timeoutMs);
		const onError = (error: Error) => {
			clearTimeout(timer);
			reject(error);
		};
		socket.once('error', onError);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.removeListener('error', onError);
			resolve(socket);
		});
	});
}

interface ITlsConnectOptions {
	readonly host: string;
	readonly port: number;
	readonly socket?: netType.Socket;
	readonly servername?: string;
	readonly ca?: readonly string[];
	readonly rejectUnauthorized: boolean;
	/** Require this ALPN protocol (`h2` for the server; none for an HTTPS proxy). */
	readonly alpn?: string;
	readonly timeoutMs: number;
}

function connectTls(net: typeof netType, tls: typeof tlsType, options: ITlsConnectOptions): Promise<tlsType.TLSSocket> {
	const servername = options.servername ?? (net.isIP(options.host) ? undefined : options.host);
	return new Promise((resolve, reject) => {
		const tlsOptions: tlsType.ConnectionOptions = {
			host: options.host,
			servername,
			rejectUnauthorized: options.rejectUnauthorized,
		};
		if (options.socket) {
			tlsOptions.socket = options.socket;
		} else {
			tlsOptions.port = options.port;
		}
		if (options.ca) {
			tlsOptions.ca = [...options.ca];
		}
		if (options.alpn) {
			tlsOptions.ALPNProtocols = [options.alpn];
		}
		const socket = tls.connect(tlsOptions);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out in the TLS handshake with ${options.host}:${options.port}`));
		}, options.timeoutMs);
		const onError = (error: Error) => {
			clearTimeout(timer);
			reject(error);
		};
		socket.once('error', onError);
		socket.once('secureConnect', () => {
			clearTimeout(timer);
			socket.removeListener('error', onError);
			if (options.alpn && socket.alpnProtocol !== options.alpn) {
				socket.destroy();
				reject(new Error(`${options.host}:${options.port} did not negotiate HTTP/2 (ALPN '${options.alpn}', got '${socket.alpnProtocol || 'none'}')`));
				return;
			}
			resolve(socket);
		});
	});
}

interface IProxyResponse {
	readonly statusCode: number;
	readonly statusLine: string;
	readonly headers: Readonly<Record<string, string[]>>;
	readonly rest: Buffer;
}

/** Sends `CONNECT authority` on `socket` and reads the response head; bytes after it are returned in `rest`. */
function sendConnect(socket: netType.Socket, authority: string, authorization: string | undefined, timeoutMs: number): Promise<IProxyResponse> {
	return new Promise((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeListener('data', onData);
			socket.removeListener('error', onError);
			socket.removeListener('close', onClose);
		};
		const fail = (error: Error) => {
			cleanup();
			socket.destroy();
			reject(error);
		};
		const onError = (error: Error) => fail(error);
		const onClose = () => fail(new Error('The proxy closed the connection during CONNECT'));
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf('\r\n\r\n');
			if (end === -1) {
				if (buffered.length > MAX_PROXY_RESPONSE_HEAD_BYTES) {
					fail(new Error('The response of the proxy to CONNECT is too large'));
				}
				return;
			}
			socket.pause();
			cleanup();
			const [statusLine, ...lines] = buffered.subarray(0, end).toString('latin1').split('\r\n');
			const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(statusLine);
			if (!match) {
				socket.destroy();
				reject(new Error(`The proxy sent an invalid response to CONNECT: ${statusLine}`));
				return;
			}
			const headers: Record<string, string[]> = {};
			for (const line of lines) {
				const colon = line.indexOf(':');
				if (colon > 0) {
					const name = line.slice(0, colon).trim().toLowerCase();
					(headers[name] ??= []).push(line.slice(colon + 1).trim());
				}
			}
			resolve({ statusCode: Number(match[1]), statusLine, headers, rest: buffered.subarray(end + 4) });
		};
		const timer = setTimeout(() => fail(new Error('Timed out waiting for the proxy to answer CONNECT')), timeoutMs);
		socket.on('data', onData);
		socket.once('error', onError);
		socket.once('close', onClose);
		const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
		if (authorization) {
			lines.push(`Proxy-Authorization: ${authorization}`);
		}
		socket.write(lines.join('\r\n') + '\r\n\r\n');
	});
}

/** Opens a tunnel to `authority` through an HTTP or HTTPS proxy with CONNECT, answering its authentication challenges. */
async function connectThroughProxy(net: typeof netType, tls: typeof tlsType, proxyUrl: string, authority: string, options: IGrpcConnectionFactoryOptions, timeoutMs: number, roots: () => Promise<readonly string[] | undefined>): Promise<netType.Socket> {
	const proxy = new URL(proxyUrl);
	if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
		throw new Error(`gRPC connections can only use HTTP CONNECT proxies, not '${proxy.protocol}' proxies`);
	}
	const proxyHost = proxy.hostname.startsWith('[') ? proxy.hostname.slice(1, -1) : proxy.hostname;
	const proxyPort = proxy.port ? Number(proxy.port) : (proxy.protocol === 'https:' ? 443 : 80);
	const proxyHref = `${proxy.protocol}//${proxy.host}/`;
	const lookup = options.proxy?.lookupProxyAuthorization;
	const state: Record<string, unknown> = {};
	let authorization = proxy.username
		? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
		: undefined;
	if (!authorization && lookup) {
		authorization = await lookup(proxyHref, undefined, state);
	}
	for (let attempt = 0; attempt < MAX_PROXY_AUTH_ATTEMPTS; attempt++) {
		const socket = proxy.protocol === 'https:'
			? await connectTls(net, tls, { host: proxyHost, port: proxyPort, ca: await roots(), rejectUnauthorized: true, timeoutMs })
			: await connectPlain(net, proxyHost, proxyPort, timeoutMs);
		const response = await sendConnect(socket, authority, authorization, timeoutMs);
		if (response.statusCode === 200) {
			if (response.rest.length) {
				socket.unshift(response.rest);
			}
			options.log?.(LogLevel.Debug, `Connected to ${authority} through the proxy ${proxy.host}`);
			return socket;
		}
		socket.destroy();
		const challenge = response.headers['proxy-authenticate'];
		if (response.statusCode === 407 && lookup && challenge) {
			const next = await lookup(proxyHref, challenge.length === 1 ? challenge[0] : challenge, state);
			if (next) {
				authorization = next;
				continue;
			}
		}
		throw new Error(`The proxy ${proxy.host} refused to connect to ${authority}: ${response.statusLine}`);
	}
	throw new Error(`The proxy ${proxy.host} kept asking for authentication`);
}

/**
 * Creates the `createConnection` hook of a {@link GrpcChannel}: a TCP
 * connection (through the CONNECT proxy the extension host resolves for the
 * server, when there is one and `http.proxySupport` is not `off`) and, for
 * `grpcs://`, TLS with ALPN `h2`. `net` and `tls` come through the module
 * loader of the extension host, so that its proxy and certificate patches
 * apply. TLS trusts the roots the extension host's `fetch` trusts
 * ({@link IGrpcConnectionFactoryOptions.loadRootCertificates}) and, for the
 * server, the `tls.ca` certificates on top of them.
 */
export function createGrpcConnectionFactory(options: IGrpcConnectionFactoryOptions): (target: { host: string; port: number }) => Promise<netType.Socket | tlsType.TLSSocket> {
	const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const loadRoots = async (): Promise<readonly string[] | undefined> => {
		try {
			const roots = await options.loadRootCertificates?.();
			return roots?.length ? roots : undefined;
		} catch (error) {
			options.log?.(LogLevel.Warning, `Could not load the system certificates, verifying with Node's bundled roots only: ${stringifyError(error)}`);
			return undefined;
		}
	};
	return async target => {
		const net = loadNet();
		const tls = loadTls();
		const host = net.isIPv6(target.host) ? `[${target.host}]` : target.host;
		const authority = `${host}:${target.port}`;
		let proxyUrl: string | undefined;
		// Read per connection: the setting can change while the server runs. With `off` the
		// extension host's own requests go direct, and so does gRPC (it sets no agent of its
		// own, so `on` behaves like `override`, as for fetch).
		if (options.proxy?.getProxySupport?.() === 'off') {
			options.log?.(LogLevel.Trace, `http.proxySupport is off: connecting to ${authority} directly`);
		} else {
			try {
				proxyUrl = await options.proxy?.resolveProxyURL?.(`${options.secure ? 'https' : 'http'}://${authority}/`);
			} catch (error) {
				options.log?.(LogLevel.Warning, `Could not resolve the proxy for ${authority}, connecting directly: ${stringifyError(error)}`);
			}
		}
		const socket = proxyUrl ? await connectThroughProxy(net, tls, proxyUrl, authority, options, timeoutMs, loadRoots) : undefined;
		if (!options.secure) {
			return socket ?? await connectPlain(net, target.host, target.port, timeoutMs);
		}
		try {
			// An explicit `ca` replaces the default roots (and the patched `tls.connect` adds
			// nothing to it), so `tls.ca` comes on top of the full set.
			const roots = await loadRoots();
			const ca = options.ca?.length ? [...(roots ?? tls.rootCertificates), ...options.ca] : roots;
			return await connectTls(net, tls, {
				host: target.host,
				port: target.port,
				socket,
				servername: options.servername,
				ca,
				rejectUnauthorized: options.rejectUnauthorized ?? true,
				alpn: 'h2',
				timeoutMs,
			});
		} catch (error) {
			socket?.destroy();
			throw error;
		}
	};
}

//#endregion

//#region The handle

/** The part of {@link GrpcChannel} the handle uses. */
export interface IMcpGrpcChannel extends IDisposable {
	call(path: string, metadata: Readonly<Record<string, string>>, request: Uint8Array, options?: IGrpcCallOptions): IGrpcCall;
}

export interface IMcpGrpcHandleOptions {
	/** Creates the channel (tests pass a fake); defaults to a {@link GrpcChannel}. */
	readonly createChannel?: (options: IGrpcChannelOptions) => IMcpGrpcChannel;
	/** Creates the `createConnection` hook of the channel; defaults to {@link createGrpcConnectionFactory}. */
	readonly createConnectionFactory?: (options: IGrpcConnectionFactoryOptions) => NonNullable<IGrpcChannelOptions['createConnection']>;
	/** Reads the PEM file of `tls.ca`. */
	readonly readCaFile?: (path: string) => Promise<string>;
	/**
	 * Sends one request for authorization metadata, without following
	 * redirects (the handle follows them itself); defaults to the global
	 * `fetch` of the extension host.
	 */
	readonly fetchMetadata?: (url: string, init: IMetadataRequestInit) => Promise<CommonResponse>;
	/** Each authorization metadata request (with its redirects) is aborted after this long; defaults to 30 s. */
	readonly metadataTimeoutMs?: number;
	/** The proxy resolution; defaults to the one of the extension host. */
	readonly proxyLookup?: () => Promise<IGrpcProxyLookup>;
}

/** One request for authorization metadata. */
export interface IMetadataRequestInit {
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body?: Uint8Array<ArrayBuffer>;
	/** Always `manual`: the handle follows redirects itself, so that credentials never follow one to another origin. */
	readonly redirect: 'manual';
	/** Aborted when the handle is disposed, the call it serves is cancelled, or the request takes longer than its timeout. */
	readonly signal: AbortSignal;
}

/** The metadata that carries credentials; trace logs show it blanked, as on Streamable HTTP. */
const CREDENTIAL_METADATA: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

/** Redirects of an authorization metadata request that are followed, as on Streamable HTTP. */
const MAX_METADATA_REDIRECTS = 5;
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_METADATA_TIMEOUT_MS = 30_000;

/** Sets `name` to `value` in `headers`, replacing it in any letter case. */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) {
			delete headers[key];
		}
	}
	headers[name] = value;
}

/** Every {@link OAuthClientError} (it survives the RPC boundary by name) ends the authorization flow. */
function isTerminalAuthorizationError(error: unknown): boolean {
	return error instanceof OAuthClientError || (error instanceof Error && error.name === 'OAuthClientError');
}

interface IActiveCall {
	cancelled: boolean;
	call: IGrpcCall | undefined;
	/** Set while the call waits for its authorization challenge to be handled: ends that handling. */
	onCancel?: () => void;
}

/** Cancels an in-flight call: RST_STREAM(CANCEL) for its stream, and the end of its challenge handling. */
function cancelActiveCall(active: IActiveCall): void {
	active.cancelled = true;
	active.call?.cancel();
	active.onCancel?.();
}

/**
 * The proxy functions, the `http.proxySupport` accessor and the certificate
 * loader that `proxyResolver.ts` puts on the `@vscode/proxy-agent` module of
 * the extension host; none when proxy resolution is not set up.
 */
export async function extensionHostProxyLookup(): Promise<IGrpcProxyLookup> {
	const agentModule = proxyAgent as unknown as IGrpcProxyLookup & { readonly default?: IGrpcProxyLookup };
	const target = agentModule.default ?? agentModule;
	return {
		resolveProxyURL: typeof target.resolveProxyURL === 'function' ? url => target.resolveProxyURL!(url) : undefined,
		lookupProxyAuthorization: typeof target.lookupProxyAuthorization === 'function' ? (url, challenge, state) => target.lookupProxyAuthorization!(url, challenge, state) : undefined,
		getProxySupport: typeof target.getProxySupport === 'function' ? () => target.getProxySupport!() : undefined,
		loadCaCertificates: typeof target.loadCaCertificates === 'function' ? () => target.loadCaCertificates!() : undefined,
	};
}

function encodeTunnelMessage(text: string): Uint8Array {
	return encodeMessage(JSON_RPC_MESSAGE, { jsonrpc: encodeUtf8(text) });
}

function decodeTunnelMessage(payload: Uint8Array): string {
	const message = decodeMessage(JSON_RPC_MESSAGE, payload);
	const bytes = message.jsonrpc;
	return bytes instanceof Uint8Array ? decodeUtf8(bytes) : '';
}

export class McpGrpcHandle extends Disposable implements IMcpExtHostHandle {
	private readonly _authority: string;
	private readonly _host: string;
	private readonly _secure: boolean;
	/**
	 * The binding the handle speaks, fixed for its lifetime: `typed` only with
	 * `binding: 'typed'`; `auto` (the default) and `tunnel` speak the tunnel.
	 */
	readonly binding: 'tunnel' | 'typed';
	private _channel: Promise<IMcpGrpcChannel> | undefined;
	/** In-flight requests by {@link requestKey}, for {@link cancelRequest}. */
	private readonly _requests = new Map<string, IActiveCall>();
	/** Every in-flight call, for {@link close} and {@link dispose}. */
	private readonly _active = new Set<IActiveCall>();
	/** Discovery, token acquisition and challenge handling (OAuth 2.1), shared with Streamable HTTP. */
	private readonly _auth: McpAuthHeaderProvider;
	/** The protocol version of the last enveloped message; authorization metadata requests carry it. */
	private _protocolVersion: string | undefined;
	private _warnedCleartextToken = false;
	/** Aborts the authorization metadata requests in flight when the handle is disposed. */
	private readonly _abortCtrl = new AbortController();
	/** The identity a typed-only server gave on this connection, for its synthesized discover. */
	private _typedIdentity: ITypedServerIdentity | undefined;

	constructor(
		private readonly _id: number,
		private readonly _launch: McpServerTransportGrpc,
		private readonly _proxy: MainThreadMcpShape,
		private readonly _logService: ILogService,
		errorOnUserInteraction?: boolean,
		private readonly _options: IMcpGrpcHandleOptions = {},
	) {
		super();
		const authority = _launch.uri.authority;
		this._authority = authority.slice(authority.lastIndexOf('@') + 1);
		this._host = authorityHost(this._authority);
		this._secure = _launch.uri.scheme === 'grpcs';
		this.binding = _launch.binding === 'typed' ? 'typed' : 'tunnel';
		this._register(toDisposable(() => {
			this._abortCtrl.abort();
			this._cancelAll();
		}));
		this._auth = this._register(new McpAuthHeaderProvider({
			id: _id,
			launch: _launch,
			proxy: _proxy,
			errorOnUserInteraction,
			protocolVersion: () => this._protocolVersion ?? LATEST_MCP_PROTOCOL_VERSION,
			// The gRPC port serves no HTTP/1.1: the protected resource is the server's HTTPS identity.
			resourceUrl: () => `https://${this._authority}/`,
			fetchMetadata: (url, init, transportHeaders, signal) => this._fetchMetadata(url, init, transportHeaders, signal),
			log: (level, message) => this._log(level, message),
		}));
		this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Running });
		// The mcp.json schema rejects these values; a configuration that has them anyway still works.
		const { deadlineMs, keepAliveMs } = _launch;
		if (deadlineMs !== undefined && !isValidDeadline(deadlineMs)) {
			this._log(LogLevel.Warning, `deadlineMs ${deadlineMs} is not a positive number of milliseconds; it is ignored`);
		}
		if (keepAliveMs !== undefined) {
			const { keepAliveTimeMs } = grpcKeepAliveFor(keepAliveMs);
			if (!isValidKeepAlive(keepAliveMs)) {
				this._log(LogLevel.Warning, `keepAliveMs ${keepAliveMs} is not a number of milliseconds (0 turns keepalive pings off); it is ignored`);
			} else if (keepAliveTimeMs !== undefined && keepAliveTimeMs > keepAliveMs) {
				this._log(LogLevel.Warning, `keepAliveMs ${keepAliveMs} is below the ${MIN_GRPC_KEEPALIVE_MS} ms that gRPC servers allow by default; a keepalive ping is sent every ${keepAliveTimeMs} ms instead`);
			} else if (keepAliveTimeMs !== undefined && keepAliveTimeMs < keepAliveMs) {
				this._log(LogLevel.Warning, `keepAliveMs ${keepAliveMs} is longer than a timer can wait; a keepalive ping is sent every ${keepAliveTimeMs} ms instead`);
			}
		}
	}

	async send(message: string, envelope?: IMcpMessageEnvelope): Promise<void> {
		if (envelope) {
			this._protocolVersion = envelope.protocolVersion;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			this._log(LogLevel.Warning, `Dropping a message that is not JSON: ${message.slice(0, 200)}`);
			return;
		}
		if (Array.isArray(parsed)) {
			// The gRPC bindings carry one message per call.
			await Promise.all(parsed.map(item => this._sendOne(JSON.stringify(item), item, undefined)));
		} else {
			await this._sendOne(message, parsed, envelope);
		}
	}

	cancelRequest(requestId: JsonRpcId): void {
		const key = requestKey(requestId);
		const active = this._requests.get(key);
		if (active) {
			this._requests.delete(key);
			// RST_STREAM(CANCEL): the server cancels the request handler. An authorization
			// discovery the request waits for ends too.
			cancelActiveCall(active);
		}
	}

	async close(): Promise<void> {
		this._cancelAll();
		this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Stopped });
	}

	private _cancelAll(): void {
		for (const active of this._active) {
			cancelActiveCall(active);
		}
		this._active.clear();
		this._requests.clear();
	}

	private async _sendOne(text: string, message: unknown, envelope: IMcpMessageEnvelope | undefined): Promise<void> {
		if (!isObject(message)) {
			this._log(LogLevel.Warning, `Dropping a message that is not a JSON-RPC object: ${text.slice(0, 200)}`);
			return;
		}
		const method = message.method;
		const id = message.id;
		if (typeof method !== 'string') {
			this._log(LogLevel.Warning, 'Dropping a response to a server request: the gRPC bindings carry no requests from the server');
			return;
		}
		if (typeof id === 'string' || typeof id === 'number') {
			await this._sendRequest(text, id, method, message.params, envelope);
		} else {
			await this._sendNotification(text, method, envelope);
		}
	}

	private async _sendRequest(text: string, id: JsonRpcId, method: string, params: unknown, envelope: IMcpMessageEnvelope | undefined): Promise<void> {
		const key = requestKey(id);
		const active: IActiveCall = { cancelled: false, call: undefined };
		this._requests.set(key, active);
		this._active.add(active);
		try {
			if (this.binding === 'typed') {
				await this._sendTyped(id, method, params, envelope, active);
			} else {
				await this._sendTunnel(text, id, method, params, envelope, active);
			}
		} catch (err) {
			if (!active.cancelled) {
				this._abort(id, active, { reason: 'transport-error', message: err instanceof CancellationError ? `The ${method} request was cancelled` : stringifyError(err) });
				if (isTerminalAuthorizationError(err) && !this._store.isDisposed) {
					// As on Streamable HTTP: a terminal authorization failure stops the server.
					const message = `Authorization with ${this._authority} failed: ${stringifyError(err)}`;
					this.dispose();
					this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message });
				}
			}
		} finally {
			this._active.delete(active);
			if (this._requests.get(key) === active) {
				this._requests.delete(key);
			}
		}
	}

	private async _sendNotification(text: string, method: string, envelope: IMcpMessageEnvelope | undefined): Promise<void> {
		if (this.binding === 'typed') {
			this._log(LogLevel.Debug, `The typed gRPC binding has no RPC for the notification ${method}; dropping it`);
			return;
		}
		const active: IActiveCall = { cancelled: false, call: undefined };
		this._active.add(active);
		try {
			// The server answers a notification with an empty stream and status 0.
			const trailers = await this._runCall(TUNNEL_CALL_PATH, encodeTunnelMessage(text), this._metadata(envelope), {}, active, () => { });
			if (trailers.status !== GrpcStatus.OK) {
				this._log(LogLevel.Info, `The notification ${method} ended with ${grpcStatusName(trailers.status)}${trailers.message ? `: ${trailers.message}` : ''}`);
			}
		} catch (err) {
			if (!active.cancelled) {
				this._log(LogLevel.Warning, `Could not send the notification ${method}: ${stringifyError(err)}`);
			}
		} finally {
			this._active.delete(active);
		}
	}

	/**
	 * One JSON-RPC request on the tunnel: every message of the response stream
	 * is delivered as it arrives (notifications, then the response; the events
	 * of a listen stream). A `server/discover` that a gRPC server answers with
	 * a bare UNIMPLEMENTED is aborted with {@link noTunnelMessage} (reason
	 * `transport-error`, so that the engine fails the handshake with it instead
	 * of trying `initialize`); nothing is sent on the typed binding.
	 */
	private async _sendTunnel(text: string, id: JsonRpcId, method: string, params: unknown, envelope: IMcpMessageEnvelope | undefined, active: IActiveCall): Promise<void> {
		let sawResponse = false;
		const deadlineMs = grpcDeadlineFor(method, envelope?.kind, params, this._launch.deadlineMs, envelope?.deadlineMs);
		const callOptions: IGrpcCallOptions = { deadlineMs, longLived: isListenCall(method, envelope?.kind) };
		const trailers = await this._runCall(TUNNEL_CALL_PATH, encodeTunnelMessage(text), this._metadata(envelope), callOptions, active, payload => {
			const message = decodeTunnelMessage(payload);
			if (!sawResponse && isResponseFor(message, id)) {
				sawResponse = true;
			}
			this._deliver(message);
		});
		if (active.cancelled) {
			return;
		}
		if (trailers.status === GrpcStatus.OK) {
			if (!sawResponse) {
				this._abort(id, active, { reason: 'stream-closed', message: `The response stream for ${method} ended before the response arrived` });
			}
			return;
		}
		if (sawResponse) {
			this._log(LogLevel.Debug, `The ${method} call ended with ${grpcStatusName(trailers.status)} after its response`);
			return;
		}
		if (method === 'server/discover' && isMissingTunnel(trailers)) {
			// A gRPC server without the tunnel service (an HTTP 404, any non-200, is no gRPC server
			// at all and fails below as a transport error). It may serve the typed service, but
			// only an explicit `binding: 'typed'` uses that.
			this._log(LogLevel.Warning, `${this._authority} answered server/discover on the JSON-RPC tunnel with ${grpcStatusName(trailers.status)}${trailers.message ? `: ${trailers.message}` : ''}`);
			this._abort(id, active, { reason: 'transport-error', grpcStatus: trailers.status, message: noTunnelMessage(this._authority, trailers.message) });
			return;
		}
		this._deliverTrailers(id, active, trailers);
	}

	/** One request on the typed binding, or the answer a typed-only server cannot give itself. */
	private async _sendTyped(id: JsonRpcId, method: string, params: unknown, envelope: IMcpMessageEnvelope | undefined, active: IActiveCall): Promise<void> {
		const rpc = typedRpcForMethod(method);
		if (!rpc) {
			if (method === 'server/discover') {
				const probe = await this._typedServerIdentity(params, envelope, active);
				if (active.cancelled) {
					return;
				}
				if (probe.kind === 'failed') {
					// The server is unreachable or the authorization was not resolved (the user declined to
					// sign in): the discover fails as any request does, and the next one probes again.
					this._deliverTrailers(id, active, probe.trailers);
					return;
				}
				this._deliver(JSON.stringify({ jsonrpc: '2.0', id, result: synthesizeDiscoverResult(this._authority, probe.identity) }));
			} else if (method === 'subscriptions/listen') {
				this._deliver(JSON.stringify({
					jsonrpc: '2.0',
					id,
					error: { code: -32601, message: 'subscriptions/listen is not available on the typed gRPC binding', data: { vscodeTransportError: 'unsupported' } },
				}));
			} else {
				this._log(LogLevel.Warning, `The typed gRPC binding has no RPC for ${method}`);
				this._abort(id, active, { reason: 'unexpressible', message: `The typed gRPC binding has no RPC for ${method}` });
			}
			return;
		}

		let body: Uint8Array;
		try {
			body = encodeTypedRequest(rpc, params ?? {});
		} catch (err) {
			if (err instanceof McpUnexpressibleError) {
				this._log(LogLevel.Warning, `The typed gRPC binding cannot send ${method}: ${err.message}`);
				this._abort(id, active, { reason: 'unexpressible', message: err.message });
				return;
			}
			throw err;
		}

		const metadata = this._metadata(envelope, LATEST_MCP_PROTOCOL_VERSION);
		for (const [key, value] of Object.entries(routingMetadataFor(rpc, params))) {
			// The routing metadata is optional; a value that is not plain ASCII stays in the message only.
			if (value.length > 0 && isHeaderSafeAscii(value)) {
				metadata[key] = value;
			}
		}
		const payloads: Uint8Array[] = [];
		const deadlineMs = grpcDeadlineFor(method, envelope?.kind, params, this._launch.deadlineMs, envelope?.deadlineMs);
		const trailers = await this._runCall(rpc.path, body, metadata, { deadlineMs }, active, payload => payloads.push(payload));
		if (active.cancelled) {
			return;
		}
		if (trailers.status !== GrpcStatus.OK) {
			this._deliverTrailers(id, active, trailers);
			return;
		}
		if (payloads.length !== 1) {
			this._abort(id, active, { reason: 'transport-error', message: `The ${rpc.name} call returned ${payloads.length} messages instead of one` });
			return;
		}
		let result: Record<string, unknown>;
		try {
			result = decodeTypedResponse(rpc, payloads[0]);
		} catch (err) {
			this._log(LogLevel.Warning, `The ${rpc.name} response of the typed gRPC binding is not valid: ${stringifyError(err)}`);
			this._abort(id, active, { reason: 'transport-error', message: `Invalid ${rpc.name} response: ${stringifyError(err)}` });
			return;
		}
		this._deliver(JSON.stringify({ jsonrpc: '2.0', id, result }));
	}

	/**
	 * The `serverInfo` and `instructions` for the synthesized `server/discover`
	 * of a typed-only server. Every typed response carries the server's
	 * `serverInfo` in its `_meta`, and an initial response its `instructions`:
	 * the first discover of the connection asks for the first page of
	 * ListTools and takes them from its common fields. Without them (the server
	 * answers the call with an error, the response has none) the synthesized
	 * result names the server after its authority. A failure of the call itself
	 * (a cancellation, a denied, lost or refused connection, a deadline, an
	 * HTTP answer that is not gRPC, an authorization challenge that was not
	 * resolved, a terminal authorization failure) fails the discover as it fails
	 * any request.
	 */
	private async _typedServerIdentity(params: unknown, envelope: IMcpMessageEnvelope | undefined, active: IActiveCall): Promise<{ readonly kind: 'identity'; readonly identity: ITypedServerIdentity } | { readonly kind: 'failed'; readonly trailers: IGrpcTrailers }> {
		if (this._typedIdentity) {
			return { kind: 'identity', identity: this._typedIdentity };
		}
		const rpc = typedRpcForMethod('tools/list');
		if (!rpc) {
			return { kind: 'identity', identity: {} };
		}
		// The request metadata of the discover (protocol version, client info and capabilities) applies to any request.
		const probeParams = isObject(params) && isObject(params._meta) ? { _meta: params._meta } : {};
		let body: Uint8Array;
		try {
			body = encodeTypedRequest(rpc, probeParams);
		} catch (err) {
			if (!(err instanceof McpUnexpressibleError)) {
				throw err;
			}
			body = encodeTypedRequest(rpc, {});
		}
		const probeEnvelope = envelope && { ...envelope, method: 'tools/list', headers: buildMirroredHeaders('tools/list', probeParams) };
		const metadata = this._metadata(probeEnvelope, LATEST_MCP_PROTOCOL_VERSION);
		const deadlineMs = grpcDeadlineFor('tools/list', 'request', probeParams, this._launch.deadlineMs, envelope?.deadlineMs);
		const payloads: Uint8Array[] = [];
		const trailers = await this._runCall(rpc.path, body, metadata, { deadlineMs }, active, payload => payloads.push(payload));
		if (trailers.status !== GrpcStatus.OK && isCallFailure(trailers)) {
			this._log(LogLevel.Info, `The ${rpc.name} call that asks ${this._authority} for its serverInfo failed with ${grpcStatusName(trailers.status)}${trailers.message ? `: ${trailers.message}` : ''}`);
			return { kind: 'failed', trailers };
		}
		if (trailers.status !== GrpcStatus.OK || payloads.length !== 1) {
			this._log(LogLevel.Info, `The ${rpc.name} call that asks ${this._authority} for its serverInfo ended with ${grpcStatusName(trailers.status)}${trailers.message ? `: ${trailers.message}` : ''}; naming the server after its address`);
			return { kind: 'identity', identity: {} };
		}
		const identity = decodeTypedServerIdentity(rpc, payloads[0]);
		if (!identity.serverInfo) {
			this._log(LogLevel.Info, `The ${rpc.name} response of ${this._authority} carries no serverInfo; naming the server after its address`);
		}
		this._typedIdentity = identity;
		return { kind: 'identity', identity };
	}

	/**
	 * Runs one call and returns its trailers, after feeding every response
	 * message to `onMessage`. A status-only UNAUTHENTICATED (an HTTP 401) or
	 * PERMISSION_DENIED (403) before any message is an authorization challenge:
	 * the {@link McpAuthHeaderProvider} discovers the authorization metadata of
	 * the server's HTTPS identity, gets a token and the call runs again.
	 */
	private async _runCall(path: string, body: Uint8Array, metadata: Record<string, string>, callOptions: IGrpcCallOptions, active: IActiveCall, onMessage: (payload: Uint8Array) => void): Promise<IGrpcTrailers> {
		const callMetadata = { ...metadata };
		await this._auth.addAuthHeader(callMetadata);
		for (let cycle = 0; ; cycle++) {
			await this._checkAllowed();
			if (active.cancelled || this._store.isDisposed) {
				throw new CancellationError();
			}
			const channel = await this._getChannel();
			if (active.cancelled) {
				throw new CancellationError();
			}
			this._noteTokenSent(callMetadata);
			this._traceCall(path, callMetadata, callOptions.deadlineMs);
			const call = channel.call(path, callMetadata, body, callOptions);
			active.call = call;

			let received = 0;
			const iterator = call.messages[Symbol.asyncIterator]();
			for (; ;) {
				let next: IteratorResult<Uint8Array>;
				try {
					next = await iterator.next();
				} catch {
					break; // the trailers tell why
				}
				if (next.done) {
					break;
				}
				if (active.cancelled) {
					call.cancel();
					break;
				}
				received++;
				try {
					onMessage(next.value);
				} catch (err) {
					call.cancel();
					throw err;
				}
			}
			const trailers = await call.trailers;
			if (active.cancelled) {
				throw new CancellationError();
			}
			const challengeStatus = received === 0 ? authChallengeStatus(trailers) : undefined;
			if (challengeStatus === undefined) {
				this._auth.onDidAccept(callMetadata);
				return trailers;
			}
			if (cycle >= MCP_OAUTH_MAX_CHALLENGE_CYCLES) {
				this._log(LogLevel.Warning, `${grpcStatusName(trailers.status)} from ${this._authority} after ${cycle} authorization attempts; giving up on this call`);
				return trailers;
			}
			if (!await this._handleChallenge(challengeStatus, trailers.raw['www-authenticate'], callMetadata, active)) {
				return trailers;
			}
			this._log(LogLevel.Debug, `Retrying ${path} after ${grpcStatusName(trailers.status)} with a new token`);
		}
	}

	/**
	 * Hands a challenge of `active` to the {@link McpAuthHeaderProvider} with a
	 * token that is cancelled with the call ({@link cancelRequest}, {@link close}
	 * or disposal), so that cancelling the call ends its discovery (and aborts
	 * the metadata request in flight) and stops it waiting for other challenges.
	 */
	private async _handleChallenge(status: 401 | 403, wwwAuthenticate: string | undefined, metadata: Record<string, string>, active: IActiveCall): Promise<boolean> {
		const cts = new CancellationTokenSource();
		active.onCancel = () => cts.cancel();
		if (active.cancelled || this._store.isDisposed) {
			cts.cancel();
		}
		try {
			return await this._auth.handleChallenge(status, wwwAuthenticate, metadata, cts.token);
		} finally {
			active.onCancel = undefined;
			cts.dispose();
		}
	}

	/**
	 * Fetches authorization metadata, which lives on the HTTPS side of the
	 * server (and at the authorization server); it is not subject to the allow
	 * list. As on Streamable HTTP, redirects are followed here (at most
	 * {@link MAX_METADATA_REDIRECTS}, to http(s) only), and a request to
	 * another origin than the HTTPS identity, or a redirect that changes the
	 * origin, carries neither the configured headers nor `Authorization`,
	 * cookies or proxy credentials; the generated `transportHeaders` and the
	 * user agent survive. Disposing the handle, the timeout or `requestSignal`
	 * (the discovery it serves ended: its call was cancelled) aborts it.
	 */
	private async _fetchMetadata(url: string, init: Pick<IMetadataRequestInit, 'method' | 'headers' | 'body'>, transportHeaders: Readonly<Record<string, string>> | undefined, requestSignal?: AbortSignal): Promise<CommonResponse> {
		const generated: Record<string, string> = { ...transportHeaders, 'user-agent': `${product.nameLong}/${product.version}` };
		let headers: Record<string, string> = { ...init.headers };
		for (const [name, value] of Object.entries(generated)) {
			setHeader(headers, name, value);
		}
		let current = new URL(url);
		if (current.protocol !== 'https:' && current.protocol !== 'http:') {
			throw new Error(`Authorization metadata of ${this._authority} must be fetched over http(s), not '${current.protocol}'`);
		}
		if (current.origin !== new URL(`https://${this._authority}/`).origin) {
			headers = stripCrossOriginHeaders(headers, this._launch.headers, generated);
		}
		const signals = [this._abortCtrl.signal, AbortSignal.timeout(this._options.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS)];
		if (requestSignal) {
			signals.push(requestSignal);
		}
		const signal = AbortSignal.any(signals);
		const fetchOnce = this._options.fetchMetadata ?? ((target: string, request: IMetadataRequestInit): Promise<CommonResponse> => fetch(target, request));
		let method = init.method;
		let body = init.body;
		let target = url;
		for (let redirects = 0; ; redirects++) {
			signal.throwIfAborted();
			const response = await fetchOnce(target, { method, headers, body, redirect: 'manual', signal });
			const location = REDIRECT_STATUS_CODES.has(response.status) ? response.headers.get('location') : null;
			if (!location || redirects >= MAX_METADATA_REDIRECTS) {
				return response;
			}
			const next = new URL(location, current);
			if (next.protocol !== 'https:' && next.protocol !== 'http:') {
				throw new Error(`The authorization metadata request to ${current.origin} redirected to a non-http(s) target (${next.protocol}), which is not allowed`);
			}
			response.body?.cancel().catch(() => { /* the body of a redirect is not read */ });
			if (next.origin !== current.origin) {
				headers = stripCrossOriginHeaders(headers, this._launch.headers, generated);
			}
			// As fetch does: 303 always, and 301/302 after a POST, continue with a GET without a body.
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
				method = 'GET';
				body = undefined;
			}
			this._log(LogLevel.Trace, `Following the redirect (${response.status}) of the authorization metadata request from ${current.origin}${current.pathname} to ${next.origin}${next.pathname}`);
			current = next;
			target = next.toString();
		}
	}

	/** A bearer token over cleartext `grpc://` to another machine can be read on the way: warn once. */
	private _noteTokenSent(metadata: Readonly<Record<string, string>>): void {
		if (this._warnedCleartextToken || this._secure || isLoopbackHost(this._host) || !Object.keys(metadata).some(name => name.toLowerCase() === 'authorization')) {
			return;
		}
		this._warnedCleartextToken = true;
		this._log(LogLevel.Warning, `Sending a bearer token to ${this._authority} over cleartext HTTP/2 (grpc://); use grpcs:// to protect it`);
	}

	/** The metadata of a call: the configured headers, the mirrored `Mcp-*` headers of the envelope and the protocol version, lowercased. */
	private _metadata(envelope: IMcpMessageEnvelope | undefined, defaultProtocolVersion?: string): Record<string, string> {
		const metadata: Record<string, string> = {};
		for (const [name, value] of this._launch.headers) {
			metadata[name.toLowerCase()] = value;
		}
		for (const [name, value] of Object.entries(envelope?.headers ?? {})) {
			metadata[name.toLowerCase()] = value;
		}
		const protocolVersion = envelope?.protocolVersion ?? defaultProtocolVersion;
		if (protocolVersion) {
			metadata[MCP_PROTOCOL_VERSION_METADATA] = protocolVersion;
		}
		return metadata;
	}

	private async _checkAllowed(): Promise<void> {
		const denied = await this._proxy.$checkMcpServerAllowed(this._id, this._launch.uri.toString(true));
		if (denied !== undefined) {
			if (!this._store.isDisposed) {
				this.dispose();
				this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message: denied });
			}
			throw new Error(denied);
		}
	}

	private _getChannel(): Promise<IMcpGrpcChannel> {
		this._channel ??= this._createChannel().catch(err => {
			if (!this._store.isDisposed && !(err instanceof CancellationError)) {
				const message = `Could not set up the gRPC connection to ${this._launch.uri.toString(true)}: ${stringifyError(err)}`;
				this.dispose();
				this._proxy.$onDidChangeState(this._id, { state: McpConnectionState.Kind.Error, message });
			}
			throw err;
		});
		return this._channel;
	}

	private async _createChannel(): Promise<IMcpGrpcChannel> {
		const tls = this._launch.tls;
		let ca: string[] | undefined;
		if (this._secure && tls?.ca) {
			// Trusted in addition to the roots of the extension host (see createGrpcConnectionFactory).
			ca = [await (this._options.readCaFile ?? (path => readFile(path, 'utf-8')))(untildify(tls.ca, homedir()))];
		}
		const proxyLookup = await (this._options.proxyLookup ?? extensionHostProxyLookup)();
		if (this._store.isDisposed) {
			throw new CancellationError();
		}
		const loadCaCertificates = proxyLookup.loadCaCertificates;
		const options: IGrpcChannelOptions = {
			authority: this._authority,
			secure: this._secure,
			...grpcKeepAliveFor(this._launch.keepAliveMs),
			userAgent: `grpc-node-vscode/${product.version} (${product.nameLong})`,
			createConnection: (this._options.createConnectionFactory ?? createGrpcConnectionFactory)({
				secure: this._secure,
				ca,
				loadRootCertificates: loadCaCertificates ? () => loadCaCertificates.call(proxyLookup) : undefined,
				rejectUnauthorized: !tls?.insecure,
				servername: tls?.serverName,
				proxy: proxyLookup,
				log: (level, message) => this._log(level, message),
			}),
		};
		const channel = (this._options.createChannel ?? (o => new GrpcChannel(o)))(options);
		this._register(channel);
		return channel;
	}

	private _deliverTrailers(id: JsonRpcId, active: IActiveCall, trailers: IGrpcTrailers): void {
		const outcome = mapGrpcTrailersToJsonRpc(trailers, id);
		if (outcome.kind === 'message') {
			this._deliver(outcome.message);
		} else {
			this._abort(id, active, outcome.abort);
		}
	}

	private _deliver(message: string): void {
		if (!this._store.isDisposed) {
			this._proxy.$onDidReceiveMessage(this._id, message);
		}
	}

	private _abort(id: JsonRpcId, active: IActiveCall, abort: Omit<IMcpRequestAbort, 'requestId'>): void {
		if (!active.cancelled && !this._store.isDisposed) {
			this._proxy.$onDidAbortRequest(this._id, { requestId: id, ...abort });
		}
	}

	private _traceCall(path: string, metadata: Readonly<Record<string, string>>, deadlineMs: number | undefined): void {
		if (canLog(this._logService.getLevel(), LogLevel.Trace)) {
			// Never log credentials: neither the ones the transport adds nor the configured
			// headers, whose values are typically API keys.
			const configured = new Set(this._launch.headers.map(([name]) => name.toLowerCase()));
			const shown: Record<string, string> = {};
			for (const [name, value] of Object.entries(metadata)) {
				const lower = name.toLowerCase();
				shown[lower] = CREDENTIAL_METADATA.has(lower) || configured.has(lower) ? '***' : value;
			}
			this._log(LogLevel.Trace, `Calling ${path} on ${this._authority} with ${JSON.stringify(shown)}${deadlineMs !== undefined ? ` and a deadline of ${deadlineMs}ms` : ''}`);
		}
	}

	private _log(level: LogLevel, message: string): void {
		if (!this._store.isDisposed) {
			this._proxy.$onDidPublishLog(this._id, level, message);
		}
	}
}

//#endregion
