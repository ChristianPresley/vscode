# MCP 2026-07-28 and gRPC: documentation

| File | What it is |
| --- | --- |
| [`mcp-conformance-matrix.md`](mcp-conformance-matrix.md) | The conformance matrix: every normative sentence of the MCP 2026-07-28 specification with the tests and conformance scenarios that cover it, the per-scenario results of the official suite, the deliberate deviations, the supported JSON Schema dialects, the features and extensions, what the typed gRPC binding cannot carry, and how the gateway gRPC listener checks a call next to zig-sdk's `grpc_server.zig`. Generated; do not edit. |
| [`release-notes.md`](release-notes.md) | The user-facing summary of the work: MCP 2026-07-28 support, the dual-era behaviour, gRPC servers, the OAuth changes, the gateway and the proposed API. |
| [`vscode-docs-mcp.md`](vscode-docs-mcp.md) | A draft for the vscode-docs MCP page: `grpc` servers in `mcp.json`, the `protocolVersion` pin and the new `oauth` properties. |
| [`../gateway-threats.md`](../gateway-threats.md) | The threat model of the MCP gateway: each item of the zig-sdk threat model that applies to it, with the tests that cover it (checked by `check-matrix`). |
| [`../../mcp-e2e/visual-verification.md`](../../mcp-e2e/visual-verification.md) | The visual verification of the end-to-end run (screenshots of the product surfaces and their verdicts), kept with the end-to-end harness in `test/mcp-e2e/`. |

## The matrix

`mcp-conformance-matrix.md` is rendered from three files of the harness folder:

- `requirements-2026-07-28.json`: the 733 normative sentences of the specification, converted from `docs/spec/requirements.zon` of [zig-sdk](https://github.com/ChristianPresley/zig-sdk) v0.5.2 (Apache-2.0) by `tools/convert-requirements.ts`.
- `requirement-tests.json`: the mapping of every requirement to the tests (`{ "file", "test" }`) and conformance scenarios (`{ "leg", "revision", "scenario", "check"? }`) that cover it, with a status (`tested`, `partial`, `deviation`, `gap` or `n-a`) and a reason where the status needs one.
- `requirement-matrix.md`: one row per scenario of the suite's requirement sets.

After a change to any of them, or to a cited test name, run from the repository root:

```sh
node test/mcp-conformance/run.ts render-matrix   # rewrite docs/mcp-conformance-matrix.md
node test/mcp-conformance/run.ts check-matrix    # what CI runs
```

`check-matrix` fails when a requirement has no mapping, when a MUST or MUST NOT is a `gap`, when a mapping names a requirement that does not exist, when a cited test is not declared by the cited file or does not run (`test.skip`, a skipped suite, `.only`), when a cited scenario is not in the suite's requirement set of its leg and revision (or its matrix row is not `driven`), when a cited check id is not defined by the suite, when a status that needs a reason has none, when the rendered matrix is not current, when `requirements-2026-07-28.json` is not the conversion of its zig-sdk source (checked when a zig-sdk checkout is available), and when a threat of `gateway-threats.md` or a row of the `grpc_server.zig` parity table cites a test that does not run.
