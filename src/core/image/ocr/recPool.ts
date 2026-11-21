// OCR — text lines recognized in parallel by a small pool of workers (lines are independent). Message passing only
// (no SharedArrayBuffer: the app is not cross-origin isolated): each worker gets the recognizer file once and parses
// it itself, then line crops go out as transferred copies and LineText comes back. Lines are handed out longest
// first to whichever worker is free, so one long title line does not finish last on its own. Every worker runs the
// same code on the same model, so the page result is identical to recognizing the lines one by one.
//
// Pure engine code (no DOM); the image worker owns the pool (worker.ts) because only it can name the worker script.

import type { LineRecognizer, RecTask } from "./pipeline";
import type { LineText } from "./recognize";

/** What a recognition worker accepts (recWorker.ts). */
export type RecWorkerMsg = { kind: "model"; bytes: ArrayBuffer } | { kind: "line"; i: number; task: RecTask };
export type RecWorkerReply = { i: number; r?: LineText; error?: string };

export interface PoolWorker {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/**
 * Worker count: one per spare core, at most 6 (more brings little on 8-core laptops and every worker holds its own
 * copy of the recognizer and its own WebAssembly heap, ≈ 100 MB measured: 4 workers 683–869 MB RSS in all), fewer on small-memory devices (navigator.deviceMemory, GB, where known).
 */
export function poolSize(cores = 4, memGb?: number): number {
  let n = Math.min(6, Math.max(1, cores - 2));
  if (memGb !== undefined && memGb > 0) n = Math.min(n, Math.max(1, Math.floor(memGb / 2)));
  return n;
}

/**
 * A pool member on this thread with the same protocol: `recognize` runs one line (the WebGPU recognizer — it only
 * records GPU work here, so it takes lines alongside the CPU workers).
 */
export function localWorker(recognize: (t: RecTask) => Promise<LineText>): PoolWorker {
  const w: PoolWorker = {
    onmessage: null,
    onerror: null,
    terminate() {},
    postMessage(m: RecWorkerMsg) {
      if (m.kind !== "line") return;
      recognize(m.task).then(
        (r) => w.onmessage?.({ data: { i: m.i, r } } as MessageEvent),
        (e) => w.onmessage?.({ data: { i: m.i, error: e instanceof Error ? e.message : String(e) } } as MessageEvent),
      );
    },
  };
  return w;
}

export class RecPool {
  private ws: PoolWorker[] = [];
  private model: ArrayBuffer | null = null;
  private broken = false;

  constructor(
    private make: () => PoolWorker,
    readonly size: number,
  ) {}

  /** Start the workers and send them the recognizer (they parse it while detection runs). */
  prepare(model: ArrayBuffer) {
    if (this.model !== model) {
      this.model = model;
      for (const w of this.ws) w.postMessage({ kind: "model", bytes: model.slice(0) } satisfies RecWorkerMsg);
    }
    while (this.ws.length < this.size) {
      const w = this.make();
      w.postMessage({ kind: "model", bytes: model.slice(0) } satisfies RecWorkerMsg);
      this.ws.push(w);
    }
  }

  /** False after a worker failed to start or crashed (the caller then recognizes on its own thread). */
  get ok() {
    return !this.broken;
  }

  dispose() {
    for (const w of this.ws) w.terminate();
    this.ws = [];
    this.model = null;
  }

  readonly run: LineRecognizer = (tasks, done) => this.with([])(tasks, done);

  /** The pool's workers plus `extra` members (localWorker). A failing pool worker turns the pool off from now on;
   *  a failing extra member only fails this page — but the pool workers may still be busy with its lines, and their
   *  late replies (indices of this page) would land in the next page's results, so they are replaced by fresh ones
   *  (prepare starts them again). */
  with(extra: PoolWorker[]): LineRecognizer {
    return (tasks, done) =>
      runLines([...this.ws, ...extra], tasks, done, (w) => {
        if (this.ws.includes(w)) this.broken = true;
        this.dispose();
      });
  }
}

/**
 * Calls `release` once `ms` have passed since the last job ended (begin/end count the jobs, so it never fires
 * while one runs). The image worker frees the recognition workers (≈ 100 MB each) and the GPU buffer cache with
 * it: the OCR dialog warms them up when it opens, and nothing else would ever free them before the app closes.
 */
export class IdleRelease {
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private ms: number,
    private release: () => void,
  ) {}
  begin() {
    this.active++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  end() {
    this.active = Math.max(0, this.active - 1);
    if (this.active || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active) this.release();
    }, this.ms);
  }
}

/** Recognize `tasks` with the members `ws` (each gets the next line, longest first, when it returns one). */
export function runLines(ws: PoolWorker[], tasks: RecTask[], done: () => void, failed?: (w: PoolWorker) => void): Promise<LineText[]> {
  return new Promise<LineText[]>((resolve, reject) => {
    if (!ws.length) return reject(new Error("no recognition workers"));
    const out: LineText[] = new Array(tasks.length);
    if (!tasks.length) return resolve(out);
    // longest crops first (time is about proportional to width at the fixed 48 px height)
    const order = tasks.map((_, i) => i).sort((a, b) => tasks[b].crop.width / tasks[b].crop.height - tasks[a].crop.width / tasks[a].crop.height);
    let next = 0, left = tasks.length, stop = false;
    const fail = (e: Error, w: PoolWorker) => {
      if (stop) return;
      stop = true;
      failed?.(w);
      reject(e);
    };
    const give = (w: PoolWorker) => {
      if (next >= order.length) return;
      const i = order[next++];
      const crop = tasks[i].crop;
      // a copy, transferred: the caller keeps its crops
      const data = new Uint8ClampedArray(crop.data);
      w.postMessage({ kind: "line", i, task: { crop: { width: crop.width, height: crop.height, data }, opts: tasks[i].opts } } satisfies RecWorkerMsg, [data.buffer]);
    };
    for (const w of ws) {
      w.onmessage = (e: MessageEvent<RecWorkerReply>) => {
        const m = e.data;
        if (stop) return;
        if (m.error !== undefined || !m.r) return fail(new Error(m.error ?? "recognition worker"), w);
        out[m.i] = m.r;
        done();
        if (--left === 0) resolve(out);
        else give(w);
      };
      w.onerror = () => fail(new Error("recognition worker failed"), w);
      give(w);
    }
  });
}
