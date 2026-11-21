// Background removal: methods, classifier, refinement primitives, the AI path on one photo, and the
// non-destructive document edit (new layer above, original hidden, one undo step, matte kept as an asset).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { setModelBytes, saliency } from "../../src/core/image/infer";
import { boxMean, guidedFilter } from "../../src/core/image/matte/refine";
import { chromaKey, chromaScreen, flatBackground, paperRemoval, studioKey } from "../../src/core/image/matte/select";
import { decideFast, decideWithSaliency, imageFeatures, type SaliencyStats } from "../../src/core/image/matte/classify";
import { plainSaliencyAlpha, removeBackground } from "../../src/core/image/matte/pipeline";
import { encodePng } from "../../src/core/image/png";
import { imgToTiles } from "../../src/core/image/pixels";
import { draftPage, findPage, useStore } from "../../src/core/store";
import { newRaster, type RasterNode } from "../../src/core/types";
import { getBlob } from "../../src/core/assets";
import { matteAssetOf, removeBackgroundSelection } from "../../src/ui/matteActions";
import { chromaCase, complexCase, documentCase, graphicCase, portraitCase, productCase, rng, scoreAlpha, transparentCase } from "./synth";

beforeAll(() => setModelBytes(new Uint8Array(readFileSync("src/assets/models/u2netp.lwt"))));

describe("refinement primitives", () => {
  it("box mean equals the brute-force window mean (borders shrink the window)", () => {
    const w = 13, h = 9, R = rng(2);
    const a = new Float32Array(w * h).map(R);
    const m = boxMean(a, w, h, 3);
    for (const [x, y] of [[0, 0], [6, 4], [12, 8], [2, 7]]) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - 3); yy <= Math.min(h - 1, y + 3); yy++) for (let xx = Math.max(0, x - 3); xx <= Math.min(w - 1, x + 3); xx++) (s += a[yy * w + xx]), n++;
      expect(m[y * w + x]).toBeCloseTo(s / n, 5);
    }
  });
  it("guided filter snaps a blurry matte to a sharp colour edge", () => {
    const w = 40, h = 10;
    const I = [0, 1, 2].map(() => new Float32Array(w * h)) as [Float32Array, Float32Array, Float32Array];
    const p = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        I[0][y * w + x] = x < 20 ? 0.9 : 0.1; // red | dark edge at x = 20
        p[y * w + x] = Math.min(1, Math.max(0, (x - 14) / 12)); // soft ramp 14..26
      }
    const q = guidedFilter(I, p, w, h, 4, 1e-4);
    // the result follows the guide: nearly flat on each side, the jump sits at the colour edge
    expect(Math.abs(q[5 * w + 17] - q[5 * w + 19])).toBeLessThan(0.08);
    expect(Math.abs(q[5 * w + 20] - q[5 * w + 19])).toBeGreaterThan(0.25);
  });
});

describe("non-AI methods", () => {
  it("graphic: exact background removal, holes too, anti-aliased rim kept", () => {
    const c = graphicCase(11);
    const r = flatBackground(c.img);
    const s = scoreAlpha(r.alpha, c.gt!);
    expect(s.iou).toBeGreaterThan(0.995);
    expect(s.mad).toBeLessThan(0.002);
    // centre of the ring ("O") is background
    const W = c.img.width, H = c.img.height;
    expect(r.alpha[Math.round(H * 0.5) * W + Math.round(W * 0.25)]).toBe(0);
    // some partial-alpha rim pixels exist (no hard aliasing)
    expect(Array.from(r.alpha).some((a) => a > 20 && a < 235)).toBe(true);
  });
  it("document: paper removed under uneven light, ink kept with its own colour", () => {
    const c = documentCase(11);
    const r = paperRemoval(c.img);
    const s = scoreAlpha(r.alpha, c.gt!);
    expect(s.iou).toBeGreaterThan(0.9);
    // the red stamp ring stays red after un-mixing from the paper
    const W = c.img.width, H = c.img.height;
    const p = Math.round(H * 0.35) * W + Math.round(W * 0.78 + 43);
    expect(r.alpha[p]).toBeGreaterThan(200);
    expect(r.rgb![p * 3]).toBeGreaterThan(150);
    expect(r.rgb![p * 3 + 1]).toBeLessThan(80);
  });
  it("chroma key: screen removed and green spill suppressed on the edges", () => {
    const c = chromaCase(11);
    const screen = chromaScreen(c.img)!;
    expect(screen).toBeTruthy();
    const r = chromaKey(c.img, screen);
    const k = screen === "green" ? 1 : 2, o1 = 0, o2 = screen === "green" ? 2 : 1;
    expect(scoreAlpha(r.alpha, c.gt!).iou).toBeGreaterThan(0.97);
    let spill = 0, n = 0;
    for (let p = 0; p < c.gt!.length; p++)
      if (c.gt![p] > 0.2 && c.gt![p] < 0.9 && r.alpha[p] > 30) {
        n++;
        if (r.rgb![p * 3 + k] > (r.rgb![p * 3 + o1] + r.rgb![p * 3 + o2]) / 2 + 8) spill++;
      }
    expect(n).toBeGreaterThan(20);
    expect(spill / n).toBeLessThan(0.05);
  });
  it("studio key keeps the subject, drops the cast shadow — or keeps it as a dark translucent layer", () => {
    const c = productCase(11);
    const r = studioKey(c.img);
    expect(scoreAlpha(r.alpha, c.gt!).iou).toBeGreaterThan(0.97);
    const withShadow = studioKey(c.img, { keepShadow: true });
    let more = 0;
    for (let p = 0; p < c.gt!.length; p++) if (c.gt![p] === 0 && withShadow.alpha[p] > r.alpha[p] + 10) more++;
    expect(more).toBeGreaterThan(100);
  });
});

describe("classifier", () => {
  it("detects the non-AI types without running the network", () => {
    for (const seed of [11, 28, 45]) {
      expect(decideFast(imageFeatures(transparentCase(seed, 200, 150).img))?.type).toBe("transparent");
      expect(decideFast(imageFeatures(graphicCase(seed, 240, 160).img))?.type).toBe("graphic");
      expect(decideFast(imageFeatures(documentCase(seed, 280, 200).img))?.type).toBe("document");
      expect(decideFast(imageFeatures(chromaCase(seed, 200, 200).img))?.type).toBe("chroma");
      // photos go on to the saliency stage
      expect(decideFast(imageFeatures(portraitCase(seed, 180, 200).img))).toBeNull();
      expect(decideFast(imageFeatures(productCase(seed, 200, 200).img))).toBeNull();
      expect(decideFast(imageFeatures(complexCase(seed, 200, 150).img))).toBeNull();
    }
  });
  it("routes saliency statistics: unclear → complex (review), face → portrait, fur → animal", () => {
    const f = imageFeatures(portraitCase(11).img);
    const base: SaliencyStats = { certainty: 0.95, area: 0.3, parts: 1, peak: 1, skin: 0, skinTop: 0, headRatio: 0.5, softEdge: 1, texture: 5, bottom: 0, bgEdges: 0, green: 0 };
    expect(decideWithSaliency(f, { ...base, certainty: 0.4 }).type).toBe("complex");
    expect(decideWithSaliency(f, { ...base, peak: 0.1 }).type).toBe("complex");
    expect(decideWithSaliency(f, { ...base, skin: 0.4, skinTop: 0.7, bottom: 0.6 }).type).toBe("portrait");
    expect(decideWithSaliency(f, { ...base, texture: 25, softEdge: 1.5 }).type).toBe("animal");
    expect(decideWithSaliency(f, base).type).toBe("object");
  });
});

describe("AI path", () => {
  it("portrait: detected, refined edges beat the plain U²-Netp upsample", async () => {
    const c = portraitCase(11, 240, 270);
    const s = await saliency(c.img, { backend: "cpu" });
    const plain = scoreAlpha(plainSaliencyAlpha(Float32Array.from(s.map), c.img.width, c.img.height), c.gt!);
    const r = await removeBackground(c.img, { sal: { map: s.map, hi: s.hi, lo: s.lo } });
    expect(r.type).toBe("portrait");
    const ours = scoreAlpha(r.alpha, c.gt!);
    console.log(`portrait: ours IoU ${ours.iou.toFixed(3)} MAD ${ours.mad.toFixed(4)} | plain U2Netp IoU ${plain.iou.toFixed(3)} MAD ${plain.mad.toFixed(4)} | ${s.backend} ${s.ms.toFixed(0)} ms`);
    expect(ours.iou).toBeGreaterThan(0.97);
    expect(ours.mad).toBeLessThan(plain.mad);
  }, 120_000);
});

describe("non-destructive apply", () => {
  it("cut-out goes on a new layer above, original hidden, one undo step, matte asset kept", async () => {
    const S = useStore.getState;
    const c = graphicCase(28, 300, 200);
    const n = newRaster("logo");
    n.tiles = imgToTiles(c.img, 0, 0, {}).tiles;
    n.transform = { x: 40, y: 30, rotation: 15, scale: 1.5 };
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    const before = findPage(S().doc, S().pageId)!.nodes.length;
    const r = await removeBackgroundSelection();
    expect(r?.type).toBe("graphic");
    const nodes = findPage(S().doc, S().pageId)!.nodes;
    expect(nodes.length).toBe(before + 1);
    const at = nodes.findIndex((x) => x.id === n.id);
    const orig = nodes[at] as RasterNode, cut = nodes[at + 1] as RasterNode;
    expect(orig.visible).toBe(false);
    expect(orig.tiles).toBe(n.tiles); // original pixels untouched
    expect(cut.type).toBe("RASTER");
    expect(cut.transform).toEqual(n.transform);
    expect(cut.matte?.sourceId).toBe(n.id);
    expect(cut.matte?.type).toBe("graphic");
    expect(cut.matte?.assetId).toBeTruthy();
    const matte = matteAssetOf(S().doc, cut)!;
    expect(matte?.id).toBe(cut.matte!.assetId);
    expect(matte?.mime).toBe("image/png");
    expect(getBlob(matte.hash)!.length).toBeGreaterThan(50);
    S().undo();
    const after = findPage(S().doc, S().pageId)!.nodes;
    expect(after.length).toBe(before);
    expect(after.find((x) => x.id === n.id)!.visible).toBe(true);
  }, 60_000);

  it("the pure PNG writer produces a valid grey PNG", () => {
    const png = encodePng(new Uint8Array([0, 128, 255, 64]), 2, 2, 1);
    expect(Array.from(png.subarray(1, 4))).toEqual([80, 78, 71]);
    // IDAT inflates to 2 rows × (filter + 2 px)
    const idat = png.indexOf(0x49, 33); // 'I' of IDAT after IHDR
    const len = new DataView(png.buffer).getUint32(idat - 4);
    expect(unzlibSync(png.subarray(idat + 4, idat + 4 + len)).length).toBe(6);
  });
});
