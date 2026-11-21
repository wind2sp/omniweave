// Legacy binary office formats — read-only, text (and table) extraction from public specifications:
//   DOC  [MS-DOC]  : FIB → piece table (Clx/PlcPcd) → text
//   XLS  [MS-XLS]  : BIFF8 workbook stream → shared strings + cell records → tables
//   PPT  [MS-PPT]  : record tree → TextCharsAtom / TextBytesAtom grouped per slide
//   HWP  HWP 5.0 문서 형식(한글과컴퓨터 공개) : FileHeader → BodyText/Section* (raw deflate) → PARA_TEXT, tables
// Layout, images and styling are not reconstructed here; users are told to save as DOCX/XLSX/PPTX/HWPX for full fidelity.
// (DOC since 2026-11-17: opened with its formatting by docRich.ts, on the paragraphs and tables read here — docStory,
// shared with the DOC writer; docText is what a file that cannot be read so opens as.)

import { inflateSync } from "fflate";
import type { TableCell } from "../../core/types";
import { t } from "../../i18n";
import { readCfb, type Cfb } from "./cfb";
import { numText, serialToText } from "./xlsx";

export interface LegacyText {
  /** paragraphs, or tables (rows of cells) in reading order */
  blocks: ({ kind: "para"; text: string } | { kind: "table"; rows: string[][] } | { kind: "slide"; index: number; notes?: string })[];
  warnings: string[];
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);

function utf16(b: Uint8Array, o: number, chars: number): string {
  let s = "";
  for (let i = 0; i < chars && o + i * 2 + 1 < b.length; i++) s += String.fromCharCode(u16(b, o + i * 2));
  return s;
}
const latin1 = (b: Uint8Array, o: number, n: number) => {
  let s = "";
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
};

// ───────────────────────── DOC ─────────────────────────

/** the 8-bit (compressed) text of a DOC piece: Windows-1252 where it differs from Latin-1 (the DOC writer reads it too) */
// (QA doc-write2: all of 0x80–0x9F — Word stores Œ Š ‰ Ÿ … in 8-bit pieces too; 0x81 0x8D 0x8F 0x90 0x9D have none)
export const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž",
  0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

/** One piece of a DOC piece table: CPs [cp, cpEnd), its FC as stored (bit 30: 8-bit text) and its prm. */
export interface DocPiece {
  cp: number;
  cpEnd: number;
  fc: number;
  prm: number;
}
/** byte offset in WordDocument of a CP's character in its piece (an 8-bit piece stores twice its offset) */
export const docFcAt = (p: DocPiece, cp: number) => ((p.fc & 0x40000000) !== 0 ? (p.fc & 0x3fffffff) / 2 + (cp - p.cp) : (p.fc & 0x3fffffff) + (cp - p.cp) * 2);

/**
 * The streams and the decoded text of a .doc ([MS-DOC] FIB → Clx → PlcPcd): the text of every story by CP (the main
 * document is [0, ccpText)), the pieces, the FIB's FibRgLw / FibRgFcLcb places, and the paragraph formatting pages
 * (PlcBtePapx) when the file has them.
 */
export interface DocMain {
  wd: Uint8Array;
  table: Uint8Array;
  data?: Uint8Array;
  pieces: DocPiece[];
  text: string;
  ccpText: number;
  /** FibRgLw offset; FibRgFcLcb offset and its count of pairs */
  lw: number;
  blob: number;
  pairs: number;
  /** PlcBtePapx: the FC each paragraph formatting page starts at (and the end), and the pages */
  papx: { fcs: number[]; pns: number[] } | null;
}

/** FibRgFcLcb pair i of a DOC: fc, lcb (0 when the FIB has no such pair) */
export const docPair = (m: Pick<DocMain, "wd" | "blob" | "pairs">, i: number) => (i < m.pairs ? { fc: u32(m.wd, m.blob + i * 8), lcb: u32(m.wd, m.blob + i * 8 + 4) } : { fc: 0, lcb: 0 });

/** Read a .doc's streams (`get`: a stream of its compound file by name) as the reader decodes them (DocMain). */
export function docMainFrom(wd: Uint8Array | undefined, get: (name: string) => Uint8Array | undefined): DocMain {
  if (!wd || wd.length < 0x1aa || u16(wd, 0) !== 0xa5ec) throw new Error(t("engine.legacy.noWordStream"));
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) throw new Error(t("engine.legacy.docEncrypted"));
  const table = get(flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new Error(t("engine.legacy.noTableStream"));
  // FIB: base (32 bytes), csw + FibRgW, cslw + FibRgLw, cbRgFcLcb + FibRgFcLcb
  const csw = u16(wd, 0x20);
  const cslwAt = 0x22 + csw * 2;
  const lw = cslwAt + 2;
  const pairsAt = lw + u16(wd, cslwAt) * 4;
  const pairs = pairsAt + 2 <= wd.length ? u16(wd, pairsAt) : 0;
  const blob = pairsAt + 2;
  const ccpText = u32(wd, 0x4c);
  const fcClx = u32(wd, 0x1a2), lcbClx = u32(wd, 0x1a6);
  let o = fcClx;
  const end = fcClx + lcbClx;
  while (o < end && table[o] === 0x01) o += 3 + u16(table, o + 1); // Prc entries
  if (table[o] !== 0x02) throw new Error(t("engine.legacy.noPieceTable"));
  const lcb = u32(table, o + 1);
  const plc = o + 5;
  // (no more pieces than the table stream holds: a forged lcb ran the open out of memory — QA doc-rich-open)
  const n = Math.min((lcb - 4) / 12, Math.floor((table.length - plc - 4) / 12));
  const pieces: DocPiece[] = [];
  let text = "";
  for (let i = 0; i < n; i++) {
    const cpStart = u32(table, plc + i * 4), cpEnd = u32(table, plc + (i + 1) * 4);
    const pcd = plc + (n + 1) * 4 + i * 8;
    const p: DocPiece = { cp: cpStart, cpEnd, fc: u32(table, pcd + 2), prm: u16(table, pcd + 6) };
    pieces.push(p);
    // (the main text as before; the stories after it as far as the pieces hold text)
    if (text.length !== cpStart || cpEnd <= cpStart) continue;
    const len = cpEnd - cpStart;
    if ((p.fc & 0x40000000) !== 0) {
      const off = (p.fc & 0x3fffffff) / 2;
      for (let k = 0; k < len && off + k < wd.length; k++) {
        const c = wd[off + k];
        text += CP1252[c] ?? String.fromCharCode(c);
      }
    } else text += utf16(wd, p.fc, len);
  }
  const m: DocMain = { wd, table, data: get("Data"), pieces, text, ccpText, lw, blob, pairs, papx: null };
  // PlcBtePapx (FibRgFcLcb97 pair 13)
  const bp = docPair(m, 13);
  if (bp.lcb >= 12 && (bp.lcb - 4) % 8 === 0 && bp.fc + bp.lcb <= table.length) {
    const k = (bp.lcb - 4) / 8;
    const fcs: number[] = [], pns: number[] = [];
    for (let i = 0; i <= k; i++) fcs.push(u32(table, bp.fc + i * 4));
    for (let i = 0; i < k; i++) pns.push(u32(table, bp.fc + (k + 1) * 4 + i * 4) & 0x3fffff);
    if (fcs.every((f, i) => !i || f >= fcs[i - 1])) m.papx = { fcs, pns };
  }
  return m;
}

/** The formatting page (FKP) run holding byte `fc`: the page's offset, its run count and the run's index. */
export function docFkpRun(wd: Uint8Array, bte: { fcs: number[]; pns: number[] }, fc: number): { page: number; crun: number; j: number } | null {
  let lo = 0, hi = bte.pns.length - 1, i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bte.fcs[mid] <= fc) (i = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (i < 0 || fc >= bte.fcs[i + 1]) return null;
  const page = bte.pns[i] * 512;
  if (page + 512 > wd.length) return null;
  const crun = wd[page + 511];
  for (let j = 0; j < crun; j++) if (u32(wd, page + j * 4) <= fc && fc < u32(wd, page + (j + 1) * 4)) return { page, crun, j };
  return null;
}

/** The size of a sprm's operand at `o` (its first byte), or −1 when it cannot be stepped over. */
export function docSprmSize(g: Uint8Array, sprm: number, o: number): number {
  switch (sprm >> 13) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 4:
    case 5:
      return 2;
    case 3:
      return 4;
    case 7:
      return 3;
    default:
      // variable: a size byte (sprmTDefTable: a size word, one more than the rest; sprmPChgTabs 255: not read here)
      if (sprm === 0xd608) return o + 2 <= g.length ? u16(g, o) + 1 : -1;
      if (sprm === 0xc615 && g[o] === 255) return -1;
      return o < g.length ? g[o] + 1 : -1;
  }
}

/** The sprms of a grpprl (from byte `from`) with the offset of each one's operand; null when one cannot be stepped over. */
export function docSprms(g: Uint8Array, from: number): { sprm: number; at: number }[] | null {
  const out: { sprm: number; at: number }[] = [];
  let o = from;
  while (o + 2 <= g.length) {
    const sprm = u16(g, o);
    const size = docSprmSize(g, sprm, o + 2);
    if (size < 0) return null;
    out.push({ sprm, at: o + 2 });
    o += 2 + size;
  }
  return o === g.length ? out : null;
}

/** The piece holding `cp` (the first one that does: by halving when the pieces are in order and do not overlap, as in
 *  every file Word writes — the formatting readers ask for each character). */
const ordered = new WeakMap<DocMain, boolean>();
export function docPieceAt(m: DocMain, cp: number): DocPiece | undefined {
  const ps = m.pieces;
  let ok = ordered.get(m);
  if (ok === undefined) ordered.set(m, (ok = ps.every((p, i) => p.cp <= p.cpEnd && (!i || ps[i - 1].cpEnd <= p.cp))));
  if (!ok) return ps.find((x) => x.cp <= cp && cp < x.cpEnd);
  let lo = 0, hi = ps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].cpEnd <= cp) lo = mid + 1;
    else if (ps[mid].cp > cp) hi = mid - 1;
    else return ps[mid];
  }
  return undefined;
}

/**
 * The PAPX of the paragraph whose mark is at `cp` (grpprlInPapx: istd, then the sprms; empty: the defaults); a huge
 * PAPX (sprmPHugePapx) read from the Data stream, the istd kept in front. Null when no formatting page holds it.
 */
export function docPapxAt(m: DocMain, cp: number): Uint8Array | null {
  if (!m.papx) return null;
  const p = docPieceAt(m, cp);
  if (!p) return null;
  const r = docFkpRun(m.wd, m.papx, docFcAt(p, cp));
  if (!r) return null;
  const bx = r.page + (r.crun + 1) * 4 + r.j * 13;
  const b = m.wd[bx];
  if (!b) return new Uint8Array(0);
  const at = r.page + b * 2;
  const cb = m.wd[at];
  let g = cb ? m.wd.slice(at + 1, at + 2 * cb) : m.wd.slice(at + 2, at + 2 + 2 * m.wd[at + 1]);
  const sprms = g.length >= 2 ? docSprms(g, 2) : [];
  const huge = sprms?.find((x) => x.sprm === 0x6646);
  if (huge) {
    // (PrcData in the Data stream: cbGrpprl, then the grpprl — without the istd)
    const data = m.data, o = u32(g, huge.at);
    if (!data || o + 2 > data.length || o + 2 + u16(data, o) > data.length) return null;
    g = Uint8Array.from([g[0], g[1], ...data.subarray(o + 2, o + 2 + u16(data, o))]);
  }
  return g;
}

/**
 * What the mark at `cp` ends, by its paragraph's properties: a table row (sprmPFTtp), a paragraph in a table
 * (sprmPFInTable), or neither. Null when its properties cannot be read (the reader then guesses from the text).
 */
export function docMarkKind(m: DocMain, cp: number): { ttp: boolean; inTable: boolean } | null {
  const g = docPapxAt(m, cp);
  if (!g) return null;
  const sprms = g.length >= 2 ? docSprms(g, 2) : [];
  if (!sprms) return null;
  const val = (s: number) => {
    let v = 0;
    for (const x of sprms) if (x.sprm === s) v = g[x.at];
    return v;
  };
  return { ttp: val(0x2417) === 1, inTable: val(0x2416) === 1 };
}

/** A body paragraph as the reader shows it: its text, the CP of each of its code units, its first CP and its mark. */
export interface DocRawPara {
  start: number;
  /** CP of the paragraph mark (−1: the text ends without one) */
  cr: number;
  text: string;
  cps: number[];
}
/** A table cell as the reader shows it: its text, the CP of each code unit, its first CP and its cell mark (0x07). */
export interface DocRawCell {
  text: string;
  cps: number[];
  start: number;
  mark: number;
}
export type DocBlock = { kind: "para"; p: DocRawPara } | { kind: "table"; rows: string[][]; cells: DocRawCell[][] };

/**
 * The paragraphs and tables of a story's text as the reader shows them, with the CP of every code unit shown: fields
 * show their result (after 0x14), not their code (0x13 … 0x14); paragraphs end with CR; a table cell ends with 0x07
 * and a row with a 0x07 whose paragraph properties say so (sprmPFTtp) — a CR whose properties say it is in a table
 * (sprmPFInTable) is a line of its cell. `kind` reads a mark's properties; where it cannot (null), a row ends at a 0x07
 * right after a cell's, and a CR is a cell's line once a row has a cell (the reader before 2026-11-17 did only that).
 * Also: the CPs inside a field (its marks too), and of each CP of a field's result (of a field not nested in another)
 * its field's begin CP + 1.
 */
export function docStory(text: string, kind?: (cp: number) => { ttp: boolean; inTable: boolean } | null): { blocks: DocBlock[]; inField: Uint8Array; result: Int32Array; shown: Uint8Array } {
  const inField = new Uint8Array(text.length);
  const isShown = new Uint8Array(text.length);
  const result = new Int32Array(text.length);
  const shown: number[] = [];
  // fields: the result is shown (after 0x14), the code is not (0x13 … 0x14)
  const stack: boolean[] = [];
  let begin = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (stack.length || c === 0x13) inField[i] = 1;
    if (c === 0x13) {
      if (!stack.length) begin = i;
      stack.push(true);
    } else if (c === 0x14) {
      if (stack.length) stack[stack.length - 1] = false;
    } else if (c === 0x15) stack.pop();
    else if (stack.length && stack[stack.length - 1]) continue;
    else {
      if (stack.length === 1) result[i] = begin + 1;
      shown.push(i);
      isShown[i] = 1;
    }
  }
  const blocks: DocBlock[] = [];
  let rows: string[][] = [];
  let cells: DocRawCell[][] = [];
  let row: string[] = [];
  let rowCells: DocRawCell[] = [];
  let buf: { ch: string; cp: number }[] = [];
  let prevCell = false;
  let start = 0;
  for (const cp of shown) {
    const ch = text[cp];
    if (ch === "\x07") {
      const k = kind?.(cp);
      if (k ? k.ttp : !buf.length && prevCell) {
        // (a row end with letters before it: they go with the row's last cell)
        if (buf.length && rowCells.length) {
          const last = rowCells[rowCells.length - 1];
          const c = docCleaned([...last.cps.map((x) => ({ ch: text[x] === "\r" ? "\n" : text[x], cp: x })), ...buf]);
          rowCells[rowCells.length - 1] = { ...last, ...c };
          row[row.length - 1] = c.text;
        }
        rows.push(row), cells.push(rowCells);
        row = [];
        rowCells = [];
        prevCell = false;
      } else {
        const c = docCleaned(buf);
        row.push(c.text);
        rowCells.push({ ...c, start, mark: cp });
        prevCell = true;
      }
      buf = [];
      start = cp + 1;
      continue;
    }
    prevCell = false;
    if (ch === "\r") {
      const k = kind?.(cp);
      if (k ? k.inTable : row.length) buf.push({ ch: "\n", cp });
      else {
        if (rows.length || row.length) {
          if (row.length) rows.push(row), cells.push(rowCells), (row = []), (rowCells = []);
          blocks.push({ kind: "table", rows, cells }), (rows = []), (cells = []);
        }
        blocks.push({ kind: "para", p: { ...docCleaned(buf), start, cr: cp } });
        buf = [];
        start = cp + 1;
      }
      continue;
    }
    buf.push({ ch, cp });
  }
  if (row.length) rows.push(row), cells.push(rowCells);
  if (rows.length) blocks.push({ kind: "table", rows, cells });
  if (buf.length) blocks.push({ kind: "para", p: { ...docCleaned(buf), start, cr: -1 } });
  return { blocks, inField, result, shown: isShown };
}

/** A paragraph's or cell's code units as shown, each with its CP: line breaks as \n, other controls dropped, tabs at the end too. */
export function docCleaned(buf: readonly { ch: string; cp: number }[]): { text: string; cps: number[] } {
  const kept = buf.map((x) => (x.ch === "\x0b" ? { ch: "\n", cp: x.cp } : x)).filter((x) => !/[\x00-\x08\x0c\x0e-\x1f]/.test(x.ch));
  let n = kept.length;
  while (n && kept[n - 1].ch === "\t") n--;
  return { text: kept.slice(0, n).map((x) => x.ch).join(""), cps: kept.slice(0, n).map((x) => x.cp) };
}

/** A .doc's main text, paragraphs and tables (docStory) as the reader shows them. */
export function docMainStory(bytes: Uint8Array, guess = false): { m: DocMain; story: ReturnType<typeof docStory> } {
  const cfb = readCfb(bytes);
  const m = docMainFrom(cfb.get("WordDocument"), (n) => cfb.get(n));
  return { m, story: docStory(m.text.slice(0, m.ccpText), guess ? undefined : (cp) => docMarkKind(m, cp)) };
}

/** `guess`: as the reader before 2026-11-17 read it (rows and cells' lines guessed from the text — docStory without the
 *  marks' properties): the pages of a document opened then (a .omw saved then) are of that reading */
export function docText(bytes: Uint8Array, guess = false): LegacyText {
  const { story } = docMainStory(bytes, guess);
  const blocks: LegacyText["blocks"] = story.blocks.map((b) => (b.kind === "para" ? { kind: "para", text: b.p.text } : { kind: "table", rows: b.rows }));
  return { blocks, warnings: [t("engine.legacy.docLimited")] };
}

// ───────────────────────── PPT ─────────────────────────

/** [MS-PPT] record types read here (and by the PPT writer, pptWrite.ts) */
export const PPT_RT = {
  document: 0x03e8,
  slide: 0x03ee,
  slideAtom: 0x03ef,
  notes: 0x03f0,
  mainMaster: 0x03f8,
  handout: 0x0fc9,
  slideList: 0x0ff0,
  slidePersist: 0x03f3,
  textHeader: 0x0f9f,
  textChars: 0x0fa0,
  textBytes: 0x0fa8,
  userEdit: 0x0ff5,
  persistDir: 0x1772,
  currentUser: 0x0ff6,
  clientTextbox: 0xf00d,
} as const;
const RT = PPT_RT;

/**
 * The live persist objects of a PowerPoint Document stream ([MS-PPT] 2.1.2): the user edits from the Current User
 * stream's offsetToCurrentEdit back along offsetLastEdit (newest first: each UserEditAtom's offset and its
 * PersistDirectoryAtom's), and persist id → stream offset, the newest edit's entry winning. Throws on a chain that is not
 * one (an encrypted file's Current User, an offset off a record, a loop).
 */
export function pptPersist(s: Uint8Array, cu: Uint8Array): { edits: { at: number; dir: number }[]; offsets: Map<number, number> } {
  // CurrentUserAtom: rh, size 0x14, headerToken 0xE391C05F (0xF3D1C4DF: encrypted), offsetToCurrentEdit
  if (cu.length < 20 || u16(cu, 2) !== RT.currentUser || u32(cu, 8) !== 0x14 || u32(cu, 12) !== 0xe391c05f) throw new Error("ppt: Current User");
  const edits: { at: number; dir: number }[] = [];
  const offsets = new Map<number, number>();
  for (let at = u32(cu, 16); ; ) {
    // UserEditAtom: lastSlideIdRef, version, minor / major version, offsetLastEdit, offsetPersistDirectory …
    if (edits.some((e) => e.at === at) || at + 36 > s.length || u16(s, at + 2) !== RT.userEdit || u32(s, at + 4) < 28) throw new Error("ppt: UserEditAtom");
    const last = u32(s, at + 16), dir = u32(s, at + 20);
    if (dir + 8 > s.length || u16(s, dir + 2) !== RT.persistDir || dir + 8 + u32(s, dir + 4) > s.length) throw new Error("ppt: PersistDirectoryAtom");
    // PersistDirectoryEntry: persistId (20 bits) and cPersist (12 bits), then cPersist offsets
    for (let o = dir + 8, end = dir + 8 + u32(s, dir + 4); o < end; ) {
      const h = u32(s, o), id = h & 0xfffff, n = h >>> 20;
      if (o + 4 + n * 4 > end) throw new Error("ppt: PersistDirectoryEntry");
      for (let k = 0; k < n; k++) if (!offsets.has(id + k)) offsets.set(id + k, u32(s, o + 4 + k * 4));
      o += 4 + n * 4;
    }
    edits.push({ at, dir });
    if (!last) break;
    at = last;
  }
  return { edits, offsets };
}

/** A TextCharsAtom / TextBytesAtom the reader takes text from: its record's offset in the stream, its text as stored. */
export interface PptAtom {
  at: number;
  text: string;
}
/** One slide as the reader sees it: its text atoms in order, its SlideContainer (when known), its notes' text atom. */
export interface PptSlide {
  slide?: number;
  texts: PptAtom[];
  notes?: PptAtom;
}

/** a text atom's text as stored (TextBytesAtom: each byte the low byte of a UTF-16 code unit) */
const atomText = (s: Uint8Array, at: number) => (u16(s, at + 2) === RT.textChars ? utf16(s, at + 8, u32(s, at + 4) / 2) : latin1(s, at + 8, u32(s, at + 4)));

/**
 * The slides of a PowerPoint Document stream and where their text is: the outline text of the slide list
 * (SlideListWithText instance 0: the text atoms after each SlidePersistAtom) when it has any — files of PowerPoint
 * 97-2003 — else the text inside each SlideContainer, in stream order (PowerPoint 2007 and later keep it there only).
 * With the persist map, each slide's notes: the text of the notes body placeholder (TextHeaderAtom type 2) in the
 * NotesContainer its SlideAtom names.
 */
export function pptSlides(s: Uint8Array, persist?: Map<number, number>): { slides: PptSlide[]; fromList: boolean } {
  // pass A: SlideListWithText (instance 0 = slides) with SlidePersistAtom separators
  const slidesA: PptSlide[] = [];
  // pass B: text inside SlideContainer drawings
  const slidesB: PptSlide[] = [];
  // the notes list (SlideListWithText instance 2): notesId → the NotesContainer's persist id
  const notesIds = new Map<number, number>();
  const walk = (o: number, end: number, ctx: { list: number; inSlide: boolean }, depth: number) => {
    while (o + 8 <= end && depth < 32) {
      const verInst = u16(s, o), type = u16(s, o + 2), len = u32(s, o + 4);
      const body = o + 8;
      if (body + len > s.length) break;
      const inst = verInst >> 4;
      if ((verInst & 0xf) === 0xf) {
        if (type === RT.slideList) walk(body, body + len, { list: inst, inSlide: false }, depth + 1);
        else if (type === RT.slide) {
          slidesB.push({ slide: o, texts: [] });
          walk(body, body + len, { list: -1, inSlide: true }, depth + 1);
        } else if (type === RT.mainMaster || type === RT.handout || type === RT.notes) {
          /* masters, handouts, notes: skip */
        } else walk(body, body + len, ctx, depth + 1);
      } else if (type === RT.slidePersist && ctx.list === 2 && len >= 16) notesIds.set(u32(s, body + 12), u32(s, body));
      else if (type === RT.slidePersist && ctx.list === 0) {
        // SlidePersistAtom: persistIdRef first
        const at = len >= 4 ? persist?.get(u32(s, body)) : undefined;
        slidesA.push(at !== undefined && at + 8 <= s.length && u16(s, at + 2) === RT.slide ? { slide: at, texts: [] } : { texts: [] });
      } else if (type === RT.textChars || type === RT.textBytes) {
        const a = { at: o, text: atomText(s, o) };
        if (ctx.list === 0 && slidesA.length) slidesA[slidesA.length - 1].texts.push(a);
        else if (ctx.inSlide && slidesB.length) slidesB[slidesB.length - 1].texts.push(a);
      }
      o = body + len;
    }
  };
  walk(0, s.length, { list: -1, inSlide: false }, 0);
  const fromList = slidesA.some((x) => x.texts.length);
  const slides = fromList ? slidesA : slidesB;
  if (persist) for (const sl of slides) if (sl.slide !== undefined) sl.notes = notesAtom(s, sl.slide, persist, notesIds);
  return { slides, fromList };
}

/** the records directly inside the container at `at` */
function kidsOf(s: Uint8Array, at: number): { at: number; type: number; len: number }[] {
  const out: { at: number; type: number; len: number }[] = [];
  for (let o = at + 8, end = Math.min(s.length, at + 8 + u32(s, at + 4)); o + 8 <= end; ) {
    const len = u32(s, o + 4);
    if (o + 8 + len > end) break;
    out.push({ at: o, type: u16(s, o + 2), len });
    o += 8 + len;
  }
  return out;
}

/**
 * the text atom of the body placeholder of the notes the SlideContainer at `slide` names (SlideAtom notesIdRef: a
 * notesId of the notes list, whose NotesPersistAtom gives the persist id)
 */
function notesAtom(s: Uint8Array, slide: number, persist: Map<number, number>, notesIds: Map<number, number>): PptAtom | undefined {
  // SlideAtom: geom, rgPlaceholderTypes (8), masterIdRef, notesIdRef …
  const atom = kidsOf(s, slide).find((k) => k.type === RT.slideAtom);
  if (!atom || atom.len < 24) return;
  const id = notesIds.get(u32(s, atom.at + 8 + 16));
  const at = id ? persist.get(id) : undefined;
  if (at === undefined || at + 8 > s.length || u16(s, at + 2) !== RT.notes) return;
  // the drawing's shapes, at any depth: the first OfficeArtClientTextbox whose TextHeaderAtom says notes (2)
  let found: PptAtom | undefined;
  const look = (o: number, depth: number) => {
    for (const k of kidsOf(s, o)) {
      if (found || depth > 16) return;
      if (k.type === RT.clientTextbox) {
        const ks = kidsOf(s, k.at);
        const h = ks.findIndex((x) => x.type === RT.textHeader && x.len >= 4 && u32(s, x.at + 8) === 2);
        const t = h >= 0 ? ks[h + 1] : undefined;
        if (t && (t.type === RT.textChars || t.type === RT.textBytes)) found = { at: t.at, text: atomText(s, t.at) };
      } else if ((u16(s, k.at) & 0xf) === 0xf) look(k.at, depth + 1);
    }
  };
  look(at, 0);
  return found;
}

/** a PPT text as the slides show it: paragraph marks (CR) and line breaks (VT) each start a line */
export const pptLines = (t: string) => t.replace(/\r/g, "\n").replace(/\x0b/g, "\n");

export function pptText(bytes: Uint8Array): LegacyText {
  const cfb = readCfb(bytes);
  const s = cfb.get("PowerPoint Document");
  if (!s) throw new Error(t("engine.legacy.noPptStream"));
  if (cfb.get("EncryptedSummary")) throw new Error(t("engine.legacy.pptEncrypted"));
  let persist: Map<number, number> | undefined;
  try {
    persist = pptPersist(s, cfb.get("Current User") ?? new Uint8Array(0)).offsets;
  } catch {
    persist = undefined; // (then no notes: the slides' text does not need it)
  }
  const blocks: LegacyText["blocks"] = [];
  pptSlides(s, persist).slides.forEach((sl, i) => {
    blocks.push(sl.notes ? { kind: "slide", index: i, notes: pptLines(sl.notes.text) } : { kind: "slide", index: i });
    for (const a of sl.texts) for (const line of pptLines(a.text).split("\n")) blocks.push({ kind: "para", text: line });
  });
  return { blocks, warnings: [t("engine.legacy.pptLimited")] };
}

// ───────────────────────── XLS ─────────────────────────

export interface XlsSheet {
  name: string;
  rows: TableCell[][];
}

export function xlsSheets(bytes: Uint8Array): { sheets: XlsSheet[]; warnings: string[] } {
  const cfb = readCfb(bytes);
  const wb = cfb.get("Workbook") ?? cfb.get("Book");
  if (!wb) throw new Error(t("engine.legacy.noWorkbook"));
  if (!cfb.get("Workbook")) throw new Error(t("engine.legacy.biff5"));
  // records
  const recs: { type: number; off: number; len: number }[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const type = u16(wb, o), len = u16(wb, o + 2);
    recs.push({ type, off: o + 4, len });
    o += 4 + len;
  }
  if (recs.some((r) => r.type === 0x002f)) throw new Error(t("engine.legacy.xlsEncrypted"));
  const sst: string[] = [];
  const sheets: { name: string; pos: number }[] = [];
  const formats = new Map<number, string>();
  const xfFmt: number[] = [];
  let date1904 = false;
  // SST with CONTINUE records: a reader that walks across record boundaries
  const parseSst = (i: number) => {
    const parts = [recs[i]];
    for (let j = i + 1; j < recs.length && recs[j].type === 0x003c; j++) parts.push(recs[j]);
    let p = 0, o = parts[0].off, end = parts[0].off + parts[0].len;
    const next = () => {
      p++;
      if (p >= parts.length) return false;
      o = parts[p].off;
      end = o + parts[p].len;
      return true;
    };
    const ensure = (n: number) => {
      if (o + n > end) next();
    };
    const rd8 = () => {
      ensure(1);
      return wb[o++];
    };
    const rd16 = () => {
      ensure(2);
      const v = u16(wb, o);
      o += 2;
      return v;
    };
    const rd32 = () => {
      ensure(4);
      const v = u32(wb, o);
      o += 4;
      return v;
    };
    const skipN = (n: number) => {
      while (n > 0) {
        const k = Math.min(n, end - o);
        o += k;
        n -= k;
        if (n > 0 && !next()) return;
      }
    };
    o += 4; // cstTotal
    const unique = rd32();
    for (let k = 0; k < unique && p < parts.length; k++) {
      const cch = rd16();
      let flags = rd8();
      const runs = flags & 0x08 ? rd16() : 0;
      const ext = flags & 0x04 ? rd32() : 0;
      let s = "";
      let left = cch;
      while (left > 0) {
        if (o >= end) {
          if (!next()) break;
          flags = wb[o++]; // continued characters start with a fresh high-byte flag
        }
        const wide = flags & 0x01;
        const avail = Math.floor((end - o) / (wide ? 2 : 1));
        const take = Math.min(left, avail);
        s += wide ? utf16(wb, o, take) : latin1(wb, o, take);
        o += take * (wide ? 2 : 1);
        left -= take;
        if (take === 0 && !next()) break;
      }
      skipN(runs * 4 + ext);
      sst.push(s);
    }
  };
  const xlString = (o: number, short = false): string => {
    const cch = short ? wb[o] : u16(wb, o);
    const f = wb[o + (short ? 1 : 2)];
    const at = o + (short ? 2 : 3);
    return f & 1 ? utf16(wb, at, cch) : latin1(wb, at, cch);
  };
  recs.forEach((r, i) => {
    if (r.type === 0x0085) sheets.push({ name: xlString(r.off + 6, true), pos: u32(wb, r.off) });
    else if (r.type === 0x00fc) parseSst(i);
    else if (r.type === 0x041e) formats.set(u16(wb, r.off), xlString(r.off + 2));
    else if (r.type === 0x00e0) xfFmt.push(u16(wb, r.off + 2));
    else if (r.type === 0x0022) date1904 = u16(wb, r.off) === 1;
  });
  const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const dateCode = (xf: number): string | null => {
    const f = xfFmt[xf];
    if (f === undefined) return null;
    if (BUILTIN_DATE.has(f)) return f >= 18 && f <= 21 ? "h:mm:ss" : "yyyy-mm-dd";
    const code = formats.get(f);
    if (!code) return null;
    const s = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    return /[ymdhs]/i.test(s) && !/^[#0.,%\s]*$/.test(s) ? code : null;
  };
  const num = (v: number, xf: number) => {
    const d = dateCode(xf);
    return d ? serialToText(v, date1904, d) : numText(String(v));
  };
  const rk = (v: number) => {
    let n: number;
    if (v & 2) n = v >> 2;
    else {
      const buf = new DataView(new ArrayBuffer(8));
      buf.setUint32(4, v & 0xfffffffc, true);
      n = buf.getFloat64(0, true);
    }
    return v & 1 ? n / 100 : n;
  };
  const out: XlsSheet[] = [];
  for (const sh of sheets) {
    const start = recs.findIndex((r) => r.off - 4 === sh.pos);
    if (start < 0) continue;
    const grid: TableCell[][] = [];
    let maxCol = 0;
    const put = (row: number, col: number, text: string, right = false) => {
      if (row > 20000 || col > 255) return;
      while (grid.length <= row) grid.push([]);
      grid[row][col] = right ? { text, align: "RIGHT" } : { text };
      maxCol = Math.max(maxCol, col + 1);
    };
    let pendingFormula: { row: number; col: number } | null = null;
    for (let i = start + 1; i < recs.length; i++) {
      const r = recs[i];
      const o = r.off;
      if (r.type === 0x000a) break; // EOF
      switch (r.type) {
        case 0x00fd:
          put(u16(wb, o), u16(wb, o + 2), sst[u32(wb, o + 6)] ?? "");
          break;
        case 0x0204:
          put(u16(wb, o), u16(wb, o + 2), xlString(o + 6));
          break;
        case 0x0203:
          put(u16(wb, o), u16(wb, o + 2), num(new DataView(wb.buffer, wb.byteOffset + o + 6, 8).getFloat64(0, true), u16(wb, o + 4)), true);
          break;
        case 0x027e:
          put(u16(wb, o), u16(wb, o + 2), num(rk(u32(wb, o + 6)), u16(wb, o + 4)), true);
          break;
        case 0x00bd: {
          const row = u16(wb, o), first = u16(wb, o + 2);
          const count = (r.len - 6) / 6;
          for (let k = 0; k < count; k++) put(row, first + k, num(rk(u32(wb, o + 4 + k * 6 + 2)), u16(wb, o + 4 + k * 6)), true);
          break;
        }
        case 0x0205: {
          const v = wb[o + 6], isErr = wb[o + 7];
          put(u16(wb, o), u16(wb, o + 2), isErr ? "#ERR" : v ? "TRUE" : "FALSE");
          break;
        }
        case 0x0006: {
          const row = u16(wb, o), col = u16(wb, o + 2);
          if (u16(wb, o + 12) === 0xffff) {
            const kind = wb[o + 6];
            if (kind === 0) pendingFormula = { row, col };
            else if (kind === 1) put(row, col, wb[o + 8] ? "TRUE" : "FALSE");
            else if (kind === 2) put(row, col, "#ERR");
          } else put(row, col, num(new DataView(wb.buffer, wb.byteOffset + o + 6, 8).getFloat64(0, true), u16(wb, o + 4)), true);
          break;
        }
        case 0x0207:
          if (pendingFormula) put(pendingFormula.row, pendingFormula.col, xlString(o));
          pendingFormula = null;
          break;
      }
    }
    while (grid.length && !grid[grid.length - 1].some((c) => c?.text)) grid.pop();
    if (!grid.length) continue;
    out.push({ name: sh.name, rows: grid.map((r) => Array.from({ length: Math.max(1, maxCol) }, (_, c) => r[c] ?? { text: "" })) });
  }
  return { sheets: out, warnings: [t("engine.legacy.xlsLimited")] };
}

// ───────────────────────── HWP 5.0 ─────────────────────────

const TAG_PARA_TEXT = 0x43, TAG_CTRL_HEADER = 0x47, TAG_LIST_HEADER = 0x48, TAG_TABLE = 0x4d;
const CHID_TBL = (0x74 << 24) | (0x62 << 16) | (0x6c << 8) | 0x20; // 'tbl '

function hwpParaText(b: Uint8Array, o: number, len: number): string {
  let s = "";
  for (let i = 0; i + 1 < len; ) {
    const c = u16(b, o + i);
    if (c < 32) {
      // char controls take 1 WCHAR; inline and extended controls take 8 (HWP 5.0 표 6)
      const single = c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31);
      if (c === 9) s += "\t";
      else if (c === 10) s += "\n";
      else if (c === 24 || c === 30 || c === 31) s += c === 24 ? "-" : " ";
      i += single ? 2 : 16;
      continue;
    }
    s += String.fromCharCode(c);
    i += 2;
  }
  return s;
}

export function hwpText(bytes: Uint8Array): LegacyText {
  let cfb: Cfb;
  try {
    cfb = readCfb(bytes);
  } catch {
    throw new Error(t("engine.legacy.notHwp5"));
  }
  const fh = cfb.get("FileHeader");
  if (!fh || !latin1(fh, 0, 17).startsWith("HWP Document File")) throw new Error(t("engine.legacy.noFileHeader"));
  const props = u32(fh, 36);
  if (props & 0x02) throw new Error(t("engine.legacy.hwpEncrypted"));
  if (props & 0x04) throw new Error(t("engine.legacy.hwpDistribution"));
  const compressed = (props & 0x01) !== 0;
  const sections = [...cfb.streams.keys()].filter((k) => /^BodyText\/Section\d+$/.test(k)).sort((a, b) => Number(a.slice(16)) - Number(b.slice(16)));
  if (!sections.length) throw new Error(t("engine.legacy.noBodyText"));
  const blocks: LegacyText["blocks"] = [];
  type T = { level: number; rows: number; cols: number; cells: string[][]; cur: [number, number] | null; listLevel: number };
  const stack: T[] = [];
  const closeTo = (level: number) => {
    while (stack.length && level <= stack[stack.length - 1].level) {
      const t = stack.pop()!;
      const rows = t.cells.map((r) => Array.from({ length: t.cols }, (_, c) => r[c] ?? ""));
      if (stack.length) {
        // nested table: flatten into the outer cell
        const outer = stack[stack.length - 1];
        if (outer.cur) {
          const [r, c] = outer.cur;
          outer.cells[r][c] = [outer.cells[r][c], rows.map((x) => x.join(" | ")).join("\n")].filter(Boolean).join("\n");
        }
      } else blocks.push({ kind: "table", rows });
    }
  };
  for (const sec of sections) {
    let data = cfb.get(sec)!;
    if (compressed) data = inflateSync(data);
    for (let o = 0; o + 4 <= data.length; ) {
      const h = u32(data, o);
      const tag = h & 0x3ff, level = (h >>> 10) & 0x3ff;
      let size = h >>> 20;
      o += 4;
      if (size === 0xfff) {
        size = u32(data, o);
        o += 4;
      }
      const body = o;
      o += size;
      if (o > data.length) break;
      closeTo(level);
      const top = stack[stack.length - 1];
      if (tag === TAG_CTRL_HEADER && size >= 4 && u32(data, body) === CHID_TBL) {
        stack.push({ level, rows: 0, cols: 0, cells: [], cur: null, listLevel: level + 1 });
      } else if (tag === TAG_TABLE && top && level === top.listLevel) {
        top.rows = u16(data, body + 4);
        top.cols = u16(data, body + 6);
        top.cells = Array.from({ length: top.rows }, () => []);
      } else if (tag === TAG_LIST_HEADER && top && level === top.listLevel && size >= 12) {
        const col = u16(data, body + 8), row = u16(data, body + 10);
        if (row < top.rows && col < Math.max(top.cols, 1)) {
          top.cur = [row, col];
          top.cells[row][col] ??= "";
        } else top.cur = null;
      } else if (tag === TAG_PARA_TEXT) {
        const text = hwpParaText(data, body, size).replace(/\r$/, "");
        if (top && top.cur) {
          const [r, c] = top.cur;
          top.cells[r][c] = top.cells[r][c] ? top.cells[r][c] + "\n" + text : text;
        } else if (!top) blocks.push({ kind: "para", text });
        else blocks.push({ kind: "para", text }); // text box or caption inside a table control
      }
    }
    closeTo(0);
  }
  return { blocks, warnings: [t("engine.legacy.hwpLimited")] };
}
