// psd-cmyk-open: a CMYK PSD opens without reading its channels on the way (they are read in the background — a
// worker in the app, a layer record a task without one), an .omw that stored every tile does the same, sampling takes
// only the tiles it needs, and see-through Normal layers of a CMYK document are mixed in CMYK as Photoshop does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { putBlob } from "../../src/core/assets";
import { cmykComposable, cmykLevelPixels, cmykStoreLater, cmykStoreOf, cmykTileSteps, cmykTilesOf, composeRegion, prepareCmykStore, releaseCmykFiles } from "../../src/core/image/cmykComposite";
import { wandMask } from "../../src/core/image/pixelSelection";
import { loadDissolveField } from "../../src/core/style/blend";
import type { OmwDocument, Page } from "../../src/core/types";
import { FORMATS } from "../../src/io/formats";
import { decodePsd, importPsdPage, withoutCmykManagement } from "../../src/io/formats/psd";
import { buildPsd } from "../../src/io/formats/psdWrite";
import { cmykSampleTile, paintCmykRegion, resetCmykView } from "../../src/render/cmykView";
import type { DrawEnv } from "../../src/render/draw";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

function open(bytes: Uint8Array, name: string) {
  const hash = putBlob(bytes);
  const r = importPsdPage(bytes, name, name, { id: "a1", hash });
  const doc = { assets: { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name, size: bytes.length } } };
  return { doc: doc as Pick<OmwDocument, "assets">, page: r.page, hash, ref: r.image.composite! };
}

const same = (a: Map<string, Uint8Array> | null, b: Map<string, Uint8Array> | null) =>
  !!a && !!b && a.size === b.size && [...a].every(([k, v]) => b.has(k) && Buffer.compare(Buffer.from(v), Buffer.from(b.get(k)!)) === 0);

/** Pixels whose largest RGB channel difference is ≤ 2, in % (both opaque here). */
function within2(a: Uint8Array | Uint8ClampedArray, b: Uint8Array): number {
  let ok = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) <= 2) ok++;
  return (100 * ok) / (a.length / 4);
}

class FakeCanvas {
  px: Uint8ClampedArray | null = null;
  constructor(public width: number, public height: number) {}
  getContext() {
    return { putImageData: (d: { data: Uint8ClampedArray }) => void (this.px = d.data) };
  }
}
vi.stubGlobal("OffscreenCanvas", FakeCanvas);
vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray) {} });
const ctx = { save() {}, restore() {}, drawImage() {}, imageSmoothingEnabled: true } as never;
const envOf = (doc: Pick<OmwDocument, "assets">, ready = () => {}): DrawEnv => ({ doc: doc as OmwDocument, clip: { x: 0, y: 0, w: 1e5, h: 1e5 }, scale: 1, incomplete: false, onResourceReady: ready });

beforeAll(() => loadDissolveField());

describe("reading a CMYK PSD", () => {
  it("decoding CMYK layers (one tight loop now) gives back exactly what was written, alpha included", () => {
    const W = 97, H = 61, rgba = new Uint8Array(W * H * 4);
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 24) & 255;
    for (let i = 0; i < rgba.length; i++) rgba[i] = rnd();
    const bytes = buildPsd({ width: W, height: H, mode: 4, layers: [{ name: "omni-rnd", px: { rgba, left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL" }] });
    // buildPsd writes CMYK with the exact inverse of the colour-unmanaged conversion: read back the same way
    const l = withoutCmykManagement(() => decodePsd(bytes)).layers.find((x) => x.name === "omni-rnd")!;
    // fully clear pixels carry no colour in the file: compare where there is coverage
    for (let i = 0; i < W * H; i++) {
      expect(l.rgba![i * 4 + 3]).toBe(rgba[i * 4 + 3]);
      if (rgba[i * 4 + 3]) expect([...l.rgba!.subarray(i * 4, i * 4 + 3)]).toEqual([...rgba.subarray(i * 4, i * 4 + 3)]);
    }
  });

  it("the channels come a layer record a step, the same as all at once", () => {
    const bytes = read("omni-fid-cmyk-blend.psd");
    const { page } = open(bytes, "omni-qa-steps.psd");
    const steps = cmykTileSteps(bytes, page);
    let n = 0, r = steps.next();
    for (; !r.done; r = steps.next()) n++;
    expect(n).toBeGreaterThanOrEqual(4); // one per pixel layer
    expect(same(r.value, cmykTilesOf(bytes, page))).toBe(true);
  });
});

describe("opening does not wait for the channels", () => {
  it("open: the channels are read afterwards, from the page the import made", async () => {
    const bytes = read("omni-fid-cmyk-blend.psd");
    releaseCmykFiles(() => false);
    const fmt = FORMATS.find((f) => f.id === "psd")!;
    const r = await fmt.open!({ bytes, name: "omni-qa-open2.psd" } as never);
    const doc = { assets: r.assets! }, page = r.pages![0];
    expect(cmykStoreOf(doc, page, false)).toBeUndefined(); // not on the way
    const s = await cmykStoreLater(doc, page);
    expect(s!.size).toBeGreaterThan(0);
    expect(same(s, cmykTilesOf(bytes, importPsdPage(bytes, "x", "x", { id: "x", hash: "" }).page))).toBe(true);
  });

  it(".omw that stored every tile (no decode at open): the first draw shows the layers, the composite follows", async () => {
    const bytes = read("omni-fid-cmyk-blend.psd");
    const { doc, page } = open(bytes, "omni-qa-omw.psd");
    releaseCmykFiles(() => false);
    resetCmykView();
    let ready = 0;
    const e = envOf(doc, () => ready++);
    expect(paintCmykRegion(ctx, doc as OmwDocument, page, { x: 0, y: 0, w: page.width, h: page.height }, 1, e)).toBe(false);
    expect(e.incomplete).toBe(true);
    expect(cmykStoreOf(doc, page, false)).toBeUndefined();
    // the background read (here without a worker: the file imported again, then a layer record a task)
    const s = await cmykStoreLater(doc, page);
    expect(ready).toBeGreaterThan(0);
    expect(same(s, cmykTilesOf(bytes, page))).toBe(true);
    // the same work without the page, as the worker does it, gives the same channels
    releaseCmykFiles(() => false);
    expect(same(await prepareCmykStore(doc.assets.a1.hash, bytes), s)).toBe(true);
  });

  it("the worker's reply: the channels for the page sent, or for the file imported there", async () => {
    const bytes = read("omni-fid-cmyk-blend.psd");
    const { page } = open(bytes, "omni-qa-worker.psd");
    const posted: unknown[] = [];
    const scope: { onmessage: ((e: { data: unknown }) => Promise<void>) | null; postMessage: (m: unknown) => void } = { onmessage: null, postMessage: (m) => void posted.push(m) };
    vi.stubGlobal("self", scope);
    await import("../../src/core/fidelity/worker");
    await scope.onmessage!({ data: { kind: "cmyk", bytes, page } });
    await scope.onmessage!({ data: { kind: "cmyk", bytes, page: null } });
    vi.unstubAllGlobals();
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray) {} });
    const want = cmykTilesOf(bytes, page);
    for (const m of posted as { kind: string; tiles: [string, Uint8Array][] }[]) {
      expect(m.kind).toBe("cmyk");
      expect(same(new Map(m.tiles), want)).toBe(true);
    }
    expect(posted).toHaveLength(2);
  });
});

describe("sampling (wand, eyedropper) takes only the tiles it needs", () => {
  it("a sample tile is the screen's level-0 picture; undefined while the channels are read", async () => {
    const bytes = read("omni-fid-cmyk-blend.psd");
    const { doc, page } = open(bytes, "omni-qa-sample.psd");
    releaseCmykFiles(() => false);
    resetCmykView();
    let woke = false;
    expect(cmykSampleTile(doc as OmwDocument, page, 0, 0, () => (woke = true))).toBeUndefined();
    const store = (await cmykStoreLater(doc, page))!;
    expect(woke).toBe(true);
    const px = cmykSampleTile(doc as OmwDocument, page, 0, 0, () => {})!;
    expect(Buffer.compare(Buffer.from(px), Buffer.from(cmykLevelPixels(page, store, 0, 0, 0)))).toBe(0);
  });

  it("the wand reports the tiles it reached that are not filled in; filled in, it is the plain wand", () => {
    const w = 700, h = 300, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(i % w < 650 ? [10, 20, 30, 255] : [200, 0, 0, 255], i * 4);
    const cols = Math.ceil(w / 256), ready = new Uint8Array(cols * Math.ceil(h / 256));
    ready[0] = 1;
    const missing = new Set<number>();
    const partial = wandMask(data, w, h, 5, 5, 8, true, { ready, cols, missing });
    expect([...missing].sort()).toEqual([1, 3]); // right of tile 0 and below it — not the far ones yet
    expect(partial.data[255]).toBe(255); // (255, 0): tile 0
    expect(partial.data[256]).toBe(0); // (256, 0): tile 1, not looked at yet
    ready.fill(1);
    const m2 = new Set<number>();
    const full = wandMask(data, w, h, 5, 5, 8, true, { ready, cols, missing: m2 });
    expect(m2.size).toBe(0);
    expect(Buffer.compare(Buffer.from(full.data), Buffer.from(wandMask(data, w, h, 5, 5, 8, true).data))).toBe(0);
    // a click on a tile not filled in: nothing yet, that tile asked for
    const m3 = new Set<number>();
    ready.fill(0);
    expect(wandMask(data, w, h, 600, 290, 8, false, { ready, cols, missing: m3 }).data.some((v) => v)).toBe(false);
    expect([...m3]).toEqual([5]);
  });
});

describe("CMYK documents: Normal layers that let others show through (QA risk 3)", () => {
  it("omni-fid-cmyk-normal-alpha (Photoshop 2027: opacity 60 %, fill 45 %, soft edges over heavy ink) takes the CMYK path and matches Photoshop", () => {
    const bytes = read("omni-fid-cmyk-normal-alpha.psd");
    const { page, ref } = open(bytes, "omni-qa-normal-alpha.psd");
    expect(page.nodes.filter((n) => n.visible).every((n) => n.blendMode === "NORMAL")).toBe(true);
    expect(cmykComposable(page)).toBe(true);
    const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
    const cmyk = composeRegion(nodes, page.groups, 0, 0, page.width, page.height, cmykTilesOf(bytes, page), page);
    const rgb = composeRegion(nodes, page.groups, 0, 0, page.width, page.height, null, page);
    expect(within2(cmyk, ref)).toBeGreaterThan(99.9);
    expect(within2(rgb, ref)).toBeLessThan(50); // the RGB mix the screen drew before (12.4 %)
  });

  it("omni-fid-cmyk-curves (an adjustment layer, all Normal) takes the CMYK path too", () => {
    const bytes = read("omni-fid-cmyk-curves.psd");
    const { page, ref } = open(bytes, "omni-qa-cmyk-curves.psd");
    expect(cmykComposable(page)).toBe(true);
    const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
    expect(within2(composeRegion(nodes, page.groups, 0, 0, page.width, page.height, cmykTilesOf(bytes, page), page), ref)).toBeGreaterThan(99.9);
    expect(within2(composeRegion(nodes, page.groups, 0, 0, page.width, page.height, null, page), ref)).toBeLessThan(90); // 83 % before
  });

  it("opaque, hard-edged Normal layers over each other stay on the usual path; a soft edge or 99 % opacity moves them", () => {
    const W = 300, H = 200;
    const flat = (c: number[], a = 255) => {
      const px = new Uint8Array(W * H * 4);
      for (let i = 0; i < W * H; i++) px.set([...c, a], i * 4);
      return px;
    };
    const top = flat([30, 40, 200]);
    for (let i = 0; i < W * H; i++) if (i % W > 150) top[i * 4 + 3] = 0; // a hard edge
    const make = (t: Uint8Array, opacity = 1) =>
      importPsdPage(buildPsd({ width: W, height: H, mode: 4, layers: [
        { name: "omni-bottom", px: { rgba: flat([200, 180, 20]), left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL" },
        { name: "omni-top", px: { rgba: t, left: 0, top: 0, width: W, height: H }, opacity, visible: true, blend: "NORMAL" },
      ] }), "x", "x", null).page;
    const hard = make(top);
    const shown = (p: Page) => ({ ...p, nodes: p.nodes.filter((n) => n.id !== p.source?.psd?.compositeNode) });
    expect(cmykComposable(shown(hard))).toBe(false);
    expect(cmykComposable(shown(make(top, 0.99)))).toBe(true);
    const soft = new Uint8Array(top);
    soft[(10 * W + 150) * 4 + 3] = 128;
    expect(cmykComposable(shown(make(soft)))).toBe(true);
  });
});
