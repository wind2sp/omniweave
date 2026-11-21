# 엔진 한국어 문구 번역 키 초안 (src/core · src/io)

> 상태: **초안**. 코드와 언어 파일은 아직 바꾸지 않았습니다. `src/i18n/**`는 교정 팀이 작업 중이라 손대지 않았고,
> 이 문서와 `engine-keys-draft.json`만 새로 만들었습니다. (브랜치 `wip/2026-11-11`, 2026-11-11 기준)

## 1. 한눈에 보기

- 엔진(`src/core`, `src/io`, 테스트 파일 제외)에 한국어가 든 문자열·템플릿 리터럴은 **630개**입니다.
- 분류: **A 사용자 메시지 416 · B 문서에 만들어지는 기본 내용 40 · C 이미 UI에서 번역됨 122 · D 한국어로 남김 52**.
- 초안 키: **430개** = 새 키 427개(이 가운데 영어 단수형 `_one` 16개) + 이미 있는 키 재사용 3개
  (`doc.history.open`, `doc.pageName.DESIGN`, `doc.print.title`). A·B 리터럴 456개를 모두 덮습니다(같은 글은 한 키로 묶음).
- 문법 규칙 때문에 한국어를 고친 키가 66개이며, JSON에 `koOld`(지금 글)를 함께 적었습니다.
- **먼저 고칠 것:** `src/i18n/index.ts` ↔ `core`/`io` 사이의 import 순환(5장). 이걸 풀기 전에는 엔진이 `t()`를 부를 수 없습니다.

### 세는 법

안내받은 정규식 명령은 499개를 세지만, 그 정규식은 한 줄 안의 `"…"`와 `` `…` ``가 섞이면 여러 리터럴을 하나로 묶거나
리터럴이 아닌 부분까지 잡습니다(예: `formats/index.ts`의 FORMATS 목록이 큰 덩어리 몇 개로 잡힘). 이 초안은 TypeScript
구문 트리로 다시 셌습니다: 문자열 리터럴, 템플릿 리터럴(안에 든 템플릿은 따로 셈) 가운데 **자기 글자에 한글이 있는 것**,
주석 제외. 그래서 630개입니다. 객체 키와 정규식은 리터럴이 아니라 세지 않았습니다 — 예: `core/units.ts`의 입력 별칭
(`픽셀:`, `밀리미터:` …)과 `io/print.ts`의 `/^(all|모두|전체)$/`. 둘 다 **입력 인식용이라 그대로 두되**, 다른 언어의 별칭
(예: `ミリ`, `毫米`, `すべて`, `全部`)을 더할지는 따로 정하면 됩니다.

## 2. 파일별 요약

| 파일 | A | B | C | D | 합계 |
|---|--:|--:|--:|--:|--:|
| `src/io/formats/index.ts` | 131 | · | · | 2 | 133 |
| `src/core/image/ops.ts` | 1 | · | 90 | · | 91 |
| `src/io/formats/psdWrite.ts` | 23 | 3 | · | 29 | 55 |
| `src/io/formats/psd.ts` | 51 | 3 | · | · | 54 |
| `src/io/crypto/office.ts` | 30 | · | · | · | 30 |
| `src/io/formats/legacy.ts` | 18 | · | · | · | 18 |
| `src/core/types.ts` | · | 11 | 4 | 1 | 16 |
| `src/io/formats/pptx.ts` | 10 | 6 | · | · | 16 |
| `src/io/office.ts` | 2 | 2 | · | 11 | 15 |
| `src/io/print.ts` | 12 | · | 3 | · | 15 |
| `src/core/image/trace.ts` | · | · | 12 | · | 12 |
| `src/io/pdfsurgeon/write.ts` | 12 | · | · | · | 12 |
| `src/io/tools/pdfTools.ts` | 12 | · | · | · | 12 |
| `src/io/pdf.ts` | 9 | 1 | · | 1 | 11 |
| `src/io/formats/tiff.ts` | 10 | · | · | · | 10 |
| `src/core/anim.ts` | · | · | 7 | · | 7 |
| `src/io/formats/srt.ts` | 2 | 5 | · | · | 7 |
| `src/io/formats/text.ts` | 7 | · | · | · | 7 |
| `src/io/pdfVector.ts` | 5 | 2 | · | · | 7 |
| `src/io/tools/imageTools.ts` | 7 | · | · | · | 7 |
| `src/io/pdfsurgeon/filters.ts` | 6 | · | · | · | 6 |
| `src/io/platform.ts` | 6 | · | · | · | 6 |
| `src/core/history.ts` | 5 | · | · | · | 5 |
| `src/core/units.ts` | · | · | 5 | · | 5 |
| `src/io/formats/media.ts` | 5 | · | · | · | 5 |
| `src/io/formats/xlsx.ts` | 3 | · | · | 2 | 5 |
| `src/io/pdfsurgeon/ai.ts` | 5 | · | · | · | 5 |
| `src/io/pdfsurgeon/interpret.ts` | 5 | · | · | · | 5 |
| `src/core/pages.ts` | 4 | · | · | · | 4 |
| `src/core/store.ts` | 4 | · | · | · | 4 |
| `src/io/formats/epub.ts` | 4 | · | · | · | 4 |
| `src/io/formats/flow.ts` | · | 4 | · | · | 4 |
| `src/io/pdfsurgeon/decrypt.ts` | 4 | · | · | · | 4 |
| `src/io/pdfsurgeon/elevate.ts` | 2 | 2 | · | · | 4 |
| `src/io/pdfsurgeon/fonts.ts` | · | · | · | 4 | 4 |
| `src/io/crypto/cfbWrite.ts` | 3 | · | · | · | 3 |
| `src/io/crypto/hwpx.ts` | 3 | · | · | · | 3 |
| `src/io/crypto/omwCrypt.ts` | 3 | · | · | · | 3 |
| `src/core/image/run.ts` | 2 | · | · | · | 2 |
| `src/io/formats/csv.ts` | 1 | 1 | · | · | 2 |
| `src/io/omw.ts` | 2 | · | · | · | 2 |
| `src/io/pdfsurgeon/document.ts` | 2 | · | · | · | 2 |
| `src/io/pdfsurgeon/incremental.ts` | 2 | · | · | · | 2 |
| `src/core/crop.ts` | · | · | 1 | · | 1 |
| `src/core/loom.ts` | · | · | · | 1 | 1 |
| `src/io/crypto/pdfEncrypt.ts` | 1 | · | · | · | 1 |
| `src/io/export.ts` | · | · | · | 1 | 1 |
| `src/io/formats/cfb.ts` | 1 | · | · | · | 1 |
| `src/io/pdfsurgeon/index.ts` | 1 | · | · | · | 1 |
| **합계** | **416** | **40** | **122** | **52** | **630** |

`formats/index.ts`의 A 131개 가운데 41개는 FORMATS 목록의 `label`/`level`(형식 설명)입니다. 이 값은 **지금 어느 화면에도
쓰이지 않습니다**(src·scripts·tests에서 읽는 곳 없음). 초안에는 `engine.format.*`로 넣었지만 미룰 수 있습니다(7장).

### C — 이미 UI에서 번역되는 등록 정보 (새 키 없음)

UI가 `t(키, undefined, 엔진 글)` 꼴로 이미 번역해 보여 주는 것들입니다. 엔진 글은 대체값으로만 남습니다.
`tests/i18nKeys.test.ts`의 "registry-built keys" 검사가 이 키들이 있는지 이미 확인합니다.

| 수 | 파일 | 기존 키 계열 |
|--:|---|---|
| 90 | `src/core/image/ops.ts` | `image.op.<id>.label` · `.hint` · `.param.<key>` · `.param.<key>.<i>` · `.param.<key>.opt.<v>` |
| 12 | `src/core/image/trace.ts` | `image.trace.preset.<id>.label` · `.hint` |
| 7 | `src/core/anim.ts` | `doc.anim.<preset>` · `dock.anim.preset.<preset>` |
| 5 | `src/core/units.ts` | `ribbon.unit.<px·mm·cm·pt·in>` |
| 4 | `src/core/types.ts` (PAGE_PRESETS) | `doc.preset.<A4·SLIDE_16_9·ARTBOARD·SQUARE>` |
| 2 | `src/io/print.ts` (PAPERS) | `doc.print.paperSize.<Photo4x6·Photo5x7>` |
| 1 | `src/io/print.ts` (PHOTO_SIZES) | `doc.print.photo.A4` |
| 1 | `src/core/crop.ts` | `ribbon.cropRatio.free` |

`ops.ts`의 리터럴 91개 중 90개는 모두 기존 키가 있음을 확인했습니다. 나머지 1개(`알 수 없는 이미지 작업: …`)는 A입니다.

## 3. 제안 키 영역

모두 `engine.` 아래에 둡니다. 숫자는 초안의 새 키 수(`_one` 포함)입니다.

| 영역 | 키 | 담는 것 |
|---|--:|---|
| `engine.psd.*` | 78 | PSD 읽기 오류(`read.*`, 손상 위치 이름 `part.*`), 열기 경고(`warn.*`, `note.*`), 저장 오류·경고(`save.*`) |
| `engine.pdf.*` | 45 | PDF 암호·열기·원래 형식 저장, PDF 수술 분석·저장 안내(`pdf.edit.*`), 벡터 내보내기 경고(`pdf.export.*`) |
| `engine.format.*` | 41 | 형식 목록의 이름·설명(`format.<id>.label`, `format.level.*`) — 지금 화면에 안 쓰임 |
| `engine.crypto.*` | 34 | Office·HWPX·.omw·CFB 암호 처리 오류 |
| `engine.open.*` | 29 | 파일을 연 뒤 상태 줄 메시지(“DOCX 문단 n개 → n쪽” 등) |
| `engine.export.*` | 29 | 내보내기 메뉴의 이름·설명(`export.<id>.label/.hint`), “원래 형식으로 저장” |
| `engine.default.*` | 22 | 문서 안에 만들어지는 기본 이름(B): 레이어·표·본문·“{title} · {page}쪽”·PDF 제목 대체값 등 |
| `engine.tools.*` | 19 | 빠른 도구(PDF 합치기·압축, 이미지 변환) 오류·진행·결과 |
| `engine.legacy.*` | 18 | DOC·PPT·XLS·HWP(구형 바이너리) 열기 오류·제한 안내 |
| `engine.filter.*` | 15 | 열기/저장 대화상자의 파일 형식 필터 이름 |
| `engine.text.*` | 12 | JSON·XML·YAML 문법 검사 메시지, 저장 확인 |
| `engine.pptx.*` | 11 | PPTX 근사·생략 사유(`pptx.skip.*`), 오류 |
| `engine.tiff.*` | 10 | TIFF 미지원 형식 |
| `engine.print.*` | 9 | 인쇄 범위 오류, 인쇄 계획 안내, 인쇄 창 오류 |
| `engine.srt.*` | 7 | SRT 표 머리글(B)·시트 이름(B)·오류 |
| `engine.history.*` | 6 | 기록 패널 이름(기록 시작·새 문서·히스토리 복원·실행 취소/다시 실행) |
| `engine.xlsx.*` · `engine.xls.*` | 6 · 2 | Excel 열기·내보내기 |
| `engine.media.*` | 5 | 동영상·오디오 해석 오류(→ `doc.err.mediaHelp`의 `{reason}`) |
| `engine.epub.*` · `engine.pages.*` · `engine.pw.*` | 4 · 4 · 4 | EPUB 오류, 쪽 범위 입력 오류, 암호 입력 창 제목·안내 |
| `engine.image.*` · `engine.ai.*` | 3 · 3 | 이미지 작업 실패, Illustrator 안내 |
| 그 밖 | 11 | `engine.common.*`(없음·저장할까요?), `engine.office.*`, `engine.omw.*`, `engine.doc.*`, `engine.hwpx.*`, `engine.heic.*`, `engine.csv.*` |

언어 파일은 지금 규칙(“화면 묶음마다 `parts/<area>/{lang}.json` 하나”)에 맞춰 `parts/engine/{ko,en,zh,ja}.json`
하나로 시작하고, 커지면 `engine-psd`·`engine-pdf`로 나누기를 제안합니다. 교정 작업이 끝난 뒤 넣습니다.

### JSON 형식 (`engine-keys-draft.json`)

요청 형식에 다음을 더했습니다.

- `file`: 같은 글을 한 키로 묶은 경우 위치를 `", "`로 이어 적었습니다(예: `engine.filter.omw`는 세 곳).
- `koOld`: 문법 규칙 때문에 한국어를 바꾼 경우의 지금 글(템플릿 식 `${…}` 그대로). 코드가 덧붙이던 조각을 키 밖으로 뺀 경우도 포함.
- `existingKey: true`: 새로 만들지 않고 기존 키를 쓰는 3개.
- `testsMatch`: 테스트·스크립트가 글자로 확인하는 조각(6장). 한국어를 고칠 때 이 조각을 남겨야 합니다.
- `note`: 호출 쪽에서 알아야 할 것(코드가 앞뒤에 붙이는 조각, 변수에 넣을 값 등).

## 4. 문법 규칙 적용

- **한국어 — 변수 뒤 조사 없음:** `{변수}` 바로 뒤(따옴표·괄호 하나를 사이에 둔 경우 포함)에 조사가 오던 글을 모두 고쳤습니다.
  예: `${what}를 읽다가 범위를 벗어났습니다` → `범위를 벗어난 읽기: {part} (…)`,
  `레이어 '${name}'가 너무 큽니다` → `레이어가 너무 큽니다: '{name}'`,
  `색상 모드 ${mode}는 지원하지 않습니다` → `지원하지 않는 색상 모드입니다: {mode}`,
  `${notes}는 화면에 그대로 그리지 못하지만…` → `화면에 그대로 그리지 못하는 요소가 있습니다({notes}) — …`,
  `${img.mime}은 변환이 필요합니다` → `{name}: 변환이 필요한 형식입니다 ({mime})`,
  `${FMT}로 저장 (.${ext}은 쓰기 미지원)` → `{fmt} 형식으로 저장 (.{ext} 쓰기 미지원)`.
  “{n}쪽은”, “{n}개를”처럼 **단위 명사 뒤**의 조사는 변수 뒤가 아니므로 그대로 두었습니다. 그래서 받침 도우미가 필요한 키는 없습니다.
- **한국어 — 합니다체:** 오류·안내 문장 가운데 명사로 끝나던 것을 합니다체로 맞췄습니다(예: `LZW 데이터 손상` → `LZW 데이터가 손상되었습니다`,
  `인코딩 실패` → `인코딩에 실패했습니다`). 메뉴 이름·필터 이름·목록 항목(근사·생략 사유, PSD `note.*`, 진행 표시)은 명사구로 둡니다.
- **영어 복수:** 수가 하나인 문장은 `_one` 키를 따로 두었습니다(16개). 호출은 UI에 이미 있는 `tn(key, n, vars)`
  (`ui/actions.ts:42`, `ui/pageActions.ts:20`) 방식을 그대로 쓰면 되도록 **세는 변수는 모두 `{n}`**입니다.
  수가 둘 이상인 요약 줄(예: `DOC text · blocks: {blocks} → pages: {pages}`)은 “이름: 수” 꼴로 써서 복수 일치 문제를 피했습니다.
- **일본어:** 문장은 です・ます체, 따옴표는 「」. 콜론·괄호는 기존 일본어 파일처럼 반각을 썼습니다.
- **중국어:** 간체, 전각 문장부호(，：；（）“”——。). 시간 형식 `00:00:01,000`, 쪽 범위 `1-3, 5` 같은 **입력 예시**만 반각입니다.
- **자리표시:** 네 언어의 `{변수}`가 키마다 똑같은지 스크립트로 확인했습니다. `engine.text.unclosedBracket`의 `{`는 글자 그대로이며
  `t()`의 `/\{(\w+)\}/`에 걸리지 않습니다.

## 5. 먼저 고칠 구조 문제 — import 순환

**지금:** `src/i18n/index.ts`가 `../core/types`(DEFAULT_TITLE)와 `../io/platform`(isTauri)을 import하고,
`io/platform.ts`는 `./formats`(ALL_EXTS)를 import합니다. 엔진 파일이 `t`를 import하면
`io/formats → i18n → io/platform → io/formats`, `core/types → i18n → core/types` 순환이 생깁니다.
ES 모듈 순환에서는 먼저 평가되는 쪽이 아직 초기화되지 않은 값(`DEFAULT_TITLE`, `ALL_EXTS`, `FORMATS`)을 보게 되어
불러오는 순서에 따라 `undefined`나 TDZ 오류가 납니다.

**준비된 패치** (`i18n-decouple.patch`, 세션 scratchpad에 있음 — 저장소에는 넣지 않음):

1. `src/i18n/index.ts`
   - `import { DEFAULT_TITLE } from "../core/types"`와 `import { isTauri } from "../io/platform"`을 지웁니다.
   - `isTauri`를 그 자리에서 계산합니다: `typeof window !== "undefined" && "__TAURI_INTERNALS__" in window` —
     `io/platform.ts:5`와 같은 식입니다.
   - `export const DEFAULT_TITLE = "제목 없음"`을 여기로 옮기고 “core·io에서 import하지 않는다”는 주석을 붙입니다.
2. `src/core/types.ts`
   - `import { DEFAULT_TITLE } from "../i18n"`을 더하고, 상수 정의를 `export { DEFAULT_TITLE }`로 바꿔 **다시 내보냅니다.**
     그래서 `ui/shell/TopBar.tsx` 등 기존 import는 그대로 동작합니다. 값(`"제목 없음"`)은 바뀌지 않습니다(D2).

적용 후 의존 방향은 `core/io → i18n`의 한 방향만 남습니다. `git apply --check`로 지금 브랜치에 깨끗하게 들어감을 확인했습니다(적용은 안 함).

**적용 전에 확인할 점**

- 패치가 **`src/i18n/index.ts`를 고칩니다.** 교정 팀이 `src/i18n/**`를 작업 중이므로 그쪽과 시점을 맞춰야 합니다(JSON만 만지는 중이면 충돌은 없음).
- `core/types`가 i18n을 불러오면 모든 언어 사전(JSON)과 zustand가 core에 딸려 옵니다. 이미지 **워커**(`core/image/worker.ts`)는 지금
  `core/types`를 불러오지 않아 괜찮지만, 워커 안에서 `t()`를 부르면 워커는 UI 언어를 모르므로 늘 한국어가 됩니다.
  그래서 워커에서 던지는 오류(`engine.image.unknownOp` 등)는 **코드로 던지고 메인 스레드(`core/image/run.ts`)에서 번역**하기를 권합니다.
- `tests/i18nKeys.test.ts`의 “literal keys passed to t…” 검사는 접두어 목록(`doc|dock|image|ribbon|shell|quick|cmd|menu|about|prefs`)에
  있는 키만 확인합니다. **`engine`을 목록에 더해야** 엔진 키 누락이 잡힙니다. `tests/i18nCoverage.test.ts`의 “한국어 리터럴 없음” 검사도
  지금은 `src/ui`만 보므로, 옮긴 뒤 `src/core`·`src/io`로 넓히고 D 목록을 허용 목록(ALLOWED)으로 두면 됩니다.

## 6. D — 한국어로 남길 것

| # | 수 | 위치 | 글 | 남기는 이유 | 권장 |
|---|--:|---|---|---|---|
| D1 | 1 | `core/loom.ts:215` | 제목 없음 | 문서 제목 기준값(DEFAULT_TITLE)과 같은 값. `docTitle()`이 이 값과 비교해 화면 언어로 바꿔 보여 줍니다. | 리터럴 대신 `DEFAULT_TITLE` 상수를 쓰기 |
| D2 | 1 | `core/types.ts:458` | 제목 없음 | `DEFAULT_TITLE`: 새 문서에 저장되는 기준값. `docTitle()`·TopBar가 비교합니다. 값을 바꾸면 기존 .omw 파일 제목이 번역되지 않습니다. | 5장 패치로 i18n으로 옮기되 값은 유지 |
| D3 | 1 | `io/export.ts:65` | [PDF] 벡터 PDF 내보내기 실패 — … | 개발자용 `console.warn` — 사용자에게 보이지 않음 | 영어 로그로 바꾸기 (번역 키 불필요) |
| D4 | 3 | `io/formats/index.ts:537`, `:581`, `io/pdf.ts:397` | 저장 취소 | 취소 신호. `ui/actions.ts:542`, `ui/pageActions.ts:161`·`:197`이 `e.message === "저장 취소"`로 비교해 `doc.toast.saveCancelled`를 띄웁니다. 번역하면 비교가 깨집니다. | `throw new Error("SAVE_CANCELLED")`(또는 `SaveCancelled` 클래스)로 바꾸고 UI 세 곳 비교도 함께 바꾸기 |
| D5 | 28 | `io/formats/psdWrite.ts:1358`~`:1451` (`checkPsd()`) | 헤더 크기 …, 연결 파일(…) …, 레이어 {i}: … | 저장 전 구조 검사 진단. 테스트(`tests/psd/photoshop-rules.test.ts`의 “헤더 크기”·“연결 파일”·“배경”·`/RLE\|구조/`, `tests/psd/psd.test.ts`의 “연결 파일”)와 `scripts/make-interop-kit`이 글자로 확인하고, `psdWrite.ts:1462`가 `startsWith`로 거릅니다. 사용자에게는 `engine.psd.save.checkFailed` 뒤에 기술 부록으로만 붙습니다. | `{ code: "HEADER_SIZE", args }` 꼴 진단 코드로 바꾸고, 보여 줄 때만 `engine.psd.check.<code>`로 번역 |
| D6 | 1 | `io/formats/psdWrite.ts:1462` | 연결 파일( | D5 결과를 `p.startsWith("연결 파일(")`로 거르는 비교값 | 진단 코드(`LINKED_ORPHAN`)로 비교 |
| D7 | 2 | `io/formats/xlsx.ts:83`, `:87` | 맑은 고딕 | 글꼴 이름 — XLSX에 그대로 쓰고, 읽을 때도 이 이름과 비교합니다. 테스트가 확인. | 그대로 |
| D8 | 9 | `io/office.ts:51`, `:54` | 맑은 고딕·바탕·바탕체·굴림·굴림체·돋움·돋움체·궁서·궁서체 | DOCX/HWPX의 글꼴 이름과 비교하는 줄 간격 대응표. 번역하면 매칭이 깨집니다. | 그대로 |
| D9 | 2 | `io/office.ts:1078`, `:1082` | 바탕글, 개요 {n} | HWPX 표준 스타일 이름 — 파일 형식의 일부. `tests/quality/officeStructure.test.ts`가 `name="개요 1"`을 확인. | 그대로 (`engName`이 이미 함께 쓰임) |
| D10 | 4 | `io/pdfsurgeon/fonts.ts:358`, `:390`, `:392`, `:439` | Type3 글꼴(그림 글자) 등 | 내부 표시값: `font.unsupported`는 참/거짓으로만 쓰입니다(`elevate.ts:102`). 화면에 나오지 않습니다. | `"type3"`·`"badCMap"`·`"vertical"`·`"cidNoToUnicode"` 같은 코드로 바꾸고, 사유를 보여 줄 때 키를 만들기 |

## 7. 구현할 때 참고

- **던지는 오류:** 대부분 `throw new Error("…")`입니다. 던질 때 `t()`로 번역해도 되지만, UI가 메시지를 비교하거나(D4)
  워커에서 던지는 경우(5장)는 코드로 던지고 보여 줄 때 번역하는 편이 안전합니다. 오류가 많은 영역(`engine.crypto.*`, `engine.psd.read.*`)은
  나중에 `EngineError(code, vars)` 하나로 모으는 것도 고려할 만합니다.
- **코드가 이어 붙이는 조각:** `engine.open.*`의 “ · 경고”, `engine.pptx.skipped`의 목록, `engine.psd.warn.notDrawn`의 `{notes}` 등은
  조각 키를 각각 번역한 뒤 코드가 `" · "`·`"·"`로 잇습니다(JSON `note`에 적음). PPTX 생략 사유는 지금 한국어 글을 집계 키로 쓰므로
  (`ctx.skipped[사유]++`) 사유 코드로 모으고 보여 줄 때 번역하기를 권합니다.
- **B(기본 내용)는 만들 때의 언어로 고정됩니다.** UI의 `doc.pageName.*`, `ribbon.layer.name`처럼 “만드는 순간 현재 언어”로 넣으면 되고,
  나중에 언어를 바꿔도 이미 만든 이름은 그대로입니다. `newDocument()`의 “아트보드 1”은 기존 키 `doc.pageName.DESIGN`(n = 1)을 씁니다.
- **시간 표시:** `core/history.ts:102`가 `toLocaleTimeString("ko-KR")`로 고정돼 있어, `engine.history.restored`의 `{time}`은 현재 언어 로캘로 만들어야 합니다.
- **테스트가 확인하는 한국어 (54개 키):** 테스트는 기본 언어(ko)로 돌기 때문에 키로 옮겨도 한국어 글이 같으면 통과합니다. 고친 한국어도
  테스트 조각은 남겼습니다(예: “9쪽은 없습니다”, “레이어 효과 1개”, “빠진 개체 1개”, “무결성”, “구형 바이너리”, “반복 횟수”, “배포용”,
  “PDF 호환 파일 만들기”, `REFUSAL_REASON`의 `/암호|DRM|배포용|PDF 호환 (사본|정보)/`). 교정 팀이 ko를 다시 다듬을 때는 JSON의 `testsMatch`를 확인해 주세요.
- **이름이 겹치는 기존 키:** `engine.default.path`=`shell.name.path`, `engine.default.line`=`shell.name.line`, `engine.default.table`=`cmd.insert.table`,
  `engine.default.untitled`=`shell.untitled`, `engine.filter.group.media`=`menu.filter.media`. 따로 둔 것은 쓰임(문서 안 이름 / 메뉴 이름)이 달라서입니다.
  하나로 합칠지는 교정 팀이 정하면 됩니다.
- 기존 영어 `doc.toast.elevated`가 “line(s)”를 써서 복수 규칙과 맞지 않습니다(이번 범위 밖, 참고로만 적음).

## 8. 정할 것

1. **FORMATS `label`/`level` 41개**(`engine.format.*`): 지금 화면에 안 나옵니다. 번역해 둘지, 목록 화면이 생길 때로 미룰지.
2. **D5 `checkPsd()` 진단 28개:** 진단 코드로 바꾼 뒤 번역할지(권장), 기술 부록이라 한국어로 둘지.
3. **PSD 읽기 세부 오류**(`engine.psd.read.*`·`engine.psd.part.*` 약 30개): 바이트 위치가 든 기술 정보인데 A로 넣었습니다. D5처럼 코드화할지.
4. **5장 패치 적용 시점:** `src/i18n/index.ts`를 고치므로 교정 팀과 맞춰야 합니다.
5. **“저장 취소”(D4)를 코드로 바꾸는 작업**은 `src/io`와 `src/ui` 세 곳을 함께 고쳐야 합니다 — 엔진 번역 첫 단계에 넣을지.
6. 필터 이름 “이미지”(`engine.filter.images`, platform.ts)와 UI의 `menu.filter.images`(“그림”)가 다릅니다 — 하나로 맞출지.
7. 입력 별칭(`core/units.ts`의 `밀리`·`센티`…, `io/print.ts`의 `모두|전체`)에 다른 언어 별칭을 더할지.
