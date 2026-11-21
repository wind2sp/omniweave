# Local Windows release: produces exactly two files in ./release
#   Omniweave_<ver>_x64-setup.exe     one-file installer (per-user, no admin)
#   Omniweave_<ver>_x64-portable.exe  one-file portable app (no install, nothing written next to it)
# plus SHA256SUMS.txt. Run:  powershell -NoProfile -File scripts/release-win.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$v = (Get-Content package.json -Raw | ConvertFrom-Json).version
npm test
if ($LASTEXITCODE) { throw "tests failed" }
# updater artifacts must be signed with the private key kept outside the repo
$key = Join-Path $HOME ".tauri/omniweave.key"
if (-not (Test-Path $key)) { throw "signing key not found: $key (npx tauri signer generate --ci -w $key)" }
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $key -Raw
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" }
# no build-machine folders (C:\Users\<account>\.cargo\…) in the exe: scripts/rust-remap.mjs
$env:CARGO_ENCODED_RUSTFLAGS = node scripts/rust-remap.mjs
npx tauri build --bundles nsis
if ($LASTEXITCODE) { throw "tauri build failed" }
$rel = "release"
if (Test-Path $rel) { Remove-Item $rel -Recurse -Force }
New-Item -ItemType Directory $rel | Out-Null
$setup = Get-ChildItem "src-tauri/target/release/bundle/nsis/*.exe" | Select-Object -First 1
Copy-Item $setup.FullName "$rel/Omniweave_${v}_x64-setup.exe"
Copy-Item "src-tauri/target/release/omniweave.exe" "$rel/Omniweave_${v}_x64-portable.exe"
& "$rel/Omniweave_${v}_x64-portable.exe" --selftest | Out-Host
if ($LASTEXITCODE) { throw "selftest failed" }
$text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes("$rel/Omniweave_${v}_x64-portable.exe"))
if ([regex]::IsMatch($text, '[A-Za-z]:\\Users\\')) { throw "build-machine user paths in the exe" }
Get-ChildItem $rel -Filter *.exe | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
} | Set-Content "$rel/SHA256SUMS.txt" -Encoding ascii
Get-ChildItem $rel | Format-Table Name, @{n="MB";e={[math]::Round($_.Length/1MB,1)}}
