// PSD self-scoring in the app: schedules a scoring run for the PSD page on screen (fidelity worker, one at a time,
// cancelled when its page goes away), keeps the result in page.source.psdScore (so a reopened .omw does not
// recompute) and draws the fidelity overlay — Photoshop's merged image on the tiles we do not render the same,
// until the layers there are edited — and the "show differences" heat map. Drawn on the screen canvas only:
// exports, thumbnails and saved files never contain it.

import { produce } from "immer";
import { create } from "zustand";
import { getBlob } from "../core/assets";
import { buildCache, compositeOverlayable, liveTiles, type PsdScoreCache } from "../core/fidelity/overlay";
import { heatGrid, SCORE_VERSION, type PsdScore } from "../core/fidelity/psdScore";
import { startScore, type ScoreJob } from "../core/fidelity/run";
import { findPage, useStore, type View } from "../core/store";
import type { Page } from "../core/types";
import { makeCanvas, ctx2d, tileCanvas } from "../render/draw";

interface FidelityState {
  /** draw the mismatch heat map over the page */
  heat: boolean;
  /** show Photoshop's merged image on mismatching, unedited tiles */
  overlay: boolean;
  /** page id → 0..1 while a run is going */
  progress: Record<string, number>;
  /** bumps when a score arrives (the badge re-reads) */
  epoch: number;
  set: (p: Partial<FidelityState>) => void;
}

export const useFidelity = create<FidelityState>((set) => ({ heat: false, overlay: true, progress: {}, epoch: 0, set: (p) => set(p) }));

/** Scores by page id + file hash, also kept outside the document (undo to a state from before the score arrived). */
const memo = new Map<string, PsdScoreCache>();
const failed = new Set<string>();
let job: { key: string; pageId: string; hash: string; job: ScoreJob } | null = null;
let repaint: (() => void) | null = null;

/** The PSD source of a page that can be scored (layers drawn + a hidden merged image), or null. */
function psdOf(page: Page) {
  const p = page.source?.psd;
  return p && p.compositeNode ? p : null;
}

const keyOf = (page: Page, hash: string) => `${page.id}|${hash}`;

/** The current score of a PSD page (finished, or partial while running); null when none yet. */
export function scoreOf(page: Page): PsdScoreCache | null {
  const p = page.source?.psd;
  if (!p) return null;
  const s = page.source?.psdScore;
  if (s && s.hash === p.hash && s.v === SCORE_VERSION) return s;
  return memo.get(keyOf(page, p.hash)) ?? null;
}

/** A PSD page this module scores (shows the badge). */
export const isScorable = (page: Page | undefined): page is Page => !!page && !!page.source?.psd;

function attach(pageId: string, cache: PsdScoreCache) {
  const s = useStore.getState();
  const page = findPage(s.doc, pageId);
  if (!page) return;
  memo.set(keyOf(page, cache.hash), cache);
  if (!cache.partial) {
    // into the document without an undo step and without marking it unsaved (a view cache, recomputable)
    const doc = produce(s.doc, (d) => {
      const p = d.pages.find((q) => q.id === pageId);
      if (p?.source) p.source.psdScore = cache;
    });
    useStore.setState({ doc });
  }
  useFidelity.setState((f) => ({ epoch: f.epoch + 1 }));
  repaint?.();
}

/** Start scoring `page` unless it has a score, is being scored or failed before (`force`: score again). */
export function ensureScore(page: Page, force = false): void {
  const p = psdOf(page);
  if (!p) return;
  const key = keyOf(page, p.hash);
  if (job?.key === key) return;
  const have = scoreOf(page);
  if (!force && ((have && !have.partial) || failed.has(key))) return;
  const doc = useStore.getState().doc;
  const asset = doc.assets[p.assetId];
  const bytes = asset ? getBlob(asset.hash) : undefined;
  if (!bytes) return;
  job?.job.cancel();
  failed.delete(key);
  if (force) memo.delete(key);
  const pageId = page.id;
  const alive = () => {
    const cur = findPage(useStore.getState().doc, pageId);
    return !!cur && cur.source?.psd?.hash === p.hash;
  };
  const j = startScore(bytes, (done, total, partial) => {
    // a superseded run (a message queued before terminate, or the fallback's last row) touches nothing
    if (job?.job !== j) return;
    if (!alive()) return cancelScore();
    useFidelity.setState((f) => ({ progress: { ...f.progress, [pageId]: done / total } }));
    const cur = findPage(useStore.getState().doc, pageId);
    if (cur) attach(pageId, buildCache(cur, { score: partial, layerBounds: [] }, p.hash, true));
  });
  job = { key, pageId, hash: p.hash, job: j };
  const finish = () => {
    if (job?.job === j) job = null;
    useFidelity.setState((f) => {
      const { [pageId]: _, ...rest } = f.progress;
      return { progress: rest };
    });
  };
  j.promise.then(
    (run) => {
      finish();
      const cur = findPage(useStore.getState().doc, pageId);
      if (!run || !cur || !alive()) return;
      attach(pageId, buildCache(cur, run, p.hash));
    },
    () => {
      const current = job?.job === j;
      finish();
      if (!current) return;
      failed.add(key);
      memo.set(key, { ...noScore(p.hash), track: { layers: [], order: "", groups: "", page: "", composite: "" } });
      useFidelity.setState((f) => ({ epoch: f.epoch + 1 }));
    },
  );
}

const noScore = (hash: string): PsdScore => ({ v: SCORE_VERSION, status: "none", reason: "error", hash, width: 0, height: 0, tile: 256, cols: 0, rows: 0, within2: 0, ssim: 0, max: 0, mean: 0, bad: [], done: 0, ms: 0 });

/** Repaint the canvas after a view switch (heat map, overlay) that changes no document state. */
export function repaintFidelity(): void {
  repaint?.();
}

export function cancelScore(): void {
  if (!job) return;
  const { pageId } = job;
  job.job.cancel();
  job = null;
  memo.forEach((v, k) => v.partial && k.startsWith(pageId + "|") && memo.delete(k));
  useFidelity.setState((f) => {
    const { [pageId]: _, ...rest } = f.progress;
    return { progress: rest };
  });
}

// The run goes away with its page or document, also before its first progress message (decoding a big PSB takes
// seconds and its memory is held until the worker is terminated).
useStore.subscribe((s, prev) => {
  if (!job || s.doc === prev.doc) return;
  const cur = findPage(s.doc, job.pageId);
  if (!cur || cur.source?.psd?.hash !== job.hash) cancelScore();
});

const heatCanvases = new WeakMap<PsdScore, ReturnType<typeof makeCanvas> | null>();

function heatCanvas(s: PsdScore) {
  if (heatCanvases.has(s)) return heatCanvases.get(s)!;
  const g = heatGrid(s);
  let c: ReturnType<typeof makeCanvas> | null = null;
  if (g && s.heat) {
    const { w, h } = s.heat;
    c = makeCanvas(w, h);
    const img = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      if (g[i] <= 2) continue;
      const v = Math.min(1, g[i] / 32);
      img.data.set([Math.round(255 * Math.min(1, v * 3)), Math.round(255 * Math.min(1, Math.max(0, v * 3 - 1))), Math.round(255 * Math.max(0, v * 3 - 2)), 200], i * 4);
    }
    ctx2d(c).putImageData(img, 0, 0);
  }
  heatCanvases.set(s, c);
  return c;
}

/**
 * Canvas hook (ui/CanvasView.tsx, after the page render): the fidelity overlay and the heat map. Also starts the
 * scoring run for a PSD page that has no score yet. `c` is the screen canvas in device pixels.
 */
export function drawFidelity(c: CanvasRenderingContext2D, page: Page, master: Page | null, view: View, dpr: number, invalidate: () => void): void {
  repaint = invalidate;
  if (!psdOf(page)) return;
  const sc = scoreOf(page);
  if (!sc || sc.partial) {
    if (!job || job.pageId !== page.id) setTimeout(() => {
      const cur = findPage(useStore.getState().doc, page.id);
      if (cur) ensureScore(cur);
    });
  }
  if (!sc || sc.status !== "ok") return;
  const f = useFidelity.getState();
  if (!f.overlay && !f.heat) return;
  const { zoom, panX, panY } = view;
  const T = sc.tile;
  // visible page area → tile range
  const vx0 = -panX / zoom, vy0 = -panY / zoom;
  const vx1 = vx0 + c.canvas.width / dpr / zoom, vy1 = vy0 + c.canvas.height / dpr / zoom;
  const inView = (i: number) => {
    const x = (i % sc.cols) * T, y = Math.floor(i / sc.cols) * T;
    return x < vx1 && x + T > vx0 && y < vy1 && y + T > vy0;
  };
  const live = liveTiles(page, sc);
  c.save();
  c.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
  const comp = page.nodes.find((n) => n.id === sc.track.composite);
  if (f.overlay && !master && compositeOverlayable(comp)) {
    c.imageSmoothingEnabled = zoom < 1;
    for (const i of live.shown) {
      if (!inView(i)) continue;
      const tx = i % sc.cols, ty = Math.floor(i / sc.cols);
      const w = Math.min(T, page.width - tx * T), h = Math.min(T, page.height - ty * T);
      c.save();
      c.beginPath();
      c.rect(tx * T, ty * T, w, h);
      c.clip();
      c.fillStyle = page.background;
      c.fillRect(tx * T, ty * T, w, h);
      const tile = comp.tiles[`${tx}_${ty}`];
      if (tile) c.drawImage(tileCanvas(tile), tx * T, ty * T);
      c.restore();
    }
  }
  if (f.heat) {
    const hc = heatCanvas(sc);
    if (hc && sc.heat) {
      c.imageSmoothingEnabled = false;
      c.drawImage(hc as CanvasImageSource, 0, 0, sc.heat.w * sc.heat.block, sc.heat.h * sc.heat.block);
    }
    c.lineWidth = 1.5 / zoom;
    c.strokeStyle = "rgba(43,116,236,.9)";
    for (const i of live.shown) if (inView(i)) c.strokeRect((i % sc.cols) * T, Math.floor(i / sc.cols) * T, T, T);
    c.setLineDash([4 / zoom, 4 / zoom]);
    c.strokeStyle = "rgba(160,160,160,.9)";
    for (const i of live.edited) if (inView(i)) c.strokeRect((i % sc.cols) * T, Math.floor(i / sc.cols) * T, T, T);
  }
  c.restore();
}
