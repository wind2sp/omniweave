// Colour management of CMYK documents: a CMYK ICC profile (v2 or v4) evaluated as Photoshop shows a CMYK document —
// the profile's colorimetric table (A2B1, else A2B0) to the profile connection space, black point compensation, then
// to sRGB, relative colorimetric. (Photoshop's display and its Info panel / colour picker convert with Color Settings'
// default intent, relative colorimetric with black point compensation: through U.S. Web Coated (SWOP) v2, 100 % cyan
// reads 0 174 239 and 100 % black 35 31 32, which this reproduces; docs/legal/CMYK_PROFILES.md.)
//
// The way back (a new or edited pixel's inks) goes through the profile's B2A1 (else B2A0) table — Photoshop's own
// RGB → CMYK separation for the profile, black generation included.
//
// For speed both directions are sampled once per profile into a table (`CmykXform`): CMYK → RGB on an 18⁴ grid
// (step 15 of the 8-bit values; K linear between two tetrahedral C·M·Y lookups — Little CMS's 4-input scheme),
// RGB → CMYK on a 33³ grid (trilinear). Built lazily, kept per profile. CMYK → RGB is the same bits on every engine
// (portable arithmetic below, whole-number interpolation): .omw packages re-derive such tiles (recipe psd/2). The way
// back uses the same arithmetic (so a separation, too, is the same everywhere), but nothing re-derives it.
//
// Plain TypeScript, no dependencies: lut8 (mft1), lut16 (mft2), lutAtoB / lutBtoA (mAB / mBA) with curv / para
// curves, Lab or XYZ connection space.

import { DEFAULT_CMYK_ICC_GRID, DEFAULT_CMYK_ICC_HEAD, DEFAULT_CMYK_ICC_SIZE } from "./defaultCmykIcc";

type Vec = Float64Array;
type Stage = (v: Vec) => Vec;

const u32 = (p: Uint8Array, o: number) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
const u16 = (p: Uint8Array, o: number) => (p[o] << 8) | p[o + 1];
const s15 = (p: Uint8Array, o: number) => (u32(p, o) | 0) / 65536;
const sig = (p: Uint8Array, o: number) => String.fromCharCode(p[o], p[o + 1], p[o + 2], p[o + 3]);

// ───────── portable arithmetic ─────────
//
// ECMAScript fixes +, −, ×, ÷, sqrt, floor, round and the float32 rounding of a Float32Array to IEEE 754, but leaves
// Math.pow / exp / log / cbrt (and **) "implementation-approximated": WebView2 and WebKit may give results an ulp
// apart, enough to move a colour a level. Every value the CMYK → RGB table holds is therefore computed below from the
// exact operations only (`ppow`: logarithm by the atanh series, exponential by Taylor series, both with a fixed order of
// operations), so the table, and the tiles decoded through it, are the same bits on every engine (the .omw recipe
// psd/2 relies on it, io/omwDerive.ts; tests/psd/iccPortable.test.ts pins the result). Accurate to a few ulps.

const bits = new DataView(new ArrayBuffer(8));
// ln 2 split as fdlibm does: k·LN2_HI is exact for the |k| < 2048 used here
const LN2 = 0.6931471805599453, LN2_HI = 6.93147180369123816490e-1, LN2_LO = 1.90821492927058770002e-10;
const SQRT2 = 1.4142135623730951;
/** 1 / (2j + 1), j = 1..11: the atanh series to below 1e-17 for |s| ≤ 0.172 */
const ATANH = Array.from({ length: 11 }, (_, j) => 1 / (2 * j + 3));
/** 1 / j!, j = 2..14: the exponential's Taylor series to below 1e-17 for |r| ≤ ln 2 / 2 */
const FACT: number[] = [];
for (let j = 2, f = 1; j <= 14; j++) FACT.push(1 / (f *= j));

/** x · 2^k (k an integer from −1100 to 1024), exact unless the result is subnormal */
function scale2(x: number, k: number): number {
  if (k > 1023) {
    x *= 2;
    k--;
  } else if (k < -1022) {
    x *= 2.2250738585072014e-308; // 2^−1022
    k += 1022;
  }
  bits.setUint32(0, (k + 1023) << 20);
  bits.setUint32(4, 0);
  return x * bits.getFloat64(0);
}

/** ln x for a finite x > 0 */
function pln(x: number): number {
  let e = 0;
  if (x < 2.2250738585072014e-308) {
    x *= 18014398509481984; // 2^54: a subnormal made normal
    e = -54;
  }
  bits.setFloat64(0, x);
  const hi = bits.getUint32(0);
  e += ((hi >>> 20) & 0x7ff) - 1023;
  bits.setUint32(0, (hi & 0x000fffff) | 0x3ff00000);
  let m = bits.getFloat64(0); // x = m · 2^e, m in [1, 2)
  if (m > SQRT2) {
    m *= 0.5;
    e++;
  }
  const s = (m - 1) / (m + 1), z = s * s;
  let p = ATANH[10];
  for (let j = 9; j >= 0; j--) p = ATANH[j] + z * p;
  const lnm = 2 * s + 2 * s * z * p;
  return e * LN2_HI + (lnm + e * LN2_LO);
}

/** e^z */
function pexp(z: number): number {
  if (z < -745.2) return 0;
  if (z > 709.79) return Infinity;
  const k = Math.round(z / LN2);
  const r = z - k * LN2_HI - k * LN2_LO;
  let p = FACT[12];
  for (let j = 11; j >= 0; j--) p = FACT[j] + r * p;
  return scale2(1 + r + r * r * p, k);
}

/**
 * x^y for x ≥ 0 (x^0 = 1), the same on every engine. Outside what the callers pass (x > 0, or y ≥ 0): 0 for x ≤ 0 or
 * NaN (Math.pow: ∞ for 0^−y, NaN for a negative base), finite near the overflow edge (Math.pow(2, 1024) = ∞).
 */
export function ppow(x: number, y: number): number {
  if (y === 0 || x === 1) return 1;
  if (!(x > 0)) return 0;
  if (x === Infinity) return y > 0 ? Infinity : 0;
  return pexp(y * pln(x));
}

/** b^n for small whole numbers (exact) */
const ipow = (b: number, n: number) => {
  let r = 1;
  for (let i = 0; i < n; i++) r *= b;
  return r;
};

class IccError extends Error {}
const need = (ok: unknown, what: string) => {
  if (!ok) throw new IccError(what);
};

// Limits against a damaged or hostile profile (a PSD's resource can be any size): real CMYK profiles have grids of
// up to 33⁴ × 3 values (3.6 M) and curves of up to 4096 entries.
/** values in one colour lookup table (kept as 32-bit floats: 64 MB at most) */
const MAX_CLUT = 1 << 24;
/** entries of one sampled curve */
const MAX_CURVE = 1 << 16;

interface Tag {
  sig: string;
  at: number;
  size: number;
}

/** A parsed profile header and tag table. */
export interface IccInfo {
  version: number;
  cls: string;
  space: string;
  pcs: string;
  tags: Map<string, Tag>;
}

export function iccInfo(p: Uint8Array): IccInfo | null {
  if (p.length < 132 || sig(p, 36) !== "acsp") return null;
  const n = Math.min(u32(p, 128), 1000);
  const tags = new Map<string, Tag>();
  for (let i = 0; i < n; i++) {
    const e = 132 + i * 12;
    if (e + 12 > p.length) break;
    const at = u32(p, e + 4), size = u32(p, e + 8);
    if (at + size <= p.length && size >= 8) tags.set(sig(p, e), { sig: sig(p, at), at, size });
  }
  return { version: p[8], cls: sig(p, 12), space: sig(p, 16), pcs: sig(p, 20), tags };
}

// ───────── curves ─────────

type Curve = (x: number) => number;

const identity: Curve = (x) => x;

/** A sampled table (0..1 in, 0..1 out), linear between samples. */
function tableCurve(t: Float64Array): Curve {
  const n = t.length - 1;
  if (n < 1) return identity;
  return (x) => {
    const f = Math.max(0, Math.min(1, x)) * n;
    const i = Math.min(n - 1, Math.floor(f));
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  };
}

/** A 'curv' or 'para' element at o: the curve and its size (padded to 4 bytes). */
function readCurve(p: Uint8Array, o: number): [Curve, number] {
  need(o + 12 <= p.length, "curve");
  const type = sig(p, o);
  if (type === "curv") {
    const n = u32(p, o + 8);
    need(n <= MAX_CURVE && o + 12 + n * 2 <= p.length, "curv");
    const size = (12 + n * 2 + 3) & ~3;
    if (n === 0) return [identity, size];
    if (n === 1) {
      const g = u16(p, o + 12) / 256;
      return [(x) => ppow(Math.max(0, x), g), size];
    }
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = u16(p, o + 12 + i * 2) / 65535;
    return [tableCurve(t), size];
  }
  need(type === "para", "curve type");
  const fn = u16(p, o + 8);
  const count = [1, 3, 4, 5, 7][fn];
  need(count !== undefined && o + 12 + count * 4 <= p.length, "para");
  const v = Array.from({ length: count }, (_, i) => s15(p, o + 12 + i * 4));
  const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = v;
  const pw = (x: number) => (x > 0 ? ppow(x, g) : 0);
  let curve: Curve;
  switch (fn) {
    case 0:
      curve = (x) => pw(x);
      break;
    case 1:
      curve = (x) => (x >= -b / a ? pw(a * x + b) : 0);
      break;
    case 2:
      curve = (x) => (x >= -b / a ? pw(a * x + b) + c : c);
      break;
    case 3:
      curve = (x) => (x >= d ? pw(a * x + b) : c * x);
      break;
    default:
      curve = (x) => (x >= d ? pw(a * x + b) + e : c * x + f);
  }
  return [(x) => Math.max(0, Math.min(1, curve(x))), (12 + count * 4 + 3) & ~3];
}

function readCurves(p: Uint8Array, o: number, n: number): Curve[] {
  const out: Curve[] = [];
  for (let i = 0; i < n; i++) {
    const [c, size] = readCurve(p, o);
    out.push(c);
    o += size;
  }
  return out;
}

const curvesStage = (cs: Curve[]): Stage => (v) => {
  const o = new Float64Array(cs.length);
  for (let i = 0; i < cs.length; i++) o[i] = cs[i](v[i]);
  return o;
};

// ───────── multi-dimensional table ─────────

/**
 * A colour lookup table: `grid[d]` points on input d (first input varies slowest), `outs` outputs, values 0..1.
 * Three inputs: tetrahedral; more: linear on the first, the rest recursively (as Little CMS does for four); fewer:
 * multilinear.
 */
function clutStage(grid: number[], outs: number, data: Float32Array): Stage {
  const nin = grid.length;
  const stride = new Array<number>(nin);
  let s = outs;
  for (let d = nin - 1; d >= 0; d--) {
    stride[d] = s;
    s *= grid[d];
  }
  const out = new Float64Array(outs);
  // tetrahedral on three inputs: the fractions sorted, a walk along the cell's edges in that order
  const eval3 = (base: number, v: Vec, d0: number, res: Float64Array) => {
    const ax = [0, 1, 2].map((j) => {
      const g = grid[d0 + j] - 1;
      const f = Math.max(0, Math.min(1, v[d0 + j])) * g;
      const i = Math.min(g - 1, Math.floor(f));
      return { i, r: f - i, s: stride[d0 + j] };
    });
    let X = base;
    for (const a of ax) X += a.i * a.s;
    ax.sort((p, q) => q.r - p.r);
    const X1 = X + ax[0].s, X2 = X1 + ax[1].s, X3 = X2 + ax[2].s;
    const [r1, r2, r3] = [ax[0].r, ax[1].r, ax[2].r];
    for (let k = 0; k < outs; k++) res[k] = (1 - r1) * data[X + k] + (r1 - r2) * data[X1 + k] + (r2 - r3) * data[X2 + k] + r3 * data[X3 + k];
  };
  const evalN = (base: number, v: Vec, d0: number, res: Float64Array) => {
    const left = nin - d0;
    if (left === 3) return eval3(base, v, d0, res);
    const g = grid[d0] - 1;
    const f = Math.max(0, Math.min(1, v[d0])) * g;
    const i = g > 0 ? Math.min(g - 1, Math.floor(f)) : 0;
    const t = g > 0 ? f - i : 0;
    const a = new Float64Array(outs), b = new Float64Array(outs);
    if (left === 1) {
      for (let k = 0; k < outs; k++) {
        const x = data[base + i * stride[d0] + k];
        res[k] = g > 0 ? x + (data[base + (i + 1) * stride[d0] + k] - x) * t : x;
      }
      return;
    }
    evalN(base + i * stride[d0], v, d0 + 1, a);
    if (g > 0) evalN(base + (i + 1) * stride[d0], v, d0 + 1, b);
    for (let k = 0; k < outs; k++) res[k] = g > 0 ? a[k] + (b[k] - a[k]) * t : a[k];
  };
  return (v) => {
    evalN(0, v, 0, out);
    return Float64Array.from(out);
  };
}

const matrixStage = (m: number[], off: number[]): Stage => (v) =>
  Float64Array.of(m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + off[0], m[3] * v[0] + m[4] * v[1] + m[5] * v[2] + off[1], m[6] * v[0] + m[7] * v[1] + m[8] * v[2] + off[2]);

/** How a table's connection-space values are encoded (normalized 0..1 at its end). */
type PcsEnc = "lab2" | "lab4" | "xyz";

interface Lut {
  nin: number;
  nout: number;
  run: Stage;
  enc: PcsEnc;
}

/** A lut8 / lut16 / lutAtoB / lutBtoA tag at o. `pcs`: the profile's connection space; Lab in v2 tables of 16 bits. */
function readLut(p: Uint8Array, o: number, pcs: string): Lut {
  const type = sig(p, o);
  const nin = p[o + 8], nout = p[o + 9];
  need(nin >= 1 && nin <= 8 && nout >= 1 && nout <= 8, "channels");
  if (type === "mft1" || type === "mft2") {
    const wide = type === "mft2";
    const g = p[o + 10];
    need(g >= 2, "grid");
    const mat = Array.from({ length: 9 }, (_, i) => s15(p, o + 12 + i * 4));
    const n = wide ? u16(p, o + 48) : 256, m = wide ? u16(p, o + 50) : 256;
    need(n >= 2 && m >= 2, "table entries");
    const B = wide ? 2 : 1, max = wide ? 65535 : 255;
    let q = o + (wide ? 52 : 48);
    const rd = (at: number) => (wide ? u16(p, at) : p[at]) / max;
    const table = <T extends Float64Array | Float32Array>(len: number, make: (n: number) => T): T => {
      need(len <= MAX_CLUT && q + len * B <= p.length, "lut size");
      const t = make(len);
      for (let i = 0; i < len; i++) t[i] = rd(q + i * B);
      q += len * B;
      return t;
    };
    const f64 = (k: number) => new Float64Array(k), f32 = (k: number) => new Float32Array(k);
    const ins: Curve[] = [];
    for (let c = 0; c < nin; c++) ins.push(tableCurve(table(n, f64)));
    const clut = table(ipow(g, nin) * nout, f32);
    const outsC: Curve[] = [];
    for (let c = 0; c < nout; c++) outsC.push(tableCurve(table(m, f64)));
    const stages: Stage[] = [];
    // the matrix applies only to XYZ input (a B2A table of an XYZ profile)
    if (nin === 3 && pcs === "XYZ " && !(mat[0] === 1 && mat[4] === 1 && mat[8] === 1 && mat[1] === 0 && mat[2] === 0 && mat[3] === 0 && mat[5] === 0 && mat[6] === 0 && mat[7] === 0)) stages.push(matrixStage(mat, [0, 0, 0]));
    stages.push(curvesStage(ins), clutStage(new Array(nin).fill(g), nout, clut), curvesStage(outsC));
    return { nin, nout, run: (v) => stages.reduce((x, s) => s(x), v), enc: pcs === "XYZ " ? "xyz" : wide ? "lab2" : "lab4" };
  }
  need(type === "mAB " || type === "mBA ", "lut type");
  const atob = type === "mAB ";
  const offB = u32(p, o + 12), offMat = u32(p, o + 16), offM = u32(p, o + 20), offClut = u32(p, o + 24), offA = u32(p, o + 28);
  // B curves sit on the connection-space side: as many as its channels
  const pcsN = atob ? nout : nin, devN = atob ? nin : nout;
  const B = offB ? curvesStage(readCurves(p, o + offB, pcsN)) : null;
  const M = offM ? curvesStage(readCurves(p, o + offM, pcsN)) : null;
  const A = offA ? curvesStage(readCurves(p, o + offA, devN)) : null;
  let mat: Stage | null = null;
  if (offMat) {
    const a = o + offMat;
    need(a + 48 <= p.length, "matrix");
    const v = Array.from({ length: 12 }, (_, i) => s15(p, a + i * 4));
    mat = matrixStage(v.slice(0, 9), v.slice(9));
  }
  let clut: Stage | null = null;
  if (offClut) {
    const a = o + offClut;
    const cin = nin, cout = nout;
    need(a + 20 <= p.length, "clut");
    const grid = Array.from({ length: cin }, (_, i) => p[a + i]);
    need(grid.every((g) => g >= 2), "grid");
    const prec = p[a + 16];
    need(prec === 1 || prec === 2, "precision");
    const len = grid.reduce((x, g) => x * g, 1) * cout;
    need(len <= MAX_CLUT && a + 20 + len * prec <= p.length, "clut size");
    const t = new Float32Array(len);
    for (let i = 0; i < len; i++) t[i] = prec === 2 ? u16(p, a + 20 + i * 2) / 65535 : p[a + 20 + i] / 255;
    clut = clutStage(grid, cout, t);
  }
  // without a table the channel count cannot change (the curves on either side are per channel)
  need(clut || nin === nout, "no clut");
  const order = (atob ? [A, clut, M, mat, B] : [B, mat, M, clut, A]).filter((s): s is Stage => !!s);
  const clip: Stage = (v) => v.map((x) => Math.max(0, Math.min(1, x)));
  return { nin, nout, run: (v) => order.reduce((x, s) => clip(s(x)), v), enc: pcs === "XYZ " ? "xyz" : "lab4" };
}

// ───────── connection space ─────────

const D50 = [0.9642, 1, 0.8249];

// (6/29)² and (6/29)³ by multiplication: ** is not exact everywhere
const D2 = (6 / 29) * (6 / 29), D3 = D2 * (6 / 29);

function labToXyz(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const f = (t: number) => (t > 6 / 29 ? t * t * t : 3 * D2 * (t - 4 / 29));
  return [D50[0] * f(fx), D50[1] * f(fy), D50[2] * f(fz)];
}

function xyzToLab(X: number, Y: number, Z: number): [number, number, number] {
  const f = (t: number) => (t > D3 ? ppow(t, 1 / 3) : t / (3 * D2) + 4 / 29);
  const fx = f(X / D50[0]), fy = f(Y / D50[1]), fz = f(Z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** A table's normalized connection-space output → XYZ (D50). */
function decodePcs(v: Vec, enc: PcsEnc): [number, number, number] {
  if (enc === "xyz") return [(v[0] * 65535) / 32768, (v[1] * 65535) / 32768, (v[2] * 65535) / 32768];
  if (enc === "lab2") return labToXyz((v[0] * 65535 * 100) / 65280, (v[1] * 65535) / 256 - 128, (v[2] * 65535) / 256 - 128);
  return labToXyz(v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128);
}

/** XYZ (D50) → a table's normalized connection-space input. */
function encodePcs(X: number, Y: number, Z: number, enc: PcsEnc): Vec {
  const c = (x: number) => Math.max(0, Math.min(1, x));
  if (enc === "xyz") return Float64Array.of(c((X * 32768) / 65535), c((Y * 32768) / 65535), c((Z * 32768) / 65535));
  const [L, a, b] = xyzToLab(X, Y, Z);
  if (enc === "lab2") return Float64Array.of(c((L * 65280) / 100 / 65535), c(((a + 128) * 256) / 65535), c(((b + 128) * 256) / 65535));
  return Float64Array.of(c(L / 100), c((a + 128) / 255), c((b + 128) / 255));
}

// sRGB from XYZ relative to D50 (the ICC sRGB profile's Bradford-adapted primaries) and back
const TO_RGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];
const TO_XYZ = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
const encodeSrgb = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * ppow(l, 1 / 2.4) - 0.055);
const decodeSrgb = (v: number) => (v <= 0.04045 ? v / 12.92 : ppow((v + 0.055) / 1.055, 2.4));

// ───────── the profile as a transform ─────────

/** A CMYK profile ready to use (`cmykXform`): both directions on 8-bit stored values (255 = no ink). */
export interface CmykXform {
  /** the profile's description */
  readonly name: string;
  /** stored C, M, Y, K (255 = no ink) → sRGB, written to out[o..o+2] */
  rgb(c: number, m: number, y: number, k: number, out: Uint8Array | Uint8ClampedArray, o: number): void;
  /** sRGB → stored C, M, Y, K (255 = no ink), written to out[o..o+3] */
  cmyk(r: number, g: number, b: number, out: Uint8Array, o: number): void;
  /** the profile evaluated directly, without the table (tests: the table's error) */
  exact(c: number, m: number, y: number, k: number): [number, number, number];
}

interface Profile {
  name: string;
  toPcs: Lut;
  fromPcs: Lut;
  /** black point of the colorimetric table (XYZ), for compensation */
  black: [number, number, number];
}

function loadProfile(p: Uint8Array, name: string): Profile {
  const info = iccInfo(p);
  need(info && info.space === "CMYK" && (info.pcs === "Lab " || info.pcs === "XYZ "), "not a CMYK profile");
  const lut = (tag: string, nin: number) => {
    const t = info!.tags.get(tag);
    if (!t) return null;
    const l = readLut(p, t.at, info!.pcs);
    return l.nin === nin && l.nout === (nin === 4 ? 3 : 4) ? l : null;
  };
  const toPcs = lut("A2B1", 4) ?? lut("A2B0", 4);
  need(toPcs, "no A2B table");
  const fromPcs = lut("B2A1", 3) ?? lut("B2A0", 3);
  // the way back is needed too: an edited pixel's inks must read back as its colour (a printer profile always has
  // B2A0; one without cannot separate, and the colour-unmanaged split would show differently through A2B)
  need(fromPcs, "no B2A table");
  // Black point (Adobe's / Little CMS's method for a printer profile, relative colorimetric): the darkest colour the
  // profile makes — Lab 0 through the perceptual separation and back through the colorimetric table — as a neutral.
  const toDevice = lut("B2A0", 3) ?? fromPcs;
  let black: [number, number, number];
  const darkest = toDevice ? toDevice.run(encodePcs(0, 0, 0, toDevice.enc)) : Float64Array.of(1, 1, 1, 1);
  const [, Yb] = decodePcs(toPcs!.run(darkest), toPcs!.enc);
  let Lb = xyzToLab(0, Math.max(0, Yb), 0)[0];
  Lb = Math.min(50, Math.max(0, Lb));
  black = labToXyz(Lb, 0, 0);
  need(black.every(Number.isFinite), "black point");
  return { name, toPcs: toPcs!, fromPcs: fromPcs!, black };
}

/** Grid of the CMYK → RGB table: 18 points a channel, 15 levels apart. */
const G = 18, STEP = 15;
/** The table's linear values in units of 1 / LS (16 steps per GAMMA step), out-of-gamut values clamped to ±LMAX. */
const LS = 65535 * 16, LMAX = 64;
/** Grid of the RGB → CMYK table. */
const GI = 33;

function buildXform(pr: Profile): CmykXform {
  const [bx, by, bz] = pr.black;
  const wx = D50[0], wy = D50[1], wz = D50[2];
  // black point compensation onto sRGB's black (0): a scale in XYZ (Little CMS's form with a zero destination black)
  const sx = wx / (wx - bx), sy = wy / (wy - by), sz = wz / (wz - bz);
  /** inks → linear sRGB, not clipped (what the table holds: linear in XYZ, so interpolating it follows the profile) */
  const toLinear = (inks: Vec): [number, number, number] => {
    const [X0, Y0, Z0] = decodePcs(pr.toPcs.run(inks), pr.toPcs.enc);
    const X = (X0 - bx) * sx, Y = (Y0 - by) * sy, Z = (Z0 - bz) * sz;
    return [TO_RGB[0] * X + TO_RGB[1] * Y + TO_RGB[2] * Z, TO_RGB[3] * X + TO_RGB[4] * Y + TO_RGB[5] * Z, TO_RGB[6] * X + TO_RGB[7] * Y + TO_RGB[8] * Z];
  };
  const toRgb = (inks: Vec) => toLinear(inks).map((l) => 255 * encodeSrgb(Math.max(0, Math.min(1, l)))) as [number, number, number];
  // linear 0..1 (in 1/65535 steps) → 8-bit sRGB, clipped
  const GAMMA = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) GAMMA[i] = Math.round(255 * encodeSrgb(i / 65535));
  // forward table: [C][M][Y][K] → linear RGB in units of 1 / LS, rounded to whole numbers (K innermost: the two K
  // slices of a corner are neighbours in memory); inks 0..1 = 1 − stored / 255 — built on first use. Whole numbers
  // and whole-number weights below: the interpolation is exact, its one rounding defined.
  let fwd: Int32Array | null = null;
  const build = () => {
    const t = new Int32Array(G * G * G * G * 3);
    const v = new Float64Array(4);
    let o = 0;
    for (let c = 0; c < G; c++)
      for (let m = 0; m < G; m++)
        for (let y = 0; y < G; y++)
          for (let k = 0; k < G; k++) {
            v[0] = (c * STEP) / 255;
            v[1] = (m * STEP) / 255;
            v[2] = (y * STEP) / 255;
            v[3] = (k * STEP) / 255;
            const rgb = toLinear(v);
            need(Number.isFinite(rgb[0] + rgb[1] + rgb[2]), "A2B value");
            for (let j = 0; j < 3; j++) t[o++] = Math.round(Math.max(-LMAX, Math.min(LMAX, rgb[j])) * LS);
          }
    return t;
  };
  // ink level (0..255) → grid cell and the fraction in fifteenths (exact: the grid is 15 levels apart)
  const cell = new Uint8Array(256), frac = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    cell[v] = Math.min(G - 2, Math.floor(v / STEP));
    frac[v] = v - cell[v] * STEP;
  }
  const SK = 3, SY = G * 3, SM = G * G * 3, SC = G * G * G * 3;
  // stored value (255 = no ink) → offset of its cell on each axis, and the fraction (0..15)
  const offC = new Int32Array(256), offM = new Int32Array(256), offY = new Int32Array(256), offK = new Int32Array(256), fr = new Uint8Array(256);
  for (let s = 0; s < 256; s++) {
    const v = 255 - s;
    offC[s] = cell[v] * SC;
    offM[s] = cell[v] * SM;
    offY[s] = cell[v] * SY;
    offK[s] = cell[v] * SK;
    fr[s] = frac[v];
  }
  /** an interpolated value's scale: table units × 15 (C·M·Y weights) × 15 (K weights) */
  const W = LS * STEP * STEP;
  /** linear 1 / 65535 (a GAMMA step) in interpolated units: 3600 */
  const Q = W / 65535;
  const ALL = SC + SM + SY;
  /**
   * One colour (stored values) → sRGB at out[o..o+2]: tetrahedral on C·M·Y in the two K slices around k, linear
   * between them. The tetrahedron as its three corner offsets from the cell's origin and the sorted fractions.
   */
  // results by colour, direct-mapped: artwork and flat areas repeat colours, a hit costs a fraction of a lookup
  const CACHE = 1 << 15;
  const keys = new Int32Array(CACHE).fill(-1), vals = new Uint8Array(CACHE * 3);
  // (key −1 is C = M = Y = K = 255, no ink: its slot is filled at the start below)
  let fresh = true;
  const rgb = (c: number, m: number, y: number, k: number, out: Uint8Array | Uint8ClampedArray, o: number) => {
    if (fresh) {
      fresh = false;
      const h0 = Math.imul(-1, 0x9e3779b1) >>> 17;
      raw(255, 255, 255, 255, vals, h0 * 3);
    }
    const key = (c << 24) | (m << 16) | (y << 8) | k;
    const h = Math.imul(key, 0x9e3779b1) >>> 17;
    if (keys[h] === key) {
      out[o] = vals[h * 3];
      out[o + 1] = vals[h * 3 + 1];
      out[o + 2] = vals[h * 3 + 2];
      return;
    }
    raw(c, m, y, k, vals, h * 3);
    keys[h] = key;
    out[o] = vals[h * 3];
    out[o + 1] = vals[h * 3 + 1];
    out[o + 2] = vals[h * 3 + 2];
  };
  const raw = (c: number, m: number, y: number, k: number, out: Uint8Array | Uint8ClampedArray, o: number) => {
    const t = fwd ?? (fwd = build());
    const X0 = offK[k] + offC[c] + offM[m] + offY[y];
    const rx = fr[c], ry = fr[m], rz = fr[y], rk = fr[k];
    let o1: number, o2: number, f1: number, f2: number, f3: number;
    if (rx >= ry) {
      if (ry >= rz) (o1 = SC), (o2 = SC + SM), (f1 = rx), (f2 = ry), (f3 = rz);
      else if (rx >= rz) (o1 = SC), (o2 = SC + SY), (f1 = rx), (f2 = rz), (f3 = ry);
      else (o1 = SY), (o2 = SC + SY), (f1 = rz), (f2 = rx), (f3 = ry);
    } else if (rx >= rz) (o1 = SM), (o2 = SC + SM), (f1 = ry), (f2 = rx), (f3 = rz);
    else if (ry >= rz) (o1 = SM), (o2 = SM + SY), (f1 = ry), (f2 = rz), (f3 = rx);
    else (o1 = SY), (o2 = SM + SY), (f1 = rz), (f2 = ry), (f3 = rx);
    // whole-number weights summing to 15 (and 15 for K): every product and sum below is an exact integer (< 2^40)
    const w0 = STEP - f1, w1 = f1 - f2, w2 = f2 - f3;
    const A = X0 + o1, B = X0 + o2, D = X0 + ALL;
    let l0 = w0 * t[X0] + w1 * t[A] + w2 * t[B] + f3 * t[D];
    let l1 = w0 * t[X0 + 1] + w1 * t[A + 1] + w2 * t[B + 1] + f3 * t[D + 1];
    let l2 = w0 * t[X0 + 2] + w1 * t[A + 2] + w2 * t[B + 2] + f3 * t[D + 2];
    if (rk > 0) {
      const X1 = X0 + SK, A1 = A + SK, B1 = B + SK, D1 = D + SK, wk = STEP - rk;
      l0 = l0 * wk + (w0 * t[X1] + w1 * t[A1] + w2 * t[B1] + f3 * t[D1]) * rk;
      l1 = l1 * wk + (w0 * t[X1 + 1] + w1 * t[A1 + 1] + w2 * t[B1 + 1] + f3 * t[D1 + 1]) * rk;
      l2 = l2 * wk + (w0 * t[X1 + 2] + w1 * t[A1 + 2] + w2 * t[B1 + 2] + f3 * t[D1 + 2]) * rk;
    } else {
      l0 *= STEP;
      l1 *= STEP;
      l2 *= STEP;
    }
    // to the nearest 1 / 65535 (halves up): floor of an exact quotient of whole numbers
    out[o] = l0 <= 0 ? 0 : l0 >= W ? 255 : GAMMA[Math.floor((l0 + Q / 2) / Q)];
    out[o + 1] = l1 <= 0 ? 0 : l1 >= W ? 255 : GAMMA[Math.floor((l1 + Q / 2) / Q)];
    out[o + 2] = l2 <= 0 ? 0 : l2 >= W ? 255 : GAMMA[Math.floor((l2 + Q / 2) / Q)];
  };
  // inverse table: [R][G][B] → stored C, M, Y, K (floats) through the profile's separation; built on first use
  let inv: Float32Array | null = null;
  const buildInv = () => {
    const t = new Float32Array(GI * GI * GI * 4);
    const from = pr.fromPcs;
    let o = 0;
    for (let r = 0; r < GI; r++)
      for (let g = 0; g < GI; g++)
        for (let b = 0; b < GI; b++) {
          const lr = decodeSrgb(r / (GI - 1)), lg = decodeSrgb(g / (GI - 1)), lb = decodeSrgb(b / (GI - 1));
          const X = TO_XYZ[0] * lr + TO_XYZ[1] * lg + TO_XYZ[2] * lb, Y = TO_XYZ[3] * lr + TO_XYZ[4] * lg + TO_XYZ[5] * lb, Z = TO_XYZ[6] * lr + TO_XYZ[7] * lg + TO_XYZ[8] * lb;
          // undo the compensation, then the profile's own separation
          const ink = from.run(encodePcs(X / sx + bx, Y / sy + by, Z / sz + bz, from.enc));
          need(ink.length === 4 && Number.isFinite(ink[0] + ink[1] + ink[2] + ink[3]), "B2A value");
          for (let i = 0; i < 4; i++) t[o++] = 255 * (1 - ink[i]);
        }
    return t;
  };
  const S = (GI - 1) / 255;
  const cmyk = (r: number, g: number, b: number, out: Uint8Array, o: number) => {
    const t = (inv ??= buildInv());
    const fr = r * S, fg = g * S, fb = b * S;
    const ir = Math.min(GI - 2, Math.floor(fr)), ig = Math.min(GI - 2, Math.floor(fg)), ib = Math.min(GI - 2, Math.floor(fb));
    const tr = fr - ir, tg = fg - ig, tb = fb - ib;
    const B0 = ((ir * GI + ig) * GI + ib) * 4, SR = GI * GI * 4, SG = GI * 4, SB = 4;
    for (let i = 0; i < 4; i++) {
      const at = (d: number) => t[B0 + d + i];
      const c00 = at(0) + (at(SB) - at(0)) * tb, c01 = at(SG) + (at(SG + SB) - at(SG)) * tb;
      const c10 = at(SR) + (at(SR + SB) - at(SR)) * tb, c11 = at(SR + SG) + (at(SR + SG + SB) - at(SR + SG)) * tb;
      const c0 = c00 + (c01 - c00) * tg, c1 = c10 + (c11 - c10) * tg;
      out[o + i] = Math.max(0, Math.min(255, Math.round(c0 + (c1 - c0) * tr)));
    }
  };
  const exact = (c: number, m: number, y: number, k: number) => toRgb(Float64Array.of(1 - c / 255, 1 - m / 255, 1 - y / 255, 1 - k / 255));
  return { name: pr.name, rgb, cmyk, exact };
}

/** Profiles made into transforms, by a key of all their bytes (a document's profile is read once per file). */
const xforms = new Map<string, CmykXform | null>();

function keyOf(p: Uint8Array): string {
  // every byte: two versions of a profile differing only inside a table must not share a transform (≈ 1 ms / MB)
  let h = 2166136261, g = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = 0; i < p.length; i++) {
    h = Math.imul(h ^ p[i], 16777619);
    g = Math.imul(g ^ p[i], 0x01000193) + i;
  }
  return `${p.length}:${h >>> 0}:${g >>> 0}`;
}

/**
 * A CMYK ICC profile as a transform, or null when it is not one this can evaluate (not CMYK, no A2B table, a damaged
 * or unsupported table) — the caller then keeps the colour-unmanaged conversion and says so.
 */
export function cmykXform(p: Uint8Array | null | undefined, name = ""): CmykXform | null {
  if (!p || p.length < 132) return null;
  const key = keyOf(p);
  if (xforms.has(key)) return xforms.get(key)!;
  let x: CmykXform | null = null;
  try {
    x = buildXform(loadProfile(p, name));
    // both tables built here, through the whole pipeline (a broken table throws or gives NaN here, not while drawing
    // or saving)
    const o = new Uint8Array(4);
    x.rgb(0, 128, 255, 40, o, 0);
    x.cmyk(0, 128, 255, o, 0);
  } catch {
    x = null;
  }
  if (xforms.size > 8) xforms.delete(xforms.keys().next().value!);
  xforms.set(key, x);
  return x;
}

/** Tests: forget the transforms built so far (tests/psd/iccPortable.test.ts builds them again under other conditions). */
export function forgetCmykXforms() {
  xforms.clear();
}

/** Name the default profile goes by in notices and transforms. */
export const DEFAULT_CMYK_NAME = "FOGRA39";

let defaultBytes: Uint8Array | null = null;

/**
 * The CMYK profile used for a CMYK document that carries none, or carries one this cannot evaluate — Photoshop uses
 * its working CMYK there, which the file does not say. Shipped: FOGRA39L Coated (OpenICC / colord, zlib / CC0;
 * characterization data FOGRA39L by Fogra), reduced to the tables display and separation use
 * (scripts/make-default-cmyk-icc.mjs; docs/legal/CMYK_PROFILES.md). The bytes are decoded on first use only (a
 * document that needs them); the transform is built from them by cmykXform like any embedded profile.
 */
export function defaultCmykProfile(): { bytes: Uint8Array; name: string } | null {
  if (!defaultBytes) {
    const s = atob(DEFAULT_CMYK_ICC_HEAD);
    const head = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) head[i] = s.charCodeAt(i);
    try {
      defaultBytes = unpackIcc(DEFAULT_CMYK_ICC_SIZE, head, DEFAULT_CMYK_ICC_GRID);
    } catch {
      return null; // (a build that damaged the module: the colour-unmanaged conversion, as without a default)
    }
  }
  return { bytes: defaultBytes, name: DEFAULT_CMYK_NAME };
}

/** The grid digits' characters (scripts/make-default-cmyk-icc.mjs GRID_ALPHABET): printable ASCII but " \ ` $. */
const GRID_DIGIT = (() => {
  const t = new Int8Array(128).fill(-1);
  let n = 0;
  for (let c = 32; c < 127; c++) if (!'"\\`$'.includes(String.fromCharCode(c))) t[c] = n++;
  return t;
})();

/**
 * The profile file back from the generator's packing (scripts/make-default-cmyk-icc.mjs pack): `head` is the file
 * without its lut16 grids, curve values differenced; `grid` the grid values (units of 16) as Lorenzo-predicted
 * residuals in base-45 digits. Exact — tests/psd/defaultCmyk.test.ts compares the result with the .icc file.
 */
function unpackIcc(size: number, head: Uint8Array, grid: string): Uint8Array {
  const b = new Uint8Array(size);
  const w = (o: number) => (b[o] << 8) | b[o + 1];
  const put = (o: number, v: number) => ((b[o] = (v >> 8) & 255), (b[o + 1] = v & 255));
  const bad = () => new Error("default CMYK profile: damaged packing");
  const u32 = (o: number) => ((head[o] << 24) >>> 0) + (head[o + 1] << 16) + u16(head, o + 2);
  // the tables in file order, from the tag table at the front (no grid lies before it)
  const tabs = new Set<number>();
  for (let i = 0, n = u32(128); i < n; i++) if (/^(A2B0|B2A0)$/.test(sig(head, 132 + i * 12))) tabs.add(u32(136 + i * 12));
  const H = 45;
  let hs = 0, d = 0, sp = 0;
  const curves: [number, number][] = [];
  for (const at of [...tabs].sort((x, y) => x - y)) {
    const ha = at - (d - hs); // the table's place in head
    const nin = head[ha + 8], nout = head[ha + 9], g = head[ha + 10], ie = u16(head, ha + 48), oe = u16(head, ha + 50);
    const c0 = at + 52 + nin * ie * 2, cells = ipow(g, nin), n = cells * nout, c1 = c0 + n * 2;
    if (nin < 1 || nin > 4 || c1 > size) throw bad();
    b.set(head.subarray(hs, hs + (c0 - d)), d);
    hs += c0 - d;
    curves.push([at + 52, c0], [c1, c1 + nout * oe * 2]);
    // n-dimensional Lorenzo prediction: per set of axes past their first point, the neighbours' offsets and signs
    const stride = Array.from({ length: nin }, (_, k) => nout * ipow(g, nin - 1 - k));
    const terms: number[][] = [];
    for (let mask = 0; mask < 1 << nin; mask++) {
      const t: number[] = [];
      for (let sub = mask; sub; sub = (sub - 1) & mask) {
        let off = 0, c = 0;
        for (let k = 0; k < nin; k++) if ((sub >> k) & 1) (off += stride[k]), c++;
        t.push(off, c & 1 ? 1 : -1);
      }
      terms.push(t);
    }
    const V = new Int32Array(n), idx = new Array<number>(nin).fill(0);
    for (let cell = 0, i = 0; cell < cells; cell++) {
      let mask = 0;
      for (let k = 0; k < nin; k++) if (idx[k] > 0) mask |= 1 << k;
      const t = terms[mask];
      for (let j = 0; j < nout; j++, i++) {
        let p = 0;
        for (let q = 0; q < t.length; q += 2) p += t[q + 1] * V[i - t[q]];
        let z = 0, f = 1, dg: number;
        do {
          if (sp >= grid.length) throw bad();
          dg = GRID_DIGIT[grid.charCodeAt(sp++) & 127];
          if (dg < 0) throw bad();
          z += (dg >= H ? dg - H : dg) * f;
          f *= H;
        } while (dg >= H);
        const v = p + (z & 1 ? -(z + 1) / 2 : z / 2);
        if (v < 0 || v > 4096) throw bad();
        V[i] = v;
        put(c0 + i * 2, Math.min(65535, v * 16));
      }
      for (let k = nin - 1; k >= 0 && ++idx[k] === g; k--) idx[k] = 0;
    }
    d = c1;
  }
  if (sp !== grid.length || head.length - hs !== size - d) throw bad();
  b.set(head.subarray(hs), d);
  for (const [a, z] of curves) for (let o = a + 2; o < z; o += 2) put(o, w(o) + w(o - 2));
  return b;
}
