// PSD self-scoring (docs/design/ENGINE_RESEARCH.md S1): a PSD/PSB saved with "maximize compatibility" carries
// Photoshop's own merged image — the ground truth for that file. We import the file the same way "open" does,
// composite the layer tree with the pixel compositor (core/image/softComposite.ts), and compare region by region:
// per-file score (pixels within 2 levels, SSIM on luma, max / mean difference), the tiles that mismatch, and a
// coarse heat map. Pure engine code (no DOM): runs in its own worker (fidelity/worker.ts), in tests and in the CLI.
//
// Regions are one 256 px tile row high and at most REGION_PIXELS wide, so memory per step stays bounded (big PSB)
// and the caller gets progress after every tile row and can stop in between.

import { unzlibSync, zlibSync } from "fflate";
import { cmykTilesOf, composeRegion, duotoneStore, linearStoreOf, rasterGeo } from "../image/cmykComposite";
import { duotoneLut, parsePsdLayout } from "../../io/formats/psd";
import { importPsdPage } from "../../io/formats/psd";
import { loadDissolveField } from "../style/blend";
import { TILE } from "../tile";

export const SCORE_VERSION = 1;

/** "none": no ground truth to compare with (flat file, no merged image, or a blank one). */
export type NoScoreReason = "flat" | "noComposite" | "blankComposite" | "error";

export interface PsdScore {
  v: number;
  status: "ok" | "none";
  reason?: NoScoreReason;
  /** content hash of the scored file (the page's PSD asset); a different hash means the score is stale */
  hash: string;
  width: number;
  height: number;
  /** tile edge (= raster TILE, so a tile lines up with the hidden composite node's tiles) */
  tile: number;
  cols: number;
  rows: number;
  /** % of pixels whose largest channel difference is ≤ 2 levels (the badge's "충실도") */
  within2: number;
  /** mean SSIM on luma, 8×8 windows, stride 4, inside each tile */
  ssim: number;
  /** largest channel difference anywhere (levels 0..255) */
  max: number;
  /** mean channel difference */
  mean: number;
  /** mismatching tiles, flat triples [tile index, max difference, pixels > 2 levels] */
  bad: number[];
  /** per-block max difference, zlib + base64 (block × block px per cell, w × h cells) */
  heat?: { block: number; w: number; h: number; z: string };
  /** tile rows done (= rows when finished) */
  done: number;
  ms: number;
  /** where the time went (ms): decoding the file, compositing our render, comparing */
  timing?: { import: number; compose: number; compare: number };
}

export interface ScoreRun {
  score: PsdScore;
  /** page-space bounds [x, y, w, h] of the node drawn for each PSD layer record (page.source.psd.layers order) */
  layerBounds: ([number, number, number, number] | null)[];
}

export interface ScoreOptions {
  /** after every tile row: rows done, total, the score so far (no heat map yet) */
  onProgress?: (done: number, total: number, partial: PsdScore) => void;
  /** checked between tile rows; true stops the run (result null) */
  shouldStop?: () => boolean;
  /** give the event loop a turn every ~30 ms (main-thread fallback) */
  yieldToLoop?: boolean;
  /** widest region composited at once, in pixels per row × TILE (default ≈ 2 M px, one compositor band) */
  regionPixels?: number;
}

/** A tile counts as mismatching when enough pixels differ by more than 2 levels (lone noisy pixels do not). */
export function isBadTile(over2: number, max: number, pixels: number): boolean {
  return over2 > Math.max(16, pixels * 0.001) || (over2 >= 4 && max >= 48);
}

const REGION_PIXELS = 2_000_000;
const HEAT_CELLS = 512;

/** Straight-alpha channel value flattened over white, rounded: FLAT[alpha << 8 | value]. */
const FLAT = (() => {
  const t = new Uint8Array(65536);
  for (let a = 0; a < 256; a++) for (let v = 0; v < 256; v++) t[(a << 8) | v] = Math.round((v * a) / 255 + 255 * (1 - a / 255));
  return t;
})();

/**
 * Compare one tile (page x0, y0, tw × th) of our region render (left X0, row stride rw) with the merged image (W
 * wide): luma planes for SSIM into ya / yb, per-block max into heat; largest difference, pixels > 2 levels and the
 * channel difference sum into st.
 */
export function diffTile(ours: Uint8Array, X0: number, rw: number, ref: Uint8Array, W: number, x0: number, y0: number, tw: number, th: number, ya: Float32Array, yb: Float32Array, heat: Uint8Array, hw: number, block: number, st: { m: number; o: number; s: number }) {
  let m = 0, o = 0, sum = 0;
  for (let y = 0; y < th; y++) {
    let ia = (y * rw + x0 - X0) * 4, jb = ((y0 + y) * W + x0) * 4;
    const hrow = (((y0 + y) / block) | 0) * hw, lrow = y * tw;
    for (let x = 0; x < tw; x++, ia += 4, jb += 4) {
      const aa = ours[ia + 3] << 8, ab = ref[jb + 3] << 8;
      const ra = FLAT[aa | ours[ia]], ga = FLAT[aa | ours[ia + 1]], ba = FLAT[aa | ours[ia + 2]];
      const rb = FLAT[ab | ref[jb]], gb = FLAT[ab | ref[jb + 1]], bb = FLAT[ab | ref[jb + 2]];
      const dr = ra > rb ? ra - rb : rb - ra, dg = ga > gb ? ga - gb : gb - ga, db = ba > bb ? ba - bb : bb - ba;
      const d = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
      ya[lrow + x] = 0.299 * ra + 0.587 * ga + 0.114 * ba;
      yb[lrow + x] = 0.299 * rb + 0.587 * gb + 0.114 * bb;
      sum += dr + dg + db;
      if (d > m) m = d;
      if (d > 2) o++;
      const hi = hrow + (((x0 + x) / block) | 0);
      if (d > heat[hi]) heat[hi] = d;
    }
  }
  st.m = m;
  st.o = o;
  st.s = sum;
}

/** Sum of SSIM over 8×8 windows (stride 4) of two luma planes w×h; returns [sum, windows]. */
export function ssimSum(ya: Float32Array, yb: Float32Array, w: number, h: number): [number, number] {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let s = 0, n = 0;
  for (let y = 0; y + 8 <= h; y += 4)
    for (let x = 0; x + 8 <= w; x += 4) {
      let ma = 0, mb = 0;
      for (let j = 0; j < 8; j++) {
        const r = (y + j) * w + x;
        for (let i = 0; i < 8; i++) (ma += ya[r + i]), (mb += yb[r + i]);
      }
      ma /= 64;
      mb /= 64;
      let va = 0, vb = 0, cv = 0;
      for (let j = 0; j < 8; j++) {
        const r = (y + j) * w + x;
        for (let i = 0; i < 8; i++) {
          const da = ya[r + i] - ma, db = yb[r + i] - mb;
          va += da * da;
          vb += db * db;
          cv += da * db;
        }
      }
      va /= 63;
      vb /= 63;
      cv /= 63;
      s += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  return [s, n];
}

function toBase64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/** The heat grid of a finished score (per-block max difference), or null. */
export function heatGrid(score: PsdScore): Uint8Array | null {
  if (!score.heat) return null;
  try {
    return unzlibSync(fromBase64(score.heat.z));
  } catch {
    return null;
  }
}

/** Mismatching tiles of a score as a map: tile index → [max difference, pixels > 2 levels]. */
export function badTiles(score: PsdScore): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  for (let i = 0; i + 2 < score.bad.length; i += 3) m.set(score.bad[i], [score.bad[i + 1], score.bad[i + 2]]);
  return m;
}

/** "99.7": one decimal, rounded down, so a file with any mismatch never shows 100. */
export function formatWithin(p: number): string {
  if (p >= 100) return "100";
  return (Math.floor(p * 10) / 10).toFixed(1);
}

const none = (reason: NoScoreReason, w = 0, h = 0, ms = 0): PsdScore => ({
  v: SCORE_VERSION, status: "none", reason, hash: "", width: w, height: h, tile: TILE, cols: 0, rows: 0,
  within2: 0, ssim: 0, max: 0, mean: 0, bad: [], done: 0, ms,
});

/**
 * Score a PSD/PSB file against its own merged image. Null when stopped (`shouldStop`). A file without ground
 * truth gives status "none" with the reason. The caller fills `hash`.
 */
export async function scorePsd(bytes: Uint8Array, opts: ScoreOptions = {}): Promise<ScoreRun | null> {
  const t0 = performance.now();
  const r = importPsdPage(bytes, "score.psd", "score", { id: "score", hash: "" });
  const { page, image } = r;
  const W = page.width, H = page.height;
  const links = page.source?.psd?.layers ?? [];
  const compositeId = page.source?.psd?.compositeNode;
  const byId = new Map(page.nodes.map((n) => [n.id, n]));
  const layerBounds = links.map((l): [number, number, number, number] | null => {
    const n = l.node ? byId.get(l.node) : undefined;
    const g = n && n.type === "RASTER" ? rasterGeo(n) : null;
    return g ? [g.x, g.y, g.w, g.h] : null;
  });
  if (!r.pixelLayers) return { score: none("flat", W, H, performance.now() - t0), layerBounds };
  const ref = image.composite;
  if (!ref || !compositeId) return { score: none("noComposite", W, H, performance.now() - t0), layerBounds };

  const nodes = page.nodes.filter((n) => n.id !== compositeId);
  // a CMYK document: Photoshop blends its channels as stored — composited as the screen and the exports do
  // (core/image/cmykComposite.ts)
  // a 32-bit document: composited in linear light, as Photoshop does (the same module, linearStore)
  // a duotone: its layers composited as grey, then coloured (duotoneStore)
  const lut = image.mode === 8 ? duotoneLut(parsePsdLayout(bytes)) : null;
  const cmyk = image.mode === 4 ? cmykTilesOf(bytes, page) : image.depth === 32 ? linearStoreOf(bytes, page) : lut ? duotoneStore(lut) : null;
  // DISSOLVE thresholds are loaded on demand (core/style/blend.ts)
  await loadDissolveField();

  const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
  let block = 1;
  while (Math.max(W, H) / block > HEAT_CELLS) block *= 2;
  const hw = Math.ceil(W / block), hh = Math.ceil(H / block);
  const heat = new Uint8Array(hw * hh);
  let max = 0, sum = 0, over = 0, ssimS = 0, ssimN = 0, px = 0;
  const ref32 = new Uint32Array(ref.buffer, ref.byteOffset, ref.byteLength >>> 2);
  let uniform = true;
  for (let i = 1; i < ref32.length && uniform; i++) if (ref32[i] !== ref32[0]) uniform = false;
  const st = { m: 0, o: 0, s: 0 };
  const regionW = Math.max(TILE, Math.floor((opts.regionPixels ?? REGION_PIXELS) / TILE / TILE) * TILE);
  const ya = new Float32Array(TILE * TILE), yb = new Float32Array(TILE * TILE);
  const bad: number[] = [];
  let lastYield = performance.now();
  const tImport = lastYield - t0;
  let tCompose = 0, tCompare = 0;

  const snapshot = (done: number): PsdScore => ({
    v: SCORE_VERSION, status: "ok", hash: "", width: W, height: H, tile: TILE, cols, rows,
    within2: px ? (100 * (px - over)) / px : 100, ssim: ssimN ? ssimS / ssimN : 1, max, mean: px ? sum / (px * 3) : 0,
    bad: bad.slice(), done, ms: performance.now() - t0,
    timing: { import: Math.round(tImport), compose: Math.round(tCompose), compare: Math.round(tCompare) },
  });

  for (let ty = 0; ty < rows; ty++) {
    const Y0 = ty * TILE, rh = Math.min(TILE, H - Y0);
    for (let X0 = 0; X0 < W; X0 += regionW) {
      const rw = Math.min(regionW, W - X0);
      const t1 = performance.now();
      const ours = composeRegion(nodes, page.groups, X0, Y0, rw, rh, cmyk, page);
      const t2 = performance.now();
      tCompose += t2 - t1;
      const o32 = new Uint32Array(ours.buffer, ours.byteOffset, ours.byteLength >>> 2);
      for (let tx = X0 / TILE; tx * TILE < X0 + rw; tx++) {
        const x0 = tx * TILE, tw = Math.min(TILE, W - x0);
        let m = 0, o = 0, ts = 0;
        // fast path: the tile is bit-identical (most tiles of a file we render right) — every SSIM window is 1
        let same = true;
        for (let y = 0; y < rh && same; y++) {
          const ra = y * rw + x0 - X0, rb = (Y0 + y) * W + x0;
          for (let x = 0; x < tw; x++) {
            if (o32[ra + x] !== ref32[rb + x]) {
              same = false;
              break;
            }
          }
        }
        if (same) {
          const windows = tw >= 8 && rh >= 8 ? (Math.floor((tw - 8) / 4) + 1) * (Math.floor((rh - 8) / 4) + 1) : 0;
          ssimN += windows;
          ssimS += windows;
        } else {
          diffTile(ours, X0, rw, ref, W, x0, Y0, tw, rh, ya, yb, heat, hw, block, st);
          m = st.m;
          o = st.o;
          ts = st.s;
          const [s, n] = ssimSum(ya, yb, tw, rh);
          ssimS += s;
          ssimN += n;
        }
        const ti = ty * cols + tx;
        sum += ts;
        px += tw * rh;
        over += o;
        if (m > max) max = m;
        if (isBadTile(o, m, tw * rh)) bad.push(ti, m, o);
      }
      tCompare += performance.now() - t2;
    }
    opts.onProgress?.(ty + 1, rows, snapshot(ty + 1));
    if (opts.shouldStop?.()) return null;
    if (opts.yieldToLoop && performance.now() - lastYield > 30) {
      await new Promise((res) => setTimeout(res, 0));
      lastYield = performance.now();
      if (opts.shouldStop?.()) return null;
    }
  }
  const score = snapshot(rows);
  // a merged image of one flat colour that our layers do not match: Photoshop saved without "maximize
  // compatibility" (it then writes a blank merged image) — nothing to compare with
  if (uniform && score.within2 < 50) return { score: none("blankComposite", W, H, performance.now() - t0), layerBounds };
  score.heat = { block, w: hw, h: hh, z: toBase64(zlibSync(heat, { level: 6 })) };
  score.ms = performance.now() - t0;
  return { score, layerBounds };
}
