// Screen and picture side of CMYK documents (core/image/cmykComposite.ts computes; this draws). A CMYK PSD page
// whose layers blend in a way that differs in CMYK (`cmykComposable`) is drawn from the pixel compositor's CMYK
// result instead of the Canvas2D layer walk, so the screen, PNG / image-PDF export, the slide show and the PSD score
// show the same pixels. A 32-bit (HDR) page comes the same way, composited in linear light (cmykComposite.ts
// linearStore); other RGB pages never come here.
//
// The result is cached in page-grid tiles per level of detail (level L: one 256 × 256 picture of 256·2^L page px,
// box-filtered), keyed by the weave key of their page rectangle (core/loom.ts) and the file, so an edit recomputes
// only the tiles it touched. Level 0 is composited; level L is made from its four level L−1 quarters (a pyramid), so
// a zoomed-out picture after an edit costs one level-0 tile, not the whole page. On screen (and in thumbnails) at
// most a small time budget of level-0 tiles is computed per task, the rest in the background while the Canvas2D
// render stands in (marked incomplete and repainted when they are ready). Exports compute everything at once.
// The file's CMYK channels themselves are read in a worker (prepareCmykStore) — the RGB layers stand in until then.

import type { Rect } from "../core/geom";
import { cmykComposable, cmykLevel, cmykLevelPixels, cmykStoreLater, cmykStoreOf, releaseCmykFiles, type CmykTiles } from "../core/image/cmykComposite";
import { weaveKey } from "../core/loom";
import { TILE } from "../core/tile";
import type { OmwDocument, Page } from "../core/types";
import { ctx2d, makeCanvas, type Ctx, type DrawEnv } from "./draw";

type Cv = OffscreenCanvas | HTMLCanvasElement;

/** Cached level tiles to draw (≈ 256 KB each). */
const MAX_TILES = 192;
const lru = new Map<string, Cv>();
/** Cached level pictures the coarser levels are made from (≈ 256 KB each). */
const MAX_PICTURES = 256;
const pics = new Map<string, Uint8ClampedArray>();
/** ms of tile work the screen may do in one task before handing the rest to the background */
const BUDGET_MS = 12;

function lruGet<T>(m: Map<string, T>, k: string): T | undefined {
  const v = m.get(k);
  if (v) {
    m.delete(k);
    m.set(k, v);
  }
  return v;
}

function lruPut<T>(m: Map<string, T>, k: string, v: T, max: number) {
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value!);
}

function tileCanvas(px: Uint8ClampedArray): Cv {
  const cv = makeCanvas(TILE, TILE);
  ctx2d(cv).putImageData(new ImageData(px, TILE, TILE), 0, 0);
  return cv;
}

// ───────── the level pyramid ─────────

/** Cache key of the level-L tile at page px (X, Y): what is on the page there, the level and the file. */
const tileKey = (page: Page, X: number, Y: number, L: number, file: string) =>
  `${weaveKey(page, null, { x: X, y: Y, w: TILE << L, h: TILE << L }, 1, null).key}|${L}|${file}`;

/** Level L from its four level L−1 quarters (null: outside the page): 2 × 2 box on premultiplied colour. */
function halve(q: (Uint8ClampedArray | null)[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  const H = TILE / 2;
  q.forEach((src, i) => {
    if (!src) return;
    const ox = (i & 1) * H, oy = (i >> 1) * H;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < H; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const s of [((2 * y) * TILE + 2 * x) * 4, ((2 * y) * TILE + 2 * x + 1) * 4, ((2 * y + 1) * TILE + 2 * x) * 4, ((2 * y + 1) * TILE + 2 * x + 1) * 4]) {
          const al = src[s + 3];
          r += src[s] * al;
          g += src[s + 1] * al;
          b += src[s + 2] * al;
          a += al;
        }
        if (!a) continue;
        const o = ((oy + y) * TILE + ox + x) * 4;
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / 4);
      }
  });
  return out;
}

/**
 * The level-L picture at page px (X, Y), from the cache or made now: level 0 composited when `may()` allows, a coarser
 * level from its quarters. Undefined while some level-0 tile has to wait (the work done so far stays cached).
 */
function levelPicture(page: Page, store: CmykTiles, X: number, Y: number, L: number, file: string, may: () => boolean): Uint8ClampedArray | undefined {
  const key = tileKey(page, X, Y, L, file);
  let px = lruGet(pics, key);
  if (px) return px;
  if (L === 0) {
    if (!may()) return undefined;
    px = cmykLevelPixels(page, store, X, Y, 0);
  } else {
    const h = TILE << (L - 1);
    const q: (Uint8ClampedArray | null)[] = [];
    let wait = false;
    for (let i = 0; i < 4; i++) {
      const x = X + (i & 1) * h, y = Y + (i >> 1) * h;
      const sub = x < page.width && y < page.height ? levelPicture(page, store, x, y, L - 1, file, may) : null;
      if (sub === undefined) wait = true;
      q.push(sub ?? null);
    }
    if (wait) return undefined;
    px = halve(q);
  }
  lruPut(pics, key, px, MAX_PICTURES);
  return px;
}

// ───────── background work ─────────

interface Job {
  /** true when done (false: the task's time ran out — run again later) */
  run: () => boolean;
  ready: Set<() => void>;
}
const queue = new Map<string, Job>();
let pumping = false;
let storeLoads = new Map<string, Set<() => void>>();

function pump() {
  if (pumping) return;
  pumping = true;
  setTimeout(() => {
    pumping = false;
    const done = new Set<() => void>();
    for (const [k, j] of queue) {
      if (!budgetLeft()) break;
      let finished = true;
      try {
        finished = j.run();
      } catch {
        // a tile that fails is left to the Canvas2D render
      }
      if (!finished) break;
      queue.delete(k);
      for (const r of j.ready) done.add(r);
    }
    for (const r of done) r();
    if (queue.size) pump();
  }, 0);
}

/** Time budget of the current task for computing tiles (the first tile of a task always goes). */
let taskStart = -1;
function budgetLeft(): boolean {
  const now = performance.now();
  if (taskStart < 0) {
    taskStart = now;
    setTimeout(() => (taskStart = -1), 0);
  }
  return now - taskStart < BUDGET_MS;
}
const always = () => true;

/**
 * The page's CMYK channels; undefined while they are being read in the background — a worker, so neither opening
 * nor the first draw waits (an .omw that stored every tile included) — `sync`: read now (exports).
 */
function storeFor(doc: OmwDocument, page: Page, sync: boolean, ready: () => void): CmykTiles | null | undefined {
  const s = cmykStoreOf(doc, page, sync);
  if (s !== undefined) return s;
  const id = doc.assets[page.source?.psd?.assetId ?? ""]?.hash ?? "";
  let waiting = storeLoads.get(id);
  if (!waiting) {
    storeLoads.set(id, (waiting = new Set()));
    const done = () => {
      const w = storeLoads.get(id);
      storeLoads.delete(id);
      w?.forEach((r) => r());
    };
    cmykStoreLater(doc, page).then(done, done);
  }
  waiting.add(ready);
  return undefined;
}

/**
 * Paint `region` (page units) of a CMYK page into `c` (mapping page → device already set, page clip and background
 * done) from the CMYK composite. False when the page does not take this path, or (not `sync`) when its tiles are not
 * all ready — then the caller draws as usual and `env.incomplete` asks for a repaint. `sync`: compute everything now.
 */
export function paintCmykRegion(c: Ctx, doc: OmwDocument, page: Page, region: Rect, scale: number, env: DrawEnv, sync = false): boolean {
  if (!page.source?.psd || !cmykComposable(page)) return false;
  const store = storeFor(doc, page, sync, env.onResourceReady);
  if (store === null) return false;
  if (store === undefined) {
    env.incomplete = true;
    return false;
  }
  const L = cmykLevel(scale), S = TILE << L;
  // the channels come from the file: its hash keeps two documents with the same layers but other files apart
  const file = doc.assets[page.source.psd.assetId]?.hash ?? "";
  const x0 = Math.max(0, Math.floor(region.x / S)), y0 = Math.max(0, Math.floor(region.y / S));
  const x1 = Math.min(Math.ceil(page.width / S), Math.ceil((region.x + region.w) / S));
  const y1 = Math.min(Math.ceil(page.height / S), Math.ceil((region.y + region.h) / S));
  const tiles: [Cv, number, number][] = [];
  let missing = false;
  for (let ty = y0; ty < y1; ty++)
    for (let tx = x0; tx < x1; tx++) {
      const X = tx * S, Y = ty * S;
      const key = tileKey(page, X, Y, L, file);
      let cv = lruGet(lru, key);
      if (!cv) {
        const px = levelPicture(page, store, X, Y, L, file, sync ? always : budgetLeft);
        if (px) lruPut(lru, key, (cv = tileCanvas(px)), MAX_TILES);
      }
      if (cv) tiles.push([cv, X, Y]);
      else {
        missing = true;
        // the job holds this state's page: what it makes is cached under this state's keys, never drawn for another
        let job = queue.get(key);
        if (!job)
          queue.set(key, (job = {
            run: () => {
              if (lru.has(key)) return true;
              const px = levelPicture(page, store, X, Y, L, file, budgetLeft);
              if (px) lruPut(lru, key, tileCanvas(px), MAX_TILES);
              return !!px;
            },
            ready: new Set(),
          }));
        job.ready.add(env.onResourceReady);
      }
    }
  if (missing) {
    pump();
    env.incomplete = true;
    return false;
  }
  c.save();
  // whole page pixels stay crisp when magnified, as raster layers do (draw.ts)
  c.imageSmoothingEnabled = scale * (1 << L) < 1;
  for (const [cv, X, Y] of tiles) c.drawImage(cv as CanvasImageSource, X, Y, S, S);
  c.restore();
  return true;
}

// ───────── sampling (wand, eyedropper — ui/pixelSelect.ts) ─────────

/**
 * The CMYK composite of 256 px page tile (tx, ty), straight RGBA — what the screen shows there at 100 %: from the
 * screen's cache or composited now (one tile). Null when the page does not take the CMYK path; undefined while its
 * channels are being read (`ready` is called when they are there).
 */
export function cmykSampleTile(doc: OmwDocument, page: Page, tx: number, ty: number, ready: () => void): Uint8ClampedArray | null | undefined {
  if (!page.source?.psd || !cmykComposable(page)) return null;
  const store = storeFor(doc, page, false, ready);
  if (!store) return store;
  const file = doc.assets[page.source.psd.assetId]?.hash ?? "";
  return levelPicture(page, store, tx * TILE, ty * TILE, 0, file, always)!;
}

/** Does sampling this page (all layers) need the CMYK composite (`cmykSampleTile`)? False for every RGB page. */
export function cmykSampled(doc: OmwDocument, page: Page): boolean {
  return !!page.source?.psd && cmykComposable(page) && cmykStoreOf(doc, page, false) !== null;
}

/** A document closed: forget the channels, tiles and pending work of PSD files no open document uses (by file hash). */
export function releaseCmyk(inUse: ReadonlySet<string>) {
  releaseCmykFiles((h) => inUse.has(h));
  const gone = (k: string) => !inUse.has(k.slice(k.lastIndexOf("|") + 1));
  for (const m of [lru, pics, queue] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (gone(k)) m.delete(k);
}

/** Drop cached tiles and pending work (tests). */
export function resetCmykView() {
  lru.clear();
  pics.clear();
  queue.clear();
  storeLoads = new Map();
}