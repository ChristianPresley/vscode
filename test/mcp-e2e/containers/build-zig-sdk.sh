#!/usr/bin/env bash
# build-zig-sdk.sh [branch] - runs INSIDE the vscode-mcp-build:2 container (see build-zig-sdk.ps1).
# Clones zig-sdk from the read-only mount /src/zig-sdk into the volume (/work/zig-sdk), builds the
# conformance server and the examples (ReleaseSafe), then starts
#   mcp-conformance-server --port 3000 --grpc-port 50051 --grpc-typed
# and checks a 2026-07-28 `server/discover` over HTTP POST /mcp (and over gRPC with curl).
set -euo pipefail
BRANCH="${1:-main}"
SRC=/src/zig-sdk
REPO=/work/zig-sdk
LOGS=/out/logs
RUN_ID="${E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$LOGS" /work/home
exec > >(tee -a "$LOGS/build-zig-sdk-$RUN_ID.log") 2>&1
export HOME=/work/home   # zig's global cache (~/.cache/zig) persists in the volume
log() { printf '\n[%s] === %s\n' "$(date -u +%H:%M:%S)" "$*"; }
T0=$(date +%s)

git config --global --get-all safe.directory | grep -qx "$SRC" || git config --global --add safe.directory "$SRC"
git config --global --get-all safe.directory | grep -qx "$SRC/.git" || git config --global --add safe.directory "$SRC/.git"
t=$(date +%s)
if [ ! -d "$REPO/.git" ]; then
	git clone --branch "$BRANCH" "$SRC" "$REPO"
else
	git -C "$REPO" remote set-url origin "$SRC"
	git -C "$REPO" fetch --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
	git -C "$REPO" checkout -f -B "$BRANCH" "origin/$BRANCH"
	git -C "$REPO" clean -fd
fi
cd "$REPO"
COMMIT=$(git rev-parse HEAD)
T_CLONE=$(( $(date +%s) - t ))
log "zig-sdk $BRANCH @ $COMMIT ($(git log -1 --format=%s)); zig $(zig version)"

t=$(date +%s)
zig build conformance-server examples -Doptimize=ReleaseSafe --summary all 2>&1 | tail -30
T_BUILD=$(( $(date +%s) - t ))
ls -la zig-out/bin
log "built in ${T_BUILD}s"

log "starting mcp-conformance-server --port 3000 --grpc-port 50051 --grpc-typed"
./zig-out/bin/mcp-conformance-server --port 3000 --grpc-port 50051 --grpc-typed > /tmp/server.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; echo "--- server log"; cat /tmp/server.log' EXIT
for i in $(seq 1 50); do
	curl -s --max-time 2 -o /dev/null -X POST http://127.0.0.1:3000/mcp && break
	sleep 0.2
done

BODY='{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
log "HTTP POST /mcp server/discover"
curl -sS -D /tmp/discover.headers -o /tmp/discover.body -w 'http %{http_code} %{content_type}\n' -X POST http://127.0.0.1:3000/mcp \
	-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
	-H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: server/discover' \
	--data "$BODY" | tee /tmp/discover.status
cat /tmp/discover.headers
# The answer is JSON or a single SSE event; take the JSON-RPC payload either way.
RESULT=$(sed -n 's/^data: //p' /tmp/discover.body); [ -n "$RESULT" ] || RESULT=$(cat /tmp/discover.body)
echo "$RESULT" | tee "$LOGS/zig-discover-http.json" | jq -c '{supportedVersions: .result.supportedVersions, serverInfo: .result._meta["io.modelcontextprotocol/serverInfo"], capabilities: (.result.capabilities | keys)}'
echo "$RESULT" | jq -e '.result.supportedVersions | index("2026-07-28")' > /dev/null
grep -q '^http 200' /tmp/discover.status

log "gRPC Call server/discover (HTTP/2 prior knowledge) on :50051"
len=${#BODY}
printf '\x0a' > /tmp/message.bin
printf "$(printf '\\x%02x' $((len & 0x7f | 0x80)) $((len >> 7)))" >> /tmp/message.bin
printf '%s' "$BODY" >> /tmp/message.bin
total=$(stat -c %s /tmp/message.bin)
{ printf '\x00'; printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' $((total >> 24 & 255)) $((total >> 16 & 255)) $((total >> 8 & 255)) $((total & 255)))"; cat /tmp/message.bin; } > /tmp/call.bin
GRPC_STATUS=$(curl -s --http2-prior-knowledge -o /tmp/grpc-response.bin -w '%{http_code} %{content_type}' \
	-H 'content-type: application/grpc+proto' -H 'te: trailers' \
	-H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: server/discover' \
	--data-binary @/tmp/call.bin http://127.0.0.1:50051/mcp.zig.transport.v1.Mcp/Call)
echo "grpc: $GRPC_STATUS"
[ "$GRPC_STATUS" = "200 application/grpc+proto" ]
grep -q '"supportedVersions"' /tmp/grpc-response.bin

cat > /out/zig-sdk-info.json <<EOF
{ "branch": "$BRANCH", "commit": "$COMMIT", "zig": "$(zig version)",
	"binaries": "/work/zig-sdk/zig-out/bin (volume vscode-e2e-work)",
	"httpDiscover": "$(cat /tmp/discover.status)", "grpcDiscover": "$GRPC_STATUS",
	"seconds": { "clone": $T_CLONE, "build": $T_BUILD, "total": $(( $(date +%s) - T0 )) } }
EOF
cat /out/zig-sdk-info.json
log "zig-sdk OK in $(( $(date +%s) - T0 ))s"
