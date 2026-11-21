// Layer effects — the pixel side, shared by every renderer: the screen (render/effects.ts reads the canvas back and
// runs this), the pixel compositor (softComposite: PSD merged image, render tests) and the exporters that place
// effects as pictures (PDF, DOCX). One implementation, so the screen, the PSD composite and a PDF shadow agree.
//
// Photoshop's model (public "Layer Style" documentation), reproduced within tolerance:
//   Size     — the blur's reach; the edge falls off as a Gaussian with σ = Size·SIZE_TO_SIGMA (core/style/effects.ts),
//   Spread / Choke — the part of Size that first grows (spread) the matte with a hard edge; the rest blurs,
//   Angle / Distance — the offset of shadows (light from `angle`, shadows move away from it),
//   Knockout — Photoshop draws the content over its shadow / glow and fades the two together with the layer's
//     opacity. The compositors draw the below surfaces and the content one after the other at that opacity, so
//     the outer effect's coverage is scaled by (1 − a) / (1 − op·a) (a = content alpha, op = layer opacity): the
//     result equals (content over effect) faded by op — no darker rim at anti-aliased edges (measured on
//     qa/interop/adobe-made/omni-fx-shadow-text: the plain (1 − a) knockout darkened every glyph edge),
//   inner effects are clipped to the layer's pixels and blended onto them; outer effects blend with what is below.
// Surfaces are premultiplied float RGBA (0..1), w×h, in device pixels; `k` = device pixels per page unit.

import { SIZE_TO_SIGMA, activeEffects, effectBlend, effectOpacity, isOuterEffect, shadowOffset } from "../style/effects";
import { anySeparableBlend, blendMix } from "../style/blend";
import { rgbaOf } from "../style/color";
import { toPx } from "../style/len";
import type { Color, Effect, Paint, StyleBlend } from "../style/types";

/**
 * Largest surface (px) effects are computed on: the screen (render/compose.ts), the pixel compositor and the PDF
 * pictures draw a bigger one without its effects (a 250 px blur at high zoom or a 30000 px shadow distance) instead
 * of allocating gigabytes; the PDF exporter says so.
 */
export const MAX_FX_PIXELS = 48_000_000;

export interface FxBelow {
  /** premultiplied RGBA, same size as the content surface */
  d: Float32Array;
  blend: StyleBlend;
  opacity: number;
}

export interface FxBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ───────── primitives ─────────

/** Separable Gaussian blur of a single-channel plane in place (σ in px). Outside the plane counts as `edge`. */
export function blurPlane(a: Float32Array, w: number, h: number, sigma: number, edge = 0): void {
  if (sigma < 0.2 || w <= 0 || h <= 0) return;
  if (sigma <= 3) {
    const r = Math.ceil(sigma * 3);
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= s;
    const line = new Float32Array(Math.max(w, h));
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const xx = x + i;
          acc += k[i + r] * (xx < 0 || xx >= w ? edge : a[o + xx]);
        }
        line[x] = acc;
      }
      a.set(line.subarray(0, w), o);
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const yy = y + i;
          acc += k[i + r] * (yy < 0 || yy >= h ? edge : a[yy * w + x]);
        }
        line[y] = acc;
      }
      for (let y = 0; y < h; y++) a[y * w + x] = line[y];
    }
    return;
  }
  // three "extended box" passes (Gwosdek, Grewenig, Bruhn, Weickert 2011): an integer box plus fractional end taps,
  // so the passes' variance is exactly σ² for every σ — plain integer boxes step the effective σ by up to ~15 %
  // between sizes (measured against Photoshop: qa/interop/adobe-made/omni-fx-*)
  const n = 3;
  const v = (sigma * sigma) / n;
  const l = Math.floor(0.5 * Math.sqrt(12 * v + 1) - 0.5);
  const alpha = ((2 * l + 1) * ((l * (l + 1)) / 3 - v)) / (2 * (v - (l + 1) * (l + 1)));
  const tmp = new Float32Array(a.length);
  for (let p = 0; p < n; p++) {
    boxH(a, tmp, w, h, l, alpha, edge);
    boxV(tmp, a, w, h, l, alpha, edge);
  }
}

/** Box of radius r plus end taps of weight `al` at ±(r+1), normalised; outside reads `edge`. */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, al: number, edge: number) {
  const inv = 1 / (2 * r + 1 + 2 * al);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const at = (x: number) => (x < 0 || x >= w ? edge : src[o + x]);
    let acc = edge * r;
    for (let x = 0; x <= r; x++) acc += x < w ? src[o + x] : edge;
    for (let x = 0; x < w; x++) {
      dst[o + x] = (acc + al * (at(x - r - 1) + at(x + r + 1))) * inv;
      const add = x + r + 1, sub = x - r;
      acc += (add < w ? src[o + add] : edge) - (sub >= 0 ? src[o + sub] : edge);
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, al: number, edge: number) {
  const inv = 1 / (2 * r + 1 + 2 * al);
  for (let x = 0; x < w; x++) {
    const at = (y: number) => (y < 0 || y >= h ? edge : src[y * w + x]);
    let acc = edge * r;
    for (let y = 0; y <= r; y++) acc += y < h ? src[y * w + x] : edge;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = (acc + al * (at(y - r - 1) + at(y + r + 1))) * inv;
      const add = y + r + 1, sub = y - r;
      acc += (add < h ? src[add * w + x] : edge) - (sub >= 0 ? src[sub * w + x] : edge);
    }
  }
}

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher 2012). */
function edt1(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Euclidean distance (px) from each pixel to the nearest pixel where `inSet` holds. */
function edt(inSet: Uint8Array, w: number, h: number, outsideIsSet: boolean): Float32Array {
  const INF = 1e20;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = inSet[i] ? 0 : INF;
  const n = Math.max(w, h) + 2;
  const f = new Float32Array(n), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1);
  // the border ring counts as outside: pad by one virtual pixel at each end when the outside is in the set
  const pad = outsideIsSet ? 1 : 0;
  for (let x = 0; x < w; x++) {
    const len = h + 2 * pad;
    if (pad) f[0] = f[len - 1] = 0;
    for (let y = 0; y < h; y++) f[y + pad] = g[y * w + x];
    edt1(f, len, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y + pad];
  }
  for (let y = 0; y < h; y++) {
    const len = w + 2 * pad;
    if (pad) f[0] = f[len - 1] = 0;
    for (let x = 0; x < w; x++) f[x + pad] = g[y * w + x];
    edt1(f, len, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x + pad]);
  }
  return g;
}

/**
 * Signed distance to the matte's edge in px (negative inside), sub-pixel along anti-aliased edges: a pixel of
 * coverage a lies at 0.5 − a from the edge. `outsideAlpha` = what lies beyond the plane (0 transparent, 1 solid).
 */
export function signedDistance(a: Float32Array, w: number, h: number, outsideAlpha = 0): Float32Array {
  const inside = new Uint8Array(w * h), outside = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) {
    if (a[i] >= 0.5) inside[i] = 1;
    else outside[i] = 1;
  }
  const dIn = edt(inside, w, h, outsideAlpha >= 0.5); // distance to the nearest inside pixel (for outside pixels)
  const dOut = edt(outside, w, h, outsideAlpha < 0.5); // distance to the nearest outside pixel (for inside pixels)
  const sd = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v > 0.001 && v < 0.999) sd[i] = 0.5 - v;
    else if (v >= 0.5) sd[i] = 0.5 - dOut[i];
    else sd[i] = dIn[i] - 0.5;
  }
  return sd;
}

/** The matte grown (r > 0) or shrunk (r < 0) by r px with an anti-aliased edge. */
export function offsetMatte(a: Float32Array, w: number, h: number, r: number, outsideAlpha = 0, sd?: Float32Array): Float32Array {
  if (Math.abs(r) < 1e-6) return a.slice();
  const s = sd ?? signedDistance(a, w, h, outsideAlpha);
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) {
    const v = 0.5 - s[i] + r;
    out[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
  return out;
}

/** Plane shifted by (dx, dy) px with bilinear sampling; beyond the plane reads `edge`. */
export function shiftPlane(a: Float32Array, w: number, h: number, dx: number, dy: number, edge = 0): Float32Array {
  if (!dx && !dy) return a;
  const out = new Float32Array(a.length);
  const ix = Math.floor(dx), iy = Math.floor(dy);
  const fx = dx - ix, fy = dy - iy;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? edge : a[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x - ix, sy = y - iy;
      // sample at (x − dx, y − dy)
      const v00 = at(sx, sy), v10 = at(sx - 1, sy), v01 = at(sx, sy - 1), v11 = at(sx - 1, sy - 1);
      out[y * w + x] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
    }
  return out;
}

/** Alpha plane of a premultiplied surface. */
export function alphaOf(d: Float32Array): Float32Array {
  const a = new Float32Array(d.length / 4);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
}

const rgb01 = (c: Color): [number, number, number, number] => {
  const v = rgbaOf(c);
  return [v.r / 255, v.g / 255, v.b / 255, v.a];
};

/** Colour of `paint` at pixel (x, y) of `box` (solid, linear / radial gradient; others: their representative). */
function paintSampler(p: Paint, box: FxBox): (x: number, y: number) => [number, number, number, number] {
  if (p.type === "solid") {
    const c = rgb01(p.color);
    return () => c;
  }
  if (p.type !== "gradient" || !p.stops.length) {
    const c: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
    return () => c;
  }
  const stops = [...p.stops].sort((a, b) => a.at - b.at).map((s) => ({ at: s.at, c: rgb01(s.color) }));
  const fx0 = box.x + p.from[0] * box.w, fy0 = box.y + p.from[1] * box.h;
  const fx1 = box.x + p.to[0] * box.w, fy1 = box.y + p.to[1] * box.h;
  const vx = fx1 - fx0, vy = fy1 - fy0, L2 = vx * vx + vy * vy || 1, R = Math.sqrt(L2);
  return (x, y) => {
    let t = p.kind === "radial" ? Math.hypot(x - fx0, y - fy0) / R : ((x - fx0) * vx + (y - fy0) * vy) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (t <= stops[0].at) return stops[0].c;
    for (let i = 1; i < stops.length; i++)
      if (t <= stops[i].at) {
        const a = stops[i - 1], b = stops[i], u = (t - a.at) / (b.at - a.at || 1);
        return [a.c[0] + (b.c[0] - a.c[0]) * u, a.c[1] + (b.c[1] - a.c[1]) * u, a.c[2] + (b.c[2] - a.c[2]) * u, a.c[3] + (b.c[3] - a.c[3]) * u];
      }
    return stops[stops.length - 1].c;
  };
}

/**
 * Colour `col` with coverage `m` (0..1 per pixel, times `op`) onto the content, clipped to the content (atop):
 * the content's alpha stays, its colour is blended (Photoshop blends interior effects against the layer as if it
 * were opaque — the layer's alpha only masks the result, like a clipped layer).
 */
function paintAtop(d: Float32Array, m: Float32Array, sample: (x: number, y: number) => [number, number, number, number], op: number, blend: StyleBlend, w: number, shape?: Float32Array) {
  const B = blend === "NORMAL" ? null : anySeparableBlend(blend);
  for (let i = 0; i < m.length; i++) {
    const o = i * 4;
    const da = d[o + 3];
    // `shape`: the layer's shape before its fill faded the pixels — the effect covers the shape, not the faded pixels
    const S = shape ? Math.max(da, shape[i]) : da;
    if (S <= 0) continue;
    const c = sample(i % w, (i / w) | 0);
    const sa = m[i] * op * c[3];
    if (sa <= 0) continue;
    for (let ch = 0; ch < 3; ch++) {
      const cs = c[ch];
      const mixed = B && da > 0 ? blendMix(B, d[o + ch] / da, cs, da, true) : cs;
      d[o + ch] = sa * S * mixed + d[o + ch] * (1 - sa);
    }
    d[o + 3] = sa * S + da * (1 - sa);
  }
}

/** Colour with coverage `m` drawn under the content (destination-over). */
function paintUnder(d: Float32Array, m: Float32Array, sample: (x: number, y: number) => [number, number, number, number], op: number, w: number, shape?: Float32Array) {
  for (let i = 0; i < m.length; i++) {
    const c = sample(i % w, (i / w) | 0);
    const sa = m[i] * op * c[3];
    if (sa <= 0) continue;
    const o = i * 4;
    // (an outer stroke stays outside the shape when the fill faded the pixels)
    const k = 1 - (shape ? Math.max(d[o + 3], shape[i]) : d[o + 3]);
    if (k <= 0) continue;
    d[o] += c[0] * sa * k;
    d[o + 1] += c[1] * sa * k;
    d[o + 2] += c[2] * sa * k;
    d[o + 3] += sa * k;
  }
}

/** A below-layer surface: `col` with coverage `m`. */
function belowSurface(m: Float32Array, c: [number, number, number, number]): Float32Array {
  const d = new Float32Array(m.length * 4);
  for (let i = 0; i < m.length; i++) {
    const a = m[i] * c[3];
    if (a <= 0) continue;
    d[i * 4] = c[0] * a;
    d[i * 4 + 1] = c[1] * a;
    d[i * 4 + 2] = c[2] * a;
    d[i * 4 + 3] = a;
  }
  return d;
}

/** Spread / choke then blur, the shared matte step of shadows and glows. */
function spreadBlur(src: Float32Array, w: number, h: number, sizePx: number, spread: number, outside: number): Float32Array {
  const sp = Math.max(0, Math.min(1, spread));
  let m = sp > 0 ? offsetMatte(src, w, h, sizePx * sp, outside) : src.slice();
  blurPlane(m, w, h, sizePx * (1 - sp) * SIZE_TO_SIGMA, outside);
  for (let i = 0; i < m.length; i++) m[i] = m[i] < 0 ? 0 : m[i] > 1 ? 1 : m[i];
  return m;
}

// ───────── the effect stack ─────────

/**
 * Apply `effects` to a layer surface. The content (`d`, premultiplied) gets its interior effects and the stroke in
 * place; the effects drawn under the layer (drop shadow, outer glow) come back as separate surfaces, each to be
 * blended onto what is below with its own blend mode and opacity (times the layer's opacity) before the content.
 * `box` = the object's box in surface pixels (gradient overlays span it; default: the pixels' bounds).
 * `fill` (Photoshop Fill, core/style/blend.ts fxFill): fades the pixels before the interior effects and the stroke are
 * drawn over the layer's shape — they keep their strength, and the shape still knocks out the drop shadow.
 */
export function applyEffects(d: Float32Array, w: number, h: number, effects: readonly Effect[] | undefined, k: number, box?: FxBox | null, layerOpacity = 1, fill = 1): FxBelow[] {
  const fx = activeEffects(effects);
  if (!fx.length || w <= 0 || h <= 0) return [];
  const A0 = alphaOf(d);
  const shape = fill < 1 ? A0 : undefined;
  if (shape) for (let i = 0; i < d.length; i++) d[i] *= Math.max(0, fill);
  const bx = box ?? alphaBox(A0, w, h);
  let sd0: Float32Array | null = null;
  const sdOf = () => (sd0 ??= signedDistance(A0, w, h));
  const below: FxBelow[] = [];
  // interior effects and the stroke, bottom → top, on the content; outer effects afterwards from the final shape
  // (in Photoshop the stroke casts the shadow too)
  for (const e of fx) {
    if (isOuterEffect(e)) continue;
    const op = effectOpacity(e);
    switch (e.type) {
      case "overlay":
        paintAtop(d, A0.map(() => 1), paintSampler(e.paint, bx), op, effectBlend(e), w, shape);
        break;
      case "innerGlow": {
        const S = toPx(e.size) * k;
        const inv = A0.map((a) => 1 - a);
        let m = spreadBlur(inv, w, h, S, e.spread, 1);
        if (e.source === "center") m = m.map((v) => 1 - v);
        paintAtop(d, m, paintSampler(e.paint, bx), op, effectBlend(e), w, shape);
        break;
      }
      case "innerShadow": {
        const S = toPx(e.size) * k;
        const [dx, dy] = shadowOffset(e.angle, toPx(e.distance) * k);
        // the shadow moves in from beyond the surface: blur on a plane padded by the offset, so what slides in is
        // the blurred falloff, not a solid edge (content touching its layer bounds — every PSD layer — got a hard,
        // full-strength band there: omni-fx-inner-image max 58 → see tests)
        const P = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) + 1;
        const pw = w + 2 * P, ph = h + 2 * P;
        const inv = new Float32Array(pw * ph).fill(1);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) inv[(y + P) * pw + x + P] = 1 - A0[y * w + x];
        const mp = shiftPlane(spreadBlur(inv, pw, ph, S, e.spread, 1), pw, ph, dx, dy, 1);
        const m = new Float32Array(w * h);
        for (let y = 0; y < h; y++) m.set(mp.subarray((y + P) * pw + P, (y + P) * pw + P + w), y * w);
        const c = rgb01(e.color);
        paintAtop(d, m, () => c, op, effectBlend(e), w, shape);
        break;
      }
      case "fxStroke": {
        const W = toPx(e.stroke.width) * k;
        if (W <= 0) break;
        const sample = paintSampler(e.stroke.paint, bx);
        const align = e.stroke.align ?? "outside";
        const sd = sdOf();
        const grow = align === "outside" ? W : align === "center" ? W / 2 : 0;
        const shrink = align === "inside" ? W : align === "center" ? W / 2 : 0;
        if (shrink > 0) {
          // the inner band: the shape minus the shape shrunk by `shrink`, on top of the content
          const inner = offsetMatte(A0, w, h, -shrink, 0, sd).map((v) => 1 - v);
          paintAtop(d, inner, sample, op, "NORMAL", w, shape);
        }
        if (grow > 0) paintUnder(d, offsetMatte(A0, w, h, grow, 0, sd), sample, op, w, shape);
        break;
      }
      case "softEdge": {
        const R = toPx(e.radius) * k;
        if (R <= 0) break;
        const m = offsetMatte(A0, w, h, -R / 2, 0, sdOf());
        blurPlane(m, w, h, (R / 2) * SIZE_TO_SIGMA);
        for (let i = 0; i < m.length; i++) {
          const f = Math.min(1, Math.max(0, m[i]));
          const o = i * 4;
          d[o] *= f;
          d[o + 1] *= f;
          d[o + 2] *= f;
          d[o + 3] *= f;
        }
        break;
      }
    }
  }
  let A = fx.some((e) => !isOuterEffect(e) && (e.type === "fxStroke" || e.type === "softEdge")) ? alphaOf(d) : A0;
  // a faded fill: the shape still knocks out what is drawn under it
  if (shape && A !== A0) A = A.map((a, i) => Math.max(a, A0[i]));
  // (the content is drawn at the opacity × its fill: what it lets through of the knocked-out shadow follows that)
  const lop = Math.max(0, Math.min(1, layerOpacity)) * Math.max(0, Math.min(1, fill));
  // the part of an outer effect left visible under the content (see Knockout above)
  const knock = (m: Float32Array) => {
    for (let i = 0; i < m.length; i++) {
      const a = A[i];
      if (a <= 0) continue;
      m[i] *= a >= 1 ? 0 : (1 - a) / (1 - lop * a);
    }
  };
  for (const e of fx) {
    if (!isOuterEffect(e)) continue;
    const op = effectOpacity(e);
    if (e.type === "dropShadow") {
      const S = toPx(e.size) * k;
      const [dx, dy] = shadowOffset(e.angle, toPx(e.distance) * k);
      const m = shiftPlane(spreadBlur(A, w, h, S, e.spread, 0), w, h, dx, dy, 0);
      // knockout: the shadow does not show through the layer's pixels
      knock(m);
      below.push({ d: belowSurface(m, rgb01(e.color)), blend: effectBlend(e), opacity: op });
    } else if (e.type === "outerGlow") {
      const S = toPx(e.size) * k;
      const m = spreadBlur(A, w, h, S, e.spread, 0);
      knock(m);
      const sample = paintSampler(e.paint, bx);
      below.push({ d: belowSurface(m, sample(bx.x, bx.y)), blend: effectBlend(e), opacity: op });
    }
  }
  return below;
}

/** Bounds of the non-transparent pixels (the whole plane when empty). */
function alphaBox(a: Float32Array, w: number, h: number): FxBox {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (a[y * w + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ───────── 8-bit helpers (canvas ImageData, PNG, PSD layer pixels) ─────────

/** Straight RGBA8 → premultiplied float. */
export function premultiply(rgba: Uint8Array | Uint8ClampedArray): Float32Array {
  const d = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    if (a <= 0) continue;
    d[i] = (rgba[i] / 255) * a;
    d[i + 1] = (rgba[i + 1] / 255) * a;
    d[i + 2] = (rgba[i + 2] / 255) * a;
    d[i + 3] = a;
  }
  return d;
}

/** Premultiplied float → straight RGBA8 (into `out` when given). */
export function unpremultiply(d: Float32Array, out?: Uint8ClampedArray): Uint8ClampedArray {
  const o = out ?? new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a <= 0) {
      o[i] = o[i + 1] = o[i + 2] = o[i + 3] = 0;
      continue;
    }
    o[i] = Math.round((d[i] / a) * 255);
    o[i + 1] = Math.round((d[i + 1] / a) * 255);
    o[i + 2] = Math.round((d[i + 2] / a) * 255);
    o[i + 3] = Math.round(a * 255);
  }
  return o;
}

/** Straight RGBA8 pixels padded by `m` transparent pixels on every side. */
export function padRgba(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, m: number): { rgba: Uint8ClampedArray; w: number; h: number } {
  const W = w + 2 * m, H = h + 2 * m;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) out.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), ((y + m) * W + m) * 4);
  return { rgba: out, w: W, h: H };
}

/** Source-over of premultiplied `src` onto `dst` (same size) at opacity `op` with a blend mode (W3C over). */
export function compositeOver(dst: Float32Array, src: Float32Array, op: number, blend: StyleBlend) {
  const B = blend === "NORMAL" ? null : anySeparableBlend(blend);
  for (let o = 0; o < dst.length; o += 4) {
    const sa = src[o + 3] * op;
    if (sa <= 0) continue;
    const da = dst[o + 3];
    for (let c = 0; c < 3; c++) {
      const cs = src[o + c] / src[o + 3];
      const mixed = B && da > 0 ? blendMix(B, dst[o + c] / da, cs, da, false) : cs;
      dst[o + c] = sa * mixed + dst[o + c] * (1 - sa);
    }
    dst[o + 3] = sa + da * (1 - sa);
  }
}

/**
 * The whole styled layer flattened onto transparency (below effects, then the content): what a format without live
 * effects stores as a picture. Straight RGBA8 in, straight RGBA8 out, padded by `m` px (choose m ≥ the margins).
 */
export function flattenEffects(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, effects: readonly Effect[] | undefined, k: number, m: number, box?: FxBox | null): { rgba: Uint8ClampedArray; w: number; h: number } {
  const p = padRgba(rgba, w, h, m);
  const d = premultiply(p.rgba);
  const below = applyEffects(d, p.w, p.h, effects, k, box ? { ...box, x: box.x + m, y: box.y + m } : null);
  const out = new Float32Array(d.length);
  for (const b of below) compositeOver(out, b.d, b.opacity, "NORMAL");
  compositeOver(out, d, 1, "NORMAL");
  return { rgba: unpremultiply(out), w: p.w, h: p.h };
}

/** Only the parts drawn below / above the content (for formats that keep the content itself live: PDF text). */
export function effectLayers(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number, effects: readonly Effect[] | undefined, k: number, m: number, layerOpacity = 1): { below: Uint8ClampedArray | null; belowBlend: StyleBlend; above: Uint8ClampedArray | null; w: number; h: number } {
  const p = padRgba(rgba, w, h, m);
  const orig = premultiply(p.rgba);
  const d = orig.slice();
  const bl = applyEffects(d, p.w, p.h, effects, k, null, layerOpacity);
  let below: Uint8ClampedArray | null = null;
  // one picture for everything below: it keeps the blend mode when all of them share one (a multiply shadow)
  const belowBlend: StyleBlend = bl.length && bl.every((b) => b.blend === bl[0].blend) ? bl[0].blend : "NORMAL";
  if (bl.length) {
    const acc = new Float32Array(d.length);
    for (const b of bl) compositeOver(acc, b.d, b.opacity, "NORMAL");
    below = unpremultiply(acc);
  }
  // above: where the styled content differs from the original content, the styled pixels (drawn over the live
  // content they cover exactly; the outside part of a stroke is outside the content anyway)
  // pixels the effects left as they were are cleared: the live content already draws them (drawing them twice
  // would thicken anti-aliased text edges and, at layer opacity < 1, make the content more opaque)
  let changed = false;
  for (let o = 0; o < d.length; o += 4) {
    if (Math.abs(d[o] - orig[o]) <= 1 / 512 && Math.abs(d[o + 1] - orig[o + 1]) <= 1 / 512 && Math.abs(d[o + 2] - orig[o + 2]) <= 1 / 512 && Math.abs(d[o + 3] - orig[o + 3]) <= 1 / 512) {
      d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
    } else changed = true;
  }
  return { below, belowBlend, above: changed ? unpremultiply(d) : null, w: p.w, h: p.h };
}
