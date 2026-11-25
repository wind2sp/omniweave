// Excel tables (ListObjects) made here — 삽입 ▸ 표 / Ctrl+T: their table parts (xl/tables/tableN.xml), the sheet's
// relationships and <tableParts>, for a fresh workbook and for a sheet saved into its original package. Tables the
// file already had are kept by the surgery as they were (their header edits: officesurgeon/xlsxTables.ts).
// ECMA-376 Part 1 §18.5. Omniweave's own implementation.

import type { SheetData, SheetTable } from "../../core/sheetTypes";
import { esc } from "../xml";
import { filterColumnXml, placeChildren } from "./writeParts";
import type { PkgRels } from "./writeDrawings";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";
const TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml";

/** A table's <autoFilter> (its filter range and the values shown per column); "" for a table without a header. */
function autoFilterXml(t: SheetTable, px = ""): string {
  if (t.noHeader) return "";
  const fref = t.filter?.ref ?? (t.totals ? t.ref.replace(/\d+$/, (n) => String(Number(n) - 1)) : t.ref);
  const fcols = Object.entries(t.filter?.cols ?? {})
    .filter(([, v]) => (v.vals || v.custom) && !v.other)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, v]) => filterColumnXml("", k, v))
    .join("");
  return fcols ? `<${px}autoFilter ref="${fref}">${fcols.replace(/<(\/?)(filterColumn|filters|filter)\b/g, `<$1${px}$2`)}</${px}autoFilter>` : `<${px}autoFilter ref="${fref}"/>`;
}

/** The table part of one table (id unique in the workbook). */
export function tableXml(t: SheetTable, id: number): string {
  const cols = t.cols.map((c, i) => `<tableColumn id="${i + 1}" name="${esc(c)}"/>`).join("");
  const af = autoFilterXml(t);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="${esc(t.name)}" displayName="${esc(t.name)}" ref="${t.ref}"${t.noHeader ? ' headerRowCount="0"' : ""}${t.totals ? ' totalsRowCount="1"' : ' totalsRowShown="0"'}>` +
    `${af}<tableColumns count="${t.cols.length}">${cols}</tableColumns>` +
    `<tableStyleInfo name="${esc(t.style ?? "TableStyleMedium2")}" showFirstColumn="${t.firstCol ? 1 : 0}" showLastColumn="${t.lastCol ? 1 : 0}" showRowStripes="${t.rowStripes === false ? 0 : 1}" showColumnStripes="${t.colStripes ? 1 : 0}"/></table>`
  );
}

/** The highest table id in the package (ids are unique across the workbook). */
function maxTableId(pkg: PkgRels): number {
  let max = 0;
  for (let n = 1; n <= 512; n++) {
    const x = pkg.getPart(`xl/tables/table${n}.xml`);
    if (x == null) continue;
    const id = Number(/<(?:\w+:)?table\b[^>]*\sid="(\d+)"/.exec(x)?.[1] ?? 0);
    if (id > max) max = id;
  }
  return max;
}

/**
 * The tables of `sh` that are not in the original sheet `o` (all of them for a fresh sheet), written as table parts
 * with their relationships; the worksheet's <tableParts> lists the old ones and the new ones.
 */
export function writeNewTables(xml: string, sh: SheetData, o: SheetData | null, pkg: PkgRels, ids?: Map<string, number>): string {
  const had = new Set((o?.tables ?? []).map((t) => t.name.toLowerCase()));
  const add = (sh.tables ?? []).filter((t) => !had.has(t.name.toLowerCase()));
  for (const t of sh.tables ?? []) if (t.id != null) ids?.set(t.name, t.id);
  // tables of the file whose AutoFilter changed here (a table slicer's pick, the header's filter buttons): written into their parts
  for (const t of sh.tables ?? []) {
    const was = o?.tables?.find((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (!was || JSON.stringify(was.filter ?? null) === JSON.stringify(t.filter ?? null)) continue;
    for (const r of pkg.rels(pkg.part)) {
      if (!/table$/.test(r.type)) continue;
      const tx = pkg.getPart(r.target);
      if (!tx || !tx.includes(` displayName="${esc(t.name)}"`)) continue;
      const tpx = /<(\w+:)?table\b/.exec(tx)?.[1] ?? "";
      const el = autoFilterXml(t, tpx);
      const cur = /<((?:\w+:)?autoFilter)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/.exec(tx);
      pkg.setPart(r.target, cur ? tx.slice(0, cur.index) + el + tx.slice(cur.index + cur[0].length) : tx.replace(/(<(?:\w+:)?tableColumns\b)/, `${el}$1`));
    }
  }
  if (!add.length) return xml;
  let id = maxTableId(pkg);
  // the relationships namespace on the root (a worksheet written without one)
  if (!/^[\s\S]*?<(?:\w+:)?worksheet\b[^>]*\sxmlns:r=/.test(xml.slice(0, xml.indexOf(">", xml.search(/<(?:\w+:)?worksheet\b/)) + 1)))
    xml = xml.replace(/<((?:\w+:)?worksheet)\b/, '<$1 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
  const px = /^<\?xml[^>]*>\s*<(\w+:)?worksheet\b/.exec(xml)?.[1] ?? /<(\w+:)?worksheet\b/.exec(xml)?.[1] ?? "";
  const old = /<((?:\w+:)?tableParts)\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1>)/.exec(xml);
  const parts = old?.[2] ? [...old[2].matchAll(/<(?:\w+:)?tablePart\b[^>]*\/>/g)].map((m) => m[0]) : [];
  for (const t of add) {
    const path = pkg.freeName((n) => `xl/tables/table${n}.xml`);
    pkg.setPart(path, tableXml(t, ++id), TYPE);
    ids?.set(t.name, id);
    const rid = pkg.addRel(pkg.part, REL, path);
    parts.push(`<${px}tablePart r:id="${rid}"/>`);
  }
  return placeChildren(xml, "tableParts", [`<${px}tableParts count="${parts.length}">${parts.join("")}</${px}tableParts>`]);
}
