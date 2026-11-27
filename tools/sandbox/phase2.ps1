# Clean-machine restore test (phase 2: a second fresh machine restores phase 1's backup with its recovery code) for @synalla/memory, run inside Windows Sandbox at logon.
$ErrorActionPreference = 'Continue'
$out = 'C:\out'; $in = 'C:\in'; $log = "$out\log.txt"
function Step($name, [scriptblock]$b) { "=== $name" | Out-File $log -Append -Encoding utf8
  try { & $b 2>&1 | Out-File $log -Append -Encoding utf8; $code = $LASTEXITCODE } catch { $_ | Out-File $log -Append -Encoding utf8; $code = 99 }
  "--- $name exit $code" | Out-File $log -Append -Encoding utf8; "$name`t$code" | Out-File "$out\steps.tsv" -Append -Encoding utf8 }
"start $(Get-Date -Format o) $([Environment]::OSVersion.VersionString)" | Out-File $log -Append -Encoding utf8
$v = 'v24.19.0'; $zip = "node-$v-win-x64.zip"
Step 'download node' { $ProgressPreference='SilentlyContinue'
  Invoke-WebRequest "https://nodejs.org/dist/$v/$zip" -OutFile "C:\$zip"; Invoke-WebRequest "https://nodejs.org/dist/$v/SHASUMS256.txt" -OutFile C:\SHASUMS256.txt
  $want = ((Get-Content C:\SHASUMS256.txt) -match " $zip$") -split ' ' | Select-Object -First 1
  $got = (Get-FileHash "C:\$zip" -Algorithm SHA256).Hash.ToLower(); "want $want got $got"; if ($want -ne $got) { throw 'node checksum mismatch' }
  Expand-Archive "C:\$zip" C:\node-x; Move-Item "C:\node-x\node-$v-win-x64" C:\node; $global:LASTEXITCODE = 0 }
$env:Path = "C:\node;$env:APPDATA\npm;$env:Path"
Step 'npm install -g' { npm install -g "$in\synalla-memory.tgz" 2>&1 | Select-String -NotMatch 'npm notice' }
$code = (Select-String -Path "$out\log.txt" -Pattern '^\s+([0-9A-Z]{5}(?:-[0-9A-Z]{5}){5,})\s*$' | Select-Object -First 1).Matches[0].Groups[1].Value
"code read from phase 1 log: $($code.Length) chars" | Out-File $log -Append -Encoding utf8
Copy-Item "$out\bk" C:\bk2 -Recurse
Step 'restore' { synalla-memory restore C:\restored --code $code --from folder C:\bk2 }
$env:SYNALLA_MEMORY_HOME = 'C:\restored'
Step 'status after restore' { synalla-memory status }
Step 'recall after restore' { synalla-memory recall 'bike chain' }
Step 'wrong code refused' { $bad = $code.Substring(0, $code.Length - 1) + $(if ($code[-1] -eq 'A') { 'B' } else { 'A' }); synalla-memory restore C:\restored2 --code $bad --from folder C:\bk2; if ($LASTEXITCODE -ne 0) { $global:LASTEXITCODE = 0; 'refused as expected' } else { $global:LASTEXITCODE = 1 } }
"end $(Get-Date -Format o)" | Out-File $log -Append -Encoding utf8
New-Item "$out\DONE2" | Out-Null
shutdown.exe /s /t 5
