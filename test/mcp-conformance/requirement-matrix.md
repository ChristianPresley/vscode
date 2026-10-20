# MCP conformance requirement matrix

One row per scenario that the requirement sets of `@modelcontextprotocol/conformance@0.2.0-alpha.11` name (`requirements/2026-07-28.yaml` and `requirements/2025-11-25.yaml`), for both legs and both revisions: the scored scenarios and the `not_scored` ones. A scenario that belongs to both revisions has a row for each, because it runs once at each revision's wire.

`node test/mcp-conformance/run.ts check-matrix` checks this file: every scenario of both requirement sets has exactly one row, the scoring column matches the set, every `gap` row has an entry in its expected-failures file, and every not-scored row is driven or baselined. It also checks `requirement-tests.json`.

| Status | Meaning |
| --- | --- |
| driven | A fixture of this repository runs the scenario: the client leg runs `out/vs/workbench/api/node/mcpConformanceClientMain.js`, the server leg runs the gateway fixture `out/vs/platform/mcp/node/mcpGatewayConformanceMain.js` (milestone M6). Every check must pass. |
| gap | The fixture runs the scenario, but it fails checks of a feature that is not implemented yet. Each failing check (or the whole scenario) is listed in the expected-failures file of the row (`expected-failures-<leg>-<revision>.yml` for scored rows, `expected-failures-unscored.yml` for not-scored rows), and the notes name the milestone that closes the gap. |
| n-a | The harness does not run the scenario; the notes say why. |

## Client leg

### 2026-07-28

| Leg | Revision | Scenario | Scoring | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| client | 2026-07-28 | `tools_call` | scored | driven | `tools/list`, then `tools/call` with arguments that satisfy the input schema |
| client | 2026-07-28 | `request-metadata` | scored | driven | `server/discover`, retried after the version rejection; `_meta` on every request |
| client | 2026-07-28 | `auth/metadata-default` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/metadata-var1` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/metadata-var2` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/metadata-var3` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/basic-cimd` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/scope-from-www-authenticate` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/scope-from-scopes-supported` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/scope-omitted-when-undefined` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/scope-step-up` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/scope-retry-limit` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/token-endpoint-auth-basic` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/token-endpoint-auth-post` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/token-endpoint-auth-none` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/pre-registration` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/resource-mismatch` | scored | driven | the protected resource metadata names another resource: discovery fails (`resource_mismatch`) before any authorization request |
| client | 2026-07-28 | `auth/offline-access-scope` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/offline-access-not-supported` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/authorization-server-migration` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/iss-supported` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/iss-not-advertised` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/iss-supported-missing` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/iss-wrong-issuer` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/iss-unexpected` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/iss-normalized` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2026-07-28 | `auth/metadata-issuer-mismatch` | scored | driven | the authorization server metadata names another issuer: discovery fails (`issuer_mismatch`) before registration |
| client | 2026-07-28 | `sep-2322-client-request-state` | scored | driven | echoes `requestState` on the MRTR retries and omits it when absent |
| client | 2026-07-28 | `http-standard-headers` | scored | driven | `Mcp-Method` and `Mcp-Name` on every tool, resource and prompt request |
| client | 2026-07-28 | `http-custom-headers` | scored | driven | mirrors the `x-mcp-header` parameters into `Mcp-Param-*` headers |
| client | 2026-07-28 | `http-invalid-tool-headers` | scored | driven | drops the tools whose `x-mcp-header` annotations are invalid |
| client | 2026-07-28 | `json-schema-ref-no-deref` | scored | driven | never dereferences a network `$ref` of an input schema |
| client | 2026-07-28 | `auth/client-credentials-jwt` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2026-07-28 | `auth/client-credentials-basic` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2026-07-28 | `auth/enterprise-managed-authorization` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2026-07-28 | `auth/dpop` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2026-07-28 | `auth/dpop-nonce` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2026-07-28 | `auth/wif-jwt-bearer` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2026-07-28 | `json-schema-2020-12-preservation` | not-scored | driven | added-after-release: echoes the focal tool's `inputSchema` exactly as received |

### 2025-11-25

| Leg | Revision | Scenario | Scoring | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| client | 2025-11-25 | `initialize` | scored | driven | the engine's initialize handshake, then `tools/list` |
| client | 2025-11-25 | `tools_call` | scored | driven | `tools/list`, then `tools/call` with arguments that satisfy the input schema |
| client | 2025-11-25 | `elicitation-sep1034-client-defaults` | scored | driven | accepts the form elicitation with the schema defaults (SEP-1034) |
| client | 2025-11-25 | `sse-retry` | scored | driven | the transport resumes the closed SSE stream after the advertised `retry`; also runs alone after the parallel run |
| client | 2025-11-25 | `auth/metadata-default` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/metadata-var1` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/metadata-var2` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/metadata-var3` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/basic-cimd` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/scope-from-www-authenticate` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/scope-from-scopes-supported` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/scope-omitted-when-undefined` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/scope-step-up` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/scope-retry-limit` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/token-endpoint-auth-basic` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/token-endpoint-auth-post` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/token-endpoint-auth-none` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/pre-registration` | scored | driven | OAuth (M5): the transport answers the challenges; the conformance OAuth client (the product's rule set) registers and authorizes |
| client | 2025-11-25 | `auth/client-credentials-jwt` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2025-11-25 | `auth/client-credentials-basic` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2025-11-25 | `auth/enterprise-managed-authorization` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2025-11-25 | `auth/dpop` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2025-11-25 | `auth/dpop-nonce` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2025-11-25 | `auth/wif-jwt-bearer` | not-scored | gap | extension: an authorization extension the client does not implement; baselined whole |
| client | 2025-11-25 | `json-schema-2020-12-preservation` | not-scored | driven | added-after-release: echoes the focal tool's `inputSchema` exactly as received |

## Server leg

### 2026-07-28

| Leg | Revision | Scenario | Scoring | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| server | 2026-07-28 | `server-stateless` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `completion-complete` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-list` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-call-simple-text` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-call-image` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-call-audio` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-call-embedded-resource` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-call-mixed-content` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-call-error` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tools-call-with-progress` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `server-sse-multiple-streams` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `resources-list` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `resources-read-text` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `resources-read-binary` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `resources-templates-read` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `sep-2164-resource-not-found` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `prompts-list` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `prompts-get-simple` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `prompts-get-with-args` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `prompts-get-embedded-resource` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `prompts-get-with-image` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `dns-rebinding-protection` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `caching` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-basic-elicitation` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-basic-sampling` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-basic-list-roots` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-request-state` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-multiple-input-requests` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-multi-round` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-missing-input-response` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-non-tool-request` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-result-type` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-unsupported-methods` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-tampered-state` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-capability-check` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-ignore-extra-params` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `input-required-result-validate-input` | scored | driven | gateway fixture (M6) |
| server | 2026-07-28 | `tasks-lifecycle` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `tasks-capability-negotiation` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `tasks-wire-fields` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `tasks-request-state-removal` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `tasks-mrtr-input` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `tasks-request-headers` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `tasks-dispatch-and-envelope` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `tasks-status-notifications` | not-scored | driven | Tasks extension (M9); the suite reports no checks (notifications are optional) |
| server | 2026-07-28 | `tasks-required-task-error` | not-scored | driven | Tasks extension (M9): a `taskSupport: required` tool answers -32021 without the extension |
| server | 2026-07-28 | `tasks-mrtr-composition` | not-scored | gap | Tasks extension (M9): every functional check passes; `wire-schema-valid` is baselined in `expected-failures-unscored.yml` (the suite validates a CreateTaskResult against CallToolResult, which requires `content`) |
| server | 2026-07-28 | `json-schema-2020-12` | not-scored | driven | pending: gateway fixture (M6) |
| server | 2026-07-28 | `http-header-validation` | not-scored | driven | pending: gateway fixture (M6) |
| server | 2026-07-28 | `http-custom-header-server-validation` | not-scored | driven | pending: gateway fixture (M6) |

### 2025-11-25

| Leg | Revision | Scenario | Scoring | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| server | 2025-11-25 | `server-initialize` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `logging-set-level` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `ping` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `completion-complete` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-list` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-simple-text` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-image` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-audio` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-embedded-resource` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-mixed-content` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-with-logging` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-error` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-with-progress` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-sampling` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `tools-call-elicitation` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `elicitation-sep1034-defaults` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `server-sse-multiple-streams` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `elicitation-sep1330-enums` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `resources-list` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `resources-read-text` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `resources-read-binary` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `resources-templates-read` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `resources-subscribe` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `resources-unsubscribe` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `prompts-list` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `prompts-get-simple` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `prompts-get-with-args` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `prompts-get-embedded-resource` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `prompts-get-with-image` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `dns-rebinding-protection` | scored | driven | gateway fixture (M6) |
| server | 2025-11-25 | `server-session-lifecycle` | not-scored | driven | added-after-release: gateway fixture (M6) |
| server | 2025-11-25 | `json-schema-2020-12` | not-scored | driven | pending: gateway fixture (M6) |
| server | 2025-11-25 | `server-sse-polling` | not-scored | driven | gateway fixture: `test_reconnection` closes the stream with a retry hint; Last-Event-ID resumes it (SEP-1699) |
