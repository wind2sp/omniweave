// Rough timings of the CMYK screen path on a large synthesized CMYK PSD (Node, one thread — what the app's main
// thread would spend). Opt-in: OMW_CMYK_PERF=1 npx vitest run tests/psd/cmykPerf.test.ts
import { describe, expect, it, vi } from "vitest";
import { putBlob } from "../../src/core/assets";
import { cmykFlatPage, cmykLevel, cmykLevelPixels, cmykStoreLater, cmykStoreOf, cmykTileSteps, cmykTilesOf, prepareCmykStore, releaseCmykFiles, seedCmykStore } from "../../src/core/image/cmykComposite";
import { makeTile } from "../../src/core/tile";
import type { Page, RasterNode } from "../../src/core/types";
import { cmykSampleTile, paintCmykRegion, resetCmykView } from "../../src/render/cmykView";
import { loadDissolveField } from "../../src/core/style/blend";
import { TILE } from "../../src/core/tile";
import { importPsdPage } from "../../src/io/formats/psd";
import { buildPsd, type FreshLayer } from "../../src/io/formats/psdWrite";

const run = process.env.OMW_CMYK_PERF === "1";
const W = Number(process.env.OMW_CMYK_W ?? 4000), H = Number(process.env.OMW_CMYK_H ?? 3000);

function photo(seed: number): Uint8Array {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      px[i] = (x * 3 + y + seed * 40) & 255;
      px[i + 1] = (y * 2 + seed * 70) & 255;
      px[i + 2] = ((x ^ y) + seed * 9) & 255;
      px[i + 3] = 255;
    }
  return px;
}

describe.runIf(run)("CMYK path on a large file (timings)", () => {
  it(`${W}×${H}, 5 layers that blend`, async () => {
    await loadDissolveField();
    const blends = ["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "SOFT_LIGHT"] as const;
    const layers: FreshLayer[] = blends.map((b, i) => ({ name: `omni-L${i}`, px: { rgba: photo(i), left: 0, top: 0, width: W, height: H }, opacity: i ? 0.8 : 1, visible: true, blend: b }));
    let t = performance.now();
    const bytes = buildPsd({ width: W, height: H, mode: 4, layers });
    const tBuild = performance.now() - t;
    const hash = putBlob(bytes);
    const asset = { id: "a1", hash };
    t = performance.now();
    const page = importPsdPage(bytes, "omni-perf.psd", "omni-perf", asset).page;
    const tImport = performance.now() - t;
    const doc = { assets: { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: "omni-perf.psd", size: bytes.length } } };
    const heap0 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    t = performance.now();
    const store = cmykStoreOf(doc, page)!;
    const tStore = performance.now() - t;
    const heap1 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    const storeMB = [...store.values()].reduce((s, v) => s + v.byteLength, 0) / 2 ** 20;
    // one level-0 tile (100 % zoom)
    const t0s: number[] = [];
    for (let i = 0; i < 6; i++) {
      t = performance.now();
      cmykLevelPixels(page, store, (i % 3) * TILE * 3, Math.floor(i / 3) * TILE * 3, 0);
      t0s.push(performance.now() - t);
    }
    // fit to a 1600 px wide window: the level, and the slowest single tile job (one task on the main thread)
    const fit = Math.min(1600 / W, 1000 / H), L = cmykLevel(fit), S = TILE << L;
    let worst = 0, total = 0, n = 0;
    t = performance.now();
    for (let Y = 0; Y < H; Y += S)
      for (let X = 0; X < W; X += S) {
        const t1 = performance.now();
        cmykLevelPixels(page, store, X, Y, L);
        const d = performance.now() - t1;
        worst = Math.max(worst, d);
        total += d;
        n++;
      }
    // a page thumbnail (≈ 160 px): what paintPage computes synchronously
    const LT = cmykLevel(160 / W), ST = TILE << LT;
    t = performance.now();
    for (let Y = 0; Y < H; Y += ST) for (let X = 0; X < W; X += ST) cmykLevelPixels(page, store, X, Y, LT);
    const tThumb = performance.now() - t;
    // at open: the channels from the page just imported (what seedCmykStore does instead of the first-draw import)
    t = performance.now();
    cmykTilesOf(bytes, page);
    const tSeed = performance.now() - t;
    // the screen / thumbnail pyramid: a thumbnail, then one tile edited and the thumbnail again
    vi.stubGlobal("OffscreenCanvas", class { constructor(public width: number, public height: number) {} getContext() { return { putImageData() {} }; } });
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray) {} });
    const ctx = { save() {}, restore() {}, drawImage() {}, imageSmoothingEnabled: true } as never;
    const env = { doc: doc as never, clip: { x: 0, y: 0, w: W, h: H }, scale: 1, incomplete: false, onResourceReady: () => {} };
    resetCmykView();
    t = performance.now();
    paintCmykRegion(ctx, doc as never, page, { x: 0, y: 0, w: W, h: H }, 160 / W, env, true);
    const tPyr = performance.now() - t;
    const top = page.nodes.find((x) => x.name === "omni-L4") as RasterNode;
    const d = new Uint8ClampedArray(top.tiles["3_3"].data);
    d.fill(9, 0, 4096);
    const edited: Page = { ...page, nodes: page.nodes.map((x) => (x === top ? { ...top, tiles: { ...top.tiles, "3_3": makeTile(d) } } : x)) };
    t = performance.now();
    paintCmykRegion(ctx, doc as never, edited, { x: 0, y: 0, w: W, h: H }, 160 / W, env, true);
    const tPyrEdit = performance.now() - t;
    t = performance.now();
    const flat = cmykFlatPage(doc, page);
    const tFlat = performance.now() - t;
    // since psd-cmyk-open: opening only starts the channel read (a worker in the app; here the same work a layer
    // record a task), the first draw shows the RGB layers meanwhile
    releaseCmykFiles(() => false);
    resetCmykView();
    t = performance.now();
    seedCmykStore(hash, bytes, page);
    const tSeedMain = performance.now() - t;
    const env2 = { ...env, incomplete: false };
    t = performance.now();
    const drawn = paintCmykRegion(ctx, doc as never, page, { x: 0, y: 0, w: W, h: H }, 160 / W, env2);
    const tFirstDraw = performance.now() - t;
    t = performance.now();
    await cmykStoreLater(doc, page);
    const tReady = performance.now() - t;
    let worstStep = 0;
    const steps = cmykTileSteps(bytes, page);
    for (let done = false; !done; ) {
      const t1 = performance.now();
      done = !!steps.next().done;
      worstStep = Math.max(worstStep, performance.now() - t1);
    }
    // an .omw that stored every tile: the worker imports the file for the keys (here: on this thread)
    releaseCmykFiles(() => false);
    t = performance.now();
    await prepareCmykStore(hash, bytes);
    const tOmw = performance.now() - t;
    // the wand / eyedropper on all layers: one tile of the composite
    resetCmykView();
    t = performance.now();
    cmykSampleTile(doc as never, page, 5, 5, () => {});
    const tSample = performance.now() - t;
    const lines = [
      `[cmyk-perf] ${W}×${H} 5 layers, PSD ${(bytes.length / 2 ** 20).toFixed(1)} MB (built ${tBuild.toFixed(0)} ms)`,
      `  open (import) ${tImport.toFixed(0)} ms; first draw re-import + channels ${tStore.toFixed(0)} ms, store ${storeMB.toFixed(0)} MB (heap +${((heap1 - heap0) / 2 ** 20).toFixed(0)} MB)`,
      `  100 % tile (256 px) ${Math.min(...t0s).toFixed(1)}–${Math.max(...t0s).toFixed(1)} ms`,
      `  fit (${(fit * 100).toFixed(1)} %, level ${L}): ${n} tiles, ${total.toFixed(0)} ms in all, slowest one ${worst.toFixed(0)} ms`,
      `  thumbnail (level ${LT}) ${tThumb.toFixed(0)} ms; vector PDF flat page ${tFlat.toFixed(0)} ms`,
      `  channels at open (seed) ${tSeed.toFixed(0)} ms; pyramid thumbnail ${tPyr.toFixed(0)} ms, after a one-tile edit ${tPyrEdit.toFixed(0)} ms`,
      `  open now: main thread seed ${tSeedMain.toFixed(0)} ms, first draw ${tFirstDraw.toFixed(0)} ms (drawn ${drawn}, RGB meanwhile); channels ready in the background ${tReady.toFixed(0)} ms, longest step ${worstStep.toFixed(0)} ms`,
      `  .omw with every tile stored: background import + channels ${tOmw.toFixed(0)} ms; sampling one composite tile ${tSample.toFixed(0)} ms`,
    ];
    console.log(lines.join("\n"));
    expect(flat).not.toBeNull();
  }, 600_000);
});
