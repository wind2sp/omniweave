// "PSD Surgeon" — writes an Omniweave page back to Photoshop (.psd / .psb).
//
// For a page imported from a PSD (page.source.psd links each node to its original layer record and the
// original file is kept as an asset), only what changed is rewritten:
//   • nothing changed                  → the original file, byte for byte
//   • untouched layer                  → original record + channel data, byte for byte
//   • name / opacity / visibility / blend / lock / whole-pixel move
//                                      → the same record with just those fields patched (channel data verbatim)
//   • pixels edited (or rotated/scaled) → channels re-encoded (PackBits) in the document's mode and depth;
//                                         every other additional-info block kept (text / smart-object / shape
//                                         content blocks are dropped so Photoshop shows the edited pixels)
//   • text edited as text (psdText)   → pixels re-encoded and the TySh block rewritten (psdText.ts): it stays a text
//                                         layer; the global Txt2 copy is dropped so Photoshop reads the new text
//   • deleted / reordered / new layers → records removed / moved / created; groups, adjustment and fill
//                                         layers stay where they were relative to their neighbours
//   • merged image                     → recomposited from the written layers when anything visual changed
// A page that did not come from a PSD is written as a new 8-bit RGB PSD with one layer per node
// (vector, text, table… nodes rasterized, marked in the layer name).
// Format reference: Adobe "Photoshop File Formats Specification" (clean-room).

import { unzlibSync } from "fflate";
import { getBlob } from "../../core/assets";
import { applyTransform, invertTransform, transformRect } from "../../core/geom";
import { localBounds } from "../../core/loom";
import { TILE, type BlendMode, type GroupBlend, type LayerGroup, type OmwDocument, type Page, type PsdLayerLink, type PsdSourceMeta, type RasterNode, type SceneNode } from "../../core/types";
import { contiguousOrder, groupIndex, groupPath, hasStructure } from "../../core/layerTree";
import { compositeTree, type PlacedPixels } from "../../core/image/softComposite";
import { cmykStoreOf, composeInkPlanes, composeRegion, linearStoreOf, type InkPixels } from "../../core/image/cmykComposite";
import { PSD_BLEND_OUT, blendMixPixel, dissolveKeep, loadDissolveField, pageDissolves, pixelBlend } from "../../core/style/blend";
import { t } from "../../i18n";
import { effectsFingerprint } from "../../core/style/fingerprint";
import type { Effect } from "../../core/style/types";
import { buildEffectsDesc, effectsBlocks, globalLightAngle, parseFxBlock, writeFxBlock, type Desc } from "./psdFx";
import { editTySh, psdTextKey } from "./psdText";
import { defaultCmykProfile, type CmykXform } from "../../core/image/iccCmyk";
import { LONG_KEYS, PSD_GROUP_SEP, blendOptionsKey, colorChannels, decodeLayout, hasRealMergedData, importPsdPage, duotoneGrey, duotoneLut, type GreyOf, fxSourceBlock, layerCmykPlanes, parsePsdLayout, psdCmykProfile, psdLocked, rasterFingerprint, readChannelPlane, readCompositePlanes, recordName, sectionType, to8, type PsdBlock, type PsdLayout, type PsdRecord } from "./psd";
import { srgbToLinear } from "../../core/image/adjust";
import { maskFingerprint, maskPlane, shownTiles } from "../../core/image/layerMask";
import { tileBounds } from "../../core/image/pixels";
import { adjustmentBlocks } from "./psdAdjustWrite";
import { pathResources, readPaths, replacePathResources } from "./psdPaths";
import { guidesResource, readGuides, replaceGuidesResource } from "./psdGuides";
import { newTextTySh } from "./psdTextNew";
import { linkedEntry, smartPlacedData } from "./psdSmartNew";
import { PLACED_KEYS, placedWithCorners, placedWithSize, rebuildLinkedBlock, type LinkedData } from "./psdSmart";

export type RasterizeNode = (doc: OmwDocument, page: Page, node: SceneNode) => Promise<{ png: Uint8Array; x: number; y: number; w: number; h: number } | null>;

export interface PsdWriteOptions {
  /** browser renderer for non-raster nodes (2× PNG of the node cropped to the page) */
  rasterize?: RasterizeNode;
  /** drop the Content Credentials (C2PA 'CAI ') block of a changed file — its signature no longer matches */
  dropContentCredentials?: boolean;
  /** remove linked-file entries of smart objects that were rasterized (default true) */
  pruneLinkedFiles?: boolean;
}

export interface PsdWriteResult {
  bytes: Uint8Array;
  /** "original" = unchanged file bytes, "surgery" = original structure with edits, "fresh" = new file */
  method: "original" | "surgery" | "fresh";
  warnings: string[];
}

// ───────── byte output ─────────

class Out {
  private chunks: Uint8Array[] = [];
  private buf = new Uint8Array(1 << 14);
  private dv = new DataView(this.buf.buffer);
  private n = 0;
  size = 0;
  private room(k: number) {
    if (this.n + k > this.buf.length) this.flush();
  }
  private flush() {
    if (this.n) this.chunks.push(this.buf.slice(0, this.n));
    this.n = 0;
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.n++] = v & 255;
    this.size++;
  }
  u16(v: number) {
    this.room(2);
    this.dv.setUint16(this.n, v & 0xffff);
    this.n += 2;
    this.size += 2;
  }
  i16(v: number) {
    this.room(2);
    this.dv.setInt16(this.n, v);
    this.n += 2;
    this.size += 2;
  }
  u32(v: number) {
    this.room(4);
    this.dv.setUint32(this.n, v >>> 0);
    this.n += 4;
    this.size += 4;
  }
  i32(v: number) {
    this.room(4);
    this.dv.setInt32(this.n, v | 0);
    this.n += 4;
    this.size += 4;
  }
  len(v: number, long: boolean) {
    if (long) {
      this.u32(Math.floor(v / 2 ** 32));
      this.u32(v % 2 ** 32);
    } else {
      if (v > 0xffffffff) throw new Error("PSD 구역이 4GB를 넘습니다 — PSB(대형 문서)로 저장해야 합니다");
      this.u32(v);
    }
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  bytes(b: Uint8Array) {
    if (b.length < 256) {
      this.room(b.length);
      this.buf.set(b, this.n);
      this.n += b.length;
    } else {
      this.flush();
      this.chunks.push(b);
    }
    this.size += b.length;
  }
  pad(to: number) {
    while (this.size % to) this.u8(0);
  }
  done(): Uint8Array {
    this.flush();
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

// ───────── PackBits / channel encoding ─────────

/** PackBits-encode `src[s, s+n)` into `out`. */
function packRow(src: Uint8Array, s: number, n: number, out: Out) {
  const end = s + n;
  let i = s;
  while (i < end) {
    // run of identical bytes?
    let run = 1;
    while (i + run < end && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 3 || (run === 2 && i + run >= end)) {
      out.u8(257 - run);
      out.u8(src[i]);
      i += run;
      continue;
    }
    // literal until a run of 3 starts
    let lit = 0;
    while (i + lit < end && lit < 128) {
      if (i + lit + 2 < end && src[i + lit] === src[i + lit + 1] && src[i + lit] === src[i + lit + 2]) break;
      lit++;
    }
    out.u8(lit - 1);
    for (let k = 0; k < lit; k++) out.u8(src[i + k]);
    i += lit;
  }
}

/** One layer channel (compression word + data). PackBits RLE; empty channels are a bare "raw" word. */
export function encodeChannel(plane: Uint8Array, w: number, h: number, bpc: number, psb: boolean): Uint8Array {
  const o = new Out();
  if (w <= 0 || h <= 0) {
    o.u16(0);
    return o.done();
  }
  const row = w * bpc;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < h; y++) {
    const r = new Out();
    packRow(plane, y * row, row, r);
    rows.push(r.done());
  }
  o.u16(1);
  for (const r of rows) {
    if (!psb && r.length > 0xffff) throw new Error("RLE 행이 너무 깁니다");
    psb ? o.u32(r.length) : o.u16(r.length);
  }
  for (const r of rows) o.bytes(r);
  return o.done();
}

/** Merged image data: one compression word, then every channel (RLE row table for all channels first). */
function encodeImageData(planes: Uint8Array[], w: number, h: number, bpc: number, psb: boolean): Uint8Array {
  const o = new Out();
  o.u16(1);
  const row = w * bpc;
  const rows: Uint8Array[] = [];
  for (const p of planes)
    for (let y = 0; y < h; y++) {
      const r = new Out();
      packRow(p, y * row, row, r);
      rows.push(r.done());
    }
  for (const r of rows) psb ? o.u32(r.length) : o.u16(r.length);
  for (const r of rows) o.bytes(r);
  return o.done();
}

// ───────── colour conversion (exact inverses of psd.ts toRgba) ─────────

/** Blend modes Photoshop has for 32-bit documents (a 32-bit PSD with any other one does not open: Photoshop 2027). */
export const HDR_BLENDS = new Set<string>(["NORMAL", "PASS_THROUGH", "DISSOLVE", "DARKEN", "MULTIPLY", "LIGHTEN", "LINEAR_DODGE", "DIFFERENCE", "SUBTRACT", "DIVIDE", "HUE", "SATURATION", "COLOR", "LUMINOSITY", "LIGHTER_COLOR", "DARKER_COLOR"]);

export function writableMode(mode: number, depth: number): boolean {
  // 32-bit (HDR): RGB and grey, by the PSD Surgeon only (floats in linear light — `floatPlane`)
  return ([1, 3, 4, 8].includes(mode) && (depth === 8 || depth === 16)) || ((mode === 1 || mode === 3) && depth === 32);
}

/**
 * 8-bit plane → 32-bit floats (big-endian) as the reader shows them: a colour through the sRGB curve back to linear
 * light, a coverage (transparency, mask) as v / 255. `keep(i)`: the original float bytes for sample i, when its
 * 8-bit value is still the one the reader made of them (an unchanged pixel keeps its exact value, past white too).
 */
function floatPlane(p: Uint8Array, coverage: boolean, keep?: (i: number, v: number) => Uint8Array | null): Uint8Array {
  const out = new Uint8Array(p.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < p.length; i++) {
    const k = keep?.(i, p[i]);
    if (k) out.set(k, i * 4);
    else dv.setFloat32(i * 4, coverage ? p[i] / 255 : srgbToLinear(p[i] / 255));
  }
  return out;
}

/** RGBA → colour planes in the document mode, at the document depth (8 or 16 bits); `grey`: a duotone's colours. */
function colourPlanes(rgba: Uint8Array, n: number, mode: number, depth: number, grey?: GreyOf | null, xf?: CmykXform | null): Uint8Array[] {
  const ch = colorChannels(mode);
  const p8 = Array.from({ length: ch }, () => new Uint8Array(n));
  const ink = new Uint8Array(4);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (mode === 4 && xf) {
      // a document made CMYK here (이미지 › 모드): separated through its profile, as it is read back
      xf.cmyk(r, g, b, ink, 0);
      p8[0][i] = ink[0];
      p8[1][i] = ink[1];
      p8[2][i] = ink[2];
      p8[3][i] = ink[3];
    } else if (mode === 3) {
      p8[0][i] = r;
      p8[1][i] = g;
      p8[2][i] = b;
    } else if (mode === 4) {
      // stored inverted; reading gives back exactly (r, g, b)
      const mx = Math.max(r, g, b);
      p8[0][i] = 255 - (mx - r);
      p8[1][i] = 255 - (mx - g);
      p8[2][i] = 255 - (mx - b);
      p8[3][i] = mx;
    } else p8[0][i] = grey ? grey(r, g, b) : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return depth === 16 ? p8.map((p) => widen(p)) : depth === 32 ? p8.map((p) => floatPlane(p, false)) : p8;
}

function alphaPlane(rgba: Uint8Array, n: number, depth: number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + 3];
  return depth === 16 ? widen(a) : depth === 32 ? floatPlane(a, true) : a;
}

function widen(p: Uint8Array): Uint8Array {
  const o = new Uint8Array(p.length * 2);
  for (let i = 0; i < p.length; i++) o[i * 2] = o[i * 2 + 1] = p[i]; // v * 257
  return o;
}

/**
 * Where sample i of a re-encoded plane was in the original 16-bit plane `o16` (index into it, or -1: no original
 * pixel there — new area, moved off it, or drawn another way).
 */
type Orig16 = { o16: Uint8Array; at: (i: number) => number; /** sample i is known unchanged (keep it whatever its 8-bit view) */ keep?: (i: number) => boolean };

/**
 * 8-bit plane → 16-bit (big-endian) from the original 16-bit samples: a sample whose 8-bit value is still the one the
 * reader made of the original (round(v16 / 257)) keeps its exact 16 bits; an edited one is the edit's 8-bit level
 * with the original pixel's part below one 8-bit level carried over (−128 … 128 of 65535: the original's fine
 * gradient and noise act as the dither, so a smooth 16-bit ramp stays smooth after an 8-bit edit and the 8-bit view
 * still reads the edited level); with no original pixel, the level itself (v · 257, as Photoshop widens 8 bits).
 */
export function widen16(p: Uint8Array, orig?: Orig16 | null): Uint8Array {
  if (!orig) return widen(p);
  const o = new Uint8Array(p.length * 2);
  const { o16, at, keep } = orig;
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    const j = at(i);
    let s = v * 257;
    if (j >= 0 && j * 2 + 1 < o16.length) {
      const was = (o16[j * 2] << 8) | o16[j * 2 + 1];
      const w8 = Math.round(was / 257);
      s = w8 === v || keep?.(i) ? was : Math.max(0, Math.min(65535, s + (was - w8 * 257)));
    }
    o[i * 2] = s >> 8;
    o[i * 2 + 1] = s & 255;
  }
  return o;
}

/**
 * A 16-bit record's original planes for widen16 (channel id → Orig16), read on first use: `ox, oy` = where the
 * record's original pixels now sit on the page (null: drawn another way — no original values kept).
 */
function record16(L: PsdLayout, rec: PsdRecord, px: LayerPixels, ox: number | null, oy: number | null): ((id: number) => Orig16 | null) | undefined {
  if (L.depth !== 16 || ox === null || oy === null) return undefined;
  const rw = rec.right - rec.left, rh = rec.bottom - rec.top;
  if (rw <= 0 || rh <= 0) return undefined;
  const at = (i: number) => {
    const x = px.left + (i % px.width) - ox, y = px.top + Math.floor(i / px.width) - oy;
    return x < 0 || y < 0 || x >= rw || y >= rh ? -1 : y * rw + x;
  };
  const cache = new Map<number, Orig16 | null>();
  return (id) => {
    if (!cache.has(id)) {
      const ch = rec.channels.find((c) => c.id === id);
      let v: Orig16 | null = null;
      try {
        if (ch) v = { o16: readChannelPlane(L.bytes, ch.start, ch.end, rw, rh, 2, L.psb), at };
      } catch {
        v = null;
      }
      cache.set(id, v);
    }
    return cache.get(id) ?? null;
  };
}

// ───────── node → layer pixels ─────────

export interface LayerPixels {
  rgba: Uint8Array;
  left: number;
  top: number;
  width: number;
  height: number;
}

const MAX_LAYER_PIXELS = 200_000_000;

/** Crop RGBA to the bounding box of non-transparent pixels. */
function cropAlpha(px: LayerPixels): LayerPixels | null {
  const { rgba, width: w, height: h } = px;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return px;
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  const out = new Uint8Array(cw * chh * 4);
  for (let y = 0; y < chh; y++) out.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
  return { rgba: out, left: px.left + x0, top: px.top + y0, width: cw, height: chh };
}

/**
 * Whole-pixel position of a node that is only translated (no rotation / scale / crop), else null.
 * PSD layers sit on integer pixels: a fractional offset left by free transform or snapping is rounded instead
 * of resampled — resampling would blur the layer and grow its bounds by one pixel (961×1441 for a 960×1440
 * background, which is what broke a Photoshop round trip).
 */
export function pixelOffset(n: RasterNode): { x: number; y: number } | null {
  const t = n.transform;
  const E = 1e-6;
  if (Math.abs(t.rotation) > E || Math.abs(t.scale - 1) > E || Math.abs((t.scaleY ?? t.scale) - 1) > E || n.crop) return null;
  return { x: Math.round(t.x), y: Math.round(t.y) };
}

/** Page-space pixels of a raster node (bilinear resampling only when rotated, scaled or cropped). */
export function rasterPixels(n: RasterNode): LayerPixels | null {
  const keys = Object.keys(n.tiles);
  if (!keys.length) return null;
  const lb = localBounds(n);
  const off = pixelOffset(n);
  if (off) {
    const t = off;
    if (lb.w * lb.h > MAX_LAYER_PIXELS) throw new Error(`레이어 '${n.name}'가 너무 큽니다`);
    const rgba = new Uint8Array(lb.w * lb.h * 4);
    for (const k of keys) {
      const [tx, ty] = k.split("_").map(Number);
      const data = n.tiles[k].data;
      const ox = tx * TILE - lb.x, oy = ty * TILE - lb.y;
      for (let y = 0; y < TILE; y++) rgba.set(data.subarray(y * TILE * 4, (y + 1) * TILE * 4), ((oy + y) * lb.w + ox) * 4);
    }
    return cropAlpha({ rgba, left: lb.x + t.x, top: lb.y + t.y, width: lb.w, height: lb.h });
  }
  const t = n.transform;
  const pb = transformRect(t, lb);
  const left = Math.floor(pb.x), top = Math.floor(pb.y);
  const w = Math.ceil(pb.x + pb.w) - left, h = Math.ceil(pb.y + pb.h) - top;
  if (w <= 0 || h <= 0) return null;
  if (w * h > MAX_LAYER_PIXELS) throw new Error(`레이어 '${n.name}'가 너무 큽니다`);
  const rgba = new Uint8Array(w * h * 4);
  const at = (x: number, y: number, c: number) => {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    const tile = n.tiles[`${tx}_${ty}`];
    if (!tile) return 0;
    return tile.data[((y - ty * TILE) * TILE + (x - tx * TILE)) * 4 + c];
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [lx, ly] = invertTransform(t, [left + x + 0.5, top + y + 0.5]);
      const fx = lx - 0.5, fy = ly - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      // premultiplied bilinear
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy, wt] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]] as const) {
        if (!wt) continue;
        const al = at(x0 + dx, y0 + dy, 3) * wt;
        if (!al) continue;
        a += al;
        r += at(x0 + dx, y0 + dy, 0) * al;
        g += at(x0 + dx, y0 + dy, 1) * al;
        b += at(x0 + dx, y0 + dy, 2) * al;
      }
      if (a > 0) {
        const i = (y * w + x) * 4;
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round(a);
      }
    }
  return cropAlpha({ rgba, left, top, width: w, height: h });
}

/** The pixels a layer shows (its mask applied): what the merged image is composited from. */
export function shownPixels(n: RasterNode): LayerPixels | null {
  return rasterPixels(n.mask && !n.mask.off && !n.adjust ? { ...n, tiles: shownTiles(n), mask: undefined } : n);
}

/**
 * The PSD user mask of a layer (a pixel layer's layer mask, or an adjustment layer's own mask in its tiles), in page
 * coordinates: the rectangle of its painted tiles, outside it the default colour. Null for a layer without one or one
 * that is turned / scaled (its mask is applied to its pixels then).
 */
export function layerMaskSpec(n: RasterNode): NonNullable<FreshLayer["mask"]> | null {
  const m = n.adjust ? { tiles: n.tiles, hide: n.adjust.hide } : n.mask;
  const off = pixelOffset(n);
  if (!m || (n.adjust && (!off || !Number.isInteger(n.transform.x) || !Number.isInteger(n.transform.y)))) return null;
  if (!off) {
    // a turned / scaled layer: the mask resampled through the same transform as its pixels (rasterPixels), in grey
    const keys = new Set([...Object.keys(n.tiles), ...Object.keys(m.tiles)]);
    const grey: RasterNode["tiles"] = {};
    for (const k of keys) {
      const u = k.indexOf("_");
      const tx = +k.slice(0, u), ty = +k.slice(u + 1);
      const p = maskPlane(m, tx * TILE, ty * TILE, TILE, TILE);
      const d = new Uint8ClampedArray(TILE * TILE * 4);
      for (let i = 0; i < p.length; i++) ((d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = p[i]), (d[i * 4 + 3] = 255));
      grey[k] = { hash: `mask-${k}`, data: d };
    }
    const px = rasterPixels({ ...n, tiles: grey, mask: undefined });
    if (!px) return null;
    const data = new Uint8Array(px.width * px.height);
    const def = m.hide ? 255 : 0;
    for (let i = 0; i < data.length; i++) {
      const a = px.rgba[i * 4 + 3];
      data[i] = Math.round((px.rgba[i * 4] * a + def * (255 - a)) / 255);
    }
    return { left: px.left, top: px.top, width: px.width, height: px.height, data, defaultColor: def, disabled: !!n.mask?.off };
  }
  const tb = tileBounds(m.tiles);
  const def = m.hide ? 255 : 0;
  const disabled = !n.adjust && !!n.mask?.off;
  if (!tb) return { left: 0, top: 0, width: 0, height: 0, data: new Uint8Array(0), defaultColor: def, disabled };
  const data = maskPlane(m, tb.ox, tb.oy, tb.width, tb.height);
  return { left: tb.ox + off.x, top: tb.oy + off.y, width: tb.width, height: tb.height, data, defaultColor: def, disabled };
}

/** A smart object made here (its content an asset): its placed-layer block and its linked-file entry, or null. */
const concatBytes = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

function newSmartParts(n: SceneNode, psb: boolean): { block: Uint8Array; entry: Uint8Array } | null {
  if (n.type !== "RASTER" || !n.psdSmart?.edited || n.psdSmart.kind !== "embedded") return null;
  const data = getBlob(n.psdSmart.edited.hash);
  if (!data) return null;
  const placed = `${n.psdSmart.id.slice(0, 8)}-${n.id.replace(/[^0-9a-z]/gi, "").slice(-12).padStart(12, "0")}`;
  return { block: block("SoLd", smartPlacedData(n, placed), psb), entry: linkedEntry(n, data) };
}

/** The type tool block of a text box drawn here (its turn and scale in the text transform), as a layer block; null for anything else. */
function textTyShBlock(n: SceneNode, psb: boolean): Uint8Array | null {
  if (n.type !== "TEXT" || n.flow) return null;
  if (!n.paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) return null;
  try {
    return block("TySh", newTextTySh(n, localBounds(n).h), psb);
  } catch {
    return null;
  }
}

/** A user mask's record parts: the mask data section and its channel (-2). */
function maskParts(m: NonNullable<FreshLayer["mask"]>, depth: number, psb: boolean): { mask: Uint8Array; channel: { id: number; data: Uint8Array } } {
  const mo = new Out();
  mo.i32(m.top);
  mo.i32(m.left);
  mo.i32(m.top + m.height);
  mo.i32(m.left + m.width);
  mo.u8(m.defaultColor);
  mo.u8(m.disabled ? 2 : 0);
  mo.u16(0);
  return { mask: mo.done(), channel: { id: -2, data: encodeChannel(depth === 16 ? widen(m.data) : m.data, m.width, m.height, depth / 8, psb) } };
}

/** A record for an adjustment layer made or edited here (settings blocks, mask); null for a kind not written. */
function adjustRecord(n: RasterNode, mode: number, depth: number, psb: boolean, id: number): RecordParts | null {
  const blocks = n.adjust ? adjustmentBlocks(n.adjust.adj) : null;
  if (!blocks) return null;
  const { parts } = newRecord(n.name, null, n, mode, depth, psb, id);
  parts.blocks.push(...blocks.map(([k, d]) => block(k, d, psb)));
  // pixel data irrelevant (bit 4, with bit 3 saying bit 4 is used): Photoshop's flags of an adjustment layer
  parts.flags |= 0x10;
  if (n.clip) parts.clipping = 1;
  const ms = layerMaskSpec(n);
  if (ms && depth !== 32) {
    const mp = maskParts(ms, depth, psb);
    parts.mask = mp.mask;
    parts.channels.push(mp.channel);
  }
  return parts;
}

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced — what canvas.toBlob produces). */
export function decodePngRgba(png: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.length < 33 || dv.getUint32(0) !== 0x89504e47) throw new Error("PNG가 아닙니다");
  let o = 8, w = 0, h = 0, ct = 0;
  const idat: Uint8Array[] = [];
  while (o + 8 <= png.length) {
    const n = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (o + 12 + n > png.length) throw new Error("PNG 청크가 잘렸습니다");
    const d = png.subarray(o + 8, o + 8 + n);
    if (type === "IHDR") {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
      if (d[8] !== 8 || d[12] !== 0 || (d[9] !== 6 && d[9] !== 2)) throw new Error("지원하지 않는 PNG 형식");
      ct = d[9];
    } else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    o += 12 + n;
  }
  const z = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  let k = 0;
  for (const d of idat) {
    z.set(d, k);
    k += d.length;
  }
  const raw = unzlibSync(z);
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error("PNG 데이터가 부족합니다");
  const cur = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[y * stride + x - bpp] : 0;
      const b = y ? cur[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? cur[(y - 1) * stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[y * stride + x] = v & 255;
    }
  }
  if (ct === 6) return { rgba: cur, width: w, height: h };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = cur[i * 3];
    rgba[i * 4 + 1] = cur[i * 3 + 1];
    rgba[i * 4 + 2] = cur[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, width: w, height: h };
}

/** Box-downsample an RGBA image to w×h (premultiplied). */
export function downsample(src: { rgba: Uint8Array; width: number; height: number }, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const sx = src.width / w, sy = src.height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let yy = Math.floor(y * sy); yy < Math.min(src.height, Math.ceil((y + 1) * sy)); yy++)
        for (let xx = Math.floor(x * sx); xx < Math.min(src.width, Math.ceil((x + 1) * sx)); xx++) {
          const i = (yy * src.width + xx) * 4, al = src.rgba[i + 3];
          r += src.rgba[i] * al;
          g += src.rgba[i + 1] * al;
          b += src.rgba[i + 2] * al;
          a += al;
          cnt++;
        }
      const i = (y * w + x) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(a / cnt);
      }
    }
  return out;
}

async function nodePixels(doc: OmwDocument, page: Page, n: SceneNode, opts: PsdWriteOptions): Promise<LayerPixels | null | "skip"> {
  if (n.type === "RASTER") return rasterPixels(n);
  if (!opts.rasterize) return "skip";
  // the layer's pixels without its effects: they are written as a live layer style (lfx2) next to them
  const r = await opts.rasterize(doc, page, { ...n, visible: true, opacity: 1, blendMode: "NORMAL", effects: undefined } as SceneNode);
  if (!r) return null;
  const png = decodePngRgba(r.png);
  return cropAlpha({ rgba: downsample(png, r.w, r.h), left: r.x, top: r.y, width: r.w, height: r.h });
}

/**
 * The page's layers composited as the merged image is (straight RGBA, page size, transparency kept): what a smart
 * object's content looks like when it is placed in its parent (io/formats/psdSmart.ts projectPlaced). The hidden
 * 'merged image' node of an imported PSD is left out; non-raster nodes need `opts.rasterize`.
 */
export async function pageComposite(doc: OmwDocument, page: Page, opts: PsdWriteOptions = {}): Promise<Uint8Array> {
  const hidden = page.source?.psd?.compositeNode;
  const nodes = contiguousOrder(page.nodes.filter((n) => n.id !== hidden), page.groups);
  const got = new Map<string, LayerPixels | null>();
  for (const n of nodes) {
    if (!n.visible || n.opacity <= 0) continue;
    const px = await nodePixels(doc, page, n, opts);
    got.set(n.id, px === "skip" ? null : px);
  }
  if (pageDissolves(page)) await loadDissolveField().catch(() => {});
  return compositeTree(nodes, page.groups, (n) => got.get(n.id) ?? null, page.width, page.height);
}

// ───────── compositing (the merged image) ─────────

const BLEND_OUT: Record<GroupBlend, string> = { ...PSD_BLEND_OUT, PASS_THROUGH: "pass" };

/** Whole-pixel blend of a mode, null = NORMAL (formulas: core/style/blend.ts). */
const blendFn = (mode: BlendMode) => pixelBlend(mode);

interface CompLayer {
  px: LayerPixels;
  opacity: number;
  blend: BlendMode;
}

/** W3C blending (all 27 modes) + source-over, premultiplied float accumulation; returns straight RGBA8. */
export function compositeLayers(layers: CompLayer[], W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  // done in bands of rows: the float accumulator is a band, not the whole canvas (16 bytes a pixel — 1.5 GB at
  // 12000×8000); every pixel goes through the same arithmetic, so the result does not depend on the band size
  const BAND = Math.max(1, Math.min(H, Math.floor(4_000_000 / Math.max(1, W))));
  const acc = new Float32Array(W * BAND * 4); // premultiplied
  for (let by = 0; by < H; by += BAND) {
    const bh = Math.min(BAND, H - by);
    acc.fill(0);
    for (const L of layers) {
      const { px } = L;
      const rgba = px.rgba;
      const B = blendFn(L.blend);
      const normal = L.blend === "NORMAL" || L.blend === "DISSOLVE";
      const dis = L.blend === "DISSOLVE";
      const mixed = new Float64Array(3);
      const x0 = Math.max(0, px.left), y0 = Math.max(by, px.top);
      const x1 = Math.min(W, px.left + px.width), y1 = Math.min(by + bh, px.top + px.height);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const s = ((y - px.top) * px.width + (x - px.left)) * 4;
          let as = (rgba[s + 3] / 255) * L.opacity;
          if (as <= 0) continue;
          if (dis) {
            if (!dissolveKeep(x, y, as)) continue;
            as = 1;
          }
          const d = ((y - by) * W + x) * 4;
          if (as === 1 && normal) {
            // opaque source-over: the general formula below gives exactly the source colour
            acc[d] = rgba[s] / 255;
            acc[d + 1] = rgba[s + 1] / 255;
            acc[d + 2] = rgba[s + 2] / 255;
            acc[d + 3] = 1;
            continue;
          }
          const ab = acc[d + 3];
          const ib = ab > 0 ? 1 / ab : 0;
          blendMixPixel(normal ? null : B, acc[d] * ib, acc[d + 1] * ib, acc[d + 2] * ib, rgba[s] / 255, rgba[s + 1] / 255, rgba[s + 2] / 255, ab, false, mixed);
          for (let c = 0; c < 3; c++) acc[d + c] = as * mixed[c] + (1 - as) * acc[d + c];
          acc[d + 3] = as + ab * (1 - as);
        }
    }
    const base = by * W * 4;
    for (let i = 0, n = W * bh; i < n; i++) {
      const a = acc[i * 4 + 3];
      if (a <= 0) continue;
      const o = base + i * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round((acc[i * 4 + c] / a) * 255)));
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

function flattenOverWhite(rgba: Uint8Array) {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(rgba[i + c] * a + 255 * (1 - a));
    rgba[i + 3] = 255;
  }
}

// ───────── layer record serialisation ─────────

interface RecordParts {
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: { id: number; data: Uint8Array }[];
  blend: string;
  opacity: number;
  clipping: number;
  flags: number;
  filler: number;
  mask: Uint8Array;
  ranges: Uint8Array;
  name: Uint8Array;
  blocks: Uint8Array[];
  tail: Uint8Array;
}

function writeRecord(o: Out, p: RecordParts, psb: boolean) {
  o.i32(p.top);
  o.i32(p.left);
  o.i32(p.bottom);
  o.i32(p.right);
  o.u16(p.channels.length);
  for (const c of p.channels) {
    o.i16(c.id);
    o.len(c.data.length, psb);
  }
  o.str("8BIM");
  o.str(p.blend);
  o.u8(p.opacity);
  o.u8(p.clipping);
  o.u8(p.flags);
  o.u8(p.filler);
  const extra = 4 + p.mask.length + 4 + p.ranges.length + p.name.length + p.blocks.reduce((s, b) => s + b.length, 0) + p.tail.length;
  o.u32(extra);
  o.u32(p.mask.length);
  o.bytes(p.mask);
  o.u32(p.ranges.length);
  o.bytes(p.ranges);
  o.bytes(p.name);
  for (const b of p.blocks) o.bytes(b);
  o.bytes(p.tail);
}

/** Pascal name padded to a multiple of 4 (ASCII; the Unicode name goes in 'luni'). */
function pascalName(name: string): Uint8Array {
  let s = "";
  for (const ch of name) s += ch.charCodeAt(0) < 128 && ch.length === 1 ? ch : "?";
  s = s.slice(0, 255);
  const n = 1 + s.length;
  const out = new Uint8Array(n + ((4 - (n % 4)) % 4));
  out[0] = s.length;
  for (let i = 0; i < s.length; i++) out[1 + i] = s.charCodeAt(i);
  return out;
}

function block(key: string, data: Uint8Array, psb: boolean): Uint8Array {
  const o = new Out();
  o.str("8BIM");
  o.str(key);
  const padded = data.length + (data.length % 2);
  o.len(padded, psb && LONG_KEYS.has(key));
  o.bytes(data);
  if (data.length % 2) o.u8(0);
  return o.done();
}

function luniData(name: string): Uint8Array {
  const o = new Out();
  o.u32(name.length);
  for (let i = 0; i < name.length; i++) o.u16(name.charCodeAt(i));
  return o.done();
}

const u32be = (v: number) => {
  const o = new Out();
  o.u32(v);
  return o.done();
};

function defaultRanges(colorCh: number): Uint8Array {
  const r = new Uint8Array((1 + colorCh) * 8);
  for (let i = 0; i < 1 + colorCh; i++) r.set([0, 0, 255, 255, 0, 0, 255, 255], i * 8);
  return r;
}

/**
 * A CMYK layer's inks (stored values, 255 = no ink) for its pixels `px`, as written: a pixel whose colour is still the
 * one the original channels read as (`orig`, the record's planes, its (0, 0) at page (ox, oy)) keeps the original
 * inks; any other — an edited, moved-in or new pixel — is split from its colour, black = the grey part (read back as
 * exactly that colour). `changed`: the visible pixels split anew.
 */
export interface LayerInks {
  planes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  px: LayerPixels;
  changed: number;
}

export function cmykLayerInks(px: LayerPixels, orig: { c: Uint8Array; m: Uint8Array; y: Uint8Array; k: Uint8Array; w: number; h: number } | null, ox = 0, oy = 0, xf?: CmykXform | null): LayerInks {
  const n = px.width * px.height;
  const planes: LayerInks["planes"] = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  const [C, M, Y, K] = planes;
  const d = px.rgba;
  const seen = new Uint8Array(4);
  let changed = 0;
  for (let y = 0, i = 0; y < px.height; y++) {
    const sy = px.top + y - oy;
    for (let x = 0; x < px.width; x++, i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      const sx = px.left + x - ox;
      if (orig && sx >= 0 && sy >= 0 && sx < orig.w && sy < orig.h) {
        const s = sy * orig.w + sx;
        const c = orig.c[s], m = orig.m[s], yy = orig.y[s], k = orig.k[s] - 255;
        // the reader's conversion (psd.ts toRgba): through the document's profile, or stored + stored black − 255
        // (that one also for a colour-managed file: an .omw saved before colour management kept those colours)
        let same = Math.max(0, c + k) === r && Math.max(0, m + k) === g && Math.max(0, yy + k) === b;
        if (!same && xf) {
          // within one level: the profile is evaluated in floating point, and an .omw made on another engine
          // (WebView2 / WebKit) may hold its colours a level apart — those pixels are not edited, and a one-level
          // edit is not worth new inks either
          xf.rgb(c, m, yy, orig.k[s], seen, 0);
          same = Math.abs(seen[0] - r) <= 1 && Math.abs(seen[1] - g) <= 1 && Math.abs(seen[2] - b) <= 1;
        }
        if (same) {
          C[i] = c;
          M[i] = m;
          Y[i] = yy;
          K[i] = orig.k[s];
          continue;
        }
      }
      if (xf) {
        // the profile's own separation (as Photoshop converts a colour into the document)
        xf.cmyk(r, g, b, seen, 0);
        C[i] = seen[0];
        M[i] = seen[1];
        Y[i] = seen[2];
        K[i] = seen[3];
        if (d[i * 4 + 3]) changed++;
        continue;
      }
      const mx = Math.max(r, g, b);
      C[i] = 255 - (mx - r);
      M[i] = 255 - (mx - g);
      Y[i] = 255 - (mx - b);
      K[i] = mx;
      if (d[i * 4 + 3]) changed++;
    }
  }
  return { planes, px, changed };
}

/**
 * Placed pixels `px` inside region (X0, Y0, rw × rh), in region coordinates, with colour from three planes (null: the
 * pixels' own RGB) and the pixels' alpha — one pass of the ink compositor (core/image/cmykComposite.ts). Null outside.
 */
function inkPass(px: LayerPixels, planes: Uint8Array[] | null, X0: number, Y0: number, rw: number, rh: number): PlacedPixels | null {
  const x0 = Math.max(X0, px.left), x1 = Math.min(X0 + rw, px.left + px.width);
  const y0 = Math.max(Y0, px.top), y1 = Math.min(Y0 + rh, px.top + px.height);
  if (x0 >= x1 || y0 >= y1) return null;
  const w = x1 - x0, h = y1 - y0;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y + y0 - px.top) * px.width + (x + x0 - px.left), o = (y * w + x) * 4;
      if (planes) {
        rgba[o] = planes[0][s];
        rgba[o + 1] = planes[1][s];
        rgba[o + 2] = planes[2][s];
      } else {
        rgba[o] = px.rgba[s * 4];
        rgba[o + 1] = px.rgba[s * 4 + 1];
        rgba[o + 2] = px.rgba[s * 4 + 2];
      }
      rgba[o + 3] = px.rgba[s * 4 + 3];
    }
  return { rgba, left: x0 - X0, top: y0 - Y0, width: w, height: h };
}

/**
 * A 32-bit layer's channels from its edited pixels: `ox, oy` = where the record's original pixels now sit on the page
 * (null: drawn another way — no original values kept); a pixel whose colour / transparency still reads as the
 * original float gets that float back.
 */
function floatChannels(L: PsdLayout, rec: PsdRecord, px: LayerPixels, ox: number | null, oy: number | null, colorCh: number, psb: boolean, alpha: boolean): { id: number; data: Uint8Array }[] {
  const n = px.width * px.height;
  const rw = rec.right - rec.left, rh = rec.bottom - rec.top;
  const out: { id: number; data: Uint8Array }[] = [];
  const ids = [...(alpha ? [-1] : []), ...Array.from({ length: colorCh }, (_, i) => i)];
  for (const id of ids) {
    const p8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) p8[i] = id === -1 ? px.rgba[i * 4 + 3] : colorCh === 1 ? Math.round(0.299 * px.rgba[i * 4] + 0.587 * px.rgba[i * 4 + 1] + 0.114 * px.rgba[i * 4 + 2]) : px.rgba[i * 4 + id];
    const ch = rec.channels.find((c) => c.id === id);
    let keep: ((i: number, v: number) => Uint8Array | null) | undefined;
    if (ch && ox !== null && oy !== null && rw > 0 && rh > 0) {
      try {
        const orig = readChannelPlane(L.bytes, ch.start, ch.end, rw, rh, 4, psb);
        const o8 = to8(orig, rw * rh, 32, rw, id === -1);
        keep = (i, v) => {
          const x = px.left + (i % px.width) - ox, y = px.top + Math.floor(i / px.width) - oy;
          if (x < 0 || y < 0 || x >= rw || y >= rh) return null;
          const j = y * rw + x;
          return o8[j] === v ? orig.subarray(j * 4, j * 4 + 4) : null;
        };
      } catch {
        keep = undefined;
      }
    }
    out.push({ id, data: encodeChannel(floatPlane(p8, id === -1, keep), px.width, px.height, 4, psb) });
  }
  return out;
}

/** Channel list for pixels in the document encoding (`inks`: a CMYK layer's own planes, 8-bit). */
function pixelChannels(px: LayerPixels | null, mode: number, depth: number, psb: boolean, alpha: boolean, inks?: Uint8Array[], grey?: GreyOf | null, orig16?: (id: number) => Orig16 | null): { id: number; data: Uint8Array }[] {
  const ch = colorChannels(mode);
  const bpc = depth / 8;
  if (!px) {
    const empty = encodeChannel(new Uint8Array(0), 0, 0, bpc, psb);
    return [...(alpha ? [{ id: -1, data: empty }] : []), ...Array.from({ length: ch }, (_, i) => ({ id: i, data: empty }))];
  }
  const n = px.width * px.height;
  // 16 bits: from the 8-bit planes, keeping the record's original samples (widen16)
  const planes = depth === 16 ? (inks ?? colourPlanes(px.rgba, n, mode, 8, grey)).map((p, i) => widen16(p, orig16?.(i))) : inks ?? colourPlanes(px.rgba, n, mode, depth, grey);
  const out: { id: number; data: Uint8Array }[] = [];
  if (alpha) out.push({ id: -1, data: encodeChannel(depth === 16 ? widen16(alphaPlane(px.rgba, n, 8), orig16?.(-1)) : alphaPlane(px.rgba, n, depth), px.width, px.height, bpc, psb) });
  planes.forEach((p, i) => out.push({ id: i, data: encodeChannel(p, px.width, px.height, bpc, psb) }));
  return out;
}

/** lfx2 (and lmfx for several effects of one kind) blocks for `effects`, patched onto `orig` when given. */
export function fxBlocks(effects: readonly Effect[] | undefined, psb: boolean, orig?: Desc | null, globalAngle = 120, group = false): Uint8Array[] {
  if (!effects?.length) return [];
  // a group's layer style: one 'lfxs' block on the folder header, as Photoshop writes it (the *Multi lists inside it,
  // like Photoshop's own lfx2) — omni-fx-group.psd
  if (group) return [block("lfxs", writeFxBlock(buildEffectsDesc(effects, orig, globalAngle).desc), psb)];
  const { lfx2, lmfx } = effectsBlocks(effects, orig, globalAngle);
  return [block("lfx2", lfx2, psb), ...(lmfx ? [block("lmfx", lmfx, psb)] : [])];
}

/** Has the node's / group's effect list changed since import? (no import-time fingerprint: any effect is new) */
const fxChanged = (cur: readonly Effect[] | undefined, link: PsdLayerLink) => (link.fx !== undefined ? effectsFingerprint(cur) !== link.fx : !!cur?.length);

/**
 * Replace a record's effects blocks: the edited list is patched onto the record's own descriptor (lmfx or lfx2),
 * lrFX (old effects) and the replaced blocks are dropped. Keeps the lfx2 position when the record had one.
 */
function patchFxBlocks(blks: { key: string; raw: Uint8Array }[], b: Uint8Array, rec: PsdRecord, effects: readonly Effect[] | undefined, psb: boolean, globalAngle: number, group = false) {
  const src = fxSourceBlock(rec);
  let orig: Desc | null = null;
  if (src)
    try {
      orig = parseFxBlock(b.subarray(src.dataStart, src.dataEnd));
    } catch {
      orig = null;
    }
  const at = blks.findIndex((k) => k.key === "lfx2" || k.key === "lfxs" || k.key === "lrFX");
  const kept = blks.filter((k) => k.key !== "lfx2" && k.key !== "lmfx" && k.key !== "lfxs" && k.key !== "lrFX");
  const fresh = fxBlocks(effects, psb, orig, globalAngle, group).map((raw) => ({ key: String.fromCharCode(raw[4], raw[5], raw[6], raw[7]), raw }));
  const pos = at >= 0 ? Math.min(at, kept.length) : kept.length;
  kept.splice(pos, 0, ...fresh);
  blks.length = 0;
  blks.push(...kept);
}

/** lspf protection bits of a node: all (bit 31), transparency (0), image pixels (1), position (2). */
export function lockBits(n: Pick<SceneNode, "locked" | "lockAlpha" | "lockPixels" | "lockPosition">): number {
  return ((n.locked ? 0x80000000 : 0) | (n.lockAlpha ? 1 : 0) | (n.lockPixels ? 2 : 0) | (n.lockPosition ? 4 : 0)) >>> 0;
}

function newRecord(name: string, px: LayerPixels | null, n: SceneNode, mode: number, depth: number, psb: boolean, id: number, inks?: LayerInks["planes"]): { parts: RecordParts } {
  // Photoshop's default blending options (clipped layers blend as a group, interior effects not, no knockout). A
  // record without any of them reads as a pre-CS layer: Photoshop then turns the opacity of a layer in one of the
  // eight special modes (colour / linear burn and dodge, vivid / linear light, hard mix, difference) into its fill
  // opacity — a different picture (QA 2026-11-18, Photoshop 28: Colour Burn at 70 % opened as opacity 100 % fill 70 %).
  // blending options (Photoshop's Layer Style dialog): fill opacity, interior effects, knockout, Blend If, locks
  const blocks = [block("luni", luniData(name), psb), block("lyid", u32be(id), psb), block("clbl", u32be(0x01000000), psb), block("infx", u32be(n.fillInterior ? 0x01000000 : 0), psb), block("knko", u32be(n.knockout === "deep" ? 0x02000000 : n.knockout === "shallow" ? 0x01000000 : 0), psb)];
  if ((n.fillOpacity ?? 1) < 1) blocks.push(block("iOpa", Uint8Array.from([Math.round(Math.max(0, n.fillOpacity!) * 255), 0, 0, 0]), psb));
  const lock = lockBits(n);
  if (lock) blocks.push(block("lspf", u32be(lock), psb));
  blocks.push(...fxBlocks(n.effects, psb));
  const ranges = defaultRanges(colorChannels(mode));
  if (n.blendIf) ranges.set(n.blendIf.slice(0, ranges.length));
  return {
    parts: {
      top: px?.top ?? 0,
      left: px?.left ?? 0,
      bottom: px ? px.top + px.height : 0,
      right: px ? px.left + px.width : 0,
      channels: pixelChannels(px, mode, depth, psb, true, inks),
      blend: BLEND_OUT[n.blendMode] ?? "norm",
      opacity: Math.round(Math.max(0, Math.min(1, n.opacity)) * 255),
      clipping: 0,
      flags: 0x08 | (n.visible ? 0 : 0x02),
      filler: 0,
      mask: new Uint8Array(0),
      ranges,
      name: pascalName(name),
      blocks,
      tail: new Uint8Array(0),
    },
  };
}

// ───────── layer-info content ─────────

function layerInfoContent(records: RecordParts[], count: number, psb: boolean): Uint8Array {
  const o = new Out();
  o.i16(count);
  for (const r of records) writeRecord(o, r, psb);
  for (const r of records) for (const c of r.channels) o.bytes(c.data);
  o.pad(4);
  return o.done();
}

// ───────── fresh document ─────────

export interface FreshLayer {
  name: string;
  px: LayerPixels | null;
  opacity: number;
  visible: boolean;
  blend: BlendMode;
  locked?: boolean;
  /** extra additional-info blocks (raw, test fixtures) */
  blocks?: Uint8Array[];
  /** user layer mask (8-bit samples, page coordinates) */
  mask?: { left: number; top: number; width: number; height: number; data: Uint8Array; defaultColor: number; disabled?: boolean };
  clipping?: boolean;
  /** write as Photoshop's Background layer (no transparency channel, flags bit 0, lspf 0xD); must be opaque, canvas-sized, bottom */
  background?: boolean;
  /** record blend key instead of `blend` (a folder header's 'pass') */
  blendKey?: string;
  /** layer effects, written as lfx2 */
  effects?: Effect[];
  /** an adjustment layer (its settings in `blocks`): Photoshop's "pixel data irrelevant" flag */
  adjustment?: boolean;
  /** blending options and partial locks (Layer Style dialog, lock buttons) */
  options?: Pick<SceneNode, "fillOpacity" | "fillInterior" | "knockout" | "blendIf" | "lockAlpha" | "lockPixels" | "lockPosition">;
}

/** Section divider block (lsct): type 0..3; folder headers also carry the folder's blend key. */
function lsctData(type: number, blendKey?: string): Uint8Array {
  const o = new Out();
  o.u32(type);
  if (blendKey) {
    o.str("8BIM");
    o.str(blendKey);
  }
  return o.done();
}

/** A folder as Photoshop writes it, bottom → top: bounding divider, then (after the members) the header. */
export function groupMarkers(g: Pick<LayerGroup, "name" | "visible" | "opacity" | "blendMode" | "collapsed" | "locked" | "effects">, psb = false): { divider: FreshLayer; header: FreshLayer } {
  const key = BLEND_OUT[g.blendMode] ?? "pass";
  return {
    divider: { name: "</Layer group>", px: null, opacity: 1, visible: true, blend: "NORMAL", blocks: [block("lsct", lsctData(3), psb)] },
    header: { name: g.name || "Group", px: null, opacity: g.opacity, visible: g.visible, blend: "NORMAL", blendKey: key, locked: g.locked, blocks: [block("lsct", lsctData(g.collapsed ? 2 : 1, key), psb), ...fxBlocks(g.effects, psb, null, 120, true)] },
  };
}

export interface FreshSpec {
  width: number;
  height: number;
  /** 8 or 16 (16-bit layers go into the Lr16 block, as Photoshop does) */
  depth?: number;
  /** 3 RGB (default), 1 Grayscale, 4 CMYK */
  mode?: number;
  psb?: boolean;
  layers: FreshLayer[];
  /** merged image; computed from the layers when omitted */
  composite?: Uint8Array;
  /** extra global additional-info blocks (raw, test fixtures) */
  globalBlocks?: Uint8Array[];
  /** more image resources (whole '8BIM' blocks) after the resolution: saved paths (psdPaths.ts) */
  resources?: Uint8Array;
  /** CMYK (mode 4): the profile the colours are separated through (layers and merged image) */
  xf?: CmykXform | null;
}

/** Section type (lsct / lsdk) and folder blend key of a fresh layer's raw blocks; type 0 = not a marker. */
function freshSection(l: FreshLayer): { type: number; key: string } {
  for (const raw of l.blocks ?? []) {
    if (raw.length < 16) continue;
    const key = String.fromCharCode(raw[4], raw[5], raw[6], raw[7]);
    if (key !== "lsct" && key !== "lsdk") continue;
    const type = ((raw[12] << 24) | (raw[13] << 16) | (raw[14] << 8) | raw[15]) >>> 0;
    const sig = raw.length >= 24 ? String.fromCharCode(raw[16], raw[17], raw[18], raw[19]) : "";
    return { type, key: sig === "8BIM" ? String.fromCharCode(raw[20], raw[21], raw[22], raw[23]) : l.blendKey ?? BLEND_OUT[l.blend] };
  }
  return { type: 0, key: "" };
}

/** Merged image of fresh layers: flat as before, or Photoshop's compositing when there are folders / clipping. */
function freshComposite(layers: FreshLayer[], W: number, H: number): Uint8Array {
  const sections = layers.map(freshSection);
  if (!sections.some((s) => s.type) && !layers.some((l) => l.clipping))
    return compositeLayers(layers.filter((l) => l.visible && l.px).map((l) => ({ px: l.px!, opacity: l.opacity, blend: l.blend })), W, H);
  const groups: LayerGroup[] = [];
  const nodes: SceneNode[] = [];
  const pxOf = new Map<string, LayerPixels>();
  const pending: string[] = [];
  const members: { node: SceneNode; level: number }[] = [];
  layers.forEach((l, i) => {
    const s = sections[i];
    if (s.type === 3) return void pending.push(`g${i}`);
    if (s.type === 1 || s.type === 2) {
      const id = pending.pop();
      if (!id) return;
      groups.push({ id, name: l.name, parentId: pending[pending.length - 1] ?? null, visible: l.visible, locked: false, opacity: l.opacity, blendMode: s.key === "pass" ? "PASS_THROUGH" : ((Object.keys(BLEND_OUT) as GroupBlend[]).find((k) => BLEND_OUT[k] === s.key) ?? "NORMAL") });
      return;
    }
    const n = { id: `n${i}`, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blend, ...(pending.length ? { groupId: pending[pending.length - 1] } : {}), ...(l.clipping ? { clip: true } : {}) } as SceneNode;
    if (l.px) pxOf.set(n.id, l.px);
    nodes.push(n);
    members.push({ node: n, level: pending.length });
  });
  return compositeTree(nodes, groups, (n) => pxOf.get(n.id) ?? null, W, H);
}

const NO_BYTES = new Uint8Array(0);
/** one image resource block ('8BIM', id, empty name, data padded to even) */
function resourceBlock(id: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length + (data.length % 2));
  const dv = new DataView(out.buffer);
  out.set([56, 66, 73, 77], 0);
  dv.setUint16(4, id);
  dv.setUint32(8, data.length);
  out.set(data, 12);
  return out;
}

/** A complete new PSD/PSB from scratch (merged image with transparency). */
export function buildPsd(spec: FreshSpec): Uint8Array {
  const depth = spec.depth ?? 8, mode = spec.mode ?? 3, psb = !!spec.psb;
  if (!writableMode(mode, depth)) throw new Error(`색상 모드 ${mode} / ${depth}비트로는 쓸 수 없습니다`);
  const W = spec.width, H = spec.height;
  const colorCh = colorChannels(mode);
  const records = spec.layers.map((l, i) => {
    const inks = mode === 4 && spec.xf && l.px ? cmykLayerInks(l.px, null, 0, 0, spec.xf).planes : undefined;
    const { parts } = newRecord(l.name, l.px, { ...l.options, visible: l.visible, opacity: l.opacity, blendMode: l.blend, locked: !!l.locked, effects: l.effects } as SceneNode, mode, depth, psb, i + 1, inks);
    if (l.blocks) parts.blocks.push(...l.blocks);
    if (l.clipping) parts.clipping = 1;
    if (l.blendKey) parts.blend = l.blendKey;
    if (l.background) {
      parts.channels = parts.channels.filter((c) => c.id !== -1);
      parts.flags |= 0x01;
      parts.blocks.push(block("lspf", u32be(0xd), psb));
    }
    if (l.mask) {
      const mp = maskParts(l.mask, depth, psb);
      parts.mask = mp.mask;
      parts.channels.push(mp.channel);
    }
    if (l.adjustment) parts.flags |= 0x10;
    return parts;
  });
  const comp = spec.composite ?? freshComposite(spec.layers, W, H);
  const o = new Out();
  o.str("8BPS");
  o.u16(psb ? 2 : 1);
  for (let i = 0; i < 6; i++) o.u8(0);
  o.u16(colorCh + 1);
  o.u32(H);
  o.u32(W);
  o.u16(depth);
  o.u16(mode);
  o.u32(0); // colour mode data
  // image resources: resolution info (72 dpi)
  const res = new Out();
  res.str("8BIM");
  res.u16(1005);
  res.u16(0);
  res.u32(16);
  res.u32(72 << 16);
  res.u16(1);
  res.u16(1);
  res.u32(72 << 16);
  res.u16(1);
  res.u16(1);
  if (spec.resources?.length) res.bytes(spec.resources);
  const resBytes = res.done();
  o.u32(resBytes.length);
  o.bytes(resBytes);
  const lm = new Out();
  const content = records.length ? layerInfoContent(records, -records.length, psb) : new Uint8Array(0);
  if (depth === 16 && records.length) {
    lm.len(0, psb);
    lm.u32(0); // global mask
    lm.bytes(block("Lr16", content, psb));
  } else {
    lm.len(content.length, psb);
    lm.bytes(content);
    lm.u32(0);
  }
  for (const g of spec.globalBlocks ?? []) lm.bytes(g);
  const lmBytes = lm.done();
  o.len(lmBytes.length, psb);
  o.bytes(lmBytes);
  const n = W * H;
  o.bytes(encodeImageData([...colourPlanes(comp, n, mode, depth, null, spec.xf), alphaPlane(comp, n, depth)], W, H, depth / 8, psb));
  return o.done();
}

// ───────── main entry ─────────

const CONTENT_KEYS = new Set(["TySh", "tySh", "SoLd", "SoLE", "PlLd", "plLd", "vscg", "vstk", "vogk"]);
const VECTOR_MASK_KEYS = new Set(["vmsk", "vsms"]);
/** Fill-layer content (solid colour / gradient / pattern): with a vector mask, a shape layer Photoshop draws live. */
const FILL_KEYS = new Set(["SoCo", "GdFl", "PtFl"]);

/**
 * Background's lock signature (lspf 0x0D = transparency + position + auto-nesting locks) on the bottom record
 * although it has a transparency channel — what an earlier version wrote (Photoshop refused that file).
 * lspf bit 3 alone is Photoshop's user-settable "prevent auto-nesting into artboards/frames" lock and is valid
 * on any layer, so it is not a sign of a Background.
 */
export function isHalfBackground(b: Uint8Array, rec: PsdRecord, index = rec.index): boolean {
  if (index !== 0 || !rec.channels.some((c) => c.id === -1)) return false;
  const k = rec.blocks.find((x) => x.key === "lspf" && x.dataEnd - x.dataStart >= 4);
  return !!k && (b[k.dataStart + 3] & 0x0f) === 0x0d;
}
const halfBackground = (b: Uint8Array, rec: PsdRecord) => isHalfBackground(b, rec);

function hasContentBlocks(rec: PsdRecord) {
  return rec.blocks.some((b) => CONTENT_KEYS.has(b.key) || VECTOR_MASK_KEYS.has(b.key));
}
const hasVectorMask = (rec: PsdRecord) => rec.blocks.some((b) => VECTOR_MASK_KEYS.has(b.key));

/** Content blocks whose canvas anchors shiftContentBlock moves (a pure move / canvas crop keeps them live). */
const SHIFTABLE_KEYS = new Set(["TySh", "SoLd", "SoLE", "PlLd", "plLd", "vscg", "vstk", "vogk", "vmsk", "vsms"]);
function canShiftContent(b: Uint8Array, rec: PsdRecord): boolean {
  return rec.blocks.every((k) => !(CONTENT_KEYS.has(k.key) || VECTOR_MASK_KEYS.has(k.key)) || (SHIFTABLE_KEYS.has(k.key) && shiftContentBlock(b.subarray(k.dataStart, k.dataEnd), k.key, 0, 0, 1, 1, 1, 1) !== null));
}

const asciiAt = (d: Uint8Array, at: number, s: string) => {
  if (at < 0 || at + s.length > d.length) return false;
  for (let i = 0; i < s.length; i++) if (d[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * A content block's data with its canvas anchors moved by (dx, dy) and, for vector-mask paths (stored as fractions
 * of the canvas), renormalised from the old canvas (ow × oh) to the new one (nw × nh): placed-layer transform
 * corners (PlLd header, SoLd 'Trnf' / 'nonAffineTransform'), the type transform's tx / ty (TySh), live-shape
 * origination points and boxes (vogk), vector-mask knots (vmsk / vsms). Fill / stroke content (vscg / vstk) has no
 * canvas anchor. null: a layout this does not know (the caller rasterizes, as before).
 */
export function shiftContentBlock(src: Uint8Array, key: string, dx: number, dy: number, ow: number, oh: number, nw: number, nh: number): Uint8Array | null {
  const d = src.slice();
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const addD = (at: number, by: number) => v.setFloat64(at, v.getFloat64(at) + by);
  // 'VlLs' of 8 'doub' after a descriptor key (x, y pairs)
  const corners = (name: string, keyed: boolean) => {
    const pre = keyed ? [0, 0, 0, 0] : [0, 0, 0, name.length];
    for (let at = 4; (at = d.indexOf(name.charCodeAt(0), at)) >= 0; at++) {
      if (!asciiAt(d, at, name) || at < 4) continue;
      if (![0, 1, 2, 3].every((i) => d[at - 4 + i] === pre[i])) continue;
      let p = at + name.length;
      if (!asciiAt(d, p, "VlLs") || p + 8 > d.length || v.getUint32(p + 4) !== 8) continue;
      p += 8;
      for (let i = 0; i < 8; i++, p += 12) {
        if (!asciiAt(d, p, "doub") || p + 12 > d.length) return false;
        addD(p + 4, i % 2 ? dy : dx);
      }
    }
    return true;
  };
  switch (key) {
    case "TySh": {
      if (d.length < 50 || v.getUint16(0) !== 1) return null;
      addD(2 + 32, dx);
      addD(2 + 40, dy);
      return d;
    }
    case "PlLd":
    case "plLd": {
      if (!asciiAt(d, 0, "plcL") || d.length < 9) return null;
      const p = 8 + 1 + d[8] + 16;
      if (p + 64 > d.length) return null;
      for (let i = 0; i < 8; i++) addD(p + i * 8, i % 2 ? dy : dx);
      return d;
    }
    case "SoLd":
    case "SoLE":
      if (!asciiAt(d, 0, "soLD")) return null;
      return corners("Trnf", true) && corners("nonAffineTransform", false) ? d : null;
    case "vogk": {
      // descriptor items 'Hrzn' / 'Vrtc' / 'Left' / 'Rght' / 'Top ' / 'Btom' as 'UntF' '#Pxl' or plain 'doub'
      const axis: Record<string, number> = { Hrzn: dx, Left: dx, Rght: dx, Vrtc: dy, "Top ": dy, Btom: dy };
      for (let at = 4; at + 8 <= d.length; at++) {
        if (v.getUint32(at - 4) !== 0) continue;
        const k = String.fromCharCode(d[at], d[at + 1], d[at + 2], d[at + 3]);
        if (!(k in axis)) continue;
        if (asciiAt(d, at + 4, "UntF") && asciiAt(d, at + 8, "#Pxl") && at + 20 <= d.length) addD(at + 12, axis[k]);
        else if (asciiAt(d, at + 4, "doub") && at + 16 <= d.length) addD(at + 8, axis[k]);
      }
      return d;
    }
    case "vmsk":
    case "vsms":
      return mapVectorMask(src, (x, y) => [x + dx, y + dy], ow, oh, nw, nh);
    case "vscg":
    case "vstk":
      return d;
  }
  return null;
}

/**
 * A vector-mask block (vmsk / vsms) with every knot (anchor and both control points) mapped by `f` in canvas pixels:
 * knots are fractions of the old canvas (ow × oh) in, of the new one (nw × nh) out. null: a layout this does not know.
 */
export function mapVectorMask(src: Uint8Array, f: (x: number, y: number) => [number, number], ow: number, oh: number, nw: number, nh: number): Uint8Array | null {
  const d = src.slice();
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 8 || (d.length - 8) % 26 > 3) return null; // Photoshop pads the block to 4 bytes (2 left over)
  const F = 1 << 24;
  for (let r = 8; r + 26 <= d.length; r += 26) {
    const t = v.getUint16(r);
    if (t !== 1 && t !== 2 && t !== 4 && t !== 5) continue;
    for (let i = 0; i < 3; i++) {
      const at = r + 2 + i * 8;
      const [x, y] = f((v.getInt32(at + 4) / F) * ow, (v.getInt32(at) / F) * oh);
      v.setInt32(at, Math.round((y / nh) * F));
      v.setInt32(at + 4, Math.round((x / nw) * F));
    }
  }
  return d;
}

/**
 * A text layer edited as text here (psdText changed or the layer moved) whose pixels are the ones drawn from that
 * text: painted over with other tools (pixels unlike what the spec drew), rotated or scaled, it is rasterized as before.
 */
function textEdited(rec: PsdRecord, node: RasterNode, link: PsdLayerLink): boolean {
  const s = node.psdText;
  if (!s || link.txt === undefined || !rec.blocks.some((k) => k.key === "TySh")) return false;
  const off = pixelOffset(node);
  if (!off) return false;
  if (rasterFingerprint(node) !== (s.fp ?? link.fp)) return false;
  return psdTextKey(s) !== link.txt || off.x !== link.x || off.y !== link.y;
}

/**
 * A smart object whose content was edited in its own tab (psdSmart.edited) and whose pixels are still the ones drawn
 * from it then (not painted over since, at whole pixels): written as a smart object with the new content.
 */
function smartEdited(rec: PsdRecord, node: RasterNode): boolean {
  const e = node.psdSmart?.edited;
  if (!e || node.adjust || !node.psdSmart?.redraw) return false;
  if (!rec.blocks.some((k) => PLACED_KEYS.has(k.key))) return false;
  return !!pixelOffset(node) && rasterFingerprint(node) === e.fp && !!getBlob(e.hash);
}

/** The record's TySh block rewritten from the node's text spec, or null (then it is dropped and the layer rasterized). */
function retypedTySh(b: Uint8Array, rec: PsdRecord, node: RasterNode, link: PsdLayerLink, psb: boolean): Uint8Array | null {
  const blk = rec.blocks.find((k) => k.key === "TySh");
  const s = node.psdText;
  const off = pixelOffset(node);
  if (!blk || !s || !off || !link.txt) return null;
  let was: { text: string; size: number; color: string };
  try {
    const [text, size, color] = JSON.parse(link.txt);
    was = { text, size, color };
  } catch {
    return null;
  }
  const data = editTySh(b.subarray(blk.dataStart, blk.dataEnd), was, s, off.x + s.ox, off.y + s.oy);
  return data ? block("TySh", data, psb) : null;
}

/** Write `page` as PSD. Uses the original file (page.source.psd) when it is available and intact. */
export async function writePsd(doc: OmwDocument, page: Page, opts: PsdWriteOptions = {}): Promise<PsdWriteResult> {
  // the merged image of a page that dissolves needs Photoshop's thresholds (loaded on demand, core/style/blend.ts)
  if (pageDissolves(page)) await loadDissolveField().catch(() => {});
  const meta = page.source?.format === "psd" ? page.source.psd : undefined;
  const warnings: string[] = [];
  if (meta) {
    const asset = doc.assets[meta.assetId];
    const orig = asset && asset.hash === meta.hash ? getBlob(asset.hash) : undefined;
    if (!orig) warnings.push("원본 PSD 데이터를 찾지 못해 새 PSD로 저장했습니다 (효과·텍스트·조정 레이어 정보 없음)");
    else {
      let L: PsdLayout | null = null;
      try {
        L = parsePsdLayout(orig);
      } catch (e: any) {
        warnings.push(`원본 PSD 구조를 다시 읽지 못해 새 PSD로 저장했습니다: ${e?.message ?? e}`);
      }
      if (L && L.records.length !== meta.layers.length) {
        warnings.push("원본 PSD와 레이어 연결 정보가 맞지 않아 새 PSD로 저장했습니다");
        L = null;
      }
      // 이미지 › 모드 changed (RGB ↔ Grayscale ↔ CMYK): the file is written anew in that mode
      const want = page.colorMode === "cmyk" ? 4 : page.colorMode === "gray" ? 1 : 3;
      if (L && [1, 3, 4].includes(L.mode) && L.mode !== want) {
        warnings.push(`색상 모드를 바꿔(${L.mode === 4 ? "CMYK" : L.mode === 1 ? "회색조" : "RGB"} → ${want === 4 ? "CMYK" : want === 1 ? "회색조" : "RGB"}) 새 PSD로 저장했습니다`);
        L = null;
      }
      if (L) {
        const c = psdCanvasSize(page, L);
        return guard(await surgery(doc, page, L, orig, meta, opts, warnings), { width: c.width, height: c.height, depth: L.depth, mode: L.mode, psb: L.psb }, orig);
      }
    }
  }
  return guard(await fresh(doc, page, opts, warnings), null);
}

async function fresh(doc: OmwDocument, page: Page, opts: PsdWriteOptions, warnings: string[]): Promise<PsdWriteResult> {
  const layers: FreshLayer[] = [];
  const skipped: string[] = [];
  const hidden = page.source?.psd?.compositeNode;
  const psb = page.width > 30000 || page.height > 30000;
  const nodes = contiguousOrder(page.nodes.filter((n) => n.id !== hidden), page.groups);
  const index = groupIndex(page.groups);
  const pxOf = new Map<string, LayerPixels | null>();
  const smartEntries: Uint8Array[] = [];
  // folders: a divider opens each group the first time one of its members comes, the header closes it
  let open: LayerGroup[] = [];
  const close = (to: number) => {
    while (open.length > to) layers.push(groupMarkers(open.pop()!, psb).header);
  };
  for (const n of nodes) {
    const path = groupPath(n.groupId, index);
    let k = 0;
    while (k < open.length && k < path.length && open[k].id === path[k].id) k++;
    close(k);
    for (; k < path.length; k++) {
      layers.push(groupMarkers(path[k], psb).divider);
      open.push(path[k]);
    }
    if (n.type === "RASTER" && n.adjust) {
      // an adjustment layer made or edited here: its settings and mask (psdAdjustWrite.ts); a kind not written is left out
      const blocks = adjustmentBlocks(n.adjust.adj);
      if (!blocks) {
        skipped.push(n.name);
        continue;
      }
      pxOf.set(n.id, rasterPixels(n));
      const ms = layerMaskSpec(n);
      layers.push({ name: n.name, px: null, opacity: n.opacity, visible: n.visible, blend: n.blendMode, locked: n.locked, adjustment: true, blocks: blocks.map(([k, d]) => block(k, d, psb)), ...(ms ? { mask: ms } : {}), ...(n.clip ? { clipping: true } : {}) });
      continue;
    }
    const px = await nodePixels(doc, page, n, opts);
    if (px === "skip") {
      skipped.push(n.name);
      continue;
    }
    // the merged image shows the layer through its mask; the record keeps every pixel and the mask beside them
    const ms = n.type === "RASTER" ? layerMaskSpec(n) : null;
    pxOf.set(n.id, ms && n.type === "RASTER" ? shownPixels(n) : px);
    // a text box: an editable Photoshop text layer (its type block made here, our drawing as its pixels)
    const ty = textTyShBlock(n, psb);
    // a smart object made here: a placed layer, its file in the document's linked-file block
    const so = newSmartParts(n, psb);
    if (so) smartEntries.push(so.entry);
    const extra = [...(ty ? [ty] : []), ...(so ? [so.block] : [])];
    layers.push({ name: n.type === "RASTER" || ty ? n.name : `${n.name} (래스터로 굳힘)`, px, opacity: n.opacity, visible: n.visible, blend: n.blendMode, locked: n.locked, ...(extra.length ? { blocks: extra } : {}), options: { fillOpacity: n.fillOpacity, fillInterior: n.fillInterior, knockout: n.knockout, blendIf: n.blendIf, lockAlpha: n.lockAlpha, lockPixels: n.lockPixels, lockPosition: n.lockPosition }, ...(ms ? { mask: ms } : {}), ...(n.clip ? { clipping: true } : {}), ...(n.effects?.length ? { effects: n.effects } : {}) });
  }
  close(0);
  if (skipped.length) warnings.push(`래스터로 바꿀 수 없어 빠진 개체 ${skipped.length}개: ${skipped.slice(0, 5).join(", ")}`);
  // groups / clipping: the merged image follows Photoshop's compositing of the tree
  const composite = hasStructure(nodes, page.groups) || nodes.some((n) => n.effects?.length || (n.fillOpacity ?? 1) < 1 || !!n.blendIf || !!n.knockout || (n.type === "RASTER" && (n.adjust || n.mask)))
    ? compositeTree(nodes.filter((n) => pxOf.has(n.id)), page.groups, (n) => pxOf.get(n.id) ?? null, page.width, page.height)
    : undefined;
  // image resources after the resolution: saved paths (패스 panel) and ruler guides (resource 1032)
  const extraRes = concatBytes([page.paths?.length ? pathResources(page.paths, page.width, page.height) : new Uint8Array(0), guidesResource(page.guides)]);
  const mode = page.colorMode === "cmyk" ? 4 : page.colorMode === "gray" ? 1 : 3;
  // CMYK: separated through the CMYK profile the file is read with (the shipped default), embedded (resource 1039) so
  // Photoshop separates and shows it the same way
  const xf = mode === 4 ? psdCmykProfile(NO_BYTES, []).xf : null;
  const icc = xf ? defaultCmykProfile() : null;
  const allRes = icc ? concatBytes([extraRes, resourceBlock(1039, icc.bytes)]) : extraRes;
  const bytes = buildPsd({ width: page.width, height: page.height, mode, xf, layers, psb, composite, ...(allRes.length ? { resources: allRes } : {}), ...(smartEntries.length ? { globalBlocks: [block("lnk2", concatBytes(smartEntries), psb)] } : {}) });
  return { bytes, method: "fresh", warnings };
}

// ───────── linked smart-object files (global lnk2 / lnk3 / lnkD) ─────────

const SMART_KEYS = new Set(["PlLd", "plLd", "SoLd", "SoLE"]);
const LINK_KEYS = new Set(["lnk2", "lnk3", "lnkD"]);

/** Entries of a linked-file block: 8-byte length, then 'liFD'/'liFE'/'liFA', version, Pascal unique id; 4-aligned. */
function linkEntries(b: Uint8Array, blk: PsdBlock): { start: number; end: number; id: string }[] | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: { start: number; end: number; id: string }[] = [];
  let o = blk.dataStart;
  while (o < blk.dataEnd) {
    if (o + 8 + 9 > blk.dataEnd) return null;
    const len = dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);
    const s = o + 8;
    if (len < 9 || s + len > blk.dataEnd) return null;
    const idLen = b[s + 8];
    if (9 + idLen > len) return null;
    let id = "";
    for (let i = 0; i < idLen; i++) id += String.fromCharCode(b[s + 9 + i]);
    let end = s + len;
    while ((end - blk.dataStart) % 4 && end < blk.dataEnd) end++;
    out.push({ start: o, end, id });
    o = end;
  }
  return o === blk.dataEnd ? out : null;
}

/** Linked-file entries no smart-object block of `L` references (0 when none or the blocks cannot be parsed). */
function orphanLinks(b: Uint8Array, L: PsdLayout): number {
  const live = L.records.flatMap((r) => r.blocks.filter((k) => SMART_KEYS.has(k.key)).map((k) => b.subarray(k.dataStart, k.dataEnd)));
  let n = 0;
  for (const blk of L.globalBlocks) {
    if (!LINK_KEYS.has(blk.key)) continue;
    const entries = linkEntries(b, blk);
    if (entries) n += entries.filter((e) => !mentions(live, e.id)).length;
  }
  return n;
}

/** Does any of `hay` contain `id` as Latin-1 or UTF-16BE text? */
function mentions(hay: Uint8Array[], id: string): boolean {
  if (!id) return true;
  const a = Array.from(id, (c) => c.charCodeAt(0));
  const u = a.flatMap((c) => [0, c]);
  const find = (h: Uint8Array, n: number[]) => {
    outer: for (let i = 0; i + n.length <= h.length; i++) {
      for (let k = 0; k < n.length; k++) if (h[i + k] !== n[k]) continue outer;
      return true;
    }
    return false;
  };
  return hay.some((h) => find(h, a) || find(h, u));
}

/**
 * The linked-file block keeping only entries a live smart object (PlLd / SoLd …) still references. Photoshop
 * refuses files with orphaned entries (seen with a file whose smart object an earlier version had rasterized);
 * Photoshop's own files never contain them. Null when nothing changes or the block cannot be parsed (then it is
 * copied verbatim).
 */
function pruneLinks(b: Uint8Array, blk: PsdBlock, live: Uint8Array[]): Uint8Array | null {
  const entries = linkEntries(b, blk);
  if (!entries) return null;
  const keep = entries.filter((e) => mentions(live, e.id));
  if (keep.length === entries.length) return null;
  const o = new Out();
  o.str(blk.sig);
  o.str(blk.key);
  o.len(keep.reduce((s, e) => s + e.end - e.start, 0), blk.long);
  for (const e of keep) o.bytes(b.subarray(e.start, e.end));
  return o.done();
}

type Plan =
  | { kind: "orig"; rec: PsdRecord; link: PsdLayerLink; node: RasterNode | null; action: "keep" | "meta" | "pixels"; group?: LayerGroup; text?: boolean; smart?: boolean }
  | { kind: "new"; node: SceneNode }
  | { kind: "newGroup"; group: LayerGroup; end: "divider" | "header" };

const groupChanged = (g: LayerGroup, link: PsdLayerLink) => g.name !== link.name || g.opacity !== link.opacity || g.visible !== link.visible || g.blendMode !== link.blend || g.locked !== link.locked || fxChanged(g.effects, link);
const groupLooksChanged = (g: LayerGroup, link: PsdLayerLink) => g.opacity !== link.opacity || g.visible !== link.visible || g.blendMode !== link.blend || fxChanged(g.effects, link);

/**
 * Record order from the model (page.groups + node.groupId): every folder of the original file the model still
 * has is written around wherever its members are now; folders the model dropped (ungrouped) lose their markers;
 * new folders get new markers. Records we do not draw (adjustment, fill… layers, folders with none of our
 * layers) travel with the nearest surviving layer or folder below them in their original folder, as before.
 * With nothing changed this reproduces the original order exactly.
 */
function modelPlans(b: Uint8Array, L: PsdLayout, meta: PsdSourceMeta, page: Page, nodes: SceneNode[], recPlan: Map<number, Plan>, warnings: string[]): Plan[] {
  type OGroup = { t: "grp"; d: number; h: number; gid: string; kids: OItem[] };
  type OItem = { t: "rec"; i: number } | OGroup;
  const model = groupIndex(page.groups);
  // original tree (bottom → top); unmatched markers and folders the model no longer has are flattened
  const root: OItem[] = [];
  const st: { g: OGroup | null; kids: OItem[] }[] = [{ g: null, kids: root }];
  let dropped = 0;
  for (let i = 0; i < L.records.length; i++) {
    const s = sectionType(b, L.records[i]);
    if (s === 3) {
      const g: OGroup = { t: "grp", d: i, h: -1, gid: "", kids: [] };
      st[st.length - 1].kids.push(g);
      st.push({ g, kids: g.kids });
    } else if ((s === 1 || s === 2) && meta.layers[i].node === null) {
      if (st.length > 1) {
        const top = st.pop()!;
        top.g!.h = i;
        top.g!.gid = meta.layers[i].group ?? "";
      } else dropped++;
    } else st[st.length - 1].kids.push({ t: "rec", i });
  }
  while (st.length > 1) st.pop();
  const flatten = (items: OItem[]): OItem[] =>
    items.flatMap((it) => {
      if (it.t === "rec") return [it];
      it.kids = flatten(it.kids);
      if (it.h >= 0 && it.gid && model.has(it.gid)) return [it];
      if (it.h >= 0 || it.d >= 0) dropped++;
      return it.kids;
    });
  const top = flatten(root);
  const origGroup = new Map<string, OGroup>();
  const walkG = (items: OItem[]) => items.forEach((it) => it.t === "grp" && (origGroup.set(it.gid, it), walkG(it.kids)));
  walkG(top);

  // groups that hold at least one of our nodes (directly or in a subgroup)
  const ordered = contiguousOrder(nodes, page.groups);
  const filled = new Set<string>();
  for (const n of ordered) for (const g of groupPath(n.groupId, model)) filled.add(g.id);
  const nodeOfRec = (i: number) => {
    const p = recPlan.get(i);
    return p && p.kind === "orig" && p.node ? p.node.id : null;
  };

  // unlinked items: tails after their anchor (a node id or "g:"+group id), or leads at the bottom of a folder
  const tails = new Map<string, OItem[]>();
  const leads = new Map<string, OItem[]>();
  const push = (m: Map<string, OItem[]>, k: string, it: OItem) => (m.get(k) ?? m.set(k, []).get(k)!).push(it);
  const anchorWalk = (items: OItem[], gid: string) => {
    let anchor: string | null = null;
    for (const it of items) {
      if (it.t === "rec") {
        const link = meta.layers[it.i];
        if (link.node) {
          const id = nodeOfRec(it.i);
          if (id) anchor = id; // a deleted layer leaves the anchor where it was
          continue;
        }
        if (anchor) push(tails, anchor, it);
        else push(leads, gid, it);
      } else if (filled.has(it.gid)) {
        anchor = "g:" + it.gid;
        anchorWalk(it.kids, it.gid);
      } else if (anchor) push(tails, anchor, it);
      else push(leads, gid, it);
    }
  };
  anchorWalk(top, "");

  const out: Plan[] = [];
  const used = new Set<Plan>();
  const add = (p: Plan | undefined) => {
    if (p && !used.has(p)) {
      used.add(p);
      out.push(p);
    }
  };
  const emitUnlinked = (it: OItem) => {
    // a record of one of our layers is placed by the model, never by its old folder
    if (it.t === "rec") return meta.layers[it.i].node ? undefined : add(recPlan.get(it.i));
    add(recPlan.get(it.d));
    it.kids.forEach(emitUnlinked);
    add(recPlan.get(it.h));
  };
  const emitTails = (k: string) => (tails.get(k) ?? []).forEach(emitUnlinked);

  // model tree from the (contiguous) node order
  type MItem = { t: "node"; n: SceneNode } | { t: "group"; g: LayerGroup; kids: MItem[] };
  const mroot: MItem[] = [];
  const mst: { g: LayerGroup; kids: MItem[] }[] = [];
  for (const n of ordered) {
    const path = groupPath(n.groupId, model);
    let k = 0;
    while (k < mst.length && k < path.length && mst[k].g.id === path[k].id) k++;
    mst.length = k;
    for (; k < path.length; k++) {
      const kids: MItem[] = [];
      (mst.length ? mst[mst.length - 1].kids : mroot).push({ t: "group", g: path[k], kids });
      mst.push({ g: path[k], kids });
    }
    (mst.length ? mst[mst.length - 1].kids : mroot).push({ t: "node", n });
  }
  const linkedNodes = new Map<string, number>();
  meta.layers.forEach((l, i) => l.node && linkedNodes.set(l.node, i));
  const emitted = new Set<string>();
  const emitContents = (gid: string, kids: MItem[]) => {
    (leads.get(gid) ?? []).forEach(emitUnlinked);
    for (const k of kids) {
      if (k.t === "node") {
        const i = linkedNodes.get(k.n.id);
        if (i !== undefined) {
          const p = recPlan.get(i);
          if (p) {
            add(p);
            emitTails(k.n.id);
          }
        } else out.push({ kind: "new", node: k.n });
      } else emitGroup(k.g, k.kids);
    }
    // new folders without members: on top of their parent
    for (const g of page.groups ?? [])
      if ((g.parentId ?? "") === gid && !filled.has(g.id) && !origGroup.has(g.id) && !emitted.has(g.id)) emitGroup(g, []);
  };
  const emitGroup = (g: LayerGroup, kids: MItem[]) => {
    emitted.add(g.id);
    const o = origGroup.get(g.id);
    if (o) add(recPlan.get(o.d));
    else out.push({ kind: "newGroup", group: g, end: "divider" });
    emitContents(g.id, kids);
    if (o) add(recPlan.get(o.h));
    else out.push({ kind: "newGroup", group: g, end: "header" });
    emitTails("g:" + g.id);
  };
  emitContents("", mroot);
  if (dropped) warnings.push(t(dropped === 1 ? "layers.psd.foldersReleased_one" : "layers.psd.foldersReleased", { n: dropped }));
  return out;
}

/**
 * Canvas size a PSD rewrite gets: the page's when it is whole pixels and this file version holds it (PSD up to 30000
 * px, PSB up to 300000 — the version is not switched), else the original header's (`fits` false: a notice is shown).
 */
export function psdCanvasSize(page: { width: number; height: number }, L: { width: number; height: number; psb: boolean }): { width: number; height: number; changed: boolean; fits: boolean } {
  const w = page.width, h = page.height;
  if (w === L.width && h === L.height) return { width: w, height: h, changed: false, fits: true };
  const max = L.psb ? 300000 : 30000;
  const fits = Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= max && h <= max;
  return fits ? { width: w, height: h, changed: true, fits } : { width: L.width, height: L.height, changed: false, fits };
}

async function surgery(doc: OmwDocument, page: Page, L: PsdLayout, orig: Uint8Array, meta: PsdSourceMeta, opts: PsdWriteOptions, warnings: string[]): Promise<PsdWriteResult> {
  const b = orig;
  const { psb, mode, depth } = L;
  // a CMYK document's profile: unchanged pixels are recognised, new ones separated, through it (iccCmyk.ts)
  const xf = mode === 4 ? psdCmykProfile(b, L.resItems).xf : null;
  // a duotone shows its grey as ink colours (psd.ts duotoneLut): written back as that grey
  const grey = mode === 8 ? duotoneGrey(duotoneLut(L)) : null;
  const colorCh = colorChannels(mode);
  const nodes = page.nodes.filter((n) => n.id !== meta.compositeNode);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const linked = new Set(meta.layers.map((l) => l.node).filter(Boolean) as string[]);
  // canvas size: the page's (canvas crop / enlarge). The header, the merged image and the Background layer rule follow
  // it; layer records keep their own rectangles (moved with the content). A size this file cannot hold keeps the
  // original one, with a notice (psdCanvasSize)
  const canvas = psdCanvasSize(page, L);
  const sizeChanged = canvas.changed;
  const outW = canvas.width, outH = canvas.height;
  // ruler guides made or moved in the app (resource 1032): the file is rewritten for them too
  const guidesOf = (g: { x?: number[]; y?: number[] } | undefined) => JSON.stringify(g?.x?.length || g?.y?.length ? { x: g.x ?? [], y: g.y ?? [] } : {});
  const guidesChanged = guidesOf(readGuides(b, L.resItems)) !== guidesOf(page.guides);
  if (!canvas.fits) warnings.push(`캔버스 크기 변경(${L.width}×${L.height} → ${page.width}×${page.height})은 이 PSD에 담을 수 없어 원본 크기로 저장했습니다`);
  if (sizeChanged) warnings.push(`캔버스 크기를 ${L.width}×${L.height}에서 ${outW}×${outH}로 바꿔 저장했습니다 (레이어 위치도 함께 옮김)`);

  // flat file: the merged image node is the content
  const flat = meta.flatNode ? byId.get(meta.flatNode) : undefined;
  if (meta.flatNode && flat && flat.type === "RASTER" && nodes.length === 1) {
    const t = flat.transform;
    const same = rasterFingerprint(flat) === meta.flatFp && t.x === 0 && t.y === 0 && t.rotation === 0 && t.scale === 1 && (t.scaleY ?? 1) === 1 && !flat.crop && flat.visible && flat.opacity === 1 && !sizeChanged && !guidesChanged;
    if (same) return { bytes: orig.slice(), method: "original", warnings };
  }

  // content blocks' canvas anchors moved with their layer / renormalised to the new canvas (blocks shiftContentBlock
  // cannot read were ruled out when planning: those layers are rasterized)
  const shiftBlocks = (blks: { key: string; raw: Uint8Array }[], dx: number, dy: number, only?: Set<string>) => {
    for (let i = 0; i < blks.length; i++) {
      const k = blks[i];
      if (!SHIFTABLE_KEYS.has(k.key) || (only && !only.has(k.key))) continue;
      const hdr = psb && LONG_KEYS.has(k.key) ? 16 : 12;
      const data = shiftContentBlock(k.raw.subarray(hdr), k.key, dx, dy, L.width, L.height, outW, outH);
      if (data) blks[i] = { key: k.key, raw: block(k.key, data, psb) };
    }
  };

  // per-record decisions
  const plans: Plan[] = [];
  const recPlan = new Map<number, Plan>();
  let adjustMasks = 0;
  for (let i = 0; i < L.records.length; i++) {
    const rec = L.records[i], link = meta.layers[i];
    const node = link.node ? byId.get(link.node) : undefined;
    if (link.node && !node) continue; // deleted
    if (node && node.type !== "RASTER") continue;
    let action: "keep" | "meta" | "pixels" = "keep";
    let text = false, smart = false;
    if (node && smartEdited(rec, node as RasterNode)) {
      // a smart object whose content was edited in its own tab: its pixels are the new content drawn through its
      // transform; it stays a smart object (its placed-layer block kept, the embedded file replaced)
      action = "pixels";
      smart = true;
    } else if (node && !(node as RasterNode).adjust && textEdited(rec, node as RasterNode, link)) {
      // a text layer edited as text (or moved): its pixels are re-encoded and its type block rewritten, not dropped
      action = "pixels";
      text = true;
    } else if (node && (node as RasterNode).adjust) {
      // an adjustment layer: its record (settings, mask channel) is kept; name, opacity, eye, blend, lock, clipping
      // and effects are patched. A mask painted here is not written back (the Photoshop mask stays)
      // A pure move (canvas crop) shifts its mask rectangle and vector mask instead
      const tf = node.transform;
      const same = rasterFingerprint(node) === link.fp && tf.rotation === 0 && tf.scale === 1 && (tf.scaleY ?? 1) === 1 && !(node as RasterNode).crop;
      const shifted = same && (tf.x !== link.x || tf.y !== link.y) && Number.isInteger(tf.x) && Number.isInteger(tf.y) && canShiftContent(b, rec);
      // (settings or a mask changed here on a kind written here: the record is written anew — adjustRecord)
      const rewritten = (!!(node as RasterNode).adjust!.edited || !same) && !!adjustmentBlocks((node as RasterNode).adjust!.adj);
      if (!rewritten && (!same || ((tf.x !== link.x || tf.y !== link.y) && !shifted))) adjustMasks++;
      if (shifted || (sizeChanged && hasVectorMask(rec) && canShiftContent(b, rec))) action = "meta";
      if (fxChanged(node.effects, link) || node.name !== link.name || node.opacity !== link.opacity || node.visible !== link.visible || node.blendMode !== link.blend || node.locked !== link.locked || !!node.clip !== !!link.clip) action = "meta";
    } else if (node) {
      const off = pixelOffset(node as RasterNode);
      const moved = !!off && (off.x !== link.x || off.y !== link.y);
      // a Background layer (no transparency channel) cannot move: it is rewritten as an ordinary layer
      const background = !rec.channels.some((c) => c.id === -1);
      // a moved smart object / shape / fill / text layer keeps its record: bounds and canvas anchors are shifted
      // (shiftContentBlock); a block of a layout that cannot be shifted rasterizes it, as before
      const shiftable = !background && hasContentBlocks(rec) && canShiftContent(b, rec);
      // a layer mask added, painted, turned off or removed here (link.mfp: the mask as read, kept apart on import)
      if (maskFingerprint((node as RasterNode).mask) !== (link.mfp ?? "") || rasterFingerprint(node) !== link.fp || !off || (moved && !shiftable && (hasContentBlocks(rec) || background)) || (sizeChanged && !shiftable && hasVectorMask(rec)) || (background && sizeChanged) || (background && (node.opacity !== link.opacity || node.blendMode !== link.blend))) action = "pixels";
      else if (fxChanged(node.effects, link) || (link.opt !== undefined && blendOptionsKey(node) !== link.opt) || moved || (sizeChanged && hasVectorMask(rec)) || node.name !== link.name || node.opacity !== link.opacity || node.visible !== link.visible || node.blendMode !== link.blend || node.locked !== link.locked || !!node.clip !== !!link.clip || halfBackground(b, rec)) action = "meta";
    }
    const group = link.group ? page.groups?.find((g) => g.id === link.group) : undefined;
    if (group && groupChanged(group, link)) action = "meta";
    const p: Plan = { kind: "orig", rec, link, node: (node as RasterNode) ?? null, action, ...(group ? { group } : {}), ...(text ? { text } : {}), ...(smart ? { smart } : {}) };
    recPlan.set(i, p);
  }

  // groups in the model (a page imported with folder links, or groups made here): order from the model
  // A page imported before folders became groups (no folder links) has no membership for the file's folders: the
  // model cannot place them, so groups made on such a page are not written and the file's folders stay as they are
  const fileFolders = L.records.some((r) => sectionType(b, r) !== 0);
  const modelDriven = meta.layers.some((l) => l.group) || (!!page.groups?.length && !fileFolders);
  if (!modelDriven && page.groups?.length) warnings.push(t("layers.psd.legacyGroups"));
  if (modelDriven) plans.push(...modelPlans(b, L, meta, page, nodes, recPlan, warnings));
  else {

  // group folders of the original file: bounding divider (lsct 3) … folder header (lsct 1/2), bottom → top
  const pairs: { d: number; h: number }[] = [];
  const paired = new Set<number>();
  {
    const st: number[] = [];
    for (let i = 0; i < L.records.length; i++) {
      if (meta.layers[i].node) continue;
      const t = sectionType(b, L.records[i]);
      if (t === 3) st.push(i);
      else if ((t === 1 || t === 2) && st.length) {
        const d = st.pop()!;
        pairs.push({ d, h: i });
        paired.add(d).add(i);
      }
    }
  }

  // order: other unlinked records (adjustments, fills…) travel with the nearest surviving pixel layer below them
  const lead: Plan[] = [];
  const tails = new Map<string, Plan[]>();
  let anchor: Plan[] = lead;
  for (let i = 0; i < L.records.length; i++) {
    const p = recPlan.get(i);
    const link = meta.layers[i];
    if (link.node) {
      if (p) {
        anchor = [];
        tails.set(link.node, anchor);
      }
      continue;
    }
    if (p && !paired.has(i)) anchor.push(p);
  }
  plans.push(...lead);
  for (const n of nodes) {
    if (linked.has(n.id)) {
      const i = meta.layers.findIndex((l) => l.node === n.id);
      const p = recPlan.get(i);
      if (p) plans.push(p, ...(tails.get(n.id) ?? []));
    } else plans.push({ kind: "new", node: n });
  }
  // each folder is wrapped around wherever its surviving members ended up (innermost folders first, so
  // an outer folder also encloses the inner one's markers); an emptied folder stays at its old place
  const origIdx = (p: Plan) => (p.kind === "orig" ? p.rec.index : -1);
  for (const { d, h } of [...pairs].sort((x, y) => x.h - x.d - (y.h - y.d))) {
    const pd = recPlan.get(d), ph = recPlan.get(h);
    if (!pd || !ph) continue;
    const pos = plans.map((p, k) => (origIdx(p) > d && origIdx(p) < h ? k : -1)).filter((k) => k >= 0);
    if (pos.length) {
      plans.splice(Math.max(...pos) + 1, 0, ph);
      plans.splice(Math.min(...pos), 0, pd);
    } else {
      let at = 0;
      plans.forEach((p, k) => {
        if (origIdx(p) >= 0 && origIdx(p) < d) at = k + 1;
      });
      plans.splice(at, 0, pd, ph);
    }
  }

  // Group markers travel with neighbouring layers, so a reorder can put a folder header below its
  // bounding divider. Photoshop needs dividers (lsct 3) and headers (lsct 1/2) properly nested
  // bottom → top: unmatched markers are dropped (their layers stay, just outside that group).
  {
    const open: number[] = [];
    const drop = new Set<number>();
    plans.forEach((p, k) => {
      if (p.kind !== "orig" || p.link.node) return;
      const t = sectionType(b, p.rec);
      if (t === 3) open.push(k);
      else if (t === 1 || t === 2) {
        if (open.length) open.pop();
        else drop.add(k);
      }
    });
    for (const k of open) drop.add(k);
    if (drop.size) {
      const kept = plans.filter((_, k) => !drop.has(k));
      plans.length = 0;
      plans.push(...kept);
      warnings.push(`레이어 순서를 바꾸면서 짝이 맞지 않게 된 그룹 표시 ${drop.size}개를 빼고 저장했습니다 (레이어는 모두 남고 해당 그룹만 풀립니다)`);
    }
  }

  }

  // a Background layer (no transparency channel) must stay the bottom layer; anything else turns it into an
  // ordinary layer (re-encoded with transparency), as Photoshop does when a layer goes under it
  plans.forEach((p, k) => {
    if (k > 0 && p.kind === "orig" && p.node && p.action !== "pixels" && !p.rec.channels.some((c) => c.id === -1)) p.action = "pixels";
  });

  const origOrder = plans.every((p, k) => p.kind === "orig" && p.rec.index === k) && plans.length === L.records.length;
  const groupVisual = plans.some((p) => p.kind === "newGroup" || (p.kind === "orig" && p.group && groupLooksChanged(p.group, p.link)) || (p.kind === "orig" && p.node && !!p.node.clip !== !!p.link.clip));
  const anyEdit = plans.some((p) => p.kind !== "orig" || p.action !== "keep");
  // unedited: the original bytes — unless it carries orphaned linked files (an earlier version's leftovers that
  // Photoshop refuses), which only a rewrite removes
  const orphaned = opts.pruneLinkedFiles !== false && orphanLinks(b, L) > 0;
  if (origOrder && !anyEdit && !sizeChanged && !orphaned && !guidesChanged) return { bytes: orig.slice(), method: "original", warnings };
  const visual =
    sizeChanged ||
    !origOrder ||
    groupVisual ||
    plans.some((p) => p.kind === "new" || (p.kind === "orig" && (p.action === "pixels" || (p.action === "meta" && p.node && (fxChanged(p.node.effects, p.link) || p.node.visible !== p.link.visible || p.node.opacity !== p.link.opacity || p.node.blendMode !== p.link.blend || (!p.node.adjust && (pixelOffset(p.node)?.x !== p.link.x || pixelOffset(p.node)?.y !== p.link.y)))))));
  const needsPixels = plans.some((p) => p.kind === "new" || (p.kind === "orig" && p.action === "pixels"));
  // 32-bit (HDR): the layers are floats in linear light. Layers not edited keep their floats; an edited layer keeps
  // the float of every pixel still as the reader showed it, the edited pixels are written from the screen's 8-bit
  // view (no light past white there); the merged image is composited in linear light (core/image/softComposite.ts)
  let hdrEdited = 0, deepEdited = 0;
  if (depth === 32) {
    // Photoshop opens a 32-bit file only with the blend modes it has for 32 bits (Photoshop 2027, every mode tried):
    // any other one and the file does not open at all — refused here, with the layer named
    const bad = [...nodes.map((n) => [n.name, n.blendMode] as const), ...(page.groups ?? []).map((g) => [g.name, g.blendMode] as const)].find(([, m]) => !HDR_BLENDS.has(m));
    if (bad) throw new Error(`32비트(HDR) PSD에서 PSD 형식이 32비트에서 허용하지 않는 혼합 모드(${bad[1]})가 '${bad[0]}'에 있어 저장하지 않았습니다 — PSD 편집 프로그램이 그 파일을 열지 못합니다. 32비트에서 쓸 수 있는 혼합: 표준·디졸브·어둡게 하기·곱하기·밝게 하기·선형 닷지(추가)·차이·빼기·나누기·색조·채도·색상·광도·밝은 색상·어두운 색상`);
  }
  if ((needsPixels || visual) && !writableMode(mode, depth)) throw new Error(`이 PSD(색상 모드 ${mode}, ${depth}비트)는 레이어 픽셀·합쳐진 이미지를 다시 쓸 수 없습니다 — 편집 없이 저장하거나 Photoshop에서 RGB 8/16비트로 바꾸세요`);

  // pixels (cached: also used for the merged image)
  const pxCache = new Map<string, LayerPixels | null>();
  const skipped = new Map<string, string>();
  const pixelsOf = async (n: SceneNode) => {
    if (!pxCache.has(n.id)) {
      const px = await nodePixels(doc, page, n, opts);
      if (px === "skip") {
        skipped.set(n.id, n.name);
        pxCache.set(n.id, null);
      } else pxCache.set(n.id, px);
    }
    return pxCache.get(n.id) ?? null;
  };
  // a flat file whose only content is its (edited) merged image stays flat
  const flatMode = !L.records.length && nodes.length === 1 && nodes[0].id === meta.flatNode;
  // a duotone: some grey levels show as the same ink colour (30 of 256 in omni-fid-duotone-*), so the colour alone
  // cannot tell them apart — a pixel whose colour is still its original level's keeps that level (QA 2026-11-18:
  // one edited pixel in a flat duotone moved 3446 untouched pixels by a level)
  const duoLut = grey ? duotoneLut(L) : null;
  const greyOrig = new Map<string, { plane: Uint8Array; x: number; y: number; w: number; h: number } | null>();
  const origGreyOf = (n: SceneNode) => {
    if (!greyOrig.has(n.id)) {
      let src: { plane: Uint8Array; x: number; y: number; w: number; h: number } | null = null;
      try {
        if (flatMode && n.id === meta.flatNode) src = { plane: readCompositePlanes(L, colorCh)[0], x: 0, y: 0, w: L.width, h: L.height };
        else {
          const p = plans.find((q) => q.kind === "orig" && q.node?.id === n.id);
          const off = n.type === "RASTER" ? pixelOffset(n as RasterNode) : null;
          if (p && p.kind === "orig" && off) {
            const rec = p.rec, ch = rec.channels.find((c) => c.id === 0);
            const w = rec.right - rec.left, h = rec.bottom - rec.top;
            if (ch && w > 0 && h > 0) src = { plane: readChannelPlane(b, ch.start, ch.end, w, h, 1, psb), x: rec.left + off.x - (p.link.x ?? rec.left), y: rec.top + off.y - (p.link.y ?? rec.top), w, h };
          }
        }
      } catch {
        src = null;
      }
      greyOrig.set(n.id, src);
    }
    return greyOrig.get(n.id) ?? null;
  };
  const greyPlane = (n: SceneNode, px: LayerPixels): Uint8Array => {
    const out = new Uint8Array(px.width * px.height);
    const src = duoLut ? origGreyOf(n) : null;
    for (let i = 0; i < out.length; i++) {
      const r = px.rgba[i * 4], g = px.rgba[i * 4 + 1], bl = px.rgba[i * 4 + 2];
      let v = -1;
      if (src && duoLut) {
        const x = px.left + (i % px.width) - src.x, y = px.top + Math.floor(i / px.width) - src.y;
        if (x >= 0 && y >= 0 && x < src.w && y < src.h) {
          const o = src.plane[y * src.w + x];
          if (duoLut[o * 3] === r && duoLut[o * 3 + 1] === g && duoLut[o * 3 + 2] === bl) v = o;
        }
      }
      out[i] = v >= 0 ? v : grey!(r, g, bl);
    }
    return out;
  };

  let maxId = 0;
  const img = decodeLayout(L, { metaOnly: true });
  for (const l of img.layers) maxId = Math.max(maxId, l.id);

  const records: RecordParts[] = [];
  const recOrigIndex: (number | null)[] = [];
  const gAngle = globalLightAngle(b, L.resItems);
  let baked = 0, stripped = 0, bgConverted = 0, repaired = 0, retyped = 0, reinked = 0, turnedShapes = 0, resmart = 0;
  /** smart objects whose content was edited: linked-file entry id → the new embedded file */
  const smartReplace = new Map<string, LinkedData>();
  /** linked-file entries of smart objects made here (new records) */
  const newSmartEntries: Uint8Array[] = [];
  /** CMYK: the inks written for layers whose pixels were re-encoded (node id → planes), for the merged image */
  const inkLayers = new Map<string, LayerInks>();
  for (const p of plans) {
    if (p.kind === "newGroup") {
      const m = groupMarkers(p.group, psb)[p.end];
      const { parts } = newRecord(m.name, null, { visible: m.visible, opacity: m.opacity, blendMode: "NORMAL", locked: !!m.locked } as SceneNode, mode, depth, psb, ++maxId);
      parts.blocks.push(...(m.blocks ?? []));
      if (m.blendKey) parts.blend = m.blendKey;
      records.push(parts);
      recOrigIndex.push(null);
      continue;
    }
    if (p.kind === "new") {
      if (flatMode) continue;
      // a copied adjustment layer has no record of its own to write (its settings live in the original's blocks)
      // (an adjustment layer made here, or a copy of one whose kind is written here, gets a record of its own)
      if (p.node.type === "RASTER" && p.node.adjust) {
        const fresh = flatMode ? null : adjustRecord(p.node, mode, depth, psb, ++maxId);
        if (!fresh) {
          skipped.set(p.node.id, p.node.name);
          continue;
        }
        records.push(fresh);
        recOrigIndex.push(null);
        continue;
      }
      const px = await pixelsOf(p.node);
      if (skipped.has(p.node.id)) continue;
      const ty = textTyShBlock(p.node, psb);
      const name = p.node.type === "RASTER" || ty ? p.node.name : `${p.node.name} (래스터로 굳힘)`;
      // CMYK: a new layer's inks are split from its colour (a pasted or duplicated layer's original inks are not
      // known here): the notice counts the raster ones, the merged image composites these inks
      const inks = mode === 4 && px ? cmykLayerInks(px, null, 0, 0, xf) : null;
      if (inks) {
        inkLayers.set(p.node.id, inks);
        if (p.node.type === "RASTER" && inks.changed) reinked++;
      }
      const made = newRecord(name, px, p.node, mode, depth, psb, ++maxId, inks?.planes).parts;
      if (ty) made.blocks.unshift(ty);
      const so = newSmartParts(p.node, psb);
      if (so) {
        made.blocks.push(so.block);
        newSmartEntries.push(so.entry);
      }
      const ms = p.node.type === "RASTER" && depth !== 32 ? layerMaskSpec(p.node) : null;
      if (ms) {
        const mp = maskParts(ms, depth, psb);
        made.mask = mp.mask;
        made.channels.push(mp.channel);
      }
      records.push(made);
      recOrigIndex.push(null);
      continue;
    }
    const { rec, link, node, action } = p;
    recOrigIndex.push(rec.index);
    const parts: RecordParts = {
      top: rec.top,
      left: rec.left,
      bottom: rec.bottom,
      right: rec.right,
      channels: rec.channels.map((c) => ({ id: c.id, data: b.subarray(c.start, c.end) })),
      blend: rec.blend,
      opacity: rec.opacity,
      clipping: rec.clipping,
      flags: rec.flags,
      filler: rec.filler,
      mask: b.subarray(rec.mask.start, rec.mask.end),
      ranges: b.subarray(rec.ranges.start, rec.ranges.end),
      name: b.subarray(rec.name.start, rec.name.end),
      blocks: rec.blocks.map((k) => b.subarray(k.start, k.end)),
      tail: b.subarray(rec.tail.start, rec.tail.end),
    };
    if (p.group && action === "meta") {
      // folder header: name, opacity, eye, blend (record and section divider), lock
      const g = p.group;
      let blks = rec.blocks.map((k) => ({ key: k.key, raw: b.subarray(k.start, k.end) }));
      if (g.name !== link.name) {
        parts.name = pascalName(g.name);
        const i = blks.findIndex((k) => k.key === "luni");
        const nb = block("luni", luniData(g.name), psb);
        if (i >= 0) blks[i] = { key: "luni", raw: nb };
        else blks.unshift({ key: "luni", raw: nb });
      }
      if (g.opacity !== link.opacity) parts.opacity = Math.round(Math.max(0, Math.min(1, g.opacity)) * 255);
      if (g.visible !== link.visible) parts.flags = g.visible ? parts.flags & ~0x02 : parts.flags | 0x02;
      if (g.blendMode !== link.blend) {
        const key = BLEND_OUT[g.blendMode] ?? "pass";
        parts.blend = key;
        blks = blks.map((k) => {
          if (k.key !== "lsct" && k.key !== "lsdk") return k;
          const s = rec.blocks.find((x) => x.key === k.key)!;
          const type = (b[s.dataStart] << 24) | (b[s.dataStart + 1] << 16) | (b[s.dataStart + 2] << 8) | b[s.dataStart + 3];
          // keep a sub type (16-byte form) when present
          const data = lsctData(type >>> 0, key);
          if (s.dataEnd - s.dataStart >= 16) {
            const full = new Uint8Array(s.dataEnd - s.dataStart);
            full.set(b.subarray(s.dataStart, s.dataEnd));
            full.set(data.subarray(4, 12), 4);
            return { key: k.key, raw: block(k.key, full, psb) };
          }
          return { key: k.key, raw: block(k.key, data, psb) };
        });
      }
      if (g.locked !== link.locked) {
        const was = img.layers[rec.index]?.protect ?? 0;
        if (psdLocked(was) !== g.locked) {
          const i = blks.findIndex((k) => k.key === "lspf");
          const nb = block("lspf", u32be(g.locked ? (was | 0x80000000) >>> 0 : 0), psb);
          if (i >= 0) blks[i] = { key: "lspf", raw: nb };
          else blks.unshift({ key: "lspf", raw: nb });
        }
      }
      if (fxChanged(g.effects, link)) patchFxBlocks(blks, b, rec, g.effects, psb, gAngle, true);
      parts.blocks = blks.map((k) => k.raw);
      records.push(parts);
      continue;
    }
    // an adjustment layer whose settings or mask were changed here: written anew from them (psdAdjustWrite.ts)
    if (node?.adjust && (node.adjust.edited || rasterFingerprint(node) !== link.fp)) {
      const fresh = adjustRecord(node, mode, depth, psb, ++maxId);
      if (fresh) {
        records.push(fresh);
        continue;
      }
    }
    if (action === "keep" || !node) {
      records.push(parts);
      continue;
    }
    // ── metadata patches (blocks kept with their keys so later filters stay aligned)
    let blks = rec.blocks.map((k) => ({ key: k.key, raw: b.subarray(k.start, k.end) }));
    const replaceBlock = (key: string, data: Uint8Array) => {
      const i = blks.findIndex((k) => k.key === key);
      const nb = block(key, data, psb);
      if (i >= 0) blks[i] = { key, raw: nb };
      else blks.unshift({ key, raw: nb });
    };
    if (node.name !== link.name) {
      const own = recordName(b, rec);
      const prefix = link.name && link.name.endsWith(own) ? link.name.slice(0, link.name.length - own.length) : "";
      let name = prefix && node.name.startsWith(prefix) ? node.name.slice(prefix.length) : node.name;
      if (prefix && !node.name.startsWith(prefix) && node.name.includes(PSD_GROUP_SEP)) name = node.name.slice(node.name.lastIndexOf(PSD_GROUP_SEP) + PSD_GROUP_SEP.length);
      name = name || "레이어";
      parts.name = pascalName(name);
      replaceBlock("luni", luniData(name));
    }
    if (node.opacity !== link.opacity) {
      // (a document from before kept the fill multiplied into the opacity: node.fillOpacity absent)
      const fill = node.fillOpacity !== undefined ? 1 : (img.layers[rec.index]?.fill ?? 1) || 1;
      parts.opacity = Math.round(Math.max(0, Math.min(1, node.opacity / fill)) * 255);
    }
    if (node.visible !== link.visible) parts.flags = node.visible ? parts.flags & ~0x02 : parts.flags | 0x02;
    if (node.blendMode !== link.blend) parts.blend = BLEND_OUT[node.blendMode] ?? "norm";
    if (!!node.clip !== !!link.clip) parts.clipping = node.clip ? 1 : 0;
    if (node.locked !== link.locked) {
      const was = img.layers[rec.index]?.protect ?? 0;
      if (psdLocked(was) !== node.locked) replaceBlock("lspf", u32be(node.locked ? (was | 0x80000000) >>> 0 : 0));
    }
    // blending options changed here (the Layer Style dialog, the lock buttons): written as Photoshop keeps them
    if (link.opt !== undefined && blendOptionsKey(node) !== link.opt) {
      const was = img.layers[rec.index]?.protect ?? 0;
      replaceBlock("lspf", u32be(((was & ~0x80000007) | lockBits(node)) >>> 0));
      replaceBlock("iOpa", Uint8Array.from([Math.round(Math.max(0, Math.min(1, node.fillOpacity ?? 1)) * 255), 0, 0, 0]));
      replaceBlock("infx", u32be(node.fillInterior ? 0x01000000 : 0));
      replaceBlock("knko", u32be(node.knockout === "deep" ? 0x02000000 : node.knockout === "shallow" ? 0x01000000 : 0));
      const r = defaultRanges(colorCh);
      if (node.blendIf) r.set(node.blendIf.slice(0, r.length));
      parts.ranges = r;
    }
    if (halfBackground(b, rec)) {
      // a layer with transparency still carrying the Background lock (written so by an earlier version):
      // finish the conversion to an ordinary layer, which is what Photoshop needs to open the file
      parts.flags &= ~0x01;
      replaceBlock("lspf", u32be(node.locked ? 0x80000000 : 0));
      repaired++;
    }
    // edited effects: that record's effects block only, patched onto its own descriptor
    if (fxChanged(node.effects, link)) patchFxBlocks(blks, b, rec, node.effects, psb, gAngle);
    if (action === "meta") {
      // (an adjustment layer has no pixels: a pure move shifts its masks)
      const off = node.adjust ? (link.x !== undefined && link.y !== undefined && Number.isInteger(node.transform.x) && Number.isInteger(node.transform.y) ? { x: node.transform.x, y: node.transform.y } : null) : pixelOffset(node)!;
      const dx = off ? off.x - (link.x ?? rec.left) : 0, dy = off ? off.y - (link.y ?? rec.top) : 0;
      if (dx || dy || sizeChanged) shiftBlocks(blks, dx, dy);
      parts.blocks = blks.map((k) => k.raw);
      if (dx || dy) {
        parts.top += dy;
        parts.bottom += dy;
        parts.left += dx;
        parts.right += dx;
        if (rec.maskInfo) {
          const m = parts.mask.slice();
          const dv = new DataView(m.buffer);
          const shift = (at: number) => {
            if (at + 16 > m.length) return;
            dv.setInt32(at, dv.getInt32(at) + dy);
            dv.setInt32(at + 4, dv.getInt32(at + 4) + dx);
            dv.setInt32(at + 8, dv.getInt32(at + 8) + dy);
            dv.setInt32(at + 12, dv.getInt32(at + 12) + dx);
          };
          shift(0);
          if (rec.maskInfo.real) shift(rec.maskInfo.real.at + 2);
          parts.mask = m;
        }
      }
      records.push(parts);
      continue;
    }
    // ── pixels re-encoded
    const px = await pixelsOf(node);
    // a mask kept apart on import (link.mfp) is no baked mask: its channels go, the layer's own mask is written
    const unbaked = link.mfp !== undefined;
    const maskBaked = !unbaked && !!rec.maskInfo && rec.channels.some((c) => (c.id === -2 && !(rec.maskInfo!.flags & 2)) || (c.id === -3 && rec.maskInfo!.real && !(rec.maskInfo!.real.flags & 2)));
    const hadAlpha = rec.channels.some((c) => c.id === -1);
    const opaque = !!px && (() => {
      for (let i = 3; i < px.rgba.length; i += 4) if (px.rgba[i] !== 255) return false;
      return true;
    })();
    // Background layer rule: no transparency channel only for an opaque, canvas-sized bottom layer at 100 % Normal
    // (Photoshop turns a Background into an ordinary layer before its opacity or blend mode can change)
    const keepBackground =
      !hadAlpha && records.length === 0 && opaque && !!px && px.left === 0 && px.top === 0 && px.width === outW && px.height === outH && parts.opacity === 255 && parts.blend === "norm";
    // CMYK: pixels still the colour the record's channels read as keep their inks (wherever the layer moved); edited
    // ones get inks split from their screen colour (black = the grey part) — the colour shown is the same, the
    // original split of C, M, Y and K is not (the save notice says so)
    let inks: LayerInks | null = null;
    if (mode === 4 && px) {
      const off = pixelOffset(node);
      const orig = off ? layerCmykPlanes(L, rec) : null;
      inks = cmykLayerInks(px, orig, rec.left + (off ? off.x - (link.x ?? rec.left) : 0), rec.top + (off ? off.y - (link.y ?? rec.top) : 0), xf);
      inkLayers.set(node.id, inks);
      if (inks.changed) reinked++;
    }
    const po = pixelOffset(node);
    const ox = po ? rec.left + (po.x - (link.x ?? rec.left)) : null, oy = po ? rec.top + (po.y - (link.y ?? rec.top)) : null;
    const chans = depth === 32 && px ? floatChannels(L, rec, px, ox, oy, colorCh, psb, !keepBackground) : pixelChannels(px, mode, depth, psb, !keepBackground, inks?.planes ?? (grey && px ? [greyPlane(node, px)] : undefined), grey, px ? record16(L, rec, px, ox, oy) : undefined);
    if (depth === 32) hdrEdited++;
    if (depth === 16 && px) deepEdited++;
    if (!hadAlpha && !keepBackground) {
      // Background → ordinary layer: drop the background's transparency / position protection
      parts.flags &= ~0x01;
      if (blks.some((k) => k.key === "lspf")) replaceBlock("lspf", u32be(node.locked ? 0x80000000 : 0));
      bgConverted++;
    }
    if (maskBaked) {
      parts.mask = new Uint8Array(0);
      baked++;
    } else if (!node.mask && !unbaked) chans.push(...parts.channels.filter((c) => c.id < -1));
    else parts.mask = new Uint8Array(0);
    const ms = depth !== 32 ? layerMaskSpec(node) : null;
    if (ms) {
      const mp = maskParts(ms, depth, psb);
      parts.mask = mp.mask;
      chans.push(mp.channel);
    }
    parts.channels = chans;
    parts.top = px?.top ?? 0;
    parts.left = px?.left ?? 0;
    parts.bottom = px ? px.top + px.height : 0;
    parts.right = px ? px.left + px.width : 0;
    const shape = rec.blocks.some((k) => k.key === "vscg");
    const before = blks.length;
    // an edited text layer keeps its type block, rewritten with the new text, size, colour and origin
    const ty = p.text ? retypedTySh(b, rec, node, link, psb) : null;
    if (ty) {
      blks = blks.map((k) => (k.key === "TySh" ? { key: k.key, raw: ty } : k));
      retyped++;
    }
    const o = pixelOffset(node);
    // rotated / scaled (a straightened canvas crop, a free transform): a kept vector mask is mapped through the
    // layer's transform. A fill layer drawn by its vector mask (solid / gradient / pattern + vmsk, no vscg) stays a
    // shape layer, turned with it; its live-shape box (vogk) cannot hold a rotation and is dropped (a plain path shape)
    const turnable = !o && !node.crop && link.x !== undefined && link.y !== undefined && !maskBaked && !shape;
    const fillRec = rec.blocks.some((k) => FILL_KEYS.has(k.key)) && hasVectorMask(rec);
    const fillShape = turnable && fillRec;
    const live = blks.some((k) => k.key === "vogk");
    // an edited smart object keeps its placed-layer block: corners and content size set to the new content's
    let placedKept = false;
    if (p.smart && node.psdSmart?.edited) {
      const sm = node.psdSmart, e = sm.edited!;
      const fixed = blks.map((k) => {
        if (!PLACED_KEYS.has(k.key)) return k;
        const hdr = psb && LONG_KEYS.has(k.key) ? 16 : 12;
        let data: Uint8Array | null = placedWithCorners(k.raw.subarray(hdr), k.key, sm.quad);
        if (data && (k.key === "SoLd" || k.key === "SoLE")) data = placedWithSize(data, e.w, e.h) ?? data;
        return data ? { key: k.key, raw: block(k.key, data, psb) } : null;
      });
      const bytes = getBlob(e.hash);
      if (fixed.every(Boolean) && bytes) {
        blks = fixed as typeof blks;
        smartReplace.set(sm.id, { data: bytes, ...(e.name !== undefined ? { name: e.name } : {}), ...(e.fileType !== undefined ? { fileType: e.fileType } : {}) });
        placedKept = true;
        resmart++;
      }
    }
    blks = blks.filter((k) => !((CONTENT_KEYS.has(k.key) && !(ty && k.key === "TySh") && !(placedKept && PLACED_KEYS.has(k.key))) || (VECTOR_MASK_KEYS.has(k.key) && (maskBaked || shape)) || (!o && !turnable && fillRec && (FILL_KEYS.has(k.key) || VECTOR_MASK_KEYS.has(k.key)))));
    if (fillShape) {
      if (blks.length !== before - (live ? 1 : 0)) stripped++;
      turnedShapes++;
    } else if (blks.length !== before) stripped++;
    if (turnable) {
      // knots in the original canvas → the layer's local pixels → the page through its transform
      const lx = link.x!, ly = link.y!, tf = node.transform;
      for (let i = 0; i < blks.length; i++) {
        const k = blks[i];
        if (!VECTOR_MASK_KEYS.has(k.key)) continue;
        const data = mapVectorMask(k.raw.subarray(psb && LONG_KEYS.has(k.key) ? 16 : 12), (x, y) => applyTransform(tf, [x - lx, y - ly]), L.width, L.height, outW, outH);
        if (data) blks[i] = { key: k.key, raw: block(k.key, data, psb) };
      }
    } else {
      // a vector mask kept: its path follows the layer and the canvas (fractions of the canvas size)
      const dx = o && link.x !== undefined ? o.x - link.x : 0, dy = o && link.y !== undefined ? o.y - link.y : 0;
      if (dx || dy || sizeChanged) shiftBlocks(blks, dx, dy, VECTOR_MASK_KEYS);
    }
    parts.blocks = blks.map((k) => k.raw);
    records.push(parts);
  }
  if (skipped.size) warnings.push(`래스터로 바꿀 수 없어 빠진 개체 ${skipped.size}개: ${[...skipped.values()].slice(0, 5).join(", ")}`);
  if (baked) warnings.push(`픽셀을 고친 레이어 ${baked}개는 레이어 마스크를 픽셀에 합쳐 저장했습니다`);
  if (adjustMasks) warnings.push(`조정 레이어 ${adjustMasks}개의 마스크 편집·이동은 PSD에 저장되지 않아 원래 마스크·위치로 남습니다`);
  if (repaired) warnings.push("배경 잠금이 남아 있던 투명 레이어를 일반 레이어로 고쳐 저장했습니다 (PSD 편집 프로그램이 쓰지 않는 조합)");
  if (bgConverted) warnings.push("배경 레이어를 옮기거나 다른 레이어를 아래에 두어 일반 레이어(투명도 포함)로 저장했습니다");
  // a flat CMYK file whose image was edited: the same rule against the original merged image's inks
  if (mode === 4 && flatMode && visual) {
    const fn = nodes[0] as RasterNode;
    const px = await pixelsOf(fn);
    if (px) {
      const off = pixelOffset(fn);
      const n = L.width * L.height;
      const raw = off ? readCompositePlanes(L, 4).map((p) => to8(p, n, depth)) : null;
      const inks = cmykLayerInks(px, raw ? { c: raw[0], m: raw[1], y: raw[2], k: raw[3], w: L.width, h: L.height } : null, off?.x ?? 0, off?.y ?? 0, xf);
      inkLayers.set(fn.id, inks);
      if (inks.changed) reinked++;
    }
  }
  if (reinked) warnings.push(`CMYK 문서에서 새로 넣었거나 픽셀을 고친 레이어 ${reinked}개는 새 픽셀·바뀐 픽셀의 잉크(C·M·Y·K)를 화면 색에서 다시 나눠 저장했습니다 (검정 = 회색 성분) — 보이는 색은 같지만 그 픽셀의 원래 잉크 비율은 바뀝니다. 바뀌지 않은 픽셀과 고치지 않은 레이어의 잉크는 그대로입니다`);
  if (stripped) warnings.push(`픽셀을 고친 텍스트·고급 개체·모양 레이어 ${stripped}개는 래스터 레이어로 저장했습니다`);
  if (resmart) warnings.push(t("engine.psdsmart.resaved", { n: resmart }));
  if (turnedShapes) warnings.push(`돌리거나 크기를 바꾼 모양 레이어 ${turnedShapes}개는 벡터 마스크를 함께 돌려 모양 레이어로 저장했습니다 (라이브 모양 속성은 일반 패스로)`);
  if (hdrEdited) warnings.push(`32비트(HDR) 문서에서 픽셀을 고친 레이어 ${hdrEdited}개: 바뀌지 않은 픽셀은 원래 값(흰색을 넘는 빛 포함) 그대로, 고친 픽셀은 화면의 8비트 값으로 저장했습니다`);
  if (deepEdited) warnings.push(t("engine.psd16.saved", { n: deepEdited }));

  // ── merged image
  const outAlpha = img.compositeAlpha;
  let extra: Uint8Array[] = [];
  const extraCount = L.channels - colorCh - (outAlpha ? 1 : 0);
  let dropAlphaRes = false;
  if (extraCount > 0) {
    if (sizeChanged) dropAlphaRes = true;
    else if (visual) extra = readCompositePlanes(L, L.channels).slice(colorCh + (outAlpha ? 1 : 0));
  }
  // 16 bits: the merged image's unchanged pixels keep their original 16-bit samples (widen16), same canvas only
  let comp16: Uint8Array[] | null = null;
  // (not Photoshop's placeholder of a file saved without 'Maximize compatibility')
  if (visual && depth === 16 && !sizeChanged && L.image.end - L.image.start >= 2 && hasRealMergedData(L))
    try {
      comp16 = readCompositePlanes(L, Math.min(L.channels, colorCh + (outAlpha ? 1 : 0)));
    } catch {
      comp16 = null;
    }
  const deepComp = (p: Uint8Array, k: number, unreached?: Uint8Array) => widen16(p, comp16?.[k] && comp16[k].length === p.length * 2 ? { o16: comp16[k], at: (i) => i, ...(unreached ? { keep: (i: number) => unreached[i] === 1 } : {}) } : null);
  let imageData: Uint8Array;
  if (!visual) imageData = b.subarray(L.image.start, L.image.end);
  else if (mode === 4) {
    // a CMYK document: composited on the inks as Photoshop does (and as the screen shows it) and written as those
    // inks — not from the converted RGB, where multiply, see-through layers, adjustments and effects differ and the
    // black split of every pixel would be made anew. Unchanged layers bring the file's channels (by tile), re-encoded
    // layers the inks just written, anything else (a layer drawn by another way) its colour as C, M, Y.
    const groups = modelDriven ? page.groups : undefined;
    const store = cmykStoreOf(doc, page) ?? new Map<string, Uint8Array>();
    const byTiles = (n: SceneNode) => n.type === "RASTER" && (!!n.adjust || !!pixelOffset(n));
    for (const n of nodes) if (n.visible && n.opacity > 0 && !inkLayers.has(n.id) && !byTiles(n)) await pixelsOf(n);
    const seps = new Map<string, LayerInks["planes"]>();
    const own: InkPixels = (n, pass, X0, Y0, rw, rh) => {
      const ink = inkLayers.get(n.id);
      if (ink) return inkPass(ink.px, pass === "cmy" ? ink.planes : [ink.planes[3], ink.planes[3], ink.planes[3]], X0, Y0, rw, rh);
      if (byTiles(n)) return undefined;
      const px = pxCache.get(n.id);
      if (!px) return null;
      if (xf) {
        // drawn another way (rotated, vector …): its colour through the profile's separation
        let sep = seps.get(n.id);
        if (!sep) seps.set(n.id, (sep = cmykLayerInks(px, null, 0, 0, xf).planes));
        return inkPass(px, pass === "cmy" ? sep.slice(0, 3) : [sep[3], sep[3], sep[3]], X0, Y0, rw, rh);
      }
      if (pass === "cmy") return inkPass(px, null, X0, Y0, rw, rh);
      const k = new Uint8Array(px.width * px.height).fill(255);
      return inkPass(px, [k, k, k], X0, Y0, rw, rh);
    };
    const [cmy, k] = composeInkPlanes({ nodes: groups ? contiguousOrder(nodes, groups) : nodes, groups, source: page.source }, 0, 0, outW, outH, store, own);
    const n = outW * outH;
    const planes = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    const alpha = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = cmy[i * 4 + 3];
      const v = [cmy[i * 4], cmy[i * 4 + 1], cmy[i * 4 + 2], k[i * 4]];
      // no transparency in the file's merged image: over white, which is no ink (255); with it, a fully transparent
      // pixel holds no ink either (not the compositor's 0 = full ink, which a reader ignoring the alpha would print)
      for (let c = 0; c < 4; c++) planes[c][i] = !a ? 255 : outAlpha ? v[c] : Math.round((v[c] * a) / 255 + 255 * (1 - a / 255));
      alpha[i] = a;
    }
    const all = [...planes, ...(outAlpha ? [alpha] : [])].map((p, k) => (depth === 16 ? deepComp(p, k) : p));
    imageData = encodeImageData([...all, ...extra], outW, outH, depth / 8, psb);
  } else {
    let rgba: Uint8Array;
    // a duotone blends its grey (the ink amount), as Photoshop does: the layers' screen colours back to grey first,
    // composited as grey, written as that grey (not the colours blended and turned back)
    const greyPx = async (n: SceneNode): Promise<LayerPixels | null> => {
      const px = await pixelsOf(n);
      if (!px || !grey) return px;
      const g = new Uint8Array(px.rgba.length);
      const lv = greyPlane(n, px);
      for (let i = 0; i < g.length; i += 4) {
        g[i] = g[i + 1] = g[i + 2] = lv[i >> 2];
        g[i + 3] = px.rgba[i + 3];
      }
      return { ...px, rgba: g };
    };
    const composeRgba = async (ns: SceneNode[], groups: LayerGroup[] | undefined, md: boolean, pxOf0: (n: SceneNode) => Promise<LayerPixels | null>): Promise<Uint8Array> => {
      // a layer with a mask shows through it (the record holds every pixel and the mask)
      const pxOf = async (n: SceneNode) => (n.type === "RASTER" && n.mask && !n.mask.off && !n.adjust ? shownPixels(n) : pxOf0(n));
      let out: Uint8Array;
      if (depth === 32 || hasStructure(ns, md ? groups : undefined) || ns.some((n) => n.visible && (n.effects?.length || (n.type === "RASTER" && n.adjust) || (n.fillOpacity ?? 1) < 1 || !!n.blendIf)) || (md && !!groups?.some((g) => g.effects?.length))) {
        // groups / clipping / layer effects / fill below 100 % / Blend If: Photoshop's compositing of the tree (effects drawn, as
        // Photoshop shows them; the fill as core/style/blend.ts fillParts)
        const got = new Map<string, LayerPixels | null>();
        for (const n of ns) if (n.visible && n.opacity > 0) got.set(n.id, await pxOf(n));
        // (in the order the records are written: a group's members together — a layer the model kept between them is
        // drawn where its record goes, as Photoshop and the reopened file draw it: ps_layers_groups-delmove)
        const order = md ? contiguousOrder(ns, groups) : ns;
        // 32-bit: tiles still as read keep their light past white (cmykComposite.ts linearStoreOf) when every layer is
        // a plain raster at whole pixels; otherwise the 8-bit view of each layer, composited in linear light
        const plain = order.every((n) => !n.visible || (n.type === "RASTER" && !n.crop && !n.transform.rotation && n.transform.scale === 1 && (n.transform.scaleY ?? 1) === 1 && Number.isInteger(n.transform.x) && Number.isInteger(n.transform.y)));
        if (depth === 32 && plain && !sizeChanged) out = composeRegion(order, md ? groups : undefined, 0, 0, outW, outH, linearStoreOf(b, page), page);
        else out = compositeTree(order, md ? groups : undefined, (n) => got.get(n.id) ?? null, outW, outH, undefined, depth === 32);
      } else {
        const comp: CompLayer[] = [];
        for (const n of ns) {
          if (!n.visible || n.opacity <= 0) continue;
          const px = await pxOf(n);
          if (px) comp.push({ px, opacity: n.opacity, blend: n.blendMode });
        }
        out = compositeLayers(comp, outW, outH);
      }
      if (!outAlpha) flattenOverWhite(out);
      return out;
    };
    rgba = await composeRgba(nodes, page.groups, modelDriven, greyPx);
    const n = outW * outH;
    // 16 bits: a pixel this compositing draws as it drew the file before the edits (the original layers composited
    // the same way) is one the edits did not reach — it keeps Photoshop's own 16-bit merged sample, even where our
    // compositing is a level away from Photoshop's; the others are widened from it (widen16)
    let unreached: Uint8Array[] | null = null;
    if (depth === 16 && comp16) {
      try {
        const P0 = importPsdPage(b, "orig.psd", "orig", null);
        const hidden0 = P0.page.source?.psd?.compositeNode;
        const n0 = P0.page.nodes.filter((x) => x.id !== hidden0);
        const greyOf0 = async (x: SceneNode): Promise<LayerPixels | null> => {
          const px = x.type === "RASTER" ? rasterPixels(x) : null;
          if (!px || !grey) return px;
          const g = new Uint8Array(px.rgba.length);
          for (let i = 0; i < g.length; i += 4) {
            g[i] = g[i + 1] = g[i + 2] = grey(px.rgba[i], px.rgba[i + 1], px.rgba[i + 2]);
            g[i + 3] = px.rgba[i + 3];
          }
          return { ...px, rgba: g };
        };
        const c0 = await composeRgba(n0, P0.page.groups, !!P0.page.source?.psd?.layers.some((l) => l.group), greyOf0);
        const p0 = [...colourPlanes(c0, n, mode, 8), ...(outAlpha ? [alphaPlane(c0, n, 8)] : [])];
        const p1 = [...colourPlanes(rgba, n, mode, 8), ...(outAlpha ? [alphaPlane(rgba, n, 8)] : [])];
        unreached = p1.map((p, k) => {
          const u = new Uint8Array(n);
          for (let i = 0; i < n; i++) u[i] = p[i] === p0[k][i] ? 1 : 0;
          return u;
        });
      } catch {
        unreached = null;
      }
    }
    const planes =
      depth === 16
        ? [...[...colourPlanes(rgba, n, mode, 8), ...(outAlpha ? [alphaPlane(rgba, n, 8)] : [])].map((p, k) => deepComp(p, k, unreached?.[k])), ...extra]
        : [...colourPlanes(rgba, n, mode, depth), ...(outAlpha ? [alphaPlane(rgba, n, depth)] : []), ...extra];
    imageData = encodeImageData(planes, outW, outH, depth / 8, psb);
  }
  // an unchanged merged image keeps the original header's channel count (no need to decode its extra planes)
  const outChannels = visual ? colorCh + (outAlpha ? 1 : 0) + extra.length : L.channels;

  // ── image resources (per-layer arrays follow the new record order; stale thumbnails dropped)
  const structural = !origOrder;
  let resources: Uint8Array = b.subarray(L.resources.start, L.resources.end);
  if (structural || visual || dropAlphaRes || sizeChanged) {
    const ro = new Out();
    const count = L.records.length;
    for (const it of L.resItems) {
      const raw = b.subarray(it.start, it.end);
      const dataLen = it.dataEnd - it.dataStart;
      if (visual && (it.id === 1036 || it.id === 1033)) continue;
      if (dropAlphaRes && [1006, 1045, 1053, 1077].includes(it.id)) continue;
      // slices are canvas rectangles: Photoshop makes the default slice anew
      if (sizeChanged && it.id === 1050) continue;
      const per = it.id === 1026 ? 2 : it.id === 1072 ? 1 : 0;
      if (structural && per && dataLen === count * per) {
        const data = new Uint8Array(records.length * per);
        recOrigIndex.forEach((oi, k) => {
          if (oi !== null) data.set(b.subarray(it.dataStart + oi * per, it.dataStart + (oi + 1) * per), k * per);
          else if (per === 1) data[k] = 1;
        });
        ro.bytes(b.subarray(it.start, it.dataStart - 4));
        ro.u32(data.length);
        ro.bytes(data);
        if (data.length % 2) ro.u8(0);
        continue;
      }
      if (structural && it.id === 1024 && dataLen === 2) {
        const v = (b[it.dataStart] << 8) | b[it.dataStart + 1];
        ro.bytes(b.subarray(it.start, it.dataStart));
        ro.u16(Math.max(0, Math.min(v, records.length - 1)));
        continue;
      }
      ro.bytes(raw);
    }
    if (L.resItems.length && L.resItems[L.resItems.length - 1].end < L.resources.end) ro.bytes(b.subarray(L.resItems[L.resItems.length - 1].end, L.resources.end));
    resources = ro.done();
  }
  // saved paths (the 패스 panel): the file's path resources replaced by the page's (unchanged ones are written the same)
  {
    const key = (ps: readonly { name: string; contours: unknown }[]) => JSON.stringify(ps.map((p) => [p.name, p.contours]));
    const same = !sizeChanged && key(page.paths ?? []) === key(readPaths(b, L.resItems, L.width, L.height, () => ""));
    if (!same) resources = replacePathResources(resources, page.paths ?? [], outW, outH);
  }
  // ruler guides (resource 1032): the page's, when they differ from the file's
  if (guidesChanged) resources = replaceGuidesResource(resources, page.guides);

  // ── layer and mask information
  const count = (L.mergedAlpha || (!L.records.length && outAlpha) ? -1 : 1) * records.length;
  const content = records.length ? layerInfoContent(records, count, psb) : new Uint8Array(0);
  const lm = new Out();
  const where = L.layerInfo?.where ?? (depth === 16 && records.length ? "Lr16" : "main");
  if (where === "main") {
    lm.len(content.length, psb);
    lm.bytes(content);
  } else {
    lm.len(L.mainLayerInfo.end - L.mainLayerInfo.start, psb);
    lm.bytes(b.subarray(L.mainLayerInfo.start, L.mainLayerInfo.end));
  }
  if (L.globalMask) {
    lm.u32(L.globalMask.end - L.globalMask.start);
    lm.bytes(b.subarray(L.globalMask.start, L.globalMask.end));
  } else lm.u32(0);
  let placed = where === "main";
  const smartAfter = records.flatMap((r) => r.blocks.filter((raw) => raw.length >= 8 && SMART_KEYS.has(String.fromCharCode(raw[4], raw[5], raw[6], raw[7]))));
  // smart objects made here: their entries join the file's lnk2 block (or a new one)
  let newLinksPlaced = !newSmartEntries.length;
  const lmPut = lm.bytes.bind(lm);
  const lnkOut = (raw: Uint8Array, key: string, long: boolean) => {
    if (newLinksPlaced || key !== "lnk2") return lmPut(raw);
    const hdr = long ? 16 : 12;
    lmPut(block("lnk2", concatBytes([raw.subarray(hdr), ...newSmartEntries]), psb));
    newLinksPlaced = true;
  };
  for (const blk of L.globalBlocks) {
    if (opts.dropContentCredentials && blk.key === "CAI ") continue;
    // the document-wide text engine copy (Txt2) is what Photoshop reads first: after a text edit it would bring the
    // old text back, so it goes and Photoshop rebuilds it from every layer's own TySh (docs/design/PSD_TEXT.md)
    if (retyped && blk.key === "Txt2") continue;
    if (LINK_KEYS.has(blk.key) && smartReplace.size) {
      // an edited smart object's new content goes into its entry (orphans pruned as below)
      const prune = opts.pruneLinkedFiles !== false;
      const rb = rebuildLinkedBlock(b, blk, psb, smartReplace, prune ? (id) => mentions(smartAfter, id) : undefined);
      if (rb && (rb.replaced || rb.dropped)) {
        lnkOut(rb.bytes, blk.key, psb && LONG_KEYS.has(blk.key));
        if (rb.dropped) warnings.push("어떤 고급 개체도 쓰지 않는 연결 파일 데이터를 정리했습니다");
        continue;
      }
    }
    if (LINK_KEYS.has(blk.key) && opts.pruneLinkedFiles !== false) {
      const pruned = pruneLinks(b, blk, smartAfter);
      if (pruned) {
        lnkOut(pruned, blk.key, psb && LONG_KEYS.has(blk.key));
        warnings.push("어떤 고급 개체도 쓰지 않는 연결 파일 데이터를 정리했습니다");
        continue;
      }
    }
    if (L.layerInfo?.block && blk.start === L.layerInfo.block.start) {
      lm.str(blk.sig);
      lm.str(blk.key);
      lm.len(content.length, blk.long);
      lm.bytes(content);
      placed = true;
      continue;
    }
    if (LINK_KEYS.has(blk.key)) lnkOut(b.subarray(blk.start, blk.end), blk.key, psb && LONG_KEYS.has(blk.key));
    else lm.bytes(b.subarray(blk.start, blk.end));
  }
  if (!newLinksPlaced) lm.bytes(block("lnk2", concatBytes(newSmartEntries), psb));
  if (!placed && records.length) lm.bytes(block(where, content, psb));
  lm.bytes(b.subarray(L.globalTail.start, L.globalTail.end));
  const lmBytes = lm.done();

  // ── assemble
  const o = new Out();
  const header = b.slice(0, 26);
  const hv = new DataView(header.buffer);
  hv.setUint16(12, outChannels);
  hv.setUint32(14, outH);
  hv.setUint32(18, outW);
  o.bytes(header);
  o.u32(L.colorData.end - L.colorData.start);
  o.bytes(b.subarray(L.colorData.start, L.colorData.end));
  o.u32(resources.length);
  o.bytes(resources);
  o.len(lmBytes.length, psb);
  o.bytes(lmBytes);
  o.bytes(imageData);
  return { bytes: o.done(), method: "surgery", warnings };
}

// ───────── pre-save check (what Photoshop is strict about) ─────────

export interface PsdExpect {
  width: number;
  height: number;
  depth: number;
  mode: number;
  psb: boolean;
}

/**
 * Structural checklist run on every file before it is handed back for saving. Returns the problems found
 * (empty = OK): header unchanged, section lengths add up, layer count = records, every channel's length matches
 * its rectangle and compression, the Background-layer rule, balanced groups, per-layer resources (1024/1026/1072)
 * consistent with the layer count, and the merged image's RLE table matching its data.
 */
export function checkPsd(bytes: Uint8Array, expect: PsdExpect | null): string[] {
  const problems: string[] = [];
  let L: PsdLayout;
  try {
    L = parsePsdLayout(bytes);
  } catch (e: any) {
    return [`구조를 다시 읽을 수 없음: ${e?.message ?? e}`];
  }
  if (expect) {
    if (L.width !== expect.width || L.height !== expect.height) problems.push(`헤더 크기 ${L.width}×${L.height} ≠ 원본 ${expect.width}×${expect.height}`);
    if (L.depth !== expect.depth || L.mode !== expect.mode || L.psb !== expect.psb) problems.push("헤더 비트 깊이·색상 모드·버전이 원본과 다름");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorCh = colorChannels(L.mode);
  const bpc = L.depth === 1 ? 1 : L.depth / 8;
  const cs = L.psb ? 4 : 2;
  const rowTableSum = (at: number, rows: number) => {
    let s = 0;
    for (let y = 0; y < rows; y++) s += L.psb ? dv.getUint32(at + y * 4) : dv.getUint16(at + y * 2);
    return s;
  };
  const n = L.records.length;
  if (L.layerInfo) {
    const last = L.records.flatMap((r) => r.channels).reduce((m, c) => Math.max(m, c.end), L.layerInfo.content.start);
    if (last > L.layerInfo.content.end) problems.push("레이어 채널 데이터가 레이어 정보 구역을 넘음");
  }
  L.records.forEach((r, i) => {
    const ids = r.channels.map((c) => c.id);
    if (new Set(ids).size !== ids.length) problems.push(`레이어 ${i}: 채널 id 중복`);
    for (let c = 0; c < colorCh; c++) if (!ids.includes(c)) problems.push(`레이어 ${i}: 색 채널 ${c} 없음`);
    const w = r.right - r.left, h = r.bottom - r.top;
    // Background layer: Photoshop writes it as {no transparency channel, flags bit 0, lspf 0xD}, bottom, canvas-sized.
    // A record carrying only part of that signature (e.g. alpha + background lock) is what Photoshop refused.
    // (lspf bit 3 alone is the user's "prevent auto-nesting" lock — valid on any layer, not checked)
    if (isHalfBackground(bytes, r, i)) problems.push(`레이어 ${i}: 배경 잠금(lspf 0xD)이 있는데 투명도 채널이 있음`);
    if (!ids.includes(-1) || isHalfBackground(bytes, r, i)) {
      if (i !== 0 || r.left !== 0 || r.top !== 0 || w !== L.width || h !== L.height) problems.push(`레이어 ${i}: 배경 레이어(투명도 채널 없음·배경 잠금)는 캔버스 크기의 맨 아래 레이어여야 함`);
    }
    if (ids.includes(-2) && !r.maskInfo) problems.push(`레이어 ${i}: 마스크 채널은 있는데 마스크 정보가 없음`);
    if (ids.includes(-3) && !r.maskInfo?.real) problems.push(`레이어 ${i}: 실제 마스크 채널은 있는데 정보가 없음`);
    if ((r.ranges.end - r.ranges.start) % 8) problems.push(`레이어 ${i}: 혼합 범위 길이가 8의 배수가 아님`);
    for (const c of r.channels) {
      const box = c.id === -2 ? r.maskInfo : c.id === -3 ? r.maskInfo?.real : null;
      const cw = box ? box.right - box.left : w, ch = box ? box.bottom - box.top : h;
      const len = c.end - c.start;
      if (len < 2) {
        problems.push(`레이어 ${i} 채널 ${c.id}: 압축 방식 없음`);
        continue;
      }
      const comp = dv.getUint16(c.start);
      if (cw <= 0 || ch <= 0) {
        if (comp > 3) problems.push(`레이어 ${i} 채널 ${c.id}: 압축 방식 ${comp}`);
        continue;
      }
      if (comp === 0 && len !== 2 + cw * ch * bpc) problems.push(`레이어 ${i} 채널 ${c.id}: 무압축 길이 ${len} ≠ ${2 + cw * ch * bpc}`);
      else if (comp === 1) {
        if (len < 2 + ch * cs) problems.push(`레이어 ${i} 채널 ${c.id}: RLE 행 표가 잘림`);
        else if (2 + ch * cs + rowTableSum(c.start + 2, ch) !== len) problems.push(`레이어 ${i} 채널 ${c.id}: RLE 행 길이 합이 채널 길이와 다름`);
      } else if (comp > 3) problems.push(`레이어 ${i} 채널 ${c.id}: 압축 방식 ${comp}`);
    }
  });
  // linked files (lnk2 / lnk3 / lnkD): every entry must belong to a live smart object
  const live = L.records.flatMap((r) => r.blocks.filter((k) => SMART_KEYS.has(k.key)).map((k) => bytes.subarray(k.dataStart, k.dataEnd)));
  for (const blk of L.globalBlocks) {
    if (!LINK_KEYS.has(blk.key)) continue;
    const entries = linkEntries(bytes, blk);
    const orphans = entries ? entries.filter((e) => !mentions(live, e.id)).length : 0;
    if (orphans) problems.push(`연결 파일(${blk.key}) ${orphans}개를 쓰는 고급 개체가 없음`);
  }
  // groups: dividers (3) open, folders (1/2) close, bottom → top
  let depthG = 0;
  for (const r of L.records) {
    const t = sectionType(bytes, r);
    if (t === 3) depthG++;
    else if (t === 1 || t === 2) {
      if (--depthG < 0) {
        problems.push("그룹 표시 짝이 맞지 않음");
        depthG = 0;
      }
    }
  }
  if (depthG) problems.push("닫히지 않은 그룹 표시");
  for (const it of L.resItems) {
    const len = it.dataEnd - it.dataStart;
    if (it.id === 1026 && n && len !== 2 * n) problems.push(`리소스 1026 길이 ${len} ≠ 레이어 ${n}×2`);
    if (it.id === 1072 && n && len !== n) problems.push(`리소스 1072 길이 ${len} ≠ 레이어 ${n}`);
    if (it.id === 1024 && n && len === 2 && dv.getUint16(it.dataStart) >= n) problems.push("리소스 1024 대상 레이어 번호가 레이어 수를 넘음");
  }
  // merged image
  const img = L.image;
  if (img.end - img.start < 2) problems.push("합쳐진 이미지 없음");
  else {
    const comp = dv.getUint16(img.start);
    const rowBytes = L.depth === 1 ? Math.ceil(L.width / 8) : L.width * bpc;
    const rows = L.channels * L.height;
    if (comp === 0 && img.end - img.start < 2 + rows * rowBytes) problems.push("합쳐진 이미지 데이터가 짧음");
    else if (comp === 1) {
      if (img.end - img.start < 2 + rows * cs) problems.push("합쳐진 이미지 RLE 행 표가 잘림");
      else if (2 + rows * cs + rowTableSum(img.start + 2, rows) > img.end - img.start) problems.push("합쳐진 이미지 RLE 데이터가 짧음");
    } else if (comp > 3) problems.push(`합쳐진 이미지 압축 방식 ${comp}`);
  }
  return problems;
}

/**
 * Refuse to hand back a file that fails checkPsd. Problems the original already had are not counted — except
 * orphaned linked files, which every rewrite removes (Photoshop refuses a file that keeps them).
 */
function guard(r: PsdWriteResult, expect: PsdExpect | null, original?: Uint8Array): PsdWriteResult {
  if (r.method === "original") return r;
  const before = new Set((original ? checkPsd(original, null) : []).filter((p) => !p.startsWith("연결 파일(")));
  const problems = checkPsd(r.bytes, expect).filter((p) => !before.has(p));
  if (problems.length) throw new Error(`PSD 저장 전 검사에서 문제가 발견되어 저장하지 않았습니다 (원본 파일은 그대로입니다): ${problems.slice(0, 6).join(" / ")}`);
  return r;
}
