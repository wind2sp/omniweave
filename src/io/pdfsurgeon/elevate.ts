// PDF Surgeon — "elevation": turn recorded drawing operations into editable scene nodes that stay
// linked to the operations they came from. Node ids are deterministic (prefix + page + index), so
// the original state of every node can be rebuilt from the untouched PDF at save time.

import { PDFRef } from "pdf-lib";
import { t } from "../../i18n";
import { newText, newVector, type Contour, type TextNode, type TextRun, type VectorAnchor, type VectorNode } from "../../core/types";
import { dget, dictOf, hasIllustratorData, hiddenOcgs, pageContent, pageResources, pageView, refKey, type SurgeonDoc } from "./document";
import { analyzePage, type PageAnalysis, type PathPaint, type TextShow } from "./interpret";
import { apply, viewportMatrix, type M } from "./matrix";
import { cssFont, measure } from "../../core/text";
import { embeddedFontFamily } from "./pdfFonts";

export const PDF_UNIT = 96 / 72;
/** first baseline below the node top, as a fraction of the font size (core/text.ts, lineSpacing 1.2) */
export const BASELINE = 0.9;
export const LINE_SPACING = 1.2;

export interface TextLine {
  id: string;
  unit: string;
  shows: TextShow[];
  /** one entry per run in the node, in order */
  runs: { show: TextShow; sizePx: number; pdfWidth?: number }[];
  node: TextNode;
}

export interface VectorItem {
  id: string;
  path: PathPaint;
  node: VectorNode;
}

export interface ElevateOptions {
  /** stable per-document prefix, e.g. the first characters of the asset hash */
  prefix: string;
  /** "auto": only on pages with Illustrator data (AI files); true/false force it */
  vectors?: boolean | "auto";
  /** above this many paths a page keeps its vectors in the background */
  maxVectors?: number;
}

export interface PageModel {
  pageIndex: number;
  analysis: PageAnalysis;
  /** default user space → page px */
  viewport: M;
  width: number;
  height: number;
  lines: TextLine[];
  vectors: VectorItem[];
  notes: string[];
}

export const textId = (prefix: string, page: number, i: number) => `ps_${prefix}_${page}_t${i}`;
export const vectorId = (prefix: string, page: number, i: number) => `ps_${prefix}_${page}_v${i}`;
export const isSurgeonId = (id: string, prefix: string, page: number) => id.startsWith(`ps_${prefix}_${page}_`);

/** Analyse a page and build its elevated nodes (pure: the same PDF always gives the same model). */
export function modelPage(doc: SurgeonDoc, pageIndex: number, opts: ElevateOptions): PageModel {
  const { view, rotate, userUnit } = pageView(doc, pageIndex);
  const vp = viewportMatrix(view, rotate, PDF_UNIT * userUnit);
  const notes: string[] = [];
  let content: Uint8Array;
  try {
    content = pageContent(doc, pageIndex);
  } catch (e) {
    notes.push(t("engine.pdf.edit.contentUnreadable", { error: (e as Error).message }));
    content = new Uint8Array(0);
  }
  const analysis = analyzePage(doc, vp.m, pageResources(doc, pageIndex), content, hiddenOcgs(doc));
  notes.push(...analysis.notes);
  const sharedForms = formsShared(doc);
  const editableUnit = (key: string) => {
    const u = analysis.units.get(key);
    return !!u && u.uses === 1 && !(u.formRef && sharedForms.has(refKey(u.formRef)));
  };
  const lines = buildLines(analysis, editableUnit, opts.prefix, pageIndex, vp.width);
  const wantVectors = opts.vectors === true || (opts.vectors !== false && hasIllustratorData(doc, pageIndex));
  let vectors: VectorItem[] = [];
  if (wantVectors) {
    // Paint order: the elevated vectors are drawn above the page background (the PDF without them), so a path
    // painted BELOW something that stays in the background (an image, a gradient (sh), a path we cannot elevate)
    // would cover it once elevated — e.g. an artboard fill under a gradient (ai_layers). Such a path stays in the
    // background, where it was; paths no later background item overlaps are elevated as before.
    const elevatable = (x: (typeof analysis.items)[number]): boolean => x.kind === "path" && vectorEligible(x) && editableUnit(x.unit);
    const above: Box[] = [];
    const keep = new Set<number>();
    let lastClip: Box | null = null;
    const boxes = analysis.items.map((x) => {
      if (x.kind === "path") {
        // path operands are user space: into page px with the CTM at construction, as the vector nodes are
        const bx = segsBox(x.segs, x.base);
        if (x.clip) lastClip = bx;
        return bx;
      }
      if (x.kind === "image") return x.name.startsWith("sh:") ? lastClip ?? { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 } : imageBox(x.base);
      // text that stays in the background (not elevated) must not be covered either
      if (x.kind === "text" && x.glyphs.length && !lines.some((l) => l.shows.includes(x))) {
        const xs = x.glyphs.flatMap((g) => [g.x0, g.x1]), ys = x.glyphs.flatMap((g) => [g.y0, g.y1]);
        const h = Math.abs(x.fontSize) * Math.hypot(x.start[2], x.start[3]);
        return { x0: Math.min(...xs) - h, y0: Math.min(...ys) - h, x1: Math.max(...xs) + h, y1: Math.max(...ys) + h };
      }
      return null;
    });
    for (let k = analysis.items.length - 1; k >= 0; k--) {
      const x = analysis.items[k], bx = boxes[k];
      if (!bx) continue;
      const up = elevatable(x);
      if (up) {
        // kept in the background: then it is itself something the paths below it must not cover
        if (above.some((o) => overlaps(o, bx))) {
          keep.add(k);
          above.push(bx);
        }
      } else if (x.kind === "image" ? !x.hidden : x.kind === "text" ? true : x.kind === "path" && !x.clip && x.paintOp !== "n" && !x.hidden) above.push(bx);
    }
    const paths = analysis.items.filter((x, k): x is PathPaint => elevatable(x) && !keep.has(k));
    const max = opts.maxVectors ?? 3000;
    if (paths.length > max) notes.push(t("engine.pdf.edit.tooManyPaths", { n: paths.length.toLocaleString(), max: max.toLocaleString() }));
    else vectors = paths.map((p, i) => ({ id: vectorId(opts.prefix, pageIndex, i), path: p, node: vectorNode(p, vectorId(opts.prefix, pageIndex, i), i) }));
  }
  return { pageIndex, analysis, viewport: vp.m, width: vp.width, height: vp.height, lines, vectors, notes };
}

/** Form XObjects listed in the resources of more than one page (editing them would change every page). */
function formsShared(doc: SurgeonDoc): Set<string> {
  const counts = new Map<string, number>();
  doc.pageRefs.forEach((_, i) => {
    const xo = dictOf(dget(doc.ctx, pageResources(doc, i), "XObject"));
    const seen = new Set<string>();
    for (const [, v] of xo?.entries() ?? []) if (v instanceof PDFRef) seen.add(refKey(v));
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
}

// ───────── text lines ─────────

function textEligible(s: TextShow): boolean {
  return !s.font.unsupported && s.et >= 0 && !s.hidden && !s.clipped && s.tr !== 3 && s.glyphs.length > 0 && s.glyphs.some((g) => g.ch.trim());
}

const angleOf = (m: M) => Math.atan2(m[1], m[0]);
const sizePxOf = (s: TextShow) => Math.abs(s.fontSize) * Math.hypot(s.start[2], s.start[3]);

/** Position of a point along / across the baseline direction of `ref`. */
function frame(ref: TextShow) {
  const ang = angleOf(ref.start);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const ox = ref.glyphs[0].x0, oy = ref.glyphs[0].y0;
  return (x: number, y: number) => ({ along: (x - ox) * ux + (y - oy) * uy, across: -(x - ox) * uy + (y - oy) * ux });
}

function buildLines(a: PageAnalysis, editable: (unit: string) => boolean, prefix: string, page: number, pageW: number): TextLine[] {
  const groups: TextShow[][] = [];
  let cur: TextShow[] = [];
  let end = 0;
  let pos: ReturnType<typeof frame> | null = null;
  for (const it of a.items) {
    if (it.kind !== "text" || !textEligible(it) || !editable(it.unit)) continue;
    const size = sizePxOf(it);
    if (cur.length && pos) {
      const head = cur[0];
      const p0 = pos(it.glyphs[0].x0, it.glyphs[0].y0);
      const sameDir = Math.abs(angleOf(it.start) - angleOf(head.start)) < 0.02;
      const sameLine = Math.abs(p0.across) < Math.max(sizePxOf(head), size) * 0.35;
      const gap = p0.along - end;
      if (it.unit === head.unit && sameDir && sameLine && gap > -size * 0.5 && gap < size * 2.5) {
        cur.push(it);
        end = Math.max(end, pos(it.glyphs[it.glyphs.length - 1].x1, it.glyphs[it.glyphs.length - 1].y1).along);
        continue;
      }
    }
    if (cur.length) groups.push(cur);
    cur = [it];
    pos = frame(it);
    end = pos(it.glyphs[it.glyphs.length - 1].x1, it.glyphs[it.glyphs.length - 1].y1).along;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => textLine(g, textId(prefix, page, i), pageW));
}

const runKey = (s: TextShow) => `${s.font.id}|${Math.round(sizePxOf(s) * 100)}|${s.fill.hex}`;

function textLine(shows: TextShow[], id: string, pageW: number): TextLine {
  const head = shows[0];
  const sizePx = sizePxOf(head);
  const runs: { show: TextShow; sizePx: number; pdfWidth?: number }[] = [];
  const textRuns: TextRun[] = [];
  const pos = frame(head);
  let lastEnd: number | null = null;
  let lastCh = "";
  // where each text run ends along the line in the PDF (to match its width in the editing font, below)
  const runEnd: number[] = [];
  const lineStart = pos(head.glyphs[0].x0, head.glyphs[0].y0).along;
  for (const s of shows) {
    let piece = "";
    for (const g of s.glyphs) {
      const p = pos(g.x0, g.y0);
      const sz = sizePxOf(s);
      if (lastEnd != null && p.along - lastEnd > sz * 0.2 && !/\s$/.test(lastCh) && !/^\s/.test(g.ch)) {
        piece += " ";
      }
      piece += g.ch;
      lastCh = g.ch || lastCh;
      lastEnd = pos(g.x1, g.y1).along;
    }
    const prev = runs[runs.length - 1];
    if (prev && runKey(prev.show) === runKey(s)) {
      textRuns[textRuns.length - 1].text += piece;
      runEnd[runEnd.length - 1] = lastEnd ?? lineStart;
    } else {
      runs.push({ show: s, sizePx: sizePxOf(s) });
      textRuns.push(runOf(s, piece));
      runEnd.push(lastEnd ?? lineStart);
    }
  }
  // The PDF places glyphs one by one (TJ adjustments, Tc / Tw, Word's word-by-word strings): laid out with natural
  // advances the line came out shorter or longer than the original. Each run gets the letter spacing that makes its
  // width in the editing font the PDF's (within ±40 % of the font size per character, else left alone).
  let from = lineStart;
  textRuns.forEach((r, k) => {
    const n = [...r.text].length;
    const want = runEnd[k] - from;
    from = runEnd[k];
    if (n < 2 || !(want > 0)) return;
    // saving an edited line writes its text again with one Tc: write.ts compares this width (unscaled text space)
    // with the run's text as it writes it and spreads the difference (TJ gaps, word gaps) over the characters
    const sh = runs[k].show;
    const th = (sh.tz || 100) / 100, hx = Math.hypot(sh.start[0], sh.start[1]);
    if (hx > 0) runs[k].pdfWidth = want / (th * hx);
    // the embedded font may still be loading: its natural advances are the PDF's own, so no correction is guessed
    if (r.fontFamily.startsWith("omw-pdf-")) return;
    const ls = (want - measure(r.text, cssFont(r))) / n;
    if (Math.abs(ls) > 0.01 && Math.abs(ls) < r.fontSize * 0.4) r.letterSpacing = Math.round(ls * 1000) / 1000;
  });
  const text = textRuns.map((r) => r.text).join("");
  const node = newText(text, 100, {});
  node.id = id;
  node.name = text.trim().slice(0, 24) || t("engine.pdf.default.text");
  node.paragraphs = [{ ...node.paragraphs[0], id: `${id}_p0`, runs: textRuns, lineSpacing: LINE_SPACING, spaceAfter: 0 }];
  const ang = angleOf(head.start);
  const o = { x: head.glyphs[0].x0, y: head.glyphs[0].y0 };
  const h = BASELINE * sizePx;
  node.transform = { x: o.x + h * Math.sin(ang), y: o.y - h * Math.cos(ang), rotation: Math.abs(ang) < 1e-6 ? 0 : (ang * 180) / Math.PI, scale: 1 };
  const extent = Math.max(1, (lastEnd ?? 0) + sizePx * 2);
  node.width = Math.round(Math.min(Math.max(extent * 1.15, sizePx * 2), Math.max(pageW * 2, extent * 1.15)) * 100) / 100;
  return { id, unit: head.unit, shows, runs, node };
}

/** Omniweave families shown while editing (the saved PDF keeps the original font). */
function familyOf(s: TextShow): string {
  // the PDF base-14 families have close system equivalents with the same advance widths, so the
  // editing view keeps the original line length (Pretendard is wider than Helvetica)
  const base = s.font.baseFont.toLowerCase();
  if (/^(helvetica|arial)/.test(base)) return "Arial";
  if (/^times/.test(base)) return "Times New Roman";
  if (/^courier/.test(base)) return "Courier New";
  // any other embedded font: its family name from the PostScript name (MalgunGothic → Malgun Gothic,
  // TimesNewRomanPSMT → Times New Roman); text.ts lists the document fallbacks after it, so a PC without the font
  // shows the same as before (the original glyphs on PCs that have it — Word-made PDFs mostly use system fonts)
  const fam = pdfFontFamilies(s.font.baseFont).find(fontInstalled);
  if (fam) return fam;
  // not installed: the PDF's own embedded glyphs (a rebuilt copy registered as a FontFace, pdfFonts.ts)
  const emb = s.font.program ? embeddedFontFamily(s.font.program) : null;
  if (emb) return emb;
  return s.font.serif ? "Noto Serif KR" : "Pretendard";
}

/**
 * Family names a PDF font's PostScript name may be installed under, most likely first: CamelCase words spaced
 * (MalgunGothic → Malgun Gothic, TimesNewRomanPSMT → Times New Roman), as written without the style suffix
 * (NanumGothic), as written (HYSinMyeongJo-Medium). Empty for names that are no family (Identity, CIDs).
 */
export function pdfFontFamilies(postscript: string): string[] {
  const full = postscript.replace(/^[A-Z]{6}\+/, "");
  let n = full.replace(/[,-](Bold|Italic|Oblique|BoldItalic|BoldOblique|Regular|Roman|Medium|Light|Semibold|SemiBold|Black|Heavy|Book)(MT)?$/i, "");
  n = n.replace(/(PSMT|PS|MT)$/, "").replace(/[,-]$/, "");
  if (!n || /^(Identity|Symbol|ZapfDingbats)/i.test(n) || /^[A-Z]?\d+$/.test(n)) return [];
  const spaced = /[^\x00-\x7f]/.test(n) ? n : n.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return [...new Set([spaced, n, full.replace(/,/g, "-")].filter(Boolean))];
}

const installed = new Map<string, boolean>();
/**
 * Is a font family available to the canvas? Measured against two generic families (a missing family falls back to
 * them). Without a canvas (Node tests) every family counts as available, so the first candidate is used.
 */
function fontInstalled(family: string): boolean {
  let v = installed.get(family);
  if (v !== undefined) return v;
  const g = globalThis as { OffscreenCanvas?: typeof OffscreenCanvas };
  if (!g.OffscreenCanvas) return true;
  const c = new g.OffscreenCanvas(8, 8).getContext("2d");
  if (!c) return true;
  const probe = "Wmgi \uac00\ub098 1lI"; // Hangul GA NA
  const w = (f: string) => ((c.font = f), c.measureText(probe).width);
  v = ["monospace", "serif"].some((base) => Math.abs(w(`40px "${family}", ${base}`) - w(`40px ${base}`)) > 0.01);
  installed.set(family, v);
  return v;
}

function runOf(s: TextShow, text: string): TextRun {
  return {
    text,
    fontFamily: familyOf(s),
    fontSize: Math.round(sizePxOf(s) * 100) / 100,
    bold: s.font.bold,
    italic: s.font.italic,
    underline: false,
    color: s.tr === 1 ? s.stroke.hex ?? "#000000" : s.fill.hex ?? "#000000",
  };
}

// ───────── vectors ─────────

interface Box { x0: number; y0: number; x1: number; y1: number }
function segsBox(segs: { pts: number[] }[], m: M): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of segs)
    for (let i = 0; i + 1 < g.pts.length; i += 2) {
      const [x, y] = apply(m, g.pts[i], g.pts[i + 1]);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  return { x0, y0, x1, y1 };
}
/** An image XObject fills the unit square under its CTM. */
function imageBox(m: M): Box {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function vectorEligible(p: PathPaint): boolean {
  if (p.clip || p.hidden || p.paintOp === "n") return false;
  if (p.fill?.pattern || p.stroke?.pattern) return false;
  return p.segs.some((s) => s.op !== "m");
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function contoursOf(p: PathPaint): Contour[] {
  const out: Contour[] = [];
  let c: Contour | null = null;
  const pt = (x: number, y: number): [number, number] => {
    const [px, py] = apply(p.base, x, y);
    return [round(px), round(py)];
  };
  const corner = (q: [number, number]): VectorAnchor => ({ anchor: q, handleIn: [...q] as [number, number], handleOut: [...q] as [number, number], isCorner: true });
  for (const s of p.segs) {
    if (s.op === "m") {
      if (c && c.nodes.length > 1) out.push(c);
      c = { nodes: [corner(pt(s.pts[0], s.pts[1]))], closed: false };
    } else if (s.op === "l" && c) c.nodes.push(corner(pt(s.pts[0], s.pts[1])));
    else if (s.op === "c" && c) {
      const last = c.nodes[c.nodes.length - 1];
      last.handleOut = pt(s.pts[0], s.pts[1]);
      last.isCorner = false;
      const a: VectorAnchor = { anchor: pt(s.pts[4], s.pts[5]), handleIn: pt(s.pts[2], s.pts[3]), handleOut: [0, 0], isCorner: false };
      a.handleOut = [...a.anchor] as [number, number];
      c.nodes.push(a);
    } else if (s.op === "h" && c) {
      c.closed = true;
      const first: VectorAnchor = c.nodes[0], last: VectorAnchor = c.nodes[c.nodes.length - 1];
      if (c.nodes.length > 1 && last.anchor[0] === first.anchor[0] && last.anchor[1] === first.anchor[1]) {
        first.handleIn = last.handleIn;
        first.isCorner = first.isCorner && last.isCorner;
        c.nodes.pop();
      }
      out.push(c);
      // a path continues from the closed subpath's start
      c = { nodes: [corner([...first.anchor] as [number, number])], closed: false };
    }
  }
  if (c && c.nodes.length > 1) out.push(c);
  return out;
}

function vectorNode(p: PathPaint, id: string, i: number): VectorNode {
  const n = newVector(contoursOf(p), (p.layer ? p.layer + " · " : "") + t("engine.default.pathN", { n: i + 1 }));
  n.id = id;
  n.fill = p.fill ? p.fill.hex ?? "#000000" : null;
  n.stroke = p.stroke ? p.stroke.hex ?? "#000000" : null;
  const scale = Math.sqrt(Math.abs(p.base[0] * p.base[3] - p.base[1] * p.base[2]));
  n.strokeWidth = round(Math.max(p.lineWidth * scale, p.stroke ? 0.75 : 0));
  n.fillRule = p.evenOdd ? "evenodd" : "nonzero";
  return n;
}

