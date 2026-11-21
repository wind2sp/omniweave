import { describe, expect, it } from "vitest";
import { alignDeltas, boundsOf, distributeDeltas, distributeGap, referenceRect } from "../src/core/align";
import type { Rect } from "../src/core/geom";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const move = (rs: Rect[], d: [number, number][]) => rs.map((r, i) => R(r.x + d[i][0], r.y + d[i][1], r.w, r.h));
const page = { width: 1000, height: 600 };

describe("align", () => {
  const rs = [R(10, 10, 100, 50), R(200, 80, 40, 40), R(50, 300, 60, 20)];
  const sel = boundsOf(rs);
  it("bounds of the selection", () => expect(sel).toEqual(R(10, 10, 230, 310)));
  it("left / centre / right to the selection", () => {
    expect(move(rs, alignDeltas(rs, "left", sel)).map((r) => r.x)).toEqual([10, 10, 10]);
    expect(move(rs, alignDeltas(rs, "right", sel)).map((r) => r.x + r.w)).toEqual([240, 240, 240]);
    expect(move(rs, alignDeltas(rs, "hcenter", sel)).map((r) => r.x + r.w / 2)).toEqual([125, 125, 125]);
    expect(alignDeltas(rs, "left", sel).every(([, dy]) => dy === 0)).toBe(true);
  });
  it("top / middle / bottom", () => {
    expect(move(rs, alignDeltas(rs, "top", sel)).map((r) => r.y)).toEqual([10, 10, 10]);
    expect(move(rs, alignDeltas(rs, "bottom", sel)).map((r) => r.y + r.h)).toEqual([320, 320, 320]);
    expect(move(rs, alignDeltas(rs, "vcenter", sel)).map((r) => r.y + r.h / 2)).toEqual([165, 165, 165]);
  });
  it("references: page, key object, and single-object fallback to the page", () => {
    expect(referenceRect("page", rs, page)).toEqual(R(0, 0, 1000, 600));
    expect(referenceRect("key", rs, page, 1)).toEqual(rs[1]);
    expect(referenceRect("key", rs, page, -1)).toEqual(sel);
    expect(referenceRect("selection", [rs[0]], page)).toEqual(R(0, 0, 1000, 600));
    const keyed = move(rs, alignDeltas(rs, "left", referenceRect("key", rs, page, 1)));
    expect(keyed[1]).toEqual(rs[1]); // the key object does not move
    expect(keyed.map((r) => r.x)).toEqual([200, 200, 200]);
  });
});

describe("distribute", () => {
  it("equal horizontal gaps, outer boxes stay, order by position (input order irrelevant)", () => {
    const rs = [R(500, 0, 100, 10), R(0, 0, 100, 10), R(130, 0, 50, 10), R(300, 0, 20, 10)];
    const out = move(rs, distributeDeltas(rs, "x"));
    expect(out[1].x).toBe(0);
    expect(out[0].x).toBe(500);
    // total width 270, span 600 → gap 110
    const sorted = [...out].sort((a, b) => a.x - b.x);
    const gaps = sorted.slice(1).map((r, i) => r.x - (sorted[i].x + sorted[i].w));
    gaps.forEach((g) => expect(g).toBeCloseTo(110));
    expect(distributeGap(rs, "x")).toBeCloseTo(110);
  });
  it("vertical, and across the page", () => {
    const rs = [R(0, 0, 10, 100), R(0, 120, 10, 100)];
    expect(distributeDeltas(rs, "y")).toEqual([[0, 0], [0, 0]]); // needs 3
    const out = move(rs, distributeDeltas(rs, "y", R(0, 0, 1000, 600)));
    expect(out[0].y).toBe(0);
    expect(out[1].y + out[1].h).toBe(600);
  });
  it("overlapping boxes still get equal (negative) gaps", () => {
    const rs = [R(0, 0, 100, 10), R(20, 0, 100, 10), R(100, 0, 100, 10)];
    const out = move(rs, distributeDeltas(rs, "x"));
    expect(out[1].x).toBeCloseTo(50);
  });
});
