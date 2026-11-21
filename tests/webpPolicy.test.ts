// WebP in Word / 한글 saves (io/webpPolicy.ts): the opened file's own WebP keeps its bytes; one the person added is
// saved as a PNG (lossless, no notice).
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { getBlob, makeAsset } from "../src/core/assets";
import { newDocument, newImage, newPage, type OmwDocument } from "../src/core/types";
import { exportDocx, exportHwpx } from "../src/io/office";
import { isWebp, newWebpAssets, webpToPng } from "../src/io/webpPolicy";
import { readFileSync } from "node:fs";

const PNG = new Uint8Array(readFileSync("public/app_small.png"));
function webp(seed: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
  b[30] = seed;
  return b;
}

function docWith(origId: boolean): { doc: OmwDocument; nodeId: string; assetId: string } {
  const doc = newDocument();
  const p = newPage("DOCUMENT", 794, 1123, "p");
  const a = makeAsset(webp(origId ? 1 : 2), "image/webp", "pic.webp");
  const n = newImage(a.id, 200, 100, "pic");
  n.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
  p.nodes.push(n);
  if (origId) p.source = { format: "docx", name: "a.docx", office: { parts: [], pics: [{ id: n.id, part: "word/document.xml", b: 0, k: 0, fp: "" }] } as never };
  doc.pages = [p];
  doc.assets = { [a.id]: a };
  return { doc, nodeId: n.id, assetId: a.id };
}

describe("WebP policy for DOCX / HWPX", () => {
  it("recognises WebP bytes", () => {
    expect(isWebp(webp(0))).toBe(true);
    expect(isWebp(PNG)).toBe(false);
  });

  it("the person's WebP becomes a PNG; the original document is untouched", async () => {
    const { doc, assetId } = docWith(false);
    expect(newWebpAssets(doc)).toEqual([assetId]);
    const out = await webpToPng(doc, async () => PNG);
    expect(out).not.toBe(doc);
    const n = out.pages[0].nodes[0] as { assetId: string };
    expect(n.assetId).not.toBe(assetId);
    expect(getBlob(out.assets[n.assetId].hash)).toEqual(PNG);
    expect((doc.pages[0].nodes[0] as { assetId: string }).assetId).toBe(assetId);
    const z = unzipSync(exportDocx(out.pages, { assets: out.assets }));
    expect(Object.keys(z)).toContain("word/media/image1.png");
  });

  it("the file's own WebP stays WebP, byte for byte, also when the file is written anew", async () => {
    const { doc } = docWith(true);
    expect(newWebpAssets(doc)).toEqual([]);
    expect(await webpToPng(doc, async () => PNG)).toBe(doc);
    const z = unzipSync(exportDocx(doc.pages, { assets: doc.assets }));
    expect(z["word/media/image1.webp"]).toEqual(webp(1));
    expect(new TextDecoder().decode(z["[Content_Types].xml"])).toContain('Extension="webp"');
    const h = unzipSync(exportHwpx(doc.pages, "t", { assets: doc.assets }));
    expect(Object.entries(h).some(([k, v]) => /^BinData\/.*\.webp$/.test(k) && v.length === 40)).toBe(true);
  });
});
