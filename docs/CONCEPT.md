# Omniweave 개념 — 파일 형식은 출구일 뿐

> 이 문서는 Omniweave가 "왜 하나의 편집기로 여러 형식을 다룰 수 있다고 보는지"와 "그 주장이 어디까지 사실인지"를 함께 적습니다.
> 구현된 것은 현재형으로, 계획은 **(로드맵)** 으로 표시합니다.

## 1. 출발점: 여섯 프로그램은 같은 일을 한다

이미지 편집기, 일러스트 도구, PDF 편집기, 워드프로세서, 한글 워드프로세서, 프레젠테이션 도구.
겉모습은 다르지만, 사용자가 손으로 하는 일을 적어 보면 거의 같은 목록이 나옵니다.

| 사용자가 하는 일 | 이미지 편집 | 일러스트 | PDF | 워드 | 한글 | 슬라이드 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 이미지를 놓는다 | ● | ● | ● | ● | ● | ● |
| 글자를 쓰고 서식을 바꾼다 | ● | ● | ● | ● | ● | ● |
| 도형·선을 그린다 | ● | ● | ● | ● | ● | ● |
| 개체를 선택해 위치·크기·회전을 바꾼다 | ● | ● | ● | ● | ● | ● |
| 색·투명도·겹침 순서를 바꾼다 | ● | ● | ● | ● | ● | ● |
| 실행 취소한다 | ● | ● | ● | ● | ● | ● |

차이는 **어디에 무게를 두느냐**입니다. 이미지 편집기는 픽셀, 일러스트 도구는 곡선, 워드프로세서는 문단의 흐름,
슬라이드 도구는 시간 축에 무게를 둡니다. 그러나 이것은 *기능의 깊이* 차이이지 *편집 대상의 본질* 차이가 아닙니다.

## 2. 핵심 주장: 형식의 차이는 "저장 모양"의 차이다

흔히 이런 경계가 넘을 수 없는 벽처럼 이야기됩니다.

- **페이지 vs 레이어** — 문서는 쪽이 이어지고, 그림은 층이 쌓인다.
- **벡터 vs 비트맵** — 곡선은 수식이고, 그림은 점이다.
- **흐름 vs 고정 배치** — 워드 문단은 흘러내리고, PDF 글자는 박혀 있다.

하지만 편집하는 순간에는 모두 같은 질문으로 바뀝니다. *"이 개체는 어디에, 어떤 속성으로 있는가?"*

- 쪽은 **크기가 정해진 캔버스**이고, 레이어는 **그 캔버스 위 개체의 겹침 순서**입니다. 둘은 공존할 수 있습니다.
- 벡터 노드와 래스터 노드는 같은 변형(transform)·불투명도·혼합 모드를 가집니다. 다른 것은 "어떻게 그리느냐"뿐입니다.
- 흐르는 문단도 결국 **폭이 정해진 텍스트 상자**에 조판되어 쪽마다 놓입니다(Omniweave의 `paginate`가 하는 일).

그래서 Omniweave는 편집 중에는 하나의 모델(씬 그래프)만 쓰고, 형식은 **들어오는 문(가져오기)과 나가는 문(내보내기)** 에서만 다룹니다.

> **파일 형식은 출구일 뿐, 편집은 하나의 씬 그래프에서.**

## 3. 씬 그래프 한눈에

`src/core/types.ts` 기준입니다.

```text
OmwDocument
├── pages[]   : Page  (kind = DESIGN | DOCUMENT | SLIDE | PDF)
│   ├── width, height, background
│   ├── masterId         → masters[] 중 하나 (슬라이드 마스터)
│   ├── transition       { NONE | FADE | SLIDE_LEFT | ZOOM, duration }
│   ├── animations[]     키프레임 애니메이션 (대상 노드 id, 트리거, 속성, 키프레임)
│   └── nodes[]   : SceneNode (아래 → 위 순서)
│        공통: id, name, visible, locked, opacity, blendMode, transform{x,y,rotation,scale}
│        ├── RASTER  tiles: { "tx_ty": PixelTile(256×256 RGBA, hash) }
│        ├── VECTOR  contours[]: 베지어 기준점·핸들, fill, stroke, fillRule
│        ├── TEXT    width, paragraphs[] → runs[], wordBreak(keep-all|normal)
│        ├── IMAGE   assetId, width, height
│        └── PDF     assetId, pageIndex, covers[] (승격된 글자를 덮는 사각형)
├── masters[] : Page
└── assets    : { id → AssetRef(hash, mime, name, size) }
```

## 4. 형식별 매핑 표

"현재"는 코드에 구현된 매핑, **(로드맵)** 은 아직 없는 것입니다.

### 4.1 Word (DOCX, ECMA-376 Office Open XML) — `src/io/office.ts`

| DOCX 개념 | Omniweave | 상태 |
|---|---|---|
| `w:body` 문서 본문 | A4 `DOCUMENT` 페이지들 + 쪽마다 `TEXT` 노드 (`paginate`) | 현재 |
| `w:p` 문단 | `TextParagraph` | 현재 |
| `w:jc` 정렬 (left/center/right/both/distribute) | `align` LEFT/CENTER/RIGHT/JUSTIFY | 현재 |
| `w:spacing@line`, `@after` | `lineSpacing`, `spaceAfter` | 현재 |
| `w:ind@firstLine` | `indent` | 현재 |
| `w:pStyle` 제목 스타일(Heading N) | 글자 크기를 키우고 굵게 (단순화) | 현재 |
| `w:r` 런, `w:b` `w:i` `w:u` `w:sz` `w:color` `w:rFonts` | `TextRun` (bold, italic, underline, fontSize, color, fontFamily) | 현재 |
| `styles.xml`의 기본 글자 크기 | 기본 `fontSize` | 현재 |
| `w:tbl` 표 | 표 안 문단을 순서대로 펼침 → **(로드맵)** 표 노드 | 부분 |
| 그림(`w:drawing`), 도형, 수식 | — **(로드맵)** `IMAGE`/`VECTOR` 노드로 | 없음 |
| 머리말·꼬리말, 각주·미주, 쪽 번호, 변경 내용 추적, 주석 | — | 없음 |

### 4.2 한글 (HWPX, KS X 6101 OWPML) — `src/io/office.ts`

| HWPX 개념 | Omniweave | 상태 |
|---|---|---|
| `Contents/section*.xml`의 `hp:p` | `TextParagraph` | 현재 |
| `header.xml`의 `hh:paraPr` (`align@horizontal`, `lineSpacing` PERCENT, `intent`, `next`) | `align`, `lineSpacing`, `indent`, `spaceAfter` | 현재 |
| `hh:charPr` (`height`, `bold`, `italic`, `underline`, `textColor`, `fontRef@hangul`) | `TextRun` | 현재 |
| `hh:fontface lang="HANGUL"` 글꼴 목록 | `fontFamily` | 현재 |
| 표를 담은 컨테이너 문단 | 안쪽 문단을 순서대로 방문 → **(로드맵)** 표 노드 | 부분 |
| 그림·도형·수식·각주·머리말/꼬리말·쪽 테두리 | — | 없음 |
| 구형 HWP 바이너리(OLE) | 다루지 않음 (계획 없음) | — |

### 4.3 PDF (ISO 32000) — `src/io/pdf.ts`

| PDF 개념 | Omniweave | 상태 |
|---|---|---|
| 페이지 | `PDF` 페이지 + 잠긴 `PDF` 노드 (pdf.js 렌더, 원본은 자산으로 보관) | 현재 |
| 텍스트 내용 (`getTextContent`) | "승격": 기준선이 같은 조각을 한 줄로 묶어 `TEXT` 노드로, 원래 글자는 표본 배경색 `covers`로 가림 | 현재 |
| 벡터 그래픽 (경로 연산자) | — **(로드맵)** `VECTOR` 노드로 승격 | 없음 |
| 이미지 XObject | — **(로드맵)** `IMAGE` 노드로 승격 | 없음 |
| 내보내기 | 페이지를 PNG로 그려 PDF에 넣음 (글자 선택 불가) → **(로드맵)** 벡터·텍스트 유지 PDF | 부분 |
| 주석·양식·서명·암호화 | — | 없음 |

### 4.4 슬라이드 (PowerPoint 개념) — `src/core/anim.ts`, `src/ui/Presenter.tsx`

| 슬라이드 개념 | Omniweave | 상태 |
|---|---|---|
| 슬라이드 | `SLIDE` 페이지 (기본 1280×720) | 현재 |
| 슬라이드 마스터 | `masters[]` + 페이지의 `masterId` (마스터 노드가 먼저 그려짐) | 현재 |
| 전환 | `transition` FADE / SLIDE_LEFT / ZOOM + 지속 시간 | 현재 |
| 애니메이션 (클릭 시 / 이전과 함께 / 이전 후) | `KeyframeAnimation` (OPACITY, TRANSLATION, SCALE, ROTATION, 이징) | 현재 |
| 슬라이드 쇼 | 전체 화면 발표 (클릭 단계 진행) | 현재 |
| PPTX 파일 | — **(로드맵)** 가져오기/내보내기 | 없음 |
| 모핑·동영상·경로 애니메이션·발표자 노트 | — | 없음 |

### 4.5 이미지·일러스트 개념

| 개념 | Omniweave | 상태 |
|---|---|---|
| 픽셀 레이어 | `RASTER` 노드 (희소 256px 타일) | 현재 |
| 브러시·지우개 | `src/render/brush.ts` (필압, 경도, 불투명도) | 현재 |
| 레이어 불투명도·혼합 모드 | `opacity`, `blendMode` (NORMAL/MULTIPLY/SCREEN/OVERLAY/HARD_LIGHT) | 현재 |
| 패스 (베지어) | `VECTOR` 노드 `contours` | 현재 |
| 패스파인더 | 합치기/빼기/교차/제외 (다각형으로 펼쳐 계산) | 현재 |
| 붙여넣은 이미지 | `IMAGE` 노드 + 내용 주소 자산 | 현재 |
| PSD·AI 파일 | — (계획 없음, 공개 사양 범위 검토 필요) | 없음 |

## 5. 왕복(round-trip) 전략

### 5.1 지금 방식: "이해한 만큼 새로 쓴다"

현재 DOCX/HWPX 내보내기는 Omniweave가 이해한 내용(문단·런·정렬·간격)으로 **새 패키지를 처음부터 씁니다**.
장점은 단순하고 결과가 항상 유효하다는 것, 단점은 **가져올 때 이해하지 못한 부분이 사라진다**는 것입니다.
표, 각주, 머리말/꼬리말, 그림, 스타일 정의, 문서 속성 등이 여기에 해당합니다.

### 5.2 제안 **(로드맵)**: 패스스루(pass-through)

목표: *"이해한 부분만 바꾸고, 이해하지 못한 부분은 원본 그대로 돌려준다."*

1. **원본 보관.** 가져온 DOCX/HWPX 패키지 전체를 내용 주소 자산으로 `.omw`에 넣습니다 (지금도 PDF 원본은 이렇게 보관합니다).
2. **출처 표시.** 가져온 각 문단·런 노드에 원본 위치(파일 경로 + 요소 순번/경로)와 가져올 때의 해시를 기록합니다.
3. **변경 감지.** 내보낼 때 노드의 현재 해시와 가져올 때의 해시를 비교합니다. Loom이 이미 모든 노드에 내용 주소를 매기므로 추가 비용이 거의 없습니다.
4. **부분 재작성.** 바뀐 문단만 원본 XML에서 해당 요소를 교체하고, 나머지 파트(표, 각주, 스타일, 그림, 사용자 정의 XML)는 바이트 그대로 다시 압축합니다.
5. **새 개체.** Omniweave에서 새로 만든 개체(벡터, 래스터 등)는 원 형식이 표현할 수 있으면 그 형식의 요소로(예: 그림), 없으면 이미지로 그려 넣고 사용자에게 알립니다.
6. **보고.** 내보내기 결과에 "그대로 보존 / 다시 씀 / 이미지로 대체 / 손실" 개수를 보여 줍니다.

이 방식은 "Omniweave에서 열었다가 저장했더니 표가 사라졌다"를 막는 것이 목적입니다.
완벽한 왕복을 약속하지는 않습니다. 구조를 크게 바꾸는 편집(문단을 다른 쪽 표 안으로 옮기기 등)은 여전히 손실이 생길 수 있고, 그 경우 보고합니다.

### 5.3 형식별 정직한 기대치

| 왕복 | 지금 | 패스스루 이후 기대 |
|---|---|---|
| DOCX → Omniweave → DOCX | 문단·글자 서식만 유지 | 편집하지 않은 부분은 원본 그대로 |
| HWPX → Omniweave → HWPX | 문단·글자 서식만 유지 | 편집하지 않은 부분은 원본 그대로 |
| PDF → Omniweave → PDF | 이미지 PDF (글자 선택 불가) | 원본 페이지 유지 + 바뀐 부분만 덧씀 (검토 중) |
| 슬라이드 → PDF/PNG | 가능 (전환·애니메이션은 정지 화면) | 동일 |
| `.omw` → `.omw` | 무손실 (해시 검증, 문서 루트 주소 일치) | 동일 |

## 6. 이 접근의 한계를 먼저 말하기

- 통합 편집기는 각 분야 전문 도구의 **깊이**를 바로 따라잡지 못합니다. Omniweave의 강점은 "한곳에서, 같은 방식으로"이지 "모든 기능"이 아닙니다.
- 형식 간 개념이 1:1로 맞지 않는 경우가 있습니다(예: 워드의 흐르는 표 ↔ 슬라이드의 고정 배치). 이런 곳은 매핑 표에 "부분/없음"으로 남겨 둡니다.
- 독점 바이너리 형식(구형 HWP, PSD, AI 등)은 클린룸 원칙상 공개 사양이 충분할 때만 검토합니다.
