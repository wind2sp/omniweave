// 데이터 표 (What-If ▸ Data Table): the results of a data table worked out again from its inputs — each result cell is
// the table's formula calculated with the input cell(s) set to that row's / column's input (Excel's TABLE()).
// Used after edits and F9 so that a table follows its inputs as in Excel.
import type { SheetData } from "../../core/sheetTypes";
import type { SheetLang } from "./numfmt";
import { addr, parseRange } from "./formula";
import { applyChange, Book } from "./calc";

/** The values every data table of the book should show now (sheet index, cell, value), at most `cap` cells. */
export function dataTableValues(sheets: SheetData[], lang: SheetLang, cap = 400): { si: number; a: string; v: number | string | boolean | undefined }[] {
  const out: { si: number; a: string; v: number | string | boolean | undefined }[] = [];
  // a big book: each result is a whole recalculation, so very large books keep the stored values (Excel's F9 does the same work)
  if (sheets.reduce((n, s) => n + Object.keys(s.cells).length, 0) > 20000) return out;
  sheets.forEach((sh, si) => {
    for (const cell of Object.values(sh.cells)) {
      const dt = cell.dt;
      const g = dt && parseRange(dt.ref);
      if (!dt || !g || g.r0 < 1 || g.c0 < 1) continue;
      const work = (sets: [string, unknown][], at: string) => {
        const copy = sheets.map((s) => JSON.parse(JSON.stringify(s)) as SheetData);
        for (const [a, v] of sets) copy[si].cells[a] = v === undefined || v === null ? {} : { v: v as number | string };
        const book = new Book(copy);
        book.lang = lang;
        for (const ch of book.recalc()) applyChange(copy[ch.sheet], ch);
        return copy[si].cells[at]?.v;
      };
      const val = (a: string) => sh.cells[a]?.v;
      for (let r = g.r0; r <= g.r1; r++)
        for (let c = g.c0; c <= g.c1; c++) {
          if (out.length >= cap) return;
          let v: unknown;
          if (dt.dt2D) v = work([[dt.r1, val(addr(g.r0 - 1, c))], [dt.r2 ?? "", val(addr(r, g.c0 - 1))]].filter(([a]) => !!a) as [string, unknown][], addr(g.r0 - 1, g.c0 - 1));
          else if (dt.dtr) v = work([[dt.r1, val(addr(g.r0 - 1, c))]], addr(r, g.c0 - 1));
          else v = work([[dt.r1, val(addr(r, g.c0 - 1))]], addr(g.r0 - 1, c));
          out.push({ si, a: addr(r, c), v: v as number | string | boolean | undefined });
        }
    }
  });
  return out;
}
