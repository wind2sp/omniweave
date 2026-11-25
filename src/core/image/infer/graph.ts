// Loom Infer — graph models. The U²-Net file (model.ts) is a fixed conv/pool/up chain; OCR models (text detection and
// line recognition, converted by scripts/convert-ppocr.mjs) need strided / depthwise / transposed conv, attention
// (matmul, softmax, layer norm) and a few shape ops, with dynamic input sizes. Same LWT1 container, meta.format =
// "graph": a flat op list over numbered values, weights by name. Pure TS (no DOM): runs in the image worker and tests.
//
// Hot paths: 1×1 conv (most of PP-LCNetV3's work) is a blocked GEMM, 3×3 stride-1 dense conv reuses the WebAssembly
// SIMD kernel of cpu.ts when available, depthwise conv is a direct loop. Everything else is cheap.

import { halfToFloat } from "./model";
import { convModuleBytes, packConvWeights, type GraphKernel } from "./wasm";

export interface GNode {
  op: string;
  in: (number | string)[];
  out: number[];
  a?: Record<string, any>;
  w?: string;
  b?: string;
  act?: string;
  actA?: [number, number];
  post?: [number, number];
  /** act "prelu": the per-channel slope weight (fused conv + PReLU, Real-ESRGAN) */
  p?: string;
}

export interface GraphMeta {
  model: string;
  format: "graph";
  dtype: "f16" | "i8";
  params: number;
  input: number;
  output: number;
  mean: [number, number, number];
  std: [number, number, number];
  nodes: GNode[];
  weights: Record<string, { shape: number[]; w: [number, number]; s?: [number, number]; f32?: boolean }>;
  /** recognition models: CTC classes 1..n (0 = blank; n+1 = space) */
  dict?: string[];
}

export interface Tensor {
  s: number[];
  d: Float32Array;
  int?: boolean;
}
export type Val = Tensor | Tensor[];

export interface GraphModel {
  meta: GraphMeta;
  w: Map<string, Tensor>;
  lastUse: Map<number, number>;
  bytes: number;
}

let h2f: Float32Array | null = null;
function halfTable() {
  if (!h2f) {
    h2f = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) h2f[i] = halfToFloat(i);
  }
  return h2f;
}

/** True for an LWT1 file holding a graph model. */
export function isGraphFile(bytes: Uint8Array): boolean {
  if (bytes.length < 8 || bytes[0] !== 0x4c || bytes[1] !== 0x57 || bytes[2] !== 0x54 || bytes[3] !== 0x31) return false;
  const jl = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  return new TextDecoder().decode(bytes.subarray(8, Math.min(8 + jl, 200))).includes('"format":"graph"');
}

/** Limits for model files and the tensors a graph may make. Model files are bundled or downloaded by us, but the
 *  parser still treats them as untrusted input: a malformed file fails with an error, never with a giant allocation. */
export const GRAPH_LIMITS = { header: 32 << 20, nodes: 20000, elems: 1 << 27, rank: 8 };

const isIdx = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const bad = (what: string): never => {
  throw new Error("LWT1 model: " + what);
};

/** Checked shape: non-negative integers, at most GRAPH_LIMITS.elems elements. */
function checkShape(s: unknown, what: string): number {
  if (!Array.isArray(s) || s.length > GRAPH_LIMITS.rank || !s.every(isIdx)) bad("bad shape of " + what);
  const n = (s as number[]).reduce((a, b) => a * b, 1);
  if (n > GRAPH_LIMITS.elems) bad("tensor too large: " + what);
  return n;
}

export function parseGraph(bytes: Uint8Array): GraphModel {
  if (bytes.length < 8 || bytes[0] !== 0x4c || bytes[1] !== 0x57 || bytes[2] !== 0x54 || bytes[3] !== 0x31) throw new Error("LWT1 model expected");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jl = dv.getUint32(4, true);
  if (jl > bytes.length - 8 || jl > GRAPH_LIMITS.header) bad("header length");
  let meta: GraphMeta;
  try {
    meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jl))) as GraphMeta;
  } catch {
    return bad("header is not JSON");
  }
  if (!meta || typeof meta !== "object" || meta.format !== "graph") throw new Error("graph model expected");
  if (!Array.isArray(meta.nodes) || meta.nodes.length > GRAPH_LIMITS.nodes) bad("node list");
  if (!isIdx(meta.input) || !isIdx(meta.output)) bad("input / output");
  if (!meta.weights || typeof meta.weights !== "object" || Array.isArray(meta.weights)) bad("weights");
  for (const k of ["mean", "std"] as const) if (!Array.isArray(meta[k]) || meta[k].length !== 3 || !meta[k].every(Number.isFinite)) bad(k);
  if (meta.dict !== undefined && (!Array.isArray(meta.dict) || !meta.dict.every((c) => typeof c === "string"))) bad("dict");
  const base = 8 + jl;
  const at = (o: number, n: number) => {
    if (!isIdx(o) || !isIdx(n) || base + o + n > bytes.length) throw new Error("LWT1 model truncated");
    return bytes.byteOffset + base + o;
  };
  const tab = halfTable();
  const w = new Map<string, Tensor>();
  for (const [name, m] of Object.entries(meta.weights)) {
    if (!m || !Array.isArray(m.w) || m.w.length !== 2 || !isIdx(m.w[0]) || !isIdx(m.w[1])) bad("weight " + name);
    const n = m.w[1];
    if (checkShape(m.shape, name) !== n) bad("weight size of " + name);
    let d: Float32Array;
    if (m.f32) d = new Float32Array(bytes.buffer.slice(at(m.w[0], n * 4), at(m.w[0], n * 4) + n * 4));
    else if (m.s) {
      if (!Array.isArray(m.s) || !isIdx(m.s[0]) || !isIdx(m.s[1]) || m.s[1] < 1 || n % m.s[1]) bad("weight scales of " + name);
      const q = new Int8Array(bytes.buffer, at(m.w[0], n), n);
      const sc = new Float32Array(bytes.buffer.slice(at(m.s[0], m.s[1] * 4), at(m.s[0], m.s[1] * 4) + m.s[1] * 4));
      const per = n / m.s[1];
      d = new Float32Array(n);
      for (let i = 0; i < n; i++) d[i] = q[i] * sc[(i / per) | 0];
    } else {
      const h = new Uint16Array(bytes.buffer.slice(at(m.w[0], n * 2), at(m.w[0], n * 2) + n * 2));
      d = new Float32Array(n);
      for (let i = 0; i < n; i++) d[i] = tab[h[i]];
    }
    // NaN / ±Inf weights would turn every output into NaN without an error. Weights below 1e-20 (the converted
    // PP-OCR files have a few thousand, down to 1e-43 — int8 channel scales of dead channels) are flushed to zero:
    // their products with activations land in the subnormal range, and every subnormal result takes a microcode
    // assist on x86 (one 1×1 conv of the detector ran 20–40× slower). A term below 1e-20·|x| is far under the last
    // bit of any sum it is part of.
    for (let i = 0; i < n; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) bad("non-finite weight in " + name);
      if (v !== 0 && Math.abs(v) < 1e-20) d[i] = 0;
    }
    w.set(name, { s: m.shape, d });
  }
  const lastUse = new Map<number, number>();
  meta.nodes.forEach((n, i) => {
    if (!n || typeof n.op !== "string" || !Array.isArray(n.in) || !Array.isArray(n.out) || !n.out.every(isIdx)) bad("node " + i);
    for (const k of ["w", "b", "p"] as const) if (n[k] !== undefined && (typeof n[k] !== "string" || !w.has(n[k]!))) bad(`node ${i}: weight ${n[k]}`);
    if (n.a !== undefined && (typeof n.a !== "object" || n.a === null)) bad(`node ${i}: attributes`);
    n.in.forEach((x) => {
      if (typeof x === "string") {
        if (!w.has(x.slice(1))) bad(`node ${i}: weight ${x}`);
      } else if (isIdx(x)) lastUse.set(x, i);
      else bad(`node ${i}: input`);
    });
  });
  return { meta, w, lastUse, bytes: bytes.length };
}

// ---------- helpers ----------

const size = (s: number[]) => s.reduce((a, b) => a * b, 1);
/** One object shape for every tensor (monomorphic property access in the hot loops). Every new tensor's shape is
 *  checked (shapes come from model attributes and computed sizes: NaN, negative or huge sizes fail here). */
const T = (s: number[], d?: Float32Array, int?: boolean): Tensor => {
  const n = checkShape(s, "tensor");
  if (d && d.length !== n) bad(`shape [${s}] does not match ${d.length} values`);
  return { s, d: d ?? new Float32Array(n), int: !!int };
};
const ints = (t: Val) => Array.from((t as Tensor).d);

function strides(s: number[]) {
  const st = new Array(s.length).fill(1);
  for (let i = s.length - 2; i >= 0; i--) st[i] = st[i + 1] * s[i + 1];
  return st;
}

/** Elementwise op with NumPy broadcasting. */
const ADD = 0, MUL = 1, SUB = 2;
/** out[i] = x[xo + i·dx] (op) y[yo + i·dy] for i < n — one loop per op so V8 keeps it monomorphic */
function binRow(op: number, od: Float32Array, oo: number, xd: Float32Array, xo: number, dx: number, yd: Float32Array, yo: number, dy: number, n: number) {
  if (op === ADD) for (let i = 0; i < n; i++) od[oo + i] = xd[xo + i * dx] + yd[yo + i * dy];
  else if (op === MUL) for (let i = 0; i < n; i++) od[oo + i] = xd[xo + i * dx] * yd[yo + i * dy];
  else for (let i = 0; i < n; i++) od[oo + i] = xd[xo + i * dx] - yd[yo + i * dy];
}

function binary(a: Tensor, b: Tensor, op: number): Tensor {
  if (a.d.length === b.d.length && a.s.length === b.s.length && a.s.every((v, i) => v === b.s[i])) {
    const o = T(a.s.slice(), undefined, a.int && b.int);
    binRow(op, o.d, 0, a.d, 0, 1, b.d, 0, 1, o.d.length);
    return o;
  }
  if (b.d.length === 1 || a.d.length === 1) {
    const s = a.d.length === 1 && b.d.length !== 1 ? b.s : a.s.length >= b.s.length ? a.s : b.s;
    const o = T(s.slice(), undefined, a.int && b.int);
    binRow(op, o.d, 0, a.d, 0, a.d.length === 1 ? 0 : 1, b.d, 0, b.d.length === 1 ? 0 : 1, o.d.length);
    return o;
  }
  const n = Math.max(a.s.length, b.s.length);
  const pa = [...new Array(n - a.s.length).fill(1), ...a.s], pb = [...new Array(n - b.s.length).fill(1), ...b.s];
  const s = pa.map((v, i) => {
    if (v !== pb[i] && v !== 1 && pb[i] !== 1) throw new Error(`broadcast ${a.s} ${b.s}`);
    return Math.max(v, pb[i]);
  });
  const sa = strides(pa).map((v, i) => (pa[i] === 1 ? 0 : v)), sb = strides(pb).map((v, i) => (pb[i] === 1 ? 0 : v));
  const o = T(s, undefined, a.int && b.int);
  // fast case: channel-wise (… C H W) with the per-channel operand [1,C,1,1]
  const idx = new Array(n).fill(0);
  const last = n - 1, L = s[last];
  const da = sa[last], db = sb[last];
  for (let base = 0; base < o.d.length; base += L) {
    let ia = 0, ib = 0;
    for (let k = 0; k < last; k++) {
      ia += idx[k] * sa[k];
      ib += idx[k] * sb[k];
    }
    binRow(op, o.d, base, a.d, ia, da, b.d, ib, db, L);
    for (let k = last - 1; k >= 0; k--) {
      if (++idx[k] < s[k]) break;
      idx[k] = 0;
    }
  }
  return o;
}

function transpose(x: Tensor, perm: number[]): Tensor {
  const s = perm.map((p) => x.s[p]);
  const st = strides(x.s), os = perm.map((p) => st[p]);
  const o = T(s, undefined, x.int);
  const n = s.length, idx = new Array(n).fill(0);
  const L = s[n - 1], dl = os[n - 1];
  const od = o.d, xd = x.d;
  for (let base = 0; base < od.length; base += L) {
    let src = 0;
    for (let k = 0; k < n - 1; k++) src += idx[k] * os[k];
    for (let i = 0; i < L; i++) od[base + i] = xd[src + i * dl];
    for (let k = n - 2; k >= 0; k--) {
      if (++idx[k] < s[k]) break;
      idx[k] = 0;
    }
  }
  return o;
}

function act(d: Float32Array, kind: string | undefined, a?: [number, number], post?: [number, number]) {
  if (kind === "relu") for (let i = 0; i < d.length; i++) d[i] = d[i] > 0 ? d[i] : 0;
  else if (kind === "relu6") for (let i = 0; i < d.length; i++) d[i] = d[i] > 0 ? (d[i] < 6 ? d[i] : 6) : 0;
  else if (kind === "hardswish")
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      d[i] = v <= -3 ? 0 : v >= 3 ? v : (v * (v + 3)) / 6;
    }
  else if (kind === "swish") for (let i = 0; i < d.length; i++) d[i] = d[i] / (1 + Math.exp(-d[i]));
  else if (kind === "sigmoid") for (let i = 0; i < d.length; i++) d[i] = 1 / (1 + Math.exp(-d[i]));
  else if (kind === "hardsigmoid") {
    const [sl, of] = a ?? [1 / 6, 0.5];
    for (let i = 0; i < d.length; i++) d[i] = Math.min(1, Math.max(0, d[i] * sl + of));
  }
  if (post) for (let i = 0; i < d.length; i++) d[i] = d[i] * post[0] + post[1];
}

// ---------- conv ----------

interface ConvArgs {
  stride: [number, number];
  pad: number[];
  dil: [number, number];
  groups: number;
}

/** Own instance of the conv kernel (cpu.ts keeps U²-Net's weights resident in the shared one); packed weights are
 *  cached per weight tensor and copied in per call. */
function ownKernel(): GraphKernel | null {
  try {
    if (typeof WebAssembly === "undefined") return null;
    const e = new WebAssembly.Instance(new WebAssembly.Module(convModuleBytes() as BufferSource), {}).exports as unknown as GraphKernel;
    const dw: Record<string, (...a: number[]) => void> = {};
    for (const [n, f] of Object.entries(e)) if (n.startsWith("dw")) dw[n.slice(2)] = f as (...a: number[]) => void;
    return { mem: e.mem, conv3: e.conv3, conv1: e.conv1, conv3s2: e.conv3s2, dw };
  } catch {
    return null;
  }
}
const packCache = new WeakMap<Float32Array, { w: Float32Array; b: Float32Array; ocb: number }>();
let kr: GraphKernel | null | undefined;
let useWasm = true;
/** Tests compare the TS and WebAssembly paths. */
export function setGraphWasm(on: boolean) {
  useWasm = on;
}

/**
 * Conv in the WebAssembly kernels: dense k = 1 / 3 at stride 1, dense k = 3 at stride 2, depthwise k = 3 / 5 at
 * stride 1 or 2 per axis (sy, sx); symmetric padding. Null where the kernels are unavailable (the TS loops take
 * over). The input is copied into the kernel memory zero-padded (and de-interleaved per row when sx = 2, wasm.ts).
 */
function convWasm(x: Tensor, w: Tensor, b: Float32Array, k: number, sy: number, sx: number, pad: number, dw: boolean): Tensor | null {
  if (kr === undefined) kr = ownKernel();
  if (!kr || !useWasm) return null;
  const cout = w.s[0], cin = x.s[1];
  let [, , H, Wd] = x.s;
  // 1×1 without padding: every output pixel reads only its own input pixel, so the plane is one long row (one copy
  // per channel each way); the slack columns are never zeroed — they only feed output columns that are dropped
  const flat = k === 1 && pad === 0 && sy === 1 && sx === 1;
  if (flat) {
    Wd = H * Wd;
    H = 1;
  }
  const oh = Math.floor((H + 2 * pad - k) / sy) + 1, ow = Math.floor((Wd + 2 * pad - k) / sx) + 1;
  const xBlocks = Math.ceil(ow / 8);
  // padded row: sx = 1 → xBlocks·8 + k − 1 columns (+ 8 slack); sx = 2 → two halves of `half` columns
  const half = xBlocks * 8 + (k >> 1) + 8;
  const row = sx === 1 ? xBlocks * 8 + (k - 1) + 8 : 2 * half;
  const rows = Math.max(H + 2 * pad, (oh - 1) * sy + k);
  const plane = row * rows;
  const outStride = xBlocks * 8, outPlane = outStride * oh;
  let wv: Float32Array, bv: Float32Array, ocb = 0;
  if (dw) {
    wv = w.d;
    bv = b;
  } else {
    let p = packCache.get(w.d);
    if (!p) {
      p = packConvWeights(w.d, b, cout, cin, k);
      packCache.set(w.d, p);
    }
    wv = p.w;
    bv = p.b;
    ocb = p.ocb;
  }
  const outPlanes = dw ? cout : ocb * 4;
  const wOff = 0, bOff = (wv.length * 4 + 15) & ~15;
  const inOff = (bOff + bv.length * 4 + 63) & ~63;
  const outOff = inOff + ((cin * plane * 4 + 63) & ~63);
  const need = outOff + outPlanes * outPlane * 4;
  const have = kr.mem.buffer.byteLength;
  if (need > have) kr.mem.grow(Math.ceil((need - have) / 65536));
  const f = new Float32Array(kr.mem.buffer);
  f.set(wv, wOff / 4);
  f.set(bv, bOff / 4);
  const ib = inOff / 4, xd = x.d;
  if (flat) for (let c = 0; c < cin; c++) f.set(xd.subarray(c * Wd, (c + 1) * Wd), ib + c * plane);
  else if (sx === 1) {
    f.fill(0, ib, ib + cin * plane);
    for (let c = 0; c < cin; c++)
      for (let y = 0; y < H; y++) {
        const so = (c * H + y) * Wd;
        f.set(xd.subarray(so, so + Wd), ib + c * plane + (y + pad) * row + pad);
      }
  } else {
    f.fill(0, ib, ib + cin * plane);
    // padded column X = xx + pad goes to even[X / 2] or odd[(X − 1) / 2]
    const e0 = pad & 1; // first xx whose X is even
    for (let c = 0; c < cin; c++)
      for (let y = 0; y < H; y++) {
        const so = (c * H + y) * Wd, ro = ib + c * plane + (y + pad) * row;
        for (let xx = e0, d = ro + ((e0 + pad) >> 1); xx < Wd; xx += 2, d++) f[d] = xd[so + xx];
        for (let xx = 1 - e0, d = ro + half + ((1 - e0 + pad) >> 1); xx < Wd; xx += 2, d++) f[d] = xd[so + xx];
      }
  }
  const fn = dw ? kr.dw[`${k}_${sy}${sx}`] : k === 1 ? kr.conv1 : sx === 1 ? kr.conv3 : kr.conv3s2;
  fn(inOff, row, plane, cin, wOff, bOff, outOff, outStride, outPlane, oh, xBlocks, ocb, sx === 1 ? 1 : half, 0);
  const o = T(flat ? [1, cout, x.s[2], x.s[3]] : [1, cout, oh, ow]);
  const ob = outOff / 4;
  for (let c = 0; c < cout; c++)
    for (let y = 0; y < oh; y++) {
      const so = ob + c * outPlane + y * outStride;
      o.d.set(f.subarray(so, so + ow), (c * oh + y) * ow);
    }
  return o;
}

export function conv2d(x: Tensor, w: Tensor, b: Float32Array | null, a: ConvArgs): Tensor {
  const [, cin, H, Wd] = x.s;
  const [cout, cpg, kh, kw] = w.s;
  const g = a.groups || 1;
  const [sh, sw] = a.stride, [dh, dw] = a.dil ?? [1, 1];
  const pt = a.pad[0], pl = a.pad.length === 4 ? a.pad[2] : (a.pad[1] ?? a.pad[0]);
  const pb = a.pad.length === 4 ? a.pad[1] : pt, pr = a.pad.length === 4 ? a.pad[3] : pl;
  const oh = Math.floor((H + pt + pb - dh * (kh - 1) - 1) / sh) + 1;
  const ow = Math.floor((Wd + pl + pr - dw * (kw - 1) - 1) / sw) + 1;
  const bias = b ?? new Float32Array(cout);
  if ((sh === 1 || sh === 2) && (sw === 1 || sw === 2) && dh === 1 && dw === 1 && kh === kw && pt === pb && pl === pr && pt === pl && oh * ow >= 64) {
    const depthwise = g > 1 && g === cin && g === cout && cpg === 1 && (kh === 3 || kh === 5);
    const dense = g === 1 && sh === sw && (sh === 1 ? kh === 3 || kh === 1 : kh === 3);
    if (depthwise || dense) {
      const r = convWasm(x, w, bias, kh, sh, sw, pt, depthwise);
      if (r) return r;
    }
  }
  if (g === 1 && sh === 1 && sw === 1 && dh === 1 && dw === 1 && oh * ow >= 8) {
    // other dense kernels at stride 1 (the recognizer's 1×3 convs, MODNet's 5×5): im2col, then the 1×1 kernel —
    // channel (ci·kh + ky)·kw + kx of the column matrix is the input shifted by (ky, kx), zero outside; the weights
    // [cout][cin][kh][kw] are already that matrix. Same sum order per output: bias, then ci, ky, kx. A column matrix
    // above 2²³ values is made for bands of output rows in turn.
    const K = cin * kh * kw, xd = x.d;
    const band = Math.max(1, Math.min(oh, Math.floor((1 << 23) / (K * ow))));
    const wk = T([cout, K, 1, 1], w.d);
    const o = band < oh ? T([1, cout, oh, ow]) : null;
    let ok = true;
    for (let y0 = 0; y0 < oh && ok; y0 += band) {
      const bh = Math.min(band, oh - y0);
      if (bh * ow < 8 && band < oh) {
        ok = false;
        break;
      }
      const xc = T([1, K, bh, ow]), cd = xc.d;
      for (let ci = 0; ci < cin; ci++)
        for (let ky = 0; ky < kh; ky++)
          for (let kx = 0; kx < kw; kx++) {
            const base = ((ci * kh + ky) * kw + kx) * bh * ow;
            for (let y = 0; y < bh; y++) {
              const iy = y0 + y + ky - pt;
              if (iy < 0 || iy >= H) continue;
              const x0 = Math.max(0, pl - kx), x1 = Math.min(ow, Wd + pl - kx);
              for (let q = x0; q < x1; q++) cd[base + y * ow + q] = xd[(ci * H + iy) * Wd + q + kx - pl];
            }
          }
      const r = convWasm(xc, wk, bias, 1, 1, 1, 0, false);
      if (!r) {
        ok = false;
        break;
      }
      if (!o) return r;
      for (let c = 0; c < cout; c++) o.d.set(r.d.subarray(c * bh * ow, (c + 1) * bh * ow), (c * oh + y0) * ow);
    }
    if (o && ok) return o;
  }
  const o = T([1, cout, oh, ow]);
  const od = o.d, xd = x.d, wd = w.d;
  const HW = H * Wd, OHW = oh * ow;
  if (kh === 1 && kw === 1 && sh === 1 && sw === 1 && g === 1 && pt === 0 && pl === 0) {
    // GEMM: out[o][p] = b[o] + Σ_i w[o][i] · x[i][p]; 4 output rows at a time
    for (let oc = 0; oc < cout; oc += 4) {
      const n = Math.min(4, cout - oc);
      const r0 = oc * OHW;
      for (let j = 0; j < n; j++) od.fill(bias[oc + j], r0 + j * OHW, r0 + (j + 1) * OHW);
      for (let i = 0; i < cin; i++) {
        const xo = i * HW;
        const w0 = wd[oc * cin + i], w1 = n > 1 ? wd[(oc + 1) * cin + i] : 0, w2 = n > 2 ? wd[(oc + 2) * cin + i] : 0, w3 = n > 3 ? wd[(oc + 3) * cin + i] : 0;
        if (n === 4)
          for (let p = 0; p < OHW; p++) {
            const v = xd[xo + p];
            od[r0 + p] += w0 * v;
            od[r0 + OHW + p] += w1 * v;
            od[r0 + 2 * OHW + p] += w2 * v;
            od[r0 + 3 * OHW + p] += w3 * v;
          }
        else
          for (let j = 0; j < n; j++) {
            const wv = wd[(oc + j) * cin + i], ro = r0 + j * OHW;
            for (let p = 0; p < OHW; p++) od[ro + p] += wv * xd[xo + p];
          }
      }
    }
    return o;
  }
  const opg = cout / g;
  for (let oc = 0; oc < cout; oc++) {
    const gi = Math.floor(oc / opg);
    const ro = oc * OHW;
    od.fill(bias[oc], ro, ro + OHW);
    for (let ci = 0; ci < cpg; ci++) {
      const xo = (gi * cpg + ci) * HW;
      for (let ky = 0; ky < kh; ky++)
        for (let kx = 0; kx < kw; kx++) {
          const wv = wd[((oc * cpg + ci) * kh + ky) * kw + kx];
          if (wv === 0) continue;
          const dy = ky * dh - pt, dx = kx * dw - pl;
          // valid output range: 0 ≤ y·sh + dy < H
          const y0 = Math.max(0, Math.ceil(-dy / sh)), y1 = Math.min(oh, Math.floor((H - 1 - dy) / sh) + 1);
          const x0 = Math.max(0, Math.ceil(-dx / sw)), x1 = Math.min(ow, Math.floor((Wd - 1 - dx) / sw) + 1);
          if (sw === 1)
            for (let y = y0; y < y1; y++) {
              const orow = ro + y * ow, irow = xo + (y * sh + dy) * Wd + dx;
              for (let xx = x0; xx < x1; xx++) od[orow + xx] += wv * xd[irow + xx];
            }
          else
            for (let y = y0; y < y1; y++) {
              const orow = ro + y * ow, irow = xo + (y * sh + dy) * Wd + dx;
              for (let xx = x0; xx < x1; xx++) od[orow + xx] += wv * xd[irow + xx * sw];
            }
        }
    }
  }
  return o;
}

const convTCache = new WeakMap<Float32Array, Tensor>();
/** Transposed conv (DB head: k = 2, stride 2, no padding). Weight [cin][cout/g][kh][kw]. */
export function convT(x: Tensor, w: Tensor, b: Float32Array | null, a: { stride: number[]; pad: number[]; groups: number }): Tensor {
  const [, cin, H, Wd] = x.s;
  const [, cpg, kh, kw] = w.s;
  const g = a.groups || 1, cout = cpg * g;
  const [sh, sw] = a.stride, ph = a.pad[0] ?? 0, pw = a.pad[1] ?? ph;
  const oh = (H - 1) * sh - 2 * ph + kh, ow = (Wd - 1) * sw - 2 * pw + kw;
  if (g === 1 && kh === sh && kw === sw && ph === 0 && pw === 0 && H * Wd >= 64) {
    // non-overlapping: a 1×1 conv to cout·kh·kw channels in the WebAssembly kernel, then each channel (oc, ky, kx)
    // goes to its place in the k×k blocks (depth to space). Same sum per output: bias + Σ_ci in ascending order.
    let p = convTCache.get(w.d);
    if (!p) {
      const n = cout * kh * kw, d = new Float32Array(n * cin);
      for (let ci = 0; ci < cin; ci++) for (let j = 0; j < n; j++) d[j * cin + ci] = w.d[ci * n + j];
      p = T([n, cin, 1, 1], d);
      convTCache.set(w.d, p);
    }
    const bb = new Float32Array(cout * kh * kw);
    if (b) for (let j = 0; j < bb.length; j++) bb[j] = b[Math.floor(j / (kh * kw))];
    const y = convWasm(x, p, bb, 1, 1, 1, 0, false);
    if (y) {
      const o = T([1, cout, oh, ow]);
      const od = o.d, yd = y.d, HW = H * Wd;
      for (let oc = 0; oc < cout; oc++)
        for (let ky = 0; ky < kh; ky++)
          for (let kx = 0; kx < kw; kx++) {
            const src = ((oc * kh + ky) * kw + kx) * HW;
            for (let yy = 0; yy < H; yy++) {
              const orow = (oc * oh + yy * sh + ky) * ow + kx, irow = src + yy * Wd;
              for (let xx = 0; xx < Wd; xx++) od[orow + xx * sw] = yd[irow + xx];
            }
          }
      return o;
    }
  }
  const o = T([1, cout, oh, ow]);
  for (let c = 0; c < cout; c++) o.d.fill(b ? b[c] : 0, c * oh * ow, (c + 1) * oh * ow);
  const ipg = cin / g;
  if (kh === sh && kw === sw && ph === 0 && pw === 0) {
    // non-overlapping (DB head: k = stride = 2): every input pixel owns one k×k output block, no bounds checks.
    // Row-major order keeps one input row (all channels) and its output rows in cache; with the channel loops
    // outermost every (ci, oc) pair swept a whole output plane (seconds at 1536 px). Each output still sums its
    // inputs in ascending ci order, so the result is unchanged.
    const od = o.d, xd = x.d, wd = w.d, HW = H * Wd, OHW = oh * ow;
    for (let y = 0; y < H; y++)
      for (let oc = 0; oc < cout; oc++) {
        const gi = Math.floor(oc / cpg), oo = oc - gi * cpg;
        for (let ci = gi * ipg; ci < (gi + 1) * ipg; ci++) {
          const ir = ci * HW + y * Wd;
          for (let ky = 0; ky < kh; ky++)
            for (let kx = 0; kx < kw; kx++) {
              const wv = wd[((ci * cpg + oo) * kh + ky) * kw + kx];
              const orow = oc * OHW + (y * sh + ky) * ow + kx;
              for (let xx = 0; xx < Wd; xx++) od[orow + xx * sw] += wv * xd[ir + xx];
            }
        }
      }
    return o;
  }
  for (let ci = 0; ci < cin; ci++) {
    const gi = Math.floor(ci / ipg);
    for (let oo = 0; oo < cpg; oo++) {
      const oc = gi * cpg + oo, ob = oc * oh * ow;
      for (let ky = 0; ky < kh; ky++)
        for (let kx = 0; kx < kw; kx++) {
          const wv = w.d[((ci * cpg + oo) * kh + ky) * kw + kx];
          for (let y = 0; y < H; y++) {
            const yy = y * sh + ky - ph;
            if (yy < 0 || yy >= oh) continue;
            const ir = ci * H * Wd + y * Wd, orow = ob + yy * ow;
            for (let xx = 0; xx < Wd; xx++) {
              const ox = xx * sw + kx - pw;
              if (ox >= 0 && ox < ow) o.d[orow + ox] += wv * x.d[ir + xx];
            }
          }
        }
    }
  }
  return o;
}

function pool(x: Tensor, k: number[], a: Record<string, any>): Tensor {
  const [, C, H, W] = x.s;
  if (a.global || (a.adaptive && k[0] === 1 && k[1] === 1)) {
    const o = T([1, C, 1, 1]);
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (let i = c * H * W; i < (c + 1) * H * W; i++) s += x.d[i];
      o.d[c] = a.type === "max" ? NaN : s / (H * W);
    }
    return o;
  }
  if (a.adaptive || a.type !== "avg") throw new Error("pool2d variant");
  const [kh, kw] = k, [sh, sw] = a.stride, ph = a.pad?.[0] ?? 0, pw = a.pad?.[1] ?? 0;
  const oh = Math.floor((H + 2 * ph - kh) / sh) + 1, ow = Math.floor((W + 2 * pw - kw) / sw) + 1;
  const o = T([1, C, oh, ow]);
  for (let c = 0; c < C; c++)
    for (let y = 0; y < oh; y++)
      for (let xx = 0; xx < ow; xx++) {
        let s = 0, n = 0;
        for (let i = 0; i < kh; i++) {
          const yy = y * sh - ph + i;
          if (yy < 0 || yy >= H) continue;
          for (let j = 0; j < kw; j++) {
            const xq = xx * sw - pw + j;
            if (xq < 0 || xq >= W) continue;
            s += x.d[(c * H + yy) * W + xq];
            n++;
          }
        }
        o.d[(c * oh + y) * ow + xx] = s / (n || 1);
      }
  return o;
}

function nearest(x: Tensor, oh: number, ow: number): Tensor {
  const [, C, H, W] = x.s;
  const o = T([1, C, oh, ow]);
  const mx = new Int32Array(ow);
  for (let i = 0; i < ow; i++) mx[i] = Math.min(W - 1, Math.floor((i * W) / ow));
  for (let c = 0; c < C; c++)
    for (let y = 0; y < oh; y++) {
      const sy = Math.min(H - 1, Math.floor((y * H) / oh));
      const ir = (c * H + sy) * W, or = (c * oh + y) * ow;
      for (let i = 0; i < ow; i++) o.d[or + i] = x.d[ir + mx[i]];
    }
  return o;
}

function matmul(a: Tensor, b: Tensor): Tensor {
  const K = a.s[a.s.length - 1], M = a.s[a.s.length - 2] ?? 1;
  const N = b.s[b.s.length - 1];
  if (b.s[b.s.length - 2] !== K) throw new Error(`matmul ${a.s} ${b.s}`);
  const batch = a.d.length / (M * K);
  const bBatch = b.d.length / (K * N);
  const s = [...a.s.slice(0, -1), N];
  const o = T(s);
  const od = o.d, ad = a.d, bd = b.d;
  for (let t = 0; t < batch; t++) {
    const ao = t * M * K, bo = (bBatch === 1 ? 0 : t) * K * N, oo = t * M * N;
    for (let m = 0; m < M; m++) {
      const orow = oo + m * N;
      for (let k = 0; k < K; k++) {
        const v = ad[ao + m * K + k];
        if (v === 0) continue;
        const br = bo + k * N;
        for (let n = 0; n < N; n++) od[orow + n] += v * bd[br + n];
      }
    }
  }
  return o;
}

/** x [..., M, K] × weight [K, N] as a 1×1 conv in the WebAssembly kernel (rows = pixels). Null without SIMD. */
const wT = new WeakMap<Float32Array, Tensor>();
function matmulWeight(x: Tensor, w: Tensor): Tensor | null {
  const K = w.s[0], N = w.s[1];
  const M = x.d.length / K;
  if (M < 8) return null;
  let cw = wT.get(w.d);
  if (!cw) {
    const d = new Float32Array(K * N);
    for (let k = 0; k < K; k++) for (let n = 0; n < N; n++) d[n * K + k] = w.d[k * N + n];
    cw = T([N, K, 1, 1], d);
    wT.set(w.d, cw);
  }
  const xt = T([1, K, 1, M]);
  for (let m = 0; m < M; m++) for (let k = 0; k < K; k++) xt.d[k * M + m] = x.d[m * K + k];
  const y = convWasm(xt, cw, zeros(N), 1, 1, 1, 0, false);
  if (!y) return null;
  const o = T([...x.s.slice(0, -1), N]);
  const od = o.d, yd = y.d;
  for (let n = 0; n < N; n++) for (let m = 0; m < M; m++) od[m * N + n] = yd[n * M + m];
  return o;
}
const zc = new Map<number, Float32Array>();
const zeros = (n: number) => zc.get(n) ?? (zc.set(n, new Float32Array(n)), zc.get(n)!);

function layerNorm(x: Tensor, g: Tensor, b: Tensor, eps: number): Tensor {
  const L = x.s[x.s.length - 1];
  const o = T(x.s.slice());
  for (let r = 0; r < x.d.length; r += L) {
    let m = 0;
    for (let i = 0; i < L; i++) m += x.d[r + i];
    m /= L;
    let v = 0;
    for (let i = 0; i < L; i++) v += (x.d[r + i] - m) ** 2;
    const k = 1 / Math.sqrt(v / L + eps);
    for (let i = 0; i < L; i++) o.d[r + i] = (x.d[r + i] - m) * k * g.d[i] + b.d[i];
  }
  return o;
}

function softmaxLast(x: Tensor): Tensor {
  const L = x.s[x.s.length - 1];
  const o = T(x.s.slice());
  for (let r = 0; r < x.d.length; r += L) {
    let m = -Infinity;
    for (let i = 0; i < L; i++) m = Math.max(m, x.d[r + i]);
    let s = 0;
    for (let i = 0; i < L; i++) s += o.d[r + i] = Math.exp(x.d[r + i] - m);
    for (let i = 0; i < L; i++) o.d[r + i] /= s;
  }
  return o;
}

function slice(x: Tensor, starts: number[], ends: number[], axes: number[], decrease: number[]): Tensor {
  const s = x.s.slice(), st = new Array(s.length).fill(0);
  axes.forEach((ax, i) => {
    const n = x.s[ax];
    let a = starts[i], e = ends[i];
    if (a < 0) a += n;
    if (e < 0) e += n;
    a = Math.max(0, Math.min(n, a));
    e = Math.max(a, Math.min(n, e));
    st[ax] = a;
    s[ax] = e - a;
  });
  // channels of one picture (MODNet's IBNorm halves): one contiguous block
  if (axes.length === 1 && axes[0] === 1 && x.s[0] === 1 && x.s.length >= 2) {
    const per = x.d.length / x.s[1];
    const o = T(s, x.d.slice(st[1] * per, (st[1] + s[1]) * per), x.int);
    o.s = s.filter((_, i) => !decrease.includes(i));
    return o;
  }
  const o = T(s, undefined, x.int);
  const xs = strides(x.s), n = s.length, idx = new Array(n).fill(0);
  for (let i = 0; i < o.d.length; i++) {
    let src = 0;
    for (let k = 0; k < n; k++) src += (idx[k] + st[k]) * xs[k];
    o.d[i] = x.d[src];
    for (let k = n - 1; k >= 0; k--) {
      if (++idx[k] < s[k]) break;
      idx[k] = 0;
    }
  }
  o.s = s.filter((_, i) => !decrease.includes(i));
  return o;
}

function concat(xs: Tensor[], axis: number): Tensor {
  const r = xs[0].s.length;
  if (axis < 0) axis += r;
  const s = xs[0].s.slice();
  s[axis] = xs.reduce((a, t) => a + t.s[axis], 0);
  const o = T(s, undefined, xs[0].int);
  const outer = size(s.slice(0, axis));
  let off = 0;
  for (let q = 0; q < outer; q++)
    for (const t of xs) {
      const inner = size(t.s.slice(axis));
      o.d.set(t.d.subarray(q * inner, (q + 1) * inner), off);
      off += inner;
    }
  return o;
}

// ---------- executor ----------

/** Depth to space as PyTorch's PixelShuffle: out[c][y·r + i][x·r + j] = in[(c·r + i)·r + j][y][x]. */
function pixelShuffle(x: Tensor, rr: number): Tensor {
  const [, Ci, H, W] = x.s;
  if (!Number.isInteger(rr) || rr < 1 || Ci % (rr * rr)) bad("pixel_shuffle");
  const C = Ci / (rr * rr), OW = W * rr, o = T([1, C, H * rr, OW]);
  for (let c = 0; c < C; c++)
    for (let i = 0; i < rr; i++)
      for (let j = 0; j < rr; j++) {
        const src = ((c * rr + i) * rr + j) * H * W;
        for (let y = 0; y < H; y++) {
          const orow = (c * H * rr + y * rr + i) * OW + j;
          for (let xx = 0; xx < W; xx++) o.d[orow + xx * rr] = x.d[src + y * W + xx];
        }
      }
  return o;
}

/** Bilinear resize by a scale (ONNX Resize "linear", pytorch_half_pixel: PyTorch's align_corners = false). */
function bilinear(x: Tensor, scale: [number, number]): Tensor {
  const [, C, H, W] = x.s;
  const OH = Math.floor(H * scale[0]), OW = Math.floor(W * scale[1]);
  if (!(OH > 0 && OW > 0)) bad("bilinear_interp size");
  const o = T([1, C, OH, OW]);
  const map = (v: number, n: number, on: number) => (on > 1 ? Math.max(0, (v + 0.5) * (n / on) - 0.5) : 0);
  const y0 = new Int32Array(OH), y1 = new Int32Array(OH), fy = new Float32Array(OH);
  for (let y = 0; y < OH; y++) {
    const f = Math.min(H - 1, map(y, H, OH));
    y0[y] = Math.floor(f);
    y1[y] = Math.min(H - 1, y0[y] + 1);
    fy[y] = f - y0[y];
  }
  const x0 = new Int32Array(OW), x1 = new Int32Array(OW), fx = new Float32Array(OW);
  for (let xx = 0; xx < OW; xx++) {
    const f = Math.min(W - 1, map(xx, W, OW));
    x0[xx] = Math.floor(f);
    x1[xx] = Math.min(W - 1, x0[xx] + 1);
    fx[xx] = f - x0[xx];
  }
  for (let c = 0; c < C; c++) {
    const ib = c * H * W, ob = c * OH * OW;
    for (let y = 0; y < OH; y++) {
      const r0 = ib + y0[y] * W, r1 = ib + y1[y] * W, wy = fy[y], orow = ob + y * OW;
      for (let xx = 0; xx < OW; xx++) {
        const wx = fx[xx], a0 = x.d[r0 + x0[xx]], a1 = x.d[r0 + x1[xx]], b0 = x.d[r1 + x0[xx]], b1 = x.d[r1 + x1[xx]];
        o.d[orow + xx] = (a0 + (a1 - a0) * wx) * (1 - wy) + (b0 + (b1 - b0) * wx) * wy;
      }
    }
  }
  return o;
}

export interface RunStats {
  ms: number;
  peakBytes: number;
  /** filled when present: ms per op kind */
  perOp?: Record<string, number>;
}

/** weights of a range of output channels (the conv pool's workers each run one range — convPool.ts) */
const rangeW = new WeakMap<GNode, Map<string, { w: Tensor; b: Float32Array | null; p: Float32Array | null }>>();
function rangeOf(m: GraphModel, n: GNode, oc0: number, oc1: number) {
  let byRange = rangeW.get(n);
  if (!byRange) rangeW.set(n, (byRange = new Map()));
  const key = oc0 + ":" + oc1;
  let r = byRange.get(key);
  if (!r) {
    const w = m.w.get(n.w!)!, per = w.d.length / w.s[0];
    const b = n.b ? m.w.get(n.b)!.d : null, p = n.p ? m.w.get(n.p)!.d : null;
    r = { w: { s: [oc1 - oc0, ...w.s.slice(1)], d: w.d.slice(oc0 * per, oc1 * per) }, b: b ? b.slice(oc0, oc1) : null, p: p && p.length > 1 ? p.slice(oc0, oc1) : p };
    byRange.set(key, r);
  }
  return r;
}

/**
 * A conv node on the CPU (with its fused activation / pixel shuffle). `oc`: only output channels [oc0, oc1) — what one
 * worker of the conv pool computes (dense convs only, no pixel shuffle); the same sums as the whole conv's.
 */
export function convNode(m: GraphModel, n: GNode, x: Tensor, oc?: [number, number]): Tensor {
  const a = n.a ?? {};
  const part = oc ? rangeOf(m, n, oc[0], oc[1]) : null;
  if (part && ((a.groups ?? 1) !== 1 || a.shuffle)) throw new Error("conv range: dense convs only");
  let r = conv2d(x, part ? part.w : m.w.get(n.w!)!, part ? part.b : n.b ? m.w.get(n.b)!.d : null, { stride: a.stride, pad: a.pad, dil: a.dil, groups: a.groups });
  if (n.act === "prelu") {
    const sl = part ? part.p! : m.w.get(n.p!)!.d, C = r.s[1], HW = r.d.length / C, d = r.d;
    for (let c = 0; c < C; c++) {
      const k = sl.length === 1 ? sl[0] : sl[c];
      for (let j = c * HW; j < (c + 1) * HW; j++) if (d[j] < 0) d[j] *= k;
    }
  } else act(r.d, n.act, n.actA, n.post);
  // fused depth to space (the last conv of a super-resolution net writes its pixels in place)
  if (a.shuffle) r = pixelShuffle(r, a.shuffle);
  return r;
}

/**
 * Convs another executor may take (the conv pool): returns the output, or null to run it here. Called for dense convs
 * only, with the node's index in the graph.
 */
export type ConvOffload = (i: number, n: GNode, x: Tensor) => Promise<Tensor> | null;

/**
 * runGraph with dense convs handed to `offload` where it takes them (convPool.ts: output channels split across
 * workers). Everything else, and the order, as runGraph.
 */
export async function runGraphAsync(m: GraphModel, input: Tensor, offload: ConvOffload): Promise<Tensor> {
  const env = new Map<number, Val>([[m.meta.input, input]]);
  const get = (x: number | string): Val => {
    if (typeof x === "string") {
      const t = m.w.get(x.slice(1));
      if (!t) throw new Error("weight " + x);
      return t;
    }
    const v = env.get(x);
    if (!v) throw new Error("value %" + x);
    return v;
  };
  const nodes = m.meta.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const a = n.a ?? {};
    let r: Val | null = null;
    if (n.op === "conv" && (a.groups ?? 1) === 1 && !a.shuffle) {
      const p = offload(i, n, get(n.in[0]) as Tensor);
      if (p) r = await p;
    }
    r ??= evalNode(m, n, get);
    n.out.forEach((o) => env.set(o, r!));
    for (const x of n.in) if (typeof x === "number" && m.lastUse.get(x) === i && x !== m.meta.output && x !== m.meta.input) env.delete(x);
  }
  return get(m.meta.output) as Tensor;
}

/** One node on the CPU; `get` resolves inputs (numbered values and "$weight" names). */
export function evalNode(m: GraphModel, n: GNode, get: (x: number | string) => Val): Val {
  const a = n.a ?? {};
  const tt = (x: number | string) => get(x) as Tensor;
  let r: Val;
  switch (n.op) {
    case "conv":
      r = convNode(m, n, tt(n.in[0]));
      break;
    case "convT":
      r = convT(tt(n.in[0]), m.w.get(n.w!)!, n.b ? m.w.get(n.b)!.d : null, a as any);
      break;
    case "bn": {
      const [x, mean, vr, sc, bi] = n.in.map(tt);
      const C = x.s[1], HW = x.d.length / C;
      const o = T(x.s.slice());
      for (let c = 0; c < C; c++) {
        const k = sc.d[c] / Math.sqrt(vr.d[c] + a.eps), sh = bi.d[c] - mean.d[c] * k;
        for (let j = c * HW; j < (c + 1) * HW; j++) o.d[j] = x.d[j] * k + sh;
      }
      r = o;
      break;
    }
    case "const": {
      const v = Array.isArray(a.v) ? a.v : [a.v];
      if (a.shape && !Array.isArray(a.v)) {
        // Paddle "full": the scalar repeated over the shape ([] = a scalar)
        r = T(a.shape.slice(), undefined, !!a.int);
        r.d.fill(Number(a.v));
      } else r = T([v.length], Float32Array.from(v), !!a.int);
      break;
    }
    case "add":
      r = binary(tt(n.in[0]), tt(n.in[1]), ADD);
      break;
    case "subtract":
      r = binary(tt(n.in[0]), tt(n.in[1]), SUB);
      break;
    case "multiply":
      r = binary(tt(n.in[0]), tt(n.in[1]), MUL);
      break;
    case "inorm": {
      // instance normalisation (MODNet's IBNorm half): per channel over H × W, then the affine scale / shift
      const x = tt(n.in[0]), sc = tt(n.in[1]).d, bi = tt(n.in[2]).d, eps = a.eps ?? 1e-5;
      const C = x.s[1], HW = x.d.length / C, o = T(x.s.slice());
      for (let c = 0; c < C; c++) {
        let mean = 0;
        for (let j = c * HW; j < (c + 1) * HW; j++) mean += x.d[j];
        mean /= HW;
        let v = 0;
        for (let j = c * HW; j < (c + 1) * HW; j++) v += (x.d[j] - mean) ** 2;
        const k = sc[c] / Math.sqrt(v / HW + eps), sh = bi[c] - mean * k;
        for (let j = c * HW; j < (c + 1) * HW; j++) o.d[j] = x.d[j] * k + sh;
      }
      r = o;
      break;
    }
    case "bilinear_interp":
      r = bilinear(tt(n.in[0]), a.scale as [number, number]);
      break;
    case "relu": case "relu6": case "hardswish": case "swish": case "sigmoid": case "hardsigmoid": {
      const x = tt(n.in[0]);
      const o = T(x.s.slice(), Float32Array.from(x.d));
      act(o.d, n.op, n.op === "hardsigmoid" ? [a.slope, a.offset] : undefined);
      r = o;
      break;
    }
    case "prelu": {
      // per-channel slope for x < 0 (Real-ESRGAN SRVGGNetCompact); a 1-value slope applies to every channel
      const x = tt(n.in[0]), sl = tt(n.in[1]).d;
      const C = x.s[1], HW = x.d.length / C, o = T(x.s.slice());
      for (let c = 0; c < C; c++) {
        const k = sl.length === 1 ? sl[0] : sl[c];
        for (let j = c * HW; j < (c + 1) * HW; j++) o.d[j] = x.d[j] > 0 ? x.d[j] : x.d[j] * k;
      }
      r = o;
      break;
    }
    case "pixel_shuffle":
      r = pixelShuffle(tt(n.in[0]), a.r);
      break;
    case "pool2d":
      r = pool(tt(n.in[0]), ints(get(n.in[1])), a);
      break;
    case "nearest_interp": {
      const x = tt(n.in[0]);
      const sc = a.scale as number[];
      r = nearest(x, a.h > 0 ? a.h : Math.floor(x.s[2] * sc[0]), a.w > 0 ? a.w : Math.floor(x.s[3] * sc[1]));
      break;
    }
    case "list":
      r = n.in.map(tt);
      break;
    case "concat": {
      const xs = get(n.in[0]) as Tensor[];
      r = concat(xs, ints(get(n.in[1]))[0]);
      break;
    }
    case "stack": {
      const xs = get(n.in[0]) as Tensor[];
      if (xs.some((x) => x.d.length !== 1)) throw new Error("stack of scalars only");
      r = T([xs.length], Float32Array.from(xs.map((x) => x.d[0])), xs[0].int);
      break;
    }
    case "shape64": {
      const x = tt(n.in[0]);
      r = T([x.s.length], Float32Array.from(x.s), true);
      break;
    }
    case "slice":
      r = slice(tt(n.in[0]), ints(get(n.in[1])), ints(get(n.in[2])), a.axes, a.decrease ?? []);
      break;
    case "reshape": {
      const x = tt(n.in[0]);
      const want = ints(get(n.in[1]));
      const s = want.map((v, k) => (v === 0 ? x.s[k] : v));
      const known = s.reduce((p, v) => (v === -1 ? p : p * v), 1);
      r = T(s.map((v) => (v === -1 ? x.d.length / known : v)), x.d, x.int);
      break;
    }
    case "flatten": {
      const x = tt(n.in[0]);
      const st = a.start, sp = a.stop;
      r = T([...x.s.slice(0, st), size(x.s.slice(st, sp + 1)), ...x.s.slice(sp + 1)], x.d, x.int);
      break;
    }
    case "squeeze": {
      const x = tt(n.in[0]);
      const ax = ints(get(n.in[1])).map((v) => (v < 0 ? v + x.s.length : v));
      r = T(x.s.filter((v, k) => !(ax.includes(k) && v === 1)), x.d, x.int);
      break;
    }
    case "transpose":
      r = transpose(tt(n.in[0]), a.perm);
      break;
    case "layer_norm":
      r = layerNorm(tt(n.in[0]), tt(n.in[1]), tt(n.in[2]), a.eps);
      break;
    case "matmul":
      if (a.tx || a.ty) throw new Error("matmul transpose");
      r = (typeof n.in[1] === "string" && matmulWeight(tt(n.in[0]), tt(n.in[1]))) || matmul(tt(n.in[0]), tt(n.in[1]));
      break;
    case "scale": {
      const x = tt(n.in[0]), s = tt(n.in[1]).d[0], bias = a.bias ?? 0;
      const o = T(x.s.slice());
      for (let k = 0; k < o.d.length; k++) o.d[k] = a.after === false ? (x.d[k] + bias) * s : x.d[k] * s + bias;
      r = o;
      break;
    }
    case "softmax": {
      const x = tt(n.in[0]);
      let ax = a.axis ?? -1;
      if (ax < 0) ax += x.s.length;
      if (ax !== x.s.length - 1) throw new Error("softmax axis");
      r = softmaxLast(x);
      break;
    }
    default:
      throw new Error("op " + n.op);
  }
  return r;
}

/** Run a graph model on one NCHW input (batch 1). Returns the output tensor. */
export function runGraph(m: GraphModel, input: Tensor, stats?: RunStats): Tensor {
  const t0 = performance.now();
  const env = new Map<number, Val>([[m.meta.input, input]]);
  let live = input.d.byteLength, peak = live;
  const get = (x: number | string): Val => {
    if (typeof x === "string") {
      const t = m.w.get(x.slice(1));
      if (!t) throw new Error("weight " + x);
      return t;
    }
    const v = env.get(x);
    if (!v) throw new Error("value %" + x);
    return v;
  };
  m.meta.nodes.forEach((n, i) => {
    const a = n.a ?? {};
    const tOp = stats?.perOp ? performance.now() : 0;
    const r = evalNode(m, n, get);
    if (stats?.perOp) {
      const key = n.op === "conv" ? `conv${m.w.get(n.w!)!.s[2]}${a.groups > 1 ? "dw" : ""}${a.stride[0] > 1 || a.stride[1] > 1 ? "s" : ""}` : n.op;
      stats.perOp[key] = (stats.perOp[key] ?? 0) + performance.now() - tOp;
      if (!Array.isArray(r)) stats.perOp[`#${i} ${key} ${r.s.join("x")}`] = performance.now() - tOp;
      if (n.op === "conv" && !Array.isArray(r)) {
        const ws = m.w.get(n.w!)!.s;
        stats.perOp["Mmac:" + key] = (stats.perOp["Mmac:" + key] ?? 0) + (ws[0] * ws[1] * ws[2] * ws[3] * r.s[2] * r.s[3]) / 1e6;
      }
    }
    n.out.forEach((o) => env.set(o, r));
    if (!Array.isArray(r)) live += r.d.byteLength;
    if (live > peak) peak = live;
    for (const x of n.in)
      if (typeof x === "number" && m.lastUse.get(x) === i && x !== m.meta.output && x !== m.meta.input) {
        const v = env.get(x);
        if (v && !Array.isArray(v)) live -= v.d.byteLength;
        env.delete(x);
      }
  });
  if (stats) {
    stats.ms = performance.now() - t0;
    stats.peakBytes = peak;
  }
  return get(m.meta.output) as Tensor;
}
