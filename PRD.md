# [PRD/Architecture Guide] Omniweave (오메) - 6-in-1 초고성능 차세대 스튜디오 엔진

* **프로젝트 명칭:** Omniweave (오메)
* **전용 통합 확장자:** `.omw` (Omniweave Workspace Package)
* **타깃 환경:** Windows / macOS / Linux / Web Browser (Cross-Platform)
* **핵심 권장 기술 스택:** Rust (Native/WASM Core Engine) + Tauri + WebGPU / WebGL2 + TypeScript / React

---

## 1. 프로젝트 비전 및 시스템 아키텍처 개요

Omniweave는 6개 도메인(래스터·PSD, 벡터·AI, PDF 객체, DOCX 문서, HWPX 서식, PPTX 슬라이드 타임라인)을 단일 캔버스 하이프라인에서 직조(Weave)하여 구동하는 올인원 경량화 스튜디오입니다.

### 1.1. 시스템 계층 아키텍처 (Layered Architecture)

```
+-----------------------------------------------------------------------------------+
|               Adaptive Ribbon UI & Floating Context Menu (React / Web UI)          |
+-----------------------------------------------------------------------------------+
|                 State Orchestrator & Undo/Redo Engine (Zustand + CRDT)            |
+-----------------------------------------------------------------------------------+
|                     Omniweave Unified Scene Graph (Rust AST)                      |
| [Raster Node] | [Vector Node] | [Text Flow Engine] | [Slide Deck] | [PDF Annotation]  |
+-----------------------------------------------------------------------------------+
|               Rendering & Pipeline Core Engine (Rust + WebGPU / wgpu)             |
|   - Tile-based Raster Pipeline       - Vector Bézier Tessellation (Vello/wgpu)    |
|   - Text Layout & Font Rasterizer    - Animation Easing & Transition Engine       |
+-----------------------------------------------------------------------------------+
|                       Storage & IO Engine (.omw Packager)                         |
|   - Zip Container / CBOR Binary Parser   - Dynamic Asset Loader (Lazy Evaluation)   |
+-----------------------------------------------------------------------------------+
```

---

## 2. 6대 핵심 모듈별 구체적 기술 명세 & 시행착오 방지 가이드

### 2.1. 래스터 모듈 (PSD·이미지) - 타일 기반 픽셀 파이프라인

#### A. 고난도 기술 구조 (Tile-Based Quad-Tree Raster Engine)
단순 4K/8K 통 캔버스를 `CanvasRenderingContext2D`에 그리게 되면 RAM 상주량이 GB 단위로 폭증하고 줌/팬(Zoom/Pan) 시 프레임 드랍이 발생합니다.
* **해결 구조:** 캔버스를 $256 \times 256$ 픽셀 단위의 타일(Tile) 격자로 쪼개고, 쿼드트리(Quad-Tree) 알고리즘을 활용해 현재 뷰포트(Screen Viewport)에 보이는 타일만 WebGPU 텍스처 메모리에 바인딩합니다.

#### B. 메모리 데이터 구조체 (TypeScript/Rust 타입 명세)
```typescript
interface PixelTile {
  tileId: string;       // "x_y_zoom"
  x: number;
  y: number;
  size: number;         // default: 256
  isDirty: boolean;     // 재렌더링 필요 여부
  data: Uint8ClampedArray | ImageBitmap; // RGBA 픽셀 버퍼
}

interface RasterLayer {
  id: string;
  type: 'RASTER';
  opacity: number;
  blendMode: 'NORMAL' | 'MULTIPLY' | 'SCREEN' | 'OVERLAY' | 'HARD_LIGHT';
  tiles: Map<string, PixelTile>; // Sparse Matrix 타일 맵
  transform: Matrix3x3;
}
```

#### C. 시행착오 방지 (Risk Mitigation)
* **브러시 획(Stroke) 그리기 시 마우스 지연(Lag):**
  * `pointermove` 이벤트는 CPU 스레드에서 무겁게 동작합니다. 브러시 입력 좌표는 `OffscreenCanvas` 또는 Web Worker로 직행시키고, 렌더링 피드백은 WebGPU 프레임 버퍼로 즉시 전송하는 **비동기 듀얼 스레드 드로잉 파이프라인**을 구축해야 합니다.

---

### 2.2. 벡터 모듈 (AI·SVG·PDF 벡터) - GPU 테셀레이션 & 베지어 연산

#### A. 고난도 기술 구조 (Bézier Curve Tessellation)
3차 베지어 곡선(Cubic Bézier Curve)을 CPU에서 픽셀로 변환(Rasterization)하면 패스가 많아질수록 메인 스레드가 정지합니다.
* **해결 구조:** 3차 베지어 패스를 GPU Compute Shader를 이용해 실시간 삼각형 메쉬(Tessellation)로 변환한 후 렌더링하는 `wgpu` / `Vello` 기반 파이프라인을 채택합니다.

#### B. 데이터 구조체 (Bézier Node AST)
```rust
pub struct VectorNode {
    pub id: String,
    pub anchor: (f32, f32),      // 기준점 Anchor Point
    pub handle_in: (f32, f32),   // 제어점 Control Point In
    pub handle_out: (f32, f32),  // 제어점 Control Point Out
    pub is_corner: bool,
}

pub struct VectorPath {
    pub id: String,
    pub nodes: Vec<VectorNode>,
    pub fill_color: Option<RGBA>,
    pub stroke_color: Option<RGBA>,
    pub stroke_width: f32,
    pub closed: bool,
}
```

#### C. 시행착오 방지 (Risk Mitigation)
* **패스파인더(Pathfinder - 합치기/빼기) 연산 병목:**
  * CPU에서 3D/2D 불리언 연산을 직접 작성하면 엣지 케이스에서 무한 루프나 메모리 잼이 생깁니다. C++ 오픈소스 라이브러리인 `Clipper2`를 WASM으로 바인딩하여 래핑(Wrapping) 사용하는 것이 가장 안전합니다.

---

### 2.3. PDF 모듈 (Acrobat Pro 대안) - Object Stream 승격 파이프라인

#### A. 고난도 기술 구조 (PDF AST Node Elevation)
PDF는 렌더링 전용 명령집합(`Do`, `TJ`, `cm` 등)으로 꼬여있어 단순 PDF.js 사용 시 텍스트나 도형을 픽셀 단위로 수정할 수 없습니다.
* **해결 구조:** PDF.js를 통해 단순 백그라운드 렌더링을 1차 수행하고, 수정 버튼 클릭 시 PDF Content Stream 문맥을 역파싱(Reverse-parse)하여 `VectorPath` 및 `TextNode`로 **가상 개체 승격(Elevation)**을 수행합니다.

#### B. 시행착오 방지 (Risk Mitigation)
* **폰트 미임베딩 처리 문제:**
  * PDF 내의 임베디드 폰트 폰트 파싱 오류 시 텍스트 깨짐 현상이 일어납니다. 시스템 기본 폰트(Arial, Noto Sans)로 Fallback 처리함과 동시에 `pdf-lib` 구조를 활용해 폰트 폭(Glyph Width) 계산 보정 레이어를 얹어야 합니다.

---

### 2.4. DOCX·HWPX 문서 모듈 - 통합 타이포그래피 파이프라인

#### A. 고난도 기술 구조 (HWPX & OpenXML Parser)
구형 HWP 바이너리(OLE 구조)는 역공학 리스크가 크므로 포기하고, 국가 표준 개방형 포맷인 **HWPX(XML 기반 zip 구조)**와 **DOCX(OpenXML)** 파서에 전념합니다.

#### B. 문서 단락 레이아웃 파이프라인 (Text Layout Engine)
```typescript
interface TextParagraph {
  id: string;
  runs: TextRun[];
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  lineSpacing: number;
  indent: number;
}

interface TextRun {
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
}
```

#### C. 시행착오 방지 (Risk Mitigation)
* **한글 자소 분리 및 굴림/장평 연산 이슈:**
  * 웹 렌더링 시 한글 조합형 자소가 분리되는 현상이 발생할 수 있습니다. Canvas/DOM 렌더링 시 `Intl.Segmenter`를 사용하여 문자열 조각(Grapheme Cluster) 단위를 보장하고 폰트 metrics를 세밀히 측정해야 합니다.

---

### 2.5. 슬라이드 모듈 (PPTX) - 슬라이드 마스터 & 타임라인 타임코드

#### A. 고난도 기술 구조 (Time-Keyframe Easing Pipeline)
슬라이드 애니메이션 연산을 캔버스 렌더링 루프와 결합하면 프레임 저하가 일어납니다.
* **해결 구조:** Web Animations API 혹은 독립된 타임라인 트랙 스케줄러를 구동하여 각 개체(Object)의 `Transform` 값을 GPU 프레임에 맞춰 보간(Interpolation) 연산합니다.

#### B. 데이터 구조체 (Slide Deck & Animation AST)
```typescript
interface Slide {
  id: string;
  masterLayoutId: string;
  elements: string[]; // Scene Graph Node IDs
  transitions: {
    type: 'FADE' | 'SLIDE_LEFT' | 'ZOOM';
    duration: number; // ms
  };
  animations: KeyframeAnimation[];
}

interface KeyframeAnimation {
  targetNodeId: string;
  trigger: 'ON_CLICK' | 'WITH_PREVIOUS' | 'AFTER_PREVIOUS';
  property: 'OPACITY' | 'TRANSLATION' | 'SCALE' | 'ROTATION';
  keyframes: { time: number; value: any; easing: string }[];
}
```

---

## 3. 전용 파일 포맷 `.omw` 바이너리 패키징 명세

### 3.1. 압축 컨테이너 내부 맵 (Zip Archive Structure)
`.omw` 포맷은 데이터 보존 및 초고속 입출력을 위해 아래와 같이 엄격한 계층을 유지합니다.

```text
document.omw
├── manifest.json              # 메타데이터, 모드, 생성일, 인덱스 맵
├── scene_graph.cbor           # 바이너리로 직렬화된 통합 씬 그래프 (Rust CBOR)
├── /slides                    # PPT 슬라이드 구성 정보
│   ├── slide_deck.json
│   └── master_styles.json
├── /vectors                   # SVG 기반 벡터 노드 좌표 및 베지어 파스 데이터
│   └── paths.json
├── /rasters                   # 포토샵 레이어 픽셀 데이터 (WebP / Raw Tiles)
│   ├── layer_1.webp
│   └── layer_2.raw
├── /documents                 # HWPX / DOCX 호환 마크업 및 단락 구조 XML
│   └── document.xml
└── /assets                    # 임베드 폰트(.ttf, .woff2) 및 비디오/오디오 파일
    └── fonts/
```

---

## 4. 융합형 Adaptive Interface (Context-Aware UI)

6개 모듈이 한 번에 공존할 때 발생하는 UI 복잡도를 풀기 위해 **"상황 인지형 적응 인터페이스"**를 탑재합니다.

```
+-----------------------------------------------------------------------------------+
|  [Omniweave Logo]  [File]  [Edit]  [View]  [Mode: Auto-Detect]    [Export: .omw]  |
+-----------------------------------------------------------------------------------+
| Dynamic Toolbar: (선택된 객체 종류에 따라 툴바 아이콘 세트가 0.1초 만에 자동 전환됨)   |
|   - Vector Selected:  [Pen Tool] [Anchor Multi-Select] [Pathfinder Union]        |
|   - Text Selected:    [Font: Noto Sans] [Size: 14pt] [Line Spacing: 1.6] [HWP 표]  |
|   - Raster Selected:  [Brush Size: 25px] [Hardness: 80%] [Opacity: 100%] [Layer]    |
|   - Slide Selected:   [New Slide] [Transition: Fade] [Play Slideshow]             |
+-----------------------------------------------------------------------------------+
|  Left Dock    |                                                  | Right Dock     |
|  - Layers     |                 Central Omni-Canvas              | - Properties   |
|  - Pages      |             (WebGPU / Virtualized)               | - Color Swatch |
|  - Slides     |                                                  | - Animations   |
+-----------------------------------------------------------------------------------+
```

---

## 5. 단계별 개발 구현 로드맵 (Milestones)

### Phase 1: 패키징 & 백엔드 뼈대 구축 (1~3주차)
* Rust 기반 `.omw` Zip & CBOR 직렬화/역직렬화 엔진 개발.
* WebGPU 기본 렌더링 파이프라인 구축 (`wgpu` 캔버스 초기화).

### Phase 2: 래스터 & 벡터 캔버스 완성 (4~7주차)
* 타일 기반 쿼드트리 픽셀 관리 구조 작성.
* 베지어 곡선 조작 펜 툴 및 핸들 이동 연산 파이프라인 이식.

### Phase 3: 문서 (HWPX/DOCX) & PDF 파서 통합 (8~11주차)
* HWPX XML 구조 해독 및 DOM/Canvas 단락 배치 엔진 제작.
* PDF.js 오버레이 파이프라인 및 가상 개체 승격 구조 결합.

### Phase 4: PPT 슬라이드 타임라인 & UI 동기화 (12~14주차)
* 슬라이드 마스터 시스템 및 애니메이션 타임라인 엔진 구축.
* 상황 인지형 Adaptive Ribbon UI 레이아웃 완성.

---

## 6. 법적 라이선스 컴플라이언스 & 면책 조항

1. **상표권 보호:** 어도비, 마이크로소프트, 한글과컴퓨터의 상표를 프로그램 이름이나 마케팅 문구로 무단 사용하지 않습니다.
2. **소프트웨어 라이선스:** 프로젝트 소스 코드는 **GPL-3.0-or-later**(GNU GPL 3판 또는 그 이후 판)로 무료 공개하며, 보증 부인·책임 제한 조항(GPL 15·16조)을 따릅니다. (처음에는 MIT로 계획했으나 2026-11 제품 결정으로 변경)
3. **Clean-Room 원칙:** 타사 상용 바이너리의 리버스 엔지니어링을 철저히 금지하며, 공개 표준 문서(ISO PDF 표준, HWPX 오픈 규격 등)만 기반으로 제작합니다.