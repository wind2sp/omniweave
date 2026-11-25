// PDF Surgeon — the editing view's copy of a PDF's embedded TrueType font. Elevated text ("PDF 텍스트 편집") is drawn
// by Omniweave's text engine, which addresses fonts by Unicode; an embedded CID TrueType subset usually has no usable
// Unicode cmap (glyphs are reached through CIDs) and often lacks the tables browsers require (name, OS/2, post).
// fontFaceSfnt() rebuilds the font: the original glyph tables byte for byte, a new Unicode cmap (format 4 + 12) from
// the PDF's own code → Unicode → glyph mapping, and minimal name / OS/2 / post tables when missing. The PDF itself is
// never changed: this copy only feeds a FontFace (family "omw-pdf-<hash>") for drawing on screen.
// Specification: Apple TrueType Reference / OpenType 1.9 table formats (cmap 4 & 12, name, OS/2, post).

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;

class W {
  a: number[] = [];
  u8(v: number) {
    this.a.push(v & 255);
  }
  u16(v: number) {
    this.a.push((v >> 8) & 255, v & 255);
  }
  u32(v: number) {
    this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
  bytes() {
    return Uint8Array.from(this.a);
  }
}

function tablesOf(b: Uint8Array): Map<string, Uint8Array> | null {
  if (b.length < 12) return null;
  const n = u16(b, 4);
  if (12 + n * 16 > b.length) return null;
  const t = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]);
    const off = u32(b, r + 8), len = u32(b, r + 12);
    if (off + len > b.length) return null;
    t.set(tag, b.subarray(off, off + len));
  }
  return t;
}

/** cmap with a (3,1) format 4 subtable (BMP) and a (3,10) format 12 subtable (all). */
function buildCmap(map: Map<number, number>): Uint8Array {
  const cps = [...map.keys()].sort((a, b) => a - b);
  // format 12: groups of consecutive code points with consecutive glyph ids
  const groups: [number, number, number][] = [];
  for (const cp of cps) {
    const g = map.get(cp)!;
    const last = groups[groups.length - 1];
    if (last && cp === last[1] + 1 && g === last[2] + (cp - last[0])) last[1] = cp;
    else groups.push([cp, cp, g]);
  }
  // format 4: BMP only, one segment per group (idDelta), plus the closing 0xFFFF segment
  const seg = groups.filter((x) => x[0] <= 0xfffe).map(([a, b, g]) => [a, Math.min(b, 0xfffe), (g - a) & 0xffff] as const);
  seg.push([0xffff, 0xffff, 1]);
  const segX2 = seg.length * 2;
  let sr = 1;
  while (sr * 2 <= seg.length) sr *= 2;
  const f4 = new W();
  f4.u16(4);
  f4.u16(16 + seg.length * 8);
  f4.u16(0);
  f4.u16(segX2);
  f4.u16(sr * 2);
  f4.u16(Math.log2(sr));
  f4.u16(segX2 - sr * 2);
  for (const s of seg) f4.u16(s[1]);
  f4.u16(0);
  for (const s of seg) f4.u16(s[0]);
  for (const s of seg) f4.u16(s[2]);
  for (let i = 0; i < seg.length; i++) f4.u16(0);
  const f12 = new W();
  f12.u16(12);
  f12.u16(0);
  f12.u32(16 + groups.length * 12);
  f12.u32(0);
  f12.u32(groups.length);
  for (const [a, b, g] of groups) {
    f12.u32(a);
    f12.u32(b);
    f12.u32(g);
  }
  // format 4's length is 16 bits: a font with more than about 8 000 separate runs gets the format 12 table only
  const a4 = 16 + seg.length * 8 <= 0xffff ? f4.bytes() : new Uint8Array(0), a12 = f12.bytes();
  const w = new W();
  w.u16(0);
  w.u16(a4.length ? 2 : 1);
  if (a4.length) {
    w.u16(3);
    w.u16(1);
    w.u32(4 + 16);
  }
  w.u16(3);
  w.u16(10);
  w.u32(4 + (a4.length ? 16 : 8) + a4.length);
  const head = w.bytes();
  const out = new Uint8Array(head.length + a4.length + a12.length);
  out.set(head);
  out.set(a4, head.length);
  out.set(a12, head.length + a4.length);
  return out;
}

function buildName(family: string): Uint8Array {
  const recs: [number, string][] = [
    [1, family],
    [2, "Regular"],
    [4, family],
    [6, family.replace(/[^A-Za-z0-9-]/g, "")],
  ];
  const strs = recs.map(([, s]) => {
    const b: number[] = [];
    for (const ch of s) b.push(ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 255);
    return b;
  });
  const w = new W();
  w.u16(0);
  w.u16(recs.length);
  w.u16(6 + recs.length * 12);
  let off = 0;
  recs.forEach(([id], k) => {
    w.u16(3);
    w.u16(1);
    w.u16(0x409);
    w.u16(id);
    w.u16(strs[k].length);
    w.u16(off);
    off += strs[k].length;
  });
  for (const s of strs) for (const x of s) w.u8(x);
  return w.bytes();
}

function buildPost(): Uint8Array {
  const w = new W();
  w.u32(0x00030000);
  for (let i = 0; i < 7; i++) w.u32(0);
  return w.bytes();
}

function buildOs2(hhea: Uint8Array | undefined, head: Uint8Array | undefined): Uint8Array {
  const asc = hhea ? i16(hhea, 4) : 800, desc = hhea ? i16(hhea, 6) : -200, gap = hhea ? i16(hhea, 8) : 0;
  const upm = head ? u16(head, 18) : 1000;
  const w = new W();
  w.u16(1); // version
  w.u16(Math.round(upm / 2)); // xAvgCharWidth
  w.u16(400);
  w.u16(5);
  w.u16(0); // fsType: installable
  for (const v of [upm / 2, upm / 2, 0, upm / 5, upm / 2, upm / 2, 0, upm / 2]) w.u16(Math.round(v)); // sub / superscript
  w.u16(Math.round(upm / 20));
  w.u16(Math.round(upm / 4));
  w.u16(0); // sFamilyClass
  for (let i = 0; i < 10; i++) w.u8(0); // panose
  for (let i = 0; i < 4; i++) w.u32(0); // unicode ranges
  for (const c of "omw ") w.u8(c.charCodeAt(0));
  w.u16(0x40); // fsSelection: regular
  w.u16(0x20);
  w.u16(0xffff);
  w.u16(asc);
  w.u16(desc);
  w.u16(gap);
  w.u16(Math.max(0, asc));
  w.u16(Math.max(0, -desc));
  w.u32(1); // code page ranges: Latin 1
  w.u32(0);
  return w.bytes();
}

/**
 * A browser-loadable copy of an embedded TrueType program with a Unicode cmap from `uniToGid`; null when the program
 * is not TrueType (CFF, broken) or nothing maps.
 */
export function fontFaceSfnt(data: Uint8Array, uniToGid: Map<number, number>, family: string): Uint8Array | null {
  if (!uniToGid.size) return null;
  const ver = u32(data, 0);
  if (ver !== 0x00010000 && ver !== 0x74727565) return null;
  const t = tablesOf(data);
  if (!t || !t.has("glyf") || !t.has("loca") || !t.has("head") || !t.has("hhea") || !t.has("hmtx") || !t.has("maxp")) return null;
  const out = new Map(t);
  out.set("cmap", buildCmap(uniToGid));
  if (!out.has("name")) out.set("name", buildName(family));
  if (!out.has("post")) out.set("post", buildPost());
  if (!out.has("OS/2")) out.set("OS/2", buildOs2(t.get("hhea"), t.get("head")));
  // hinting programs of subsets often reference functions that were cut away: drop them (outlines are unchanged)
  for (const k of ["fpgm", "prep", "cvt ", "hdmx", "LTSH", "VDMX", "kern", "gasp"]) out.delete(k);
  const tags = [...out.keys()].sort();
  let sr = 1;
  while (sr * 2 <= tags.length) sr *= 2;
  let size = 12 + tags.length * 16;
  const offs: number[] = [];
  for (const k of tags) {
    offs.push(size);
    size += (out.get(k)!.length + 3) & ~3;
  }
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, tags.length);
  dv.setUint16(6, sr * 16);
  dv.setUint16(8, Math.log2(sr));
  dv.setUint16(10, tags.length * 16 - sr * 16);
  tags.forEach((k, i) => {
    const r = 12 + i * 16, d = out.get(k)!;
    for (let j = 0; j < 4; j++) b[r + j] = k.charCodeAt(j);
    let sum = 0;
    for (let j = 0; j < d.length; j += 4) sum = (sum + (((d[j] << 24) | ((d[j + 1] ?? 0) << 16) | ((d[j + 2] ?? 0) << 8) | (d[j + 3] ?? 0)) >>> 0)) >>> 0;
    dv.setUint32(r + 4, sum);
    dv.setUint32(r + 8, offs[i]);
    dv.setUint32(r + 12, d.length);
    b.set(d, offs[i]);
  });
  return b;
}

/**
 * FNV-1a over the whole program AND its Unicode → glyph mapping: the same font bytes used with another ToUnicode /
 * CIDToGIDMap (another font dictionary or PDF) get a family of their own, never the first one's cmap.
 */
function programKey(data: Uint8Array, map: Map<number, number>): string {
  let h = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
  for (const [cp, g] of map) h2 = Math.imul(h2 ^ (cp * 31 + g), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0") + data.length.toString(16);
}

const families = new WeakMap<object, string | null>();
const registered = new Set<string>();
/** the sfnt each registered family was made from (Create Outlines reads the glyphs' own outlines from it) */
const familyBytes = new Map<string, Uint8Array>();

/** The font program bytes (sfnt) behind an embedded font's FontFace family, or null for any other family. */
export const embeddedFontBytes = (family: string): Uint8Array | null => familyBytes.get(family) ?? null;

/**
 * The FontFace family of an embedded font program (registered on first use: document.fonts.add + load, which fires
 * "loadingdone" so the app re-measures and repaints). Null without FontFace (Node) or when it cannot be rebuilt.
 */
export function embeddedFontFamily(program: { data: Uint8Array; uniToGid: () => Map<number, number> }): string | null {
  if (families.has(program)) return families.get(program)!;
  const g = globalThis as { FontFace?: typeof FontFace; document?: Document };
  let fam: string | null = null;
  if (g.FontFace && g.document?.fonts) {
    const map = program.uniToGid();
    fam = "omw-pdf-" + programKey(program.data, map);
    if (!registered.has(fam)) {
      const sfnt = fontFaceSfnt(program.data, map, fam);
      if (!sfnt) fam = null;
      else {
        registered.add(fam);
        familyBytes.set(fam, sfnt);
        try {
          const face = new g.FontFace(fam, sfnt);
          g.document.fonts.add(face);
          face.load().catch(() => {
            g.document?.fonts.delete(face);
          });
        } catch {
          fam = null;
        }
      }
    }
  }
  families.set(program, fam);
  return fam;
}
