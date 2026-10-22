# MCP 2026-07-28 schema fixtures

Vendored from https://github.com/modelcontextprotocol/modelcontextprotocol at commit
`046fa30efd374370afb87ef830bd788eac5f217e` (`schema/2026-07-28/`), the same pin as
`build/mcp/mcp-schema-2026-07-28.ts`. License: MIT AND Apache-2.0 (see the
`modelcontextprotocol/modelcontextprotocol` entry in `ThirdPartyNotices.txt`).

- `schema.json` — the JSON Schema 2020-12 document of the revision.
- `examples/<TypeName>/<case>.json` — the golden examples; each validates against
  `#/$defs/<TypeName>` of `schema.json`.

Consumed by `src/vs/platform/mcp/test/node/mcpSchemaGoldenExamples.test.ts`.
