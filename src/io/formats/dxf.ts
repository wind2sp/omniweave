// DXF reader (ASCII and binary DXF, R12 … 2018) → CadDrawing (io/formats/cad/model.ts). Written from the public DXF
// Reference (group codes, sections, entity layouts); no code from other DXF libraries. Import only: Omniweave keeps
// the original file as an asset and edits the drawing as its own pages (docs/design/CAD_IMPORT.md).

import { cadGroups, emptyDrawing, type CadColor, type CadDrawing, type CadGroupDef, type CadEntity, type CadGeom, type HatchEdge, type HatchLine, type HatchLoop, type P2, type P3, type PolyVertex } from "./cad/model";
import { fitSplineCtrl, polyfaceEdges } from "./cad/geom";
import { acisWires, parseSab, parseSat, satDecrypt } from "./cad/acis";

export type Tag = [number, string | number];

// ───────── value types by group code ─────────

type VKind = "s" | "d" | "i16" | "i32" | "i64" | "b" | "bin";

export function codeKind(c: number): VKind {
  if (c < 10) return "s";
  if (c < 60) return "d";
  if (c < 80) return "i16";
  if (c >= 90 && c < 100) return "i32";
  if (c < 110) return "s";
  if (c < 150) return "d";
  if (c >= 160 && c < 170) return "i64";
  if (c >= 170 && c < 180) return "i16";
  if (c >= 210 && c < 240) return "d";
  if (c >= 270 && c < 290) return "i16";
  if (c >= 290 && c < 300) return "b";
  if (c >= 310 && c < 320) return "bin";
  if (c >= 300 && c < 370) return "s";
  if (c >= 370 && c < 390) return "i16";
  if (c >= 390 && c < 400) return "s";
  if (c >= 400 && c < 410) return "i16";
  if (c >= 410 && c < 420) return "s";
  if (c >= 420 && c < 430) return "i32";
  if (c >= 430 && c < 440) return "s";
  if (c >= 440 && c < 460) return "i32";
  if (c >= 460 && c < 470) return "d";
  if (c >= 470 && c < 999) return "s";
  if (c === 999) return "s";
  if (c === 1004) return "bin";
  if (c >= 1000 && c < 1010) return "s";
  if (c >= 1010 && c < 1060) return "d";
  if (c >= 1060 && c < 1071) return "i16";
  if (c === 1071) return "i32";
  return "s";
}

// ───────── text encoding ─────────

const CODEPAGES: Record<string, string> = {
  ANSI_949: "euc-kr",
  ANSI_1361: "johab",
  ANSI_932: "shift_jis",
  ANSI_936: "gbk",
  ANSI_950: "big5",
  ANSI_874: "windows-874",
  ANSI_1250: "windows-1250",
  ANSI_1251: "windows-1251",
  ANSI_1252: "windows-1252",
  ANSI_1253: "windows-1253",
  ANSI_1254: "windows-1254",
  ANSI_1255: "windows-1255",
  ANSI_1256: "windows-1256",
  ANSI_1257: "windows-1257",
  ANSI_1258: "windows-1258",
};

const latin1 = (b: Uint8Array, from = 0, to = b.length) => {
  let s = "";
  for (let i = from; i < to; i += 8192) s += String.fromCharCode(...b.subarray(i, Math.min(to, i + 8192)));
  return s;
};

/**
 * Korean Johab (code page 1361), which TextDecoder does not have: ASCII and the 11,172 Hangul syllables (lead byte
 * 0x84–0xD3, 5 bits each for initial / medial / final); Johab's symbols and hanja (lead byte 0xD8–0xF9) come out as '?'.
 */
const JOHAB_I = (v: number) => (v >= 2 && v <= 20 ? v - 2 : -1);
const JOHAB_M = (v: number) => (v >= 3 && v <= 7 ? v - 3 : v >= 10 && v <= 15 ? v - 5 : v >= 18 && v <= 23 ? v - 7 : v >= 26 && v <= 29 ? v - 9 : -1);
const JOHAB_F = (v: number) => (v >= 1 && v <= 17 ? v - 1 : v >= 19 && v <= 29 ? v - 2 : -1);
export function decodeJohab(b: Uint8Array): string {
  let s = "";
  for (let k = 0; k < b.length; k++) {
    const c = b[k];
    if (c < 0x80) {
      s += String.fromCharCode(c);
      continue;
    }
    if (k + 1 >= b.length) {
      s += "?";
      break;
    }
    const code = (c << 8) | b[++k];
    const i = JOHAB_I((code >> 10) & 31), m = JOHAB_M((code >> 5) & 31), f = JOHAB_F(code & 31);
    s += c >= 0x84 && c <= 0xd3 && i >= 0 && m >= 0 && f >= 0 ? String.fromCharCode(0xac00 + (i * 21 + m) * 28 + f) : "?";
  }
  return s;
}
/** a TextDecoder label, or "johab" for decodeJohab */
export function textDecoder(label: string): TextDecoder {
  if (label === "johab") return { decode: (b?: Uint8Array) => decodeJohab(b ?? new Uint8Array(0)) } as unknown as TextDecoder;
  return new TextDecoder(label);
}

/** The decoder for a file's strings: UTF-8 from 2007 (AC1021) on, else $DWGCODEPAGE, else UTF-8 / Korean by trial. */
function pickDecoder(version: string, codepage: string | undefined, sample: Uint8Array): TextDecoder {
  if (version >= "AC1021") return new TextDecoder("utf-8");
  const cp = codepage && CODEPAGES[codepage.toUpperCase()];
  if (cp)
    try {
      return textDecoder(cp);
    } catch {
      /* not in this runtime */
    }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return new TextDecoder("utf-8");
  } catch {
    try {
      return new TextDecoder("euc-kr");
    } catch {
      return new TextDecoder("windows-1252");
    }
  }
}

/** `\M+n` code pages: 1 Japanese 932, 2 Traditional Chinese 950, 3 Korean 949, 4 Johab 1361, 5 Simplified Chinese 936 */
const MIF: Record<string, string> = { "1": "shift_jis", "2": "big5", "3": "euc-kr", "4": "johab", "5": "gbk" };

/**
 * `\U+XXXX` and `\M+nXXXX` (a double-byte character in code page n) escapes in DXF and ≤ 2004 DWG strings.
 * omni-cad-16 DWG 2000: gbcbig text as \M+5BCBE (季), extfont text as \M+18E6C (四).
 */
export function unescapeDxf(s: string): string {
  if (!s.includes("\\U+") && !s.includes("\\M+")) return s;
  return s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (_, n, h) => {
      const v = parseInt(h, 16);
      try {
        return textDecoder(MIF[n] ?? "euc-kr").decode(new Uint8Array([v >> 8, v & 0xff]));
      } catch {
        return "?";
      }
    });
}

// ───────── tokenizers ─────────

const BINARY_SENTINEL = "AutoCAD Binary DXF\r\n\x1a\0";

export const isBinaryDxf = (b: Uint8Array) => b.length > 22 && latin1(b, 0, 22) === BINARY_SENTINEL;

function headerHints(text: string): { version: string; codepage?: string } {
  const v = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(text);
  const c = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]+)/.exec(text);
  return { version: v?.[1] ?? "", codepage: c?.[1]?.trim() };
}

function asciiTags(b: Uint8Array): Tag[] {
  let start = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) start = 3;
  const head = latin1(b, start, Math.min(b.length, start + 65536));
  const hints = headerHints(head);
  const text = pickDecoder(hints.version, hints.codepage, b.subarray(start, Math.min(b.length, start + 262144))).decode(b.subarray(start));
  const lines = text.split(/\r?\n/);
  const tags: Tag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (!Number.isFinite(code)) {
      // a stray blank line: resynchronise on the next line that is a number
      i -= 1;
      continue;
    }
    const raw = lines[i + 1].replace(/\r$/, "");
    const k = codeKind(code);
    if (k === "s" || k === "bin") tags.push([code, raw]);
    else if (k === "d") tags.push([code, parseFloat(raw)]);
    else tags.push([code, parseInt(raw.trim(), 10) || 0]);
  }
  return tags;
}

function binaryTags(b: Uint8Array): Tag[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 22;
  // R13 and later write 2-byte group codes; R12 wrote one byte (255 → a 2-byte code follows)
  const wide = b[o] === 0 && b[o + 1] === 0;
  const tags: Tag[] = [];
  const strs: { at: number; from: number; to: number }[] = [];
  while (o < b.length) {
    let code: number;
    if (wide) {
      code = dv.getUint16(o, true);
      o += 2;
    } else {
      code = b[o++];
      if (code === 255) {
        code = dv.getUint16(o, true);
        o += 2;
      }
    }
    const k = codeKind(code);
    let v: string | number;
    if (k === "s") {
      let e = o;
      while (e < b.length && b[e] !== 0) e++;
      strs.push({ at: tags.length, from: o, to: e });
      v = "";
      o = e + 1;
    } else if (k === "d") {
      v = dv.getFloat64(o, true);
      o += 8;
    } else if (k === "i16") {
      v = dv.getInt16(o, true);
      o += 2;
    } else if (k === "i32") {
      v = dv.getInt32(o, true);
      o += 4;
    } else if (k === "i64") {
      v = Number(dv.getBigInt64(o, true));
      o += 8;
    } else if (k === "b") {
      v = b[o++];
    } else {
      const n = b[o++];
      v = Array.from(b.subarray(o, o + n), (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
      o += n;
    }
    tags.push([code, v]);
    if (code === 0 && o >= b.length) break;
  }
  // strings decoded once the header tells the code page
  const after = (name: string) => {
    const i = strs.findIndex((s) => latin1(b, s.from, s.to) === name);
    return i >= 0 && strs[i + 1] ? latin1(b, strs[i + 1].from, strs[i + 1].to) : undefined;
  };
  const version = after("$ACADVER") ?? "";
  const codepage = after("$DWGCODEPAGE");
  const dec = pickDecoder(version, codepage, b.subarray(0, Math.min(b.length, 262144)));
  for (const s of strs) tags[s.at][1] = dec.decode(b.subarray(s.from, s.to));
  return tags;
}

export function dxfTags(b: Uint8Array): Tag[] {
  return isBinaryDxf(b) ? binaryTags(b) : asciiTags(b);
}

// ───────── tag helpers ─────────

const num = (v: string | number | undefined, d = 0) => (typeof v === "number" ? (Number.isFinite(v) ? v : d) : v === undefined ? d : Number(v) || d);
const str = (v: string | number | undefined) => (v === undefined ? "" : String(v));

class Rec {
  constructor(public tags: Tag[]) {}
  get(code: number): string | number | undefined {
    for (const t of this.tags) if (t[0] === code) return t[1];
    return undefined;
  }
  n(code: number, d = 0) {
    return num(this.get(code), d);
  }
  s(code: number, d = "") {
    const v = this.get(code);
    return v === undefined ? d : unescapeDxf(str(v));
  }
  has(code: number) {
    return this.tags.some((t) => t[0] === code);
  }
  all(code: number) {
    return this.tags.filter((t) => t[0] === code).map((t) => t[1]);
  }
  p3(cx: number, d: P3 = [0, 0, 0]): P3 {
    return [this.n(cx, d[0]), this.n(cx + 10, d[1]), this.n(cx + 20, d[2])];
  }
}

/** Sequential reader over an entity's tags (HATCH, SPLINE, LWPOLYLINE repeat codes in order). */
class Cursor {
  i = 0;
  constructor(public tags: Tag[]) {}
  peek() {
    return this.tags[this.i]?.[0];
  }
  /** value of the next tag if it has `code` (advancing), else undefined */
  take(code: number): string | number | undefined {
    if (this.tags[this.i]?.[0] === code) return this.tags[this.i++][1];
    return undefined;
  }
  /** skip forward to the next tag with `code`; its value, or undefined at the end */
  seek(code: number): string | number | undefined {
    while (this.i < this.tags.length && this.tags[this.i][0] !== code) this.i++;
    return this.i < this.tags.length ? this.tags[this.i++][1] : undefined;
  }
  n(code: number, d = 0) {
    return num(this.take(code), d);
  }
}

// ───────── sections ─────────

/** Records (0 … next 0) of a tag range. */
function records(tags: Tag[], from: number, to: number): Rec[] {
  const out: Rec[] = [];
  let i = from;
  while (i < to) {
    if (tags[i][0] !== 0) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < to && tags[j][0] !== 0) j++;
    out.push(new Rec(tags.slice(i, j)));
    i = j;
  }
  return out;
}

function sections(tags: Tag[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (let i = 0; i < tags.length; i++) {
    if (tags[i][0] === 0 && tags[i][1] === "SECTION" && tags[i + 1]?.[0] === 2) {
      const name = str(tags[i + 1][1]);
      let j = i + 2;
      while (j < tags.length && !(tags[j][0] === 0 && tags[j][1] === "ENDSEC")) j++;
      out.set(name, [i + 2, j]);
      i = j;
    }
  }
  return out;
}

function readHeader(tags: Tag[], from: number, to: number, d: CadDrawing) {
  const vars = new Map<string, Tag[]>();
  let cur: Tag[] | null = null;
  for (let i = from; i < to; i++) {
    const [c, v] = tags[i];
    if (c === 9) vars.set(str(v), (cur = []));
    else cur?.push(tags[i]);
  }
  const first = (name: string) => vars.get(name)?.[0]?.[1];
  const pt = (name: string): P2 | undefined => {
    const t = vars.get(name);
    if (!t) return undefined;
    const x = t.find((x) => x[0] === 10)?.[1], y = t.find((x) => x[0] === 20)?.[1];
    return x === undefined || y === undefined ? undefined : [num(x), num(y)];
  };
  d.version = str(first("$ACADVER")) || "AC1009";
  d.codepage = first("$DWGCODEPAGE") === undefined ? undefined : str(first("$DWGCODEPAGE"));
  d.insunits = num(first("$INSUNITS"), 0);
  d.measurement = first("$MEASUREMENT") === undefined ? undefined : num(first("$MEASUREMENT"));
  d.ltscale = num(first("$LTSCALE"), 1) || 1;
  const lwd = num(first("$LWDEFAULT"), 25);
  d.lwdefault = lwd > 0 ? lwd : 25;
  d.arrow = num(first("$DIMASZ"), d.measurement === 0 ? 0.18 : 2.5) * (num(first("$DIMSCALE"), 1) || 1);
  d.pdmode = num(first("$PDMODE"), 0);
  d.pdsize = num(first("$PDSIZE"), 0);
  d.extmin = pt("$EXTMIN");
  d.extmax = pt("$EXTMAX");
}

function readTables(tags: Tag[], from: number, to: number, d: CadDrawing, blockRecords: Map<string, string>, trueNames: Map<string, string>) {
  for (const r of records(tags, from, to)) {
    const type = r.tags[0][1];
    if (type === "LAYER") {
      const name = r.s(2);
      if (!name) continue;
      const color = r.n(62, 7);
      const flags = r.n(70);
      d.layers.set(name.toUpperCase(), {
        name,
        color: Math.abs(color) || 7,
        rgb: r.has(420) ? r.n(420) & 0xffffff : undefined,
        ltype: r.s(6, "CONTINUOUS"),
        lw: r.has(370) ? r.n(370) : -3,
        handle: r.s(5).toUpperCase() || undefined,
        on: color >= 0,
        frozen: !!(flags & 1),
        locked: !!(flags & 4),
        plot: r.n(290, 1) !== 0,
      });
    } else if (type === "LTYPE") {
      const name = r.s(2);
      if (name) d.ltypes.set(name.toUpperCase(), { name, pattern: r.all(49).map((v) => num(v)) });
    } else if (type === "STYLE") {
      const name = r.s(2);
      if (!name || r.n(70) & 1) continue;
      // a TrueType style names its family in ACAD xdata (1001 ACAD, 1000 family)
      const ac = r.tags.findIndex((t) => t[0] === 1001 && t[1] === "ACAD");
      const fam = ac >= 0 ? r.tags.slice(ac + 1).find((t) => t[0] === 1000)?.[1] : undefined;
      d.styles.set(name.toUpperCase(), { name, font: fam ? str(fam) : r.s(3), bigFont: r.s(4) || undefined, height: r.n(40), widthFactor: r.n(41, 1) || 1, oblique: r.n(50) });
    } else if (type === "BLOCK_RECORD") {
      const h = r.s(5);
      if (h) blockRecords.set(h.toUpperCase(), r.s(2));
      // a dynamic block saved for an older release: an anonymous "*U" record, its name in AcDbDynamicBlockTrueName xdata
      const tn = r.tags.findIndex((t) => t[0] === 1001 && t[1] === "AcDbDynamicBlockTrueName");
      const real = tn >= 0 && r.tags[tn + 1]?.[0] === 1000 ? str(r.tags[tn + 1][1]) : "";
      if (real && /^\*U/i.test(r.s(2))) trueNames.set(r.s(2).toUpperCase(), real);
    }
  }
}

// ───────── entities ─────────

const UNSUPPORTED_DRAWN = new Set(["ATTDEF", "SEQEND", "ENDBLK", "VERTEX"]);

function common(r: Rec, type: string): CadEntity {
  const ext = r.has(210) ? r.p3(210, [0, 0, 1]) : undefined;
  return {
    type,
    handle: r.s(5) || undefined,
    layer: r.s(8, "0") || "0",
    color: { aci: r.has(62) ? r.n(62) : 256, rgb: r.has(420) ? r.n(420) & 0xffffff : undefined },
    ltype: r.s(6, "BYLAYER") || "BYLAYER",
    ltscale: r.n(48, 1) || 1,
    lw: r.has(370) ? r.n(370) : -1,
    invisible: r.n(60) === 1 || undefined,
    paper: r.n(67) === 1 || undefined,
    owner: r.s(330) || undefined,
    extrusion: ext && !(Math.abs(ext[0]) < 1e-12 && Math.abs(ext[1]) < 1e-12 && ext[2] > 0) ? ext : undefined,
    geom: null,
  };
}

/** Points of repeated 10/20(/30) groups in order. */
function points(tags: Tag[], xc = 10): P3[] {
  const out: P3[] = [];
  for (let i = 0; i < tags.length; i++) {
    if (tags[i][0] !== xc) continue;
    const p: P3 = [num(tags[i][1]), 0, 0];
    if (tags[i + 1]?.[0] === xc + 10) p[1] = num(tags[++i][1]);
    if (tags[i + 1]?.[0] === xc + 20) p[2] = num(tags[++i][1]);
    out.push(p);
  }
  return out;
}

function lwpolyline(r: Rec): CadGeom {
  const pts: PolyVertex[] = [];
  let v: PolyVertex | null = null;
  for (const [c, val] of r.tags) {
    if (c === 10) pts.push((v = { x: num(val), y: 0 }));
    else if (!v) continue;
    else if (c === 20) v.y = num(val);
    else if (c === 42) v.bulge = num(val);
    else if (c === 40) v.w0 = num(val);
    else if (c === 41) v.w1 = num(val);
  }
  return { k: "poly", pts, closed: !!(r.n(70) & 1), width: r.n(43) || undefined, elevation: r.n(38) || undefined };
}

function spline(r: Rec): CadGeom {
  const flags = r.n(70);
  const w = r.all(41).map((x) => num(x));
  const degree = r.n(71, 3) || 3;
  let knots = r.all(40).map((x) => num(x));
  let ctrl = points(r.tags, 10);
  const fit = points(r.tags, 11);
  if (ctrl.length < 2 && fit.length >= 2 && degree === 3) {
    // fit points only: the curve AutoCAD makes through them (start / end tangents 12, 13)
    const f = fitSplineCtrl(
      fit.map((p) => [p[0], p[1]] as P2),
      r.has(12) ? [r.n(12), r.n(22)] : undefined,
      r.has(13) ? [r.n(13), r.n(23)] : undefined,
    );
    if (f) {
      knots = f.knots;
      ctrl = f.ctrl.map((p) => [p[0], p[1], 0] as P3);
    }
  }
  return { k: "spline", degree, knots, ctrl, weights: w.length && w.some((x) => x !== 1) ? w : undefined, fit, closed: !!(flags & 1) || !!(flags & 2) };
}

function hatchEdges(c: Cursor, n: number): HatchEdge[] {
  const edges: HatchEdge[] = [];
  for (let e = 0; e < n; e++) {
    const type = num(c.seek(72));
    if (type === 1) {
      const a: P2 = [c.n(10), c.n(20)];
      const b: P2 = [c.n(11), c.n(21)];
      edges.push({ k: "line", a, b });
    } else if (type === 2) {
      const center: P2 = [c.n(10), c.n(20)];
      const r = c.n(40), a0 = c.n(50), a1 = c.n(51), ccw = c.n(73, 1) !== 0;
      edges.push({ k: "arc", c: center, r, a0, a1, ccw });
    } else if (type === 3) {
      const center: P2 = [c.n(10), c.n(20)];
      const major: P2 = [c.n(11), c.n(21)];
      const ratio = c.n(40), a0 = c.n(50), a1 = c.n(51), ccw = c.n(73, 1) !== 0;
      edges.push({ k: "ellipse", c: center, major, ratio, a0, a1, ccw });
    } else if (type === 4) {
      const degree = c.n(94, 3);
      const rational = c.n(73) !== 0;
      c.n(74);
      const nk = c.n(95), nc = c.n(96);
      const knots: number[] = [];
      for (let k = 0; k < nk; k++) knots.push(num(c.seek(40)));
      const ctrl: P2[] = [];
      const weights: number[] = [];
      for (let k = 0; k < nc; k++) {
        const x = num(c.seek(10));
        ctrl.push([x, c.n(20)]);
        if (rational && c.peek() === 42) weights.push(c.n(42, 1));
      }
      const fit: P2[] = [];
      // fit data on spline edges from 2010 (AC1024); before that a 97 here is the source object count
      if (c.peek() === 97 && readingVersion >= "AC1024") {
        const nf = c.n(97);
        for (let k = 0; k < nf; k++) {
          const x = num(c.seek(11));
          fit.push([x, c.n(21)]);
        }
        if (c.peek() === 12) (c.n(12), c.n(22));
        if (c.peek() === 13) (c.n(13), c.n(23));
      }
      edges.push({ k: "spline", degree, knots, ctrl, weights: weights.length ? weights : undefined, fit });
    }
  }
  return edges;
}

function hatch(r: Rec): CadGeom {
  const c = new Cursor(r.tags);
  // the boundary starts after the pattern name / solid flag / associativity
  c.seek(91);
  c.i--;
  const nLoops = c.n(91);
  const loops: HatchLoop[] = [];
  for (let l = 0; l < nLoops; l++) {
    const flags = num(c.seek(92));
    if (flags & 2) {
      const hasBulge = c.n(72) !== 0;
      const closed = c.n(73, 1) !== 0;
      const nv = c.n(93);
      const pts: PolyVertex[] = [];
      for (let k = 0; k < nv; k++) {
        const x = num(c.seek(10));
        const v: PolyVertex = { x, y: c.n(20) };
        if (hasBulge && c.peek() === 42) v.bulge = c.n(42);
        pts.push(v);
      }
      loops.push({ poly: { pts, closed } });
    } else {
      const ne = c.n(93);
      loops.push({ edges: hatchEdges(c, ne) });
    }
    // source boundary objects
    if (c.peek() === 97) {
      const ns = c.n(97);
      for (let k = 0; k < ns; k++) c.take(330);
    }
  }
  const lines: HatchLine[] = [];
  const rest = new Cursor(r.tags.slice(c.i));
  const nLines = num(rest.seek(78));
  for (let l = 0; l < nLines; l++) {
    const angle = num(rest.seek(53));
    const base: P2 = [rest.n(43), rest.n(44)];
    const offset: P2 = [rest.n(45), rest.n(46)];
    const nd = rest.n(79);
    const dashes: number[] = [];
    for (let k = 0; k < nd; k++) dashes.push(num(rest.seek(49)));
    lines.push({ angle, base, offset, dashes });
  }
  const solid = r.n(70) === 1;
  const gradient = r.n(450) === 1;
  let grad: Extract<CadGeom, { k: "hatch" }>["grad"];
  if (gradient) {
    // colours: each 463 (value) is followed by its 63 (ACI) and 421 (true colour)
    const colors: CadColor[] = [];
    const t = r.tags;
    for (let i = 0; i < t.length; i++)
      if (t[i][0] === 463) {
        const c: CadColor = { aci: 256 };
        for (let j = i + 1; j < t.length && t[j][0] !== 463 && t[j][0] !== 470; j++) {
          if (t[j][0] === 63) c.aci = num(t[j][1]);
          if (t[j][0] === 421) c.rgb = num(t[j][1]) & 0xffffff;
        }
        if (c.rgb !== undefined) c.aci = 256; // a true colour wins (DWG keeps only it)
        colors.push(c);
      }
    grad = { name: r.s(470) || "LINEAR", angle: r.n(460), shift: r.n(461), single: r.n(452) === 1, tint: r.n(462, 1), colors };
  }
  return { k: "hatch", solid, pattern: r.s(2), loops, lines, gradient: gradient || undefined, grad };
}

/**
 * MULTILEADER (AcDbMLeader): the CONTEXT_DATA{ … } block holds the drawn result — text (304, location 12, direction 13,
 * height 41, arrow size 140) and per leader (302 LEADER{) its landing point 10, direction 11, dogleg length 40 and its
 * lines (304 LEADER_LINE{ with vertices 10). Arrow at each line's first vertex, the line runs to the landing point.
 */
function mleader(r: Rec): CadGeom | null {
  const t = r.tags;
  const a = t.findIndex((x) => x[0] === 300 && x[1] === "CONTEXT_DATA{");
  if (a < 0) return null;
  const lines: P3[][] = [];
  let text = "", textP: P3 | undefined, xdir: P3 | undefined, textH = 1, arrow = 0, w = 0, attach = 1;
  let block: string | undefined, bm: number[] | undefined;
  let depth = 0;
  for (let i = a + 1; i < t.length; i++) {
    const [c, v] = t[i];
    const p3 = (): P3 => [num(v), num(t[i + 1]?.[1]), num(t[i + 2]?.[1])];
    if (c === 301 && depth === 0) break;
    if (c === 302 && v === "LEADER{") {
      depth = 1;
      let land: P3 | undefined, dir: P3 = [1, 0, 0], dog = 0;
      const own: P3[][] = [];
      for (i++; i < t.length && !(t[i][0] === 303); i++) {
        const [cc, vv] = t[i];
        if (cc === 10 && !land) land = [num(vv), num(t[i + 1]?.[1]), num(t[i + 2]?.[1])];
        else if (cc === 11) dir = [num(vv), num(t[i + 1]?.[1]), num(t[i + 2]?.[1])];
        else if (cc === 40) dog = num(vv);
        else if (cc === 304 && vv === "LEADER_LINE{") {
          const pts: P3[] = [];
          for (i++; i < t.length && t[i][0] !== 305; i++) if (t[i][0] === 10) pts.push([num(t[i][1]), num(t[i + 1]?.[1]), num(t[i + 2]?.[1])]);
          own.push(pts);
        }
      }
      for (const pts of own) lines.push(land ? [...pts, land] : pts);
      if (land && dog) lines.push([land, [land[0] + dir[0] * dog, land[1] + dir[1] * dog, land[2]]]);
      depth = 0;
      continue;
    }
    if (c === 304) text = unescapeDxf(str(v));
    // text alignment 1 left, 2 centre, 3 right: the corner of its top line at 12 (omni-cad-12 "Landing first")
    else if (c === 171 && num(v) >= 1 && num(v) <= 3) attach = num(v);
    // block content (omni-cad-12 callout): its block record, then the 4 × 4 matrix that places it
    else if (c === 341) block = str(v).toUpperCase();
    else if (c === 47) (bm ??= []).push(num(v));
    else if (c === 12) textP = p3();
    else if (c === 13) xdir = p3();
    else if (c === 41) textH = num(v) || 1;
    else if (c === 140) arrow = num(v);
    else if (c === 43) w = num(v);
  }
  // the block's attribute values follow the context (330 attribute definition, 302 value)
  const vals: string[] = [];
  const end = t.findIndex((x, k) => k > a && x[0] === 301);
  for (let k = end + 1; end > 0 && k < t.length; k++) {
    if (t[k][0] !== 330) continue;
    const q = t.findIndex((x, n) => n > k && n < k + 5 && x[0] === 302);
    if (q > 0) vals.push(unescapeDxf(str(t[q][1])));
  }
  return { k: "mleader", lines, arrow, text, textP, textH, xdir: xdir && !(xdir[0] === 1 && xdir[1] === 0) ? xdir : undefined, attach, w, ...(block && bm?.length === 16 ? { block, bm, battr: vals } : {}) };
}

function mtextBody(r: Rec): string {
  // 3 = leading 250-character chunks, 1 = the last chunk
  // "^ " is a caret, "^I" a tab and so on: DXF writes control characters as a caret before (code + 64)
  // (omni-cad-15: tabs of a list paragraph; the DWG holds the tab itself)
  return unescapeDxf(r.all(3).map(str).join("") + str(r.get(1) ?? "")).replace(/\^([ @-_])/g, (_, c: string) => (c === " " ? "^" : String.fromCharCode(c.charCodeAt(0) - 64)));
}

function geomOf(type: string, r: Rec, e: CadEntity): CadGeom | null {
  switch (type) {
    case "LINE":
      return { k: "line", a: r.p3(10), b: r.p3(11) };
    case "POINT":
      return { k: "point", p: r.p3(10) };
    case "CIRCLE":
      return { k: "circle", c: r.p3(10), r: r.n(40) };
    case "ARC":
      return { k: "arc", c: r.p3(10), r: r.n(40), a0: r.n(50), a1: r.n(51) };
    case "ELLIPSE":
      return { k: "ellipse", c: r.p3(10), major: r.p3(11), ratio: r.n(40, 1) || 1, t0: r.n(41), t1: r.has(42) ? r.n(42) : Math.PI * 2 };
    case "LWPOLYLINE":
      return lwpolyline(r);
    case "SPLINE":
      return spline(r);
    case "TEXT":
    case "ATTDEF":
    case "ATTRIB": {
      if (type !== "TEXT" && r.n(70) & 1) e.invisible = true;
      const sub = r.tags.filter((t) => t[0] === 100).map((t) => t[1]);
      // ATTRIB: 72 is horizontal, 74 vertical justification (73 is the field length there)
      const vj = type !== "TEXT" || sub.includes("AcDbAttribute") ? r.n(74) : r.n(73);
      return { k: "text", p: r.p3(10), align: r.has(11) ? r.p3(11) : undefined, h: r.n(40, 1) || 1, rot: r.n(50), wf: r.has(41) && r.n(41) !== 1 ? r.n(41) : undefined, oblique: r.n(51) || undefined, text: r.s(1), style: r.s(7, "STANDARD"), hj: r.n(72), vj, mirror: r.n(71) || undefined };
    }
    case "MTEXT": {
      // 2018: an "Embedded Object" (101) follows with the column layout; its 10/11/40… are not the entity's
      const cut = r.tags.findIndex((t) => t[0] === 101);
      const m = cut > 0 ? new Rec(r.tags.slice(0, cut)) : r;
      const emb = cut > 0 ? new Rec(r.tags.slice(cut)) : null;
      const xdir = m.has(11) ? m.p3(11) : undefined;
      // 50 is in radians (QA reference drawings: entmake takes radians; AutoCAD itself writes the 11/21/31 direction)
      const rot = m.n(50);
      let cols: { n: number; w: number; gutter: number; h: number } | undefined;
      if (emb && emb.n(71) > 0 && emb.n(72) > 1 && emb.n(44) > 0) cols = { n: emb.n(72), w: emb.n(44), gutter: emb.n(45), h: emb.n(41) || m.n(46) };
      // background mask: 90 & 1 fill colour 63 / 421, & 2 the drawing's background; 45 border offset factor
      const bgf = m.n(90);
      const bg = bgf & 3 ? { color: bgf & 2 ? null : { aci: m.n(63, 256), ...(m.has(421) ? { rgb: m.n(421) & 0xffffff } : {}) }, scale: m.has(45) && m.n(45) >= 1 && m.n(45) <= 5 ? m.n(45) : 1.5 } : undefined;
      return { k: "mtext", p: m.p3(10), h: m.n(40, 1) || 1, w: m.n(41), attach: m.n(71, 1) || 1, rot, xdir, text: mtextBody(m), style: m.s(7, "STANDARD"), spacing: m.has(44) ? m.n(44) : undefined, cols, ...(bg ? { bg } : {}) };
    }
    case "INSERT":
      return { k: "insert", block: r.s(2), p: r.p3(10), sx: r.n(41, 1) || 1, sy: r.n(42, 1) || 1, rot: r.n(50), cols: Math.max(1, r.n(70, 1)), rows: Math.max(1, r.n(71, 1)), cs: r.n(44), rs: r.n(45), attribs: [], xdict: r.s(360).toUpperCase() || undefined };
    case "HATCH":
      return hatch(r);
    case "SOLID":
    case "TRACE":
      return { k: "solid", pts: [r.p3(10), r.p3(11), r.p3(12), r.has(13) ? r.p3(13) : r.p3(12)] };
    case "3DFACE":
      // invisible edges (70: 1, 2, 4, 8 = edge from corner 1 … 4): only the visible ones are drawn (omni-cad-20)
      if (r.n(70) & 15) {
        const f = r.n(70);
        return { k: "faces", edges: polyfaceEdges([r.p3(10), r.p3(11), r.p3(12), r.has(13) ? r.p3(13) : r.p3(12)], [[1, 2, 3, 4].map((i) => (f & (1 << (i - 1)) ? -i : i))]) };
      }
      return { k: "poly", pts: [r.p3(10), r.p3(11), r.p3(12), r.has(13) ? r.p3(13) : r.p3(12)].map((p) => ({ x: p[0], y: p[1] })), closed: true, is3d: true };
    case "DIMENSION":
    case "ARC_DIMENSION":
    case "LARGE_RADIAL_DIMENSION":
      return { k: "dimension", block: r.s(2), text: r.s(1) || undefined, measure: r.has(42) ? r.n(42) : undefined, dimtype: r.n(70) & 7 };
    case "LEADER":
      return { k: "leader", pts: points(r.tags, 10), arrow: r.n(71, 1) !== 0 };
    case "MULTILEADER":
      return mleader(r);
    case "IMAGE":
      return { k: "image", p: r.p3(10), u: r.p3(11), v: r.p3(12), size: [r.n(13), r.n(23)], def: r.s(340).toUpperCase(), clip: r.n(280) === 1 ? clipPoints(r.tags, 14) : undefined };
    case "WIPEOUT":
      // an image without a picture (AcDbRasterImage): frame p/u/v/size, boundary 14/24 in its pixel coordinates
      return { k: "wipeout", p: r.p3(10), u: r.p3(11), v: r.p3(12), size: [r.n(13, 1) || 1, r.n(23, 1) || 1], clip: clipPoints(r.tags, 14) };
    case "ACAD_TABLE": {
      // a table is a block reference to its anonymous *T block, which AutoCAD keeps up to date with the cells' text
      // and grid lines (omni-cad-14); the cell data that follows (AcDbTable) is not needed to draw it
      const cut = r.tags.findIndex((t) => t[0] === 100 && t[1] === "AcDbTable");
      const b = cut > 0 ? new Rec(r.tags.slice(0, cut)) : r;
      return { k: "insert", block: b.s(2), p: b.p3(10), sx: b.n(41, 1) || 1, sy: b.n(42, 1) || 1, rot: b.n(50), cols: 1, rows: 1, cs: 0, rs: 0, attribs: [] };
    }
    case "VIEWPORT":
      return { k: "viewport", c: r.p3(10), w: r.n(40), h: r.n(41), id: r.n(69), vc: [r.n(12), r.n(22)], vh: r.n(45), target: r.p3(17), twist: r.n(51), off: r.has(68) && r.n(68) === 0, frozen: [...r.all(331), ...r.all(341)].map((h) => str(h).toUpperCase()), clipBy: r.n(90) & 0x10000 && r.s(340) ? r.s(340).toUpperCase() : undefined }; // 2000 writes them as 341, later releases 331 (omni-cad-21)
    case "XLINE":
    case "RAY":
      return { k: "xline", p: r.p3(10), dir: r.p3(11), ray: type === "RAY" };
    case "3DSOLID":
    case "REGION":
    case "BODY":
      return modeler(r);
  }
  return null;
}

/** SAB data of ACIS entities in DXF 2013+ (ACDSDATA section, by entity handle) — set while a file is read */
let acdsData = new Map<string, Uint8Array>();

/**
 * 3DSOLID / REGION / BODY: the wireframe AutoCAD draws (cad/acis.ts). DXF 2000–2010 hold the SAT text in 1 (a line)
 * and 3 (the rest of a long line) with each character encrypted; 2013+ keep SAB in the ACDSDATA section.
 */
function modeler(r: Rec): CadGeom | null {
  let text = "", lines = 0;
  for (const [c, v] of r.tags) {
    if (c !== 1 && c !== 3) continue;
    // DXF writes a caret as "^ " and control characters as ^@ … ^_
    const s = str(v).replace(/\^([ @-_])/g, (_, ch: string) => (ch === " " ? "^" : String.fromCharCode(ch.charCodeAt(0) - 64)));
    text += (c === 1 && lines++ ? "\n" : "") + s;
  }
  const data = text ? parseSat(satDecrypt(text)) : (() => {
    const b = acdsData.get(r.s(5).toUpperCase());
    return b ? parseSab(b) : null;
  })();
  if (!data) return null;
  const edges = acisWires(data);
  return edges.length ? { k: "faces", edges } : null;
}

/** ACDSDATA: each ACDSRECORD with an ASM_Data value — its entity handle (320) and hex chunks (310). */
function readAcds(tags: Tag[], from: number, to: number): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const r of records(tags, from, to)) {
    if (r.tags[0][1] !== "ACDSRECORD") continue;
    const at = r.tags.findIndex((t) => t[0] === 2 && t[1] === "ASM_Data");
    const h = r.s(320).toUpperCase();
    if (at < 0 || !h) continue;
    const hex = r.tags.slice(at).filter((t) => t[0] === 310).map((t) => str(t[1])).join("");
    const b = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    out.set(h, b);
  }
  return out;
}

/** Entities of a record range; POLYLINE / VERTEX / SEQEND and INSERT / ATTRIB / SEQEND are folded into one entity. */
function readEntities(recs: Rec[], d: CadDrawing): CadEntity[] {
  const out: CadEntity[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const type = str(r.tags[0][1]);
    if (type === "POLYLINE") {
      const e = common(r, type);
      const flags = r.n(70);
      const pts: PolyVertex[] = [];
      const meshPts: P3[] = [], faces: number[][] = [];
      let j = i + 1;
      for (; j < recs.length && recs[j].tags[0][1] === "VERTEX"; j++) {
        const v = recs[j];
        const vf = v.n(70);
        if (flags & 64) {
          // polyface: positioned vertices (64 + 128), then faces (128) of corner indices 71–74
          if (vf & 64) meshPts.push(v.p3(10));
          else if (vf & 128) faces.push([v.n(71), v.n(72), v.n(73), v.n(74)]);
          continue;
        }
        if (vf & 16) continue; // spline frame control point
        if (vf & 128 && !(vf & 64)) continue; // polyface face record
        const p: PolyVertex = { x: v.n(10), y: v.n(20) };
        if (v.has(42)) p.bulge = v.n(42);
        // a vertex without 40 / 41 has the polyline's default start / end width (omni-cad-20: AutoCAD leaves out
        // the widths equal to the defaults; the DWG holds them on every vertex)
        if (v.has(40) || r.has(40)) p.w0 = v.has(40) ? v.n(40) : r.n(40);
        if (v.has(41) || r.has(41)) p.w1 = v.has(41) ? v.n(41) : r.n(41);
        pts.push(p);
      }
      if (recs[j]?.tags[0][1] === "SEQEND") i = j;
      else i = j - 1;
      if (flags & 64) {
        e.geom = { k: "faces", edges: polyfaceEdges(meshPts, faces) };
        out.push(e);
        continue;
      }
      if (flags & 16) {
        d.unsupported.POLYMESH = (d.unsupported.POLYMESH ?? 0) + 1;
        continue;
      }
      e.geom = { k: "poly", pts, closed: !!(flags & 1), width: r.n(40) || undefined, elevation: r.n(30) || undefined, is3d: !!(flags & 8) || undefined };
      out.push(e);
      continue;
    }
    // a constant attribute (ATTDEF 70 & 2) has no ATTRIB in the insert: AutoCAD draws the definition itself (omni-cad-18)
    if (UNSUPPORTED_DRAWN.has(type) && !(type === "ATTDEF" && r.n(70) & 2)) continue;
    const e = common(r, type);
    e.geom = geomOf(type, r, e);
    if (type === "INSERT" && r.n(66) === 1 && e.geom?.k === "insert") {
      let j = i + 1;
      for (; j < recs.length && recs[j].tags[0][1] === "ATTRIB"; j++) {
        const a = common(recs[j], "ATTRIB");
        a.geom = geomOf("ATTRIB", recs[j], a);
        e.geom.attribs.push(a);
      }
      if (recs[j]?.tags[0][1] === "SEQEND") i = j;
      else i = j - 1;
    }
    if (!e.geom) d.unsupported[type] = (d.unsupported[type] ?? 0) + 1;
    else out.push(e);
  }
  return out;
}

function readBlocks(tags: Tag[], from: number, to: number, d: CadDrawing) {
  const recs = records(tags, from, to);
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].tags[0][1] !== "BLOCK") continue;
    const b = recs[i];
    let j = i + 1;
    while (j < recs.length && recs[j].tags[0][1] !== "ENDBLK") j++;
    const name = b.s(2) || b.s(3);
    const flags = b.n(70);
    d.blocks.set(name.toUpperCase(), { name, base: [b.n(10), b.n(20)], flags, xref: flags & 4 ? b.s(1) || undefined : undefined, entities: readEntities(recs.slice(i + 1, j), d) });
    i = j;
  }
}

/** Clip boundary points (image 14/24, spatial filter 10/20): at least two, else none. */
function clipPoints(tags: Tag[], xc: number): P2[] | undefined {
  const pts = points(tags, xc).map((p): P2 => [p[0], p[1]]);
  // a polygon repeats its first corner at the end in DXF (not in DWG): one copy is kept
  const a = pts[0], z = pts[pts.length - 1];
  if (pts.length > 3 && Math.abs(a[0] - z[0]) < 1e-9 && Math.abs(a[1] - z[1]) < 1e-9) pts.pop();
  return pts.length >= 2 ? pts : undefined;
}

/**
 * XCLIP: INSERT → extension dictionary → ACAD_FILTER → SPATIAL → SPATIAL_FILTER. The filter's boundary (10/20) is in
 * the coordinates the clip was made in; its first 4×3 matrix (40 × 12, four per output axis) is the inverse of the insert's
 * transform at that time, which takes the boundary into block coordinates. A clip that is switched off (71 = 0) is
 * ignored. docs/design/CAD_IMPORT.md §11.
 */
function linkClips(d: CadDrawing, dicts: Map<string, Map<string, string>>, filters: Map<string, Rec>) {
  const clipOf = (xdict: string): P2[] | undefined => {
    const f = dicts.get(dicts.get(xdict)?.get("ACAD_FILTER") ?? "")?.get("SPATIAL");
    const r = f ? filters.get(f) : undefined;
    if (!r || r.n(71, 1) === 0) return undefined;
    const pts = clipPoints(r.tags, 10);
    if (!pts) return undefined;
    const m = r.all(40).map((v) => num(v));
    if (m.length < 12) return pts;
    // four values per output axis: x' = (0, 1, 2) · p + 3, y' = (4, 5, 6) · p + 7 (omni-cad-11: 1 0 0 0, 0 1 0 0, 0 0 1 0)
    return pts.map(([x, y]): P2 => [m[0] * x + m[1] * y + m[3], m[4] * x + m[5] * y + m[7]]);
  };
  const visit = (ents: CadEntity[]) => {
    for (const e of ents)
      if (e.geom?.k === "insert" && e.geom.xdict) {
        e.geom.clip = clipOf(e.geom.xdict);
        delete e.geom.xdict;
      }
  };
  visit(d.entities);
  for (const b of d.blocks.values()) visit(b.entities);
}

function readObjects(tags: Tag[], from: number, to: number, d: CadDrawing, blockRecords: Map<string, string>) {
  const dicts = new Map<string, Map<string, string>>();
  const filters = new Map<string, Rec>();
  const groupObjs = new Map<string, Omit<CadGroupDef, "name">>();
  for (const r of records(tags, from, to)) {
    const type = r.tags[0][1];
    if (type === "DICTIONARY") {
      const m = new Map<string, string>();
      for (let i = 0; i < r.tags.length - 1; i++) if (r.tags[i][0] === 3 && (r.tags[i + 1][0] === 350 || r.tags[i + 1][0] === 360)) m.set(str(r.tags[i][1]).toUpperCase(), str(r.tags[i + 1][1]).toUpperCase());
      dicts.set(r.s(5).toUpperCase(), m);
    } else if (type === "SPATIAL_FILTER") filters.set(r.s(5).toUpperCase(), r);
    else if (type === "RASTERVARIABLES") d.imageFrame = r.n(70, 1);
    else if (type === "WIPEOUTVARIABLES") d.wipeoutFrame = r.n(70, 1);
    else if (type === "IMAGEDEF") d.imageDefs.set(r.s(5).toUpperCase(), r.s(1));
    // GROUP: description 300, unnamed 70, selectable 71, member entities 340 (named in the ACAD_GROUP dictionary)
    else if (type === "GROUP") groupObjs.set(r.s(5).toUpperCase(), { description: r.s(300), unnamed: r.n(70) === 1, selectable: r.n(71, 1) !== 0, handles: r.all(340).map((v) => str(v).toUpperCase()) });
    else if (type === "LAYOUT") {
      // AcDbPlotSettings (page setup: its own name in 1, paper 44/45, rotation 73) then AcDbLayout (layout name 1,
      // tab order 71, limits 10/20–11/21, paper space block record 330)
      const at = r.tags.findIndex((t) => t[0] === 100 && t[1] === "AcDbLayout");
      const ps = new Rec(at > 0 ? r.tags.slice(0, at) : r.tags);
      const lay = new Rec(at > 0 ? r.tags.slice(at) : r.tags);
      const name = lay.s(1);
      const owner = lay.s(330) || r.s(340);
      const rec = blockRecords.get(owner.toUpperCase()) ?? "";
      const w = ps.n(44), h = ps.n(45);
      // PLOTSETTINGS 73: 0/2 = paper as listed, 1/3 = rotated 90°
      const rot = ps.n(73) & 1;
      const lim: [P2, P2] | undefined = lay.has(11) && lay.n(11) > lay.n(10) && lay.n(21) > lay.n(20) ? [[lay.n(10), lay.n(20)], [lay.n(11), lay.n(21)]] : undefined;
      if (name) d.layouts.push({ name, block: rec, order: lay.n(71), paper: w > 0 && h > 0 ? (rot ? [h, w] : [w, h]) : undefined, limits: lim, margins: [ps.n(40), ps.n(41), ps.n(42), ps.n(43)], paperMm: ps.has(72) && ps.n(72) === 0 ? 25.4 : 1 });
    }
  }
  d.layouts.sort((a, b) => a.order - b.order);
  if (groupObjs.size) {
    // the named objects dictionary (the one holding ACAD_GROUP) names each group
    const gd = [...dicts.values()].map((m) => m.get("ACAD_GROUP")).find((h) => h && dicts.has(h));
    const groups = cadGroups(gd ? dicts.get(gd)! : [], groupObjs);
    if (groups.length) d.groups = groups;
  }
  // (always: an insert with an extension dictionary but no clip — a dynamic block reference — drops the link too)
  linkClips(d, dicts, filters);
}

/** $ACADVER of the file being read (entity layouts that changed between releases) */
let readingVersion = "";

/** Read a DXF file (ASCII or binary) into the shared drawing model. */
export function readDxf(bytes: Uint8Array): CadDrawing {
  const tags = dxfTags(bytes);
  const d = emptyDrawing();
  const secs = sections(tags);
  if (!secs.size) throw new Error("DXF_NO_SECTIONS");
  const blockRecords = new Map<string, string>();
  const h = secs.get("HEADER");
  if (h) readHeader(tags, h[0], h[1], d);
  else d.version = "AC1009";
  readingVersion = d.version;
  const tb = secs.get("TABLES");
  const trueNames = new Map<string, string>();
  if (tb) readTables(tags, tb[0], tb[1], d, blockRecords, trueNames);
  const ds = secs.get("ACDSDATA");
  acdsData = ds ? readAcds(tags, ds[0], ds[1]) : new Map();
  const bl = secs.get("BLOCKS");
  if (bl) readBlocks(tags, bl[0], bl[1], d);
  const en = secs.get("ENTITIES");
  if (en) d.entities = readEntities(records(tags, en[0], en[1]), d);
  // (not kept after reading: the last file's solid data would stay in memory)
  acdsData = new Map();
  const ob = secs.get("OBJECTS");
  if (ob) readObjects(tags, ob[0], ob[1], d, blockRecords);
  // dynamic block definitions get their real names back, as AutoCAD does on loading (sample A-01 "Drawing Title")
  const renamed = new Map<string, string>();
  for (const [anon, real] of trueNames) {
    const b = d.blocks.get(anon);
    if (!b || d.blocks.has(real.toUpperCase())) continue;
    d.blocks.delete(anon);
    d.blocks.set(real.toUpperCase(), { ...b, name: real, flags: b.flags & ~1 });
    renamed.set(anon, real);
  }
  if (renamed.size) {
    for (const [k, v] of blockRecords) if (renamed.has(v.toUpperCase())) blockRecords.set(k, renamed.get(v.toUpperCase())!);
    const fix = (ents: CadEntity[]) => {
      for (const e of ents) if ((e.geom?.k === "insert" || e.geom?.k === "dimension") && renamed.has(e.geom.block.toUpperCase())) e.geom.block = renamed.get(e.geom.block.toUpperCase())!;
    };
    fix(d.entities);
    for (const b of d.blocks.values()) fix(b.entities);
  }
  // MLEADER block content names its block by record handle
  const named = (ents: CadEntity[]) => {
    for (const e of ents) if (e.geom?.k === "mleader" && e.geom.block) e.geom.block = blockRecords.get(e.geom.block) ?? undefined;
  };
  named(d.entities);
  for (const b of d.blocks.values()) named(b.entities);
  if (!d.layers.has("0")) d.layers.set("0", { name: "0", color: 7, ltype: "CONTINUOUS", lw: -3, on: true, frozen: false, locked: false, plot: true });
  return d;
}
