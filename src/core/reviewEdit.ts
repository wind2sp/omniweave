// Comments and tracked changes — editing them (stage 2; core/review.ts reads and shows them).
//
// Pure functions on story paragraphs and the document's comment list, like core/richtext.ts: adding a comment to a
// range (its id on the runs it covers), replies, resolving, editing and deleting comments, and accepting / rejecting
// tracked changes (one, the ones in a range, or all). The UI (ui/reviewActions.ts) runs them on every story of the
// document and commits one undo step.

import * as RT from "./richtext";
import { isRemoved, localNow, newCommentId, reviewAuthor, withoutReview } from "./review";
import type { DocComment, Page, Revision, SceneNode, TextParagraph, TextRun } from "./types";
import { gatherStory, isFlowSegment, reanchor, reflowSegment, segmentAt } from "./flow";

// ── comments on the text ──

/** The paragraphs with comment `id` on the runs of range `r`; null when the range is empty. */
export function tagComment(paras: TextParagraph[], r0: RT.Range, id: string): TextParagraph[] | null {
  const r = RT.clampRange(paras, r0);
  if (RT.collapsed(r)) return null;
  return paras.map((p, i) => {
    if (i < r.start.p || i > r.end.p) return p;
    const a = i === r.start.p ? r.start.o : 0;
    const b = i === r.end.p ? r.end.o : RT.paraText(p).length;
    if (b <= a) return p;
    let [runs, ia] = RT.splitRunsAt(p.runs, a);
    let ib: number;
    [runs, ib] = RT.splitRunsAt(runs, b);
    runs = runs.map((x, k) => (k >= ia && k < ib && x.text && !x.comments?.includes(id) ? { ...x, comments: [...(x.comments ?? []), id] } : x));
    return { ...p, runs: RT.mergeRuns(runs) };
  });
}

/** The paragraphs with the comments `ids` taken off their runs (the same array when none is there). */
export function untagComments(paras: TextParagraph[], ids: ReadonlySet<string>): TextParagraph[] {
  if (!ids.size || !paras.some((p) => p.runs.some((r) => r.comments?.some((c) => ids.has(c))))) return paras;
  return paras.map((p) => {
    if (!p.runs.some((r) => r.comments?.some((c) => ids.has(c)))) return p;
    const runs = p.runs.map((r) => {
      if (!r.comments?.some((c) => ids.has(c))) return r;
      const keep = r.comments.filter((c) => !ids.has(c));
      const { comments: _c, ...rest } = r;
      return (keep.length ? { ...rest, comments: keep } : rest) as TextRun;
    });
    return { ...p, runs: RT.mergeRuns(runs) };
  });
}

/** The paragraphs with reply `reply` on every run its parent comment `parent` covers (Word gives a reply the same range). */
export function tagReply(paras: TextParagraph[], parent: string, reply: string): TextParagraph[] {
  if (!paras.some((p) => p.runs.some((r) => r.comments?.includes(parent)))) return paras;
  return paras.map((p) => (p.runs.some((r) => r.comments?.includes(parent)) ? { ...p, runs: RT.mergeRuns(p.runs.map((r) => (r.comments?.includes(parent) && !r.comments.includes(reply) ? { ...r, comments: [...r.comments, reply] } : r))) } : p));
}

// ── the comment list ──

/** A new comment of the reviewer (now). */
export function newComment(text: string, parent?: string): DocComment {
  const name = reviewAuthor();
  const c: DocComment = { id: newCommentId(), author: name, date: localNow(), text };
  const ini = initialsOf(name);
  if (ini) c.initials = ini;
  if (parent) c.parent = parent;
  return c;
}

/** Initials as Word makes them: the first letter of each word (a Korean name: its first syllable). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  if (words.length === 1 && /[ㄱ-힣]/.test(words[0])) return [...words[0]][0];
  return words.map((w) => [...w][0].toUpperCase()).join("").slice(0, 9);
}

/** The thread a comment is in: its first comment (a reply's parent chain followed up). */
export function threadRoot(list: readonly DocComment[], id: string): string {
  const seen = new Set<string>();
  let c = list.find((x) => x.id === id);
  while (c?.parent && !seen.has(c.id)) {
    seen.add(c.id);
    const up = list.find((x) => x.id === c!.parent);
    if (!up) break;
    c = up;
  }
  return c?.id ?? id;
}

/** The comment and the replies under it (ids). */
export function threadIds(list: readonly DocComment[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of list) if (c.parent && out.has(c.parent) && !out.has(c.id)) out.add(c.id), (grew = true);
  }
  return out;
}

/** Resolve / reopen a thread (Word marks each comment of it done). */
export function setThreadDone(list: readonly DocComment[], id: string, done: boolean): DocComment[] {
  const ids = threadIds(list, threadRoot(list, id));
  return list.map((c) => {
    if (!ids.has(c.id) || !!c.done === done) return c;
    if (done) return { ...c, done: true };
    const { done: _d, ...rest } = c;
    return rest;
  });
}

/** A comment with new text. */
export const editComment = (list: readonly DocComment[], id: string, text: string): DocComment[] => list.map((c) => (c.id === id && c.text !== text ? { ...c, text } : c));

// ── accepting and rejecting tracked changes ──

/** Where a change is: its story paragraph (index, id) and characters, and whether it is of the text, its format or a paragraph's. */
export interface ChangeAt {
  para: number;
  paraId: string;
  from: number;
  to: number;
  level: "run" | "fmt" | "mark" | "para";
}

/** Which changes to act on. */
export type ChangePick = (rev: Revision, at: ChangeAt) => boolean;

/** One change as the review panel and the context menu name it: its kind, author and id in the file. */
export const changeKey = (level: ChangeAt["level"], rev: Revision) => `${level === "run" ? rev.kind : level}|${rev.author ?? ""}|${rev.src ?? ""}`;

/**
 * Accept (true) or reject (false) the picked changes. An insertion accepted / a deletion rejected becomes plain text;
 * an insertion rejected / a deletion accepted goes (a paragraph mark that goes joins its paragraph with the next one).
 * A format change keeps the format shown (the format before it is not kept: its mark goes either way). Returns the
 * paragraphs (the same array when nothing was picked) and how many changes were acted on.
 */
export function resolveChanges(paras: TextParagraph[], accept: boolean, pick: ChangePick): { paras: TextParagraph[]; count: number } {
  const keys = new Set<string>();
  const pass: { p: TextParagraph; join: boolean }[] = [];
  let any = false;
  paras.forEach((p, i) => {
    let o = 0;
    let changed = false;
    const runs: TextRun[] = [];
    for (const r of p.runs) {
      const at: ChangeAt = { para: i, paraId: p.id, from: o, to: o + r.text.length, level: "run" };
      o += r.text.length;
      let x: TextRun | null = r;
      if (r.rev && pick(r.rev, at)) {
        keys.add(`${i}|${changeKey("run", r.rev)}`);
        changed = true;
        const removed = isRemoved(r) ? accept : !accept;
        if (removed) x = null;
        else {
          const { rev: _r, ...rest } = r;
          x = rest as TextRun;
        }
      }
      if (x?.fmtRev && pick(x.fmtRev, { ...at, level: "fmt" })) {
        keys.add(`${i}|${changeKey("fmt", x.fmtRev)}`);
        changed = true;
        // rejected: the format before it comes back when it is known (a change made here: Revision.was)
        const back = !accept ? RT.formerRun(x) : null;
        const { fmtRev: _f, ...rest } = back ?? x;
        x = rest as TextRun;
      }
      if (x) runs.push(x);
    }
    let q: TextParagraph = p;
    if (changed) {
      q = { ...p, runs: runs.length ? RT.mergeRuns(runs) : [{ ...withoutReview(p.runs[0] ?? ({} as TextRun)), text: "" } as TextRun] };
      any = true;
    }
    const len = RT.paraText(q).length;
    if (q.fmtRev && pick(q.fmtRev, { para: i, paraId: p.id, from: 0, to: len, level: "para" })) {
      keys.add(`${i}|${changeKey("para", q.fmtRev)}`);
      const { fmtRev: _f, ...rest } = q;
      q = rest;
      any = true;
    }
    if (q.markFmtRev && pick(q.markFmtRev, { para: i, paraId: p.id, from: len, to: len, level: "mark" })) {
      // the mark's format change: its mark goes either way, like a run's (the format before it is not kept)
      keys.add(`${i}|${changeKey("mark", q.markFmtRev)}`);
      const { markFmtRev: _k, ...rest } = q;
      q = rest;
      any = true;
    }
    let join = false;
    if (q.markRev && pick(q.markRev, { para: i, paraId: p.id, from: len, to: len, level: "mark" })) {
      keys.add(`${i}|${changeKey("mark", q.markRev)}`);
      const gone = isRemoved({ rev: q.markRev }) ? accept : !accept;
      const { markRev: _m, ...rest } = q;
      q = rest;
      join = gone && i < paras.length - 1;
      any = true;
    }
    pass.push({ p: q, join });
  });
  if (!any) return { paras, count: 0 };
  const out: TextParagraph[] = [];
  let joining = false;
  for (const { p, join } of pass) {
    if (joining) {
      const prev = out[out.length - 1];
      const merged: TextParagraph = { ...prev, runs: RT.mergeRuns([...prev.runs.filter((r) => r.text), ...p.runs]) };
      if (p.markRev) merged.markRev = p.markRev;
      else delete merged.markRev;
      // (the joined paragraph ends in the next one's mark, with its format change)
      if (p.markFmtRev) merged.markFmtRev = p.markFmtRev;
      else delete merged.markFmtRev;
      out[out.length - 1] = merged;
    } else out.push(p);
    joining = join;
  }
  // (a change cut by a paragraph end counts once per paragraph it is in)
  return { paras: out, count: new Set([...keys].map((k) => k.slice(k.indexOf("|") + 1))).size };
}

export const pickAll: ChangePick = () => true;

/** The changes inside range `r` of the story (a collapsed range: the change at the caret, or the paragraph mark there). */
export function pickInRange(paras: TextParagraph[], r0: RT.Range): ChangePick | null {
  const r = RT.clampRange(paras, r0);
  if (!RT.collapsed(r)) {
    const inside = (at: ChangeAt) => {
      const a = { p: at.para, o: at.from }, b = { p: at.para, o: at.to };
      if (at.level === "mark") return at.para >= r.start.p && at.para < r.end.p;
      if (at.level === "para") return at.para >= r.start.p && at.para <= r.end.p;
      return RT.cmpPos(b, r.start) > 0 && RT.cmpPos(a, r.end) < 0;
    };
    return (_rev, at) => inside(at);
  }
  const ref = changeAt(paras, r.start);
  if (!ref) return null;
  return (rev, at) => at.para === ref.para && changeKey(at.level, rev) === ref.key && at.from >= ref.from && at.to <= ref.to && (ref.level === "mark" ? at.level === "mark" : at.level !== "mark");
}

/**
 * The change at a caret of the story: the run's change touching it (the neighbouring runs of the same change with it),
 * else the paragraph's own change (its mark when the caret is at its end, its format change). Null when there is none.
 */
export function changeAt(paras: TextParagraph[], pos: RT.Pos): (ChangeAt & { key: string }) | null {
  const p = paras[pos.p];
  if (!p) return null;
  const runs = p.runs;
  let acc = 0;
  const spans = runs.map((r) => {
    const s = { r, from: acc, to: acc + r.text.length };
    acc += r.text.length;
    return s;
  });
  const hit = spans.find((s) => s.r.text && (s.r.rev || s.r.fmtRev) && pos.o >= s.from && pos.o <= s.to && (pos.o < s.to || !spans.some((t) => t.from === pos.o && t.r.text && (t.r.rev || t.r.fmtRev))));
  if (hit) {
    const level: ChangeAt["level"] = hit.r.rev ? "run" : "fmt";
    const key = changeKey(level, (hit.r.rev ?? hit.r.fmtRev)!);
    let i = spans.indexOf(hit), j = i;
    const same = (s: (typeof spans)[number]) => !!(level === "run" ? s.r.rev : s.r.fmtRev) && changeKey(level, (level === "run" ? s.r.rev : s.r.fmtRev)!) === key;
    while (i > 0 && same(spans[i - 1])) i--;
    while (j < spans.length - 1 && same(spans[j + 1])) j++;
    return { para: pos.p, paraId: p.id, from: spans[i].from, to: spans[j].to, level, key };
  }
  const len = acc;
  if (p.markRev && pos.o === len) return { para: pos.p, paraId: p.id, from: len, to: len, level: "mark", key: changeKey("mark", p.markRev) };
  if (p.markFmtRev && pos.o === len) return { para: pos.p, paraId: p.id, from: len, to: len, level: "mark", key: changeKey("mark", p.markFmtRev) };
  if (p.fmtRev) return { para: pos.p, paraId: p.id, from: 0, to: len, level: "para", key: changeKey("para", p.fmtRev) };
  return null;
}

/** Whether the story paragraphs hold a tracked change. */
export const hasChanges = (paras: readonly TextParagraph[]) => paras.some((p) => p.markRev || p.fmtRev || p.markFmtRev || p.runs.some((r) => r.rev || r.fmtRev));

// ── the document's paragraphs, all of them ──

/**
 * The pages with `fn` run on every story: each flowing page run's body (then flowed again), the paragraphs of other
 * text frames and of every table cell. The same array when nothing changed.
 */
export function mapStories(pages: Page[], fn: (paras: TextParagraph[]) => TextParagraph[]): Page[] {
  const node = (n: SceneNode): SceneNode => {
    if (n.type === "TEXT" && !n.flow) {
      const ps = fn(n.paragraphs);
      return ps === n.paragraphs ? n : { ...n, paragraphs: ps };
    }
    if (n.type === "TABLE") {
      let changed = false;
      const rows = n.rows.map((row) =>
        row.map((c) => {
          if (!c.richText?.length) return c;
          const ps = fn(c.richText);
          if (ps === c.richText) return c;
          changed = true;
          // the cell's plain text follows its rich text while they matched
          const same = c.richText.map((q) => q.runs.map((r) => r.text).join("")).join("\n") === c.text;
          return { ...c, richText: ps, ...(same ? { text: ps.map((q) => q.runs.map((r) => r.text).join("")).join("\n") } : {}) };
        }),
      );
      return changed ? { ...n, rows } : n;
    }
    return n;
  };
  let out = pages.map((pg) => {
    const nodes = pg.nodes.map(node);
    return nodes.some((x, i) => x !== pg.nodes[i]) ? { ...pg, nodes } : pg;
  });
  for (let i = 0; i < out.length; ) {
    const seg = segmentAt(out, i);
    if (isFlowSegment(out, seg)) {
      const st = gatherStory(out, seg);
      const ps = fn(st.paras);
      if (ps !== st.paras) out = reflowSegment(out, seg.start, { ...st, paras: ps, objs: reanchor(st.objs, st.paras, ps) });
    }
    i = segmentAt(out, seg.start).end;
  }
  return out.every((p, i) => p === pages[i]) && out.length === pages.length ? pages : out;
}

/** The pages with the document's comment list `list` (on the first page). */
export function withComments(pages: Page[], list: DocComment[]): Page[] {
  if (!pages.length) return pages;
  const first = { ...pages[0] };
  if (list.length) first.comments = list;
  else delete first.comments;
  return [first, ...pages.slice(1)];
}
