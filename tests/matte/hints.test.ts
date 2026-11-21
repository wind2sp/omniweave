// Background removal: "keep inner white areas" (counter vs surface) and subject hints (component choice, region grow
// when the saliency map missed the subject, background points on non-AI results, saved options for re-editing).
// Synthetic pictures carry a faint "omni" corner mark (a tiny off-white square, below every key tolerance).
import { describe, expect, it } from "vitest";
import { newImg, type Img } from "../../src/core/image/pixels";
import { flatBackground, innerRegion, isCounter } from "../../src/core/image/matte/select";
import { components, dropComponents, hintPixels, hintSaliency } from "../../src/core/image/matte/hints";
import { removeBackground } from "../../src/core/image/matte/pipeline";
import { SAL } from "../../src/core/image/infer";
import { dialogUndoKey, matteEditTarget, matteOptionsOf, removeBackgroundSelection } from "../../src/ui/matteActions";
import { imgToTiles } from "../../src/core/image/pixels";
import { draftPage, findPage, useStore } from "../../src/core/store";
import { newRaster, type RasterNode } from "../../src/core/types";
import { rng } from "./synth";

type RGB = [number, number, number];

function paint(W: number, H: number, bg: RGB, f: (x: number, y: number) => RGB | null): Img {
  const img = newImg(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = f(x, y) ?? bg;
      img.data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
  // the faint omniweave mark: 3×3, 2 levels off the background in the bottom-right corner
  for (let y = H - 5; y < H - 2; y++) for (let x = W - 5; x < W - 2; x++) img.data.set([bg[0] - 2, bg[1] - 2, bg[2] - 2], (y * W + x) * 4);
  return img;
}

const WHITE: RGB = [255, 255, 255], BLACK: RGB = [20, 20, 20], BLUE: RGB = [20, 110, 220], RED: RGB = [200, 40, 40];
const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1;

/** "omni-doc-icon": black page outline, white page, a blue label band with a white letter. */
function docIcon(): Img {
  return paint(240, 280, WHITE, (x, y) => {
    if (inRect(x, y, 30, 130, 210, 210)) return inRect(x, y, 70, 150, 84, 190) || inRect(x, y, 70, 176, 130, 190) ? WHITE : BLUE; // band + white letter L
    if (inRect(x, y, 50, 30, 190, 260) && !inRect(x, y, 60, 40, 180, 250)) return BLACK; // page outline
    return null;
  });
}

/** "omni-ring-logo": a red ring (its hole is a counter) and a red bar. */
function ringLogo(): Img {
  return paint(260, 180, WHITE, (x, y) => {
    const d = Math.hypot(x - 80, y - 90);
    if (d < 55 && d > 30) return RED;
    if (inRect(x, y, 160, 60, 230, 120)) return RED;
    return null;
  });
}

describe("inner background-coloured regions (graphics)", () => {
  it("auto keeps a document icon's white page and white letters", () => {
    const img = docIcon();
    const W = img.width;
    const auto = flatBackground(img, { holes: "auto" }).alpha;
    const all = flatBackground(img, { holes: true }).alpha;
    expect(auto[100 * W + 120]).toBe(255); // page above the band
    expect(auto[230 * W + 120]).toBe(255); // page below the band
    expect(auto[170 * W + 77]).toBe(255); // white letter inside the band
    expect(all[100 * W + 120]).toBe(0); // the old behaviour removed all of them
    expect(auto[10 * W + 10]).toBe(0); // outside background still goes
  });

  it("auto still removes the hole of a ring (counter)", () => {
    const img = ringLogo();
    const W = img.width;
    const auto = flatBackground(img, { holes: "auto" }).alpha;
    expect(auto[90 * W + 80]).toBe(0);
    expect(auto[90 * W + 195]).toBe(255);
    expect(flatBackground(img, { holes: false }).alpha[90 * W + 80]).toBe(255);
  });

  it("counter features: one surrounding colour, fat; surfaces: two colours or a stroke inside a wide fill", () => {
    expect(isCounter({ colors: 1, fat: 0.99, width: 50, line: 25 })).toBe(true);
    expect(isCounter({ colors: 2, fat: 1, width: 120, line: 30 })).toBe(false);
    expect(isCounter({ colors: 1, fat: 0.22, width: 40, line: 64 })).toBe(false);
    expect(isCounter({ colors: 2, fat: 0.5, width: 6, line: 4 })).toBe(true); // a sliver between drawn lines
    // measured on the ring
    const img = ringLogo(), W = img.width, H = img.height;
    const isBg = new Uint8Array(W * H);
    const px: number[] = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 80, y - 90) <= 30) px.push(y * W + x);
    const r = innerRegion(img, px, isBg, WHITE);
    expect(r.colors).toBe(1);
    expect(r.fat).toBeGreaterThan(0.9);
  });

  it("hints decide single regions; the pipeline's option and a background point on a solid part", async () => {
    const img = ringLogo(), W = img.width, H = img.height;
    // a subject point in the ring's hole keeps it
    const keep = await removeBackground(img, { type: "graphic", hints: [{ x: 80 / W, y: 90 / H, fg: true }] });
    expect(keep.alpha[90 * W + 80]).toBe(255);
    // inner: false keeps every enclosed region
    expect((await removeBackground(img, { type: "graphic", inner: false })).alpha[90 * W + 80]).toBe(255);
    // a background point on the bar removes the bar, the ring stays
    const drop = await removeBackground(img, { type: "graphic", hints: [{ x: 195 / W, y: 90 / H, fg: false }] });
    expect(drop.alpha[90 * W + 195]).toBe(0);
    expect(drop.alpha[90 * W + 40]).toBe(255);
  });
});

describe("subject hints on the saliency map", () => {
  /** "omni-tree": textured green blob (the subject) on a reddish texture; the map wrongly marks a bg patch. */
  function scene() {
    const W = 400, H = 400, R = rng(7);
    const img = paint(W, H, [180, 60, 50], (x, y) => {
      const n = (R() - 0.5) * 40;
      if (Math.hypot(x - 230, y - 220) < 90) return [60 + n, 150 + n, 60 + n];
      return [180 + n, 60 + n, 50 + n];
    });
    const map = new Float32Array(SAL * SAL);
    for (let y = 0; y < SAL; y++) for (let x = 0; x < SAL; x++) if (x > 20 && x < 90 && y > 20 && y < 90) map[y * SAL + x] = 0.95;
    return { img, map, W, H };
  }

  it("components: a background point drops the component under it, a subject point keeps its own", () => {
    const map = new Float32Array(SAL * SAL);
    for (let y = 0; y < SAL; y++)
      for (let x = 0; x < SAL; x++) if ((x > 20 && x < 80 && y > 20 && y < 80) || (x > 200 && x < 280 && y > 200 && y < 280)) map[y * SAL + x] = 1;
    const img = paint(64, 64, [128, 128, 128], () => null);
    const r = hintSaliency(img, map, SAL, [{ x: 50 / SAL, y: 50 / SAL, fg: false }, { x: 240 / SAL, y: 240 / SAL, fg: true }]);
    expect(r.grown).toBe(false);
    expect(r.map[50 * SAL + 50]).toBe(0);
    expect(r.map[240 * SAL + 240]).toBe(1);
    const { n } = components(Uint8Array.from(r.map, (v) => (v >= 0.5 ? 1 : 0)), SAL, SAL);
    expect(n).toBe(1);
  });

  it("region grow finds a subject the map missed from one point", () => {
    const { img, map, W, H } = scene();
    const r = hintSaliency(img, map, SAL, [{ x: 230 / W, y: 220 / H, fg: true }]);
    expect(r.grown).toBe(true);
    let inter = 0, uni = 0;
    for (let y = 0; y < SAL; y++)
      for (let x = 0; x < SAL; x++) {
        const gt = Math.hypot(((x + 0.5) * W) / SAL - 230, ((y + 0.5) * H) / SAL - 220) < 90;
        const a = r.map[y * SAL + x] >= 0.5;
        if (a && gt) inter++;
        if (a || gt) uni++;
      }
    expect(inter / uni).toBeGreaterThan(0.85);
    // the wrongly salient patch is gone
    expect(r.map[50 * SAL + 50]).toBeLessThan(0.5);
  });

  it("the pipeline uses the edited map for AI types and keeps the original map in the result", async () => {
    const { img, map, W, H } = scene();
    const res = await removeBackground(img, { type: "object", sal: { map: Float32Array.from(map), hi: 1 }, hints: [{ x: 230 / W, y: 220 / H, fg: true }] });
    expect(res.grown).toBe(true);
    expect(res.alpha[220 * W + 230]).toBeGreaterThan(200);
    expect(res.alpha[60 * W + 60]).toBeLessThan(50);
    expect(res.sal!.map[50 * SAL + 50]).toBeCloseTo(0.95, 5);
  });
});

describe("hint helpers and saved options", () => {
  it("hint pixels are discs on the grid; background points remove opaque components", () => {
    expect(hintPixels([{ x: 0.5, y: 0.5, fg: true }], 10, 10, true)).toEqual([55]);
    expect(hintPixels([{ x: 0.5, y: 0.5, fg: true }], 10, 10, false)).toEqual([]);
    expect(hintPixels([{ x: 0.5, y: 0.5, fg: true }], 10, 10, true, 1).length).toBe(9);
    const a = new Uint8ClampedArray(10 * 10);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) a[y * 10 + x] = 255;
    for (let y = 6; y < 9; y++) for (let x = 6; x < 9; x++) a[y * 10 + x] = 255;
    dropComponents(a, 10, 10, [{ x: 0.25, y: 0.25, fg: false }]);
    expect(a[2 * 10 + 2]).toBe(0);
    expect(a[7 * 10 + 7]).toBe(255);
  });

  it("the matte record round-trips the dialog options (re-editing keeps them)", () => {
    const o = matteOptionsOf({ assetId: "a", sourceId: "s", type: "graphic", edge: { radius: 6, smooth: 10, feather: 0, contrast: 0, shift: 0, decontaminate: 100, keepInner: true }, hints: [{ x: 0.2, y: 0.3, fg: true }] });
    expect(o.type).toBe("graphic");
    expect(o.inner).toBe(false);
    expect(o.edge.smooth).toBe(10);
    expect(o.hints).toEqual([{ x: 0.2, y: 0.3, fg: true }]);
    expect(matteOptionsOf({ assetId: "a", sourceId: "s", type: "object", edge: { keepShadow: true } }).inner).toBe("auto");
  });

  it("re-editing a cut-out remakes the same node from its original with the saved points", async () => {
    const S = useStore.getState;
    const img = ringLogo(), W = img.width, H = img.height;
    const n = newRaster("omni-ring-logo");
    n.tiles = imgToTiles(img, 0, 0, {}).tiles;
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    await removeBackgroundSelection({ type: "graphic", inner: false, hints: [{ x: 195 / W, y: 90 / H, fg: false }] });
    const count = findPage(S().doc, S().pageId)!.nodes.length;
    const cut = findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === S().selection[0]) as RasterNode;
    expect(cut.matte?.hints).toEqual([{ x: 195 / W, y: 90 / H, fg: false }]);
    expect(cut.matte?.edge.keepInner).toBe(true);
    const edit = matteEditTarget()!;
    expect(edit.node.id).toBe(n.id);
    const saved = matteOptionsOf(edit.matte);
    expect(saved.inner).toBe(false);
    await removeBackgroundSelection({ type: saved.type, edge: saved.edge, inner: true, hints: [] }, edit);
    const nodes = findPage(S().doc, S().pageId)!.nodes;
    expect(nodes.length).toBe(count);
    const again = nodes.find((x) => x.id === cut.id) as RasterNode;
    expect(again.tiles).not.toBe(cut.tiles);
    expect(again.matte?.hints).toBeUndefined();
    expect(again.matte?.edge.keepInner).toBe(false);
    S().undo();
    expect((findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === cut.id) as RasterNode).matte?.hints?.length).toBe(1);
  }, 60_000);

  it("re-editing keeps the cut-out's own crop (cropped after it was made)", async () => {
    const S = useStore.getState;
    const img = ringLogo();
    const n = newRaster("omni-ring-crop");
    n.tiles = imgToTiles(img, 0, 0, {}).tiles;
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    await removeBackgroundSelection({ type: "graphic" });
    const id = S().selection[0];
    S().commit("crop", (d) => {
      const c = draftPage(d, S().pageId)!.nodes.find((x) => x.id === id) as RasterNode;
      c.crop = { x: 10, y: 10, w: 100, h: 80 };
    });
    const edit = matteEditTarget()!;
    await removeBackgroundSelection({ type: "graphic", inner: true }, edit);
    const again = findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === id) as RasterNode;
    expect(again.matte?.edge.keepInner).toBe(false);
    expect(again.crop).toEqual({ x: 10, y: 10, w: 100, h: 80 });
  }, 60_000);
});

describe("matte dialog undo keys", () => {
  const ev = (o: Partial<KeyboardEvent> & { target?: unknown }) => ({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: "z", code: "KeyZ", target: null, ...o }) as any;
  const el = (tag: string, type = "") => ({ tagName: tag, type, closest: (s: string) => (tag === "TEXTAREA" && s.includes("textarea") ? {} : null) });
  it("Ctrl+Z takes back a point; redo / undo with no point never reaches the document behind the dialog", () => {
    expect(dialogUndoKey(ev({}))).toBe("point");
    expect(dialogUndoKey(ev({ shiftKey: true }))).toBe("block");
    expect(dialogUndoKey(ev({ key: "y", code: "KeyY" }))).toBe("block");
    expect(dialogUndoKey(ev({ ctrlKey: false }))).toBe(null);
    expect(dialogUndoKey(ev({ key: "s", code: "KeyS" }))).toBe(null);
  });
  it("Korean IME (key 'ㅋ' / 'Process') is still Ctrl+Z by position", () => {
    expect(dialogUndoKey(ev({ key: "ㅋ" }))).toBe("point");
    expect(dialogUndoKey(ev({ key: "Process" }))).toBe("point");
  });
  it("text fields keep their own undo; sliders and checkboxes do not", () => {
    expect(dialogUndoKey(ev({ target: el("INPUT", "text") }))).toBe(null);
    expect(dialogUndoKey(ev({ target: el("INPUT", "number") }))).toBe(null);
    expect(dialogUndoKey(ev({ target: el("TEXTAREA") }))).toBe(null);
    expect(dialogUndoKey(ev({ target: el("INPUT", "range") }))).toBe("point");
    expect(dialogUndoKey(ev({ target: el("INPUT", "checkbox") }))).toBe("point");
  });
});