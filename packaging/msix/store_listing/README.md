# Microsoft Store 제출 자료

| 파일 | 내용 |
|---|---|
| `listing_ko.md` · `listing_en.md` · `listing_ja.md` · `listing_zh.md` | 언어별 등록 정보 전체(간단한 설명, 설명, 새로운 기능, 제품 기능 8개, 검색어 7개, 스크린샷 설명, 저작권) |
| `screenshots/<언어>/*.png` | 1920×1080 데스크톱 스크린샷 6장씩(Store 최소 1366×768). 실제 앱(웹 빌드)을 그 언어 화면으로 찍음, 문서는 omni- 시험 자료·데모만 — `make_screenshots.mjs` |
| `art/*.png` | Store 표시 이미지(포스터·박스·수퍼히어로) — `make_store_art.py` |
| `../../../marketing/video/store_trailer/` | 트레일러 영상·썸네일·자막과 만드는 스크립트(비공개 저장소에만) |

## 언어와 상관없는 칸

| Partner Center 칸 | 값 |
|---|---|
| 가격 및 사용 가능 여부 › 가격 | 무료 |
| 가격 및 사용 가능 여부 › 시장 | 모든 시장(원하면 조정) |
| 속성 › 범주 | 생산성 (Productivity), 하위 범주 없음 |
| 속성 › 개인정보처리방침 URL | https://wind2sp.github.io/omniweave/privacy.html (`website/privacy.html`을 GitHub Pages로 올린 뒤) |
| 속성 › 웹 사이트 | https://wind2sp.github.io/omniweave/ |
| 속성 › 지원 연락처 정보 | https://github.com/wind2sp/omniweave/issues |
| 속성 › 시스템 요구 사항 | Windows 10 버전 2004(빌드 19041) 이상 또는 Windows 11, x64, WebView2 런타임(Windows 11과 최신 Windows 10에 기본 포함) |
| 속성 › 제품이 다음에 액세스함 | 없음(인터넷 접속 기능을 쓰지 않음 — Store 판은 업데이트 확인도 하지 않음) |
| 연령 등급 | IARC 설문: 폭력·성적 내용·약물·도박 없음, 사용자 간 소통 없음, 개인정보 공유 없음, 위치 사용 없음, 디지털 구매 없음, 사용자가 만든 내용을 다른 사람과 공유하는 기능 없음 → 대부분 지역 3+ 예상 |
| 패키지 | `release\Omniweave-<버전>.0.msix`(`node scripts/make-msix.mjs`로 만든 것, 서명 없이 올림) |
| 기기 제품군 | Windows 10/11 데스크톱(매니페스트대로) |

## 제출 옵션 › 제한된 기능 설명 (runFullTrust)

영어로 적습니다.

> Omniweave is a Win32 desktop editor (Tauri 2 with WebView2) packaged as MSIX. It needs runFullTrust to run as a regular desktop process: it opens and saves documents, images, PDFs and drawings in folders the user picks through the standard file dialogs, opens the file it was launched with ("Open with" for the file types in its manifest), uses the Windows spell-checking API for text editing, and runs its bundled image models (upscaling, background removal, text recognition) locally with WebGPU or the CPU. It makes no network connections in the Store version: updates come from the Store and the app's own updater is turned off when it runs from its package.

## 인증 참고 사항 (Notes for certification)

> No account or sign-in. On start the app shows the start screen; File > New creates a document, and File > Open opens any supported file (sample files: a .docx, .pptx, .pdf or .png of your own work). Choose a work mode (Document, Slides, Image, Design) at the top. Image > Upscale and Image > Remove background run on the device; the first run may take a few seconds while the bundled model loads. The app makes no network connections and has no in-app purchases. Help > About shows the version and licenses (GPL-3.0-or-later).

## 스크린샷

언어마다 같은 여섯 장입니다. 순서대로 올리세요.

1. `1-document.png` — 문서(DOCX)
2. `2-slides.png` — 슬라이드(PPTX)
3. `3-image.png` — 이미지(레이어·업스케일)
4. `4-design.png` — 디자인(벡터·글)
5. `5-pdf.png` — PDF
6. `6-drawing.png` — 도면(DXF)

화면은 웹 빌드를 1920×1080 창에서 그 언어 UI로 찍은 것이라 Windows 제목 표시줄이 없습니다(앱도 자체 제목 줄을 씁니다).
문서 내용은 저장소의 omni- 시험 자료와 데모 문서뿐이며 실제 사용자 문서·실명·다른 회사 로고는 쓰지 않았습니다.
다시 찍기: `node packaging/msix/store_listing/make_screenshots.mjs`(웹 빌드를 띄운 뒤, 머리 없는 Edge로 찍음).

## Store 표시 이미지·트레일러 (언어별 목록 화면)

네 언어에 **같은 이미지**를 올립니다(트레일러 영상·썸네일만 한국어판/영어판).

| 칸 | 파일 | 올리는 언어 |
|---|---|---|
| 2:3 포스터 아트 (1440×2160) | `art/poster_2x3_1440x2160.png` | 네 언어 모두 |
| 1:1 박스 아트 (2160×2160) | `art/box_1x1_2160x2160.png` | 네 언어 모두 |
| 16:9 수퍼히어로 아트 (3840×2160, 글자 없음) | `art/superhero_16x9_3840x2160.png` | 네 언어 모두(트레일러를 맨 위에 띄우려면 필수) |
| 트레일러 영상 | `marketing/video/store_trailer/trailer_ko.mp4` | 한국어 |
| 〃 | `marketing/video/store_trailer/trailer_en.mp4` | 영어·일본어·중국어 |
| 트레일러 썸네일 (1920×1080) | `thumbnail_ko.png` / `thumbnail_en.png`(같은 폴더) | 영상과 같은 짝 |
| 자막 (WebVTT) | `captions_ko.vtt`·`captions_en.vtt`·`captions_ja.vtt`·`captions_zh-Hans.vtt` | 영상에 붙임(일본어·중국어 목록은 영어 영상 + 그 언어 자막) |

이미지 다시 만들기: `python packaging/msix/store_listing/make_store_art.py`.
Store 로고(1:1 300×300 등)는 비워 두면 패키지 아이콘을 씁니다.
