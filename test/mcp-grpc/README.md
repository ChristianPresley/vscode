# MCP gRPC interop checks

A self-contained npm package (not part of `build/npm/dirs.ts`, so the root
`npm ci` does not install it) that checks VS Code's MCP gRPC bindings against
the reference JavaScript stack: `@grpc/grpc-js`, `@grpc/proto-loader` and
`protobufjs`. Everything is TypeScript run with Node's type stripping; there
is no build step.

The proto files come from `src/vs/platform/mcp/test/node/fixtures/grpc/`
(see its README for the sources and licenses).

## What is here

| File | Purpose |
| --- | --- |
| `src/fixtureServer.ts` | A grpc-js server that serves both bindings on one ephemeral port: the JSON-RPC tunnel `mcp.zig.transport.v1.Mcp/Call` and the typed service `model_context_protocol.Mcp`, with a fixed inventory (the echo tool `test-tool`, one prompt, one static resource, a completion). The tunnel answers `server/discover`, `tools/list`, `tools/call` and `subscriptions/listen` (acknowledgement, then open until cancelled) and reports a `tools/call` whose `mcp-name` metadata does not match the body as `-32020` in the `mcp-error-code` / `mcp-error-bin` trailers. |
| `src/fixtureServer.test.ts` | A smoke test of the fixture server through grpc-js clients. |
| `src/protobufjsRoundTrip.test.ts` | Loads the vendored protos with protobufjs and asserts that our descriptors and codec produce byte-equal encodings and canonical-equal decodings for a fixture set, including a `Struct` holding `{ a: null, b: 0, c: false, d: '' }`. |
| `src/gatewayInterop.test.ts` | Foreign gRPC clients against VS Code's MCP gateway as a gRPC server. It starts the transpiled conformance entry point `out/vs/platform/mcp/node/mcpGatewayConformanceMain.js --grpc` (one route on the conformance fixture; it prints `READY:<url>` and `GRPC:<port>`), then: grpc-js calls all eight typed RPCs and the tunnel (discover, list, call with progress, listen), and checks errors and unknown routes in the trailers; the zig-sdk example client `grpc_client` calls `add`; curl makes a raw HTTP/2 prior-knowledge tunnel call and checks `grpc-status: 0` in the trailers. |

## Running

From the repository root:

```sh
npm run transpile-client                      # the round-trip test imports the codec from out/
npm ci --prefix test/mcp-grpc --no-audit --no-fund
npm --prefix test/mcp-grpc test               # node --test src/*.test.ts
npm --prefix test/mcp-grpc run start-fixture  # prints READY:<port> and serves until SIGINT
```

The fixture server is what `.github/workflows/mcp-grpc-interop.yml` and the
VS Code client/gateway interop tests talk to. Its inventory is intentionally
small and fixed so that assertions can be literal.

### The gateway interop test

`gatewayInterop.test.ts` needs the transpiled gateway, so its gateway tests
are skipped unless enabled:

| Variable | Effect |
| --- | --- |
| `MCP_GATEWAY_GRPC_INTEROP=1` | Starts the gateway and runs the grpc-js tests, and the curl test when `curl --version` lists `HTTP2` (otherwise it is skipped as "curl without HTTP/2", as with the stock curl of Windows). |
| `MCP_ZIG_GRPC_CLIENT=<path>` | Also runs the zig-sdk example client: the path of its `grpc_client` binary (built with `zig build` in a checkout of the zig-sdk; `zig-out/bin/grpc_client`, `.exe` on Windows). |

```sh
npm run transpile-client
MCP_GATEWAY_GRPC_INTEROP=1 MCP_ZIG_GRPC_CLIENT=/path/to/zig-sdk/zig-out/bin/grpc_client \
	node --test test/mcp-grpc/src/gatewayInterop.test.ts
```

The conformance entry point is a test fixture: its gRPC listener lets a call
without the `mcp-gateway-route` metadata reach its only route
(`allowDefaultRoute`), because the zig-sdk client sends no such metadata.
The product's gateway (electron-main and the remote server) never does: every
call must name its route, the path of the server's
`grpc://127.0.0.1:<port>/<routeId>` address, and the route id is what keeps
other local processes out (the unit tests in
`src/vs/platform/mcp/test/node/mcpGatewayGrpc.test.ts` cover that mode).
Neither opens a gRPC port by itself: the entry point's route asks for gRPC
(`--grpc`), as a product gateway does when an extension starts it with
`vscode.lm.startMcpGateway(resource, { grpc: true })`; other gateways are
served over HTTP only and have no `grpcAddress`.
