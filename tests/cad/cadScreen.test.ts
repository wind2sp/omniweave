// The drawing screen (docs/design/CAD_SCREEN.md): AutoCAD coordinate entry, object snaps, TRIM splitting, and the
// command line driving real edits on an imported drawing (LINE, CIRCLE, MOVE, COPY, ROTATE, ERASE, OFFSET, TRIM,
// EXTEND, U), the design-mode profile of a drawing page and its keys.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentPage, useStore } from "../../src/core/store";
import { resetSessionsForTest } from "../../src/core/sessions";
import { newDocument, type VectorNode } from "../../src/core/types";
import { openInTab } from "../../src/ui/actions";
import "../../src/ui/tabs";
import { cadScreenNow, currentProfile, isCadScreen, useCadScreen } from "../../src/ui/editModes";
import { arc3, constrain, contourSegs, dist, I, nodeSegs, osnap, parseEntry, segsToContour, trimContour, type Seg, type W } from "../../src/ui/cad/geom";
import { cancel, complete, resolve, submit, useCmd, answer, currentLayer, startGrip, stretchGrip } from "../../src/ui/cad/engine";

const S = () => useStore.getState();
const seg = (a: W, b: W, id = "x"): Seg => ({ a, b, id, ci: 0, si: 0 });
const close = (p: readonly number[], q: readonly number[], e = 1e-6) => expect(dist(p, q)).toBeLessThan(e);

describe("coordinate entry", () => {
  it("absolute, relative, polar, last point and direct distance", () => {
    expect(parseEntry("10,20", null)).toEqual({ k: "point", p: [10, 20] });
    expect(parseEntry("@5,-5", [10, 20])).toEqual({ k: "point", p: [15, 15] });
    const p = parseEntry("@10<90", [1, 1]);
    expect(p?.k).toBe("point");
    close((p as { p: W }).p, [1, 11]);
    close((parseEntry("100<180", null) as { p: W }).p, [-100, 0]);
    expect(parseEntry("@", [3, 4])).toEqual({ k: "point", p: [3, 4] });
    expect(parseEntry("#2.5,-1e1", [9, 9])).toEqual({ k: "point", p: [2.5, -10] });
    expect(parseEntry("250", null)).toEqual({ k: "number", v: 250 });
    expect(parseEntry("x", null)).toBeNull();
  });
  it("ortho and polar tracking pull the cursor onto their angles", () => {
    close(constrain([0, 0], [10, 1], true, null), [Math.hypot(10, 1), 0]);
    const p = constrain([0, 0], [10, 9], false, 45);
    close(p, [Math.cos(Math.PI / 4) * (10 * Math.SQRT1_2 + 9 * Math.SQRT1_2), Math.sin(Math.PI / 4) * (10 * Math.SQRT1_2 + 9 * Math.SQRT1_2)]);
    expect(constrain([0, 0], [10, 4], false, 45)).toEqual([10, 4]); // 21.8° is outside the 5° tolerance
  });
});

describe("object snaps", () => {
  const segs = [seg([0, 0], [10, 0], "a"), seg([5, -5], [5, 5], "b")];
  const all = { end: true, mid: true, cen: true, int: true, per: true, tan: true };
  it("endpoint, midpoint, intersection — the closest wins", () => {
    expect(osnap(segs, [9.8, 0.1], 1, all)?.kind).toBe("end");
    expect(osnap(segs, [5.2, 0.2], 1, all)).toEqual({ kind: "int", p: [5, 0] });
    expect(osnap([segs[0]], [5.3, 0.2], 1, all)?.kind).toBe("mid");
    expect(osnap(segs, [2, 3], 0.5, all)).toBeNull();
  });
  it("perpendicular from the last point and the centre of a circle", () => {
    expect(osnap([segs[0]], [3.2, 0.3], 1, { per: true }, [3, 8])).toEqual({ kind: "per", p: [3, 0] });
    const c = segsToContour([], false, [1, 0, 0, 1, 0, 0]);
    expect(c.nodes.length).toBe(0);
    const arc = arc3([10, 0], [0, 10], [-10, 0])!;
    close(arc.c, [0, 0]);
    expect(arc.r).toBeCloseTo(10);
    expect(arc.a1 - arc.a0).toBeCloseTo(Math.PI);
  });
});

describe("TRIM splits a contour at its crossings", () => {
  it("an open line loses the picked middle piece", () => {
    const line = contourSegs({ closed: false, nodes: [[0, 0], [10, 0]].map((p) => ({ anchor: p as W, handleIn: p as W, handleOut: p as W, isCorner: true })) }, I);
    const pieces = trimContour(line, false, [0.3, 0.7], 0.5)!;
    expect(pieces.length).toBe(2);
    close(pieces[0][0].b, [3, 0]);
    close(pieces[1][0].a, [7, 0]);
    // the end piece: only one remains
    expect(trimContour(line, false, [0.3], 0.1)!.length).toBe(1);
    // nothing crosses it
    expect(trimContour(line, false, [], 0.5)).toBeNull();
  });
});

describe("command line on an imported drawing", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  beforeEach(async () => {
    S().load(newDocument());
    resetSessionsForTest();
    cancel(true);
    const bytes = new Uint8Array(readFileSync("tests/fixtures/cad/omni-cad-basic.dxf"));
    await openInTab({ name: "omni-cad-basic.dxf", path: null, bytes });
    S().set({ selection: [] });
  });
  const cad = () => currentPage()!.source!.cad!;
  const added = (before: Set<string>) => currentPage()!.nodes.filter((n) => !before.has(n.id));
  const ids = () => new Set(currentPage()!.nodes.map((n) => n.id));

  it("a drawing page is the drawing screen: the design profile without tool letters or slide show", () => {
    expect(cadScreenNow()).toBe(true);
    expect(currentProfile().toolKeys).toBe(false);
    expect(currentProfile().slideshow).toBe(false);
    // the drawing fixes its mode (UI_TOP_REDESIGN.md §2.3, 제품 결정 2026-11-20): a manual work mode chosen on another
    // page does not turn it into a document; only 보기 › 일반 디자인 화면 leaves the drawing screen
    expect(isCadScreen("DOCUMENT", currentPage())).toBe(true);
    expect(isCadScreen("AUTO", currentPage(), false)).toBe(false);
  });

  it("the drawing screen's status bar shows the sheet in paper mm and the plot scale (integ-0110: cad-3 kind on cad-ui bar)", async () => {
    const { paperKind, paperMm } = await import("../../src/ui/cad/CadScreen");
    expect(paperMm(793.7)).toBe("210");
    const pg = currentPage()!;
    expect(paperKind(pg)).toContain(`${paperMm(pg.width)} × ${paperMm(pg.height)} mm`);
    expect(readFileSync("src/ui/cad/CadScreen.tsx", "utf8")).toMatch(/cad-paper[^\n]*\n\s*\{paperKind\(page\)\}/);
  });

  it("aliases and AutoComplete", () => {
    expect(resolve("l")).toBe("LINE");
    expect(resolve("_rec")).toBe("RECTANG");
    expect(resolve("co")).toBe("COPY");
    expect(resolve("nothing")).toBeNull();
    expect(complete("DI")).toEqual(expect.arrayContaining(["DIST", "DIMLINEAR"]));
  });

  it("LINE draws one entity per segment on the current layer, @ relative and polar, Enter ends, Space repeats", () => {
    const before = ids();
    submit("L");
    submit("100,100");
    submit("@200,0");
    submit("@50<90");
    submit("");
    const made = added(before) as VectorNode[];
    expect(made.length).toBe(2);
    const segs = made.map((n) => nodeSegs(n, cad())[0]).sort((p, q) => p.a[1] - q.a[1] || p.a[0] - q.a[0]);
    close(segs[0].a, [100, 100], 1e-6);
    close(segs[0].b, [300, 100], 1e-6);
    close(segs[1].a, [300, 100], 1e-6);
    close(segs[1].b, [300, 150], 1e-6);
    const layer = currentLayer();
    const g = currentPage()!.groups!.find((x) => x.id === made[0].groupId)!;
    expect(g.cad?.layer).toBe(layer);
    expect(useCmd.getState().name).toBeNull();
    // Enter on an empty line repeats the last command
    submit("");
    expect(useCmd.getState().name).toBe("LINE");
    cancel(true);
    // U undoes the last segment
    S().undo();
    expect(added(before).length).toBe(1);
  });

  it("CIRCLE by centre and radius / diameter; MOVE, COPY, ROTATE, ERASE on it", () => {
    const before = ids();
    submit("C");
    submit("0,0");
    submit("25");
    const [c] = added(before) as VectorNode[];
    expect(c).toBeTruthy();
    for (const s of nodeSegs(c, cad())) expect(dist([0, 0], s.a)).toBeCloseTo(25, 6);
    S().set({ selection: [c.id] });
    submit("M");
    submit("0,0");
    submit("@10,5");
    const moved = currentPage()!.nodes.find((n) => n.id === c.id) as VectorNode;
    for (const s of nodeSegs(moved, cad())) expect(dist([10, 5], s.a)).toBeCloseTo(25, 6);
    S().set({ selection: [c.id] });
    submit("CO");
    submit("10,5");
    submit("@100,0");
    submit("@200,0");
    submit("");
    expect(added(before).length).toBe(3);
    S().set({ selection: [c.id] });
    submit("RO");
    submit("0,0");
    submit("90");
    const r = currentPage()!.nodes.find((n) => n.id === c.id) as VectorNode;
    const ctr = nodeSegs(r, cad()).map((s) => s.a).reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    close(ctr, [-5, 10], 1e-6);
    S().set({ selection: [c.id] });
    submit("E");
    expect(currentPage()!.nodes.some((n) => n.id === c.id)).toBe(false);
  });

  it("OFFSET a line to the picked side; TRIM between crossings; EXTEND to a boundary", () => {
    const before = ids();
    submit("L");
    submit("0,0");
    submit("100,0");
    submit("");
    const [h] = added(before);
    submit("O");
    submit("10");
    answer({ k: "pick", id: h.id, p: [50, 0] });
    submit("50,5");
    cancel(true);
    const off = added(before).filter((n) => n.id !== h.id) as VectorNode[];
    expect(off.length).toBe(1);
    const so = nodeSegs(off[0], cad())[0];
    expect(so.a[1]).toBeCloseTo(10, 6);
    expect(so.b[1]).toBeCloseTo(10, 6);

    // two verticals cross the line at x = 30 and x = 60; trimming at x = 45 removes 30..60
    const b2 = ids();
    for (const x of [30, 60]) {
      submit("L");
      submit(`${x},-20`);
      submit(`${x},20`);
      submit("");
    }
    expect(added(b2).length).toBe(2);
    submit("TR");
    answer({ k: "pick", id: h.id, p: [45, 0] });
    cancel(true);
    const trimmed = currentPage()!.nodes.find((n) => n.id === h.id) as VectorNode;
    const segs = nodeSegs(trimmed, cad());
    expect(segs.length).toBe(2);
    const xs = segs.flatMap((s) => [s.a[0], s.b[0]]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 6);
    expect(xs[1]).toBeCloseTo(30, 6);
    expect(xs[2]).toBeCloseTo(60, 6);
    expect(xs[3]).toBeCloseTo(100, 6);

    // a short line from x = 70 to 80 at y = -10 extends to the vertical at x = 60? no — towards +x there is nothing
    const b3 = ids();
    submit("L");
    submit("40,-10");
    submit("50,-10");
    submit("");
    const [e] = added(b3);
    submit("EX");
    answer({ k: "pick", id: e.id, p: [49, -10] });
    cancel(true);
    const ex = nodeSegs(currentPage()!.nodes.find((n) => n.id === e.id) as VectorNode, cad())[0];
    expect(Math.max(ex.a[0], ex.b[0])).toBeCloseTo(60, 6);
  });

  const line = (a: string, b: string) => {
    const before = ids();
    submit("L");
    submit(a);
    submit(b);
    submit("");
    return added(before)[0] as VectorNode;
  };
  const segsOfId = (id: string) => nodeSegs(currentPage()!.nodes.find((n) => n.id === id) as VectorNode, cad());

  it("FILLET: radius 0 meets at the corner; radius 10 trims both lines and adds the tangent arc", () => {
    const a = line("0,0", "100,0");
    const b = line("120,10", "120,100");
    submit("F");
    answer({ k: "pick", id: a.id, p: [50, 0] });
    answer({ k: "pick", id: b.id, p: [120, 50] });
    expect(useCmd.getState().name).toBeNull();
    close(segsOfId(a.id)[0].b, [120, 0]);
    close(segsOfId(b.id)[0].a, [120, 0]);
    const c = line("0,200", "100,200");
    const d = line("150,250", "150,300");
    const before = ids();
    submit("F");
    submit("R");
    submit("10");
    answer({ k: "pick", id: c.id, p: [50, 200] });
    answer({ k: "pick", id: d.id, p: [150, 280] });
    close(segsOfId(c.id)[0].b, [140, 200]);
    close(segsOfId(d.id)[0].a, [150, 210]);
    const arc = added(before) as VectorNode[];
    expect(arc.length).toBe(1);
    const as = nodeSegs(arc[0], cad());
    close(as[0].a, [140, 200]);
    close(as[as.length - 1].b, [150, 210]);
    // parallel lines cannot be filleted
    const e = line("0,400", "10,400");
    const f = line("0,410", "10,410");
    submit("F");
    answer({ k: "pick", id: e.id, p: [5, 400] });
    answer({ k: "pick", id: f.id, p: [5, 410] });
    expect(useCmd.getState().hist.at(-1)).toMatch(/모깎기할 수 없습니다/);
  });

  it("JOIN makes one polyline of lines that meet; EXPLODE splits it again", () => {
    const a = line("0,0", "10,0");
    const b = line("20,10", "10,0");
    const c = line("20,10", "0,0");
    S().set({ selection: [a.id, b.id, c.id] });
    submit("J");
    const pg = currentPage()!;
    expect(pg.nodes.some((n) => n.id === b.id || n.id === c.id)).toBe(false);
    const j = pg.nodes.find((n) => n.id === a.id) as VectorNode;
    expect(j.contours.length).toBe(1);
    expect(j.contours[0].closed).toBe(true);
    expect(nodeSegs(j, cad()).length).toBe(3);
    S().set({ selection: [a.id] });
    const before = ids();
    submit("X");
    const parts = currentPage()!.nodes.filter((n) => !before.has(n.id)) as VectorNode[];
    expect(parts.length).toBe(3);
    expect(currentPage()!.nodes.some((n) => n.id === a.id)).toBe(false);
    // one undo step brings the polyline back
    S().undo();
    expect(currentPage()!.nodes.some((n) => n.id === a.id)).toBe(true);
  });

  it("EXPLODE keeps an arc's Bézier pieces together and frees a block's members", () => {
    const before = ids();
    submit("C");
    submit("0,0");
    submit("25");
    const [circle] = added(before);
    S().set({ selection: [circle.id] });
    submit("X");
    expect(currentPage()!.nodes.some((n) => n.id === circle.id)).toBe(true);
    // an imported block: its group goes, its members stay
    const pg = currentPage()!;
    const blk = pg.groups?.find((g) => g.parentId && !g.cad?.layer);
    if (blk) {
      const member = pg.nodes.find((n) => n.groupId === blk.id)!;
      S().set({ selection: [member.id] });
      submit("X");
      expect(currentPage()!.groups?.some((g) => g.id === blk.id)).toBe(false);
      expect(currentPage()!.nodes.find((n) => n.id === member.id)?.groupId).toBe(blk.parentId);
    }
  });

  it("ARRAYRECT copies in columns and rows; a grip stretches one end of a line", () => {
    const a = line("0,0", "10,0");
    S().set({ selection: [a.id] });
    const before = ids();
    submit("AR");
    submit("3");
    submit("2");
    submit("20");
    submit("50");
    const copies = added(before) as VectorNode[];
    expect(copies.length).toBe(5);
    const starts = copies.map((n) => nodeSegs(n, cad())[0].a).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    close(starts[0], [20, 0]);
    close(starts[4], [40, 50]);
    S().set({ selection: [a.id] });
    startGrip(a.id, [10, 0]);
    submit("10,30");
    close(segsOfId(a.id)[0].b, [10, 30]);
    close(segsOfId(a.id)[0].a, [0, 0]);
    // the midpoint grip moves the whole line
    expect(stretchGrip(a.id, [5, 15], [6, 15])).toBe(true);
    close(segsOfId(a.id)[0].a, [1, 0]);
  });

  it("DIST reports distance and angle; Esc-style cancel leaves no command", () => {
    submit("DI");
    submit("0,0");
    submit("30,40");
    const last = useCmd.getState().hist.at(-1)!;
    expect(last).toMatch(/50/);
    submit("L");
    cancel();
    expect(useCmd.getState().name).toBeNull();
  });
});
