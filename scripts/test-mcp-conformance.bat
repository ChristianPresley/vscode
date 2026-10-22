@echo off
setlocal

pushd %~dp0\..

if /i "%~1"=="--help" goto show_help
if /i "%~1"=="-h" goto show_help

if "%VSCODE_SKIP_MCP_CONFORMANCE%"=="1" (
	echo Skipping the MCP conformance suite because VSCODE_SKIP_MCP_CONFORMANCE is set.
	set EXIT_CODE=0
	goto end
)

set SUBCOMMAND=
if /i "%~1"=="client" set SUBCOMMAND=1
if /i "%~1"=="server" set SUBCOMMAND=1
if /i "%~1"=="all" set SUBCOMMAND=1
if /i "%~1"=="check-matrix" set SUBCOMMAND=1
if /i "%~1"=="render-matrix" set SUBCOMMAND=1

if defined SUBCOMMAND (
	call node .\test\mcp-conformance\run.ts %*
) else (
	call node .\test\mcp-conformance\run.ts all %*
)
set EXIT_CODE=%errorlevel%
if not "%EXIT_CODE%"=="0" goto end

if defined SUBCOMMAND if /i not "%~1"=="all" goto end
call node .\test\mcp-conformance\run.ts check-matrix
set EXIT_CODE=%errorlevel%
goto end

:show_help
echo Usage: %~nx0 [client^|server^|all^|check-matrix^|render-matrix] [options]
echo.
echo Runs the official MCP conformance suite against VS Code's MCP client and the
echo MCP gateway fixture, then checks the requirement matrix. Without a subcommand
echo it runs 'all'. Run 'npm run transpile-client' and
echo 'npm ci --prefix test/mcp-conformance --no-audit --no-fund' first.
echo.
echo   client         run the scored client scenarios of each revision (--unscored: the not-scored loop instead)
echo   server         the same for the server leg, against the gateway fixture (or --server-url)
echo   all            both legs, scored and not scored
echo   check-matrix   check requirement-matrix.md, requirement-tests.json and docs/mcp-conformance-matrix.md against the suite, the baselines and the tests
echo   render-matrix  regenerate docs/mcp-conformance-matrix.md from the requirements, their mapping and requirement-matrix.md
echo.
echo Options:
echo   --requirements ^<rev^>[,^<rev^>]  revisions to run (default: 2026-07-28,2025-11-25)
echo   --unscored                    run the not-scored scenarios one by one (--force) instead of the scored sets
echo   --scenario ^<name^>             run one scenario of the leg (with --spec-version, or at every revision that lists it)
echo   --spec-version ^<rev^>          the revision of --scenario
echo   --server-url ^<url^>            run the server leg against this server instead of starting the gateway fixture
echo   --skip-server[=true^|false]    skip the server leg of server and all (default: false, the leg runs); --no-skip-server
echo   --out ^<dir^>                   results directory (default: .build/conformance-results)
echo   --timeout ^<ms^>                per-scenario timeout passed to the suite (default: 60000)
echo   --update-baseline             rewrite the expected-failures files from the observed results (refused when CI is set)
echo   --help, -h                    show this help
echo.
echo Set VSCODE_SKIP_MCP_CONFORMANCE=1 to skip the suite, for example when no relevant files changed.
echo See test\mcp-conformance\README.md.
set EXIT_CODE=0

:end
popd
endlocal & exit /b %EXIT_CODE%
