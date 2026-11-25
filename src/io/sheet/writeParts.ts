// Worksheet parts made or changed here (표 계산의 서식·보호·인쇄 쓰기): conditional formatting, data validation,
// hyperlinks, sheet protection, page setup (margins, paper, orientation, scale / fit, header / footer, breaks), and on
// the workbook: defined names, print area / titles and structure protection. The same writers serve a fresh workbook
// (io/sheet/book.ts writeFreshXlsx) and the Office Surgeon (only what differs from the original is rewritten; a
// conditional format left as it was keeps its original XML, x14 extensions included).

import type { SheetCond, SheetCondRule, SheetData, SheetLink, SheetPrint, SheetProtect, SheetValidation } from "../../core/sheetTypes";
import { childrenOf, rootOf } from "../officesurgeon/scan";
import { esc } from "../xml";
import { addr, colLetters, parseRange } from "./formula";
import { PROTECT_KEYS } from "./readExtra";

const xmlText = (s: string) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ""));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const argb = (c: string) => "FF" + c.replace("#", "").toUpperCase().padStart(6, "0");

/** CT_Worksheet child order (ECMA-376 §18.3.1.99). */
export const SHEET_ORDER = ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"];

/** Every child `local` of the worksheet replaced by `els` (none = removed), put where the schema wants them. */
export function placeChildren(xml: string, local: string, els: string[]): string {
  const root = rootOf(xml);
  const kids = childrenOf(xml, root);
  const cur = kids.filter((k) => k.local === local);
  if (cur.length) {
    let out = xml.slice(0, cur[0].start) + els.join("");
    for (let i = 0; i < cur.length; i++) out += xml.slice(cur[i].end, i + 1 < cur.length ? cur[i + 1].start : undefined);
    return out;
  }
  if (!els.length) return xml;
  const rank = SHEET_ORDER.indexOf(local);
  const next = kids.find((k) => SHEET_ORDER.indexOf(k.local) > rank);
  const at = next ? next.start : root.closeStart;
  return xml.slice(0, at) + els.join("") + xml.slice(at);
}

/** Excel's legacy 16-bit password verifier (<sheetProtection password>, <workbookProtection workbookPassword>). */
export function excelPasswordHash(pw: string): string {
  if (!pw) return "";
  const bytes = [...pw].map((ch) => ch.charCodeAt(0) & 0xff);
  let h = 0;
  for (let i = bytes.length - 1; i >= 0; i--) {
    h = ((h >> 14) & 1) | ((h << 1) & 0x7fff);
    h ^= bytes[i];
  }
  h = ((h >> 14) & 1) | ((h << 1) & 0x7fff);
  h ^= bytes.length;
  h ^= 0xce4b;
  return h.toString(16).toUpperCase().padStart(4, "0");
}

// ───── sheet protection ─────

export function protectionXml(px: string, p: SheetProtect | undefined): string {
  if (!p) return "";
  const allow = new Set(p.allow);
  const a = [p.hash ? ` password="${p.hash}"` : "", ' sheet="1" objects="1" scenarios="1"'];
  for (const k of PROTECT_KEYS) if (allow.has(k)) a.push(` ${k}="0"`);
  if (!allow.has("selectLocked")) a.push(' selectLockedCells="1"');
  if (!allow.has("selectUnlocked")) a.push(' selectUnlockedCells="1"');
  return `<${px}sheetProtection${a.join("")}/>`;
}

// ───── conditional formatting ─────

function cfvoXml(px: string, kind: string, val?: string) {
  return `<${px}cfvo type="${kind}"${val != null && kind !== "min" && kind !== "max" ? ` val="${xmlText(val)}"` : ""}/>`;
}

/** The formula Excel stores for a 발생 날짜 (timePeriod) rule, relative to the range's top-left cell. */
export function periodFormula(period: string, a: string): string {
  const d = `FLOOR(${a},1)`, w = `ROUNDDOWN(${a},0)`;
  switch (period) {
    case "yesterday":
      return `${d}=TODAY()-1`;
    case "tomorrow":
      return `${d}=TODAY()+1`;
    case "last7Days":
      return `AND(TODAY()-${d}<=6,${d}<=TODAY())`;
    case "thisWeek":
      return `AND(TODAY()-${w}<=WEEKDAY(TODAY())-1,${w}-TODAY()<=7-WEEKDAY(TODAY()))`;
    case "lastWeek":
      return `AND(TODAY()-${w}>=(WEEKDAY(TODAY())),TODAY()-${w}<(WEEKDAY(TODAY())+7))`;
    case "nextWeek":
      return `AND(${w}-TODAY()>(7-WEEKDAY(TODAY())),${w}-TODAY()<(15-WEEKDAY(TODAY())))`;
    case "thisMonth":
      return `AND(MONTH(${a})=MONTH(TODAY()),YEAR(${a})=YEAR(TODAY()))`;
    case "lastMonth":
      return `AND(MONTH(${a})=MONTH(EDATE(TODAY(),0-1)),YEAR(${a})=YEAR(EDATE(TODAY(),0-1)))`;
    case "nextMonth":
      return `AND(MONTH(${a})=MONTH(EDATE(TODAY(),0+1)),YEAR(${a})=YEAR(EDATE(TODAY(),0+1)))`;
    default:
      return `${d}=TODAY()`;
  }
}

/** The formula Excel stores for a text rule (it needs one besides text=""). */
export function textRuleFormula(type: string, text: string, cell: string): string {
  const q = `"${text.replace(/"/g, '""')}"`;
  if (type === "containsText") return `NOT(ISERROR(SEARCH(${q},${cell})))`;
  if (type === "notContainsText") return `ISERROR(SEARCH(${q},${cell}))`;
  if (type === "beginsWith") return `LEFT(${cell},LEN(${q}))=${q}`;
  if (type === "endsWith") return `RIGHT(${cell},LEN(${q}))=${q}`;
  if (type === "containsBlanks") return `LEN(TRIM(${cell}))=0`;
  if (type === "notContainsBlanks") return `LEN(TRIM(${cell}))>0`;
  if (type === "containsErrors") return `ISERROR(${cell})`;
  if (type === "notContainsErrors") return `NOT(ISERROR(${cell}))`;
  return "";
}

function ruleXml(px: string, rule: SheetCondRule, priority: number, dxfOf: (st: NonNullable<SheetCondRule["style"]>) => number, topLeft: string): string {
  const a: string[] = [` type="${rule.type}"`];
  const styled = !["colorScale", "dataBar", "iconSet"].includes(rule.type);
  if (styled && rule.style && Object.keys(rule.style).length) a.push(` dxfId="${dxfOf(rule.style)}"`);
  a.push(` priority="${priority}"`);
  if (rule.stop) a.push(' stopIfTrue="1"');
  if (rule.type === "top10") {
    a.push(` rank="${rule.rank ?? 10}"`);
    if (rule.percent) a.push(' percent="1"');
    if (rule.bottom) a.push(' bottom="1"');
  }
  if (rule.type === "aboveAverage" && rule.below) a.push(' aboveAverage="0"');
  if (rule.type === "timePeriod") a.push(` timePeriod="${rule.period ?? "today"}"`);
  if (rule.op && (rule.type === "cellIs" || /Text|With$/.test(rule.type))) a.push(` operator="${rule.op}"`);
  let body = "";
  if (rule.type === "colorScale") {
    const sc = rule.scale ?? [];
    body = `<${px}colorScale>${sc.map((s) => cfvoXml(px, s.kind, s.val)).join("")}${sc.map((s) => `<${px}color rgb="${argb(s.color)}"/>`).join("")}</${px}colorScale>`;
  } else if (rule.type === "dataBar") {
    const sc = rule.scale?.length === 2 ? rule.scale : [{ kind: "min", color: "" }, { kind: "max", color: "" }];
    body = `<${px}dataBar${rule.noValue ? ' showValue="0"' : ""}>${sc.map((s) => cfvoXml(px, s.kind, s.val)).join("")}<${px}color rgb="${argb(rule.bar ?? "#638EC6")}"/></${px}dataBar>`;
  } else if (rule.type === "iconSet") {
    const sc = rule.scale ?? [];
    body = `<${px}iconSet iconSet="${rule.icons ?? "3TrafficLights1"}"${rule.iconReverse ? ' reverse="1"' : ""}${rule.noValue ? ' showValue="0"' : ""}>${sc.map((s) => cfvoXml(px, s.kind, s.val)).join("")}</${px}iconSet>`;
  } else {
    let fs = rule.formulas ?? [];
    if (rule.text != null) a.push(` text="${xmlText(rule.text)}"`);
    if (!fs.length && rule.type !== "cellIs") {
      const f = rule.type === "timePeriod" ? periodFormula(rule.period ?? "today", topLeft) : textRuleFormula(rule.type, rule.text ?? "", topLeft);
      if (f) fs = [f];
    }
    body = fs.map((f) => `<${px}formula>${xmlText(f)}</${px}formula>`).join("");
  }
  return `<${px}cfRule${a.join("")}>${body}</${px}cfRule>`;
}

/**
 * The <conditionalFormatting> elements of a sheet: a block equal to one the file had keeps that block's XML (its x14
 * extension ids, its exact formulas); the others are written from the model.
 */
export function condXml(px: string, conds: SheetCond[], orig: { cond?: SheetCond[]; blocks: string[] } | null, dxfOf: (st: NonNullable<SheetCondRule["style"]>) => number): string[] {
  let priority = Math.max(0, ...conds.flatMap((c) => c.rules.map((r) => r.priority))) + 1;
  return conds.map((cf) => {
    const j = orig && orig.cond && orig.blocks.length === orig.cond.length ? orig.cond.findIndex((o) => same(o, cf)) : -1;
    if (j >= 0) return orig!.blocks[j];
    const g = parseRange(cf.ranges[0] ?? "A1");
    const topLeft = g ? addr(g.r0, g.c0) : "A1";
    return `<${px}conditionalFormatting sqref="${cf.ranges.join(" ")}">${cf.rules.map((r) => ruleXml(px, r, r.priority || priority++, dxfOf, topLeft)).join("")}</${px}conditionalFormatting>`;
  });
}

// ───── data validation ─────

export function validationsXml(px: string, list: SheetValidation[]): string {
  const own = list.filter((v) => !v.x14);
  if (!own.length) return "";
  const one = (v: SheetValidation) => {
    const a: string[] = [];
    if (v.type !== "none") a.push(` type="${v.type}"`);
    if (v.errStyle && v.errStyle !== "stop") a.push(` errorStyle="${v.errStyle}"`);
    if (v.op && v.op !== "between" && v.type !== "list" && v.type !== "custom") a.push(` operator="${v.op}"`);
    if (v.allowBlank) a.push(' allowBlank="1"');
    if (v.noDropdown) a.push(' showDropDown="1"');
    if (v.showInput) a.push(' showInputMessage="1"');
    if (v.showError) a.push(' showErrorMessage="1"');
    if (v.errTitle) a.push(` errorTitle="${xmlText(v.errTitle)}"`);
    if (v.error) a.push(` error="${xmlText(v.error)}"`);
    if (v.promptTitle) a.push(` promptTitle="${xmlText(v.promptTitle)}"`);
    if (v.prompt) a.push(` prompt="${xmlText(v.prompt)}"`);
    a.push(` sqref="${v.ranges.join(" ")}"`);
    const f = (n: string, x?: string) => (x != null && x !== "" ? `<${px}${n}>${xmlText(x)}</${px}${n}>` : "");
    return `<${px}dataValidation${a.join("")}>${f("formula1", v.f1)}${f("formula2", v.f2)}</${px}dataValidation>`;
  };
  return `<${px}dataValidations count="${own.length}">${own.map(one).join("")}</${px}dataValidations>`;
}

// ───── hyperlinks ─────

/** <hyperlinks>; `rid(url)` gives the relationship of an external address. */
export function hyperlinksXml(px: string, links: Record<string, SheetLink> | undefined, rid: (url: string) => string): string {
  const list = Object.entries(links ?? {}).filter(([, l]) => l.url || l.loc);
  if (!list.length) return "";
  return `<${px}hyperlinks>${list
    .map(([a, l]) => `<${px}hyperlink ref="${a}"${l.url ? ` r:id="${rid(l.url)}"` : ""}${l.loc ? ` location="${xmlText(l.loc)}"` : ""}${l.tip ? ` tooltip="${xmlText(l.tip)}"` : ""}/>`)
    .join("")}</${px}hyperlinks>`;
}

// ───── page setup ─────

/** printOptions, pageMargins, pageSetup, headerFooter, rowBreaks, colBreaks of `p` (Excel's defaults when absent). */
export function printXml(px: string, p: SheetPrint, keepRid?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const po = [p.hCenter ? ' horizontalCentered="1"' : "", p.vCenter ? ' verticalCentered="1"' : "", p.headings ? ' headings="1"' : "", p.grid ? ' gridLines="1"' : ""].join("");
  out.printOptions = po ? `<${px}printOptions${po}/>` : "";
  const m = p.margins ?? { l: 0.7, r: 0.7, t: 0.75, b: 0.75, header: 0.3, footer: 0.3 };
  out.pageMargins = `<${px}pageMargins left="${m.l}" right="${m.r}" top="${m.t}" bottom="${m.b}" header="${m.header}" footer="${m.footer}"/>`;
  const ps = [
    ` paperSize="${p.paper ?? 9}"`,
    p.scale && p.scale !== 100 ? ` scale="${p.scale}"` : "",
    p.firstPage ? ` firstPageNumber="${p.firstPage}"` : "",
    p.fit ? ` fitToWidth="${p.fit.w}" fitToHeight="${p.fit.h}"` : "",
    p.overThenDown ? ' pageOrder="overThenDown"' : "",
    ` orientation="${p.landscape ? "landscape" : "portrait"}"`,
    p.firstPage ? ' useFirstPageNumber="1"' : "",
    keepRid ? ` r:id="${keepRid}"` : "",
  ].join("");
  out.pageSetup = `<${px}pageSetup${ps}/>`;
  const hf = (n: string, v?: string) => (v ? `<${px}${n}>${xmlText(v)}</${px}${n}>` : "");
  const first = p.firstHeader != null || p.firstFooter != null;
  const hfBody = hf("oddHeader", p.header) + hf("oddFooter", p.footer) + (first ? hf("firstHeader", p.firstHeader) + hf("firstFooter", p.firstFooter) : "");
  out.headerFooter = hfBody || first ? `<${px}headerFooter${first ? ' differentFirst="1"' : ""}>${hfBody}</${px}headerFooter>` : "";
  const brk = (n: string, ids: number[] | undefined, max: number) =>
    ids?.length ? `<${px}${n} count="${ids.length}" manualBreakCount="${ids.length}">${ids.map((id) => `<${px}brk id="${id}" max="${max}" man="1"/>`).join("")}</${px}${n}>` : "";
  out.rowBreaks = brk("rowBreaks", p.rowBreaks, 16383);
  out.colBreaks = brk("colBreaks", p.colBreaks, 1048575);
  return out;
}

/** <sheetPr> with <pageSetUpPr fitToPage> set as `fit` says (other children and attributes kept). */
export function sheetPrFit(xml: string, px: string, fit: boolean): string {
  const root = rootOf(xml);
  const pr = childrenOf(xml, root).find((k) => k.local === "sheetPr");
  const cur = pr ? xml.slice(pr.start, pr.end) : `<${px}sheetPr/>`;
  let next: string;
  const ps = /<(\w+:)?pageSetUpPr\b[^>]*\/>/.exec(cur);
  if (ps) {
    const tag = ps[0].replace(/\sfitToPage="[^"]*"/, "");
    const fixed = fit ? tag.replace(/\/>$/, ' fitToPage="1"/>') : tag;
    next = cur.replace(ps[0], /^<[\w:]+pageSetUpPr\s*\/>$/.test(fixed) ? "" : fixed);
  } else if (!fit) return xml;
  else if (/\/>$/.test(cur)) next = cur.replace(/\s*\/>$/, `><${px}pageSetUpPr fitToPage="1"/></${px}sheetPr>`);
  else {
    // CT_SheetPr: tabColor outlinePr pageSetUpPr
    const close = cur.lastIndexOf("</");
    next = cur.slice(0, close) + `<${px}pageSetUpPr fitToPage="1"/>` + cur.slice(close);
  }
  if (/^<[\w:]+sheetPr\s*>\s*<\/[\w:]+sheetPr>$/.test(next) || /^<[\w:]+sheetPr\s*\/>$/.test(next)) next = "";
  if (pr) return xml.slice(0, pr.start) + next + xml.slice(pr.end);
  if (!next) return xml;
  return xml.slice(0, root.openEnd) + next + xml.slice(root.openEnd);
}

/** The sheet's page setup elements written when `p` differs from the original's (r:id of printer settings kept). */
export function writePrint(xml: string, px: string, p: SheetPrint | undefined, was: SheetPrint | undefined): string {
  if (same(p, was)) return xml;
  const rid = /<(?:\w+:)?pageSetup\b[^>]*\sr:id="([^"]*)"/.exec(xml)?.[1] ?? null;
  const parts = printXml(px, p ?? {}, rid);
  for (const k of ["printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks"]) xml = placeChildren(xml, k, parts[k] ? [parts[k]] : []);
  if (!!p?.fit !== !!was?.fit) xml = sheetPrFit(xml, px, !!p?.fit);
  return xml;
}

// ───── sparklines (x14:sparklineGroups in the worksheet's extLst) ─────

const SPARK_URI = "{05C60535-1F16-4fd2-B633-F4F36F0B64E0}";

/** The worksheet extension with the sheet's sparkline groups, as Excel 2010+ writes it. */
export function sparkExt(sh: SheetData): string {
  const rgb = (c: string) => `FF${c.replace("#", "").toUpperCase()}`;
  const groups = (sh.sparks ?? [])
    .map((g) => {
      const items = g.items.map((it) => `<x14:sparkline><xm:f>${esc(it.ref)}</xm:f><xm:sqref>${it.at}</xm:sqref></x14:sparkline>`).join("");
      const neg = g.negColor ?? "#D00000";
      return (
        `<x14:sparklineGroup displayEmptyCellsAs="gap"${g.type === "line" ? "" : ` type="${g.type}"`}${g.markers ? ' markers="1"' : ""}${g.negColor ? ' negative="1"' : ""}>` +
        `<x14:colorSeries rgb="${rgb(g.color)}"/><x14:colorNegative rgb="${rgb(neg)}"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="${rgb(g.color)}"/>` +
        `<x14:colorFirst rgb="${rgb(neg)}"/><x14:colorLast rgb="${rgb(neg)}"/><x14:colorHigh rgb="${rgb(neg)}"/><x14:colorLow rgb="${rgb(neg)}"/>` +
        `<x14:sparklines>${items}</x14:sparklines></x14:sparklineGroup>`
      );
    })
    .join("");
  return `<ext uri="${SPARK_URI}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">${groups}</x14:sparklineGroups></ext>`;
}

/** The worksheet with its sparkline extension written again (removed when there are none); other extensions stay. */
export function writeSparks(xml: string, px: string, sh: SheetData): string {
  const ext = sh.sparks?.length ? sparkExt(sh).replace(/^<ext\b/, `<${px}ext`).replace(/<\/ext>$/, `</${px}ext>`) : "";
  const re = /<((?:\w+:)?ext)\b[^>]*uri="\{05C60535-1F16-4fd2-B633-F4F36F0B64E0\}"[^>]*>[\s\S]*?<\/\1>/i;
  const lst = /<((?:\w+:)?extLst)>([\s\S]*?)<\/\1>/.exec(xml);
  if (lst) {
    let inner = lst[2].replace(re, "");
    inner = ext + inner;
    const out = inner.trim() ? `<${lst[1]}>${inner}</${lst[1]}>` : "";
    return xml.slice(0, lst.index) + out + xml.slice(lst.index + lst[0].length);
  }
  return ext ? placeChildren(xml, "extLst", [`<${px}extLst>${ext}</${px}extLst>`]) : xml;
}

/** A filter column's XML: the values shown (<filters>) or the conditions (<customFilters>); "" for a kind kept as it was. */
export function filterColumnXml(px: string, k: string | number, v: { vals?: string[]; blank?: boolean; other?: boolean; custom?: { and?: boolean; items: { op: string; val: string }[] } }): string {
  if (v.custom?.items.length)
    return `<${px}filterColumn colId="${k}"><${px}customFilters${v.custom.and ? ' and="1"' : ""}>${v.custom.items.map((x) => `<${px}customFilter${x.op === "equal" ? "" : ` operator="${x.op}"`} val="${esc(x.val)}"/>`).join("")}</${px}customFilters></${px}filterColumn>`;
  if (!v.vals || v.other) return "";
  return `<${px}filterColumn colId="${k}"><${px}filters${v.blank ? ' blank="1"' : ""}>${v.vals.map((x) => `<${px}filter val="${esc(x)}"/>`).join("")}</${px}filters></${px}filterColumn>`;
}

/** <autoFilter> of a sheet: the range and the values shown in each filtered column */
export function filterXml(px: string, sh: SheetData): string {
  const f = sh.filter!;
  const cols = Object.entries(f.cols ?? {})
    .filter(([, v]) => (v.vals || v.custom) && !v.other)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, v]) => filterColumnXml(px, k, v))
    .join("");
  return cols ? `<${px}autoFilter ref="${f.ref}">${cols}</${px}autoFilter>` : `<${px}autoFilter ref="${f.ref}"/>`;
}

// ───── workbook: names, print area / titles, protection ─────

const quoteSheet = (n: string) => (/^[A-Za-z_][\w.]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);

/** _xlnm.Print_Area / _xlnm.Print_Titles of a sheet as Excel writes them ('Sheet 1'!$A$1:$F$40). */
export function printNames(sh: SheetData): { area?: string; titles?: string } {
  const q = quoteSheet(sh.name);
  const p = sh.print;
  const abs = (r: string) => {
    const g = parseRange(r);
    return g ? `${q}!$${colLetters(g.c0)}$${g.r0 + 1}:$${colLetters(g.c1)}$${g.r1 + 1}` : null;
  };
  const area = p?.area?.map(abs).filter(Boolean).join(",") || undefined;
  const t: string[] = [];
  if (p?.titleCols) t.push(`${q}!$${colLetters(p.titleCols[0])}:$${colLetters(p.titleCols[1])}`);
  if (p?.titleRows) t.push(`${q}!$${p.titleRows[0] + 1}:$${p.titleRows[1] + 1}`);
  return { area, titles: t.join(",") || undefined };
}

/**
 * workbook.xml with: the print names of each sheet (by its tab position), user names that differ from the original
 * (`origNames` = names as read), and the structure protection.
 */
export function workbookParts(wb: string, sheets: SheetData[], orig: { sheets: SheetData[]; names?: Record<string, string> } | null, fileFormula: (f: string) => string): string {
  const px = /<(\w+:)?workbook\b/.exec(wb)?.[1] ?? "";
  const dn = (name: string, body: string, local?: number, hidden = false) => `<${px}definedName name="${esc(name)}"${local != null ? ` localSheetId="${local}"` : ""}${hidden ? ' hidden="1"' : ""}>${xmlText(body)}</${px}definedName>`;
  const edits: { name: string; local?: number; body: string | null; hidden?: boolean }[] = [];
  // print area / titles
  sheets.forEach((sh, i) => {
    const o = orig?.sheets.find((x) => x.index != null && x.index === sh.index);
    const now = printNames(sh), was = o ? printNames({ ...o, name: sh.name }) : {};
    if (now.area !== was.area || !o) if (now.area || o) edits.push({ name: "_xlnm.Print_Area", local: i, body: now.area ?? null });
    if (now.titles !== was.titles || !o) if (now.titles || o) edits.push({ name: "_xlnm.Print_Titles", local: i, body: now.titles ?? null });
  });
  // the hidden name Excel keeps for each AutoFilter range (a fresh workbook; the surgical save keeps / edits its own)
  if (!orig)
    sheets.forEach((sh, i) => {
      const g = sh.filter && parseRange(sh.filter.ref);
      if (g) edits.push({ name: "_xlnm._FilterDatabase", local: i, body: `${quoteSheet(sh.name)}!$${colLetters(g.c0)}$${g.r0 + 1}:$${colLetters(g.c1)}$${g.r1 + 1}`, hidden: true });
    });
  // user names (workbook-wide)
  const names = sheets[0]?.names ?? {};
  const wasNames = orig?.names ?? {};
  for (const k of new Set([...Object.keys(names), ...Object.keys(wasNames)])) if (names[k] !== wasNames[k]) edits.push({ name: k, body: names[k] != null ? fileFormula(names[k]) : null });
  for (const e of edits) {
    const re = new RegExp(`<(?:\\w+:)?definedName\\b(?=[^>]*\\sname="${e.name.replace(/[.$]/g, "\\$&")}")${e.local != null ? `(?=[^>]*localSheetId="${e.local}")` : "(?![^>]*localSheetId=)"}[^>]*>[^<]*</(?:\\w+:)?definedName>`, "i");
    const m = re.exec(wb);
    if (e.body == null) {
      if (m) wb = wb.slice(0, m.index) + wb.slice(m.index + m[0].length);
      continue;
    }
    if (e.local == null && e.body === null) continue;
    const el = dn(e.name, e.body, e.local, e.hidden);
    if (m) {
      wb = wb.slice(0, m.index) + el + wb.slice(m.index + m[0].length);
      continue;
    }
    const close = /<\/(?:\w+:)?definedNames>/.exec(wb);
    if (close) wb = wb.slice(0, close.index) + el + wb.slice(close.index);
    else {
      // CT_Workbook: … sheets functionGroups externalReferences definedNames calcPr …
      const after = /<\/(?:\w+:)?externalReferences>/.exec(wb) ?? /<\/(?:\w+:)?functionGroups>/.exec(wb) ?? /<\/(?:\w+:)?sheets>/.exec(wb);
      if (!after) continue;
      const at = after.index + after[0].length;
      wb = wb.slice(0, at) + `<${px}definedNames>${el}</${px}definedNames>` + wb.slice(at);
    }
  }
  wb = wb.replace(/<(\w+:)?definedNames>\s*<\/(\w+:)?definedNames>/, "");
  // structure protection
  const lock = sheets[0]?.bookProtect;
  const wasLock = orig?.sheets[0]?.bookProtect;
  if (!orig || !same(lock, wasLock)) {
    const cur = /<(?:\w+:)?workbookProtection\b[^>]*\/>/.exec(wb);
    const el = lock ? `<${px}workbookProtection${lock.hash ? ` workbookPassword="${lock.hash}"` : ""} lockStructure="1"/>` : "";
    if (cur) wb = wb.slice(0, cur.index) + el + wb.slice(cur.index + cur[0].length);
    else if (el) {
      // CT_Workbook: fileVersion fileSharing workbookPr workbookProtection bookViews …
      const before = /<(?:\w+:)?bookViews\b/.exec(wb) ?? /<(?:\w+:)?sheets\b/.exec(wb);
      if (before) wb = wb.slice(0, before.index) + el + wb.slice(before.index);
    }
  }
  return wb;
}

// ───── the sheet's view: gridlines, headings, frozen panes ─────

/**
 * 창 나누기 as Excel writes it: the panes' sizes in twips (1/20 pt) from the sheet's top-left including the headings,
 * the bottom-right pane's first cell, state="split".
 */
export function splitPaneXml(px: string, sh: SheetData): string {
  const sp = sh.split!;
  const twip = (pxv: number) => Math.round(pxv * 15);
  let h = 0, w = 0;
  for (let r = sp.top; r < sp.top + sp.rows; r++) h += sh.hiddenRows?.includes(r) ? 0 : sh.rowH[r] ?? sh.defRowH;
  for (let c = sp.left; c < sp.left + sp.cols; c++) w += sh.hiddenCols?.includes(c) ? 0 : sh.colW[c] ?? sh.defColW;
  // the headings Excel counts in: a row as tall as the default row, a column 22.2 pt wide (measured in Excel)
  const ySplit = sp.rows ? twip(h + sh.defRowH) : 0, xSplit = sp.cols ? twip(w + 29.6) : 0;
  const tl = addr(sp.rows ? sp.row ?? sp.top + sp.rows : 0, sp.cols ? sp.col ?? sp.left + sp.cols : 0);
  const active = sp.rows && sp.cols ? "bottomRight" : sp.rows ? "bottomLeft" : "topRight";
  return `<${px}pane${xSplit ? ` xSplit="${xSplit}"` : ""}${ySplit ? ` ySplit="${ySplit}"` : ""} topLeftCell="${tl}" activePane="${active}" state="split"/>`;
}

/** The first <sheetView> with gridlines / headings shown as the model says and its frozen pane written again. */
function writeView(xml: string, px: string, sh: SheetData, o: SheetData): string {
  const m = /<((?:\w+:)?sheetView)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/.exec(xml);
  if (!m) {
    const fr = sh.freeze;
    const pane = !fr && sh.split ? splitPaneXml(px, sh) : fr && (fr.rows || fr.cols) ? paneXml(px, fr) : "";
    return placeChildren(xml, "sheetViews", [`<${px}sheetViews><${px}sheetView${sh.grid ? "" : ' showGridLines="0"'}${sh.headings === false ? ' showRowColHeaders="0"' : ""}${!fr && sh.split ? ` topLeftCell="${addr(sh.split.top, sh.split.left)}"` : ""} workbookViewId="0">${pane}</${px}sheetView></${px}sheetViews>`]);
  }
  let attrs = m[2].replace(/\s(showGridLines|showRowColHeaders)="[^"]*"/g, "");
  attrs = (sh.grid ? "" : ' showGridLines="0"') + (sh.headings === false ? ' showRowColHeaders="0"' : "") + attrs;
  let body = m[4] ?? "";
  if (!same(sh.freeze, o.freeze) || !same(sh.split, o.split)) {
    // the old pane and the selections that named its panes go; Excel puts its selection back on opening
    body = body.replace(/<(?:\w+:)?pane\b[^>]*\/>/g, "").replace(/<(?:\w+:)?selection\b[^>]*\/>/g, "");
    const fr = sh.freeze;
    if (fr && (fr.rows || fr.cols)) body = paneXml(px, fr) + body;
    else if (sh.split) {
      body = splitPaneXml(px, sh) + body;
      attrs = attrs.replace(/\stopLeftCell="[^"]*"/, "") + ` topLeftCell="${addr(sh.split.top, sh.split.left)}"`;
    }
  }
  const el = body ? `<${m[1]}${attrs}>${body}</${m[1]}>` : `<${m[1]}${attrs}/>`;
  return xml.slice(0, m.index) + el + xml.slice(m.index + m[0].length);
}

const paneXml = (px: string, fr: { rows: number; cols: number }) =>
  `<${px}pane${fr.cols ? ` xSplit="${fr.cols}"` : ""}${fr.rows ? ` ySplit="${fr.rows}"` : ""} topLeftCell="${addr(fr.rows, fr.cols)}" activePane="${fr.rows && fr.cols ? "bottomRight" : fr.rows ? "bottomLeft" : "topRight"}" state="frozen"/>`;

// ───── one sheet, everything above ─────

export interface SheetRels {
  /** relationship id of an external hyperlink target (added to the sheet's rels) */
  link(url: string): string;
  /** drop the sheet's hyperlink relationships (before they are written again) */
  dropLinks(): void;
}

/**
 * A worksheet XML with this module's parts written: in full for a fresh sheet (`o` null), or where they differ from
 * the original `o` (Office Surgeon). `dxfOf` adds differential formats to styles.xml.
 */
export function writeSheetParts(xml: string, sh: SheetData, o: SheetData | null, dxfOf: (st: NonNullable<SheetCondRule["style"]>) => number, rels: SheetRels): string {
  const root = rootOf(xml);
  const px = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":") + 1) : "";
  if (o && (sh.grid !== o.grid || (sh.headings !== false) !== (o.headings !== false) || !same(sh.freeze, o.freeze) || !same(sh.split, o.split))) xml = writeView(xml, px, sh, o);
  if (!o || !same(sh.protect, o.protect)) xml = placeChildren(xml, "sheetProtection", sh.protect ? [protectionXml(px, sh.protect)] : []);
  if (!o || !same(sh.scenarios, o.scenarios)) {
    const sc = sh.scenarios;
    // 시나리오 관리자: <scenarios current sqref><scenario name count><inputCells r val/>…
    const all = [...new Set((sc?.list ?? []).flatMap((x) => x.cells))];
    const sx = sc?.list.length
      ? `<${px}scenarios${sc.cur != null ? ` current="${sc.cur}" show="${sc.cur}"` : ""} sqref="${all.join(" ")}">` +
        sc.list.map((x) => `<${px}scenario name="${esc(x.name)}" count="${x.cells.length}"${x.user ? ` user="${esc(x.user)}"` : ""}${x.comment ? ` comment="${esc(x.comment)}"` : ""}>${x.cells.map((a, i) => `<${px}inputCells r="${a}" val="${esc(x.vals[i] ?? "")}"/>`).join("")}</${px}scenario>`).join("") +
        `</${px}scenarios>`
      : "";
    xml = placeChildren(xml, "scenarios", sx ? [sx] : []);
  }
  if (!o || !same(sh.cond, o.cond)) {
    const blocks = o ? childrenOf(xml, rootOf(xml)).filter((k) => k.local === "conditionalFormatting").map((k) => xml.slice(k.start, k.end)).filter((x) => /cfRule\b/.test(x)) : [];
    xml = placeChildren(xml, "conditionalFormatting", condXml(px, sh.cond ?? [], o ? { cond: o.cond, blocks } : null, dxfOf));
  }
  const own = (v?: SheetValidation[]) => (v ?? []).filter((x) => !x.x14);
  const ext = (v?: SheetValidation[]) => (v ?? []).filter((x) => x.x14);
  if (o && !same(ext(sh.valid), ext(o.valid))) {
    // a rule of the x14 extension (lists on other sheets) changed: the extension goes and every rule is written in the
    // main list (Excel 2010 and later read references to other sheets there)
    xml = xml.replace(/<((?:\w+:)?ext)\b[^>]*uri="\{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF\}"[^>]*>[\s\S]*?<\/\1>/i, "").replace(/<((?:\w+:)?extLst)>\s*<\/\1>/, "");
    const v = validationsXml(px, (sh.valid ?? []).map((x) => ({ ...x, x14: undefined })));
    xml = placeChildren(xml, "dataValidations", v ? [v] : []);
  } else if (!o || !same(own(sh.valid), own(o.valid))) {
    const v = validationsXml(px, sh.valid ?? []);
    xml = placeChildren(xml, "dataValidations", v ? [v] : []);
  }
  if (!o || !same(sh.links, o.links)) {
    if (o) rels.dropLinks();
    const h = hyperlinksXml(px, sh.links, (u) => rels.link(u));
    xml = placeChildren(xml, "hyperlinks", h ? [h] : []);
  }
  // a fresh sheet's AutoFilter (the surgical save writes it in bookExtra's writeFilter): the range and each column's shown values
  if (!o && sh.filter) xml = placeChildren(xml, "autoFilter", [filterXml(px, sh)]);
  if (o ? !same(sh.sparks, o.sparks) : sh.sparks?.length) xml = writeSparks(xml, px, sh);
  if (!o) {
    if (sh.print) {
      const parts = printXml(px, sh.print);
      for (const k of ["printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks"]) if (parts[k]) xml = placeChildren(xml, k, [parts[k]]);
      if (sh.print.fit) xml = sheetPrFit(xml, px, true);
    }
  } else xml = writePrint(xml, px, sh.print, o.print);
  return xml;
}
