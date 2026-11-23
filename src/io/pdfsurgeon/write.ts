// PDF Surgeon — write edits back into the PDF.
// For every elevated node we compare the current node with the node rebuilt from the untouched
// PDF. Only the operations of changed nodes are replaced (text: neutralised in place and re-drawn
// after the text object in the ORIGINAL font; paths: replaced in place). All other bytes of the
// stream stay identical, unchanged streams/objects/pages are not touched at all, and the result is
// an incremental update appended to the original file.

import { PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFFont } from "pdf-lib";
import { applyTransform, invertTransform, scaleYOf } from "../../core/geom";
import type { Contour, PdfCover, SceneNode, TextNode, Transform, VectorNode } from "../../core/types";
import { contentParts, dictOf, hasIllustratorData, inherited, look, pageDict, type SurgeonDoc } from "./document";
import { BASELINE, LINE_SPACING, illustratorMarked, isSurgeonId, modelPage, type ElevateOptions, type PageModel, type TextLine, type VectorItem } from "./elevate";
import { cloneDict, lastXref, reserveNumbers, writeFull, writeIncremental } from "./incremental";
import { PdfName, hexOf, num, serialize, type Op } from "./syntax";
import { apply, inv, mul, rotate, scaleOf, translate, type M } from "./matrix";
import { t } from "../../i18n";
import { dropXmpThumbnail, isIllustratorPdf, stripIllustratorData } from "./ai";
import { mirrorIllustratorEdits, type AiMirror } from "./aiPrivate";
import { padTtfSubsetGlyphs } from "../fontkitPatch";
import type { ColorState } from "./interpret";
import { paintBox } from "../../core/vector";
import type { Paint } from "../../core/style/types";
import { drawableGradient, gradientFades, shadingDict, type GradientPaint } from "../pdfGradient";

export interface PageEditInput {
  /** page index in the original PDF */
  pageIndex: number;
  /** the Omniweave page's nodes (the PdfNode itself is ignored) */
  nodes: SceneNode[];
  /** the page was elevated by PDF Surgeon (its nodes carry surgeon ids) */
  elevated: boolean;
  /** legacy "cover" rectangles from the old elevation method, painted as filled rectangles */
  covers?: PdfCover[];
  /** placement of the PdfNode on the Omniweave page (default: identity at page size) */
  pdfNode?: { transform: Transform; width: number; crop?: { x: number; y: number; w: number; h: number } };
}

export interface SaveOptions extends ElevateOptions {
  /** fallback font (TTF/OTF) for characters the original font cannot show and for added text */
  fallbackFont?: () => Promise<Uint8Array>;
  /** bytes of an image asset for added image nodes */
  imageBytes?: (assetId: string) => { bytes: Uint8Array; mime: string } | undefined;
  /** original page indices to keep, in output order (default: every page, unchanged order) */
  pageOrder?: number[];
}

export interface SaveReport {
  changed: boolean;
  editedText: number;
  deletedText: number;
  editedVectors: number;
  deletedVectors: number;
  addedNodes: number;
  /** characters drawn with the fallback font because the original (subset) font lacks them */
  fallbackChars: string[];
  /** Illustrator private data was removed so Illustrator reads the edited PDF content (layers merge in Illustrator) */
  illustratorDataRemoved: boolean;
  /** the edits were mirrored into Illustrator's private data (layers, hidden layers and text stay in Illustrator) */
  illustratorDataUpdated: boolean;
  /** why the edits could not be mirrored into Illustrator's private data (set with illustratorDataRemoved) */
  illustratorNote: string;
  /** things that could not be written (kept as in the original or left out) */
  skipped: string[];
  pagesReordered: boolean;
}

interface Splice {
  s: number;
  e: number;
  text: string;
}

const close = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

// ───────── change detection ─────────

const runSig = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => [r.text, Math.round(r.fontSize * 100), r.color.toLowerCase(), r.bold, r.italic]));

function sameTransform(a: Transform, b: Transform) {
  return close(a.x, b.x) && close(a.y, b.y) && close(a.rotation, b.rotation) && close(a.scale, b.scale, 1e-4) && close(scaleYOf(a), scaleYOf(b), 1e-4);
}

/** Compare an elevated text node with its current state (position compared in PDF page px). */
export function textChanged(orig: TextNode, cur: TextNode, toPx: (p: [number, number]) => [number, number] = (p) => p): boolean {
  if (JSON.stringify(runSig(orig)) !== JSON.stringify(runSig(cur))) return true;
  const p = toPx([cur.transform.x, cur.transform.y]);
  const t = orig.transform;
  return !close(p[0], t.x) || !close(p[1], t.y) || !close(cur.transform.rotation, t.rotation) || !close(cur.transform.scale, t.scale, 1e-4) || !close(scaleYOf(cur.transform), scaleYOf(t), 1e-4);
}

const geomSig = (c: Contour[]) => JSON.stringify(c);

export function vectorChanged(orig: VectorNode, cur: VectorNode): boolean {
  return (
    geomSig(orig.contours) !== geomSig(cur.contours) ||
    !sameTransform(orig.transform, cur.transform) ||
    (orig.fill ?? "").toLowerCase() !== (cur.fill ?? "").toLowerCase() ||
    (orig.stroke ?? "").toLowerCase() !== (cur.stroke ?? "").toLowerCase() ||
    !close(orig.strokeWidth, cur.strokeWidth, 1e-3) ||
    orig.fillRule !== cur.fillRule
  );
}

// ───────── colours ─────────

export function parseCss(c: string | null | undefined): [number, number, number] | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (s === "transparent" || s === "none") return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16) / 255) as [number, number, number];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    if (m[2] === "00") return null;
    return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    if (p.length >= 4 && p[3] === 0) return null;
    return [p[0] / 255, p[1] / 255, p[2] / 255];
  }
  return [0, 0, 0];
}

const rgbOp = (c: [number, number, number], op: "rg" | "RG") => `${num(c[0])} ${num(c[1])} ${num(c[2])} ${op}`;

/**
 * A changed colour, written in the colour space family the original used: DeviceCMYK stays k/K
 * (the inverse of the reader's naive CMYK → RGB, so the colour reads back exactly) and DeviceGray
 * stays g/G for neutral colours. Other spaces (RGB, ICC, spot, Lab) cannot hold an arbitrary new
 * colour and are written as RGB.
 */
function colorOpLike(c: [number, number, number], orig: ColorState | null | undefined, stroke: boolean): string {
  const last = orig?.replay.trim().split(/\s+/).pop()?.toLowerCase();
  const [r, g, b] = c;
  if (last === "k") {
    const k = 1 - Math.max(r, g, b);
    const ink = (v: number) => (k >= 1 ? 0 : (1 - v - k) / (1 - k));
    return `${num(ink(r))} ${num(ink(g))} ${num(ink(b))} ${num(k)} ${stroke ? "K" : "k"}`;
  }
  if (last === "g" && r === g && g === b) return `${num(r)} ${stroke ? "G" : "g"}`;
  return rgbOp(c, stroke ? "RG" : "rg");
}
const mStr = (m: readonly number[]) => m.map((v) => num(v)).join(" ");

// ───────── session (one save) ─────────

class Session {
  readonly dirty: PDFRef[] = [];
  readonly report: SaveReport = { changed: false, editedText: 0, deletedText: 0, editedVectors: 0, deletedVectors: 0, addedNodes: 0, fallbackChars: [], illustratorDataRemoved: false, illustratorDataUpdated: false, illustratorNote: "", skipped: [], pagesReordered: false };
  private fallback: Promise<PDFFont | null> | null = null;
  private fbNames = new Map<string, string>();
  private imgNames = new Map<string, { ref: PDFRef; w: number; h: number } | null>();
  readonly splices = new Map<string, Splice[]>();

  constructor(readonly doc: SurgeonDoc, readonly opts: SaveOptions) {}

  mark(r: PDFRef | null | undefined) {
    if (r) this.dirty.push(r);
  }

  splice(unit: string, s: Splice) {
    let list = this.splices.get(unit);
    if (!list) this.splices.set(unit, (list = []));
    list.push(s);
  }

  async fallbackFont(): Promise<PDFFont | null> {
    if (!this.fallback) {
      this.fallback = (async () => {
        if (!this.opts.fallbackFont) return null;
        const bytes = await this.opts.fallbackFont();
        this.doc.pdf.registerFontkit((await import("@pdf-lib/fontkit")).default); // loaded on first use
        const f = await this.doc.pdf.embedFont(bytes, { subset: true });
        padTtfSubsetGlyphs((f as unknown as { embedder?: { subset?: object } }).embedder?.subset); // fontkit short-loca bug
        return f;
      })();
    }
    return this.fallback;
  }

  private fbChars: Set<number> | null = null;

  /**
   * Text the fallback font can actually draw: characters it lacks (Hanja, emoji with Pretendard…)
   * would otherwise be written as .notdef — empty boxes that copy as U+0000 — so they are left out
   * and reported. Control characters (tab…) become spaces.
   */
  async fallbackDrawable(text: string): Promise<string> {
    const f = await this.fallbackFont();
    if (!f) return text;
    this.fbChars ??= new Set(f.getCharacterSet());
    let out = "";
    const missing = new Set<string>();
    for (const ch of text.replace(/[\u0000-\u001f\u007f]/g, " ")) {
      if (this.fbChars.has(ch.codePointAt(0)!)) out += ch;
      else if (/\s/.test(ch)) out += " ";
      else missing.add(ch);
    }
    if (missing.size) this.report.skipped.push(t("engine.pdf.edit.charsDropped", { chars: [...missing].join("") }));
    return out;
  }

  fallbackFontIfLoaded(): Promise<PDFFont | null> | null {
    return this.fallback;
  }

  /** resource name of the fallback font in the given resource owner */
  async fallbackName(owner: ResOwner): Promise<string | null> {
    const f = await this.fallbackFont();
    if (!f) return null;
    const k = owner.key;
    let n = this.fbNames.get(k);
    if (!n) this.fbNames.set(k, (n = addResource(this, owner, "Font", f.ref, "OmwFb")));
    return n;
  }

  private gsRefs = new Map<number, PDFRef>();
  private gsNames = new Map<string, string>();

  /** resource name of an ExtGState with fill and stroke alpha `alpha` (ca/CA) in the given owner */
  gsName(owner: ResOwner, alpha: number): string {
    const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
    let ref = this.gsRefs.get(a);
    if (!ref) this.gsRefs.set(a, (ref = this.doc.ctx.register(this.doc.ctx.obj({ Type: "ExtGState", ca: a, CA: a }))));
    const k = `${owner.key}|${a}`;
    let n = this.gsNames.get(k);
    if (!n) this.gsNames.set(k, (n = addResource(this, owner, "ExtGState", ref, "OmwGs")));
    return n;
  }

  async imageName(owner: ResOwner, assetId: string): Promise<{ name: string; w: number; h: number } | null> {
    let e = this.imgNames.get(assetId);
    if (e === undefined) {
      const src = this.opts.imageBytes?.(assetId);
      e = null;
      if (src) {
        try {
          const img = /png/.test(src.mime) ? await this.doc.pdf.embedPng(src.bytes) : /jpe?g/.test(src.mime) ? await this.doc.pdf.embedJpg(src.bytes) : null;
          if (img) e = { ref: img.ref, w: img.width, h: img.height };
        } catch (err) {
          this.report.skipped.push(t("engine.pdf.edit.imageFailed", { error: (err as Error).message }));
        }
      }
      this.imgNames.set(assetId, e);
    }
    if (!e) return null;
    return { name: addResource(this, owner, "XObject", e.ref, "OmwIm"), w: e.w, h: e.h };
  }
}

/** Who owns the resources of a stream: a page dictionary or a Form XObject dictionary. */
interface ResOwner {
  key: string;
  dict: PDFDict;
  ref: PDFRef | null;
  inherited: PDFDict | undefined;
}

function addResource(se: Session, owner: ResOwner, cat: string, value: PDFRef, base: string): string {
  const ctx = se.doc.ctx;
  const raw = owner.dict.get(PDFName.of("Resources"));
  let res: PDFDict;
  if (raw instanceof PDFRef && ctx.lookup(raw) instanceof PDFDict) {
    res = ctx.lookup(raw) as PDFDict;
    se.mark(raw);
  } else if (raw instanceof PDFDict) {
    res = raw;
    se.mark(owner.ref);
  } else {
    res = owner.inherited ? cloneDict(ctx, owner.inherited) : (ctx.obj({}) as PDFDict);
    owner.dict.set(PDFName.of("Resources"), res);
    se.mark(owner.ref);
  }
  const rawCat = res.get(PDFName.of(cat));
  let catDict: PDFDict;
  const resolved = look(ctx, rawCat);
  if (rawCat instanceof PDFRef && resolved instanceof PDFDict) {
    catDict = cloneDict(ctx, resolved); // copy-on-write: the category dictionary may be shared
    res.set(PDFName.of(cat), catDict);
  } else if (resolved instanceof PDFDict) catDict = resolved;
  else {
    catDict = ctx.obj({}) as PDFDict;
    res.set(PDFName.of(cat), catDict);
  }
  let i = 0;
  while (catDict.has(PDFName.of(`${base}${i}`))) i++;
  const name = `${base}${i}`;
  catDict.set(PDFName.of(name), value);
  return name;
}

function ownerOf(se: Session, model: PageModel, unitKey: string): ResOwner {
  const doc = se.doc;
  const pd = pageDict(doc, model.pageIndex);
  const pageInherited = dictOf(inherited(doc.ctx, pd, "Resources"));
  if (unitKey === "page") return { key: `page${model.pageIndex}`, dict: pd, ref: doc.pageRefs[model.pageIndex], inherited: pageInherited };
  const u = model.analysis.units.get(unitKey)!;
  const st = doc.ctx.lookup(u.formRef!) as PDFStream;
  return { key: unitKey, dict: st.dict, ref: null, inherited: pageInherited };
}

// ───────── text ─────────

/** Map page coordinates of the Omniweave page to the PDF page's px space (PdfNode placement). */
function makeToPdfPx(input: PageEditInput, model: PageModel) {
  const pn = input.pdfNode;
  if (!pn) return (p: [number, number]) => p;
  const k = model.width / (pn.width || model.width);
  return (p: [number, number]): [number, number] => {
    const q = invertTransform(pn.transform, p);
    return [q[0] * k, q[1] * k];
  };
}

function baselineOrigin(n: TextNode, toPx: (p: [number, number]) => [number, number]) {
  const size = n.paragraphs[0]?.runs[0]?.fontSize ?? 12;
  const th = (n.transform.rotation * Math.PI) / 180;
  const h = BASELINE * size * n.transform.scale;
  return toPx([n.transform.x - h * Math.sin(th), n.transform.y + h * Math.cos(th)]);
}

function neutralizeText(se: Session, line: TextLine, ops: Op[]) {
  for (const s of line.shows) {
    const o = ops[s.op];
    let text = " ";
    if (o.op === "'") text = " T* ";
    else if (o.op === '"') text = ` ${serialize(o.args[0] ?? 0)} Tw ${serialize(o.args[1] ?? 0)} Tc T* `;
    se.splice(line.unit, { s: o.s, e: o.e, text });
  }
}

/** Width in unscaled text space (before Tz) of `text` written the way emitText writes it with `sh`'s state. */
async function writtenWidth(se: Session, sh: TextLine["runs"][0]["show"], text: string): Promise<number | null> {
  let w = 0;
  for (const seg of sh.font.encode(text)) {
    if (seg.bytes) {
      for (const { code, len } of sh.font.codes(seg.bytes)) w += sh.font.advance(code) * sh.fontSize + sh.tc + (code === 32 && len === 1 ? sh.tw : 0);
    } else {
      const font = await se.fallbackFont();
      if (!font) return null;
      const d = await se.fallbackDrawable(seg.text);
      if (d) w += font.widthOfTextAtSize(d, sh.fontSize) + sh.tc * [...d].length;
    }
  }
  return w;
}

async function emitText(se: Session, model: PageModel, line: TextLine, cur: TextNode, toPx: (p: [number, number]) => [number, number]): Promise<string | null> {
  const first = line.shows[0], last = line.shows[line.shows.length - 1];
  const P0 = first.start;
  const o0 = baselineOrigin(line.node, (p) => p);
  const o1 = baselineOrigin(cur, toPx);
  const r0 = (line.node.transform.rotation * Math.PI) / 180, r1 = (cur.transform.rotation * Math.PI) / 180;
  const kx = cur.transform.scale / (line.node.transform.scale || 1);
  const ky = scaleYOf(cur.transform) / (scaleYOf(line.node.transform) || 1);
  // undo the original rotation, scale in the node's own axes (x / y may differ), apply the new rotation
  // (for a uniform scale this is rotate(r1 − r0) · k)
  const delta = mul(mul(rotate(-r0), [kx, 0, 0, ky, 0, 0]), rotate(r1));
  const Pn = mul(mul(mul(P0, translate(-o0[0], -o0[1])), delta), translate(o1[0], o1[1]));
  const baseInv = inv(last.base);
  if (!baseInv) return null;
  const Tm0 = mul(Pn, baseInv);
  const yScale = Math.hypot(Pn[2], Pn[3]) || 1;
  const owner = ownerOf(se, model, line.unit);
  const srcRuns = line.runs;
  const origRuns = line.node.paragraphs[0].runs;
  const pickSrc = (r: TextNode["paragraphs"][0]["runs"][0], idx: number) => {
    if (cur.paragraphs.length === 1 && cur.paragraphs[0].runs.length === srcRuns.length) return srcRuns[idx] ? { src: srcRuns[idx], orig: origRuns[idx] } : null;
    let k = origRuns.findIndex((o) => o.bold === r.bold && o.italic === r.italic && o.fontFamily === r.fontFamily);
    if (k < 0) k = 0;
    return { src: srcRuns[k], orig: origRuns[k] };
  };
  let out = "\nq BT\n";
  let lineY = 0;
  for (let pi = 0; pi < cur.paragraphs.length; pi++) {
    const para = cur.paragraphs[pi];
    if (pi > 0) {
      const prevSize = Math.max(...cur.paragraphs[pi - 1].runs.map((r) => r.fontSize), 1);
      lineY += (prevSize * (cur.paragraphs[pi - 1].lineSpacing || LINE_SPACING) * Math.abs(scaleYOf(cur.transform))) / yScale;
    }
    out += `${mStr(mul(translate(0, -lineY), Tm0))} Tm\n`;
    for (let ri = 0; ri < para.runs.length; ri++) {
      const r = para.runs[ri];
      if (!r.text) continue;
      const pick = pickSrc(r, ri) ?? { src: srcRuns[0], orig: origRuns[0] };
      const sh = pick.src.show;
      const size = sh.fontSize * (r.fontSize / (pick.orig.fontSize || r.fontSize));
      const sameColor = r.color.toLowerCase() === pick.orig.color.toLowerCase();
      const rgb = parseCss(r.color) ?? [0, 0, 0];
      out += sameColor ? `${sh.fill.replay} ${sh.stroke.replay}\n` : `${rgbOp(rgb, "rg")} ${rgbOp(rgb, "RG")}\n`;
      // the original run's width (elevate.ts pdfWidth) against its text as written here: the difference (TJ gaps,
      // word gaps) spread over its characters as Tc, so a re-written line keeps the original's spacing
      let tc = sh.tc;
      const n0 = [...pick.orig.text].length;
      if (pick.src.pdfWidth !== undefined && n0 > 1) {
        const nat = await writtenWidth(se, sh, pick.orig.text);
        const extra = nat === null ? 0 : (pick.src.pdfWidth - nat) / n0;
        if (Math.abs(extra) > 1e-4 && Math.abs(extra) < Math.abs(sh.fontSize) * 0.4) tc += extra * (size / (sh.fontSize || size));
      }
      out += `${num(tc)} Tc ${num(sh.tw)} Tw ${num(sh.tz)} Tz ${num(sh.ts)} Ts ${sh.tr} Tr\n`;
      for (const seg of sh.font.encode(r.text)) {
        if (seg.bytes) out += `${serialize(new PdfName(sh.fontRes))} ${num(size)} Tf ${hexOf(seg.bytes)} Tj\n`;
        else {
          const fb = await se.fallbackName(owner);
          const font = await se.fallbackFont();
          if (!fb || !font) {
            se.report.skipped.push(t("engine.pdf.edit.noFallbackFont", { text: seg.text }));
            continue;
          }
          const drawable = await se.fallbackDrawable(seg.text);
          if (!drawable) continue;
          se.report.fallbackChars.push(...Array.from(drawable).filter((c) => c.trim()));
          out += `/${fb} ${num(size)} Tf ${font.encodeText(drawable).toString()} Tj\n`;
        }
      }
    }
  }
  return out + "ET Q\n";
}

// ───────── vectors ─────────

function pathOps(contours: Contour[], map: (p: [number, number]) => [number, number]): string {
  let s = "";
  const P = (p: readonly number[]) => {
    const q = map([p[0], p[1]]);
    return `${num(q[0])} ${num(q[1])}`;
  };
  const seg = (a: Contour["nodes"][0], b: Contour["nodes"][0]) => {
    const straight = a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1] && b.handleIn[0] === b.anchor[0] && b.handleIn[1] === b.anchor[1];
    return straight ? `${P(b.anchor)} l\n` : `${P(a.handleOut)} ${P(b.handleIn)} ${P(b.anchor)} c\n`;
  };
  for (const c of contours) {
    if (!c.nodes.length) continue;
    s += `${P(c.nodes[0].anchor)} m\n`;
    for (let i = 1; i < c.nodes.length; i++) s += seg(c.nodes[i - 1], c.nodes[i]);
    if (c.closed) {
      if (c.nodes.length > 1) s += seg(c.nodes[c.nodes.length - 1], c.nodes[0]);
      s += "h\n";
    }
  }
  return s;
}

function paintOp(fill: boolean, stroke: boolean, evenOdd: boolean) {
  if (fill && stroke) return evenOdd ? "B*" : "B";
  if (fill) return evenOdd ? "f*" : "f";
  return stroke ? "S" : "n";
}

/** The interpreter's path segments (user space at the paint operator) as path construction operators. */
function segOps(segs: readonly { op: string; pts: readonly number[] }[]): string {
  let s = "";
  for (const g of segs) {
    if (g.op === "h") s += "h\n";
    else s += `${g.pts.map((v) => num(v)).join(" ")} ${g.op}\n`;
  }
  return s;
}

const PATH_OPS = new Set(["m", "l", "c", "v", "y", "h", "re", "W", "W*"]);
const closeIfNeeded = (path: string, paintOp: string) => path + (paintOp === "s" || paintOp === "b" || paintOp === "b*" ? " h\n" : "\n");

/**
 * Re-paint an edited path. The original path construction and everything between it and the paint
 * operator stay byte-identical (pdf-lib's drawEllipse builds the path inside `q … Q` and paints after
 * the `Q`, so colour operators placed before or inside that range are undone by the `Q`). Only the
 * paint operator is replaced: by `n` (end the path without painting, any `W` clip still applies),
 * followed by `q <changed state> <path> <paint> Q` — the inserted `q` inherits exactly the graphics
 * state that was in effect at the original paint operator, so unchanged colours/patterns stay as they were.
 */
function emitVector(v: VectorItem, cur: VectorNode, toPx: (p: [number, number]) => [number, number], pathOnly: string | null, paintState = ""): string | null {
  const p = v.path;
  const orig = v.node;
  const baseInv = inv(p.base);
  if (!baseInv) return null;
  // a plain path object (only construction operators before the paint) is replaced as a whole
  let s = pathOnly == null ? "n\nq\n" : "\nq\n";
  // the path was built under p.base; the inserted q starts from the CTM at the paint operator
  const toBase = mul(p.base, inv(p.paintBase) ?? [1, 0, 0, 1, 0, 0]);
  if (toBase.some((x, i) => !close(x, [1, 0, 0, 1, 0, 0][i], 1e-9))) s += `${mStr(toBase)} cm\n`;
  const fill = parseCss(cur.fill), stroke = parseCss(cur.stroke);
  // an unchanged colour is not written: the inserted q inherits the original operators (k/K, cs/scn …)
  if ((cur.fill ?? "").toLowerCase() !== (orig.fill ?? "").toLowerCase() && fill) s += colorOpLike(fill, p.fill, false) + "\n";
  if ((cur.stroke ?? "").toLowerCase() !== (orig.stroke ?? "").toLowerCase() && stroke) s += colorOpLike(stroke, p.stroke, true) + "\n";
  if (!close(cur.strokeWidth, orig.strokeWidth, 1e-3)) s += `${num(cur.strokeWidth / (scaleOf(p.base) || 1))} w\n`;
  s += paintState;
  const sameGeom = geomSig(orig.contours) === geomSig(cur.contours) && sameTransform(orig.transform, cur.transform);
  if (sameGeom) s += pathOnly ?? segOps(p.segs);
  else {
    const t = cur.transform;
    s += pathOps(cur.contours, (q) => {
      const page = applyTransform(t, q);
      const px = toPx([page[0], page[1]]);
      const u = [baseInv[0] * px[0] + baseInv[2] * px[1] + baseInv[4], baseInv[1] * px[0] + baseInv[3] * px[1] + baseInv[5]];
      return [u[0], u[1]];
    });
  }
  s += paintOp(!!fill, !!stroke, cur.fillRule === "evenodd") + "\nQ\n";
  return s;
}

// ───────── gradient shapes ─────────

const paintsOf = (n: VectorNode, key: "fills" | "strokes"): Paint | undefined =>
  key === "fills" ? (n as VectorNode & { fills?: Paint[] }).fills?.[0] : (n as VectorNode & { strokes?: { paint: Paint }[] }).strokes?.[0]?.paint;
const paintsChanged = (a: VectorNode, b: VectorNode, key: "fills" | "strokes") => JSON.stringify(paintsOf(a, key) ?? null) !== JSON.stringify(paintsOf(b, key) ?? null);

/** Node-local point → the analysed page's px (the space the PDF model and its matrices use). */
const localToPx = (cur: VectorNode, toPx: (p: [number, number]) => [number, number]) => (q: [number, number]): [number, number] => {
  const page = applyTransform(cur.transform, q);
  return toPx([page[0], page[1]]);
};

/** A gradient's unit (box) coordinates of `cur` → page px → `then`. */
function gradientAt(cur: VectorNode, toPx: (p: [number, number]) => [number, number], then: (px: [number, number]) => [number, number]) {
  const b = paintBox(cur), L = localToPx(cur, toPx);
  return (u: [number, number]): [number, number] => then(L([b.x + u[0] * b.w, b.y + u[1] * b.h]));
}

/**
 * An edited gradient shape (clip path + sh): `q <path> W n /Sh sh Q` in the user space of the original clip path,
 * with a new shading. Opacity stops: a luminosity soft mask of their grey shading, written the way Illustrator writes
 * an opacity mask (a non-isolated grey group, perceptual intent), so Illustrator shows it as it shows its own; for an
 * Illustrator file the grey is the one Illustrator shows as that opacity (elevate.ts maskFade). Null when it cannot
 * be written so (no gradient fill, a degenerate matrix).
 */
function shadedShape(se: Session, model: PageModel, v: VectorItem, cur: VectorNode, toPx: (p: [number, number]) => [number, number], illustrator: boolean): string | null {
  const g = paintsOf(cur, "fills");
  const back = inv(v.path.base);
  if (!drawableGradient(g) || !back || !cur.fill) return null;
  const ctx = se.doc.ctx;
  const user = (px: [number, number]): [number, number] => apply(back, px[0], px[1]);
  const L = localToPx(cur, toPx);
  const at = gradientAt(cur, toPx, user);
  const owner = ownerOf(se, model, v.path.unit);
  const name = addResource(se, owner, "Shading", ctx.register(shadingDict(ctx, g, at)), "OmwSh");
  const path = pathOps(cur.contours, (q) => user(L(q)));
  let gs = "";
  if (gradientFades(g)) {
    const grey = (a: number) => (illustrator ? Math.min(1, Math.max(0, (a - 0.115) / 0.885)) : a);
    const mg: GradientPaint = { ...g, stops: g.stops.map((x) => ({ ...x, color: { hex: x.color.hex, a: Math.round(grey(x.color.a ?? 1) * 1e4) / 1e4 } })) };
    const form = ctx.stream("q 0 g /Perceptual ri BX /A sh EX Q", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [-32768, 32767, 32767, -32768],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { Shading: { A: ctx.register(shadingDict(ctx, mg, at, true)) } },
      Group: ctx.register(ctx.obj({ Type: "Group", S: "Transparency", I: false, K: false, CS: "DeviceGray" })),
    });
    const mask = ctx.obj({ Type: "ExtGState", AIS: false, BM: "Normal", CA: 1, ca: 1, OP: false, op: false, OPM: 1, SA: true, SMask: ctx.register(ctx.obj({ Type: "Mask", S: "Luminosity", G: ctx.register(form) })) });
    gs = `/${addResource(se, owner, "ExtGState", ctx.register(mask), "OmwGS")} gs\n`;
  }
  return `\nq\n${path}${cur.fillRule === "evenodd" ? "W*" : "W"} n\nq\n/Perceptual ri\n${gs}BX\n/${name} sh\nEX\nQ\nQ\n`;
}

/** The colour operators of a changed gradient fill / stroke of a pattern-painted path: new shading patterns. */
function patternState(se: Session, model: PageModel, v: VectorItem, cur: VectorNode, toPx: (p: [number, number]) => [number, number]): string | null {
  const u = model.analysis.units.get(v.path.unit);
  const back = u?.space ? inv(u.space) : null;
  if (!back) return null;
  let s = "";
  for (const key of ["fills", "strokes"] as const) {
    if (!paintsChanged(v.node, cur, key)) continue;
    const g = paintsOf(cur, key);
    if (!g) continue; // went plain: the plain colour is written by emitVector
    if (!drawableGradient(g) || gradientFades(g)) return null;
    const ctx = se.doc.ctx;
    const sh = shadingDict(ctx, g as GradientPaint, gradientAt(cur, toPx, (px) => apply(back, px[0], px[1])));
    const ref = ctx.register(ctx.obj({ Type: "Pattern", PatternType: 2, Shading: sh, Matrix: [1, 0, 0, 1, 0, 0] }));
    const name = addResource(se, ownerOf(se, model, v.path.unit), "Pattern", ref, "OmwP");
    s += key === "fills" ? `/Pattern cs /${name} scn\n` : `/Pattern CS /${name} SCN\n`;
  }
  return s;
}

// ───────── added nodes (appended to the page) ─────────

const nodeMatrix = (t: Transform): M => {
  const a = (t.rotation * Math.PI) / 180;
  // local → page: scale (x: scale, y: scaleY — absent = scale, negative = flip), then rotate, then move
  const c = Math.cos(a), s = Math.sin(a), sx = t.scale, sy = scaleYOf(t);
  return [c * sx, s * sx, -s * sy, c * sy, t.x, t.y];
};

/** synthetic italic: horizontal shear of the text matrix (about 11°, what viewers use for oblique) */
const ITALIC_SLANT = 0.2;
/** synthetic bold: glyph outline stroke width as a fraction of the font size */
const BOLD_STROKE = 0.03;

async function emitAdded(se: Session, n: SceneNode, owner: ResOwner, toPdfM: M): Promise<string | null> {
  const m = mul(nodeMatrix(n.transform), toPdfM);
  // node opacity → ExtGState ca/CA (applied per painting operation: where a node's own fill, stroke or
  // glyphs overlap they compound, unlike the screen's whole-node opacity)
  const gs = n.opacity < 1 && (n.type === "VECTOR" || n.type === "IMAGE" || n.type === "TEXT") ? `/${se.gsName(owner, n.opacity)} gs ` : "";
  if (n.type === "VECTOR") {
    const fill = parseCss(n.fill), stroke = parseCss(n.stroke);
    let s = `q ${mStr(m)} cm ${gs}\n`;
    if (fill) s += rgbOp(fill, "rg") + "\n";
    if (stroke) s += `${rgbOp(stroke, "RG")} ${num(n.strokeWidth)} w\n`;
    return s + pathOps(n.contours, (p) => p) + paintOp(!!fill, !!stroke, n.fillRule === "evenodd") + "\nQ\n";
  }
  if (n.type === "IMAGE") {
    const img = await se.imageName(owner, n.assetId);
    if (!img) return null;
    // non-destructive crop → clip in node space (the image stays whole in the file, as in the vector export)
    const clipOp = n.crop ? `${num(n.crop.x)} ${num(n.crop.y)} ${num(n.crop.w)} ${num(n.crop.h)} re W n ` : "";
    return `q ${mStr(m)} cm ${gs}${clipOp}${num(n.width)} 0 0 ${num(-n.height)} 0 ${num(n.height)} cm /${img.name} Do Q\n`;
  }
  if (n.type === "TEXT") {
    const fb = await se.fallbackName(owner);
    const font = await se.fallbackFont();
    if (!fb || !font) return null;
    // One fallback font (no bold/italic faces), so bold and italic are synthetic: bold strokes the glyph
    // outlines in the text colour (Tr 2), italic slants the text matrix; underline is a filled bar.
    let s = `q ${mStr(m)} cm ${gs}BT\n`;
    const bars: string[] = [];
    let y = 0;
    for (const p of n.paragraphs) {
      const size = Math.max(...p.runs.map((r) => r.fontSize), 1);
      const h = size * (p.lineSpacing || 1.2);
      const base = y + (h - size) / 2 + size * 0.8;
      let x = p.indent + (p.indentLeft ?? 0);
      for (const r of p.runs) {
        const drawable = r.text ? await se.fallbackDrawable(r.text) : "";
        if (!drawable) continue;
        const rgb = parseCss(r.color) ?? [0, 0, 0];
        const w = font.widthOfTextAtSize(drawable, r.fontSize);
        s += `1 0 ${r.italic ? ITALIC_SLANT : 0} -1 ${num(x)} ${num(base)} Tm ${rgbOp(rgb, "rg")} `;
        s += r.bold ? `${rgbOp(rgb, "RG")} ${num(r.fontSize * BOLD_STROKE)} w 2 Tr ` : "0 Tr ";
        s += `/${fb} ${num(r.fontSize)} Tf ${font.encodeText(drawable).toString()} Tj\n`;
        if (r.underline) bars.push(`${rgbOp(rgb, "rg")} ${num(x)} ${num(base + r.fontSize * 0.1)} ${num(w)} ${num(Math.max(0.5, r.fontSize * 0.06))} re f\n`);
        x += w;
      }
      y += h + p.spaceAfter;
    }
    return s + "ET\n" + bars.join("") + "Q\n";
  }
  se.report.skipped.push(t("engine.pdf.edit.objectUnsupported", { name: n.name, type: n.type }));
  return null;
}

// ───────── streams ─────────

function applySplices(bytes: Uint8Array, list: Splice[]): Uint8Array {
  const sorted = [...list].sort((a, b) => a.s - b.s || a.e - b.e);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const sp of sorted) {
    if (sp.s < at) throw new Error(t("engine.pdf.edit.overlap"));
    parts.push(bytes.subarray(at, sp.s), latin1Bytes(sp.text));
    at = sp.e;
  }
  parts.push(bytes.subarray(at));
  return concat(parts);
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

function newStream(se: Session, bytes: Uint8Array, from?: PDFDict): PDFRawStream {
  const st = se.doc.ctx.flateStream(bytes);
  if (from) for (const [k, v] of from.entries()) if (!["Length", "Filter", "DecodeParms", "DL"].includes(k.decodeText())) st.dict.set(k, v);
  return st;
}

function finishUnits(se: Session, model: PageModel, appended: string) {
  const doc = se.doc;
  const pd = pageDict(doc, model.pageIndex);
  const pageRef = doc.pageRefs[model.pageIndex];
  for (const [key, list] of se.splices) {
    const unit = model.analysis.units.get(key);
    if (!unit || !list.length) continue;
    const bytes = applySplices(unit.bytes, list);
    if (key === "page") {
      const body = appended ? concat([latin1Bytes("q\n"), bytes, latin1Bytes("\nQ\n" + appended)]) : bytes;
      const ref = doc.ctx.register(newStream(se, body));
      pd.set(PDFName.of("Contents"), ref);
      se.mark(ref);
      se.mark(pageRef);
    } else {
      const st = doc.ctx.lookup(unit.formRef!) as PDFStream;
      doc.ctx.assign(unit.formRef!, newStream(se, bytes, st.dict));
      se.mark(unit.formRef);
    }
  }
  if (appended && !se.splices.get("page")?.length) {
    // keep the original content streams as they are: wrap them between two new streams
    const pre = doc.ctx.register(newStream(se, latin1Bytes("q\n")));
    const post = doc.ctx.register(newStream(se, latin1Bytes("\nQ\n" + appended)));
    const parts = contentParts(doc, model.pageIndex);
    pd.set(PDFName.of("Contents"), doc.ctx.obj([pre, ...parts, post]));
    se.mark(pre);
    se.mark(post);
    se.mark(pageRef);
  }
  se.splices.clear();
}

// ───────── verification ─────────

const rgb255 = (c: string | null | undefined) => {
  const v = parseCss(c);
  return v ? v.map((x) => Math.round(x * 255)).join(",") : "none";
};

/**
 * Re-interpret the written page and count a vector as edited only when the colours the reader now
 * sees at its paint operator are the requested ones (the report must not claim edits that a viewer
 * would not show).
 */
function verifyVectors(se: Session, pageIndex: number, opts: SaveOptions, edited: { id: string; name: string; cur: VectorNode }[]) {
  let after: PageModel;
  try {
    after = modelPage(se.doc, pageIndex, { ...opts, vectors: true });
  } catch (err) {
    se.report.skipped.push(t("engine.pdf.edit.verifyFailed", { error: (err as Error).message }));
    return;
  }
  const byId = new Map(after.vectors.map((v) => [v.id, v.node]));
  for (const e of edited) {
    const got = byId.get(e.id);
    const ok = !!got && (!e.cur.fill || rgb255(got.fill) === rgb255(e.cur.fill)) && (!e.cur.stroke || rgb255(got.stroke) === rgb255(e.cur.stroke));
    if (ok) se.report.editedVectors++;
    else se.report.skipped.push(t("engine.pdf.edit.colorMismatch", { name: e.name }));
  }
}

// ───────── page order ─────────

function reorderPages(se: Session, order: number[]) {
  const doc = se.doc;
  const ctx = doc.ctx;
  const rootRef = doc.pdf.catalog.get(PDFName.of("Pages"));
  if (!(rootRef instanceof PDFRef)) throw new Error(t("engine.pdf.edit.rootNotIndirect"));
  const root = ctx.lookup(rootRef) as PDFDict;
  const kids: PDFRef[] = [];
  for (const i of order) {
    const ref = doc.pageRefs[i];
    const pd = pageDict(doc, i);
    for (const k of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
      if (pd.get(PDFName.of(k)) !== undefined) continue;
      const parent = dictOf(look(ctx, pd.get(PDFName.of("Parent"))));
      const v = parent ? inheritedRaw(ctx, parent, k) : undefined;
      if (v !== undefined) pd.set(PDFName.of(k), v);
    }
    pd.set(PDFName.of("Parent"), rootRef);
    kids.push(ref);
    se.mark(ref);
  }
  root.set(PDFName.of("Kids"), ctx.obj(kids));
  root.set(PDFName.of("Count"), PDFNumber.of(kids.length));
  se.mark(rootRef);
  se.report.pagesReordered = true;
}

function inheritedRaw(ctx: SurgeonDoc["ctx"], node: PDFDict, key: string) {
  let n: PDFDict | undefined = node;
  for (let g = 0; n && g < 64; g++) {
    const v = n.get(PDFName.of(key));
    if (v !== undefined) return v;
    n = dictOf(look(ctx, n.get(PDFName.of("Parent"))));
  }
  return undefined;
}

// ───────── entry point ─────────

/**
 * Apply Omniweave edits to a (forked) surgeon document. Returns the new file bytes, or the
 * original bytes untouched when nothing changed.
 */
export async function applyEdits(doc: SurgeonDoc, inputs: PageEditInput[], opts: SaveOptions): Promise<{ bytes: Uint8Array; report: SaveReport }> {
  const se = new Session(doc, opts);
  // a file without a usable startxref can still be "saved" unchanged; edits need the xref (checked on write)
  let firstNew = doc.ctx.largestObjectNumber + 1;
  try {
    firstNew = Math.max(firstNew, lastXref(doc.plain).size);
  } catch {
    /* writeIncremental re-checks and refuses */
  }
  reserveNumbers(doc.ctx, firstNew);
  // models first: they must see the untouched objects
  const models = new Map<number, PageModel>();
  for (const inp of inputs) if (inp.elevated) models.set(inp.pageIndex, modelPage(doc, inp.pageIndex, opts));
  // edits to mirror into Illustrator's private data (AI files); `aiWhy` = why they cannot be mirrored
  const ai = isIllustratorPdf(doc);
  const mirror: AiMirror = { texts: [], styles: [], pagePaths: new Map() };
  let aiWhy = "";
  const block = (key: string) => (aiWhy ||= t(key));

  for (const inp of inputs) {
    const model = models.get(inp.pageIndex) ?? modelPage(doc, inp.pageIndex, { ...opts, vectors: false });
    const byId = new Map(inp.nodes.map((n) => [n.id, n]));
    const toPx = makeToPdfPx(inp, model);
    const edited: { id: string; name: string; cur: VectorNode }[] = [];
    if (ai) mirror.pagePaths.set(inp.pageIndex, model.analysis.items.flatMap((it) => (it.kind === "path" ? [pdfPoints(it, model)] : [])));
    if (inp.elevated) {
      for (const line of model.lines) {
        const ops = model.analysis.units.get(line.unit)!.ops;
        const cur = byId.get(line.id);
        if (!cur || cur.type !== "TEXT" || !cur.visible) {
          neutralizeText(se, line, ops);
          se.report.deletedText++;
          block("engine.ai.why.delete");
          continue;
        }
        if (!textChanged(line.node, cur, toPx)) continue;
        const text = await emitText(se, model, line, cur, toPx);
        if (text == null) {
          se.report.skipped.push(t("engine.pdf.edit.degenerateMatrix", { name: line.node.name }));
          continue;
        }
        neutralizeText(se, line, ops);
        const etOp = ops[line.shows[line.shows.length - 1].et];
        se.splice(line.unit, { s: etOp.e, e: etOp.e, text });
        se.report.editedText++;
        if (ai) {
          if (textOnlyChanged(line.node, cur, toPx)) mirror.texts.push({ from: plainText(line.node), to: plainText(cur) });
          else block("engine.ai.why.textStyle");
        }
      }
      for (const v of model.vectors) {
        // a gradient-filled shape (clip path + shading): deleting it takes the shading out (the clip alone draws
        // nothing); its other edits are not written into the PDF yet — the original stays, said in the report
        if (v.shade) {
          const cur = byId.get(v.id);
          const su = model.analysis.units.get(v.shade.unit)!;
          if (!cur || cur.type !== "VECTOR" || !cur.visible) {
            se.splice(v.shade.unit, { s: su.ops[v.shade.op].s, e: su.ops[v.shade.op].e, text: " " });
            se.report.deletedVectors++;
            block("engine.ai.why.delete");
          } else if (vectorChanged(v.node, cur) || paintsChanged(v.node, cur, "fills")) {
            // the changed shape and gradient go in where the original was drawn (before its clip path), the
            // original shading comes out; a fading one (opacity stops) keeps its original look
            const text = shadedShape(se, model, v, cur, toPx, hasIllustratorData(doc, inp.pageIndex) || illustratorMarked(doc));
            if (text == null) se.report.skipped.push(t("engine.pdf.edit.gradientKept", { name: v.node.name }));
            else {
              const cu = model.analysis.units.get(v.path.unit)!;
              se.splice(v.path.unit, { s: cu.ops[v.path.first].s, e: cu.ops[v.path.first].s, text });
              se.splice(v.shade.unit, { s: su.ops[v.shade.op].s, e: su.ops[v.shade.op].e, text: " " });
              se.report.editedVectors++;
              block("engine.ai.why.shape");
            }
          }
          continue;
        }
        const unit = model.analysis.units.get(v.path.unit)!;
        // A plain path object (construction operators, then the paint) is replaced as a whole. When the
        // producer put other operators in between (pdf-lib drawEllipse: `q m c… Q f`), only the paint
        // operator is replaced, so the q/Q nesting and the graphics state at the paint are never broken.
        const plain = unit.ops.slice(v.path.first, v.path.paint).every((o) => PATH_OPS.has(o.op));
        const range = plain ? { s: unit.ops[v.path.first].s, e: unit.ops[v.path.paint].e } : { s: unit.ops[v.path.paint].s, e: unit.ops[v.path.paint].e };
        const pathOnly = plain ? closeIfNeeded(new TextDecoder("latin1").decode(unit.bytes.subarray(unit.ops[v.path.first].s, unit.ops[v.path.paint].s)), v.path.paintOp) : null;
        const cur = byId.get(v.id);
        if (!cur || cur.type !== "VECTOR" || !cur.visible) {
          se.splice(v.path.unit, { ...range, text: plain ? " " : "n" });
          se.report.deletedVectors++;
          block("engine.ai.why.delete");
          continue;
        }
        const gradEdit = v.pattern && (paintsChanged(v.node, cur, "fills") || paintsChanged(v.node, cur, "strokes"));
        if (!vectorChanged(v.node, cur) && !gradEdit) continue;
        // a gradient fill / stroke (shading pattern) changed: a new pattern for it
        const paintState = gradEdit ? patternState(se, model, v, cur, toPx) : "";
        if (paintState == null) {
          se.report.skipped.push(t("engine.pdf.edit.gradientKept", { name: v.node.name }));
          continue;
        }
        const text = emitVector(v, cur, toPx, pathOnly, paintState);
        if (text == null) {
          se.report.skipped.push(t("engine.pdf.edit.degenerateMatrix", { name: v.node.name }));
          continue;
        }
        if (ai) {
          const o = v.node;
          const sameShape = geomSig(o.contours) === geomSig(cur.contours) && sameTransform(o.transform, cur.transform) && o.fillRule === cur.fillRule;
          const widthOk = o.strokeWidth > 0 || close(o.strokeWidth, cur.strokeWidth, 1e-3);
          if (sameShape && widthOk)
            mirror.styles.push({
              pageIndex: inp.pageIndex,
              points: pdfPoints(v.path, model),
              fill: parseCss(cur.fill),
              stroke: parseCss(cur.stroke),
              fillChanged: (o.fill ?? "").toLowerCase() !== (cur.fill ?? "").toLowerCase(),
              strokeChanged: (o.stroke ?? "").toLowerCase() !== (cur.stroke ?? "").toLowerCase(),
              widthScale: o.strokeWidth > 0 ? cur.strokeWidth / o.strokeWidth : 1,
            });
          else block("engine.ai.why.shape");
        }
        se.splice(v.path.unit, { ...range, text });
        if (v.pattern) se.report.editedVectors++;
        else edited.push({ id: v.id, name: v.node.name, cur });
      }
    }
    // nodes that did not come from this PDF page are appended on top
    let appended = "";
    const added = inp.nodes.filter((n) => n.type !== "PDF" && n.visible && !isSurgeonId(n.id, opts.prefix, inp.pageIndex));
    const covers = (inp.covers ?? []).filter((c) => c.w > 0 && c.h > 0 && parseCss(c.color));
    if (inp.pdfNode?.crop)
      se.report.skipped.push(t("engine.pdf.edit.cropIgnored"));
    if (added.length || covers.length) {
      block("engine.ai.why.add");
      const owner = ownerOf(se, model, "page");
      const vpInv = inv(model.viewport)!;
      const pn = inp.pdfNode;
      const k = pn ? model.width / (pn.width || model.width) : 1;
      const pageToPx: M = pn ? mul(inv(nodeMatrix(pn.transform))!, [k, 0, 0, k, 0, 0]) : [1, 0, 0, 1, 0, 0];
      const toPdf = mul(pageToPx, vpInv);
      for (const c of covers) appended += `q ${mStr(toPdf)} cm ${rgbOp(parseCss(c.color)!, "rg")} ${num(c.x)} ${num(c.y)} ${num(c.w)} ${num(c.h)} re f Q\n`;
      for (const n of added) {
        const s = await emitAdded(se, n, owner, toPdf);
        if (s) (appended += s), se.report.addedNodes++;
      }
    }
    finishUnits(se, model, appended);
    if (edited.length) verifyVectors(se, inp.pageIndex, opts, edited);
  }

  const order = opts.pageOrder;
  if (order && (order.length !== doc.pageRefs.length || order.some((p, i) => p !== i))) {
    reorderPages(se, order);
    block("engine.ai.why.pages");
  }

  if (se.dirty.length && ai) {
    // Illustrator reads its private data first: mirror the edits there, or remove it so Illustrator reads the
    // edited PDF content (layers then merge into one in Illustrator — the caller tells the person why)
    let why = aiWhy;
    if (!why) {
      let r: ReturnType<typeof mirrorIllustratorEdits>;
      try {
        r = mirrorIllustratorEdits(doc, (ref) => se.mark(ref), mirror);
      } catch (err) {
        r = { ok: false, reason: (err as Error).message };
      }
      if (r.ok) se.report.illustratorDataUpdated = true;
      else why = t("engine.ai.why.data", { detail: r.reason });
    }
    if (why && stripIllustratorData(doc, se)) {
      se.report.illustratorDataRemoved = true;
      se.report.illustratorNote = why;
    }
  }
  if (!se.dirty.length) return { bytes: doc.original, report: se.report };

  // the fallback font's objects (font dictionary, CID font, descriptor, program, ToUnicode)
  const fb = await se.fallbackFontIfLoaded();
  if (fb) await fb.embed();
  for (const [ref] of doc.ctx.enumerateIndirectObjects()) if (ref.objectNumber >= firstNew) se.mark(ref);
  se.report.changed = true;
  se.report.fallbackChars = [...new Set(se.report.fallbackChars)];
  // private data removed or replaced: write the file in full so the old private data (the unedited artwork and
  // text) does not stay in the file's earlier revision
  const full = se.report.illustratorDataRemoved || se.report.illustratorDataUpdated;
  // the XMP preview picture still shows the old artwork and text: drop it (Illustrator makes a new one when it saves)
  if (full) dropXmpThumbnail(doc);
  return { bytes: full ? writeFull(doc.plain, doc.ctx) : writeIncremental(doc.plain, doc.ctx, se.dirty), report: se.report };
}

/** Path points (anchors and control points) in PDF default user space. */
function pdfPoints(p: { segs: readonly { pts: readonly number[] }[]; base: M }, model: PageModel): [number, number][] {
  const m = mul(p.base, inv(model.viewport) ?? [1, 0, 0, 1, 0, 0]);
  const out: [number, number][] = [];
  for (const s of p.segs) for (let i = 0; i + 1 < s.pts.length; i += 2) out.push(apply(m, s.pts[i], s.pts[i + 1]));
  return out;
}

const plainText = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

/**
 * Only the characters changed, the way aiPrivate.ts mirrors them: the line keeps its place and size, the unchanged
 * characters before and after the changed middle keep their style, and the new characters take the style of the
 * character before them (of the first replaced character at the start of the line) — so a style moved from one run
 * to another, which Illustrator's data would not get, is not mistaken for a text-only edit.
 */
function textOnlyChanged(orig: TextNode, cur: TextNode, toPx: (p: [number, number]) => [number, number]): boolean {
  const chars = (n: TextNode) => {
    const t: string[] = [];
    const st: string[] = [];
    n.paragraphs.forEach((p, i) => {
      if (i) (t.push("\n"), st.push(""));
      for (const r of p.runs) {
        const key = JSON.stringify([Math.round(r.fontSize * 100), r.color.toLowerCase(), r.bold, r.italic]);
        for (let k = 0; k < r.text.length; k++) (t.push(r.text[k]), st.push(key));
      }
    });
    return { t, st };
  };
  const a = chars(orig), b = chars(cur);
  let pre = 0;
  while (pre < a.t.length && pre < b.t.length && a.t[pre] === b.t[pre]) pre++;
  let suf = 0;
  while (suf < a.t.length - pre && suf < b.t.length - pre && a.t[a.t.length - 1 - suf] === b.t[b.t.length - 1 - suf]) suf++;
  for (let i = 0; i < pre; i++) if (a.st[i] !== b.st[i]) return false;
  for (let i = 1; i <= suf; i++) if (a.st[a.t.length - i] !== b.st[b.t.length - i]) return false;
  // the style the inserted characters get in Illustrator's data
  const near = (from: number, dir: number) => {
    for (let i = from; i >= 0 && i < a.st.length; i += dir) if (a.st[i]) return a.st[i];
    return "";
  };
  const want = pre > 0 ? near(pre - 1, -1) || near(pre, 1) : near(0, 1);
  for (let i = pre; i < b.t.length - suf; i++) if (b.st[i] && b.st[i] !== want) return false;
  return !textChanged({ ...orig, paragraphs: cur.paragraphs }, cur, toPx);
}


export type { Session };

