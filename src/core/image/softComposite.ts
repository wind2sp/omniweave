// Pixel compositor without a canvas: the layer tree (groups, clipping masks) composited in premultiplied float,
// band by band. Used for the PSD merged image and as the reference in render tests; the screen renderer walks
// the same tree (core/layerTree.ts) with Canvas2D surfaces, so both follow one set of rules.
// Blending: W3C Compositing and Blending Level 1 (all 27 Photoshop modes as whole-pixel blends, core/style/blend.ts),
// source-over / source-atop; DISSOLVE dithers alpha by page position. Adjustment layers (RasterNode.adjust) recolour
// what is below them through core/image/adjustLayer.ts.

import { buildTree, composeItems, type Compositor, type LeafMode } from "../layerTree";
import type { BlendMode, LayerGroup, SceneNode } from "../types";
import { anySeparableBlend, blendIfWeight, dissolveKeep, fillParts, fxFill, pixelBlend, separableBlend, type PixelBlend, type SeparableBlend } from "../style/blend";
import { activeEffects, effectMargins, innerReach, maxMargin } from "../style/effects";
import type { Effect, StyleBlend } from "../style/types";
import { MAX_FX_PIXELS, applyEffects, premultiply } from "./effects";
import { adjustFnOf, inkFnOf } from "./adjustLayer";
import { linearToSrgb as encodeSrgb, srgbToLinear } from "./adjust";

/** Linear light → sRGB-encoded, clipped to 0 … 1 (Photoshop's 8-bit view of a 32-bit document: exposure 0, gamma 1). */
const linearToSrgb = (v: number) => (!(v > 0) ? 0 : v >= 1 ? 1 : encodeSrgb(v));

/** Straight-alpha RGBA8 pixels placed on the page. */
export interface PlacedPixels {
  rgba: Uint8Array | Uint8ClampedArray;
  /**
   * linear-light colour (R, G, B per pixel, may pass 1) for a page composited in linear light: a 32-bit layer's own
   * floats where they hold light past white (cmykComposite.ts linearStore); absent = decoded from `rgba`
   */
  lin?: Float32Array;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Separable blend of a mode; null = NORMAL (source colour unchanged). Formulas: core/style/blend.ts. */
export function blendFn(mode: BlendMode | StyleBlend): SeparableBlend | null {
  return separableBlend(mode) ?? (mode === "NORMAL" ? null : anySeparableBlend(mode as StyleBlend));
}

/** A layer with its effects applied: premultiplied content and the surfaces drawn below it, all the same box. */
interface Styled {
  left: number;
  top: number;
  width: number;
  height: number;
  content: Float32Array;
  below: { d: Float32Array; blend: StyleBlend; opacity: number }[];
}

/**
 * Effects applied to a node's pixels (page px, k = 1), padded by the effects' reach; null beyond MAX_FX_PIXELS.
 * `fx`: the node's effects as drawn (a CMYK plane's colours — `InkPlanes`).
 */
export function styledPixels(n: SceneNode, px: PlacedPixels, fx: readonly Effect[] | undefined = n.effects): Styled | null {
  const m = Math.ceil(maxMargin(effectMargins(fx))) + 1;
  const W = px.width + 2 * m, H = px.height + 2 * m;
  if (W * H > MAX_FX_PIXELS) return null;
  const content = new Float32Array(W * H * 4);
  const pre = premultiply(px.rgba);
  for (let y = 0; y < px.height; y++) content.set(pre.subarray(y * px.width * 4, (y + 1) * px.width * 4), ((y + m) * W + m) * 4);
  const below = applyEffects(content, W, H, fx, 1, null, n.opacity, fxFill(n)[0]);
  return { left: px.left - m, top: px.top - m, width: W, height: H, content, below };
}

/**
 * A CMYK document composited on its stored channels (core/image/cmykComposite.ts): `pixels` gives a node's (C, M, Y)
 * as RGB, `k` its black as a grey (same alpha) — two planes composited side by side, so an adjustment layer sees
 * all four channels of what is below it.
 */
export interface InkPlanes {
  /** a node's black plane: (K, K, K) and the alpha of its (C, M, Y) pixels; null = nothing to draw */
  k(n: SceneNode): PlacedPixels | null;
  /** effects as drawn on plane 0 (C, M, Y) or 1 (K): their colours in that plane's stored values */
  fx(effects: readonly Effect[] | undefined, plane: 0 | 1): readonly Effect[] | undefined;
}

interface Band {
  /** premultiplied RGBA, w×h */
  d: Float32Array;
  /** a CMYK document's black plane, as `d` (InkPlanes) */
  k?: Float32Array;
  y0: number;
  w: number;
  h: number;
}

/**
 * Source pixel (premultiplied sc, alpha sa — already scaled by opacity) onto dst at index o.
 * atop keeps the destination alpha (clipping); over is source-over. Both apply `B` (null = normal).
 */
const mixOut = new Float64Array(3);
function put(d: Float32Array, o: number, sr: number, sg: number, sb: number, sa: number, B: PixelBlend | null, atop: boolean) {
  const da = d[o + 3];
  if (atop && da <= 0) return;
  const fa = atop ? da : 1;
  if (!B || da <= 0) {
    // normal: cs' = cs
    d[o] = sr * fa + d[o] * (1 - sa);
    d[o + 1] = sg * fa + d[o + 1] * (1 - sa);
    d[o + 2] = sb * fa + d[o + 2] * (1 - sa);
  } else {
    const inv = 1 / sa, ib = 1 / da;
    const cr = sr * inv, cg = sg * inv, cbl = sb * inv;
    B(d[o] * ib, d[o + 1] * ib, d[o + 2] * ib, cr, cg, cbl, mixOut);
    // over: W3C — where the backdrop is partly transparent the source shows unblended in proportion.
    // atop (a clipped layer): Photoshop blends against the clip base's colour as if the base were opaque —
    // the base's alpha only masks the result (measured on Photoshop-made files: qa/interop/adobe-made/psd_clip_*)
    const k = atop ? 0 : 1 - da, j = atop ? 1 : da;
    d[o] = sa * fa * (k * cr + j * mixOut[0]) + d[o] * (1 - sa);
    d[o + 1] = sa * fa * (k * cg + j * mixOut[1]) + d[o + 1] * (1 - sa);
    d[o + 2] = sa * fa * (k * cbl + j * mixOut[2]) + d[o + 2] * (1 - sa);
  }
  d[o + 3] = atop ? da : sa + da * (1 - sa);
}

const ADD: PixelBlend = (br, bg, bb, sr, sg, sb, out) => ((out[0] = br + sr), (out[1] = bg + sg), (out[2] = bb + sb));
const PICK_SOURCE: PixelBlend = (_br, _bg, _bb, sr, sg, sb, out) => ((out[0] = sr), (out[1] = sg), (out[2] = sb));
const PICK_BACKDROP: PixelBlend = (br, bg, bb, _sr, _sg, _sb, out) => ((out[0] = br), (out[1] = bg), (out[2] = bb));

/**
 * Composite a page's layers (with groups and clipping) into straight RGBA8, W×H. `pixels` gives each node's
 * pixels (null = nothing to draw). Works in bands of rows, so memory stays bounded for big canvases.
 * `linear`: blend in linear light — a 32-bit PSD, which Photoshop composites on its linear floats (multiply, opacity,
 * soft edges all differ from blending the sRGB values): the sRGB pixels are decoded before and encoded after.
 */
export function compositeTree(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined, pixels: (n: SceneNode) => PlacedPixels | null, W: number, H: number, bandRows?: number, linear = false): Uint8Array {
  return composite(nodes, groups, pixels, null, W, H, bandRows, linear)[0];
}

/** sRGB byte → linear light (IEC 61966-2-1). */
const LIN = new Float32Array(256).map((_, i) => srgbToLinear(i / 255));
/** A premultiplied sRGB float surface → premultiplied linear light, in place. */
function toLinear(d: Float32Array) {
  for (let o = 0; o < d.length; o += 4) {
    const a = d[o + 3];
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) d[o + c] = srgbToLinear(Math.max(0, Math.min(1, d[o + c] / a))) * a;
  }
}

/**
 * A CMYK document's layers composited on its stored channels: [(C, M, Y) as RGBA, (K, K, K) as RGBA], straight,
 * W×H each. Blends and effects work per channel as `compositeTree`'s do; adjustment layers see all four channels.
 */
export function compositeInks(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined, pixels: (n: SceneNode) => PlacedPixels | null, ink: InkPlanes, W: number, H: number, bandRows?: number): [Uint8Array, Uint8Array] {
  const [cmy, k] = composite(nodes, groups, pixels, ink, W, H, bandRows);
  return [cmy, k];
}

function composite(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined, pixels: (n: SceneNode) => PlacedPixels | null, ink: InkPlanes | null, W: number, H: number, bandRows?: number, linear = false): Uint8Array[] {
  // linear light (32-bit): values past 1 stay as Photoshop keeps its floats — linear dodge adds without a ceiling
  const blendOf = (mode: StyleBlend | string): PixelBlend | null => (linear && mode === "LINEAR_DODGE" ? ADD : pixelBlend(mode));
  const outs = ink ? [new Uint8Array(W * H * 4), new Uint8Array(W * H * 4)] : [new Uint8Array(W * H * 4)];
  const tree = buildTree(nodes, groups);
  const BAND = Math.max(1, Math.min(H, bandRows ?? Math.floor(2_000_000 / Math.max(1, W))));
  const pool: Float32Array[] = [];
  // group effects need rows above / below the band (a group's shadow comes from members outside it): bands
  // overlap by the largest group effect reach, only their own rows are kept
  let M = 0;
  // (interior effects too: an inner shadow / glow would otherwise appear along every band edge)
  for (const g of groups ?? []) M = Math.max(M, Math.ceil(maxMargin(effectMargins(g.effects))), Math.ceil(innerReach(g.effects)));
  // a node's effects are computed once over the whole layer (not per band) — per plane
  const styledCache = [new Map<SceneNode, Styled | null>(), new Map<SceneNode, Styled | null>()];
  const styledOf = (n: SceneNode, px: PlacedPixels, plane: 0 | 1 = 0) => {
    const c = styledCache[plane];
    if (!c.has(n)) {
      const st = ink ? styledPixels(n, px, ink.fx(n.effects, plane)) : styledPixels(n, px);
      if (st && linear) {
        toLinear(st.content);
        for (const b of st.below) toLinear(b.d);
      }
      c.set(n, st);
    }
    return c.get(n)!;
  };
  const kCache = new Map<SceneNode, PlacedPixels | null>();
  const kOf = (n: SceneNode) => {
    if (!kCache.has(n)) kCache.set(n, ink!.k(n));
    return kCache.get(n)!;
  };
  for (let by = 0; by < H; by += BAND) {
    const by0 = Math.max(0, by - M);
    const bh = Math.min(H, by + BAND + M) - by0;
    const size = W * bh * 4;
    const take = () => {
      const a = pool.pop();
      if (a && a.length === size) return a.fill(0);
      return new Float32Array(size);
    };
    const band0 = (): Band => (ink ? { d: take(), k: take(), y0: by0, w: W, h: bh } : { d: take(), y0: by0, w: W, h: bh });
    const C: Compositor<Band> = {
      alpha: (n) => n.opacity,
      alloc: band0,
      copy: (s) => {
        const b = band0();
        b.d.set(s.d);
        if (b.k) b.k.set(s.k!);
        return b;
      },
      free: (s) => {
        pool.push(s.d);
        if (s.k) pool.push(s.k);
      },
      blit: (dst, src, op, blend) => {
        blitPlane(dst.d, src.d, dst.y0, op, blend);
        if (dst.k) blitPlane(dst.k, src.k!, dst.y0, op, blend);
      },
      leaf: (dst, n, how: LeafMode) => {
        if (n.type === "RASTER" && n.adjust) {
          if (how !== "bare") {
            if (ink) adjustInk(dst, n, pixels(n));
            else adjustBand(dst, n, pixels(n));
          }
          return;
        }
        const px = pixels(n);
        if (!px) return;
        if (dst.k && how !== "bare" && (n.blendMode === "DARKER_COLOR" || n.blendMode === "LIGHTER_COLOR") && !activeEffects(n.effects).length) {
          const pk = kOf(n);
          if (pk) return leafPick(dst, n, how === "atop", px, pk, n.blendMode === "DARKER_COLOR");
        }
        leafPlane(dst.d, dst.y0, dst.h, n, how, px, 0);
        if (dst.k) {
          const pk = kOf(n);
          if (pk) leafPlane(dst.k, dst.y0, dst.h, n, how, pk, 1);
        }
      },
      under: (dst, n, op) => {
        const px = pixels(n);
        if (!px || !activeEffects(n.effects).length) return;
        underPlane(dst.d, dst.y0, dst.h, styledOf(n, px), op);
        if (dst.k) {
          const pk = kOf(n);
          if (pk) underPlane(dst.k, dst.y0, dst.h, styledOf(n, pk, 1), op);
        }
      },
      knock: (dst, n, op) => {
        const px = n.type === "RASTER" && !n.adjust ? pixels(n) : null;
        if (!px || op <= 0) return;
        const planes = dst.k ? [dst.d, dst.k] : [dst.d];
        const x0 = Math.max(0, px.left), x1 = Math.min(W, px.left + px.width);
        const y0 = Math.max(dst.y0, px.top), y1 = Math.min(dst.y0 + dst.h, px.top + px.height);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const k = 1 - (px.rgba[((y - px.top) * px.width + (x - px.left)) * 4 + 3] / 255) * op;
            if (k >= 1) continue;
            const o = ((y - dst.y0) * W + x) * 4;
            for (const p of planes) for (let c = 0; c < 4; c++) p[o + c] *= k;
          }
      },
      allocFx: band0,
      applyFx: (s, fx, op) => {
        const below = applyEffects(s.d, W, s.h, ink ? ink.fx(fx, 0) : fx, 1, null, op);
        // (a group's effects are drawn from its sRGB colours: approximate on a linear page)
        if (linear) for (const b of below) toLinear(b.d);
        if (!ink) return below.map((b) => ({ s: { d: b.d, y0: s.y0, w: W, h: s.h }, blend: b.blend, opacity: b.opacity }));
        const bk = applyEffects(s.k!, W, s.h, ink.fx(fx, 1), 1, null, op);
        return below.map((b, i) => ({ s: { d: b.d, k: bk[i]?.d ?? new Float32Array(b.d.length), y0: s.y0, w: W, h: s.h }, blend: b.blend, opacity: b.opacity }));
      },
    };
    const band = band0();
    composeItems(tree, band, C);
    const keep = Math.min(BAND, H - by);
    const planes = band.k ? [band.d, band.k] : [band.d];
    for (let p = 0; p < planes.length; p++) {
      const d = planes[p].subarray((by - by0) * W * 4, (by - by0 + keep) * W * 4);
      const out = outs[p];
      const base = by * W * 4;
      for (let i = 0, n = W * keep; i < n; i++) {
        const a = d[i * 4 + 3];
        if (a <= 0) continue;
        const o = base + i * 4;
        if (linear) for (let c = 0; c < 3; c++) out[o + c] = Math.round(linearToSrgb(d[i * 4 + c] / a) * 255);
        else for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round((d[i * 4 + c] / a) * 255)));
        out[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
      }
      pool.push(planes[p]);
    }
  }
  return outs;

  /** One plane of a surface onto the same plane of another (see Compositor.blit). */
  function blitPlane(d: Float32Array, s: Float32Array, y0: number, op: number, blend: Parameters<Compositor<Band>["blit"]>[3]) {
    if (blend === "lerp") {
      for (let i = 0; i < d.length; i++) d[i] = d[i] * (1 - op) + s[i] * op;
      return;
    }
    const B = blendOf(blend);
    const dis = blend === "DISSOLVE";
    for (let o = 0; o < d.length; o += 4) {
      let sa = s[o + 3] * op;
      if (sa <= 0) continue;
      let m = op;
      if (dis) {
        const i = o >> 2;
        if (!dissolveKeep(i % W, y0 + Math.floor(i / W), sa)) continue;
        m = op / sa;
        sa = 1;
      }
      put(d, o, s[o] * m, s[o + 1] * m, s[o + 2] * m, sa, B, false);
    }
  }

  /** A node's pixels (and its effects) onto one plane of a band (band rows y0 … y0 + h). */
  function leafPlane(d: Float32Array, by0: number, bh: number, n: SceneNode, how: LeafMode, px: PlacedPixels, plane: 0 | 1) {
    const op = how === "bare" ? 1 : n.opacity;
    // fill: the pixels' share (the effects keep the opacity alone), or inside the blend (blend.ts fillParts)
    const fp = how === "bare" ? null : fillParts(n);
    const B = how === "bare" ? null : blendOf(fp!.blend);
    const dis = how !== "bare" && n.blendMode === "DISSOLVE";
    const atop = how === "atop";
    const st = activeEffects(n.effects).length ? styledOf(n, px, plane) : null;
    if (st) {
      if (how !== "bare") for (const b of st.below) paintFloat(d, by0, bh, st, b.d, op * b.opacity, blendOf(b.blend), atop);
      paintFloat(d, by0, bh, st, st.content, op * (how === "bare" ? 1 : fxFill(n)[1]), B, atop, dis, how === "bare" ? undefined : n.blendIf);
      return;
    }
    const cop = op * (fp?.content ?? 1);
    const bif = how === "bare" ? undefined : n.blendIf;
    const rgba = px.rgba;
    const x0 = Math.max(0, px.left), x1 = Math.min(W, px.left + px.width);
    const y0 = Math.max(by0, px.top), y1 = Math.min(by0 + bh, px.top + px.height);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const s = ((y - px.top) * px.width + (x - px.left)) * 4;
        let a = (rgba[s + 3] / 255) * cop;
        if (a <= 0) continue;
        if (bif) {
          // Blend If: by the layer's colour and the colour below (as shown: sRGB on a linear page)
          const o = ((y - by0) * W + x) * 4, da = d[o + 3];
          const bc = (c: number) => (da > 0 ? (linear ? linearToSrgb(d[o + c] / da) : d[o + c] / da) * 255 : 0);
          a *= blendIfWeight(bif, rgba[s], rgba[s + 1], rgba[s + 2], bc(0), bc(1), bc(2));
          if (a <= 0) continue;
        }
        if (dis) {
          if (!dissolveKeep(x, y, a)) continue;
          a = 1;
        }
        if (px.lin && linear) {
          const l = (s >> 2) * 3;
          put(d, ((y - by0) * W + x) * 4, px.lin[l] * a, px.lin[l + 1] * a, px.lin[l + 2] * a, a, B, atop);
        } else if (linear) put(d, ((y - by0) * W + x) * 4, LIN[rgba[s]] * a, LIN[rgba[s + 1]] * a, LIN[rgba[s + 2]] * a, a, B, atop);
        else put(d, ((y - by0) * W + x) * 4, (rgba[s] / 255) * a, (rgba[s + 1] / 255) * a, (rgba[s + 2] / 255) * a, a, B, atop);
      }
  }

  /**
   * Darker / lighter colour on a CMYK document: whole colours compared, all four channels — the luminosity of the
   * colour as RGB (stored value × black, as adjustLayer.ts) — and the chosen one taken on both planes.
   */
  function leafPick(dst: Band, n: SceneNode, atop: boolean, px: PlacedPixels, pk: PlacedPixels, darker: boolean) {
    const d = dst.d, kd = dst.k!, op = n.opacity;
    const x0 = Math.max(0, px.left), x1 = Math.min(W, px.left + px.width);
    const y0 = Math.max(dst.y0, px.top), y1 = Math.min(dst.y0 + dst.h, px.top + px.height);
    const lum = (c: number, m: number, y: number, k: number) => (0.3 * c + 0.59 * m + 0.11 * y) * k;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const s = ((y - px.top) * px.width + (x - px.left)) * 4;
        const a = (px.rgba[s + 3] / 255) * op;
        if (a <= 0) continue;
        const o = ((y - dst.y0) * W + x) * 4;
        const sc = px.rgba[s] / 255, sm = px.rgba[s + 1] / 255, sy = px.rgba[s + 2] / 255, sk = pk.rgba[s] / 255;
        let B: PixelBlend = PICK_SOURCE;
        const da = d[o + 3], ka = kd[o + 3];
        if (da > 0 && ka > 0) {
          const ls = lum(sc, sm, sy, sk), lb = lum(d[o] / da, d[o + 1] / da, d[o + 2] / da, kd[o] / ka);
          if (darker ? !(ls < lb) : !(ls > lb)) B = PICK_BACKDROP;
        }
        put(d, o, sc * a, sm * a, sy * a, a, B, atop);
        put(kd, o, sk * a, sk * a, sk * a, a, B, atop);
      }
  }

  /** The outer effects of a clip-stack base onto one plane. */
  function underPlane(d: Float32Array, by0: number, bh: number, st: Styled | null, op: number) {
    if (!st) return;
    for (const b of st.below) paintFloat(d, by0, bh, st, b.d, op * b.opacity, blendOf(b.blend), false);
  }

  /**
   * An adjustment layer over what the band holds: each covered pixel's colour goes through the adjustment, is
   * blended with the layer's mode and mixed in by mask × opacity; alpha is kept (nothing changes where it is 0).
   */
  function adjustBand(dst: Band, n: SceneNode & { type: "RASTER" }, px: PlacedPixels | null) {
    const A = n.adjust!;
    const f = adjustFnOf(A.adj);
    const op = n.opacity;
    if (!f || op <= 0) return;
    const B = blendOf(n.blendMode);
    const d = dst.d;
    const o3 = [0, 0, 0], m3 = new Float64Array(3);
    for (let y = dst.y0; y < dst.y0 + dst.h; y++)
      for (let x = 0; x < W; x++) {
        let m = 0;
        if (px && x >= px.left && y >= px.top && x < px.left + px.width && y < px.top + px.height) m = px.rgba[((y - px.top) * px.width + (x - px.left)) * 4 + 3] / 255;
        const k = (A.hide ? 1 - m : m) * op;
        if (k <= 0) continue;
        const o = ((y - dst.y0) * W + x) * 4;
        const da = d[o + 3];
        if (da <= 0) continue;
        let r = d[o] / da, g = d[o + 1] / da, b = d[o + 2] / da;
        // (on a linear page the adjustment works on the colours as shown, then back: approximate)
        if (linear) ((r = linearToSrgb(r)), (g = linearToSrgb(g)), (b = linearToSrgb(b)));
        f(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), o3);
        let sr = o3[0] / 255, sg = o3[1] / 255, sb = o3[2] / 255;
        if (B) {
          B(r, g, b, sr, sg, sb, m3);
          ((sr = m3[0]), (sg = m3[1]), (sb = m3[2]));
        }
        if (linear) {
          d[o] = srgbToLinear(r + (sr - r) * k) * da;
          d[o + 1] = srgbToLinear(g + (sg - g) * k) * da;
          d[o + 2] = srgbToLinear(b + (sb - b) * k) * da;
          continue;
        }
        d[o] = (r + (sr - r) * k) * da;
        d[o + 1] = (g + (sg - g) * k) * da;
        d[o + 2] = (b + (sb - b) * k) * da;
      }
  }

  /** `adjustBand` for a CMYK document: the adjustment's ink function on both planes at once (adjustLayer.ts). */
  function adjustInk(dst: Band, n: SceneNode & { type: "RASTER" }, px: PlacedPixels | null) {
    const A = n.adjust!;
    const f = inkFnOf(A.adj);
    const op = n.opacity;
    if (!f || op <= 0) return;
    const B = blendOf(n.blendMode);
    const d = dst.d, kd = dst.k!;
    const o4 = new Float64Array(4), m3 = new Float64Array(3);
    for (let y = dst.y0; y < dst.y0 + dst.h; y++)
      for (let x = 0; x < W; x++) {
        let m = 0;
        if (px && x >= px.left && y >= px.top && x < px.left + px.width && y < px.top + px.height) m = px.rgba[((y - px.top) * px.width + (x - px.left)) * 4 + 3] / 255;
        const k = (A.hide ? 1 - m : m) * op;
        if (k <= 0) continue;
        const o = ((y - dst.y0) * W + x) * 4;
        const da = d[o + 3], ka = kd[o + 3];
        if (da <= 0 || ka <= 0) continue;
        const r = d[o] / da, g = d[o + 1] / da, b = d[o + 2] / da, kk = kd[o] / ka;
        f(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(kk * 255), o4);
        let sr = o4[0] / 255, sg = o4[1] / 255, sb = o4[2] / 255, sk = o4[3] / 255;
        if (B) {
          B(r, g, b, sr, sg, sb, m3);
          ((sr = m3[0]), (sg = m3[1]), (sb = m3[2]));
          B(kk, kk, kk, sk, sk, sk, m3);
          sk = m3[0];
        }
        d[o] = (r + (sr - r) * k) * da;
        d[o + 1] = (g + (sg - g) * k) * da;
        d[o + 2] = (b + (sb - b) * k) * da;
        kd[o] = kd[o + 1] = kd[o + 2] = (kk + (sk - kk) * k) * ka;
      }
  }

  /** Premultiplied float pixels in the box of `st` onto a plane (opacity, blend, atop as in `put`). */
  function paintFloat(d: Float32Array, by0: number, bh: number, st: Styled, src: Float32Array, op: number, B: PixelBlend | null, atop: boolean, dis = false, bif?: readonly number[]) {
    if (op <= 0) return;
    const x0 = Math.max(0, st.left), x1 = Math.min(W, st.left + st.width);
    const y0 = Math.max(by0, st.top), y1 = Math.min(by0 + bh, st.top + st.height);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const s = ((y - st.top) * st.width + (x - st.left)) * 4;
        let a = src[s + 3] * op, m = op;
        if (a <= 0) continue;
        if (bif) {
          const o = ((y - by0) * W + x) * 4, da = d[o + 3], sa = src[s + 3];
          const bc = (c: number) => (da > 0 ? (linear ? linearToSrgb(d[o + c] / da) : d[o + c] / da) * 255 : 0);
          const sc = (c: number) => (linear ? linearToSrgb(src[s + c] / sa) : src[s + c] / sa) * 255;
          const k = blendIfWeight(bif, sc(0), sc(1), sc(2), bc(0), bc(1), bc(2));
          a *= k;
          m *= k;
          if (a <= 0) continue;
        }
        if (dis) {
          if (!dissolveKeep(x, y, a)) continue;
          m = op / a;
          a = 1;
        }
        put(d, ((y - by0) * W + x) * 4, src[s] * m, src[s + 1] * m, src[s + 2] * m, a, B, atop);
      }
  }
}
