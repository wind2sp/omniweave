// Excel tables (ListObjects, ECMA-376 Part 1 §18.5) and array formula ranges of a worksheet, for the sheet reader
// (read.ts): table definitions feed structured references (Table1[Col]); cells inside an array formula's range are
// marked as filled by it. Omniweave's own implementation.

import type { SheetData, SheetFilter, SheetTable } from "../../core/sheetTypes";
import { attr, children, descendants, parseXml } from "../xml";
import { addr, parseRange } from "./formula";

/** Tables of a worksheet part: its relationships of type …/table → xl/tables/tableN.xml. */
export function readTables(read: (path: string) => string | undefined, sheetPart: string): SheetTable[] {
  const relsXml = read(sheetPart.replace(/([^/]+)$/, "_rels/$1.rels"));
  if (!relsXml) return [];
  const dir = sheetPart.slice(0, sheetPart.lastIndexOf("/") + 1);
  const out: SheetTable[] = [];
  for (const rel of descendants(parseXml(relsXml), "Relationship")) {
    if (!/\/table$/.test(attr(rel, "Type") ?? "")) continue;
    const target = attr(rel, "Target") ?? "";
    const parts: string[] = [];
    for (const seg of (target.startsWith("/") ? target.slice(1) : dir + target).split("/")) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    }
    const xml = read(parts.join("/"));
    if (!xml) continue;
    const root = parseXml(xml).documentElement;
    const ref = attr(root, "ref");
    if (!ref || !parseRange(ref)) continue;
    const cols = descendants(root, "tableColumns").flatMap((tc) => children(tc, "tableColumn")).map((c) => attr(c, "name") ?? "");
    const t: SheetTable = { name: attr(root, "displayName") ?? attr(root, "name") ?? "", ref, cols };
    if (attr(root, "headerRowCount") === "0") t.noHeader = true;
    const id = Number(attr(root, "id"));
    if (id > 0) t.id = id;
    if (Number(attr(root, "totalsRowCount") ?? 0) > 0) t.totals = true;
    const af = children(root, "autoFilter")[0];
    if (af && attr(af, "ref")) {
      const cols: NonNullable<SheetFilter["cols"]> = {};
      for (const fc of children(af, "filterColumn")) {
        const id = Number(attr(fc, "colId"));
        const fs = children(fc, "filters")[0];
        const cf = children(fc, "customFilters")[0];
        if (fs && !cf) cols[id] = { vals: children(fs, "filter").map((x) => attr(x, "val") ?? ""), ...(attr(fs, "blank") === "1" ? { blank: true } : {}) };
        else if (cf) cols[id] = { custom: { ...(attr(cf, "and") === "1" ? { and: true } : {}), items: children(cf, "customFilter").map((x) => ({ op: (attr(x, "operator") ?? "equal") as "equal", val: attr(x, "val") ?? "" })) } };
        else cols[id] = { other: true };
      }
      t.filter = { ref: attr(af, "ref")!, ...(Object.keys(cols).length ? { cols } : {}) };
    }
    const si = descendants(root, "tableStyleInfo")[0];
    if (si) {
      const name = attr(si, "name");
      if (name) t.style = name;
      if (attr(si, "showRowStripes") === "0") t.rowStripes = false;
      if (attr(si, "showColumnStripes") === "1") t.colStripes = true;
      if (attr(si, "showFirstColumn") === "1") t.firstCol = true;
      if (attr(si, "showLastColumn") === "1") t.lastCol = true;
    }
    if (t.name) out.push(t);
  }
  return out;
}

/** Mark the cells covered by array formulas (`spill` on their anchor) as filled by them (`sp`). */
export function markSpills(sh: SheetData) {
  for (const [a, cell] of Object.entries(sh.cells)) {
    if (!cell.spill || !cell.f) continue;
    const g = parseRange(cell.spill);
    if (!g || (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) > 1_000_000) continue;
    for (let r = g.r0; r <= g.r1; r++)
      for (let c = g.c0; c <= g.c1; c++) {
        const b = addr(r, c);
        const x = sh.cells[b];
        if (b !== a && x && !x.f) x.sp = a;
      }
  }
}
