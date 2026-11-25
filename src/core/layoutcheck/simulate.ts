// A line breaker that reproduces core/text.ts layoutText() exactly (same tokens, same greedy fit test, same
// long-token split, same line heights) but with pluggable parts, so the comparator can ask "would this
// paragraph break like Hangul if only X were different?" without touching text.ts.
//   - width:    advance of a token (default: text.ts advance(), i.e. the real measurer + letter spacing)
//   - tokenize: break opportunities (default: text.ts tokenize(), "keep-all" = between 어절)
//   - condense: spaces may shrink by this fraction when testing whether a token still fits (HWPX 공백 최소값)
// With no options the result equals layoutText() line for line (tests/layoutcheck asserts it on every
// fixture paragraph); line starts are character offsets into the paragraph text.

import { advance, glued, graphemes, lineHeightOf, listMarkerChars, rubyLine, rubyMetrics, rubyPad, runFont, runScale, spaceExtra, tokenize, type LaidLine, type TextLayout } from "../text";
import type { TextParagraph, TextRun } from "../types";

/** Advance of `text` (a token or part of one) of `run` starting at paragraph character `at`. */
export type WidthFn = (text: string, run: TextRun, font: string, at: number) => number;
/** Break a run segment (no "\n") into tokens; each token carries its trailing whitespace. */
export type TokenizeFn = (seg: string, run: TextRun, at: number) => string[];

export interface SimOptions {
  wordBreak?: "keep-all" | "normal";
  width?: WidthFn;
  tokenize?: TokenizeFn;
  /** fraction (0..1) by which spaces may shrink to fit a line */
  condense?: number;
}

export interface SimLine {
  /** first character (offset in the paragraph text) */
  start: number;
  /** px */
  height: number;
  /** used width, trailing whitespace trimmed, px */
  width: number;
}

export const defaultWidth: WidthFn = (text, run, font) => advance(text, font, run.letterSpacing || 0, runScale(run));


/** Lay out one paragraph in a box `maxW` px wide (same rules as layoutText). */
export function simulateParagraph(para: TextParagraph, boxWidth: number, opts: SimOptions = {}): SimLine[] {
  const wordBreak = opts.wordBreak ?? (para.breakWord ? "normal" : "keep-all");
  const step = para.tabStep && para.tabStep > 1 ? para.tabStep : 0;
  const width0 = opts.width ?? defaultWidth;
  const base = opts.tokenize ?? ((seg: string) => tokenize(seg, wordBreak, !!para.breakWord));
  // default tab stops (as layoutText): a tab is a token of its own reaching the next stop from the left indent
  const tok: TokenizeFn = step ? (seg, run, at) => base(seg, run, at).flatMap((t) => (t.includes("\t") ? t.split(/(\t)/).filter(Boolean) : [t])) : base;
  let xNow = 0;
  const left0 = para.indentLeft ?? 0;
  const width: WidthFn = step ? (t, run, font, at) => (t === "\t" ? Math.max(1, left0 + Math.floor((xNow - left0) / step + 1e-6) * step + step - xNow) : width0(t, run, font, at)) : width0;
  const condense = opts.condense ?? para.condense ?? 0;
  const left = para.indentLeft ?? 0;
  const maxW = Math.max(left + 10, Math.max(10, boxWidth) - (para.indentRight ?? 0));
  const mkChars = para.indent < 0 ? listMarkerChars(para) : 0;
  const lines: SimLine[] = [];
  let x = Math.max(0, left + para.indent);
  let count = 0; // pieces on the current line
  let maxSize = 0;
  let ci = 0; // characters consumed
  let lineStart = 0;
  let lastEnd = 0; // used width so far, trailing whitespace trimmed
  let spaceW = 0; // width of spaces on the current line (shrinkable)
  // a word split over runs (layoutText glueFrom): where it began on the line, to move it down whole
  let lastTok = "";
  let g = { ci: 0, x: 0, count: 0, lastEnd: 0, max: 0, wordMax: 0 };
  // room the 덧말 of the line need above / below the baseline (layoutText, text.ts rubyLine)
  let up = 0;
  let down = 0;
  const flush = (next: number) => {
    const size = maxSize || para.runs[0]?.fontSize || 16;
    let height = lineHeightOf(para, size);
    if (up || down) height = rubyLine(para, height, para.lineTop ? Math.min(height, size) * 0.85 : (height - size) / 2 + size * 0.8, up, down)[0];
    up = down = 0;
    lines.push({ start: lineStart, height, width: count ? lastEnd : 0 });
    lineStart = next;
    count = 0;
    x = left;
    maxSize = 0;
    lastEnd = 0;
    spaceW = 0;
  };
  for (const run of para.runs) {
    const font = runFont(run);
    if (run.ruby) {
      // 덧말: one unbreakable piece, with room on both sides in Word (layoutText)
      const hwp = !!para.lineTop;
      const baseW = width(run.text, run, font, ci);
      const pad = rubyPad(run, baseW, hwp);
      if (x + baseW + pad * 2 > maxW && count) flush(ci);
      x += pad;
      count++;
      maxSize = Math.max(maxSize, run.fontSize);
      lastEnd = x + baseW;
      x += baseW + pad;
      ci += run.text.length;
      const m = rubyMetrics(run, hwp);
      up = Math.max(up, m.up);
      down = Math.max(down, m.down);
      lastTok = "";
      continue;
    }
    const segs = run.text.split("\n");
    segs.forEach((seg, si) => {
      if (si) {
        maxSize = Math.max(maxSize, run.fontSize);
        ci += 1;
        flush(ci);
        lastTok = "";
      }
      tok(seg, run, ci).forEach((t, ti) => {
        xNow = x;
        const w = width(t, run, font, ci) + spaceExtra(t, run, font, runScale(run), para.spaceEm);
        const vis = t.replace(/\s+$/, "");
        const visW = vis === t ? w : width(vis, run, font, ci);
        // (a twip past the width still fits: layoutText's FIT_EPS)
        const fits = (at: number) => at + visW <= maxW + 1 / 15 || (condense > 0 && at - spaceW * condense + visW <= maxW + 1 / 15);
        const glue = si === 0 && ti === 0 && count > 0 && glued(lastTok, t, wordBreak);
        if (!glue) g = { ci, x, count, lastEnd, max: maxSize, wordMax: 0 };
        // (layoutText: a token that is only spaces never starts a line)
        if (vis && !fits(x) && count) {
          if (glue && g.count > 0) {
            // the word began in an earlier run on this line: the line ends before it and the word moves down whole
            const moved = { n: count - g.count, w: x - g.x, end: lastEnd - g.x, max: g.wordMax };
            count = g.count;
            lastEnd = g.lastEnd;
            maxSize = g.max;
            flush(g.ci);
            count = moved.n;
            x = left + moved.w;
            lastEnd = left + moved.end;
            maxSize = moved.max;
          } else flush(ci);
          g = { ci: lineStart, x: left, count: 0, lastEnd: 0, max: 0, wordMax: maxSize };
        }
        lastTok = t;
        if (visW > maxW - left) {
          let chunk = "";
          let chunkAt = ci;
          for (const g of graphemes(t)) {
            const cw = width(chunk + g, run, font, chunkAt);
            if (x + cw > maxW && chunk) {
              count++;
              maxSize = Math.max(maxSize, run.fontSize);
              lastEnd = x + width(chunk, run, font, chunkAt);
              chunkAt += chunk.length;
              flush(chunkAt);
              chunk = g;
            } else chunk += g;
          }
          if (chunk) {
            const cw = width(chunk, run, font, chunkAt);
            count++;
            maxSize = Math.max(maxSize, run.fontSize);
            const trimmed = chunk.replace(/\s+$/, "");
            lastEnd = x + (trimmed === chunk ? cw : width(trimmed, run, font, chunkAt));
            x += cw;
          }
          ci += t.length;
          return;
        }
        count++;
        maxSize = Math.max(maxSize, run.fontSize);
        g.wordMax = Math.max(g.wordMax, run.fontSize);
        lastEnd = x + visW;
        // the token's trailing spaces become shrinkable for the tokens that follow (as layoutText)
        if (condense > 0) spaceW += w - visW;
        x += w;
        ci += t.length;
        if (mkChars && ci === mkChars && lineStart === 0 && lines.length === 0 && x < left) x = left;
      });
    });
  }
  flush(ci);
  return lines;
}

/** Line starts (character offsets into the paragraph text) of a layoutText() result for one paragraph. */
export function lineStartsOf(layout: TextLayout | LaidLine[], para: TextParagraph, paragraphIndex = 0): number[] {
  const text = para.runs.map((r) => r.text).join("");
  const lines = (Array.isArray(layout) ? layout : layout.lines).filter((l) => l.paragraph === paragraphIndex);
  const out: number[] = [];
  let ci = 0;
  for (const l of lines) {
    out.push(ci);
    for (const p of l.pieces) ci += p.text.length;
    if (text[ci] === "\n") ci++;
  }
  return out;
}
