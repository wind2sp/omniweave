// Person matting for background removal: MODNet (ZHKKKe/MODNet, Apache-2.0 — public/models/matte/LICENSE), converted
// by scripts/convert-modnet.mjs to an LWT1 graph (int8 per output channel, 6.6 MB) and shipped with the app in
// models/matte/ (no download). Loaded on first use, only for pictures that look like a person (below).
//
// Why: U²-Netp finds "the subject"; on real photos of people it often keeps the head and hair and loses most of the
// body (CC0 street portraits, 2026-11-25 model comparison). MODNet is trained for people
// only — on a person it keeps the whole body with clean hair edges; on a cup or a shoe it fails. So it is used only when
// the picture is a person photo:
//   1. candidate — U²-Netp's subject (its saliency map, already computed for the classifier) looks like a person:
//      skin in the upper part of the subject, and the subject reaching the picture's lower edge (portrait framing);
//      or the user chose the "portrait" type;
//   2. confirmed — MODNet's own matte passes the same test (a person in frame) and covers a sensible part of the
//      picture. Otherwise the U²-Netp result stands.
// The matte replaces the saliency map in the usual chain (guided filter, hints, edge controls, decontamination).

import { parseGraph, runGraph, runGraphAsync, type GraphModel, type Tensor } from "../infer/graph";
import { convPool } from "../infer/convPool";
import { graphGpu, graphGpuAvailable } from "../infer/graphGpu";
import type { Img } from "../pixels";
import { components, type MatteHint } from "./hints";

export const MODNET_FILE = "modnet.lwt";
/** side of the square map handed to the matte chain (the saliency map is 320; MODNet's detail needs more) */
export const PERSON_SIDE = 512;

let pageBase: string | undefined;
/** The app page's base URL (the image worker's own location is its script, where models/ is not). */
export function setMatteModelBase(base: string | undefined) {
  if (base) pageBase = base;
}
function modelUrl(file: string): string {
  const g = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };
  const base = pageBase ?? g.document?.baseURI ?? g.location?.href;
  return base ? new URL(`models/matte/${file}`, base).href : `models/matte/${file}`;
}

let model: Promise<GraphModel | null> | null = null;
/** the model file (the conv pool's workers parse their own copy) */
let modelBytes: ArrayBuffer | null = null;
let reader: ((file: string) => Promise<Uint8Array>) | null = null;
/** Tests: read the model file from disk (null: fetch as the app does). */
export function setMatteModelReader(r: ((file: string) => Promise<Uint8Array>) | null) {
  reader = r;
  model = null;
  cache.length = 0;
}
/** The model, or null when it cannot be loaded (missing file: background removal goes on with U²-Netp). */
function load(): Promise<GraphModel | null> {
  model ??= (async () => {
    try {
      if (reader) {
        const b = await reader(MODNET_FILE);
        modelBytes = b.slice().buffer as ArrayBuffer;
        return parseGraph(b);
      }
      const res = await fetch(modelUrl(MODNET_FILE));
      if (!res.ok) throw new Error(`${MODNET_FILE}: HTTP ${res.status}`);
      modelBytes = await res.arrayBuffer();
      return parseGraph(new Uint8Array(modelBytes));
    } catch (e) {
      // (not kept: the next picture tries again — a failed first fetch must not turn the person model off for good)
      console.warn("person matting model not loaded:", e);
      model = null;
      return null;
    }
  })();
  return model;
}

// ---------- the person test (on a matte of any square size) ----------

/** a common RGB skin rule (any skin tone under ordinary light; person.ts uses the same) */
const isSkin = (r: number, g: number, b: number) => r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15;

export interface PersonStats {
  /** part of the picture kept */
  area: number;
  /** the kept region reaches the lower edge */
  bottom: boolean;
  /** skin among the kept pixels of the region's upper 40 % */
  skin: number;
  /** the kept region's top, as a part of the picture height */
  top: number;
}

/** How much a matte (`side` × `side`, 0..1, over the whole picture) looks like a person in frame. */
export function personStats(img: Img, map: Float32Array, side: number, thr = 0.5): PersonStats {
  const W = img.width, H = img.height, d = img.data;
  let kept = 0, y0 = side, y1 = -1;
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++)
      if (map[y * side + x] >= thr) {
        kept++;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (!kept) return { area: 0, bottom: false, skin: 0, top: 1 };
  let bottomKept = 0;
  for (let x = 0; x < side; x++) if (map[(side - 1) * side + x] >= thr || map[(side - 2) * side + x] >= thr) bottomKept++;
  const yTop = y0 + Math.max(1, Math.round((y1 - y0 + 1) * 0.4));
  let n = 0, skin = 0;
  for (let y = y0; y < yTop; y++)
    for (let x = 0; x < side; x++) {
      if (map[y * side + x] < thr) continue;
      n++;
      const px = Math.min(W - 1, Math.floor(((x + 0.5) * W) / side)), py = Math.min(H - 1, Math.floor(((y + 0.5) * H) / side));
      const i = (py * W + px) * 4;
      if (isSkin(d[i], d[i + 1], d[i + 2])) skin++;
    }
  return { area: kept / (side * side), bottom: bottomKept >= side * 0.04, skin: n ? skin / n : 0, top: y0 / side };
}

/** A person in frame: a head with skin at the top of the kept region, the body running out at the lower edge. */
// (skin under 85 % of the upper part: a face with hair, collar, background between — a tan or orange animal's fur is
//  skin-coloured all over: 0.96 on the drawn test animals)
export const looksLikePerson = (s: PersonStats) => s.area >= 0.03 && s.area <= 0.9 && s.bottom && s.skin >= 0.08 && s.skin <= 0.85 && s.top < 0.6;

// ---------- running the model ----------

/**
 * Short side of MODNet's input: 512 as MODNet's own demo — and on the GPU everywhere. On a phone's CPU 320 (0.39× the
 * work: the CC0 street portraits came out within IoU 0.987 / mean alpha error 0.005 of the 512 matte; 384: 0.999 /
 * 0.001 at 0.56×). The result shows after the subject model's own, so the wait is for a better edge, not for a result.
 */
const onPhone = () => /Android|iPhone|iPad|iPod|Mobile/i.test((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "");
let refSet: number | null = null;
/** Tests: a fixed short side (null: by device) */
export function setModnetRef(v: number | null) {
  refSet = v;
  cache.length = 0;
}
const refFor = (gpu: boolean) => refSet ?? (gpu || !onPhone() ? 512 : 320);

let gpuOff = false;
/** the GPU checked once against the CPU on a small picture (a software or broken adapter can run the shaders and
 *  still give other numbers): null = not yet */
let gpuChecked: Promise<boolean> | null = null;
function gpuAgrees(m: GraphModel, g: { run(x: Tensor): Promise<Tensor> }): Promise<boolean> {
  gpuChecked ??= (async () => {
    const s = [1, 3, 64, 96], d = new Float32Array(3 * 64 * 96);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 0.37) * 0.9;
    try {
      const a = runGraph(m, { s, d: d.slice() }), b = await g.run({ s, d: d.slice() });
      let mx = 0;
      for (let i = 0; i < a.d.length; i++) mx = Math.max(mx, Math.abs(a.d[i] - b.d[i]));
      if (!(mx < 1e-3)) console.warn("person matting model: the GPU's result differs from the CPU's (" + mx + "), using the CPU");
      return mx < 1e-3;
    } catch {
      return false;
    }
  })();
  return gpuChecked;
}

/** MODNet's input size for a picture: short side 512 (when the picture is not already within it), multiples of 32 */
export function modnetSize(W: number, H: number, ref = refFor(false)): { w: number; h: number } {
  let w = W, h = H;
  if (Math.max(H, W) < ref || Math.min(H, W) > ref) {
    if (W >= H) (h = ref), (w = Math.floor((W / H) * ref));
    else (w = ref), (h = Math.floor((H / W) * ref));
  }
  // very long pictures: at most 1024 on the long side (time and memory on phones)
  const k = Math.min(1, 1024 / Math.max(w, h));
  w = Math.max(32, Math.floor((w * k) / 32) * 32);
  h = Math.max(32, Math.floor((h * k) / 32) * 32);
  return { w, h };
}

/** bilinear sample of the picture into MODNet's input, (v − 0.5) / 0.5 */
function input(img: Img, w: number, h: number): Float32Array {
  const W = img.width, H = img.height, d = img.data, x = new Float32Array(3 * w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(H - 1, (y + 0.5) * (H / h) - 0.5)), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), wy = fy - y0;
    for (let xx = 0; xx < w; xx++) {
      const fx = Math.max(0, Math.min(W - 1, (xx + 0.5) * (W / w) - 0.5)), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (a: number, b: number) => d[(a * W + b) * 4 + c];
        const v = ((p(y0, x0) * (1 - wx) + p(y0, x1) * wx) * (1 - wy) + (p(y1, x0) * (1 - wx) + p(y1, x1) * wx) * wy) / 255;
        x[c * w * h + y * w + xx] = (v - 0.5) / 0.5;
      }
    }
  }
  return x;
}

/** resample a w × h plane to side × side (bilinear) */
function toSquare(p: Float32Array, w: number, h: number, side: number): Float32Array {
  const o = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    const fy = Math.max(0, Math.min(h - 1, (y + 0.5) * (h / side) - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < side; x++) {
      const fx = Math.max(0, Math.min(w - 1, (x + 0.5) * (w / side) - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), wx = fx - x0;
      o[y * side + x] = (p[y0 * w + x0] * (1 - wx) + p[y0 * w + x1] * wx) * (1 - wy) + (p[y1 * w + x0] * (1 - wx) + p[y1 * w + x1] * wx) * wy;
    }
  }
  return o;
}

/** a cheap fingerprint of a picture (the preview and the apply of one dialog share the matte) */
function fingerprint(img: Img): string {
  const d = img.data;
  let h = 2166136261 >>> 0;
  const step = Math.max(4, Math.floor(d.length / 4096 / 4) * 4);
  for (let i = 0; i < d.length; i += step) h = Math.imul(h ^ d[i] ^ (d[i + 1] << 8) ^ (d[i + 2] << 16), 16777619) >>> 0;
  return `${img.width}x${img.height}:${h}`;
}
const cache: { key: string; map: Float32Array; ms: number }[] = [];

/**
 * MODNet's matte of the picture, as a PERSON_SIDE² map over the whole picture (0..1). Null when the model is not
 * available. The last two pictures' mattes are kept (dialog preview → apply).
 */
export async function personMatte(img: Img, o: { gpu?: boolean; pool?: boolean } = {}): Promise<{ map: Float32Array; side: number; ms: number; backend?: "webgpu" | "cpu" } | null> {
  const key = fingerprint(img);
  const hit = cache.find((c) => c.key === key);
  if (hit) return { map: hit.map, side: PERSON_SIDE, ms: 0 };
  const m = await load();
  if (!m) return null;
  const t0 = performance.now();
  // WebGPU where the browser has it (PC Chrome / Edge, Android Chrome): the same graph on the GPU (infer/graphGpu.ts);
  // a failure there falls back to the CPU for good
  let g = o.gpu !== false && !gpuOff && graphGpuAvailable() ? await graphGpu(m).catch(() => null) : null;
  if (g && !(await gpuAgrees(m, g))) {
    gpuOff = true;
    g = null;
  }
  const { w, h } = modnetSize(img.width, img.height, refFor(!!g));
  const x: Tensor = { s: [1, 3, h, w], d: input(img, w, h) };
  let out: Tensor | null = null;
  let backend: "webgpu" | "cpu" = "cpu";
  if (g)
    try {
      out = await g.run(x);
      backend = "webgpu";
    } catch {
      gpuOff = true;
    }
  // the CPU: the convs split across the conv pool's workers where there is one (infer/convPool.ts)
  if (!out) {
    const pool = o.pool === false ? null : convPool("modnet", "graph", () => modelBytes);
    if (pool)
      try {
        out = await runGraphAsync(m, x, (i, n, t) => pool.graphConv(m, i, n, t));
      } catch {
        pool.terminate();
      }
  }
  out ??= runGraph(m, x);
  const map = toSquare(out.d, out.s[3], out.s[2], PERSON_SIDE);
  const ms = performance.now() - t0;
  cache.unshift({ key, map, ms });
  cache.length = Math.min(cache.length, 2);
  return { map, side: PERSON_SIDE, ms, backend };
}

/**
 * Background points on the person (지울 곳 on the shirt): the person matte holds the whole body as one region, so a
 * background point alone would drop all of it (hints.ts drops a region that has only background points). With no
 * subject point on the person, one is added at the head (the top of the largest region): the person is then a region
 * with both kinds of points, and only the part around the background point is cut (hints.ts region grow).
 */
export function withHeadHint(map: Float32Array, side: number, hints: readonly MatteHint[]): MatteHint[] {
  if (!hints.some((h) => !h.fg)) return [...hints];
  const N = side * side, mask = new Uint8Array(N);
  for (let p = 0; p < N; p++) mask[p] = map[p] >= 0.5 ? 1 : 0;
  const { label, n } = components(mask, side, side);
  if (!n) return [...hints];
  const count = new Int32Array(n + 1);
  for (let p = 0; p < N; p++) count[label[p]]++;
  let big = 1;
  for (let l = 2; l <= n; l++) if (count[l] > count[big]) big = l;
  const at = (h: MatteHint) => label[Math.min(side - 1, Math.floor(h.y * side)) * side + Math.min(side - 1, Math.floor(h.x * side))];
  if (!hints.some((h) => !h.fg && at(h) === big) || hints.some((h) => h.fg && at(h) === big)) return [...hints];
  let y0 = side, y1 = -1;
  for (let p = 0; p < N; p++)
    if (label[p] === big) {
      const y = Math.floor(p / side);
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  const yEnd = y0 + Math.max(1, Math.round((y1 - y0 + 1) * 0.15));
  let sx = 0, sy = 0, k = 0;
  for (let y = y0; y < yEnd; y++)
    for (let x = 0; x < side; x++)
      if (label[y * side + x] === big) (sx += x), (sy += y), k++;
  const head = { x: (sx / k + 0.5) / side, y: (sy / k + 0.5) / side, fg: true };
  // (a background point on the head itself: the person is meant to go)
  if (hints.some((h) => !h.fg && Math.hypot(h.x - head.x, h.y - head.y) < 0.1)) return [...hints];
  return [...hints, head];
}
