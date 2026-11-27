# Clean-machine install test (phase 1: install, init with the defaults, import, recall, MCP, backup) for @synalla/memory, run inside Windows Sandbox at logon.
$ErrorActionPreference = 'Continue'
$out = 'C:\out'; $in = 'C:\in'; $log = "$out\log.txt"
function Step($name, [scriptblock]$b) { "=== $name" | Out-File $log -Append -Encoding utf8
  try { & $b 2>&1 | Out-File $log -Append -Encoding utf8; $code = $LASTEXITCODE } catch { $_ | Out-File $log -Append -Encoding utf8; $code = 99 }
  "--- $name exit $code" | Out-File $log -Append -Encoding utf8; "$name`t$code" | Out-File "$out\steps.tsv" -Append -Encoding utf8 }
"start $(Get-Date -Format o) $([Environment]::OSVersion.VersionString)" | Out-File $log -Encoding utf8
$v = 'v24.19.0'; $zip = "node-$v-win-x64.zip"
Step 'download node' { $ProgressPreference='SilentlyContinue'
  Invoke-WebRequest "https://nodejs.org/dist/$v/$zip" -OutFile "C:\$zip"; Invoke-WebRequest "https://nodejs.org/dist/$v/SHASUMS256.txt" -OutFile C:\SHASUMS256.txt
  $want = ((Get-Content C:\SHASUMS256.txt) -match " $zip$") -split ' ' | Select-Object -First 1
  $got = (Get-FileHash "C:\$zip" -Algorithm SHA256).Hash.ToLower(); "want $want got $got"; if ($want -ne $got) { throw 'node checksum mismatch' }
  Expand-Archive "C:\$zip" C:\node-x; Move-Item "C:\node-x\node-$v-win-x64" C:\node; $global:LASTEXITCODE = 0 }
$env:Path = "C:\node;$env:APPDATA\npm;$env:Path"
Step 'node version' { node --version; npm --version }
Step 'npm install -g' { npm install -g "$in\synalla-memory.tgz" }
Step 'where' { where.exe synalla-memory }
Step 'init' { synalla-memory init }
Step 'import-notes' { synalla-memory import-notes "$in\notes" }
Step 'import (no sessions yet)' { synalla-memory import }
Step 'recall' { synalla-memory recall 'dentist appointment' }
Step 'status' { $o = synalla-memory status; $o; if ("$o" -notmatch '2 chunk\(s\), 2 with vectors') { 'search by meaning is OFF'; $global:LASTEXITCODE = 1 } }
Step 'mcp serve probe' { node "$in\mcp_probe.mjs" synalla-memory }
Step 'backup-to folder' { New-Item -ItemType Directory C:\out\bk | Out-Null; synalla-memory backup-to folder C:\out\bk }
Step 'backup' { synalla-memory backup; Get-ChildItem C:\out\bk -Recurse | Select-Object FullName, Length }
"end $(Get-Date -Format o)" | Out-File $log -Append -Encoding utf8
New-Item "$out\DONE" | Out-Null
shutdown.exe /s /t 5
