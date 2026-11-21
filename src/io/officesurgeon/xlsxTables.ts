// Office Surgeon — XLSX: Excel tables (ListObjects, xl/tables/tableN.xml) whose header or totals label cells change.
//
// A table's column names are its header cells' text (tableColumn name): Excel repairs a workbook where they differ.
// The cell surgeries (officesurgeon/xlsx.ts for table pages, io/sheet/book.ts for sheet pages) hand such a cell here,
// and the column is renamed the way Excel renames it when a header is typed over: an empty name becomes "Column1"
// (in the UI language: 열1, 列1; the first number no other column has), a name another column of the table has (compared without case) gets a number
// ("매출2"), and the cell holds the final name as text. Every structured reference to the column takes the new name —
// Table1[Old], Table1[[#This Row],[Old]], [@Old] in the table's own cells, calculated column and totals row formulas,
// defined names — with Excel's escapes (' before [ ] # ', the column in its own brackets when it needs them).
// A totals row label typed over goes into the column's totalsRowLabel. What cannot be followed throws
// SurgeryUnavailable (the workbook is then written anew, with its warning): a formula typed into a header or label
// cell, a query / XML table, a slicer on the table, a reference whose table cannot be told, a part this does not
// read that names the table (charts, pivot caches, external links…).

import { t } from "../../i18n";
import { SurgeryUnavailable } from "./docx";
import { childrenOf, rootOf, type XmlEl } from "./scan";

export type PartReader = (name: string) => string | null;

interface TableCol {
  /** name as Excel shows it (_xHHHH_ escapes decoded) */
  name: string;
  totalsRowLabel: string | null;
  totalsRowFunction: string | null;
}

export interface XlsxTable {
  part: string;
  id: string;
  /** displayName: what formulas call it */
  name: string;
  /** whole range, 0-based, header and totals rows included */
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  header: boolean;
  totals: boolean;
  /** tableType (worksheet when omitted; queryTable / xml tables are tied to their source) */
  type: string | null;
  cols: TableCol[];
}

const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const unXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))),
  );
const escText = (s: string) => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
const escAttr = (s: string) => s.replace(/[<>&"\t\n\r]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "\t": "&#9;", "\n": "&#10;", "\r": "&#13;" })[c]!);
/** ST_Xstring escapes in a column name: _x000a_ = line feed, _x005F_ = a literal "_" before an x… run */
const decodeName = (s: string) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
const encodeName = (s: string) => s.replace(/_x([0-9A-Fa-f]{4})_/g, "_x005F_x$1_").replace(/[\x00-\x1f]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, "0")}_`);

const colNum = (c: string) => [...c.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const colName = (c: number) => {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const cellAddr = (r: number, c: number) => colName(c) + (r + 1);
const cellOf = (s: string) => {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(s);
  return m ? { r: Number(m[2]) - 1, c: colNum(m[1]) } : null;
};

/** The Excel tables of a worksheet part (its relationships of type …/table). */
export function tablesOfSheet(read: PartReader, sheetPart: string): XlsxTable[] {
  const rels = read(sheetPart.replace(/([^/]+)$/, "_rels/$1.rels"));
  if (!rels) return [];
  const dir = sheetPart.slice(0, sheetPart.lastIndexOf("/") + 1);
  const out: XlsxTable[] = [];
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!/\/table$/.test(attrOf(m[0], "Type") ?? "") || attrOf(m[0], "TargetMode") === "External") continue;
    const target = unXml(attrOf(m[0], "Target") ?? "");
    const segs: string[] = [];
    for (const s of (target.startsWith("/") ? target.slice(1) : dir + target).split("/")) {
      if (s === "..") segs.pop();
      else if (s && s !== ".") segs.push(s);
    }
    const part = segs.join("/");
    const x = read(part);
    if (!x) continue;
    const tag = /<(?:\w+:)?table\b[^>]*>/.exec(x)?.[0] ?? "";
    const [a0, b0] = (attrOf(tag, "ref") ?? "").split(":");
    const a = cellOf(a0 ?? ""), b = cellOf(b0 ?? a0 ?? "");
    if (!a || !b) continue;
    const cols = Array.from(x.matchAll(/<(?:\w+:)?tableColumn\b[^>]*>/g), (c) => {
      const label = attrOf(c[0], "totalsRowLabel");
      return { name: decodeName(unXml(attrOf(c[0], "name") ?? "")), totalsRowLabel: label == null ? null : unXml(label), totalsRowFunction: attrOf(c[0], "totalsRowFunction") };
    });
    out.push({
      part,
      id: attrOf(tag, "id") ?? "",
      name: unXml(attrOf(tag, "displayName") ?? attrOf(tag, "name") ?? ""),
      r0: a.r,
      c0: a.c,
      r1: b.r,
      c1: b.c,
      header: attrOf(tag, "headerRowCount") !== "0",
      totals: Number(attrOf(tag, "totalsRowCount") ?? 0) > 0,
      type: attrOf(tag, "tableType"),
      cols,
    });
  }
  return out;
}

/** Text of a cell value as Excel takes it for a column name; null = not plain text (a formula, an error). */
export function headerText(v: string | number | boolean | undefined | null, formula?: string | null, error?: boolean): string | null {
  if (formula || error) return null;
  if (v == null) return "";
  return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
}

/** The header and totals label cells of a workbook's tables that a save changes, and what follows from them. */
export class TableEdits {
  private bySheet = new Map<string, XlsxTable[]>();
  private heads = new Map<XlsxTable, Map<number, string | null>>();
  private labels = new Map<XlsxTable, Map<number, string | null>>();
  /** names Excel's rules changed (empty, repeated) */
  adjusted = 0;

  constructor(private read: PartReader) {}

  tables(sheetPart: string): XlsxTable[] {
    let ts = this.bySheet.get(sheetPart);
    if (!ts) this.bySheet.set(sheetPart, (ts = tablesOfSheet(this.read, sheetPart)));
    return ts;
  }

  private at(sheetPart: string, r: number, c: number): { tb: XlsxTable; i: number; label: boolean } | null {
    for (const tb of this.tables(sheetPart)) {
      if (c < tb.c0 || c > tb.c1) continue;
      const i = c - tb.c0;
      if (tb.header && r === tb.r0) return { tb, i, label: false };
      // a totals row cell holding a label (not one with a totals function)
      const fn = tb.cols[i]?.totalsRowFunction;
      if (tb.totals && r === tb.r1 && (!fn || fn === "none")) return { tb, i, label: true };
    }
    return null;
  }

  /** Whether the cell (0-based) names a table column or holds a totals row label: its edits go to `edit`. */
  owns(sheetPart: string, r: number, c: number): boolean {
    return !!this.at(sheetPart, r, c);
  }

  /** Whether the cell (0-based) is a table's header cell. */
  isHeader(sheetPart: string, r: number, c: number): boolean {
    return this.at(sheetPart, r, c)?.label === false;
  }

  /** A changed cell `owns` said yes to: its new text, or null when it is not plain text. */
  edit(sheetPart: string, r: number, c: number, text: string | null) {
    const a = this.at(sheetPart, r, c);
    if (!a) return;
    const m = a.label ? this.labels : this.heads;
    const e = m.get(a.tb) ?? new Map<number, string | null>();
    e.set(a.i, text);
    m.set(a.tb, e);
  }

  get any(): boolean {
    return this.heads.size + this.labels.size > 0;
  }

  /**
   * Writes the edits into the package as the save has it so far: `get` reads a part (null = not there), `set` writes
   * one, `parts` names every part. Tables, their header / label cells and the formulas naming renamed columns.
   */
  apply(get: PartReader, set: (name: string, text: string) => void, parts: string[]) {
    const renamed: { tb: XlsxTable; sheet: string; map: Map<string, string> }[] = [];
    const cellText = new Map<string, Map<string, string>>();
    const tableXml = new Map<string, string>();
    for (const [sheet, list] of this.bySheet)
      for (const tb of list) {
        const he = this.heads.get(tb), le = this.labels.get(tb);
        if (!he && !le) continue;
        if (tb.type && tb.type !== "worksheet") throw new SurgeryUnavailable("table type");
        const names = tb.cols.map((c) => c.name);
        const labels = tb.cols.map((c) => c.totalsRowLabel);
        const cells = cellText.get(sheet) ?? new Map<string, string>();
        cellText.set(sheet, cells);
        const map = new Map<string, string>();
        const edits = [...(he ?? [])].sort((a, b) => a[0] - b[0]);
        for (const [i, text] of edits) {
          if (text == null || i >= names.length) throw new SurgeryUnavailable("table header");
          names[i] = "\u0000"; // not compared with itself or with another header changed at the same time
        }
        for (const [i, text] of edits) {
          const taken = (n: string) => names.some((x, k) => k !== i && x.toLowerCase() === n.toLowerCase());
          let name = text!;
          if (!name.trim()) for (let k = 1; taken((name = t("engine.officeSurgeon.tableColumnName", { n: k }))); k++);
          else for (let k = 2; taken(name); k++) name = text! + k;
          names[i] = name;
          if (name !== text) this.adjusted++;
          cells.set(cellAddr(tb.r0, tb.c0 + i), name);
          if (name !== tb.cols[i].name) map.set(tb.cols[i].name.toLowerCase(), name);
        }
        for (const [i, text] of le ?? []) {
          if (text == null || i >= labels.length) throw new SurgeryUnavailable("totals label");
          labels[i] = text || null;
          if (text) cells.set(cellAddr(tb.r1, tb.c0 + i), text);
        }
        const x0 = tableXml.get(tb.part) ?? get(tb.part);
        if (x0 == null) throw new SurgeryUnavailable("table part");
        let k = 0;
        const x = x0.replace(/<((?:\w+:)?)tableColumn\b([^>]*?)(\/?)>/g, (all, p: string, a: string, sl: string) => {
          const i = k++;
          let na = a;
          if (names[i] !== tb.cols[i]?.name) na = setAttr(na, "name", escAttr(encodeName(names[i])));
          if (labels[i] !== tb.cols[i]?.totalsRowLabel) na = labels[i] == null ? na.replace(/\stotalsRowLabel="[^"]*"/, "") : setAttr(na, "totalsRowLabel", escAttr(labels[i]!));
          return na === a ? all : `<${p}tableColumn${na}${sl}>`;
        });
        if (k !== names.length) throw new SurgeryUnavailable("table columns");
        tableXml.set(tb.part, x);
        if (map.size) renamed.push({ tb, sheet, map });
      }
    // the header / label cells hold the names as text
    const sheetXml = new Map<string, string>();
    for (const [sheet, cells] of cellText) {
      let x = get(sheet);
      if (x == null) throw new SurgeryUnavailable("sheet part");
      for (const [a, text] of cells) x = putText(x, a, text);
      sheetXml.set(sheet, x);
    }
    const cur = (n: string) => sheetXml.get(n) ?? tableXml.get(n) ?? get(n);
    if (renamed.length) {
      const byName = (name: string) => renamed.find((r) => r.tb.name.toLowerCase() === name.toLowerCase())?.map ?? null;
      const allOld = renamed.flatMap((r) => [...r.map.keys()]);
      // structured references in worksheets: cells (a reference without a table name is its cell's table's)
      for (const p of parts.filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n))) {
        const x = cur(p);
        if (x == null) continue;
        const own = this.tables(p);
        const y = renameInSheet(x, (name, at) => {
          if (name) return byName(name);
          if (!at) return "unknown";
          const tb = own.find((q) => at.r >= q.r0 && at.r <= q.r1 && at.c >= q.c0 && at.c <= q.c1);
          return (tb && renamed.find((r) => r.tb.part === tb.part)?.map) ?? null;
        }, allOld);
        if (y !== x) sheetXml.set(p, y);
      }
      // calculated column and totals row formulas of every table
      for (const p of parts.filter((n) => /^xl\/tables\/[^/]+\.xml$/i.test(n))) {
        const x = cur(p);
        if (x == null) continue;
        const own = renamed.find((r) => r.tb.part === p)?.map ?? null;
        const y = x.replace(/<((?:\w+:)?)(calculatedColumnFormula|totalsRowFormula)\b([^>]*)>([^<]*)<\/\1\2>/g, (all, px: string, el: string, a: string, f: string) => {
          const g = renameFormula(unXml(f), (name) => (name ? byName(name) : own), allOld);
          return g === unXml(f) ? all : `<${px}${el}${a}>${escText(g)}</${px}${el}>`;
        });
        if (y !== x) tableXml.set(p, y);
      }
      // defined names
      const wb = get("xl/workbook.xml");
      if (wb != null) {
        const y = wb.replace(/(<(?:\w+:)?definedName\b[^>]*>)([^<]*)(<\/)/g, (all, a: string, f: string, c: string) => {
          const g = renameFormula(unXml(f), (name) => (name ? byName(name) : "unknown"), allOld);
          return g === unXml(f) ? all : a + escText(g) + c;
        });
        if (y !== wb) set("xl/workbook.xml", y);
      }
      // parts not followed here that name a renamed table: written anew
      for (const p of parts) {
        if (!/^xl\/.*\.xml$/i.test(p) || /^xl\/(worksheets|tables)\/[^/]+\.xml$|^xl\/(workbook|sharedStrings|styles|calcChain|metadata)\.xml$|^xl\/theme\/|\.rels$/i.test(p)) continue;
        const x = get(p);
        if (x == null) continue;
        const text = unXml(x).toLowerCase();
        for (const r of renamed) {
          if (text.includes(r.tb.name.toLowerCase() + "[")) throw new SurgeryUnavailable("table referenced");
          if (/slicerCache/i.test(p) && new RegExp(`<(?:\\w+:)?tableSlicerCache\\b[^>]*\\stableId="${r.tb.id}"`).test(x)) throw new SurgeryUnavailable("table slicer");
        }
      }
    }
    for (const [p, x] of [...sheetXml, ...tableXml]) set(p, x);
  }
}

const setAttr = (a: string, name: string, v: string) => (new RegExp(`\\s${name}="[^"]*"`).test(a) ? a.replace(new RegExp(`(\\s${name}=")[^"]*"`), `$1${v.replace(/\$/g, "$$$$")}"`) : a.replace(/\s*$/, "") + ` ${name}="${v}"`);

/** The worksheet with the cell `a` holding `text` as an inline string (its other attributes kept; made when missing). */
function putText(xml: string, a: string, text: string): string {
  const at = cellOf(a)!;
  const root = rootOf(xml);
  const px = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":") + 1) : "";
  const sd = childrenOf(xml, root).find((k) => k.local === "sheetData");
  if (!sd) throw new SurgeryUnavailable("sheetData");
  const cell = (attrs: string) => `<${px}c r="${a}"${attrs} t="inlineStr"><${px}is><${px}t xml:space="preserve">${escText(text)}</${px}t></${px}is></${px}c>`;
  let auto = 0;
  let after: XmlEl | null = null;
  for (const row of sd.openEnd === sd.end ? [] : childrenOf(xml, sd).filter((k) => k.local === "row")) {
    const n = Number(attrOf(xml.slice(row.start, row.openEnd), "r") ?? auto + 1) - 1;
    auto = n + 1;
    if (n < at.r) {
      after = row;
      continue;
    }
    if (n > at.r) break;
    let ac = 0;
    let prev: XmlEl | null = null;
    for (const c of childrenOf(xml, row).filter((k) => k.local === "c")) {
      const tag = xml.slice(c.start, c.openEnd);
      const col = cellOf(attrOf(tag, "r") ?? "")?.c ?? ac;
      ac = col + 1;
      if (col < at.c) {
        prev = c;
        continue;
      }
      if (col > at.c) break;
      const attrs = tag.replace(/^<[\w:]+/, "").replace(/\/?>$/, "").replace(/\s(r|t|cm|vm)="[^"]*"/g, "").replace(/\s+$/, "");
      return xml.slice(0, c.start) + cell(attrs) + xml.slice(c.end);
    }
    // the row has no such cell: put one in column order
    if (row.openEnd === row.end) {
      const open = xml.slice(row.start, row.end - 2).trimEnd() + ">";
      return xml.slice(0, row.start) + open + cell("") + `</${row.name}>` + xml.slice(row.end);
    }
    const ins = prev ? prev.end : row.openEnd;
    return xml.slice(0, ins) + cell("") + xml.slice(ins);
  }
  const newRow = `<${px}row r="${at.r + 1}">${cell("")}</${px}row>`;
  if (sd.openEnd === sd.end) return xml.slice(0, sd.start) + xml.slice(sd.start, sd.end - 2).trimEnd() + ">" + newRow + `</${sd.name}>` + xml.slice(sd.end);
  const ins = after ? after.end : sd.openEnd;
  return xml.slice(0, ins) + newRow + xml.slice(ins);
}

/** Map of renamed columns (lower-case old name → new name) for a reference, null = none of its columns renamed,
 * "unknown" = a reference without a table name where the table cannot be told. */
type Resolve = (table: string | undefined, at?: { r: number; c: number }) => Map<string, string> | null | "unknown";

/** A worksheet's formulas with structured references to renamed columns renamed. */
function renameInSheet(xml: string, resolve: Resolve, allOld: string[]): string {
  const root = rootOf(xml);
  const sd = childrenOf(xml, root).find((k) => k.local === "sheetData");
  const fixF = (s: string, at?: { r: number; c: number }) =>
    s.replace(/<((?:\w+:)?)(f|formula|formula1|formula2)\b([^>]*)>([^<]*)<\/\1\2>/g, (all, px: string, el: string, a: string, f: string) => {
      const g = renameFormula(unXml(f), (name) => resolve(name, at), allOld);
      return g === unXml(f) ? all : `<${px}${el}${a}>${escText(g)}</${px}${el}>`;
    });
  // outside sheetData (conditional formats, validations, extensions): no cell to tell a nameless reference's table
  if (!sd || sd.openEnd === sd.end) return fixF(xml);
  const body = xml.slice(sd.openEnd, sd.closeStart).replace(/<((?:\w+:)?)c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/g, (all, _px: string, a: string, inner: string | undefined) => {
    if (!inner || !/<(?:\w+:)?f\b/.test(inner)) return all;
    const ref = /\sr="([^"]*)"/.exec(a)?.[1];
    return fixF(all, (ref && cellOf(ref)) || undefined);
  });
  return fixF(xml.slice(0, sd.openEnd)) + body + fixF(xml.slice(sd.closeStart));
}

const NAME_BEFORE = /([A-Za-z_\\\u0080-￿][\w.\\\u0080-￿]*)$/;

/** Index of the "]" closing the "[" at `at` (nested, ' escapes the next character); -1 when unclosed. */
function bracketEnd(s: string, at: number): number {
  let depth = 0;
  for (let k = at; k < s.length; k++) {
    if (s[k] === "'") k++;
    else if (s[k] === "[") depth++;
    else if (s[k] === "]" && --depth === 0) return k;
  }
  return -1;
}

/** The formula with structured references to renamed columns renamed (strings and quoted sheet names skipped). */
export function renameFormula(f: string, resolve: (table: string | undefined) => Map<string, string> | null | "unknown", allOld: string[]): string {
  let out = "";
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"' || ch === "'") {
      // a string ("" inside) or a quoted sheet name ('' inside)
      let j = i + 1;
      while (j < f.length && !(f[j] === ch && f[j + 1] !== ch)) j += f[j] === ch ? 2 : 1;
      out += f.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch !== "[") {
      out += ch;
      i++;
      continue;
    }
    const end = bracketEnd(f, i);
    if (end < 0) throw new SurgeryUnavailable("formula");
    const spec = f.slice(i + 1, end);
    const nm = NAME_BEFORE.exec(out);
    const name = nm?.[1];
    const before = nm ? out[out.length - name!.length - 1] : out[out.length - 1];
    // an external book index ([1]Sheet1!A1) is not a structured reference
    const external = !name && /^\d+$/.test(spec) && /^[\w'!\u0080-￿]/.test(f.slice(end + 1));
    let map: ReturnType<typeof resolve> = null;
    if (!external) map = before === "!" ? (name && resolve(name) ? "unknown" : null) : resolve(name);
    if (map === "unknown") {
      if (mentions(spec, allOld)) throw new SurgeryUnavailable("structured reference");
      map = null;
    }
    out += map ? "[" + renameSpec(spec, map) + "]" : f.slice(i, end + 1);
    i = end + 1;
  }
  return out;
}

const unesc = (s: string) => s.replace(/'(.)/g, "$1");
const escName = (s: string) => s.replace(/['[\]#]/g, "'$&");
/** a column name written without its own brackets (Table1[매출]) */
const plain = (s: string) => /^[\p{L}\p{N}_]+(?: [\p{L}\p{N}_]+)*$/u.test(s) && !/^\d+$/.test(s);
const lookup = (map: Map<string, string>, old: string) => map.get(old.toLowerCase()) ?? map.get(old.trim().toLowerCase());

function mentions(spec: string, olds: string[]): boolean {
  const items = spec.includes("[") ? Array.from(spec.matchAll(/\[((?:'.|[^\]])*)\]/g), (m) => m[1]) : [spec.replace(/^\s*@\s*/, "")];
  return items.some((x) => olds.includes(unesc(x).toLowerCase()) || olds.includes(unesc(x).trim().toLowerCase()));
}

/** The inside of a structured reference's brackets with renamed columns renamed. */
function renameSpec(spec: string, map: Map<string, string>): string {
  const pre = /^\s*(@\s*)?/.exec(spec)![0];
  const body = spec.slice(pre.length);
  if (!body.trim() || body[0] === "#") return spec;
  if (body[0] !== "[") {
    const nw = lookup(map, unesc(body));
    return nw == null ? spec : pre + (plain(nw) ? escName(nw) : `[${escName(nw)}]`);
  }
  let out = "";
  for (let k = 0; k < body.length; ) {
    const ch = body[k];
    if (ch === "[") {
      let e = -1;
      for (let j = k + 1; j < body.length; j++) {
        if (body[j] === "'") j++;
        else if (body[j] === "[") break;
        else if (body[j] === "]") {
          e = j;
          break;
        }
      }
      if (e < 0) throw new SurgeryUnavailable("structured reference");
      const inner = body.slice(k + 1, e);
      const nw = inner.trimStart().startsWith("#") || inner.trimStart().startsWith("@") ? null : lookup(map, unesc(inner));
      if (inner.trimStart().startsWith("@")) throw new SurgeryUnavailable("structured reference");
      out += nw == null ? body.slice(k, e + 1) : `[${escName(nw)}]`;
      k = e + 1;
    } else if (/[\s,:]/.test(ch)) {
      out += ch;
      k++;
    } else throw new SurgeryUnavailable("structured reference");
  }
  return pre + out;
}
