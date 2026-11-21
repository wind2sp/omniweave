// A deck larger than 64 MB (corpus #n: 46 slides, ~150 MB, nearly all stored pictures) used to be opened without its
// original package — a size gate in the PPTX open path — so an unedited save was a new package and a one-place edit
// could not be saved into the original. The deck here is PowerPoint's omni-pptx-media.pptx repacked with a stored
// padding part that takes it over that size; it must keep its package like any other deck, and the pictures and clips
// the pages hold must be views of those same bytes (stored parts), not a second copy.

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { getBlob } from "../../src/core/assets";
import { newDocument, type OmwDocument, type TextNode } from "../../src/core/types";
import { formatForExt } from "../../src/io/formats";
import { pptxSurgical, pptxUnchanged } from "../../src/io/officesurgeon/pptx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const MEDIA = "qa/interop/adobe-made/omni-pptx-media.pptx";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PAD = 66 * 1024 * 1024;

/** The media deck repacked: pictures / clips stored (as PowerPoint writes them) or deflated, plus a stored padding part. */
function repack(mediaStored: boolean, pad: number): Uint8Array {
  const src = unzipSync(new Uint8Array(readFileSync(MEDIA)));
  const out: Zippable = {};
  for (const [name, data] of Object.entries(src)) out[name] = [data, { level: /^ppt\/media\//.test(name) && mediaStored ? 0 : 6 }];
  if (pad) {
    const b = new Uint8Array(pad);
    let x = 0x2545f491;
    for (let i = 0; i < b.length; i += 4) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      b[i] = x & 255;
    }
    out["ppt/media/omni-pad.bin"] = [b, { level: 0 }];
  }
  return zipSync(out);
}

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("pptx")!.open({ name: "omni-big.pptx", path: null, bytes } as never, {} as any);
  const doc = newDocument("deck");
  doc.pages = r.pages;
  doc.assets = r.assets ?? {};
  return doc;
}

const changed = (a: Record<string, Uint8Array>, b: Record<string, Uint8Array>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !a[k] || !b[k] || a[k].length !== b[k].length || a[k].some((v, i) => v !== b[k][i])).sort();

describe("PPTX larger than 64 MB keeps its original package", () => {
  let big: Uint8Array;
  let doc: OmwDocument;
  beforeAll(async () => {
    big = repack(true, PAD);
    doc = await open(big);
  });

  it("is kept and saved unedited byte for byte", () => {
    expect(big.length).toBeGreaterThan(64 * 1024 * 1024);
    const orig = Object.values(doc.assets).filter((a) => a.mime === PPTX_MIME);
    expect(orig).toHaveLength(1);
    expect(doc.pages.every((p) => p.source?.office?.assetId === orig[0].id)).toBe(true);
    const same = pptxUnchanged(doc.pages)!;
    expect(same).not.toBeNull();
    expect(same.length).toBe(big.length);
    expect(same.every((v, i) => v === big[i])).toBe(true);
  });

  it("holds its stored pictures and clips as views of the original, not copies", () => {
    const media = Object.values(doc.assets).filter((a) => a.mime !== PPTX_MIME);
    expect(media.length).toBeGreaterThan(0);
    // booleans, not the buffers: a failing toBe would print tens of megabytes
    for (const a of media) expect(getBlob(a.hash)!.buffer === big.buffer).toBe(true);
  });

  it("one character typed: only that slide part changes", async () => {
    const t = doc.pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    t.paragraphs[0].runs[0].text = "X" + t.paragraphs[0].runs[0].text;
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    expect(changed(unzipSync(big), unzipSync(r.bytes))).toEqual(["ppt/slides/slide1.xml"]);
    t.paragraphs[0].runs[0].text = t.paragraphs[0].runs[0].text.slice(1);
  });

  it("deflated media are still read whole (copied out of the package)", async () => {
    const small = repack(false, 0);
    const d = await open(small);
    const stored = await open(repack(true, 0));
    const hashes = (x: OmwDocument) => Object.values(x.assets).filter((a) => a.mime !== PPTX_MIME).map((a) => a.hash).sort();
    expect(hashes(d)).toEqual(hashes(stored));
    for (const a of Object.values(d.assets)) if (a.mime !== PPTX_MIME) expect(getBlob(a.hash)!.buffer === small.buffer).toBe(false);
  });
});
