# Microsoft Store용 MSIX

GitHub 릴리스와 같은 `omniweave.exe`를 MSIX 패키지 하나로 묶습니다. 설치본(NSIS)·포터블 빌드는 바뀌지 않습니다.

## 만들기

```powershell
$env:CARGO_ENCODED_RUSTFLAGS = node scripts/rust-remap.mjs   # 빌드 PC 경로를 exe에 남기지 않기
npx tauri build --no-bundle                                  # <target>\release\omniweave.exe
node scripts/make-msix.mjs                                   # release\Omniweave-<버전>.0.msix
```

- 필요: Windows 10/11 SDK의 `makeappx.exe`·`makepri.exe`(`C:\Program Files (x86)\Windows Kits\10\bin\<버전>\x64`), Pillow가 있는 Python
  (`OMW_PYTHON`으로 지정 가능 — 아이콘은 `assets/make_icon.py --msix`가 그림).
- 패키지 버전은 package.json 버전 뒤에 `.0`(0.2.0 → 0.2.0.0). Store는 네 번째 자리가 0이어야 합니다.
- 중간 결과는 `release\msix-work\`(`layout\` = 패키지에 들어가는 그대로, `pri\` = 아이콘·언어별 문구).
- 서명하지 않습니다. Store에 올리면 Microsoft가 서명합니다.
- 옵션: `--exe <경로>`, `--out <폴더>`, `--name`·`--publisher`·`--publisher-display-name`(store_identity.json 대신).

### 들어가는 것

| 위치 | 내용 |
|---|---|
| `AppxManifest.xml` | `AppxManifest.template.xml`에 이름·게시자·버전을 채운 것 |
| `Omniweave\` | `omniweave.exe`(웹 자원이 exe 안에 있음), LICENSE·NOTICE·THIRD_PARTY_NOTICES.md |
| `Assets\` | 앱 아이콘에서 그린 타일·로고(배율 100/125/150/200/400, 작업 표시줄·탐색기용 16~256). 40px 이하는 작은 크기용 단순한 그림 |
| `resources.pri` | 아이콘 배율 선택과 언어별 표시 이름·설명·파일 형식 이름(ko-KR 기본, en-US, ja-JP, zh-CN — `scripts/make-msix.mjs` STRINGS) |

### 매니페스트 요점

- 최소 Windows 10 2004(10.0.19041). 화면은 Windows의 WebView2(Evergreen)로 그립니다.
- 권한은 `runFullTrust` 하나(일반 데스크톱 앱으로 실행).
- 파일 연결(`uap:FileTypeAssociation`): `.omw`, 문서·표·슬라이드·PDF(`.docx .doc .hwpx .hwp .pptx .ppt .xlsx .xls .csv .pdf`),
  이미지·벡터·도면(`.psd .ai .svg .dxf .dwg`). '연결 프로그램'에 나타날 뿐 기본 프로그램을 바꾸지 않습니다.
- **업데이트는 Store가 합니다.** 앱은 패키지 ID가 있고 exe가 패키지 폴더 안에 있으면(`GetCurrentPackageFullName`·`GetCurrentPackagePath`,
  `src-tauri/src/lib.rs` `is_store_package`) 업데이트 확인·알림·'업데이트 확인' 메뉴를 끕니다(`src/ui/shell/storeBuild.ts`).
- 설정·자동 저장 저널·캐시(`%APPDATA%`·`%LOCALAPPDATA%` 아래)는 Windows가 패키지 전용 폴더
  (`%LOCALAPPDATA%\Packages\<패키지 이름>_<게시자 해시>\LocalCache\`)로 돌려 보관하고, 앱을 제거하면 함께 지워집니다.
  사용자가 저장한 문서는 고른 폴더에 그대로 남습니다. 모델 파일(누끼·OCR·업스케일)은 앱 안에 있어 따로 받지 않습니다.

## Partner Center에서 받아 넣을 값

`Partner Center › 앱 및 게임 › Omniweave › 제품 관리 › 제품 ID`의 세 값을 `store_identity.json`에 넣습니다.

| store_identity.json | Partner Center 표시 | 예 |
|---|---|---|
| `Name` | Package/Identity/Name | `NinerowPartners.Omniweave` |
| `Publisher` | Package/Identity/Publisher | `CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` |
| `PublisherDisplayName` | Package/Properties/PublisherDisplayName | `Ninerow Partners` |

값이 비어 있으면 시험용 임시 이름(`Omniweave.TestPackage` / `CN=Omniweave Test`)으로 만들고 경고를 냅니다. 그대로 올리면 Store가 거절합니다.

## 이 PC에서 설치해 보기 (선택 — 시스템을 바꾸는 일이니 시험 PC에서)

### 방법 1: 개발자 모드에서 폴더째 등록 (서명 필요 없음)
1. `설정 › 시스템 › 개발자용 › 개발자 모드` 켜기
2. `Add-AppxPackage -Register release\msix-work\layout\AppxManifest.xml`
3. 되돌리기: `Get-AppxPackage *Omniweave* | Remove-AppxPackage`, 개발자 모드 끄기

### 방법 2: 시험용 인증서로 서명한 .msix 설치
인증서의 주체(Subject)와 매니페스트의 Publisher가 정확히 같아야 합니다(`--publisher "CN=Omniweave Test"`).
`New-SelfSignedCertificate`(코드 서명 용도) → SDK `signtool sign /fd SHA256 /f <pfx>` → 인증서를 `LocalMachine\TrustedPeople`에 넣기(관리자) →
`Add-AppxPackage release\Omniweave-<버전>.0.msix`. 끝나면 패키지·인증서를 지웁니다.

### 설치 뒤 확인할 것
- [ ] 시작 메뉴에 "Omniweave"가 한 개 보이고 아이콘이 깨지지 않는다(밝은·어두운 작업 표시줄)
- [ ] 도움말에 '업데이트 확인'이 없고, 제목 줄에 업데이트 알림이 뜨지 않는다. `%TEMP%\omniweave-update.log`에 확인 기록이 생기지 않는다
- [ ] `.docx`·`.hwpx`·`.pdf`·`.omw`의 '연결 프로그램'에 Omniweave가 있고, 그렇게 열면 그 파일이 열린다
- [ ] 문서를 열고 저장·다시 열기, 누끼·OCR·업스케일이 동작한다(모델이 패키지 안에서 읽힘)
- [ ] 앱을 제거해도 사용자가 저장한 문서는 남는다

## Windows 앱 인증 키트(WACK)

Store가 올린 패키지를 자동으로 검사하지만, 미리 보려면 SDK의 `appcert.exe`로 검사할 수 있습니다. 패키지를 실제로 설치하고
관리자 권한이 필요하므로 시험 PC나 가상 머신에서 하세요.

```powershell
& "C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe" test `
  -appxpackagepath release\Omniweave-0.2.0.0.msix -reportoutputpath $env:TEMP\omniweave-wack.xml
```

## Store 등록 문구·이미지

`store_listing\` 폴더(README.md에 칸별 값).
