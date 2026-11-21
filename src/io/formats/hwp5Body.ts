// HWP 5.0 same-format save, stage 2: BodyText/SectionN paragraphs written again after a text edit.
//
// The edit comes as the HWPX the Office Surgeon wrote (officesurgeon/hwpx.ts saveHwpxSurgical) over the package the
// HWP import converted the file into (io/formats/hwp5.ts hwp5ToHwpx). That conversion is one to one: each PARA_HEADER
// record (with its children) is one hp:p, in order, and each control character of a paragraph's text other than a
// tab and the one-unit char controls is one element of its runs (hp:secPr, hp:ctrl, hp:tbl, hp:pic …), in order. So
// every hp:p of the edited section maps back onto the original records:
//
//   an hp:p the surgeon copied as it was        → the original paragraph's records, byte for byte
//   an hp:p it rewrote (same start tag)         → PARA_HEADER (character count, control mask, shape ids, breaks),
//                                                 PARA_TEXT, PARA_CHAR_SHAPE and PARA_LINE_SEG made again from its
//                                                 runs; its controls (8 WCHARs each) and their CTRL_HEADER records
//                                                 kept as stored
//   an hp:p holding a table whose cells changed → the paragraph kept, the changed cells' paragraph lists rewritten
//                                                 the same way (LIST_HEADER paragraph count updated)
//   a new hp:p (plain text)                     → new records in the shapes its attributes name
//   an original hp:p no longer there            → its records left out
//
// Character / paragraph shape ids of the HWPX are the DocInfo indices (the conversion numbers them so), and the
// caller only comes here when header.xml is unchanged: every id written exists in DocInfo.
//
// PARA_LINE_SEG (한글's line layout cache) of a rewritten paragraph: see LINE_SEG below.
//
// Source: 한글과컴퓨터 "한글 문서 파일 형식 5.0" (public, rev 1.3) §4.2 (BodyText records: PARA_HEADER, PARA_TEXT,
// PARA_CHAR_SHAPE, PARA_LINE_SEG, PARA_RANGE_TAG, CTRL_HEADER, LIST_HEADER) and §4.2.2 (control characters: char /
// inline / extended, 1 or 8 WCHARs). Facts the document leaves open were read off files 한글 2024 saved
// (qa/interop/hancom-made): bit 31 of the character count marks the last paragraph of its list; the control mask has
// bit n set for each control character n in the text except the paragraph end (13); a paragraph holding only its end
// has no PARA_TEXT record; a tab's 8 WCHARs are [9, width (2), leader | type << 8, 0x20, 0x20, 0x20, 9].
// Written from those documents, no other code.

import { deflateSync, inflateSync } from "fflate";
import { childrenOf, rootOf, type XmlEl } from "../officesurgeon/scan";

const PARA_HEADER = 0x42, PARA_TEXT = 0x43, PARA_CHAR_SHAPE = 0x44, PARA_LINE_SEG = 0x45, PARA_RANGE_TAG = 0x46, CTRL_HEADER = 0x47, LIST_HEADER = 0x48, TABLE = 0x4d;
/** extended controls (a CTRL_HEADER record each) and one-unit char controls (§4.2.2; the same lists as hwp5.ts) */
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
const SINGLE = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
const LAST = 0x80000000;

/**
 * PARA_LINE_SEG of a rewritten paragraph. "none": no record, the header's line count 0 — 한글 has no cached lines and
 * lays the paragraph out when it opens the file. Checked with 한글 2024 (qa/interop/scripts/hwp5_check.ps1 -Edited opens
 * the file and saves it as HWPX again): a paragraph made four lines longer comes back with its new lines (hwp_doc 1 → 8
 * lines, the page count grows 2 → 3), in every repo file. "first" (the old first line kept, text position 0) is what
 * 한글 does not do: it takes the cached line as it is — the same edit came back as 1 line on 2 pages, the text drawn
 * over itself. Old lines are never right for new text, so none are written (the HWPX surgeon drops hp:linesegarray
 * for the same reason).
 */
export const LINE_SEG: { mode: "none" | "first" } = { mode: "none" };

/** The line segments written for a rewritten paragraph (LINE_SEG): none, or (a test of the other choice) its first one. */
function lineSegs(from: HRec | undefined, lv: number): HRec[] {
  const ls = from && kid(from, PARA_LINE_SEG);
  if (LINE_SEG.mode === "none" || !ls || ls.data.length < 36) return [];
  const d = ls.data.slice(0, 36);
  put32(d, 0, 0);
  return [{ tag: PARA_LINE_SEG, level: lv, data: d, kids: [] }];
}

/**
 * Paragraph shapes the surgeon appended to header.xml (hwp5Write.ts addedParaShapes): id → the format it stands for, and
 * the format of each original shape. Only a new paragraph may use one, and it is written with the shape (and style) of
 * the paragraph before it when that has the same format.
 */
export interface ParaShapes {
  added: Map<number, string>;
  keyOf: Map<number, string>;
}
let addedShapes: ParaShapes | undefined;

/** The edit cannot be written into the HWP records (the caller saves as HWPX instead). */
export class Hwp5Unsupported extends Error {}

/** One record: its own bytes as stored (`raw`, header and data) while unchanged, and the records under it. */
export interface HRec {
  tag: number;
  level: number;
  data: Uint8Array;
  raw?: Uint8Array;
  kids: HRec[];
}

const u16 = (d: Uint8Array, o: number) => (o + 1 < d.length ? d[o] | (d[o + 1] << 8) : 0);
const u32 = (d: Uint8Array, o: number) => (o + 3 < d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 0x1000000 : 0);
const put16 = (d: Uint8Array, o: number, v: number) => {
  d[o] = v & 255;
  d[o + 1] = (v >>> 8) & 255;
};
const put32 = (d: Uint8Array, o: number, v: number) => {
  d[o] = v & 255;
  d[o + 1] = (v >>> 8) & 255;
  d[o + 2] = (v >>> 16) & 255;
  d[o + 3] = (v >>> 24) & 255;
};
/** four-character control id ('secd', 'tbl ', …) of a CTRL_HEADER, or of an extended control's 8 WCHARs (from 2) */
const idAt = (d: Uint8Array, o: number) => String.fromCharCode(d[o + 3] ?? 0, d[o + 2] ?? 0, d[o + 1] ?? 0, d[o] ?? 0);

/** Records of a stream as a tree (a record's children follow it one level deeper). */
export function parseRecords(data: Uint8Array): HRec[] {
  const root: HRec[] = [];
  const stack: HRec[] = [];
  for (let o = 0; o + 4 <= data.length; ) {
    const start = o;
    const h = u32(data, o);
    const tag = h & 0x3ff, level = (h >>> 10) & 0x3ff;
    let size = h >>> 20;
    o += 4;
    if (size === 0xfff) {
      size = u32(data, o);
      o += 4;
    }
    if (o + size > data.length) throw new Hwp5Unsupported("record past the stream end");
    const r: HRec = { tag, level, data: data.subarray(o, o + size), raw: data.subarray(start, o + size), kids: [] };
    o += size;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : root).push(r);
    stack.push(r);
  }
  return root;
}

/** The records written out in order (unchanged ones as their stored bytes). */
export function writeRecords(recs: readonly HRec[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const walk = (r: HRec) => {
    if (r.raw) parts.push(r.raw);
    else {
      const big = r.data.length >= 0xfff;
      const h = new Uint8Array(big ? 8 : 4);
      put32(h, 0, (r.tag & 0x3ff) | ((r.level & 0x3ff) << 10) | ((big ? 0xfff : r.data.length) << 20));
      if (big) put32(h, 4, r.data.length);
      parts.push(h, r.data);
    }
    r.kids.forEach(walk);
  };
  recs.forEach(walk);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ───────────────────────── a paragraph's controls ─────────────────────────

interface BinCtrl {
  code: number;
  /** the control's 8 WCHARs as stored */
  units: Uint8Array;
  /** its CTRL_HEADER record (extended controls) */
  rec?: HRec;
}

const kid = (p: HRec, tag: number) => p.kids.find((k) => k.tag === tag);

/** The controls of a paragraph that are elements in the HWPX runs, in text order, and its tabs' 8 WCHARs. */
function binControls(p: HRec): { ctrls: BinCtrl[]; tabs: Uint8Array[] } {
  const text = kid(p, PARA_TEXT)?.data ?? new Uint8Array(0);
  const heads = p.kids.filter((k) => k.tag === CTRL_HEADER);
  const ctrls: BinCtrl[] = [];
  const tabs: Uint8Array[] = [];
  let h = 0;
  for (let i = 0; i < text.length >> 1; ) {
    const c = u16(text, i * 2);
    if (c >= 32 || SINGLE.has(c)) {
      i++;
      continue;
    }
    const units = text.subarray(i * 2, i * 2 + 16);
    if (c === 9) tabs.push(units);
    else if (EXTENDED.has(c)) {
      const rec = heads[h++];
      // the CTRL_HEADER records follow the controls in text order (§4.2.6); a file that has them otherwise is not rewritten
      if (!rec || idAt(rec.data, 0) !== idAt(text, i * 2 + 2)) throw new Hwp5Unsupported("control order");
      ctrls.push({ code: c, units, rec });
    } else ctrls.push({ code: c, units });
    i += 8;
  }
  if (h !== heads.length) throw new Hwp5Unsupported("control records");
  return { ctrls, tabs };
}

// ───────────────────────── HWPX side ─────────────────────────

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const openTag = (s: string, el: XmlEl) => (el.openEnd === el.end ? s.slice(el.start, el.end - 2).trimEnd() + ">" : s.slice(el.start, el.openEnd));
const elText = (s: string, el: XmlEl) => s.slice(el.start, el.end);
const runsOf = (s: string, p: XmlEl) => childrenOf(s, p).filter((c) => c.local === "run");
/** the run children that are controls (everything but hp:t), in order */
const ctrlEls = (s: string, p: XmlEl) => runsOf(s, p).flatMap((r) => childrenOf(s, r).filter((k) => k.local !== "t"));

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e]));

/** The text units of an hp:t: characters, and the char controls / tabs 한글 writes as elements inside it. */
function textUnits(s: string, t: XmlEl, tabs: Uint8Array[], out: number[]): number {
  let mask = 0;
  let at = t.openEnd;
  const pushText = (x: string) => {
    for (let i = 0; i < x.length; i++) {
      const c = x.charCodeAt(i);
      // (QA 2026-11-15) a code under 32 in the text would be read as a control — 13 ends the paragraph, the others take
      // 8 units — so such a character the surgeon left in hp:t is not written as text
      if (c < 32) throw new Hwp5Unsupported(`control character ${c} in the text`);
      out.push(c);
    }
  };
  for (const k of childrenOf(s, t)) {
    pushText(unescape(s.slice(at, k.start)));
    at = k.end;
    const one: Record<string, number> = { lineBreak: 10, hyphen: 24, nbSpace: 30, fwSpace: 31 };
    if (one[k.local] !== undefined) {
      out.push(one[k.local]);
      mask |= 1 << one[k.local];
    } else if (k.local === "tab") {
      // the original's tab (its width, leader and type as 한글 cached them) while there is one, else one from the attributes
      const orig = tabs.shift();
      if (orig) for (let i = 0; i < 8; i++) out.push(u16(orig, i * 2));
      else {
        const tag = openTag(s, k);
        const w = Number(attr(tag, "width")) || 0;
        out.push(9, w & 0xffff, (w >>> 16) & 0xffff, ((Number(attr(tag, "leader")) || 0) & 255) | (((Number(attr(tag, "type")) || 0) & 255) << 8), 0x20, 0x20, 0x20, 9);
      }
      mask |= 1 << 9;
    } else throw new Hwp5Unsupported(`text element ${k.local}`);
  }
  if (t.openEnd !== t.end) pushText(unescape(s.slice(at, t.closeStart)));
  return mask;
}

// ───────────────────────── paragraphs ─────────────────────────

const bytesOf = (units: number[]) => {
  const b = new Uint8Array(units.length * 2);
  units.forEach((u, i) => put16(b, i * 2, u));
  return b;
};

/**
 * Records of a paragraph written from its hp:p. `base`: the original paragraph it replaces (its controls, header fields
 * and record order are kept), or null for a new one (`tpl` lends the header layout and level).
 */
function paraFrom(s: string, el: XmlEl, base: { rec: HRec; xml: string; el: XmlEl } | null, tpl: HRec): HRec {
  // the original's controls and their HWPX elements, one to one
  const bin = base ? binControls(base.rec) : { ctrls: [], tabs: [] };
  const origEls = base ? ctrlEls(base.xml, base.el).map((k) => elText(base.xml, k)) : [];
  if (origEls.length !== bin.ctrls.length) throw new Hwp5Unsupported("controls");
  const units: number[] = [];
  const shapes: [number, number][] = [];
  const recs: HRec[] = [];
  let mask = 0;
  let next = 0; // controls are kept in their order: each one is found after the one before
  let firstCp = -1;
  const shapeAt = (cp: number) => {
    if (!shapes.length || shapes[shapes.length - 1][1] !== cp) {
      if (shapes.length && shapes[shapes.length - 1][0] === units.length) shapes[shapes.length - 1][1] = cp;
      else shapes.push([units.length, cp]);
    }
  };
  for (const c of childrenOf(s, el)) {
    if (c.local === "linesegarray") continue; // 한글 lays the paragraph out again (LINE_SEG)
    if (c.local !== "run") throw new Hwp5Unsupported(`paragraph element ${c.local}`);
    const cp = Number(attr(openTag(s, c), "charPrIDRef"));
    if (!Number.isInteger(cp) || cp < 0) throw new Hwp5Unsupported("charPrIDRef");
    if (firstCp < 0) firstCp = cp;
    for (const k of childrenOf(s, c)) {
      if (k.local === "t") {
        const t: number[] = [];
        mask |= textUnits(s, k, bin.tabs, t);
        if (!t.length) continue;
        shapeAt(cp);
        units.push(...t);
        continue;
      }
      const x = elText(s, k);
      let j = next;
      while (j < origEls.length && origEls[j] !== x) j++;
      if (j >= origEls.length) throw new Hwp5Unsupported(`control ${k.local}`);
      next = j + 1;
      const bc = bin.ctrls[j];
      shapeAt(cp);
      for (let i = 0; i < 8; i++) units.push(u16(bc.units, i * 2));
      mask |= 1 << bc.code;
      if (bc.rec) recs.push(bc.rec);
    }
  }
  const b = base?.rec;
  // a range tag (§4.2.5) marks text positions: the text changed, so its ranges would point at other text
  if (b && kid(b, PARA_RANGE_TAG) && !sameUnits(kid(b, PARA_TEXT)?.data, units)) throw new Hwp5Unsupported("range tag");
  if (!shapes.length) shapes.push([0, firstCp >= 0 ? firstCp : b ? u32(kid(b, PARA_CHAR_SHAPE)?.data ?? new Uint8Array(8), 4) : 0]);
  const hasText = units.length > 0;
  units.push(13);

  // header: the original's (or the template's) with the counts, mask, shapes and breaks of this paragraph
  const open = openTag(s, el);
  const src = (b ?? tpl).data;
  const hd = new Uint8Array(Math.max(22, src.length));
  hd.set(src.subarray(0, hd.length));
  let pp = Number(attr(open, "paraPrIDRef")), st = Number(attr(open, "styleIDRef"));
  if (!Number.isInteger(pp) || !Number.isInteger(st) || pp < 0 || st < 0 || st > 255) throw new Hwp5Unsupported("shape ids");
  const ps = addedShapes;
  if (ps?.added.has(pp)) {
    // a shape the surgeon added: a new paragraph in the format of the one before it takes that one's shape and style
    const tp = u16(tpl.data, 8);
    if (b || ps.keyOf.get(tp) !== ps.added.get(pp)) throw new Hwp5Unsupported("paragraph shape");
    pp = tp;
    st = tpl.data[10];
  }
  put32(hd, 0, (hasText ? units.length : 1) >>> 0);
  put32(hd, 4, mask >>> 0);
  put16(hd, 8, pp);
  hd[10] = st;
  // column / page break (4 = 쪽, 8 = 단); a new paragraph takes no section / multi-column start of its template
  hd[11] = ((b ? hd[11] & ~0x0c : 0) | (attr(open, "pageBreak") === "1" ? 4 : 0) | (attr(open, "columnBreak") === "1" ? 8 : 0)) & 255;
  put16(hd, 12, shapes.length);
  put16(hd, 14, 0);
  put16(hd, 16, 0); // no line segments (LINE_SEG)
  if (!b) {
    put32(hd, 18, 0); // instance id
    if (hd.length >= 24) put16(hd, 22, 0); // change-tracking merge
  } else if (kid(b, PARA_RANGE_TAG)) put16(hd, 14, kid(b, PARA_RANGE_TAG)!.data.length / 12);
  const lv = (b ?? tpl).level + 1;
  const kids: HRec[] = [];
  if (hasText) kids.push({ tag: PARA_TEXT, level: lv, data: bytesOf(units), kids: [] });
  const cs = new Uint8Array(shapes.length * 8);
  shapes.forEach(([pos, id], i) => {
    put32(cs, i * 8, pos);
    put32(cs, i * 8 + 4, id);
  });
  kids.push({ tag: PARA_CHAR_SHAPE, level: lv, data: cs, kids: [] });
  const segs = lineSegs(b ?? tpl, lv);
  put16(hd, 16, segs.length);
  kids.push(...segs);
  if (b && kid(b, PARA_RANGE_TAG)) kids.push(kid(b, PARA_RANGE_TAG)!);
  kids.push(...recs);
  // records of the original this program does not know stay with the paragraph
  if (b) kids.push(...b.kids.filter((k) => ![PARA_TEXT, PARA_CHAR_SHAPE, PARA_LINE_SEG, PARA_RANGE_TAG, CTRL_HEADER].includes(k.tag)));
  return { tag: PARA_HEADER, level: (b ?? tpl).level, data: hd, kids };
}

function sameUnits(d: Uint8Array | undefined, units: number[]): boolean {
  if (!d) return units.length === 0;
  if (d.length !== (units.length + 1) * 2) return false;
  return units.every((u, i) => u16(d, i * 2) === u);
}

/** A paragraph holding tables whose cells changed (its own text as it was): the changed cells' lists rewritten. */
function tablePara(s: string, el: XmlEl, base: { rec: HRec; xml: string; el: XmlEl }): HRec {
  const bin = binControls(base.rec);
  const oc = ctrlEls(base.xml, base.el);
  const nc = ctrlEls(s, el);
  if (oc.length !== bin.ctrls.length || oc.length !== nc.length) throw new Hwp5Unsupported("table controls");
  // everything but the tables (and the line layout the surgeon drops) as it was
  const strip = (x: string, p: XmlEl, tbls: XmlEl[]) => {
    let out = "", at = p.start;
    for (const t of tbls) {
      out += x.slice(at, t.start) + "\u0000";
      at = t.end;
    }
    out += x.slice(at, p.end);
    // the paragraph's own line layout: its last child (the cells' paragraphs have theirs inside the table)
    const ls = out.lastIndexOf("<hp:linesegarray>");
    return ls >= 0 && out.endsWith("</hp:linesegarray></hp:p>") && out.indexOf("</hp:p>", ls) === out.length - 7 ? out.slice(0, ls) + "</hp:p>" : out;
  };
  if (strip(base.xml, base.el, oc.filter((k) => k.local === "tbl")) !== strip(s, el, nc.filter((k) => k.local === "tbl"))) throw new Hwp5Unsupported("table paragraph");
  const swap = new Map<HRec, HRec>();
  nc.forEach((k, i) => {
    if (k.local !== "tbl" || elText(s, k) === elText(base.xml, oc[i])) return;
    const rec = bin.ctrls[i].rec;
    if (!rec || idAt(rec.data, 0) !== "tbl ") throw new Hwp5Unsupported("table record");
    swap.set(rec, tableRec(base.xml, oc[i], s, k, rec));
  });
  const segs = lineSegs(base.rec, base.rec.level + 1);
  const kids = base.rec.kids.flatMap((k) => (k.tag === PARA_LINE_SEG ? segs.splice(0) : [swap.get(k) ?? k]));
  const hd = base.rec.data.slice();
  put16(hd, 16, kids.filter((k) => k.tag === PARA_LINE_SEG).length); // the table's height may have changed: laid out again (LINE_SEG)
  return { ...base.rec, data: hd, raw: undefined, kids };
}

/** The table's CTRL_HEADER tree with the paragraph lists of its changed cells written again. */
function tableRec(ox: string, ot: XmlEl, nx: string, nt: XmlEl, rec: HRec): HRec {
  const cells = (x: string, t: XmlEl) => {
    const m = new Map<string, XmlEl>();
    for (const tr of childrenOf(x, t).filter((c) => c.local === "tr"))
      for (const tc of childrenOf(x, tr).filter((c) => c.local === "tc")) {
        const a = childrenOf(x, tc).find((c) => c.local === "cellAddr");
        const tag = a ? openTag(x, a) : "";
        m.set(`${attr(tag, "rowAddr")}:${attr(tag, "colAddr")}`, tc);
      }
    return m;
  };
  const oc = cells(ox, ot), nc = cells(nx, nt);
  if (oc.size !== nc.size || [...nc.keys()].some((k) => !oc.has(k))) throw new Hwp5Unsupported("table grid");
  // the cells' lists: a LIST_HEADER and the paragraphs after it (siblings under the CTRL_HEADER, after TABLE)
  const ti = rec.kids.findIndex((k) => k.tag === TABLE);
  if (ti < 0) throw new Hwp5Unsupported("table");
  const lists = new Map<string, { at: number; n: number }>();
  for (let i = ti + 1; i < rec.kids.length; i++) {
    const h = rec.kids[i];
    if (h.tag !== LIST_HEADER) continue;
    let n = 0;
    while (rec.kids[i + 1 + n]?.tag === PARA_HEADER) n++;
    lists.set(`${u16(h.data, 10)}:${u16(h.data, 8)}`, { at: i, n });
  }
  const repl = new Map<number, HRec[]>(); // LIST_HEADER index → [LIST_HEADER, …paragraphs]
  for (const [key, ntc] of nc) {
    const otc = oc.get(key)!;
    if (elText(nx, ntc) === elText(ox, otc)) continue;
    const l = lists.get(key);
    const os = childrenOf(ox, otc).find((c) => c.local === "subList"), ns = childrenOf(nx, ntc).find((c) => c.local === "subList");
    if (!l || !os || !ns) throw new Hwp5Unsupported("cell");
    // only the cell's paragraphs changed (its subList start tag, address, size, margins as they were)
    if (ox.slice(otc.start, os.openEnd) !== nx.slice(ntc.start, ns.openEnd) || ox.slice(os.closeStart, otc.end) !== nx.slice(ns.closeStart, ntc.end)) throw new Hwp5Unsupported("cell settings");
    const ops = childrenOf(ox, os).filter((c) => c.local === "p"), nps = childrenOf(nx, ns).filter((c) => c.local === "p");
    const paras = rewriteList(ox, ops, nx, nps, rec.kids.slice(l.at + 1, l.at + 1 + l.n));
    if (!paras.length) throw new Hwp5Unsupported("empty cell");
    const lh = rec.kids[l.at].data.slice();
    put16(lh, 0, paras.length);
    repl.set(l.at, [{ ...rec.kids[l.at], data: lh, raw: undefined }, ...paras]);
  }
  const count = new Map([...lists.values()].map((v) => [v.at, v.n]));
  const kids: HRec[] = [];
  for (let i = 0; i < rec.kids.length; i++) {
    const r = repl.get(i);
    if (!r) {
      kids.push(rec.kids[i]);
      continue;
    }
    kids.push(...r);
    i += count.get(i)!; // the list's old paragraphs
  }
  return { ...rec, kids };
}

/**
 * The records of a paragraph list (a section's paragraphs, a cell's) for the edited hp:p elements `nps`, against the
 * original elements `ops` and their PARA_HEADER trees `recs` (one to one). Bit 31 of the character count marks the
 * last paragraph.
 */
export function rewriteList(ox: string, ops: XmlEl[], nx: string, nps: XmlEl[], recs: HRec[]): HRec[] {
  if (ops.length !== recs.length || recs.some((r) => r.tag !== PARA_HEADER)) throw new Hwp5Unsupported("paragraph map");
  const otext = ops.map((e) => elText(ox, e));
  const otag = ops.map((e) => openTag(ox, e));
  // originals some edited element copies exactly: a rewritten paragraph is not matched to one of these
  const copied = new Set<number>();
  for (const e of nps) {
    const i = otext.indexOf(elText(nx, e));
    if (i >= 0) copied.add(i);
  }
  const out: HRec[] = [];
  let ptr = 0;
  for (const e of nps) {
    const x = elText(nx, e);
    let j = otext.indexOf(x, ptr);
    if (j >= 0) {
      out.push(recs[j]);
      ptr = j + 1;
      continue;
    }
    const tag = openTag(nx, e);
    const cands = otag.map((t, k) => (k >= ptr && t === tag ? k : -1)).filter((k) => k >= 0);
    j = cands.find((k) => !copied.has(k)) ?? cands[0] ?? -1;
    const hasTbl = runsOf(nx, e).some((r) => childrenOf(nx, r).some((k) => k.local === "tbl"));
    if (j >= 0) {
      const base = { rec: recs[j], xml: ox, el: ops[j] };
      out.push(hasTbl ? tablePara(nx, e, base) : paraFrom(nx, e, base, recs[j]));
      ptr = j + 1;
      continue;
    }
    if (hasTbl) throw new Hwp5Unsupported("new table");
    out.push(paraFrom(nx, e, null, out[out.length - 1] ?? recs[Math.min(ptr, recs.length - 1)]));
  }
  // the last paragraph of the list carries bit 31 of its character count, no other one
  out.forEach((r, i) => {
    const want = i === out.length - 1;
    if (u32(r.data, 0) >= LAST === want) return;
    const d = r.data.slice();
    put32(d, 0, ((u32(d, 0) & 0x7fffffff) + (want ? LAST : 0)) >>> 0);
    out[i] = { ...r, data: d, raw: undefined };
  });
  return out;
}

// ───────────────────────── sections ─────────────────────────

/** Top-level hp:p elements of a section part. */
function sectionParas(xml: string): XmlEl[] {
  return childrenOf(xml, rootOf(xml)).filter((c) => c.local === "p");
}

/**
 * A BodyText/SectionN stream (as stored: compressed when `compressed`) written again for the edited section XML `nx`
 * of the converted section `ox` (`added`: paragraph shapes the surgeon appended). Throws Hwp5Unsupported when the edit
 * does not map onto the records.
 */
export function rewriteSection(stored: Uint8Array, compressed: boolean, ox: string, nx: string, added?: ParaShapes): Uint8Array {
  const raw = compressed ? inflateSync(stored) : stored;
  const recs = parseRecords(raw);
  addedShapes = added;
  let out: HRec[];
  try {
    out = rewriteList(ox, sectionParas(ox), nx, sectionParas(nx), recs);
  } finally {
    addedShapes = undefined;
  }
  if (!out.length) throw new Hwp5Unsupported("empty section");
  const bytes = writeRecords(out);
  return compressed ? deflateSync(bytes, { level: 6 }) : bytes;
}

// ───────────────────────── direct rewrite (stage 3) ─────────────────────────
//
// Paragraphs the HWPX surgeon cannot write — text beside a picture, a footnote, a field, a bookmark (its rewritePara
// moves such controls to the paragraph start), and the cells of a table with merged cells — are written straight from
// the model: the paragraph's text as 한글 stored it, split into tokens (a character, a char control, a tab, an 8-unit
// control with its CTRL_HEADER), is matched one to one to the characters of the paragraph as the import read it
// (TextParagraph runs; the controls the import shows no text for are "silent" tokens, a footnote reference is one
// token for its mark). The edit is the span between the common start and end of the old and new characters: only
// that span is written anew; every control, its 8 WCHARs and its CTRL_HEADER tree stay byte for byte where they were.
// A control inside a replaced span, a format change of the paragraph, a range tag, a character format no character of
// the paragraph (or of the document) has: Hwp5Unsupported (save as HWPX).

/** A token of a paragraph's text: its units as stored, the character the model shows for it, its character shape. */
interface Tok {
  units: number[];
  /** the character the import shows (9 tab, 10 line break), NOTE for a footnote / endnote reference, null when silent */
  vis: number | null;
  cs: number;
}
const NOTE = -1;

/** The model's view of a paragraph: one token per UTF-16 unit of its runs' text, one per note reference. */
export interface ModelTok {
  code: number;
  /** the character format (and review marks) of its run — officesurgeon/common.ts runKey */
  key: string;
}

/** The text tokens of a paragraph record (paragraph end left out). `notes`: footnote / endnote references show their mark. */
function recTokens(p: HRec, notes: boolean): Tok[] {
  const text = kid(p, PARA_TEXT)?.data ?? new Uint8Array(0);
  const csd = kid(p, PARA_CHAR_SHAPE)?.data ?? new Uint8Array(0);
  const pairs: [number, number][] = [];
  for (let o = 0; o + 8 <= csd.length; o += 8) pairs.push([u32(csd, o), u32(csd, o + 4)]);
  if (!pairs.length) pairs.push([0, 0]);
  const heads = p.kids.filter((k) => k.tag === CTRL_HEADER);
  const out: Tok[] = [];
  let h = 0, ci = 0;
  const n = text.length >> 1;
  for (let i = 0; i < n; ) {
    while (ci + 1 < pairs.length && pairs[ci + 1][0] <= i) ci++;
    const cs = pairs[ci][1];
    const c = u16(text, i * 2);
    if (c === 13) break; // the paragraph end
    if (c >= 32) {
      out.push({ units: [c], vis: c === 0xfffe || c === 0xffff ? null : c, cs });
      i++;
      continue;
    }
    if (SINGLE.has(c)) {
      out.push({ units: [c], vis: c === 10 ? 10 : null, cs });
      i++;
      continue;
    }
    if (i + 8 > n) throw new Hwp5Unsupported("control past the text end");
    const units = Array.from({ length: 8 }, (_, k) => u16(text, (i + k) * 2));
    let vis: number | null = c === 9 ? 9 : null;
    if (EXTENDED.has(c)) {
      const rec = heads[h++];
      const id = idAt(text, i * 2 + 2);
      if (!rec || idAt(rec.data, 0) !== id) throw new Hwp5Unsupported("control order");
      if (notes && (id === "fn  " || id === "en  ")) vis = NOTE;
    }
    out.push({ units, vis, cs });
    i += 8;
  }
  if (h !== heads.length) throw new Hwp5Unsupported("control records");
  return out;
}

/**
 * The records of a paragraph for the token list `toks` (as `rec` with its text, character shapes and counts made
 * again; its controls' records, range tags and records this program does not know as they were, in their order).
 */
function paraRecord(rec: HRec, toks: Tok[]): HRec {
  const units = toks.flatMap((t) => t.units);
  let mask = 0;
  for (const t of toks) if (t.units[0] < 32) mask |= 1 << t.units[0];
  units.push(13);
  const pairs: [number, number][] = [];
  let pos = 0;
  for (const t of toks) {
    if (!pairs.length || pairs[pairs.length - 1][1] !== t.cs) pairs.push([pos, t.cs]);
    pos += t.units.length;
  }
  if (!pairs.length) pairs.push([0, u32(kid(rec, PARA_CHAR_SHAPE)?.data ?? new Uint8Array(8), 4)]);
  const hd = new Uint8Array(Math.max(22, rec.data.length));
  hd.set(rec.data.subarray(0, hd.length));
  put32(hd, 0, ((toks.length ? units.length : 1) + (u32(rec.data, 0) >= LAST ? LAST : 0)) >>> 0);
  put32(hd, 4, mask >>> 0);
  put16(hd, 12, pairs.length);
  const lv = rec.level + 1;
  const cs = new Uint8Array(pairs.length * 8);
  pairs.forEach(([p, id], i) => {
    put32(cs, i * 8, p);
    put32(cs, i * 8 + 4, id);
  });
  const segs = lineSegs(rec, lv);
  put16(hd, 16, segs.length);
  const kids: HRec[] = [];
  let placed = false;
  const place = () => {
    if (placed) return;
    placed = true;
    if (toks.length) kids.push({ tag: PARA_TEXT, level: lv, data: bytesOf(units), kids: [] });
    kids.push({ tag: PARA_CHAR_SHAPE, level: lv, data: cs, kids: [] }, ...segs);
  };
  for (const k of rec.kids) {
    if (k.tag === PARA_TEXT || k.tag === PARA_CHAR_SHAPE || k.tag === PARA_LINE_SEG) place();
    else kids.push(k);
  }
  place();
  return { tag: rec.tag, level: rec.level, data: hd, kids };
}

/** Character format → character shape id of the characters of `rec` (matched to `model`); null when they do not match. */
export function shapesOf(rec: HRec, model: readonly ModelTok[], notes: boolean, into = new Map<string, number>()): Map<string, number> | null {
  let rt: Tok[];
  try {
    rt = recTokens(rec, notes);
  } catch {
    return null;
  }
  const vis = rt.filter((t) => t.vis !== null);
  if (vis.length !== model.length || vis.some((t, k) => t.vis !== model[k].code)) return null;
  vis.forEach((t, k) => into.has(model[k].key) || into.set(model[k].key, t.cs));
  return into;
}

/**
 * A paragraph record with the text edit from `old` (the model's characters of the paragraph as opened) to `now` written
 * into it (see above). `doc`: character format → shape id over the document, for a format this paragraph has no
 * character in. Returns `rec` itself when the characters are the same.
 */
export function directPara(rec: HRec, old: readonly ModelTok[], now: readonly ModelTok[], notes: boolean, doc?: () => Map<string, number>): HRec {
  const rt = recTokens(rec, notes);
  const vis: number[] = [];
  rt.forEach((t, i) => t.vis !== null && vis.push(i));
  if (vis.length !== old.length || vis.some((ri, k) => rt[ri].vis !== old[k].code)) throw new Hwp5Unsupported("text map");
  const same = (a: ModelTok, b: ModelTok) => a.code === b.code && a.key === b.key;
  let P = 0;
  while (P < old.length && P < now.length && same(old[P], now[P])) P++;
  let S = 0;
  while (S < old.length - P && S < now.length - P && same(old[old.length - 1 - S], now[now.length - 1 - S])) S++;
  if (P === old.length && P === now.length) return rec;
  // (QA 2026-11-16) no characters of its own beside a drawing object / table holding paragraphs (a caption, a text box):
  // the model's paragraph may be the object's (office.ts visitP gives a block of a picture or box alone the object's
  // paragraphs only), and its text would land in the body beside the object
  if (!vis.length && rec.kids.some((k) => k.tag === CTRL_HEADER && ["gso ", "tbl "].includes(idAt(k.data, 0)) && holdsList(k))) throw new Hwp5Unsupported("object text");
  const oMid = old.slice(P, old.length - S), nMid = now.slice(P, now.length - S);
  if (oMid.some((t) => t.code === NOTE) || nMid.some((t) => t.code === NOTE)) throw new Hwp5Unsupported("note reference");
  // a range tag (§4.2.5) marks text positions: the text changed, so its ranges would point at other text
  if (kid(rec, PARA_RANGE_TAG)) throw new Hwp5Unsupported("range tag");
  // where the new characters go: in place of the old ones (no control among them), or — an insertion — right after the
  // character before (the controls after it stay after the new text), at the paragraph start after its leading controls
  let start: number, end: number;
  if (oMid.length) {
    start = vis[P];
    end = vis[old.length - S - 1] + 1;
    if (rt.slice(start, end).some((t) => t.vis === null)) throw new Hwp5Unsupported("control in the changed text");
  } else start = end = P > 0 ? vis[P - 1] + 1 : vis.length ? vis[0] : rt.length;
  // character shapes of the new characters: a neighbour's in the same format, else any of the paragraph's, else the document's
  const local = new Map<string, number>();
  vis.forEach((ri, k) => local.has(old[k].key) || local.set(old[k].key, rt[ri].cs));
  const pick = (key: string): number => {
    for (const k of [P - 1, old.length - S]) if (k >= 0 && k < old.length && old[k].key === key) return rt[vis[k]].cs;
    const id = local.get(key) ?? doc?.().get(key);
    if (id === undefined) throw new Hwp5Unsupported("character shape");
    return id;
  };
  const tabs = rt.slice(start, end).filter((t) => t.vis === 9).map((t) => t.units);
  const anyTab = rt.find((t) => t.vis === 9)?.units;
  const mid: Tok[] = nMid.map((t) => {
    const cs = pick(t.key);
    if (t.code === 9) return { units: tabs.shift() ?? anyTab ?? [9, 4000, 0, 1 << 8, 0x20, 0x20, 0x20, 9], vis: 9, cs };
    // (QA 2026-11-15) a code under 32 other than a tab or a line break would be read as a control
    if (t.code < 32 && t.code !== 10) throw new Hwp5Unsupported(`control character ${t.code} in the text`);
    return { units: [t.code], vis: t.code, cs };
  });
  return paraRecord(rec, [...rt.slice(0, start), ...mid, ...rt.slice(end)]);
}

const holdsList = (r: HRec): boolean => r.kids.some((k) => k.tag === LIST_HEADER || holdsList(k));

/** A new paragraph after `tpl` (its shapes, its level) holding the characters `now` only. */
function freshDirect(tpl: HRec, tplModel: readonly ModelTok[], now: readonly ModelTok[], doc?: () => Map<string, number>): HRec {
  const local = shapesOf(tpl, tplModel, false) ?? new Map<string, number>();
  const toks: Tok[] = now.map((t) => {
    const cs = local.get(t.key) ?? doc?.().get(t.key);
    if (cs === undefined) throw new Hwp5Unsupported("character shape");
    if (t.code === NOTE || (t.code < 32 && t.code !== 9 && t.code !== 10)) throw new Hwp5Unsupported(`control character ${t.code} in the text`);
    return { units: t.code === 9 ? [9, 4000, 0, 1 << 8, 0x20, 0x20, 0x20, 9] : [t.code], vis: t.code, cs };
  });
  const hd = tpl.data.slice();
  hd[11] = 0; // no section / column start, no page / column break of its own
  if (hd.length >= 22) put32(hd, 18, 0); // instance id
  if (hd.length >= 24) put16(hd, 22, 0);
  return paraRecord({ tag: PARA_HEADER, level: tpl.level, data: hd, kids: tpl.kids.filter((k) => k.tag === PARA_CHAR_SHAPE) }, toks);
}

/** One changed cell of a table: its address and its paragraphs as opened / now (model characters). */
export interface DirectCell {
  row: number;
  col: number;
  old: ModelTok[][];
  now: ModelTok[][];
}

/**
 * A table's CTRL_HEADER tree with the changed cells' paragraph lists written again (directPara; merged cells too — a
 * cell is found by its own address in its LIST_HEADER). The cell's other records as stored.
 */
export function directTable(rec: HRec, cells: readonly DirectCell[], doc?: () => Map<string, number>): HRec {
  const ti = rec.kids.findIndex((k) => k.tag === TABLE);
  if (ti < 0) throw new Hwp5Unsupported("table");
  const lists = new Map<string, { at: number; n: number }>();
  for (let i = ti + 1; i < rec.kids.length; i++) {
    const h = rec.kids[i];
    if (h.tag !== LIST_HEADER) continue;
    let n = 0;
    while (rec.kids[i + 1 + n]?.tag === PARA_HEADER) n++;
    const key = `${u16(h.data, 10)}:${u16(h.data, 8)}`;
    if (lists.has(key)) throw new Hwp5Unsupported("table grid");
    lists.set(key, { at: i, n });
  }
  const repl = new Map<number, HRec[]>();
  for (const c of cells) {
    const l = lists.get(`${c.row}:${c.col}`);
    if (!l) throw new Hwp5Unsupported("cell");
    const recs = rec.kids.slice(l.at + 1, l.at + 1 + l.n);
    if (recs.length !== c.old.length || !c.now.length) throw new Hwp5Unsupported("cell paragraphs");
    const paras: HRec[] = [];
    c.now.forEach((now, k) => {
      if (k < recs.length) paras.push(directPara(recs[k], c.old[k], now, false, doc));
      else paras.push(freshDirect(recs[recs.length - 1], c.old[recs.length - 1], now, doc));
    });
    // paragraphs deleted from the cell: only plain ones (a control in one would go with it)
    for (const r of recs.slice(c.now.length)) if (r.kids.some((k) => k.tag === CTRL_HEADER)) throw new Hwp5Unsupported("cell control");
    // the last paragraph of the cell carries bit 31 of its character count, no other one
    paras.forEach((r, i) => {
      const want = i === paras.length - 1;
      if (u32(r.data, 0) >= LAST === want) return;
      const d = r.data.slice();
      put32(d, 0, ((u32(d, 0) & 0x7fffffff) + (want ? LAST : 0)) >>> 0);
      paras[i] = { ...r, data: d, raw: undefined };
    });
    const lh = rec.kids[l.at];
    const head = paras.length === l.n ? lh : { ...lh, data: lh.data.slice(), raw: undefined };
    if (head !== lh) put16(head.data, 0, paras.length);
    repl.set(l.at, [head, ...paras]);
  }
  const kids: HRec[] = [];
  for (let i = 0; i < rec.kids.length; i++) {
    const r = repl.get(i);
    if (!r) {
      kids.push(rec.kids[i]);
      continue;
    }
    kids.push(...r);
    i += [...lists.values()].find((v) => v.at === i)!.n;
  }
  return { ...rec, raw: undefined, kids };
}

/** The paragraph holding tables with the n-th 'tbl ' control's tree replaced (`tables`: n → tree), laid out again. */
export function withTables(rec: HRec, tables: ReadonlyMap<number, HRec>): HRec {
  let n = 0;
  const segs = lineSegs(rec, rec.level + 1);
  const kids = rec.kids.flatMap((k) => {
    if (k.tag === PARA_LINE_SEG) return segs.splice(0);
    if (k.tag !== CTRL_HEADER || idAt(k.data, 0) !== "tbl ") return [k];
    return [tables.get(n++) ?? k];
  });
  for (const k of tables.keys()) if (k >= n) throw new Hwp5Unsupported("tables");
  const hd = rec.data.slice();
  put16(hd, 16, kids.filter((k) => k.tag === PARA_LINE_SEG).length); // the table's height may have changed (LINE_SEG)
  return { ...rec, data: hd, raw: undefined, kids };
}

/** The 'tbl ' controls of a paragraph record, in text order. */
export const tablesOf = (rec: HRec) => rec.kids.filter((k) => k.tag === CTRL_HEADER && idAt(k.data, 0) === "tbl ");

/** A section stream's records (inflated when `compressed`) and the stream written back from records. */
export const sectionRecords = (stored: Uint8Array, compressed: boolean) => parseRecords(compressed ? inflateSync(stored) : stored);
export const sectionStream = (recs: readonly HRec[], compressed: boolean) => {
  const bytes = writeRecords(recs);
  return compressed ? deflateSync(bytes, { level: 6 }) : bytes;
};

// ───────────────────────── PrvText ─────────────────────────

/** Most UTF-16 units 한글 keeps in PrvText (a 1024-unit buffer with its NUL). */
const PRV_MAX = 1023;

/**
 * The preview text (PrvText) of the body, written the way 한글 writes it (QA doc-summary: the same text, unit for unit,
 * as every PrvText 한글 2024 wrote in qa/interop): each paragraph's text and a CR LF; a tab as a space; a table as one
 * line per row, each cell's text in < > (a cell's paragraphs and line breaks as spaces), the last row ended by the CR LF
 * of the paragraph holding the table. Only body paragraphs and table cells (not notes, headers, text boxes). At most
 * 1023 units: a paragraph's text (or a mark) that does not fit is cut one unit short of the end, as 한글 cuts it
 * (files that stop inside a paragraph hold 1022 units, a cell that fits exactly 1023). A cell is still closed (QA
 * prvtext-cell, 한글 2024): its text is cut to what fits before its '>' and the '>' written, so the text ends at 1023
 * units ('…<14><>' where '부서 14' no longer fit); a '<' with no room for its '>' after it is not written.
 */
export function previewText(sections: readonly Uint8Array[]): string {
  let s = "";
  let full = false;
  let depth = 0; // cells open: the room their '>' need kept at the end
  const add = (piece: string) => {
    if (full || !piece) return;
    const cap = PRV_MAX - depth;
    if (s.length + piece.length <= cap) s += piece;
    else (s += piece.slice(0, Math.max(0, depth ? cap - s.length : cap - s.length - 1))), (full = true);
  };
  const para = (p: HRec, inCell: boolean) => {
    const text = kid(p, PARA_TEXT)?.data ?? new Uint8Array(0);
    const heads = p.kids.filter((k) => k.tag === CTRL_HEADER);
    const nl = inCell ? " " : "\r\n";
    let h = 0;
    let run = "";
    const flush = () => (add(run), (run = ""));
    for (let i = 0; i < text.length >> 1 && !full; ) {
      const c = u16(text, i * 2);
      if (c >= 32) {
        run += String.fromCharCode(c);
        i++;
        continue;
      }
      if (SINGLE.has(c)) {
        if (c === 10) flush(), add(nl);
        else if (c === 30 || c === 31) run += " ";
        i++;
        continue;
      }
      if (c === 9) run += " ";
      else if (EXTENDED.has(c)) {
        const r = heads[h++];
        if (r && idAt(r.data, 0) === "tbl ") flush(), table(r);
      }
      i += 8;
    }
    flush();
  };
  const table = (r: HRec) => {
    const ti = r.kids.findIndex((k) => k.tag === TABLE);
    let row = -1;
    for (let i = ti + 1; i < r.kids.length && !full; i++) {
      const lh = r.kids[i];
      if (lh.tag !== LIST_HEADER) continue;
      const rr = u16(lh.data, 10);
      if (row >= 0 && rr !== row) add("\r\n");
      row = rr;
      if (full) break;
      if (s.length + 1 > PRV_MAX - depth - 1) {
        full = true;
        break;
      }
      s += "<";
      depth++;
      // the cell's paragraphs on one line
      for (let k = i + 1; r.kids[k]?.tag === PARA_HEADER && !full; k++) {
        if (k > i + 1) add(" ");
        para(r.kids[k], true);
      }
      depth--;
      s += ">";
    }
  };
  for (const sec of sections)
    for (const p of parseRecords(sec)) {
      if (full) break;
      para(p, false);
      add("\r\n");
    }
  return s;
}

/** PrvText bytes (UTF-16LE, no terminator) of a preview text. */
export function previewBytes(text: string): Uint8Array {
  const b = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) put16(b, i * 2, text.charCodeAt(i));
  return b;
}
