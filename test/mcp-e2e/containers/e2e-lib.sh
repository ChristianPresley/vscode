#!/usr/bin/env bash
# e2e-lib.sh - shell functions shared by verify-install.sh and run-suite.sh. Source it inside a
# vscode-mcp-build:2 container that has these mounts:
#   /src/e2e  test/mcp-e2e of the repository (read-only)
#   /out      .build/e2e (the .deb, logs, run results)
#   /work     the vscode-e2e-work volume (the build clone with node_modules, zig-sdk, e2e-tools)

E2E_SRC=${E2E_SRC:-/src/e2e}
E2E_OUT=${E2E_OUT:-/out}
E2E_TOOLS=${E2E_TOOLS:-/work/e2e-tools}
E2E_BUILD=${E2E_BUILD:-/tmp/e2e-build}
E2E_CLONE=${E2E_CLONE:-/work/vscode}
ZIG_SERVER=${ZIG_SERVER:-/work/zig-sdk/zig-out/bin/mcp-conformance-server}
EVERYTHING_SERVER="$E2E_TOOLS/node_modules/@modelcontextprotocol/server-everything/dist/index.js"
# The launcher (resources/linux/bin/code.sh) sees "Microsoft" in /proc/version inside a WSL
# container and asks interactively whether to continue; this variable skips the prompt.
export DONT_PROMPT_WSL_INSTALL=1

e2e_log() { printf '\n[%s] === %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# install_deb: installs $E2E_DEB (run-e2e.ps1 -Deb) or else the newest .deb of /out and sets APP
# (the binary name from product.json), APP_DIR (/usr/share/<app>), PRODUCT_JSON and DEB.
install_deb() {
	local deb
	if [ -n "${E2E_DEB:-}" ]; then
		deb="$E2E_DEB"
		[ -f "$deb" ] || { echo "E2E_DEB=$deb does not exist in the container"; return 1; }
	else
		deb=$(ls -t "$E2E_OUT"/*.deb 2>/dev/null | head -1)
	fi
	[ -n "$deb" ] || { echo "no .deb in $E2E_OUT - run containers/build-vscode.ps1 first"; return 1; }
	e2e_log "installing $(basename "$deb")"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends "$deb" > /tmp/apt-install.log 2>&1 || { tail -40 /tmp/apt-install.log; return 1; }
	PRODUCT_JSON=$(ls /usr/share/*/resources/app/product.json | head -1)
	APP=$(jq -r .applicationName "$PRODUCT_JSON")
	APP_DIR=$(dirname "$(dirname "$(dirname "$PRODUCT_JSON")")")
	DEB="$deb"
	export APP APP_DIR PRODUCT_JSON DEB
	echo "applicationName=$APP dir=$APP_DIR commit=$(jq -r .commit "$PRODUCT_JSON") version=$(jq -r .version "$APP_DIR/resources/app/package.json")"
}

# prepare_tools: npm ci of tools/package-lock.json into /work/e2e-tools (only when the lockfile changed).
prepare_tools() {
	mkdir -p "$E2E_TOOLS"
	local want have
	want=$(cat "$E2E_SRC/tools/package.json" "$E2E_SRC/tools/package-lock.json" | sha256sum | cut -d' ' -f1)
	have=$(cat "$E2E_TOOLS/.e2e-tools.hash" 2>/dev/null || true)
	if [ "$want" = "$have" ] && [ -d "$E2E_TOOLS/node_modules/playwright" ]; then
		echo "e2e-tools up to date ($want)"
		return 0
	fi
	e2e_log "npm ci into $E2E_TOOLS"
	cp "$E2E_SRC/tools/package.json" "$E2E_SRC/tools/package-lock.json" "$E2E_TOOLS/"
	(cd "$E2E_TOOLS" && HOME=/work/home npm_config_cache=/work/home/.npm PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund) || return 1
	echo "$want" > "$E2E_TOOLS/.e2e-tools.hash"
}

# build_extension: compiles the E2E extension against the vscode.d.ts of the build clone (the
# commit the .deb was built from). The sources are copied into a mirror of the repository layout
# (/tmp/e2e-build/{src/vscode-dts,node_modules,test/mcp-e2e}) so that the relative paths of
# extension/tsconfig.json resolve as they do in the repository. Sets E2E (the copy of test/mcp-e2e)
# and EXT (the extension folder).
build_extension() {
	rm -rf "$E2E_BUILD"
	mkdir -p "$E2E_BUILD/src" "$E2E_BUILD/test"
	ln -s "$E2E_CLONE/src/vscode-dts" "$E2E_BUILD/src/vscode-dts"
	ln -s "$E2E_CLONE/node_modules" "$E2E_BUILD/node_modules"
	mkdir -p "$E2E_BUILD/test/mcp-e2e"
	(cd "$E2E_SRC" && tar --exclude=./extension/out --exclude=./node_modules --exclude=./tools/node_modules -cf - .) | (cd "$E2E_BUILD/test/mcp-e2e" && tar -xf -)
	E2E="$E2E_BUILD/test/mcp-e2e"
	EXT="$E2E/extension"
	export E2E EXT
	local clone_commit product_commit
	clone_commit=$(git -C "$E2E_CLONE" rev-parse HEAD 2>/dev/null || echo unknown)
	product_commit=$(jq -r .commit "${PRODUCT_JSON:-/dev/null}" 2>/dev/null || echo unknown)
	if [ -n "${PRODUCT_JSON:-}" ] && [ "$clone_commit" != "$product_commit" ]; then
		echo "WARNING: the build clone is at $clone_commit but the installed product is $product_commit; the extension is typed against the clone"
	fi
	e2e_log "tsc -p $EXT/tsconfig.json (vscode.d.ts of $clone_commit)"
	(cd "$EXT" && node "$E2E_BUILD/node_modules/typescript/bin/tsc6" -p tsconfig.json) || return 1
	ls "$EXT/out"
}
