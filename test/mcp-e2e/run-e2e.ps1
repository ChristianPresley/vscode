<#
.SYNOPSIS
  End-to-end tests of the VS Code fork's MCP client with a llama.cpp model, in WSL containers.

.DESCRIPTION
  1. ensures the images (vscode-mcp-build:latest, :2), the network vscode-e2e-net and the volume
     vscode-e2e-work
  2. builds the .deb of -Branch (default: the checked-out branch; committed state only) unless
     -SkipBuild or -Deb; llama-e2e is stopped during the build (memory) unless -KeepLlamaDuringBuild
  3. builds the zig-sdk servers when they are missing from the volume (or with -RebuildZig)
  4. starts llama-e2e (llama.cpp, Qwen3-8B) on vscode-e2e-net
  5. runs containers/run-suite.sh in a fresh container on vscode-e2e-net: installs the .deb, starts
     the MCP servers, runs the API suite (extension tests) and the UI suite (Playwright: screenshots
     and the input that needs the UI)
  Results: <repo>\.build\e2e\runs\<run id>\ (summary.md, which starts with the installed commit and
  the content hash of test/mcp-e2e, provenance.json, api\, ui\, logs-*\); screenshots:
  <repo>\.build\visual-verification\. Exits non-zero on any failure.

  -Deb <path>      tests that package instead of the newest .deb of .build\e2e (implies -SkipBuild)
  -Repeat <n>      runs the suite n times, each in a fresh container with the run id <run id>-r<i>,
                   and writes runs\<run id>-aggregate.md/.json; strict: the run passes only when
                   every repetition passed
  -Mutate <names>  applies test-side mutations of runner/mutations.ts; each must make its test fail
                   (see run-mutations.ps1 and the README)

.EXAMPLE
  pwsh -File test\mcp-e2e\run-e2e.ps1 -SkipBuild
  pwsh -File test\mcp-e2e\run-e2e.ps1 -Branch mcp-2026/final -AllowFail grpc
  pwsh -File test\mcp-e2e\run-e2e.ps1 -SkipBuild -Repeat 3 -RunId final
  pwsh -File test\mcp-e2e\run-e2e.ps1 -Deb .build\e2e-keep\m8-6201d830320.deb -SkipUi -Only 'gRPC soak'
#>
param(
	[string]$Branch,
	[switch]$SkipBuild,
	[switch]$SkipApi,
	[switch]$SkipUi,
	# Comma-separated test groups whose failures are reported but do not fail the run (e.g. grpc).
	[string]$AllowFail = '',
	# Comma-separated substrings: only the tests whose name contains one of them.
	[string]$Only = '',
	[string]$RunId,
	[string]$Repo,
	[string]$ZigSdk = 'C:\repos\zig-sdk',
	[string]$ZigBranch = 'v0.6.0',
	[switch]$RebuildZig,
	[switch]$Cpu,
	[switch]$KeepLlamaDuringBuild,
	# A .deb to test instead of the newest one of .build\e2e (no build).
	[string]$Deb,
	# Run the suite this many times, each with its own run id and container; all must pass.
	[ValidateRange(1, 20)][int]$Repeat = 1,
	# Comma-separated mutations of runner/mutations.ts (each must make its test fail).
	[string]$Mutate = '',
	[string]$Name = 'vscode-e2e-test'
)
. (Join-Path $PSScriptRoot 'containers\e2e-common.ps1')
if (-not $Repo) { $Repo = $script:DefaultRepo }
if (-not $RunId) { $RunId = New-RunId }
$out = Join-Path $Repo '.build\e2e'
$vv = Join-Path $Repo '.build\visual-verification'
New-Item -ItemType Directory -Force (Join-Path $out 'logs'), (Join-Path $out 'runs'), $vv | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()
function Step([string]$msg) { Write-Host ("`n[{0}] === {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) }

# -Deb: the package as the test container sees it (/out/... inside .build\e2e, else its own mount).
$debMount = @()
$debInContainer = ''
if ($Deb) {
	$debPath = (Resolve-Path -LiteralPath $Deb -ErrorAction Stop).Path
	if (-not $debPath.EndsWith('.deb')) { throw "-Deb $Deb is not a .deb" }
	$outFull = (Resolve-Path -LiteralPath $out).Path.TrimEnd('\')
	if ($debPath.StartsWith($outFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
		$debInContainer = '/out/' + $debPath.Substring($outFull.Length + 1).Replace('\', '/')
	} else {
		$debMount = @('--mount', "type=bind,source=$(Split-Path -Parent $debPath),target=/deb,readonly")
		$debInContainer = '/deb/' + (Split-Path -Leaf $debPath)
	}
	$SkipBuild = $true
	Write-Host "testing $debPath ($debInContainer in the container)"
}

Step 'images, network, volume'
Initialize-E2eImages -LogDir (Join-Path $out 'logs')
Initialize-E2eNetwork
Initialize-E2eVolume

if (-not $SkipBuild) {
	if (-not $Branch) { $Branch = Get-CurrentBranch $Repo }
	Step "build the .deb of $Branch"
	$llamaWasRunning = Test-ContainerRunning $script:LlamaName
	if ($llamaWasRunning -and -not $KeepLlamaDuringBuild) { & $script:Wslc stop $script:LlamaName | Out-Null }
	& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'containers\build-vscode.ps1') -Branch $Branch -Repo $Repo
	$buildRc = $LASTEXITCODE
	if ($buildRc -ne 0) { Write-Host "build failed ($buildRc)"; exit $buildRc }
} elseif (-not $Deb -and -not (Get-ChildItem -Path $out -Filter '*.deb' -ErrorAction SilentlyContinue)) {
	throw "-SkipBuild: no .deb in $out"
}

Step 'zig-sdk servers'
$zigOk = $false
if (-not $RebuildZig) {
	& $script:Wslc run --rm --mount "type=volume,source=$script:Volume,target=/work,readonly" $script:Image test -x /work/zig-sdk/zig-out/bin/mcp-conformance-server
	$zigOk = $LASTEXITCODE -eq 0
}
if (-not $zigOk) {
	& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'containers\build-zig-sdk.ps1') -Branch $ZigBranch -ZigSdk $ZigSdk -Repo $Repo
	if ($LASTEXITCODE -ne 0) { throw "zig-sdk build failed ($LASTEXITCODE)" }
}

Step 'llama.cpp'
$llamaArgs = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'containers\start-llama.ps1'), '-Repo', $Repo, '-SkipChecks')
if ($Cpu) { $llamaArgs += '-Cpu' }
& pwsh @llamaArgs
if ($LASTEXITCODE -ne 0) { throw "llama.cpp did not start ($LASTEXITCODE)" }

function Invoke-Suite([string]$Id) {
	Step "suite (run $Id)"
	Remove-StaleContainer $Name
	$runArgs = @('run', '--rm', '--name', $Name, '--shm-size', '2g', '--network', $script:Network,
		'--mount', "type=bind,source=$script:E2eDir,target=/src/e2e,readonly",
		'--mount', "type=bind,source=$out,target=/out",
		'--mount', "type=bind,source=$vv,target=/vv",
		'--mount', "type=volume,source=$script:Volume,target=/work") + $debMount + @(
		'-e', "E2E_RUN_ID=$Id",
		'-e', "LLAMA_URL=http://$($script:LlamaName):8080")
	if ($debInContainer) { $runArgs += @('-e', "E2E_DEB=$debInContainer") }
	if ($AllowFail) { $runArgs += @('-e', "MCP_E2E_ALLOW_FAIL=$AllowFail") }
	if ($Only) { $runArgs += @('-e', "MCP_E2E_ONLY=$Only") }
	if ($Mutate) { $runArgs += @('-e', "MCP_E2E_MUTATIONS=$Mutate") }
	if ($SkipApi) { $runArgs += @('-e', 'E2E_SKIP_API=1') }
	if ($SkipUi) { $runArgs += @('-e', 'E2E_SKIP_UI=1') }
	$runArgs += @($script:Image, 'bash', '/src/e2e/containers/run-suite.sh')
	Write-Host "wslc $($runArgs -join ' ')"
	& $script:Wslc @runArgs | Out-Host
	return $LASTEXITCODE
}

if ($Repeat -eq 1) {
	$rc = Invoke-Suite $RunId
	Step ("finished with {0} after {1:n1} min; results: {2}\runs\{3}\summary.md; screenshots: {4}" -f $rc, $sw.Elapsed.TotalMinutes, $out, $RunId, $vv)
	exit $rc
}

# -Repeat: the same package and servers, a fresh container per repetition; strict: all must pass.
$ids = @()
$codes = @()
for ($i = 1; $i -le $Repeat; $i++) {
	$id = "$RunId-r$i"
	$ids += $id
	$codes += (Invoke-Suite $id)
	Write-Host ("repetition {0}/{1} ({2}) exited with {3}" -f $i, $Repeat, $id, $codes[-1])
}
Step "aggregate of $Repeat runs"
Remove-StaleContainer "$Name-aggregate"
$aggArgs = @('run', '--rm', '--name', "$Name-aggregate",
	'--mount', "type=bind,source=$script:E2eDir,target=/src/e2e,readonly",
	'--mount', "type=bind,source=$out,target=/out",
	$script:Image, 'node', '/src/e2e/runner/aggregate.ts', '/out/runs', "$RunId-aggregate") + $ids + @('--exit-codes', ($codes -join ','))
& $script:Wslc @aggArgs | Out-Host
$rc = $LASTEXITCODE
Step ("{0} runs finished with {1} after {2:n1} min; aggregate: {3}\runs\{4}-aggregate.md" -f $Repeat, $rc, $sw.Elapsed.TotalMinutes, $out, $RunId)
exit $rc
