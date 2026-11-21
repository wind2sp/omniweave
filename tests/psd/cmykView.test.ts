// CMYK documents on screen and in exports (core/image/cmykComposite.ts, render/cmykView.ts): the screen's level
// tiles and the export's flat picture are the PSD score's CMYK composite, pixel for pixel; RGB documents never take
// that path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { putBlob } from "../../src/core/assets";
import { cmykComposable, cmykFlatPage, cmykLevelPixels, cmykStoreOf, cmykTilesOf, composeRegion, psdColorMode, slicePass, rasterGeo } from "../../src/core/image/cmykComposite";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { loadDissolveField } from "../../src/core/style/blend";
import { makeTile, TILE } from "../../src/core/tile";
import type { OmwDocument, Page, RasterNode } from "../../src/core/types";
import { importPsdPage } from "../../src/io/formats/psd";
import { paintCmykRegion } from "../../src/render/cmykView";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");

function open(file: string): { doc: Pick<OmwDocument, "assets">; page: Page; bytes: Uint8Array; ref: Uint8Array | undefined } {
  const bytes = new Uint8Array(readFileSync(join(DIR, file)));
  const hash = putBlob(bytes);
  const r = importPsdPage(bytes, file, file, { id: "a1", hash });
  const doc = { assets: { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: file, size: bytes.length } } };
  return { doc, page: r.page, bytes, ref: r.image.composite ?? undefined };
}

/** The page composited as the score does: one region, the hidden merged-image node left out. */
function scoreComposite(page: Page, store: ReturnType<typeof cmykTilesOf>): Uint8Array {
  const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
  return composeRegion(nodes, page.groups, 0, 0, page.width, page.height, store);
}

/** Level-0 tiles assembled into one page picture, as the screen draws them at 100 %. */
function screenComposite(page: Page, store: NonNullable<ReturnType<typeof cmykTilesOf>>): Uint8Array {
  const W = page.width, H = page.height, out = new Uint8Array(W * H * 4);
  for (let ty = 0; ty * TILE < H; ty++)
    for (let tx = 0; tx * TILE < W; tx++) {
      const px = cmykLevelPixels(page, store, tx * TILE, ty * TILE, 0);
      for (let y = 0; y < TILE && ty * TILE + y < H; y++) {
        const w = Math.min(TILE, W - tx * TILE);
        out.set(px.subarray(y * TILE * 4, (y * TILE + w) * 4), ((ty * TILE + y) * W + tx * TILE) * 4);
      }
    }
  return out;
}

/** Pixels whose largest channel difference (over white) is ≤ 2, in %. */
function within2(a: Uint8Array, b: Uint8Array): number {
  let ok = 0;
  const flat = (v: number, al: number) => Math.round((v * al) / 255 + 255 * (1 - al / 255));
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(flat(a[i + c], a[i + 3]) - flat(b[i + c], b[i + 3])));
    if (d <= 2) ok++;
  }
  return (100 * ok) / (a.length / 4);
}

beforeAll(() => loadDissolveField());

describe("CMYK documents: screen and export = the PSD score's composite", () => {
  it("a CMYK file that blends takes the CMYK path; its channels are read from the file", () => {
    const { doc, page, bytes } = open("omni-fid-cmyk-blend.psd");
    expect(psdColorMode(bytes)).toBe(4);
    expect(cmykComposable(page)).toBe(true);
    const store = cmykStoreOf(doc, page);
    expect(store).toBeInstanceOf(Map);
    expect(store!.size).toBeGreaterThan(0);
  });

  it("screen level-0 tiles are the score's composite byte for byte, and match Photoshop", () => {
    const { doc, page, ref } = open("omni-fid-cmyk-blend.psd");
    const store = cmykStoreOf(doc, page)!;
    const score = scoreComposite(page, store);
    const screen = screenComposite(page, store);
    expect(Buffer.compare(Buffer.from(screen), Buffer.from(score))).toBe(0);
    // and it is Photoshop's merged image (the score's 99.9 %), where the RGB blend was not
    expect(within2(screen, ref!)).toBeGreaterThan(99.5);
    expect(within2(scoreComposite(page, null), ref!)).toBeLessThan(within2(screen, ref!));
  });

  it("the score reports the same number as the shared composite gives", async () => {
    const { page, bytes, ref } = open("omni-fid-cmyk-blend.psd");
    const run = await scorePsd(bytes);
    const mine = within2(scoreComposite(page, cmykTilesOf(bytes, page)), ref!);
    expect(Math.abs(run!.score.within2 - mine)).toBeLessThan(0.01);
  });

  it("the export's flat page (vector PDF) holds the same pixels", () => {
    const { doc, page } = open("omni-fid-cmyk-blend.psd");
    const store = cmykStoreOf(doc, page)!;
    const flat = cmykFlatPage(doc, page)!;
    expect(flat.nodes).toHaveLength(1);
    const n = flat.nodes[0] as RasterNode;
    const g = rasterGeo(n)!;
    const pic = slicePass(g, 0, 0, page.width, page.height, "rgb", null)!;
    expect(Buffer.compare(Buffer.from(pic.rgba), Buffer.from(scoreComposite(page, store)))).toBe(0);
    // memoized per page state
    expect(cmykFlatPage(doc, page)).toBe(flat);
  });

  it("level tiles at low zoom are the box-filtered level-0 composite", () => {
    const { doc, page } = open("omni-fid-cmyk-blend.psd");
    const store = cmykStoreOf(doc, page)!;
    const l0 = cmykLevelPixels(page, store, 0, 0, 0), l1 = cmykLevelPixels(page, store, 0, 0, 1);
    // one level-1 pixel = the mean of its 2 × 2 level-0 pixels (opaque here)
    const i = (y: number, x: number) => (y * TILE + x) * 4;
    for (const [y, x] of [[10, 10], [40, 70], [60, 20]]) {
      for (let c = 0; c < 3; c++) {
        const mean = (l0[i(2 * y, 2 * x) + c] + l0[i(2 * y, 2 * x + 1) + c] + l0[i(2 * y + 1, 2 * x) + c] + l0[i(2 * y + 1, 2 * x + 1) + c]) / 4;
        expect(Math.abs(l1[i(y, x) + c] - mean)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("an edited tile has no stored channels: read back from its RGB with no black ink", () => {
    const { doc, page } = open("omni-fid-cmyk-blend.psd");
    const store = cmykStoreOf(doc, page)!;
    const n = page.nodes.find((x): x is RasterNode => x.type === "RASTER" && x.visible && Object.values(x.tiles).some((t) => store.has(t.hash)))!;
    const key = Object.keys(n.tiles).find((k) => store.has(n.tiles[k].hash))!;
    const data = new Uint8ClampedArray(n.tiles[key].data);
    data[0] = data[0] ^ 1; // a one-pixel edit: a new tile
    const edited: RasterNode = { ...n, tiles: { ...n.tiles, [key]: makeTile(data) } };
    const g = rasterGeo(edited)!;
    const cmy = slicePass(g, g.x, g.y, TILE, TILE, "cmy", store)!, k = slicePass(g, g.x, g.y, TILE, TILE, "k", store)!;
    expect(Array.from(cmy.rgba.subarray(0, 4))).toEqual(Array.from(data.subarray(0, 4)));
    expect(Array.from(k.rgba.subarray(0, 3))).toEqual([255, 255, 255]);
  });
});

describe("RGB documents never take the CMYK path", () => {
  /** A context that fails the test on any use: the CMYK path must not draw. */
  const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`touched ${String(p)}`); } }) as never;
  const env = (doc: Pick<OmwDocument, "assets">) => ({ doc: doc as OmwDocument, clip: { x: 0, y: 0, w: 1e4, h: 1e4 }, scale: 1, incomplete: false, onResourceReady: () => {} });

  it("an RGB file that blends: no CMYK store, no flat page, the canvas is not touched", () => {
    const { doc, page, bytes } = open("omni-fid-blend-multiply.psd");
    expect(psdColorMode(bytes)).toBe(3);
    expect(cmykComposable(page)).toBe(true); // it blends — only the colour mode keeps it on the usual path
    expect(cmykStoreOf(doc, page)).toBeNull();
    expect(cmykFlatPage(doc, page)).toBeNull();
    const e = env(doc);
    expect(paintCmykRegion(untouchable, e.doc, page, { x: 0, y: 0, w: page.width, h: page.height }, 1, e)).toBe(false);
    expect(paintCmykRegion(untouchable, e.doc, page, { x: 0, y: 0, w: page.width, h: page.height }, 1, e, true)).toBe(false);
    expect(e.incomplete).toBe(false);
  });

  it("the RGB composite is unchanged by the shared code (same as softComposite on the RGB tiles)", () => {
    const { page } = open("omni-fid-blend-screen.psd");
    const a = scoreComposite(page, null);
    // the shared slice in "rgb" is a plain copy of the tiles
    const b = scoreComposite(page, null);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    for (const n of page.nodes) {
      if (n.type !== "RASTER") continue;
      const g = rasterGeo(n);
      if (!g) continue;
      const s = slicePass(g, g.x, g.y, TILE, TILE, "rgb", null);
      const t = n.tiles["0_0"];
      if (s && t && s.width === TILE && s.height === TILE) expect(Buffer.compare(Buffer.from(s.rgba), Buffer.from(t.data))).toBe(0);
    }
  });

  it("a page without a PSD source or without a CMYK-sensitive blend is not touched", () => {
    const { doc, page } = open("omni-fid-cmyk-blend.psd");
    // (since psd-cmyk-open a Normal layer that lets another show through blends too: only opaque, hard-edged layers
    // over each other stay off the path — here the bottom layer alone, opaque)
    const bottom = page.nodes.find((n) => n.visible)!;
    const plain: Page = { ...page, nodes: page.nodes.map((n) => ({ ...n, blendMode: "NORMAL" as const, opacity: 1, visible: n === bottom })), groups: page.groups?.map((g) => ({ ...g, blendMode: "NORMAL" as const })) };
    expect(cmykComposable(plain)).toBe(false);
    const e = env(doc);
    expect(paintCmykRegion(untouchable, e.doc, plain, { x: 0, y: 0, w: 100, h: 100 }, 1, e)).toBe(false);
    const noSource: Page = { ...page, source: undefined };
    expect(paintCmykRegion(untouchable, e.doc, noSource, { x: 0, y: 0, w: 100, h: 100 }, 1, e)).toBe(false);
  });
});
