<#
.SYNOPSIS
  Installs the newest .deb from <repo>\.build\e2e into a fresh vscode-mcp-build:2 container and
  verifies it (version, headless --list-extensions, full workbench start under xvfb with the smoke
  test of the E2E extension). Result: .build\e2e\install-info.json.
  When llama-e2e runs on vscode-e2e-net and the zig-sdk binaries exist in the vscode-e2e-work
  volume, it also checks both peers from inside the VS Code container.
#>
param(
	[string]$Repo,
	[string]$Name = 'vscode-e2e-install'
)
. (Join-Path $PSScriptRoot 'e2e-common.ps1')
if (-not $Repo) { $Repo = $script:DefaultRepo }
$out = Join-Path $Repo '.build\e2e'
$runId = New-RunId
Initialize-E2eImages -LogDir (Join-Path $out 'logs')
Initialize-E2eVolume
Remove-StaleContainer $Name
$runArgs = @('run', '--rm', '--name', $Name, '--shm-size', '2g',
	'--mount', "type=bind,source=$script:E2eDir,target=/src/e2e,readonly",
	'--mount', "type=bind,source=$out,target=/out",
	'--mount', "type=volume,source=$script:Volume,target=/work,readonly",
	'-e', "E2E_RUN_ID=$runId")
# Join the e2e network when llama-e2e runs there, so the VS Code container can reach it by name.
if (Test-WslcObject network $script:Network) {
	$runArgs += @('--network', $script:Network)
	if (Test-ContainerRunning $script:LlamaName) { $runArgs += @('-e', "LLAMA_URL=http://$($script:LlamaName):8080") }
}
$runArgs += @($script:Image, 'bash', '/src/e2e/containers/verify-install.sh')
Write-Host "wslc $($runArgs -join ' ')"
$sw = [Diagnostics.Stopwatch]::StartNew()
& $script:Wslc @runArgs
$rc = $LASTEXITCODE
Write-Host ("install/verify container exited with {0} after {1:n1} s" -f $rc, $sw.Elapsed.TotalSeconds)
exit $rc
