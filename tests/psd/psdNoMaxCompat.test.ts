// A PSD saved with 'Maximize PSD compatibility' off carries a placeholder merged image (version info resource 1057:
// hasRealMergedData 0). It must not stand for Photoshop's picture — before the fix (QA 2026-11-18) the untouched view,
// thumbnails and PNG / PDF export showed the blank placeholder. Files: qa/interop/adobe-made/fidelity/*-nomax.psd
// (Photoshop 2027, ps_make_gaps.jsx) next to the same documents saved with it on, and Photoshop's own PNG (.ps.png).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { pristinePsdView } from "../../src/core/fidelity/overlay";
import { hasRealMergedData, importPsdPage, parsePsdLayout } from "../../src/io/formats/psd";
import { buildPsd } from "../../src/io/formats/psdWrite";

const FID = path.join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const load = (n: string) => new Uint8Array(fs.readFileSync(path.join(FID, n)));

describe("maximize compatibility off: no Photoshop picture to show", () => {
  for (const base of ["omni-fid-scene-blend", "omni-fid-text-ko", "omni-fid-smart-embedded", "omni-fid-scene-curves-mask"]) {
    it(`${base}: the -nomax file draws its layers; the file with the merged image keeps it`, async () => {
      const off = load(`${base}-nomax.psd`), on = load(`${base}.psd`);
      expect(hasRealMergedData(parsePsdLayout(off))).toBe(false);
      expect(hasRealMergedData(parsePsdLayout(on))).toBe(true);
      const pOff = importPsdPage(off, "off.psd", "off", { id: "a", hash: "h" }).page;
      const pOn = importPsdPage(on, "on.psd", "on", { id: "b", hash: "h2" }).page;
      expect(pOff.source?.psd?.compositeNode).toBeUndefined();
      expect(pristinePsdView(pOff)).toBeNull();
      expect(pOn.source?.psd?.compositeNode).toBeDefined();
      expect(pristinePsdView(pOn)).not.toBeNull();
      // same layers either way
      expect(pOff.nodes.map((n) => n.name)).toEqual(pOn.nodes.filter((n) => n.id !== pOn.source?.psd?.compositeNode).map((n) => n.name));
      expect((await scorePsd(off))?.score.reason).toBe("noComposite");
    });
  }

  it("hostile version resources: short, truncated, any non-zero flag count as real; only a 0 flag is a placeholder", () => {
    const bytes = new Uint8Array(64);
    const at = (data: number[], len = data.length) => {
      bytes.fill(0);
      bytes.set(data, 10);
      return { bytes, resItems: [{ id: 1057, start: 0, end: 10 + len, dataStart: 10, dataEnd: 10 + len }] };
    };
    expect(hasRealMergedData(at([]))).toBe(true);
    expect(hasRealMergedData(at([0, 0, 0, 1]))).toBe(true); // no flag byte
    expect(hasRealMergedData(at([0, 0, 0, 1, 0]))).toBe(false);
    expect(hasRealMergedData(at([0xff, 0xff, 0xff, 0xff, 0]))).toBe(false); // any version: the flag is what counts
    expect(hasRealMergedData(at([0, 0, 0, 1, 1]))).toBe(true);
    expect(hasRealMergedData(at([0, 0, 0, 1, 0xff]))).toBe(true);
    // a length running past the end of the file reads no byte → real
    expect(hasRealMergedData({ bytes: new Uint8Array(12), resItems: [{ id: 1057, start: 0, end: 12, dataStart: 10, dataEnd: 4000 }] })).toBe(true);
  });

  it("the import notice does not point at a hidden 'merged image' layer that is not there", () => {
    const off = importPsdPage(load("omni-fid-smart-embedded-nomax.psd"), "off.psd", "off", { id: "d", hash: "h4" });
    expect(off.page.source?.psd?.compositeNode).toBeUndefined();
    expect(off.warnings.join(" ")).not.toContain("숨겨 둔");
    expect(off.warnings.join(" ")).toContain("호환성 최대화");
    // (the same file with its merged image: its smart object now opens as a document of its own, so it has nothing
    // to point at either — psd16-smart; before, its 'preview pixels' notice pointed at the hidden merged image)
    const on = importPsdPage(load("omni-fid-smart-embedded.psd"), "on.psd", "on", { id: "e", hash: "h5" });
    expect(on.page.source?.psd?.compositeNode).toBeDefined();
    expect(on.warnings).toEqual([]);
    // the 32-bit reference (psd-32bit: layers kept, option off → flag 0): its layers are read and composited,
    // so the placeholder picture is not shown and no placeholder notice is given
    const b32 = load("omni-fid-32bit-blend-nomax.psd");
    const L32 = parsePsdLayout(b32);
    expect(hasRealMergedData(L32)).toBe(false);
    const real = importPsdPage(b32, "f.psd", "f", { id: "g", hash: "h6" });
    expect(real.pixelLayers).toBeGreaterThan(0);
    expect(real.warnings.join(" ")).not.toContain("자리표시");
  });

  it("files without the version resource (ours, older writers) count as real", () => {
    const b = buildPsd({ width: 8, height: 8, layers: [{ name: "omni", px: { rgba: new Uint8Array(256).fill(200), left: 0, top: 0, width: 8, height: 8 }, opacity: 1, visible: true, blend: "NORMAL" }] });
    const L = parsePsdLayout(b);
    expect(L.resItems.some((r) => r.id === 1057)).toBe(false);
    expect(hasRealMergedData(L)).toBe(true);
    expect(importPsdPage(b, "x.psd", "x", { id: "c", hash: "h3" }).page.source?.psd?.compositeNode).toBeDefined();
  });
});
