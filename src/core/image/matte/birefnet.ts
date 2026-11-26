// BiRefNet-lite (ZhengPeng7/BiRefNet, MIT; Swin-T backbone): the manual "고품질(사람·동물)" background removal (PC only,
// pipeline.ts opts.hq), converted by scripts/convert-birefnet.mjs to an LWT1 graph (int8, 46 MB). Not bundled: the
// file is downloaded on first use and kept (birefnetModel.ts); the image worker sets the source to the kept copy.
// Measurements (edge error, speed, memory): the image department's evaluation report, 2026-11-25 (outside the repository).
//
// Same running as MODNet (modnet.ts): WebGPU where the browser has it (checked once against the CPU on a small
// picture), else the CPU with the conv pool's workers (convs, deformable convs and the window attention split), else
// one thread. Input: the picture resampled to a square side (1024 as trained; 768 / 512 are cheaper), ImageNet
// mean / std. Output: the matte (0..1) at that side.

import { parseGraph, runGraph, runGraphAsync, type GraphModel, type Tensor } from "../infer/graph";
import { convPool } from "../infer/convPool";
import { graphGpu, graphGpuAvailable, releaseGraphGpu } from "../infer/graphGpu";
import type { Img } from "../pixels";
import { readBirefnetModel } from "./birefnetModel";

let source: (() => Promise<Uint8Array>) | null = null;
let model: Promise<GraphModel | null> | null = null;
let modelBytes: ArrayBuffer | null = null;
let gpuOff = false;
let gpuChecked: Promise<boolean> | null = null;

/** Where the model comes from (the kept download, or a file read in tests). Resets the loaded model. */
export function setBirefnetSource(read: (() => Promise<Uint8Array | null>) | null) {
  source = read as (() => Promise<Uint8Array>) | null;
  model = null;
  modelBytes = null;
  gpuChecked = null;
  gpuOff = false;
}

function load(): Promise<GraphModel | null> {
  model ??= (async () => {
    if (!source) return null;
    try {
      const b = await source();
      if (!b) throw new Error("not downloaded");
      modelBytes = b.slice().buffer as ArrayBuffer;
      return parseGraph(b);
    } catch (e) {
      console.warn("BiRefNet model not loaded:", e);
      model = null;
      return null;
    }
  })();
  return model;
}

/** the GPU checked once against the CPU on a small picture (a software or broken adapter can run the shaders and give
 *  other numbers) */
function gpuAgrees(m: GraphModel, g: { run(x: Tensor): Promise<Tensor> }): Promise<boolean> {
  gpuChecked ??= (async () => {
    const S = 64, d = new Float32Array(3 * S * S);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin(i * 0.37) * 1.5;
    try {
      const a = runGraph(m, { s: [1, 3, S, S], d: d.slice() }), b = await g.run({ s: [1, 3, S, S], d: d.slice() });
      let mx = 0;
      for (let i = 0; i < a.d.length; i++) mx = Math.max(mx, Math.abs(a.d[i] - b.d[i]));
      if (!(mx < 2e-3)) console.warn("BiRefNet: the GPU's result differs from the CPU's (" + mx + "), using the CPU");
      return mx < 2e-3;
    } catch {
      return false;
    }
  })();
  return gpuChecked;
}

/** bilinear sample of the picture into the S × S input, ImageNet mean / std (the eval reference does the same) */
export function birefnetInput(img: Img, S: number, mean: number[], std: number[]): Float32Array {
  const W = img.width, H = img.height, d = img.data, x = new Float32Array(3 * S * S);
  for (let y = 0; y < S; y++) {
    const fy = Math.max(0, Math.min(H - 1, (y + 0.5) * (H / S) - 0.5)), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), wy = fy - y0;
    for (let xx = 0; xx < S; xx++) {
      const fx = Math.max(0, Math.min(W - 1, (xx + 0.5) * (W / S) - 0.5)), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (a: number, b: number) => d[(a * W + b) * 4 + c];
        const v = ((p(y0, x0) * (1 - wx) + p(y0, x1) * wx) * (1 - wy) + (p(y1, x0) * (1 - wx) + p(y1, x1) * wx) * wy) / 255;
        x[c * S * S + y * S + xx] = (v - mean[c]) / std[c];
      }
    }
  }
  return x;
}

/**
 * BiRefNet's matte of the picture at `side` × `side` (a multiple of 32; 1024 as trained), 0..1 over the whole picture.
 * Null when the model is not available.
 */
/** The GPU copy (weights + activation buffers, ≈ 1.3 GB at 1024) is freed after this long unused; the parsed model
 *  and the kept file stay, so the next use only uploads it again (≈ 1 s). */
export const BIREFNET_GPU_IDLE_MS = 60_000;
let idleMs = BIREFNET_GPU_IDLE_MS;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
let release: (m: GraphModel) => Promise<unknown> = releaseGraphGpu;

/** tests: another idle time, another release function */
export function setBirefnetGpuIdle(ms: number, rel?: (m: GraphModel) => Promise<unknown>) {
  idleMs = ms;
  if (rel) release = rel;
}

function armRelease(m: GraphModel) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // (a run that started meanwhile re-arms it when it ends)
    if (!running) void release(m).catch(() => undefined);
  }, idleMs);
  // (a waiting release never keeps a test process alive)
  (idleTimer as { unref?: () => void }).unref?.();
}

/** The downloaded, kept model (birefnetModel.ts) as the source, unless one is set already (tests set a file). */
export function useKeptBirefnet() {
  if (!source) source = readBirefnetModel as () => Promise<Uint8Array>;
}

/** the GPU fell back to the CPU (a failed or disagreeing adapter) */
export const birefnetGpuOff = () => gpuOff;

export async function birefnetMatte(img: Img, o: { side?: number; cpuSide?: number; gpu?: boolean; pool?: boolean } = {}): Promise<{ map: Float32Array; side: number; ms: number; backend: "webgpu" | "cpu"; workers?: number } | null> {
  const m = await load();
  if (!m) return null;
  running++;
  if (idleTimer) clearTimeout(idleTimer), (idleTimer = null);
  try {
    return await runBirefnet(m, img, o);
  } finally {
    running--;
    armRelease(m);
  }
}

async function runBirefnet(m: GraphModel, img: Img, o: { side?: number; cpuSide?: number; gpu?: boolean; pool?: boolean }) {
  const t0 = performance.now();
  let g = o.gpu !== false && !gpuOff && graphGpuAvailable() ? await graphGpu(m).catch(() => null) : null;
  if (g && !(await gpuAgrees(m, g))) {
    gpuOff = true;
    g = null;
  }
  // (a smaller side on the CPU when asked: the dialog's ≤ 640 px preview does not need 1024, and the CPU takes 20 s there)
  const S = Math.max(64, Math.round((g ? (o.side ?? 1024) : (o.cpuSide ?? o.side ?? 1024)) / 32) * 32);
  const x: Tensor = { s: [1, 3, S, S], d: birefnetInput(img, S, m.meta.mean, m.meta.std) };
  let out: Tensor | null = null;
  let backend: "webgpu" | "cpu" = "cpu", workers: number | undefined;
  if (g)
    try {
      out = await g.run(x);
      backend = "webgpu";
    } catch (e) {
      console.warn("BiRefNet on WebGPU failed, using the CPU:", e);
      gpuOff = true;
    }
  if (!out) {
    const pool = o.pool === false ? null : convPool("birefnet", "graph", () => modelBytes);
    if (pool)
      try {
        out = await runGraphAsync(m, x, (i, n, t, ins) => pool.graphConv(m, i, n, t, ins));
        workers = pool.size;
      } catch {
        pool.terminate();
      }
  }
  out ??= runGraph(m, x);
  return { map: out.d, side: S, ms: performance.now() - t0, backend, workers };
}
