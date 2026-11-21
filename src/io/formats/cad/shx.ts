// AutoCAD compiled shape fonts (.shx) read from the user's own installation — never bundled (Autodesk's SHX files are
// copyrighted; docs/legal/IP_CHECKLIST.md). Written from the public description of the shape-definition language in
// AutoCAD's customization guide (vector length/direction bytes, special codes 0–14) and the three compiled layouts
// ("shapes", "unifont", "bigfont"); no other program's code was used.
//
// A shape is interpreted into centre-line strokes in shape units; the font's "above" value is its cap height. Glyphs
// are turned into a TrueType face by strokeFont.ts (`shapeFontTtf`) so drawing text stays editable text.

export type ShxPt = [number, number];
export interface ShxGlyph {
  /** pen position after the shape (the advance), shape units */
  adv: number;
  strokes: ShxPt[][];
}

export interface ShxFont {
  kind: "shapes" | "unifont" | "bigfont";
  /** lower-case file name without .shx */
  name: string;
  /** cap height (shape units): text height maps onto it */
  above: number;
  below: number;
  /** shape number → definition bytes (without the name) */
  defs: Map<number, Uint8Array>;
  /** bigfont: lead-byte ranges */
  ranges?: [number, number][];
  cache: Map<number, ShxGlyph | null>;
}

const HEAD = "AutoCAD-86 ";
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s8 = (v: number) => (v > 127 ? v - 256 : v);

/** definition bytes after the shape's name (a 0-terminated string) */
function body(d: Uint8Array): Uint8Array {
  const z = d.indexOf(0);
  return z < 0 ? d : d.subarray(z + 1);
}

/** Parse an .shx file; null when it is not a compiled shape font this reader knows. */
export function parseShx(bytes: Uint8Array, name = ""): ShxFont | null {
  let i = 0;
  while (i < Math.min(bytes.length, 64) && bytes[i] !== 0x1a) i++;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, i));
  if (!head.startsWith(HEAD) || i >= bytes.length) return null;
  const kind = /unifont/i.test(head) ? "unifont" : /bigfont/i.test(head) ? "bigfont" : /shapes/i.test(head) ? "shapes" : null;
  if (!kind) return null;
  let p = i + 1;
  const defs = new Map<number, Uint8Array>();
  const font: ShxFont = { kind, name: name.toLowerCase().replace(/\.shx$/i, ""), above: 0, below: 0, defs, cache: new Map() };
  try {
    if (kind === "shapes") {
      const n = u16(bytes, p + 4);
      p += 6;
      const idx: [number, number][] = [];
      for (let k = 0; k < n; k++, p += 4) idx.push([u16(bytes, p), u16(bytes, p + 2)]);
      for (const [code, len] of idx) {
        if (p + len > bytes.length) break;
        defs.set(code, body(bytes.subarray(p, p + len)));
        p += len;
      }
    } else if (kind === "unifont") {
      const n = u32(bytes, p);
      const len0 = u16(bytes, p + 4);
      p += 6;
      defs.set(0, body(bytes.subarray(p, p + len0)));
      p += len0;
      for (let k = 1; k < n && p + 4 <= bytes.length; k++) {
        const code = u16(bytes, p), len = u16(bytes, p + 2);
        p += 4;
        if (p + len > bytes.length) break;
        defs.set(code, body(bytes.subarray(p, p + len)));
        p += len;
      }
    } else {
      const n = u16(bytes, p + 2), nr = u16(bytes, p + 4);
      p += 6;
      font.ranges = [];
      for (let k = 0; k < nr; k++, p += 4) font.ranges.push([u16(bytes, p), u16(bytes, p + 2)]);
      for (let k = 0; k < n && p + 8 <= bytes.length; k++, p += 8) {
        const code = u16(bytes, p), len = u16(bytes, p + 2), off = u32(bytes, p + 4);
        if (!len || off + len > bytes.length || (code === 0 && defs.has(0))) continue;
        defs.set(code, body(bytes.subarray(off, off + len)));
      }
    }
  } catch {
    return null;
  }
  const info = defs.get(0);
  if (!info || info.length < 2) return null;
  // font info: above, below, modes … (bigfont: height, 0, modes, width)
  // (some big fonts end the name with two zero bytes)
  const at = kind === "bigfont" && info[0] === 0 && info.length > 2 ? 1 : 0;
  font.above = info[at];
  font.below = kind === "bigfont" ? 0 : info[at + 1];
  if (!font.above) return null;
  if (kind === "bigfont") {
    // the drawn cell is what sets the size: a big font whose glyphs scale themselves down (gbcbig's set-up shape)
    // keeps a nominal height far above its glyphs — then the usual advance (a square cell) stands for the height
    const advs: number[] = [];
    for (const code of [...defs.keys()].filter((c) => c > 0xff).slice(40, 80)) {
      const g = shxGlyph(font, code);
      if (g && g.adv > 0) advs.push(g.adv);
    }
    advs.sort((a, b) => a - b);
    const cell = advs[advs.length >> 1];
    if (cell && cell < font.above * 0.5) font.above = cell;
    font.cache.clear();
  }
  return font;
}

/** the 16 standard vector directions (east first, counter-clockwise) */
const DIRS: ShxPt[] = [
  [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [-0.5, 1], [-1, 1], [-1, 0.5],
  [-1, 0], [-1, -0.5], [-1, -1], [-0.5, -1], [0, -1], [0.5, -1], [1, -1], [1, -0.5],
];

/** Interpret shape `code` of `font` into strokes; null when the font has no such shape. */
export function shxGlyph(font: ShxFont, code: number): ShxGlyph | null {
  if (font.cache.has(code)) return font.cache.get(code)!;
  const d = font.defs.get(code);
  let g: ShxGlyph | null = null;
  if (d && code !== 0) {
    const strokes: ShxPt[][] = [];
    const st = { x: 0, y: 0, down: true, cur: null as ShxPt[] | null, scale: 1, stack: [] as [number, number][] };
    budget = MAX_STEPS;
    points = MAX_POINTS;
    run(font, d, st, strokes, 0);
    // (a broken or hostile file: coordinates that are not numbers, or far outside any cell, are dropped)
    const ok = (s: ShxPt[]) => s.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= LIMIT && Math.abs(y) <= LIMIT);
    const adv = Number.isFinite(st.x) ? Math.max(-LIMIT, Math.min(LIMIT, st.x)) : 0;
    g = { adv, strokes: strokes.filter((s) => (s.length > 1 || (s.length === 1 && st.down)) && ok(s)) };
  }
  font.cache.set(code, g);
  return g;
}

/**
 * Bounds on one glyph (a damaged or hostile file — subshapes calling each other many times over, scale bytes multiplied
 * up — must not hang or fill memory): commands interpreted, points kept, and coordinates (shape units).
 */
const MAX_STEPS = 200_000;
const MAX_POINTS = 20_000;
const LIMIT = 1e5;
let budget = 0;
let points = 0;

interface Pen {
  x: number;
  y: number;
  down: boolean;
  cur: ShxPt[] | null;
  scale: number;
  stack: [number, number][];
}

function run(font: ShxFont, d: Uint8Array, st: Pen, out: ShxPt[][], depth: number) {
  const moveTo = (x: number, y: number) => {
    if (st.down && --points >= 0) {
      if (!st.cur) out.push((st.cur = [[st.x, st.y]]));
      st.cur.push([x, y]);
    } else st.cur = null;
    st.x = x;
    st.y = y;
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 15) * Math.max(1, Math.min(4, Math.round(r / 4))));
    for (let k = 1; k <= n; k++) {
      const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
      moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  };
  const bulge = (dx: number, dy: number, b: number) => {
    if (!b) return moveTo(st.x + dx, st.y + dy);
    const t = b / 127, x0 = st.x, y0 = st.y;
    const theta = 4 * Math.atan(t);
    const chord = Math.hypot(dx, dy);
    const r = chord / (2 * Math.sin(theta / 2));
    const mx = x0 + dx / 2, my = y0 + dy / 2;
    const h = r * Math.cos(theta / 2);
    // centre to the left of the chord for a positive (counter-clockwise) bulge
    const cx = mx - (dy / chord) * h, cy = my + (dx / chord) * h;
    const a0 = (Math.atan2(y0 - cy, x0 - cx) * 180) / Math.PI;
    const n = Math.max(2, Math.ceil((Math.abs(theta) * 180) / Math.PI / 15));
    for (let k = 1; k <= n; k++) {
      const a = (a0 * Math.PI) / 180 + (theta * k) / n;
      moveTo(k === n ? x0 + dx : cx + Math.abs(r) * Math.cos(a), k === n ? y0 + dy : cy + Math.abs(r) * Math.sin(a));
    }
  };
  let skip = false;
  let i = 0;
  // number of argument bytes of the command at i (for code 14: skip it in horizontal text)
  const argLen = (j: number): number => {
    const c = d[j];
    if (c > 14) return 0;
    if (c === 3 || c === 4) return 1;
    if (c === 7) return font.kind === "bigfont" && d[j + 1] === 0 ? 7 : font.kind === "unifont" ? 2 : 1;
    if (c === 8) return 2;
    if (c === 9 || c === 13) {
      let k = j + 1;
      for (;;) {
        if (k + 1 >= d.length) return d.length - j - 1;
        const zero = d[k] === 0 && d[k + 1] === 0;
        k += c === 13 && !zero ? 3 : 2;
        if (zero) return k - j - 1;
      }
    }
    if (c === 10) return 2;
    if (c === 11) return 5;
    if (c === 12) return 3;
    return 0;
  };
  while (i < d.length) {
    if (--budget < 0 || points < 0) return;
    const c = d[i];
    if (skip) {
      skip = false;
      i += 1 + argLen(i);
      continue;
    }
    i++;
    if (c > 14) {
      const len = (c >> 4) * st.scale, [ux, uy] = DIRS[c & 15];
      moveTo(st.x + ux * len, st.y + uy * len);
      continue;
    }
    switch (c) {
      case 0:
        return;
      case 1:
        st.down = true;
        st.cur = null;
        break;
      case 2:
        st.down = false;
        st.cur = null;
        break;
      case 3:
        st.scale = Math.max(1e-6, st.scale / (d[i++] || 1));
        break;
      case 4:
        st.scale = Math.min(1e6, st.scale * (d[i++] || 1));
        break;
      case 5:
        if (st.stack.length < 8) st.stack.push([st.x, st.y]);
        break;
      case 6: {
        const p = st.stack.pop();
        if (p) {
          st.x = p[0];
          st.y = p[1];
          st.cur = null;
        }
        break;
      }
      case 7: {
        let sub: number;
        if (font.kind === "bigfont" && d[i] === 0) {
          // extended big font subshape: 0, number, origin x, y, width, height — the part drawn into that box (its own
          // cell is the font height), the pen staying where it was
          sub = u16be(d, i + 1);
          const ox = d[i + 3], oy = d[i + 4], w = d[i + 5], h = d[i + 6];
          i += 7;
          const sd = font.defs.get(sub);
          if (sd && depth < 6) {
            const tmp: ShxPt[][] = [];
            run(font, sd, { x: 0, y: 0, down: true, cur: null, scale: 1, stack: [] }, tmp, depth + 1);
            const sx = (w / font.above) * st.scale, sy = (h / font.above) * st.scale;
            const bx = st.x + ox * st.scale, by = st.y + oy * st.scale;
            for (const s of tmp) out.push(s.map(([x, y]): ShxPt => [bx + x * sx, by + y * sy]));
            st.cur = null;
          }
          break;
        }
        // (a big font names its subshapes in one byte, a Unicode font in two; the scale a subshape sets carries on —
        // gbcbig's set-up / finish shapes rely on it)
        if (font.kind !== "unifont") sub = d[i++];
        else {
          sub = u16be(d, i);
          i += 2;
        }
        const sd = font.defs.get(sub);
        if (sd && depth < 6) run(font, sd, st, out, depth + 1);
        break;
      }
      case 8:
        moveTo(st.x + s8(d[i]) * st.scale, st.y + s8(d[i + 1]) * st.scale);
        i += 2;
        break;
      case 9:
        while (i + 1 < d.length) {
          const dx = s8(d[i]), dy = s8(d[i + 1]);
          i += 2;
          if (!dx && !dy) break;
          moveTo(st.x + dx * st.scale, st.y + dy * st.scale);
        }
        break;
      case 10: {
        const r = d[i] * st.scale, sp = d[i + 1];
        i += 2;
        const cw = (sp & 0x80) !== 0, so = (sp >> 4) & 7, n = sp & 7 || 8;
        const a0 = so * 45, a1 = a0 + (cw ? -n : n) * 45;
        const cx = st.x - r * Math.cos((a0 * Math.PI) / 180), cy = st.y - r * Math.sin((a0 * Math.PI) / 180);
        arc(cx, cy, r, a0, a1);
        break;
      }
      case 11: {
        const s0 = d[i], e0 = d[i + 1], r = (d[i + 2] * 256 + d[i + 3]) * st.scale, sp = d[i + 4];
        i += 5;
        const cw = (sp & 0x80) !== 0, so = (sp >> 4) & 7, n = sp & 7 || 8;
        const sgn = cw ? -1 : 1;
        const a0 = so * 45 + (sgn * s0 * 45) / 256;
        const eo = so + sgn * (n - 1);
        const a1 = e0 ? eo * 45 + (sgn * e0 * 45) / 256 : (eo + sgn) * 45;
        const cx = st.x - r * Math.cos((a0 * Math.PI) / 180), cy = st.y - r * Math.sin((a0 * Math.PI) / 180);
        arc(cx, cy, r, a0, a1);
        break;
      }
      case 12:
        bulge(s8(d[i]) * st.scale, s8(d[i + 1]) * st.scale, s8(d[i + 2]));
        i += 3;
        break;
      case 13:
        while (i + 1 < d.length) {
          const dx = s8(d[i]), dy = s8(d[i + 1]);
          if (!dx && !dy) {
            i += 2;
            break;
          }
          bulge(dx * st.scale, dy * st.scale, s8(d[i + 2]));
          i += 3;
        }
        break;
      case 14:
        skip = true; // vertical-text only: horizontal text skips the next command
        break;
    }
  }
}

/** 2-byte shape numbers in definitions are high byte first */
const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);

// ───────── characters → shape numbers ─────────

/** AutoCAD's special shapes of the text fonts: %%d %%p %%c */
const SPECIAL: Record<string, number[]> = { "°": [0xb0, 127], "±": [0xb1, 128], "⌀": [0x2205, 0x2300, 0xd8, 129], Ø: [0xd8, 129] };

const decoders = new Map<string, Map<number, number> | null>();
/** Unicode → double-byte code of a big font's code page (the code page follows the font: AutoCAD's names) */
function dbcsMap(font: ShxFont): Map<number, number> | null {
  const n = font.name.replace(/^@/, "");
  const enc = /^(wh|hgt|kor)/.test(n) ? "euc-kr" : /^(gbc|gb|chs)/.test(n) ? "gbk" : /^(chineset|big5|cht)/.test(n) ? "big5" : /^(ext|bigfont|jis|@ext)/.test(n) ? "shift_jis" : "";
  if (!enc) return null;
  if (decoders.has(enc)) return decoders.get(enc)!;
  let m: Map<number, number> | null = new Map();
  try {
    const dec = new TextDecoder(enc, { fatal: true });
    for (let hi = 0x81; hi <= 0xfe; hi++)
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        try {
          const s = dec.decode(new Uint8Array([hi, lo]));
          const cp = s.codePointAt(0)!;
          if (s.length === 1 && cp > 0x7f && !m.has(cp)) m.set(cp, (hi << 8) | lo);
        } catch {
          /* not a character */
        }
      }
  } catch {
    m = null;
  }
  decoders.set(enc, m);
  return m;
}

/** Shape number of a character in `font`, or null. */
export function shxCode(font: ShxFont, ch: string): number | null {
  const cp = ch.codePointAt(0)!;
  if (font.kind === "bigfont") {
    // a single-byte shape in a big font takes the place of the main font's (whgtxt's space: 0.65 of the height — the
    // AutoCAD 2027 plot of omni-cad-16)
    if (cp < 0x80) return cp >= 0x20 && font.defs.has(cp) && !font.ranges?.some(([a, b]) => cp >= a && cp <= b) ? cp : null;
    const code = dbcsMap(font)?.get(cp);
    return code !== undefined && font.defs.has(code) ? code : null;
  }
  if (cp === 0x20 && !font.defs.has(32)) return null;
  for (const c of [cp, ...(SPECIAL[ch] ?? [])]) if (c && font.defs.has(c) && (font.kind === "unifont" || c < 256)) return c;
  return null;
}

/** A text style's SHX pair: main font, optional big font (CJK). Advances / strokes in units of the cap height. */
export interface ShxPair {
  main: ShxFont | null;
  big: ShxFont | null;
}

/** Glyph of a character in cap-height units (cap = 1), from the big font for wide characters, else the main font. */
export function pairGlyph(pair: ShxPair, ch: string): ShxGlyph | null {
  for (const f of [pair.big, pair.main]) {
    if (!f) continue;
    const code = shxCode(f, ch);
    if (code === null) continue;
    const g = shxGlyph(f, code);
    if (!g) continue;
    // a big font's height is its whole cell: AutoCAD sets it at the main font's cap height
    const k = 1 / f.above;
    return { adv: g.adv * k, strokes: g.strokes.map((s) => s.map(([x, y]): ShxPt => [x * k, y * k])) };
  }
  return null;
}

/** SHX file name of a style font ("romans", "txt.shx" → "romans.shx"); null for TrueType */
export function shxFileOf(font: string | undefined): string | null {
  const f = (font ?? "").trim().replace(/^.*[\\/]/, "");
  if (!f) return "txt.shx";
  if (/\.(ttf|ttc|otf)$/i.test(f)) return null;
  if (/\.shx$/i.test(f)) return f.toLowerCase();
  return /^(txt|simplex|romans|romand|romant|romanc|complex|italic|isocp\d?|isoct\d?|monotxt|gothic\w*|script\w*|greek\w*|whg\w*|hgt\w*|bigfont|extfont\w*|@extfont\w*|gb\w*|chineset)$/i.test(f) ? f.toLowerCase() + ".shx" : null;
}

/** Register key "main[+big]" of a style, or null (TrueType) */
export const shxKeyOf = (font: string | undefined, big: string | undefined): string | null => {
  const m = shxFileOf(font);
  if (!m) return null;
  const b = big ? shxFileOf(big) : null;
  return m.replace(/\.shx$/, "") + (b ? "+" + b.replace(/\.shx$/, "") : "");
};
