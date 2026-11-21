# Upload the website to the hosting through a WinSCP saved site (credentials stay in WinSCP, never here).
#   powershell -NoProfile -File scripts/deploy-site.ps1 [-Site gdra] [-Remote /www/omniweave] [-Url https://gdra.mycafe24.com/omniweave/] [-DryRun]
# - rebuilds the language pages, stages website/ without the source-only files, adapts .htaccess (404 path)
#   and config.json (siteUrl) to the sub-folder, backs up the remote folder, then synchronizes (upload only).
# - Publishing is public: run it only after the page was reviewed.
param(
  [string]$Site = "gdra",
  [string]$Remote = "/www/omniweave",
  [string]$Url = "https://gdra.mycafe24.com/omniweave/",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$winscp = @("${env:ProgramFiles(x86)}\WinSCP\WinSCP.com", "$env:ProgramFiles\WinSCP\WinSCP.com") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $winscp) { throw "WinSCP.com not found" }

node website/build-i18n.mjs
if ($LASTEXITCODE) { throw "build-i18n failed" }

$stage = Join-Path ([IO.Path]::GetTempPath()) "omniweave-site-stage"
$backup = Join-Path ([IO.Path]::GetTempPath()) ("omniweave-site-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
$skip = @("_templates", "i18n", "build-i18n.mjs", "README.txt")
Get-ChildItem website -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object { Copy-Item $_.FullName $stage -Recurse -Force }

$base = ([Uri]$Url).AbsolutePath
$ht = Join-Path $stage ".htaccess"
(Get-Content $ht -Raw) -replace "ErrorDocument 404 /404.html", "ErrorDocument 404 ${base}404.html" | Set-Content $ht -NoNewline -Encoding utf8
$cfg = Join-Path $stage "config.json"
(Get-Content $cfg -Raw) -replace '"siteUrl": ""', ('"siteUrl": "' + $Url + '"') | Set-Content $cfg -NoNewline -Encoding utf8

$preview = if ($DryRun) { "-preview" } else { "" }
$scr = Join-Path ([IO.Path]::GetTempPath()) "omniweave-site-sync.txt"
@"
open $Site
option batch abort
option confirm off
synchronize local "$backup" $Remote
synchronize remote $preview -criteria=size "$stage" $Remote
exit
"@ | Set-Content -Encoding utf8 $scr
New-Item -ItemType Directory $backup | Out-Null
& $winscp /script="$scr"
if ($LASTEXITCODE) { throw "WinSCP failed" }
Write-Host "remote backup: $backup"
foreach ($p in @("", "en/", "ja/", "zh/", "download.html")) {
  $code = (Invoke-WebRequest -Uri ($Url + $p) -Method Head -UseBasicParsing -SkipHttpErrorCheck).StatusCode
  Write-Host ("{0,-16} {1}" -f ($(if ($p) { $p } else { "/" })), $code)
}
