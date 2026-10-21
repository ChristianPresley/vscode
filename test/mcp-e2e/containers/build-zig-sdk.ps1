<#
.SYNOPSIS
  Builds the zig-sdk conformance server and examples inside vscode-mcp-build:2 from a read-only
  mount of the zig-sdk repository (cloned into the vscode-e2e-work volume at /work/zig-sdk) and
  checks that mcp-conformance-server answers a 2026-07-28 server/discover over HTTP and gRPC.
  Result: <repo>\.build\e2e\zig-sdk-info.json.
#>
param(
	[string]$Branch = 'main',
	[string]$ZigSdk = 'C:\repos\zig-sdk',
	[string]$Repo,
	[string]$Name = 'zig-sdk-e2e-build'
)
. (Join-Path $PSScriptRoot 'e2e-common.ps1')
if (-not $Repo) { $Repo = $script:DefaultRepo }
$out = Join-Path $Repo '.build\e2e'
New-Item -ItemType Directory -Force (Join-Path $out 'logs') | Out-Null
$runId = New-RunId
Initialize-E2eImages -LogDir (Join-Path $out 'logs')
Initialize-E2eVolume
Remove-StaleContainer $Name
$sw = [Diagnostics.Stopwatch]::StartNew()
& $script:Wslc run --rm --name $Name `
	--mount "type=bind,source=$ZigSdk,target=/src/zig-sdk,readonly" `
	--mount "type=bind,source=$script:E2eDir,target=/src/e2e,readonly" `
	--mount "type=bind,source=$out,target=/out" `
	--mount "type=volume,source=$script:Volume,target=/work" `
	-e "E2E_RUN_ID=$runId" `
	$script:Image bash /src/e2e/containers/build-zig-sdk.sh $Branch
$rc = $LASTEXITCODE
Write-Host ("zig-sdk container exited with {0} after {1:n1} s" -f $rc, $sw.Elapsed.TotalSeconds)
exit $rc
