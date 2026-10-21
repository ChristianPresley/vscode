# Draft for vscode-docs: gRPC servers and the new `mcp.json` properties

*A draft of the sections to add to the MCP servers page of vscode-docs (`docs/copilot/customization/mcp-servers.md`). It describes the behaviour of this branch; the headings follow the page's existing structure.*

---

## Add an MCP server that uses gRPC

Besides local servers (`stdio`) and remote servers (`http`), VS Code can connect to MCP servers over [gRPC](https://grpc.io/). Add the server to `mcp.json` with the type `grpc` and a `grpc://` or `grpcs://` URL:

```jsonc
{
	"servers": {
		"inventory": {
			"type": "grpc",
			"url": "grpcs://inventory.example.com:443"
		}
	}
}
```

Use `grpcs://` for servers on other machines: it connects with TLS and verifies the server certificate against the system's trusted roots. `grpc://` connects with cleartext HTTP/2 and is meant for servers on your own machine or network.

You can also run **MCP: Add Server** from the Command Palette and select **gRPC**.

> **Note:** gRPC servers run in the Node.js extension host. They are not available in VS Code for the Web.

### gRPC server configuration

| Property | Type | Description |
| --- | --- | --- |
| `type` | `"grpc"` | The server type. |
| `url` | string | The endpoint: `grpc://host:port` (cleartext) or `grpcs://host:port` (TLS). |
| `headers` | object | Metadata sent with every call, for example an API key. It is never sent to another authority than the one in `url`. |
| `tls.ca` | string | Path to a PEM file of certificate authorities that verify the server certificate, in addition to the system roots. Variables such as `${workspaceFolder}` are resolved. |
| `tls.serverName` | string | The host name sent in the TLS handshake (SNI) and checked against the certificate, when it differs from the host in `url`. |
| `tls.insecure` | boolean | Skips the verification of the server certificate. Only for local development. When your organization restricts MCP servers with an allow list, `tls.insecure` is not allowed. |
| `binding` | `"auto"`, `"tunnel"` or `"typed"` | The gRPC service the server implements. `tunnel` sends MCP's JSON-RPC messages through the `mcp.zig.transport.v1.Mcp/Call` method. `typed` calls Google's typed `model_context_protocol.Mcp` service. `auto` (the default) is the tunnel: VS Code never switches to the typed service on its own. Set `typed` for a server that only offers the typed service. |
| `deadlineMs` | number | The deadline of every call, in milliseconds (more than 0). Without it, discovery, listing, reading resources, prompts and completions time out after 60 seconds, and tool calls have no deadline. |
| `keepAliveMs` | number | The interval between HTTP/2 keep-alive pings, in milliseconds, at least `300000` (5 minutes): gRPC servers close connections that ping more often. The pings are sent only while at least one call is open; if the server still answers with `too_many_pings`, the interval is doubled for the next connection. `0` sends no pings at all. Without it, a ping is sent every 5 minutes and 10 seconds only while a `subscriptions/listen` stream is open, so that a NAT or load balancer does not cut a stream that has no events for a while. |
| `oauth` | object | OAuth settings, as for `http` servers (see [OAuth settings](#oauth-settings)). |
| `protocolVersion` | string | Pins the MCP revision (see [Pin the protocol revision](#pin-the-protocol-revision)). |

The typed service carries less than the tunnel: it has no subscriptions (so no list-changed notifications or resource updates), no progress or log notifications, only the first page of a list, and no tasks. MCP requires a custom transport to keep the JSON-RPC message format, which only the tunnel does, so VS Code uses the typed service only when `binding` is `typed`. With `auto` or `tunnel`, a server that does not implement the tunnel fails to start, and its output shows:

```text
The gRPC server at host:port does not implement the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp). If it only offers Google's typed MCP service, set "binding": "typed" in its configuration, or, if an extension provides the server, ask its author to use McpGrpcBinding.Typed.
```

When the server sent a reason with its `UNIMPLEMENTED` (a `grpc-message`), the first sentence quotes it instead, since it tells more about the server than `UNIMPLEMENTED` alone (for example, another gRPC service listening on that port names the service it does not know):

```text
The gRPC server at host:port answered a call to the MCP JSON-RPC tunnel service (mcp.zig.transport.v1.Mcp) with UNIMPLEMENTED: "unknown service mcp.zig.transport.v1.Mcp". If it only offers Google's typed MCP service, set "binding": "typed" in its configuration, or, if an extension provides the server, ask its author to use McpGrpcBinding.Typed.
```

For a server that an extension provides, the extension sets the binding (`McpGrpcBinding.Typed` in its `McpGrpcServerDefinition`); you cannot change it in `mcp.json`.

(Earlier builds tried the tunnel and fell back to the typed service, decision 11 of the implementation plan; that is superseded.)

### Authentication

A gRPC server that requires authorization answers a call with `UNAUTHENTICATED`. VS Code then reads the OAuth protected resource metadata of the server's HTTPS address (`https://host:port`), signs you in with the authorization server it names, and sends the token as `authorization` metadata. VS Code warns once in the server's output when it sends a token over cleartext `grpc://` to a host other than your own machine.

### Proxies and policies

gRPC connections use the proxy settings of VS Code (`http.proxy`, `http.proxySupport`), including proxy authentication. The enterprise policies that allow or deny MCP servers by URL apply to gRPC URLs as well.

### Extensions

Extensions can contribute gRPC servers with the proposed API `mcpGrpcServerDefinition`: return a `McpGrpcServerDefinition` (which extends `McpHttpServerDefinition` with `tls` and `binding`) from an MCP server definition provider.

## Pin the protocol revision

VS Code supports the MCP revision 2026-07-28 and the earlier revisions that start with an `initialize` handshake (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07). It negotiates the newest revision that both VS Code and the server support: it first asks with `server/discover`, and falls back to `initialize` when the server does not understand it. It remembers the result for the next start.

If a server misbehaves with the negotiated revision, pin one with `protocolVersion`:

```jsonc
{
	"servers": {
		"legacy-tools": {
			"type": "http",
			"url": "https://tools.example.com/mcp",
			"protocolVersion": "2025-11-25"
		}
	}
}
```

When the server rejects a pinned revision, VS Code falls back to negotiation. It then uses the negotiated revision instead of the pin, and says so in the server's output, until you change the pin or the server's command, URL or other connection settings, or run **MCP: Reset Cached Tools**.

## OAuth settings

VS Code signs in to MCP servers that require authorization following the MCP authorization specification. It requires PKCE (`S256`) and HTTPS endpoints, checks the issuer of the authorization server metadata and of every authorization response, and keeps registrations and tokens separate for each authorization server. These `oauth` properties of an `http` or `grpc` server change the defaults:

| Property | Type | Description |
| --- | --- | --- |
| `oauth.clientId` | string | A client ID registered for VS Code with the authorization server, for authorization servers that support neither client ID metadata documents nor dynamic client registration. Use the **Set Client Secret** code lens to store its secret in the OS secret store. |
| `oauth.authorizationServer` | string | The issuer URL of the authorization server that `clientId` belongs to. VS Code never sends the client ID and secret to another authorization server. Without it, they are bound to the first authorization server they are used with. |
| `oauth.pkce` | `"require-advertised"` or `"assume-supported"` | By default (`require-advertised`), VS Code signs in only with authorization servers whose metadata advertises the `S256` PKCE method. `assume-supported` uses PKCE `S256` anyway, for authorization servers that support it without advertising it. |
| `oauth.allowInsecureHttp` | boolean | Allows `http://` authorization endpoints on hosts other than your own machine. Only for local development: tokens and credentials are sent unencrypted. Loopback hosts are always allowed. |

When a server moves to another authorization server, VS Code signs in again with the new one and forgets the registration and tokens of the old one. When a server asks for more permissions during use, VS Code asks you to sign in again with the additional scopes.

## Use the MCP servers of VS Code in Copilot CLI

Copilot CLI reaches the MCP servers you configured in VS Code through the MCP gateway, a server on your machine that VS Code starts for it. The gateway speaks MCP 2026-07-28 and the earlier `initialize`-based revisions over HTTP, and over gRPC when the extension that starts it asks for it; it only accepts connections from your own machine. It limits how fast one client may call tools (50 calls a second, bursts of 100) and request completions (20 a second, bursts of 40); a client over the limit is told when to retry.
