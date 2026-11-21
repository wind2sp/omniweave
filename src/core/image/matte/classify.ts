// Automatic image classification for background removal: which method suits this picture? No extra model — fast
// statistics on a small copy of the image, plus U²-Netp saliency statistics for photos. Every decision carries a
// confidence (0..1); the UI shows the type and lets the user override it.

import type { Img } from "../pixels";
import { downscale } from "../pixels";
import { borderColors, borderModel, borderPixels, chromaScreen, dist } from "./select";

export type MatteType = "transparent" | "graphic" | "document" | "chroma" | "product" | "portrait" | "animal" | "object" | "complex";

export const MATTE_TYPES: MatteType[] = ["transparent", "graphic", "document", "chroma", "product", "portrait", "animal", "object", "complex"];

/** Types that need the neural saliency map. */
export const NEEDS_AI: ReadonlySet<MatteType> = new Set(["product", "portrait", "animal", "object", "complex"]);

export interface ImageFeatures {
  /** share of pixels with alpha < 16 */
  clear: number;
  /** share of pixels with 16 ≤ alpha < 250 */
  soft: number;
  chroma: "green" | "blue" | null;
  /** share of the whole image in the screen colour */
  chromaShare: number;
  /** quantized colours covering 95% of the pixels */
  colors95: number;
  /** share of pixels identical (±2) to all 4 neighbours */
  flat: number;
  /** share of pixels in the 8 most frequent exact colours (digital art ≈ 0.9, photos and renders far less) */
  exact8: number;
  /** share of the border explained by the smooth border model (plain / studio background) */
  borderPlain: number;
  /** strongest border colour share */
  borderTop: number;
  /** mean colour distance of border pixels to the smooth border model (0 = one exact colour, as in digital art) */
  borderSpread: number;
  /** median screen-colour excess over the border, relative to the channel (green screens ≈ 0.6, grass ≈ 0.35) */
  chromaStrength: number;
  /** that colour is light and unsaturated (paper) */
  paperLike: boolean;
  /** share of pixels close to the paper colour */
  paper: number;
  /** of the non-paper pixels, the share lying in thin strokes (text, signatures, line art) */
  thin: number;
}

export interface SaliencyStats {
  /** mean |2s − 1|: 1 = the network is sure everywhere */
  certainty: number;
  /** salient area share (s > 0.5) */
  area: number;
  /** connected salient components ≥ 1% of the image */
  parts: number;
  /** raw network peak before normalizing */
  peak: number;
  /** skin-tone share inside the salient region */
  skin: number;
  /** skin share in the top 40% of the salient bounding box relative to the rest (faces sit on top) */
  skinTop: number;
  /** width of the top quarter of the salient region over the widest row (head and shoulders ≈ 0.35..0.7) */
  headRatio: number;
  /** soft-edge share: pixels 0.15 < s < 0.85 per salient boundary pixel (fur, hair) */
  softEdge: number;
  /** high-frequency energy inside the salient region (fur texture) */
  texture: number;
  /** salient touches the bottom edge (portraits are cut at the chest) */
  bottom: number;
  /** share of background pixels on strong edges (busy scenes) */
  bgEdges: number;
  /** share of foliage-green pixels in the salient region (plants, vegetables) */
  green: number;
}

export interface Classification {
  type: MatteType;
  confidence: number;
  features: ImageFeatures;
  sal?: SaliencyStats;
  /** the result is uncertain: ask the user to check / refine */
  review: boolean;
}

const SMALL = 192;

export function imageFeatures(src: Img): ImageFeatures {
  const img = downscale(src, SMALL).img;
  const { width: W, height: H, data: d } = img;
  const N = W * H;
  let clear = 0, soft = 0;
  for (let p = 0; p < N; p++) {
    const a = d[p * 4 + 3];
    if (a < 16) clear++;
    else if (a < 250) soft++;
  }
  const chroma = chromaScreen(img);
  let chromaN = 0;
  if (chroma) {
    const k = chroma === "green" ? 1 : 2;
    for (let p = 0; p < N; p++) {
      const i = p * 4;
      const o = chroma === "green" ? Math.max(d[i], d[i + 2]) : Math.max(d[i], d[i + 1]);
      if (d[i + k] > 60 && d[i + k] - o > 0.25 * d[i + k]) chromaN++;
    }
  }
  // colours
  const bins = new Map<number, number>();
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  const counts = [...bins.values()].sort((a, b) => b - a);
  let acc = 0, colors95 = 0;
  for (const c of counts) {
    acc += c;
    colors95++;
    if (acc >= 0.95 * N) break;
  }
  // flatness on the full-detail copy (≤ 512) — downscaling smooths noise away, so use a larger copy here
  const mid = downscale(src, 512).img;
  let flat = 0, exact8 = 0;
  {
    const exact = new Map<number, number>();
    const m0 = mid.data;
    for (let i = 0; i < m0.length; i += 4) {
      const key = (m0[i] << 16) | (m0[i + 1] << 8) | m0[i + 2];
      exact.set(key, (exact.get(key) ?? 0) + 1);
    }
    exact8 = [...exact.values()].sort((a, b) => b - a).slice(0, 8).reduce((a, b) => a + b, 0) / (m0.length / 4);
    const w = mid.width, h = mid.height, m = mid.data;
    let n = 0;
    for (let y = 1; y < h - 1; y += 2)
      for (let x = 1; x < w - 1; x += 2) {
        const i = (y * w + x) * 4;
        let ok = true;
        for (const j of [i - 4, i + 4, i - w * 4, i + w * 4]) {
          if (Math.abs(m[i] - m[j]) > 2 || Math.abs(m[i + 1] - m[j + 1]) > 2 || Math.abs(m[i + 2] - m[j + 2]) > 2) {
            ok = false;
            break;
          }
        }
        if (ok) flat++;
        n++;
      }
    flat = n ? flat / n : 0;
  }
  // border
  const bc = borderColors(img, 3, 0.02);
  const model = borderModel(img);
  const bpx = borderPixels(img);
  let plain = 0, spread = 0;
  const ex: number[] = [];
  for (const p of bpx) {
    const x = p % W, y = (p - x) / W, i = p * 4;
    const e = dist([d[i], d[i + 1], d[i + 2]], model(x, y));
    spread += e;
    if (e < 14) plain++;
    if (chroma) {
      const k = chroma === "green" ? 1 : 2;
      const o = chroma === "green" ? Math.max(d[i], d[i + 2]) : Math.max(d[i], d[i + 1]);
      ex.push((d[i + k] - o) / Math.max(1, d[i + k]));
    }
  }
  ex.sort((a, b) => a - b);
  const chromaStrength = ex.length ? ex[ex.length >> 1] : 0;
  const top = bc[0];
  const L = top ? 0.299 * top.color[0] + 0.587 * top.color[1] + 0.114 * top.color[2] : 0;
  const sat = top ? (Math.max(...top.color) - Math.min(...top.color)) / Math.max(1, Math.max(...top.color)) : 1;
  const paperLike = !!top && L > 165 && sat < 0.22;
  // paper share and stroke thinness (paper-like images only)
  let paper = 0, thin = 0;
  if (paperLike) {
    const ink = new Uint8Array(N);
    let inkN = 0;
    for (let p = 0; p < N; p++) {
      const i = p * 4;
      const x = p % W, y = (p - x) / W;
      const B = model(x, y);
      const lp = d[i] + d[i + 1] + d[i + 2], lb = B[0] + B[1] + B[2];
      if (dist([d[i], d[i + 1], d[i + 2]], B) < 28 || lp > lb * 0.9) paper++;
      else {
        ink[p] = 1;
        inkN++;
      }
    }
    // a stroke pixel is "thin" when fewer than 60% of its 7×7 window is ink
    let thinN = 0;
    for (let p = 0; p < N; p++) {
      if (!ink[p]) continue;
      const x = p % W, y = (p - x) / W;
      let s = 0, n = 0;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          s += ink[yy * W + xx];
          n++;
        }
      if (s / n < 0.6) thinN++;
    }
    paper /= N;
    thin = inkN ? thinN / inkN : 1;
  }
  return { clear: clear / N, soft: soft / N, chroma, chromaShare: chromaN / N, colors95, flat, exact8, borderPlain: bpx.length ? plain / bpx.length : 0, borderTop: top?.share ?? 0, borderSpread: bpx.length ? spread / bpx.length : 0, chromaStrength, paperLike, paper, thin };
}

/** Saliency statistics on the 320² map, read in the image's own aspect. */
export function saliencyStats(src: Img, map: Float32Array, side: number, peak: number): SaliencyStats {
  const img = downscale(src, SMALL).img;
  const { width: W, height: H, data: d } = img;
  const N = W * H;
  const s = new Float32Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) s[y * W + x] = map[Math.min(side - 1, Math.floor(((y + 0.5) * side) / H)) * side + Math.min(side - 1, Math.floor(((x + 0.5) * side) / W))];
  let cert = 0, area = 0, skin = 0, softN = 0, edgeN = 0, bottom = 0, bgN = 0, bgE = 0, green = 0;
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  const isSkin = (i: number) => {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return cb >= 77 && cb <= 127 && cr >= 137 && cr <= 173 && r > 60 && r > b;
  };
  const lum = (i: number) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  for (let p = 0; p < N; p++) {
    const v = s[p];
    cert += Math.abs(2 * v - 1);
    if (v < 0.3) {
      const x = p % W;
      if (x < W - 1 && p + W < N) {
        bgN++;
        if (Math.abs(lum(p + 1) - lum(p)) + Math.abs(lum(p + W) - lum(p)) > 40) bgE++;
      }
    }
    if (v > 0.15 && v < 0.85) softN++;
    if (v > 0.5) {
      area++;
      const x = p % W, y = (p - x) / W;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      if (isSkin(p * 4)) skin++;
      {
        const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
        if (sat > 0.2 && g > r * 1.08 && g > b * 1.08) green++;
      }
      if (y === H - 1) bottom++;
      const isEdge = (x > 0 && s[p - 1] <= 0.5) || (x < W - 1 && s[p + 1] <= 0.5) || (y > 0 && s[p - W] <= 0.5) || (y < H - 1 && s[p + W] <= 0.5);
      if (isEdge) edgeN++;
    }
  }
  // components
  const seen = new Uint8Array(N);
  let parts = 0;
  for (let p0 = 0; p0 < N; p0++) {
    if (seen[p0] || s[p0] <= 0.5) continue;
    const st = [p0];
    seen[p0] = 1;
    let n = 0;
    while (st.length) {
      const p = st.pop()!;
      n++;
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W]) if (q >= 0 && q < N && !seen[q] && s[q] > 0.5) (seen[q] = 1), st.push(q);
    }
    if (n >= 0.01 * N) parts++;
  }
  // head / shoulders profile and skin distribution
  let headRatio = 0, skinTop = 0, texture = 0;
  if (area > 0) {
    const bh = y1 - y0 + 1;
    const rowW = (y: number) => {
      let a = W, b = -1;
      for (let x = 0; x < W; x++) if (s[y * W + x] > 0.5) (a = Math.min(a, x)), (b = Math.max(b, x));
      return b >= a ? b - a + 1 : 0;
    };
    let widest = 1;
    for (let y = y0; y <= y1; y++) widest = Math.max(widest, rowW(y));
    let topW = 0;
    for (let y = y0; y < y0 + Math.max(1, Math.round(bh * 0.25)); y++) topW = Math.max(topW, rowW(y));
    headRatio = topW / widest;
    let st = 0, sb = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const p = y * W + x;
        if (s[p] <= 0.5 || !isSkin(p * 4)) continue;
        if (y < y0 + bh * 0.4) st++;
        else sb++;
      }
    skinTop = st / Math.max(1, st + sb);
    // texture: mean absolute Laplacian of luma inside the region
    let tn = 0;
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (s[p] <= 0.6) continue;
        const l = (i: number) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        texture += Math.abs(4 * l(p) - l(p - 1) - l(p + 1) - l(p - W) - l(p + W));
        tn++;
      }
    texture = tn ? texture / tn : 0;
  }
  return {
    certainty: cert / N,
    area: area / N,
    parts,
    peak,
    skin: area ? skin / area : 0,
    skinTop,
    headRatio,
    softEdge: edgeN ? softN / edgeN : 0,
    texture,
    bottom: bottom / W,
    bgEdges: bgN ? bgE / bgN : 0,
    green: area ? green / area : 0,
  };
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** Decide from the non-AI features alone; null = a photo, decide after saliency (decideWithSaliency). */
export function decideFast(f: ImageFeatures): { type: MatteType; confidence: number } | null {
  if (f.clear > 0.02) return { type: "transparent", confidence: clamp(0.6 + f.clear * 4) };
  // a saturated, even screen colour around the border (grass and sky are less saturated)
  if (f.chroma && f.chromaShare > 0.25 && f.chromaStrength > 0.45) return { type: "chroma", confidence: clamp(0.3 + f.chromaShare * 0.5 + (f.chromaStrength - 0.45) * 2) };
  // clean digital artwork: few colours, mostly perfectly flat, a border of one exact colour. Checked before
  // "document": line art on pure white is also paper-like with thin strokes, but its exact flat border says digital
  // (real-image eval, docs/design/MATTE_EVAL.md).
  if (f.flat > 0.8 && f.exact8 > 0.8 && f.borderTop > 0.5 && f.borderSpread < 1.5) return { type: "graphic", confidence: clamp(0.3 + (f.exact8 - 0.8) * 2 + (f.flat - 0.8) + f.borderTop * 0.3) };
  // paper with thin dark strokes (text, signatures, stamps, line art) — or bold marker strokes in very few colours
  if (f.paperLike && f.paper > 0.5 && f.borderPlain > 0.8 && (f.thin > 0.5 || (f.paper > 0.85 && f.colors95 <= 24 && f.thin > 0.25)))
    return { type: "document", confidence: clamp(0.3 + f.paper * 0.4 + Math.max(f.thin - 0.5, f.colors95 <= 24 ? 0.15 : 0)) };
  return null;
}

export function decideWithSaliency(f: ImageFeatures, s: SaliencyStats): { type: MatteType; confidence: number } {
  // the network found nothing clear
  if (s.peak < 0.3 || s.certainty < 0.55 || s.area < 0.01 || s.area > 0.9 || s.parts > 3) {
    return { type: "complex", confidence: clamp(0.5 + (0.7 - s.certainty)) };
  }
  // skin tones concentrated at the top of a head-and-shoulders silhouette, cut by the bottom edge (a cat's face is
  // skin-coloured too, but an animal photo shows the whole body). Before the scene test: flyaway hair widens the soft margin.
  const face = s.skin > 0.06 && s.skinTop > 0.4 && s.headRatio > 0.2 && s.headRatio < 0.8 && s.bottom > 0.2;
  if (face) return { type: "portrait", confidence: clamp(0.35 + s.skin + (s.skinTop - 0.4) * 0.6 + (s.bottom > 0.5 ? 0.15 : 0)) };
  // real scenes (streets, rooms, crowds): the network hedges — a tiny or diffuse map, wide soft margins around the
  // "subject" (single subjects stay below ≈2.5 soft pixels per boundary pixel, scenes reach 4..13), or a less sure map
  if (s.softEdge > 3 || s.certainty < 0.9 || s.area < 0.05) {
    return { type: "complex", confidence: clamp(0.45 + Math.min(0.3, (s.softEdge - 3) * 0.05) + Math.max(0, 0.9 - s.certainty) + (s.area < 0.05 ? 0.15 : 0)) };
  }
  // strong fine texture inside a soft-edged subject: fur — but not foliage green (broccoli,
  // plants and fruit have the texture and the soft edge too). A slightly softer edge counts away from a studio backdrop.
  const fur = s.green < 0.15;
  if (fur && s.texture > 14 && (s.softEdge > 1.0 || (s.softEdge > 0.82 && f.borderPlain < 0.85)))
    return { type: "animal", confidence: clamp(0.35 + (s.texture - 14) / 30 + (s.softEdge - 0.82) * 0.2) };
  if (f.borderPlain > 0.85 && s.parts <= 1) return { type: "product", confidence: clamp(0.4 + (f.borderPlain - 0.85) * 3 + s.certainty * 0.3) };
  return { type: "object", confidence: clamp(0.3 + s.certainty * 0.5) };
}

/** Types whose result should be checked by the user. */
export function needsReview(type: MatteType, confidence: number): boolean {
  return type === "complex" || confidence < 0.5;
}
