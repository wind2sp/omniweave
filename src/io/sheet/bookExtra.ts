// Office Surgeon for sheet pages, second part (표 계산 수술 보충): what io/sheet/book.ts does not write by cell diff —
// rows / columns inserted or deleted (the worksheet XML moved line by line: <row r>, <c r>, formulas, merges,
// conditional formats, data validation, hyperlinks, AutoFilter, frozen panes, column widths; and the parts that point
// into the sheet: drawing anchors, notes and their VML shapes, threaded comments, tables, chart series, pivot caches,
// defined names), notes added / edited / deleted (comments part and its VML drawing), and the AutoFilter.
// Every other byte of the package stays as it was.

import type { SheetCondRule, SheetData, SheetNote } from "../../core/sheetTypes";
import { SurgeryUnavailable } from "../officesurgeon/docx";
import { childrenOf, rootOf } from "../officesurgeon/scan";
import type { ZipArchive } from "../officesurgeon/zip";
import { addr, colLetters, parseAddr, parseRange } from "./formula";
import { relsOf, relTarget } from "./readExtra";
import { writeSheetDrawings, type PkgRels } from "./writeDrawings";
import { filterColumnXml, writeSheetParts } from "./writeParts";
import { readPersons, writeThreads } from "./threads";
import { writeNewTables } from "./writeTables";
import { markRefreshed, markShown, maxCacheId, writeNewPivots, type NewPivot } from "./pivots";
import { writeNewSlicers, type SlicerCacheOut } from "./slicers";
import { adjustAddr, adjustFormula, adjustRange, adjustSqref, applyStructToSheet, frozenAfter, shiftIndex, shiftSpan, type StructOp } from "./structure";

const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const setAttr = (tag: string, name: string, v: string) => (new RegExp(`\\s${name}="[^"]*"`).test(tag) ? tag.replace(new RegExp(`\\s${name}="[^"]*"`), ` ${name}="${v}"`) : tag.replace(/^<([\w:]+)/, `<$1 ${name}="${v}"`));
const unesc = (s: string) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_m, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e as string]!);
/** text-node escaping that leaves quotes alone (Excel writes them raw) */
const escText = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

/** CT_Worksheet child order (ECMA-376 §18.3.1.99). */
const SHEET_ORDER = ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"];

/** The worksheet with its child `local` replaced by `el` ("" removes it), or `el` put where the schema wants it. */
export function placeChild(xml: string, local: string, el: string): string {
  const root = rootOf(xml);
  const kids = childrenOf(xml, root);
  const cur = kids.find((k) => k.local === local);
  if (cur) return xml.slice(0, cur.start) + el + xml.slice(cur.end);
  if (!el) return xml;
  const rank = SHEET_ORDER.indexOf(local);
  const next = kids.find((k) => SHEET_ORDER.indexOf(k.local) > rank);
  const at = next ? next.start : root.closeStart;
  return xml.slice(0, at) + el + xml.slice(at);
}

// ───── moving the worksheet XML ─────

/** Formula text in XML (escaped) after a change. */
const fxXml = (text: string, op: StructOp, own: string | undefined, target: string) => {
  const f = unesc(text);
  const g = adjustFormula(f, op, own, target);
  return g === f ? text : escText(g);
};

/** The worksheet XML after one row / column change; `shared` = cells that hold shared formulas (rewritten whole). */
export function structSheetXml(xml: string, op: StructOp, own: string): { xml: string; shared: string[] } {
  const root = rootOf(xml);
  const sd = childrenOf(xml, root).find((k) => k.local === "sheetData");
  if (!sd) throw new SurgeryUnavailable("sheetData");
  const shared: string[] = [];
  const fx = (t: string) => fxXml(t, op, own, own);
  let body = "";
  let autoR = 0;
  for (const row of childrenOf(xml, sd)) {
    if (row.local !== "row") {
      body += xml.slice(row.start, row.end);
      continue;
    }
    let tag = xml.slice(row.start, row.openEnd);
    const rn = Number(attrOf(tag, "r") ?? autoR + 1);
    autoR = rn;
    let r = rn - 1;
    if (op.axis === "row") {
      const nr = shiftIndex(r, op);
      if (nr == null) continue;
      r = nr;
    }
    tag = setAttr(tag.replace(/\sspans="[^"]*"/, ""), "r", String(r + 1));
    if (row.openEnd === row.end) {
      body += tag;
      continue;
    }
    let inner = "";
    let ac = 0;
    for (const c of childrenOf(xml, row)) {
      let text = xml.slice(c.start, c.end);
      if (c.local !== "c") {
        inner += text;
        continue;
      }
      const ctag = xml.slice(c.start, c.openEnd);
      const p = parseAddr(attrOf(ctag, "r") ?? "");
      const col = p ? p.c : ac;
      ac = col + 1;
      let nc = col;
      if (op.axis === "col") {
        const x = shiftIndex(col, op);
        if (x == null) continue;
        nc = x;
      }
      const a = addr(r, nc);
      text = setAttr(ctag, "r", a) + text.slice(ctag.length);
      text = text.replace(/<((?:\w+:)?f)\b([^>]*?)(\/?)>(?:([\s\S]*?)<\/\1>)?/, (_m, name: string, attrs: string, selfClose: string, ftext: string | undefined) => {
        let at = attrs;
        const ref = attrOf(at, "ref");
        if (ref) {
          const nr = adjustRange(ref, op);
          if (nr) at = at.replace(/\sref="[^"]*"/, ` ref="${nr}"`);
        }
        if (/\st="shared"/.test(at)) shared.push(a);
        if (selfClose) return `<${name}${at}/>`;
        return `<${name}${at}>${ftext ? fx(ftext) : ""}</${name}>`;
      });
      inner += text;
    }
    body += tag + inner + xml.slice(row.closeStart, row.end);
  }
  const head = xml.slice(0, sd.openEnd), tail = xml.slice(sd.closeStart);
  const out = moveRest(head, op, own) + body + moveRest(tail, op, own);
  return { xml: sd.openEnd === sd.end ? moveRest(xml, op, own) : out, shared };
}

/** Everything of a worksheet outside sheetData after a change. */
function moveRest(x: string, op: StructOp, own: string): string {
  const fx = (t: string) => fxXml(t, op, own, own);
  const sq = (s: string) => adjustSqref(s, op);
  x = x.replace(/(<(?:\w+:)?dimension\b[^>]*\sref=")([^"]*)"/, (_m, a, ref) => `${a}${adjustRange(ref, op) ?? "A1"}"`);
  // panes and selections
  x = x.replace(/<(?:\w+:)?pane\b[^>]*>/g, (tag) => {
    let t = tag;
    if (/state="frozen/.test(t)) {
      const key = op.axis === "row" ? "ySplit" : "xSplit";
      const v = attrOf(t, key);
      if (v) {
        const n = frozenAfter(Math.round(Number(v)), op);
        t = n ? setAttr(t, key, String(n)) : t.replace(new RegExp(`\\s${key}="[^"]*"`), "");
      }
    }
    const tl = attrOf(t, "topLeftCell");
    if (tl) t = setAttr(t, "topLeftCell", adjustAddr(tl, op, true) ?? tl);
    return t;
  });
  x = x.replace(/<(?:\w+:)?sheetView\b[^>]*>/g, (tag) => {
    const tl = attrOf(tag, "topLeftCell");
    return tl ? setAttr(tag, "topLeftCell", adjustAddr(tl, op, true) ?? tl) : tag;
  });
  x = x.replace(/<(?:\w+:)?selection\b[^>]*>/g, (tag) => {
    let t = tag;
    const ac = attrOf(t, "activeCell");
    const na = ac ? adjustAddr(ac, op, true) ?? ac : null;
    if (ac) t = setAttr(t, "activeCell", na!);
    const s = attrOf(t, "sqref");
    if (s) t = setAttr(t, "sqref", sq(s) || na || "A1");
    return t;
  });
  // column widths
  if (op.axis === "col")
    x = x.replace(/<((?:\w+:)?)col\b[^>]*\/>/g, (tag) => {
      const a = Number(attrOf(tag, "min")) - 1, b = Number(attrOf(tag, "max")) - 1;
      const write = (lo: number, hi: number) => setAttr(setAttr(tag, "min", String(lo + 1)), "max", String(hi + 1));
      if (op.n > 0 && a < op.at && b >= op.at) return write(a, op.at - 1) + (op.at + op.n <= 16383 ? write(op.at + op.n, Math.min(16383, b + op.n)) : "");
      const s = shiftSpan(a, b, op);
      return s ? write(s[0], s[1]) : "";
    });
  // merges
  x = x.replace(/<(?:\w+:)?mergeCell\b[^>]*\/>/g, (tag) => {
    const r = adjustRange(attrOf(tag, "ref") ?? "", op);
    const g = r && parseRange(r);
    return g && (g.r0 !== g.r1 || g.c0 !== g.c1) ? setAttr(tag, "ref", r!) : "";
  });
  x = x.replace(/<((?:\w+:)?mergeCells)\b([^>]*)>([\s\S]*?)<\/\1>/, (_m, name, attrs, inner: string) => {
    const n = (inner.match(/<(?:\w+:)?mergeCell\b/g) ?? []).length;
    return n ? `<${name}${attrs.replace(/\scount="\d+"/, ` count="${n}"`)}>${inner}</${name}>` : "";
  });
  // conditional formats (and the x14 ones in extLst)
  x = x.replace(/<((?:\w+:)?conditionalFormatting)\b([^>]*)>([\s\S]*?)<\/\1>/g, (_m, name: string, attrs: string, inner: string) => {
    let at = attrs;
    const s = attrOf(at, "sqref");
    if (s != null) {
      const ns = sq(s);
      if (!ns) return "";
      at = at.replace(/\ssqref="[^"]*"/, ` sqref="${ns}"`);
    }
    let body = inner.replace(/<((?:\w+:)?(?:formula|f))>([^<]*)<\/\1>/g, (_m2, n2, t) => `<${n2}>${fx(t)}</${n2}>`);
    let gone = false;
    body = body.replace(/<((?:\w+:)?sqref)>([^<]*)<\/\1>/g, (_m2, n2, t) => {
      const ns = sq(t);
      if (!ns) gone = true;
      return `<${n2}>${ns}</${n2}>`;
    });
    return gone ? "" : `<${name}${at}>${body}</${name}>`;
  });
  // data validation
  x = x.replace(/<((?:\w+:)?dataValidation)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g, (_m, name: string, attrs: string, rest: string, inner: string | undefined) => {
    let at = attrs;
    const s = attrOf(at, "sqref");
    if (s != null) {
      const ns = sq(s);
      if (!ns) return "";
      at = at.replace(/\ssqref="[^"]*"/, ` sqref="${ns}"`);
    }
    if (inner === undefined) return `<${name}${at}${rest}`;
    let gone = false;
    let body = inner.replace(/<((?:\w+:)?(?:formula1|formula2|f))>([^<]*)<\/\1>/g, (_m2, n2, t) => `<${n2}>${fx(t)}</${n2}>`);
    body = body.replace(/<((?:\w+:)?sqref)>([^<]*)<\/\1>/g, (_m2, n2, t) => {
      const ns = sq(t);
      if (!ns) gone = true;
      return `<${n2}>${ns}</${n2}>`;
    });
    return gone ? "" : `<${name}${at}>${body}</${name}>`;
  });
  x = x.replace(/<((?:\w+:)?dataValidations)\b([^>]*)>([\s\S]*?)<\/\1>/g, (_m, name, attrs: string, inner: string) => {
    const n = (inner.match(/<(?:\w+:)?dataValidation\b/g) ?? []).length;
    return n ? `<${name}${attrs.replace(/\scount="\d+"/, ` count="${n}"`)}>${inner}</${name}>` : "";
  });
  // hyperlinks, ignored errors, protected ranges
  x = x.replace(/<(?:\w+:)?hyperlink\b[^>]*\/>/g, (tag) => {
    const r = adjustRange(attrOf(tag, "ref") ?? "", op);
    return r ? setAttr(tag, "ref", r) : "";
  });
  x = x.replace(/<((?:\w+:)?hyperlinks)\b[^>]*>\s*<\/\1>/, "");
  x = x.replace(/<(?:\w+:)?(?:ignoredError|protectedRange)\b[^>]*>/g, (tag) => {
    const s = attrOf(tag, "sqref");
    return s ? setAttr(tag, "sqref", sq(s) || s) : tag;
  });
  // AutoFilter and sort state
  x = x.replace(/<((?:\w+:)?autoFilter)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/, (_m, name: string, attrs: string, rest: string, inner: string | undefined) => {
    const ref = attrOf(attrs, "ref");
    const nr = ref ? adjustRange(ref, op) : null;
    if (ref && !nr) return "";
    const at = nr ? attrs.replace(/\sref="[^"]*"/, ` ref="${nr}"`) : attrs;
    if (inner === undefined) return `<${name}${at}${rest}`;
    let body = inner;
    if (op.axis === "col" && ref) {
      const c0 = parseRange(ref)!.c0, n0 = parseRange(nr!)!.c0;
      body = body.replace(/<((?:\w+:)?filterColumn)\b([^>]*?)(\/>|>[\s\S]*?<\/\1>)/g, (_m2, n2: string, a2: string, r2: string) => {
        const nc = shiftIndex(c0 + Number(attrOf(a2, "colId") ?? 0), op);
        return nc == null ? "" : `<${n2}${setAttr(a2, "colId", String(nc - n0))}${r2}`;
      });
    }
    return `<${name}${at}>${body}</${name}>`;
  });
  x = x.replace(/<(?:\w+:)?(?:sortState|sortCondition)\b[^>]*>/g, (tag) => {
    const r = attrOf(tag, "ref");
    const nr = r ? adjustRange(r, op) : null;
    return nr ? setAttr(tag, "ref", nr) : tag;
  });
  return x;
}

/** Drawing anchors after a change (pictures, charts, shapes move with their cells; absolute ones stay). */
export function structDrawingXml(xml: string, op: StructOp): string {
  const key = op.axis === "row" ? "row" : "col";
  return xml.replace(/<((?:\w+:)?)(twoCellAnchor|oneCellAnchor)\b([^>]*)>([\s\S]*?)<\/\1\2>/g, (m, px: string, kind: string, attrs: string, inner: string) => {
    if (/editAs="absolute"/.test(attrs)) return m;
    let delta = 0;
    const move = (part: "from" | "to", body: string) =>
      body.replace(new RegExp(`(<${px}${part}>[\\s\\S]*?<${px}${key}>)(\\d+)(</${px}${key}>)`), (_m2, a, v, b) => {
        const i = Number(v);
        let j: number;
        if (part === "to" && (kind === "oneCellAnchor" || /editAs="oneCell"/.test(attrs))) j = i + delta;
        else j = shiftIndex(i, op) ?? op.at;
        if (part === "from") delta = j - i;
        return `${a}${Math.max(0, j)}${b}`;
      });
    const body = move("to", move("from", inner));
    return `<${px}${kind}${attrs}>${body}</${px}${kind}>`;
  });
}

/** A notes VML drawing after a change: note shapes follow their cells (deleted cells drop theirs). */
export function structVml(xml: string, op: StructOp): string {
  return xml.replace(/<(v:shape)\b[^>]*>[\s\S]*?<\/v:shape>/g, (m) => {
    if (!/ObjectType="Note"/.test(m)) return m;
    const r = Number(/<x:Row>(\d+)<\/x:Row>/.exec(m)?.[1] ?? -1), c = Number(/<x:Column>(\d+)<\/x:Column>/.exec(m)?.[1] ?? -1);
    if (r < 0 || c < 0) return m;
    const i = shiftIndex(op.axis === "row" ? r : c, op);
    if (i == null) return "";
    let out = m.replace(op.axis === "row" ? /<x:Row>\d+<\/x:Row>/ : /<x:Column>\d+<\/x:Column>/, op.axis === "row" ? `<x:Row>${i}</x:Row>` : `<x:Column>${i}</x:Column>`);
    out = out.replace(/<x:Anchor>([^<]*)<\/x:Anchor>/, (_m2, list: string) => {
      const v = list.split(",").map((s) => Number(s.trim()));
      if (v.length !== 8) return _m2;
      const idx = op.axis === "row" ? [2, 6] : [0, 4];
      const d = (shiftIndex(v[idx[0]], op) ?? op.at) - v[idx[0]];
      for (const k of idx) v[k] = Math.max(0, v[k] + d);
      return `<x:Anchor>${v.join(", ")}</x:Anchor>`;
    });
    return out;
  });
}

// ───── notes ─────

const NOTE_W = 2, NOTE_H = 4;
function noteShape(id: number, r: number, c: number): string {
  return (
    `<v:shape id="_x0000_s${id}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:${id % 1024};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">` +
    `<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>` +
    `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${c + 1}, 15, ${Math.max(0, r - 1)}, 10, ${c + 1 + NOTE_W}, 15, ${Math.max(0, r - 1) + NOTE_H}, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${r}</x:Row><x:Column>${c}</x:Column></x:ClientData></v:shape>`
  );
}
const SHAPETYPE =
  '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>';

const noteXml = (px: string, ref: string, authorId: number, n: SheetNote) => `<${px}comment ref="${ref}" authorId="${authorId}"><${px}text><${px}t xml:space="preserve">${escText(n.text.replace(/\r\n/g, "\n"))}</${px}t></${px}text></${px}comment>`;

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const sameNote = (a: SheetNote | undefined, b: SheetNote | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A fresh sheet's notes (Shift+F2 in a new workbook): the comments part, the VML drawing Excel shows them with and the
 * sheet's <legacyDrawing>, as Excel writes them.
 */
export function writeFreshNotes(xml: string, sh: SheetData, pkg: PkgRels): string {
  const notes = Object.entries(sh.notes ?? {});
  if (!notes.length) return xml;
  const authors: string[] = [];
  const authorOf = (n: SheetNote) => {
    const name = n.author ?? "";
    const i = authors.indexOf(name);
    return i >= 0 ? i : authors.push(name) - 1;
  };
  const list = notes.map(([a, n]) => noteXml("", a, authorOf(n), n)).join("");
  const cPath = pkg.freeName((n) => `xl/comments${n}.xml`);
  pkg.setPart(
    cPath,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors>${authors.map((a) => `<author>${escText(a)}</author>`).join("")}</authors><commentList>${list}</commentList></comments>`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml",
  );
  pkg.addRel(pkg.part, `${REL_NS}/comments`, cPath);
  const vPath = pkg.freeName((n) => `xl/drawings/vmlDrawing${n}.vml`);
  const block = Number(/(\d+)\.vml$/.exec(vPath)![1]);
  let id = block * 1024 + 1;
  const shapes = notes.map(([a]) => {
    const p = parseAddr(a)!;
    return noteShape(id++, p.r, p.c);
  });
  pkg.setPart(
    vPath,
    `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${block}"/></o:shapelayout>${SHAPETYPE}${shapes.join("")}</xml>`,
    "application/vnd.openxmlformats-officedocument.vmlDrawing",
  );
  const rid = pkg.addRel(pkg.part, `${REL_NS}/vmlDrawing`, vPath);
  return placeChild(xml, "legacyDrawing", `<legacyDrawing r:id="${rid}"/>`);
}

// ───── the surgery ─────

export class SheetSurgery {
  private parts = new Map<string, string>();
  /** binary parts written here (pictures) */
  private bins = new Map<string, Uint8Array>();
  private removed = new Set<string>();
  private wbFns: ((wb: string) => string)[] = [];
  private ctFns: ((ct: string) => string)[] = [];
  /** cells moved: calcChain is stale and Excel should recalculate */
  moved = false;

  constructor(
    private zip: ZipArchive,
    private readOrig: (name: string) => string | null,
  ) {}

  get(name: string): string | null {
    if (this.removed.has(name)) return null;
    return this.parts.get(name) ?? this.readOrig(name);
  }
  private set(name: string, text: string) {
    this.removed.delete(name);
    if (text !== this.readOrig(name)) this.parts.set(name, text);
    else this.parts.delete(name);
  }
  private remove(name: string) {
    this.parts.delete(name);
    if (this.zip.entries.some((e) => e.name === name)) this.removed.add(name);
  }
  private exists(name: string) {
    return !this.removed.has(name) && (this.parts.has(name) || this.zip.entries.some((e) => e.name === name));
  }
  private rels(part: string): { id: string; type: string; target: string; tag: string }[] {
    const x = this.get(relsOf(part));
    if (!x) return [];
    return [...x.matchAll(/<Relationship\b[^>]*>/g)].map((m) => ({ id: attrOf(m[0], "Id") ?? "", type: (attrOf(m[0], "Type") ?? "").replace(/^.*\//, ""), target: attrOf(m[0], "TargetMode") === "External" ? "" : relTarget(part, unesc(attrOf(m[0], "Target") ?? "")), tag: m[0] }));
  }
  private addRel(part: string, type: string, target: string): string {
    const rp = relsOf(part);
    let x = this.get(rp) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const ids = [...x.matchAll(/\sId="rId(\d+)"/g)].map((m) => Number(m[1]));
    const id = `rId${Math.max(0, ...ids) + 1}`;
    const dir = part.split("/").slice(0, -1);
    const tparts = target.split("/");
    let common = 0;
    while (common < dir.length && dir[common] === tparts[common]) common++;
    const rel = [...dir.slice(common).map(() => ".."), ...tparts.slice(common)].join("/");
    x = x.replace(/<\/Relationships>\s*$/, `<Relationship Id="${id}" Type="${type}" Target="${rel}"/></Relationships>`);
    if (!x.includes(id)) x = x.replace(/<Relationships\b([^>]*)\/>/, `<Relationships$1><Relationship Id="${id}" Type="${type}" Target="${rel}"/></Relationships>`);
    this.set(rp, x);
    return id;
  }
  private dropRel(part: string, id: string) {
    const rp = relsOf(part);
    const x = this.get(rp);
    if (x) this.set(rp, x.replace(new RegExp(`<Relationship\\b[^>]*\\sId="${id}"[^>]*/>`), ""));
  }
  private freeName(pattern: (n: number) => string): string {
    for (let n = 1; ; n++) if (!this.exists(pattern(n))) return pattern(n);
  }

  /**
   * Before the cell diff of a sheet: its rows / columns changes applied to its XML, to the parts that point into it
   * and to the original model `o` (so that the diff sees only real edits). Returns the moved XML and the cells to
   * write out whole (shared formulas).
   */
  before(sh: SheetData, o: SheetData, xml: string): { xml: string; force: Set<string> } {
    const force = new Set<string>();
    const ops = sh.struct ?? [];
    if (!ops.length || !sh.part) return { xml, force };
    const own = o.name;
    for (const op of ops) {
      const r = structSheetXml(xml, op, own);
      xml = r.xml;
      for (const a of force) {
        const na = adjustAddr(a, op);
        force.delete(a);
        if (na) force.add(na);
      }
      r.shared.forEach((a) => force.add(a));
      applyStructToSheet(o, op);
      // parts of this sheet
      for (const rel of this.rels(sh.part)) {
        const x = rel.target && this.get(rel.target);
        if (!x) continue;
        if (rel.type === "drawing") this.set(rel.target, structDrawingXml(x, op));
        else if (rel.type === "vmlDrawing") this.set(rel.target, structVml(x, op));
        else if (rel.type === "comments" || rel.type === "threadedComment")
          this.set(
            rel.target,
            x.replace(/<((?:\w+:)?(?:comment|threadedComment))\b([^>]*?)(\/>|>[\s\S]*?<\/\1>)/g, (m, _n, attrs: string) => {
              const ref = attrOf(attrs, "ref");
              if (!ref) return m;
              const na = adjustAddr(ref, op);
              return na ? m.replace(` ref="${ref}"`, ` ref="${na}"`) : "";
            }),
          );
        else if (rel.type === "table") {
          const tag = /<(?:\w+:)?table\b[^>]*>/.exec(x)?.[0] ?? "";
          const g = parseRange(attrOf(tag, "ref") ?? "");
          if (!g) continue;
          if (op.axis === "col" && op.at <= g.c1 && (op.n < 0 ? op.at - op.n - 1 >= g.c0 : op.at > g.c0)) throw new SurgeryUnavailable("table columns");
          const nr = adjustRange(attrOf(tag, "ref")!, op);
          if (!nr) throw new SurgeryUnavailable("table deleted");
          this.set(rel.target, x.replace(/(<(?:\w+:)?(?:table|autoFilter)\b[^>]*\sref=")([^"]*)"/g, (_m, a, ref) => `${a}${adjustRange(ref, op) ?? ref}"`));
        }
      }
      // chart series, pivot sources and defined names that point at the sheet
      for (const e of this.zip.entries) {
        if (/^xl\/charts\/chart[^/]*\.xml$/.test(e.name)) {
          const x = this.get(e.name);
          if (x && x.includes(own)) this.set(e.name, x.replace(/<((?:\w+:)?f)>([^<]*)<\/\1>/g, (_m, n, t) => `<${n}>${fxXml(t, op, undefined, own)}</${n}>`));
        } else if (/^xl\/pivotCache\/pivotCacheDefinition[^/]*\.xml$/.test(e.name)) {
          const x = this.get(e.name);
          if (x)
            this.set(
              e.name,
              x.replace(/<(?:\w+:)?worksheetSource\b[^>]*>/g, (tag) => {
                const s = attrOf(tag, "sheet"), ref = attrOf(tag, "ref");
                if (!s || !ref || unesc(s).toLowerCase() !== own.toLowerCase()) return tag;
                return setAttr(tag, "ref", adjustRange(ref, op) ?? ref);
              }),
            );
        }
      }
      this.wbFns.push((wb) => wb.replace(/(<(?:\w+:)?definedName\b[^>]*>)([^<]*)(<\/)/g, (_m, a, body: string, c) => a + fxXml(body, op, undefined, own) + c));
    }
    this.moved = true;
    return { xml, force };
  }

  /**
   * After the cell diff: notes and the AutoFilter written when they changed; with `dxfOf`, also conditional formats,
   * validation, hyperlinks, protection, page setup and charts (io/sheet/writeParts.ts, writeDrawings.ts).
   */
  /** pivot caches of pivot tables written here (the workbook lists them; io/sheet/book.ts) */
  caches: (NewPivot & { sheet: string })[] = [];
  private cacheId = -1;
  /** table ids (new tables and the file's), and the slicer caches of slicers made here (io/sheet/slicers.ts) */
  tableIds = new Map<string, number>();
  slicerCaches: SlicerCacheOut[] = [];

  /** the workbook's threaded-comment authors (persons part): read once, added to by threads written here */
  private personsMap: Map<string, string> | null = null;
  personsChanged = false;
  get persons(): Map<string, string> {
    return (this.personsMap ??= readPersons(this.readOrig("xl/persons/person.xml")));
  }

  after(sh: SheetData, o: SheetData, xml: string, dxfOf?: (st: NonNullable<SheetCondRule["style"]>) => number, sheets?: SheetData[]): string {
    if (JSON.stringify(sh.notes ?? {}) !== JSON.stringify(o.notes ?? {})) xml = this.writeNotes(sh, o, xml);
    if (sh.part && JSON.stringify(sh.threads ?? {}) !== JSON.stringify(o.threads ?? {})) {
      const n = this.persons.size;
      if (writeThreads(sh, o, this.pkgFor(sh.part), this.persons) && this.persons.size !== n) this.personsChanged = true;
    }
    if (JSON.stringify(sh.filter ?? null) !== JSON.stringify(o.filter ?? null)) xml = this.writeFilter(sh, o, xml);
    if (dxfOf && sh.part) {
      const pkg = this.pkgFor(sh.part);
      const before = xml;
      xml = writeSheetParts(xml, sh, o, dxfOf, pkg);
      xml = writeSheetDrawings(xml, sh, o, pkg);
      xml = writeNewTables(xml, sh, o, pkg, this.tableIds);
      if (sheets) {
        const sl = writeNewSlicers(xml, sh, o, pkg, sheets);
        xml = sl.xml;
        this.slicerCaches.push(...sl.caches);
        markRefreshed(sh, o, pkg);
        markShown(sh, o, pkg);
        this.caches.push(...writeNewPivots(sh, sheets, pkg, () => (this.cacheId = (this.cacheId < 0 ? maxCacheId(this.readOrig("xl/workbook.xml") ?? "") : this.cacheId) + 1)).map((x) => ({ ...x, sheet: sh.name })));
      }
      if (xml !== before && /\sr:id=/.test(xml) && !new RegExp(`xmlns:r="${REL_NS}"`).test(xml.slice(0, rootOf(xml).openEnd))) xml = xml.replace(/<((?:\w+:)?worksheet)\b/, `<$1 xmlns:r="${REL_NS}"`);
    }
    return xml;
  }

  /** A sheet added here (written whole): its formats, validation, links, protection, page setup, charts and pivots. */
  fresh(sh: SheetData, xml: string, part: string, dxfOf: (st: NonNullable<SheetCondRule["style"]>) => number, sheets: SheetData[]): string {
    const pkg = this.pkgFor(part);
    xml = writeSheetParts(xml, sh, null, dxfOf, pkg);
    xml = writeSheetDrawings(xml, sh, null, pkg);
    xml = writeFreshNotes(xml, sh, pkg);
    xml = writeNewTables(xml, sh, null, pkg, this.tableIds);
    const sl = writeNewSlicers(xml, sh, null, pkg, sheets);
    xml = sl.xml;
    this.slicerCaches.push(...sl.caches);
    this.caches.push(...writeNewPivots(sh, sheets, pkg, () => (this.cacheId = (this.cacheId < 0 ? maxCacheId(this.readOrig("xl/workbook.xml") ?? "") : this.cacheId) + 1)).map((x) => ({ ...x, sheet: sh.name })));
    return xml;
  }

  /** The package as the chart / hyperlink writers see it, for one worksheet part. */
  private pkgFor(part: string): PkgRels {
    return {
      part,
      addRel: (from, type, target) => this.addRel(from, type, target),
      rels: (from) => this.rels(from),
      getPart: (name) => this.get(name),
      setPart: (name, text, ct) => {
        const isNew = !this.exists(name);
        this.set(name, text);
        if (isNew && ct) this.ctFns.push((c) => (c.includes(`"/${name}"`) ? c : c.replace(/<\/Types>/, `<Override PartName="/${name}" ContentType="${ct}"/></Types>`)));
      },
      setBytes: (name, bytes, ct) => {
        this.bins.set(name, bytes);
        this.ctFns.push((c) => (c.includes(`"/${name}"`) ? c : c.replace(/<\/Types>/, `<Override PartName="/${name}" ContentType="${ct}"/></Types>`)));
      },
      freeName: (p) => this.freeName(p),
      link: (url) => {
        const rp = relsOf(part);
        let x = this.get(rp) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
        const ids = [...x.matchAll(/\sId="rId(\d+)"/g)].map((m) => Number(m[1]));
        const id = `rId${Math.max(0, ...ids) + 1}`;
        const el = `<Relationship Id="${id}" Type="${REL_NS}/hyperlink" Target="${escAttr(url)}" TargetMode="External"/>`;
        x = /<\/Relationships>\s*$/.test(x) ? x.replace(/<\/Relationships>\s*$/, `${el}</Relationships>`) : x.replace(/<Relationships\b([^>]*)\/>/, `<Relationships$1>${el}</Relationships>`);
        this.set(rp, x);
        return id;
      },
      dropLinks: () => {
        const rp = relsOf(part);
        const x = this.get(rp);
        if (x) this.set(rp, x.replace(/<Relationship\b[^>]*Type="[^"]*\/hyperlink"[^>]*\/>/g, ""));
      },
    };
  }

  private writeNotes(sh: SheetData, o: SheetData, xml: string): string {
    const part = sh.part!;
    const notes = sh.notes ?? {};
    const rels = this.rels(part);
    const cRel = rels.find((r) => r.type === "comments");
    const ldTag = /<(?:\w+:)?legacyDrawing\b[^>]*>/.exec(xml)?.[0];
    const ldId = ldTag ? attrOf(ldTag, "r:id") ?? attrOf(ldTag, "id") : null;
    const vRel = ldId ? rels.find((r) => r.id === ldId) : rels.find((r) => r.type === "vmlDrawing");
    // a thread's legacy comment (author "tc={id}") is written as Omniweave keeps it; other threaded notes as they were
    const live = Object.entries(notes).filter(([a, n]) => !n.threaded || n.author?.startsWith("tc=") || sameNote(n, o.notes?.[a]));
    // comments part
    let cPath = cRel?.target ?? null;
    let cx = cPath ? this.get(cPath) : null;
    if (!live.length && !Object.values(notes).some((n) => n.threaded)) {
      // every note deleted: the comments part goes; the VML too when only notes were in it
      if (cRel) {
        this.remove(cRel.target);
        this.dropRel(part, cRel.id);
        this.ctFns.push((ct) => ct.replace(new RegExp(`<Override\\b[^>]*PartName="/${cRel.target.replace(/[.]/g, "\\.")}"[^>]*/>`), ""));
      }
      if (vRel) {
        const vx = this.get(vRel.target) ?? "";
        const rest = vx.replace(/<v:shape\b[^>]*>[\s\S]*?<\/v:shape>/g, (m) => (/ObjectType="Note"/.test(m) ? "" : m));
        if (!/<v:shape\b/.test(rest)) {
          this.remove(vRel.target);
          this.dropRel(part, vRel.id);
          xml = placeChild(xml, "legacyDrawing", "");
        } else this.set(vRel.target, rest);
      }
      return xml;
    }
    let px = "";
    if (!cx) {
      cPath = this.freeName((n) => `xl/comments${n}.xml`);
      cx = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors></authors><commentList></commentList></comments>`;
      this.addRel(part, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments", cPath);
      const p = cPath;
      this.ctFns.push((ct) => ct.replace(/<\/Types>/, `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>`));
    } else {
      const r = rootOf(cx);
      px = r.name.includes(":") ? r.name.slice(0, r.name.indexOf(":") + 1) : "";
    }
    // authors
    const authors = [...cx.matchAll(/<(?:\w+:)?author>([^<]*)<\//g)].map((m) => unesc(m[1]));
    const authorOf = (n: SheetNote) => {
      const name = n.author ?? authors[0] ?? "";
      let i = authors.indexOf(name);
      if (i < 0) i = authors.push(name) - 1;
      return i;
    };
    // comments kept as they were (unchanged notes), rewritten (edited) or added
    const kept = new Map<string, string>();
    for (const m of cx.matchAll(/<((?:\w+:)?comment)\b([^>]*?)(\/>|>[\s\S]*?<\/\1>)/g)) {
      const ref = (attrOf(m[2], "ref") ?? "").toUpperCase();
      if (ref) kept.set(ref, m[0]);
    }
    const order = [...kept.keys()].filter((a) => notes[a]);
    for (const a of Object.keys(notes)) if (!kept.has(a)) order.push(a);
    const list = order
      .map((a) => {
        const n = notes[a];
        if (kept.has(a) && ((n.threaded && !n.author?.startsWith("tc=")) || sameNote(n, o.notes?.[a]))) return kept.get(a)!;
        return noteXml(px, a, authorOf(n), n);
      })
      .join("");
    const authorsXml = `<${px}authors>${authors.map((a) => `<${px}author>${escText(a)}</${px}author>`).join("")}</${px}authors>`;
    cx = cx.replace(/<((?:\w+:)?authors)\b[^>]*(\/>|>[\s\S]*?<\/\1>)/, authorsXml).replace(/<((?:\w+:)?commentList)\b[^>]*(\/>|>[\s\S]*?<\/\1>)/, `<${px}commentList>${list}</${px}commentList>`);
    this.set(cPath!, cx);
    // the VML shapes Excel shows notes with
    let vPath = vRel?.target ?? null;
    let vx = vPath ? this.get(vPath) : null;
    if (!vx) {
      vPath = this.freeName((n) => `xl/drawings/vmlDrawing${n}.vml`);
      const n = Number(/(\d+)\.vml$/.exec(vPath)![1]);
      vx = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${n}"/></o:shapelayout>${SHAPETYPE}</xml>`;
      const id = this.addRel(part, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing", vPath);
      if (!new RegExp(`xmlns:r="${REL_NS}"`).test(xml.slice(0, rootOf(xml).openEnd))) throw new SurgeryUnavailable("namespace");
      const r = rootOf(xml);
      const spx = r.name.includes(":") ? r.name.slice(0, r.name.indexOf(":") + 1) : "";
      xml = placeChild(xml, "legacyDrawing", `<${spx}legacyDrawing r:id="${id}"/>`);
      this.ctFns.push((ct) => (/Extension="vml"/i.test(ct) ? ct : ct.replace(/<\/Types>/, `<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/></Types>`)));
    }
    const have = new Set<string>();
    const maxId = Math.max(0, ...[...vx.matchAll(/id="_x0000_s(\d+)"/g)].map((m) => Number(m[1])));
    vx = vx.replace(/<v:shape\b[^>]*>[\s\S]*?<\/v:shape>/g, (m) => {
      if (!/ObjectType="Note"/.test(m)) return m;
      const r = Number(/<x:Row>(\d+)<\/x:Row>/.exec(m)?.[1] ?? -1), c = Number(/<x:Column>(\d+)<\/x:Column>/.exec(m)?.[1] ?? -1);
      const a = addr(r, c);
      if (!notes[a] || have.has(a)) return "";
      have.add(a);
      return m;
    });
    const missing = Object.keys(notes).filter((a) => !have.has(a));
    if (missing.length) {
      if (!vx.includes('id="_x0000_t202"')) vx = vx.replace(/(<o:shapelayout\b[\s\S]*?<\/o:shapelayout>)/, `$1${SHAPETYPE}`);
      if (!vx.includes('id="_x0000_t202"')) throw new SurgeryUnavailable("vml");
      const block = Number(/<o:idmap\b[^>]*data="(\d+)/.exec(vx)?.[1] ?? 1);
      let id = Math.max(block * 1024, maxId) + 1;
      const shapes = missing.map((a) => {
        const p = parseAddr(a)!;
        return noteShape(id++, p.r, p.c);
      });
      vx = vx.replace(/<\/xml>\s*$/, shapes.join("") + "</xml>");
    }
    this.set(vPath!, vx);
    return xml;
  }

  private writeFilter(sh: SheetData, o: SheetData, xml: string): string {
    const r = rootOf(xml);
    const px = r.name.includes(":") ? r.name.slice(0, r.name.indexOf(":") + 1) : "";
    const f = sh.filter;
    if (!f) return placeChild(xml, "autoFilter", "");
    const old = /<((?:\w+:)?autoFilter)\b[^>]*(\/>|>[\s\S]*?<\/\1>)/.exec(xml)?.[0] ?? "";
    const cols = Object.entries(f.cols ?? {})
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => {
        if (v.other) return new RegExp(`<(?:\\w+:)?filterColumn\\b[^>]*colId="${k}"[^>]*(?:/>|>[\\s\\S]*?</(?:\\w+:)?filterColumn>)`).exec(old)?.[0] ?? "";
        return filterColumnXml(px, k, v);
      })
      .join("");
    xml = placeChild(xml, "autoFilter", cols ? `<${px}autoFilter ref="${f.ref}">${cols}</${px}autoFilter>` : `<${px}autoFilter ref="${f.ref}"/>`);
    // the hidden name Excel keeps for the filter range
    const g = parseRange(f.ref)!;
    const q = /^[A-Za-z_][\w.]*$/.test(o.name) ? o.name : `'${o.name.replace(/'/g, "''")}'`;
    const body = escText(`${q}!$${colLetters(g.c0)}$${g.r0 + 1}:$${colLetters(g.c1)}$${g.r1 + 1}`);
    const si = o.index ?? 0;
    this.wbFns.push((wb) => {
      const re = new RegExp(`(<(?:\\w+:)?definedName\\b(?=[^>]*name="_xlnm\\._FilterDatabase")(?=[^>]*localSheetId="${si}")[^>]*>)[^<]*(</)`);
      if (re.test(wb)) return wb.replace(re, `$1${body}$2`);
      const dn = `<definedName name="_xlnm._FilterDatabase" localSheetId="${si}" hidden="1">${body}</definedName>`;
      const close = /<\/((?:\w+:)?)definedNames>/.exec(wb);
      if (close) return wb.slice(0, close.index) + dn.replace(/<(\/?)definedName/g, `<$1${close[1]}definedName`) + wb.slice(close.index);
      const after = /<\/(?:\w+:)?externalReferences>/.exec(wb) ?? /<\/(?:\w+:)?sheets>/.exec(wb);
      if (!after) return wb;
      const wpx = /<\/(\w+:)?sheets>/.exec(wb)?.[1] ?? "";
      const at = after.index + after[0].length;
      return wb.slice(0, at) + `<${wpx}definedNames>${dn.replace(/<(\/?)definedName/g, `<$1${wpx}definedName`)}</${wpx}definedNames>` + wb.slice(at);
    });
    return xml;
  }

  workbook(wb: string): string {
    return this.wbFns.reduce((w, f) => f(w), wb);
  }
  private ctDone = 0;
  /** [Content_Types].xml with the parts added since the last call. */
  contentTypes(ct: string): string {
    const fns = this.ctFns.slice(this.ctDone);
    this.ctDone = this.ctFns.length;
    return fns.reduce((c, f) => f(c), ct);
  }
  /** Parts written / removed, into the save's maps. */
  flush(changed: Map<string, Uint8Array>, gone: Set<string>) {
    for (const [k, v] of this.bins) changed.set(k, v);
    const enc = new TextEncoder();
    for (const [k, v] of this.parts) changed.set(k, enc.encode(v));
    for (const k of this.removed) gone.add(k);
  }
}
