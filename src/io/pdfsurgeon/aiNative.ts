// PDF Surgeon — an Illustrator file saved WITHOUT PDF content, drawn from Illustrator's own (native) data.
//
// Such a file's PDF part only holds a notice page; the art is in the private data (AIPrivateData streams, read by
// aiPrivate.ts): Illustrator's PostScript-like native format. This module interprets it into a scene
// (aiNativeScene.ts), which aiNativePdf.ts writes as a PDF — one page per artboard — so the art opens, draws and
// edits exactly like a PDF-compatible .ai. Saving back to .ai stays refused (formats/index.ts): this PDF is a
// rendering, not Illustrator's document.
//
// What is read (Illustrator 9+ native syntax, checked against Illustrator 24–31 files, qa/interop/adobe-made):
//   header      %AI3_Cropmarks, the artboards (ArtboardArray: PositionPoint1/2 in art space), %AI9_ColorModel;
//   setup       gradients (%AI5_BeginGradient … Bd, stops %_BS), patterns (%AI3_BeginPattern, art behind %_),
//               symbols (%AI14_BeginSymbol), named paints (/KnownStyle, used by text), the text document
//               (/AI11TextDocument) and the ruler origin;
//   art         layers (%AI5_BeginLayer … Lb … LB: visibility), groups (u … U), clip groups (q … clipping path W …
//               Q, the clip written last), compound paths (*u … *U), paths (m l L c C v V y Y, closing h, paint f F
//               s S b B n N), colours (g G k K x X Xa XA Xx XX: gray, CMYK, RGB, custom/spot with tint), stroke
//               (w J j M d), fill rule (XR), hidden objects (Xw), transparency (Xy: blend mode, opacity, knockout —
//               a record with a 2 in its fourth field belongs to the object just finished, see applyXy), gradient
//               instances (Bb … Bg Xm/Bm Bh … BB), pattern fills (p / P), embedded rasters (%AI5_BeginRaster Xh
//               … XI binary data: colour interleaved, then the alpha plane), placed (linked) files (their embedded
//               preview), symbol instances (/SymbolInstance), point/area/path text (/AI11Text → the text
//               document's cached layout, aiNativeText.ts), imported PDF objects (/ForeignObject, aiNativeForeign.ts).
//   Lines starting with %_ hold the editable source of live effects, brushes and appearances; the visible art next to
//   them is Illustrator's expanded result (what a PostScript printer would draw) — that is what is drawn here.
// Anything else is counted in the notes (shown when the file opens).
// Bounded everywhere: tokens, nesting, path size, image size, objects — damaged data stops early, never hangs.

import { aiNativeText } from "./aiPrivate";
import { openSurgeonDoc } from "./document";
import {
  IDENT,
  XP_NORMAL,
  addPt,
  apply,
  boxOk,
  emptyBox,
  mul,
  nodeBox,
  unionBox,
  type Artboard,
  type Box,
  type Color,
  type GradStop,
  type Gradient,
  type ForeignNode,
  type GroupNode,
  type ImageNode,
  type Mat,
  type Node,
  type Paint,
  type PathNode,
  type Stroke,
  type Xp,
} from "./aiNativeScene";
import { readTextLayout, type TextLayout } from "./aiNativeText";
import { foreignObject } from "./aiNativeForeign";

export interface NativeDoc {
  artboards: Artboard[];
  /** the art, bottom → top */
  art: Node[];
  cmyk: boolean;
  patterns: Map<string, { box: Box; art: Node[] }>;
  /** why parts are drawn differently or not at all (counted), for the open notice */
  notes: Map<string, number>;
}

const MAX_TOKENS = 20_000_000;
const MAX_DEPTH = 64;
const MAX_PATH_OPS = 2_000_000;
const MAX_IMAGE_PX = 64_000_000;
const MAX_NODES = 1_000_000;

// ───────── lexer ─────────

export type Tok =
  | { k: "n"; v: number }
  | { k: "s"; v: string }
  | { k: "name"; v: string }
  | { k: "op"; v: string }
  | { k: "["; v: "[" }
  | { k: "]"; v: "]" }
  | { k: "{"; v: "{" }
  | { k: "}"; v: "}" }
  | { k: "mark"; v: string; line: string };

const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const NUMRE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Comment markers the interpreter acts on (everything else after % is skipped). */
const MARKS = ["%AI5_BeginRaster", "%AI5_EndRaster", "%AI5_BeginPlace"];

export class Lexer {
  i: number;
  count = 0;
  constructor(
    readonly s: string,
    from: number,
    readonly end: number,
  ) {
    this.i = from;
  }
  private eol(k: number) {
    while (k < this.end) {
      const c = this.s.charCodeAt(k);
      if (c === 10 || c === 13) break;
      k++;
    }
    return k;
  }
  /** after a token: skip one end of line (CR, LF or CRLF) */
  skipEol() {
    if (this.s.charCodeAt(this.i) === 13) this.i++;
    if (this.s.charCodeAt(this.i) === 10) this.i++;
  }
  next(): Tok | null {
    const s = this.s;
    for (;;) {
      if (++this.count > MAX_TOKENS) throw new Error("ai native: too many tokens");
      while (this.i < this.end && isWs(s.charCodeAt(this.i))) this.i++;
      if (this.i >= this.end) return null;
      const c = s.charCodeAt(this.i);
      if (c === 37 /* % */) {
        const e = this.eol(this.i);
        const line = s.slice(this.i, Math.min(e, this.i + 200));
        this.i = e;
        if (line.startsWith("%AI17_Alternate_Content")) {
          // versioned content: keep the newest branch (before Alternate), skip the older one
          const k = s.indexOf("%AI17_End_Versioned_Content", this.i);
          this.i = k < 0 || k > this.end ? this.end : k;
          continue;
        }
        const m = MARKS.find((p) => line.startsWith(p));
        if (m) return { k: "mark", v: m, line };
        continue;
      }
      if (c === 40 /* ( */) {
        let depth = 0;
        let out = "";
        let k = this.i;
        for (; k < this.end; k++) {
          const ch = s[k];
          if (ch === "\\") {
            const nx = s[++k];
            if (nx === undefined) break;
            if (nx === "n") out += "\n";
            else if (nx === "r") out += "\r";
            else if (nx === "t") out += "\t";
            else if (nx === "b") out += "\b";
            else if (nx === "f") out += "\f";
            else if (nx === "\r" || nx === "\n") {
              if (nx === "\r" && s[k + 1] === "\n") k++;
            } else if (nx >= "0" && nx <= "7") {
              let o = nx;
              while (o.length < 3 && s[k + 1] >= "0" && s[k + 1] <= "7") o += s[++k];
              out += String.fromCharCode(parseInt(o, 8) & 255);
            } else out += nx;
            continue;
          }
          if (ch === "(") {
            if (depth++ > 0) out += ch;
            continue;
          }
          if (ch === ")") {
            if (--depth === 0) break;
            out += ch;
            continue;
          }
          out += ch;
          if (out.length > 1_000_000) break;
        }
        this.i = k + 1;
        return { k: "s", v: out };
      }
      if (c === 60 /* < */) {
        const e = s.indexOf(">", this.i);
        const stop = e < 0 || e > this.end ? this.end : e;
        const hex = s.slice(this.i + 1, stop).replace(/[^0-9a-fA-F]/g, "");
        this.i = stop + 1;
        let out = "";
        for (let k = 0; k + 1 < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
        return { k: "s", v: out };
      }
      if (c === 91 || c === 93 || c === 123 || c === 125) {
        this.i++;
        const v = s[this.i - 1] as "[" | "]" | "{" | "}";
        return { k: v, v } as Tok;
      }
      if (c === 41 || c === 62) {
        this.i++;
        continue; // stray delimiter
      }
      let k = this.i + 1;
      if (c === 47 /* / */) {
        while (k < this.end && !isWs(s.charCodeAt(k)) && !isDelim(s.charCodeAt(k))) k++;
        const v = s.slice(this.i + 1, k);
        this.i = k;
        return { k: "name", v };
      }
      while (k < this.end && !isWs(s.charCodeAt(k)) && !isDelim(s.charCodeAt(k))) k++;
      const v = s.slice(this.i, k);
      this.i = k;
      // a number too large for a double (1e999) reads as 0: Infinity would reach the PDF as a broken token
      if (NUMRE.test(v)) return { k: "n", v: Number.isFinite(+v) ? +v : 0 };
      return { k: "op", v };
    }
  }
}

// ───────── colours ─────────

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const cmykColor = (c: number, m: number, y: number, k: number): Color => ({ cs: "cmyk", v: [clamp01(c), clamp01(m), clamp01(y), clamp01(k)] });
const rgbColor = (r: number, g: number, b: number): Color => ({ cs: "rgb", v: [clamp01(r), clamp01(g), clamp01(b)] });
/** a spot / custom colour at a tint: Illustrator writes the tint as 1 − tint (0 = the full colour) */
const tinted = (c: Color, t: number): Color => {
  const f = 1 - clamp01(t);
  if (c.cs === "cmyk") return cmykColor(c.v[0] * f, c.v[1] * f, c.v[2] * f, c.v[3] * f);
  if (c.cs === "rgb") return rgbColor(1 - (1 - c.v[0]) * f, 1 - (1 - c.v[1]) * f, 1 - (1 - c.v[2]) * f);
  return { cs: "gray", v: [1 - (1 - c.v[0]) * f] };
};
const numsOf = (toks: Tok[]) => toks.filter((t) => t.k === "n").map((t) => (t as { v: number }).v);

// ───────── setup: gradients ─────────

function parseGradients(s: string, cmykDoc: boolean): Map<string, Gradient> {
  const out = new Map<string, Gradient>();
  const re = /%AI5_BeginGradient: \(/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(s)) && guard++ < 100_000) {
    const end = s.indexOf("%AI5_EndGradient", m.index);
    if (end < 0) break;
    re.lastIndex = end; // a Begin without its End inside the previous gradient is not read again (quadratic work)
    const body = s.slice(m.index, end);
    const lx = new Lexer(body, body.indexOf("\n") + 1 || body.length, body.length);
    // (name) type nStops Bd
    let name = "";
    let radial = false;
    const stack: Tok[] = [];
    for (let t = lx.next(); t; t = lx.next()) {
      if (t.k === "op" && t.v === "Bd") {
        const n = numsOf(stack);
        const nm = stack.find((x) => x.k === "s");
        name = nm ? (nm as { v: string }).v : "";
        radial = (n[0] ?? 0) === 1;
        break;
      }
      stack.push(t);
      if (stack.length > 64) stack.shift();
    }
    const stops: GradStop[] = [];
    // stops: one line "<values> %_BS" each (the colour, its kind, opacity, 6, midpoint, ramp point)
    const lineRe = /^([^%\r\n]*?)\s*%_BS\s*$/gm;
    let lm: RegExpExecArray | null;
    let g2 = 0;
    while ((lm = lineRe.exec(body)) && g2++ < 10_000) {
      const toks: Tok[] = [];
      const l2 = new Lexer(lm[1], 0, lm[1].length);
      for (let t = l2.next(); t; t = l2.next()) toks.push(t);
      const nums = numsOf(toks);
      if (nums.length < 6) continue;
      const [kind, opacity, , mid, ramp] = nums.slice(-5); // kind opacity 6 midpoint ramp
      const vals = nums.slice(0, -5);
      let color: Color;
      if (kind === 0) color = { cs: "gray", v: [clamp01(vals[0] ?? 0)] };
      else if (kind === 1) color = cmykColor(vals[0], vals[1], vals[2], vals[3]);
      else if (kind === 2) color = cmykDoc ? cmykColor(vals[0], vals[1], vals[2], vals[3]) : rgbColor(vals[4], vals[5], vals[6]);
      else {
        // custom / spot: c m y k [r g b] (name) tint kind …
        const hasRgb = vals.length >= 8;
        const base = hasRgb && !cmykDoc ? rgbColor(vals[4], vals[5], vals[6]) : cmykColor(vals[0], vals[1], vals[2], vals[3]);
        color = tinted(base, vals[vals.length - 1] ?? 0);
      }
      stops.push({ at: clamp01(ramp / 100), mid: Math.min(0.99, Math.max(0.01, mid / 100)), color, opacity: clamp01(opacity) });
    }
    stops.sort((a, b) => a.at - b.at);
    if (name && stops.length) out.set(name, { name, radial, stops });
  }
  return out;
}

// ───────── header & setup ─────────

function num(s: string | undefined, d = 0) {
  const v = s === undefined ? NaN : +s;
  return Number.isFinite(v) ? v : d;
}

function readArtboards(setup: string, header: string): Artboard[] {
  const abs: Artboard[] = [];
  // the ArtboardArray dictionary (behind %_): … (Name) … x y /RealPointRelToROrigin (PositionPoint1) … (PositionPoint2)
  const re = /%_(-?[\d.eE+-]+) (-?[\d.eE+-]+) \/RealPointRelToROrigin\s*%_ ?\(PositionPoint1\)[\s\S]{0,200}?%_(-?[\d.eE+-]+) (-?[\d.eE+-]+) \/RealPointRelToROrigin\s*%_ ?\(PositionPoint2\)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  let guard = 0;
  while ((m = re.exec(setup)) && guard++ < 1000) {
    const before = setup.slice(Math.max(last, m.index - 3000), m.index);
    const nm = /%_\(((?:[^()\\]|\\.)*)\) \/UnicodeString \(Name\)/g;
    let name = "";
    let x: RegExpExecArray | null;
    while ((x = nm.exec(before))) name = x[1];
    last = m.index + m[0].length;
    const [ax, ay, bx, by] = [num(m[1]), num(m[2]), num(m[3]), num(m[4])];
    const box = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    if (box.x1 - box.x0 >= 1 && box.y1 - box.y0 >= 1 && box.x1 - box.x0 < 1e6 && box.y1 - box.y0 < 1e6) abs.push({ name: utf8(name), box });
  }
  if (!abs.length) {
    const c = /%AI3_Cropmarks: (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(header);
    if (c) {
      const [x0, y0, x1, y1] = [num(c[1]), num(c[2]), num(c[3]), num(c[4])];
      if (x1 > x0 && y1 > y0) abs.push({ name: "", box: { x0, y0, x1, y1 } });
    }
  }
  return abs;
}

/** latin1 bytes of UTF-8 text → string (Illustrator writes names as UTF-8 inside PostScript strings) */
export function utf8(b: string): string {
  try {
    const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0) & 255);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return b;
  }
}

/** One level of "%_" hiding removed (pattern bodies are written entirely behind it). */
const unhide = (s: string) => s.replace(/(^|[\r\n])%_/g, "$1");

// ───────── interpreter ─────────

interface Container {
  kind: "root" | "layer" | "group" | "clip" | "compound";
  node: GroupNode;
  hidden: boolean;
  /** compound path: the merged subpaths, painted once at *U */
  cd?: string[];
  cbox?: Box;
  cfirst?: PathNode;
}

interface Gs {
  fill: Paint;
  stroke: Paint;
  st: Stroke;
  evenOdd: boolean;
  xp: Xp;
  hidden: boolean;
}

const fmt = (v: number) => {
  if (!Number.isFinite(v)) return "0";
  // the path goes into a PDF content stream, where a number has no exponent: String(1e21) would write "1e+21"
  const r = Math.round(Math.max(-1e15, Math.min(1e15, v)) * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
};

export interface InterpretOptions {
  gradients: Map<string, Gradient>;
  symbols: Map<string, { start: number; end: number }>;
  cmyk: boolean;
  text: TextLayout | null;
  notes: Map<string, number>;
  source: string;
  /** tokens read by every interpreter of this document (symbols inside symbols multiply the work) */
  work: { n: number };
  /**
   * what was decoded from `source`, by offset — rasters, placed previews, imported PDFs: a symbol drawn many times
   * reads its data once (without it, one 50 MB raster in a symbol placed 1,000 times was decoded 1,000 times)
   */
  cache: Map<string, unknown>;
}

const MAX_WORK = 40_000_000;

export class Interpreter {
  private stack: Tok[] = [];
  readonly gs: Gs = {
    fill: { k: "color", c: { cs: "gray", v: [0] } },
    stroke: { k: "none" },
    st: { width: 1, cap: 0, join: 0, miter: 10, dash: [], phase: 0 },
    evenOdd: false,
    xp: { ...XP_NORMAL },
    hidden: false,
  };
  private cont: Container[];
  private path: string[] = [];
  private pbox = emptyBox();
  private cur: [number, number] = [0, 0];
  private start: [number, number] = [0, 0];
  private pathOps = 0;
  private gradTarget: "fill" | "stroke" | null = null;
  private gradPaint: (Paint & { k: "gradient" }) | null = null;
  private gradHasXm = false;
  private clipNext = false;
  /** the object finished last (a post-record Xy with a 2 in its 4th field applies to it) */
  private lastObj: Node | null = null;
  private raster: { cs: "gray" | "rgb" | "cmyk" } | null = null;
  private nodes = 0;
  private depthSym = 0;
  /** last search for each marker: [from, found at] — a marker that is not there is not searched for again */
  private seen = new Map<string, [number, number]>();
  constructor(
    private o: InterpretOptions,
    root: GroupNode,
  ) {
    this.cont = [{ kind: "root", node: root, hidden: false }];
  }
  /** source.indexOf(marker, from), remembered: many operators looking for a missing end marker cost one scan */
  private find(marker: string, from: number): number {
    const m = this.seen.get(marker);
    if (m && m[0] <= from && (m[1] < 0 || m[1] >= from)) return m[1];
    const at = this.o.source.indexOf(marker, from);
    this.seen.set(marker, [from, at]);
    return at;
  }
  note(k: string, n = 1) {
    this.o.notes.set(k, (this.o.notes.get(k) ?? 0) + n);
  }
  private get top() {
    return this.cont[this.cont.length - 1];
  }
  private hiddenNow() {
    return this.cont.some((c) => c.hidden) || this.gs.hidden;
  }
  private add(n: Node) {
    if (++this.nodes > MAX_NODES) throw new Error("ai native: too many objects");
    const c = this.top;
    if (c.kind === "compound" && n.t === "path") {
      // compound path: every subpath joins one path, painted with the first subpath's style
      c.cd!.push(n.d);
      unionBox(c.cbox!, n.box);
      if (!c.cfirst) c.cfirst = n;
      return;
    }
    if (this.cont.some((x) => x.hidden) || (this.gs.hidden && n.t !== "group")) return;
    c.node.kids.push(n);
    this.lastObj = n;
  }
  private push(kind: Container["kind"], hidden = false, extra?: Partial<GroupNode>): GroupNode {
    if (this.cont.length > MAX_DEPTH) throw new Error("ai native: nested too deep");
    const node: GroupNode = { t: "group", kids: [], xp: { ...XP_NORMAL }, ...extra };
    const c: Container = { kind, node, hidden };
    if (kind === "compound") {
      c.cd = [];
      c.cbox = emptyBox();
    }
    this.cont.push(c);
    this.lastObj = null;
    return node;
  }
  private pop(kind: Container["kind"]): Container | null {
    // close the innermost container of this kind (unbalanced input closes what is open above it)
    let k = this.cont.length - 1;
    while (k > 0 && this.cont[k].kind !== kind) k--;
    if (k <= 0) return null;
    let c: Container | null = null;
    while (this.cont.length > k) {
      c = this.cont.pop()!;
      this.finish(c);
    }
    return c;
  }
  private finish(c: Container) {
    if (c.kind === "compound") {
      const f = c.cfirst;
      if (f && c.cd!.length) this.add({ ...f, d: c.cd!.join("\n"), box: c.cbox! });
      return;
    }
    if (c.hidden) return;
    const n = c.node;
    if (c.kind === "clip") n.clip = true;
    if (!n.kids.length) return;
    // a clip group without a clipping path: its topmost text clips (text made a mask), else the content draws plainly
    if (n.clip && !n.kids.some((k) => k.t === "path" && k.clip)) {
      const last = n.kids[n.kids.length - 1];
      if (last.t === "text" && n.kids.length > 1) last.clip = true;
      else n.clip = false;
    }
    this.add(n);
  }
  private nums(args: Tok[], n: number): number[] | null {
    const v = numsOf(args);
    return v.length >= n ? v.slice(-n) : null;
  }

  // ── paths ──
  private moveTo(x: number, y: number) {
    this.path.push(`${fmt(x)} ${fmt(y)} m`);
    this.cur = [x, y];
    this.start = [x, y];
    addPt(this.pbox, x, y);
  }
  private lineTo(x: number, y: number) {
    this.path.push(`${fmt(x)} ${fmt(y)} l`);
    this.cur = [x, y];
    addPt(this.pbox, x, y);
  }
  private curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    this.path.push(`${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x3)} ${fmt(y3)} c`);
    this.cur = [x3, y3];
    addPt(this.pbox, x1, y1);
    addPt(this.pbox, x2, y2);
    addPt(this.pbox, x3, y3);
  }
  private closePath() {
    if (this.path.length && this.path[this.path.length - 1] !== "h") this.path.push("h");
    this.cur = this.start;
  }
  private paint(op: string) {
    const d = this.path;
    this.path = [];
    const box = this.pbox;
    this.pbox = emptyBox();
    const clip = this.clipNext;
    this.clipNext = false;
    if (!d.length) return;
    if (op === op.toLowerCase() && d[d.length - 1] !== "h") d.push("h");
    const fillOn = op === "f" || op === "F" || op === "b" || op === "B";
    const strokeOn = op === "s" || op === "S" || op === "b" || op === "B";
    const g = this.gs;
    const n: PathNode = {
      t: "path",
      d: d.join("\n"),
      box,
      fill: fillOn ? g.fill : { k: "none" },
      stroke: strokeOn ? g.stroke : { k: "none" },
      st: { ...g.st, dash: [...g.st.dash] },
      evenOdd: g.evenOdd,
      xp: { ...g.xp },
    };
    if (this.top.kind === "compound") return this.add(n); // the compound's paint comes from its first subpath
    if (clip) {
      // a clipping path of the enclosing clip group (W before its paint operator)
      n.clip = true;
      if (!this.cont.some((x) => x.hidden)) this.top.node.kids.push(n);
      return;
    }
    if (!fillOn && !strokeOn) return; // n / N: a guide, no paint
    this.add(n);
  }

  // ── transparency ──
  /**
   * Xy: blend-mode opacity isolated knockout alpha-is-shape. With 2 in the knockout field it is the record written
   * after an object (a symbol instance, a raster, a group, a layer's last object): it applies to the object just
   * finished and does not change the state; otherwise it is the state for the objects that follow.
   */
  private applyXy(v: number[]) {
    const [mode, opacity, isolated, knockout] = v;
    const xp: Xp = { mode: Math.max(0, Math.min(15, Math.round(mode))), opacity: clamp01(opacity), isolated: isolated === 1, knockout: knockout === 1 };
    if (knockout === 2) {
      const o = this.lastObj;
      if (o && o.t !== "patch") o.xp = xp;
      return;
    }
    this.gs.xp = xp;
  }

  run(lx: Lexer) {
    for (let t = lx.next(); t; t = lx.next()) {
      if (++this.o.work.n > MAX_WORK) throw new Error("ai native: too much work");
      if (t.k === "mark") {
        this.mark(t, lx);
        continue;
      }
      if (t.k === "name") {
        // dictionary object: /Name : … ;
        const save = lx.i;
        const nx = lx.next();
        if (nx && nx.k === "op" && nx.v === ":") {
          this.dictObject(t.v, lx);
          continue;
        }
        lx.i = save;
        this.stack.push(t);
        continue;
      }
      if (t.k !== "op") {
        this.stack.push(t);
        if (this.stack.length > 100_000) this.stack.splice(0, 50_000);
        continue;
      }
      this.op(t.v, lx);
    }
  }

  private op(v: string, lx: Lexer) {
    const args = this.stack.splice(0);
    const g = this.gs;
    switch (v) {
      // ── path construction ──
      case "m": {
        const a = this.nums(args, 2);
        if (a) this.moveTo(a[0], a[1]);
        break;
      }
      case "l":
      case "L": {
        const a = this.nums(args, 2);
        if (a) this.lineTo(a[0], a[1]);
        break;
      }
      case "c":
      case "C": {
        const a = this.nums(args, 6);
        if (a) this.curveTo(a[0], a[1], a[2], a[3], a[4], a[5]);
        break;
      }
      case "v":
      case "V": {
        const a = this.nums(args, 4);
        if (a) this.curveTo(this.cur[0], this.cur[1], a[0], a[1], a[2], a[3]);
        break;
      }
      case "y":
      case "Y": {
        const a = this.nums(args, 4);
        if (a) this.curveTo(a[0], a[1], a[2], a[3], a[2], a[3]);
        break;
      }
      case "h":
        this.closePath();
        break;
      case "W":
        this.clipNext = true;
        break;
      case "f":
      case "F":
      case "s":
      case "S":
      case "b":
      case "B":
      case "n":
      case "N":
        if (++this.pathOps > MAX_PATH_OPS) throw new Error("ai native: too many paths");
        this.paint(v);
        break;
      // ── colours ──
      case "g":
      case "G": {
        const a = this.nums(args, 1);
        if (a) g[v === "g" ? "fill" : "stroke"] = { k: "color", c: { cs: "gray", v: [clamp01(a[0])] } };
        break;
      }
      case "k":
      case "K": {
        const a = this.nums(args, 4);
        if (a) g[v === "k" ? "fill" : "stroke"] = { k: "color", c: cmykColor(a[0], a[1], a[2], a[3]) };
        break;
      }
      case "Xa":
      case "XA": {
        const a = this.nums(args, 7);
        if (a) g[v === "Xa" ? "fill" : "stroke"] = { k: "color", c: this.o.cmyk ? cmykColor(a[0], a[1], a[2], a[3]) : rgbColor(a[4], a[5], a[6]) };
        break;
      }
      case "x":
      case "X":
      case "Xx":
      case "XX":
      case "Xk":
      case "XK": {
        // custom (spot) colour: c m y k [r g b] (name) tint [type]
        const si = args.findIndex((t) => t.k === "s");
        if (si < 0) break;
        const pre = numsOf(args.slice(0, si));
        const post = numsOf(args.slice(si + 1));
        const tint = post[0] ?? 0;
        const p = pre.slice(-(pre.length >= 7 ? 7 : 4));
        const rgb = p.length >= 7 && !this.o.cmyk;
        const base = rgb ? rgbColor(p[4], p[5], p[6]) : cmykColor(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0);
        g[v === "x" || v === "Xx" || v === "Xk" ? "fill" : "stroke"] = { k: "color", c: tinted(base, tint) };
        break;
      }
      case "p":
      case "P": {
        // pattern: (name) shiftX shiftY scaleX scaleY rotate reflect reflectAngle shearAngle shearAxis [matrix] p
        const si = args.findIndex((t) => t.k === "s");
        const nm = si >= 0 ? (args[si] as { v: string }).v : "";
        const ob = args.findIndex((t) => t.k === "[");
        const mat = ob >= 0 ? numsOf(args.slice(ob + 1)) : [];
        g[v === "p" ? "fill" : "stroke"] = { k: "pattern", name: nm, m: mat.length >= 6 ? (mat.slice(0, 6) as Mat) : ([...IDENT] as Mat) };
        break;
      }
      // ── gradients ──
      case "Bb": {
        const a = this.nums(args, 1);
        this.gradTarget = a && a[0] === 1 ? "stroke" : "fill";
        this.gradPaint = null;
        this.gradHasXm = false;
        break;
      }
      case "Bg": {
        const si = args.findIndex((t) => t.k === "s");
        const nm = si >= 0 ? (args[si] as { v: string }).v : "";
        const flag = si > 0 && args[si - 1].k === "n" ? (args[si - 1] as { v: number }).v : 1;
        const grad = this.o.gradients.get(nm);
        const target: "fill" | "stroke" = this.gradTarget ?? (flag === 2 ? "stroke" : "fill");
        if (!grad) {
          this.note("gradient-missing");
          break;
        }
        // fallback geometry from Bg itself: origin x y, angle, length, then a matrix (Xm / Bm replace it)
        const nn = numsOf(args.slice(si + 1));
        const [ox = 0, oy = 0, ang = 0, len = 1] = nn;
        const base: Mat = nn.length >= 10 ? (nn.slice(4, 10) as Mat) : ([...IDENT] as Mat);
        const r = (ang * Math.PI) / 180;
        const L = len || 1;
        const m0: Mat = grad.radial ? [L, 0, 0, L, ox, oy] : [L * Math.cos(r), L * Math.sin(r), -L * Math.sin(r), L * Math.cos(r), ox, oy];
        this.gradPaint = { k: "gradient", g: grad, m: mul(m0, base) };
        g[target] = this.gradPaint;
        break;
      }
      case "Xm":
      case "Bm": {
        // Xm: the whole ramp (linear); without it the first Bm (later Bm are print slices)
        const a = this.nums(args, 6);
        if (a && this.gradPaint && (v === "Xm" || !this.gradHasXm)) {
          this.gradPaint.m = a as Mat;
          this.gradHasXm = true;
        }
        break;
      }
      case "Bh": {
        // highlight: x y angle length (radial focal point, in the ramp's unit space)
        const a = this.nums(args, 4);
        if (a && this.gradPaint && a[3]) {
          const r = (a[2] * Math.PI) / 180;
          const len = Math.min(0.99, Math.abs(a[3]));
          this.gradPaint.focal = [len * Math.cos(r), len * Math.sin(r)];
        }
        break;
      }
      case "BB":
        this.gradTarget = null;
        this.gradPaint = null;
        break;
      // ── stroke & state ──
      case "w": {
        const a = this.nums(args, 1);
        if (a) g.st.width = Math.max(0, a[0]);
        break;
      }
      case "J": {
        const a = this.nums(args, 1);
        if (a) g.st.cap = Math.max(0, Math.min(2, Math.round(a[0])));
        break;
      }
      case "j": {
        const a = this.nums(args, 1);
        if (a) g.st.join = Math.max(0, Math.min(2, Math.round(a[0])));
        break;
      }
      case "M": {
        const a = this.nums(args, 1);
        if (a) g.st.miter = Math.max(1, a[0]);
        break;
      }
      case "d": {
        const ob = args.findIndex((t) => t.k === "[");
        const cb = args.findIndex((t) => t.k === "]");
        const arr = ob >= 0 && cb > ob ? numsOf(args.slice(ob + 1, cb)).map((x) => Math.max(0, x)) : [];
        const ph = numsOf(args.slice(cb + 1))[0];
        g.st.dash = arr.slice(0, 32).every((x) => x === 0) ? [] : arr.slice(0, 32);
        g.st.phase = ph ?? 0;
        break;
      }
      case "XR": {
        const a = this.nums(args, 1);
        if (a) g.evenOdd = a[0] === 1;
        break;
      }
      case "Xw": {
        const a = this.nums(args, 1);
        if (a) g.hidden = a[0] === 1;
        break;
      }
      case "Xy": {
        const a = this.nums(args, 5) ?? this.nums(args, 4);
        if (a) this.applyXy(a);
        break;
      }
      // ── containers ──
      case "Lb": {
        // visible preview enabled printing dimmed hasMask colourIndex red green blue …
        const a = numsOf(args);
        this.push("layer", a.length ? a[0] === 0 : false, { layer: true });
        g.hidden = false;
        break;
      }
      case "Ln": {
        const s = args.find((t) => t.k === "s");
        if (s && this.top.kind === "layer") this.top.node.name = utf8((s as { v: string }).v);
        break;
      }
      case "LB":
        this.pop("layer");
        break;
      case "u":
        this.push("group", this.gs.hidden);
        break;
      case "U":
        this.pop("group");
        break;
      case "*u":
        this.push("compound", this.gs.hidden);
        break;
      case "*U":
        this.pop("compound");
        break;
      case "q":
        this.push("clip", this.gs.hidden);
        break;
      case "Q":
        this.pop("clip");
        break;
      // ── rasters ──
      case "XN": {
        const nm = args.find((t) => t.k === "name");
        if (this.raster && nm) {
          const v2 = (nm as { v: string }).v;
          this.raster.cs = /CMYK/i.test(v2) ? "cmyk" : /Gray/i.test(v2) ? "gray" : "rgb";
        }
        break;
      }
      case "XI":
        this.image(args, lx);
        break;
      default:
        // A AE Ae Ap As O R D Xd XW Np TE X= X+ H XP XG XH Xh Xr Bc …: nothing visible here
        break;
    }
  }

  // ── comments the interpreter acts on ──
  private mark(t: Tok & { k: "mark" }, lx: Lexer) {
    if (t.v === "%AI5_BeginRaster") this.raster = { cs: "rgb" };
    else if (t.v === "%AI5_EndRaster") this.raster = null;
    else if (t.v === "%AI5_BeginPlace") this.placed(lx);
  }

  /** XI with the raster header on the stack, then the binary samples (colour interleaved, then the alpha plane). */
  private image(args: Tok[], lx: Lexer) {
    lx.skipEol();
    const ob = args.findIndex((t) => t.k === "[");
    const cb = args.findIndex((t) => t.k === "]");
    const mat = ob >= 0 && cb > ob ? numsOf(args.slice(ob + 1, cb)) : [];
    const rest = numsOf(args.slice(cb + 1));
    // [m] x0 y0 x1 y1 w h bits colourChannels alphaChannels …
    const [, , , , w, h, bits, chans, alphaN] = rest;
    const s = lx.s;
    const endMark = this.find("%%EndData", lx.i);
    const okDims = Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w * h <= MAX_IMAGE_PX;
    if (mat.length < 6 || !okDims || bits !== 8 || ![1, 3, 4].includes(chans) || !(alphaN === 0 || alphaN === 1)) {
      // no header at all: the samples of a raster written behind %_ (a live effect's source) — skipped silently
      if (mat.length || rest.length) this.note("raster-unknown");
      if (endMark >= 0 && endMark < lx.end) lx.i = endMark + 9;
      return;
    }
    const n = w * h;
    const need = n * (chans + alphaN);
    const avail = (endMark >= 0 && endMark < lx.end ? endMark : lx.end) - lx.i;
    if (avail < need) {
      this.note("raster-truncated");
      lx.i = endMark >= 0 && endMark < lx.end ? endMark + 9 : lx.end;
      return;
    }
    const base = lx.i;
    const key = `XI${base}:${w}:${h}:${chans}:${alphaN}`;
    let px = this.o.cache.get(key) as { data: Uint8Array; alpha?: Uint8Array } | undefined;
    if (!px) {
      const data = new Uint8Array(n * chans);
      for (let k = 0; k < data.length; k++) data[k] = s.charCodeAt(base + k) & 255;
      let alpha: Uint8Array | undefined;
      if (alphaN) {
        alpha = new Uint8Array(n);
        const a0 = base + n * chans;
        let opaque = true;
        for (let k = 0; k < n; k++) {
          const v = s.charCodeAt(a0 + k) & 255;
          alpha[k] = v;
          if (v !== 255) opaque = false;
        }
        if (opaque) alpha = undefined;
      }
      px = { data, alpha };
      this.o.cache.set(key, px);
    }
    const { data, alpha } = px;
    lx.i = endMark >= base + need && endMark - (base + need) < 16 ? endMark + 9 : base + need;
    const cs = chans === 1 ? "gray" : chans === 4 ? "cmyk" : "rgb";
    // Illustrator's raster matrix maps pixel (u, v) — v down the rows — to (e + a u − c v, f + b u − d v)
    const [a, b, c, d, e, f] = mat;
    const m: Mat = [a * w, b * w, c * h, d * h, e - c * h, f - d * h];
    const node: ImageNode = { t: "image", m, w, h, cs, data, alpha, xp: { ...this.gs.xp } };
    if (!this.hiddenNow()) this.add(node);
    else this.lastObj = node;
  }

  /**
   * A placed (linked) file: Illustrator keeps its own preview of it (%AI26_BeginPlacedObjectPreview: width height
   * rowbytes 32 … '@' + RGBA rows) inside the place block; that preview is drawn in the placed bounds.
   */
  private placed(lx: Lexer) {
    const s = lx.s;
    const end = this.find("%AI5_EndPlace", lx.i);
    const stop = end < 0 || end > lx.end ? lx.end : end;
    const block = s.slice(lx.i, Math.min(stop, lx.i + 4096));
    // header: [a b c d tx ty] x0 y0 x1 y1 …
    const N = "(-?[\\d.eE+-]+)";
    const hm = new RegExp(`\\[\\s*${N}\\s+${N}\\s+${N}\\s+${N}\\s+${N}\\s+${N}\\s*\\]\\s+${N}\\s+${N}\\s+${N}\\s+${N}`).exec(block);
    const pv = this.find("%AI26_BeginPlacedObjectPreview", lx.i);
    let drawn = false;
    if (hm && pv >= 0 && pv < stop) {
      const M = hm.slice(1, 7).map(Number) as Mat;
      const [x0, y0, x1, y1] = hm.slice(7, 11).map(Number);
      const after = s.indexOf("\n", pv) + 1;
      const hdr = /^\s*(\d+) (\d+) (\d+) (\d+) (\d+) @/.exec(s.slice(after, after + 64));
      if (hdr) {
        const [w, h, rowBytes, bpp] = hdr.slice(1, 5).map(Number);
        const d0 = after + hdr[0].length;
        if (bpp === 32 && w > 0 && h > 0 && w * h <= MAX_IMAGE_PX && rowBytes >= w * 4 && d0 + rowBytes * h <= stop) {
          const key = `PL${d0}:${w}:${h}:${rowBytes}`;
          let px = this.o.cache.get(key) as { data: Uint8Array; alpha: Uint8Array; opaque: boolean } | undefined;
          if (!px) {
            const data = new Uint8Array(w * h * 3);
            const alpha = new Uint8Array(w * h);
            let opaque = true;
            for (let yy = 0; yy < h; yy++)
              for (let xx = 0; xx < w; xx++) {
                const p = d0 + yy * rowBytes + xx * 4;
                const o = yy * w + xx;
                data[o * 3] = s.charCodeAt(p) & 255;
                data[o * 3 + 1] = s.charCodeAt(p + 1) & 255;
                data[o * 3 + 2] = s.charCodeAt(p + 2) & 255;
                alpha[o] = s.charCodeAt(p + 3) & 255;
                if (alpha[o] !== 255) opaque = false;
              }
            px = { data, alpha, opaque };
            this.o.cache.set(key, px);
          }
          const { data, alpha, opaque } = px;
          // corners of the placed bounds (y down in the place space) through the place matrix
          const BL = apply(M, x0, y1), BR = apply(M, x1, y1), TL = apply(M, x0, y0);
          const m: Mat = [BR[0] - BL[0], BR[1] - BL[1], TL[0] - BL[0], TL[1] - BL[1], BL[0], BL[1]];
          if (!this.hiddenNow()) this.add({ t: "image", m, w, h, cs: "rgb", data, alpha: opaque ? undefined : alpha, xp: { ...this.gs.xp } });
          drawn = true;
        }
      }
    }
    this.note(drawn ? "placed-preview" : "placed-missing");
    lx.i = stop < lx.end ? stop + 13 : lx.end;
  }

  // ── dictionary objects: /Name : … ; ──
  private dictObject(name: string, lx: Lexer) {
    // read up to the matching ';' (nested /X : … ; objects inside, e.g. a text frame's confining path)
    const toks: Tok[] = [];
    const from = lx.i;
    let depth = 1;
    let guard = 0;
    for (let t = lx.next(); t; t = lx.next()) {
      if (++guard > 5_000_000) break;
      // counted with the rest: a symbol re-reads its dictionaries at every instance
      if (++this.o.work.n > MAX_WORK) throw new Error("ai native: too much work");
      if (t.k === "op" && t.v === ":") depth++;
      else if (t.k === "op" && t.v === ";") {
        if (--depth === 0) break;
      }
      if (t.k === "mark") continue;
      toks.push(t);
    }
    if (name === "SymbolInstance") return this.symbolInstance(toks);
    if (name === "AI11Text") return this.text(toks);
    if (name === "ForeignObject") return this.foreign(lx, from);
    // ArtDictionary, BlendStyle, … : no art of their own
  }

  private symbolInstance(toks: Tok[]) {
    const ref = toks.find((t) => t.k === "s");
    const ni = toks.findIndex((t) => t.k === "name" && t.v === "RTransformMatrix");
    const m = ni >= 0 ? numsOf(toks.slice(Math.max(0, ni - 6), ni)) : [];
    if (!ref || m.length < 6) return;
    const def = this.o.symbols.get((ref as { v: string }).v);
    if (!def) {
      this.note("symbol-missing");
      return;
    }
    if (this.depthSym > 8) return;
    const g: GroupNode = { t: "group", kids: [], xp: { ...XP_NORMAL }, m: m as Mat };
    const sub = new Interpreter(this.o, g);
    sub.depthSym = this.depthSym + 1;
    sub.nodes = this.nodes;
    try {
      sub.run(new Lexer(this.o.source, def.start, def.end));
      sub.closeAll();
    } catch {
      this.note("symbol-damaged");
    }
    this.nodes = sub.nodes;
    if (!g.kids.length) return;
    const only = g.kids[0];
    if (g.kids.length === 1 && only.t === "group" && !only.m && !only.clip && only.xp.opacity >= 1 && !only.xp.mode) g.kids = only.kids;
    // the instance's own transparency comes after it (applyXy, knockout field 2) — not the state's
    if (!this.hiddenNow()) this.add(g);
    this.lastObj = g;
  }

  private text(toks: Tok[]) {
    const si = toks.findIndex((t) => t.k === "name" && t.v === "StoryIndex");
    const fi = toks.findIndex((t) => t.k === "name" && t.v === "FrameIndex");
    const story = si > 0 && toks[si - 1].k === "n" ? (toks[si - 1] as { v: number }).v : -1;
    const frame = fi > 0 && toks[fi - 1].k === "n" ? (toks[fi - 1] as { v: number }).v : 0;
    const L = this.o.text;
    const node = L && story >= 0 ? L.frame(story, frame) : null;
    if (L) for (const k of L.takeNotes()) this.note(k);
    if (!node) {
      this.note("text-unread");
      return;
    }
    if (!node.runs.length) return;
    if (!this.hiddenNow()) this.add(node);
    this.lastObj = node;
  }

  private foreign(lx: Lexer, from: number) {
    // decoded once per place in the source (a symbol's imported PDF, drawn at every instance); a new node each time
    const key = `FO${from}`;
    let c = this.o.cache.get(key) as ForeignNode | null | undefined;
    if (c === undefined) {
      c = foreignObject(lx.s.slice(from, lx.i));
      this.o.cache.set(key, c);
    }
    const r: ForeignNode | null = c ? { ...c, box: { ...c.box }, xp: { ...XP_NORMAL } } : null;
    if (!r) {
      this.note("foreign-missing");
      return;
    }
    this.note("foreign");
    if (!this.hiddenNow()) this.add(r);
  }

  closeAll() {
    while (this.cont.length > 1) this.finish(this.cont.pop()!);
  }
}

// ───────── setup scan ─────────

function findSymbols(s: string, from: number, to: number): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  let i = from;
  let guard = 0;
  while (guard++ < 100_000) {
    const a = s.indexOf("%AI14_BeginSymbol", i);
    if (a < 0 || a > to) break;
    const e = s.indexOf("%AI10_EndSymbol", a);
    if (e < 0) break;
    // (name) right after the marker line
    const lx = new Lexer(s, s.indexOf("\n", a) + 1, e);
    const t = lx.next();
    if (t && t.k === "s") out.set(t.v, { start: lx.i, end: e });
    i = e + 15;
  }
  return out;
}

function findPatterns(s: string, from: number, to: number, o: Omit<InterpretOptions, "source" | "cache">): Map<string, { box: Box; art: Node[] }> {
  const out = new Map<string, { box: Box; art: Node[] }>();
  let i = from;
  let guard = 0;
  while (guard++ < 10_000) {
    const a = s.indexOf("%AI3_BeginPattern", i);
    if (a < 0 || a > to) break;
    const e = s.indexOf("%AI3_EndPattern", a);
    if (e < 0) break;
    i = e + 15;
    const lx = new Lexer(s, s.indexOf("\n", a) + 1, e);
    const nm = lx.next();
    const nums: number[] = [];
    for (let k = 0; k < 4; k++) {
      const t = lx.next();
      if (t && t.k === "n") nums.push(t.v);
    }
    if (!nm || nm.k !== "s" || nums.length < 4) continue;
    const body = unhide(s.slice(lx.i, e));
    const root: GroupNode = { t: "group", kids: [], xp: { ...XP_NORMAL } };
    const it = new Interpreter({ ...o, source: body, symbols: new Map(), cache: new Map() }, root);
    try {
      it.run(new Lexer(body, 0, body.length));
      it.closeAll();
    } catch {
      continue;
    }
    const [x0, y0, x1, y1] = nums;
    if (x1 - x0 > 0.01 && y1 - y0 > 0.01) out.set(nm.v, { box: { x0, y0, x1, y1 }, art: root.kids });
  }
  return out;
}

/**
 * Named paints (/KnownStyle : (name) /Name , /SimpleStyle : <style operators> /Paint ;): the text document refers to
 * them for its fills ("Anon …"), e.g. a gradient fill of text.
 */
function knownPaints(s: string, from: number, to: number, o: Omit<InterpretOptions, "source" | "cache">): Map<string, Paint> {
  const out = new Map<string, Paint>();
  const re = /\/KnownStyle :\s*\(([^()\\]*)\) \/Name ,\s*\/SimpleStyle :([\s\S]{0,4000}?)\/Paint ;/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(s)) && m.index < to && guard++ < 10_000) {
    const body = m[2];
    const root: GroupNode = { t: "group", kids: [], xp: { ...XP_NORMAL } };
    const it = new Interpreter({ ...o, source: body, symbols: new Map(), text: null, cache: new Map() }, root);
    try {
      it.run(new Lexer(body, 0, body.length));
    } catch {
      continue;
    }
    out.set(m[1], it.gs.fill);
  }
  return out;
}

/** The document ruler origin (canvas coordinates, y down) — text layout is written relative to it. */
function rulerOrigin(s: string, from: number, to: number): [number, number] | null {
  const k = s.lastIndexOf("/RulerOrigin ,", to);
  if (k < from) return null;
  const m = /(-?[\d.]+) (-?[\d.]+)\s*$/.exec(s.slice(Math.max(from, k - 80), k));
  return m ? [+m[1], +m[2]] : null;
}

/** Read the native document (latin1 string) into a scene. Null when it is not Illustrator's native format. */
export function interpretNative(native: string): NativeDoc | null {
  if (!native.startsWith("%!PS-Adobe")) return null;
  const endSetup = native.indexOf("%%EndSetup");
  if (endSetup < 0) return null;
  const ec = native.indexOf("%%EndComments");
  const header = native.slice(0, ec > 0 ? ec : Math.min(native.length, 20000));
  const cmyk = /%AI9_ColorModel: 2\b/.test(header);
  const notes = new Map<string, number>();
  const setupStart = Math.max(0, native.indexOf("%%BeginSetup"));
  const gradients = parseGradients(native.slice(setupStart, endSetup), cmyk);
  const symbols = findSymbols(native, setupStart, endSetup);
  const base = { gradients, symbols, cmyk, text: null as TextLayout | null, notes, work: { n: 0 } };
  const paints = knownPaints(native, setupStart, endSetup, base);
  try {
    base.text = readTextLayout(native, rulerOrigin(native, setupStart, endSetup), paints);
  } catch {
    notes.set("text-unread", 1);
  }
  const patterns = findPatterns(native, setupStart, endSetup, base);
  const artEnd = native.indexOf("%%PageTrailer", endSetup);
  const root: GroupNode = { t: "group", kids: [], xp: { ...XP_NORMAL } };
  const it = new Interpreter({ ...base, source: native, cache: new Map() }, root);
  try {
    it.run(new Lexer(native, endSetup + 10, artEnd < 0 ? native.length : artEnd));
  } catch {
    notes.set("damaged", 1);
  }
  it.closeAll();
  const artboards = readArtboards(native.slice(setupStart, endSetup), header);
  if (!artboards.length) {
    const b = emptyBox();
    root.kids.forEach((k) => unionBox(b, nodeBox(k)));
    if (!boxOk(b)) return null;
    artboards.push({ name: "", box: b });
  }
  return { artboards, art: root.kids, cmyk, patterns, notes };
}

/** The native document of an .ai saved without PDF content (decompressed, latin1), or null. */
export async function readNativeDocument(bytes: Uint8Array): Promise<string | null> {
  return aiNativeText(await openSurgeonDoc(bytes));
}
