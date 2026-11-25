// Loom Infer — CPU executor. Conv runs in the WebAssembly SIMD kernel (wasm.ts) when available, else in plain TS;
// pool / bilinear up / concat / add are cheap and stay in TS. Tensors are CHW Float32Array (batch 1) and are freed
// right after their last reader, so peak memory stays near the two largest activations.

import type { ConvLayer, Layer, Model } from "./model";
import { convKernel, packConvWeights, type ConvKernel } from "./wasm";

export type T = { c: number; h: number; w: number; d: Float32Array };

// ---------- TS kernels ----------

/** Reference conv (also the fallback without WebAssembly SIMD). */
export function convTs(x: T, L: ConvLayer): T {
  const { cin, cout, k, pad, dil } = L;
  const H = x.h, W = x.w;
  const oh = H + 2 * pad - dil * (k - 1), ow = W + 2 * pad - dil * (k - 1);
  const out = new Float32Array(cout * oh * ow);
  const src = x.d, wt = L.weight;
  for (let o = 0; o < cout; o++) {
    const op = o * oh * ow;
    out.fill(L.bias[o], op, op + oh * ow);
    for (let i = 0; i < cin; i++) {
      const ip = i * H * W;
      for (let ky = 0; ky < k; ky++)
        for (let kx = 0; kx < k; kx++) {
          const wv = wt[((o * cin + i) * k + ky) * k + kx];
          if (wv === 0) continue;
          const dy = ky * dil - pad, dx = kx * dil - pad;
          const y0 = Math.max(0, -dy), y1 = Math.min(oh, H - dy);
          const x0 = Math.max(0, -dx), x1 = Math.min(ow, W - dx);
          for (let y = y0; y < y1; y++) {
            const orow = op + y * ow, irow = ip + (y + dy) * W + dx;
            for (let xx = x0; xx < x1; xx++) out[orow + xx] += wv * src[irow + xx];
          }
        }
    }
    if (L.relu) for (let j = op; j < op + oh * ow; j++) if (out[j] < 0) out[j] = 0;
  }
  if (L.sigmoid) sigmoidInPlace(out);
  return { c: cout, h: oh, w: ow, d: out };
}

export function sigmoidInPlace(a: Float32Array) {
  for (let i = 0; i < a.length; i++) a[i] = 1 / (1 + Math.exp(-a[i]));
}

/** 2×2 max pool, stride 2; `ceil` keeps the last partial window (PyTorch ceil_mode). */
export function pool2(x: T, ceil: boolean): T {
  const oh = ceil ? Math.ceil((x.h - 2) / 2) + 1 : Math.floor((x.h - 2) / 2) + 1;
  const ow = ceil ? Math.ceil((x.w - 2) / 2) + 1 : Math.floor((x.w - 2) / 2) + 1;
  const out = new Float32Array(x.c * oh * ow);
  const s = x.d, H = x.h, W = x.w;
  for (let c = 0; c < x.c; c++) {
    const ip = c * H * W, op = c * oh * ow;
    for (let y = 0; y < oh; y++) {
      const y0 = y * 2, y1 = Math.min(H, y0 + 2);
      for (let xx = 0; xx < ow; xx++) {
        const x0 = xx * 2, x1 = Math.min(W, x0 + 2);
        let m = -Infinity;
        for (let yy = y0; yy < y1; yy++)
          for (let q = x0; q < x1; q++) {
            const v = s[ip + yy * W + q];
            if (v > m) m = v;
          }
        out[op + y * ow + xx] = m;
      }
    }
  }
  return { c: x.c, h: oh, w: ow, d: out };
}

/** Bilinear resize, ONNX Resize "half_pixel" (= PyTorch align_corners=False) or "align_corners". */
export function upBilinear(x: T, oh: number, ow: number, align = false): T {
  const out = new Float32Array(x.c * oh * ow);
  const H = x.h, W = x.w;
  const map = (n: number, inN: number) => {
    const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n);
    for (let o = 0; o < n; o++) {
      let s = align ? (n > 1 ? (o * (inN - 1)) / (n - 1) : 0) : ((o + 0.5) * inN) / n - 0.5;
      if (s < 0) s = 0;
      if (s > inN - 1) s = inN - 1;
      const a = Math.floor(s);
      i0[o] = a;
      i1[o] = Math.min(inN - 1, a + 1);
      f[o] = s - a;
    }
    return { i0, i1, f };
  };
  const my = map(oh, H), mx = map(ow, W);
  for (let c = 0; c < x.c; c++) {
    const ip = c * H * W, op = c * oh * ow;
    for (let y = 0; y < oh; y++) {
      const r0 = ip + my.i0[y] * W, r1 = ip + my.i1[y] * W, fy = my.f[y];
      for (let xx = 0; xx < ow; xx++) {
        const a = mx.i0[xx], b = mx.i1[xx], fx = mx.f[xx];
        const top = x.d[r0 + a] + (x.d[r0 + b] - x.d[r0 + a]) * fx;
        const bot = x.d[r1 + a] + (x.d[r1 + b] - x.d[r1 + a]) * fx;
        out[op + y * ow + xx] = top + (bot - top) * fy;
      }
    }
  }
  return { c: x.c, h: oh, w: ow, d: out };
}

function concat(xs: T[]): T {
  const c = xs.reduce((a, b) => a + b.c, 0);
  const out = new Float32Array(c * xs[0].h * xs[0].w);
  let o = 0;
  for (const x of xs) {
    out.set(x.d, o);
    o += x.d.length;
  }
  return { c, h: xs[0].h, w: xs[0].w, d: out };
}

function add(a: T, b: T): T {
  const out = new Float32Array(a.d.length);
  for (let i = 0; i < out.length; i++) out[i] = a.d[i] + b.d[i];
  return { ...a, d: out };
}

// ---------- WASM conv ----------

interface Packed {
  wOff: number;
  bOff: number;
  ocb: number;
}

/** the WasmConv whose weights are in the (single, shared) kernel memory right now */
let current: WasmConv | null = null;

class WasmConv {
  private packed = new Map<ConvLayer, Packed>();
  private scratch = 0; // byte offset where per-call buffers start
  private blocks: { L: ConvLayer; w: Float32Array; b: Float32Array; ocb: number }[] = [];
  constructor(private kr: ConvKernel, model: Model) {
    let off = 0;
    const blocks: { L: ConvLayer; w: Float32Array; b: Float32Array; ocb: number }[] = [];
    for (const L of model.layers) {
      if (L.op !== "conv") continue;
      const p = packConvWeights(L.weight, L.bias, L.cout, L.cin, L.k);
      blocks.push({ L, ...p });
    }
    for (const bl of blocks) {
      const wOff = off;
      off += bl.w.length * 4;
      const bOff = off;
      off += bl.b.length * 4;
      this.packed.set(bl.L, { wOff, bOff, ocb: bl.ocb });
    }
    this.scratch = (off + 63) & ~63;
    this.blocks = blocks;
  }
  /** (re)load this model's weights into the kernel memory (another model may have used it meanwhile) */
  private upload() {
    this.ensure(this.scratch);
    const f = new Float32Array(this.kr.mem.buffer);
    for (const bl of this.blocks) {
      const p = this.packed.get(bl.L)!;
      f.set(bl.w, p.wOff / 4);
      f.set(bl.b, p.bOff / 4);
    }
    current = this;
  }
  private ensure(bytes: number) {
    const have = this.kr.mem.buffer.byteLength;
    if (bytes > have) this.kr.mem.grow(Math.ceil((bytes - have) / 65536));
  }
  run(x: T, L: ConvLayer): T {
    if (current !== this) this.upload();
    const p = this.packed.get(L)!;
    const { pad, dil, k } = L;
    const oh = x.h + 2 * pad - dil * (k - 1), ow = x.w + 2 * pad - dil * (k - 1);
    const xBlocks = Math.ceil(ow / 8);
    const row = xBlocks * 8 + dil * (k - 1) + 8; // padded input row (room for the over-read of the last block)
    const rows = oh + dil * (k - 1);
    const plane = row * rows;
    const outStride = xBlocks * 8, outPlane = outStride * oh;
    const inOff = this.scratch;
    const outOff = inOff + ((x.c * plane * 4 + 63) & ~63);
    this.ensure(outOff + p.ocb * 4 * outPlane * 4);
    const f = new Float32Array(this.kr.mem.buffer);
    const ib = inOff / 4;
    f.fill(0, ib, ib + x.c * plane);
    for (let c = 0; c < x.c; c++)
      for (let y = 0; y < x.h; y++) {
        const s = (c * x.h + y) * x.w;
        f.set(x.d.subarray(s, s + x.w), ib + c * plane + (y + pad) * row + pad);
      }
    (k === 3 ? this.kr.conv3 : this.kr.conv1)(inOff, row, plane, x.c, p.wOff, p.bOff, outOff, outStride, outPlane, oh, xBlocks, p.ocb, dil, L.relu ? 1 : 0);
    const out = new Float32Array(L.cout * oh * ow);
    const ob = outOff / 4;
    const g = new Float32Array(this.kr.mem.buffer);
    for (let c = 0; c < L.cout; c++)
      for (let y = 0; y < oh; y++) {
        const s = ob + c * outPlane + y * outStride;
        out.set(g.subarray(s, s + ow), (c * oh + y) * ow);
      }
    if (L.sigmoid) sigmoidInPlace(out);
    return { c: L.cout, h: oh, w: ow, d: out };
  }
}

export interface CpuOptions {
  /** force the TS conv even where WebAssembly SIMD works (tests compare both) */
  noWasm?: boolean;
}

const wasmFor = new WeakMap<Model, WasmConv | null>();

/** Whether the WebAssembly SIMD conv is used for this engine. */
export function cpuUsesWasm(): boolean {
  return !!convKernel();
}

/** One conv layer of `model` on the CPU (WebAssembly SIMD where it works). */
export function convLayer(model: Model, L: ConvLayer, x: T): T {
  if (!wasmFor.has(model)) {
    const kr = convKernel();
    wasmFor.set(model, kr ? new WasmConv(kr, model) : null);
  }
  const wc = wasmFor.get(model);
  return wc ? wc.run(x, L) : convTs(x, L);
}

/** The layer with only output channels [oc0, oc1) (the conv pool's workers each hold one such slice of every conv). */
export function subLayer(L: ConvLayer, oc0: number, oc1: number): ConvLayer {
  const per = L.cin * L.k * L.k;
  return { ...L, cout: oc1 - oc0, weight: L.weight.slice(oc0 * per, oc1 * per), bias: L.bias.slice(oc0, oc1) };
}

/** Convs another executor may take (convPool.ts): the output, or null to run it here. `i` = layer index. */
export type LayerOffload = (i: number, L: ConvLayer, x: T) => Promise<T> | null;

/** runCpu with convs handed to `offload` where it takes them; the same order and results. */
export async function runCpuAsync(model: Model, input: Float32Array, offload: LayerOffload): Promise<Float32Array> {
  const [c, h, w] = model.meta.input;
  if (input.length !== c * h * w) throw new Error("input size");
  const env = new Map<string, T>([["x", { c, h, w, d: input }]]);
  const get = (n: string) => {
    const t = env.get(n);
    if (!t) throw new Error("tensor " + n);
    return t;
  };
  for (let i = 0; i < model.layers.length; i++) {
    const L = model.layers[i];
    let r: T;
    if (L.op === "conv") r = (await offload(i, L, get(L.in))) ?? convLayer(model, L, get(L.in));
    else if (L.op === "pool") r = pool2(get(L.in), L.ceil);
    else if (L.op === "up") r = upBilinear(get(L.in), L.h, L.w, L.align);
    else if (L.op === "concat") r = concat(L.in.map(get));
    else r = add(get(L.in[0]), get(L.in[1]));
    env.set(L.out, r);
    for (const x of Array.isArray(L.in) ? L.in : [L.in]) if (model.lastUse.get(x) === i && x !== "x") env.delete(x);
  }
  return get(model.meta.output).d;
}

/** Run the model on a CHW input (meta.input shape). Returns the output tensor (CHW). */
export function runCpu(model: Model, input: Float32Array, opts: CpuOptions = {}): Float32Array {
  const [c, h, w] = model.meta.input;
  if (input.length !== c * h * w) throw new Error("input size");
  let wc: WasmConv | null = null;
  if (!opts.noWasm) {
    if (!wasmFor.has(model)) {
      const kr = convKernel();
      wasmFor.set(model, kr ? new WasmConv(kr, model) : null);
    }
    wc = wasmFor.get(model) ?? null;
  }
  const env = new Map<string, T>([["x", { c, h, w, d: input }]]);
  const get = (n: string) => {
    const t = env.get(n);
    if (!t) throw new Error("tensor " + n);
    return t;
  };
  model.layers.forEach((L: Layer, i) => {
    let r: T;
    if (L.op === "conv") r = wc ? wc.run(get(L.in), L) : convTs(get(L.in), L);
    else if (L.op === "pool") r = pool2(get(L.in), L.ceil);
    else if (L.op === "up") r = upBilinear(get(L.in), L.h, L.w, L.align);
    else if (L.op === "concat") r = concat(L.in.map(get));
    else r = add(get(L.in[0]), get(L.in[1]));
    env.set(L.out, r);
    for (const x of Array.isArray(L.in) ? L.in : [L.in]) if (model.lastUse.get(x) === i && x !== "x") env.delete(x);
  });
  return get(model.meta.output).d;
}
