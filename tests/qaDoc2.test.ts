// QA doc-gaps-2: defects found in review (Word-native DOCX values, 한글 자간 → Word spacing, list numbering
// across text nodes, legacy lists with Tab, paragraph dialog patches).
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { changeListLevel, paraText, renumber, renumberAfter, toggleList } from "../src/core/richtext";
import { graphemes, measure, runFont } from "../src/core/text";
import { DEFAULT_RUN, newPage, newParagraph, newText, type Page, type TextParagraph } from "../src/core/types";
import { absoluteSpacing, exportDocx, parseDocx } from "../src/io/office";
import { paraDialogPatch } from "../src/ui/shell/paraDialogPatch";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const P = (text: string, extra: Partial<TextParagraph> = {}): TextParagraph => ({ ...newParagraph(text), ...extra });
const texts = (ps: TextParagraph[]) => ps.map(paraText);

/** A minimal DOCX with the given w:p elements in its body. */
function docx(body: string): Uint8Array {
  const pg = newPage("DOCUMENT", 794, 1123, "P");
  const t = newText("x", 600);
  pg.nodes.push(t);
  const files = unzipSync(exportDocx([pg]));
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  files["word/document.xml"] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zipSync(files);
}
const pageOf = (paras: TextParagraph[]): Page => {
  const pg = newPage("DOCUMENT", 794, 1123, "P");
  const t = newText("", 600);
  t.paragraphs = paras;
  pg.nodes.push(t);
  return pg;
};

describe("DOCX line spacing: Word's own multiple is written back as it was", () => {
  it("w:line (lineRule auto) of an imported paragraph survives import → export verbatim", () => {
    for (const [line, font, text] of [
      [480, "Pretendard", "Omni report"],
      [259, "맑은 고딕", "가나다 보고서"],
      [276, "Calibri", "Quarterly"],
      [360, "Arial", "Arial text"],
    ] as const) {
      const xml = `<w:p><w:pPr><w:spacing w:after="160" w:line="${line}" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
      const ps = parseDocx(docx(xml));
      const out = strFromU8(unzipSync(exportDocx([pageOf(ps)]))["word/document.xml"]);
      expect(out, `${font} ${line}`).toContain(`w:line="${line}" w:lineRule="auto"`);
    }
  });

  it("a lineSpacing changed outside the Word multiple (an older app) is converted again (the Word value no longer applies)", () => {
    const xml = `<w:p><w:pPr><w:spacing w:line="480" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Pretendard" w:hAnsi="Pretendard"/></w:rPr><w:t>abc</w:t></w:r></w:p>`;
    const ps = parseDocx(docx(xml));
    ps[0] = { ...ps[0], lineSpacing: 1.2 };
    const out = strFromU8(unzipSync(exportDocx([pageOf(ps)]))["word/document.xml"]);
    expect(out).not.toContain('w:line="480"');
    expect(out).toContain('w:line="186" w:lineRule="auto"'); // 1.2 × size ÷ Pretendard's single line 1.551 (measured in Word) × 240
  });
});

describe("한글 자간 → Word w:spacing (one absolute value per run)", () => {
  it("is the run's total extra advance spread over every character, spaces included (Word spaces get it too)", () => {
    const r = { ...DEFAULT_RUN, fontSize: 14, text: "Omni 분기 보고서 The same", spacingPct: -5 };
    const n = graphemes(r.text).length;
    const want = (measure(r.text, runFont(r)) / n) * -0.05;
    expect(absoluteSpacing(r)).toBeCloseTo(want, 6);
  });
});

describe("list numbers across text nodes", () => {
  it("renumberAfter renumbers the next node when the edited node has no list items any more", () => {
    const l = { id: "L", def: "decimal", level: 0 };
    const a = newText("", 400);
    a.paragraphs = renumber([P("a", { list: l }), P("b", { list: l })]).paras;
    a.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
    const b = newText("", 400);
    b.paragraphs = renumber([P("c", { list: l })], { seed: renumber(a.paragraphs).seed }).paras;
    b.transform = { x: 0, y: 500, rotation: 0, scale: 1 };
    const pg = newPage("DOCUMENT", 794, 1123, "P");
    pg.nodes.push(a, b);
    expect(texts(b.paragraphs)).toEqual(["3. c"]);
    // the list is removed from the first box: the second box starts at 1
    a.paragraphs = [P("a"), P("b")];
    renumberAfter([pg], a.id);
    expect(texts((pg.nodes[1] as typeof b).paragraphs)).toEqual(["1. c"]);
  });
});

describe("Tab in an older one-level numbered list", () => {
  it("the items after the indented one keep counting (the whole list becomes multi-level)", () => {
    const ps = toggleList([P("a"), P("b"), P("c"), P("d")], 0, 3, "oli").paras;
    expect(texts(ps)).toEqual(["1. a", "2. b", "3. c", "4. d"]);
    const r = changeListLevel(ps, 1, 1, 1)!;
    expect(texts(r.paras)).toEqual(["1. a", "a. b", "2. c", "3. d"]);
  });
});

describe("paragraph dialog: only what the user changed is applied", () => {
  const init = { align: undefined, left: 28.4, right: 0, firstMode: "hanging" as const, first: 18, before: 0, after: 6, mode: "exact" as const, mult: 1.08, pct: 160, pts: 18, keepNext: false, keepLines: false, breakBefore: false };
  it("untouched dialog → empty patch (mixed alignment and original units are kept)", () => {
    expect(paraDialogPatch(init, { ...init }, 16)).toEqual({});
  });
  it("a changed field alone is patched", () => {
    expect(paraDialogPatch(init, { ...init, after: 12 }, 16)).toEqual({ spaceAfter: 16 });
    expect(Object.keys(paraDialogPatch(init, { ...init, align: "CENTER" }, 16))).toEqual(["align"]);
  });
  it("line spacing: mode or value changed → line height and the nearest multiple", () => {
    // 배수 is Word's multiple; % of the size is the 한글-style mode (core/lineSpacing.ts)
    expect(paraDialogPatch(init, { ...init, mode: "multiple", mult: 2 }, 16)).toEqual({ lineMultiple: 2, lineHeight: null });
    expect(paraDialogPatch(init, { ...init, mode: "percent", pct: 200 }, 16)).toEqual({ lineSpacing: 2, lineHeight: null, lineMultiple: null });
  });
});

describe("doc-features sample: the values 한글 2024 and Word showed (RESULTS 2026-11-12) stay exact", () => {
  const hwpxVals = (bytes: Uint8Array) => {
    const h = strFromU8(unzipSync(bytes)["Contents/header.xml"]);
    return ['lineSpacing type="FIXED" value="1800"', 'lineSpacing type="PERCENT" value="200"', '<hc:prev value="1400"', '<hc:right value="6000"', 'ratio hangul="90"', 'spacing hangul="-5"'].filter((s) => !h.includes(s));
  };
  it("HWPX: FIXED 1800, PERCENT 200, prev 1400, right 6000, ratio 90, spacing −5 — in the sample and after import → export", async () => {
    const { readFileSync } = await import("node:fs");
    const { parseHwpx, exportHwpx } = await import("../src/io/office");
    const src = new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.hwpx"));
    expect(hwpxVals(src)).toEqual([]);
    expect(hwpxVals(exportHwpx([pageOf(parseHwpx(src))], "t"))).toEqual([]);
  });
  it("DOCX: exact 18 pt (360), before / after 280, right 1200, w:w 90 — in the sample and after import → export", async () => {
    const { readFileSync } = await import("node:fs");
    const vals = (bytes: Uint8Array) => {
      const d = strFromU8(unzipSync(bytes)["word/document.xml"]);
      return ['w:line="360" w:lineRule="exact"', 'w:before="280"', 'w:right="1200"', '<w:w w:val="90"/>'].filter((s) => !d.includes(s));
    };
    const src = new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx"));
    expect(vals(src)).toEqual([]);
    const ps = parseDocx(src);
    const out = exportDocx([pageOf(ps)]);
    expect(vals(out)).toEqual([]);
    // every Word line multiple of the sample is written back as it was
    const lines = (b: Uint8Array) => (strFromU8(unzipSync(b)["word/document.xml"]).match(/w:line="\d+" w:lineRule="auto"/g) ?? []).sort();
    // (paragraphs without w:line in the source are Word's single, 240)
    expect([...new Set(lines(out))].filter((l) => !lines(src).includes(l) && !l.startsWith('w:line="240"'))).toEqual([]);
  });
});

describe("vector PDF: 한글 자간 text stays searchable", { timeout: 30_000 }, () => {
  it("the spaces between words are in the text (a run with spacingPct is drawn character by character)", async () => {
    const { readFileSync } = await import("node:fs");
    const { pathToFileURL } = await import("node:url");
    const { exportPdfVector } = await import("../src/io/pdfVector");
    const { newDocument } = await import("../src/core/types");
    const pdfjs: any = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const pg = newPage("DOCUMENT", 794, 1123, "P");
    const t = newText("", 600);
    t.paragraphs = [{ ...P(""), runs: [{ ...DEFAULT_RUN, text: "분기 보고서 Quarterly report", spacingPct: -5, hscale: 90 }] }];
    t.transform = { x: 60, y: 80, rotation: 0, scale: 1 };
    pg.nodes.push(t);
    const doc = newDocument("t");
    doc.pages = [pg];
    const bytes = await exportPdfVector(doc, [pg], { fonts });
    const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
    const items = (await (await d.getPage(1)).getTextContent()).items.map((x: any) => x.str).join("");
    await d.destroy();
    expect(items.replace(/\s+/g, " ")).toContain("분기 보고서 Quarterly report");
  });
});
