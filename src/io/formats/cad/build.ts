// CadDrawing → Omniweave pages. Layers become top-level layer groups (on/off, freeze, lock), block inserts and
// dimensions become nested groups (block name kept, insert counts on the page source), entities become editable
// VECTOR paths (the pen / anchor tools work on them) and TEXT nodes. Coordinates: drawing units → page px at a
// standard plot scale chosen so the drawing fits about an A0 sheet; lineweights are paper millimetres as plotted.
// docs/design/CAD_IMPORT.md §4–5.

import { t } from "../../../i18n";
import { cssFont, layoutText, measure } from "../../../core/text";
import { PX_PER } from "../../../core/units";
import { cadTextAt, cadTextSig, insLocal } from "../../../core/cadText";
import { DEFAULT_RUN, newImage, newPage, newVector, uid, type AssetRef, type CadGroupMeta, type CadRefMeta, type CadSourceMeta, type CadStyleSource, type CadHatch, type Contour, type ImageNode, type LayerGroup, type Page, type SceneNode, type TextNode, type TextParagraph, type TextRun, type VectorNode } from "../../../core/types";
import { cadHex } from "./aci";
import { IDENT, PathBuilder, ap, arcEnd, arcTo, av, fitPath, mul, ocs, polyPath, rings, rotateM, scaleM, scaleOf, splinePath, translate, type Mat } from "./geom";
import { mmPerUnit, scaleLabel, unitSymbol, type CadColor, type CadDrawing, type CadEntity, type CadGeom, type CadLayer, type HatchLine, type HatchLoop, type P2, type PolyVertex } from "./model";
import { parseMtext, textCodes, type CadPara, type CadRun } from "./mtext";
import { shxKeyOf } from "./shx";
import { hasShxPair, STROKE_FAMILY, STROKE_MONO, STROKE_SHX, strokeAdvance, strokeVariantOf, type StrokeVariant } from "./strokeFont";

const PX_MM = PX_PER.mm;
/** cap height ÷ font size of the stand-in fonts (Pretendard ≈ 0.72) */
const CAP = 0.72;
/**
 * MTEXT wraps a little past its width: AutoCAD 2027 kept 140.3 pt of 굴림 text on a 37-unit (138.8 pt) column line
 * and wrapped 232 pt on a 60-unit (225 pt) one (omni-cad-03 plot).
 */
const MTEXT_WRAP_SLACK = 1.02;
/** MTEXT line pitch ÷ text height: 1.70 in the same plot (2.5 → 15.96 pt of 9.38, 3 → 19.2 pt of 11.25), not 5/3 */
const MTEXT_PITCH = 1.705;
/** height a stack on the first line adds to the top of a middle-attached MTEXT box ÷ text height (textNodes) */
const STACK_BOX_EXTRA = 2;
/** more nodes than this: same-style lines of a layer are merged into shared paths */
const MAX_NODES = 25000;
const MAX_HATCH_SEGMENTS = 20000;
const MAX_INSERT_DEPTH = 16;
const MAX_ARRAY = 10000;
/** standard plot scales (drawing mm per paper mm) */
const SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000, 1e6];
const ENLARGE = [0.5, 0.2, 0.1, 0.05, 0.02, 0.01];
/** longest paper side the drawing is scaled to fit (A0) */
const SHEET_MM = 1189;

interface Grp {
  id: string;
  name: string;
  parent: Grp | null;
  /** layer of the top-level group the insert sits in */
  top: string;
  cad: CadGroupMeta;
  used?: boolean;
}

interface PathItem {
  kind: "path";
  type: string;
  contours: Contour[];
  stroke: string | null;
  fill: string | null;
  /** lineweight, paper mm */
  lw: number;
  /** polyline width in drawing units (drawn as the stroke width when set) */
  width?: number;
  /** dash pattern in drawing units (canvas order: dash, gap, …) */
  dash?: number[];
  /** ByLayer linetype: pattern scale and piece lengths (drawing units), so a layer linetype change can lay it out again */
  lt?: { s: number; segs?: number[] };
  evenodd?: boolean;
  layer: string;
  grp: Grp | null;
  name?: string;
  invisible?: boolean;
  /** construction line / ray: clipped to the drawing extents once they are known */
  xline?: { p: P2; dir: P2; ray: boolean };
  /** a hatch: its definition for the drawing screen (HATCHEDIT) and the DXF export (VectorNode.cadHatch) */
  hatch?: CadHatch;
  /** a layout viewport's frame: the viewport's centre on the sheet (VectorNode.cadVpFrame) */
  vpFrame?: P2;
}

interface TextItem {
  kind: "text";
  /** cut by a viewport / XCLIP boundary across its box: shown only inside this outline (drawing coordinates) */
  mask?: P2[];
  type: string;
  layer: string;
  grp: Grp | null;
  anchor: P2;
  /** text x axis and up axis in drawing units (up has the text height as its length) */
  xdir: P2;
  up: P2;
  paras: CadPara[];
  color: string;
  layerColor: string;
  blockColor: string;
  font: string;
  wf: number;
  italic: boolean;
  hAlign: 0 | 1 | 2;
  vAlign: "baseline" | "bottom" | "middle" | "top";
  mtext: boolean;
  /** the source entity's group codes (TEXT / MTEXT): written back as they were while the text is unchanged */
  raw?: [number, string | number][];
  /** one column of a column MTEXT: the entity's key (its first column carries `raw`, the text's codes for them all) */
  col?: string;
  /** a block's text: the insert it came in with (its codes are in the block's coordinates) */
  ins?: { p: [number, number]; rot: number; sx: number; sy: number };
  /** MTEXT reference width (drawing units), 0 = no wrapping */
  boxW: number;
  /** MTEXT line spacing factor */
  spacing: number;
  invisible?: boolean;
  /** set in Omni Stroke (exact widths) */
  stroke?: StrokeVariant | null;
  /** an SHX style without a big font (its Hangul set narrower, SHX_NO_BIGFONT_CJK) */
  shxNoBig?: boolean;
}

/** A linked picture (IMAGE whose file was found): its corner and the two edge vectors, drawing units. */
interface ImageItem {
  kind: "image";
  type: string;
  layer: string;
  grp: Grp | null;
  assetId: string;
  name: string;
  /** bottom-left corner and the full width / height edge vectors (image u × width, v × height) */
  p: P2;
  u: P2;
  v: P2;
  /** shown part as fractions of the picture (x, y from the top-left, w, h) */
  crop?: { x: number; y: number; w: number; h: number };
  /** polygonal clip boundary (IMAGECLIP with 3 or more corners), drawing coordinates */
  mask?: P2[];
  invisible?: boolean;
}

type Item = PathItem | TextItem | ImageItem;

interface Ctx {
  m: Mat;
  inBlock: boolean;
  /** insert's layer (for entities on layer 0 inside the block) */
  layer: string;
  color: string;
  lwRaw: number;
  ltype: string;
  /** the insert's linetype was ByLayer (BYBLOCK members follow its layer) */
  byLayer?: boolean;
  grp: Grp | null;
  depth: number;
  stack: string[];
}

export interface CadBuildResult {
  pages: Page[];
  assets: Record<string, AssetRef>;
  warnings: string[];
  /** drawn entities by DXF type, over all pages */
  counts: Record<string, number>;
  /** read but not drawn, by type */
  unsupported: Record<string, number>;
  layers: number;
  /** plot scale of the model page (100 = 1:100) */
  scale: number;
}



/** Plot scale that fits `extentMm` (the longer side) on about an A0 sheet, enlarging very small drawings. */
export function pickScale(extentMm: number): number {
  if (!(extentMm > 0)) return 1;
  if (extentMm <= SHEET_MM) {
    let s = 1;
    if (extentMm < 50) for (const e of ENLARGE) if (extentMm / e <= SHEET_MM / 4) s = e;
    return s;
  }
  return SCALES.find((s) => extentMm / s <= SHEET_MM) ?? extentMm / SHEET_MM;
}

const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;
/**
 * Advance of a string in em: exact for the Omni Stroke font (SHX stand-in), rough otherwise (layout happens later with
 * the real font).
 */
function emWidth(s: string, stroke?: StrokeVariant | null): number {
  if (stroke) return strokeAdvance(s, stroke);
  let w = 0;
  for (const ch of s) w += CJK.test(ch) ? 1 : ch === " " ? 0.3 : 0.6;
  return w;
}

/**
 * Hangul / CJK in a Latin TrueType style (Arial …): AutoCAD draws it in the Korean system font 굴림, spaces between
 * and after the syllables too (a space after Latin text stays Latin: omni-cad-04 "중첩 3단, 레이어"), a little smaller
 * than the Latin text — measured in the AutoCAD 2027 plot of omni-cad-03: text
 * height 2.5 → Arial 13.07 pt, 굴림 12.76 pt (one syllable a full em, a space a third).
 */
export const CJK_FALLBACK = "굴림"; // i18n: keep — font name
/** text height ÷ font size of 굴림 as AutoCAD sets it */
const CJK_FALLBACK_CAP = 0.735;
/** advance scale of fallback 굴림 runs (drawn at the run's size, narrowed so the line pitch stays the run's) */
export const CJK_FALLBACK_SCALE = CAP / CJK_FALLBACK_CAP;
/**
 * Text height ÷ font size AutoCAD sets a TrueType font at, where it differs from CAP (the plots: Arial 2.5 → 13.07 pt,
 * 3 → 15.68 pt; 맑은 고딕 3 → 15.62 pt = CAP). Lower-case family names.
 */
const TTF_CAP: Record<string, number> = { arial: 0.7175 };
/** size scale of a family's runs (1 for Omni Stroke and fonts set at CAP) */
export const ttfScale = (family: string): number => CAP / (TTF_CAP[family.toLowerCase()] ?? CAP);
const CJK_RUN = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿]+(?:[ 　]+[ᄀ-ᇿ⺀-鿿가-힯豈-﫿]+)*[ 　]*/g;
/** Fonts with Hangul / CJK glyphs of their own (no fallback). */
const CJK_FAMILY = /[가-힣ぁ-ヿ一-鿿]|malgun|gulim|batang|dotum|gungsuh|gothic|mincho|ming|sim(sun|hei)|yahei|jhenghei|meiryo|nanum|noto sans (kr|jp|sc|tc|cjk)|pretendard/i; // i18n: keep — font names

/** A Latin TrueType family whose CJK text AutoCAD sets in the fallback font. */
export function needsCjkFallback(family: string): boolean {
  return !!family && !strokeVariantOf(family) && !CJK_FAMILY.test(family);
}

/**
 * Hangul / CJK cell of an SHX style without a big font ÷ Omni Stroke's Hangul cell: AutoCAD puts a '?' in its place,
 * about one text height wide (omni-cad-03 plot: txt 0.98, romans 1.08 × the height; whgtxt Hangul 1.22 — Omni
 * Stroke's 1.25). The Hangul stays (content kept), narrowed to that cell.
 */
export const SHX_NO_BIGFONT_CJK = 0.8;
const CJK_CHARS = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿]+/g;

/**
 * Text → pieces in the family itself and (cjk) in the fallback font, as AutoCAD splits them; `chars`: every CJK
 * character whatever the family, spaces between them not included (an SHX style without a big font).
 */
export function splitCjk(s: string, family: string, chars = false): { text: string; cjk: boolean }[] {
  if (!chars && !needsCjkFallback(family)) return [{ text: s, cjk: false }];
  const out: { text: string; cjk: boolean }[] = [];
  let at = 0;
  for (const m of s.matchAll(chars ? CJK_CHARS : CJK_RUN)) {
    if (m.index! > at) out.push({ text: s.slice(at, m.index), cjk: false });
    out.push({ text: m[0], cjk: true });
    at = m.index! + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at), cjk: false });
  return out;
}

/**
 * Advance of a run's text in em of its size, measured with the font it is drawn in (Omni Stroke exactly, TrueType by
 * the text engine's measurer — the canvas in the app, an estimate in Node), CJK fallback pieces included.
 */
export function runEm(text: string, family: string, bold?: boolean, italic?: boolean): number {
  const sv = strokeVariantOf(family);
  if (sv) return strokeAdvance(text, sv);
  let w = 0;
  for (const p of splitCjk(text, family)) {
    const f = cssFont({ fontSize: 100, fontFamily: p.cjk ? CJK_FALLBACK : family, bold: !!bold, italic: !!italic });
    w += (measure(p.text, f) / 100) * (p.cjk ? CJK_FALLBACK_SCALE : ttfScale(family));
  }
  return w;
}

/** TrueType file / family of a text style → a font Omniweave has; SHX fonts (not redistributable) → Pretendard. */
const TTF_FAMILY: Record<string, string> = {
  arial: "Arial",
  arialbd: "Arial",
  arialn: "Arial Narrow",
  times: "Times New Roman",
  timesbd: "Times New Roman",
  cour: "Courier New",
  calibri: "Calibri",
  tahoma: "Tahoma",
  verdana: "Verdana",
  isocpeur: "Arial",
  isocteur: "Arial",
  malgun: "맑은 고딕", // i18n: keep
  malgunbd: "맑은 고딕", // i18n: keep
  gulim: "굴림", // i18n: keep
  batang: "바탕", // i18n: keep
  dotum: "돋움", // i18n: keep
  gungsuh: "궁서", // i18n: keep
  simsun: "SimSun",
  simhei: "SimHei",
  msgothic: "MS Gothic",
  msmincho: "MS Mincho",
};

export function fontFamily(font: string | undefined, bigFont?: string): { family: string; shx?: string } {
  // the style's SHX files were found on this computer (cad/shxLoad.ts): their own shapes
  const key = shxKeyOf(font, bigFont);
  if (key && hasShxPair(key)) return { family: STROKE_SHX + key, shx: key.split("+")[0] };
  const f = (font ?? "").trim();
  if (!f) return { family: STROKE_MONO, shx: "txt" };
  const base = f.replace(/^.*[\\/]/, "");
  // [^]: a damaged style name can hold a line break, which "." does not match (exec gave null — QA cad-verify fuzz)
  const m = /^([^]*?)(\.(shx|ttf|ttc|otf))?$/i.exec(base)!;
  const ext = (m[3] ?? "").toLowerCase();
  if (ext === "shx" || (!ext && /^(txt|simplex|romans|romand|romant|romanc|complex|italic|isocp|isoct|monotxt|gothic\w*|script\w*|greek\w*|whg\w*|hgt\w*|bigfont|extfont\w*)$/i.test(m[1])))
    return { family: /^(txt|monotxt)$/i.test(m[1]) ? STROKE_MONO : STROKE_FAMILY, shx: m[1].toLowerCase() };
  if (ext) return { family: TTF_FAMILY[m[1].toLowerCase()] ?? m[1] };
  return { family: TTF_FAMILY[f.toLowerCase()] ?? f };
}


/** Linetype pattern (+ dash, − gap, 0 dot) → canvas dash list (dash, gap, …), starting with a dash. */
export function dashList(pattern: number[], scale: number): number[] | undefined {
  if (!pattern.length) return undefined;
  const out: number[] = [];
  for (const v of pattern) {
    const len = Math.abs(v) * scale;
    const isDash = v >= 0;
    const wantDash = out.length % 2 === 0;
    if (isDash === wantDash) out.push(len);
    else if (out.length) out[out.length - 1] += len;
    else out.push(0, len);
  }
  if (out.length % 2) out.push(0);
  return out.some((v) => v > 0) && out.some((v, i) => i % 2 === 1 && v > 0) ? out : undefined;
}

/** Infinite / half line clipped to a rectangle: the visible segment, or null. */
function clipLine(p: P2, dir: P2, ray: boolean, box: [number, number, number, number]): [P2, P2] | null {
  let t0 = ray ? 0 : -Infinity, t1 = Infinity;
  for (let a = 0; a < 2; a++) {
    const lo = box[a], hi = box[a + 2];
    if (Math.abs(dir[a]) < 1e-15) {
      if (p[a] < lo || p[a] > hi) return null;
      continue;
    }
    let u = (lo - p[a]) / dir[a], v = (hi - p[a]) / dir[a];
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
  }
  if (!(t1 > t0)) return null;
  return [
    [p[0] + dir[0] * t0, p[1] + dir[1] * t0],
    [p[0] + dir[0] * t1, p[1] + dir[1] * t1],
  ];
}

/** Pattern line families clipped to the boundary (even-odd), dashes left out: [from, to] segments. */
export function patternSegments(boundary: P2[][], lines: HatchLine[], limit = MAX_HATCH_SEGMENTS): [P2, P2][] | null {
  const segs: [P2, P2][] = [];
  const pts = boundary.flat();
  if (!pts.length) return segs;
  for (const L of lines) {
    const a = (L.angle * Math.PI) / 180;
    const d: P2 = [Math.cos(a), Math.sin(a)];
    const n: P2 = [-d[1], d[0]];
    const step = L.offset[0] * n[0] + L.offset[1] * n[1];
    if (Math.abs(step) < 1e-9) continue;
    let lo = Infinity, hi = -Infinity;
    for (const q of pts) {
      const s = (q[0] - L.base[0]) * n[0] + (q[1] - L.base[1]) * n[1];
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    const k0 = Math.ceil(Math.min(lo / step, hi / step)), k1 = Math.floor(Math.max(lo / step, hi / step));
    if (k1 - k0 > limit) return null;
    for (let k = k0; k <= k1; k++) {
      const o: P2 = [L.base[0] + L.offset[0] * k, L.base[1] + L.offset[1] * k];
      const ts: number[] = [];
      for (const ring of boundary)
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          const sp = (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1];
          const sq = (q[0] - o[0]) * n[0] + (q[1] - o[1]) * n[1];
          if ((sp > 0) === (sq > 0) || sp === sq) continue;
          const f = sp / (sp - sq);
          const x = p[0] + (q[0] - p[0]) * f, y = p[1] + (q[1] - p[1]) * f;
          ts.push((x - o[0]) * d[0] + (y - o[1]) * d[1]);
        }
      ts.sort((x, y) => x - y);
      const at = (t: number): P2 => [o[0] + d[0] * t, o[1] + d[1] * t];
      // dashes (+ dash, − gap, 0 dot) run from the family's origin on each line, as AutoCAD lays them
      const P = L.dashes.reduce((s, v) => s + Math.abs(v), 0);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const t0 = ts[i], t1 = ts[i + 1];
        if (t1 - t0 < 1e-12) continue;
        if (!(P > 1e-9) || (t1 - t0) / P > 2000) {
          segs.push([at(t0), at(t1)]);
          if (segs.length > limit) return null;
          continue;
        }
        for (let c = Math.floor(t0 / P) * P; c < t1; c += P) {
          let s = c;
          for (const v of L.dashes) {
            const e = s + Math.abs(v);
            if (v >= 0) {
              const a = Math.max(s, t0), b = Math.min(v === 0 ? s : e, t1);
              if (b >= a && (v > 0 ? b > a : s >= t0 && s <= t1)) segs.push([at(a), at(b)]);
            }
            s = e;
          }
          if (segs.length > limit) return null;
        }
      }
    }
  }
  return segs;
}

const GRADIENT_BANDS = 48;

/**
 * A gradient fill as colour bands: the boundary rings cut to slabs across the gradient direction (two half-plane
 * clips per ring keep holes as holes under even-odd). LINEAR runs colour 1 → 2 across the extent; the CYLINDER kinds
 * run 1 → 2 → 1 (INV: 2 → 1 → 2); the round kinds (SPHERICAL, HEMISPHERICAL, CURVED) are shown linear along their
 * direction. One-colour gradients go from the colour to its tint (toward white). `shift` moves the middle.
 */
export function gradientBands(boundary: P2[][], gr: NonNullable<Extract<CadGeom, { k: "hatch" }>["grad"]>, hex: (c: CadColor) => string): { color: string; contours: Contour[] }[] {
  const pts = boundary.flat();
  if (!pts.length) return [];
  const d: P2 = [Math.cos(gr.angle), Math.sin(gr.angle)];
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const s = p[0] * d[0] + p[1] * d[1];
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  if (!(hi > lo)) return [];
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const c1 = rgb(hex(gr.colors[0]));
  const c2 = gr.single || gr.colors.length < 2 ? c1.map((v) => v + (255 - v) * (gr.tint ?? 1)) : rgb(hex(gr.colors[1]));
  const name = gr.name.toUpperCase();
  const mirror = /CYLINDER/.test(name);
  const inv = /^INV/.test(name);
  const out: { color: string; contours: Contour[] }[] = [];
  for (let k = 0; k < GRADIENT_BANDS; k++) {
    const s0 = lo + ((hi - lo) * k) / GRADIENT_BANDS, s1 = lo + ((hi - lo) * (k + 1)) / GRADIENT_BANDS;
    let f = Math.min(1, Math.max(0, (k + 0.5) / GRADIENT_BANDS - (gr.shift ?? 0) / 2));
    if (mirror) f = 1 - Math.abs(2 * f - 1);
    if (inv) f = 1 - f;
    const col = "#" + c1.map((v, i) => Math.round(v + (c2[i] - v) * f).toString(16).padStart(2, "0")).join("");
    const contours: Contour[] = [];
    for (const ring of boundary) {
      let poly = ring;
      for (const [sign, lim] of [
        [1, s0],
        [-1, s1],
      ] as const) {
        const inside = (p: P2) => sign * (p[0] * d[0] + p[1] * d[1] - lim) >= 0;
        const next: P2[] = [];
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          const cut = (): P2 => {
            const sp = p[0] * d[0] + p[1] * d[1] - lim, sq = q[0] * d[0] + q[1] * d[1] - lim;
            const t = sp / (sp - sq);
            return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
          };
          if (inside(q)) {
            if (!inside(p)) next.push(cut());
            next.push(q);
          } else if (inside(p)) next.push(cut());
        }
        poly = next;
      }
      if (poly.length >= 3) contours.push({ closed: true, nodes: poly.map(corner) });
    }
    if (!contours.length) continue;
    // neighbouring bands of the same colour become one
    const prev = out[out.length - 1];
    if (prev && prev.color === col) prev.contours.push(...contours);
    else out.push({ color: col, contours });
  }
  return out;
}

function hatchBoundary(loops: HatchLoop[], b: PathBuilder) {
  // b works in the hatch's own coordinates (identity matrix): the pen can be compared with edge ends directly
  for (const loop of loops) {
    if (loop.poly) {
      polyPath(b, loop.poly.pts, true);
      continue;
    }
    let first = true;
    const goto = (x: number, y: number) => {
      if (first) return b.move(x, y);
      const p = b.pen;
      if (!p || Math.hypot(p[0] - x, p[1] - y) > 1e-9 * (1 + Math.abs(x) + Math.abs(y))) b.line(x, y);
    };
    const angles = (a0d: number, a1d: number, ccw: boolean): [number, number] => {
      // clockwise edges store their angles mirrored
      const a0 = ((ccw ? a0d : -a0d) * Math.PI) / 180;
      return [a0, arcEnd(a0, ((ccw ? a1d : -a1d) * Math.PI) / 180, ccw)];
    };
    for (const e of loop.edges ?? []) {
      if (e.k === "line") {
        goto(e.a[0], e.a[1]);
        b.line(e.b[0], e.b[1]);
      } else if (e.k === "arc" || e.k === "ellipse") {
        const [a0, a1] = angles(e.a0, e.a1, e.ccw);
        const u: P2 = e.k === "arc" ? [e.r, 0] : e.major;
        const v: P2 = e.k === "arc" ? [0, e.r] : [-e.major[1] * e.ratio, e.major[0] * e.ratio];
        const s: P2 = [e.c[0] + u[0] * Math.cos(a0) + v[0] * Math.sin(a0), e.c[1] + u[1] * Math.cos(a0) + v[1] * Math.sin(a0)];
        goto(s[0], s[1]);
        arcTo(b, e.c, u, v, a0, a1, true);
      } else if (e.ctrl.length >= 2) {
        const sub = new PathBuilder(IDENT);
        splinePath(sub, e.degree, e.knots, e.ctrl, e.weights);
        for (const c of sub.done())
          c.nodes.forEach((n, i) => {
            if (i === 0) return goto(n.anchor[0], n.anchor[1]);
            const prev = c.nodes[i - 1];
            b.cubic(prev.handleOut[0], prev.handleOut[1], n.handleIn[0], n.handleIn[1], n.anchor[0], n.anchor[1]);
          });
      } else if (e.fit.length >= 2) {
        e.fit.forEach((p, i) => (i === 0 ? goto(p[0], p[1]) : b.line(p[0], p[1])));
      }
      first = false;
    }
    b.close();
  }
}

/** A polyline with varying widths as filled quads, one per segment (arcs sampled), widths running linearly. */
function widthBand(b: PathBuilder, pts: PolyVertex[], closed: boolean) {
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], z = pts[(i + 1) % pts.length];
    const w0 = a.w0 ?? 0, w1 = a.w1 ?? 0;
    const bulge = a.bulge ?? 0;
    const steps = bulge ? 24 : 1;
    const c = Math.hypot(z.x - a.x, z.y - a.y);
    if (c < 1e-12) continue;
    // points (and their unit normals) along the segment
    const at: { p: P2; n: P2 }[] = [];
    if (!bulge) {
      const nx = -(z.y - a.y) / c, ny = (z.x - a.x) / c;
      at.push({ p: [a.x, a.y], n: [nx, ny] }, { p: [z.x, z.y], n: [nx, ny] });
    } else {
      const th = 4 * Math.atan(bulge);
      const r = c / (2 * Math.sin(th / 2));
      const mx = (a.x + z.x) / 2, my = (a.y + z.y) / 2;
      const d = r * Math.cos(th / 2);
      const ux = (z.x - a.x) / c, uy = (z.y - a.y) / c;
      const cx = mx - uy * d, cy = my + ux * d;
      const s0 = Math.atan2(a.y - cy, a.x - cx);
      const R = Math.abs(r);
      for (let k = 0; k <= steps; k++) {
        const ang = s0 + (th * k) / steps;
        const ox = Math.cos(ang), oy = Math.sin(ang);
        // normal pointing left of the travel direction
        const sgn = th > 0 ? -1 : 1;
        at.push({ p: [cx + R * ox, cy + R * oy], n: [sgn * ox, sgn * oy] });
      }
    }
    const L = at.length - 1;
    const left = at.map((q, k) => {
      const w = (w0 + ((w1 - w0) * k) / L) / 2;
      return [q.p[0] + q.n[0] * w, q.p[1] + q.n[1] * w] as P2;
    });
    const right = at.map((q, k) => {
      const w = (w0 + ((w1 - w0) * k) / L) / 2;
      return [q.p[0] - q.n[0] * w, q.p[1] - q.n[1] * w] as P2;
    });
    const ring = [...left, ...right.reverse()];
    ring.forEach((p, k) => (k ? b.line(p[0], p[1]) : b.move(p[0], p[1])));
    b.close();
  }
}

/** Lengths of a polyline's segments (bulges as arcs). */
function polySegments(pts: { x: number; y: number; bulge?: number }[], closed: boolean): number[] {
  const out: number[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], z = pts[(i + 1) % pts.length];
    const c = Math.hypot(z.x - a.x, z.y - a.y);
    const b = a.bulge ?? 0;
    if (!b) out.push(c);
    else {
      const th = 4 * Math.atan(Math.abs(b));
      out.push(th > 1e-9 ? (c / (2 * Math.sin(th / 2))) * th : c);
    }
  }
  return out;
}

/**
 * AutoCAD's line type layout over pieces of given lengths: on every piece the pattern is shifted so the piece starts
 * and ends with a dash of the same length (the pattern centred), and a piece shorter than one pattern is drawn solid.
 * Returns one explicit dash list for the whole path (pieces joined dash to dash); a list that would grow too long
 * keeps the plain pattern, shifted for the first piece.
 */
export function layoutDash(list: number[], segs: number[]): number[] {
  const P = list.reduce((a, v) => a + v, 0);
  if (!(P > 0)) return list;
  const out: number[] = [];
  const push = (len: number, dash: boolean) => {
    if (len <= 0) return;
    const wantDash = out.length % 2 === 0;
    if (dash === wantDash) out.push(len);
    else if (out.length) out[out.length - 1] += len;
    else out.push(0, len);
  };
  const phaseFor = (L: number) => {
    const rem = L - Math.floor(L / P) * P;
    let ph = (list[0] / 2 - rem / 2) % P;
    if (ph < 0) ph += P;
    return ph;
  };
  let total = 0;
  for (const L of segs) total += Math.max(1, Math.ceil(L / P)) * list.length;
  if (total > 4000) {
    // too many dashes to spell out: the cyclic pattern, rotated to the first piece's phase
    let ph = phaseFor(segs[0]);
    let i = 0;
    while (i < list.length - 1 && ph >= list[i]) ph -= list[i++];
    const rot = [...list.slice(i), ...list.slice(0, i)];
    rot[0] -= ph;
    if (i % 2) rot.unshift(0);
    rot.push(ph);
    if (rot.length % 2) rot.push(0);
    return rot;
  }
  for (const L of segs) {
    if (L < P) {
      push(L, true);
      continue;
    }
    let ph = phaseFor(L);
    let i = 0;
    while (i < list.length - 1 && ph >= list[i]) ph -= list[i++];
    let left = L;
    let cur = list[i] - ph;
    while (left > 1e-12) {
      const len = Math.min(cur, left);
      push(len, i % 2 === 0);
      left -= len;
      i = (i + 1) % list.length;
      cur = list[i];
    }
  }
  if (out.length % 2) out.push(P);
  DASH_PERIOD.set(out, P);
  return out;
}

/** pattern length of a laid-out dash list (its total is the path length) */
const DASH_PERIOD = new WeakMap<number[], number>();

// ───────── walk: entities → items in drawing coordinates ─────────

class Walker {
  items: Item[] = [];
  /** item → handle of the top-level entity it was drawn for */
  owner = new Map<Item, string>();
  counts: Record<string, number> = {};
  blocks: Record<string, number> = {};
  /** top-level dimension handle → its group (associativity, DIMASSOC) */
  dimGrp = new Map<string, Grp>();
  unsupported: Record<string, number> = {};
  xrefs = new Set<string>();
  shx = new Set<string>();
  images = 0;
  viewports = 0;
  gradients = 0;
  patterns = 0;
  /** model space shown through the viewports of a layout page */
  model?: CadEntity[];
  /** line type scale correction inside a viewport (PSLTSCALE: dashes keep their paper length) */
  ltK = 1;
  /** layers frozen in the viewport being drawn */
  vpFrozen?: Set<string>;
  /** the last dash() call's scale and pieces (an entity's ByLayer linetype, PathItem.lt) */
  lastLt?: { s: number; segs?: number[] };
  constructor(public d: CadDrawing) {}

  layer(name: string): CadLayer {
    return this.d.layers.get(name.toUpperCase()) ?? { name, color: 7, ltype: "CONTINUOUS", lw: -3, on: true, frozen: false, locked: false, plot: true };
  }

  count(type: string) {
    this.counts[type] = (this.counts[type] ?? 0) + 1;
  }

  color(e: CadEntity, L: CadLayer, ctx: Ctx): string {
    const c = e.color;
    if (c.rgb !== undefined) return cadHex(0, c.rgb);
    if (c.aci === 256 || c.aci < 0 || c.aci > 256) return cadHex(L.color, L.rgb);
    if (c.aci === 0) return ctx.color;
    return cadHex(c.aci);
  }

  lwRaw(e: CadEntity, L: CadLayer, ctx: Ctx): number {
    const v = e.lw === -1 ? L.lw : e.lw === -2 ? ctx.lwRaw : e.lw;
    return v === -2 ? ctx.lwRaw : v;
  }

  lwMm(raw: number): number {
    return (raw >= 0 ? raw : this.d.lwdefault) / 100;
  }

  ltypeName(e: CadEntity, L: CadLayer, ctx: Ctx): string {
    const n = e.ltype.toUpperCase();
    return n === "BYLAYER" ? L.ltype.toUpperCase() : n === "BYBLOCK" ? ctx.ltype : n;
  }

  /**
   * Line type of an entity as a canvas dash list in drawing units. With `segs` (the lengths of the entity's pieces in
   * its own units: one for a line, arc or circle, one per vertex for a polyline) the list is laid out as AutoCAD does:
   * each piece starts and ends with a dash, the pattern centred on it; a piece shorter than one pattern is solid.
   */
  dash(e: CadEntity, name: string, m: Mat, segs?: number[]): number[] | undefined {
    const s = this.d.ltscale * e.ltscale * scaleOf(m) * this.ltK;
    this.lastLt = segs?.length ? { s, segs: segs.map((x) => x * scaleOf(m)) } : { s };
    if (name === "CONTINUOUS") return undefined;
    const lt = this.d.ltypes.get(name);
    if (!lt) return undefined;
    const list = dashList(lt.pattern, s);
    if (!list || !segs?.length) return list;
    return layoutDash(list, segs.map((s) => s * scaleOf(m)));
  }

  walk(ents: CadEntity[], ctx: Ctx) {
    for (const e of ents) this.entity(e, ctx);
  }

  entity(e: CadEntity, ctx: Ctx) {
    const g = e.geom;
    if (!g) return;
    const layerName = ctx.inBlock && e.layer === "0" ? ctx.layer : e.layer;
    if (this.vpFrozen?.has(layerName.toUpperCase())) return;
    const L = this.layer(layerName);
    const color = this.color(e, L, ctx);
    const lwRaw = this.lwRaw(e, L, ctx);
    const ltName = this.ltypeName(e, L, ctx);
    const base = { layer: L.name, grp: ctx.grp, invisible: e.invisible };
    // the linetype comes from the layer (BYLAYER, or BYBLOCK inside a ByLayer insert)
    const byLayer = isByLayer(e, ctx);
    this.lastLt = undefined;
    const path = (contours: Contour[], extra: Partial<PathItem> = {}) => {
      if (!contours.length) return;
      const lt = "dash" in extra && byLayer && this.lastLt ? { lt: this.lastLt } : {};
      this.items.push({ kind: "path", type: e.type, contours, stroke: color, fill: null, lw: this.lwMm(lwRaw), ...base, ...extra, ...lt });
    };
    const mo = mul(ctx.m, ocs(e.extrusion));
    switch (g.k) {
      case "line": {
        const b = new PathBuilder(ctx.m);
        b.move(g.a[0], g.a[1]);
        b.line(g.b[0], g.b[1]);
        path(b.done(), { dash: this.dash(e, ltName, ctx.m, [Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1])]) });
        break;
      }
      case "point": {
        const b = new PathBuilder(ctx.m);
        const mode = this.d.pdmode;
        const ext = this.d.extmin && this.d.extmax ? Math.abs(this.d.extmax[1] - this.d.extmin[1]) : 0;
        const sz = this.d.pdsize > 0 ? this.d.pdsize : (ext || 100) * 0.01 * (this.d.pdsize < 0 ? -this.d.pdsize / 5 : 1);
        const [x, y] = g.p, r = sz / 2;
        if ((mode & 7) === 0) {
          b.move(x, y);
          b.line(x, y);
        } else if ((mode & 7) === 2 || (mode & 7) === 3) {
          const k = (mode & 7) === 3 ? Math.SQRT1_2 : 1;
          const d1: P2 = (mode & 7) === 3 ? [r * k, r * k] : [r, 0];
          const d2: P2 = (mode & 7) === 3 ? [-r * k, r * k] : [0, r];
          b.move(x - d1[0], y - d1[1]);
          b.line(x + d1[0], y + d1[1]);
          b.move(x - d2[0], y - d2[1]);
          b.line(x + d2[0], y + d2[1]);
        } else if ((mode & 7) === 4) {
          b.move(x, y);
          b.line(x, y + r);
        }
        if (mode & 32) arcTo(b, [x, y], [r, 0], [0, r], 0, Math.PI * 2), b.close();
        if (mode & 64) {
          b.move(x - r, y - r);
          b.line(x + r, y - r);
          b.line(x + r, y + r);
          b.line(x - r, y + r);
          b.close();
        }
        path(b.done());
        break;
      }
      case "circle": {
        const b = new PathBuilder(mo);
        arcTo(b, [g.c[0], g.c[1]], [g.r, 0], [0, g.r], 0, Math.PI * 2);
        b.close();
        path(b.done(), { dash: this.dash(e, ltName, mo, [2 * Math.PI * g.r]) });
        break;
      }
      case "arc": {
        const b = new PathBuilder(mo);
        const a0 = (g.a0 * Math.PI) / 180;
        const a1 = arcEnd(a0, (g.a1 * Math.PI) / 180);
        arcTo(b, [g.c[0], g.c[1]], [g.r, 0], [0, g.r], a0, a1);
        path(b.done(), { dash: this.dash(e, ltName, mo, [g.r * (a1 - a0)]) });
        break;
      }
      case "ellipse": {
        // center and major axis are in WCS; the minor axis lies in the plane of the extrusion
        const b = new PathBuilder(ctx.m);
        const n = e.extrusion ?? [0, 0, 1];
        const sgn = n[2] < 0 ? -1 : 1;
        const minor: P2 = [-g.major[1] * g.ratio * sgn, g.major[0] * g.ratio * sgn];
        const t1 = arcEnd(g.t0, g.t1);
        const full = Math.abs(t1 - g.t0 - Math.PI * 2) < 1e-9;
        arcTo(b, [g.c[0], g.c[1]], [g.major[0], g.major[1]], minor, g.t0, t1);
        if (full) b.close();
        path(b.done(), { dash: this.dash(e, ltName, ctx.m) });
        break;
      }
      case "poly": {
        const m = g.is3d ? ctx.m : mul(ctx.m, ocs(e.extrusion, g.elevation ?? 0));
        const b = new PathBuilder(m);
        polyPath(b, g.pts, g.closed);
        const w = g.width ?? Math.max(0, ...g.pts.map((p) => Math.max(p.w0 ?? 0, p.w1 ?? 0)));
        // vertex widths (a missing one is the polyline's default); any that differ: the band, even when the polyline
        // has a default width (omni-cad-20: POLYLINE 40 = 1 with vertex widths 0.5 → 3 → 0)
        const widths = g.pts.flatMap((p) => [p.w0 ?? g.width ?? 0, p.w1 ?? g.width ?? 0]);
        if (widths.some((x) => Math.abs(x - widths[0]) > 1e-12)) {
          // start / end widths that change: drawn as the filled band AutoCAD draws
          const band = new PathBuilder(m);
          widthBand(band, g.width === undefined ? g.pts : g.pts.map((p) => ({ ...p, w0: p.w0 ?? g.width, w1: p.w1 ?? g.width })), g.closed);
          path(band.done(), { stroke: null, fill: color });
          break;
        }
        path(b.done(), { dash: this.dash(e, ltName, m, polySegments(g.pts, g.closed)), ...(w > 0 ? { width: w * scaleOf(m) } : {}) });
        break;
      }
      case "spline": {
        const b = new PathBuilder(ctx.m);
        if (g.ctrl.length >= 2)
          splinePath(
            b,
            g.degree,
            g.knots,
            g.ctrl.map((p) => [p[0], p[1]]),
            g.weights,
          );
        else fitPath(b, g.fit.map((p) => [p[0], p[1]]), g.closed);
        const cs = b.done();
        if (g.closed && cs.length === 1 && !cs[0].closed) {
          const c = cs[0], a = c.nodes[0].anchor, z = c.nodes[c.nodes.length - 1].anchor;
          if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 1e-9 * (1 + Math.abs(a[0]))) {
            c.nodes[0].handleIn = c.nodes[c.nodes.length - 1].handleIn;
            c.nodes.pop();
            c.closed = true;
          }
        }
        path(cs, { dash: this.dash(e, ltName, ctx.m) });
        break;
      }
      case "solid": {
        const b = new PathBuilder(mo);
        const [p1, p2, p3, p4] = g.pts;
        b.move(p1[0], p1[1]);
        b.line(p2[0], p2[1]);
        b.line(p4[0], p4[1]);
        b.line(p3[0], p3[1]);
        b.close();
        path(b.done(), { stroke: null, fill: color });
        break;
      }
      case "hatch": {
        const local = new PathBuilder(IDENT);
        hatchBoundary(g.loops, local);
        const boundary = local.done();
        if (!boundary.length) break;
        const toW = (cs: Contour[]) => mapContours(cs, mo);
        const hatch: CadHatch & { srcH?: string[] } = { ...(g.src && !ctx.inBlock ? { srcH: g.src } : {}), pattern: (g.solid ? "SOLID" : g.pattern || "SOLID").toUpperCase(), scale: 1, angle: 0, loops: rings(boundary).map((r) => r.map((q) => { const w = ap(mo, q[0], q[1]); return [w[0], w[1]] as [number, number]; })) };
        if (g.gradient && g.grad && g.grad.colors.length) {
          // gradient: bands of the interpolated colour, each the boundary cut to a slab across the gradient direction
          const hexOf = (c: CadColor) => (c.rgb !== undefined ? cadHex(0, c.rgb) : c.aci === 256 ? cadHex(L.color, L.rgb) : c.aci === 0 ? ctx.color : cadHex(c.aci));
          const gh: CadHatch = { ...hatch, pattern: "GRADIENT", angle: (g.grad.angle * 180) / Math.PI, color1: hexOf(g.grad.colors[0]), color2: g.grad.colors[1] ? hexOf(g.grad.colors[1]) : "#ffffff", gname: g.grad.name || "LINEAR", gshift: g.grad.shift ?? 0, gsingle: !!g.grad.single };
          for (const band of gradientBands(rings(boundary), g.grad, hexOf))
            path(toW(band.contours), { stroke: null, fill: band.color, evenodd: true, name: hatchName(g.grad.name || g.pattern), hatch: gh });
          break;
        }
        if (g.gradient) this.gradients++;
        if (g.solid || g.gradient || !g.lines.length) {
          if (!g.solid && !g.gradient) this.patterns++;
          path(toW(boundary), { stroke: null, fill: color, evenodd: true, name: hatchName(g.pattern), hatch });
          break;
        }
        const segs = patternSegments(rings(boundary), g.lines);
        if (!segs) {
          this.patterns++;
          path(toW(boundary), { stroke: null, fill: color, evenodd: true, name: hatchName(g.pattern) });
          break;
        }
        const b = new PathBuilder(mo);
        for (const [p, q] of segs) {
          b.move(p[0], p[1]);
          b.line(q[0], q[1]);
        }
        path(b.done(), { name: hatchName(g.pattern), hatch });
        break;
      }
      case "leader": {
        if (g.pts.length < 2) break;
        const b = new PathBuilder(ctx.m);
        g.pts.forEach((p, i) => (i ? b.line(p[0], p[1]) : b.move(p[0], p[1])));
        path(b.done(), { dash: this.dash(e, ltName, ctx.m) });
        if (g.arrow) {
          const [a, c] = g.pts;
          const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
          const s = Math.min(this.d.arrow, len / 2);
          const ux = (c[0] - a[0]) / len, uy = (c[1] - a[1]) / len;
          const h = new PathBuilder(ctx.m);
          h.move(a[0], a[1]);
          h.line(a[0] + ux * s - uy * s / 6, a[1] + uy * s + ux * s / 6);
          h.line(a[0] + ux * s + uy * s / 6, a[1] + uy * s - ux * s / 6);
          h.close();
          path(h.done(), { stroke: null, fill: color });
        }
        break;
      }
      case "mleader": {
        for (const pts of g.lines) {
          if (pts.length < 2) continue;
          const b = new PathBuilder(ctx.m);
          pts.forEach((p, i) => (i ? b.line(p[0], p[1]) : b.move(p[0], p[1])));
          path(b.done());
        }
        // closed filled arrowheads at the first point of each leader line (the landing line has none)
        for (const pts of g.lines.slice(0, Math.max(0, g.lines.length - 1))) {
          if (pts.length < 2 || !(g.arrow > 0)) continue;
          const [a, c] = pts;
          const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
          const s = Math.min(g.arrow, len / 2);
          const ux = (c[0] - a[0]) / len, uy = (c[1] - a[1]) / len;
          const h = new PathBuilder(ctx.m);
          h.move(a[0], a[1]);
          h.line(a[0] + ux * s - (uy * s) / 6, a[1] + uy * s + (ux * s) / 6);
          h.line(a[0] + ux * s + (uy * s) / 6, a[1] + uy * s - (ux * s) / 6);
          h.close();
          path(h.done(), { stroke: null, fill: color });
        }
        if (g.text && g.textP) this.text(e, { k: "mtext", p: g.textP, h: g.textH, w: g.w, attach: g.attach, rot: 0, xdir: g.xdir, text: g.text, style: "STANDARD" }, ctx, L, color);
        if (g.block && g.bm && this.d.blocks.has(g.block.toUpperCase())) {
          // block content: the block placed by its matrix (rows: x' = m0 x + m1 y + m3 …); its attribute values at the
          // block's insertion point, centred (the callout blocks AutoCAD ships put their one attribute there)
          const m = g.bm;
          const sx = Math.hypot(m[0], m[4]), sy = Math.hypot(m[1], m[5]);
          const rot = (Math.atan2(m[4], m[0]) * 180) / Math.PI;
          this.entity({ ...e, geom: { k: "insert", block: g.block, p: [m[3], m[7], m[11]], sx, sy, rot, cols: 1, rows: 1, cs: 0, rs: 0, attribs: [] } }, ctx);
          (g.battr ?? []).forEach((v, i) => {
            if (v) this.text(e, { k: "mtext", p: [m[3], m[7] - i * g.textH * 1.5, m[11]], h: g.textH * sy, w: 0, attach: 5, rot: (rot * Math.PI) / 180, text: v, style: "STANDARD" }, ctx, L, color);
          });
        }
        break;
      }
      case "image": {
        const [p, u, v] = [g.p, g.u, g.v];
        const [w, h] = g.size;
        const file = this.d.imageDefs.get(g.def) ?? "";
        const fileName = file.replace(/^.*[\\/]/, "");
        const assetId = this.d.images?.get(g.def);
        const at = (fx: number, fy: number): P2 => [p[0] + u[0] * w * fx + v[0] * h * (1 - fy), p[1] + u[1] * w * fx + v[1] * h * (1 - fy)];
        const frame = (c = { x: 0, y: 0, w: 1, h: 1 }) => {
          const b = new PathBuilder(ctx.m);
          [at(c.x, c.y + c.h), at(c.x + c.w, c.y + c.h), at(c.x + c.w, c.y), at(c.x, c.y)].forEach((q, i) => (i ? b.line(q[0], q[1]) : b.move(q[0], q[1])));
          b.close();
          return b.done();
        };
        if (!assetId) {
          // not found: the frame and the file name, as AutoCAD shows a missing picture
          this.images++;
          path(frame(), { name: fileName || undefined });
          const ul = Math.hypot(u[0], u[1]) || 1, vl = Math.hypot(v[0], v[1]) || 1;
          const th = Math.min(vl * h, ul * w) * 0.06;
          if (fileName && th > 0)
            this.text(e, { k: "text", p: [p[0] + ((u[0] / ul + v[0] / vl) * th) / 2, p[1] + ((u[1] / ul + v[1] / vl) * th) / 2, 0], h: th, rot: (Math.atan2(u[1], u[0]) * 180) / Math.PI, text: fileName, style: "STANDARD", hj: 0, vj: 0 }, ctx, L, color);
          break;
        }
        const P = ap(ctx.m, p[0], p[1]), U = av(ctx.m, u[0] * w, u[1] * w), V = av(ctx.m, v[0] * h, v[1] * h);
        let crop: ImageItem["crop"];
        let poly: P2[] | undefined;
        if (g.clip && g.clip.length >= 2 && w > 0 && h > 0) {
          // pixel coordinates, (−0.5, −0.5) = the picture's top-left corner; the bounding box crops the picture and
          // a polygon (3 or more corners; the first may be repeated at the end) masks it further
          const xs = g.clip.map((q) => (q[0] + 0.5) / w), ys = g.clip.map((q) => (q[1] + 0.5) / h);
          const x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(1, Math.max(...xs)), y0 = Math.max(0, Math.min(...ys)), y1 = Math.min(1, Math.max(...ys));
          if (x1 > x0 && y1 > y0 && (x0 > 1e-6 || y0 > 1e-6 || x1 < 1 - 1e-6 || y1 < 1 - 1e-6)) crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          const corners = xs.map((x, i): P2 => [x, ys[i]]);
          if (corners.length > 3 && Math.hypot(corners[0][0] - corners[corners.length - 1][0], corners[0][1] - corners[corners.length - 1][1]) < 1e-9) corners.pop();
          if (corners.length >= 3) poly = corners.map(([fx, fy]) => at(fx, fy));
        }
        this.items.push({ kind: "image", type: e.type, layer: L.name, grp: ctx.grp, assetId, name: fileName || t("engine.cad.ent.IMAGE"), p: P, u: U, v: V, crop, mask: poly?.map((q) => ap(ctx.m, q[0], q[1])), invisible: e.invisible });
        // IMAGEFRAME: 0 off, 1 shown and plotted, 2 shown but not plotted (left out, as the plot leaves it)
        if ((this.d.imageFrame ?? 1) === 1) {
          if (poly) {
            const b = new PathBuilder(ctx.m);
            poly.forEach((q, i) => (i ? b.line(q[0], q[1]) : b.move(q[0], q[1])));
            b.close();
            path(b.done(), { name: fileName || undefined });
          } else path(frame(crop), { name: fileName || undefined });
        }
        break;
      }
      case "faces": {
        // polyface mesh: its visible edges, seen from above
        const b = new PathBuilder(ctx.m);
        for (const [a, z] of g.edges) {
          b.move(a[0], a[1]);
          b.line(z[0], z[1]);
        }
        path(b.done());
        break;
      }
      case "wipeout": {
        // painted in the paper colour over what was drawn before it (draw order), frame per WIPEOUTFRAME
        // (1 shown and plotted, 0 off, 2 shown but not plotted — left out, as the plot leaves it); omni-cad-19
        const [p, u, v] = [g.p, g.u, g.v];
        const [w, h] = g.size;
        const at = (q: P2): P2 => {
          const fx = (q[0] + 0.5) / w, fy = (q[1] + 0.5) / h;
          return [p[0] + u[0] * w * fx + v[0] * h * (1 - fy), p[1] + u[1] * w * fx + v[1] * h * (1 - fy)];
        };
        let px: P2[] = g.clip && g.clip.length >= 2 ? g.clip : [[-0.5, -0.5], [w - 0.5, h - 0.5]];
        if (px.length === 2) px = [[px[0][0], px[0][1]], [px[1][0], px[0][1]], [px[1][0], px[1][1]], [px[0][0], px[1][1]]];
        const corners = px.map(at);
        const b = new PathBuilder(ctx.m);
        corners.forEach((q, i) => (i ? b.line(q[0], q[1]) : b.move(q[0], q[1])));
        b.close();
        path(b.done(), { stroke: null, fill: "#FFFFFF", name: t("engine.cad.ent.WIPEOUT", undefined, "WIPEOUT") });
        if ((this.d.wipeoutFrame ?? 1) === 1) {
          const f = new PathBuilder(ctx.m);
          corners.forEach((q, i) => (i ? f.line(q[0], q[1]) : f.move(q[0], q[1])));
          f.close();
          path(f.done());
        }
        break;
      }
      case "viewport": {
        if (g.id === 1) break; // the paper itself
        this.viewports++;
        const b = new PathBuilder(ctx.m);
        const [cx, cy] = g.c;
        b.move(cx - g.w / 2, cy - g.h / 2);
        b.line(cx + g.w / 2, cy - g.h / 2);
        b.line(cx + g.w / 2, cy + g.h / 2);
        b.line(cx - g.w / 2, cy + g.h / 2);
        b.close();
        // the frame plots like any entity of its layer (omni-cad-07: AutoCAD's plot has it); a viewport on a no-plot
        // layer leaves it out of the plot and the PDF with that layer. A clipped viewport (polygon, circle) has no
        // rectangle: its boundary entity is drawn as itself (omni-cad-21) — unless that entity is missing (damaged or
        // purged boundary): then the view is cut to the rectangle and the rectangle is its frame
        if (!g.clipBy || !clipOutline(this.d, g.clipBy)) path(b.done(), { vpFrame: [cx, cy] });
        if (this.model && !g.off && g.vh && g.vh > 0 && !ctx.inBlock) viewportView.call(this, g, ctx, L.name);
        break;
      }
      case "xline": {
        const p = ap(ctx.m, g.p[0], g.p[1]), dir = av(ctx.m, g.dir[0], g.dir[1]);
        path([{ nodes: [], closed: false }], { xline: { p, dir, ray: g.ray }, dash: this.dash(e, ltName, ctx.m) });
        break;
      }
      case "text":
      case "mtext":
        this.text(e, g, ctx, L, color);
        break;
      case "insert":
      case "dimension": {
        const blk = this.d.blocks.get(g.block.toUpperCase());
        if (!blk) {
          this.unsupported[e.type] = (this.unsupported[e.type] ?? 0) + 1;
          if (g.k === "insert") this.walk(g.attribs, ctx);
          return;
        }
        if (blk.flags & 4 && !blk.loaded) {
          // external reference whose file was not found: its path at the insertion point in a frame (AutoCAD shows
          // the path there); the page source lists it for 경로 지정
          this.xrefs.add(blk.xref || blk.name);
          if (g.k === "insert") this.missingXref(e, g.p, blk.xref || blk.name, ctx, L, color);
          this.count(e.type);
          return;
        }
        if (ctx.depth >= MAX_INSERT_DEPTH || ctx.stack.includes(blk.name.toUpperCase())) return;
        const name = blk.flags & 4 ? t("engine.cad.group.xref", { name: blk.name }) : g.k === "dimension" ? t("engine.cad.group.dim", { name: g.text && g.text !== "<>" ? g.text.replace(/\\P/g, " ") : g.measure !== undefined ? String(+g.measure.toFixed(4)) : blk.name }) : blk.name;
        const grp: Grp = { id: uid("g"), name, parent: ctx.grp, top: ctx.grp ? ctx.grp.top : L.name, cad: { block: blk.name } };
        const inner: Ctx = { m: ctx.m, inBlock: true, layer: L.name, color, lwRaw, ltype: ltName, byLayer: isByLayer(e, ctx), grp, depth: ctx.depth + 1, stack: [...ctx.stack, blk.name.toUpperCase()] };
        if (g.k === "dimension") {
          if (e.handle && !ctx.inBlock) this.dimGrp.set(e.handle.toUpperCase(), grp);
          // a dimension the export can write as DIMENSION again: its kind, points (drawing coordinates) and value
          // (an arc length dimension is kind 7 here: AutoCAD's ARC_DIMENSION)
          const t = g.arc ? 7 : g.large ? 9 : g.dimtype;
          if (g.p?.["10"] && [0, 1, 2, 3, 4, 5, 6, 7, 9].includes(t) && g.measure !== undefined) {
            const p: Record<string, [number, number]> = {};
            for (const [c, q] of Object.entries(g.p)) {
              const w = ap(mo, q[0], q[1]);
              p[c] = [w[0], w[1]];
            }
            grp.cad.dim = { type: t, p, measure: g.measure, ...(g.angle !== undefined ? { angle: g.angle } : {}), ...(g.text ? { text: g.text } : {}), ...(g.flags !== undefined ? { flags: g.flags } : {}), ...(g.arc ? { arc: g.arc } : {}) };
          }
          this.walk(blk.entities, inner);
        } else {
          this.blocks[blk.name] = (this.blocks[blk.name] ?? 0) + 1;
          const at = mul(mo, mul(translate(g.p[0], g.p[1]), rotateM(g.rot)));
          const n = Math.min(MAX_ARRAY, g.cols * g.rows);
          // an xref in other units is scaled by the unit ratio, as AutoCAD inserts it
          const us = blk.unitScale ?? 1;
          if (n === 1 && !(blk.flags & 4)) {
            // the placement, so the drawing screen can insert the block again and the DXF export writes it as a block
            const p0 = ap(at, 0, 0), px = ap(at, 1, 0), py = ap(at, 0, 1);
            const ux = [px[0] - p0[0], px[1] - p0[1]], uy = [py[0] - p0[0], py[1] - p0[1]];
            const det = ux[0] * uy[1] - ux[1] * uy[0];
            grp.cad!.ins = { p: [p0[0], p0[1]], rot: Math.atan2(ux[1], ux[0]), sx: g.sx * us * Math.hypot(ux[0], ux[1]), sy: g.sy * us * Math.hypot(uy[0], uy[1]) * (det < 0 ? -1 : 1) };
          }
          const start = this.items.length;
          for (let k = 0; k < n; k++) {
            const i = k % g.cols, j = Math.floor(k / g.cols);
            const m = mul(at, mul(translate(i * g.cs, j * g.rs), mul(scaleM(g.sx * us, g.sy * us), translate(-blk.base[0], -blk.base[1]))));
            this.walk(blk.entities, { ...inner, m });
          }
          if (g.clip && n === 1) {
            // XCLIP: the boundary (block coordinates) taken through the insert — two points are a rectangle; a
            // rotated rectangle or a polygon clips along its edges
            const m = mul(at, mul(scaleM(g.sx * us, g.sy * us), translate(-blk.base[0], -blk.base[1])));
            const c = g.clip;
            const pts = (c.length === 2 ? [c[0], [c[1][0], c[0][1]] as P2, c[1], [c[0][0], c[1][1]] as P2] : c).map((q) => ap(m, q[0], q[1]));
            const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
            const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
            const onBox = (q: P2) => (Math.abs(q[0] - box[0]) < 1e-9 || Math.abs(q[0] - box[2]) < 1e-9) && (Math.abs(q[1] - box[1]) < 1e-9 || Math.abs(q[1] - box[3]) < 1e-9);
            if (pts.length === 4 && pts.every(onBox)) clipItems(this.items, start, box);
            else clipItemsPolygon(this.items, start, pts);
          }
          // attributes are placed in the drawing already (not block-relative); like the block's own entities, one on
          // layer 0 or BYLAYER / BYBLOCK takes the insert's layer and colour (omni-cad-18: ATTRIBs on 0 plot green with
          // their insert on B-속성)
          this.walk(g.attribs, { ...inner, m: ctx.m });
        }
        break;
      }
    }
    this.count(e.type);
  }

  /** An xref whose file was not found: its stored path at the insertion point, in a dashed frame. */
  missingXref(e: CadEntity, p: P2 | [number, number, number], path: string, ctx: Ctx, L: CadLayer, color: string) {
    const ext = this.d.extmin && this.d.extmax ? Math.max(this.d.extmax[0] - this.d.extmin[0], this.d.extmax[1] - this.d.extmin[1]) : 0;
    const h = ext > 0 && Number.isFinite(ext) ? ext / 80 : 2.5;
    const label = t("engine.cad.xrefMissing", { path });
    const w = (emWidth(label) * h) / CAP;
    const b = new PathBuilder(ctx.m);
    const [x, y] = [p[0], p[1]];
    b.move(x - h * 0.5, y - h * 0.6);
    b.line(x + w + h * 0.5, y - h * 0.6);
    b.line(x + w + h * 0.5, y + h * 1.6);
    b.line(x - h * 0.5, y + h * 1.6);
    b.close();
    this.items.push({ kind: "path", type: "XREF", contours: b.done(), stroke: color, fill: null, lw: 0, dash: [h * 0.4, h * 0.3], layer: L.name, grp: ctx.grp, name: label });
    this.text(e, { k: "text", p: [x, y, 0], h, rot: 0, text: label, style: "STANDARD", hj: 0, vj: 0 }, ctx, L, color);
  }

  text(e: CadEntity, g: Extract<CadEntity["geom"], { k: "text" | "mtext" }>, ctx: Ctx, L: CadLayer, color: string) {
    const st = this.d.styles.get(g.style.toUpperCase());
    const font = fontFamily(st?.font, st?.bigFont);
    if (font.shx) this.shx.add(font.shx + (st?.bigFont ? " + " + st.bigFont.replace(/\.shx$/i, "") : ""));
    let anchor: P2, xdir: P2, up: P2, hAlign: 0 | 1 | 2 = 0, vAlign: TextItem["vAlign"] = "baseline";
    let paras: CadPara[];
    let boxW = 0;
    let stretch = 1;
    if (g.k === "text") {
      const m = mul(ctx.m, ocs(e.extrusion));
      let p = g.p, rot = g.rot;
      const aligned = g.hj === 3 || g.hj === 5;
      if ((g.hj || g.vj) && g.align && !aligned) p = g.align;
      if (aligned && g.align) rot = (Math.atan2(g.align[1] - g.p[1], g.align[0] - g.p[0]) * 180) / Math.PI;
      const a = (rot * Math.PI) / 180;
      anchor = ap(m, p[0], p[1]);
      xdir = av(m, Math.cos(a), Math.sin(a));
      up = av(m, -Math.sin(a) * g.h, Math.cos(a) * g.h);
      // generation flags (DXF 71, DWG): 2 backwards — mirrored along the baseline direction, running back from the
      // insertion point; 4 upside down — mirrored about the baseline (omni-cad-16)
      if ((g.mirror ?? 0) & 2) xdir = [-xdir[0], -xdir[1]];
      if ((g.mirror ?? 0) & 4) up = [-up[0], -up[1]];
      if (g.hj === 1 || g.hj === 4) hAlign = 1;
      else if (g.hj === 2) hAlign = 2;
      vAlign = g.hj === 4 ? "middle" : (["baseline", "bottom", "middle", "top"] as const)[g.vj] ?? "baseline";
      paras = [{ runs: textCodes(g.text) }];
      if (aligned && g.align) {
        boxW = Math.hypot(g.align[0] - g.p[0], g.align[1] - g.p[1]);
        // FIT (5) stretches the letters to the two points at the given height, ALIGNED (3) scales the height with them
        // — the stroke font's widths are exact, so the stretch is too
        const sv = strokeVariantOf(font.family);
        const nat = sv ? (strokeAdvance(paras[0].runs.map((r) => r.text).join(""), sv) / CAP) * g.h * (g.wf ?? 1) : 0;
        if (nat > 0 && boxW > 0) {
          const f = boxW / nat;
          if (g.hj === 5) stretch = f;
          else up = [up[0] * f, up[1] * f];
        }
      }
    } else {
      const m = ctx.m;
      const dir: P2 = g.xdir ? [g.xdir[0], g.xdir[1]] : [Math.cos(g.rot), Math.sin(g.rot)];
      const len = Math.hypot(dir[0], dir[1]) || 1;
      const ux = dir[0] / len, uy = dir[1] / len;
      anchor = ap(m, g.p[0], g.p[1]);
      xdir = av(m, ux, uy);
      up = av(m, -uy * g.h, ux * g.h);
      hAlign = ((g.attach - 1) % 3) as 0 | 1 | 2;
      vAlign = (["top", "middle", "bottom"] as const)[Math.floor((g.attach - 1) / 3)] ?? "top";
      paras = parseMtext(g.text);
      boxW = g.w * scaleOf(m);
      if (g.cols && g.cols.n > 1) {
        // columns: the text flows down a column of the defined height, then on to the next one
        const chunks = flowColumns(paras, g.cols.n, g.cols.w, g.cols.h, g.h, g.spacing ?? 1, font.family);
        // (one MTEXT entity: its columns share a key, the first one keeps its codes — written back once, not per column)
        const col = uid("mt");
        let head = true;
        chunks.forEach((ps, i) => {
          if (!ps.length) return;
          const off = (g.cols!.w + g.cols!.gutter) * i;
          const at = ap(m, g.p[0] + ux * off, g.p[1] + uy * off);
          this.pushText(e, g, ctx, L, color, at, xdir, up, hAlign, vAlign, ps, g.cols!.w * scaleOf(m), font);
          const it = this.items[this.items.length - 1] as TextItem;
          it.col = col;
          if (!head) delete it.raw;
          head = false;
        });
        return;
      }
    }
    const at = this.items.length;
    this.pushText(e, g, ctx, L, color, anchor, xdir, up, hAlign, vAlign, paras, boxW, font, stretch);
    if (g.k === "mtext" && g.bg) this.mask(this.items[at] as TextItem, g.bg, ctx, L, at);
  }

  /**
   * MTEXT background mask: a filled rectangle under the text — the box (its width, or the text's when it has none) and
   * its lines, grown by (factor − 1) × the text height on every side; the drawing background colour paints white,
   * as plotted (omni-cad-15).
   */
  mask(it: TextItem, bg: NonNullable<Extract<CadGeom, { k: "mtext" }>["bg"]>, ctx: Ctx, L: CadLayer, at: number) {
    if (!it || it.kind !== "text") return;
    const h = Math.hypot(it.up[0], it.up[1]);
    if (!(h > 0)) return;
    const ext = textExtent(it, h);
    const w = it.boxW > 0 ? it.boxW : ext.w;
    const xl = Math.hypot(it.xdir[0], it.xdir[1]) || 1;
    const ux = it.xdir[0] / xl, uy = it.xdir[1] / xl, vx = it.up[0] / h, vy = it.up[1] / h;
    const tall = h + (ext.lines - 1) * MTEXT_PITCH * h * (it.spacing || 1);
    const [top, bottom] = it.vAlign === "top" ? [0, -tall] : it.vAlign === "middle" ? [tall / 2, -tall / 2] : [tall, 0];
    const left = it.hAlign === 0 ? 0 : it.hAlign === 1 ? -w / 2 : -w;
    const o = (bg.scale - 1) * h;
    const pt = (x: number, y: number): P2 => [it.anchor[0] + ux * x + vx * y, it.anchor[1] + uy * x + vy * y];
    const b = new PathBuilder(IDENT);
    [pt(left - o, bottom - o), pt(left + w + o, bottom - o), pt(left + w + o, top + o), pt(left - o, top + o)].forEach((q, i) => (i ? b.line(q[0], q[1]) : b.move(q[0], q[1])));
    b.close();
    const fill = bg.color ? (bg.color.rgb !== undefined ? cadHex(0, bg.color.rgb) : bg.color.aci === 256 ? cadHex(L.color, L.rgb) : bg.color.aci === 0 ? ctx.color : cadHex(bg.color.aci)) : "#FFFFFF";
    // under its text: in before it
    this.items.splice(at, 0, { kind: "path", type: "MTEXT", contours: b.done(), stroke: null, fill, lw: 0, layer: L.name, grp: ctx.grp, name: t("engine.cad.mask", undefined, "Background mask"), invisible: it.invisible });
  }

  pushText(e: CadEntity, g: Extract<CadEntity["geom"], { k: "text" | "mtext" }>, ctx: Ctx, L: CadLayer, color: string, anchor: P2, xdir: P2, up: P2, hAlign: 0 | 1 | 2, vAlign: TextItem["vAlign"], paras: CadPara[], boxW: number, font: { family: string; shx?: string }, stretch = 1) {
    const st = this.d.styles.get(g.style.toUpperCase());
    this.items.push({
      kind: "text",
      type: e.type,
      layer: L.name,
      grp: ctx.grp,
      anchor,
      xdir,
      up,
      paras,
      color,
      layerColor: cadHex(L.color, L.rgb),
      blockColor: ctx.color,
      font: font.family,
      // SHX text is set in Omni Stroke, whose advances follow the SHX fonts' (cad/strokeFont.ts); FIT stretch on top
      // TEXT: its own width factor and obliquing (group 41 / 51, default 1 / 0 — the style's only seed new text: AutoCAD 2027
      // plots a TEXT without 41 / 51 in style OMNI-W08-O15 upright at full width); MTEXT: the style's
      wf: (g.k === "text" ? g.wf ?? 1 : st?.widthFactor ?? 1) * stretch,
      italic: Math.abs(g.k === "text" ? g.oblique ?? 0 : st?.oblique ?? 0) > 0.5,
      stroke: strokeVariantOf(font.family),
      // (SHX files read: their own "?" stands in, cad/strokeFont.ts)
      shxNoBig: !!font.shx && !st?.bigFont && !font.family.startsWith(STROKE_SHX),
      hAlign,
      vAlign,
      mtext: g.k === "mtext",
      // (model space, paper space, and a block's own texts — through a plain insert, not an array / xref / a nested one)
      ...(g.raw && (!ctx.grp || (ctx.grp.cad.ins && !ctx.grp.parent)) ? { raw: g.raw, ...(ctx.grp?.cad.ins ? { ins: ctx.grp.cad.ins as TextItem["ins"] } : {}) } : {}),
      boxW,
      spacing: g.k === "mtext" ? g.spacing ?? 1 : 1,
      invisible: e.invisible,
    });
  }
}

/**
 * Model space seen through a layout viewport: the model entities drawn again with the viewport's view (centre, height,
 * twist) mapped onto its paper rectangle, then cut to that rectangle. The copy sits in a group of its own on the layout
 * page; its entities keep their drawing layers, so turning a layer off reaches them too.
 */
function viewportView(this: Walker, g: Extract<CadGeom, { k: "viewport" }>, ctx: Ctx, layer: string) {
  const s = g.h / g.vh!;
  const tg = g.target ?? [0, 0, 0];
  const vc = g.vc ?? [0, 0];
  const m = mul(translate(g.c[0], g.c[1]), mul(scaleM(s, s), mul(translate(-vc[0], -vc[1]), mul(rotateM(g.twist ?? 0), translate(-tg[0], -tg[1])))));
  // (its frame and view kept, so the DXF export writes the layout's VIEWPORT again)
  const grp: Grp = { id: uid("g"), name: t("engine.cad.group.viewport", { scale: scaleLabel(1 / s) }), parent: ctx.grp, top: ctx.grp ? ctx.grp.top : layer, cad: { block: "*VIEWPORT " + g.id, vp: { model: "", c: [g.c[0], g.c[1]], w: g.w, h: g.h, mc: [vc[0] + tg[0], vc[1] + tg[1]], scale: 1 / s } } };
  const frozen = new Set<string>();
  for (const h of g.frozen ?? []) for (const L of this.d.layers.values()) if (L.handle === h) frozen.add(L.name.toUpperCase());
  const start = this.items.length;
  const keep = { ltK: this.ltK, vpFrozen: this.vpFrozen, model: this.model };
  this.ltK = 1 / s;
  this.vpFrozen = frozen;
  const model = this.model!;
  this.model = undefined;
  this.walk(model, { m, inBlock: false, layer: "0", color: "#000000", lwRaw: -3, ltype: "CONTINUOUS", grp, depth: 0, stack: [] });
  Object.assign(this, keep);
  const poly = g.clipBy ? clipOutline(this.d, g.clipBy) : null;
  if (poly) clipItemsPolygon(this.items, start, poly);
  else clipItems(this.items, start, [g.c[0] - g.w / 2, g.c[1] - g.h / 2, g.c[0] + g.w / 2, g.c[1] + g.h / 2]);
  this.viewports--;
}

/** Outline of a viewport's clip boundary entity (paper space): polyline corners (arcs as chords of 16), circle, ellipse */
function clipOutline(d: CadDrawing, handle: string): P2[] | null {
  const find = (ents: CadEntity[]) => ents.find((e) => e.handle?.toUpperCase() === handle);
  let e = find(d.entities);
  for (const b of d.blocks.values()) e ??= find(b.entities);
  const g = e?.geom;
  if (!g) return null;
  const ring: P2[] = [];
  if (g.k === "circle") for (let i = 0; i < 96; i++) ring.push([g.c[0] + g.r * Math.cos((i / 96) * 2 * Math.PI), g.c[1] + g.r * Math.sin((i / 96) * 2 * Math.PI)]);
  else if (g.k === "ellipse") {
    const minor: P2 = [-g.major[1] * g.ratio, g.major[0] * g.ratio];
    for (let i = 0; i < 96; i++) {
      const t = (i / 96) * 2 * Math.PI;
      ring.push([g.c[0] + g.major[0] * Math.cos(t) + minor[0] * Math.sin(t), g.c[1] + g.major[1] * Math.cos(t) + minor[1] * Math.sin(t)]);
    }
  } else if (g.k === "poly") {
    g.pts.forEach((p, i) => {
      ring.push([p.x, p.y]);
      const q = g.pts[(i + 1) % g.pts.length];
      if (!p.bulge || (!g.closed && i === g.pts.length - 1)) return;
      // arc segment: chord points along the bulge
      const th = 4 * Math.atan(p.bulge), c = Math.hypot(q.x - p.x, q.y - p.y);
      if (c < 1e-12) return;
      const r = c / (2 * Math.sin(th / 2)), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const h = r * Math.cos(th / 2), nx = -(q.y - p.y) / c, ny = (q.x - p.x) / c;
      const cx = mx + nx * h, cy = my + ny * h, a0 = Math.atan2(p.y - cy, p.x - cx);
      for (let k = 1; k < 16; k++) ring.push([cx + Math.abs(r) * Math.cos(a0 + (th * k) / 16), cy + Math.abs(r) * Math.sin(a0 + (th * k) / 16)]);
    });
  }
  return ring.length >= 3 ? ring : null;
}

/**
 * Items from `start` on cut to a rectangle (drawing coordinates): paths clipped, texts and pictures kept when their
 * anchor (picture: centre) is inside — a viewport's window, an XCLIP boundary.
 */
function clipItems(items: Item[], start: number, rect: [number, number, number, number]) {
  const inside = (x: number, y: number) => x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
  const out: Item[] = [];
  const poly: P2[] = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]]];
  for (const it of items.slice(start)) {
    if (it.kind === "text") {
      if (keepText(it, poly, (q) => inside(q[0], q[1]))) out.push(it);
      continue;
    }
    if (it.kind === "image") {
      if (inside(it.p[0] + (it.u[0] + it.v[0]) / 2, it.p[1] + (it.u[1] + it.v[1]) / 2)) out.push(it);
      continue;
    }
    if (it.xline) {
      out.push(it);
      continue;
    }
    it.contours = clipContours(it.contours, rect, !!it.fill);
    if (it.contours.length) out.push(it);
  }
  items.length = start;
  items.push(...out);
}

const corner = (p: P2) => ({ anchor: p, handleIn: p, handleOut: p, isCorner: true });

/** The four corners of a text item's box (drawing coordinates), as the page bounds measure it. */
export function textBox(it: TextItem): P2[] {
  const h = Math.hypot(it.up[0], it.up[1]);
  const ext = textExtent(it, h);
  const w = Math.max(it.boxW, ext.w);
  const xl = Math.hypot(it.xdir[0], it.xdir[1]) || 1;
  const ux = it.xdir[0] / xl, uy = it.xdir[1] / xl, vx = it.up[0] / (h || 1), vy = it.up[1] / (h || 1);
  const x0 = it.hAlign === 0 ? 0 : it.hAlign === 1 ? -w / 2 : -w;
  const tall = h + (ext.lines - 1) * MTEXT_PITCH * h * (it.spacing || 1);
  const [top, bottom] = !it.mtext ? [h, 0] : it.vAlign === "top" ? [0, -tall] : it.vAlign === "middle" ? [tall / 2, -tall / 2] : [tall, 0];
  const pt = (x: number, y: number): P2 => [it.anchor[0] + ux * x + vx * y, it.anchor[1] + uy * x + vy * y];
  return [pt(x0, bottom), pt(x0 + w, bottom), pt(x0 + w, top), pt(x0, top)];
}

/**
 * A text cut by a viewport / XCLIP boundary: kept whole when its box is inside, left out when the box and the
 * boundary do not meet, and across the edge kept with the boundary as its mask (AutoCAD shows the part inside —
 * omni-cad-21 A4: the model text running past the viewport edges).
 */
function keepText(it: TextItem, poly: P2[], inside: (q: P2) => boolean): boolean {
  const box = textBox(it);
  const n = box.filter(inside).length;
  if (n === 4) return true;
  const meets = n > 0 || poly.some((q) => insidePolygon(q, box)) || box.some((p, i) => poly.some((q, j) => segmentsCross(p, box[(i + 1) % 4], q, poly[(j + 1) % poly.length])));
  if (!meets) return false;
  it.mask = poly;
  return true;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const s = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return s(a, b, c) * s(a, b, d) < 0 && s(c, d, a) * s(c, d, b) < 0;
}

/** Even-odd point in polygon. */
export function insidePolygon(q: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Items from `start` on cut to a polygon (XCLIP with a polygonal or rotated boundary, drawing coordinates): lines are
 * split where they cross the boundary and the pieces inside kept; filled areas are cut edge by edge (Sutherland–
 * Hodgman, exact for a convex boundary; a concave one keeps an area whose centre is inside); texts and pictures by
 * their anchor, as clipItems.
 */
export function clipItemsPolygon(items: Item[], start: number, poly: P2[]) {
  if (poly.length > 3 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < 1e-9) poly = poly.slice(0, -1);
  if (poly.length < 3) return;
  const inside = (q: P2) => insidePolygon(q, poly);
  // orientation, for the convex cut
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  const sgn = area >= 0 ? 1 : -1;
  const side = (a: P2, b: P2, p: P2) => sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  let convex = true;
  for (let i = 0; i < poly.length; i++) if (side(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]) < -1e-9) convex = false;
  /** parameters along p–q where it crosses the boundary */
  const crossings = (p: P2, q: P2): number[] => {
    const ts: number[] = [];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-15) continue;
      const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
      const u = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / den;
      if (t > 1e-12 && t < 1 - 1e-12 && u >= -1e-12 && u <= 1 + 1e-12) ts.push(t);
    }
    return ts.sort((x, y) => x - y);
  };
  const out: Item[] = [];
  for (const it of items.slice(start)) {
    if (it.kind === "text") {
      if (keepText(it, poly, inside)) out.push(it);
      continue;
    }
    if (it.kind === "image") {
      if (inside([it.p[0] + (it.u[0] + it.v[0]) / 2, it.p[1] + (it.u[1] + it.v[1]) / 2])) out.push(it);
      continue;
    }
    if (it.xline) {
      out.push(it);
      continue;
    }
    const cs: Contour[] = [];
    for (const c of it.contours) {
      if (!c.nodes.length) continue;
      const ring = rings([c], 24)[0];
      if (c.closed && ring.length && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) > 1e-12) ring.push(ring[0]);
      let cut = false;
      for (let i = 0; i + 1 < ring.length && !cut; i++) if (crossings(ring[i], ring[i + 1]).length) cut = true;
      if (!cut) {
        if (ring.length && inside(ring[0]) && inside(ring[Math.floor(ring.length / 2)])) cs.push(c);
        continue;
      }
      if (it.fill && c.closed) {
        if (!convex) {
          const cx = ring.reduce((s, q) => s + q[0], 0) / ring.length, cy = ring.reduce((s, q) => s + q[1], 0) / ring.length;
          if (inside([cx, cy])) cs.push(c);
          continue;
        }
        let pg = ring.slice(0, -1);
        for (let e = 0; e < poly.length && pg.length; e++) {
          const a = poly[e], b = poly[(e + 1) % poly.length];
          const keep = (p: P2) => side(a, b, p) >= 0;
          const at = (p: P2, q: P2): P2 => {
            const sp = side(a, b, p), sq = side(a, b, q);
            const f = sp / (sp - sq);
            return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
          };
          const next: P2[] = [];
          for (let i = 0; i < pg.length; i++) {
            const p = pg[i], q = pg[(i + 1) % pg.length];
            if (keep(q)) {
              if (!keep(p)) next.push(at(p, q));
              next.push(q);
            } else if (keep(p)) next.push(at(p, q));
          }
          pg = next;
        }
        if (pg.length >= 3) cs.push({ closed: true, nodes: pg.map(corner) });
        continue;
      }
      let run: P2[] = [];
      const flush = () => {
        if (run.length >= 2) cs.push({ closed: false, nodes: run.map(corner) });
        run = [];
      };
      for (let i = 0; i + 1 < ring.length; i++) {
        const p = ring[i], q = ring[i + 1];
        const ts = [0, ...crossings(p, q), 1];
        for (let k = 0; k + 1 < ts.length; k++) {
          const t0 = ts[k], t1 = ts[k + 1];
          const P: P2 = [p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0], Q: P2 = [p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1];
          if (!inside([(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2])) {
            flush();
            continue;
          }
          const last = run[run.length - 1];
          if (!last || Math.hypot(last[0] - P[0], last[1] - P[1]) > 1e-9) {
            flush();
            run.push(P);
          }
          run.push(Q);
        }
      }
      flush();
    }
    it.contours = cs;
    if (cs.length) out.push(it);
  }
  items.length = start;
  items.push(...out);
}

/** Contours cut to a rectangle: kept whole inside, dropped outside, flattened and clipped across the edge. */
export function clipContours(cs: Contour[], r: [number, number, number, number], filled: boolean): Contour[] {
  const out: Contour[] = [];
  for (const c of cs) {
    if (!c.nodes.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of c.nodes)
      for (const p of [n.anchor, n.handleIn, n.handleOut]) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    if (x0 >= r[0] && x1 <= r[2] && y0 >= r[1] && y1 <= r[3]) {
      out.push(c);
      continue;
    }
    if (x1 < r[0] || x0 > r[2] || y1 < r[1] || y0 > r[3]) continue;
    const ring = rings([c], 24)[0];
    if (filled && c.closed) {
      let poly = ring;
      // Sutherland–Hodgman against the four edges
      for (let e = 0; e < 4 && poly.length; e++) {
        const inside = (p: P2) => (e === 0 ? p[0] >= r[0] : e === 1 ? p[1] >= r[1] : e === 2 ? p[0] <= r[2] : p[1] <= r[3]);
        const cut = (p: P2, q: P2): P2 => {
          const ax = e % 2 === 0 ? 0 : 1, v = r[e];
          const f = (v - p[ax]) / (q[ax] - p[ax]);
          return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
        };
        const next: P2[] = [];
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          if (inside(q)) {
            if (!inside(p)) next.push(cut(p, q));
            next.push(q);
          } else if (inside(p)) next.push(cut(p, q));
        }
        poly = next;
      }
      if (poly.length >= 3) out.push({ closed: true, nodes: poly.map(corner) });
      continue;
    }
    let run: P2[] = [];
    const flush = () => {
      if (run.length >= 2) out.push({ closed: false, nodes: run.map(corner) });
      run = [];
    };
    for (let i = 0; i + 1 < ring.length; i++) {
      const seg = clipSegment(ring[i], ring[i + 1], r);
      if (!seg) {
        flush();
        continue;
      }
      const last = run[run.length - 1];
      if (!last || Math.hypot(last[0] - seg[0][0], last[1] - seg[0][1]) > 1e-9) {
        flush();
        run.push(seg[0]);
      }
      run.push(seg[1]);
    }
    flush();
  }
  return out;
}

/** Liang–Barsky: the part of segment p–q inside the rectangle, or null. */
function clipSegment(p: P2, q: P2, r: [number, number, number, number]): [P2, P2] | null {
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const edges: [number, number][] = [
    [-dx, p[0] - r[0]],
    [dx, r[2] - p[0]],
    [-dy, p[1] - r[1]],
    [dy, r[3] - p[1]],
  ];
  for (const [pp, qq] of edges) {
    if (pp === 0) {
      if (qq < 0) return null;
      continue;
    }
    const t = qq / pp;
    if (pp < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [
    [p[0] + dx * t0, p[1] + dy * t0],
    [p[0] + dx * t1, p[1] + dy * t1],
  ];
}

/**
 * MTEXT columns: paragraphs split into `n` columns of `colW` × `colH` drawing units. Lines are estimated with the
 * same em widths as the page bounds (the real font lays them out later); the last column takes what is left.
 */
export function flowColumns(paras: CadPara[], n: number, colW: number, colH: number, h: number, spacing: number, family?: string): CadPara[][] {
  const lineH = h * (5 / 3) * (spacing || 1);
  // a line needs its text height, the ones after it a line pitch each (AutoCAD fits 3 lines of 2.5 in a 12 column)
  const perCol = Math.max(1, Math.floor((colH - h) / lineH + 1e-6) + 1);
  // the same width and widths the text engine wraps each column with (textNode), so its lines end where these do
  const lineEm = ((colW * CAP) / h) * (family ? MTEXT_WRAP_SLACK : 1);
  const em = (s: string, r: CadRun) => (family ? runEm(s, r.font ? fontFamily(r.font).family : family, r.bold, r.italic) : emWidth(s)) * (r.h < 0 ? -r.h / h : r.h) * (r.wf ?? 1);
  const cols: CadPara[][] = [[]];
  let lines = 0;
  for (const p of paras) {
    let cur: CadPara = { runs: [], align: p.align };
    let used = 0;
    const newLine = () => {
      lines++;
      used = 0;
      if (lines >= perCol && cols.length < n) {
        cols[cols.length - 1].push(cur);
        cols.push([]);
        cur = { runs: [], align: p.align };
        lines = 0;
      }
    };
    for (const r of p.runs) {
      // break opportunities: after spaces, and between CJK characters (closing punctuation stays with the one before)
      const pieces = r.text.match(/[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯][.,!?)\]}:;%」』》〉”’]*[\s　]*|[^\s　ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]*[\s　]+|[^\s　ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]+/g) ?? []; // i18n: keep
      let buf = "";
      for (const piece of pieces) {
        const w = em(piece.trimEnd(), r);
        if (used > 0 && used + w > lineEm) {
          if (buf) cur.runs.push({ ...r, text: buf });
          buf = "";
          newLine();
        }
        buf += piece;
        used += em(piece, r);
      }
      if (buf) cur.runs.push({ ...r, text: buf });
    }
    cols[cols.length - 1].push(cur);
    lines++;
    if (lines >= perCol && cols.length < n) {
      cols.push([]);
      lines = 0;
    }
  }
  return cols;
}

const hatchName = (pattern: string) => `${t("engine.cad.ent.HATCH", undefined, "HATCH")} ${pattern}`.trim();

function mapContours(cs: Contour[], m: Mat): Contour[] {
  return cs.map((c) => ({
    closed: c.closed,
    nodes: c.nodes.map((n) => ({ anchor: ap(m, n.anchor[0], n.anchor[1]), handleIn: ap(m, n.handleIn[0], n.handleIn[1]), handleOut: ap(m, n.handleOut[0], n.handleOut[1]), isCorner: n.isCorner })),
  }));
}

// ───────── items → page ─────────

interface PageOpts {
  name: string;
  layout?: string;
  layoutOrder?: number;
  layoutActive?: boolean;
  /** paper space: drawn 1:1 in paper units */
  paper?: boolean;
  /** layout sheet (paper units) and millimetres per paper unit */
  frame?: [number, number, number, number];
  paperMm?: number;
  format: "dxf" | "dwg";
  asset: AssetRef;
  refs?: CadRefMeta[];
}

/**
 * Widest paragraph (drawing units) and number of lines of a text item: each paragraph by the widths of the fonts it
 * is drawn in, an MTEXT with a width in as many lines as it takes there.
 */
export function textExtent(it: Pick<TextItem, "paras" | "font" | "stroke" | "wf" | "mtext" | "boxW">, h: number): { w: number; lines: number } {
  let w = 0, lines = 0;
  for (const p of it.paras) {
    let pw = 0;
    for (const r of p.runs) {
      if (!r.text) continue;
      const em = it.stroke && !r.font ? emWidth(r.text, it.stroke) : runEm(r.text, r.font ? fontFamily(r.font).family : it.font, r.bold, r.italic);
      pw += (em * (r.h < 0 ? -r.h / (h || 1) : r.h) * (r.wf ?? 1) * it.wf * h) / CAP;
    }
    const wrap = it.mtext && it.boxW > 0 ? it.boxW * MTEXT_WRAP_SLACK : 0;
    lines += wrap ? Math.max(1, Math.ceil(pw / wrap - 1e-9)) : 1;
    w = Math.max(w, wrap ? Math.min(pw, wrap) : pw);
  }
  return { w, lines: Math.max(1, lines) };
}

function bounds(items: Item[]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const it of items) {
    if (it.invisible) continue;
    if (it.kind === "path") {
      for (const c of it.contours) for (const n of c.nodes) add(n.anchor[0], n.anchor[1]);
      if (it.xline) add(it.xline.p[0], it.xline.p[1]);
    } else if (it.kind === "image") {
      add(it.p[0], it.p[1]);
      add(it.p[0] + it.u[0], it.p[1] + it.u[1]);
      add(it.p[0] + it.v[0], it.p[1] + it.v[1]);
      add(it.p[0] + it.u[0] + it.v[0], it.p[1] + it.u[1] + it.v[1]);
    } else {
      const h = Math.hypot(it.up[0], it.up[1]);
      const ext = textExtent(it, h);
      const w = Math.max(it.boxW, ext.w);
      const xl = Math.hypot(it.xdir[0], it.xdir[1]) || 1;
      const ux = it.up[0] / (h || 1), uy = it.up[1] / (h || 1);
      const dx = it.hAlign === 0 ? 1 : it.hAlign === 1 ? 0.5 : -1;
      // vertical span of every line of the text (an MTEXT of several lines reaches far below its first)
      const tall = h + (ext.lines - 1) * MTEXT_PITCH * h * (it.spacing || 1);
      const [top, bottom] = !it.mtext ? [h, 0] : it.vAlign === "top" ? [0, -tall] : it.vAlign === "middle" ? [tall / 2, -tall / 2] : [tall, 0];
      for (const v of [top, bottom]) {
        add(it.anchor[0] + ux * v, it.anchor[1] + uy * v);
        add(it.anchor[0] + ux * v + (it.xdir[0] / xl) * w * dx, it.anchor[1] + uy * v + (it.xdir[1] / xl) * w * dx);
      }
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/**
 * A text item as TEXT nodes: the text itself, then the upper part of each stack (MTEXT \S) as a text of its own,
 * placed above the start of its lower part where the text engine lays that out.
 */
function textNodes(it: TextItem, m: Mat, k: number): TextNode[] {
  const anchor = ap(m, it.anchor[0], it.anchor[1]);
  const xd = av(m, it.xdir[0], it.xdir[1]);
  const upv = av(m, it.up[0], it.up[1]);
  const hPage = Math.hypot(upv[0], upv[1]);
  if (!(hPage > 0.01)) return [];
  const stacks = new Map<TextRun, { up: string; rise: number; bar: boolean }>();
  const size = hPage / CAP;
  const rotation = (Math.atan2(xd[1], xd[0]) * 180) / Math.PI;
  const lineSpacing = it.mtext ? MTEXT_PITCH * CAP * (it.spacing || 1) : 1.2;
  const runColor = (r: CadRun) => (r.rgb !== undefined ? cadHex(0, r.rgb) : r.aci === undefined ? it.color : r.aci === 256 ? it.layerColor : r.aci === 0 ? it.blockColor : cadHex(r.aci));
  const align = (["LEFT", "CENTER", "RIGHT"] as const)[it.hAlign];
  let widest = 0;
  const paragraphs: TextParagraph[] = it.paras.map((p) => {
    const runs: TextRun[] = [];
    let w = 0;
    for (const r of p.runs) {
      if (!r.text) continue;
      const fs = r.h < 0 ? (-r.h * k) / CAP : size * r.h;
      const family = r.font ? fontFamily(r.font).family : it.font;
      const wf = (r.wf ?? 1) * it.wf;
      // tabs: to the paragraph's stops (MTEXT \p…t), four spaces where it has none
      const text = p.tabs ? r.text : r.text.replace(/\t/g, "    ");
      const emOf = (s: string) => (it.stroke && !r.font ? emWidth(s, it.stroke) : runEm(s, family, r.bold, r.italic)) * fs * wf;
      const lowW = emOf(text);
      // a stack takes the wider of its parts
      const upW = r.stack ? emOf(r.stack.up) : 0;
      w += r.stack?.spacer ? upW : Math.max(lowW, upW);
      // Hangul in a Latin TrueType style: in the fallback font, as AutoCAD draws it
      // (an SHX style without a big font: its Hangul in the narrower cell AutoCAD gives the '?' there)
      const noBig = !!it.shxNoBig && !r.font;
      for (const piece of splitCjk(text, family, noBig)) {
        const run: TextRun = { ...DEFAULT_RUN, text: piece.text, fontFamily: piece.cjk && !noBig ? CJK_FALLBACK : family, fontSize: piece.cjk && !noBig ? fs : fs * ttfScale(family), bold: !!r.bold, italic: !!r.italic || it.italic, underline: !!r.underline, color: runColor(r) };
        const sx = wf * (piece.cjk ? (noBig ? SHX_NO_BIGFONT_CJK : CJK_FALLBACK_SCALE) : 1);
        if (Math.abs(sx - 1) > 0.005) run.hscale = Math.round(sx * 100);
        if (r.strike) run.strike = true;
        // tracking (\T): every character's advance × the factor — the gap after each one grows by (factor − 1) × its width
        if (r.track && r.track !== 1 && !r.stack) {
          const n = Array.from(piece.text).length || 1;
          run.letterSpacing = ((r.track - 1) * emOf(piece.text) * (piece.cjk && !noBig ? CJK_FALLBACK_SCALE : 1)) / n;
        }
        if (r.script) run.script = r.script;
        if (r.stack) {
          // the lower part (or a space) as wide as the stack; the upper part becomes a text of its own above it
          const extra = (r.stack.spacer ? upW : Math.max(lowW, upW)) - lowW;
          const n = Array.from(piece.text).length || 1;
          if (extra > 0.01) run.letterSpacing = extra / n;
          stacks.set(run, { up: r.stack.up, rise: r.stack.rise * (r.h < 0 ? -r.h * k : hPage * r.h), bar: !!r.stack.bar });
        }
        runs.push(run);
      }
    }
    widest = Math.max(widest, w);
    const para: TextParagraph = { id: uid("p"), runs: runs.length ? runs : [{ ...DEFAULT_RUN, text: "", fontFamily: it.font, fontSize: size, color: it.color }], align: p.align ?? align, lineSpacing, indent: 0, spaceAfter: 0 };
    // MTEXT paragraph format (\p): indents and tab stops in drawing units
    if (p.left) para.indentLeft = p.left * k;
    if (p.indent) para.indent = p.indent * k;
    // (the text engine has even stops from the left indent: the first stop sets them — "t20,40", "l3,t3" land there)
    if (p.tabs) para.tabStep = p.tabs[0] * k;
    // AutoCAD wraps Hangul / CJK between any two characters (omni-cad-15: "… 보고서" | "는 이번 …")
    if (it.mtext && it.boxW > 0) para.breakWord = true;
    return para;
  });
  const boxW = it.boxW * k;
  // MTEXT with a width wraps there (as AutoCAD, a little past it); everything else never wraps
  const W = boxW > 0 && it.mtext ? boxW * MTEXT_WRAP_SLACK : Math.max(boxW, widest * 1.3 + size);
  const node: TextNode = {
    id: uid(),
    name: (it.paras.map((p) => p.runs.map((r) => r.text).join("")).join(" ").trim() || t(`engine.cad.ent.${it.type}`, undefined, it.type)).slice(0, 40),
    visible: !it.invisible,
    locked: false,
    opacity: 1,
    blendMode: "NORMAL",
    transform: { x: 0, y: 0, rotation: 0, scale: 1 },
    type: "TEXT",
    width: W,
    paragraphs,
    wordBreak: "normal",
    background: null,
  };
  const lh = size * lineSpacing;
  const B1 = (lh - size) / 2 + size * 0.8;
  const capTop = B1 - hPage;
  // the last line of an MTEXT as the text engine wraps it (middle / bottom attachment)
  let lastBase = B1;
  if (it.mtext && it.vAlign !== "top") {
    const lay = layoutText(node).lines;
    if (lay.length > 1) lastBase = B1 + (lay[lay.length - 1].y + lay[lay.length - 1].baseline - (lay[0].y + lay[0].baseline));
  }
  const ax = it.hAlign === 0 ? 0 : it.hAlign === 1 ? W / 2 : W;
  // a stack on the first line raises the top of the box AutoCAD centres a middle-attached MTEXT on (omni-cad-06: the
  // tolerance dimension "50\S+0,1^ -0,05;" sits one text height lower than a plain one-line text would)
  const firstStack = it.paras[0]?.runs.some((r) => r.stack);
  const mTop = firstStack && it.mtext && it.vAlign === "middle" ? capTop - STACK_BOX_EXTRA * hPage : capTop;
  // a top-attached MTEXT whose first line holds a stack: AutoCAD hangs the box from the top of the upper part, the line
  // that much lower (omni-cad-15 "분수 \S1/2;": the baseline 1.33 text heights further down)
  // (the stacks the text engine puts on the first line — a long paragraph may carry them to a later one)
  let firstRise = 0;
  if (it.mtext && it.vAlign === "top" && stacks.size) for (const piece of layoutText(node).lines[0]?.pieces ?? []) firstRise = Math.max(firstRise, stacks.get(piece.run)?.rise ?? 0);
  const ay = it.vAlign === "top" ? capTop - firstRise : it.vAlign === "middle" ? (it.mtext ? (mTop + lastBase) / 2 : B1 - hPage / 2) : it.vAlign === "bottom" ? (it.mtext ? lastBase : B1 + hPage * 0.25) : B1;
  const a = (rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // a mirrored text (TEXT backwards or upside down alone, a mirrored insert): "up" turns the other way round from the
  // baseline than in plain text — drawn mirrored about the baseline (the node's y flipped)
  const my = xd[0] * upv[1] - xd[1] * upv[0] > 0 ? -1 : 1;
  node.transform = { x: anchor[0] - (ax * c - my * ay * s), y: anchor[1] - (ax * s + my * ay * c), rotation: Math.abs(rotation) < 1e-9 ? 0 : rotation, scale: 1, ...(my < 0 ? { scaleY: -1 } : {}) };
  const out = [node];
  if (!stacks.size) return out;
  const placed = new Set<TextRun>();
  for (const line of layoutText(node).lines)
    for (const piece of line.pieces) {
      const st = stacks.get(piece.run);
      if (!st || placed.has(piece.run)) continue;
      placed.add(piece.run);
      const run: TextRun = { ...piece.run, text: st.up, underline: piece.run.underline || st.bar };
      delete run.letterSpacing;
      const up: TextNode = { ...node, id: uid(), name: st.up.slice(0, 40), width: Math.max(10, runEm(st.up, run.fontFamily, run.bold, run.italic) * run.fontSize * 1.3 + run.fontSize), paragraphs: [{ id: uid("p"), runs: [run], align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 0 }] };
      // its baseline `rise` above the line's, at the lower part's start (local x, y of the text box)
      const lx = piece.x, ly = line.y + line.baseline - st.rise - layoutText(up).lines[0].baseline;
      up.transform = { ...node.transform, x: node.transform.x + lx * c - my * ly * s, y: node.transform.y + lx * s + my * ly * c };
      out.push(up);
    }
  return out;
}

/**
 * A linked picture as an IMAGE node: origin at its top-left corner (drawing p + v), x along u, y down along −v; a
 * mirrored placement (−v turning the other way on the page) gets a negative vertical scale.
 */
function imageNode(it: ImageItem, m: Mat): ImageNode | null {
  const U = av(m, it.u[0], it.u[1]), V = av(m, it.v[0], it.v[1]);
  const w = Math.hypot(U[0], U[1]), h = Math.hypot(V[0], V[1]);
  if (!(w > 0.01 && h > 0.01)) return null;
  const top = ap(m, it.p[0] + it.v[0], it.p[1] + it.v[1]);
  const rot = Math.atan2(U[1], U[0]);
  // the node's y axis on the page is (−sin, cos); the picture's downward edge is −V
  const flip = V[0] * Math.sin(rot) - V[1] * Math.cos(rot) < 0;
  const n = newImage(it.assetId, w, h, it.name);
  const deg = (rot * 180) / Math.PI;
  n.transform = { x: top[0], y: top[1], rotation: Math.abs(deg) < 1e-9 ? 0 : deg, scale: 1, ...(flip ? { scaleY: -1 } : {}) };
  if (it.crop) n.crop = { x: it.crop.x * w, y: it.crop.y * h, w: it.crop.w * w, h: it.crop.h * h };
  if (it.invisible) n.visible = false;
  return n;
}

/** An entity whose linetype is its layer's: BYLAYER, or BYBLOCK inside a ByLayer insert. */
function isByLayer(e: CadEntity, ctx: Ctx): boolean {
  const n = e.ltype.toUpperCase();
  return n === "BYLAYER" || (n === "BYBLOCK" && ctx.byLayer === true);
}

/** The drawing's LTYPE table for the page source (linetypes loaded in the drawing, by upper-case name). */
/** The drawing's STYLE table for the page source (the DXF export writes it back: texts keep their fonts). */
function styleTable(d: CadDrawing): Record<string, CadStyleSource> {
  const out: Record<string, CadStyleSource> = {};
  for (const [key, s] of d.styles) out[key] = { name: s.name, file: s.file ?? s.font, ...(s.bigFont ? { bigFont: s.bigFont } : {}), height: s.height, width: s.widthFactor, oblique: s.oblique, gen: s.gen ?? 0, ...(s.family ? { family: s.family, familyFlags: s.familyFlags ?? 0 } : {}) };
  return out;
}

function ltypeTable(d: CadDrawing): Record<string, { name: string; pattern: number[] }> {
  const out: Record<string, { name: string; pattern: number[] }> = {};
  for (const [key, lt] of d.ltypes) if (!/^(BYLAYER|BYBLOCK)$/i.test(key)) out[key.toUpperCase()] = { name: lt.name, pattern: [...lt.pattern] };
  return out;
}

function pathNode(it: PathItem, m: Mat, k: number): VectorNode {
  const n = newVector(mapContours(it.contours, m), it.name ?? t(`engine.cad.ent.${it.type}`, undefined, it.type));
  n.fill = it.fill;
  n.stroke = it.stroke;
  n.fillRule = it.evenodd ? "evenodd" : "nonzero";
  if (it.width && it.width * k > 0.25) {
    n.strokeWidth = it.width * k;
    n.strokeCap = "butt";
    n.strokeJoin = "miter";
  } else n.strokeWidth = it.stroke ? Math.max(0.25, it.lw * PX_MM) : 0;
  if (it.dash && it.stroke) {
    const d = it.dash.map((v) => v * k);
    // a pattern finer than a pixel reads as a solid line (AutoCAD shows it solid too)
    if ((DASH_PERIOD.get(it.dash) ?? it.dash.reduce((a, v) => a + v, 0)) * k >= 2) n.strokeDash = d;
  }
  if (it.lt && it.stroke) n.cadLt = it.lt.segs ? { s: it.lt.s * k, segs: it.lt.segs.map((v) => v * k) } : { s: it.lt.s * k };
  if (it.invisible) n.visible = false;
  if (it.hatch) n.cadHatch = it.hatch;
  // a POINT stays a point (written back as POINT, not as a zero-length line)
  if (it.type === "POINT") n.cadPoint = true;
  if (it.vpFrame) n.cadVpFrame = [it.vpFrame[0], it.vpFrame[1]];
  return n;
}

/** Same-look paths of the same group merged into shared nodes (very large drawings). */
function mergeItems(items: Item[]): { items: Item[]; merged: number } {
  const out: Item[] = [];
  let merged = 0;
  for (const it of items) {
    const prev = out[out.length - 1];
    if (
      it.kind === "path" && prev?.kind === "path" && it.type !== "POINT" && prev.type !== "POINT" && !it.xline && !prev.xline && !it.hatch && !prev.hatch && !it.fill && !prev.fill && prev.grp === it.grp && prev.layer === it.layer && prev.stroke === it.stroke && prev.lw === it.lw && prev.width === it.width && String(prev.dash) === String(it.dash) && prev.lt?.s === it.lt?.s && !prev.invisible && !it.invisible && prev.contours.length < 500
    ) {
      // merged pieces keep one pattern scale (no per-piece layout when the layer linetype changes)
      if (prev.type !== "MERGED") out[out.length - 1] = { ...prev, type: "MERGED", contours: [...prev.contours, ...it.contours], name: undefined, ...(prev.lt ? { lt: { s: prev.lt.s } } : {}) };
      else if (prev.lt) prev.lt = { s: prev.lt.s };
      else prev.contours.push(...it.contours);
      merged++;
      continue;
    }
    out.push(it);
  }
  return { items: out, merged };
}

function buildPage(d: CadDrawing, w: Walker, items: Item[], opts: PageOpts, warnings: string[]): { page: Page; scale: number } | null {
  const drawn = bounds(items);
  if (!drawn) return null;
  // a layout page is its sheet (paper limits), a model page the drawing extents and a margin
  const box = opts.frame ?? drawn;
  const mpu = opts.paper ? opts.paperMm ?? mmPerUnit(d.insunits) : mmPerUnit(d.insunits);
  const wDu = box[2] - box[0], hDu = box[3] - box[1];
  const scale = opts.paper ? 1 : pickScale(Math.max(wDu, hDu) * mpu);
  const k = (mpu * PX_MM) / scale;
  const span = Math.max(wDu, hDu) * k;
  const pad = opts.frame ? 0 : Math.max(24, span * 0.04);
  const ox = box[0] - pad / k, oy = box[3] + pad / k;
  const pageM: Mat = [k, 0, 0, -k, -ox * k, oy * k];
  // construction lines: clipped to the drawing extents plus the margin
  const ext: [number, number, number, number] = [box[0] - pad / k, box[1] - pad / k, box[2] + pad / k, box[3] + pad / k];
  for (const it of items)
    if (it.kind === "path" && it.xline) {
      const seg = clipLine(it.xline.p, it.xline.dir, it.xline.ray, ext);
      it.contours = seg
        ? [
            {
              closed: false,
              nodes: seg.map((p) => ({ anchor: p, handleIn: p, handleOut: p, isCorner: true })),
            },
          ]
        : [];
      it.xline = undefined;
    }
  let list = items.filter((it) => it.kind !== "path" || it.contours.length);
  if (list.length > MAX_NODES) {
    const r = mergeItems(list);
    list = r.items;
    if (r.merged) warnings.push(t("engine.cad.warn.merged", { n: r.merged }));
  }

  // layer groups: layers in table order, layers holding fills first (drawn underneath, as fills usually are)
  const layerOrder = [...d.layers.values()].map((l) => l.name.toUpperCase());
  const used = new Map<string, Item[]>();
  for (const it of list) {
    const top = (it.grp ? it.grp.top : it.layer).toUpperCase();
    if (!used.has(top)) used.set(top, []);
    used.get(top)!.push(it);
  }
  const hasFill = (key: string) => used.get(key)!.some((it) => it.kind === "path" && !!it.fill);
  const keys = [...used.keys()].sort((a, b) => {
    const fa = hasFill(a) ? 0 : 1, fb = hasFill(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const ia = layerOrder.indexOf(a), ib = layerOrder.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });

  const groups: LayerGroup[] = [];
  const nodes: SceneNode[] = [];
  const layerGroupId = new Map<string, string>();
  /** entity handle → the nodes drawn for it */
  const nodesOf = new Map<string, string[]>();
  const grpAdded = new Set<Grp>();
  const addGrp = (g: Grp) => {
    if (grpAdded.has(g)) return;
    if (g.parent) addGrp(g.parent);
    grpAdded.add(g);
    groups.push({ id: g.id, name: g.name, parentId: g.parent ? g.parent.id : layerGroupId.get(g.top.toUpperCase()) ?? null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: g.cad });
  };
  for (const key of keys) {
    const first = used.get(key)![0];
    const L = w.layer(first.grp?.top ?? first.layer);
    const id = uid("g");
    layerGroupId.set(key, id);
    const cad: CadGroupMeta = { layer: L.name, color: cadHex(L.color, L.rgb), ltype: L.ltype };
    if (L.lw >= 0) cad.lw = L.lw / 100;
    if (L.frozen) cad.frozen = true;
    if (!L.plot) cad.noPlot = true;
    groups.push({ id, name: L.name, parentId: null, visible: L.on && !L.frozen, locked: L.locked, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad });
    /** column MTEXTs of this layer: the first column's node, all their nodes, where the codes are (finished below) */
    const cols = new Map<string, { head: TextNode; ts: TextNode[]; own: (q: [number, number]) => [number, number]; raw: [number, string | number][]; type: "TEXT" | "MTEXT" }>();
    for (const it of used.get(key)!) {
    const made = it.kind === "text" ? textNodes(it, pageM, k) : [it.kind === "path" ? pathNode(it, pageM, k) : imageNode(it, pageM)];
    // a text drawn as several nodes (stack tops) stays one object: a text group of its own in its layer / block
    let textG: string | null = null;
    if (made.length > 1) {
      if (it.grp) addGrp(it.grp);
      textG = uid("g");
      groups.push({ id: textG, name: made[0]!.name, parentId: it.grp ? it.grp.id : id, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { text: true } });
    }
    // an imported TEXT / MTEXT: its group codes and the look of its nodes now, so the DXF export writes it back exactly
    // while it is unchanged (dxfWrite2000.ts; the nodes' own geometry gave a slightly other insertion point and height)
    if (it.kind === "text" && it.raw && made[0] && made[0].type === "TEXT") {
      const ts = made.filter((x): x is TextNode => !!x && x.type === "TEXT");
      // (page → the text's own coordinates: the drawing / sheet, then its block's through its insert)
      const inv: Mat = [1 / pageM[0], 0, 0, 1 / pageM[3], -pageM[4] / pageM[0], -pageM[5] / pageM[3]];
      const ins = it.ins;
      const own = (q: [number, number]): [number, number] => {
        const w = ap(inv, q[0], q[1]) as [number, number];
        return ins ? insLocal(ins, w) : w;
      };
      if (it.col) cols.set(it.col, { head: made[0], ts, own, raw: it.raw, type: it.type === "MTEXT" ? "MTEXT" : "TEXT" });
      else made[0].cadText = { type: it.type === "MTEXT" ? "MTEXT" : "TEXT", raw: it.raw, sig: cadTextSig(ts), at: cadTextAt(ts, own), parts: ts.length };
    } else if (it.kind === "text" && it.col && cols.has(it.col)) cols.get(it.col)!.ts.push(...made.filter((x): x is TextNode => !!x && x.type === "TEXT"));
    const src = w.owner.get(it);
    for (const n of made) {
      if (!n) continue;
      if (src) {
        const l = nodesOf.get(src);
        if (l) l.push(n.id);
        else nodesOf.set(src, [n.id]);
      }
      if (it.grp) {
        addGrp(it.grp);
        n.groupId = textG ?? it.grp.id;
        if (it.layer.toUpperCase() !== key) {
          n.cadLayer = it.layer;
          const own = w.layer(it.layer);
          if (!own.on || own.frozen) n.visible = false;
          if (own.locked) n.locked = true;
        }
      } else n.groupId = textG ?? id;
      if (it.kind === "text" && it.mask) {
        // a text across a viewport edge: clipped onto a white copy of the window drawn in Multiply (it leaves what is
        // under it as it is), one base for the text's nodes
        if (n === made[0]) {
          const base = newVector(mapContours([{ closed: true, nodes: it.mask.map(corner) }], pageM), t("engine.cad.clipBoundary"));
          base.fill = "#FFFFFF";
          base.stroke = null;
          base.strokeWidth = 0;
          base.blendMode = "MULTIPLY";
          base.groupId = n.groupId;
          if (n.cadLayer) base.cadLayer = n.cadLayer;
          base.visible = n.visible;
          base.locked = n.locked;
          nodes.push(base);
        }
        n.clip = true;
      }
      if (it.kind === "image" && it.mask) {
        // a polygonal clip: the picture is a clipping mask over a filled copy of the boundary (the original picture
        // and its crop stay as they are)
        const base = newVector(mapContours([{ closed: true, nodes: it.mask.map(corner) }], pageM), t("engine.cad.clipBoundary"));
        base.fill = "#FFFFFF";
        base.stroke = null;
        base.strokeWidth = 0;
        base.groupId = n.groupId;
        if (n.cadLayer) base.cadLayer = n.cadLayer;
        base.visible = n.visible;
        base.locked = n.locked;
        nodes.push(base);
        n.clip = true;
      }
      nodes.push(n);
    }
    }
    // a column MTEXT: its codes on its first node, for the nodes of all its columns (the others marked as its parts)
    for (const [k2, c] of cols) {
      c.head.cadText = { type: c.type, raw: c.raw, sig: cadTextSig(c.ts), at: cadTextAt(c.ts, c.own), parts: c.ts.length, key: k2 };
      for (const x of c.ts) if (x !== c.head) x.cadPart = k2;
    }
  }

  // associativity as AutoCAD keeps it: a hatch's boundary objects and a dimension's measured object points
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    const h = n.type === "VECTOR" ? (n.cadHatch as (CadHatch & { srcH?: string[] }) | undefined) : undefined;
    if (!h?.srcH) continue;
    const ids = h.srcH.flatMap((x) => nodesOf.get(x)?.slice(0, 1) ?? []);
    const { srcH: _drop, ...rest } = h;
    void _drop;
    (n as VectorNode).cadHatch = ids.length ? { ...rest, src: ids } : rest;
  }
  for (const [dh, da] of d.dimAssoc ?? []) {
    const g = w.dimGrp.get(dh);
    const dm = g?.cad.dim;
    if (!dm || (dm.type !== 0 && dm.type !== 1) || !dm.p["13"] || !dm.p["14"] || !dm.p["10"]) continue;
    const assoc: NonNullable<typeof dm.assoc> = {};
    let r = 0;
    for (const [bit, key] of [[1, "13"], [2, "14"]] as const) {
      if (!(da.flags & bit)) continue;
      const ref = da.refs[r++];
      const id = ref && nodesOf.get(ref.obj)?.[0];
      const n = id ? byId.get(id) : undefined;
      if (n?.type !== "VECTOR" || !n.contours[0]) continue;
      assoc[key] = { id: n.id, ci: 0, i: ref.param > 0.5 ? n.contours[0].nodes.length - 1 : 0 };
    }
    if (!Object.keys(assoc).length) continue;
    const a = dm.p["13"], b = dm.p["14"], p10 = dm.p["10"];
    const ang = dm.type === 0 ? ((dm.angle ?? 0) * Math.PI) / 180 : Math.atan2(b[1] - a[1], b[0] - a[0]);
    const u: [number, number] = [Math.cos(ang), Math.sin(ang)];
    const nrm = [-u[1], u[0]];
    dm.assoc = assoc;
    dm.u = u;
    dm.off = (p10[0] - a[0]) * nrm[0] + (p10[1] - a[1]) * nrm[1];
  }

  const width = Math.max(1, Math.round(wDu * k + 2 * pad));
  const height = Math.max(1, Math.round(hDu * k + 2 * pad));
  const page = newPage("DESIGN", width, height, opts.name);
  page.nodes = nodes;
  page.groups = groups;
  const cad: CadSourceMeta = { format: opts.format, version: d.version, assetId: opts.asset.id, hash: opts.asset.hash, insunits: d.insunits, unit: unitSymbol(d.insunits), mmPerUnit: mpu, scale, k, ox, oy, ltypes: ltypeTable(d), styles: styleTable(d) };
  if (opts.layout) cad.layout = opts.layout;
  if (opts.layout && opts.layoutOrder) cad.layoutOrder = opts.layoutOrder;
  if (opts.layout && opts.layoutActive) cad.layoutActive = true;
  if (opts.refs?.length) cad.refs = opts.refs.map((r) => ({ ...r }));
  if (Object.keys(w.blocks).length) cad.blocks = { ...w.blocks };
  // AutoCAD GROUPs with members on this page: their entities' nodes (a clipping base node stays out, as it is not an entity)
  const cadGroupsHere = (d.groups ?? []).flatMap((g) => {
    const ids = g.handles.flatMap((h) => nodesOf.get(h) ?? []);
    return ids.length ? [{ name: g.name, ids, ...(g.description ? { description: g.description } : {}), ...(g.selectable ? {} : { selectable: false }), ...(g.unnamed ? { unnamed: true } : {}) }] : [];
  });
  if (cadGroupsHere.length) cad.groups = cadGroupsHere;
  page.source = { format: opts.format, name: opts.asset.name, cad };
  return { page, scale };
}

/** Pages for a read drawing: model space, then each layout with something drawn on it. */
export function buildCadPages(d: CadDrawing, opts: { name: string; format: "dxf" | "dwg"; asset: AssetRef; refs?: CadRefMeta[]; assets?: Record<string, AssetRef> }): CadBuildResult {
  const warnings: string[] = [];
  const pages: Page[] = [];
  const counts: Record<string, number> = {};
  const unsupported: Record<string, number> = { ...d.unsupported };
  const top = (): Ctx => ({ m: IDENT, inBlock: false, layer: "0", color: "#000000", lwRaw: -3, ltype: "CONTINUOUS", grp: null, depth: 0, stack: [] });
  const totals = { xrefs: new Set<string>(), shx: new Set<string>(), images: 0, viewports: 0, gradients: 0, patterns: 0 };
  const run = (ents: CadEntity[], po: Omit<PageOpts, "format" | "asset">) => {
    const w = new Walker(d);
    if (po.paper) w.model = d.entities.filter((e) => !e.paper);
    const ctx = top();
    // each item remembers the top-level entity it was drawn for (AutoCAD GROUPs name entities by handle)
    for (const e of ents) {
      const i0 = w.items.length;
      w.entity(e, ctx);
      const h = e.handle?.toUpperCase();
      if (h) for (let i = i0; i < w.items.length; i++) if (!w.owner.has(w.items[i])) w.owner.set(w.items[i], h);
    }
    for (const [k, v] of Object.entries(w.counts)) counts[k] = (counts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(w.unsupported)) unsupported[k] = (unsupported[k] ?? 0) + v;
    w.xrefs.forEach((x) => totals.xrefs.add(x));
    w.shx.forEach((x) => totals.shx.add(x));
    totals.images += w.images;
    totals.viewports += w.viewports;
    totals.gradients += w.gradients;
    totals.patterns += w.patterns;
    const r = buildPage(d, w, w.items, { ...po, format: opts.format, asset: opts.asset, refs: opts.refs }, warnings);
    if (r) pages.push(r.page);
    return r;
  };
  const model = run(
    d.entities.filter((e) => !e.paper),
    { name: t("engine.cad.page.model", { name: opts.name }) },
  );
  // layouts: the active one's entities are in ENTITIES (paper flag), the others in their *Paper_Space<n> blocks
  const layouts = d.layouts.filter((l) => l.name.toUpperCase() !== "MODEL");
  const paperEnts = d.entities.filter((e) => e.paper);
  const seen = new Set<string>();
  for (const l of layouts) {
    const key = l.block.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ents = key === "*PAPER_SPACE" || !key ? paperEnts : d.blocks.get(key)?.entities ?? [];
    if (!ents.some((e) => e.geom && !(e.geom.k === "viewport" && e.geom.id === 1))) continue;
    const frame: [number, number, number, number] | undefined = l.limits ? [l.limits[0][0], l.limits[0][1], l.limits[1][0], l.limits[1][1]] : undefined;
    run(ents, { name: t("engine.cad.page.layout", { name: opts.name, layout: l.name }), layout: l.name, layoutOrder: l.order, layoutActive: key === "*PAPER_SPACE", paper: true, frame, paperMm: l.paperMm });
  }
  if (!layouts.length && paperEnts.some((e) => e.geom && !(e.geom.k === "viewport" && e.geom.id === 1))) run(paperEnts, { name: t("engine.cad.page.layout", { name: opts.name, layout: "Layout1" }), layout: "Layout1", paper: true });

  if (!pages.length) {
    const p = newPage("DESIGN", 1123, 794, t("engine.cad.page.model", { name: opts.name }));
    p.source = { format: opts.format, name: opts.asset.name, cad: { format: opts.format, version: d.version, assetId: opts.asset.id, hash: opts.asset.hash, insunits: d.insunits, unit: unitSymbol(d.insunits), mmPerUnit: mmPerUnit(d.insunits), scale: 1, k: PX_MM, ox: 0, oy: 794 / PX_MM, ltypes: ltypeTable(d), styles: styleTable(d) } };
    pages.push(p);
    warnings.push(t("engine.cad.warn.empty"));
  }
  const un = Object.entries(unsupported).filter(([, n]) => n > 0);
  if (un.length) warnings.push(t("engine.cad.warn.unsupported", { list: un.map(([k, n]) => `${k} ${n}`).join(", ") }));
  // missing external files first: the open message shows the first warning
  if (totals.images) warnings.unshift(t("engine.cad.warn.image", { n: totals.images }));
  if (totals.xrefs.size) warnings.unshift(t("engine.cad.warn.xref", { n: totals.xrefs.size, list: [...totals.xrefs].slice(0, 5).join(", ") }));
  if (totals.patterns) warnings.push(t("engine.cad.warn.pattern", { n: totals.patterns }));
  if (totals.gradients) warnings.push(t("engine.cad.warn.gradient", { n: totals.gradients }));
  if (totals.viewports) warnings.push(t("engine.cad.warn.viewport", { n: totals.viewports }));
  if (totals.shx.size) warnings.push(t("engine.cad.warn.font", { list: [...totals.shx].slice(0, 6).join(", ") }));
  return { pages, assets: { ...opts.assets, [opts.asset.id]: opts.asset }, warnings, counts, unsupported, layers: d.layers.size, scale: model?.scale ?? 1 };
}
