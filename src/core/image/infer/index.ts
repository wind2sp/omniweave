// Loom Infer — Omniweave's own neural-network runner. Today it runs one model: U²-Netp (salient-object detection,
// xuebinqin/U-2-Net, Apache-2.0), bundled as fp16 weights in src/assets/models/u2netp.lwt (mantissa rounded to 9 bits —
// docs/design/INSTALLER_SIZE.md §4; no download, no third-party runtime). Backends: WebGPU (webgpu.ts) when the engine has it, else the CPU executor (cpu.ts, WebAssembly SIMD conv).
//
// `saliency(img)` → 320×320 map in 0..1 (1 = subject). Refinement to full resolution is in ../matte/refine.ts.

import { parseModel, type Model } from "./model";
import { cpuUsesWasm, runCpu, runCpuAsync } from "./cpu";
import { convPool } from "./convPool";
import { GpuRunner, gpuAvailable } from "./webgpu";
import type { Img } from "../pixels";

export type Backend = "webgpu" | "wasm-simd" | "cpu";

export const SAL = 320;

let model: Model | null = null;
/** the model file (the conv pool's workers parse their own copy) */
let modelBytes: ArrayBuffer | null = null;
let loading: Promise<Model> | null = null;
let gpu: Promise<GpuRunner | null> | null = null;
let gpuBroken = false;

/** Provide the model bytes directly (tests, or a caller that already has them). */
export function setModelBytes(bytes: Uint8Array) {
  model = parseModel(bytes);
  modelBytes = bytes.slice().buffer as ArrayBuffer;
  loading = Promise.resolve(model);
  gpu = null;
}

/** The bundled model, fetched once from the app's own assets (same origin; nothing is downloaded from outside). */
export function loadModel(): Promise<Model> {
  if (model) return Promise.resolve(model);
  if (!loading)
    loading = (async () => {
      const url = new URL("../../../assets/models/u2netp.lwt", import.meta.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`model ${res.status}`);
      modelBytes = await res.arrayBuffer();
      model = parseModel(new Uint8Array(modelBytes));
      return model;
    })();
  loading.catch(() => (loading = null));
  return loading;
}

/**
 * Network input from an RGBA image: area-average to 320×320 (anti-aliased like the reference LANCZOS resize),
 * composite transparent pixels on white, divide by the image maximum (as U²-Net's ToTensorLab / rembg do), then
 * ImageNet mean / std. CHW float32.
 */
export function preprocess(img: Img, mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]): Float32Array {
  const N = SAL, out = new Float32Array(3 * N * N);
  const { width: W, height: H, data: d } = img;
  const sx = W / N, sy = H / N;
  let mx = 0;
  for (let y = 0; y < N; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < N; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        const row = Math.min(H - 1, yy) * W;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wgt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const i = (row + Math.min(W - 1, xx)) * 4;
          const a = d[i + 3] / 255;
          r += wgt * (d[i] * a + 255 * (1 - a));
          g += wgt * (d[i + 1] * a + 255 * (1 - a));
          b += wgt * (d[i + 2] * a + 255 * (1 - a));
          wsum += wgt;
        }
      }
      const p = y * N + x;
      out[p] = r / wsum;
      out[N * N + p] = g / wsum;
      out[2 * N * N + p] = b / wsum;
      mx = Math.max(mx, out[p], out[N * N + p], out[2 * N * N + p]);
    }
  }
  mx = mx || 1;
  for (let c = 0; c < 3; c++) for (let p = c * N * N; p < (c + 1) * N * N; p++) out[p] = (out[p] / mx - mean[c]) / std[c];
  return out;
}

export interface SaliencyResult {
  /** SAL×SAL, 0..1 */
  map: Float32Array;
  /** raw output range before normalizing (a weak peak = the network found no clear subject) */
  lo: number;
  hi: number;
  backend: Backend;
  ms: number;
  /** CPU: the conv pool workers the run was split across (none: one thread) */
  workers?: number;
}

/** Run U²-Netp on an image. `backend: "cpu"` skips WebGPU (tests, or the user turned GPU off). */
export async function saliency(img: Img, opts: { backend?: "auto" | "cpu"; pool?: boolean } = {}): Promise<SaliencyResult> {
  const m = await loadModel();
  const x = preprocess(img, m.meta.mean, m.meta.std);
  const t0 = performance.now();
  if (opts.backend !== "cpu" && !gpuBroken && gpuAvailable()) {
    try {
      gpu ??= GpuRunner.create(m);
      const r = await gpu;
      if (r && !r.lost) return { ...normalize(await r.run(x)), backend: "webgpu", ms: performance.now() - t0 };
      if (r?.lost) throw new Error("WebGPU device lost");
    } catch {
      gpuBroken = true; // driver error / device lost: CPU from now on (this run included)
      gpu = null;
    }
  }
  // the CPU: the convs split across the conv pool's workers where there is one (convPool.ts), else on this thread
  const pool = opts.pool === false ? null : convPool("u2netp", "u2", () => modelBytes);
  if (pool)
    try {
      const out = await runCpuAsync(m, x, (i, L, t) => pool.u2Conv(i, L, t));
      return { ...normalize(out), backend: cpuUsesWasm() ? "wasm-simd" : "cpu", ms: performance.now() - t0, workers: pool.size };
    } catch {
      pool.terminate();
    }
  return { ...normalize(runCpu(m, x)), backend: cpuUsesWasm() ? "wasm-simd" : "cpu", ms: performance.now() - t0 };
}

/** U²-Net's own post-processing: min-max normalize the fused map. */
export function normalize(a: Float32Array): { map: Float32Array; lo: number; hi: number } {
  let lo = Infinity, hi = -Infinity;
  for (const v of a) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi - lo > 1e-6 ? 1 / (hi - lo) : 0;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * k;
  return { map: a, lo, hi };
}
