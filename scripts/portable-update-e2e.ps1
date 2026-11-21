# Portable self-update, end to end, with two real builds (0.2.0 -> 0.2.1) and a local server standing in for GitHub.
#   B: latest.json names a wrong sha256 -> the download is refused, nothing is replaced
#   A: correct entry -> download, size + sha256 + signature + --selftest, --finish-update swap, restart as 0.2.1, clean-up
# The apps run with OMW_UPDATE_QA=1 (no window, update without a click), TEMP and the WebView2 profile in this folder.
# Usage: scripts/portable-update-e2e.ps1 -Dir <work folder> -Key <throwaway minisign key>
#   <work folder>\builds\omniweave-0.2.0.exe and omniweave-0.2.1.exe: two `tauri build --no-bundle` builds whose config
#   sets version, identifier app.omniweave.updatetest and plugins.updater {pubkey of that key, endpoints
#   ["http://127.0.0.1:18765/latest.json"], dangerousInsecureTransportProtocol: true}; <work folder>\serve.mjs = a static
#   server for <work folder>\server on 127.0.0.1:18765 that logs requests to server.log. Never the real updater key.
param([Parameter(Mandatory)][string]$Dir, [Parameter(Mandatory)][string]$Key)
$ErrorActionPreference = "Stop"
# the test builds use their own identifier (app.omniweave.updatetest), so their WebView2 profile is not the real app's
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\app.omniweave.updatetest" -ErrorAction SilentlyContinue
# node, npx and the Tauri CLI must be on PATH
$d = $Dir
Set-Location $d
foreach ($x in "server", "app", "tmp") { if (Test-Path $x) { Remove-Item -Recurse -Force $x }; New-Item -ItemType Directory $x | Out-Null }
Remove-Item -Force server.log, e2e.log -ErrorAction SilentlyContinue
function Say($s) { $line = "$(Get-Date -Format HH:mm:ss) $s"; Add-Content e2e.log $line; $line }

$new = "server\Omniweave_0.2.1_x64-portable.exe"
Copy-Item builds\omniweave-0.2.1.exe $new
Push-Location (Split-Path $PSScriptRoot)
npx.cmd tauri signer sign -f $Key -p '""' (Join-Path $d $new) *> $null
Pop-Location
$sig = (Get-Content "$new.sig" -Raw).Trim()
$size = (Get-Item $new).Length
$sha = (Get-FileHash $new -Algorithm SHA256).Hash.ToLower()
Say "server: 0.2.1 portable $size bytes sha256 $sha (signed with the throwaway test key)"
foreach ($v in "0.2.0", "0.2.1") {
  $p = Start-Process "builds\omniweave-$v.exe" -ArgumentList "--selftest" -WindowStyle Hidden -Wait -PassThru
  Say "selftest $v exit $($p.ExitCode)"
}
function Manifest($sha256) {
  $url = "http://127.0.0.1:18765/Omniweave_0.2.1_x64-portable.exe"
  $m = [ordered]@{
    version = "0.2.1"; notes = "[important] update test`n- portable swap test"; pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{ "windows-x86_64" = [ordered]@{ signature = $sig; url = $url } }
    portable = [ordered]@{ "windows-x86_64" = [ordered]@{ url = $url; size = $size; sha256 = $sha256; signature = $sig } }
  }
  [IO.File]::WriteAllText("$d\server\latest.json", ($m | ConvertTo-Json -Depth 6))
}
$srv = Start-Process node -ArgumentList "serve.mjs" -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 800
$env:OMW_UPDATE_QA = "1"; $env:TEMP = "$d\tmp"; $env:TMP = "$d\tmp"
$exe = "$d\app\Omniweave_0.2.0_x64-portable.exe"
$log = "$d\tmp\omniweave-update.log"
function WaitLog($pattern, $secs) {
  $t = [Diagnostics.Stopwatch]::StartNew()
  while ($t.Elapsed.TotalSeconds -lt $secs) { if ((Test-Path $log) -and (Select-String -Path $log -Pattern $pattern -Quiet)) { return $true }; Start-Sleep -Milliseconds 500 }
  return $false
}
function KillApps {
  Get-Process | Where-Object { $_.Path -like "$d\app\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like "*app.omniweave.updatetest*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

try {
  # ---- B: wrong sha256
  Copy-Item builds\omniweave-0.2.0.exe $exe
  Manifest ("0" * 64)
  Say "B: start 0.2.0 with a latest.json whose sha256 is wrong"
  $p = Start-Process $exe -WindowStyle Hidden -PassThru
  $ok = WaitLog "portable download failed" 120
  Start-Sleep 2
  $same = (Get-FileHash $exe).Hash -eq (Get-FileHash builds\omniweave-0.2.0.exe).Hash
  Say "B: refused=$ok exe still 0.2.0=$same leftovers=$((Get-ChildItem app -Name) -join ',')"
  KillApps; Start-Sleep 2
  if (Test-Path $log) { Copy-Item $log "$d\tmp\B-update.log"; Remove-Item $log }

  # ---- A: the real thing
  Manifest $sha
  Say "A: start 0.2.0 with the correct latest.json"
  $p = Start-Process $exe -WindowStyle Hidden -PassThru
  Say "A: first pid $($p.Id)"
  $ok = WaitLog "v0\.2\.1 start 0\.2\.1" 180
  Say "A: 0.2.1 started=$ok"
  $null = WaitLog "portable\[\d+\]: removed .*\.new\.exe" 30
  Start-Sleep 3
  $now = (Get-FileHash $exe).Hash -eq (Get-FileHash builds\omniweave-0.2.1.exe).Hash
  $running = Get-Process | Where-Object { $_.Path -like "$d\app\*" } | ForEach-Object { "$($_.Id) $($_.Path)" }
  Say "A: same path now holds 0.2.1=$now; running: $($running -join '; '); files: $((Get-ChildItem app -Name) -join ',')"
}
finally {
  KillApps
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
}
"---- update log (B)"; Get-Content "$d\tmp\B-update.log" -ErrorAction SilentlyContinue
"---- update log (A)"; Get-Content $log -ErrorAction SilentlyContinue
"---- server log"; Get-Content server.log


