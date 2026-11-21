// PPT (PowerPoint 97-2003) opened with its formatting: the binary records of the file ([MS-PPT], [MS-ODRAW]) written out
// as the PresentationML package PowerPoint would save of it, read by the PPTX importer (pptx.ts importPptx) — the same
// slide model, text formatting, shapes, pictures, tables and backgrounds as a PPTX. The same way the DOC reader goes
// through WordprocessingML (docRich.ts) and the HWP 5.0 reader through HWPX (hwp5.ts).
//
//   document   DocumentAtom: slide and notes size, first slide number; the persist directory of the newest user edit
//              (legacy.ts pptPersist) to the live document, slides, masters and notes; the slide list (SlideListWithText:
//              slides in order, the text of files of PowerPoint 97-2003 — OutlineTextRefAtom)
//   masters    each main master → a slide master: its colour scheme (ColorSchemeAtom → the theme's colours), its text
//              styles (TextMasterStyleAtom title / body / other → p:txStyles), its shapes (placeholders as prompts, the
//              rest drawn on every slide that follows the master's objects) and its background; a title master → a
//              layout of its main master with its own shapes
//   text       each text box's TextCharsAtom / TextBytesAtom with its runs: StyleTextPropAtom (paragraph and character
//              exceptions over the master's level of the text type: font, size, bold, italic, underline, colour,
//              super / subscript; alignment, indents, line spacing, space before / after, bullets), TextRulerAtom (the
//              box's indents), TextSpecialInfoAtom (language), slide number / date / footer fields — written out as
//              explicit a:pPr / a:rPr, so the PPTX importer reads exactly what PowerPoint resolves
//   shapes     OfficeArt (SpContainer): shape type → preset geometry (arrows' and rounded rectangles' adjust values
//              converted), freeforms (pVertices / pSegmentInfo → custGeom), anchors (client / child, group coordinate
//              spaces), rotation and flips, fill (solid, gradients, picture), line (colour, width, dashes), shadow, text
//              insets, anchor and wrap, placeholders
//   pictures   the BLIP store (FBSE → the Pictures stream): PNG, JPEG, DIB (as BMP), TIFF, crop; EMF and WMF
//              (inflated, WMF with its placeable header back — drawn by metafile.ts); PICT is named in a notice
//   tables     a group with table properties (0x3A0) whose cells lie on a grid: an a:tbl with the cells' text, fills,
//              insets and merged cells, the borders' colour as the table style's (one colour)
//   notes      the notes body text of each slide (as the text reader reads it — legacy.ts pptSlides)
//   slides     hidden slides, transitions (fade, push; others as fade, named), backgrounds (own or the master's),
//              own colour schemes, headers / footers (slide number, footer, date placeholders of the master)
//
// What is not read is named in the warnings (never left out without a word). The pages hold the text exactly as the
// text reader reads it (one text box per text atom), so the PPT save writes text edits into the original file by the
// map this open returns (pptWrite.ts savePptRichText).
//
// Source: [MS-PPT] PowerPoint (.ppt) Binary File Format, [MS-ODRAW] Office Drawing Binary File Format — Microsoft open
// specifications. ECMA-376 Part 1 (PresentationML, DrawingML) for the package written.

import { strFromU8, strToU8, unzlibSync, inflateSync, unzipSync, zipSync, type Zippable } from "fflate";
import { metafileKind, wmfPlaceable } from "./metafileSniff";
import type { AssetRef, Page, SceneNode } from "../../core/types";
import { t } from "../../i18n";
import { esc as escXml } from "../xml";
import { readCfb } from "./cfb";
import { PPT_RT, pptLines, pptPersist, pptSlides } from "./legacy";
import { importPptx } from "./pptx";

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const i16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

/**
 * XML-escaped, without the letters XML 1.0 cannot hold (C0 controls but tab / line feed / return, U+FFFE / U+FFFF, a
 * lone surrogate): a text atom or a name holding one made the part unreadable — a browser's DOMParser returns a
 * parsererror document, and the slide showed nothing after it (QA 2026-11-21). The box then shows other letters than
 * its atom holds: its edits are refused (pptWrite.ts, "special").
 */
const esc = (s: string) => escXml(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, ""));

/** EMU per master unit (576 per inch) */
const MU = 914400 / 576;
const emu = (v: number) => Math.round(v * MU);

// ───────────────────────── records ─────────────────────────

/** A record: header (instance, version, type), its body, and (a container) its records. */
interface R {
  at: number;
  type: number;
  inst: number;
  ver: number;
  body: Uint8Array;
  kids: R[] | null;
}

function recsIn(s: Uint8Array, from: number, to: number, depth: number): R[] {
  const out: R[] = [];
  for (let o = from; o + 8 <= to; ) {
    const vi = u16(s, o), type = u16(s, o + 2), len = u32(s, o + 4);
    if (o + 8 + len > to) break;
    const r: R = { at: o, type, inst: vi >> 4, ver: vi & 0xf, body: s.subarray(o + 8, o + 8 + len), kids: null };
    if ((vi & 0xf) === 0xf && depth < 32) r.kids = recsIn(s, o + 8, o + 8 + len, depth + 1);
    out.push(r);
    o += 8 + len;
  }
  return out;
}
const recAt = (s: Uint8Array, at: number): R | null => (at + 8 <= s.length ? recsIn(s, at, Math.min(s.length, at + 8 + u32(s, at + 4)), 0)[0] ?? null : null);
const kid = (r: R | null | undefined, type: number, inst?: number) => r?.kids?.find((k) => k.type === type && (inst === undefined || k.inst === inst));
const kidsOf = (r: R | null | undefined, type: number) => r?.kids?.filter((k) => k.type === type) ?? [];
function deep(r: R | null | undefined, type: number, out: R[] = []): R[] {
  for (const k of r?.kids ?? []) {
    if (k.type === type) out.push(k);
    deep(k, type, out);
  }
  return out;
}

const RT = {
  ...PPT_RT,
  documentAtom: 0x03e9,
  environment: 0x03f2,
  fontCollection: 0x07d5,
  fontEntity: 0x0fb7,
  masterStyle: 0x0fa3,
  colorScheme: 0x07f0,
  ppDrawing: 0x040c,
  ppDrawingGroup: 0x040b,
  headersFooters: 0x0fd9,
  headersFootersAtom: 0x0fda,
  cString: 0x0fba,
  slideShowInfo: 0x03f9,
  outlineRef: 0x0f9e,
  styleTextProp: 0x0fa1,
  masterTextProp: 0x0fa2,
  ruler: 0x0fa6,
  specialInfo: 0x0faa,
  interactive: 0x0ff2,
  textInteractive: 0x0fdf,
  slideNumberMC: 0x0fd8,
  dateTimeMC: 0x0ff7,
  genericDateMC: 0x0ff8,
  headerMC: 0x0ff9,
  footerMC: 0x0ffa,
  rtfDateTimeMC: 0x1015,
  progTags: 0x1388,
  exObjRef: 0x0fc1,
  placeholder: 0x0bc3,
  // OfficeArt
  dgg: 0xf000,
  bstore: 0xf001,
  dg: 0xf002,
  spgr: 0xf003,
  sp: 0xf004,
  fbse: 0xf007,
  fspgr: 0xf009,
  fsp: 0xf00a,
  fopt: 0xf00b,
  childAnchor: 0xf00f,
  clientAnchor: 0xf010,
  clientData: 0xf011,
  tertiary: 0xf122,
} as const;

// ───────────────────────── OfficeArt properties ─────────────────────────

/** An OfficeArt property table (FOPT, tertiary FOPT): simple values and complex data by property id. */
interface Props {
  v: Map<number, number>;
  c: Map<number, Uint8Array>;
}
function propsOf(...recs: (R | undefined)[]): Props {
  const p: Props = { v: new Map(), c: new Map() };
  for (const r of recs) {
    if (!r) continue;
    const n = r.inst;
    let data = n * 6;
    for (let k = 0; k < n && k * 6 + 6 <= r.body.length; k++) {
      const opid = u16(r.body, k * 6), op = u32(r.body, k * 6 + 2);
      const id = opid & 0x3fff;
      p.v.set(id, op);
      if (opid & 0x8000) {
        p.c.set(id, r.body.subarray(data, Math.min(r.body.length, data + op)));
        data += op;
      }
    }
  }
  return p;
}
/** A boolean property bit with its "use" bit (bits 16+): undefined when not set here. */
function flag(p: Props, id: number, bit: number): boolean | undefined {
  const v = p.v.get(id);
  if (v === undefined) return undefined;
  const use = bit << 16;
  return v & use ? !!(v & bit) : undefined;
}
const fixed = (v: number | undefined) => (v === undefined ? undefined : (v | 0) / 65536);

// ───────────────────────── colours ─────────────────────────

type Scheme = string[];
const hex6 = (r: number, g: number, b: number) => [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("").toUpperCase();
function schemeOf(r: R | undefined): Scheme | null {
  if (!r || r.body.length < 32) return null;
  return Array.from({ length: 8 }, (_, i) => hex6(r.body[i * 4], r.body[i * 4 + 1], r.body[i * 4 + 2]));
}

/** What an OfficeArtCOLORREF refers to others by (fill, line … colours of the same shape). */
interface ColorCtx {
  scheme: Scheme;
  fill?: string;
  line?: string;
  fillBack?: string;
  shadow?: string;
}
/** An OfficeArtCOLORREF ([MS-ODRAW] 2.2.2) as RRGGBB, or null for none. */
function colorRef(v: number | undefined, c: ColorCtx): string | null {
  if (v === undefined) return null;
  const r = v & 0xff, g = (v >>> 8) & 0xff, b = (v >>> 16) & 0xff, f = (v >>> 24) & 0xff;
  if (f & 0x08) return c.scheme[r] ?? null; // fSchemeIndex
  if (f & 0x10) {
    // fSysIndex: another colour of the shape (0xF0 …) with a modification (green: function, blue: parameter)
    const base = r === 0xf0 ? c.fill : r === 0xf1 ? c.line ?? c.fill : r === 0xf2 ? c.line : r === 0xf3 ? c.shadow : r === 0xf5 ? c.fillBack : r === 0xf7 ? c.fill ?? c.line : c.fill;
    if (!base) return null;
    let [x, y, z] = [0, 2, 4].map((k) => parseInt(base.slice(k, k + 2), 16));
    const fn = g & 0x0f, p = b;
    const map = (q: (n: number) => number) => ([x, y, z] = [x, y, z].map(q));
    if (fn === 1) map((n) => (n * p) / 255);
    else if (fn === 2) map((n) => 255 - ((255 - n) * p) / 255);
    else if (fn === 3) map((n) => n + p);
    else if (fn === 4) map((n) => n - p);
    else if (fn === 5) map((n) => p - n);
    if (g & 0x20) map((n) => 255 - n);
    return hex6(x, y, z);
  }
  return hex6(r, g, b);
}

// ───────────────────────── text properties ─────────────────────────

type Col = { rgb: string } | { scheme: number };
/** ColorIndexStruct: an RGB colour or a scheme index */
function colIdx(b: Uint8Array, o: number): Col | undefined {
  const idx = b[o + 3];
  if (idx === 0xfe) return { rgb: hex6(b[o], b[o + 1], b[o + 2]) };
  if (idx < 8) return { scheme: idx };
  return undefined;
}
const colHex = (c: Col | undefined, scheme: Scheme) => (c ? ("rgb" in c ? c.rgb : scheme[c.scheme] ?? "000000") : undefined);

/** TextPFException ([MS-PPT] 2.9.18), the fields set */
interface PF {
  hasBullet?: boolean;
  bulletHasFont?: boolean;
  bulletHasColor?: boolean;
  bulletHasSize?: boolean;
  bulletChar?: number;
  bulletFont?: number;
  bulletSize?: number;
  bulletColor?: Col;
  align?: number;
  lineSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  leftMargin?: number;
  indent?: number;
  defTab?: number;
  tabs?: { pos: number; type: number }[];
  fontAlign?: number;
  charWrap?: boolean;
  wordWrap?: boolean;
  overflow?: boolean;
  rtl?: boolean;
}
/** TextCFException ([MS-PPT] 2.9.13), the fields set */
interface CF {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  shadow?: boolean;
  emboss?: boolean;
  font?: number;
  eaFont?: number;
  symFont?: number;
  size?: number;
  color?: Col;
  position?: number;
}

function readPF(b: Uint8Array, o: number): { pf: PF; end: number } | null {
  if (o + 4 > b.length) return null;
  const m = u32(b, o);
  let p = o + 4;
  const pf: PF = {};
  const need = (n: number) => p + n <= b.length;
  if (m & 0xf) {
    if (!need(2)) return null;
    const f = u16(b, p);
    p += 2;
    if (m & 0x1) pf.hasBullet = !!(f & 1);
    if (m & 0x2) pf.bulletHasFont = !!(f & 2);
    if (m & 0x4) pf.bulletHasColor = !!(f & 4);
    if (m & 0x8) pf.bulletHasSize = !!(f & 8);
  }
  if (m & 0x80) (pf.bulletChar = u16(b, p)), (p += 2);
  if (m & 0x10) (pf.bulletFont = u16(b, p)), (p += 2);
  if (m & 0x40) (pf.bulletSize = i16(b, p)), (p += 2);
  if (m & 0x20) (pf.bulletColor = colIdx(b, p)), (p += 4);
  if (m & 0x800) (pf.align = u16(b, p)), (p += 2);
  if (m & 0x1000) (pf.lineSpacing = i16(b, p)), (p += 2);
  if (m & 0x2000) (pf.spaceBefore = i16(b, p)), (p += 2);
  if (m & 0x4000) (pf.spaceAfter = i16(b, p)), (p += 2);
  if (m & 0x100) (pf.leftMargin = i16(b, p)), (p += 2);
  if (m & 0x400) (pf.indent = i16(b, p)), (p += 2);
  if (m & 0x8000) (pf.defTab = u16(b, p)), (p += 2);
  if (m & 0x100000) {
    if (!need(2)) return null;
    const n = u16(b, p);
    p += 2;
    pf.tabs = [];
    for (let k = 0; k < n && need(4); k++, p += 4) pf.tabs.push({ pos: i16(b, p), type: u16(b, p + 2) });
  }
  if (m & 0x10000) (pf.fontAlign = u16(b, p)), (p += 2);
  if (m & 0xe0000) {
    const f = u16(b, p);
    p += 2;
    if (m & 0x20000) pf.charWrap = !!(f & 1);
    if (m & 0x40000) pf.wordWrap = !!(f & 2);
    if (m & 0x80000) pf.overflow = !!(f & 4);
  }
  if (m & 0x200000) (pf.rtl = u16(b, p) === 1), (p += 2);
  return p <= b.length ? { pf, end: p } : null;
}

function readCF(b: Uint8Array, o: number): { cf: CF; end: number } | null {
  if (o + 4 > b.length) return null;
  const m = u32(b, o);
  let p = o + 4;
  const cf: CF = {};
  if (m & 0xffff) {
    const f = u16(b, p);
    p += 2;
    if (m & 0x1) cf.bold = !!(f & 0x1);
    if (m & 0x2) cf.italic = !!(f & 0x2);
    if (m & 0x4) cf.underline = !!(f & 0x4);
    if (m & 0x10) cf.shadow = !!(f & 0x10);
    if (m & 0x200) cf.emboss = !!(f & 0x200);
  }
  if (m & 0x10000) (cf.font = u16(b, p)), (p += 2);
  if (m & 0x200000) (cf.eaFont = u16(b, p)), (p += 2);
  if (m & 0x400000) p += 2; // ansiFontRef
  if (m & 0x800000) (cf.symFont = u16(b, p)), (p += 2);
  if (m & 0x20000) (cf.size = u16(b, p)), (p += 2);
  if (m & 0x40000) (cf.color = colIdx(b, p)), (p += 4);
  if (m & 0x80000) (cf.position = i16(b, p)), (p += 2);
  if (m & 0x100000) p += 4; // pp10runid
  if (m & 0x1000000) p += 2; // newEAFontRef
  if (m & 0x2000000) p += 2; // csFontRef
  if (m & 0x4000000) p += 4; // pp11ext
  return p <= b.length ? { cf, end: p } : null;
}

const merge = <T extends object>(a: T, b: T | undefined): T => (b ? { ...a, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) } : a);

interface Lvl {
  pf: PF;
  cf: CF;
}
/** TextMasterStyleAtom: its levels (by level), each as stored (only the fields set). */
function masterStyle(r: R): (Lvl | undefined)[] {
  const b = r.body;
  const n = u16(b, 0);
  const out: (Lvl | undefined)[] = [];
  let o = 2;
  for (let k = 0; k < n && k < 9; k++) {
    let level = k;
    if (r.inst >= 5) (level = u16(b, o)), (o += 2);
    const pf = readPF(b, o);
    if (!pf) break;
    const cf = readCF(b, pf.end);
    if (!cf) break;
    o = cf.end;
    out[Math.min(4, level)] = { pf: pf.pf, cf: cf.cf };
  }
  return out;
}

/** text types (TextHeaderAtom): Title 0, Body 1, Notes 2, Other 4, CenterBody 5, CenterTitle 6, HalfBody 7, QuarterBody 8 */
const BASE_TYPE: Record<number, number> = { 5: 1, 6: 0, 7: 1, 8: 1 };

/** A master's text styles: each text type's five levels, resolved (the default style, the base type's, its own). */
class Styles {
  readonly lv = new Map<number, Lvl[]>();
  constructor(def: (Lvl | undefined)[], defPF: PF, defCF: CF, own: Map<number, (Lvl | undefined)[]>, exact?: Map<number, number[]>) {
    const lv = (l: Lvl, d: Lvl | undefined): Lvl => (d ? { pf: merge(l.pf, d.pf), cf: merge(l.cf, d.cf) } : l);
    const base = (type: number): Lvl[] => {
      const got = this.lv.get(type);
      if (got) return got;
      const mine = own.get(type) ?? [];
      const out: Lvl[] = [];
      if (BASE_TYPE[type] !== undefined) {
        // centred title / body, half and quarter body: the title's or body's levels with their own changes
        const from = base(BASE_TYPE[type]);
        for (let i = 0; i < 5; i++) out.push(lv(from[i], mine[i]));
      } else {
        // a level starts from the level above it: the default style's (Environment), then the master's
        for (let i = 0; i < 5; i++) out.push(lv(lv(i ? out[i - 1] : { pf: defPF, cf: defCF }, def[i]), mine[i]));
        // (PowerPoint 2007+ writes whole points here and the size it uses, 13.5 pt …, in its round-trip text styles)
        const ex = exact?.get(type);
        if (ex) out.forEach((l, i) => ex[i] && l.cf.size === Math.floor(ex[i]) && (out[i] = { pf: l.pf, cf: { ...l.cf, size: ex[i] } }));
      }
      this.lv.set(type, out);
      return out;
    };
    for (const type of [0, 1, 2, 4, 5, 6, 7, 8]) base(type);
  }
  of(type: number, level: number): Lvl {
    const l = this.lv.get(this.lv.has(type) ? type : 4)!;
    return l[Math.max(0, Math.min(4, level))];
  }
}

/**
 * The font sizes of a master's round-trip text styles (RoundTripOArtTextStyles12Atom: PowerPoint 2007+ keeps its
 * p:txStyles in a small package) by text type (title 0, body 1, other 4) and level — the sizes the binary styles round
 * down to whole points.
 */
function exactSizes(r: R | undefined): Map<number, number[]> | undefined {
  if (!r) return undefined;
  try {
    // (only the master's part, and only when small — QA 2026-11-21: a record of a few KB could inflate to gigabytes)
    const files = unzipSync(r.body, { filter: (f) => /slideMaster\d*\.xml$/.test(f.name) && f.originalSize <= 4 << 20 });
    const xml = Object.entries(files).find(([k]) => /slideMaster\d*\.xml$/.test(k))?.[1];
    if (!xml) return undefined;
    const s = strFromU8(xml);
    const out = new Map<number, number[]>();
    for (const [type, tag] of [[0, "titleStyle"], [1, "bodyStyle"], [4, "otherStyle"]] as const) {
      const m = new RegExp(`<p:${tag}>([\\s\\S]*?)</p:${tag}>`).exec(s);
      if (!m) continue;
      const sizes: number[] = [];
      for (const l of m[1].matchAll(/<a:lvl(\d)pPr\b[\s\S]*?<\/a:lvl\1pPr>/g)) {
        const sz = /<a:defRPr\b[^>]*?\bsz="(\d+)"/.exec(l[0]);
        if (sz) sizes[Number(l[1]) - 1] = Number(sz[1]) / 100;
      }
      out.set(type, sizes);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** TextRuler ([MS-PPT] 2.9.57): the box's indents by level */
function readRuler(b: Uint8Array): { lm: (number | undefined)[]; ind: (number | undefined)[]; defTab?: number; tabs?: { pos: number; type: number }[] } {
  const m = u32(b, 0);
  let p = 4;
  const out: ReturnType<typeof readRuler> = { lm: [], ind: [] };
  if (m & 0x2) p += 2; // cLevels
  if (m & 0x1) (out.defTab = u16(b, p)), (p += 2);
  if (m & 0x4) {
    const n = u16(b, p);
    p += 2;
    out.tabs = [];
    for (let k = 0; k < n && p + 4 <= b.length; k++, p += 4) out.tabs.push({ pos: i16(b, p), type: u16(b, p + 2) });
  }
  for (let i = 0; i < 5; i++) {
    if (m & (0x8 << i)) (out.lm[i] = i16(b, p)), (p += 2);
    if (m & (0x100 << i)) (out.ind[i] = i16(b, p)), (p += 2);
  }
  return out;
}

// ───────────────────────── the open ─────────────────────────

/** Gaps of the conversion, each named in a notice. */
type Gap =
  | "metafile"
  | "picture"
  | "ole"
  | "media"
  | "link"
  | "anim"
  | "transition"
  | "adjust"
  | "shape"
  | "arrow"
  | "pattern"
  | "gradient"
  | "alpha"
  | "vertical"
  | "textFx"
  | "autoNum"
  | "tableBorder"
  | "tableShapes"
  | "comments"
  | "picFx"
  | "freeform"
  | "scheme";
const GAPS: Gap[] = ["metafile", "picture", "ole", "media", "link", "anim", "transition", "adjust", "shape", "freeform", "arrow", "pattern", "gradient", "alpha", "picFx", "vertical", "textFx", "autoNum", "tableBorder", "tableShapes", "comments", "scheme"];

/** Where each text box of the pages came from: the text atom (stream offset) the PPT save writes its edits into. */
export interface PptTextAt {
  at: number;
  /** a master's text drawn on the slide (not written from a slide's edit) */
  master?: boolean;
}

export interface PptRichOpen {
  pages: Page[];
  assets: Record<string, AssetRef>;
  warnings: string[];
  /** per page, per node: the text atom of a text node (null: none) */
  texts: (PptTextAt | null)[][];
  /** per page: the SlideContainer's stream offset */
  slideAt: number[];
  pictures: number;
  tables: number;
  /** the day the date fields show (YYYY-MM-DD) */
  day: string;
}

interface Pic {
  bytes: Uint8Array;
  ext: string;
  mime: string;
}

/** a marker in the shape names written: the importer keeps the name, the open reads back which atom a text node is */
const MARK = "";

/**
 * Open a .ppt with its formatting (above). Throws when the file does not read so (then it opens as text only).
 */
export function pptRichOpen(bytes: Uint8Array, name: string, opts: { day?: string } = {}): PptRichOpen {
  // (the day date fields show: today, or the day of the open the save compares with — pptWrite.ts; QA 2026-11-21: a
  // file with a date field opened one day and saved the next refused every text edit as "reads differently")
  const day = opts.day ?? today();
  const cv = pptToPptx(bytes, day);
  const r = importPptx(cv.pptx, name, { copyMedia: true });
  if (r.pages.length !== cv.slides.length) throw new Error("ppt: slides");
  const texts: (PptTextAt | null)[][] = [];
  // (asset ids from the content, list ids from the place: the PPT save opens the file again and compares the pages)
  const assets: Record<string, AssetRef> = {};
  const idOf = new Map<string, string>();
  for (const a of Object.values(r.assets)) {
    const id = `pptpic-${a.hash.slice(0, 24)}`;
    idOf.set(a.id, id);
    assets[id] = { ...a, id };
  }
  r.pages.forEach((p, pi) => {
    const sl = cv.slides[pi];
    p.source = { format: "ppt", name };
    delete p.layout;
    if (sl.notes) p.notes = sl.notes;
    else delete p.notes;
    const row: (PptTextAt | null)[] = [];
    let lists = 0;
    const listIds = new Map<string, string>();
    p.nodes.forEach((n: SceneNode) => {
      const cut = n.name.indexOf(MARK);
      const mark = cut >= 0 ? n.name.slice(cut + 1) : "";
      if (cut >= 0) n.name = n.name.slice(0, cut);
      const at = mark ? cv.atoms.get(Number(mark)) : undefined;
      row.push(n.type === "TEXT" && at ? at : null);
      if (n.type === "IMAGE" && idOf.has(n.assetId)) n.assetId = idOf.get(n.assetId)!;
      if (n.type === "MEDIA" && n.posterAssetId && idOf.has(n.posterAssetId)) n.posterAssetId = idOf.get(n.posterAssetId)!;
      if (n.type === "TEXT")
        for (const q of n.paragraphs)
          if (q.list) {
            const inst = q.list.id.slice(0, q.list.id.length - q.list.def.length - 1);
            if (!listIds.has(inst)) listIds.set(inst, `ppt${pi}-${lists++}`);
            q.list = { ...q.list, id: `${listIds.get(inst)}-${q.list.def}` };
          }
    });
    texts.push(row);
  });
  const warnings: string[] = [];
  const tn = (key: string, n: number) => t(n === 1 ? `${key}_one` : key, { n });
  for (const g of GAPS) {
    const n = cv.gaps.get(g);
    if (n) warnings.push(tn(`pptrich.gap.${g}`, n));
  }
  // what the PPTX importer itself did not read (shapes it draws as their box …)
  for (const [k, v] of Object.entries(r.skipped)) warnings.push(`${k} ${v}`);
  return { pages: r.pages, assets, warnings, texts, slideAt: cv.slides.map((s) => s.at), pictures: cv.pictures, tables: cv.tables, day };
}

// ───────────────────────── PPT → PresentationML ─────────────────────────

interface SlideOut {
  at: number;
  notes?: string;
}

/** The file as the PresentationML package (above), the atoms its text boxes came from and what was not read. */
export function pptToPptx(bytes: Uint8Array, day = today()): { pptx: Uint8Array; slides: SlideOut[]; atoms: Map<number, PptTextAt>; gaps: Map<Gap, number>; pictures: number; tables: number } {
  const cfb = readCfb(bytes);
  const s = cfb.get("PowerPoint Document");
  const cu = cfb.get("Current User");
  if (!s || !cu || cfb.get("EncryptedSummary")) throw new Error("ppt: stream");
  const pics = cfb.get("Pictures");
  const persist = pptPersist(s, cu);
  const ue = persist.edits[0].at;
  const docAt = persist.offsets.get(u32(s, ue + 8 + 16));
  const doc = docAt !== undefined ? recAt(s, docAt) : null;
  if (!doc || doc.type !== RT.document) throw new Error("ppt: document");
  const da = kid(doc, RT.documentAtom);
  if (!da || da.body.length < 36) throw new Error("ppt: DocumentAtom");
  const W = i32(da.body, 0), H = i32(da.body, 4);
  const notesW = i32(da.body, 8), notesH = i32(da.body, 12);
  const firstNo = u16(da.body, 32) || 1;
  const gaps = new Map<Gap, number>();
  const gap = (g: Gap, n = 1) => gaps.set(g, (gaps.get(g) ?? 0) + n);

  // fonts, default text style
  const env = kid(doc, RT.environment);
  const fonts: string[] = [];
  for (const f of kidsOf(kid(env, RT.fontCollection), RT.fontEntity)) {
    let nm = "";
    for (let i = 0; i + 1 < Math.min(64, f.body.length) && u16(f.body, i); i += 2) nm += String.fromCharCode(u16(f.body, i));
    fonts[f.inst] = nm;
  }
  const fontOf = (ref: number | undefined) => (ref !== undefined && fonts[ref]) || fonts[0] || "Arial";
  const defCFr = kid(env, 0x0fa4), defPFr = kid(env, 0x0fa5);
  const defCF = (defCFr && readCF(defCFr.body, 0)?.cf) || {};
  const defPF = (defPFr && readPF(defPFr.body, 2)?.pf) || {};
  const defStyle = kidsOf(env, RT.masterStyle).map(masterStyle)[0] ?? [];

  // the BLIP store
  const bstore = kid(kid(kid(doc, RT.ppDrawingGroup), RT.dgg), RT.bstore);
  const fbses = kidsOf(bstore, RT.fbse);
  const dggDefaults = propsOf(kid(kid(kid(doc, RT.ppDrawingGroup), RT.dgg), RT.fopt));
  const picCache = new Map<number, Pic | null>();
  /** pictures that are metafiles (EMF, WMF, PICT) */
  const metafiles = new Set<number>();
  const blipOf = (pib: number): Pic | null => {
    if (picCache.has(pib)) return picCache.get(pib)!;
    let out: Pic | null = null;
    const f = fbses[pib - 1];
    if (f && f.body.length >= 36) {
      const foDelay = u32(f.body, 28), cbName = f.body[33];
      let blip: R | null = null;
      if (f.body.length > 36 + cbName + 8) blip = recsIn(f.body, 36 + cbName, f.body.length, 1)[0] ?? null;
      if (!blip && pics && foDelay < pics.length) blip = recAt(pics, foDelay);
      if (blip) out = decodeBlip(blip);
      if (blip && blip.type >= 0xf01a && blip.type <= 0xf01c) metafiles.add(pib);
    }
    picCache.set(pib, out);
    return out;
  };
  // embedded objects (ExObjList): movies and sounds, OLE objects — by their id
  const exMedia = new Set<number>();
  for (const x of kid(doc, 0x0409)?.kids ?? []) {
    const media = x.type === 0x1006 || x.type === 0x1007 || (x.type >= 0x100d && x.type <= 0x1011);
    const ma = kid(x, 0x1004);
    if (media && ma && ma.body.length >= 4) exMedia.add(u32(ma.body, 0));
  }
  const media: Zippable = {};
  const mediaName = new Map<number, string>();
  let pictures = 0;
  /** the package path of picture `pib` (null: not one shown — named in a notice) */
  const mediaOf = (pib: number): string | null => {
    if (mediaName.has(pib)) return mediaName.get(pib)!;
    const p = blipOf(pib);
    if (!p) return null;
    const path = `media/image${mediaName.size + 1}.${p.ext}`;
    media[`ppt/${path}`] = [p.bytes, { level: 0 }];
    mediaName.set(pib, path);
    return path;
  };

  // the slide list, masters, notes
  const lists = kidsOf(doc, RT.slideList);
  const list0 = lists.find((l) => l.inst === 0), list1 = lists.find((l) => l.inst === 1);
  const persistAt = (id: number) => persist.offsets.get(id);
  /** each slide of the list: its container's offset and its outline texts (97-2003: text in the list) */
  const slideList: { at: number; id: number; groups: R[][] }[] = [];
  for (const k of list0?.kids ?? []) {
    if (k.type === RT.slidePersist) {
      const at = persistAt(u32(k.body, 0));
      slideList.push({ at: at ?? -1, id: u32(k.body, 12), groups: [] });
    } else if (slideList.length) {
      const sl = slideList[slideList.length - 1];
      if (k.type === RT.textHeader) sl.groups.push([k]);
      else if (sl.groups.length) sl.groups[sl.groups.length - 1].push(k);
    }
  }
  const masterAt = new Map<number, number>();
  for (const k of list1?.kids ?? []) if (k.type === RT.slidePersist) {
    const at = persistAt(u32(k.body, 0));
    if (at !== undefined) masterAt.set(u32(k.body, 12), at);
  }
  // the text reader's notes (the PPT save writes notes edits by it)
  const notesBy = new Map<number, string>();
  for (const sl of pptSlides(s, persist.offsets).slides) if (sl.slide !== undefined && sl.notes) notesBy.set(sl.slide, pptLines(sl.notes.text));

  // headers / footers of the slides (document default)
  const hfOf = (r: R | undefined) => {
    const a = kid(r, RT.headersFootersAtom);
    const flags = a && a.body.length >= 4 ? u16(a.body, 2) : 0;
    const str = (inst: number) => {
      const c = kidsOf(r, RT.cString).find((x) => x.inst === inst);
      let v = "";
      if (c) for (let i = 0; i + 1 < c.body.length; i += 2) v += String.fromCharCode(u16(c.body, i));
      return v;
    };
    return { date: !!(flags & 0x1), num: !!(flags & 0x8), footer: !!(flags & 0x20), userDate: flags & 0x4 ? str(0) : "", footerText: str(2), today: !!(flags & 0x2) };
  };
  const docHF = kidsOf(doc, RT.headersFooters).find((h) => h.inst === 3);

  // ── masters ──
  interface Master {
    at: number;
    rec: R;
    main: Master | null;
    scheme: Scheme;
    styles: Styles;
    /** placeholders by type (title / body / dt / ftr / sldNum): their shape */
    ph: Map<string, R>;
    bg: R | null;
    part: number;
    layout: number;
    /** its shapes' properties by shape id (a slide shape with fHaveMaster inherits those of hspMaster) */
    spProps: Map<number, Props>;
  }
  const masters = new Map<number, Master>();
  const defScheme: Scheme = ["FFFFFF", "000000", "808080", "000000", "BBE0E3", "333399", "009999", "99CC00"];
  let parts = 0;
  const masterOf = (id: number, depth = 0): Master | null => {
    const at = masterAt.get(id);
    if (at === undefined || depth > 3) return null;
    if (masters.has(at)) return masters.get(at)!;
    const rec = recAt(s, at);
    if (!rec || (rec.type !== RT.mainMaster && rec.type !== RT.slide)) return null;
    let main: Master | null = null;
    if (rec.type === RT.slide) {
      // a title master: a layout of the main master its SlideAtom names
      const sa = kid(rec, RT.slideAtom);
      main = sa ? masterOf(u32(sa.body, 12), depth + 1) : null;
      if (!main) return null;
    }
    const own = new Map<number, (Lvl | undefined)[]>();
    for (const m of kidsOf(rec, RT.masterStyle)) own.set(m.inst, masterStyle(m));
    const scheme = schemeOf(kid(rec, RT.colorScheme, 1)) ?? main?.scheme ?? defScheme;
    const m: Master = {
      at,
      rec,
      main,
      scheme,
      styles: main ? main.styles : new Styles(defStyle, defPF, defCF, own, exactSizes(kid(rec, 0x0423))),
      ph: new Map(),
      bg: null,
      part: main ? main.part : ++parts,
      layout: 0,
      spProps: new Map(main?.spProps ?? []),
    };
    masters.set(at, m);
    const dg = kid(kid(rec, RT.ppDrawing), RT.dg);
    m.bg = kidsOf(dg, RT.sp).find((x) => fspOf(x).flags & 0x400) ?? null;
    if (main) for (const [k, v] of main.ph) m.ph.set(k, v);
    for (const sp of deep(kid(dg, RT.spgr), RT.sp)) {
      const ph = phOf(sp);
      if (ph) m.ph.set(ph.type, sp);
      const f = kid(sp, RT.fsp);
      if (f && f.body.length >= 4) m.spProps.set(u32(f.body, 0), propsOf(kid(sp, RT.fopt), kid(sp, RT.tertiary)));
    }
    return m;
  };

  // ── shapes ──
  const atoms = new Map<number, PptTextAt>();
  let tables = 0;
  /** A shape or group as PresentationML (and its pictures' relationships). */
  interface Out {
    xml: string[];
    rels: string[];
    ids: number;
  }

  /** the slide being written: its scheme, its outline texts (97-2003), its number */
  interface Env {
    scheme: Scheme;
    styles: Styles;
    groups: R[][];
    slideNo: number;
    master: boolean;
    hf: ReturnType<typeof hfOf>;
    /** the master the drawing's shapes inherit their properties from (fHaveMaster) */
    mst: Master | null;
  }
  /** the properties a shape with a master shape inherits: hspMaster's, else its master placeholder's */
  const masterProps = (e: Env, props: Props, ph: { type: string } | null): Props | null => {
    if (!e.mst) return null;
    const hsp = props.v.get(0x301);
    const by = hsp !== undefined ? e.mst.spProps.get(hsp) : undefined;
    if (by) return by;
    if (!ph) return null;
    const key = ph.type === "ctrTitle" ? ["ctrTitle", "title"] : ph.type === "subTitle" ? ["subTitle", "body"] : ph.type === "obj" ? ["body"] : [ph.type];
    for (const k of key) {
      const sp = e.mst.ph.get(k);
      if (sp) return propsOf(kid(sp, RT.fopt), kid(sp, RT.tertiary));
    }
    return null;
  };

  const relFor = (out: Out, path: string) => {
    const target = `../${path}`;
    const have = out.rels.findIndex((r) => r.includes(`Target="${target}"`));
    if (have >= 0) return `rIdM${have + 1}`;
    out.rels.push(`<Relationship Id="rIdM${out.rels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`);
    return `rIdM${out.rels.length}`;
  };

  /** text of a shape: its ClientTextbox's records, or (OutlineTextRefAtom) its group of the slide list */
  const textRecs = (sp: R, e: Env): R[] | null => {
    const tb = kid(sp, 0xf00d);
    if (!tb?.kids) return null;
    const ref = kid(tb, RT.outlineRef);
    if (ref) {
      const g = e.groups[i32(ref.body, 0)];
      return g ? [...g, ...tb.kids.filter((k) => k !== ref)] : null;
    }
    return tb.kids;
  };

  /** the a:p elements of a text box (null: none) */
  const txBody = (recs: R[], e: Env, ph: string | null, insets: string, mark: (at: number) => void): string | null => {
    const head = recs.find((k) => k.type === RT.textHeader);
    const atom = recs.find((k) => k.type === RT.textChars || k.type === RT.textBytes);
    const type = head && head.body.length >= 4 ? u32(head.body, 0) : 4;
    let text = "";
    // fields: their character positions
    const fields = new Map<number, string>();
    if (atom) {
      if (atom.type === RT.textChars) for (let i = 0; i + 1 < atom.body.length; i += 2) text += String.fromCharCode(u16(atom.body, i));
      else for (const c of atom.body) text += String.fromCharCode(c);
      mark(atom.at);
    } else if (!e.master && (ph === "sldNum" || ph === "ftr" || ph === "dt")) {
      // a header / footer placeholder without text of its own shows the slide's number, footer, date
      text = ph === "ftr" ? e.hf.footerText.replace(/\r\n?/g, "\x0b") : "*";
      if (ph !== "ftr") fields.set(0, ph === "sldNum" ? "num" : "date");
    }
    const L = text.length;
    // runs
    const pfRuns: { n: number; lvl: number; pf: PF }[] = [];
    const cfRuns: { n: number; cf: CF }[] = [];
    const st = recs.find((k) => k.type === RT.styleTextProp);
    if (st) {
      let o = 0, sum = 0;
      while (sum < L + 1 && o + 6 <= st.body.length) {
        const n = u32(st.body, o), lvl = u16(st.body, o + 4);
        const p = readPF(st.body, o + 6);
        if (!p || n < 1) break;
        pfRuns.push({ n, lvl, pf: p.pf });
        sum += n;
        o = p.end;
      }
      sum = 0;
      while (sum < L + 1 && o + 4 <= st.body.length) {
        const n = u32(st.body, o);
        const c = readCF(st.body, o + 4);
        if (!c || n < 1) break;
        cfRuns.push({ n, cf: c.cf });
        sum += n;
        o = c.end;
      }
    }
    // languages (TextSpecialInfoAtom)
    const langRuns: { n: number; lid?: number }[] = [];
    const si = recs.find((k) => k.type === RT.specialInfo);
    if (si) {
      for (let o = 0, sum = 0; sum < L + 1 && o + 8 <= si.body.length; ) {
        const n = u32(si.body, o), m = u32(si.body, o + 4);
        let p = o + 8, lid: number | undefined;
        if (m & 0x1) p += 2;
        if (m & 0x2) (lid = u16(si.body, p)), (p += 2);
        if (m & 0x4) p += 2;
        if (m & 0x40) p += 2;
        if (m & 0x20) p += 4;
        if (m & 0x200) p += 4 + u32(si.body, p) * 4;
        if (n < 1 || m & ~0x267) break;
        langRuns.push({ n, lid });
        sum += n;
        o = p;
      }
    }
    const ruler = recs.find((k) => k.type === RT.ruler);
    const rl = ruler ? readRuler(ruler.body) : null;
    if (recs.some((k) => k.type === RT.textInteractive || k.type === RT.interactive)) gap("link");
    for (const k of recs) {
      const kind = k.type === RT.slideNumberMC ? "num" : k.type === RT.dateTimeMC || k.type === RT.genericDateMC || k.type === RT.rtfDateTimeMC ? "date" : k.type === RT.footerMC ? "ftr" : k.type === RT.headerMC ? "hdr" : null;
      if (kind && k.body.length >= 4) fields.set(i32(k.body, 0), kind);
    }
    // (the run a character is in: by the runs' ends, halving — QA 2026-11-21: a walk over every run for every letter
    // took minutes on a long text with many runs)
    const ends = new Map<object, number[]>();
    const idx = (runs: { n: number }[], i: number): number => {
      if (!runs.length) return -1;
      let e = ends.get(runs);
      if (!e) {
        let sum = 0;
        ends.set(runs, (e = runs.map((r) => (sum += r.n))));
      }
      let lo = 0, hi = e.length - 1;
      if (i >= e[hi]) return hi;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (i < e[mid]) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const at = <T extends { n: number }>(runs: T[], i: number): T | undefined => runs[idx(runs, i)];
    const paras: string[] = [];
    let start = 0;
    const lines = text.split("\r");
    for (const line of lines.length ? lines : [""]) {
      const pr = at(pfRuns, start);
      const lvl = Math.max(0, Math.min(4, pr?.lvl ?? 0));
      const base = e.styles.of(type, lvl);
      let pf: PF = { ...base.pf };
      if (rl) {
        if (rl.lm[lvl] !== undefined) pf.leftMargin = rl.lm[lvl];
        if (rl.ind[lvl] !== undefined) pf.indent = rl.ind[lvl];
        if (rl.defTab !== undefined) pf.defTab = rl.defTab;
        if (rl.tabs) pf.tabs = rl.tabs;
      }
      pf = merge(pf, pr?.pf);
      const runs: string[] = [];
      const cfAt = (i: number) => merge(base.cf, at(cfRuns, i)?.cf);
      // (a run's formats by its character and language runs: worked out once per pair in the paragraph)
      const keys = new Map<string, string>();
      const runKey = (i: number) => {
        const k = `${idx(cfRuns, i)}|${idx(langRuns, i)}`;
        let v = keys.get(k);
        if (v === undefined) keys.set(k, (v = JSON.stringify([cfAt(i), at(langRuns, i)?.lid])));
        return v;
      };
      const rPr = (i: number) => {
        const cf = cfAt(i);
        const lid = at(langRuns, i)?.lid;
        return rprXml(cf, e.scheme, fontOf, lid, gap);
      };
      let i = 0;
      while (i < line.length) {
        const ci = start + i;
        const ch = line[i];
        if (ch === "\x0b") {
          runs.push(`<a:br>${rPr(ci).replace(/^<a:rPr/, "<a:rPr")}</a:br>`);
          i++;
          continue;
        }
        const f = fields.get(ci);
        if (f && ch === "*") {
          const txt = f === "num" ? String(e.slideNo) : f === "ftr" ? e.hf.footerText : f === "date" ? e.hf.userDate || day : "";
          if (f === "num") runs.push(`<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum">${rPr(ci)}<a:t>${esc(e.master ? "‹#›" : txt)}</a:t></a:fld>`);
          else if (f === "date" && !e.hf.userDate) runs.push(`<a:fld id="{CB24CFB4-81BA-4A5E-A3CF-0B4ED16F4DBA}" type="datetime1">${rPr(ci)}<a:t>${esc(txt)}</a:t></a:fld>`);
          else if (txt) runs.push(`<a:r>${rPr(ci)}<a:t>${esc(txt)}</a:t></a:r>`);
          i++;
          continue;
        }
        // a run: the same character formats and language, up to a line break or a field
        const key = runKey(ci);
        let j = i + 1;
        while (j < line.length && line[j] !== "\x0b" && !(fields.has(start + j) && line[j] === "*") && runKey(start + j) === key) j++;
        runs.push(`<a:r>${rPr(ci)}<a:t>${esc(line.slice(i, j))}</a:t></a:r>`);
        i = j;
      }
      const end = rPr(start + line.length).replace(/^<a:rPr/, "<a:endParaRPr").replace(/<\/a:rPr>$/, "</a:endParaRPr>");
      paras.push(`<a:p>${pprXml(pf, lvl, base.cf, e.scheme, fontOf)}${runs.join("")}${end}</a:p>`);
      start += line.length + 1;
    }
    if (!atom && !ph && !text) return null;
    return `<p:txBody>${insets}<a:lstStyle/>${paras.join("")}</p:txBody>`;
  };

  /** OfficeArt shape (or group) → PresentationML, into `out` */
  const shape = (sp: R, e: Env, out: Out, map: (b: Box) => Box, top: boolean, onMaster: boolean, defs: Props): void => {
    if (sp.type === RT.spgr) {
      const first = kid(sp, RT.sp);
      if (!first) return;
      const fsp = fspOf(first);
      const props = propsOf(kid(first, RT.fopt), kid(first, RT.tertiary));
      const fg = kid(first, RT.fspgr);
      const anchor = anchorOf(first, top);
      const kids = (sp.kids ?? []).slice(1);
      if (!fg || !anchor) {
        for (const k of kids) shape(k, e, out, map, top, onMaster, defs);
        return;
      }
      const box = map(rotBox(anchor, props, fsp));
      const ch = { x: i32(fg.body, 0), y: i32(fg.body, 4), w: i32(fg.body, 8) - i32(fg.body, 0), h: i32(fg.body, 12) - i32(fg.body, 4) };
      // a table: its cells on a grid
      if (props.v.has(0x3a0) || props.c.has(0x3a1)) {
        const tbl = tableXml(kids, ch, box, e, out, defs);
        if (tbl) {
          tables++;
          out.xml.push(tbl);
          return;
        }
        gap("tableShapes");
      }
      const id = ++out.ids;
      const inner: Out = { xml: [], rels: out.rels, ids: out.ids };
      for (const k of kids) shape(k, e, inner, (b) => b, false, onMaster, defs);
      out.ids = inner.ids;
      out.xml.push(`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${esc(nameOf(props) || t("pptrich.name.group"))}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm(box, ch)}</p:grpSpPr>${inner.xml.join("")}</p:grpSp>`);
      return;
    }
    if (sp.type !== RT.sp) return;
    const fsp = fspOf(sp);
    if (fsp.flags & 0x0c) return; // patriarch, deleted
    const props = propsOf(kid(sp, RT.fopt), kid(sp, RT.tertiary));
    const anchor = anchorOf(sp, top);
    const ph = phOf(sp);
    if (!anchor) return;
    // a shape with a master shape (a slide's placeholder): what it does not set, its master shape's
    if (fsp.flags & 0x20) defs = masterProps(e, props, ph) ?? defs;
    const box = map(rotBox(anchor, props, fsp));
    const P = (id: number) => props.v.get(id) ?? defs.v.get(id) ?? dggDefaults.v.get(id);
    const cc: ColorCtx = { scheme: e.scheme };
    cc.fill = colorRef(P(0x181) ?? 0x08000004, cc) ?? undefined;
    cc.fillBack = colorRef(P(0x183) ?? 0x00ffffff, cc) ?? undefined;
    cc.line = colorRef(P(0x1c0) ?? 0x08000001, cc) ?? undefined;
    cc.shadow = colorRef(P(0x201) ?? 0x00808080, cc) ?? undefined;
    const spt = sp && fsp.type;
    const filled = flag(props, 0x1bf, 0x10) ?? flag(defs, 0x1bf, 0x10) ?? flag(dggDefaults, 0x1bf, 0x10) ?? spt !== 20;
    const lined = flag(props, 0x1ff, 0x08) ?? flag(defs, 0x1ff, 0x08) ?? flag(dggDefaults, 0x1ff, 0x08) ?? true;
    const exRef = kid(kid(sp, RT.clientData), RT.exObjRef);
    if (exRef && exRef.body.length >= 4 && exMedia.has(u32(exRef.body, 0))) gap("media");
    else if (exRef || fsp.flags & 0x10) gap("ole");
    const name = nameOf(props) || (ph ? t("pptrich.name.placeholder") : spt === 75 ? t("pptrich.name.picture") : t("pptrich.name.shape"));
    const textR = textRecs(sp, e);
    let markAt = -1;
    const insets = bodyPr(props, defs, fsp);
    if (P(0x88)) gap("vertical");
    const body = textR ? txBody(textR, e, ph?.type ?? null, insets, (a) => (markAt = a)) : null;
    if (markAt >= 0) {
      atoms.set(markAt, onMaster ? { at: markAt, master: true } : { at: markAt });
    }
    // (the file's own name without the marker letter: a name holding one would point the save at another atom)
    const nm = esc(name.split(MARK).join("")) + (markAt >= 0 ? MARK + markAt : "");
    const id = ++out.ids;
    const nvPr = ph && !onMaster ? `<p:nvPr><p:ph type="${ph.type}"${ph.idx ? ` idx="${ph.idx}"` : ""}/></p:nvPr>` : ph ? `<p:nvPr><p:ph type="${ph.type}"${ph.idx ? ` idx="${ph.idx}"` : ""}/></p:nvPr>` : "<p:nvPr/>";
    // pictures: a picture frame (or a shape filled with a picture, without text)
    const pib = P(0x104);
    const fillType = P(0x180) ?? 0;
    const fillPib = fillType === 3 && filled ? P(0x186) : undefined;
    if ((pib && (spt === 75 || !body)) || (fillPib && !body)) {
      const path = mediaOf((pib || fillPib)!);
      if (!path) {
        gap(metafiles.has((pib || fillPib)!) ? "metafile" : "picture");
        return;
      }
      pictures++;
      const rid = relFor(out, path);
      const crop = [0x102, 0x100, 0x103, 0x101].map((k) => Math.round((fixed(props.v.get(k)) ?? 0) * 100000));
      const src = crop.some(Boolean) ? `<a:srcRect l="${crop[0]}" t="${crop[1]}" r="${crop[2]}" b="${crop[3]}"/>` : "";
      // (brightness, contrast off their defaults; grey / black-and-white picture)
      if ((props.v.get(0x108) ?? 0x10000) !== 0x10000 || (props.v.get(0x109) ?? 0) !== 0 || flag(props, 0x13f, 0x4) || flag(props, 0x13f, 0x2)) gap("picFx");
      const geom = spt === 75 || spt === 1 || spt === 202 ? `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` : geomXml(spt, props, box, gap);
      const ln = spt === 75 && lined && props.v.has(0x1c0) ? lineXml(P, cc, gap) : "";
      out.xml.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${nm}"/><p:cNvPicPr/>${nvPr}</p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(box)}${geom}${ln}</p:spPr></p:pic>`);
      return;
    }
    const isLine = spt === 20 || (spt >= 32 && spt <= 40) || !!(fsp.flags & 0x100);
    const fill = isLine ? "<a:noFill/>" : filled ? fillXml(props, P, cc, e, out, gap) : "<a:noFill/>";
    const ln = lined ? lineXml(P, cc, gap) : "<a:ln><a:noFill/></a:ln>";
    const fx = flag(props, 0x23f, 0x02) ?? false ? shadowXml(P, cc) : "";
    const geom = geomXml(spt, props, box, gap);
    const tag = isLine ? "cxnSp" : "sp";
    const nv = isLine ? `<p:nvCxnSpPr><p:cNvPr id="${id}" name="${nm}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` : `<p:nvSpPr><p:cNvPr id="${id}" name="${nm}"/><p:cNvSpPr${spt === 202 ? ' txBox="1"' : ""}/>${nvPr}</p:nvSpPr>`;
    out.xml.push(`<p:${tag}>${nv}<p:spPr>${xfrm(box)}${geom}${fill}${ln}${fx}</p:spPr>${!isLine && body ? body : ""}</p:${tag}>`);
  };

  // tables: the group's cells on a grid
  const tableXml = (kids: R[], ch: { x: number; y: number; w: number; h: number }, box: Box, e: Env, out: Out, defs: Props): string | null => {
    const cells: { x0: number; y0: number; x1: number; y1: number; sp: R; props: Props }[] = [];
    const lines: { x0: number; y0: number; x1: number; y1: number; color: string | null; w: number }[] = [];
    const sx = box.w / (ch.w || 1), sy = box.h / (ch.h || 1);
    for (const k of kids) {
      if (k.type !== RT.sp) return null;
      const a = anchorOf(k, false);
      if (!a) return null;
      const props = propsOf(kid(k, RT.fopt), kid(k, RT.tertiary));
      const f = fspOf(k);
      const r = { x0: Math.round(a.x - ch.x), y0: Math.round(a.y - ch.y), x1: Math.round(a.x - ch.x + a.w), y1: Math.round(a.y - ch.y + a.h) };
      if (f.type === 20) {
        const on = flag(props, 0x1ff, 0x08) ?? true;
        lines.push({ ...r, color: on ? colorRef(props.v.get(0x1c0) ?? 0x08000001, { scheme: e.scheme }) : null, w: (props.v.get(0x1cb) ?? 12700) / 12700 });
      } else cells.push({ ...r, sp: k, props });
    }
    if (!cells.length) return null;
    const xs = [...new Set(cells.flatMap((c) => [c.x0, c.x1]))].sort((a, b) => a - b);
    const ys = [...new Set(cells.flatMap((c) => [c.y0, c.y1]))].sort((a, b) => a - b);
    // (a grid far larger than its cells is no table: drawn as shapes — QA 2026-11-21, cells at scattered places made a
    // grid of their count squared)
    if (cells.length > 4096 || lines.length > 16384 || (xs.length - 1) * (ys.length - 1) > Math.max(64, cells.length * 4)) return null;
    const grid: (typeof cells[number] | null | "covered")[][] = ys.slice(1).map(() => xs.slice(1).map(() => null));
    for (const c of cells) {
      const ci = xs.indexOf(c.x0), cj = xs.indexOf(c.x1), ri = ys.indexOf(c.y0), rj = ys.indexOf(c.y1);
      for (let r = ri; r < rj; r++) for (let q = ci; q < cj; q++) {
        if (grid[r][q]) return null;
        grid[r][q] = r === ri && q === ci ? c : "covered";
      }
    }
    if (grid.some((row) => row.some((c) => c === null))) return null;
    // borders: one colour (the most used), one width
    const colors = new Map<string, number>();
    for (const l of lines) if (l.color) colors.set(l.color, (colors.get(l.color) ?? 0) + 1);
    const border = [...colors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (colors.size > 1 || new Set(lines.map((l) => l.w)).size > 1 || lines.some((l) => !l.color)) gap("tableBorder");
    tableStyles.push(border ?? "");
    const styleId = tableStyleId(tableStyles.length - 1);
    const id = ++out.ids;
    const ln = (c: typeof cells[number], side: "L" | "R" | "T" | "B") => {
      const hit = lines.find((l) => (side === "L" || side === "R" ? l.x0 === l.x1 && l.x0 === (side === "L" ? c.x0 : c.x1) && l.y0 <= c.y0 && l.y1 >= c.y1 : l.y0 === l.y1 && l.y0 === (side === "T" ? c.y0 : c.y1) && l.x0 <= c.x0 && l.x1 >= c.x1));
      if (!hit?.color) return `<a:ln${side} w="0"><a:noFill/></a:ln${side}>`;
      return `<a:ln${side} w="${Math.round(hit.w * 12700)}"><a:solidFill><a:srgbClr val="${hit.color}"/></a:solidFill></a:ln${side}>`;
    };
    const rows = grid.map((row, r) => {
      const h = emu((ys[r + 1] - ys[r]) * sy);
      const tcs = row.map((c, q) => {
        if (c === "covered" || c === null) {
          const above = r > 0 && grid[r - 1][q] !== null && grid.slice(0, r).some((rr) => rr[q] !== "covered" && rr[q] !== null && (rr[q] as typeof cells[number]).y1 > ys[r]);
          return `<a:tc${above ? ' vMerge="1"' : ' hMerge="1"'}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></a:txBody><a:tcPr/></a:tc>`;
        }
        const gs = xs.indexOf(c.x1) - xs.indexOf(c.x0), rs = ys.indexOf(c.y1) - ys.indexOf(c.y0);
        const recs = textRecs(c.sp, e);
        const P = (k: number) => c.props.v.get(k) ?? defs.v.get(k) ?? dggDefaults.v.get(k);
        // (a cell's text is not a text box of the page: its edits are not written into the file — refused as a table edit)
        const body = recs ? txBody(recs, e, "body", "<a:bodyPr/>", () => {}) : null;
        const cc: ColorCtx = { scheme: e.scheme };
        cc.fill = colorRef(P(0x181) ?? 0x08000004, cc) ?? undefined;
        const filled = flag(c.props, 0x1bf, 0x10) ?? flag(dggDefaults, 0x1bf, 0x10) ?? true;
        const fill = filled ? `<a:solidFill><a:srgbClr val="${cc.fill ?? "FFFFFF"}"/></a:solidFill>` : "<a:noFill/>";
        const anchor = ["t", "ctr", "b", "t", "ctr", "b"][P(0x87) ?? 0] ?? "t";
        const mar = (k: number, d: number) => Math.round(P(k) ?? d);
        const tcPr = `<a:tcPr marL="${mar(0x81, 91440)}" marR="${mar(0x83, 91440)}" marT="${mar(0x82, 45720)}" marB="${mar(0x84, 45720)}" anchor="${anchor}">${ln(c, "L")}${ln(c, "R")}${ln(c, "T")}${ln(c, "B")}${fill}</a:tcPr>`;
        const txb = body ? body.replace(/^<p:txBody>/, "<a:txBody>").replace(/<\/p:txBody>$/, "</a:txBody>") : `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></a:txBody>`;
        return `<a:tc${gs > 1 ? ` gridSpan="${gs}"` : ""}${rs > 1 ? ` rowSpan="${rs}"` : ""}>${txb}${tcPr}</a:tc>`;
      });
      return `<a:tr h="${h}">${tcs.join("")}</a:tr>`;
    });
    const cols = xs.slice(1).map((x, q) => `<a:gridCol w="${emu((x - xs[q]) * sx)}"/>`).join("");
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(t("pptrich.name.table"))}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(box.w)}" cy="${emu(box.h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr><a:tblGrid>${cols}</a:tblGrid>${rows.join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  };
  const tableStyles: string[] = [];

  /** a drawing's shapes (and its background shape) as PresentationML */
  const drawing = (rec: R, e: Env, out: Out, onMaster: boolean, skipPh: boolean) => {
    const dg = kid(kid(rec, RT.ppDrawing), RT.dg);
    const tree = kid(dg, RT.spgr);
    const defs: Props = { v: new Map(), c: new Map() };
    for (const k of (tree?.kids ?? []).slice(1)) {
      if (skipPh && k.type === RT.sp && phOf(k)) continue;
      shape(k, e, out, (b) => b, true, onMaster, defs);
    }
  };
  /** a background shape as p:bg */
  const bgXml = (bg: R | null, e: Env, out: Out): string => {
    if (!bg) return "";
    const props = propsOf(kid(bg, RT.fopt), kid(bg, RT.tertiary));
    const P = (id: number) => props.v.get(id) ?? dggDefaults.v.get(id);
    const cc: ColorCtx = { scheme: e.scheme };
    cc.fill = colorRef(P(0x181) ?? 0x08000000, cc) ?? e.scheme[0];
    cc.fillBack = colorRef(P(0x183) ?? 0x00ffffff, cc) ?? undefined;
    const filled = flag(props, 0x1bf, 0x10) ?? true;
    const fill = filled ? fillXml(props, P, cc, e, out, gap, true) : `<a:solidFill><a:srgbClr val="${e.scheme[0]}"/></a:solidFill>`;
    return `<p:bg><p:bgPr>${fill}<a:effectLst/></p:bgPr></p:bg>`;
  };
  /** a picture fill (background, shape) */
  function fillXml(props: Props, P: (id: number) => number | undefined, cc: ColorCtx, e: Env, out: Out, g: typeof gap, bg = false): string {
    const type = P(0x180) ?? 0;
    const alpha = fixed(P(0x182));
    const a = (v: number | undefined) => (v !== undefined && v < 1 ? `<a:alpha val="${Math.round(Math.max(0, v) * 100000)}"/>` : "");
    if (alpha !== undefined && alpha < 1) g("alpha");
    const solid = (c: string | undefined, v?: number) => `<a:solidFill><a:srgbClr val="${c ?? "FFFFFF"}">${a(v)}</a:srgbClr></a:solidFill>`;
    if (type === 0) return solid(cc.fill, alpha);
    if (type >= 4 && type <= 8) {
      // shades: linear from the fill colour to the back colour (the angle, the focus: 100 reverses, 50 mirrors)
      if (type !== 7 || props.c.has(0x197)) g("gradient");
      const ang = ((fixed(P(0x18b)) ?? 0) % 360 + 360) % 360;
      const focus = i32ish(P(0x18c) ?? 0);
      const c1 = cc.fill ?? "FFFFFF", c2 = cc.fillBack ?? "FFFFFF";
      const gs = (pos: number, c: string) => `<a:gs pos="${pos}"><a:srgbClr val="${c}"/></a:gs>`;
      const stops = Math.abs(focus) === 50 ? (focus > 0 ? gs(0, c1) + gs(50000, c2) + gs(100000, c1) : gs(0, c2) + gs(50000, c1) + gs(100000, c2)) : focus === 100 || focus === -100 ? gs(0, c2) + gs(100000, c1) : gs(0, c1) + gs(100000, c2);
      // OfficeArt angles go counter-clockwise from the bottom; DrawingML's clockwise from the right
      const lin = (((90 - ang) % 360) + 360) % 360;
      return type === 5 || type === 6 ? `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>` : `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${lin * 60000}" scaled="1"/></a:gradFill>`;
    }
    if (type === 3 || type === 2) {
      const path = P(0x186) ? mediaOf(P(0x186)!) : null;
      if (path && (bg || type === 3)) return `<a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${relFor(out, path)}"/><a:srcRect/>${type === 2 ? '<a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/>' : "<a:stretch><a:fillRect/></a:stretch>"}</a:blipFill>`;
      g("pattern");
      return solid(cc.fill, alpha);
    }
    if (type === 9) return solid(e.scheme[0]);
    g("pattern");
    return solid(cc.fill, alpha);
  }

  // ── the package ──
  const files: Zippable = {};
  const put = (path: string, xml: string) => (files[path] = [strToU8(xml), { level: 0 }]);
  const slides: SlideOut[] = [];
  const masterParts = new Map<number, Master>();
  const layoutsOf = new Map<number, { file: number; master: Master }>();
  let layoutsN = 0;
  /** the layout part of a master (the main master's own; a title master's) */
  const layoutOf = (m: Master): number => {
    if (layoutsOf.has(m.at)) return layoutsOf.get(m.at)!.file;
    const file = ++layoutsN;
    layoutsOf.set(m.at, { file, master: m });
    if (!m.main) masterParts.set(m.part, m);
    else if (!masterParts.has(m.part)) masterParts.set(m.part, m.main);
    return file;
  };

  const slideHF = (rec: R) => hfOf(kidsOf(rec, RT.headersFooters).find((h) => h.inst === 3) ?? docHF);
  let animSlides = 0;
  slideList.forEach((sl, si) => {
    const rec = sl.at >= 0 ? recAt(s, sl.at) : null;
    if (!rec || rec.type !== RT.slide) throw new Error("ppt: slide");
    const sa = kid(rec, RT.slideAtom);
    if (!sa || sa.body.length < 22) throw new Error("ppt: SlideAtom");
    const m = masterOf(u32(sa.body, 12));
    if (!m) throw new Error("ppt: master");
    const flags = u16(sa.body, 20);
    const main = m.main ?? m;
    const scheme = flags & 0x2 ? m.scheme : schemeOf(kid(rec, RT.colorScheme, 1)) ?? m.scheme;
    const hf = slideHF(rec);
    const e: Env = { scheme, styles: main.styles, groups: sl.groups, slideNo: firstNo + si, master: false, hf, mst: m };
    const out: Out = { xml: [], rels: [], ids: 1 };
    // the master's objects: on the master (its scheme the slide's own when it has one: then drawn on the slide)
    const showMaster = !!(flags & 0x1);
    const ownScheme = showMaster && scheme.join() !== m.scheme.join();
    if (ownScheme) {
      gap("scheme");
      for (const mm of m.main ? [m.main, m] : [m]) drawing(mm.rec, { ...e, master: false, mst: mm.main }, out, true, true);
    }
    drawing(rec, e, out, false, false);
    // headers / footers the slide shows from its master's placeholders (when its own drawing has none)
    const own = new Set(deep(kid(kid(kid(rec, RT.ppDrawing), RT.dg), RT.spgr), RT.sp).map((x) => phOf(x)?.type));
    for (const [type, on] of [["sldNum", hf.num], ["ftr", hf.footer], ["dt", hf.date]] as const) {
      const phSp = (m.ph.get(type) ?? main.ph.get(type)) as R | undefined;
      if (on && phSp && !own.has(type)) shape(phSp, { ...e, mst: null }, out, (b) => b, true, true, { v: new Map(), c: new Map() });
    }
    const bg = flags & 0x4 ? bgXml(m.bg ?? main.bg, e, out) : bgXml(kidsOf(kid(kid(rec, RT.ppDrawing), RT.dg), RT.sp).find((x) => fspOf(x).flags & 0x400) ?? null, e, out);
    // transitions, hidden
    const ssi = kid(rec, RT.slideShowInfo);
    let transition = "";
    let hidden = false;
    if (ssi && ssi.body.length >= 13) {
      const dir = ssi.body[8], type = ssi.body[9], sflags = u16(ssi.body, 10), speed = ssi.body[12];
      hidden = !!(sflags & 0x4);
      const spd = ["slow", "med", "fast"][speed] ?? "med";
      if (type === 6) transition = `<p:transition spd="${spd}"><p:fade/></p:transition>`;
      else if (type === 20) transition = `<p:transition spd="${spd}"><p:push dir="${["l", "u", "r", "d"][dir] ?? "l"}"/></p:transition>`;
      else if (type !== 0) {
        gap("transition");
        transition = `<p:transition spd="${spd}"><p:fade/></p:transition>`;
      }
    }
    // animation: PowerPoint 97's (AnimationInfoContainer on a shape), PowerPoint 2002's (PPT10 time nodes)
    if (deep(kid(rec, RT.ppDrawing), 0x1014).length || hasBinaryAnim(rec)) animSlides++;
    if (deep(rec, 0x2ee0).length) gap("comments");
    if (autoNumbered(rec)) gap("autoNum");
    const layout = layoutOf(m);
    const rels = [`<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${layout}.xml"/>`, ...out.rels];
    // (the master's shapes drawn on the slide itself in its own colours: none from the master)
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}${hidden ? ' show="0"' : ""}${showMaster && !ownScheme ? "" : ' showMasterSp="0"'}><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${out.xml.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transition}</p:sld>`;
    const n = slides.length + 1;
    put(`ppt/slides/slide${n}.xml`, xml);
    put(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(rels));
    slides.push({ at: sl.at, notes: notesBy.get(sl.at) || undefined });
  });
  if (animSlides) gap("anim", animSlides);
  if (!slides.length) throw new Error("ppt: no slides");

  // masters and layouts
  for (const [part, m] of [...masterParts.entries()].sort((a, b) => a[0] - b[0])) {
    const e: Env = { scheme: m.scheme, styles: m.styles, groups: [], slideNo: firstNo, master: true, hf: hfOf(docHF), mst: null };
    const out: Out = { xml: [], rels: [], ids: 1 };
    drawing(m.rec, e, out, true, false);
    const lays = [...layoutsOf.values()].filter((l) => l.master.part === part);
    const rels = [...lays.map((l) => `<Relationship Id="rIdY${l.file}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${l.file}.xml"/>`), `<Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme${part}.xml"/>`, ...out.rels];
    const sty = (type: number, levels: number) => Array.from({ length: levels }, (_, i) => lvlXml(m.styles.of(type, i), i, m.scheme, fontOf)).join("");
    const txStyles = `<p:txStyles><p:titleStyle>${sty(0, 1)}</p:titleStyle><p:bodyStyle>${sty(1, 5)}</p:bodyStyle><p:otherStyle>${sty(4, 5)}</p:otherStyle></p:txStyles>`;
    const ids = lays.map((l, i) => `<p:sldLayoutId id="${2147483649 + part * 100 + i}" r:id="rIdY${l.file}"/>`).join("");
    put(`ppt/slideMasters/slideMaster${part}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${NS}><p:cSld>${bgXml(m.bg, e, out)}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${out.xml.join("")}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst>${txStyles}</p:sldMaster>`);
    put(`ppt/slideMasters/_rels/slideMaster${part}.xml.rels`, relsXml(rels));
    const titleFont = fontOf(m.styles.of(0, 0).cf.font), bodyFont = fontOf(m.styles.of(1, 0).cf.font);
    const eaTitle = fontOf(m.styles.of(0, 0).cf.eaFont ?? m.styles.of(0, 0).cf.font), eaBody = fontOf(m.styles.of(1, 0).cf.eaFont ?? m.styles.of(1, 0).cf.font);
    put(`ppt/theme/theme${part}.xml`, themeXml(m.scheme, [titleFont, eaTitle], [bodyFont, eaBody]));
    for (const l of lays) {
      const le: Env = { ...e, scheme: l.master.scheme, mst: l.master.main };
      const lout: Out = { xml: [], rels: [], ids: 1 };
      if (l.master.main) drawing(l.master.rec, le, lout, true, false);
      const lbg = l.master.main && l.master.bg ? bgXml(l.master.bg, le, lout) : "";
      // a title master that does not show its main master's objects
      const tsa = l.master.main ? kid(l.master.rec, RT.slideAtom) : undefined;
      const hideMain = !!tsa && tsa.body.length >= 22 && !(u16(tsa.body, 20) & 0x1);
      put(`ppt/slideLayouts/slideLayout${l.file}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${NS}${hideMain ? ' showMasterSp="0"' : ""} preserve="1"><p:cSld name="${esc(l.master.main ? t("pptrich.name.titleMaster") : t("pptrich.name.layout"))}">${lbg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${lout.xml.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
      put(`ppt/slideLayouts/_rels/slideLayout${l.file}.xml.rels`, relsXml([`<Relationship Id="rIdM" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster${part}.xml"/>`, ...lout.rels]));
    }
  }
  // presentation
  const firstMaster = [...masterParts.keys()].sort((a, b) => a - b);
  const presRels = [
    ...firstMaster.map((p) => `<Relationship Id="rIdMa${p}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster${p}.xml"/>`),
    ...slides.map((_, i) => `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`),
    `<Relationship Id="rIdTs" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>`,
  ];
  const mainStyles = masterParts.get(firstMaster[0])!;
  const defText = Array.from({ length: 5 }, (_, i) => lvlXml(mainStyles.styles.of(4, i), i, mainStyles.scheme, fontOf)).join("");
  put(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}${firstNo !== 1 ? ` firstSlideNum="${firstNo}"` : ""}><p:sldMasterIdLst>${firstMaster.map((p, i) => `<p:sldMasterId id="${2147483648 + i * 100}" r:id="rIdMa${p}"/>`).join("")}</p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${emu(W)}" cy="${emu(H)}"/><p:notesSz cx="${emu(notesW || 4320)}" cy="${emu(notesH || 5760)}"/><p:defaultTextStyle>${defText}</p:defaultTextStyle></p:presentation>`,
  );
  put("ppt/_rels/presentation.xml.rels", relsXml(presRels));
  put("ppt/tableStyles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="${tableStyleId(0)}">${tableStyles.map((c, i) => `<a:tblStyle styleId="${tableStyleId(i)}" styleName="PPT ${i + 1}"><a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef></a:tcTxStyle><a:tcStyle><a:tcBdr>${c ? `<a:insideH><a:ln><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></a:ln></a:insideH><a:insideV><a:ln><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></a:ln></a:insideV>` : ""}</a:tcBdr></a:tcStyle></a:wholeTbl></a:tblStyle>`).join("")}</a:tblStyleLst>`);
  put("_rels/.rels", relsXml([`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>`]));
  put(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="bmp" ContentType="image/bmp"/><Default Extension="tiff" ContentType="image/tiff"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="wmf" ContentType="image/x-wmf"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
  );
  Object.assign(files, media);
  return { pptx: zipSync(files), slides, atoms, gaps, pictures, tables };
}

// ───────────────────────── shape pieces ─────────────────────────

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const relsXml = (rels: readonly string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
const tableStyleId = (i: number) => `{5C22544A-7EE6-4342-B048-85BDC9FD${(0x1c00 + i).toString(16).toUpperCase().padStart(4, "0")}}`;
const i32ish = (v: number) => (v | 0);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

function fspOf(sp: R): { type: number; flags: number } {
  const f = kid(sp, RT.fsp);
  return f && f.body.length >= 8 ? { type: f.inst, flags: u32(f.body, 4) } : { type: 0, flags: 0 };
}
/** the shape's anchor in master units (a top-level shape's ClientAnchor) or in its group's space (ChildAnchor) */
function anchorOf(sp: R, top: boolean): { x: number; y: number; w: number; h: number } | null {
  const c = kid(sp, top ? RT.clientAnchor : RT.childAnchor) ?? kid(sp, top ? RT.childAnchor : RT.clientAnchor);
  if (!c) return null;
  const b = c.body;
  if (c.type === RT.clientAnchor && b.length === 8) {
    const t0 = i16(b, 0), l = i16(b, 2), r = i16(b, 4), bt = i16(b, 6);
    return { x: l, y: t0, w: r - l, h: bt - t0 };
  }
  if (b.length >= 16) {
    if (c.type === RT.clientAnchor) {
      const t0 = i32(b, 0), l = i32(b, 4), r = i32(b, 8), bt = i32(b, 12);
      return { x: l, y: t0, w: r - l, h: bt - t0 };
    }
    const l = i32(b, 0), t0 = i32(b, 4), r = i32(b, 8), bt = i32(b, 12);
    return { x: l, y: t0, w: r - l, h: bt - t0 };
  }
  return null;
}
/** the box with its rotation and flips; a box turned 45–135° / 225–315° is stored turned by 90° ([MS-ODRAW]) */
function rotBox(a: { x: number; y: number; w: number; h: number }, p: Props, fsp: { flags: number }): Box {
  const rot = ((((fixed(p.v.get(0x4)) ?? 0) % 360) + 360) % 360);
  let { x, y, w, h } = a;
  if ((rot >= 45 && rot < 135) || (rot >= 225 && rot < 315)) {
    const cx = x + w / 2, cy = y + h / 2;
    [w, h] = [h, w];
    x = cx - w / 2;
    y = cy - h / 2;
  }
  return { x, y, w, h, rot, flipH: !!(fsp.flags & 0x40), flipV: !!(fsp.flags & 0x80) };
}
function xfrm(b: Box, ch?: { x: number; y: number; w: number; h: number }): string {
  const attrs = `${b.rot ? ` rot="${Math.round(b.rot * 60000)}"` : ""}${b.flipH ? ' flipH="1"' : ""}${b.flipV ? ' flipV="1"' : ""}`;
  const c = ch ? `<a:chOff x="${emu(ch.x)}" y="${emu(ch.y)}"/><a:chExt cx="${emu(ch.w)}" cy="${emu(ch.h)}"/>` : "";
  return `<a:xfrm${attrs}><a:off x="${emu(b.x)}" y="${emu(b.y)}"/><a:ext cx="${Math.max(0, emu(b.w))}" cy="${Math.max(0, emu(b.h))}"/>${c}</a:xfrm>`;
}
/** PlaceholderAtom → PresentationML placeholder type and index */
function phOf(sp: R): { type: string; idx?: string } | null {
  const a = kid(kid(sp, RT.clientData), RT.placeholder);
  if (!a || a.body.length < 6) return null;
  const pos = i32(a.body, 0), id = a.body[4];
  const type = ({ 0x01: "title", 0x02: "body", 0x03: "ctrTitle", 0x04: "subTitle", 0x07: "dt", 0x08: "sldNum", 0x09: "ftr", 0x0a: "hdr", 0x0b: "sldImg", 0x0c: "body", 0x0d: "title", 0x0e: "body", 0x0f: "ctrTitle", 0x10: "subTitle", 0x11: "title", 0x12: "body", 0x13: "obj", 0x14: "chart", 0x15: "tbl", 0x16: "clipArt", 0x17: "dgm", 0x18: "media", 0x19: "obj", 0x1a: "pic" } as Record<number, string>)[id];
  if (!type) return null;
  return { type, ...(pos > 0 && !/^(title|ctrTitle|dt|sldNum|ftr|hdr)$/.test(type) ? { idx: String(pos) } : {}) };
}
function nameOf(p: Props): string {
  const c = p.c.get(0x380);
  if (!c) return "";
  let s = "";
  for (let i = 0; i + 1 < c.length && u16(c, i); i += 2) s += String.fromCharCode(u16(c, i));
  return s;
}
function bodyPr(p: Props, defs: Props, fsp: { type: number }): string {
  const P = (id: number) => p.v.get(id) ?? defs.v.get(id);
  const ins = (id: number, d: number) => Math.round(P(id) ?? d);
  const anchor = P(0x87) ?? 0;
  const a = ["t", "ctr", "b", "t", "ctr", "b", "t", "ctr", "b", "t"][anchor] ?? "t";
  const ctr = anchor >= 3 && anchor <= 5 ? ' anchorCtr="1"' : "";
  const wrap = P(0x85) === 2 ? "none" : "square";
  const fit = flag(p, 0xbf, 0x02) ? "<a:spAutoFit/>" : "";
  void fsp;
  return `<a:bodyPr wrap="${wrap}" lIns="${ins(0x81, 91440)}" tIns="${ins(0x82, 45720)}" rIns="${ins(0x83, 91440)}" bIns="${ins(0x84, 45720)}" anchor="${a}"${ctr} rtlCol="0">${fit}</a:bodyPr>`;
}

/** OfficeArt shape types → DrawingML presets */
const PRST: Record<number, string> = {
  1: "rect", 2: "roundRect", 3: "ellipse", 4: "diamond", 5: "triangle", 6: "rtTriangle", 7: "parallelogram", 8: "trapezoid", 9: "hexagon", 10: "octagon", 11: "plus", 12: "star5", 13: "rightArrow", 14: "rightArrow", 15: "homePlate", 16: "cube", 17: "wedgeRoundRectCallout", 18: "star16", 19: "arc", 20: "line", 21: "plaque", 22: "can", 23: "donut",
  32: "straightConnector1", 33: "bentConnector2", 34: "bentConnector3", 35: "bentConnector4", 36: "bentConnector5", 37: "curvedConnector2", 38: "curvedConnector3", 39: "curvedConnector4", 40: "curvedConnector5",
  41: "callout1", 42: "callout2", 43: "callout3", 44: "accentCallout1", 45: "accentCallout2", 46: "accentCallout3", 47: "borderCallout1", 48: "borderCallout2", 49: "borderCallout3", 50: "accentBorderCallout1", 51: "accentBorderCallout2", 52: "accentBorderCallout3",
  53: "ribbon", 54: "ribbon2", 55: "chevron", 56: "pentagon", 57: "noSmoking", 58: "star8", 59: "star16", 60: "star32", 61: "wedgeRectCallout", 62: "wedgeRoundRectCallout", 63: "wedgeEllipseCallout", 64: "wave", 65: "foldedCorner", 66: "leftArrow", 67: "downArrow", 68: "upArrow", 69: "leftRightArrow", 70: "upDownArrow", 71: "irregularSeal1", 72: "irregularSeal2", 73: "lightningBolt", 74: "heart", 75: "rect", 76: "quadArrow",
  77: "leftArrowCallout", 78: "rightArrowCallout", 79: "upArrowCallout", 80: "downArrowCallout", 81: "leftRightArrowCallout", 82: "upDownArrowCallout", 83: "quadArrowCallout", 84: "bevel", 85: "leftBracket", 86: "rightBracket", 87: "leftBrace", 88: "rightBrace", 89: "leftUpArrow", 90: "bentUpArrow", 91: "bentArrow", 92: "star24", 93: "stripedRightArrow", 94: "notchedRightArrow", 95: "blockArc", 96: "smileyFace", 97: "verticalScroll", 98: "horizontalScroll", 99: "circularArrow", 101: "uturnArrow", 102: "curvedRightArrow", 103: "curvedLeftArrow", 104: "curvedUpArrow", 105: "curvedDownArrow", 106: "cloudCallout", 107: "ellipseRibbon", 108: "ellipseRibbon2",
  109: "flowChartProcess", 110: "flowChartDecision", 111: "flowChartInputOutput", 112: "flowChartPredefinedProcess", 113: "flowChartInternalStorage", 114: "flowChartDocument", 115: "flowChartMultidocument", 116: "flowChartTerminator", 117: "flowChartPreparation", 118: "flowChartManualInput", 119: "flowChartManualOperation", 120: "flowChartConnector", 121: "flowChartPunchedCard", 122: "flowChartPunchedTape", 123: "flowChartSummingJunction", 124: "flowChartOr", 125: "flowChartCollate", 126: "flowChartSort", 127: "flowChartExtract", 128: "flowChartMerge", 129: "flowChartOfflineStorage", 130: "flowChartOnlineStorage", 131: "flowChartMagneticTape", 132: "flowChartMagneticDisk", 133: "flowChartMagneticDrum", 134: "flowChartDisplay", 135: "flowChartDelay",
  176: "flowChartAlternateProcess", 177: "flowChartOffpageConnector", 178: "callout1", 179: "accentCallout1", 180: "borderCallout1", 181: "accentBorderCallout1", 182: "leftRightUpArrow", 183: "sun", 184: "moon", 185: "bracketPair", 186: "bracePair", 187: "star4", 188: "doubleWave",
  189: "actionButtonBlank", 190: "actionButtonHome", 191: "actionButtonHelp", 192: "actionButtonInformation", 193: "actionButtonForwardNext", 194: "actionButtonBackPrevious", 195: "actionButtonEnd", 196: "actionButtonBeginning", 197: "actionButtonReturn", 198: "actionButtonDocument", 199: "actionButtonSound", 200: "actionButtonMovie", 202: "rect",
};

/** the preset (or freeform) geometry of a shape, adjust values converted where their meaning is known */
function geomXml(spt: number, p: Props, box: Box, gap: (g: Gap, n?: number) => void): string {
  const adj = [0x147, 0x148, 0x149, 0x14a].map((k) => p.v.get(k));
  const hasAdj = adj.some((v) => v !== undefined);
  const verts = p.c.get(0x145);
  if ((spt === 0 || spt === 100) && verts) {
    const g = freeformXml(p, gap);
    if (g) return g;
  }
  const prst = PRST[spt];
  if (!prst) {
    gap("shape");
    return `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
  }
  const w = Math.abs(box.w) || 1, h = Math.abs(box.h) || 1, ss = Math.min(w, h);
  const gd = (n: string, v: number) => `<a:gd name="${n}" fmla="val ${Math.round(v)}"/>`;
  let av = "";
  const a0 = (d: number) => (adj[0] ?? d) | 0, a1 = (d: number) => (adj[1] ?? d) | 0;
  switch (spt) {
    case 2:
      av = gd("adj", (a0(3600) / 21600) * 100000);
      break;
    case 13:
    case 14:
      av = gd("adj1", ((21600 - 2 * a1(5400)) / 21600) * 100000) + gd("adj2", (((21600 - a0(16200)) / 21600) * w * 100000) / ss);
      break;
    case 66:
      av = gd("adj1", ((21600 - 2 * a1(5400)) / 21600) * 100000) + gd("adj2", ((a0(5400) / 21600) * w * 100000) / ss);
      break;
    case 68:
      av = gd("adj1", ((21600 - 2 * a1(5400)) / 21600) * 100000) + gd("adj2", ((a0(5400) / 21600) * h * 100000) / ss);
      break;
    case 67:
      av = gd("adj1", ((21600 - 2 * a1(5400)) / 21600) * 100000) + gd("adj2", (((21600 - a0(16200)) / 21600) * h * 100000) / ss);
      break;
    case 55:
    case 15:
      av = gd("adj", (((21600 - a0(16200)) / 21600) * w * 100000) / ss);
      break;
    case 5:
      av = gd("adj", (a0(10800) / 21600) * 100000);
      break;
    case 7:
    case 9:
    case 11:
    case 22:
    case 23:
      av = gd("adj", ((a0(5400) / 21600) * (spt === 7 ? w : spt === 9 ? w : ss) * 100000) / ss);
      break;
    default:
      if (hasAdj) gap("adjust");
  }
  return `<a:prstGeom prst="${prst}"><a:avLst>${av}</a:avLst></a:prstGeom>`;
}

/** pVertices / pSegmentInfo ([MS-ODRAW] 2.3.6) → a:custGeom in the geometry's own space */
function freeformXml(p: Props, gap: (g: Gap, n?: number) => void): string | null {
  const vb = p.c.get(0x145);
  if (!vb || vb.length < 6) return null;
  const n = u16(vb, 0), cb = u16(vb, 4);
  const size = cb === 0xfff0 ? 4 : cb;
  if (size !== 4 && size !== 8) return null;
  const pts: [number, number][] = [];
  for (let k = 0; k < n && 6 + (k + 1) * size <= vb.length; k++) {
    const o = 6 + k * size;
    pts.push(size === 4 ? [i16(vb, o), i16(vb, o + 2)] : [i32(vb, o), i32(vb, o + 4)]);
  }
  const l = (p.v.get(0x140) ?? 0) | 0, tp = (p.v.get(0x141) ?? 0) | 0, r = (p.v.get(0x142) ?? 21600) | 0, b = (p.v.get(0x143) ?? 21600) | 0;
  const W = Math.max(1, r - l), H = Math.max(1, b - tp);
  const pt = (k: number) => {
    const q = pts[Math.min(k, pts.length - 1)] ?? [0, 0];
    return `<a:pt x="${q[0] - l}" y="${q[1] - tp}"/>`;
  };
  const sb = p.c.get(0x146);
  const cmds: string[] = [];
  let noFill = false, arcs = false;
  let k = 0;
  if (!sb || sb.length < 6) {
    cmds.push(`<a:moveTo>${pt(0)}</a:moveTo>`);
    for (k = 1; k < pts.length; k++) cmds.push(`<a:lnTo>${pt(k)}</a:lnTo>`);
  } else {
    const ns = u16(sb, 0), cs = u16(sb, 4) === 0xfff0 ? 2 : u16(sb, 4);
    if (cs !== 2) return null;
    // (each vertex used once: line and curve segments stop at the last vertex — QA 2026-11-21: counts of 8191 in each of
    // 65535 segments wrote hundreds of millions of commands)
    for (let j = 0; j < ns && 6 + (j + 1) * 2 <= sb.length; j++) {
      const seg = u16(sb, 6 + j * 2);
      const type = seg >> 13;
      const cnt = seg & 0x1fff;
      if (type === 0) for (let c = 0; c < Math.max(1, cnt) && k < pts.length; c++) cmds.push(`<a:lnTo>${pt(k++)}</a:lnTo>`);
      else if (type === 1) for (let c = 0; c < Math.max(1, cnt) && k < pts.length; c++) cmds.push(`<a:cubicBezTo>${pt(k++)}${pt(k++)}${pt(k++)}</a:cubicBezTo>`);
      else if (type === 2) cmds.push(`<a:moveTo>${pt(k++)}</a:moveTo>`);
      else if (type === 3) cmds.push("<a:close/>");
      else if (type === 4) continue;
      else if (type === 5) {
        const esc = (seg >> 8) & 0x1f, vc = seg & 0xff;
        if (esc === 0x0a) noFill = true;
        else if (esc === 0x09) for (let c = 0; c + 1 < vc && k < pts.length; c += 2) cmds.push(`<a:quadBezTo>${pt(k++)}${pt(k++)}</a:quadBezTo>`);
        else if (vc) {
          // arcs and the rest: to their last point in a line
          if (esc >= 1 && esc <= 8) arcs = true;
          k += vc;
          cmds.push(`<a:lnTo>${pt(k - 1)}</a:lnTo>`);
        }
      }
    }
  }
  if (arcs) gap("freeform");
  if (!cmds.length || !cmds[0].startsWith("<a:moveTo>")) cmds.unshift(`<a:moveTo>${pt(0)}</a:moveTo>`);
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}"${noFill ? ' fill="none"' : ""}>${cmds.join("")}</a:path></a:pathLst></a:custGeom>`;
}

const DASH = ["solid", "sysDash", "sysDot", "sysDashDot", "sysDashDotDot", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot"];
function lineXml(P: (id: number) => number | undefined, cc: ColorCtx, gap: (g: Gap, n?: number) => void): string {
  const w = P(0x1cb) ?? 9525;
  const c = colorRef(P(0x1c0) ?? 0x08000001, cc) ?? "000000";
  const op = fixed(P(0x1c1));
  if (op !== undefined && op < 1) gap("alpha");
  const dash = P(0x1ce) ?? 0;
  if (P(0x1d0) || P(0x1d1)) gap("arrow");
  const ends = (P(0x1d0) ? '<a:headEnd type="triangle"/>' : "") + (P(0x1d1) ? '<a:tailEnd type="triangle"/>' : "");
  return `<a:ln w="${Math.round(w)}"><a:solidFill><a:srgbClr val="${c}">${op !== undefined && op < 1 ? `<a:alpha val="${Math.round(op * 100000)}"/>` : ""}</a:srgbClr></a:solidFill>${dash ? `<a:prstDash val="${DASH[dash] ?? "dash"}"/>` : ""}${ends}</a:ln>`;
}
function shadowXml(P: (id: number) => number | undefined, cc: ColorCtx): string {
  const c = colorRef(P(0x201) ?? 0x00808080, cc) ?? "808080";
  const dx = (P(0x205) ?? 25400) | 0, dy = (P(0x206) ?? 25400) | 0;
  const op = fixed(P(0x204)) ?? 1;
  const dist = Math.round(Math.hypot(dx, dy)), dir = Math.round((((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) * 60000);
  return `<a:effectLst><a:outerShdw dist="${dist}" dir="${dir}" algn="tl" rotWithShape="0"><a:srgbClr val="${c}"><a:alpha val="${Math.round(op * 100000)}"/></a:srgbClr></a:outerShdw></a:effectLst>`;
}

// ───────────────────────── text pieces ─────────────────────────

const LANG: Record<number, string> = { 0x0412: "ko-KR", 0x0409: "en-US", 0x0411: "ja-JP", 0x0804: "zh-CN", 0x0404: "zh-TW", 0x0809: "en-GB", 0x0407: "de-DE", 0x040c: "fr-FR" };
const ALGN = ["l", "ctr", "r", "just", "dist", "thaiDist", "justLow"];
const spc = (v: number | undefined) => (v === undefined ? "" : v >= 0 ? `<a:spcPct val="${v * 1000}"/>` : `<a:spcPts val="${Math.round((-v / 8) * 100)}"/>`);

function rprXml(cf: CF, scheme: Scheme, fontOf: (r?: number) => string, lid: number | undefined, gap: (g: Gap, n?: number) => void, tag = "a:rPr"): string {
  if (cf.shadow || cf.emboss) gap("textFx");
  const a = [`lang="${(lid && LANG[lid]) || "ko-KR"}"`, `sz="${Math.round((cf.size ?? 18) * 100)}"`, `b="${cf.bold ? 1 : 0}"`, `i="${cf.italic ? 1 : 0}"`];
  if (cf.underline) a.push('u="sng"');
  if (cf.position) a.push(`baseline="${cf.position * 1000}"`);
  const c = colHex(cf.color, scheme) ?? scheme[1] ?? "000000";
  const latin = fontOf(cf.font), ea = fontOf(cf.eaFont ?? cf.font);
  return `<${tag} ${a.join(" ")} dirty="0"><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:latin typeface="${esc(latin)}"/><a:ea typeface="${esc(ea)}"/></${tag}>`;
}

/** a paragraph's a:pPr, everything explicit */
function pprXml(pf: PF, lvl: number, cf: CF, scheme: Scheme, fontOf: (r?: number) => string, tag = "a:pPr", defRPr = ""): string {
  const lm = pf.leftMargin ?? 0, ind = pf.indent ?? 0;
  const at = [`marL="${emu(lm)}"`, `indent="${emu(ind - lm)}"`, `algn="${ALGN[pf.align ?? 0] ?? "l"}"`];
  if (tag === "a:pPr" && lvl) at.push(`lvl="${lvl}"`);
  if (pf.defTab) at.push(`defTabSz="${emu(pf.defTab)}"`);
  if (pf.charWrap !== undefined) at.push(`eaLnBrk="${pf.charWrap ? 1 : 0}"`);
  if (pf.wordWrap !== undefined) at.push(`latinLnBrk="${pf.wordWrap ? 0 : 1}"`);
  if (pf.overflow !== undefined) at.push(`hangingPunct="${pf.overflow ? 1 : 0}"`);
  let kids = `<a:lnSpc>${spc(pf.lineSpacing ?? 100)}</a:lnSpc><a:spcBef>${spc(pf.spaceBefore ?? 0)}</a:spcBef><a:spcAft>${spc(pf.spaceAfter ?? 0)}</a:spcAft>`;
  if (pf.hasBullet) {
    const c = pf.bulletHasColor ? colHex(pf.bulletColor, scheme) : undefined;
    if (c) kids += `<a:buClr><a:srgbClr val="${c}"/></a:buClr>`;
    if (pf.bulletHasSize && pf.bulletSize) kids += pf.bulletSize > 0 ? `<a:buSzPct val="${pf.bulletSize * 1000}"/>` : `<a:buSzPts val="${-pf.bulletSize * 100}"/>`;
    kids += pf.bulletHasFont && pf.bulletFont !== undefined ? `<a:buFont typeface="${esc(fontOf(pf.bulletFont))}"/>` : "<a:buFontTx/>";
    kids += `<a:buChar char="${esc(String.fromCharCode(pf.bulletChar || 0x2022))}"/>`;
  } else kids += "<a:buNone/>";
  if (pf.tabs?.length) kids += `<a:tabLst>${pf.tabs.map((x) => `<a:tab pos="${emu(x.pos)}" algn="${["l", "ctr", "r", "dec"][x.type] ?? "l"}"/>`).join("")}</a:tabLst>`;
  void cf;
  return `<${tag} ${at.join(" ")}>${kids}${defRPr}</${tag}>`;
}
/** a level of a master text style as a:lvlNpPr */
function lvlXml(l: Lvl, i: number, scheme: Scheme, fontOf: (r?: number) => string): string {
  const def = rprXml(l.cf, scheme, fontOf, undefined, () => {}, "a:defRPr");
  return pprXml(l.pf, i, l.cf, scheme, fontOf, `a:lvl${i + 1}pPr`, def);
}

function themeXml(s: Scheme, major: [string, string], minor: [string, string]): string {
  const c = (n: string, v: string) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  const scheme = c("dk1", s[1]) + c("lt1", s[0]) + c("dk2", s[3]) + c("lt2", s[2]) + c("accent1", s[4]) + c("accent2", s[5]) + c("accent3", s[6]) + c("accent4", s[7]) + c("accent5", s[4]) + c("accent6", s[5]) + c("hlink", s[6]) + c("folHlink", s[7]);
  const font = (f: [string, string]) => `<a:latin typeface="${esc(f[0])}"/><a:ea typeface="${esc(f[1])}"/><a:cs typeface=""/>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PPT"><a:themeElements><a:clrScheme name="PPT">${scheme}</a:clrScheme><a:fontScheme name="PPT"><a:majorFont>${font(major)}</a:majorFont><a:minorFont>${font(minor)}</a:minorFont></a:fontScheme><a:fmtScheme name="PPT"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst><a:lnStyleLst><a:ln w="9525">${solid}</a:ln><a:ln w="12700">${solid}</a:ln><a:ln w="19050">${solid}</a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

/** whether a slide's PowerPoint 2000 text extensions (StyleTextProp9Atom) number a paragraph automatically */
function autoNumbered(rec: R): boolean {
  for (const data of deep(rec, 0x138b)) {
    for (const r of recsIn(data.body, 0, data.body.length, 1)) {
      if (r.type !== 0x0fac) continue;
      // TextPFException9: masks, bulletBlipRef (0x800000), fBulletHasAutoNumber (0x2000000)
      const b = r.body;
      if (b.length < 6) continue;
      const m = u32(b, 0);
      const p = 4 + (m & 0x800000 ? 2 : 0);
      if (m & 0x2000000 && p + 2 <= b.length && u16(b, p)) return true;
    }
  }
  return false;
}

/** whether a slide holds PowerPoint 2002+ animation (PPT10 binary tag: an extended time node container) */
function hasBinaryAnim(rec: R): boolean {
  for (const tag of deep(rec, 0x138a)) {
    const nm = kid(tag, RT.cString);
    let s = "";
    if (nm) for (let i = 0; i + 1 < nm.body.length; i += 2) s += String.fromCharCode(u16(nm.body, i));
    const data = kid(tag, 0x138b);
    if (s === "___PPT10" && data && data.body.length > 8) {
      // BinaryTagDataBlob: its records; an ExtTimeNodeContainer (0xF144) is animation
      for (let o = 0; o + 8 <= data.body.length; ) {
        const type = u16(data.body, o + 2), len = u32(data.body, o + 4);
        if (type === 0xf144) return true;
        o += 8 + len;
      }
    }
  }
  return false;
}

// ───────────────────────── pictures ─────────────────────────

/**
 * An EMF / WMF BLIP ([MS-ODRAW] 2.2.24 / 2.2.25): one or two UIDs, the OfficeArtMetafileHeader (uncompressed size,
 * bounds, size in EMUs, saved size, compression), then the metafile — DEFLATE-compressed (zlib) or as it is. A WMF
 * gets its placeable header back (the binary file keeps it without one); drawn through render/picDecode.ts.
 */
function metafileBlip(b: R): Pic | null {
  const emf = b.type === 0xf01a;
  const o = 16 + (b.inst === (emf ? 0x3d5 : 0x217) ? 16 : 0);
  if (b.body.length < o + 34) return null;
  const size = u32(b.body, o), saved = u32(b.body, o + 28), comp = b.body[o + 32];
  const i32 = (at: number) => u32(b.body, at) | 0;
  const l = i32(o + 4), t = i32(o + 8), r = i32(o + 12), bt = i32(o + 16), cx = i32(o + 20);
  const raw = b.body.subarray(o + 34, Math.min(b.body.length, o + 34 + (saved || b.body.length)));
  if (size > 64 << 20) return null;
  let data: Uint8Array;
  if (comp === 0) {
    try {
      data = unzlibSync(raw, { out: new Uint8Array(size) });
    } catch {
      try {
        data = inflateSync(raw, { out: new Uint8Array(size) });
      } catch {
        return null;
      }
    }
  } else data = raw;
  if (emf) return metafileKind(data) === "emf" ? { bytes: data, ext: "emf", mime: "image/x-emf" } : null;
  if (metafileKind(data) !== "wmf") return null;
  if (data[0] === 0xd7 && data[1] === 0xcd) return { bytes: data, ext: "wmf", mime: "image/x-wmf" };
  const fit = (v: number) => Math.max(-32768, Math.min(32767, v));
  const w = r - l, inch = w > 0 && cx > 0 ? w / (cx / 914400) : 1440;
  return { bytes: wmfPlaceable(data, fit(l), fit(t), fit(r), fit(bt), inch), ext: "wmf", mime: "image/x-wmf" };
}

/** A BLIP record ([MS-ODRAW] 2.2.23 …) as the picture file it holds (null: PICT, or none) */
function decodeBlip(b: R): Pic | null {
  const two = (i: number) => (b.inst === i ? 16 : 0);
  switch (b.type) {
    case 0xf01e: {
      const o = 16 + two(0x6e1) + 1;
      return { bytes: b.body.slice(o), ext: "png", mime: "image/png" };
    }
    case 0xf01d:
    case 0xf02a: {
      const o = 16 + (b.inst === 0x46b || b.inst === 0x6e3 ? 16 : 0) + 1;
      return { bytes: b.body.slice(o), ext: "jpeg", mime: "image/jpeg" };
    }
    case 0xf029: {
      const o = 16 + two(0x6e5) + 1;
      return { bytes: b.body.slice(o), ext: "tiff", mime: "image/tiff" };
    }
    case 0xf01f: {
      // DIB: a BMP file around it
      const o = 16 + two(0x7a9) + 1;
      const dib = b.body.subarray(o);
      if (dib.length < 40) return null;
      const hs = u32(dib, 0), bpp = u16(dib, 14), comp = u32(dib, 16), used = u32(dib, 32);
      const pal = (bpp <= 8 ? used || 1 << bpp : used) * 4 + (comp === 3 && hs === 40 ? 12 : 0);
      const out = new Uint8Array(14 + dib.length);
      out[0] = 0x42;
      out[1] = 0x4d;
      const put32 = (at: number, v: number) => {
        out[at] = v & 0xff;
        out[at + 1] = (v >>> 8) & 0xff;
        out[at + 2] = (v >>> 16) & 0xff;
        out[at + 3] = (v >>> 24) & 0xff;
      };
      put32(2, out.length);
      put32(10, 14 + hs + pal);
      out.set(dib, 14);
      return { bytes: out, ext: "bmp", mime: "image/bmp" };
    }
    case 0xf01a:
    case 0xf01b:
      return metafileBlip(b);
    case 0xf01c:
      return null; // PICT: not shown (named in a notice)
  }
  return null;
}
