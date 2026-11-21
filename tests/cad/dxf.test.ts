// DXF import (docs/design/CAD_IMPORT.md): hand-made omni-cad-* drawings → layers, entities, blocks, text, hatches,
// dimensions, layouts; binary DXF; ACI colours; spline / MTEXT helpers; DWG container groundwork.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useLang } from "../../src/i18n";
import { makeAsset } from "../../src/core/assets";
import type { LayerGroup, Page, SceneNode, TextNode, VectorNode } from "../../src/core/types";
import { codeKind, dxfTags, readDxf, type Tag } from "../../src/io/formats/dxf";
import { buildCadPages, dashList, fontFamily, patternSegments, pickScale } from "../../src/io/formats/cad/build";
import { aciRgb } from "../../src/io/formats/cad/aci";
import { PathBuilder, bezierPieces, splinePath } from "../../src/io/formats/cad/geom";
import { parseMtext, textCodes } from "../../src/io/formats/cad/mtext";
import { cadKind } from "../../src/io/formats/sniff";
import { decompressDwg, decryptHeader, readDwgInfo } from "../../src/io/formats/dwg/container";
import { BitReader } from "../../src/io/formats/dwg/bits";
import { formatForExt } from "../../src/io/formats";
import { cadPoint, cadRulerTicks, setCadLayerLocked, setCadLayerVisible } from "../../src/ui/cad";
import { useStore } from "../../src/core/store";
import { newDocument } from "../../src/core/types";
import { packOmw, unpackOmw } from "../../src/io/omw";

useLang.getState().set("ko", false);

const fx = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/cad/${name}`));
const BASIC = fx("omni-cad-basic.dxf");

function build(bytes: Uint8Array, name = "omni-cad-basic") {
  const d = readDxf(bytes);
  const asset = makeAsset(bytes, "image/vnd.dxf", name + ".dxf");
  return { d, asset, ...buildCadPages(d, { name, format: "dxf", asset }) };
}

const groupNamed = (p: Page, name: string) => p.groups!.find((g) => g.name === name)!;
const inGroup = (p: Page, g: LayerGroup): SceneNode[] => {
  const ids = new Set([g.id, ...p.groups!.filter((x) => x.parentId === g.id).map((x) => x.id)]);
  return p.nodes.filter((n) => n.groupId && ids.has(n.groupId));
};
const wcs = (p: Page, pt: [number, number]) => cadPoint(p.source!.cad!, pt);
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * (1 + Math.abs(b));

describe("DXF reader", () => {
  it("reads the header, tables, blocks and entities of an AC1027 drawing", () => {
    const d = readDxf(BASIC);
    expect(d.version).toBe("AC1027");
    expect(d.insunits).toBe(4);
    expect(d.layers.size).toBe(10);
    expect(d.layers.get("HIDDEN-OFF")).toMatchObject({ on: false, color: 3 });
    expect(d.layers.get("LOCKED")?.locked).toBe(true);
    expect(d.layers.get("FROZEN")?.frozen).toBe(true);
    expect(d.layers.get("한글레이어")).toMatchObject({ plot: false, color: 30 });
    expect(d.layers.get("WALL")?.lw).toBe(50);
    expect(d.ltypes.get("DASHED")?.pattern).toEqual([10, -5]);
    expect(d.styles.get("ARIAL")).toMatchObject({ font: "Arial", widthFactor: 0.8 });
    expect(d.blocks.get("OMNI-DOOR")?.entities.map((e) => e.type)).toEqual(["LINE", "ARC", "CIRCLE"]);
    const types = d.entities.map((e) => e.type);
    for (const t of ["LWPOLYLINE", "LINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE", "TEXT", "MTEXT", "INSERT", "HATCH", "DIMENSION", "LEADER", "SOLID", "POINT", "XLINE", "VIEWPORT"]) expect(types).toContain(t);
    expect(d.unsupported).toEqual({ "3DSOLID": 1 });
    const ins = d.entities.find((e) => e.type === "INSERT")!;
    expect(ins.geom).toMatchObject({ k: "insert", block: "OMNI-DOOR", cols: 2, cs: 1000 });
    expect(ins.geom?.k === "insert" && ins.geom.attribs[0].geom).toMatchObject({ k: "text", text: "D-01" });
    expect(d.layouts.map((l) => l.name)).toEqual(["Model", "Layout1"]);
  });

  it("knows the value type of every group code range", () => {
    expect([0, 8, 10, 40, 62, 70, 90, 100, 140, 210, 280, 290, 310, 330, 370, 420, 1000, 1010, 1071].map(codeKind)).toEqual(["s", "s", "d", "d", "i16", "i16", "i32", "s", "d", "d", "i16", "b", "bin", "s", "i16", "i32", "s", "d", "i32"]);
  });

  it("reads R12 with the CP949 code page, POLYLINE / VERTEX / SEQEND and \\U+ escapes", () => {
    const { d, pages } = build(fx("omni-cad-r12-ko.dxf"), "omni-cad-r12-ko");
    expect(d.version).toBe("AC1009");
    expect([...d.layers.values()].map((l) => l.name)).toContain("도면층");
    const p = pages[0];
    expect(p.source?.cad?.unit).toBe("in");
    const poly = p.nodes.find((n) => n.type === "VECTOR") as VectorNode;
    expect(poly.contours[0].closed).toBe(true);
    // the bulge 1 segment is a half circle: curved handles
    expect(poly.contours[0].nodes.some((a) => a.handleOut[0] !== a.anchor[0] || a.handleOut[1] !== a.anchor[1])).toBe(true);
    const text = p.nodes.find((n) => n.type === "TEXT") as TextNode;
    // (an SHX style without a big font: the Hangul a run of its own, narrowed to the cell AutoCAD gives it)
    expect(text.paragraphs[0].runs.map((r) => r.text).join("")).toBe("한글 R12 °");
    expect(text.paragraphs[0].runs[0]).toMatchObject({ text: "한글", hscale: 80 });
  });

  it("reads binary DXF the same as ASCII", () => {
    const tags = dxfTags(BASIC);
    const bin = binaryDxf(tags);
    expect(cadKind(bin)).toBe("dxf");
    const a = readDxf(BASIC), b = readDxf(bin);
    expect(b.version).toBe("AC1027");
    expect(b.entities.map((e) => e.type)).toEqual(a.entities.map((e) => e.type));
    expect([...b.layers.keys()]).toEqual([...a.layers.keys()]);
    expect(JSON.stringify(b.entities[0].geom)).toBe(JSON.stringify(a.entities[0].geom));
  });
});

describe("DXF → pages", () => {
  const r = build(BASIC);
  const model = r.pages[0];

  it("makes a model page and a layout page, keeps the original file as an asset", () => {
    expect(r.pages.map((p) => p.name)).toEqual(["omni-cad-basic · 모형", "omni-cad-basic · 배치 Layout1"]);
    const cad = model.source!.cad!;
    expect(cad).toMatchObject({ format: "dxf", version: "AC1027", insunits: 4, unit: "mm", mmPerUnit: 1 });
    expect(r.assets[cad.assetId]?.hash).toBe(cad.hash);
    expect(r.assets[cad.assetId]?.size).toBe(BASIC.length);
    expect(cad.blocks).toEqual({ "OMNI-DOOR": 1 });
    expect([1, 2, 5]).toContain(cad.scale);
    expect(model.kind).toBe("DESIGN");
    // fits about an A0 sheet at the chosen scale
    expect(Math.max(model.width, model.height)).toBeLessThan(1189 * 3.78 * 1.2);
  });

  it("turns layers into layer groups with on/off, freeze, lock and plot", () => {
    const top = model.groups!.filter((g) => !g.parentId);
    expect(top.every((g) => g.cad?.layer === g.name)).toBe(true);
    expect(groupNamed(model, "HIDDEN-OFF").visible).toBe(false);
    expect(groupNamed(model, "FROZEN")).toMatchObject({ visible: false, cad: { frozen: true } });
    expect(groupNamed(model, "LOCKED").locked).toBe(true);
    expect(groupNamed(model, "한글레이어").cad).toMatchObject({ noPlot: true });
    expect(groupNamed(model, "WALL").cad).toMatchObject({ color: "#ff0000", lw: 0.5 });
    // fills (hatch / solid layers) are drawn first
    const order = top.map((g) => g.name);
    expect(order.indexOf("HATCH")).toBeLessThan(order.indexOf("TEXT"));
    // members of each group sit next to each other
    const seen = new Set<string>();
    let last = "";
    for (const n of model.nodes) {
      const g = model.groups!.find((x) => x.id === n.groupId)!;
      let t = g;
      while (t.parentId) t = model.groups!.find((x) => x.id === t.parentId)!;
      if (t.id !== last) {
        expect(seen.has(t.id)).toBe(false);
        seen.add(t.id);
        last = t.id;
      }
    }
  });

  it("draws entities as editable paths with colour, lineweight and line type", () => {
    const wall = inGroup(model, groupNamed(model, "WALL")).filter((n) => n.type === "VECTOR") as VectorNode[];
    const poly = wall.find((n) => n.name === "폴리선")!;
    expect(poly).toMatchObject({ stroke: "#ff0000", fill: null });
    expect(poly.strokeWidth).toBeCloseTo(0.5 * (96 / 25.4), 5);
    expect(poly.contours[0].closed).toBe(true);
    expect(poly.contours[0].nodes.some((a) => !a.isCorner || a.handleIn[0] !== a.anchor[0])).toBe(true);
    const dashed = wall.find((n) => n.strokeDash)!;
    expect(dashed.stroke).toBe("#00ff00");
    expect(dashed.strokeWidth).toBeCloseTo(0.35 * (96 / 25.4), 5);
    const k = model.source!.cad!.k;
    // laid out as AutoCAD does: whole dashes inside, the same partial dash at both ends (docs/design/FIDELITY_CAD.md)
    const dd = dashed.strokeDash!;
    expect(dd[1]).toBeCloseTo(5 * k, 6);
    expect(dd[2]).toBeCloseTo(10 * k, 6);
    expect(dd[0]).toBeCloseTo(dd[dd.length - 2], 6);
    // the mirrored arc (extrusion −Z): centre (−300, 600) in its OCS is (300, 600) in the drawing
    const arcs = wall.filter((n) => n.name === "호" && !n.groupId?.startsWith("x"));
    const mirrored = arcs.find((n) => {
      const a = wcs(model, n.contours[0].nodes[0].anchor);
      return close(a[0], 200, 1e-6) && close(a[1], 600, 1e-6);
    });
    expect(mirrored).toBeTruthy();
    const end = wcs(model, mirrored!.contours[0].nodes.at(-1)!.anchor);
    expect(end[0]).toBeCloseTo(300, 6);
    expect(end[1]).toBeCloseTo(700, 6);
    // a true colour beats the ACI
    const tc = inGroup(model, groupNamed(model, "한글레이어"))[0] as VectorNode;
    expect(tc.stroke).toBe("#3366cc");
    // construction line clipped to the page
    const xl = inGroup(model, groupNamed(model, "CENTER-LINES")).find((n) => n.name === "구성선") as VectorNode;
    expect(xl.contours[0].nodes.map((a) => Math.round(a.anchor[0]))).toEqual([0, model.width]);
    // the CENTER line type of the layer: dash, gap, dot, gap
    const center = inGroup(model, groupNamed(model, "CENTER-LINES")).find((n) => n.name === "선") as VectorNode;
    expect(center.strokeDash!.filter((v, i) => i % 2 === 0 && v === 0).length).toBeGreaterThan(0);
  });

  it("keeps an exact cubic spline and a closed ellipse", () => {
    const wall = inGroup(model, groupNamed(model, "WALL")) as VectorNode[];
    const sp = wall.find((n) => n.name === "스플라인")!;
    const nodes = sp.contours[0].nodes;
    expect(nodes.length).toBe(2);
    expect(wcs(model, nodes[0].handleOut)).toEqual([expect.closeTo(1400, 6), expect.closeTo(400, 6)]);
    expect(wcs(model, nodes[1].handleIn)).toEqual([expect.closeTo(1600, 6), expect.closeTo(0, 6)]);
    const el = wall.find((n) => n.name === "타원")!;
    expect(el.contours[0].closed).toBe(true);
    expect(el.contours[0].nodes.length).toBe(4);
  });

  it("turns a block insert (2 × 1 array) into a group; layer 0 takes the insert's layer, BYBLOCK its colour", () => {
    const door = groupNamed(model, "OMNI-DOOR");
    expect(door.cad).toEqual({ block: "OMNI-DOOR" });
    expect(door.parentId).toBe(groupNamed(model, "WALL").id);
    const members = model.nodes.filter((n) => n.groupId === door.id);
    // 2 copies × (line, arc, circle) + the attribute
    expect(members.length).toBe(7);
    const lines = members.filter((n) => n.name === "선") as VectorNode[];
    expect(lines.length).toBe(2);
    expect(lines.map((n) => n.stroke)).toEqual(["#ff0000", "#ff0000"]); // BYLAYER on layer 0 → WALL red
    expect((members.find((n) => n.name === "호") as VectorNode).stroke).toBe("#ffff00"); // BYBLOCK → insert colour 2
    // the second copy is 1000 to the right
    const x = lines.map((n) => wcs(model, (n as VectorNode).contours[0].nodes[0].anchor)[0]).sort((a, b) => a - b);
    expect(x[0]).toBeCloseTo(200, 6);
    expect(x[1]).toBeCloseTo(1200, 6);
    // the circle kept on DIM inside the WALL block remembers its own layer
    const circles = members.filter((n) => n.name === "원");
    expect(circles.map((n) => n.cadLayer)).toEqual(["DIM", "DIM"]);
    const attr = members.find((n) => n.type === "TEXT") as TextNode;
    expect(attr.paragraphs[0].runs[0].text).toBe("D-01");
  });

  it("reads TEXT special codes, alignment and MTEXT formatting", () => {
    const texts = inGroup(model, groupNamed(model, "TEXT")).filter((n) => n.type === "TEXT") as TextNode[];
    const plan = texts.find((n) => n.paragraphs[0].runs[0].text.includes("PLAN"))!;
    expect(plan.paragraphs[0].runs[0].text).toBe("⌀50 PLAN 도면 ±0.5");
    expect(plan.paragraphs[0].align).toBe("CENTER");
    expect(plan.paragraphs[0].runs[0].fontFamily).toBe("Omni Stroke Mono");
    // centre of the box sits on the alignment point (1000, 850)
    const cx = plan.transform.x + plan.width / 2;
    expect(wcs(model, [cx, 0])[0]).toBeCloseTo(1000, 3);
    const m = texts.find((n) => n.paragraphs.length === 3)!;
    const [p1, p2, p3] = m.paragraphs;
    expect(p1.runs[0]).toMatchObject({ text: "Bold", bold: true, fontFamily: "Arial", hscale: 80 });
    expect(p2.runs.find((r) => r.text.includes("red"))?.color).toBe("#ff0000");
    expect(p2.runs.find((r) => r.text.includes("under"))?.underline).toBe(true);
    const big = p2.runs.find((r) => r.text === "big")!;
    expect(big.fontSize / p2.runs[0].fontSize).toBeCloseTo(2, 6);
    // \S1/2; stacked: the lower part on the line, the upper part a text of its own above it with the bar (underline)
    expect(p3.runs.map((r) => r.text).join("")).toBe("third 2");
    const num = texts.find((n) => n.paragraphs.length === 1 && n.paragraphs[0].runs[0].text === "1")!;
    expect(num.paragraphs[0].runs[0].underline).toBe(true);
    expect(num.transform.rotation).toBe(m.transform.rotation);
    expect(r.warnings.some((w) => w.includes("txt"))).toBe(true);
  });

  it("fills a solid hatch, draws pattern lines clipped to the boundary, and keeps a dimension's block as a group", () => {
    const h = inGroup(model, groupNamed(model, "HATCH")) as VectorNode[];
    const solid = h.find((n) => n.fill)!;
    expect(solid).toMatchObject({ fill: "#808080", stroke: null, fillRule: "evenodd" });
    const pat = h.find((n) => !n.fill)!;
    expect(pat.name).toContain("ANSI31");
    expect(pat.contours.length).toBeGreaterThan(50);
    // every pattern segment lies inside the boundary box (1300..1700 × 400..800)
    for (const c of pat.contours)
      for (const a of c.nodes) {
        const [x, y] = wcs(model, a.anchor);
        expect(x).toBeGreaterThan(1300 - 1e-6);
        expect(x).toBeLessThan(1700 + 1e-6);
        expect(y).toBeGreaterThan(400 - 1e-6);
        expect(y).toBeLessThan(800 + 1e-6);
      }
    const dim = model.groups!.find((g) => g.cad?.block === "*D1")!;
    expect(dim.name).toBe("치수 1000");
    const dm = model.nodes.filter((n) => n.groupId === dim.id);
    expect(dm.map((n) => n.type).sort()).toEqual(["TEXT", "VECTOR", "VECTOR", "VECTOR"]);
  });

  it("reports what it could not draw", () => {
    expect(r.unsupported).toEqual({ "3DSOLID": 1 });
    expect(r.warnings.some((w) => w.includes("3DSOLID 1"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("뷰포트"))).toBe(true);
    expect(r.counts.LINE).toBeGreaterThanOrEqual(5);
  });

  it("draws the layout in paper units 1:1 with the viewport frame", () => {
    const lay = r.pages[1];
    expect(lay.source?.cad).toMatchObject({ layout: "Layout1", scale: 1 });
    const frame = lay.nodes.find((n) => n.name === "뷰포트") as VectorNode;
    const a = frame.contours[0].nodes.map((n) => wcs(lay, n.anchor));
    expect(a[0][0]).toBeCloseTo(23.5, 6);
    expect(a[2][1]).toBeCloseTo(180, 6);
  });

  it("rulers count in drawing coordinates, y upwards", () => {
    const cad = model.source!.cad!;
    const ticks = cadRulerTicks(cad, 0, model.width, 0.2, true).filter((t) => t.major);
    expect(ticks.some((t) => t.label === "0")).toBe(true);
    const zero = ticks.find((t) => t.label === "0")!;
    expect(wcs(model, [zero.pos, 0])[0]).toBeCloseTo(0, 6);
    const v = cadRulerTicks(cad, 0, model.height, 0.2, false).filter((t) => t.major && t.label === "0")[0];
    expect(wcs(model, [0, v.pos])[1]).toBeCloseTo(0, 6);
  });

  it("layer off / lock reaches block entities kept on that layer; undo; survives .omw", () => {
    const doc = newDocument("cad");
    doc.pages = r.pages;
    doc.assets = { ...r.assets };
    useStore.getState().load(doc);
    const S = () => useStore.getState();
    const pg = () => S().doc.pages[0];
    const dim = () => groupNamed(pg(), "DIM");
    const blockCircles = () => pg().nodes.filter((n) => n.cadLayer === "DIM");
    setCadLayerVisible(dim(), false);
    expect(dim().visible).toBe(false);
    expect(blockCircles().every((n) => !n.visible)).toBe(true);
    setCadLayerLocked(dim(), true);
    expect(blockCircles().every((n) => n.locked)).toBe(true);
    S().undo();
    S().undo();
    expect(dim().visible).toBe(true);
    expect(blockCircles().every((n) => n.visible && !n.locked)).toBe(true);
    // thawing a frozen layer
    setCadLayerVisible(groupNamed(pg(), "FROZEN"), true);
    expect(groupNamed(pg(), "FROZEN").cad?.frozen).toBeUndefined();
    const back = unpackOmw(packOmw(S().doc).bytes);
    const p0 = back.doc.pages[0];
    expect(p0.source?.cad?.k).toBe(pg().source?.cad?.k);
    expect(back.doc.assets[p0.source!.cad!.assetId]).toBeTruthy();
    expect(p0.nodes.filter((n) => n.cadLayer === "DIM").length).toBe(2);
    expect(groupNamed(p0, "WALL").cad?.color).toBe("#ff0000");
  });

  it("opens through the format registry", async () => {
    const f = formatForExt("dxf")!;
    const o = await f.open!({ name: "omni-cad-basic.dxf", bytes: BASIC } as never, { confirm: () => true });
    expect(o.pages?.length).toBe(2);
    expect(o.mode).toBe("DESIGN");
    expect(o.message).toMatch(/^DXF 도면 \(2013\) · 레이어 10개 · 개체 \d+개 · 축척 1:\d+/);
  });
});

describe("CAD helpers", () => {
  it("ACI colours", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(aciRgb)).toEqual([0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0x000000, 0x808080, 0xc0c0c0]);
    expect([10, 11, 12, 13, 14, 16, 18, 19, 20, 21, 30, 40, 50, 60, 130, 250, 255].map(aciRgb)).toEqual([0xff0000, 0xff7f7f, 0xa50000, 0xa55252, 0x7f0000, 0x4c0000, 0x260000, 0x261313, 0xff3f00, 0xff9f7f, 0xff7f00, 0xffbf00, 0xffff00, 0xbfff00, 0x00ffff, 0x333333, 0xffffff]);
  });

  it("line type patterns and plot scales", () => {
    expect(dashList([10, -5], 2)).toEqual([20, 10]);
    expect(dashList([-5, 10], 1)).toEqual([0, 5, 10, 0]);
    expect(dashList([12.7, -6.35, 0, -6.35], 1)).toEqual([12.7, 6.35, 0, 6.35]);
    expect(dashList([], 1)).toBeUndefined();
    expect(pickScale(800)).toBe(1);
    expect(pickScale(2400)).toBe(5);
    expect(pickScale(50000)).toBe(50);
    expect(pickScale(10)).toBe(0.05);
  });

  it("fonts: SHX → stand-in, TrueType by family", () => {
    expect(fontFamily("romans.shx")).toEqual({ family: "Omni Stroke", shx: "romans" });
    expect(fontFamily("txt")).toEqual({ family: "Omni Stroke Mono", shx: "txt" });
    expect(fontFamily("malgun.ttf").family).toBe("맑은 고딕");
    expect(fontFamily("Arial").family).toBe("Arial");
  });

  it("splits a uniform cubic B-spline into Bézier pieces exactly", () => {
    // 5 control points, clamped: two pieces meeting at the inserted knot
    const ctrl = [
      [0, 0, 1],
      [1, 2, 1],
      [2, 0, 1],
      [3, 2, 1],
      [4, 0, 1],
    ];
    const pieces = bezierPieces(3, [0, 0, 0, 0, 0.5, 1, 1, 1, 1], ctrl);
    expect(pieces.length).toBe(2);
    expect(pieces[0][0]).toEqual([0, 0, 1]);
    expect(pieces[1][3]).toEqual([4, 0, 1]);
    expect(pieces[0][3]).toEqual(pieces[1][0]);
    const b = new PathBuilder();
    splinePath(b, 3, [0, 0, 0, 0, 0.5, 1, 1, 1, 1], ctrl.map((c) => [c[0], c[1]]));
    expect(b.done()[0].nodes.length).toBe(3);
  });

  it("pattern lines stay inside an even-odd boundary with a hole", () => {
    const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole: [number, number][] = [[3, 3], [7, 3], [7, 7], [3, 7]];
    const segs = patternSegments([outer, hole], [{ angle: 0, base: [0, 0], offset: [0, 1], dashes: [] }])!;
    // y = 5 crosses the hole: two pieces
    const at5 = segs.filter((s) => s[0][1] === 5);
    expect(at5.map((s) => [s[0][0], s[1][0]])).toEqual([[0, 3], [7, 10]]);
  });

  it("MTEXT and TEXT codes", () => {
    expect(textCodes("%%uA%%u B %%d %%137").map((r) => [r.text, !!r.underline])).toEqual([["A", true], [" B ° \u0089", false]]);
    const p = parseMtext("a\\Pb{\\C3;c}d\\~e\\\\f");
    expect(p.length).toBe(2);
    expect(p[1].runs.map((r) => [r.text, r.aci])).toEqual([["b", undefined], ["c", 3], ["d e\\f", undefined]]);
    expect(parseMtext("\\pxqc;mid")[0].align).toBe("CENTER");
  });
});

describe("DWG groundwork", () => {
  it("knows the R2004 header XOR sequence", () => {
    const z = decryptHeader(new Uint8Array(8));
    expect(Array.from(z)).toEqual([0x29, 0x23, 0xbe, 0x84, 0xe1, 0x6c, 0xd6, 0xae]);
  });

  it("decompresses literal runs and back-references", () => {
    const src = new Uint8Array([0x01, 65, 66, 67, 68, 0x5c, 0x00, 0x11]);
    expect(new TextDecoder().decode(decompressDwg(src, 8))).toBe("ABCDABCD");
  });

  it("reads an R2000 section locator table and refuses a broken DWG with a clear message", async () => {
    const b = new Uint8Array(0x100);
    b.set(Array.from("AC1015", (c) => c.charCodeAt(0)));
    b[0x13] = 30;
    b[0x15] = 2;
    const rec = (i: number, num: number, seek: number, size: number) => {
      const o = 0x19 + i * 9;
      b[o] = num;
      new DataView(b.buffer).setUint32(o + 1, seek, true);
      new DataView(b.buffer).setUint32(o + 5, size, true);
    };
    rec(0, 0, 0x60, 0x40);
    rec(1, 1, 0xa0, 0x20);
    expect(cadKind(b)).toBe("dwg");
    const info = readDwgInfo(b);
    expect(info).toMatchObject({ version: "AC1015", release: "2000", codepage: 30 });
    expect(info.sections).toEqual([
      { name: "Header", seeker: 0x60, size: 0x40 },
      { name: "Classes", seeker: 0xa0, size: 0x20 },
    ]);
    await expect(formatForExt("dwg")!.open!({ name: "x.dwg", bytes: b } as never, { confirm: () => true })).rejects.toThrow(/DWG 2000.*DXF/);
  });

  it("bit stream values", () => {
    // BS 01 + char 0x05, BD 01 (1.0), BL 10 (0), B 1
    const r = new BitReader(new Uint8Array([0b01000001, 0b01011010, 0]));
    expect(r.BS()).toBe(5);
    expect(r.BD()).toBe(1);
    expect(r.BL()).toBe(0);
    expect(r.B()).toBe(1);
  });
});

/** Binary DXF from tags (R13+ layout: 2-byte codes), for the reader test. */
function binaryDxf(tags: Tag[]): Uint8Array {
  const parts: number[] = Array.from("AutoCAD Binary DXF\r\n\x1a\0", (c) => c.charCodeAt(0));
  const enc = new TextEncoder();
  for (const [c, v] of tags) {
    parts.push(c & 0xff, c >> 8);
    const k = codeKind(c);
    const dv = new DataView(new ArrayBuffer(8));
    if (k === "s") parts.push(...enc.encode(String(v)), 0);
    else if (k === "d") (dv.setFloat64(0, Number(v), true), parts.push(...new Uint8Array(dv.buffer)));
    else if (k === "i16") (dv.setInt16(0, Number(v), true), parts.push(...new Uint8Array(dv.buffer, 0, 2)));
    else if (k === "i32") (dv.setInt32(0, Number(v), true), parts.push(...new Uint8Array(dv.buffer, 0, 4)));
    else if (k === "i64") (dv.setBigInt64(0, BigInt(v), true), parts.push(...new Uint8Array(dv.buffer)));
    else if (k === "b") parts.push(Number(v));
    else {
      const hex = String(v);
      parts.push(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) parts.push(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  return new Uint8Array(parts);
}
