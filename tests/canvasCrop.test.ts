// Canvas crop (Photoshop's crop tool, ISSUES-2026-11-19 2-3): with nothing selected the crop box goes round the whole
// page — shrink, enlarge past the page, ratio lock, straighten; Enter is one undo step; a PSD saves with the new
// canvas and reopens the same; a selected image keeps the object crop (이미지 자르기). Synthetic fixtures only.
import { beforeEach, describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { draftPage, useStore } from "../src/core/store";
import { newDocument, newImage, newPage, type Page, type RasterNode } from "../src/core/types";
import { readFileSync } from "node:fs";
import { decodePsd, importPsdPage, parsePsdLayout } from "../src/io/formats/psd";
import { buildPsd, checkPsd, psdCanvasSize, rasterPixels, writePsd, type FreshLayer } from "../src/io/formats/psdWrite";
import { applyCrop, cancelCrop, canvasCropPlan, CANVAS_CROP, cropRatioValue, setCropAngle, setCropCustom, setCropRatio, startCrop, useCrop } from "../src/ui/cropTool";

const S = () => useStore.getState();
const page = () => S().doc.pages[0];
const C = () => useCrop.getState();

function solid(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) o.set([...rgb, 255], i * 4);
  return o;
}
const L = (name: string, rgba: Uint8Array, left: number, top: number, width: number, height: number): FreshLayer => ({ name, px: { rgba, left, top, width, height }, opacity: 1, visible: true, blend: "NORMAL" });

function psdFixture(): Uint8Array {
  return buildPsd({ width: 40, height: 30, layers: [L("omw-배경", solid(40, 30, [255, 255, 255]), 0, 0, 40, 30), L("omw-빨강", solid(10, 8, [255, 0, 0]), 12, 6, 10, 8)] });
}

function loadPsd(bytes: Uint8Array) {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omw-crop.psd");
  const r = importPsdPage(bytes, "omw-crop.psd", "omw-crop", asset);
  const doc = newDocument("omw-crop");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  S().load(doc);
  S().set({ mode: "IMAGE", selection: [] });
}

function loadImage() {
  const doc = newDocument("omw-img");
  const p = newPage("DESIGN", 400, 300, "A");
  const img = newImage("asset", 400, 300, "omw-img");
  img.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  p.nodes.push(img as any);
  doc.pages = [p];
  S().load(doc);
  S().set({ mode: "IMAGE", selection: [] });
  return img.id;
}

const byName = (p: Page, name: string) => p.nodes.find((n) => n.name === name) as RasterNode;

beforeEach(() => {
  if (C().id) cancelCrop();
});

describe("canvas crop", () => {
  it("with nothing selected crops the canvas: shrink, one undo step", () => {
    const id = loadImage();
    startCrop();
    expect(C().id).toBe(CANVAS_CROP);
    expect(C().rect).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    C().set({ rect: { x: 50, y: 20, w: 200, h: 100 } });
    applyCrop();
    expect(C().id).toBe(null);
    expect([page().width, page().height]).toEqual([200, 100]);
    const n = page().nodes.find((x) => x.id === id)!;
    expect([n.transform.x, n.transform.y]).toEqual([-50, -20]);
    expect(S().past.map((p) => p.label)).toEqual(["캔버스 자르기"]);
    S().undo();
    expect([page().width, page().height]).toEqual([400, 300]);
    expect(page().nodes[0].transform.x).toBe(0);
  });

  it("extends past the page (the canvas grows) and whole pixels are kept", () => {
    loadImage();
    startCrop();
    C().set({ rect: { x: -20.4, y: -10, w: 440.2, h: 320 } });
    applyCrop();
    expect([page().width, page().height]).toEqual([440, 320]);
    expect([page().nodes[0].transform.x, page().nodes[0].transform.y]).toEqual([20, 10]);
  });

  it("Esc (cancel) leaves the page as it was and no step", () => {
    loadImage();
    startCrop();
    C().set({ rect: { x: 10, y: 10, w: 10, h: 10 } });
    cancelCrop();
    expect([page().width, page().height]).toEqual([400, 300]);
    expect(S().past.length).toBe(0);
    expect(S().gestureBase).toBe(null);
  });

  it("ratio lock: presets, original and custom W:H", () => {
    loadImage();
    startCrop();
    setCropRatio("1:1");
    expect(C().rect!.w).toBeCloseTo(C().rect!.h, 6);
    expect(cropRatioValue()).toBe(1);
    setCropRatio("16:9");
    expect(C().rect!.w / C().rect!.h).toBeCloseTo(16 / 9, 6);
    setCropRatio("original");
    expect(cropRatioValue()).toBeCloseTo(4 / 3, 6);
    setCropCustom(5, 2);
    expect(C().ratio).toBe("custom");
    expect(C().rect!.w / C().rect!.h).toBeCloseTo(2.5, 6);
    setCropRatio("free");
    expect(cropRatioValue()).toBe(null);
  });

  it("straighten: the content turns so the box becomes level (non-destructive transforms)", () => {
    const id = loadImage();
    startCrop();
    setCropAngle(10);
    expect(C().angle).toBe(10);
    // the box turned about its centre: the page centre stays the centre
    applyCrop();
    expect([page().width, page().height]).toEqual([400, 300]);
    const n = page().nodes.find((x) => x.id === id)!;
    expect(n.transform.rotation).toBeCloseTo(-10, 6);
    // the image's centre is still the page centre
    const a = (-10 * Math.PI) / 180;
    const cx = n.transform.x + 200 * Math.cos(a) - 150 * Math.sin(a), cy = n.transform.y + 200 * Math.sin(a) + 150 * Math.cos(a);
    expect(cx).toBeCloseTo(200, 4);
    expect(cy).toBeCloseTo(150, 4);
    expect(S().past.map((p) => p.label)).toEqual(["캔버스 자르기·기울기 바로잡기"]);
    S().undo();
    expect(page().nodes[0].transform.rotation).toBe(0);
  });

  it("plan maps points as the box frame says", () => {
    const plan = canvasCropPlan({ width: 100, height: 100 }, { x: 10, y: 10, w: 50, h: 50 }, 0, [50, 50]);
    expect(plan.map([10, 10])).toEqual([0, 0]);
    expect(plan.unchanged).toBe(false);
    expect(canvasCropPlan({ width: 100, height: 100 }, { x: 0, y: 0, w: 100, h: 100 }, 0, [50, 50]).unchanged).toBe(true);
  });

  it("with an image selected the object crop (이미지 자르기) still works", () => {
    const id = loadImage();
    S().set({ selection: [id] });
    startCrop();
    expect(C().id).toBe(id);
    C().set({ rect: { x: 0, y: 0, w: 100, h: 50 } });
    applyCrop();
    expect((page().nodes[0] as any).crop).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect([page().width, page().height]).toEqual([400, 300]);
  });

  it("a slide page has no canvas crop (select one object)", () => {
    loadImage();
    S().set({ mode: "SLIDE" });
    startCrop();
    expect(C().id).toBe(null);
  });
});

describe("canvas crop: PSD save and reopen", () => {
  it("an unedited PSD still saves as its original bytes", async () => {
    const bytes = psdFixture();
    loadPsd(bytes);
    const res = await writePsd(S().doc, page());
    expect(res.method).toBe("original");
    expect(res.bytes).toEqual(bytes);
  });

  it("a cropped PSD saves with the new canvas and layer offsets and reopens the same", async () => {
    loadPsd(psdFixture());
    startCrop();
    C().set({ rect: { x: 10, y: 4, w: 20, h: 16 } });
    applyCrop();
    expect([page().width, page().height]).toEqual([20, 16]);
    const res = await writePsd(S().doc, page());
    expect(res.method).toBe("surgery");
    expect(res.warnings.some((w) => w.includes("20×16"))).toBe(true);
    const lay = parsePsdLayout(res.bytes);
    expect([lay.width, lay.height]).toEqual([20, 16]);
    expect(checkPsd(res.bytes, { width: 20, height: 16, depth: lay.depth, mode: lay.mode, psb: lay.psb })).toEqual([]);
    // reopen: same size, the red layer at its moved offset
    loadPsd(res.bytes);
    expect([page().width, page().height]).toEqual([20, 16]);
    const red = byName(page(), "omw-빨강");
    expect([red.transform.x, red.transform.y]).toEqual([2, 2]);
  });

  it("an enlarged PSD saves the bigger canvas", async () => {
    loadPsd(psdFixture());
    startCrop();
    C().set({ rect: { x: -5, y: -5, w: 50, h: 40 } });
    applyCrop();
    const res = await writePsd(S().doc, page());
    const lay = parsePsdLayout(res.bytes);
    expect([lay.width, lay.height]).toEqual([50, 40]);
    expect(checkPsd(res.bytes, { width: 50, height: 40, depth: lay.depth, mode: lay.mode, psb: lay.psb })).toEqual([]);
    loadPsd(res.bytes);
    expect([page().width, page().height]).toEqual([50, 40]);
    expect(byName(page(), "omw-빨강").transform.x).toBe(17);
  });

  it("a size the file cannot hold keeps the original one, with a notice", () => {
    expect(psdCanvasSize({ width: 40000, height: 10 }, { width: 40, height: 30, psb: false })).toMatchObject({ width: 40, height: 30, fits: false });
    expect(psdCanvasSize({ width: 20.5, height: 10 }, { width: 40, height: 30, psb: false }).fits).toBe(false);
    expect(psdCanvasSize({ width: 20, height: 10 }, { width: 40, height: 30, psb: false })).toMatchObject({ width: 20, height: 10, changed: true });
  });

  it("a fresh PSD (image saved as PSD) takes the cropped page size", async () => {
    loadImage();
    // a raster page without an original PSD: the writer builds a new one at the page size
    S().commit("t", (d) => void (draftPage(d, S().pageId)!.nodes = []));
    startCrop();
    C().set({ rect: { x: 0, y: 0, w: 120, h: 80 } });
    applyCrop();
    const res = await writePsd(S().doc, page());
    const lay = parsePsdLayout(res.bytes);
    expect([lay.width, lay.height]).toEqual([120, 80]);
  });
});

describe("canvas crop keeps live PSD layers (no rasterizing on a pure move)", () => {
  const ascii = (t: string) => Array.from(t, (c) => c.charCodeAt(0));
  const raw = (key: string, data: number[]) => {
    const n = data.length + (data.length % 2);
    const d = new Uint8Array(12 + n);
    d.set(ascii("8BIM"), 0);
    d.set(ascii(key), 4);
    new DataView(d.buffer).setUint32(8, n);
    d.set(data, 12);
    return d;
  };
  const f64 = (x: number) => Array.from(new Uint8Array(new Float64Array([x]).buffer).reverse());
  const i32 = (x: number) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255];
  const corners = [12, 6, 22, 6, 22, 14, 12, 14];
  const sold = raw("SoLd", [...ascii("soLD"), ...i32(4), ...i32(16), ...i32(0), ...ascii("Trnf"), ...ascii("VlLs"), ...i32(8), ...corners.flatMap((c) => [...ascii("doub"), ...f64(c)])]);
  // one closed subpath, one knot at (x 12, y 6) of the 40×30 canvas
  const fx = (v: number) => Math.round(v * (1 << 24));
  const knot = [...i32(fx(6 / 30)), ...i32(fx(12 / 40))];
  const vmsk = raw("vmsk", [...i32(3), ...i32(0), 0, 0, 0, 1, ...new Array(22).fill(0), 0, 1, ...knot, ...knot, ...knot]);
  const fixture = () =>
    buildPsd({ width: 40, height: 30, layers: [
      L("omw-배경", solid(40, 30, [255, 255, 255]), 0, 0, 40, 30),
      { ...L("omw-고급", solid(10, 8, [0, 0, 255]), 12, 6, 10, 8), blocks: [sold] },
      { ...L("omw-벡터", solid(10, 8, [0, 255, 0]), 12, 6, 10, 8), blocks: [vmsk] },
    ] });
  const blockData = (bytes: Uint8Array, key: string) => {
    for (const r of parsePsdLayout(bytes).records) {
      const k = r.blocks.find((x) => x.key === key);
      if (k) return { rec: r, data: new DataView(bytes.buffer, bytes.byteOffset + k.dataStart, k.dataEnd - k.dataStart) };
    }
    return null;
  };

  it("smart object and vector mask records survive a canvas crop, shifted", async () => {
    loadPsd(fixture());
    startCrop();
    C().set({ rect: { x: 10, y: 4, w: 20, h: 16 } });
    applyCrop();
    const res = await writePsd(S().doc, page());
    expect(res.method).toBe("surgery");
    const notes = res.warnings.join(" ");
    expect(notes).not.toMatch(/래스터|픽셀로/);
    const lay = parsePsdLayout(res.bytes);
    expect(checkPsd(res.bytes, { width: 20, height: 16, depth: lay.depth, mode: lay.mode, psb: lay.psb })).toEqual([]);
    const so = blockData(res.bytes, "SoLd")!;
    expect(so).not.toBeNull();
    expect([so.rec.left, so.rec.top]).toEqual([2, 2]);
    const at = 7 * 4; // soLD, ver, descVer, key len, 'Trnf', 'VlLs', count → first 'doub'
    const got = Array.from({ length: 8 }, (_, i) => so.data.getFloat64(at + i * 12 + 4));
    expect(got).toEqual(corners.map((c, i) => c + (i % 2 ? -4 : -10)));
    const vm = blockData(res.bytes, "vmsk")!;
    expect(vm).not.toBeNull();
    const F = 1 << 24;
    // the knot (12, 6) → (2, 2) on the 20×16 canvas
    expect(vm.data.getInt32(8 + 26 + 2) / F).toBeCloseTo(2 / 16, 5);
    expect(vm.data.getInt32(8 + 26 + 6) / F).toBeCloseTo(2 / 20, 5);
    // reopens the same, and an untouched re-save is the same bytes
    loadPsd(res.bytes);
    expect([page().width, page().height]).toEqual([20, 16]);
    expect([byName(page(), "omw-고급").transform.x, byName(page(), "omw-고급").transform.y]).toEqual([2, 2]);
    const again = await writePsd(S().doc, page());
    expect(again.bytes).toEqual(res.bytes);
  });
});

describe("straightened canvas crop of a shape layer (fill + vector mask)", () => {
  const REF = "qa/interop/adobe-made/fidelity/omni-fid-shape-ellipse.psd";
  const keysOf = (bytes: Uint8Array) => parsePsdLayout(bytes).records.map((r) => r.blocks.map((k) => k.key));
  // the saved vector mask as a polygon (cubic segments sampled) in canvas pixels
  function maskPolygon(bytes: Uint8Array, W: number, H: number): [number, number][] {
    const L = parsePsdLayout(bytes);
    for (const r of L.records) {
      const k = r.blocks.find((x) => x.key === "vmsk");
      if (!k) continue;
      const v = new DataView(bytes.buffer, bytes.byteOffset + k.dataStart, k.dataEnd - k.dataStart);
      const F = 1 << 24;
      const knots: [number, number][][] = [];
      for (let at = 8; at + 26 <= v.byteLength; at += 26) {
        const t = v.getUint16(at);
        if (t !== 1 && t !== 2) continue;
        knots.push([0, 1, 2].map((i) => [(v.getInt32(at + 6 + i * 8) / F) * W, (v.getInt32(at + 2 + i * 8) / F) * H] as [number, number]));
      }
      const poly: [number, number][] = [];
      for (let i = 0; i < knots.length; i++) {
        const a = knots[i][1], c1 = knots[i][2], c2 = knots[(i + 1) % knots.length][0], b = knots[(i + 1) % knots.length][1];
        for (let s = 0; s < 32; s++) {
          const t = s / 32, u = 1 - t;
          poly.push([0, 1].map((j) => u * u * u * a[j] + 3 * u * u * t * c1[j] + 3 * u * t * t * c2[j] + t * t * t * b[j]) as [number, number]);
        }
      }
      return poly;
    }
    return [];
  }
  const inside = (poly: [number, number][], x: number, y: number) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };

  it("stays a shape layer whose vector mask turns with the pixels; no raster notice; reopens the same", async () => {
    const src = new Uint8Array(readFileSync(REF));
    loadPsd(src);
    // unedited: the original bytes
    const same = await writePsd(S().doc, page());
    expect(same.method).toBe("original");
    expect(same.bytes).toEqual(src);
    startCrop();
    setCropAngle(5);
    applyCrop();
    const W = page().width, H = page().height;
    const idx = parsePsdLayout(src).records.findIndex((r) => r.blocks.some((k) => k.key === "vmsk"));
    const shapeId = (page().source as any).psd.layers[idx].node;
    const shape = page().nodes.find((n) => n.id === shapeId) as RasterNode;
    expect(Math.abs(shape.transform.rotation)).toBeCloseTo(5, 6);
    expect(shape).toBeTruthy();
    const ours = rasterPixels(shape)!;
    const res = await writePsd(S().doc, page());
    expect(res.method).toBe("surgery");
    const notes = res.warnings.join(" ");
    expect(notes).not.toMatch(/래스터/);
    expect(notes).toMatch(/모양 레이어 \d+개는 벡터 마스크를 함께 돌려/);
    const lay = parsePsdLayout(res.bytes);
    expect(checkPsd(res.bytes, { width: W, height: H, depth: lay.depth, mode: lay.mode, psb: lay.psb })).toEqual([]);
    // kind: still solid fill + vector mask (live-shape box dropped)
    const ks = keysOf(res.bytes).find((k) => k.includes("vmsk"))!;
    expect(ks).toContain("SoCo");
    expect(ks).not.toContain("vogk");
    // the saved path is the drawn (rotated) ellipse: its fill agrees with our pixels' alpha
    const mismatch = (poly: [number, number][]) => {
      let diff = 0, area = 0;
      for (let y = 0; y < ours.height; y++)
        for (let x = 0; x < ours.width; x++) {
          const a = ours.rgba[(y * ours.width + x) * 4 + 3] >= 128;
          if (a) area++;
          if (a !== inside(poly, ours.left + x + 0.5, ours.top + y + 0.5)) diff++;
        }
      expect(area).toBeGreaterThan(5000);
      return diff / area;
    };
    expect(mismatch(maskPolygon(res.bytes, W, H))).toBeLessThan(0.01);
    // (the unturned original path — the old save — is visibly off)
    expect([W, H]).toEqual([parsePsdLayout(src).width, parsePsdLayout(src).height]);
    expect(mismatch(maskPolygon(src, W, H))).toBeGreaterThan(0.02);
    // the bounds hold the turned pixels
    const rec = lay.records.find((r) => r.blocks.some((k) => k.key === "vmsk"))!;
    expect([rec.left, rec.top, rec.right - rec.left, rec.bottom - rec.top]).toEqual([ours.left, ours.top, ours.width, ours.height]);
    // reopen: the same layer pixels and merged image as our render of the cropped document; untouched re-save = same bytes
    const merged = decodePsd(res.bytes).composite!;
    loadPsd(res.bytes);
    expect([page().width, page().height]).toEqual([W, H]);
    const back = page().nodes.filter((n) => n.type === "RASTER").map((n) => rasterPixels(n as RasterNode)).find((p) => p && p.left === ours.left && p.top === ours.top && p.width === ours.width)!;
    expect(back).toBeTruthy();
    let worst = 0;
    for (let i = 0; i < back.rgba.length; i++) worst = Math.max(worst, Math.abs(back.rgba[i] - ours.rgba[i]));
    expect(worst).toBeLessThanOrEqual(2);
    const again = await writePsd(S().doc, page());
    expect(again.bytes).toEqual(res.bytes);
    expect(decodePsd(again.bytes).composite).toEqual(merged);
  });
});
