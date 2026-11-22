# 릴리스와 자동 업데이트

설치본으로 설치한 Omniweave는 실행 4초 뒤와 6시간마다 GitHub Releases의 최신 버전을 확인하고,
새 버전이 있으면 백그라운드로 받아 서명을 검증한 뒤 제목 줄 오른쪽에 작은 알림을 띄웁니다. 누르면 바뀐 내용을 보여 주고 묻고,
**지금 업데이트**를 누르면 조용히 설치한 뒤 앱을 다시 엽니다. 노트 첫 줄이 `[중요]`면 바로 묻습니다. 사용자는 exe를 다시 내려받을 필요가 없습니다.

- **포터블 exe**도 스스로 업데이트합니다: 옆에 `<이름>.new.exe`로 받아 크기·SHA-256·서명·`--selftest`를 확인한 뒤 같은 경로·같은 이름으로 바꿔치기하고 다시 엽니다
  (설치본이 따로 생기지 않음). 폴더에 쓸 수 없거나 검사가 실패하면 다운로드 페이지를 안내합니다. 자세한 방식과 시험 기록: `docs/UPDATES.md`.
- **Microsoft Store 판**은 Store가 설치·업데이트합니다. 앱은 패키지 안에서 실행 중인지 스스로 알아내고(`is_store_package`),
  그때는 업데이트 확인·알림을 끄고, 도움말 메뉴·정보 창에 'Microsoft Store가 업데이트합니다'를 보여 줍니다(`src/ui/shell/storeBuild.ts`, `packaging/msix/README.md`).

## 동작 원리

1. 태그 `vX.Y.Z`를 푸시하면 `.github/workflows/release.yml`이 Windows 파일과
   `latest.json`(버전·노트·다운로드 URL·서명)을 **초안 릴리스**에 올립니다. macOS·Linux는 실기 확인 전이라 아직 빌드하지 않습니다.
2. 초안을 검토하고 **Publish**하면 `releases/latest/download/latest.json`이 새 버전을 가리킵니다.
3. 앱은 `tauri.conf.json`의 `plugins.updater.endpoints`에서 이 파일을 읽고, `pubkey`로 서명을 검증한 뒤에만 설치합니다.
   서명이 맞지 않는 파일은 설치하지 않습니다.

## 처음 한 번 설정

- 업데이트 서명 키: 비밀 키 파일(저장소에 넣지 않음)과 공개 키(`tauri.conf.json`의 `pubkey`). 비밀 키를 잃어버리면
  이미 설치된 앱에 업데이트를 보낼 수 없으니 안전한 곳에 백업합니다.
- GitHub 저장소 Settings → Secrets and variables → Actions에 등록(초보자용 단계: `docs/GITHUB_PUBLISH_GUIDE.md`):
  - `TAURI_SIGNING_PRIVATE_KEY` = 비밀 키 파일의 내용 전체(설치본과 포터블 exe 서명에 같이 씀)
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = 키를 만들 때 정한 암호
- OCR 모델(`ppocr-det.lwt`, `ppocr-rec-ko.lwt`, 4.9 MB, Apache-2.0)은 git(`public/models/ocr`)에 들어 있어 따로 올릴 것이 없습니다.
  빌드마다 `scripts/ocr-models.mjs`가 매니페스트의 sha256과 맞는지 확인합니다(예전 `OMW_OCR_MODELS_RELEASE` 비밀값·모델 릴리스는 필요 없음).
- 비밀값은 저장소·이슈·메시지에 적지 않습니다.

## 버전 규칙

- 첫 공개 판은 **0.2.0**입니다. 공개 전 시험 채널에 0.1.13까지 나갔으므로 그보다 낮은 번호는 쓰지 않습니다
  (`scripts/release.mjs`가 막습니다. 설치된 앱은 더 높은 번호로만 업데이트합니다).

| 종류 | 언제 | 버전 |
|---|---|---|
| 긴급 수정(hotfix) | 데이터 손실·크래시·보안 문제를 고치면 **바로** | patch (0.2.0 → 0.2.1) |
| 수정 묶음 | 사용자 보고 수정이 몇 개 모이면 | patch |
| 기능 | 새 기능이 QA를 통과하면 | minor (0.2 → 0.3) |
| 베타 | 큰 기능을 미리 시험받을 때 | `0.3.0-beta.1` — GitHub 사전 릴리스, **자동 업데이트 대상 아님** |

**릴리스 관문(모두 통과해야 태그)**: 코드 QA 검수 통과 → `npx tsc --noEmit` 0 오류 → `npm test` 전부 통과 →
설치본 `--selftest` 통과 → 실무 샘플 열기 결과가 이전 릴리스보다 나빠지지 않음 → exe에 빌드 PC 경로(`C:\Users\…`) 0개.

평소에는 `CHANGELOG.md`의 `## [Unreleased]` 아래에 바뀐 점을 적어 둡니다(비어 있으면 커밋 제목으로 초안을 만듭니다).

## 새 버전 내기 (GitHub Actions — 기본)

```bash
npm run release -- patch            # 또는 minor / major / 0.3.0-beta.1, --date YYYY-MM-DD|none
```
버전 5곳(package.json·tauri.conf.json·Cargo.toml·Cargo.lock·website/config.json)과 CHANGELOG를 한 번에 맞추고 커밋·태그 명령을 알려 줍니다.
태그를 푸시하면 Actions가 빌드해 **초안 릴리스**로 올립니다. 설치본을 직접 설치·실행해 본 뒤 Publish하면 설치된 앱들이 업데이트됩니다.
**공식 판은 CI 빌드만 배포합니다.** 코드 서명은 `docs/CODE_SIGNING.md`.

## 대안: 로컬에서 빌드·서명해 올리기

CI를 쓸 수 없을 때만 씁니다. 결과 파일 이름·`latest.json` 형식은 CI와 같아야 합니다.

1. 깨끗한 작업 폴더에서 `npm ci`, `npx tsc --noEmit`, `npm test`.
2. 서명 키 암호는 **암호 파일(DPAPI로 이 PC 사용자 계정에 묶어 암호화한 파일)에서 풀어 환경변수
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`로만** 넘깁니다. 화면·파일·명령 기록에 평문으로 남기지 않고, 끝나면 그 환경변수를 지웁니다.
   비밀 키 파일 경로는 `TAURI_SIGNING_PRIVATE_KEY`(내용) 또는 스크립트가 읽는 기본 위치로 줍니다.
3. `powershell -NoProfile -File scripts/release-win.ps1` → `release/`에 설치본·포터블·SHA256SUMS.txt가 생깁니다.
   스크립트가 빌드 PC 경로를 exe에서 빼고(`scripts/rust-remap.mjs`), `--selftest`와 경로 검사를 합니다.
4. `src-tauri/target/release/bundle/nsis/`의 설치본 `.sig` 내용으로 `latest.json`을 만듭니다
   (`{"version","notes","pub_date","platforms":{"windows-x86_64":{"signature","url"}}}`, url은 `releases/download/vX.Y.Z/` 아래 설치본).
   포터블 exe도 `npx tauri signer sign <포터블 exe>`로 서명하고 `"portable":{"windows-x86_64":{"url","size","sha256","signature"}}`를 넣습니다
   (없으면 포터블은 스스로 바꾸지 않고 다운로드 페이지만 안내합니다). 형식은 `release.yml`의 포터블 단계와 같게.
5. GitHub에서 태그 `vX.Y.Z`로 **초안** 릴리스를 만들고 설치본·포터블·SHA256SUMS.txt·latest.json을 올린 뒤, 직접 설치해 확인하고 Publish합니다.

## 빌드 PC 경로를 exe에 남기지 않기

Rust는 패닉 위치로 원본 파일 경로를 실행 파일에 넣습니다. 그대로 빌드하면 `C:\Users\<계정>\.cargo\registry\…`가 들어갑니다.
`release.yml`과 `scripts/release-win.ps1`은 `--remap-path-prefix`로 cargo·rustup 폴더와 작업 폴더를 `/cargo`·`/rustup`·`/omniweave`로 바꿉니다
(`CARGO_ENCODED_RUSTFLAGS`, `scripts/rust-remap.mjs`). 직접 `tauri build`할 때도 같은 값을 넣으세요:
```powershell
$env:CARGO_ENCODED_RUSTFLAGS = node scripts/rust-remap.mjs; npx tauri build
```

## Microsoft Store 판

릴리스를 **Publish**하면 `.github/workflows/store-submit.yml`이 그 릴리스의 포터블 exe(같은 빌드)를 MSIX로 묶어 Store에 자동 제출합니다(Microsoft Store CLI `msstore`, 비밀값 `PARTNER_CENTER_TENANT_ID`·`_CLIENT_ID`·`_CLIENT_SECRET`·`_SELLER_ID`가 없거나 사전 릴리스면 건너뜀, 첫 제출은 손으로). 채널별 업데이트 방식은 `docs/UPDATES.md`.

`node scripts/make-msix.mjs` → `release/Omniweave-X.Y.Z.0.msix`(서명 없음 — Store가 서명). 매니페스트·아이콘·언어별 이름과
설치해 보는 방법은 `packaging/msix/README.md`, 등록 문구는 `packaging/msix/store_listing/`.

## 업데이트 확인 실패를 볼 때

- 기록: `%TEMP%\omniweave-update.log`. 확인 실패 줄 끝 `[…]`에 원인 단서와 다음 재시도 시각이 붙습니다.
  조용한 확인(시작 4초·6시간마다)이 실패하면 **30초 → 10분 뒤 다시** 확인한 뒤 6시간 주기로 돌아갑니다.
- `omniweave.exe --update-check`: 창 없이 업데이트 주소에 물어 결과를 `%TEMP%\omniweave-update-check.txt`에 쓰고 끝납니다.
- 재시작 인자: 설치 프로그램(`/R /ARGS …`)이 앱을 다시 띄울 때 `--update-test`는 빼고 넘깁니다.
- 포터블: 기록에 `portable[<pid>]: …` 줄(받기·검사·`--finish-update`·바꿔치기·정리)이 남습니다. 환경 변수 `OMW_UPDATE_QA=1`이면
  창 없이 바로 확인하고 누르지 않고 업데이트합니다(재실행까지 이어짐 — 시험 전용, 디버그·시험 식별자 빌드에서만 듣고 배포판은 무시).

## 배포 채널

| 플랫폼 | 배포·업데이트 | 상태 |
|---|---|---|
| Windows | GitHub 릴리스 + 자동 업데이트(설치본: Tauri updater, 포터블: exe 바꿔치기) | 0.2.0부터 |
| Windows (Store) | Microsoft Store가 배포·업데이트, 앱 안 updater 꺼짐 | 준비 중 |
| macOS | 같은 updater. `latest.json`에 `darwin-aarch64`·`darwin-x86_64` 항목 추가 | Mac 빌드 PC·Apple 공증 필요 |
| Linux | 같은 updater. `linux-x86_64`(AppImage) 항목 | 실기 확인 뒤 |
| 웹 | 아래 '웹판 업데이트' | 데스크톱 완성 뒤 |

- 안내 파일은 하나(`latest.json`)이고, `platforms` 표에 OS·CPU별 항목(서명·받을 주소)이 따로 있습니다. 앱은 자기 OS 항목만 읽습니다.
- 한 OS만 새로 낼 때는 그 OS 항목만 바꿉니다.

### 웹판 업데이트
웹판은 설치가 없습니다. "업데이트" = 서버에 새 빌드를 올리고, 열려 있는 탭이 안전하게 새 판으로 넘어가는 것.

1. 파일 이름에 내용 해시를 붙이고(Vite 기본) `index.html`과 `version.json`만 캐시하지 않습니다. 옛 해시 파일은 최소 2개 판 동안 남깁니다.
2. 서비스 워커가 새 빌드를 미리 받고, 시작 시와 6시간마다 `version.json`을 확인합니다.
3. 데스크톱과 같은 알림으로 **"새로 고쳐서 업데이트"**를 보여 주고, 저장하지 않은 문서를 묻습니다(자동 저장 저널에서 이어 열기).
4. `version.json`의 `minOmwReader`로 옛 탭이 새 형식 `.omw`를 덮어쓰지 않게 경고합니다.
5. `/app/`(정식)과 `/app-beta/`(시험) 두 경로. 정식은 시험에서 확인한 빌드를 그대로 복사합니다.
6. 서버의 `index.html`을 직전 판으로 바꾸면 즉시 되돌아갑니다.

**지금 된 것(2026-11-22, GitHub Pages `/omniweave/app/`):** 빌드가 `version.json`(`version`·`build`=입구 스크립트 이름·`date`)을
함께 만들고(vite.config.ts `webVersion`), 앱이 시작 10초 뒤·6시간마다·탭으로 돌아올 때(30분 간격) `cache: "no-store"`로 읽어
입구 스크립트가 다르면 제목 줄에 **"새로 고쳐서 업데이트"**를 띄웁니다(src/ui/shell/WebUpdate.tsx). 새 배포로 옛 지연 로딩 파일이
사라져 기능을 못 불러오면(`vite:preloadError`) 같은 알림과 안내를 냅니다. 저장 안 한 내용은 새로 고친 뒤 자동 저장 복구로 돌아옵니다.
아직 안 된 것: 옛 해시 파일 보존(Pages는 배포마다 사이트 전체를 바꿈), `minOmwReader`, `/app-beta/`.

**홈 화면 앱·오프라인(PWA, 2026-11-22):** iPhone은 App Store 대신 웹판을 사파리 '홈 화면에 추가'로 씁니다(대표님 결정).
웹 빌드(`OMW_WEB=1`, Pages 워크플로가 켬 — 데스크톱 빌드·설치본에는 하나도 안 들어감)가 `scripts/web-pwa.mjs`로
`manifest.webmanifest`·`icons/`(192·512·maskable·apple-touch-icon·iPhone 시작 그림, `assets/make_icon.py --web`)·`sw.js`를 만들고
head에 iOS 태그를 넣습니다. 앱은 브라우저에서만 서비스 워커를 등록합니다(`src/web/pwa.ts`, Tauri·개발 서버·http는 안 함).
- 빌드마다 캐시 `omw-shell-<입구 스크립트>`에 껍데기(스크립트·CSS·UI 글꼴·pdf.js 자료·아이콘, 약 16 MB)를 **전부** 받아야 설치 완료.
  `index.html`이 다른 빌드(Pages 10분 캐시)면 설치 실패 → 다음 확인 때 다시. 페이지는 이 캐시에서 엽니다(오프라인·빠른 시작).
- AI 모델(`models/**`, `*.lwt`)은 처음 쓸 때 `omw-models-<모델 파일 해시>`에 저장(모델이 같으면 업데이트 뒤에도 유지). `version.json`·`sw.js`는 캐시 안 함.
- **업데이트:** 새 `sw.js`가 새 빌드를 뒤에서 받고 **기다립니다**(자동 skipWaiting 없음 — 열린 탭이 자기 빌드 파일을 계속 씀).
  준비되면(또는 `version.json`이 새 빌드를 알리면) 기존 **"새로 고쳐서 업데이트"**가 뜨고, 누르면 `SKIP_WAITING` → 새 워커가 넘겨받은 뒤 새로 고침.
  그냥 새로 고침만 하면 옛 빌드가 다시 나오므로 이 단추가 넘김을 맡습니다(20초 안에 준비 안 되면 그냥 새로 고침). 앱 창을 모두 닫았다 열어도 넘어갑니다.
  첫 설치만 바로 넘겨받습니다. 새 워커가 켜지면 옛 `omw-` 캐시를 지웁니다.
- **갇힘 방지:** `sw.js`는 HTTP 캐시를 건너뛰어 받고(`updateViaCache: "none"`), 문제가 생기면 주소 끝에 `?sw=off`를 붙여 열면 워커와 캐시를 모두 지우고 네트워크에서 엽니다.
- 설치된 데스크톱 Chrome·Edge에서는 파일 연결(`file_handlers` → `launchQueue`)로 .omw·PDF·DOCX·HWPX… 를 탭으로 엽니다.
- iPhone: 파일 열기는 형식 제한 없이 고름(사파리가 .omw·.hwpx를 회색으로 막음), 저장·내보내기는 공유 시트('파일에 저장'), 큰 파일 메모리 안내.
Pages는 모든 파일에 `Cache-Control: max-age=600`을 주고 헤더를 바꿀 수 없어서 1번의 `index.html` no-cache는 못 합니다(최대 10분 늦게 보임).

## .omw 형식 호환 정책

**정식 배포 이후에는 어떤 버전에서도 .omw 파일이 '안 열리는' 일이 없어야 합니다.**

1. **새 앱은 모든 옛 판을 엽니다.** 옛 판 고정 파일을 시험에 두고, 판마다 열기 시험을 유지합니다.
2. **옛 앱도 새 파일을 열 수 있어야 합니다.** 형식을 바꿀 때는 옛 앱이 읽는 표현을 함께 저장하고, 옛 앱은 모르는 부분을 버리지 않고
   '새 버전에서 만든 내용 일부를 표시하지 못함'으로 알립니다.
3. **컨테이너 판을 올리는 시점:** 자동 업데이트로 앞 판이 충분히 보급된 뒤에만 올립니다.
4. **릴리스 체크리스트:** 직전 두 개 정식 버전의 실행 파일로 새 버전이 저장한 .omw를 열어 보는 '버전 교차 열기 시험'을 통과해야 배포합니다.
