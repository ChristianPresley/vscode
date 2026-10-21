# e2e-common.ps1 - dot-sourced by the PowerShell drivers of test/mcp-e2e. Names, paths and the
# helpers that create the WSL container resources on demand.

$ErrorActionPreference = 'Stop'

$script:Wslc = 'C:\Program Files\WSL\wslc.exe'
$script:E2eDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path          # test/mcp-e2e (mounted at /src/e2e)
$script:ContainersDir = $PSScriptRoot                                         # test/mcp-e2e/containers
$script:DefaultRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$script:BaseImage = 'vscode-mcp-build:latest'
$script:Image = 'vscode-mcp-build:2'
$script:Network = 'vscode-e2e-net'
$script:Volume = 'vscode-e2e-work'
$script:LlamaName = 'llama-e2e'

if (-not (Test-Path $script:Wslc)) {
	throw "WSL Containers CLI not found at $script:Wslc (WSL 3 with wslc is required)"
}

function Invoke-Wslc {
	& $script:Wslc @args
}

function Test-WslcObject([string]$Kind, [string]$Name) {
	switch ($Kind) {
		'image' { & $script:Wslc image inspect $Name *> $null }
		'volume' { & $script:Wslc volume inspect $Name *> $null }
		'network' { & $script:Wslc network inspect $Name *> $null }
		'container' { & $script:Wslc inspect --type container $Name *> $null }
	}
	return $LASTEXITCODE -eq 0
}

function Test-ContainerRunning([string]$Name) {
	$state = & $script:Wslc inspect --type container --format json $Name 2>$null
	if ($LASTEXITCODE -ne 0) { return $false }
	return [bool](($state | ConvertFrom-Json)[0].State.Running)
}

# The builder/runtime images: vscode-mcp-build:latest (Dockerfile.base) and vscode-mcp-build:2 (Dockerfile.builder).
function Initialize-E2eImages([switch]$Rebuild, [string]$LogDir) {
	if ($LogDir) { New-Item -ItemType Directory -Force $LogDir | Out-Null }
	foreach ($spec in @(@{ Tag = $script:BaseImage; File = 'Dockerfile.base' }, @{ Tag = $script:Image; File = 'Dockerfile.builder' })) {
		if ($Rebuild -or -not (Test-WslcObject image $spec.Tag)) {
			Write-Host "building image $($spec.Tag) from $($spec.File)"
			$log = if ($LogDir) { Join-Path $LogDir ("image-{0}.log" -f ($spec.Tag -replace '[:/]', '_')) } else { $null }
			if ($log) {
				& $script:Wslc build -t $spec.Tag -f (Join-Path $script:ContainersDir $spec.File) --progress plain $script:ContainersDir 2>&1 | Tee-Object -FilePath $log | Out-Host
			} else {
				& $script:Wslc build -t $spec.Tag -f (Join-Path $script:ContainersDir $spec.File) --progress plain $script:ContainersDir | Out-Host
			}
			if ($LASTEXITCODE -ne 0) { throw "image build of $($spec.Tag) failed ($LASTEXITCODE)" }
		}
	}
}

function Initialize-E2eNetwork {
	if (-not (Test-WslcObject network $script:Network)) {
		& $script:Wslc network create $script:Network | Out-Host
		if ($LASTEXITCODE -ne 0) { throw "network create $script:Network failed" }
	}
}

function Initialize-E2eVolume {
	if (-not (Test-WslcObject volume $script:Volume)) {
		& $script:Wslc volume create $script:Volume | Out-Host
		if ($LASTEXITCODE -ne 0) { throw "volume create $script:Volume failed" }
	}
}

function Remove-StaleContainer([string]$Name) {
	if (Test-WslcObject container $Name) {
		Write-Host "removing stale container $Name"
		& $script:Wslc remove -f $Name *> $null
	}
}

# The checked-out branch of the repository (read-only git).
function Get-CurrentBranch([string]$Repo) {
	$branch = (& git -C $Repo rev-parse --abbrev-ref HEAD 2>$null)
	if ($LASTEXITCODE -ne 0 -or -not $branch -or $branch -eq 'HEAD') { throw "cannot determine the current branch of $Repo; pass -Branch" }
	return $branch.Trim()
}

function New-RunId { (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') }
