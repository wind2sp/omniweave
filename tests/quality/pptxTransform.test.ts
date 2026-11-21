// PPTX export: non-uniform scale (Transform.scaleY; absent = scale, negative = flip) and non-destructive
// image crop reach the slide XML.

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync, zlibSync } from "fflate";
import { makeAsset } from "../../src/core/assets";
import { newDocument, newPage, newVector, type ImageNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { exportPptx } from "../../src/io/formats/pptx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const EMU = 9525;

/** 2×2 RGB PNG */
function png(): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(Array.from(type, (c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const raw = new Uint8Array([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 255, 255]);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) all.set(p, (o += p.length) - p.length);
  return all;
}

async function slideXml(build: (doc: ReturnType<typeof newDocument>, page: ReturnType<typeof newPage>) => void): Promise<string> {
  const doc = newDocument("t");
  const page = newPage("SLIDE", 960, 540, "s");
  doc.pages = [page];
  build(doc, page);
  const { bytes } = await exportPptx(doc, doc.pages);
  return strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]);
}

const xfrm = (xml: string) => {
  // the last one: the group transform of the shape tree comes first
  const m = [...xml.matchAll(/<a:xfrm([^>]*)><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)].pop()!;
  return { attrs: m[1], x: Number(m[2]) / EMU, y: Number(m[3]) / EMU, w: Number(m[4]) / EMU, h: Number(m[5]) / EMU };
};

describe("PPTX export transforms", () => {
  it("a shape stretched vertically keeps its stretched size", async () => {
    const xml = await slideXml((_, page) => {
      const v = newVector([rectContour(0, 0, 100, 50)], "box");
      v.fill = "#ff0000";
      v.transform = { ...v.transform, x: 10, y: 20, scale: 1, scaleY: 2 };
      page.nodes.push(v);
    });
    const f = xfrm(xml);
    expect(f.w).toBeCloseTo(100, 0);
    expect(f.h).toBeCloseTo(100, 0);
    expect([Math.round(f.x), Math.round(f.y)]).toEqual([10, 20]);
  });

  it("a negative scaleY is a vertical flip (flipV), the box stays where the page shows it", async () => {
    const xml = await slideXml((_, page) => {
      const v = newVector([rectContour(0, 0, 100, 50)], "box");
      v.fill = "#ff0000";
      v.transform = { ...v.transform, x: 10, y: 120, scale: 1, scaleY: -1 }; // occupies y 70…120 on the page
      page.nodes.push(v);
    });
    const f = xfrm(xml);
    expect(f.attrs).toContain('flipV="1"');
    expect([Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h)]).toEqual([10, 70, 100, 50]);
  });

  it("a cropped image is written as the visible part (a:srcRect), the picture stays whole", async () => {
    const xml = await slideXml((doc, page) => {
      const asset = makeAsset(png(), "image/png", "p.png");
      doc.assets[asset.id] = asset;
      const img: ImageNode = { ...(newVector([], "x") as any), type: "IMAGE", name: "pic", assetId: asset.id, width: 200, height: 100 };
      delete (img as any).contours;
      img.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
      img.crop = { x: 50, y: 25, w: 100, h: 50 };
      page.nodes.push(img);
    });
    expect(xml).toMatch(/<a:srcRect l="25000" t="25000" r="25000" b="25000"\/>/);
    const f = xfrm(xml);
    expect([Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h)]).toEqual([50, 25, 100, 50]);
  });
});
