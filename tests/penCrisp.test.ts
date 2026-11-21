// Pen-anchors QA: draw.ts fits straight h / v paths to device pixels and widens hairlines to one device pixel only
// on screen tiles (DrawEnv.screen); exports (PDF / PNG / SVG / print / thumbnails) keep the model's geometry and width,
// and rotated or non-uniformly scaled paths are drawn as modelled.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { drawNode, type DrawEnv } from "../src/render/draw";
import { newDocument, newVector, type VectorNode } from "../src/core/types";
import { rectContour } from "../src/core/vector";
import { crisp } from "../src/render/crisp";

class FakePath2D {
  constructor(public d = "") {}
}
beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D ??= FakePath2D;
});

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/** A recording 2D context with a real affine transform. */
function fakeCtx(base: M) {
  let m = base;
  const stack: M[] = [];
  const calls: { op: "fill" | "stroke"; d: string; lineWidth: number; m: M }[] = [];
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "round", lineCap: "round",
    save: () => void stack.push(m),
    restore: () => void (m = stack.pop() ?? m),
    translate: (x: number, y: number) => void (m = mul(m, [1, 0, 0, 1, x, y])),
    rotate: (a: number) => void (m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])),
    scale: (x: number, y: number) => void (m = mul(m, [x, 0, 0, y, 0, 0])),
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    setLineDash: () => {},
    fill: (p: FakePath2D) => void calls.push({ op: "fill", d: p.d, lineWidth: ctx.lineWidth, m }),
    stroke: (p: FakePath2D) => void calls.push({ op: "stroke", d: p.d, lineWidth: ctx.lineWidth, m }),
  };
  return { ctx, calls };
}

const env = (screen: boolean): DrawEnv => ({ doc: newDocument(), clip: { x: 0, y: 0, w: 1e4, h: 1e4 }, scale: 1, incomplete: false, onResourceReady: () => {}, screen });

function rect(w: number, opts: Partial<VectorNode["transform"]> = {}): VectorNode {
  const v = newVector([rectContour(0.3, 0.3, 50.2, 20.1)], "r");
  v.fill = "#ffffff";
  v.stroke = "#000000";
  v.strokeWidth = w;
  v.transform = { x: 10.17, y: 5.41, rotation: 0, scale: 1, ...opts };
  return v;
}
const nums = (d: string) => (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number);

afterEach(() => {
  crisp.snapContent = true;
});

describe("crisp vector paths (screen only)", () => {
  it("export / thumbnail paints keep the model's stroke width and coordinates at every scale", () => {
    for (const k of [0.25, 1, 1.25, 1.5, 3]) {
      for (const w of [0.1, 0.75, 4 / 3, 3]) {
        const { ctx, calls } = fakeCtx([k, 0, 0, k, 0, 0]);
        const n = rect(w);
        drawNode(ctx as never, n, env(false));
        const st = calls.find((c) => c.op === "stroke")!;
        expect(st.lineWidth).toBe(w);
        // the cached model path, not a fitted copy
        expect(nums(st.d)).toContain(0.3);
        expect(calls.find((c) => c.op === "fill")!.d).toBe(st.d);
      }
    }
  });

  it("on screen a rectangle's fill edges land on device pixels and its stroke covers whole pixels (dpr 1 / 1.25 / 1.5)", () => {
    for (const dpr of [1, 1.25, 1.5]) {
      const { ctx, calls } = fakeCtx([dpr, 0, 0, dpr, 0, 0]);
      drawNode(ctx as never, rect(4 / 3), env(true));
      const fill = calls.find((c) => c.op === "fill")!, st = calls.find((c) => c.op === "stroke")!;
      const [a, , , , e, f] = fill.m;
      const xs = nums(fill.d);
      for (let i = 0; i < xs.length; i += 2) {
        expect(Math.abs((a * xs[i] + e) % 1)).toBeLessThan(1e-6);
        expect(Math.abs((a * xs[i + 1] + f) % 1)).toBeLessThan(1e-6);
      }
      const dev = st.lineWidth * a;
      expect(Math.abs(dev - Math.round(dev))).toBeLessThan(1e-9);
      expect(dev).toBeGreaterThanOrEqual(1);
    }
  });

  it("on screen a hairline is at least one device pixel; a rotated path is drawn as modelled (only widened)", () => {
    const { ctx, calls } = fakeCtx([1.25, 0, 0, 1.25, 0, 0]);
    drawNode(ctx as never, rect(0.1, { rotation: 30 }), env(true));
    const st = calls.find((c) => c.op === "stroke")!;
    expect(nums(st.d)).toContain(0.3);
    expect(st.lineWidth * 1.25).toBeCloseTo(1, 9);
  });

  it("a non-uniformly scaled path is not fitted", () => {
    const { ctx, calls } = fakeCtx([1.5, 0, 0, 1.5, 0, 0]);
    drawNode(ctx as never, rect(1, { scaleY: 2 }), env(true));
    expect(nums(calls.find((c) => c.op === "stroke")!.d)).toContain(0.3);
    expect(nums(calls.find((c) => c.op === "fill")!.d)).toContain(0.3);
  });
});
