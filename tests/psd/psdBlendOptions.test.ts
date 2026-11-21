// New layer records carry Photoshop's default blending options (clbl / infx / knko). Without any of them Photoshop
// reads the record as a pre-CS layer and turns the opacity of a layer in one of the eight special modes into its fill
// opacity (QA 2026-11-18, Photoshop 28.0: a Colour Burn layer at 70 % written by the fresh writer opened as opacity
// 100 % / fill 70 % — 3325 pixels up to 51 levels different; qa/interop/RESULTS-2026-11-18-psd.md).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { newDocument, type BlendMode } from "../../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout, recordName, type PsdLayout, type PsdRecord } from "../../src/io/formats/psd";
import { buildPsd, writePsd } from "../../src/io/formats/psdWrite";
import { rasterFromRgba } from "../../src/io/formats/raster";

const FID = path.join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const solid = (w: number, h: number, c: number[]) => {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) a.set(c, i * 4);
  return a;
};
function options(L: PsdLayout, r: PsdRecord) {
  const v = (k: string) => {
    const b = r.blocks.find((x) => x.key === k);
    return b ? L.bytes[b.dataStart] : undefined;
  };
  return { clbl: v("clbl"), infx: v("infx"), knko: v("knko") };
}

describe("new layer records: Photoshop's default blending options", () => {
  it("fresh writer: every record has clbl 1, infx 0, knko 0; the opacity stays the opacity", () => {
    const bytes = buildPsd({
      width: 64,
      height: 48,
      layers: [
        { name: "omni-bg", px: { rgba: solid(64, 48, [200, 150, 90, 255]), left: 0, top: 0, width: 64, height: 48 }, opacity: 1, visible: true, blend: "NORMAL" },
        { name: "omni-burn", px: { rgba: solid(40, 30, [90, 120, 220, 255]), left: 10, top: 8, width: 40, height: 30 }, opacity: 0.7, visible: true, blend: "COLOR_BURN" },
      ],
    });
    const L = parsePsdLayout(bytes);
    for (const r of L.records) expect(options(L, r)).toEqual({ clbl: 1, infx: 0, knko: 0 });
    const burn = decodePsd(bytes).layers.find((l) => l.name === "omni-burn")!;
    expect([Math.round(burn.opacity * 255), burn.fill]).toEqual([179, 1]);
  });

  it("a layer added to a Photoshop file (PSD Surgeon) gets them too; Photoshop's own records keep theirs", async () => {
    const src = new Uint8Array(fs.readFileSync(path.join(FID, "omni-fid-blend-multiply.psd")));
    const asset = makeAsset(src, "image/vnd.adobe.photoshop", "omni-fid-blend-multiply.psd");
    const page = importPsdPage(src, "omni-fid-blend-multiply.psd", "omni", asset).page;
    const doc = newDocument("omni");
    doc.pages = [page];
    doc.assets[asset.id] = asset;
    for (const [i, mode] of (["COLOR_BURN", "LINEAR_DODGE", "HARD_MIX"] as BlendMode[]).entries()) {
      const n = rasterFromRgba(solid(30, 20, [40 * i, 120, 220, 255]), 30, 20, `omni-new ${mode}`);
      n.transform = { x: 10 + 40 * i, y: 10, rotation: 0, scale: 1 };
      n.blendMode = mode;
      n.opacity = 0.6;
      page.nodes.push(n);
    }
    const r = await writePsd(doc, page);
    expect(r.method).toBe("surgery");
    const L = parsePsdLayout(r.bytes);
    const added = L.records.filter((x) => recordName(L.bytes, x).startsWith("omni-new"));
    expect(added).toHaveLength(3);
    for (const x of added) expect(options(L, x)).toEqual({ clbl: 1, infx: 0, knko: 0 });
    const O = parsePsdLayout(src);
    for (const x of O.records) {
      const same = L.records.find((y) => recordName(L.bytes, y) === recordName(O.bytes, x))!;
      expect(options(L, same)).toEqual(options(O, x));
    }
  });

  // QA 2026-11-18: Photoshop's own non-default options (knockout shallow / deep, interior effects as group) survive
  // when the layer itself is edited — its record is rewritten, never given the defaults
  for (const f of ["omni-fid-knockout-deep.psd", "omni-fid-knockout-shallow.psd", "omni-fid-fill40-overlay-interior.psd"]) {
    it(`${f}: every layer renamed, 55 %, Screen — the file's clbl / infx / knko stay as Photoshop wrote them`, async () => {
      const src = new Uint8Array(fs.readFileSync(path.join(FID, f)));
      const asset = makeAsset(src, "image/vnd.adobe.photoshop", f);
      const page = importPsdPage(src, f, "omni", asset).page;
      const doc = newDocument("omni");
      doc.pages = [page];
      doc.assets[asset.id] = asset;
      const comp = page.source?.psd?.compositeNode;
      page.nodes = page.nodes.map((n) => (n.id === comp ? n : { ...n, name: n.name + " omni", opacity: 0.55, blendMode: "SCREEN" as BlendMode }));
      const r = await writePsd(doc, page);
      expect(r.method).toBe("surgery");
      const O = parsePsdLayout(src), L = parsePsdLayout(r.bytes);
      const lyid = (P: PsdLayout, x: PsdRecord) => {
        const b = x.blocks.find((k) => k.key === "lyid");
        return b ? (P.bytes[b.dataStart] << 24) | (P.bytes[b.dataStart + 1] << 16) | (P.bytes[b.dataStart + 2] << 8) | P.bytes[b.dataStart + 3] : -1;
      };
      expect(O.records.some((x) => { const o = options(O, x); return o.infx === 1 || (o.knko ?? 0) > 0; })).toBe(true);
      expect(L.records).toHaveLength(O.records.length);
      for (const x of O.records) {
        const y = L.records.find((k) => lyid(L, k) === lyid(O, x))!;
        expect(options(L, y)).toEqual(options(O, x));
      }
      expect(L.records.filter((x) => recordName(L.bytes, x).endsWith(" omni")).length).toBeGreaterThan(0);
    });
  }
});
