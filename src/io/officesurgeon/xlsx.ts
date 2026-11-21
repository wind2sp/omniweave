// Office Surgeon — XLSX: rewrite only the changed cells of each worksheet.
//
// Design: docs/design/OFFICE_SURGEON.md §5. The edit unit is a cell. Each sheet keeps, from import, a hash per
// row of its table; on save a row whose hash still matches is not touched at all, and in a changed row only the
// cells whose value differs from the original are written (keeping the cell's style index `s`). Text is written
// as an inline string, so sharedStrings.xml stays as it was. Values changed → workbook calcPr fullCalcOnLoad so
// Excel recalculates; a formula removed → calcChain.xml dropped (Excel rebuilds it). Styles, themes, charts,
// pictures, pivots, defined names, protection and every other entry are copied byte for byte.

import { strFromU8 } from "fflate";
import { getBlob } from "../../core/assets";
import { hashString } from "../../core/hash";
import type { OfficeSourceMeta, OfficeSourcePart, Page, TableCell } from "../../core/types";
import { t } from "../../i18n";
import { readingOrder } from "../formats/flow";
import { cellNumber, colName, isDateFormat, parseRef, parseXlsx, xmlCellText as esc, type Sheet } from "../formats/xlsx";
import { cellFp, ENGINE_VERSION } from "./common";
import { saveSheetSurgical } from "../sheet/book";
import { SurgeryUnavailable, type SurgeryResult } from "./docx";
import { childrenOf, rootOf, type XmlEl } from "./scan";
import { entryData, readZip, rewriteZip, type ZipArchive } from "./zip";
import { TableEdits } from "./xlsxTables";

const tn = (key: string, n: number) => t(n === 1 ? `${key}_one` : key, { n });
const rowHash = (r: TableCell[]) => hashString(r.map(cellFp).join(","));
/** what a cell holds, without its look (bold / italic / alignment / fill cannot be written without new styles) */
const valueKey = (c: TableCell | undefined) => JSON.stringify([c?.text ?? "", c?.formula ?? null]);
const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * Tables of the pages by sheet name: consecutive chunks of one sheet (split across pages) are joined again,
 * each continuation dropping its repeated header row — whatever that header now says (an edited first header
 * row must not stop the join). A sheet name appearing apart twice cannot be matched.
 */
function sheetTables(pages: Page[]): Map<string, { name: string; rows: TableCell[][] }> {
  const out = new Map<string, { name: string; rows: TableCell[][] }>();
  let last: string | null = null;
  for (const n of readingOrder(pages)) {
    if (n.type !== "TABLE") continue;
    const cur = out.get(n.name);
    if (cur && last === n.name) cur.rows.push(...(n.headerRow ? n.rows.slice(1) : n.rows));
    else if (cur) throw new SurgeryUnavailable("table name");
    else out.set(n.name, { name: n.name, rows: [...n.rows] });
    last = n.name;
  }
  return out;
}

/** Block map of a freshly imported workbook (one part per sheet that became a table). */
export function xlsxMeta(pages: Page[], sheets: Sheet[], asset: { id: string; hash: string }): OfficeSourceMeta | null {
  let tables: ReturnType<typeof sheetTables>;
  try {
    tables = sheetTables(pages);
  } catch {
    return null;
  }
  const parts: OfficeSourcePart[] = [];
  for (const sh of sheets) {
    if (!sh.rows.length) continue;
    const tb = tables.get(sh.name);
    if (!tb || tb.rows.length !== sh.rows.length) return null;
    parts.push({ part: sh.part, blocks: [], tables: [sh.name], rows: tb.rows.map(rowHash) });
  }
  return parts.length ? { engine: ENGINE_VERSION, assetId: asset.id, hash: asset.hash, parts } : null;
}

export function saveXlsxSurgical(pages: Page[], meta: OfficeSourceMeta): SurgeryResult {
  // sheet pages (the grid model, io/sheet): cell by cell from the sheet models; table pages (older .omw): below
  if (pages.some((p) => p.sheet)) return saveSheetSurgical(pages, meta);
  if (meta.engine !== ENGINE_VERSION) throw new SurgeryUnavailable("engine");
  const orig = getBlob(meta.hash);
  if (!orig) throw new SurgeryUnavailable("asset");
  const zip = readZip(orig);
  if (!zip) throw new SurgeryUnavailable("zip");
  // a macro workbook / template saved under .xlsx would not open (its content type says otherwise): written anew
  const types = zip.entries.find((e) => e.name === "[Content_Types].xml");
  if (types && /macroEnabled|\.template\.main/.test(strFromU8(entryData(zip, types)))) throw new SurgeryUnavailable("package type");
  const tables = sheetTables(pages);
  // every table must still be one of the original sheets, and every original sheet still there
  const names = new Set(meta.parts.map((p) => p.tables?.[0] ?? ""));
  if (tables.size !== names.size || [...tables.keys()].some((n) => !names.has(n))) throw new SurgeryUnavailable("sheets");
  const origSheets = new Map(parseXlsx(orig).map((s) => [s.part, s]));
  const styles = cellFormats(zip);
  const enc = new TextEncoder();
  const changed = new Map<string, Uint8Array>();
  let looks = 0;
  let reshaped = 0;
  let formulaGone = false;
  let formulaValues = 0;
  // header cells of Excel tables (their column names) and totals row labels: officesurgeon/xlsxTables.ts
  const readPart = (name: string) => {
    const e = zip.entries.find((x) => x.name === name);
    return e ? strFromU8(entryData(zip, e)) : null;
  };
  const te = new TableEdits(readPart);
  for (const part of meta.parts) {
    const tb = tables.get(part.tables![0])!;
    const hashes = part.rows ?? [];
    const dirty = tb.rows.map((r, i) => i >= hashes.length || rowHash(r) !== hashes[i]);
    if (tb.rows.length === hashes.length && !dirty.some(Boolean)) continue;
    const sh = origSheets.get(part.part);
    const entry = zip.entries.find((e) => e.name === part.part);
    if (!sh || !entry) throw new SurgeryUnavailable("sheet");
    if (tb.rows.length !== hashes.length || (tb.rows[0]?.length ?? 0) !== (sh.rows[0]?.length ?? 0)) reshaped++;
    const r = rewriteSheet(strFromU8(entryData(zip, entry)), sh.rows, tb.rows, dirty, hashes.length, styles, te, part.part);
    looks += r.looks;
    formulaValues += r.formulaValues;
    formulaGone ||= r.formulaGone;
    if (r.changed) changed.set(part.part, enc.encode(r.xml));
  }
  if (!changed.size) {
    // only looks changed (bold, alignment…): nothing to write in stage 1
    return { bytes: orig, unchanged: true, warnings: looks ? [tn("engine.officeSurgeon.cellLookKept", looks)] : [] };
  }
  if (te.any) {
    const get = (name: string) => (changed.has(name) ? strFromU8(changed.get(name)!) : readPart(name));
    te.apply(get, (name, text) => changed.set(name, enc.encode(text)), zip.entries.map((e) => e.name));
  }
  // recalculate on open (cached results of other formulas may be stale)
  const wb = changed.has("xl/workbook.xml") ? strFromU8(changed.get("xl/workbook.xml")!) : readPart("xl/workbook.xml");
  if (wb != null) changed.set("xl/workbook.xml", enc.encode(fullCalcOnLoad(wb)));
  const removed = new Set<string>();
  if (formulaGone && zip.entries.some((e) => e.name === "xl/calcChain.xml")) dropCalcChain(zip, changed, removed);
  const warnings: string[] = [];
  if (zip.entries.some((e) => e.name.startsWith("_xmlsignatures/"))) warnings.push(t("engine.officeSurgeon.signature"));
  if (reshaped) warnings.push(tn("engine.officeSurgeon.sheetReshaped", reshaped));
  if (looks) warnings.push(tn("engine.officeSurgeon.cellLookKept", looks));
  if (formulaValues) warnings.push(tn("engine.officeSurgeon.formulaValue", formulaValues));
  if (te.adjusted) warnings.push(tn("engine.officeSurgeon.tableHeaderAdjusted", te.adjusted));
  return { bytes: rewriteZip(zip, changed, removed), unchanged: false, warnings };
}

/** Attribute value of a start tag. */
const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** One sheet's XML with the dirty rows (and the rows past the table's end) rewritten cell by cell. */
function rewriteSheet(xml: string, orig: TableCell[][], rows: TableCell[][], dirty: boolean[], origCount: number, styles: CellFormats, te: TableEdits, part: string) {
  const root = rootOf(xml);
  // SpreadsheetML written with a prefix (x:row) keeps it on the new elements
  const px = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":") + 1) : "";
  const sheetData = childrenOf(xml, root).find((c) => c.local === "sheetData");
  if (!sheetData) throw new SurgeryUnavailable("sheetData");
  const rowEls = childrenOf(xml, sheetData).filter((c) => c.local === "row");
  // cells covered by array / data-table formulas: Excel cannot change one part of such a range
  const blocked: { r0: number; c0: number; r1: number; c1: number }[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?f\b[^>]*\st="(?:array|dataTable)"[^>]*>/g)) {
    const rg = /^([A-Z]+\d+)(?::([A-Z]+\d+))?$/i.exec(attrOf(m[0], "ref") ?? "");
    const a = rg && parseRef(rg[1]), b = rg && parseRef(rg[2] ?? rg[1]);
    if (a && b) blocked.push({ r0: a.row, c0: a.col, r1: b.row, c1: b.col });
  }
  const byNum = new Map<number, XmlEl>();
  let auto = 0;
  for (const r of rowEls) {
    const n = Number(attrOf(xml.slice(r.start, r.openEnd), "r") ?? auto + 1);
    auto = n;
    byNum.set(n, r);
  }
  let looks = 0;
  let formulaGone = false;
  let formulaValues = 0;
  let changed = false;
  const todo: number[] = [];
  dirty.forEach((d, i) => d && todo.push(i + 1));
  for (let i = rows.length; i < origCount; i++) todo.push(i + 1); // rows removed from the end: cleared
  const newRow = new Map<number, string>();
  for (const n of todo) {
    const cur = rows[n - 1] ?? [];
    const old = orig[n - 1] ?? [];
    const el = byNum.get(n);
    const byCol = new Map<number, XmlEl>();
    let ac = 0;
    for (const c of el ? childrenOf(xml, el).filter((k) => k.local === "c") : []) {
      const ref = parseRef(attrOf(xml.slice(c.start, c.openEnd), "r") ?? "");
      const col = ref ? ref.col : ac;
      ac = col + 1;
      byCol.set(col, c);
    }
    const width = Math.max(cur.length, old.length);
    const out: { col: number; xml: string }[] = [];
    let rowChanged = false;
    /** an original cell kept as it was (its address added when it had none: cells before it may be left out now) */
    const keep = (col: number, c: XmlEl) => {
      const text = xml.slice(c.start, c.end);
      return attrOf(xml.slice(c.start, c.openEnd), "r") != null ? text : text.replace(/^<([\w:]+)/, `<$1 r="${colName(col)}${n}"`);
    };
    // original cells the table does not show (beyond its columns) stay
    for (const [col, c] of byCol) if (col >= width) out.push({ col, xml: keep(col, c) });
    for (let col = 0; col < width; col++) {
      const now = cur[col];
      const was = old[col];
      const orig0 = byCol.get(col);
      if (valueKey(now) === valueKey(was)) {
        if (now && was && cellFp(now) !== cellFp(was)) looks++;
        if (orig0) out.push({ col, xml: keep(col, orig0) });
        continue;
      }
      rowChanged = true;
      const ref = colName(col) + n;
      const origXml = orig0 ? xml.slice(orig0.start, orig0.end) : "";
      // shared / array / data-table formulas: other cells depend on this one's definition
      if (/<(\w+:)?f\b[^>]*\st="(shared|array|dataTable)"[^>]*\sref="/.test(origXml)) throw new SurgeryUnavailable("shared formula");
      // an Excel table's header names its column (xl/tables), a totals label is its totalsRowLabel: both follow (xlsxTables.ts)
      if (te.owns(part, n - 1, col)) te.edit(part, n - 1, col, now?.formula ? null : (now?.text ?? ""));
      if (blocked.some((g) => n - 1 >= g.r0 && n - 1 <= g.r1 && col >= g.c0 && col <= g.c1)) throw new SurgeryUnavailable("array formula");
      if (/<(\w+:)?f\b/.test(origXml) && !now?.formula) formulaGone = true; // also a cell of a shared formula
      if (now?.formula && now.formula === was?.formula) formulaValues++; // its result is recalculated on open
      const s = orig0 ? attrOf(xml.slice(orig0.start, orig0.openEnd), "s") : null;
      const c = writeCell(px, ref, s, now, was, styles);
      if (c) out.push({ col, xml: c });
    }
    if (!rowChanged) continue;
    changed = true;
    out.sort((a, b) => a.col - b.col);
    const body = out.map((o) => o.xml).join("");
    if (el) {
      // the row keeps its attributes (height, style, hidden, outline) except the column-span hint
      const tag = xml.slice(el.start, el.openEnd).replace(/\sspans="[^"]*"/, "");
      const open = el.openEnd === el.end ? tag.slice(0, -2).trimEnd() + ">" : tag;
      newRow.set(n, `${open}${body}</${el.name}>`);
    } else if (body) newRow.set(n, `<${px}row r="${n}">${body}</${px}row>`);
  }
  const fresh = [...newRow.keys()].filter((n) => !byNum.has(n)).sort((a, b) => a - b);
  if (sheetData.openEnd === sheetData.end) {
    // <sheetData/>: the sheet had no rows
    const open = xml.slice(sheetData.start, sheetData.end - 2).trimEnd() + ">";
    const rowsXml = fresh.map((n) => newRow.get(n)!).join("");
    return { xml: xml.slice(0, sheetData.start) + open + rowsXml + `</${sheetData.name}>` + xml.slice(sheetData.end), looks, formulaGone, formulaValues, changed };
  }
  // original rows replaced in place, new rows inserted in row order
  let res = "";
  let at = sheetData.openEnd;
  let fi = 0;
  const flushFresh = (upTo: number) => {
    while (fi < fresh.length && fresh[fi] < upTo) res += newRow.get(fresh[fi++])!;
  };
  for (const [n, el] of [...byNum.entries()].sort((a, b) => a[1].start - b[1].start)) {
    res += xml.slice(at, el.start);
    flushFresh(n);
    res += newRow.get(n) ?? xml.slice(el.start, el.end);
    at = el.end;
  }
  flushFresh(Infinity);
  res += xml.slice(at, sheetData.closeStart);
  return { xml: xml.slice(0, sheetData.openEnd) + res + xml.slice(sheetData.closeStart), looks, formulaGone, formulaValues, changed };
}

/** One changed cell, its original style index kept; null = nothing to write (empty, unstyled). */
function writeCell(px: string, ref: string, s: string | null, now: TableCell | undefined, was: TableCell | undefined, styles: CellFormats): string | null {
  const sa = s ? ` s="${s}"` : "";
  const c = px + "c", v = px + "v", f = px + "f", is = px + "is", tt = px + "t";
  if (!now || (!now.text && !now.formula)) return s ? `<${c} r="${ref}"${sa}/>` : null;
  if (now.formula) {
    // the cached result is kept only while the formula is the one it came from (recalculated on open anyway)
    const val = now.formula === was?.formula && now.text ? `<${v}>${esc(now.text)}</${v}>` : "";
    return `<${c} r="${ref}"${sa}${val && !NUMERIC.test(now.text) ? ' t="str"' : ""}><${f}>${esc(now.formula)}</${f}>${val}</${c}>`;
  }
  const num = cellNumber(now);
  // a number needing a format the cell's style does not have would show as a bare serial: written as text then
  // a bare number in a date / percent cell would show as a date / x100: written as text then too
  if (num && (num.fmt == null ? styles(s) == null : num.fmt === (was?.numFmt ?? null))) return `<${c} r="${ref}"${sa}><${v}>${num.v}</${v}></${c}>`;
  return `<${c} r="${ref}"${sa} t="inlineStr"><${is}><${tt} xml:space="preserve">${esc(now.text)}</${tt}></${is}></${c}>`;
}

/** Number-format kind of a cell style index: "date", "percent" or null (anything else). */
type CellFormats = (s: string | null) => "date" | "percent" | null;

function cellFormats(zip: ZipArchive): CellFormats {
  const e = zip.entries.find((x) => x.name === "xl/styles.xml");
  if (!e) return () => null;
  const st = strFromU8(entryData(zip, e));
  const codes = new Map<string, string>();
  for (const m of st.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)) {
    const id = attrOf(m[0], "numFmtId"), code = attrOf(m[0], "formatCode");
    if (id != null && code != null) codes.set(id, code.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  }
  const xfsBlock = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(st)?.[1] ?? "";
  const ids = Array.from(xfsBlock.matchAll(/<(?:\w+:)?xf\b[^>]*>/g), (m) => attrOf(m[0], "numFmtId") ?? "0");
  return (s) => {
    const id = ids[Number(s ?? 0)] ?? "0";
    const n = Number(id);
    if ((n >= 14 && n <= 22) || (n >= 45 && n <= 47)) return "date";
    if (n === 9 || n === 10) return "percent";
    const code = codes.get(id);
    if (!code) return null;
    if (/%/.test(code.replace(/"[^"]*"|\\./g, ""))) return "percent";
    return isDateFormat(code) ? "date" : null;
  };
}

/** workbook.xml with calcPr fullCalcOnLoad="1" (CT_Workbook order: … definedNames calcPr oleSize …). */
function fullCalcOnLoad(wb: string): string {
  const m = /<(\w+:)?calcPr\b[^>]*>/.exec(wb);
  if (m) {
    const tag = m[0];
    const fixed = /\sfullCalcOnLoad="[^"]*"/.test(tag) ? tag.replace(/\sfullCalcOnLoad="[^"]*"/, ' fullCalcOnLoad="1"') : tag.replace(/^<((\w+:)?calcPr)/, '<$1 fullCalcOnLoad="1"');
    return wb.slice(0, m.index) + fixed + wb.slice(m.index + tag.length);
  }
  const after = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
  const root = rootOf(wb);
  const next = childrenOf(wb, root).find((k) => after.includes(k.local));
  const px = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":") + 1) : "";
  const at = next ? next.start : root.closeStart;
  return wb.slice(0, at) + `<${px}calcPr fullCalcOnLoad="1"/>` + wb.slice(at);
}

/** Remove xl/calcChain.xml with its relationship and content-type override (Excel rebuilds the chain). */
function dropCalcChain(zip: ZipArchive, changed: Map<string, Uint8Array>, removed: Set<string>) {
  const enc = new TextEncoder();
  const read = (name: string) => {
    const e = zip.entries.find((x) => x.name === name);
    return e ? strFromU8(entryData(zip, e)) : null;
  };
  const rels = read("xl/_rels/workbook.xml.rels");
  const ct = read("[Content_Types].xml");
  if (rels == null || ct == null) return;
  removed.add("xl/calcChain.xml");
  changed.set("xl/_rels/workbook.xml.rels", enc.encode(rels.replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, "")));
  changed.set("[Content_Types].xml", enc.encode(ct.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "")));
}
