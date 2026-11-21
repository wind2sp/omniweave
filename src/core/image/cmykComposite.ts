// CMYK documents composited the way Photoshop does — one implementation for the PSD score (core/fidelity/psdScore.ts),
// the screen (render/cmykView.ts) and the pictures exports make (PNG, image PDF, vector PDF, slide show).
//
// Photoshop blends a CMYK document channel by channel on the stored values (255 = no ink) with the RGB formulas
// (omni-fid-cmyk-blend, -mode-*: every channel within 3 levels of Photoshop). So the layer tree is composited by the
// pixel compositor (core/image/softComposite.ts compositeInks) on two planes side by side — (C, M, Y) and (K) — and
// the result converted as the reader converts a layer (io/formats/psd.ts cmykToRgba). Multiply, screen, overlay …
// then differ from blending the converted RGB colours; Normal at full opacity does not. An adjustment layer sees all
// four channels (core/image/adjustLayer.ts inkFnOf), effects draw their CMYK colours per plane (`inkEffects`), and
// darker / lighter colour compare whole CMYK colours.
//
// The CMYK channels of a layer are kept per pixel tile, keyed by the hash of the RGB tile the import made from them
// (`CmykTiles`): a tile the user has not changed finds its channels by content, wherever its layer moved; a changed
// or new tile has none and is read back from its RGB (C, M, Y = R, G, B with no black ink: exact for the reader's
// conversion). Only tiles with black ink are stored — without black the RGB tile already says everything.

import { compositeInks, compositeTree, type PlacedPixels } from "./softComposite";
import { linearToSrgb as encodeSrgb, srgbToLinear } from "./adjust";
import { cmykToRgba, readChannelPlane, duotoneGrey, duotoneLut, importPsdPage, layerCmykPlanes, parsePsdLayout, psdCmykProfile, type GreyOf } from "../../io/formats/psd";
import type { CmykXform } from "./iccCmyk";
import { getBlob } from "../assets";
import { pageEffectReach } from "../loom";
import { rgbColor, rgbaOf } from "../style/color";
import { hasEffects } from "../style/effects";
import type { Color, Effect, Paint } from "../style/types";
import { fidelityWorker } from "../fidelity/run";
import { TILE, isBlank, makeTile } from "../tile";
import { newRaster, type LayerGroup, type OmwDocument, type Page, type RasterNode, type SceneNode } from "../types";

/**
 * One PSD file's black-ink tiles: RGB tile hash → (C, M, Y, K) stored bytes, TILE × TILE × 4. A colour-managed file
 * (its profile: `cmykXformOf`) keeps every tile — its RGB no longer gives the inks back.
 */
export type CmykTiles = Map<string, Uint8Array>;

/** The colour profile of the file a store was read from (psd.ts psdCmykProfile), null: colour-unmanaged. */
const storeXforms = new WeakMap<CmykTiles, CmykXform | null>();
export const cmykXformOf = (store: CmykTiles | null | undefined): CmykXform | null => (store ? storeXforms.get(store) ?? null : null);
/** Tie a store to its file's profile (the store read in a worker comes back without it). */
function withXform(store: CmykTiles | null, bytes: Uint8Array): CmykTiles | null {
  if (store) storeXforms.set(store, psdCmykProfile(bytes).xf);
  return store;
}

/**
 * A 32-bit (HDR) document goes the same way with a "store" that holds no channels, only the mark that its page is
 * composited in linear light, as Photoshop composites its floats (softComposite.ts compositeTree `linear`): blends,
 * opacity and soft edges differ from blending the sRGB colours (omni-fid-32bit-*). Read only, so no ink planes.
 */
const linearStores = new WeakSet<CmykTiles>();
export function linearStore(): CmykTiles {
  const s: CmykTiles = new Map();
  linearStores.add(s);
  return s;
}

/**
 * A 32-bit document's store with the light past white kept: for every layer tile holding a colour above 1, its
 * floats (TILE × TILE × (R, G, B), linear, as the bytes of a Float32Array) keyed by the tile's hash — so multiply,
 * opacity and the blends see what Photoshop sees, not the 8-bit view clipped at white (omni-fid-32bit-hdr). A pixel
 * keeps its floats only while it still reads as them (an edited sample: NaN, decoded from its 8 bits).
 */
export function linearStoreOf(bytes: Uint8Array, page: CmykKeyPage): CmykTiles {
  const s = linearStore();
  let L: ReturnType<typeof parsePsdLayout>;
  try {
    L = parsePsdLayout(bytes);
  } catch {
    return s;
  }
  if (L.depth !== 32 || L.mode !== 3) return s;
  const links = page.source?.psd?.layers ?? [];
  const byId = new Map(page.nodes.map((n) => [n.id, n]));
  links.forEach((l, i) => {
    const n = l.node ? byId.get(l.node) : undefined;
    const rec = L.records[i];
    if (!n || n.type !== "RASTER" || n.adjust || !rec) return;
    const w = rec.right - rec.left, h = rec.bottom - rec.top;
    if (w <= 0 || h <= 0 || w * h > 50_000_000) return;
    const ch = [0, 1, 2].map((id) => rec.channels.find((c) => c.id === id));
    if (ch.some((c) => !c)) return;
    let planes: DataView[];
    try {
      planes = ch.map((c) => {
        const p = readChannelPlane(bytes, c!.start, c!.end, w, h, 4, L.psb);
        return new DataView(p.buffer, p.byteOffset, p.byteLength);
      });
    } catch {
      return;
    }
    for (const [key, t] of Object.entries(n.tiles)) {
      const u = key.indexOf("_"), tx = +key.slice(0, u), ty = +key.slice(u + 1);
      const f = new Float32Array(TILE * TILE * 3);
      let hot = false;
      f.fill(NaN);
      for (let y = 0; y < TILE; y++) {
        const ry = ty * TILE + y;
        if (ry >= h) break;
        for (let x = 0; x < TILE; x++) {
          const rx = tx * TILE + x;
          if (rx >= w) break;
          const o = (y * TILE + x) * 4;
          if (!t.data[o + 3]) continue;
          // a sample still as the reader showed it keeps its float; an edited one (NaN) is decoded from its 8 bits —
          // channel by channel, as the writer keeps them (psdWrite.ts floatChannels)
          for (let c = 0; c < 3; c++) {
            const v = planes[c].getFloat32((ry * w + rx) * 4);
            if ((!(v > 0) ? 0 : v >= 1 ? 255 : Math.round(encodeSrgb(v) * 255)) !== t.data[o + c]) continue;
            if (v > 1) hot = true;
            f[(y * TILE + x) * 3 + c] = Math.max(0, v);
          }
        }
      }
      if (hot) s.set(t.hash, new Uint8Array(f.buffer));
    }
  });
  return s;
}
export const isLinearStore = (s: CmykTiles | null | undefined): boolean => !!s && linearStores.has(s);

/**
 * A duotone (mode 8) likewise: a "store" with no channels, holding the grey → colour table (psd.ts duotoneLut). Its
 * layers are composited as their grey — the ink amount Photoshop blends — and only the result coloured, so multiply,
 * opacity and soft edges come out as in Photoshop's merged image (omni-fid-duotone-layers).
 */
const duoStores = new WeakMap<CmykTiles, { lut: Uint8Array; grey: GreyOf }>();
export function duotoneStore(lut: Uint8Array): CmykTiles {
  const s: CmykTiles = new Map();
  duoStores.set(s, { lut, grey: duotoneGrey(lut)! });
  return s;
}

/** Bits per channel of PSD / PSB bytes, 0 when not a PSD. */
export function psdDepth(bytes: Uint8Array): number {
  return psdColorMode(bytes) < 0 ? 0 : (bytes[22] << 8) | bytes[23];
}

/** Colour mode of PSD / PSB bytes (4 = CMYK), -1 when not a PSD. */
export function psdColorMode(bytes: Uint8Array): number {
  if (bytes.length < 26 || bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) return -1;
  return (bytes[24] << 8) | bytes[25];
}

/**
 * The CMYK channels of a CMYK PSD's pixel layers, from the file and the page the import made of it (`page`: as
 * imported — its tile hashes are the keys). Null when the file is not CMYK. An empty map is still a CMYK document.
 */
export function cmykTilesOf(bytes: Uint8Array, page: CmykKeyPage): CmykTiles | null {
  const steps = cmykTileSteps(bytes, page);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

/** What `cmykTilesOf` reads of a page: its raster nodes' place and tile hashes, and the PSD layer links. */
export type CmykKeyPage = Pick<Page, "nodes" | "source">;

/** `cmykTilesOf` one PSD layer record at a time (a step each), for work spread over tasks. */
export function* cmykTileSteps(bytes: Uint8Array, page: CmykKeyPage): Generator<void, CmykTiles | null> {
  if (psdColorMode(bytes) !== 4) return null;
  const L = parsePsdLayout(bytes);
  const out: CmykTiles = new Map();
  const xf = psdCmykProfile(bytes, L.resItems).xf;
  storeXforms.set(out, xf);
  // Different CMYK can convert to the same RGB (grey from black ink or from C = M = Y): when two tiles share an RGB
  // hash but not their channels, the hash alone cannot say whose they are — those are kept per layer record and
  // tile (`layerTileKey`), and the hash itself is left out (a copy elsewhere is read back from its RGB).
  const seen = new Map<string, Uint8Array | null>(); // hash → channels (null: no black ink)
  const ambiguous = new Set<string>();
  const inked: [string, string, Uint8Array][] = []; // [hash, layer-tile key, channels]
  const byId = new Map(page.nodes.map((n) => [n.id, n]));
  const links = page.source?.psd?.layers ?? [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    const n = l.node ? byId.get(l.node) : undefined;
    const rec = L.records[i];
    if (!n || n.type !== "RASTER" || n.adjust || !rec) continue;
    // the import places a layer's tiles at its record's corner
    if (rec.left !== Math.round(n.transform.x) || rec.top !== Math.round(n.transform.y)) continue;
    const v = layerCmykPlanes(L, rec);
    if (!v) continue;
    for (const [key, t] of Object.entries(n.tiles)) {
      const u = key.indexOf("_");
      const tx = +key.slice(0, u), ty = +key.slice(u + 1);
      const x0 = tx * TILE, y0 = ty * TILE;
      const xn = Math.min(TILE, v.w - x0), yn = Math.min(TILE, v.h - y0);
      // black ink under some coverage? (most tiles of most files have none: nothing to copy then)
      let ink = false;
      for (let y = 0; y < yn && !ink; y++)
        for (let s = (y0 + y) * v.w + x0, e = s + xn; s < e; s++)
          if ((xf || v.k[s] !== 255) && v.a[s]) {
            ink = true;
            break;
          }
      let mine: Uint8Array | null = null;
      if (ink) {
        mine = new Uint8Array(TILE * TILE * 4).fill(255);
        for (let y = 0; y < yn; y++)
          for (let x = 0, s = (y0 + y) * v.w + x0, o = y * TILE * 4; x < xn; x++, s++, o += 4) {
            mine[o] = v.c[s];
            mine[o + 1] = v.m[s];
            mine[o + 2] = v.y[s];
            mine[o + 3] = v.k[s];
          }
      }
      const prev = seen.get(t.hash);
      if (prev === undefined) seen.set(t.hash, mine);
      else if (!sameBytes(prev, mine)) ambiguous.add(t.hash);
      if (mine) inked.push([t.hash, layerTileKey(t.hash, i, key), mine]);
    }
    yield;
  }
  for (const [hash, own, data] of inked) out.set(ambiguous.has(hash) ? own : hash, data);
  return out;
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean => {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** Store key of a tile whose RGB hash is shared with other channels: the hash, the layer record and the tile. */
const layerTileKey = (hash: string, record: number, tile: string) => `${hash}#${record}/${tile}`;

const recordMemo = new WeakMap<object, Map<string, number>>();
/** Node id → index of its PSD layer record (page.source.psd.layers), for the per-layer keys above. */
export function psdRecordIndex(page: Pick<Page, "source"> | undefined): Map<string, number> | undefined {
  const links = page?.source?.psd?.layers;
  if (!links) return undefined;
  let m = recordMemo.get(links);
  if (!m) {
    m = new Map();
    links.forEach((l, i) => l.node && m!.set(l.node, i));
    recordMemo.set(links, m);
  }
  return m;
}

/** Page-space placement of a raster node at whole pixels: its tile grid's corner and extent. */
export interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
  tiles: RasterNode["tiles"];
}

const geos = new WeakMap<RasterNode, Geo | null>();

/** Where a raster node's tiles lie on the page (untransformed except for a whole-pixel move); null when empty. */
export function rasterGeo(n: RasterNode): Geo | null {
  let g = geos.get(n);
  if (g !== undefined) return g;
  let mx = -1, my = -1;
  for (const k of Object.keys(n.tiles)) {
    const i = k.indexOf("_");
    mx = Math.max(mx, +k.slice(0, i));
    my = Math.max(my, +k.slice(i + 1));
  }
  g = mx < 0 ? null : { x: Math.round(n.transform.x), y: Math.round(n.transform.y), w: (mx + 1) * TILE, h: (my + 1) * TILE, tiles: n.tiles };
  geos.set(n, g);
  return g;
}

const tmp = new Uint8Array(4);

/** Which channels a pass reads: the RGB tiles, or a CMYK document's (C, M, Y) or (K, K, K) — alpha always the tile's. */
export type Pass = "rgb" | "cmy" | "k";

/** The part of a node inside region (X0, Y0, rw, rh) as one pass sees it, in region coordinates; null when outside. */
export function slicePass(g: Geo, X0: number, Y0: number, rw: number, rh: number, pass: Pass, store: CmykTiles | null, record?: number): PlacedPixels | null {
  const x0 = Math.max(X0, g.x), x1 = Math.min(X0 + rw, g.x + g.w);
  const y0 = Math.max(Y0, g.y), y1 = Math.min(Y0 + rh, g.y + g.h);
  if (x0 >= x1 || y0 >= y1) return null;
  const w = x1 - x0, h = y1 - y0;
  const rgba = new Uint8Array(w * h * 4);
  let any = false;
  const lx0 = x0 - g.x, ly0 = y0 - g.y;
  // (filled with NaN: a pixel no HDR tile wrote is decoded from its 8 bits at the end)
  let lin: Float32Array | undefined;
  const linFrom = (n: number) => new Float32Array(n * 3).fill(NaN);
  for (let ty = Math.floor(ly0 / TILE); ty * TILE < ly0 + h; ty++)
    for (let tx = Math.floor(lx0 / TILE); tx * TILE < lx0 + w; tx++) {
      const t = g.tiles[`${tx}_${ty}`];
      if (!t) continue;
      any = true;
      const sx0 = Math.max(lx0, tx * TILE), sx1 = Math.min(lx0 + w, (tx + 1) * TILE);
      const sy0 = Math.max(ly0, ty * TILE), sy1 = Math.min(ly0 + h, (ty + 1) * TILE);
      // a 32-bit tile with light past white: its floats beside the 8-bit pixels (linearStoreOf)
      const hdr = pass === "rgb" && store && linearStores.has(store) ? store.get(t.hash) : undefined;
      if (hdr) {
        const f = new Float32Array(hdr.buffer, hdr.byteOffset, hdr.byteLength >> 2);
        lin ??= linFrom(rgba.length >> 2);
        for (let y = sy0; y < sy1; y++)
          for (let x = sx0; x < sx1; x++) {
            const si = ((y - ty * TILE) * TILE + (x - tx * TILE)) * 3, di = ((y - ly0) * w + (x - lx0)) * 3;
            lin[di] = f[si];
            lin[di + 1] = f[si + 1];
            lin[di + 2] = f[si + 2];
          }
      }
      const ink = pass === "rgb" || !store ? undefined : store.get(t.hash) ?? (record !== undefined ? store.get(layerTileKey(t.hash, record, `${tx}_${ty}`)) : undefined);
      // a colour-managed file's changed or new tile: its inks through the profile's separation
      const sep = !ink && pass !== "rgb" ? cmykXformOf(store) : null;
      for (let y = sy0; y < sy1; y++) {
        const src = ((y - ty * TILE) * TILE + (sx0 - tx * TILE)) * 4, n = (sx1 - sx0) * 4;
        const dst = ((y - ly0) * w + (sx0 - lx0)) * 4;
        if (pass === "rgb" || (pass === "cmy" && !ink && !sep)) {
          rgba.set(t.data.subarray(src, src + n), dst);
          continue;
        }
        const d = t.data;
        if (sep) {
          for (let i = 0; i < n; i += 4) {
            const s = src + i, o = dst + i;
            sep.cmyk(d[s], d[s + 1], d[s + 2], tmp, 0);
            if (pass === "cmy") {
              rgba[o] = tmp[0];
              rgba[o + 1] = tmp[1];
              rgba[o + 2] = tmp[2];
            } else rgba[o] = rgba[o + 1] = rgba[o + 2] = tmp[3];
            rgba[o + 3] = d[s + 3];
          }
          continue;
        }
        for (let i = 0; i < n; i += 4) {
          const s = src + i, o = dst + i;
          if (pass === "cmy") {
            rgba[o] = ink![s];
            rgba[o + 1] = ink![s + 1];
            rgba[o + 2] = ink![s + 2];
          } else rgba[o] = rgba[o + 1] = rgba[o + 2] = ink ? ink[s + 3] : 255;
          rgba[o + 3] = d[s + 3];
        }
      }
    }
  if (lin) for (let i = 0; i < lin.length; i++) if (Number.isNaN(lin[i])) lin[i] = srgbToLinear(rgba[(((i / 3) | 0) << 2) + (i % 3)] / 255);
  return any ? { rgba, left: x0 - X0, top: y0 - Y0, width: w, height: h, ...(lin ? { lin } : {}) } : null;
}

/**
 * The layers composited over region (X0, Y0, rw × rh) of the page, straight RGBA: RGB when `store` is null, else as a
 * CMYK document (two passes, converted). Raster nodes only, drawn at their whole-pixel place (`cmykComposable`). A
 * DISSOLVE pattern follows the region's own corner, so regions start at multiples of 256 px. `page`: whose PSD layer
 * records the nodes come from (finds the channels of tiles whose RGB another layer shares — `cmykTilesOf`).
 */
export function composeRegion(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined, X0: number, Y0: number, rw: number, rh: number, store: CmykTiles | null, page?: Pick<Page, "source">): Uint8Array {
  const records = store ? psdRecordIndex(page) : undefined;
  const pixels = (p: Pass) => (n: SceneNode) => {
    if (n.type !== "RASTER") return null;
    const g = rasterGeo(n);
    return g ? slicePass(g, X0, Y0, rw, rh, p, store, records?.get(n.id)) : null;
  };
  if (!store) return compositeTree(nodes, groups, pixels("rgb"), rw, rh);
  if (linearStores.has(store)) return compositeTree(nodes, groups, pixels("rgb"), rw, rh, undefined, true);
  const duo = duoStores.get(store);
  if (duo) {
    const rgb = pixels("rgb");
    const out = compositeTree(nodes, groups, (n) => {
      const p = rgb(n);
      if (!p) return p;
      for (let i = 0; i < p.rgba.length; i += 4) p.rgba[i] = p.rgba[i + 1] = p.rgba[i + 2] = duo.grey(p.rgba[i], p.rgba[i + 1], p.rgba[i + 2]);
      return p;
    }, rw, rh);
    for (let i = 0; i < out.length; i += 4) {
      const g = out[i] * 3;
      out[i] = duo.lut[g];
      out[i + 1] = duo.lut[g + 1];
      out[i + 2] = duo.lut[g + 2];
    }
    return out;
  }
  const [cmy, k] = compositeInks(nodes, groups, pixels("cmy"), { k: pixels("k"), fx: inkEffectsOf(store) }, rw, rh);
  return cmykToRgba(cmy, k, cmykXformOf(store));
}

// ───────── effect colours on the ink planes ─────────

/**
 * A colour as one plane's stored values: (C, M, Y) as RGB on plane 0, black as a grey on plane 1 (255 = no ink). A
 * CMYK colour (what Photoshop keeps for a CMYK document's effects) by its inks; any other colour as the reader takes
 * an RGB layer — C, M, Y = R, G, B, no black.
 */
export function inkColor(c: Color, plane: 0 | 1, xf?: CmykXform | null): Color {
  const a = rgbaOf(c).a;
  if (c.space === "cmyk" && c.v && c.v.length >= 4) {
    const s = (v: number) => 255 * (1 - Math.max(0, Math.min(1, v)));
    return plane ? rgbColor(s(c.v[3]), s(c.v[3]), s(c.v[3]), a) : rgbColor(s(c.v[0]), s(c.v[1]), s(c.v[2]), a);
  }
  if (xf) {
    // a colour-managed document: the profile's separation of the colour
    const v = rgbaOf(c), ink = new Uint8Array(4);
    xf.cmyk(Math.round(v.r), Math.round(v.g), Math.round(v.b), ink, 0);
    return plane ? rgbColor(ink[3], ink[3], ink[3], a) : rgbColor(ink[0], ink[1], ink[2], a);
  }
  if (!plane) return c;
  return rgbColor(255, 255, 255, a);
}

function inkPaint(p: Paint, plane: 0 | 1, xf: CmykXform | null): Paint {
  switch (p.type) {
    case "solid":
      return { ...p, color: inkColor(p.color, plane, xf) };
    case "gradient":
      return { ...p, stops: p.stops.map((s) => ({ ...s, color: inkColor(s.color, plane, xf) })) };
    case "pattern":
      return { ...p, ...(p.fg ? { fg: inkColor(p.fg, plane, xf) } : {}), ...(p.bg ? { bg: inkColor(p.bg, plane, xf) } : {}) };
    default:
      return p;
  }
}

function inkEffect(e: Effect, plane: 0 | 1, xf: CmykXform | null): Effect {
  switch (e.type) {
    case "dropShadow":
    case "innerShadow":
    case "satin":
      return { ...e, color: inkColor(e.color, plane, xf) };
    case "outerGlow":
    case "innerGlow":
    case "overlay":
      return { ...e, paint: inkPaint(e.paint, plane, xf) };
    case "fxStroke":
      return { ...e, stroke: { ...e.stroke, paint: inkPaint(e.stroke.paint, plane, xf) } };
    case "bevel":
      return { ...e, highlight: inkColor(e.highlight, plane, xf), shadow: inkColor(e.shadow, plane, xf) };
    default:
      return e;
  }
}

type InkFx = (fx: readonly Effect[] | undefined, plane: 0 | 1) => readonly Effect[] | undefined;
const fxFns = new WeakMap<object, InkFx>();
const UNMANAGED = {};

/**
 * A node's or group's effects as drawn on a CMYK plane (`InkPlanes.fx`) of a store's document — RGB colours through
 * its profile's separation when it has one — memoized per effects list.
 */
export function inkEffectsOf(store: CmykTiles | null | undefined): InkFx {
  const xf = cmykXformOf(store);
  let f = fxFns.get(xf ?? UNMANAGED);
  if (!f) {
    const memo = [new WeakMap<readonly Effect[], readonly Effect[]>(), new WeakMap<readonly Effect[], readonly Effect[]>()];
    f = (fx, plane) => {
      if (!fx || !fx.length) return fx;
      let v = memo[plane].get(fx);
      if (!v) memo[plane].set(fx, (v = fx.map((e) => inkEffect(e, plane, xf))));
      return v;
    };
    fxFns.set(xf ?? UNMANAGED, f);
  }
  return f;
}

/** `inkEffectsOf` a colour-unmanaged document. */
export const inkEffects = inkEffectsOf(null);
/** Blend modes that give the same result in CMYK as on the converted RGB (where a pixel covers fully). */
const SAME_IN_CMYK = new Set(["NORMAL", "PASS_THROUGH", "DISSOLVE"]);

const needMemo = new WeakMap<readonly SceneNode[], { groups: unknown; v: boolean }>();
const partialMemo = new WeakMap<object, boolean>();

/** Does a raster tile have see-through pixels that are not fully clear (soft edges, feathered masks)? Per tile. */
function partialTile(t: { data: Uint8ClampedArray }): boolean {
  let v = partialMemo.get(t);
  if (v === undefined) {
    v = false;
    const d = t.data;
    for (let i = 3; i < d.length; i += 4)
      if (d[i] !== 0 && d[i] !== 255) {
        v = true;
        break;
      }
    partialMemo.set(t, v);
  }
  return v;
}

/**
 * Does this page need CMYK compositing, and can the pixel compositor draw it? Something blends: a layer or folder
 * with a mode that differs in CMYK, or a layer over others that lets them show through — opacity or fill below
 * 100 %, soft edges, effects, an adjustment layer. Photoshop mixes a CMYK document's channels there, and converting
 * clips at full ink, so mixing the converted RGB differs (omni-fid-cmyk-normal-alpha: RGB 12 % of pixels within 2
 * levels, CMYK 100 %). And everything that shows is a raster layer at a whole-pixel place (no scale, rotation or
 * crop) — the PSD import's layers. Otherwise the page is drawn as before. Memoized per node list.
 */
export function cmykComposable(page: Pick<Page, "nodes" | "groups">): boolean {
  const m = needMemo.get(page.nodes);
  if (m && m.groups === page.groups) return m.v;
  let blend = (page.groups ?? []).some((g) => g.visible && (!SAME_IN_CMYK.has(g.blendMode) || g.opacity < 1 || hasEffects(g)));
  let ok = true;
  const shown: RasterNode[] = [];
  for (const n of page.nodes) {
    if (!n.visible) continue;
    const t = n.transform;
    if (n.type !== "RASTER" || n.crop || t.rotation || t.scale !== 1 || (t.scaleY ?? 1) !== 1 || !Number.isInteger(t.x) || !Number.isInteger(t.y)) {
      ok = false;
      break;
    }
    if (!SAME_IN_CMYK.has(n.blendMode) || n.adjust || hasEffects(n)) blend = true;
    // over another layer: what lets it show through mixes the two
    else if (shown.length && n.opacity < 1) blend = true;
    shown.push(n);
  }
  // soft edges of a layer over another (the bottom one's only meet the page colour, as in RGB): the tiles' alpha
  if (ok && !blend) blend = shown.slice(1).some((n) => Object.values(n.tiles).some(partialTile));
  const v = blend && ok;
  needMemo.set(page.nodes, { groups: page.groups, v });
  return v;
}

// ───────── a page's CMYK channels, loaded on demand ─────────

/** Black-ink tiles by PSD file hash (null = not a CMYK file); the last few files used, within a memory bound. */
const stores = new Map<string, CmykTiles | null>();
const STORES = 4;
/** bytes of channels kept for files other than the one used last */
const STORE_BYTES = 512 * 2 ** 20;

const sizes = new WeakMap<CmykTiles, number>();
const bytesOf = (s: CmykTiles | null | undefined) => {
  if (!s) return 0;
  let n = sizes.get(s);
  if (n === undefined) {
    n = 0;
    for (const v of s.values()) n += v.byteLength;
    sizes.set(s, n);
  }
  return n;
};

function keepStore(hash: string, s: CmykTiles | null) {
  stores.delete(hash);
  stores.set(hash, s);
  let total = 0;
  for (const v of stores.values()) total += bytesOf(v);
  while (stores.size > 1 && (stores.size > STORES || total > STORE_BYTES)) {
    const old = stores.keys().next().value!;
    total -= bytesOf(stores.get(old));
    stores.delete(old);
  }
}

/** Channels being read in the background, by file hash. */
const preparing = new Map<string, Promise<CmykTiles | null>>();
/** Files whose background reading failed (a worker out of memory): drawn as RGB, never retried on the main thread. */
const failed = new Set<string>();

/** The page as `cmykTilesOf` reads it, without pixels (what goes to the worker): ids, places, tile hashes, links. */
function keyPage(page: CmykKeyPage): CmykKeyPage {
  const nodes = page.nodes.map((n) => {
    if (n.type !== "RASTER") return { id: n.id, type: n.type };
    const tiles: Record<string, { hash: string }> = {};
    for (const [k, t] of Object.entries(n.tiles)) tiles[k] = { hash: t.hash };
    return { id: n.id, type: n.type, adjust: n.adjust ? true : undefined, transform: { x: n.transform.x, y: n.transform.y }, tiles };
  });
  const layers = (page.source?.psd?.layers ?? []).map((l) => ({ node: l.node }));
  return { nodes, source: { psd: { layers } } } as unknown as CmykKeyPage;
}

/** ms of channel work a task may do where there is no worker (one layer record a step) */
const STEP_MS = 30;

/** Read the channels on this thread a layer record per task (no worker: tests, old engines). */
function readHere(bytes: Uint8Array, page: CmykKeyPage | null, hash: string): Promise<CmykTiles | null> {
  return new Promise((resolve, reject) => {
    let steps: Generator<void, CmykTiles | null> | null = null;
    const run = () => {
      try {
        const t0 = performance.now();
        // without the import's page the file is imported here first (one long task: only without a worker)
        steps ??= cmykTileSteps(bytes, page ?? importPsdPage(bytes, "cmyk.psd", "cmyk", { id: "cmyk", hash }).page);
        for (;;) {
          const r = steps.next();
          if (r.done) return resolve(r.value);
          if (performance.now() - t0 > STEP_MS) return void setTimeout(run, 0);
        }
      } catch (e) {
        reject(e);
      }
    };
    setTimeout(run, 0);
  });
}

/** Read the channels in a worker: the file is copied there (the caller keeps its bytes), the channels come back. */
function readInWorker(w: Worker, bytes: Uint8Array, page: CmykKeyPage | null): Promise<CmykTiles | null> {
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ kind: string; tiles?: [string, Uint8Array][] | null; message?: string }>) => {
      w.terminate();
      if (e.data.kind === "cmyk") resolve(e.data.tiles ? new Map(e.data.tiles) : null);
      else reject(new Error(e.data.message ?? "cmyk worker"));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || "cmyk worker"));
    };
    const copy = bytes.slice(); // only the file's bytes, whatever buffer they sit in
    w.postMessage({ kind: "cmyk", bytes: copy, page }, [copy.buffer]);
  });
}

/**
 * Read a CMYK file's channels in the background (a worker; without one, a layer record per task) and keep them.
 * `page`: the page just imported from `bytes` (its tile hashes are the keys) — without it the file is imported once
 * more there (an .omw whose tiles were all stored). Resolves to the channels, null for a file that is not CMYK or
 * could not be read. Repeated calls share the work.
 */
export function prepareCmykStore(hash: string, bytes: Uint8Array, page?: CmykKeyPage): Promise<CmykTiles | null> {
  if (stores.has(hash)) return Promise.resolve(stores.get(hash)!);
  if (failed.has(hash) || psdColorMode(bytes) !== 4) return Promise.resolve(null);
  let p = preparing.get(hash);
  if (p) return p;
  const key = page ? keyPage(page) : null;
  // the fidelity worker: it holds the PSD reader already
  const w = fidelityWorker();
  // still wanted? (the tab may have been closed meanwhile — releaseCmykFiles forgets the work)
  const mine = () => preparing.get(hash) === job && (preparing.delete(hash), true);
  const job: Promise<CmykTiles | null> = (w ? readInWorker(w, bytes, key).then((s) => withXform(s, bytes)) : readHere(bytes, key, hash)).then(
    (s) => {
      if (mine() && !stores.has(hash)) keepStore(hash, s); // an export may have read them meanwhile
      return stores.get(hash) ?? s;
    },
    () => {
      if (mine()) failed.add(hash);
      return null;
    },
  );
  preparing.set(hash, job);
  return job;
}

/**
 * At import (the page just made from `bytes`): a CMYK file whose layers blend starts reading its channels in the
 * background — opening is not held up, the screen shows the RGB layers until they are there (render/cmykView.ts).
 */
export function seedCmykStore(hash: string, bytes: Uint8Array, page: Pick<Page, "nodes" | "groups" | "source">) {
  if (stores.has(hash) || preparing.has(hash) || psdColorMode(bytes) !== 4 || !cmykComposable(page)) return;
  void prepareCmykStore(hash, bytes, page);
}

/** Forget the channels of files no open document uses (`inUse`: by PSD file hash) — a tab was closed. */
export function releaseCmykFiles(inUse: (hash: string) => boolean) {
  for (const h of [...stores.keys()]) if (!inUse(h)) stores.delete(h);
  for (const h of [...failed]) if (!inUse(h)) failed.delete(h);
  for (const h of [...preparing.keys()]) if (!inUse(h)) preparing.delete(h);
}

/** The file bytes behind a PSD page and their hash, or null. */
function psdBytes(doc: Pick<OmwDocument, "assets">, page: Page): { hash: string; bytes: Uint8Array } | null {
  const p = page.source?.psd;
  const a = p ? doc.assets[p.assetId] : undefined;
  const bytes = a ? getBlob(a.hash) : undefined;
  return a && bytes ? { hash: a.hash, bytes } : null;
}

/**
 * The CMYK channels of a PSD page's file: undefined while not read yet (`build` false — `cmykStoreLater` reads them
 * in the background), null when the page is not from a CMYK file. `build`: read now on this thread (exports) — that
 * imports the file once more (the page the user edits is never the source of the keys). A cheap header check first,
 * so an RGB file costs nothing.
 */
export function cmykStoreOf(doc: Pick<OmwDocument, "assets">, page: Page, build = true): CmykTiles | null | undefined {
  const f = psdBytes(doc, page);
  if (!f) return null;
  if (stores.has(f.hash)) {
    const s = stores.get(f.hash)!;
    if ([...stores.keys()].pop() !== f.hash) keepStore(f.hash, s); // used last
    return s;
  }
  let s: CmykTiles | null = null;
  if (psdColorMode(f.bytes) === 4) {
    if (!build) return failed.has(f.hash) ? null : undefined;
    s = cmykTilesOf(f.bytes, importPsdPage(f.bytes, "cmyk.psd", "cmyk", { id: "cmyk", hash: f.hash }).page);
  } else if (psdDepth(f.bytes) === 32) s = linearStoreOf(f.bytes, page);
  else if (psdColorMode(f.bytes) === 8) {
    const lut = duotoneLut(parsePsdLayout(f.bytes));
    s = lut ? duotoneStore(lut) : null;
  }
  keepStore(f.hash, s);
  return s;
}

/** The CMYK channels of a PSD page's file, read in the background when not there yet (null: not CMYK, or failed). */
export function cmykStoreLater(doc: Pick<OmwDocument, "assets">, page: Page): Promise<CmykTiles | null> {
  const s = cmykStoreOf(doc, page, false);
  if (s !== undefined) return Promise.resolve(s);
  const f = psdBytes(doc, page)!;
  return prepareCmykStore(f.hash, f.bytes);
}

/**
 * Region (X0, Y0, w × h; X0, Y0 multiples of 256) of a page composited as a CMYK document. With effects on the page
 * the region is composited with a margin of whole 256 px tiles, so shadows and glows from outside it are complete.
 */
export function composeCmykPageRegion(page: Pick<Page, "nodes" | "groups" | "source">, X0: number, Y0: number, w: number, h: number, store: CmykTiles): Uint8Array {
  const reach = pageEffectReach(page);
  const pad = reach > 0 ? Math.ceil(reach / TILE) * TILE : 0;
  if (!pad) return composeRegion(page.nodes, page.groups, X0, Y0, w, h, store, page);
  const W = w + 2 * pad;
  const big = composeRegion(page.nodes, page.groups, X0 - pad, Y0 - pad, W, h + 2 * pad, store, page);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(big.subarray(((y + pad) * W + pad) * 4, ((y + pad) * W + pad + w) * 4), y * w * 4);
  return out;
}

/** One pass of a node over a region (X0, Y0, rw × rh), in region coordinates; undefined: its tiles and the store. */
export type InkPixels = (n: SceneNode, pass: "cmy" | "k", X0: number, Y0: number, rw: number, rh: number) => PlacedPixels | null | undefined;

/**
 * Region (X0, Y0, w × h) of a page composited on the inks, as the stored channel values (255 = no ink): the (C, M, Y)
 * plane as RGB and the black plane as a grey, each with the composite's alpha — what a CMYK PSD's merged image holds
 * (`composeCmykPageRegion` is these converted). `own`: a node's pixels when they are not its tiles with the file's
 * channels (layers the save writes with new inks, or drawn another way). Effects from outside the region complete.
 */
export function composeInkPlanes(page: Pick<Page, "nodes" | "groups" | "source">, X0: number, Y0: number, w: number, h: number, store: CmykTiles, own?: InkPixels): [Uint8Array, Uint8Array] {
  const reach = pageEffectReach(page);
  const pad = reach > 0 ? Math.ceil(reach / TILE) * TILE : 0;
  const RX = X0 - pad, RY = Y0 - pad, RW = w + 2 * pad, RH = h + 2 * pad;
  const records = psdRecordIndex(page);
  const pixels = (p: "cmy" | "k") => (n: SceneNode) => {
    const o = own?.(n, p, RX, RY, RW, RH);
    if (o !== undefined) return o;
    if (n.type !== "RASTER") return null;
    const g = rasterGeo(n);
    return g ? slicePass(g, RX, RY, RW, RH, p, store, records?.get(n.id)) : null;
  };
  const [cmy, k] = compositeInks(page.nodes, page.groups, pixels("cmy"), { k: pixels("k"), fx: inkEffectsOf(store) }, RW, RH);
  if (!pad) return [cmy, k];
  const crop = (big: Uint8Array) => {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(big.subarray(((y + pad) * RW + pad) * 4, ((y + pad) * RW + pad + w) * 4), y * w * 4);
    return out;
  };
  return [crop(cmy), crop(k)];
}

const flatMemo = new WeakMap<Page, Page | null>();

/**
 * A CMYK page that needs CMYK compositing (`cmykComposable`) as one picture: the page with a single raster layer of
 * its composite — what the vector PDF export draws (as it draws an unedited PSD's merged image). Null for every
 * other page. Builds synchronously (export time); memoized per page state.
 */
export function cmykFlatPage(doc: Pick<OmwDocument, "assets">, page: Page): Page | null {
  let v = flatMemo.get(page);
  if (v !== undefined) return v;
  v = null;
  const store = cmykComposable(page) ? cmykStoreOf(doc, page) : null;
  if (store) {
    const node = newRaster(page.name);
    node.id = `${page.id}-cmyk`;
    for (let ty = 0; ty * TILE < page.height; ty++)
      for (let tx = 0; tx * TILE < page.width; tx++) {
        const rgba = composeCmykPageRegion(page, tx * TILE, ty * TILE, TILE, TILE, store);
        const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        if (!isBlank(data)) node.tiles[`${tx}_${ty}`] = makeTile(data);
      }
    v = { ...page, nodes: [node], groups: undefined };
  }
  flatMemo.set(page, v);
  return v;
}

// ───────── levels of detail (the screen at low zoom) ─────────

/** coarsest level: 256 px pictures of 8192 page px */
const MAX_LEVEL = 5;

/** Level of detail for `scale` device px per page px: 0 at 50 % and above, one more per halving. */
export function cmykLevel(scale: number): number {
  return Math.max(0, Math.min(MAX_LEVEL, Math.floor(Math.log2(1 / Math.max(scale, 1e-6)))));
}

/**
 * Level-L picture (256 × 256) of page px (X0, Y0) … + 256·2^L: the CMYK composite of each 256 px page tile, box-
 * filtered on premultiplied colour. Straight RGBA.
 */
export function cmykLevelPixels(page: Page, store: CmykTiles, X0: number, Y0: number, L: number): Uint8ClampedArray {
  const S = TILE << L, f = 1 << L;
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  if (L === 0) {
    out.set(composeCmykPageRegion(page, X0, Y0, TILE, TILE, store));
    return out;
  }
  const acc = new Float64Array(TILE * TILE * 4);
  for (let sy = 0; sy < S; sy += TILE)
    for (let sx = 0; sx < S; sx += TILE) {
      if (X0 + sx >= page.width || Y0 + sy >= page.height) continue;
      const px = composeCmykPageRegion(page, X0 + sx, Y0 + sy, TILE, TILE, store);
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const i = (y * TILE + x) * 4, a = px[i + 3];
          if (!a) continue;
          const o = ((((sy + y) / f) | 0) * TILE + (((sx + x) / f) | 0)) * 4;
          acc[o] += px[i] * a;
          acc[o + 1] += px[i + 1] * a;
          acc[o + 2] += px[i + 2] * a;
          acc[o + 3] += a;
        }
    }
  const n = f * f;
  for (let o = 0; o < acc.length; o += 4) {
    const a = acc[o + 3];
    if (!a) continue;
    out[o] = Math.round(acc[o] / a);
    out[o + 1] = Math.round(acc[o + 1] / a);
    out[o + 2] = Math.round(acc[o + 2] / a);
    out[o + 3] = Math.round(a / n);
  }
  return out;
}
