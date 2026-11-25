# 오메 모바일: Android APK/AAB 빌드 (개발자 모드 없이, 새 PC에서도 저장소 그대로).
# tauri android build는 Rust 라이브러리(.so)를 jniLibs에 "심볼릭 링크"로 넣는데, Windows는 개발자 모드가 없으면 링크를
# 만들 수 없어 그 단계에서 멈춥니다(사용자 Windows 설정은 바꾸지 않음). 그래서:
#   1) tauri android build — 프런트 빌드, Kotlin 생성물, .so 컴파일까지 (링크 단계 실패는 예상된 것)
#   2) .so를 jniLibs/<abi>/에 "복사", tauri.conf.json(안드로이드 병합본)을 assets에 넣기
#   3) Gradle을 Rust 작업(rustBuild*)을 빼고 실행
# 사용: powershell -NoProfile -File scripts\android-build.ps1 -Targets x86_64[,aarch64,armv7] [-Release] [-Aab]
#   결과: 한 대상 = app/build/outputs/apk/<abi>/<debug|release>/, 여러 대상 = apk/universal/<debug|release>/
#   환경: OMW_ANDROID_ENV가 가리키는 파일, 없으면 저장소 폴더 옆의 android-env.ps1이 있으면 읽고, 없으면 JAVA_HOME·ANDROID_HOME·PATH(node·cargo·python)를 그대로 씀
param([string]$Targets = "x86_64", [switch]$Release, [switch]$Aab, [string]$Root = '', [string]$TargetDir = '')
$omwEnv = if ($env:OMW_ANDROID_ENV) { $env:OMW_ANDROID_ENV } else { Join-Path (Split-Path (Resolve-Path "$PSScriptRoot\..").Path -Parent) 'android-env.ps1' }
if (Test-Path $omwEnv) { . $omwEnv }
if (-not $Root) { $Root = (Resolve-Path "$PSScriptRoot\..").Path }
if (-not $TargetDir) { $TargetDir = "$Root\src-tauri\target" }
$root = $Root; $env:CARGO_TARGET_DIR = $TargetDir
# the project's own Tauri CLI (devDependency), not a copy installed elsewhere
$tauri = "$root\node_modules\.bin\tauri.cmd"
if (-not (Test-Path $tauri)) { "missing $tauri (npm ci first)"; "EXIT 1"; exit 1 }
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe" }
$android = "$root\src-tauri\gen\android"
Set-Location $root
# tauri android build writes src-tauri/Cargo.toml, gradlew, AndroidManifest.xml back with LF: .gitattributes keeps them LF;
# should it still leave a change with the same content (line ends, spacing only), that file is put back as it was —
# the release gate takes results only from a clean checkout
$git = if (Test-Path 'C:\Program Files\Git\cmd\git.exe') { 'C:\Program Files\Git\cmd\git.exe' } else { 'git' }
function Restore-Untouched {
  # every tracked file of src-tauri the build wrote back (Cargo.toml, gradlew, AndroidManifest.xml, ...)
  foreach ($f in @(& $git -C $root diff --name-only -- src-tauri)) {
    if (-not $f) { continue }
    & $git -C $root diff --quiet --ignore-all-space --ignore-cr-at-eol -- $f 2>$null
    if ($LASTEXITCODE -eq 0) { & $git -C $root checkout -- $f; "put back $f (only line ends / spacing changed)" }
    else { "NOTE: $f has real changes after the build - left as is:"; & $git -C $root --no-pager diff --ignore-cr-at-eol -- $f }
  }
}
$map = @{
  'aarch64' = @{ triple = 'aarch64-linux-android'; abi = 'arm64-v8a'; arch = 'Arm64' }
  'armv7'   = @{ triple = 'armv7-linux-androideabi'; abi = 'armeabi-v7a'; arch = 'Arm' }
  'i686'    = @{ triple = 'i686-linux-android'; abi = 'x86'; arch = 'X86' }
  'x86_64'  = @{ triple = 'x86_64-linux-android'; abi = 'x86_64'; arch = 'X86_64' }
}
$list = @($Targets.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$prof = if ($Release) { 'release' } else { 'debug' }
$Prof = if ($Release) { 'Release' } else { 'Debug' }

# 1) tauri android build, one target at a time (the CLI stops at the first target's link step)
foreach ($t in $list) {
  $a = @('android', 'build', '--ci', '--target', $t)
  if (-not $Release) { $a += '--debug' }
  if ($Aab) { $a += '--aab' } else { $a += '--apk' }
  $out = & $tauri @a 2>&1 | ForEach-Object { "$_" }
  $out
  $code = $LASTEXITCODE
  Restore-Untouched
  if ($code -eq 0 -and $list.Count -eq 1) { "EXIT 0"; exit 0 }
  if ($code -ne 0 -and -not ($out -match 'symbolic link')) { "EXIT $code (not the symlink step)"; exit $code }
}

# 2) copy the libraries, write the merged config asset
foreach ($t in $list) {
  $m = $map[$t]
  $so = "$TargetDir\$($m.triple)\$prof\libomniweave_lib.so"
  if (-not (Test-Path $so)) { "missing $so"; "EXIT 1"; exit 1 }
  $dst = "$android\app\src\main\jniLibs\$($m.abi)"
  New-Item -ItemType Directory -Force $dst | Out-Null
  Copy-Item $so "$dst\libomniweave_lib.so" -Force
  "copied $so -> $dst"
}
$py = @"
import json, os
root = r'$root'
base = json.load(open(os.path.join(root, 'src-tauri', 'tauri.conf.json'), encoding='utf-8'))
over = json.load(open(os.path.join(root, 'src-tauri', 'tauri.android.conf.json'), encoding='utf-8'))
def merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict): merge(a[k], v)
        else: a[k] = v
merge(base, over)
d = os.path.join(r'$android', 'app', 'src', 'main', 'assets')
os.makedirs(d, exist_ok=True)
json.dump(base, open(os.path.join(d, 'tauri.conf.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print('wrote assets/tauri.conf.json')
"@
$py | & $python -I -

# 3) Gradle without the Rust tasks
Set-Location $android
$skip = @()
foreach ($t in $list) { $skip += @('-x', "rustBuild$($map[$t].arch)$Prof") }
if ($list.Count -eq 1) {
  $arch = $map[$list[0]].arch
  $task = if ($Aab) { "bundle$arch$Prof" } else { "assemble$arch$Prof" }
} else {
  $task = if ($Aab) { "bundleUniversal$Prof" } else { "assembleUniversal$Prof" }
  $skip += @('-x', "rustBuildUniversal$Prof")
  $skip += "-PabiList=$((($list | ForEach-Object { $map[$_].abi }) -join ','))"
  $skip += "-ParchList=$((($list | ForEach-Object { $map[$_].arch.ToLower() }) -join ','))"
  $skip += "-PtargetList=$($list -join ',')"
}
& .\gradlew.bat $task @skip --console=plain 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
Restore-Untouched
"EXIT $code"
