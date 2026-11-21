// Client side of the image worker. Falls back to the calling thread where Worker is unavailable (tests, old engines),
// so callers always get the same result either way.

import { t } from "../../i18n";
import type { ApplyCtx } from "./filters";
import { applyOps, ImageOpError, type ImageOp } from "./ops";
import type { Img } from "./pixels";
import { traceImage, type TraceMap, type TraceOptions, type TraceResult } from "./trace";
import { analyze, removeBackground, type MatteOptions, type MatteResult } from "./matte/pipeline";
import { recognizePage, type OcrLang } from "./ocr/models";
import type { OcrOptions, OcrPage } from "./ocr/pipeline";
import { checkUpscale, upscale, type UpImg, type UpscaleOptions } from "./upscale";
import type { SrRequest } from "./worker";
import { srModel } from "./sr/models";
import { superResolve } from "./sr/pipeline";
import { runGraph } from "./infer/graph";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (done: number, total: number) => void };

let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker !== "undefined" ? new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }) : null;
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { id: number; ok: boolean; error?: string; code?: string; vars?: Record<string, string | number>; progress?: [number, number] };
      const p = pending.get(m.id);
      if (!p) return;
      if (m.progress) return void p.progress?.(m.progress[0], m.progress[1]);
      pending.delete(m.id);
      if (m.ok) p.resolve(m);
      else p.reject(new Error(m.code ? t(m.code, m.vars) : (m.error ?? t("engine.image.failed"))));
    };
    const w = worker;
    worker.onerror = () => {
      if (worker !== w) return; // a worker stopped by cancelImageWork
      // worker failed to load or crashed: reject everything in flight and fall back to the main thread from now on
      for (const p of pending.values()) p.reject(new Error(t("engine.image.workerError")));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function post<T>(msg: Record<string, unknown>, progress?: Pending["progress"]): Promise<T> | null {
  const w = getWorker();
  if (!w) return null;
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, progress });
    // the input is copied (not transferred) so the caller can keep using its image
    w.postMessage({ ...msg, id });
  });
}

export interface Timed<T> {
  value: T;
  ms: number;
}

export async function runOps(img: Img, ops: ImageOp[], ctx?: ApplyCtx): Promise<Timed<Img>> {
  const p = post<{ img: Img; ms: number }>({ kind: "ops", img, ops, ctx });
  if (p) {
    try {
      const r = await p;
      return { value: r.img, ms: r.ms };
    } catch (e) {
      if (worker) throw e; // real processing error
    }
  }
  const t0 = performance.now();
  try {
    const value = applyOps(img, ops, ctx);
    return { value, ms: performance.now() - t0 };
  } catch (e) {
    throw e instanceof ImageOpError ? new Error(t(e.code, e.vars)) : e;
  }
}

export async function runTrace(img: Img, opts: Partial<TraceOptions>, map: TraceMap = {}): Promise<Timed<TraceResult>> {
  const p = post<{ trace: TraceResult; ms: number }>({ kind: "trace", img, opts, map });
  if (p) {
    try {
      const r = await p;
      return { value: r.trace, ms: r.ms };
    } catch (e) {
      if (worker) throw e;
    }
  }
  const t0 = performance.now();
  const value = traceImage(img, opts, map);
  return { value, ms: performance.now() - t0 };
}

/** Background removal (classify → method → refine) in the image worker. */
/** Above this the cut-out buffers (source copy, matte, cut, refine planes) would need several GB. */
export const MATTE_MAX_PIXELS = 120_000_000;
/** A crashed worker (usually out of memory) is not retried on the UI thread above this — it would freeze the app. */
const MATTE_MAIN_THREAD_MAX = 16_000_000;

function checkMatteSize(img: Img) {
  if (img.width * img.height > MATTE_MAX_PIXELS) throw new Error(t("engine.image.matteTooLarge", { w: img.width, h: img.height }));
}

export async function runMatte(img: Img, opts: MatteOptions = {}): Promise<Timed<MatteResult>> {
  checkMatteSize(img);
  const p = post<{ matte: MatteResult; ms: number }>({ kind: "matte", img, opts });
  if (p) {
    try {
      const r = await p;
      return { value: r.matte, ms: r.ms };
    } catch (e) {
      if (worker || img.width * img.height > MATTE_MAIN_THREAD_MAX) throw e;
    }
  }
  const t0 = performance.now();
  const value = await removeBackground(img, opts);
  return { value, ms: performance.now() - t0 };
}

/** Same ceiling as background removal: the decoded copy sent to the worker alone would be 4 bytes a pixel. (The
 *  engine itself works on at most OCR_MAX_SIDE, ocr/pipeline.ts.) */
export const OCR_MAX_PIXELS = MATTE_MAX_PIXELS;
/** Rejection of a request stopped with cancelImageWork (callers show nothing for it). */
export const CANCELLED = "image work cancelled";

/**
 * Stop the image worker (a long text recognition): every request in flight is rejected with CANCELLED and the next
 * request starts a fresh worker. A no-op when nothing runs.
 */
export function cancelImageWork() {
  if (!worker || !pending.size) return;
  worker.terminate();
  worker = undefined;
  for (const p of pending.values()) p.reject(new Error(CANCELLED));
  pending.clear();
}

/** Get the OCR models and the GPU (or recognition workers) ready in the image worker while the dialog is open. */
export function warmOcr(lang: OcrLang = "auto") {
  post({ kind: "ocrWarm", lang, base: typeof document !== "undefined" ? document.baseURI : undefined })?.catch(() => undefined);
}

/**
 * Text recognition of a page image in the image worker. Only engines without a Worker run it on this thread: it takes
 * tens of seconds, so after a worker crash (usually out of memory) or a cancel it is never retried here — that would
 * freeze the app.
 */
export async function runOcr(img: Img, lang: OcrLang = "auto", opts: OcrOptions = {}): Promise<Timed<OcrPage>> {
  if (img.width * img.height > OCR_MAX_PIXELS) throw new Error(t("ocr.err.tooLarge", { w: img.width, h: img.height }));
  const p = post<{ ocr: OcrPage; ms: number }>({ kind: "ocr", img, lang, opts: { ...opts, onProgress: undefined }, base: typeof document !== "undefined" ? document.baseURI : undefined });
  if (p) {
    const r = await p;
    return { value: r.ocr, ms: r.ms };
  }
  // the engine has workers but ours crashed earlier: not on this thread either
  if (typeof Worker !== "undefined") throw new Error(t("engine.image.workerError"));
  const t0 = performance.now();
  const value = await recognizePage(img, lang, opts);
  return { value, ms: performance.now() - t0 };
}

/** Above this an upscale is not retried on the UI thread after a worker crash (it would freeze the app). */
const UPSCALE_MAIN_THREAD_MAX = 16_000_000;

/**
 * Enlarge a picture in the image worker (core/image/upscale.ts), with progress per tile; cancelImageWork stops it.
 * Engines without a Worker run it here.
 */
export async function runUpscale<D extends Uint8ClampedArray | Uint16Array>(img: UpImg<D>, opts: UpscaleOptions, onProgress?: (done: number, total: number) => void): Promise<Timed<UpImg<D>>> {
  try {
    checkUpscale(img.width, img.height, opts.width, opts.height);
  } catch (e) {
    throw e instanceof ImageOpError ? new Error(t(e.code, e.vars)) : e;
  }
  const p = post<{ img: UpImg<D>; ms: number }>({ kind: "upscale", img, opts }, onProgress);
  if (p) {
    try {
      const r = await p;
      return { value: r.img, ms: r.ms };
    } catch (e) {
      if (worker || (e as Error).message === CANCELLED || opts.width * opts.height > UPSCALE_MAIN_THREAD_MAX) throw e;
    }
  }
  const t0 = performance.now();
  try {
    const value = upscale(img, opts, onProgress);
    return { value, ms: performance.now() - t0 };
  } catch (e) {
    throw e instanceof ImageOpError ? new Error(t(e.code, e.vars)) : e;
  }
}

/**
 * AI super-resolution (core/image/sr) in the image worker: WebGPU there when available, else its CPU; progress per
 * tile, cancelImageWork stops it. Engines without a Worker run it on this thread (CPU). `backend` says which ran.
 */
export async function runSuperResolve(img: Img, opts: SrRequest, onProgress?: (done: number, total: number) => void): Promise<Timed<Img> & { backend: string }> {
  const base = typeof document !== "undefined" ? document.baseURI : undefined;
  const p = post<{ img: Img; ms: number; backend: string }>({ kind: "sr", img, opts, base }, onProgress);
  if (p) {
    const r = await p;
    return { value: r.img, ms: r.ms, backend: r.backend };
  }
  if (typeof Worker !== "undefined") throw new Error(t("engine.image.workerError"));
  const t0 = performance.now();
  const m = await srModel(opts.model, opts.denoise);
  const value = await superResolve(img, opts, async (x) => runGraph(m, x), onProgress);
  return { value, ms: performance.now() - t0, backend: "cpu" };
}

export type MatteAnalysis = Awaited<ReturnType<typeof analyze>>;

/** Detected type + confidence (and the saliency map for photos, so the dialog's previews reuse it). */
export async function runMatteAnalyze(img: Img, opts: MatteOptions = {}): Promise<Timed<MatteAnalysis>> {
  checkMatteSize(img);
  const p = post<{ analysis: MatteAnalysis; ms: number }>({ kind: "matteAnalyze", img, opts });
  if (p) {
    try {
      const r = await p;
      return { value: r.analysis, ms: r.ms };
    } catch (e) {
      if (worker || img.width * img.height > MATTE_MAIN_THREAD_MAX) throw e;
    }
  }
  const t0 = performance.now();
  const value = await analyze(img, opts);
  return { value, ms: performance.now() - t0 };
}
