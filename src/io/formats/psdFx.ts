// Photoshop layer effects: the object-based effects block (lfx2, and lmfx for "multiple" effects) ↔ Effect[].
// Format reference: Adobe "Photoshop File Formats Specification" — "Object-based effects layer info" and the
// action "Descriptor structure" (clean-room). Byte preservation (design ch. 8.3):
//   • an untouched layer keeps its original block bytes (the PSD Surgeon never calls this writer);
//   • an edited layer's block is written from its ORIGINAL descriptor tree with only the changed fields replaced
//     (contours, "present / showInDialog", unknown keys and colour spaces of unchanged colours stay as they were);
//   • the old effects block (lrFX) is dropped on such a rewrite — Photoshop reads lfx2 and rebuilds lrFX itself,
//     a stale lrFX would contradict it.

import { colorOf, rgbaOf } from "../../core/style/color";
import type { Color, Effect, GradientStop, Paint, StyleBlend } from "../../core/style/types";

// ───────── descriptor model ─────────

export type DVal =
  | { t: "Objc" | "GlbO"; v: Desc }
  | { t: "VlLs"; v: DVal[] }
  | { t: "doub"; v: number }
  | { t: "UntF"; unit: string; v: number }
  | { t: "TEXT"; v: string }
  | { t: "enum"; type: string; v: string }
  | { t: "long"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "type" | "GlbC"; name: string; cls: string }
  | { t: "raw"; type: string; bytes: Uint8Array };

export interface Desc {
  name: string;
  cls: string;
  items: [string, DVal][];
}

/** Nesting limit of descriptor objects / lists (Photoshop's own effects nest 4–5 deep; a hostile file far more). */
const MAX_DEPTH = 32;

class R {
  dv: DataView;
  depth = 0;
  constructor(public b: Uint8Array, public p = 0) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  /** Fail before reading `n` bytes that are not there (a hostile length would otherwise loop over nothing). */
  need(n: number) {
    if (!(n >= 0) || this.p + n > this.b.length) throw new Error("effects descriptor: data ends early");
  }
  u32() {
    const v = this.dv.getUint32(this.p);
    this.p += 4;
    return v;
  }
  i32() {
    const v = this.dv.getInt32(this.p);
    this.p += 4;
    return v;
  }
  f64() {
    const v = this.dv.getFloat64(this.p);
    this.p += 8;
    return v;
  }
  str4() {
    this.need(4);
    const s = String.fromCharCode(this.b[this.p], this.b[this.p + 1], this.b[this.p + 2], this.b[this.p + 3]);
    this.p += 4;
    return s;
  }
  id() {
    const n = this.u32();
    if (n === 0) return this.str4();
    this.need(n);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]);
    this.p += n;
    return s;
  }
  uni() {
    const n = this.u32();
    this.need(n * 2);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint16(this.p + i * 2));
    this.p += n * 2;
    return s;
  }
  bytes(n: number) {
    this.need(n);
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
}

function readDesc(r: R): Desc {
  if (++r.depth > MAX_DEPTH) throw new Error("effects descriptor: nested too deep");
  const name = r.uni();
  const cls = r.id();
  const n = r.u32();
  // every item takes at least 8 bytes (key length + type): a count beyond that is a broken / hostile file
  r.need(n * 8);
  const items: [string, DVal][] = [];
  for (let i = 0; i < n; i++) {
    const key = r.id();
    items.push([key, readVal(r, r.str4())]);
  }
  r.depth--;
  return { name, cls, items };
}

function readVal(r: R, t: string): DVal {
  switch (t) {
    case "Objc":
    case "GlbO":
      return { t, v: readDesc(r) };
    case "VlLs": {
      const n = r.u32();
      r.need(n * 4); // each value has at least its 4-byte type
      if (++r.depth > MAX_DEPTH) throw new Error("effects descriptor: nested too deep");
      const v: DVal[] = [];
      for (let i = 0; i < n; i++) v.push(readVal(r, r.str4()));
      r.depth--;
      return { t, v };
    }
    case "doub":
      return { t, v: r.f64() };
    case "UntF":
      return { t, unit: r.str4(), v: r.f64() };
    case "TEXT":
      return { t, v: r.uni() };
    case "enum":
      return { t, type: r.id(), v: r.id() };
    case "long":
      return { t, v: r.i32() };
    case "bool":
      r.need(1);
      return { t, v: r.b[r.p++] !== 0 };
    case "type":
    case "GlbC":
      return { t, name: r.uni(), cls: r.id() };
    case "comp":
      return { t: "raw", type: t, bytes: r.bytes(8) };
    case "alis":
    case "tdta":
    case "Pth ": {
      const s = r.p;
      const n = r.u32();
      r.need(n);
      r.p += n;
      return { t: "raw", type: t, bytes: r.b.subarray(s, r.p) };
    }
    case "UnFl": {
      const s = r.p;
      r.need(4);
      r.p += 4;
      const n = r.u32();
      r.need(n * 8);
      r.p += n * 8;
      return { t: "raw", type: t, bytes: r.b.subarray(s, r.p) };
    }
    default:
      throw new Error(`descriptor type '${t}' not supported`);
  }
}

class W {
  chunks: number[] = [];
  u32(v: number) {
    this.chunks.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
  i32(v: number) {
    this.u32(v >>> 0);
  }
  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    this.chunks.push(...b);
  }
  str4(s: string) {
    for (let i = 0; i < 4; i++) this.chunks.push(s.charCodeAt(i) & 255);
  }
  id(s: string) {
    if (s.length === 4) {
      this.u32(0);
      this.str4(s);
    } else {
      this.u32(s.length);
      for (let i = 0; i < s.length; i++) this.chunks.push(s.charCodeAt(i) & 255);
    }
  }
  uni(s: string) {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.chunks.push((c >> 8) & 255, c & 255);
    }
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.chunks.push(x);
  }
  done() {
    return new Uint8Array(this.chunks);
  }
}

function writeDesc(w: W, d: Desc) {
  w.uni(d.name);
  w.id(d.cls);
  w.u32(d.items.length);
  for (const [k, v] of d.items) {
    w.id(k);
    writeVal(w, v);
  }
}

function writeVal(w: W, v: DVal) {
  w.str4(v.t === "raw" ? v.type : v.t);
  switch (v.t) {
    case "Objc":
    case "GlbO":
      return writeDesc(w, v.v);
    case "VlLs":
      w.u32(v.v.length);
      for (const x of v.v) writeVal(w, x);
      return;
    case "doub":
      return w.f64(v.v);
    case "UntF":
      w.str4(v.unit);
      return w.f64(v.v);
    case "TEXT":
      return w.uni(v.v);
    case "enum":
      w.id(v.type);
      return w.id(v.v);
    case "long":
      return w.i32(v.v);
    case "bool":
      return void w.chunks.push(v.v ? 1 : 0);
    case "type":
    case "GlbC":
      w.uni(v.name);
      return w.id(v.cls);
    case "raw":
      return w.bytes(v.bytes);
  }
}

/** Effects block data (lfx2 / lmfx): version 0, descriptor version 16, descriptor. */
export function parseFxBlock(data: Uint8Array): Desc {
  const r = new R(data);
  const ver = r.u32();
  const dver = r.u32();
  if (ver !== 0 || dver !== 16) throw new Error(`effects block version ${ver}/${dver}`);
  return readDesc(r);
}

/** A bare descriptor block (descriptor version 16, then the descriptor) at `at`: CgEd, blwh, … */
export function parseDescAt(data: Uint8Array, at = 0): Desc {
  const r = new R(data, at);
  const dver = r.u32();
  if (dver !== 16) throw new Error(`descriptor version ${dver}`);
  return readDesc(r);
}

export function writeFxBlock(d: Desc): Uint8Array {
  const w = new W();
  w.u32(0);
  w.u32(16);
  writeDesc(w, d);
  return w.done();
}

/** Descriptor bytes alone (tests: parse → write identity). */
export function descBytes(d: Desc): Uint8Array {
  const w = new W();
  writeDesc(w, d);
  return w.done();
}
export const readDescBytes = (b: Uint8Array) => readDesc(new R(b));
/** A descriptor (without a version word) at `at` and the offset just after it. Throws on a type it does not know. */
export function readDescEnd(b: Uint8Array, at: number): { desc: Desc; end: number } {
  const r = new R(b, at);
  const desc = readDesc(r);
  return { desc, end: r.p };
}

// ───────── descriptor helpers ─────────

const get = (d: Desc | undefined, k: string) => d?.items.find((x) => x[0] === k)?.[1];
const num = (v: DVal | undefined, def = 0) => (v && (v.t === "doub" || v.t === "UntF" || v.t === "long") ? v.v : def);
const bool = (v: DVal | undefined, def = false) => (v && v.t === "bool" ? v.v : def);
const en = (v: DVal | undefined) => (v && v.t === "enum" ? v.v : "");
const obj = (v: DVal | undefined) => (v && (v.t === "Objc" || v.t === "GlbO") ? v.v : undefined);

/** Replace (or append) item `k` of `d` in place. */
function put(d: Desc, k: string, v: DVal) {
  const i = d.items.findIndex((x) => x[0] === k);
  if (i >= 0) d.items[i] = [k, v];
  else d.items.push([k, v]);
}

const unitF = (unit: string, v: number): DVal => ({ t: "UntF", unit, v });
const B = (v: boolean): DVal => ({ t: "bool", v });
const E = (type: string, v: string): DVal => ({ t: "enum", type, v });
const O = (cls: string, items: [string, DVal][], name = ""): DVal => ({ t: "Objc", v: { name, cls, items } });

// ───────── blend modes ─────────

const BLEND_ENUM: Record<StyleBlend, string> = {
  NORMAL: "Nrml", DISSOLVE: "Dslv", DARKEN: "Drkn", MULTIPLY: "Mltp", COLOR_BURN: "CBrn", LINEAR_BURN: "linearBurn", DARKER_COLOR: "darkerColor",
  LIGHTEN: "Lghn", SCREEN: "Scrn", COLOR_DODGE: "CDdg", LINEAR_DODGE: "linearDodge", LIGHTER_COLOR: "lighterColor",
  OVERLAY: "Ovrl", SOFT_LIGHT: "SftL", HARD_LIGHT: "HrdL", VIVID_LIGHT: "vividLight", LINEAR_LIGHT: "linearLight", PIN_LIGHT: "pinLight", HARD_MIX: "hardMix",
  DIFFERENCE: "Dfrn", EXCLUSION: "Xclu", SUBTRACT: "blendSubtraction", DIVIDE: "blendDivide",
  HUE: "H   ", SATURATION: "Strt", COLOR: "Clr ", LUMINOSITY: "Lmns",
};
/** The string-id spelling current Photoshop versions write ("multiply" instead of "Mltp"); both are read. */
const BLEND_STR: Record<StyleBlend, string> = {
  NORMAL: "normal", DISSOLVE: "dissolve", DARKEN: "darken", MULTIPLY: "multiply", COLOR_BURN: "colorBurn", LINEAR_BURN: "linearBurn", DARKER_COLOR: "darkerColor",
  LIGHTEN: "lighten", SCREEN: "screen", COLOR_DODGE: "colorDodge", LINEAR_DODGE: "linearDodge", LIGHTER_COLOR: "lighterColor",
  OVERLAY: "overlay", SOFT_LIGHT: "softLight", HARD_LIGHT: "hardLight", VIVID_LIGHT: "vividLight", LINEAR_LIGHT: "linearLight", PIN_LIGHT: "pinLight", HARD_MIX: "hardMix",
  DIFFERENCE: "difference", EXCLUSION: "exclusion", SUBTRACT: "blendSubtraction", DIVIDE: "blendDivide",
  HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
};
const BLEND_IN = {
  ...Object.fromEntries(Object.entries(BLEND_ENUM).map(([k, v]) => [v, k as StyleBlend])),
  ...Object.fromEntries(Object.entries(BLEND_STR).map(([k, v]) => [v, k as StyleBlend])),
} as Record<string, StyleBlend>;
/** Blend enum value in the spelling `like` uses (string ids unless the file used four-letter ids). */
const blendOut = (b: StyleBlend, like: DVal | undefined) => (like && like.t === "enum" && /^[A-Z][A-Za-z ]{3}$/.test(like.v) && like.v.length === 4 ? BLEND_ENUM[b] : BLEND_STR[b]);

// ───────── colours ─────────

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

function readColor(d: Desc | undefined): Color {
  if (!d) return { hex: "#000000" };
  switch (d.cls) {
    case "RGBC": {
      const r = num(get(d, "Rd  ") ?? get(d, "redFloat")), g = num(get(d, "Grn ") ?? get(d, "greenFloat")), b = num(get(d, "Bl  ") ?? get(d, "blueFloat"));
      const f = get(d, "redFloat") && !get(d, "Rd  ") ? 255 : 1;
      return { hex: `#${hex2(r * f)}${hex2(g * f)}${hex2(b * f)}` };
    }
    case "Grsc": {
      const k = 255 - (num(get(d, "Gry ")) / 100) * 255;
      return { hex: `#${hex2(k)}${hex2(k)}${hex2(k)}`, space: "gray", v: [1 - num(get(d, "Gry ")) / 100] };
    }
    case "CMYC": {
      const c = num(get(d, "Cyn ")) / 100, m = num(get(d, "Mgnt")) / 100, y = num(get(d, "Ylw ")) / 100, k = num(get(d, "Blck")) / 100;
      return { hex: `#${hex2(255 * (1 - c) * (1 - k))}${hex2(255 * (1 - m) * (1 - k))}${hex2(255 * (1 - y) * (1 - k))}`, space: "cmyk", v: [c, m, y, k] };
    }
    case "HSBC": {
      const h = num(get(d, "H   ")) / 60, s = num(get(d, "Strt")) / 100, v = num(get(d, "Brgh")) / 100;
      const i = Math.floor(h) % 6, f = h - Math.floor(h), p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
      const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
      return { hex: `#${hex2(r * 255)}${hex2(g * 255)}${hex2(b * 255)}` };
    }
    default:
      return { hex: "#000000" };
  }
}

function colorVal(c: Color): DVal {
  const v = rgbaOf(c);
  return O("RGBC", [["Rd  ", { t: "doub", v: v.r }], ["Grn ", { t: "doub", v: v.g }], ["Bl  ", { t: "doub", v: v.b }]]);
}

const sameHex = (a: Color, b: Color) => a.hex.toLowerCase() === b.hex.toLowerCase();

// ───────── gradients ─────────

function readGradient(d: Desc | undefined, angle: number, type: string, reverse: boolean): Paint {
  const clrs = get(d, "Clrs");
  const trns = get(d, "Trns");
  const interval = num(get(d, "Intr"), 4096) || 4096;
  const alphas = trns && trns.t === "VlLs" ? trns.v.map((x) => obj(x)).filter(Boolean).map((t) => ({ at: num(get(t, "Lctn")) / 4096, a: num(get(t, "Opct"), 100) / 100 })) : [];
  const alphaAt = (at: number) => {
    if (!alphas.length) return 1;
    if (at <= alphas[0].at) return alphas[0].a;
    for (let i = 1; i < alphas.length; i++) if (at <= alphas[i].at) return alphas[i - 1].a + ((alphas[i].a - alphas[i - 1].a) * (at - alphas[i - 1].at)) / (alphas[i].at - alphas[i - 1].at || 1);
    return alphas[alphas.length - 1].a;
  };
  let stops: GradientStop[] = clrs && clrs.t === "VlLs"
    ? clrs.v.map((x) => obj(x)!).filter(Boolean).map((s) => {
        const at = num(get(s, "Lctn")) / (interval === 4096 ? 4096 : 4096);
        const c = readColor(obj(get(s, "Clr ")));
        const a = alphaAt(at);
        const mid = num(get(s, "Mdpn"), 50) / 100;
        return { at, color: a < 1 ? { ...c, a } : c, ...(Math.abs(mid - 0.5) > 1e-9 ? { mid } : {}) };
      })
    : [{ at: 0, color: { hex: "#000000" } }, { at: 1, color: { hex: "#ffffff" } }];
  if (reverse) stops = stops.map((s) => ({ ...s, at: 1 - s.at })).reverse();
  const a = (angle * Math.PI) / 180, cx = Math.cos(a) / 2, cy = -Math.sin(a) / 2;
  const kind = type === "Rdl " ? "radial" : type === "Angl" ? "angular" : type === "Dmnd" ? "diamond" : "linear";
  if (kind === "linear") return { type: "gradient", kind, stops, from: [0.5 - cx, 0.5 - cy], to: [0.5 + cx, 0.5 + cy] };
  return { type: "gradient", kind, stops, from: [0.5, 0.5], to: [0.5 + cx, 0.5 + cy] };
}

function gradientAngle(p: Extract<Paint, { type: "gradient" }>): number {
  const dx = p.to[0] - p.from[0], dy = p.to[1] - p.from[1];
  const a = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return Math.round(a * 1000) / 1000;
}

function gradientDesc(p: Extract<Paint, { type: "gradient" }>): DVal {
  const stops = [...p.stops].sort((a, b) => a.at - b.at);
  return O(
    "Grdn",
    [
      ["Nm  ", { t: "TEXT", v: "Custom\u0000" }],
      ["GrdF", E("GrdF", "CstS")],
      ["Intr", { t: "doub", v: 4096 }],
      ["Clrs", { t: "VlLs", v: stops.map((s) => O("Clrt", [["Clr ", colorVal(s.color)], ["Type", E("Clry", "UsrS")], ["Lctn", { t: "long", v: Math.round(s.at * 4096) }], ["Mdpn", { t: "long", v: Math.round((s.mid ?? 0.5) * 100) }]])) }],
      ["Trns", { t: "VlLs", v: stops.map((s) => O("TrnS", [["Opct", unitF("#Prc", (s.color.a ?? 1) * 100)], ["Lctn", { t: "long", v: Math.round(s.at * 4096) }], ["Mdpn", { t: "long", v: 50 }]])) }],
    ],
    "Gradient",
  );
}

// ───────── effect ↔ descriptor ─────────

const KEY_SINGLE: Record<string, string> = { dropShadow: "DrSh", innerShadow: "IrSh", outerGlow: "OrGl", innerGlow: "IrGl", bevel: "ebbl", fxStroke: "FrFX", solid: "SoFi", gradient: "GrFl", pattern: "patternFill", satin: "ChFX" };
const KEY_MULTI: Record<string, string> = { DrSh: "dropShadowMulti", IrSh: "innerShadowMulti", FrFX: "frameFXMulti", SoFi: "solidFillMulti", GrFl: "gradientFillMulti" };
const SINGLE_OF_MULTI = Object.fromEntries(Object.entries(KEY_MULTI).map(([k, v]) => [v, k]));
const ORDER = ["DrSh", "IrSh", "OrGl", "IrGl", "ebbl", "SoFi", "GrFl", "patternFill", "FrFX", "ChFX"];
const ALL_FX_KEYS = new Set([...ORDER, ...Object.values(KEY_MULTI)]);

/** File key of an effect. */
export function effectKey(e: Effect): string {
  if (e.type === "overlay") return KEY_SINGLE[e.paint.type] ?? "SoFi";
  return KEY_SINGLE[e.type];
}

const contour = (): DVal => O("ShpC", [["Nm  ", { t: "TEXT", v: "Linear\u0000" }], ["Crv ", { t: "VlLs", v: [O("CrPt", [["Hrzn", { t: "doub", v: 0 }], ["Vrtc", { t: "doub", v: 0 }]]), O("CrPt", [["Hrzn", { t: "doub", v: 255 }], ["Vrtc", { t: "doub", v: 255 }]])] }]], "");

/** One effect object → Effect (null for an effect type the model does not hold). */
export function readEffect(key: string, d: Desc, globalAngle: number, master = true): Effect | null {
  const on = master && bool(get(d, "enab"), true);
  const blend = BLEND_IN[en(get(d, "Md  "))];
  // values are clamped to the ranges Photoshop's Layer Style dialog allows (Size / stroke 0–250 px, Distance 0–30000,
  // percentages 0–100 %): a damaged or hostile file cannot ask the renderer for a 10⁹-px blur or a NaN
  const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);
  const opacity = clamp(num(get(d, "Opct"), 100), 0, 100) / 100;
  const base = { on, ...(blend ? { blend } : {}), opacity };
  const px = (k: string, hi = 250) => ({ v: clamp(num(get(d, k)), 0, hi), u: "px" as const });
  const pct = (k: string, hi = 100) => clamp(num(get(d, k)), 0, hi) / 100;
  const angleOf = () => (bool(get(d, "uglg")) ? globalAngle : clamp(num(get(d, "lagl"), 120), -360, 360));
  switch (key) {
    case "DrSh":
    case "IrSh": {
      const e: Effect = { ...base, type: key === "DrSh" ? "dropShadow" : "innerShadow", color: readColor(obj(get(d, "Clr "))), angle: angleOf(), distance: px("Dstn", 30000), spread: pct("Ckmt"), size: px("blur") };
      if (bool(get(d, "uglg"))) e.globalLight = true;
      const noise = pct("Nose");
      if (noise) e.noise = noise;
      if (key === "DrSh" && get(d, "layerConceals") && !bool(get(d, "layerConceals"))) e.knockout = false;
      return e;
    }
    case "OrGl":
    case "IrGl": {
      const grad = obj(get(d, "Grad"));
      const paint: Paint = grad ? readGradient(grad, 90, "Lnr ", false) : { type: "solid", color: readColor(obj(get(d, "Clr "))) };
      const e: Effect = { ...base, type: key === "OrGl" ? "outerGlow" : "innerGlow", paint, spread: pct("Ckmt"), size: px("blur") };
      const range = get(d, "Inpr");
      if (range && Math.abs(num(range) - 50) > 1e-9) e.range = pct("Inpr");
      if (key === "IrGl") e.source = en(get(d, "glwS")) === "SrcC" ? "center" : "edge";
      return e;
    }
    case "FrFX": {
      const st = en(get(d, "Styl"));
      const pt = en(get(d, "PntT"));
      const paint: Paint = pt === "GrFl" ? readGradient(obj(get(d, "Grad")), num(get(d, "Angl"), 90), en(get(d, "Type")), bool(get(d, "Rvrs"))) : { type: "solid", color: readColor(obj(get(d, "Clr "))) };
      return { ...base, type: "fxStroke", stroke: { paint, width: px("Sz  "), align: st === "InsF" ? "inside" : st === "CtrF" ? "center" : "outside" } };
    }
    case "SoFi":
      return { ...base, type: "overlay", paint: { type: "solid", color: readColor(obj(get(d, "Clr "))) } };
    case "GrFl":
      return { ...base, type: "overlay", paint: readGradient(obj(get(d, "Grad")), num(get(d, "Angl"), 90), en(get(d, "Type")), bool(get(d, "Rvrs"))) };
    case "ebbl": {
      const s = en(get(d, "bvlS"));
      const style = s === "OtrB" ? "outer" : s === "Embs" ? "emboss" : s === "PlEb" ? "pillow" : s === "strokeEmboss" ? "strokeEmboss" : "inner";
      return {
        on,
        type: "bevel",
        style,
        depth: pct("srgR", 1000),
        size: px("blur"),
        soften: px("Sftn"),
        angle: angleOf(),
        altitude: clamp(num(get(d, "Lald"), 30), 0, 90),
        highlight: readColor(obj(get(d, "hglC"))),
        shadow: readColor(obj(get(d, "sdwC"))),
      };
    }
    case "ChFX":
      return { ...base, type: "satin", color: readColor(obj(get(d, "Clr "))), angle: num(get(d, "lagl"), 19), distance: px("Dstn", 30000), size: px("blur"), ...(bool(get(d, "Invr")) ? { invert: true } : {}) };
    default:
      return null;
  }
}

/** Write the fields of `e` into effect object `d` (in place), touching only fields whose value differs from `was`. */
function patchEffect(d: Desc, e: Effect, was: Effect | null) {
  const same = (k: string, a: unknown, b: unknown) => was && JSON.stringify(a) === JSON.stringify(b) && get(d, k) !== undefined;
  const w = was as any;
  const setNum = (k: string, unit: string | null, v: number, wv: number | undefined) => {
    if (was && wv !== undefined && Math.abs(v - wv) < 1e-9 && get(d, k)) return;
    const old = get(d, k);
    put(d, k, unit ? unitF(old && old.t === "UntF" ? old.unit : unit, v) : { t: "doub", v });
  };
  if (!(was && was.on === e.on)) put(d, "enab", B(e.on));
  if (e.type !== "bevel") {
    if (!(was && (w.blend ?? null) === (e.blend ?? null) && get(d, "Md  "))) put(d, "Md  ", E("BlnM", blendOut(e.blend ?? "NORMAL", get(d, "Md  "))));
    setNum("Opct", "#Prc", (e.opacity ?? 1) * 100, w ? (w.opacity ?? 1) * 100 : undefined);
  }
  switch (e.type) {
    case "dropShadow":
    case "innerShadow": {
      if (!(w && sameHex(w.color, e.color) && get(d, "Clr "))) put(d, "Clr ", colorVal(e.color));
      if (!(w && !!w.globalLight === !!e.globalLight && get(d, "uglg"))) put(d, "uglg", B(!!e.globalLight));
      setNum("lagl", "#Ang", e.angle, w?.angle);
      setNum("Dstn", "#Pxl", e.distance.v, w?.distance.v);
      setNum("Ckmt", "#Pxl", e.spread * 100, w ? w.spread * 100 : undefined);
      setNum("blur", "#Pxl", e.size.v, w?.size.v);
      setNum("Nose", "#Prc", (e.noise ?? 0) * 100, w ? (w.noise ?? 0) * 100 : undefined);
      if (!get(d, "AntA")) put(d, "AntA", B(false));
      if (!get(d, "TrnS")) put(d, "TrnS", contour());
      if (e.type === "dropShadow" && !(w && (w.knockout ?? true) === (e.knockout ?? true) && get(d, "layerConceals"))) put(d, "layerConceals", B(e.knockout ?? true));
      break;
    }
    case "outerGlow":
    case "innerGlow": {
      if (!(w && same("Clr ", w.paint, e.paint))) {
        if (e.paint.type === "gradient") put(d, "Grad", gradientDesc(e.paint));
        else put(d, "Clr ", colorVal(e.paint.type === "solid" ? e.paint.color : { hex: "#ffffbe" }));
      }
      if (!get(d, "GlwT")) put(d, "GlwT", E("BETE", "SfBL"));
      setNum("Ckmt", "#Pxl", e.spread * 100, w ? w.spread * 100 : undefined);
      setNum("blur", "#Pxl", e.size.v, w?.size.v);
      if (!get(d, "Nose")) put(d, "Nose", unitF("#Prc", 0));
      setNum("Inpr", "#Prc", (e.range ?? 0.5) * 100, w ? (w.range ?? 0.5) * 100 : undefined);
      if (!get(d, "AntA")) put(d, "AntA", B(false));
      if (!get(d, "TrnS")) put(d, "TrnS", contour());
      if (e.type === "innerGlow" && !(w && w.source === e.source && get(d, "glwS"))) put(d, "glwS", E("IGSr", e.source === "center" ? "SrcC" : "SrcE"));
      break;
    }
    case "fxStroke": {
      const s = e.stroke;
      const ws = w?.stroke;
      if (!(ws && (ws.align ?? "outside") === (s.align ?? "outside") && get(d, "Styl"))) put(d, "Styl", E("FStl", s.align === "inside" ? "InsF" : s.align === "center" ? "CtrF" : "OutF"));
      if (!(ws && JSON.stringify(ws.paint) === JSON.stringify(s.paint))) {
        if (s.paint.type === "gradient") {
          put(d, "PntT", E("FrFl", "GrFl"));
          put(d, "Grad", gradientDesc(s.paint));
          put(d, "Angl", unitF("#Ang", gradientAngle(s.paint)));
          put(d, "Type", E("GrdT", s.paint.kind === "radial" ? "Rdl " : "Lnr "));
        } else {
          put(d, "PntT", E("FrFl", "SClr"));
          put(d, "Clr ", colorVal(s.paint.type === "solid" ? s.paint.color : { hex: "#000000" }));
        }
      }
      setNum("Sz  ", "#Pxl", s.width.v, ws?.width.v);
      break;
    }
    case "overlay": {
      if (!(w && JSON.stringify(w.paint) === JSON.stringify(e.paint))) {
        if (e.paint.type === "gradient") {
          put(d, "Grad", gradientDesc(e.paint));
          put(d, "Angl", unitF("#Ang", gradientAngle(e.paint)));
          put(d, "Type", E("GrdT", e.paint.kind === "radial" ? "Rdl " : e.paint.kind === "angular" ? "Angl" : e.paint.kind === "diamond" ? "Dmnd" : "Lnr "));
          put(d, "Rvrs", B(false));
          if (!get(d, "Algn")) put(d, "Algn", B(true));
          if (!get(d, "Scl ")) put(d, "Scl ", unitF("#Prc", 100));
        } else put(d, "Clr ", colorVal(e.paint.type === "solid" ? e.paint.color : { hex: "#000000" }));
      }
      break;
    }
    case "bevel": {
      const styles = { inner: "InrB", outer: "OtrB", emboss: "Embs", pillow: "PlEb", strokeEmboss: "strokeEmboss" } as const;
      if (!(w && w.style === e.style && get(d, "bvlS"))) put(d, "bvlS", E("BESl", styles[e.style]));
      setNum("srgR", "#Prc", e.depth * 100, w ? w.depth * 100 : undefined);
      setNum("blur", "#Pxl", e.size.v, w?.size.v);
      setNum("Sftn", "#Pxl", e.soften.v, w?.soften.v);
      setNum("lagl", "#Ang", e.angle, w?.angle);
      setNum("Lald", "#Ang", e.altitude, w?.altitude);
      if (!(w && sameHex(w.highlight, e.highlight) && get(d, "hglC"))) put(d, "hglC", colorVal(e.highlight));
      if (!(w && sameHex(w.shadow, e.shadow) && get(d, "sdwC"))) put(d, "sdwC", colorVal(e.shadow));
      if (!get(d, "hglM")) put(d, "hglM", E("BlnM", "screen"));
      if (!get(d, "hglO")) put(d, "hglO", unitF("#Prc", 75));
      if (!get(d, "sdwM")) put(d, "sdwM", E("BlnM", "multiply"));
      if (!get(d, "sdwO")) put(d, "sdwO", unitF("#Prc", 75));
      if (!get(d, "bvlT")) put(d, "bvlT", E("bvlT", "SfBL"));
      if (!get(d, "bvlD")) put(d, "bvlD", E("BESs", "In  "));
      if (!get(d, "uglg")) put(d, "uglg", B(false));
      break;
    }
    case "satin": {
      if (!(w && sameHex(w.color, e.color) && get(d, "Clr "))) put(d, "Clr ", colorVal(e.color));
      setNum("lagl", "#Ang", e.angle, w?.angle);
      setNum("Dstn", "#Pxl", e.distance.v, w?.distance.v);
      setNum("blur", "#Pxl", e.size.v, w?.size.v);
      if (!(w && !!w.invert === !!e.invert && get(d, "Invr"))) put(d, "Invr", B(!!e.invert));
      break;
    }
  }
}

const EFFECT_CLASS: Record<string, string> = { DrSh: "DrSh", IrSh: "IrSh", OrGl: "OrGl", IrGl: "IrGl", ebbl: "ebbl", FrFX: "FrFX", SoFi: "SoFi", GrFl: "GrFl", ChFX: "ChFX" };

export interface FxRead {
  effects: Effect[];
  /** the descriptor the effects came from (kept by the caller to patch on save) */
  desc: Desc;
  /** effect objects the model does not hold (pattern overlay…), kept on save */
  unknown: number;
}

/** Effect objects of a descriptor in file order: [key (single form), object]. */
function effectObjects(d: Desc): [string, Desc][] {
  const out: [string, Desc][] = [];
  for (const [k, v] of d.items) {
    if (SINGLE_OF_MULTI[k] && v.t === "VlLs") for (const x of v.v) { const o = obj(x); if (o) out.push([SINGLE_OF_MULTI[k], o]); }
    else if (ALL_FX_KEYS.has(k)) { const o = obj(v); if (o) out.push([k, o]); }
  }
  return out;
}

/** Effects of an lfx2 / lmfx descriptor. `globalAngle` = the document's global light (resource 1037, default 120°). */
export function readEffects(d: Desc, globalAngle = 120): FxRead {
  const master = bool(get(d, "masterFXSwitch"), true);
  const effects: Effect[] = [];
  let unknown = 0;
  for (const [k, o] of effectObjects(d)) {
    // Photoshop keeps an object for every effect it ever had, with present = false once removed
    if (get(o, "present") && !bool(get(o, "present"))) continue;
    const e = readEffect(k, o, globalAngle, master);
    if (e) effects.push(e);
    else unknown++;
  }
  return { effects, desc: d, unknown };
}

const clone = (d: Desc): Desc => JSON.parse(JSON.stringify(d, (_k, v) => (v instanceof Uint8Array ? { __u8: Array.from(v) } : v)), (_k, v) => (v && v.__u8 ? new Uint8Array(v.__u8) : v));

/**
 * Descriptor for `effects`, built on `orig` when given: effect objects are matched to the original ones of the same
 * key in order and patched field by field; unknown effect objects (pattern overlay) and top-level keys are kept.
 * Several effects of one key are written as that key's *Multi list (Photoshop CC "multiple effects"); returns
 * `multi` = true then, and the caller writes the descriptor as lmfx (with a single-form lfx2 next to it).
 */
export function buildEffectsDesc(effects: readonly Effect[], orig?: Desc | null, globalAngle = 120): { desc: Desc; single: Desc; multi: boolean } {
  const base = orig ? clone(orig) : { name: "", cls: "null", items: [["Scl ", unitF("#Prc", 100)], ["masterFXSwitch", B(true)]] as [string, DVal][] };
  const origObjs = orig ? effectObjects(orig) : [];
  const byKey = new Map<string, Effect[]>();
  for (const e of effects) {
    const k = effectKey(e);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  // master switch: on when any effect is on (an all-off list keeps the file's switch)
  if (effects.some((e) => e.on)) put(base, "masterFXSwitch", B(true));
  const master = bool(get(base, "masterFXSwitch"), true);
  const objsFor = (k: string) => {
    const list = byKey.get(k) ?? [];
    const olds = origObjs.filter((o) => o[0] === k && !(get(o[1], "present") && !bool(get(o[1], "present")))).map((o) => o[1]);
    return list.map((e, i) => {
      const old = olds[i];
      const d = old ? clone(old) : { name: "", cls: EFFECT_CLASS[k] ?? k, items: [] as [string, DVal][] };
      if (!old) {
        d.items.push(["enab", B(e.on)], ["present", B(true)], ["showInDialog", B(true)]);
      }
      const was = old ? readEffect(k, old, globalAngle, master) : null;
      patchEffect(d, e, was);
      return d;
    });
  };
  // rebuild the effect keys: known keys from the model (in Photoshop's order, where the original had them first)
  // (pattern overlays are not in the model: their objects stay as they were)
  const rest = base.items.filter(([k]) => !((ORDER.includes(k) && k !== "patternFill") || SINGLE_OF_MULTI[k]));
  const fxItems: [string, DVal][] = [];
  let multi = false;
  for (const k of ORDER) {
    if (k === "patternFill") continue;
    const objs = objsFor(k);
    if (!objs.length) continue;
    if (objs.length > 1 && KEY_MULTI[k]) {
      multi = true;
      fxItems.push([KEY_MULTI[k], { t: "VlLs", v: objs.map((o) => ({ t: "Objc", v: o }) as DVal) }]);
    } else fxItems.push([k, { t: "Objc", v: objs[0] }]);
  }
  const desc: Desc = { ...base, items: [...rest, ...fxItems] };
  // single form for lfx2 when lmfx carries the multiples: the first of each
  const single: Desc = multi ? { ...desc, items: desc.items.map(([k, v]) => (SINGLE_OF_MULTI[k] && v.t === "VlLs" ? ([SINGLE_OF_MULTI[k], v.v[0]] as [string, DVal]) : [k, v])) } : desc;
  return { desc, single, multi };
}

/** Effects block bytes ready for a record: lfx2 (and lmfx when needed). */
export function effectsBlocks(effects: readonly Effect[], orig?: Desc | null, globalAngle = 120): { lfx2: Uint8Array; lmfx: Uint8Array | null } {
  const { desc, single, multi } = buildEffectsDesc(effects, orig, globalAngle);
  return { lfx2: writeFxBlock(single), lmfx: multi ? writeFxBlock(desc) : null };
}

/** Global light angle of a document (image resource 1037), 120 when absent. */
export function globalLightAngle(bytes: Uint8Array, resItems: { id: number; dataStart: number; dataEnd: number }[]): number {
  const r = resItems.find((x) => x.id === 1037 && x.dataEnd - x.dataStart >= 4);
  if (!r) return 120;
  return new DataView(bytes.buffer, bytes.byteOffset + r.dataStart, 4).getInt32(0);
}

/** Colour for display from a CSS string (tests / defaults). */
export const fxColor = (s: string): Color => colorOf(s) ?? { hex: "#000000" };
