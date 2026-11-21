// Delayed progress for work that can take a moment (open, save, export, OCR, background removal…).
// docs/design/VISUAL_DESIGN.md §로딩·진행: nothing shows for the first 0.3 s; then a bar in the status bar (a filling bar
// when the work reports how far it is, a moving one when it cannot); after 2 s one line says what is happening and,
// where the work can be stopped, a Cancel button. The thresholds are CSS animation delays (ProgressIndicator.tsx), so
// they keep running on the compositor even while synchronous work holds the main thread.
//
//   await withProgress(t("progress.export", { fmt: "PDF" }), (p) => exportPdf(doc, pages, { onProgress: p.set }), { cancel: true });
//
// Cancelling rejects withProgress at once with ProgressCancelled (the caller's work may finish in the background; its
// result is dropped), aborts `p.signal`, and calls `cancel` when it is a function (e.g. terminate a worker).

import { create } from "zustand";
import { useSessions } from "../core/sessions";

export interface ProgressTask {
  id: number;
  /** what is happening, in the viewer's language ("Saving…", "Exporting PDF…") */
  label: string;
  /** 0..1 when known, null for an indeterminate bar */
  fraction: number | null;
  /** present when the work can be stopped */
  cancel?: () => void;
  /** the document tab that was active when the work started: it shows a busy mark meanwhile (DocTabs .doc-tab-busy) */
  tab?: string;
}

export const useProgress = create<{ tasks: ProgressTask[] }>(() => ({ tasks: [] }));

export class ProgressCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "ProgressCancelled";
  }
}
export const isCancelled = (e: unknown): e is ProgressCancelled => e instanceof ProgressCancelled;

export interface ProgressControl {
  /** report how far the work is (0..1), or null to go back to an indeterminate bar */
  set(fraction: number | null): void;
  /** change the line shown after 2 s ("Reading pages…" → "Building fonts…") */
  label(text: string): void;
  /** aborted when the person presses Cancel */
  readonly signal: AbortSignal;
}

export interface ProgressOptions {
  /** true or a stop function: offer Cancel after 2 s */
  cancel?: boolean | (() => void);
}

let nextId = 1;

function patch(id: number, p: Partial<ProgressTask>) {
  useProgress.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
}
function drop(id: number) {
  useProgress.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
}

/**
 * Let the indicator reach the screen before `fn` starts, so synchronous work (packing a file, parsing a PDF) that
 * holds the main thread still shows it after 0.3 s. About one frame; skipped where there is no rendering (tests).
 */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function" || typeof document === "undefined" || document.hidden) return Promise.resolve();
  return new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
}

/** Run `fn` with a delayed progress indicator; see the file comment. */
export async function withProgress<T>(label: string, fn: (p: ProgressControl) => Promise<T> | T, opts: ProgressOptions = {}): Promise<T> {
  const id = nextId++;
  const ctrl = new AbortController();
  let cancelled: (e: ProgressCancelled) => void = () => {};
  const whenCancelled = new Promise<never>((_, rej) => (cancelled = rej));
  whenCancelled.catch(() => {}); // only observed through the race below
  const task: ProgressTask = { id, label, fraction: null, tab: useSessions.getState().active };
  if (opts.cancel)
    task.cancel = () => {
      if (ctrl.signal.aborted) return;
      ctrl.abort();
      drop(id);
      if (typeof opts.cancel === "function") opts.cancel();
      cancelled(new ProgressCancelled());
    };
  useProgress.setState((s) => ({ tasks: [...s.tasks, task] }));
  const control: ProgressControl = {
    set: (f) => !ctrl.signal.aborted && patch(id, { fraction: f == null || !Number.isFinite(f) ? null : Math.max(0, Math.min(1, f)) }),
    label: (text) => !ctrl.signal.aborted && patch(id, { label: text }),
    signal: ctrl.signal,
  };
  try {
    await nextPaint();
    if (ctrl.signal.aborted) throw new ProgressCancelled();
    return await Promise.race([Promise.resolve().then(() => fn(control)), whenCancelled]);
  } finally {
    drop(id);
  }
}

/** Is work running for this tab (its busy mark)? */
export const useTabWorking = (tab: string) => useProgress((s) => s.tasks.some((t) => t.tab === tab));

/** The task the indicator shows: the most recent one still running. */
export const currentTask = (tasks: ProgressTask[]): ProgressTask | null => tasks[tasks.length - 1] ?? null;
