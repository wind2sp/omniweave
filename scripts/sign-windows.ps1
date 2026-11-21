# Windows code signing hook — Tauri calls this for every binary it bundles
# (bundle.windows.signCommand in src-tauri/tauri.conf.json). The app binaries are signed with src-tauri/ as the working
# directory, but NSIS signs the uninstaller from target/release/nsis/x64/, so the command looks for this script at both
# relative paths (a plain "-File ../scripts/..." missed it there and left uninstall.exe unsigned without failing the build).
#
# Signing is configured only through environment variables (CI secrets or your shell), never files
# in the repository. With nothing configured the build stays unsigned and prints a notice, so
# development builds keep working.
#
#   OMW_SIGN_MODE = pfx          OMW_SIGN_PFX (path to .pfx), OMW_SIGN_PFX_PASSWORD
#                 = thumbprint   OMW_SIGN_THUMBPRINT (certificate in the Windows store / USB token)
#                 = trusted      Azure Trusted Signing: OMW_SIGN_DLIB (Azure.CodeSigning.Dlib.dll),
#                                OMW_SIGN_METADATA (metadata.json with Endpoint / account / profile)
#   OMW_SIGN_TIMESTAMP           RFC 3161 timestamp URL (default http://timestamp.digicert.com)
#   OMW_SIGNTOOL                 explicit path to signtool.exe (otherwise found in the Windows SDK)

# The file may arrive split in several arguments (tauri.conf.json runs this through `powershell -Command`, which re-splits
# a path that contains spaces), so the remaining arguments are joined back into one path.
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$FileParts)
$File = $FileParts -join " "
$ErrorActionPreference = "Stop"

$mode = $env:OMW_SIGN_MODE
if (-not $mode) {
  Write-Host "[sign] unsigned build (OMW_SIGN_MODE not set): $File"
  exit 0
}

function Find-SignTool {
  if ($env:OMW_SIGNTOOL -and (Test-Path $env:OMW_SIGNTOOL)) { return $env:OMW_SIGNTOOL }
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path $kits) {
    $found = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\x64\\" } | Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  throw "signtool.exe not found — install the Windows SDK or set OMW_SIGNTOOL"
}

$signtool = Find-SignTool
$ts = if ($env:OMW_SIGN_TIMESTAMP) { $env:OMW_SIGN_TIMESTAMP } else { "http://timestamp.digicert.com" }
$common = @("sign", "/fd", "SHA256", "/tr", $ts, "/td", "SHA256", "/d", "Omniweave", "/du", "https://github.com/wind2sp/omniweave")

switch ($mode) {
  "pfx" {
    if (-not $env:OMW_SIGN_PFX) { throw "OMW_SIGN_PFX is not set" }
    $signArgs = $common + @("/f", $env:OMW_SIGN_PFX)
    if ($env:OMW_SIGN_PFX_PASSWORD) { $signArgs += @("/p", $env:OMW_SIGN_PFX_PASSWORD) }
  }
  "thumbprint" {
    if (-not $env:OMW_SIGN_THUMBPRINT) { throw "OMW_SIGN_THUMBPRINT is not set" }
    $signArgs = $common + @("/sha1", $env:OMW_SIGN_THUMBPRINT)
  }
  "trusted" {
    if (-not ($env:OMW_SIGN_DLIB -and $env:OMW_SIGN_METADATA)) { throw "OMW_SIGN_DLIB and OMW_SIGN_METADATA are required" }
    $signArgs = $common + @("/dlib", $env:OMW_SIGN_DLIB, "/dmdf", $env:OMW_SIGN_METADATA)
  }
  default { throw "unknown OMW_SIGN_MODE '$mode' (pfx | thumbprint | trusted)" }
}

# retry: timestamp servers occasionally time out
for ($i = 1; $i -le 3; $i++) {
  & $signtool @signArgs $File
  if ($LASTEXITCODE -eq 0) { break }
  if ($i -eq 3) { throw "signing failed: $File" }
  Start-Sleep -Seconds (5 * $i)
}
& $signtool verify /pa /q $File
if ($LASTEXITCODE -ne 0) { throw "signature verification failed: $File" }
Write-Host "[sign] signed: $File"
