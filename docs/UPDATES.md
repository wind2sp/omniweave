# 자동 업데이트 — 채널별 방식과 설계 (2026-11-22)

제품 요구: "GitHub 배포, MS Store 배포 모두 자동 업데이트 방식으로. GitHub에 올라간 걸 확인하면 자동 업데이트가 진행."
기존 Tauri updater를 유지하고, 사내 다른 프로젝트(exe 자동 업데이트 공용 방식: version.json + exe 바꿔치기)의 장점을 맞춘다.
**첫 공개판 0.2.0부터** 세 채널 모두 들어 있다(나중에 넣으면 이미 깔린 판은 손으로 바꿔야 하므로).

| 채널 | 누가 업데이트 | 확인 주소 | 상태 |
|---|---|---|---|
| GitHub 설치본(NSIS) | 앱(Tauri updater) | `github.com/wind2sp/omniweave/releases/latest/download/latest.json` | 구현됨 |
| GitHub 포터블 exe | 앱 — 받아서 검사 후 **같은 경로·같은 이름으로 바꿔치기**(`src-tauri/src/portable.rs`) | 같은 주소(`portable` 항목) | 구현됨(4장), 두 판으로 끝까지 재현(5장) |
| Microsoft Store(MSIX) | Store | — (앱 updater 꺼짐, `is_store_package`) | 구현됨, 메뉴·정보 창에 'Microsoft Store가 업데이트' 문구, 자동 제출(`store-submit.yml`) |

## 1. 공용 방식과 맞춘 점

| 공용 방식 | 오메 |
|---|---|
| 시작 후 확인 + 날짜가 바뀌면 하루 한 번 | 시작 4초 뒤 + **6시간마다**(하루 4번, 날짜 변경 확인보다 촘촘함 — 동등 이상). 실패하면 30초·10분 뒤 재시도 |
| version.json: version·date·important·notes·files(size·sha256) | `latest.json`: version·pub_date·notes·platforms(설치본 url·**minisign 서명**) + `portable.windows-x86_64`(url·**size·sha256**·서명). important는 아래 2장 |
| 바뀐 내용 보여 주고 묻기 | 백그라운드로 받아 검사한 뒤 제목 줄 알림 → 누르면 **'새 버전 X' 창**(지금 → 새 버전, 바뀐 내용 목록, 나중에 / 지금 업데이트). 저장 안 한 문서가 있으면 먼저 묻는다 |
| important면 바로 묻고 빨간 글씨 | 노트 첫 줄 `[중요]`/`[important]` → 받자마자 그 창을 바로 열고, 알림·창을 위험 색(빨강)으로, '중요' 표시와 안내 문장(4개 언어) |
| 받은 파일 크기·SHA-256 확인 후 교체 | 설치본: 받으면서 서명 검증. 포터블: 크기·SHA-256·**서명**(같은 updater 공개 키) 모두 맞아야 함 |
| 새 exe `--selftest` | 포터블: 받은 `<이름>.new.exe --selftest`(창 없이, 2분 제한)가 0으로 끝나야 바꿈. 릴리스 빌드(CI)에서도 `--selftest` + exe 경로 검사 |
| `--finish-update`로 같은 경로·같은 이름에 바꿔치기 후 재실행 | 포터블: 그대로(4장). 설치본: NSIS가 같은 폴더에 덮어 설치 후 재실행 |
| 업데이트 뒤 첫 실행 확인 | 매 시작에 `%TEMP%\omniweave-update.log`에 `v<버전> start <버전>` 기록 → 업데이트 직후 새 버전이 떴는지 남음 |
| 남은 임시 파일 정리 | 설치본: Tauri updater가 임시 폴더에서 설치 후 지움. 포터블: 다음 실행이 `.new.exe`·`.exe.old`를 지움(닫히는 중이면 0.5초씩 10초까지) |
| exe 먼저, version.json 마지막 | release.yml이 포터블 exe를 올린 뒤 latest.json에 포터블 항목을 넣어 다시 올림. 게다가 초안 릴리스라 **Publish** 전에는 `releases/latest`가 바뀌지 않음 |
| 홈페이지가 version.json을 읽어 표시 | 홈페이지 `download.html`이 `website/config.json`의 버전을 씀. latest.json 직접 읽기는 GitHub 자산이 브라우저에서 CORS로 막힐 수 있어 Pages에 사본을 두는 방식 검토(남은 일) |

## 2. 중요 업데이트(important)

- 릴리스 노트 첫 줄에 `[중요]` 또는 `[important]`(대소문자 무관)를 쓰면 중요 업데이트다(latest.json 형식을 바꾸지 않음 — tauri-action이 노트를 그대로 넣음).
  표식 자체는 화면에 보이지 않는다(`src/ui/shell/updateNotes.ts` `parseNotes`).
- 앱: 받아서 검사가 끝나면 '새 버전' 창을 바로 연다. 제목 옆 '중요' 표시, 빨간 안내 문장 "중요 업데이트입니다. 되도록 바로 업데이트해 주세요."(ko·en·zh·ja),
  제목 줄 알림도 빨강. 평소 업데이트는 알림만 띄우고 누를 때 창을 연다.

## 3. Microsoft Store

- Store 판은 MSIX라 앱이 자기를 바꿀 수 없다(정책). Store가 업데이트한다. 앱은 업데이트 확인을 하지 않는다(`storeBuild.ts`, Rust `portable_update_*`도 거절).
- 도움말 메뉴의 '업데이트 확인' 자리에 **'업데이트: Microsoft Store'**(누르면 "업데이트는 Microsoft Store가 합니다"), 정보 창에
  "이 판은 Microsoft Store에서 설치되어 Microsoft Store가 업데이트합니다" — 4개 언어, 상표는 지명 사용으로 'Microsoft Store'만(™·로고 없음).
- 릴리스 Publish → `.github/workflows/store-submit.yml`이 그 릴리스의 포터블 exe(같은 빌드, SHA-256·selftest 확인)를 MSIX로 묶어
  Microsoft Store CLI(`msstore publish`, `microsoft/setup-msstore-cli` — 커밋 SHA로 고정)로 제출(마지막 게시 제출 기준으로 패키지 교체).
  비밀값(`PARTNER_CENTER_*` 네 개)이 없거나 사전 릴리스면 건너뛴다.
- 비밀값·앱 등록: `docs/STORE_AUTO_SUBMIT_GUIDE.md`. 첫 제출은 손으로(`docs/STORE_SUBMIT_GUIDE.md`).

## 4. 포터블 exe 바꿔치기 (구현: `src-tauri/src/portable.rs`, UI `src/ui/shell/UpdateBanner.tsx`)

1. **release.yml**: 포터블 exe를 올린 뒤 `tauri signer sign`(updater 비밀 키)으로 서명하고, latest.json에
   `"portable": {"windows-x86_64": {"url", "size", "sha256", "signature"}}`를 넣어 다시 올린다(`.sig`도 함께).
2. **앱(포터블로 판정 = exe 옆에 uninstall.exe 없음)**: 새 판을 찾으면 `portable_update_download` —
   폴더에 쓸 수 있는지 확인(못 쓰면 `no-write` → 다운로드 페이지 안내) → exe 옆에 `<이름>.new.exe`로 받기(Rust reqwest, 브라우저가 아니라 Mark of the Web 없음,
   https만 — 시험용으로 127.0.0.1만 http 허용) → **크기·SHA-256·서명** → `<이름>.new.exe --selftest`(CREATE_NO_WINDOW). 하나라도 틀리면 받은 파일을 지우고 다운로드 페이지 안내.
3. 사용자가 '지금 업데이트'(중요하면 바로 묻기) → 저장 확인 → `portable_update_finish`: `<이름>.new.exe --finish-update "<지금 exe>" <pid>`(CREATE_NO_WINDOW)를 띄우고 앱 종료.
4. **`--finish-update`**(`run()` 맨 앞, 창·플러그인보다 먼저): pid 종료를 기다림(최대 60초) → 지금 exe를 `<이름>.exe.old`로 옮기고 자기를 같은 경로·같은 이름으로 복사
   (잠겨 있으면 0.5초씩 30초까지, 복사가 끝내 실패하면 `.old`를 되돌려 예전 판을 실행) → 실행.
5. **다음 실행**: `.new.exe`·`.exe.old`를 지움(`.new.exe`로 실행 중이면 건너뜀, Store 패키지면 건너뜀).
- 파일 이름에 버전이 있어도(`Omniweave_0.2.0_x64-portable.exe`) 이름은 그대로 둔다 — 바로가기·작업 표시줄 고정·연결 프로그램이 유지되도록(공용 방식과 같음).
- 단계마다 `%TEMP%\omniweave-update.log`에 `portable[<pid>]: …` 줄을 남긴다.
- QA: 환경 변수 `OMW_UPDATE_QA=1` = `--update-test`(바로 확인, 누르지 않고 업데이트) + 창 숨김. 인자와 달리 바꿔치기 뒤 재실행까지 이어진다.
  **디버그 빌드와 식별자가 다른 시험 빌드(pp.omniweave.updatetest)에서만** 듣는다 — 배포판(pp.omniweave.studio)은 이 변수를 무시한다(update_qa_allowed, cargo test).

## 5. 시험 기록

- 단위: `cargo test`(이름 규칙, 바꿔치기·`.old` 보관·정리, **잠긴 exe를 기다렸다가** 바꾸기, 원본이 없으면 예전 판 유지, `.new.exe`에서는 정리 안 함,
  크기·SHA-256·서명 각각 틀리면 거절(같은 크기·맞는 SHA-256이라도 서명이 틀리면 거절), selftest 종료 코드, https·로컬만 허용, 로컬 서버에서 받기).
  시험용 키는 이 시험만을 위해 만든 일회용 공개 키와 서명(`src-tauri/testdata/`, 비밀 키는 저장소에 없음).
- UI: `tests/updateFlow.test.ts`(노트·중요 표식, latest.json 포터블 항목 검사, 포터블 받기→준비→바꿔치기 호출, 중요면 바로 묻기, 쓰기 불가·검사 실패·항목 없음이면 페이지 안내,
  설치본은 Tauri updater 경로, release.yml 순서), `tests/storeBuild.test.ts`(Store 판은 확인 안 함).
- 끝까지 재현(2026-11-22, `scripts/portable-update-e2e.ps1`): 실제 포터블 빌드 두 개(0.2.0·0.2.1, 시험용 식별자·일회용 키, nosign),
  GitHub 대신 127.0.0.1 서버. 결과:
  - B(latest.json의 sha256이 틀림): 0.2.0이 0.2.1을 찾고(`[important]` 표식 인식) 받은 뒤 `check failed: sha256 … expected 000…` → 받은 파일 삭제, exe 그대로(해시 같음), 다운로드 페이지 안내.
  - A(정상): 시작 → 확인(0.2.1, 중요) → 받기 20.6 MB → 크기·SHA-256·서명·selftest 통과 → `--finish-update` 시작·앱 종료 → pid 종료 대기 →
    같은 경로·같은 이름에 바꿔치기 → 재실행 → 새 프로세스가 `.new.exe`·`.exe.old` 삭제 → `v0.2.1 start 0.2.1` → 다시 확인 "none". 전체 약 3초,
    폴더에는 원래 이름의 exe 하나만 남고 해시가 0.2.1 빌드와 같음.
  - 설치본 쪽: 같은 서버로 0.2.0 `--update-check` → `available version=0.2.1`(Tauri updater가 latest.json을 읽음). NSIS 설치 자체는
    Claude Desktop(패키지) 안에서 시험하지 않는다는 원칙대로 하지 않음 — 설치 경로는 기존 Tauri updater 그대로.
- 이 재현 중 찾은 출시 차단 결함(고침): `src/io/formats/sniff.ts`가 작은 청크로 빌드되는데 첫 1 KB 안의 `%PDF-` 글자 때문에 데스크톱 앱의
  자산 서버(Tauri, 내용으로 형식 추측)가 이 스크립트를 `application/pdf`로 보내 모듈 로드가 실패 → **앱이 시작 화면에서 멈춤**
  (origin/release-prep 그대로의 Rust 코드로 빌드해도 같음). 바이트 비교로 바꾸고, 같은 일이 다시 생기면 빌드가 멈추게 `vite.config.ts` `sniffGuard` 추가
  (`tests/sniffGuard.test.ts`).
