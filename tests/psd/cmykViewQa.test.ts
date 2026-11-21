// QA of the CMYK screen / export path (core/image/cmykComposite.ts, render/cmykView.ts): a layer's CMYK channels must
// be its own even when another layer's tile converts to the same RGB, and the screen cache must not mix documents.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { putBlob } from "../../src/core/assets";
import * as cmyk from "../../src/core/image/cmykComposite";
import { cmykStoreOf, cmykTilesOf, composeCmykPageRegion, composeRegion } from "../../src/core/image/cmykComposite";
import { makeTile, TILE } from "../../src/core/tile";
import type { OmwDocument, Page, RasterNode } from "../../src/core/types";
import { FORMATS } from "../../src/io/formats";
import { importPsdPage } from "../../src/io/formats/psd";
import { paintCmykRegion, resetCmykView } from "../../src/render/cmykView";
import type { DrawEnv } from "../../src/render/draw";

// These files carry no colour profile; the channel bookkeeping is checked on the colour-unmanaged conversion, where a
// black-ink grey and a C = M = Y grey are the same RGB (through the shipped default profile, FOGRA39, they are not —
// iccCmyk.test.ts / defaultCmyk.test.ts cover that path)
vi.mock("../../src/core/image/iccCmyk", async (orig) => {
  const m = await orig<typeof import("../../src/core/image/iccCmyk")>();
  return { ...m, defaultCmykProfile: () => null };
});

// level pictures are counted: the screen's background work must come in level-0 units
vi.mock("../../src/core/image/cmykComposite", async (orig) => {
  const m = await orig<typeof import("../../src/core/image/cmykComposite")>();
  return { ...m, cmykLevelPixels: vi.fn(m.cmykLevelPixels) };
});

/** One layer of a raw CMYK PSD: stored channel values (255 = no ink), one value per channel, filling w × h. */
interface RawLayer {
  name: string;
  left: number;
  top: number;
  w: number;
  h: number;
  cmyk: [number, number, number, number];
  blend: string; // PSD blend key, e.g. "norm", "mul "
}

/** An uncompressed 8-bit CMYK PSD (public spec) whose layers are flat CMYK fills — any C, M, Y, K, not just GCR. */
function rawCmykPsd(W: number, H: number, layers: RawLayer[]): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 255);
  const u16 = (v: number) => (u8(v >> 8), u8(v));
  const u32 = (v: number) => (u16(v >>> 16), u16(v & 0xffff));
  const str = (s: string) => [...s].forEach((c) => u8(c.charCodeAt(0)));
  str("8BPS");
  u16(1);
  for (let i = 0; i < 6; i++) u8(0);
  u16(4); // C M Y K
  u32(H);
  u32(W);
  u16(8);
  u16(4); // CMYK
  u32(0); // colour mode data
  u32(0); // image resources
  // layer & mask section
  const lm: number[] = [];
  const w8 = (a: number[], v: number) => a.push(v & 255);
  const w16 = (a: number[], v: number) => (w8(a, v >> 8), w8(a, v));
  const w32 = (a: number[], v: number) => (w16(a, v >>> 16), w16(a, v & 0xffff));
  const li: number[] = [];
  w16(li, layers.length);
  const chIds = [0, 1, 2, 3, -1];
  for (const l of layers) {
    w32(li, l.top);
    w32(li, l.left);
    w32(li, l.top + l.h);
    w32(li, l.left + l.w);
    w16(li, chIds.length);
    for (const id of chIds) {
      w16(li, id & 0xffff);
      w32(li, 2 + l.w * l.h);
    }
    for (const c of "8BIM") w8(li, c.charCodeAt(0));
    for (const c of l.blend) w8(li, c.charCodeAt(0));
    w8(li, 255); // opacity
    w8(li, 0); // clipping
    w8(li, 0); // flags (visible)
    w8(li, 0);
    const name = [l.name.length, ...[...l.name].map((c) => c.charCodeAt(0))];
    while (name.length % 4) name.push(0);
    w32(li, 8 + name.length);
    w32(li, 0); // mask
    w32(li, 0); // blending ranges
    for (const v of name) li.push(v);
  }
  for (const l of layers)
    for (const id of chIds) {
      w16(li, 0); // raw
      const v = id < 0 ? 255 : l.cmyk[id];
      for (let i = 0; i < l.w * l.h; i++) w8(li, v);
    }
  if (li.length % 2) li.push(0);
  w32(lm, li.length);
  for (const v of li) lm.push(v);
  w32(lm, 0); // global mask
  u32(lm.length);
  for (const v of lm) out.push(v);
  // merged image: raw, white (it is not what these tests look at)
  u16(0);
  for (let i = 0; i < 4 * W * H; i++) u8(255);
  return new Uint8Array(out);
}

function open(bytes: Uint8Array, file = "omni-qa-cmyk.psd"): { doc: Pick<OmwDocument, "assets">; page: Page } {
  const hash = putBlob(bytes);
  const r = importPsdPage(bytes, file, file, { id: "a1", hash });
  return { doc: { assets: { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: file, size: bytes.length } } }, page: r.page };
}

/** CMYK multiply on stored values (255 = no ink) and the reader's conversion — what Photoshop shows. */
const mul = (a: number, b: number) => Math.round((a * b) / 255);
const toR = (c: number, k: number) => 255 - Math.min(255, 255 - c + (255 - k));

describe("CMYK channels are the layer's own, not another layer's with the same RGB", () => {
  // grey 128 two ways: black ink only, and C = M = Y with no black — the same RGB tile, other channels
  const kGrey: RawLayer = { name: "omni-k", left: 0, top: 0, w: 256, h: 256, cmyk: [255, 255, 255, 128], blend: "norm" };
  const cmyGrey: RawLayer = { name: "omni-cmy", left: 0, top: 0, w: 256, h: 256, cmyk: [128, 128, 128, 255], blend: "mul " };
  const expectR = toR(mul(255, 128), mul(128, 255)); // C 128, K 128 → 1

  it("the two fills import to the same RGB tile (the case the store's hash keys cannot tell apart)", () => {
    const { page } = open(rawCmykPsd(256, 256, [kGrey, cmyGrey]));
    const hashes = page.nodes.filter((n) => n.type === "RASTER" && n.visible && n.tiles["0_0"]).map((n) => (n as any).tiles["0_0"].hash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("score and screen composite multiply the layers' own channels (grey × grey in CMYK)", () => {
    const bytes = rawCmykPsd(256, 256, [kGrey, cmyGrey]);
    const { doc, page } = open(bytes);
    const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
    const score = composeRegion(nodes, page.groups, 0, 0, 256, 256, cmykTilesOf(bytes, page), page);
    expect(Math.abs(score[(100 * 256 + 100) * 4] - expectR)).toBeLessThanOrEqual(1);
    const screen = composeCmykPageRegion(page, 0, 0, 256, 256, cmykStoreOf(doc, page)!);
    expect(Math.abs(screen[(100 * 256 + 100) * 4] - expectR)).toBeLessThanOrEqual(1);
    // and the other order (black-ink fill on top) too
    const b2 = rawCmykPsd(256, 256, [{ ...cmyGrey, blend: "norm" }, { ...kGrey, blend: "mul " }]);
    const o2 = open(b2, "omni-qa-cmyk2.psd");
    const s2 = composeCmykPageRegion(o2.page, 0, 0, 256, 256, cmykStoreOf(o2.doc, o2.page)!);
    expect(Math.abs(s2[(100 * 256 + 100) * 4] - expectR)).toBeLessThanOrEqual(1);
  });

  it("a moved layer keeps its own channels", () => {
    const bytes = rawCmykPsd(512, 256, [kGrey, cmyGrey]);
    const { doc, page } = open(bytes);
    const store = cmykStoreOf(doc, page)!;
    const top = page.nodes.find((n) => n.name === "omni-cmy")!;
    const moved: Page = { ...page, nodes: page.nodes.map((n) => (n === top ? { ...n, transform: { ...n.transform, x: 256 } } : n)) };
    const px = composeCmykPageRegion(moved, 256, 0, 256, 256, store);
    // the CMY-only grey alone (no black ink) over white: R = 128
    expect(Math.abs(px[(10 * 256 + 10) * 4] - 128)).toBeLessThanOrEqual(1);
    const left = composeCmykPageRegion(moved, 0, 0, 256, 256, store);
    expect(Math.abs(left[(10 * 256 + 10) * 4] - 128)).toBeLessThanOrEqual(1);
  });
});

// ───────── the screen path (render/cmykView.ts) with a stand-in canvas ─────────

class FakeImageData {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
}
class FakeCanvas {
  px: Uint8ClampedArray | null = null;
  constructor(public width: number, public height: number) {}
  getContext() {
    return { putImageData: (img: FakeImageData) => void (this.px = img.data) };
  }
}
vi.stubGlobal("OffscreenCanvas", FakeCanvas);
vi.stubGlobal("ImageData", FakeImageData);

/** A context that records the pictures drawn. */
function recorder() {
  const draws: { cv: FakeCanvas; x: number; y: number; w: number }[] = [];
  const c = { save() {}, restore() {}, imageSmoothingEnabled: true, drawImage: (cv: FakeCanvas, x: number, y: number, w: number) => void draws.push({ cv, x, y, w }) };
  return { c: c as never, draws };
}

const envOf = (doc: Pick<OmwDocument, "assets">, ready = () => {}): DrawEnv => ({ doc: doc as OmwDocument, clip: { x: 0, y: 0, w: 1e5, h: 1e5 }, scale: 1, incomplete: false, onResourceReady: ready });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Paint until the CMYK tiles are all there (background work), at most `tasks` tasks. */
async function paintSettled(doc: Pick<OmwDocument, "assets">, page: Page, scale: number, tasks = 400) {
  for (let i = 0; i < tasks; i++) {
    const r = recorder();
    if (paintCmykRegion(r.c, doc as OmwDocument, page, { x: 0, y: 0, w: page.width, h: page.height }, scale, envOf(doc))) return r.draws;
    await tick();
  }
  throw new Error("not settled");
}

const levelCalls = () => vi.mocked(cmyk.cmykLevelPixels).mock.calls;

describe("CMYK screen: cache, background work and the first draw", () => {
  const kGrey: RawLayer = { name: "omni-k", left: 0, top: 0, w: 1024, h: 1024, cmyk: [255, 255, 255, 128], blend: "norm" };
  const cmyGrey: RawLayer = { name: "omni-cmy", left: 0, top: 0, w: 1024, h: 1024, cmyk: [128, 128, 128, 255], blend: "mul " };
  beforeEach(() => {
    resetCmykView();
    vi.mocked(cmyk.cmykLevelPixels).mockClear();
  });

  it("opening a CMYK PSD that blends reads its channels then: the first draw does not import the file again", async () => {
    // (since psd-cmyk-open: in the background, from the page the import made — opening does not wait for them)
    const bytes = rawCmykPsd(512, 256, [{ ...kGrey, w: 512, h: 256 }, { ...cmyGrey, w: 512, h: 256 }]);
    const fmt = FORMATS.find((f) => f.id === "psd")!;
    const r = await fmt.open!({ bytes, name: "omni-qa-open.psd" } as never);
    const doc = { assets: r.assets! };
    expect(cmykStoreOf(doc, r.pages![0], false)).toBeUndefined();
    expect(await cmyk.cmykStoreLater(doc, r.pages![0])).toBeInstanceOf(Map);
    expect(cmykStoreOf(doc, r.pages![0], false)).toBeInstanceOf(Map);
  });

  it("zoomed out, the background work comes in level-0 tiles; an edit recomputes only the tile it touched", async () => {
    const { doc, page } = open(rawCmykPsd(1024, 1024, [kGrey, cmyGrey]), "omni-qa-pyramid.psd");
    const scale = 1 / 4; // level 2: one picture of the whole page
    await paintSettled(doc, page, scale);
    const calls = levelCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c[4] === 0)).toBe(true); // no task composites a whole zoomed-out picture at once
    expect(calls.length).toBe(16);
    // one 256 px tile of the top layer changes
    vi.mocked(cmyk.cmykLevelPixels).mockClear();
    const top = page.nodes.find((n) => n.name === "omni-cmy") as RasterNode;
    const data = new Uint8ClampedArray(top.tiles["1_1"].data);
    data.fill(200, 0, 4 * 64);
    const edited: Page = { ...page, nodes: page.nodes.map((n) => (n === top ? { ...top, tiles: { ...top.tiles, "1_1": makeTile(data) } } : n)) };
    await paintSettled(doc, edited, scale);
    // the edited tile and the neighbours whose weave keys take in its edge (core/loom.ts) — not the 16 of the page
    expect(levelCalls().filter((c) => c[4] === 0).length).toBeLessThanOrEqual(4);
    expect(levelCalls().every((c) => c[4] === 0)).toBe(true);
  });

  it("a result computed for an older state is not drawn for the new one", async () => {
    const { doc, page } = open(rawCmykPsd(512, 512, [{ ...kGrey, w: 512, h: 512 }, { ...cmyGrey, w: 512, h: 512 }]), "omni-qa-race.psd");
    const store = cmykStoreOf(doc, page)!;
    // ask for state A without waiting, then the user lowers the top layer's opacity (state B) before the work is done
    const r = recorder();
    paintCmykRegion(r.c, doc as OmwDocument, page, { x: 0, y: 0, w: 512, h: 512 }, 1 / 2, envOf(doc));
    const hidden: Page = { ...page, nodes: page.nodes.map((n) => (n.name === "omni-cmy" ? { ...n, opacity: 0.5 } : n)) };
    const draws = await paintSettled(doc, hidden, 1 / 2);
    expect(draws).toHaveLength(1);
    const want = cmyk.cmykLevelPixels(hidden, store, 0, 0, 1);
    expect(Buffer.compare(Buffer.from(draws[0].cv.px!), Buffer.from(want))).toBe(0);
  });

  it("two documents with the same layers but other files do not share cached tiles", async () => {
    const a = open(rawCmykPsd(256, 256, [{ ...kGrey, w: 256, h: 256 }, { ...cmyGrey, w: 256, h: 256 }]), "omni-qa-docA.psd");
    // the same page (a copy of the document) with another file behind it: the black-ink grey on both layers
    const bytesB = rawCmykPsd(256, 256, [{ ...kGrey, w: 256, h: 256 }, { ...kGrey, name: "omni-cmy", w: 256, h: 256, blend: "mul " }]);
    const hashB = putBlob(bytesB);
    const docB = { assets: { a1: { ...a.doc.assets.a1, hash: hashB } } };
    const da = await paintSettled(a.doc, a.page, 1);
    const db = await paintSettled(docB, a.page, 1);
    const pa = da[0].cv.px!, pb = db[0].cv.px!;
    expect(Math.abs(pa[(5 * 256 + 5) * 4] - expectR0)).toBeLessThanOrEqual(1);
    // file B: K 128 × K 128 → K 64, no C → R 64
    expect(Math.abs(pb[(5 * 256 + 5) * 4] - 64)).toBeLessThanOrEqual(1);
  });
});

const expectR0 = toR(mul(255, 128), mul(128, 255));

describe("vector PDF of an edited CMYK page that blends (cmykFlatPage)", () => {
  it("opens, draws one picture, and is not much larger than the unedited page's PDF", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { exportPdfVector } = await import("../../src/io/pdfVector");
    const { newDocument } = await import("../../src/core/types");
    const pdfjs: any = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
    const file = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity", "omni-fid-cmyk-blend.psd");
    const bytes = new Uint8Array(readFileSync(file));
    const { doc: d0, page } = open(bytes, "omni-fid-cmyk-blend.psd");
    const doc = { ...newDocument("omni-cmyk-pdf"), assets: d0.assets as OmwDocument["assets"] };
    // an edit: a layer moved by one pixel
    const n = page.nodes.find((x) => x.type === "RASTER" && x.visible && x.id !== page.source?.psd?.compositeNode)!;
    const edited: Page = { ...page, nodes: page.nodes.map((x) => (x === n ? { ...x, transform: { ...x.transform, x: x.transform.x + 1 } } : x)) };
    expect(cmyk.cmykFlatPage(doc, edited)).not.toBeNull();
    const unedited = await exportPdfVector({ ...doc, pages: [page] }, [page]);
    const flat = await exportPdfVector({ ...doc, pages: [edited] }, [edited]);
    // the same edit drawn as before (no file behind it: the RGB layers)
    const noFile = { ...doc, assets: {} };
    const again: Page = { ...edited }; // cmykFlatPage is memoized per page object
    const layered = await exportPdfVector({ ...noFile, pages: [again] }, [again]);
    expect(await images(layered)).toBeGreaterThan(1);
    async function images(b: Uint8Array) {
      const d = await pdfjs.getDocument({ data: b.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
      const list = await (await d.getPage(1)).getOperatorList();
      const n = list.fnArray.filter((f: number) => f === pdfjs.OPS.paintImageXObject).length;
      await d.destroy();
      return n;
    }
    expect(await images(flat)).toBe(1);
    console.log(`[cmyk-pdf] unedited ${unedited.length} B, edited CMYK flat ${flat.length} B, edited RGB layers ${layered.length} B`);
    expect(flat.length).toBeLessThan(unedited.length * 2);
  }, 60_000);
});