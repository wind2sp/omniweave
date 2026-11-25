// PDF Surgeon — redaction (Acrobat ▸ 가리기), text lines, and picture replacement.
//
// Redaction removes what lies under the marked areas from the FILE, not just from view:
//   text       the covered glyphs leave their text-show operations (the others keep their exact positions: a
//              removed glyph becomes a TJ displacement of its own advance), also invisible text (OCR layers) and
//              text inside form XObjects (a form drawn elsewhere too is copied first, so other pages keep theirs)
//   pictures   covered pixels are painted over in the image data (8-bit / 1-bit samples, JPEG through `decodeJpeg`);
//              a picture that cannot be decoded, or an inline image touching a mark, is taken out whole
//   vectors    paths lying entirely inside a mark are no longer painted
//   comments   annotations and form widgets touching a mark are deleted (with their fields)
//   hidden     page thumbnails; optionally the document information, XMP metadata, attachments, scripts, and
//              any ActualText / Alt / comment text that repeats a removed word
// Then the marks are painted (fill colour, overlay text) and the file is written again in full, so the old
// content streams are gone (an incremental update would keep them in the file).

import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFContext, type PDFObject } from "pdf-lib";
import { addContent, displayOf, fontFor, savePdf, type RGB, type Rect } from "./acrobat";
import { dget, dictOf, hiddenOcgs, look, nameOf, numArray, numOf, openSurgeonDoc, pageContent, pageDict, pageResources, streamBytes, toVal, type SurgeonDoc } from "./document";
import { filtersOf, decodeFilters } from "./filters";
import { cloneDict } from "./incremental";
import { analyzePage, type ImageDraw, type PageAnalysis, type PathPaint, type StreamUnit, type TextShow } from "./interpret";
import { I, apply, inv, mul, toM, type M } from "./matrix";
import { PdfDict, PdfName, PdfStr, latin1, parseOps, serialize, type PdfVal } from "./syntax";

export interface RedactMark {
  page: number;
  rect: Rect;
}

export interface RedactOptions {
  /** the box painted over each mark (null: nothing painted, the area is left empty) */
  fill?: RGB | null;
  /** text written in each box (Acrobat's overlay text) */
  overlay?: string;
  overlayColor?: RGB;
  overlaySize?: number;
  font?: () => Promise<Uint8Array>;
  /** remove document information, XMP metadata, attachments and scripts too (Acrobat: 숨겨진 정보 제거) */
  scrubMetadata?: boolean;
  /** words searched for: also taken out of bookmarks, comments and alternate texts */
  terms?: string[];
  /** a JPEG's pixels (RGBA) for painting; without it a covered JPEG is removed */
  decodeJpeg?: (bytes: Uint8Array) => Promise<{ width: number; height: number; data: Uint8Array | Uint8ClampedArray } | null>;
}

export interface RedactReport {
  pages: number;
  glyphs: number;
  images: number;
  imagesRemoved: number;
  paths: number;
  /** paths and gradients partly under a mark, clipped to paint outside it */
  pathsCut: number;
  /** text shows inside tiling patterns that lost glyphs */
  patterns: number;
  annots: number;
  removedText: string[];
  notes: string[];
}

// ───────── glyph boxes and text lines ─────────

export interface GlyphBox {
  ch: string;
  box: Rect;
}

/** The strings and TJ displacements an operation shows. */
const showStrings = (u: StreamUnit, s: TextShow): PdfVal[] => {
  const { op, args } = u.ops[s.op];
  return op === "TJ" ? (Array.isArray(args[0]) ? args[0] : []) : op === '"' ? args.slice(2, 3) : args.slice(0, 1);
};
/** Vertical writing (Identity-V and other -V CMaps): the interpreter lays glyphs out across; they go down. */
const isVertical = (s: TextShow) => s.font.unsupported === "vertical";

/**
 * Glyphs of vertical text, from the show's own strings: each glyph's em square hangs below the current point
 * (vertical origin at the top centre, default vertical metrics: advance one em down, ISO 32000-1 §9.7.4.3).
 */
function verticalBoxes(s: TextShow, u: StreamUnit): GlyphBox[] {
  const fs = s.fontSize || 0;
  const out: GlyphBox[] = [];
  let y = 0, gi = 0;
  const box = (x0: number, y0: number, x1: number, y1: number): Rect => {
    const pts = [apply(s.start, x0, y0), apply(s.start, x1, y0), apply(s.start, x0, y1), apply(s.start, x1, y1)];
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  };
  for (const v of showStrings(u, s)) {
    if (typeof v === "number") {
      y += (-v / 1000) * fs;
      continue;
    }
    if (!(v instanceof PdfStr)) continue;
    for (const { code, len } of s.font.codes(v.bytes)) {
      out.push({ ch: s.glyphs[gi++]?.ch ?? "", box: box(-0.5 * fs, y - fs, 0.5 * fs, y) });
      y += -fs + s.tc + (code === 32 && len === 1 ? s.tw : 0);
    }
  }
  return out;
}

/** Axis-aligned box of each glyph of a show in user space (baseline … ascent, a little descent). */
export function glyphBoxes(s: TextShow, u?: StreamUnit): GlyphBox[] {
  if (u && isVertical(s)) return verticalBoxes(s, u);
  const up = [s.start[2], s.start[3]];
  const k = Math.hypot(up[0], up[1]) || 1;
  const size = Math.abs(s.fontSize) * k;
  const ux = (up[0] / k) * size, uy = (up[1] / k) * size;
  return s.glyphs.map((g) => {
    const pts = [
      [g.x0 - ux * 0.22, g.y0 - uy * 0.22],
      [g.x1 - ux * 0.22, g.y1 - uy * 0.22],
      [g.x0 + ux * 0.88, g.y0 + uy * 0.88],
      [g.x1 + ux * 0.88, g.y1 + uy * 0.88],
    ];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { ch: g.ch, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Rect };
  });
}

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const area = (a: Rect) => Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
const norm = (r: Rect): Rect => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
/** a glyph is redacted when a third of it is covered, or its centre is */
function glyphHit(g: Rect, marks: Rect[]): boolean {
  const cx = (g[0] + g[2]) / 2, cy = (g[1] + g[3]) / 2;
  const a = area(g);
  return marks.some((m) => (cx >= m[0] && cx <= m[2] && cy >= m[1] && cy <= m[3]) || (a > 0 && overlap(g, m) >= a / 3));
}

function analyze(sd: SurgeonDoc, i: number): PageAnalysis {
  return analyzePage(sd, I, pageResources(sd, i), pageContent(sd, i), hiddenOcgs(sd));
}

export interface TextLine {
  text: string;
  /** font size in user space */
  size: number;
  box: Rect;
  glyphs: GlyphBox[];
}

/** The page's text as lines (top to bottom, left to right), with each glyph's box — for search, TOC and compare. */
export function textLines(sd: SurgeonDoc, i: number): TextLine[] {
  const a = analyze(sd, i);
  type G = GlyphBox & { y: number; h: number; size: number };
  const gs: G[] = [];
  for (const it of a.items) {
    if (it.kind !== "text") continue;
    const k = Math.hypot(it.start[2], it.start[3]) || 1;
    for (const g of glyphBoxes(it, a.units.get(it.unit))) gs.push({ ...g, y: (g.box[1] + g.box[3]) / 2, h: g.box[3] - g.box[1], size: Math.abs(it.fontSize) * k });
  }
  gs.sort((p, q) => q.y - p.y || p.box[0] - q.box[0]);
  const lines: G[][] = [];
  for (const g of gs) {
    const l = lines.find((x) => Math.abs(x[0].y - g.y) < Math.max(1.5, Math.min(x[0].h, g.h) * 0.45));
    if (l) l.push(g);
    else lines.push([g]);
  }
  return lines
    .map((l) => {
      l.sort((p, q) => p.box[0] - q.box[0]);
      let text = "";
      let prev: G | null = null;
      for (const g of l) {
        // a gap wider than a third of the type is a space the file did not write
        if (prev && g.box[0] - prev.box[2] > g.size * 0.3 && !text.endsWith(" ") && g.ch !== " ") text += " ";
        text += g.ch;
        prev = g;
      }
      const box = l.reduce((b, g) => union(b, g.box), l[0].box);
      return { text, size: Math.max(...l.map((g) => g.size)), box, glyphs: l };
    })
    .sort((p, q) => q.box[3] - p.box[3]);
}

/** Areas of every match of `pattern` (text or RegExp) on the page: one rectangle per line part. */
export function findTextRects(sd: SurgeonDoc, i: number, pattern: string | RegExp, o: { caseSensitive?: boolean; wholeWord?: boolean } = {}): { text: string; rects: Rect[] }[] {
  const out: { text: string; rects: Rect[] }[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const src = typeof pattern === "string" ? esc(pattern).replace(/\s+/g, "\\s*") : pattern.source;
  if (!src) return out;
  const flags = "g" + ((typeof pattern === "string" ? !o.caseSensitive : pattern.flags.includes("i")) ? "i" : "") + "u";
  const re = new RegExp(o.wholeWord && typeof pattern === "string" ? `(?<![\\p{L}\\p{N}])${src}(?![\\p{L}\\p{N}])` : src, flags);
  for (const l of textLines(sd, i)) {
    // the line text without the added spaces, mapped to glyphs
    let s = "";
    const map: number[] = [];
    l.glyphs.forEach((g, gi) => {
      const ch = g.ch || " ";
      for (let k = 0; k < ch.length; k++) {
        s += ch[k];
        map.push(gi);
      }
    });
    for (const m of s.matchAll(re)) {
      if (!m[0]) continue;
      const a = map[m.index!], b = map[m.index! + m[0].length - 1];
      if (a === undefined || b === undefined) continue;
      let r: Rect | null = null;
      for (let k = a; k <= b; k++) r = r ? union(r, l.glyphs[k].box) : l.glyphs[k].box;
      if (r) out.push({ text: m[0], rects: [r] });
    }
  }
  return out;
}

/** Search every page (Acrobat's 텍스트 찾아 가리기): page, matched text, rectangles. */
export async function searchRedactions(bytes: Uint8Array, pattern: string | RegExp, o: { caseSensitive?: boolean; wholeWord?: boolean } = {}): Promise<{ page: number; text: string; rect: Rect }[]> {
  const sd = await openSurgeonDoc(bytes);
  const out: { page: number; text: string; rect: Rect }[] = [];
  for (let i = 0; i < sd.pageRefs.length; i++) for (const m of findTextRects(sd, i, pattern, o)) for (const r of m.rects) out.push({ page: i, text: m.text, rect: r });
  return out;
}

/** Every page's text lines (for bookmarks from the table of contents, comparison, form detection). */
export async function documentLines(bytes: Uint8Array): Promise<TextLine[][]> {
  const sd = await openSurgeonDoc(bytes);
  return sd.pageRefs.map((_, i) => {
    try {
      return textLines(sd, i);
    } catch {
      return [];
    }
  });
}

// ───────── rewriting content streams ─────────

const enc = new TextEncoder();

/** The unit's bytes with some operations replaced (index → new text; "" removes it). */
function rewriteUnit(u: StreamUnit, edits: Map<number, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const i of [...edits.keys()].sort((a, b) => a - b)) {
    const op = u.ops[i];
    parts.push(u.bytes.subarray(pos, op.s), enc.encode(" " + edits.get(i)! + " "));
    pos = op.e;
  }
  parts.push(u.bytes.subarray(pos));
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

/** A text show without the glyphs `drop` (indices into show.glyphs): the rest keep their places. */
function showWithout(u: StreamUnit, s: TextShow, drop: Set<number>): string {
  const { op, args } = u.ops[s.op];
  const strs = showStrings(u, s);
  const vertical = isVertical(s);
  const out: PdfVal[] = [];
  let buf: number[] = [];
  let gi = 0;
  const flush = () => {
    if (buf.length) out.push(new PdfStr(new Uint8Array(buf), true));
    buf = [];
  };
  const push = (n: number) => {
    flush();
    const last = out[out.length - 1];
    if (typeof last === "number") out[out.length - 1] = last + n;
    else out.push(n);
  };
  for (const v of strs) {
    if (typeof v === "number") {
      push(v);
      continue;
    }
    if (!(v instanceof PdfStr)) continue;
    let at = 0;
    for (const { code, len } of s.font.codes(v.bytes)) {
      const bytes = v.bytes.subarray(at, at + len);
      at += len;
      if (drop.has(gi++)) {
        // the glyph's own advance as a displacement (TJ numbers move down in vertical writing)
        const spacing = s.tc + (code === 32 && len === 1 ? s.tw : 0);
        const adv = vertical ? -s.fontSize + spacing : s.font.advance(code) * s.fontSize + spacing;
        if (s.fontSize) push((-adv * 1000) / s.fontSize);
      } else buf.push(...bytes);
    }
  }
  flush();
  const tj = `${serialize(out.map((x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x)))} TJ`;
  if (op === "'") return `T* ${tj}`;
  if (op === '"') return `${serialize(args[0] ?? 0)} Tw ${serialize(args[1] ?? 0)} Tc T* ${tj}`;
  return tj;
}

/** An operation exactly as written in its stream. */
const opText = (u: StreamUnit, i: number) => latin1(u.bytes, u.ops[i].s, u.ops[i].e);

/**
 * A clip that keeps everything but the marks (even-odd: a huge square with the marks cut out), in the local space
 * of the CTM `m` — the operations that follow paint only outside the marks.
 */
function clipOut(m: M, rects: Rect[]): string | null {
  const toLocal = inv(m);
  if (!toLocal || !rects.length) return null;
  const poly = (r: Rect) => {
    const pts = [apply(toLocal, r[0], r[1]), apply(toLocal, r[2], r[1]), apply(toLocal, r[2], r[3]), apply(toLocal, r[0], r[3])];
    return `${pts.map((p, k) => `${p[0].toFixed(3)} ${p[1].toFixed(3)} ${k ? "l" : "m"}`).join(" ")} h`;
  };
  const big = 1e5;
  return `${poly([-big, -big, big, big])} ${rects.map(poly).join(" ")} W* n`;
}

/** The subpaths of a path in user space, curves flattened (about a quarter point apart). */
function flattenPath(p: PathPaint): { pts: [number, number][]; closed: boolean }[] {
  const out: { pts: [number, number][]; closed: boolean }[] = [];
  let cur: { pts: [number, number][]; closed: boolean } | null = null;
  const at = (x: number, y: number) => apply(p.base, x, y) as [number, number];
  for (const sg of p.segs) {
    if (sg.op === "m") {
      cur = { pts: [at(sg.pts[0], sg.pts[1])], closed: false };
      out.push(cur);
    } else if (sg.op === "l" && cur) cur.pts.push(at(sg.pts[0], sg.pts[1]));
    else if (sg.op === "c" && cur) {
      const p0 = cur.pts[cur.pts.length - 1], p1 = at(sg.pts[0], sg.pts[1]), p2 = at(sg.pts[2], sg.pts[3]), p3 = at(sg.pts[4], sg.pts[5]);
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
      const n = Math.max(4, Math.min(200, Math.ceil(len / 0.5)));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        cur.pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
      }
    } else if (sg.op === "h" && cur) {
      cur.closed = true;
      cur = { pts: [cur.pts[0]], closed: false }; // a path going on after h starts at the closed subpath's start
      out.push(cur);
    }
  }
  return out.filter((s) => s.pts.length > 1);
}

/** The parts of segment a→b outside every rectangle (parameter intervals cut by Liang–Barsky). */
function segmentOutside(a: [number, number], b: [number, number], rects: Rect[]): [[number, number], [number, number]][] {
  let parts: [number, number][] = [[0, 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const r of rects) {
    let t0 = 0, t1 = 1;
    const clip = (pp: number, q: number) => {
      if (pp === 0) return q >= 0;
      const t = q / pp;
      if (pp < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
      return true;
    };
    if (!(clip(-dx, a[0] - r[0]) && clip(dx, r[2] - a[0]) && clip(-dy, a[1] - r[1]) && clip(dy, r[3] - a[1])) || t1 <= t0) continue;
    parts = parts.flatMap(([s, e]): [number, number][] => {
      const out: [number, number][] = [];
      if (t0 > s) out.push([s, Math.min(e, t0)]);
      if (t1 < e) out.push([Math.max(s, t1), e]);
      return out.filter(([x, y]) => y - x > 1e-9);
    });
  }
  const pt = (t: number): [number, number] => [a[0] + dx * t, a[1] + dy * t];
  return parts.map(([s, e]) => [pt(s), pt(e)]);
}

/**
 * The path again without its parts under the marks, in the CTM it was built in, with its painting operator. Fills:
 * the filled area minus the marks (written even-odd); strokes: the lines cut where they enter a mark. Curves come back
 * as short straight pieces. null when the path cannot be rewritten (no inverse matrix).
 */
function cutPath(p: PathPaint, rects: Rect[]): string | null {
  const toLocal = inv(p.base);
  if (!toLocal) return null;
  const subs = flattenPath(p);
  const op = p.paintOp;
  const fills = !["S", "s"].includes(op);
  const strokes = ["S", "s", "B", "B*", "b", "b*"].includes(op);
  const w = (q: [number, number]) => {
    const l = apply(toLocal, q[0], q[1]);
    return `${l[0].toFixed(3)} ${l[1].toFixed(3)}`;
  };
  let out = "";
  if (fills) {
    const ring = (pts: [number, number][]): Pair[] => [...pts, pts[0]] as Pair[];
    const polys = subs.map((s) => [ring(s.pts)] as Polygon);
    let area: MultiPolygon = [];
    try {
      const subject = polys.length > 1 ? (p.evenOdd ? polygonClipping.xor(polys[0], ...polys.slice(1)) : polygonClipping.union(polys[0], ...polys.slice(1))) : [polys[0]];
      area = polygonClipping.difference(subject as MultiPolygon, ...rects.map((r) => [[[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]], [r[0], r[1]]]] as Polygon));
    } catch {
      return null;
    }
    for (const poly of area) for (const rg of poly) out += rg.map((q, k) => `${w(q as [number, number])} ${k ? "l" : "m"}`).join(" ") + " h ";
    if (out) out += "f* ";
  }
  if (strokes) {
    let s = "";
    for (const sub of subs) {
      const pts = sub.closed || op === "s" || op.startsWith("b") ? [...sub.pts, sub.pts[0]] : sub.pts;
      let last: [number, number] | null = null;
      for (let i = 0; i + 1 < pts.length; i++)
        for (const [x, y] of segmentOutside(pts[i], pts[i + 1], rects)) {
          if (!last || Math.hypot(last[0] - x[0], last[1] - x[1]) > 1e-6) s += `${w(x)} m `;
          s += `${w(y)} l `;
          last = y;
        }
    }
    if (s) out += s + "S ";
  }
  return out || " ";
}
type Pair = [number, number];

/** Bounding box of a path in user space (points are transformed when the path is built) */
function pathBox(p: PathPaint): Rect | null {
  let r: Rect | null = null;
  for (const sg of p.segs)
    for (let k = 0; k + 1 < sg.pts.length; k += 2) {
      const [x, y] = apply(p.base, sg.pts[k], sg.pts[k + 1]);
      r = r ? union(r, [x, y, x, y]) : [x, y, x, y];
    }
  return r;
}

const unitBox = (m: M): Rect => {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
};
const inside = (a: Rect, m: Rect) => a[0] >= m[0] - 0.5 && a[1] >= m[1] - 0.5 && a[2] <= m[2] + 0.5 && a[3] <= m[3] + 0.5;

/** How often each object is referred to in the file (to tell a form or picture drawn elsewhere too). */
function refCounts(ctx: PDFContext): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (o: PDFObject | undefined, depth: number) => {
    if (!o || depth > 8) return;
    if (o instanceof PDFRef) return void out.set(o.toString(), (out.get(o.toString()) ?? 0) + 1);
    if (o instanceof PDFArray) for (const x of o.asArray()) visit(x, depth + 1);
    else if (o instanceof PDFDict) for (const [, x] of o.entries()) visit(x, depth + 1);
    else if (o instanceof PDFStream) for (const [, x] of o.dict.entries()) visit(x, depth + 1);
  };
  for (const [, o] of ctx.enumerateIndirectObjects()) visit(o, 0);
  return out;
}

// ───────── pictures ─────────

interface Samples {
  w: number;
  h: number;
  n: number;
  bpc: number;
  data: Uint8Array;
  /** written back as (dict entries to set; the rest of the image dictionary stays) */
  rgb?: boolean;
  invert: boolean;
  indexed: boolean;
  mask: boolean;
}

function components(ctx: PDFContext, cs: PDFObject | undefined, depth = 0): { n: number; indexed: boolean } | null {
  const v = look(ctx, cs);
  const nm = nameOf(v);
  if (nm) return { DeviceGray: 1, G: 1, CalGray: 1, DeviceRGB: 3, RGB: 3, CalRGB: 3, DeviceCMYK: 4, CMYK: 4 }[nm] ? { n: ({ DeviceGray: 1, G: 1, CalGray: 1, DeviceRGB: 3, RGB: 3, CalRGB: 3, DeviceCMYK: 4, CMYK: 4 } as Record<string, number>)[nm], indexed: false } : null;
  if (!(v instanceof PDFArray) || !v.size() || depth > 4) return null;
  const fam = nameOf(look(ctx, v.get(0)));
  if (fam === "ICCBased") {
    const s = look(ctx, v.get(1));
    return { n: s instanceof PDFStream ? numOf(dget(ctx, s.dict, "N")) ?? 3 : 3, indexed: false };
  }
  if (fam === "Indexed" || fam === "I") return { n: 1, indexed: true };
  if (fam === "Separation") return { n: 1, indexed: false };
  if (fam === "DeviceN") {
    const names = look(ctx, v.get(1));
    return { n: names instanceof PDFArray ? names.size() : 1, indexed: false };
  }
  if (fam === "CalRGB" || fam === "Lab") return { n: 3, indexed: false };
  if (fam === "CalGray") return { n: 1, indexed: false };
  return null;
}

async function samplesOf(sd: SurgeonDoc, img: PDFStream, decodeJpeg?: RedactOptions["decodeJpeg"]): Promise<Samples | null> {
  const ctx = sd.ctx;
  const d = img.dict;
  const w = numOf(dget(ctx, d, "Width")) ?? 0, h = numOf(dget(ctx, d, "Height")) ?? 0;
  if (!w || !h || w * h > 60_000_000) return null;
  const mask = look(ctx, d.get(PDFName.of("ImageMask")))?.toString() === "true";
  const bpc = mask ? 1 : numOf(dget(ctx, d, "BitsPerComponent")) ?? 8;
  const filters = filtersOf(toVal(dget(ctx, d, "Filter")), toVal(dget(ctx, d, "DecodeParms")));
  const decode = look(ctx, d.get(PDFName.of("Decode")));
  const invert = decode instanceof PDFArray && decode.size() >= 2 && (numOf(look(ctx, decode.get(0))) ?? 0) > (numOf(look(ctx, decode.get(1))) ?? 1);
  const last = filters[filters.length - 1]?.name;
  if (last === "DCTDecode" || last === "DCT") {
    if (!decodeJpeg || mask) return null;
    const raw = img instanceof PDFRawStream ? img.contents : img.getContents();
    const pre = decodeFilters(raw, filters.slice(0, -1));
    const px = await decodeJpeg(pre).catch(() => null);
    if (!px || px.width !== w || px.height !== h) return null;
    const rgbData = new Uint8Array(w * h * 3);
    for (let p = 0, q = 0; p < w * h; p++, q += 4) (rgbData[p * 3] = px.data[q]), (rgbData[p * 3 + 1] = px.data[q + 1]), (rgbData[p * 3 + 2] = px.data[q + 2]);
    return { w, h, n: 3, bpc: 8, data: rgbData, rgb: true, invert: false, indexed: false, mask: false };
  }
  let data: Uint8Array;
  try {
    data = streamBytes(ctx, img);
  } catch {
    return null;
  }
  const cs = mask ? { n: 1, indexed: false } : components(ctx, d.get(PDFName.of("ColorSpace")));
  if (!cs || ![1, 2, 4, 8, 16].includes(bpc)) return null;
  const stride = Math.ceil((w * cs.n * bpc) / 8);
  if (data.length < stride * h) return null;
  return { w, h, n: cs.n, bpc, data: data.slice(0, stride * h), invert, indexed: cs.indexed, mask };
}

/** Paint the pixel rectangles with the fill colour in the image's own colour space. */
function paintSamples(s: Samples, rects: [number, number, number, number][], fill: RGB) {
  const lum = 0.299 * fill[0] + 0.587 * fill[1] + 0.114 * fill[2];
  const k = 1 - Math.max(...fill);
  const comp: number[] = s.mask
    ? [1] // a stencil mask: 1 = nothing painted there
    : s.indexed
      ? [0]
      : s.n === 1
        ? [lum]
        : s.n === 3
          ? [...fill]
          : s.n === 4
            ? [k >= 1 ? 0 : (1 - fill[0] - k) / (1 - k), k >= 1 ? 0 : (1 - fill[1] - k) / (1 - k), k >= 1 ? 0 : (1 - fill[2] - k) / (1 - k), k]
            : new Array(s.n).fill(1);
  const max = (1 << Math.min(s.bpc, 8)) - 1;
  const vals = comp.map((c) => (s.indexed || s.mask ? c : s.invert ? 1 - c : c)).map((c) => (s.indexed ? 0 : Math.round(Math.max(0, Math.min(1, c)) * max)));
  const stride = Math.ceil((s.w * s.n * s.bpc) / 8);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = Math.max(0, y0); y < Math.min(s.h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(s.w, x1); x++)
        for (let c = 0; c < s.n; c++) {
          const v = vals[c] ?? 0;
          const sample = x * s.n + c;
          if (s.bpc === 8) s.data[y * stride + sample] = v;
          else if (s.bpc === 16) (s.data[y * stride + sample * 2] = v), (s.data[y * stride + sample * 2 + 1] = v);
          else {
            const bit = sample * s.bpc;
            const byte = y * stride + (bit >> 3), shift = 8 - s.bpc - (bit & 7);
            const m = ((1 << s.bpc) - 1) << shift;
            s.data[byte] = (s.data[byte] & ~m) | ((v << shift) & m);
          }
        }
  }
}

function writeSamples(ctx: PDFContext, img: PDFStream, s: Samples): PDFStream {
  const nd = ctx.obj({}) as PDFDict;
  for (const [k, v] of img.dict.entries()) if (!["/Filter", "/DecodeParms", "/Length", "/DL"].includes(k.asString())) nd.set(k, v);
  if (s.rgb) {
    nd.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    nd.delete(PDFName.of("Decode"));
  }
  const st = ctx.flateStream(s.data);
  for (const [k, v] of nd.entries()) st.dict.set(k, v);
  return st;
}

// ───────── redaction ─────────

export async function applyRedactions(bytes: Uint8Array, marks: RedactMark[], o: RedactOptions = {}): Promise<{ bytes: Uint8Array; report: RedactReport }> {
  const sd = await openSurgeonDoc(bytes);
  const ctx = sd.ctx;
  const rep: RedactReport = { pages: 0, glyphs: 0, images: 0, imagesRemoved: 0, paths: 0, pathsCut: 0, patterns: 0, annots: 0, removedText: [], notes: [] };
  const byPage = new Map<number, Rect[]>();
  for (const m of marks) if (m.page >= 0 && m.page < sd.pageRefs.length) byPage.set(m.page, [...(byPage.get(m.page) ?? []), norm(m.rect)]);
  const counts = refCounts(ctx);
  let seq = 0;
  const removedFields = new Set<string>();
  const donePatterns = new Set<string>();

  for (const [pi, rects] of byPage) {
    rep.pages++;
    const pd = pageDict(sd, pi);
    const a = analyze(sd, pi);
    rep.notes.push(...a.notes);
    const edits = new Map<string, Map<number, string>>();
    const edit = (unit: string, op: number, s: string) => {
      let m = edits.get(unit);
      if (!m) edits.set(unit, (m = new Map()));
      m.set(op, s);
    };
    // the page's own resources (copy-on-write): pictures and forms written anew are named here
    let ownRes: PDFDict | null = null;
    const pageRes = () => {
      if (ownRes) return ownRes;
      const cur = pageResources(sd, pi);
      ownRes = cur ? cloneDict(ctx, cur) : (ctx.obj({}) as PDFDict);
      const xo = dictOf(look(ctx, ownRes.get(PDFName.of("XObject"))));
      ownRes.set(PDFName.of("XObject"), xo ? cloneDict(ctx, xo) : ctx.obj({}));
      pd.set(PDFName.of("Resources"), ownRes);
      return ownRes;
    };
    const touchedOps = new Map<string, Set<number>>();
    /** page XObject names drawn anew under another name: the old entry goes when no other Do of the page uses it */
    const renamed = new Set<string>();
    /** form units: pictures added under new names, and names to drop from their resources */
    const formXos = new Map<string, { set: Map<string, PDFRef>; drop: Set<string> }>();
    const formXo = (unit: string) => formXos.get(unit) ?? formXos.set(unit, { set: new Map(), drop: new Set() }).get(unit)!;
    // text
    for (const it of a.items) {
      if (it.kind !== "text") continue;
      const boxes = glyphBoxes(it, a.units.get(it.unit));
      const drop = new Set<number>();
      boxes.forEach((g, k) => glyphHit(g.box, rects) && drop.add(k));
      if (!drop.size) continue;
      const u = a.units.get(it.unit)!;
      edit(it.unit, it.op, showWithout(u, it, drop));
      (touchedOps.get(it.unit) ?? touchedOps.set(it.unit, new Set()).get(it.unit)!).add(it.op);
      rep.glyphs += drop.size;
      const removed = [...drop].sort((x, y) => x - y).map((k) => boxes[k].ch).join("");
      if (removed.trim()) rep.removedText.push(removed);
    }
    // vector paths entirely inside a mark
    for (const it of a.items) {
      if (it.kind !== "path" || it.clip || it.paintOp === "n") continue;
      const b = pathBox(it);
      if (b && rects.some((m) => inside(b, m))) {
        edit(it.unit, it.paint, "n");
        rep.paths++;
      } else if (b && rects.some((m) => overlap(b, m) > 0)) {
        // partly covered: the path is written again without what lies under the marks (fills: area difference;
        // strokes: the lines cut at the mark edges), so no coordinate inside a mark stays in the file
        const cut = cutPath(it, rects.filter((m) => overlap(b, m) > 0));
        if (cut == null) continue;
        edit(it.unit, it.first, cut);
        for (let k = it.first + 1; k <= it.paint; k++) edit(it.unit, k, "");
        rep.pathsCut++;
      }
    }
    // pictures
    for (const it of a.items) {
      if (it.kind !== "image") continue;
      const box = unitBox(it.base);
      const hit = rects.filter((m) => overlap(box, m) > 0);
      if (!hit.length) continue;
      if (it.name.startsWith("sh:")) {
        if (rects.some((m) => inside(box, m))) edit(it.unit, it.op, "");
        else {
          const cut = clipOut(it.base, hit);
          if (cut) edit(it.unit, it.op, `q ${cut} ${opText(a.units.get(it.unit)!, it.op)} Q`);
        }
        continue;
      }
      if (rects.some((m) => inside(box, m))) {
        edit(it.unit, it.op, "");
        if (it.unit === "page") renamed.add(it.name);
        else formXo(it.unit).drop.add(it.name);
        rep.images++;
        continue;
      }
      await paintImage(it, hit);
    }
    async function paintImage(it: ImageDraw, hit: Rect[]) {
      const u = a.units.get(it.unit)!;
      const xo = dictOf(dget(ctx, u.resources, "XObject"));
      const ref = xo?.get(PDFName.of(it.name));
      const img = look(ctx, ref);
      if (!(img instanceof PDFStream)) return;
      const s = await samplesOf(sd, img, o.decodeJpeg);
      const toUnit = inv(it.base);
      if (!s || !toUnit) {
        edit(it.unit, it.op, "");
        if (it.unit === "page") renamed.add(it.name);
        else formXo(it.unit).drop.add(it.name);
        rep.imagesRemoved++;
        return;
      }
      const px = hit.map((m) => {
        const pts = [apply(toUnit, m[0], m[1]), apply(toUnit, m[2], m[1]), apply(toUnit, m[0], m[3]), apply(toUnit, m[2], m[3])];
        const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
        return [Math.floor(Math.min(...us) * s.w), Math.floor((1 - Math.max(...vs)) * s.h), Math.ceil(Math.max(...us) * s.w), Math.ceil((1 - Math.min(...vs)) * s.h)] as [number, number, number, number];
      });
      paintSamples(s, px, o.fill ?? [0, 0, 0]);
      const out = writeSamples(ctx, img, s);
      rep.images++;
      // drawn from the page itself: a new picture under a new name (other pages keep theirs); inside a form: in place
      if (it.unit === "page") {
        const nm = `OmwRx${++seq}`;
        (pageRes().get(PDFName.of("XObject")) as PDFDict).set(PDFName.of(nm), ctx.register(out));
        edit("page", it.op, `/${nm} Do`);
        renamed.add(it.name);
      } else {
        // inside a form: a new picture under a new name in the form's own resources (the old one stays for its
        // other users, and leaves this form when nothing else in it draws it)
        const nm = `OmwRx${++seq}`;
        const fx = formXo(it.unit);
        fx.set.set(nm, ctx.register(out));
        fx.drop.add(it.name);
        edit(it.unit, it.op, `/${nm} Do`);
      }
    }
    // inline images touching a mark (no picture data worth painting: taken out)
    for (const [key, u] of a.units) {
      let ctm: M = u.space ?? I;
      const stack: M[] = [];
      u.ops.forEach((op, k) => {
        if (op.op === "q") stack.push(ctm);
        else if (op.op === "Q") ctm = stack.pop() ?? ctm;
        else if (op.op === "cm") {
          const m = toM(op.args);
          if (m) ctm = mul(m, ctm);
        } else if (op.op === "BI" && rects.some((m) => overlap(unitBox(ctm), m) > 0)) {
          edit(key, k, "");
          rep.imagesRemoved++;
        }
      });
    }
    // text inside tiling patterns (a cell repeated over an area): a glyph any of whose repeats meets a mark leaves the
    // cell — every repeat of it, wherever the pattern paints (the pattern object is changed in place)
    for (const u of [...a.units.values()]) {
      const pats = dictOf(dget(ctx, u.resources, "Pattern"));
      if (!pats) continue;
      for (const [, ref] of pats.entries()) {
        if (!(ref instanceof PDFRef) || donePatterns.has(ref.toString())) continue;
        const ps = look(ctx, ref);
        if (!(ps instanceof PDFStream) || numOf(dget(ctx, ps.dict, "PatternType")) !== 1) continue;
        donePatterns.add(ref.toString());
        let content: Uint8Array;
        try {
          content = streamBytes(ctx, ps);
        } catch {
          continue;
        }
        if (!/\bBT\b/.test(latin1(content, 0, content.length))) continue;
        const toPat = inv(mul(toM(numArray(ctx, dget(ctx, ps.dict, "Matrix"))) ?? I, u.space ?? I));
        if (!toPat) continue;
        const xs = Math.abs(numOf(dget(ctx, ps.dict, "XStep")) ?? 0), ys = Math.abs(numOf(dget(ctx, ps.dict, "YStep")) ?? 0);
        const markP = rects.map((r) => {
          const pts = [apply(toPat, r[0], r[1]), apply(toPat, r[2], r[1]), apply(toPat, r[0], r[3]), apply(toPat, r[2], r[3])];
          return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as Rect;
        });
        const pa = analyzePage(sd, I, dictOf(dget(ctx, ps.dict, "Resources")), content, hiddenOcgs(sd));
        const pe = new Map<number, string>();
        const pu = pa.units.get("page");
        if (!pu) continue;
        for (const it of pa.items) {
          if (it.kind !== "text" || it.unit !== "page") continue;
          const boxes = glyphBoxes(it, pu);
          const drop = new Set<number>();
          boxes.forEach((g, k) => {
            const hitAny = markP.some((m) => {
              const i0 = xs ? Math.floor((m[0] - g.box[2]) / xs) : 0, i1 = xs ? Math.ceil((m[2] - g.box[0]) / xs) : 0;
              const j0 = ys ? Math.floor((m[1] - g.box[3]) / ys) : 0, j1 = ys ? Math.ceil((m[3] - g.box[1]) / ys) : 0;
              if ((i1 - i0 + 1) * (j1 - j0 + 1) > 1e6) return true; // a tiny cell under a large mark: certainly covered
              for (let i = i0; i <= i1; i++)
                for (let j = j0; j <= j1; j++) if (overlap([g.box[0] + i * xs, g.box[1] + j * ys, g.box[2] + i * xs, g.box[3] + j * ys], m) > 0) return true;
              return false;
            });
            if (hitAny) drop.add(k);
          });
          if (!drop.size) continue;
          pe.set(it.op, showWithout(pu, it, drop));
          rep.glyphs += drop.size;
          rep.patterns++;
        }
        if (!pe.size) continue;
        const st = ctx.flateStream(rewriteUnit(pu, pe));
        for (const [k, v] of ps.dict.entries()) if (!["/Filter", "/DecodeParms", "/Length", "/DL"].includes(k.asString())) st.dict.set(k, v);
        ctx.assign(ref, st);
      }
    }
    // marked-content alternate text around removed glyphs
    for (const [key, ops] of touchedOps) {
      const u = a.units.get(key)!;
      const open: number[] = [];
      u.ops.forEach((op, k) => {
        if (op.op === "BDC" || op.op === "BMC") open.push(k);
        else if (op.op === "EMC") {
          const b = open.pop();
          if (b === undefined || u.ops[b].op !== "BDC") return;
          const props = u.ops[b].args[1];
          if (!(props instanceof PdfDict) || !["ActualText", "Alt", "E"].some((x) => props.map.has(x))) return;
          if (![...ops].some((x) => x > b && x < k)) return;
          const nd = new PdfDict();
          for (const [kk, v] of props.map) if (!["ActualText", "Alt", "E"].includes(kk)) nd.map.set(kk, v);
          edit(key, b, `${serialize(u.ops[b].args[0] ?? new PdfName("Span"))} ${serialize(nd)} BDC`);
        }
      });
    }
    // write the streams: forms first (a form drawn from the page and elsewhere too gets a copy for this page, which
    // renames its Do in the page stream), the page's own stream last
    const pageUnit = a.units.get("page");
    const pageXo = dictOf(dget(ctx, pageUnit?.resources, "XObject"));
    for (const [key, m] of edits) {
      if (key === "page") continue;
      const u = a.units.get(key)!;
      const old = u.formRef ? look(ctx, u.formRef) : undefined;
      if (!(old instanceof PDFStream) || !u.formRef) continue;
      const st = ctx.flateStream(rewriteUnit(u, m));
      const fx = formXos.get(key);
      let newRes: PDFDict | null = null;
      if (fx) {
        const r0 = dictOf(dget(ctx, old.dict, "Resources")) ?? u.resources; // (a form without its own uses the page's)
        const res = r0 ? cloneDict(ctx, r0) : (ctx.obj({}) as PDFDict);
        const x0 = dictOf(look(ctx, res.get(PDFName.of("XObject"))));
        const xo = x0 ? cloneDict(ctx, x0) : (ctx.obj({}) as PDFDict);
        for (const [nm, r] of fx.set) xo.set(PDFName.of(nm), r);
        const still = new Set(u.ops.filter((op, k) => op.op === "Do" && !m.has(k) && op.args[0] instanceof PdfName).map((op) => (op.args[0] as PdfName).name));
        for (const nm of fx.drop) if (!still.has(nm)) xo.delete(PDFName.of(nm));
        res.set(PDFName.of("XObject"), xo);
        newRes = res; // the new stream's only: a form copied for this page leaves the original's resources as they were
      }
      for (const [k, v] of old.dict.entries()) if (!["/Filter", "/DecodeParms", "/Length", "/DL"].includes(k.asString())) st.dict.set(k, v);
      if (newRes) st.dict.set(PDFName.of("Resources"), newRes);
      const shared = u.uses > 1 || (counts.get(u.formRef.toString()) ?? 0) > 1;
      const doOps = shared && pageUnit
        ? pageUnit.ops
            .map((op, k) => [op, k] as const)
            .filter(([op]) => {
              if (op.op !== "Do" || !(op.args[0] instanceof PdfName)) return false;
              const r = pageXo?.get(PDFName.of(op.args[0].name));
              return r instanceof PDFRef && r.toString() === u.formRef!.toString();
            })
        : [];
      if (shared && doOps.length) {
        const nm = `OmwRf${++seq}`;
        (pageRes().get(PDFName.of("XObject")) as PDFDict).set(PDFName.of(nm), ctx.register(st));
        for (const [, k] of doOps) edit("page", k, `/${nm} Do`);
        renamed.add((doOps[0][0].args[0] as PdfName).name);
      } else ctx.assign(u.formRef, st); // drawn only here (or from another form): changed in place
    }
    const pe = edits.get("page");
    if (pageUnit && renamed.size) {
      const still = new Set(pageUnit.ops.filter((op, k) => op.op === "Do" && !pe?.has(k) && op.args[0] instanceof PdfName).map((op) => (op.args[0] as PdfName).name));
      const xo = pageRes().get(PDFName.of("XObject")) as PDFDict;
      for (const nm of renamed) if (!still.has(nm)) xo.delete(PDFName.of(nm));
    }
    if (pe && pageUnit) pd.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(rewriteUnit(pageUnit, pe))));
    // annotations and widgets touching a mark
    const annots = look(ctx, pd.get(PDFName.of("Annots")));
    if (annots instanceof PDFArray) {
      const keep: PDFObject[] = [];
      for (const r of annots.asArray()) {
        const an = dictOf(look(ctx, r));
        const ra = an && look(ctx, an.get(PDFName.of("Rect")));
        const box = ra instanceof PDFArray && ra.size() >= 4 ? norm(ra.asArray().slice(0, 4).map((x) => numOf(look(ctx, x)) ?? 0) as Rect) : null;
        if (an && box && rects.some((m) => overlap(box, m) > 0 || (area(box) === 0 && box[0] >= m[0] && box[0] <= m[2] && box[1] >= m[1] && box[1] <= m[3]))) {
          rep.annots++;
          if (r instanceof PDFRef) removedFields.add(r.toString());
          const popup = an.get(PDFName.of("Popup"));
          if (popup instanceof PDFRef) removedFields.add(popup.toString());
          continue;
        }
        keep.push(r);
      }
      const kept = keep.filter((r) => !(r instanceof PDFRef && removedFields.has(r.toString())));
      pd.set(PDFName.of("Annots"), ctx.obj(kept as never[]));
    }
    pd.delete(PDFName.of("Thumb"));
    pd.delete(PDFName.of("PieceInfo"));
    if (o.scrubMetadata) pd.delete(PDFName.of("Metadata"));
  }

  // fields whose widgets were removed
  if (removedFields.size) pruneFields(ctx, sd.pdf.catalog, removedFields);

  // words found: out of bookmarks, comments and alternate texts as well
  const terms = [...new Set([...(o.terms ?? []), ...rep.removedText.map((s) => s.trim()).filter((s) => s.replace(/\s/g, "").length >= 4)])].filter(Boolean);
  if (terms.length) scrubStrings(ctx, terms);
  if (o.scrubMetadata) scrubDocument(sd);

  // the boxes and overlay text
  const pages = sd.pdf.getPages();
  const label = (o.overlay ?? "").trim();
  const font = label ? await fontFor(sd.pdf, label, o.font) : null;
  for (const [pi, rects] of byPage) {
    if (o.fill === null && !font) continue;
    const page = pages[pi];
    let ops = "";
    for (const r of rects) {
      if (o.fill !== null) ops += `${(o.fill ?? [0, 0, 0]).map((v) => v.toFixed(3)).join(" ")} rg ${r[0].toFixed(2)} ${r[1].toFixed(2)} ${(r[2] - r[0]).toFixed(2)} ${(r[3] - r[1]).toFixed(2)} re f\n`;
      if (font) {
        const size = Math.max(4, Math.min(o.overlaySize ?? 10, (r[3] - r[1]) * 0.8));
        const w = font.widthOfTextAtSize(label, size);
        const nm = page.node.newFontDictionary("OmwRF", font.ref).decodeText();
        // upright as the page is shown, centred in the box
        const rot = displayOf(page).m;
        const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
        ops += `q ${rot.slice(0, 4).map((v) => v.toFixed(3)).join(" ")} ${cx.toFixed(2)} ${cy.toFixed(2)} cm BT /${nm} ${size.toFixed(2)} Tf ${(o.overlayColor ?? [1, 1, 1]).map((v) => v.toFixed(3)).join(" ")} rg ${(-w / 2).toFixed(2)} ${(-size * 0.35).toFixed(2)} Td ${font.encodeText(label).toString()} Tj ET Q\n`;
      }
    }
    if (ops) addContent(page, ops);
  }
  return { bytes: await savePdf(sd.pdf), report: rep };
}

/** Remove fields whose widgets were deleted from the AcroForm (and parents left without kids). */
function pruneFields(ctx: PDFContext, catalog: PDFDict, gone: Set<string>) {
  const af = dictOf(look(ctx, catalog.get(PDFName.of("AcroForm"))));
  const fields = af && look(ctx, af.get(PDFName.of("Fields")));
  if (!(fields instanceof PDFArray)) return;
  const prune = (arr: PDFArray, depth: number): PDFObject[] =>
    arr.asArray().filter((r) => {
      if (r instanceof PDFRef && gone.has(r.toString())) return false;
      const d = dictOf(look(ctx, r));
      const kids = d && look(ctx, d.get(PDFName.of("Kids")));
      if (kids instanceof PDFArray && depth < 16) {
        const left = prune(kids, depth + 1);
        if (!left.length) return false;
        d!.set(PDFName.of("Kids"), ctx.obj(left as never[]));
      }
      return true;
    });
  af!.set(PDFName.of("Fields"), ctx.obj(prune(fields, 0) as never[]));
}

const SCRUB_KEYS = new Set(["/Title", "/Contents", "/Alt", "/ActualText", "/E", "/TU", "/V", "/RC", "/Subj"]);
/** Text strings that repeat a removed word: the word becomes ■ characters (bookmarks, comments, alt text, values). */
function scrubStrings(ctx: PDFContext, terms: string[]) {
  const res = terms.map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "giu"));
  const fix = (d: PDFDict) => {
    for (const [k, v] of d.entries()) {
      if (!SCRUB_KEYS.has(k.asString())) continue;
      const s = v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;
      if (s == null) continue;
      let out = s;
      for (const re of res) out = out.replace(re, (m) => "■".repeat(Math.min(8, Array.from(m).length)));
      if (out !== s) d.set(k, PDFHexString.fromText(out));
    }
  };
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (o instanceof PDFDict) fix(o);
    else if (o instanceof PDFStream) fix(o.dict);
  }
}

/** Document information, XMP metadata, attachments, scripts and private application data. */
function scrubDocument(sd: SurgeonDoc) {
  const ctx = sd.ctx;
  const cat = sd.pdf.catalog;
  const info = ctx.trailerInfo.Info;
  const infoDict = info ? dictOf(look(ctx, info as PDFObject)) : undefined;
  if (infoDict) for (const [k] of [...infoDict.entries()]) if (k.asString() !== "/Producer") infoDict.delete(k);
  cat.delete(PDFName.of("Metadata"));
  cat.delete(PDFName.of("PieceInfo"));
  cat.delete(PDFName.of("OpenAction"));
  cat.delete(PDFName.of("AA"));
  const names = dictOf(look(ctx, cat.get(PDFName.of("Names"))));
  if (names) {
    names.delete(PDFName.of("EmbeddedFiles"));
    names.delete(PDFName.of("JavaScript"));
  }
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    const d = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (!d) continue;
    d.delete(PDFName.of("PieceInfo"));
    if (d !== cat && nameOf(d.get(PDFName.of("Type"))) !== "Metadata") d.delete(PDFName.of("Metadata"));
    if (nameOf(d.get(PDFName.of("Subtype"))) === "FileAttachment") d.delete(PDFName.of("FS"));
  }
}

// ───────── replace a picture ─────────

export interface PagePicture {
  /** operation index in the page's content (pictures drawn from forms cannot be replaced here) */
  op: number;
  name: string;
  box: Rect;
  width: number;
  height: number;
}

/** Pictures drawn directly by the page (Acrobat 이미지 편집 ▸ 바꾸기 candidates). */
export async function pagePictures(bytes: Uint8Array, pageIndex: number): Promise<PagePicture[]> {
  const sd = await openSurgeonDoc(bytes);
  const a = analyze(sd, pageIndex);
  const xo = dictOf(dget(sd.ctx, a.units.get("page")?.resources, "XObject"));
  return a.items
    .filter((it): it is ImageDraw => it.kind === "image" && !it.name.startsWith("sh:"))
    .map((it) => {
      const s = look(sd.ctx, (it.unit === "page" ? xo : dictOf(dget(sd.ctx, a.units.get(it.unit)?.resources, "XObject")))?.get(PDFName.of(it.name)));
      return { op: it.unit === "page" ? it.op : -1, name: it.name, box: unitBox(it.base), width: s instanceof PDFStream ? numOf(dget(sd.ctx, s.dict, "Width")) ?? 0 : 0, height: s instanceof PDFStream ? numOf(dget(sd.ctx, s.dict, "Height")) ?? 0 : 0 };
    });
}

/**
 * Put another picture (PNG / JPEG) in place of the one drawn by operation `op` of the page: same place and size
 * (`fit`: "fill" stretches to the old box, "keep" keeps the new picture's proportions inside it).
 */
export async function replacePicture(bytes: Uint8Array, pageIndex: number, op: number, image: { bytes: Uint8Array; mime: string }, fit: "fill" | "keep" = "keep"): Promise<Uint8Array> {
  const sd = await openSurgeonDoc(bytes);
  const ctx = sd.ctx;
  const a = analyze(sd, pageIndex);
  const u = a.units.get("page");
  const it = a.items.find((x): x is ImageDraw => x.kind === "image" && x.unit === "page" && x.op === op);
  if (!u || !it) throw new Error("picture not found");
  const img = /png/i.test(image.mime) ? await sd.pdf.embedPng(image.bytes) : await sd.pdf.embedJpg(image.bytes);
  const pd = pageDict(sd, pageIndex);
  const cur = pageResources(sd, pageIndex);
  const res = cur ? cloneDict(ctx, cur) : (ctx.obj({}) as PDFDict);
  const xo = dictOf(look(ctx, res.get(PDFName.of("XObject"))));
  const nx = xo ? cloneDict(ctx, xo) : (ctx.obj({}) as PDFDict);
  res.set(PDFName.of("XObject"), nx);
  pd.set(PDFName.of("Resources"), res);
  const nm = `OmwPic${Date.now().toString(36)}`;
  nx.set(PDFName.of(nm), img.ref);
  let draw = `/${nm} Do`;
  if (fit === "keep") {
    // inside the old unit square: scale the shorter way, centred
    const b = it.base;
    const ow = Math.hypot(b[0], b[1]), oh = Math.hypot(b[2], b[3]);
    const k = Math.min(ow / img.width, oh / img.height);
    const sx = (img.width * k) / ow, sy = (img.height * k) / oh;
    draw = `q ${sx.toFixed(5)} 0 0 ${sy.toFixed(5)} ${((1 - sx) / 2).toFixed(5)} ${((1 - sy) / 2).toFixed(5)} cm /${nm} Do Q`;
  }
  pd.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(rewriteUnit(u, new Map([[op, draw]])))));
  return savePdf(sd.pdf);
}

/** Re-parse check used by tests and the UI: every text glyph of the page inside `rect` (should be none after redaction). */
export async function glyphsInside(bytes: Uint8Array, pageIndex: number, rect: Rect): Promise<string> {
  const sd = await openSurgeonDoc(bytes);
  const a = analyze(sd, pageIndex);
  let s = "";
  for (const it of a.items) if (it.kind === "text") for (const g of glyphBoxes(it, a.units.get(it.unit))) if (glyphHit(g.box, [norm(rect)])) s += g.ch;
  return s;
}

// ───────── form detection (Acrobat 양식 준비 ▸ 자동 인식) ─────────

export interface DetectedField {
  kind: "text" | "checkbox";
  page: number;
  rect: Rect;
  /** the words before it on the line (its label), for the field name */
  label: string;
}

/**
 * Places a form would have: runs of underscores ("이름: ________") become text fields, box characters (□ ☐ ▢)
 * check boxes, and empty table cells drawn as rectangles right of a label are left for the person (not guessed).
 */
export function detectFields(lines: TextLine[][]): DetectedField[] {
  const out: DetectedField[] = [];
  lines.forEach((pl, page) =>
    pl.forEach((l) => {
      const gs = l.glyphs;
      let i = 0;
      while (i < gs.length) {
        const ch = gs[i].ch;
        if (ch === "_" || ch === "＿") {
          let j = i;
          while (j + 1 < gs.length && (gs[j + 1].ch === "_" || gs[j + 1].ch === "＿")) j++;
          if (j - i + 1 >= 4) {
            const b = gs.slice(i, j + 1).reduce((r, g) => union(r, g.box), gs[i].box);
            const h = Math.max(10, l.size * 1.25);
            const label = gs.slice(0, i).map((g) => g.ch).join("").replace(/[:：\s]+$/, "").split(/\s{2,}/).pop()?.trim() ?? "";
            out.push({ kind: "text", page, rect: [b[0], b[1] + l.size * 0.15, b[2], b[1] + l.size * 0.15 + h], label });
          }
          i = j + 1;
          continue;
        }
        if ("□☐▢◻⬜".includes(ch)) {
          const b = gs[i].box;
          const s = Math.min(b[2] - b[0], b[3] - b[1]) || l.size;
          const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2 - s * 0.1;
          const label = gs.slice(i + 1).map((g) => g.ch).join("").trim().split(/\s{2,}|[□☐▢◻⬜]/)[0]?.trim() ?? "";
          out.push({ kind: "checkbox", page, rect: [cx - s * 0.42, cy - s * 0.42, cx + s * 0.42, cy + s * 0.42], label });
        }
        i++;
      }
    }),
  );
  return out;
}

// ───────── compare (Acrobat 파일 비교) ─────────

export interface TextChange {
  kind: "changed" | "added" | "removed";
  pageA: number | null;
  pageB: number | null;
  a: string;
  b: string;
  /** where it is in A (removed / changed words; for an addition, the word it follows) */
  boxesA: Rect[];
  boxesB: Rect[];
}

interface Tok {
  s: string;
  page: number;
  box: Rect;
}

function tokens(lines: TextLine[][]): { lines: { page: number; text: string; toks: Tok[] }[] } {
  const out: { page: number; text: string; toks: Tok[] }[] = [];
  lines.forEach((pl, page) =>
    pl.forEach((l) => {
      const toks: Tok[] = [];
      let cur: Tok | null = null;
      let prev: GlyphBox | null = null;
      for (const g of l.glyphs) {
        const gap = prev ? g.box[0] - prev.box[2] > l.size * 0.25 : false;
        if (!g.ch.trim() || gap) {
          if (cur) toks.push(cur);
          cur = null;
        }
        if (g.ch.trim()) cur = cur ? { s: cur.s + g.ch, page, box: union(cur.box, g.box) } : { s: g.ch, page, box: g.box };
        prev = g;
      }
      if (cur) toks.push(cur);
      if (toks.length) out.push({ page, text: toks.map((x) => x.s).join(" "), toks });
    }),
  );
  return { lines: out };
}

/** Differences in wording between two files: lines matched first, then words inside the lines that differ. */
export async function compareDocuments(aBytes: Uint8Array, bBytes: Uint8Array): Promise<TextChange[]> {
  const { changedRuns } = await import("../formats/textDiff");
  const A = tokens(await documentLines(aBytes)).lines, B = tokens(await documentLines(bBytes)).lines;
  const out: TextChange[] = [];
  for (const [a0, a1, b0, b1] of changedRuns(A.map((l) => l.text), B.map((l) => l.text))) {
    const ta = A.slice(a0, a1).flatMap((l) => l.toks), tb = B.slice(b0, b1).flatMap((l) => l.toks);
    const runs = changedRuns(ta.map((x) => x.s), tb.map((x) => x.s));
    for (const [x0, x1, y0, y1] of runs) {
      const wa = ta.slice(x0, x1), wb = tb.slice(y0, y1);
      const anchor = wa.length ? null : ta[x0 - 1] ?? A[a0 - 1]?.toks.at(-1) ?? A[a1]?.toks[0] ?? null;
      out.push({
        kind: wa.length && wb.length ? "changed" : wa.length ? "removed" : "added",
        pageA: wa[0]?.page ?? anchor?.page ?? null,
        pageB: wb[0]?.page ?? null,
        a: wa.map((x) => x.s).join(" "),
        b: wb.map((x) => x.s).join(" "),
        boxesA: wa.length ? mergeBoxes(wa) : anchor ? [anchor.box] : [],
        boxesB: mergeBoxes(wb),
      });
    }
  }
  return out;
}

/** Word boxes joined per line and page (one highlight per line). */
function mergeBoxes(ws: Tok[]): Rect[] {
  const out: (Rect & { page?: number })[] = [];
  let cur: Rect | null = null;
  let page = -1;
  for (const w of ws) {
    if (cur && w.page === page && Math.abs((cur[1] + cur[3]) / 2 - (w.box[1] + w.box[3]) / 2) < (w.box[3] - w.box[1]) * 0.5) cur = union(cur, w.box);
    else {
      if (cur) out.push(cur);
      cur = w.box;
      page = w.page;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export { parseOps };
