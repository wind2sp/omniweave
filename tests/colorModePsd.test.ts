// 이미지 › 모드 in a PSD (ui/ps/colorMode.ts, io/formats/psdWrite.ts): a page set to CMYK / Grayscale is written in
// that mode — from an RGB PSD too (written anew) — and opens in it again, its colours as they were on the screen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { newDocument } from "../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout } from "../src/io/formats/psd";
import { writePsd } from "../src/io/formats/psdWrite";

const SRC = "qa/samples/store-sample/ko/omni-store-layers.psd";
const open = (bytes: Uint8Array) => {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omw-mode.psd");
  const r = importPsdPage(bytes, "omw-mode.psd", "omw-mode", asset);
  const doc = newDocument("omw-mode");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return doc;
};
const px = (rgba: Uint8Array | Uint8ClampedArray, w: number, x: number, y: number) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

describe("PSD colour mode", () => {
  it("an RGB PSD set to CMYK is saved as CMYK, opens as CMYK, and its colours stay", async () => {
    const src = new Uint8Array(readFileSync(SRC));
    expect(parsePsdLayout(src).mode).toBe(3);
    const doc = open(src);
    expect(doc.pages[0].colorMode).toBeUndefined();
    doc.pages[0].colorMode = "cmyk";
    const out = await writePsd(doc, doc.pages[0]);
    expect(parsePsdLayout(out.bytes).mode).toBe(4);
    expect(open(out.bytes).pages[0].colorMode).toBe("cmyk");
    // the colours: separated through the CMYK profile, as Photoshop converts — a colour outside the CMYK gamut (the
    // sample's bright magenta) comes back duller, as it does there; saved again unchanged, the inks stay as they are
    const d2 = open(out.bytes);
    const again = await writePsd(d2, d2.pages[0]);
    expect(parsePsdLayout(again.bytes).mode).toBe(4);
    expect(again.method).toBe("original");
    const b = decodePsd(out.bytes), c = decodePsd(again.bytes), a = decodePsd(src);
    for (const [x, y] of [[700, 50], [30, 580], [150, 150], [450, 250]]) {
      const p = px(b.composite!, b.width, x, y), q = px(c.composite!, c.width, x, y), o = px(a.composite!, a.width, x, y);
      for (let i = 0; i < 3; i++) expect(Math.abs(p[i] - q[i]), `${x},${y} ch${i}`).toBeLessThanOrEqual(2);
      // and near the RGB original (within the gamut's pull)
      expect(Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]), `${x},${y}`).toBeLessThan(80);
    }
  });
  it("Grayscale: a Grayscale PSD that opens as Grayscale", async () => {
    const doc = open(new Uint8Array(readFileSync(SRC)));
    doc.pages[0].colorMode = "gray";
    const out = await writePsd(doc, doc.pages[0]);
    expect(parsePsdLayout(out.bytes).mode).toBe(1);
    expect(open(out.bytes).pages[0].colorMode).toBe("gray");
  });
});
