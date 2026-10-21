<#
.SYNOPSIS
  The mutation runs of the MCP end-to-end suite: each run applies one mutation of
  runner/mutations.ts (or, for soak-m8-package, tests the m8 package) and must make the tests it
  names fail. Prints KILLED or NOT KILLED per mutation and exits non-zero when any survived.

.DESCRIPTION
  Runs `run-e2e.ps1 -SkipBuild -Mutate <name> -Only <its tests>` (the suite it needs only) with the
  run id mut-<name>-<stamp>, then `node runner/mutations.ts check <run dir> <name>` on the host.
  Node.js (24) is needed on the host for the check; `node runner/mutations.ts list` prints the
  table with the exact commands (README.md "Mutation runs").

.EXAMPLE
  pwsh -File test\mcp-e2e\run-mutations.ps1
  pwsh -File test\mcp-e2e\run-mutations.ps1 -Names strip-tasks,no-mangle
#>
param(
	# Only these mutations (comma-separated); default all.
	[string]$Names = '',
	[string]$Repo
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $here '..\..')).Path }
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'node (Node.js 24) is needed on the host for runner/mutations.ts' }
$mutations = & node (Join-Path $here 'runner\mutations.ts') json | ConvertFrom-Json
if ($Names) {
	$wanted = $Names.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
	$mutations = $mutations | Where-Object { $wanted -contains $_.name }
}
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$results = @()
foreach ($m in $mutations) {
	$runId = "mut-$($m.name)-$stamp"
	$runArgs = @('-NoProfile', '-File', (Join-Path $here 'run-e2e.ps1'), '-SkipBuild', '-Only', $m.only, '-RunId', $runId)
	if ($m.deb) { $runArgs += @('-Deb', (Join-Path $Repo $m.deb)) } else { $runArgs += @('-Mutate', $m.name) }
	if ($m.suites -eq 'api') { $runArgs += '-SkipUi' } elseif ($m.suites -eq 'ui') { $runArgs += '-SkipApi' }
	Write-Host "`n=== mutation $($m.name): $($m.summary)"
	Write-Host "pwsh $($runArgs -join ' ')"
	& pwsh @runArgs | Out-Host
	$runDir = Join-Path $Repo ".build\e2e\runs\$runId"
	& node (Join-Path $here 'runner\mutations.ts') check $runDir $m.name | Out-Host
	$results += [pscustomobject]@{ Mutation = $m.name; Killed = ($LASTEXITCODE -eq 0); Run = $runId }
}
Write-Host "`n=== mutation summary"
$results | Format-Table -AutoSize | Out-Host
$survived = @($results | Where-Object { -not $_.Killed })
if ($survived.Count) {
	Write-Host "$($survived.Count) mutation(s) survived: $($survived.Mutation -join ', ')"
	exit 1
}
Write-Host 'every mutation was killed'
exit 0
