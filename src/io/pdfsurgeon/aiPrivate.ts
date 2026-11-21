// PDF Surgeon — mirror edits into Adobe Illustrator's private data so an edited .ai reopens in Illustrator
// with its layers, hidden layers and editable text.
//
// A PDF-compatible .ai keeps Illustrator's own document in the page-piece dictionary
// (/PieceInfo /Illustrator /Private: AIPrivateData1…n streams, NumBlock n). Illustrator 24+ writes it as
// '%AI24_ZStandard_Data' + one zstd frame (older versions: '%AI12_CompressedData' + zlib). Decompressed it is
// Illustrator's PostScript-like native format:
//   * the art section (after %%EndSetup): layers (%AI5_BeginLayer … Lb … LB), paths as `x y m / L / C …` followed
//     by a paint operator (f F s S b B n N), the colour state set by operators such as `c m y k r g b Xa` (fill) and
//     `XA` (stroke) and inherited by the following objects;
//   * the text document (/AI11TextDocument, ASCII85 lines starting with '%'): a key/value structure with numeric
//     keys; each story holds its text (UTF-16BE string), style runs (arrays of dictionaries with a run length /1;
//     a story in the default styles has none in its /0, only the view's) and a cached layout (/1 /2 — dropped on
//     edit; Illustrator lays the story out again when it opens the file).
//
// Supported here: replacing text inside a story (point, area and path text), and changing a path's fill colour,
// stroke colour or stroke width. Anything else (moved or reshaped objects, deleted or added objects, style changes
// of text, compound paths, gradient fills…) is reported as not mirrorable, and the caller falls back to removing
// the private data (with a notice). Written back as one zstd frame (zstd.ts's LZ encoder).

import { PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";
import { Unzlib } from "fflate";
import { dictOf, look, pageDict, type SurgeonDoc } from "./document";
import { ZSTD_MAX_OUTPUT, zstdCompress, zstdDecompress } from "../zstd";

const ZSTD_HEAD = "%AI24_ZStandard_Data";
const ZLIB_HEAD = "%AI12_CompressedData";
const PIECE = 65536;

export interface AiTextEdit {
  /** the line's text before the edit (paragraphs joined with "\n") */
  from: string;
  to: string;
}

export interface AiStyleEdit {
  pageIndex: number;
  /** anchor and control points of the path in PDF default user space */
  points: [number, number][];
  /** new fill / stroke colour (0..1 RGB); null = none */
  fill: [number, number, number] | null;
  stroke: [number, number, number] | null;
  /** new stroke width as a factor of the old one (1 = unchanged) */
  widthScale: number;
  fillChanged: boolean;
  strokeChanged: boolean;
}

export interface AiMirror {
  texts: AiTextEdit[];
  styles: AiStyleEdit[];
  /** every painted path of the edited pages (PDF user space) — used to find the page → native offset */
  pagePaths: Map<number, [number, number][][]>;
}

export type MirrorResult = { ok: true } | { ok: false; reason: string };

interface Private {
  ref: PDFRef;
  dict: PDFDict;
  keys: string[];
  head: "zstd" | "zlib" | "raw";
  data: Uint8Array;
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return s;
};
const bytesOf = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
};

/** The Illustrator /Private dictionary shared by the pages (null when absent or when pages disagree). */
function privateRef(doc: SurgeonDoc): { ref: PDFRef; dict: PDFDict } | null {
  let found: PDFRef | null = null;
  for (let i = 0; i < doc.pageRefs.length; i++) {
    const pi = dictOf(look(doc.ctx, pageDict(doc, i).get(PDFName.of("PieceInfo"))));
    const ill = dictOf(look(doc.ctx, pi?.get(PDFName.of("Illustrator"))));
    if (!ill) continue;
    const raw = ill.get(PDFName.of("Private"));
    if (!(raw instanceof PDFRef)) return null;
    if (found && (found.objectNumber !== raw.objectNumber || found.generationNumber !== raw.generationNumber)) return null;
    found = raw;
  }
  const dict = found ? dictOf(doc.ctx.lookup(found)) : undefined;
  return found && dict ? { ref: found, dict } : null;
}

function readPrivate(doc: SurgeonDoc): Private | null {
  const p = privateRef(doc);
  if (!p) return null;
  const keys = p.dict
    .keys()
    .map((k) => k.decodeText())
    .filter((k) => /^AIPrivateData\d+$/.test(k))
    .sort((a, b) => +a.slice(13) - +b.slice(13));
  if (!keys.length) return null;
  const parts: Uint8Array[] = [];
  for (const k of keys) {
    const st = look(doc.ctx, p.dict.get(PDFName.of(k)));
    if (!(st instanceof PDFRawStream) || st.dict.get(PDFName.of("Filter"))) return null;
    parts.push(st.contents);
  }
  const all = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of parts) (all.set(b, o), (o += b.length));
  const head = latin1(all.subarray(0, 24));
  if (head.startsWith(ZSTD_HEAD)) return { ...p, keys, head: "zstd", data: zstdDecompress(all.subarray(ZSTD_HEAD.length)) };
  if (head.startsWith(ZLIB_HEAD)) return { ...p, keys, head: "zlib", data: inflateCapped(all.subarray(ZLIB_HEAD.length), ZSTD_MAX_OUTPUT) };
  return { ...p, keys, head: "raw", data: all };
}

/**
 * zlib data inflated with a ceiling on the output: a few KB of hostile input can claim gigabytes (the private data,
 * a /ForeignObject's PDF); past `max` bytes it throws instead of allocating.
 */
export function inflateCapped(src: Uint8Array, max: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const z = new Unzlib((chunk) => {
    total += chunk.length;
    if (total > max) throw new Error("zlib: output larger than the limit");
    parts.push(chunk);
  });
  // fed in small pieces: fflate hands over what one push produced, so a piece bounds the output held at once
  const STEP = 16384;
  for (let i = 0; i < src.length; i += STEP) z.push(src.subarray(i, i + STEP), i + STEP >= src.length);
  if (!src.length) z.push(src, true);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of parts) (out.set(b, o), (o += b.length));
  return out;
}

/** Illustrator's native document of an .ai (decompressed, latin1), or null. */
export function aiNativeText(doc: SurgeonDoc): string | null {
  const p = readPrivate(doc);
  return p ? latin1(p.data) : null;
}

// ───────── ASCII85 ─────────

export function a85decode(s: string): Uint8Array {
  const end = s.indexOf("~>");
  if (end >= 0) s = s.slice(0, end);
  const out: number[] = [];
  const g: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 122 && !g.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    g.push(c - 33);
    if (g.length === 5) {
      let v = 0;
      for (const x of g) v = v * 85 + x;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      g.length = 0;
    }
  }
  if (g.length) {
    const n = g.length;
    while (g.length < 5) g.push(84);
    let v = 0;
    for (const x of g) v = v * 85 + x;
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

export function a85encode(b: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < b.length; i += 4) {
    const n = Math.min(4, b.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? b[i + k] : 0);
    if (n === 4 && v === 0) {
      parts.push("z");
      continue;
    }
    const d = new Array<string>(5);
    for (let k = 4; k >= 0; k--) {
      d[k] = String.fromCharCode(33 + (v % 85));
      v = Math.floor(v / 85);
    }
    parts.push(d.join("").slice(0, n + 1));
  }
  return parts.join("") + "~>";
}

/**
 * ASCII85 as Illustrator writes it in its native file: lines of '%' + `width` characters, the end mark '~>' always
 * whole on the last line. (Split over two lines — '…~' then '%>' — Illustrator reads none of the text document and
 * opens an EMPTY document, without a warning.)
 */
export function a85Lines(b: Uint8Array, width: number): string[] {
  const body = a85encode(b).slice(0, -2);
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += width) lines.push("%" + body.slice(i, i + width));
  if (lines.length && lines[lines.length - 1].length + 1 <= width) lines[lines.length - 1] += "~>";
  else lines.push("%~>");
  return lines;
}

// ───────── text document ─────────

type PNode =
  | { t: "d"; s: number; e: number; kv: [string, PNode][] }
  | { t: "a"; s: number; e: number; items: PNode[] }
  | { t: "s"; s: number; e: number }
  | { t: "o"; s: number; e: number; v: string };

const WS = /[\s\0]/;
const DELIM = "<>[]()/";

class TdParser {
  constructor(private s: string) {}
  i = 0;
  private ws() {
    while (this.i < this.s.length && WS.test(this.s[this.i])) this.i++;
  }
  value(): PNode {
    this.ws();
    const s = this.s;
    const st = this.i;
    if (s.startsWith("<<", st)) {
      this.i += 2;
      const kv = this.entries(">>");
      this.i += 2;
      return { t: "d", s: st, e: this.i, kv };
    }
    if (s[st] === "[") {
      this.i++;
      const items: PNode[] = [];
      for (;;) {
        this.ws();
        if (this.i >= s.length) throw new Error("ai text: unterminated array");
        if (s[this.i] === "]") break;
        items.push(this.value());
      }
      this.i++;
      return { t: "a", s: st, e: this.i, items };
    }
    if (s[st] === "(") {
      let depth = 0;
      for (let k = st; k < s.length; k++) {
        const c = s[k];
        if (c === "\\") k++;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) {
          this.i = k + 1;
          return { t: "s", s: st, e: this.i };
        }
      }
      throw new Error("ai text: unterminated string");
    }
    if (s[st] === "<") {
      const e = s.indexOf(">", st);
      if (e < 0) throw new Error("ai text: unterminated hex string");
      this.i = e + 1;
      return { t: "o", s: st, e: this.i, v: s.slice(st, this.i) };
    }
    let k = st + 1;
    while (k < s.length && !WS.test(s[k]) && !DELIM.includes(s[k])) k++;
    if (k === st + 1 && DELIM.includes(s[st]) && s[st] !== "/") throw new Error("ai text: unexpected " + s[st]);
    this.i = k;
    return { t: "o", s: st, e: k, v: s.slice(st, k) };
  }
  entries(close: string | null): [string, PNode][] {
    const kv: [string, PNode][] = [];
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) {
        if (close) throw new Error("ai text: unterminated dictionary");
        return kv;
      }
      if (close && this.s.startsWith(close, this.i)) return kv;
      const k = this.value();
      if (k.t !== "o" || !k.v.startsWith("/")) throw new Error("ai text: key expected");
      kv.push([k.v.slice(1), this.value()]);
    }
  }
}

const get = (n: PNode | undefined, k: string): PNode | undefined => (n?.t === "d" ? n.kv.find((e) => e[0] === k)?.[1] : undefined);

/** PostScript string body → bytes (latin1 string). */
function psString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "t") out += "\t";
    else if (n === "b") out += "\b";
    else if (n === "f") out += "\f";
    else if (n === "\r" || n === "\n") {
      if (n === "\r" && raw[i + 1] === "\n") i++;
    } else if (/[0-7]/.test(n)) {
      let o = n;
      while (o.length < 3 && /[0-7]/.test(raw[i + 1] ?? "")) o += raw[++i];
      out += String.fromCharCode(parseInt(o, 8) & 255);
    } else out += n;
  }
  return out;
}

const utf16 = (b: string) => {
  let s = "";
  for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b.charCodeAt(i) << 8) | b.charCodeAt(i + 1));
  return s;
};

function utf16String(text: string): string {
  let out = "(þÿ";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    for (const x of [c >> 8, c & 255]) out += (x === 0x5c || x === 0x28 || x === 0x29 ? "\\" : "") + String.fromCharCode(x);
  }
  return out + ")";
}

interface Story {
  node: PNode;
  textNode: PNode;
  text: string;
  /** run arrays: each item's length node */
  runs: { arr: PNode & { t: "a" }; lens: { node: PNode; item: PNode; v: number }[] }[];
  cache: PNode | undefined;
}

/**
 * A story: << /0 << /0 (UTF-16BE text) /5 paragraph runs? /6 style runs? /10 … >> /1 << view: /0 /1 runs /2 cache … >> >>.
 * Illustrator leaves out /6 (and /5) when the whole story uses the default styles — e.g. qa ai_text_only.ai, one point
 * text in the default font: its only run array is the view's /1 /0. Such a story is still recognised by its view
 * dictionary with the layout cache (/2 array); a font entry (<< /99 /CoolTypeFont … /0 << /0 (name) >> >>) has no
 * view and stays out, so a line that happens to equal a font name is never written into the font list.
 */
function isStory(n: PNode & { t: "d" }, S: PNode | undefined): boolean {
  if (S?.t !== "d" || get(n, "99") || get(S, "99")) return false;
  if (get(S, "6")?.t === "d") return true;
  const view = get(n, "1");
  return view?.t === "d" && get(view, "2")?.t === "a" && get(view, "0")?.t === "a";
}

function storiesOf(td: string, root: PNode): Story[] {
  const out: Story[] = [];
  const walk = (n: PNode) => {
    if (n.t === "a") return n.items.forEach(walk);
    if (n.t !== "d") return;
    const S = get(n, "0");
    const str = get(S, "0");
    if (str?.t === "s" && isStory(n, S)) {
      const bytes = psString(td.slice(str.s + 1, str.e - 1));
      if (bytes.startsWith("þÿ")) {
        const text = utf16(bytes);
        const view = get(n, "1");
        const cache = get(view, "2");
        const runs: Story["runs"] = [];
        const findRuns = (x: PNode) => {
          if (x === cache) return;
          if (x.t === "d") return x.kv.forEach((e) => findRuns(e[1]));
          if (x.t !== "a") return;
          const lens = x.items.map((it) => {
            const l = get(it, "1");
            return l?.t === "o" && /^\d+$/.test(l.v) ? { node: l, item: it, v: +l.v } : null;
          });
          if (x.items.length && lens.every(Boolean) && lens.reduce((a, l) => a + l!.v, 0) === text.length) runs.push({ arr: x, lens: lens as Story["runs"][0]["lens"] });
          else x.items.forEach(findRuns);
        };
        findRuns(n);
        out.push({ node: n, textNode: str, text, runs, cache });
        return;
      }
    }
    n.kv.forEach((e) => walk(e[1]));
  };
  walk(root);
  return out;
}

/**
 * Adjust run lengths for replacing `del` characters at `pos` with `ins` characters. The inserted characters join the
 * run of the character before `pos`, or with `atStart` (the edit starts a line) the run of the character at `pos` —
 * the same rule write.ts's textOnlyChanged checks the PDF edit against.
 */
function editRuns(lens: number[], pos: number, del: number, ins: number, atStart = false): number[] {
  const out = [...lens];
  // removal
  let at = 0;
  let left = del;
  for (let i = 0; i < out.length && left > 0; i++) {
    const s = at, e = at + out[i];
    at = e;
    const a = Math.max(s, pos), b = Math.min(e, pos + del);
    if (b > a) {
      out[i] -= b - a;
      left -= b - a;
    }
  }
  // insertion: the run holding the character before pos (or the first run; with atStart the one at pos)
  const ref = atStart ? Math.min(pos, Math.max(0, lens.reduce((a, b) => a + b, 0) - 1)) : pos - 1;
  at = 0;
  let target = 0;
  for (let i = 0; i < lens.length; i++) {
    if (ref >= at) target = i;
    at += lens[i];
  }
  if (out[target] === 0 && pos > 0 && !atStart) {
    // the run before was removed entirely; use the next non-empty one
    const k = out.findIndex((v, i) => i >= target && v > 0);
    if (k >= 0) target = k;
  }
  out[target] += ins;
  return out;
}

/** tab, no-break and figure / narrow no-break spaces → space (same length) */
const foldSpaces = (s: string) => s.replace(/[\t   ]/g, " ");

/** @internal exported for tests */
export function editTextDocument(native: string, edits: AiTextEdit[]): { native: string } | { reason: string } {
  const key = "/AI11TextDocument : /ASCII85Decode ,";
  const a = native.indexOf(key);
  if (a < 0) return { reason: "no text document" };
  const ls = native.indexOf("\n", a) + 1;
  let p = ls;
  while (native[p] === "%") {
    const e = native.indexOf("\n", p);
    if (e < 0) return { reason: "text document truncated" };
    p = e + 1;
  }
  const block = native.slice(ls, p);
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const width = Math.max(64, ...block.split(/\r?\n/).map((l) => l.length - 1));
  const td = latin1(a85decode(block.split(/\r?\n/).map((l) => l.slice(1)).join("")));
  let root: PNode;
  try {
    root = { t: "d", s: 0, e: td.length, kv: new TdParser(td).entries(null) };
  } catch {
    return { reason: "text document not understood" };
  }
  const stories = storiesOf(td, root);
  const state = stories.map((s) => ({ text: s.text, runs: s.runs.map((r) => r.lens.map((l) => l.v)), touched: false }));
  for (const ed of edits) {
    const from = ed.from.replace(/\r?\n/g, "\r");
    const to = ed.to.replace(/\r?\n/g, "\r");
    if (!from) return { reason: "empty line" };
    let hit = -1;
    let at = -1;
    let count = 0;
    const find = (f: (s: string) => string) => {
      const needle = f(from);
      state.forEach((st, i) => {
        const hay = f(st.text);
        for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) {
          count++;
          hit = i;
          at = k;
        }
      });
    };
    find((s) => s);
    // the PDF line may show a tab or a no-break space of the story as a plain space: compare with those folded (one
    // character for one, so positions stay the story's); still exactly one match or nothing is written
    if (!count) find(foldSpaces);
    if (count !== 1) return { reason: count ? "text found more than once" : "text not found" };
    const st = state[hit];
    if (!stories[hit].runs.length) return { reason: "story runs not understood" };
    // replace only the differing middle so runs around it keep their styles
    let pre = 0;
    while (pre < from.length && pre < to.length && from[pre] === to[pre]) pre++;
    let suf = 0;
    while (suf < from.length - pre && suf < to.length - pre && from[from.length - 1 - suf] === to[to.length - 1 - suf]) suf++;
    const pos = at + pre, del = from.length - pre - suf, ins = to.length - pre - suf;
    st.text = st.text.slice(0, pos) + to.slice(pre, to.length - suf) + st.text.slice(pos + del);
    st.runs = st.runs.map((r) => editRuns(r, pos, del, ins, pre === 0));
    st.touched = true;
  }
  const splices: { s: number; e: number; text: string }[] = [];
  state.forEach((st, i) => {
    if (!st.touched) return;
    const story = stories[i];
    splices.push({ s: story.textNode.s, e: story.textNode.e, text: utf16String(st.text) });
    story.runs.forEach((r, k) => {
      r.lens.forEach((l, j) => {
        const v = st.runs[k][j];
        if (v > 0) splices.push({ s: l.node.s, e: l.node.e, text: String(v) });
        else splices.push({ s: l.item.s, e: l.item.e, text: "" });
      });
    });
    if (story.cache?.t === "a") splices.push({ s: story.cache.s, e: story.cache.e, text: "[ ]" });
  });
  splices.sort((x, y) => y.s - x.s);
  let out = td;
  for (const sp of splices) out = out.slice(0, sp.s) + sp.text + out.slice(sp.e);
  const lines = a85Lines(bytesOf(out), width);
  return { native: native.slice(0, ls) + lines.join(eol) + eol + native.slice(p) };
}

// ───────── art section ─────────

interface ArtPath {
  start: number;
  paintS: number;
  paintE: number;
  paint: string;
  pts: [number, number][];
  fillOp: string | null;
  strokeOp: string | null;
  width: number;
  editable: boolean;
}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const PAINT = new Set(["N", "n", "F", "f", "S", "s", "B", "b"]);
const COORDS: Record<string, number> = { m: 2, L: 2, l: 2, C: 6, c: 6, V: 4, v: 4, Y: 4, y: 4 };
const FILL_OPS = new Set(["Xa", "k", "g"]);
const STROKE_OPS = new Set(["XA", "K", "G"]);

function artPaths(s: string, from: number, to: number): ArtPath[] {
  const paths: ArtPath[] = [];
  const ops: { s: number; e: number; v: string }[] = [];
  let fillOp: string | null = null, strokeOp: string | null = null, width = 1;
  let inArt = 0, compound = 0;
  let cur: ArtPath | null = null;
  let i = from;
  const flush = (v: string, s0: number, e0: number) => {
    if (NUM.test(v) || v.startsWith("/") || v === "[" || v === "]" || v.startsWith("(") || v.startsWith("<")) {
      ops.push({ s: s0, e: e0, v });
      return;
    }
    const args = ops.splice(0);
    const n = args.map((a) => +a.v);
    if (v in COORDS) {
      const need = COORDS[v];
      if (args.length < need) return void (cur = null);
      const a = args.slice(-need);
      if (v === "m" && !cur) cur = { start: a[0].s, paintS: 0, paintE: 0, paint: "", pts: [], fillOp, strokeOp, width, editable: !inArt && !compound };
      if (!cur) return;
      const nn = n.slice(-need);
      for (let k = 0; k < need; k += 2) cur.pts.push([nn[k], nn[k + 1]]);
      return;
    }
    if (PAINT.has(v)) {
      if (cur) {
        cur.paintS = s0;
        cur.paintE = e0;
        cur.paint = v;
        paths.push(cur);
      }
      cur = null;
      return;
    }
    const opText = args.length ? s.slice(args[0].s, e0) : v;
    if (FILL_OPS.has(v)) fillOp = opText;
    else if (STROKE_OPS.has(v)) strokeOp = opText;
    else if (v === "w" && args.length) width = n[n.length - 1];
    else if (v === "X=") inArt++;
    else if (v === "X+") inArt = Math.max(0, inArt - 1);
    else if (v === "*u") compound++;
    else if (v === "*U") compound = Math.max(0, compound - 1);
    else if (/^[a-zA-Z]$/.test(v) && cur && v !== "h") cur.editable = false; // something odd inside a path
    else if (v === "x" || v === "X" || v === "Xk" || v === "XK" || v === "Bb" || v === "Bg" || v === "p" || v === "P") {
      // fill/stroke set by a custom colour, gradient or pattern: not a simple colour op
      if (v === "X" || v === "XK" || v === "P") strokeOp = null;
      else fillOp = null;
    }
  };
  while (i < to) {
    const c = s[i];
    if (c === "%") {
      if (s.startsWith("%%BeginData", i)) {
        const e = s.indexOf("%%EndData", i);
        i = e < 0 ? to : e + 9;
        continue;
      }
      const e = s.indexOf("\n", i);
      i = e < 0 ? to : e + 1;
      continue;
    }
    if (WS.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      let depth = 0, k = i;
      for (; k < to; k++) {
        if (s[k] === "\\") k++;
        else if (s[k] === "(") depth++;
        else if (s[k] === ")" && --depth === 0) break;
      }
      flush(s.slice(i, k + 1), i, k + 1);
      i = k + 1;
      continue;
    }
    if (c === "[" || c === "]" || c === "{" || c === "}") {
      flush(c === "{" || c === "}" ? "[" : c, i, i + 1);
      i++;
      continue;
    }
    let k = i + 1;
    while (k < to && !WS.test(s[k]) && !"()[]{}%".includes(s[k])) k++;
    flush(s.slice(i, k), i, k);
    i = k;
  }
  return paths;
}

const fmt = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};

/**
 * A colour operator in the document's colour mode: `c m y k r g b Xa`/`XA` in an RGB document, `c m y k k`/`K` in a
 * CMYK document (%AI9_ColorModel: 2) — an RGB colour there would make Illustrator mix colour modes in one document.
 */
function colourOp([r, g, b]: [number, number, number], stroke: boolean, cmyk: boolean) {
  const k = 1 - Math.max(r, g, b);
  const ink = (v: number) => (k >= 1 ? 0 : (1 - v - k) / (1 - k));
  if (cmyk) return [ink(r), ink(g), ink(b), k].map(fmt).join(" ") + (stroke ? " K" : " k");
  return [ink(r), ink(g), ink(b), k, r, g, b].map(fmt).join(" ") + (stroke ? " XA" : " Xa");
}

const R2 = (v: number) => Math.round(v * 100) / 100;
function uniq(pts: [number, number][]): [number, number][] {
  const m = new Map<string, [number, number]>();
  for (const p of pts) m.set(`${R2(p[0])},${R2(p[1])}`, p);
  return [...m.values()];
}
function bbox(pts: [number, number][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}
const shapeKey = (u: [number, number][]) => {
  const b = bbox(u);
  return `${u.length}:${Math.round(b.w * 10)}:${Math.round(b.h * 10)}`;
};
function samePoints(a: [number, number][], b: [number, number][], dx: number, dy: number, tol = 0.02) {
  if (a.length !== b.length) return false;
  return a.every(([x, y]) => b.some(([u, v]) => Math.abs(u - x - dx) <= tol && Math.abs(v - y - dy) <= tol));
}

function editArt(native: string, m: AiMirror): { native: string } | { reason: string } {
  if (!m.styles.length) return { native };
  const from = native.indexOf("%%EndSetup");
  const endAt = native.indexOf("%%PageTrailer", from);
  if (from < 0) return { reason: "art section not found" };
  const all = artPaths(native, from, endAt < 0 ? native.length : endAt);
  const cmyk = /%AI9_ColorModel: 2\b/.test(native.slice(0, from));
  const eol = native.includes("\r\n") ? "\r\n" : "\n";
  const native2 = all.map((p) => ({ p, u: uniq(p.pts) })).map((x) => ({ ...x, key: shapeKey(x.u), b: bbox(x.u) }));
  const byKey = new Map<string, typeof native2>();
  for (const n of native2) byKey.set(n.key, [...(byKey.get(n.key) ?? []), n]);
  // page → native offset, by vote over the page's paths
  const offsets = new Map<number, [number, number]>();
  for (const [page, paths] of m.pagePaths) {
    const votes = new Map<string, { n: number; d: [number, number] }>();
    for (const pts of paths) {
      const u = uniq(pts);
      if (u.length < 2) continue;
      const b = bbox(u);
      for (const n of byKey.get(shapeKey(u)) ?? []) {
        const d: [number, number] = [n.b.x0 - b.x0, n.b.y0 - b.y0];
        if (!samePoints(u, n.u, d[0], d[1])) continue;
        const k = `${Math.round(d[0] * 10)},${Math.round(d[1] * 10)}`;
        const v = votes.get(k) ?? { n: 0, d };
        v.n++;
        votes.set(k, v);
      }
    }
    const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
    if (best) offsets.set(page, best.d);
  }
  const splices: { s: number; e: number; text: string }[] = [];
  for (const ed of m.styles) {
    const d = offsets.get(ed.pageIndex);
    if (!d) return { reason: "path not found" };
    const u = uniq(ed.points);
    const hits = (byKey.get(shapeKey(u)) ?? []).filter((n) => samePoints(u, n.u, d[0], d[1]));
    if (hits.length !== 1) return { reason: hits.length ? "path found more than once" : "path not found" };
    const p = hits[0].p;
    if (!p.editable) return { reason: "compound or special path" };
    const before: string[] = [];
    const after: string[] = [];
    const hadFill = /[FfBb]/.test(p.paint), hadStroke = /[SsBb]/.test(p.paint);
    const fill = ed.fillChanged ? ed.fill : hadFill ? undefined : null;
    const stroke = ed.strokeChanged ? ed.stroke : hadStroke ? undefined : null;
    if (ed.fillChanged && ed.fill) {
      if (!p.fillOp) return { reason: "fill is not a plain colour" };
      before.push(colourOp(ed.fill, false, cmyk));
      after.push(p.fillOp);
    }
    if (ed.strokeChanged && ed.stroke) {
      if (!p.strokeOp) return { reason: "stroke is not a plain colour" };
      before.push(colourOp(ed.stroke, true, cmyk));
      after.push(p.strokeOp);
    }
    if (Math.abs(ed.widthScale - 1) > 1e-6) {
      before.push(`${fmt(p.width * ed.widthScale)} w`);
      after.push(`${fmt(p.width)} w`);
    }
    const f = fill !== null, st = stroke !== null;
    const closed = p.paint === p.paint.toLowerCase();
    let paint = f && st ? "b" : f ? "f" : st ? "s" : "n";
    if (!closed) paint = paint.toUpperCase();
    if (before.length) splices.push({ s: p.start, e: p.start, text: before.join(eol) + eol });
    splices.push({ s: p.paintS, e: p.paintE, text: paint + (after.length ? eol + after.join(eol) : "") });
  }
  splices.sort((a, b) => b.s - a.s || b.e - a.e);
  let out = native;
  for (const sp of splices) out = out.slice(0, sp.s) + sp.text + out.slice(sp.e);
  return { native: out };
}

/**
 * Apply the edits to the private data and write it back (new AIPrivateData streams, /NumBlock updated; the old
 * streams become unreferenced — the caller must write the file in full so they leave the file).
 */
export function mirrorIllustratorEdits(doc: SurgeonDoc, mark: (r: PDFRef) => void, m: AiMirror): MirrorResult {
  let priv: Private | null;
  try {
    priv = readPrivate(doc);
  } catch {
    return { ok: false, reason: "private data could not be read" };
  }
  if (!priv) return { ok: false, reason: "private data not found" };
  let native = latin1(priv.data);
  if (m.texts.length) {
    const r = editTextDocument(native, m.texts);
    if ("reason" in r) return { ok: false, reason: r.reason };
    native = r.native;
  }
  const r = editArt(native, m);
  if ("reason" in r) return { ok: false, reason: r.reason };
  native = r.native;
  writePrivate(doc, priv, bytesOf(native));
  mark(priv.ref);
  return { ok: true };
}

function writePrivate(doc: SurgeonDoc, priv: Private, data: Uint8Array) {
  const frame = zstdCompress(data);
  const head = bytesOf(ZSTD_HEAD);
  const all = new Uint8Array(head.length + frame.length);
  all.set(head);
  all.set(frame, head.length);
  for (const k of priv.keys) priv.dict.delete(PDFName.of(k));
  const n = Math.ceil(all.length / PIECE);
  for (let i = 0; i < n; i++) {
    const piece = all.slice(i * PIECE, (i + 1) * PIECE);
    const st = PDFRawStream.of(doc.ctx.obj({ Length: piece.length }) as PDFDict, piece);
    priv.dict.set(PDFName.of(`AIPrivateData${i + 1}`), doc.ctx.register(st));
  }
  priv.dict.set(PDFName.of("NumBlock"), PDFNumber.of(n));
}
