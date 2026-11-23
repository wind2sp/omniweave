// OCR — text line recognition. Model: PP-OCRv5 mobile recognizer (PP-LCNetV3 + SVTR neck + CTC head, Apache-2.0),
// converted to a Loom Infer graph by scripts/convert-ppocr.mjs. Input: a 48 px high line crop (B, G, R planes,
// (v/255 − 0.5)/0.5), output: per time step (= 8 input px) class probabilities, class 0 = CTC blank.
//
// Our additions over the reference decoder:
//   * per-character time-step positions → character x ranges in the image (caret placement, confidence boxes),
//   * space restoration from glyph gaps (the Korean model often drops 띄어쓰기: "자기는돈이"); see restoreSpaces,
//   * runner-up per character with its probability and whether it differs only in one jamo (받침 / 모음 confusions
//     such as 았/었, 의/위 are the typical errors): the UI marks those for review.

import type { Img } from "../pixels";
import { runGraph, type GraphModel, type Tensor } from "../infer/graph";

export const REC_H = 48;

export interface OcrChar {
  ch: string;
  /** probability of the chosen class (mean over its time steps) */
  p: number;
  /** x range in the line crop, px */
  x0: number;
  x1: number;
  /** runner-up class and probability when it is a close call */
  alt?: string;
  altP?: number;
  /** alt differs from ch in exactly one jamo (초성/중성/종성) */
  jamo?: boolean;
}

export interface LineText {
  text: string;
  /** mean character probability */
  conf: number;
  chars: OcrChar[];
}

/** Bilinear resize of an RGBA crop to height 48 → network input [1,3,48,W] (B, G, R order like the reference). */
export function recInput(img: Img, maxW = 3200, minW = 320): { x: Tensor; scale: number; w: number } {
  const ratio = img.width / Math.max(1, img.height);
  const w = Math.max(16, Math.min(maxW, Math.ceil(REC_H * ratio)));
  // the reference pads every line to at least 48×320 (its training shape); a smaller minimum saves time on short lines
  const W = Math.max(w, minW);
  const d = new Float32Array(3 * REC_H * W); // padded part stays 0 (= mid grey after normalization, as the reference pads)
  const sx = img.width / w, sy = img.height / REC_H;
  const src = img.data;
  for (let y = 0; y < REC_H; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(img.height - 1, Math.floor(fy)), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(img.width - 1, Math.floor(fx)), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = src[(y0 * img.width + x0) * 4 + c], b = src[(y0 * img.width + x1) * 4 + c];
        const e = src[(y1 * img.width + x0) * 4 + c], f = src[(y1 * img.width + x1) * 4 + c];
        const v = (a + (b - a) * tx) * (1 - ty) + (e + (f - e) * tx) * ty;
        // channel order B, G, R
        d[(2 - c) * REC_H * W + y * W + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
  return { x: { s: [1, 3, REC_H, W], d }, scale: img.width / w, w };
}

const S0 = 0xac00;
/** Jamo indices of a Hangul syllable, or null. */
export function jamo(ch: string): [number, number, number] | null {
  const c = ch.codePointAt(0)! - S0;
  if (c < 0 || c > 11171) return null;
  return [Math.floor(c / 588), Math.floor((c % 588) / 28), c % 28];
}
/** Number of differing jamo between two syllables (−1 = not both Hangul). */
export function jamoDistance(a: string, b: string): number {
  const x = jamo(a), y = jamo(b);
  if (!x || !y) return -1;
  return (x[0] !== y[0] ? 1 : 0) + (x[1] !== y[1] ? 1 : 0) + (x[2] !== y[2] ? 1 : 0);
}

/** Greedy CTC decode of probabilities [T, C] with time-step positions. */
export function ctcDecode(prob: Float32Array, T: number, C: number, dict: string[], step: number): LineText {
  const chars: OcrChar[] = [];
  let prev = 0;
  let cur: { k: number; t0: number; t1: number; ps: number; n: number; alt: number; altP: number } | null = null;
  const label = (k: number) => (k === dict.length + 1 ? " " : (dict[k - 1] ?? ""));
  const flush = () => {
    if (!cur) return;
    const ch = label(cur.k);
    const c: OcrChar = { ch, p: cur.ps / cur.n, x0: cur.t0 * step, x1: (cur.t1 + 1) * step };
    if (cur.alt > 0 && cur.altP > 0.05) {
      c.alt = label(cur.alt);
      c.altP = cur.altP;
      if (jamoDistance(ch, c.alt) === 1) c.jamo = true;
    }
    chars.push(c);
    cur = null;
  };
  for (let t = 0; t < T; t++) {
    const row = t * C;
    let k = 0, best = prob[row], k2 = -1, second = -1;
    for (let c = 1; c < C; c++) {
      const v = prob[row + c];
      if (v > best) {
        k2 = k;
        second = best;
        best = v;
        k = c;
      } else if (v > second) {
        second = v;
        k2 = c;
      }
    }
    if (k !== 0 && k === prev && cur) {
      cur.t1 = t;
      cur.ps += best;
      cur.n++;
      if (k2 > 0 && second > cur.altP) {
        cur.alt = k2;
        cur.altP = second;
      }
    } else {
      flush();
      if (k !== 0) cur = { k, t0: t, t1: t, ps: best, n: 1, alt: k2 > 0 ? k2 : 0, altP: k2 > 0 ? second : 0 };
    }
    prev = k;
  }
  flush();
  const text = chars.map((c) => c.ch).join("");
  const conf = chars.length ? chars.reduce((a, c) => a + c.p, 0) / chars.length : 0;
  return { text, conf, chars };
}

/**
 * Space restoration from geometry: a gap between two characters clearly wider than the line's typical
 * inter-character gap gets a space when the model wrote none. Gaps are measured on the ink (column profile of the
 * crop), not the CTC steps, which are only 8 px apart.
 */
export function restoreSpaces(line: LineText, crop: Img, opts: { factor?: number; em?: number } = {}): LineText {
  if (line.chars.length < 3) return line;
  const W = crop.width, H = crop.height;
  // column ink profile (dark on light; inverted crops are rare in documents and handled by the caller)
  const ink = new Uint8Array(W);
  let lum = 0;
  for (let i = 0; i < W * H; i++) lum += crop.data[i * 4] * 0.3 + crop.data[i * 4 + 1] * 0.59 + crop.data[i * 4 + 2] * 0.11;
  const thr = (lum / (W * H)) * 0.75;
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      if (crop.data[i] * 0.3 + crop.data[i + 1] * 0.59 + crop.data[i + 2] * 0.11 < thr) {
        ink[x] = 1;
        break;
      }
    }
  // blank run between consecutive characters (search between their centres)
  const gaps: number[] = [];
  for (let i = 0; i + 1 < line.chars.length; i++) {
    const a = line.chars[i], b = line.chars[i + 1];
    const ca = Math.round((a.x0 + a.x1) / 2), cb = Math.round((b.x0 + b.x1) / 2);
    let best = 0, run = 0;
    for (let x = Math.max(0, ca); x < Math.min(W, cb); x++) {
      run = ink[x] ? 0 : run + 1;
      if (run > best) best = run;
    }
    gaps.push(best);
  }
  const real = gaps.filter((_, i) => line.chars[i].ch !== " " && line.chars[i + 1].ch !== " ");
  if (real.length < 2) return line;
  const sorted = [...real].sort((p, q) => p - q);
  const med = sorted[Math.floor(sorted.length / 2)];
  const spaceGaps = gaps.filter((_, i) => line.chars[i + 1].ch === " " || line.chars[i].ch === " ");
  void spaceGaps;
  // a word space leaves ≈ 0.35–0.45 em of paper (space + side bearings), a syllable gap ≈ 0.05–0.12 em and the gap
  // inside 이 / 니 (consonant | vowel) up to ≈ 0.2 em: 0.3 em was best on the synthetic set (0.15–0.38 tried)
  const minGap = opts.em ? Math.max(opts.em * (opts.factor ?? 0.3), med * 1.8, 2) : Math.max(H * 0.22, med * 2.2, 3);
  // between two digits a narrow figure ("1") in a tabular font leaves a wide blank on its own: a space there needs a
  // clearly wider gap, and a space the model put between digits over a narrow blank is dropped ("1 23" → "123")
  const digit = (ch: string) => /^[0-9]$/.test(ch);
  const digitGap = Math.max(minGap * 1.7, (opts.em ?? H) * 0.5);
  const blank = (a: OcrChar, b: OcrChar) => {
    let best = 0, run = 0;
    for (let x = Math.max(0, Math.round((a.x0 + a.x1) / 2)); x < Math.min(W, Math.round((b.x0 + b.x1) / 2)); x++) {
      run = ink[x] ? 0 : run + 1;
      if (run > best) best = run;
    }
    return best;
  };
  const out: OcrChar[] = [];
  let changed = false;
  line.chars.forEach((c, i) => {
    const prev = out[out.length - 1], n = line.chars[i + 1];
    if (c.ch === " " && prev && n && digit(prev.ch) && digit(n.ch) && blank(prev, n) < digitGap) {
      changed = true;
      return;
    }
    out.push(c);
    if (!n || c.ch === " " || n.ch === " ") return;
    const g = gaps[i];
    if (g >= (digit(c.ch) && digit(n.ch) ? digitGap : minGap)) {
      out.push({ ch: " ", p: 0.5, x0: c.x1, x1: n.x0 });
      changed = true;
    }
  });
  if (!changed) return line;
  return { ...line, chars: out, text: out.map((c) => c.ch).join("") };
}

export interface RecOptions {
  /** add spaces the model left out (default on) */
  /** line em size in crop px (from the detector core height); improves space restoration */
  em?: number;
  spaceFactor?: number;
  /** minimum padded input width (reference: 320) */
  minWidth?: number;
  spaces?: boolean;
}

/** Recognize one line crop. */
export function recognizeLine(model: GraphModel, crop: Img, opts: RecOptions = {}): LineText {
  const dict = model.meta.dict;
  if (!dict) throw new Error("recognition model expected");
  const { x, scale } = recInput(crop, 3200, opts.minWidth ?? 320);
  return decodeLine(dict, runGraph(model, x), x, scale, crop, opts);
}

/** recognizeLine with the network run elsewhere (WebGPU, infer/graphGpu.ts). */
export async function recognizeLineWith(run: (x: Tensor) => Promise<Tensor>, model: GraphModel, crop: Img, opts: RecOptions = {}): Promise<LineText> {
  const dict = model.meta.dict;
  if (!dict) throw new Error("recognition model expected");
  const { x, scale } = recInput(crop, 3200, opts.minWidth ?? 320);
  return decodeLine(dict, await run(x), x, scale, crop, opts);
}

function decodeLine(dict: string[], y: Tensor, x: Tensor, scale: number, crop: Img, opts: RecOptions): LineText {
  const T = y.s[1], C = y.s[2];
  const step = (x.s[3] / T) * scale;
  let r = ctcDecode(y.d, T, C, dict, step);
  // only the real (unpadded) width counts
  r.chars = r.chars.map((c) => ({ ...c, x0: Math.min(crop.width, c.x0), x1: Math.min(crop.width, c.x1) }));
  if (opts.spaces !== false) r = restoreSpaces(r, crop, { em: opts.em, factor: opts.spaceFactor });
  r.text = r.text.trim();
  return r;
}
