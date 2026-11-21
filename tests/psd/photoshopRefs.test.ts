// Photoshop-made reference files (qa/interop/adobe-made/psd_*: .psd with the merged image + Photoshop's PNG export):
// our import + layer-tree compositing must reproduce Photoshop's render, and the PSD Surgeon must round-trip them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { compositeTree } from "../../src/core/image/softComposite";
import { newDocument, type Page, type RasterNode, type SceneNode } from "../../src/core/types";
import { importPsdPage } from "../../src/io/formats/psd";
import { checkPsd, decodePngRgba, rasterPixels, writePsd } from "../../src/io/formats/psdWrite";
import { diff } from "../../qa/interop/scripts/psd-metrics";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

function open(name: string, bytes = read(name + ".psd")) {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd");
  const r = importPsdPage(bytes, name + ".psd", name, asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page, bytes, merged: r.image.composite!, warnings: r.warnings };
}

function compose(page: Page): Uint8Array {
  const px = new Map(page.nodes.filter((n) => n.type === "RASTER").map((n) => [n.id, rasterPixels(n as RasterNode)]));
  return compositeTree(page.nodes, page.groups, (n: SceneNode) => px.get(n.id) ?? null, page.width, page.height);
}

const byName = (page: Page, prefix: string) => page.nodes.find((n) => n.name.startsWith(prefix))!;

describe("Photoshop reference renders", () => {
  for (const name of ["psd_clip_basic", "psd_group_opacity", "psd_nested", "psd_clip_in_group"]) {
    it(`${name}: our composite matches Photoshop's PNG and merged image`, () => {
      const { page, merged } = open(name);
      const png = decodePngRgba(read(name + ".png"));
      const ours = compose(page);
      for (const ref of [png.rgba, merged]) {
        const d = diff(ours, ref, page.width, page.height);
        expect(d.max).toBeLessThanOrEqual(2);
        expect(d.over2).toBe(0);
        expect(d.ssim).toBeGreaterThan(0.9995);
      }
    });
  }

  it("psd_clip_in_group: the clip stack stays inside its group (no green through the circle)", () => {
    const { page } = open("psd_clip_in_group");
    const base = byName(page, "Base Circle");
    expect(base.groupId).toBeTruthy();
    expect(page.nodes.filter((n) => n.clip).map((n) => n.groupId)).toEqual([base.groupId, base.groupId]);
  });

  it("psd_clip_text: a text base clips with its rasterised pixels from the file", () => {
    const { page, merged } = open("psd_clip_text");
    const text = byName(page, "OMNI") as RasterNode;
    expect(byName(page, "Gradient").clip).toBe(true);
    const ours = compose(page);
    const W = page.width, H = page.height;
    const d = diff(ours, merged, W, H);
    // only the anti-aliased rim differs: Photoshop blends text edges with "Blend Text Colors Using Gamma" (a colour
    // setting, not stored in the file) — we blend linearly in sRGB
    expect(d.over2).toBeLessThan(2);
    expect(d.ssim).toBeGreaterThan(0.999);
    // where the text pixel is fully in or out, the result is exact
    const tp = rasterPixels(text)!;
    let worst = 0, solid = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const inside = x >= tp.left && y >= tp.top && x < tp.left + tp.width && y < tp.top + tp.height;
        const a = inside ? tp.rgba[((y - tp.top) * tp.width + (x - tp.left)) * 4 + 3] : 0;
        if (a !== 0 && a !== 255) continue;
        if (a === 255) solid++;
        const o = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(ours[o + c] - merged[o + c]));
      }
    expect(solid).toBeGreaterThan(5000);
    expect(worst).toBeLessThanOrEqual(2);
  });
});

describe("Photoshop reference files: PSD Surgeon round trip", () => {
  const NAMES = ["psd_clip_basic", "psd_group_opacity", "psd_nested", "psd_clip_in_group", "psd_clip_text"];
  for (const name of NAMES)
    it(`${name}: unchanged save is byte-identical`, async () => {
      const { doc, page, bytes } = open(name);
      const res = await writePsd(doc, page);
      expect(res.method).toBe("original");
      expect(res.bytes.length).toBe(bytes.length);
      expect(res.bytes.every((v, i) => v === bytes[i])).toBe(true);
      expect(checkPsd(res.bytes, null)).toEqual([]);
    });

  /** Edit, save, re-open: the saved merged image is our composite of the edited tree, and survives re-import. */
  async function roundTrip(name: string, edit: (page: Page) => void) {
    const { doc, page } = open(name);
    edit(page);
    const want = compose(page);
    const res = await writePsd(doc, page);
    expect(res.method).toBe("surgery");
    expect(checkPsd(res.bytes, null)).toEqual([]);
    const again = open(name, res.bytes);
    const d = diff(again.merged, want, page.width, page.height);
    expect(d.max).toBeLessThanOrEqual(1);
    // the edited tree comes back as it was saved
    expect(diff(compose(again.page), want, page.width, page.height).max).toBeLessThanOrEqual(1);
    return again;
  }

  it("group opacity change", async () => {
    const again = await roundTrip("psd_group_opacity", (page) => {
      const g = page.groups!.find((g) => g.blendMode === "NORMAL")!;
      g.opacity = 0.2;
    });
    expect(again.page.groups!.find((g) => g.blendMode === "NORMAL")!.opacity).toBeCloseTo(0.2, 2);
  });

  it("group visibility change (the hidden middle group of psd_nested shown)", async () => {
    const before = compose(open("psd_nested").page);
    const again = await roundTrip("psd_nested", (page) => {
      page.groups!.find((g) => g.name.startsWith("Middle"))!.visible = true;
    });
    expect(again.page.groups!.find((g) => g.name.startsWith("Middle"))!.visible).toBe(true);
    // showing it changes the picture
    expect(diff(again.merged, before, again.page.width, again.page.height).max).toBeGreaterThan(10);
  });

  it("clip flag removed (psd_clip_basic overlay layer drawn unclipped)", async () => {
    const again = await roundTrip("psd_clip_basic", (page) => {
      const n = byName(page, "Gradient Overlay");
      n.clip = false;
    });
    expect(byName(again.page, "Gradient Overlay").clip).toBeFalsy();
  });

  it("clip flag added inside a group (psd_group_opacity: blue clipped to red)", async () => {
    const again = await roundTrip("psd_group_opacity", (page) => {
      for (const n of page.nodes) if (n.name.startsWith("Square Blue")) n.clip = true;
    });
    expect(again.page.nodes.filter((n) => n.name.startsWith("Square Blue")).every((n) => n.clip)).toBe(true);
  });
});
