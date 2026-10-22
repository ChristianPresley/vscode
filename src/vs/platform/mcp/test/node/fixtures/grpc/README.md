# MCP over gRPC proto fixtures

Vendored proto files for the two gRPC bindings of the Model Context Protocol
that `src/vs/platform/mcp/common/mcpGrpcProto.ts` describes by hand. The
descriptors in that module are cross-checked against these files by
`src/vs/platform/mcp/test/node/mcpGrpcProto.test.ts`; the npm package under
`test/mcp-grpc/` loads them with `@grpc/proto-loader` and `protobufjs` for the
interop checks.

## The typed binding (Google Cloud)

| File | Upstream path |
| --- | --- |
| `mcp.proto` | `proto/mcp.proto` |
| `mcp_messages.proto` | `proto/mcp_messages.proto` |
| `LICENSE-google-mcp-grpc-proto` | `LICENSE` |

- Source: https://github.com/GoogleCloudPlatform/mcp-grpc-transport-proto
- Release `v0.2.0`, commit `1d2216c1eca5ac20267f49cd666efaeac2fd2eb9` (2026-08-31).
- License: MIT (see `LICENSE-google-mcp-grpc-proto` and the
  `GoogleCloudPlatform/mcp-grpc-transport-proto` entry in `cgmanifest.json`).
- The files are copied verbatim (via the identical copy vendored by
  `ChristianPresley/zig-sdk` under `test/fixtures/google_mcp_grpc_proto/`).

## The JSON-RPC tunnel (zig-sdk)

| File | Upstream path |
| --- | --- |
| `mcp_zig_transport_v1.proto` | `proto/mcp_zig_transport_v1.proto` |
| `LICENSE-zig-sdk` | `LICENSE` |

- Source: https://github.com/ChristianPresley/zig-sdk
- Release `v0.6.0`, commit `77146c46df2c2289185ec8151dcf173809f4b0c4` (the proto is unchanged since `v0.5.2`).
- License: Apache-2.0 (see `LICENSE-zig-sdk` and the `ChristianPresley/zig-sdk`
  entry in `cgmanifest.json`).
- The normative description of the tunnel and of the typed mapping is the
  `Transport-gRPC` page of the zig-sdk wiki.

Both bindings are test fixtures only: VS Code does not generate code from
them.

## Notices

These files are development-only test data and are not shipped with VS Code.
`cgmanifest.json` registers both upstream repositories with
`"developmentDependency": true`, so they are not listed in
`ThirdPartyNotices.txt`; the upstream licenses are kept next to the copies
instead (`LICENSE-google-mcp-grpc-proto`, `LICENSE-zig-sdk`). The
`ChristianPresley/zig-sdk` registration also covers
`test/mcp-conformance/requirements-2026-07-28.json`, which is converted from
its `docs/spec/requirements.zon`.
