// PSD self-scoring (core/fidelity): the merged image Photoshop saves in a PSD is the ground truth for our render.
// Reference files: qa/interop/adobe-made (Photoshop-made). Synthetic files: psdWrite.buildPsd with a tampered
// merged image (Omniweave violet thread on a weft-white canvas), so the mismatching tile is known exactly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { buildCache, liveTiles, nodeSig } from "../../src/core/fidelity/overlay";
import { badTiles, formatWithin, heatGrid, isBadTile, scorePsd } from "../../src/core/fidelity/psdScore";
import { startScore } from "../../src/core/fidelity/run";
import { dehydrate, hydrate } from "../../src/core/loom";
import { newDocument, newRaster, type Page, type RasterNode } from "../../src/core/types";
import { decodePsd, importPsdPage } from "../../src/io/formats/psd";
import { buildPsd, writePsd } from "../../src/io/formats/psdWrite";
import { DICTS } from "../../src/i18n";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

/** 600×300 (3×2 tiles): weft-white base + a violet thread; `tamper` paints a 40×40 red patch into the merged image. */
function weave(tamper?: { x: number; y: number }, blankComposite = false) {
  const W = 600, H = 300;
  const base = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) base.set([250, 249, 246, 255], i * 4);
  const tw = 520, th = 24;
  const thread = new Uint8Array(tw * th * 4);
  for (let i = 0; i < tw * th; i++) thread.set([124, 92, 255, 255], i * 4);
  const layers = [
    { name: "Weft", px: { rgba: base, left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL" as const },
    { name: "Omniweave thread", px: { rgba: thread, left: 40, top: 140, width: tw, height: th }, opacity: 0.9, visible: true, blend: "NORMAL" as const },
  ];
  // our own merged image (what the writer computes), then tampered
  const composite = decodePsd(buildPsd({ width: W, height: H, layers })).composite!;
  if (tamper)
    for (let y = tamper.y; y < tamper.y + 40; y++) for (let x = tamper.x; x < tamper.x + 40; x++) composite.set([230, 30, 40, 255], (y * W + x) * 4);
  if (blankComposite) composite.fill(255);
  return buildPsd({ width: W, height: H, layers, composite });
}

function open(bytes: Uint8Array) {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "weave.psd");
  const r = importPsdPage(bytes, "weave.psd", "weave", asset);
  return { page: r.page, asset };
}

describe("PSD self-score: Photoshop-made reference files", () => {
  for (const name of ["psd_clip_basic", "psd_group_opacity", "psd_nested", "psd_clip_in_group", "ps_16bit_rgb", "ps_cmyk_8bit"])
    it(`${name}: every tile matches the merged image`, async () => {
      const { score } = (await scorePsd(read(name + ".psd")))!;
      expect(score.status).toBe("ok");
      expect(score.within2).toBe(100);
      expect(score.max).toBeLessThanOrEqual(2);
      expect(score.ssim).toBeGreaterThan(0.9995);
      expect(score.bad).toEqual([]);
      expect(score.done).toBe(score.rows);
    });

  it("psd_clip_text: only the text-rim tiles mismatch (Photoshop's text gamma)", async () => {
    const { score } = (await scorePsd(read("psd_clip_text.psd")))!;
    expect(score.within2).toBeGreaterThan(98);
    expect(score.ssim).toBeGreaterThan(0.999);
    expect(badTiles(score).size).toBeGreaterThan(0);
    expect(badTiles(score).size).toBeLessThan(score.cols * score.rows);
  });

  it("ps_text_effects: layer effects we do not draw are found, the score says so", async () => {
    const { score } = (await scorePsd(read("ps_text_effects.psd")))!;
    expect(score.status).toBe("ok");
    // (its adjustment layers are drawn since 2026-11-13: about 98 %; the bevel / satin it carries still are not)
    expect(score.within2).toBeLessThan(99);
    expect(score.max).toBeGreaterThan(100);
    expect(badTiles(score).size).toBeGreaterThan(0);
    // the heat map is there and agrees with the max
    const g = heatGrid(score)!;
    expect(g.length).toBe(score.heat!.w * score.heat!.h);
    expect(Math.max(...g)).toBe(score.max);
  });
});

describe("PSD self-score: synthetic files", () => {
  it("an exact merged image scores 100% with no mismatching tile", async () => {
    const { score, layerBounds } = (await scorePsd(weave()))!;
    expect(score).toMatchObject({ status: "ok", within2: 100, bad: [], cols: 3, rows: 2 });
    // the writer's merged image and the scorer's render are the same compositor, up to 8-bit rounding
    expect(score.max).toBeLessThanOrEqual(1);
    expect(score.ssim).toBeGreaterThan(0.99999);
    expect(layerBounds.filter(Boolean)).toEqual([[0, 0, 768, 512], [40, 140, 768, 256]]);
  });

  it("a tampered tile is the only mismatching one, with its size and the heat map", async () => {
    const { score } = (await scorePsd(weave({ x: 300, y: 20 })))!; // tile (1, 0)
    expect([...badTiles(score).keys()]).toEqual([1]);
    expect(badTiles(score).get(1)![1]).toBe(1600);
    expect(score.within2).toBeCloseTo(100 - (100 * 1600) / (600 * 300), 6);
    expect(score.ssim).toBeLessThan(1);
    const g = heatGrid(score)!;
    const { block, w } = score.heat!;
    const at = (x: number, y: number) => g[Math.floor(y / block) * w + Math.floor(x / block)];
    expect(at(310, 30)).toBeGreaterThan(200);
    expect(at(100, 200)).toBeLessThanOrEqual(1);
  });

  it("files without ground truth: flat, blank merged image", async () => {
    expect((await scorePsd(weave(undefined, true)))!.score).toMatchObject({ status: "none", reason: "blankComposite" });
    const flat = buildPsd({ width: 64, height: 64, layers: [], composite: new Uint8Array(64 * 64 * 4).fill(200) });
    expect((await scorePsd(flat))!.score).toMatchObject({ status: "none", reason: "flat" });
  });

  it("progress after every tile row; a big file is scored in bounded regions; stop cancels", async () => {
    const seen: number[] = [];
    const run = await scorePsd(weave({ x: 300, y: 20 }), { regionPixels: 256 * 256, onProgress: (d, total, partial) => (seen.push(d), expect(partial.done).toBe(d), expect(total).toBe(2)) });
    expect(seen).toEqual([1, 2]);
    expect([...badTiles(run!.score).keys()]).toEqual([1]);
    let rows = 0;
    expect(await scorePsd(weave(), { onProgress: () => rows++, shouldStop: () => rows >= 1 })).toBeNull();
    // the client: no Worker under Node → same result on this thread; cancel resolves null
    const job = startScore(weave({ x: 300, y: 20 }));
    expect([...badTiles((await job.promise)!.score).keys()]).toEqual([1]);
    const j2 = startScore(weave());
    j2.cancel();
    expect(await j2.promise).toBeNull();
  });

  it("isBadTile ignores lone noisy pixels", () => {
    expect(isBadTile(3, 200, 65536)).toBe(false);
    expect(isBadTile(4, 60, 65536)).toBe(true);
    expect(isBadTile(70, 3, 65536)).toBe(true);
    expect(isBadTile(16, 3, 65536)).toBe(false);
    expect(formatWithin(99.99)).toBe("99.9");
    expect(formatWithin(100)).toBe("100");
  });
});

describe("fidelity overlay: shown until the layers under a tile are edited", () => {
  async function scored(tamper = { x: 300, y: 20 }) {
    const bytes = weave(tamper);
    const { page } = open(bytes);
    const run = (await scorePsd(bytes))!;
    return { page, cache: buildCache(page, run, page.source!.psd!.hash) };
  }
  const nodeNamed = (p: Page, n: string) => p.nodes.find((x) => x.name === n)! as RasterNode;
  const edit = (p: Page, fn: (d: Page) => void) => produce(p, fn);

  it("unedited: the mismatching tile shows the merged image", async () => {
    const { page, cache } = await scored();
    expect(liveTiles(page, cache)).toEqual({ shown: [1], edited: [] });
  });

  it("editing a layer that reaches the tile releases it; undo (the old page) brings it back", async () => {
    const { page, cache } = await scored();
    const changed = edit(page, (d) => void (nodeNamed(d, "Weft").opacity = 0.5));
    expect(liveTiles(changed, cache)).toEqual({ shown: [], edited: [1] });
    expect(liveTiles(page, cache)).toEqual({ shown: [1], edited: [] });
  });

  it("only tiles under the edit are released (thread far from a tampered tile)", async () => {
    const { page, cache } = await scored({ x: 520, y: 260 }); // tile (2, 1)
    expect(liveTiles(page, cache).shown).toEqual([5]);
    // the thread layer (y 140..164, x 40..560) — its box reaches tile 5 too, so pick an edit far away: a new node
    const far = edit(page, (d) => void d.nodes.push({ ...newRaster("note"), transform: { x: 10, y: 10, rotation: 0, scale: 1 } }));
    expect(liveTiles(far, cache)).toEqual({ shown: [5], edited: [] });
    const near = edit(page, (d) => void d.nodes.push({ ...newRaster("note"), transform: { x: 500, y: 250, rotation: 0, scale: 1 } }));
    expect(liveTiles(near, cache)).toEqual({ shown: [], edited: [5] });
  });

  it("hiding, deleting, moving, reordering and renaming", async () => {
    const { page, cache } = await scored();
    expect(liveTiles(edit(page, (d) => void (nodeNamed(d, "Weft").visible = false)), cache).edited).toEqual([1]);
    expect(liveTiles(edit(page, (d) => void (d.nodes = d.nodes.filter((n) => n.name !== "Weft"))), cache).edited).toEqual([1]);
    expect(liveTiles(edit(page, (d) => void (nodeNamed(d, "Weft").transform.x = 3)), cache).edited).toEqual([1]);
    expect(liveTiles(edit(page, (d) => void d.nodes.reverse()), cache).edited).toEqual([1]);
    // renaming or locking changes no pixel
    expect(liveTiles(edit(page, (d) => void ((nodeNamed(d, "Weft").name = "Weft 2"), (d.nodes[0].locked = true))), cache).shown).toEqual([1]);
    expect(nodeSig(page.nodes[0])).toBe(nodeSig(edit(page, (d) => void (d.nodes[0].name = "x")).nodes[0]));
  });

  it("a layer edited before the score arrived never shows the merged image", async () => {
    const bytes = weave({ x: 300, y: 20 });
    const { page } = open(bytes);
    const edited = edit(page, (d) => void (nodeNamed(d, "Weft").opacity = 0.4));
    const cache = buildCache(edited, (await scorePsd(bytes))!, "h");
    expect(liveTiles(edited, cache)).toEqual({ shown: [], edited: [1] });
  });
});

describe("score cache in page.source.psdScore", () => {
  it("survives the .omw graph round trip and never changes the PSD export", async () => {
    const bytes = weave({ x: 300, y: 20 });
    const { page, asset } = open(bytes);
    const cache = buildCache(page, (await scorePsd(bytes))!, asset.hash);
    page.source!.psdScore = cache;
    const doc = newDocument("t");
    doc.pages = [page];
    doc.assets[asset.id] = asset;
    const { graph, tiles } = dehydrate(doc);
    const back = hydrate(graph, (h) => tiles.get(h)).doc;
    expect(back.pages[0].source!.psdScore).toEqual(cache);
    // an unedited page still saves the original bytes: the score / overlay is never written into the file
    const res = await writePsd(doc, page);
    expect(res.method).toBe("original");
    expect(res.bytes.every((v, i) => v === bytes[i])).toBe(true);
  });
});

describe("fidelity strings", () => {
  it("exist in every language", () => {
    const keys = Object.keys(DICTS.ko).filter((k) => k.startsWith("fidelity."));
    expect(keys.length).toBeGreaterThan(15);
    for (const l of ["en", "zh", "ja"] as const) for (const k of keys) expect(DICTS[l][k], `${l} ${k}`).toBeTruthy();
  });
});
