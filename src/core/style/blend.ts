// Blend modes — the single table (design ch. 4.7, rule 10 "one place"). Photoshop's 27 modes with their PSD keys,
// PDF /BM names, Canvas globalCompositeOperation, CSS / SVG mix-blend-mode names and the W3C Compositing and
// Blending Level 1 formulas. The renderer (draw.ts), the PSD reader / writer, merge down, the CPU compositor and
// the PDF / SVG exports all read this file; nothing else spells a blend formula or a blend key.
//
// `model: true` marks the modes the scene graph holds (types.ts BlendMode). Since phase B (2026-11-13) that is all
// 27. Modes without a Canvas operation (canvas: null) are blended on the CPU by the renderer (render/compose.ts) with
// `pixelBlend`; modes without a PDF / CSS name are written as Normal there (caps.ts "blend.photoshop": approx).

import type { BlendMode, LayerGroup, SceneNode } from "../types";
import type { StyleBlend } from "./types";

/** Separable blend function B(cb, cs) on straight colour channels 0..1 (W3C §10.1). */
export type SeparableBlend = (cb: number, cs: number) => number;

export interface BlendDef {
  id: StyleBlend;
  /** Photoshop layer record key (4 chars) */
  psd: string;
  /** PDF /BM name, null = not in PDF (falls back to rasterising or Normal) */
  pdf: string | null;
  /** Canvas2D globalCompositeOperation, null = no Canvas equivalent (CPU path) */
  canvas: GlobalCompositeOperation | null;
  /** CSS / SVG mix-blend-mode, null = none */
  css: string | null;
  /** separable formula; null for the non-separable (HSL) modes, dissolve, darker / lighter colour */
  fn: SeparableBlend | null;
  /** held by the scene graph today (types.ts BlendMode) */
  model: boolean;
}

// The five model formulas are written exactly as they were in draw/merge/psdWrite/softComposite, so composites stay
// bit-identical (tests/style/blend.test.ts compares them with the old copies on a dense grid).
const multiply: SeparableBlend = (cb, cs) => cb * cs;
const screen: SeparableBlend = (cb, cs) => cb + cs - cb * cs;
const overlay: SeparableBlend = (cb, cs) => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs));
const hardLight: SeparableBlend = (cb, cs) => (cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs));

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const colorDodge: SeparableBlend = (cb, cs) => (cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs)));
const colorBurn: SeparableBlend = (cb, cs) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs));
const softLight: SeparableBlend = (cb, cs) => {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
  return cb + (2 * cs - 1) * (d - cb);
};
// Photoshop-only modes (not in W3C): the formulas Photoshop documents / every open implementation uses
const vividLight: SeparableBlend = (cb, cs) => (cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * cs - 1));
const linearLight: SeparableBlend = (cb, cs) => clamp(cb + 2 * cs - 1);
const pinLight: SeparableBlend = (cb, cs) => (cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1));
const hardMix: SeparableBlend = (cb, cs) => (vividLight(cb, cs) < 0.5 ? 0 : 1);

// phase B (2026-11-13): the scene graph holds all 27 modes, so every row is a model mode
const def = (id: StyleBlend, psd: string, pdf: string | null, canvas: GlobalCompositeOperation | null, css: string | null, fn: SeparableBlend | null, model = true): BlendDef => ({ id, psd, pdf, canvas, css, fn, model });

/** All modes, in Photoshop's menu order. */
export const BLEND_TABLE: readonly BlendDef[] = [
  def("NORMAL", "norm", "Normal", "source-over", "normal", null, true),
  def("DISSOLVE", "diss", null, null, null, null),
  def("DARKEN", "dark", "Darken", "darken", "darken", (cb, cs) => Math.min(cb, cs)),
  def("MULTIPLY", "mul ", "Multiply", "multiply", "multiply", multiply, true),
  def("COLOR_BURN", "idiv", "ColorBurn", "color-burn", "color-burn", colorBurn),
  def("LINEAR_BURN", "lbrn", null, null, null, (cb, cs) => clamp(cb + cs - 1)),
  def("DARKER_COLOR", "dkCl", null, null, null, null),
  def("LIGHTEN", "lite", "Lighten", "lighten", "lighten", (cb, cs) => Math.max(cb, cs)),
  def("SCREEN", "scrn", "Screen", "screen", "screen", screen, true),
  def("COLOR_DODGE", "div ", "ColorDodge", "color-dodge", "color-dodge", colorDodge),
  def("LINEAR_DODGE", "lddg", null, null, null, (cb, cs) => clamp(cb + cs)),
  def("LIGHTER_COLOR", "lgCl", null, null, null, null),
  def("OVERLAY", "over", "Overlay", "overlay", "overlay", overlay, true),
  def("SOFT_LIGHT", "sLit", "SoftLight", "soft-light", "soft-light", softLight),
  def("HARD_LIGHT", "hLit", "HardLight", "hard-light", "hard-light", hardLight, true),
  def("VIVID_LIGHT", "vLit", null, null, null, vividLight),
  def("LINEAR_LIGHT", "lLit", null, null, null, linearLight),
  def("PIN_LIGHT", "pLit", null, null, null, pinLight),
  def("HARD_MIX", "hMix", null, null, null, hardMix),
  def("DIFFERENCE", "diff", "Difference", "difference", "difference", (cb, cs) => Math.abs(cb - cs)),
  def("EXCLUSION", "smud", "Exclusion", "exclusion", "exclusion", (cb, cs) => cb + cs - 2 * cb * cs),
  def("SUBTRACT", "fsub", null, null, null, (cb, cs) => clamp(cb - cs)),
  def("DIVIDE", "fdiv", null, null, null, (cb, cs) => (cs <= 0 ? (cb > 0 ? 1 : 0) : clamp(cb / cs))),
  def("HUE", "hue ", "Hue", "hue", "hue", null),
  def("SATURATION", "sat ", "Saturation", "saturation", "saturation", null),
  def("COLOR", "colr", "Color", "color", "color", null),
  def("LUMINOSITY", "lum ", "Luminosity", "luminosity", "luminosity", null),
];

const BY_ID = new Map(BLEND_TABLE.map((d) => [d.id, d]));
const BY_PSD = new Map(BLEND_TABLE.map((d) => [d.psd, d]));

export const blendDef = (id: StyleBlend | string): BlendDef | undefined => BY_ID.get(id as StyleBlend);

/** Modes the scene graph holds today, in menu order (the blend-mode pickers list these). */
export const MODEL_BLEND_MODES = BLEND_TABLE.filter((d) => d.model).map((d) => d.id) as BlendMode[];

const modelOnly = <T>(pick: (d: BlendDef) => T | null): Record<string, T> => {
  const o: Record<string, T> = {};
  for (const d of BLEND_TABLE) {
    const v = pick(d);
    if (d.model && v != null) o[d.id] = v;
  }
  return o;
};

/** Model mode → Canvas2D composite operation. */
export const CANVAS_BLEND: Record<string, GlobalCompositeOperation> = modelOnly((d) => d.canvas);
/** Model mode → PDF /BM name. */
export const PDF_BLEND: Record<BlendMode, string> = modelOnly((d) => d.pdf) as Record<BlendMode, string>;
/** Model mode → CSS / SVG mix-blend-mode, Normal left out (it needs no attribute). */
export const CSS_BLEND: Record<string, string> = modelOnly((d) => (d.id === "NORMAL" ? null : d.css));
/** Model mode → PSD key. */
export const PSD_BLEND_OUT: Record<BlendMode, string> = modelOnly((d) => d.psd) as Record<BlendMode, string>;
/** PSD key → model mode (keys of modes the model does not hold yet are absent: readers fall back to NORMAL). */
export const PSD_BLEND_IN: Record<string, BlendMode> = Object.fromEntries(BLEND_TABLE.filter((d) => d.model).map((d) => [d.psd, d.id as BlendMode]));

/** PSD key → any style mode (for warnings and phase B readers). */
export const blendFromPsdKey = (key: string): StyleBlend | null => BY_PSD.get(key)?.id ?? null;

/**
 * Separable formula of a mode; null for NORMAL (callers take the source colour unchanged) and for modes without a
 * separable formula. Only the model modes are returned for now — see the header.
 */
export function separableBlend(mode: StyleBlend | string): SeparableBlend | null {
  const d = BY_ID.get(mode as StyleBlend);
  return d && d.model ? d.fn : null;
}

/** Separable formula of any table mode (phase B renderer / tests); null for NORMAL and non-separable modes. */
export const anySeparableBlend = (mode: StyleBlend): SeparableBlend | null => BY_ID.get(mode)?.fn ?? null;

/**
 * Source colour after blending with the backdrop — the one rule every compositor uses (straight colours 0..1,
 * `da` = backdrop alpha):
 *   over (an ordinary layer): W3C — where the backdrop is partly transparent the source shows unblended in
 *     proportion: (1 − da)·cs + da·B(cb, cs);
 *   atop (a layer clipped to its base): Photoshop blends against the base's colour as if the base were opaque —
 *     the base's alpha only masks the result: B(cb, cs) (verified on Photoshop-made files, qa/interop/adobe-made/
 *     psd_clip_*, tests/psd/photoshopRefs.test.ts). The Canvas renderer (render/compose.ts) gets the same result by
 *     making a copy of the clip stack opaque before blending onto it.
 */
export const blendMix = (B: SeparableBlend, cb: number, cs: number, da: number, atop: boolean): number => (atop ? B(cb, cs) : (1 - da) * cs + da * B(cb, cs));

/** The source colour unchanged — what a NORMAL layer contributes. */
export const normalBlend: SeparableBlend = (_cb, cs) => cs;

// ───────── whole-pixel blends (every mode, including the non-separable ones) ─────────

/**
 * B(Cb, Cs) on a whole pixel: backdrop and source straight colours (r, g, b in 0..1) → `out`. Separable modes apply
 * their formula per channel; HUE / SATURATION / COLOR / LUMINOSITY are the W3C non-separable formulas (Lum = 0.3 R +
 * 0.59 G + 0.11 B); DARKER / LIGHTER COLOR pick the whole colour with the lower / higher luminosity (measured on
 * omni-fid-blend-darkercolor / lightercolor: 99.7 %; a channel total gives 82 %). DISSOLVE has no colour formula (the compositor dithers its alpha: `dissolveKeep`).
 */
export type PixelBlend = (br: number, bg: number, bb: number, sr: number, sg: number, sb: number, out: Float64Array | number[]) => void;

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(out: Float64Array | number[]) {
  const l = lum(out[0], out[1], out[2]);
  const n = Math.min(out[0], out[1], out[2]), x = Math.max(out[0], out[1], out[2]);
  for (let c = 0; c < 3; c++) {
    if (n < 0) out[c] = l + ((out[c] - l) * l) / (l - n || 1);
    if (x > 1) out[c] = l + ((out[c] - l) * (1 - l)) / (x - l || 1);
  }
}
/** out = colour (r, g, b) with luminosity l */
function setLum(r: number, g: number, b: number, l: number, out: Float64Array | number[]) {
  const d = l - lum(r, g, b);
  out[0] = r + d;
  out[1] = g + d;
  out[2] = b + d;
  clipColor(out);
}
/** out = colour (r, g, b) with saturation s (max − min), hue kept */
function setSat(r: number, g: number, b: number, s: number, out: Float64Array | number[]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const v = [r, g, b];
  if (mx > mn) for (let c = 0; c < 3; c++) out[c] = v[c] === mx ? s : v[c] === mn ? 0 : ((v[c] - mn) * s) / (mx - mn);
  else out[0] = out[1] = out[2] = 0;
  // a colour with two equal maxima: both get s (the loop above already does), equal minima both 0
}
const sat = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);
const tmp = [0, 0, 0];

const NON_SEPARABLE: Partial<Record<StyleBlend, PixelBlend>> = {
  HUE: (br, bg, bb, sr, sg, sb, out) => {
    setSat(sr, sg, sb, sat(br, bg, bb), tmp);
    setLum(tmp[0], tmp[1], tmp[2], lum(br, bg, bb), out);
  },
  SATURATION: (br, bg, bb, sr, sg, sb, out) => {
    setSat(br, bg, bb, sat(sr, sg, sb), tmp);
    setLum(tmp[0], tmp[1], tmp[2], lum(br, bg, bb), out);
  },
  COLOR: (br, bg, bb, sr, sg, sb, out) => setLum(sr, sg, sb, lum(br, bg, bb), out),
  LUMINOSITY: (br, bg, bb, sr, sg, sb, out) => setLum(br, bg, bb, lum(sr, sg, sb), out),
  DARKER_COLOR: (br, bg, bb, sr, sg, sb, out) => {
    const s = lum(sr, sg, sb) < lum(br, bg, bb);
    out[0] = s ? sr : br;
    out[1] = s ? sg : bg;
    out[2] = s ? sb : bb;
  },
  LIGHTER_COLOR: (br, bg, bb, sr, sg, sb, out) => {
    const s = lum(sr, sg, sb) > lum(br, bg, bb);
    out[0] = s ? sr : br;
    out[1] = s ? sg : bg;
    out[2] = s ? sb : bb;
  },
};

// ───────── fill opacity (Photoshop "Fill") ─────────
//
// Fill fades a layer's own pixels but not its effects. For most modes that is the pixels' alpha × fill. Eight modes
// take it inside the formula instead: the source colour moves toward the mode's neutral colour by (1 − fill) and keeps
// its full alpha (hard mix: linear burn by fill, stretched by 1 / (1 − fill)). Fitted on Photoshop's files
// omni-fid-fill50-* (all eight within 2 levels; with alpha × fill they were 0 – 33 % right).

/** The eight modes whose formula takes the fill (Photoshop's 'special eight'). */
export const FILL_IN_FORMULA = new Set<string>(["COLOR_BURN", "LINEAR_BURN", "COLOR_DODGE", "LINEAR_DODGE", "VIVID_LIGHT", "LINEAR_LIGHT", "HARD_MIX", "DIFFERENCE"]);

function fillSeparable(mode: string, f: number): SeparableBlend | null {
  switch (mode) {
    case "COLOR_BURN":
      return (cb, cs) => colorBurn(cb, 1 - f * (1 - cs));
    case "LINEAR_BURN":
      return (cb, cs) => clamp(cb - f * (1 - cs));
    case "COLOR_DODGE":
      return (cb, cs) => colorDodge(cb, f * cs);
    case "LINEAR_DODGE":
      return (cb, cs) => clamp(cb + f * cs);
    case "DIFFERENCE":
      return (cb, cs) => Math.abs(cb - f * cs);
    case "VIVID_LIGHT":
      return (cb, cs) => vividLight(cb, 0.5 + f * (cs - 0.5));
    case "LINEAR_LIGHT":
      return (cb, cs) => clamp(cb + f * (2 * cs - 1));
    case "HARD_MIX":
      return (cb, cs) => clamp((cb - f * (1 - cs)) / Math.max(1e-6, 1 - f));
  }
  return null;
}

/**
 * How a node's fill is drawn: `content` = the factor on its pixels' alpha (effects keep the opacity alone) and `blend`
 * = the blend to use — for the eight modes a blend with the fill inside (`MODE@fill`, a key pixelBlend knows).
 */
export function fillParts(n: { fillOpacity?: number; blendMode: string }): { content: number; blend: string } {
  // (with layer effects the content's share is taken inside the effect stack, core/image/effects.ts applyEffects
  // `fill` — interior effects keep their strength — unless fillInterior: `fxFill`)
  const f = n.fillOpacity;
  if (f === undefined || !(f < 1)) return { content: 1, blend: n.blendMode };
  if (FILL_IN_FORMULA.has(n.blendMode)) return { content: 1, blend: `${n.blendMode}@${Math.max(0, f)}` };
  return { content: Math.max(0, f), blend: n.blendMode };
}

/**
 * A node with layer effects: [the fill taken inside the effect stack (its pixels only), the factor on the styled content
 * afterwards]. Photoshop fades only the pixels — an overlay, an inner shadow or stroke keep their strength, the outer
 * stroke stays outside the shape and the shape still knocks out the drop shadow — unless the interior effects blend as
 * a group (fillInterior), when the whole styled content fades (omni-fid-fill0-fx, fill40-overlay-interior).
 */
export function fxFill(n: { fillOpacity?: number; fillInterior?: boolean; blendMode: string }): [number, number] {
  const c = fillParts(n).content;
  return n.fillInterior ? [1, c] : [c, 1];
}

// ───────── Blend If (blending ranges) ─────────

function rangeWeight(v: number, b0: number, b1: number, w0: number, w1: number): number {
  if (v < b0 || v > w1) return 0;
  let k = 1;
  // the split sliders: a ramp over [from, to], both ends included
  if (v < b1) k = (v - b0 + 1) / (b1 - b0 + 1);
  if (v > w0) k = Math.min(k, (w1 - v + 1) / (w1 - w0 + 1));
  return k;
}

/**
 * How much of a layer pixel shows by its Blend If ranges (NodeBase.blendIf): the product over the channels of the
 * layer's own value and the value below in each range. Colours 0..255; grey = 0.3 R + 0.59 G + 0.11 B. Fitted on
 * Photoshop's files omni-fid-blendif-this / -underlying / -red (within 5 levels, under 1 % of values over 2).
 */
export function blendIfWeight(bif: readonly number[], sr: number, sg: number, sb: number, dr: number, dg: number, db: number): number {
  let w = 1;
  for (let c = 0; c * 8 + 7 < bif.length && w > 0; c++) {
    const o = c * 8;
    const s = c === 0 ? 0.3 * sr + 0.59 * sg + 0.11 * sb : c === 1 ? sr : c === 2 ? sg : sb;
    const d = c === 0 ? 0.3 * dr + 0.59 * dg + 0.11 * db : c === 1 ? dr : c === 2 ? dg : db;
    if (bif[o] > 0 || bif[o + 1] > 0 || bif[o + 2] < 255 || bif[o + 3] < 255) w *= rangeWeight(s, bif[o], bif[o + 1], bif[o + 2], bif[o + 3]);
    if (bif[o + 4] > 0 || bif[o + 5] > 0 || bif[o + 6] < 255 || bif[o + 7] < 255) w *= rangeWeight(d, bif[o + 4], bif[o + 5], bif[o + 6], bif[o + 7]);
  }
  return w;
}

const pixelCache = new Map<string, PixelBlend | null>();
/** Whole-pixel blend of a mode; null for NORMAL and DISSOLVE (source colour unchanged). `MODE@fill`: fillParts. */
export function pixelBlend(mode: StyleBlend | string): PixelBlend | null {
  let p = pixelCache.get(mode);
  if (p !== undefined) return p;
  const at = mode.indexOf("@");
  if (at > 0) {
    const fn = fillSeparable(mode.slice(0, at), Number(mode.slice(at + 1)));
    p = fn ? (br, bg, bb, sr, sg, sb, out) => ((out[0] = fn(br, sr)), (out[1] = fn(bg, sg)), (out[2] = fn(bb, sb))) : null;
    pixelCache.set(mode, p);
    return p;
  }
  const ns = NON_SEPARABLE[mode as StyleBlend];
  const fn = BY_ID.get(mode as StyleBlend)?.fn;
  p = ns ?? (fn ? (br, bg, bb, sr, sg, sb, out) => ((out[0] = fn(br, sr)), (out[1] = fn(bg, sg)), (out[2] = fn(bb, sb))) : null);
  pixelCache.set(mode, p);
  return p;
}

/**
 * `blendMix` for a whole pixel: the source colour after blending (straight 0..1) into `out` — over: (1 − da)·Cs +
 * da·B(Cb, Cs); atop (a clipped layer): B(Cb, Cs). P null = NORMAL (Cs unchanged).
 */
export function blendMixPixel(P: PixelBlend | null, br: number, bg: number, bb: number, sr: number, sg: number, sb: number, da: number, atop: boolean, out: Float64Array | number[]) {
  if (!P || (da <= 0 && !atop)) {
    out[0] = sr;
    out[1] = sg;
    out[2] = sb;
    return;
  }
  P(br, bg, bb, sr, sg, sb, out);
  if (atop) return;
  out[0] = (1 - da) * sr + da * out[0];
  out[1] = (1 - da) * sg + da * out[1];
  out[2] = (1 - da) * sb + da * out[2];
}

/** The blend has no Canvas2D operation: the renderer blends it on the CPU (DISSOLVE included). */
export const needsCpuBlend = (mode: StyleBlend | string): boolean => mode !== "NORMAL" && mode !== "PASS_THROUGH" && mode !== "lerp" && (mode.includes("@") || !BY_ID.get(mode as StyleBlend)?.canvas);

/**
 * DISSOLVE: Photoshop shows each pixel fully or not at all, with probability = its alpha. Its pattern is fixed to
 * the document position; the thresholds it uses for pixel alpha were measured for the first 256 × 256 pixels
 * (dissolveField.ts) and repeat from there — the same dots as Photoshop in that corner, the same density elsewhere.
 */
export function dissolveKeep(x: number, y: number, a: number): boolean {
  const f = field;
  if (f) return Math.round(a * 255) >= f[((y & 255) << 8) | (x & 255)];
  // the table is not here yet (it loads with the first document that dissolves): same density, other dots. Every
  // caller that must match Photoshop waits for it first — the screen repaints when it arrives (render/weave.ts), the
  // score and the exports await `loadDissolveField`
  void loadDissolveField();
  let h = Math.imul((x & 255) * 374761393 + (y & 255) * 668265263, 1274126177);
  h ^= h >>> 16;
  return Math.round(a * 255) >= 1 + ((h >>> 0) % 255);
}

// The 64 KB threshold table (dissolveField.ts) is its own chunk, loaded on demand: never at app start.
let field: Uint8Array | null = null;
let loading: Promise<void> | null = null;

/** Load the DISSOLVE thresholds (once; resolves at once when they are here). */
export function loadDissolveField(): Promise<void> {
  if (field) return Promise.resolve();
  return (loading ??= import("./dissolveField").then(
    (m) => void (field = m.dissolveField()),
    (e) => {
      loading = null;
      throw e;
    },
  ));
}

/** Are the DISSOLVE thresholds loaded? */
export const dissolveReady = (): boolean => !!field;

const dissolveMemo = new WeakMap<readonly SceneNode[], { groups: unknown; v: boolean }>();
/** Does anything on the page dissolve (a layer, a folder or an effect)? Memoized per node list. */
export function pageDissolves(page: { nodes: readonly SceneNode[]; groups?: readonly LayerGroup[] }): boolean {
  const m = dissolveMemo.get(page.nodes);
  if (m && m.groups === page.groups) return m.v;
  const fx = (e: readonly { blend?: string }[] | undefined) => !!e?.some((x) => x.blend === "DISSOLVE");
  const v = page.nodes.some((n) => n.blendMode === "DISSOLVE" || fx(n.effects)) || !!page.groups?.some((g) => g.blendMode === "DISSOLVE" || fx(g.effects));
  dissolveMemo.set(page.nodes, { groups: page.groups, v });
  return v;
}
