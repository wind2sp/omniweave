// Builds assets/fonts/pdfa/OmniPDFASerif-*.ttf: Liberation Serif cut down to the characters a simple PDF font can show (the 256 codes of
// WinAnsi, MacRoman and Standard encoding), for "PDF/A로 저장" to embed in place of a left-out Times
// (src/io/pdfsurgeon/acrobat.ts). Run once by hand when the source fonts change:
//
//   node scripts/pdfa-fonts.mjs <folder with LiberationSerif-*.ttf and LICENSE>
//
// Source: https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5 (liberation-fonts-ttf-2.1.5.tar.gz,
// SHA-256 7191C669BF38899F73A2094ED00F7B800553364F90E2637010A69C0E268F25D0), SIL Open Font License 1.1.
// fontkit's subset keeps the outlines and metrics but no cmap / name / OS/2 / post: those are added back here (a cmap
// (3,1) format 4 for the kept characters, the original name and OS/2 tables, post format 3), so the result is a
// complete TrueType a PDF viewer or validator can read through its Unicode cmap. The glyph widths stay the same.
// A modified OFL font may not keep the Reserved Font Name "Liberation": the result is named "Omni PDFA Serif".
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";

const src = process.argv[2];
if (!src) throw new Error("usage: node scripts/pdfa-fonts.mjs <folder>");
const out = "assets/fonts/pdfa";
mkdirSync(out, { recursive: true });

// the characters of the three base encodings (same tables as src/io/pdfsurgeon/encodings.ts, written out here)
const WIN_80 = [0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178];
const MAC_80 = "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";
const STD = [0x2019, 0x2018, 0x2044, 0x192, 0x201c, 0x2039, 0x203a, 0xfb01, 0xfb02, 0x2013, 0x2020, 0x2021, 0xb7, 0x2022, 0x201a, 0x201e, 0x201d, 0x2026, 0x2030, 0x60, 0xb4, 0x2c6, 0x2dc, 0xaf, 0x2d8, 0x2d9, 0xa8, 0x2da, 0xb8, 0x2dd, 0x2db, 0x2c7, 0x2014, 0xc6, 0xaa, 0x141, 0xd8, 0x152, 0xba, 0xe6, 0x131, 0x142, 0xf8, 0x153, 0xdf];
const chars = new Set();
for (let c = 0x20; c < 0x7f; c++) chars.add(c);
for (let c = 0xa0; c <= 0xff; c++) chars.add(c);
for (const c of WIN_80) if (c) chars.add(c);
for (const ch of MAC_80) chars.add(ch.codePointAt(0));
for (const c of STD) chars.add(c);

// fontkit 1.1.1 writes unpadded glyph records with a short loca (src/io/fontkitPatch.ts): pad each to 4 bytes
function padSubset(subset) {
  const proto = Object.getPrototypeOf(subset);
  if (proto.__omwPadded) return;
  const orig = proto._addGlyph;
  proto._addGlyph = function (gid) {
    const r = orig.call(this, gid);
    const i = this.glyf.length - 1;
    const buf = this.glyf[i];
    const extra = buf ? (4 - (buf.length % 4)) % 4 : 0;
    if (extra) {
      const padded = typeof buf.constructor.alloc === "function" ? buf.constructor.alloc(buf.length + extra) : new Uint8Array(buf.length + extra);
      padded.set(buf);
      this.glyf[i] = padded;
      this.offset += extra;
    }
    return r;
  };
  proto.__omwPadded = true;
}

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
function tables(b) {
  const n = u16(b, 4);
  const t = new Map();
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]);
    t.set(tag, b.slice(u32(b, r + 8), u32(b, r + 8) + u32(b, r + 12)));
  }
  return t;
}
function checksum(b) {
  let s = 0;
  for (let i = 0; i < b.length; i += 4) s = (s + (((b[i] ?? 0) << 24) >>> 0) + ((b[i + 1] ?? 0) << 16) + ((b[i + 2] ?? 0) << 8) + (b[i + 3] ?? 0)) >>> 0;
  return s;
}
/** cmap with one (3,1) format 4 subtable: one segment per character (a few hundred — small enough) */
function cmap4(map) {
  const codes = [...map.keys()].filter((c) => c <= 0xffff).sort((a, b) => a - b);
  const segs = [...codes.map((c) => [c, c, (map.get(c) - c) & 0xffff]), [0xffff, 0xffff, 1]];
  const n = segs.length;
  const len = 16 + n * 8;
  const st = new Uint8Array(len);
  const dv = new DataView(st.buffer);
  let sr = 1, es = 0;
  while (sr * 2 <= n) (sr *= 2), es++;
  dv.setUint16(0, 4), dv.setUint16(2, len), dv.setUint16(4, 0), dv.setUint16(6, n * 2), dv.setUint16(8, sr * 2), dv.setUint16(10, es), dv.setUint16(12, n * 2 - sr * 2);
  segs.forEach(([, e], i) => dv.setUint16(14 + i * 2, e));
  segs.forEach(([s], i) => dv.setUint16(16 + n * 2 + i * 2, s));
  segs.forEach(([, , d], i) => dv.setUint16(16 + n * 4 + i * 2, d));
  // idRangeOffset all 0
  const head = new Uint8Array(12);
  const hv = new DataView(head.buffer);
  hv.setUint16(0, 0), hv.setUint16(2, 1), hv.setUint16(4, 3), hv.setUint16(6, 1), hv.setUint32(8, 12);
  const outB = new Uint8Array(12 + len);
  outB.set(head), outB.set(st, 12);
  return outB;
}
function build(tbls) {
  const tags = [...tbls.keys()].sort();
  const n = tags.length;
  let sr = 1, es = 0;
  while (sr * 2 <= n) (sr *= 2), es++;
  let off = 12 + n * 16;
  const recs = [];
  for (const t of tags) {
    const d = tbls.get(t);
    recs.push({ t, d, off });
    off += (d.length + 3) & ~3;
  }
  const outB = new Uint8Array(off);
  const dv = new DataView(outB.buffer);
  dv.setUint32(0, 0x00010000), dv.setUint16(4, n), dv.setUint16(6, sr * 16), dv.setUint16(8, es), dv.setUint16(10, n * 16 - sr * 16);
  recs.forEach((r, i) => {
    const p = 12 + i * 16;
    for (let k = 0; k < 4; k++) outB[p + k] = r.t.charCodeAt(k);
    if (r.t === "head") new DataView(r.d.buffer, r.d.byteOffset).setUint32(8, 0);
    dv.setUint32(p + 4, checksum(r.d)), dv.setUint32(p + 8, r.off), dv.setUint32(p + 12, r.d.length);
    outB.set(r.d, r.off);
  });
  const head = recs.find((r) => r.t === "head");
  dv.setUint32(head.off + 8, (0xb1b0afba - checksum(outB)) >>> 0);
  return outB;
}

/**
 * The name table of the cut-down font: a Modified Version of an OFL font may not use the Reserved Font Name
 * ("Liberation", OFL §3), so it is named "Omni PDFA Serif"; the copyright, licence and licence-URL records (IDs 0,
 * 13, 14) are copied from the original, and the description (ID 10) says what it was made from.
 */
function nameTable(orig, style) {
  const n = u16(orig, 2), strOff = u16(orig, 4);
  const keep = new Map();
  for (let i = 0; i < n; i++) {
    const r = 6 + i * 12;
    const [plat, enc, lang, id, len, off] = [u16(orig, r), u16(orig, r + 2), u16(orig, r + 4), u16(orig, r + 6), u16(orig, r + 8), u16(orig, r + 10)];
    if (plat !== 3 || enc !== 1 || lang !== 0x409 || ![0, 13, 14].includes(id)) continue;
    let s = "";
    for (let k = 0; k < len; k += 2) s += String.fromCharCode(u16(orig, strOff + off + k));
    keep.set(id, s);
  }
  const sub = { Regular: "Regular", Bold: "Bold", Italic: "Italic", BoldItalic: "Bold Italic" }[style];
  const recs = [
    [0, keep.get(0) ?? ""],
    [1, "Omni PDFA Serif"],
    [2, sub],
    [3, `Omni PDFA Serif ${sub} 2.1.5`],
    [4, `Omni PDFA Serif ${sub}`],
    [5, "Version 2.1.5"],
    [6, `OmniPDFASerif-${style}`],
    [10, "Characters of the PDF base encodings cut from Liberation Serif 2.1.5 (SIL Open Font License 1.1) for Omniweave PDF/A saving"],
    [13, keep.get(13) ?? ""],
    [14, keep.get(14) ?? "http://scripts.sil.org/OFL"],
  ].filter(([, s]) => s);
  const strs = recs.map(([, s]) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) (b[i * 2] = s.charCodeAt(i) >> 8), (b[i * 2 + 1] = s.charCodeAt(i) & 255);
    return b;
  });
  const head = 6 + recs.length * 12;
  const total = head + strs.reduce((a, b) => a + b.length, 0);
  const t = new Uint8Array(total);
  const dv = new DataView(t.buffer);
  dv.setUint16(0, 0), dv.setUint16(2, recs.length), dv.setUint16(4, head);
  let off = 0;
  recs.forEach(([id], i) => {
    const r = 6 + i * 12;
    dv.setUint16(r, 3), dv.setUint16(r + 2, 1), dv.setUint16(r + 4, 0x409), dv.setUint16(r + 6, id), dv.setUint16(r + 8, strs[i].length), dv.setUint16(r + 10, off);
    t.set(strs[i], head + off);
    off += strs[i].length;
  });
  return t;
}

for (const style of ["Regular", "Bold", "Italic", "BoldItalic"]) {
  const name = `LiberationSerif-${style}.ttf`;
  const orig = new Uint8Array(readFileSync(`${src}/${name}`));
  const font = fontkit.create(Buffer.from(orig));
  const subset = font.createSubset();
  padSubset(subset);
  const map = new Map();
  for (const c of [...chars].sort((a, b) => a - b)) {
    const g = font.glyphForCodePoint(c);
    if (g && g.id) map.set(c, subset.includeGlyph(g));
  }
  const parts = [];
  await new Promise((res, rej) => subset.encodeStream().on("data", (d) => parts.push(d)).on("end", res).on("error", rej));
  const sub = new Uint8Array(Buffer.concat(parts));
  const t = tables(sub);
  const o = tables(orig);
  t.set("cmap", cmap4(map));
  if (o.has("OS/2")) t.set("OS/2", o.get("OS/2"));
  t.set("name", nameTable(o.get("name"), style));
  const post = o.get("post").slice(0, 32);
  new DataView(post.buffer).setUint32(0, 0x00030000);
  t.set("post", post);
  const bytes = build(t);
  // check: the result reads back with the same characters and widths
  const back = fontkit.create(Buffer.from(bytes));
  for (const c of [0x41, 0x67, 0xe9, 0x2019]) {
    const a = font.glyphForCodePoint(c), b2 = back.glyphForCodePoint(c);
    if (!b2.id || a.advanceWidth !== b2.advanceWidth) throw new Error(`${name}: U+${c.toString(16)} lost`);
  }
  writeFileSync(`${out}/OmniPDFASerif-${style}.ttf`, bytes);
  console.log(name, orig.length, "→", bytes.length, `(${map.size} characters)`);
}
copyFileSync(`${src}/LICENSE`, `${out}/LICENSE_LIBERATION_SERIF`);
