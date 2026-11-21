// QA (2026-11-16) for sheet-csv 86ece92 — CSV kept as read, shown like Excel, DATEVALUE / TIMEVALUE.
// Excel answers below were read from a new Excel 365 ko-KR instance (New-Object) on 2026-11-16.
//  1. A received CSV must not hang Omniweave when it opens: formulas are calculated only to show them, so text
//     functions keep Excel's 32,767-character limit and the calculation has a time budget.
//  2. Every edit reaches the file: after any mix of edits, inserted / deleted / moved rows (beyond the 64-row search
//     too) and inserted / deleted columns, reading the saved file gives the table's values.
//  3. A formula shown from the file is saved as the value shown once rows are inserted, deleted or moved (its relative
//     references would point elsewhere); with the rows in place it is saved as written.
//  4. 1900-02-29 is a date as in Excel (serial 60).
import { describe, expect, it } from "vitest";
import type { Page, SheetData } from "../../src/core/types";
import type { TableNode } from "../../src/core/types";
import { collectTables, exportCsv, importCsv, parseCsv } from "../../src/io/formats/csv";
import { decodeText, encodeText } from "../../src/io/formats/textcodec";
import { Book } from "../../src/io/sheet/calc";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const tables = (pages: Page[]) => pages.flatMap((p) => p.nodes.filter((n) => n.type === "TABLE")) as TableNode[];
const grid = (pages: Page[]) => collectTables(pages)[0].rows.map((r) => r.map((c) => c.text));

function calc(f: string): unknown {
  const sh = { book: "b", name: "S", cells: { A1: { f } }, styles: [{}], colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont: "Calibri", baseSize: 11, mdw: 7 } as unknown as SheetData;
  const b = new Book([sh]);
  b.now = () => Date.UTC(2026, 10, 16, 3);
  for (const ch of b.recalc()) Object.assign((sh.cells as any)[ch.addr], { v: ch.v });
  const v = (sh.cells as any).A1.v;
  return typeof v === "string" && v.length > 40 ? `len ${v.length}` : v;
}

describe("QA 1 — text length limit (Excel: 32,767 characters)", () => {
  // [formula, Excel 365 answer]
  const CASES: [string, unknown][] = [
    ['REPT("x",32767)', "len 32767"],
    ['REPT("x",32768)', "#VALUE!"],
    ['REPT("ab",16384)', "#VALUE!"],
    ['REPT("x",100000000)', "#VALUE!"],
    ['CONCAT(REPT("x",20000),REPT("x",20000))', "#VALUE!"],
    ['TEXTJOIN(",",1,REPT("x",20000),REPT("x",20000))', "#VALUE!"],
    ['SUBSTITUTE(REPT("x",20000),"x","yy")', "#VALUE!"],
    ['REPLACE(REPT("x",20000),1,1,REPT("y",20000))', "#VALUE!"],
    ['REPT("x",20000)&REPT("x",20000)', "len 32767"],
    ['CONCATENATE(REPT("x",20000),REPT("x",20000))', "len 32767"],
    ['LEN(REPT("x",32767)&"a")', 32767],
  ];
  for (const [f, want] of CASES) it(f, () => expect(calc(f)).toBe(want));

  it("a CSV whose formula would build a 100-million-character text opens at once and shows #VALUE! as Excel does", () => {
    const src = 'a,b\r\n1,"=SUBSTITUTE(REPT(""x"",30000),""x"",REPT(""y"",30000))"\r\n2,"=REPT(""x"",100000000)"\r\n';
    const t = performance.now();
    const { pages } = importCsv(enc(src), "x.csv", { year: 2026 });
    expect(performance.now() - t).toBeLessThan(3000);
    expect(grid(pages).slice(1).map((r) => r[1])).toEqual(["#VALUE!", "#VALUE!"]);
    expect(dec(exportCsv(pages))).toBe(src);
  });
});

describe("QA 1 — formulas get a time budget when a CSV opens", () => {
  it("2,000 rows of =SUM(C:C)·SUMPRODUCT: opens within the budget; formulas past it stay the file's text; saved as read", () => {
    let src = "id,name,amount,f\r\n";
    for (let i = 1; i <= 2000; i++) src += `${i},n${i},${i % 100},=SUMPRODUCT((C2:C2001>${i % 50})*C2:C2001)+SUM(C:C)\r\n`;
    const t = performance.now();
    const { pages } = importCsv(enc(src), "big.csv", { year: 2026 });
    expect(performance.now() - t).toBeLessThan(8000);
    const g = grid(pages);
    // the first formulas are shown as numbers (calculated within the budget)
    expect(g[1][3]).toMatch(/^\d+$/);
    expect(dec(exportCsv(pages))).toBe(src);
  });

  it("array generators (SEQUENCE, RANDARRAY, MMULT) are not calculated to show a CSV", () => {
    const src = 'a,b\r\n1,"=SUM(MMULT(SEQUENCE(3000,3000),SEQUENCE(3000,3000)))"\r\n2,"=SUM(SEQUENCE(4000,4000))"\r\n';
    const t = performance.now();
    const { pages } = importCsv(enc(src), "x.csv", { year: 2026 });
    expect(performance.now() - t).toBeLessThan(3000);
    expect(grid(pages)[1][1]).toBe("=SUM(MMULT(SEQUENCE(3000,3000),SEQUENCE(3000,3000)))");
  });

  it("a formula using one not calculated (unknown function) stays the file's text, not a number made from an empty cell", () => {
    const { pages } = importCsv(enc("a,b,c\r\n=foo(1),=A2+1,=B2*2\r\n=1+1,=A3+1,x\r\n"), "x.csv", { year: 2026 });
    expect(grid(pages)[1]).toEqual(["=foo(1)", "=A2+1", "=B2*2"]);
    expect(grid(pages)[2]).toEqual(["2", "3", "x"]);
  });

  it("no outside call: HYPERLINK / WEBSERVICE / DDE / INFO / CELL stay text, and no network or process API is touched", () => {
    const g = globalThis as any;
    const saved = g.fetch;
    let called = 0;
    g.fetch = () => {
      called++;
      throw new Error("no fetch");
    };
    try {
      const src = 'a,b\r\n1,"=HYPERLINK(""http://127.0.0.1/x"",""a"")"\r\n2,"=WEBSERVICE(""http://127.0.0.1/"")"\r\n3,=cmd|\' /C calc\'!A0\r\n4,"=INFO(""directory"")"\r\n5,"=CELL(""filename"")"\r\n6,"=FILTERXML(""<a/>"",""//a"")"\r\n7,=IMAGE("http://127.0.0.1/a.png")\r\n';
      const { pages } = importCsv(enc(src), "x.csv", { year: 2026 });
      const shown = grid(pages).slice(1).map((r) => r[1]);
      expect(shown.every((s) => s.startsWith("="))).toBe(true);
      expect(collectTables(pages)[0].rows.slice(1).every((r) => !r[1].formula)).toBe(true);
      expect(called).toBe(0);
      expect(dec(exportCsv(pages))).toBe(src);
    } finally {
      g.fetch = saved;
    }
  });
});

// deterministic random
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("QA 2 — no edit is lost (random edits, row / column operations, beyond the 64-row search)", () => {
  const make = (rand: () => number, n: number) => {
    const words = ["a", "b", "Kim, J", 'say "hi"', "x\r\ny", "", "1200", "0012", " lead", "가나", "a;b"];
    let s = '"id","name",memo\r\n';
    for (let i = 0; i < n; i++) {
      const w = () => words[Math.floor(rand() * words.length)];
      const q = (v: string) => (rand() < 0.5 || /[",\r\n]|^\s/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      s += [q(String(i % 7)), q(w()), q(w())].join(",") + (rand() < 0.1 ? "\n" : "\r\n");
    }
    return s;
  };
  const OPS = ["edit", "insertRow", "deleteRow", "deleteMany", "moveRow", "sortByName", "dupRow", "insertCol", "deleteCol", "clearRow", "editToNeighbour"] as const;
  for (let seed = 1; seed <= 60; seed++)
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const src = make(rand, 40 + Math.floor(rand() * 200));
      const { pages } = importCsv(enc(src), "r.csv", { year: 2026 });
      // work on one table of all rows (a CSV over several pages is joined when saved)
      const all = collectTables(pages)[0].rows.map((r) => r.map((c) => ({ ...c })));
      const ops: string[] = [];
      for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
        const op = OPS[Math.floor(rand() * OPS.length)];
        ops.push(op);
        const r = 1 + Math.floor(rand() * (all.length - 1));
        const w = all[0].length;
        if (op === "edit") all[r][Math.floor(rand() * w)].text += "~" + seed;
        else if (op === "insertRow") all.splice(r, 0, Array.from({ length: w }, (_, j) => ({ text: j ? `new${seed}` : "" })));
        else if (op === "deleteRow" && all.length > 2) all.splice(r, 1);
        else if (op === "deleteMany" && all.length > 90) all.splice(r > all.length - 80 ? 1 : r, 75);
        else if (op === "moveRow") all.splice(Math.min(all.length, 1 + Math.floor(rand() * (all.length - 1))), 0, ...all.splice(r, 1));
        else if (op === "sortByName") all.splice(1, all.length - 1, ...all.slice(1).sort((a, b) => (a[1].text < b[1].text ? -1 : a[1].text > b[1].text ? 1 : 0)));
        else if (op === "dupRow") all.splice(r, 0, all[r].map((c) => ({ ...c })));
        else if (op === "insertCol") for (const row of all) row.splice(1, 0, { text: row === all[0] ? "added" : "" });
        else if (op === "deleteCol" && w > 1) for (const row of all) row.splice(w - 1, 1);
        else if (op === "clearRow") all[r] = all[r].map((c) => ({ ...c, text: "" }));
        else if (op === "editToNeighbour" && r + 1 < all.length) all[r] = all[r + 1].map((c) => ({ ...c }));
      }
      // the table as one page node holding every row
      const t0 = tables(pages)[0];
      t0.rows = all;
      for (const p of pages) p.nodes = p.nodes.filter((n) => n.type !== "TABLE" || n === t0);
      const saved = dec(exportCsv(pages));
      const back = parseCsv(saved, ",").map((r) => r.map((v) => v.replace(/\r\n?/g, "\n")));
      // trailing blank rows are not table rows (the file may keep its own blank lines at the end)
      while (back.length && back[back.length - 1].every((v) => v === "")) back.pop();
      const want = all.map((r) => r.map((c) => c.text));
      while (want.length && want[want.length - 1].every((v) => v === "")) want.pop();
      const pad = (rows: string[][]) => rows.map((r) => { const x = [...r]; while (x.length && x[x.length - 1] === "") x.pop(); return x; });
      expect(pad(back), ops.join(",")).toEqual(pad(want));
    });
});

describe("QA 2 — a deleted column leaves no empty field behind", () => {
  it("the last column deleted: no trailing delimiter, also on rows whose deleted field was empty", () => {
    const { pages } = importCsv(enc("h,v,w\r\na,1,\r\nb,2,x\r\n"), "c.csv");
    for (const r of tables(pages)[0].rows) r.splice(2, 1);
    expect(dec(exportCsv(pages))).toBe("h,v\r\na,1\r\nb,2\r\n");
  });
  it("a ragged row stays as short as it was when another cell is edited", () => {
    const { pages } = importCsv(enc("a,b,c\r\n1\r\n2,3\r\n"), "c.csv");
    tables(pages)[0].rows[1][0].text = "9";
    expect(dec(exportCsv(pages))).toBe("a,b,c\r\n9\r\n2,3\r\n");
  });
});

describe("QA 3 — a formula after rows were inserted / deleted / moved is saved as its shown value", () => {
  const src = "x\r\n5\r\n=A2*10\r\n";
  it("rows in place: the formula as written", () => {
    const { pages } = importCsv(enc(src), "f.csv", { year: 2026 });
    expect(grid(pages)[2][0]).toBe("50");
    tables(pages)[0].rows[0][0].text = "y";
    expect(dec(exportCsv(pages))).toBe("y\r\n5\r\n=A2*10\r\n");
  });
  it("a row above deleted: =A2*10 would now point at itself in Excel — the value shown (50) is saved", () => {
    const { pages } = importCsv(enc(src), "f.csv", { year: 2026 });
    tables(pages)[0].rows.splice(1, 1);
    expect(grid(pages)[1][0]).toBe("50");
    expect(dec(exportCsv(pages))).toBe("x\r\n50\r\n");
  });
  it("a row inserted above: the value shown is saved", () => {
    const { pages } = importCsv(enc(src), "f.csv", { year: 2026 });
    tables(pages)[0].rows.splice(1, 0, [{ text: "new" }]);
    expect(dec(exportCsv(pages))).toBe("x\r\nnew\r\n5\r\n50\r\n");
  });
});

describe("QA 4 — 1900-02-29 (Excel's 1900 leap-year bug)", () => {
  it("DATEVALUE: 1900-02-28 → 59, 1900-02-29 → 60, 29-Feb-1900 → 60, 1900-03-01 → 61", () => {
    expect(calc('DATEVALUE("1900-02-28")')).toBe(59);
    expect(calc('DATEVALUE("1900-02-29")')).toBe(60);
    expect(calc('DATEVALUE("29-Feb-1900")')).toBe(60);
    expect(calc('DATEVALUE("1900-03-01")')).toBe(61);
    expect(calc('DATEVALUE("1901-02-29")')).toBe("#VALUE!");
  });
  it("a CSV with 1900-02-29 shows it as a date (Excel: 60, yyyy-mm-dd) and =A2+1 as 61", () => {
    const { pages } = importCsv(enc("d,f\r\n1900/2/29,=A2+1\r\n"), "x.csv", { year: 2026 });
    expect(grid(pages)[1]).toEqual(["1900-02-29", "61"]);
  });
});

describe("QA 5 — encodings: kept and edited", () => {
  for (const [label, encoding, bom] of [["UTF-16LE with BOM", "utf-16le", true], ["UTF-16BE with BOM", "utf-16be", true], ["CP949", "euc-kr", false], ["UTF-8 BOM", "utf-8", true]] as const)
    it(label, () => {
      const text = "이름\t값\r\n\"가, 나\"\t1\r\n다\t2026/1/2\r\n";
      const bytes = encodeText(text, { encoding, bom });
      const { pages } = importCsv(bytes, "k.tsv", { year: 2026 });
      expect(Buffer.from(exportCsv(pages)).equals(Buffer.from(bytes))).toBe(true);
      tables(pages)[0].rows[2][0].text = "라";
      const out = exportCsv(pages);
      const d = decodeText(out);
      expect(d.encoding).toBe(encoding);
      expect(d.bom).toBe(bom);
      expect(d.raw).toBe(text.replace("다\t", "라\t"));
    });
});
