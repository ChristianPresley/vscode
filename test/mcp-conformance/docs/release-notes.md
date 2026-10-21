# Release notes: MCP 2026-07-28, gRPC servers and stricter OAuth

## Model Context Protocol 2026-07-28

VS Code speaks the 2026-07-28 revision of the [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28) with MCP servers that support it, and keeps working with every server that does not.

- **Stateless requests.** Every request carries its protocol version, the client capabilities and the client information in `_meta`; there is no session to set up. VS Code learns a server's version, capabilities and instructions with `server/discover`.
- **Input during a request.** A tool call, a prompt or a resource read can ask for input (`input_required`): a form or URL elicitation, a sampling request or the roots. VS Code answers in the chat and sends the request again with the answers and the server's state, for up to ten rounds.
- **Sampling.** A sampling request's `maxTokens` limits the model's answer (it is passed to the language model as the `max_tokens` option). When a language model with tool calling is available, VS Code declares `sampling.tools` and passes the request's `tools` and `toolChoice` to the model.
- **Elicitation messages.** The message of a form or URL elicitation is shown as literal text: no link, image or formatting in it is rendered, so a server cannot disguise a link. The URL of a URL elicitation is shown in full before it is opened.
- **Subscriptions.** List changes and resource updates arrive on `subscriptions/listen` streams, which VS Code reopens with a growing backoff when they drop.
- **Caching.** A public tool list stays valid for its `ttlMs` (at most a day) across reconnects, so a restarted server does not have to be listed again; private lists are listed again.
- **HTTP headers.** Requests carry `Mcp-Method` and `Mcp-Name`, and the parameters a tool marks with `x-mcp-header` are mirrored into `Mcp-Param-*` headers (Base64-encoded when needed). Tools with invalid annotations are dropped and logged; a header mismatch makes VS Code list the tools again and retry once.
- **Schemas.** Tool input schemas, output schemas and elicitation forms are validated with JSON Schema 2020-12 or draft-07 (when `$schema` names it); without `$schema` a 2026-07-28 server gets 2020-12 and a server of an earlier revision draft-07. A `$ref` to a network URI is never fetched, and a `pattern` that cannot be compiled is not checked (a warning in the server's output). From a 2026-07-28 server, a tool whose schema names another dialect is not offered, a result whose `structuredContent` does not match the tool's output schema (or whose output schema does not compile) is an error, and a form whose schema does not compile is declined. For servers of earlier revisions a schema that does not compile is not checked, with a warning, as before.
- **Tasks.** With the Tasks extension (`io.modelcontextprotocol/tasks`), a long tool call runs as a task that VS Code polls, answers input for and cancels.

### Both eras, one client

VS Code supports the 2026-07-28 revision and the earlier revisions that use the `initialize` handshake (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07).

- For a new server VS Code first sends `server/discover`. A server that rejects it the way earlier revisions do, or that does not answer within 10 seconds on stdio, gets the `initialize` handshake instead. A server that answers `UnsupportedProtocolVersionError` with a list of versions gets the newest one both sides speak.
- VS Code remembers which revision a server spoke and uses it the next time, probing again only when the server rejects it.
- A request that a 2026-07-28 server rejects as an unsupported version is negotiated again and retried once.

### Pin the protocol revision

The new `protocolVersion` property of a server in `mcp.json` pins the revision VS Code uses, for example `"protocolVersion": "2025-11-25"` for a server that misbehaves on the newer revision. A pinned revision that the server rejects still falls back to negotiation. VS Code then uses the negotiated revision instead of the pin, and says so in the server's output, until the pin or the server's connection settings change or you run **MCP: Reset Cached Tools**.

## MCP servers over gRPC

A server in `mcp.json` can now have the type `grpc`:

```jsonc
{
	"servers": {
		"inventory": {
			"type": "grpc",
			"url": "grpcs://inventory.example.com:443",
			"binding": "auto",
			"tls": { "ca": "${workspaceFolder}/certs/ca.pem" },
			"deadlineMs": 120000,
			"keepAliveMs": 300000
		}
	}
}
```

- `url`: `grpc://host:port` (cleartext HTTP/2) or `grpcs://host:port` (TLS with ALPN `h2`).
- `headers`: metadata sent with every call to the server's authority.
- `tls`: `ca` (a PEM bundle used in addition to the system roots), `serverName` (the name sent as SNI and checked against the certificate) and `insecure` (skips certificate verification, for local development; an enterprise allow list policy denies it).
- `binding`: `tunnel` sends the JSON-RPC messages through `mcp.zig.transport.v1.Mcp/Call`, `typed` calls Google's typed `model_context_protocol.Mcp` service, and `auto` (the default) is the tunnel. VS Code never switches to the typed service on its own: MCP requires a custom transport to keep the JSON-RPC message format, which the typed service does not. A server that does not implement the tunnel fails to start with "The gRPC server at host:port does not implement the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp). If it only offers Google's typed MCP service, set "binding": "typed" in its configuration, or, if an extension provides the server, ask its author to use McpGrpcBinding.Typed." When the server's `UNIMPLEMENTED` carries a `grpc-message`, the first sentence quotes it instead ("The gRPC server at host:port answered a call to the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp) with UNIMPLEMENTED: "…"."), because the server's reason tells more than a bare `UNIMPLEMENTED`, for example when another gRPC service listens on that port. Set `"binding": "typed"` (`McpGrpcBinding.Typed` in an extension's `McpGrpcServerDefinition`) for a typed-only server; the typed service carries less: no subscriptions, no notifications, only the first page of a list and no tasks. (This replaces the earlier plan, decision 11, of an `auto` that tried the tunnel and fell back to the typed service.)
- `deadlineMs`: the deadline of every call, in milliseconds (more than 0). Without it, discovery, listing, reads, prompts and completions get 60 seconds and tool calls have no deadline; a `subscriptions/listen` stream never has one.
- `keepAliveMs`: the interval of HTTP/2 keep-alive pings, at least 300000 (5 minutes): gRPC servers close connections that ping more often (`too_many_pings`). The pings are sent only while at least one call is open, as gRPC clients do by default, and after a `too_many_pings` the interval is doubled for the next connection. `0` sends no pings at all. Without it, a ping is sent every 5 minutes and 10 seconds only while a `subscriptions/listen` stream is open, so that a NAT or load balancer does not cut a stream that has no events for a while.
- `oauth`: the same properties as for HTTP servers. A server that answers `UNAUTHENTICATED` is authorized through the protected resource metadata of `https://host:port`, and the token is sent as `authorization` metadata. VS Code warns once when it sends a token over cleartext `grpc://` to a host other than loopback.

gRPC servers run in the Node.js extension host, so they are not available in VS Code for the Web. They honor the HTTP proxy settings (`http.proxy`, `http.proxySupport`) and the enterprise allow list of MCP server URLs.

Extensions can provide gRPC servers with the proposed API `mcpGrpcServerDefinition`: `McpGrpcServerDefinition` extends `McpHttpServerDefinition` with `tls` and `binding` (`McpGrpcBinding.Auto`, the default and the tunnel, `Tunnel` or `Typed`).

## OAuth: stricter by default

The sign-in to MCP servers follows the OAuth 2.1 rules of the 2026-07-28 authorization specification more strictly:

- **PKCE is required.** VS Code authorizes only against authorization servers whose metadata advertises the `S256` PKCE method. For an authorization server that supports PKCE without advertising it, set `"oauth": { "pkce": "assume-supported" }` on the server.
- **HTTPS is required.** Authorization endpoints must use `https`, except on loopback hosts. For local development, `"oauth": { "allowInsecureHttp": true }` allows plain `http`.
- **Pre-registered credentials stay with their authorization server.** `oauth.clientId` and its secret are bound to the authorization server they are first used with, or to the issuer that `oauth.authorizationServer` names; VS Code never sends them to another authorization server.
- **Issuer checks.** The authorization server metadata must name the issuer it was fetched for, and the `iss` of an authorization response (RFC 9207) must match it exactly; VS Code acts on no response that fails the check.
- **Moved resources.** When a server names a new authorization server, VS Code registers again with it and drops the registration and tokens of the old one.
- **Scopes.** VS Code asks for the scopes of the server's challenge, or of its protected resource metadata, and adds `offline_access` only when the authorization server lists it. A request for more scopes (`insufficient_scope`) re-authorizes with the union of the held and the demanded scopes, at most twice per server while VS Code runs.
- **Client registration.** VS Code uses its client ID metadata document when the authorization server supports them, dynamic client registration otherwise, and asks for a client ID when neither is available.
- **Resource indicators.** Authorization, token and refresh requests carry the MCP server's resource as `resource` (RFC 8707): the `resource` its protected resource metadata publishes, exactly as written, else the canonical URL of the server (without a trailing slash for a bare origin). Microsoft Entra ID sign-ins send none.

## The MCP gateway for Copilot CLI

The MCP gateway, which makes the MCP servers of VS Code available to Copilot CLI, now serves both the 2026-07-28 revision and the `initialize`-based revisions up to 2025-11-25 over HTTP on loopback, and, for a gateway that an extension starts with `vscode.lm.startMcpGateway(resource, { grpc: true })` (`McpGatewayStartOptions` in the `mcpServerDefinitions` proposal), every server also over gRPC (`grpcAddress` of `McpGatewayServer`; a call names its server with the `mcp-gateway-route` metadata). Without that option a gateway opens no gRPC port; the gRPC listener is shared by the gateways that ask for it and is open only while one of them has a server, so it closes when the last such server goes away and may open on another port for the next one. It supports the Tasks extension, seals the state of input rounds (AES-GCM, bound to the method, the target and the client), validates the mirrored headers and protects against DNS rebinding with Host and Origin checks (`:authority` on gRPC).

The gateway limits `tools/call` to 50 requests a second (bursts of 100) and `completion/complete` to 20 a second (bursts of 40) per client, with a ceiling of four times that for all clients of a server together. A request over a limit is refused before it reaches the server with the JSON-RPC error -32603, `data.reason` `rate_limited` and `data.retryAfterMs`; on gRPC the call ends with `RESOURCE_EXHAUSTED` and carries the same error. The [threat model of the gateway](../gateway-threats.md) lists its defences and the tests that cover them.

## Conformance

VS Code passes every scored client and server scenario of the official MCP conformance suite (`@modelcontextprotocol/conformance` 0.2.0-alpha.12) for 2026-07-28 and 2025-11-25, and every check of the not-scored Tasks and HTTP-header server scenarios. The [conformance matrix](mcp-conformance-matrix.md) maps each normative sentence of the specification to the tests that cover it and lists the deliberate deviations, among them:

- Resource reads are coalesced for 3 seconds whatever `ttlMs` the server sends.
- Microsoft Entra ID sign-ins send no `resource` parameter.
- Icons are also accepted over `http` from the server's own host and as `file:` URIs from local stdio servers.
- The typed gRPC binding cannot carry subscriptions, notifications, pagination beyond the first page or tasks.
