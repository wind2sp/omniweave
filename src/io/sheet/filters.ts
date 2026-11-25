// The AutoFilters of a sheet: the sheet's own (데이터 ▸ 필터, Ctrl+Shift+L) and each Excel table's (a table with a
// header row always has its filter buttons). `table` names the table; absent = the sheet's own filter.

import type { SheetData, SheetFilter } from "../../core/sheetTypes";

export interface FilterAt {
  /** the table's name, or undefined for the sheet's own AutoFilter */
  table?: string;
  f: SheetFilter;
}

/** Every AutoFilter on the sheet (the sheet's first, then the tables'). */
export function sheetFilters(sh: SheetData): FilterAt[] {
  const out: FilterAt[] = sh.filter ? [{ f: sh.filter }] : [];
  for (const t of sh.tables ?? []) if (!t.noHeader && t.filter) out.push({ table: t.name, f: t.filter });
  return out;
}

/** The AutoFilter of a table (by name) or the sheet's own. */
export function filterOf(sh: SheetData, table?: string): SheetFilter | undefined {
  if (!table) return sh.filter;
  return sh.tables?.find((t) => t.name === table)?.filter;
}

/** A table's filter range: the table without its totals row ("A1:C9" with a totals row → "A1:C8"). */
export function tableFilterRef(ref: string, totals?: boolean): string {
  return totals ? ref.replace(/(\d+)$/, (n) => String(Number(n) - 1)) : ref;
}
