import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { layoutTable } from "../../src/core/table";
import { localBounds, nodeHash } from "../../src/core/loom";
import { newPage, newTable, type TableNode } from "../../src/core/types";
import { collectTables, detectDelimiter, exportCsv, importCsv, parseCsv, toCsv } from "../../src/io/formats/csv";
import { cuesFromPages, exportSrt, formatTime, importSrt, parseSrt, parseTime } from "../../src/io/formats/srt";
import { colName, exportXlsx, importXlsx, parseRef, parseXlsx, serialToText } from "../../src/io/formats/xlsx";
import { decodeText } from "../../src/io/formats/textcodec";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const u8 = (s: string) => new TextEncoder().encode(s);
const tables = (pages: { nodes: any[] }[]) => pages.flatMap((p) => p.nodes.filter((n) => n.type === "TABLE")) as TableNode[];

describe("TABLE node", () => {
  it("lays out rows that grow with wrapped text, and has stable bounds/hash", () => {
    const t = newTable([["이름", "설명"], ["a", "아주 긴 설명 문장이 여러 줄로 줄바꿈되어야 합니다 아주 긴 설명 문장"]], [80, 90]);
    const l = layoutTable(t);
    expect(l.width).toBe(170);
    expect(l.rowY[2] - l.rowY[1]).toBeGreaterThan(t.rowHeight);
    expect(localBounds(t)).toEqual({ x: 0, y: 0, w: 170, h: l.height });
    const copy = { ...t, rows: t.rows.map((r) => r.map((c) => ({ ...c }))) };
    expect(nodeHash(copy)).toBe(nodeHash(t));
    const edited = { ...t, rows: [t.rows[0], [{ text: "b" }, t.rows[1][1]]] };
    expect(nodeHash(edited)).not.toBe(nodeHash(t));
  });
});

describe("CSV", () => {
  it("parses quotes, embedded newlines and detects delimiters", () => {
    expect(parseCsv('a,"b,c","d ""q"""\n1,"x\ny",3\n')).toEqual([["a", "b,c", 'd "q"'], ["1", "x\ny", "3"]]);
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(toCsv([["a,b", 'q"'], ["1", "2"]])).toBe('"a,b","q"""\r\n1,2\r\n');
  });

  it("import → edit → export round trip, long tables split across pages with header repeated", () => {
    const rows = [["번호", "이름"], ...Array.from({ length: 120 }, (_, i) => [String(i + 1), `사람 ${i + 1}`])];
    const { pages, rows: n } = importCsv(u8("﻿" + toCsv(rows)), "명단.csv");
    expect(n).toBe(121);
    expect(pages.length).toBeGreaterThan(1);
    const ts = tables(pages);
    expect(ts.every((t) => t.rows[0][0].text === "번호")).toBe(true);
    expect(collectTables(pages)[0].rows).toHaveLength(121);
    const out = exportCsv(pages);
    const d = decodeText(out);
    expect(d.bom).toBe(true);
    expect(parseCsv(d.text)).toEqual(rows);
  });
});

describe("SRT", () => {
  const SRT = "1\r\n00:00:01,000 --> 00:00:02,500\r\n안녕하세요\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n두 줄\r\n자막\r\n";
  it("parses and formats time codes", () => {
    expect(parseTime("01:02:03,045")).toBe(3723045);
    expect(formatTime(3723045)).toBe("01:02:03,045");
    expect(parseSrt(SRT)).toEqual([
      { start: 1000, end: 2500, text: "안녕하세요" },
      { start: 3000, end: 4000, text: "두 줄\n자막" },
    ]);
  });
  it("opens as a cue table and saves back (renumbered, CRLF kept)", () => {
    const { pages } = importSrt(u8(SRT), "a.srt");
    const t = tables(pages)[0];
    expect(t.rows[1].map((c) => c.text)).toEqual(["1", "00:00:01,000", "00:00:02,500", "안녕하세요"]);
    const out = new TextDecoder().decode(exportSrt(pages));
    expect(out).toContain("\r\n");
    expect(parseSrt(out)).toEqual(parseSrt(SRT));
    const broken = { ...t, rows: [...t.rows, [{ text: "3" }, { text: "xx" }, { text: "yy" }, { text: "틀림" }]] };
    const pg = { ...pages[0], nodes: [broken] };
    expect(cuesFromPages([pg]).bad).toEqual([3]);
    expect(() => exportSrt([pg])).toThrow(/3번/);
  });
});

describe("XLSX", () => {
  it("cell refs and date serials", () => {
    expect(colName(0)).toBe("A");
    expect(colName(27)).toBe("AB");
    expect(parseRef("AB12")).toEqual({ row: 11, col: 27 });
    expect(serialToText(45658, false, "yyyy-mm-dd")).toBe("2025-01-01");
  });

  it("export → import keeps sheets, text, numbers, formulas, bold and widths", () => {
    const p1 = newPage("DOCUMENT");
    p1.source = { format: "xlsx", name: "a.xlsx" };
    const t = newTable(
      [
        [{ text: "품목" }, { text: "수량" }, { text: "합계" }],
        [{ text: "사과 & 배" }, { text: "3", align: "RIGHT" }, { text: "6", formula: "B2*2", align: "RIGHT" }],
        [{ text: "<특가>", bold: true }, { text: "0012" }, { text: "" }],
      ],
      [120, 80, 90],
      "재고",
    );
    p1.nodes.push(t);
    const p2 = newPage("DOCUMENT");
    p2.source = { format: "xlsx", name: "a.xlsx" };
    p2.nodes.push(newTable([["x"], ["1"]], [60], "둘째"));
    const bytes = exportXlsx([p1, p2]);
    const sheets = parseXlsx(bytes);
    expect(sheets.map((s) => s.name)).toEqual(["재고", "둘째"]);
    const r = sheets[0].rows;
    expect(r[1].map((c) => c.text)).toEqual(["사과 & 배", "3", "6"]);
    expect(r[1][2].formula).toBe("B2*2");
    expect(r[2][0]).toMatchObject({ text: "<특가>", bold: true });
    expect(r[2][1].text).toBe("0012"); // leading zero kept as text
    expect(r[0][0].bold).toBe(true); // header row
    expect(sheets[0].colWidths[0]).toBeCloseTo(120, -1);
    const { pages } = importXlsx(bytes, "a.xlsx");
    expect(tables(pages).map((x) => x.name)).toEqual(["재고", "둘째"]);
  });
});
