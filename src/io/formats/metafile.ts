// Windows metafile pictures (EMF, WMF) → SVG, in pure TypeScript from the public specifications [MS-EMF] and
// [MS-WMF] (no GDI, no third-party code). Office keeps many pictures as metafiles — copied charts, clip art, logos,
// equation previews — and a browser cannot show them, so the shared picture decode (render/picDecode.ts) turns the
// asset's bytes into an SVG when it is drawn; the asset itself keeps the original bytes, so saving writes them back.
//
// Played: the header (frame / bounds → the SVG viewBox and size), mapping (SetMapMode, window and viewport origins
// and extents, scale records, world transforms), pens / brushes / fonts (create, select, delete, stock objects),
// polygons / polylines / Béziers (16- and 32-bit), rectangles, round rectangles, ellipses, arcs / chords / pies,
// paths (BeginPath … StrokeAndFillPath, SelectClipPath), text (ExtTextOutW / A, SmallTextOut, WMF TextOut /
// ExtTextOut — fonts mapped to system fonts, the record's character advances kept), bitmaps (StretchDIBits, BitBlt,
// StretchBlt, SetDIBitsToDevice, AlphaBlend, WMF DIB records → embedded BMP / PNG / JPEG), gradient fills, regions,
// save / restore DC and clipping (IntersectClipRect, ExcludeClipRect, SelectClipPath, ExtSelectClipRgn).
// EMF+ (GDI+ records in comments): a dual file is played from its EMF records; an EMF+ only file draws its basic
// EMF+ shapes (rectangles, lines, paths, ellipses with solid brushes and pens — emfPlus below).
// A WMF holding an EMF in its escape records (MFCOMMENT "WMFC") is played from that EMF.
//
// Robustness: every read is checked against its record, a record that does not fit is skipped, counts are checked
// against the bytes they need, save / restore depth and the output size are capped — any input ends in time with
// bounded memory (tests/metafile.test.ts fuzzes it).

import { metafileKind, type MetaKind } from "./metafileSniff";
export { isMetafileMime, metafileKind, metafileSize, wmfPlaceable, type MetaKind } from "./metafileSniff";

export interface MetafileSvg {
  /** the SVG document (UTF-8 text) */
  svg: string;
  /** intrinsic size in CSS px (96 dpi) */
  width: number;
  height: number;
  kind: MetaKind;
  /** what could not be drawn as the file asks (short keys: "glyphIndexText", "emfPlusOnly", "rop", "truncated" …) */
  notes: string[];
}


const LIMIT = { output: 40 << 20, images: 96 << 20, depth: 256, objects: 65536, records: 4_000_000 };

class Bad extends Error {}
const BAD = new Bad("record");

type Pt = [number, number];
interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
const ID: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
/** m after n */
const mul = (m: Mat, n: Mat): Mat => ({ a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d, e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f });
const det = (m: Mat) => m.a * m.d - m.b * m.c;

/** number for the SVG text: 2 decimals, no -0, clamped */
function N(v: number): string {
  if (!isFinite(v)) return "0";
  const c = Math.max(-1e7, Math.min(1e7, v));
  const r = Math.round(c * 100) / 100;
  return r === 0 ? "0" : String(r);
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** text for XML: control characters and lone surrogates out */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, " ").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
const hex2 = (v: number) => (v & 0xff).toString(16).padStart(2, "0");
const colorref = (v: number) => `#${hex2(v)}${hex2(v >>> 8)}${hex2(v >>> 16)}`;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(b: Uint8Array): string {
  const out: string[] = [];
  let line = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    line += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
    if (line.length >= 8192) {
      out.push(line);
      line = "";
    }
  }
  out.push(line);
  return out.join("");
}

// ───────────────────────── objects and state ─────────────────────────

interface Img {
  uri: string;
  w: number;
  h: number;
  bottomUp: boolean;
}
interface Pen {
  k: "pen";
  style: number;
  width: number;
  cosmetic: boolean;
  color: string;
  user?: number[];
}
interface Brush {
  k: "brush";
  style: number;
  color: string;
  hatch: number;
  img?: Img;
}
interface Font {
  k: "font";
  h: number;
  w: number;
  esc: number;
  weight: number;
  italic: boolean;
  under: boolean;
  strike: boolean;
  charset: number;
  pitch: number;
  face: string;
}
interface Rgn {
  k: "rgn";
  d: string;
}
type Obj = Pen | Brush | Font | Rgn | { k: "other" };

const pen = (color: string, style = 0, width = 0): Pen => ({ k: "pen", style, width, cosmetic: width === 0, color });
const brush = (color: string, style = 0): Brush => ({ k: "brush", style, color, hatch: 0 });
const SYS_FONT: Font = { k: "font", h: -12, w: 0, esc: 0, weight: 400, italic: false, under: false, strike: false, charset: 0, pitch: 0, face: "Arial" };
const STOCK: Record<number, Obj> = {
  0: brush("#ffffff"),
  1: brush("#c0c0c0"),
  2: brush("#808080"),
  3: brush("#404040"),
  4: brush("#000000"),
  5: brush("#000000", 1),
  6: pen("#ffffff"),
  7: pen("#000000"),
  8: pen("#000000", 5),
  10: { ...SYS_FONT, face: "Courier New" },
  11: { ...SYS_FONT, face: "Courier New" },
  12: SYS_FONT,
  13: { ...SYS_FONT, weight: 700 },
  14: SYS_FONT,
  16: { ...SYS_FONT, face: "Courier New" },
  17: { ...SYS_FONT, face: "Segoe UI", h: -11 },
  18: brush("#ffffff"),
  19: pen("#000000"),
};

interface Dc {
  mapMode: number;
  wo: Pt;
  we: Pt;
  vo: Pt;
  ve: Pt;
  world: Mat;
  pen: Pen;
  brush: Brush;
  font: Font;
  text: string;
  bk: string;
  bkMode: number;
  fill: number;
  align: number;
  cur: Pt;
  clip: string[];
  arcDir: number;
  miter: number;
}

/** ratio of the em to a positive (cell) height, and the ascent / descent in ems (OS/2 win metrics, Office fonts) */
const FACE_METRICS: Record<string, [number, number]> = {
  arial: [0.905, 0.212],
  "times new roman": [0.891, 0.216],
  calibri: [0.952, 0.269],
  cambria: [0.95, 0.222],
  "segoe ui": [1.079, 0.251],
  tahoma: [1.0, 0.207],
  verdana: [1.005, 0.21],
  "courier new": [0.833, 0.3],
  "malgun gothic": [1.079, 0.27],
  gulim: [0.86, 0.14],
  dotum: [0.86, 0.14],
  batang: [0.86, 0.14],
};
/** Korean and Japanese face names as GDI writes them → the family name browsers know too */
const FACE_ALIAS: Record<string, string> = {
  "\ub9d1\uc740 \uace0\ub515": "Malgun Gothic",
  "\uad74\ub9bc": "Gulim",
  "\uad74\ub9bc\uccb4": "GulimChe",
  "\ub3cb\uc6c0": "Dotum",
  "\ub3cb\uc6c0\uccb4": "DotumChe",
  "\ubc14\ud0d5": "Batang",
  "\ubc14\ud0d5\uccb4": "BatangChe",
  "\uad81\uc11c": "Gungsuh",
  "\uad81\uc11c\uccb4": "GungsuhChe",
  "\uff2d\uff33 \u30b4\u30b7\u30c3\u30af": "MS Gothic",
  "\uff2d\uff33 \u660e\u671d": "MS Mincho",
  "\uff2d\uff33 \uff30\u30b4\u30b7\u30c3\u30af": "MS PGothic",
  "\u30e1\u30a4\u30ea\u30aa": "Meiryo",
  "\u5b8b\u4f53": "SimSun",
  "\u9ed1\u4f53": "SimHei",
  "\u5fae\u8f6f\u96c5\u9ed1": "Microsoft YaHei",
  "\u65b0\u7d30\u660e\u9ad4": "PMingLiU",
};
const CHARSET_CODEPAGE: Record<number, string> = {
  0: "windows-1252",
  1: "windows-1252",
  128: "shift_jis",
  129: "euc-kr",
  134: "gbk",
  136: "big5",
  161: "windows-1253",
  162: "windows-1254",
  163: "windows-1258",
  177: "windows-1255",
  178: "windows-1256",
  186: "windows-1257",
  204: "windows-1251",
  222: "windows-874",
  238: "windows-1250",
};
const decoders = new Map<string, TextDecoder | null>();
/** 8-bit text in a font's character set (symbol fonts: the byte values as they are) */
function decodeAnsi(b: Uint8Array, charset: number): string {
  if (charset === 2 || charset === 255) return String.fromCharCode(...b);
  const cp = CHARSET_CODEPAGE[charset] ?? "windows-1252";
  let d = decoders.get(cp);
  if (d === undefined) {
    try {
      d = new TextDecoder(cp);
    } catch {
      d = null;
    }
    decoders.set(cp, d);
  }
  if (!d) return String.fromCharCode(...b);
  try {
    return d.decode(b);
  } catch {
    return String.fromCharCode(...b);
  }
}

// ───────────────────────── SVG output ─────────────────────────

class Out {
  parts: string[] = [];
  defs: string[] = [];
  open: string[] = [];
  size = 0;
  full = false;
  n = 0;
  imageBytes = 0;
  id(p: string) {
    return `${p}${++this.n}`;
  }
  def(s: string) {
    if (this.full) return;
    this.defs.push(s);
    this.grow(s.length);
  }
  grow(n: number) {
    this.size += n;
    if (this.size > LIMIT.output) this.full = true;
  }
  add(el: string, clip: string[]) {
    if (this.full) return;
    let k = 0;
    while (k < this.open.length && k < clip.length && this.open[k] === clip[k]) k++;
    while (this.open.length > k) {
      this.open.pop();
      this.parts.push("</g>");
    }
    for (let i = k; i < clip.length; i++) {
      this.open.push(clip[i]);
      this.parts.push(`<g clip-path="url(#${clip[i]})">`);
    }
    this.parts.push(el);
    this.grow(el.length + 40);
  }
  end() {
    while (this.open.length) {
      this.open.pop();
      this.parts.push("</g>");
    }
  }
}

// ───────────────────────── player ─────────────────────────

const HATCH: Record<number, string> = {
  0: "M0 4H8",
  1: "M4 0V8",
  2: "M0 0L8 8M-1 7L1 9M7 -1L9 1",
  3: "M0 8L8 0M-1 1L1 -1M7 9L9 7",
  4: "M0 4H8M4 0V8",
  5: "M0 0L8 8M0 8L8 0",
};

class Player {
  b: Uint8Array;
  dv: DataView;
  end = 0;
  out = new Out();
  notes = new Set<string>();
  dc: Dc;
  stack: Dc[] = [];
  objs = new Map<number, Obj>();
  /** EMF: device units per mm */
  dpm: Pt = [96 / 25.4, 96 / 25.4];
  /** WMF: the reference rectangle the window maps onto */
  wmfRef: { x: number; y: number; w: number; h: number } | null = null;
  path: string[] | null = null;
  pathOpen = false;
  /** LineTo strokes waiting to be joined into one path */
  pending: { d: string[]; attrs: string; clip: string[] } | null = null;
  brushPatterns = new Map<Brush, string>();

  constructor(b: Uint8Array) {
    this.b = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.dc = {
      mapMode: 1,
      wo: [0, 0],
      we: [1, 1],
      vo: [0, 0],
      ve: [1, 1],
      world: ID,
      pen: STOCK[7] as Pen,
      brush: STOCK[0] as Brush,
      font: SYS_FONT,
      text: "#000000",
      bk: "#ffffff",
      bkMode: 2,
      fill: 1,
      align: 0,
      cur: [0, 0],
      clip: [],
      arcDir: 1,
      miter: 10,
    };
  }

  // ── reads, checked against the current record ──
  chk(o: number, n: number) {
    if (o < 0 || n < 0 || o + n > this.end) throw BAD;
  }
  u8(o: number) {
    this.chk(o, 1);
    return this.b[o];
  }
  u16(o: number) {
    this.chk(o, 2);
    return this.dv.getUint16(o, true);
  }
  i16(o: number) {
    this.chk(o, 2);
    return this.dv.getInt16(o, true);
  }
  u32(o: number) {
    this.chk(o, 4);
    return this.dv.getUint32(o, true);
  }
  i32(o: number) {
    this.chk(o, 4);
    return this.dv.getInt32(o, true);
  }
  f32(o: number) {
    this.chk(o, 4);
    const v = this.dv.getFloat32(o, true);
    return isFinite(v) ? v : 0;
  }
  /** n points from o (16-bit or 32-bit pairs) */
  pts(o: number, n: number, small: boolean): Pt[] {
    const sz = small ? 4 : 8;
    if (n < 0 || n > (this.end - o) / sz) throw BAD;
    const out: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = small ? [this.i16(o + i * 4), this.i16(o + i * 4 + 2)] : [this.i32(o + i * 8), this.i32(o + i * 8 + 4)];
    return out;
  }

  // ── mapping ──
  mat(): Mat {
    const s = this.dc;
    let sx = 1, sy = 1, ox = s.vo[0], oy = s.vo[1];
    if (this.wmfRef) {
      const r = this.wmfRef;
      sx = s.we[0] ? r.w / s.we[0] : 1;
      sy = s.we[1] ? r.h / s.we[1] : 1;
      ox = r.x;
      oy = r.y;
    } else if (s.mapMode >= 2 && s.mapMode <= 6) {
      const mm = [0, 0, 0.1, 0.01, 0.254, 0.0254, 25.4 / 1440][s.mapMode];
      sx = this.dpm[0] * mm;
      sy = -this.dpm[1] * mm;
    } else if (s.mapMode === 7 || s.mapMode === 8) {
      sx = s.we[0] ? s.ve[0] / s.we[0] : 1;
      sy = s.we[1] ? s.ve[1] / s.we[1] : 1;
      if (s.mapMode === 7) {
        const m = Math.min(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx || 1) * m;
        sy = Math.sign(sy || 1) * m;
      }
    }
    const page: Mat = { a: sx, b: 0, c: 0, d: sy, e: ox - s.wo[0] * sx, f: oy - s.wo[1] * sy };
    return mul(page, s.world);
  }
  P(m: Mat, x: number, y: number) {
    return `${N(m.a * x + m.c * y + m.e)} ${N(m.b * x + m.d * y + m.f)}`;
  }
  dev(m: Mat, x: number, y: number): Pt {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  }

  // ── geometry (logical points → device path text) ──
  poly(p: Pt[], close: boolean, to = false): string {
    if (!p.length) return "";
    const m = this.mat();
    let d = to ? `L${this.P(m, p[0][0], p[0][1])}` : `M${this.P(m, p[0][0], p[0][1])}`;
    for (let i = 1; i < p.length; i++) d += `L${this.P(m, p[i][0], p[i][1])}`;
    return close ? d + "Z" : d;
  }
  bez(p: Pt[], to: boolean): string {
    const m = this.mat();
    let d = "";
    let i = 0;
    if (!to) {
      if (!p.length) return "";
      d = `M${this.P(m, p[0][0], p[0][1])}`;
      i = 1;
    } else d = `M${this.P(m, this.dc.cur[0], this.dc.cur[1])}`;
    for (; i + 2 < p.length; i += 3) d += `C${this.P(m, p[i][0], p[i][1])} ${this.P(m, p[i + 1][0], p[i + 1][1])} ${this.P(m, p[i + 2][0], p[i + 2][1])}`;
    return d;
  }
  rect(l: number, t: number, r: number, b: number): string {
    const m = this.mat();
    return `M${this.P(m, l, t)}L${this.P(m, r, t)}L${this.P(m, r, b)}L${this.P(m, l, b)}Z`;
  }
  /** an elliptic arc as cubic Béziers (logical), from parameter angle t0 sweeping `sw` radians */
  arcD(cx: number, cy: number, rx: number, ry: number, t0: number, sw: number, lead: "M" | "L" | ""): string {
    const m = this.mat();
    const n = Math.max(1, Math.min(64, Math.ceil(Math.abs(sw) / (Math.PI / 2) - 1e-9)));
    const step = sw / n;
    const k = (4 / 3) * Math.tan(step / 4);
    let a = t0;
    let d = lead ? `${lead}${this.P(m, cx + rx * Math.cos(a), cy + ry * Math.sin(a))}` : "";
    for (let i = 0; i < n; i++) {
      const b = a + step;
      const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      d += `C${this.P(m, cx + rx * (ca - k * sa), cy + ry * (sa + k * ca))} ${this.P(m, cx + rx * (cb + k * sb), cy + ry * (sb - k * cb))} ${this.P(m, cx + rx * cb, cy + ry * sb)}`;
      a = b;
    }
    return d;
  }
  ellipse(l: number, t: number, r: number, b: number): string {
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = Math.abs(r - l) / 2, ry = Math.abs(b - t) / 2;
    return this.arcD(cx, cy, rx, ry, 0, 2 * Math.PI, "M") + "Z";
  }
  roundRect(l: number, t: number, r: number, b: number, w: number, h: number): string {
    if (l > r) [l, r] = [r, l];
    if (t > b) [t, b] = [b, t];
    const rx = Math.min(Math.abs(w) / 2, (r - l) / 2), ry = Math.min(Math.abs(h) / 2, (b - t) / 2);
    if (rx <= 0 || ry <= 0) return this.rect(l, t, r, b);
    const m = this.mat();
    const H = Math.PI / 2;
    return (
      `M${this.P(m, l + rx, t)}L${this.P(m, r - rx, t)}` +
      this.arcD(r - rx, t + ry, rx, ry, -H, H, "") +
      `L${this.P(m, r, b - ry)}` +
      this.arcD(r - rx, b - ry, rx, ry, 0, H, "") +
      `L${this.P(m, l + rx, b)}` +
      this.arcD(l + rx, b - ry, rx, ry, H, H, "") +
      `L${this.P(m, l, t + ry)}` +
      this.arcD(l + rx, t + ry, rx, ry, Math.PI, H, "") +
      "Z"
    );
  }
  /** Arc / Chord / Pie / ArcTo: the box and the two radial points; GDI draws counter-clockwise on the device by default */
  arcOf(l: number, t: number, r: number, b: number, s: Pt, e: Pt) {
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = Math.abs(r - l) / 2 || 1e-9, ry = Math.abs(b - t) / 2 || 1e-9;
    const t0 = Math.atan2((s[1] - cy) / ry, (s[0] - cx) / rx), t1 = Math.atan2((e[1] - cy) / ry, (e[0] - cx) / rx);
    const yDown = det(this.mat()) > 0;
    const ccw = this.dc.arcDir !== 2;
    const decreasing = ccw === yDown;
    const TAU = 2 * Math.PI;
    let sw = decreasing ? t0 - t1 : t1 - t0;
    sw = ((sw % TAU) + TAU) % TAU;
    if (sw < 1e-9) sw = TAU;
    return { cx, cy, rx, ry, t0, sw: decreasing ? -sw : sw };
  }

  // ── styles ──
  scale() {
    return Math.sqrt(Math.abs(det(this.mat()))) || 1;
  }
  strokeAttrs(p: Pen = this.dc.pen): string | null {
    const style = p.style & 0xf;
    if (style === 5) return null;
    const cosmetic = p.cosmetic || p.width <= 0;
    const w = cosmetic ? 1 : Math.max(p.width * this.scale(), 0.01);
    let s = ` stroke="${p.color}" stroke-width="${N(w)}"`;
    if (cosmetic) s += ` vector-effect="non-scaling-stroke"`;
    const cap = p.style & 0xf00, join = p.style & 0xf000;
    s += cap === 0x200 ? ` stroke-linecap="butt"` : cap === 0x100 ? ` stroke-linecap="square"` : ` stroke-linecap="round"`;
    s += join === 0x2000 ? ` stroke-miterlimit="${N(Math.max(1, this.dc.miter))}"` : join === 0x1000 ? ` stroke-linejoin="bevel"` : ` stroke-linejoin="round"`;
    const u = Math.max(w, 1);
    const dash =
      style === 1 ? [3, 1] : style === 2 ? [1, 1] : style === 3 ? [3, 1, 1, 1] : style === 4 ? [3, 1, 1, 1, 1, 1] : style === 8 ? [1, 1] : style === 7 && p.user?.length ? p.user.map((v) => v / (cosmetic ? 1 : u)) : null;
    if (dash) s += ` stroke-dasharray="${dash.map((v) => N(Math.max(0.1, v * (cosmetic ? (style === 7 ? 1 : 3) : u)))).join(" ")}"`;
    return s;
  }
  fillAttr(b: Brush = this.dc.brush): string | null {
    if (b.style === 1) return null;
    if (b.style === 2 && HATCH[b.hatch] !== undefined) return `url(#${this.hatchPattern(b)})`;
    if ((b.style === 3 || b.style === 5 || b.style === 6) && b.img) return `url(#${this.imagePattern(b)})`;
    return b.color;
  }
  hatchPattern(b: Brush): string {
    const key = `${b.hatch}|${b.color}|${this.dc.bkMode === 2 ? this.dc.bk : ""}`;
    const hit = this.hatches.get(key);
    if (hit) return hit;
    const id = this.out.id("h");
    const bg = this.dc.bkMode === 2 ? `<rect width="8" height="8" fill="${this.dc.bk}"/>` : "";
    this.out.def(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="8" height="8">${bg}<path d="${HATCH[b.hatch]}" stroke="${b.color}" stroke-width="1" fill="none"/></pattern>`);
    this.hatches.set(key, id);
    return id;
  }
  hatches = new Map<string, string>();
  imagePattern(b: Brush): string {
    const got = this.brushPatterns.get(b);
    if (got) return got;
    const id = this.out.id("p");
    const im = b.img!;
    this.out.def(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${im.w}" height="${im.h}"><image width="${im.w}" height="${im.h}" href="${im.uri}"/></pattern>`);
    this.brushPatterns.set(b, id);
    return id;
  }
  /** a device path filled and / or stroked with the current brush / pen */
  shape(d: string, fill: boolean, stroke: boolean) {
    if (!d) return;
    if (this.path) {
      this.path.push(d);
      this.pathOpen = !d.endsWith("Z");
      return;
    }
    const f = fill ? this.fillAttr() : null;
    const s = stroke ? this.strokeAttrs() : null;
    if (!f && !s) return;
    this.out.add(`<path d="${d}" fill="${f ?? "none"}"${f && this.dc.fill !== 2 ? ` fill-rule="evenodd"` : ""}${s ?? ""}/>`, this.dc.clip);
  }
  flush() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.out.add(`<path d="${p.d.join("")}" fill="none"${p.attrs}/>`, p.clip);
  }
  lineTo(x: number, y: number) {
    const m = this.mat();
    const [cx, cy] = this.dc.cur;
    this.dc.cur = [x, y];
    if (this.path) {
      if (!this.pathOpen) this.path.push(`M${this.P(m, cx, cy)}`);
      this.path.push(`L${this.P(m, x, y)}`);
      this.pathOpen = true;
      return;
    }
    const attrs = this.strokeAttrs();
    if (!attrs) return;
    const p = this.pending;
    if (p && p.attrs === attrs && p.clip === this.dc.clip && p.d.length < 20000) p.d.push(`L${this.P(m, x, y)}`);
    else {
      this.flush();
      this.pending = { d: [`M${this.P(m, cx, cy)}L${this.P(m, x, y)}`], attrs, clip: this.dc.clip };
    }
  }
  moveTo(x: number, y: number) {
    this.dc.cur = [x, y];
    if (this.path) this.pathOpen = false;
    else if (this.pending) this.pending.d.push(`M${this.P(this.mat(), x, y)}`);
  }

  // ── clipping (device paths) ──
  clipWith(d: string, rule: "nonzero" | "evenodd", mode: number) {
    // modes: 1 AND, 2 OR, 3 XOR, 4 DIFF, 5 COPY
    if (mode === 5 && !d) {
      this.dc.clip = [];
      return;
    }
    const id = this.out.id("c");
    if (mode === 4) {
      this.out.def(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="M-1e7 -1e7H1e7V1e7H-1e7Z${d}" clip-rule="evenodd"/></clipPath>`);
      this.dc.clip = [...this.dc.clip, id];
      return;
    }
    this.out.def(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${d}" clip-rule="${rule}"/></clipPath>`);
    // AND narrows; COPY replaces; OR / XOR (rare) replace too — a union of nested clips has no SVG form here
    this.dc.clip = mode === 1 ? [...this.dc.clip, id] : [id];
    if (mode !== 1 && mode !== 5) this.notes.add("clipMode");
  }

  // ── save / restore ──
  save() {
    if (this.stack.length >= LIMIT.depth) return;
    this.stack.push({ ...this.dc, cur: [...this.dc.cur] as Pt });
  }
  restore(n: number) {
    // n < 0: relative (−1 the last saved); n > 0: that saved state counted from the first
    let i = n < 0 ? this.stack.length + n : n - 1;
    if (i < 0 || i >= this.stack.length) i = this.stack.length - 1;
    if (i < 0) return;
    this.dc = this.stack[i];
    this.stack.length = i;
  }

  // ── objects ──
  put(i: number, o: Obj) {
    if (i >= 0 && i < LIMIT.objects) this.objs.set(i, o);
  }
  select(i: number) {
    const o = i & 0x80000000 ? STOCK[i & 0x7fffffff] : this.objs.get(i);
    if (!o) return;
    if (o.k === "pen") this.dc.pen = o;
    else if (o.k === "brush") this.dc.brush = o;
    else if (o.k === "font") this.dc.font = o;
    else if (o.k === "rgn") this.clipWith(o.d, "nonzero", 5);
  }

  // ── bitmaps ──
  /** a DIB (BITMAPINFO + bits) as an image the SVG can hold */
  dib(bmiAt: number, bmiLen: number, bitsAt: number, bitsLen: number, opaque32: boolean): Img | null {
    if (bmiLen < 12 || bmiAt < 0 || bitsAt < 0) return null;
    this.chk(bmiAt, bmiLen);
    bitsLen = Math.min(bitsLen, this.end - bitsAt);
    if (bitsLen <= 0) return null;
    const hs = this.u32(bmiAt);
    let w: number, h: number, bpp: number, comp = 0;
    if (hs === 12) {
      w = this.u16(bmiAt + 4);
      h = this.i16(bmiAt + 6);
      bpp = this.u16(bmiAt + 10);
    } else if (hs >= 40 && hs <= bmiLen) {
      w = this.i32(bmiAt + 4);
      h = this.i32(bmiAt + 8);
      bpp = this.u16(bmiAt + 14);
      comp = this.u32(bmiAt + 16);
    } else return null;
    if (w <= 0 || h === 0 || Math.abs(h) > 1 << 15 || w > 1 << 15 || w * Math.abs(h) > 1 << 26) return null;
    if (this.out.imageBytes + bitsLen + bmiLen > LIMIT.images) {
      this.notes.add("imageLimit");
      return null;
    }
    this.out.imageBytes += bitsLen + bmiLen;
    const bits = this.b.subarray(bitsAt, bitsAt + bitsLen);
    if (comp === 4 || comp === 5) return { uri: `data:image/${comp === 4 ? "jpeg" : "png"};base64,${base64(bits)}`, w, h: Math.abs(h), bottomUp: h > 0 };
    let bmi = this.b.subarray(bmiAt, bmiAt + bmiLen);
    if (opaque32 && hs === 40 && bpp === 32 && comp === 0) {
      // GDI ignores the fourth byte outside AlphaBlend; a browser would read it as alpha: say the masks without alpha
      const nb = new Uint8Array(bmiLen + 12);
      nb.set(bmi);
      nb[16] = 3;
      nb.set([0, 0, 0xff, 0, 0, 0xff, 0, 0, 0xff, 0, 0, 0], 40);
      nb.set(bmi.subarray(40), 52);
      bmi = nb;
    }
    // the bits run past what the header asks: leave them (a BMP reader takes the size from the header)
    const file = new Uint8Array(14 + bmi.length + bits.length);
    const fdv = new DataView(file.buffer);
    file[0] = 0x42;
    file[1] = 0x4d;
    fdv.setUint32(2, file.length, true);
    fdv.setUint32(10, 14 + bmi.length, true);
    file.set(bmi, 14);
    file.set(bits, 14 + bmi.length);
    return { uri: `data:image/bmp;base64,${base64(file)}`, w, h: Math.abs(h), bottomUp: h > 0 };
  }
  /** a bitmap into the logical destination rectangle, from its source rectangle (DIB origin rule: `dibOrigin`) */
  blit(img: Img, dx: number, dy: number, dw: number, dh: number, sx: number, sy: number, sw: number, sh: number, rop: number, dibOrigin: boolean, opacity = 1) {
    this.flush();
    if (!sw || !sh) {
      sw = img.w;
      sh = img.h;
    }
    if (!dw || !dh) return;
    const top = dibOrigin && img.bottomUp ? img.h - sy - sh : sy;
    const t: Mat = { a: dw / sw, b: 0, c: 0, d: dh / sh, e: dx - (sx * dw) / sw, f: dy - (top * dh) / sh };
    const m = mul(this.mat(), t);
    const r3 = (rop >>> 16) & 0xff;
    if (r3 === 0xaa) return;
    let style = "";
    if (r3 === 0x88) style = "mix-blend-mode:darken";
    else if (r3 === 0xee) style = "mix-blend-mode:lighten";
    else if (r3 === 0x66 || r3 === 0x99) style = "mix-blend-mode:difference";
    if (r3 !== 0xcc && r3 !== 0x88 && r3 !== 0xee && r3 !== 0x66 && r3 !== 0) this.notes.add("rop");
    const full = sx === 0 && top === 0 && sw === img.w && sh === img.h;
    const clip = full ? this.dc.clip : this.tempClip(this.rect(dx, dy, dx + dw, dy + dh));
    this.out.add(
      `<image width="${img.w}" height="${img.h}" preserveAspectRatio="none" transform="matrix(${N6(m.a)} ${N6(m.b)} ${N6(m.c)} ${N6(m.d)} ${N(m.e)} ${N(m.f)})"${opacity < 1 ? ` opacity="${N(opacity)}"` : ""}${style ? ` style="${style}"` : ""} href="${img.uri}"/>`,
      clip,
    );
  }
  tempClip(d: string): string[] {
    const id = this.out.id("c");
    this.out.def(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${d}"/></clipPath>`);
    return [...this.dc.clip, id];
  }
  /** a raster operation without a source: the brush, black or white over the logical rectangle */
  patBlt(x: number, y: number, w: number, h: number, rop: number) {
    const r3 = (rop >>> 16) & 0xff;
    const d = this.rect(x, y, x + w, y + h);
    const f = r3 === 0xf0 ? this.fillAttr() : r3 === 0 ? "#000000" : r3 === 0xff ? "#ffffff" : null;
    if (r3 !== 0xf0 && r3 !== 0 && r3 !== 0xff && r3 !== 0xaa) this.notes.add("rop");
    if (f) this.out.add(`<path d="${d}" fill="${f}"/>`, this.dc.clip);
  }

  // ── text ──
  fontCss(f: Font): string {
    // only the name: quotes, markup, CSS escapes and punctuation out (the SVG is drawn as an image, but the value
    // stays a plain family name whatever the record holds)
    const face = clean(f.face).replace(/['"<>&\\();{}:]/g, "").trim();
    const fam: string[] = [];
    const alias = FACE_ALIAS[face];
    if (face) fam.push(`'${face}'`);
    if (alias) fam.push(`'${alias}'`);
    if (f.charset === 129) fam.push("'Malgun Gothic'");
    if (f.charset === 128) fam.push("'Yu Gothic'", "'MS Gothic'");
    if (f.charset === 134) fam.push("'Microsoft YaHei'");
    const g = f.pitch & 0xf0;
    fam.push(g === 0x10 ? "serif" : g === 0x30 ? "monospace" : g === 0x40 ? "cursive" : "sans-serif");
    return fam.join(", ");
  }
  /**
   * Text at logical (x, y) with the current font, colour and alignment. `dx`: the logical advance of each character
   * (the record's own, so the placement holds whatever system font draws it). `rect`: ETO_OPAQUE / ETO_CLIPPED box.
   */
  text(x: number, y: number, str: string, dx: number[] | null, opts: number, rect: [number, number, number, number] | null) {
    this.flush();
    if (this.path) return; // text into a path: not kept
    const s = this.dc;
    const f = s.font;
    const updateCp = (s.align & 1) !== 0;
    if (updateCp) [x, y] = s.cur;
    const m = this.mat();
    if (rect && opts & 2) this.out.add(`<path d="${this.rect(rect[0], rect[1], rect[2], rect[3])}" fill="${s.bk}"/>`, s.clip);
    str = clean(str);
    const chars = Array.from(str);
    if (!chars.length) return;
    const key = f.face.toLowerCase();
    const met = FACE_METRICS[FACE_ALIAS[f.face]?.toLowerCase() ?? key] ?? [0.905, 0.212];
    const em = f.h < 0 ? -f.h : f.h > 0 ? f.h / (met[0] + met[1]) : 12;
    // advances per code point (a surrogate pair has two entries)
    let adv: number[] | null = null;
    if (dx && dx.length) {
      adv = [];
      let k = 0;
      for (const ch of chars) {
        let a = dx[k++] ?? 0;
        if (ch.length > 1) a += dx[k++] ?? 0;
        adv.push(a);
      }
    }
    const width = adv ? adv.reduce((p, q) => p + q, 0) : chars.reduce((p, c) => p + (c.codePointAt(0)! >= 0x1100 ? 1 : 0.55) * em, 0);
    const h = s.align & 6;
    const shift = h === 6 ? -width / 2 : h === 2 ? -width : 0;
    const v = s.align & 24;
    const base = v === 24 ? 0 : v === 8 ? -met[1] * em : met[0] * em;
    // text stays upright on a flipped map (GDI): the y column of the mapping turns back when the map mirrors
    const flip = det(m) < 0;
    const lin = { a: m.a, b: m.b, c: flip ? -m.c : m.c, d: flip ? -m.d : m.d };
    const ang = (-(f.esc || 0) / 10) * (Math.PI / 180) * (flip ? 1 : 1);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const [ox, oy] = this.dev(m, x, y);
    const t = { a: lin.a * ca + lin.c * sa, b: lin.b * ca + lin.d * sa, c: -lin.a * sa + lin.c * ca, d: -lin.b * sa + lin.d * ca, e: ox, f: oy };
    let clip = s.clip;
    if (rect && opts & 4) clip = this.tempClip(this.rect(rect[0], rect[1], rect[2], rect[3]));
    if (s.bkMode === 2 && !(rect && opts & 2)) {
      const top = base - met[0] * em, bot = base + met[1] * em;
      const bx = (u: number, w: number) => `${N(t.a * u + t.c * w + t.e)} ${N(t.b * u + t.d * w + t.f)}`;
      this.out.add(`<path d="M${bx(shift, top)}L${bx(shift + width, top)}L${bx(shift + width, bot)}L${bx(shift, bot)}Z" fill="${s.bk}"/>`, clip);
    }
    let xs = N(shift);
    if (adv && chars.length > 1) {
      const list: string[] = [];
      let at = shift;
      for (const a of adv) {
        list.push(N(at));
        at += a;
      }
      xs = list.join(" ");
    }
    const deco = [f.under ? "underline" : "", f.strike ? "line-through" : ""].filter(Boolean).join(" ");
    this.out.add(
      `<text transform="matrix(${N6(t.a)} ${N6(t.b)} ${N6(t.c)} ${N6(t.d)} ${N(t.e)} ${N(t.f)})" x="${xs}" y="${N(base)}" font-family="${esc(this.fontCss(f))}" font-size="${N(Math.max(0.01, em))}"${f.weight >= 600 ? ` font-weight="${f.weight >= 800 ? 800 : 700}"` : ""}${f.italic ? ` font-style="italic"` : ""}${deco ? ` text-decoration="${deco}"` : ""} fill="${s.text}" xml:space="preserve">${esc(chars.join(""))}</text>`,
      clip,
    );
    if (updateCp) s.cur = [x + width, y];
  }
  logFontW(o: number): Font {
    let face = "";
    for (let i = 0; i < 32; i++) {
      const c = this.u16(o + 28 + i * 2);
      if (!c) break;
      face += String.fromCharCode(c);
    }
    return { k: "font", h: this.i32(o), w: this.i32(o + 4), esc: this.i32(o + 8), weight: this.i32(o + 16), italic: !!this.u8(o + 20), under: !!this.u8(o + 21), strike: !!this.u8(o + 22), charset: this.u8(o + 23), pitch: this.u8(o + 27), face };
  }
  /** RGNDATA (device rectangles) → path */
  rgnData(o: number, len: number): string {
    if (len < 32) return "";
    this.chk(o, len);
    const n = this.u32(o + 8);
    if (n > (len - 32) / 16) throw BAD;
    let d = "";
    for (let i = 0; i < n; i++) {
      const p = o + 32 + i * 16;
      const l = this.i32(p), t = this.i32(p + 4), r = this.i32(p + 8), b = this.i32(p + 12);
      d += `M${N(l)} ${N(t)}H${N(r)}V${N(b)}H${N(l)}Z`;
    }
    return d;
  }

  // ───────── EMF ─────────
  emf(): { vb: [number, number, number, number]; w: number; h: number } | null {
    const b = this.b;
    this.end = b.length;
    const hsize = this.u32(4);
    if (hsize < 88 || hsize > b.length) return null;
    const bl = this.i32(8), bt = this.i32(12), br = this.i32(16), bb = this.i32(20);
    const fl = this.i32(24), ft = this.i32(28), fr = this.i32(32), fb = this.i32(36);
    const devX = this.i32(72), devY = this.i32(76), mmX = this.i32(80), mmY = this.i32(84);
    let umX = 0, umY = 0;
    if (hsize >= 108) {
      umX = this.i32(100);
      umY = this.i32(104);
    }
    if (devX > 0 && devY > 0) {
      if (umX > 0 && umY > 0) this.dpm = [devX / (umX / 1000), devY / (umY / 1000)];
      else if (mmX > 0 && mmY > 0) this.dpm = [devX / mmX, devY / mmY];
    }
    let vb: [number, number, number, number];
    let w: number, h: number;
    if (fr > fl && fb > ft) {
      vb = [(fl / 100) * this.dpm[0], (ft / 100) * this.dpm[1], ((fr - fl) / 100) * this.dpm[0], ((fb - ft) / 100) * this.dpm[1]];
      w = ((fr - fl) / 100) * (96 / 25.4);
      h = ((fb - ft) / 100) * (96 / 25.4);
    } else if (br >= bl && bb >= bt) {
      vb = [bl, bt, br - bl + 1, bb - bt + 1];
      w = (vb[2] / this.dpm[0]) * (96 / 25.4);
      h = (vb[3] / this.dpm[1]) * (96 / 25.4);
    } else return null;
    let o = hsize;
    let count = 0;
    while (o + 8 <= b.length && count++ < LIMIT.records && !this.out.full) {
      const type = this.dv.getUint32(o, true), size = this.dv.getUint32(o + 4, true);
      if (size < 8 || size % 4 || o + size > b.length) break;
      this.end = o + size;
      if (type === 14) break;
      if (type !== 54 && type !== 27) this.flush();
      try {
        this.emfRecord(type, o, size);
      } catch (e) {
        if (!(e instanceof Bad)) throw e;
        this.notes.add("badRecord");
      }
      o += size;
    }
    this.flush();
    return { vb, w, h };
  }

  emfRecord(type: number, o: number, size: number) {
    const s = this.dc;
    const pt = (at: number): Pt => [this.i32(at), this.i32(at + 4)];
    const box = (at: number) => [this.i32(at), this.i32(at + 4), this.i32(at + 8), this.i32(at + 12)] as const;
    switch (type) {
      case 2:
      case 85: {
        const p = this.pts(o + 28, this.u32(o + 24), type === 85);
        this.shape(this.bez(p, false), false, true);
        break;
      }
      case 5:
      case 88: {
        const p = this.pts(o + 28, this.u32(o + 24), type === 88);
        if (this.path) {
          const m = this.mat();
          if (!this.pathOpen) this.path.push(`M${this.P(m, s.cur[0], s.cur[1])}`);
          for (let i = 0; i + 2 < p.length; i += 3) this.path.push(`C${this.P(m, p[i][0], p[i][1])} ${this.P(m, p[i + 1][0], p[i + 1][1])} ${this.P(m, p[i + 2][0], p[i + 2][1])}`);
          this.pathOpen = true;
        } else this.shape(this.bez(p, true), false, true);
        if (p.length) s.cur = p[p.length - 1];
        break;
      }
      case 3:
      case 86: {
        const p = this.pts(o + 28, this.u32(o + 24), type === 86);
        this.shape(this.poly(p, true), true, true);
        break;
      }
      case 4:
      case 87: {
        const p = this.pts(o + 28, this.u32(o + 24), type === 87);
        this.shape(this.poly(p, false), false, true);
        break;
      }
      case 6:
      case 89: {
        const p = this.pts(o + 28, this.u32(o + 24), type === 89);
        for (const q of p) this.lineTo(q[0], q[1]);
        break;
      }
      case 7:
      case 8:
      case 90:
      case 91: {
        const small = type >= 90;
        const n = this.u32(o + 24), total = this.u32(o + 28);
        if (n > (size - 32) / 4) throw BAD;
        const counts: number[] = [];
        for (let i = 0; i < n; i++) counts.push(this.u32(o + 32 + i * 4));
        const p = this.pts(o + 32 + n * 4, total, small);
        let k = 0, d = "";
        const close = type === 8 || type === 91;
        for (const c of counts) {
          if (c > p.length - k) break;
          d += this.poly(p.slice(k, k + c), close);
          k += c;
        }
        this.shape(d, close, true);
        break;
      }
      case 9:
        s.we = pt(o + 8);
        break;
      case 10:
        s.wo = pt(o + 8);
        break;
      case 11:
        s.ve = pt(o + 8);
        break;
      case 12:
        s.vo = pt(o + 8);
        break;
      case 15: {
        const [x, y] = pt(o + 8);
        const [dx, dy] = this.dev(this.mat(), x, y);
        this.out.add(`<rect x="${N(dx)}" y="${N(dy)}" width="1" height="1" fill="${colorref(this.u32(o + 16))}"/>`, s.clip);
        break;
      }
      case 17:
        s.mapMode = this.u32(o + 8);
        break;
      case 18:
        s.bkMode = this.u32(o + 8);
        break;
      case 19:
        s.fill = this.u32(o + 8);
        break;
      case 22:
        s.align = this.u32(o + 8);
        break;
      case 24:
        s.text = colorref(this.u32(o + 8));
        break;
      case 25:
        s.bk = colorref(this.u32(o + 8));
        break;
      case 27: {
        const [x, y] = pt(o + 8);
        this.moveTo(x, y);
        break;
      }
      case 29:
      case 30: {
        const [l, t, r, b] = box(o + 8);
        this.clipWith(this.rect(l, t, r, b), "nonzero", type === 30 ? 1 : 4);
        break;
      }
      case 31:
      case 32: {
        const xn = this.i32(o + 8), xd = this.i32(o + 12), yn = this.i32(o + 16), yd = this.i32(o + 20);
        const e = type === 31 ? s.ve : s.we;
        const ne: Pt = [xd ? (e[0] * xn) / xd : e[0], yd ? (e[1] * yn) / yd : e[1]];
        if (type === 31) s.ve = ne;
        else s.we = ne;
        break;
      }
      case 33:
        this.save();
        break;
      case 34:
        this.restore(this.i32(o + 8));
        break;
      case 35:
      case 36: {
        const x: Mat = { a: this.f32(o + 8), b: this.f32(o + 12), c: this.f32(o + 16), d: this.f32(o + 20), e: this.f32(o + 24), f: this.f32(o + 28) };
        const mode = type === 35 ? 4 : this.u32(o + 32);
        if (mode === 1) s.world = ID;
        else if (mode === 2) s.world = mul(s.world, x);
        else if (mode === 3) s.world = mul(x, s.world);
        else if (mode === 4) s.world = x;
        break;
      }
      case 37:
        this.select(this.u32(o + 8));
        break;
      case 38: {
        const st = this.u32(o + 12), w = this.i32(o + 16);
        this.put(this.u32(o + 8), { k: "pen", style: st, width: Math.abs(w), cosmetic: w === 0, color: colorref(this.u32(o + 24)) });
        break;
      }
      case 39: {
        const st = this.u32(o + 12);
        this.put(this.u32(o + 8), { k: "brush", style: st === 3 || st === 5 || st === 6 ? 0 : st, color: colorref(this.u32(o + 16)), hatch: this.u32(o + 20) });
        break;
      }
      case 40: {
        const i = this.u32(o + 8);
        this.objs.delete(i);
        break;
      }
      case 41: {
        const [cx, cy] = pt(o + 8);
        const r = this.u32(o + 16);
        const a0 = (this.f32(o + 20) * Math.PI) / 180, sw = (this.f32(o + 24) * Math.PI) / 180;
        // angles count counter-clockwise on a y-up page: on the y-down logical plane, the parameter goes the other way
        const yDown = det(this.mat()) > 0;
        const t0 = yDown ? -a0 : a0, swp = yDown ? -sw : sw;
        const startX = cx + r * Math.cos(t0), startY = cy + r * Math.sin(t0);
        this.lineTo(startX, startY);
        this.flush();
        const d = this.arcD(cx, cy, r, r, t0, swp, this.path ? "" : "M");
        if (this.path) {
          this.path.push(d);
          this.pathOpen = true;
        } else this.shape(d, false, true);
        s.cur = [cx + r * Math.cos(t0 + swp), cy + r * Math.sin(t0 + swp)];
        break;
      }
      case 42: {
        const [l, t, r, b] = box(o + 8);
        this.shape(this.ellipse(l, t, r, b), true, true);
        break;
      }
      case 43: {
        const [l, t, r, b] = box(o + 8);
        this.shape(this.rect(l, t, r, b), true, true);
        break;
      }
      case 44: {
        const [l, t, r, b] = box(o + 8);
        this.shape(this.roundRect(l, t, r, b, this.i32(o + 24), this.i32(o + 28)), true, true);
        break;
      }
      case 45:
      case 46:
      case 47:
      case 55: {
        const [l, t, r, b] = box(o + 8);
        const a = this.arcOf(l, t, r, b, pt(o + 24), pt(o + 32));
        if (type === 55) {
          this.lineTo(a.cx + a.rx * Math.cos(a.t0), a.cy + a.ry * Math.sin(a.t0));
          this.flush();
          const d = this.arcD(a.cx, a.cy, a.rx, a.ry, a.t0, a.sw, this.path ? "" : "M");
          if (this.path) {
            this.path.push(d);
            this.pathOpen = true;
          } else this.shape(d, false, true);
          s.cur = [a.cx + a.rx * Math.cos(a.t0 + a.sw), a.cy + a.ry * Math.sin(a.t0 + a.sw)];
          break;
        }
        let d = this.arcD(a.cx, a.cy, a.rx, a.ry, a.t0, a.sw, "M");
        if (type === 46) d += "Z";
        if (type === 47) d += `L${this.P(this.mat(), a.cx, a.cy)}Z`;
        this.shape(d, type !== 45, true);
        break;
      }
      case 49:
        this.put(this.u32(o + 8), { k: "other" });
        break;
      case 54: {
        const [x, y] = pt(o + 8);
        this.lineTo(x, y);
        break;
      }
      case 56:
      case 92: {
        const small = type === 92;
        const n = this.u32(o + 24);
        const p = this.pts(o + 28, n, small);
        const tAt = o + 28 + n * (small ? 4 : 8);
        this.chk(tAt, n);
        const m = this.mat();
        let d = "";
        for (let i = 0; i < n; i++) {
          const ty = this.b[tAt + i];
          const kind = ty & 6;
          if (kind === 6) d += `M${this.P(m, p[i][0], p[i][1])}`;
          else if (kind === 2) d += `${d ? "" : `M${this.P(m, s.cur[0], s.cur[1])}`}L${this.P(m, p[i][0], p[i][1])}`;
          else if (kind === 4 && i + 2 < n) {
            d += `${d ? "" : `M${this.P(m, s.cur[0], s.cur[1])}`}C${this.P(m, p[i][0], p[i][1])} ${this.P(m, p[i + 1][0], p[i + 1][1])} ${this.P(m, p[i + 2][0], p[i + 2][1])}`;
            i += 2;
            if (this.b[tAt + i] & 1) d += "Z";
            s.cur = p[i];
            continue;
          }
          if (ty & 1) d += "Z";
          s.cur = p[i];
        }
        this.shape(d, false, true);
        break;
      }
      case 57:
        s.arcDir = this.u32(o + 8);
        break;
      case 58: {
        const v = this.u32(o + 8);
        s.miter = v > 0 && v < 1000 ? v : this.f32(o + 8) || 10;
        break;
      }
      case 59:
        this.path = [];
        this.pathOpen = false;
        break;
      case 60:
        break;
      case 61:
        if (this.path) {
          this.path.push("Z");
          this.pathOpen = false;
        }
        break;
      case 62:
      case 63:
      case 64: {
        const d = this.path?.join("") ?? "";
        this.path = null;
        this.pathOpen = false;
        this.shape(d, type !== 64, type !== 62);
        break;
      }
      case 65:
      case 66:
        break;
      case 67: {
        const d = this.path?.join("") ?? "";
        this.path = null;
        this.pathOpen = false;
        if (d) this.clipWith(d, s.fill === 2 ? "nonzero" : "evenodd", this.u32(o + 8));
        break;
      }
      case 68:
        this.path = null;
        this.pathOpen = false;
        break;
      case 70: {
        // EMF+ in a comment: EmfPlusHeader (0x4001) says dual (flag D) or EMF+ only
        if (size >= 28 && this.u32(o + 12) === 0x2b464d45 && this.u16(o + 16) === 0x4001) {
          const dual = (this.u16(o + 18) & 1) !== 0;
          if (!dual) this.emfPlusOnly = true;
          if (size >= 44) this.plusDpi = this.u32(o + 36) || 96;
        }
        if (this.emfPlusOnly && size >= 16 && this.u32(o + 12) === 0x2b464d45) this.emfPlus(o + 16, o + 8 + 4 + this.u32(o + 8));
        break;
      }
      case 71:
      case 72:
      case 74: {
        const cb = this.u32(o + 24);
        const ih = type === 74 ? -1 : this.u32(o + 28);
        const at = type === 72 ? o + 40 : type === 71 ? o + 32 : o + 28;
        const d = this.rgnData(at, Math.min(cb, this.end - at));
        const br = ih < 0 ? s.brush : ih & 0x80000000 ? (STOCK[ih & 0x7fffffff] as Brush) : (this.objs.get(ih) as Brush | undefined);
        if (!d || !br || br.k !== "brush") break;
        const f = this.fillAttr(br);
        if (type === 72) {
          if (f) this.out.add(`<path d="${d}" fill="none" stroke="${br.color}" stroke-width="1"/>`, s.clip);
        } else if (f) this.out.add(`<path d="${d}" fill="${f}"/>`, s.clip);
        break;
      }
      case 75: {
        const cb = this.u32(o + 8), mode = this.u32(o + 12);
        const d = cb >= 32 ? this.rgnData(o + 16, Math.min(cb, this.end - o - 16)) : "";
        if (!d && mode === 5) s.clip = [];
        else if (d) this.clipWith(d, "nonzero", mode);
        break;
      }
      case 76:
      case 77:
      case 114:
      case 116: {
        const dx = this.i32(o + 24), dy = this.i32(o + 28), dw = this.i32(o + 32), dh = this.i32(o + 36);
        const rop = type === 114 || type === 116 ? 0xcc0020 : this.u32(o + 40);
        const sx = this.i32(o + 44), sy = this.i32(o + 48);
        const offBmi = this.u32(o + 84), cbBmi = this.u32(o + 88), offBits = this.u32(o + 92), cbBits = this.u32(o + 96);
        let sw = 0, sh = 0;
        if (type !== 76) {
          sw = this.i32(o + 100);
          sh = this.i32(o + 104);
        }
        if (!cbBmi) {
          this.patBlt(dx, dy, dw, dh, rop);
          break;
        }
        const alpha = type === 114 ? this.u8(o + 42) / 255 : 1;
        const img = this.dib(o + offBmi, cbBmi, o + offBits, cbBits, type !== 114);
        if (type === 116) this.notes.add("transparentBlt");
        if (img) this.blit(img, dx, dy, dw, dh, sx, sy, sw || img.w, sh || img.h, rop, false, alpha);
        break;
      }
      case 80:
      case 81: {
        const dx = this.i32(o + 24), dy = this.i32(o + 28), sx = this.i32(o + 32), sy = this.i32(o + 36), sw = this.i32(o + 40), sh = this.i32(o + 44);
        const offBmi = this.u32(o + 48), cbBmi = this.u32(o + 52), offBits = this.u32(o + 56), cbBits = this.u32(o + 60);
        const rop = type === 81 ? this.u32(o + 68) : 0xcc0020;
        const dw = type === 81 ? this.i32(o + 72) : sw, dh = type === 81 ? this.i32(o + 76) : sh;
        if (!cbBmi) {
          this.patBlt(dx, dy, dw, dh, rop);
          break;
        }
        const img = this.dib(o + offBmi, cbBmi, o + offBits, cbBits, true);
        if (img) this.blit(img, dx, dy, dw, dh, sx, sy, sw, sh, rop, true);
        break;
      }
      case 82:
        this.put(this.u32(o + 8), this.logFontW(o + 12));
        break;
      case 83:
      case 84: {
        const opts = this.u32(o + 52);
        const n = this.u32(o + 44), offS = this.u32(o + 48), offDx = this.u32(o + 72);
        const rect = [this.i32(o + 56), this.i32(o + 60), this.i32(o + 64), this.i32(o + 68)] as [number, number, number, number];
        const [x, y] = pt(o + 36);
        if (n > size) throw BAD;
        if (opts & 0x10) {
          // glyph indices: the font's own numbering, not characters — only the background box is drawn
          this.notes.add("glyphIndexText");
          if (opts & 2) this.text(x, y, "", null, opts, rect);
          break;
        }
        let str = "";
        if (type === 84) {
          this.chk(o + offS, n * 2);
          for (let i = 0; i < n; i++) str += String.fromCharCode(this.dv.getUint16(o + offS + i * 2, true));
        } else {
          this.chk(o + offS, n);
          str = decodeAnsi(this.b.subarray(o + offS, o + offS + n), s.font.charset);
        }
        let dx: number[] | null = null;
        const pdy = (opts & 0x2000) !== 0;
        const dn = type === 83 ? str.length : n;
        if (offDx && o + offDx + dn * 4 * (pdy ? 2 : 1) <= this.end) {
          dx = [];
          for (let i = 0; i < dn; i++) dx.push(this.i32(o + offDx + i * 4 * (pdy ? 2 : 1)));
        }
        this.text(x, y, str, dx, opts, opts & 6 ? rect : null);
        break;
      }
      case 93:
      case 94: {
        const usage = this.u32(o + 12);
        const img = usage === 0 || type === 93 ? this.dib(o + this.u32(o + 16), this.u32(o + 20), o + this.u32(o + 24), this.u32(o + 28), true) : null;
        this.put(this.u32(o + 8), img ? { k: "brush", style: 5, color: "#808080", hatch: 0, img } : brush("#808080"));
        break;
      }
      case 95: {
        const st = this.u32(o + 28), w = this.u32(o + 32), bst = this.u32(o + 36), col = this.u32(o + 40), ne = this.u32(o + 48);
        const user: number[] = [];
        if ((st & 0xf) === 7 && ne < 64) for (let i = 0; i < ne; i++) user.push(this.u32(o + 52 + i * 4));
        const geometric = (st & 0xf0000) === 0x10000;
        this.put(this.u32(o + 8), { k: "pen", style: bst === 1 ? 5 : st, width: geometric ? w : 0, cosmetic: !geometric || w === 0, color: colorref(col), user });
        break;
      }
      case 108: {
        const x = this.i32(o + 8), y = this.i32(o + 12), n = this.u32(o + 16), opts = this.u32(o + 20);
        let at = o + 36;
        let rect: [number, number, number, number] | null = null;
        if (!(opts & 0x100)) {
          rect = [this.i32(at), this.i32(at + 4), this.i32(at + 8), this.i32(at + 12)];
          at += 16;
        }
        if (n > size) throw BAD;
        let str = "";
        if (opts & 0x200) {
          this.chk(at, n);
          str = decodeAnsi(this.b.subarray(at, at + n), s.font.charset);
        } else {
          this.chk(at, n * 2);
          for (let i = 0; i < n; i++) str += String.fromCharCode(this.dv.getUint16(at + i * 2, true));
        }
        if (opts & 0x10) {
          this.notes.add("glyphIndexText");
          break;
        }
        this.text(x, y, str, null, opts, rect);
        break;
      }
      case 118: {
        const nv = this.u32(o + 24), nt = this.u32(o + 28), mode = this.u32(o + 32);
        if (nv > (size - 36) / 16) throw BAD;
        const vs: { x: number; y: number; c: string }[] = [];
        for (let i = 0; i < nv; i++) {
          const p = o + 36 + i * 16;
          vs.push({ x: this.i32(p), y: this.i32(p + 4), c: `#${hex2(this.u16(p + 8) >> 8)}${hex2(this.u16(p + 10) >> 8)}${hex2(this.u16(p + 12) >> 8)}` });
        }
        let at = o + 36 + nv * 16;
        const m = this.mat();
        for (let i = 0; i < nt && i < 100000; i++) {
          if (mode === 2) {
            const a = vs[this.u32(at)], b2 = vs[this.u32(at + 4)], c = vs[this.u32(at + 8)];
            at += 12;
            if (!a || !b2 || !c) continue;
            const avg = (k: number) => Math.round([a, b2, c].reduce((p, v) => p + parseInt(v.c.slice(1 + k * 2, 3 + k * 2), 16), 0) / 3);
            this.out.add(`<path d="${this.poly([[a.x, a.y], [b2.x, b2.y], [c.x, c.y]], true)}" fill="#${hex2(avg(0))}${hex2(avg(1))}${hex2(avg(2))}"/>`, s.clip);
            this.notes.add("gradientTriangle");
          } else {
            const a = vs[this.u32(at)], b2 = vs[this.u32(at + 4)];
            at += 8;
            if (!a || !b2) continue;
            const id = this.out.id("g");
            const [x1, y1] = this.dev(m, a.x, a.y);
            const [x2, y2] = mode === 0 ? this.dev(m, b2.x, a.y) : this.dev(m, a.x, b2.y);
            this.out.def(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${N(x1)}" y1="${N(y1)}" x2="${N(x2)}" y2="${N(y2)}"><stop offset="0" stop-color="${a.c}"/><stop offset="1" stop-color="${b2.c}"/></linearGradient>`);
            this.out.add(`<path d="${this.rect(a.x, a.y, b2.x, b2.y)}" fill="url(#${id})"/>`, s.clip);
          }
        }
        break;
      }
    }
  }

  // ───────── EMF+ (only files: a basic subset) ─────────
  emfPlusOnly = false;
  plusObjs = new Map<number, { k: "brush"; c: string; a: number } | { k: "pen"; c: string; a: number; w: number } | { k: "path"; pts: Pt[]; types: number[] }>();
  plusWorld: Mat = ID;
  plusPage: Mat = ID;
  plusStack: Mat[] = [];
  /**
   * EMF+ records from `o` to `end` ([MS-EMFPLUS]), for files without EMF drawing records: solid brushes and pens,
   * path objects, FillRects / DrawRects, FillPolygon / DrawLines, Fill / DrawEllipse, Fill / DrawPath, world and
   * page transforms, save / restore. EMF+ draws in the reference device's pixels, which are the EMF device units.
   */
  emfPlus(o: number, end: number) {
    end = Math.min(end, this.end);
    const argb = (v: number) => ({ c: `#${hex2(v >>> 16)}${hex2(v >>> 8)}${hex2(v)}`, a: ((v >>> 24) & 0xff) / 255 });
    let guard = 0;
    while (o + 12 <= end && guard++ < 100000) {
      const type = this.u16(o), flags = this.u16(o + 2), size = this.u32(o + 4);
      if (size < 12 || o + size > end) break;
      const d = o + 12;
      const m = mul(this.plusPage, this.plusWorld);
      const P = (x: number, y: number) => this.P(m, x, y);
      const comp = (flags & 0x4000) !== 0;
      const fillOf = (solid: boolean, v: number): string | null => {
        const c = solid ? argb(v) : (() => {
          const ob = this.plusObjs.get(v & 0xff);
          return ob?.k === "brush" ? ob : null;
        })();
        return c && c.a ? `fill="${c.c}"${c.a < 1 ? ` fill-opacity="${N(c.a)}"` : ""}` : null;
      };
      const strokeOf = (id: number): string | null => {
        const ob = this.plusObjs.get(id & 0xff);
        if (ob?.k !== "pen" || !ob.a) return null;
        const w = ob.w * Math.sqrt(Math.abs(det(m)));
        return `fill="none" stroke="${ob.c}"${ob.a < 1 ? ` stroke-opacity="${N(ob.a)}"` : ""} stroke-width="${N(Math.max(w, 1))}"${w < 1 ? ` vector-effect="non-scaling-stroke"` : ""}`;
      };
      const rectAt = (at: number, i: number): [number, number, number, number] =>
        comp ? [this.i16(at + i * 8), this.i16(at + i * 8 + 2), this.i16(at + i * 8 + 4), this.i16(at + i * 8 + 6)] : [this.f32(at + i * 16), this.f32(at + i * 16 + 4), this.f32(at + i * 16 + 8), this.f32(at + i * 16 + 12)];
      const ptAt = (at: number, i: number): Pt => (comp ? [this.i16(at + i * 4), this.i16(at + i * 4 + 2)] : [this.f32(at + i * 8), this.f32(at + i * 8 + 4)]);
      const ellipse = (x: number, y: number, w: number, h: number) => {
        const k = 0.5523, cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
        return `M${P(cx + rx, cy)}C${P(cx + rx, cy + ry * k)} ${P(cx + rx * k, cy + ry)} ${P(cx, cy + ry)}C${P(cx - rx * k, cy + ry)} ${P(cx - rx, cy + ry * k)} ${P(cx - rx, cy)}C${P(cx - rx, cy - ry * k)} ${P(cx - rx * k, cy - ry)} ${P(cx, cy - ry)}C${P(cx + rx * k, cy - ry)} ${P(cx + rx, cy - ry * k)} ${P(cx + rx, cy)}Z`;
      };
      const xform = (at: number): Mat => ({ a: this.f32(at), b: this.f32(at + 4), c: this.f32(at + 8), d: this.f32(at + 12), e: this.f32(at + 16), f: this.f32(at + 20) });
      const apply = (x: Mat) => (this.plusWorld = flags & 0x2000 ? mul(x, this.plusWorld) : mul(this.plusWorld, x));
      try {
        switch (type) {
          case 0x4008: {
            // Object: brush (1), pen (2), path (3)
            const kind = (flags >> 8) & 0x7f, id = flags & 0xff;
            if (kind === 1) {
              if (this.u32(d + 4) === 0) this.plusObjs.set(id, { k: "brush", ...argb(this.u32(d + 8)) });
            } else if (kind === 2) {
              const pf = this.u32(d + 8), w = this.f32(d + 16);
              const bAt = d + 20 + this.penDataExtra(d + 8, pf);
              const c = this.u32(bAt + 4) === 0 ? argb(this.u32(bAt + 8)) : { c: "#000000", a: 1 };
              this.plusObjs.set(id, { k: "pen", ...c, w });
            } else if (kind === 3) {
              const n = this.u32(d + 4), pf = this.u32(d + 8);
              const c16 = (pf & 0x4000) !== 0;
              if (n > (size - 24) / (c16 ? 5 : 9)) break;
              const pts: Pt[] = [];
              for (let i = 0; i < n; i++) pts.push(c16 ? [this.i16(d + 12 + i * 4), this.i16(d + 12 + i * 4 + 2)] : [this.f32(d + 12 + i * 8), this.f32(d + 12 + i * 8 + 4)]);
              const tAt = d + 12 + n * (c16 ? 4 : 8);
              const types: number[] = [];
              for (let i = 0; i < n; i++) types.push(this.u8(tAt + i));
              this.plusObjs.set(id, { k: "path", pts, types });
            }
            break;
          }
          case 0x400a:
          case 0x400b: {
            const fill = type === 0x400a;
            const n = this.u32(fill ? d + 4 : d), at = fill ? d + 8 : d + 4;
            if (n > size / 8) break;
            const f = fill ? fillOf((flags & 0x8000) !== 0, this.u32(d)) : strokeOf(flags);
            if (!f) break;
            let dd = "";
            for (let i = 0; i < n; i++) {
              const [x, y, w, h] = rectAt(at, i);
              dd += `M${P(x, y)}L${P(x + w, y)}L${P(x + w, y + h)}L${P(x, y + h)}Z`;
            }
            this.out.add(`<path d="${dd}" ${f}/>`, this.dc.clip);
            break;
          }
          case 0x400c:
          case 0x400d: {
            const fill = type === 0x400c;
            const n = this.u32(fill ? d + 4 : d), at = fill ? d + 8 : d + 4;
            if (n > size / 4) break;
            const f = fill ? fillOf((flags & 0x8000) !== 0, this.u32(d)) : strokeOf(flags);
            if (!f) break;
            let dd = "";
            for (let i = 0; i < n; i++) {
              const [x, y] = ptAt(at, i);
              dd += `${i ? "L" : "M"}${P(x, y)}`;
            }
            if (fill || flags & 0x2000) dd += "Z";
            this.out.add(`<path d="${dd}" ${f}/>`, this.dc.clip);
            break;
          }
          case 0x400e:
          case 0x400f: {
            const fill = type === 0x400e;
            const [x, y, w, h] = rectAt(fill ? d + 4 : d, 0);
            const f = fill ? fillOf((flags & 0x8000) !== 0, this.u32(d)) : strokeOf(flags);
            if (f) this.out.add(`<path d="${ellipse(x, y, w, h)}" ${f}/>`, this.dc.clip);
            break;
          }
          case 0x4014:
          case 0x4015: {
            const ob = this.plusObjs.get(flags & 0xff);
            if (ob?.k !== "path") break;
            let dd = "";
            for (let i = 0; i < ob.pts.length; i++) {
              const t = ob.types[i] ?? 1, [x, y] = ob.pts[i];
              if ((t & 7) === 0) dd += `M${P(x, y)}`;
              else if ((t & 7) === 3 && i + 2 < ob.pts.length) {
                dd += `C${P(x, y)} ${P(ob.pts[i + 1][0], ob.pts[i + 1][1])} ${P(ob.pts[i + 2][0], ob.pts[i + 2][1])}`;
                i += 2;
              } else dd += `${dd ? "L" : "M"}${P(x, y)}`;
              if ((ob.types[i] ?? 0) & 0x80) dd += "Z";
            }
            const f = type === 0x4014 ? fillOf((flags & 0x8000) !== 0, this.u32(d)) : strokeOf(this.u32(d));
            if (f && dd) this.out.add(`<path d="${dd}" ${f}/>`, this.dc.clip);
            break;
          }
          case 0x402a:
            this.plusWorld = xform(d);
            break;
          case 0x402b:
            this.plusWorld = ID;
            break;
          case 0x402c:
            apply(xform(d));
            break;
          case 0x402d:
            apply({ a: 1, b: 0, c: 0, d: 1, e: this.f32(d), f: this.f32(d + 4) });
            break;
          case 0x402e:
            apply({ a: this.f32(d), b: 0, c: 0, d: this.f32(d + 4), e: 0, f: 0 });
            break;
          case 0x402f: {
            const r = (this.f32(d) * Math.PI) / 180;
            apply({ a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 });
            break;
          }
          case 0x4030: {
            // SetPageTransform: unit (flags) × scale → device pixels at the header's logical dpi
            const unit = flags & 0xff, sc = this.f32(d) || 1;
            const dpi = this.plusDpi;
            const k = unit === 3 ? dpi / 72 : unit === 4 ? dpi : unit === 5 ? dpi / 300 : unit === 6 ? dpi / 25.4 : 1;
            this.plusPage = { a: sc * k, b: 0, c: 0, d: sc * k, e: 0, f: 0 };
            break;
          }
          case 0x4025:
          case 0x4027:
          case 0x4028:
            if (this.plusStack.length < LIMIT.depth) this.plusStack.push(this.plusWorld);
            break;
          case 0x4026:
          case 0x4029:
            this.plusWorld = this.plusStack.pop() ?? ID;
            break;
        }
      } catch (e) {
        if (!(e instanceof Bad)) throw e;
      }
      o += size;
    }
    this.notes.add("emfPlusOnly");
  }
  plusDpi = 96;
  /** bytes of the optional pen data before the pen's brush (EmfPlusPenData) */
  penDataExtra(at: number, flags: number): number {
    let n = 0;
    const has = (f: number) => (flags & f) !== 0;
    const count = (k: number) => Math.min(1 << 16, this.u32(at + 12 + n)) * k;
    if (has(0x1)) n += 24;
    for (const f of [0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80]) if (has(f)) n += 4;
    if (has(0x100)) n += 4 + count(4);
    if (has(0x200)) n += 4;
    if (has(0x400)) n += 4 + count(4);
    if (has(0x800)) n += 4 + count(1);
    if (has(0x1000)) n += 4 + count(1);
    return n;
  }

  // ───────── WMF ─────────
  wmf(): { vb: [number, number, number, number]; w: number; h: number; emf?: Uint8Array } | null {
    const b = this.b;
    this.end = b.length;
    let at = 0;
    let ref: { x: number; y: number; w: number; h: number } | null = null;
    let inch = 1440;
    if (this.u32(0) === 0x9ac6cdd7) {
      const l = this.i16(6), t = this.i16(8), r = this.i16(10), bt = this.i16(12);
      inch = this.u16(14) || 1440;
      if (r !== l && bt !== t) ref = { x: Math.min(l, r), y: Math.min(t, bt), w: Math.abs(r - l), h: Math.abs(bt - t) };
      at = 22;
    }
    const hs = this.u16(at + 2);
    if (hs !== 9) return null;
    const start = at + 18;
    // embedded EMF (MFCOMMENT escapes "WMFC"): the EMF is the better picture
    const emf = this.embeddedEmf(start);
    if (emf) return { vb: [0, 0, 0, 0], w: 0, h: 0, emf };
    if (!ref) {
      // no placeable header: the first window origin / extent
      let wo: Pt = [0, 0], we: Pt | null = null;
      this.walkWmf(start, (fn, p) => {
        if (fn === 0x020b) wo = [this.i16(p + 2), this.i16(p)];
        if (fn === 0x020c && !we) we = [this.i16(p + 2), this.i16(p)];
        return !we;
      });
      const e = we as Pt | null;
      ref = e ? { x: wo[0], y: wo[1], w: e[0] || 1, h: e[1] || 1 } : { x: 0, y: 0, w: 1000, h: 1000 };
      inch = 1440;
      this.end = b.length;
    }
    this.wmfRef = { x: ref.x, y: ref.y, w: ref.w, h: ref.h };
    this.dc.wo = [ref.x, ref.y];
    this.dc.we = [ref.w, ref.h];
    this.dc.bkMode = 2;
    const objs: (Obj | null)[] = [];
    const addObj = (o: Obj) => {
      let i = objs.indexOf(null);
      if (i < 0) i = objs.length;
      if (i >= LIMIT.objects) return;
      objs[i] = o;
      this.objs.set(i, o);
    };
    this.walkWmf(start, (fn, p, size) => {
      if (fn !== 0x0213 && fn !== 0x0214) this.flush();
      try {
        this.wmfRecord(fn, p, size, addObj, objs);
      } catch (e) {
        if (!(e instanceof Bad)) throw e;
        this.notes.add("badRecord");
      }
      return !this.out.full;
    });
    this.flush();
    const w = (ref.w / inch) * 96, h = (ref.h / inch) * 96;
    return { vb: [ref.x, ref.y, ref.w, ref.h], w, h };
  }
  walkWmf(start: number, fn: (fn: number, params: number, size: number) => boolean) {
    const b = this.b;
    let o = start, count = 0;
    while (o + 6 <= b.length && count++ < LIMIT.records) {
      const size = this.dv.getUint32(o, true) * 2, func = this.dv.getUint16(o + 4, true);
      if (size < 6 || o + size > b.length) break;
      if (func === 0) break;
      this.end = o + size;
      if (!fn(func, o + 6, size)) break;
      o += size;
    }
  }
  embeddedEmf(start: number): Uint8Array | null {
    const chunks: Uint8Array[] = [];
    let total = 0, want = 0;
    this.walkWmf(start, (fn, p) => {
      if (fn !== 0x0626) return true;
      if (this.end - p < 38 || this.u16(p) !== 0x000f || this.u32(p + 4) !== 0x43464d57 || this.u32(p + 8) !== 1) return true;
      const cur = this.u32(p + 26), size = this.u32(p + 34);
      want = size;
      const at = p + 38;
      const n = Math.min(cur, this.end - at);
      if (n <= 0 || total + n > (64 << 20)) return false;
      chunks.push(this.b.subarray(at, at + n));
      total += n;
      return true;
    });
    this.end = this.b.length;
    if (!chunks.length || total < 88 || (want && total < want)) return null;
    const out = new Uint8Array(total);
    let k = 0;
    for (const c of chunks) {
      out.set(c, k);
      k += c.length;
    }
    return metafileKind(out) === "emf" ? out : null;
  }

  wmfRecord(fn: number, p: number, size: number, addObj: (o: Obj) => void, objs: (Obj | null)[]) {
    const s = this.dc;
    const w = (i: number) => this.i16(p + i * 2);
    const uw = (i: number) => this.u16(p + i * 2);
    const end = p - 6 + size;
    switch (fn) {
      case 0x0201:
        s.bk = colorref(this.u32(p));
        break;
      case 0x0102:
        s.bkMode = uw(0);
        break;
      case 0x0103:
        s.mapMode = uw(0);
        break;
      case 0x0106:
        s.fill = uw(0);
        break;
      case 0x0209:
        s.text = colorref(this.u32(p));
        break;
      case 0x012e:
        s.align = uw(0);
        break;
      case 0x020b:
        s.wo = [w(1), w(0)];
        break;
      case 0x020c:
        s.we = [w(1), w(0)];
        break;
      case 0x020f:
        s.wo = [s.wo[0] + w(1), s.wo[1] + w(0)];
        break;
      case 0x0410: {
        const yd = w(0), yn = w(1), xd = w(2), xn = w(3);
        s.we = [xd ? (s.we[0] * xn) / xd : s.we[0], yd ? (s.we[1] * yn) / yd : s.we[1]];
        break;
      }
      case 0x0213:
        this.lineTo(w(1), w(0));
        break;
      case 0x0214:
        this.moveTo(w(1), w(0));
        break;
      case 0x0415:
      case 0x0416:
        this.clipWith(this.rect(w(3), w(2), w(1), w(0)), "nonzero", fn === 0x0416 ? 1 : 4);
        break;
      case 0x0817:
      case 0x081a:
      case 0x0830: {
        const a = this.arcOf(w(7), w(6), w(5), w(4), [w(3), w(2)], [w(1), w(0)]);
        let d = this.arcD(a.cx, a.cy, a.rx, a.ry, a.t0, a.sw, "M");
        if (fn === 0x0830) d += "Z";
        if (fn === 0x081a) d += `L${this.P(this.mat(), a.cx, a.cy)}Z`;
        this.shape(d, fn !== 0x0817, true);
        break;
      }
      case 0x0418:
        this.shape(this.ellipse(w(3), w(2), w(1), w(0)), true, true);
        break;
      case 0x041b:
        this.shape(this.rect(w(3), w(2), w(1), w(0)), true, true);
        break;
      case 0x061c:
        this.shape(this.roundRect(w(5), w(4), w(3), w(2), w(1), w(0)), true, true);
        break;
      case 0x061d:
        this.patBlt(w(5), w(4), w(3), w(2), this.u32(p));
        break;
      case 0x001e:
        this.save();
        break;
      case 0x0127:
        this.restore(w(0));
        break;
      case 0x041f: {
        const [dx, dy] = this.dev(this.mat(), w(3), w(2));
        this.out.add(`<rect x="${N(dx)}" y="${N(dy)}" width="1" height="1" fill="${colorref(this.u32(p))}"/>`, s.clip);
        break;
      }
      case 0x0521: {
        const n = uw(0);
        this.chk(p + 2, n);
        const str = decodeAnsi(this.b.subarray(p + 2, p + 2 + n), s.font.charset);
        const q = p + 2 + n + (n & 1);
        this.text(this.i16(q + 2), this.i16(q), str, null, 0, null);
        break;
      }
      case 0x0a32: {
        const y = w(0), x = w(1), n = uw(2), opts = uw(3);
        let at = p + 8;
        let rect: [number, number, number, number] | null = null;
        if (opts & 6) {
          rect = [this.i16(at), this.i16(at + 2), this.i16(at + 4), this.i16(at + 6)];
          at += 8;
        }
        this.chk(at, n);
        const str = decodeAnsi(this.b.subarray(at, at + n), s.font.charset);
        at += n + (n & 1);
        let dx: number[] | null = null;
        if (at + n * 2 <= end) {
          // one advance per byte: double-byte characters have two (the second is 0 or the rest)
          const raw: number[] = [];
          for (let i = 0; i < n; i++) raw.push(this.i16(at + i * 2));
          if (str.length === n) dx = raw;
          else {
            // a double-byte code page: a character beyond ASCII took two bytes, so it sums their two advances
            const dbcs = [128, 129, 130, 134, 136].includes(s.font.charset);
            dx = [];
            let k = 0;
            for (const ch of Array.from(str)) {
              const len = Math.max(1, Math.min(2, n - k, ch.codePointAt(0)! > 0x7f && dbcs ? 2 : 1));
              let a = 0;
              for (let j = 0; j < len; j++) a += raw[k + j] ?? 0;
              k += len;
              dx.push(a);
              if (ch.length > 1) dx.push(0);
            }
          }
        }
        this.text(x, y, str, dx, opts, rect);
        break;
      }
      case 0x0324:
      case 0x0325: {
        const n = uw(0);
        const pts = this.pts(p + 2, n, true);
        this.shape(this.poly(pts, fn === 0x0324), fn === 0x0324, true);
        break;
      }
      case 0x0538: {
        const n = uw(0);
        if (n > (size - 8) / 2) throw BAD;
        const counts: number[] = [];
        for (let i = 0; i < n; i++) counts.push(uw(1 + i));
        let at = p + 2 + n * 2, d = "";
        for (const c of counts) {
          d += this.poly(this.pts(at, c, true), true);
          at += c * 4;
        }
        this.shape(d, true, true);
        break;
      }
      case 0x012d: {
        const o = objs[uw(0)];
        if (!o) break;
        if (o.k === "pen") s.pen = o;
        else if (o.k === "brush") s.brush = o;
        else if (o.k === "font") s.font = o;
        break;
      }
      case 0x01f0: {
        const i = uw(0);
        if (i < objs.length) objs[i] = null;
        break;
      }
      case 0x02fa: {
        const st = uw(0), wd = Math.abs(w(1));
        addObj({ k: "pen", style: st, width: wd, cosmetic: wd === 0, color: colorref(this.u32(p + 6)) });
        break;
      }
      case 0x02fc: {
        const st = uw(0);
        addObj({ k: "brush", style: st === 3 || st === 5 || st === 6 ? 0 : st, color: colorref(this.u32(p + 2)), hatch: uw(3) });
        break;
      }
      case 0x02fb: {
        const charset = this.u8(p + 13);
        let n = 0;
        while (n < 32 && p + 18 + n < end && this.b[p + 18 + n]) n++;
        const face = decodeAnsi(this.b.subarray(p + 18, p + 18 + n), charset === 2 ? 0 : charset);
        addObj({ k: "font", h: w(0), w: w(1), esc: w(2), weight: w(4), italic: !!this.u8(p + 10), under: !!this.u8(p + 11), strike: !!this.u8(p + 12), charset, pitch: this.u8(p + 17), face });
        break;
      }
      case 0x0142: {
        const img = uw(1) === 0 ? this.wmfDib(p + 4, end) : null;
        addObj(img ? { k: "brush", style: 5, color: "#808080", hatch: 0, img } : brush("#808080"));
        break;
      }
      case 0x01f9:
        addObj(brush("#808080"));
        break;
      case 0x00f7:
        addObj({ k: "other" });
        break;
      case 0x06ff:
        addObj({ k: "rgn", d: this.wmfRegion(p, end) });
        break;
      case 0x012c: {
        const o = objs[uw(0)];
        if (o?.k === "rgn") this.clipWith(o.d, "nonzero", 5);
        else s.clip = [];
        break;
      }
      case 0x0228:
      case 0x012b: {
        const r = objs[uw(0)];
        const br = fn === 0x0228 ? objs[uw(1)] : s.brush;
        if (r?.k === "rgn" && br?.k === "brush") {
          const f = this.fillAttr(br);
          if (f && r.d) this.out.add(`<path d="${r.d}" fill="${f}"/>`, s.clip);
        }
        break;
      }
      case 0x0f43: {
        const rop = this.u32(p), usage = uw(2);
        const sh = w(3), sw = w(4), sy = w(5), sx = w(6), dh = w(7), dw = w(8), dy = w(9), dx = w(10);
        const img = usage === 0 ? this.wmfDib(p + 22, end) : null;
        if (img) this.blit(img, dx, dy, dw, dh, sx, sy, sw, sh, rop, true);
        break;
      }
      case 0x0b41:
      case 0x0940: {
        const rop = this.u32(p);
        const noBitmap = size / 2 === (fn >> 8) + 3;
        if (fn === 0x0b41) {
          if (noBitmap) {
            this.patBlt(w(10), w(9), w(8), w(7), rop);
            break;
          }
          const sh = w(2), sw = w(3), sy = w(4), sx = w(5), dh = w(6), dw = w(7), dy = w(8), dx = w(9);
          const img = this.wmfDib(p + 20, end);
          if (img) this.blit(img, dx, dy, dw, dh, sx, sy, sw, sh, rop, false);
        } else {
          if (noBitmap) {
            this.patBlt(w(8), w(7), w(6), w(5), rop);
            break;
          }
          const sy = w(2), sx = w(3), h = w(4), wd = w(5), dy = w(6), dx = w(7);
          const img = this.wmfDib(p + 16, end);
          if (img) this.blit(img, dx, dy, wd, h, sx, sy, wd, h, rop, false);
        }
        break;
      }
      case 0x0d33: {
        const usage = uw(0);
        const sy = w(3), sx = w(4), h = w(5), wd = w(6), dy = w(7), dx = w(8);
        const img = usage === 0 ? this.wmfDib(p + 18, end) : null;
        if (img) this.blit(img, dx, dy, wd, h, sx, sy, wd, h, 0xcc0020, true);
        break;
      }
      case 0x0922:
      case 0x0b23:
        this.notes.add("oldBitmap");
        break;
    }
  }
  /** a DIB from `at` to the end of the record (WMF keeps header, colours and bits together) */
  wmfDib(at: number, end: number): Img | null {
    const hs = this.u32(at);
    if (hs !== 12 && (hs < 40 || hs > 124)) return null;
    const bpp = hs >= 40 ? this.u16(at + 14) : this.u16(at + 10);
    const comp = hs >= 40 ? this.u32(at + 16) : 0;
    const used = hs >= 40 ? this.u32(at + 32) : 0;
    const pal = bpp <= 8 ? Math.min(256, used || 1 << bpp) * (hs === 12 ? 3 : 4) : used * 4 + (hs === 40 && comp === 3 ? 12 : 0);
    if (at + hs + pal > end) return null;
    return this.dib(at, hs + pal, at + hs + pal, end - at - hs - pal, true);
  }
  /** a WMF Region object → device path of its scan rectangles */
  wmfRegion(p: number, end: number): string {
    // nextInChain, objectType, objectCount, regionSize, scanCount, maxScan, bounding rect, scans
    const scans = this.i16(p + 12);
    const m = this.mat();
    let at = p + 22, d = "";
    for (let i = 0; i < scans && at + 6 <= end; i++) {
      const cnt = this.u16(at), top = this.i16(at + 2), bot = this.i16(at + 4);
      if (cnt > 1000) break;
      at += 6;
      for (let j = 0; j + 1 < cnt; j += 2) {
        const l = this.i16(at), r = this.i16(at + 2);
        at += 4;
        d += `M${this.P(m, l, top)}L${this.P(m, r, top)}L${this.P(m, r, bot)}L${this.P(m, l, bot)}Z`;
      }
      at += 2;
    }
    return d;
  }

  svg(vb: [number, number, number, number], w: number, h: number): string {
    this.out.end();
    const body = this.out.parts.join("");
    const defs = this.out.defs.length ? `<defs>${this.out.defs.join("")}</defs>` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${N(Math.max(1, w))}" height="${N(Math.max(1, h))}" viewBox="${N(vb[0])} ${N(vb[1])} ${N(vb[2] || 1)} ${N(vb[3] || 1)}" preserveAspectRatio="none" overflow="hidden">${defs}${body}</svg>`;
  }
}

/** matrix entries keep more digits (a small scale times a big coordinate) */
function N6(v: number): string {
  if (!isFinite(v)) return "0";
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? "0" : String(r);
}

/** An EMF or WMF picture as SVG (null when the bytes are not a metafile or its header is unusable). */
export function metafileToSvg(bytes: Uint8Array): MetafileSvg | null {
  const kind = metafileKind(bytes);
  if (!kind) return null;
  try {
    const pl = new Player(bytes);
    if (kind === "emf") {
      const r = pl.emf();
      if (!r) return null;
      if (pl.out.full) pl.notes.add("truncated");
      return { svg: pl.svg(r.vb, r.w, r.h), width: r.w, height: r.h, kind, notes: [...pl.notes] };
    }
    const r = pl.wmf();
    if (!r) return null;
    if (r.emf) {
      const inner = metafileToSvg(r.emf);
      if (inner) return { ...inner, kind: "wmf" };
      return null;
    }
    if (pl.out.full) pl.notes.add("truncated");
    return { svg: pl.svg(r.vb, r.w, r.h), width: r.w, height: r.h, kind, notes: [...pl.notes] };
  } catch (e) {
    if (e instanceof Bad) return null;
    throw e;
  }
}
