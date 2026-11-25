// Colour adjustments (Photoshop "Image > Adjustments" family) as pure point operations.
// Every function returns a new image; alpha is never changed. Most work through 256-entry lookup tables,
// so they cost one table read per channel per pixel and can also run per Loom tile without seams.
//
// Formulas are textbook (each documented next to its function); none is copied from another program.

import { histRange, histogram, luma, newImg, type Img } from "./pixels";

export type Lut = Uint8Array;

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function identityLut(): Lut {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = i;
  return l;
}

export function makeLut(f: (x: number) => number): Lut {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = Math.round(clamp255(f(i)));
  return l;
}

/** Compose two LUTs: first `a`, then `b`. */
export function chainLut(a: Lut, b: Lut): Lut {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = b[a[i]];
  return l;
}

/** Apply per-channel LUTs (alpha untouched). */
export function applyLuts(img: Img, r: Lut, g: Lut = r, b: Lut = r): Img {
  const out = newImg(img.width, img.height);
  const s = img.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i] = r[s[i]];
    d[i + 1] = g[s[i + 1]];
    d[i + 2] = b[s[i + 2]];
    d[i + 3] = s[i + 3];
  }
  return out;
}

/** Map every pixel through f(r,g,b) → [r,g,b] in 0..255 floats (alpha untouched). */
function mapRgb(img: Img, f: (r: number, g: number, b: number, out: number[]) => void): Img {
  const out = newImg(img.width, img.height);
  const s = img.data, d = out.data;
  const o = [0, 0, 0];
  for (let i = 0; i < s.length; i += 4) {
    f(s[i], s[i + 1], s[i + 2], o);
    d[i] = o[0];
    d[i + 1] = o[1];
    d[i + 2] = o[2];
    d[i + 3] = s[i + 3];
  }
  return out;
}

// ───────── levels ─────────

export interface LevelsParams {
  inBlack: number; // 0..253
  inWhite: number; // 2..255
  gamma: number; // 0.1..9.99, >1 brightens midtones
  outBlack: number;
  outWhite: number;
}

/** Levels transfer: v = clamp((x − inBlack)/(inWhite − inBlack)); v = v^(1/γ); out = outBlack + v·(outWhite − outBlack). */
export function levelsLut(p: LevelsParams): Lut {
  const lo = Math.min(p.inBlack, p.inWhite - 1), hi = Math.max(p.inWhite, lo + 1);
  const g = Math.max(0.01, p.gamma);
  return makeLut((x) => {
    const v = clamp01((x - lo) / (hi - lo));
    return p.outBlack + Math.pow(v, 1 / g) * (p.outWhite - p.outBlack);
  });
}

/** channel: 0 = RGB together, 1 = R, 2 = G, 3 = B. */
export function levels(img: Img, p: LevelsParams & { channel?: number }): Img {
  const lut = levelsLut(p), id = identityLut();
  const ch = p.channel ?? 0;
  return applyLuts(img, ch === 0 || ch === 1 ? lut : id, ch === 0 || ch === 2 ? lut : id, ch === 0 || ch === 3 ? lut : id);
}

// ───────── curves (monotone cubic, Fritsch–Carlson 1980) ─────────

/**
 * Curve through control points (x, y in 0..255) as a LUT. Uses monotone piecewise-cubic Hermite interpolation
 * (Fritsch & Carlson, "Monotone Piecewise Cubic Interpolation", SIAM J. Numer. Anal. 1980): between two points the
 * curve never overshoots, so monotone control points give a monotone LUT. Outside the first/last point the curve is
 * flat. `points` is a flat list [x0, y0, x1, y1, …]; duplicates on x keep the later point.
 */
export function curveLut(points: number[]): Lut {
  const map = new Map<number, number>();
  for (let i = 0; i + 1 < points.length; i += 2) map.set(Math.round(clamp255(points[i])), clamp255(points[i + 1]));
  const xs = [...map.keys()].sort((a, b) => a - b);
  const ys = xs.map((x) => map.get(x)!);
  const n = xs.length;
  if (n === 0) return identityLut();
  if (n === 1) return makeLut(() => ys[0]);
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k] / d[k], b = m[k + 1] / d[k];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[k] = t * a * d[k];
      m[k + 1] = t * b * d[k];
    }
  }
  return makeLut((x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
  });
}

export interface CurvesParams {
  rgb?: number[];
  r?: number[];
  g?: number[];
  b?: number[];
}

/** Channel curves first, then the composite (RGB) curve — both as LUTs, chained into one table per channel. */
export function curves(img: Img, p: CurvesParams): Img {
  const master = p.rgb && p.rgb.length >= 4 ? curveLut(p.rgb) : identityLut();
  const ch = (c?: number[]) => chainLut(c && c.length >= 4 ? curveLut(c) : identityLut(), master);
  return applyLuts(img, ch(p.r), ch(p.g), ch(p.b));
}

// ───────── brightness / contrast ─────────

/**
 * brightness −150..150 (added in 0..255 units), contrast −100..100 (slope about middle grey 127.5:
 * k = 1 + c/100 for c < 0, k = 1/(1 − 0.99·c/100) for c ≥ 0, so +100 is a near-threshold and −100 flat grey).
 */
export function brightnessContrastLut(brightness: number, contrast: number): Lut {
  const c = Math.max(-100, Math.min(100, contrast));
  const k = c < 0 ? 1 + c / 100 : 1 / (1 - (0.99 * c) / 100);
  return makeLut((x) => (x + brightness - 127.5) * k + 127.5);
}

export function brightnessContrast(img: Img, p: { brightness: number; contrast: number }): Img {
  return applyLuts(img, brightnessContrastLut(p.brightness, p.contrast));
}

// ───────── HSL helpers ─────────

/** RGB 0..255 → [h 0..360, s 0..1, l 0..1] */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hue2(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** [h 0..360, s 0..1, l 0..1] → RGB 0..255 floats */
export function hslToRgb(h: number, s: number, l: number, out: number[] = [0, 0, 0]): number[] {
  if (s <= 0) {
    out[0] = out[1] = out[2] = l * 255;
    return out;
  }
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hue2(p, q, hh + 1 / 3) * 255;
  out[1] = hue2(p, q, hh) * 255;
  out[2] = hue2(p, q, hh - 1 / 3) * 255;
  return out;
}

// ───────── hue / saturation / lightness ─────────

/**
 * hue −180..180 (degrees added), saturation −100..100, lightness −100..100.
 * Negative saturation/lightness scale toward 0 (s·(1+v)); positive move toward 1 (s + (1−s)·v).
 * colorize = 1: hue becomes absolute (0..360 via hue+180) and saturation (sat+100)/200 — sepia / duotone look.
 */
export function hueSaturation(img: Img, p: { hue: number; saturation: number; lightness: number; colorize?: number }): Img {
  const sv = p.saturation / 100, lv = p.lightness / 100;
  const colorize = !!p.colorize;
  return mapRgb(img, (r, g, b, o) => {
    let [h, s, l] = rgbToHsl(r, g, b);
    if (colorize) {
      h = p.hue + 180;
      s = clamp01((p.saturation + 100) / 200);
    } else {
      h += p.hue;
      s = sv < 0 ? s * (1 + sv) : s + (1 - s) * sv * (s > 0 ? 1 : 0);
    }
    l = lv < 0 ? l * (1 + lv) : l + (1 - l) * lv;
    hslToRgb(h, clamp01(s), clamp01(l), o);
  });
}

// ───────── colour balance ─────────

export interface ColorBalanceParams {
  /** each −100..100: cyan↔red, magenta↔green, yellow↔blue */
  shadows: number[];
  midtones: number[];
  highlights: number[];
  preserveLuminosity?: number;
}

/**
 * Tone weights from pixel lightness L (0..1): shadows = clamp(1 − 2L)... midtones = 1 − |2L − 1|, highlights = clamp(2L − 1).
 * Each channel moves by (wS·S + wM·M + wH·H)/100 · 0.5 · 255. With preserveLuminosity the HSL lightness is restored.
 */
export function colorBalance(img: Img, p: ColorBalanceParams): Img {
  const S = p.shadows ?? [0, 0, 0], M = p.midtones ?? [0, 0, 0], H = p.highlights ?? [0, 0, 0];
  const keep = !!p.preserveLuminosity;
  return mapRgb(img, (r, g, b, o) => {
    const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
    const ws = clamp01(1 - 2 * l), wm = 1 - Math.abs(2 * l - 1), wh = clamp01(2 * l - 1);
    o[0] = clamp255(r + ((ws * S[0] + wm * M[0] + wh * H[0]) / 100) * 127.5);
    o[1] = clamp255(g + ((ws * S[1] + wm * M[1] + wh * H[1]) / 100) * 127.5);
    o[2] = clamp255(b + ((ws * S[2] + wm * M[2] + wh * H[2]) / 100) * 127.5);
    if (keep) {
      const [hh, ss] = rgbToHsl(o[0], o[1], o[2]);
      hslToRgb(hh, ss, l, o);
    }
  });
}

// ───────── exposure (linear light) ─────────

export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** exposure in stops (−5..5) and offset (−0.5..0.5) applied in linear light (IEC 61966-2-1 sRGB curve), then gamma (out^(1/γ)). */
export function exposureLut(exposure: number, offset = 0, gamma = 1): Lut {
  const k = Math.pow(2, exposure), g = Math.max(0.01, gamma);
  return makeLut((x) => {
    const lin = Math.max(0, srgbToLinear(x / 255) * k + offset);
    return Math.pow(clamp01(linearToSrgb(lin)), 1 / g) * 255;
  });
}

export function exposure(img: Img, p: { exposure: number; offset?: number; gamma?: number }): Img {
  return applyLuts(img, exposureLut(p.exposure, p.offset ?? 0, p.gamma ?? 1));
}

// ───────── black & white (channel mixer) ─────────

/** gray = (r·R + g·G + b·B)/100 (+ constant, −100..100 → ±255). Defaults R30 G59 B11 = Rec. 601 luma. */
export function blackWhite(img: Img, p: { r: number; g: number; b: number; constant?: number }): Img {
  const c = ((p.constant ?? 0) / 100) * 255;
  return mapRgb(img, (r, g, b, o) => {
    const v = clamp255((r * p.r + g * p.g + b * p.b) / 100 + c);
    o[0] = o[1] = o[2] = v;
  });
}

// ───────── white balance ─────────

/** temperature −100..100 (warm = +), tint −100..100 (magenta = +): channel gains R·(1+0.2t) B·(1−0.2t), G·(1−0.2·tint). */
export function temperatureTint(img: Img, p: { temperature: number; tint: number }): Img {
  const t = p.temperature / 100, n = p.tint / 100;
  const rl = makeLut((x) => x * (1 + 0.2 * t)), gl = makeLut((x) => x * (1 - 0.2 * n)), bl = makeLut((x) => x * (1 - 0.2 * t));
  return applyLuts(img, rl, gl, bl);
}

// ───────── simple maps ─────────

export function invert(img: Img): Img {
  return applyLuts(img, makeLut((x) => 255 - x));
}

/** levels 2..255 per channel: round(x·(n−1)/255)·255/(n−1) */
export function posterize(img: Img, p: { levels: number }): Img {
  const n = Math.max(2, Math.min(255, Math.round(p.levels)));
  return applyLuts(img, makeLut((x) => (Math.round((x * (n - 1)) / 255) * 255) / (n - 1)));
}

/** luma ≥ level → white, else black */
export function threshold(img: Img, p: { level: number }): Img {
  return mapRgb(img, (r, g, b, o) => {
    o[0] = o[1] = o[2] = luma(r, g, b) >= p.level ? 255 : 0;
  });
}

// ───────── automatic corrections (histogram stretch) ─────────

const stretch = (lo: number, hi: number): Lut => (hi <= lo ? identityLut() : makeLut((x) => ((x - lo) * 255) / (hi - lo)));

/** Auto levels / "auto tone": stretch every channel on its own, clipping `clip` % at each end (default 0.1 %). */
export function autoLevels(img: Img, p: { clip?: number } = {}): Img {
  const h = histogram(img);
  if (!h.count) return applyLuts(img, identityLut());
  const c = (p.clip ?? 0.1) / 100;
  const [r0, r1] = histRange(h.r, h.count, c), [g0, g1] = histRange(h.g, h.count, c), [b0, b1] = histRange(h.b, h.count, c);
  return applyLuts(img, stretch(r0, r1), stretch(g0, g1), stretch(b0, b1));
}

/** Auto contrast: one stretch for all channels (from the darkest / brightest channel values), so hues do not shift. */
export function autoContrast(img: Img, p: { clip?: number } = {}): Img {
  const h = histogram(img);
  if (!h.count) return applyLuts(img, identityLut());
  const all = new Uint32Array(256);
  for (let i = 0; i < 256; i++) all[i] = h.r[i] + h.g[i] + h.b[i];
  const [lo, hi] = histRange(all, h.count * 3, (p.clip ?? 0.1) / 100);
  return applyLuts(img, stretch(lo, hi));
}

/**
 * Auto colour: per-channel stretch (as auto levels), then neutralise the midtones — each channel gets a gamma that
 * moves its mean to the common mean of the three (γ clamped to 0.5..2), which removes an overall colour cast.
 */
export function autoColor(img: Img, p: { clip?: number } = {}): Img {
  const st = autoLevels(img, p);
  const d = st.data;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
  }
  if (!n) return st;
  const means = [sr / n, sg / n, sb / n];
  const target = (means[0] + means[1] + means[2]) / 3 / 255;
  const luts = means.map((m) => {
    const mm = m / 255;
    if (mm <= 0.001 || mm >= 0.999 || target <= 0.001 || target >= 0.999) return identityLut();
    const gam = Math.max(0.5, Math.min(2, Math.log(target) / Math.log(mm)));
    return makeLut((x) => Math.pow(x / 255, gam) * 255);
  });
  return applyLuts(st, luts[0], luts[1], luts[2]);
}

// ───────── selective colour (선택 색상) ─────────

/** 0 reds · 1 yellows · 2 greens · 3 cyans · 4 blues · 5 magentas · 6 whites · 7 neutrals · 8 blacks (Photoshop's list) */
export type SelectiveColorRange = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** How much of a pixel belongs to `range` (0…1), Photoshop's split of a colour into its max / mid / min channel. */
export function selectiveAmount(range: number, r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), md = r + g + b - mx - mn;
  switch (range) {
    case 0: return r === mx && r > md ? (mx - md) / 255 : 0; // reds: red is the largest
    case 1: return b === mn && b < md ? (md - mn) / 255 : 0; // yellows: blue is the smallest
    case 2: return g === mx && g > md ? (mx - md) / 255 : 0;
    case 3: return r === mn && r < md ? (md - mn) / 255 : 0;
    case 4: return b === mx && b > md ? (mx - md) / 255 : 0;
    case 5: return g === mn && g < md ? (md - mn) / 255 : 0;
    case 6: return mn > 127.5 ? (mn - 127.5) / 127.5 : 0; // whites: every channel over half
    case 7: return mx === 0 || mn === 255 ? 0 : 1 - (Math.abs(mx - 127.5) + Math.abs(mn - 127.5)) / 255;
    case 8: return mx < 127.5 ? (127.5 - mx) / 127.5 : 0; // blacks: every channel under half
    default: return 0;
  }
}

/**
 * 선택 색상 (Photoshop Selective Color): cyan / magenta / yellow / black (−100…100 %) added to or taken from the pixels
 * of one colour range, as ink on the red / green / blue channels (cyan ink = less red). 상대: the change is a share of
 * the ink already there; 절대: of the whole range.
 */
export function selectiveColor(img: Img, p: { range: number; c: number; m: number; y: number; k: number; absolute?: number }): Img {
  const adj = [p.c / 100, p.m / 100, p.y / 100], k = p.k / 100, abs = !!p.absolute;
  return mapRgb(img, (r, g, b, o) => {
    const a = selectiveAmount(p.range, r, g, b);
    const v = [r, g, b];
    for (let i = 0; i < 3; i++) {
      if (!a) { o[i] = v[i]; continue; }
      const ink = 1 - v[i] / 255;
      const d = abs ? adj[i] + k : adj[i] * ink + k * ink;
      o[i] = clamp255(v[i] - a * d * 255);
    }
  });
}
