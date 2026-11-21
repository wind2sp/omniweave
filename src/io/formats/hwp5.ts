// HWP 5.0 binary → HWPX package, so a .hwp file goes through the HWPX importer (parseHwpxFlow) with the same
// fidelity: character / paragraph shapes, fonts, border fills, numbering, styles, page setup, tables, pictures,
// headers / footers, notes and 한글's own line layout (lineseg).
//
// Source: 한글과컴퓨터 "한글 문서 파일 형식 5.0" (public, rev 1.3) record layouts, checked field by field against a
// document 한글 saved both as HWP and as HWPX (qa/interop/adobe-made/hwp_doc.hwp ↔ hwpx_doc.hwpx). The XML follows
// what 한글 itself writes (OWPML 2011 namespaces), including hp:switch for paragraph margins: the binary keeps
// margins / non-percent line spacing / tab positions at twice HWPUNIT, which is what 한글 writes in hp:default,
// while hp:case (HwpUnitChar) holds the HWPUNIT value our readers use.
//
// Text positions: a text character is one unit, char controls (line break, hyphen, nb / fixed-width space) one,
// inline and extended controls (tab, section / column definitions, fields, tables, pictures, notes, headers, auto
// numbers …) eight — the lineseg textpos units. Every extended control becomes exactly one element in the run
// sequence (hp:secPr, hp:ctrl, hp:tbl, hp:pic …), so the HWPX unit count (core/layoutcheck/hwpxLineseg.ts) stays
// equal to the binary one.

import { inflateSync, strToU8, zipSync, type Zippable } from "fflate";
import { t } from "../../i18n";
import { readCfb, type Cfb } from "./cfb";

// record tags (HWPTAG_BEGIN = 0x10)
const DOC_PROPS = 0x10, ID_MAPPINGS = 0x11, BIN_DATA = 0x12, FACE_NAME = 0x13, BORDER_FILL = 0x14, CHAR_SHAPE = 0x15, TAB_DEF = 0x16, NUMBERING = 0x17, BULLET = 0x18, PARA_SHAPE = 0x19, STYLE = 0x1a, COMPAT_DOC = 0x1e;
const PARA_HEADER = 0x42, PARA_TEXT = 0x43, PARA_CHAR_SHAPE = 0x44, PARA_LINE_SEG = 0x45, CTRL_HEADER = 0x47, LIST_HEADER = 0x48, PAGE_DEF = 0x49, FOOTNOTE_SHAPE = 0x4a, PAGE_BORDER_FILL = 0x4b;
const SHAPE_COMPONENT = 0x4c, TABLE = 0x4d, SC_PICTURE = 0x55, EQEDIT = 0x58;

interface Rec {
  tag: number;
  level: number;
  d: Uint8Array;
  kids: Rec[];
}

const u8 = (d: Uint8Array, o: number) => d[o] ?? 0;
const i8 = (d: Uint8Array, o: number) => (u8(d, o) << 24) >> 24;
const u16 = (d: Uint8Array, o: number) => (o + 1 < d.length ? d[o] | (d[o + 1] << 8) : 0);
const i16 = (d: Uint8Array, o: number) => (u16(d, o) << 16) >> 16;
const u32 = (d: Uint8Array, o: number) => (o + 3 < d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + ((d[o + 3] << 24) >>> 0) : 0);
const i32 = (d: Uint8Array, o: number) => u32(d, o) | 0;
const bits = (v: number, from: number, n: number) => (v >>> from) & ((1 << n) - 1);
/** WCHAR string with a u16 length prefix: [text, offset after it] */
function str(d: Uint8Array, o: number): [string, number] {
  const n = u16(d, o);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(u16(d, o + 2 + i * 2));
  return [s, o + 2 + n * 2];
}
/** four-character control id ('secd', 'tbl ', …), stored as a little-endian u32 */
const ctrlId = (d: Uint8Array) => String.fromCharCode(u8(d, 3), u8(d, 2), u8(d, 1), u8(d, 0));

/** Records of a stream as a tree: a record's children follow it with level + 1. */
function records(data: Uint8Array): Rec[] {
  const root: Rec[] = [];
  const stack: Rec[] = [];
  for (let o = 0; o + 4 <= data.length; ) {
    const h = u32(data, o);
    const tag = h & 0x3ff, level = (h >>> 10) & 0x3ff;
    let size = h >>> 20;
    o += 4;
    if (size === 0xfff) {
      size = u32(data, o);
      o += 4;
    }
    if (o + size > data.length) break;
    const r: Rec = { tag, level, d: data.subarray(o, o + size), kids: [] };
    o += size;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : root).push(r);
    stack.push(r);
  }
  return root;
}
const flat = (rs: Rec[]): Rec[] => rs.flatMap((r) => [r, ...flat(r.kids)]);

// ───────────────────────── XML helpers ─────────────────────────

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>`;
const NS =
  `xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" ` +
  `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" ` +
  `xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"`;
const UNIT_CHAR = "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar";

/** XML text / attribute escape; characters XML cannot hold are dropped */
const esc = (s: string) => s.replace(/[&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : ""));
const chr = (c: number) => (c ? esc(String.fromCharCode(c)) : "");
const b01 = (v: number | boolean) => (v ? "1" : "0");
/** COLORREF (0x00BBGGRR) → #RRGGBB; 0xFFFFFFFF = none */
const col = (v: number) => (v === 0xffffffff ? "none" : "#" + [v & 255, (v >>> 8) & 255, (v >>> 16) & 255].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase());
const pick = <T>(list: readonly T[], i: number, def: T) => list[i] ?? def;

const LANGS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
const LANG_UP = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
/** border / note line types (0 = none); underline and strikeout shapes are the same list without NONE */
const LINE = ["NONE", "SOLID", "DASH", "DOT", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH", "CIRCLE", "DOUBLE_SLIM", "SLIM_THICK", "THICK_SLIM", "SLIM_THICK_SLIM", "WAVE", "DOUBLE_WAVE", "THICK_3D", "THICK_3D_REVERS", "3D", "3D_REVERS"];
const WIDTH = ["0.1 mm", "0.12 mm", "0.15 mm", "0.2 mm", "0.25 mm", "0.3 mm", "0.4 mm", "0.5 mm", "0.6 mm", "0.7 mm", "1.0 mm", "1.5 mm", "2.0 mm", "3.0 mm", "4.0 mm", "5.0 mm"];
const NUM_FMT = ["DIGIT", "CIRCLED_DIGIT", "ROMAN_CAPITAL", "ROMAN_SMALL", "LATIN_CAPITAL", "LATIN_SMALL", "CIRCLED_LATIN_CAPITAL", "CIRCLED_LATIN_SMALL", "HANGUL_SYLLABLE", "CIRCLED_HANGUL_SYLLABLE", "HANGUL_JAMO", "CIRCLED_HANGUL_JAMO", "HANGUL_PHONETIC", "IDEOGRAPH", "CIRCLED_IDEOGRAPH", "DECAGON_CIRCLE", "DECAGON_CIRCLE_HANJA"];
const numFmt = (v: number) => (v === 0x80 ? "SYMBOL" : v === 0x81 ? "USER_CHAR" : pick(NUM_FMT, v, "DIGIT"));
const NUM_TYPE = ["PAGE", "FOOTNOTE", "ENDNOTE", "PICTURE", "TABLE", "EQUATION", "TOTAL_PAGE"];
const SUBLIST_VALIGN = ["TOP", "CENTER", "BOTTOM"];

// ───────────────────────── DocInfo → header.xml ─────────────────────────

interface BinItem {
  id: number;
  ext: string;
  compress: number;
}

function headerXml(info: Rec[], secCnt: number, bins: BinItem[]): string {
  const all = flat(info);
  const of = (tag: number) => all.filter((r) => r.tag === tag);
  const out: string[] = [];

  // start numbers
  const dp = of(DOC_PROPS)[0]?.d ?? new Uint8Array(0);
  const sn = (o: number) => u16(dp, o) || 1;
  out.push(`<hh:beginNum page="${sn(2)}" footnote="${sn(4)}" endnote="${sn(6)}" pic="${sn(8)}" tbl="${sn(10)}" equation="${sn(12)}"/>`, "<hh:refList>");

  // fonts: FACE_NAME records in language order, counts from ID_MAPPINGS
  const idm = of(ID_MAPPINGS)[0]?.d ?? new Uint8Array(0);
  const faces = of(FACE_NAME);
  const fontType = (v: number) => pick(["REP", "TTF", "HFT"], v, "TTF");
  let fi = 0;
  out.push(`<hh:fontfaces itemCnt="7">`);
  LANG_UP.forEach((lang, li) => {
    const n = idm.length >= 4 * (li + 2) ? i32(idm, 4 * (li + 1)) : 0;
    const fonts: string[] = [];
    for (let k = 0; k < n && fi < faces.length; k++, fi++) {
      const d = faces[fi].d;
      const props = u8(d, 0);
      let [name, o] = str(d, 1);
      let inner = "";
      if (props & 0x80) {
        const alt = u8(d, o);
        const [an, o2] = str(d, o + 1);
        o = o2;
        inner += `<hh:substFont face="${esc(an)}" type="${fontType(alt)}" isEmbedded="0" binaryItemIDRef=""/>`;
      }
      if (props & 0x40) {
        const ti = (k2: number) => u8(d, o + k2);
        const FCAT = ["FCAT_UNKNOWN", "FCAT_MYUNGJO", "FCAT_GOTHIC", "FCAT_SSERIF", "FCAT_BRUSHSCRIPT", "FCAT_DECORATIVE", "FCAT_NONRECTMJ", "FCAT_NONRECTGT"];
        inner += `<hh:typeInfo familyType="${pick(FCAT, ti(0), "FCAT_UNKNOWN")}" weight="${ti(2)}" proportion="${ti(3)}" contrast="${ti(4)}" strokeVariation="${ti(5)}" armStyle="${ti(6)}" letterform="${ti(7)}" midline="${ti(8)}" xHeight="${ti(9)}"/>`;
      }
      fonts.push(`<hh:font id="${k}" face="${esc(name)}" type="${fontType(props & 3)}" isEmbedded="0">${inner}</hh:font>`);
    }
    out.push(`<hh:fontface lang="${lang}" fontCnt="${fonts.length}">${fonts.join("")}</hh:fontface>`);
  });
  out.push(`</hh:fontfaces>`);

  // border fills (ids 1-based)
  const bfs = of(BORDER_FILL);
  out.push(`<hh:borderFills itemCnt="${bfs.length}">`);
  bfs.forEach((r, i) => {
    const d = r.d;
    const p = u16(d, 0);
    const SLASH: Record<number, string> = { 0: "NONE", 2: "CENTER", 3: "CENTER_BELOW", 6: "CENTER_ABOVE", 7: "ALL" };
    const line = (n: string, o: number) => `<hh:${n} type="${pick(LINE, u8(d, o), "SOLID")}" width="${pick(WIDTH, u8(d, o + 1), "0.1 mm")}" color="${col(u32(d, o + 2))}"/>`;
    let fill = "";
    const ft = u32(d, 32);
    if (ft & 1) {
      const pt = i32(d, 44);
      const HATCH = ["HORIZONTAL", "VERTICAL", "BACK_SLASH", "SLASH", "CROSS", "CROSS_DIAGONAL"];
      fill = `<hc:fillBrush><hc:winBrush faceColor="${col(u32(d, 36))}" hatchColor="${col(u32(d, 40))}"${pt >= 0 && HATCH[pt] ? ` hatchStyle="${HATCH[pt]}"` : ""} alpha="0"/></hc:fillBrush>`;
    }
    out.push(
      `<hh:borderFill id="${i + 1}" threeD="${b01(p & 1)}" shadow="${b01(p & 2)}" centerLine="NONE" breakCellSeparateLine="0">` +
        `<hh:slash type="${SLASH[bits(p, 2, 3)] ?? "NONE"}" Crooked="0" isCounter="0"/><hh:backSlash type="${SLASH[bits(p, 5, 3)] ?? "NONE"}" Crooked="0" isCounter="0"/>` +
        `${line("leftBorder", 2)}${line("rightBorder", 8)}${line("topBorder", 14)}${line("bottomBorder", 20)}${line("diagonal", 26)}${fill}</hh:borderFill>`,
    );
  });
  out.push(`</hh:borderFills>`);

  // character shapes
  const css = of(CHAR_SHAPE);
  out.push(`<hh:charProperties itemCnt="${css.length}">`);
  css.forEach((r, i) => {
    const d = r.d;
    const langs = (f: (k: number) => number) => LANGS.map((l, k) => `${l}="${f(k)}"`).join(" ");
    const p = u32(d, 46);
    const text = u32(d, 52);
    const ulKind = bits(p, 2, 2); // 0 none, 1 below, 3 above (2: an old strikeout position, not an underline)
    const strike = bits(p, 18, 3) !== 0;
    const SYM = ["NONE", "DOT_ABOVE", "RING_ABOVE", "TILDE", "CARON", "SIDE", "COLON", "GRAVE_ACCENT", "ACUTE_ACCENT", "CIRCUMFLEX", "MACRON", "HOOK_ABOVE", "DOT_BELOW"];
    out.push(
      `<hh:charPr id="${i}" height="${i32(d, 42)}" textColor="${col(text)}" shadeColor="${col(u32(d, 60))}" useFontSpace="${b01(p & (1 << 25))}" useKerning="${b01(p & (1 << 30))}" symMark="${pick(SYM, bits(p, 21, 4), "NONE")}" borderFillIDRef="${d.length >= 70 ? u16(d, 68) : 2}">` +
        `<hh:fontRef ${langs((k) => u16(d, k * 2))}/><hh:ratio ${langs((k) => u8(d, 14 + k))}/><hh:spacing ${langs((k) => i8(d, 21 + k))}/><hh:relSz ${langs((k) => u8(d, 28 + k))}/><hh:offset ${langs((k) => i8(d, 35 + k))}/>` +
        (p & 1 ? "<hh:italic/>" : "") +
        (p & 2 ? "<hh:bold/>" : "") +
        `<hh:underline type="${ulKind === 1 ? "BOTTOM" : ulKind === 3 ? "TOP" : "NONE"}" shape="${pick(LINE, bits(p, 4, 4) + 1, "SOLID")}" color="${col(u32(d, 56))}"/>` +
        `<hh:strikeout shape="${strike ? pick(LINE, bits(p, 26, 4) + 1, "SOLID") : "NONE"}" color="${col(d.length >= 74 ? u32(d, 70) : text)}"/>` +
        `<hh:outline type="${pick(["NONE", "SOLID", "DOT", "THICK", "DASH", "DASH_DOT", "DASH_DOT_DOT"], bits(p, 8, 3), "NONE")}"/>` +
        `<hh:shadow type="${pick(["NONE", "DROP", "CONTINUOUS"], bits(p, 11, 2), "NONE")}" color="${col(u32(d, 64))}" offsetX="${i8(d, 50)}" offsetY="${i8(d, 51)}"/>` +
        (p & (1 << 13) ? "<hh:emboss/>" : "") +
        (p & (1 << 14) ? "<hh:engrave/>" : "") +
        (p & (1 << 15) ? "<hh:supscript/>" : p & (1 << 16) ? "<hh:subscript/>" : "") +
        `</hh:charPr>`,
    );
  });
  out.push(`</hh:charProperties>`);

  // tab definitions (positions twice HWPUNIT like margins: hp:case holds HWPUNIT)
  const tabs = of(TAB_DEF);
  out.push(`<hh:tabProperties itemCnt="${tabs.length}">`);
  tabs.forEach((r, i) => {
    const d = r.d;
    const p = u32(d, 0);
    const n = Math.max(0, Math.min(i32(d, 4), Math.floor((d.length - 8) / 8)));
    const item = (k: number, half: boolean) => {
      const o = 8 + k * 8;
      const pos = u32(d, o);
      return `<hh:tabItem pos="${half ? Math.round(pos / 2) : pos}" type="${pick(["LEFT", "RIGHT", "CENTER", "DECIMAL"], u8(d, o + 4), "LEFT")}" leader="${pick(LINE, u8(d, o + 5), "NONE")}"${half ? ` unit="HWPUNIT"` : ""}/>`;
    };
    const items = (half: boolean) => Array.from({ length: n }, (_, k) => item(k, half)).join("");
    const head = `<hh:tabPr id="${i}" autoTabLeft="${b01(p & 1)}" autoTabRight="${b01(p & 2)}"`;
    out.push(n ? `${head}><hp:switch><hp:case hp:required-namespace="${UNIT_CHAR}">${items(true)}</hp:case><hp:default>${items(false)}</hp:default></hp:switch></hh:tabPr>` : `${head}/>`);
  });
  out.push(`</hh:tabProperties>`);

  // numberings (ids 1-based): 7 levels, start, per-level starts, then levels 8–10 (5.1)
  const paraHead = (d: Uint8Array, o: number, level: number, start: number, text: string | null) => {
    const p = u32(d, o);
    const attrs =
      `start="${start}" level="${level}" align="${pick(["LEFT", "CENTER", "RIGHT"], bits(p, 0, 2), "LEFT")}" useInstWidth="${b01(p & 4)}" autoIndent="${b01(p & 8)}" widthAdjust="${i16(d, o + 4)}" ` +
      `textOffsetType="${p & 16 ? "HWPUNIT" : "PERCENT"}" textOffset="${u16(d, o + 6)}" numFormat="${numFmt(bits(p, 5, 4))}" charPrIDRef="${u32(d, o + 8)}" checkable="0"`;
    return text === null ? `<hh:paraHead ${attrs}/>` : text ? `<hh:paraHead ${attrs}>${esc(text)}</hh:paraHead>` : `<hh:paraHead ${attrs}/>`;
  };
  const nums = of(NUMBERING);
  out.push(`<hh:numberings itemCnt="${nums.length}">`);
  nums.forEach((r, i) => {
    const d = r.d;
    let o = 0;
    const lv: { o: number; text: string }[] = [];
    for (let k = 0; k < 7 && o + 12 <= d.length; k++) {
      const [s, next] = str(d, o + 12);
      lv.push({ o, text: s });
      o = next;
    }
    const start = u16(d, o);
    o += 2;
    const starts: number[] = [];
    if (o + 28 <= d.length) for (let k = 0; k < 7; k++, o += 4) starts.push(u32(d, o));
    for (let k = 7; k < 10 && o + 14 <= d.length; k++) {
      const [s, next] = str(d, o + 12);
      lv.push({ o, text: s });
      o = next;
    }
    if (o + 12 <= d.length) for (let k = 7; k < 10; k++, o += 4) starts.push(u32(d, o));
    out.push(`<hh:numbering id="${i + 1}" start="${start}">${lv.map((l, k) => paraHead(d, l.o, k + 1, starts[k] || 1, l.text)).join("")}</hh:numbering>`);
  });
  out.push(`</hh:numberings>`);

  // bullets (ids 1-based)
  const buls = of(BULLET);
  if (buls.length) {
    out.push(`<hh:bullets itemCnt="${buls.length}">`);
    buls.forEach((r, i) => {
      const d = r.d;
      const img = d.length >= 18 ? i32(d, 14) : 0;
      out.push(`<hh:bullet id="${i + 1}" char="${chr(u16(d, 12))}" useImage="${b01(img > 0)}">${paraHead(d, 0, 0, 1, null)}</hh:bullet>`);
    });
    out.push(`</hh:bullets>`);
  }

  // paragraph shapes
  const pss = of(PARA_SHAPE);
  out.push(`<hh:paraProperties itemCnt="${pss.length}">`);
  pss.forEach((r, i) => {
    const d = r.d;
    const p1 = u32(d, 0), p2 = u32(d, 42);
    const newLs = d.length >= 54;
    const lsType = newLs ? bits(u32(d, 46), 0, 5) : bits(p1, 0, 2);
    const lsVal = newLs ? i32(d, 50) : i32(d, 24);
    const headType = bits(p1, 23, 2);
    const level = d.length >= 58 && headType ? u32(d, 54) : bits(p1, 25, 3);
    const LST = ["PERCENT", "FIXED", "BETWEEN_LINES", "AT_LEAST"];
    const block = (half: boolean) => {
      const v = (x: number) => (half ? Math.round(x / 2) : x);
      return (
        `<hh:margin><hc:intent value="${v(i32(d, 12))}" unit="HWPUNIT"/><hc:left value="${v(i32(d, 4))}" unit="HWPUNIT"/><hc:right value="${v(i32(d, 8))}" unit="HWPUNIT"/>` +
        `<hc:prev value="${v(i32(d, 16))}" unit="HWPUNIT"/><hc:next value="${v(i32(d, 20))}" unit="HWPUNIT"/></hh:margin>` +
        `<hh:lineSpacing type="${pick(LST, lsType, "PERCENT")}" value="${lsType === 0 ? lsVal : v(lsVal)}" unit="HWPUNIT"/>`
      );
    };
    out.push(
      `<hh:paraPr id="${i}" tabPrIDRef="${u16(d, 28)}" condense="${bits(p1, 9, 7)}" fontLineHeight="${b01(p1 & (1 << 22))}" snapToGrid="${b01(p1 & (1 << 8))}" suppressLineNumbers="0" checked="0" textDir="LTR">` +
        `<hh:align horizontal="${pick(["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"], bits(p1, 2, 3), "JUSTIFY")}" vertical="${pick(["BASELINE", "TOP", "CENTER", "BOTTOM"], bits(p1, 20, 2), "BASELINE")}"/>` +
        `<hh:heading type="${pick(["NONE", "OUTLINE", "NUMBER", "BULLET"], headType, "NONE")}" idRef="${u16(d, 30)}" level="${level}"/>` +
        `<hh:breakSetting breakLatinWord="${pick(["KEEP_WORD", "HYPHENATION", "BREAK_WORD"], bits(p1, 5, 2), "KEEP_WORD")}" breakNonLatinWord="${p1 & 0x80 ? "KEEP_WORD" : "BREAK_WORD"}" ` +
        `widowOrphan="${b01(p1 & (1 << 16))}" keepWithNext="${b01(p1 & (1 << 17))}" keepLines="${b01(p1 & (1 << 18))}" pageBreakBefore="${b01(p1 & (1 << 19))}" lineWrap="${pick(["BREAK", "SQUEEZE", "KEEP"], bits(p2, 0, 2), "BREAK")}"/>` +
        `<hh:autoSpacing eAsianEng="${b01(p2 & 16)}" eAsianNum="${b01(p2 & 32)}"/>` +
        `<hp:switch><hp:case hp:required-namespace="${UNIT_CHAR}">${block(true)}</hp:case><hp:default>${block(false)}</hp:default></hp:switch>` +
        `<hh:border borderFillIDRef="${u16(d, 32)}" offsetLeft="${i16(d, 34)}" offsetRight="${i16(d, 36)}" offsetTop="${i16(d, 38)}" offsetBottom="${i16(d, 40)}" connect="${b01(p1 & (1 << 28))}" ignoreMargin="${b01(p1 & (1 << 29))}"/>` +
        `</hh:paraPr>`,
    );
  });
  out.push(`</hh:paraProperties>`);

  // styles
  const sts = of(STYLE);
  out.push(`<hh:styles itemCnt="${sts.length}">`);
  sts.forEach((r, i) => {
    const d = r.d;
    const [name, o1] = str(d, 0);
    const [eng, o] = str(d, o1);
    out.push(
      `<hh:style id="${i}" type="${u8(d, o) & 7 ? "CHAR" : "PARA"}" name="${esc(name)}" engName="${esc(eng)}" paraPrIDRef="${u16(d, o + 4)}" charPrIDRef="${u16(d, o + 6)}" nextStyleIDRef="${u8(d, o + 1)}" langID="${i16(d, o + 2)}" lockForm="0"/>`,
    );
  });
  out.push(`</hh:styles></hh:refList>`);
  const cd = of(COMPAT_DOC)[0];
  out.push(`<hh:compatibleDocument targetProgram="${pick(["HWP201X", "HWP200X", "MS_WORD"], cd ? u32(cd.d, 0) : 0, "HWP201X")}"><hh:layoutCompatibility/></hh:compatibleDocument>`);
  out.push(`<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>`);

  // binary items (pictures): BIN_DATA records in order, ids from the records
  of(BIN_DATA).forEach((r) => {
    const d = r.d;
    const p = u16(d, 0);
    if (bits(p, 0, 4) === 0) return; // linked file: not in the package
    const [ext] = str(d, 4);
    bins.push({ id: u16(d, 2), ext: ext.toLowerCase(), compress: bits(p, 4, 2) });
  });
  return `${XML_HEAD}<hh:head ${NS} version="1.4" secCnt="${secCnt}">${out.join("")}</hh:head>`;
}

// ───────────────────────── BodyText → section*.xml ─────────────────────────

/** a paragraph list: LIST_HEADER and the paragraphs after it */
interface List {
  head: Rec;
  paras: Rec[];
}
function lists(kids: Rec[]): List[] {
  const out: List[] = [];
  let cur: List | null = null;
  for (const k of kids) {
    if (k.tag === LIST_HEADER) out.push((cur = { head: k, paras: [] }));
    else if (k.tag === PARA_HEADER && cur) cur.paras.push(k);
    else if (k.tag !== PARA_HEADER) cur = null;
  }
  return out;
}

/** extended controls (a CTRL_HEADER each) and the other 8-unit controls; the rest are 1-unit char controls */
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
const SINGLE = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);

class Body {
  constructor(private binRef: (id: number) => string) {}

  subList(l: List, extra = ""): string {
    const p = u32(l.head.d, 4);
    return (
      `<hp:subList id="" textDirection="${p & 7 ? "VERTICAL" : "HORIZONTAL"}" lineWrap="${pick(["BREAK", "SQUEEZE", "KEEP"], bits(p, 3, 2), "BREAK")}" vertAlign="${pick(SUBLIST_VALIGN, bits(p, 5, 2), "TOP")}" ` +
      `linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"${extra}>${l.paras.map((x) => this.para(x)).join("")}</hp:subList>`
    );
  }

  para(p: Rec): string {
    const d = p.d;
    const kid = (tag: number) => p.kids.find((k) => k.tag === tag);
    const text = kid(PARA_TEXT)?.d ?? new Uint8Array(0);
    const csd = kid(PARA_CHAR_SHAPE)?.d;
    const pairs: [number, number][] = [];
    if (csd) for (let o = 0; o + 8 <= csd.length; o += 8) pairs.push([u32(csd, o), u32(csd, o + 4)]);
    if (!pairs.length) pairs.push([0, 0]);
    const ctrls = p.kids.filter((k) => k.tag === CTRL_HEADER);
    const used = new Set<Rec>();
    const takeCtrl = (id: number) => {
      const r = ctrls.find((c) => !used.has(c) && u32(c.d, 0) === id) ?? ctrls.find((c) => !used.has(c));
      if (r) used.add(r);
      return r;
    };

    // runs: split where the character shape changes; hp:t holds text and the inline marks
    const runs: string[] = [];
    let run = "", tbuf = "", runCp = -1, ci = 0;
    const flushT = () => {
      if (tbuf) run += `<hp:t>${tbuf}</hp:t>`;
      tbuf = "";
    };
    const closeRun = () => {
      flushT();
      if (runCp >= 0) runs.push(run ? `<hp:run charPrIDRef="${runCp}">${run}</hp:run>` : `<hp:run charPrIDRef="${runCp}"/>`);
      run = "";
    };
    const n = text.length >> 1;
    for (let i = 0; i < n; ) {
      while (ci + 1 < pairs.length && pairs[ci + 1][0] <= i) ci++;
      if (pairs[ci][1] !== runCp) {
        closeRun();
        runCp = pairs[ci][1];
      }
      const c = u16(text, i * 2);
      if (c >= 32) {
        if (c !== 0xfffe && c !== 0xffff) tbuf += esc(String.fromCharCode(c));
        i++;
        continue;
      }
      if (SINGLE.has(c)) {
        tbuf += c === 10 ? "<hp:lineBreak/>" : c === 24 ? "<hp:hyphen/>" : c === 30 ? "<hp:nbSpace/>" : c === 31 ? "<hp:fwSpace/>" : "";
        i++;
        continue;
      }
      if (c === 9) {
        // tab: its width (HWPUNIT) and leader / type in the control's data
        tbuf += `<hp:tab width="${u32(text, i * 2 + 2)}" leader="${u8(text, i * 2 + 6)}" type="${u8(text, i * 2 + 7)}"/>`;
      } else {
        flushT();
        if (EXTENDED.has(c)) {
          const r = takeCtrl(u32(text, i * 2 + 2));
          run += r ? this.ctrl(r) : "<hp:ctrl/>";
        } else if (c === 4) run += `<hp:ctrl><hp:fieldEnd beginIDRef="" fieldid=""/></hp:ctrl>`;
        else run += "<hp:ctrl/>"; // title mark and reserved inline controls: 8 units, no content
      }
      i += 8;
    }
    if (runCp < 0) runCp = pairs[0][1];
    closeRun();

    const ls = kid(PARA_LINE_SEG)?.d;
    let segs = "";
    if (ls && ls.length >= 36) {
      const L = ["textpos", "vertpos", "vertsize", "textheight", "baseline", "spacing", "horzpos", "horzsize", "flags"];
      for (let o = 0; o + 36 <= ls.length; o += 36) segs += `<hp:lineseg ${L.map((a, k) => `${a}="${k === 0 || k === 8 ? u32(ls, o + k * 4) : i32(ls, o + k * 4)}"`).join(" ")}/>`;
      segs = `<hp:linesegarray>${segs}</hp:linesegarray>`;
    }
    const div = u8(d, 11);
    return `<hp:p id="${d.length >= 22 ? u32(d, 18) : 0}" paraPrIDRef="${u16(d, 8)}" styleIDRef="${u8(d, 10)}" pageBreak="${b01(div & 4)}" columnBreak="${b01(div & 8)}" merged="0">${runs.join("")}${segs}</hp:p>`;
  }

  /** one extended control as the element(s) 한글 writes in its place */
  ctrl(c: Rec): string {
    const d = c.d;
    const id = ctrlId(d);
    const subs = () => lists(c.kids);
    switch (id) {
      case "secd":
        return this.secPr(c);
      case "cold": {
        const p = u16(d, 4);
        return `<hp:ctrl><hp:colPr id="" type="${pick(["NEWSPAPER", "BALANCED_NEWSPAPER", "PARALLEL"], bits(p, 0, 2), "NEWSPAPER")}" layout="${pick(["LEFT", "RIGHT", "MIRROR"], bits(p, 10, 2), "LEFT")}" colCount="${Math.max(1, bits(p, 2, 8))}" sameSz="${b01(p & (1 << 12))}" sameGap="${u16(d, 6)}"/></hp:ctrl>`;
      }
      case "tbl ":
        return this.table(c);
      case "gso ":
        return this.gso(c);
      case "eqed": {
        const eq = c.kids.find((k) => k.tag === EQEDIT)?.d;
        const script = eq ? str(eq, 4)[0] : "";
        return `<hp:equation ${this.objAttrs(d, "EQUATION")}>${this.objGeom(d)}<hp:script>${esc(script)}</hp:script></hp:equation>`;
      }
      case "head":
      case "foot": {
        const l = subs()[0];
        const lh = l?.head.d;
        const tag = id === "head" ? "header" : "footer";
        const body = l ? this.subList(l).replace(/textWidth="0" textHeight="0"/, `textWidth="${u32(lh!, 8)}" textHeight="${u32(lh!, 12)}"`) : "";
        return `<hp:ctrl><hp:${tag} id="${u32(d, 8)}" applyPageType="${pick(["BOTH", "EVEN", "ODD"], bits(u32(d, 4), 0, 2), "BOTH")}">${body}</hp:${tag}></hp:ctrl>`;
      }
      case "fn  ":
      case "en  ": {
        const tag = id === "fn  " ? "footNote" : "endNote";
        return `<hp:ctrl><hp:${tag} number="${u32(d, 4)}" suffixChar="${u16(d, 10)}" instId="${u32(d, 16)}">${subs().map((l) => this.subList(l)).join("")}</hp:${tag}></hp:ctrl>`;
      }
      case "tcmt":
        return `<hp:ctrl><hp:hiddenComment>${subs().map((l) => this.subList(l)).join("")}</hp:hiddenComment></hp:ctrl>`;
      case "atno": {
        const p = u32(d, 4);
        return `<hp:ctrl><hp:autoNum num="${u16(d, 8)}" numType="${pick(NUM_TYPE, bits(p, 0, 4), "PAGE")}"><hp:autoNumFormat type="${numFmt(bits(p, 4, 8))}" userChar="${chr(u16(d, 10))}" prefixChar="${chr(u16(d, 12))}" suffixChar="${chr(u16(d, 14))}" supscript="${b01(p & (1 << 12))}"/></hp:autoNum></hp:ctrl>`;
      }
      case "nwno":
        return `<hp:ctrl><hp:newNum num="${u16(d, 8)}" numType="${pick(NUM_TYPE, bits(u32(d, 4), 0, 4), "PAGE")}"/></hp:ctrl>`;
      case "pgnp": {
        const p = u32(d, 4);
        const POS = ["NONE", "TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT", "OUTSIDE_TOP", "OUTSIDE_BOTTOM", "INSIDE_TOP", "INSIDE_BOTTOM"];
        return `<hp:ctrl><hp:pageNum pos="${pick(POS, bits(p, 8, 4), "NONE")}" formatType="${numFmt(bits(p, 0, 8))}" sideChar="${chr(u16(d, 14))}"/></hp:ctrl>`;
      }
      case "pghd": {
        const p = u32(d, 4);
        return `<hp:ctrl><hp:pageHiding hideHeader="${b01(p & 1)}" hideFooter="${b01(p & 2)}" hideMasterPage="${b01(p & 4)}" hideBorder="${b01(p & 8)}" hideFill="${b01(p & 16)}" hidePageNum="${b01(p & 32)}"/></hp:ctrl>`;
      }
      case "bokm":
        return `<hp:ctrl><hp:bookmark name=""/></hp:ctrl>`;
      default:
        // fields (%hlk hyperlink, %clk click-here, …): the field's text follows as ordinary text up to its end mark
        if (id[0] === "%") return `<hp:ctrl><hp:fieldBegin id="${u32(d, 4)}" type="${id === "%hlk" ? "HYPERLINK" : id === "%clk" ? "CLICK_HERE" : "UNKNOWN"}" name="" editable="0" dirty="0" zorder="-1" fieldid="${u32(d, 4)}"/></hp:ctrl>`;
        return "<hp:ctrl/>";
    }
  }

  secPr(c: Rec): string {
    const d = c.d;
    const p = u32(d, 4);
    const kid = (tag: number) => c.kids.filter((k) => k.tag === tag);
    const pd = kid(PAGE_DEF)[0]?.d;
    const tab = u32(d, 14) || 8000;
    let x =
      `<hp:secPr id="" textDirection="${p & (1 << 16) ? "VERTICAL" : "HORIZONTAL"}" spaceColumns="${u16(d, 8)}" tabStop="${tab}" tabStopVal="${tab / 2}" tabStopUnit="HWPUNIT" outlineShapeIDRef="${u16(d, 18)}" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
      `<hp:grid lineGrid="${u16(d, 10)}" charGrid="${u16(d, 12)}" wonggojiFormat="0"/>` +
      `<hp:startNum pageStartsOn="${pick(["BOTH", "EVEN", "ODD"], bits(p, 20, 2), "BOTH")}" page="${u16(d, 20)}" pic="${u16(d, 22)}" tbl="${u16(d, 24)}" equation="${u16(d, 26)}"/>` +
      `<hp:visibility hideFirstHeader="${b01(p & 1)}" hideFirstFooter="${b01(p & 2)}" hideFirstMasterPage="${b01(p & 4)}" border="${p & 8 ? "HIDE_FIRST" : "SHOW_ALL"}" fill="${p & 16 ? "HIDE_FIRST" : "SHOW_ALL"}" hideFirstPageNum="${b01(p & 32)}" hideFirstEmptyLine="${b01(p & (1 << 19))}" showLineNumber="0"/>` +
      `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>`;
    if (pd) {
      const pp = u32(pd, 36);
      x +=
        `<hp:pagePr landscape="${pp & 1 ? "NARROWLY" : "WIDELY"}" width="${u32(pd, 0)}" height="${u32(pd, 4)}" gutterType="${pick(["LEFT_ONLY", "LEFT_RIGHT", "TOP_BOTTOM"], bits(pp, 1, 2), "LEFT_ONLY")}">` +
        `<hp:margin header="${u32(pd, 24)}" footer="${u32(pd, 28)}" gutter="${u32(pd, 32)}" left="${u32(pd, 8)}" right="${u32(pd, 12)}" top="${u32(pd, 16)}" bottom="${u32(pd, 20)}"/></hp:pagePr>`;
    }
    kid(FOOTNOTE_SHAPE).slice(0, 2).forEach((r, k) => {
      const f = r.d;
      const fp = u32(f, 0);
      const tag = k ? "endNotePr" : "footNotePr";
      const place = k ? pick(["END_OF_DOCUMENT", "END_OF_SECTION"], bits(fp, 8, 2), "END_OF_DOCUMENT") : pick(["EACH_COLUMN", "MERGED_COLUMN", "RIGHT_MOST_COLUMN"], bits(fp, 8, 2), "EACH_COLUMN");
      x +=
        `<hp:${tag}><hp:autoNumFormat type="${numFmt(bits(fp, 0, 8))}" userChar="${chr(u16(f, 4))}" prefixChar="${chr(u16(f, 6))}" suffixChar="${chr(u16(f, 8))}" supscript="${b01(fp & (1 << 12))}"/>` +
        `<hp:noteLine length="${i32(f, 12)}" type="${pick(LINE, u8(f, 22), "SOLID")}" width="${pick(WIDTH, u8(f, 23), "0.12 mm")}" color="${col(u32(f, 24))}"/>` +
        `<hp:noteSpacing betweenNotes="${u16(f, 20)}" belowLine="${u16(f, 18)}" aboveLine="${u16(f, 16)}"/>` +
        `<hp:numbering type="${pick(["CONTINUOUS", "ON_SECTION", "ON_PAGE"], bits(fp, 10, 2), "CONTINUOUS")}" newNum="${u16(f, 10) || 1}"/>` +
        `<hp:placement place="${place}" beneathText="${b01(fp & (1 << 13))}"/></hp:${tag}>`;
    });
    kid(PAGE_BORDER_FILL).slice(0, 3).forEach((r, k) => {
      const b = r.d;
      const bp = u32(b, 0);
      x +=
        `<hp:pageBorderFill type="${["BOTH", "EVEN", "ODD"][k]}" borderFillIDRef="${u16(b, 12)}" textBorder="${bp & 1 ? "PAPER" : "CONTENT"}" headerInside="${b01(bp & 2)}" footerInside="${b01(bp & 4)}" fillArea="${pick(["PAPER", "PAGE", "BORDER"], bits(bp, 3, 2), "PAPER")}">` +
        `<hp:offset left="${u16(b, 4)}" right="${u16(b, 6)}" top="${u16(b, 8)}" bottom="${u16(b, 10)}"/></hp:pageBorderFill>`;
    });
    return x + "</hp:secPr>";
  }

  // common object properties of a CTRL_HEADER (tables, drawing objects, equations)
  objAttrs(d: Uint8Array, numbering?: string): string {
    const p = u32(d, 4);
    return (
      `id="${u32(d, 36)}" zOrder="${i32(d, 24)}" numberingType="${numbering ?? pick(["NONE", "PICTURE", "TABLE", "EQUATION"], bits(p, 26, 3), "NONE")}" textWrap="${pick(["SQUARE", "TOP_AND_BOTTOM", "BEHIND_TEXT", "IN_FRONT_OF_TEXT"], bits(p, 21, 3), "TOP_AND_BOTTOM")}" ` +
      `textFlow="${pick(["BOTH_SIDES", "LEFT_ONLY", "RIGHT_ONLY", "LARGEST_ONLY"], bits(p, 24, 2), "BOTH_SIDES")}" lock="0" dropcapstyle="None"`
    );
  }
  objGeom(d: Uint8Array): string {
    const p = u32(d, 4);
    return (
      `<hp:sz width="${u32(d, 16)}" widthRelTo="${pick(["PAPER", "PAGE", "COLUMN", "PARA", "ABSOLUTE"], bits(p, 15, 3), "ABSOLUTE")}" height="${u32(d, 20)}" heightRelTo="${pick(["PAPER", "PAGE", "ABSOLUTE"], bits(p, 18, 2), "ABSOLUTE")}" protect="${b01(p & (1 << 20))}"/>` +
      `<hp:pos treatAsChar="${b01(p & 1)}" affectLSpacing="${b01(p & 4)}" flowWithText="${b01(p & (1 << 13))}" allowOverlap="${b01(p & (1 << 14))}" holdAnchorAndSO="0" ` +
      `vertRelTo="${pick(["PAPER", "PAGE", "PARA"], bits(p, 3, 2), "PARA")}" horzRelTo="${pick(["PAPER", "PAGE", "COLUMN", "PARA"], bits(p, 8, 2), "COLUMN")}" ` +
      `vertAlign="${pick(["TOP", "CENTER", "BOTTOM", "INSIDE", "OUTSIDE"], bits(p, 5, 3), "TOP")}" horzAlign="${pick(["LEFT", "CENTER", "RIGHT", "INSIDE", "OUTSIDE"], bits(p, 10, 3), "LEFT")}" vertOffset="${i32(d, 8)}" horzOffset="${i32(d, 12)}"/>` +
      `<hp:outMargin left="${u16(d, 28)}" right="${u16(d, 30)}" top="${u16(d, 32)}" bottom="${u16(d, 34)}"/>`
    );
  }
  caption(l: List | undefined): string {
    if (!l) return "";
    const d = l.head.d;
    const p = u32(d, 8);
    return `<hp:caption side="${pick(["LEFT", "RIGHT", "TOP", "BOTTOM"], bits(p, 0, 2), "BOTTOM")}" fullSz="${b01(p & 4)}" width="${u32(d, 12)}" gap="${u16(d, 16)}" lastWidth="${u32(d, 18)}">${this.subList(l)}</hp:caption>`;
  }
  /** object description (shape comment) after the common properties */
  comment(d: Uint8Array): string {
    const s = d.length > 46 ? str(d, 44)[0] : "";
    return s ? `<hp:shapeComment>${esc(s.replace(/\r\n?/g, "\n"))}</hp:shapeComment>` : "";
  }

  table(c: Rec): string {
    const d = c.d;
    const ti = c.kids.findIndex((k) => k.tag === TABLE);
    const tb = ti >= 0 ? c.kids[ti].d : new Uint8Array(0);
    const tp = u32(tb, 0);
    const rows = u16(tb, 4), cols = u16(tb, 6);
    const inM = [u16(tb, 10), u16(tb, 12), u16(tb, 14), u16(tb, 16)];
    const cells = lists(ti >= 0 ? c.kids.slice(ti + 1) : []);
    const byRow = new Map<number, string[]>();
    for (const cl of cells) {
      const h = cl.head.d;
      const r = u16(h, 10);
      const m = [u16(h, 24), u16(h, 26), u16(h, 28), u16(h, 30)];
      const tc =
        `<hp:tc name="" header="0" hasMargin="${b01(m.some((v, k) => v !== inM[k]))}" protect="0" editable="0" dirty="0" borderFillIDRef="${u16(h, 32)}">${this.subList(cl)}` +
        `<hp:cellAddr colAddr="${u16(h, 8)}" rowAddr="${r}"/><hp:cellSpan colSpan="${u16(h, 12) || 1}" rowSpan="${u16(h, 14) || 1}"/><hp:cellSz width="${u32(h, 16)}" height="${u32(h, 20)}"/>` +
        `<hp:cellMargin left="${m[0]}" right="${m[1]}" top="${m[2]}" bottom="${m[3]}"/></hp:tc>`;
      byRow.set(r, [...(byRow.get(r) ?? []), tc]);
    }
    const trs = [...byRow.keys()].sort((a, b) => a - b).map((r) => `<hp:tr>${byRow.get(r)!.join("")}</hp:tr>`).join("");
    const bf = u16(tb, 18 + rows * 2);
    return (
      `<hp:tbl ${this.objAttrs(d, "TABLE")} pageBreak="${pick(["NONE", "TABLE", "CELL"], bits(tp, 0, 2), "CELL")}" repeatHeader="${b01(tp & 4)}" rowCnt="${rows}" colCnt="${cols}" cellSpacing="${u16(tb, 8)}" borderFillIDRef="${bf}" noAdjust="0">` +
      `${this.objGeom(d)}<hp:inMargin left="${inM[0]}" right="${inM[1]}" top="${inM[2]}" bottom="${inM[3]}"/>${this.caption(lists(c.kids.slice(0, Math.max(0, ti)))[0])}${trs}</hp:tbl>`
    );
  }

  /** drawing object: pictures as hp:pic; other shapes keep their text box paragraphs; groups hold their members */
  gso(c: Rec): string {
    const d = c.d;
    const sc = c.kids.find((k) => k.tag === SHAPE_COMPONENT);
    const cap = this.caption(lists(c.kids)[0]);
    return sc ? this.shape(sc, d, true, cap) : "<hp:ctrl/>";
  }
  shape(sc: Rec, d: Uint8Array, top: boolean, cap: string): string {
    const s = sc.d;
    const o = top ? 8 : 4; // a component right under the control repeats its id
    const kind = String.fromCharCode(u8(s, 3), u8(s, 2), u8(s, 1), u8(s, 0));
    const fl = u32(s, o + 28);
    const geo =
      `<hp:offset x="${i32(s, o)}" y="${i32(s, o + 4)}"/><hp:orgSz width="${u32(s, o + 12)}" height="${u32(s, o + 16)}"/><hp:curSz width="${u32(s, o + 20)}" height="${u32(s, o + 24)}"/>` +
      `<hp:flip horizontal="${b01(fl & 1)}" vertical="${b01(fl & 2)}"/><hp:rotationInfo angle="${i16(s, o + 32)}" centerX="${i32(s, o + 34)}" centerY="${i32(s, o + 38)}" rotateimage="1"/>` +
      `<hp:renderingInfo>${["trans", "sca", "rot"].map((m) => `<hc:${m}Matrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>`).join("")}</hp:renderingInfo>`;
    // members of a group: their own size and position, inside the group
    const place = top ? this.objGeom(d) : `<hp:sz width="${u32(s, o + 20)}" widthRelTo="ABSOLUTE" height="${u32(s, o + 24)}" heightRelTo="ABSOLUTE" protect="0"/>`;
    const attrs = top ? this.objAttrs(d) : `id="0" zOrder="0" numberingType="NONE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None"`;
    const common = `${attrs} href="" groupLevel="${u16(s, o + 8)}" instid="${top ? u32(d, 36) : 0}"`;
    const pic = sc.kids.find((k) => k.tag === SC_PICTURE);
    if (kind === "$pic" && pic) {
      const q = pic.d;
      const pt = (k: number) => `<hc:pt${k} x="${i32(q, 12 + k * 8)}" y="${i32(q, 16 + k * 8)}"/>`;
      const dims = q.length >= 91 ? [u32(q, q.length - 9), u32(q, q.length - 5)] : [i32(q, 52) - i32(q, 44), i32(q, 56) - i32(q, 48)];
      return (
        `<hp:pic ${common.replace(/instid="\d+"/, `instid="${u32(q, 74)}"`)} reverse="0">${geo}` +
        `<hc:img binaryItemIDRef="${this.binRef(u16(q, 71))}" bright="${i8(q, 68)}" contrast="${i8(q, 69)}" effect="${pick(["REAL_PIC", "GRAY_SCALE", "BLACK_WHITE", "PATTERN8x8"], u8(q, 70), "REAL_PIC")}" alpha="0"/>` +
        `<hp:imgRect>${[0, 1, 2, 3].map(pt).join("")}</hp:imgRect><hp:imgClip left="${i32(q, 44)}" right="${i32(q, 52)}" top="${i32(q, 48)}" bottom="${i32(q, 56)}"/>` +
        `<hp:inMargin left="${u16(q, 60)}" right="${u16(q, 62)}" top="${u16(q, 64)}" bottom="${u16(q, 66)}"/><hp:imgDim dimwidth="${dims[0]}" dimheight="${dims[1]}"/><hp:effects/>` +
        `${place}${cap}${top ? this.comment(d) : ""}</hp:pic>`
      );
    }
    if (kind === "$con") {
      const members = sc.kids.filter((k) => k.tag === SHAPE_COMPONENT).map((k) => this.shape(k, d, false, ""));
      return `<hp:container ${common}>${geo}${members.join("")}${place}${cap}</hp:container>`;
    }
    // other shapes (rectangle, ellipse, line, polygon …): the text box's paragraphs
    const NAMES: Record<string, string> = { $rec: "rect", $ell: "ellipse", $lin: "line", $arc: "arc", $pol: "polygon", $cur: "curve", $ole: "ole" };
    const tag = NAMES[kind] ?? "rect";
    const tb = lists(sc.kids)[0];
    const draw = tb ? `<hp:drawText lastWidth="${u32(tb.head.d, 16)}" name="" editable="0">${this.subList(tb)}</hp:drawText>` : "";
    return `<hp:${tag} ${common}>${geo}${draw}${place}${cap}${top ? this.comment(d) : ""}</hp:${tag}>`;
  }
}

// ───────────────────────── package ─────────────────────────

const MEDIA: Record<string, string> = { png: "image/png", jpg: "image/jpg", jpeg: "image/jpg", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", svg: "image/svg+xml" };

/**
 * Convert an HWP 5.0 document (OLE compound file) into an equivalent HWPX package (zip bytes) for the HWPX importer.
 * Encrypted and distribution-only documents are refused with the same messages as the text import.
 */
export function hwp5ToHwpx(bytes: Uint8Array): Uint8Array {
  let cfb: Cfb;
  try {
    cfb = readCfb(bytes);
  } catch {
    throw new Error(t("engine.legacy.notHwp5"));
  }
  const fh = cfb.get("FileHeader");
  if (!fh || String.fromCharCode(...fh.subarray(0, 17)) !== "HWP Document File") throw new Error(t("engine.legacy.noFileHeader"));
  const props = u32(fh, 36);
  if (props & 0x02) throw new Error(t("engine.legacy.hwpEncrypted"));
  if (props & 0x04) throw new Error(t("engine.legacy.hwpDistribution"));
  const compressed = (props & 0x01) !== 0;
  const open = (s: Uint8Array) => (compressed ? inflateSync(s) : s);
  const sections = [...cfb.streams.keys()].filter((k) => /^BodyText\/Section\d+$/.test(k)).sort((a, b) => Number(a.slice(16)) - Number(b.slice(16)));
  if (!sections.length) throw new Error(t("engine.legacy.noBodyText"));
  const ver = `${fh[35]}.${fh[34]}.${fh[33]}.${fh[32]}`;

  const docInfo = cfb.get("DocInfo");
  const bins: BinItem[] = [];
  const header = headerXml(docInfo ? records(open(docInfo)) : [], sections.length, bins);

  // pictures: BinData/BIN%04X.ext streams (compressed with the document unless the item says otherwise)
  const streamByName = new Map([...cfb.streams.keys()].map((k) => [k.toLowerCase(), k]));
  const files: Zippable = { mimetype: [strToU8("application/hwp+zip"), { level: 0 }] };
  const items: string[] = [];
  const binIds = new Map<number, string>();
  for (const b of bins) {
    const name = streamByName.get(`bindata/bin${b.id.toString(16).toUpperCase().padStart(4, "0")}.${b.ext}`.toLowerCase());
    const raw = name ? cfb.get(name) : undefined;
    if (!raw) continue;
    let data = raw;
    if (b.compress === 1 || (b.compress === 0 && compressed))
      try {
        data = inflateSync(raw);
      } catch {
        data = raw; // stored as is after all
      }
    const ext = b.ext === "jpeg" ? "jpg" : b.ext;
    const path = `BinData/image${b.id}.${ext}`;
    files[path] = data;
    binIds.set(b.id, `image${b.id}`);
    items.push(`<opf:item id="image${b.id}" href="${path}" media-type="${MEDIA[ext] ?? "application/octet-stream"}" isEmbeded="1"/>`);
  }

  const body = new Body((id) => binIds.get(id) ?? `image${id}`);
  const secIds: string[] = [];
  sections.forEach((s, i) => {
    const recs = records(open(cfb.get(s)!));
    const xml = recs.filter((r) => r.tag === PARA_HEADER).map((p) => body.para(p)).join("");
    files[`Contents/section${i}.xml`] = strToU8(`${XML_HEAD}<hs:sec ${NS}>${xml}</hs:sec>`);
    secIds.push(`section${i}`);
  });
  files["Contents/header.xml"] = strToU8(header);
  files["Contents/content.hpf"] = strToU8(
    `${XML_HEAD}<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title/><opf:language>ko</opf:language></opf:metadata><opf:manifest>` +
      `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${items.join("")}${secIds.map((id) => `<opf:item id="${id}" href="Contents/${id}.xml" media-type="application/xml"/>`).join("")}</opf:manifest>` +
      `<opf:spine><opf:itemref idref="header" linear="yes"/>${secIds.map((id) => `<opf:itemref idref="${id}" linear="yes"/>`).join("")}</opf:spine></opf:package>`,
  );
  // the layout (lineseg) is 한글's own: say where the package came from
  files["version.xml"] = strToU8(`${XML_HEAD}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="0" os="1" xmlVersion="1.4" application="Omniweave (from HWP ${ver})" appVersion="${ver}"/>`);
  files["META-INF/container.xml"] = strToU8(
    `${XML_HEAD}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`,
  );
  // a fixed time stamp: the same HWP always converts to the same bytes (one asset, a byte-for-byte unedited save)
  return zipSync(files, { mtime: new Date(2020, 0, 1) });
}
