// Metric-locked fallback fonts (research idea T2, phase 1 prototype — used only by the layout comparator).
//
// When a document's font is not installed we draw with a fallback (Pretendard, …). Its glyph advances differ
// from the original's, so lines break elsewhere and pages drift. Instead of using the fallback's widths
// as they are, we keep the fallback's shapes but lock the ADVANCES to what the original font would have used:
//
//   advance(char) = em[class] × size                 when the class has a fixed em advance
//                 = fallbackAdvance(char) × scale[class]   otherwise
//
// per character class (Hangul, CJK, Latin letters, digits, space, ASCII punctuation, other symbols).
// Two ways to know the original's metrics:
//   1. a prior: Korean (KS X 1001 era) text fonts draw Hangul syllables and CJK on a full-width square, so
//      Hangul / CJK advance = 1 em regardless of the font (checked on the installed Korean fonts in tests);
//   2. a fit from the document itself: Hancom's saved line layout (lineseg) says where every line broke.
//      A profile that makes our greedy breaker reproduce those breaks is searched per font family
//      (coordinate search over the class scales, objective = paragraphs with identical breaks, ties broken by
//      the total break offset error). Fonts embedded in the package (rare in HWPX) would give exact tables.
// Phase 2 wires the chosen profile into the real measurer (core/text.ts setMeasure / font table); here it
// only feeds the comparator's simulator.

import { graphemes, measure } from "../text";
import type { TextRun } from "../types";

export type CharClass = "hangul" | "cjk" | "latin" | "digit" | "space" | "punct" | "symbol";
export const CHAR_CLASSES: CharClass[] = ["hangul", "cjk", "latin", "digit", "space", "punct", "symbol"];

export function charClass(g: string): CharClass {
  const c = g.codePointAt(0) ?? 0;
  if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xd7b0 && c <= 0xd7ff)) return "hangul";
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x20000 && c <= 0x2ffff)) return "cjk";
  if (c === 0x20 || c === 0xa0 || c === 0x3000 || c === 9) return "space";
  if (c >= 0x30 && c <= 0x39) return "digit";
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) return "latin";
  if (c >= 0x21 && c <= 0x7e) return "punct";
  return "symbol";
}

export interface MetricProfile {
  /** multiplier on the fallback font's advance, per class */
  scale: Record<CharClass, number>;
  /** fixed advance in em (overrides scale), per class */
  em: Partial<Record<CharClass, number>>;
}

export const identityProfile = (): MetricProfile => ({ scale: { hangul: 1, cjk: 1, latin: 1, digit: 1, space: 1, punct: 1, symbol: 1 }, em: {} });

/** Prior for a missing Korean document font: Hangul and CJK on a 1-em square, everything else as the fallback. */
export const koreanPrior = (): MetricProfile => ({ ...identityProfile(), em: { hangul: 1, cjk: 1 } });

export const cloneProfile = (p: MetricProfile): MetricProfile => ({ scale: { ...p.scale }, em: { ...p.em } });

/** Font size in px actually drawn for a run (superscript / subscript are smaller). */
const drawnSize = (run: TextRun, font: string) => Number(/([\d.]+)px/.exec(font)?.[1] ?? run.fontSize);

/**
 * Advance of `text` drawn with `font` (the fallback) but locked to `profile`. No letter spacing: callers add
 * their own. Consecutive characters of one class are measured together, so the fallback's kerning inside a
 * class survives when the class is only scaled.
 */
export function lockedAdvance(text: string, run: TextRun, font: string, profile: MetricProfile): number {
  const size = drawnSize(run, font);
  let w = 0;
  for (const s of classRuns(text)) {
    const em = profile.em[s.k];
    w += em !== undefined ? em * size * s.n * profile.scale[s.k] : measure(s.text, font) * profile.scale[s.k];
  }
  return w;
}

const classCache = new Map<string, { k: CharClass; text: string; n: number }[]>();
/** Text split into runs of one character class (grapheme counts included); memoized — fitting calls it a lot. */
function classRuns(text: string): { k: CharClass; text: string; n: number }[] {
  let out = classCache.get(text);
  if (out) return out;
  out = [];
  for (const g of graphemes(text)) {
    const k = charClass(g);
    const last = out[out.length - 1];
    if (last && last.k === k) {
      last.text += g;
      last.n++;
    } else out.push({ k, text: g, n: 1 });
  }
  if (classCache.size > 100000) classCache.clear();
  classCache.set(text, out);
  return out;
}

/**
 * Coordinate search over a profile's class scales. `score` must be higher for better profiles; `classes`
 * limits which classes move (others keep their value). Coarse pass then fine pass around the best value.
 */
export function fitProfile(
  start: MetricProfile,
  score: (p: MetricProfile) => number,
  classes: CharClass[] = ["hangul", "latin", "digit", "space", "punct", "symbol"],
  opts: { lo?: number; hi?: number; coarse?: number; fine?: number; rounds?: number } = {},
): { profile: MetricProfile; score: number; evaluations: number } {
  const lo = opts.lo ?? 0.6, hi = opts.hi ?? 1.4, coarse = opts.coarse ?? 0.05, fine = opts.fine ?? 0.01, rounds = opts.rounds ?? 2;
  let best = cloneProfile(start);
  let bestScore = score(best);
  let evaluations = 1;
  const tryValues = (k: CharClass, values: number[]) => {
    for (const v of values) {
      if (Math.abs(v - best.scale[k]) < 1e-9) continue;
      const cand = cloneProfile(best);
      cand.scale[k] = Math.round(v * 1000) / 1000;
      const s = score(cand);
      evaluations++;
      // ties: prefer the value closer to 1 (do not move without evidence)
      if (s > bestScore || (s === bestScore && Math.abs(cand.scale[k] - 1) < Math.abs(best.scale[k] - 1))) {
        best = cand;
        bestScore = s;
      }
    }
  };
  for (let r = 0; r < rounds; r++)
    for (const k of classes) {
      const grid: number[] = [];
      for (let v = lo; v <= hi + 1e-9; v += coarse) grid.push(v);
      tryValues(k, grid);
      const c = best.scale[k];
      const fineGrid: number[] = [];
      for (let v = c - coarse; v <= c + coarse + 1e-9; v += fine) if (v >= lo - 1e-9 && v <= hi + 1e-9) fineGrid.push(v);
      tryValues(k, fineGrid);
    }
  return { profile: best, score: bestScore, evaluations };
}
