// PDF Surgeon — the text of an Illustrator file saved without PDF content, from its text document's cached layout.
//
// Illustrator keeps, next to each story's characters and styles, the layout it last computed (the story view's /2):
// frames → rows → lines → segments → glyph runs (/99 /G), each run with its glyph advances (/21 /1, cumulative) and
// its bounds in canvas coordinates (/8; y down). Drawing those runs with the story's characters and styles puts every
// character where Illustrator put it — point, area and path text, justification, tracking, kerning, super/subscript
// and baseline shift included — without laying the text out again. The fonts are named (PostScript names); the
// PDF writer leaves them unembedded so the viewer uses the installed font of that name.
//
// Structure used (aiTextDoc.ts reads the values):
//   root /0 /1 /0 [i] /0 /0 /0     font i's PostScript name
//   root /0 /8 /0 [f] /0           frame f: /0 origin, /1 /0 path points (area / path text), /2 /0 kind (1 area,
//                                  2 path), /2 /1 orientation (2 vertical), /2 /2 matrix (canvas → canvas), /2 /6 range
//   root /1 /1 [s]                 story s: /0 /0 text, /0 /6 /0 [ << /0 << /0 << /6 features >> >> /1 length >> ]
//   root /1 /2                     the document's default character features
//   features: /0 font, /1 size, /6 horizontal scale, /7 vertical scale, /53 fill paint, /54 stroke paint,
//             /56 fill on, /57 stroke on, /63 stroke width
//   story /1 /2 layout: /99 /S /15 /0 character count, /16 first character; /99 /G /1 local bounds [x0 asc x1 desc],
//             /8 canvas bounds, /10 /0 [ << /0 first character in the segment, /2 [sx sy] >> ], /21 /1 advances.
// Coordinates: canvas (y down) → art = (x − ruler x, ruler y − y).

import { a85decode } from "./aiPrivate";
import { parseTextDoc, tdArr, tdGet, tdIsDict, tdName, tdNum, tdNums, tdText, type TdDict, type TdValue } from "./aiTextDoc";
import { addPt, emptyBox, mul, type Box, type Color, type Glyph, type Mat, type Paint, type TextNode, type TextRun, XP_NORMAL } from "./aiNativeScene";

export interface TextLayout {
  /** the text object for /AI11Text … /StoryIndex story /FrameIndex frame, or null */
  frame(story: number, frame: number): TextNode | null;
  takeNotes(): string[];
}

const MAX_GLYPHS = 2_000_000;
/** layout records visited and path points searched, over the whole document: many text objects showing one large
 *  story (or path text that never reaches its glyphs' x) would otherwise repeat the walk for each */
const MAX_VISITS = 20_000_000;
/** path text: Bézier segments of a frame path that are followed */
const MAX_PATH_SEGS = 4096;

function textDocument(native: string): string | null {
  const key = "/AI11TextDocument : /ASCII85Decode ,";
  const a = native.indexOf(key);
  if (a < 0) return null;
  let p = native.indexOf("\n", a) + 1;
  if (p <= 0) return null;
  const parts: string[] = [];
  let guard = 0;
  while (native[p] === "%" && guard++ < 10_000_000) {
    let e = native.indexOf("\n", p);
    if (e < 0) e = native.length;
    parts.push(native.slice(p + 1, e).replace(/\r$/, ""));
    p = e + 1;
    if (parts[parts.length - 1].includes("~>")) break;
  }
  const b = a85decode(parts.join(""));
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
  return s;
}

function paintOf(v: TdValue | undefined, named: Map<string, Paint>): Paint | null {
  // << /99 /CAITextPaint | /SimplePaint  /0 << /0 kind /1 [alpha c…] >> /5 (named paint: /KnownStyle) >>
  const ref = named.get(tdText(tdGet(v, "5")));
  if (ref && ref.k !== "none") return ref;
  const k = tdNum(tdGet(v, "0", "0"), -1);
  const c = tdNums(tdGet(v, "0", "1"));
  if (k < 0 || !c.length) return null;
  const f = (x: number) => Math.min(1, Math.max(0, x));
  let col: Color | null = null;
  if (k === 0 && c.length >= 2) col = { cs: "gray", v: [f(c[1])] };
  else if (k === 1 && c.length >= 4) col = { cs: "rgb", v: [f(c[1]), f(c[2]), f(c[3])] };
  else if (k === 2 && c.length >= 5) col = { cs: "cmyk", v: [f(c[1]), f(c[2]), f(c[3]), f(c[4])] };
  return col ? { k: "color", c: col } : null;
}

interface Style {
  font: string;
  size: number;
  hs: number;
  vs: number;
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  /** capitalization: 1 small caps */
  caps: number;
}

/** A point of a cubic Bézier path (canvas) at arc length `d`, with its unit tangent. */
class ArcPath {
  private pts: [number, number][] = [];
  private len: number[] = [0];
  constructor(
    segs: number[][],
    private budget: { n: number },
  ) {
    for (const s of segs) {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = s;
      const steps = 32;
      for (let i = this.pts.length ? 1 : 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
        const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
        if (this.pts.length) {
          const [px, py] = this.pts[this.pts.length - 1];
          this.len.push(this.len[this.len.length - 1] + Math.hypot(x - px, y - py));
        }
        this.pts.push([x, y]);
      }
    }
  }
  /** the first arc length ≥ `from` where the path reaches x (null when it does not) */
  findX(x: number, from: number): number | null {
    // the first segment ending at or after `from` (the lengths grow): binary search, then onwards
    let lo = 0, hi = this.pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.len[mid + 1] < from) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j + 1 < this.pts.length; j++) {
      if (++this.budget.n > MAX_VISITS) return null;
      if (this.len[j + 1] < from) continue;
      const a = this.pts[j][0], b = this.pts[j + 1][0];
      if ((x - a) * (x - b) > 0) continue;
      const t = a === b ? 0 : (x - a) / (b - a);
      const d = this.len[j] + (this.len[j + 1] - this.len[j]) * t;
      if (d >= from - 1e-6) return d;
    }
    return null;
  }
  get total() {
    return this.len[this.len.length - 1] ?? 0;
  }
  at(d: number): { x: number; y: number; tx: number; ty: number } | null {
    const n = this.pts.length;
    if (n < 2) return null;
    let lo = 0, hi = n - 1;
    const D = Math.max(0, Math.min(this.total, d));
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.len[mid] <= D) lo = mid;
      else hi = mid;
    }
    const seg = this.len[hi] - this.len[lo] || 1;
    const t = (D - this.len[lo]) / seg;
    const [ax, ay] = this.pts[lo], [bx, by] = this.pts[hi];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, tx: (bx - ax) / L, ty: (by - ay) / L };
  }
}

export function readTextLayout(native: string, ruler: [number, number] | null, named: Map<string, Paint>): TextLayout | null {
  const td = textDocument(native);
  if (!td) return null;
  const root: TdDict = parseTextDoc(td);
  const [Rx, Ry] = ruler ?? [0, 0];
  const toArt: Mat = [1, 0, 0, -1, -Rx, Ry];
  const fonts = tdArr(tdGet(root, "0", "1", "0")).map((x) => tdText(tdGet(x, "0", "0", "0")));
  const frames = tdArr(tdGet(root, "0", "8", "0"));
  const stories = tdArr(tdGet(root, "1", "1"));
  const defaults = tdGet(root, "1", "2");
  const notes: string[] = [];
  let glyphCount = 0;
  const budget = { n: 0 };
  /** a text object per (story, frame): several objects naming the same frame share the work (each gets a copy) */
  const made = new Map<string, TextNode>();
  const fCache = new Map<number, TdDict[]>();

  const feature = (st: TdValue | undefined, k: string): TdValue | undefined => {
    const v = tdIsDict(st) ? st.get(k) : undefined;
    return v !== undefined ? v : tdIsDict(defaults) ? defaults.get(k) : undefined;
  };
  const styleOf = (st: TdValue | undefined): Style => {
    const fi = tdNum(feature(st, "0"), 0);
    const fill = paintOf(feature(st, "53"), named);
    const stroke = paintOf(feature(st, "54"), named);
    const fillOn = feature(st, "56") !== false;
    const strokeOn = feature(st, "57") === true;
    return {
      font: fonts[fi] || "MyriadPro-Regular",
      size: tdNum(feature(st, "1"), 12) || 12,
      hs: tdNum(feature(st, "6"), 1) || 1,
      vs: tdNum(feature(st, "7"), 1) || 1,
      fill: fillOn ? fill ?? { k: "color", c: { cs: "gray", v: [0] } } : { k: "none" },
      stroke: strokeOn && stroke ? stroke : { k: "none" },
      strokeWidth: tdNum(feature(st, "63"), 1),
      caps: tdNum(feature(st, "12"), 0),
    };
  };

  return {
    takeNotes() {
      return notes.splice(0);
    },
    frame(storyIndex: number, frameIndex: number): TextNode | null {
      const key = `${storyIndex}:${frameIndex}`;
      let node = made.get(key);
      if (!node) {
        const n = makeFrame(storyIndex, frameIndex);
        if (!n) return null;
        made.set(key, (node = n));
      }
      return { ...node, box: { ...node.box }, xp: { ...XP_NORMAL } };
    },
  };

  function makeFrame(storyIndex: number, frameIndex: number): TextNode | null {
    {
      if (budget.n > MAX_VISITS || glyphCount > MAX_GLYPHS) return null;
      const story = stories[storyIndex];
      if (!tdIsDict(story)) return null;
      const text = tdText(tdGet(story, "0", "0"));
      // style runs: [start, end, style]
      const runs: { a: number; b: number; s: Style }[] = [];
      let at = 0;
      for (const r of tdArr(tdGet(story, "0", "6", "0"))) {
        const len = tdNum(tdGet(r, "1"));
        const st = tdGet(r, "0", "0", "6");
        if (len > 0) runs.push({ a: at, b: at + len, s: styleOf(st) });
        at += Math.max(0, len);
      }
      const dflt = styleOf(undefined);
      // the runs are in order and back to back: binary search (a run per glyph run would be quadratic)
      const styleAt = (i: number) => {
        let lo = 0, hi = runs.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (i < runs[mid].a) hi = mid - 1;
          else if (i >= runs[mid].b) lo = mid + 1;
          else return runs[mid].s;
        }
        return runs[runs.length - 1]?.s ?? dflt;
      };

      const node: TextNode = { t: "text", runs: [], box: emptyBox(), xp: { ...XP_NORMAL } };
      const byKey = new Map<string, TextRun>();
      const runFor = (s: Style) => {
        const key = `${s.font}|${JSON.stringify(s.fill)}|${JSON.stringify(s.stroke)}|${s.strokeWidth}`;
        let r = byKey.get(key);
        if (!r) {
          r = { font: s.font, glyphs: [], fill: s.fill, stroke: s.stroke, strokeWidth: s.strokeWidth };
          byKey.set(key, r);
          node.runs.push(r);
        }
        return r;
      };

      // the frame this text object draws (a story flowing through several frames draws one per /F record)
      const layout = tdGet(story, "1", "2");
      const cachedF = fCache.get(storyIndex);
      const fRecords: TdDict[] = cachedF ?? [];
      const findF = (v: TdValue | undefined, depth: number) => {
        if (depth > 12 || ++budget.n > MAX_VISITS) return;
        if (tdIsDict(v)) {
          if (tdName(v.get("99")) === "F") {
            fRecords.push(v);
            return;
          }
          for (const x of v.values()) findF(x, depth + 1);
        } else if (Array.isArray(v)) v.forEach((x) => findF(x, depth + 1));
      };
      if (!cachedF) {
        findF(layout, 0);
        fCache.set(storyIndex, fRecords);
      }
      const fr = fRecords.find((f) => tdNum(f.get("10"), -1) === frameIndex) ?? (fRecords.length === 1 ? fRecords[0] : fRecords[frameIndex]);
      if (!fr) return node;
      const fi = tdNum(fr.get("10"), frameIndex);
      const frame = tdGet(frames[fi], "0");
      const info = tdGet(frame, "2");
      const kind = tdNum(tdGet(info, "0"), 0);
      const vertical = tdNum(tdGet(info, "1"), 0) === 2;
      const fm = tdNums(tdGet(info, "2"));
      const M: Mat = fm.length === 6 ? (fm as Mat) : [1, 0, 0, 1, 0, 0];
      const C2A = mul(M, toArt); // canvas → art (frame matrix first)
      let path: ArcPath | null = null;
      let pathStart = 0;
      let pathCursor = 0;
      if (kind === 2) {
        const p = tdNums(tdGet(frame, "1", "0"));
        const segs: number[][] = [];
        for (let k = 0; k + 7 < p.length; k += 8) segs.push(p.slice(k, k + 8));
        if (segs.length) {
          path = new ArcPath(segs.slice(0, MAX_PATH_SEGS), budget);
          // start param (segment index + t) → arc length, approximately (uniform in t)
          const r = tdNums(tdGet(info, "6"));
          const s0 = r[0] ?? 0;
          pathStart = (s0 / Math.max(1, segs.length)) * path.total;
          pathCursor = pathStart;
        }
        notes.push("text-path");
      }
      if (vertical) notes.push("text-vertical");

      // walk the frame's lines: segments (/S) with their glyph runs (/G)
      const walk = (v: TdValue | undefined, seg: { first: number; count: number } | null, depth: number) => {
        if (depth > 16 || ++budget.n > MAX_VISITS) return;
        if (Array.isArray(v)) return v.forEach((x) => walk(x, seg, depth + 1));
        if (!tdIsDict(v)) return;
        const t = tdName(v.get("99"));
        if (t === "S") seg = { first: tdNum(v.get("16")), count: tdNum(tdGet(v, "15", "0")) };
        if (t === "G") return glyphRun(v, seg);
        walk(v.get("6"), seg, depth + 1);
      };
      const glyphRun = (g: TdDict, seg: { first: number; count: number } | null) => {
        let adv = tdNums(tdGet(g, "21", "1"));
        const ids = tdArr(tdGet(g, "21", "0"));
        const loc = tdNums(g.get("1"));
        const bb = tdNums(g.get("8"));
        if (bb.length < 4) return;
        if (ids.length && adv.length < ids.length + 1) {
          // no per-glyph advances (vertical runs): the glyphs share the run's extent evenly
          const span = vertical ? bb[3] - bb[1] : bb[2] - bb[0];
          adv = Array.from({ length: ids.length + 1 }, (_, k) => (span * k) / ids.length);
        }
        const n = Math.max(0, Math.min(ids.length, adv.length - 1));
        if (!n || (glyphCount += n) > MAX_GLYPHS) return;
        // path text: the advances are the glyphs' x positions (canvas, from the run's left bound); each glyph sits where
        // the path, followed onwards from the previous glyph, reaches that x
        const along: (number | null)[] = [];
        if (path) {
          for (let i = 0; i <= n; i++) {
            // the first glyph may sit a hair before the path's start
            const d = path.findX(bb[0] - (loc[0] ?? 0) + adv[i], pathCursor) ?? (i === 0 ? pathCursor : null);
            along.push(d);
            if (d !== null) pathCursor = d;
          }
        }
        const st0 = tdArr(tdGet(g, "10", "0"))[0];
        const first = (seg?.first ?? 0) + tdNum(tdGet(st0, "0"));
        // characters of this run: up to the next run's first character (or the segment's end)
        const next = (g as unknown as { __next?: number }).__next;
        const segEnd = seg ? seg.first + seg.count : text.length;
        const chars = text.slice(first, Math.min(segEnd, next ?? segEnd));
        const scale = tdNums(tdGet(st0, "2"));
        const s = styleAt(first);
        const sx = s.size * s.hs * (scale[0] || 1), sy = s.size * s.vs * (scale[1] || 1);
        const ox = bb[0] - (loc[0] ?? 0), oy = bb[1] - (loc[1] ?? 0); // origin = canvas bounds − local bounds
        const run = runFor(s);
        // glyph ↔ characters: one each when the counts match; otherwise (ligatures) characters spread over the run
        const one = [...chars];
        const units = one.length === n ? one : clusters(one, n);
        for (let i = 0; i < n; i++) {
          const ch = units[i] ?? "";
          let a = adv[i + 1] - adv[i];
          if (!ch || /^[\r\n\u0003]+$/.test(ch)) continue;
          let m: Mat;
          if (path) {
            const d0 = along[i];
            if (d0 === null) continue;
            const d1 = along[i + 1];
            a = d1 !== null && d1 > d0 ? d1 - d0 : Math.abs(a) || sx * 0.5;
            const mid = path.at(d0 + a / 2);
            const at = path.at(d0);
            if (!mid || !at) continue;
            // canvas: tangent (tx, ty), glyph "up" = (ty, −tx) (left of travel, y down)
            m = mul([sx * mid.tx, sx * mid.ty, sy * mid.ty, -sy * mid.tx, at.x, at.y], C2A);
          } else if (vertical) {
            m = mul([sx, 0, 0, -sy, bb[0] + (bb[2] - bb[0] - sx) / 2, bb[1] + adv[i] + a * 0.88], C2A);
          } else m = mul([sx, 0, 0, -sy, ox + adv[i], oy], C2A);
          const glyph: Glyph = { ch: ch === "\t" || ch === " " ? " " : ch, m, adv: (a / Math.max(1e-6, sx)) * 1000 };
          // a glyph showing several characters (ligature, fraction) is drawn as those characters sharing its advance;
          // small caps as capitals at a smaller size
          const parts = [...glyph.ch];
          // the characters one glyph shows count too (a run's last glyph takes all the characters left over)
          if ((glyphCount += parts.length - 1) > MAX_GLYPHS) return;
          const em = glyph.adv / 1000 / parts.length;
          parts.forEach((c, j) => {
            let gm: Mat = [m[0], m[1], m[2], m[3], m[4] + m[0] * em * j, m[5] + m[1] * em * j];
            let shown = c;
            let k = 1;
            if (s.caps === 1 && c !== c.toUpperCase()) {
              shown = c.toUpperCase();
              k = 0.78;
              gm = [gm[0] * k, gm[1] * k, gm[2] * k, gm[3] * k, gm[4], gm[5]];
            }
            const g2: Glyph = { ch: shown, m: gm, adv: (em * 1000) / k };
            run.glyphs.push(g2);
            // bounds: the em box of the glyph
            for (const [u, w] of [[0, -0.25], [g2.adv / 1000, -0.25], [0, 1], [g2.adv / 1000, 1]]) addPt(node.box, gm[0] * u + gm[2] * w + gm[4], gm[1] * u + gm[3] * w + gm[5]);
          });
        }
      };
      // each glyph run needs the next run's first character: mark them in order first
      const gs: TdDict[] = [];
      const collect = (v: TdValue | undefined, depth: number, seg: TdDict | null) => {
        if (depth > 16 || ++budget.n > MAX_VISITS) return;
        if (Array.isArray(v)) return v.forEach((x) => collect(x, depth + 1, seg));
        if (!tdIsDict(v)) return;
        const t = tdName(v.get("99"));
        if (t === "S") {
          const before = gs.length;
          for (const x of tdArr(v.get("6"))) collect(x, depth + 1, v);
          const mine = gs.slice(before);
          mine.forEach((g, k) => {
            const nx = mine[k + 1];
            if (nx) (g as unknown as { __next?: number }).__next = tdNum(v.get("16")) + tdNum(tdGet(tdArr(tdGet(nx, "10", "0"))[0], "0"));
          });
          return;
        }
        if (t === "G") return void gs.push(v);
        collect(v.get("6"), depth + 1, seg);
      };
      collect(fr, 0, null);
      walk(fr, null, 0);
      node.runs = node.runs.filter((r) => r.glyphs.length);
      // a gradient fill of text runs across the text object (left → right)
      const b = node.box;
      if (b.x1 > b.x0)
        for (const r of node.runs) if (r.fill.k === "gradient") r.fill = { ...r.fill, m: [b.x1 - b.x0, 0, 0, b.x1 - b.x0, b.x0, (b.y0 + b.y1) / 2], focal: undefined };
      return node;
    }
  }
}

/** Sequences one glyph may show (OpenType ligatures, fractions), longest first. */
const LIGATURES = /^(ffi|ffl|ff|fi|fl|ft|st|ct|Th|\d+\/\d+)/;

/**
 * n glyph slots for the characters when there are more characters than glyphs: a ligature or fraction takes the
 * characters it covers (as many as the surplus allows); any characters left over join the last glyph.
 */
function clusters(chars: string[], n: number): string[] {
  const out: string[] = [];
  let surplus = chars.length - n;
  let i = 0;
  for (let k = 0; k < n && i < chars.length; k++) {
    let take = 1;
    if (surplus > 0) {
      const m = LIGATURES.exec(chars.slice(i, i + 8).join(""));
      if (m) take = Math.min(1 + surplus, [...m[0]].length);
    }
    out.push(chars.slice(i, i + take).join(""));
    surplus -= take - 1;
    i += take;
  }
  if (i < chars.length && out.length) out[out.length - 1] += chars.slice(i).join("");
  while (out.length < n) out.push("");
  return out;
}

export type { Box };
