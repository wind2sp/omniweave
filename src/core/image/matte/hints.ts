// Subject hints for background removal ("주인공 찍기"): points the user clicks on the preview to say "this is the
// subject" (fg) or "this is background". Pure, runs in the image worker.
//
//  - AI types: the saliency map's connected components (map ≥ 0.5) that hold a subject point are kept, those that
//    hold only background points are dropped. When a subject point lies outside every component (U²-Netp missed the
//    subject — a tree in front of a forest) or a component holds both kinds, a model-free region grow takes over
//    (`growRegion`: GrabCut-lite — small colour / texture / saliency mixtures for subject and background, an
//    edge-aware smoothing of the likelihood, connectivity to the subject points, three re-estimation rounds). The
//    result replaces the map and goes through the usual edge refinement.
//  - non-AI types: a background point removes the opaque component under it (`dropComponents`); graphics also use
//    the points to keep / remove enclosed background-coloured regions (select.ts flatBackground keep / drop).

import type { Img } from "../pixels";
import { boxMean, guidedFilter, rgbPlanes } from "./refine";

export interface MatteHint {
  /** position as a fraction of the picture's width / height (0..1), so the dialog preview and the apply agree */
  x: number;
  y: number;
  /** true = subject, false = background */
  fg: boolean;
}

/** Pixel indices (w×h grid) of the hints of one kind, as discs of radius r. */
export function hintPixels(hints: readonly MatteHint[], w: number, h: number, fg: boolean, r = 0): number[] {
  const out: number[] = [];
  for (const k of hints) {
    if (k.fg !== fg) continue;
    const cx = Math.min(w - 1, Math.max(0, Math.floor(k.x * w))), cy = Math.min(h - 1, Math.max(0, Math.floor(k.y * h)));
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r) continue;
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h) out.push(y * w + x);
      }
  }
  return out;
}

/** 4-connected components of `mask`; returns labels (0 = none) and the count. */
export function components(mask: Uint8Array, w: number, h: number): { label: Int32Array; n: number } {
  const label = new Int32Array(w * h);
  let n = 0;
  const st: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    label[s] = ++n;
    st.push(s);
    while (st.length) {
      const p = st.pop()!, x = p % w;
      if (x > 0 && mask[p - 1] && !label[p - 1]) (label[p - 1] = n), st.push(p - 1);
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) (label[p + 1] = n), st.push(p + 1);
      if (p >= w && mask[p - w] && !label[p - w]) (label[p - w] = n), st.push(p - w);
      if (p + w < w * h && mask[p + w] && !label[p + w]) (label[p + w] = n), st.push(p + w);
    }
  }
  return { label, n };
}

/** Non-AI results: remove the opaque components (alpha ≥ 128) under a background point unless a subject point is on them too. */
export function dropComponents(alpha: Uint8ClampedArray, W: number, H: number, hints: readonly MatteHint[]): void {
  const bg = hintPixels(hints, W, H, false);
  if (!bg.length) return;
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) mask[p] = alpha[p] >= 128 ? 1 : 0;
  const { label } = components(mask, W, H);
  const fgL = new Set(hintPixels(hints, W, H, true).map((p) => label[p]));
  const drop = new Set(bg.map((p) => label[p]).filter((l) => l && !fgL.has(l)));
  if (!drop.size) return;
  // the soft rim around a dropped component goes with it
  const kill = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) if (drop.has(label[p])) kill[p] = 1;
  for (let p = 0; p < W * H; p++) {
    if (kill[p]) alpha[p] = 0;
    else if (alpha[p] && alpha[p] < 128) {
      const x = p % W;
      if ((x > 0 && kill[p - 1]) || (x < W - 1 && kill[p + 1]) || (p >= W && kill[p - W]) || (p + W < W * H && kill[p + W])) alpha[p] = 0;
    }
  }
}

// ---------- region grow (GrabCut-lite) ----------

const F = 5; // features: r, g, b, texture, saliency
const FW = [1, 1, 1, 0.6, 0.3]; // feature weights (saliency is a soft prior, texture a weaker cue)
/** log-density of the subject model's uniform component (pixels this unlike the background count as subject) */
const NOVEL = -2;

interface Gauss {
  w: number;
  m: Float64Array;
  v: Float64Array;
}

/** Small diagonal Gaussian mixture by k-means (k ≤ 5) on up to 3000 samples. */
function fitMixture(feat: Float32Array[], idx: number[], k = 5): Gauss[] {
  if (!idx.length) return [];
  const step = Math.max(1, Math.floor(idx.length / 3000));
  const s: number[] = [];
  for (let i = 0; i < idx.length; i += step) s.push(idx[i]);
  k = Math.min(k, s.length);
  const cent: Float64Array[] = [];
  // farthest-point initialisation (deterministic)
  cent.push(Float64Array.from(feat.map((f) => f[s[0]])));
  const dmin = new Float64Array(s.length).fill(Infinity);
  while (cent.length < k) {
    const c = cent[cent.length - 1];
    let bi = 0, bd = -1;
    for (let i = 0; i < s.length; i++) {
      let d = 0;
      for (let f = 0; f < F; f++) d += FW[f] * (feat[f][s[i]] - c[f]) ** 2;
      if (d < dmin[i]) dmin[i] = d;
      if (dmin[i] > bd) (bd = dmin[i]), (bi = i);
    }
    cent.push(Float64Array.from(feat.map((f) => f[s[bi]])));
  }
  const asg = new Int32Array(s.length);
  for (let it = 0; it < 6; it++) {
    for (let i = 0; i < s.length; i++) {
      let bj = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        let d = 0;
        for (let f = 0; f < F; f++) d += FW[f] * (feat[f][s[i]] - cent[j][f]) ** 2;
        if (d < bd) (bd = d), (bj = j);
      }
      asg[i] = bj;
    }
    for (let j = 0; j < k; j++) cent[j].fill(0);
    const n = new Float64Array(k);
    for (let i = 0; i < s.length; i++) {
      n[asg[i]]++;
      for (let f = 0; f < F; f++) cent[asg[i]][f] += feat[f][s[i]];
    }
    for (let j = 0; j < k; j++) if (n[j]) for (let f = 0; f < F; f++) cent[j][f] /= n[j];
  }
  const out: Gauss[] = [];
  const n = new Float64Array(k);
  const v = Array.from({ length: k }, () => new Float64Array(F));
  for (let i = 0; i < s.length; i++) {
    n[asg[i]]++;
    for (let f = 0; f < F; f++) v[asg[i]][f] += (feat[f][s[i]] - cent[asg[i]][f]) ** 2;
  }
  for (let j = 0; j < k; j++) {
    if (!n[j]) continue;
    for (let f = 0; f < F; f++) v[j][f] = Math.max(v[j][f] / n[j], 4e-4);
    out.push({ w: n[j] / s.length, m: cent[j], v: v[j] });
  }
  return out;
}

function logLik(g: Gauss[], feat: Float32Array[], p: number): number {
  let best = -Infinity;
  const terms: number[] = [];
  for (const c of g) {
    let e = Math.log(c.w);
    for (let f = 0; f < F; f++) e -= FW[f] * (0.5 * (feat[f][p] - c.m[f]) ** 2 / c.v[f] + 0.5 * Math.log(c.v[f]));
    terms.push(e);
    if (e > best) best = e;
  }
  let s = 0;
  for (const e of terms) s += Math.exp(e - best);
  return best + Math.log(s);
}

/**
 * Model-free subject region from seeds, on a w×h grid (the saliency map's): `fgSeed` / `bgSeed` are hard labels,
 * `sal` the saliency map (a soft feature). Returns a soft subject map 0..1.
 */
/**
 * `fgHint` / `bgHint`: the clicked points' discs, weighted to at least a third of each model's samples (a single
 * background click on a red flower must teach the background model "red").
 */
export function growRegion(img: Img, sal: Float32Array, w: number, h: number, fgSeed: Uint8Array, bgSeed: Uint8Array, fgHint: number[] = [], bgHint: number[] = []): Float32Array {
  const N = w * h;
  const I = rgbPlanes(img, w, h);
  // texture: local standard deviation of the luminance (5×5)
  const L = new Float32Array(N), L2 = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    L[p] = 0.299 * I[0][p] + 0.587 * I[1][p] + 0.114 * I[2][p];
    L2[p] = L[p] * L[p];
  }
  const mL = boxMean(L, w, h, 2), mL2 = boxMean(L2, w, h, 2);
  const tex = new Float32Array(N);
  for (let p = 0; p < N; p++) tex[p] = Math.min(1, 4 * Math.sqrt(Math.max(0, mL2[p] - mL[p] * mL[p])));
  const feat = [I[0], I[1], I[2], tex, sal];
  let fgIdx: number[] = [], bgIdx: number[] = [];
  for (let p = 0; p < N; p++) {
    if (fgSeed[p]) fgIdx.push(p);
    else if (bgSeed[p]) bgIdx.push(p);
  }
  if (!fgIdx.length) return new Float32Array(N);
  const seeds = fgIdx.slice();
  let out = new Float32Array(N);
  for (let round = 0; round < 3; round++) {
    const gF = fitMixture(feat, weighted(fgIdx, fgHint)), gB = fitMixture(feat, weighted(bgIdx, bgHint));
    const pf = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      if (fgSeed[p]) pf[p] = 1;
      else if (bgSeed[p] || !gB.length) pf[p] = bgSeed[p] ? 0 : 1;
      else {
        // the subject model has a broad 'unlike the background' component, so subject parts with colours the
        // points did not sample (a light leaf next to a dark one) still win over a background they do not resemble
        const lf = logLik(gF, feat, p);
        const d = Math.max(lf, NOVEL) + Math.log1p(Math.exp(-Math.abs(lf - NOVEL))) - logLik(gB, feat, p);
        pf[p] = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, d * 0.5))));
      }
    }
    // edge-aware smoothing of the likelihood (a cheap stand-in for the pairwise term of a graph cut)
    const sm = guidedFilter(I, pf, w, h, Math.max(2, Math.round(Math.max(w, h) / 80)), 1e-2);
    for (let p = 0; p < N; p++) sm[p] = fgSeed[p] ? 1 : bgSeed[p] ? 0 : Math.min(1, Math.max(0, sm[p]));
    // keep what is connected to a subject point
    const mask = new Uint8Array(N);
    for (let p = 0; p < N; p++) mask[p] = sm[p] >= 0.5 ? 1 : 0;
    const { label } = components(mask, w, h);
    const keep = new Set(seeds.map((p) => label[p]).filter((l) => l));
    out = new Float32Array(N);
    for (let p = 0; p < N; p++) out[p] = keep.has(label[p]) ? sm[p] : 0;
    // re-estimate the mixtures from the current labelling (GrabCut iteration)
    fgIdx = [];
    bgIdx = [];
    for (let p = 0; p < N; p++) {
      if (bgSeed[p]) bgIdx.push(p);
      else if (out[p] >= 0.5) fgIdx.push(p);
      else bgIdx.push(p);
    }
    if (!fgIdx.length) break;
  }
  return out;
}

/** Samples with the hint pixels repeated to make up at least a third of them. */
function weighted(idx: number[], hint: number[]): number[] {
  if (!hint.length) return idx;
  const k = Math.ceil((0.5 * idx.length) / hint.length);
  const out = idx.slice();
  for (let i = 0; i < k; i++) out.push(...hint);
  return out;
}

/**
 * Apply hints to a saliency map (side×side): component selection, and the region grow where the map has no
 * component under a subject point. Returns the edited map (same size) and whether the region grow was used.
 */
export function hintSaliency(img: Img, map: Float32Array, side: number, hints: readonly MatteHint[]): { map: Float32Array; grown: boolean } {
  const N = side * side;
  if (!hints.length) return { map, grown: false };
  const mask = new Uint8Array(N);
  for (let p = 0; p < N; p++) mask[p] = map[p] >= 0.5 ? 1 : 0;
  const { label } = components(mask, side, side);
  const fgPts = hintPixels(hints, side, side, true), bgPts = hintPixels(hints, side, side, false);
  const fgL = new Set(fgPts.map((p) => label[p]).filter((l) => l));
  const bgL = new Set(bgPts.map((p) => label[p]).filter((l) => l));
  const mixed = new Set([...fgL].filter((l) => bgL.has(l)));
  const missed = fgPts.some((p) => !label[p]) || mixed.size > 0;
  // components → keep (subject point only), drop (background point only), keep as is (no point)
  const out = Float32Array.from(map);
  const dropL = new Set([...bgL].filter((l) => !fgL.has(l)));
  // the soft ramp around a component belongs to it: assign below-threshold pixels to the nearest component (3 px)
  const near = nearestLabel(label, side, side, 3);
  for (let p = 0; p < N; p++) if (dropL.has(near[p])) out[p] = 0;
  if (!missed) return { map: out, grown: false };
  // region grow: seeds = subject points + cores of the components holding one (away from background points),
  // background points, the border ring, and the cores of salient components that hold no subject point (the map
  // found something else there)
  const r = Math.max(2, Math.round(side / 30));
  const fgSeed = new Uint8Array(N), bgSeed = new Uint8Array(N);
  for (const p of hintPixels(hints, side, side, true, r)) fgSeed[p] = 1;
  for (const p of hintPixels(hints, side, side, false, r)) bgSeed[p] = 1;
  const bgXY = hints.filter((k) => !k.fg).map((k) => [k.x * side, k.y * side]);
  const away = side * 0.1;
  for (let p = 0; p < N; p++) {
    const l = label[p];
    if (!l || map[p] < 0.8) continue;
    if (fgL.has(l)) {
      const x = p % side, y = (p - x) / side;
      if (!bgXY.some(([bx, by]) => Math.hypot(bx - x, by - y) < away)) fgSeed[p] = 1;
    }
  }
  // border ring, except near a subject point (a subject cut by the frame)
  const ring = Math.max(1, Math.round(side / 160));
  const pts = hints.filter((k) => k.fg).map((k) => [k.x * side, k.y * side]);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      if (x >= ring && y >= ring && x < side - ring && y < side - ring) continue;
      if (pts.some(([px, py]) => Math.hypot(px - x, py - y) < side * 0.12)) continue;
      const p = y * side + x;
      if (!fgSeed[p]) bgSeed[p] = 1;
    }
  for (let p = 0; p < N; p++) if (fgSeed[p]) bgSeed[p] = 0;
  const g = growRegion(img, map, side, side, fgSeed, bgSeed, hintPixels(hints, side, side, true, r), hintPixels(hints, side, side, false, r));
  // when the map already holds the subject, a click outside it adds locally (near that click), not everywhere
  const lone = hints.filter((k) => k.fg && !label[Math.min(N - 1, Math.floor(k.y * side) * side + Math.floor(k.x * side))]).map((k) => [k.x * side, k.y * side]);
  const local = fgL.size > 0;
  const reach = side * 0.2;
  const cut = side * 0.15;
  for (let p = 0; p < N; p++) {
    const l = near[p];
    // a component with both kinds of points: the map, cut where the grow says background near a background point
    if (mixed.has(l)) {
      const x = p % side, y = (p - x) / side;
      out[p] = bgXY.some(([bx, by]) => Math.hypot(bx - x, by - y) < cut) ? Math.min(map[p], g[p]) : map[p];
      continue;
    }
    let gp = g[p];
    if (local && gp > 0) {
      const x = p % side, y = (p - x) / side;
      if (!lone.some(([px, py]) => Math.hypot(px - x, py - y) < reach)) gp = 0;
    }
    // grown region + kept subject components; components without points stay only where the grow agrees
    if (fgL.has(l)) out[p] = Math.max(gp, out[p]);
    else out[p] = Math.max(gp, dropL.has(l) ? 0 : Math.min(out[p], g[p] > 0.25 ? 1 : 0));
  }
  return { map: out, grown: true };
}

/** Label of the nearest labelled pixel within r (Chebyshev), 0 if none. */
function nearestLabel(label: Int32Array, w: number, h: number, r: number): Int32Array {
  let cur = Int32Array.from(label);
  for (let it = 0; it < r; it++) {
    const nx = Int32Array.from(cur);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (cur[p]) continue;
        const c = (x > 0 && cur[p - 1]) || (x < w - 1 && cur[p + 1]) || (y > 0 && cur[p - w]) || (y < h - 1 && cur[p + w]) || 0;
        if (c) nx[p] = c;
      }
    cur = nx;
  }
  return cur;
}
