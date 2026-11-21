// Find & replace over a document's text (pure): paragraph runs of text boxes and table cells on every page
// and master page, plus the word count shown by Text → Word count. Locked objects and formula cells are left
// alone; PDF and other original-backed objects carry no editable text here, so they are never touched. Imported
// table-cell paragraphs (richText) are edited along with the cell text, so their formatting survives.

import type { OmwDocument, TableCell, TextParagraph, TextRun } from "./types";

export interface TextMatch {
  pageId: string;
  nodeId: string;
  kind: "para" | "cell";
  /** paragraph index (kind "para"), -1 otherwise */
  p: number;
  /** table cell (kind "cell"), -1 otherwise */
  row: number;
  col: number;
  /** offsets in the paragraph's joined run text / the cell text */
  start: number;
  end: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Literal search pattern (global; case-insensitive unless `matchCase`); null for an empty query. */
export function searchRegex(query: string, matchCase: boolean): RegExp | null {
  if (!query) return null;
  return new RegExp(escapeRe(query), matchCase ? "gu" : "giu");
}

export const paraText = (p: { runs: readonly TextRun[] }) => p.runs.map((r) => r.text).join("");

/** [start, end) of every non-overlapping match, left to right. */
export function matchRanges(text: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) if (m[0].length) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

const editableCell = (c: TableCell) => !c.formula;

/** A cell's imported paragraphs as plain text (io/office.ts joins them with line breaks). */
const cellRichText = (ps: readonly TextParagraph[]) => ps.map(paraText).join("\n");

/** Pages searched: every page, then the master pages. */
const searchPages = (doc: OmwDocument) => [...doc.pages, ...doc.masters];

/** Every match in the document, page by page (master pages last) and object by object (bottom to top). */
export function findMatches(doc: OmwDocument, query: string, matchCase: boolean): TextMatch[] {
  const re = searchRegex(query, matchCase);
  if (!re) return [];
  const out: TextMatch[] = [];
  for (const page of searchPages(doc))
    for (const n of page.nodes) {
      if (n.locked) continue;
      if (n.type === "TEXT")
        n.paragraphs.forEach((para, p) => {
          for (const [start, end] of matchRanges(paraText(para), re)) out.push({ pageId: page.id, nodeId: n.id, kind: "para", p, row: -1, col: -1, start, end });
        });
      else if (n.type === "TABLE")
        n.rows.forEach((r, row) =>
          r.forEach((c, col) => {
            if (!editableCell(c)) return;
            for (const [start, end] of matchRanges(c.text, re)) out.push({ pageId: page.id, nodeId: n.id, kind: "cell", p: -1, row, col, start, end });
          }),
        );
    }
  return out;
}

/**
 * Replace every match in one paragraph's runs, in place (works on an immer draft). A match spanning several
 * runs takes the formatting of the run where it starts; the other runs only lose the matched characters, and
 * runs emptied by the replacement are dropped (one run always stays). Runs are never merged. Returns the count.
 */
export function replaceInRuns(runs: TextRun[], re: RegExp, replacement: string): number {
  const ranges = matchRanges(runs.map((r) => r.text).join(""), re);
  if (!ranges.length) return 0;
  const emptied = new Set<number>();
  for (let m = ranges.length - 1; m >= 0; m--) {
    const [a, b] = ranges[m];
    let pos = 0, first = true;
    for (let i = 0; i < runs.length; i++) {
      const text = runs[i].text, rs = pos, re2 = pos + text.length;
      pos = re2;
      const s = Math.max(a, rs), e = Math.min(b, re2);
      if (s >= e) continue;
      runs[i].text = text.slice(0, s - rs) + (first ? replacement : "") + text.slice(e - rs);
      first = false;
      if (!runs[i].text) emptied.add(i);
    }
  }
  for (let i = runs.length - 1; i >= 0 && runs.length > 1; i--) if (emptied.has(i) && !runs[i].text) runs.splice(i, 1);
  return ranges.length;
}

/** Replace every match in the document (call inside one store commit). Returns the number replaced. */
export function replaceAllInDoc(d: OmwDocument, query: string, replacement: string, matchCase: boolean): number {
  const re = searchRegex(query, matchCase);
  if (!re) return 0;
  let n = 0;
  for (const page of searchPages(d))
    for (const node of page.nodes) {
      if (node.locked) continue;
      if (node.type === "TEXT") for (const para of node.paragraphs as TextParagraph[]) n += replaceInRuns(para.runs, re, replacement);
      else if (node.type === "TABLE")
        for (const r of node.rows)
          for (const c of r) {
            if (!editableCell(c)) continue;
            const k = matchRanges(c.text, re).length;
            if (!k) continue;
            if (c.richText?.length && cellRichText(c.richText) === c.text) {
              // imported cell paragraphs (fonts, sizes…): replace inside their runs and rebuild the text the way
              // the importer joins them, so the cell is still written back with its formatting
              for (const para of c.richText) replaceInRuns(para.runs, re, replacement);
              c.text = cellRichText(c.richText);
            } else {
              re.lastIndex = 0;
              c.text = c.text.replace(re, () => replacement);
            }
            n += k;
          }
    }
  return n;
}

export interface TextStats {
  /** characters (Unicode code points), spaces included; paragraph breaks are not counted */
  chars: number;
  charsNoSpaces: number;
  /**
   * words as Word / 한글 count them: runs of non-space characters (a Korean 어절 is one word, Hanja inside it too);
   * outside Hangul runs every Chinese character and kana counts as a word of its own, as in Word's ja / zh count
   */
  words: number;
  /** non-empty paragraphs */
  paragraphs: number;
}

const CJK_WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Words in one run of non-space characters (see TextStats.words). */
function wordsIn(run: string): number {
  if (/\p{Script=Hangul}/u.test(run) || !CJK_WORD.test(run)) return 1;
  let n = 0, other = false;
  for (const ch of run) {
    if (CJK_WORD.test(ch)) {
      n++;
      other = false;
    } else if (!other && !/[\p{P}\p{S}ー]/u.test(ch)) {
      n++; // a Latin word / number between ideographs
      other = true;
    }
  }
  return n;
}

export function textStats(paragraphs: string[]): TextStats {
  const st: TextStats = { chars: 0, charsNoSpaces: 0, words: 0, paragraphs: 0 };
  for (const p of paragraphs) {
    const cps = Array.from(p);
    st.chars += cps.length;
    st.charsNoSpaces += cps.filter((c) => !/\s/u.test(c)).length;
    for (const w of p.split(/\s+/u)) if (w) st.words += wordsIn(w);
    if (p.trim()) st.paragraphs++;
  }
  return st;
}
