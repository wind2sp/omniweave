// Omni Stroke (docs/design/CAD_IMPORT.md §5.4): the run-time TrueType font is well formed (a TrueType parser reads it
// back: tables, character map, outlines, advances) and the widths the importer uses are the font's own.
import fontkit from "@pdf-lib/fontkit";
import { describe, expect, it } from "vitest";
import { STROKE_FAMILY, strokeAdvance, strokeFontTtf, strokeHas } from "../../src/io/formats/cad/strokeFont";

describe("Omni Stroke", () => {
  const ttf = strokeFontTtf(["가", "힣", "분", "기", "보", "고", "서", "똠", "뷁"]);
  const font = (fontkit as any).create(ttf as any);

  it("is a TrueType font a parser reads back", () => {
    expect(font.familyName).toBe(STROKE_FAMILY);
    expect(font.unitsPerEm).toBe(1000);
    expect(font.capHeight).toBe(720);
    for (const ch of "AZaz09%@±°⌀가힣똠뷁ㄱㅢ") {
      const g = font.glyphForCodePoint(ch.codePointAt(0)!);
      expect(g.id, ch).toBeGreaterThan(0);
      expect(g.path.commands.length, ch).toBeGreaterThan(3);
    }
    // a character it does not have: none (the fallback font draws it)
    expect(font.glyphForCodePoint("漢".codePointAt(0)!).id).toBe(0);
    expect(strokeHas("A") && strokeHas("뷁") && !strokeHas("漢")).toBe(true);
  });

  it("has the advances the importer measures with", () => {
    const run = font.layout("Omni 1,234.5");
    // (font units are whole numbers)
    expect(run.advanceWidth / 1000).toBeCloseTo(strokeAdvance("Omni 1,234.5"), 2);
    // capitals stand 0.72 em tall (the cap ratio of the drawing text)
    const H = font.glyphForCodePoint(72).bbox;
    expect(H.maxY - H.minY).toBeGreaterThan(720);
    expect(H.maxY - H.minY).toBeLessThan(720 + 70);
  });

  it("is embedded in the vector PDF for drawing text (no Pretendard stand-in)", async () => {
    const { readFileSync } = await import("node:fs");
    const { exportPdfVector } = await import("../../src/io/pdfVector");
    const { newDocument, newText } = await import("../../src/core/types");
    const doc = newDocument();
    const t = newText("Omni 분기 1,234.5");
    t.paragraphs[0].runs[0].fontFamily = "Omni Stroke Mono";
    doc.pages[0].nodes = [t];
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const warnings: string[] = [];
    const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
    const pdf = await PDFDocument.load(await exportPdfVector(doc, doc.pages, { fonts, onWarning: (w) => warnings.push(w) }));
    const names = pdf.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o): o is InstanceType<typeof PDFDict> => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Font") && !!o.get(PDFName.of("BaseFont")))
      .map((o) => String(o.get(PDFName.of("BaseFont"))));
    expect(names.some((n) => n.includes("OmniStrokeMono-Regular"))).toBe(true);
    expect(names.some((n) => n.includes("Pretendard"))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("slants the italic face 15°", () => {
    const it = (fontkit as any).create(strokeFontTtf([], true) as any);
    const a = it.glyphForCodePoint(73).bbox; // I: a vertical stroke leans right by tan 15° × its height
    expect(a.maxX - a.minX - 56).toBeCloseTo(720 * Math.tan((15 * Math.PI) / 180), -1);
  });
});
