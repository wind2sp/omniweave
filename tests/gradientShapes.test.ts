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
    expect(a.fill).toBe("#ff0000");
    // the radial gradient took its stops from the gradient it points to
    expect(b.fills?.[0]).toMatchObject({ kind: "radial" });
    expect((b.fills![0] as any).from[0]).toBeCloseTo(0.5, 2);
    expect((b.fills![0] as any).to[0]).toBeCloseTo(1, 2);
  });
  it("a clip path cuts a filled shape; a white mask works as a clip; a grey mask or a gradient stroke keeps one picture", () => {
    const art = svgToVectors(SVG(`<defs><clipPath id="c"><rect x="0" y="0" width="50" height="50"/></clipPath><mask id="m"><rect x="0" y="0" width="30" height="100" fill="white"/></mask></defs>
      <rect x="20" y="20" width="100" height="100" fill="#0a0" clip-path="url(#c)"/><rect x="0" y="60" width="100" height="20" fill="#00a" mask="url(#m)"/>`))!;
    expect(art.nodes.length).toBe(2);
    const xs = (n: VectorNode) => n.contours[0].nodes.map((p) => p.anchor[0]);
    expect(Math.max(...xs(art.nodes[0] as VectorNode))).toBeCloseTo(50, 3);
    expect(Math.max(...xs(art.nodes[1] as VectorNode))).toBeCloseTo(30, 3);
    expect(svgToVectors(SVG(`<defs><mask id="m"><rect width="30" height="30" fill="#888"/></mask></defs><rect width="10" height="10" fill="#000" mask="url(#m)"/>`))).toBeNull();
    expect(svgToVectors(SVG(`<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><path d="M0 0L10 10" stroke="url(#g)"/>`))).toBeNull();
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
    expect(grads.length).toBe(4);
    // the soft-masked shape is not elevated as a plain solid path either
    expect(m.vectors.length).toBe(4);
    expect(grads.map((v) => ((v.node as GV).fills![0] as any).kind).sort()).toEqual(["linear", "linear", "radial", "radial"]);
    const out = await sg.strippedForView(doc, 0, { prefix: "omw", vectors: "auto" });
    const back = el.modelPage(await sg.openSurgeonDoc(out), 0, { prefix: "omw", vectors: false });
    const shadings = back.analysis.items.filter((x) => x.kind === "image" && x.name.startsWith("sh:"));
    // the soft-masked one is still drawn by the background
    expect(shadings.length).toBe(1);
  });
});
