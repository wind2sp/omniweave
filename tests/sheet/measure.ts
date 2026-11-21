// Excel fidelity measure (docs/design/FIDELITY_XLSX.md): an Excel-made workbook next to Excel's own dump of it
// (qa/interop/scripts/xlsx_fidelity_make.ps1 → *.truth.json: shown text, value, formula of every cell, column widths,
// row heights) compared with what Omniweave reads, shows and calculates. Used by tests/sheet/fidelity.test.ts and
// scripts/fidelity-xlsx.mjs.

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { readXlsx } from "../../src/io/sheet/read";
import { formatValue } from "../../src/io/sheet/numfmt";
import { addr } from "../../src/io/sheet/formula";
import { recalcAll } from "../../src/io/sheet/calc";
import { openSheetBook, saveSheetBook } from "../../src/io/sheet/book";

export interface TruthCell {
  r: number;
  c: number;
  text: string;
  value: number | string | boolean | null;
  t: "n" | "s" | "b" | "e";
  f: string | null;
}
interface Truth {
  sheets: { name: string; cells: TruthCell[]; cols: { c: number; px: number; hidden: boolean }[]; rows: { r: number; px: number; hidden: boolean }[] }[];
}

const ERR_CODES: Record<number, string> = { [-2146826281]: "#DIV/0!", [-2146826246]: "#N/A", [-2146826259]: "#NAME?", [-2146826288]: "#NULL!", [-2146826252]: "#NUM!", [-2146826265]: "#REF!", [-2146826273]: "#VALUE!" };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export interface Score {
  text: { ok: number; total: number; misses: string[] };
  colW: { exact: number; total: number; meanAbs: number; misses: string[] };
  rowH: { exact: number; total: number; meanAbs: number };
  formula: { ok: number; total: number; misses: string[] };
  preserve: { same: boolean; bytes: number };
}

export function measure(xlsxPath: string, truthPath: string, lang: "ko" | "en" = "ko"): Score {
  (globalThis as any).DOMParser ??= DOMParser;
  const bytes = new Uint8Array(readFileSync(xlsxPath));
  const truth: Truth = JSON.parse(readFileSync(truthPath, "utf8").replace(/^﻿/, ""));
  const { sheets } = readXlsx(bytes, lang);
  const sc: Score = {
    text: { ok: 0, total: 0, misses: [] },
    colW: { exact: 0, total: 0, meanAbs: 0, misses: [] },
    rowH: { exact: 0, total: 0, meanAbs: 0 },
    formula: { ok: 0, total: 0, misses: [] },
    preserve: { same: false, bytes: bytes.length },
  };
  // calculated values: every formula recalculated from scratch (stored results ignored)
  const calc = sheets.map((s) => ({ ...s, cells: Object.fromEntries(Object.entries(s.cells).map(([k, c]) => [k, c.f ? { ...c, v: undefined, t: undefined } : c])) }));
  recalcAll(calc);
  let colAbs = 0, rowAbs = 0;
  for (const ts of truth.sheets) {
    const sh = sheets.find((s) => s.name === ts.name);
    const cs = calc.find((s) => s.name === ts.name);
    if (!sh || !cs) continue;
    for (const tc of ts.cells) {
      const a = addr(tc.r - 1, tc.c - 1);
      const cell = sh.cells[a];
      if (tc.text && !/^#+$/.test(tc.text)) {
        sc.text.total++;
        const v = cell?.v ?? null;
        const got = formatValue(v, sh.styles[cell?.s ?? 0]?.fmt, { lang, date1904: sh.date1904 }).text;
        if (norm(got) === norm(tc.text)) sc.text.ok++;
        else sc.text.misses.push(`${ts.name}!${a} [${sh.styles[cell?.s ?? 0]?.fmt ?? "General"}] ${JSON.stringify(v)} → "${got}" ≠ "${tc.text}"`);
      }
      // functions Excel 2016 does not have (XLOOKUP…): #NAME? there, not a fault of the engine
      if (tc.f && !(tc.t === "e" && ERR_CODES[tc.value as number] === "#NAME?")) {
        sc.formula.total++;
        const got = cs.cells[a];
        const want = tc.t === "e" ? ERR_CODES[tc.value as number] ?? String(tc.value) : tc.value;
        const gv = got?.v ?? null;
        let ok: boolean;
        if (typeof want === "number" && typeof gv === "number") ok = Math.abs(want - gv) <= 1e-9 * Math.max(1, Math.abs(want));
        else ok = (want ?? "") === (gv ?? "") || (want == null && gv === 0);
        if (ok) sc.formula.ok++;
        else sc.formula.misses.push(`${ts.name}!${a} =${tc.f.replace(/^=/, "")} → ${JSON.stringify(gv)} ≠ ${JSON.stringify(want)}`);
      }
    }
    for (const col of ts.cols) {
      const c = col.c - 1;
      const got = sh.hiddenCols?.includes(c) ? 0 : sh.colW[c] ?? sh.defColW;
      sc.colW.total++;
      const d = Math.abs(got - col.px);
      colAbs += d;
      if (d <= 1) sc.colW.exact++;
      else sc.colW.misses.push(`${ts.name} ${col.c}: ${got} ≠ ${col.px}`);
    }
    for (const row of ts.rows) {
      const r = row.r - 1;
      const got = sh.hiddenRows?.includes(r) ? 0 : sh.rowH[r] ?? sh.defRowH;
      sc.rowH.total++;
      const d = Math.abs(got - row.px);
      rowAbs += d;
      if (d <= 1) sc.rowH.exact++;
    }
  }
  sc.colW.meanAbs = sc.colW.total ? colAbs / sc.colW.total : 0;
  sc.rowH.meanAbs = sc.rowH.total ? rowAbs / sc.rowH.total : 0;
  // no-edit round trip: opened and saved without a change → the same bytes
  const opened = openSheetBook(bytes, "omni.xlsx", lang);
  const saved = saveSheetBook(opened.pages, () => {
    throw new Error("fresh save");
  });
  sc.preserve.same = saved.length === bytes.length && saved.every((b, i) => b === bytes[i]);
  return sc;
}
