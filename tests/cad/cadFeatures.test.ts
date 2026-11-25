// The drawing screen's everyday AutoCAD commands (QA bux2 2026-11-24, "기본 작업은 편하게"): every acad.pgp alias runs
// the command AutoCAD runs (E = ERASE, not EXTEND) or is named as missing; hatches by internal point, STRETCH by
// crossing window, CHAMFER, BREAK, LENGTHEN, PEDIT, ELLIPSE, POLYGON, blocks kept as blocks (BLOCK, INSERT, BEDIT),
// dimensions, layer tools, MATCHPROP, LIST, and the R2000 DXF export read back.
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentPage, useStore } from "../../src/core/store";
import { resetSessionsForTest } from "../../src/core/sessions";
import { newDocument, type VectorNode } from "../../src/core/types";
import { openInTab } from "../../src/ui/actions";
import "../../src/ui/tabs";
import { useCadScreen } from "../../src/ui/editModes";
import { stretchGrip, answer, cancel, complete, resolve, submit, useCmd, NOT_HERE, textParts, bridge, blockEdit } from "../../src/ui/cad/engine";
import { ACAD_PGP } from "../../src/ui/cad/more";
import { nodeSegs, dist, type W } from "../../src/ui/cad/geom";
import { boundaryAt } from "../../src/ui/cad/hatch";
import { insertOf, blockNames } from "../../src/ui/cad/moreBlock";
import { listLines } from "../../src/ui/cad/moreEdit";
import { flushViewports } from "../../src/ui/cad/layout";
import { applyArrayGrip, arrayGrips, arrayOf, attachDrawing, editArray, reloadXrefs, selectionPage } from "../../src/ui/cad/moreExtra";
import { setCadFileReader } from "../../src/io/formats/cad/external";
import { writeDxf2000 } from "../../src/io/formats/cad/dxfWrite2000";
import { readDxf } from "../../src/io/formats/dxf";

const S = () => useStore.getState();
const pg = () => currentPage()!;
const cad = () => pg().source!.cad!;
const ids = () => new Set(pg().nodes.map((n) => n.id));
const added = (before: Set<string>) => pg().nodes.filter((n) => !before.has(n.id));
const segs = (id: string) => nodeSegs(pg().nodes.find((n) => n.id === id) as VectorNode, cad());
const run = (...lines: string[]) => lines.forEach((l) => submit(l));
const line = (a: string, b: string) => {
  const before = ids();
  run("L", a, b, "");
  return added(before)[0] as VectorNode;
};

describe("acad.pgp aliases", () => {
  it("an exact alias wins over the autocomplete list", () => {
    for (const [a, c] of Object.entries({ E: "ERASE", I: "INSERT", P: "PAN", LI: "LIST", RE: "REGEN", UN: "UNITS", S: "STRETCH", D: "DIMSTYLE", ME: "MEASURE", FI: "FILTER", MEA: "DIST", H: "HATCH", B: "BLOCK", T: "MTEXT", X: "EXPLODE", CHA: "CHAMFER", BR: "BREAK", PE: "PEDIT", EL: "ELLIPSE", POL: "POLYGON", MA: "MATCHPROP", QSE: undefined })) {
      if (!c) continue;
      expect(resolve(a), a).toBe(c);
      expect(complete(a)[0], a).toBe(c);
    }
  });
  it("every stock alias runs AutoCAD's command, or is named as not here — never another command", () => {
    for (const [a, c] of Object.entries(ACAD_PGP)) {
      const r = resolve(a);
      const want = c.toUpperCase().replace(/^-/, "");
      if (r) expect([want, "DIST", "PROPERTIES", "PLOT", "TEXTEDIT", "REGEN", "REDRAW", "LAYISO", "LAYUNISO", "U", "HATCH"], `${a} → ${r}`).toContain(r === want ? want : r);
      else expect(NOT_HERE[a.toUpperCase()], a).toBeTruthy();
      if (r && r !== want) expect(["MEASUREGEOM", "PROPERTIES", "QUICKPROPERTIES", "PROPERTIESCLOSE", "EXPORTPDF", "PLOT", "DDEDIT", "REGENALL", "REDRAWALL", "BHATCH", "ISOLATEOBJECTS", "UNISOLATEOBJECTS"]).toContain(c.toUpperCase());
    }
  });
});

describe("drawing commands on an imported drawing", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  beforeEach(async () => {
    S().load(newDocument());
    resetSessionsForTest();
    cancel(true);
    blockEdit.gid = blockEdit.name = null;
    const bytes = new Uint8Array(readFileSync("tests/fixtures/cad/omni-cad-basic.dxf"));
    await openInTab({ name: "omni-cad-basic.dxf", path: null, bytes });
    S().set({ selection: [] });
  });

  it("E erases (it used to run EXTEND)", () => {
    const a = line("1000,1000", "1010,1000");
    S().set({ selection: [a.id] });
    submit("E");
    expect(pg().nodes.some((n) => n.id === a.id)).toBe(false);
    expect(useCmd.getState().name).toBeNull();
  });

  it("ELLIPSE and POLYGON draw closed shapes of the asked size", () => {
    let before = ids();
    run("EL", "0,0", "20,0", "5");
    const el = added(before)[0] as VectorNode;
    expect(el.contours[0].closed).toBe(true);
    const xs = segs(el.id).flatMap((s) => [s.a[0], s.b[0]]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 4);
    before = ids();
    run("POL", "6", "100,100", "I", "10");
    const p = added(before)[0] as VectorNode;
    expect(p.contours[0].nodes.length).toBe(6);
    for (const s of segs(p.id)) expect(dist(s.a, [100, 100])).toBeCloseTo(10, 6);
  });

  it("HATCH by internal point fills the area four lines close (and its islands stay empty)", () => {
    line("500,500", "600,500");
    line("600,500", "600,560");
    line("600,560", "500,560");
    line("500,560", "500,500");
    const loops = boundaryAt([550, 530])!;
    expect(loops).toBeTruthy();
    const xs = loops[0].map((q) => q[0]), ys = loops[0].map((q) => q[1]);
    expect(Math.min(...xs)).toBeCloseTo(500, 6);
    expect(Math.max(...ys)).toBeCloseTo(560, 6);
    // the hatch: pattern ANSI31 then SOLID
    const before = ids();
    run("H", "550,530", "");
    const h = added(before) as VectorNode[];
    expect(h.length).toBe(1);
    expect(h[0].cadHatch?.pattern).toBe("ANSI31");
    expect(h[0].contours.length).toBeGreaterThan(5);
    run("H", "P", "SOLID", "550,530", "");
    const s = added(before).find((n) => !h.some((x) => x.id === n.id)) as VectorNode;
    expect(s.cadHatch?.pattern).toBe("SOLID");
    expect(s.fill).toBeTruthy();
    // HATCHEDIT: the scale
    S().set({ selection: [h[0].id] });
    run("HE", "SC", "2", "");
    const again = pg().nodes.find((n) => n.type === "VECTOR" && n.cadHatch?.pattern === "ANSI31") as VectorNode;
    expect(again.cadHatch!.scale).toBe(2);
    expect(again.contours.length).toBeLessThan(h[0].contours.length);
  });

  it("an associative hatch follows its boundary (STRETCH) and goes back with it on undo", () => {
    line("500,500", "600,500");
    line("600,500", "600,560");
    line("600,560", "500,560");
    line("500,560", "500,500");
    const before = ids();
    run("H", "P", "SOLID", "550,530", "");
    const h = added(before)[0] as VectorNode;
    expect(h.cadHatch?.src?.length).toBe(4);
    const maxX = () => Math.max(...(pg().nodes.find((n) => n.id === h.id) as VectorNode).cadHatch!.loops[0].map((q) => q[0]));
    expect(maxX()).toBeCloseTo(600, 6);
    submit("S");
    bridge.lastWin = { a: [610, 570], b: [590, 490], crossing: true };
    S().set({ selection: pg().nodes.filter((n) => n.type === "VECTOR" && !n.cadHatch && segs(n.id).some((s) => s.a[0] > 590 || s.b[0] > 590) && segs(n.id).every((s) => s.a[1] >= 499 && s.a[1] <= 561)).map((n) => n.id) });
    run("", "0,0", "@20,0");
    expect(maxX()).toBeCloseTo(620, 6);
    S().undo();
    expect(maxX()).toBeCloseTo(600, 6);
  });

  it("an imported hatch (no boundary objects recorded) finds them and follows when they move", () => {
    const b0 = ids();
    run("REC", "900,900", "960,940");
    const rect = added(b0)[0];
    const b1 = ids();
    run("H", "P", "ANSI31", "930,920", "");
    const h = added(b1)[0] as VectorNode;
    // as the importer leaves it: the definition without seed or boundary objects
    S().commit("strip", (d) => {
      const n = d.pages.find((p) => p.id === pg().id)!.nodes.find((x) => x.id === h.id) as any;
      delete n.cadHatch.src;
      delete n.cadHatch.seed;
    });
    S().set({ selection: [rect.id] });
    run("M", "0,0", "@0,100");
    const now = pg().nodes.find((n) => n.id === h.id) as VectorNode;
    expect(Math.min(...now.cadHatch!.loops[0].map((q) => q[1]))).toBeCloseTo(1000, 6);
  });

  it("an associative linear dimension follows the line end it measures; FENCE and LAYERSTATE on the command line", () => {
    const a = line("1200,1200", "1250,1200");
    const b0 = ids();
    run("DLI", "1200,1200", "1250,1200", "1225,1210");
    const txt = () => added(b0).find((n) => n.type === "TEXT") as any;
    expect(txt().paragraphs[0].runs[0].text).toBe("50");
    stretchGrip(a.id, [1250, 1200], [1280, 1200]);
    expect(txt().paragraphs[0].runs[0].text).toBe("80");
    // fence: a line of points selects what it crosses
    S().set({ selection: [] });
    submit("E");
    run("F", "1210,1190", "1210,1205", "");
    expect(S().selection).toContain(a.id);
    run("");
    expect(pg().nodes.some((n) => n.id === a.id)).toBe(false);
    run("LAS", "S", "OMNI-LS");
    expect(Object.keys(pg().source!.cad!.layerStates ?? {})).toContain("OMNI-LS");
  });

  it("associative array: ARRAYEDIT changes the columns; LTSCALE, LIMITS, WBLOCK page, XATTACH of a drawing", () => {
    const b0 = ids();
    run("C", "1500,1500", "5");
    const c0 = added(b0)[0];
    S().set({ selection: [c0.id] });
    run("AR", "R", "3", "2", "20", "30");
    const arr = arrayOf(pg(), c0.id)!;
    expect(arr.cad?.arr?.cols).toBe(3);
    const count = () => pg().nodes.filter((n) => n.type === "VECTOR" && n.name === c0.name && arrayOf(pg(), n.id)).length;
    expect(count()).toBe(6);
    S().set({ selection: [c0.id] });
    run("ARRAYEDIT", "COL", "5", "");
    expect(count()).toBe(10);
    // LTSCALE doubles every dash
    const dashed = pg().nodes.find((n) => n.type === "VECTOR" && n.strokeDash?.length) as VectorNode | undefined;
    if (dashed) {
      const d0 = dashed.strokeDash![0];
      run("LTS", "2");
      expect((pg().nodes.find((n) => n.id === dashed.id) as VectorNode).strokeDash![0]).toBeCloseTo(d0 * 2, 6);
    }
    run("LIMITS", "0,0", "420,297");
    expect(cad().limits).toEqual([[0, 0], [420, 297]]);
    // WBLOCK's page: just the objects (the whole array, picked as one), their layers
    const wb = selectionPage([c0.id])!;
    expect(wb.nodes.length).toBe(10);
    // XATTACH: a drawing placed as one block
    const other = JSON.parse(JSON.stringify(pg()));
    const b1 = ids();
    attachDrawing(other, "OMNI-XREF", [3000, 3000], 1);
    const got = added(b1);
    expect(got.length).toBeGreaterThan(5);
    expect(insertOf(pg(), got[0].id)?.cad?.block).toBe("OMNI-XREF");
  });

  it("array grips change the count and spacing; a path array is edited too; XREF Reload reads the file again", async () => {
    const b0 = ids();
    run("C", "1700,1700", "4");
    const c0 = added(b0)[0];
    S().set({ selection: [c0.id] });
    run("AR", "R", "2", "1", "20");
    let g = arrayOf(pg(), c0.id)!;
    const grips = arrayGrips(pg(), g.id);
    const colG = grips.find((x) => x.key === "cols")!;
    expect(colG.p[0]).toBeCloseTo(1720, 6);
    // dragging the column grip three spacings further: 5 columns
    applyArrayGrip(g.id, "cols", [1760, 1700]);
    g = arrayOf(pg(), c0.id)!;
    expect(g.cad!.arr!.cols).toBe(4);
    applyArrayGrip(g.id, "dx", [1730, 1700]);
    expect(arrayOf(pg(), c0.id)!.cad!.arr!.dx).toBeCloseTo(30, 6);
    // a path array along a line: 3 items, then 6
    const path = line("1800,1700", "1900,1700");
    const b1 = ids();
    run("C", "1800,1700", "3");
    const c1 = added(b1)[0];
    S().set({ selection: [c1.id] });
    submit("ARRAYPATH");
    answer({ k: "pick", id: path.id, p: [1850, 1700] });
    run("3", "N");
    const pa = arrayOf(pg(), c1.id)!;
    expect(pa.cad!.arr!.kind).toBe("path");
    editArray(pa.id, { n: 6 });
    const pa2 = arrayOf(pg(), c1.id)!;
    expect(pg().nodes.filter((n) => n.groupId === pa2.id).length).toBe(6);
    // XREF: attached with a path, read again (a reader stands in for the desktop's file system)
    const other = JSON.parse(JSON.stringify(pg()));
    const gid = attachDrawing(other, "OMNI-XR", [5000, 5000], 1, { xref: { path: "C:/qa/omni-xr.dxf", file: "OMNI-XR" } })!;
    const bytes = new Uint8Array(readFileSync("tests/fixtures/cad/omni-cad-basic.dxf"));
    setCadFileReader(async (p) => (p === "C:/qa/omni-xr.dxf" ? bytes : null));
    const n = await reloadXrefs(pg(), false);
    setCadFileReader(null);
    expect(n).toBe(1);
    const xr = pg().groups!.find((x) => x.id === gid)!;
    expect(xr.cad?.xref?.path).toBe("C:/qa/omni-xr.dxf");
    expect(pg().nodes.filter((x) => x.groupId === gid).length).toBeGreaterThan(3);
  });

  it("a hatch made by object selection follows its object when it moves", () => {
    const b0 = ids();
    run("REC", "700,700", "760,740");
    const rect = added(b0)[0];
    const b1 = ids();
    run("H", "P", "SOLID", "S");
    S().set({ selection: [rect.id] });
    run("", "");
    const h = added(b1)[0] as VectorNode;
    expect(h?.cadHatch?.src).toEqual([rect.id]);
    S().set({ selection: [rect.id] });
    run("M", "0,0", "@100,0");
    const now = pg().nodes.find((n) => n.id === h.id) as VectorNode;
    expect(Math.min(...now.cadHatch!.loops[0].map((q) => q[0]))).toBeCloseTo(800, 6);
  });

  it("LAYOUT and MVIEW: a paper page with a viewport at 1:100; REGEN draws it again; the DXF has the layout and VIEWPORTs", () => {
    run("C", "0,0", "50");
    const model = pg().id;
    run("LAYOUT", "N", "OMNI-L1", "A3");
    expect(pg().id).not.toBe(model);
    expect(pg().source!.cad!.layout).toBe("OMNI-L1");
    expect(pg().width / (96 / 25.4)).toBeCloseTo(420, 3);
    run("MVIEW", "10,10", "200,200", "100");
    const vp = (pg().groups ?? []).find((g) => g.cad?.vp)!;
    expect(vp.cad!.vp!.scale).toBeCloseTo(100, 6);
    const n0 = pg().nodes.filter((n) => n.groupId === vp.id).length;
    expect(n0).toBeGreaterThan(1);
    submit("RE");
    expect(pg().nodes.filter((n) => n.groupId === vp.id).length).toBe(n0);
    // the model changes: the viewport follows without REGEN
    const lay = pg().id;
    S().set({ pageId: model });
    run("C", "10,10", "20");
    flushViewports();
    expect(S().doc.pages.find((p) => p.id === lay)!.nodes.filter((n) => n.groupId === vp.id).length).toBe(n0 + 1);
    S().set({ pageId: lay });
    const text = new TextDecoder("latin1").decode(writeDxf2000(pg(), S().doc.pages).bytes);
    expect(text).toContain("OMNI-L1");
    expect((text.match(/\r\nVIEWPORT\r\n/g) ?? []).length).toBe(3);
  });

  it("STRETCH moves only the vertices in the crossing window", () => {
    const a = line("700,700", "800,700");
    bridge.lastWin = null;
    submit("S");
    // the canvas's crossing window around the right end
    bridge.lastWin = { a: [810, 710], b: [790, 690], crossing: true };
    S().set({ selection: [a.id] });
    run("", "0,0", "@20,0");
    const s = segs(a.id)[0];
    expect(s.a[0]).toBeCloseTo(700, 6);
    expect(s.b[0]).toBeCloseTo(820, 6);
  });

  it("CHAMFER, BREAK, LENGTHEN and PEDIT close", () => {
    const a = line("0,300", "50,300"), b = line("60,310", "60,360");
    run("CHA", "D", "5", "5");
    const before = ids();
    S().set({ selection: [] });
    // picks: on each line
    answer({ k: "pick", id: a.id, p: [20, 300] });
    answer({ k: "pick", id: b.id, p: [60, 340] });
    const cut = added(before)[0] as VectorNode;
    expect(cut).toBeTruthy();
    expect(segs(a.id)[0].b[0]).toBeCloseTo(55, 6);
    expect(segs(b.id)[0].a[1]).toBeCloseTo(305, 6);
    // BREAK a line in two
    const c = line("0,400", "100,400");
    const b2 = ids();
    submit("BR");
    answer({ k: "pick", id: c.id, p: [30, 400] });
    submit("60,400");
    expect(segs(c.id)[0].b[0]).toBeCloseTo(30, 4);
    const rest = added(b2)[0] as VectorNode;
    expect(segs(rest.id)[0].a[0]).toBeCloseTo(60, 4);
    // LENGTHEN by 10 at the right end
    submit("LEN");
    run("DE", "10");
    answer({ k: "pick", id: rest.id, p: [99, 400] });
    submit("");
    expect(segs(rest.id)[0].b[0]).toBeCloseTo(110, 4);
    // PEDIT: a polyline closes
    const b3 = ids();
    run("PL", "0,500", "50,500", "50,550", "");
    const pl = added(b3)[0] as VectorNode;
    S().set({ selection: [pl.id] });
    run("PE", "C", "");
    expect(pg().nodes.find((n) => n.id === pl.id)!.type === "VECTOR" && (pg().nodes.find((n) => n.id === pl.id) as VectorNode).contours[0].closed).toBe(true);
  });

  it("BLOCK makes one object; INSERT places another; COPY of a block stays a block; EXPLODE frees it", () => {
    const a = line("0,900", "10,900"), b = line("10,900", "10,910");
    S().set({ selection: [] });
    run("B", "OMNI-BLK", "0,900");
    S().set({ selection: [a.id, b.id] });
    submit("");
    const g = insertOf(pg(), a.id)!;
    expect(g?.cad?.block).toBe("OMNI-BLK");
    expect(new Set(textParts(pg(), [a.id]))).toEqual(new Set([a.id, b.id]));
    expect(blockNames(pg()).has("OMNI-BLK")).toBe(true);
    const before = ids();
    run("I", "OMNI-BLK", "100,900");
    const made = added(before) as VectorNode[];
    expect(made.length).toBe(2);
    const g2 = insertOf(pg(), made[0].id)!;
    expect(g2.id).not.toBe(g.id);
    expect(g2.cad!.ins!.p).toEqual([100, 900]);
    expect(Math.min(...made.flatMap((n) => segs(n.id).map((s) => s.a[0])))).toBeCloseTo(100, 6);
    // COPY: a block of its own
    S().set({ selection: [made[0].id] });
    const b2 = ids();
    run("CO", "0,0", "@0,50", "");
    const copies = added(b2);
    expect(copies.length).toBe(2);
    const g3 = insertOf(pg(), copies[0].id)!;
    expect(g3.id).not.toBe(g2.id);
    expect(g3.cad!.ins!.p[1]).toBeCloseTo(950, 6);
    // BEDIT: a part on its own, and BCLOSE carries a change to the other inserts
    S().set({ selection: [a.id] });
    submit("BE");
    expect(blockEdit.gid).toBe(g.id);
    expect(textParts(pg(), [a.id])).toEqual([a.id]);
    S().set({ selection: [a.id] });
    run("E");
    // what is drawn in the block editor goes into the block (it went to the layer, outside the block: realuse
    // cad-bedit 2026-11-25), and BCLOSE gives it to the other inserts
    const bl = ids();
    run("L", "0,0", "5,0", "");
    const drawnIn = added(bl)[0];
    expect(insertOf(pg(), drawnIn.id)?.id).toBe(g.id);
    run("BC", "Y");
    expect(blockEdit.gid).toBeNull();
    expect(pg().nodes.filter((n) => insertOf(pg(), n.id)?.id === g2.id).length).toBe(2);
    // EXPLODE
    S().set({ selection: copies.map((n) => n.id) });
    submit("X");
    expect(insertOf(pg(), copies[0].id)).toBeNull();
  });

  it("dimensions: radius, continue, baseline; one object each", () => {
    let before = ids();
    run("C", "300,300", "20");
    const circ = added(before)[0];
    before = ids();
    submit("DRA");
    answer({ k: "pick", id: circ.id, p: [320, 300] });
    submit("340,300");
    const dim = added(before);
    expect(dim.length).toBe(3);
    const txt = dim.find((n) => n.type === "TEXT")!;
    expect(txt.type === "TEXT" && txt.paragraphs[0].runs[0].text).toBe("R20");
    expect(new Set(textParts(pg(), [dim[0].id])).size).toBe(3);
    before = ids();
    run("DLI", "0,0", "10,0", "5,10");
    run("DCO", "30,0", "");
    run("DBA", "50,0", "");
    const texts = added(before).filter((n) => n.type === "TEXT").map((n) => (n.type === "TEXT" ? n.paragraphs[0].runs[0].text : ""));
    // ISO-25 suppresses trailing zeros; the baseline dimension after a continued one starts at that one's first origin (AutoCAD)
    expect(texts).toEqual(["10", "20", "40"]);
  });

  it("layer tools, MATCHPROP and LIST", () => {
    const layers = (pg().groups ?? []).filter((g) => !g.parentId && g.cad?.layer);
    expect(layers.length).toBeGreaterThan(1);
    const a = line("0,0", "5,5");
    S().set({ selection: [a.id] });
    submit("LAYISO");
    const on = (pg().groups ?? []).filter((g) => !g.parentId && g.cad?.layer && g.visible);
    expect(on.length).toBe(1);
    submit("LAYUNISO");
    expect((pg().groups ?? []).filter((g) => !g.parentId && g.cad?.layer && g.visible).length).toBeGreaterThan(1);
    const l = listLines([a.id]);
    expect(l.join(" ")).toMatch(/7\.07/);
  });

  it("the R2000 DXF export keeps hatches, blocks, arcs and lineweights, and reads back", () => {
    line("500,500", "600,500");
    line("600,500", "600,560");
    line("600,560", "500,560");
    line("500,560", "500,500");
    run("H", "P", "ANSI31", "550,530", "");
    run("C", "0,0", "10");
    run("A", "C", "50,0", "60,0", "50,10");
    const a = line("0,900", "10,900");
    S().set({ selection: [] });
    run("B", "OMNI-BLK", "0,900");
    S().set({ selection: [a.id] });
    submit("");
    run("I", "OMNI-BLK", "100,900");
    const r = writeDxf2000(pg());
    const text = new TextDecoder("latin1").decode(r.bytes);
    expect(text).toContain("AC1015");
    expect(text).toMatch(/\r\nHATCH\r\n/);
    expect(text).toMatch(/\r\nINSERT\r\n/);
    expect(text).toMatch(/\r\nOMNI-BLK\r\n/);
    expect(text).toMatch(/\r\nARC\r\n/);
    expect(text).toMatch(/\r\nCIRCLE\r\n/);
    const d = readDxf(r.bytes);
    expect(d.version).toMatch(/^AC101[58]$/);
    expect(d.blocks.has("OMNI-BLK")).toBe(true);
    const kinds = d.entities.map((e) => e.geom?.k);
    expect(kinds).toContain("hatch");
    expect(kinds).toContain("insert");
    expect(kinds).toContain("circle");
    expect(kinds).toContain("arc");
    expect(d.layers.size).toBeGreaterThan(1);
  });
});

void (null as unknown as W);

// AutoCAD check material (OMW_DXF_OUT=folder): the drawing screen's work exported as R2000 DXF, for accoreconsole
const REF29 = `${process.env.TEMP}/refs1124_cad/qa/interop/autocad-made/gui5/omni-cad-29-assoc-2018.dxf`;
describe.skipIf(!existsSync(REF29))("imported associativity (omni-cad-29-assoc, AutoCAD)", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  it("its hatches know their boundary objects and its dimensions their line; both follow", async () => {
    S().load(newDocument());
    resetSessionsForTest();
    cancel(true);
    await openInTab({ name: "omni-cad-29-assoc-2018.dxf", path: null, bytes: new Uint8Array(readFileSync(REF29)) });
    const hs = pg().nodes.filter((n) => n.type === "VECTOR" && n.cadHatch?.src?.length) as VectorNode[];
    expect(hs.length).toBeGreaterThanOrEqual(3);
    const dims = (pg().groups ?? []).filter((g) => g.cad?.dim?.assoc);
    expect(dims.length).toBe(2);
    // the measured line: its end moves 10 to the right, the horizontal dimension 55 becomes 65
    const a = dims[0].cad!.dim!.assoc!["14"] ?? dims[0].cad!.dim!.assoc!["13"]!;
    const before = dims.map((g) => g.cad!.dim!.measure);
    const ln = pg().nodes.find((n) => n.id === a.id) as VectorNode;
    const segs0 = nodeSegs(ln, cad());
    const end = a.i === 0 ? segs0[0].a : segs0[segs0.length - 1].b;
    stretchGrip(ln.id, end, [end[0] + 10, end[1]]);
    const after = (pg().groups ?? []).filter((g) => g.cad?.dim?.assoc).map((g) => g.cad!.dim!.measure);
    expect(after.some((m, i) => Math.abs(m - before[i]) > 1)).toBe(true);
    // a hatch boundary moved: the hatch goes with it
    const h = pg().nodes.find((n) => n.id === hs[0].id) as VectorNode;
    const src = h.cadHatch!.src![0];
    const x0 = Math.min(...h.cadHatch!.loops[0].map((q) => q[0]));
    S().set({ selection: [src] });
    run("M", "0,0", "@100,0");
    const h2 = pg().nodes.find((n) => n.id === h.id) as VectorNode;
    expect(Math.min(...h2.cadHatch!.loops[0].map((q) => q[0]))).toBeCloseTo(x0 + 100, 3);
  });
});

const OUT = process.env.OMW_DXF_OUT;
describe.skipIf(!OUT)("R2000 DXF files for AutoCAD", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  for (const src of ["omni-cad-02-layers-2018", "omni-cad-04-blocks-2018", "omni-cad-05-hatch-2018", "omni-cad-06-dims-2018", "omni-cad-07-layouts-2018", "omni-cad-13-dimstyles-2018", "omni-cad-17-gradients-2018", "omni-cad-18-attribs-2018", "omni-cad-28-hatchpatterns-2018", "omni-cad-29-assoc-2018"]) {
    it(src, async () => {
      const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
      // (28 · 29: the reference team's newest drawings, branch refs-1124, unpacked under TEMP)
      const path = /omni-cad-2[89]/.test(src) ? `${process.env.TEMP}/refs1124_cad/qa/interop/autocad-made/gui5/${src}.dxf` : `qa/interop/autocad-made/${src}.dxf`;
      if (!existsSync(path)) return;
      S().load(newDocument());
      resetSessionsForTest();
      cancel(true);
      await openInTab({ name: `${src}.dxf`, path: null, bytes: new Uint8Array(readFileSync(path)) });
      S().set({ selection: [] });
      // what the drawing screen adds: a hatch (pattern and solid), a block with an attribute and an insert, every dimension kind, a leader
      run("L", "5000,5000", "5100,5000", "5100,5060", "5000,5060", "C");
      run("H", "P", "ANSI31", "5050,5030", "");
      run("C", "5200,5030", "20");
      run("H", "P", "SOLID", "5200,5030", "");
      run("REC", "5550,5000", "5650,5060");
      run("GD", "5600,5030", "");
      const a = line("5300,5000", "5340,5000");
      run("ATT", "OMNI-TAG", "Value?", "D0", "5300,5005", "2.5");
      const att = pg().nodes.find((n) => n.type === "TEXT" && n.cadAttr?.tag === "OMNI-TAG")!;
      expect(att).toBeTruthy();
      S().set({ selection: [] });
      run("B", "OMNI-ATTBLK", "5300,5000");
      S().set({ selection: [a.id, att.id] });
      run("", "V1");
      run("I", "OMNI-ATTBLK", "5400,5000", "V2");
      run("DLI", "5000,4990", "5100,4990", "5050,4980");
      // an associative dimension on the rectangle's top corners (they are line ends)
      run("DLI", "5000,5060", "5100,5060", "5050,5075");
      run("DCO", "5160,4990", "");
      run("DAL", "5000,5000", "5100,5060", "5040,5050");
      const circ = pg().nodes.filter((n) => n.type === "VECTOR" && !n.cadHatch).find((n) => segs(n.id).some((s) => Math.abs(dist(s.a, [5220, 5030])) < 1e-6 || Math.abs(dist(s.b, [5220, 5030])) < 1e-6))!;
      submit("DRA");
      answer({ k: "pick", id: circ.id, p: [5220, 5030] });
      submit("5240,5050");
      submit("DDI");
      answer({ k: "pick", id: circ.id, p: [5220, 5030] });
      submit("5170,5010");
      run("DAN", "", "5000,5000", "5100,5000", "5000,5060", "5030,5020");
      run("MLD", "5100,5060", "5130,5090", "OMNI leader");
      // a layout (A3) with a viewport at 1:100 and another fitted
      run("LAYOUT", "N", "OMNI-L1", "A3");
      expect(pg().source!.cad!.layout).toBe("OMNI-L1");
      run("MVIEW", "10,10", "200,287", "100");
      run("MVIEW", "210,10", "410,287", "");
      expect((pg().groups ?? []).filter((g) => g.cad?.vp).length).toBe(2);
      expect(pg().nodes.length).toBeGreaterThan(2);
      const r = writeDxf2000(pg(), S().doc.pages);
      mkdirSync(OUT!, { recursive: true });
      writeFileSync(`${OUT}/omw-r2000-${src.replace("-2018", "")}.dxf`, r.bytes);
      // our PLOT of the layout (1:1 on its paper), to set beside AutoCAD's -PLOT of the same file
      const { plotPage } = await import("../../src/ui/cad/plot");
      const { exportPdfVector } = await import("../../src/io/pdfVector");
      const sheet = plotPage(pg(), { paper: "A3", landscape: true, scale: 1, area: "display", mono: true });
      const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
      const pdf = await exportPdfVector({ ...S().doc, pages: [sheet.page] } as any, [sheet.page], { fonts });
      writeFileSync(`${OUT}/omw-plot-${src.replace("-2018", "")}-layout.pdf`, (pdf as any).bytes ?? pdf);
      const d = readDxf(r.bytes);
      expect(d.version).toMatch(/^AC101[58]$/);
      const kinds = d.entities.map((e) => e.geom?.k);
      expect(kinds).toContain("dimension");
      expect(kinds).toContain("hatch");
    });
  }
});