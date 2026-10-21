# MCP conformance

Runs the official MCP conformance suite, [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) (pinned to `0.2.0-alpha.12`), against VS Code. It is a self-contained npm package (not part of `build/npm/dirs.ts`, so the root `npm ci` does not install it). Everything is TypeScript run with Node's type stripping; there is no build step.

The suite has two legs, and both are measured at each specification revision the suite has a requirement set for, `2026-07-28` (stateless, per-request `_meta`) and `2025-11-25` (the stateful `initialize` handshake):

- **Client leg.** The suite starts a scenario server and spawns the client as `<command> <server-url>`, with the scenario in `MCP_CONFORMANCE_SCENARIO`, its data in `MCP_CONFORMANCE_CONTEXT` and the revision in `MCP_CONFORMANCE_PROTOCOL_VERSION`. The client is `out/vs/workbench/api/node/mcpConformanceClientMain.js`: it drives VS Code's real client code, the workbench protocol engine (`McpServerRequestHandler`) over the extension-host Streamable HTTP transport (`McpHTTPHandle`), writes nothing to stdout and exits 0 when the scenario ran. The scenario drivers are in `src/vs/workbench/api/node/mcpConformanceScenarios.ts`.
- **Server leg.** The suite connects to an MCP server. The server is the MCP gateway fixture `out/vs/platform/mcp/node/mcpGatewayConformanceMain.js` (milestone M6), which prints `READY:<url>` when it listens. `server` and `all` start it, unless `--server-url` names another server or `--skip-server` skips the leg.

## What is here

| File | Purpose |
| --- | --- |
| `run.ts` | The harness: runs the suite for each leg and revision, judges the results against the baselines, kills leftover clients and checks the requirement matrix. |
| `run.test.ts` | Tests of the harness with the suite stubbed out (`node --test run.test.ts`), and of the requirements converter. |
| `expected-failures-client-<revision>.yml` | The known failing checks of the scored client scenarios of a revision. Both lists are empty: the authorization scenarios run through the conformance OAuth client (`src/vs/workbench/api/node/mcpConformanceOAuth.ts`), which is built with the product's rule set (milestone M5). |
| `expected-failures-server-<revision>.yml` | The same for the server leg. Both lists are empty. |
| `expected-failures-unscored.yml` | The known failures of the scenarios the requirement sets run without scoring (`not_scored`): the six authorization-extension client scenarios, as whole scenarios. The server list is empty: every check of the `tasks-*` scenarios passes (since 0.2.0-alpha.12 the suite validates a CreateTaskResult against the generic result envelope). |
| `requirement-matrix.md` | One row per scenario of both requirement sets, legs and revisions, with its status: `driven`, `gap` or `n-a`. |
| `requirements-2026-07-28.json` | The 733 normative sentences of the 2026-07-28 specification (id, party, level, text, source), converted from `docs/spec/requirements.zon` of zig-sdk v0.5.2 (Apache-2.0; `cgmanifest.json` records it) by `tools/convert-requirements.ts`. Do not edit it by hand. |
| `requirement-tests.json` | Maps every one of those requirements to the tests and conformance scenarios that cover it, with a status and, where needed, a reason. |
| `tools/convert-requirements.ts` | Converts zig-sdk's `requirements.zon` to `requirements-<revision>.json`: `node test/mcp-conformance/tools/convert-requirements.ts [--zig-sdk <checkout>] [--commit <rev>]` reads the file from the checkout's history at the commit (default `HEAD`; the checkout defaults to `ZIG_SDK_DIR`, else `zig-sdk` next to the repository). |
| `gateway-threats.md` | The threat model of the MCP gateway: each item of the zig-sdk threat model that applies to it, with the tests that cover it. |
| `docs/` | The documentation: the rendered conformance matrix (`docs/mcp-conformance-matrix.md`), the release notes and a draft for the vscode-docs MCP page. See [docs/README.md](docs/README.md). |

## Running

From the repository root:

```sh
npm run transpile-client                                     # the client and the fixture run from out/
npm ci --prefix test/mcp-conformance --no-audit --no-fund
node test/mcp-conformance/run.ts client                      # the scored client scenarios of both revisions
node test/mcp-conformance/run.ts client --unscored           # the not-scored client scenarios, one by one
node test/mcp-conformance/run.ts all                         # both legs, scored and not scored (what CI runs)
node test/mcp-conformance/run.ts check-matrix                # the matrix, the requirement mapping and the rendered matrix
node test/mcp-conformance/run.ts render-matrix               # rewrite docs/mcp-conformance-matrix.md
node --test test/mcp-conformance/run.test.ts                 # the harness's own tests
```

`npm run test-mcp-conformance` (or `scripts/test-mcp-conformance.sh` / `.bat`) runs `all` and then `check-matrix`; given a subcommand (`client`, `server`, `all`, `check-matrix`, `render-matrix`) it runs that one, and its `--help` is `run.ts`'s (`run.test.ts` checks both). The results go to `.build/conformance-results/<leg>/<revision>/…`: each invocation's own folder with the suite's `checks.json`, `stdout.txt` and `stderr.txt` per scenario, and `summary.json` with the verdict of every invocation.

| Option | Meaning |
| --- | --- |
| `--requirements <rev>[,<rev>]` | The revisions to run. The default is both. |
| `--unscored` | Run the not-scored scenarios of the selected revisions instead of the scored sets. `all` runs both. |
| `--scenario <name>` | Run one scenario of the leg: at `--spec-version`, or at every selected revision that lists it. |
| `--spec-version <rev>` | The revision of `--scenario`. |
| `--server-url <url>` | Run the server leg against this server instead of starting the gateway fixture. It turns the server leg on. |
| `--skip-server[=true\|false]`, `--no-skip-server` | Skip the server leg. The default is `false`: `server` and `all` start the gateway fixture (unless `--server-url` is given), wait up to 30 seconds for its `READY:<url>` line and stop it after the leg. |
| `--out <dir>` | The results folder. The default is `.build/conformance-results`. |
| `--timeout <ms>` | The per-scenario timeout the suite gets. The default is `60000`. The suite's `server` command has no `--timeout`, so only the client leg gets it. |
| `--update-baseline` | Rewrite the expected-failures files from what the run observed, and report the entries it adds and removes. It is refused when `CI` is set. |

## How the suite is invoked

- A scored run is `--requirements <rev> --expected-failures expected-failures-<leg>-<rev>.yml`. The suite runs every scenario of the set in parallel, the not-scored ones too, and judges the scored ones against the baseline.
- A single scenario is `--scenario <s> --spec-version <rev> --expected-failures <file>`. The suite rejects `--requirements` together with `--scenario`, so the two forms never mix. A scenario the revision does not score also gets `--force` and the not-scored baseline.
- The not-scored loop is one such invocation per `not_scored` scenario of each revision, with `--force --expected-failures expected-failures-unscored.yml`.
- Timing scenarios (`sse-retry`) also run alone after the parallel run of their revision. A scored run that fails only on a timing scenario passes when that scenario passes alone.
- The client command is `node <root>/out/vs/workbench/api/node/mcpConformanceClientMain.js` (on Windows `node --no-wasm-dynamic-tiering <root>/…`, see below). The suite splits the command on spaces, so when the repository path has whitespace the harness passes the path relative to the root, which is the suite's working directory.
- On Windows a Node process that used the built-in `fetch` can abort in libuv while it exits (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, file `src\win\async.c`; exit code 127 from a shell, `0xC0000409` otherwise), after its work completed. `fetch` (undici) parses HTTP with a WebAssembly module, and V8 keeps tiering its functions up on background threads for a moment after the last response; an exit in that moment hits the abort (Node 24.13.1). No handle is left open: a 20-line script that fetches from a local server and exits reproduces it in every run, and `--no-wasm-dynamic-tiering` (or `--liftoff-only`) prevents it. So on Windows the harness starts the suite, the client command and the gateway fixture with `--no-wasm-dynamic-tiering` (`nodeProcessFlags` in `run.ts`; Node refuses the flag in `NODE_OPTIONS`, so it goes on each command line), and `npm run test-node` starts the unit-test process with it on every platform (`package.json`), which covers every suite that uses `fetch` when it runs in Node; `mcpConformanceClient.test.ts` checks that a process started with the unit-test process's flags exits cleanly after using `fetch`. The Electron unit-test runner (`scripts/test.sh`, `scripts\test.bat`) loads the same suites in a renderer that is started without the flag and needs none: its `fetch` is Chromium's, not undici, and the runner's exit code is the main process's `app.exit(runner.didFail ? 1 : 0)` once the renderer reported the end of the run, while a renderer that goes away after that is ignored (`test/unit/electron/index.js`), so how the renderer ends cannot fail a run that passed. Under Electron the test skips its check of the process's own flags and starts the child as Electron run as Node (`ELECTRON_RUN_AS_NODE`) with the flag. This is the same assertion as the abort of the suite's own process after a passing verdict that earlier Windows runs showed, and the suite uses `fetch` for every request of the server leg, so it is very likely the same cause; it did not occur in 16 runs here (the client and the server leg of 2026-07-28, 4 runs each with and 4 without the flag), so that part is not confirmed by a reproduction. The harness still counts an invocation whose verdict before such an abort is `Baseline check passed` as passed and says so in the summary.
- With a baseline the suite judges a run by its checks alone, so a client that crashes after its checks are recorded would pass. The harness also fails an invocation when a client of a scenario it judges times out, or exits non-zero although the scenario does not set `allowClientError` in the suite (the scenarios in which the client must refuse the server and exit with an error, such as `auth/scope-retry-limit`, `auth/resource-mismatch` and `http-invalid-tool-headers`; read from the suite's bundle). A scenario its baseline lists as a whole is exempt. The suite reports such a client on its stderr (`Client exited with code <n>`, then the client's output; `Client timed out after <ms>ms`) and saves the client's output as the scenario's `stdout.txt` and `stderr.txt`, so the harness matches each report to its scenario by the output it quotes; a report it cannot match fails the invocation unless the invocation runs one scenario only. This is the client's exit, not the libuv abort of the suite's own process above.
- The suite spawns the client through a shell, and on a timeout it kills only the shell, which on Windows leaves the client running. Every client records its PID in the folder named by `VSCODE_MCP_CONFORMANCE_PID_DIR` while it runs, and after each invocation the harness kills the PIDs that are still running (`taskkill /pid <pid> /T /F` on Windows).

## Baselines

The suite fails a run on WARNING checks only when an expected-failures file is supplied, so the harness always supplies one, also when it is empty: SHOULD-level checks count. An entry is `<scenario>` (the whole scenario may fail) or `<scenario>:<check-id>` (only that check may fail; it addresses every occurrence of the id). A failing check that is not listed fails the run, and so does a listed check that passes: when a fix lands, remove its entries, or run with `--update-baseline` and commit the result. The update keeps the comments of the file, keeps a whole-scenario entry while the scenario still fails, and otherwise writes one entry per failing check.

## The requirement matrix

`requirement-matrix.md` has one row per scenario that the suite's `requirements/2026-07-28.yaml` and `requirements/2025-11-25.yaml` name, for both legs: `driven` (a fixture of this repository runs it and every check passes), `gap` (it runs, and its failing checks are baselined) or `n-a` (not run). `check-matrix` fails when a scenario has no row or two, when the scoring column does not match the set, when a `gap` row has no entry in its expected-failures file, when a `driven` row has entries in its expected-failures file, when a not-scored scenario is neither driven nor baselined, and when a baseline entry names a scenario its file does not cover.

## The requirement mapping

`requirement-tests.json` maps every requirement of `requirements-2026-07-28.json` to what covers it:

```jsonc
{
	"id": "basic/patterns/mrtr#025-0387ee",
	"status": "tested",          // tested | partial | deviation | gap | n-a
	"tests": [{ "file": "src/vs/workbench/contrib/mcp/test/common/mcpServerRequestHandler.test.ts", "test": "a form elicitation is answered and the call is retried with the responses and the state" }],
	"scenarios": [{ "leg": "client", "revision": "2026-07-28", "scenario": "sep-2322-client-request-state" }],
	"reason": "…",               // required for partial, deviation, gap and n-a
	"note": "…"                  // optional
}
```

`tested` cites tests or scenarios that cover the requirement; `partial` cites tests that cover a part of it, and the reason names the rest; `deviation` is a deliberate deviation, explained by the reason and pinned by the cited tests; `gap` has no automated test (never allowed for a MUST or MUST NOT); `n-a` does not apply to VS Code. A scenario may name one of its checks (`"check"`).

`check-matrix` fails when a requirement has no mapping (whatever its level), when a MUST or MUST NOT is a `gap`, when a mapping names an id that is not a requirement, when an id is mapped twice, when a cited test is not declared (as the first argument of a `test(...)` or `it(...)` call) by the cited file or does not run there (`test.skip`, `test.todo`, a test inside `suite.skip(...)`, or `.only` on the test or its suite; a skip decided at run time, such as `this.skip()`, `{ skip: condition }` or a suite chosen by an expression, counts as running), when a cited scenario is not in the requirement set of its leg and revision or its row is not `driven`, when a cited check id is not defined by the suite, and when a status that needs a reason or a citation has none. A template-literal name (`` test(`… ${x} …`) ``) is cited as written, placeholders included, and stands for every test it generates. It also checks that the suite still defines the two authorization-server scenarios (`authorization` command) that the matrix marks n/a, that `requirements-2026-07-28.json` is what `tools/convert-requirements.ts` produces from zig-sdk at the commit its `source` names (when a zig-sdk checkout is available: `ZIG_SDK_DIR`, else `zig-sdk` next to the repository; otherwise it prints a notice and skips this check), that every threat of `gateway-threats.md` cites tests that run or driven scenarios, and that the tests of the matrix's `grpc_server.zig` parity table run.

`docs/mcp-conformance-matrix.md` is rendered from these files by `run.ts render-matrix`; `check-matrix` fails when it is not current, so a change to a requirement, a mapping, a matrix row or a cited test name needs a `render-matrix` run.

CI runs all of this in `.github/workflows/mcp-conformance.yml`, on Linux and Windows, when a pull request changes the MCP sources (the `mcp` rule of `.github/actions/detect-changes/detect.ts`; a push to `main` uses the same list as the workflow's `paths`). `run.test.ts` checks that the two lists agree and that they cover the MCP sources outside the MCP folders: the extension host's `mcp*`, `extHostMcp*` and `mainThreadMcp*` files, the script of `npm run mcp:check-schema`, the SSE parser and every file that only MCP code imports.
