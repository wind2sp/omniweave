// Excel workbook (.xlsx, SpreadsheetML / ECMA-376 Part 1 §18): every sheet becomes a table
// (split across pages when long). Values are the cached results; formulas are kept on the cell
// and written back. Clean-room from the public OOXML schema.

import { t as tr } from "../../i18n";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type { Align, Page, TableCell } from "../../core/types";
import { attr, child, children, descendants, esc, parseXml, textOf } from "../xml";
import { MAX_ROWS, collectTables, tablePages } from "./csv";
import { pagesFor } from "./flow";
import { baseName } from "./text";

export function colName(i: number): string {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

export function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Built-in number formats (ECMA-376 Part 1 §18.8.30); 14–22 are shown in the reader's locale. */
const BUILTIN_FMT: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};
const BUILTIN_ID = new Map(Object.entries(BUILTIN_FMT).map(([id, code]) => [code, Number(id)]));

export function isDateFormat(code: string): boolean {
  const s = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  return /[ymdhs]/i.test(s) && !/^[#0.,%\s]*$/.test(s);
}

/**
 * Serial number of a calendar date in the 1900 date system (ECMA-376 Part 1 §18.17.4.1): day 1 is
 * 1900-01-01 and, for compatibility, serial 60 is the non-existent 1900-02-29. null when the date does
 * not exist or is outside 1900-01-01 … 9999-12-31.
 */
export function dateSerial(y: number, m: number, d: number): number | null {
  if (y === 1900 && m === 2 && d === 29) return 60;
  if (y < 1900 || y > 9999) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const s = t / 86400000 + 25569;
  return s < 61 ? s - 1 : s; // before 1900-03-01 the fake leap day has not been counted yet
}

export function serialToText(v: number, date1904: boolean, code: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  // 1900 system: serials below 61 lack the fake 1900-02-29 (serial 60 itself is that date)
  const fake29 = !date1904 && Math.floor(v) === 60;
  const days = !date1904 && v < 60 ? v + 1 : v;
  const ms = Math.round((days + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  const ymd = fake29 ? "1900-02-29" : `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const hms = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${/s/i.test(code) ? ":" + p(d.getUTCSeconds()) : ""}`;
  if (v < 1 && /h/i.test(code)) return hms;
  return /h/i.test(code) || (v % 1 !== 0 && !/^[ymd\W]*$/i.test(code)) ? `${ymd} ${hms}` : ymd;
}

export function numText(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(parseFloat(n.toPrecision(15)));
}

/**
 * Maximum digit width in pixels of the workbook's default font (the Normal style's font), the unit of
 * SpreadsheetML column widths (ECMA-376 Part 1 §18.3.1.13). Measured in Excel at 100 % / 96 dpi:
 * Calibri 11 → 7 px, 맑은 고딕 11 → 8 px.
 */
export function maxDigitWidth(font: string | undefined, sizePt = 11): number {
  const f = (font ?? "").trim().toLowerCase();
  const at11 = f === "맑은 고딕" || f === "malgun gothic" ? 8 : 7; // i18n: keep — font name matched in files
  return Math.max(4, Math.round((at11 * sizePt) / 11));
}
/** The default font this exporter writes into styles.xml (font 0). */
const EXPORT_FONT = "맑은 고딕"; // i18n: keep — font name written to the file

export interface Sheet {
  name: string;
  rows: TableCell[][];
  colWidths: number[];
  merged: number;
  truncated: boolean;
  /** package entry of the worksheet (Office Surgeon) */
  part: string;
}

export function parseXlsx(bytes: Uint8Array): Sheet[] {
  const files = unzipSync(bytes, { filter: (f) => /\.(xml|rels)$/i.test(f.name) });
  const wbFile = files["xl/workbook.xml"];
  if (!wbFile) throw new Error(tr("engine.xlsx.notXlsx"));
  const wb = parseXml(strFromU8(wbFile));
  const date1904 = descendants(wb, "workbookPr").some((e) => /^(1|true)$/.test(attr(e, "date1904") ?? ""));
  const rels = new Map<string, string>();
  const relFile = files["xl/_rels/workbook.xml.rels"];
  if (relFile)
    for (const r of descendants(parseXml(strFromU8(relFile)), "Relationship")) {
      const t = attr(r, "Target") ?? "";
      rels.set(attr(r, "Id") ?? "", t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""));
    }
  // shared strings (phonetic runs <rPh> are not part of the value)
  const shared: string[] = [];
  const ss = files["xl/sharedStrings.xml"];
  if (ss)
    for (const si of descendants(parseXml(strFromU8(ss)), "si")) {
      let s = "";
      const visit = (n: Element) => {
        for (const c of children(n)) {
          if (c.localName === "rPh" || c.localName === "phoneticPr") continue;
          if (c.localName === "t") s += textOf(c);
          else visit(c);
        }
      };
      visit(si);
      shared.push(s);
    }
  // styles: number formats, bold/italic fonts, horizontal alignment
  let mdw = 7;
  const xfs: { date: string | null; percent: boolean; fmt: string | null; bold: boolean; italic: boolean; align?: Align }[] = [];
  const st = files["xl/styles.xml"];
  if (st) {
    const sd = parseXml(strFromU8(st));
    const fmts = new Map<number, string>();
    for (const f of descendants(sd, "numFmt")) fmts.set(Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? "");
    const fontsEl = descendants(sd, "fonts")[0];
    const f0 = fontsEl && children(fontsEl, "font")[0];
    const nm = f0 && child(f0, "name"), sz = f0 && child(f0, "sz");
    mdw = maxDigitWidth((nm && attr(nm, "val")) ?? undefined, Number(sz && attr(sz, "val")) || 11);
    const fonts = fontsEl ? children(fontsEl, "font").map((f) => ({ bold: !!child(f, "b") && attr(child(f, "b")!, "val") !== "0", italic: !!child(f, "i") && attr(child(f, "i")!, "val") !== "0" })) : [];
    const cellXfs = descendants(sd, "cellXfs")[0];
    if (cellXfs)
      for (const xf of children(cellXfs, "xf")) {
        const id = Number(attr(xf, "numFmtId") ?? 0);
        const code = fmts.get(id) ?? "";
        const date = BUILTIN_DATE.has(id) ? (id >= 18 && id <= 21 ? "h:mm:ss" : id === 22 ? "yyyy-mm-dd h:mm" : "yyyy-mm-dd") : code && isDateFormat(code) ? code : null;
        const font = fonts[Number(attr(xf, "fontId") ?? 0)];
        const al = child(xf, "alignment");
        const h = al && attr(al, "horizontal");
        const fmt = BUILTIN_FMT[id] ?? (code || null);
        xfs.push({
          date,
          fmt: id === 0 || fmt === "@" || /^general$/i.test(fmt ?? "") ? null : fmt,
          percent: id === 9 || id === 10 || /%/.test(code),
          bold: !!font?.bold,
          italic: !!font?.italic,
          align: h === "center" || h === "centerContinuous" ? "CENTER" : h === "right" ? "RIGHT" : undefined,
        });
      }
  }
  const sheets: Sheet[] = [];
  for (const s of descendants(wb, "sheet")) {
    const rid = attr(s, "id") ?? "";
    const path = rels.get(rid) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const f = files[path];
    if (!f) continue;
    const doc = parseXml(strFromU8(f));
    const grid: TableCell[][] = [];
    let maxCol = 0;
    let truncated = false;
    const rowsEl = descendants(doc, "row");
    let autoRow = 0;
    for (const r of rowsEl) {
      const rn = Number(attr(r, "r") ?? autoRow + 1) - 1;
      autoRow = rn + 1;
      if (rn >= MAX_ROWS) {
        truncated = true;
        break;
      }
      let autoCol = 0;
      for (const c of children(r, "c")) {
        const ref = parseRef(attr(c, "r") ?? "");
        const col = ref ? ref.col : autoCol;
        autoCol = col + 1;
        if (col > 255) continue;
        const t = attr(c, "t") ?? "n";
        const vEl = child(c, "v");
        const v = vEl ? textOf(vEl) : "";
        const fEl = child(c, "f");
        const xf = xfs[Number(attr(c, "s") ?? 0)];
        let text = "";
        if (t === "s") text = shared[Number(v)] ?? "";
        else if (t === "inlineStr") text = descendants(c, "t").map(textOf).join("");
        else if (t === "b") text = v === "1" ? "TRUE" : "FALSE";
        else if (t === "str" || t === "e") text = v;
        else if (v !== "") {
          const n = Number(v);
          if (xf?.date && Number.isFinite(n)) text = serialToText(n, date1904, xf.date);
          else if (xf?.percent && Number.isFinite(n)) text = numText(String(n * 100)) + "%";
          else text = numText(v);
        }
        const cell: TableCell = { text };
        if (xf?.bold) cell.bold = true;
        if (xf?.italic) cell.italic = true;
        if (xf?.align) cell.align = xf.align;
        else if ((t === "n" || !attr(c, "t")) && v !== "" && !xf?.date) cell.align = "RIGHT";
        if (fEl && textOf(fEl)) cell.formula = textOf(fEl);
        if (xf?.fmt && (t === "n" || !attr(c, "t")) && v !== "") cell.numFmt = xf.fmt;
        if (!text && !cell.formula && !cell.bold) continue;
        while (grid.length <= rn) grid.push([]);
        grid[rn][col] = cell;
        maxCol = Math.max(maxCol, col + 1);
      }
    }
    while (grid.length && !grid[grid.length - 1].some((c) => c && (c.text || c.formula))) grid.pop();
    const rows = grid.map((r) => Array.from({ length: Math.max(1, maxCol) }, (_, c) => r[c] ?? { text: "" }));
    const widths = new Array(Math.max(1, maxCol)).fill(0);
    for (const col of descendants(doc, "col")) {
      const min = Number(attr(col, "min")), max = Number(attr(col, "max")), w = Number(attr(col, "width"));
      if (!(w > 0)) continue;
      for (let i = min - 1; i < Math.min(max, widths.length); i++) widths[i] = Math.round(w * mdw); // stored width includes the 5px padding (see export)
    }
    sheets.push({ name: attr(s, "name") ?? `Sheet${sheets.length + 1}`, rows, colWidths: widths, merged: descendants(doc, "mergeCell").length, truncated, part: path });
  }
  return sheets;
}

export function importXlsx(bytes: Uint8Array, name: string): { pages: Page[]; sheets: Sheet[] } {
  const sheets = parseXlsx(bytes);
  const pages: Page[] = [];
  for (const sh of sheets) {
    if (!sh.rows.length) continue;
    const auto = sh.rows[0].map((_, c) => {
      let len = 0;
      for (const r of sh.rows.slice(0, 300)) len = Math.max(len, [...(r[c]?.text.split("\n")[0] ?? "")].reduce((a, ch) => a + (/[가-힯一-鿿]/.test(ch) ? 2 : 1), 0)); // i18n: keep — wide-character range, not text
      return Math.min(320, Math.max(48, len * 7 + 16));
    });
    const widths = sh.colWidths.map((w, c) => w || auto[c]);
    const ps = tablePages(sh.rows, `${baseName(name)} · ${sh.name}`, { format: "xlsx", name }, sh.name, widths);
    pages.push(...ps);
  }
  if (!pages.length) throw new Error(tr("engine.xlsx.noContent"));
  return { pages, sheets };
}

// ───────── export ─────────

const DATE_TEXT = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const TIME_TEXT = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const PERCENT_TEXT = /^(-?\d+(?:\.(\d+))?)%$/;
const NUM_TEXT = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const serialStr = (v: number) => String(parseFloat(v.toFixed(10)));

/**
 * The number a cell holds for SpreadsheetML and its number format: dates ("2026-11-11", with an
 * optional time) become 1900-system serial numbers with a date format, "12.5%" becomes 0.125 with a
 * percent format, numbers keep the format they were imported with (currency, thousands separators).
 * null = write the cell as text.
 */
export function cellNumber(c: TableCell): { v: string; fmt: string | null } | null {
  const text = c.text.trim();
  const keep = c.numFmt ?? null;
  let m = DATE_TEXT.exec(text);
  if (m) {
    const day = dateSerial(Number(m[1]), Number(m[2]), Number(m[3]));
    const [h, mi, se] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
    if (day == null || h > 23 || mi > 59 || se > 59) return null;
    const fmt = keep && isDateFormat(keep) ? keep : m[4] ? (m[6] ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd hh:mm") : "yyyy-mm-dd";
    return { v: serialStr(day + (h * 3600 + mi * 60 + se) / 86400), fmt };
  }
  m = TIME_TEXT.exec(text);
  if (m) {
    const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    if (h > 23 || mi > 59 || se > 59) return null;
    const fmt = keep && isDateFormat(keep) ? keep : m[3] ? "h:mm:ss" : "h:mm";
    return { v: serialStr((h * 3600 + mi * 60 + se) / 86400), fmt };
  }
  m = PERCENT_TEXT.exec(text);
  if (m) {
    const fmt = keep && /%/.test(keep) ? keep : m[2] ? `0.${"0".repeat(m[2].length)}%` : "0%";
    return { v: String(parseFloat((Number(m[1]) / 100).toPrecision(15))), fmt };
  }
  if (NUM_TEXT.test(text) && text.length < 16 && !/^-?0\d/.test(text)) return { v: text, fmt: keep && !isDateFormat(keep) && !/%/.test(keep) ? keep : null };
  return null;
}

/** Cell text as XML character data: characters XML 1.0 cannot hold (control characters) are left out. */
export const xmlCellText = (s: string) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ""));

export function sheetName(n: string, used: Set<string>): string {
  let s = n.replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet";
  let k = 2;
  while (used.has(s.toLowerCase())) s = `${s.slice(0, 28)}_${k++}`;
  used.add(s.toLowerCase());
  return s;
}

export function exportXlsx(allPages: Page[]): Uint8Array {
  const tables = collectTables(pagesFor(allPages, ["xlsx", "xls", "csv"]));
  if (!tables.length) throw new Error(tr("engine.xlsx.noTable"));
  const used = new Set<string>();
  const NUM = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
  // number formats: built-in ids where the code is a built-in one, custom ids from 164
  const customFmts: string[] = [];
  const fmtId = (code: string | null) => {
    if (!code) return 0;
    const b = BUILTIN_ID.get(code);
    if (b !== undefined) return b;
    let i = customFmts.indexOf(code);
    if (i < 0) i = customFmts.push(code) - 1;
    return 164 + i;
  };
  // cell formats (xf), de-duplicated; xf 0 is the default
  // key = font id (bit 0 bold, bit 1 italic — the order of FONTS below) | number format id | alignment
  const xfKeys = ["0|0|"];
  const xfIndex = (c: TableCell, header: boolean, fmt: string | null) => {
    const k = `${(c.bold || header ? 1 : 0) | (c.italic ? 2 : 0)}|${fmtId(fmt)}|${c.align === "CENTER" ? "center" : c.align === "RIGHT" ? "right" : ""}`;
    let i = xfKeys.indexOf(k);
    if (i < 0) i = xfKeys.push(k) - 1;
    return i;
  };
  const files: Zippable = {};
  const sheetsXml: string[] = [];
  const relsXml: string[] = [];
  const overrides: string[] = [];
  tables.forEach((t, si) => {
    const rowsXml = t.rows
      .map((r, ri) => {
        const cells = r
          .map((c, ci) => {
            const ref = colName(ci) + (ri + 1);
            const header = t.headerRow && ri === 0;
            const num = c.formula ? null : cellNumber(c);
            const s = xfIndex(c, header, num ? num.fmt : c.formula && c.numFmt && NUM.test(c.text) ? c.numFmt : null);
            const sa = s ? ` s="${s}"` : "";
            if (c.formula) return `<c r="${ref}"${sa}${NUM.test(c.text) ? "" : ' t="str"'}><f>${xmlCellText(c.formula)}</f><v>${xmlCellText(c.text)}</v></c>`;
            if (!c.text) return s ? `<c r="${ref}"${sa}/>` : "";
            if (num) return `<c r="${ref}"${sa}><v>${num.v}</v></c>`;
            return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlCellText(c.text)}</t></is></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    // ECMA-376 Part 1 §18.3.1.13: stored width = Truncate((chars × maxDigitWidth + 5px padding) / maxDigitWidth × 256) / 256,
    // i.e. pixels / maxDigitWidth of the default font; Excel shows (pixels − 5) / maxDigitWidth characters
    const mdw = maxDigitWidth(EXPORT_FONT);
    const cols = `<cols>${t.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(1, Math.trunc((w / mdw) * 256) / 256)}" customWidth="1"/>`).join("")}</cols>`;
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${t.headerRow ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ""}${cols}<sheetData>${rowsXml}</sheetData></worksheet>`,
    );
    sheetsXml.push(`<sheet name="${esc(sheetName(t.name, used))}" sheetId="${si + 1}" r:id="rId${si + 1}"/>`);
    relsXml.push(`<Relationship Id="rId${si + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${si + 1}.xml"/>`);
    overrides.push(`<Override PartName="/xl/worksheets/sheet${si + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });
  const n = tables.length;
  relsXml.push(`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  const cellXfs = xfKeys.map((k) => {
    const [font, fmt, align] = k.split("|");
    return `<xf numFmtId="${fmt}" fontId="${font}" fillId="0" borderId="0" xfId="0"${fmt !== "0" ? ' applyNumberFormat="1"' : ""}${font !== "0" ? ' applyFont="1"' : ""}${align ? ` applyAlignment="1"><alignment horizontal="${align}"/></xf>` : "/>"}`;
  });
  const numFmtsXml = customFmts.length ? `<numFmts count="${customFmts.length}">${customFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(c)}"/>`).join("")}</numFmts>` : "";
  files["xl/styles.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmtsXml}<fonts count="4">${["", "<b/>", "<i/>", "<b/><i/>"].map((bi) => `<font>${bi}<sz val="11"/><name val="${EXPORT_FONT}"/></font>`).join("")}</fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetsXml.join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsXml.join("")}</Relationships>`);
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join("")}</Types>`,
  );
  return zipSync(files, { level: 6 });
}
