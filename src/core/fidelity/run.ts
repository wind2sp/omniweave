// Client side of the fidelity worker: start a scoring run, get progress, cancel it. Falls back to the calling thread
// (yielding between tile rows, still cancellable) where Worker is unavailable — tests, the CLI, old engines.

import { scorePsd, type PsdScore, type ScoreRun } from "./psdScore";
import type { FidelityReply } from "./worker";

export interface ScoreJob {
  /** the run's result; null when cancelled */
  promise: Promise<ScoreRun | null>;
  cancel(): void;
}

export type Progress = (done: number, total: number, partial: PsdScore) => void;

/**
 * A new fidelity worker, or null where there is none. Also reads a CMYK PSD's channels for the screen
 * (core/image/cmykComposite.ts prepareCmykStore). The one place it is constructed (vite.config.ts sharedWorkers).
 */
export function fidelityWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/** Score PSD bytes in a dedicated worker (or here). The bytes are copied, so the caller keeps its buffer. */
export function startScore(bytes: Uint8Array, onProgress?: Progress, opts: { worker?: boolean } = {}): ScoreJob {
  const w = opts.worker !== false ? fidelityWorker() : null;
  if (!w) {
    let stop = false;
    return {
      // a job cancelled after its last row still resolves null (small files finish before the first yield)
      promise: scorePsd(bytes, { onProgress, shouldStop: () => stop, yieldToLoop: true }).then((r) => (stop ? null : r)),
      cancel: () => void (stop = true),
    };
  }
  const worker = w;
  let settle: ((v: ScoreRun | null) => void) | null = null;
  const promise = new Promise<ScoreRun | null>((resolve, reject) => {
    settle = resolve;
    worker.onmessage = (e: MessageEvent<FidelityReply>) => {
      const m = e.data;
      if (m.kind === "progress") return onProgress?.(m.done, m.total, m.partial);
      worker.terminate();
      settle = null;
      if (m.kind === "done") resolve(m.run);
      else reject(new Error(m.kind === "error" ? m.message : "fidelity worker"));
    };
    worker.onerror = (e) => {
      // failed to load or crashed (usually out of memory on a huge file): no score, never retried on the UI thread
      worker.terminate();
      settle = null;
      reject(new Error(e.message || "fidelity worker"));
    };
  });
  const copy = bytes.slice();
  worker.postMessage({ bytes: copy }, [copy.buffer]);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      settle?.(null);
      settle = null;
    },
  };
}
