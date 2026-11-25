// Slicers (삽입 ▸ 슬라이서, Excel 2010+ / table slicers Excel 2013+): read from a workbook and written for the ones
// made here. A slicer is three things in the package —
//   the sheet's slicer part   xl/slicers/slicerN.xml   (name, caption, its cache), listed in the sheet's extLst
//   its drawing anchor        a graphicFrame (sle:slicer) in mc:AlternateContent of the sheet's drawing part
//   the workbook's cache      xl/slicerCaches/slicerCacheN.xml (the source: a table column — x15:tableSlicerCache — or
//                             a pivot field with its items and which are selected), listed in the workbook's extLst
//                             and named by a defined name (#N/A) as Excel writes it
// A table slicer's pick is the table's own AutoFilter on that column; a pivot slicer's, the pivot field's hidden items
// (pivotField items h="1") and the cache's items (s="1" selected). Layout checked against files Excel 365 wrote.
// Omniweave's own implementation.

import type { SheetAnchor, SheetData, SheetSlicer } from "../../core/sheetTypes";
import { attr, descendants, parseXml } from "../xml";
import { esc } from "../xml";
import { partRels } from "./readExtra";
import { placeChildren } from "./writeParts";
import type { PkgRels } from "./writeDrawings";

const X14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main";
const X15 = "http://schemas.microsoft.com/office/spreadsheetml/2010/11/main";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const SLICER_REL = "http://schemas.microsoft.com/office/2007/relationships/slicer";
export const SLICER_CACHE_REL = "http://schemas.microsoft.com/office/2007/relationships/slicerCache";
const SLICER_CT = "application/vnd.ms-excel.slicer+xml";
export const SLICER_CACHE_CT = "application/vnd.ms-excel.slicerCache+xml";
const DRAWING_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const DRAWING_CT = "application/vnd.openxmlformats-officedocument.drawing+xml";
/** worksheet extLst: a table slicer list (x15) / a pivot slicer list (x14) */
const EXT_TABLE = "{3A4CF648-6AED-40f4-86FF-DC5316D8AED3}", EXT_PIVOT = "{A8765BA9-456A-4dab-B4F3-ACF838C121DE}";
/** workbook extLst: table slicer caches (x15) / pivot slicer caches (x14) */
const WB_TABLE = "{46BE6895-7355-4a93-B00E-2C351335B9C9}", WB_PIVOT = "{BBE1A952-AA13-448e-AADC-164F8A28A991}";
const EMU = 9525;

// ───── read ─────

/**
 * The slicers of the book's sheets (after the sheets, tables and pivots are read): their parts through the sheets'
 * relationships, their caches through the workbook's, their anchors from the drawing part (drawings.ts keeps them by
 * name in `slicerAt`).
 */
export function readSlicers(sheets: SheetData[], read: (p: string) => string | undefined) {
  const wbRels = partRels("xl/workbook.xml", read);
  const caches = new Map<string, Element>();
  for (const r of wbRels.values()) {
    if (r.type !== "slicerCache") continue;
    const x = read(r.target);
    if (!x) continue;
    const root = parseXml(x).documentElement;
    const name = attr(root, "name");
    if (name) caches.set(name, root);
  }
  if (!caches.size) {
    for (const sh of sheets) delete (sh as { slicerAt?: unknown }).slicerAt;
    return;
  }
  const wb = read("xl/workbook.xml") ?? "";
  const tabIds = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*\ssheetId="(\d+)"/g)].map((m) => Number(m[1]));
  for (const sh of sheets) {
    const at = (sh as { slicerAt?: Record<string, SheetAnchor> }).slicerAt ?? {};
    delete (sh as { slicerAt?: unknown }).slicerAt;
    if (!sh.part) continue;
    const out: SheetSlicer[] = [];
    for (const r of partRels(sh.part, read).values()) {
      if (r.type !== "slicer") continue;
      const x = read(r.target);
      if (!x) continue;
      for (const s of descendants(parseXml(x).documentElement, "slicer")) {
        const name = attr(s, "name") ?? "", cache = attr(s, "cache") ?? "";
        const c = caches.get(cache);
        if (!name || !c) continue;
        const caption = attr(s, "caption") ?? name;
        const src = attr(c, "sourceName") ?? "";
        const tsc = descendants(c, "tableSlicerCache")[0];
        let source: SheetSlicer["source"] | null = null;
        if (tsc) {
          const tid = Number(attr(tsc, "tableId")), col = Number(attr(tsc, "column"));
          const table = sheets.flatMap((x2) => x2.tables ?? []).find((t) => t.id === tid);
          if (table) source = { table: table.name, col: table.cols[col - 1] ?? src };
        } else {
          const pt = descendants(c, "pivotTable")[0];
          const tab = Number(pt && attr(pt, "tabId")), pname = pt && attr(pt, "name");
          const psheet = sheets[tabIds.indexOf(tab)];
          const p = psheet?.pivots?.find((x2) => x2.name === pname);
          if (psheet && p) source = { pivotSheet: psheet.name, pivotAt: p.at, field: src };
        }
        if (!source) continue;
        out.push({ name, cache, caption, source, at: at[name] ?? { c0: 0, x0: 0, r0: 0, y0: 0, w: 192, h: 200 }, fromFile: true });
      }
    }
    if (out.length) sh.slicers = out;
  }
}

// ───── write ─────

/** A slicer cache the workbook must list (made for a new slicer). */
export interface SlicerCacheOut {
  name: string;
  /** the column / field name */
  source: string;
  table?: string;
  /** 1-based column of the table */
  col?: number;
  pivot?: { sheet: string; at: string };
}

/** The drawing anchor of a slicer (an mc:AlternateContent graphicFrame; the fallback box says it needs Excel 2010+). */
function anchorXml(s: SheetSlicer, id: number, table: boolean): string {
  const a = s.at;
  const pos = (c: number, x: number, r: number, y: number) => `<xdr:col>${c}</xdr:col><xdr:colOff>${Math.round(x * EMU)}</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>${Math.round(y * EMU)}</xdr:rowOff>`;
  const from = pos(a.c0, a.x0, a.r0, a.y0);
  const to = a.c1 != null ? pos(a.c1, a.x1 ?? 0, a.r1 ?? a.r0, a.y1 ?? 0) : null;
  const req = table ? `xmlns:sle15="http://schemas.microsoft.com/office/drawing/2012/slicer" Requires="sle15"` : `xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"`;
  const body =
    `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice ${req}><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${esc(s.name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2010/slicer"><sle:slicer xmlns:sle="http://schemas.microsoft.com/office/drawing/2010/slicer" name="${esc(s.name)}"/></a:graphicData></a:graphic></xdr:graphicFrame></mc:Choice>` +
    `<mc:Fallback><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="0" name=""/><xdr:cNvSpPr><a:spLocks noTextEdit="1"/></xdr:cNvSpPr></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round((a.w ?? 192) * EMU)}" cy="${Math.round((a.h ?? 200) * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:prstClr val="white"/></a:solidFill><a:ln w="1"><a:solidFill><a:prstClr val="green"/></a:solidFill></a:ln></xdr:spPr>` +
    `<xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100"/><a:t>This shape represents a ${table ? "table " : ""}slicer. Slicers are supported in Excel ${table ? "2013" : "2010"} or later.</a:t></a:r></a:p></xdr:txBody></xdr:sp></mc:Fallback></mc:AlternateContent><xdr:clientData/>`;
  return to ? `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${from}</xdr:from><xdr:to>${to}</xdr:to>${body}</xdr:twoCellAnchor>` : `<xdr:oneCellAnchor><xdr:from>${from}</xdr:from><xdr:ext cx="${Math.round((a.w ?? 192) * EMU)}" cy="${Math.round((a.h ?? 200) * EMU)}"/>${body}</xdr:oneCellAnchor>`;
}

/** The worksheet's extLst with a slicer list added (other extensions kept). */
function addExt(xml: string, px: string, uri: string, rids: string[], table: boolean): string {
  const list = `<x14:slicerList${table ? ` xmlns:x14="${X14}"` : ""}>${rids.map((r) => `<x14:slicer r:id="${r}"/>`).join("")}</x14:slicerList>`;
  const ext = table ? `<${px}ext uri="${uri}" xmlns:x15="${X15}">${list}</${px}ext>` : `<${px}ext uri="${uri}" xmlns:x14="${X14}">${list}</${px}ext>`;
  const lst = /<((?:\w+:)?extLst)>([\s\S]*?)<\/\1>/.exec(xml);
  if (lst) return xml.slice(0, lst.index) + `<${lst[1]}>${lst[2]}${ext}</${lst[1]}>` + xml.slice(lst.index + lst[0].length);
  return placeChildren(xml, "extLst", [`<${px}extLst>${ext}</${px}extLst>`]);
}

/**
 * The slicers made here on this sheet (not in the original `o`, not read from the file) written: slicer parts (one for
 * table slicers, one for pivot slicers), their anchors in the sheet's drawing part (made when there is none) and the
 * worksheet's slicer lists. Returns the caches the workbook must list.
 */
export function writeNewSlicers(xml: string, sh: SheetData, o: SheetData | null, pkg: PkgRels, sheets: readonly SheetData[]): { xml: string; caches: SlicerCacheOut[] } {
  const had = new Set((o?.slicers ?? []).map((s) => s.name));
  // slicers of the file moved here (dragged, or lines inserted / deleted before them): their anchors written again
  const moved = (sh.slicers ?? []).filter((s) => s.fromFile && JSON.stringify(o?.slicers?.find((x) => x.name === s.name)?.at ?? null) !== JSON.stringify(s.at));
  if (moved.length) {
    const dr = pkg.rels(pkg.part).find((r) => /drawing$/.test(r.type) && !/vmlDrawing/.test(r.type))?.target;
    const dxx = dr ? pkg.getPart(dr) : null;
    if (dr && dxx) {
      let out = dxx;
      for (const s of moved) {
        const re = /<((?:\w+:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor))\b[^>]*>[\s\S]*?<\/\1>/g;
        out = out.replace(re, (el) => {
          if (!el.includes(`name="${esc(s.name)}"`) || !/graphicData uri="[^"]*\/slicer"/.test(el)) return el;
          const id = Number(/<(?:\w+:)?cNvPr\b[^>]*\sid="(\d+)"/.exec(el)?.[1] ?? 2);
          return anchorXml(s, id, "table" in s.source);
        });
      }
      if (out !== dxx) pkg.setPart(dr, out);
    }
  }
  const add = (sh.slicers ?? []).filter((s) => !s.fromFile && !had.has(s.name));
  if (!add.length) return { xml, caches: [] };
  const px = /<(\w+:)?worksheet\b/.exec(xml)?.[1] ?? "";
  if (!/<(?:\w+:)?worksheet\b[^>]*\sxmlns:r=/.test(xml)) xml = xml.replace(/<((?:\w+:)?worksheet)\b/, `<$1 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`);
  const caches: SlicerCacheOut[] = [];
  // the drawing part: the sheet's own, or a new one
  let drawing = pkg.rels(pkg.part).find((r) => /drawing$/.test(r.type) && !/vmlDrawing/.test(r.type))?.target ?? null;
  let dx = drawing ? pkg.getPart(drawing) : null;
  if (!drawing || !dx) {
    drawing = pkg.freeName((n) => `xl/drawings/drawing${n}.xml`);
    dx = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>`;
    const rid = pkg.addRel(pkg.part, DRAWING_REL, drawing);
    pkg.setPart(drawing, dx, DRAWING_CT);
    xml = placeChildren(xml, "drawing", [`<${px}drawing r:id="${rid}"/>`]);
  }
  let id = Math.max(1, ...[...dx.matchAll(/<(?:\w+:)?cNvPr\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const anchors: string[] = [];
  for (const kind of ["table", "pivot"] as const) {
    const list = add.filter((s) => ("table" in s.source) === (kind === "table"));
    if (!list.length) continue;
    const part = pkg.freeName((n) => `xl/slicers/slicer${n}.xml`);
    pkg.setPart(
      part,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<slicers xmlns="${X14}" xmlns:mc="${MC}" mc:Ignorable="x" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        list.map((s) => `<slicer name="${esc(s.name)}" cache="${esc(s.cache)}" caption="${esc(s.caption)}" rowHeight="241300"/>`).join("") +
        `</slicers>`,
      SLICER_CT,
    );
    const rid = pkg.addRel(pkg.part, SLICER_REL, part);
    xml = addExt(xml, px, kind === "table" ? EXT_TABLE : EXT_PIVOT, [rid], kind === "table");
    for (const s of list) {
      anchors.push(anchorXml(s, id++, kind === "table"));
      if ("table" in s.source) {
        const src = s.source;
        const tb = sheets.flatMap((x) => x.tables ?? []).find((t) => t.name === src.table);
        caches.push({ name: s.cache, source: src.col, table: src.table, col: (tb?.cols.indexOf(src.col) ?? -1) + 1 });
      } else caches.push({ name: s.cache, source: s.source.field, pivot: { sheet: s.source.pivotSheet, at: s.source.pivotAt } });
    }
  }
  pkg.setPart(drawing, dx.replace(/<\/((?:\w+:)?wsDr)>\s*$/, `${anchors.join("")}</$1>`));
  return { xml, caches };
}

/** What a pivot slicer's cache needs of its pivot table as written (io/sheet/pivots.ts writeNewPivots). */
export interface PivotForSlicer {
  sheet: string;
  at: string;
  /** the sheet's sheetId, the pivot table's name, the cache's x14 pivotCacheId */
  tabId: number;
  name: string;
  x14: number;
  /** each field's shared items as written, and which are hidden */
  items: Map<string, string[]>;
  shown: (field: string) => Set<string> | null;
}

/** The slicer cache part of a cache. */
export function slicerCacheXml(c: SlicerCacheOut, tableId: (name: string) => number | null, pivot: (sheet: string, at: string) => PivotForSlicer | null): string | null {
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<slicerCacheDefinition xmlns="${X14}" xmlns:mc="${MC}" mc:Ignorable="x" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="${esc(c.name)}" sourceName="${esc(c.source)}">`;
  if (c.table) {
    const id = tableId(c.table);
    if (id == null || !c.col) return null;
    return head + `<extLst><x:ext uri="{2F2917AC-EB37-4324-AD4E-5DD8C200BD13}" xmlns:x15="${X15}"><x15:tableSlicerCache tableId="${id}" column="${c.col}"/></x:ext></extLst></slicerCacheDefinition>`;
  }
  const p = c.pivot && pivot(c.pivot.sheet, c.pivot.at);
  if (!p) return null;
  const items = p.items.get(c.source) ?? [];
  const shown = p.shown(c.source);
  return (
    head +
    `<pivotTables><pivotTable tabId="${p.tabId}" name="${esc(p.name)}"/></pivotTables><data><tabular pivotCacheId="${p.x14}"><items count="${items.length}">` +
    items.map((v, i) => `<i x="${i}"${!shown || shown.has(v) ? ' s="1"' : ""}/>`).join("") +
    `</items></tabular></data></slicerCacheDefinition>`
  );
}

/** workbook.xml with the slicer caches listed (extLst) and named (definedName #N/A), as Excel writes them. */
export function listSlicerCaches(wb: string, list: { name: string; rid: string; table: boolean }[]): string {
  if (!list.length) return wb;
  const px = /<(\w+:)?workbook\b/.exec(wb)?.[1] ?? "";
  // names
  const names = list.map((c) => `<${px}definedName name="${esc(c.name)}">#N/A</${px}definedName>`).join("");
  const close = /<\/(?:\w+:)?definedNames>/.exec(wb);
  if (close) wb = wb.slice(0, close.index) + names + wb.slice(close.index);
  else {
    const after = /<\/(?:\w+:)?externalReferences>/.exec(wb) ?? /<\/(?:\w+:)?functionGroups>/.exec(wb) ?? /<\/(?:\w+:)?sheets>/.exec(wb);
    if (after) wb = wb.slice(0, after.index + after[0].length) + `<${px}definedNames>${names}</${px}definedNames>` + wb.slice(after.index + after[0].length);
  }
  // caches in extLst (pivot caches x14, table caches x15)
  const exts: string[] = [];
  const pv = list.filter((c) => !c.table), tb = list.filter((c) => c.table);
  if (pv.length) exts.push(`<${px}ext uri="${WB_PIVOT}" xmlns:x14="${X14}"><x14:slicerCaches>${pv.map((c) => `<x14:slicerCache r:id="${c.rid}"/>`).join("")}</x14:slicerCaches></${px}ext>`);
  if (tb.length) exts.push(`<${px}ext uri="${WB_TABLE}" xmlns:x15="${X15}"><x15:slicerCaches xmlns:x14="${X14}">${tb.map((c) => `<x14:slicerCache r:id="${c.rid}"/>`).join("")}</x15:slicerCaches></${px}ext>`);
  const lst = /<((?:\w+:)?extLst)>([\s\S]*?)<\/\1>/.exec(wb);
  if (lst) return wb.slice(0, lst.index) + `<${lst[1]}>${exts.join("")}${lst[2]}</${lst[1]}>` + wb.slice(lst.index + lst[0].length);
  const end = /<\/(?:\w+:)?workbook>\s*$/.exec(wb);
  return end ? wb.slice(0, end.index) + `<${px}extLst>${exts.join("")}</${px}extLst>` + wb.slice(end.index) : wb;
}

/** The items a slicer lists (distinct shown texts of its column / field) — for the screen. */
export function slicerAnchorDefault(r: number, c: number): SheetAnchor {
  return { c0: c, x0: 8, r0: r, y0: 4, w: 192, h: 220 };
}
