// 2026-11-25 (design 2): gradient mesh, opacity mask, perspective grid.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newVector, type Vec2, type VectorNode } from "../src/core/types";
import { corner, ellipseContour } from "../src/core/vector";
import { inverseBilinear, meshAddAt, meshRaster, newMesh } from "../src/core/mesh";
import { applyH, defaultGrid, invertH, planeMap, planeQuad, squareToQuad } from "../src/core/perspective";
import { addMeshPoint, makeOpacityMask, meshPaint, releaseOpacityMask, useMeshPick } from "../src/ui/designMesh";
import { drawOnPlane } from "../src/ui/designPersp";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;
const rect = (x: number, y: number, w: number, h: number, fill = "#ff0000") => {
  const v = newVector([{ closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }], "omni-rect");
  v.fill = fill;
  v.stroke = null;
  return v;
};
function load(...nodes: VectorNode[]) {
  const doc = newDocument();
  const p = newPage("DESIGN", 800, 600);
  p.nodes.push(...nodes);
  doc.pages = [p];
  S().load(doc);
  S().set({ pageId: p.id, selection: [], mode: "DESIGN" });
}
const near = (a: Vec2, b: Vec2, e = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1]) < e;

describe("gradient mesh", () => {
  it("inverse bilinear finds u, v on a skewed patch", () => {
    const a: Vec2 = [0, 0], b: Vec2 = [100, 10], c: Vec2 = [120, 90], d: Vec2 = [-10, 80];
    const P = (u: number, v: number): Vec2 => [
      (1 - u) * (1 - v) * a[0] + u * (1 - v) * b[0] + u * v * c[0] + (1 - u) * v * d[0],
      (1 - u) * (1 - v) * a[1] + u * (1 - v) * b[1] + u * v * c[1] + (1 - u) * v * d[1],
    ];
    const uv = inverseBilinear(P(0.3, 0.7), a, b, c, d)!;
    expect(uv[0]).toBeCloseTo(0.3, 6);
    expect(uv[1]).toBeCloseTo(0.7, 6);
  });
  it("a click adds a row and a column through the point; the raster blends from the coloured point", () => {
    const m0 = newMesh({ x: 0, y: 0, w: 100, h: 100 }, "#ffffff");
    const r = meshAddAt(m0, [50, 50], "#ff0000")!;
    expect([r.mesh.rows, r.mesh.cols, r.mesh.pts.length, r.index]).toEqual([2, 2, 9, 4]);
    expect(near(r.mesh.pts[4].p, [50, 50])).toBe(true);
    const px = meshRaster(r.mesh, 1);
    const at = (x: number, y: number) => [...px.data.slice((y * px.pw + x) * 4, (y * px.pw + x) * 4 + 4)];
    expect(at(50, 50)[0]).toBe(255);
    expect(at(50, 50)[1]).toBeLessThan(20);
    expect(at(1, 1)[1]).toBeGreaterThan(230);
    expect(at(25, 25)[1]).toBeGreaterThan(at(45, 45)[1]);
    // on an existing line only one line is added
    const r2 = meshAddAt(r.mesh, [25, 50])!;
    expect([r2.mesh.rows, r2.mesh.cols]).toEqual([2, 3]);
  });
  it("the Mesh tool: a click makes the mesh, the Fill field paints the picked point, SVG gets a clipped picture", async () => {
    const v = rect(100, 100, 200, 100, "#00ff00");
    load(v);
    S().set({ tool: "meshTool" });
    expect(addMeshPoint(page().nodes[0] as VectorNode, [200, 150])).toBe(true);
    expect(useMeshPick.getState().idx).toBe(4);
    S().commit("fill", (d) => {
      const x = d.pages[0].nodes[0];
      if (!meshPaint(x as never, "#0000ff")) (x as VectorNode).fill = "#0000ff";
    });
    const n = page().nodes[0] as VectorNode;
    expect(n.meshFill!.pts[4].c).toBe("#0000ff");
    expect(n.fill).toBe("#00ff00");
    const { exportSvg } = await import("../src/io/export");
    const svg = await exportSvg(S().doc, page()).catch(() => null);
    expect(svg).not.toBeNull();
    if (svg) {
      expect(svg).toMatch(/<clipPath id="mesh-/);
      expect(svg).toMatch(/<image clip-path="url\(#mesh-[^"]+\)"[^>]*href="data:image\/png;base64,/);
    }
    S().set({ tool: "select" });
  });
});

describe("opacity mask", () => {
  it("Make Mask: the top object masks the others by brightness; SVG luminance mask; Release puts it back on top", async () => {
    const art = rect(0, 0, 300, 300, "#ff0000");
    const maskArt = newVector([ellipseContour(150, 150, 100, 100)], "omni-mask");
    maskArt.fill = "#ffffff";
    load(art, maskArt);
    S().set({ selection: [art.id, maskArt.id] });
    expect(makeOpacityMask()).toBe(true);
    const ns = page().nodes;
    expect(ns.map((n) => n.id)).toEqual([maskArt.id, art.id]);
    expect(ns[0].lumMask).toBe(true);
    expect(ns[1].clip).toBe(true);
    const { exportSvg } = await import("../src/io/export");
    const svg = await exportSvg(S().doc, page()).catch(() => null);
    expect(svg).not.toBeNull();
    if (svg) {
      expect(svg).toMatch(/<mask id="[^"]+" mask-type="luminance"/);
      expect(svg).toMatch(/<g mask="url\(#/);
    }
    S().set({ selection: [art.id] });
    expect(releaseOpacityMask()).toBe(true);
    const back = page().nodes;
    expect(back.map((n) => n.id)).toEqual([art.id, maskArt.id]);
    expect(back.every((n) => !n.lumMask && !n.clip)).toBe(true);
  });
});

describe("perspective grid", () => {
  it("square-to-quad maps the corners and inverts", () => {
    const q: [Vec2, Vec2, Vec2, Vec2] = [[10, 20], [200, 40], [180, 160], [5, 140]];
    const H = squareToQuad(q);
    expect(near(applyH(H, [0, 0]), q[0], 1e-6) && near(applyH(H, [1, 0]), q[1], 1e-6) && near(applyH(H, [1, 1]), q[2], 1e-6) && near(applyH(H, [0, 1]), q[3], 1e-6)).toBe(true);
    const I = invertH(H);
    const p = applyH(H, [0.3, 0.6]);
    expect(near(applyH(I, p), [0.3, 0.6], 1e-6)).toBe(true);
  });
  it("two-point: a wall's lines run to its vanishing point, its upright edges stay upright", () => {
    const g = defaultGrid(800, 600, 2);
    const [a, b, c, d] = planeQuad(g, "left");
    expect(a[0]).toBeCloseTo(d[0], 6);
    expect(b[0]).toBeCloseTo(c[0], 6);
    // the bottom and top edges meet at the left vanishing point
    const m = planeMap(g, "left");
    const far = m.to([1e6, 0]), far2 = m.to([1e6, 1]);
    expect(far[0]).toBeCloseTo(g.vp1, 2);
    expect(far[1]).toBeCloseTo(g.horizon, 2);
    expect(far2[1]).toBeCloseTo(g.horizon, 2);
  });
  it("a rectangle drawn on the right wall becomes a perspective quad on it", () => {
    load();
    S().set({ view: { ...S().view, zoom: 1 } });
    const g = defaultGrid(800, 600, 2);
    const m = planeMap(g, "right");
    const a = m.to([0.2, 0.2]), b = m.to([0.6, 0.7]);
    expect(drawOnPlane(g, "right", "rect", a, b)).toBe(true);
    const v = page().nodes[0] as VectorNode;
    const pts = v.contours[0].nodes.map((x) => x.anchor);
    expect(pts.length).toBe(4);
    expect(pts.some((q) => near(q, a, 1e-6)) && pts.some((q) => near(q, b, 1e-6))).toBe(true);
    // left and right edges vertical, top and bottom edges not parallel (they converge to the right VP)
    expect(pts[0][0]).toBeCloseTo(pts[3][0], 6);
    const s1 = (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0]), s2 = (pts[2][1] - pts[3][1]) / (pts[2][0] - pts[3][0]);
    expect(Math.abs(s1 - s2)).toBeGreaterThan(0.01);
  });
});

describe("curved mesh, transforms, saved grid, perspective selection", () => {
  it("mesh lines are curves: a handle bends them, a new line splits a curve where it crosses it", async () => {
    const { meshSetHandle, patchPoint, H_DOWN, meshHandle } = await import("../src/core/mesh");
    const r = meshAddAt(newMesh({ x: 0, y: 0, w: 100, h: 100 }, "#ffffff"), [50, 50], "#ff0000")!;
    // the centre point's lower handle pulled to the right: the column line below it bends right
    const bent = meshSetHandle(r.mesh, 4, H_DOWN, [40, 16]);
    const mid = patchPoint(bent, 1, 0, 1, 0.3); // on the right side of the lower-left patch = that column line
    expect(mid[0]).toBeGreaterThan(55);
    const px = meshRaster(bent, 1);
    const g = (x: number, y: number) => px.data[(y * px.pw + x) * 4 + 1];
    expect(g(62, 70)).toBeLessThan(g(38, 70));
    // a click on the bent line's patch keeps the curve: the new point on the split column line sits on it
    const split = meshAddAt(bent, patchPoint(bent, 1, 0, 0.5, 0.5))!;
    expect(split.mesh.rows).toBe(3);
    const on = split.mesh.pts.find((p) => Math.abs(p.p[0] - mid[0]) < 3 && Math.abs(p.p[1] - mid[1]) < 12);
    expect(on || meshHandle(split.mesh, 2, 2, 0)).toBeTruthy();
  });
  it("a shear carries the mesh with the path (points and handles)", async () => {
    const { transformSelection } = await import("../src/ui/designPathOps");
    const v = rect(100, 100, 200, 100, "#00ff00");
    load(v);
    S().set({ tool: "meshTool" });
    addMeshPoint(page().nodes[0] as VectorNode, [200, 150]);
    S().set({ tool: "select", selection: [v.id] });
    transformSelection("shear", { angle: 30, axis: 0, origin: [200, 150] });
    const n = page().nodes[0] as VectorNode;
    const corners = n.contours[0].nodes.map((a) => a.anchor);
    const m = n.meshFill!;
    // the mesh's corners are the path's corners again
    for (const i of [0, 2, 6, 8]) expect(corners.some((c) => near(c, m.pts[i].p, 1e-6))).toBe(true);
    expect(near(m.pts[4].p, [200, 150], 1e-6)).toBe(true);
  });
  it("the page's grid and objects on it are saved in .omw", async () => {
    const { packOmw, unpackOmw } = await import("../src/io/omw");
    const { showGrid, drawOnPlane, currentGrid } = await import("../src/ui/designPersp");
    load();
    S().set({ view: { ...S().view, zoom: 1 } });
    showGrid(1);
    const g = currentGrid()!;
    expect(g.kind).toBe(1);
    const m = planeMap(g, "floor");
    expect(drawOnPlane(g, "floor", "ellipse", m.to([0.3, 0.2]), m.to([0.6, 0.5]))).toBe(true);
    const back = unpackOmw(packOmw(S().doc).bytes).doc;
    expect(back.pages[0].perspGrid).toEqual({ ...g });
    const v = back.pages[0].nodes[0] as VectorNode;
    expect(v.persp?.plane).toBe("floor");
    expect(v.contours[0].nodes.length).toBeGreaterThan(4);
  });
  it("PDF / AI: the grid goes into the page-piece data and comes back", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const { omwDataOf, setOmwData } = await import("../src/io/pdfsurgeon/omwPiece");
    const pdf = await PDFDocument.create();
    const pg = pdf.addPage([200, 200]);
    const grid = { ...defaultGrid(800, 600, 1), shown: true };
    expect(setOmwData(pdf.context, pg.node, { perspGrid: grid })).toBe(true);
    expect(setOmwData(pdf.context, pg.node, { perspGrid: grid })).toBe(false);
    const again = await PDFDocument.load(await pdf.save());
    expect(omwDataOf(again.context, again.getPage(0).node)?.perspGrid).toEqual(grid);
  });
  it("Perspective Selection: a path dropped on a plane is projected there and moves along it", async () => {
    const { showGrid, attachToPlane, currentGrid } = await import("../src/ui/designPersp");
    const v = rect(100, 100, 60, 40);
    load(v);
    showGrid(2);
    const g = currentGrid()!;
    const m = planeMap(g, "right");
    const to = m.to([0.3, 0.4]);
    expect(await attachToPlane([v.id], "right", [100, 100], to)).toBe(1);
    const n = page().nodes[0] as VectorNode;
    expect(n.persp?.plane).toBe("right");
    const pts = n.contours[0].nodes.map((a) => a.anchor);
    expect(near(pts[0], to, 1e-6)).toBe(true);
    // upright sides stay upright, the top and bottom run toward the right vanishing point
    expect(pts[0][0]).toBeCloseTo(pts[3][0], 6);
    const s1 = (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0]), s2 = (pts[2][1] - pts[3][1]) / (pts[2][0] - pts[3][0]);
    expect(Math.abs(s1 - s2)).toBeGreaterThan(0.005);
  });
});

describe("text on a perspective plane stays editable", () => {
  it("a double-click gives the outline paths back as the text itself, flat, and opens the editor on it", async () => {
    const { newText } = await import("../src/core/types");
    const { editPerspText } = await import("../src/ui/designPersp");
    const text = newText("PERSP", 200, { fontSize: 40 });
    text.transform = { x: 50, y: 60, rotation: 0, scale: 1 };
    const part = (name: string) => {
      const v = rect(500, 300, 20, 30);
      v.name = name;
      v.persp = { plane: "right", flat: v.contours, text, key: text.id, d: [400, 200] };
      return v;
    };
    const other = rect(0, 0, 10, 10);
    load(part("a"), other, part("b"));
    let opened: string | null = null;
    expect(editPerspText(page().nodes[0] as VectorNode, (n) => (opened = n.id))).toBe(true);
    const ns = page().nodes;
    expect(ns.map((n) => n.type)).toEqual(["TEXT", "VECTOR"]);
    expect(ns[0].id).toBe(text.id);
    expect(opened).toBe(text.id);
    expect(ns[0].transform).toEqual(text.transform);
  });
});
