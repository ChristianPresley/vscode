# MCP gateway threat model

The MCP gateway (`src/vs/platform/mcp/node/mcpGateway*.ts`, `src/vs/base/node/grpcServer.ts`) serves VS Code's MCP servers to the local Copilot CLI over Streamable HTTP (2026-07-28 and 2025-11-25) and, for the gateways that ask for it (`vscode.lm.startMcpGateway(resource, { grpc: true })`), gRPC (the tunnel and the typed binding). It is VS Code's only MCP server.

This file maps each item of the threat model of zig-sdk (the wiki page `Threat-Model.md`, reviewed 2026-10-08) that applies to such a server to the tests that cover it in this repository. The items of that page that concern parts the gateway does not have (TLS, OAuth resource servers and authorization servers, Unix sockets, WebSocket, icons, Skills, token storage) do not apply: the gateway listens on loopback only, in plain HTTP and plain HTTP/2, and implements no authorization.

`node test/mcp-conformance/run.ts check-matrix` checks this file: every threat (a `## ` section) cites at least one test or conformance scenario; each cited test (``- `<file>`: <test name>``) must be declared by its file and run (not skipped); each cited scenario (``- conformance <leg> <revision> `<scenario>` ``) must have a `driven` row in `requirement-matrix.md`. The gateway gRPC listener's validation order next to zig-sdk's `grpc_server.zig` is a table of the [conformance matrix](docs/mcp-conformance-matrix.md#the-gateway-grpc-listener-grpc_serverzig-parity).

## 1. DNS rebinding: loopback `Host` and `Origin` (HTTP)

zig-sdk: secure defaults "`Origin` and `Host` checks: loopback only" and "HTTP bind address `127.0.0.1`"; transport threat "Validate `Origin`, answer `403`".

The gateway listens on `127.0.0.1` only. A request whose `Host` is not a loopback name (`localhost`, an address of `127.0.0.0/8` or `[::1]`, with or without the port) or whose `Origin`, when present, is not a loopback origin gets HTTP 403 before the route is looked up. Other hosts and origins are allowed only through an explicit service option; the product's registration sets none.

- `src/vs/platform/mcp/test/common/mcpGatewayProtocol.test.ts`: loopback host and origin checks
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: the Host and Origin checks run before the route lookup (403)
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: options reach a service registered through DI; the plain descriptor stays loopback-only
- conformance server 2026-07-28 `dns-rebinding-protection`
- conformance server 2025-11-25 `dns-rebinding-protection`

## 2. DNS rebinding: loopback `:authority` (gRPC)

zig-sdk: the same loopback rule, applied by the gRPC server before it looks at the message (`grpc_server.zig`, "Authorization comes before any look at the message").

The gRPC listener binds `127.0.0.1` and, when the machine has IPv6, `[::1]`. A call whose `:authority` is not a loopback name ends with `PERMISSION_DENIED`, trailers only, before the request message is read.

The listener is not always open: it opens only while a gateway that asked for gRPC (`{ grpc: true }`) has a server, and it closes after the last of them, so a gateway that does not ask (every Copilot CLI session today) adds no port. Concurrent first requests share one listener; one that cannot open leaves the gateway that asked served over HTTP only.

- `src/vs/base/test/node/grpcServer.test.ts`: a refused :authority is PERMISSION_DENIED before the message is read
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: a foreign :authority is PERMISSION_DENIED
- `src/vs/base/test/node/grpcServer.test.ts`: listens on [::1] as well when the machine has IPv6
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: without { grpc: true } a gateway opens no gRPC port, also on a service configured for gRPC, and its servers have no grpcAddress
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: { grpc: true } opens the listener and advertises grpcAddress; a second gateway reuses it; disposing the last one closes the port while HTTP gateways keep theirs
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: concurrent first requests for gRPC wait for one listener start and share the listener
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: when the gRPC listener cannot open, the gateway that asked is served over HTTP only (logged), and the next request opens it

## 3. Route ids: an unknown or missing route never reaches a server

zig-sdk: the principal of a request (from its token) decides what it may reach. The gateway has no authorization: each MCP server is served on its own random route id (a UUID), which the gateway gives only to the client that created the route (Copilot CLI gets it through VS Code), and the route id is the principal of the sealed request state (section 4).

An HTTP request to an unknown route is 404. A gRPC call must name its route in the `mcp-gateway-route` metadata, also when the listener serves one route (only test fixtures may allow a default route); a missing or unknown route is `NOT_FOUND`, trailers only, before the dispatcher sees the call. The routes of a gateway that did not ask for gRPC are not on the listener: a call that names one is `NOT_FOUND` exactly like an unknown route.

- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: an unknown route is 404 with a JSON-RPC -32601 body
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: by default a call must name its route, even when the listener serves one: missing or unknown is NOT_FOUND, trailers only, before the message is read
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: several routes: a call names its route, else NOT_FOUND before the dispatcher sees it
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: a route that did not ask for gRPC is NOT_FOUND over gRPC, trailers only, exactly like an unknown route
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: the product registration (mcpGatewayServiceDescriptor({ grpc: true }), as electron-main and the remote server use it) opens no gRPC port until a gateway asks for it, then advertises gRPC and requires the route

## 4. Sealed `requestState`: a per-process key, a lifetime, bound to its route

zig-sdk: secure default "Request state sealed with AES-256-GCM, 600 s lifetime, bound to the principal"; request threats "The server treats `requestState` as attacker-controlled" and "Only the principal of the request that sealed `requestState` can open it".

The gateway seals the `requestState` of an input round with AES-256-GCM under a 32-byte key that each process draws at random once (`getProcessSealedState` in `mcpGatewayService.ts`) and never writes anywhere, so state from another process or an earlier run does not open. The additional data binds the state to the method, the target and the route; it expires after 600 s. A tampered, foreign or expired state is -32602 `invalid_request_state`.

- `src/vs/platform/mcp/test/node/mcpGatewaySealedState.test.ts`: rejects tampering, truncation, malformed input and the wrong prefix
- `src/vs/platform/mcp/test/node/mcpGatewaySealedState.test.ts`: binds the state to method, target and principal
- `src/vs/platform/mcp/test/node/mcpGatewaySealedState.test.ts`: rejects a value sealed under another key
- `src/vs/platform/mcp/test/node/mcpGatewaySealedState.test.ts`: expires after the TTL using the injected clock
- `src/vs/platform/mcp/test/node/mcpGatewaySealedState.test.ts`: requires a 32-byte key
- `src/vs/platform/mcp/test/node/mcpGatewaySealedState.test.ts`: each seal uses a fresh nonce
- `src/vs/platform/mcp/test/node/mcpGatewayDispatcher.test.ts`: a tampered, foreign or non-string requestState is -32602 invalid_request_state
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: input rounds: the sealed requestState continues on its own route only
- conformance server 2026-07-28 `input-required-result-tampered-state`

## 5. No credentials in logs

zig-sdk: secure default "Tokens: never logged".

The gateway takes no credentials: it reads no `Authorization` header and passes none to the MCP servers behind it, which it reaches through VS Code's tool broker, not over the network. Its log lines name routes, sessions, methods and HTTP statuses (and, at the debug level, listen filters), not request bodies. The credentials VS Code does handle are those of its OAuth client for remote MCP servers; every log line of it, of the product's sign-in path and of the conformance client goes through a redaction of tokens, codes, verifiers, secrets, assertions, `Location`, `Authorization` and cookies.

- `src/vs/base/test/common/oauthClient.test.ts`: redact strips credentials from log messages
- `src/vs/base/test/common/oauthClient.test.ts`: the log never contains tokens, codes, verifiers or secrets
- `src/vs/workbench/api/test/browser/extHostAuthentication.test.ts`: logs neither the code, the verifier, the client secret nor any token
- `src/vs/workbench/api/test/node/mcpConformanceProxy.test.ts`: uses the OAuth client's redaction: verifiers, assertions, JSON codes, Location; and blanks cookies

## 6. Body and message size caps

zig-sdk: secure default "Body and line limits: 4 MiB per HTTP body"; transport threats on header block limits (`ENHANCE_YOUR_CALM`) and message limits.

An HTTP request body over 1 MiB is 413. A gRPC request or response message over 4 MiB is `RESOURCE_EXHAUSTED`, also before the request ends; a header list over 8 KiB resets the stream with `ENHANCE_YOUR_CALM`. The replay log of a stream keeps at most 256 events and 4 MiB of data.

- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: an oversized body is 413 and malformed JSON is 400 with -32700
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: a request message over 4 MiB is RESOURCE_EXHAUSTED
- `src/vs/base/test/node/grpcServer.test.ts`: a request message over the limit is RESOURCE_EXHAUSTED, also before the request ends (RST_STREAM NO_ERROR)
- `src/vs/base/test/node/grpcServer.test.ts`: a response message over the send limit is RESOURCE_EXHAUSTED
- `src/vs/base/test/node/grpcServer.test.ts`: a header list over 8 KiB is reset with ENHANCE_YOUR_CALM
- `src/vs/platform/mcp/test/node/mcpGatewayEventLog.test.ts`: the log is bounded: the oldest events are dropped and a replay says it is truncated

## 7. `subscriptions/listen` caps

zig-sdk: request threat "A `subscriptions/listen` filter has a size limit" (-32603, no stream).

A route keeps at most 64 listen streams; the next one is refused with -32603. A filter may name at most 1024 distinct resource URIs and be at most 64 Ki characters long; a filter over a limit is -32603 and opens nothing on the server, and a malformed one is -32602.

- `src/vs/platform/mcp/test/node/mcpGatewayListenRegistry.test.ts`: the stream after ${MAX_LISTEN_STREAMS} open ones is refused with -32603
- `src/vs/platform/mcp/test/common/mcpGatewayProtocol.test.ts`: validateSubscriptionFilter: at most MAX_LISTEN_RESOURCE_SUBSCRIPTIONS distinct URIs and MAX_LISTEN_FILTER_LENGTH characters (-32603); honorSubscriptionFilter keeps each URI once
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: subscriptions/listen: a filter over the resource subscription limit is -32603 and opens nothing on the server; repeated URIs are subscribed once
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: subscriptions/listen: a malformed filter is 400 with -32602, not an internal error

## 8. Rate limits

zig-sdk: request threats "A caller over its tool call limit gets an error before the server validates the arguments", "The limit of one principal does not affect another principal" and "Many callers cannot make the buckets use more memory than `max_callers` allows". (zig-sdk turns rate limits off by default; the gateway turns them on.)

`tools/call` (50 a second, bursts of 100) and `completion/complete` (20 a second, bursts of 40) are limited per client, and a route-wide bucket of four times the rate holds all clients together, so a client that changes its identity at each call gains nothing. A refused request is -32603 with `data.reason` `rate_limited` and `retryAfterMs`, never reaches the upstream server, and on gRPC ends with `RESOURCE_EXHAUSTED`. At most 1024 client buckets are kept, keyed by a fixed-size hash, and an idle one is forgotten after 10 minutes.

- `src/vs/platform/mcp/test/node/mcpGatewayRateLimit.test.ts`: a token bucket per client: a full burst, then one request per period, refilled at an even rate up to the burst
- `src/vs/platform/mcp/test/node/mcpGatewayRateLimit.test.ts`: a route-wide bucket of ROUTE_RATE_MULTIPLIER times the rate holds all clients together
- `src/vs/platform/mcp/test/node/mcpGatewayRateLimit.test.ts`: a client that changes its client info at each request is held to the route-wide ceiling
- `src/vs/platform/mcp/test/node/mcpGatewayRateLimit.test.ts`: at most MAX_RATE_LIMITED_CLIENTS buckets: the least recently seen client is forgotten
- `src/vs/platform/mcp/test/node/mcpGatewayRateLimit.test.ts`: client keys are fixed-size hashes of the client identity, whatever the client info claims
- `src/vs/platform/mcp/test/node/mcpGatewayDispatcher.test.ts`: rate limits: tools/call and completion/complete per client, -32603 rate_limited with retryAfterMs, never reaching the upstream; both eras
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: rate limits (service option): tools/call and completion/complete over the limit are -32603 rate_limited, per client, on both revisions
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: a request over the route's rate limit ends with RESOURCE_EXHAUSTED on both bindings, -32603 rate_limited in mcp-error-bin

## 9. Mirrored headers and the protocol version

zig-sdk: transport threats "Verify `Mcp-*` headers against the body, answer -32020", "Reject control characters, bytes that are not ASCII and unsafe integers in mirrored headers", "Decode the base64 sentinel with a strict alphabet" and "Answer -32022 for an unsupported version".

Every 2026-07-28 request, over HTTP and over both gRPC bindings, goes through the same check of its `_meta`, its protocol version and its mirrored headers before it runs: a mismatch is -32020, an unsupported version -32022 with the supported versions.

- `src/vs/platform/mcp/test/node/mcpGatewayDispatcher.test.ts`: prepareModernRequest validates _meta, the version and the mirrored headers
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: a header mismatch ends the call before the request runs: -32020 in mcp-error-bin
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: an unsupported protocol version is -32022 with the supported versions
- conformance server 2026-07-28 `http-header-validation`
- conformance server 2026-07-28 `http-custom-header-server-validation`
- conformance server 2026-07-28 `server-stateless`

## 10. Input requests only for declared client capabilities

zig-sdk: request threats "A missing client capability answers -32021", "`includeContext` other than `none` needs the capability `sampling.context`" and "The server requests only declared input kinds".

- `src/vs/platform/mcp/test/node/mcpGatewayDispatcher.test.ts`: an input request for an undeclared client capability is -32021 naming the capability
- `src/vs/platform/mcp/test/node/mcpGatewayDispatcher.test.ts`: a sampling request with includeContext other than none needs sampling.context
- `src/vs/platform/mcp/test/node/mcpGatewayDispatcher.test.ts`: a tool-enabled sampling request reaches only a client with sampling.tools: -32021 on 2026-07-28, never bridged to a 2025-11-25 client without it
- conformance server 2026-07-28 `input-required-result-capability-check`

## 11. Cancellation stays with its client

zig-sdk: transport threats "Close of the HTTP stream cancels the request", "A server sends nothing for a request that the client canceled" and "A closed connection cancels only its own requests".

A `notifications/cancelled` without client info reaches the requests and listen streams of the only client of its address that uses the id, counting both together: when two clients of the address use it, it cancels nothing, also when one of them is a client that never sends client info (the cancellation then matches that client's key, but the other client may have sent it). A cancelled listen stream ends without a `subscriptions/listen` result.

- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: closing a 2026-07-28 response stream cancels the request
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: notifications/cancelled reaches only the requests and listen streams of the client that sent it
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: notifications/cancelled without _meta is ambiguous across listen streams and requests: two clients of the address use the id, one for each, and it cancels neither
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: notifications/cancelled without _meta is ambiguous when a client that sends no client info and a named client of the address use the id: it cancels neither
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: subscriptions/listen: acknowledgement first, honoured filter, tagged notifications; a cancelled stream ends without a result
- `src/vs/platform/mcp/test/node/mcpGatewaySession.test.ts`: cancellation is scoped to the session: another session's request with the same id runs on
- `src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts`: a client reset and grpc-timeout cancel the request in the dispatcher

## 12. Bounded state per route

zig-sdk: the limits of "Limits and Security": bounded memory per request and per caller.

A route keeps at most 256 legacy (2025-11-25) sessions, replacing the least recently active idle one and refusing a new one with 503 while all are busy; an idle session expires after 30 minutes. A session subscribes to at most 1024 resources with `resources/subscribe`, whose URIs add up to at most 64 Ki characters (the limits of one `subscriptions/listen` filter); one more is -32603 and never reaches the server. An SSE response (a 2026-07-28 request or listen stream, a 2025-11-25 GET or POST stream) whose client stops reading is closed once 16 MiB are queued for it. A task stays readable for its `ttlMs`, and the number of tasks is bounded. An input round bridged to a legacy client may repeat at most 10 times.

- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: 2025-11-25: a route keeps at most maxLegacySessions sessions: a new one replaces the least recently active idle session, and is refused with 503 while every session is busy
- `src/vs/platform/mcp/test/node/mcpGatewaySession.test.ts`: an idle session expires; messages in flight and open responses keep it alive
- `src/vs/platform/mcp/test/node/mcpGatewaySession.test.ts`: resources/subscribe: a session keeps at most ${MAX_LEGACY_RESOURCE_SUBSCRIPTIONS} subscriptions, also when they are opened concurrently (-32603); a repeated URI is no new one, an unsubscribe makes room
- `src/vs/platform/mcp/test/node/mcpGatewaySession.test.ts`: resources/subscribe: the subscribed URIs of a session add up to at most ${MAX_LEGACY_SUBSCRIPTION_URI_LENGTH} characters (-32603)
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: a 2026-07-28 listen stream whose client stops reading is closed once maxBufferedSseBytes are queued, without a result
- `src/vs/platform/mcp/test/node/mcpGatewayRoute.test.ts`: 2025-11-25: a GET stream whose client stops reading is closed once maxBufferedSseBytes are queued; the session lives on
- `src/vs/platform/mcp/test/node/mcpGatewayTasks.test.ts`: a task stays readable for its ttlMs and is dropped after it; the number of tasks is bounded
- `src/vs/platform/mcp/test/node/mcpGatewayDispatcher.test.ts`: legacy bridge: no request channel, a non-object answer and endless rounds are -32603

## 13. Slow and silent gRPC peers

zig-sdk: transport threats "A slow client cannot keep a connection without end", "A `grpc-timeout` value in hours, such as `99999999H`, does not cause an integer overflow" and "A gRPC call that stops does not keep its stream or its task".

A call that does not deliver its request message in time is `DEADLINE_EXCEEDED`; a client that stops reading gets its stream reset once the send buffer is full; an idle connection is closed with GOAWAY; a `grpc-timeout` beyond what a timer can wait arms no deadline; a client reset cancels the call.

- `src/vs/base/test/node/grpcServer.test.ts`: a call that does not deliver its request message in time is DEADLINE_EXCEEDED
- `src/vs/base/test/node/grpcServer.test.ts`: a client that stops reading gets its stream reset once the send buffer is full; one that reads gets everything
- `src/vs/base/test/node/grpcServer.test.ts`: an idle connection is closed with GOAWAY
- `src/vs/base/test/node/grpcServer.test.ts`: a grpc-timeout beyond what a timer can wait arms no deadline (3000000S, 99999999H)
- `src/vs/base/test/node/grpcServer.test.ts`: RST_STREAM from the client cancels the call
- `src/vs/base/test/node/grpcServer.test.ts`: the connection advertises the limits and no server push
