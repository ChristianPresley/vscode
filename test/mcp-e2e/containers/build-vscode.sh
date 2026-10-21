#!/usr/bin/env bash
# build-vscode.sh - runs INSIDE the vscode-mcp-build:2 container (see build-vscode.ps1).
#
# Clones (or fast-forwards) the VS Code fork from the read-only mount /src/vscode into the
# persistent volume at /work, installs the dependencies, builds the Linux x64 desktop
# product and packages it as a .deb, which is copied to /out (= C:\repos\vscode\.build\e2e).
#
# Usage: build-vscode.sh [branch]
# Environment knobs:
#   VSCODE_BUILD_TARGET   gulp product task (default vscode-linux-x64-min)
#   FORCE_NPM_CI=1        run npm ci even when the lockfiles did not change since the last install
#   SKIP_BUILD=1          only refresh the clone and the dependencies
#   E2E_RUN_ID            name for the log files (default: UTC timestamp)
set -euo pipefail

BRANCH="${1:-${VSCODE_BRANCH:-main}}"
SRC=/src/vscode
WORK=/work
REPO="$WORK/vscode"
OUT=/out
LOGS="$OUT/logs"
STATE="$WORK/state"
TARGET="${VSCODE_BUILD_TARGET:-vscode-linux-x64-min}"
RUN_ID="${E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
LOG="$LOGS/build-vscode-$RUN_ID.log"
TIMINGS="$LOGS/build-vscode-$RUN_ID.timings.tsv"

mkdir -p "$LOGS" "$STATE" "$WORK/home" "$WORK/tmp"
exec > >(tee -a "$LOG") 2>&1

# Keep every cache (npm, node-gyp headers, Electron zips, sysroots, dpkg-shlibdeps) in the volume.
export HOME="$WORK/home"
export TMPDIR="$WORK/tmp"
export npm_config_cache="$WORK/home/.npm"
export NODE_OPTIONS="--max-old-space-size=8192"
export VSCODE_SYSROOT_DIR="$WORK/sysroots/glibc-2.28-gcc-10.5.0"
# Electron must be downloadable for the desktop build; Playwright browsers and the
# optional on-device model runtimes (same switches as the CI build) are not needed.
unset ELECTRON_SKIP_BINARY_DOWNLOAD
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export ONNXRUNTIME_NODE_INSTALL=skip
export FOUNDRY_LOCAL_SKIP_INSTALL=1
export DISABLE_V8_COMPILE_CACHE=1
export NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NPM_CONFIG_UPDATE_NOTIFIER=false

T_START=$(date +%s)
printf 'step\tseconds\tstatus\n' > "$TIMINGS"
log() { printf '\n[%s] === %s\n' "$(date -u +%H:%M:%S)" "$*"; }
record() { printf '%s\t%s\t%s\n' "$1" "$(( $(date +%s) - $2 ))" "$([ "$3" -eq 0 ] && echo ok || echo "fail($3)")" >> "$TIMINGS"; }

# step <name> <command...>: runs and times one step. Under set -e a failing step ends the
# script (the EXIT trap records it); inside an `if` the exit code is returned to the caller.
CUR_STEP=""; CUR_T0=0; FAILED_STEP=""
step() {
	local name="$1"; shift
	CUR_STEP="$name"; CUR_T0=$(date +%s)
	log "$name: $*"
	"$@"
	local rc=$?
	record "$name" "$CUR_T0" "$rc"
	log "$name finished in $(( $(date +%s) - CUR_T0 ))s (exit $rc)"
	[ $rc -eq 0 ] || FAILED_STEP="$name"
	CUR_STEP=""
	return $rc
}
on_exit() {
	local rc=$?
	if [ $rc -ne 0 ]; then
		[ -n "$CUR_STEP" ] && record "$CUR_STEP" "$CUR_T0" "$rc"
		log "FAILED (exit $rc) in step '${CUR_STEP:-${FAILED_STEP:-?}}' after $(( $(date +%s) - T_START ))s - see $LOG"
		cat "$TIMINGS"
	fi
}
trap on_exit EXIT

log "build-vscode.sh branch=$BRANCH target=$TARGET run=$RUN_ID"
log "host: $(nproc) CPUs, $(free -g | awk '/Mem:/{print $2}') GiB RAM, $(free -g | awk '/Swap:/{print $2}') GiB swap"

# ---------------------------------------------------------------------------------------------
# 1. Source: clone from the read-only mount, or fetch + hard checkout when the clone exists.
# ---------------------------------------------------------------------------------------------
sync_source() {
	git config --global --get-all safe.directory | grep -qx "$SRC" || git config --global --add safe.directory "$SRC"
	git config --global --get-all safe.directory | grep -qx "$SRC/.git" || git config --global --add safe.directory "$SRC/.git"
	git config --global advice.detachedHead false
	if [ ! -d "$REPO/.git" ]; then
		git clone --branch "$BRANCH" "$SRC" "$REPO"
	else
		git -C "$REPO" remote set-url origin "$SRC"
		git -C "$REPO" fetch --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
		# Drop the local build patches of the previous run (tracked files only; node_modules,
		# out-* and .build stay - they are git-ignored).
		git -C "$REPO" checkout -f -B "$BRANCH" "origin/$BRANCH"
		git -C "$REPO" reset --hard "origin/$BRANCH"
		git -C "$REPO" clean -fd
	fi
	git -C "$REPO" log -1 --format='commit %H%n%s'
}
step clone sync_source

cd "$REPO"
COMMIT=$(git rev-parse HEAD)

# Local-only build patches (on the clone in the volume, never on the source repository):
#  - The OSS build has no Rust tunnel CLI (bin/code-tunnel-oss is mixed in from a separate CI
#    job), so the .deb dependency calculator must skip files that do not exist.
#  - Native modules are compiled with the Ubuntu 24.04 toolchain rather than the glibc 2.28
#    sysroot toolchain of the official builds, so the computed Depends: line differs from the
#    reference list in build/linux/debian/dep-lists.ts; warn instead of failing.
patch_clone() {
	local f=build/linux/dependencies-generator.ts
	sed -i 's/^const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = true;/const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = false;/' "$f"
	grep -q '^const FAIL_BUILD_FOR_NEW_DEPENDENCIES: boolean = false;' "$f"
	if ! grep -q 'e2e: skip missing files' "$f"; then
		sed -i 's|^\t// Generate the dependencies\.$|\t// e2e: skip missing files (no tunnel CLI in the OSS build)\n\tfor (let i = files.length - 1; i >= 0; i--) { if (spawnSync('"'"'test'"'"', ['"'"'-e'"'"', files[i]]).status !== 0) { console.warn('"'"'[e2e] skipping missing '"'"' + files[i]); files.splice(i, 1); } }\n\t// Generate the dependencies.|' "$f"
	fi
	grep -q 'e2e: skip missing files' "$f"
	git --no-pager diff --stat
}
step patch-clone patch_clone

# ---------------------------------------------------------------------------------------------
# 2. Node.js: use exactly the version in .nvmrc (downloaded once into the volume).
# ---------------------------------------------------------------------------------------------
setup_node() {
	local want; want=$(tr -d ' \r\n' < .nvmrc); want="${want#v}"
	local dir="$WORK/node/v$want"
	if [ "$(node --version 2>/dev/null)" = "v$want" ]; then
		echo "system node already v$want"; return 0
	fi
	if [ ! -x "$dir/bin/node" ]; then
		local base="https://nodejs.org/dist/v$want" file="node-v$want-linux-x64.tar.xz"
		mkdir -p "$WORK/node" && cd "$WORK/node"
		curl -fsSLO --retry 3 "$base/$file"
		curl -fsSL --retry 3 "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -
		rm -rf "$dir" && mkdir -p "$dir" && tar -xJf "$file" -C "$dir" --strip-components=1 && rm -f "$file"
		cd "$REPO"
	fi
}
step node setup_node
NODE_WANT=$(tr -d ' \r\n' < .nvmrc); NODE_WANT="${NODE_WANT#v}"
[ -x "$WORK/node/v$NODE_WANT/bin/node" ] && export PATH="$WORK/node/v$NODE_WANT/bin:$PATH"
log "node $(node --version), npm $(npm --version)"

# ---------------------------------------------------------------------------------------------
# 3. Dependencies: npm ci (skipped when no lockfile/package.json/.npmrc/.nvmrc changed since the
#    last successful install in this volume). One retry on failure (network flakes).
# ---------------------------------------------------------------------------------------------
deps_hash() {
	{ node --version; git ls-files -s -- '*package-lock.json' '*package.json' '*.npmrc' .nvmrc; } | sha256sum | cut -d' ' -f1
}
install_deps() {
	local h; h=$(deps_hash)
	if [ -z "${FORCE_NPM_CI:-}" ] && [ -d node_modules ] && [ "$(cat "$STATE/npm-ci.hash" 2>/dev/null)" = "$h" ]; then
		echo "dependencies unchanged since the last npm ci ($h) - skipping"; return 0
	fi
	rm -f "$STATE/npm-ci.hash"
	if ! npm ci; then
		echo "npm ci failed - retrying once in 30s"
		sleep 30
		npm ci
	fi
	echo "$h" > "$STATE/npm-ci.hash"
}
step npm-ci install_deps

if [ -n "${SKIP_BUILD:-}" ]; then log "SKIP_BUILD set - stopping after the dependencies"; exit 0; fi

retry_once() { "$@" || { echo "retrying once: $*"; sleep 15; "$@"; }; }
step builtin-extensions retry_once npm run download-builtin-extensions

# ---------------------------------------------------------------------------------------------
# 4. Product build. The minified build falls back to the non-minified one on memory trouble.
#
# The built-in Copilot extension: gulp packages extensions/copilot with build/.moduleignore,
# which strips node_modules/@github/copilot/** - the official build replaces
# .build/extensions/copilot with the Copilot VSIX of a separate CI job (downloadCopilotVsix.ts)
# before `vscode-linux-x64-min-ci`. Without it, the packaging step
# prepareBuiltInCopilotRipgrepShim fails with "Copilot SDK directory not found". In that case we
# mix in exactly the @github/copilot files the VSIX would carry (`vsce ls` applies the
# extension's .vscodeignore) and rerun only the packaging task (<target>-ci).
# ---------------------------------------------------------------------------------------------
build_product() {
	local t="$1" plog="$LOGS/gulp-$1-$RUN_ID.log" rc
	set +e; npm run gulp "$t" 2>&1 | tee "$plog"; rc=${PIPESTATUS[0]}; set -e
	return $rc
}
overlay_copilot_sdk() {
	local ext="$REPO/extensions/copilot" dest="$REPO/.build/extensions/copilot" list="$TMPDIR/copilot-vsix-files.txt"
	[ -d "$dest" ] || { echo "no $dest"; return 1; }
	(cd "$ext" && node_modules/.bin/vsce ls) > "$TMPDIR/copilot-vsce-ls.txt" || return 1
	grep '^node_modules/@github/copilot/' "$TMPDIR/copilot-vsce-ls.txt" > "$list" || { echo "vsce ls listed no @github/copilot files"; return 1; }
	echo "mixing $(wc -l < "$list") @github/copilot files of the VSIX file list into $dest:"
	sed 's/^/  /' "$list"
	(cd "$ext" && tar -cf - -T "$list") | (cd "$dest" && tar -xf -) || return 1
	test -d "$dest/node_modules/@github/copilot/sdk"
}
build_with_fixups() {
	local t="$1"
	build_product "$t" && return 0
	if grep -q 'Copilot SDK directory not found' "$LOGS/gulp-$t-$RUN_ID.log"; then
		log "no Copilot VSIX: mixing the @github/copilot SDK into .build/extensions/copilot, then $t-ci"
		overlay_copilot_sdk || return 1
		build_product "$t-ci"
		return $?
	fi
	return 1
}
BUILT_TARGET="$TARGET"
if ! step "gulp $TARGET" build_with_fixups "$TARGET"; then
	if [ "$TARGET" = "vscode-linux-x64-min" ] && cat "$LOGS"/gulp-"$TARGET"*-"$RUN_ID".log | grep -qE 'heap out of memory|JavaScript heap|Killed|SIGKILL|ENOMEM|exit code 137'; then
		log "minified build ran out of memory - falling back to vscode-linux-x64"
		BUILT_TARGET=vscode-linux-x64
		step "gulp $BUILT_TARGET" build_with_fixups "$BUILT_TARGET"
	else
		false
	fi
fi
test -x "$WORK/VSCode-linux-x64/code-oss"

# ---------------------------------------------------------------------------------------------
# 5. Debian package.
# ---------------------------------------------------------------------------------------------
step prepare-deb npm run gulp vscode-linux-x64-prepare-deb
step build-deb npm run gulp vscode-linux-x64-build-deb

copy_deb() {
	local deb; deb=$(ls -t .build/linux/deb/amd64/deb/*.deb | head -1)
	file "$deb"
	file "$deb" | grep -q 'data compression xz'
	rm -f "$OUT"/*.deb
	cp "$deb" "$OUT/"
	DEB_NAME=$(basename "$deb")
	DEB_SIZE=$(stat -c %s "$OUT/$DEB_NAME")
	dpkg-deb --info "$OUT/$DEB_NAME" | sed -n '1,40p'
}
step copy-deb copy_deb

TOTAL=$(( $(date +%s) - T_START ))
cat > "$OUT/build-info.json" <<EOF
{
	"runId": "$RUN_ID",
	"branch": "$BRANCH",
	"commit": "$COMMIT",
	"target": "$BUILT_TARGET",
	"node": "$(node --version)",
	"deb": "$DEB_NAME",
	"debBytes": $DEB_SIZE,
	"totalSeconds": $TOTAL,
	"log": "logs/$(basename "$LOG")",
	"timings": "logs/$(basename "$TIMINGS")"
}
EOF
log "DONE in ${TOTAL}s: /out/$DEB_NAME ($DEB_SIZE bytes)"
cat "$TIMINGS"
