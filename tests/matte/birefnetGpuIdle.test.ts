// 배경 지우기(고품질): the BiRefNet GPU copy (≈ 1.3 GB) is freed after a minute unused and made again on the next use;
// the parsed model (and the kept file) stay. WebGPU is stood in for by a runner that counts what is made and freed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeGraphLwt } from "../../scripts/convert-birefnet.mjs";
import { runGraph, type GraphModel, type Tensor } from "../../src/core/image/infer/graph";

const made: GraphModel[] = [];
const freed: GraphModel[] = [];
const runners = new Map<GraphModel, { run(x: Tensor): Promise<Tensor> }>();
vi.mock("../../src/core/image/infer/graphGpu", () => ({
  graphGpuAvailable: () => true,
  graphGpu: async (m: GraphModel) => {
    let r = runners.get(m);
    if (!r) {
      made.push(m);
      r = { run: async (x: Tensor) => runGraph(m, x) };
      runners.set(m, r);
    }
    return r;
  },
  releaseGraphGpu: async (m: GraphModel) => {
    if (!runners.delete(m)) return false;
    freed.push(m);
    return true;
  },
  trimGraphGpu: () => {},
}));

const { birefnetMatte, setBirefnetGpuIdle, setBirefnetSource, BIREFNET_GPU_IDLE_MS } = await import("../../src/core/image/matte/birefnet");

/** a one-conv stand-in for the model (3 → 1 channels, sigmoid), written as the converter writes its files */
function tinyModel(): Uint8Array {
  const data = Float32Array.from({ length: 27 }, (_, i) => Math.sin(i) * 0.3);
  return writeGraphLwt({ nodes: [{ op: "conv", in: [0], out: [1], w: "w", act: "sigmoid", a: { stride: [1, 1], pad: [1, 1, 1, 1], dil: [1, 1], groups: 1 } }], weights: new Map([["w", { shape: [1, 3, 3, 3], data }]]), input: 0, output: 1 }, { name: "t", dtype: "f32" });
}
const img = { width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4).map((_, i) => (i * 37) & 255) };

describe("BiRefNet GPU copy freed when unused", () => {
  let reads = 0;
  beforeEach(() => {
    made.length = freed.length = 0;
    runners.clear();
    reads = 0;
    const bytes = tinyModel();
    setBirefnetSource(async () => (reads++, bytes));
  });
  afterAll(() => setBirefnetGpuIdle(BIREFNET_GPU_IDLE_MS));

  it("waits a minute by default", () => {
    expect(BIREFNET_GPU_IDLE_MS).toBe(60_000);
  });

  it("freed after the idle time, made again on the next use; the model file is read once", async () => {
    vi.useFakeTimers();
    try {
      setBirefnetGpuIdle(60_000, async (m) => (await import("../../src/core/image/infer/graphGpu")).releaseGraphGpu(m));
      const a = await birefnetMatte(img, { side: 64, pool: false });
      expect(a?.backend).toBe("webgpu");
      expect(made.length).toBe(1);
      // still in use within the minute: a second run reuses the same GPU copy and restarts the wait
      await vi.advanceTimersByTimeAsync(59_000);
      expect(freed.length).toBe(0);
      await birefnetMatte(img, { side: 64, pool: false });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(made.length).toBe(1);
      expect(freed.length).toBe(0);
      // a minute after the last run: freed
      await vi.advanceTimersByTimeAsync(1_500);
      expect(freed.length).toBe(1);
      // the next use uploads it again; the kept bytes / parsed model are not read again
      const b = await birefnetMatte(img, { side: 64, pool: false });
      expect(b?.backend).toBe("webgpu");
      expect(made.length).toBe(2);
      expect(Array.from(b!.map)).toEqual(Array.from(a!.map));
      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("not freed while a run is in flight", async () => {
    let calls = 0;
    setBirefnetGpuIdle(0, async () => void calls++);
    const p1 = birefnetMatte(img, { side: 64, pool: false });
    const p2 = birefnetMatte(img, { side: 64, pool: false });
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 20));
    // one release after the last of the two, none while the second was running
    expect(calls).toBe(1);
  });
});
