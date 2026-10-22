#!/usr/bin/env bash
# run-e2e.sh - the Git Bash entry point of the MCP end-to-end tests (Windows host with WSL
# Containers). It maps the options onto run-e2e.ps1, which drives wslc.exe; see README.md.
#
#   test/mcp-e2e/run-e2e.sh [--branch <b>] [--skip-build] [--skip-api] [--skip-ui]
#                           [--allow-fail <groups>] [--only <substrings>] [--run-id <id>]
#                           [--deb <path>] [--repeat <n>] [--mutate <names>]
#                           [--cpu] [--rebuild-zig] [--keep-llama]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
winpath() {
	if command -v cygpath > /dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
args=()
while [ $# -gt 0 ]; do
	case "$1" in
		--branch) args+=(-Branch "$2"); shift 2 ;;
		--skip-build) args+=(-SkipBuild); shift ;;
		--skip-api) args+=(-SkipApi); shift ;;
		--skip-ui) args+=(-SkipUi); shift ;;
		--allow-fail) args+=(-AllowFail "$2"); shift 2 ;;
		--only) args+=(-Only "$2"); shift 2 ;;
		--run-id) args+=(-RunId "$2"); shift 2 ;;
		--deb) args+=(-Deb "$(winpath "$2")"); shift 2 ;;
		--repeat) args+=(-Repeat "$2"); shift 2 ;;
		--mutate) args+=(-Mutate "$2"); shift 2 ;;
		--cpu) args+=(-Cpu); shift ;;
		--rebuild-zig) args+=(-RebuildZig); shift ;;
		--keep-llama) args+=(-KeepLlamaDuringBuild); shift ;;
		-h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "unknown option $1" >&2; exit 2 ;;
	esac
done

ps1="$(winpath "$here/run-e2e.ps1")"
if command -v pwsh > /dev/null 2>&1; then
	exec pwsh -NoProfile -File "$ps1" "${args[@]}"
fi
echo "PowerShell 7 (pwsh) is required: the drivers call wslc.exe and parse its JSON output" >&2
exit 2
