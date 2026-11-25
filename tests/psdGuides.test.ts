// Ruler guides in a PSD (image resource 1032): written from page.guides, read back into it — a fresh PSD and one
// rewritten from an opened PSD (realuse img-rulers-guides 2026-11-25: guides made in the image mode were not saved).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { newDocument } from "../src/core/types";
import { importPsdPage, parsePsdLayout } from "../src/io/formats/psd";
import { guidesResource, readGuides, replaceGuidesResource } from "../src/io/formats/psdGuides";
import { writePsd } from "../src/io/formats/psdWrite";

const SRC = "qa/samples/store-sample/ko/omni-store-layers.psd";
const open = (bytes: Uint8Array) => {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omw-guides.psd");
  const r = importPsdPage(bytes, "omw-guides.psd", "omw-guides", asset);
  const doc = newDocument("omw-guides");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return doc;
};

describe("PSD ruler guides (1032)", () => {
  it("the resource holds each guide in 1/32 px with its direction", () => {
    const b = guidesResource({ x: [400], y: [150.5] });
    const items = [{ id: 1032, dataStart: 12, dataEnd: 12 + 26 }];
    expect(readGuides(b, items)).toEqual({ x: [400], y: [150.5] });
    expect(guidesResource({})).toHaveLength(0);
    // replaced, not added twice
    const twice = replaceGuidesResource(b, { x: [10] });
    expect(readGuides(twice, [{ id: 1032, dataStart: 12, dataEnd: 12 + 21 }])).toEqual({ x: [10] });
    expect(twice.length).toBe(12 + 22);
  });
  it("guides of an opened PSD are saved with it and come back", async () => {
    const doc = open(new Uint8Array(readFileSync(SRC)));
    const page = doc.pages[0];
    page.guides = { x: [400], y: [300, 120] };
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    expect(readGuides(out.bytes, L.resItems)).toEqual({ x: [400], y: [300, 120] });
    expect(open(out.bytes).pages[0].guides).toEqual({ x: [400], y: [300, 120] });
  });
});
