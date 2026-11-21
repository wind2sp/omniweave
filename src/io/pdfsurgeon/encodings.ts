// PDF Surgeon — simple-font encodings (ISO 32000-1 Annex D) and a glyph-name → Unicode subset
// of the Adobe Glyph List conventions (names, uniXXXX, uXXXX[XX]).

const ASCII_NAMES =
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde".split(" ");

const LATIN1_NAMES =
  "exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot - registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis".split(" ");

const EXTRA_NAMES: Record<string, number> = {
  quoteleft: 0x2018, quoteright: 0x2019, quotesinglbase: 0x201a, quotedblleft: 0x201c, quotedblright: 0x201d, quotedblbase: 0x201e,
  bullet: 0x2022, endash: 0x2013, emdash: 0x2014, ellipsis: 0x2026, dagger: 0x2020, daggerdbl: 0x2021, perthousand: 0x2030,
  trademark: 0x2122, fi: 0xfb01, fl: 0xfb02, Euro: 0x20ac, OE: 0x152, oe: 0x153, Scaron: 0x160, scaron: 0x161, Zcaron: 0x17d,
  zcaron: 0x17e, Ydieresis: 0x178, florin: 0x192, circumflex: 0x2c6, tilde: 0x2dc, dotlessi: 0x131, fraction: 0x2044,
  guilsinglleft: 0x2039, guilsinglright: 0x203a, minus: 0x2212, nbspace: 0xa0, nonbreakingspace: 0xa0, sfthyphen: 0xad,
  Lslash: 0x141, lslash: 0x142, breve: 0x2d8, dotaccent: 0x2d9, ring: 0x2da, hungarumlaut: 0x2dd, ogonek: 0x2db, caron: 0x2c7,
  middot: 0xb7, overscore: 0xaf, apple: 0xf8ff, notequal: 0x2260, infinity: 0x221e, lessequal: 0x2264, greaterequal: 0x2265,
  partialdiff: 0x2202, summation: 0x2211, product: 0x220f, pi: 0x3c0, integral: 0x222b, Omega: 0x3a9, radical: 0x221a,
  approxequal: 0x2248, Delta: 0x2206, lozenge: 0x25ca, mu1: 0xb5, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04,
};

let nameMap: Map<string, number> | null = null;
function names(): Map<string, number> {
  if (nameMap) return nameMap;
  nameMap = new Map();
  ASCII_NAMES.forEach((n, i) => nameMap!.set(n, 0x20 + i));
  LATIN1_NAMES.forEach((n, i) => n !== "-" && nameMap!.set(n, 0xa1 + i));
  for (const [k, v] of Object.entries(EXTRA_NAMES)) nameMap.set(k, v);
  return nameMap;
}

/** Unicode for a glyph name, or "" when unknown (e.g. "g123", "cid45"). */
export function glyphToUnicode(name: string): string {
  const base = name.split(".")[0].split("_")[0];
  const known = names().get(base);
  if (known != null) return String.fromCodePoint(known);
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(base);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) {
    const cp = parseInt(m[1], 16);
    if (cp <= 0x10ffff) return String.fromCodePoint(cp);
  }
  return "";
}

export function unicodeToGlyph(ch: string): string {
  const cp = ch.codePointAt(0)!;
  for (const [k, v] of names()) if (v === cp) return k;
  return cp <= 0xffff ? `uni${cp.toString(16).toUpperCase().padStart(4, "0")}` : `u${cp.toString(16).toUpperCase()}`;
}

const WIN_80 = [0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178];

const MAC_80 =
  "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";

const STD_HIGH: Record<number, number> = {
  0xa1: 0xa1, 0xa2: 0xa2, 0xa3: 0xa3, 0xa4: 0x2044, 0xa5: 0xa5, 0xa6: 0x192, 0xa7: 0xa7, 0xa8: 0xa4, 0xa9: 0x27, 0xaa: 0x201c,
  0xab: 0xab, 0xac: 0x2039, 0xad: 0x203a, 0xae: 0xfb01, 0xaf: 0xfb02, 0xb1: 0x2013, 0xb2: 0x2020, 0xb3: 0x2021, 0xb4: 0xb7,
  0xb6: 0xb6, 0xb7: 0x2022, 0xb8: 0x201a, 0xb9: 0x201e, 0xba: 0x201d, 0xbb: 0xbb, 0xbc: 0x2026, 0xbd: 0x2030, 0xbf: 0xbf,
  0xc1: 0x60, 0xc2: 0xb4, 0xc3: 0x2c6, 0xc4: 0x2dc, 0xc5: 0xaf, 0xc6: 0x2d8, 0xc7: 0x2d9, 0xc8: 0xa8, 0xca: 0x2da, 0xcb: 0xb8,
  0xcd: 0x2dd, 0xce: 0x2db, 0xcf: 0x2c7, 0xd0: 0x2014, 0xe1: 0xc6, 0xe3: 0xaa, 0xe8: 0x141, 0xe9: 0xd8, 0xea: 0x152, 0xeb: 0xba,
  0xf1: 0xe6, 0xf5: 0x131, 0xf8: 0x142, 0xf9: 0xf8, 0xfa: 0x153, 0xfb: 0xdf,
};

export type BaseEncoding = "WinAnsiEncoding" | "MacRomanEncoding" | "StandardEncoding" | "None";

/** code → Unicode table (256 entries, "" for undefined codes) */
export function baseEncodingTable(enc: BaseEncoding): string[] {
  const t: string[] = new Array(256).fill("");
  if (enc === "None") return t;
  for (let c = 0x20; c < 0x7f; c++) t[c] = String.fromCharCode(c);
  if (enc === "WinAnsiEncoding") {
    WIN_80.forEach((u, i) => (t[0x80 + i] = u ? String.fromCharCode(u) : ""));
    for (let c = 0xa0; c <= 0xff; c++) t[c] = String.fromCharCode(c);
    t[0xad] = "-"; // soft hyphen shows as a hyphen
  } else if (enc === "MacRomanEncoding") {
    Array.from(MAC_80).forEach((ch, i) => (t[0x80 + i] = ch));
  } else {
    t[0x27] = "’";
    t[0x60] = "‘";
    for (const [k, v] of Object.entries(STD_HIGH)) t[+k] = String.fromCharCode(v);
  }
  return t;
}
