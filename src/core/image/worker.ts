// Image worker: runs filters / adjustments / trace off the UI thread. Pure engine code only (no DOM).

import type { ApplyCtx } from "./filters";
import { applyOps, ImageOpError, type ImageOp } from "./ops";
import type { Img } from "./pixels";
import { traceImage, type TraceMap, type TraceOptions } from "./trace";
import { analyze, removeBackground, type MatteOptions } from "./matte/pipeline";
import { modelFile, ocrModels, recognizePage, setModelBase, type OcrAccel, type OcrLang } from "./ocr/models";
import type { OcrOptions } from "./ocr/pipeline";
import { IdleRelease, localWorker, poolSize, RecPool, runLines } from "./ocr/recPool";
import { recognizeLine, recognizeLineWith } from "./ocr/recognize";
import { graphGpu, graphGpuAvailable, trimGraphGpu } from "./infer/graphGpu";
import { runGraph, type GraphModel } from "./infer/graph";
import { upscale, type UpImg, type UpscaleOptions } from "./upscale";
import { setSrModelBase, srModel, type SrModelKind } from "./sr/models";
import { superResolve, type NetRun, type SrOptions } from "./sr/pipeline";

export type WorkerRequest =
  | { id: number; kind: "ops"; img: Img; ops: ImageOp[]; ctx?: ApplyCtx }
  | { id: number; kind: "trace"; img: Img; opts: Partial<TraceOptions>; map: TraceMap }
  | { id: number; kind: "matte"; img: Img; opts: MatteOptions }
  | { id: number; kind: "matteAnalyze"; img: Img; opts: MatteOptions }
  | { id: number; kind: "ocr"; img: Img; lang: OcrLang; opts: OcrOptions; base?: string }
  | { id: number; kind: "ocrWarm"; lang: OcrLang; base?: string }
  | { id: number; kind: "upscale"; img: UpImg; opts: UpscaleOptions }
  | { id: number; kind: "sr"; img: Img; opts: SrRequest; base?: string };

/** AI super-resolution request (core/image/sr): model kind, denoise (photo), deblock, target size. */
export interface SrRequest extends SrOptions {
  model: SrModelKind;
  denoise: number;
  /** false: CPU only (tests, measurements) */
  gpu?: boolean;
}

let srGpuOff = false;
/** The network as a tile runner: WebGPU where it works (falls back for good after one failure), else the CPU. */
async function srRunner(m: GraphModel, gpu: boolean): Promise<{ run: NetRun; tile: number; backend: "webgpu" | "cpu" }> {
  const g = gpu && !srGpuOff && graphGpuAvailable() ? await graphGpu(m) : null;
  if (!g) return { run: async (x) => runGraph(m, x), tile: 128, backend: "cpu" };
  return {
    run: (x) =>
      g.run(x).catch(() => {
        srGpuOff = true;
        return runGraph(m, x);
      }),
    tile: 256,
    backend: "webgpu",
  };
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

// OCR acceleration. Text lines are recognized by a pool of nested workers (ocr/recPool.ts) — they stay alive between
// pages (the model is parsed once) and end with this worker (cancelImageWork terminates it) or after two idle
// minutes (ocrIdle) — and, where WebGPU
// works, also by the GPU from this thread (infer/graphGpu.ts), which runs the detector too.
let pool: RecPool | null | undefined;
let gpuOff = false;
function cpuPool(rec: GraphModel, o: OcrOptions): RecPool | null {
  const bytes = modelFile(rec);
  if (!bytes || typeof Worker === "undefined") return null;
  if (pool === undefined || (o.workers !== undefined && pool?.size !== o.workers)) {
    pool?.dispose();
    const nav = (self as unknown as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator;
    const n = o.workers ?? poolSize(nav?.hardwareConcurrency ?? 4, nav?.deviceMemory);
    pool = n > 0 ? new RecPool(() => new Worker(new URL("./ocr/recWorker.ts", import.meta.url), { type: "module" }), n) : null;
  }
  if (!pool || !pool.ok) return null;
  try {
    pool.prepare(bytes);
  } catch {
    pool.dispose();
    pool = null;
  }
  return pool;
}

/**
 * With WebGPU the GPU runs the detector and the lines (three in flight: one is recorded here while the GPU runs the
 * others) and no CPU workers are started (they would hold ≈ 100 MB each). The GPU is set up meanwhile — the first
 * time it compiles its shaders while the page is straightened. Without WebGPU, or after it failed once, the CPU pool.
 */
async function ocrAccel(det: GraphModel, rec: GraphModel, o: OcrOptions): Promise<OcrAccel> {
  if (o.gpu === false || gpuOff || !graphGpuAvailable()) return { lines: cpuPool(rec, o)?.run ?? null };
  const p = o.workers ? cpuPool(rec, o) : null; // CPU workers alongside only when asked for (measurements)
  const gdP = graphGpu(det), grP = graphGpu(rec);
  const off = (e: unknown): never => {
    gpuOff = true; // this page falls back to the CPU, the next ones start there
    throw e;
  };
  return {
    detRun: async (x) => {
      const g = await gdP;
      return g ? g.run(x).catch(off) : runGraph(det, x);
    },
    lines: async (tasks, done) => {
      const gr = await grP;
      const extra = gr ? [0, 1, 2].map(() => localWorker((t) => recognizeLineWith((x) => gr.run(x), rec, t.crop, t.opts).catch(off))) : [];
      const q = p ?? (extra.length ? null : cpuPool(rec, o));
      if (q) return q.with(extra)(tasks, done);
      if (extra.length) return runLines(extra, tasks, done);
      return tasks.map((t) => (done(), recognizeLine(rec, t.crop, t.opts)));
    },
  };
}

/** Two minutes after the last OCR request (or warm-up) ended: the recognition workers end and the GPU activation
 *  buffers are freed — the dialog warms them up on open, and the worker itself lives as long as the app. The next
 *  page starts them again (cpuPool → prepare; the GPU allocates on its first run). */
const ocrIdle = new IdleRelease(120_000, () => {
  pool?.dispose();
  trimGraphGpu();
});

/** While the OCR dialog is open: load the models and set up the GPU (shaders, weights, buffers — seconds the first
 *  time) or the CPU workers, so "Recognize" starts at full speed. */
async function ocrWarm(lang: OcrLang) {
  const { det, rec } = await ocrModels(lang);
  if (gpuOff || !graphGpuAvailable()) return void cpuPool(rec, {});
  const [gd, gr] = await Promise.all([graphGpu(det), graphGpu(rec)]);
  // one run each at the largest size, so the pages after it find their GPU buffers already made (graphGpu.ts)
  await gd?.run({ s: [1, 3, 1536, 1536], d: new Float32Array(3 * 1536 * 1536) }); // the largest detector input
  await gr?.run({ s: [1, 3, 48, 3200], d: new Float32Array(3 * 48 * 3200) }); // the widest line
}

scope.onmessage = async (e) => {
  const req = e.data;
  const t0 = performance.now();
  try {
    if (req.kind === "matte") {
      const r = await removeBackground(req.img, req.opts);
      const transfer: Transferable[] = [r.alpha.buffer, r.cut.data.buffer];
      scope.postMessage({ id: req.id, ok: true, matte: r, ms: performance.now() - t0 }, transfer);
      return;
    }
    if (req.kind === "ocrWarm") {
      setModelBase(req.base);
      ocrIdle.begin();
      try {
        await ocrWarm(req.lang).catch(() => undefined);
      } finally {
        ocrIdle.end();
      }
      scope.postMessage({ id: req.id, ok: true, ms: performance.now() - t0 });
      return;
    }
    if (req.kind === "ocr") {
      setModelBase(req.base);
      ocrIdle.begin();
      let r;
      try {
        r = await recognizePage(req.img, req.lang, req.opts, (det, rec) => ocrAccel(det, rec, req.opts));
      } finally {
        ocrIdle.end();
      }
      scope.postMessage({ id: req.id, ok: true, ocr: r, ms: performance.now() - t0 }, [r.image.data.buffer]);
      return;
    }
    if (req.kind === "sr") {
      setSrModelBase(req.base);
      const m = await srModel(req.opts.model, req.opts.denoise);
      const r = await srRunner(m, req.opts.gpu !== false);
      let last = 0;
      const out = await superResolve(req.img, { ...req.opts, tile: req.opts.tile ?? r.tile }, r.run, (done, total) => {
        const now = performance.now();
        if (now - last > 150 || done === total) (last = now), scope.postMessage({ id: req.id, progress: [done, total] });
      });
      scope.postMessage({ id: req.id, ok: true, img: out, backend: r.backend, ms: performance.now() - t0 }, [out.data.buffer]);
      return;
    }
    if (req.kind === "upscale") {
      // progress at most every 150 ms (a tile is 512 × 512 output px)
      let last = 0;
      const out = upscale(req.img, req.opts, (done, total) => {
        const now = performance.now();
        if (now - last > 150 || done === total) (last = now), scope.postMessage({ id: req.id, progress: [done, total] });
      });
      scope.postMessage({ id: req.id, ok: true, img: out, ms: performance.now() - t0 }, [out.data.buffer]);
      return;
    }
    if (req.kind === "matteAnalyze") {
      const r = await analyze(req.img, req.opts);
      scope.postMessage({ id: req.id, ok: true, analysis: r, ms: performance.now() - t0 });
      return;
    }
    if (req.kind === "ops") {
      const out = applyOps(req.img, req.ops, req.ctx);
      scope.postMessage({ id: req.id, ok: true, img: out, ms: performance.now() - t0 }, [out.data.buffer]);
    } else {
      const res = traceImage(req.img, req.opts, req.map);
      scope.postMessage({ id: req.id, ok: true, trace: res, ms: performance.now() - t0 });
    }
  } catch (err) {
    // a coded error goes back as its key and values; the main thread translates it (t() here would always be Korean)
    if (err instanceof ImageOpError) scope.postMessage({ id: req.id, ok: false, code: err.code, vars: err.vars });
    else scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
