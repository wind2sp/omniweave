// 2026-11-24 mobile report: on a PSD, a finger stroke with the brush / eraser changed nothing (a PNG photo worked).
// A PSD layer starts at its content's corner, not at the page's: the stroke mask only covered node-local (0, 0) and
// beyond, so whatever was painted left of / above the layer's corner — a stroke across the page when the top layer is
// a small shape — was cut off and the commit found nothing. Also: a chosen locked / hidden layer is not painted (nor
// another layer instead), as in Photoshop.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { newDocument, newPage, newRaster, TILE, type Page, type RasterNode } from "../src/core/types";
import { useStore } from "../src/core/store";
import { makeTile, localBounds } from "../src/core/loom";
import { paintTarget } from "../src/ui/pixelSelect";
import { Stroke } from "../src/render/brush";
import { makeAsset } from "../src/core/assets";
import { importPsdPage } from "../src/io/formats/psd";
import { writePsd } from "../src/io/formats/psdWrite";

const S = () => useStore.getState();

beforeAll(async () => {
  const cv = await import("@napi-rs/canvas");
  const g = globalThis as any;
  g.ImageData ??= cv.ImageData;
  g.OffscreenCanvas ??= class {
    constructor(w: number, h: number) {
      return cv.createCanvas(w, h) as any;
    }
  };
});

function fresh(page: Page) {
  const doc = newDocument();
  doc.pages = [page];
  S().load(doc);
  S().set({ pageId: page.id, selection: [], mode: "AUTO" });
  return page;
}

/** a small opaque square layer whose origin is at (x, y) on the page, as a PSD layer is */
function shape(name: string, x: number, y: number): RasterNode {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0; i < 64; i++) for (let j = 0; j < 64; j++) d.set([250, 220, 60, 255], (i * TILE + j) * 4);
  const n = newRaster(name);
  n.tiles["0_0"] = makeTile(d);
  n.transform = { x, y, rotation: 0, scale: 1 };
  return n;
}

const stroke = (n: RasterNode, page: Page, pts: [number, number][], erase = false) => {
  const st = new Stroke(n, page.width, page.height, { ...S().brush, size: 20, color: "#2050ff", opacity: 1, hardness: 1 }, erase);
  for (const [x, y] of pts) st.add({ x, y, p: 1 });
  return st;
};

describe("brush on a PSD layer that starts inside the page", () => {
  it("a stroke left of and above the layer's corner is painted (tiles at negative indices)", () => {
    const page = fresh(newPage("DESIGN", 800, 600));
    const tri = shape("omni-yellow", 500, 325);
    page.nodes.push(tri);
    const st = stroke(tri, page, [[240, 240], [560, 250]]);
    expect(st.ox).toBe(2 * TILE);
    expect(st.oy).toBe(2 * TILE);
    const tiles = st.commit();
    expect(tiles).not.toBeNull();
    const keys = Object.keys(tiles!);
    expect(keys.some((k) => k.startsWith("-"))).toBe(true);
    // the layer's bounds now reach the stroke's start (page x 240 → local −260)
    const b = localBounds({ ...tri, tiles: tiles! });
    expect(b.x).toBeLessThanOrEqual(-260);
    expect(b.y).toBeLessThanOrEqual(-85);
    // the painted pixel at page (240, 240) is the brush colour
    const tx = Math.floor((240 - 500) / TILE), ty = Math.floor((240 - 325) / TILE);
    const t = tiles![`${tx}_${ty}`];
    const lx = 240 - 500 - tx * TILE, ly = 240 - 325 - ty * TILE;
    const i = (ly * TILE + lx) * 4;
    expect(Array.from(t.data.subarray(i, i + 4))).toEqual([32, 80, 255, 255]);
    // the old tile keeps its pixels where the stroke did not go
    expect(tiles!["0_0"].hash).toBe(tri.tiles["0_0"].hash);
  });

  it("a layer whose origin is the page's own corner paints as before (no offset canvas)", () => {
    const page = fresh(newPage("DESIGN", 400, 300));
    const bg = shape("omni-bg", 0, 0);
    page.nodes.push(bg);
    const st = stroke(bg, page, [[10, 10], [100, 30]]);
    expect([st.ox, st.oy]).toEqual([0, 0]);
    expect(st.full).toBe(st.mask);
    expect(Object.keys(st.commit()!)).toEqual(["0_0"]);
  });

  it("the eraser also reaches left of / above the corner (only where the layer has pixels)", () => {
    const page = fresh(newPage("DESIGN", 800, 600));
    const sq = shape("omni-sq", 300, 300);
    page.nodes.push(sq);
    const st = stroke(sq, page, [[250, 310], [330, 310]], true);
    const tiles = st.commit()!;
    expect(tiles).not.toBeNull();
    expect(Object.keys(tiles).every((k) => !k.startsWith("-"))).toBe(true);
    const i = (10 * TILE + 10) * 4;
    expect(tiles["0_0"].data[i + 3]).toBe(0);
  });
});

describe("which layer the brush paints", () => {
  const setup = () => {
    const page = fresh(newPage("DESIGN", 800, 600));
    const a = shape("omni-a", 100, 100), locked = shape("omni-locked", 200, 200), hidden = shape("omni-hidden", 300, 300);
    locked.locked = true;
    hidden.visible = false;
    page.nodes.push(a, locked, hidden);
    return { page, a, locked, hidden };
  };
  it("a chosen locked or hidden layer is not painted, and no other layer is painted instead", () => {
    const { page, locked, hidden } = setup();
    for (const [n, msg] of [[locked, /잠겨|locked/i], [hidden, /숨겨|hidden/i]] as const) {
      S().set({ selection: [n.id], toast: null } as any);
      for (const erase of [false, true]) {
        expect(paintTarget(page, erase, true)).toBeNull();
        expect(String((S() as any).toast?.text ?? (S() as any).toast)).toMatch(msg);
      }
    }
  });
  it("a chosen shown, unlocked layer is painted; with nothing chosen, the top shown unlocked layer", () => {
    const { page, a } = setup();
    S().set({ selection: [a.id] });
    expect(paintTarget(page, false, true)?.id).toBe(a.id);
    S().set({ selection: [] });
    expect(paintTarget(page, false, true)?.id).toBe(a.id);
  });
});

describe("PSD save after painting past a layer's corner", () => {
  const load = (bytes: Uint8Array) => {
    const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omni-store-layers.psd");
    const r = importPsdPage(bytes, "omni-store-layers.psd", "omni-store-layers", asset);
    const doc = newDocument("omni-store-layers");
    doc.pages = [r.page];
    doc.assets[asset.id] = asset;
    S().load(doc);
    S().set({ pageId: r.page.id, mode: "IMAGE", selection: [] });
    return r.page;
  };
  it("the stroke left of / above the yellow triangle's corner is saved and reopens where it was painted", async () => {
    const page = load(new Uint8Array(readFileSync("qa/samples/store-sample/ko/omni-store-layers.psd")));
    const tri = page.nodes.find((n) => n.name === "노란 삼각형") as RasterNode;
    const st = stroke(tri, page, [[240, 240], [560, 250]]);
    const tiles = st.commit()!;
    S().commit("omni-brush", (d) => {
      (d.pages[0].nodes.find((n) => n.id === tri.id) as RasterNode).tiles = tiles;
    });
    const res = await writePsd(S().doc, S().doc.pages[0]);
    const back = load(res.bytes);
    const tri2 = back.nodes.find((n) => n.name === "노란 삼각형") as RasterNode;
    // the layer now starts where the stroke began (page x ≈ 230, y ≈ 230)
    const b = localBounds(tri2);
    const left = tri2.transform.x + b.x, top = tri2.transform.y + b.y;
    expect(left).toBeLessThanOrEqual(232);
    expect(top).toBeLessThanOrEqual(232);
    // and the painted pixel at page (300, 242) is the brush blue
    const lx = 300 - tri2.transform.x, ly = 242 - tri2.transform.y;
    const tx = Math.floor(lx / TILE), ty = Math.floor(ly / TILE);
    const t = tri2.tiles[`${tx}_${ty}`];
    const i = ((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4;
    expect(Array.from(t.data.subarray(i, i + 3))).toEqual([32, 80, 255]);
  });
});
