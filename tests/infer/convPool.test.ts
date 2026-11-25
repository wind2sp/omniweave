// The conv pool (infer/convPool.ts): convs split across workers (by output channel, or by rows for MODNet's
// high-resolution layers) give the one-thread result.
// The workers here are in-process stand-ins running the same code as convWorker.ts (worker threads are a browser thing).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convNode, parseGraph, runGraph, runGraphAsync } from "../../src/core/image/infer/graph";
import { convLayer, runCpu, runCpuAsync, subLayer } from "../../src/core/image/infer/cpu";
import { parseModel, type ConvLayer } from "../../src/core/image/infer/model";
import { ConvPool, convPoolSize, partRange, type ConvWorkerMsg } from "../../src/core/image/infer/convPool";

/** an in-process pool worker: convWorker.ts's protocol, answering on a later tick */
function fakeWorker() {
  let part = 0, parts = 1;
  let g: ReturnType<typeof parseGraph> | null = null;
  let u: ReturnType<typeof parseModel> | null = null;
  const w = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null,
    terminate() {},
    postMessage(m: ConvWorkerMsg) {
      if (m.kind === "init") {
        (part = m.part), (parts = m.parts);
        if (m.model === "graph") g = parseGraph(new Uint8Array(m.bytes));
        else {
          const full = parseModel(new Uint8Array(m.bytes));
          u = full;
        }
        return;
      }
      const d = m.d.slice();
      setTimeout(() => {
        if (g) {
          const n = g.meta.nodes[m.layer];
          const r = m.pad ? convNode(g, { ...n, a: { ...n.a, pad: m.pad } }, { s: m.s, d }) : convNode(g, n, { s: m.s, d }, partRange(g.w.get(n.w!)!.s[0], part, parts));
          w.onmessage?.({ data: { id: m.id, s: r.s, d: r.d } } as MessageEvent);
        } else {
          const r = convLayer(u!, u!.layers[m.layer] as ConvLayer, { c: m.s[1], h: m.s[2], w: m.s[3], d });
          const [top, bh] = m.crop!;
          const o = new Float32Array(r.c * bh * r.w);
          for (let c = 0; c < r.c; c++) o.set(r.d.subarray((c * r.h + top) * r.w, (c * r.h + top + bh) * r.w), c * bh * r.w);
          w.onmessage?.({ data: { id: m.id, s: [1, r.c, bh, r.w], d: o } } as MessageEvent);
        }
      }, 0);
    },
  };
  return w;
}

describe("conv pool", () => {
  it("worker counts: cores − 1, a PC at most 8, a phone 2–4, none on one core", () => {
    expect(convPoolSize(22, false)).toBe(8);
    expect(convPoolSize(4, false)).toBe(3);
    expect(convPoolSize(1, false)).toBe(0);
    expect(convPoolSize(8, true)).toBe(4);
    expect(convPoolSize(2, true)).toBe(2);
    expect(partRange(64, 0, 3)).toEqual([0, 24]);
    expect(partRange(64, 2, 3)).toEqual([48, 64]);
    expect(partRange(16, 2, 3)).toEqual([16, 16]);
  });

  it("MODNet (graph): the same matte as one thread", async () => {
    const bytes = readFileSync("public/models/matte/modnet.lwt");
    const m = parseGraph(new Uint8Array(bytes));
    const pool = new ConvPool(fakeWorker, "graph", new Uint8Array(bytes).slice().buffer, 3);
    const x = { s: [1, 3, 96, 128], d: Float32Array.from({ length: 3 * 96 * 128 }, (_, i) => Math.sin(i * 0.01)) };
    const a = runGraph(m, { s: x.s, d: x.d.slice() });
    let used = 0;
    const b = await runGraphAsync(m, { s: x.s, d: x.d.slice() }, (i, n, t) => {
      const p = pool.graphConv(m, i, n, t);
      if (p) used++;
      return p;
    });
    expect(used).toBeGreaterThan(5);
    expect(b.s).toEqual(a.s);
    // (bands of rows have their own padding, so a band may run another conv kernel of the engine — the same sums in
    // another order: last-bit differences)
    let mx = 0;
    for (let k = 0; k < a.d.length; k++) mx = Math.max(mx, Math.abs(a.d[k] - b.d[k]));
    expect(mx).toBeLessThan(1e-5);
  }, 120_000);

  it("U²-Netp: the same saliency map as one thread", async () => {
    const bytes = readFileSync("src/assets/models/u2netp.lwt");
    const m = parseModel(new Uint8Array(bytes));
    const pool = new ConvPool(fakeWorker, "u2", new Uint8Array(bytes).slice().buffer, 4);
    const n = 3 * 320 * 320, x = Float32Array.from({ length: n }, (_, i) => Math.cos(i * 0.003));
    const a = runCpu(m, x.slice());
    let used = 0;
    const b = await runCpuAsync(m, x.slice(), (i, L, t) => {
      const p = pool.u2Conv(i, L, t);
      if (p) used++;
      return p;
    });
    expect(used).toBeGreaterThan(10);
    expect(Array.from(b)).toEqual(Array.from(a));
  }, 120_000);
});
