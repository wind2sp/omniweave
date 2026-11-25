// 문서 비교 (Word 검토 ▸ 비교): the revised document's body marked with what changed against the original, as tracked
// changes (TextRun.rev, core/review.ts) — paragraphs matched whole first (longest common subsequence), then the words of
// each changed pair; paragraphs only in the original come back as deleted text, paragraphs only in the revised one as
// inserted text. The result keeps the revised document's formatting; deleted text has the original's.

import { changedRuns } from "../io/formats/textDiff";
import { mergeRuns, paraText, sliceRuns } from "./richtext";
import { uid, type Revision, type TextParagraph, type TextRun } from "./types";

/** words with the spaces after them (a run of spaces alone is a token too) */
const tokens = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];

const mark = (runs: TextRun[], rev: Revision): TextRun[] => runs.filter((r) => r.text).map((r) => ({ ...r, rev }));

/** One paragraph pair: the revised paragraph with the original's deleted words put back as deletions. */
function compareWords(a: TextParagraph, b: TextParagraph, del: Revision, ins: Revision): TextParagraph {
  const ta = tokens(paraText(a)), tb = tokens(paraText(b));
  const offA = [0], offB = [0];
  for (const t of ta) offA.push(offA[offA.length - 1] + t.length);
  for (const t of tb) offB.push(offB[offB.length - 1] + t.length);
  const out: TextRun[] = [];
  let j = 0; // revised token copied up to
  for (const [a0, a1, b0, b1] of changedRuns(ta, tb)) {
    if (b0 > j) out.push(...sliceRuns(b.runs, offB[j], offB[b0]));
    if (a1 > a0) out.push(...mark(sliceRuns(a.runs, offA[a0], offA[a1]), del));
    if (b1 > b0) out.push(...mark(sliceRuns(b.runs, offB[b0], offB[b1]), ins));
    j = b1;
  }
  if (j < tb.length) out.push(...sliceRuns(b.runs, offB[j], offB[tb.length]));
  return { ...b, runs: mergeRuns(out.length ? out : b.runs) };
}

/**
 * The revised paragraphs `b` with the changes against the original `a` marked (author / date: who and when the
 * comparison says it was). Unchanged paragraphs are `b`'s own objects (their ids kept: objects anchored to them stay).
 */
export function compareParagraphs(a: TextParagraph[], b: TextParagraph[], who: { author: string; date?: string }): { paras: TextParagraph[]; changes: number } {
  const date = who.date ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const del: Revision = { kind: "del", author: who.author, date };
  const ins: Revision = { kind: "ins", author: who.author, date };
  const out: TextParagraph[] = [];
  let changes = 0;
  let j = 0;
  for (const [a0, a1, b0, b1] of changedRuns(a.map(paraText), b.map(paraText))) {
    out.push(...b.slice(j, b0));
    const pairs = Math.min(a1 - a0, b1 - b0);
    for (let k = 0; k < pairs; k++) out.push(compareWords(a[a0 + k], b[b0 + k], del, ins));
    // paragraphs only in the original: deleted (their text and their paragraph mark)
    for (let k = a0 + pairs; k < a1; k++) out.push({ ...a[k], id: uid("p"), runs: mark(a[k].runs, del).length ? mark(a[k].runs, del) : a[k].runs, markRev: del });
    // paragraphs only in the revised one: inserted
    for (let k = b0 + pairs; k < b1; k++) out.push({ ...b[k], runs: mark(b[k].runs, ins).length ? mark(b[k].runs, ins) : b[k].runs, markRev: ins });
    changes += Math.max(a1 - a0, b1 - b0);
    j = b1;
  }
  out.push(...b.slice(j));
  return { paras: out, changes };
}
