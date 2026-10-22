<#
.SYNOPSIS
  Builds the VS Code fork as a Linux x64 .deb inside a WSL container (wslc).

.DESCRIPTION
  - builds the images vscode-mcp-build:latest (Dockerfile.base) and vscode-mcp-build:2
    (Dockerfile.builder) when they are missing
  - creates the named volume vscode-e2e-work (mounted at /work: clone, node_modules, caches,
    build output persist between runs)
  - runs build-vscode.sh in a throw-away container with
      <repo>                  -> /src/vscode (read-only; the clone source: committed branches only)
      <repo>\test\mcp-e2e     -> /src/e2e    (read-only; the scripts)
      <repo>\.build\e2e       -> /out        (read-write; logs, build-info.json, the .deb)
  The repository itself is never written to.

.EXAMPLE
  pwsh -File test\mcp-e2e\containers\build-vscode.ps1 -Branch mcp-2026/m4-conformance-client
#>
param(
	[string]$Branch,
	[string]$Target = 'vscode-linux-x64-min',
	[string]$Repo,
	[string]$Name = 'vscode-e2e-build',
	[switch]$ForceNpmCi,
	[switch]$SkipBuild,
	[switch]$RebuildImage
)
. (Join-Path $PSScriptRoot 'e2e-common.ps1')
if (-not $Repo) { $Repo = $script:DefaultRepo }
if (-not $Branch) { $Branch = Get-CurrentBranch $Repo }
$out = Join-Path $Repo '.build\e2e'
$runId = New-RunId
New-Item -ItemType Directory -Force (Join-Path $out 'logs') | Out-Null
$driverLog = Join-Path $out "logs\build-vscode-driver-$runId.log"
function Log([string]$msg) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg; Write-Host $line; Add-Content -Path $driverLog -Value $line }

$sw = [Diagnostics.Stopwatch]::StartNew()
Initialize-E2eImages -Rebuild:$RebuildImage -LogDir (Join-Path $out 'logs')
Initialize-E2eVolume
Remove-StaleContainer $Name

$runArgs = @(
	'run', '--rm', '--name', $Name,
	'--shm-size', '2g',
	'--mount', "type=bind,source=$Repo,target=/src/vscode,readonly",
	'--mount', "type=bind,source=$script:E2eDir,target=/src/e2e,readonly",
	'--mount', "type=bind,source=$out,target=/out",
	'--mount', "type=volume,source=$script:Volume,target=/work",
	'-e', "E2E_RUN_ID=$runId",
	'-e', "VSCODE_BUILD_TARGET=$Target"
)
if ($ForceNpmCi) { $runArgs += @('-e', 'FORCE_NPM_CI=1') }
if ($SkipBuild) { $runArgs += @('-e', 'SKIP_BUILD=1') }
$runArgs += @($script:Image, 'bash', '/src/e2e/containers/build-vscode.sh', $Branch)

Log "wslc $($runArgs -join ' ')"
& $script:Wslc @runArgs
$rc = $LASTEXITCODE
Log ("build container exited with {0} after {1:n1} min (logs: {2}\logs\build-vscode-{3}.log)" -f $rc, $sw.Elapsed.TotalMinutes, $out, $runId)
if ($rc -ne 0) { exit $rc }
Get-Content (Join-Path $out 'build-info.json') | Out-Host
