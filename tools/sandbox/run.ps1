# Clean-machine test in Windows Sandbox: packs the package, runs phase 1 (install, init with the defaults, import,
# recall, MCP handshake, backup) in one fresh sandbox, then phase 2 (restore with the recovery code, recall, a wrong
# code refused) in a second one. Needs Windows Sandbox enabled. Results: <out>\steps.tsv and <out>\log.txt.
# Usage (from the repo root): powershell -File tools\sandbox\run.ps1 [-Out <empty folder>]
param([string]$Out = (Join-Path $env:TEMP "synalla-sandbox-$(Get-Date -Format yyyyMMdd-HHmmss)"))
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot; $repo = (Resolve-Path "$here\..\..").Path
$in = Join-Path $Out 'in'; $res = Join-Path $Out 'out'
New-Item -ItemType Directory -Force $in, $res, "$in\notes" | Out-Null
Push-Location $repo; try { $tgz = (npm pack --pack-destination $in --silent) | Select-Object -Last 1 } finally { Pop-Location }
Move-Item (Join-Path $in $tgz) (Join-Path $in 'synalla-memory.tgz')
Copy-Item "$here\phase1.ps1", "$here\phase2.ps1", "$here\mcp_probe.mjs" $in; Copy-Item "$here\notes\*" "$in\notes"
foreach ($p in 1, 2) {
  @"
<Configuration>
  <Networking>Enable</Networking>
  <vGPU>Disable</vGPU>
  <MappedFolders>
    <MappedFolder><HostFolder>$in</HostFolder><SandboxFolder>C:\in</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$res</HostFolder><SandboxFolder>C:\out</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\in\phase$p.ps1</Command></LogonCommand>
</Configuration>
"@ | Set-Content -Encoding utf8 (Join-Path $Out "phase$p.wsb")
}
foreach ($p in 1, 2) {
  $done = Join-Path $res $(if ($p -eq 1) { 'DONE' } else { 'DONE2' })
  Start-Process (Join-Path $Out "phase$p.wsb")
  $until = (Get-Date).AddMinutes(20)
  while (-not (Test-Path $done)) { if ((Get-Date) -gt $until) { throw "phase $p did not finish in 20 minutes; see $res\log.txt" }; Start-Sleep 5 }
  # Only one sandbox can run at a time: wait for this one to shut down.
  Start-Sleep 30; while (Get-Process WindowsSandbox, WindowsSandboxClient, WindowsSandboxRemoteSession -ErrorAction SilentlyContinue) { Start-Sleep 3 }
}
$steps = Get-Content "$res\steps.tsv" | ForEach-Object { $n, $c = $_ -split "`t"; [pscustomobject]@{ Step = $n.Trim([char]0xFEFF); Exit = [int]$c } }
$steps | Format-Table -AutoSize | Out-String | Write-Output
$bad = @($steps | Where-Object Exit -ne 0)
if ($bad.Count) { Write-Output "FAILED: $($bad.Step -join ', ') (log: $res\log.txt)"; exit 1 } else { Write-Output "all $($steps.Count) steps passed (log: $res\log.txt)" }
