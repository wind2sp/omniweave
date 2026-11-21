// Page setup of a worksheet (표 계산 인쇄 설정, ECMA-376 Part 1 §18.3.1.62 pageSetup, §18.3.1.62 pageMargins,
// §18.3.1.70 printOptions, §18.3.1.46 headerFooter, §18.3.1.73 rowBreaks / colBreaks, §18.2.5 definedName
// _xlnm.Print_Area / _xlnm.Print_Titles) → `SheetData.print`. Read only: an unedited save keeps the original XML.

import type { SheetData, SheetPrint } from "../../core/sheetTypes";
import { attr, child, children, descendants, textOf } from "../xml";
import { colIndex, parseRange } from "./formula";

const on = (v: string | null) => /^(1|true)$/.test(v ?? "");
const num = (v: string | null) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Split a defined name's formula at top-level commas ('Sheet, 1'!$A:$A,'Sheet, 1'!$1:$2). */
function refList(f: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (const ch of f) {
    if (ch === "'") q = !q;
    if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  // the sheet part goes; references stay ($ removed)
  return out.map((r) => r.trim().replace(/^.*!/, "").replace(/\$/g, "")).filter(Boolean);
}

/** Print area / titles of one sheet from the workbook's defined names (local names, localSheetId = sheet index). */
function printNames(wb: Document, sheetIndex: number, p: SheetPrint) {
  for (const dn of descendants(wb, "definedName")) {
    if (Number(attr(dn, "localSheetId") ?? -1) !== sheetIndex) continue;
    const n = (attr(dn, "name") ?? "").toLowerCase();
    if (n === "_xlnm.print_area") {
      const area = refList(textOf(dn)).filter((r) => /^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(r) && parseRange(r));
      if (area.length) p.area = area;
    } else if (n === "_xlnm.print_titles") {
      for (const r of refList(textOf(dn))) {
        const rows = /^(\d+):(\d+)$/.exec(r);
        const cols = /^([A-Z]{1,3}):([A-Z]{1,3})$/i.exec(r);
        if (rows) p.titleRows = [Number(rows[1]) - 1, Number(rows[2]) - 1];
        else if (cols) p.titleCols = [colIndex(cols[1]), colIndex(cols[2])];
      }
    }
  }
}

/** Read the page setup of a worksheet (`root` = <worksheet>, `wb` = workbook.xml) into `sh.print`. */
export function readPrintSetup(sh: SheetData, root: Element, wb: Document, sheetIndex: number) {
  const p: SheetPrint = {};
  const ps = child(root, "pageSetup");
  if (ps) {
    p.paper = num(attr(ps, "paperSize")) ?? 1; // the schema default is Letter
    if (attr(ps, "orientation") === "landscape") p.landscape = true;
    const sc = num(attr(ps, "scale"));
    if (sc && sc !== 100) p.scale = Math.min(400, Math.max(10, sc));
    if (on(attr(ps, "useFirstPageNumber"))) p.firstPage = num(attr(ps, "firstPageNumber")) ?? 1;
    if (attr(ps, "pageOrder") === "overThenDown") p.overThenDown = true;
  }
  const pr = child(root, "sheetPr");
  const fitPr = pr && child(pr, "pageSetUpPr");
  if (fitPr && on(attr(fitPr, "fitToPage"))) p.fit = { w: num(ps ? attr(ps, "fitToWidth") : null) ?? 1, h: num(ps ? attr(ps, "fitToHeight") : null) ?? 1 };
  const pm = child(root, "pageMargins");
  if (pm) {
    const m = (k: string, d: number) => num(attr(pm, k)) ?? d;
    p.margins = { l: m("left", 0.7), r: m("right", 0.7), t: m("top", 0.75), b: m("bottom", 0.75), header: m("header", 0.3), footer: m("footer", 0.3) };
  }
  const po = child(root, "printOptions");
  if (po) {
    if (on(attr(po, "gridLines"))) p.grid = true;
    if (on(attr(po, "headings"))) p.headings = true;
    if (on(attr(po, "horizontalCentered"))) p.hCenter = true;
    if (on(attr(po, "verticalCentered"))) p.vCenter = true;
  }
  const hf = child(root, "headerFooter");
  if (hf) {
    const t = (k: string) => {
      const e = child(hf, k);
      return e ? textOf(e) : undefined;
    };
    const h = t("oddHeader"), f = t("oddFooter");
    if (h) p.header = h;
    if (f) p.footer = f;
    if (on(attr(hf, "differentFirst"))) {
      p.firstHeader = t("firstHeader") ?? "";
      p.firstFooter = t("firstFooter") ?? "";
    }
  }
  // manual breaks: <brk id> is the last row / column before the break (1-based) = the 0-based start of the next page
  const brks = (name: string) => {
    const e = child(root, name);
    const ids = e ? children(e, "brk").filter((b) => attr(b, "man") == null || on(attr(b, "man"))).map((b) => Number(attr(b, "id"))) : [];
    return [...new Set(ids.filter((n) => n > 0))].sort((a, b) => a - b);
  };
  const rb = brks("rowBreaks"), cb = brks("colBreaks");
  if (rb.length) p.rowBreaks = rb;
  if (cb.length) p.colBreaks = cb;
  printNames(wb, sheetIndex, p);
  if (Object.keys(p).length) sh.print = p;
}
