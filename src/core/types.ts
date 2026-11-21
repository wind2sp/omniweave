// Omniweave unified scene graph.
// Every object is treated as immutable: edits produce new objects (immer), so object
// identity == content identity. The Loom engine relies on this for memoized hashing.

import type { MatteType } from "./image/matte/classify";
import type { EdgeOptions } from "./image/matte/refine";
import type { LayerAdjust } from "./image/adjustLayer";
import { DEFAULT_TITLE, t } from "../i18n";
import type { Effect, LineHeight, ListDef, StyleBlend } from "./style/types";

export { TILE } from "./tile";

/** Photoshop's 27 blend modes (core/style/blend.ts has the per-format table; phase B, 2026-11-13). */
export type BlendMode = StyleBlend;

export interface Transform {
  x: number;
  y: number;
  rotation: number; // degrees
  scale: number;
  /**
   * Vertical scale when it differs from `scale` (non-uniform stretch, vertical flip). Omitted =
   * same as `scale`, so older files and content hashes are unchanged. `scale` is then the
   * horizontal scale. Negative values mirror.
   */
  scaleY?: number;
}

interface NodeBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  /**
   * Fill opacity 0..1 (Photoshop "Fill", PSD iOpa): fades the node's own pixels, not its effects; the eight special
   * modes take it inside the blend (core/style/blend.ts fillParts). Omitted = 1 (and in documents from before, where
   * an imported PSD layer's fill was multiplied into `opacity`).
   */
  fillOpacity?: number;
  /** Photoshop "Blend Interior Effects as Group" (PSD infx): the fill fades the interior effects and the inner stroke too */
  fillInterior?: boolean;
  /**
   * Photoshop "Blend If" (the layer record's blending ranges), 0..255: per channel — composite grey, then R, G, B —
   * [this layer: black from, to, white from, to, underlying layer: the same four]. Omitted when every range is open.
   * core/style/blend.ts blendIfWeight.
   */
  blendIf?: number[];
  /**
   * Photoshop Knockout (PSD knko 1 shallow, 2 deep): the layer's shape, at its opacity, punches through the layers below
   * it in its group to what is under the group; its own pixels (at their fill) and effects are then drawn there.
   * Shallow and deep are drawn alike (through the enclosing group). core/layerTree.ts Compositor.knock.
   */
  knockout?: "shallow" | "deep";
  blendMode: BlendMode;
  transform: Transform;
  /**
   * Layer group (page.groups) this node belongs to; omitted = top level. Groups are records, not a tree of
   * nodes: the node list stays flat (bottom → top) and a group's members sit next to each other in it.
   */
  groupId?: string;
  /**
   * Clipping mask (Photoshop "Create Clipping Mask"): shown only where the clipping base — the nearest
   * unclipped layer or group below it in the same group — has pixels / geometry. Consecutive clipped layers
   * share the base; the base's opacity and blend mode apply to the whole stack. Omitted = not clipped.
   */
  clip?: boolean;
  /**
   * Layer effects (drop shadow, glows, stroke, overlays… — Photoshop layer style parameters, core/style/effects.ts).
   * Omitted when there are none, so nodes without effects keep their hashes and .omw v1 files stay byte-identical.
   */
  effects?: Effect[];
  /**
   * Part of a document page's body flow (core/flow.ts, docs/design/DOC_FLOW.md): a text frame, table or picture that
   * the story flows through from page to page. Omitted = a free object placed on the page (every node before flow).
   */
  flow?: true;
  /**
   * A page's note area as the body flow laid it out (core/flow.ts): the footnotes at the foot of the page or the
   * endnotes after the document's end, and their separator line. Made again whenever the flow runs; never body content
   * (the notes live in their reference runs, TextRun.note).
   */
  notes?: "foot" | "end";
  /**
   * CAD import (DXF / DWG, docs/design/CAD_IMPORT.md): the drawing layer of an entity inside a block whose own layer
   * is not the layer group it sits in (blocks keep their entities together), so turning that layer off reaches it too.
   * Omitted otherwise.
   */
  cadLayer?: string;
  /**
   * A shape drawn for a slide chart (io/formats/pptxChart.ts): the shapes of one chart follow each other and share
   * `id`; the first carries what the chart shows (`data`), so it can be edited and drawn again. Omitted otherwise.
   */
  chart?: { id: string; data?: SlideChart };
}

/** What a slide chart shows (PPTX c:chartSpace read from its cached values; ui/chartEdit edits it). */
export interface SlideChart {
  /** clustered column / bar, line, pie (area and doughnut as read; edited ones become one of the first four) */
  kind: "col" | "bar" | "line" | "pie" | "area" | "doughnut";
  /** the chart part of the deck it was read from (ppt/charts/chartN.xml), for the source-preserving save */
  part?: string;
  /** the graphic frame's name (the shapes are named after it) */
  name: string;
  categories: string[];
  series: { name: string; values: number[]; color: string | null }[];
  /** the title shown: its own text, null = the name of its only series; omitted = no title */
  title?: string | null;
  /** axis text size the chart saved (hundredths of a point); omitted = none saved */
  axSz?: number;
  /** c:gapWidth and c:overlap, percent */
  gapWidth: number;
  overlap: number;
  /** the theme's accent colours 1–6 and body font the chart was drawn with */
  accents: string[];
  font: string;
  /** the frame it was drawn in, page px */
  frame: { x: number; y: number; w: number; h: number };
}

/** Blend mode of a layer group: a layer blend mode (the group is composited on its own first) or Pass Through. */
export type GroupBlend = BlendMode | "PASS_THROUGH";

/**
 * Layer group (folder). Members are the nodes whose groupId is this id, plus child groups (parentId).
 * PASS_THROUGH (Photoshop's default) blends the members straight into what is below; any other mode — or an
 * opacity below 1 — composites the members on their own first, then blends that result.
 */
export interface LayerGroup {
  id: string;
  name: string;
  /** enclosing group, null = top level */
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blendMode: GroupBlend;
  /** folded in the layers panel (Photoshop's closed folder); view state only */
  collapsed?: boolean;
  /** layer effects applied to the group's composite (Photoshop group layer style); omitted when none */
  effects?: Effect[];
  /** CAD import: the drawing layer or block this group stands for (docs/design/CAD_IMPORT.md); omitted otherwise */
  cad?: CadGroupMeta;
}

/** A layer group made from a DXF / DWG layer (`layer`) or block insert (`block`). */
export interface CadGroupMeta {
  /** drawing layer name (a layer group) */
  layer?: string;
  /** block name (an INSERT or a dimension's block) */
  block?: string;
  /**
   * one drawing text drawn as several nodes (the upper parts of MTEXT stacks \S): picked, moved, copied, erased and
   * re-layered together on the drawing screen (ui/cad/engine.ts textParts)
   */
  text?: true;
  /** layer colour, lineweight (mm) and line type as the drawing set them */
  color?: string;
  lw?: number;
  ltype?: string;
  /** frozen (hidden like off, kept apart so thawing restores it) */
  frozen?: true;
  /** turned off while frozen (stays off when thawed; drawing screen layer manager) */
  offWhileFrozen?: true;
  /** not plotted */
  noPlot?: true;
}

/** A 256x256 RGBA tile. `hash` is the content address of `data` (a Loom thread). */
export interface PixelTile {
  hash: string;
  data: Uint8ClampedArray;
}

/**
 * Non-destructive crop: the node-local rectangle that is shown. Every original pixel / PDF
 * operator is kept; omitted = not cropped (older files unchanged).
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Background-removal matte of a cut-out layer ("배경 지우기"): the full-resolution alpha the cut-out was made with,
 * kept so a later mask model can reuse it without recomputing. `assetId` is a grey 8-bit PNG in doc.assets (saved
 * with the document like any other asset); `sourceId` is the hidden original node; `bounds` is the source area the
 * engine worked on (raster layers: the painted area, in the source picture's pixels). Optional, so older files and
 * content hashes are unchanged, and older app versions simply ignore it.
 */
export interface NodeMatte {
  assetId: string;
  sourceId: string;
  type: MatteType;
  bounds?: { x: number; y: number; w: number; h: number };
  edge: Partial<EdgeOptions> & Record<string, number | boolean>;
  /** subject (fg) / background points clicked in the dialog, as fractions of the source area (kept for re-editing) */
  hints?: { x: number; y: number; fg: boolean }[];
}

export interface RasterNode extends NodeBase {
  type: "RASTER";
  /** Sparse tile map keyed "tx_ty" in node-local tile coordinates. */
  tiles: Record<string, PixelTile>;
  crop?: CropRect;
  matte?: NodeMatte;
  /**
   * An adjustment layer (PSD levels, curves, …): the node changes the colours below it instead of drawing its
   * tiles, which hold its layer mask as alpha (core/image/adjustLayer.ts). Omitted on ordinary raster layers.
   */
  adjust?: LayerAdjust;
  /**
   * A PSD text layer (TySh): what can be edited as text (io/formats/psdText.ts, docs/design/PSD_TEXT.md). The tiles
   * stay its pixels — Photoshop's preview until edited, then drawn here from the spec. Omitted on other layers.
   */
  psdText?: PsdText;
  /**
   * A PSD smart object (placed layer, io/formats/psdSmart.ts): which file it shows and how it
   * is placed. The tiles stay its pixels — Photoshop's until its content is edited ('고급 개체 열기'), then drawn here
   * from the new content. Omitted on other layers.
   */
  psdSmart?: PsdSmart;
}

/** A PSD smart object's placed content. */
export interface PsdSmart {
  /** the linked-file entry's id (the placed-layer block's Idnt) */
  id: string;
  /** embedded in the document, or a linked file outside it */
  kind: "embedded" | "linked";
  /** the file name the entry stores */
  name: string;
  /** embedded content that opens as a document here (absent: a kind this cannot open — PDF, vector …) */
  content?: "psd" | "psb" | "png" | "jpg";
  /** corners on the page — top-left, top-right, bottom-right, bottom-left (x, y) — perspective included */
  quad: number[];
  /** the original embedded content's pixel size, which the corners belong to (from its header; absent: not known) */
  contentSize?: { w: number; h: number };
  /** its pixels can be drawn anew from the content (no warp, no smart filters, a block read in full) */
  redraw: boolean;
  /** linked: the path as stored, and whether the file was found next to the document (absent: not looked for) */
  path?: string;
  found?: boolean;
  /** content put back from its own tab: the new file (an asset), its size, and the layer's fingerprint once drawn */
  edited?: { assetId: string; hash: string; w: number; h: number; fp: string; /** put back as another kind (JPEG → PNG) */ name?: string; fileType?: string };
}

/** Editable part of a PSD text layer; sizes in page px. */
export interface PsdText {
  /** paragraphs separated by "\n" */
  text: string;
  /** font size of the first character run, px on the page */
  size: number;
  /** fill colour of the first character run, #rrggbb */
  color: string;
  /** PostScript name of the first run's font (as in the file) */
  font: string;
  align: "left" | "center" | "right";
  /** distance between baselines, px */
  leading: number;
  /** the text origin (first baseline; left / right / centre point per `align`) relative to the node's position */
  ox: number;
  oy: number;
  bold?: boolean;
  italic?: boolean;
  /** paragraph text: the box relative to the origin, px */
  box?: { x: number; y: number; w: number; h: number };
  /** pixel fingerprint after the text was drawn here (an edit made with other tools after that rasterizes on save) */
  fp?: string;
}

export type Vec2 = [number, number];

export interface VectorAnchor {
  anchor: Vec2;
  handleIn: Vec2;
  handleOut: Vec2;
  isCorner: boolean;
}

export interface Contour {
  nodes: VectorAnchor[];
  closed: boolean;
}

export interface VectorNode extends NodeBase {
  type: "VECTOR";
  contours: Contour[];
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  fillRule: "nonzero" | "evenodd";
  // Stroke panel (획 패널; Illustrator). Omitted = round caps and joins, solid — what every path drew before,
  // so older files and content hashes are unchanged.
  /** line ends */
  strokeCap?: "butt" | "round" | "square";
  /** corners */
  strokeJoin?: "miter" | "round" | "bevel";
  /** dash / gap lengths in stroke units (px); omitted or empty = solid */
  strokeDash?: number[];
  /**
   * A drawing entity drawn in its layer's linetype (ByLayer): the pattern scale and its pieces' lengths in page px, so
   * a layer linetype change lays the dashes out again (ui/cad/layers.ts setLayerLtype). Omitted otherwise.
   */
  cadLt?: { s: number; segs?: number[] };
}

export type Align = "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";

export interface TextRun {
  text: string;
  /** the run's font — for a run with `latinFont`, the font of its Hangul / CJK text (Word w:eastAsia) */
  fontFamily: string;
  /**
   * Font of the run's Latin text when it differs from `fontFamily` (Word w:ascii / w:hAnsi beside w:eastAsia, e.g.
   * Calibri + 맑은 고딕); omitted otherwise. Set by the DOCX importer; any font change of the run drops it.
   */
  latinFont?: string;
  fontSize: number; // px
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  // Optional character formats (omitted when off, so older files and content hashes are unchanged).
  /** strikethrough (취소선) */
  strike?: boolean;
  /** superscript / subscript (위첨자 / 아래첨자) */
  script?: "super" | "sub";
  /** highlight / character shading colour (형광펜) */
  highlight?: string;
  /** extra advance after every character, px (자간); may be negative */
  letterSpacing?: number;
  /** 장평 (horizontal glyph scale), percent; omitted when 100. Word w:w, HWPX hh:ratio, PDF Tz */
  hscale?: number;
  /**
   * 자간 as 한글 defines it: percent of each character's own advance (after 장평), added after every character;
   * omitted when 0. Measured in 한글 2024 (docs/design/LAYOUT_TRUTH.md 9). Independent of `letterSpacing`
   * (absolute px: Word, PPTX, PSD); both add up.
   */
  spacingPct?: number;
  /**
   * A field (머리말·꼬리말: 쪽 번호, 전체 쪽 수 …; core/headerFooter.ts): `text` is the value last shown, and the page it
   * is drawn on shows the live value. Omitted for ordinary text.
   */
  field?: FieldKind;
  /** the field's own code as the file had it (DOCX instruction such as ` DATE \@ "yyyy-MM-dd" `), written back as it was */
  fieldCode?: string;
  /**
   * An object in the line like a character (그림 글자처럼, Word "In Line with Text"; core/flow.ts): the run's text is
   * one U+FFFC, it takes the object's width, and its bottom sits on the baseline. `id` is the IMAGE node the body flow
   * places there. Omitted for text.
   */
  obj?: InlineObj;
  /**
   * A footnote / endnote reference (각주·미주; core/notes.ts): the run shows the note's mark (its number as numbered, or
   * the user's own mark) and carries the note's text. The body flow lays the note out at the foot of the page the
   * reference lands on (footnotes) or after the end of the document (endnotes). Omitted for text.
   */
  note?: NoteRef;
  /** in a note's own text: the note's mark (Word w:footnoteRef, 한글 autoNum); its text is the reference's mark */
  noteMark?: true;
  /**
   * A tracked insertion / deletion / move (변경 내용 추적; core/review.ts): the run's text was inserted, deleted (still
   * there, drawn struck through; hidden in the final view) or moved away / here. Omitted for text without one.
   */
  rev?: Revision;
  /** a tracked change of the run's character format (Word w:rPrChange); the run shows its new format */
  fmtRev?: Revision;
  /** ids of the comments (메모) whose range covers the run (Page.comments; core/review.ts) */
  comments?: string[];
}

/** A tracked change as the file records it (core/review.ts). */
export interface Revision {
  kind: "ins" | "del" | "moveFrom" | "moveTo" | "fmt";
  author?: string;
  /** when, as the file says it (ISO 8601) */
  date?: string;
  /** the change in the file it was read from (DOCX w:id, HWPX TcId) */
  src?: string;
  /**
   * a character format change made here (kind "fmt"): the run's format before it — rejecting it puts that format back,
   * DOCX writes it as the w:rPrChange's w:rPr. Omitted for a change read from a file (its format before is not read).
   */
  was?: Partial<Omit<TextRun, "text" | "rev" | "fmtRev" | "comments" | "note" | "noteMark" | "obj">>;
}

/** A comment (메모) of a document (Word comments.xml, 한글 메모 필드); its range is marked on the runs (TextRun.comments). */
export interface DocComment {
  /** the comment in the file (DOCX w:id, HWPX memo field id) */
  id: string;
  author: string;
  initials?: string;
  /** when, as the file says it (ISO 8601) */
  date?: string;
  /** its text, paragraphs joined with "
" */
  text: string;
  /** the comment this one answers (Word commentsExtended paraIdParent) */
  parent?: string;
  /** marked resolved (Word w15:done) */
  done?: true;
  /** the memo box of a 한글 memo (header.xml hh:memoPr of its field or section; not written to DOCX) */
  shape?: MemoShape;
  /** a memo on no text (한글: its field begun and ended at one place): that place — the paragraph's id, the text offset */
  at?: { para: string; offset: number };
}

/** A 한글 memo box (hh:memoPr attributes as the file writes them: width / line in HWPUNIT, colours #RRGGBB). */
export type MemoShape = Partial<Record<"width" | "lineWidth" | "lineType" | "lineColor" | "fillColor" | "activeColor" | "memoType", string>>;

/** A footnote / endnote: its kind, text and where it came from (core/notes.ts). */
export interface NoteRef {
  kind: "foot" | "end";
  /** the note's paragraphs (the first starts with its noteMark run) */
  paras: TextParagraph[];
  /** the run text is the user's own mark (Word customMarkFollows, 한글 사용자 기호), not a number */
  custom?: true;
  /** the note in the file it was read from (DOCX w:id, HWPX instId): the Office Surgeon writes untouched notes as they were */
  src?: string;
}

/** Number formats of note marks: the page number formats and Word's symbols (*, †, ‡, §). */
export type NoteNumFormat = PageNumFormat | "symbol";

/** How the notes of one kind are numbered and set apart (core/notes.ts). */
export interface NoteKindPr {
  /** number format (omitted: 1 2 3 for footnotes, i ii iii for Word endnotes) */
  fmt?: NoteNumFormat;
  /** first number (omitted = 1) */
  start?: number;
  /** numbers start again on each page (Word w:numRestart eachPage) or each section (eachSect); omitted = continuous */
  restart?: "page" | "section";
  /** characters around the number (한글 autoNumFormat prefixChar / suffixChar: "1)") */
  prefix?: string;
  suffix?: string;
  /**
   * The separator line above the notes: `len` px long at the body's left, with room `above` and `below` it (한글
   * noteLine / noteSpacing), drawn `width` px thick; null = no line. Word's separator paragraph is `para` (its height
   * holds the line, drawn across its middle).
   */
  line?: { len: number; above: number; below: number; width: number; color: string } | null;
  para?: TextParagraph;
  /** endnotes begin on a page of their own (한글's 문서 끝 미주, measured on its PDFs) */
  newPage?: true;
}

/** Note settings of a document (on its first page). */
export interface NotePr {
  foot?: NoteKindPr;
  end?: NoteKindPr;
}

export interface InlineObj {
  id: string;
  w: number;
  h: number;
}

/** The character an inline object stands for in run text. */
export const OBJ_CHAR = "\uFFFC";

/** Fields: this page's number, the document's page count, this section's page count, today's date, the file name. */
export type FieldKind = "page" | "pages" | "secpages" | "date" | "file";

export interface TextParagraph {
  id: string;
  runs: TextRun[];
  align: Align;
  /** line height ÷ font size (한글 PERCENT / 100); with a Word multiple, the same height as a size multiple (core/lineSpacing.ts) */
  lineSpacing: number;
  indent: number; // first-line indent px (relative to indentLeft; negative = hanging)
  /** left indent of every line, px (왼쪽 여백); omitted when 0 */
  indentLeft?: number;
  spaceAfter: number; // px
  /** semantic role kept for Markdown/HTML/DOCX round trips (h1..h6, list item, quote, code) */
  role?: ParaRole;
  /**
   * (DOC, doc-para-write) the paragraph Enter at this one's end makes when its style names another style for the
   * paragraph after it (Word: a heading → Normal): that style's format and letters, nothing of this paragraph's own.
   * Omitted when the new paragraph is cut from this one (the same style). Not content: a fingerprint and a look leave it out.
   */
  styleNext?: Omit<TextParagraph, "id" | "styleNext">;
  /** tracked changes of the paragraph itself (core/review.ts): its mark inserted / deleted, its format changed (w:pPrChange) */
  markRev?: Revision;
  fmtRev?: Revision;
  /**
   * a tracked change of the paragraph mark's own character format (Word w:pPr/w:rPr/w:rPrChange — an empty paragraph's
   * format changed): listed and accepted / rejected like a run's format change
   */
  markFmtRev?: Revision;
  // Optional paragraph formats (omitted when off / 0, so older files and content hashes are unchanged).
  /** space before the paragraph, px (문단 위 / 단락 앞) */
  spaceBefore?: number;
  /** right indent, px (오른쪽 여백) */
  indentRight?: number;
  /**
   * Line height other than a multiple of the size: exact (고정값), at least (최소), or the gap between lines (한글
   * '여백만'). The length keeps the unit of the file it came from. When set it decides the line height, and
   * `lineSpacing` holds the nearest multiple (what older readers draw).
   */
  lineHeight?: ParaLineHeight;
  /** keep with the next paragraph / keep the lines together (stored and saved; honoured once text flows across pages) */
  keepNext?: boolean;
  keepLines?: boolean;
  /** start on a new page (Word pageBreakBefore, 한글 '문단 앞에서 항상 쪽 나눔') */
  pageBreakBefore?: boolean;
  /**
   * (Documents imported before `lineMultiple`; DOCX import now gives lineMultiple.)
   * Word's own line spacing of a paragraph read from DOCX (w:line, lineRule auto: 240ths of the font's single line)
   * and the lineSpacing it was read as. While lineSpacing is unchanged, DOCX export writes `line` back as it was (the
   * multiple Word users set); once lineSpacing is edited it no longer applies and the multiple is converted again.
   */
  wordLine?: { line: number; lineSpacing: number };
  /**
   * Word multiple line spacing (줄 간격 배수: the font's own single line × v; Word w:line lineRule auto = v × 240).
   * `lineSpacing` is the size multiple of the same height (what older readers draw); while it equals the one here the
   * paragraph is drawn with the Word multiple (core/lineSpacing.ts wordMultipleOf). Absent = lineSpacing is a multiple
   * of the font size (한글 PERCENT), as in every document before.
   */
  lineMultiple?: { v: number; lineSpacing: number };
  /** list membership: real multi-level numbering (core/lists.ts); the marker stays real text at the start */
  list?: ParaList;
  /** widow / orphan control (Word 과부·고아 줄, 한글 외톨이줄 보호) in the body flow; omitted = on (Word's default) */
  widowControl?: false;
  /**
   * Body flow (core/flow.ts): the head of a paragraph cut at the bottom of a page. Its last line is not the paragraph's
   * end (no space after, still justified). 1 = cut between runs, 2 = cut inside a run (joined again when merged).
   */
  flowSplit?: 1 | 2;
  /** Body flow: the rest of a paragraph cut at a page end (top of the next page); the value is the paragraph's id */
  flowCont?: string;
  /**
   * Word (DOCX / DOC import): the empty paragraph that holds a section break before a continuous section. Word lays out
   * no line for it (Word 2021 PDFs: the next section's first line is one line and that paragraph's space after higher
   * than with an empty line), and the next paragraph's space before gives up that space after (core/text.ts
   * spacingOverlap). Text typed into it lays out as usual.
   */
  sectMark?: true;
  /**
   * 한글's own line layout of the paragraph as the file saved it (HWPX hp:linesegarray, HWP PARA_LINE_SEG): while the
   * paragraph is as imported (`sig`) and laid out in a box of the same width, its lines break exactly where 한글 broke
   * them (core/text.ts). Omitted for other documents and once 한글 left no line layout.
   */
  hwpLines?: HwpLines;
  /** Hangul may break between syllables (한글 '한글 단위: 글자' — OWPML breakNonLatinWord KEEP_WORD), not only between 어절; omitted = the node's rule */
  breakWord?: boolean;
  /** default tab stops every this many px from the left indent (한글 구역 tabStopVal); omitted = a tab is as wide as its glyph */
  tabStep?: number;
  /**
   * width of a word space as a fraction of the font size (한글 sets a space half an em wide whatever the font's own space
   * glyph — measured on 한글 2024 PDFs, docs/design/FIDELITY_HWP.md); omitted = the font's space
   */
  spaceEm?: number;
  /** 공백 최소값 (한글 condense): word spaces may shrink by this fraction (0..1) to keep a word on the line */
  condense?: number;
  /** text at the top of each line, the line spacing below it (한글: baseline 0.85 × size from the line top); omitted = centred */
  lineTop?: boolean;
  /**
   * PowerPoint line placement (io/formats/pptxText.ts): the baseline of a line h tall with text `size` high is
   * max(slideAscent × size − (1.2 × size − h), 0.75 × h) below the line top — a line spacing under 100 % is taken off
   * above the text, over 100 % puts the baseline at 3/4 of the line (measured on PowerPoint PDFs). Omitted = centred.
   */
  slideAscent?: number;
  /**
   * Paragraph borders (Word w:pBdr, 한글 문단 테두리 — borderFill of the paragraph shape): lines around the paragraph's
   * text box (its indents widened by each side's `space`). Paragraphs in a row with the same borders and indents are one
   * box (Word): the top line over the first, the bottom under the last, `between` between them. Omitted = none.
   */
  border?: ParaBorders;
  /** paragraph shading (Word pPr w:shd fill, 한글 문단 배경): the paragraph's box filled with this colour; omitted = none */
  shade?: string;
}

/** One side of a paragraph border: width and gap to the text, px. */
export interface ParaBorderLine {
  w: number;
  color: string;
  space: number;
  /** line style; omitted = single */
  style?: "double" | "dashed" | "dotted";
}

export interface ParaBorders {
  top?: ParaBorderLine;
  bottom?: ParaBorderLine;
  left?: ParaBorderLine;
  right?: ParaBorderLine;
  between?: ParaBorderLine;
}

export interface HwpLines {
  /** character offsets (after any list marker) where the 2nd, 3rd … lines start */
  at: number[];
  /** right end of 한글's lines from the box's left edge, px (box width less the right margin) */
  right: number;
  /** signature of the paragraph's text and formats when imported (core/text.ts hwpLinesSig) */
  sig: string;
  /**
   * The lines (0 = the first) at which 한글 began a new page (its saved lines start again at the top: lineseg vertpos);
   * present = 한글's pages are known here, so the body flow breaks pages there and nowhere else (core/flow.ts)
   */
  page?: number[];
}

export type ParaLineHeight = Exclude<LineHeight, { mode: "multiple" }>;

/**
 * A paragraph's place in a list. `id` is the list instance (numbers count on across text nodes / pages with the
 * same id); `def` names the level formats: a preset (core/lists.ts LIST_PRESETS) or an entry of TextNode.lists.
 */
export interface ParaList {
  id: string;
  def: string;
  /** 0..8 */
  level: number;
  /** restart: this item gets this number (the items after it count on from it) */
  start?: number;
  /** the marker text (with its separator) the paragraph starts with, as renumbering last wrote it */
  mk?: string;
}

export type ParaRole = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "oli" | "quote" | "code" | "hr";

export interface TextNode extends NodeBase {
  type: "TEXT";
  width: number;
  paragraphs: TextParagraph[];
  /** keep-all = break between 어절 (Korean word units), normal = break anywhere allowed. */
  wordBreak: "keep-all" | "normal";
  /**
   * "half": a space set in an East Asian font is half the size wide (Word's balanceSingleByteDoubleByteWidth, on in
   * Korean Word documents: a Latin font's space next to Hangul is the East Asian font's too). Omitted = the font's own.
   */
  cjkSpace?: "half";
  /** closing punctuation (, . 、 。) at a line end may hang past the right edge (Word w:overflowPunct, on by default) */
  hangPunct?: boolean;
  /** a justified line may keep a Latin word that runs past the end by shrinking its spaces (Word 2013+ layout) */
  justifyShrink?: boolean;
  /** Word's automatic quarter-size space between Hangul and Latin letters / digits (w:autoSpaceDE / w:autoSpaceDN) */
  autoSpace?: { alpha?: boolean; digit?: boolean };
  /**
   * Word's paragraph spacing (DOCX import; docs/design/FIDELITY_DOCX.md 8). "max": the gap between two paragraphs is
   * the larger of the first's space after and the second's space before (Word without
   * w:doNotUseHTMLParagraphAutoSpacing — every new Word document), "sum": both. Either way the body flow drops the space
   * before of a paragraph that begins a page after a page break (natural, hard or 'page break before'). Omitted = the
   * sum, kept at the top of a page (한글, documents of our own, DOCX imported before).
   */
  wordSpacing?: "max" | "sum";
  background: string | null;
  /**
   * Language of the node's Latin text for spelling (BCP-47, Word w:lang w:val of the default run properties); omitted =
   * en-US. Hangul is always checked as Korean (ui/spell.ts). Never written to a file: it only picks the checker.
   */
  lang?: string;
  /** list definitions the paragraphs use besides the presets (imported numbering, edited levels); omitted when none */
  lists?: ListDef[];
  /**
   * A slide placeholder (core/slides.ts, docs/design/SLIDE_MODE.md): the box a layout gives the slide for its title or
   * text. Empty, it shows its prompt on the canvas only (never in a show, a print or a file). Omitted for text boxes.
   */
  ph?: Placeholder;
}

/** Placeholder role and box of a slide text node (PresentationML p:ph). */
export interface Placeholder {
  /** p:ph type (title slide title = ctrTitle, its subtitle = subTitle, text and content = body) */
  type: "title" | "ctrTitle" | "subTitle" | "body";
  /** p:ph idx (several body placeholders on one layout) */
  idx?: string;
  /** height of the placeholder box, px (the node's width is the box width) */
  h: number;
  /** the text's offset below the box top, px (vertical anchor; omitted = 0) */
  dy?: number;
  /** vertical anchor of the text in the box (omitted = top) */
  anchor?: "ctr" | "b";
  /** autofit: the text was shrunk to this fraction of its size to stay in the box (omitted = 1) */
  fit?: number;
  /** the text does not shrink to fit (PowerPoint noAutofit / spAutoFit): it may overflow the box */
  noFit?: true;
}

export interface ImageNode extends NodeBase {
  type: "IMAGE";
  assetId: string;
  width: number;
  height: number;
  crop?: CropRect;
  matte?: NodeMatte;
  /** how the picture sits in a word-processor document (DOCX / HWPX); omitted = chosen on save from where it is */
  place?: ObjectPlace;
}

/**
 * Placement of a picture in a Word / 한글 document (DOCX wp:inline / wp:anchor, HWPX hp:pic treatAsChar / textWrap).
 * The node's transform stays the place it is drawn at; this says how the file holds it. Optional, so older files and
 * content hashes are unchanged.
 */
export interface ObjectPlace {
  /** inline = in the text like a character (Word 텍스트 줄 안, 한글 글자처럼 취급); float = at a place on the page */
  mode: "inline" | "float";
  /** float: how text goes around it (square, top and bottom, none in front of / behind the text) */
  wrap?: "square" | "topBottom" | "front" | "behind";
  /**
   * Where it sits in the text, for the body flow model: the paragraph (id) it is in — or, `own`, the paragraph of its
   * own that comes after that paragraph (absent: the first in its section) — and the number of characters before it.
   */
  para?: string;
  offset?: number;
  own?: boolean;
  /** a picture in a paragraph of its own (Word / 한글): that paragraph's space before and after, px, which the body flow keeps around it */
  space?: { before: number; after: number };
}

export interface PdfCover {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface PdfNode extends NodeBase {
  type: "PDF";
  assetId: string;
  pageIndex: number;
  width: number;
  height: number;
  /** Rectangles painted over the original page where content was elevated to editable nodes. */
  covers: PdfCover[];
  /** visible part of the page (like a PDF CropBox), node-local */
  crop?: CropRect;
  /**
   * Form values typed in Omniweave for fields with a widget on this page (field name → text / chosen options /
   * check state / radio on-state). The page is shown, exported and saved filled with them (io/pdfsurgeon/forms.ts).
   */
  form?: Record<string, string | string[] | boolean>;
  /**
   * Annotations added in Omniweave on this page (highlight / underline / strike-out over text, sticky notes), in PDF
   * user space; written into the file like the form values (io/pdfsurgeon/annots.ts).
   */
  annots?: {
    id: string;
    kind: "highlight" | "underline" | "strike" | "note" | "sign";
    quads?: number[][];
    at?: [number, number];
    color: [number, number, number];
    contents?: string;
    author?: string;
    /** sign: the picture's box in PDF user space and its PNG (an asset of this document) */
    rect?: [number, number, number, number];
    assetId?: string;
    /** sign: placed upright as the page is shown (absent in older files: written unturned, as before) */
    upright?: boolean;
  }[];
}

/** One table cell. Optional fields are omitted when default so content hashes stay small. */
export interface TableCell {
  text: string;
  bold?: boolean;
  italic?: boolean;
  align?: Align;
  color?: string;
  fill?: string;
  /** spreadsheet formula without the leading "=", kept for XLSX round trips */
  formula?: string;
  /**
   * spreadsheet number format code (ECMA-376 §18.8.31, e.g. "yyyy-mm-dd", "0.00%", "#,##0") kept so
   * dates, percentages and currency are written back as numbers with their original format
   */
  numFmt?: string;
  /**
   * merged cell (DOCX gridSpan/vMerge, HWPX cellSpan): this top-left cell covers colSpan columns and
   * rowSpan rows. Covered cells stay in the grid with empty text (renderers that do not draw spans
   * show the grid unmerged); omitted when 1.
   */
  colSpan?: number;
  rowSpan?: number;
  /**
   * Cell paragraphs as imported from DOCX/HWPX (fonts, sizes, list items…). Written back unchanged
   * while `text` still equals their text; an edited cell is written from `text` and the table style.
   */
  richText?: TextParagraph[];
  /** vertical alignment of the cell's content in a table with `cellBox` (한글 subList vertAlign); absent = top */
  vAlign?: "middle" | "bottom";
  /** the cell's own height as the file set it, px (한글 cellSz): its row is at least this tall in a `cellBox` table */
  minHeight?: number;
  /**
   * body flow (core/flow.ts cutRowAt, on the pieces only): the cell is in the first part (`cutA`) / the rest (`cutB`)
   * of the row cut between lines at the page end numbered so. Joining the pieces joins a first part with the rest of
   * the same number only — rows inserted or deleted next to a part, cells merged across one: the parts stay rows of
   * their own, never joined into another row. Joined tables carry none.
   */
  cutA?: number;
  cutB?: number;
}

export interface TableNode extends NodeBase {
  type: "TABLE";
  /** rows × columns; every row has colWidths.length cells */
  rows: TableCell[][];
  colWidths: number[];
  /** minimum row height (rows grow to fit wrapped text) */
  rowHeight: number;
  headerRow: boolean;
  fontFamily: string;
  fontSize: number;
  color: string;
  borderColor: string;
  headerFill: string;
  background: string | null;
  /** body flow (core/flow.ts): rows of the table with this id continued on the next page (header row repeated) */
  flowCont?: string;
  /**
   * body flow (core/flow.ts): this piece's last row was cut between lines at the page end and goes on as the first row
   * (after the repeated header) of the next piece — joined back into one row when the pieces are joined
   */
  cutRow?: true;
  /**
   * Cells drawn from their own paragraphs (TableCell.richText: fonts, sizes, alignment, 한글's saved lines) inside
   * these cell margins, px — set by the HWPX / HWP import (한글 hp:inMargin). Absent: cell text in the table's font
   * with the default padding (every table before, and DOCX). `cut`: a row that does not fit at a page end is cut
   * between its lines (한글 '쪽 경계에서 나눔', hp:tbl pageBreak="CELL"); without it rows move whole.
   */
  cellBox?: { padX: number; padY: number; word?: WordCells; cut?: true };
  /**
   * Word table alignment (DOCX tblPr w:jc, docs/design/FIDELITY_DOCX.md 8): the body flow centres the table in the text
   * column or sets it at the right edge, counting the outer half of its left border (`left`: that border's width, px)
   * as Word does (core/flow.ts tableShift). Omitted = at the left edge (한글, our own tables, Word's left).
   */
  wordAlign?: { jc: "center" | "right"; left: number };
  /**
   * Word's left-aligned table (DOCX tblPr w:tblInd): its cell edge this far (px, may be negative) right of the text
   * column's left; in compatibility mode 14 and before Word measures w:tblInd to the first cell's text, so the edge
   * is that far less the cell's left margin (Word 2010 tables start their text at the margin). Omitted = 0.
   */
  wordInd?: number;
}

/**
 * Word's cell model (DOCX import, docs/design/FIDELITY_DOCX.md 6): a cell is as tall as its paragraphs lay out (space
 * before and after included, as Word counts them) plus the top / bottom cell margins and one border line; the text sits
 * below the border. The text frame settings of the document (TextNode wordBreak, cjkSpace …) apply in the cells too.
 * Absent: 한글's cell model (the glyph box of the text inside the margins).
 */
export interface WordCells {
  /** width of a horizontal border line, px (w:insideH / w:top sz); 0 = none */
  border: number;
  wordBreak?: TextNode["wordBreak"];
  cjkSpace?: TextNode["cjkSpace"];
  hangPunct?: boolean;
  justifyShrink?: boolean;
  autoSpace?: TextNode["autoSpace"];
  wordSpacing?: TextNode["wordSpacing"];
}

export type MediaKind = "video" | "audio";

/** Video or audio clip placed on the canvas. The bytes live in assets; the canvas shows the poster frame. */
export interface MediaNode extends NodeBase {
  type: "MEDIA";
  media: MediaKind;
  assetId: string;
  /** still frame shown on the canvas (image asset), null for audio or when no frame could be decoded */
  posterAssetId: string | null;
  width: number;
  height: number;
  /** seconds; 0 when unknown */
  duration: number;
  trimStart: number;
  /** null = play to the end */
  trimEnd: number | null;
  muted: boolean;
  loop: boolean;
  /** play automatically when the slide is shown in a slideshow */
  autoplay: boolean;
}

export type SceneNode = RasterNode | VectorNode | TextNode | ImageNode | PdfNode | TableNode | MediaNode;
export type NodeType = SceneNode["type"];

export type TransitionType = "NONE" | "FADE" | "SLIDE_LEFT" | "ZOOM";
export type AnimTrigger = "ON_CLICK" | "WITH_PREVIOUS" | "AFTER_PREVIOUS";
export type AnimProperty = "OPACITY" | "TRANSLATION" | "SCALE" | "ROTATION";

export interface Keyframe {
  time: number; // ms from animation start
  value: number | Vec2;
  easing: string; // linear | ease-in | ease-out | ease-in-out | cubic-bezier(a,b,c,d)
}

export interface KeyframeAnimation {
  id: string;
  targetNodeId: string;
  trigger: AnimTrigger;
  property: AnimProperty;
  keyframes: Keyframe[];
}

export type PageKind = "DESIGN" | "DOCUMENT" | "SLIDE" | "PDF" | "MASTER";

export interface Page {
  id: string;
  name: string;
  kind: PageKind;
  width: number;
  height: number;
  background: string;
  nodes: SceneNode[]; // bottom -> top
  masterId: string | null;
  transition: { type: TransitionType; duration: number };
  animations: KeyframeAnimation[];
  /** where the page came from (format id such as "csv", "md", "json"), used by "save as the same type" */
  source?: PageSource;
  /** ruler guides in page px (x = vertical lines, y = horizontal lines); omitted when there are none */
  guides?: PageGuides;
  /** layer groups (folders) of this page; omitted when there are none (see LayerGroup, NodeBase.groupId) */
  groups?: LayerGroup[];
  /**
   * Page setup (쪽 설정) margins in px; omitted = DEFAULT_MARGINS (core/pageSetup.ts, 76 px ≈ 2 cm around the body,
   * the size every document page had before margins were stored), so old files lay out exactly as before.
   */
  margins?: PageMargins;
  /**
   * How a document page begins when it is written to a word-processor file (DOCX / HWPX). Omitted = after a page
   * break (쪽 나누기): the first page, and every page made with "new page" or Ctrl+Enter. "flow" = the text simply
   * continues from the previous page (pages made by automatic pagination on import: no break is written);
   * "section" = a section break (구역 나누기): a new section with its own paper size, orientation and margins.
   */
  breakBefore?: "flow" | "section";
  /**
   * Header, footer and page numbering of the section this page begins (머리말·꼬리말·쪽 번호; core/headerFooter.ts).
   * Read from the first page of each section only; omitted = everything as in the section before.
   */
  hf?: SectionHF;
  /** note numbering and separators of the document (read from its first page; core/notes.ts) */
  notePr?: NotePr;
  /** comments (메모) of the document, in file order (read from its first page; core/review.ts) */
  comments?: DocComment[];
  /** changes are recorded while editing (Word w:trackRevisions, 한글 변경 내용 추적 켬; core/review.ts); on the first page */
  trackChanges?: true;
  /**
   * Spreadsheet sheet (표 계산, core/sheetTypes.ts): the page is one worksheet shown as a cell grid (ui/sheet). Its
   * `nodes` stay empty; printing and exports lay the sheet out as table pages (io/sheet/pages.ts).
   */
  sheet?: import("./sheetTypes").SheetData;
  /**
   * Slides (core/slides.ts): the layout the slide was made from — a built-in layout id (SlideLayoutId) or, in a deck
   * read from PPTX, its slideLayout part — so 'reset' and 'change layout' know the placeholders. Omitted = none known.
   */
  layout?: string;
  /** a hidden slide (PowerPoint show="0"): kept in the deck, skipped by the slide show */
  hidden?: true;
  /** a section (구역) begins with this slide; its name (PowerPoint p14:sectionLst) */
  section?: string;
  /** speaker notes of a slide (plain text, one paragraph per line; PPTX notesSlide body) */
  notes?: string;
}

/** Page number formats: 1 2 3, i ii, I II, a b, A B, - 1 -, 가 나 다. */
export type PageNumFormat = "decimal" | "lowerRoman" | "upperRoman" | "lowerLetter" | "upperLetter" | "dash" | "ganada";

/** Where a page number placed by itself sits (한글 쪽 번호 매기기 hp:pageNum; outside / inside: by odd / even page). */
export type PageNumPos = `${"top" | "bottom"}-${"left" | "center" | "right" | "outside" | "inside"}`;

/**
 * The header or footer variants of a section (Word default / first / even, 한글 양쪽 / 홀수 / 짝수). A variant that is
 * absent is linked to the section before (앞 구역과 연결); an empty array is a blank one of this section's own.
 */
export interface HFVariants {
  default?: TextParagraph[];
  first?: TextParagraph[];
  even?: TextParagraph[];
}

export interface SectionHF {
  header?: HFVariants;
  footer?: HFVariants;
  /** different first page (Word titlePg): the section's first page uses the `first` variants */
  titlePg?: boolean;
  /** different odd and even pages (Word evenAndOddHeaders, a document setting: read from the first page) */
  evenOdd?: boolean;
  /** page numbers start again at this number with this section (Word pgNumType start, 한글 새 번호 / startNum) */
  pageStart?: number;
  /** number format of this section's page numbers (Word pgNumType fmt: not inherited, absent = 1 2 3) */
  pageFmt?: PageNumFormat;
  /** a page number placed by itself (한글 hp:pageNum, Word's framed page number); null = none from this section on */
  pageNum?: { pos: PageNumPos; side?: string } | null;
  /** no page number on the section's first page (한글 hideFirstPageNum; Word: set together with titlePg) */
  hideFirstNum?: boolean;
}

/** Page margins in px (Word's meaning: top/bottom = paper edge → body; header/footer = paper edge → header/footer). */
export interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
  header: number;
  footer: number;
}

export interface PageGuides {
  x?: number[];
  y?: number[];
}

export interface PageSource {
  format: string;
  name: string;
  /** text formats: original encoding, line ending and BOM, restored on save */
  encoding?: string;
  eol?: "\r\n" | "\n";
  bom?: boolean;
  /** CSV field delimiter when not "," */
  delimiter?: string;
  /**
   * Text formats (Markdown): the original source text of each block on this page, written back
   * verbatim while the block's content is unchanged, so editing one paragraph does not reformat the file.
   */
  fragments?: SourceFragment[];
  /** HTML: the original text up to and including </head> (doctype, <html> attributes, meta, link, style, script) and the <body> start tag */
  htmlHead?: string;
  htmlBodyTag?: string;
  /** CSV quoting of the original file when it was not "only where needed": every field, or every non-numeric field */
  quote?: "all" | "nonnumeric";
  /** CSV: the file as it was read (io/formats/csv.ts keptCsv), on the first page of the table only */
  csv?: CsvSourceMeta;
  /**
   * The source file was password-protected. Only the scheme and a session key are stored —
   * the password itself lives in memory (io/crypto/session.ts) and is never saved.
   */
  protection?: { scheme: string; secretId: string };
  /**
   * An Illustrator file saved without PDF content, drawn from its native data (io/pdfsurgeon/aiNative.ts): the page's
   * PDF is that rendering, so "save in the original format" is not offered (the .ai would lose Illustrator's document)
   */
  aiNative?: boolean;
  /** Photoshop round-trip map (io/formats/psd.ts → psdWrite.ts); absent for other formats */
  psd?: PsdSourceMeta;
  /** PSD self-score against the file's merged image (core/fidelity); a view cache, never written into exports */
  psdScore?: import("./fidelity/overlay").PsdScoreCache;
  /** Office Surgeon block map (DOCX / XLSX / HWPX, io/officesurgeon); absent for other formats */
  office?: OfficeSourceMeta;
  /**
   * HWP 5.0 read through its HWPX conversion (format "hwpx", with `office`): the original .hwp kept as an asset, so an
   * unedited document saves as HWP byte for byte (io/formats/hwp5Write.ts); absent for other files. `fp` / `shape`: the
   * pages' fingerprint when the file was opened (hwp5Fingerprint), so the save tells an unedited document, a text edit
   * (written into the HWP records) and any other edit apart
   */
  hwp5?: { assetId: string; hash: string; name: string; fp?: string; shape?: string };
  /**
   * DOC / XLS / PPT (Office 97-2003): the original file kept as an asset, so an unedited document saves as that file
   * byte for byte (io/formats/legacyWrite.ts); absent for other files and for password-protected ones. `fp`: the pages'
   * fingerprint when the file was opened (legacyFingerprint) — any other fingerprint is an edit. `shape` (XLS): the
   * same without the cell values (xlsShape) — only values changed, they are written into the BIFF records (xlsWrite.ts);
   * (DOC) the same without the body text (docShape) — only text changed, it is written into the WordDocument stream
   * (docWrite.ts)
   */
  /** (`day`: a PPT opened with its formatting — the day its date fields showed at the open, io/formats/pptRich.ts) */
  legacy?: { kind: "doc" | "xls" | "ppt"; assetId: string; hash: string; name: string; fp: string; shape?: string; day?: string };
  /** DXF / DWG import: the original drawing and how its coordinates map onto the page (io/formats/cad/build.ts) */
  cad?: CadSourceMeta;
}

/**
 * A CSV as it was read, so saving writes back the file's own text: unedited rows byte for byte (line ends, each field's
 * quotes, line breaks inside cells), edited rows with their unedited fields as written (io/formats/csv.ts keptCsv).
 */
export interface CsvSourceMeta {
  /** the file's text after decoding (BOM removed, line ends as in the file) */
  text: string;
  /** records of `text` that became table rows (the ones after them — blank lines at the end, rows past the limit — are written back as they were) */
  rows: number;
  /** the line end most records use, for new rows */
  eol: "\r\n" | "\n" | "\r";
  /** cells shown differently from the file's text, as Excel shows them (dates typed as text, formula results): "row,col" → shown text */
  shown?: Record<string, string>;
}

/**
 * A page made from a DXF / DWG drawing (model space or one layout). The original file is kept as an asset (re-import,
 * comparison); page px (x, y) is drawing point (ox + x / k, oy − y / k).
 */
export interface CadSourceMeta {
  format: "dxf" | "dwg";
  /** $ACADVER (AC1015 …) */
  version: string;
  assetId: string;
  hash: string;
  /** $INSUNITS and its symbol ("mm", "in", "" unitless) */
  insunits: number;
  unit: string;
  /** millimetres per drawing unit */
  mmPerUnit: number;
  /** plot scale: drawing millimetres per paper millimetre (100 = 1:100, 0.5 = 2:1) */
  scale: number;
  /** page px per drawing unit, and the drawing point at the page's top-left corner */
  k: number;
  ox: number;
  oy: number;
  /** layout name for a paper-space page; omitted for model space */
  layout?: string;
  /** block name → number of inserts on this page */
  blocks?: Record<string, number>;
  /** external files the drawing names (xrefs, linked pictures): found or not, kept as assets (CAD_IMPORT.md §11) */
  refs?: CadRefMeta[];
  /** named layer states (drawing screen, AutoCAD LAYERSTATE): layer → [on, frozen, locked] */
  layerStates?: Record<string, Record<string, [boolean, boolean, boolean]>>;
  /** AutoCAD GROUPs (named object selections across layers): shown as group rows in the layer manager */
  groups?: CadGroupSource[];
  /** the drawing's LTYPE table: linetypes loaded in it (upper-case name ??its name and + dash / − gap / 0 dot pattern) */
  ltypes?: Record<string, { name: string; pattern: number[] }>;
}

/** One AutoCAD GROUP of a page: its member nodes (the entities' nodes on this page). */
export interface CadGroupSource {
  name: string;
  ids: string[];
  description?: string;
  /** false = not selectable as a group (AutoCAD "Selectable" off); omitted = selectable */
  selectable?: boolean;
  /** anonymous group (*A1 …): AutoCAD lists it only with "Include Unnamed" */
  unnamed?: boolean;
}

/** An external file of a drawing (io/formats/cad/external.ts CadRef). */
export interface CadRefMeta {
  kind: "xref" | "image";
  name: string;
  /** path as stored in the drawing */
  path: string;
  found: boolean;
  /** where it was found (relative to the drawing's folder when inside it) */
  at?: string;
  /** the file's bytes, kept as a document asset */
  assetId?: string;
}

/** One source block: the paragraphs / table it became, its original text and its canonical re-export. */
export interface SourceFragment {
  /** paragraph ids (or the table node id) made from the block, in order */
  ids: string[];
  /** original source text of the block (no trailing blank lines) */
  raw: string;
  /** what the exporter writes for those nodes at import time; raw is reused while this still matches */
  canon: string;
  /** original text between this block and the next one */
  sep: string;
  /** block number in the source file (adjacent blocks keep their original separator) */
  n: number;
}

/**
 * Links a page imported from a PSD/PSB to the original file (kept as an asset) so "save as PSD" can copy
 * every untouched layer record, channel and additional-info block byte for byte.
 */
export interface PsdSourceMeta {
  /** asset holding the original file bytes, and its content hash (checked before reuse) */
  assetId: string;
  hash: string;
  /** one entry per original layer record, in file order (bottom → top) */
  layers: PsdLayerLink[];
  /** hidden node showing Photoshop's merged image (never written as a layer) */
  compositeNode?: string;
  /** flat file (no layers): the node holding the merged image, and its pixel fingerprint at import */
  flatNode?: string;
  flatFp?: string;
  /** canvas size at import */
  width: number;
  height: number;
  /** folders + page + layer order at import (core/fidelity/structureSig.ts); absent in documents from before */
  importSig?: string;
}

/** Import-time state of one PSD layer record; the writer compares it with the node to find edits. */
export interface PsdLayerLink {
  /** raster node made from the record, null for records without pixels (groups, adjustment / fill layers) */
  node: string | null;
  /** pixel fingerprint (tile keys + hashes) at import */
  fp?: string;
  name?: string;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  blend?: string;
  x?: number;
  y?: number;
  /** clipping flag at import (pixel records) */
  clip?: boolean;
  /** folder header record (lsct 1/2): the page.groups id made from it; name / opacity / visible / blend above are the group's */
  group?: string;
  /** effects fingerprint at import (core/style effectsFingerprint) when the record had an effects block it read */
  fx?: string;
  /** text layer: io/formats/psdText psdTextKey of the spec at import (an edit rewrites the record's TySh) */
  txt?: string;
}

export interface AssetRef {
  id: string;
  hash: string; // content address of the bytes in the thread store
  mime: string;
  name: string;
  size: number;
  /** draw the stored pixels without the JPEG / TIFF EXIF orientation — PowerPoint shows a picture that way, so a phone
   *  photo whose EXIF says "rotate" stays as the deck shows it (set by the PPTX / PPT import) */
  exifIgnored?: boolean;
}

export interface OmwDocument {
  format: "omw";
  /** 1 for documents made here (the .omw version is io/omwMigrate.ts requiredVersion); a file from a newer app keeps
   *  its higher number so saving it again never claims an older version than its contents */
  version: number;
  id: string;
  title: string;
  created: string;
  modified: string;
  pages: Page[];
  masters: Page[];
  assets: Record<string, AssetRef>;
}

let idCounter = 0;
export function uid(prefix = "n"): string {
  idCounter = (idCounter + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}${idCounter.toString(36)}`;
}

/**
 * A copy of `n` with id `id` whose text paragraphs get new ids too (paragraph ids identify a paragraph,
 * e.g. to map it back to its original Office element: a duplicate must never share them).
 */
export function copyNode<T extends SceneNode>(n: T, id: string): T {
  if (n.type === "TEXT") return { ...n, id, paragraphs: n.paragraphs.map((p) => ({ ...p, id: uid("p") })) } as T;
  // a PDF page's annotations are the copy's own: new ids (written as /NM), edited and deleted apart from the original
  if (n.type === "PDF" && n.annots?.length) return { ...n, id, annots: n.annots.map((a) => ({ ...a, id: uid("annot") })) } as T;
  return { ...n, id };
}

export const IDENTITY: Transform = { x: 0, y: 0, rotation: 0, scale: 1 };

function base(name: string): NodeBase {
  return { id: uid(), name, visible: true, locked: false, opacity: 1, blendMode: "NORMAL", transform: { ...IDENTITY } };
}

export function newRaster(name = t("engine.default.rasterLayer")): RasterNode {
  return { ...base(name), type: "RASTER", tiles: {} };
}

export function newVector(contours: Contour[], name = t("engine.default.path")): VectorNode {
  return { ...base(name), type: "VECTOR", contours, fill: "#4f7cff", stroke: null, strokeWidth: 2, fillRule: "nonzero" };
}

export const DEFAULT_RUN: TextRun = {
  text: "",
  fontFamily: "Pretendard",
  fontSize: 18,
  bold: false,
  italic: false,
  underline: false,
  color: "#1d1f24",
};

export function newParagraph(text = "", run: Partial<TextRun> = {}, align: Align = "LEFT"): TextParagraph {
  return { id: uid("p"), runs: [{ ...DEFAULT_RUN, ...run, text }], align, lineSpacing: 1.6, indent: 0, spaceAfter: 6 };
}

export function newText(text: string, width = 360, run: Partial<TextRun> = {}): TextNode {
  const paragraphs = text.split("\n").map((t) => newParagraph(t, run));
  return { ...base(t("engine.default.text")), type: "TEXT", width, paragraphs, wordBreak: "keep-all", background: null };
}

export function newImage(assetId: string, width: number, height: number, name = t("engine.default.image")): ImageNode {
  return { ...base(name), type: "IMAGE", assetId, width, height };
}

export function newPdf(assetId: string, pageIndex: number, width: number, height: number): PdfNode {
  return { ...base(t("engine.default.pdfPage", { page: pageIndex + 1 })), type: "PDF", assetId, pageIndex, width, height, covers: [], locked: true };
}

export function newGroup(name: string, parentId: string | null = null): LayerGroup {
  return { id: uid("g"), name, parentId, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH" };
}

export const MONO_FONT = "Consolas";

export function newTable(rows: TableCell[][] | string[][], colWidths?: number[], name = t("engine.default.table")): TableNode {
  const cells: TableCell[][] = rows.map((r) => r.map((c) => (typeof c === "string" ? { text: c } : c)));
  const cols = Math.max(1, ...cells.map((r) => r.length));
  for (const r of cells) while (r.length < cols) r.push({ text: "" });
  if (!cells.length) cells.push(Array.from({ length: cols }, () => ({ text: "" })));
  return {
    ...base(name),
    type: "TABLE",
    rows: cells,
    colWidths: colWidths && colWidths.length === cols ? colWidths : Array.from({ length: cols }, () => 120),
    rowHeight: 28,
    headerRow: true,
    fontFamily: DEFAULT_RUN.fontFamily,
    fontSize: 13,
    color: "#1d1f24",
    borderColor: "#c9ced8",
    headerFill: "#eef1f6",
    background: "#ffffff",
  };
}

export function newMedia(media: MediaKind, assetId: string, width: number, height: number, name = media === "video" ? t("engine.default.video") : t("engine.default.audio")): MediaNode {
  return { ...base(name), type: "MEDIA", media, assetId, posterAssetId: null, width, height, duration: 0, trimStart: 0, trimEnd: null, muted: false, loop: false, autoplay: true };
}

export const PAGE_PRESETS = {
  A4: { width: 794, height: 1123, kind: "DOCUMENT" as PageKind, label: "A4 문서" }, // i18n: ui
  SLIDE_16_9: { width: 1280, height: 720, kind: "SLIDE" as PageKind, label: "16:9 슬라이드" }, // i18n: ui
  ARTBOARD: { width: 1920, height: 1080, kind: "DESIGN" as PageKind, label: "1920×1080 아트보드" }, // i18n: ui
  SQUARE: { width: 1080, height: 1080, kind: "DESIGN" as PageKind, label: "1080 정사각" }, // i18n: ui
};

export function newPage(kind: PageKind = "DESIGN", width = 1920, height = 1080, name = t("engine.default.page")): Page {
  return {
    id: uid("pg"),
    name,
    kind,
    width,
    height,
    background: "#ffffff",
    nodes: [],
    masterId: null,
    transition: { type: kind === "SLIDE" ? "FADE" : "NONE", duration: 400 },
    animations: [],
  };
}

export { DEFAULT_TITLE };

export function newDocument(title = DEFAULT_TITLE): OmwDocument {
  const now = new Date().toISOString();
  const first = newPage("DESIGN", 1920, 1080, t("doc.pageName.DESIGN", { n: 1 }));
  first.nodes.push(newRaster(t("engine.default.backgroundRaster")));
  return { format: "omw", version: 1, id: uid("doc"), title, created: now, modified: now, pages: [first], masters: [], assets: {} };
}

/**
 * Links pages imported from a DOCX / XLSX / HWPX to the original package (kept as an asset) so "save in the
 * original format" rewrites only the changed paragraphs / cells and copies everything else byte for byte
 * (io/officesurgeon, docs/design/OFFICE_SURGEON.md).
 */
export interface OfficeSourceMeta {
  /** Office Surgeon rule version the map was made with (another version → the file is written anew) */
  engine: number;
  /** paragraph model version of the fingerprints (officesurgeon/common.ts MODEL_VERSION); absent = 1 (older .omw) */
  model?: number;
  /** headers / footers were read into the pages (officesurgeon/hf.ts HF_MAP_VERSION); absent = older map: they stay as in the original */
  hf?: number;
  /** HWPX: key of the pages' headers / footers right after import (officesurgeon/hf.ts hfStateKey) */
  hfKey?: string;
  /** asset holding the original file bytes (as opened: still encrypted for a password-protected HWPX), and its content hash */
  assetId: string;
  hash: string;
  /** body parts in order: DOCX word/document.xml, HWPX one per section, XLSX one per sheet */
  parts: OfficeSourcePart[];
  /** pictures read into IMAGE nodes (model 5 on; officesurgeon/pics.ts): where each is in the file and its fingerprint */
  pics?: OfficeSourcePic[];
  /**
   * footnotes / endnotes read with their references (model 7 on): each note's kind, its id in the file (DOCX w:id,
   * HWPX instId) and the fingerprint of its text, in document order; absent = an older map (notes left as in the file)
   */
  notes?: { k: "foot" | "end"; id: string; fp: string }[];
}

/** One picture of an Office body: the IMAGE node made from it, its part, top-level element and picture index there. */
export interface OfficeSourcePic {
  id: string;
  part: string;
  b: number;
  k: number;
  fp: string;
}

export interface OfficeSourcePart {
  /** package entry name, e.g. "word/document.xml" */
  part: string;
  /** one per top-level body element in file order (DOCX / HWPX) */
  blocks: OfficeSourceBlock[];
  /** XLSX: the table node ids made from the sheet, and a content hash per sheet row (index = row number) */
  tables?: string[];
  rows?: string[];
}

export interface OfficeSourceBlock {
  /** paragraph ids / table node ids made from the element, in order; empty for elements without content */
  ids: string[];
  /** content fingerprint of each item right after import */
  fp: string[];
  /** tables: fingerprint of the table-level format (column widths, header row, fonts) at import; "" for paragraphs */
  tp?: string[];
}
