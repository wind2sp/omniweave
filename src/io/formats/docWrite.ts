// DOC (Word 97-2003) same-format save, stage 2: a document opened from a .doc whose body text alone was edited
// (legacyWrite.ts docTextOnly — the fingerprint without the text is the one taken at open): letters typed or deleted in
// paragraphs, paragraphs split (Enter) or joined, added or removed. The text is written into the WordDocument stream
// the way Word's own fast save did; every other stream of the compound file (Data, ObjectPool, the summaries …) stays
// byte for byte (but in the summaries a title taken from the first line that changed, and the first page's picture —
// QA doc-summary), and so do the old bytes of WordDocument (but the deleted characters, cleared) and of the table stream
// — what changes is written after them
// or, for the CP tables that keep their size, in their place. Loaded only when such a document is saved as DOC.
//
//   edits      the paragraphs between tables are compared with the file read again as opened (paragraphs alike at
//              both ends and in the middle matched, each run of changed paragraphs one edit: the letters that differ,
//              as characters of the file — CPs). A new paragraph made with Enter at a paragraph's end is written as a
//              paragraph mark after that paragraph's last letter (it takes that paragraph's look, as in Word)
//   cells      (stage 3, doc-write3) a table cell's text: letters and line breaks typed or deleted inside one cell, the
//              cell's and row's marks, its paragraphs' marks and their properties (TAP / PAP) as they were; in the
//              first cell of a row, the paragraphs the reader shows as body paragraphs too (letters only)
//   results    (stage 3) a field's result (after its separator 0x14, before its end 0x15) of a field not nested in
//              another: letters typed or deleted in it; the field's marks stay, its PlcfFld entries move with them and
//              its end gets fResultDirty / fResultEdited as Word sets them. Letters typed where body text and a result
//              meet go into the body, as in stage 2
//   refused    (save as DOCX) an edit that touches a field's code (or a nested field), a paragraph mark in a cell or
//              in a field's result, a table's rows, columns or cells added, removed or merged, a cell of a nested
//              table, a cell merged into the one above or before it (QA: Word does not show its text) or of a row
//              whose cells' TAP is not read here, a picture, a note or comment mark, a page / section / column break or any other special
//              character, the last paragraph mark of the body; a file whose piece table, FIB or CP tables are not the
//              ones known here; characters a DOC cannot hold as text; a written file that does not read back as edited
//              (its text, tables or field marks)
//   looks      (2026-11-17, the open reads the formatting — docRich.ts) the pages as opened are read again from the
//              original with the formatting (else as text, a document opened before); paragraphs are their letters
//              without a list's number or a note's mark (docParaText), a table's cells by the open's cell map (merged
//              cells span columns). The written file opened again must show every paragraph's and letter's format, the
//              tables' and the pictures' as the pages do (sameLooks — the shape leaves them out), and a floating picture
//              stays where it was opened; else the edit is not only text: refused as one (save as DOCX). New letters take
//              the look of the letter before them as shown (over a field's end, its result's last letter)
//   text       the new letters are appended to WordDocument as UTF-16 (one piece each), the piece table (Clx / PlcPcd)
//              is made again: pieces cut around the edits, the deleted CPs left out, the new pieces put in — the old
//              text bytes stay where they are (the formatting pages find them by FC, which did not move); the deleted
//              characters' bytes are cleared (zeros), so deleted text does not stay readable in the file
//   compact    (doc-compact) a file an earlier save of ours appended to: that save's text and formatting pages are written
//              again from where its text began (the text still in the document, with its look, next to the new text;
//              the rest left out) and its Clx / Btes at the table stream's end in their place, so saving again and
//              again does not grow the file — only when that part is found by the shape such a save leaves (tailOf)
//              and the result holds the same document as the append (sameWritten); else the save appends as before
//   formatting the new letters take the character formatting (CHPX) of the letter before them (at a paragraph's start:
//              the letter after them, else the paragraph mark) and a new paragraph mark the paragraph formatting
//              (PAPX) of the paragraph it was typed in; new CHPX / PAPX formatting pages (FKP) cover the appended FCs
//              and are added to PlcBteChpx / PlcBtePapx. Each new piece's text is followed by one spare character so
//              the paragraph run that holds the text after its last mark runs past the piece ([MS-DOC] 2.4.2: the
//              paragraph goes on in the next piece)
//   CPs        the FIB's ccpText; the main document's CP tables (sections, fields, bookmarks, note and comment
//              references, shape anchors) are moved with the text; the stories after the body (headers, notes,
//              comments, text boxes) follow by the piece table, their own tables count from their own start. Caches
//              over CPs that Word builds again (spelling, grammar, language, smart tag state, page descriptors …) are
//              dropped; any other CP table in the file is refused
//
// Source: [MS-DOC] Word (.doc) Binary File Format — Microsoft open specification.

import type { Page, TextParagraph } from "../../core/types";
import { t } from "../../i18n";
import { collectFlow, type FlowItem } from "../office";
import { segments } from "../../core/flow";
import { readCfbTree, writeCfb, type CfbNode } from "./cfb";
import { CP1252, docMainFrom, docMarkKind, docStory, docText, type DocBlock, type DocMain, type DocRawPara, type LegacyText } from "./legacy";
import { docParaText, docRichOpen, docStyleTools } from "./docRich";
import { canon, FLOW_PLACE, flowLegacyPages, fresh, legacyFingerprint, legacyKeepable, without } from "./legacyWrite";
import { markerLength } from "../../core/richtext";
import { retitleText } from "./oleSummary";
import { changedRuns, letterChanges } from "./textDiff";

/** A text edit this stage does not write: the advice is to save as DOCX (the message says why). */
export type DocWhy = "reader" | "layout" | "special" | "chars" | "verify";
export class DocRefused extends Error {
  constructor(
    readonly why: DocWhy,
    message: string,
  ) {
    super(message);
  }
}
type Why = DocWhy;
const refuse = (why: Why) => new DocRefused(why, t("legacysave.err.docText", { why: t(`legacysave.docWhy.${why}`) }));

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

// ───────────────────────── FIB ─────────────────────────

/** fibRgLw: cbMac, ccpText */
const LW_CBMAC = 0, LW_CCPTEXT = 3;
/** FibRgFcLcb pairs used here */
const CHPX = 12, PAPX = 13, CLX = 33, SECTIONS = 6, FIELDS = 16;
/** main-document CP tables moved with the text: pair → bytes of data per entry (PlcffndRef, PlcfandRef, PlcfSed,
 *  PlcfFldMom, PlcfBkf, PlcfBkl, PlcSpaMom, PlcfAtnBkf, PlcfAtnBkl, PlcfendRef) */
const MOVED = new Map([
  [2, 2],
  [4, 30],
  [6, 12],
  [16, 2],
  [22, 4],
  [23, 0],
  [40, 26],
  [42, 4],
  [43, 0],
  [46, 2],
]);
/** CP tables whose CPs stay where text is typed at them (writeEdits move): PlcfSed, PlcfBkf, PlcfBkl, PlcfAtnBkl */
const STAYS = new Set([SECTIONS, 22, 23, 43]);
/** caches over CPs that Word builds again, dropped: PlcfPhe, PlcfPgdFtn, PlcfSpl, the old page descriptors, PlcfGram,
 *  PlcfTch, PlcfLad, Plcffactoid, PgdMother / BkdMother / PgdFtn / BkdFtn / PgdEdn / BkdEdn */
const DROPPED = new Set([8, 34, 55, 63, 64, 65, 66, 67, 68, 90, 93, 98, 102, 103, 104, 105, 106, 107, 132, 154, 155, 157, 158, 160, 161]);
/** not CP tables of the main document (styles, fonts, lists, the Dop, the stories' own tables, names, drawings …) */
const KEPT = new Set([
  0, 1, 3, 5, 9, 11, 12, 13, 15, 17, 18, 19, 20, 21, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 35, 36, 37, 38, 39, 41, 44, 45, 47, 48, 49, 50, 51, 52, 53, 56, 57, 58, 59, 60, 61, 62, 69, 70,
  71, 72, 73, 74, 75, 76, 83, 84, 87, 91, 92, 94, 95, 96, 97, 99, 108, 109, 111, 112, 113, 114, 118, 120, 123, 126, 127, 131, 136, 137, 140, 141, 144, 145, 165, 168, 171, 172, 173, 174,
  177, 178, 179, 180, 181, 182,
]);

interface Fib {
  /** fibRgLw offset */
  lw: number;
  /** FibRgFcLcb offset, and its count of fc / lcb pairs */
  blob: number;
  pairs: number;
}

function fibOf(wd: Uint8Array): Fib {
  if (wd.length < 0x200 || u16(wd, 0) !== 0xa5ec) throw refuse("layout");
  const csw = u16(wd, 0x20);
  const cslwAt = 0x22 + csw * 2;
  const cslw = u16(wd, cslwAt);
  const lw = cslwAt + 2;
  const pairsAt = lw + cslw * 4;
  const pairs = u16(wd, pairsAt);
  const blob = pairsAt + 2;
  // (Word 97 and later: 14 words, 22 longs, at least the 93 pairs of FibRgFcLcb97)
  if (csw < 14 || cslw < 22 || pairs < 0x5d || blob + pairs * 8 > wd.length) throw refuse("layout");
  return { lw, blob, pairs };
}
const fcOf = (wd: Uint8Array, f: Fib, i: number) => u32(wd, f.blob + i * 8);
const lcbOf = (wd: Uint8Array, f: Fib, i: number) => (i < f.pairs ? u32(wd, f.blob + i * 8 + 4) : 0);

// ───────────────────────── pieces, formatting pages ─────────────────────────

/** One piece of the piece table: CPs [cp, cpEnd), its Pcd (flags, FcCompressed as stored, prm). */
interface Piece {
  cp: number;
  cpEnd: number;
  flags: number;
  fc: number;
  prm: number;
}
const compressed = (p: Piece) => (p.fc & 0x40000000) !== 0;
/** byte offset in WordDocument of the CP's character (FcCompressed: an 8-bit piece stores twice its offset) */
const fcAt = (p: Piece, cp: number) => (compressed(p) ? (p.fc & 0x3fffffff) / 2 + (cp - p.cp) : (p.fc & 0x3fffffff) + (cp - p.cp) * 2);

/** PlcBteChpx / PlcBtePapx: the FC each formatting page starts at (and the end), and the pages */
interface Bte {
  fcs: number[];
  pns: number[];
}

function bteOf(table: Uint8Array, fc: number, lcb: number): Bte {
  if (lcb < 12 || (lcb - 4) % 8 || fc + lcb > table.length) throw refuse("layout");
  const n = (lcb - 4) / 8;
  const fcs: number[] = [], pns: number[] = [];
  for (let i = 0; i <= n; i++) fcs.push(u32(table, fc + i * 4));
  for (let i = 0; i < n; i++) pns.push(u32(table, fc + (n + 1) * 4 + i * 4) & 0x3fffff);
  for (let i = 1; i <= n; i++) if (fcs[i] < fcs[i - 1]) throw refuse("layout");
  return { fcs, pns };
}

/** The formatting page run holding byte `fc`: the page's offset, its run count and the run's index. */
function fkpRun(wd: Uint8Array, bte: Bte, fc: number): { page: number; crun: number; j: number } | null {
  let lo = 0, hi = bte.pns.length - 1, i = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bte.fcs[m] <= fc) (i = m), (lo = m + 1);
    else hi = m - 1;
  }
  if (i < 0 || fc >= bte.fcs[i + 1]) return null;
  const page = bte.pns[i] * 512;
  if (page + 512 > wd.length) return null;
  const crun = wd[page + 511];
  for (let j = 0; j < crun; j++) if (u32(wd, page + j * 4) <= fc && fc < u32(wd, page + (j + 1) * 4)) return { page, crun, j };
  return null;
}

type FkpRun = NonNullable<ReturnType<typeof fkpRun>>;

/** CHPX grpprl of the character at byte `fc` (empty: default properties); null when no page holds it */
function chpxAt(wd: Uint8Array, bte: Bte, fc: number): Uint8Array | null {
  const r = fkpRun(wd, bte, fc);
  return r && chpxOfRun(wd, r);
}
function chpxOfRun(wd: Uint8Array, r: FkpRun): Uint8Array {
  const b = wd[r.page + (r.crun + 1) * 4 + r.j];
  if (!b) return new Uint8Array(0);
  const at = r.page + b * 2;
  return wd.slice(at + 1, at + 1 + wd[at]);
}

/** PAPX (grpprlInPapx: istd and grpprl, null: default properties) and PHE of the paragraph mark at byte `fc` */
function papxAt(wd: Uint8Array, bte: Bte, fc: number): { grpprl: Uint8Array | null; phe: Uint8Array } | null {
  const r = fkpRun(wd, bte, fc);
  return r && papxOfRun(wd, r);
}

/**
 * (doc-compact) The formatting page runs over bytes [from, to): each run's end (`lim`, may be past `to`) and its
 * properties (CHPX: null for the defaults; PAPX: the grpprl, null for the defaults, and the PHE). Throws when a byte is
 * held by no page.
 */
function runsIn(wd: Uint8Array, bte: Bte, from: number, to: number, pap: boolean): { lim: number; props: Uint8Array | null; phe?: Uint8Array }[] {
  const out: { lim: number; props: Uint8Array | null; phe?: Uint8Array }[] = [];
  for (let pos = from; pos < to; ) {
    const r = fkpRun(wd, bte, pos);
    if (!r) throw refuse("layout");
    const lim = u32(wd, r.page + (r.j + 1) * 4);
    if (pap) {
      const x = papxOfRun(wd, r);
      out.push({ lim, props: x.grpprl, phe: x.phe });
    } else {
      const g = chpxOfRun(wd, r);
      out.push({ lim, props: g.length ? g : null });
    }
    pos = lim;
  }
  return out;
}

function papxOfRun(wd: Uint8Array, r: FkpRun): { grpprl: Uint8Array | null; phe: Uint8Array } {
  const bx = r.page + (r.crun + 1) * 4 + r.j * 13;
  const phe = wd.slice(bx + 1, bx + 13);
  const b = wd[bx];
  if (!b) return { grpprl: null, phe };
  const at = r.page + b * 2;
  const cb = wd[at];
  return { grpprl: cb ? wd.slice(at + 1, at + 2 * cb) : wd.slice(at + 2, at + 2 + 2 * wd[at + 1]), phe };
}

/** The sprm codes of a grpprl (from byte `from`); null when one cannot be stepped over. */
function sprmsOf(g: Uint8Array, from: number): number[] | null {
  return sprmsAt(g, from)?.map((x) => x.sprm) ?? null;
}

/** The sprms of a grpprl (from byte `from`) with the offset of each one's operand; null when one cannot be stepped over. */
function sprmsAt(g: Uint8Array, from: number): { sprm: number; at: number }[] | null {
  const out: { sprm: number; at: number }[] = [];
  let o = from;
  while (o + 2 <= g.length) {
    const sprm = u16(g, o);
    let size: number;
    switch (sprm >> 13) {
      case 0:
      case 1:
        size = 1;
        break;
      case 2:
      case 4:
      case 5:
        size = 2;
        break;
      case 3:
        size = 4;
        break;
      case 7:
        size = 3;
        break;
      default:
        // variable: a size byte (sprmTDefTable: a size word, one more than the rest; sprmPChgTabs 255: not read here)
        if (sprm === 0xd608) size = u16(g, o + 2) + 1;
        else if (sprm === 0xc615 && g[o + 2] === 255) return null;
        else size = g[o + 2] + 1;
    }
    out.push({ sprm, at: o + 2 });
    o += 2 + size;
  }
  return o === g.length ? out : null;
}

/** character properties that make a character something other than a letter, or mark it as a tracked change:
 *  sprmCFRMarkDel / Ins, sprmCFFldVanish, sprmCFData, sprmCFOle2, sprmCFSpec, sprmCPicLocation, sprmCSymbol,
 *  sprmCObjLocation, sprmCPropRMark90 */
const NOT_LETTER = new Set([0x0800, 0x0801, 0x0802, 0x0806, 0x080a, 0x0855, 0x6a03, 0x6a09, 0x680e, 0xca89]);
/** paragraph properties of a table: sprmPFInTable, sprmPFTtp, sprmPItap, sprmPFInnerTableCell, sprmPFInnerTtp */
const IN_TABLE = new Set([0x2416, 0x2417, 0x6649, 0x244b, 0x244c]);

// ───────────────────────── the document ─────────────────────────

type RawPara = DocRawPara;
type Blk = DocBlock;

interface Doc {
  wd: Uint8Array;
  table: Uint8Array;
  tableName: string;
  /** the Data stream (huge PAPX) */
  data?: Uint8Array;
  fib: Fib;
  ccpText: number;
  prc: Uint8Array;
  pieces: Piece[];
  /** the main document's text by CP, as the reader decodes it */
  text: string;
  /** CPs inside a field (its marks too) */
  inField: Uint8Array;
  /** CPs of a field's result (not a field mark, not inside a field nested in it) of a field not nested in another:
   *  the field's begin CP + 1; else 0 */
  result: Int32Array;
  blocks: Blk[];
  chpx: Bte;
  papx: Bte;
  /** paragraph marks (CPs) of paragraphs in a table cell, or whose properties could not be read */
  cellMarks: Set<number>;
  /** whether the mark (CP) ends a paragraph of a cell of a table not nested in another — its text may be edited */
  cellOk: (mark: number) => boolean;
}

/** the paragraph mark or cell mark at or after `cp` (−1: none) */
function nextMark(text: string, cp: number): number {
  for (let i = cp; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d || c === 0x07) return i;
  }
  return -1;
}

function readDoc(wd: Uint8Array, tables: (name: string) => Uint8Array | undefined, guess = false): Doc {
  const fib = fibOf(wd);
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) throw refuse("layout");
  const tableName = flags & 0x0200 ? "1Table" : "0Table";
  const table = tables(tableName);
  if (!table) throw refuse("layout");
  const ccpText = u32(wd, fib.lw + LW_CCPTEXT * 4);
  // Clx: Prc entries (property changes of a fast save, kept as they are), then the piece table
  const fcClx = fcOf(wd, fib, CLX), lcbClx = lcbOf(wd, fib, CLX);
  if (!lcbClx || fcClx + lcbClx > table.length) throw refuse("layout");
  let o = fcClx;
  const end = fcClx + lcbClx;
  while (o < end && table[o] === 0x01) o += 3 + u16(table, o + 1);
  if (o + 5 > end || table[o] !== 0x02) throw refuse("layout");
  const prc = table.slice(fcClx, o);
  const lcb = u32(table, o + 1), plc = o + 5;
  if (plc + lcb > end || lcb < 16 || (lcb - 4) % 12) throw refuse("layout");
  const n = (lcb - 4) / 12;
  const pieces: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const pcd = plc + (n + 1) * 4 + i * 8;
    pieces.push({ cp: u32(table, plc + i * 4), cpEnd: u32(table, plc + (i + 1) * 4), flags: u16(table, pcd), fc: u32(table, pcd + 2), prm: u16(table, pcd + 6) });
  }
  if (pieces[0].cp !== 0 || pieces.some((p, i) => p.cpEnd <= p.cp || (i > 0 && p.cp !== pieces[i - 1].cpEnd)) || pieces[n - 1].cpEnd < ccpText) throw refuse("layout");
  for (const p of pieces) if (fcAt(p, p.cpEnd) > wd.length) throw refuse("layout");
  // the main text, decoded as the reader does (legacy.ts docText)
  let text = "";
  for (const p of pieces) {
    if (text.length >= ccpText) break;
    const len = Math.min(p.cpEnd - p.cp, ccpText - text.length);
    const at = fcAt(p, p.cp);
    for (let k = 0; k < len; k++) {
      if (compressed(p)) text += CP1252[wd[at + k]] ?? String.fromCharCode(wd[at + k]);
      else text += String.fromCharCode(u16(wd, at + k * 2));
    }
  }
  const chpx = bteOf(table, fcOf(wd, fib, CHPX), lcbOf(wd, fib, CHPX));
  const papx = bteOf(table, fcOf(wd, fib, PAPX), lcbOf(wd, fib, PAPX));
  // the reader's paragraphs and tables (legacy.ts docStory): row ends and cells' lines by their marks' properties, as
  // the reader reads them (docMarkKind)
  let main: DocMain | null = null;
  try {
    main = docMainFrom(wd, tables);
  } catch {
    main = null;
  }
  const { blocks, inField, result } = docStory(text, main && !guess ? (cp) => docMarkKind(main!, cp) : undefined);
  // paragraphs the reader shows outside tables whose mark says otherwise (a cell's first paragraphs read as body)
  const cellMarks = new Set<number>();
  const pieceOf = (cp: number) => pieces.find((p) => p.cp <= cp && cp < p.cpEnd)!;
  for (const b of blocks) {
    if (b.kind !== "para" || b.p.cr < 0) continue;
    const pap = papxAt(wd, papx, fcAt(pieceOf(b.p.cr), b.p.cr));
    const sprms = pap ? (pap.grpprl ? sprmsOf(pap.grpprl, 2) : []) : null;
    if (!sprms || sprms.some((s) => IN_TABLE.has(s))) cellMarks.add(b.p.cr);
  }
  // (doc-write3) a cell's paragraph: its mark's own properties say it is in a table (sprmPFInTable), not a row's end
  // (sprmPFTtp), not in a table nested in a cell (sprmPItap above 1, sprmPFInnerTableCell, sprmPFInnerTtp)
  const okMarks = new Map<number, boolean>();
  /** a mark's PAPX grpprl (istd first) and its sprms; a huge PAPX (sprmPHugePapx) read from the Data stream */
  const papOf = (mark: number): { g: Uint8Array; sprms: { sprm: number; at: number }[] } | null => {
    const c = text.charCodeAt(mark);
    const pap = mark >= 0 && mark < ccpText && (c === 0x0d || c === 0x07) && !inField[mark] ? papxAt(wd, papx, fcAt(pieceOf(mark), mark)) : null;
    let g = pap?.grpprl;
    let sprms = g ? sprmsAt(g, 2) : null;
    const huge = sprms?.find((x) => x.sprm === 0x6646);
    if (g && huge) {
      // (PrcData in the Data stream: cbGrpprl, then the grpprl — without the istd; the istd kept in front of it here)
      const data = tables("Data"), o = u32(g, huge.at);
      if (!data || o + 2 > data.length || o + 2 + u16(data, o) > data.length) return null;
      g = Uint8Array.from([g[0], g[1], ...data.subarray(o + 2, o + 2 + u16(data, o))]);
      sprms = sprmsAt(g, 2);
    }
    return g && sprms ? { g, sprms } : null;
  };
  /** whether the mark's paragraph is in a cell of a table not nested in another (not a row's end) */
  const paraInCell = (mark: number) => {
    const pap = papOf(mark);
    if (!pap) return false;
    const { g, sprms } = pap;
    const val = (s: number) => sprms.find((x) => x.sprm === s);
    const flag = (s: number) => {
      const x = val(s);
      return x ? g[x.at] : 0;
    };
    const itap = val(0x6649);
    return flag(0x2416) === 1 && !flag(0x2417) && !flag(0x244b) && !flag(0x244c) && (!itap || u32(g, itap.at) <= 1);
  };
  /** whether a row's end (TTP) is one */
  const isTtp = (mark: number) => {
    const pap = papOf(mark);
    const x = pap?.sprms.find((s) => s.sprm === 0x2417);
    return !!pap && !!x && pap.g[x.at] === 1;
  };
  // (QA doc-write3) a cell merged into the one before it (fMerged) or the one above it (fVertMerge without
  // fVertRestart) is not shown by Word — its text would be hidden: such a cell, or a cell of a row whose TAP is not read
  // here (no sprmTDefTable, cells inserted, deleted, merged or split by sprm), is not edited. Each cell mark (0x07) of
  // the body: its row's end and its index in the row (itc), found once.
  let rowOf: Map<number, { ttp: number; itc: number }> | null = null;
  const shownCell = (cell: number) => {
    if (!rowOf) {
      rowOf = new Map();
      let pending: number[] = [];
      for (let cp = 0; cp < ccpText; cp++) {
        if (text.charCodeAt(cp) !== 0x07 || inField[cp]) continue;
        if (isTtp(cp)) {
          pending.forEach((m, itc) => rowOf!.set(m, { ttp: cp, itc }));
          pending = [];
        } else pending.push(cp);
      }
    }
    const row = rowOf.get(cell);
    const pap = row && papOf(row.ttp);
    if (!row || !pap) return false;
    const { g, sprms } = pap;
    if (sprms.some((x) => [0x5624, 0x5625, 0x7621, 0x5622, 0xd606].includes(x.sprm))) return false;
    const def = sprms.find((x) => x.sprm === 0xd608);
    if (!def) return false;
    // TDefTableOperand: cb (2 bytes), itcMac, rgdxaCenter (itcMac + 1 × 2 bytes), rgTc80 (20 bytes each; may be fewer)
    const end = def.at + 2 + u16(g, def.at) - 1;
    const itcMac = g[def.at + 2];
    if (row.itc >= itcMac) return false;
    const tc = def.at + 3 + (itcMac + 1) * 2 + row.itc * 20;
    let grf = tc + 2 <= end ? u16(g, tc) : 0;
    // sprmTVertMerge (VertMergeOperand: cb 2, itc, 0 none / 1 merged with the cell above / 3 the first of a merge)
    for (const x of sprms) if (x.sprm === 0xd62b && g[x.at + 1] === row.itc) grf = (grf & ~0x60) | (g[x.at + 2] & 1 ? 0x20 : 0) | (g[x.at + 2] & 2 ? 0x40 : 0);
    return !(grf & 0x02) && (grf & 0x60) !== 0x20;
  };
  const cellOk = (mark: number) => {
    let ok = okMarks.get(mark);
    if (ok !== undefined) return ok;
    ok = paraInCell(mark);
    if (ok) {
      // (the cell the paragraph is in: its cell mark, the first at or after its paragraph mark)
      let cell = mark;
      while (cell < ccpText && text.charCodeAt(cell) !== 0x07) cell++;
      ok = cell < ccpText && shownCell(cell);
    }
    okMarks.set(mark, ok);
    return ok;
  };
  return { wd, table, tableName, data: tables("Data"), fib, ccpText, prc, pieces, text, inField, result, blocks, chpx, papx, cellMarks, cellOk };
}

const blocksOf = (d: Doc): LegacyText["blocks"] => d.blocks.map((b) => (b.kind === "para" ? { kind: "para", text: b.p.text } : { kind: "table", rows: b.rows }));

// ───────────────────────── edits ─────────────────────────

/** Replace the CPs [s, e) of the original main text with `text` (code units, \r a paragraph mark). */
interface Edit {
  s: number;
  e: number;
  text: string;
  /** the paragraph mark whose properties the new marks take (else the mark that ends the paragraph the edit is in) */
  papxMark?: number;
  /** the character whose properties the new text takes (else the letter before, …) */
  chpxCp?: number;
  /** (doc-write3) the begin CP of the field whose result this edit is in */
  field?: number;
  /**
   * (doc-para-write) paragraphs joined by the edit (a mark deleted): which one's properties the joined paragraph has on
   * the pages — the first one's (its mark is written again with them) or the last one's (its own mark stays)
   */
  join?: "first" | "end";
  /** (doc-para-write) the properties of the new text, given: each code unit's CHPX (null: none), each new mark's PAPX */
  look?: { chpx: (Uint8Array | null)[]; papx: { grpprl: Uint8Array | null; phe: Uint8Array }[] };
  /** (doc-para-write) a mark written again for paragraphs joined: where the letters of the paragraph it ends begin */
  from?: number;
}

/** a paragraph's format as the pages show it (docLooks: but its letters) — what tells which paragraph a new one is like */
function paraLook(p: TextParagraph): string {
  return canon({ ...without(p, ["runs", "lineSpacing", "wordLine", "lineMultiple", "list"]), mult: p.lineMultiple?.v, list: p.list ? { ...without(p.list, ["mk"]), shown: markerLength(p) > 0 } : undefined }, FLOW_PLACE);
}

/** a paragraph's style (its PAPX's istd; no PAPX: Normal) */
const istdOf = (g: Uint8Array | null) => (g && g.length >= 2 ? u16(g, 0) : 0);

const plainChar = (c: number) => c >= 0x20 || c === 0x09 || c === 0x0b;

/**
 * Where letters typed between code units a − 1 and a of a paragraph's or a cell's text go: right after the letter before,
 * or right before the letter after (`ok`: a CP that may be written next to, with its paragraph's mark) — outside a field
 * when a letter of the body is on either side (doc-write3: as stage 2 did), else in the field's result (at its end when
 * the results of two fields meet). The CP and the field whose result it is in (its begin CP; −1: none); null when
 * neither side may be.
 */
function placeAt(d: Doc, cps: readonly number[], marks: readonly number[], a: number, ok: (cp: number, mark: number) => boolean): { s: number; field: number } | null {
  const L = a > 0 ? cps[a - 1] : -1, R = a < cps.length ? cps[a] : -1;
  const pl = L >= 0 && ok(L, marks[a - 1]);
  // (the letter after: in the same paragraph, or the first of the next one — a cell's paragraph after its mark)
  const pr = R >= 0 && ok(R, marks[a]) && (L < 0 || marks[a] === marks[a - 1] || L === marks[a - 1]);
  if (pl && !d.result[L]) return { s: L + 1, field: -1 };
  if (pr && !d.result[R]) return { s: R, field: -1 };
  if (pl) return { s: L + 1, field: d.result[L] - 1 };
  if (pr) return { s: R, field: d.result[R] - 1 };
  return null;
}

/** the new text as the characters of a DOC: \r a paragraph mark (only where `marks`), \n a line break, no other controls */
function docUnits(ins: string, marks: boolean): string {
  let units = "";
  for (const ch of ins) {
    const c = ch.charCodeAt(0);
    if (ch === "\r") {
      if (!marks) throw refuse("special");
      units += "\r";
    } else if (ch === "\n") units += "\x0b";
    else if (c < 0x20 && c !== 0x09) throw refuse("chars");
    else units += ch;
  }
  return units;
}

/**
 * (doc-write3) The text edits inside table cells: the tables as they were (the reader's, with their CPs) against the
 * tables of the body flow now — the same tables, rows and cells (a row, column or cell added or removed, cells merged:
 * refused); in a cell whose text changed, each place where the letters differ is one edit, inside that cell: letters and
 * line breaks typed or deleted, never a paragraph or cell mark; in a cell of a table nested in another, refused.
 */
function cellEdits(d: Doc, items: readonly FlowItem[], cellMap?: number[][][]): Edit[] {
  const was = d.blocks.flatMap((b) => (b.kind === "table" ? [b] : []));
  const now = items.flatMap((it) => (it.kind === "table" ? [it.t.rows] : [])).map((rows, ti) => fileRows(rows, ti, cellMap));
  if (was.length !== now.length) throw refuse("special");
  const edits: Edit[] = [];
  was.forEach((tb, ti) => {
    const rows = now[ti];
    // (the flow fills short rows with empty cells — a merged cell's row: those stay empty)
    if (rows.length !== tb.cells.length || rows.some((r, i) => r.length < tb.cells[i].length || r.slice(tb.cells[i].length).some((x) => x))) throw refuse("special");
    tb.cells.forEach((row, ri) =>
      row.forEach((cell, ci) => {
        const text = rows[ri][ci];
        if (text === cell.text) return;
        const marks = cell.cps.map((cp) => nextMark(d.text, cp));
        /** a letter of this cell (a line break too; in a field's result too), its paragraph one of a cell of a table */
        const ok = (cp: number, mark: number) => plainChar(d.text.charCodeAt(cp)) && (!d.inField[cp] || d.result[cp] > 0) && mark >= 0 && mark <= cell.mark && d.cellOk(mark);
        for (const { a, b, ins } of letterChanges(cell.text, text)) {
          let s: number, e: number, field: number;
          if (b > a) {
            s = cell.cps[a];
            e = cell.cps[b - 1] + 1;
            field = d.result[s] - 1;
            for (let k = a; k < b; k++) if (cell.cps[k] !== s + (k - a) || !ok(cell.cps[k], marks[k]) || d.result[cell.cps[k]] - 1 !== field) throw refuse("special");
          } else {
            const at = placeAt(d, cell.cps, marks, a, ok);
            if (at) ({ s, field } = at);
            // (no letter next to it: at the cell's start, or right before its mark)
            else if (a === 0 && !d.inField[cell.start] && d.cellOk(nextMark(d.text, cell.start))) (s = cell.start), (field = -1);
            else if (a === cell.cps.length && !d.inField[cell.mark] && d.cellOk(cell.mark)) (s = cell.mark), (field = -1);
            else throw refuse("special");
            e = s;
          }
          edits.push({ s, e, text: docUnits(ins, false), ...(field >= 0 ? { field } : {}) });
        }
      }),
    );
  });
  return edits;
}

/** the index among the tables of the body flow of the table at item `k` */
const tableIndex = (items: readonly FlowItem[], k: number) => items.slice(0, k).filter((x) => x.kind === "table").length;

/**
 * A table's cell texts by the file's cells: with the open's cell map (docRich.ts: the table node's column of each of the
 * file's cells — merged cells span columns, rows may start later), each row's cells as the file has them, then the
 * columns no cell of the file is in (covered by a merge, or the grid's own: they must stay empty); without one, the row
 * as it is (text-only pages: one column per cell).
 */
function fileRows(rows: readonly (readonly { text: string }[])[], ti: number, cellMap?: number[][][]): string[][] {
  const map = cellMap?.[ti];
  return rows.map((row, ri) => {
    const cols = map?.[ri];
    if (!cols) return row.map((c) => c.text);
    const used = new Set(cols);
    return [...cols.map((c) => row[c]?.text ?? ""), ...row.filter((_, c) => !used.has(c)).map((c) => c.text)];
  });
}

/**
 * The text edits that turn the file as opened into `items` (the body flow now), in CP order. With `opened` (the body flow
 * as opened with the formatting, doc-para-write) and the file's style sheet (`styles`): where a paragraph is added or
 * paragraphs are joined, the properties of each paragraph as the pages give them decide how — a new paragraph like the
 * one before it is cut from it (Enter at its end), like the one after it is put before that one (Enter at its start),
 * like the paragraph its style names for the one after it gets that style alone (Enter at a heading's end: Word's
 * "style for the following paragraph"); paragraphs joined with the first one's properties have the mark that ends them
 * written again with those (the letters of the others with the CHPX that keeps their look under the first one's style),
 * with the last one's keep its mark.
 */
function textEdits(d: Doc, items: readonly FlowItem[], cellMap?: number[][][], opened?: readonly FlowItem[], styles?: ReturnType<typeof docStyleTools>, pics?: { was: Map<string, number>; now: Map<string, number> }): Edit[] {
  // the paragraphs between tables, then and now
  const groupsWas: RawPara[][] = [[]], groupsNow: string[][] = [[]];
  const looksWas: TextParagraph[][] = [[]], looksNow: TextParagraph[][] = [[]];
  for (const b of d.blocks) {
    if (b.kind === "para") groupsWas[groupsWas.length - 1].push(b.p);
    else groupsWas.push([]);
  }
  for (const it of items) {
    // (the paragraph's letters as the file has them: without a list's number, a note's mark — docRich.ts docParaText)
    if (it.kind === "p") groupsNow[groupsNow.length - 1].push(docParaText(it.p)), looksNow[looksNow.length - 1].push(it.p);
    else groupsNow.push([]), looksNow.push([]);
  }
  for (const it of opened ?? []) {
    if (it.kind === "p") looksWas[looksWas.length - 1].push(it.p);
    else looksWas.push([]);
  }
  const looks = !!opened && looksWas.every((L, g) => L.length === groupsWas[g]?.length);
  const papxOfCp = (cp: number) => {
    const p = d.pieces.find((x) => x.cp <= cp && cp < x.cpEnd);
    return p ? papxAt(d.wd, d.papx, fcAt(p, cp)) : null;
  };
  const chpxOfCp = (cp: number) => {
    const p = d.pieces.find((x) => x.cp <= cp && cp < x.cpEnd);
    return p ? chpxAt(d.wd, d.chpx, fcAt(p, cp)) : null;
  };
  /** the code units up to `to` of `s` that are paragraph marks */
  const marksIn = (s: string, to: number) => {
    let n = 0;
    for (let k = 0; k < to; k++) if (s.charCodeAt(k) === 13) n++;
    return n;
  };
  const lastMark = d.text.lastIndexOf("\r");
  /** a CP that may be deleted or written next to: a letter (or a paragraph mark) of a body paragraph, outside fields —
   *  (doc-write3) a letter of a field's result too, and a letter (not the mark) of a cell's paragraph the reader shows
   *  as a body paragraph (the first paragraphs of a row's first cell) */
  const plain = (cp: number, mark: number) => {
    const c = d.text.charCodeAt(cp);
    if (mark < 0) return false;
    if (c === 0x0d) return cp === mark && !d.inField[cp] && !d.cellMarks.has(mark);
    return plainChar(c) && (!d.inField[cp] || d.result[cp] > 0) && (!d.cellMarks.has(mark) || d.cellOk(mark));
  };
  const edits: Edit[] = cellEdits(d, items, cellMap);
  groupsWas.forEach((P, g) => {
    const Q = groupsNow[g];
    if (!P.length !== !Q.length) throw refuse("special");
    let after = 0;
    for (let [i0, i1, j0, j1] of changedRuns(
      P.map((p) => p.text),
      Q,
    )) {
      // (doc-para-write) with the formatting: the empty paragraphs right before the run in it too — an empty paragraph
      // added next to others may be any of them, the one the pages have is told by its look (below)
      if (looks) while (i0 - 1 > after && j0 > 0 && !P[i0 - 1].text && !Q[j0 - 1] && P[i0 - 1].cr >= 0) i0--, j0--;
      after = i1;
      // the run's text, each paragraph with its mark, after the mark of the paragraph before (when there is one)
      const ctx = i0 > 0 ? P[i0 - 1] : null;
      let was = ctx ? "\r" : "";
      const cps: number[] = ctx ? [ctx.cr] : [];
      const marks: number[] = ctx ? [ctx.cr] : [];
      for (const p of P.slice(i0, i1)) {
        if (p.cr < 0) throw refuse("special");
        was += p.text + "\r";
        cps.push(...p.cps, p.cr);
        marks.push(...p.cps.map(() => p.cr), p.cr);
      }
      const now = (ctx ? "\r" : "") + Q.slice(j0, j1).map((q) => q + "\r").join("");
      // (doc-para-write) the paragraphs (then, now) a code unit of `was` / `now` is in
      const PL = looksWas[g], QL = looksNow[g];
      const baseP = i0 - (ctx ? 1 : 0), baseQ = j0 - (ctx ? 1 : 0);
      let shift = 0;
      // each place where the letters differ is one edit: the letters between them keep their own bytes and look
      for (const region of letterChanges(was, now)) {
        let { a, b, ins } = region;
        const nowA = a + shift;
        shift += ins.length - (b - a);
        if (looks && a === b && ins.endsWith("\r") && a > 0 && was[a - 1] === "\r") {
          // (doc-para-write) paragraphs added between two: like which one the pages have them
          const k = marksIn(ins, ins.length);
          const lead = nowA - a;
          const bare = /^\r+$/.test(ins);
          // (empty paragraphs only: among other empty paragraphs any place is the same text — the one where the
          // paragraphs then and now are alike)
          const places = [a];
          if (bare) {
            for (let c = a - 1; c >= 1 && was[c] === "\r" && was[c - 1] === "\r"; c--) places.push(c);
            for (let c = a + 1; c <= was.length && was[c - 1] === "\r" && was[c - 2] === "\r"; c++) places.push(c);
          }
          const Lo = Math.min(...places), Hi = Math.max(...places);
          const w0 = baseP + marksIn(was, Lo), qs = baseQ + marksIn(now, Lo + lead);
          // (an empty one: its letters' look — the last letter's of the one before it, the first's of the one after)
          const runKey = (r: TextParagraph["runs"][number] | undefined) => (r ? canon(without(r, ["text"]), FLOW_PLACE) : "");
          const shown = (p: TextParagraph | undefined, end: boolean) => {
            const rs = p?.runs.filter((r) => r.text) ?? [];
            return runKey(rs.length ? rs[end ? rs.length - 1 : 0] : p?.runs[0]);
          };
          const options = places
            .sort((u, v) => u - v)
            .flatMap((c) => {
              // (the empty paragraphs of then among those places: the same as now, the new ones put at this one)
              for (let t = 0; t < Hi - Lo; t++) {
                const qi = qs + t + (Lo + t < c ? 0 : k);
                if (!PL[w0 + t] || !QL[qi] || paraLook(PL[w0 + t]) + (pics?.was.get(PL[w0 + t].id) ?? 0) !== paraLook(QL[qi]) + (pics?.now.get(QL[qi].id) ?? 0)) return [];
              }
              const x = baseP + marksIn(was, c - 1), y = x + 1;
              const q0 = baseQ + marksIn(now, c + lead);
              const added = QL.slice(q0, q0 + k);
              const like = (p: TextParagraph | Omit<TextParagraph, "id"> | undefined) => !!p && added.length === k && added.every((q) => paraLook(q) === paraLook(p as TextParagraph));
              const X = P[x], Y = P[y];
              const yOk = !!Y && Y.cr >= 0 && !d.cellMarks.has(Y.cr) && !(Y.start > 0 && d.inField[Y.start - 1]) && !d.inField[Y.start];
              const xp = X && X.cr >= 0 ? papxOfCp(X.cr) : null;
              const newRun = bare ? runKey(added[0]?.runs[0]) : "";
              const nx = xp && styles ? styles.next(istdOf(xp.grpprl)) : -1;
              const tpl = nx >= 0 ? PL[x]?.styleNext : undefined;
              // which the pages made: like it in the paragraph's format and (an empty one) its letters' — the one
              // before first, then its style's next, then the one after
              const ways = [
                { w: "x", p: !!X && like(PL[x]), r: !bare || newRun === shown(PL[x], true) },
                { w: "next", p: !!xp && like(tpl), r: !bare || newRun === runKey(tpl?.runs[0]) },
                { w: "y", p: yOk && like(PL[y]), r: !bare || newRun === shown(PL[y], false) },
              ];
              return ways.filter((v) => v.p).map((v) => ({ c, X, Y, yOk, xp, nx, way: v.w, full: v.r }));
            });
          // (the first place and way alike in the letters too, else the first alike in the paragraph's format)
          const pick = options.find((o) => o.full) ?? options[0];
          let done = false;
          if (pick) {
            const { c, X, Y, yOk, xp, nx, way } = pick;
            if (way === "x") {
              // Enter at its end: cut from it (below) — an empty one with the last letter's character properties when its
              // own mark has others (the mark that ends it would be that one)
              const lastCp = X.cps[X.cps.length - 1];
              const own = X.cr >= 0 ? chpxOfCp(X.cr) : null, lastG = lastCp !== undefined && !d.inField[lastCp] ? chpxOfCp(lastCp) : null;
              if (bare && xp && own && lastG && !sameBytes(own, lastG) && !(sprmsOf(lastG, 0) ?? [0x0800]).some((s) => NOT_LETTER.has(s))) {
                const units = docUnits(ins, true);
                const g = lastG.length ? lastG : null;
                if (yOk) (done = true), edits.push({ s: Y.start, e: Y.start, text: units, look: { chpx: [...units].map(() => g), papx: [...units].map(() => xp) } });
                else if (plain(X.cr, X.cr) && X.cr !== lastMark) (done = true), edits.push({ s: X.cr, e: X.cr + 1, text: "\r" + units, look: { chpx: [own.length ? own : null, ...[...units].map(() => g)], papx: [xp, ...[...units].map(() => xp)] } });
              }
              if (!done) a = b = c;
            } else if (way === "next" && xp) {
              // Enter at the end of a paragraph whose style names another for the one after it: that style alone, the
              // letters with none of their own — before the next paragraph's letters, else after this one's own mark
              // written again
              const units = docUnits(ins, true);
              const papx = { grpprl: Uint8Array.of(nx & 255, nx >> 8), phe: xp.phe };
              if (yOk) (done = true), edits.push({ s: Y.start, e: Y.start, text: units, look: { chpx: [...units].map(() => null), papx: [...units].filter((u) => u === "\r").map(() => papx) } });
              else if (plain(X.cr, X.cr) && X.cr !== lastMark) {
                const own = chpxOfCp(X.cr);
                done = true;
                edits.push({ s: X.cr, e: X.cr + 1, text: "\r" + units, look: { chpx: [own && own.length ? own : null, ...[...units].map(() => null)], papx: [xp, ...[...units].filter((u) => u === "\r").map(() => papx)] } });
              }
            } else if (way === "y") {
              // Enter at the start of a paragraph: the new ones before its letters, with its look
              edits.push({ s: Y.start, e: Y.start, text: docUnits(ins, true) });
              done = true;
            }
          }
          if (done) continue;
        }
        if (looks && pics && b > a && !ins && /^\r+$/.test(was.slice(a, b))) {
          // (doc-pic-para) marks deleted among empty paragraphs: any of them is the same text — the ones whose paragraphs
          // join as the pages have their pictures (a picture is in the paragraph its mark ends: the mark deleted after it
          // takes it into the paragraph after)
          const k = b - a, lead = nowA - a;
          let lo = a, hi = b;
          while (lo > 0 && was[lo - 1] === "\r") lo--;
          while (hi < was.length && was[hi] === "\r") hi++;
          const x0 = baseP + marksIn(was, lo), x1 = baseP + marksIn(was, hi), q0 = baseQ + marksIn(now, lo + lead);
          const cnt = (m: Map<string, number>, p: TextParagraph | undefined) => (p ? m.get(p.id) ?? 0 : -1);
          const fits = (c: number) => {
            const x = baseP + marksIn(was, c);
            const counts: number[] = [];
            for (let t = x0; t <= x1; t++) {
              const v = cnt(pics.was, PL[t]);
              if (t > x && t <= x + k) counts[counts.length - 1] += v;
              else counts.push(v);
            }
            return counts.every((v, t) => v === cnt(pics.now, QL[q0 + t]));
          };
          if (!fits(a))
            for (let c = lo; c + k <= hi; c++)
              if (c !== a && fits(c)) {
                (a = c), (b = c + k);
                break;
              }
        }
        let join: Edit["join"];
        if (looks && b > a && was.slice(a, b).includes("\r")) {
          // (doc-para-write) paragraphs joined: the pages show the joined one with the first one's properties, or the
          // last one's
          const first = PL[baseP + marksIn(was, a)], last = PL[baseP + marksIn(was, b)], joined = QL[baseQ + marksIn(now, nowA + ins.length)];
          if (first && last && joined && paraLook(first) !== paraLook(last)) join = paraLook(joined) === paraLook(first) ? "first" : paraLook(joined) === paraLook(last) ? "end" : undefined;
        }
        // a paragraph added after another (Enter at its end): the new mark right after that paragraph's text, so the
        // new paragraph is cut from it and takes its look
        if (a === b && ins.endsWith("\r") && a > 0 && was[a - 1] === "\r") (a -= 1), (b -= 1), (ins = "\r" + ins.slice(0, -1));
        // the body's last paragraph removed: the mark before it goes instead (the body keeps its last mark)
        if (b > a && !ins && cps[b - 1] === lastMark && a > 0 && was[a - 1] === "\r" && was[b - 1] === "\r") (a -= 1), (b -= 1);
        let s: number, e: number;
        let field = -1;
        if (b > a && !ins && pics) {
          // (doc-pic-para) marks and letters deleted around pictures (a paragraph holding only a picture joined with the
          // ones around it): each run of characters deleted, the pictures between them kept — they go into the joined
          // paragraph, as the pages have them
          const runs: [number, number][] = [];
          for (let k = a; k < b; k++) {
            const last = runs[runs.length - 1];
            if (last && cps[k] === last[1]) last[1]++;
            else runs.push([cps[k], cps[k] + 1]);
          }
          const gapsArePictures = runs.length > 1 && runs.every(([, e1], r) => r === runs.length - 1 || (runs[r + 1][0] > e1 && [...d.text.slice(e1, runs[r + 1][0])].every((ch) => ch === "\x01" || ch === "\x08")));
          if (gapsArePictures) {
            const f = d.result[cps[a]] - 1;
            for (let k = a; k < b; k++) if (!plain(cps[k], marks[k]) || d.result[cps[k]] - 1 !== f) throw refuse("special");
            if (cps[b - 1] === lastMark) throw refuse("special");
            for (const [s1, e1] of runs) edits.push({ s: s1, e: e1, text: "", ...(f >= 0 ? { field: f } : {}), ...(join ? { join } : {}) });
            continue;
          }
        }
        if (b > a) {
          s = cps[a];
          e = cps[b - 1] + 1;
          // (doc-write3: letters of one field's result, or none)
          field = d.result[s] - 1;
          for (let k = a; k < b; k++) if (cps[k] !== s + (k - a) || !plain(cps[k], marks[k]) || d.result[cps[k]] - 1 !== field) throw refuse("special");
          if (e - 1 === lastMark) throw refuse("special");
        } else {
          // after the letter before, before the letter or mark after it — outside a field when a letter of the body is
          // on either side, else in the field's result (placeAt); else where the run starts
          if (a > 0 && ins.startsWith("\r") && was[a] === "\r" && was[a - 1] === "\r") {
            // (doc-para-write: a new paragraph cut from an empty one — after the empty paragraphs before it in the run —
            // right before its mark, after a picture it holds, as for the run's first paragraph)
            if (!plain(cps[a], marks[a])) throw refuse("special");
            s = cps[a];
            field = -1;
          } else if (a > 0) {
            const at = placeAt(d, cps, marks, a, plain);
            if (!at) throw refuse("special");
            ({ s, field } = at);
          } else if (ctx) {
            // (a new paragraph cut from the one before: right before its mark)
            if (!plain(cps[0], marks[0])) throw refuse("special");
            s = cps[0];
          } else {
            // (no paragraph before in this run of paragraphs: at the start of the first one; in a cell's paragraph the
            // reader shows as body, letters only)
            s = P[i0].start;
            if ((s > 0 && d.inField[s - 1]) || P[i0].cr < 0 || (d.cellMarks.has(P[i0].cr) && (!d.cellOk(P[i0].cr) || ins.includes("\r")))) throw refuse("special");
          }
          // (QA docx-flow) a page break (0x0C, not a section's mark) the reader leaves out at the start of a paragraph:
          // the letters typed there go after it — the reader shows that break before the paragraph (docRich), and
          // letters before it would move the paragraph up to the page before
          while (d.text[s] === "\x0c" && !marks.includes(s) && s < (P[i1 - 1]?.cr ?? s)) s++;
          e = s;
        }
        // (doc-write3) no paragraph mark in a field's result, nor in a cell's paragraph
        const cellPara = marks.slice(a > 0 ? a - 1 : a, Math.max(b, a + 1)).some((m) => d.cellMarks.has(m));
        edits.push({ s, e, text: docUnits(ins, field < 0 && !cellPara), ...(field >= 0 ? { field } : {}), ...(join ? { join } : {}) });
      }
    }
  });
  edits.sort((x, y) => x.s - y.s);
  // paragraphs joined (a mark deleted after letters of its paragraph): the joined paragraph keeps the first one's
  // properties, as in Word — the mark that ends it is written again with them (its own character properties kept)
  const papxOf = (cp: number) => {
    const p = d.pieces.find((x) => x.cp <= cp && cp < x.cpEnd)!;
    const r = papxAt(d.wd, d.papx, fcAt(p, cp));
    return r ? Array.from(r.grpprl ?? []).join(",") : null;
  };
  const marks: Edit[] = [];
  let pending: Edit | null = null;
  for (const ed of edits) {
    if (pending && pending.s >= ed.s && pending.s < ed.e) {
      ed.papxMark = pending.papxMark; // (that mark is deleted too: the first paragraph's properties go on)
      pending = null;
    } else if (pending && pending.s < ed.s) marks.push(pending), (pending = null);
    const chained: boolean = ed.papxMark !== undefined;
    const first = d.text.indexOf("\r", ed.s);
    // (doc-para-write: as the pages join them — with the last one's properties its own mark stays; with the first one's
    // also when the edit begins at a paragraph's start, a paragraph left empty joined with the one after it)
    const before = ed.s > 0 ? d.text[ed.s - 1] : "\r";
    if (ed.look || first < 0 || first >= ed.e || ed.join === "end" || before === "\x07" || (ed.join !== "first" && before === "\r")) continue;
    ed.papxMark ??= first;
    const end = d.text.indexOf("\r", ed.e);
    if (end < 0 || d.inField[end] || d.cellMarks.has(end)) throw refuse("special");
    const was = papxOf(ed.papxMark), now = papxOf(end);
    if (was === null || now === null) throw refuse("layout");
    pending = was === now ? null : { s: end, e: end + 1, text: "\r", papxMark: ed.papxMark, chpxCp: end, ...(chained ? {} : { from: ed.e }) };
  }
  if (pending) marks.push(pending);
  // (doc-para-write) the letters of the paragraph a mark written again ends, from another paragraph of another style:
  // written again too, each with the CHPX that keeps its look under the first one's style (as the pages show them) —
  // when they are plain letters no other edit, field, bookmark, note or comment is at
  if (styles)
    for (const m of marks) {
      const from = m.from;
      if (from === undefined || m.papxMark === undefined) continue;
      const to = papxOfCp(m.papxMark), fromP = papxOfCp(m.s);
      if (!to || !fromP) continue;
      const a = istdOf(fromP.grpprl), b = istdOf(to.grpprl);
      if (a === b) continue;
      const cps: number[] = [];
      for (let cp = from; cp <= m.s; cp++) cps.push(cp);
      if (cps.slice(0, -1).some((cp) => !plainChar(d.text.charCodeAt(cp)) || d.inField[cp] || d.cellMarks.has(cp))) continue;
      if (edits.some((ed) => ed.e > from && ed.s <= m.s) || anchoredIn(d, from, m.s)) continue;
      const own = cps.map((cp) => chpxOfCp(cp) ?? new Uint8Array(0));
      const restyled = own.map((g) => styles.restyle(g, a, b));
      if (restyled.some((g) => !g)) continue;
      if (restyled.every((g, k) => g === own[k])) continue;
      m.text = d.text.slice(from, m.s) + "\r";
      m.look = { chpx: restyled.map((g) => (g!.length ? g : null)), papx: [to] };
      m.s = from;
    }
  edits.push(...marks);
  // (letters typed right before a mark written again: the letters first, then the mark)
  edits.sort((x, y) => x.s - y.s || x.e - x.s - (y.e - y.s));
  for (let k = 1; k < edits.length; k++) if (edits[k].s < edits[k - 1].e || (edits[k].s === edits[k - 1].s && (edits[k - 1].e !== edits[k - 1].s || edits[k].e === edits[k].s))) throw refuse("special");
  return edits;
}

/** (doc-para-write) whether a CP table the save moves (fields, bookmarks, notes, comments, sections …) has a CP in (a, b] */
function anchoredIn(d: Doc, a: number, b: number): boolean {
  for (const [i, cb] of MOVED) {
    const lcb = lcbOf(d.wd, d.fib, i), at = fcOf(d.wd, d.fib, i);
    if (!lcb) continue;
    if ((lcb - 4) % (4 + cb) || at + lcb > d.table.length) return true;
    const n = (lcb - 4) / (4 + cb);
    for (let k = 0; k <= n; k++) {
      const cp = u32(d.table, at + k * 4);
      if (cp > a && cp <= b) return true;
    }
  }
  return false;
}

// ───────────────────────── writing ─────────────────────────

/** One run of a formatting page: bytes [from, to) and their properties (null: the defaults), PAPX with its PHE. */
interface Run {
  from: number;
  to: number;
  props: Uint8Array | null;
  phe?: Uint8Array;
}

/** CHPX (`pap` false) or PAPX formatting pages holding `runs` (contiguous); each page 512 bytes. */
function fkpPages(runs: readonly Run[], pap: boolean): { pages: Uint8Array[]; ends: number[] } {
  const pages: Uint8Array[] = [], ends: number[] = [];
  const ent = pap ? 13 : 1, maxRuns = pap ? 0x1d : 0x65;
  const blob = (g: Uint8Array) => {
    if (!pap) return Uint8Array.from([g.length, ...g]);
    return g.length % 2 ? Uint8Array.from([(g.length + 1) / 2, ...g]) : Uint8Array.from([0, g.length / 2, ...g]);
  };
  let i = 0;
  while (i < runs.length) {
    const page = new Uint8Array(512);
    const fcs = [runs[i].from];
    const offs: number[] = [];
    const phes: (Uint8Array | undefined)[] = [];
    const stored = new Map<string, number>();
    let top = 511;
    while (i < runs.length && offs.length < maxRuns) {
      const r = runs[i];
      const key = r.props ? Array.from(r.props).join(",") : "";
      const b = r.props && !stored.has(key) ? blob(r.props) : null;
      const at = b ? (top - b.length) & ~1 : top;
      const crun = offs.length + 1;
      if ((crun + 1) * 4 + crun * ent > at) break;
      if (b) {
        page.set(b, at);
        stored.set(key, at / 2);
        top = at;
      }
      offs.push(r.props ? stored.get(key)! : 0);
      phes.push(r.phe);
      fcs.push(r.to);
      i++;
    }
    if (!offs.length) throw refuse("layout");
    fcs.forEach((fc, k) => put32(page, k * 4, fc));
    const base = fcs.length * 4;
    offs.forEach((o, k) => {
      page[base + k * ent] = o;
      if (pap && phes[k]) page.set(phes[k]!, base + k * ent + 1);
    });
    page[511] = offs.length;
    pages.push(page);
    ends.push(fcs[fcs.length - 1]);
  }
  return { pages, ends };
}

/** The PLC of a Bte with pages added (their first FC is the old last FC). */
function bteWith(old: Bte, ends: readonly number[], pns: readonly number[]): Uint8Array {
  const fcs = [...old.fcs, ...ends], all = [...old.pns, ...pns];
  const out = new Uint8Array(fcs.length * 4 + all.length * 4);
  fcs.forEach((fc, i) => put32(out, i * 4, fc));
  all.forEach((pn, i) => put32(out, fcs.length * 4 + i * 4, pn));
  return out;
}

const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};

/**
 * (doc-compact) Where a save may write the end of WordDocument again: the text and formatting pages an earlier save of
 * ours appended, from `base` (where its text began) — the formatting pages before it stay (`kc` CHPX, `kp` PAPX pages).
 * Found by the shape such a save leaves: the first page after the kept ones starts with the run of default properties
 * writeEdits puts from where the kept pages end to `base`, every later page lies at or after `base`, and every piece of
 * text either lies below where the kept pages end or is a 16-bit piece at or after `base`. Null when there is none (a
 * file as Word wrote it: the save appends as before).
 */
function tailOf(d: Doc): { base: number; kc: number; kp: number } | null {
  const { wd, fib } = d;
  const after = fib.blob + fib.pairs * 8;
  // (pnNext: the FIB of an AutoText document after this one; QA doc-compact — fComplex: Word's own incremental (fast)
  // save was the last one, what it appended is Word's — our saves leave the flag as it was)
  if (u16(wd, 0x08) || u16(wd, 0x0a) & 0x0004 || after + 2 > wd.length) return null;
  const fibEnd = after + 2 + u16(wd, after) * 2;
  const keptOf = (b: Bte, base: number) => {
    let k = 0;
    while (k < b.pns.length && b.pns[k] * 512 + 512 <= base) k++;
    for (let i = k; i < b.pns.length; i++) if (b.pns[i] * 512 < base) return -1;
    return k;
  };
  const gapAt = (b: Bte, k: number, base: number) => {
    if (k < 1 || k >= b.pns.length) return false;
    const page = b.pns[k] * 512;
    if (page + 512 > wd.length) return false;
    const crun = wd[page + 511];
    return crun >= 1 && u32(wd, page) === b.fcs[k] && b.fcs[k] < base && u32(wd, page + 4) === base && wd[page + (crun + 1) * 4] === 0;
  };
  const bases = new Set<number>();
  for (const pn of d.chpx.pns) if (pn * 512 + 512 <= wd.length) bases.add(u32(wd, pn * 512 + 4));
  for (const base of [...bases].sort((x, y) => x - y)) {
    if (base & 1 || base < fibEnd || base >= wd.length) continue;
    const kc = keptOf(d.chpx, base), kp = keptOf(d.papx, base);
    if (kc < 0 || kp < 0 || !gapAt(d.chpx, kc, base) || !gapAt(d.papx, kp, base)) continue;
    const low = Math.min(d.chpx.fcs[kc], d.papx.fcs[kp]);
    if (d.pieces.every((p) => fcAt(p, p.cpEnd) <= low || (!compressed(p) && fcAt(p, p.cp) >= base)) && onlyOurs(d, base, kc, kp)) return { base, kc, kp };
  }
  return null;
}

/**
 * (QA doc-compact) Whether the bytes of WordDocument from `base` on hold nothing but what our saves put there — the text
 * of the pieces at or after `base`, the formatting pages of the Btes after the kept ones (whole, inside the stream), and
 * between them zeros (padding, deleted characters our saves cleared) or the spare character (0x0020) after a piece's
 * text — so writing them again from `base` drops nothing else of the file.
 */
function onlyOurs(d: Doc, base: number, kc: number, kp: number): boolean {
  const { wd } = d;
  const known = new Uint8Array(wd.length - base);
  for (const pn of [...d.chpx.pns.slice(kc), ...d.papx.pns.slice(kp)]) {
    if (pn * 512 < base || pn * 512 + 512 > wd.length) return false;
    known.fill(1, pn * 512 - base, pn * 512 + 512 - base);
  }
  for (const p of d.pieces) if (fcAt(p, p.cp) >= base) known.fill(1, fcAt(p, p.cp) - base, fcAt(p, p.cpEnd) - base);
  for (let o = base; o < wd.length; o++) if (!known[o - base] && wd[o] && !(wd[o] === 0x20 && !((o - base) & 1) && !wd[o + 1])) return false;
  return true;
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null) => (!a || !b ? a === b : a.length === b.length && a.every((x, i) => x === b[i]));

interface Written {
  wd: Uint8Array;
  table: Uint8Array;
  /** where the text written after the old bytes begins */
  base: number;
}

/**
 * WordDocument and the table stream with `edits` written (see the top of this file). `compact` (doc-compact): the text
 * and formatting pages an earlier save appended (tailOf) are written again from where they began — the text still in
 * the document with the look it had, next to the new text, the rest left out — and the structures an earlier save
 * appended at the table stream's end (Clx, PlcBteChpx / Papx, SttbfAssoc) in their place; null when there are none.
 */
function writeEdits(d: Doc, edits: readonly Edit[], compact = false): Written | null {
  const { wd, fib, text } = d;
  // every non-empty CP table of the file must be one known here
  for (let i = 0; i < fib.pairs; i++) if (lcbOf(wd, fib, i) && !MOVED.has(i) && !DROPPED.has(i) && !KEPT.has(i)) throw refuse("layout");
  const tail = compact ? tailOf(d) : null;
  if (compact && !tail) return null;
  const pieceOf = (cp: number) => d.pieces.find((p) => p.cp <= cp && cp < p.cpEnd)!;
  const isLetter = (cp: number) => cp >= 0 && cp < d.ccpText && plainChar(text.charCodeAt(cp)) && (!d.inField[cp] || d.result[cp] > 0);
  const letterChpx = (cp: number) => {
    const g = chpxAt(wd, d.chpx, fcAt(pieceOf(cp), cp));
    const sprms = g && sprmsOf(g, 0);
    return g && sprms && !sprms.some((s) => NOT_LETTER.has(s)) ? g : null;
  };
  /** (compact) whether a piece's text is written again: it is in the text an earlier save appended */
  const moves = (p: Piece) => !!tail && fcAt(p, p.cp) >= tail.base;
  const keptOf = (b: Bte, k: number): Bte => ({ fcs: b.fcs.slice(0, k + 1), pns: b.pns.slice(0, k) });
  const oldChpx = tail ? keptOf(d.chpx, tail.kc) : d.chpx, oldPapx = tail ? keptOf(d.papx, tail.kp) : d.papx;
  // where the new text goes: after the old text, its formatting pages and anything the old pages cover (compact: where
  // the text an earlier save appended began)
  const lastChp = oldChpx.fcs[oldChpx.fcs.length - 1], lastPap = oldPapx.fcs[oldPapx.fcs.length - 1];
  let fc = tail ? tail.base : Math.max(wd.length, lastChp, lastPap);
  fc += fc & 1;
  const textStart = fc;
  const chunks: Uint8Array[] = [];
  const chpRuns: Run[] = [], papRuns: Run[] = [];

  // the piece table: the old pieces cut around the edits, the new pieces in their places
  const total = d.pieces[d.pieces.length - 1].cpEnd;
  const pieces: Piece[] = [];
  let cpNow = 0;
  const add = (flags: number, fcField: number, prm: number, len: number) => {
    if (len <= 0) return;
    const prev = pieces[pieces.length - 1];
    if (prev && prev.flags === flags && prev.prm === prm && (prev.fc & 0x40000000) === (fcField & 0x40000000) && (prev.fc & 0x3fffffff) + (prev.cpEnd - prev.cp) * 2 === (fcField & 0x3fffffff)) prev.cpEnd += len;
    else pieces.push({ cp: cpNow, cpEnd: cpNow + len, flags, fc: fcField, prm });
    cpNow += len;
  };
  // the text written after the old bytes, piece by piece (compact: pieces next to each other with the same flags and
  // prm as one), each run of it followed by one spare character
  let open: { flags: number; prm: number; papFrom: number } | null = null;
  const close = () => {
    if (!open) return;
    chunks.push(Uint8Array.of(0x20, 0)); // the spare character after the piece's text
    chpRuns[chpRuns.length - 1].to += 2;
    papRuns.push({ from: open.papFrom, to: fc + 2, props: null });
    fc += 2;
    open = null;
  };
  const pushChp = (from: number, to: number, props: Uint8Array | null) => {
    const last = chpRuns[chpRuns.length - 1];
    if (tail && last && last.to === from && sameBytes(last.props, props)) last.to = to;
    else chpRuns.push({ from, to, props });
  };
  /** 16-bit text as the next piece: its character runs (lengths in bytes) and its paragraph ends (bytes after a mark) */
  const emit = (bytes: Uint8Array, flags: number, prm: number, chp: readonly { len: number; props: Uint8Array | null }[], ends: readonly { at: number; props: Uint8Array | null; phe?: Uint8Array }[]) => {
    if (open && (open.flags !== flags || open.prm !== prm)) close();
    const o = (open ??= { flags, prm, papFrom: fc });
    const start = fc;
    chunks.push(bytes);
    let at = start;
    for (const r of chp) pushChp(at, at + r.len, r.props), (at += r.len);
    for (const e of ends) papRuns.push({ from: o.papFrom, to: start + e.at, props: e.props, phe: e.phe }), (o.papFrom = start + e.at);
    fc = start + bytes.length;
    add(flags, start, prm, bytes.length / 2);
    if (!tail) close();
  };
  /** (compact) the CPs [a, b) of a piece an earlier save appended, written again with their character runs and
   *  paragraph ends */
  const relocate = (p: Piece, a: number, b: number) => {
    const f0 = fcAt(p, a), f1 = fcAt(p, b);
    const chp: { len: number; props: Uint8Array | null }[] = [];
    let pos = f0;
    for (const r of runsIn(wd, d.chpx, f0, f1, false)) {
      const to = Math.min(r.lim, f1);
      chp.push({ len: to - pos, props: r.props });
      pos = to;
    }
    const ends = runsIn(wd, d.papx, f0, f1, true)
      .filter((r) => r.lim <= f1)
      .map((r) => ({ at: r.lim - f0, props: r.props, phe: r.phe }));
    emit(wd.slice(f0, f1), p.flags, p.prm, chp, ends);
  };
  const keep = (from: number, to: number) => {
    for (const p of d.pieces) {
      const a = Math.max(from, p.cp), b = Math.min(to, p.cpEnd);
      if (a >= b) continue;
      if (moves(p)) relocate(p, a, b);
      // (FcCompressed: both kinds of piece move by two per CP)
      else close(), add(p.flags, p.fc + (a - p.cp) * 2, p.prm, b - a);
    }
  };
  let at = 0;
  for (const ed of edits) {
    keep(at, ed.s);
    at = ed.e;
    if (!ed.text) continue;
    // the look of the letter before (not a mark or other special character), else the letter after, else the mark
    // (doc-write3: in a cell, the cell's mark)
    const mark = ed.papxMark ?? nextMark(text, ed.e);
    if (mark < 0) throw refuse("special");
    if (ed.look) {
      // (doc-para-write) properties given: each unit's CHPX, each mark's PAPX (no property modifier of a fast save on
      // the pieces it is written next to — it would apply to the new text too)
      const near = pieceOf(Math.min(ed.s, total - 1));
      if (near.prm || pieceOf(mark).prm) throw refuse("layout");
      const bytes = new Uint8Array(ed.text.length * 2);
      const chp: { len: number; props: Uint8Array | null }[] = [];
      const ends: { at: number; props: Uint8Array | null; phe?: Uint8Array }[] = [];
      let m = 0;
      for (let k = 0; k < ed.text.length; k++) {
        put16(bytes, k * 2, ed.text.charCodeAt(k));
        const g = ed.look.chpx[k] ?? null;
        const last = chp[chp.length - 1];
        if (last && sameBytes(last.props, g)) last.len += 2;
        else chp.push({ len: 2, props: g });
        if (ed.text[k] === "\r") {
          const p = ed.look.papx[m++];
          if (!p) throw refuse("layout");
          ends.push({ at: (k + 1) * 2, props: p.grpprl, phe: p.phe });
        }
      }
      emit(bytes, near.flags & ~1, 0, chp, ends);
      continue;
    }
    let src = -1;
    let chp: Uint8Array | null = null;
    // (2026-11-17: the letter before as the editor shows it — over a field's end and code, back to its result's last
    // letter: letters typed right after a hyperlink look like it, as on the screen)
    let before = ed.s - 1;
    while (before >= 0 && (/[\x13\x14\x15]/.test(text[before]) || (d.inField[before] && !d.result[before] && !/[\r\x07]/.test(text[before])))) before--;
    for (const cp of ed.chpxCp !== undefined ? [ed.chpxCp] : [before, ed.e, mark]) {
      if (cp !== mark && cp !== ed.chpxCp && !isLetter(cp)) continue;
      if ((chp = letterChpx(cp))) {
        src = cp;
        break;
      }
    }
    if (!chp) throw refuse("special");
    const piece = pieceOf(src);
    let pap: ReturnType<typeof papxAt> = null;
    if (ed.text.includes("\r")) {
      if (d.cellMarks.has(mark) || d.inField[mark]) throw refuse("special");
      pap = papxAt(wd, d.papx, fcAt(pieceOf(mark), mark));
      // (a fast save's property change on the mark's piece must be the one the new piece carries)
      if (!pap || pieceOf(mark).prm !== piece.prm) throw refuse("layout");
    }
    const bytes = new Uint8Array(ed.text.length * 2);
    const ends: { at: number; props: Uint8Array | null; phe?: Uint8Array }[] = [];
    for (let k = 0; k < ed.text.length; k++) {
      put16(bytes, k * 2, ed.text.charCodeAt(k));
      if (ed.text[k] === "\r") ends.push({ at: (k + 1) * 2, props: pap!.grpprl, phe: pap!.phe });
    }
    emit(bytes, piece.flags & ~1, piece.prm, [{ len: bytes.length, props: chp.length ? chp : null }], ends);
  }
  keep(at, total);
  close();
  const delta = edits.reduce((n, ed) => n + ed.text.length - (ed.e - ed.s), 0);
  if (cpNow !== total + delta) throw refuse("layout");

  // the formatting pages: one run of default properties from where the old pages end to the new text, then the new text
  const pagesOf = (runs: Run[], last: number, pap: boolean) => {
    if (!runs.length) return { pages: [], ends: [] };
    if (last < runs[0].from) runs.unshift({ from: last, to: runs[0].from, props: null });
    return fkpPages(runs, pap);
  };
  const chp = pagesOf(chpRuns, lastChp, false), pap = pagesOf(papRuns, lastPap, true);
  const textBytes = concat(chunks);
  const pagesAt = Math.ceil((textStart + textBytes.length) / 512) * 512;
  const out = new Uint8Array(pagesAt + (chp.pages.length + pap.pages.length) * 512);
  out.set(tail ? wd.subarray(0, tail.base) : wd);
  // (QA doc-write2: the deleted characters' old bytes are cleared — no piece holds them any more, and text the user
  // deleted must not stay readable in the file, as it did after Word's own fast saves; compact: the text an earlier save
  // appended is not copied at all)
  for (const ed of edits)
    for (const p of d.pieces) {
      const a = Math.max(ed.s, p.cp), b = Math.min(ed.e, p.cpEnd);
      if (a < b && !moves(p)) out.fill(0, fcAt(p, a), fcAt(p, b));
    }
  out.set(textBytes, textStart);
  [...chp.pages, ...pap.pages].forEach((p, k) => out.set(p, pagesAt + k * 512));
  const pn0 = pagesAt / 512;
  const chpPns = chp.pages.map((_, k) => pn0 + k), papPns = pap.pages.map((_, k) => pn0 + chp.pages.length + k);

  const plcPcd = new Uint8Array((pieces.length + 1) * 4 + pieces.length * 8);
  pieces.forEach((p, i) => {
    put32(plcPcd, i * 4, p.cp);
    const pcd = (pieces.length + 1) * 4 + i * 8;
    put16(plcPcd, pcd, p.flags);
    put32(plcPcd, pcd + 2, p.fc);
    put16(plcPcd, pcd + 6, p.prm);
  });
  put32(plcPcd, pieces.length * 4, cpNow);
  const pcdt = new Uint8Array(5);
  pcdt[0] = 0x02;
  put32(pcdt, 1, plcPcd.length);
  const clx = concat([d.prc, pcdt, plcPcd]);

  // the table stream: CP tables moved in their place, the new Clx and Btes after the old bytes
  const table = d.table.slice();
  // (a CP that marks a character moves with it; a CP that stays where text is typed at it: a section's first CP (the
  // text is in the section), a bookmark's start and end (QA doc-write2, as Word: text typed at a bookmark's start is in
  // it, at its end not, at an empty bookmark after it), a comment range's end (text typed there is not in the range;
  // at its start the range's start moves on, also as Word)
  const move = (cp: number, starts: boolean) => {
    let dlt = 0;
    for (const ed of edits) {
      if (cp < ed.s || (starts && cp === ed.s && ed.s === ed.e)) break;
      if (cp >= ed.e) {
        dlt += ed.text.length - (ed.e - ed.s);
        continue;
      }
      return ed.s + dlt; // inside deleted text: where it was
    }
    return cp + dlt;
  };
  for (const [i, cb] of MOVED) {
    const lcb = lcbOf(wd, fib, i), at = fcOf(wd, fib, i);
    if (!lcb) continue;
    if ((lcb - 4) % (4 + cb) || at + lcb > table.length) throw refuse("layout");
    const n = (lcb - 4) / (4 + cb);
    // (doc-write3) a field whose result was edited: its end's grffldEnd gets fResultDirty and fResultEdited, as Word sets
    // them when the result is typed in (measured: Word 16, a QUOTE field's result edited — 0x80 → 0x8C)
    if (i === FIELDS) {
      const edited = new Set(edits.flatMap((ed) => (ed.field !== undefined ? [ed.field] : [])));
      const open: number[] = [];
      for (let k = 0; k < n && edited.size; k++) {
        const fld = at + (n + 1) * 4 + k * 2;
        const ch = table[fld] & 0x1f;
        if (ch === 0x13) open.push(u32(table, at + k * 4));
        else if (ch === 0x15 && edited.has(open.pop()!)) table[fld + 1] |= 0x0c;
      }
    }
    for (let k = 0; k <= n; k++) put32(table, at + k * 4, move(u32(table, at + k * 4), STAYS.has(i) && k < n));
  }
  // (compact) the structures an earlier save appended at the table stream's end, one after another (a byte of padding
  // between them) with nothing else of the file after them: written again from where they began
  let cut = table.length;
  const again: number[] = [];
  if (tail) {
    const regs = [CLX, CHPX, PAPX, ASSOC]
      .filter((i) => lcbOf(wd, fib, i))
      .map((i) => ({ i, fc: fcOf(wd, fib, i), end: fcOf(wd, fib, i) + lcbOf(wd, fib, i) }))
      .sort((x, y) => y.fc - x.fc);
    for (const r of regs) {
      if (r.end > cut || cut - r.end > 1 || table.subarray(r.end, cut).some((x) => x)) break;
      cut = r.fc;
      again.push(r.i);
    }
    // (a pair whose fc is past the stream's end holds no structure of it — some files have such values in pairs Word
    // does not use)
    for (let i = 0; i < fib.pairs; i++)
      if (lcbOf(wd, fib, i) && !again.includes(i) && fcOf(wd, fib, i) < table.length && fcOf(wd, fib, i) + lcbOf(wd, fib, i) > cut) {
        cut = table.length;
        again.length = 0;
        break;
      }
  }
  const extra: Uint8Array[] = [];
  let tableLen = cut;
  const append = (b: Uint8Array) => {
    if (tableLen & 1) extra.push(new Uint8Array(1)), tableLen++;
    const fcNew = tableLen;
    extra.push(b);
    tableLen += b.length;
    return fcNew;
  };
  const setPair = (i: number, fcv: number, lcb: number) => {
    put32(out, fib.blob + i * 8, fcv);
    put32(out, fib.blob + i * 8 + 4, lcb);
  };
  setPair(CLX, append(clx), clx.length);
  // (compact: the pages an earlier save appended are left out of the Btes too)
  if (chp.pages.length || tail) {
    const b = bteWith(oldChpx, chp.ends, chpPns);
    setPair(CHPX, append(b), b.length);
  }
  if (pap.pages.length || tail) {
    const b = bteWith(oldPapx, pap.ends, papPns);
    setPair(PAPX, append(b), b.length);
  }
  if (again.includes(ASSOC)) {
    const a = fcOf(wd, fib, ASSOC), l = lcbOf(wd, fib, ASSOC);
    setPair(ASSOC, append(d.table.slice(a, a + l)), l);
  }
  for (const i of DROPPED) if (i < fib.pairs && lcbOf(wd, fib, i)) put32(out, fib.blob + i * 8 + 4, 0);
  put32(out, fib.lw + LW_CCPTEXT * 4, d.ccpText + delta);
  put32(out, fib.lw + LW_CBMAC * 4, out.length);
  return { wd: out, table: concat([table.subarray(0, cut), ...extra]), base: textStart };
}

/**
 * (doc-compact) Whether a compacted write holds the same document as the write that appends: by CP the same text, the
 * same piece flags and prm, the same character properties, the same paragraph ends with the same PAPX and PHE; the
 * same FIB (but where the Clx, the Btes and SttbfAssoc are, and cbMac), the same bytes of WordDocument before the
 * compacted text, the same Prc and the same other structures of the table stream.
 */
function sameWritten(d: Doc, a: Written, b: Written): boolean {
  const ids = new Map<string, number>();
  const id = (k: string) => {
    let v = ids.get(k);
    if (v === undefined) ids.set(k, (v = ids.size));
    return v;
  };
  const view = (w: Written) => {
    const r = readDoc(w.wd, (n) => (n === d.tableName ? w.table : n === "Data" ? d.data : undefined));
    const n = r.pieces[r.pieces.length - 1].cpEnd;
    const ch = new Int32Array(n), pc = new Int32Array(n), cx = new Int32Array(n), pe = new Int32Array(n).fill(-1);
    for (const p of r.pieces) {
      const step = compressed(p) ? 1 : 2, f0 = fcAt(p, p.cp), f1 = fcAt(p, p.cpEnd);
      const k = id(`${p.flags},${p.prm},${step}`);
      const runs = runsIn(r.wd, r.chpx, f0, f1, false).map((x) => ({ lim: x.lim, v: id(x.props ? x.props.join(",") : "") }));
      let j = 0;
      for (let cp = p.cp; cp < p.cpEnd; cp++) {
        const f = f0 + (cp - p.cp) * step;
        pc[cp] = k;
        ch[cp] = step === 1 ? r.wd[f] : u16(r.wd, f);
        while (runs[j].lim <= f) j++;
        cx[cp] = runs[j].v;
      }
      for (const x of runsIn(r.wd, r.papx, f0, f1, true)) if (x.lim <= f1) pe[p.cp + (x.lim - f0) / step - 1] = id(`${x.props ? x.props.join(",") : "-"}|${x.phe ? x.phe.join(",") : ""}`);
    }
    return { r, arrays: [ch, pc, cx, pe] };
  };
  const va = view(a), vb = view(b);
  const same = (x: ArrayLike<number>, y: ArrayLike<number>) => x.length === y.length && Array.prototype.every.call(x, (v: number, i: number) => v === y[i]);
  if (!va.arrays.every((x, i) => same(x, vb.arrays[i])) || va.r.ccpText !== vb.r.ccpText || !same(va.r.prc, vb.r.prc)) return false;
  const { fib } = d;
  const after = fib.blob + fib.pairs * 8, fibEnd = after + 2 + u16(d.wd, after) * 2;
  // (the FIB's bytes that may differ: cbMac, and the fc / lcb pairs of the Clx, the Btes and SttbfAssoc)
  const mayDiffer = new Set<number>();
  for (const o of [fib.lw + LW_CBMAC * 4, ...[CLX, CHPX, PAPX, ASSOC].flatMap((i) => [fib.blob + i * 8, fib.blob + i * 8 + 4])]) for (let k = 0; k < 4; k++) mayDiffer.add(o + k);
  for (let o = 0; o < fibEnd; o++) if (!mayDiffer.has(o) && a.wd[o] !== b.wd[o]) return false;
  if (b.base > a.wd.length || !same(a.wd.subarray(fibEnd, b.base), b.wd.subarray(fibEnd, b.base))) return false;
  for (let i = 0; i < fib.pairs; i++) {
    if (i === CLX || i === CHPX || i === PAPX) continue;
    const la = lcbOf(a.wd, fib, i), fa = fcOf(a.wd, fib, i), fb = fcOf(b.wd, fib, i);
    if (la !== lcbOf(b.wd, fib, i) || (la && !same(a.table.subarray(fa, fa + la), b.table.subarray(fb, fb + la)))) return false;
  }
  return true;
}

/** SttbfAssoc ([MS-DOC] SttbfAssoc, FibRgFcLcb97 fcSttbfAssoc): strings Word keeps with the document — the template, and copies of the summary's
 *  title (ibstAssocTitle), subject, keywords, comments, authors */
const ASSOC = 32, ASSOC_TITLE = 2;

/**
 * The table stream with SttbfAssoc's copy of the title `title.was` made `title.now` (QA doc-summary: the copy of a title
 * Word took from the first line); written in its place when it fits (the bytes after it cleared), else after the table
 * stream's bytes with the old ones cleared — the FIB's pair in `wd` set. Null when there is no such copy.
 */
function assocRetitled(wd: Uint8Array, table: Uint8Array, fib: Fib, title: { was: string; now: string }): Uint8Array | null {
  const fc = fcOf(wd, fib, ASSOC), lcb = lcbOf(wd, fib, ASSOC);
  if (lcb < 6 || fc + lcb > table.length || u16(table, fc) !== 0xffff || u16(table, fc + 4) !== 0) return null;
  const n = u16(table, fc + 2), end = fc + lcb;
  const strs: string[] = [];
  let o = fc + 6;
  for (let i = 0; i < n; i++) {
    if (o + 2 > end) return null;
    const c = u16(table, o);
    if (o + 2 + c * 2 > end) return null;
    let s = "";
    for (let k = 0; k < c; k++) s += String.fromCharCode(u16(table, o + 2 + k * 2));
    strs.push(s);
    o += 2 + c * 2;
  }
  if (o !== end || n <= ASSOC_TITLE || strs[ASSOC_TITLE].trim() !== title.was) return null;
  strs[ASSOC_TITLE] = title.now;
  const sttb = new Uint8Array(6 + strs.reduce((m, s) => m + 2 + s.length * 2, 0));
  put16(sttb, 0, 0xffff);
  put16(sttb, 2, n);
  o = 6;
  for (const s of strs) {
    put16(sttb, o, s.length);
    for (let k = 0; k < s.length; k++) put16(sttb, o + 2 + k * 2, s.charCodeAt(k));
    o += 2 + s.length * 2;
  }
  let out = table.slice();
  out.fill(0, fc, end);
  let at = fc;
  if (sttb.length > lcb) {
    at = out.length + (out.length & 1);
    out = concat([out, new Uint8Array(at - out.length), sttb]);
  } else out.set(sttb, fc);
  put32(wd, fib.blob + ASSOC * 8, at);
  put32(wd, fib.blob + ASSOC * 8 + 4, sttb.length);
  return out;
}

// ───────────────────────── save ─────────────────────────

const streamNode = (root: CfbNode, name: string) => root.kids?.find((k) => k.kind === "stream" && k.name === name);

/**
 * The .doc with the body text edited in `pages` written into it (the original when the text is as opened). Throws
 * DocRefused (advice: save as DOCX) for an edit this stage does not write.
 */
export function saveDocText(pages: readonly Page[], orig: Uint8Array, legacy: { name: string; fp: string }): Uint8Array {
  const tree = readCfbTree(orig);
  const wdNode = streamNode(tree.root, "WordDocument");
  if (!wdNode?.data) throw refuse("layout");
  let d = readDoc(wdNode.data, (n) => streamNode(tree.root, n)?.data);
  // the file reads as it did when it was opened: the same paragraphs and tables, the same pages
  let r = docText(orig);
  if (JSON.stringify(blocksOf(d)) !== JSON.stringify(r.blocks)) throw refuse("reader");
  /** (QA doc-rich-open) the pages are of the reading before 2026-11-17 (a .omw saved then): read and checked so here */
  let guess = false;
  // the pages as opened: with the formatting (docRich.ts, 2026-11-17), else as text only (a file that does not read so,
  // a document opened before) — whichever has the fingerprint taken at open
  let opened: { pages: Page[]; cellMap?: number[][][] } | null = null;
  try {
    const rich = docRichOpen(orig, legacy.name);
    if (legacyFingerprint("doc", rich.pages) === legacy.fp) opened = rich;
  } catch {
    opened = null;
  }
  if (!opened) {
    const plain = flowLegacyPages(r, legacy.name, "doc");
    if (legacyFingerprint("doc", plain) === legacy.fp) opened = { pages: plain };
  }
  if (!opened) {
    // (QA doc-rich-open: a .omw saved before 2026-11-17 holds the text pages of the reading of then — rows and cells'
    // lines guessed from the text; where the reading now differs, its text edits were refused: written by that reading)
    const r0 = docText(orig, true);
    const plain = flowLegacyPages(r0, legacy.name, "doc");
    if (legacyFingerprint("doc", plain) === legacy.fp) {
      const d0 = readDoc(wdNode.data, (n) => streamNode(tree.root, n)?.data, true);
      if (JSON.stringify(blocksOf(d0)) !== JSON.stringify(r0.blocks)) throw refuse("reader");
      (d = d0), (r = r0), (guess = true), (opened = { pages: plain });
    }
  }
  if (!opened) throw refuse("reader");
  const was = collectFlow(opened.pages);
  if (was.length !== r.blocks.length || was.some((it, i) => (it.kind === "p") !== (r.blocks[i].kind === "para"))) throw refuse("reader");
  const cellMap = opened.cellMap;
  const items = collectFlow(fresh(pages) as Page[]);
  // what the save writes is the text: the paragraphs' and letters' formats must be the file's — docShape leaves them out
  // (2026-11-17), a format changed is refused here as any other edit that is not text (save as DOCX)
  const rich = !!opened.cellMap;
  // (doc-para-write) opened with the formatting: paragraphs added or joined as the pages have them (textEdits)
  /** the pictures each paragraph holds (by its id) — an empty paragraph with one is not like one without */
  const picsOf = (ps: readonly Page[]) => {
    const m = new Map<string, number>();
    for (const pg of ps)
      for (const n of pg.nodes) {
        const para = n.type === "IMAGE" ? (n as { place?: { para?: string } }).place?.para : undefined;
        if (para) m.set(para, (m.get(para) ?? 0) + 1);
      }
    return m;
  };
  const edits = textEdits(d, items, cellMap, rich ? was : undefined, rich ? docStyleTools(d.table, fcOf(d.wd, d.fib, 1), lcbOf(d.wd, d.fib, 1)) : null, rich ? { was: picsOf(opened.pages), now: picsOf(pages) } : undefined);
  if (!edits.length) {
    if (!sameLooks(opened.pages, pages)) throw new Error(t("legacysave.err.edited.doc"));
    return orig;
  }
  let w = writeEdits(d, edits)!;
  // (doc-compact) a file an earlier save of ours appended to: that text and its pages written again from where they
  // began, so a file saved again and again does not grow — when it holds the same document as the append above (else
  // the save appends, as before)
  try {
    const c = writeEdits(d, edits, true);
    if (c && sameWritten(d, w, c)) w = c;
  } catch {
    // (the save as before)
  }
  wdNode.data = w.wd;
  streamNode(tree.root, d.tableName)!.data = w.table;
  // (QA doc-summary) the summaries: a title Word took from the first line (Word up to 2003 did, in SummaryInformation
  // and the DocumentSummaryInformation parts) taken again from the first line now when the edit changed it; the picture
  // of the first page left out (which text is on the first page is not known here; Word makes it again on its next
  // save when "save preview picture" is on). Every other property keeps its bytes (oleSummary.ts retitleText).
  const firstOf = (texts: readonly string[]) => texts.find((x) => x.trim()) ?? "";
  const siNode = streamNode(tree.root, "\u0005SummaryInformation"), dsiNode = streamNode(tree.root, "\u0005DocumentSummaryInformation");
  const sum = retitleText(
    { si: siNode?.data, dsi: dsiNode?.data },
    firstOf(r.blocks.flatMap((b) => (b.kind === "para" ? [b.text] : b.kind === "table" ? b.rows.flat() : []))),
    firstOf(items.flatMap((it, k) => (it.kind === "p" ? [docParaText(it.p)] : fileRows(it.t.rows, tableIndex(items, k), cellMap).flat()))),
    true,
  );
  if (sum.si && siNode) siNode.data = sum.si;
  if (sum.dsi && dsiNode) dsiNode.data = sum.dsi;
  // (Word keeps a copy of the title in the table stream too: SttbfAssoc)
  const assoc = sum.title && assocRetitled(w.wd, w.table, d.fib, sum.title);
  if (assoc) streamNode(tree.root, d.tableName)!.data = w.table = assoc;
  const out = writeCfb(tree);
  // read back: the text is the one edited, and the file is one the stage-1 save keeps
  // (doc-write3: the tables with their cells as edited)
  // (as many cells in each row as the reader found: the flow fills short rows)
  const tables = r.blocks.flatMap((b) => (b.kind === "table" ? [b.rows] : []));
  let k = 0;
  const expect: LegacyText["blocks"] = items.map((it) => {
    if (it.kind === "p") return { kind: "para", text: docParaText(it.p) };
    const ti = k++;
    const shape = tables[ti];
    return { kind: "table", rows: fileRows(it.t.rows, ti, cellMap).map((row, i) => row.slice(0, shape[i].length)) };
  });
  let back: LegacyText["blocks"];
  let fieldsOk = true;
  try {
    back = docText(out, guess).blocks;
    const d2 = readDoc(w.wd, (n) => (n === d.tableName ? w.table : n === "Data" ? d.data : undefined), guess);
    // (doc-write3) every field mark the PlcfFld names is still that mark (when it was so in the file as opened)
    fieldsOk = !fieldMarksOk(d) || fieldMarksOk(d2);
  } catch {
    throw refuse("verify");
  }
  if (!fieldsOk || JSON.stringify(back) !== JSON.stringify(expect) || !legacyKeepable("doc", out)) throw refuse("verify");
  // the written file opened again (as it was opened: with the formatting, or as text) shows the pages as they are: each
  // paragraph's and letter's format (new letters take the letter's before them, a new paragraph the one's it was cut
  // from — as the editor gave them, or the edit is not only text)
  let again: Page[];
  try {
    again = rich ? docRichOpen(out, legacy.name).pages : flowLegacyPages(docText(out, guess), legacy.name, "doc");
  } catch {
    throw refuse("verify");
  }
  // (a floating picture: where the pages have it, as opened — the file keeps it with its paragraph, which the text
  // edits may move; the pages do not move it, so it is compared with the open, not with the file written)
  if (!sameLooks(again, pages, false) || !sameLooks(opened.pages, pages, true, true)) throw new Error(t("legacysave.err.edited.doc"));
  // (QA docx-flow) and its page breaks before the same items: letters typed next to a page break could move it to the
  // other side of their paragraph, which neither the text nor the looks show
  if (JSON.stringify(hardBreaks(again)) !== JSON.stringify(hardBreaks(pages))) throw refuse("verify");
  return out;
}

/** The body items (collectFlow) each run of pages after the first starts at: where the hard page and section breaks are. */
function hardBreaks(pages: readonly Page[]): number[] {
  const out: number[] = [];
  let n = 0;
  for (const s of segments(pages)) {
    if (s.start > 0) out.push(n);
    n += collectFlow(pages.slice(s.start, s.end)).length;
  }
  return out;
}

/**
 * What the pages show of the body beyond its text, item by item (pages of docRich.ts): each paragraph's format (but the
 * line spacing it was read as — a multiple of the size taken from its text — and the text of its list number) and the
 * format of each of its letters (an empty paragraph: of its mark); each table's and cell's settings; the pictures, with
 * the paragraph each follows. (Exported for the tests: a saved file read again shows the pages as they were.)
 */
export function docLooks(pages: readonly Page[], floatsAt = true, floatsOnly = false): string[] {
  const ps = fresh(pages) as Page[];
  const flow = collectFlow(ps);
  const out: string[] = [];
  const paraAt = new Map<string, number>();
  flow.forEach((it, i) => it.kind === "p" && paraAt.set(it.p.id, i));
  for (const it of floatsOnly ? [] : flow) {
    if (it.kind === "table") {
      out.push("T" + canon({ ...without(it.t, ["id", "transform", "flowCont", "name"]), rows: it.t.rows.map((r) => r.map((c) => without(c, ["text", "richText"]))) }, FLOW_PLACE));
      continue;
    }
    const p = it.p;
    // (QA doc-rich-open: whether its number is shown too — letters typed into the number, or the number deleted with
    // letters after it, were written as the paragraph's letters while the file kept its number: paraLook)
    let skip = markerLength(p);
    const letters: [string, number][] = [];
    for (const r of p.runs) {
      let n = r.text.length;
      if (skip) {
        const k = Math.min(skip, n);
        n -= k;
        skip -= k;
      }
      if (!n && !r.note && !r.obj) continue;
      const k = canon(without(r, ["text"]), FLOW_PLACE);
      const last = letters[letters.length - 1];
      if (last && last[0] === k) last[1] += n;
      else letters.push([k, n]);
    }
    if (!letters.length && p.runs[0]) letters.push([canon(without(p.runs[0], ["text"]), FLOW_PLACE), 0]);
    out.push("P" + paraLook(p) + JSON.stringify(letters));
  }
  const pics: string[] = [];
  for (const pg of ps)
    for (const n of pg.nodes)
      if (n.type === "IMAGE") {
        const place = (n as { place?: { mode?: string; para?: string } }).place;
        // (a floating picture: where it is too — the flow puts one anchored in a paragraph with that paragraph)
        if (floatsOnly && place?.mode !== "float") continue;
        const at = place?.mode === "float" && floatsAt ? [Math.round(n.transform.x * 10) / 10, Math.round(n.transform.y * 10) / 10] : null;
        // (of a picture in the line, not the letters before it in its paragraph: the pages do not move it as letters are
        // typed — it is drawn after its paragraph — and the file counts them anew)
        // (doc-pic-para: `floatsOnly` — where it is drawn, as opened; not the letters before its anchor, which follow the
        // text edited as in Word)
        pics.push("I" + canon({ ...without(n, ["id", "transform", "place"]), place: place ? without(place, place.mode === "inline" || floatsOnly ? ["para", "offset"] : ["para"]) : null, para: place?.para && !floatsOnly ? paraAt.get(place.para) ?? -1 : null, at }));
      }
  // (doc-pic-para: in no order — the open lays a floating picture out before or after the body's first frame by the
  // paragraph it is anchored in; which paragraph is in each entry)
  return [...out, ...pics.sort()];
}

/** whether two pages show the body alike beyond its text (docLooks; `floatsAt`: floating pictures where they are too,
 *  `floatsOnly`: those alone) */
const sameLooks = (a: readonly Page[], b: readonly Page[], floatsAt = true, floatsOnly = false) => JSON.stringify(docLooks(a, floatsAt, floatsOnly)) === JSON.stringify(docLooks(b, floatsAt, floatsOnly));

/** Whether each entry of the main document's PlcfFld is at a character that is its field mark (0x13, 0x14, 0x15). */
function fieldMarksOk(d: Doc): boolean {
  const lcb = lcbOf(d.wd, d.fib, FIELDS), at = fcOf(d.wd, d.fib, FIELDS);
  if (!lcb) return true;
  if ((lcb - 4) % 6 || at + lcb > d.table.length) return false;
  const n = (lcb - 4) / 6;
  for (let k = 0; k < n; k++) if (d.text.charCodeAt(u32(d.table, at + k * 4)) !== (d.table[at + (n + 1) * 4 + k * 2] & 0x1f)) return false;
  return true;
}

/**
 * Read aid (tests): a .doc's main text by CP, the CHPX of a CP, and the paragraph a CP is in as Word finds it
 * ([MS-DOC] 2.4.2: the PAPX run holding the CP's FC; a run that goes past its piece goes on in the next piece) — its
 * mark's CP and PAPX (null: default properties).
 */
export function docProps(file: Uint8Array) {
  const tree = readCfbTree(file);
  const wd = streamNode(tree.root, "WordDocument")!.data!;
  const d = readDoc(wd, (n) => streamNode(tree.root, n)?.data);
  const pieceAt = (cp: number) => d.pieces.findIndex((p) => p.cp <= cp && cp < p.cpEnd);
  const para = (cp: number): { mark: number; papx: Uint8Array | null } | null => {
    for (let i = pieceAt(cp), fc = fcAt(d.pieces[i], cp); i >= 0 && i < d.pieces.length; i++, fc = i < d.pieces.length ? fcAt(d.pieces[i], d.pieces[i].cp) : 0) {
      const p = d.pieces[i];
      const r = fkpRun(wd, d.papx, fc);
      if (!r) return null;
      const lim = u32(wd, r.page + (r.j + 1) * 4);
      const end = fcAt(p, p.cpEnd);
      if (lim <= end) {
        const mark = p.cp + (lim - fcAt(p, p.cp)) / (compressed(p) ? 1 : 2) - 1;
        return { mark, papx: papxAt(wd, d.papx, fcAt(p, mark))?.grpprl ?? null };
      }
    }
    return null;
  };
  return { text: d.text, pieces: d.pieces.length, chpx: (cp: number) => chpxAt(wd, d.chpx, fcAt(d.pieces[pieceAt(cp)], cp)), para };
}
