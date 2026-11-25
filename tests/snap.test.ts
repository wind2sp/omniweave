import { describe, expect, it } from "vitest";
import { buildSnapIndex, equalSpacing, nearRect, smartGuideSegments, snapAngle, snapAxis, snapPoint, snapRect } from "../src/core/snap";
import type { Rect } from "../src/core/geom";
import { cpuNow, cpuBudget } from "./budget";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const page = { width: 1000, height: 800 };

describe("snap index", () => {
  it("collects page edges and centre, guides and object edges/centres in sorted order", () => {
    const ix = buildSnapIndex({ page, guides: { x: [300], y: [50] }, objects: [R(100, 100, 50, 20)] });
    expect(ix.xs.map((l) => l.v)).toEqual([0, 100, 125, 150, 300, 500, 1000]);
    expect(ix.ys.map((l) => l.v)).toEqual([0, 50, 100, 110, 120, 400, 800]);
    expect(ix.xs.find((l) => l.v === 300)!.kind).toBe("guide");
    expect(ix.xs.find((l) => l.v === 125)!).toMatchObject({ kind: "object", lo: 100, hi: 120 });
  });

  it("can switch kinds off and ignores broken rectangles", () => {
    const ix = buildSnapIndex({ page, guides: { x: [5] }, objects: [R(NaN, 0, 1, 1), R(10, 10, 10, 10)], use: { page: false, guide: false } });
    expect(ix.xs.map((l) => l.v)).toEqual([10, 15, 20]);
    expect(buildSnapIndex({ page, objects: [R(1, 1, 1, 1)], use: { object: false } }).objects).toEqual([]);
  });
});

describe("snapAxis", () => {
  const ix = buildSnapIndex({ page, guides: { x: [303] }, objects: [R(200, 0, 100, 100)] });
  it("snaps within tolerance and returns the correction", () => {
    expect(snapAxis(ix.xs, null, [196], 6)).toMatchObject({ delta: 4, v: 200, kind: "object", which: 0 });
    expect(snapAxis(ix.xs, null, [190], 6)).toBeNull();
  });
  it("picks the closest of several positions (left / centre / right)", () => {
    // a 60 px box at x=468: centre 498 → page centre 500 (2px) beats left 468 (no line)
    const h = snapAxis(ix.xs, null, [468, 498, 528], 6)!;
    expect(h).toMatchObject({ v: 500, which: 1, kind: "page" });
  });
  it("prefers guides over objects on a tie, and objects over the grid", () => {
    const ix2 = buildSnapIndex({ guides: { x: [100] }, objects: [R(100, 0, 10, 10)] });
    expect(snapAxis(ix2.xs, null, [98], 5)!.kind).toBe("guide");
    expect(snapAxis(ix2.xs, null, [98], 5)!.lines.map((l) => l.kind)).toEqual(["guide", "object"]);
    const ix3 = buildSnapIndex({ objects: [R(40, 0, 10, 10)], grid: { size: 40, sub: 1 } });
    expect(snapAxis(ix3.xs, ix3.grid, [41], 5)!.kind).toBe("object");
  });
  it("snaps to grid subdivisions analytically", () => {
    const ix4 = buildSnapIndex({ grid: { size: 100, sub: 4 } });
    expect(snapAxis(ix4.xs, ix4.grid, [73], 3)).toMatchObject({ v: 75, kind: "grid", delta: 2 });
    expect(snapAxis(ix4.xs, ix4.grid, [-26], 3)).toMatchObject({ v: -25, kind: "grid" });
    expect(snapAxis(ix4.xs, ix4.grid, [62], 3)).toBeNull();
  });
});

describe("snapRect", () => {
  it("aligns a moving box edge to another object's edge on both axes", () => {
    const ix = buildSnapIndex({ objects: [R(100, 100, 80, 40)] });
    const s = snapRect(ix, R(183, 142, 50, 50), 5);
    // left edge 183 → right edge 180 ; top 142 → bottom 140
    expect(s.dx).toBeCloseTo(-3);
    expect(s.dy).toBeCloseTo(-2);
    expect(s.x!.v).toBe(180);
    expect(s.y!.v).toBe(140);
  });
  it("snaps centres to the page centre and can restrict to one axis", () => {
    const ix = buildSnapIndex({ page });
    const s = snapRect(ix, R(448, 300, 100, 100), 5, { y: false });
    expect(s.dx).toBe(2);
    expect(s.dy).toBe(0);
    expect(s.y).toBeNull();
  });
  it("edges-only mode ignores centres", () => {
    const ix = buildSnapIndex({ page });
    expect(snapRect(ix, R(448, 0.5, 100, 100), 3, { centers: false }).dx).toBe(0);
  });
  it("produces pink segments spanning the matched objects", () => {
    const ix = buildSnapIndex({ objects: [R(100, 0, 50, 50), R(100, 400, 30, 30)] });
    const r = R(102, 200, 40, 40);
    const s = snapRect(ix, r, 5);
    const segs = smartGuideSegments({ ...r, x: r.x + s.dx }, s);
    expect(segs[0]).toEqual({ x0: 100, y0: 0, x1: 100, y1: 430 });
  });
  it("does not draw segments for grid or guide hits", () => {
    const ix = buildSnapIndex({ guides: { x: [10] }, grid: { size: 50, sub: 1 } });
    const s = snapRect(ix, R(11, 49, 5, 5), 3, { centers: false });
    expect(s.x!.kind).toBe("guide");
    expect(s.y!.kind).toBe("grid");
    expect(smartGuideSegments(R(10, 50, 5, 5), s)).toEqual([]);
  });
});

describe("equal spacing", () => {
  const row = [R(0, 0, 100, 50), R(150, 0, 100, 50)]; // gap 50
  it("repeats an existing gap to the right of the last object", () => {
    const e = equalSpacing(R(297, 10, 100, 30), row, "x", 5)!;
    expect(e.delta).toBe(3); // 250 + 50 = 300
    expect(e.gap).toBe(50);
    expect(e.marks).toHaveLength(2);
    expect(e.marks[1]).toMatchObject({ a: 250, b: 300 });
  });
  it("repeats an existing gap to the left of the first object", () => {
    const objs = [R(300, 0, 100, 50), R(450, 0, 100, 50)];
    const e = equalSpacing(R(152, 0, 100, 50), objs, "x", 5)!;
    expect(e.delta).toBe(-2); // 300 - 50 - 100 = 150
  });
  it("centres a box between two neighbours", () => {
    const objs = [R(0, 0, 100, 50), R(350, 0, 100, 50)];
    const e = equalSpacing(R(173, 0, 100, 50), objs, "x", 5)!;
    expect(e.delta).toBe(2); // gaps (350 - 100 - 100) / 2 = 75 → x 175
    expect(e.gap).toBe(75);
  });
  it("ignores objects that are not in the same row", () => {
    expect(equalSpacing(R(297, 200, 100, 30), row, "x", 5)).toBeNull();
  });
  it("works vertically and is used by snapRect when it is closer", () => {
    const col = [R(0, 0, 50, 100), R(0, 140, 50, 100)]; // gap 40
    const ix = buildSnapIndex({ objects: col });
    const s = snapRect(ix, R(10, 282, 30, 50), 5, { equal: true });
    expect(s.dy).toBe(-2); // 240 + 40 = 280
    expect(s.gaps.map((g) => g.axis)).toEqual(["y", "y"]);
  });
});

describe("snapPoint and angles", () => {
  it("snaps a pen anchor to a guide crossing", () => {
    const ix = buildSnapIndex({ guides: { x: [120], y: [80] } });
    const p = snapPoint(ix, 117, 83, 4);
    expect([p.x, p.y]).toEqual([120, 80]);
    const q = snapPoint(ix, 110, 83, 4);
    expect([q.x, q.y]).toEqual([110, 80]);
    expect(q.hx).toBeNull();
  });
  it("snaps angles to 15° steps only when near (or always when forced)", () => {
    expect(snapAngle(43)).toBe(45);
    expect(snapAngle(38)).toBe(38);
    expect(snapAngle(38, 15, 4, true)).toBe(45);
    expect(snapAngle(-91)).toBe(-90);
  });
});

describe("performance on large pages", () => {
  it("indexes 10 000 objects and answers 1 000 moves quickly", () => {
    const objs: Rect[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 10_000; i++) objs.push(R(rnd() * 20000, rnd() * 20000, 10 + rnd() * 200, 10 + rnd() * 200));
    const t0 = cpuNow();
    const ix = buildSnapIndex({ page: { width: 20000, height: 20000 }, objects: objs, grid: { size: 100, sub: 4 } });
    const tBuild = cpuNow() - t0;
    const t1 = cpuNow();
    for (let i = 0; i < 1000; i++) snapRect(ix, R(rnd() * 20000, rnd() * 20000, 120, 80), 3, { equal: true });
    const tMoves = cpuNow() - t1;
    console.log(`snap perf: build ${tBuild.toFixed(1)} ms, ${(tMoves / 1000).toFixed(3)} ms per move`);
    // generous bounds (the full suite runs files in parallel); measured alone: build ~50 ms, ~0.1 ms per move
    expect(tBuild).toBeLessThan(cpuBudget(3000));
    expect(tMoves / 1000).toBeLessThan(cpuBudget(10));
    // viewport culling keeps only nearby candidates
    expect(nearRect(objs, R(0, 0, 2000, 1000), 100).length).toBeLessThan(objs.length / 20);
  });
});
