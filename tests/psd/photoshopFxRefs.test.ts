// Photoshop-made layer-effect references (qa/interop/adobe-made/omni-fx-*.psd + .png, made on a QA PC by
// qa/interop/scripts/ps_make_effects.jsx — `run_adobe.ps1 -App psfx`). Skipped while the files are absent.
// For each: the effects are read from lfx2 as the script set them, our compositing (core/image/effects.ts through
// the layer tree) reproduces Photoshop's PNG and merged image within the effect tolerance, and the file round-trips
// byte for byte. The printed numbers calibrate SIZE_TO_SIGMA (core/style/effects.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { compositeTree } from "../../src/core/image/softComposite";
import { newDocument, type Page, type RasterNode, type SceneNode } from "../../src/core/types";
import { importPsdPage } from "../../src/io/formats/psd";
import { checkPsd, decodePngRgba, rasterPixels, writePsd } from "../../src/io/formats/psdWrite";
import { diff } from "../../qa/interop/scripts/psd-metrics";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const has = (n: string) => existsSync(join(DIR, n + ".psd")) && existsSync(join(DIR, n + ".png"));
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

function open(name: string) {
  const bytes = read(name + ".psd");
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd");
  const r = importPsdPage(bytes, name + ".psd", name, asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page, bytes, merged: r.image.composite! };
}
function compose(page: Page): Uint8Array {
  const px = new Map(page.nodes.filter((n) => n.type === "RASTER").map((n) => [n.id, rasterPixels(n as RasterNode)]));
  return compositeTree(page.nodes, page.groups, (n: SceneNode) => px.get(n.id) ?? null, page.width, page.height);
}
const fxOf = (page: Page, name: string) => (page.nodes.find((n) => n.name.startsWith(name))?.effects ?? page.groups?.find((g) => g.name.startsWith(name))?.effects ?? []) as any[];

/** What the script sets on each file (layer / group name → effect summary). */
const CASES: { name: string; layer: string; expect: Record<string, unknown>; ssim: number }[] = [
  { name: "omni-fx-shadow-text", layer: "OMNI", expect: { type: "dropShadow", blend: "MULTIPLY", opacity: 0.75, angle: 120, distance: { v: 8, u: "px" }, size: { v: 10, u: "px" } }, ssim: 0.985 },
  { name: "omni-fx-glow-shape", layer: "Ellipse", expect: { type: "outerGlow", blend: "SCREEN", opacity: 0.8, spread: 0.1, size: { v: 12, u: "px" } }, ssim: 0.98 },
  { name: "omni-fx-inner-image", layer: "Image", expect: { type: "innerShadow", blend: "MULTIPLY", opacity: 0.7, angle: 135, distance: { v: 6, u: "px" }, size: { v: 8, u: "px" } }, ssim: 0.985 },
  { name: "omni-fx-stroke", layer: "Outside", expect: { type: "fxStroke", stroke: { width: { v: 4, u: "px" }, align: "outside" } }, ssim: 0.99 },
  { name: "omni-fx-group", layer: "OMNI Group", expect: { type: "dropShadow", distance: { v: 10, u: "px" }, size: { v: 6, u: "px" } }, ssim: 0.985 },
  { name: "omni-fx-clip", layer: "Base", expect: { type: "dropShadow", distance: { v: 8, u: "px" }, size: { v: 4, u: "px" } }, ssim: 0.985 },
];

describe("Photoshop layer-effect references (omni-fx-*)", () => {
  for (const c of CASES)
    describe.skipIf(!has(c.name))(c.name, () => {
      it("effects read from lfx2 as the script set them", () => {
        const { page } = open(c.name);
        expect(fxOf(page, c.layer).find((e) => e.type === c.expect.type)).toMatchObject(c.expect);
      });

      it("our composite matches Photoshop's PNG and merged image within the effect tolerance", () => {
        const { page, merged } = open(c.name);
        const png = decodePngRgba(read(c.name + ".png"));
        const ours = compose(page);
        for (const ref of [png.rgba, merged]) {
          const d = diff(ours, ref, page.width, page.height);
          console.log(`[fx-ref] ${c.name}: max ${d.max} over2 ${d.over2} ssim ${d.ssim.toFixed(5)}`);
          expect(d.ssim).toBeGreaterThan(c.ssim);
        }
      });

      it("opened and saved unchanged: byte for byte; an edited effect stays valid", async () => {
        const { doc, page, bytes } = open(c.name);
        expect((await writePsd(doc, page)).bytes).toEqual(bytes);
        const n = page.nodes.find((x) => x.effects?.length);
        if (!n) return;
        const i = page.nodes.indexOf(n);
        page.nodes[i] = { ...n, effects: n.effects!.map((e) => ({ ...e, on: !e.on })) } as SceneNode;
        const r = await writePsd(doc, page);
        expect(checkPsd(r.bytes, null)).toEqual([]);
      });
    });
});
