// Background removal ("배경 지우기"): classify → pick the method → refine edges → matte + cut-out pixels.
// Pure engine code (no DOM); runs in the image worker (worker.ts kind "matte") or on the calling thread in tests.
//
// The result keeps the matte (alpha, full resolution) separate from the cut-out pixels so a later Mask model can
// reuse it non-destructively (docs/design/UNIFIED_STYLES.md §4.6, §6).

import type { Img } from "../pixels";
import { SAL, saliency, type Backend } from "../infer";
import { decideFast, decideWithSaliency, imageFeatures, NEEDS_AI, needsReview, saliencyStats, type ImageFeatures, type MatteType, type SaliencyStats } from "./classify";
import { chromaKey, chromaScreen, flatBackground, paperRemoval, studioKey, borderModel, type InnerHoles, type SelectResult } from "./select";
import { dropComponents, hintPixels, hintSaliency, type MatteHint } from "./hints";
import { clamp01, composeCutout, DEFAULT_EDGE, GUIDE, guidedFilter, hardenAlpha, matteBand, resizePlane, rgbPlanes, shapeAlpha, upsampleAlpha, workSize, type EdgeOptions } from "./refine";

export interface MatteOptions {
  /** user override of the detected type */
  type?: MatteType;
  edge?: Partial<EdgeOptions>;
  /** product shots: keep the cast shadow as a translucent dark layer */
  keepShadow?: boolean;
  /** saliency computed earlier for this picture (dialog preview → apply) */
  sal?: { map: Float32Array; hi: number; lo?: number; backend?: Backend; ms?: number };
  backend?: "auto" | "cpu";
  /** graphics: enclosed background-coloured regions — "auto" (default) removes counters ("O") and keeps surfaces (a white page), true removes all, false keeps all */
  inner?: InnerHoles;
  /** subject / background points clicked on the preview (fractions of the picture size) */
  hints?: MatteHint[];
}

export interface MatteResult {
  /** full-resolution matte, 0..255 */
  alpha: Uint8ClampedArray;
  /** cut-out pixels (colour decontaminated where the method knows the background) */
  cut: Img;
  type: MatteType;
  /** the type detected automatically (equals `type` unless overridden) */
  detected: MatteType;
  confidence: number;
  review: boolean;
  features: ImageFeatures;
  salStats?: SaliencyStats;
  /** the saliency map used (so a preview can hand it to the final apply) */
  sal?: { map: Float32Array; hi: number; lo: number };
  backend?: Backend;
  /** the hints took over from the saliency map (region grow) */
  grown?: boolean;
  ms: { classify: number; ai: number; refine: number; total: number };
}

/** Edge defaults per type (radius in working-res px at 1024: the band where local fg / bg colours are estimated for decontamination). */
export const TYPE_EDGE: Record<MatteType, Partial<EdgeOptions>> = {
  transparent: { decontaminate: 0 },
  graphic: { decontaminate: 100 },
  document: { decontaminate: 100 },
  chroma: { decontaminate: 100 },
  product: { radius: 2, decontaminate: 50 },
  portrait: { radius: 10, decontaminate: 70 },
  animal: { radius: 16, decontaminate: 70 },
  object: { radius: 6, decontaminate: 60 },
  complex: { radius: 6, decontaminate: 50 },
};

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Classification only (cheap for graphics / scans / screens; runs U²-Netp for photos). */
export async function analyze(img: Img, opts: Pick<MatteOptions, "sal" | "backend"> = {}) {
  const t0 = now();
  const features = imageFeatures(img);
  const fast = decideFast(features);
  if (fast) return { ...fast, detected: fast.type, features, review: needsReview(fast.type, fast.confidence), ms: now() - t0, aiMs: 0 };
  const t1 = now();
  const s = opts.sal ?? (await saliency(img, { backend: opts.backend }));
  const aiMs = opts.sal ? 0 : now() - t1;
  const salStats = saliencyStats(img, s.map, SAL, s.hi);
  const d = decideWithSaliency(features, salStats);
  return { ...d, detected: d.type, features, salStats, sal: { map: s.map, hi: s.hi, lo: s.lo ?? 0 }, backend: s.backend, review: needsReview(d.type, d.confidence), ms: now() - t0, aiMs };
}

const userShaped = (e: EdgeOptions) => e.smooth > 0 || e.feather > 0 || e.contrast > 0 || e.shift !== 0;

/** Apply the slider controls to a full-resolution alpha (non-AI methods). */
function shapeFull(alpha: Uint8ClampedArray, W: number, H: number, e: EdgeOptions): Uint8ClampedArray {
  if (!userShaped(e)) return alpha;
  const f = Float32Array.from(alpha, (v) => v / 255);
  const o = shapeAlpha(f, W, H, e, e.feather);
  return Uint8ClampedArray.from(o, (v) => Math.round(v * 255));
}

function fromSelect(img: Img, r: SelectResult, amount: number): Img {
  const { width: W, height: H, data: d } = img;
  const out = new Uint8ClampedArray(d.length);
  const k = amount / 100;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    out[i + 3] = r.alpha[p];
    if (!r.alpha[p]) continue;
    for (let c = 0; c < 3; c++) out[i + c] = r.rgb ? d[i + c] + (r.rgb[p * 3 + c] - d[i + c]) * k : d[i + c];
  }
  return { width: W, height: H, data: out };
}

/**
 * Saliency map → full-resolution matte: colour-guided filter at working resolution, tail clip, user edge controls,
 * guided upsampling. `band` holds the local foreground / background colours (radius = edge.radius) for
 * decontamination. The band's colour-line alpha is not used: on real photos it added halos (MATTE_EVAL.md).
 */
export function aiMatte(img: Img, map: Float32Array, w: number, h: number, edge: EdgeOptions) {
  const W = img.width;
  const I = rgbPlanes(img, w, h);
  const S = resizePlane({ w: SAL, h: SAL, d: map }, w, h).d;
  const scale = Math.max(w, h) / 1024;
  const g = hardenAlpha(guidedFilter(I, S, w, h, Math.max(2, Math.round(GUIDE.radius * scale)), GUIDE.eps), GUIDE.harden);
  const band = matteBand(I, g, w, h, Math.max(2, Math.round(edge.radius * scale)));
  const shaped = shapeAlpha(g, w, h, edge, (edge.feather * w) / W);
  return { alpha: upsampleAlpha(img, I, shaped, w, h), band };
}

export async function removeBackground(img: Img, opts: MatteOptions = {}): Promise<MatteResult> {
  const T0 = now();
  const a = await analyze(img, opts);
  const tClassify = a.ms - a.aiMs;
  const type = opts.type ?? a.type;
  const edge: EdgeOptions = { ...DEFAULT_EDGE, ...TYPE_EDGE[type], ...opts.edge };
  const W = img.width, H = img.height;
  let sal = "sal" in a ? a.sal : opts.sal ? { map: opts.sal.map, hi: opts.sal.hi, lo: opts.sal.lo ?? 0 } : undefined;
  let backend = "backend" in a ? a.backend : opts.sal?.backend;
  let tAi = a.aiMs;
  if (NEEDS_AI.has(type) && !sal) {
    const t = now();
    const s = await saliency(img, { backend: opts.backend });
    sal = { map: s.map, hi: s.hi, lo: s.lo };
    backend = s.backend;
    tAi = now() - t;
  }
  const t1 = now();
  const hints = opts.hints ?? [];
  // the map the matte is built from: the saliency map, edited by the subject hints (the original stays in `sal`)
  let grown = false;
  let map = sal?.map;
  if (map && hints.length && NEEDS_AI.has(type)) {
    const h = hintSaliency(img, map, SAL, hints);
    map = h.map;
    grown = h.grown;
  }
  let alpha: Uint8ClampedArray;
  let cut: Img;
  if (type === "transparent") {
    alpha = new Uint8ClampedArray(W * H);
    for (let p = 0; p < W * H; p++) {
      const v = img.data[p * 4 + 3];
      alpha[p] = v < 6 ? 0 : v > 249 ? 255 : v;
    }
    dropComponents(alpha, W, H, hints);
    alpha = shapeFull(alpha, W, H, edge);
    cut = fromSelect(img, { alpha, rgb: null }, 0);
  } else if (type === "graphic" || type === "document" || type === "chroma") {
    let r: SelectResult;
    if (type === "graphic") r = flatBackground(img, { holes: opts.inner ?? "auto", keep: hintPixels(hints, W, H, true, 1), drop: hintPixels(hints, W, H, false, 1) });
    else if (type === "document") r = paperRemoval(img);
    else r = chromaKey(img, chromaScreen(img) ?? "green");
    dropComponents(r.alpha, W, H, hints);
    r.alpha = shapeFull(r.alpha, W, H, edge);
    alpha = r.alpha;
    cut = fromSelect(img, r, edge.decontaminate);
  } else if (type === "product") {
    const r = studioKey(img, { keepShadow: opts.keepShadow });
    // the guided saliency matte is the base (a colour key alone loses white-on-white rims and handles: real-image eval,
    // docs/design/MATTE_EVAL.md); the studio key only clears what is certainly backdrop (border-connected, key ≈ 0)
    const { w, h } = workSize(W, H);
    const m = aiMatte(img, map!, w, h, edge);
    alpha = m.alpha;
    for (let p = 0; p < W * H; p++) {
      if (r.alpha[p] < 8 && alpha[p] < 128) alpha[p] = 0;
      // kept cast shadow: a dark translucent layer where the key found one
      if (opts.keepShadow && r.rgb && r.rgb[p * 3] === 0 && r.rgb[p * 3 + 1] === 0 && r.rgb[p * 3 + 2] === 0 && r.alpha[p] < 128) alpha[p] = Math.max(alpha[p], r.alpha[p]);
    }
    // decontaminate against the fitted backdrop colour
    const model = borderModel(img);
    const bg: [Float32Array, Float32Array, Float32Array] = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = model(((x + 0.5) * W) / w, ((y + 0.5) * H) / h);
        for (let k = 0; k < 3; k++) bg[k][y * w + x] = clamp01(c[k] / 255);
      }
    cut = composeCutout(img, alpha, bg, null, w, h, edge.decontaminate);
    if (opts.keepShadow && r.rgb) {
      // shadow pixels are black at their shadow opacity
      for (let p = 0; p < W * H; p++)
        if (r.rgb[p * 3] === 0 && r.rgb[p * 3 + 1] === 0 && r.rgb[p * 3 + 2] === 0 && r.alpha[p] < 128 && alpha[p] > 0) cut.data[p * 4] = cut.data[p * 4 + 1] = cut.data[p * 4 + 2] = 0;
    }
  } else {
    const { w, h } = workSize(W, H);
    const m = aiMatte(img, map!, w, h, edge);
    alpha = m.alpha;
    cut = composeCutout(img, alpha, m.band.bg, m.band.fg, w, h, edge.decontaminate);
  }
  const tRefine = now() - t1;
  return {
    alpha,
    cut,
    type,
    detected: a.detected,
    confidence: a.confidence,
    review: opts.type ? opts.type === "complex" : a.review,
    features: a.features,
    salStats: "salStats" in a ? a.salStats : undefined,
    sal,
    backend,
    grown,
    ms: { classify: tClassify, ai: tAi, refine: tRefine, total: now() - T0 },
  };
}

/** Plain U²-Netp baseline (what rembg does without alpha matting): bilinear upsample of the saliency map. */
export function plainSaliencyAlpha(map: Float32Array, W: number, H: number): Uint8ClampedArray {
  const up = resizePlane({ w: SAL, h: SAL, d: map }, W, H).d;
  return Uint8ClampedArray.from(up, (v) => Math.round(v * 255));
}
