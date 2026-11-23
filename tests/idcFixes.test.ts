// 2026-11-23 real-use audit of the image / design / CAD modes: what was
// broken when used like a user — SVG opened as one picture, PSD on a white sheet, merge down greyed for pictures, the
// design eraser not touching paths, greyed menus without a reason, a flipped pixel layer jumping, PSD exported at 2×,
// the design brush painting pixels, history making .omw files large, no DXF in the export list.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { applyTransform } from "../src/core/geom";
import { historyForFile, type HistoryEntry } from "../src/core/history";
import { nodeBounds, rasterContentBounds } from "../src/core/loom";
import { findPage, useStore } from "../src/core/store";
import { newDocument, newImage, newPage, newRaster, newText, newVector, TILE, type OmwDocument, type Page } from "../src/core/types";
import { corner, cubicAt } from "../src/core/vector";
import { cutContours, eraseVector, subCubic } from "../src/core/vectorErase";
import { imgToTiles, newImg } from "../src/core/image/pixels";
import { importPsdPage } from "../src/io/formats/psd";
import { pictureScale } from "../src/io/formats/pictureExport";
import { svgToVectors } from "../src/io/svgVectors";
import { command, enabled } from "../src/ui/commands";
import { brushPath, simplifyTrack } from "../src/ui/designPaint";
import { exportBlocked } from "../src/ui/exportMenu";
import { mergeDownPair } from "../src/ui/menuActions";
import { flipSelected } from "../src/ui/xform";

const S = () => useStore.getState();
function fresh(pages: Page[]) {
  const doc = newDocument();
  doc.pages = pages;
  S().load(doc);
  S().set({ pageId: pages[0].id, selection: [], mode: "AUTO" });
}
const page = () => findPage(S().doc, S().pageId)!;

beforeAll(() => {
  (globalThis as any).DOMParser ??= DOMParser;
});

describe("X1 SVG opens as editable objects", () => {
  it("rect, circle, path, text and <use> become their own objects (text an editable text box)", () => {
    const art = svgToVectors(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="300">
      <defs><circle id="dot" r="10" fill="#00f"/></defs>
      <rect x="10" y="10" width="100" height="50" fill="#f00"/>
      <circle cx="200" cy="100" r="40" fill="#0a0"/>
      <path d="M10 200 C 60 150 120 250 180 200" stroke="#000" fill="none" stroke-width="3"/>
      <g font-family="Arial" font-size="24"><text x="200" y="250" text-anchor="middle" font-weight="bold" fill="#333">Omni <tspan>weave</tspan></text></g>
      <use href="#dot" x="300" y="50"/>
    </svg>`)!;
    expect(art).not.toBeNull();
    expect(art.nodes.map((n) => n.type)).toEqual(["VECTOR", "VECTOR", "VECTOR", "TEXT", "VECTOR"]);
    const tx = art.nodes[3] as any;
    expect(tx.paragraphs[0].runs.map((r: any) => r.text).join("")).toBe("Omni weave");
    expect(tx.paragraphs[0].runs[0]).toMatchObject({ fontSize: 24, bold: true, fontFamily: "Arial", color: "#333" });
    expect(tx.paragraphs[0].align).toBe("CENTER");
    // anchored in the middle at x = 200; the baseline near y = 250
    expect(tx.transform.x + tx.width / 2).toBeCloseTo(200, 3);
    expect(tx.transform.y).toBeGreaterThan(250 - 24 * 1.2);
    expect(tx.transform.y).toBeLessThan(250);
    const dot = nodeBounds(art.nodes[4]);
    expect(dot.x + dot.w / 2).toBeCloseTo(300, 0);
    expect(dot.y + dot.h / 2).toBeCloseTo(50, 0);
  });
});

describe("X2 PSD pages are transparent, exported at their own size", () => {
  it("a PSD opens on a transparent canvas and exports 1:1", () => {
    const bytes = new Uint8Array(readFileSync("qa/samples/store-sample/ko/omni-store-layers.psd"));
    const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omni-store-layers.psd");
    const r = importPsdPage(bytes, "omni-store-layers.psd", "omni-store-layers", asset);
    expect(r.page.background).toBe("transparent");
    expect(pictureScale(r.page)).toBe(1);
    const art = newPage("DESIGN", 100, 100);
    expect(pictureScale(art)).toBe(2);
  });
});

function solidRaster(w: number, h: number, ox = 0) {
  const img = newImg(w, h);
  for (let i = 0; i < img.data.length; i += 4) img.data.set([200, 30, 30, 255], i);
  const n = newRaster("omni-solid");
  n.tiles = imgToTiles(img, ox, 0, {}).tiles;
  return n;
}

describe("X4 merge down with a picture layer", () => {
  it("a picture, text or shape layer merges with the layer below (drawn into pixels)", () => {
    const pg = newPage("DESIGN", 200, 200);
    const pic = newImage("asset_omni", 200, 200, "omni.jpg");
    const r = solidRaster(50, 50);
    pg.nodes.push(pic, r);
    fresh([pg]);
    expect(mergeDownPair(page(), [r.id])).not.toBeNull();
    S().set({ selection: [r.id] });
    expect(enabled(command("image.mergeDown")!)).toBe(true);
  });
});

describe("X5 design eraser cuts paths", () => {
  const line = () => {
    const v = newVector([{ closed: false, nodes: [corner(0, 0), corner(100, 0)] }], "omni-line");
    v.fill = null;
    v.stroke = "#000";
    v.strokeWidth = 2;
    return v;
  };
  it("a line crossed in the middle becomes two lines, the ends where they were", () => {
    const r = eraseVector(line(), [[50, -20], [50, 20]], 5)!;
    expect(r.contours.length).toBe(2);
    const [a, b] = r.contours;
    expect(a.nodes[0].anchor).toEqual([0, 0]);
    expect(a.nodes.at(-1)!.anchor[0]).toBeCloseTo(44, 0); // 50 − radius 5 − half the stroke 1
    expect(b.nodes[0].anchor[0]).toBeCloseTo(56, 0);
    expect(b.nodes.at(-1)!.anchor).toEqual([100, 0]);
  });
  it("away from the path nothing changes; over all of it, the path goes", () => {
    expect(eraseVector(line(), [[50, 50], [60, 50]], 5)).toBeUndefined();
    expect(eraseVector(line(), [[-10, 0], [110, 0]], 8)).toBeNull();
  });
  it("the parts left of a curve keep its exact shape", () => {
    const c: [number, number][] = [[0, 0], [30, -60], [70, 60], [100, 0]];
    const cut = cutContours([{ closed: false, nodes: [{ anchor: c[0], handleIn: c[0], handleOut: c[1], isCorner: true }, { anchor: c[3], handleIn: c[2], handleOut: c[3], isCorner: true }] }], [[50, -50], [50, 50]], 4)!;
    expect(cut.length).toBe(2);
    const left = cut[0];
    const q = subCubic([c[0], c[1], c[2], c[3]] as any, 0, 0.3);
    // a point on the kept piece lies on the original curve
    const mid = cubicAt(left.nodes[0].anchor, left.nodes[0].handleOut, left.nodes[1].handleIn, left.nodes[1].anchor, 0.5);
    let best = Infinity;
    for (let i = 0; i <= 2000; i++) {
      const p = cubicAt(c[0], c[1], c[2], c[3], i / 2000);
      best = Math.min(best, Math.hypot(p[0] - mid[0], p[1] - mid[1]));
    }
    expect(best).toBeLessThan(0.1);
    expect(q[0]).toEqual(c[0]);
  });
  it("a filled shape loses the area the eraser covers", () => {
    const sq = newVector([{ closed: true, nodes: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)] }], "omni-square");
    sq.fill = "#f00";
    const r = eraseVector(sq, [[50, -10], [50, 110]], 10)!;
    // two pieces left and right of a 20 px band
    expect(r.contours.length).toBe(2);
    const xs = r.contours.map((c) => Math.max(...c.nodes.map((n) => n.anchor[0])));
    expect(Math.min(...xs)).toBeCloseTo(40, 0);
  });
  it("the design paintbrush makes a smooth open path in the brush colour and size", () => {
    const track: [number, number][] = Array.from({ length: 60 }, (_, i) => [i * 5, 50 + Math.sin(i / 6) * 30]);
    const v = brushPath(track, "#123456", 8, 1)!;
    expect(v.type).toBe("VECTOR");
    expect(v.fill).toBeNull();
    expect(v.stroke).toBe("#123456");
    expect(v.strokeWidth).toBe(8);
    expect(v.contours[0].closed).toBe(false);
    expect(v.contours[0].nodes.length).toBeLessThan(track.length);
    expect(simplifyTrack([[0, 0], [1, 0.01], [2, 0]], 0.5)).toEqual([[0, 0], [2, 0]]);
    expect(brushPath([[5, 5]], "#000", 4, 1)).toBeNull();
  });
});

describe("X6–X8 layer commands: the only layer is the target, otherwise the menu says why", () => {
  it("flip / rotate / crop act on the page's only layer with nothing selected", () => {
    const pg = newPage("DESIGN", 200, 100);
    const pic = newImage("asset_omni", 200, 100, "omni.png");
    pg.nodes.push(pic);
    fresh([pg]);
    for (const id of ["object.flipH", "object.flipV", "object.rotateCW", "object.crop", "image.rasterize"]) expect(enabled(command(id)!), id).toBe(true);
    command("object.flipH")!.run();
    expect(S().selection).toEqual([pic.id]);
    expect(page().nodes[0].transform.scale).toBe(-1);
  });
  it("with several layers the greyed command says to pick one; vectors say why pixel commands are off", () => {
    const pg = newPage("DESIGN", 200, 100);
    const v = newVector([{ closed: true, nodes: [corner(0, 0), corner(10, 0), corner(10, 10)] }], "omni-v");
    pg.nodes.push(newImage("asset_a", 50, 50, "a.png"), newImage("asset_b", 50, 50, "b.png"), v);
    fresh([pg]);
    const flip = command("object.flipH")!;
    expect(enabled(flip)).toBe(false);
    expect(flip.whyNot!()).toBeTruthy();
    S().set({ selection: [v.id] });
    const up = command("image.upscale")!;
    expect(enabled(up)).toBe(false);
    expect(up.whyNot!()).toMatch(/래스터|rasterize/i);
  });
  it("a one-colour fill layer (canvas extension) does not count as a layer to act on", () => {
    const pg = newPage("DESIGN", 200, 100);
    const fill = solidRaster(300, 100);
    const pic = newImage("asset_omni", 200, 100, "omni.png");
    pg.nodes.push(fill, pic);
    fresh([pg]);
    expect(enabled(command("object.flipH")!)).toBe(true);
  });
});

describe("△ flipping a pixel layer keeps it in place", () => {
  it("an 800 px wide raster (1024 px of tiles) flips about its painted middle", () => {
    const pg = newPage("DESIGN", 800, 100);
    const r = solidRaster(800, 100);
    expect(Object.keys(r.tiles).length).toBe(4); // 4 × 256 = 1024 px of tiles
    expect(rasterContentBounds(r)).toEqual({ x: 0, y: 0, w: 800, h: 100 });
    pg.nodes.push(r);
    fresh([pg]);
    S().set({ selection: [r.id] });
    flipSelected("h");
    const n = page().nodes[0];
    const xs = [applyTransform(n.transform, [0, 0])[0], applyTransform(n.transform, [800, 0])[0]];
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(800, 6);
    expect(TILE).toBe(256);
  });
});

describe("△ .omw history and DXF export", () => {
  it("history in the file keeps only the newest steps that fit the budget", () => {
    const big = (i: number): OmwDocument => {
      const d = newDocument();
      const p = newPage("DESIGN", 10, 10);
      const im = newImage(`a${i}`, 10, 10, "omni.png");
      p.nodes.push(im);
      d.pages = [p];
      d.assets[`a${i}`] = { id: `a${i}`, hash: `h${i}`, mime: "image/png", name: "omni.png", size: 3 * 1024 * 1024 };
      return d;
    };
    const entries: HistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, time: i, label: "step", root: `r${i}`, doc: big(i) }));
    const cur = entries[9].doc;
    const kept = historyForFile(entries, cur);
    // the document's own picture is 3 MB: the budget is 6 MB of earlier pictures → the last entry + 2 earlier ones
    expect(kept.length).toBe(3);
    expect(kept.at(-1)!.id).toBe("e9");
    const small = entries.map((e) => ({ ...e, doc: cur }));
    expect(historyForFile(small, cur)).toHaveLength(10);
  });
  it("DXF is offered for a drawing and greyed for a page without lines or text", () => {
    const pg = newPage("DESIGN", 100, 100);
    expect(exportBlocked("dxf", [pg])).toBeTruthy();
    pg.nodes.push(newText("omni"));
    expect(exportBlocked("dxf", [pg])).toBeNull();
  });
});
