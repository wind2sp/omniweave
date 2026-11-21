// PDF Surgeon — fonts (ISO 32000-1 §9.5–9.10): string bytes ↔ character codes ↔ Unicode, glyph
// advances, and re-encoding edited text in the ORIGINAL font. A character is only re-encoded when
// we have evidence the embedded (possibly subset) font really has its glyph; anything else is
// reported so the writer can use a fallback font for just that stretch.

import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, StandardFontEmbedder, StandardFonts, type PDFObject } from "pdf-lib";
import { baseEncodingTable, glyphToUnicode, type BaseEncoding } from "./encodings";
import { dget, dictOf, look, nameOf, numArray, numOf, refKey, streamBytes, textOf, type SurgeonDoc } from "./document";
import { Lexer, PdfStr } from "./syntax";

export interface FontInfo {
  id: string;
  ref: PDFRef | null;
  subtype: string;
  /** PostScript name without the subset tag */
  baseFont: string;
  subset: boolean;
  composite: boolean;
  serif: boolean;
  bold: boolean;
  italic: boolean;
  /** why text in this font is not editable in place (null = editable) */
  unsupported: string | null;
  /** split string bytes into character codes */
  codes(bytes: Uint8Array): { code: number; len: number }[];
  unicode(code: number): string;
  /** horizontal advance in text space for font size 1 */
  advance(code: number): number;
  /** codes seen on the page: their glyphs certainly exist in the embedded font */
  used: Set<number>;
  /** encode text in this font; null entries mark characters the font cannot show */
  encode(text: string): { text: string; bytes: Uint8Array | null }[];
  /**
   * The embedded TrueType program of a composite (CID) font and its Unicode → glyph id table, so the editing view
   * can draw with the original glyphs (pdfFonts.ts rebuilds a cmap for it). Absent for other fonts.
   */
  program?: { data: Uint8Array; uniToGid: () => Map<number, number> };
}

// ───────── CMaps ─────────

interface CMapData {
  space: { len: number; lo: number; hi: number }[];
  uni: Map<number, string>;
  uniRanges: { lo: number; hi: number; dst: string }[];
  cid: Map<number, number>;
  cidRanges: { lo: number; hi: number; cid: number }[];
}

const utf16 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]);
  return s;
};
const intOf = (b: Uint8Array) => b.reduce((n, x) => n * 256 + x, 0);

export function parseCMap(data: Uint8Array): CMapData {
  const out: CMapData = { space: [], uni: new Map(), uniRanges: [], cid: new Map(), cidRanges: [] };
  const lx = new Lexer(data);
  let mode = "";
  const buf: unknown[] = [];
  for (;;) {
    let t;
    try {
      t = lx.next();
    } catch {
      break; // damaged tail: keep what we have
    }
    if (t.k === "eof") break;
    if (t.k === "kw") {
      if (t.v.startsWith("begin")) (mode = t.v.slice(5)), (buf.length = 0);
      else if (t.v.startsWith("end")) mode = "";
      continue;
    }
    if (!mode) continue;
    if (t.k === "[") {
      const arr: Uint8Array[] = [];
      for (let u = lx.next(); u.k !== "]" && u.k !== "eof"; u = lx.next()) if (u.k === "val" && u.v instanceof PdfStr) arr.push(u.v.bytes);
      buf.push(arr);
    } else if (t.k === "val") buf.push(t.v instanceof PdfStr ? t.v.bytes : t.v);
    const need = mode === "codespacerange" || mode === "bfchar" || mode === "cidchar" || mode === "notdefchar" ? 2 : 3;
    if (buf.length < need) continue;
    const [a, b, c] = buf.splice(0, need) as [any, any, any];
    if (!(a instanceof Uint8Array)) continue;
    if (mode === "codespacerange" && b instanceof Uint8Array) out.space.push({ len: a.length, lo: intOf(a), hi: intOf(b) });
    else if (mode === "bfchar" && b instanceof Uint8Array) out.uni.set(intOf(a), utf16(b));
    else if (mode === "bfrange" && b instanceof Uint8Array) {
      const lo = intOf(a), hi = intOf(b);
      if (Array.isArray(c)) c.forEach((d: Uint8Array, i: number) => lo + i <= hi && out.uni.set(lo + i, utf16(d)));
      else if (c instanceof Uint8Array && hi >= lo) out.uniRanges.push({ lo, hi, dst: utf16(c) });
    } else if (mode === "cidchar" && typeof b === "number") out.cid.set(intOf(a), b);
    else if (mode === "cidrange" && b instanceof Uint8Array && typeof c === "number") out.cidRanges.push({ lo: intOf(a), hi: intOf(b), cid: c });
  }
  return out;
}

function cmapUnicode(m: CMapData, code: number): string | undefined {
  const v = m.uni.get(code);
  if (v !== undefined) return v;
  for (const r of m.uniRanges) {
    if (code < r.lo || code > r.hi) continue;
    if (!r.dst) return "";
    const last = r.dst.charCodeAt(r.dst.length - 1) + (code - r.lo);
    return r.dst.slice(0, -1) + String.fromCharCode(last & 0xffff);
  }
  return undefined;
}

// ───────── TrueType glyph presence ─────────

/** gid → glyph has an outline, from the 'loca' table of an embedded TrueType program. */
function trueTypeGlyphs(data: Uint8Array): ((gid: number) => boolean) | null {
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = dv.getUint16(4);
    const tables = new Map<string, [number, number]>();
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      tables.set(String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]), [dv.getUint32(o + 8), dv.getUint32(o + 12)]);
    }
    const head = tables.get("head"), maxp = tables.get("maxp"), loca = tables.get("loca");
    if (!head || !maxp || !loca) return null;
    const longLoca = dv.getInt16(head[0] + 50) === 1;
    const numGlyphs = dv.getUint16(maxp[0] + 4);
    const at = (g: number) => (longLoca ? dv.getUint32(loca[0] + g * 4) : dv.getUint16(loca[0] + g * 2) * 2);
    return (gid) => gid >= 0 && gid < numGlyphs && (loca[0] + (gid + 2) * (longLoca ? 4 : 2) <= data.length ? at(gid + 1) > at(gid) : false);
  } catch {
    return null;
  }
}

/** Unicode ↔ glyph id from a TrueType 'cmap' table (Windows Unicode subtables, formats 4 and 12). */
export function trueTypeUnicode(data: Uint8Array): { gidToUni: Map<number, number> } | null {
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const n = dv.getUint16(4);
    let cmap = -1;
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      if (String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]) === "cmap") cmap = dv.getUint32(o + 8);
    }
    if (cmap < 0) return null;
    const subs: { pid: number; eid: number; off: number }[] = [];
    const count = dv.getUint16(cmap + 2);
    for (let i = 0; i < count; i++) subs.push({ pid: dv.getUint16(cmap + 4 + i * 8), eid: dv.getUint16(cmap + 6 + i * 8), off: cmap + dv.getUint32(cmap + 8 + i * 8) });
    const rank = (s: (typeof subs)[0]) => (s.pid === 3 && s.eid === 10 ? 0 : s.pid === 0 ? 1 : s.pid === 3 && s.eid === 1 ? 2 : 9);
    const pick = subs.filter((s) => rank(s) < 9).sort((a, b) => rank(a) - rank(b));
    const gidToUni = new Map<number, number>();
    const put = (cp: number, g: number) => g && !gidToUni.has(g) && gidToUni.set(g, cp);
    for (const s of pick) {
      const fmt = dv.getUint16(s.off);
      if (fmt === 12) {
        const groups = dv.getUint32(s.off + 12);
        for (let i = 0; i < groups; i++) {
          const o = s.off + 16 + i * 12;
          const a = dv.getUint32(o), b = dv.getUint32(o + 4), g = dv.getUint32(o + 8);
          for (let c = a; c <= b && c - a < 0x10000; c++) put(c, g + (c - a));
        }
      } else if (fmt === 4) {
        const segX2 = dv.getUint16(s.off + 6);
        const ends = s.off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        for (let i = 0; i < segX2 / 2; i++) {
          const end = dv.getUint16(ends + i * 2), start = dv.getUint16(starts + i * 2);
          const delta = dv.getInt16(deltas + i * 2), ro = dv.getUint16(ranges + i * 2);
          for (let c = start; c <= end && c !== 0xffff; c++) {
            let g: number;
            if (!ro) g = (c + delta) & 0xffff;
            else {
              const at = ranges + i * 2 + ro + (c - start) * 2;
              g = at + 1 < data.length ? dv.getUint16(at) : 0;
              if (g) g = (g + delta) & 0xffff;
            }
            put(c, g);
          }
        }
      } else continue;
      if (gidToUni.size) break;
    }
    return gidToUni.size ? { gidToUni } : null;
  } catch {
    return null;
  }
}

// ───────── standard 14 metrics ─────────

const STD: [RegExp, StandardFonts][] = [
  [/^(Helvetica|Arial)(MT)?$/i, StandardFonts.Helvetica],
  [/^(Helvetica|Arial)(MT)?[-,]?Bold(MT)?$/i, StandardFonts.HelveticaBold],
  [/^(Helvetica|Arial)(MT)?[-,]?(Oblique|Italic)(MT)?$/i, StandardFonts.HelveticaOblique],
  [/^(Helvetica|Arial)(MT)?[-,]?Bold(Oblique|Italic)(MT)?$/i, StandardFonts.HelveticaBoldOblique],
  [/^Times(-Roman|NewRoman(PS)?(MT)?)?$/i, StandardFonts.TimesRoman],
  [/^Times(NewRoman(PS)?)?[-,]?Bold(MT)?$/i, StandardFonts.TimesRomanBold],
  [/^Times(NewRoman(PS)?)?[-,]?Italic(MT)?$/i, StandardFonts.TimesRomanItalic],
  [/^Times(NewRoman(PS)?)?[-,]?BoldItalic(MT)?$/i, StandardFonts.TimesRomanBoldItalic],
  [/^Courier(New(PS)?(MT)?)?$/i, StandardFonts.Courier],
  [/^Courier(New(PS)?)?[-,]?Bold(MT)?$/i, StandardFonts.CourierBold],
  [/^Courier(New(PS)?)?[-,]?(Oblique|Italic)(MT)?$/i, StandardFonts.CourierOblique],
  [/^Courier(New(PS)?)?[-,]?Bold(Oblique|Italic)(MT)?$/i, StandardFonts.CourierBoldOblique],
  [/^Symbol$/i, StandardFonts.Symbol],
  [/^ZapfDingbats$/i, StandardFonts.ZapfDingbats],
];
const stdEmbedders = new Map<string, StandardFontEmbedder>();
function standardWidth(base: string): ((ch: string) => number) | null {
  const hit = STD.find(([re]) => re.test(base));
  if (!hit) return null;
  let e = stdEmbedders.get(hit[1]);
  if (!e) stdEmbedders.set(hit[1], (e = StandardFontEmbedder.for(hit[1] as any)));
  const emb = e;
  return (ch) => {
    try {
      return emb.widthOfTextAtSize(ch, 1000);
    } catch {
      return 0;
    }
  };
}

// ───────── font analysis ─────────

function styleOf(base: string, desc: PDFDict | undefined, ctx: SurgeonDoc["ctx"]) {
  const flags = numOf(dget(ctx, desc, "Flags")) ?? 0;
  const weight = numOf(dget(ctx, desc, "FontWeight")) ?? 0;
  const bold = /bold|black|heavy|semibold|demi|extrabold|ultra|[-,_]b$|\bEB\b|\bB\b/i.test(base) || weight >= 600 || (flags & 0x40000) !== 0;
  const italic = /italic|oblique/i.test(base) || (flags & 64) !== 0;
  const serif = /myeongjo|myungjo|batang|serif(?!.*sans)|times|mincho|song|garamond|georgia|minion|palatino|book ?antiqua|cambria/i.test(base) || ((flags & 2) !== 0 && !/sans|gothic|dotum|gulim|malgun|arial|helvetica|nanumsquare|pretendard/i.test(base));
  return { bold, italic, serif };
}

export function loadFont(doc: SurgeonDoc, fontObj: PDFObject | undefined, fallbackId: string): FontInfo | null {
  const ref = fontObj instanceof PDFRef ? fontObj : null;
  const id = ref ? refKey(ref) : fallbackId;
  const cached = doc.fontCache.get(id);
  if (cached) return cached;
  const fd = dictOf(look(doc.ctx, fontObj));
  if (!fd) return null;
  const info = nameOf(dget(doc.ctx, fd, "Subtype")) === "Type0" ? compositeFont(doc, fd, id, ref) : simpleFont(doc, fd, id, ref);
  doc.fontCache.set(id, info);
  return info;
}

function baseName(doc: SurgeonDoc, fd: PDFDict) {
  const raw = nameOf(dget(doc.ctx, fd, "BaseFont")) ?? "";
  const subset = /^[A-Z]{6}\+/.test(raw);
  return { base: subset ? raw.slice(7) : raw, subset };
}

function toUnicodeOf(doc: SurgeonDoc, fd: PDFDict): CMapData | null {
  const tu = fd.get(PDFName.of("ToUnicode"));
  if (!(look(doc.ctx, tu) instanceof PDFStream)) return null;
  try {
    return parseCMap(streamBytes(doc.ctx, tu));
  } catch {
    return null;
  }
}

/** Characters → codes, preferring the lowest code; multi-character targets (ligatures) included. */
function reverseMap(entries: Iterable<[number, string]>): Map<string, number> {
  const rev = new Map<string, number>();
  for (const [code, s] of entries) if (s && (!rev.has(s) || rev.get(s)! > code)) rev.set(s, code);
  return rev;
}

function* cmapEntries(m: CMapData, limit = 65536): Iterable<[number, string]> {
  yield* m.uni;
  let n = 0;
  for (const r of m.uniRanges) for (let c = r.lo; c <= r.hi && n++ < limit; c++) yield [c, cmapUnicode(m, c) ?? ""];
}

function encoder(rev: Map<string, number>, ok: (code: number) => boolean, bytesOf: (code: number) => Uint8Array) {
  return (text: string) => {
    const out: { text: string; bytes: Uint8Array | null }[] = [];
    const push = (t: string, b: Uint8Array | null) => {
      const last = out[out.length - 1];
      if (last && (last.bytes === null) === (b === null)) {
        last.text += t;
        if (b && last.bytes) {
          const m = new Uint8Array(last.bytes.length + b.length);
          m.set(last.bytes);
          m.set(b, last.bytes.length);
          last.bytes = m;
        }
      } else out.push({ text: t, bytes: b });
    };
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; ) {
      let done = false;
      for (const n of [3, 2, 1]) {
        if (i + n > chars.length) continue;
        const s = chars.slice(i, i + n).join("");
        const code = rev.get(s);
        if (code != null && ok(code)) {
          push(s, bytesOf(code));
          i += n;
          done = true;
          break;
        }
      }
      if (!done) push(chars[i++], null);
    }
    return out;
  };
}

function simpleFont(doc: SurgeonDoc, fd: PDFDict, id: string, ref: PDFRef | null): FontInfo {
  const ctx = doc.ctx;
  const subtype = nameOf(dget(ctx, fd, "Subtype")) ?? "Type1";
  const { base, subset } = baseName(doc, fd);
  const desc = dictOf(dget(ctx, fd, "FontDescriptor"));
  const flags = numOf(dget(ctx, desc, "Flags")) ?? 0;
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  const encObj = dget(ctx, fd, "Encoding");
  const encDict = dictOf(encObj);
  let baseEnc: BaseEncoding = (nameOf(encObj) ?? nameOf(dget(ctx, encDict, "BaseEncoding")) ?? "") as BaseEncoding;
  if (!["WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"].includes(baseEnc)) baseEnc = symbolic ? "None" : subtype === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding";
  const table = baseEncodingTable(baseEnc);
  const diffs = dget(ctx, encDict, "Differences");
  const fromDiff = new Set<number>();
  if (diffs instanceof PDFArray) {
    let code = 0;
    for (const v of diffs.asArray()) {
      const o = look(ctx, v);
      const n = numOf(o);
      if (n != null) code = n;
      else if (nameOf(o) != null && code < 256) {
        table[code] = glyphToUnicode(nameOf(o)!);
        fromDiff.add(code++);
      }
    }
  }
  const tu = toUnicodeOf(doc, fd);
  const first = numOf(dget(ctx, fd, "FirstChar")) ?? 0;
  const widths = numArray(ctx, dget(ctx, fd, "Widths"));
  const missing = numOf(dget(ctx, desc, "MissingWidth")) ?? 0;
  const std = !widths ? standardWidth(base) : null;
  const type3 = subtype === "Type3";
  const fm = type3 ? numArray(ctx, dget(ctx, fd, "FontMatrix")) ?? [0.001, 0, 0, 0.001, 0, 0] : null;
  const unicode = (code: number) => (tu ? cmapUnicode(tu, code) : undefined) ?? table[code] ?? "";
  const advance = (code: number) => {
    let w = widths && code >= first && code - first < widths.length ? widths[code - first] : std ? std(table[code] || " ") : missing;
    return type3 ? w * fm![0] : w / 1000;
  };
  const used = new Set<number>();
  const hasProgram = !!(desc && (desc.get(PDFName.of("FontFile")) || desc.get(PDFName.of("FontFile2")) || desc.get(PDFName.of("FontFile3"))));
  const listed = new Set<number>(tu ? [...tu.uni.keys()] : []);
  // glyph exists: seen on the page, listed in ToUnicode/Differences (subset fonts list only what they keep),
  // or the font is complete (not a subset / not embedded at all)
  const ok = (code: number) => used.has(code) || listed.has(code) || fromDiff.has(code) || ((!subset || !hasProgram) && (!widths || advance(code) > 0));
  const entries: [number, string][] = [];
  for (let c = 0; c < 256; c++) entries.push([c, unicode(c)]);
  let rev: Map<string, number> | null = null;
  const style = styleOf(base, desc, ctx);
  return {
    id,
    ref,
    subtype,
    baseFont: base,
    subset,
    composite: false,
    ...style,
    unsupported: type3 ? "type3" : null,
    codes: (b) => Array.from(b, (code) => ({ code, len: 1 })),
    unicode,
    advance,
    used,
    encode: (text) => encoder((rev ??= reverseMap(entries)), ok, (c) => Uint8Array.of(c))(text),
  };
}

function compositeFont(doc: SurgeonDoc, fd: PDFDict, id: string, ref: PDFRef | null): FontInfo {
  const ctx = doc.ctx;
  const { base, subset } = baseName(doc, fd);
  const descendants = dget(ctx, fd, "DescendantFonts");
  const cid = dictOf(look(ctx, descendants instanceof PDFArray ? descendants.get(0) : undefined));
  const desc = dictOf(dget(ctx, cid, "FontDescriptor"));
  const encObj = dget(ctx, fd, "Encoding");
  const encName = nameOf(encObj) ?? "";
  let unsupported: string | null = null;
  let space: CMapData["space"] = [{ len: 2, lo: 0, hi: 0xffff }];
  let cidOf: (code: number) => number = (c) => c;
  let codeIsUnicode = false;
  if (encObj instanceof PDFStream) {
    try {
      const cm = parseCMap(streamBytes(ctx, encObj));
      if (cm.space.length) space = cm.space;
      cidOf = (c) => {
        const d = cm.cid.get(c);
        if (d != null) return d;
        for (const r of cm.cidRanges) if (c >= r.lo && c <= r.hi) return r.cid + (c - r.lo);
        return 0;
      };
    } catch {
      unsupported = "cmap-damaged";
    }
  } else if (/-V$/.test(encName)) unsupported = "vertical";
  else if (/^Identity-H$/.test(encName)) {
    /* code == CID */
  } else if (/UCS2-H$|UTF16-H$/.test(encName)) {
    codeIsUnicode = true;
    cidOf = () => -1; // CIDs come from a predefined CMap we do not ship: widths fall back to DW
  } else {
    // other predefined CMaps (EUC/UHC/SJIS/GBK/Big5): lead bytes ≥ 0x81 start a 2-byte code
    space = [
      { len: 1, lo: 0, hi: 0x80 },
      { len: 2, lo: 0x8140, hi: 0xfefe },
    ];
    cidOf = () => -1;
  }
  const tu = toUnicodeOf(doc, fd);
  // embedded TrueType program: glyph presence (loca) and, without ToUnicode, Unicode from its cmap
  const ff2 = desc?.get(PDFName.of("FontFile2"));
  let ttData: Uint8Array | null = null;
  if (ff2) {
    try {
      ttData = streamBytes(ctx, ff2);
    } catch {
      ttData = null;
    }
  }
  let glyph = ttData ? trueTypeGlyphs(ttData) : null;
  const c2g = dget(ctx, cid, "CIDToGIDMap");
  let gidOf = (c: number) => c;
  let cidOfGid = (g: number) => g;
  if (c2g instanceof PDFStream) {
    try {
      const m = streamBytes(ctx, c2g);
      gidOf = (c) => (c * 2 + 1 < m.length ? (m[c * 2] << 8) | m[c * 2 + 1] : 0);
      const back = new Map<number, number>();
      for (let c = 0; c * 2 + 1 < m.length; c++) {
        const g = (m[c * 2] << 8) | m[c * 2 + 1];
        if (g && !back.has(g)) back.set(g, c);
      }
      cidOfGid = (g) => back.get(g) ?? -1;
    } catch {
      glyph = null;
    }
  }
  const ttUni = !tu && ttData && /^Identity-H$/.test(encName) ? trueTypeUnicode(ttData) : null;
  // Adobe CJK collections (e.g. Adobe-Korea1 in Illustrator files): CID → Unicode from the UCS2 CMap
  const ordering = textOf(dget(ctx, dictOf(dget(ctx, cid, "CIDSystemInfo")), "Ordering")) ?? "";
  const collection = !tu && !ttUni && /^Identity-H$/.test(encName) ? doc.cidUnicode.get(ordering) ?? null : null;
  if (!tu && !codeIsUnicode && !ttUni && !collection && !unsupported) unsupported = "cid-no-tounicode";
  const dw = numOf(dget(ctx, cid, "DW")) ?? 1000;
  const wmap = new Map<number, number>();
  const W = dget(ctx, cid, "W");
  if (W instanceof PDFArray) {
    const a = W.asArray().map((x) => look(ctx, x));
    for (let i = 0; i < a.length; ) {
      const c0 = numOf(a[i]);
      const next = a[i + 1];
      if (c0 == null) break;
      if (next instanceof PDFArray) {
        next.asArray().forEach((w, k) => wmap.set(c0 + k, numOf(look(ctx, w)) ?? dw));
        i += 2;
      } else {
        const c1 = numOf(next), w = numOf(a[i + 2]);
        if (c1 == null || w == null) break;
        for (let c = c0; c <= c1 && c - c0 < 65536; c++) wmap.set(c, w);
        i += 3;
      }
    }
  }
  const lens = [...new Set(space.map((s) => s.len))].sort((x, y) => x - y);
  const codes = (b: Uint8Array) => {
    const out: { code: number; len: number }[] = [];
    for (let i = 0; i < b.length; ) {
      let hit = 0, code = 0;
      for (const n of lens) {
        if (i + n > b.length) break;
        const c = intOf(b.subarray(i, i + n));
        if (space.some((s) => s.len === n && c >= s.lo && c <= s.hi)) {
          hit = n;
          code = c;
          break;
        }
      }
      if (!hit) {
        hit = Math.min(lens[0], b.length - i);
        code = intOf(b.subarray(i, i + hit));
      }
      out.push({ code, len: hit });
      i += hit;
    }
    return out;
  };
  const codeLen = (code: number) => space.find((s) => code >= s.lo && code <= s.hi && (s.len === 1 ? code <= 0xff : true))?.len ?? lens[lens.length - 1];
  const unicode = (code: number) => {
    if (tu) return cmapUnicode(tu, code) ?? "";
    if (codeIsUnicode) return String.fromCharCode(code);
    if (collection) return collection.get(code) ?? "";
    const cp = ttUni?.gidToUni.get(gidOf(code));
    return cp != null ? String.fromCodePoint(cp) : "";
  };
  const advance = (code: number) => {
    const c = cidOf(code);
    return (c >= 0 ? wmap.get(c) ?? dw : dw) / 1000;
  };
  // glyph presence: embedded TrueType → check the outline; otherwise trust ToUnicode/used codes
  const used = new Set<number>();
  const listed = (code: number) => (tu ? cmapUnicode(tu, code) !== undefined : codeIsUnicode || !!collection?.has(code) || !!ttUni?.gidToUni.has(gidOf(code)));
  const ok = (code: number) => {
    if (used.has(code)) return true;
    if (!listed(code)) return false;
    if (glyph) {
      const c = cidOf(code);
      if (c < 0) return false;
      const ws = /^\s$/.test(unicode(code));
      return ws ? gidOf(c) > 0 : glyph(gidOf(c));
    }
    return !subset || !!tu; // CFF subsets: ToUnicode of a subset lists only kept glyphs
  };
  let rev: Map<string, number> | null = null;
  const entries = (): Iterable<[number, string]> => {
    if (tu) return cmapEntries(tu);
    if (codeIsUnicode) return [...Array(0x10000).keys()].map((c) => [c, String.fromCharCode(c)] as [number, string]);
    if (collection) return collection;
    if (ttUni) return [...ttUni.gidToUni].map(([g, cp]) => [cidOfGid(g), String.fromCodePoint(cp)] as [number, string]).filter(([c]) => c >= 0);
    return [];
  };
  const style = styleOf(base, desc, ctx);
  return {
    id,
    ref,
    subtype: "Type0",
    baseFont: base,
    subset,
    composite: true,
    ...style,
    unsupported,
    codes,
    unicode,
    advance,
    used,
    ...(ttData && glyph
      ? {
          program: {
            data: ttData,
            uniToGid: () => {
              const m = new Map<number, number>();
              for (const [code, u] of entries()) {
                const cp = u.codePointAt(0);
                const c = cidOf(code);
                if (cp === undefined || [...u].length !== 1 || c < 0 || m.has(cp)) continue;
                const g = gidOf(c);
                if (g > 0) m.set(cp, g);
              }
              return m;
            },
          },
        }
      : {}),
    encode: (text) =>
      encoder((rev ??= reverseMap(entries())), ok, (c) => {
        const n = codeLen(c);
        const b = new Uint8Array(n);
        for (let i = n - 1, v = c; i >= 0; i--, v = Math.floor(v / 256)) b[i] = v & 255;
        return b;
      })(text),
  };
}
