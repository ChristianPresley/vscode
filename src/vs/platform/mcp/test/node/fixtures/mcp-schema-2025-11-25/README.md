# MCP 2025-11-25 schema fixture

`schema.json` is the JSON Schema 2020-12 document of the released 2025-11-25
revision of the Model Context Protocol (`schema/2025-11-25/schema.json` of
https://github.com/modelcontextprotocol/modelcontextprotocol), as the official
conformance suite `@modelcontextprotocol/conformance@0.2.0-alpha.12` (the
version pinned in `test/mcp-conformance/package-lock.json`) embeds it for its
`wire-schema-valid` checks. It was taken from the suite's `dist/index.js`
(the schema object of the 2025-11-25 revision, written out as JSON with
4-space indentation) at `0.2.0-alpha.11`; the object is unchanged in
`0.2.0-alpha.12`. License: MIT AND Apache-2.0 (see the
`modelcontextprotocol/modelcontextprotocol` entry in `ThirdPartyNotices.txt`).

Consumed by `src/vs/platform/mcp/test/node/mcpGatewaySession.test.ts`: the
gateway's answers to 2025-11-25 sessions (`initialize`, `tools/list`, ...)
validate against their `#/$defs/<TypeName>` entries.
