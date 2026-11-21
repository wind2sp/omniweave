// Pretendard Regular/Bold ship as a lossless "TrueType pack" (src/io/fontPack.ts, public/fonts/*.ttpack): glyf is split
// into WOFF2-style streams so the installer's brotli compresses it ~15% better than the TTF, and unpacking gives the
// ORIGINAL TTF back byte for byte — so the font program PDF export embeds does not change. docs/design/INSTALLER_SIZE.md.
//
// Regenerate the shipped packs after changing the source TTFs (assets/fonts/):
//   OMNIWEAVE_WRITE_FONTPACK=1 npx vitest run tests/size/fontPack.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { unzlibSync } from "fflate";
import { packTtf, unpackTtf } from "../../src/io/fontPack";

const WEIGHTS = ["Regular", "Bold"] as const;
const src = (w: string) => new Uint8Array(readFileSync(`assets/fonts/Pretendard-${w}.ttf`));
const shipped = (w: string) => `public/fonts/Pretendard-${w}.ttpack`;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

if (process.env.OMNIWEAVE_WRITE_FONTPACK) for (const w of WEIGHTS) writeFileSync(shipped(w), packTtf(src(w)));

/** Minimal TrueType file: head (long loca), maxp, loca, glyf from the given glyph records. */
function tinyTtf(glyphs: Uint8Array[]): Uint8Array {
  const glyf = new Uint8Array(glyphs.reduce((a, g) => a + g.length, 0));
  const offs: number[] = [0];
  glyphs.reduce((p, g) => (glyf.set(g, p), offs.push(p + g.length), p + g.length), 0);
  const loca = new Uint8Array(4 * offs.length);
  offs.forEach((o, i) => new DataView(loca.buffer).setUint32(4 * i, o));
  const head = new Uint8Array(54);
  new DataView(head.buffer).setInt16(50, 1);
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint16(4, glyphs.length);
  const tables: [string, Uint8Array][] = [["glyf", glyf], ["head", head], ["loca", loca], ["maxp", maxp]];
  let off = 12 + 16 * tables.length;
  const total = tables.reduce((a, [, t]) => a + ((t.length + 3) & ~3), off);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x10000);
  dv.setUint16(4, tables.length);
  tables.forEach(([tag, t], i) => {
    for (let k = 0; k < 4; k++) out[12 + 16 * i + k] = tag.charCodeAt(k);
    dv.setUint32(12 + 16 * i + 8, off);
    dv.setUint32(12 + 16 * i + 12, t.length);
    out.set(t, off);
    off += (t.length + 3) & ~3;
  });
  return out;
}
const bytes = (...v: number[]) => Uint8Array.from(v);
const i16 = (v: number) => [(v >> 8) & 255, v & 255];

describe("TrueType pack", () => {
  it.each(WEIGHTS)("Pretendard %s: unpack(pack(ttf)) is the TTF byte for byte, and the shipped pack is current", (w) => {
    const ttf = src(w);
    const p = packTtf(ttf);
    expect(same(unpackTtf(p), ttf)).toBe(true);
    expect(p.length).toBeLessThan(ttf.length);
    expect(existsSync(shipped(w))).toBe(true);
    const disk = new Uint8Array(readFileSync(shipped(w)));
    expect(same(disk, p)).toBe(true);
    expect(same(unpackTtf(disk), ttf)).toBe(true);
  });

  it("glyphs the stream form cannot reproduce exactly are kept raw (and still round-trip)", () => {
    // simple glyph, 1 contour, 3 points, canonical (greedy) flags and coordinates
    // points (100,0) (200,100) (100,200): x deltas +100 +100 −100, y deltas 0 +100 +100
    const canon = bytes(...i16(1), ...i16(100), ...i16(0), ...i16(200), ...i16(200), ...i16(2), ...i16(0), 0x33, 0x37, 0x27, 100, 100, 100, 100, 100);
    // the same outline with a non-canonical encoding (2-byte x delta where 1 byte would do)
    const loose = bytes(...i16(1), ...i16(100), ...i16(0), ...i16(200), ...i16(200), ...i16(2), ...i16(0), 0x21, 0x37, 0x27, ...i16(100), 100, 100, 100, 100);
    // stale bounding box, overlap flag bit, instructions, large deltas, a composite and an empty glyph
    const bbox = bytes(...i16(1), ...i16(90), ...i16(0), ...i16(200), ...i16(200), ...i16(2), ...i16(0), 0x33, 0x37, 0x27, 100, 100, 100, 100, 100);
    const overlap = bytes(...i16(1), ...i16(100), ...i16(0), ...i16(200), ...i16(200), ...i16(2), ...i16(0), 0x73, 0x37, 0x27, 100, 100, 100, 100, 100);
    const instr = bytes(...i16(1), ...i16(100), ...i16(0), ...i16(200), ...i16(200), ...i16(2), ...i16(3), 0xb0, 0x01, 0x2f, 0x33, 0x37, 0x27, 100, 100, 100, 100, 100);
    // (−3000,−20) (1500,−20) (1500,0): off-curve 2-byte x, short y; 2-byte x, same y; same x, short y
    const big = bytes(...i16(1), ...i16(-3000), ...i16(-20), ...i16(1500), ...i16(0), ...i16(2), ...i16(0), 0x04, 0x21, 0x35, ...i16(-3000), ...i16(4500), 20, 20);
    const comp = bytes(...i16(-1), ...i16(0), ...i16(0), ...i16(100), ...i16(100), 0x00, 0x02, 0x00, 0x01, 5, 7);
    const ttf = tinyTtf([new Uint8Array(0), canon, loose, bbox, overlap, instr, big, comp]);
    expect(same(unpackTtf(packTtf(ttf)), ttf)).toBe(true);
  });

  it("rejects what is not a pack, and a truncated pack", () => {
    expect(() => unpackTtf(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toThrow();
    const p = packTtf(src("Bold"));
    expect(() => unpackTtf(p.subarray(0, p.length - 100))).toThrow();
  });

  it("PDF export embeds the same font program from the unpacked TTF (fontkit subset bytes equal)", async () => {
    const fontFiles = async (ttf: Uint8Array) => {
      const pdf = await PDFDocument.create({ updateMetadata: false });
      pdf.registerFontkit(fontkit);
      const f = await pdf.embedFont(ttf, { subset: true });
      pdf.addPage().drawText("한글 Omniweave 오메 1234 ①☑", { font: f, size: 12 });
      await pdf.save(); // subsetting happens on save
      const out: Uint8Array[] = [];
      for (const [, o] of pdf.context.enumerateIndirectObjects()) {
        if (!(o instanceof PDFDict) || o.get(PDFName.of("Type")) !== PDFName.of("FontDescriptor")) continue;
        const s = pdf.context.lookup(o.get(PDFName.of("FontFile2")) ?? o.get(PDFName.of("FontFile3")));
        if (s instanceof PDFRawStream) out.push(unzlibSync(s.contents));
      }
      return out;
    };
    for (const w of WEIGHTS) {
      const a = await fontFiles(src(w));
      const b = await fontFiles(unpackTtf(new Uint8Array(readFileSync(shipped(w)))));
      expect(a.length).toBe(1);
      expect(a[0].length).toBeGreaterThan(1000);
      expect(same(a[0], b[0])).toBe(true);
    }
  });
});
