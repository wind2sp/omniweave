# 설치 파일 용량 — OCR(A안 품질)을 넣고도 커지지 않게

2026-11-12 · 용량 부서 · 제품 요구: "오메 용량이 점점 커지는데, 용량은 커지지 않으면서 A안 품질을 유지할 방법을 찾아 달라."

**한 줄 요약**: 설치 파일의 77%는 Tauri가 exe 안에 넣은 프런트엔드 파일(파일마다 brotli 압축)이다. 1차로 같은 글꼴을 두 형식으로
싣던 것, 169개로 흩어진 pdf.js CMap, 쓰지 않는 1024px 아이콘, U²-Netp 가수부 1비트를 정리해 **2.4 MB**, 2차(조정자 결정 —
글꼴·디자인은 그대로)로 pdf.js 표준 글꼴 정리·Pretendard TTF 무손실 묶음·작업자 코드 공유로 **0.93 MB**를 더 줄였다. 모두 품질 변화
없음(렌더 픽셀·글꼴 바이트·작업자 동작으로 확인). OCR 모델(int8, A안)은 설치 파일에 **+3.1 MB**(4.9 MB가 아니라 — brotli가 이미
압축)를 더하므로, OCR을 넣은 추정 설치 파일은 **약 12.77 MB**, Rust `opt-level = "s"`(cargo 빌드로 확인 필요)까지 **약 12.4–12.6 MB**
(0.1.1: 12.61 MB). OCR 모델 자체를 int8보다 더 줄이는 방법(코드북·저랭크·글자 줄이기)은 재학습 없이는 CER을 지키지 못하거나
이득이 작았다(3장).

## 1. 설치 파일은 무엇으로 이루어져 있나 (0.1.1 실측)

0.1.1 exe(17,228,288 B)에서 `tauri-codegen`이 넣은 brotli 덩어리 207개를 바이트 단위로 찾아 분리했다
(도구: 저장소 밖 `exeassets.mjs`, `src-tauri/target/release/build/*/out/tauri-codegen-assets`와 대조).

| 부분 | 바이트 | 설명 |
|---|---:|---|
| 프런트엔드 파일(exe 안, brotli q9) | 10,074,047 | `dist/` 전체. release 빌드에서 Tauri가 파일마다 brotli q9로 압축해 넣음 |
| Rust 코드·리소스(exe의 나머지 7.15 MB) | 2,293,032 | 위를 뺀 나머지를 xz(LZMA) 압축한 크기 |
| NSIS 머리·설치 스크립트·플러그인 | ≈ 238,000 | 나머지 |
| **설치 파일** | **12,605,070** | |

- 결론 1: **설치 파일 기여 = 그 파일의 brotli q9 크기.** brotli로 이미 압축된 덩어리는 NSIS LZMA가 더 줄이지 못한다.
  그래서 아래 표는 모두 `zlib.brotliCompressSync(q 9, lgwin 22)`로 잰 값이다(실측보다 약 1% 크게 나옴).
- 결론 2: **파일마다 따로** 압축되므로, 같은 내용을 두 파일에 두면 두 번 내고, 작은 파일이 많으면 공통 부분을 못 나눈다.
- 결론 3: 코드 분할(지연 로딩)은 **설치 크기를 줄이지 않는다**(같은 바이트). 시작 시간·메모리용이다.
- 소스 맵은 원래 만들지 않는다(`dist`에 `.map` 없음). i18n 4개 언어 JSON은 합쳐 수십 KB라 지연 로딩해도 설치 크기 차이 없음.

## 2. 프런트엔드 — 바꾼 것 (품질 손실 없음)

`npx vite build` + `scripts/copy-pdfjs-assets.mjs`(release와 같은 `prebuild`) 기준, 단위 바이트(brotli = 설치 파일 기여):

| 항목 | 원래 크기 | 전 (brotli) | **후 (brotli)** | 바꾼 것 |
|---|---:|---:|---:|---|
| **U²-Netp 모델** | 2,298,832 | 2,108,575 | **2,001,168** | **fp16 가수부 10 → 9비트**(4장, 매트 품질 같음) |
| Pretendard TTF Regular·Bold | 5,387,580 | 1,959,516 | 1,959,516 | PDF 내보내기가 심는 원본 — 1차는 그대로(2차: 7장 묶음, 1,661,105) |
| Pretendard woff2 Medium·SemiBold | 1,564,288 | 1,538,614 | 1,538,614 | UI 500·600 굵기 — 그대로(5장 제안) |
| **Pretendard woff2 Regular·Bold** | 1,557,048 | 1,530,119 | **0** | **삭제** — UI 400·700도 같은 TTF를 씀 |
| 주 JS(+ 지연 fontkit·pdf.js 조각) | 3,218,323 | 1,047,299 | 1,043,266 | fontkit·pdf.js를 처음 쓸 때 로드(시작 시 주 JS 3.2 → 2.2 MB) |
| **pdf.js CMap** | 1,167,747 | 951,022 | **433,077** | **169개 → `pdfjs/cmaps.pack` 1개** |
| pdf.js 표준 글꼴 | 780,306 | 510,697 | 510,697 | 그대로(5장 제안) |
| pdf.js 작업자 | 1,375,838 | 366,384 | 366,384 | 그대로 |
| 우리 작업자(이미지·입출력) | 660,704 | 179,493 | 179,493 | 그대로 |
| **UCS2 bcmap 4개(`pdf.ts ?url`)** | 139,411 | 111,889 | **0** | **CMap 묶음에서 읽음(중복 제거)** |
| **app.png (1024px)** | 128,438 | 127,003 | **0** | **삭제** — 앱 어디서도 안 씀(favicon은 64px) |
| 그 밖(css·작은 조각·라이선스) | 100,303 | 29,004 | 29,008 | |
| **합계** | 18,378,818 | **10,459,615** | **8,061,223** | **−2,398,392** |

자세히:

1. **글꼴 중복**: Regular·Bold가 TTF(PDF용)와 woff2(UI용)로 두 번 있었다. 두 형식의 글리프가 같음을 확인(fontkit으로 Pretendard
   1.309, 14,716글리프, 2,048개 표본 글리프의 윤곽·너비 모두 동일). UI `@font-face` 400·700을 TTF로 바꾸고 woff2 2개 삭제(2차에서 TTF도 7장의 묶음으로 바뀜).
   woff2가 brotli(TTF)보다 22% 작지만, TTF는 PDF 글꼴 심기(fontkit 부분 집합)에 꼭 필요해 TTF를 남겼다.
   웹 데모(`/app/`)에서는 처음 내려받는 글꼴이 커진다(서버 gzip/brotli로 상쇄되는 것이 보통).
   `assets/brand/make_brand.py`·`assets/trademark/make_trademark.py`는 woff2가 없으면 TTF를 쓰게 함.
2. **CMap 묶음**: `copy-pdfjs-assets.mjs`가 `public/pdfjs/cmaps.pack`("OCM1" | 개수 | 이름·길이·bcmap) 하나를 쓰고, 옛 `cmaps/` 폴더는
   지운다. `src/io/pdfCMaps.ts`의 `PackedCMapReaderFactory`가 pdf.js `CMapReaderFactory`로 들어가 묶음을 한 번만 받아 이름으로
   돌려준다. PDF Surgeon의 CID→유니코드(Adobe-*-UCS2)도 같은 묶음에서 읽어 별도 bcmap 4개(`?url`)를 없앴다.
   시험 `tests/size/cmapPack.test.ts`: 169개 바이트 단위 왕복, 손상 거절, **임베드 안 된 한국어 CID 글꼴(UniKS-UCS2-H) PDF를 pdf.js가
   묶음으로 "한글"로 읽음**(CMap 없이 읽으면 깨짐을 대조로 확인), 묶음은 기준 URL당 한 번만 받음.
   `tests/fidelity/screen.ts`(개발용 브라우저 비교)는 `node_modules/pdfjs-dist/cmaps/`를 직접 씀. 라이선스는 `pdfjs/LICENSE_CMAPS`.
3. **지연 로딩(시작 메모리용)**: fontkit(0.58 MB)은 PDF 내보내기·Surgeon 대체 글꼴에서, pdf.js 본체(0.33 MB)는 첫 PDF 열기·인쇄·
   PDF→JPG에서 로드(`src/io/pdfjsLoader.ts` — 작업자 URL을 늘 설정하고, 이미 설정된 값(시험)은 유지). 주 조각 2.96 → 2.05 MB(원래 크기).
   OCR 모델은 이미 처음 쓸 때 `models/ocr/*.lwt`를 받아 캐시(`ocr/models.ts`), U²-Netp도 처음 누끼 때 로드 — 그대로 둠.
4. 바꾸지 않은 것: 작업자와 주 조각의 코드 중복(brotli 합쳐 압축하면 135 KB 차이)은 Vite가 작업자를 따로 묶어 공유 조각을 만들 수
   없어 제안으로 남김.

## 3. OCR 모델 — int8보다 더 줄일 수 있나 (재학습 없이)

기준(A안): PP-OCRv5 모바일 검출 + 한국어 인식, 출력 행별 int8. 설치 파일 기여 **검출 981,249 + 인식 2,127,541 = 3,108,790 B**
(파일 1.36 + 3.57 MB). 변환은 `convert-ppocr.mjs --f32`(손실 없는 사본) → `requant-lwt.mjs`. `--int8` 결과와 바이트 동일함을 확인.

평가: OCR 부서 합성 시험 21쪽(`scripts/ocr-eval.ts`, 현재 파이프라인), 쪽별 CER %. 거르기 7쪽 → 통과한 것만 21쪽.

| 방법 | 설치 기여(검출+인식) | report-clean | form-scan | mixed-clean | 판정 |
|---|---:|---:|---:|---:|---|
| **A: int8 (출력 행별)** | **3,108,790** | **0.39** | **5.05** | **4.80** | 기준 |
| 인식·검출 k-평균 64단계(가중치 공유) | 2,753,099 | 2.94 | 6.50 | 5.07 | 탈락(+2.6pt) |
| 〃 32단계 | 2,415,085 | 37.84 | 48.38 | 29.33 | 탈락 |
| 검출만 32단계 | 2,914,211 | 0.39 | 3.97 | 3.20 | 탈락 — english_times-scan 0.50 → 5.94 |
| 검출만 16단계 | 2,806,242 | 37.65 | – | 35.47 | 탈락 |
| 인식 128단계 | −73 KB | – | – | – | 이득이 작아 생략 |

- 가중치 오차: int8 1–2%, 64단계 4–5%(인식 텐서별 상대 RMS). 이 모델은 4%대 잡음에서 이미 글자를 틀린다 → **양자화 인식 학습(QAT)
  없이 int8 아래로는 못 간다.**
- **분류기(120×11,947, 인식 매개변수의 43%)**: SVD 에너지 rank 64 = 83%, 96 = 94.6%(상대 오차 23%) — 거의 꽉 찬 계수라 저랭크 분해 불가.
  자모 덧셈 구조(초·중·종 효과 합)로 설명되는 분산은 R² 0.10뿐 — 잔차 부호화 이득 없음.
- **글자 줄이기**: 사전은 현대 한글 11,172자 전부 + 옛한글 자모 238 + 라틴·기호(한자 없음). KS X 1001 2,350자만 남기면 분류기 열
  11,947 → 3,125지만 설치 기여는 **−118 KB뿐**(드문 음절의 가중치는 작아서 이미 잘 압축됨). 반면 "똠·햏·뷁" 같은 음절과 이름은
  항상 틀리게 된다 → **하지 않음**.
- 검출·인식 백본 비교(보고만): 둘 다 PP-LCNetV3 계열이지만 학습이 따로라 같은 가중치는 없다. 1×1 conv 비중이 비슷하다는 것 정도.
- 텐서 안 엔트로피 부호화(정적 허프만 등): 설치 파일은 이미 brotli가 텐서별 분포를 부호화한다(int8 인식 5.67 bit/값 → brotli가 그
  이하로 압축) — 설치 크기 이득 없음. 웹 다운로드에서만 의미(브라우저가 brotli를 풀면 같음).

OCR 21쪽 결과(A, 현재 파이프라인, 묶음은 글자 수 가중): 한국어 clean **2.31%** / scan 5.39% / photo 9.44%, 영어 clean **0.41%** /
scan 1.57% / photo 7.93%. report-clean 0.39%(OCR.md 3.3의 int8 1.57%는 띄어쓰기·체크 상자 수정 전 측정).

## 4. U²-Netp — 지금 fp16(채널별 정규화) 2.11 MB

| 방법 | 설치 기여 | ONNX 대비 최대/평균 오차 | 매트 평가 68장 IoU(ours) | 판정 |
|---|---:|---|---|---|
| **fp16(현재)** | 2,108,575 | 0.0082 / 1.91e-4 | 0.918 · 분류 0.78 | 기준 |
| int8 출력 채널별 | 1,031,296 | **0.9905 / 3.35e-2** | – | 탈락(BN 접기로 큰 가중치 하나가 채널 범위를 정함) |
| fp16 가수부 9비트 | 2,001,168 | 0.0114 / 1.94e-4 | 0.918 · 분류 0.78(53/68) — SAD 17.1·Grad 1.06·가장자리 MAD 0.064 모두 같음 | **적용**(−107 KB) |
| fp16 가수부 8비트 | 1,884,573 | 0.0253 / 3.10e-4 | 0.918 · 분류 0.78 — 같음 | 매트 품질은 같으나 수치 시험 한계(0.02) 넘음 → 제안(−117 KB 더) |
| fp16 가수부 7·6·5비트 | 1.77 / 1.63 / 1.48 MB | 0.029 / 0.114 / 0.115 | – | 탈락 |

가수부 줄이기(`lwtQuant.toHalf(v, M)`, `requant-lwt.mjs --f16 M`)는 형식이 그대로 fp16이라 실행기 변경이 없고, int8과 달리
**작은 가중치의 상대 정밀도를 지킨다**. 낮은 비트가 0이 되어 brotli가 거의 공짜로 저장한다.

## 5. 크기 계획표 (설치 파일 기준 추정)

| 조치 | 설치 파일 절감 | 품질 영향(측정) | 노력 | 위험 | 상태 |
|---|---:|---|---|---|---|
| woff2 Regular·Bold 삭제(UI가 TTF 사용) | **−1.53 MB** | 같은 글리프(검증) | S | 웹 데모 첫 글꼴 다운로드 증가 | **적용** |
| CMap 169개 → 묶음 1개 | **−0.52 MB** | 바이트 동일 + pdf.js 시험 | S | 낮음 | **적용** |
| UCS2 bcmap 중복 제거 | **−0.11 MB** | 같은 바이트 | S | 낮음 | **적용** |
| 안 쓰는 app.png 삭제 | **−0.13 MB** | 없음 | S | 없음 | **적용** |
| fontkit·pdf.js 지연 로딩 | 0 (시작 시 JS −0.9 MB) | 없음 | S | 낮음 | **적용** |
| U²-Netp fp16 가수부 9비트 | −0.11 MB | 4장 | S | 낮음 | **적용** |
| Rust `opt-level = "s"` (lto·cu1·strip·abort는 이미 있음) | −0.2~0.4 MB(추정) | Rust는 IPC·파일 접착 코드뿐 | S | 자산 brotli 풀기 약간 느려질 수 | **Cargo.toml 수정, cargo 빌드로 확인 필요** |
| 글꼴 Medium·SemiBold 부분 집합(KS X 1001+라틴, 나머지는 `unicode-range`로 Regular/Bold TTF) | −0.9~1.0 MB | 드문 음절이 한 단계 다른 굵기 | M | **OFL 예약 글꼴 이름 "Pretendard" → 수정본은 이름 변경 필요**(또는 공식 부분 집합판 사용) | 결정 필요 |
| UI 500→400·600→700(Medium·SemiBold 삭제) | −1.54 MB | UI 굵기 디자인 변경(CSS 41곳) | S | 디자인 | 결정 필요 |
| pdf.js 표준 글꼴: Symbol·Dingbats만(8장) | **−0.47 MB** | 21개 PDF 렌더 픽셀 차이 0 | S | 시스템에 Arial/Times/Courier 계열이 없는 웹 데모 환경 | **적용** |
| Pretendard Regular·Bold TTF → 무손실 묶음(7장) | **−0.30 MB** | TTF 바이트 동일·PDF 글꼴 부분 집합 동일·UI 글자 픽셀 동일 | M | 낮음 | **적용** |
| 작업자·주 조각 코드 공유(9장) | **−0.17 MB** | 두 작업자 실제 실행 확인 | M | Tauri에서 모듈 작업자 확인 필요 | **적용** |
| OCR k-평균·저랭크·글자 줄이기 | −0.1~−0.7 MB | CER 크게 나빠짐 / 글자 범위 손실 | – | 높음 | **하지 않음**(3장) |
| OCR 인식기 우리 모델(자모 출력, QAT int4) | −1.5 MB 이상(목표) | 학습 필요 | L | 학습 자원 | OCR.md 5장 |

## 6. 예상 설치 파일 크기

고정부(Rust 코드 xz + NSIS) = 12,605,070 − 10,074,047 = **2,531,023 B**(0.1.1 실측) + 프런트엔드 brotli 합.

| 상태 | 프런트엔드 | 설치 파일(추정) |
|---|---:|---:|
| 0.1.1 (실측) | 10.07 MB | **12.61 MB** |
| 이 가지 바꾸기 전(OCR 코드 포함, 모델 없음) | 10.46 MB | ≈ 12.99 MB |
| 1차 뒤, OCR 모델 없음 | 8.06 MB | ≈ 10.59 MB |
| 1차 뒤 + OCR A안(int8) | 11.17 MB | ≈ 13.70 MB |
| **2차 뒤, OCR 모델 없음** | 7.13 MB (7,127,047) | **≈ 9.66 MB** |
| **2차 뒤 + OCR A안(int8) 묶음** | 10.24 MB (10,235,837) | **≈ 12.77 MB** |
| 〃 + Rust opt-level "s"(추정 −0.2~0.4) | | **≈ 12.4–12.6 MB** |

(node brotli는 Tauri의 Rust brotli보다 약 1% 크게 나와(0.1.1 대조) 실제는 0.1 MB쯤 작을 것 → OCR 포함 ≈ 12.67 MB, "s"까지 ≈ 12.3–12.5 MB.)

**12.6 MB 이하는 opt-level "s"의 실측에 달려 있다.** 남은 결정 항목(Medium·SemiBold, −1.0~1.5 MB)은 조정자 결정으로 보류.

## 7. Pretendard Regular·Bold — 무손실 "TrueType 묶음" (`src/io/fontPack.ts`)

조정자 지시는 "woff2만 싣고 PDF용 TTF는 실행 중 복원, 심는 글꼴 바이트는 지금과 같게"였다. 확인해 보니 **배포하던 woff2는 TTF와
다른 바이너리**(woff2 안의 원래 glyf 2,292,312 B·GSUB 37,262 B vs TTF 2,271,831 B·37,976 B — 같은 윤곽, 다른 빌드)라 woff2를
어떻게 풀어도 TTF와 바이트가 같아질 수 없다. 또 woff2가 작은 이유의 절반은 glyf 변환, 절반은 brotli q11이다(woff2 안 데이터를
q9로 다시 압축하면 821 KB). 그래서 같은 아이디어를 **바이트 보존**으로 구현했다.

- `packTtf`: glyf를 WOFF2 방식 스트림(윤곽 수, 255UInt16 점 수, 점마다 플래그 1바이트 + "triplet" 좌표, 점에서 계산되는 bbox는 생략)으로
  나누고 loca는 버림. 나머지 표(GPOS·GSUB·cmap·post…)와 표 사이 바이트는 그대로.
- 정확성: 단순 글리프마다 **글꼴 컴파일러의 방식(fontTools greedy 좌표·플래그 압축)으로 다시 인코딩해 원래 바이트와 같을 때만** 스트림에
  넣고, 아니면 원본 그대로(raw) 저장. Pretendard는 13,123개 단순 글리프 전부 일치, 겹침/예약 플래그 0개.
- `unpackTtf(packTtf(ttf)) === ttf` **바이트 동일**(Regular·Bold). pdf-lib+fontkit로 "한글 Omniweave 오메 1234 ①☑"를 심은
  **FontFile2 부분 집합 바이트도 원본 TTF와 동일**(`tests/size/fontPack.test.ts`). 비정규 인코딩·잘못된 bbox·겹침 플래그·명령어·큰 좌표·
  합성·빈 글리프가 섞인 작은 TTF도 왕복 시험.
- 앱: `public/fonts/Pretendard-{Regular,Bold}.ttpack` 하나를 UI(`installUiFonts` → `FontFace` 400·700, `main.tsx`가 첫 화면 전에 기다림)와
  PDF 내보내기·Surgeon 대체 글꼴(`pretendardTtf`)이 함께 씀 — 내려받기·풀기는 무게당 한 번. 원본 TTF는 `assets/fonts/`(배포 안 함,
  시험·브랜드 스크립트용). 묶음 갱신: `OMNIWEAVE_WRITE_FONTPACK=1 npx vitest run tests/size/fontPack.test.ts`.
- 크기(설치 기여): Regular 962,612 → **819,245**, Bold 996,904 → **841,860** — 합계 **−298,411 B**. (woff2 q11만큼 −0.43 MB는 안 됨:
  앱 안에서 brotli를 풀 수단이 없어 Tauri의 q9에 맡김.)
- UI 확인(빌드한 앱): 400·700 "loaded", 원본 TTF로 같은 문자열을 그린 캔버스와 **다른 픽셀 0**(400: 잉크 4,096, 700: 6,474픽셀).

## 8. pdf.js 표준 글꼴 — Symbol·Dingbats만 (`scripts/copy-pdfjs-assets.mjs`)

- 브라우저/WebView에서 pdf.js는 `useSystemFonts`가 기본으로 켜져, 임베드 안 된 표준 14 글꼴 중 **Symbol·ZapfDingbats만** 표준 글꼴
  데이터를 받는다(Helvetica·Times·Courier는 시스템 글꼴 — Windows의 Arial·Times New Roman·Courier New). Liberation은 CSS `url()` 대체
  경로에만 쓰이는데, CMap 묶음 때문에 우리가 `CMapReaderFactory`를 직접 주면서 작업자가 URL을 만들지 않으므로(useWorkerFetch 꺼짐)
  앱에서는 이미 쓰이지 않았다. → `FoxitSymbol.pfb`·`FoxitDingbats.pfb`·`LICENSE_FOXIT`만 복사(510,697 → **42,189 B, −468,508**).
- 시험 `tests/size/stdFonts.test.ts`: 앱 설정 그대로(useSystemFonts, 묶음 CMap) 표준 14 전부 + 한·중·일 CMap PDF를 pdf.js로 읽을 때
  요청된 파일을 기록 → 정확히 Dingbats·Symbol 두 개, 남긴 목록에 포함.
- **픽셀 증명** `qa/size/stdfonts-compare.html`(브라우저, 2배 렌더): 이전 설정(낱개 CMap + 표준 글꼴 전부 + 기본 팩토리) vs 앱 설정
  (CMap 묶음 + Symbol·Dingbats만). 시험 PDF 5개(표준 14 글꼴 14줄, Korea1·Japan1·GB1·CNS1 비임베드) + interop PDF/AI 16개 =
  **21개 모두 다른 픽셀 0**(최대 차 0).
- 한계: Arial·Helvetica·Liberation Sans 같은 로컬 글꼴이 하나도 없는 환경(일부 리눅스 웹 데모 사용자)에서는 Helvetica가 Liberation
  대신 브라우저 기본 sans-serif로 그려진다(1차의 CMap 묶음부터 그랬음). 데스크톱(Windows)은 해당 없음.

## 9. 작업자와 주 스레드의 코드 공유 (`vite.config.ts` `sharedWorkers`)

- 이미지 작업자(누끼·OCR·벡터화·필터)와 충실도 작업자(PSD 채점)는 Vite가 따로 묶어, 주 스레드 대체 경로와 같은 코드가 두 번 실렸다.
- 빌드 전용 플러그인이 `run.ts`의 `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`를 앱 빌드 안의 **방출 청크**
  (`import.meta.ROLLUP_FILE_URL_…`)로 바꾼다. 작업자는 ES 모듈이라 공유 청크(`models-*.js` 이미지 파이프라인, `psdScore-*.js`,
  `tile-*.js`)를 같은 폴더에서 상대 경로로 가져온다 — 이름에 해시 유지, `base: "./"` 그대로(Tauri·사이트 루트·`/app/`), CSP는 원래 없음.
  개발 서버는 Vite의 원래 작업자 처리 그대로.
- 크기: JS 합계 1,233,179 → **1,065,898 B(−167,281)**. 시작 시 주 조각은 2.05 → 1.45 MB(공유 청크 3개는 modulepreload).
- 확인(빌드한 dist를 브라우저에서): 이미지 작업자 — 필터·누끼 정상(원 안 알파 평균 255 근처, 밖 0, 종류 graphic), OCR은 모델이
  없어 기존과 같은 오류 응답; 충실도 작업자 — `ps_layers_groups.psd` 채점 완료(SSIM 0.998, 2 이내 98.4%). 콘솔 오류 없음.
  시험 `tests/size/sharedWorkers.test.ts`(변환·방출·패턴이 바뀌면 빌드 실패).
- 참고: 공유 청크는 주 스레드가 쓰는 export도 남기므로 충실도 작업자가 읽는 코드는 115 KB → 약 590 KB(원래 크기)로 커졌다 —
  작업자 시작에 수십 ms. 설치 크기와 바꾼 것.

## 10. cargo 빌드로 확인할 것 (조정자)

1. `opt-level = "s"`로 release 빌드 → exe·설치 파일 크기, `--selftest`, 큰 파일 열기 시간(IPC)과 첫 화면 시간 비교.
2. 이 가지 dist로 설치 파일을 만들어 6장의 "2차 뒤, OCR 모델 없음" 값(≈9.66 MB, 실제는 ≈9.6 MB)과 대조.
3. 실제 앱(tauri://)에서: UI 글꼴 400·700(묶음에서 FontFace), 누끼·OCR·PSD 채점(모듈 작업자가 공유 청크를 가져오는지),
   CJK·표준 글꼴 비임베드 PDF 표시, PDF 내보내기(글꼴 심기), 인쇄 미리보기, PDF→JPG.

## 11. 재현

- 크기: `node <scratch>/sizes.mjs dist`(파일별 원본·brotli q9), exe 분해: `exeassets.mjs <exe> <tauri-codegen-assets 폴더들>`.
- 모델: `node scripts/convert-ppocr.mjs <dir> --out x-f32.lwt --f32` → `node scripts/requant-lwt.mjs x-f32.lwt --out x.lwt [--levels K]`,
  `node scripts/convert-u2netp.mjs <onnx> --f32 --out u-f32.lwt` → `node scripts/requant-lwt.mjs u-f32.lwt --out u.lwt --f16 9`.
- 품질: `scripts/ocr-eval.ts`(OCR.md 3장), `node scripts/matte-eval.mjs <ds> --split all --model <lwt>`(새 `--model` 선택지).
- 시험: `tests/size/cmapPack.test.ts`, `tests/infer/requant.test.ts`, `tests/size/fontPack.test.ts`, `tests/size/pretendard.test.ts`,
  `tests/size/stdFonts.test.ts`, `tests/size/sharedWorkers.test.ts`. 픽셀 비교: `OMNIWEAVE_SIZE=1 npx vitest run tests/size/stdFonts.test.ts`
  후 개발 서버에서 `qa/size/stdfonts-compare.html`.

## 12. 크기 예산 — 설치본을 이유 없이 키우지 않는다 (2026-11-12 제품 요구)

설치 파일 실측(이 가지, OCR int8 포함): **12,379,761 B** (0.1.1: 12,605,070 B). 그중 프런트엔드(dist/)는 파일마다 brotli q9로
들어가므로 그 합을 예산으로 지킨다. `npm run build` 뒤 `npm run size:budget`(또는 `OMW_SIZE_BUDGET=1 npx vitest run
tests/size/sizeBudget.test.ts`)이 dist를 재서 **기준 + 50 KB**를 넘으면 실패한다. 기준을 올리는 것은 이유를 적고
`node scripts/size-budget.mjs --update`로만(아래 줄이 바뀌므로 리뷰에서 보인다).

기준 올림 기록: 2026-11-13 CAD 2차(cad-import-2) — DXF·DWG 가져오기 청크 3개(`build`·`dxf`·`objects`, brotli 27,320 B,
도면을 열 때만 불러옴)와 0.1.7 화면이 합쳐져 기준 + 9,764 B를 넘어 10,399,082 → 10,460,046 B.
통합 integ-cad(0.1.8 + CAD 2차): main 기준(xlsx 부서, 10,468,767 B)에 CAD 2차 증가분(지연 청크 27,321 B + 레이어 패널·눈금자·번역 등
앱 본체 쪽)이 더해져 기준 + 55,539 B → 10,524,306 B(파일 43개). 도면 해석 코드는 도면을 열 때만 불러온다.
통합 integ-0110(0.1.10: doc-3 맞춤법·표 칸 서식·문단 테두리, cad-3 외부 참조·단선 글꼴, cad-ui 도면 화면, 검수 PC PDF 양식·메모·서명):
기준 + 74,198 B → 10,598,504 B(파일 49개). 늘어난 파일은 도면을 열 때만 불러오는 청크(`CadScreen`·`view`·`open`·`external`·
`strokeFont`·`strokeInstall` 등), 나머지는 맞춤법·PDF 양식 화면·번역의 기능 코드 — 같은 것을 두 번 싣는 낭비 없음(규칙 1·2 ✔).
통합 integ-0112(0.1.12: cad-4 DWG 2007·MULTILEADER·XCLIP·도면 명령, slide-mode 자리표시자·레이아웃·구역·노트): 두 가지 각자
기준(10,653,519 / 10,660,115)을 합친 dist가 10,667,246 B(파일 50개) → i18n 청크 분리 10,667,841 B → 자리표시자 문구 다듬기 뒤 **10,667,952 B(파일 51개)**, cad-4 기준 + 14,433 B.
번역 문구 중복 점검: CAD 부서가 '새 명령 문구가 도면 `view` 청크와 `psdScore` 청크 두 곳에 실림'이라 본 것은 `view`에 있는
**키**(`t("cadui.msg.arrayed")` 호출 자리)였고, 4개 언어 **문구 값**은 한 청크에만 있다(i18n 문구 7,472개를 dist JS 전체에서
찾아 두 파일 이상에 나오는 것은 'Insert'·'Layers'처럼 코드에도 우연히 있는 짧은 영어 낱말 252개 5 KB뿐 — 중복 아님).
원인: `src/i18n`은 앱과 작업자(fidelity·image)가 함께 쓰므로 Rollup이 공용 청크에 넣고, 그 공용 청크 이름이 우연히 `psdScore`였다.
정리: `vite.config.ts` manualChunks로 `src/i18n/**`(4개 언어 전부)를 `assets/i18n-*.js` 한 청크로 모음(원본 551 KB, brotli 164 KB,
앱 시작 때 불러오는 것은 전과 같음 — 동작 불변, `tests/size/i18nChunk.test.ts`). `psdScore`는 691 → 140 KB(원본)로 이름값을 함.
크기 변화: 파일 하나가 늘어 +595 B(brotli, 0.006%) — 줄일 중복이 없어 감량 없음. 메인 청크에 넣는 길은 작업자가 앱 본체 청크를 불러오게
되므로 쓰지 않음.

psd-adjust(조정 레이어 6종·디졸브, QA 2026-11-15): 기준 + 76,472 B → **10,744,424 B**(파일 51개 그대로). 그중 66,266 B는 포토샵 디졸브 문턱값 표(`src/core/style/dissolveField.ts`, 256×256 = 65,536 B를 base64로 87 KB)이고 나머지 약 10 KB는 조정 6종 코드다. 표는 측정값이라 줄일 규칙이 없다(값 1..255가 고르게 퍼져 원본 바이트의 brotli도 64,300 B — base64를 바이너리로 바꿔도 1.4 KB만 줄어 둘 이유 없음, 비트 수를 줄이면 무늬가 바뀌어 기능 왜곡). 중복 없음(규칙 1·2 ✔). 남은 일: 표는 `blend.ts dissolveKeep`이 동기로 부르므로 공용 `psdScore` 청크에 실려 앱 시작 때 함께 불러온다 — 디졸브 레이어를 만났을 때만 불러오는 지연 로드는 화면·내보내기 경로를 비동기로 준비시켜야 해서 따로 한다.

통합 integ-0113(wip/2026-11-11 7d46fbf, 크기 점검 2026-11-16): 기준 + 69,455 B → 10,813,879 B로 예산(+51,200)을 18,255 B 넘음. 그 주 부서·QA는 모두 OCR 모델 없이(대부분은 prebuild 없이 `npx vite build`라 pdf.js CMap·표준 글꼴도 없이) 재서 7.2~7.7 MB가 나와 예산 시험이 걸러 주지 못했다(아래 '측정 불가'). 같은 조건(OCR 포함, `npm run build`)으로 기준 시점 820991d와 비교한 파일별 brotli 차이: `psdScore` 126,614 → `cmykComposite` 72,488 + `dissolveField` 65,734(디졸브 표가 지연 청크로 빠지고 공용 청크 이름이 바뀜, +11,608), `index` +39,117, `i18n` +9,709, `sheetChart` +5,515, `store` +1,333, `open`(CAD) +1,318, css +619, 나머지 ±300 이하. 기능별(모듈 크기 비율로 나눈 어림, brotli B): 메모·추적 15,700 · HWP 저장 11,200 · 차트(Excel chartex·PPTX 차트 편집) 9,700 · 공용(office.ts·형식 목록·리본 등 여러 부서) 5,900 · 슬라이드 레이아웃 4,300 · CMYK 4,300 · DOCX 간격·쪽 4,000 · 단축키 3,100 · 구형 형식 저장 3,100 · 표 머리글 3,000 · CSV 2,200 · CAD 글자 1,700 · HWPX 번호 제목 1,000. 큰 표·자료 파일은 새로 없음(모두 기능 코드와 4개 언어 문구).

낭비로 고친 것(동작 불변, 시험 전체 통과): ① HWP 저장기(`hwp5Write`·`hwp5Body`·`hwp5Preview`)가 시작 묶음에 있었음 → HWP로 저장할 때만 불러옴(`hwp5Fp.ts`에 열 때 필요한 지문·출처만 남김). 시작 때 받는 파일 brotli −9.2 KB(원본 −28.6 KB), 대신 따로 압축되어 전체 +2.2 KB. ② CFB(복합 파일) 쓰기 코드가 두 벌(암호화용 `crypto/cfbWrite.ts`, HWP 저장용 `formats/cfb.ts`) → 하나로(암호화는 얇은 어댑터), −931 B. 저장소 시작 섹터를 [MS-CFB] 2.6.3대로 0으로(한글이 쓰는 값과 같음), 형제 트리는 유효한 레드-블랙 색. Word·Excel로 새 쓰기의 암호 DOCX·XLSX 열기 확인. ③ 단계가 바뀌며 안 쓰게 된 문구 7개×4개 언어(`hwp5write.export.hint`·`format.level`·`menu.notFromHwp`·`err.edited`, `review.readOnlyNote`·`editNote`·`pdf.note`) 지움, −556 B. 바뀐 모듈의 최상위 함수 이름이 다른 파일과 겹치는 222곳을 살핀 결과 같은 일을 하는 큰 코드는 CFB 쓰기 하나뿐(나머지는 u16·clamp 같은 몇 줄 도우미, HWP 레코드 해석 25줄은 읽기용·쓰기용 동작이 달라 둠).

새 기준: **10,814,613 B(파일 53개)**, 기준 + 70,189 B. 늘어난 것은 위 기능 코드와 문구 — 기능을 빼거나 줄일 규칙이 없고 같은 것을 두 번 싣지 않음(규칙 1·2 ✔). 앱 시작 때 받는 파일(index.html이 부르는 8개)은 820991d 1,099,894 → 1,086,774 B로 오히려 줄었다(디졸브 표·HWP 저장기 지연 로드).

측정 불가(재발 방지): 예산 시험과 `npm run size:budget`은 dist에 prebuild가 넣는 파일 — `pdfjs/cmaps.pack`·Foxit 표준 글꼴 2개, 기준이 OCR 포함(`"ocr":true`)이면 `models/ocr/` 고정 모델 2개와 LICENSE — 이 없으면 크기를 비교하지 않고 "cannot measure"로 실패한다(`measureGaps`, tests/size/sizeBudget.test.ts). docx-pages QA의 7,698,596 B와 다른 가지 약 7.22 MB의 차이 475,266 B는 바로 이 pdf.js 파일(cmaps.pack 432,289 + Foxit 41,434 + 라이선스 2개 1,543)이다: docx-pages는 `copy-pdfjs-assets`를 돌린 뒤 OCR만 없이 빌드했고, 다른 가지는 prebuild 없이 `npx vite build`만 해 public/pdfjs가 없었다. docx-pages dist는 OCR 3개(3,112,475 B)를 빼면 지금 통합 dist와 코드 청크 ±2.5 KB 안에서 같다.

psd-cmyk-default(기본 CMYK 프로필 FOGRA39, QA 2026-11-17): 바탕 wip 059356f(프로필 없음) 10,860,294 B → **10,891,717 B(파일 58개)**, +31,423 B. 거의 전부 줄인 FOGRA39L 프로필(84,960 B)을 담은 `src/core/image/defaultCmykIcc.ts`(`cmykComposite` 청크)다. 부서 처음 판은 한 축 차분 base64라 +50,914 B였고, QA에서 표 값을 4차원 예측 나머지의 인쇄 가능한 문자로 바꿔(같은 .icc로 정확히 풀림) −19,491 B. 더 줄이는 길은 이득이 작거나 기능을 바꿔 쓰지 않음: 따로 내려받는 바이너리 파일(base64·문자 부호를 벗겨도 약 −4 KB인데, 동기 PSD 디코딩 경로 — 작업자·.omw 복원·점수 — 를 모두 미리 불러오게 고쳐야 함), 표 11비트(−0.6~1.8 KB, A2B는 2단계 어긋남), B2A 격자 13³(최대 65단계 어긋남). 중복 없음(규칙 1·2 ✔). 기준 10,814,613(2026-11-16) → 10,891,717 B — 그 차이에는 이 가지 전 wip에 이미 쌓인 +45,681 B(예산 허용치 안이던 다른 부서 코드)도 들어 있다.

pptx-emf-images(EMF·WMF 그림 재생기, 2026-11-21 발표 부서): 바탕 wip e1ee7e4(직전 QA 측정 15,047,468 B, 예산 허용치 안) → **15,074,765 B(파일 69개)**, +27,297 B, 기준 15,014,443 → 15,074,765 B. 그중 13,967 B는 새 지연 청크 `metafile`(EMF·WMF·EMF+ 재생기 `src/io/formats/metafile.ts` — 메타파일 그림을 처음 그릴 때만 불러옴, 앱 시작 묶음에 들지 않음)이고, 나머지는 시작 묶음의 작은 판별 모듈(`metafileSniff.ts`)·공용 그림 디코드(`render/picDecode.ts`)·큰 그림 반씩 줄이기와 픽셀 맞춤(`draw.ts drawPicture`)·PPT 메타파일 BLIP 풀기·4개 언어 알림 문구다. 기능 코드라 줄일 규칙이 없고 같은 것을 두 번 싣지 않음(규칙 1·2 ✔): 메타파일 바이트는 원본 그대로 자산에 두고 화면에서만 SVG로 바꾼다(저장 파일 크기 변화 없음).

ai-native(PDF 호환 없는 .ai를 Illustrator 고유 데이터로 그리기, 2026-11-21 AI 부서 + QA): 바탕 wip cdc8984 15,074,765 B(파일 69개) → **15,094,835 B(파일 70개)**, +20,070 B. 새 지연 청크 `aiNativeOpen`(고유 데이터 해석기·PDF 쓰기, 원본 44,085 B · brotli 16,568 B — PDF 호환 없는 .ai를 처음 열 때만 불러옴, 앱 시작 때 받는 파일에는 없음)과 4개 언어 안내 문구. 부서 측정의 +64 KB(15,014,443 → 15,078,623)는 옛 바탕 기준이라, wip를 합친 뒤 한 번 다시 쟀다. QA에서 더한 한도·캐시·제한 풀기 코드는 몇백 B. 기능을 빼거나 같은 것을 두 번 싣지 않음(규칙 1·2 ✔), 필요한 증가로 기록.

0.2.0 공개 준비(release-prep + update-full, 출시 QA 2026-11-22): 기준 fab3502 15,094,835 B(파일 70개) → **15,176,693 B(파일 76개)**, +81,858 B로 예산(+51,200)을 30,658 B 넘음. 같은 조건(`npm run build`, OCR 포함)으로 fab3502를 다시 빌드해 파일별 brotli를 비교: **`legalTexts` +57,327 B(새 지연 청크)** — 앱 안 법적 고지 전문(LICENSE GPL-3.0 35,823 B · NOTICE · THIRD_PARTY_NOTICES.md 740,059 B · TRADEMARKS.md, 원본 786 KB). GPL §4·§6과 BSD·Apache·MIT·OFL·zlib이 바이너리 배포에 고지를 요구하고 Store 판에도 들어가야 해서 넣음, 정보 창에서 열 때만 불러옴(시작 묶음 아님). 의존성마다 같은 라이선스 본문이 반복되지만 brotli가 반복을 거의 다 접어(원본의 7.3 %) 중복 제거로 줄 몫은 작고, 고지 문서 형식을 바꾸지 않으려 둠. 나머지 +24.5 KB: `i18n` +5,891(업데이트 창·중요 업데이트·Store 문구·상표 표기 4개 언어), `index` +5,207(업데이트 흐름·포터블 바꿔치기 UI·Store 판 감지), `cmykComposite` +4,382·`psdLinks` +937(PSD 고급 개체), `strokeFont` +3,329·`shxLoad` +819(CAD SHX 글꼴), `sniff` +1,692(시작 화면 멈춤 고침으로 따로 청크가 된 형식 판별), 그 밖 ±1 KB. 같은 것을 두 번 싣지 않음(규칙 1·2 ✔), 법적 의무·기능 증가라 크기 원칙(필요한 증가 허용)대로 올림.

<!-- size-budget: {"distBrotli":22425590,"tolerance":51200,"files":180,"ocr":true,"date":"2026-11-25"} -->

| 기준 | 값 |
|---|---|
| dist brotli q9 합 | **10,251,335 B** (파일 34개, 원본 19,268,280 B) — OCR int8 모델 2개 + LICENSE 포함 |
| 허용 | +51,200 B |

규칙(스크립트가 검사하는 것은 ✔):
1. ✔ 같은 것을 두 번 싣지 않는다 — Pretendard Regular·Bold는 `fonts/*.ttpack` 하나(TTF·woff2 사본 금지), CMap은
   `pdfjs/cmaps.pack` 하나(낱개 .bcmap 금지), 표준 글꼴은 Foxit Symbol·Dingbats와 그 LICENSE만.
2. ✔ 모델은 정해진 자리와 고정된 해시만 — `models/ocr/`에는 매니페스트(`tests/fixtures/ocr/models-manifest.json` "bundle")의
   파일과 LICENSE만, U²-Netp는 `assets/u2netp-*.lwt` 하나.
3. 모델 정밀도: OCR은 int8(출력 채널별 배율), U²-Netp는 fp16 가수 9비트(4장). 더 큰 형식은 품질 측정과 예산 갱신이 함께.
4. 새 자산(글꼴·그림·모델·라이브러리)은 넣기 전에 brotli q9 크기를 재서 이 문서에 적는다. 무거운 라이브러리는 첫 사용 때 불러온다
   (pdf.js·fontkit처럼).
5. Rust release 프로필 `opt-level = "s"`, `lto`, `strip`, `panic = "abort"` 유지(exe는 이 예산 밖 — 설치 파일 실측으로 확인).

OCR 모델을 빌드에 넣는 길(재현 가능): 고정 파일 두 개(int8, 4.9 MB)는 2026-11-22부터 git의 `public/models/ocr`에 있다(sr 모델과 같은 방식).
`npm run build`의 prebuild가 `scripts/ocr-models.mjs`로 sha256을 확인하고 그 밖의 파일은 지운다. 없거나 다르면 로컬 모델 캐시
(`OMW_MODEL_CACHE`, 기본 `%LOCALAPPDATA%\omniweave\models\ocr`)의 맞는 파일로 바꾸고, 그것도 없으면 빌드가 멈춘다(의도적으로 빼려면
`OMW_OCR_MODELS=none`). 다시 변환한 파일 넣기: `node scripts/ocr-models.mjs --seed <변환한 ppocr-*.lwt 폴더>`(변환: `scripts/convert-ppocr.mjs`,
고정 리비전은 매니페스트). 설치본에 들어가는 내용은 전과 같다(같은 파일·같은 해시 — 크기 변화 없음).

## 2026-11-20 기준 갱신 (조율)

- 10,891,717 → **10,951,450 B**(brotli q9, +59,733). 11-17 기준 이후 wip에 들어온 기능 몫: CMYK 색 관리 이식 계산(psd/2), AI 고유 데이터 편집·zstd 풀기·압축기, PSD 32비트·대지·듀오톤·칠/혼합 조건 엔진, CAD ACIS 솔리드·DWG 지시선 블록·코드 페이지, DOC 서식째 열기·문단 경계 저장, XLSX 3차원 차트·인쇄 글꼴 지표, Word 표 오른쪽 클릭 메뉴(약 2~3 KB). 중복·낭비 아닌 기능 증가라 크기 원칙(필요한 증가 허용)대로 올림.

## 2026-11-21 기준 갱신 (조율)

- 10,951,450 → **15,014,443 B**(brotli q9, +4,062,993). 거의 전부 이미지 업스케일 AI 모델(Real-ESRGAN, BSD-3) 3개 `models/sr/*.lwt` — general-x4v3 1.78 MB · general-wdn-x4v3 1.78 MB · animevideov3 0.48 MB(brotli), 코드 약 32 KB. 제품 결정으로 기본 장착(OCR처럼 설치본에 넣고 처음 쓸 때 로드)과 몇 MB 증가를 승인(2026-11-21). 모델은 시작 묶음에 들지 않고 처음 업스케일 때만 읽음. 더 줄일 때 후보: wdn 모델 빼기(−1.78 MB, 잡음 세기 조절 대신 고정).
