import { describe, expect, it } from "vitest";
import { addGuide, chunkPages, cleanGuides, flattenRanges, hitGuide, insertionIndex, mergedGuides, moveGuide, moveIdsTo, parsePageRanges, rangeLabel, removeGuide, resizePageInPlace, rotatePageInPlace } from "../src/core/pages";
import { applyTransform } from "../src/core/geom";
import { newImage, newPage } from "../src/core/types";
import { defaultGrid, defaultUnit, formatLength, fromUnit, parseLength, rulerSteps, rulerTicks, visibleGridStep } from "../src/core/units";

describe("page ranges", () => {
  it("parses ranges, open ends and singles", () => {
    expect(parsePageRanges("1-3, 5, 8-", 10).groups).toEqual([[0, 1, 2], [4], [7, 8, 9]]);
    expect(parsePageRanges("-2; 4~4", 5).groups).toEqual([[0, 1], [3]]);
    expect(parsePageRanges("3-1", 5).groups).toEqual([[2, 1, 0]]);
  });
  it("reports bad input instead of dropping pages", () => {
    expect(parsePageRanges("", 5).error).toBeTruthy();
    expect(parsePageRanges("1-x", 5).error).toMatch(/읽을 수 없는/);
    expect(parsePageRanges("2, 9", 5).error).toMatch(/9쪽은 없습니다/);
    expect(parsePageRanges("0", 5).error).toMatch(/1부터/);
  });
  it("flattens without repeats, chunks, labels", () => {
    expect(flattenRanges([[0, 1], [1, 2], [5]])).toEqual([0, 1, 2, 5]);
    expect(chunkPages(7, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(chunkPages(2, 0)).toEqual([[0], [1]]);
    expect(rangeLabel([4, 0, 1, 2, 7])).toBe("1-3, 5, 8");
  });
});

describe("ordering and insertion", () => {
  const L = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const ids = (l: { id: string }[]) => l.map((x) => x.id).join("");
  it("moves a set of pages before a target, keeping their order", () => {
    expect(ids(moveIdsTo(L, ["d", "b"], 0))).toBe("bdace");
    expect(ids(moveIdsTo(L, ["a"], 5))).toBe("bcdea");
    expect(ids(moveIdsTo(L, ["a", "b"], 4))).toBe("cdabe");
    expect(moveIdsTo(L, ["c"], 2)).toBe(L); // no-op keeps identity
    expect(moveIdsTo(L, ["zz"], 1)).toBe(L);
  });
  it("insertion index", () => {
    expect(insertionIndex("start", 3, 9)).toBe(0);
    expect(insertionIndex("end", 3, 9)).toBe(9);
    expect(insertionIndex("before", 3, 9)).toBe(3);
    expect(insertionIndex("after", 3, 9)).toBe(4);
    expect(insertionIndex({ afterPage: 2 }, 3, 9)).toBe(2);
    expect(insertionIndex({ afterPage: 99 }, 3, 9)).toBe(9);
  });
});

describe("rotate and resize pages", () => {
  it("quarter turn swaps the size and turns objects with the page (and back)", () => {
    const p = newPage("PDF", 800, 600);
    const img = newImage("a", 100, 50);
    img.transform = { x: 40, y: 30, rotation: 0, scale: 1 };
    p.nodes.push(img);
    p.guides = { x: [100], y: [200] };
    const corner = applyTransform(img.transform, [100, 50]);
    rotatePageInPlace(p, 1);
    expect([p.width, p.height]).toEqual([600, 800]);
    expect(img.transform.rotation).toBe(90);
    // the same local point lands where a clockwise turn of the page puts it: (x, y) → (H - y, x)
    const after = applyTransform(img.transform, [100, 50]);
    expect(after[0]).toBeCloseTo(600 - corner[1]);
    expect(after[1]).toBeCloseTo(corner[0]);
    expect(p.guides).toEqual({ x: [400], y: [100] });
    rotatePageInPlace(p, -1);
    expect([p.width, p.height]).toEqual([800, 600]);
    expect(img.transform).toMatchObject({ x: 40, y: 30, rotation: 0 });
    expect(p.guides).toEqual({ x: [100], y: [200] });
  });
  it("four turns are the identity; rotation stays in (-180, 180]", () => {
    const p = newPage("DESIGN", 300, 200);
    const img = newImage("a", 10, 10);
    img.transform = { x: 5, y: 7, rotation: 170, scale: 1 };
    p.nodes.push(img);
    for (let i = 0; i < 4; i++) rotatePageInPlace(p, 1);
    expect(img.transform.x).toBeCloseTo(5);
    expect(img.transform.y).toBeCloseTo(7);
    expect(img.transform.rotation).toBe(170);
    rotatePageInPlace(p, 1);
    expect(img.transform.rotation).toBe(-100);
  });
  it("resize with or without scaling content", () => {
    const p = newPage("DESIGN", 100, 100);
    const img = newImage("a", 10, 10);
    img.transform = { x: 50, y: 50, rotation: 0, scale: 1 };
    p.nodes.push(img);
    resizePageInPlace(p, 200, 100);
    expect(img.transform.x).toBe(50);
    resizePageInPlace(p, 400, 200, true);
    expect(img.transform).toMatchObject({ x: 100, y: 100, scale: 2 });
  });
});

describe("guides", () => {
  it("add / move / remove keep a clean sorted list and vanish when empty", () => {
    let g = addGuide(undefined, "x", 30);
    g = addGuide(g, "x", 10);
    g = addGuide(g, "x", 10);
    expect(g).toEqual({ x: [10, 30] });
    g = moveGuide(g, "x", 30, 5.12345);
    expect(g).toEqual({ x: [5.123, 10] });
    g = removeGuide(g, "x", 10);
    g = removeGuide(g, "x", 5.123);
    expect(g).toBeUndefined();
    expect(cleanGuides({ x: [NaN], y: [] })).toBeUndefined();
  });
  it("hit test and master merge", () => {
    expect(hitGuide({ x: [100], y: [50] }, 103, 400, 4)).toEqual({ axis: "x", v: 100 });
    expect(hitGuide({ x: [100], y: [50] }, 300, 52, 4)).toEqual({ axis: "y", v: 50 });
    expect(hitGuide({ x: [100] }, 110, 0, 4)).toBeNull();
    expect(mergedGuides({ guides: { x: [1] } }, { guides: { y: [2] } })).toEqual({ x: [1], y: [2] });
  });
});

describe("units and rulers", () => {
  it("parses and formats lengths", () => {
    expect(parseLength("25.4mm", "px")).toBeCloseTo(96);
    expect(parseLength("1 in", "px")).toBeCloseTo(96);
    expect(parseLength("72pt", "px")).toBeCloseTo(96);
    expect(parseLength("2,54 cm", "px")).toBeCloseTo(96);
    expect(parseLength("10", "mm")).toBeCloseTo(fromUnit(10, "mm"));
    expect(parseLength("-4px", "mm")).toBe(-4);
    expect(parseLength("abc", "px")).toBeNull();
    expect(parseLength("3 furlongs", "px")).toBeNull();
    expect(formatLength(96, "mm")).toBe("25.4 mm");
    expect(formatLength(100, "px")).toBe("100 px");
  });
  it("accepts unit words in Korean, English, Chinese and Japanese", () => {
    const mm = fromUnit(10, "mm");
    for (const s of ["10mm", "10 밀리", "10 밀리미터", "10 millimeters", "10 Millimetre", "10毫米", "10 ミリ", "10ミリメートル"])
      expect(parseLength(s, "px"), s).toBeCloseTo(mm);
    for (const s of ["1 cm", "1센티", "1 centimeter", "1厘米", "1公分", "1センチ"]) expect(parseLength(s, "px"), s).toBeCloseTo(fromUnit(1, "cm"));
    for (const s of ["1 inch", "1 inches", "1인치", "1英寸", "1インチ", '1"']) expect(parseLength(s, "px"), s).toBeCloseTo(96);
    for (const s of ["72 points", "72포인트", "72磅", "72ポイント"]) expect(parseLength(s, "px"), s).toBeCloseTo(96);
    for (const s of ["5 pixels", "5픽셀", "5像素", "5ピクセル"]) expect(parseLength(s, "mm"), s).toBe(5);
    expect(parseLength("3 尺", "px")).toBeNull();
  });
  it("defaults: mm for documents and PDF, px elsewhere", () => {
    expect(defaultUnit("DOCUMENT")).toBe("mm");
    expect(defaultUnit("PDF")).toBe("mm");
    expect(defaultUnit("DESIGN")).toBe("px");
    expect(defaultGrid("SLIDE")).toEqual({ size: 40, sub: 4 });
    expect(defaultGrid("DOCUMENT").size).toBeCloseTo(fromUnit(10, "mm"));
  });
  it("ruler steps follow 1-2-5 and keep labels apart at every zoom", () => {
    for (const zoom of [0.03, 0.1, 0.25, 0.5, 1, 2, 4, 8, 32])
      for (const u of ["px", "mm", "cm", "pt", "in"] as const) {
        const s = rulerSteps(zoom, u);
        expect(s.major * zoom).toBeGreaterThanOrEqual(56 - 1e-6);
        expect(s.major * zoom).toBeLessThan(56 * 5.01);
        expect((s.major / s.sub) * zoom).toBeGreaterThanOrEqual(5 - 1e-6);
        const lead = Number(s.unitStep.toExponential(6).split("e")[0]);
        expect([1, 2, 5]).toContain(lead);
      }
    expect(rulerSteps(1, "px")).toMatchObject({ major: 100, sub: 10, unitStep: 100 });
  });
  it("ticks carry labels in the unit", () => {
    const s = rulerSteps(1, "px");
    const t = rulerTicks(-15, 210, s);
    expect(t.filter((x) => x.major).map((x) => x.label)).toEqual(["0", "100", "200"]);
    expect(t[0].pos).toBe(-20);
    expect(rulerTicks(0, 1e9, s)).toEqual([]); // refuses absurd ranges
    const mm = rulerSteps(4, "mm");
    expect(rulerTicks(0, 200, mm).find((x) => x.major && x.pos > 0)!.label).toBe(String(mm.unitStep));
  });
  it("grid hides minor lines when they would be too dense", () => {
    expect(visibleGridStep({ size: 80, sub: 4 }, 1)).toEqual({ step: 20, every: 4 });
    expect(visibleGridStep({ size: 80, sub: 4 }, 0.2)).toEqual({ step: 80, every: 1 });
    expect(visibleGridStep({ size: 80, sub: 4 }, 0.05)).toBeNull();
  });
});
