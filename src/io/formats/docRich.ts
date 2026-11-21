// DOC (Word 97-2003) opened with its formatting: the binary structures of the file ([MS-DOC]) written out as the
// WordprocessingML package Word would save of it, read by the DOCX importer (io/office.ts parseDocxFlow) — the same
// document model, styles, lists, tables, sections, headers / footers and notes as a DOCX. The same way the HWP 5.0
// reader goes through HWPX (hwp5.ts).
//
//   text       the main document's paragraphs and tables exactly as the text reader shows them (legacy.ts docStory: one
//              body paragraph per block, one table per table block, the same letters) — the DOC save writes text edits
//              into the original file by that reading (docWrite.ts), so the pages must hold the same text; a file that
//              does not read so here opens as text only, as before
//   characters CHPX (formatting pages) over the paragraph style's and the character style's CHP (STSH, istd chains):
//              fonts (SttbfFfn), size, bold, italic, underline, strike, colour (ico / COLORREF), highlight, shading,
//              super / subscript, character spacing and scale; tracked insertions / deletions
//   paragraphs PAPX (huge PAPX from the Data stream) over the style's PAP: alignment, indents, spacing, line spacing,
//              keep with next / together, page break before, widow control, borders, shading, list membership
//   lists      PlfLst / PlfLfo (LSTF, LVL, LFO overrides) → numbering.xml
//   tables     each row's TAP (sprmTDefTable: cell edges and TC80; borders, cell shading, vertical merges, cell
//              alignment, row height, header row, table alignment, cell margins) → the table grid
//   sections   PlfSed / SEPX: paper size, margins, header / footer distances, title page, page numbers; headers and
//              footers of PlcfHdd (empty: the section before's), footnotes and endnotes (PlcffndRef / PlcfendRef)
//   pictures   inline pictures (0x01 with sprmCPicLocation: PICF in the Data stream, its OfficeArt BLIP — PNG, JPEG,
//              DIB) as the DOCX importer places them; anything else is named in a notice (warnings)
//
// Source: [MS-DOC] Word (.doc) Binary File Format, [MS-ODRAW] Office Drawing Binary File Format — Microsoft open
// specifications.

import { strToU8, zipSync } from "fflate";
import { makeAsset } from "../../core/assets";
import type { AssetRef, Page, TextParagraph } from "../../core/types";
import { t } from "../../i18n";
import { collectFlow, docxFieldKind, parseDocxFlow, type OfficeImportReport, type OfficeItem } from "../office";
import type { OfficePic } from "../officeDrawing";
import { readCfb } from "./cfb";
import { officePages } from "./flow";
import { docFcAt, docFkpRun, docMainFrom, docMarkKind, docPair, docPapxAt, docPieceAt, docSprms, docStory, type DocRawCell } from "./legacy";
import { baseName } from "./text";
import { markerLength } from "../../core/richtext";

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const i16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

/** FibRgLw: ccpText, ccpFtn, ccpHdd, ccpMcr, ccpAtn, ccpEdn, ccpTxbx, ccpHdrTxbx */
const LW = { text: 3, ftn: 4, hdd: 5, mcr: 6, atn: 7, edn: 8, txbx: 9, hdrTxbx: 10 };
/** FibRgFcLcb97 pairs read here */
const P = { stsh: 1, fndRef: 2, fndTxt: 3, andRef: 4, andTxt: 5, atnOwners: 36, atnBkmk: 37, atnBkf: 42, atnBkl: 43, sed: 6, hdd: 11, chpx: 12, ffn: 15, dop: 31, spaMom: 40, dgg: 50, endRef: 46, endTxt: 47, rmark: 51, lst: 73, lfo: 74 };

// ───────────────────────── character and paragraph properties ─────────────────────────

interface Chp {
  b: boolean;
  i: boolean;
  strike: boolean;
  dstrike: boolean;
  caps: boolean;
  smallCaps: boolean;
  vanish: boolean;
  u: number;
  hps: number;
  ftc: [number, number, number];
  ico: number;
  cv: string | null;
  hl: number;
  shd: string | null;
  iss: number;
  dxaSpace: number;
  scale: number;
  istd: number;
  del: boolean;
  ins: boolean;
  ibstIns: number;
  ibstDel: number;
  spec: boolean;
  pic: number;
  ole2: boolean;
  data: boolean;
  /** (not in the model — named in a notice) raised / lowered (sprmCHpsPos), a symbol font character (sprmCSymbol), East
   *  Asian layout (sprmCFELayout) */
  pos: number;
  sym: boolean;
  fe: boolean;
  /** (not in the model — QA doc-para-write: what a style may change that restyle sets again) kerning (sprmCHpsKern), the
   *  languages (sprmCRgLid0/1, sprmCLidBi; 0 none read), the complex-script size, bold, italic and font */
  kern: number;
  lid: [number, number, number];
  hpsBi: number;
  bBi: boolean;
  iBi: boolean;
  ftcBi: number;
}

interface Brc {
  w: number;
  type: number;
  color: string | null;
  space: number;
}

interface Pap {
  istd: number;
  jc: number;
  left: number;
  right: number;
  first: number;
  before: number;
  after: number;
  beforeAuto: boolean;
  afterAuto: boolean;
  line: number;
  mult: boolean;
  keep: boolean;
  keepNext: boolean;
  pageBreak: boolean;
  widow: boolean;
  wordWrap: boolean;
  overflowPunct: boolean;
  autoDE: boolean;
  autoDN: boolean;
  ilvl: number;
  ilfo: number;
  outLvl: number;
  brc: Partial<Record<"top" | "left" | "bottom" | "right" | "between", Brc>>;
  shd: string | null;
  dxaAbs: number | null;
  framed: boolean;
  /** tab stops of its own (sprmPChgTabsPapx / sprmPChgTabs; not in the model — named in a notice) */
  tabs: boolean;
  /** the indents the paragraph's own PAPX gives (a list paragraph takes the others from its level, then its style — Word) */
  own?: { left: boolean; first: boolean };
}

const DEF_PAP: Pap = {
  istd: 0, jc: 0, left: 0, right: 0, first: 0, before: 0, after: 0, beforeAuto: false, afterAuto: false, line: 240, mult: true, keep: false, keepNext: false, pageBreak: false,
  widow: true, wordWrap: true, overflowPunct: true, autoDE: true, autoDN: true, ilvl: 0, ilfo: 0, outLvl: 9, brc: {}, shd: null, dxaAbs: null, framed: false, tabs: false,
};

/** ico (Ico) → RGB */
const ICO = ["", "000000", "0000FF", "00FFFF", "00FF00", "FF00FF", "FF0000", "FFFF00", "FFFFFF", "000080", "008080", "008000", "800080", "800000", "808000", "808080", "C0C0C0"];
/** ico → w:highlight */
const HL = ["", "black", "blue", "cyan", "green", "magenta", "red", "yellow", "white", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray"];

/** COLORREF (r, g, b, fAuto 0xFF) → RRGGBB, null for auto */
const colorRef = (b: Uint8Array, o: number) => (b[o + 3] === 0xff ? null : [b[o], b[o + 1], b[o + 2]].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase());
/** SHD80 (icoFore, icoBack, ipat) → fill */
const shd80 = (v: number) => {
  const fore = v & 0x1f, back = (v >> 5) & 0x1f, ipat = v >> 10;
  const c = ipat === 1 ? fore : back;
  return ipat === 0 && !back ? null : ICO[c] || null;
};
/** SHD (cvFore, cvBack, ipat) → fill */
const shdOf = (b: Uint8Array, o: number) => {
  const ipat = u16(b, o + 8);
  if (ipat === 0xffff) return null;
  return ipat === 1 ? colorRef(b, o) : colorRef(b, o + 4);
};
const brc80 = (b: Uint8Array, o: number): Brc => ({ w: b[o], type: b[o + 1], color: ICO[b[o + 2]] || null, space: b[o + 3] & 0x1f });
const brc = (b: Uint8Array, o: number): Brc => ({ w: b[o + 4], type: b[o + 5], color: colorRef(b, o), space: b[o + 6] & 0x1f });

/** a toggle property's value: 0 off, 1 on, 0x80 the style's, 0x81 the opposite of the style's */
const toggle = (v: number, base: boolean) => (v === 0x80 ? base : v === 0x81 ? !base : v === 1);

function applyChp(c: Chp, g: Uint8Array, from: number, base: Chp): void {
  const sprms = docSprms(g, from);
  if (!sprms) return;
  for (const { sprm, at } of sprms) {
    switch (sprm) {
      case 0x0835: c.b = toggle(g[at], base.b); break;
      case 0x0836: c.i = toggle(g[at], base.i); break;
      case 0x0837: c.strike = toggle(g[at], base.strike); break;
      case 0x083a: c.smallCaps = toggle(g[at], base.smallCaps); break;
      case 0x083b: c.caps = toggle(g[at], base.caps); break;
      case 0x083c: c.vanish = toggle(g[at], base.vanish); break;
      case 0x2a53: c.dstrike = toggle(g[at], base.dstrike); break;
      case 0x2a3e: c.u = g[at]; break;
      case 0x4a43: c.hps = u16(g, at); break;
      case 0x4a4f: c.ftc[0] = u16(g, at); break;
      case 0x4a50: c.ftc[1] = u16(g, at); break;
      case 0x4a51: c.ftc[2] = u16(g, at); break;
      case 0x4a3d: c.ftc[0] = c.ftc[2] = u16(g, at); break;
      case 0x2a42: c.ico = g[at]; c.cv = null; break;
      case 0x6870: c.cv = colorRef(g, at); break;
      case 0x2a0c: c.hl = g[at]; break;
      case 0x4866: c.shd = shd80(u16(g, at)); break;
      case 0xca71: c.shd = shdOf(g, at + 1); break;
      case 0x2a48: c.iss = g[at]; break;
      case 0x8840: c.dxaSpace = i16(g, at); break;
      case 0x4852: c.scale = u16(g, at); break;
      case 0x0800: c.del = g[at] === 1; break;
      case 0x0801: c.ins = g[at] === 1; break;
      case 0x4804: c.ibstIns = u16(g, at); break;
      case 0x4863: c.ibstDel = u16(g, at); break;
      case 0x0855: c.spec = g[at] === 1; break;
      case 0x6a03: c.pic = u32(g, at); break;
      case 0x080a: c.ole2 = g[at] === 1; break;
      case 0x0806: c.data = g[at] === 1; break;
      case 0x4845: c.pos = i16(g, at); break;
      case 0x6a09: c.sym = true; break;
      case 0xca78: c.fe = true; break;
      case 0x484b: c.kern = u16(g, at); break;
      case 0x486d: case 0x4873: c.lid = [u16(g, at), c.lid[1], c.lid[2]]; break;
      case 0x486e: case 0x4874: c.lid = [c.lid[0], u16(g, at), c.lid[2]]; break;
      case 0x485f: c.lid = [c.lid[0], c.lid[1], u16(g, at)]; break;
      case 0x4a61: c.hpsBi = u16(g, at); break;
      case 0x085c: c.bBi = toggle(g[at], base.bBi); break;
      case 0x085d: c.iBi = toggle(g[at], base.iBi); break;
      case 0x4a5e: c.ftcBi = u16(g, at); break;
    }
  }
}

function applyPap(p: Pap, g: Uint8Array, from: number): void {
  const sprms = docSprms(g, from);
  if (!sprms) return;
  for (const { sprm, at } of sprms) {
    switch (sprm) {
      case 0x4600: p.istd = u16(g, at); break;
      case 0x2403: case 0x2461: p.jc = g[at]; break;
      case 0x2405: p.keep = g[at] === 1; break;
      case 0x2406: p.keepNext = g[at] === 1; break;
      case 0x2407: p.pageBreak = g[at] === 1; break;
      case 0x260a: p.ilvl = g[at]; break;
      case 0x460b: p.ilfo = i16(g, at); break;
      case 0x840e: case 0x845d: p.right = i16(g, at); break;
      case 0x840f: case 0x845e: p.left = i16(g, at); break;
      case 0x8411: case 0x8460: p.first = i16(g, at); break;
      case 0x6412: p.line = i16(g, at); p.mult = i16(g, at + 2) === 1; break;
      case 0xa413: p.before = u16(g, at); break;
      case 0xa414: p.after = u16(g, at); break;
      case 0x245b: p.beforeAuto = g[at] === 1; break;
      case 0x245c: p.afterAuto = g[at] === 1; break;
      case 0x2431: p.widow = g[at] === 1; break;
      case 0x2434: p.wordWrap = g[at] === 1; break;
      case 0x2435: p.overflowPunct = g[at] === 1; break;
      case 0x2437: p.autoDE = g[at] === 1; break;
      case 0x2438: p.autoDN = g[at] === 1; break;
      case 0x2640: p.outLvl = g[at]; break;
      case 0x6424: p.brc = { ...p.brc, top: brc80(g, at) }; break;
      case 0x6425: p.brc = { ...p.brc, left: brc80(g, at) }; break;
      case 0x6426: p.brc = { ...p.brc, bottom: brc80(g, at) }; break;
      case 0x6427: p.brc = { ...p.brc, right: brc80(g, at) }; break;
      case 0x6428: p.brc = { ...p.brc, between: brc80(g, at) }; break;
      case 0xc64e: p.brc = { ...p.brc, top: brc(g, at + 1) }; break;
      case 0xc64f: p.brc = { ...p.brc, left: brc(g, at + 1) }; break;
      case 0xc650: p.brc = { ...p.brc, bottom: brc(g, at + 1) }; break;
      case 0xc651: p.brc = { ...p.brc, right: brc(g, at + 1) }; break;
      case 0xc652: p.brc = { ...p.brc, between: brc(g, at + 1) }; break;
      case 0x442d: p.shd = shd80(u16(g, at)); break;
      case 0xc64d: p.shd = shdOf(g, at + 1); break;
      case 0x261b: case 0x8419: case 0x2423: p.framed = true; break;
      case 0x8418: p.dxaAbs = i16(g, at); p.framed = true; break;
      // PChgTabsPapx: cb, itbdDelMax, rgdxaDel, itbdAddMax, rgdxaAdd, rgtbdAdd; PChgTabs: cb, cTabs, rgdxaDel, rgdxaClose,
      // cTabs, rgdxaAdd, rgtbdAdd — stops added: the paragraph has its own
      case 0xc60d: { const del = g[at + 1] ?? 0; if (g[at + 2 + del * 2]) p.tabs = true; break; }
      case 0xc615: { const del = g[at + 1] ?? 0; if (g[at + 2 + del * 4]) p.tabs = true; break; }
    }
  }
}

// ───────────────────────── XML ─────────────────────────

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
// (QA doc-rich-open: and no character XML does not allow — a control character in a font name, a style name, a comment's
// author or a field code made the whole package unreadable, and the file opened as text only)
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
const onOff = (name: string, v: boolean) => (v ? `<w:${name}/>` : `<w:${name} w:val="0"/>`);
const JC = ["left", "center", "right", "both", "distribute", "both", "both", "both", "both", "both"];

/** text as w:t / w:tab / w:br (\t, \n) */
function textXml(s: string, del = false): string {
  let out = "";
  const tag = del ? "w:delText" : "w:t";
  for (const part of s.split(/([\t\n])/)) {
    if (part === "\t") out += "<w:tab/>";
    else if (part === "\n") out += "<w:br/>";
    else if (part) out += `<${tag} xml:space="preserve">${esc(part)}</${tag}>`;
  }
  return out;
}

const brcXml = (side: string, b: Brc | undefined) => {
  if (!b || !b.type || b.type === 0xff) return `<w:${side} w:val="nil"/>`;
  const val = b.type === 3 ? "double" : b.type === 6 ? "dotted" : b.type === 7 ? "dashed" : b.type === 2 ? "thick" : "single";
  return `<w:${side} w:val="${val}" w:sz="${Math.max(2, b.w)}" w:space="${b.space}" w:color="${b.color ?? "auto"}"/>`;
};

// ───────────────────────── the reader ─────────────────────────

interface Style {
  sti: number;
  stk: number;
  base: number;
  /** the style of the paragraph Enter makes at the end of one of this style (Stdf istdNext) */
  next: number;
  name: string;
  papx: Uint8Array | null;
  chpx: Uint8Array | null;
}

/**
 * The style sheet (STSH at `fc` in the table stream: STSHI, then each STD — Stdf, name, UPXs) and the PAP / CHP each
 * paragraph style gives (its base's first), the CHPX chain of a character style, the CHP of a character with CHPX `g`
 * in a paragraph of style `pistd`. Throws when there is none.
 */
function styleSheet(table: Uint8Array, fc: number, lcb: number) {
  const styles: (Style | null)[] = [];
  let defFtc: [number, number, number] = [0, 0, 0];
  if (!lcb || fc + lcb > table.length) throw new Error("doc: no STSH");
  {
    const cbStshi = u16(table, fc);
    const shi = fc + 2;
    const cstd = u16(table, shi), cbBase = u16(table, shi + 2);
    if (cbStshi >= 18) defFtc = [u16(table, shi + 12), u16(table, shi + 14), u16(table, shi + 16)];
    let o = shi + cbStshi;
    for (let istd = 0; istd < cstd && o + 2 <= fc + lcb; istd++) {
      const cb = u16(table, o);
      const at = o + 2;
      o = at + cb;
      if (!cb) {
        styles.push(null);
        continue;
      }
      const sti = u16(table, at) & 0x0fff;
      const stk = u16(table, at + 2) & 0x0f;
      const base = u16(table, at + 2) >> 4;
      const cupx = u16(table, at + 4) & 0x0f;
      const next = u16(table, at + 4) >> 4;
      let q = at + cbBase;
      const cch = Math.min(u16(table, q), Math.max(0, (at + cb - q - 2) >> 1));
      let nm = "";
      for (let j = 0; j < cch; j++) nm += String.fromCharCode(u16(table, q + 2 + j * 2));
      q += 2 + cch * 2 + 2;
      const upx: Uint8Array[] = [];
      for (let k = 0; k < cupx && q + 2 <= at + cb; k++) {
        const n = u16(table, q);
        upx.push(table.slice(q + 2, q + 2 + n));
        q += 2 + n + (n & 1);
      }
      // paragraph style: PAPX (istd, grpprl), CHPX; character style: CHPX; table style: TAPX, PAPX, CHPX
      const papx = stk === 1 ? upx[0] ?? null : stk === 3 ? upx[1] ?? null : null;
      const chpx = stk === 1 ? upx[1] ?? null : stk === 2 ? upx[0] ?? null : stk === 3 ? upx[2] ?? null : null;
      styles.push({ sti, stk, base, next, name: nm, papx, chpx });
    }
  }
  const defChp = (): Chp => ({
    b: false, i: false, strike: false, dstrike: false, caps: false, smallCaps: false, vanish: false, u: 0, hps: 20, ftc: [...defFtc], ico: 0, cv: null, hl: 0, shd: null, iss: 0, dxaSpace: 0, scale: 100, istd: 10,
    del: false, ins: false, ibstIns: 0, ibstDel: 0, spec: false, pic: -1, ole2: false, data: false, pos: 0, sym: false, fe: false,
    kern: 0, lid: [0, 0, 0], hpsBi: 20, bBi: false, iBi: false, ftcBi: 0,
  });
  const papMemo = new Map<number, Pap>(), chpMemo = new Map<number, Chp>(), charMemo = new Map<number, Uint8Array[]>();
  /** a paragraph style's PAP (its base's first) */
  const stylePap = (istd: number, depth = 0): Pap => {
    let p = papMemo.get(istd);
    if (p) return p;
    const s = styles[istd];
    p = s && s.stk === 1 && depth < 16 ? { ...(s.base !== 0xfff && s.base !== istd ? stylePap(s.base, depth + 1) : DEF_PAP), brc: {} } : { ...DEF_PAP, brc: {} };
    if (s?.base !== 0xfff && s?.base !== undefined && s.base !== istd && depth < 16) p.brc = { ...stylePap(s.base, depth + 1).brc };
    if (s?.stk === 1 && s.papx && s.papx.length >= 2) applyPap(p, s.papx, 2);
    p.istd = istd;
    papMemo.set(istd, p);
    return p;
  };
  /** a paragraph style's CHP (its base's first) */
  const styleChp = (istd: number, depth = 0): Chp => {
    let c = chpMemo.get(istd);
    if (c) return c;
    const s = styles[istd];
    const b = s && s.stk === 1 && s.base !== 0xfff && s.base !== istd && depth < 16 ? styleChp(s.base, depth + 1) : defChp();
    c = { ...b, ftc: [...b.ftc] };
    if (s?.stk === 1 && s.chpx) applyChp(c, s.chpx, 0, b);
    chpMemo.set(istd, c);
    return c;
  };
  /** a character style's CHPX chain (base first) */
  const charChain = (istd: number): Uint8Array[] => {
    let ch = charMemo.get(istd);
    if (ch) return ch;
    ch = [];
    const seen = new Set<number>();
    for (let k = istd; styles[k]?.stk === 2 && !seen.has(k); k = styles[k]!.base) {
      seen.add(k);
      if (styles[k]!.chpx) ch.unshift(styles[k]!.chpx!);
    }
    charMemo.set(istd, ch);
    return ch;
  };
  /** the CHP of a character with CHPX `g` in a paragraph of style `pistd` (the style's, the character style's, its own) */
  const chpOf = (g: Uint8Array, pistd: number): Chp => {
    const ps = styleChp(pistd);
    let base: Chp = { ...ps, ftc: [...ps.ftc] };
    const sp = docSprms(g, 0) ?? [];
    const ist = sp.find((x) => x.sprm === 0x4a30);
    if (ist) {
      const istd = u16(g, ist.at);
      for (const cg of charChain(istd)) {
        const b2 = { ...base, ftc: [...base.ftc] as [number, number, number] };
        applyChp(b2, cg, 0, base);
        base = b2;
      }
      base.istd = istd;
    }
    const c = { ...base, ftc: [...base.ftc] as [number, number, number] };
    applyChp(c, g, 0, base);
    return c;
  };
  return { styles, defFtc, defChp, stylePap, styleChp, charChain, chpOf };
}

/** the toggle sprms (bold, italic, strike, small caps, caps, hidden, double strike, complex-script bold and italic) */
const TOGGLES = new Set([0x0835, 0x0836, 0x0837, 0x083a, 0x083b, 0x083c, 0x2a53, 0x085c, 0x085d]);

/** what of a character's CHP the document model shows (rPrXml): equal keys, equal look */
const chpLook = (c: Chp) => JSON.stringify([c.b, c.i, c.caps, c.smallCaps, c.strike, c.dstrike, c.cv ?? (ICO[c.ico] || null), c.dxaSpace, c.scale, c.hps, c.hl > 0 ? HL[c.hl] ?? "" : "", c.u ? (c.u === 3 ? 2 : 1) : 0, c.shd, c.iss === 1 || c.iss === 2 ? c.iss : 0, c.ftc, c.vanish, c.pos]);

/**
 * (doc-para-write) What the DOC save needs of the style sheet of a file (STSH at `fc` in its table stream):
 *  - `next(istd)`: the paragraph style Enter at the end of a paragraph of style `istd` gives the new one (Word: the
 *    style's "style for the following paragraph"), −1 when it is the same style or none is known;
 *  - `restyle(g, from, to)`: the CHPX a character with CHPX `g` in a paragraph of style `from` takes so that it looks the
 *    same in a paragraph of style `to` (two paragraphs joined: the joined one has the first one's style, the letters of
 *    the second keep their look, as the editor shows them) — `g` itself when it does, its sprms followed by the ones that
 *    set what differs, null when that cannot be said so.
 * Null when the file has no style sheet.
 */
export function docStyleTools(table: Uint8Array, fc: number, lcb: number) {
  let sh: ReturnType<typeof styleSheet>;
  try {
    sh = styleSheet(table, fc, lcb);
  } catch {
    return null;
  }
  const { styles, chpOf, charChain } = sh;
  const next = (istd: number) => {
    const s = styles[istd];
    if (!s || s.stk !== 1) return -1;
    const n = s.next;
    return n !== istd && n !== 0xfff && styles[n]?.stk === 1 ? n : -1;
  };
  const restyle = (g: Uint8Array, from: number, to: number): Uint8Array | null => {
    if (!docSprms(g, 0)) return null;
    const want = chpOf(g, from);
    const has = chpOf(g, to);
    // (QA doc-para-write: and what the model does not show but Word does — kerning, language, the complex-script size,
    // bold, italic and font; a language the file never names is left as the style has it)
    const hidden = (c: Chp) => JSON.stringify([c.kern, c.lid.map((v, k) => (want.lid[k] ? v : 0)), c.hpsBi, c.bBi, c.iBi, c.ftcBi]);
    // (QA doc-para-write: a toggle a character style sets is, in Word, the paragraph style's turned over (bold heading +
    // a bold character style: not bold) — the reader takes it as set; the letter gets it as direct formatting, which Word
    // takes as it is, so it shows what the reader shows in either paragraph)
    const forced = new Set<number>();
    const ist = (docSprms(g, 0) ?? []).find((x) => x.sprm === 0x4a30);
    if (ist) for (const cg of charChain(u16(g, ist.at))) for (const x of docSprms(cg, 0) ?? []) if (TOGGLES.has(x.sprm)) forced.add(x.sprm);
    if (!forced.size && chpLook(want) === chpLook(has) && hidden(want) === hidden(has)) return g;
    const out: number[] = [...g];
    const s8 = (sprm: number, v: number) => out.push(sprm & 255, sprm >> 8, v & 255);
    const s16 = (sprm: number, v: number) => out.push(sprm & 255, sprm >> 8, v & 255, (v >> 8) & 255);
    const tog = (sprm: number, a: boolean, b: boolean) => (a !== b || forced.has(sprm)) && s8(sprm, a ? 1 : 0);
    tog(0x0835, want.b, has.b);
    tog(0x0836, want.i, has.i);
    tog(0x0837, want.strike, has.strike);
    tog(0x083a, want.smallCaps, has.smallCaps);
    tog(0x083b, want.caps, has.caps);
    tog(0x083c, want.vanish, has.vanish);
    tog(0x2a53, want.dstrike, has.dstrike);
    if (want.u !== has.u) s8(0x2a3e, want.u);
    if (want.hps !== has.hps) s16(0x4a43, want.hps);
    [0x4a4f, 0x4a50, 0x4a51].forEach((sprm, k) => want.ftc[k] !== has.ftc[k] && s16(sprm, want.ftc[k]));
    if (want.cv !== has.cv || want.ico !== has.ico) {
      // (QA doc-para-write: the colour as a COLORREF too, auto included — sprmCIco alone left a style's sprmCCv colour
      // to Word's reading of which wins)
      const cv = want.cv ?? (ICO[want.ico] || null);
      s8(0x2a42, want.ico);
      out.push(0x70, 0x68, ...(cv ? [parseInt(cv.slice(0, 2), 16), parseInt(cv.slice(2, 4), 16), parseInt(cv.slice(4, 6), 16), 0] : [0, 0, 0, 0xff]));
    }
    if (want.hl !== has.hl) s8(0x2a0c, want.hl);
    if (want.shd !== has.shd) {
      // SHD: cvFore, cvBack, ipat (clear: the back colour; 0xFFFF: none)
      const v = want.shd;
      const rgb = v ? [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 0] : [0, 0, 0, 0xff];
      out.push(0x71, 0xca, 10, 0, 0, 0, 0xff, ...rgb, ...(v ? [0, 0] : [0xff, 0xff]));
    }
    if (want.iss !== has.iss) s8(0x2a48, want.iss);
    if (want.dxaSpace !== has.dxaSpace) s16(0x8840, want.dxaSpace);
    if (want.scale !== has.scale) s16(0x4852, want.scale);
    if (want.pos !== has.pos) s16(0x4845, want.pos);
    if (want.kern !== has.kern) s16(0x484b, want.kern);
    [0x486d, 0x486e, 0x485f].forEach((sprm, k) => want.lid[k] && want.lid[k] !== has.lid[k] && s16(sprm, want.lid[k]));
    if (want.hpsBi !== has.hpsBi) s16(0x4a61, want.hpsBi);
    tog(0x085c, want.bBi, has.bBi);
    tog(0x085d, want.iBi, has.iBi);
    if (want.ftcBi !== has.ftcBi) s16(0x4a5e, want.ftcBi);
    const g2 = Uint8Array.from(out);
    const got = chpOf(g2, to);
    return g2.length <= 255 && chpLook(got) === chpLook(want) && hidden(got) === hidden(want) ? g2 : null;
  };
  return { next, restyle };
}

/** An STTB of extended (UTF-16) strings at `fc` ([MS-DOC] STTB): the strings (empty array when there is none). */
function sttb(table: Uint8Array, fc: number, lcb: number): string[] {
  if (lcb < 4 || fc + lcb > table.length) return [];
  let o = fc;
  const ext = u16(table, o) === 0xffff;
  if (ext) o += 2;
  const n = u16(table, o), cbExtra = u16(table, o + 2);
  o += 4;
  const out: string[] = [];
  for (let k = 0; k < n && o < fc + lcb; k++) {
    if (ext) {
      const c = u16(table, o);
      let s = "";
      for (let j = 0; j < c; j++) s += String.fromCharCode(u16(table, o + 2 + j * 2));
      out.push(s);
      o += 2 + c * 2;
    } else {
      const c = table[o];
      let s = "";
      for (let j = 0; j < c; j++) s += String.fromCharCode(table[o + 1 + j]);
      out.push(s);
      o += 1 + c;
    }
    o += cbExtra;
  }
  return out;
}

/** What the open left out or approximated (each a notice) */
interface Gaps {
  pictures: number;
  objects: number;
  comments: number;
  cellNotes: number;
  cellLists: number;
  nested: number;
  hidden: number;
}

export interface DocRichOpen {
  pages: Page[];
  assets: Record<string, AssetRef>;
  warnings: string[];
  paras: number;
  tables: number;
  pictures: number;
  /** for each table of the body: for each row, the column of the table node each of the file's cells is in */
  cellMap: number[][][];
}

/**
 * The text of a paragraph as the DOC reader reads it (docStory): its runs' letters without the list marker the
 * import puts in front, the note references' marks and the in-line objects.
 */
export function docParaText(p: TextParagraph): string {
  let skip = markerLength(p);
  let out = "";
  for (const r of p.runs) {
    let s = r.text;
    if (skip) {
      const k = Math.min(skip, s.length);
      s = s.slice(k);
      skip -= k;
    }
    if (r.note || r.noteMark || r.obj) continue;
    out += s;
  }
  return out;
}

/**
 * Open a .doc with its formatting (above). Throws when the file does not read so (then it opens as text only).
 */
export function docRichOpen(bytes: Uint8Array, name: string): DocRichOpen {
  const cfb = readCfb(bytes);
  const m = docMainFrom(cfb.get("WordDocument"), (n) => cfb.get(n));
  const { wd, table } = m;
  const lw = (i: number) => u32(wd, m.lw + i * 4);
  // (QA doc-rich-open: a pair that runs past the table stream is none — its count would drive the loops below: a
  // forged lcb of PlcfandTxt / PlcfSed ran the renderer out of memory)
  const pair = (i: number) => {
    const p = docPair(m, i);
    return p.fc + p.lcb <= table.length ? p : { fc: 0, lcb: 0 };
  };
  const ccp = { text: lw(LW.text), ftn: lw(LW.ftn), hdd: lw(LW.hdd), mcr: lw(LW.mcr), atn: lw(LW.atn), edn: lw(LW.edn), txbx: lw(LW.txbx) };
  const start = { ftn: ccp.text, hdd: ccp.text + ccp.ftn, atn: ccp.text + ccp.ftn + ccp.hdd + ccp.mcr, edn: ccp.text + ccp.ftn + ccp.hdd + ccp.mcr + ccp.atn };
  const text = m.text;
  if (!m.papx) throw new Error("doc: no PAPX");
  const kind = (cp: number) => docMarkKind(m, cp);
  const story = docStory(text.slice(0, ccp.text), kind);
  const gaps: Gaps = { pictures: 0, objects: 0, comments: 0, cellNotes: 0, cellLists: 0, nested: 0, hidden: 0 };
  // formats the model has no place for, met where they show (QA doc-rich-open: they were left out without a word)
  const looks = new Set<Look>();
  /** a shown letter's formats the model does not have */
  const lookOf = (c: Chp, s: string) => {
    if ((c.caps || c.smallCaps) && s !== s.toUpperCase()) looks.add("caps");
    if (c.pos) looks.add("position");
    if (c.sym) looks.add("symbol");
    if (c.fe) looks.add("eastAsian");
  };
  // hyperlinks: their text shown, the link not kept
  for (let cp = 0, found = false; cp < ccp.text && !found; cp++)
    if (text.charCodeAt(cp) === 0x13 && /^\s*HYPERLINK\b/i.test(text.slice(cp + 1, cp + 40))) looks.add("link"), (found = true);

  // fonts (SttbfFfn: FFN — 39 bytes, then the name)
  const fonts: string[] = [];
  {
    const { fc, lcb } = pair(P.ffn);
    if (lcb >= 4 && fc + lcb <= table.length) {
      const n = u16(table, fc);
      let o = fc + 4;
      for (let k = 0; k < n && o < fc + lcb; k++) {
        const cb = table[o];
        let s = "";
        for (let j = o + 1 + 39; j + 1 < o + 1 + cb && u16(table, j); j += 2) s += String.fromCharCode(u16(table, j));
        fonts.push(s);
        o += 1 + cb;
      }
    }
  }
  const font = (ftc: number) => fonts[ftc] || fonts[0] || "Times New Roman";

  // styles (STSH: STSHI, then each STD — Stdf, name, UPXs)
  const sheet = (() => {
    const { fc, lcb } = pair(P.stsh);
    return styleSheet(table, fc, lcb);
  })();
  const { styles, stylePap, styleChp, charChain, defChp, defFtc } = sheet;

  // CHPX of a CP
  const bteChpx = (() => {
    const { fc, lcb } = pair(P.chpx);
    if (lcb < 12 || (lcb - 4) % 8 || fc + lcb > table.length) return null;
    const n = (lcb - 4) / 8;
    const fcs: number[] = [], pns: number[] = [];
    for (let i = 0; i <= n; i++) fcs.push(u32(table, fc + i * 4));
    for (let i = 0; i < n; i++) pns.push(u32(table, fc + (n + 1) * 4 + i * 4) & 0x3fffff);
    return { fcs, pns };
  })();
  if (!bteChpx) throw new Error("doc: no CHPX");
  const chpxAt = (cp: number): Uint8Array => {
    const p = docPieceAt(m, cp);
    const r = p && docFkpRun(wd, bteChpx, docFcAt(p, cp));
    if (!r) return new Uint8Array(0);
    const b = wd[r.page + (r.crun + 1) * 4 + r.j];
    if (!b) return new Uint8Array(0);
    const at = r.page + b * 2;
    return wd.subarray(at + 1, at + 1 + wd[at]);
  };
  const runMemo = new Map<string, Chp>();
  /** the CHP of the character at `cp` in a paragraph of style `pistd` */
  const chpAt = (cp: number, pistd: number): Chp => {
    const g = chpxAt(cp);
    const key = pistd + "|" + g.join(",");
    let c = runMemo.get(key);
    if (c) return c;
    const ps = styleChp(pistd);
    let base: Chp = { ...ps, ftc: [...ps.ftc] };
    const sp = docSprms(g, 0) ?? [];
    const ist = sp.find((x) => x.sprm === 0x4a30);
    if (ist) {
      const istd = u16(g, ist.at);
      for (const cg of charChain(istd)) {
        const b2 = { ...base, ftc: [...base.ftc] as [number, number, number] };
        applyChp(b2, cg, 0, base);
        base = b2;
      }
      base.istd = istd;
    }
    c = { ...base, ftc: [...base.ftc] };
    applyChp(c, g, 0, base);
    runMemo.set(key, c);
    return c;
  };
  /** the PAP of the paragraph whose mark is at `cp` (−1: the defaults) */
  const papAt = (cp: number): Pap => {
    const g = cp >= 0 ? docPapxAt(m, cp) : null;
    if (!g || g.length < 2) return { ...stylePap(0), brc: { ...stylePap(0).brc } };
    const s = stylePap(u16(g, 0));
    const p = { ...s, brc: { ...s.brc } };
    applyPap(p, g, 2);
    const sp = docSprms(g, 2) ?? [];
    p.own = { left: sp.some((x) => x.sprm === 0x840f || x.sprm === 0x845e), first: sp.some((x) => x.sprm === 0x8411 || x.sprm === 0x8460) };
    return p;
  };

  // revision authors
  const authors = sttb(table, pair(P.rmark).fc, pair(P.rmark).lcb);

  const rPrXml = (c: Chp) => {
    let x = `<w:rFonts w:ascii="${esc(font(c.ftc[0]))}" w:hAnsi="${esc(font(c.ftc[2]))}" w:eastAsia="${esc(font(c.ftc[1]))}"/>`;
    x += onOff("b", c.b) + onOff("i", c.i);
    if (c.caps) x += "<w:caps/>";
    if (c.smallCaps) x += "<w:smallCaps/>";
    x += onOff("strike", c.strike);
    if (c.dstrike) x += "<w:dstrike/>";
    const color = c.cv ?? (ICO[c.ico] || null);
    x += `<w:color w:val="${color ?? "auto"}"/>`;
    if (c.dxaSpace) x += `<w:spacing w:val="${c.dxaSpace}"/>`;
    if (c.scale && c.scale !== 100) x += `<w:w w:val="${c.scale}"/>`;
    x += `<w:sz w:val="${c.hps}"/>`;
    if (c.hl > 0 && HL[c.hl]) x += `<w:highlight w:val="${HL[c.hl]}"/>`;
    x += `<w:u w:val="${c.u ? (c.u === 3 ? "double" : "single") : "none"}"/>`;
    if (c.shd) x += `<w:shd w:val="clear" w:color="auto" w:fill="${c.shd}"/>`;
    if (c.iss === 1 || c.iss === 2) x += `<w:vertAlign w:val="${c.iss === 1 ? "superscript" : "subscript"}"/>`;
    return `<w:rPr>${x}</w:rPr>`;
  };

  // ── lists (PlfLst + LVLs, PlfLfo) ──
  const numbering: string[] = [];
  const lfoIds = new Set<number>(), oddLfo = new Set<number>();
  {
    const L = pair(P.lst), F = pair(P.lfo);
    if (L.lcb >= 2 && L.fc + L.lcb <= table.length && F.lcb >= 4 && F.fc + F.lcb <= table.length) {
      // (counts no larger than their tables hold: a forged lfoMac ran the open for ever — QA doc-rich-open)
      const cLst = Math.min(u16(table, L.fc), Math.floor((L.lcb - 2) / 28));
      const lsts: { lsid: number; simple: boolean; lvls: string[]; odd: boolean }[] = [];
      let lv = L.fc + 2 + cLst * 28;
      for (let k = 0; k < cLst; k++) {
        const o = L.fc + 2 + k * 28;
        const simple = (table[o + 26] & 1) === 1;
        const lvls: string[] = [];
        let odd = false;
        for (let il = 0; il < (simple ? 1 : 9) && lv + 28 <= table.length; il++) {
          const start = i32(table, lv), nfc = table[lv + 4], jc = table[lv + 5] & 3, follow = table[lv + 15];
          // (legal numbering, fLegal, and a restart rule of its own, fNoRestart: not in the model — named in a notice)
          if (table[lv + 5] & 0x0c) odd = true;
          const cbChp = table[lv + 24], cbPap = table[lv + 25];
          const pg = table.subarray(lv + 28, lv + 28 + cbPap);
          const cg = table.subarray(lv + 28 + cbPap, lv + 28 + cbPap + cbChp);
          let q = lv + 28 + cbPap + cbChp;
          if (q + 2 > table.length) break;
          const cch = Math.min(u16(table, q), (table.length - q - 2) >> 1);
          let lt = "";
          for (let j = 0; j < cch; j++) {
            const ch = u16(table, q + 2 + j * 2);
            lt += ch < 9 ? `%${ch + 1}` : String.fromCharCode(ch);
          }
          q += 2 + cch * 2;
          lv = q;
          const lp: Pap = { ...DEF_PAP, brc: {} };
          applyPap(lp, pg, 0);
          const lc = defChp();
          applyChp(lc, cg, 0, defChp());
          const fontSet = (docSprms(cg, 0) ?? []).some((x) => x.sprm === 0x4a4f || x.sprm === 0x4a51);
          const fmt = NFC[nfc] ?? "decimal";
          lvls.push(
            `<w:lvl w:ilvl="${il}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:suff w:val="${follow === 1 ? "space" : follow === 2 ? "nothing" : "tab"}"/><w:lvlText w:val="${esc(lt)}"/><w:lvlJc w:val="${["left", "center", "right"][jc] ?? "left"}"/>` +
              `<w:pPr><w:ind w:left="${lp.left}" ${lp.first < 0 ? `w:hanging="${-lp.first}"` : `w:firstLine="${lp.first}"`}/></w:pPr>` +
              (fontSet ? `<w:rPr><w:rFonts w:ascii="${esc(font(lc.ftc[0]))}" w:hAnsi="${esc(font(lc.ftc[2]))}"/></w:rPr>` : "") +
              `</w:lvl>`,
          );
        }
        lsts.push({ lsid: i32(table, o), simple, lvls, odd });
      }
      lsts.forEach((l, k) => numbering.push(`<w:abstractNum w:abstractNumId="${k}"><w:multiLevelType w:val="${l.simple ? "singleLevel" : "multilevel"}"/>${l.lvls.join("")}</w:abstractNum>`));
      const lfoMac = Math.min(u32(table, F.fc), Math.floor((F.lcb - 4) / 16));
      const absOf = new Map<number, number>();
      lsts.forEach((l, k) => absOf.has(l.lsid) || absOf.set(l.lsid, k));
      let d = F.fc + 4 + lfoMac * 16;
      const nums: string[] = [];
      for (let k = 0; k < lfoMac; k++) {
        const o = F.fc + 4 + k * 16;
        const lsid = i32(table, o), clfolvl = table[o + 12];
        const abs = absOf.get(lsid) ?? -1;
        // LFOData: cp, then LFOLVL (iStartAt, iLvl / fStartAt / fFormatting, an LVL when fFormatting)
        let over = "";
        if (clfolvl && d + 4 <= F.fc + F.lcb + 4096) {
          let q = d + 4;
          for (let j = 0; j < clfolvl && q + 8 <= table.length; j++) {
            const st = i32(table, q), fl = u32(table, q + 4);
            q += 8;
            if (fl & 0x10) over += `<w:lvlOverride w:ilvl="${fl & 0xf}"><w:startOverride w:val="${st}"/></w:lvlOverride>`;
            if (fl & 0x20) {
              // (an LVL of its own: stepped over)
              const cbChp = table[q + 24], cbPap = table[q + 25];
              q += 28 + cbPap + cbChp;
              q += 2 + u16(table, q) * 2;
            }
          }
          d = q;
        } else d += 4;
        if (abs < 0) continue;
        lfoIds.add(k + 1);
        if (lsts[abs].odd) oddLfo.add(k + 1);
        nums.push(`<w:num w:numId="${k + 1}"><w:abstractNumId w:val="${abs}"/>${over}</w:num>`);
      }
      numbering.push(...nums);
    }
  }

  // ── pictures in the line (PICF in the Data stream) ──
  const pictures: OfficePic[] = [];
  const picAt = (cp: number, c: Chp, item: number, para: TextParagraph | null, offset: number, look: TextParagraph | null): boolean => {
    const data = m.data;
    if (!data || c.pic < 0 || c.ole2 || c.data || c.pic + 0x44 > data.length) return false;
    const at = c.pic;
    const lcb = u32(data, at), cbHeader = u16(data, at + 4), mm = u16(data, at + 6);
    if (cbHeader !== 0x44 || at + lcb > data.length || lcb < 0x44) return false;
    const dxa = i16(data, at + 0x1c), dya = i16(data, at + 0x1e), mx = u16(data, at + 0x20), my = u16(data, at + 0x22);
    let o = at + cbHeader;
    if (mm === 0x66) o += 1 + data[o];
    const blip = findBlip(data, o, at + lcb);
    if (!blip) return false;
    const w = ((dxa * (mx || 1000)) / 1000 / 20) * (96 / 72), h = ((dya * (my || 1000)) / 1000 / 20) * (96 / 72);
    if (!(w > 0 && h > 0)) return false;
    if (!para || !look) return false;
    // (in a paragraph of its own: in that paragraph's place, before its empty line; with letters: after the
    // paragraph, as the DOCX importer places a picture in the line)
    const alone = !docParaText(para).trim();
    pictures.push({
      id: `docpic-${cp}`,
      at: alone ? item : item + 1,
      tail: !alone,
      bytes: blip.bytes,
      mime: blip.mime,
      name: t("engine.default.image"),
      g: { x: 0, y: 0, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100, rot: 0, flipH: false, flipV: false, crop: null },
      offset,
      own: false,
      part: "doc",
      b: -1,
      k: pictures.length,
      para: para.id,
      inline: { align: look.align, indent: look.indentLeft ?? 0, before: 0, after: 0 },
    });
    return true;
  };
  /** pictures found in paragraphs: item index, char offset, CP (placed once the items are read) */
  const picRefs: { item: number; offset: number; cp: number; c: Chp }[] = [];

  // ── floating pictures: 0x08 at their anchor, FSPA (PlcSpaMom), the shape's BLIP (OfficeArt: pib → BStore) ──
  const floats = new Map<number, { spid: number; x0: number; y0: number; x1: number; y1: number; bx: number; by: number; wr: number; below: boolean }>();
  {
    const { fc, lcb } = pair(P.spaMom);
    const n = lcb >= 30 ? (lcb - 4) / 30 : 0;
    for (let k = 0; k < n && Number.isInteger(n); k++) {
      const o = fc + (n + 1) * 4 + k * 26;
      const fl = u16(table, o + 20);
      floats.set(u32(table, fc + k * 4), { spid: i32(table, o), x0: i32(table, o + 4), y0: i32(table, o + 8), x1: i32(table, o + 12), y1: i32(table, o + 16), bx: (fl >> 1) & 3, by: (fl >> 3) & 3, wr: (fl >> 5) & 15, below: (fl & 0x4000) !== 0 });
    }
  }
  const blipOfSpid = floats.size ? officeArtBlips(table, pair(P.dgg).fc, pair(P.dgg).lcb, wd) : new Map<number, { bytes: Uint8Array; mime: string }>();
  /** floating pictures found: their anchor's item, char offset, CP */
  const floatRefs: { item: number; offset: number; cp: number }[] = [];
  const floatAt = (cp: number, item: number, para: TextParagraph, offset: number): boolean => {
    const f = floats.get(cp);
    const blip = f && blipOfSpid.get(f.spid);
    if (!f || !blip) return false;
    const px = (tw: number) => Math.round((tw / 20) * (96 / 72) * 100) / 100;
    const w = px(f.x1 - f.x0), h = px(f.y1 - f.y0);
    if (!(w > 0 && h > 0)) return false;
    // FSPA wr: 1 top and bottom, 3 none (in front of / behind the text), else around it (square)
    const wrap = f.wr === 3 ? (f.below ? "behind" : "front") : f.wr === 1 ? "topBottom" : "square";
    pictures.push({
      id: `docpic-${cp}`,
      at: item + 1,
      tail: true,
      bytes: blip.bytes,
      mime: blip.mime,
      name: t("engine.default.image"),
      g: { x: 0, y: 0, w, h, rot: 0, flipH: false, flipV: false, crop: null },
      offset,
      own: false,
      part: "doc",
      b: -1,
      k: pictures.length,
      para: para.id,
      // bx / by: 0 the margin, 1 the page, 2 the column / the paragraph
      float: { x: px(f.x0), xFrom: f.bx === 1 ? "page" : "margin", y: px(f.y0), yFrom: f.by === 1 ? "page" : f.by === 2 ? "para" : "margin", wrap, gapBelow: 0 },
    });
    return true;
  };

  // ── note references ──
  const refs = (refPair: number) => {
    const { fc, lcb } = pair(refPair);
    if (lcb < 6 || fc + lcb > table.length) return [] as number[];
    const n = Math.floor((lcb - 4) / 6);
    return Array.from({ length: n }, (_, k) => u32(table, fc + k * 4));
  };
  const ftnRefs = refs(P.fndRef), endRefs = refs(P.endRef);
  const noteTxt = (txtPair: number, base: number) => {
    const { fc, lcb } = pair(txtPair);
    if (lcb < 8 || fc + lcb > table.length) return [] as [number, number][];
    const n = Math.floor(lcb / 4) - 1;
    const cps = Array.from({ length: n + 1 }, (_, k) => u32(table, fc + k * 4));
    // (a story's places in order, as every PLC: else each note could read the whole story again — QA doc-rich-open)
    if (!ascending(cps)) throw new Error("doc: notes");
    return Array.from({ length: Math.max(0, n - 1) }, (_, k) => [base + cps[k], base + cps[k + 1]] as [number, number]);
  };
  const ftnTxt = noteTxt(P.fndTxt, start.ftn), endTxt = noteTxt(P.endTxt, start.edn);

  // ── comments: PlcfandRef (ATRDPre10: initials, the author in GrpXstAtnOwners, the tag of its range's bookmark),
  // their text (PlcfandTxt), their ranges (SttbfAtnBkmk tags, PlcfAtnBkf / PlcfAtnBkl) ──
  const atn = (() => {
    const R = pair(P.andRef);
    const n = R.lcb >= 34 && (R.lcb - 4) % 34 === 0 ? (R.lcb - 4) / 34 : 0;
    const owners: string[] = [];
    {
      const { fc, lcb } = pair(P.atnOwners);
      for (let o = fc; lcb && o + 2 <= fc + lcb && o + 2 <= table.length; ) {
        const c = u16(table, o);
        let s = "";
        for (let j = 0; j < c; j++) s += String.fromCharCode(u16(table, o + 2 + j * 2));
        owners.push(s);
        o += 2 + c * 2;
      }
    }
    // the bookmarks of the comments' ranges: tag → [start, end)
    const ranges = new Map<number, [number, number]>();
    {
      const S = pair(P.atnBkmk), F = pair(P.atnBkf), L = pair(P.atnBkl);
      if (S.lcb >= 6 && u16(table, S.fc) === 0xffff && F.lcb >= 8 && L.lcb >= 4) {
        const cnt = u16(table, S.fc + 2), extra = u16(table, S.fc + 4);
        const m2 = (F.lcb - 4) / 8;
        let o = S.fc + 6;
        for (let k = 0; k < cnt && k < m2; k++) {
          const c = u16(table, o);
          const tag = i32(table, o + 2 + c * 2 + 2);
          o += 2 + c * 2 + extra;
          const ibkl = i16(table, F.fc + (m2 + 1) * 4 + k * 4);
          const s0 = u32(table, F.fc + k * 4), e0 = u32(table, L.fc + ibkl * 4);
          if (ibkl >= 0 && L.fc + ibkl * 4 + 4 <= table.length) ranges.set(tag, [s0, e0]);
        }
      }
    }
    const T = pair(P.andTxt);
    const txt = T.lcb >= 8 ? Array.from({ length: Math.floor(T.lcb / 4) }, (_, k) => start.atn + u32(table, T.fc + k * 4)) : [];
    if (!ascending(txt)) throw new Error("doc: comments");
    const list: { cp: number; author: string; initials: string; text: [number, number] | null; range: [number, number] | null }[] = [];
    for (let k = 0; k < n; k++) {
      const o = R.fc + (n + 1) * 4 + k * 30;
      const ci = Math.min(9, u16(table, o));
      let ini = "";
      for (let j = 0; j < ci; j++) ini += String.fromCharCode(u16(table, o + 2 + j * 2));
      const tag = i32(table, o + 26);
      list.push({ cp: u32(table, R.fc + k * 4), author: owners[i16(table, o + 20)] ?? "", initials: ini, text: k + 1 < txt.length ? [txt[k], txt[k + 1]] : null, range: tag >= 0 ? ranges.get(tag) ?? null : null });
    }
    return list;
  })();
  // (each reference's index by its CP, the first of a CP: as indexOf found it, once)
  const firstAt = (cps: readonly number[]) => {
    const out = new Map<number, number>();
    cps.forEach((cp, k) => out.has(cp) || out.set(cp, k));
    return out;
  };
  const ftnAt = firstAt(ftnRefs), endAt = firstAt(endRefs), atnAt = firstAt(atn.map((x) => x.cp));
  const atnStarts = new Map<number, number[]>(), atnEnds = new Map<number, number[]>();
  atn.forEach((x, k) => {
    if (!x.range || !x.text) return;
    (atnStarts.get(x.range[0]) ?? atnStarts.set(x.range[0], []).get(x.range[0])!).push(k);
    (atnEnds.get(x.range[1]) ?? atnEnds.set(x.range[1], []).get(x.range[1])!).push(k);
  });

  // ── a story's text (notes, headers, footers) as paragraphs ──
  /** the shown characters of [a, b) by paragraph (CR ends one; the CRs of tables' cells too): field results, PAGE fields */
  const storyParas = (a: number, b: number, opts: { fields: boolean; noteKind?: "foot" | "end" }): string[] => {
    const out: string[] = [];
    let cur = "";
    let run: { key: string; rpr: string; text: string; del: boolean } | null = null;
    const flush = () => {
      if (run) cur += run.del ? `<w:r>${run.rpr}${textXml(run.text, true)}</w:r>` : `<w:r>${run.rpr}${textXml(run.text)}</w:r>`;
      run = null;
    };
    // fields: their code skipped, their result shown; PAGE / NUMPAGES … as Word's complex field (opts.fields)
    const stack: { instr: string; result: boolean; fld: boolean }[] = [];
    let pap = papAt(nextMarkIn(text, a, b));
    for (let cp = a; cp < b; cp++) {
      const ch = text[cp];
      const c = ch.charCodeAt(0);
      if (c === 0x13) {
        flush();
        stack.push({ instr: "", result: false, fld: false });
        continue;
      }
      const top = stack[stack.length - 1];
      if (c === 0x14 && top) {
        top.result = true;
        const kind = docxFieldKind(top.instr);
        if (opts.fields && stack.length === 1 && kind) {
          top.fld = true;
          const rpr = rPrXml(chpAt(cp, pap.istd));
          cur += `<w:r>${rpr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rpr}<w:instrText xml:space="preserve">${esc(top.instr)}</w:instrText></w:r><w:r>${rpr}<w:fldChar w:fldCharType="separate"/></w:r>`;
        }
        continue;
      }
      if (c === 0x15 && top) {
        flush();
        const kind = docxFieldKind(top.instr);
        if (top.fld) cur += `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
        else if (opts.fields && stack.length === 1 && kind && !top.result) {
          const rpr = rPrXml(chpAt(cp, pap.istd));
          cur += `<w:r>${rpr}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rpr}<w:instrText xml:space="preserve">${esc(top.instr)}</w:instrText></w:r><w:r>${rpr}<w:fldChar w:fldCharType="end"/></w:r>`;
        }
        stack.pop();
        continue;
      }
      if (top && !top.result) {
        top.instr += ch;
        continue;
      }
      if (ch === "\r" || ch === "\x07") {
        flush();
        out.push(paraXml(pap, cur, { mark: rPrXml(chpAt(cp, pap.istd)) }));
        cur = "";
        pap = papAt(nextMarkIn(text, cp + 1, b));
        continue;
      }
      const cc = chpAt(cp, pap.istd);
      // (pictures and drawn objects of headers, footers and notes: not read)
      if (cc.spec && (c === 0x01 || c === 0x08) && !stack.length) {
        if (c === 0x01 && !cc.ole2) gaps.pictures++;
        else gaps.objects++;
        continue;
      }
      if (c === 0x02 && cc.spec && opts.noteKind) {
        flush();
        cur += `<w:r>${rPrXml(cc)}<w:${opts.noteKind}noteRef/></w:r>`;
        continue;
      }
      const s = ch === "\x0b" ? "\n" : /[\x00-\x08\x0c\x0e-\x1f]/.test(ch) ? "" : ch;
      if (!s) continue;
      lookOf(cc, s);
      if (s === "\t" && pap.tabs) looks.add("tabs");
      const rpr = rPrXml(cc);
      const key = rpr + (cc.del ? "D" : "");
      if (run && run.key === key) run.text += s;
      else {
        flush();
        run = { key, rpr, text: s, del: cc.del };
      }
    }
    flush();
    if (cur) out.push(paraXml(pap, cur));
    return out;
  };

  // ── paragraph properties ──
  const pPrXml = (p: Pap, opts: { list?: boolean; sect?: string; mark?: string } = {}) => {
    let x = `<w:pStyle w:val="s${p.istd}"/>`;
    x += onOff("keepNext", p.keepNext) + onOff("keepLines", p.keep) + onOff("pageBreakBefore", p.pageBreak);
    if (p.framed && p.dxaAbs !== null && [-4, -8, -12, -16].includes(p.dxaAbs)) x += `<w:framePr w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:xAlign="${{ [-4]: "center", [-8]: "right", [-12]: "inside", [-16]: "outside" }[p.dxaAbs]}" w:y="1"/>`;
    x += onOff("widowControl", p.widow);
    if (opts.list && oddLfo.has(p.ilfo)) looks.add("numbering");
    if (opts.list && p.ilfo > 0 && lfoIds.has(p.ilfo)) x += `<w:numPr><w:ilvl w:val="${Math.min(8, p.ilvl)}"/><w:numId w:val="${p.ilfo}"/></w:numPr>`;
    const sides = (["top", "left", "bottom", "right", "between"] as const).filter((s) => p.brc[s] && p.brc[s]!.type && p.brc[s]!.type !== 0xff);
    if (sides.length) x += `<w:pBdr>${sides.map((s) => brcXml(s, p.brc[s])).join("")}</w:pBdr>`;
    if (p.shd) x += `<w:shd w:val="clear" w:color="auto" w:fill="${p.shd}"/>`;
    x += `<w:spacing w:before="${p.before}"${p.beforeAuto ? ' w:beforeAutospacing="1"' : ""} w:after="${p.after}"${p.afterAuto ? ' w:afterAutospacing="1"' : ""} w:line="${Math.abs(p.line) || 240}" w:lineRule="${p.mult ? "auto" : p.line < 0 ? "exact" : "atLeast"}"/>`;
    // (a list paragraph: only the indents it gives itself — the level's come next, as Word takes them)
    const listed = opts.list && p.ilfo > 0 && lfoIds.has(p.ilfo);
    const first = p.first < 0 ? `w:hanging="${-p.first}"` : `w:firstLine="${p.first}"`;
    if (!listed) x += `<w:ind w:left="${p.left}" w:right="${p.right}" ${first}/>`;
    else if (p.own?.left || p.own?.first || p.right) x += `<w:ind${p.own?.left ? ` w:left="${p.left}"` : ""}${p.right ? ` w:right="${p.right}"` : ""}${p.own?.first ? " " + first : ""}/>`;
    x += `<w:jc w:val="${JC[p.jc] ?? "left"}"/>`;
    if (p.outLvl < 9) x += `<w:outlineLvl w:val="${p.outLvl}"/>`;
    return `<w:pPr>${x}${opts.mark ?? ""}${opts.sect ?? ""}</w:pPr>`;
  };
  const paraXml = (p: Pap, runs: string, opts: { list?: boolean; sect?: string; mark?: string } = {}) => `<w:p>${pPrXml(p, opts)}${runs}</w:p>`;

  /**
   * The runs of a paragraph of the main story: `cps` its letters as the reader shows them (cleaned), [a, b) its
   * characters; pictures and note references where they are. `item` the body item it is (null in a cell).
   */
  const bodyRuns = (a: number, b: number, cps: readonly number[], pistd: number, item: number | null): string => {
    const keep = new Set(cps);
    let out = "";
    let run: { key: string; rpr: string; text: string; del: boolean; ins: boolean; author: string } | null = null;
    const flush = () => {
      if (!run) return;
      const r = `<w:r>${run.rpr}${textXml(run.text, run.del)}</w:r>`;
      out += run.del ? `<w:del w:id="0" w:author="${esc(run.author)}">${r}</w:del>` : run.ins ? `<w:ins w:id="0" w:author="${esc(run.author)}">${r}</w:ins>` : r;
      run = null;
    };
    let shownBefore = 0;
    /** comment ranges ending / starting at a CP (their bookmarks' places) */
    const marks = (cp: number) => {
      const e = atnEnds.get(cp), s = atnStarts.get(cp);
      if (!e && !s) return;
      flush();
      for (const k of e ?? []) out += `<w:commentRangeEnd w:id="${k}"/>`;
      for (const k of s ?? []) out += `<w:commentRangeStart w:id="${k}"/>`;
    };
    for (let cp = a; cp < b; cp++) {
      marks(cp);
      if (!story.shown[cp]) continue;
      const ch = text[cp];
      const c = ch.charCodeAt(0);
      if (keep.has(cp)) {
        const cc = chpAt(cp, pistd);
        if (cc.vanish) gaps.hidden++;
        lookOf(cc, ch);
        const s = ch === "\x0b" || ch === "\r" ? "\n" : ch;
        const rpr = rPrXml(cc);
        const author = cc.del ? authors[cc.ibstDel] ?? "" : cc.ins ? authors[cc.ibstIns] ?? "" : "";
        const key = rpr + (cc.del ? "D" : cc.ins ? "I" : "") + author;
        if (run && run.key === key) run.text += s;
        else {
          flush();
          run = { key, rpr, text: s, del: cc.del, ins: cc.ins, author };
        }
        shownBefore++;
        continue;
      }
      if (c === 0x01 || c === 0x02 || c === 0x05 || c === 0x08) {
        const cc = chpAt(cp, pistd);
        if (c === 0x02 && cc.spec) {
          const fk = ftnAt.get(cp) ?? -1, ek = endAt.get(cp) ?? -1;
          if (item === null) gaps.cellNotes++;
          else if (fk >= 0 || ek >= 0) {
            flush();
            out += `<w:r>${rPrXml(cc)}<w:${fk >= 0 ? "footnote" : "endnote"}Reference w:id="${(fk >= 0 ? fk : ek) + 1}"/></w:r>`;
          }
        } else if (c === 0x01 && cc.spec && !story.inField[cp]) {
          if (cc.ole2) gaps.objects++;
          else if (item === null || cc.data || cc.pic < 0) gaps.pictures++;
          else picRefs.push({ item, offset: shownBefore, cp, c: cc });
        } else if (c === 0x05 && cc.spec) {
          const k = atnAt.get(cp) ?? -1;
          if (k >= 0 && atn[k].text) {
            flush();
            out += `<w:r>${rPrXml(cc)}<w:commentReference w:id="${k}"/></w:r>`;
          } else gaps.comments++;
        }
        else if (c === 0x08 && cc.spec) {
          if (item !== null && floats.has(cp)) floatRefs.push({ item, offset: shownBefore, cp });
          else gaps.objects++;
        }
      }
    }
    // (a range that ends at the paragraph's mark: at its end)
    const e = atnEnds.get(b);
    if (e) {
      flush();
      for (const k of e) out += `<w:commentRangeEnd w:id="${k}"/>`;
    }
    flush();
    return out;
  };

  // ── sections (PlcfSed, SEPX) ──
  interface Sec {
    end: number;
    xa: number; ya: number; left: number; right: number; top: number; bottom: number; hdr: number; ftr: number; gutter: number;
    bkc: number; title: boolean; cols: number; colSpace: number; nfc: number; pgStart: number; restart: boolean; landscape: boolean;
  }
  const secs: Sec[] = [];
  {
    const { fc, lcb } = pair(P.sed);
    const n = lcb >= 16 ? (lcb - 4) / 16 : 0;
    for (let k = 0; k < n; k++) {
      const s: Sec = { end: u32(table, fc + (k + 1) * 4), xa: 12240, ya: 15840, left: 1800, right: 1800, top: 1440, bottom: 1440, hdr: 720, ftr: 720, gutter: 0, bkc: 2, title: false, cols: 1, colSpace: 720, nfc: 0, pgStart: 1, restart: false, landscape: false };
      const sed = fc + (n + 1) * 4 + k * 12;
      const fcSepx = u32(table, sed + 2);
      if (fcSepx !== 0xffffffff && fcSepx + 2 <= wd.length) {
        const cb = u16(wd, fcSepx);
        const g = wd.subarray(fcSepx + 2, fcSepx + 2 + cb);
        for (const { sprm, at } of docSprms(g, 0) ?? []) {
          switch (sprm) {
            case 0x3009: s.bkc = g[at]; break;
            case 0x300a: s.title = g[at] === 1; break;
            case 0x500b: s.cols = u16(g, at) + 1; break;
            case 0x900c: s.colSpace = u16(g, at); break;
            case 0x300e: s.nfc = g[at]; break;
            case 0x3011: s.restart = g[at] === 1; break;
            case 0x501c: s.pgStart = u16(g, at); break;
            case 0x301d: s.landscape = g[at] === 2; break;
            case 0xb017: s.hdr = u16(g, at); break;
            case 0xb018: s.ftr = u16(g, at); break;
            case 0xb01f: s.xa = u16(g, at); break;
            case 0xb020: s.ya = u16(g, at); break;
            case 0xb021: s.left = u16(g, at); break;
            case 0xb022: s.right = u16(g, at); break;
            case 0x9023: s.top = i16(g, at); break;
            case 0x9024: s.bottom = i16(g, at); break;
            case 0xb025: s.gutter = u16(g, at); break;
            // (not in the model — named in a notice) page borders (sprmSBrcTop80 … / sprmSBrcTop …), vertical text
            case 0x702b: case 0x702c: case 0x702d: case 0x702e: if (g[at + 1] && g[at + 1] !== 0xff) looks.add("pageBorder"); break;
            case 0xd234: case 0xd235: case 0xd236: case 0xd237: if (g[at + 6] && g[at + 6] !== 0xff) looks.add("pageBorder"); break;
            case 0x5033: if (u16(g, at)) looks.add("textFlow"); break;
          }
        }
      }
      secs.push(s);
    }
  }
  if (!secs.length) throw new Error("doc: no sections");

  // ── headers and footers (PlcfHdd) ──
  const files: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  const dop = pair(P.dop);
  const facing = dop.lcb > 0 && (table[dop.fc] & 1) === 1;
  const hddCps = (() => {
    const { fc, lcb } = pair(P.hdd);
    if (lcb < 8 || fc + lcb > table.length) return [] as number[];
    const cps = Array.from({ length: Math.floor(lcb / 4) }, (_, k) => u32(table, fc + k * 4));
    if (!ascending(cps)) throw new Error("doc: PlcfHdd");
    return cps;
  })();
  const hfRefs: string[] = secs.map(() => "");
  {
    // per section: even header, odd header, even footer, odd footer, first header, first footer (after 6 separators)
    const kinds: [string, string][] = [["header", "even"], ["header", "default"], ["footer", "even"], ["footer", "default"], ["header", "first"], ["footer", "first"]];
    const last = new Map<number, string>();
    let part = 0;
    secs.forEach((s, si) => {
      let refs = "";
      kinds.forEach(([area, type], j) => {
        const i = 6 + si * 6 + j;
        const a = hddCps[i], b = hddCps[i + 1];
        let rid = last.get(j);
        if (a !== undefined && b !== undefined && b > a && b <= hddCps[hddCps.length - 1]) {
          const paras = storyParas(start.hdd + a, start.hdd + b, { fields: true });
          // (the story's last paragraph mark is not the story's)
          if (paras.length > 1) paras.pop();
          part++;
          const path = `${area}${part}.xml`;
          files[`word/${path}`] = strToU8(`${HEAD}<w:${area === "header" ? "hdr" : "ftr"} ${W_NS}>${paras.join("") || "<w:p/>"}</w:${area === "header" ? "hdr" : "ftr"}>`);
          rid = `rIdH${part}`;
          rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${area}" Target="${path}"/>`);
          last.set(j, rid);
        }
        if (!rid) return;
        if (type === "even" && !facing) return;
        if (type === "first" && !s.title) return;
        refs += `<w:${area}Reference w:type="${type}" r:id="${rid}"/>`;
      });
      hfRefs[si] = refs;
    });
  }
  const sectXml = (s: Sec, si: number) =>
    `<w:sectPr>${hfRefs[si]}${s.bkc !== 2 ? `<w:type w:val="${["continuous", "nextColumn", "nextPage", "evenPage", "oddPage"][s.bkc] ?? "nextPage"}"/>` : ""}<w:pgSz w:w="${s.xa}" w:h="${s.ya}"${s.landscape ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${s.top}" w:right="${s.right}" w:bottom="${s.bottom}" w:left="${s.left}" w:header="${s.hdr}" w:footer="${s.ftr}" w:gutter="${s.gutter}"/>` +
    `<w:pgNumType w:fmt="${NFC[s.nfc] ?? "decimal"}"${s.restart ? ` w:start="${s.pgStart}"` : ""}/>` +
    `<w:cols w:num="${s.cols}" w:space="${s.colSpace}"/>${s.title ? "<w:titlePg/>" : ""}</w:sectPr>`;

  // ── the body ──
  const body: string[] = [];
  const breaks = new Set<number>();
  const cellMap: number[][][] = [];
  const blocks = story.blocks;
  // the block each section ends in
  const blockEnd = blocks.map((b) => (b.kind === "para" ? (b.p.cr >= 0 ? b.p.cr : ccp.text - 1) : lastMark(b.cells)));
  const secOfBlock = new Map<number, number>();
  /** each body paragraph's style (by block) */
  const paraIstd = new Map<number, number>();
  // (the blocks in order, once: a file of very many sections took as many passes over the blocks)
  let kb = 0;
  secs.forEach((s, si) => {
    if (si === secs.length - 1) return;
    while (kb < blockEnd.length && blockEnd[kb] < s.end - 1) kb++;
    const b = blocks[kb];
    if (b?.kind !== "para") return;
    secOfBlock.set(kb, si);
    // a section break with letters of its paragraph after it: one paragraph here (the text reader's), two in Word
    if (b.p.cps.some((x) => x > s.end - 1)) looks.add("sectionMid");
  });
  blocks.forEach((b, k) => {
    if (b.kind === "para") {
      const p = b.p;
      const pap = papAt(p.cr);
      paraIstd.set(k, pap.istd);
      if (pap.tabs && p.text.includes("\t")) looks.add("tabs");
      const runs = bodyRuns(p.start, p.cr >= 0 ? p.cr : ccp.text, p.cps, pap.istd, k);
      // page breaks (0x0C not ending a section): before the paragraph when no letter comes before it, else after it —
      // a paragraph of nothing but the break too: Word's DOC layout (compatibility mode 11) sets its paragraph mark, an
      // empty line, at the top of the next page (Word PDF: the next page's first line one line lower)
      const end = p.cr >= 0 ? p.cr : ccp.text;
      for (let cp = p.start; cp < end; cp++) {
        if (text[cp] !== "\x0c" || !story.shown[cp] || secs.some((s) => s.end - 1 === cp)) continue;
        const before = p.cps.some((x) => x < cp);
        if (!before) {
          // (QA docx-flow: the first paragraph of nothing but a break has no page before it to leave — the break goes
          // after it as before; the change to "before" dropped it, and the DOC save with it)
          if (k > 0) breaks.add(k);
          else if (!p.cps.some((x) => x > cp)) breaks.add(k + 1);
        } else breaks.add(k + 1);
        break;
      }
      const si = secOfBlock.get(k);
      body.push(paraXml(pap, runs, { list: true, ...(p.cr >= 0 ? { mark: rPrXml(chpAt(p.cr, pap.istd)) } : {}), ...(si !== undefined ? { sect: sectXml(secs[si], si) } : {}) }));
      return;
    }
    body.push(tableXml(b.cells, cellMap));
  });

  function lastMark(cells: DocRawCell[][]): number {
    const row = cells[cells.length - 1];
    return row?.length ? row[row.length - 1].mark : 0;
  }

  /** the table: one w:tr per row, one w:tc per cell of the file (cellMap: the grid column of each) */
  function tableXml(cells: DocRawCell[][], map: number[][][]): string {
    // each row's TAP: the row end (TTP) after its last cell
    const taps = cells.map((row) => {
      const last = row[row.length - 1]?.mark ?? -1;
      let ttp = -1;
      for (let cp = last + 1; cp < ccp.text; cp++)
        if (text[cp] === "\x07" && story.shown[cp]) {
          ttp = cp;
          break;
        }
      return tapOf(ttp >= 0 ? docPapxAt(m, ttp) : null, row.length);
    });
    // the grid: every cell edge of every row
    const edges = [...new Set(taps.flatMap((tp) => tp.centers))].sort((a, b) => a - b);
    const grid: number[] = [];
    const merged: number[] = [];
    for (const e of edges) if (!merged.length || e - merged[merged.length - 1] > 5) merged.push(e);
    for (let i = 1; i < merged.length; i++) grid.push(merged[i] - merged[i - 1]);
    const colOf = (x: number) => {
      let best = 0;
      for (let i = 0; i < merged.length; i++) if (Math.abs(merged[i] - x) < Math.abs(merged[best] - x)) best = i;
      return best;
    };
    const tp0 = taps[0];
    let x = "<w:tbl><w:tblPr>";
    if (tp0.jc === 1 || tp0.jc === 2) x += `<w:jc w:val="${tp0.jc === 1 ? "center" : "right"}"/>`;
    x += `<w:tblW w:w="${(merged[merged.length - 1] ?? 0) - (merged[0] ?? 0)}" w:type="dxa"/>`;
    const tb = tp0.borders;
    if (tb) x += `<w:tblBorders>${brcXml("top", tb[0])}${brcXml("left", tb[1])}${brcXml("bottom", tb[2])}${brcXml("right", tb[3])}${brcXml("insideH", tb[4])}${brcXml("insideV", tb[5])}</w:tblBorders>`;
    x += `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="${tp0.pad[0]}" w:type="dxa"/><w:left w:w="${tp0.pad[1]}" w:type="dxa"/><w:bottom w:w="${tp0.pad[2]}" w:type="dxa"/><w:right w:w="${tp0.pad[3]}" w:type="dxa"/></w:tblCellMar></w:tblPr>`;
    x += `<w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
    const tmap: number[][] = [];
    cells.forEach((row, ri) => {
      const tp = taps[ri];
      let tr = "<w:tr><w:trPr>";
      const c0 = colOf(tp.centers[0] ?? merged[0]);
      if (c0 > 0) tr += `<w:gridBefore w:val="${c0}"/>`;
      if (tp.height) tr += `<w:trHeight w:val="${Math.abs(tp.height)}" w:hRule="${tp.height < 0 ? "exact" : "atLeast"}"/>`;
      if (ri === 0 && tp.header) tr += "<w:tblHeader/>";
      tr += "</w:trPr>";
      const rmap: number[] = [];
      row.forEach((cell, ci) => {
        const l = tp.centers[ci] ?? tp.centers[tp.centers.length - 1] ?? 0;
        const r = tp.centers[ci + 1] ?? l + 1440;
        const a = colOf(l), z = Math.max(a + 1, colOf(r));
        rmap.push(a);
        const tc = tp.tcs[ci];
        let pr = `<w:tcW w:w="${r - l}" w:type="dxa"/>`;
        if (z - a > 1) pr += `<w:gridSpan w:val="${z - a}"/>`;
        // a cell merged into the one above: only when it has no text of its own (it would be hidden)
        if (tc?.vmerge === "restart") pr += '<w:vMerge w:val="restart"/>';
        else if (tc?.vmerge === "continue" && !cell.text) pr += "<w:vMerge/>";
        if (tc?.borders) pr += `<w:tcBorders>${brcXml("top", tc.borders[0])}${brcXml("left", tc.borders[1])}${brcXml("bottom", tc.borders[2])}${brcXml("right", tc.borders[3])}</w:tcBorders>`;
        if (tp.shd[ci]) pr += `<w:shd w:val="clear" w:color="auto" w:fill="${tp.shd[ci]}"/>`;
        if (tc?.valign) pr += `<w:vAlign w:val="${tc.valign === 1 ? "center" : "bottom"}"/>`;
        tr += `<w:tc><w:tcPr>${pr}</w:tcPr>${cellParas(cell)}</w:tc>`;
      });
      tmap.push(rmap);
      x += tr + "</w:tr>";
    });
    map.push(tmap);
    return x + "</w:tbl>";
  }

  /** a cell's paragraphs: its letters cut at its paragraph marks (the reader shows them as line breaks of the cell) */
  function cellParas(cell: DocRawCell): string {
    const out: string[] = [];
    let from = cell.start;
    const cps = cell.cps;
    const marks = [...cps.filter((cp) => text[cp] === "\r"), cell.mark];
    for (const mark of marks) {
      const pap = papAt(mark);
      if (pap.ilfo > 0) gaps.cellLists++;
      const own = cps.filter((cp) => cp >= from && cp < mark);
      if (pap.tabs && own.some((cp) => text[cp] === "\t")) looks.add("tabs");
      out.push(paraXml(pap, bodyRuns(from, mark, own, pap.istd, null), { mark: rPrXml(chpAt(mark, pap.istd)) }));
      from = mark + 1;
    }
    // (a nested table: its cells' paragraphs in this cell, as the reader shows them)
    for (let cp = cell.start; cp < cell.mark; cp++)
      if (text[cp] === "\r" && story.shown[cp]) {
        const g = docPapxAt(m, cp);
        const s = g && g.length >= 2 ? docSprms(g, 2) : null;
        if (s?.some((x) => x.sprm === 0x244c && g![x.at] === 1)) gaps.nested++;
      }
    return out.join("");
  }

  /** a row's TAP: cell edges, TC80s, borders, shading, padding, height, header, alignment */
  function tapOf(g: Uint8Array | null, cells: number) {
    const tap = {
      centers: [] as number[],
      tcs: [] as { vmerge?: "restart" | "continue"; valign?: number; borders?: Brc[] }[],
      borders: null as Brc[] | null,
      shd: [] as (string | null)[],
      pad: [0, 108, 0, 108],
      height: 0,
      header: false,
      jc: 0,
    };
    const sprms = g && g.length >= 2 ? docSprms(g, 2) ?? [] : [];
    for (const { sprm, at } of sprms) {
      if (!g) break;
      switch (sprm) {
        case 0xd608: {
          const n = g[at + 2];
          tap.centers = Array.from({ length: n + 1 }, (_, k) => i16(g, at + 3 + k * 2));
          const end = at + 2 + u16(g, at) - 1;
          for (let k = 0; k < n; k++) {
            const o = at + 3 + (n + 1) * 2 + k * 20;
            if (o + 20 > end + 1) break;
            const grf = u16(g, o);
            const tc: (typeof tap.tcs)[number] = {};
            if (grf & 0x20) tc.vmerge = grf & 0x40 ? "restart" : "continue";
            // (not in the model — named in a notice) vertical text (fVertical, fBackward, fRotateFont); cells merged
            // across the old way (fFirstMerged, fMerged: each keeps its own cell)
            if (grf & 0x1c) looks.add("textFlow");
            if (grf & 0x03) looks.add("oldMerge");
            const va = (grf >> 7) & 3;
            if (va) tc.valign = va;
            const bs = [brc80(g, o + 4), brc80(g, o + 8), brc80(g, o + 12), brc80(g, o + 16)];
            if (bs.some((b) => b.type && b.type !== 0xff)) tc.borders = bs;
            tap.tcs[k] = tc;
          }
          break;
        }
        case 0xd605:
          tap.borders = [0, 1, 2, 3, 4, 5].map((k) => brc80(g, at + 1 + k * 4));
          break;
        case 0xd613:
          tap.borders = [0, 1, 2, 3, 4, 5].map((k) => brc(g, at + 1 + k * 8));
          break;
        case 0xd609: {
          const n = g[at] / 2;
          for (let k = 0; k < n; k++) tap.shd[k] = shd80(u16(g, at + 1 + k * 2));
          break;
        }
        case 0xd612:
        case 0xd616:
        case 0xd60c: {
          const off = sprm === 0xd612 ? 0 : sprm === 0xd616 ? 22 : 44;
          const n = g[at] / 10;
          for (let k = 0; k < n; k++) tap.shd[off + k] = shdOf(g, at + 1 + k * 10);
          break;
        }
        case 0x9602:
          tap.pad[1] = tap.pad[3] = i16(g, at);
          break;
        case 0xd634: {
          // CSSA: itcFirst, itcLim, grfbrc (top 1, left 2, bottom 4, right 8), ftsWidth, wWidth
          const sides = g[at + 3], w = u16(g, at + 5);
          if (g[at + 4] === 3) [1, 2, 4, 8].forEach((bit, k) => sides & bit && (tap.pad[k] = w));
          break;
        }
        case 0x9407:
          tap.height = i16(g, at);
          break;
        case 0x3404:
          tap.header = g[at] === 1;
          break;
        case 0x5400:
        case 0x548a:
          tap.jc = u16(g, at);
          break;
        case 0xd62b: {
          const itc = g[at + 1], f = g[at + 2];
          tap.tcs[itc] = { ...(tap.tcs[itc] ?? {}), vmerge: f & 2 ? "restart" : f & 1 ? "continue" : undefined };
          break;
        }
        case 0xd62c: {
          for (let k = g[at + 1]; k < g[at + 2]; k++) tap.tcs[k] = { ...(tap.tcs[k] ?? {}), valign: g[at + 3] };
          break;
        }
      }
    }
    if (tap.centers.length < cells + 1) {
      // (no cell edges: the columns of an A4 text width, evenly)
      const w = Math.round(9026 / Math.max(1, cells));
      tap.centers = Array.from({ length: cells + 1 }, (_, k) => k * w);
    }
    return tap;
  }

  // ── notes ──
  const notesXml = (kind: "foot" | "end", ranges: [number, number][]) =>
    ranges
      .map(([a, b], k) => {
        const ps = storyParas(a, b, { fields: false, noteKind: kind });
        while (ps.length > 1 && ps[ps.length - 1].endsWith("</w:pPr></w:p>")) ps.pop();
        return `<w:${kind}note w:id="${k + 1}">${ps.join("")}</w:${kind}note>`;
      })
      .join("");
  const sep = (kind: string) => `<w:${kind}note w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${kind}note><w:${kind}note w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}note>`;
  const comments = atn.flatMap((x, k) => (x.text ? [`<w:comment w:id="${k}" w:author="${esc(x.author)}" w:initials="${esc(x.initials)}">${storyParas(x.text[0], x.text[1], { fields: false }).join("") || "<w:p/>"}</w:comment>`] : []));
  if (comments.length) files["word/comments.xml"] = strToU8(`${HEAD}<w:comments ${W_NS}>${comments.join("")}</w:comments>`);
  if (ftnTxt.length) files["word/footnotes.xml"] = strToU8(`${HEAD}<w:footnotes ${W_NS}>${sep("foot")}${notesXml("foot", ftnTxt)}</w:footnotes>`);
  if (endTxt.length) files["word/endnotes.xml"] = strToU8(`${HEAD}<w:endnotes ${W_NS}>${sep("end")}${notesXml("end", endTxt)}</w:endnotes>`);

  // ── styles, settings, the package ──
  const normal = stylePap(0);
  const styleXml = styles
    .map((s, istd) => {
      if (!s || (s.stk !== 1 && s.stk !== 2)) return "";
      const type = s.stk === 1 ? "paragraph" : "character";
      const nm = s.sti >= 1 && s.sti <= 9 ? `heading ${s.sti}` : s.sti === 0 ? "Normal" : s.name || `Style ${istd}`;
      const def = (s.stk === 1 && istd === 0) || (s.stk === 2 && istd === 10) ? ' w:default="1"' : "";
      const based = s.base !== 0xfff && styles[s.base] ? `<w:basedOn w:val="s${s.base}"/>` : "";
      const own = istd === 0 ? `<w:pPr>${onOff("wordWrap", normal.wordWrap)}${onOff("overflowPunct", normal.overflowPunct)}${onOff("autoSpaceDE", normal.autoDE)}${onOff("autoSpaceDN", normal.autoDN)}</w:pPr>` : "";
      return `<w:style w:type="${type}"${def} w:styleId="s${istd}"><w:name w:val="${esc(nm)}"/>${based}${own}</w:style>`;
    })
    .join("");
  files["word/styles.xml"] = strToU8(
    `${HEAD}<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${esc(font(defFtc[0]))}" w:hAnsi="${esc(font(defFtc[2]))}" w:eastAsia="${esc(font(defFtc[1]))}"/><w:sz w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>${styleXml}</w:styles>`,
  );
  if (numbering.length) files["word/numbering.xml"] = strToU8(`${HEAD}<w:numbering ${W_NS}>${numbering.join("")}</w:numbering>`);
  files["word/settings.xml"] = strToU8(
    `${HEAD}<w:settings ${W_NS}>${facing ? "<w:evenAndOddHeaders/>" : ""}<w:compat><w:balanceSingleByteDoubleByteWidth/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="11"/></w:compat></w:settings>`,
  );
  files["word/_rels/document.xml.rels"] = strToU8(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  const last = secs.length - 1;
  files["word/document.xml"] = strToU8(`${HEAD}<w:document ${W_NS}><w:body>${body.join("")}${sectXml(secs[last], last)}</w:body></w:document>`);
  const docx = zipSync(files, { level: 0 });

  // ── read as a DOCX; the same paragraphs and tables, the same text ──
  const report: OfficeImportReport = { notesDropped: 0 };
  const items = parseDocxFlow(docx, report);
  if (items.length !== blocks.length) throw new Error("doc: items");
  const same = (it: OfficeItem, k: number) => {
    const b = blocks[k];
    if (it.kind === "p") return b.kind === "para" && docParaText(it.p) === b.p.text;
    if (b.kind !== "table" || it.table.rows.length !== b.rows.length) return false;
    const map = cellMap[blocks.slice(0, k).filter((x) => x.kind === "table").length];
    return b.rows.every((row, ri) => row.every((txt, ci) => it.table.rows[ri][map[ri][ci]]?.text === txt));
  };
  if (!items.every(same)) throw new Error("doc: text");
  // (doc-para-write) a paragraph whose style gives the paragraph after it another style (a heading → Normal): the new
  // paragraph Enter makes at its end, as Word makes it — that style and nothing of its own (read as the paragraphs
  // above: an empty paragraph of the style, its mark with the style's letters); a style with a list: not given
  const nextOf = new Map<number, number>();
  for (const [k, istd] of paraIstd) {
    const s = styles[istd];
    const n = s && s.stk === 1 ? s.next : -1;
    if (n >= 0 && n !== istd && n !== 0xfff && styles[n]?.stk === 1 && !stylePap(n).ilfo) nextOf.set(k, n);
  }
  if (nextOf.size) {
    const kinds = [...new Set(nextOf.values())];
    const tpl = kinds.map((n) => paraXml({ ...stylePap(n), brc: { ...stylePap(n).brc }, own: { left: false, first: false } }, "", { mark: rPrXml(styleChp(n)) }));
    const docx2 = zipSync({ ...files, "word/document.xml": strToU8(`${HEAD}<w:document ${W_NS}><w:body>${tpl.join("")}${sectXml(secs[last], last)}</w:body></w:document>`) }, { level: 0 });
    const got = parseDocxFlow(docx2, { notesDropped: 0 });
    if (got.length === kinds.length && got.every((it) => it.kind === "p" && !docParaText(it.p))) {
      const byIstd = new Map(kinds.map((n, i) => [n, (got[i] as { p: TextParagraph }).p]));
      for (const [k, n] of nextOf) {
        const it = items[k];
        const { id: _id, styleNext: _n, ...tp } = byIstd.get(n)!;
        if (it.kind === "p") it.p.styleNext = JSON.parse(JSON.stringify(tp));
      }
    }
  }
  // hard page breaks as read here (the DOCX importer reads none: none is written)
  const layout = report.layout;
  if (layout) layout.pageBreaks = [...breaks].filter((i) => i > 0 && i < items.length).sort((a, b) => a - b);

  // pictures in the line, after the paragraph they are in (as the DOCX importer places them)
  for (const r of picRefs) {
    const it = items[r.item];
    if (it?.kind !== "p" || !picAt(r.cp, r.c, r.item, it.p, r.offset, it.p)) gaps.pictures++;
  }
  // floating pictures, by their anchor paragraph (a shape that is not a picture: not read)
  for (const r of floatRefs) {
    const it = items[r.item];
    if (it?.kind !== "p" || !floatAt(r.cp, r.item, it.p, r.offset)) gaps.objects++;
  }
  pictures.sort((a, b) => a.at - b.at || a.offset - b.offset);
  const assets: Record<string, AssetRef> = {};
  const placed = pictures.map((pic) => {
    const a = makeAsset(pic.bytes, pic.mime, pic.name);
    // (the asset id from its content: the DOC save reads the pages as opened again and compares them)
    const id = `docpic-${a.hash.slice(0, 24)}`;
    assets[id] = { ...a, id };
    return { pic, assetId: id };
  });
  const pages = officePages(items, baseName(name), report.layout, report.lists, placed);
  pages.forEach((p) => (p.source = { format: "doc", name }));
  // the body flow holds the same items (the DOC save matches them to the file's paragraphs)
  const flow = collectFlow(pages);
  if (flow.length !== blocks.length || flow.some((it, k) => (it.kind === "p") !== (blocks[k].kind === "para"))) throw new Error("doc: flow");

  const warnings: string[] = [];
  const tn = (key: string, n: number) => t(n === 1 ? `${key}_one` : key, { n });
  if (gaps.pictures) warnings.push(tn("engine.doc.gap.pictures", gaps.pictures));
  if (gaps.objects) warnings.push(tn("engine.doc.gap.objects", gaps.objects));
  if (gaps.comments) warnings.push(tn("engine.doc.gap.comments", gaps.comments));
  if (gaps.cellNotes) warnings.push(tn("engine.doc.gap.cellNotes", gaps.cellNotes));
  if (gaps.cellLists) warnings.push(tn("engine.doc.gap.cellLists", gaps.cellLists));
  if (gaps.nested) warnings.push(tn("engine.doc.gap.nested", gaps.nested));
  if (gaps.hidden) warnings.push(tn("engine.doc.gap.hidden", gaps.hidden));
  if (secs.some((s) => s.cols > 1)) warnings.push(t("engine.doc.gap.columns"));
  if (looks.size) warnings.push(t("engine.doc.gap.looks", { list: LOOKS.filter((k) => looks.has(k)).map((k) => t(`engine.doc.look.${k}`)).join(t("engine.doc.look.sep")) }));
  return { pages, assets, warnings, paras: blocks.filter((b) => b.kind === "para").length, tables: blocks.length - blocks.filter((b) => b.kind === "para").length, pictures: pictures.length, cellMap };
}

/** whether CPs go up (or stay) one after another */
const ascending = (cps: readonly number[]) => cps.every((x, k) => !k || x >= cps[k - 1]);

/** formats of a DOC the document model has no place for (named in a notice: engine.doc.look.*) */
const LOOKS = ["tabs", "caps", "position", "symbol", "eastAsian", "link", "numbering", "textFlow", "oldMerge", "pageBorder", "sectionMid"] as const;
type Look = (typeof LOOKS)[number];

/** the first paragraph or cell mark in [a, b) (−1: none) */
function nextMarkIn(text: string, a: number, b: number): number {
  for (let cp = a; cp < b; cp++) if (text[cp] === "\r" || text[cp] === "\x07") return cp;
  return -1;
}

/** nfc (MSONFC) → w:numFmt */
const NFC: Record<number, string> = {
  0: "decimal", 1: "upperRoman", 2: "lowerRoman", 3: "upperLetter", 4: "lowerLetter", 5: "ordinal", 6: "cardinalText", 7: "ordinalText", 14: "decimalFullWidth", 18: "decimalEnclosedCircle",
  22: "decimalZero", 23: "bullet", 24: "ganada", 25: "chosung", 26: "decimalEnclosedFullstop", 27: "decimalEnclosedParen", 28: "decimalEnclosedCircleChinese", 255: "none",
};

/**
 * The picture of an OfficeArt record sequence [o, end) (PICF's data: OfficeArtInlineSpContainer — the shape, then its
 * BLIP store entries): the first BLIP a browser shows (PNG, JPEG, DIB as BMP), or null.
 */
function findBlip(d: Uint8Array, o: number, end: number): { bytes: Uint8Array; mime: string } | null {
  let found: { bytes: Uint8Array; mime: string } | null = null;
  const walk = (a: number, z: number, depth: number) => {
    for (let p = a; p + 8 <= z && !found && depth < 8; ) {
      const verInst = u16(d, p), type = u16(d, p + 2), len = u32(d, p + 4);
      const body = p + 8;
      if (body + len > z) return;
      if ((verInst & 0xf) === 0xf) walk(body, body + len, depth + 1);
      else if (type === 0xf007) walk(body + 36 + d[body + 33], body + len, depth + 1); // FBSE: its embedded BLIP after the name
      else if (type >= 0xf018 && type <= 0xf117) {
        const inst = verInst >> 4;
        const two = (t2: number, one: number) => (inst === t2 ? 32 : inst === one ? 16 : -1);
        let skip = -1, mime = "";
        if (type === 0xf01e) (skip = two(0x6e1, 0x6e0)), (mime = "image/png");
        else if (type === 0xf01d || type === 0xf02a) (skip = type === 0xf01d ? two(0x46b, 0x46a) : two(0x6e3, 0x6e2)), (mime = "image/jpeg");
        else if (type === 0xf01f) (skip = two(0x7a9, 0x7a8)), (mime = "image/bmp");
        if (skip >= 0) {
          const data = d.subarray(body + skip + 1, body + len);
          found = mime === "image/bmp" ? { bytes: dibToBmp(data), mime } : { bytes: data.slice(), mime };
        }
      }
      p = body + len;
    }
  };
  walk(o, end, 0);
  return found;
}

/**
 * The pictures of a document's shapes ([MS-ODRAW], in the table stream at fcDggInfo: OfficeArtDggContainer with the
 * BLIP store, then each drawing — a dgglbl byte, an OfficeArtDgContainer): shape id → its BLIP (the shape's pib, 1-based
 * into the store; a store entry's BLIP is in it, else in WordDocument at its foDelay). Shapes without a picture are not
 * in it.
 */
function officeArtBlips(table: Uint8Array, fc: number, lcb: number, wd: Uint8Array): Map<number, { bytes: Uint8Array; mime: string }> {
  const out = new Map<number, { bytes: Uint8Array; mime: string }>();
  const end = fc + lcb;
  if (!lcb || end > table.length || fc + 8 > end) return out;
  const store: { body: number; len: number }[] = [];
  const pibOf = new Map<number, number>();
  const sp = (a: number, z: number) => {
    let spid = -1, pib = -1;
    for (let p = a; p + 8 <= z; ) {
      const ver = u16(table, p), type = u16(table, p + 2), len = u32(table, p + 4), body = p + 8;
      if (body + len > z) break;
      if (type === 0xf00a && len >= 4) spid = u32(table, body);
      else if (type === 0xf00b || type === 0xf121 || type === 0xf122) {
        // OfficeArtFOPT: rh.recInstance properties of 6 bytes (opid: pid 14 bits, fBid, fComplex; op) — pib is 0x104
        const n = ver >> 4;
        for (let k = 0; k < n && body + k * 6 + 6 <= body + len; k++) if ((u16(table, body + k * 6) & 0x3fff) === 0x104) pib = u32(table, body + k * 6 + 2);
      }
      p = body + len;
    }
    if (spid >= 0 && pib > 0) pibOf.set(spid, pib);
  };
  const walk = (a: number, z: number, depth: number) => {
    for (let p = a; p + 8 <= z && depth < 12; ) {
      const ver = u16(table, p), type = u16(table, p + 2), len = u32(table, p + 4), body = p + 8;
      if (body + len > z) return;
      if (type === 0xf007) store.push({ body, len });
      else if (type === 0xf004) sp(body, body + len);
      else if ((ver & 0xf) === 0xf) walk(body, body + len, depth + 1);
      p = body + len;
    }
  };
  // the Dgg container, then the drawings (each after its dgglbl byte)
  const dggLen = u32(table, fc + 4);
  walk(fc, Math.min(end, fc + 8 + dggLen), 0);
  for (let p = fc + 8 + dggLen; p + 9 <= end; ) {
    const at = p + 1, len = u32(table, at + 4);
    if (u16(table, at + 2) !== 0xf002 || at + 8 + len > end) break;
    walk(at, at + 8 + len, 0);
    p = at + 8 + len;
  }
  for (const [spid, pib] of pibOf) {
    const e = store[pib - 1];
    if (!e || e.len < 36) continue;
    const cbName = table[e.body + 33];
    let blip: { bytes: Uint8Array; mime: string } | null = null;
    if (e.len > 36 + cbName) blip = findBlip(table, e.body + 36 + cbName, e.body + e.len);
    else {
      const fo = u32(table, e.body + 28);
      if (fo + 8 <= wd.length) blip = findBlip(wd, fo, Math.min(wd.length, fo + 8 + u32(wd, fo + 4)));
    }
    if (blip) out.set(spid, blip);
  }
  return out;
}

/** a DIB (BITMAPINFOHEADER …) as a BMP file */
function dibToBmp(dib: Uint8Array): Uint8Array {
  const hdr = u32(dib, 0), bpp = u16(dib, 14), used = u32(dib, 32);
  const colors = bpp <= 8 ? used || 1 << bpp : 0;
  const off = 14 + hdr + colors * 4;
  const out = new Uint8Array(14 + dib.length);
  out[0] = 0x42;
  out[1] = 0x4d;
  const put = (o: number, v: number) => ((out[o] = v & 0xff), (out[o + 1] = (v >> 8) & 0xff), (out[o + 2] = (v >> 16) & 0xff), (out[o + 3] = (v >>> 24) & 0xff));
  put(2, out.length);
  put(10, off);
  out.set(dib, 14);
  return out;
}

