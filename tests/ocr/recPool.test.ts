// OCR line recognition pool (src/core/image/ocr/recPool.ts) with fake workers: results come back in task order
// whatever worker finishes first, long lines go out first, a failing worker rejects the page and disables the pool.
import { describe, expect, it, vi } from "vitest";
import { IdleRelease, localWorker, poolSize, RecPool, type RecWorkerMsg } from "../../src/core/image/ocr/recPool";
import type { RecTask } from "../../src/core/image/ocr/pipeline";

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  got: RecWorkerMsg[] = [];
  dead = false;
  constructor(private delay: (w: number) => number, private failOn = -1) {}
  postMessage(m: RecWorkerMsg) {
    this.got.push(m);
    if (m.kind !== "line") return;
    const { i, task } = m;
    setTimeout(() => {
      if (this.dead) return;
      if (i === this.failOn) return this.onmessage?.({ data: { i, error: "boom" } } as MessageEvent);
      this.onmessage?.({ data: { i, r: { text: `w${task.crop.width}`, conf: 1, chars: [] } } } as MessageEvent);
    }, this.delay(task.crop.width));
  }
  terminate() {
    this.dead = true;
  }
}

const task = (w: number): RecTask => ({ crop: { width: w, height: 10, data: new Uint8ClampedArray(w * 40) }, opts: { em: 8 } });

describe("recognition worker pool", () => {
  it("returns results in task order, hands out the longest lines first, copies crops", async () => {
    const ws: FakeWorker[] = [];
    const pool = new RecPool(() => {
      const w = new FakeWorker((width) => width / 10);
      ws.push(w);
      return w;
    }, 3);
    pool.prepare(new ArrayBuffer(8));
    expect(ws.length).toBe(3);
    expect(ws.every((w) => w.got[0].kind === "model")).toBe(true);
    const tasks = [40, 300, 120, 80, 200, 60, 20].map(task);
    let done = 0;
    const r = await pool.run(tasks, () => done++);
    expect(r.map((x) => x.text)).toEqual(tasks.map((t) => `w${t.crop.width}`));
    expect(done).toBe(tasks.length);
    // the first line each worker got: the three widest
    const first = ws.map((w) => (w.got[1] as { task: RecTask }).task.crop.width).sort((a, b) => b - a);
    expect(first).toEqual([300, 200, 120]);
    // the caller's crops are untouched (copies were transferred)
    expect(tasks[0].crop.data.length).toBe(40 * 40);
    expect(pool.ok).toBe(true);
    expect(await pool.run([], () => done++)).toEqual([]);
  });

  it("a failing worker rejects the page and turns the pool off", async () => {
    let n = 0;
    const pool = new RecPool(() => new FakeWorker(() => 1, n++ === 0 ? 0 : -1), 2);
    pool.prepare(new ArrayBuffer(8));
    await expect(pool.run([task(100), task(50), task(30)], () => {})).rejects.toThrow("boom");
    expect(pool.ok).toBe(false);
  });

  it("a failing extra member (GPU) does not let the pool's late replies land in the next page", async () => {
    const ws: FakeWorker[] = [];
    const pool = new RecPool(() => {
      const w = new FakeWorker(() => 30);
      ws.push(w);
      return w;
    }, 2);
    pool.prepare(new ArrayBuffer(8));
    const bad = localWorker(() => Promise.reject(new Error("WebGPU device lost")));
    await expect(pool.with([bad])([task(100), task(90), task(80)], () => {})).rejects.toThrow("device lost");
    // the pool workers are still busy with page 1 lines (replies due in 30 ms); the next page starts right away
    pool.prepare(new ArrayBuffer(8));
    const page2 = [task(10), task(11), task(12)];
    const r = await pool.run(page2, () => {});
    expect(r.map((x) => x.text)).toEqual(["w10", "w11", "w12"]);
    expect(pool.ok).toBe(true);
  });

  it("idle release: runs after the last job ends, never while one is running", () => {
    vi.useFakeTimers();
    try {
      let released = 0;
      const idle = new IdleRelease(1000, () => released++);
      idle.begin();
      idle.begin();
      idle.end();
      vi.advanceTimersByTime(5000);
      expect(released).toBe(0); // one job still running
      idle.end();
      vi.advanceTimersByTime(999);
      expect(released).toBe(0);
      idle.begin(); // a new job before the timer: cancelled
      vi.advanceTimersByTime(5000);
      expect(released).toBe(0);
      idle.end();
      vi.advanceTimersByTime(1000);
      expect(released).toBe(1);
      vi.advanceTimersByTime(5000);
      expect(released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a disposed (idle-released) pool starts fresh workers on the next page", async () => {
    const ws: FakeWorker[] = [];
    const pool = new RecPool(() => {
      const w = new FakeWorker(() => 1);
      ws.push(w);
      return w;
    }, 2);
    pool.prepare(new ArrayBuffer(8));
    pool.dispose();
    expect(ws.every((w) => w.dead)).toBe(true);
    pool.prepare(new ArrayBuffer(8));
    expect(ws.length).toBe(4);
    expect((await pool.run([task(5)], () => {}))[0].text).toBe("w5");
  });

  it("sizes the pool by cores and memory", () => {
    expect(poolSize(1)).toBe(1);
    expect(poolSize(4)).toBe(2);
    expect(poolSize(18)).toBe(6);
    expect(poolSize(18, 4)).toBe(2);
    expect(poolSize(8, 8)).toBe(4);
  });
});
