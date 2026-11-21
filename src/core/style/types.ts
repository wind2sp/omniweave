// Unified, format-independent style model (docs/design/UNIFIED_STYLES.md ch. 4).
// One concept = one type: a fill is a Paint everywhere, a line is a Stroke, character formatting is a CharStyle.
// Rules every field here follows:
//   • optional and omitted when it has its default value (node hashes are JSON.stringify based — loom.ts nodeHash —
//     so a field that is merely present would change the hash of an untouched node);
//   • original values and original units are kept (Len keeps the unit a file used; Color keeps CMYK / spot / theme
//     references next to the sRGB used for display), conversion happens only when computing.
// Phase A defines the types and pure helpers only; no node carries these fields yet (the per-node legacy fields —
// VectorNode.fill / stroke / strokeWidth, TextRun.bold … — are read through the converters in this folder).

import type { CropRect, Contour, PixelTile, Vec2 } from "../types";

// ───────── lengths ─────────

/** Length units files use: CSS px, points, 1/1000 em (PS / AI tracking), percent, EMU (OOXML), twips (Word), HWPUNIT (한글). */
export type LenUnit = "px" | "pt" | "em1000" | "pct" | "emu" | "twip" | "hwpunit";

/** A length in the unit it came in. `pct` and `em1000` need a basis (font size, …) to become px. */
export interface Len {
  v: number;
  u: LenUnit;
}

// ───────── colour ─────────

export type ColorSpace = "rgb" | "cmyk" | "gray" | "lab" | "spot";

/** Theme colour reference (PPTX schemeClr / DOCX w:themeColor) with its modifiers (lumMod, lumOff, tint, shade, alpha…). */
export interface ThemeRef {
  theme: string;
  mods?: Record<string, number>;
}
/** Document swatch reference (global swatch). */
export interface SwatchRef {
  swatch: string;
}

export interface Color {
  /** sRGB used for display, "#rrggbb" — always present */
  hex: string;
  /** alpha 0..1, omitted when 1 */
  a?: number;
  /** original colour space, omitted when rgb */
  space?: ColorSpace;
  /** original components in that space (cmyk 0..1 × 4, gray 0..1, lab L 0..100 a b −128..127) */
  v?: number[];
  /** separation (spot) colour: name and tint 0..1 */
  spot?: { name: string; tint: number };
  /** theme colour or document swatch this colour came from */
  ref?: ThemeRef | SwatchRef;
  /** PDF original colour operators (ColorState.replay): written back verbatim while the colour is unchanged */
  replay?: string;
}

// ───────── paint ─────────

export interface GradientStop {
  /** position 0..1 */
  at: number;
  color: Color;
  /** Photoshop midpoint 0..1, omitted when 0.5 */
  mid?: number;
}

export type GradientKind = "linear" | "radial" | "angular" | "diamond";

export type Paint =
  | { type: "solid"; color: Color }
  | {
      type: "gradient";
      kind: GradientKind;
      stops: GradientStop[];
      /** unit coordinates of the node's bounding box (0..1), like SVG objectBoundingBox / PPTX lin ang / PS angle */
      from: Vec2;
      to: Vec2;
      aspect?: number;
      spread?: "pad" | "repeat" | "reflect";
      smooth?: number;
      dither?: boolean;
    }
  | { type: "pattern"; preset?: string; fg?: Color; bg?: Color; assetId?: string; scale?: number; offset?: Vec2 }
  | { type: "image"; assetId: string; fit: "stretch" | "fill" | "fit" | "tile"; crop?: CropRect; alpha?: number };

export type PaintType = Paint["type"];

// ───────── stroke ─────────

export type LineCap = "butt" | "round" | "square";
export type LineJoin = "miter" | "round" | "bevel";
export type ArrowType = "triangle" | "stealth" | "diamond" | "oval" | "arrow" | "none";
export type ArrowSize = "sm" | "med" | "lg";

export interface Arrow {
  type: ArrowType;
  w?: ArrowSize;
  l?: ArrowSize;
}

export interface Stroke {
  paint: Paint;
  width: Len;
  /** omitted = center */
  align?: "center" | "inside" | "outside";
  cap?: LineCap;
  join?: LineJoin;
  miter?: number;
  /** dash pattern in multiples of the stroke width (PPTX / Word convention) */
  dash?: number[];
  /** original named dash ("dash", "sysDot", "lgDashDot"…) */
  dashPreset?: string;
  dashOffset?: number;
  compound?: "single" | "double" | "thickThin" | "thinThick" | "triple";
  start?: Arrow;
  end?: Arrow;
  scaleWithObject?: boolean;
}

// ───────── effects ─────────

/** Every blend mode the style system knows (Photoshop's 27; see blend.ts for the per-format table). */
export type StyleBlend =
  | "NORMAL" | "DISSOLVE"
  | "DARKEN" | "MULTIPLY" | "COLOR_BURN" | "LINEAR_BURN" | "DARKER_COLOR"
  | "LIGHTEN" | "SCREEN" | "COLOR_DODGE" | "LINEAR_DODGE" | "LIGHTER_COLOR"
  | "OVERLAY" | "SOFT_LIGHT" | "HARD_LIGHT" | "VIVID_LIGHT" | "LINEAR_LIGHT" | "PIN_LIGHT" | "HARD_MIX"
  | "DIFFERENCE" | "EXCLUSION" | "SUBTRACT" | "DIVIDE"
  | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY";

interface EffectBase {
  on: boolean;
  blend?: StyleBlend;
  opacity?: number;
}

export type Effect = EffectBase &
  (
    | { type: "dropShadow" | "innerShadow"; color: Color; angle: number; distance: Len; spread: number; size: Len; noise?: number; knockout?: boolean; scale?: Vec2; globalLight?: boolean }
    | { type: "outerGlow" | "innerGlow"; paint: Paint; spread: number; size: Len; source?: "edge" | "center"; range?: number }
    | { type: "bevel"; style: "inner" | "outer" | "emboss" | "pillow" | "strokeEmboss"; depth: number; size: Len; soften: Len; angle: number; altitude: number; highlight: Color; shadow: Color }
    | { type: "satin"; color: Color; angle: number; distance: Len; size: Len; invert?: boolean }
    | { type: "overlay"; paint: Paint }
    | { type: "fxStroke"; stroke: Stroke }
    | { type: "blur"; radius: Len }
    | { type: "softEdge"; radius: Len }
    | { type: "reflection"; distance: Len; size: number; startAlpha?: number; endAlpha?: number; blur?: Len }
  );

export type EffectType = Effect["type"];

// ───────── masks ─────────

interface MaskBase {
  enabled?: boolean;
  linked?: boolean;
  density?: number;
  feather?: Len;
  invert?: boolean;
}

export type Mask = MaskBase &
  (
    | { kind: "raster"; tiles: Record<string, PixelTile>; bounds: CropRect; defaultValue: 0 | 255 }
    | { kind: "vector"; contours: Contour[]; fillRule: "nonzero" | "evenodd" }
  );

// ───────── shape geometry ─────────

/** Live shape: preset name (PPTX prstGeom names) + parameters; contours stay stored next to it as derived data. */
export interface ShapeGeom {
  preset: string;
  params: Record<string, number>;
}

// ───────── text ─────────

export type Underline = "single" | "double" | "thick" | "dotted" | "dash" | "wavy" | "words";

export interface FontRef {
  /** name used on screen (after substitution) */
  family: string;
  /** name written in the file (PostScript name included) — saving prefers this */
  original?: string;
  scripts?: { latin?: string; ea?: string; cs?: string; hanja?: string; symbol?: string };
}

export interface CharStyle {
  font?: FontRef;
  size?: Len;
  weight?: number;
  italic?: boolean;
  underline?: Underline;
  underlineColor?: Color;
  strike?: "single" | "double";
  caps?: "all" | "small";
  baseline?: Len | "super" | "sub";
  scriptScale?: number;
  tracking?: Len;
  kerning?: "auto" | "metrics" | "optical" | "none";
  hscale?: number;
  vscale?: number;
  fill?: Paint;
  stroke?: Stroke;
  effects?: Effect[];
  highlight?: Color;
  highlightName?: string;
  lang?: string;
  features?: Record<string, boolean | number>;
  link?: { href: string };
  emphasis?: string;
}

export type LineHeight =
  | { mode: "multiple"; v: number; basis: "font" | "em" }
  /** basis "font" (at least only): the natural line is the font's own single line, as in Word (DOCX, Word-multiple
   *  paragraphs); absent: 1.2 × the size, as every document before it (한글, older files) */
  | { mode: "exact" | "atLeast"; v: Len; basis?: "font" }
  | { mode: "between"; v: Len };

export interface TabStop {
  at: Len;
  align: "left" | "center" | "right" | "decimal";
  leader?: "dot" | "dash" | "line" | "none";
}

export interface ParaStyle {
  align?: "left" | "center" | "right" | "justify" | "distribute";
  indent?: { start?: Len; end?: Len; first?: Len };
  spaceBefore?: Len;
  spaceAfter?: Len;
  lineHeight?: LineHeight;
  tabs?: TabStop[];
  defaultTab?: Len;
  list?: { id: string; level: number };
  keepNext?: boolean;
  keepLines?: boolean;
  widow?: boolean;
  breakBefore?: "page" | "column";
  shading?: Paint;
  direction?: "ltr" | "rtl";
  wordBreak?: "keep-all" | "normal";
  /** semantic role kept for Markdown / HTML / DOCX round trips (same values as TextParagraph.role) */
  role?: string;
}

export interface TextFrame<P = unknown> {
  paragraphs: P[];
  insets?: { l: Len; t: Len; r: Len; b: Len };
  vAlign?: "top" | "middle" | "bottom";
  autofit?: "none" | "shrink" | "grow";
  columns?: { n: number; gap: Len };
  writingMode?: "horizontal" | "vertical-rl";
}

// ───────── document level ─────────

export interface NamedStyle {
  id: string;
  name: string;
  type: "para" | "char" | "table";
  basedOn?: string;
  next?: string;
  char?: CharStyle;
  para?: ParaStyle;
  /** original style id / name in the source file */
  src?: string;
}

/** One list level (core/lists.ts). */
export interface ListLevel {
  /** number format (core/lists.ts ListFormat): "bullet", "decimal", "lowerLetter", "ganada", "circled" … */
  format: string;
  /** marker text: "%1." "%1.%2." (Word lvlText; %n = the number of level n), or the bullet character */
  text: string;
  /** first number, omitted when 1 */
  start?: number;
  /** left indent of the level's lines and its first-line indent (negative = hanging, where the marker sits) */
  indent?: ParaStyle["indent"];
  char?: CharStyle;
  /**
   * The HWPX element the level was read from (io/office.ts): its numFormat (formats the model has only a nearest name
   * for — ㉮ CIRCLED_HANGUL_SYLLABLE, ㉠ CIRCLED_HANGUL_JAMO …), the hh:paraHead (or hh:bullet) as written, and the
   * level as it was read. While the level is unchanged the marker uses `fmt` (core/lists.ts levelFormat) and a full
   * HWPX rewrite writes `raw` again (checkable, charPrIDRef, align … as 한글 wrote them).
   */
  hwpx?: { fmt: string; raw: string; format: string; text: string; start?: number };
}

export interface ListDef {
  id: string;
  levels: ListLevel[];
  /** heading outline numbering (개요 번호): a heading's level decides its list level */
  outline?: boolean;
  /** preset it was made from (core/lists.ts LIST_PRESETS), kept so the dialog can show it */
  preset?: string;
  /** original id in the source file (DOCX abstractNumId, HWPX numbering / bullet id) */
  src?: string;
  /** HWPX hh:paraHead elements of levels the model does not keep (한글 level 10), as written — a full rewrite writes them again */
  hwpxMore?: string[];
}

export interface DocTheme {
  colors: Record<string, Color>;
  fonts?: { major?: string; minor?: string };
}

export interface Swatch {
  id: string;
  name: string;
  color: Color;
  global?: boolean;
}

/** Document-level style fields (all optional, omitted when empty). */
export interface DocStyleFields {
  styles?: NamedStyle[];
  lists?: ListDef[];
  theme?: DocTheme;
  swatches?: Swatch[];
}
