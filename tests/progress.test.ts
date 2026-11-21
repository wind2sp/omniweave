// withProgress (src/ui/progress.ts): the task is listed while the work runs, reports fraction / label, is removed
// afterwards (also on error), and Cancel rejects at once, aborts the signal and calls the stop function.
import { describe, expect, it, vi } from "vitest";
import { currentTask, isCancelled, useProgress, withProgress } from "../src/ui/progress";

const tasks = () => useProgress.getState().tasks;

describe("withProgress", () => {
  it("lists the task while it runs and removes it after", async () => {
    let seen = 0;
    const out = await withProgress("Saving…", async (p) => {
      seen = tasks().length;
      p.set(0.5);
      expect(currentTask(tasks())?.fraction).toBe(0.5);
      p.set(2);
      expect(currentTask(tasks())?.fraction).toBe(1);
      p.set(null);
      expect(currentTask(tasks())?.fraction).toBeNull();
      p.label("Writing…");
      expect(currentTask(tasks())?.label).toBe("Writing…");
      return 42;
    });
    expect(out).toBe(42);
    expect(seen).toBe(1);
    expect(tasks()).toEqual([]);
  });

  it("takes synchronous work and removes the task when it throws", async () => {
    expect(await withProgress("x", () => "sync")).toBe("sync");
    await expect(
      withProgress("x", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(tasks()).toEqual([]);
  });

  it("offers Cancel only when asked; Cancel rejects at once and stops the work", async () => {
    const stop = vi.fn();
    let signal: AbortSignal | null = null;
    let finish!: () => void;
    const run = withProgress(
      "Exporting…",
      (p) => {
        signal = p.signal;
        return new Promise<string>((res) => (finish = () => res("late")));
      },
      { cancel: stop },
    );
    await vi.waitFor(() => expect(currentTask(tasks())?.cancel).toBeTypeOf("function"));
    currentTask(tasks())!.cancel!();
    const err = await run.catch((e) => e);
    expect(isCancelled(err)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(signal!.aborted).toBe(true);
    expect(tasks()).toEqual([]);
    finish(); // the late result is dropped
    const plain = withProgress("Saving…", () => new Promise((r) => setTimeout(r, 5)));
    expect(currentTask(tasks())?.cancel).toBeUndefined();
    await plain;
  });

  it("shows the most recent of overlapping tasks", async () => {
    let release!: () => void;
    const a = withProgress("A", () => new Promise<void>((r) => (release = r)));
    const b = withProgress("B", async () => {
      expect(currentTask(tasks())?.label).toBe("B");
    });
    await b;
    expect(currentTask(tasks())?.label).toBe("A");
    release();
    await a;
    expect(tasks()).toEqual([]);
  });
});
