// CSV saved as it was read (표 계산 부서, 2026-11-16 측정 결함 2~4 · CSV ① 다른 15칸):
// unedited → byte for byte (encoding, BOM, delimiter, line ends, final line end, each field's quotes, CR LF inside a cell);
// one cell edited → only its line changes; new cells and rows follow the file's own habits.
// Shown like Excel (dates typed as text, "=1+2"), saved as the file's text.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Page, TableNode } from "../../src/core/types";
import { collectTables, exportCsv, importCsv } from "../../src/io/formats/csv";
import { encodeText } from "../../src/io/formats/textcodec";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const tables = (pages: Page[]) => pages.flatMap((p) => p.nodes.filter((n) => n.type === "TABLE")) as TableNode[];
/** the cell (row, col) of the joined table, edited in its page node */
function setCell(pages: Page[], r: number, c: number, text: string) {
  let left = r;
  for (const t of tables(pages)) {
    const body = t === tables(pages)[0] ? t.rows : t.rows.slice(t.headerRow ? 1 : 0);
    const off = t === tables(pages)[0] ? 0 : t.headerRow ? 1 : 0;
    if (left < body.length) {
      t.rows[left + off][c] = { ...t.rows[left + off][c], text };
      return;
    }
    left -= body.length;
  }
  throw new Error("no cell");
}
const lines = (s: string) => s.split(/(?<=\r\n|\n|\r(?!\n))/);

const DIR = "qa/interop/csv";
const REPO = readdirSync(DIR).filter((f) => f.endsWith(".csv")).map((f) => join(DIR, f));
const SEMI = 'name;amount;memo\r\n"Kim, J";1200;"line ""quoted"""\r\n이;300;\r\n';

describe("CSV — unedited save is the original", () => {
  for (const f of REPO)
    it(`byte for byte: ${f}`, () => {
      const bytes = new Uint8Array(readFileSync(f));
      const { pages } = importCsv(bytes, f.split("/").pop()!, { year: 2026 });
      expect(Buffer.from(exportCsv(pages)).equals(Buffer.from(bytes))).toBe(true);
    });

  it("public sample: semicolon file whose fields chose their own quotes", () => {
    const { pages } = importCsv(enc(SEMI), "sample-semicolon.csv");
    expect(dec(exportCsv(pages))).toBe(SEMI);
  });

  for (const [label, src] of [
    ["LF line ends, no final line end", "a,b\n1,2\n3,4"],
    ["LF line ends with a final line end", "a,b\n1,2\n"],
    ["CR LF inside a quoted cell, LF between rows", 'a,b\n"x\r\ny",2\n'],
    ["LF inside a quoted cell, CR LF between rows", 'a,b\r\n"x\ny",2\r\n'],
    ["mixed quoting in one column", 'a,b\r\n"1",2\r\n3,"4"\r\n'],
    ["ragged rows and trailing blank lines", "a,b,c\r\n1\r\n2,3\r\n\r\n\r\n"],
    ["a quoted field with text after the closing quote", 'a,b\r\n"x"y,2\r\n'],
    ["old Mac CR line ends", "a,b\r1,2\r"],
  ] as const)
    it(label, () => {
      const { pages } = importCsv(enc(src), "x.csv");
      expect(dec(exportCsv(pages))).toBe(src);
    });

  it("CP949 without BOM stays CP949", () => {
    const src = encodeText("이름,값\r\n가,1\r\n", { encoding: "euc-kr" });
    const { pages } = importCsv(src, "k.csv");
    expect(Buffer.from(exportCsv(pages)).equals(Buffer.from(src))).toBe(true);
  });
});

describe("CSV — one cell edited: only its line changes", () => {
  for (const f of REPO)
    it(f, () => {
      const bytes = new Uint8Array(readFileSync(f));
      const { pages } = importCsv(bytes, f.split("/").pop()!, { year: 2026 });
      setCell(pages, 1, 0, collectTables(pages)[0].rows[1][0].text + "~");
      const out = exportCsv(pages);
      // same encoding: compare as latin1 so CP949 bytes line up too
      const a = lines(Buffer.from(bytes).toString("latin1")), b = lines(Buffer.from(out).toString("latin1"));
      expect(b.length).toBe(a.length);
      const changed = a.map((x, i) => (x === b[i] ? -1 : i)).filter((i) => i >= 0);
      expect(changed).toEqual([1]);
      expect(b[1].replace(/\r?\n$|\r$/, "")).toMatch(/~$|~(?=[;,])/);
    });

  it("the edited row keeps the other fields' quotes and its own line end", () => {
    const { pages } = importCsv(enc(SEMI), "s.csv");
    setCell(pages, 2, 1, "301");
    expect(dec(exportCsv(pages))).toBe('name;amount;memo\r\n"Kim, J";1200;"line ""quoted"""\r\n이;301;\r\n');
  });

  it("an edited cell that was quoted stays quoted; a new line inside a cell uses the file's style", () => {
    const src = 'a,b\n"x\r\ny","q"\n1,2';
    const { pages } = importCsv(enc(src), "x.csv");
    setCell(pages, 1, 1, "r");
    setCell(pages, 2, 0, "p\nq");
    expect(dec(exportCsv(pages))).toBe('a,b\n"x\r\ny","r"\n"p\r\nq",2');
  });

  it("a new row follows the file: its line end, no final line end added, quoted columns stay quoted", () => {
    const src = '"id","name"\n"1","a"';
    const { pages } = importCsv(enc(src), "x.csv");
    const t = tables(pages)[tables(pages).length - 1];
    t.rows.push([{ text: "2" }, { text: "b" }]);
    expect(dec(exportCsv(pages))).toBe('"id","name"\n"1","a"\n"2","b"');
  });

  it("a deleted row drops only its line", () => {
    const src = "a,b\r\n1,2\r\n3,4\r\n5,6\r\n";
    const { pages } = importCsv(enc(src), "x.csv");
    const t = tables(pages)[0];
    t.rows.splice(2, 1);
    expect(dec(exportCsv(pages))).toBe("a,b\r\n1,2\r\n5,6\r\n");
  });
});

describe("CSV — shown like Excel, saved as written", () => {
  const src = "날짜,값\r\n2026/1/2,=1+2\r\n11/16,=A2\r\n2026-13-40,=SUM(1\r\n2026년 1월 2일,=foo(1)\r\n";
  it("dates typed as text and formulas show Excel's text; the file's text is saved", () => {
    const { pages } = importCsv(enc(src), "d.csv", { year: 2026 });
    const g = collectTables(pages)[0].rows;
    expect(g.slice(1).map((r) => r[0].text)).toEqual(["2026-01-02", "11월 16일", "2026-13-40", "2026년 01월 02일"]);
    expect(g[1][1]).toMatchObject({ text: "3", formula: "1+2" });
    expect(g[2][1].text).toBe("46024"); // =A2 → the date's serial number, General format (as Excel shows it)
    expect(g[3][1].text).toBe("=SUM(1"); // not a formula Excel can read: kept as text
    expect(g[4][1].text).toBe("=foo(1)"); // a function Omniweave does not know: the file's text
    expect(dec(exportCsv(pages))).toBe(src);
  });

  it("editing another cell of that row keeps the formula and the date as written", () => {
    const { pages } = importCsv(enc(src), "d.csv", { year: 2026 });
    setCell(pages, 1, 0, "2026-01-03");
    expect(dec(exportCsv(pages))).toBe(src.replace("2026/1/2,", "2026-01-03,"));
  });
});
