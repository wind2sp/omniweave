// Gradient-filled shapes as editable vectors (2026-11-23): SVG linear / radial gradients, clip paths and white masks,
// and Illustrator / PDF gradient shapes (a clip path with a shading painted through it) — drawn, exported as SVG,
// kept in .omw, and their PDF counterpart removed from the page background when they are elevated or deleted.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { newDocument, newPage, newVector, type VectorNode } from "../src/core/types";
import { corner } from "../src/core/vector";
import type { Paint } from "../src/core/style/types";
import { svgToVectors } from "../src/io/svgVectors";

type GV = VectorNode & { fills?: Paint[] };
let cv: typeof import("@napi-rs/canvas");
beforeAll(async () => {
  (globalThis as any).DOMParser ??= DOMParser;
  cv = await import("@napi-rs/canvas");
  const g = globalThis as any;
  g.ImageData ??= cv.ImageData;
  g.Path2D ??= cv.Path2D;
  g.OffscreenCanvas ??= class {
    constructor(w: number, h: number) {
      return cv.createCanvas(w, h) as any;
    }
  };
});

const SVG = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">${body}</svg>`;

describe("SVG gradients, clip paths and masks open as objects", () => {
  it("linear and radial gradients become gradient fills over the shape's box", () => {
    const art = svgToVectors(SVG(`<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="blue"/></linearGradient>
      <radialGradient id="r" href="#g"/></defs>
      <rect x="20" y="20" width="200" height="100" fill="url(#g)"/><circle cx="300" cy="80" r="60" fill="url(#r)"/>`))!;
    expect(art).not.toBeNull();
    const [a, b] = art.nodes as GV[];
    expect(a.fills?.[0]).toMatchObject({ type: "gradient", kind: "linear", from: [0, 0], to: [1, 0] });
    expect((a.fills![0] as any).stops.map((s: any) => s.color.hex)).toEqual(["#ff0000", "#0000ff"]);
    // the plain colour older versions draw: the opacity-weighted average, not the first stop
    expect(a.fill).toBe("#800080");
    // the radial gradient took its stops from the gradient it points to
    expect(b.fills?.[0]).toMatchObject({ kind: "radial" });
    expect((b.fills![0] as any).from[0]).toBeCloseTo(0.5, 2);
    expect((b.fills![0] as any).to[0]).toBeCloseTo(1, 2);
  });
  it("a clip path cuts a filled shape; a white mask works as a clip; a grey mask keeps one picture", () => {
    const art = svgToVectors(SVG(`<defs><clipPath id="c"><rect x="0" y="0" width="50" height="50"/></clipPath><mask id="m"><rect x="0" y="0" width="30" height="100" fill="white"/></mask></defs>
      <rect x="20" y="20" width="100" height="100" fill="#0a0" clip-path="url(#c)"/><rect x="0" y="60" width="100" height="20" fill="#00a" mask="url(#m)"/>`))!;
    expect(art.nodes.length).toBe(2);
    const xs = (n: VectorNode) => n.contours[0].nodes.map((p) => p.anchor[0]);
    expect(Math.max(...xs(art.nodes[0] as VectorNode))).toBeCloseTo(50, 3);
    expect(Math.max(...xs(art.nodes[1] as VectorNode))).toBeCloseTo(30, 3);
    expect(svgToVectors(SVG(`<defs><mask id="m"><rect width="30" height="30" fill="#888"/></mask></defs><rect width="10" height="10" fill="#000" mask="url(#m)"/>`))).toBeNull();
  });
  it("a gradient stroke and a radial gradient with a focus come in as they are", () => {
    const art = svgToVectors(SVG(`<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
      <radialGradient id="r" fx="0.25" fy="0.5" fr="0.1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs>
      <path d="M0 0L100 0" stroke="url(#g)" stroke-width="4" fill="none"/><rect x="0" y="20" width="100" height="100" fill="url(#r)"/>`))!;
    expect(art).not.toBeNull();
    const [s, r] = art.nodes as (GV & { strokes?: { paint: Paint }[] })[];
    expect(s.strokes?.[0].paint).toMatchObject({ type: "gradient", kind: "linear" });
    expect(s.stroke).toBe("#800080");
    const f = r.fills![0] as any;
    expect(f.focal[0]).toBeCloseTo(0.25, 3);
    expect(f.focalRadius).toBeCloseTo(0.2, 3);
  });
});

describe("drawing and keeping gradient fills", () => {
  const rect = (): GV => {
    const v = newVector([{ closed: true, nodes: [corner(0, 0), corner(100, 0), corner(100, 20), corner(0, 20)] }], "omni-grad") as GV;
    v.fill = "#ff0000";
    v.fills = [{ type: "gradient", kind: "linear", from: [0, 0], to: [1, 0], stops: [{ at: 0, color: { hex: "#ff0000" } }, { at: 1, color: { hex: "#0000ff" } }] }];
    return v;
  };
  it("the canvas draws the gradient (red on the left, blue on the right)", async () => {
    const { drawNode } = await import("../src/render/draw");
    const c = cv.createCanvas(100, 20);
    const g = c.getContext("2d") as any;
    drawNode(g, rect(), { doc: newDocument(), clip: { x: 0, y: 0, w: 100, h: 20 }, scale: 1, incomplete: false, onResourceReady: () => {} } as any);
    const px = (x: number) => Array.from(g.getImageData(x, 10, 1, 1).data as Uint8ClampedArray).slice(0, 3);
    expect(px(1)[0]).toBeGreaterThan(240);
    expect(px(98)[2]).toBeGreaterThan(240);
    expect(px(50)[0]).toBeGreaterThan(100);
    expect(px(50)[2]).toBeGreaterThan(100);
  });
  it("SVG export writes an SVG gradient; .omw keeps the fill", async () => {
    const { exportSvg } = (await import("../src/io/export")) as any;
    const doc = newDocument();
    const p = newPage("DESIGN", 100, 20);
    p.nodes.push(rect());
    doc.pages = [p];
    const svg: string = exportSvg ? await exportSvg(doc, p) : "";
    if (exportSvg) {
      expect(svg).toContain("<linearGradient");
      expect(svg).toMatch(/fill="url\(#g_/);
    }
    const { packOmw, unpackOmw } = await import("../src/io/omw");
    const back = unpackOmw(packOmw(doc, []).bytes).doc;
    expect((back.pages[0].nodes[0] as GV).fills?.[0]).toMatchObject({ type: "gradient", kind: "linear" });
  });
});

describe("Illustrator gradient shapes", () => {
  it("clip path + shading pairs become gradient vectors; a fading (soft-masked) one stays in the background; the background loses the elevated shadings", async () => {
    const sg = await import("../src/io/pdfsurgeon");
    const el = await import("../src/io/pdfsurgeon/elevate");
    const bytes = new Uint8Array(readFileSync("qa/samples/store-sample/ko/omni-store-design.ai"));
    const doc = await sg.openSurgeonDoc(bytes);
    const m = el.modelPage(doc, 0, { prefix: "omw", vectors: "auto" });
    const grads = m.vectors.filter((v) => v.shade);
    // the fading one (an opacity mask) comes up too, with opacity stops as Illustrator shows them; the ring's
    // gradient stroke (a shading pattern) as a gradient stroke
    expect(grads.length).toBe(5);
    expect(m.vectors.length).toBe(6);
    expect(grads.map((v) => ((v.node as GV).fills![0] as any).kind).sort()).toEqual(["linear", "linear", "linear", "radial", "radial"]);
    const fade = grads.map((v) => (v.node as GV).fills![0] as any).find((f) => f.stops.some((s: any) => s.color.a !== undefined));
    expect(fade.stops.map((s: any) => s.color.a)).toEqual([1, 0.115]);
    const ring = m.vectors.find((v) => v.pattern)!;
    expect((ring.node as any).strokes[0].paint.stops.map((s: any) => s.color.hex)).toEqual(["#7800c8", "#00c8a0"]);
    const out = await sg.strippedForView(doc, 0, { prefix: "omw", vectors: "auto" });
    const back = el.modelPage(await sg.openSurgeonDoc(out), 0, { prefix: "omw", vectors: false });
    const shadings = back.analysis.items.filter((x) => x.kind === "image" && x.name.startsWith("sh:"));
    expect(shadings.length).toBe(0);
  });
});

describe("gradients written back (AI save, PDF export)", () => {
  it("an edited gradient shape and gradient stroke are saved into the AI and read back as edited", async () => {
    const sg = await import("../src/io/pdfsurgeon");
    const bytes = new Uint8Array(readFileSync("qa/samples/store-sample/ko/omni-store-design.ai"));
    const doc = await sg.openSurgeonDoc(bytes);
    const el = sg.elevatePage(doc, 0, { prefix: "omw", vectors: "auto" });
    const nodes = structuredClone(el.nodes) as (GV & { strokes?: { paint: any }[] })[];
    // the 45° rectangle: moved 30 px right, now green → blue
    const rect = nodes.find((n) => n.type === "VECTOR" && (n.fills?.[0] as any)?.stops?.[0]?.color.hex === "#ffc800")!;
    rect.transform = { ...rect.transform, x: rect.transform.x + 30 };
    (rect.fills![0] as any).stops = [{ at: 0, color: { hex: "#00ff00" } }, { at: 1, color: { hex: "#0000ff" } }];
    // the ring: its gradient stroke now red → yellow
    const ring = nodes.find((n) => n.type === "VECTOR" && n.strokes?.[0])!;
    ring.strokes![0].paint = { ...ring.strokes![0].paint, stops: [{ at: 0, color: { hex: "#ff0000" } }, { at: 1, color: { hex: "#ffff00" } }] };
    // the fading rectangle (an opacity mask): moved 20 px up, still fading
    const fade = nodes.find((n) => n.type === "VECTOR" && (n.fills?.[0] as any)?.stops?.some((x: any) => x.color.a !== undefined))!;
    fade.transform = { ...fade.transform, y: fade.transform.y - 20 };
    const { bytes: out, report } = await sg.saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: "omw", vectors: "auto" });
    expect(report.skipped.filter((x) => /그레이디언트|gradient/i.test(x))).toEqual([]);
    expect(report.editedVectors).toBe(3);
    const again = sg.elevatePage(await sg.openSurgeonDoc(out), 0, { prefix: "omw", vectors: "auto" });
    const vs = again.nodes.filter((n) => n.type === "VECTOR") as (GV & { strokes?: { paint: any }[] })[];
    const r2 = vs.find((n) => (n.fills?.[0] as any)?.stops?.[0]?.color.hex === "#00ff00")!;
    expect(r2).toBeTruthy();
    expect((r2.fills![0] as any).stops.map((x: any) => x.color.hex)).toEqual(["#00ff00", "#0000ff"]);
    const xs = (n: VectorNode) => n.contours[0].nodes.map((q) => q.anchor[0] + n.transform.x);
    expect(Math.min(...xs(r2))).toBeCloseTo(Math.min(...xs(rect)), 0);
    expect(vs.filter((n) => (n.fills?.[0] as any)?.stops?.[0]?.color.hex === "#ffc800").length).toBe(0);
    const ring2 = vs.find((n) => n.strokes?.[0])!;
    expect(ring2.strokes![0].paint.stops.map((x: any) => x.color.hex)).toEqual(["#ff0000", "#ffff00"]);
    expect(vs.length).toBe(6);
    const fade2 = vs.find((n) => (n.fills?.[0] as any)?.stops?.some((x: any) => x.color.a !== undefined))!;
    expect((fade2.fills![0] as any).stops.map((x: any) => x.color.a)).toEqual([1, 0.115]);
    const ys = (n: VectorNode) => n.contours[0].nodes.map((q) => q.anchor[1] + n.transform.y);
    expect(Math.min(...ys(fade2))).toBeCloseTo(Math.min(...ys(fade)), 0);
  });

  it("vector PDF export draws gradient fills and strokes as shadings", async () => {
    const { exportPdfVector } = await import("../src/io/pdfVector");
    const doc = newDocument();
    const p = newPage("DESIGN", 120, 60);
    const v = newVector([{ closed: true, nodes: [corner(10, 10), corner(110, 10), corner(110, 30), corner(10, 30)] }], "omni-grad") as GV & { strokes?: { paint: Paint; width: number }[] };
    v.fill = "#ff0000";
    v.fills = [{ type: "gradient", kind: "linear", from: [0, 0], to: [1, 0], stops: [{ at: 0, color: { hex: "#ff0000" } }, { at: 1, color: { hex: "#0000ff" } }] }];
    v.stroke = "#00ff00";
    v.strokeWidth = 2;
    v.strokes = [{ paint: { type: "gradient", kind: "radial", from: [0.5, 0.5], to: [1, 0.5], focal: [0.4, 0.5], focalRadius: 0.1, stops: [{ at: 0, color: { hex: "#00ff00" } }, { at: 1, color: { hex: "#000000", a: 0.5 } }] }, width: 2 }];
    p.nodes.push(v);
    doc.pages = [p];
    const pdf = await exportPdfVector(doc, [p]);
    const { PDFDocument, PDFName, PDFDict } = await import("pdf-lib");
    const d = await PDFDocument.load(pdf);
    const res = d.getPage(0).node.Resources()!;
    const sh = res.lookup(PDFName.of("Shading"), PDFDict);
    const types = sh.keys().map((k) => (sh.lookup(k) as any).lookup(PDFName.of("ShadingType")).asNumber()).sort();
    expect(types).toEqual([2, 3]);
    // the radial one keeps its focus (start circle off-centre, radius > 0)
    const radial = sh.keys().map((k) => sh.lookup(k) as any).find((x) => x.lookup(PDFName.of("ShadingType")).asNumber() === 3);
    const c = radial.lookup(PDFName.of("Coords")).asArray().map((x: any) => x.asNumber());
    expect(c[0]).toBeLessThan(c[3]);
    expect(c[2]).toBeGreaterThan(0);
    // pixels: red on the left of the fill, blue on the right (pdf.js)
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pg = await (await pdfjs.getDocument({ data: pdf.slice(), isEvalSupported: false }).promise).getPage(1);
    const vp = pg.getViewport({ scale: 4 / 3 });
    const cnv = cv.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const g = cnv.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, cnv.width, cnv.height);
    await pg.render({ canvasContext: g as any, viewport: vp }).promise;
    const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
    expect(px(14, 20)[0]).toBeGreaterThan(200);
    expect(px(106, 20)[2]).toBeGreaterThan(200);
  });
});

describe("PDF shadings read back", () => {
  it("a two-circle radial gradient survives PDF export → open → elevate with its focus", async () => {
    const { exportPdfVector } = await import("../src/io/pdfVector");
    const sg = await import("../src/io/pdfsurgeon");
    const doc = newDocument();
    const p = newPage("DESIGN", 200, 200);
    const v = newVector([{ closed: true, nodes: [corner(20, 20), corner(180, 20), corner(180, 180), corner(20, 180)] }], "omni-focal") as GV;
    v.fill = "#ffffff";
    v.fills = [{ type: "gradient", kind: "radial", from: [0.5, 0.5], to: [1, 0.5], focal: [0.3, 0.4], focalRadius: 0.1, stops: [{ at: 0, color: { hex: "#ffffff" } }, { at: 0.5, color: { hex: "#ff8800" } }, { at: 1, color: { hex: "#330000" } }] }];
    p.nodes.push(v);
    doc.pages = [p];
    const pdf = await exportPdfVector(doc, [p]);
    const el = sg.elevatePage(await sg.openSurgeonDoc(pdf), 0, { prefix: "omw", vectors: true });
    const g = el.nodes.find((n): n is GV => n.type === "VECTOR" && !!(n as GV).fills)!;
    const f = g.fills![0] as any;
    expect(f.kind).toBe("radial");
    expect(f.focal[0]).toBeCloseTo(0.3, 2);
    expect(f.focal[1]).toBeCloseTo(0.4, 2);
    expect(f.focalRadius).toBeCloseTo(0.1, 3);
    expect(f.stops.map((s: any) => s.color.hex)).toEqual(["#ffffff", "#ff8800", "#ff8800", "#330000"]);
  });
});

describe("the plain colour standing in for a gradient (versions before 0.2.2 draw only that)", () => {
  it("is the opacity-weighted average; a wholly transparent gradient gives its darkest colour", async () => {
    const { gradientFallbackHex } = await import("../src/core/style/paint");
    const st = (hex: string, at: number, a?: number) => ({ at, color: { hex, ...(a !== undefined ? { a } : {}) } });
    expect(gradientFallbackHex([st("#ff0000", 0), st("#0000ff", 1)])).toBe("#800080");
    // white → transparent green: leans white but keeps a visible green (not white, which vanishes on white paper)
    const wg = gradientFallbackHex([st("#ffffff", 0), st("#22aa55", 1, 0)]);
    expect(wg).toBe("#b5e3c6");
    expect(wg).not.toBe("#ffffff");
    expect(gradientFallbackHex([st("#ffffff", 0, 0), st("#103080", 1, 0)])).toBe("#103080");
    expect(gradientFallbackHex([st("#123456", 0.3)])).toBe("#123456");
  });
  it("SVG and Illustrator gradients get it as their plain fill / stroke", () => {
    const art = svgToVectors(SVG(`<defs><radialGradient id="r"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#22aa55" stop-opacity="0"/></radialGradient></defs><circle cx="50" cy="50" r="40" fill="url(#r)"/>`))!;
    expect((art.nodes[0] as GV).fill).toBe("#b5e3c6");
  });
});
