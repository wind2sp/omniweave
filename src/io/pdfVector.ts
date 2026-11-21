// Vector PDF export: every scene node becomes native PDF content instead of a page-sized bitmap.
//   TEXT / TABLE  → real PDF text in an embedded (subset) Pretendard font, so text is selectable,
//                   searchable and copyable (Hangul included) — positions come from layoutText/layoutTable.
//   VECTOR        → path operators (m/l/c/h, f/f*/S/B/B*), stroke width, round cap/join like the canvas.
//   IMAGE         → original JPEG bytes passed through (DCTDecode); PNG pixels kept losslessly;
//                   other formats decoded to RGBA (browser) and stored as Flate image XObjects.
//   PDF           → the imported page is embedded as a Form XObject (vector, text intact) + cover rects.
//   RASTER        → only the painted tiles, as one RGBA image XObject (lossless).
//   MEDIA         → poster frame image + play/speaker glyph as vectors.
// Coordinates: the page content runs in Omniweave px with a y-down CTM (1px = 0.75pt); each node
// adds its own translate/rotate/scale, opacity and blend mode through ExtGState.
//
// This module has no DOM dependency on its main paths so it can run under Node (tests); the
// browser-only fallbacks (decoding exotic image formats, rasterising a node) are optional.

import { isEmptyPh } from "../core/slides";
import { PRETENDARD_FILES, pretendardTtf } from "./pretendard";
import { padTtfSubsetGlyphs } from "./fontkitPatch";
import type { StrokeVariant, strokeGlyphEm } from "./formats/cad/strokeFont";
import {
  LineCapStyle,
  LineJoinStyle,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFObjectCopier,
  PDFOperatorNames as PON,
  PDFPageEmbedder,
  PDFRef,
  TextRenderingMode,
  appendBezierCurve,
  beginText,
  clip,
  clipEvenOdd,
  closePath,
  concatTransformationMatrix,
  drawObject,
  endPath,
  endText,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setCharacterSpacing,
  setFontAndSize,
  setGraphicsState,
  setDashPattern,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  stroke,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { getBlob as defaultGetBlob } from "../core/assets";
import { renderMasterOf } from "../core/headerFooter";
import { buildTree, hasStructure, type TreeItem } from "../core/layerTree";
import { intersects, transformRect } from "../core/geom";
import { CELL_PAD_Y, TABLE_LINE, hasMerges, layoutTable, lineX, tableCells } from "../core/table";
import { graphemes, layoutText, measure, shadeWidth } from "../core/text";
import { reviewLook } from "../core/review";
import { boxLines, paraBoxes } from "../core/paraBox";
import { segments } from "../core/vector";
import {
  TILE,
  type BlendMode,
  type ImageNode,
  type LayerGroup,
  type MediaNode,
  type OmwDocument,
  type Page,
  type PdfNode,
  type RasterNode,
  type SceneNode,
  type TableNode,
  type TextNode,
  type VectorNode,
} from "../core/types";
import { pdfBytesForNode } from "./pdf";
import { isSurgeonMark } from "./pdfsurgeon";
import { zlibSync } from "fflate";
import { PDFRawStream, type PDFDict } from "pdf-lib";
import { tidyBeforeSave } from "./pdfOptimize";
import { filterRows } from "./tileCodec";
import { PDF_BLEND, loadDissolveField, pageDissolves } from "../core/style/blend";
import { pdfEffectImages, type PdfFxImage } from "./pdfEffects";
import { MAX_FX_PIXELS } from "../core/image/effects";
import { pristinePsdView } from "../core/fidelity/overlay";
import { cmykFlatPage } from "../core/image/cmykComposite";
import { picturePixels } from "../render/picDecode";

export const PX_TO_PT = 0.75;
export const PDF_PRODUCER = "Omniweave";

export interface RasterizedNode {
  png: Uint8Array;
  /** page-space px rectangle the PNG covers */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfVectorOptions {
  /** Font bytes (TTF/OTF). When omitted they are fetched from /fonts/ (browser). */
  fonts?: { regular?: Uint8Array; bold?: Uint8Array };
  /** Custom font loader (used when `fonts` lacks a weight). */
  fontLoader?: (weight: "regular" | "bold") => Promise<Uint8Array>;
  /** Blob lookup (defaults to the asset store). */
  getBlob?: (hash: string) => Uint8Array | undefined;
  /** Browser fallback: paint one node to a PNG (page-space crop). Used when a node has no native PDF form. */
  rasterize?: (page: Page, node: SceneNode) => Promise<RasterizedNode | null>;
  /**
   * Bookmarks: true / omitted = one per page name (when there is more than one page), false = none,
   * or an explicit list (title + zero-based index into `pages`), e.g. one bookmark per merged file.
   */
  outline?: boolean | { title: string; page: number }[];
  /** Called with human-readable notes about content that could not be exported natively. */
  onWarning?: (msg: string) => void;
}

// ───────── fonts ─────────

export { fontUrl } from "./pretendard";

/** The original Pretendard TTF (unpacked from public/fonts/*.ttpack — the same bytes the export always embedded). */
async function fetchFont(weight: "regular" | "bold"): Promise<Uint8Array> {
  try {
    return await pretendardTtf(weight);
  } catch (e) {
    throw new Error(`글꼴을 불러오지 못했습니다: ${PRETENDARD_FILES[weight]} (${(e as Error).message})`);
  }
}

// ───────── colours ─────────

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", orange: "#ffa500", purple: "#800080", navy: "#000080",
  teal: "#008080", maroon: "#800000", lime: "#00ff00", aqua: "#00ffff", cyan: "#00ffff", fuchsia: "#ff00ff",
  magenta: "#ff00ff", olive: "#808000", pink: "#ffc0cb", brown: "#a52a2a", lightgray: "#d3d3d3", darkgray: "#a9a9a9",
};

export function parseColor(css: string | null | undefined): Rgba | null {
  if (!css) return null;
  let s = css.trim().toLowerCase();
  if (s === "transparent" || s === "none") return null;
  if (NAMED[s]) s = NAMED[s];
  if (s[0] === "#") {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return { r: 0, g: 0, b: 0, a: 1 };
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (v: string) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v) / 255);
    const al = (v: string | undefined) => (v === undefined ? 1 : v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v));
    const c = { r: ch(parts[0] ?? "0"), g: ch(parts[1] ?? "0"), b: ch(parts[2] ?? "0"), a: al(parts[3]) };
    for (const k of ["r", "g", "b", "a"] as const) c[k] = Number.isFinite(c[k]) ? Math.max(0, Math.min(1, c[k])) : k === "a" ? 1 : 0;
    return c;
  }
  const hm = /^hsla?\(([^)]*)\)$/.exec(s);
  if (hm) {
    const p = hm[1].split(/[\s,/]+/).filter(Boolean);
    const H = (((parseFloat(p[0] ?? "0") % 360) + 360) % 360) / 360, S = parseFloat(p[1] ?? "0") / 100, L = parseFloat(p[2] ?? "0") / 100;
    const a = p[3] === undefined ? 1 : p[3].endsWith("%") ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    const q = L < 0.5 ? L * (1 + S) : L + S - L * S, pp = 2 * L - q;
    const hue = (t: number) => {
      t = (t + 1) % 1;
      return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp;
    };
    return { r: hue(H + 1 / 3), g: hue(H), b: hue(H - 1 / 3), a: Number.isFinite(a) ? a : 1 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// ───────── per-export state ─────────

const BM: Record<BlendMode, string> = PDF_BLEND;

interface ImageRes {
  ref: PDFRef;
}

class Exporter {
  readonly getBlob: (hash: string) => Uint8Array | undefined;
  private fonts = new Map<string, Promise<PDFFont>>();
  private images = new Map<string, Promise<ImageRes | null>>();
  private srcPdfs = new Map<string, Promise<PDFDocument | null>>();
  /** one copier per source PDF, so resources its pages share (fonts, images) are copied once */
  private copiers = new Map<string, PDFObjectCopier>();
  private charsets = new Map<string, Promise<Set<number>>>();
  /** Omni Stroke's glyph lines (loaded with the stroke font): SHX text is drawn with them */
  strokeGlyph: typeof strokeGlyphEm | null = null;
  strokePen = 0.056;
  private pdfPages = new Map<string, Promise<{ ref: PDFRef; w: number; h: number; rot: number } | null>>();
  // per-page resource names
  /** current page (layer groups build Form XObjects on its resources) */
  page!: PDFPage;
  private gsNames = new Map<string, PDFName>();
  private fontNames = new Map<string, PDFName>();
  private xNames = new Map<string, PDFName>();

  constructor(readonly pdf: PDFDocument, readonly doc: OmwDocument, readonly opts: PdfVectorOptions) {
    this.getBlob = opts.getBlob ?? defaultGetBlob;
  }

  warn(msg: string) {
    this.opts.onWarning?.(msg);
  }

  beginPage(page: PDFPage) {
    this.page = page;
    this.gsNames.clear();
    this.fontNames.clear();
    this.xNames.clear();
  }

  // ---- resources ----

  font(bold: boolean): Promise<PDFFont> {
    const key = bold ? "bold" : "regular";
    let f = this.fonts.get(key);
    if (!f) {
      f = (async () => {
        const bytes = this.opts.fonts?.[key] ?? (this.opts.fontLoader ? await this.opts.fontLoader(key) : await fetchFont(key));
        const f = await this.pdf.embedFont(bytes, { subset: true });
        padTtfSubsetGlyphs((f as unknown as { embedder?: { subset?: object } }).embedder?.subset);
        return f;
      })();
      this.fonts.set(key, f);
    }
    return f;
  }

  /**
   * Omni Stroke (drawing text from DXF / DWG: io/formats/cad/strokeFont.ts) embedded as the drawing shows it — built
   * here for the characters the document sets in it, like on screen; nothing is fetched.
   */
  strokeFont(variant: string): Promise<PDFFont> {
    const key = "stroke-" + variant;
    let f = this.fonts.get(key);
    if (!f) {
      f = (async () => {
        const { strokeFontTtf, strokeVariantOf, strokeGlyphEm, STROKE_PEN_EM } = await import("./formats/cad/strokeFont");
        this.strokeGlyph = strokeGlyphEm;
        this.strokePen = STROKE_PEN_EM;
        let text = "";
        for (const p of this.doc.pages) for (const n of p.nodes) if (n.type === "TEXT") for (const para of n.paragraphs) for (const r of para.runs) if (strokeVariantOf(r.fontFamily)) text += r.text;
        // an SHX style: a font of advances only (the text layer: search, copy), the shapes drawn as lines over it —
        // as AutoCAD plots SHX text; the user's SHX shapes are never embedded (docs/legal/IP_CHECKLIST.md 13)
        const font = await this.pdf.embedFont(strokeFontTtf(text, false, variant as StrokeVariant, !isShx(variant)), { subset: true });
        padTtfSubsetGlyphs((font as unknown as { embedder?: { subset?: object } }).embedder?.subset);
        return font;
      })();
      this.fonts.set(key, f);
    }
    return f;
  }

  /** The font a run is embedded in: Omni Stroke for drawing text, Pretendard for everything else. */
  runFont(run: { bold?: boolean; fontFamily?: string }): Promise<PDFFont> {
    const v = strokeVariant(run.fontFamily);
    return v ? this.strokeFont(v) : this.font(!!run.bold);
  }

  /** Code points the embedded font can draw. */
  charset(bold: boolean, family?: string): Promise<Set<number>> {
    const v = strokeVariant(family);
    const key = v ? "stroke-" + v : bold ? "bold" : "regular";
    let c = this.charsets.get(key);
    if (!c) {
      c = (v ? this.strokeFont(v) : this.font(bold)).then((f) => new Set(f.getCharacterSet()));
      this.charsets.set(key, c);
    }
    return c;
  }

  fontName(font: PDFFont): PDFName {
    const k = font.ref.toString();
    let n = this.fontNames.get(k);
    if (!n) {
      n = this.page.node.newFontDictionary("F", font.ref); // PDFName
      this.fontNames.set(k, n);
    }
    return n;
  }

  xobjectName(ref: PDFRef): PDFName {
    const k = ref.toString();
    let n = this.xNames.get(k);
    if (!n) {
      n = this.page.node.newXObject("X", ref); // PDFName
      this.xNames.set(k, n);
    }
    return n;
  }

  /** ExtGState for fill alpha / stroke alpha / blend; null when it would be the default. */
  gs(fillAlpha: number, strokeAlpha: number, blend: BlendMode): PDFOperator | null {
    const ca = Math.round(Math.max(0, Math.min(1, fillAlpha)) * 1000) / 1000;
    const CA = Math.round(Math.max(0, Math.min(1, strokeAlpha)) * 1000) / 1000;
    const bm = BM[blend] ?? "Normal";
    if (ca === 1 && CA === 1 && bm === "Normal") return null;
    const key = `${ca}|${CA}|${bm}`;
    let n = this.gsNames.get(key);
    if (!n) {
      const dict = this.pdf.context.obj({ Type: "ExtGState", ca, CA, BM: bm });
      n = this.page.node.newExtGState("GS", this.pdf.context.register(dict)); // PDFName
      this.gsNames.set(key, n);
    }
    return setGraphicsState(n);
  }

  /** RGBA pixels → image XObject (RGB + optional soft mask), Flate-compressed, lossless. */
  rgbaImage(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): PDFRef {
    const px = w * h;
    const rgb = new Uint8Array(px * 3);
    const alpha = new Uint8Array(px);
    let opaque = true;
    for (let i = 0, j = 0; i < px; i++, j += 4) {
      rgb[i * 3] = rgba[j];
      rgb[i * 3 + 1] = rgba[j + 1];
      rgb[i * 3 + 2] = rgba[j + 2];
      alpha[i] = rgba[j + 3];
      if (rgba[j + 3] !== 255) opaque = false;
    }
    const ctx = this.pdf.context;
    const base = { Type: "XObject", Subtype: "Image", Width: w, Height: h, BitsPerComponent: 8 };
    // PNG prediction (/Predictor 15) before Flate: lossless, typically far smaller for photos (docs/design/FILE_SIZE.md)
    const predicted = (samples: Uint8Array, colors: number, extra: Record<string, unknown>) => {
      const z = zlibSync(filterRows(samples, w, h, colors), { level: 6 });
      const d = ctx.obj({ ...base, ...extra, Filter: "FlateDecode", DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: 8, Columns: w }, Length: z.length } as any);
      return ctx.register(PDFRawStream.of(d as unknown as PDFDict, z));
    };
    const dict: Record<string, unknown> = { ColorSpace: "DeviceRGB" };
    if (!opaque) dict.SMask = predicted(alpha, 1, { ColorSpace: "DeviceGray" });
    return predicted(rgb, 3, dict);
  }

  /** Image asset → XObject. JPEG passes through untouched; PNG keeps its pixels; others are decoded. */
  image(assetId: string): Promise<ImageRes | null> {
    const asset = this.doc.assets[assetId];
    if (!asset) return Promise.resolve(null);
    let p = this.images.get(asset.hash);
    if (!p) {
      p = (async () => {
        const bytes = this.getBlob(asset.hash);
        if (!bytes) return null;
        const mime = asset.mime.toLowerCase();
        const sig = sniff(bytes);
        try {
          if (sig === "jpeg" || (!sig && /jpe?g/.test(mime))) return { ref: (await this.pdf.embedJpg(bytes)).ref };
          if (sig === "png" || (!sig && mime === "image/png")) return { ref: (await this.pdf.embedPng(bytes)).ref };
        } catch {
          /* fall through to the decoder */
        }
        const dec = await decodeImage(bytes, asset.mime);
        if (dec) return { ref: this.rgbaImage(dec.data, dec.width, dec.height) };
        return null;
      })();
      this.images.set(asset.hash, p);
    }
    return p;
  }

  /** Imported PDF page → Form XObject of the original page (vector, text intact). */
  pdfPage(assetId: string, index: number, node?: PdfNode): Promise<{ ref: PDFRef; w: number; h: number; rot: number } | null> {
    const asset = this.doc.assets[assetId];
    if (!asset) return Promise.resolve(null);
    // pages elevated by PDF Surgeon embed the original minus the elevated operations (no double text)
    const elevated = !!node?.covers.some(isSurgeonMark);
    const srcKey = elevated ? `${asset.hash}:surgeon:${node!.id}` : asset.hash;
    const key = `${srcKey}#${index}`;
    let p = this.pdfPages.get(key);
    if (!p) {
      p = (async () => {
        let src = this.srcPdfs.get(srcKey);
        if (!src) {
          src = (async () => {
            const bytes = elevated ? await pdfBytesForNode(asset.hash, node!) : this.getBlob(asset.hash);
            if (!bytes) return null;
            let d = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
            // an encrypted source cannot be embedded object-by-object (its strings stay encrypted):
            // use the copy decrypted with the password it was opened with, if there is one
            if (d.isEncrypted && node && !elevated) {
              const plain = await pdfBytesForNode(asset.hash, node).catch(() => null);
              if (plain) d = await PDFDocument.load(plain, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
            }
            return d.isEncrypted ? null : d;
          })();
          this.srcPdfs.set(srcKey, src);
        }
        const sd = await src;
        if (!sd || index < 0 || index >= sd.getPageCount()) return null;
        const sp = sd.getPage(index);
        const crop = sp.getCropBox();
        const bb = { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height };
        // embedPage() would copy each page with a fresh copier, duplicating shared fonts/images per page
        // keyed like the source document: a copier resolves refs only in the context it was made for
        let copier = this.copiers.get(srcKey);
        if (!copier) {
          copier = PDFObjectCopier.for(sd.context, this.pdf.context);
          this.copiers.set(srcKey, copier);
        }
        const leaf = copier.copy(sp.node);
        const ref = this.pdf.context.nextRef();
        await (await PDFPageEmbedder.for(leaf, bb)).embedIntoContext(this.pdf.context, ref);
        const rot = (((sp.getRotation().angle ?? 0) % 360) + 360) % 360;
        return { ref, w: crop.width, h: crop.height, rot };
      })();
      this.pdfPages.set(key, p);
    }
    return p;
  }
}

function sniff(b: Uint8Array): "jpeg" | "png" | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return null;
}

/** Browser-only decode of formats PDF cannot hold directly (WebP, GIF, BMP, SVG, EMF / WMF, AVIF…). */
const decodeImage = (bytes: Uint8Array, mime: string) => picturePixels(bytes, mime);

// ───────── operator helpers ─────────

const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Omni Stroke variant of a font family (the names of io/formats/cad/strokeFont.ts, kept out of this chunk) */
// ("Omni Stroke SHX <key>": a style whose SHX files were found on this computer — the shapes the screen shows)
const isShx = (v: string | null) => !!v?.startsWith("shx:");
const strokeVariant = (family: string | undefined): string | null => (family === "Omni Stroke Mono" ? "mono" : family === "Omni Stroke" ? "prop" : family?.startsWith("Omni Stroke SHX ") ? `shx:${family.slice(16).toLowerCase()}` : null);

/** Characters of `text` the font cannot draw (control characters excluded — they become spaces). */
function missingChars(text: string, cs: Set<number>, out: Set<string>) {
  for (const ch of text.replace(CONTROL, "")) if (!/\s/.test(ch) && !cs.has(ch.codePointAt(0)!)) out.add(ch);
}

/** Characters of a text/table node that the embedded fonts cannot draw. */
async function nodeMissingChars(ex: Exporter, n: TextNode | TableNode): Promise<string[]> {
  const out = new Set<string>();
  if (n.type === "TEXT") {
    for (const p of n.paragraphs) for (const r of p.runs) if (r.text) missingChars(r.text, await ex.charset(!!r.bold, r.fontFamily), out);
  } else {
    for (let r = 0; r < n.rows.length; r++)
      for (const cell of n.rows[r]) if (cell?.text) missingChars(cell.text, await ex.charset(!!cell.bold || (n.headerRow && r === 0)), out);
  }
  return [...out];
}

type Ops = PDFOperator[];

const OP = (name: PON) => PDFOperator.of(name);

function fillOp(rule: "nonzero" | "evenodd"): PDFOperator {
  return OP(rule === "evenodd" ? PON.FillEvenOdd : PON.FillNonZero);
}

function rgb(c: Rgba, stroking = false): PDFOperator {
  return stroking ? setStrokingRgbColor(c.r, c.g, c.b) : setFillingRgbColor(c.r, c.g, c.b);
}

/** Filled rectangle in the current (px, y-down) space with its own alpha. */
function fillRect(ex: Exporter, ops: Ops, x: number, y: number, w: number, h: number, css: string | null | undefined, opacity: number, blend: BlendMode) {
  const c = parseColor(css);
  if (!c || c.a <= 0 || w <= 0 || h <= 0) return;
  ops.push(pushGraphicsState());
  const g = ex.gs(opacity * c.a, 1, blend);
  if (g) ops.push(g);
  ops.push(rgb(c), rectangle(x, y, w, h), OP(PON.FillNonZero), popGraphicsState());
}

/** One run of text at a baseline (x, y) in the y-down px space. */
function textOps(ex: Exporter, ops: Ops, font: PDFFont, text: string, x: number, y: number, size: number, italic: boolean, css: string, opacity: number, blend: BlendMode, letterSpacing = 0, invisible = false, hscale = 1, after?: number[]) {
  // tabs and other control characters have no glyph; the canvas draws them as blank space
  text = text.replace(CONTROL, " ");
  if (!text || !/\S/.test(text)) return;
  let c = parseColor(css) ?? { r: 0, g: 0, b: 0, a: 1 };
  // fully transparent text (the OCR text layer) is written invisible: selectable and searchable, never painted
  if (c.a <= 0 && css.trim().startsWith("#")) [c, invisible] = [{ ...c, a: 1 }, true];
  if (c.a <= 0) return;
  ops.push(pushGraphicsState());
  const g = ex.gs(opacity * c.a, opacity * c.a, blend);
  if (g) ops.push(g);
  // y-down CTM: flip glyphs back up (d = -1); italic = synthetic 12° slant
  const skew = italic ? Math.tan((12 * Math.PI) / 180) : 0;
  ops.push(
    beginText(),
    rgb(c),
    setFontAndSize(ex.fontName(font), size),
    // 장평: the text matrix narrows / widens the glyphs and their advances (character spacing is scaled with them)
    setTextMatrix(hscale, 0, skew, -1, x, y),
    ...(invisible ? [setTextRenderingMode(TextRenderingMode.Invisible)] : []),
    ...(letterSpacing ? [setCharacterSpacing(letterSpacing / hscale)] : []),
    after
      ? // 한글 자간: one string with a TJ adjustment after each character (thousandths of the size; negative = further
        // apart), so the text stays one run of characters for search and copy
        PDFOperator.of(PON.ShowTextAdjusted, [
          ex.pdf.context.obj(graphemes(text).flatMap((g, i) => [font.encodeText(g) as PDFHexString, ...(after[i] ? [ex.pdf.context.obj(-(after[i] / size) * 1000)] : [])])),
        ])
      : showText(font.encodeText(text) as PDFHexString),
    endText(),
    popGraphicsState(),
  );
}

/**
 * SHX text drawn as lines (AutoCAD plots SHX text as vectors): each character's centre lines at the pen width, placed on
 * the advances of the invisible text written under it (textOps with the same size, 장평, spacing and slant).
 */
function shxLineOps(ex: Exporter, ops: Ops, font: PDFFont, variant: string, text: string, x: number, y: number, size: number, italic: boolean, css: string, opacity: number, blend: BlendMode, letterSpacing = 0, hscale = 1, after?: number[]) {
  const glyph = ex.strokeGlyph;
  text = text.replace(CONTROL, " ");
  if (!glyph || !/\S/.test(text)) return;
  const c = parseColor(css) ?? { r: 0, g: 0, b: 0, a: 1 };
  if (c.a <= 0) return;
  const skew = italic ? Math.tan((12 * Math.PI) / 180) : 0;
  const path: Ops = [];
  let px = x;
  graphemes(text).forEach((g, i) => {
    const gl = glyph(g, variant as StrokeVariant);
    if (gl)
      for (const s of gl.strokes) {
        const pt = ([gx, gy]: [number, number]): [number, number] => [px + hscale * gx * size + skew * gy * size, y - gy * size];
        const [x0, y0] = pt(s[0]);
        path.push(moveTo(x0, y0));
        if (s.length === 1) path.push(lineTo(x0, y0));
        for (let k = 1; k < s.length; k++) path.push(lineTo(...pt(s[k])));
      }
    px += hscale * (font.widthOfTextAtSize(g, size) + (after?.[i] ?? 0)) + letterSpacing;
  });
  if (!path.length) return;
  ops.push(pushGraphicsState());
  const gs = ex.gs(1, opacity * c.a, blend);
  if (gs) ops.push(gs);
  ops.push(rgb(c, true), setLineWidth(ex.strokePen * size), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), ...path, stroke(), popGraphicsState());
}

function drawXObject(ex: Exporter, ops: Ops, ref: PDFRef, x: number, y: number, w: number, h: number) {
  // image space is the unit square, y-up → map to (x, y, w, h) in the y-down space
  ops.push(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, -h, x, y + h), drawObject(ex.xobjectName(ref)), popGraphicsState());
}

// ───────── node painters ─────────

function vectorOps(ex: Exporter, ops: Ops, n: VectorNode, opacity: number) {
  const path: Ops = [];
  for (const c of n.contours) {
    if (!c.nodes.length) continue;
    path.push(moveTo(c.nodes[0].anchor[0], c.nodes[0].anchor[1]));
    for (const [a, b] of segments(c)) {
      const line = a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1] && b.handleIn[0] === b.anchor[0] && b.handleIn[1] === b.anchor[1];
      if (line) path.push(lineTo(b.anchor[0], b.anchor[1]));
      else path.push(appendBezierCurve(a.handleOut[0], a.handleOut[1], b.handleIn[0], b.handleIn[1], b.anchor[0], b.anchor[1]));
    }
    if (c.closed) path.push(closePath());
  }
  if (!path.length) return;
  const fc = parseColor(n.fill);
  const sc = n.stroke && n.strokeWidth > 0 ? parseColor(n.stroke) : null;
  const doFill = !!fc && fc.a > 0;
  const doStroke = !!sc && sc.a > 0;
  if (!doFill && !doStroke) return;
  ops.push(pushGraphicsState());
  const g = ex.gs(opacity * (fc?.a ?? 1), opacity * (sc?.a ?? 1), n.blendMode);
  if (g) ops.push(g);
  if (doFill) ops.push(rgb(fc!));
  if (doStroke) ops.push(rgb(sc!, true), setLineWidth(n.strokeWidth), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
  // dashes (drawing linetypes, dashed outlines) as the canvas draws them
  if (doStroke && n.strokeDash?.length) ops.push(setDashPattern(n.strokeDash, 0));
  ops.push(...path);
  if (doFill && doStroke) ops.push(OP(n.fillRule === "evenodd" ? PON.FillEvenOddAndStroke : PON.FillNonZeroAndStroke));
  else if (doFill) ops.push(fillOp(n.fillRule));
  else ops.push(stroke());
  ops.push(popGraphicsState());
}

/** Optional character formats some layouts carry (read defensively: older layouts lack them). */
interface PieceExtras {
  dy?: number;
  letterSpacing?: number;
  hscale?: number;
  spacing?: number;
}
interface RunExtras {
  strike?: boolean;
  highlight?: string;
}

/** Font size actually drawn for a piece: taken from its CSS font (covers super/subscript scaling). */
function pieceSize(font: string, fallback: number): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  const v = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function textNodeOps(ex: Exporter, ops: Ops, n: TextNode, opacity: number, invisible = false) {
  const lay = layoutText(n);
  if (n.background && !invisible) fillRect(ex, ops, 0, 0, n.width, lay.height, n.background, opacity, n.blendMode);
  // paragraph shading and borders (core/paraBox.ts; lines as filled bars, a double line as two thin ones)
  if (!invisible && n.paragraphs.some((p) => p.border || p.shade))
    for (const b of paraBoxes(n.paragraphs, n.width, lay.lines)) {
      if (b.shade) fillRect(ex, ops, b.x0, b.top, b.x1 - b.x0, b.bottom - b.top, b.shade, opacity, n.blendMode);
      for (const [x0, y0, x1, y1, l] of boxLines(b)) {
        const vert = x0 === x1;
        const bars = l.style === "double" ? [-l.w / 3, l.w / 3].map((d) => [d, l.w / 3]) : [[0, l.w]];
        for (const [d, w] of bars)
          if (vert) fillRect(ex, ops, x0 + d - w / 2, y0, w, y1 - y0, l.color, opacity, n.blendMode);
          else fillRect(ex, ops, x0, y0 + d - w / 2, x1 - x0, w, l.color, opacity, n.blendMode);
      }
    }
  // highlights under all glyphs (same geometry as the canvas painter)
  for (const line of lay.lines)
    for (const p of line.pieces) {
      const hl = p.hidden ? undefined : (reviewLook(p.run) as RunExtras).highlight;
      if (!hl || invisible) continue;
      const w = shadeWidth(line, p);
      fillRect(ex, ops, p.x, line.y + line.baseline - p.run.fontSize * 0.95, w, p.run.fontSize * 1.22, hl, opacity, n.blendMode);
    }
  for (const line of lay.lines) {
    for (const p of line.pieces) {
      if (p.hidden) continue;
      // tracked changes and comments as the view shows them (core/review.ts)
      const run = reviewLook(p.run);
      const extra = p as PieceExtras;
      const y = line.y + line.baseline + (extra.dy ?? 0);
      const size = pieceSize(p.font, run.fontSize);
      const font = await ex.runFont(run);
      const shx = !invisible && isShx(strokeVariant(run.fontFamily));
      if (extra.spacing) {
        // 한글 자간 (a share of each character's own advance, as layoutText measured it): one string (search and copy keep the words and spaces); after each character a TJ adjustment of its own
        // share, in unscaled text space (the text matrix applies 장평 to it like to the glyph)
        const after = graphemes(p.text.replace(CONTROL, " ")).map((g) => measure(g, p.font) * extra.spacing!);
        textOps(ex, ops, font, p.text, p.x, y, size, !!run.italic, run.color, opacity, n.blendMode, extra.letterSpacing ?? 0, invisible || shx, extra.hscale ?? 1, after);
        if (shx) shxLineOps(ex, ops, font, strokeVariant(run.fontFamily)!, p.text, p.x, y, size, !!run.italic, run.color, opacity, n.blendMode, extra.letterSpacing ?? 0, extra.hscale ?? 1, after);
      } else {
        textOps(ex, ops, font, p.text, p.x, y, size, !!run.italic, run.color, opacity, n.blendMode, extra.letterSpacing ?? 0, invisible || shx, extra.hscale ?? 1);
        if (shx) shxLineOps(ex, ops, font, strokeVariant(run.fontFamily)!, p.text, p.x, y, size, !!run.italic, run.color, opacity, n.blendMode, extra.letterSpacing ?? 0, extra.hscale ?? 1);
      }
      if (invisible) continue;
      const thick = Math.max(1, size / 16);
      if (run.underline) fillRect(ex, ops, p.x, y + size * 0.12, p.width, thick, run.color, opacity, n.blendMode);
      if ((run as RunExtras).strike) fillRect(ex, ops, p.x, y - size * 0.3, p.width, thick, run.color, opacity, n.blendMode);
    }
  }
}

async function tableOps(ex: Exporter, ops: Ops, n: TableNode, opacity: number, invisible = false) {
  const l = layoutTable(n);
  if (n.background && !invisible) fillRect(ex, ops, 0, 0, l.width, l.height, n.background, opacity, n.blendMode);
  const lh = n.fontSize * TABLE_LINE;
  // merged cells cover their whole range (core/table tableCells, the same cells the canvas draws)
  const cells = tableCells(n);
  for (const v of cells) {
    const { x: x0, y: y0, w, h } = v.rect;
    const fill = v.cell.fill ?? (n.headerRow && v.r === 0 ? n.headerFill : null);
    if (fill && !invisible) fillRect(ex, ops, x0, y0, w, h, fill, opacity, n.blendMode);
    if (v.rich) {
      // a cell drawn from its own paragraphs (한글 tables), as on the canvas
      ops.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, v.rich.x, v.rich.y));
      await textNodeOps(ex, ops, v.rich.node, opacity, invisible);
      ops.push(popGraphicsState());
      continue;
    }
    if (!v.lines.length) continue;
    const font = await ex.font(!!v.cell.bold || (n.headerRow && v.r === 0));
    v.lines.forEach((ln, i) => {
      const y = y0 + CELL_PAD_Y + i * lh + (lh - n.fontSize) / 2 + n.fontSize * 0.8;
      textOps(ex, ops, font, ln.text, lineX(v.cell.align, x0, w, ln.width), y, n.fontSize, !!v.cell.italic, v.cell.color ?? n.color, opacity, n.blendMode, 0, invisible);
    });
  }
  const bc = parseColor(n.borderColor);
  if (bc && bc.a > 0 && !invisible) {
    ops.push(pushGraphicsState());
    const g = ex.gs(1, opacity * bc.a, n.blendMode);
    if (g) ops.push(g);
    ops.push(rgb(bc, true), setLineWidth(1));
    if (hasMerges(n.rows))
      for (const { rect: q } of cells) ops.push(moveTo(q.x, q.y), lineTo(q.x + q.w, q.y), lineTo(q.x + q.w, q.y + q.h), lineTo(q.x, q.y + q.h), closePath());
    else {
      for (const x of l.colX) ops.push(moveTo(x, 0), lineTo(x, l.height));
      for (const y of l.rowY) ops.push(moveTo(0, y), lineTo(l.width, y));
    }
    ops.push(stroke(), popGraphicsState());
  }
}

async function imageOps(ex: Exporter, ops: Ops, n: ImageNode, opacity: number): Promise<boolean> {
  const img = await ex.image(n.assetId);
  if (!img) return false;
  ops.push(pushGraphicsState());
  const g = ex.gs(opacity, opacity, n.blendMode);
  if (g) ops.push(g);
  drawXObject(ex, ops, img.ref, 0, 0, n.width, n.height);
  ops.push(popGraphicsState());
  return true;
}

async function pdfNodeOps(ex: Exporter, ops: Ops, n: PdfNode, opacity: number): Promise<boolean> {
  const emb = await ex.pdfPage(n.assetId, n.pageIndex, n);
  if (!emb) return false;
  const { w: wc, h: hc, rot } = emb;
  // displayed (rotated) size of the crop box, in pt
  const W = rot === 90 || rot === 270 ? hc : wc;
  const H = rot === 90 || rot === 270 ? wc : hc;
  // form space (y-up, pt) → display space (y-down, pt), honouring /Rotate (clockwise)
  const M: Record<number, [number, number, number, number, number, number]> = {
    0: [1, 0, 0, -1, 0, hc],
    90: [0, 1, 1, 0, 0, 0],
    180: [-1, 0, 0, 1, wc, 0],
    270: [0, -1, -1, 0, hc, wc],
  };
  const m = M[rot] ?? M[0];
  ops.push(pushGraphicsState(), rectangle(0, 0, n.width, n.height), clip(), endPath());
  const g = ex.gs(opacity, opacity, n.blendMode);
  if (g) ops.push(g);
  ops.push(concatTransformationMatrix(n.width / W, 0, 0, n.height / H, 0, 0), concatTransformationMatrix(...m), drawObject(ex.xobjectName(emb.ref)), popGraphicsState());
  for (const c of n.covers) if (!isSurgeonMark(c)) fillRect(ex, ops, c.x, c.y, c.w, c.h, c.color, opacity, n.blendMode);
  return true;
}

function rasterOps(ex: Exporter, ops: Ops, n: RasterNode, opacity: number, pageW: number, pageH: number) {
  const pageRect = { x: 0, y: 0, w: pageW, h: pageH };
  const keys: [number, number, Uint8ClampedArray][] = [];
  for (const [k, t] of Object.entries(n.tiles)) {
    const i = k.indexOf("_");
    const tx = +k.slice(0, i), ty = +k.slice(i + 1);
    if (!intersects(transformRect(n.transform, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE }), pageRect)) continue;
    keys.push([tx, ty, t.data]);
  }
  if (!keys.length) return;
  ops.push(pushGraphicsState());
  const g = ex.gs(opacity, opacity, n.blendMode);
  if (g) ops.push(g);
  const tx0 = Math.min(...keys.map((k) => k[0])), ty0 = Math.min(...keys.map((k) => k[1]));
  const tx1 = Math.max(...keys.map((k) => k[0])), ty1 = Math.max(...keys.map((k) => k[1]));
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  if (cols * rows <= keys.length * 4) {
    // one image for the painted area: no seams between tiles
    const W = cols * TILE, H = rows * TILE;
    const buf = new Uint8ClampedArray(W * H * 4);
    for (const [tx, ty, data] of keys) {
      const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
      for (let y = 0; y < TILE; y++) buf.set(data.subarray(y * TILE * 4, (y + 1) * TILE * 4), ((oy + y) * W + ox) * 4);
    }
    drawXObject(ex, ops, ex.rgbaImage(buf, W, H), tx0 * TILE, ty0 * TILE, W, H);
  } else {
    for (const [tx, ty, data] of keys) drawXObject(ex, ops, ex.rgbaImage(data, TILE, TILE), tx * TILE, ty * TILE, TILE, TILE);
  }
  ops.push(popGraphicsState());
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

async function mediaOps(ex: Exporter, ops: Ops, n: MediaNode, opacity: number) {
  const { width: w, height: h } = n;
  const poster = n.posterAssetId ? await ex.image(n.posterAssetId) : null;
  if (poster) {
    ops.push(pushGraphicsState());
    const g = ex.gs(opacity, opacity, n.blendMode);
    if (g) ops.push(g);
    drawXObject(ex, ops, poster.ref, 0, 0, w, h);
    ops.push(popGraphicsState());
  } else fillRect(ex, ops, 0, 0, w, h, n.media === "audio" ? "#2a2440" : "#16181d", opacity, n.blendMode);
  // play / speaker badge, as in the canvas painter
  const r = Math.max(10, Math.min(w, h) * 0.14);
  const cx = n.media === "audio" ? r * 1.6 : w / 2, cy = h / 2;
  const K = 0.5522847498 * r;
  ops.push(pushGraphicsState());
  let g = ex.gs(opacity * 0.55, 1, n.blendMode);
  if (g) ops.push(g);
  ops.push(
    setFillingRgbColor(0, 0, 0),
    moveTo(cx + r, cy),
    appendBezierCurve(cx + r, cy + K, cx + K, cy + r, cx, cy + r),
    appendBezierCurve(cx - K, cy + r, cx - r, cy + K, cx - r, cy),
    appendBezierCurve(cx - r, cy - K, cx - K, cy - r, cx, cy - r),
    appendBezierCurve(cx + K, cy - r, cx + r, cy - K, cx + r, cy),
    closePath(),
    OP(PON.FillNonZero),
    popGraphicsState(),
    pushGraphicsState(),
  );
  g = ex.gs(opacity, 1, n.blendMode);
  if (g) ops.push(g);
  ops.push(setFillingRgbColor(1, 1, 1));
  if (n.media === "audio") {
    const k = r / 10;
    ops.push(moveTo(cx - 6 * k, cy - 3 * k), lineTo(cx - 2 * k, cy - 3 * k), lineTo(cx + 3 * k, cy - 7 * k), lineTo(cx + 3 * k, cy + 7 * k), lineTo(cx - 2 * k, cy + 3 * k), lineTo(cx - 6 * k, cy + 3 * k));
  } else ops.push(moveTo(cx - r * 0.35, cy - r * 0.5), lineTo(cx + r * 0.55, cy), lineTo(cx - r * 0.35, cy + r * 0.5));
  ops.push(closePath(), OP(PON.FillNonZero), popGraphicsState());
  const fs = Math.max(9, Math.min(18, h * 0.12));
  const bold = await ex.font(true);
  if (n.media === "audio") textOps(ex, ops, bold, n.name.slice(0, 60), cx + r * 1.6, cy - fs * 0.1, fs, false, "#ffffff", opacity, n.blendMode);
  if (n.duration > 0) {
    const end = n.trimEnd ?? n.duration;
    const label = fmtTime(Math.max(0, end - n.trimStart));
    if (n.media === "audio") textOps(ex, ops, bold, label, cx + r * 1.6, cy + fs * 1.1, fs, false, "rgba(255,255,255,.75)", opacity, n.blendMode);
    else {
      const tw = label.length * fs * 0.6 + 10;
      fillRect(ex, ops, w - tw - 6, h - fs - 12, tw, fs + 8, "rgba(0,0,0,.6)", opacity, n.blendMode);
      textOps(ex, ops, bold, label, w - tw, h - 10, fs, false, "#ffffff", opacity, n.blendMode);
    }
  }
}

/** Fallback for a node without a native form: paint it to PNG (browser) and place it in page space. */
async function rasterFallback(ex: Exporter, ops: Ops, page: Page, n: SceneNode): Promise<boolean> {
  if (!ex.opts.rasterize) return false;
  const r = await ex.opts.rasterize(page, n);
  if (!r) return false;
  const img = await ex.pdf.embedPng(r.png);
  drawXObject(ex, ops, img.ref, r.x, r.y, r.w, r.h);
  return true;
}

async function nodeOps(ex: Exporter, page: Page, n: SceneNode): Promise<Ops> {
  const ops: Ops = [];
  if (!n.visible || n.opacity <= 0 || isEmptyPh(n)) return ops;
  // an adjustment layer recolours what is below it — no PDF form for that (an unedited PSD page goes in as
  // Photoshop's merged image instead, layerOps)
  if (n.type === "RASTER" && n.adjust) {
    if (n.adjust.adj.kind !== "other") ex.warn(`${n.name}: 조정 레이어는 PDF에 반영되지 않습니다`);
    return ops;
  }
  const op = Math.min(1, n.opacity);
  const t = n.transform;
  const body: Ops = [];
  let ok = true;
  try {
    switch (n.type) {
      case "VECTOR":
        vectorOps(ex, body, n, op);
        break;
      case "TEXT":
      case "TABLE": {
        // glyphs missing from Pretendard (Hanja, emoji…) would print as empty boxes and copy as U+0000:
        // place the node as an image instead and keep its text as an invisible, searchable layer
        const missing = await nodeMissingChars(ex, n);
        let invisible = false;
        if (missing.length) {
          invisible = await rasterFallback(ex, ops, page, n);
          ex.warn(`${n.name}: 글꼴(Pretendard)에 없는 글자 ${missing.slice(0, 12).join(" ")}${missing.length > 12 ? " …" : ""} — ${invisible ? "그림으로 넣고 글자는 검색용으로 남겼습니다" : "PDF에서 빈 네모로 보일 수 있습니다"}`);
        }
        if (n.type === "TEXT") await textNodeOps(ex, body, n, op, invisible);
        else await tableOps(ex, body, n, op, invisible);
        break;
      }
      case "IMAGE":
        ok = await imageOps(ex, body, n, op);
        break;
      case "PDF":
        ok = await pdfNodeOps(ex, body, n, op);
        break;
      case "RASTER":
        rasterOps(ex, body, n, op, page.width, page.height);
        break;
      case "MEDIA":
        await mediaOps(ex, body, n, op);
        break;
    }
  } catch (e) {
    // fonts are essential: let the caller fall back to the image export
    if (n.type === "TEXT" || n.type === "TABLE") throw e;
    ex.warn(`${n.name}: ${(e as Error).message}`);
    ok = false;
  }
  if (!ok) {
    if (await rasterFallback(ex, ops, page, n)) return ops;
    ex.warn(`${n.name}: PDF로 내보낼 수 없어 빠졌습니다 (${n.type})`);
    return ops;
  }
  if (!body.length) return ops;
  // layer effects: pictures under / over the live content (pdfEffects.ts); not when the node already went in as a picture
  const fx = !ops.length && n.effects?.length ? await pdfEffectImages(page, n, ex.opts.rasterize) : null;
  const fxImage = (im: PdfFxImage | null) => {
    if (!im) return;
    ops.push(pushGraphicsState());
    const g = ex.gs(op, op, im.blend as BlendMode);
    if (g) ops.push(g);
    drawXObject(ex, ops, ex.rgbaImage(im.rgba, im.pw, im.ph), im.x, im.y, im.w, im.h);
    ops.push(popGraphicsState());
  };
  if (fx?.tooBig) ex.warn(`${n.name}: 레이어 효과가 너무 커서(${MAX_FX_PIXELS / 1e6}MP 초과) PDF에는 효과 없이 넣었습니다`);
  fxImage(fx?.below ?? null);
  ops.push(pushGraphicsState());
  if (t.x || t.y) ops.push(concatTransformationMatrix(1, 0, 0, 1, t.x, t.y));
  if (t.rotation) {
    const a = (t.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    ops.push(concatTransformationMatrix(c, s, -s, c, 0, 0));
  }
  const sy = t.scaleY ?? t.scale;
  if (t.scale !== 1 || sy !== 1) ops.push(concatTransformationMatrix(t.scale, 0, 0, sy, 0, 0));
  // non-destructive crop → clipping path in node space (the original image / page stays whole in the file)
  if ((n.type === "IMAGE" || n.type === "RASTER" || n.type === "PDF") && n.crop) ops.push(rectangle(n.crop.x, n.crop.y, n.crop.w, n.crop.h), clip(), endPath());
  ops.push(...body, popGraphicsState());
  fxImage(fx?.above ?? null);
  return ops;
}

// ───────── layer groups and clipping masks ─────────
//
// Groups that need their own compositing (opacity < 1 or a blend mode) become transparency group Form XObjects
// (isolated, or non-isolated for a faded Pass Through group) drawn with the group's opacity and blend mode.
// A clip stack: its base is drawn, then the clipped layers inside a clipping path — the base's own outline for a
// filled vector shape — or under a soft mask made from the base itself (/S /Alpha), which follows any base
// exactly (image, text, raster…); the whole stack is a transparency group when the base has an opacity or blend.

/** A Form XObject over the page (page px space) holding `inner`; a transparency group when `isolated` is set. */
function formOf(ex: Exporter, page: Page, inner: Ops, isolated: boolean | null): PDFRef {
  const ctx = ex.pdf.context;
  const res = (ex.page.node as unknown as { normalizedEntries(): { Resources: unknown } }).normalizedEntries().Resources;
  const dict: Record<string, unknown> = { BBox: [0, 0, page.width, page.height], Resources: res };
  if (isolated !== null) dict.Group = ctx.obj({ Type: "Group", S: "Transparency", I: isolated, K: false, CS: "DeviceRGB" });
  return ctx.register(ctx.formXObject(inner, dict as any));
}

function drawForm(ex: Exporter, ops: Ops, ref: PDFRef, opacity: number, blend: BlendMode) {
  ops.push(pushGraphicsState());
  const g = ex.gs(opacity, opacity, blend);
  if (g) ops.push(g);
  ops.push(drawObject(ex.xobjectName(ref)), popGraphicsState());
}

/** Page-space clipping path of a plain filled vector shape (no stroke, no animation); null for anything else. */
function vectorClip(n: SceneNode): Ops | null {
  if (n.type !== "VECTOR" || !n.fill || (n.stroke && n.strokeWidth > 0) || !n.contours.length) return null;
  const c = parseColor(n.fill);
  if (!c || c.a < 1) return null;
  const t = n.transform;
  const a = (t.rotation * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a), sx = t.scale, sy = t.scaleY ?? t.scale;
  const P = (p: [number, number]): [number, number] => [t.x + cos * p[0] * sx - sin * p[1] * sy, t.y + sin * p[0] * sx + cos * p[1] * sy];
  const out: Ops = [];
  for (const k of n.contours) {
    if (!k.nodes.length) continue;
    out.push(moveTo(...P(k.nodes[0].anchor)));
    for (const [s, e] of segments(k)) {
      const [x1, y1] = P(s.handleOut), [x2, y2] = P(e.handleIn), [x3, y3] = P(e.anchor);
      out.push(appendBezierCurve(x1, y1, x2, y2, x3, y3));
    }
    if (k.closed) out.push(closePath());
  }
  if (!out.length) return null;
  out.push(n.fillRule === "evenodd" ? clipEvenOdd() : clip(), endPath());
  return out;
}

const bare = (n: SceneNode) => ({ ...n, opacity: 1, blendMode: "NORMAL" }) as SceneNode;

async function itemsOps(ex: Exporter, page: Page, items: TreeItem[]): Promise<Ops> {
  const ops: Ops = [];
  // AutoCAD never plots Defpoints, nor a layer marked no-plot; block members kept on such a layer (`cadLayer`) too
  const noPlot = (g: LayerGroup) => !!g.cad?.noPlot || (!g.parentId && g.cad?.layer?.toUpperCase() === "DEFPOINTS");
  const noPlotLayers = new Set((page.groups ?? []).filter((g) => !g.parentId && g.cad?.layer && noPlot(g)).map((g) => g.cad!.layer!.toUpperCase()));
  for (const it of items) {
    // a drawing's no-plot layers (and viewport frames) stay out of the PDF, as AutoCAD's plot leaves them out
    if (it.kind === "node" ? !it.node.visible || it.node.opacity <= 0 || (!!it.node.cadLayer && noPlotLayers.has(it.node.cadLayer.toUpperCase())) : !it.group.visible || it.group.opacity <= 0 || noPlot(it.group)) continue;
    const clips = it.clips.filter((c) => c.visible && c.opacity > 0);
    if (!clips.length) {
      ops.push(...(await itemOps(ex, page, it)));
      continue;
    }
    // clip stack
    const baseOps = it.kind === "node" ? await nodeOps(ex, page, bare(it.node)) : await itemsOps(ex, page, it.children);
    const clipped: Ops = [];
    for (const c of clips) clipped.push(...(await nodeOps(ex, page, c)));
    const stack: Ops = [...baseOps];
    const path = it.kind === "node" ? vectorClip(it.node) : null;
    if (path) stack.push(pushGraphicsState(), ...path, ...clipped, popGraphicsState());
    else {
      const mask = formOf(ex, page, baseOps, true);
      const ctx = ex.pdf.context;
      const gsRef = ctx.register(ctx.obj({ Type: "ExtGState", SMask: ctx.obj({ Type: "Mask", S: "Alpha", G: mask }) }));
      stack.push(pushGraphicsState(), setGraphicsState(ex.page.node.newExtGState("GS", gsRef)), ...clipped, popGraphicsState());
    }
    const op = it.kind === "node" ? it.node.opacity : it.group.opacity;
    const blend: BlendMode = it.kind === "node" ? it.node.blendMode : it.group.blendMode === "PASS_THROUGH" ? "NORMAL" : it.group.blendMode;
    if (op >= 1 && blend === "NORMAL") ops.push(pushGraphicsState(), ...stack, popGraphicsState());
    else drawForm(ex, ops, formOf(ex, page, stack, true), op, blend);
  }
  return ops;
}

async function itemOps(ex: Exporter, page: Page, it: TreeItem): Promise<Ops> {
  if (it.kind === "node") return nodeOps(ex, page, it.node);
  const g = it.group;
  if (g.effects?.some((e) => e.on)) ex.warn(`${g.name}: 그룹에 준 레이어 효과는 PDF에 넣지 못했습니다 (그룹 안 개체의 효과는 그대로)`);
  const inner = await itemsOps(ex, page, it.children);
  if (!inner.length) return [];
  if (g.blendMode === "PASS_THROUGH" && g.opacity >= 1) return inner;
  const ops: Ops = [];
  // Pass Through faded: a non-isolated group (members still see the backdrop); otherwise isolated
  drawForm(ex, ops, formOf(ex, page, inner, g.blendMode !== "PASS_THROUGH"), g.opacity, g.blendMode === "PASS_THROUGH" ? "NORMAL" : g.blendMode);
  return ops;
}

/** One page's (or master's) layers: node by node, or through the layer tree when it has groups / clipping. */
async function layerOps(ex: Exporter, page: Page, layers: Page): Promise<Ops> {
  // an unedited PSD page: Photoshop's merged image as one picture (what Photoshop shows: adjustment layers, every
  // blend mode — core/fidelity/overlay.ts pristinePsdView)
  // an edited CMYK PSD page that blends: its CMYK composite as one picture (core/image/cmykComposite.ts)
  if (pageDissolves(layers)) await loadDissolveField().catch(() => {});
  layers = pristinePsdView(layers) ?? cmykFlatPage(ex.doc, layers) ?? layers;
  if (!hasStructure(layers.nodes, layers.groups)) {
    const ops: Ops = [];
    for (const n of layers.nodes) ops.push(...(await nodeOps(ex, page, n)));
    return ops;
  }
  return itemsOps(ex, page, buildTree(layers.nodes, layers.groups));
}

// ───────── document ─────────

function addOutline(pdf: PDFDocument, entries: { title: string; page: PDFPage }[]) {
  const ctx = pdf.context;
  const rootRef = ctx.nextRef();
  const refs = entries.map(() => ctx.nextRef());
  entries.forEach((e, i) => {
    const item: Record<string, unknown> = {
      Title: PDFHexString.fromText(e.title),
      Parent: rootRef,
      Dest: ctx.obj([e.page.ref, PDFName.of("XYZ"), null, null, null]),
    };
    if (i > 0) item.Prev = refs[i - 1];
    if (i < refs.length - 1) item.Next = refs[i + 1];
    ctx.assign(refs[i], ctx.obj(item as any));
  });
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
  pdf.catalog.set(PDFName.of("Outlines"), rootRef);
  pdf.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

/**
 * Export pages as a vector PDF with live (selectable, searchable) text.
 * Page size: 1px = 0.75pt. Master-page nodes are drawn first, then the page's own nodes.
 */
export async function exportPdfVector(doc: OmwDocument, pages: Page[], opts: PdfVectorOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  // fontkit (≈0.6 MB of code) loads with the first export, not at startup
  pdf.registerFontkit((await import("@pdf-lib/fontkit")).default);
  const now = new Date();
  pdf.setTitle(doc.title || "제목 없음", { showInWindowTitleBar: true });
  pdf.setCreator(PDF_PRODUCER);
  pdf.setProducer(`${PDF_PRODUCER} (pdf-lib)`);
  pdf.setCreationDate(now);
  pdf.setModificationDate(now);
  pdf.setLanguage("ko-KR");
  const ex = new Exporter(pdf, doc, opts);
  const outline: { title: string; page: PDFPage }[] = [];
  for (const page of pages) {
    const W = page.width, H = page.height;
    const pp = pdf.addPage([W * PX_TO_PT, H * PX_TO_PT]);
    ex.beginPage(pp);
    const ops: Ops = [
      pushGraphicsState(),
      // page space: Omniweave px, origin top-left, y down
      concatTransformationMatrix(PX_TO_PT, 0, 0, -PX_TO_PT, 0, H * PX_TO_PT),
      rectangle(0, 0, W, H),
      clip(),
      endPath(),
    ];
    fillRect(ex, ops, 0, 0, W, H, page.background, 1, "NORMAL");
    const master = renderMasterOf(doc, page); // with its header, footer and page number (core/headerFooter.ts)
    if (master) ops.push(...(await layerOps(ex, page, master)));
    ops.push(...(await layerOps(ex, page, page)));
    ops.push(popGraphicsState());
    pp.pushOperators(...ops);
    outline.push({ title: page.name || `${outline.length + 1}쪽`, page: pp });
  }
  if (!pages.length) pdf.addPage([794 * PX_TO_PT, 1123 * PX_TO_PT]);
  if (Array.isArray(opts.outline)) {
    const entries = opts.outline.filter((e) => e.page >= 0 && e.page < outline.length).map((e) => ({ title: e.title, page: outline[e.page].page }));
    if (entries.length) addOutline(pdf, entries);
  } else if (outline.length > 1 && opts.outline !== false) addOutline(pdf, outline);
  // lossless: drop objects no page reaches (e.g. private data of copied source pages) and duplicate streams
  await tidyBeforeSave(pdf);
  return pdf.save({ useObjectStreams: true });
}

