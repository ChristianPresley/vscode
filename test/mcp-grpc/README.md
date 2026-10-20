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
