#!/usr/bin/env bash
# run-suite.sh - runs INSIDE a fresh vscode-mcp-build:2 container on vscode-e2e-net (see
# test/mcp-e2e/run-e2e.ps1). Installs the .deb, prepares the tools and the E2E extension, writes
# the profile, starts the MCP servers, runs the API suite (extension tests), the UI suite
# (Playwright) and the enterprise policy phase (ui/policy.ts: Playwright with /etc/vscode/policy.json,
# last, so that nothing else sees the policy), and copies results, logs and screenshots out.
#
# Mounts: /src/e2e (test/mcp-e2e, ro), /out (.build/e2e), /vv (.build/visual-verification), /work.
# Environment:
#   E2E_RUN_ID          name of the results folder /out/runs/<id> (default: UTC timestamp)
#   LLAMA_URL           llama.cpp base URL (default http://llama-e2e:8080)
#   MCP_E2E_ALLOW_FAIL  comma-separated test groups whose failures do not fail the run (e.g. grpc)
#   MCP_E2E_ONLY        comma-separated substrings: only run the tests whose name contains one; the
#                       entry "policy" selects the policy phase, and "policy" alone runs only that phase
#   MCP_E2E_MUTATIONS   comma-separated mutations of runner/mutations.ts (each must fail its test)
#   E2E_DEB             the .deb to install (run-e2e.ps1 -Deb; default: the newest of /out)
#   E2E_SKIP_API=1 / E2E_SKIP_UI=1   skip a suite (E2E_SKIP_UI also skips the policy phase)
#   E2E_SKIP_POLICY=1   skip the policy phase
# Sets MCP_E2E_EXPECT_GATEWAY_GRPC from the installed commit (runner/provenance.ts): a test that
# is expected on this build fails instead of skipping.
set -uo pipefail

RUN_ID="${E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="/out/runs/$RUN_ID"
WORK=/tmp/e2e
RESULTS="$WORK/results"
mkdir -p "$RUN_DIR" "$RESULTS"
exec > >(tee -a "$RUN_DIR/run-suite.log") 2>&1

# shellcheck source=e2e-lib.sh
. "$(dirname "$0")/e2e-lib.sh"

export MCP_E2E_LLAMA_URL="${LLAMA_URL:-http://llama-e2e:8080}"
export MCP_E2E_ALLOW_FAIL="${MCP_E2E_ALLOW_FAIL:-}"
export MCP_E2E_ONLY="${MCP_E2E_ONLY:-}"
export MCP_E2E_MUTATIONS="${MCP_E2E_MUTATIONS:-}"
# Both suites: the folder the window opens (the roots test compares it with the root VS Code sends)
# and the logs of the network servers (the wire logs of runner/grpc-log-proxy.ts).
export MCP_E2E_WORKSPACE="$WORK/workspace"
export MCP_E2E_SERVER_LOGS="$RESULTS/servers"
# The throw-away CA of the grpcs:// servers (runner/test-ca.ts; its keys never leave the container)
# and the stand-in web browser of the OAuth sign-in (workbench.externalBrowser -> runner/oauth-browser.ts).
TLS_DIR="$WORK/tls"
# The extension reads the CA of its TLS API definition (McpGrpcServerDefinition with tls.ca) here.
export MCP_E2E_TLS_DIR="$TLS_DIR"
E2E_BROWSER="$WORK/bin/mcp-e2e-browser"
T0=$(date +%s)
API_RC=0
UI_RC=0
POLICY_RC=0
# The only policy file VS Code reads on Linux (LINUX_SYSTEM_POLICY_FILE_PATH); ui/policy.ts writes it.
POLICY_FILE=/etc/vscode/policy.json

fail() { echo "FATAL: $*"; collect; exit 2; }

collect() {
	e2e_log "collecting results into $RUN_DIR"
	node "$E2E_SRC/runner/start-servers.ts" stop "$RESULTS/servers" > /dev/null 2>&1 || true
	cp -r "$RESULTS"/. "$RUN_DIR/" 2>/dev/null || true
	for suite in api ui policy; do
		if [ -d "$WORK/user-data-$suite/logs" ]; then
			mkdir -p "$RUN_DIR/logs-$suite"
			cp -r "$WORK/user-data-$suite/logs"/. "$RUN_DIR/logs-$suite/"
		fi
	done
	cp "$WORK/user-data-api/User/mcp.json" "$WORK/user-data-api/User/settings.json" "$RUN_DIR/" 2>/dev/null || true
	# /vv keeps the screenshots of the latest run; every run keeps its own copy.
	if ls /vv/*.png > /dev/null 2>&1; then
		mkdir -p "$RUN_DIR/screenshots"
		cp /vv/*.png "$RUN_DIR/screenshots/"
	fi
}

e2e_log "run-suite.sh run=$RUN_ID llama=$MCP_E2E_LLAMA_URL allow-fail=${MCP_E2E_ALLOW_FAIL:-none} mutations=${MCP_E2E_MUTATIONS:-none}"

# 1. product, tools, extension
install_deb || fail "installing the .deb failed"
prepare_tools || fail "npm ci of the e2e tools failed"
[ -x "$ZIG_SERVER" ] || fail "$ZIG_SERVER is missing - run containers/build-zig-sdk.ps1"
build_extension || fail "compiling the E2E extension failed"

# What this run tests (the summary prints it) and what the installed build is expected to support.
node "$E2E_SRC/runner/provenance.ts" --product "$PRODUCT_JSON" --deb "$DEB" --suite "$E2E_SRC" \
	--build-info "$E2E_OUT/build-info.json" --clone "$E2E_CLONE" > "$RUN_DIR/provenance.json" || fail "runner/provenance.ts failed"
if [ "$(jq -r '.expect.gatewayGrpc' "$RUN_DIR/provenance.json")" = "true" ]; then
	export MCP_E2E_EXPECT_GATEWAY_GRPC=1
else
	export MCP_E2E_EXPECT_GATEWAY_GRPC=0
fi
if [ "$(jq -r '.expect.gatewayRateLimits' "$RUN_DIR/provenance.json")" = "true" ]; then
	export MCP_E2E_EXPECT_GATEWAY_RATE_LIMITS=1
else
	export MCP_E2E_EXPECT_GATEWAY_RATE_LIMITS=0
fi
e2e_log "provenance: commit $(jq -r .commit "$RUN_DIR/provenance.json") ($(jq -r .deb "$RUN_DIR/provenance.json")), suite $(jq -r .suite.sha256 "$RUN_DIR/provenance.json" | cut -c1-16) (committed: $(jq -r '.committedSuite.sha256 // "unknown"' "$RUN_DIR/provenance.json" | cut -c1-16), matches: $(jq -r 'if .suiteMatchesCommit == null then "unknown" else .suiteMatchesCommit end' "$RUN_DIR/provenance.json")), gateway gRPC expected: $MCP_E2E_EXPECT_GATEWAY_GRPC ($(jq -r .expect.gatewayGrpcReason "$RUN_DIR/provenance.json"))"

# 2. llama.cpp must be up before VS Code starts
bash "$E2E_SRC/containers/check-llama.sh" "$MCP_E2E_LLAMA_URL" test-container > "$RESULTS/check-llama.log" 2>&1 || { cat "$RESULTS/check-llama.log"; fail "llama.cpp is not reachable at $MCP_E2E_LLAMA_URL"; }

# 3. profile and workspace (one template, a fresh copy per suite so that neither sees the other's caches)
rm -rf "$WORK/profile" "$WORK/user-data-api" "$WORK/user-data-ui" "$WORK/user-data-policy" "$WORK/extensions" "$WORK/workspace" "$TLS_DIR" "$WORK/bin"
node "$E2E/runner/prepare-profile.ts" "$WORK/profile" --zig "$ZIG_SERVER" --everything "$EVERYTHING_SERVER" --tls-dir "$TLS_DIR" --browser "$E2E_BROWSER" --browser-log "$MCP_E2E_SERVER_LOGS/oauth-browser.jsonl" || fail "prepare-profile failed"
cp -a "$WORK/profile" "$WORK/user-data-api"
cp -a "$WORK/profile" "$WORK/user-data-ui"
mkdir -p "$WORK/extensions" "$WORK/workspace"
printf '# MCP end-to-end workspace\n\nThe single root folder the MCP servers see as their root.\n' > "$WORK/workspace/README.md"
# An empty workspace mcp.json: the UI suite shows its completions (the MCP schema is associated
# with .vscode/mcp.json files). It defines no servers.
mkdir -p "$WORK/workspace/.vscode"
printf '{\n\t"servers": {}\n}\n' > "$WORK/workspace/.vscode/mcp.json"

start_servers() {
	node "$E2E/runner/start-servers.ts" stop "$RESULTS/servers" > /dev/null 2>&1 || true
	node "$E2E/runner/start-servers.ts" start "$RESULTS/servers" --zig "$ZIG_SERVER" --everything "$EVERYTHING_SERVER" --tls-dir "$TLS_DIR"
}

FLAGS=(--no-sandbox --disable-gpu --password-store=basic --extensions-dir "$WORK/extensions" --log debug
	--skip-welcome --skip-release-notes --disable-workspace-trust)

# -Only: the entry "policy" selects the policy phase (no -Only runs it too); "policy" as the only
# entry runs nothing else (no test of the API or UI suite has "policy" in its name).
POLICY_SELECTED=0
POLICY_ALONE=0
only_entries=0
only_policy=1
IFS=',' read -r -a only_list <<< "$MCP_E2E_ONLY"
for entry in "${only_list[@]}"; do
	entry=$(printf '%s' "$entry" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
	[ -n "$entry" ] || continue
	only_entries=$((only_entries + 1))
	if [ "$entry" = policy ]; then
		POLICY_SELECTED=1
	else
		only_policy=0
	fi
done
if [ "$only_entries" = 0 ]; then
	POLICY_SELECTED=1
elif [ "$only_policy" = 1 ]; then
	POLICY_ALONE=1
	e2e_log "-Only policy: only the policy phase runs"
fi
UI_RAN=0

# 4. API suite: the extension tests (the LLM picks every tool)
if [ -z "${E2E_SKIP_API:-}" ] && [ "$POLICY_ALONE" = 0 ]; then
	start_servers || fail "the MCP servers did not start"
	e2e_log "API suite"
	t=$(date +%s)
	MCP_E2E_RESULTS_DIR="$RESULTS/api" timeout 3600 xvfb-run -a -s '-screen 0 1600x1000x24' \
		"$APP" "${FLAGS[@]}" --user-data-dir "$WORK/user-data-api" --wait \
		--extensionDevelopmentPath="$EXT" --extensionTestsPath="$EXT/out/suite/index.js" \
		"$WORK/workspace" > "$RESULTS/api-workbench.log" 2>&1
	API_RC=$?
	# The extension host's console goes to the window's renderer log.
	grep -ah '\[mcp-e2e\] \(PASS\|FAIL\|SKIP\|API suite\)' "$WORK"/user-data-api/logs/*/window1/renderer.log | sed 's/^.*\[mcp-e2e\] /  /' | cut -c1-220 || true
	e2e_log "API suite exited with $API_RC after $(( $(date +%s) - t ))s"
	if [ ! -s "$RESULTS/api/api-results.json" ]; then
		echo "no api-results.json - the end of the workbench log:"
		tail -60 "$RESULTS/api-workbench.log"
		[ "$API_RC" -ne 0 ] || API_RC=1
	fi
fi

# 5. UI suite: Playwright drives the installed binary (screenshots + elicitation answered in the UI)
if [ -z "${E2E_SKIP_UI:-}" ] && [ "$POLICY_ALONE" = 0 ]; then
	start_servers || fail "the MCP servers did not start"
	e2e_log "UI suite"
	t=$(date +%s)
	UI_RAN=1
	mkdir -p /vv
	MCP_E2E_RESULTS_DIR="$RESULTS/ui" MCP_E2E_SCREENSHOTS=/vv MCP_E2E_PLAYWRIGHT="$E2E_TOOLS" \
		MCP_E2E_APP="$APP_DIR/$APP" MCP_E2E_USER_DATA="$WORK/user-data-ui" MCP_E2E_EXTENSIONS="$WORK/extensions" \
		MCP_E2E_EXTENSION="$EXT" MCP_E2E_WORKSPACE="$WORK/workspace" \
		timeout 3600 xvfb-run -a -s '-screen 0 1600x1000x24' node "$E2E/ui/visual.ts" > "$RESULTS/ui-driver.log" 2>&1
	UI_RC=$?
	cat "$RESULTS/ui-driver.log" | grep -vE 'Gtk-WARNING|dbus|libva|Fontconfig' | tail -80
	e2e_log "UI suite exited with $UI_RC after $(( $(date +%s) - t ))s"
fi

# 6. Policy phase: /etc/vscode/policy.json with ChatAllowedMcpServers, VS Code launched once more by
# Playwright with its own user data folder and a mcp.json of three servers (ui/policy.ts). Last, so
# that no other test sees the policy; the driver removes the file again.
if [ -z "${E2E_SKIP_UI:-}" ] && [ -z "${E2E_SKIP_POLICY:-}" ] && [ "$POLICY_SELECTED" = 1 ]; then
	e2e_log "policy phase"
	t=$(date +%s)
	mkdir -p /vv "$RESULTS/policy"
	# /vv keeps the screenshots of the latest run: without the UI suite (which clears it) only this phase's.
	[ "$UI_RAN" = 1 ] || rm -f /vv/*.png
	if [ -e "$POLICY_FILE" ]; then
		# Not this run's: left alone, and the phase does not run (no results: the summary fails the run).
		echo "$POLICY_FILE exists before the policy phase; the phase does not run"
		POLICY_RC=1
	else
		# Before the restart of the network servers: the driver counts their log entries from here on.
		MCP_E2E_PHASE_START="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
		start_servers || fail "the MCP servers did not start"
		rm -rf "$WORK/user-data-policy"
		cp -a "$WORK/profile" "$WORK/user-data-policy"
		# Its own control port: a leftover extension host of the UI window could still hold 47811.
		MCP_E2E_PHASE_START="$MCP_E2E_PHASE_START" MCP_E2E_ONLY='' MCP_E2E_CONTROL_PORT=47812 MCP_E2E_RESULTS_DIR="$RESULTS/policy" MCP_E2E_SCREENSHOTS=/vv MCP_E2E_PLAYWRIGHT="$E2E_TOOLS" \
			MCP_E2E_APP="$APP_DIR/$APP" MCP_E2E_USER_DATA="$WORK/user-data-policy" MCP_E2E_EXTENSIONS="$WORK/extensions" \
			MCP_E2E_EXTENSION="$EXT" MCP_E2E_WORKSPACE="$WORK/workspace" \
			timeout 1200 xvfb-run -a -s '-screen 0 1600x1000x24' node "$E2E/ui/policy.ts" > "$RESULTS/policy-driver.log" 2>&1
		POLICY_RC=$?
		# The driver removes the file; one stopped by the timeout cannot. A file that is still there fails the phase.
		rm -f "$POLICY_FILE"
		if [ -e "$POLICY_FILE" ]; then
			echo "$POLICY_FILE could not be removed after the policy phase"
			POLICY_RC=1
		fi
		grep -vE 'Gtk-WARNING|dbus|libva|Fontconfig' "$RESULTS/policy-driver.log" | tail -40
	fi
	e2e_log "policy phase exited with $POLICY_RC after $(( $(date +%s) - t ))s"
elif [ "$POLICY_ALONE" = 1 ]; then
	# -Only policy with -SkipUi or -SkipPolicy: nothing runs, which must not pass as an empty run.
	e2e_log "-Only policy, but the policy phase is skipped (-SkipUi or -SkipPolicy): nothing runs"
	POLICY_RC=2
fi

collect
node "$E2E/runner/summarize.ts" "$RUN_DIR" --api-exit "$API_RC" --ui-exit "$UI_RC" --policy-exit "$POLICY_RC"
SUMMARY_RC=$?
e2e_log "run $RUN_ID finished in $(( $(date +%s) - T0 ))s with $SUMMARY_RC (results: $RUN_DIR)"
exit $SUMMARY_RC
