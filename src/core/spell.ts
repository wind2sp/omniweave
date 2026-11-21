// Spelling (맞춤법 검사), the pure part: which words of a text are checked, in which language, and where a word sits on
// the laid-out lines of a text node or table cell (for the wavy underline and its right-click menu). The checking itself
// is Windows' (src-tauri/src/spell.rs, ui/spell.ts); nothing here changes a document except replaceInRuns, which the
// "replace with a suggestion" command uses.

import { layoutText, measure } from "./text";
import { CELL_PAD_Y, TABLE_LINE, cellFont, lineX, tableCells } from "./table";
import type { TableNode, TextNode, TextRun } from "./types";

export interface SpellWord {
  start: number;
  end: number;
  word: string;
  lang: string;
}

const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const KANA = /[぀-ヿ]/;
const HAN = /[㐀-鿿豈-﫿]/;
const LATIN = /^[\p{Script=Latin}\p{M}'’]+$/u;

/**
 * The language a word is checked in: Hangul → Korean, kana → Japanese, Latin letters → the document's language for
 * Latin text (Word w:lang of the default run properties; en-US when the file says nothing). Han-only words (한자 in
 * a Korean document, Chinese) and other scripts are not checked. null = not checked.
 */
export function langOfWord(word: string, latin: string): string | null {
  if (HANGUL.test(word)) return "ko-KR";
  if (KANA.test(word)) return "ja-JP";
  if (HAN.test(word)) return null;
  return LATIN.test(word) ? latin : null;
}

/**
 * The words of a text that are checked, as Word's defaults do: words with digits, words in capitals (acronyms),
 * one-letter words and words that are part of an address (a@b, a.b/c, www…) are skipped.
 */
export function spellWords(text: string, latin = "en-US"): SpellWord[] {
  const out: SpellWord[] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    const start = m.index!, end = start + word.length;
    if ([...word].length < 2) continue;
    const before = text[start - 1] ?? "", after = text[end] ?? "";
    if (/[\d_@/\\]/.test(before) || /[\d_@/\\]/.test(after)) continue;
    if (after === "." && /[\p{L}]/u.test(text[end + 1] ?? "")) continue; // a.b (file names, domains)
    if (before === "." && /[\p{L}]/u.test(text[start - 2] ?? "")) continue;
    if (word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase()) continue;
    const lang = langOfWord(word, latin);
    if (lang) out.push({ start, end, word, lang });
  }
  return out;
}

/** A misspelled word on the page: where it is in the model and where its wavy line goes (node-local px). */
export interface SpellMark {
  word: string;
  lang: string;
  /** text node: paragraph index and offsets in its run text; table: the cell (and paragraph of a rich cell) */
  para: number;
  start: number;
  end: number;
  cell?: { r: number; c: number; rich: boolean };
  /** pieces of the underline: x0..x1 at y (baseline + a little), h = the text size */
  segs: { x0: number; x1: number; y: number; size: number }[];
}

type Bad = (word: string, lang: string) => boolean;

/** x of character k of a piece text drawn at x, `width` wide (the share of the piece's own measured advance) */
function xAt(text: string, font: string, x: number, width: number, k: number): number {
  if (k <= 0) return x;
  if (k >= text.length) return x + width;
  const full = measure(text, font);
  return full > 0 ? x + (measure(text.slice(0, k), font) / full) * width : x;
}

/** The misspelled words of a text node with their underlines, node-local. */
export function textMarks(n: TextNode, bad: Bad, latin: string, dx = 0, dy = 0): SpellMark[] {
  const lay = layoutText(n);
  const texts = n.paragraphs.map((p) => p.runs.map((r) => r.text).join(""));
  // where each piece's text starts in its paragraph's text (pieces follow the text in order)
  const cursor = texts.map(() => 0);
  const spans: { pi: number; s: number; e: number; x: number; w: number; font: string; y: number; size: number; text: string }[] = [];
  for (const line of lay.lines) {
    const pi = line.paragraph;
    const t = texts[pi] ?? "";
    for (const p of line.pieces) {
      if (!p.text) continue;
      const at = t.indexOf(p.text, cursor[pi]);
      if (at < 0) continue;
      cursor[pi] = at + p.text.length;
      const size = p.run.fontSize;
      spans.push({ pi, s: at, e: at + p.text.length, x: p.x, w: p.width, font: p.font, y: line.y + line.baseline + (p.dy ?? 0), size, text: p.text });
    }
  }
  const out: SpellMark[] = [];
  texts.forEach((t, pi) => {
    for (const w of spellWords(t, latin)) {
      if (!bad(w.word, w.lang)) continue;
      const segs = spans
        .filter((s) => s.pi === pi && s.s < w.end && s.e > w.start)
        .map((s) => ({
          x0: dx + xAt(s.text, s.font, s.x, s.w, w.start - s.s),
          x1: dx + xAt(s.text, s.font, s.x, s.w, w.end - s.s),
          y: dy + s.y + s.size * 0.18,
          size: s.size,
        }));
      if (segs.length) out.push({ word: w.word, lang: w.lang, para: pi, start: w.start, end: w.end, segs });
    }
  });
  return out;
}

/** The misspelled words of a table's cells (rich cells as their own text, plain cells as their wrapped lines). */
export function tableMarks(n: TableNode, bad: Bad, latin: string): SpellMark[] {
  const out: SpellMark[] = [];
  const lh = n.fontSize * TABLE_LINE;
  for (const v of tableCells(n)) {
    if (v.rich) {
      for (const m of textMarks(v.rich.node, bad, latin, v.rich.x, v.rich.y)) out.push({ ...m, cell: { r: v.r, c: v.c, rich: true } });
      continue;
    }
    const text = v.cell.text;
    if (!text || !v.lines.length) continue;
    const font = cellFont(n, v.cell, v.r);
    let cur = 0;
    const spans = v.lines.map((ln, i) => {
      const at = ln.text ? text.indexOf(ln.text, cur) : -1;
      if (at >= 0) cur = at + ln.text.length;
      return { at, ln, x: lineX(v.cell.align, v.rect.x, v.rect.w, ln.width), y: v.rect.y + CELL_PAD_Y + i * lh + (lh - n.fontSize) / 2 + n.fontSize * 0.8 };
    });
    for (const w of spellWords(text, latin)) {
      if (!bad(w.word, w.lang)) continue;
      const segs = spans
        .filter((s) => s.at >= 0 && s.at < w.end && s.at + s.ln.text.length > w.start)
        .map((s) => ({
          x0: s.x + measure(s.ln.text.slice(0, Math.max(0, w.start - s.at)), font),
          x1: s.x + measure(s.ln.text.slice(0, Math.min(s.ln.text.length, w.end - s.at)), font),
          y: s.y + n.fontSize * 0.18,
          size: n.fontSize,
        }));
      if (segs.length) out.push({ word: w.word, lang: w.lang, para: 0, start: w.start, end: w.end, segs, cell: { r: v.r, c: v.c, rich: false } });
    }
  }
  return out;
}

/** Runs with the text from `start` to `end` (offsets in their joined text) replaced by `text`, in the first run's format. */
export function replaceInRuns(runs: TextRun[], start: number, end: number, text: string): TextRun[] {
  const out: TextRun[] = [];
  let pos = 0, placed = false;
  for (const r of runs) {
    const a = pos, b = pos + r.text.length;
    pos = b;
    if (b <= start || a >= end || r.obj || r.note) {
      // (an object or note reference is never part of a word)
      out.push(r);
      continue;
    }
    const keep = r.text.slice(0, Math.max(0, start - a)) + (placed ? "" : text) + r.text.slice(Math.max(0, end - a));
    placed = true;
    if (keep) out.push({ ...r, text: keep });
  }
  return out.length ? out : runs;
}

/** A wavy underline path from x0 to x1 at y, waves `amp` high and `period` long (Word's red squiggle). */
export function wavePoints(x0: number, x1: number, y: number, amp: number, period: number): [number, number][] {
  const pts: [number, number][] = [];
  const step = period / 2;
  let up = true;
  for (let x = x0; x < x1; x += step) {
    pts.push([x, y + (up ? 0 : amp)]);
    up = !up;
  }
  pts.push([x1, y + (up ? 0 : amp)]);
  return pts;
}
