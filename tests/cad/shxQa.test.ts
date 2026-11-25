// QA of SHX reading (cad/shx.ts, shxLoad.ts): damaged and hostile files end quickly with bounded output, font names never
// become paths outside the folders tried, each file is read once per path, and a PDF draws SHX text as lines with a
// blank-glyph text layer (the user's SHX shapes are never embedded as a font — docs/legal/IP_CHECKLIST.md 13).
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import { describe, expect, it } from "vitest";
import { pairGlyph, parseShx, shxGlyph, type ShxFont } from "../../src/io/formats/cad/shx";
import { loadDrawingShx, loadShxFamilies, resetShxCache, safeShxName } from "../../src/io/formats/cad/shxLoad";
import { registerShxPair, strokeAdvance, strokeFontTtf, STROKE_SHX } from "../../src/io/formats/cad/strokeFont";
import { cpuNow, cpuBudget, wallTimeout } from "../budget";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le16 = (v: number) => [v & 255, (v >> 8) & 255];
const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
function unifont(shapes: Record<number, number[]>, above = 10, below = 3): Uint8Array {
  const info = [...ascii("QA"), 0, above, below, 0, 0, 0, 0];
  const out = [...ascii("AutoCAD-86 unifont 1.0\r\n"), 0x1a, ...le32(Object.keys(shapes).length + 1), ...le16(info.length), ...info];
  for (const [k, v] of Object.entries(shapes)) {
    const def = [0, ...v];
    out.push(...le16(+k), ...le16(def.length), ...def);
  }
  return new Uint8Array(out);
}
/** seeded random numbers (the same cases every run) */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
}
const CHARS = [..."AZaz09 ?%°±⌀가오季報"];
/** everything a font is used for: parse, glyphs of some characters, the TrueType face */
function exercise(bytes: Uint8Array, name: string) {
  const f = parseShx(bytes, name);
  if (!f) return 0;
  const pair = f.kind === "bigfont" ? { main: null, big: f } : { main: f, big: null };
  let pts = 0;
  for (const ch of CHARS) for (const s of pairGlyph(pair, ch)?.strokes ?? []) pts += s.length;
  for (const code of [...f.defs.keys()].slice(0, 40)) shxGlyph(f, code);
  registerShxPair("qa-fuzz", pair);
  const ttf = strokeFontTtf(CHARS, false, "shx:qa-fuzz");
  (fontkit as any).create(ttf as any);
  return pts;
}

describe("SHX reading QA", () => {
  it("subshapes calling each other over and over, scale bytes multiplied up: bounded and quick", () => {
    // shapes 1–6 each call the next 20,000 times (20,000^6 calls unbounded); shape 7 multiplies the scale 100 times
    const calls = (n: number) => Array.from({ length: 20000 }, () => [7, 0, n]).flat();
    const shapes: Record<number, number[]> = { 0x41: [...calls(1)], 0x42: [...Array(100).fill([4, 255]).flat(), 0x8c, 0] };
    for (let k = 1; k <= 6; k++) shapes[k] = calls(k + 1);
    shapes[7] = [1, 0x14, 0x10, 0];
    const t0 = cpuNow();
    const f = parseShx(unifont(shapes), "bomb.shx")!;
    const a = shxGlyph(f, 0x41)!;
    expect(a.strokes.reduce((n, s) => n + s.length, 0)).toBeLessThanOrEqual(20_001);
    const b = shxGlyph(f, 0x42)!;
    for (const s of b.strokes) for (const [x, y] of s) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    registerShxPair("bomb", { main: f, big: null });
    const ttf = strokeFontTtf("AB", false, "shx:bomb");
    const font = (fontkit as any).create(ttf as any);
    expect(font.glyphForCodePoint(0x41).id).toBeGreaterThan(0);
    expect(Number.isFinite(strokeAdvance("AB", "shx:bomb"))).toBe(true);
    expect(cpuNow() - t0).toBeLessThan(cpuBudget(5000));
  });

  it("headers claiming huge counts and big-font ranges past the end", () => {
    const huge = new Uint8Array([...ascii("AutoCAD-86 unifont 1.0\r\n"), 0x1a, 0xff, 0xff, 0xff, 0xff, 4, 0, 0x51, 0, 10, 2]);
    expect(() => exercise(huge, "huge.shx")).not.toThrow();
    const big = new Uint8Array([...ascii("AutoCAD-86 bigfont 1.0\r\n"), 0x1a, 8, 0, 0xff, 0xff, 0xff, 0xff, 0xb0, 0, 0xc8, 0]);
    expect(() => exercise(big, "whgqa.shx")).not.toThrow();
    const shapes = new Uint8Array([...ascii("AutoCAD-86 shapes 1.1\r\n"), 0x1a, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    expect(() => exercise(shapes, "shp.shx")).not.toThrow();
  });

  it("fuzz: truncated and mutated fonts never throw or hang", () => {
    const seeds: [string, Uint8Array][] = [["syn.shx", unifont({ 0x41: [1, 0x84, 0x8c, 10, 4, 0x40, 7, 0, 0x42, 0], 0x42: [12, 5, 5, 60, 13, 4, 4, 30, 0, 0, 0], 0x20: [2, 0x60, 0] })]];
    // AutoCAD's fonts when installed: read in place, mutated in memory only
    const ACAD = "E:/Autodesk/AutoCAD 2027/Fonts";
    for (const n of ["txt", "romans", "whgtxt", "gbcbig", "extfont"]) if (existsSync(`${ACAD}/${n}.shx`)) seeds.push([`${n}.shx`, new Uint8Array(readFileSync(`${ACAD}/${n}.shx`))]);
    const r = rng(7);
    let worst = 0;
    for (const [name, src] of seeds) {
      const cases = name === "syn.shx" ? 400 : 60;
      for (let k = 0; k < cases; k++) {
        let b = src.slice(0, 64 + Math.floor(r() * (src.length - 64)));
        if (k % 2) {
          b = src.slice();
          for (let j = 0; j < 1 + r() * 40; j++) b[64 + Math.floor(r() * (b.length - 64))] = Math.floor(r() * 256);
        }
        const t0 = cpuNow();
        expect(() => exercise(b, name)).not.toThrow();
        worst = Math.max(worst, cpuNow() - t0);
      }
    }
    expect(worst).toBeLessThan(cpuBudget(5000));
  }, wallTimeout(300000));

  it("font names are file names only: no folder parts, drive, '..' or separator", async () => {
    for (const bad of ["../x.shx", "..\\..\\x.shx", "c:x.shx", "c:/x.shx", "a/b.shx", "*.shx", "a+b.shx", ".shx", "..shx", "x.ttf", "x\u0000.shx"]) expect(safeShxName(bad), bad).toBeNull();
    expect(safeShxName("Romans.SHX")).toBe("romans.shx");
    expect(safeShxName("@extfont2.shx")).toBe("@extfont2.shx");
    resetShxCache();
    const seen: string[] = [];
    const read = async (p: string) => (seen.push(p), null);
    // a document's family names (an .omw from anyone): a path in them is never read
    await loadShxFamilies([STROKE_SHX + "../../secret", STROKE_SHX + "c:/x/y", STROKE_SHX + "txt+../../z", STROKE_SHX + "a+b+c"], read);
    expect(seen).toEqual([]);
    // a style's font with folder parts: only its file name, in the folders tried
    const styles = new Map([["A", { name: "A", font: "..\\..\\..\\evil.shx", bigFont: "C:/Windows/../x/big.shx", height: 0, widthFactor: 1, oblique: 0 }]]);
    await loadDrawingShx({ styles } as never, "D:/work/dwg", ["D:/fonts"], read);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) expect(/^(D:\/work\/dwg|D:\/fonts|[A-Z]:\/(Program Files\/)?Autodesk\/AutoCAD 20\d\d\/Fonts)\/(evil|big)\.shx$/.test(p), p).toBe(true);
  });

  it("each path is read once; a font missing for one drawing is still found next to another", async () => {
    resetShxCache();
    const seen: string[] = [];
    const bytes = unifont({ 0x41: [1, 0x84, 0] });
    const read = async (p: string) => (seen.push(p), /^E:\/b\/myshape\.shx$/i.test(p) ? bytes : null);
    const styles = new Map(
      Array.from({ length: 30 }, (_, i): [string, object] => [`S${i}`, { name: `S${i}`, font: "myshape.shx", height: 0, widthFactor: 1, oblique: 0 }]),
    );
    expect(await loadDrawingShx({ styles } as never, "E:/a", [], read)).toEqual([]);
    const first = seen.length;
    expect(await loadDrawingShx({ styles } as never, "E:/a", [], read)).toEqual([]);
    expect(seen.length).toBe(first); // nothing read again
    expect(await loadDrawingShx({ styles } as never, "E:/b", [], read)).toEqual(["myshape"]);
    expect(seen.filter((p) => /myshape/i.test(p) && p.startsWith("E:/b")).length).toBe(1);
  });

  it("PDF: SHX text is drawn as lines over a blank-glyph text layer; Omni Stroke text stays a font", async () => {
    const f = parseShx(unifont({ 0x41: [1, 0x84, 0x8c, 2, 0x80, 0], 0x42: [1, 0x48, 0x84, 2, 0x80, 0], 0x20: [2, 0x60, 0] }), "qapdf.shx")!;
    registerShxPair("qapdf", { main: f as ShxFont, big: null });
    const { exportPdfVector } = await import("../../src/io/pdfVector");
    const { newDocument, newText } = await import("../../src/core/types");
    const { PDFDocument, PDFDict, PDFName, PDFRawStream } = await import("pdf-lib");
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const make = async (family: string) => {
      const doc = newDocument();
      const t = newText("AB BA");
      t.paragraphs[0].runs[0].fontFamily = family;
      doc.pages[0].nodes = [t];
      const pdf = await PDFDocument.load(await exportPdfVector(doc, doc.pages, { fonts }));
      const raw = pdf.context.enumerateIndirectObjects().map(([, o]) => o);
      const streams = raw.filter((o): o is InstanceType<typeof PDFRawStream> => o instanceof PDFRawStream).map((s) => {
        try {
          return Buffer.from(inflateSync(Buffer.from(s.contents)));
        } catch {
          return Buffer.from(s.contents);
        }
      });
      const fontFiles = raw
        .filter((o): o is InstanceType<typeof PDFDict> => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("FontDescriptor"))
        .map((d) => pdf.context.lookup(d.get(PDFName.of("FontFile2"))) as InstanceType<typeof PDFRawStream>)
        .map((s) => (fontkit as any).create(Buffer.from(inflateSync(Buffer.from(s.contents)))));
      const content = streams.map((b) => b.toString("latin1")).join("\n");
      return { content, fontFiles };
    };
    const shx = await make(STROKE_SHX + "qapdf");
    expect(shx.content).toMatch(/3 Tr/);
    expect(shx.content).toMatch(/\bS\b/);
    expect(shx.fontFiles.length).toBe(1);
    // (a subset: glyphs by number, no character map) — every glyph blank, the advances kept
    const blank = shx.fontFiles[0];
    expect(blank.numGlyphs).toBeGreaterThan(2);
    for (let i = 0; i < blank.numGlyphs; i++) expect(blank.getGlyph(i).path.commands.length).toBe(0);
    expect(Array.from({ length: blank.numGlyphs }, (_, i) => blank.getGlyph(i).advanceWidth)).toContain(Math.round(strokeAdvance("A", "shx:qapdf") * 1000));
    const plain = await make("Omni Stroke");
    expect(plain.content).not.toMatch(/3 Tr/);
    const pf = plain.fontFiles[0];
    expect(Array.from({ length: pf.numGlyphs }, (_, i) => pf.getGlyph(i).path.commands.length).some((n) => n > 3)).toBe(true);
  });
});
