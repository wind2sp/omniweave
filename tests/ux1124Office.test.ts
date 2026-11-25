// 기본 작업 사용성 점검 2026-11-24 — 표 · 슬라이드 · PDF.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// the fallback font the PDF writer embeds for new text, from the repository (the app unpacks its .ttpack)
vi.mock("../src/io/pretendard", async (orig) => ({ ...((await orig()) as object), pretendardTtf: async () => new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")) }));
import { tableToSheet } from "../src/io/sheet/pages";
import { autoSumFormula } from "../src/ui/sheet/sheetActions";
import { PDFDocument } from "pdf-lib";
import { unzlibSync } from "fflate";
import { newDocument, newText } from "../src/core/types";
import { importPdf, saveSameTypePdf } from "../src/io/pdf";
import { isTransparentCss } from "../src/io/pdfsurgeon/write";
import { textBetween } from "../src/ui/pdf/textMark";

describe("표: 자동 합계 (Alt+=) reads the numbers above as Excel does", () => {
  const sheet = () => {
    const sh = tableToSheet("S", [[{ text: "Qty" }], [{ text: "" }], [{ text: "" }], [{ text: "" }], [{ text: "" }]], [80]);
    sh.cells.A2 = { v: 3 };
    sh.cells.A3 = { f: "A2*2", v: undefined as unknown as number }; // a formula whose result is not worked out yet
    sh.cells.A4 = { v: "2" as unknown as number }; // a number kept as text
    return sh;
  };
  it("formulas and numeric text count (the range used to stop at the first of them)", () => {
    expect(autoSumFormula(sheet(), 4, 0)).toBe("=SUM(A2:A4)");
  });
  it("a blank or a label stops it", () => {
    const sh = sheet();
    sh.cells.A3 = { v: "Total" as unknown as number };
    expect(autoSumFormula(sh, 4, 0)).toBe("=SUM(A4:A4)");
  });
});

describe("PDF: OCR's text layer stays hidden when the PDF is saved in its own format (mobile ux-audit #8)", () => {
  it("a transparent text run is written with Tr 3 (invisible), not painted black", async () => {
    expect(isTransparentCss("#00000000")).toBe(true);
    expect(isTransparentCss("#000000")).toBe(false);
    const src = await PDFDocument.create();
    src.addPage([300, 200]);
    const { asset, pages } = await importPdf(await src.save(), "omni-scan.pdf");
    const doc = newDocument("scan");
    doc.assets[asset.id] = asset;
    doc.pages = pages;
    const layer = newText("Scan QA", 200, { color: "#00000000", fontSize: 16 });
    layer.locked = true;
    pages[0].nodes.push(layer);
    const out = await saveSameTypePdf(doc, pages[0], () => true);
    const s = Buffer.from(out).toString("latin1");
    const streams: string[] = [];
    for (const m of s.matchAll(/stream\r?\n/g)) {
      const e = s.indexOf("endstream", m.index!);
      const raw = out.subarray(m.index! + m[0].length, e);
      try {
        streams.push(Buffer.from(unzlibSync(raw)).toString("latin1"));
      } catch {
        streams.push(Buffer.from(raw).toString("latin1"));
      }
    }
    const text = streams.find((x) => /\bTj\b/.test(x))!;
    expect(text).toMatch(/3 Tr/);
    expect(text).not.toMatch(/\b0 Tr\b/);
  });
});
describe("PDF: text dragged over is copied in reading order (Acrobat's text select)", () => {
  const items = [
    { str: "Underline", x0: 72, x1: 130, y0: 630, y1: 642 },
    { str: "밑줄을", x0: 134, x1: 170, y0: 630, y1: 642 },
    { str: "Strike", x0: 72, x1: 110, y0: 600, y1: 612 },
    { str: "out", x0: 114, x1: 132, y0: 600, y1: 612 },
  ];
  it("one line: the words from the press to the release", () => {
    expect(textBetween(items, [72, 636], [170, 636])).toBe("Underline 밑줄을");
  });
  it("two lines: the rest of the first and the start of the next, a line break between", () => {
    expect(textBetween(items, [134, 636], [132, 606])).toBe("밑줄을\nStrike out");
  });
});