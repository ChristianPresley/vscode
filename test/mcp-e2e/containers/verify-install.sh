#!/usr/bin/env bash
# verify-install.sh - runs INSIDE a fresh vscode-mcp-build:2 container (see install-vscode.ps1).
#
# Installs /out/<newest>.deb with apt, checks `<applicationName> --version`, lists extensions
# headless, then launches the full workbench under xvfb with the smoke test of the E2E extension
# (extension/src/suite/smoke.ts), which records what the running product reports and lets VS Code
# exit 0. Writes /out/install-info.json. With LLAMA_URL set it also checks llama.cpp from this
# container, and when the zig-sdk server exists in the work volume it answers server/discover here.
set -euo pipefail

RUN_ID="${E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
LOGS=/out/logs
LOG="$LOGS/verify-install-$RUN_ID.log"
mkdir -p "$LOGS"
exec > >(tee -a "$LOG") 2>&1
# shellcheck source=e2e-lib.sh
. "$(dirname "$0")/e2e-lib.sh"
T0=$(date +%s)

t=$(date +%s)
install_deb
T_INSTALL=$(( $(date +%s) - t ))
dpkg -s "$APP" | sed -n '1,12p'

FLAGS=(--no-sandbox --disable-gpu --password-store=basic --user-data-dir /tmp/u --extensions-dir /tmp/e)

e2e_log "$APP --version"
"$APP" "${FLAGS[@]}" --version

e2e_log "xvfb-run $APP --list-extensions --show-versions"
xvfb-run -a "$APP" "${FLAGS[@]}" --list-extensions --show-versions | tail -5

build_extension

e2e_log "xvfb-run $APP --wait --verbose --extensionTestsPath (full workbench start)"
rm -f /tmp/e2e-smoke-result.json
t=$(date +%s)
set +e
MCP_E2E_SMOKE_RESULT=/tmp/e2e-smoke-result.json timeout 300 xvfb-run -a -s '-screen 0 1280x1024x24' "$APP" "${FLAGS[@]}" --wait --verbose \
	--disable-workspace-trust --skip-welcome --skip-release-notes \
	--extensionDevelopmentPath="$EXT" --extensionTestsPath="$EXT/out/suite/smoke.js" /tmp > /tmp/launch.log 2>&1
LAUNCH_RC=$?
set -e
T_LAUNCH=$(( $(date +%s) - t ))
grep -vE 'Gtk-WARNING|dbus|libva|Fontconfig' /tmp/launch.log | tail -40
cp /tmp/launch.log "$LOGS/verify-install-launch-$RUN_ID.log"
e2e_log "launch exited with $LAUNCH_RC after ${T_LAUNCH}s"
test -s /tmp/e2e-smoke-result.json

node "$E2E/runner/install-info.ts" --product "$PRODUCT_JSON" --deb "$DEB" --app "$APP" --smoke /tmp/e2e-smoke-result.json \
	--launch-exit "$LAUNCH_RC" --apt-seconds "$T_INSTALL" --launch-seconds "$T_LAUNCH" --total-seconds "$(( $(date +%s) - T0 ))" > /out/install-info.json
cat /out/install-info.json
[ "$LAUNCH_RC" -eq 0 ] || { echo "workbench launch failed ($LAUNCH_RC)"; exit 1; }

# Optional: the peers of the end-to-end tests, seen from this (VS Code) container.
if [ -n "${LLAMA_URL:-}" ]; then
	e2e_log "llama.cpp from the VS Code container: $LLAMA_URL"
	bash "$E2E_SRC/containers/check-llama.sh" "$LLAMA_URL" vscode-container
fi
if [ -x "$ZIG_SERVER" ]; then
	e2e_log "zig-sdk conformance server inside the VS Code container"
	"$ZIG_SERVER" --port 3000 --grpc-port 50051 --grpc-typed > /tmp/zig-server.log 2>&1 &
	ZPID=$!
	for _ in $(seq 1 50); do curl -s --max-time 2 -o /dev/null -X POST http://127.0.0.1:3000/mcp && break; sleep 0.2; done
	curl -sS -X POST http://127.0.0.1:3000/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
		-H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: server/discover' \
		--data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' \
		| jq -ce '{supportedVersions: .result.supportedVersions, serverInfo: .result._meta["io.modelcontextprotocol/serverInfo"]}'
	kill $ZPID 2>/dev/null || true
fi
e2e_log "install verified in $(( $(date +%s) - T0 ))s"
