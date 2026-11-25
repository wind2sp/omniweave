// Image mode Photoshop features, part 2 (2026-11-24): saved paths in PSD, masks of turned layers, Select and Mask,
// vertical type, free-transform maps.

import { describe, expect, it } from "vitest";
import { pathResources, readPaths } from "../../src/io/formats/psdPaths";
import { buildPsd, layerMaskSpec, writePsd } from "../../src/io/formats/psdWrite";
import { parsePsdLayout, importPsdPage } from "../../src/io/formats/psd";
import { corner } from "../../src/core/vector";
import { imgToTiles, solidImg } from "../../src/core/image/pixels";
import { maskFromPlane } from "../../src/core/image/layerMask";
import { newDocument, newPage, newRaster, newText } from "../../src/core/types";
import { refineSelection } from "../../src/ui/ps/SelectMaskDialog";
import { verticalLayout } from "../../src/core/textVertical";
import { squareToQuad } from "../../src/ui/ps/psTransform";
import { newTextTySh } from "../../src/io/formats/psdTextNew";
import { parseTySh, readPsdText } from "../../src/io/formats/psdText";

describe("saved paths in a PSD", () => {
  it("are written as path resources and read back", () => {
    const paths = [{ id: "a", name: "Path 1", contours: [{ closed: true, nodes: [corner(10, 20), corner(90, 20), corner(50, 70)] }] }];
    const res = pathResources(paths, 100, 80);
    const bytes = buildPsd({ width: 100, height: 80, layers: [], resources: res });
    const L = parsePsdLayout(bytes);
    const back = readPaths(L.bytes, L.resItems, 100, 80, () => "x");
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe("Path 1");
    expect(back[0].contours[0].nodes.map((n) => n.anchor.map(Math.round))).toEqual([[10, 20], [90, 20], [50, 70]]);
    // the import gives them to the page
    expect(importPsdPage(bytes, "p.psd", "p", null).page.paths?.length).toBe(1);
  });
  it("a page's paths go into a new PSD; a Hangul name is written in CP949 and read back", async () => {
    const doc = newDocument();
    const page = { ...newPage("DESIGN", 60, 40, "t"), paths: [{ id: "p", name: "패스 1", contours: [{ closed: true, nodes: [corner(5, 5), corner(30, 5), corner(30, 30)] }] }] };
    const r = await writePsd(doc, page);
    const L = parsePsdLayout(r.bytes);
    expect(readPaths(L.bytes, L.resItems, 60, 40, () => "")[0].name).toBe("패스 1");
  });
});

describe("a turned layer's mask", () => {
  it("is resampled through the layer's transform into a PSD user mask", () => {
    const r = newRaster("m");
    r.tiles = imgToTiles(solidImg(40, 40, 200, 0, 0), 0, 0, {}).tiles;
    const plane = new Uint8Array(40 * 40).fill(255);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 20; x++) plane[y * 40 + x] = 0;
    r.mask = { tiles: maskFromPlane(plane, 0, 0, 40, 40, true), hide: true };
    r.transform = { x: 50, y: 10, rotation: 0, scale: 2 };
    const m = layerMaskSpec(r)!;
    expect(m).toBeTruthy();
    // left half hidden (0), right half shown (255), on the page at twice the size
    const at = (px: number, py: number) => m.data[(py - m.top) * m.width + (px - m.left)];
    expect(at(60, 40)).toBeLessThan(20);
    expect(at(120, 40)).toBeGreaterThan(235);
  });
});

describe("Select and Mask", () => {
  it("feather softens a hard edge; shift edge grows it", () => {
    const w = 40, h = 20;
    const sel = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 20; x++) sel[y * w + x] = 255;
    const rgba = solidImg(w, h, 100, 100, 100).data;
    const soft = refineSelection(sel, rgba, w, h, { radius: 0, smooth: 0, feather: 4, contrast: 0, shift: 0 });
    expect(soft[10 * w + 20]).toBeGreaterThan(20);
    expect(soft[10 * w + 20]).toBeLessThan(235);
    const grown = refineSelection(sel, rgba, w, h, { radius: 0, smooth: 0, feather: 4, contrast: 0, shift: 60 });
    expect(grown[10 * w + 21]).toBeGreaterThan(soft[10 * w + 21]);
  });
});

describe("vertical type and transform maps", () => {
  it("paragraphs are columns from the right, characters downward", () => {
    const n = newText("가나\n다", 100, { fontSize: 20 });
    n.vertical = true;
    const v = verticalLayout(n);
    const ga = v.cells.find((c) => c.ch === "가")!, na = v.cells.find((c) => c.ch === "나")!, da = v.cells.find((c) => c.ch === "다")!;
    expect(na.y).toBeGreaterThan(ga.y);
    expect(da.x).toBeLessThan(ga.x);
    expect(v.h).toBe(40);
  });
  it("the projective map sends the square's corners to the quad's", () => {
    const q: [number, number][] = [[10, 10], [110, 20], [100, 90], [5, 80]];
    const m = squareToQuad(q);
    const f = (u: number, v: number) => [(m[0] * u + m[1] * v + m[2]) / (m[6] * u + m[7] * v + 1), (m[3] * u + m[4] * v + m[5]) / (m[6] * u + m[7] * v + 1)];
    for (const [[u, v], p] of [[[0, 0], q[0]], [[1, 0], q[1]], [[1, 1], q[2]], [[0, 1], q[3]]] as const) {
      const r = f(u, v);
      expect(r[0]).toBeCloseTo(p[0], 6);
      expect(r[1]).toBeCloseTo(p[1], 6);
    }
  });
});

describe("a text box drawn here becomes a Photoshop text layer", () => {
  it("its type block reads back with the text, size, colour and orientation", () => {
    const n = newText("오메 글자\n둘째", 200, { fontSize: 30, color: "#336699", fontFamily: "Malgun Gothic" });
    const data = newTextTySh({ ...n, transform: { x: 40, y: 50, rotation: 0, scale: 1 } }, 80);
    const ty = parseTySh(data)!;
    expect(ty).toBeTruthy();
    const spec = readPsdText(data, 40, 50)!;
    expect(spec.text).toBe("오메 글자\n둘째");
    expect(spec.size).toBe(30);
    expect(spec.color).toBe("#336699");
    expect(spec.font).toBe("MalgunGothic");
    expect(ty.desc.items.find((x) => x[0] === "Ornt")?.[1]).toMatchObject({ v: "Hrzn" });
    n.vertical = true;
    const tv = parseTySh(newTextTySh({ ...n, transform: { x: 40, y: 50, rotation: 0, scale: 1 } }, 80))!;
    expect(tv.desc.items.find((x) => x[0] === "Ornt")?.[1]).toMatchObject({ v: "Vrtc" });
  });
  it("a new PSD keeps it as a text layer (not 'rasterized')", async () => {
    const doc = newDocument();
    const page = newPage("DESIGN", 300, 200, "t");
    const n = newText("Hello", 150, { fontSize: 24 });
    n.transform = { x: 10, y: 20, rotation: 0, scale: 1 };
    page.nodes.push(n);
    const r = await writePsd(doc, page, { rasterize: async () => null });
    const L = parsePsdLayout(r.bytes);
    expect(L.records.some((x) => x.blocks.some((k) => k.key === "TySh"))).toBe(true);
  });
});
describe("text layer details", () => {
  it("every character run keeps its look; a turned, scaled box keeps its transform", () => {
    const n = newText("굵게 보통", 200, { fontSize: 20, color: "#000000", fontFamily: "Arial" });
    const p = n.paragraphs[0];
    p.runs = [{ ...p.runs[0], text: "굵게 ", bold: true, color: "#ff0000", fontSize: 30 }, { ...p.runs[0], text: "보통" }];
    n.transform = { x: 100, y: 60, rotation: 30, scale: 2 };
    const ty = parseTySh(newTextTySh(n, 40))!;
    const sr = (ty.engine as any).items.find((x: any) => x[0] === "EngineDict")[1].items.find((x: any) => x[0] === "StyleRun")[1];
    const lens = sr.items.find((x: any) => x[0] === "RunLengthArray")[1].v.map((v: any) => Number(v.v));
    expect(lens).toEqual([3, 3]);
    const fontSet = (ty.engine as any).items.find((x: any) => x[0] === "ResourceDict")[1].items.find((x: any) => x[0] === "FontSet")[1].v;
    expect(fontSet.length).toBe(3); // Arial-BoldMT, ArialMT, AdobeInvisFont
    expect(ty.transform[0]).toBeCloseTo(2 * Math.cos(Math.PI / 6), 6);
    expect(ty.transform[1]).toBeCloseTo(2 * Math.sin(Math.PI / 6), 6);
    expect(ty.transform[4]).toBeCloseTo(100, 6);
  });
});