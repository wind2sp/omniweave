// QA psd-cmyk-open: the wand and the eyedropper on a CMYK page that blends wait for the composite tiles (the channels
// come from a worker). What the user does meanwhile — another selection, a later click, a colour chosen by hand — must
// win: a result that arrives late must not overwrite it.
import { describe, expect, it, vi } from "vitest";
import { useStore } from "../../src/core/store";
import { newDocument, newPage, newRaster } from "../../src/core/types";
import * as P from "../../src/ui/pixelSelect";

const W = 600, H = 300;
// the composite tiles: undefined (channels being read) until `release()`, then a flat colour
let pending = true;
const wakers: (() => void)[] = [];
const release = () => {
  pending = false;
  wakers.splice(0).forEach((r) => r());
};
vi.mock("../../src/render/cmykView", () => ({
  cmykSampled: () => true,
  cmykSampleTile: (_d: unknown, _p: unknown, _tx: number, _ty: number, ready: () => void) => {
    if (pending) {
      wakers.push(ready);
      return undefined;
    }
    const px = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < px.length; i += 4) px.set([10, 200, 30, 255], i);
    return px;
  },
}));
vi.mock("../../src/core/fidelity/overlay", () => ({ pristinePsdView: () => false }));
const flat = () => {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < d.length; i += 4) d.set([10, 200, 30, 255], i);
  return d;
};
const fakeCtx = { fillStyle: "", fillRect() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: w === 1 && h === 1 ? new Uint8ClampedArray([255, 255, 255, 255]) : flat() }) };
vi.mock("../../src/render/weave", () => ({ renderPageCanvas: () => ({ width: W, height: H }) }));
vi.mock("../../src/render/draw", async (orig) => ({ ...(await orig<object>()), makeCanvas: (w: number, h: number) => ({ width: w, height: h }), ctx2d: () => fakeCtx }));

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function setup() {
  const doc = newDocument("omni-qa-race");
  const page = newPage("DESIGN", W, H, "P");
  page.nodes = [newRaster("omni-layer") as never];
  doc.pages = [page];
  useStore.getState().load(doc);
  useStore.getState().set({ pageId: page.id, selection: [] });
  P.usePixelSel.setState({ mask: null, pageId: null, sampleAll: true, wandContiguous: true, wandTolerance: 8 });
  pending = true;
  return { P, useStore };
}

describe("background channel reading vs closing the tab", () => {
  it("a read that finishes after its file was released keeps nothing; opened again, a fresh read is made", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { putBlob } = await import("../../src/core/assets");
    const { importPsdPage } = await import("../../src/io/formats/psd");
    const C = await import("../../src/core/image/cmykComposite");
    const bytes = new Uint8Array(readFileSync(join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity", "omni-fid-cmyk-blend.psd")));
    const hash = putBlob(bytes);
    const page = importPsdPage(bytes, "omni-qa-close.psd", "x", { id: "a1", hash }).page;
    const doc = { assets: { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: "omni-qa-close.psd", size: bytes.length } } } as never;
    C.releaseCmykFiles(() => false);
    const first = C.prepareCmykStore(hash, bytes, page);
    C.releaseCmykFiles(() => false); // the tab closed while reading
    await first;
    expect(C.cmykStoreOf(doc, page, false)).toBeUndefined(); // not kept for a file no one has open
    const again = await C.prepareCmykStore(hash, bytes, page);
    expect(again && again.size).toBeGreaterThan(0);
    expect(C.cmykStoreOf(doc, page, false)).toBe(again);
    C.releaseCmykFiles(() => false);
  });
});

describe("CMYK sampling: a late result does not overwrite what the user did meanwhile", () => {
  it("wand clicked, then a marquee before the composite came: the marquee stays", async () => {
    const { P } = await setup();
    P.wandSelect([20, 20], "replace");
    await settle();
    expect(P.usePixelSel.getState().mask).toBeNull(); // still waiting for the channels
    P.marqueeSelect([300, 100], [320, 120], "replace");
    const marquee = P.usePixelSel.getState().mask;
    expect(marquee).not.toBeNull();
    release();
    await settle();
    expect(P.usePixelSel.getState().mask).toBe(marquee);
  });

  it("wand clicked, then deselected (Ctrl+D) before the composite came: nothing is selected", async () => {
    const { P } = await setup();
    P.marqueeSelect([300, 100], [320, 120], "replace");
    P.wandSelect([20, 20], "add");
    await settle();
    P.deselect();
    release();
    await settle();
    expect(P.usePixelSel.getState().mask).toBeNull();
  });

  it("two wand clicks while waiting: the later click is what stays", async () => {
    const { P } = await setup();
    P.wandSelect([20, 20], "replace");
    P.wandSelect([20, 20], "subtract"); // the later click: take it away again
    release();
    await settle();
    expect(P.usePixelSel.getState().mask).toBeNull();
  });

  it("eyedropper clicked, then a colour chosen by hand before the tile came: the chosen colour stays", async () => {
    const { P, useStore } = await setup();
    P.pickColorAt([20, 20]);
    await settle();
    useStore.getState().set({ brush: { ...useStore.getState().brush, color: "#123456" } });
    release();
    await settle();
    expect(useStore.getState().brush.color).toBe("#123456");
  });

  it("without anything in between, the wand and the eyedropper still apply once the tiles are there", async () => {
    const { P, useStore } = await setup();
    P.wandSelect([20, 20], "replace");
    P.pickColorAt([20, 20]);
    release();
    await settle();
    expect(P.usePixelSel.getState().mask).not.toBeNull();
    expect(useStore.getState().brush.color).toBe("#0ac81e");
  });
});
