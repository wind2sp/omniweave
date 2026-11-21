// XLS formulas decoded from their tokens (io/sheet/readXls.ts decodeFormula) against the formula text Excel itself shows
// for the same .xls (Range.Formula after it opened the file again; qa/interop/scripts/xls_formula_make.ps1, hidden Excel):
//   excel-made/omni-xls-formulas.xls(+.excel.json)  operators and their precedence, percent and unary signs, quoted text,
//   booleans and errors, relative / absolute / whole-row and -column references, other sheets and 3-D references,
//   unions and intersections (ptgMemFunc / ptgMemArea), IF / CHOOSE / SUM (ptgAttr), array constants, names, shared
//   and array formulas, Excel 2007 functions, references to a deleted column.
// Spaces outside strings are not compared (ptgAttrSpace is not kept: the formula means the same).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addr } from "../../src/io/sheet/formula";
import { readXls } from "../../src/io/sheet/readXls";

/** a formula without its spaces outside strings and without the _xlfn. prefixes (both sides) */
export function norm(f: string): string {
  let out = "", q = false;
  for (const ch of f.replace(/_xlfn\./gi, "")) {
    if (ch === '"') q = !q;
    if (!q && /\s/.test(ch)) continue;
    out += ch;
  }
  return out;
}

const FILES = ["qa/interop/excel-made/omni-xls-formulas.xls"];

describe("XLS formulas as Excel shows them", () => {
  for (const f of FILES)
    it(f, () => {
      const want = JSON.parse(readFileSync(f + ".excel.json", "utf8").replace(/^﻿/, "")) as Record<string, string>;
      const { sheets } = readXls(new Uint8Array(readFileSync(f)), "en");
      const bad: string[] = [];
      let n = 0;
      for (const [k, w] of Object.entries(want)) {
        const m = /^(.*)!R(\d+)C(\d+)$/.exec(k)!;
        const sh = sheets.find((s) => s.name === m[1])!;
        const a = addr(Number(m[2]) - 1, Number(m[3]) - 1);
        const cell = sh.cells[a];
        if (w.startsWith("{")) {
          // an array formula: its text on its first cell, the others are filled by it
          if (cell?.f !== undefined) {
            n++;
            if (!cell.cse || norm("=" + cell.f) !== norm(w.slice(1))) bad.push(`${k} ${a}: ${cell.f} ≠ ${w}`);
          } else if (!cell?.sp) bad.push(`${k} ${a}: not part of an array`);
          continue;
        }
        n++;
        if (cell?.f === undefined || norm("=" + cell.f) !== norm(w)) bad.push(`${k} ${a}: ${cell?.f} ≠ ${w}`);
      }
      expect(bad).toEqual([]);
      expect(n).toBeGreaterThan(100);
    });
});
