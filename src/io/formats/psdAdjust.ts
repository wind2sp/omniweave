// Adjustment-layer settings from a PSD layer record's additional-info blocks (Adobe Photoshop File Formats
// Specification, "Adjustment layer" keys) into core/image/adjustLayer.ts settings. The blocks themselves are kept
// byte for byte on save (psdWrite); this only reads them so the layer can be drawn.

import type { Adjustment, Hsl3, LevelsChannel } from "../../core/image/adjustLayer";
import { parseDescAt, type Desc, type DVal } from "./psdFx";

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const i16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const f32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0);

function num(d: Desc, key: string, dflt = 0): number {
  const v = d.items.find((i) => i[0] === key)?.[1];
  return v && (v.t === "long" || v.t === "doub" || v.t === "UntF") ? v.v : dflt;
}
function bool(d: Desc, key: string): boolean {
  const v = d.items.find((i) => i[0] === key)?.[1];
  return !!v && v.t === "bool" && v.v;
}
function obj(d: Desc, key: string): Desc | null {
  const v: DVal | undefined = d.items.find((i) => i[0] === key)?.[1];
  return v && (v.t === "Objc" || v.t === "GlbO") ? v.v : null;
}

/** Curves points: [input, output] from the file's (output, input) pairs. */
function readPoints(b: Uint8Array, o: number, end: number): { pts: [number, number][]; next: number } | null {
  if (o + 2 > end) return null;
  const n = u16(b, o);
  if (n > 64 || o + 2 + n * 4 > end) return null;
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) pts.push([u16(b, o + 2 + k * 4 + 2), u16(b, o + 2 + k * 4)]);
  return { pts, next: o + 2 + n * 4 };
}

function curves(b: Uint8Array): Adjustment | null {
  // pad (1), version (2), channel bitmap (4), then one point list per set bit; then optionally '8BIM' 'Crv ' with
  // version, count and (channel index, point list) — the fuller list, used when present
  if (b.length < 7) return null;
  let o = 7;
  const bits = u32(b, 3);
  const ch: { channel: number; pts: [number, number][] }[] = [];
  for (let c = 0; c < 32 && o < b.length; c++) {
    if (!(bits & (1 << c))) continue;
    const p = readPoints(b, o, b.length);
    if (!p) break;
    ch.push({ channel: c, pts: p.pts });
    o = p.next;
  }
  const at = indexOfSig(b, "Crv ", o);
  if (at >= 0 && at + 10 <= b.length) {
    const n = u32(b, at + 6);
    const extra: typeof ch = [];
    let q = at + 10;
    for (let k = 0; k < n && q + 2 <= b.length; k++) {
      const c = u16(b, q);
      const p = readPoints(b, q + 2, b.length);
      if (!p) break;
      extra.push({ channel: c, pts: p.pts });
      q = p.next;
    }
    if (extra.length || !ch.length) return { kind: "curves", ch: extra };
  }
  return { kind: "curves", ch };
}

function indexOfSig(b: Uint8Array, sig: string, from: number): number {
  for (let i = Math.max(0, from); i + 4 <= b.length; i++) if (b[i] === sig.charCodeAt(0) && b[i + 1] === sig.charCodeAt(1) && b[i + 2] === sig.charCodeAt(2) && b[i + 3] === sig.charCodeAt(3)) return i;
  return -1;
}

function levels(b: Uint8Array, mode: number): Adjustment | null {
  // version (2), then 29 sets of (input floor, input ceiling, output floor, output ceiling, gamma × 100); the first
  // four are composite, red, green, blue (CMYK: five — composite, cyan, magenta, yellow, black)
  if (b.length < 2 + 10) return null;
  const ch: LevelsChannel[] = [];
  for (let k = 0; k < (mode === 4 ? 5 : 4) && 2 + (k + 1) * 10 <= b.length; k++) {
    const o = 2 + k * 10;
    ch.push({ inLo: u16(b, o), inHi: u16(b, o + 2), outLo: u16(b, o + 4), outHi: u16(b, o + 6), gamma: u16(b, o + 8) / 100 || 1 });
  }
  return { kind: "levels", ch };
}

function hueSat(b: Uint8Array): Adjustment | null {
  // version 2: colorize (1), pad (1), colorize H S L, master H S L, then 6 ranges of 4 range values + H S L
  if (b.length < 16 || u16(b, 0) !== 2) return null;
  const hsl = (o: number): Hsl3 => [i16(b, o), i16(b, o + 2), i16(b, o + 4)];
  const ranges: { range: [number, number, number, number]; hsl: Hsl3 }[] = [];
  for (let k = 0; k < 6 && 16 + (k + 1) * 14 <= b.length; k++) {
    const o = 16 + k * 14;
    ranges.push({ range: [i16(b, o), i16(b, o + 2), i16(b, o + 4), i16(b, o + 6)], hsl: hsl(o + 8) });
  }
  return { kind: "hueSat", colorize: b[2] !== 0, colorizeHsl: hsl(4), master: hsl(10), ranges };
}

function colorBalance(b: Uint8Array): Adjustment | null {
  if (b.length < 19) return null;
  const t = (o: number): Hsl3 => [i16(b, o), i16(b, o + 2), i16(b, o + 4)];
  return { kind: "colorBalance", shadows: t(0), midtones: t(6), highlights: t(12), preserveLum: b[18] !== 0 };
}

function brightness(blocks: Map<string, Uint8Array>): Adjustment | null {
  const cg = blocks.get("CgEd");
  if (cg) {
    try {
      const d = parseDescAt(cg);
      return { kind: "brightness", brightness: num(d, "Brgh"), contrast: num(d, "Cntr"), legacy: bool(d, "useLegacy") };
    } catch {
      /* fall back to brit */
    }
  }
  const b = blocks.get("brit");
  if (!b || b.length < 4) return null;
  return { kind: "brightness", brightness: i16(b, 0), contrast: i16(b, 2), legacy: true };
}

function blackWhite(b: Uint8Array): Adjustment | null {
  const d = parseDescAt(b);
  const tc = bool(d, "useTint") ? obj(d, "tintColor") : null;
  return {
    kind: "blackWhite",
    red: num(d, "Rd  ", 40),
    yellow: num(d, "Yllw", 60),
    green: num(d, "Grn ", 40),
    cyan: num(d, "Cyn ", 60),
    blue: num(d, "Bl  ", 20),
    magenta: num(d, "Mgnt", 80),
    // (Photoshop stores the colour as doubles a hair off whole levels: 225.0000018)
    tint: tc ? [Math.round(num(tc, "Rd  ") * 1000) / 1000, Math.round(num(tc, "Grn ") * 1000) / 1000, Math.round(num(tc, "Bl  ") * 1000) / 1000] : null,
  };
}

function selectiveColor(b: Uint8Array): Adjustment | null {
  // version (2), method (2: 0 relative, 1 absolute), 10 records of cyan, magenta, yellow, black (−100..100); the first
  // record is unused, then reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks
  if (b.length < 4 + 80) return null;
  const ranges: [number, number, number, number][] = [];
  for (let k = 1; k < 10; k++) {
    const o = 4 + k * 8;
    ranges.push([i16(b, o), i16(b, o + 2), i16(b, o + 4), i16(b, o + 6)]);
  }
  return { kind: "selectiveColor", absolute: u16(b, 2) === 1, ranges };
}

function channelMixer(b: Uint8Array, mode: number): Adjustment | null {
  // version (2), monochrome (2), then per output channel (red, green, blue, [4th: CMYK]) five values: the red,
  // green, blue (, black) weights and the constant, in percent
  if (b.length < 4 + 30) return null;
  const rows: [number, number, number, number][] = [];
  for (let k = 0; k < 3; k++) {
    const o = 4 + k * 10;
    rows.push([i16(b, o), i16(b, o + 2), i16(b, o + 4), i16(b, o + 8)]);
  }
  const a: Adjustment = { kind: "channelMixer", mono: u16(b, 2) !== 0, rows };
  if (mode === 4 && b.length >= 4 + 40) {
    // CMYK: outputs cyan, magenta, yellow, black, each weighing the four inks
    a.ink = [0, 1, 2, 3].map((k) => [0, 1, 2, 3, 4].map((j) => i16(b, 4 + k * 10 + j * 2)) as [number, number, number, number, number]);
    // monochrome: the grey of the first output row in the black ink alone, no cyan, magenta or yellow
    // (omni-fid-cmyk-adj-mixer-mono, made with four different rows)
    if (a.mono) a.ink = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], a.ink[0]];
  }
  return a;
}

const GRADIENT_METHODS: Record<string, string> = { Gcls: "classic", "Lnr ": "linear", Smoo: "smooth", Prcp: "perceptual", Stps: "stripes" };

function gradientMap(b: Uint8Array): Adjustment | null {
  // version (2: 1 or 3), reverse (1), dither (1), [3: interpolation method key (4)], name (Unicode), colour stops
  // (location 0..4096, midpoint %, colour space, 4 × 16-bit colour, 2 unused), opacity stops, then the classic
  // gradient's smoothness (0..4096) among the trailing fields
  const ver = u16(b, 0);
  if (ver !== 1 && ver !== 3) return null;
  let o = 4;
  let method = "classic";
  if (ver === 3) {
    method = GRADIENT_METHODS[String.fromCharCode(b[4], b[5], b[6], b[7])] ?? "classic";
    o = 8;
  }
  if (o + 4 > b.length) return null;
  o += 4 + u32(b, o) * 2;
  if (o + 2 > b.length) return null;
  const n = u16(b, o);
  o += 2;
  if (n < 1 || n > 256 || o + n * 20 + 2 > b.length) return null;
  const stops: { at: number; mid: number; rgb: [number, number, number]; ink?: [number, number, number, number] }[] = [];
  for (let k = 0; k < n; k++, o += 20) {
    const space = u16(b, o + 8);
    const c = [u16(b, o + 10), u16(b, o + 12), u16(b, o + 14)];
    let rgb: [number, number, number];
    let ink: [number, number, number, number] | undefined;
    if (space === 0) rgb = [c[0] / 257, c[1] / 257, c[2] / 257];
    else if (space === 2) {
      // CMYK (a CMYK document's stops): stored values, 65535 = no ink — the CMYK compositor mixes these; the RGB is
      // the colour as RGB (stored value × black) for anything else
      ink = [c[0] / 257, c[1] / 257, c[2] / 257, u16(b, o + 16) / 257];
      rgb = [(ink[0] * ink[3]) / 255, (ink[1] * ink[3]) / 255, (ink[2] * ink[3]) / 255];
    }
    else if (space === 8) rgb = [(c[0] * 255) / 10000, (c[0] * 255) / 10000, (c[0] * 255) / 10000];
    else if (space === 7) rgb = labToSrgb(c[0] / 100, ((c[1] << 16) >> 16) / 100, ((c[2] << 16) >> 16) / 100);
    else return null;
    stops.push({ at: Math.min(1, u32(b, o) / 4096), mid: Math.min(1, Math.max(0, u32(b, o + 4) / 100)), rgb, ...(ink ? { ink } : {}) });
  }
  const nt = u16(b, o);
  o += 2 + nt * 10;
  // expansion count (2), smoothness (2)
  const smooth = o + 4 <= b.length ? Math.min(1, u16(b, o + 2) / 4096) : 1;
  stops.sort((p, q) => p.at - q.at);
  return { kind: "gradientMap", stops, smooth, method, reverse: b[2] !== 0 };
}

/** CIE Lab (D50, Photoshop's) → sRGB 0..255 through Bradford-adapted D65. */
export function labToSrgb(L: number, a: number, bb: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
  const f = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
  const X = 0.9642 * f(fx), Y = f(fy), Z = 0.8249 * f(fz);
  // XYZ D50 → linear sRGB (Bradford-adapted matrix)
  const r = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const g = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const b = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  const enc = (c: number) => 255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  return [enc(r), enc(g), enc(b)];
}

function photoFilter(b: Uint8Array): Adjustment | null {
  // version (2) = 2: colour space (2) + 4 × 16-bit colour; density % (4), preserve luminosity (1)
  if (b.length < 17 || u16(b, 0) !== 2) return null;
  const space = u16(b, 2);
  let rgb: [number, number, number];
  if (space === 7) rgb = labToSrgb(u16(b, 4) / 100, i16(b, 6) / 100, i16(b, 8) / 100);
  else if (space === 0) rgb = [u16(b, 4) / 257, u16(b, 6) / 257, u16(b, 8) / 257];
  else return null;
  return { kind: "photoFilter", rgb, density: u32(b, 12), preserveLum: b[16] !== 0 };
}

/** A curve of an ICC lut8 / lut16: `n` samples of 1 or 2 bytes at o → 0..1. */
function iccCurve(b: Uint8Array, o: number, n: number, bytes: number): Float32Array {
  const c = new Float32Array(n);
  for (let k = 0; k < n; k++) c[k] = bytes === 2 ? u16(b, o + k * 2) / 65535 : b[o + k] / 255;
  return c;
}

/** The A2B0 table of an RGB → RGB ICC device link (lut8Type / lut16Type); null for anything else. */
export function iccLookup(p: Uint8Array): Extract<Adjustment, { kind: "colorLookup" }> | null {
  if (p.length < 132 || String.fromCharCode(p[16], p[17], p[18], p[19]) !== "RGB " || String.fromCharCode(p[20], p[21], p[22], p[23]) !== "RGB ") return null;
  const count = u32(p, 128);
  for (let k = 0; k < count && 132 + k * 12 + 12 <= p.length; k++) {
    const e = 132 + k * 12;
    if (String.fromCharCode(p[e], p[e + 1], p[e + 2], p[e + 3]) !== "A2B0") continue;
    const o = u32(p, e + 4), size = u32(p, e + 8);
    if (o + size > p.length || size < 48) return null;
    const type = String.fromCharCode(p[o], p[o + 1], p[o + 2], p[o + 3]);
    if ((type !== "mft2" && type !== "mft1") || p[o + 8] !== 3 || p[o + 9] !== 3) return null;
    const n = p[o + 10];
    if (n < 2) return null;
    const bytes = type === "mft2" ? 2 : 1;
    let q = o + 48;
    let nin = 256, nout = 256;
    if (type === "mft2") {
      nin = u16(p, o + 48);
      nout = u16(p, o + 50);
      q = o + 52;
    }
    if (nin < 2 || nout < 2 || q + (3 * nin + n * n * n * 3 + 3 * nout) * bytes > o + size) return null;
    const inCurves = [0, 1, 2].map((c) => iccCurve(p, q + c * nin * bytes, nin, bytes));
    q += 3 * nin * bytes;
    const table = new Float32Array(n * n * n * 3);
    for (let i = 0; i < table.length; i++) table[i] = bytes === 2 ? u16(p, q + i * 2) / 65535 : p[q + i] / 255;
    q += table.length * bytes;
    const outCurves = [0, 1, 2].map((c) => iccCurve(p, q + c * nout * bytes, nout, bytes));
    return { kind: "colorLookup", n, table, inCurves, outCurves };
  }
  return null;
}

function colorLookup(b: Uint8Array): Adjustment | null {
  // version (2), descriptor: the table as an ICC device link ('profile'), plus the LUT file it came from
  const d = parseDescAt(b, 2);
  const v = d.items.find((i) => i[0] === "profile")?.[1];
  if (!v || v.t !== "raw") return null;
  // (raw descriptor data starts with its own length)
  const p = v.bytes.length >= 4 && u32(v.bytes, 0) === v.bytes.length - 4 ? v.bytes.subarray(4) : v.bytes;
  return iccLookup(p);
}

/** Keys of adjustment blocks this reader understands, in the order they are tried. */
const READERS: [string, (b: Uint8Array, all: Map<string, Uint8Array>, mode: number) => Adjustment | null][] = [
  ["nvrt", () => ({ kind: "invert" })],
  ["thrs", (b) => (b.length >= 2 ? { kind: "threshold", level: u16(b, 0) } : null)],
  ["post", (b) => (b.length >= 2 ? { kind: "posterize", levels: u16(b, 0) } : null)],
  ["levl", (b, _all, mode) => levels(b, mode)],
  ["curv", curves],
  ["CgEd", (_b, all) => brightness(all)],
  ["brit", (_b, all) => brightness(all)],
  ["hue2", hueSat],
  ["blnc", colorBalance],
  ["blwh", blackWhite],
  ["selc", selectiveColor],
  ["mixr", (b, _all, mode) => channelMixer(b, mode)],
  ["grdm", gradientMap],
  ["phfl", photoFilter],
  ["vibA", (b) => {
    const d = parseDescAt(b);
    return { kind: "vibrance", vibrance: num(d, "vibrance"), saturation: num(d, "Strt") };
  }],
  ["clrL", colorLookup],
  ["expA", (b) => (b.length >= 14 ? { kind: "exposure", exposure: f32(b, 2), offset: f32(b, 6), gamma: f32(b, 10) } : null)],
];

/**
 * The adjustment of a layer record from its blocks (key → data). A kind we do not read, or a block that does not
 * parse, gives `{ kind: "other" }` (drawn as no change, kept on save); null when the record is no adjustment layer.
 */
export function readAdjustment(blocks: Map<string, Uint8Array>, adjustmentKeys: ReadonlySet<string>, mode = 3): Adjustment | null {
  for (const [key, read] of READERS) {
    const b = blocks.get(key);
    if (!b) continue;
    try {
      const a = read(b, blocks, mode);
      if (a) return forMode(a, mode) ?? { kind: "other", key };
    } catch {
      /* unreadable: drawn as no change */
    }
    return { kind: "other", key };
  }
  for (const k of blocks.keys()) if (adjustmentKeys.has(k)) return { kind: "other", key: k };
  return null;
}

/**
 * The settings for the document's colour mode (PSD header: 1 grayscale, 3 RGB, 4 CMYK, 8 duotone …). A grayscale document holds
 * only grey, so a channel mixer there is its grey output alone (the first row; the other rows keep RGB defaults) and a
 * gradient map's stops are their luminosity (0.3 / 0.59 / 0.11). A CMYK mixer weighs inks (C, M, Y, K): drawn from
 * its ink rows by the CMYK compositor (core/image/cmykComposite.ts), null without them (kept on save, no change).
 */
function forMode(a: Adjustment, mode: number): Adjustment | null {
  const gray = mode === 1 || mode === 8;
  if (a.kind === "channelMixer") {
    if (mode === 4) return a.ink ? a : null;
    if (gray) return { ...a, mono: true };
  }
  if (a.kind === "gradientMap" && gray)
    return { ...a, stops: a.stops.map((s) => ({ ...s, rgb: Array(3).fill(0.3 * s.rgb[0] + 0.59 * s.rgb[1] + 0.11 * s.rgb[2]) as [number, number, number] })) };
  return a;
}
