// QA: the DISSOLVE thresholds load on demand (core/style/blend.ts). Whatever writes pixels for good — PSD save, merge
// down — must use Photoshop's thresholds even when it runs before they arrived. Each test starts from fresh modules,
// so the table is not loaded yet.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Blend = typeof import("../../src/core/style/blend");

function layers(T: typeof import("../../src/core/types"), R: typeof import("../../src/io/formats/raster")) {
  const W = 300, H = 200;
  const solid = (rgb: [number, number, number], name: string) => {
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < px.length; i += 4) px.set([...rgb, 255], i);
    const n = R.rasterFromRgba(px, W, H, name);
    n.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
    return n;
  };
  const lo = solid([20, 120, 220], "omni-lo");
  const up = { ...solid([230, 40, 10], "omni-dissolve"), blendMode: "DISSOLVE" as const, opacity: 0.5 };
  const doc = T.newDocument("omni-dissolve");
  const page = T.newPage("DESIGN", W, H, "P");
  page.nodes = [lo, up];
  doc.pages = [page];
  return { doc, page, lo, up };
}

beforeEach(() => vi.resetModules());

describe("DISSOLVE thresholds loaded on demand", () => {
  it("PSD save before the table is here writes what it writes after", async () => {
    const blend: Blend = await import("../../src/core/style/blend");
    expect(blend.dissolveReady()).toBe(false);
    const { writePsd } = await import("../../src/io/formats/psdWrite");
    const { doc, page } = layers(await import("../../src/core/types"), await import("../../src/io/formats/raster"));
    const first = (await writePsd(doc, page)).bytes;
    expect(blend.dissolveReady()).toBe(true);
    const again = (await writePsd(doc, page)).bytes;
    expect(Buffer.compare(Buffer.from(first), Buffer.from(again))).toBe(0);
  });

  it("merge down of a dissolving layer before the table is here bakes Photoshop's dots", async () => {
    const blend: Blend = await import("../../src/core/style/blend");
    const { useStore } = await import("../../src/core/store");
    const { mergeDown } = await import("../../src/ui/menuActions");
    const { mergeRasterTiles } = await import("../../src/core/image/merge");
    const { doc, page, lo, up } = layers(await import("../../src/core/types"), await import("../../src/io/formats/raster"));
    useStore.getState().load(doc);
    useStore.getState().set({ selection: [up.id] });
    expect(blend.dissolveReady()).toBe(false);
    mergeDown();
    await blend.loadDissolveField();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const got = useStore.getState().doc.pages.find((p) => p.id === page.id)!.nodes;
    expect(got).toHaveLength(1);
    const want = mergeRasterTiles(lo, up);
    const tiles = (got[0] as typeof lo).tiles;
    for (const k of Object.keys(want)) expect(Buffer.compare(Buffer.from(tiles[k].data), Buffer.from(want[k].data)), k).toBe(0);
  });
});
