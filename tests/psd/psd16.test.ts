// 16-bit PSD documents (2026-11-21, PSD dept, psd16-smart): shown and edited at 8-bit levels as before, but the
// save keeps 16 bits end to end where nothing changed — every unchanged sample of an edited layer and of the merged
// image keeps its exact 16-bit value — and an edited sample is its 8-bit level with the original pixel's fine part
// (below one 8-bit level) carried over (psdWrite.ts widen16), so a smooth 16-bit ramp stays smooth after an 8-bit edit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { makeTile } from "../../src/core/tile";
import { newDocument, type RasterNode } from "../../src/core/types";
import { importPsdPage, parsePsdLayout, readChannelPlane, readCompositePlanes, recordName } from "../../src/io/formats/psd";
import { checkPsd, widen16, writePsd } from "../../src/io/formats/psdWrite";

const FID = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));
const u16 = (p: Uint8Array, i: number) => (p[i * 2] << 8) | p[i * 2 + 1];

function open(name: string) {
  const bytes = read(name);
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name);
  const r = importPsdPage(bytes, name, name, asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page, r, bytes };
}

/** the first ordinary pixel layer (not the hidden merged image, not an adjustment) */
const pixelLayer = (page: ReturnType<typeof open>["page"]) => page.nodes.find((n): n is RasterNode => n.type === "RASTER" && !n.adjust && n.id !== page.source?.psd?.compositeNode && Object.keys(n.tiles).length > 0)!;

function plane16(bytes: Uint8Array, layer: string, id: number) {
  const L = parsePsdLayout(bytes);
  const rec = L.records.find((r) => recordName(bytes, r) === layer)!;
  const w = rec.right - rec.left, h = rec.bottom - rec.top;
  const ch = rec.channels.find((c) => c.id === id)!;
  return { p: readChannelPlane(bytes, ch.start, ch.end, w, h, 2, L.psb), w, h, left: rec.left, top: rec.top };
}

describe("widen16", () => {
  it("unchanged samples keep 16 bits; edited ones carry the original's fine part and read back as the edit", () => {
    const o16 = new Uint8Array(8);
    const vals = [0x1234, 0x8080 + 100, 65535, 300];
    vals.forEach((v, i) => ((o16[i * 2] = v >> 8), (o16[i * 2 + 1] = v & 255)));
    const p8 = new Uint8Array(vals.map((v) => Math.round(v / 257)));
    p8[1] += 10; // edited by +10 levels
    p8[2] = 200;
    const out = widen16(p8, { o16, at: (i) => (i === 3 ? -1 : i) });
    expect(u16(out, 0)).toBe(0x1234);
    expect(u16(out, 1)).toBe(0x8080 + 100 + 2570);
    expect(Math.round(u16(out, 1) / 257)).toBe(p8[1]);
    expect(u16(out, 2)).toBe(200 * 257 + (65535 - 255 * 257)); // = 200 · 257 (65535 is exactly 255 · 257)
    expect(u16(out, 3)).toBe(p8[3] * 257); // no original pixel: the level itself
    // every edited level reads back as itself whatever the original's fine part was (−128 … 128)
    for (let was = 0; was < 65536; was += 37) {
      const o = new Uint8Array([was >> 8, was & 255]);
      for (const v of [0, 1, 127, 254, 255]) expect(Math.round(u16(widen16(new Uint8Array([v]), { o16: o, at: () => 0 }), 0) / 257)).toBe(v);
    }
  });
});

describe("Photoshop's 16-bit files (omni-fid-16bit-*)", () => {
  it("opens without a loss notice (the 8-bit view is information), saves unedited byte for byte", async () => {
    for (const f of ["omni-fid-16bit-blend.psd", "omni-fid-16bit-curves.psd", "omni-fid-16bit-levels.psd", "omni-fid-16bit-mask-opacity.psd", "omni-fid-16bit-gray.psd", "omni-fid-16bit-fx-stroke.psd"]) {
      const { doc, page, r, bytes } = open(f);
      expect([f, r.warnings]).toEqual([f, []]);
      expect(r.info.join()).toContain("16비트 원래 값 그대로");
      expect(Buffer.from((await writePsd(doc, page)).bytes).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("one pixel edited: every other sample of that layer keeps its 16 bits; the merged image keeps its unchanged pixels", async () => {
    const { doc, page, bytes } = open("omni-fid-16bit-blend.psd");
    const n = pixelLayer(page);
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    const at = (40 * 256 + 40) * 4;
    const was = [data[at], data[at + 1], data[at + 2]];
    data.set([255 - was[0], 255 - was[1], 255 - was[2], 255], at);
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
    const out = await writePsd(doc, page);
    expect(out.warnings.join()).toContain("16비트 원래 값 그대로");
    const L = parsePsdLayout(out.bytes);
    expect(checkPsd(out.bytes, { width: L.width, height: L.height, depth: 16, mode: L.mode, psb: L.psb })).toEqual([]);
    for (const id of [0, 1, 2]) {
      const A = plane16(bytes, n.name, id), B = plane16(out.bytes, n.name, id);
      expect([B.w, B.h, B.left, B.top]).toEqual([A.w, A.h, A.left, A.top]);
      let diff = 0;
      for (let i = 0; i < A.w * A.h; i++) if (u16(A.p, i) !== u16(B.p, i)) diff++;
      expect(diff).toBeLessThanOrEqual(1);
      // the edited pixel: its new 8-bit level, as 16 bits
      const j = (40 + n.transform.y - A.top) * A.w + 40 + n.transform.x - A.left;
      expect(Math.round(u16(B.p, j) / 257)).toBe(255 - was[id]);
    }
    // merged image: pixels whose 8-bit view did not change keep their exact 16-bit samples
    const O = parsePsdLayout(bytes);
    const before = readCompositePlanes(O, 3), after = readCompositePlanes(L, 3);
    let same = 0, total = 0;
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < O.width * O.height; i++) {
        total++;
        if (u16(before[c], i) === u16(after[c], i)) same++;
      }
    expect(same / total).toBeGreaterThan(0.9999);
  });

  it("a +10 level edit of a whole layer keeps its 16-bit gradient (original + 10 · 257, not 8-bit steps)", async () => {
    const { doc, page, bytes } = open("omni-fid-16bit-levels.psd");
    const n = page.nodes.find((x): x is RasterNode => x.name === "omni-base")!;
    n.tiles = Object.fromEntries(
      Object.entries(n.tiles).map(([k, t]) => {
        const d = new Uint8ClampedArray(t.data);
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]) for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c] + 10);
        return [k, makeTile(d)];
      }),
    );
    const out = await writePsd(doc, page);
    let exact = 0, counted = 0;
    for (const id of [0, 1, 2]) {
      const A = plane16(bytes, n.name, id), B = plane16(out.bytes, n.name, id);
      for (let i = 0; i < A.w * A.h; i++) {
        const o = u16(A.p, i);
        if (Math.round(o / 257) + 10 > 255) continue;
        counted++;
        if (u16(B.p, i) === o + 2570) exact++;
      }
    }
    expect(counted).toBeGreaterThan(1000);
    expect(exact / counted).toBeGreaterThan(0.99);
  });
});
