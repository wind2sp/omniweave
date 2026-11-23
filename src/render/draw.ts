// Node painters for Canvas2D. Each painter is pure with respect to its node; async resources
// (decoded images, PDF page bitmaps) report `env.incomplete` so the Weave Cache will not
// keep a tile that was painted before its resources arrived.

import { isEmptyPh } from "../core/slides";
import { decodePicture } from "./picDecode";
import { getBlob } from "../core/assets";
import type { NodeOverride } from "../core/anim";
import { inverseTransformRect, scaleYOf, type Rect } from "../core/geom";
import { localBounds } from "../core/loom";
import { CELL_PAD_Y, TABLE_LINE, cellFont, hasMerges, layoutTable, lineX, tableCells } from "../core/table";
import { SCRIPT_SCALE, graphemes, isLockedFont, layoutText, measure, shadeWidth, type Piece } from "../core/text";
import { reviewLook } from "../core/review";
import { contourToSvgD, paintBox } from "../core/vector";
import type { Paint } from "../core/style/types";
import { boxLines, paraBoxes } from "../core/paraBox";
import { TILE, type ImageNode, type MediaNode, type OmwDocument, type PdfNode, type PixelTile, type SceneNode, type TableNode, type TextNode, type Vec2, type VectorNode } from "../core/types";
import { pdfBitmap, pdfBitmapIsExact, pdfBitmapScale, pdfViewHash } from "../io/pdf";
import { CANVAS_BLEND, fillParts } from "../core/style/blend";
import { pixelGrid } from "./crisp";

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawEnv {
  doc: OmwDocument;
  /** page-space rectangle being painted (for raster tile culling) */
  clip: Rect;
  /** device pixels per page unit (for picking PDF render resolution) */
  scale: number;
  incomplete: boolean;
  onResourceReady: () => void;
  /** painting an on-screen weave tile (not export / thumbnails): thin rules may be fitted to device pixels */
  screen?: boolean;
}

export function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  w = Math.max(1, Math.ceil(w));
  h = Math.max(1, Math.ceil(h));
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: OffscreenCanvas | HTMLCanvasElement): Ctx {
  return c.getContext("2d") as Ctx;
}

/** Model blend mode → Canvas composite operation (from the single blend table, core/style/blend.ts). */
export const BLEND: Record<string, GlobalCompositeOperation> = CANVAS_BLEND;

// ---- pixel tile -> canvas (by thread identity) ----
const tileCanvases = new WeakMap<Uint8ClampedArray, OffscreenCanvas | HTMLCanvasElement>();
export function tileCanvas(t: PixelTile) {
  let c = tileCanvases.get(t.data);
  if (!c) {
    c = makeCanvas(TILE, TILE);
    ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(t.data), TILE, TILE), 0, 0);
    tileCanvases.set(t.data, c);
  }
  return c;
}

// ---- vectors ----
const paths = new WeakMap<VectorNode, Path2D>();
export function vectorPath(n: VectorNode): Path2D {
  let p = paths.get(n);
  if (!p) {
    p = new Path2D(n.contours.map(contourToSvgD).join(" "));
    paths.set(n, p);
  }
  return p;
}

/** A stroke width of at least one device pixel under the current transform (thin lines never fade out). */
function minHairline(ctx: Ctx, w: number): number {
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b) || 1;
  return Math.max(w, 1 / k);
}

/**
 * On-screen paths made only of straight horizontal / vertical segments under an axis-aligned transform: the fill
 * path with edges on device-pixel boundaries and the stroke path centred so its (whole-pixel) width covers whole
 * device pixels. Null for anything else (curves, diagonals, rotation) — drawn as modelled. Display only.
 */
type CrispPath = { fill: Path2D; stroke: Path2D; lw: number };
/** whether a path is made only of straight h / v segments (nodes are immutable: once per node) */
const straightHV = new WeakMap<VectorNode, boolean>();
/**
 * The fitted paths of a node for the last device grid it was drawn on. The fit depends only on the scale and the
 * fractional device offset (whole-pixel shifts — neighbouring tiles, panning by whole pixels — give the same paths),
 * so repaints reuse the Path2D objects instead of building them on every draw.
 */
const crispPaths = new WeakMap<VectorNode, { key: string; v: CrispPath }>();

function isStraightHV(n: VectorNode): boolean {
  let ok = straightHV.get(n);
  if (ok !== undefined) return ok;
  ok = true;
  scan: for (const c of n.contours) {
    const segs = c.closed ? c.nodes.length : c.nodes.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = c.nodes[i], b = c.nodes[(i + 1) % c.nodes.length];
      const flat = a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1] && b.handleIn[0] === b.anchor[0] && b.handleIn[1] === b.anchor[1];
      if (!flat || (a.anchor[0] !== b.anchor[0] && a.anchor[1] !== b.anchor[1])) {
        ok = false;
        break scan;
      }
    }
  }
  straightHV.set(n, ok);
  return ok;
}

function onDevicePixels(ctx: Ctx, n: VectorNode): CrispPath | null {
  const g = pixelGrid(ctx, n.stroke ? n.strokeWidth : 1);
  if (!g || !isStraightHV(n)) return null;
  const m = ctx.getTransform();
  // (rounded: 7.4 − 7 is 0.4000000000000004; paths that far apart are the same on any screen)
  const frac = (v: number) => Math.round((v - Math.floor(v)) * 1e6) / 1e6;
  const key = `${m.a} ${m.d} ${frac(m.e)} ${frac(m.f)} ${g.lw}`;
  const hit = crispPaths.get(n);
  if (hit?.key === key) return hit.v;
  const edge = (v: number, s: number, o: number) => (Math.round(s * v + o) - o) / s;
  const build = (fx: (v: number) => number, fy: (v: number) => number) => {
    let d = "";
    for (const c of n.contours) {
      c.nodes.forEach((a, i) => (d += `${i ? "L" : "M"}${fx(a.anchor[0])} ${fy(a.anchor[1])}`));
      if (c.closed) d += "Z";
    }
    return new Path2D(d);
  };
  const v = { fill: build((v) => edge(v, m.a, m.e), (v) => edge(v, m.d, m.f)), stroke: build(g.x, g.y), lw: g.lw };
  crispPaths.set(n, { key, v });
  return v;
}

// ---- images ----
type Decoded = ImageBitmap | HTMLImageElement;
const images = new Map<string, Decoded | "loading" | "error">();

/** Drop every decoded picture (the phone viewer closing a document, ui/mobile/openDoc.ts). */
export function dropDecodedImages(): void {
  for (const v of images.values()) if (typeof v === "object" && "close" in v) (v as ImageBitmap).close();
  images.clear();
}

/** Decode an image asset (render/picDecode.ts: SVG stays vector, EMF / WMF are played into SVG). */
const decodeAsset = decodePicture;

/**
 * A picture into the box (0, 0, w, h) of the current transform, the way PowerPoint's own output looks:
 * - shrunk more than twice, it is first halved step by step (each step averages 2×2 pixels — a box filter) and only the
 *   last step is a plain smoothed draw, so fine lines in a large photo or screenshot average out instead of beating
 *   into moiré (a direct bilinear draw samples a few source pixels of many). PowerPoint's PDF shown by pdf.js is made
 *   the same way, which the fidelity screen compares against;
 * - not rotated or skewed, its edges sit on whole device pixels (no half-covered, washed-out border).
 * Vector pictures (SVG, EMF / WMF through render/picDecode.ts) are drawn as they are: their edges are drawn, not
 * sampled. The halved copy is kept per picture for the last size asked.
 */
export function drawPicture(ctx: Ctx, pic: CanvasImageSource, w: number, h: number, crop?: Rect) {
  const m = ctx.getTransform();
  const raster = typeof HTMLImageElement === "undefined" || !(pic instanceof HTMLImageElement);
  if (!raster || !axisAligned(m) || w <= 0 || h <= 0) {
    ctx.drawImage(pic, 0, 0, w, h);
    return;
  }
  // the shown part (a crop) is what sits on whole pixels — PowerPoint's PDF holds a cropped picture as the cropped
  // pixels placed at the shown box, and pdf.js puts that box on whole pixels; snapping the uncropped box instead moved
  // the content up to half a pixel against it (6–9 corpus slides 0.002–0.033 lower, QA 2026-11-21)
  // (a negative crop — space around the picture — only adds empty room: the picture's own pixels are what is placed)
  const v = crop && crop.w > 0 && crop.h > 0 ? shownPart(crop, w, h) : { x: 0, y: 0, w, h };
  if (v.w <= 0 || v.h <= 0) return;
  const r = snapRect(m, v);
  const kx = r.w / v.w, ky = r.h / v.h; // device pixels per local unit
  const src = halved(pic as ImageBitmap | OffscreenCanvas | HTMLCanvasElement, Math.max(1, Math.round(w * kx)), Math.max(1, Math.round(h * ky))) as ImageBitmap | OffscreenCanvas | HTMLCanvasElement;
  const sx = src.width / w, sy = src.height / h; // source pixels per local unit
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (crop) ctx.drawImage(src, v.x * sx, v.y * sy, v.w * sx, v.h * sy, r.x, r.y, r.w, r.h);
  else ctx.drawImage(src, r.x, r.y, r.w, r.h);
  ctx.setTransform(m);
}

/** the crop rectangle within the picture's box (0, 0, w, h) */
function shownPart(c: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, c.x), y0 = Math.max(0, c.y), x1 = Math.min(w, c.x + c.w), y1 = Math.min(h, c.y + c.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** no rotation, skew or flip: the picture's box can sit on whole device pixels */
const axisAligned = (m: DOMMatrix) => m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0;
/** a local rectangle on whole device pixels (at least one), as pdf.js places a picture */
function snapRect(m: DOMMatrix, v: Rect): Rect {
  const x0 = Math.round(m.e + m.a * v.x), y0 = Math.round(m.f + m.d * v.y);
  const x1 = Math.max(x0 + 1, Math.round(m.e + m.a * (v.x + v.w))), y1 = Math.max(y0 + 1, Math.round(m.f + m.d * (v.y + v.h)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const halves = new WeakMap<object, { key: string; c: OffscreenCanvas | HTMLCanvasElement }>();
/** `pic` halved (rounded up) while it is still more than twice the target on a side — at most 8 steps */
function halved(pic: ImageBitmap | OffscreenCanvas | HTMLCanvasElement, dw: number, dh: number): CanvasImageSource {
  let w = pic.width, h = pic.height;
  if (!(w > 2 * dw || h > 2 * dh) || w * h > 1 << 26) return pic;
  const sizes: [number, number][] = [];
  for (let i = 0; i < 8 && (w > 2 * dw || h > 2 * dh); i++) {
    if (w > 2 * dw) w = Math.ceil(w / 2);
    if (h > 2 * dh) h = Math.ceil(h / 2);
    sizes.push([w, h]);
  }
  const key = sizes.map((s) => s.join("x")).join(",");
  const hit = halves.get(pic);
  if (hit?.key === key) return hit.c;
  let cur: CanvasImageSource = pic;
  let c: OffscreenCanvas | HTMLCanvasElement | null = null;
  for (const [sw, sh] of sizes) {
    c = makeCanvas(sw, sh);
    ctx2d(c).drawImage(cur, 0, 0, sw, sh);
    cur = c;
  }
  halves.set(pic, { key, c: c! });
  return c!;
}

/**
 * The canvas gradient of a vector's first fill when it is a linear or radial gradient (node-local; `from` / `to` are
 * units of the path's box — core/vector paintBox), or null (a plain fill, or kinds not drawn this way).
 */
export function vectorGradient(ctx: Ctx, n: VectorNode, f: Paint | undefined = (n as VectorNode & { fills?: Paint[] }).fills?.[0]): CanvasGradient | null {
  if (!f || f.type !== "gradient" || (f.kind !== "linear" && f.kind !== "radial") || f.stops.length < 1) return null;
  const b = paintBox(n);
  const at = (u: Vec2): [number, number] => [b.x + u[0] * b.w, b.y + u[1] * b.h];
  const [x0, y0] = at(f.from), [x1, y1] = at(f.to);
  const r1 = Math.max(1e-6, Math.hypot(x1 - x0, y1 - y0));
  const [fx, fy] = f.focal ? at(f.focal) : [x0, y0];
  const g = f.kind === "linear" ? ctx.createLinearGradient(x0, y0, x1, y1) : ctx.createRadialGradient(fx, fy, Math.max(0, (f.focalRadius ?? 0) * r1), x0, y0, r1);
  for (const s of [...f.stops].sort((p, q) => p.at - q.at)) {
    const hex = s.color.hex;
    const a = s.color.a ?? 1;
    g.addColorStop(Math.min(1, Math.max(0, s.at)), a >= 1 ? hex : `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`);
  }
  return g;
}

/** Pixel size of a picture node's decoded image (null while it is still decoding — env.incomplete is then set). */
export function pictureSize(n: ImageNode, env: DrawEnv): { w: number; h: number } | null {
  const a = env.doc.assets[n.assetId];
  const bmp = a ? imageFor(a.hash, a.mime, env, a.exifIgnored) : null;
  const w = (bmp as { width?: number } | null)?.width, h = (bmp as { height?: number } | null)?.height;
  return w && h ? { w, h } : null;
}

function imageFor(hash: string, mime: string, env: DrawEnv, exifIgnored = false): Decoded | null {
  const key = exifIgnored ? `${hash}|raw` : hash;
  const v = images.get(key);
  if (v && v !== "loading" && v !== "error") return v;
  if (v === "error") return null;
  env.incomplete = true;
  if (!v) {
    const bytes = getBlob(hash);
    if (!bytes) return null;
    images.set(key, "loading");
    decodeAsset(bytes, mime, { exifIgnored })
      .then((bmp) => {
        images.set(key, bmp);
        env.onResourceReady();
      })
      .catch(() => images.set(key, "error"));
  }
  return null;
}

// ── drawing pages on screen: light colours on the white sheet ──
// AutoCAD draws on a dark model space, so drawings use yellow (ACI 2), cyan, light grey … freely; on the white sheet
// they nearly vanish. Like AutoCAD's own background-dependent colour (ACI 7 black on white), on-screen tiles of a
// drawing page darken such colours until they read; thumbnails, PDF / image export and print keep the original colour.
let cadInk = false;
/** set while weave paints on-screen tiles of a drawing page (render/weave.ts) */
export function setCadInk(on: boolean) {
  cadInk = on;
}
const inkCache = new Map<string, string>();
/** a light #rrggbb colour darkened to about 45 % relative luminance (hue kept); others unchanged */
export function readableInk(c: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(c)) return c;
  let v = inkCache.get(c);
  if (v) return v;
  const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  v = c;
  if (lum > 0.5) {
    // scale in linear light so the luminance lands at 0.18 (contrast ≈ 4.4 : 1 on white)
    const k = 0.18 / lum;
    const enc = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
    v = "#" + rgb.map((x) => Math.round(enc(lin(x) * k) * 255).toString(16).padStart(2, "0")).join("");
  }
  inkCache.set(c, v);
  return v;
}
const ink = (c: string) => (cadInk ? readableInk(c) : c);

export function drawText(ctx: Ctx, n: TextNode) {
  const lay = layoutText(n);
  if (n.background) {
    ctx.fillStyle = n.background;
    ctx.fillRect(0, 0, n.width, lay.height);
  }
  ctx.textBaseline = "alphabetic";
  // paragraph shading and borders (Word w:shd / w:pBdr, 한글 문단 테두리·배경) under the text
  if (n.paragraphs.some((p) => p.border || p.shade)) drawParaBoxes(ctx, n, lay.lines);
  // highlights first, so a neighbouring piece's glyphs are never covered by the next shading
  // (tracked changes and comments in the markup view: core/review.ts reviewLook)
  for (const line of lay.lines)
    for (const p of line.pieces) {
      const hl = p.hidden ? undefined : reviewLook(p.run).highlight;
      if (hl) {
        ctx.fillStyle = hl;
        // trailing spaces of the last piece on a line are not shaded (Word behaviour; centred / right lines too)
        const w = shadeWidth(line, p);
        const top = line.y + line.baseline - p.run.fontSize * 0.95;
        ctx.fillRect(p.x, top, w, p.run.fontSize * 1.22);
      }
    }
  const lsCtx = ctx as Ctx & { letterSpacing?: string };
  const hasLs = "letterSpacing" in ctx;
  for (const line of lay.lines) {
    for (const p of line.pieces) {
      if (p.hidden) continue;
      const look = reviewLook(p.run);
      ctx.font = p.font;
      ctx.fillStyle = ink(look.color);
      const base = line.y + line.baseline;
      const y = base + (p.dy ?? 0);
      if (p.hscale || p.spacing || isLockedFont(p.font)) drawScaledPiece(ctx, p, y);
      else {
        if (p.letterSpacing && hasLs) lsCtx.letterSpacing = `${p.letterSpacing}px`;
        ctx.fillText(p.text, p.x, y);
        if (p.letterSpacing && hasLs) lsCtx.letterSpacing = "0px";
      }
      const size = p.run.script ? p.run.fontSize * SCRIPT_SCALE : p.run.fontSize;
      const thick = Math.max(1, size / 16);
      if (look.underline) ctx.fillRect(p.x, y + size * 0.12, p.width, thick);
      if (look.strike) ctx.fillRect(p.x, y - size * 0.3, p.width, thick);
    }
  }
}

/** Shaded and bordered paragraph boxes of a text (core/paraBox.ts). */
function drawParaBoxes(ctx: Ctx, n: TextNode, lines: ReturnType<typeof layoutText>["lines"]) {
  const boxes = paraBoxes(n.paragraphs, n.width, lines);
  for (const b of boxes)
    if (b.shade) {
      ctx.fillStyle = b.shade;
      ctx.fillRect(b.x0, b.top, b.x1 - b.x0, b.bottom - b.top);
    }
  ctx.save();
  ctx.lineCap = "butt";
  for (const b of boxes)
    for (const [x0, y0, x1, y1, l] of boxLines(b)) {
      ctx.strokeStyle = l.color;
      ctx.setLineDash(l.style === "dashed" ? [l.w * 3, l.w * 2] : l.style === "dotted" ? [l.w, l.w] : []);
      if (l.style === "double") {
        // two lines a third of the width each, a third apart
        const t = l.w / 3, vert = x0 === x1;
        ctx.lineWidth = t;
        for (const d of [-t, t]) {
          ctx.beginPath();
          ctx.moveTo(x0 + (vert ? d : 0), y0 + (vert ? 0 : d));
          ctx.lineTo(x1 + (vert ? d : 0), y1 + (vert ? 0 : d));
          ctx.stroke();
        }
        continue;
      }
      ctx.lineWidth = l.w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  ctx.restore();
}

/**
 * A piece with 장평 (glyphs narrowed / widened) or 한글 자간 (each character followed by a share of its own
 * advance): grapheme by grapheme at the advances layoutText measured (core/text.ts advance with runScale).
 */
function drawScaledPiece(ctx: Ctx, p: Piece, y: number) {
  const h = p.hscale ?? 1;
  const k = h * (1 + (p.spacing ?? 0));
  const ls = p.letterSpacing ?? 0;
  // (a metric-locked document font is measured at 한글's widths: its glyphs go where those widths put them)
  if (!p.spacing && !ls && !isLockedFont(p.font)) {
    ctx.save();
    ctx.translate(p.x, y);
    ctx.scale(h, 1);
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
    return;
  }
  let x = p.x;
  for (const g of graphemes(p.text)) {
    const w = measure(g, p.font);
    if (g.trim()) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(h, 1);
      ctx.fillText(g, 0, 0);
      ctx.restore();
    }
    x += w * k + ls;
  }
}

export function drawTable(ctx: Ctx, n: TableNode, screen = false) {
  const l = layoutTable(n);
  if (n.background) {
    ctx.fillStyle = n.background;
    ctx.fillRect(0, 0, l.width, l.height);
  }
  const lh = n.fontSize * TABLE_LINE;
  ctx.textBaseline = "alphabetic";
  // merged cells draw over their whole range (core/table tableCells); covered cells are not drawn
  const cells = tableCells(n);
  for (const v of cells) {
    const { x: x0, y: y0, w, h } = v.rect;
    const fill = v.cell.fill ?? (n.headerRow && v.r === 0 ? n.headerFill : null);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x0, y0, w, h);
    }
    if (v.rich) {
      // a cell drawn from its own paragraphs (한글 tables): like body text, clipped to the cell
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, w, h);
      ctx.clip();
      ctx.translate(v.rich.x, v.rich.y);
      drawText(ctx, v.rich.node);
      ctx.restore();
      ctx.textBaseline = "alphabetic";
      continue;
    }
    if (!v.lines.length) continue;
    ctx.font = cellFont(n, v.cell, v.r);
    ctx.fillStyle = v.cell.color ?? n.color;
    v.lines.forEach((ln, i) => ctx.fillText(ln.text, lineX(v.cell.align, x0, w, ln.width), y0 + CELL_PAD_Y + i * lh + (lh - n.fontSize) / 2 + n.fontSize * 0.8));
  }
  ctx.strokeStyle = n.borderColor;
  // on screen the rules sit on whole device pixels, ≥ 1 px wide (as Word / 한글 show them); the model and
  // export keep the exact 1-unit lines (docs/design/RENDER_CRISPNESS.md)
  const g = screen ? pixelGrid(ctx, 1) : null;
  const gx = g ? g.x : (v: number) => v, gy = g ? g.y : (v: number) => v;
  ctx.lineWidth = g ? g.lw : 1;
  ctx.beginPath();
  if (hasMerges(n.rows)) {
    // one path of every cell's outline: a merged cell has no inner lines (shared edges are painted once)
    for (const v of cells) {
      const x0 = gx(v.rect.x), y0 = gy(v.rect.y);
      ctx.rect(x0, y0, gx(v.rect.x + v.rect.w) - x0, gy(v.rect.y + v.rect.h) - y0);
    }
  } else {
    const top = gy(0), bottom = gy(l.height), left = gx(0), right = gx(l.width);
    for (const x of l.colX) {
      ctx.moveTo(gx(x), top);
      ctx.lineTo(gx(x), bottom);
    }
    for (const y of l.rowY) {
      ctx.moveTo(left, gy(y));
      ctx.lineTo(right, gy(y));
    }
  }
  ctx.stroke();
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function drawMedia(ctx: Ctx, n: MediaNode, env: DrawEnv) {
  const poster = n.posterAssetId ? env.doc.assets[n.posterAssetId] : undefined;
  const bmp = poster ? imageFor(poster.hash, poster.mime, env, poster.exifIgnored) : null;
  const { width: w, height: h } = n;
  if (bmp) ctx.drawImage(bmp, 0, 0, w, h);
  else {
    ctx.fillStyle = n.media === "audio" ? "#2a2440" : "#16181d";
    ctx.fillRect(0, 0, w, h);
  }
  const r = Math.max(10, Math.min(w, h) * 0.14);
  const cx = n.media === "audio" ? r * 1.6 : w / 2, cy = h / 2;
  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  if (n.media === "audio") {
    // speaker glyph
    const k = r / 10;
    ctx.moveTo(cx - 6 * k, cy - 3 * k);
    ctx.lineTo(cx - 2 * k, cy - 3 * k);
    ctx.lineTo(cx + 3 * k, cy - 7 * k);
    ctx.lineTo(cx + 3 * k, cy + 7 * k);
    ctx.lineTo(cx - 2 * k, cy + 3 * k);
    ctx.lineTo(cx - 6 * k, cy + 3 * k);
  } else {
    ctx.moveTo(cx - r * 0.35, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.55, cy);
    ctx.lineTo(cx - r * 0.35, cy + r * 0.5);
  }
  ctx.closePath();
  ctx.fill();
  const fs = Math.max(9, Math.min(18, h * 0.12));
  ctx.font = `600 ${fs}px "Pretendard", sans-serif`;
  ctx.textBaseline = "alphabetic";
  if (n.media === "audio") {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(n.name.slice(0, 60), cx + r * 1.6, cy - fs * 0.1, Math.max(10, w - cx - r * 2));
  }
  if (n.duration > 0) {
    const end = n.trimEnd ?? n.duration;
    const label = `${fmtTime(Math.max(0, end - n.trimStart))}${n.trimStart > 0 || n.trimEnd !== null ? " ✂" : ""}`;
    ctx.fillStyle = n.media === "audio" ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.6)";
    if (n.media === "audio") ctx.fillText(label, cx + r * 1.6, cy + fs * 1.1);
    else {
      const tw = label.length * fs * 0.6 + 10;
      ctx.fillRect(w - tw - 6, h - fs - 12, tw, fs + 8);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, w - tw + 0, h - 10);
    }
  }
}

function drawPdf(ctx: Ctx, n: PdfNode, env: DrawEnv) {
  const asset = env.doc.assets[n.assetId];
  const exact = !env.screen && env.scale <= 2;
  // typed form values: the file filled with them (io/pdf.ts pdfViewHash)
  // (new marks / values still being written in: the page shown meanwhile is a stand-in, never kept in a tile cache)
  const pending = { v: false };
  const view = asset ? pdfViewHash(asset.hash, n, env.onResourceReady, env.doc, pending) : null;
  let bmp = asset && view ? pdfBitmap(view, n.pageIndex, env.scale, env.onResourceReady, exact) : null;
  if (pending.v) env.incomplete = true;
  // the filled file's page still rendering: the plain page meanwhile (no grey flash after each mark or keystroke)
  if (!bmp && asset && view !== asset.hash) {
    env.incomplete = true;
    bmp = pdfBitmap(asset.hash, n.pageIndex, env.scale, () => {}, exact);
  }
  // a stand-in while the exact render loads: drawn (one-shot exports still get the page), but marked incomplete so
  // painters that wait (thumbnails, export settling, the fidelity screen) paint again with the exact one
  if (bmp && exact && !pdfBitmapIsExact(bmp)) env.incomplete = true;
  if (bmp) {
    // at the bitmap's own size (its pixel size is rounded up; stretching it to the node shifted the page bottom)
    const k = pdfBitmapScale(bmp);
    if (k && Math.abs(bmp.width / k - n.width) <= 2 / k) ctx.drawImage(bmp, 0, 0, bmp.width / k, bmp.height / k);
    else ctx.drawImage(bmp, 0, 0, n.width, n.height);
  }
  else {
    env.incomplete = true;
    ctx.fillStyle = "#f3f4f6";
    ctx.fillRect(0, 0, n.width, n.height);
  }
  for (const c of n.covers) {
    ctx.fillStyle = c.color;
    ctx.fillRect(c.x, c.y, c.w, c.h);
  }
}

/**
 * Paint one node. `mode.bare` paints it at full opacity in normal mode (a clip-stack base: its opacity and blend
 * apply to the whole stack, see render/compose.ts); `mode.gco` forces the composite operation (clipping).
 */
export function drawNode(ctx: Ctx, n: SceneNode, env: DrawEnv, o?: NodeOverride, mode?: { bare?: boolean; gco?: GlobalCompositeOperation; mask?: boolean }) {
  // an empty slide placeholder shows its prompt on the canvas only (ui/CanvasView), never here
  if (!n.visible || isEmptyPh(n)) return;
  // an adjustment layer draws nothing itself (render/compose.ts recolours what is below it); `mask` draws its mask
  if (n.type === "RASTER" && n.adjust && !mode?.mask) return;
  // (fill: the pixels' share of the opacity — render/compose.ts sends the eight fill-in-formula modes to the CPU)
  const opacity = mode?.bare ? 1 : n.opacity * fillParts(n).content * (o ? o.opacity : 1);
  if (opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.globalCompositeOperation = mode?.gco ?? (mode?.bare ? "source-over" : BLEND[n.blendMode] ?? "source-over");
  const t = n.transform;
  ctx.translate(t.x + (o?.dx ?? 0), t.y + (o?.dy ?? 0));
  if (o && (o.scale !== 1 || o.rotation !== 0)) {
    // animation scale/rotation pivot around the node's visual centre
    const b = localBounds(n);
    const cx = (b.x + b.w / 2) * t.scale, cy = (b.y + b.h / 2) * (t.scaleY ?? t.scale);
    const a = (t.rotation * Math.PI) / 180;
    const px = cx * Math.cos(a) - cy * Math.sin(a), py = cx * Math.sin(a) + cy * Math.cos(a);
    ctx.translate(px, py);
    ctx.rotate((o.rotation * Math.PI) / 180);
    ctx.scale(o.scale, o.scale);
    ctx.translate(-px, -py);
  }
  if (t.rotation) ctx.rotate((t.rotation * Math.PI) / 180);
  if (t.scale !== 1 || (t.scaleY ?? t.scale) !== 1) ctx.scale(t.scale, t.scaleY ?? t.scale);
  // non-destructive crop: only the crop rectangle of the (complete) content is shown
  if ((n.type === "IMAGE" || n.type === "RASTER" || n.type === "PDF") && n.crop) {
    ctx.beginPath();
    const m = ctx.getTransform();
    if (n.type === "IMAGE" && axisAligned(m) && n.crop.w > 0 && n.crop.h > 0) {
      // the same whole device pixels drawPicture puts the shown part on (a fractional clip would wash its edge)
      const r = snapRect(m, n.crop);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.setTransform(m);
    } else ctx.rect(n.crop.x, n.crop.y, n.crop.w, n.crop.h);
    ctx.clip();
  }

  switch (n.type) {
    case "RASTER": {
      const local = inverseTransformRect(n.transform, env.clip);
      const tx0 = Math.floor(local.x / TILE), ty0 = Math.floor(local.y / TILE);
      const tx1 = Math.floor((local.x + local.w) / TILE), ty1 = Math.floor((local.y + local.h) / TILE);
      ctx.imageSmoothingEnabled = env.scale < 1;
      // Tile by tile, a 256 px seam that does not fall on a device-pixel edge (any zoom but whole multiples, and while
      // panning) is a device pixel each tile covers only in part: the two partial covers leave a faint line along every
      // seam (2026-11-23: a light 1 px line across a rasterized photo at 114 %). Under the tiles, a strip of the left /
      // upper tile's edge pixels two device pixels wide is laid across each seam that has a tile on both sides, so the
      // seam pixel is fully covered before the tiles go on top; the strip ends under the neighbour's own pixels.
      const sx = Math.abs(n.transform.scale) || 1, sy = Math.abs(scaleYOf(n.transform)) || 1;
      const ox = env.scale > 0 ? 1 / (env.scale * sx) : 0, oy = env.scale > 0 ? 1 / (env.scale * sy) : 0;
      const shown: [number, number, PixelTile][] = [];
      for (const [k, tile] of Object.entries(n.tiles)) {
        const i = k.indexOf("_");
        const tx = +k.slice(0, i), ty = +k.slice(i + 1);
        if (tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1) continue;
        shown.push([tx, ty, tile]);
      }
      if (ox && oy)
        for (const [tx, ty, tile] of shown) {
          const r = !!n.tiles[`${tx + 1}_${ty}`], b = !!n.tiles[`${tx}_${ty + 1}`];
          if (!r && !b) continue;
          const c = tileCanvas(tile), x1 = (tx + 1) * TILE, y1 = (ty + 1) * TILE;
          if (r) ctx.drawImage(c, TILE - 1, 0, 1, TILE, x1 - ox, ty * TILE, 2 * ox, TILE);
          if (b) ctx.drawImage(c, 0, TILE - 1, TILE, 1, tx * TILE, y1 - oy, TILE, 2 * oy);
          if (r && b && n.tiles[`${tx + 1}_${ty + 1}`]) ctx.drawImage(c, TILE - 1, TILE - 1, 1, 1, x1 - ox, y1 - oy, 2 * ox, 2 * oy);
        }
      for (const [tx, ty, tile] of shown) ctx.drawImage(tileCanvas(tile), tx * TILE, ty * TILE);      break;
    }
    case "VECTOR": {
      const p = vectorPath(n);
      // on screen, straight horizontal / vertical paths (rectangles, h / v lines) sit on whole device pixels and
      // every stroke is at least one device pixel wide, so a 1 pt line reads crisp at any zoom (Illustrator)
      const crispPath = env.screen ? onDevicePixels(ctx, n) : null;
      if (n.fill) {
        // a gradient fill (`fills`, from an SVG / Illustrator gradient) over the path's box; `fill` is its plain fallback
        ctx.fillStyle = vectorGradient(ctx, n) ?? ink(n.fill);
        ctx.fill(crispPath?.fill ?? p, n.fillRule);
      }
      if (n.stroke && n.strokeWidth > 0) {
        // a gradient stroke (`strokes`, from an SVG / Illustrator gradient stroke); `stroke` is its plain fallback
        ctx.strokeStyle = vectorGradient(ctx, n, (n as VectorNode & { strokes?: { paint: Paint }[] }).strokes?.[0]?.paint) ?? ink(n.stroke);
        ctx.lineWidth = crispPath?.lw ?? (env.screen ? minHairline(ctx, n.strokeWidth) : n.strokeWidth);
        ctx.lineJoin = n.strokeJoin ?? "round";
        ctx.lineCap = n.strokeCap ?? "round";
        if (n.strokeDash?.length) ctx.setLineDash(n.strokeDash);
        ctx.stroke(crispPath?.stroke ?? p);
        if (n.strokeDash?.length) ctx.setLineDash([]);
      }
      break;
    }
    case "TEXT":
      drawText(ctx, n);
      break;
    case "IMAGE": {
      const a = env.doc.assets[n.assetId];
      const bmp = a ? imageFor(a.hash, a.mime, env, a.exifIgnored) : null;
      if (bmp) drawPicture(ctx, bmp, n.width, n.height, n.crop);
      else {
        ctx.fillStyle = "#e5e7eb";
        ctx.fillRect(0, 0, n.width, n.height);
      }
      break;
    }
    case "PDF":
      drawPdf(ctx, n, env);
      break;
    case "TABLE":
      drawTable(ctx, n, env.screen);
      break;
    case "MEDIA":
      drawMedia(ctx, n, env);
      break;
  }
  ctx.restore();
}
