// Pivot tables in the package (피벗 테이블 부품, ECMA-376 Part 1 §18.10): reading a workbook's own pivot tables into
// pivot specs (source, row / column fields, value fields with their summary) so they can be refreshed here, and writing
// the ones made here as real Excel pivot tables — pivotCacheDefinition (shared items of the row / column fields),
// pivotCacheRecords and pivotTableDefinition, refreshOnLoad so Excel rebuilds them from the source when it opens the
// file. A file pivot refreshed here gets its location and refreshOnLoad set; everything else of it stays as Excel wrote it.

import type { SheetData, SheetPivot } from "../../core/sheetTypes";
import { attr, child, children, descendants, parseXml } from "../xml";
import { esc } from "../xml";
import { addr, parseRange } from "./formula";
import { partRels } from "./readExtra";
import type { PkgRels } from "./writeDrawings";
const unesc = (v: string) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
import { t } from "../../i18n";

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const CT = {
  table: "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml",
  def: "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml",
  rec: "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml",
};
const xmlText = (s: string) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ""));
const FNS = ["sum", "count", "average", "max", "min", "product", "countNums", "stdDev", "stdDevp", "var", "varp"];

// ───── reading ─────

/** Pivot caches of the workbook: cacheId → definition part. */
export function pivotCacheParts(wb: Document, wbRels: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const pc of descendants(wb, "pivotCache")) {
    const id = attr(pc, "cacheId"), rid = attr(pc, "r:id") ?? attr(pc, "id");
    const p = rid ? wbRels.get(rid) : undefined;
    if (id != null && p) out.set(id, p);
  }
  return out;
}

/** The pivot tables of a worksheet as specs (a pivot whose source or summaries cannot be redone here is left out). */
export function readPivots(sh: SheetData, part: string, read: (p: string) => string | undefined, caches: Map<string, string>): void {
  const list: SheetPivot[] = [];
  for (const rel of partRels(part, read).values()) {
    if (rel.type !== "pivotTable" || rel.external) continue;
    const x = read(rel.target);
    if (!x) continue;
    const t = parseXml(x).documentElement;
    const cachePart = caches.get(attr(t, "cacheId") ?? "");
    const cx = cachePart ? read(cachePart) : undefined;
    if (!cx || !cachePart) continue;
    const c = parseXml(cx).documentElement;
    const ws = descendants(c, "worksheetSource")[0];
    const src = ws && attr(ws, "sheet"), ref = ws && attr(ws, "ref");
    if (!src || !ref) continue;
    const names = descendants(c, "cacheField").map((f) => attr(f, "name") ?? "");
    const fields = (el: string) => (child(t, el) ? children(child(t, el)!, "field").map((f) => Number(attr(f, "x"))).filter((n) => n >= 0).map((n) => names[n]) : []);
    const vals: SheetPivot["vals"] = [];
    let ok = true;
    for (const df of descendants(t, "dataField")) {
      const fn = (attr(df, "subtotal") ?? "sum") as SheetPivot["vals"][number]["fn"];
      if (!FNS.includes(fn)) ok = false;
      vals.push({ field: names[Number(attr(df, "fld"))] ?? "", fn });
    }
    // filter (page) fields: the field and, when one item is picked, its value (the pivot field's item → shared item)
    const cacheFields = descendants(c, "cacheField");
    const pivotFields = child(t, "pivotFields") ? children(child(t, "pivotFields")!, "pivotField") : [];
    const pages: NonNullable<SheetPivot["pages"]> = [];
    for (const pf of descendants(t, "pageField")) {
      const fld = Number(attr(pf, "fld"));
      const it = attr(pf, "item");
      let item: string | undefined;
      if (it != null) {
        const pi = pivotFields[fld] && child(pivotFields[fld], "items") ? children(child(pivotFields[fld], "items")!, "item")[Number(it)] : undefined;
        const si = cacheFields[fld] && child(cacheFields[fld], "sharedItems") ? children(child(cacheFields[fld], "sharedItems")!)[Number(pi ? attr(pi, "x") : it)] : undefined;
        item = si ? (si.localName === "m" ? "" : attr(si, "v") ?? "") : undefined;
      }
      pages.push({ field: names[fld] ?? "", ...(item != null ? { item } : {}) });
    }
    // items hidden in a field (a slicer's or the field filter's pick): the items shown, by their shared item text
    const show: Record<string, string[]> = {};
    pivotFields.forEach((pf, k) => {
      const its = child(pf, "items") ? children(child(pf, "items")!, "item").filter((i) => attr(i, "x") != null) : [];
      if (!its.some((i) => /^(1|true)$/.test(attr(i, "h") ?? ""))) return;
      const shared = cacheFields[k] && child(cacheFields[k], "sharedItems") ? children(child(cacheFields[k], "sharedItems")!) : [];
      show[names[k]] = its.filter((i) => !/^(1|true)$/.test(attr(i, "h") ?? "")).map((i) => shared[Number(attr(i, "x"))]).filter(Boolean).map((si) => (si.localName === "m" ? "" : attr(si, "v") ?? ""));
    });
    const loc = child(t, "location");
    const out = loc && attr(loc, "ref");
    const g = out ? parseRange(out) : null;
    if (!ok || !g || !vals.length) continue;
    const top = pages.length ? Math.max(0, g.r0 - pages.length - 1) : g.r0;
    list.push({ sheet: src, ref: ref.replace(/\$/g, ""), at: addr(top, g.c0), rows: fields("rowFields"), cols: fields("colFields"), vals, ...(pages.length ? { pages, area: `${addr(top, g.c0)}:${addr(g.r1, g.c1)}` } : {}), out: out ?? undefined, part: rel.target, cachePart, name: attr(t, "name") ?? undefined, ...(Object.keys(show).length ? { show } : {}) });
  }
  if (list.length) sh.pivots = list;
}

// ───── writing ─────

type Val = string | number | null;

/** The source range's header names and rows of values (numbers kept as numbers). */
function source(sheets: SheetData[], p: SheetPivot): { head: string[]; rows: Val[][]; ref: string } | null {
  const src = sheets.find((s) => s.name === p.sheet);
  const g = parseRange(p.ref);
  if (!src || !g || g.r1 <= g.r0) return null;
  const head: string[] = [];
  for (let c = g.c0; c <= g.c1; c++) head.push(String(src.cells[addr(g.r0, c)]?.v ?? ""));
  const rows: Val[][] = [];
  for (let r = g.r0 + 1; r <= g.r1; r++) {
    const row: Val[] = [];
    for (let c = g.c0; c <= g.c1; c++) {
      const v = src.cells[addr(r, c)]?.v;
      row.push(v === undefined || v === "" ? null : typeof v === "number" ? v : String(v));
    }
    rows.push(row);
  }
  return { head, rows, ref: p.ref };
}

/** Can this pivot be written as a real Excel pivot table (any row / column / filter fields, one or more values)? */
export const realPivot = (p: SheetPivot) => p.vals.length > 0;

const sortKey = (a: Val, b: Val) => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? "")));

/**
 * Pivot tables made on this sheet written as Excel pivot tables (parts and relationships through `pkg`); returns the
 * caches the workbook must list (<pivotCaches>). `display` = what each shows as the data caption.
 */
/** A pivot table written here, for the workbook (<pivotCaches>) and its slicers' caches (io/sheet/slicers.ts). */
export interface NewPivot {
  cacheId: number;
  def: string;
  name: string;
  at: string;
  /** x14 pivotCacheId (written when a slicer uses the pivot) */
  x14?: number;
  items: Map<string, string[]>;
  shown: (field: string) => Set<string> | null;
}

export function writeNewPivots(sh: SheetData, sheets: readonly SheetData[], pkg: PkgRels, nextCacheId: () => number): NewPivot[] {
  const out: NewPivot[] = [];
  let n = 0;
  for (const p of sh.pivots ?? []) {
    if (p.part || !realPivot(p) || !p.out) continue;
    const data = source(sheets as SheetData[], p);
    if (!data) continue;
    const idx = (f: string) => data.head.indexOf(f);
    const axis = new Map<number, "axisRow" | "axisCol" | "axisPage">([...p.rows.map((f) => [idx(f), "axisRow"] as [number, "axisRow"]), ...p.cols.map((f) => [idx(f), "axisCol"] as [number, "axisCol"]), ...(p.pages ?? []).map((x) => [idx(x.field), "axisPage"] as [number, "axisPage"])]);
    if ([...axis.keys(), ...p.vals.map((v) => idx(v.field))].some((k) => k < 0)) continue;
    // fields a slicer filters, and fields with items picked (p.show): their items are listed too
    const slicerFields = sheets.flatMap((x) => x.slicers ?? []).flatMap((x) => ("pivotAt" in x.source && x.source.pivotSheet === sh.name && x.source.pivotAt === p.at ? [x.source.field] : []));
    const listed = new Set([...axis.keys(), ...[...slicerFields, ...Object.keys(p.show ?? {})].map(idx).filter((k) => k >= 0)]);
    // shared items of the axis (and listed) fields, sorted as the table shows them
    const items = new Map<number, Val[]>();
    for (const k of listed) items.set(k, [...new Set(data.rows.map((r) => r[k]))].sort(sortKey));
    const shownOf = (k: number) => {
      const pick = p.show?.[data.head[k]];
      return pick ? new Set(pick) : null;
    };
    const itemText = (v: Val) => (v == null ? "" : String(v));
    const fieldXml = data.head
      .map((name, k) => {
        const vs = data.rows.map((r) => r[k]);
        const it = items.get(k);
        const nums = vs.filter((v): v is number => typeof v === "number");
        const blank = vs.some((v) => v == null);
        if (it) {
          const allNum = it.every((v) => v == null || typeof v === "number");
          const attrs = allNum ? ` containsSemiMixedTypes="0" containsString="0" containsNumber="1"${nums.every(Number.isInteger) ? ' containsInteger="1"' : ""}${nums.length ? ` minValue="${Math.min(...nums)}" maxValue="${Math.max(...nums)}"` : ""}${blank ? ' containsBlank="1"' : ""}` : blank ? ' containsBlank="1"' : "";
          return `<cacheField name="${xmlText(name)}" numFmtId="0"><sharedItems${attrs} count="${it.length}">${it.map((v) => (v == null ? "<m/>" : typeof v === "number" ? `<n v="${v}"/>` : `<s v="${xmlText(v)}"/>`)).join("")}</sharedItems></cacheField>`;
        }
        if (nums.length && nums.length === vs.filter((v) => v != null).length)
          return `<cacheField name="${xmlText(name)}" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1"${nums.every(Number.isInteger) ? ' containsInteger="1"' : ""} minValue="${Math.min(...nums)}" maxValue="${Math.max(...nums)}"${blank ? ' containsBlank="1"' : ""}/></cacheField>`;
        return `<cacheField name="${xmlText(name)}" numFmtId="0"><sharedItems${nums.length ? ' containsMixedTypes="1"' : ""}${blank ? ' containsBlank="1"' : ""}/></cacheField>`;
      })
      .join("");
    const records = data.rows
      .map(
        (r) =>
          "<r>" +
          r
            .map((v, k) => {
              const it = items.get(k);
              if (it) return `<x v="${it.indexOf(v)}"/>`;
              return v == null ? "<m/>" : typeof v === "number" ? `<n v="${v}"/>` : `<s v="${xmlText(v)}"/>`;
            })
            .join("") +
          "</r>",
      )
      .join("");
    const cacheId = nextCacheId();
    const x14 = slicerFields.length ? 100000 + cacheId : undefined;
    // (a pivot a slicer filters is one of Excel 2010 or later: Excel drops the slicer of a version-3 pivot)
    const ver = x14 != null ? 7 : 3;
    const def = pkg.freeName((k) => `xl/pivotCache/pivotCacheDefinition${k}.xml`);
    const rec = def.replace("Definition", "Records");
    pkg.setPart(rec, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<pivotCacheRecords xmlns="${NS}" xmlns:r="${REL}" count="${data.rows.length}">${records}</pivotCacheRecords>`, CT.rec);
    const recRid = pkg.addRel(def, `${REL}/pivotCacheRecords`, rec);
    pkg.setPart(
      def,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<pivotCacheDefinition xmlns="${NS}" xmlns:r="${REL}" r:id="${recRid}" refreshOnLoad="1" createdVersion="3" refreshedVersion="${ver}" minRefreshableVersion="3" recordCount="${data.rows.length}">` +
        `<cacheSource type="worksheet"><worksheetSource ref="${data.ref}" sheet="${xmlText(p.sheet)}"/></cacheSource><cacheFields count="${data.head.length}">${fieldXml}</cacheFields>` +
        (x14 != null ? `<extLst><ext uri="{725AE2AE-9491-48be-B2B4-4EB974FC3084}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:pivotCacheDefinition pivotCacheId="${x14}"/></ext></extLst>` : "") +
        `</pivotCacheDefinition>`,
      CT.def,
    );
    // the table
    // rows, columns (Σ values among them when there are several), filters; the items of each line are left to
    // Excel, which lays the table out again on opening (refreshOnLoad)
    const many = p.vals.length > 1;
    const rowPart = p.rows.length ? `<rowFields count="${p.rows.length}">${p.rows.map((f) => `<field x="${idx(f)}"/>`).join("")}</rowFields>` : "";
    const colX = [...p.cols.map(idx), ...(many ? [-2] : [])];
    const colPart = colX.length ? `<colFields count="${colX.length}">${colX.map((x) => `<field x="${x}"/>`).join("")}</colFields>` : "";
    const pageItem = (x: { field: string; item?: string }) => {
      if (x.item == null) return "";
      const it = items.get(idx(x.field))!;
      const k = it.findIndex((v) => (v == null ? "" : String(v)) === x.item);
      return k >= 0 ? ` item="${k}"` : "";
    };
    const pagePart = p.pages?.length ? `<pageFields count="${p.pages.length}">${p.pages.map((x) => `<pageField fld="${idx(x.field)}"${pageItem(x)} hier="-1"/>`).join("")}</pageFields>` : "";
    const dataFields = `<dataFields count="${p.vals.length}">${p.vals.map((v) => `<dataField name="${xmlText(captionOf(v))}" fld="${idx(v.field)}"${v.fn === "sum" ? "" : ` subtotal="${v.fn}"`} baseField="0" baseItem="0"/>`).join("")}</dataFields>`;
    const firstDataRow = p.cols.length || many ? 2 : 1;
    const pages = p.pages?.length ? ` rowPageCount="${p.pages.length}" colPageCount="1"` : "";
    const pf = data.head
      .map((_, k) => {
        const ax = axis.get(k);
        const dataField = p.vals.some((v) => idx(v.field) === k) ? ' dataField="1"' : "";
        const it = items.get(k);
        if (!it) return `<pivotField${dataField} showAll="0"/>`;
        // items a slicer / field filter leaves out are hidden (h="1")
        const sh2 = shownOf(k);
        return `<pivotField${ax ? ` axis="${ax}"` : ""}${dataField} showAll="0"><items count="${it.length + 1}">${it.map((v, j) => `<item${sh2 && !sh2.has(itemText(v)) ? ' h="1"' : ""} x="${j}"/>`).join("")}<item t="default"/></items></pivotField>`;
      })
      .join("");
    const name = `PivotTable${++n + (sh.pivots ?? []).filter((x) => x.part).length}`;
    const tPath = pkg.freeName((k) => `xl/pivotTables/pivotTable${k}.xml`);
    pkg.setPart(
      tPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<pivotTableDefinition xmlns="${NS}" name="${name}" cacheId="${cacheId}" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="${ver}" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="3" indent="0" outline="1" outlineData="1" multipleFieldFilters="0">` +
        `<location ref="${p.out}" firstHeaderRow="1" firstDataRow="${firstDataRow}" firstDataCol="1"${pages}/><pivotFields count="${data.head.length}">${pf}</pivotFields>${rowPart}${colPart}${pagePart}${dataFields}` +
        `<pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>`,
      CT.table,
    );
    pkg.addRel(tPath, `${REL}/pivotCacheDefinition`, def);
    pkg.addRel(pkg.part, `${REL}/pivotTable`, tPath);
    out.push({
      cacheId,
      def,
      name,
      at: p.at,
      x14,
      items: new Map([...items].map(([k, v]) => [data.head[k], v.map(itemText)])),
      shown: (f) => {
        const k = idx(f);
        return k >= 0 ? shownOf(k) : null;
      },
    });
  }
  return out;
}

/** A value field's caption as Excel writes it in the reader's language ("합계 : Qty", "Sum of Qty"). */
const captionOf = (v: SheetPivot["vals"][number]) => t(`sheetx.pivot.fnOf.${v.fn}`, { field: v.field });

/**
 * File pivot tables refreshed here: their location follows the refreshed cells and the cache refreshes when Excel
 * opens the file (refreshOnLoad), so Excel's own table matches the source again.
 */
export function markRefreshed(sh: SheetData, o: SheetData, pkg: PkgRels) {
  for (const p of sh.pivots ?? []) {
    if (!p.part || !p.cachePart || !p.refreshed) continue;
    const was = o.pivots?.find((x) => x.part === p.part);
    const t = pkg.getPart(p.part);
    if (t && p.out && was?.out !== p.out) pkg.setPart(p.part, t.replace(/(<(?:\w+:)?location\b[^>]*\sref=")[^"]*"/, `$1${p.out}"`));
    const c = pkg.getPart(p.cachePart);
    if (c && !/\srefreshOnLoad="(1|true)"/.test(c)) pkg.setPart(p.cachePart, c.replace(/\srefreshOnLoad="[^"]*"/, "").replace(/<((?:\w+:)?pivotCacheDefinition)\b/, '<$1 refreshOnLoad="1"'));
  }
}

/**
 * File pivot tables whose items shown changed here (a slicer's pick, p.show): the pivot fields' items hidden (h="1")
 * as picked, and the slicer caches on those fields (by the pivot's name and the field) with the items selected (s="1").
 */
export function markShown(sh: SheetData, o: SheetData, pkg: PkgRels) {
  for (const p of sh.pivots ?? []) {
    if (!p.part || !p.cachePart) continue;
    const was = o.pivots?.find((x) => x.part === p.part);
    if (JSON.stringify(was?.show ?? {}) === JSON.stringify(p.show ?? {})) continue;
    const cx = pkg.getPart(p.cachePart), tx = pkg.getPart(p.part);
    if (!cx || !tx) continue;
    // the cache's fields and their shared items' texts
    const fields = [...cx.matchAll(/<(?:\w+:)?cacheField\b[^>]*\sname="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?cacheField>)/g)].map((m) => ({
      name: unesc(m[1]),
      items: [...(m[2] ?? "").matchAll(/<(?:\w+:)?(s|n|b|d|e|m)\b([^>]*?)\/?>/g)].map((x) => (x[1] === "m" ? "" : unesc(/\sv="([^"]*)"/.exec(x[2])?.[1] ?? ""))),
    }));
    const changed = new Set([...Object.keys(p.show ?? {}), ...Object.keys(was?.show ?? {})]);
    let t2 = tx;
    let k = -1;
    t2 = t2.replace(/<((?:\w+:)?pivotField)\b([^>]*?)(\/>|>[\s\S]*?<\/\1>)/g, (whole) => {
      k++;
      const f = fields[k];
      if (!f || !changed.has(f.name)) return whole;
      const pick = p.show?.[f.name];
      return whole.replace(/<((?:\w+:)?item)\b([^>]*?)\/>/g, (it, n: string, attrs: string) => {
        const x = /\sx="(\d+)"/.exec(attrs);
        if (!x) return it;
        const hide = !!pick && !pick.includes(f.items[Number(x[1])] ?? "");
        const rest = attrs.replace(/\sh="[^"]*"/, "");
        return `<${n}${hide ? ' h="1"' : ""}${rest}/>`;
      });
    });
    if (t2 !== tx) pkg.setPart(p.part, t2);
    // slicer caches on these fields
    for (const r of pkg.rels("xl/workbook.xml")) {
      if (!/slicerCache$/.test(r.type)) continue;
      const sx = pkg.getPart(r.target);
      if (!sx || !p.name || !sx.includes(` name="${esc(p.name)}"`)) continue;
      const src = unesc(/<(?:\w+:)?slicerCacheDefinition\b[^>]*\ssourceName="([^"]*)"/.exec(sx)?.[1] ?? "");
      if (!changed.has(src)) continue;
      const f = fields.find((x) => x.name === src);
      if (!f) continue;
      const pick = p.show?.[src];
      const s2 = sx.replace(/<((?:\w+:)?i)\b([^>]*?)\/>/g, (it, n: string, attrs: string) => {
        const x = /\sx="(\d+)"/.exec(attrs);
        if (!x) return it;
        const on = !pick || pick.includes(f.items[Number(x[1])] ?? "");
        return `<${n}${attrs.replace(/\ss="[^"]*"/, "")}${on ? ' s="1"' : ""}/>`;
      });
      if (s2 !== sx) pkg.setPart(r.target, s2);
    }
  }
}

/** workbook.xml with the new caches listed in <pivotCaches> (CT_Workbook: … calcPr oleSize customWorkbookViews pivotCaches …). */
export function listPivotCaches(wb: string, caches: { cacheId: number; rid: string }[]): string {
  if (!caches.length) return wb;
  const px = /<(\w+:)?workbook\b/.exec(wb)?.[1] ?? "";
  const els = caches.map((c) => `<${px}pivotCache cacheId="${c.cacheId}" r:id="${c.rid}"/>`).join("");
  const close = /<\/(?:\w+:)?pivotCaches>/.exec(wb);
  if (close) return wb.slice(0, close.index) + els + wb.slice(close.index);
  const next = /<(?:\w+:)?(smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b/.exec(wb);
  const at = next ? next.index : wb.lastIndexOf("</");
  return wb.slice(0, at) + `<${px}pivotCaches>${els}</${px}pivotCaches>` + wb.slice(at);
}

/** The highest cacheId the workbook uses. */
export const maxCacheId = (wb: string) => Math.max(0, ...[...wb.matchAll(/<(?:\w+:)?pivotCache\b[^>]*\scacheId="(\d+)"/g)].map((m) => Number(m[1])));

