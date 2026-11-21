// Weave Cache renderer.
//
// The viewport is covered by 256-device-pixel tiles at a quantized zoom level. Each tile's
// identity is its weave key (see core/loom.ts): a hash of the content threads that touch
// it. A tile is painted at most once per key and kept in an LRU; there is no dirty
// tracking anywhere, so stale pixels are impossible by construction.

import type { Rect } from "../core/geom";
import { pageEffectReach, weaveKey } from "../core/loom";
import type { OmwDocument, Page, SceneNode } from "../core/types";
import { paintNodes } from "./compose";
import { crisp } from "./crisp";
import { ctx2d, makeCanvas, setCadInk, type Ctx, type DrawEnv } from "./draw";
import { pristinePsdView } from "../core/fidelity/overlay";
import { paintSheetPage } from "./sheet";
import { paintCmykRegion } from "./cmykView";
import { dissolveReady, loadDissolveField, pageDissolves } from "../core/style/blend";

const WT = 256; // device pixels per weave tile

interface Entry {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  /** an opaque tile (alpha:false context): glyphs get LCD (ClearType-style) anti-aliasing */
  opaque: boolean;
}

export interface WeaveStats {
  hits: number;
  misses: number;
  tiles: number;
  cached: number;
  ms: number;
}

export class WeaveCache {
  private lru = new Map<string, Entry>();
  private pool: (OffscreenCanvas | HTMLCanvasElement)[] = [];
  private opaquePool: (OffscreenCanvas | HTMLCanvasElement)[] = [];
  constructor(private maxTiles = 1600) {} // 1600 * 256KB ≈ 400MB worst case

  get size() {
    return this.lru.size;
  }

  private take(opaque: boolean): OffscreenCanvas | HTMLCanvasElement {
    if (!opaque) return this.pool.pop() ?? makeCanvas(WT, WT);
    const c = this.opaquePool.pop();
    if (c) return c;
    const cv = makeCanvas(WT, WT);
    // the context's alpha option is fixed by its first getContext: ctx2d(cv) later returns this opaque one
    cv.getContext("2d", { alpha: false });
    return cv;
  }

  /** a free tile back to its pool; the pools stay small, so switching between opaque and transparent pages
   *  does not keep a full cache's worth of the other kind alive beside the LRU */
  private give(e: Entry) {
    const p = e.opaque ? this.opaquePool : this.pool;
    if (p.length < WeaveCache.POOL_MAX) p.push(e.canvas);
  }
  static readonly POOL_MAX = 64;

  /** canvases held by the cache (LRU + both pools), for the memory check in tests */
  get canvases() {
    return this.lru.size + this.pool.length + this.opaquePool.length;
  }

  private get(key: string): Entry | undefined {
    const e = this.lru.get(key);
    if (e) {
      this.lru.delete(key);
      this.lru.set(key, e);
    }
    return e;
  }

  private put(key: string, e: Entry) {
    this.lru.set(key, e);
    while (this.lru.size > this.maxTiles) {
      const [k, old] = this.lru.entries().next().value as [string, Entry];
      this.lru.delete(k);
      this.give(old);
    }
  }

  clear() {
    this.lru.clear();
  }

  // zoom settling (docs/design/RENDER_CRISPNESS.md): tiles are painted at the exact device zoom, so
  // they blit 1:1 and glyphs / hairlines are rasterized once at their final size. Only while the zoom
  // keeps changing (a wheel or pinch gesture) do frames use quarter-octave tiles, which are reused
  // across nearby zooms and resampled on blit; SETTLE_MS after the last change the exact tiles follow.
  private zoomNow = 0;
  private zoomChanged = -Infinity;
  private zoomExact = true;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  static readonly SETTLE_MS = 160;

  /** Device pixels per page unit to paint tiles at for this frame. */
  tileScale(devZoom: number, repaint: () => void): number {
    if (!crisp.exactTiles) return quantizeZoom(devZoom);
    const now = performance.now();
    if (devZoom !== this.zoomNow) {
      // a single change after a rest (zoom menu, fit, one wheel step) paints exact at once; a change
      // that follows another within SETTLE_MS is part of a gesture
      this.zoomExact = this.zoomNow === 0 || now - this.zoomChanged >= WeaveCache.SETTLE_MS;
      this.zoomNow = devZoom;
      this.zoomChanged = now;
    }
    const wait = this.zoomExact ? 0 : WeaveCache.SETTLE_MS - (now - this.zoomChanged);
    if (wait <= 0) return devZoom;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(repaint, wait + 4);
    return quantizeZoom(devZoom);
  }

  /**
   * Paint `page` into the screen context. view: page->screen is (p * zoom + pan) in CSS px.
   * `area`: the page-space area painted (default the page). The drawing screen passes an unbounded one: model
   * space has no edge, so what is drawn beyond the imported extents shows too (QA 2026-11-19 1-2).
   */
  render(
    screen: CanvasRenderingContext2D,
    doc: OmwDocument,
    page: Page,
    master: Page | null,
    view: { zoom: number; panX: number; panY: number },
    cssW: number,
    cssH: number,
    dpr: number,
    exclude: Set<string> | null,
    onResourceReady: () => void,
    area?: Rect,
  ): WeaveStats {
    const t0 = performance.now();
    const stats: WeaveStats = { hits: 0, misses: 0, tiles: 0, cached: 0, ms: 0 };
    const devZoom = view.zoom * dpr;
    const q = this.tileScale(devZoom, onResourceReady);
    const worldTile = WT / q;

    // visible page-space rect, clipped to page
    const A = area ?? { x: 0, y: 0, w: page.width, h: page.height };
    const vx0 = Math.max(A.x, -view.panX / view.zoom), vy0 = Math.max(A.y, -view.panY / view.zoom);
    const vx1 = Math.min(A.x + A.w, (cssW - view.panX) / view.zoom), vy1 = Math.min(A.y + A.h, (cssH - view.panY) / view.zoom);
    if (vx1 <= vx0 || vy1 <= vy0) return stats;

    const tx0 = Math.floor(vx0 / worldTile), ty0 = Math.floor(vy0 / worldTile);
    const tx1 = Math.floor((vx1 - 1e-6) / worldTile), ty1 = Math.floor((vy1 - 1e-6) / worldTile);
    screen.imageSmoothingEnabled = true;
    screen.imageSmoothingQuality = "high";
    // Opaque tiles on an opaque page background: Chrome / WebView2 then draw glyphs with LCD
    // (subpixel, ClearType-like) anti-aliasing as in DOM text; a transparent canvas only gets grayscale.
    // The tiles' area outside the page is not painted, so the blits are clipped to the page frame.
    const opaque = crisp.lcdText && isOpaqueColor(page.background);
    screen.save();
    if (opaque) {
      const fx0 = Math.round((view.panX + vx0 * view.zoom) * dpr), fy0 = Math.round((view.panY + vy0 * view.zoom) * dpr);
      screen.beginPath();
      screen.rect(fx0, fy0, Math.round((view.panX + vx1 * view.zoom) * dpr) - fx0, Math.round((view.panY + vy1 * view.zoom) * dpr) - fy0);
      screen.clip();
    }

    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        stats.tiles++;
        const region: Rect = { x: tx * worldTile, y: ty * worldTile, w: worldTile, h: worldTile };
        const wk = weaveKey(page, master, region, q, exclude);
        const nodes = wk.nodes;
        const key = (opaque ? wk.key + "|o" : wk.key) + (area ? `|a${A.x},${A.y},${A.w},${A.h}` : "");
        let e = this.get(key);
        if (e) stats.hits++;
        else {
          stats.misses++;
          const canvas = this.take(opaque);
          const c = ctx2d(canvas);
          // effects reach into the tile from outside it: raster layers draw the tiles within that reach too
          const r = pageEffectReach(page);
          const env: DrawEnv = { doc, clip: r ? { x: region.x - r, y: region.y - r, w: region.w + 2 * r, h: region.h + 2 * r } : region, scale: q, incomplete: false, onResourceReady, screen: true };
          setCadInk(!!page.source?.cad);
          try {
            paintRegion(c, page, region, q, nodes, env, master, opaque, !exclude?.size, area);
          } finally {
            setCadInk(false);
          }
          e = { canvas, opaque };
          if (!env.incomplete) this.put(key, e);
          else this.give(e); // will be repainted when resources arrive
          // still blit the incomplete tile this frame
        }
        // screen device-pixel rect, snapped to whole pixels to avoid seams
        const sx0 = Math.round((region.x * view.zoom + view.panX) * dpr);
        const sy0 = Math.round((region.y * view.zoom + view.panY) * dpr);
        const sx1 = Math.round(((region.x + worldTile) * view.zoom + view.panX) * dpr);
        const sy1 = Math.round(((region.y + worldTile) * view.zoom + view.panY) * dpr);
        screen.drawImage(e.canvas, 0, 0, WT, WT, sx0, sy0, sx1 - sx0, sy1 - sy0);
      }
    screen.restore();
    stats.cached = this.lru.size;
    stats.ms = performance.now() - t0;
    return stats;
  }
}

const opaqueMemo = new Map<string, boolean>();
/** A CSS colour with full alpha (memoized; measured on a 1×1 canvas so every CSS colour form works). */
export function isOpaqueColor(css: string): boolean {
  let v = opaqueMemo.get(css);
  if (v === undefined) {
    v = false;
    try {
      const c = makeCanvas(1, 1);
      const g = c.getContext("2d", { willReadFrequently: true }) as Ctx | null;
      if (g) {
        // an unparsable colour leaves fillStyle as it was: start from transparent so it is not taken as opaque black
        g.fillStyle = "rgba(0,0,0,0)";
        g.fillStyle = css;
        g.fillRect(0, 0, 1, 1);
        v = g.getImageData(0, 0, 1, 1).data[3] === 255;
      }
    } catch {
      v = false;
    }
    opaqueMemo.set(css, v);
  }
  return v;
}

/** Quarter-octave zoom (tiles reused across nearby zooms during a zoom gesture, resampled on blit). */
export function quantizeZoom(devZoom: number): number {
  return Math.pow(2, Math.round(Math.log2(devZoom) * 4) / 4);
}

/**
 * Paint one page region at scale q into a WT×WT tile (`nodes`: the tile's nodes from weaveKey). `cmyk`: a CMYK PSD
 * page may be drawn from its CMYK composite (render/cmykView.ts) — not while some nodes are left out (`exclude`).
 */
export function paintRegion(c: Ctx, page: Page, region: Rect, q: number, nodes: Page["nodes"], env: DrawEnv, master: Page | null = null, opaque = false, cmyk = true, area?: Rect) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, WT, WT);
  if (opaque) {
    // the whole tile in the page colour, so the page's own edge pixels do not mix with the tile's black
    // outside (that outside is clipped away on blit)
    c.fillStyle = page.background;
    c.fillRect(0, 0, WT, WT);
  }
  c.setTransform(q, 0, 0, q, -region.x * q, -region.y * q);
  c.save();
  c.beginPath();
  if (area) {
    // clip to the area within this tile (an unbounded area has no finite rect of its own)
    const x0 = Math.max(area.x, region.x), y0 = Math.max(area.y, region.y);
    c.rect(x0, y0, Math.min(area.x + area.w, region.x + region.w) - x0, Math.min(area.y + area.h, region.y + region.h) - y0);
  } else c.rect(0, 0, page.width, page.height);
  c.clip();
  c.fillStyle = page.background;
  c.fillRect(region.x, region.y, region.w, region.h);
  waitForDissolve(page, env);
  if (cmyk && !master && paintCmykRegion(c, env.doc, page, region, q, env)) {
    c.restore();
    return;
  }
  const inTile = new Set(nodes);
  const include = (n: SceneNode) => inTile.has(n);
  if (master) paintNodes(c, master.nodes, master.groups, env, include);
  paintNodes(c, page.nodes, page.groups, env, include);
  c.restore();
}

/** Uncached full-page paint (thumbnails, export, presentation). */
export function paintPage(
  c: Ctx,
  doc: OmwDocument,
  page: Page,
  master: Page | null,
  scale: number,
  overrides?: Map<string, import("../core/anim").NodeOverride>,
  onResourceReady: () => void = () => {},
  /**
   * a picture that may come later (thumbnails): a CMYK page's composite is computed in the background meanwhile;
   * "rgb": the layers as drawn without it (the caller patches in the composite where it needs it — sampling)
   */
  later: boolean | "rgb" = false,
): boolean {
  const env: DrawEnv = { doc, clip: { x: 0, y: 0, w: page.width, h: page.height }, scale, incomplete: false, onResourceReady };
  c.save();
  c.scale(scale, scale);
  c.beginPath();
  c.rect(0, 0, page.width, page.height);
  c.clip();
  c.fillStyle = page.background;
  c.fillRect(0, 0, page.width, page.height);
  if (master) paintNodes(c, master.nodes, master.groups, env, null);
  // a sheet page (표 계산): the top-left of the sheet as it prints (thumbnails, page pictures)
  if (page.sheet) paintSheetPage(c as CanvasRenderingContext2D, page.sheet, page.width, page.height);
  // an unedited PSD page: Photoshop's merged image (thumbnails, PNG export, slide show — core/fidelity/overlay.ts)
  const view = overrides?.size ? null : pristinePsdView(page);
  waitForDissolve(view ?? page, env);
  // an edited CMYK PSD page that blends: its CMYK composite, computed now — or (`later`) in the background
  // (render/cmykView.ts)
  if (view || overrides?.size || master || later === "rgb" || !paintCmykRegion(c, doc, page, { x: 0, y: 0, w: page.width, h: page.height }, scale, env, !later))
    paintNodes(c, (view ?? page).nodes, (view ?? page).groups, env, null, overrides);
  c.restore();
  return !env.incomplete;
}

/** A page that dissolves before the dissolve thresholds are here: drawn now, again once they are (core/style/blend.ts). */
function waitForDissolve(page: Page, env: DrawEnv) {
  if (dissolveReady() || !pageDissolves(page)) return;
  env.incomplete = true;
  loadDissolveField().then(env.onResourceReady, () => {});
}

export function renderPageCanvas(doc: OmwDocument, page: Page, master: Page | null, scale: number, later: boolean | "rgb" = false) {
  const cv = makeCanvas(page.width * scale, page.height * scale);
  paintPage(ctx2d(cv), doc, page, master, scale, undefined, () => {}, later);
  return cv;
}
