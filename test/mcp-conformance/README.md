# MCP conformance

Runs the official MCP conformance suite, [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance) (pinned to `0.2.0-alpha.11`), against VS Code. It is a self-contained npm package (not part of `build/npm/dirs.ts`, so the root `npm ci` does not install it). Everything is TypeScript run with Node's type stripping; there is no build step.

The suite has two legs, and both are measured at each specification revision the suite has a requirement set for, `2026-07-28` (stateless, per-request `_meta`) and `2025-11-25` (the stateful `initialize` handshake):

- **Client leg.** The suite starts a scenario server and spawns the client as `<command> <server-url>`, with the scenario in `MCP_CONFORMANCE_SCENARIO`, its data in `MCP_CONFORMANCE_CONTEXT` and the revision in `MCP_CONFORMANCE_PROTOCOL_VERSION`. The client is `out/vs/workbench/api/node/mcpConformanceClientMain.js`: it drives VS Code's real client code, the workbench protocol engine (`McpServerRequestHandler`) over the extension-host Streamable HTTP transport (`McpHTTPHandle`), writes nothing to stdout and exits 0 when the scenario ran. The scenario drivers are in `src/vs/workbench/api/node/mcpConformanceScenarios.ts`.
- **Server leg.** The suite connects to an MCP server. The server is the MCP gateway fixture `out/vs/platform/mcp/node/mcpGatewayConformanceMain.js` (milestone M6), which prints `READY:<url>` when it listens. Until it lands, `run.ts` skips the server leg by default.

## What is here

| File | Purpose |
| --- | --- |
| `run.ts` | The harness: runs the suite for each leg and revision, judges the results against the baselines, kills leftover clients and checks the requirement matrix. |
| `run.test.ts` | Tests of the harness with the suite stubbed out (`node --test run.test.ts`). |
| `expected-failures-client-<revision>.yml` | The known failing checks of the scored client scenarios of a revision. Today these are the authorization scenarios, because the client has no OAuth support yet (milestone M5 empties both lists). |
| `expected-failures-server-<revision>.yml` | The same for the server leg. Both lists are empty. |
| `expected-failures-unscored.yml` | The known failures of the scenarios the requirement sets run without scoring (`not_scored`): the six authorization-extension client scenarios, as whole scenarios. A commented section takes the failing `tasks-*` checks of the server leg. |
| `requirement-matrix.md` | One row per scenario of both requirement sets, legs and revisions, with its status: `driven`, `gap` or `n-a`. |
| `requirements-2026-07-28.json` | A skeleton of the normative sentences of the 2026-07-28 specification, with the ids of the zig-sdk extraction. |
| `requirement-tests.json` | Maps those requirements to the tests and conformance scenarios that cover them. |

## Running

From the repository root:

```sh
npm run transpile-client                                     # the client and the fixture run from out/
npm ci --prefix test/mcp-conformance --no-audit --no-fund
node test/mcp-conformance/run.ts client                      # the scored client scenarios of both revisions
node test/mcp-conformance/run.ts client --unscored           # the not-scored client scenarios, one by one
node test/mcp-conformance/run.ts all                         # both legs, scored and not scored (what CI runs)
node test/mcp-conformance/run.ts check-matrix                # the matrix and the requirement mapping
node --test test/mcp-conformance/run.test.ts                 # the harness's own tests
```

`npm run test-mcp-conformance` (or `scripts/test-mcp-conformance.sh` / `.bat`) runs `all`. The results go to `.build/conformance-results/<leg>/<revision>/…`: each invocation's own folder with the suite's `checks.json`, `stdout.txt` and `stderr.txt` per scenario, and `summary.json` with the verdict of every invocation.

| Option | Meaning |
| --- | --- |
| `--requirements <rev>[,<rev>]` | The revisions to run. The default is both. |
| `--unscored` | Run the not-scored scenarios of the selected revisions instead of the scored sets. `all` runs both. |
| `--scenario <name>` | Run one scenario of the leg: at `--spec-version`, or at every selected revision that lists it. |
| `--spec-version <rev>` | The revision of `--scenario`. |
| `--server-url <url>` | Run the server leg against this server instead of starting the gateway fixture. It turns the server leg on. |
| `--skip-server[=true\|false]`, `--no-skip-server` | Skip the server leg. The default is `true` unless `--server-url` is given. `server` and `all` start the gateway fixture, wait up to 30 seconds for its `READY:<url>` line and stop it after the leg. |
| `--out <dir>` | The results folder. The default is `.build/conformance-results`. |
| `--timeout <ms>` | The per-scenario timeout the suite gets. The default is `60000`. The suite's `server` command has no `--timeout`, so only the client leg gets it. |
| `--update-baseline` | Rewrite the expected-failures files from what the run observed, and report the entries it adds and removes. It is refused when `CI` is set. |

## How the suite is invoked

- A scored run is `--requirements <rev> --expected-failures expected-failures-<leg>-<rev>.yml`. The suite runs every scenario of the set in parallel, the not-scored ones too, and judges the scored ones against the baseline.
- A single scenario is `--scenario <s> --spec-version <rev> --expected-failures <file>`. The suite rejects `--requirements` together with `--scenario`, so the two forms never mix. A scenario the revision does not score also gets `--force` and the not-scored baseline.
- The not-scored loop is one such invocation per `not_scored` scenario of each revision, with `--force --expected-failures expected-failures-unscored.yml`.
- Timing scenarios (`sse-retry`) also run alone after the parallel run of their revision. A scored run that fails only on a timing scenario passes when that scenario passes alone.
- The client command is `node <root>/out/vs/workbench/api/node/mcpConformanceClientMain.js`. The suite splits the command on spaces, so when the repository path has whitespace the harness passes the path relative to the root, which is the suite's working directory.
- On Windows the suite's own process sometimes aborts in libuv while it exits (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit code `0xC0000409`), after it printed its verdict. When the verdict before the abort is `Baseline check passed`, the harness counts the invocation as passed and says so in the summary.
- The suite spawns the client through a shell, and on a timeout it kills only the shell, which on Windows leaves the client running. Every client records its PID in the folder named by `VSCODE_MCP_CONFORMANCE_PID_DIR` while it runs, and after each invocation the harness kills the PIDs that are still running (`taskkill /pid <pid> /T /F` on Windows).

## Baselines

The suite fails a run on WARNING checks only when an expected-failures file is supplied, so the harness always supplies one, also when it is empty: SHOULD-level checks count. An entry is `<scenario>` (the whole scenario may fail) or `<scenario>:<check-id>` (only that check may fail; it addresses every occurrence of the id). A failing check that is not listed fails the run, and so does a listed check that passes: when a fix lands, remove its entries, or run with `--update-baseline` and commit the result. The update keeps the comments of the file, keeps a whole-scenario entry while the scenario still fails, and otherwise writes one entry per failing check.

## The requirement matrix

`requirement-matrix.md` has one row per scenario that the suite's `requirements/2026-07-28.yaml` and `requirements/2025-11-25.yaml` name, for both legs: `driven` (a fixture of this repository runs it and every check passes), `gap` (it runs, and its failing checks are baselined) or `n-a` (not run). `check-matrix` fails when a scenario has no row or two, when the scoring column does not match the set, when a `gap` row has no entry in its expected-failures file, when a not-scored scenario is neither driven nor baselined, when a baseline entry names a scenario its file does not cover, and when `requirement-tests.json` cites a file that does not exist, cites a conformance scenario no driven row covers, or leaves a `gap` or `n-a` mapping without a reason.

CI runs all of this in `.github/workflows/mcp-conformance.yml`, on Linux and Windows, when a pull request changes the MCP sources (the `mcp` rule of `.github/actions/detect-changes/detect.ts`).
