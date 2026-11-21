// PPT (PowerPoint 97-2003) same-format save, stage 2: a presentation opened from a .ppt whose slide text or speaker
// notes alone were edited (legacyWrite.ts pptTextOnly — the fingerprint without the text is the one taken at open):
// letters typed or deleted, paragraphs split (Enter) or joined, added or removed inside a text box. The text is written
// into the PowerPoint Document stream; every other stream (Pictures …) stays byte for byte, and so does the Current
// User stream but its offsetToCurrentEdit, and the summaries but a changed slide title (the presentation title and the
// slide titles list) and the first slide's picture when its text changed (QA ppt-write2: the old title stayed there —
// oleSummary.ts). Loaded only when such a presentation is saved as PPT.
//
//   how        the stream is laid out again in place (not saved incrementally): the edited text atoms are made again
//              where they are, the containers around them get their new lengths, and every stream offset — the
//              entries of each PersistDirectoryAtom, each UserEditAtom's offsetLastEdit and offsetPersistDirectory, the
//              Current User's offsetToCurrentEdit — moves with the records after them. Why not an incremental save (new
//              slide records, a PersistDirectoryAtom and a UserEditAtom appended): the reader (legacy.ts pptSlides)
//              reads every SlideContainer in the stream, so the old ones would be read too; the old records would keep
//              the deleted text (an information leak the DOC save had to clear, QA doc-write2), and each save would make
//              the file bigger. Laid out again, the deleted text is gone from the stream and the file grows only by the
//              text typed
//   edits      each slide's paragraphs (as the slide pages show them) against the file read again as opened: whole
//              paragraphs alike at both ends and in the middle matched, each run of changed paragraphs written into the
//              text box its paragraphs are in (letters that differ). A run across text boxes keeps each box's paragraph
//              count but one (the one that makes the fewest letter changes). Enter at a paragraph's end makes a new
//              paragraph in that paragraph's text box. The notes: the notes body placeholder's text against the slide's
//              notes. A new line is a paragraph mark (CR), in a title placeholder a line break (VT): PowerPoint keeps a
//              title one paragraph and does not show a paragraph mark in it
//   records    TextCharsAtom (UTF-16) / TextBytesAtom (8-bit: becomes a TextCharsAtom when a letter needs more); the
//              runs that count characters follow the edit — StyleTextPropAtom (paragraph and character runs),
//              MasterTextPropAtom, TextSpecialInfoAtom (spelling / language). New letters take the runs of the letter
//              before them (at a paragraph's start: of the letter after them); a new paragraph takes the paragraph
//              properties of the paragraph it was typed in; joined paragraphs, the first one's. TextRulerAtom counts no
//              characters and stays as it is. In a file whose slide text is in the slide list (SlideListWithText,
//              PowerPoint 97-2003), the same text box in the slide's drawing (same text type and text) is edited the same
//              way, so the two copies stay alike
//   refused    (save as PPTX) an edit across text boxes that cannot be split as above; text on a slide without a text
//              box; a text box whose records hold character positions (hyperlinks, slide number / date / footer
//              fields, bookmarks) or records not known here; paragraph-numbering extensions (StyleTextProp9Atom) whose
//              run count would change; notes on a slide without a notes text box; a file saved quickly (old slide
//              records still in the stream), encrypted, or whose persist directory or runs are not laid out as known;
//              control characters; a written file that does not read back as edited
//
// Source: [MS-PPT] PowerPoint (.ppt) Binary File Format, [MS-ODRAW] (record headers) — Microsoft open specifications.

import type { Page, TextNode } from "../../core/types";
import { markerLength } from "../../core/richtext";
import { t } from "../../i18n";
import { collectFlow } from "../office";
import { readCfbTree, writeCfb, type CfbNode } from "./cfb";
import { PPT_RT as RT, pptLines, pptPersist, pptSlides, pptText, type LegacyText, type PptAtom, type PptSlide } from "./legacy";
import { fresh, legacyFingerprint, legacyKeepable, pptShape, slideLegacyPages } from "./legacyWrite";
import { pptRichOpen, type PptRichOpen } from "./pptRich";
import { retitleSummaries } from "./oleSummary";
import { changedRuns, letterChanges } from "./textDiff";

/** A text edit this stage does not write: the advice is to save as PPTX (the message says why). */
export type PptWhy = "reader" | "layout" | "box" | "special" | "notes" | "chars" | "verify" | "master";
export class PptRefused extends Error {
  constructor(
    readonly why: PptWhy,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (why: PptWhy) => new PptRefused(why, t("legacysave.err.pptText", { why: t(`legacysave.pptWhy.${why}`) }));

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const put16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
};
const put32 = (b: Uint8Array, o: number, v: number) => {
  put16(b, o, v & 0xffff);
  put16(b, o + 2, Math.floor(v / 0x10000) & 0xffff);
};

/** text records that count characters, made again with the text */
const STYLE = 0x0fa1, MASTER = 0x0fa2, SPECIAL = 0x0faa;
/** text records that need no change: TextRulerAtom, OutlineTextRefAtom, TextSpecialInfoDefaultAtom */
const STILL = new Set([0x0fa6, 0x0f9e, 0x0fa9]);
/** StyleTextProp9Atom (PP9 paragraph numbering): one entry per run of the StyleTextPropAtom it goes with */
const STYLE9 = 0x0fac;
/** top records that are persist objects the reader reads: the document (slide list), slides, notes, masters */
const PERSISTED = new Set<number>([RT.document, RT.slide, RT.notes, RT.mainMaster]);

// ───────────────────────── record tree ─────────────────────────

/** A record of the stream: its header (ver / instance word, type) and either its body or, a container, its records. */
interface Rec {
  at: number;
  vi: number;
  type: number;
  body: Uint8Array;
  kids?: Rec[];
  parent?: Rec;
}

/** The records in [from, to) of `s`; null when they do not fill it exactly. Containers whose records do not fill them are kept whole. */
function recsIn(s: Uint8Array, from: number, to: number, parent: Rec | undefined, all: Map<number, Rec>, depth: number): Rec[] | null {
  const out: Rec[] = [];
  let o = from;
  while (o + 8 <= to) {
    const vi = u16(s, o), type = u16(s, o + 2), len = u32(s, o + 4);
    if (o + 8 + len > to) return null;
    const r: Rec = { at: o, vi, type, body: s.subarray(o + 8, o + 8 + len), parent };
    if ((vi & 0xf) === 0xf && depth < 32) {
      const kids = recsIn(s, o + 8, o + 8 + len, r, all, depth + 1);
      if (kids) r.kids = kids;
    }
    all.set(o, r);
    out.push(r);
    o += 8 + len;
  }
  return o === to ? out : null;
}

const sizeOf = (r: Rec): number => 8 + (r.kids ? r.kids.reduce((n, k) => n + sizeOf(k), 0) : r.body.length);
function writeRec(r: Rec, out: Uint8Array, o: number): number {
  put16(out, o, r.vi);
  put16(out, o + 2, r.type);
  put32(out, o + 4, sizeOf(r) - 8);
  o += 8;
  if (r.kids) for (const k of r.kids) o = writeRec(k, out, o);
  else {
    out.set(r.body, o);
    o += r.body.length;
  }
  return o;
}
function hasType(r: Rec, type: number): boolean {
  return r.type === type || !!r.kids?.some((k) => hasType(k, type));
}
const topOf = (r: Rec) => {
  while (r.parent) r = r.parent;
  return r;
};

// ───────────────────────── character runs ─────────────────────────

/** A run of a run table: how many characters it covers and the rest of its entry as stored. */
interface Run {
  count: number;
  data: Uint8Array;
}

/** TextPFException size at `o` ([MS-PPT] 2.9.18), or −1 for masks not known */
function pfSize(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) return -1;
  const m = u32(b, o);
  if (m & ~0x3ffdff) return -1;
  let n = 4;
  if (m & 0xf) n += 2; // bulletFlags
  for (const bit of [0x80, 0x10, 0x40]) if (m & bit) n += 2; // bulletChar, bulletFontRef, bulletSize
  if (m & 0x20) n += 4; // bulletColor
  for (const bit of [0x800, 0x1000, 0x2000, 0x4000, 0x100, 0x400, 0x8000]) if (m & bit) n += 2; // align … defaultTabSize
  if (m & 0x100000) {
    if (o + n + 2 > b.length) return -1;
    n += 2 + u16(b, o + n) * 4; // tabStops
  }
  if (m & 0x10000) n += 2; // fontAlign
  if (m & 0xe0000) n += 2; // wrapFlags
  if (m & 0x200000) n += 2; // textDirection
  return n;
}
/** TextCFException size ([MS-PPT] 2.9.13), or −1 */
function cfSize(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) return -1;
  const m = u32(b, o);
  if (m & ~0x07ff3eb7) return -1;
  let n = 4;
  if (m & 0x3eb7) n += 2; // fontStyle
  for (const bit of [0x10000, 0x200000, 0x400000, 0x800000, 0x20000, 0x80000, 0x1000000, 0x2000000]) if (m & bit) n += 2;
  for (const bit of [0x40000, 0x100000, 0x4000000]) if (m & bit) n += 4; // color, pp10ext, pp11ext
  return n;
}
/** TextSIException size ([MS-PPT] 2.9.30), or −1 */
function siSize(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) return -1;
  const m = u32(b, o);
  if (m & ~0x267) return -1;
  let n = 4;
  for (const bit of [0x1, 0x2, 0x4, 0x40]) if (m & bit) n += 2; // spellInfo, lid, altLid, bidi
  if (m & 0x20) n += 4; // pp10runid
  if (m & 0x200) {
    if (o + n + 4 > b.length) return -1;
    n += 4 + u32(b, o + n) * 4; // smartTags
  }
  return n;
}

/** Runs from `o` covering `total` characters exactly (entry: count, `lead` bytes, then an exception of `size`); null when not. */
function runsAt(b: Uint8Array, o: number, total: number, lead: number, size: (b: Uint8Array, o: number) => number): { runs: Run[]; end: number } | null {
  const runs: Run[] = [];
  let sum = 0;
  while (sum < total) {
    if (o + 4 + lead > b.length) return null;
    const count = u32(b, o);
    const n = size(b, o + 4 + lead);
    if (count < 1 || n < 0 || o + 4 + lead + n > b.length) return null;
    runs.push({ count, data: b.slice(o + 4, o + 4 + lead + n) });
    sum += count;
    o += 4 + lead + n;
  }
  return sum === total ? { runs, end: o } : null;
}
const runsBytes = (runs: readonly Run[]) => {
  const out = new Uint8Array(runs.reduce((n, r) => n + 4 + r.data.length, 0));
  let o = 0;
  for (const r of runs) {
    put32(out, o, r.count);
    out.set(r.data, o + 4);
    o += 4 + r.data.length;
  }
  return out;
};
/** each character's run (and the text's end mark's) */
const perChar = (runs: readonly Run[]) => runs.flatMap((r, i) => new Array<number>(r.count).fill(i));
/** runs again from each character's run (characters next to each other in the same run: one run) */
function packed(runs: readonly Run[], idx: readonly number[]): Run[] {
  const out: Run[] = [];
  let prev = -1;
  for (const i of idx) {
    if (i === prev) out[out.length - 1].count++;
    else out.push({ count: 1, data: runs[i].data });
    prev = i;
  }
  return out;
}
/** paragraph starts of a text (and its end mark: the last paragraph runs to it) */
const paraStarts = (t: string) => {
  const out = [0];
  for (let i = 0; i < t.length; i++) if (t[i] === "\r") out.push(i + 1);
  return out;
};

/** One text box: the text atom, its text, and the run tables that count its characters. */
interface Box {
  atom: Rec;
  text: string;
  /** the records of the box (to make again) */
  style?: Rec;
  pf?: Run[];
  cf?: Run[];
  master?: Rec;
  mr?: Run[];
  special?: Rec;
  si?: Run[];
  /** run counts as read (a StyleTextProp9Atom goes with them) */
  counts: string;
  style9: boolean;
  /** a title placeholder's text (TextHeaderAtom type 0 Title, 6 CenterTitle) */
  title: boolean;
}

/** The text box of the text atom `atom`: the records with it (an OfficeArtClientTextbox, or its part of a slide list). */
function boxOf(atom: Rec): Box {
  const p = atom.parent;
  if (!p?.kids) throw refuse("layout");
  let group: Rec[];
  if (p.type === RT.clientTextbox) group = p.kids;
  else if (p.type === RT.slideList) {
    // the records from the TextHeaderAtom before the atom to the next TextHeaderAtom / SlidePersistAtom
    const i = p.kids.indexOf(atom);
    let a = i;
    while (a > 0 && p.kids[a].type !== RT.textHeader) a--;
    let b = i + 1;
    while (b < p.kids.length && p.kids[b].type !== RT.textHeader && p.kids[b].type !== RT.slidePersist) b++;
    group = p.kids.slice(a, b);
  } else throw refuse("layout");
  if (group[0]?.type !== RT.textHeader) throw refuse("layout");
  const text = atomTextOf(atom);
  const L = text.length;
  const type = group[0].body.length >= 4 ? u32(group[0].body, 0) : -1;
  const box: Box = { atom, text, counts: "", style9: hasType(topOf(atom), STYLE9), title: type === 0 || type === 6 };
  for (const r of group) {
    if (r === atom || r.type === RT.textHeader || STILL.has(r.type)) continue;
    if (r.type === RT.textChars || r.type === RT.textBytes) throw refuse("layout");
    if (r.type === STYLE) {
      const pf = runsAt(r.body, 0, L + 1, 2, pfSize);
      const cf = pf && runsAt(r.body, pf.end, L + 1, 0, cfSize);
      if (!pf || !cf || cf.end !== r.body.length) throw refuse("layout");
      Object.assign(box, { style: r, pf: pf.runs, cf: cf.runs });
    } else if (r.type === MASTER) {
      const mr = runsAt(r.body, 0, L + 1, 2, () => 0);
      if (!mr || mr.end !== r.body.length) throw refuse("layout");
      Object.assign(box, { master: r, mr: mr.runs });
    } else if (r.type === SPECIAL) {
      const si = runsAt(r.body, 0, L + 1, 0, siSize);
      if (!si || si.end !== r.body.length) throw refuse("layout");
      Object.assign(box, { special: r, si: si.runs });
    } else throw refuse("special"); // hyperlinks, fields, bookmarks … hold character positions
  }
  // paragraph runs start at paragraphs (the edit gives each paragraph one run)
  const starts = new Set(paraStarts(text));
  for (const runs of [box.pf, box.mr])
    if (runs)
      for (let i = 0, at = 0; i < runs.length; at += runs[i++].count) if (!starts.has(at)) throw refuse("layout");
  box.counts = countsOf(box);
  return box;
}
const countsOf = (b: Box) => JSON.stringify([b.pf?.length, b.cf?.length, b.mr?.length]);
const atomTextOf = (r: Rec) => {
  let s = "";
  if (r.type === RT.textChars) for (let i = 0; i + 1 < r.body.length; i += 2) s += String.fromCharCode(u16(r.body, i));
  else for (const c of r.body) s += String.fromCharCode(c);
  return s;
};

/** An edit of a text box: its characters [a, b) replaced by `ins` (\r a paragraph mark). */
interface Edit {
  a: number;
  b: number;
  ins: string;
}

/** Apply one edit to a box: the text, and every run table with it. */
function applyEdit(box: Box, e: Edit) {
  const T = box.text, n = e.ins.length;
  const next = T.slice(0, e.a) + e.ins + T.slice(e.b);
  // the character each character of the new text takes its runs from (the new letters: the letter before, at a
  // paragraph's start the letter after; the end mark: the end mark)
  const from = e.a > 0 && T[e.a - 1] !== "\r" ? e.a - 1 : e.b;
  const src = (i: number) => (i < e.a ? i : i < e.a + n ? from : e.b + (i - e.a - n));
  const chars = (runs: Run[]) => {
    const idx = perChar(runs);
    return packed(runs, Array.from({ length: next.length + 1 }, (_, i) => idx[src(i)]));
  };
  const paras = (runs: Run[]) => {
    const idx = perChar(runs);
    const starts = paraStarts(next);
    const out: number[] = [];
    starts.forEach((s, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : next.length + 1;
      out.push(...new Array<number>(end - s).fill(idx[src(s)]));
    });
    return packed(runs, out);
  };
  if (box.cf) box.cf = chars(box.cf);
  if (box.si) box.si = chars(box.si);
  if (box.pf) box.pf = paras(box.pf);
  if (box.mr) box.mr = paras(box.mr);
  box.text = next;
}

/** Write a box's text and runs into its records. */
function writeBox(box: Box) {
  const T = box.text;
  // (QA: StyleTextProp9Atom entries go with the runs; a run count changed would shift them)
  if (box.style9 && countsOf(box) !== box.counts) throw refuse("special");
  const wide = box.atom.type === RT.textChars || [...T].some((c) => c.charCodeAt(0) > 0xff);
  if (wide) {
    const b = new Uint8Array(T.length * 2);
    for (let i = 0; i < T.length; i++) put16(b, i * 2, T.charCodeAt(i));
    box.atom.type = RT.textChars;
    box.atom.body = b;
  } else box.atom.body = Uint8Array.from(T, (c) => c.charCodeAt(0));
  if (box.style) box.style.body = concat([runsBytes(box.pf!), runsBytes(box.cf!)]);
  if (box.master) box.master.body = runsBytes(box.mr!);
  if (box.special) box.special.body = runsBytes(box.si!);
}
const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};

// ───────────────────────── edits from the pages ─────────────────────────

/** A paragraph of a slide as the file has it: its text atom (index in the slide's texts) and its letters [s, e). */
interface Para {
  atom: number;
  s: number;
  e: number;
  text: string;
}
function parasOf(texts: readonly PptAtom[]): Para[] {
  const out: Para[] = [];
  texts.forEach((a, k) => {
    let s = 0;
    for (let i = 0; i <= a.text.length; i++)
      if (i === a.text.length || a.text[i] === "\r" || a.text[i] === "\x0b") {
        out.push({ atom: k, s, e: i, text: a.text.slice(s, i) });
        s = i + 1;
      }
  });
  return out;
}

const cost = (cs: readonly { a: number; b: number; ins: string }[]) => cs.reduce((n, c) => n + c.b - c.a + c.ins.length, 0);
/** the letters an edit of [i0, i1) of one atom's paragraphs into `ys` changes (null: all its paragraphs gone) */
function atomEdits(P: readonly Para[], texts: readonly PptAtom[], i0: number, i1: number, ys: readonly string[]): Edit[] | null {
  if (ys.length) {
    const T = texts[P[i0].atom].text;
    return letterChanges(pptLines(T.slice(P[i0].s, P[i1 - 1].e)), ys.join("\n")).map((c) => ({ a: P[i0].s + c.a, b: P[i0].s + c.b, ins: c.ins }));
  }
  // whole paragraphs removed: with the mark before them, else the one after them
  const k = P[i0].atom;
  if (i0 > 0 && P[i0 - 1].atom === k) return [{ a: P[i0 - 1].e, b: P[i1 - 1].e, ins: "" }];
  if (i1 < P.length && P[i1].atom === k) return [{ a: P[i0].s, b: P[i1].s, ins: "" }];
  return null;
}

/** The edits (per text atom of the slide) that turn the paragraphs of `texts` into `now`. */
function slideEdits(texts: readonly PptAtom[], now: readonly string[]): Map<number, Edit[]> {
  const P = parasOf(texts);
  const out = new Map<number, Edit[]>();
  const add = (k: number, es: readonly Edit[]) => es.length && out.set(k, [...(out.get(k) ?? []), ...es]);
  for (const [a0, a1, b0, b1] of changedRuns(
    P.map((p) => p.text),
    now,
  )) {
    const ys = now.slice(b0, b1);
    if (a1 === a0) {
      // new paragraphs only: after the paragraph before them (Enter at its end), at the start of the first one
      if (a0 > 0) add(P[a0 - 1].atom, [{ a: P[a0 - 1].e, b: P[a0 - 1].e, ins: "\n" + ys.join("\n") }]);
      else if (P.length) add(P[0].atom, [{ a: 0, b: 0, ins: ys.join("\n") + "\n" }]);
      else throw refuse("box");
      continue;
    }
    // the atoms the changed paragraphs are in, each with its paragraphs [i0, i1)
    const parts: { k: number; i0: number; i1: number }[] = [];
    for (let i = a0; i < a1; i++) {
      const last = parts[parts.length - 1];
      if (last?.k === P[i].atom) last.i1 = i + 1;
      else parts.push({ k: P[i].atom, i0: i, i1: i + 1 });
    }
    // one atom takes the paragraphs added or removed, the others keep their count: the split with the fewest changes
    let best: { c: number; es: [number, Edit[]][] } | null = null;
    for (let j = 0; j < parts.length; j++) {
      const counts = parts.map((p, x) => p.i1 - p.i0 + (x === j ? ys.length - (a1 - a0) : 0));
      if (counts[j] < 0) continue;
      const es: [number, Edit[]][] = [];
      let at = 0, c = 0, ok = true;
      for (let x = 0; x < parts.length && ok; x++) {
        const e = atomEdits(P, texts, parts[x].i0, parts[x].i1, ys.slice(at, at + counts[x]));
        at += counts[x];
        if (!e) ok = false;
        else es.push([parts[x].k, e]), (c += cost(e));
      }
      if (ok && (!best || c < best.c)) best = { c, es };
    }
    if (!best) throw refuse("box");
    for (const [k, e] of best.es) add(k, e);
  }
  return out;
}

const okChars = (s: string) => ![...s].some((c) => c.charCodeAt(0) < 0x20 && c !== "\t" && c !== "\n");
const paraText = (p: { runs: readonly { text: string }[] }) => p.runs.map((r) => r.text).join("");

/** the slide pages, one list per PPT slide (a slide the flow carried onto more pages: those pages too) */
function slideGroups(pages: readonly Page[]): Page[][] {
  const out: Page[][] = [];
  for (const p of pages) if (p.breakBefore === "flow" && out.length) out[out.length - 1].push(p);
  else out.push([p]);
  return out;
}
/** a slide's paragraphs as its pages show them */
function pageParas(group: Page[]): string[] {
  const items = collectFlow(group);
  if (items.some((it) => it.kind !== "p")) throw refuse("box");
  return items.map((it) => (it.kind === "p" ? paraText(it.p) : ""));
}

// ───────────────────────── save ─────────────────────────

const streamNode = (root: CfbNode, name: string) => root.kids?.find((k) => k.kind === "stream" && k.name === name);

/**
 * The .ppt `orig` with the slide text and notes of `pages` written into it (or `orig` itself when they are the text as
 * opened). Throws PptRefused when the edit is not one this stage writes.
 */
export function savePptText(pages: readonly Page[], orig: Uint8Array, legacy: { name: string; fp: string; day?: string }): Uint8Array {
  const tree = readCfbTree(orig);
  const docNode = streamNode(tree.root, "PowerPoint Document"), cuNode = streamNode(tree.root, "Current User");
  if (!docNode?.data || !cuNode?.data || streamNode(tree.root, "EncryptedSummary")) throw refuse("layout");
  const s = docNode.data, cu = cuNode.data;
  let persist: ReturnType<typeof pptPersist>;
  try {
    persist = pptPersist(s, cu);
  } catch {
    throw refuse("layout");
  }
  // the file reads as it did when it was opened: with its formatting (pptRich.ts — the pages as opened, read again from
  // the original file), else as text (a file that does not read so, a presentation opened before)
  let rich: PptRichOpen | null = null;
  try {
    // (date fields on the day of the open — a save on another day reads the same pages)
    const o = pptRichOpen(orig, legacy.name, { day: legacy.day });
    if (legacyFingerprint("ppt", o.pages) === legacy.fp) rich = o;
  } catch {
    rich = null;
  }
  const { slides, fromList } = pptSlides(s, persist.offsets);
  if (!rich) {
    const r = pptText(orig);
    const was = slideLegacyPages(r, legacy.name);
    if (legacyFingerprint("ppt", was) !== legacy.fp) throw refuse("reader");
    const wasGroups = slideGroups(was);
    const showOf = (sl: PptSlide) => (sl.texts.length ? parasOf(sl.texts).map((p) => p.text) : [""]);
    if (wasGroups.length !== slides.length || slides.some((sl, i) => JSON.stringify(pageParas(wasGroups[i])) !== JSON.stringify(showOf(sl)))) throw refuse("reader");
  }

  // the records; the slides, notes and document read must be the live ones (a quickly saved file keeps old copies,
  // which the reader would read too)
  const all = new Map<number, Rec>();
  const top = recsIn(s, 0, s.length, undefined, all, 0) ?? recsInPrefix(s, all);
  const live = new Set(persist.offsets.values());
  for (const rec of top) if (PERSISTED.has(rec.type) && !live.has(rec.at)) throw refuse("reader");

  // the edits
  const boxes = new Map<number, { box: Box; edits: Edit[] }>();
  const edit = (atomAt: number, es: readonly Edit[]) => {
    const rec = all.get(atomAt);
    if (!rec) throw refuse("layout");
    let b = boxes.get(atomAt);
    if (!b) boxes.set(atomAt, (b = { box: boxOf(rec), edits: [] }));
    b.edits.push(...es);
  };
  if (rich) return saveRich(pages, rich, { tree, s, cu, docNode, cuNode, persist, slides, fromList, all, top, boxes, edit, orig, legacy });
  const now = slideGroups(fresh(pages) as Page[]);
  if (now.length !== slides.length) throw refuse("reader");
  slides.forEach((sl, i) => {
    const group = now[i];
    const paras = pageParas(group);
    for (const p of paras) if (!okChars(p)) throw refuse("chars");
    if (!sl.texts.length) {
      if (paras.length !== 1 || paras[0] !== "") throw refuse("box");
    } else for (const [k, es] of slideEdits(sl.texts, paras)) edit(sl.texts[k].at, es);
    // notes: on the slide's first page
    if (group.slice(1).some((p) => p.notes)) throw refuse("notes");
    const notes = (group[0].notes ?? "").replace(/\r\n?/g, "\n");
    if (!okChars(notes)) throw refuse("chars");
    if (!sl.notes) {
      if (notes) throw refuse("notes");
    } else {
      const es = letterChanges(pptLines(sl.notes.text), notes);
      if (es.length) edit(sl.notes.at, es);
    }
  });
  if (!boxes.size) return orig;

  const out = writeBoxes({ tree, s, cu, docNode, cuNode, persist, slides, fromList, all, top, boxes });

  // read back: the text is the one edited, and the file is one the stage-1 save keeps
  const expect: LegacyText["blocks"] = [];
  slides.forEach((sl, i) => {
    const notes = (now[i][0].notes ?? "").replace(/\r\n?/g, "\n");
    expect.push(sl.notes ? { kind: "slide", index: i, notes } : { kind: "slide", index: i });
    if (sl.texts.length) for (const text of pageParas(now[i])) expect.push({ kind: "para", text });
  });
  let back: LegacyText["blocks"];
  try {
    back = pptText(out).blocks;
  } catch {
    throw refuse("verify");
  }
  if (JSON.stringify(back) !== JSON.stringify(expect) || !legacyKeepable("ppt", out)) throw refuse("verify");
  return out;
}

/** What the save works on: the compound file, the stream and its records, the slides as the text reader reads them, the edits. */
interface SaveCtx {
  tree: ReturnType<typeof readCfbTree>;
  s: Uint8Array;
  cu: Uint8Array;
  docNode: CfbNode;
  cuNode: CfbNode;
  persist: ReturnType<typeof pptPersist>;
  slides: PptSlide[];
  fromList: boolean;
  all: Map<number, Rec>;
  top: Rec[];
  boxes: Map<number, { box: Box; edits: Edit[] }>;
}

/** The edited text boxes written into the stream (and their copies), the stream laid out again, the summaries: the file. */
function writeBoxes(c: SaveCtx): Uint8Array {
  const { tree, s, cu, docNode, cuNode, persist, slides, fromList, all, top, boxes } = c;
  // the slide list's copies in the slide drawing (PowerPoint 97-2003): the same text box made the same way — and
  // (pptRich.ts) a drawing's text box edited, its copy in the slide list
  if (fromList)
    slides.forEach((sl) => {
      if (sl.slide === undefined) return;
      const slideRec = all.get(sl.slide);
      if (!slideRec) return;
      const drawn = findAtoms(slideRec).filter((x) => x.parent?.type === RT.clientTextbox);
      for (const a of sl.texts) {
        const b = boxes.get(a.at);
        const type = textType(all.get(a.at)!);
        if (b) {
          const copy = drawn.find((x) => !boxes.has(x.at) && atomTextOf(x) === a.text && textType(x) === type);
          if (copy) boxes.set(copy.at, { box: boxOf(copy), edits: b.edits });
        } else {
          const from = drawn.find((x) => boxes.has(x.at) && atomTextOf(x) === a.text && textType(x) === type);
          if (from) boxes.set(a.at, { box: boxOf(all.get(a.at)!), edits: boxes.get(from.at)!.edits });
        }
      }
    });

  for (const { box, edits } of boxes.values()) {
    // (later edits first: the earlier ones' places do not move)
    // a new line: a paragraph mark, in a title a line break (PowerPoint keeps a title one paragraph: a paragraph mark
    // written into it is not shown — QA ppt-write2, PowerPoint 16)
    const br = box.title ? "\x0b" : "\r";
    for (const e of [...edits].sort((x, y) => y.a - x.a)) applyEdit(box, { ...e, ins: e.ins.replace(/\n/g, br) });
    writeBox(box);
  }

  // lay the stream out again: each top record's new place, then the offsets that point at them
  const placeOf = new Map<number, number>();
  let o = 0;
  for (const rec of top) placeOf.set(rec.at, o), (o += sizeOf(rec));
  const tail = s.subarray(top.length ? top[top.length - 1].at + 8 + top[top.length - 1].body.length : 0);
  const moved = (v: number) => {
    const n = placeOf.get(v);
    if (n === undefined) throw refuse("layout");
    return n;
  };
  for (const { at, dir } of persist.edits) {
    const ue = all.get(at)!, pd = all.get(dir)!;
    if (ue.parent || pd.parent) throw refuse("layout");
    const b = ue.body.slice();
    if (u32(b, 8)) put32(b, 8, moved(u32(b, 8)));
    put32(b, 12, moved(u32(b, 12)));
    ue.body = b;
    const d = pd.body.slice();
    for (let p = 0; p < d.length; ) {
      const n = u32(d, p) >>> 20;
      for (let k = 0; k < n; k++) put32(d, p + 4 + k * 4, moved(u32(d, p + 4 + k * 4)));
      p += 4 + n * 4;
    }
    pd.body = d;
  }
  const stream = new Uint8Array(o + tail.length);
  let w = 0;
  for (const rec of top) w = writeRec(rec, stream, w);
  stream.set(tail, w);
  const cu2 = cu.slice();
  put32(cu2, 16, moved(u32(cu, 16)));
  docNode.data = stream;
  cuNode.data = cu2;

  // the summaries: a changed slide title goes from the presentation title and the slide titles list, the first
  // slide's picture when its text changed (QA ppt-write2: the old text stayed there — oleSummary.ts)
  const titles = slides.map((sl) => {
    const a = sl.texts.find((x) => [0, 6].includes(textType(all.get(x.at)!)));
    return { was: a?.text ?? "", now: a ? (boxes.get(a.at)?.box.text ?? a.text) : "" };
  });
  const firstChanged = !!slides[0]?.texts.some((a) => boxes.has(a.at));
  if (firstChanged || titles.some((x) => x.was !== x.now)) {
    const siNode = streamNode(tree.root, "\u0005SummaryInformation"), dsiNode = streamNode(tree.root, "\u0005DocumentSummaryInformation");
    const got = retitleSummaries({ si: siNode?.data, dsi: dsiNode?.data }, titles, firstChanged);
    if (got.si && siNode) siNode.data = got.si;
    if (got.dsi && dsiNode) dsiNode.data = got.dsi;
  }
  return writeCfb(tree);
}

/** a text node's lines as the file holds its letters: each paragraph without its list marker (a bullet the open drew) */
const nodeLines = (n: TextNode) => n.paragraphs.map((p) => paraText(p).slice(markerLength(p))).join("\n");

/**
 * (pptRich.ts, 2026-11-21) A presentation opened with its formatting: each text box of the pages is the text atom the
 * open read it from (PptRichOpen.texts) — its letters as the pages show them now against the pages as opened, the edits
 * written into that atom; a master's text drawn on a slide, a table cell's text, a text box that shows other letters
 * than its atom (fields) — refused. The file written is opened again the same way: the text is the one edited, and
 * every format, box and object is as the pages have them (pptShape; a box whose text changed may sit elsewhere in its
 * shape, as PowerPoint lays it out again) — else refused as an edit that is not text (save as PPTX).
 */
function saveRich(pages: readonly Page[], rich: PptRichOpen, c: SaveCtx & { edit: (at: number, es: readonly Edit[]) => void; orig: Uint8Array; legacy: { name: string; fp: string; day?: string } }): Uint8Array {
  const now = fresh(pages) as Page[];
  if (now.length !== rich.pages.length) throw refuse("reader");
  const bySlide = new Map(c.slides.map((sl) => [sl.slide, sl]));
  const changed = new Set<string>();
  now.forEach((pg, i) => {
    const was = rich.pages[i];
    if (pg.nodes.length !== was.nodes.length) throw new Error(t("legacysave.err.edited.ppt"));
    pg.nodes.forEach((n, j) => {
      const w = was.nodes[j];
      if (n.type !== "TEXT" || w.type !== "TEXT") return;
      const lines = nodeLines(n);
      if (lines === nodeLines(w)) return;
      changed.add(`${i}:${j}`);
      const a = rich.texts[i][j];
      // (a master's text drawn on the slide: on every slide that shows it; a header / footer the slide shows: no atom)
      if (!a || a.master) throw refuse(a ? "master" : "special");
      // (a list paragraph whose bullet was typed into: the file keeps its bullet)
      if (n.paragraphs.some((p) => p.list && !markerLength(p))) throw refuse("special");
      if (!okChars(lines)) throw refuse("chars");
      const rec = c.all.get(a.at);
      if (!rec) throw refuse("layout");
      const text = pptLines(atomTextOf(rec));
      // (the box shows other letters than its atom holds: a field's text, a number)
      if (nodeLines(w) !== text) throw refuse("special");
      const es = letterChanges(text, lines);
      if (es.length) c.edit(a.at, es);
    });
    const notes = (pg.notes ?? "").replace(/\r\n?/g, "\n");
    if (notes !== (was.notes ?? "")) {
      if (!okChars(notes)) throw refuse("chars");
      const sl = bySlide.get(rich.slideAt[i]);
      if (!sl?.notes) throw refuse("notes");
      const es = letterChanges(pptLines(sl.notes.text), notes);
      if (es.length) c.edit(sl.notes.at, es);
    }
  });
  if (!c.boxes.size) return c.orig;
  const out = writeBoxes(c);
  // read back: opened again with the formatting, the text as edited, everything else as the pages have it
  let again: PptRichOpen;
  try {
    again = pptRichOpen(out, c.legacy.name, { day: rich.day });
  } catch {
    throw refuse("verify");
  }
  if (again.pages.length !== now.length || !legacyKeepable("ppt", out)) throw refuse("verify");
  for (let i = 0; i < now.length; i++) {
    if ((again.pages[i].notes ?? "") !== (now[i].notes ?? "").replace(/\r\n?/g, "\n")) throw refuse("verify");
    const a = again.pages[i].nodes, b = now[i].nodes;
    if (a.length !== b.length) throw refuse("verify");
    for (let j = 0; j < a.length; j++) {
      const x = a[j], y = b[j];
      if (x.type === "TEXT" && y.type === "TEXT" && nodeLines(x) !== nodeLines(y)) throw refuse("verify");
    }
  }
  if (pptShape(again.pages, changed) !== pptShape(now, changed)) throw new Error(t("legacysave.err.edited.ppt"));
  return out;
}

/** top records when bytes that are no record follow them: the records before those bytes */
function recsInPrefix(s: Uint8Array, all: Map<number, Rec>): Rec[] {
  let o = 0;
  while (o + 8 <= s.length && o + 8 + u32(s, o + 4) <= s.length) o += 8 + u32(s, o + 4);
  all.clear();
  const recs = recsIn(s, 0, o, undefined, all, 0);
  if (!recs) throw refuse("layout");
  return recs;
}

/** the TextHeaderAtom type of a text atom's box (−1: none) */
function textType(atom: Rec): number {
  const ks = atom.parent?.kids ?? [];
  for (let i = ks.indexOf(atom) - 1; i >= 0; i--) if (ks[i].type === RT.textHeader) return ks[i].body.length >= 4 ? u32(ks[i].body, 0) : -1;
  return -1;
}
/** text atoms inside a record, at any depth */
function findAtoms(r: Rec): Rec[] {
  if (r.type === RT.textChars || r.type === RT.textBytes) return [r];
  return r.kids?.flatMap(findAtoms) ?? [];
}

/**
 * Read aid (tests, the PowerPoint check): the text boxes of a .ppt's slides — each text atom's text, whether it is
 * 8-bit, and its runs (paragraph runs: count and indent level + exception bytes as hex; character and spelling runs).
 */
export function pptBoxes(file: Uint8Array) {
  const tree = readCfbTree(file);
  const s = streamNode(tree.root, "PowerPoint Document")!.data!;
  const persist = pptPersist(s, streamNode(tree.root, "Current User")!.data!);
  const all = new Map<number, Rec>();
  recsIn(s, 0, s.length, undefined, all, 0);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const show = (a: PptAtom) => {
    const rec = all.get(a.at)!;
    let box: Box;
    try {
      box = boxOf(rec);
    } catch (e) {
      // (a box this stage does not edit: its text only, and why)
      return { text: atomTextOf(rec), bytes: rec.type === RT.textBytes, refused: (e as PptRefused).why };
    }
    const runs = (rs?: Run[]) => rs?.map((r) => ({ count: r.count, data: hex(r.data) }));
    return { text: box.text, bytes: box.atom.type === RT.textBytes, pf: runs(box.pf), cf: runs(box.cf), si: runs(box.si) };
  };
  return pptSlides(s, persist.offsets).slides.map((sl) => ({ texts: sl.texts.map(show), notes: sl.notes && show(sl.notes) }));
}
