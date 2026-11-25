// Excel workbooks as sheet pages (표 계산): opening (one page per worksheet, the original kept as an asset) and saving —
// surgically into the original package when the pages came from one (only the changed cells, column widths, merges,
// sheet names and added / removed sheets are written; every other byte stays), else as a fresh workbook.

import { strFromU8, strToU8, zipSync, type Zippable } from "fflate";
import { getBlob, makeAsset } from "../../core/assets";
import type { SheetCell, SheetData, SheetStyle } from "../../core/sheetTypes";
import { newPage, uid, type AssetRef, type OfficeSourceMeta, type Page } from "../../core/types";
import { t } from "../../i18n";
import { ENGINE_VERSION } from "../officesurgeon/common";
import { SurgeryUnavailable, type SurgeryResult } from "../officesurgeon/docx";
import { childrenOf, rootOf, type XmlEl } from "../officesurgeon/scan";
import { entryData, readZip, rewriteZip } from "../officesurgeon/zip";
import { headerText, TableEdits } from "../officesurgeon/xlsxTables";
import { esc } from "../xml";
import { Book } from "./calc";
import { addr, colLetters, parseAddr, parseRange, tokenize } from "./formula";
import { formatValue, type SheetLang } from "./numfmt";
import { readXlsx, widthChars, widthPx } from "./read";
import { SheetSurgery, writeFreshNotes } from "./bookExtra";
import { freshStyles, StyleWriter } from "./styleWriter";
import { splitPaneXml, workbookParts, writeSheetParts } from "./writeParts";
import { PERSON_CT, PERSON_REL, personsXml, writeThreads } from "./threads";
import { FreshRels, writeSheetDrawings } from "./writeDrawings";
import { listPivotCaches, writeNewPivots, type NewPivot } from "./pivots";
import { listSlicerCaches, slicerCacheXml, SLICER_CACHE_CT, SLICER_CACHE_REL, writeNewSlicers, type SlicerCacheOut } from "./slicers";
import { writeNewTables } from "./writeTables";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Pages of a workbook: one page per worksheet (A4 for printing; the sheet itself is the grid). */
export function sheetPages(sheets: SheetData[], fileName: string, format = "xlsx"): Page[] {
  return sheets.map((sh) => {
    const p = newPage("DOCUMENT", 794, 1123, sh.name);
    p.background = "#ffffff";
    p.sheet = sh;
    p.source = { format, name: fileName };
    return p;
  });
}

export interface OpenedBook {
  pages: Page[];
  sheets: SheetData[];
  asset: AssetRef | null;
  truncated: boolean;
}

/** Open an .xlsx: sheet pages, with the original bytes kept as an asset for a source-preserving save. */
export function openSheetBook(bytes: Uint8Array, name: string, lang: SheetLang, keepOriginal = true): OpenedBook {
  const { sheets, truncated } = readXlsx(bytes, lang, uid("bk"));
  if (!sheets.length) throw new Error(t("engine.xlsx.noContent"));
  const pages = sheetPages(sheets, name);
  let asset: AssetRef | null = null;
  if (keepOriginal && !truncated) {
    asset = makeAsset(bytes, XLSX_MIME, name);
    const meta: OfficeSourceMeta = { engine: ENGINE_VERSION, assetId: asset.id, hash: asset.hash, parts: sheets.map((s) => ({ part: s.part ?? "", blocks: [], tables: [s.name] })) };
    pages[0].source = { ...pages[0].source!, office: meta };
  }
  return { pages, sheets, asset, truncated };
}

// ───── cell XML ─────

export const FUTURE = new Set(["XLOOKUP", "XMATCH", "IFS", "SWITCH", "MAXIFS", "MINIFS", "CONCAT", "TEXTJOIN", "XOR", "DAYS", "STDEV.S", "STDEV.P", "VAR.S", "VAR.P", "RANK.EQ", "CEILING.MATH", "FLOOR.MATH", "IFNA", "UNICHAR", "UNICODE", "FILTER", "SORT", "SORTBY", "UNIQUE", "SEQUENCE", "RANDARRAY", "LET", "LAMBDA", "CHOOSECOLS", "CHOOSEROWS", "TAKE", "DROP", "VSTACK", "HSTACK", "TOCOL", "TOROW", "WRAPROWS", "WRAPCOLS", "EXPAND", "TEXTSPLIT", "TEXTBEFORE", "TEXTAFTER", "ANCHORARRAY", "SINGLE", "MODE.SNGL", "PERCENTILE.INC", "PERCENTILE.EXC", "QUARTILE.INC"]);
/** dynamic-array functions Excel stores as _xlfn._xlws. */
const XLWS = new Set(["FILTER", "SORT"]);

/**
 * A formula as the file stores it: functions newer than Excel 2007 carry the _xlfn. prefix (FILTER / SORT
 * _xlfn._xlws.), LET names _xlpm., A1# is _xlfn.ANCHORARRAY(A1), [@Col] is [[#This Row],[Col]].
 */
export function fileFormula(f: string): string {
  const toks = tokenize(f.replace(/^=/, ""));
  const next = (i: number) => {
    let j = i + 1;
    while (toks[j]?.t === "ws") j++;
    return j;
  };
  const isOp = (k: number, s: string) => toks[k]?.t === "op" && toks[k].s === s;
  // LET names: an identifier that starts an even argument of LET and is followed by ","
  const params = new Set<string>();
  const calls: { name: string; arg: number; fresh: boolean }[] = [];
  toks.forEach((tk, i) => {
    const top = calls[calls.length - 1];
    if (tk.t === "ws") return;
    if (tk.t === "id" && isOp(next(i), "(")) {
      if (top) top.fresh = false;
      calls.push({ name: tk.s.toUpperCase().replace(/^(_XLFN\.)+/, ""), arg: 0, fresh: true });
      return;
    }
    if (isOp(i, "(")) {
      if (toks.slice(0, i).reverse().find((x) => x.t !== "ws")?.t === "id") return;
      if (top) top.fresh = false;
      calls.push({ name: "", arg: 0, fresh: true });
      return;
    }
    if (isOp(i, ")")) return void calls.pop();
    if (isOp(i, ",") && top) {
      top.arg++;
      top.fresh = true;
      return;
    }
    if (top?.name === "LET" && top.fresh && top.arg % 2 === 0 && tk.t === "id" && !tk.sheet && isOp(next(i), ",")) params.add(tk.s.replace(/^_xlpm\./i, "").toLowerCase());
    if (top) top.fresh = false;
  });
  // @x (implicit intersection) is _xlfn.SINGLE(x): the end of the operand after "@"
  const operandEnd = (k: number): number => {
    const j = next(k - 1);
    const t = toks[j];
    if (!t) return k;
    const close = (from: number) => {
      let depth = 0;
      for (let m = from; m < toks.length; m++) {
        if (isOp(m, "(")) depth++;
        else if (isOp(m, ")") && --depth === 0) return m + 1;
      }
      return toks.length;
    };
    if (isOp(j, "(")) return close(j);
    if (t.t === "id" && isOp(next(j), "(")) return close(next(j));
    return isOp(j + 1, "#") ? j + 2 : j + 1;
  };
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (isOp(i, "@")) {
      const end = operandEnd(i + 1);
      out += `_xlfn.SINGLE(${fileFormula(toks.slice(i + 1, end).map((x) => x.s).join(""))})`;
      i = end - 1;
    } else if (tk.t === "ref" && isOp(i + 1, "#")) {
      out += `_xlfn.ANCHORARRAY(${tk.s})`;
      i++;
    } else if (tk.t === "sref" && tk.spec.trim().startsWith("@")) {
      const rest = tk.spec.trim().slice(1).trim();
      out += `${tk.table ?? ""}[${rest ? `[#This Row],${rest.startsWith("[") ? rest : `[${rest}]`}` : "#This Row"}]`;
    } else if (tk.t === "id") {
      const up = tk.s.toUpperCase();
      if (isOp(next(i), "(") && FUTURE.has(up)) out += (XLWS.has(up) ? "_xlfn._xlws." : "_xlfn.") + tk.s;
      else if (!tk.sheet && !isOp(next(i), "(") && params.has(tk.s.toLowerCase())) out += "_xlpm." + tk.s;
      else out += tk.s;
    } else out += tk.s;
  }
  return out;
}
/** A formula as it is shown and edited (no _xlfn. / _xlpm. prefixes, A1# for ANCHORARRAY(A1), [@Col] for this-row references). */
export const shownFormula = (f: string) =>
  f
    .replace(/_xlfn\.ANCHORARRAY\(([^()]+)\)/gi, "$1#")
    .replace(/_xlfn\.SINGLE\(/gi, "@(")
    .replace(/\[\[#This Row\],\s*(\[[^\]]*\](?::\[[^\]]*\])?)\]/gi, (_m, cols: string) => (/^\[[\w -￿.]+\]$/.test(cols) ? `[@${cols.slice(1, -1)}]` : `[@${cols}]`))
    .replace(/_xlfn\.|_xlws\.|_xlpm\./gi, "");

const xmlText = (s: string) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ""));
const numXml = (n: number) => (Number.isFinite(n) ? String(n).replace("e+", "E+").replace("e-", "E-") : "0");

/**
 * One cell element; null when there is nothing to write. An array formula anchor is written `<f t="array" ref>`;
 * `cm` is the workbook's dynamic-array cell metadata index (without it a dynamic array is written as a legacy array formula).
 */
export function cellXml(px: string, ref: string, xf: number, c: SheetCell | undefined, cm?: number | null): string | null {
  const sa = xf ? ` s="${xf}"` : "";
  const C = px + "c", V = px + "v", F = px + "f";
  if (!c || (c.v === undefined && !c.f)) return xf ? `<${C} r="${ref}"${sa}/>` : null;
  const v = c.v;
  let tAttr = "";
  let vXml = "";
  if (c.t === "e") {
    tAttr = ' t="e"';
    vXml = `<${V}>${xmlText(String(v))}</${V}>`;
  } else if (typeof v === "boolean") {
    tAttr = ' t="b"';
    vXml = `<${V}>${v ? 1 : 0}</${V}>`;
  } else if (typeof v === "number") vXml = `<${V}>${numXml(v)}</${V}>`;
  else if (typeof v === "string") {
    if (c.f || c.sp) {
      tAttr = ' t="str"';
      vXml = `<${V}>${xmlText(v)}</${V}>`;
    } else return `<${C} r="${ref}"${sa} t="inlineStr"><${px}is><${px}t xml:space="preserve">${xmlText(v)}</${px}t></${px}is></${C}>`;
  }
  let fXml = "";
  let cmA = "";
  if (c.dt) {
    const d = c.dt;
    fXml = `<${F} t="dataTable" ref="${d.ref}"${d.dt2D ? ' dt2D="1"' : ""}${d.dtr ? ' dtr="1"' : ""} r1="${d.r1}"${d.r2 ? ` r2="${d.r2}"` : ""}/>`;
  } else if (c.f && c.spill) {
    // a blocked dynamic array (#SPILL!) covers its own cell only
    const fr = c.t === "e" && v === "#SPILL!" && !c.cse ? ref : c.spill;
    fXml = `<${F} t="array" ref="${fr}">${xmlText(fileFormula(c.f))}</${F}>`;
    if (!c.cse && cm) cmA = ` cm="${cm}"`;
  } else if (c.f) fXml = `<${F}>${xmlText(fileFormula(c.f))}</${F}>`;
  return `<${C} r="${ref}"${sa}${tAttr}${cmA}>${fXml}${vXml}</${C}>`;
}

const sameStyle = (a: SheetStyle | undefined, b: SheetStyle | undefined) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
const valueKey = (c: SheetCell | undefined) => (c ? JSON.stringify([c.v ?? null, c.t ?? null, c.f ?? null, c.spill ?? null]) : "[null,null,null,null]");

/** xl/metadata.xml with the one cell metadata Excel gives dynamic array formulas (XLDAPR, cm="1"). */
const DA_METADATA =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">` +
  `<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>` +
  `<futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>` +
  `<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`;
const METADATA_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata";
const METADATA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml";

/** The cm index of an existing metadata part's dynamic-array cell metadata; null when it has none. */
export function dynamicArrayCm(xml: string): number | null {
  const types = [...xml.matchAll(/<(?:\w+:)?metadataType\b[^>]*>/g)];
  const ti = types.findIndex((m) => attrOf(m[0], "name") === "XLDAPR");
  if (ti < 0) return null;
  const block = /<(?:\w+:)?cellMetadata\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellMetadata>/.exec(xml);
  if (!block) return null;
  const bks = [...block[1].matchAll(/<(?:\w+:)?bk\b[^>]*>([\s\S]*?)<\/(?:\w+:)?bk>/g)];
  const k = bks.findIndex((m) => new RegExp(`<(?:\\w+:)?rc\\b[^>]*\\st="${ti + 1}"`).test(m[1]));
  return k < 0 ? null : k + 1;
}
const isDynamicAnchor = (c: SheetCell | undefined) => !!(c?.f && c.spill && !c.cse);

/** Cell format index (xf) of a sheet style index: the original one while the style is unchanged, else a new one. */
function xfResolver(sh: SheetData, orig: SheetData | undefined, sw: StyleWriter) {
  return (s: number | undefined): number => {
    const k = s ?? 0;
    const st = sh.styles[k];
    if (sh.xf && k < sh.xf.length && orig && sameStyle(st, orig.styles[k])) return sh.xf[k] ?? 0;
    if (!k && sameStyle(st, {})) return 0;
    return sw.xfFor(st ?? {});
  };
}

// ───── whole worksheet (fresh workbooks, added sheets) ─────

/** `orig`: a column's width as the file wrote it, kept while it still gives the column's px (a partial save rewrites
 * <cols> when one column changes; the others keep their text, 8.43 not 8.42578125). */
function colsXml(sh: SheetData, mdw: number, xfOf: (s: number | undefined) => number, orig?: (c: number) => string | undefined): string {
  const idx = new Set<number>([...Object.keys(sh.colW).map(Number), ...(sh.hiddenCols ?? []), ...Object.keys(sh.colS ?? {}).map(Number), ...Object.keys(sh.colLevel ?? {}).map(Number)]);
  if (!idx.size) return "";
  const hidden = new Set(sh.hiddenCols ?? []);
  const list = [...idx].sort((a, b) => a - b);
  const one = (c: number) => {
    const w = sh.colW[c] ?? sh.defColW;
    const st = sh.colS?.[c];
    const was = orig?.(c);
    const chars = was != null && Number(was) >= 0 && widthPx(Number(was), mdw) === w ? was : String(widthChars(w, mdw) || 0);
    const lv = sh.colLevel?.[c];
    return `width="${chars}" customWidth="1"${hidden.has(c) ? ' hidden="1"' : ""}${st ? ` style="${xfOf(st)}"` : ""}${lv ? ` outlineLevel="${lv}"` : ""}`;
  };
  const out: string[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    const a = one(list[i]);
    while (j + 1 < list.length && list[j + 1] === list[j] + 1 && one(list[j + 1]) === a) j++;
    out.push(`<col min="${list[i] + 1}" max="${list[j] + 1}" ${a}/>`);
    i = j + 1;
  }
  return `<cols>${out.join("")}</cols>`;
}

function rowsOf(sh: SheetData): Map<number, { c: number; a: string }[]> {
  const rows = new Map<number, { c: number; a: string }[]>();
  for (const a of Object.keys(sh.cells)) {
    const p = parseAddr(a);
    if (!p) continue;
    const list = rows.get(p.r) ?? [];
    list.push({ c: p.c, a });
    rows.set(p.r, list);
  }
  return rows;
}

const rowAttrs = (sh: SheetData, r: number, xfOf: (s: number | undefined) => number) => {
  const h = sh.rowH[r];
  const hidden = sh.hiddenRows?.includes(r);
  const st = sh.rowS?.[r];
  // (a row Excel fitted to its text — rowAuto — is written without customHeight, as Excel wrote it)
  const lv = sh.rowLevel?.[r];
  return `${h != null ? ` ht="${Math.round(((h * 72) / 96) * 100) / 100}"${sh.rowAuto?.[r] ? "" : ' customHeight="1"'}` : ""}${hidden ? ' hidden="1"' : ""}${st ? ` s="${xfOf(st)}" customFormat="1"` : ""}${lv ? ` outlineLevel="${lv}"` : ""}`;
};
/** sheetFormatPr's outline depths (Excel sizes the outline bar by them) */
const outlineAttrs = (sh: SheetData) => {
  const r = Math.max(0, ...Object.values(sh.rowLevel ?? {})), c = Math.max(0, ...Object.values(sh.colLevel ?? {}));
  return `${r ? ` outlineLevelRow="${r}"` : ""}${c ? ` outlineLevelCol="${c}"` : ""}`;
};

export function worksheetXml(sh: SheetData, mdw: number, xfOf: (s: number | undefined) => number, cmOf?: () => number | null): string {
  const rows = rowsOf(sh);
  for (const r of [...Object.keys(sh.rowH).map(Number), ...(sh.hiddenRows ?? []), ...Object.keys(sh.rowS ?? {}).map(Number), ...Object.keys(sh.rowLevel ?? {}).map(Number)]) if (!rows.has(r)) rows.set(r, []);
  const rowsXml = [...rows.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const cells = rows
        .get(r)!
        .sort((a, b) => a.c - b.c)
        .map(({ a }) => cellXml("", a, xfOf(sh.cells[a].s), sh.cells[a], isDynamicAnchor(sh.cells[a]) ? cmOf?.() : undefined))
        .filter(Boolean)
        .join("");
      return `<row r="${r + 1}"${rowAttrs(sh, r, xfOf)}>${cells}</row>`;
    })
    .join("");
  const fr = sh.freeze;
  const pane = !fr && sh.split ? splitPaneXml("", sh) : fr && (fr.rows || fr.cols) ? `<pane${fr.cols ? ` xSplit="${fr.cols}"` : ""}${fr.rows ? ` ySplit="${fr.rows}"` : ""} topLeftCell="${addr(fr.rows, fr.cols)}" activePane="${fr.rows && fr.cols ? "bottomRight" : fr.rows ? "bottomLeft" : "topRight"}" state="frozen"/>` : "";
  const view = `<sheetViews><sheetView${sh.grid ? "" : ' showGridLines="0"'}${sh.headings ? "" : ' showRowColHeaders="0"'}${sh.zoom ? ` zoomScale="${Math.round(sh.zoom * 100)}"` : ""}${!fr && sh.split ? ` topLeftCell="${addr(sh.split.top, sh.split.left)}"` : ""} workbookViewId="0">${pane}</sheetView></sheetViews>`;
  const merges = sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  const tab = sh.tabColor ? `<sheetPr><tabColor rgb="FF${sh.tabColor.replace("#", "")}"/></sheetPr>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${tab}${view}<sheetFormatPr defaultRowHeight="${Math.round(((sh.defRowH * 72) / 96) * 100) / 100}"${sh.defRowCustom ? ' customHeight="1"' : ""}${outlineAttrs(sh)}/>${colsXml(sh, mdw, xfOf)}<sheetData>${rowsXml}</sheetData>${merges}</worksheet>`
  );
}

/** A new workbook written from sheet models (formats, fonts, fills, borders, widths, merges, frozen panes, formulas). */
export function writeFreshXlsx(sheets: SheetData[]): Uint8Array {
  if (!sheets.length) throw new Error(t("engine.xlsx.noTable"));
  const base = sheets[0];
  const sw = new StyleWriter(freshStyles(base.baseFont, base.baseSize), { font: base.baseFont, size: base.baseSize });
  const files: Zippable = {};
  const used = new Set<string>();
  const sheetEls: string[] = [];
  const rels: string[] = [];
  const over: string[] = [];
  let dynamic = false;
  const cmOf = () => ((dynamic = true), 1);
  const pivotCaches: (NewPivot & { si: number })[] = [];
  let cacheN = 0;
  const tableIds = new Map<string, number>();
  const slicerCaches: SlicerCacheOut[] = [];
  const persons = new Map<string, string>();
  sheets.forEach((sh, i) => {
    const xfOf = (s: number | undefined) => (!s && sameStyle(sh.styles[s ?? 0], {}) ? 0 : sw.xfFor(sh.styles[s ?? 0] ?? {}));
    const part = `xl/worksheets/sheet${i + 1}.xml`;
    const pkg = new FreshRels(part, files, over);
    let xml = writeSheetParts(worksheetXml(sh, base.mdw, xfOf, cmOf), sh, null, (st) => sw.dxfFor(st), pkg);
    xml = writeSheetDrawings(xml, sh, null, pkg);
    xml = writeFreshNotes(xml, sh, pkg);
    writeThreads(sh, null, pkg, persons);
    xml = writeNewTables(xml, sh, null, pkg, tableIds);
    const sl = writeNewSlicers(xml, sh, null, pkg, sheets);
    xml = sl.xml;
    slicerCaches.push(...sl.caches);
    pivotCaches.push(...writeNewPivots(sh, sheets, pkg, () => ++cacheN).map((x) => ({ ...x, si: i })));
    files[part] = strToU8(xml);
    pkg.flush();
    let name = sh.name.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || `Sheet${i + 1}`;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${name.slice(0, 28)}_${k}`;
    used.add(name.toLowerCase());
    sheetEls.push(`<sheet name="${esc(name)}" sheetId="${i + 1}"${sh.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`);
    rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
    over.push(`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });
  const n = sheets.length;
  rels.push(`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  files["xl/styles.xml"] = strToU8(sw.result());
  if (dynamic) {
    files["xl/metadata.xml"] = strToU8(DA_METADATA);
    rels.push(`<Relationship Id="rId${n + 2}" Type="${METADATA_REL}" Target="metadata.xml"/>`);
    over.push(`<Override PartName="/xl/metadata.xml" ContentType="${METADATA_TYPE}"/>`);
  }
  // pivot tables made here: the workbook lists their caches
  const cacheList = pivotCaches.map((c, k) => {
    const rid = `rId${n + 3 + k}`;
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="${c.def.replace(/^xl\//, "")}"/>`);
    return { cacheId: c.cacheId, rid };
  });
  // slicers made here: their caches (parts, relationships, the workbook's list and names)
  const slicerList: { name: string; rid: string; table: boolean }[] = [];
  slicerCaches.forEach((c) => {
    const x = slicerCacheXml(
      c,
      (name) => tableIds.get(name) ?? null,
      (sheet, at) => {
        const p = pivotCaches.find((q) => sheets[q.si].name === sheet && q.at === at);
        return p && p.x14 != null ? { sheet, at, tabId: p.si + 1, name: p.name, x14: p.x14, items: p.items, shown: p.shown } : null;
      },
    );
    if (!x) return;
    const k = slicerList.length + 1;
    const rid = `rId${n + 3 + cacheList.length + k}`;
    files[`xl/slicerCaches/slicerCache${k}.xml`] = strToU8(x);
    rels.push(`<Relationship Id="${rid}" Type="${SLICER_CACHE_REL}" Target="slicerCaches/slicerCache${k}.xml"/>`);
    over.push(`<Override PartName="/xl/slicerCaches/slicerCache${k}.xml" ContentType="${SLICER_CACHE_CT}"/>`);
    slicerList.push({ name: c.name, rid, table: !!c.table });
  });
  files["xl/workbook.xml"] = strToU8(
    listSlicerCaches(listPivotCaches(
      workbookParts(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${base.date1904 ? '<workbookPr date1904="1"/>' : ""}<bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetEls.join("")}</sheets><calcPr calcId="191029"${base.calcManual ? ' calcMode="manual"' : ""} fullCalcOnLoad="1"/></workbook>`,
        sheets,
        null,
        fileFormula,
      ),
      cacheList,
    ), slicerList),
  );
  // the authors of threaded comments (메모 스레드)
  if (persons.size) {
    files["xl/persons/person.xml"] = strToU8(personsXml(persons));
    rels.push(`<Relationship Id="rIdPersons" Type="${PERSON_REL}" Target="persons/person.xml"/>`);
    over.push(`<Override PartName="/xl/persons/person.xml" ContentType="${PERSON_CT}"/>`);
  }
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${over.join("")}</Types>`,
  );
  return zipSync(files, { level: 6 });
}

// ───── Office Surgeon ─────

const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Sheets of the book the original came from, in tab order. */
export function bookSheets(pages: Page[]): SheetData[] {
  const first = pages.find((p) => p.sheet)?.sheet;
  if (!first) return [];
  return pages.filter((p) => p.sheet && p.sheet.book === first.book).map((p) => p.sheet!);
}

export function saveSheetSurgical(pages: Page[], meta: OfficeSourceMeta): SurgeryResult {
  if (meta.engine !== ENGINE_VERSION) throw new SurgeryUnavailable("engine");
  const orig = getBlob(meta.hash);
  if (!orig) throw new SurgeryUnavailable("asset");
  const zip = readZip(orig);
  if (!zip) throw new SurgeryUnavailable("zip");
  const read = (name: string) => {
    const e = zip.entries.find((x) => x.name === name);
    return e ? strFromU8(entryData(zip, e)) : null;
  };
  const ct = read("[Content_Types].xml") ?? "";
  if (/macroEnabled|\.template\.main/.test(ct)) throw new SurgeryUnavailable("package type");
  if (pages.some((p) => !p.sheet)) throw new SurgeryUnavailable("not only sheets");
  const cur = bookSheets(pages);
  const origSheets = readXlsx(orig, cur[0]?.lang ?? "en", cur[0]?.book ?? "b").sheets;
  // tab order: original sheets keep their order (added sheets may be anywhere after them)
  const kept = cur.filter((s) => s.index != null);
  if (kept.some((s, i) => i > 0 && s.index! < kept[i - 1].index!)) throw new SurgeryUnavailable("sheet order");
  if (cur.some((s, i) => s.index == null && cur.slice(i).some((x) => x.index != null))) throw new SurgeryUnavailable("sheet order");
  const removed = origSheets.filter((o) => !kept.some((s) => s.index === o.index));
  const enc = new TextEncoder();
  const changed = new Map<string, Uint8Array>();
  const gone = new Set<string>();
  const stylesXml = read("xl/styles.xml");
  const base = origSheets[0] ?? cur[0];
  const sw = new StyleWriter(stylesXml ?? freshStyles(base.baseFont, base.baseSize), { font: base.baseFont, size: base.baseSize });
  let formulaGone = false;
  let anyValue = false;
  // rows / columns inserted or deleted, notes and AutoFilter (io/sheet/bookExtra.ts)
  const ex = new SheetSurgery(zip, read);
  // header cells of Excel tables (their column names) and totals row labels (officesurgeon/xlsxTables.ts); tables are
  // read as the row / column moves left them
  const te = new TableEdits((name) => ex.get(name));
  // dynamic array cell metadata (cm): the workbook's own, else a metadata part added when a dynamic array is written
  const da = { cm: null as number | null, add: false, known: false };
  const cmOf = (): number | null => {
    if (da.known) return da.cm;
    da.known = true;
    const rel = [...(read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].find((m) => attrOf(m[0], "Type") === METADATA_REL);
    const has = zip.entries.some((e) => e.name === "xl/metadata.xml");
    if (rel) {
      const target = attrOf(rel[0], "Target") ?? "";
      const x = read(target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, ""));
      da.cm = x ? dynamicArrayCm(x) : null;
    } else if (!has) {
      da.cm = 1;
      da.add = true;
    }
    return da.cm;
  };
  for (const sh of kept) {
    const o = origSheets.find((x) => x.index === sh.index)!;
    if (!o || !sh.part) throw new SurgeryUnavailable("sheet");
    const xml = read(sh.part);
    if (xml == null) throw new SurgeryUnavailable("sheet part");
    // a spilled value written alone must be what its array formula gives now (not a value typed over part of an array)
    const si = cur.indexOf(sh);
    const fresh = new Map<string, Set<string>>();
    const spilledAsCalculated = (anchor: string, a: string) => {
      let moved = fresh.get(anchor);
      if (!moved) {
        moved = new Set(new Book(cur).recalc([`${si}!${anchor}`]).filter((x) => x.sheet === si).map((x) => x.addr));
        fresh.set(anchor, moved);
      }
      return !moved.has(a) && !moved.has(anchor);
    };
    const pre = ex.before(sh, o, xml);
    const r = rewriteSheet(pre.xml, sh, o, xfResolver(sh, o, sw), te, sh.part, cmOf, spilledAsCalculated, pre.force);
    formulaGone ||= r.formulaGone || ex.moved;
    anyValue ||= r.values || ex.moved;
    const out = ex.after(sh, o, r.xml, (st) => sw.dxfFor(st), cur);
    if (out !== xml) changed.set(sh.part, enc.encode(out));
  }
  const wb0 = read("xl/workbook.xml") ?? "";
  let wb = ex.workbook(wb0);
  // print area / titles, names defined here, structure protection (io/sheet/writeParts.ts)
  wb = workbookParts(wb, cur, { sheets: origSheets, names: origSheets[0]?.names }, fileFormula);
  let wbRels = read("xl/_rels/workbook.xml.rels") ?? "";
  let types = ex.contentTypes(ct);
  // renamed sheets
  for (const sh of kept) {
    const o = origSheets.find((x) => x.index === sh.index)!;
    if (o.name === sh.name) continue;
    const els = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>/g)];
    const el = els[sh.index!];
    if (!el) throw new SurgeryUnavailable("sheet element");
    const fixed = el[0].replace(/\sname="[^"]*"/, ` name="${esc(sh.name)}"`);
    wb = wb.slice(0, el.index!) + fixed + wb.slice(el.index! + el[0].length);
    // defined names that point at the old name
    const q = (n: string) => (/^[\w.]+$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
    wb = wb.replace(/(<(?:\w+:)?definedName\b[^>]*>)([^<]*)(<\/)/g, (_m, a, body: string, c) => a + body.split(esc(q(o.name)) + "!").join(esc(q(sh.name)) + "!") + c);
  }
  // removed sheets
  if (removed.length) {
    if (/localSheetId=/.test(wb)) throw new SurgeryUnavailable("local names");
    const els = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\/?>/g)];
    for (const o of [...removed].sort((a, b) => b.index! - a.index!)) {
      const el = els[o.index!];
      if (!el) throw new SurgeryUnavailable("sheet element");
      const rid = attrOf(el[0], "r:id") ?? attrOf(el[0], "id");
      wb = wb.slice(0, el.index!) + wb.slice(el.index! + el[0].length);
      wbRels = wbRels.replace(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*/>`), "");
      if (o.part) {
        gone.add(o.part);
        const rels = o.part.replace(/([^/]+)$/, "_rels/$1.rels");
        if (zip.entries.some((e) => e.name === rels)) gone.add(rels);
        types = types.replace(new RegExp(`<Override\\b[^>]*PartName="/${o.part.replace(/[.]/g, "\\.")}"[^>]*/>`), "");
      }
    }
    // the active tab may have pointed past the end
    wb = wb.replace(/\sactiveTab="\d+"/, ' activeTab="0"').replace(/\sfirstSheet="\d+"/, "");
    formulaGone = true;
  }
  // added sheets
  const added = cur.filter((s) => s.index == null);
  if (added.length) {
    const ids = [...wb.matchAll(/\ssheetId="(\d+)"/g)].map((m) => Number(m[1]));
    let nextId = Math.max(0, ...ids) + 1;
    const rids = [...wbRels.matchAll(/\sId="rId(\d+)"/g)].map((m) => Number(m[1]));
    let nextRid = Math.max(0, ...rids) + 1;
    let n = 1;
    const sheetsClose = /<\/(\w+:)?sheets>/.exec(wb);
    if (!sheetsClose) throw new SurgeryUnavailable("sheets");
    let insert = "";
    for (const sh of added) {
      while (zip.entries.some((e) => e.name === `xl/worksheets/sheet${n}.xml`) || changed.has(`xl/worksheets/sheet${n}.xml`)) n++;
      const part = `xl/worksheets/sheet${n}.xml`;
      const xfOf = (s: number | undefined) => (!s && sameStyle(sh.styles[s ?? 0], {}) ? 0 : sw.xfFor(sh.styles[s ?? 0] ?? {}));
      changed.set(part, enc.encode(ex.fresh(sh, worksheetXml(sh, base.mdw, xfOf, cmOf), part, (st) => sw.dxfFor(st), cur)));
      const rid = `rId${nextRid++}`;
      insert += `<${sheetsClose[1] ?? ""}sheet name="${esc(sh.name)}" sheetId="${nextId++}" r:id="${rid}"/>`;
      wbRels = wbRels.replace(/<\/Relationships>/, `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`);
      types = types.replace(/<\/Types>/, `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
      anyValue = true;
    }
    if (!/xmlns:r=/.test(wb.slice(0, 600))) throw new SurgeryUnavailable("namespace");
    wb = wb.slice(0, sheetsClose.index) + insert + wb.slice(sheetsClose.index);
  }
  types = ex.contentTypes(types);
  ex.flush(changed, gone);
  // the authors of threaded comments added here: the workbook's persons part (made when the file had none)
  if (ex.personsChanged) {
    const relTag = [...wbRels.matchAll(/<Relationship\b[^>]*>/g)].find((m) => /\/person"/.test(attrOf(m[0], "Type") ?? "") || attrOf(m[0], "Type") === PERSON_REL);
    const path = relTag ? "xl/" + (attrOf(relTag[0], "Target") ?? "persons/person.xml").replace(/^\/?xl\//, "").replace(/^\//, "") : "xl/persons/person.xml";
    changed.set(path, enc.encode(personsXml(ex.persons)));
    if (!relTag) {
      const rids = [...wbRels.matchAll(/\sId="rId(\d+)"/g)].map((m) => Number(m[1]));
      wbRels = wbRels.replace(/<\/Relationships>/, `<Relationship Id="rId${Math.max(0, ...rids) + 1}" Type="${PERSON_REL}" Target="persons/person.xml"/></Relationships>`);
      types = types.replace(/<\/Types>/, `<Override PartName="/xl/persons/person.xml" ContentType="${PERSON_CT}"/></Types>`);
    }
  }
  // pivot tables made here: their caches in the workbook's relationships and <pivotCaches>
  if (ex.caches.length) {
    const list = ex.caches.map((c) => {
      const rids = [...wbRels.matchAll(/\sId="rId(\d+)"/g)].map((m) => Number(m[1]));
      const rid = `rId${Math.max(0, ...rids) + 1}`;
      wbRels = wbRels.replace(/<\/Relationships>/, `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="${c.def.replace(/^xl\//, "")}"/></Relationships>`);
      return { cacheId: c.cacheId, rid };
    });
    wb = listPivotCaches(wb, list);
  }
  // slicers made here: their caches (parts, the workbook's relationships, list and names)
  if (ex.slicerCaches.length) {
    const tabIds = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\ssheetId="(\d+)"/g)].map((m) => Number(m[1]));
    const list: { name: string; rid: string; table: boolean }[] = [];
    let k = 1;
    for (const c of ex.slicerCaches) {
      const x = slicerCacheXml(
        c,
        (name) => ex.tableIds.get(name) ?? cur.flatMap((s2) => s2.tables ?? []).find((tb) => tb.name === name)?.id ?? null,
        (sheet, at) => {
          const p = ex.caches.find((q) => q.sheet === sheet && q.at === at);
          const si2 = cur.findIndex((s2) => s2.name === sheet);
          return p && p.x14 != null && si2 >= 0 ? { sheet, at, tabId: tabIds[si2] ?? si2 + 1, name: p.name, x14: p.x14, items: p.items, shown: p.shown } : null;
        },
      );
      if (!x) continue;
      while (zip.entries.some((e) => e.name === `xl/slicerCaches/slicerCache${k}.xml`) || changed.has(`xl/slicerCaches/slicerCache${k}.xml`)) k++;
      const part = `xl/slicerCaches/slicerCache${k}.xml`;
      changed.set(part, enc.encode(x));
      const rids = [...wbRels.matchAll(/\sId="rId(\d+)"/g)].map((m) => Number(m[1]));
      const rid = `rId${Math.max(0, ...rids) + 1}`;
      wbRels = wbRels.replace(/<\/Relationships>/, `<Relationship Id="${rid}" Type="${SLICER_CACHE_REL}" Target="slicerCaches/slicerCache${k}.xml"/></Relationships>`);
      types = types.replace(/<\/Types>/, `<Override PartName="/${part}" ContentType="${SLICER_CACHE_CT}"/></Types>`);
      list.push({ name: c.name, rid, table: !!c.table });
    }
    wb = listSlicerCaches(wb, list);
  }
  if (te.any) {
    const get = (name: string) => (name === "xl/workbook.xml" ? wb : gone.has(name) ? null : changed.has(name) ? strFromU8(changed.get(name)!) : read(name));
    const names = [...new Set([...zip.entries.map((e) => e.name), ...changed.keys()])].filter((n) => !gone.has(n));
    te.apply(get, (name, text) => (name === "xl/workbook.xml" ? (wb = text) : changed.set(name, enc.encode(text))), names);
  }
  if (da.add) {
    changed.set("xl/metadata.xml", enc.encode(DA_METADATA));
    const rids = [...wbRels.matchAll(/\sId="rId(\d+)"/g)].map((m) => Number(m[1]));
    wbRels = wbRels.replace(/<\/Relationships>/, `<Relationship Id="rId${Math.max(0, ...rids) + 1}" Type="${METADATA_REL}" Target="metadata.xml"/></Relationships>`);
    types = types.replace(/<\/Types>/, `<Override PartName="/xl/metadata.xml" ContentType="${METADATA_TYPE}"/></Types>`);
  }
  // 계산 옵션 (자동 / 수동) as the book now has it
  {
    const manual = !!pages.find((p) => p.sheet)?.sheet?.calcManual;
    const m = /<(\w+:)?calcPr\b[^>]*>/.exec(wb);
    const fileManual = !!m && /\scalcMode="manual"/.test(m[0]);
    if (manual !== fileManual) {
      if (m) {
        const tag = m[0].replace(/\s+calcMode="[^"]*"/, "");
        const fixed = manual ? tag.replace(/^<((\w+:)?calcPr)/, '<$1 calcMode="manual"') : tag;
        wb = wb.slice(0, m.index) + fixed + wb.slice(m.index + m[0].length);
      } else if (manual) wb = fullCalcOnLoad(wb).replace(/<((\w+:)?calcPr)\b/, '<$1 calcMode="manual"');
    }
  }
  if (!changed.size && !gone.size && wb === wb0 && !sw.changed) return { bytes: orig, unchanged: true, warnings: [] };
  if (sw.changed && stylesXml != null) {
    changed.set("xl/styles.xml", enc.encode(sw.result()));
    // a package whose stylesheet had no content type: Excel ignores the part, and the formats written here point nowhere
    if (!/PartName="\/xl\/styles\.xml"/.test(types)) types = types.replace(/<\/Types>/, `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  }
  if (anyValue) wb = fullCalcOnLoad(wb);
  if (wb !== wb0) changed.set("xl/workbook.xml", enc.encode(wb));
  if (formulaGone && zip.entries.some((e) => e.name === "xl/calcChain.xml")) {
    gone.add("xl/calcChain.xml");
    wbRels = wbRels.replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, "");
    types = types.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
  }
  if (wbRels !== (read("xl/_rels/workbook.xml.rels") ?? "")) changed.set("xl/_rels/workbook.xml.rels", enc.encode(wbRels));
  if (types !== ct) changed.set("[Content_Types].xml", enc.encode(types));
  const warnings: string[] = [];
  if (zip.entries.some((e) => e.name.startsWith("_xmlsignatures/"))) warnings.push(t("engine.officeSurgeon.signature"));
  if (te.adjusted) warnings.push(t(te.adjusted === 1 ? "engine.officeSurgeon.tableHeaderAdjusted_one" : "engine.officeSurgeon.tableHeaderAdjusted", { n: te.adjusted }));
  return { bytes: rewriteZip(zip, changed, gone), unchanged: false, warnings };
}

/** workbook.xml with calcPr fullCalcOnLoad="1" (Excel recalculates what Omniweave did not know). */
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

/** The worksheet XML with changed cells, column widths and merges written; everything else as it was. */
function rewriteSheet(
  xml: string,
  sh: SheetData,
  o: SheetData,
  xfOf: (s: number | undefined) => number,
  te: TableEdits,
  part: string,
  cmOf: () => number | null,
  spilledAsCalculated: (anchor: string, a: string) => boolean,
  force?: Set<string>,
) {
  const root = rootOf(xml);
  const px = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":") + 1) : "";
  const kids = childrenOf(xml, root);
  const sheetData = kids.find((c) => c.local === "sheetData");
  if (!sheetData) throw new SurgeryUnavailable("sheetData");
  // which cells changed (value, formula or look)
  const dirty = new Set<string>();
  let formulaGone = false;
  let values = false;
  for (const a of new Set([...Object.keys(sh.cells), ...Object.keys(o.cells)])) {
    const n = sh.cells[a], w = o.cells[a];
    const vChanged = valueKey(n) !== valueKey(w);
    const sChanged = !sameStyle(sh.styles[n?.s ?? 0], o.styles[w?.s ?? 0]);
    if (!vChanged && !sChanged) continue;
    if (vChanged) {
      // a table's header cell names its column, a totals label is its totalsRowLabel: they follow (xlsxTables.ts)
      const p = parseAddr(a)!;
      // (a number as the cell shows it: Excel names a column typed 2026-01-02 / 50% / 1,200 by that text — QA 2026-11-16)
      if (te.owns(part, p.r, p.c)) {
        const shown = typeof n?.v === "number" ? formatValue(n.v, sh.styles[n.s ?? 0]?.fmt, { date1904: sh.date1904, lang: sh.lang ?? "en" }).text : n?.v;
        te.edit(part, p.r, p.c, headerText(shown, n?.f, n?.t === "e"));
      }
    }
    if (w?.f && !n?.f) formulaGone = true;
    if (vChanged) values = true;
    dirty.add(a);
  }
  for (const a of force ?? []) if (sh.cells[a] || o.cells[a]) dirty.add(a);
  // array / data-table formulas cannot be changed in part: an array formula's range is rewritten only with its anchor,
  // or where its cells hold values it spilled (recalculated)
  for (const m of xml.matchAll(/<(?:\w+:)?f\b[^>]*\st="(?:array|dataTable)"[^>]*>/g)) {
    const g = parseRange(attrOf(m[0], "ref") ?? "");
    if (!g) continue;
    const anchor = addr(g.r0, g.c0);
    const array = /\st="array"/.test(m[0]);
    for (const a of dirty) {
      const p = parseAddr(a)!;
      if (p.r < g.r0 || p.r > g.r1 || p.c < g.c0 || p.c > g.c1) continue;
      if (array && (dirty.has(anchor) || (sh.cells[a]?.sp === anchor && spilledAsCalculated(anchor, a)))) continue;
      throw new SurgeryUnavailable("array formula");
    }
  }
  // the original cell elements by address
  const rowEls = childrenOf(xml, sheetData).filter((c) => c.local === "row");
  const byRow = new Map<number, XmlEl>();
  const cellEls = new Map<string, XmlEl>();
  let auto = 0;
  for (const r of rowEls) {
    const n = Number(attrOf(xml.slice(r.start, r.openEnd), "r") ?? auto + 1);
    auto = n;
    byRow.set(n - 1, r);
    let ac = 0;
    for (const c of childrenOf(xml, r).filter((k) => k.local === "c")) {
      const p = parseAddr(attrOf(xml.slice(c.start, c.openEnd), "r") ?? "");
      const col = p ? p.c : ac;
      ac = col + 1;
      cellEls.set(addr(n - 1, col), c);
    }
  }
  // a changed master of a shared formula: every cell of its group is written out with its own formula
  for (const a of [...dirty]) {
    const el = cellEls.get(a);
    const m = el && /<(?:\w+:)?f\b[^>]*\st="shared"[^>]*\sref="[^"]*"[^>]*>/.exec(xml.slice(el.start, el.end));
    if (!m) continue;
    const si = attrOf(m[0], "si");
    for (const [b, e] of cellEls) if (new RegExp(`<(?:\\w+:)?f\\b[^>]*\\bsi="${si}"`).test(xml.slice(e.start, e.end))) dirty.add(b);
  }
  // rows to rebuild
  const touched = new Map<number, Set<number>>();
  for (const a of dirty) {
    const p = parseAddr(a)!;
    const s = touched.get(p.r) ?? new Set<number>();
    s.add(p.c);
    touched.set(p.r, s);
  }
  const newRows = new Map<number, string>();
  for (const [r, cols] of touched) {
    const el = byRow.get(r);
    const out: { c: number; x: string }[] = [];
    if (el) {
      let ac = 0;
      for (const c of childrenOf(xml, el).filter((k) => k.local === "c")) {
        const tag = xml.slice(c.start, c.openEnd);
        const p = parseAddr(attrOf(tag, "r") ?? "");
        const col = p ? p.c : ac;
        ac = col + 1;
        if (cols.has(col)) continue;
        // a cell kept as it was; one written without an address gets it (cells before it may be left out now)
        const text = xml.slice(c.start, c.end);
        out.push({ c: col, x: p ? text : text.replace(/^<([\w:]+)/, `<$1 r="${addr(r, col)}"`) });
      }
    }
    for (const c of cols) {
      const a = addr(r, c);
      const cell = sh.cells[a];
      const x = cellXml(px, a, xfOf(cell?.s), cell, isDynamicAnchor(cell) ? cmOf() : undefined);
      if (x) out.push({ c, x });
    }
    out.sort((p, q) => p.c - q.c);
    const body = out.map((o2) => o2.x).join("");
    if (el) {
      const tag = xml.slice(el.start, el.openEnd).replace(/\sspans="[^"]*"/, "");
      const open = el.openEnd === el.end ? tag.slice(0, -2).trimEnd() + ">" : tag;
      newRows.set(r, `${open}${body}</${el.name}>`);
    } else if (body) newRows.set(r, `<${px}row r="${r + 1}">${body}</${px}row>`);
  }
  // row heights / hidden rows changed
  for (const r of new Set([...Object.keys(sh.rowH), ...Object.keys(o.rowH), ...Object.keys(sh.rowLevel ?? {}), ...Object.keys(o.rowLevel ?? {})].map(Number).concat(sh.hiddenRows ?? [], o.hiddenRows ?? []))) {
    if (sh.rowH[r] === o.rowH[r] && !!sh.rowAuto?.[r] === !!o.rowAuto?.[r] && !!sh.hiddenRows?.includes(r) === !!o.hiddenRows?.includes(r) && (sh.rowLevel?.[r] ?? 0) === (o.rowLevel?.[r] ?? 0)) continue;
    const el = byRow.get(r);
    const cur = newRows.get(r) ?? (el ? xml.slice(el.start, el.end) : `<${px}row r="${r + 1}"></${px}row>`);
    const open = /^<[^>]*>/.exec(cur)![0];
    // (only hidden / shown: the row's own ht and customHeight stay as they are — a row Excel fitted to its text keeps
    // its exact height and no customHeight)
    const sized = sh.rowH[r] !== o.rowH[r] || !!sh.rowAuto?.[r] !== !!o.rowAuto?.[r];
    let tag = open.replace(sized ? /\s(ht|customHeight|hidden|outlineLevel)="[^"]*"/g : /\s(hidden|outlineLevel)="[^"]*"/g, "");
    const h = sh.rowH[r];
    const lv = sh.rowLevel?.[r];
    const extra = `${sized && h != null ? ` ht="${Math.round(((h * 72) / 96) * 100) / 100}"${sh.rowAuto?.[r] ? "" : ' customHeight="1"'}` : ""}${sh.hiddenRows?.includes(r) ? ' hidden="1"' : ""}${lv ? ` outlineLevel="${lv}"` : ""}`;
    tag = tag.replace(/(\/?)>$/, `${extra}$1>`);
    newRows.set(r, tag + cur.slice(open.length));
  }
  let out = xml;
  if (newRows.size) {
    const fresh = [...newRows.keys()].filter((n) => !byRow.has(n)).sort((a, b) => a - b);
    let body = "";
    let at = sheetData.openEnd;
    let fi = 0;
    const flush = (upTo: number) => {
      while (fi < fresh.length && fresh[fi] < upTo) body += newRows.get(fresh[fi++])!;
    };
    if (sheetData.openEnd === sheetData.end) {
      flush(Infinity);
      const open = xml.slice(sheetData.start, sheetData.end - 2).trimEnd() + ">";
      out = xml.slice(0, sheetData.start) + open + body + `</${sheetData.name}>` + xml.slice(sheetData.end);
    } else {
      for (const [n, el] of [...byRow.entries()].sort((a, b) => a[1].start - b[1].start)) {
        body += xml.slice(at, el.start);
        flush(n);
        body += newRows.get(n) ?? xml.slice(el.start, el.end);
        at = el.end;
      }
      flush(Infinity);
      body += xml.slice(at, sheetData.closeStart);
      out = xml.slice(0, sheetData.openEnd) + body + xml.slice(sheetData.closeStart);
    }
  }
  // column widths / hidden columns
  const colsChanged = JSON.stringify([sh.colW, sh.hiddenCols ?? [], sh.colLevel ?? {}]) !== JSON.stringify([o.colW, o.hiddenCols ?? [], o.colLevel ?? {}]);
  // the outline depths Excel sizes its outline bar by
  if (JSON.stringify([sh.rowLevel ?? {}, sh.colLevel ?? {}]) !== JSON.stringify([o.rowLevel ?? {}, o.colLevel ?? {}]))
    out = out.replace(/<((?:\w+:)?sheetFormatPr)\b([^>]*?)(\/?)>/, (_m, n: string, a: string, sl: string) => `<${n}${a.replace(/\soutlineLevel(Row|Col)="[^"]*"/g, "")}${outlineAttrs(sh)}${sl}>`);
  if (colsChanged) {
    const r2 = rootOf(out);
    const k2 = childrenOf(out, r2);
    const cols = k2.find((c) => c.local === "cols");
    // the widths the file wrote, by column
    const was = new Map<number, string>();
    for (const m of cols ? out.slice(cols.start, cols.end).matchAll(/<(?:\w+:)?col\b[^>]*>/g) : []) {
      const lo = Number(attrOf(m[0], "min")), hi = Number(attrOf(m[0], "max")), wv = attrOf(m[0], "width");
      if (wv == null || !(lo >= 1) || !(hi >= lo)) continue;
      for (let c = lo; c <= Math.min(hi, lo + 1024); c++) was.set(c - 1, wv);
    }
    const xmlCols = colsXml(sh, sh.mdw, xfOf, (c) => was.get(c)).replace(/<(\/?)(cols?)\b/g, `<$1${px}$2`);
    if (cols) out = out.slice(0, cols.start) + xmlCols + out.slice(cols.end);
    else {
      const sd = k2.find((c) => c.local === "sheetData")!;
      out = out.slice(0, sd.start) + xmlCols + out.slice(sd.start);
    }
  }
  // merges
  if (JSON.stringify(sh.merges) !== JSON.stringify(o.merges)) {
    const r2 = rootOf(out);
    const k2 = childrenOf(out, r2);
    const mc = k2.find((c) => c.local === "mergeCells");
    const xmlM = sh.merges.length ? `<${px}mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<${px}mergeCell ref="${m}"/>`).join("")}</${px}mergeCells>` : "";
    if (mc) out = out.slice(0, mc.start) + xmlM + out.slice(mc.end);
    else if (xmlM) {
      // CT_Worksheet order: … sheetData sheetCalcPr sheetProtection protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells …
      const before = ["sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews"];
      const last = [...k2].reverse().find((c) => before.includes(c.local))!;
      out = out.slice(0, last.end) + xmlM + out.slice(last.end);
    }
  }
  return { xml: out, formulaGone, values };
}

/** Save sheet pages as .xlsx: into the original when they came from one, else (or when that cannot be done) fresh. */
export function saveSheetBook(pages: Page[], fresh: () => Uint8Array): Uint8Array {
  const meta = pages.find((p) => p.sheet && p.source?.office)?.source?.office;
  if (meta) {
    try {
      return saveSheetSurgical(pages, meta).bytes;
    } catch (e) {
      if (!(e instanceof SurgeryUnavailable)) throw e;
    }
  }
  return fresh();
}

export { colLetters };
