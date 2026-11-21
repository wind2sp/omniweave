// XLSX dates/percent/currency as numbers with number formats; PPTX character formats (a:rPr).

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { newDocument, newPage, newTable, newText, type TableNode, type TextNode } from "../../src/core/types";
import { cellNumber, dateSerial, exportXlsx, importXlsx, serialToText } from "../../src/io/formats/xlsx";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe("XLSX numbers", () => {
  it("1900 date system: serial 1 = 1900-01-01, 60 = the fake 1900-02-29, 61 = 1900-03-01", () => {
    expect(dateSerial(1900, 1, 1)).toBe(1);
    expect(dateSerial(1900, 2, 28)).toBe(59);
    expect(dateSerial(1900, 2, 29)).toBe(60);
    expect(dateSerial(1900, 3, 1)).toBe(61);
    expect(dateSerial(2026, 11, 11)).toBe(46337);
    expect(dateSerial(2026, 2, 30)).toBeNull();
    expect(dateSerial(1899, 12, 31)).toBeNull();
    for (const [v, t] of [[1, "1900-01-01"], [59, "1900-02-28"], [60, "1900-02-29"], [61, "1900-03-01"], [46337, "2026-11-11"]] as const)
      expect(serialToText(v, false, "yyyy-mm-dd")).toBe(t);
  });

  it("cell text → number + format", () => {
    expect(cellNumber({ text: "2026-11-11" })).toEqual({ v: "46337", fmt: "yyyy-mm-dd" });
    expect(cellNumber({ text: "2026-11-11 12:00" })).toEqual({ v: "46337.5", fmt: "yyyy-mm-dd hh:mm" });
    expect(cellNumber({ text: "06:00" })).toEqual({ v: "0.25", fmt: "h:mm" });
    expect(cellNumber({ text: "12.5%" })).toEqual({ v: "0.125", fmt: "0.0%" });
    expect(cellNumber({ text: "12.5%", numFmt: "0.00%" })).toEqual({ v: "0.125", fmt: "0.00%" });
    expect(cellNumber({ text: "1200", numFmt: '"₩"#,##0' })).toEqual({ v: "1200", fmt: '"₩"#,##0' });
    expect(cellNumber({ text: "007" })).toBeNull();
    expect(cellNumber({ text: "2026-13-01" })).toBeNull();
    expect(cellNumber({ text: "abc" })).toBeNull();
  });

  it("dates, percentages and currency are written as numbers with their format and read back the same", () => {
    const page = newPage("DOCUMENT");
    const t = newTable([
      [{ text: "날짜" }, { text: "비율" }, { text: "금액" }, { text: "일시" }],
      [{ text: "2026-11-11" }, { text: "12.5%" }, { text: "1200", numFmt: '"₩"#,##0' }, { text: "1900-02-29" }],
      [{ text: "2024-02-29", numFmt: "mm-dd-yy" }, { text: "50%", numFmt: "0.00%" }, { text: "-3.5", numFmt: "#,##0.00" }, { text: "2026-01-02 03:04:05" }],
    ]);
    page.nodes.push(t);
    const bytes = exportXlsx([page]);
    const files = unzipSync(bytes);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    const styles = strFromU8(files["xl/styles.xml"]);
    expect(sheet).toContain("<v>46337</v>");
    expect(sheet).toContain("<v>0.125</v>");
    expect(sheet).toContain("<v>60</v>");
    expect(sheet).not.toContain("2026-11-11");
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
    expect(styles).toContain('formatCode="&quot;₩&quot;#,##0"');
    expect(styles).toMatch(/<xf numFmtId="14"/); // built-in date format kept as built-in
    expect(styles).toMatch(/<xf numFmtId="10"/); // 0.00%
    const back = importXlsx(bytes, "n.xlsx").pages[0].nodes.find((n): n is TableNode => n.type === "TABLE")!;
    expect(back.rows.map((r) => r.map((c) => c.text))).toEqual(t.rows.map((r) => r.map((c) => c.text)));
    expect(back.rows[1][2].numFmt).toBe('"₩"#,##0');
    expect(back.rows[2][1].numFmt).toBe("0.00%");
    // and once more: the second save is identical
    expect(strFromU8(unzipSync(exportXlsx([{ ...page, nodes: [back] }]))["xl/worksheets/sheet1.xml"])).toBe(sheet);
  });
});

describe("PPTX character formats", () => {
  it("strike, superscript/subscript, highlight and letter spacing round-trip through a:rPr", async () => {
    const doc = newDocument("t");
    const s = newPage("SLIDE", 1280, 720, "s");
    const tx = newText("", 800, { fontSize: 32 });
    const base = tx.paragraphs[0].runs[0];
    tx.paragraphs[0].runs = [
      { ...base, text: "취소 ", strike: true },
      { ...base, text: "x" },
      { ...base, text: "2", script: "super" },
      { ...base, text: " H" },
      { ...base, text: "2", script: "sub" },
      { ...base, text: " 형광", highlight: "#FFFF00" },
      { ...base, text: " 자간", letterSpacing: 4 },
    ];
    s.nodes.push(tx);
    doc.pages = [s];
    const { bytes } = await exportPptx(doc, doc.pages);
    const xml = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]);
    expect(xml).toContain('strike="sngStrike"');
    expect(xml).toContain('baseline="30000"');
    expect(xml).toContain('baseline="-25000"');
    expect(xml).toContain('<a:highlight><a:srgbClr val="FFFF00"/></a:highlight>');
    expect(xml).toContain('spc="300"');
    const back = importPptx(bytes, "t.pptx").pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    const runs = back.paragraphs[0].runs;
    const pick = (t: string) => runs.find((r) => r.text === t)!;
    expect(pick("취소 ").strike).toBe(true);
    expect(runs.filter((r) => r.text === "2").map((r) => r.script)).toEqual(["super", "sub"]);
    expect(pick(" 형광").highlight).toBe("#FFFF00");
    expect(pick(" 자간").letterSpacing).toBeCloseTo(4, 1);
    expect(pick("x").strike).toBeUndefined();
  });
});

describe("XLSX column width and PPTX transitions", () => {
  it("stored column width = pixels ÷ the default font's max digit width (맑은 고딕 11pt: 8px), padding included", () => {
    const page = newPage("DOCUMENT");
    page.nodes.push(newTable([[{ text: "a" }, { text: "b" }]], [64, 130]));
    const bytes = exportXlsx([page]);
    const sheet = strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]);
    expect(sheet).toContain('width="8"'); // 64px ÷ 8
    expect(sheet).toContain('width="16.25"'); // 130px ÷ 8
    expect(importXlsx(bytes, "w.xlsx").sheets[0].colWidths).toEqual([64, 130]);
  });

  it("only slides with a transition get p:transition, and opening keeps 'none'", async () => {
    const doc = newDocument("t");
    const a = newPage("SLIDE", 1280, 720, "a"), b = newPage("SLIDE", 1280, 720, "b");
    a.transition = { type: "NONE", duration: 400 };
    doc.pages = [a, b];
    const { bytes } = await exportPptx(doc, doc.pages);
    const files = unzipSync(bytes);
    expect(strFromU8(files["ppt/slides/slide1.xml"])).not.toContain("p:transition");
    expect(strFromU8(files["ppt/slides/slide2.xml"])).toContain("<p:fade/>");
    expect(importPptx(bytes, "t.pptx").pages.map((p) => p.transition.type)).toEqual(["NONE", "FADE"]);
  });
});
