<#
.SYNOPSIS
  Starts (or reuses) the llama.cpp server container llama-e2e on vscode-e2e-net and checks that a
  VS Code container reaches it by name (http://llama-e2e:8080) and that it answers a chat request
  with a tool call. -CheckPublishedPort also probes the published port through the bridge gateway
  (expected to fail with wslc 3.0.3, see README.md).

.DESCRIPTION
  The model file is read from -Models (default <repo>\.build\e2e-models); see README.md for the
  download command. -Cpu starts the CPU image (ghcr.io/ggml-org/llama.cpp:server) without --gpus.
#>
param(
	[string]$Repo,
	[string]$Models,
	[string]$Model = 'Qwen3-8B-Q4_K_M.gguf',
	[string]$LlamaImage,
	[int]$Port = 8080,
	[int]$Context = 16384,
	[switch]$Cpu,
	[switch]$Restart,
	[switch]$SkipChecks,
	[switch]$CheckPublishedPort
)
. (Join-Path $PSScriptRoot 'e2e-common.ps1')
if (-not $Repo) { $Repo = $script:DefaultRepo }
if (-not $Models) { $Models = Join-Path $Repo '.build\e2e-models' }
if (-not $LlamaImage) { $LlamaImage = if ($Cpu) { 'ghcr.io/ggml-org/llama.cpp:server' } else { 'ghcr.io/ggml-org/llama.cpp:server-cuda' } }
$out = Join-Path $Repo '.build\e2e'
New-Item -ItemType Directory -Force (Join-Path $out 'logs') | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()

if (-not (Test-Path (Join-Path $Models $Model))) {
	throw "model $Models\$Model not found; download it first (README.md, 'Prerequisites')"
}
Initialize-E2eNetwork

$name = $script:LlamaName
$running = Test-ContainerRunning $name
if (Test-WslcObject container $name) {
	if ($Restart -or -not $running) { & $script:Wslc remove -f $name *> $null; $running = $false }
}
if (-not $running) {
	$gpu = if ($Cpu) { @() } else { @('--gpus', 'all') }
	$layers = if ($Cpu) { @() } else { @('-ngl', '99') }
	& $script:Wslc run -d --name $name @gpu --network $script:Network -p "127.0.0.1:${Port}:8080" `
		--mount "type=bind,source=$Models,target=/models,readonly" `
		$LlamaImage -m "/models/$Model" --host 0.0.0.0 --port 8080 --jinja @layers -c $Context | Out-Host
	if ($LASTEXITCODE -ne 0) { throw "llama.cpp container failed to start ($LASTEXITCODE)" }
}

# /health answers 200 once the model is loaded.
$deadline = (Get-Date).AddMinutes(5)
do {
	Start-Sleep -Seconds 2
	try { $ok = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$Port/health").StatusCode -eq 200 } catch { $ok = $false }
} until ($ok -or (Get-Date) -gt $deadline)
if (-not $ok) { & $script:Wslc logs $name | Select-Object -Last 40 | Out-Host; throw 'llama.cpp did not become healthy' }
Write-Host ("llama.cpp healthy after {0:n1} s (host: http://localhost:{1}, containers: http://{2}:8080)" -f $sw.Elapsed.TotalSeconds, $Port, $name)
if ($SkipChecks) { exit 0 }

Initialize-E2eImages -LogDir (Join-Path $out 'logs')
$common = @('run', '--rm', '--mount', "type=bind,source=$script:E2eDir,target=/src/e2e,readonly", '--mount', "type=bind,source=$out,target=/out")
Write-Host "`n--- user-defined network $script:Network, by container name"
& $script:Wslc @common --network $script:Network $script:Image bash /src/e2e/containers/check-llama.sh "http://${name}:8080" network
$a = $LASTEXITCODE
if ($CheckPublishedPort) {
	# Expected to fail: wslc publishes ports through a Windows-side relay bound to 127.0.0.1.
	$gateway = ((& $script:Wslc network inspect bridge) | ConvertFrom-Json)[0].IPAM.Config[0].Gateway
	Write-Host "`n--- default bridge, published port via gateway $gateway (expected to fail with wslc 3.0.3)"
	& $script:Wslc @common $script:Image bash /src/e2e/containers/check-llama.sh "http://${gateway}:$Port" published
	Write-Host ("published-port-via-gateway: {0}" -f $(if ($LASTEXITCODE -eq 0) { 'OK' } else { "FAIL($LASTEXITCODE)" }))
}
Write-Host ("network-by-name: {0}; total {1:n1} s" -f $(if ($a -eq 0) { 'OK' } else { "FAIL($a)" }), $sw.Elapsed.TotalSeconds)
exit $a
