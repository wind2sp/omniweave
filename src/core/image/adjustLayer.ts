// Adjustment layers (Photoshop's levels, curves, hue / saturation, …): what a layer does to the colours below it,
// as one per-pixel colour function on straight 8-bit RGB. The PSD reader (io/formats/psdAdjust.ts) fills the
// parameters; the pixel compositor (softComposite.ts) and the screen (render/compose.ts) apply them the same way:
//   result = blend(backdrop, f(backdrop)) mixed in by mask × opacity, backdrop alpha kept
// Formulas are fitted against Photoshop-made files (qa/interop/adobe-made/fidelity/omni-fid-adj-*.psd); the point
// operations themselves are shared with the destructive "Image > Adjustments" commands (./adjust.ts).

import { chainLut, identityLut, levelsLut, makeLut, type Lut } from "./adjust";

/** [hue (−180..180), saturation (−100..100), lightness (−100..100)] */
export type Hsl3 = [number, number, number];

export interface LevelsChannel {
  inLo: number;
  inHi: number;
  outLo: number;
  outHi: number;
  /** midtone gamma (1 = none) */
  gamma: number;
}

export type Adjustment =
  | { kind: "invert" }
  | { kind: "threshold"; level: number }
  | { kind: "posterize"; levels: number }
  /** [composite, red, green, blue] (a CMYK document: [composite, cyan, magenta, yellow, black]) */
  | { kind: "levels"; ch: LevelsChannel[] }
  /** channel 0 = composite, 1..3 = red, green, blue (CMYK: 1..4 = C, M, Y, K); points [input, output] 0..255 */
  | { kind: "curves"; ch: { channel: number; pts: [number, number][] }[] }
  | { kind: "brightness"; brightness: number; contrast: number; legacy: boolean }
  | { kind: "hueSat"; colorize: boolean; colorizeHsl: Hsl3; master: Hsl3; ranges: { range: [number, number, number, number]; hsl: Hsl3 }[] }
  /** each [cyan↔red, magenta↔green, yellow↔blue] −100..100 */
  | { kind: "colorBalance"; shadows: Hsl3; midtones: Hsl3; highlights: Hsl3; preserveLum: boolean }
  /** weights in percent (−200..300); tint as 0..255 RGB when on */
  | { kind: "blackWhite"; red: number; yellow: number; green: number; cyan: number; blue: number; magenta: number; tint: [number, number, number] | null }
  | { kind: "exposure"; exposure: number; offset: number; gamma: number }
  /**
   * per colour range (reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks) the cyan, magenta,
   * yellow and black change in percent (−100..100); absolute or relative to the ink there
   */
  | { kind: "selectiveColor"; absolute: boolean; ranges: [number, number, number, number][] }
  /**
   * output red, green, blue (or the grey of `mono`) = Σ weight % × input + constant % of white; a CMYK document's
   * mixer weighs inks instead: `ink` per output C, M, Y, K the weights of C, M, Y, K and the constant
   */
  | { kind: "channelMixer"; mono: boolean; rows: [number, number, number, number][]; ink?: [number, number, number, number, number][] }
  /**
   * the pixel's luminosity looked up in a gradient: colour stops at 0..1 with midpoints (0..1 between two stops),
   * `smooth` 0..1 (classic gradients), `method` the interpolation ("classic", "linear", "smooth" …)
   */
  | { kind: "gradientMap"; stops: { at: number; mid: number; rgb: [number, number, number]; ink?: [number, number, number, number] }[]; smooth: number; method: string; reverse: boolean }
  /** the filter colour (0..255 RGB) at density 0..100 %, luminosity kept or not */
  | { kind: "photoFilter"; rgb: [number, number, number]; density: number; preserveLum: boolean }
  /** −100..100 each */
  | { kind: "vibrance"; vibrance: number; saturation: number }
  /**
   * a 3D table (the layer's ICC device link): per-channel input curves, an n×n×n grid of RGB outputs 0..1 (red
   * slowest, blue fastest), per-channel output curves; a curve is samples 0..1 over 0..1
   */
  | { kind: "colorLookup"; n: number; table: Float32Array; inCurves: Float32Array[]; outCurves: Float32Array[] }
  /** a kind we do not draw (kept on save as it is): no colour change */
  | { kind: "other"; key: string };

/**
 * An adjustment layer's settings on a raster node. The node's tiles carry its layer mask as alpha: where the
 * adjustment applies (`hide` false: a black-default mask) or where it is held back (`hide` true: the usual
 * white-default mask — then a node without tiles applies everywhere).
 */
export interface LayerAdjust {
  adj: Adjustment;
  hide: boolean;
}

/** Colour function on 8-bit values (integers 0..255): out[0..2] = f(r, g, b), 0..255 (may be fractional). */
export type AdjustFn = (r: number, g: number, b: number, out: number[] | Float64Array) => void;

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function lutFn(r: Lut, g: Lut, b: Lut): AdjustFn {
  return (R, G, B, out) => {
    out[0] = r[R];
    out[1] = g[G];
    out[2] = b[B];
  };
}

/** Natural cubic spline through the points (sorted by input), flat beyond the end points. */
export function splineLut(pts: [number, number][]): Lut {
  const p = pts.slice().sort((a, b) => a[0] - b[0]).filter((q, i, a) => i === a.length - 1 || a[i + 1][0] !== q[0]);
  if (p.length < 2) return p.length ? makeLut(() => p[0][1]) : identityLut();
  const n = p.length;
  const x = p.map((q) => q[0]), y = p.map((q) => q[1]);
  // second derivatives, zero at both ends (tridiagonal solve)
  const m = new Float64Array(n), u = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const sig = (x[i] - x[i - 1]) / (x[i + 1] - x[i - 1]);
    const q = sig * m[i - 1] + 2;
    m[i] = (sig - 1) / q;
    u[i] = (6 * ((y[i + 1] - y[i]) / (x[i + 1] - x[i]) - (y[i] - y[i - 1]) / (x[i] - x[i - 1]))) / (x[i + 1] - x[i - 1]);
    u[i] = (u[i] - sig * u[i - 1]) / q;
  }
  m[n - 1] = 0;
  for (let k = n - 2; k >= 0; k--) m[k] = m[k] * m[k + 1] + u[k];
  let k = 0;
  return makeLut((v) => {
    if (v <= x[0]) return y[0];
    if (v >= x[n - 1]) return y[n - 1];
    while (k < n - 2 && v > x[k + 1]) k++;
    const h = x[k + 1] - x[k];
    const a = (x[k + 1] - v) / h, b = (v - x[k]) / h;
    return a * y[k] + b * y[k + 1] + (((a * a * a - a) * m[k] + (b * b * b - b) * m[k + 1]) * (h * h)) / 6;
  });
}

/** `splineLut`'s curve as a function on any input 0..255 (not rounded). */
function splineAt(pts: [number, number][]): (v: number) => number {
  const p = pts.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const x = p.map((q) => q[0]), y = p.map((q) => q[1]);
  const m = new Float64Array(n), u = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const sig = (x[i] - x[i - 1]) / (x[i + 1] - x[i - 1]);
    const q = sig * m[i - 1] + 2;
    m[i] = (sig - 1) / q;
    u[i] = (6 * ((y[i + 1] - y[i]) / (x[i + 1] - x[i]) - (y[i] - y[i - 1]) / (x[i] - x[i - 1]))) / (x[i + 1] - x[i - 1]);
    u[i] = (u[i] - sig * u[i - 1]) / q;
  }
  m[n - 1] = 0;
  for (let k = n - 2; k >= 0; k--) m[k] = m[k] * m[k + 1] + u[k];
  return (v) => {
    if (v <= x[0]) return y[0];
    if (v >= x[n - 1]) return y[n - 1];
    let k = 0;
    while (k < n - 2 && v > x[k + 1]) k++;
    const h = x[k + 1] - x[k];
    const a = (x[k + 1] - v) / h, b = (v - x[k]) / h;
    return a * y[k] + b * y[k + 1] + (((a * a * a - a) * m[k] + (b * b * b - b) * m[k + 1]) * (h * h)) / 6;
  };
}

const levelsOf = (c: LevelsChannel) => levelsLut({ inBlack: c.inLo, inWhite: c.inHi, outBlack: c.outLo, outWhite: c.outHi, gamma: c.gamma });

// ───────── HSL helpers (all 0..1) ─────────

function rgbToHsl(r: number, g: number, b: number, out: number[]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  const d = mx - mn;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  out[0] = h;
  out[1] = s;
  out[2] = l;
}

function hueTo(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number, out: number[] | Float64Array) {
  if (s <= 0) {
    out[0] = out[1] = out[2] = l;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hueTo(p, q, h + 1 / 3);
  out[1] = hueTo(p, q, h);
  out[2] = hueTo(p, q, h - 1 / 3);
}

// ───────── the colour functions ─────────

/** The colour function of an adjustment; null = no change. */
export function adjustFn(a: Adjustment): AdjustFn | null {
  switch (a.kind) {
    case "invert": {
      const t = makeLut((v) => 255 - v);
      return lutFn(t, t, t);
    }
    case "posterize": {
      const n = Math.max(2, Math.min(255, Math.round(a.levels)));
      const t = makeLut((v) => (Math.min(n - 1, Math.floor((v * n) / 256)) * 255) / (n - 1));
      return lutFn(t, t, t);
    }
    case "threshold": {
      const lv = a.level;
      // Photoshop: luminosity 0.3 / 0.59 / 0.11, rounded (omni-fid-adj-threshold: all but 1 pixel of 30 000)
      return (r, g, b, out) => {
        out[0] = out[1] = out[2] = Math.round(0.3 * r + 0.59 * g + 0.11 * b) >= lv ? 255 : 0;
      };
    }
    case "levels": {
      const mt = a.ch[0] ? levelsOf(a.ch[0]) : identityLut();
      const t = [1, 2, 3].map((i) => (a.ch[i] ? chainLut(levelsOf(a.ch[i]), mt) : mt));
      return lutFn(t[0], t[1], t[2]);
    }
    case "curves": {
      const of = (c: number) => {
        const k = a.ch.find((x) => x.channel === c);
        return k && k.pts.length ? splineLut(k.pts) : identityLut();
      };
      const mt = of(0);
      const t = [1, 2, 3].map((c) => chainLut(of(c), mt));
      return lutFn(t[0], t[1], t[2]);
    }
    case "brightness": {
      if (!a.brightness && !a.contrast) return null;
      if (a.legacy) {
        const t = legacyBrightness(a.brightness, a.contrast);
        return lutFn(t, t, t);
      }
      // (current brightness: Photoshop stores the setting elsewhere than Brgh — files made with it read 0 — so only
      // the contrast is drawn as measured; a nonzero Brgh bends the midtones first)
      const bt = a.brightness ? brightnessLut(a.brightness, 0) : null;
      const cf = a.contrast ? contrastFn(a.contrast) : null;
      if (!cf) return lutFn(bt!, bt!, bt!);
      if (!bt) return cf;
      return (r, g, b, out) => cf(bt[r], bt[g], bt[b], out);
    }
    case "exposure": {
      // on a plain 2.2 power (not the sRGB curve): ((v^2.2·2^exposure + offset)^(1/2.2))^(1/gamma)
      const k = Math.pow(2, a.exposure), ig = 1 / Math.max(0.01, a.gamma);
      const t = makeLut((v) => {
        const x = Math.pow(v / 255, 2.2) * k + a.offset;
        return x <= 0 ? 0 : Math.pow(Math.min(1, Math.pow(x, 1 / 2.2)), ig) * 255;
      });
      return lutFn(t, t, t);
    }
    case "hueSat":
      return hueSatFn(a);
    case "colorBalance":
      return colorBalanceFn(a);
    case "blackWhite":
      return blackWhiteFn(a);
    case "selectiveColor":
      return selectiveColorFn(a);
    case "channelMixer":
      // (a CMYK document's mixer weighs inks: only the CMYK compositor draws it — `inkFnOf`)
      return a.ink ? null : channelMixerFn(a);
    case "gradientMap":
      return gradientMapFn(a);
    case "photoFilter":
      return photoFilterFn(a);
    case "vibrance":
      return vibranceFn(a);
    case "colorLookup":
      return colorLookupFn(a);
    case "other":
      return null;
  }
}

/** Legacy brightness / contrast: a shift, then a slope about middle grey. */
function legacyBrightness(br: number, ct: number): Lut {
  const c = ct >= 0 ? 1 / Math.max(0.01, 1 - ct / 100) : 1 + ct / 100;
  return makeLut((v) => (v + br - 127.5) * c + 127.5);
}

// Current (non-legacy) contrast is not per channel: the luminosity Y (0.3 / 0.59 / 0.11) moves along an S-curve and
// each channel's distance from it is scaled, both in proportion to the contrast. Measured per unit of contrast (÷100)
// at Y = 0, 16, …, 256 on omni-fid-adj-brightness (+40), omni-fid-adjv-contrast-up (+60) and -down (−40); the +40 and
// +60 tables agree to a few tenths, so one table serves each sign.
const CT_SHIFT_UP = [0, -18.65, -22.68, -26.35, -28.44, -27.66, -23.62, -16.59, -8.44, 1.85, 13.43, 19.08, 22.17, 21.16, 17.18, 9.2, 0];
const CT_SHIFT_DOWN = [0, 19.25, 22.5, 25, 25.73, 23.75, 19.55, 13.3, 6.18, -0.35, -10.3, -15.55, -19, -19.25, -16.25, -10.28, 0];
const CT_CHROMA_UP = [-0.4, -0.33, -0.12, 0.08, 0.22, 0.4, 0.56, 0.6, 0.54, 0.5, 0.25, 0.12, -0.04, -0.13, -0.23, -0.38, -0.4];
const CT_CHROMA_DOWN = [-0.3, -0.3, -0.47, -0.29, -0.36, -0.35, -0.43, -0.46, -0.45, -0.47, -0.31, -0.26, -0.22, -0.11, 0.07, 0.3, 0.3];

function sampled(t: number[], y: number): number {
  const x = Math.max(0, Math.min(255.999, y)) / 16;
  const i = Math.floor(x), f = x - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}

function contrastFn(ct: number): AdjustFn {
  const s = Math.abs(ct) / 100;
  const sh = ct > 0 ? CT_SHIFT_UP : CT_SHIFT_DOWN, ch = ct > 0 ? CT_CHROMA_UP : CT_CHROMA_DOWN;
  return (r, g, b, out) => {
    const y = 0.3 * r + 0.59 * g + 0.11 * b;
    const f = y + s * sampled(sh, y), k = 1 + s * sampled(ch, y);
    out[0] = clamp8(f + (r - y) * k);
    out[1] = clamp8(f + (g - y) * k);
    out[2] = clamp8(f + (b - y) * k);
  };
}

/** Brightness / contrast (current): brightness bends the midtones like a gamma, contrast is an S-curve about grey. */
function brightnessLut(br: number, ct: number): Lut {
  const bt = br ? makeLut((v) => Math.pow(v / 255, br > 0 ? 1 / (1 + br / 100) : 1 - br / 150) * 255) : identityLut();
  if (!ct) return bt;
  const k = ct / 100;
  const st = makeLut((v) => {
    const x = v / 255;
    const s = x < 0.5 ? 0.5 * Math.pow(2 * x, 1 + k) : 1 - 0.5 * Math.pow(2 * (1 - x), 1 + k);
    return (k >= 0 ? s : x + (x - s)) * 255;
  });
  return chainLut(bt, st);
}

const lightness = (v: number, l: number) => (l > 0 ? v + ((255 - v) * l) / 100 : l < 0 ? (v * (100 + l)) / 100 : v);

/** Share (0..1) of a hue / saturation colour range at hue `h` (degrees): full between the inner two, ramps outside. */
function rangeWeight(h: number, r: [number, number, number, number]): number {
  const a = r[0];
  const rel = (v: number) => (((v - a) % 360) + 360) % 360;
  const x = rel(h), B = rel(r[1]), C = rel(r[2]), D = rel(r[3]);
  if (x <= B) return B > 0 ? x / B : 1;
  if (x <= C) return 1;
  if (x <= D) return D > C ? (D - x) / (D - C) : 0;
  return 0;
}

function hueSatFn(a: Extract<Adjustment, { kind: "hueSat" }>): AdjustFn | null {
  const hsl = [0, 0, 0];
  const tmp = new Float64Array(3);
  if (a.colorize) {
    const [H, S, L] = a.colorizeHsl;
    return (r, g, b, out) => {
      // the pixel's HSL lightness (moved by L) in the given hue and saturation (omni-fid-adjv-huesat-colorize)
      const l = lightness((Math.max(r, g, b) + Math.min(r, g, b)) / 2, L) / 255;
      hslToRgb((((H % 360) + 360) % 360) / 360, S / 100, l, tmp);
      for (let i = 0; i < 3; i++) out[i] = clamp8(tmp[i] * 255);
    };
  }
  const [H, S, L] = a.master;
  const ranges = a.ranges.filter((r) => r.hsl[0] || r.hsl[1] || r.hsl[2]);
  if (!H && !S && !L && !ranges.length) return null;
  return (r, g, b, out) => {
    rgbToHsl(r / 255, g / 255, b / 255, hsl);
    let dh = H, ds = S, dl = L;
    for (const rg of ranges) {
      const w = rangeWeight(hsl[0] * 360, rg.range);
      dh += rg.hsl[0] * w;
      ds += rg.hsl[1] * w;
      dl += rg.hsl[2] * w;
    }
    const h = (((hsl[0] * 360 + dh) % 360) + 360) % 360;
    hslToRgb(h / 360, hsl[1], hsl[2], tmp);
    // saturation: each channel's distance from the HSL lightness scaled by 1 + s (s < 0) or 1 / (1 − s) (s > 0), no
    // further than a channel reaching 0 or 255 (omni-fid-adjv-huesat-satup)
    if (ds) {
      const L = hsl[2], mx = Math.max(tmp[0], tmp[1], tmp[2]), mn = Math.min(tmp[0], tmp[1], tmp[2]);
      let k = ds < 0 ? 1 + ds / 100 : ds >= 100 ? Infinity : 1 / (1 - ds / 100);
      if (ds > 0) k = Math.min(k, mx > L ? (1 - L) / (mx - L) : Infinity, mn < L ? L / (L - mn) : Infinity);
      if (!isFinite(k)) k = 1;
      for (let i = 0; i < 3; i++) tmp[i] = L + (tmp[i] - L) * k;
    }
    for (let i = 0; i < 3; i++) out[i] = clamp8(lightness(tmp[i] * 255, dl));
  };
}

/**
 * Colour balance, per channel (fitted on omni-fid-adj-colorbalance and omni-fid-adjv-balance-*):
 *   midtones   a gamma 2^(−a/100) (+30 → 0.81: the channel's midtones up)
 *   shadows    a > 0: a gentle gamma 2^(−a/200); a < 0: v − 1.1·(−a)·(1 − (v/255)²)
 *   highlights a > 0: the white point moves down by a; a < 0: a gentle gamma 2^(−a/200)
 * With luminosity kept, each range's three amounts are first shifted so their effect evens out: midtones about the
 * middle of the largest and smallest, highlights so the smallest is 0, shadows so the largest is 0.
 */
function colorBalanceFn(a: Extract<Adjustment, { kind: "colorBalance" }>): AdjustFn | null {
  if ([...a.shadows, ...a.midtones, ...a.highlights].every((v) => !v)) return null;
  const keep = (v: Hsl3, by: number): Hsl3 => (a.preserveLum ? (v.map((x) => x - by) as Hsl3) : v);
  const mid = keep(a.midtones, (Math.max(...a.midtones) + Math.min(...a.midtones)) / 2);
  const sh = keep(a.shadows, Math.max(...a.shadows));
  const hi = keep(a.highlights, Math.min(...a.highlights));
  const gamma = (g: number) => makeLut((v) => Math.pow(v / 255, g) * 255);
  const t = [0, 1, 2].map((c) => {
    let l = identityLut();
    if (sh[c] > 0) l = chainLut(l, gamma(Math.pow(2, -sh[c] / 200)));
    // a < 0: darker by 1.1 × −a at black, fading as (1 − x²) to nothing at white (omni-fid-adjv-balance-shadows,
    // green −10: every level within 1 — moving the black point up by −a was 2–3 levels too light in the midtones)
    else if (sh[c] < 0) {
      const k = -1.1 * sh[c];
      l = chainLut(l, makeLut((v) => v - k * (1 - (v / 255) ** 2)));
    }
    if (mid[c]) l = chainLut(l, gamma(Math.pow(2, -mid[c] / 100)));
    if (hi[c] > 0) l = chainLut(l, makeLut((v) => (v * 255) / (255 - Math.min(254, hi[c]))));
    else if (hi[c] < 0) l = chainLut(l, gamma(Math.pow(2, -hi[c] / 200)));
    return l;
  });
  return lutFn(t[0], t[1], t[2]);
}

function blackWhiteFn(a: Extract<Adjustment, { kind: "blackWhite" }>): AdjustFn {
  const R = a.red / 100, Y = a.yellow / 100, G = a.green / 100, C = a.cyan / 100, Bl = a.blue / 100, M = a.magenta / 100;
  // tint: grey + (tint − the tint's luminosity), the colour shrunk near black and white so no channel clips
  // (omni-fid-adjv-blackwhite-tint)
  const tint = a.tint;
  const d = tint ? tint.map((v) => v - (0.3 * tint[0] + 0.59 * tint[1] + 0.11 * tint[2])) : [0, 0, 0];
  const dLo = Math.max(1e-6, -Math.min(...d)), dHi = Math.max(1e-6, Math.max(...d));
  return (r, g, b, out) => {
    // grey = min + (mid − min)·w(the secondary colour of max and mid) + (max − mid)·w(the primary colour of max)
    let mx: number, md: number, mn: number, wp: number, ws: number;
    if (r >= g && r >= b) {
      mx = r;
      wp = R;
      if (g >= b) ((md = g), (mn = b), (ws = Y));
      else ((md = b), (mn = g), (ws = M));
    } else if (g >= b) {
      mx = g;
      wp = G;
      if (r >= b) ((md = r), (mn = b), (ws = Y));
      else ((md = b), (mn = r), (ws = C));
    } else {
      mx = b;
      wp = Bl;
      if (r >= g) ((md = r), (mn = g), (ws = M));
      else ((md = g), (mn = r), (ws = C));
    }
    const y = clamp8(mn + (md - mn) * ws + (mx - md) * wp);
    if (!tint) {
      out[0] = out[1] = out[2] = y;
      return;
    }
    const k = Math.min(1, y / dLo, (255 - y) / dHi);
    for (let i = 0; i < 3; i++) out[i] = clamp8(y + d[i] * k);
  };
}

/** Channel mixer (omni-fid-adk-mixer, -mono: exact): each output a weighted sum of the inputs plus a constant. */
function channelMixerFn(a: Extract<Adjustment, { kind: "channelMixer" }>): AdjustFn {
  const rows = a.mono ? [a.rows[0], a.rows[0], a.rows[0]] : a.rows;
  return (r, g, b, out) => {
    for (let i = 0; i < 3; i++) {
      const w = rows[i];
      out[i] = clamp8((w[0] * r + w[1] * g + w[2] * b + w[3] * 255) / 100);
    }
  };
}

/** Selective colour (omni-fid-adk-selective-rel / -abs: exact): each range's ink change weighed by how much of it the pixel has. */
function selectiveColorFn(a: Extract<Adjustment, { kind: "selectiveColor" }>): AdjustFn | null {
  const used = a.ranges.map((v, k) => [k, v] as const).filter(([, v]) => v[0] || v[1] || v[2] || v[3]);
  if (!used.length) return null;
  const amt = new Float64Array(9);
  const v = [0, 0, 0], d = [0, 0, 0];
  return (r, g, b, out) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), md = r + g + b - mx - mn;
    // how much of each range the pixel has (0..255): a primary its largest channel's lead over the middle one, a
    // secondary the middle one's lead over the smallest; whites / blacks how far the smallest / largest is past middle
    // grey (× 2), neutrals what is left of 255 after both distances from middle grey
    amt.fill(0);
    if (r === mx) amt[0] = mx - md;
    if (g === mx) amt[2] = mx - md;
    if (b === mx) amt[4] = mx - md;
    if (b === mn) amt[1] = md - mn;
    if (r === mn) amt[3] = md - mn;
    if (g === mn) amt[5] = md - mn;
    amt[6] = Math.max(0, mn - 127.5) * 2;
    amt[7] = 255 - (Math.abs(mx - 127.5) + Math.abs(mn - 127.5));
    amt[8] = Math.max(0, 127.5 - mx) * 2;
    v[0] = r / 255;
    v[1] = g / 255;
    v[2] = b / 255;
    d[0] = d[1] = d[2] = 0;
    for (const [k, s] of used) {
      const A = amt[k] / 255;
      if (A <= 0) continue;
      const K = s[3] / 100;
      for (let c = 0; c < 3; c++) {
        const C = s[c] / 100;
        // in ink terms (1 − value) the change is C + K + C·K (the black adds ink in proportion), of the ink there
        // when relative; it never goes past 0 or 255 before it is weighed by the range's share
        // (omni-fid-adk-selective-rel / -abs)
        const raw = -(C + K + C * K) * (a.absolute ? 1 : 1 - v[c]);
        d[c] += A * Math.min(1 - v[c], Math.max(-v[c], raw));
      }
    }
    for (let c = 0; c < 3; c++) out[c] = clamp8((v[c] + d[c]) * 255);
  };
}

// sRGB ↔ linear light and Oklab (gradient interpolation, photo filter); the Oklab matrices are Björn Ottosson's
// published ones ("A perceptual color space for image processing", 2020, public domain / MIT)
const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toEnc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
/** A 256-entry table of fractional values (makeLut rounds to bytes). */
function fineLut(f: (v: number) => number): Float64Array {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = f(i);
  return t;
}
const LIN8 = fineLut((v) => toLin(v / 255));
function oklab(rgb: readonly number[]): number[] {
  const [r, g, b] = rgb.map((v) => toLin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab(c: readonly number[]): number[] {
  const l = (c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2]) ** 3;
  const m = (c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2]) ** 3;
  const s = (c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2]) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, b].map((v) => toEnc(v) * 255);
}

/** Samples of the gradient over 0..1 (GRAD_N + 1 colours, 0..255). */
const GRAD_N = 1024;
function gradientSamples(a: Extract<Adjustment, { kind: "gradientMap" }>, ink = false): Float64Array {
  const st = a.stops;
  const n = st.length;
  // (a CMYK document: the stops' four stored ink values, mixed the same way)
  const NC = ink ? 4 : 3;
  const cols = st.map((s) => (ink ? s.ink ?? [...s.rgb, 255] : s.rgb));
  // the space the colours are mixed in: classic in the stored values, linear in linear light (both exact on
  // omni-fid-adk-gradmap / -linear), the newer ones (smooth, perceptual) straight in Oklab — Photoshop also rounds
  // the corner at each stop, which this does not (omni-fid-adk-gradmap-default: a few levels near the stops)
  const space = ink || a.method === "classic" || a.method === "stripes" ? 0 : a.method === "linear" ? 1 : 2;
  const fwd = (c: readonly number[]) => (space === 0 ? c.slice() : space === 1 ? c.map((v) => toLin(v / 255)) : oklab(c));
  const back = (c: readonly number[]) => (space === 0 ? c.slice() : space === 1 ? c.map((v) => toEnc(v) * 255) : fromOklab(c));
  const P = cols.map((c) => fwd(c));
  const T = st.map((s) => s.at);
  // classic: Catmull-Rom through the stops per channel (an end's slope half its segment's), held between the two
  // stops' values, mixed with straight lines by the smoothness (omni-fid-adk-gradmap)
  const slope = (k: number, c: number) => {
    if (n < 2) return 0;
    if (k === 0) return T[1] > T[0] ? (P[1][c] - P[0][c]) / (T[1] - T[0]) / 2 : 0;
    if (k === n - 1) return T[k] > T[k - 1] ? (P[k][c] - P[k - 1][c]) / (T[k] - T[k - 1]) / 2 : 0;
    return T[k + 1] > T[k - 1] ? (P[k + 1][c] - P[k - 1][c]) / (T[k + 1] - T[k - 1]) : 0;
  };
  const curve = space === 0 ? a.smooth : 0;
  const out = new Float64Array((GRAD_N + 1) * NC);
  const chans = ink ? [0, 1, 2, 3] : [0, 1, 2];
  let k = 0;
  for (let i = 0; i <= GRAD_N; i++) {
    let t = i / GRAD_N;
    if (a.reverse) t = 1 - t;
    let c: number[];
    if (t <= T[0]) c = P[0].slice();
    else if (t >= T[n - 1]) c = P[n - 1].slice();
    else {
      k = 0;
      while (k < n - 2 && t > T[k + 1]) k++;
      const h = T[k + 1] - T[k];
      let f = h > 0 ? (t - T[k]) / h : 1;
      // midpoint: where the two colours are half and half
      const m = Math.min(0.995, Math.max(0.005, st[k + 1].mid));
      f = f < m ? (0.5 * f) / m : 0.5 + (0.5 * (f - m)) / (1 - m);
      c = chans.map((j) => {
        const lin = P[k][j] + (P[k + 1][j] - P[k][j]) * f;
        if (!curve) return lin;
        const f2 = f * f, f3 = f2 * f;
        const hv = (2 * f3 - 3 * f2 + 1) * P[k][j] + (f3 - 2 * f2 + f) * h * slope(k, j) + (-2 * f3 + 3 * f2) * P[k + 1][j] + (f3 - f2) * h * slope(k + 1, j);
        const lo = Math.min(P[k][j], P[k + 1][j]), hi = Math.max(P[k][j], P[k + 1][j]);
        return lin + (Math.min(hi, Math.max(lo, hv)) - lin) * curve;
      });
    }
    const e = back(c);
    for (let j = 0; j < NC; j++) out[i * NC + j] = clamp8(e[j]);
  }
  return out;
}

function gradientMapFn(a: Extract<Adjustment, { kind: "gradientMap" }>): AdjustFn {
  const lut = gradientSamples(a);
  return (r, g, b, out) => {
    // the luminosity 0.3 / 0.59 / 0.11 as the place in the gradient
    const x = ((0.3 * r + 0.59 * g + 0.11 * b) / 255) * GRAD_N;
    const i = Math.min(GRAD_N - 1, Math.floor(x)), f = x - i;
    for (let j = 0; j < 3; j++) out[j] = lut[i * 3 + j] + (lut[i * 3 + 3 + j] - lut[i * 3 + j]) * f;
  };
}

/** Photoshop's luminosity blend: the colour moved to luminosity l (0.3 / 0.59 / 0.11), pulled in where it clips. */
function setLum(c: number[], l: number) {
  const d = l - (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]);
  for (let i = 0; i < 3; i++) c[i] += d;
  const mn = Math.min(c[0], c[1], c[2]), mx = Math.max(c[0], c[1], c[2]);
  if (mn < 0 && l > mn) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / (l - mn);
  if (mx > 255 && mx > l) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (255 - l)) / (mx - l);
}

/** sRGB (linear) → CIE XYZ D50, Bradford-adapted: Photoshop's connection space. */
const SRGB_XYZ50 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
function inverse3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
/** Linear light 0..1 → 8-bit encoded, by table (ENC_N steps). */
const ENC_N = 4096;
const ENC = (() => {
  const t = new Float64Array(ENC_N + 1);
  for (let i = 0; i <= ENC_N; i++) t[i] = toEnc(i / ENC_N) * 255;
  return t;
})();
function encode8(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const x = v * ENC_N, i = Math.floor(x);
  return ENC[i] + (ENC[i + 1] - ENC[i]) * (x - i);
}

/**
 * Photo filter (omni-fid-adk-photofilter*): the colour times (1 − density + density × filter) in CIE XYZ (D50), the
 * filter taken relative to white, so grey moves to the filter's hue; with luminosity kept, the result's luminosity
 * is then set back to the pixel's (as the luminosity blend does: 0.3 / 0.59 / 0.11, pulled in where it clips).
 */
function photoFilterFn(a: Extract<Adjustment, { kind: "photoFilter" }>): AdjustFn | null {
  const d = Math.min(1, Math.max(0, a.density / 100));
  if (!d) return null;
  const m = SRGB_XYZ50, mi = inverse3(m);
  const fl = a.rgb.map((v) => toLin(v / 255));
  const k = [0, 1, 2].map((r) => 1 - d + (d * (m[r * 3] * fl[0] + m[r * 3 + 1] * fl[1] + m[r * 3 + 2] * fl[2])) / (m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2]));
  // one matrix: XYZ back to RGB · the filter · RGB to XYZ
  const T = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) T[r * 3 + c] = mi[r * 3] * k[0] * m[c] + mi[r * 3 + 1] * k[1] * m[3 + c] + mi[r * 3 + 2] * k[2] * m[6 + c];
  const c = [0, 0, 0];
  return (r, g, b, out) => {
    const R = LIN8[r], G = LIN8[g], B = LIN8[b];
    for (let i = 0; i < 3; i++) c[i] = encode8(T[i * 3] * R + T[i * 3 + 1] * G + T[i * 3 + 2] * B);
    if (a.preserveLum) setLum(c, 0.3 * r + 0.59 * g + 0.11 * b);
    for (let i = 0; i < 3; i++) out[i] = clamp8(c[i]);
  };
}

/**
 * Vibrance (fitted on a 64-step colour cube through Photoshop, omni-fid-adk-vibrance*):
 *   saturation   exact: in linear light each channel's distance from the grey 0.2881 R + 0.7119 G (blue not
 *                counted) times 1 + s, clipped
 *   vibrance     an approximation: each channel moved away from (v > 0) or toward (v < 0) the largest one by an
 *                amount that falls with the pixel's saturation — fully saturated colours keep theirs — and for
 *                v > 0 less around red-orange (skin). Photoshop's own curve also moves the largest channel a little;
 *                this one does not (within 2 levels on 50–70 % of the colours, a few levels elsewhere).
 */
function vibranceFn(a: Extract<Adjustment, { kind: "vibrance" }>): AdjustFn | null {
  const V = Math.max(-1, Math.min(1, a.vibrance / 100)), S = Math.max(-1, Math.min(1, a.saturation / 100));
  if (!V && !S) return null;
  const v = [0, 0, 0];
  return (r, g, b, out) => {
    if (V > 0) {
      // in the stored values: pushed from the largest channel by V × (0.523 − 0.513 × saturation), × (1 − 0.345 near red)
      const R = r / 255, G = g / 255, B = b / 255;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
      if (d > 0) {
        const sat = d / mx;
        const h = mx === R ? ((G - B) / d + 6) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
        const skin = Math.max(0, 1 - Math.min(h, 6 - h) / 0.947);
        const q = V * Math.max(0, 0.5231 - 0.5125 * sat) * (1 - 0.3453 * skin);
        v[0] = LIN8[Math.round(clamp8((R + (R - mx) * q) * 255))];
        v[1] = LIN8[Math.round(clamp8((G + (G - mx) * q) * 255))];
        v[2] = LIN8[Math.round(clamp8((B + (B - mx) * q) * 255))];
      } else ((v[0] = LIN8[r]), (v[1] = LIN8[g]), (v[2] = LIN8[b]));
    } else {
      v[0] = LIN8[r];
      v[1] = LIN8[g];
      v[2] = LIN8[b];
      if (V < 0) {
        // in linear light: pulled toward the largest channel by −V × (0.767 − 0.503 × saturation)
        const mx = Math.max(v[0], v[1], v[2]), mn = Math.min(v[0], v[1], v[2]);
        if (mx > mn) {
          const q = -V * Math.max(0, 0.7672 - 0.5031 * ((mx - mn) / mx));
          for (let i = 0; i < 3; i++) v[i] += (mx - v[i]) * q;
        }
      }
    }
    if (S) {
      const gr = 0.2881 * v[0] + 0.7119 * v[1];
      for (let i = 0; i < 3; i++) v[i] = Math.min(1, Math.max(0, gr + (v[i] - gr) * (1 + S)));
    }
    for (let i = 0; i < 3; i++) out[i] = encode8(v[i]);
  };
}

/** Colour lookup (omni-fid-adk-lookup: exact to a level): the device link's grid, trilinear between its points. */
function colorLookupFn(a: Extract<Adjustment, { kind: "colorLookup" }>): AdjustFn {
  const { n, table: T, inCurves, outCurves } = a;
  const curve = (c: Float32Array, v: number) => {
    const x = Math.max(0, Math.min(1, v)) * (c.length - 1), i = Math.min(c.length - 2, Math.floor(x)), f = x - i;
    return c[i] + (c[i + 1] - c[i]) * f;
  };
  const inL = inCurves.map((c) => fineLut((v) => curve(c, v / 255) * (n - 1)));
  const at = (i: number, j: number, k: number, c: number) => T[((i * n + j) * n + k) * 3 + c];
  return (r, g, b, out) => {
    const x = inL[0][r], y = inL[1][g], z = inL[2][b];
    const i = Math.min(n - 2, Math.floor(x)), j = Math.min(n - 2, Math.floor(y)), k = Math.min(n - 2, Math.floor(z));
    const fx = x - i, fy = y - j, fz = z - k;
    for (let c = 0; c < 3; c++) {
      // trilinear
      const c00 = at(i, j, k, c) * (1 - fx) + at(i + 1, j, k, c) * fx;
      const c01 = at(i, j, k + 1, c) * (1 - fx) + at(i + 1, j, k + 1, c) * fx;
      const c10 = at(i, j + 1, k, c) * (1 - fx) + at(i + 1, j + 1, k, c) * fx;
      const c11 = at(i, j + 1, k + 1, c) * (1 - fx) + at(i + 1, j + 1, k + 1, c) * fx;
      const v = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
      out[c] = clamp8(curve(outCurves[c], v) * 255);
    }
  };
}

/** Memoized colour function of a node's adjustment (one per settings object). */
const fnCache = new WeakMap<Adjustment, AdjustFn | null>();
export function adjustFnOf(a: Adjustment): AdjustFn | null {
  if (!fnCache.has(a)) fnCache.set(a, adjustFn(a));
  return fnCache.get(a)!;
}

// ───────── CMYK documents ─────────
//
// Photoshop applies an adjustment to a CMYK document's four stored channels (255 = no ink), not to an RGB picture.
// Fitted on Photoshop-made CMYK files (qa/interop/adobe-made/fidelity/omni-fid-cmyk-adj-*.psd):
//   per channel, black too   invert, posterize, levels and curves (channel 1..4 = C, M, Y, K after the composite),
//                            brightness / contrast (legacy and current: the curve RGB grey gets)
//   C, M, Y as R, G, B       hue / saturation, colour balance — black is kept
//   through RGB              threshold, colorize, photo filter: the colour as RGB = stored value × black (R = C·K / 255),
//                            back with black = the largest channel (C = 255·R / K) — or black kept (photo filter)
//   in inks                  selective colour, channel mixer, gradient map (their own CMYK settings)
// Black & white, exposure and vibrance do not exist in CMYK (Photoshop refuses them).

/** Colour function on a CMYK document's stored values (integers 0..255, 255 = no ink): out[0..3] = C, M, Y, K. */
export type InkFn = (c: number, m: number, y: number, k: number, out: Float64Array) => void;

/** Per-channel tables (C, M, Y, K) as an ink function. */
function lutInk(t: readonly Lut[]): InkFn {
  return (c, m, y, k, out) => {
    out[0] = t[0][c];
    out[1] = t[1][m];
    out[2] = t[2][y];
    out[3] = t[3][k];
  };
}

/** One table for all four channels: what an RGB grey gets from `f`. */
function greyLut(f: AdjustFn): Lut {
  const o = [0, 0, 0];
  return makeLut((v) => (f(v, v, v, o), o[0]));
}

/** The stored C, M, Y as R, G, B through `f`; black kept. */
function cmyInk(f: AdjustFn): InkFn {
  const o = [0, 0, 0];
  return (c, m, y, k, out) => {
    f(c, m, y, o);
    out[0] = o[0];
    out[1] = o[1];
    out[2] = o[2];
    out[3] = k;
  };
}

/** The colour as RGB (stored value × black), and back: black the largest channel, or kept (`keepK`). */
function rgbInk(f: AdjustFn, keepK: boolean): InkFn {
  const o = [0, 0, 0];
  return (c, m, y, k, out) => {
    f(Math.round((c * k) / 255), Math.round((m * k) / 255), Math.round((y * k) / 255), o);
    const K = keepK ? k : Math.max(o[0], o[1], o[2]);
    if (K <= 0) {
      out[0] = out[1] = out[2] = 255;
      out[3] = 0;
      return;
    }
    for (let i = 0; i < 3; i++) out[i] = clamp8((255 * o[i]) / K);
    out[3] = K;
  };
}

/**
 * Current brightness / contrast on a CMYK document's channels (fitted on omni-fid-cmyk-adj-bright-*, -contrast-*,
 * -brightness: within 1 level for contrast, 1–3 for brightness): contrast c is the curve through (64, 64 − c/4) and
 * (192, 192 + c/4); brightness b > 0 the curve through (48, 48 + 0.333 b), (128, 128 + 0.855 b) and
 * (208, 208 + 0.64 b) — b < 0 the inverse of that for −b (bright-down is bright-up's inverse to a level); brightness
 * first.
 */
function inkBrightnessLut(br: number, ct: number): Lut {
  // (the top point saturates: +27 at 40, +30 at 50)
  const pts = (b: number): [number, number][] => [[0, 0], [48, Math.min(250, 48 + 0.333 * b)], [128, Math.min(252, 128 + 0.855 * b)], [208, 208 + 47 * (1 - Math.exp(-b / 46.9))], [255, 255]];
  let bt = identityLut();
  if (br > 0) bt = splineLut(pts(br));
  else if (br < 0) {
    // the inverse, by bisection on the (increasing) curve
    const f = splineAt(pts(-br));
    bt = makeLut((v) => {
      let lo = 0, hi = 255;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < v) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    });
  }
  if (!ct) return bt;
  return chainLut(bt, splineLut([[0, 0], [64, 64 - ct / 4], [192, 192 + ct / 4], [255, 255]]));
}

/** Adjustments Photoshop has no CMYK form of (it refuses them in a CMYK document): drawn by `inkFn`'s fallback. */
const NOT_IN_CMYK = new Set<Adjustment["kind"]>(["blackWhite", "exposure", "vibrance", "colorLookup"]);

/**
 * How a CMYK document draws this adjustment when it is not the way Photoshop does (the open notice names it):
 * "fallback" — a kind Photoshop has no CMYK form of, drawn on C, M, Y as RGB and black as a grey; "skipped" — a
 * channel mixer without its ink rows, not drawn. Null: drawn on the inks as Photoshop does (or not drawn at all,
 * kind "other", which the import counts on its own).
 */
export function inkApproximation(a: Adjustment): "fallback" | "skipped" | null {
  if (NOT_IN_CMYK.has(a.kind)) return "fallback";
  if (a.kind === "channelMixer" && !a.ink) return "skipped";
  return null;
}

function inkFn(a: Adjustment): InkFn | null {
  switch (a.kind) {
    case "brightness": {
      if (!a.brightness && !a.contrast) return null;
      const t = a.legacy ? legacyBrightness(a.brightness, a.contrast) : inkBrightnessLut(a.brightness, a.contrast);
      return lutInk([t, t, t, t]);
    }
    case "invert":
    case "posterize": {
      const f = adjustFn(a);
      if (!f) return null;
      const t = greyLut(f);
      return lutInk([t, t, t, t]);
    }
    case "levels": {
      const mt = a.ch[0] ? levelsOf(a.ch[0]) : identityLut();
      return lutInk([1, 2, 3, 4].map((i) => (a.ch[i] ? chainLut(levelsOf(a.ch[i]), mt) : mt)));
    }
    case "curves": {
      const of = (c: number) => {
        const k = a.ch.find((x) => x.channel === c);
        return k && k.pts.length ? splineLut(k.pts) : identityLut();
      };
      const mt = of(0);
      return lutInk([1, 2, 3, 4].map((c) => chainLut(of(c), mt)));
    }
    case "threshold": {
      const lv = a.level;
      return (c, m, y, k, out) => {
        const l = Math.round((0.3 * c + 0.59 * m + 0.11 * y) * (k / 255));
        out[0] = out[1] = out[2] = 255;
        out[3] = l >= lv ? 255 : 0;
      };
    }
    case "hueSat": {
      const f = hueSatFn(a);
      return f ? (a.colorize ? rgbInk(f, false) : cmyInk(f)) : null;
    }
    case "colorBalance": {
      const f = colorBalanceFn(a);
      return f ? cmyInk(f) : null;
    }
    case "photoFilter": {
      const f = photoFilterFn(a);
      return f ? rgbInk(f, true) : null;
    }
    case "selectiveColor":
      return selectiveInk(a);
    case "channelMixer":
      return a.ink ? mixerInk(a.ink) : null;
    case "gradientMap": {
      // the place in the gradient: the luminosity of the colour as RGB (stored value × black), as threshold
      const lut = gradientSamples(a, true);
      return (c, m, y, k, out) => {
        const x = (((0.3 * c + 0.59 * m + 0.11 * y) * (k / 255)) / 255) * GRAD_N;
        const i = Math.min(GRAD_N - 1, Math.floor(x)), f = x - i;
        for (let j = 0; j < 4; j++) out[j] = lut[i * 4 + j] + (lut[i * 4 + 4 + j] - lut[i * 4 + j]) * f;
      };
    }
    default: {
      // not in CMYK (a file from elsewhere): C, M, Y as RGB, black as a grey — as drawn before
      const f = adjustFn(a);
      if (!f) return null;
      const o = [0, 0, 0];
      return (c, m, y, k, out) => {
        f(c, m, y, o);
        out[0] = o[0];
        out[1] = o[1];
        out[2] = o[2];
        f(k, k, k, o);
        out[3] = o[0];
      };
    }
  }
}

/** Selective colour on inks: each range's change of C, M, Y, K weighed by how much of the range the pixel has. */
// (amt: reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks — as selectiveColorFn)
function selectiveInk(a: Extract<Adjustment, { kind: "selectiveColor" }>): InkFn | null {
  const used = a.ranges.map((v, k) => [k, v] as const).filter(([, v]) => v[0] || v[1] || v[2] || v[3]);
  if (!used.length) return null;
  const amt = new Float64Array(9);
  const ink = [0, 0, 0, 0], d = [0, 0, 0, 0];
  return (c, m, y, k, out) => {
    // how much of each range: as selectiveColorFn, from the colour as RGB (stored value × black)
    const r = (c * k) / 255, g = (m * k) / 255, b = (y * k) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), md = r + g + b - mx - mn;
    amt.fill(0);
    if (r === mx) amt[0] = mx - md;
    if (g === mx) amt[2] = mx - md;
    if (b === mx) amt[4] = mx - md;
    if (b === mn) amt[1] = md - mn;
    if (r === mn) amt[3] = md - mn;
    if (g === mn) amt[5] = md - mn;
    amt[6] = Math.max(0, mn - 127.5) * 2;
    amt[7] = 255 - (Math.abs(mx - 127.5) + Math.abs(mn - 127.5));
    amt[8] = Math.max(0, 127.5 - mx) * 2;
    ink[0] = 1 - c / 255;
    ink[1] = 1 - m / 255;
    ink[2] = 1 - y / 255;
    ink[3] = 1 - k / 255;
    d[0] = d[1] = d[2] = d[3] = 0;
    for (const [q, s] of used) {
      const A = amt[q] / 255;
      if (A <= 0) continue;
      // each ink straight (the black too): its change, of the ink there when relative, within 0..100 %
      // (omni-fid-cmyk-adj-selective-rel / -abs: within a level)
      for (let i = 0; i < 4; i++) {
        const raw = (s[i] / 100) * (a.absolute ? 1 : ink[i]);
        d[i] += A * Math.min(1 - ink[i], Math.max(-ink[i], raw));
      }
    }
    for (let i = 0; i < 4; i++) out[i] = clamp8((1 - ink[i] - d[i]) * 255);
  };
}

/** Channel mixer of a CMYK document: each ink a weighted sum of the four inks plus a constant (percent). */
function mixerInk(rows: readonly (readonly number[])[]): InkFn {
  return (c, m, y, k, out) => {
    const ink = [255 - c, 255 - m, 255 - y, 255 - k];
    for (let i = 0; i < 4; i++) {
      const w = rows[i];
      out[i] = 255 - clamp8((w[0] * ink[0] + w[1] * ink[1] + w[2] * ink[2] + w[3] * ink[3] + w[4] * 255) / 100);
    }
  };
}

const inkCache = new WeakMap<Adjustment, InkFn | null>();
/** Memoized ink function of an adjustment in a CMYK document; null = no change. */
export function inkFnOf(a: Adjustment): InkFn | null {
  if (!inkCache.has(a)) inkCache.set(a, inkFn(a));
  return inkCache.get(a)!;
}
