// Comments and tracked changes (메모·변경 내용 추적) — reading and showing them (stage 1: no adding, accepting or
// rejecting yet).
//
// The importers (io/office.ts) put a tracked change on the runs it covers (TextRun.rev: inserted, deleted, moved away /
// here; TextRun.fmtRev: character format changed) and on paragraphs (TextParagraph.markRev / fmtRev). Deleted text stays
// in the runs, as Word and 한글 keep it in the file: the markup view draws it struck through, the final view leaves it
// out of the lines (core/text.ts lays it out with no width). A comment's text lives on the document's first page
// (Page.comments) and its range on the runs (TextRun.comments). The Office Surgeon writes untouched paragraphs as they
// were, so the file's own comments and changes stay byte for byte.

import type { DocComment, Page, Revision, SceneNode, TextParagraph, TextRun } from "./types";
export type { Revision } from "./types";

// ── view ──

/** markup = changes drawn in colour with their lines (Word '모든 변경 내용'); final = as if every change were accepted */
export type ReviewView = "markup" | "final";

let view: ReviewView = "markup";
export const reviewView = (): ReviewView => view;
/**
 * Set the view. The caller drops laid-out text afterwards (core/text.ts fontsChanged) and repaints: the final view
 * lays deleted text out with no width (ui/reviewActions.ts does both).
 */
export function setReviewView(v: ReviewView) {
  view = v;
}

// ── authoring (stage 2): recording changes while typing, the reviewer's name ──

let tracking = false;
/** Whether typing and deleting are recorded as tracked insertions / deletions (core/richtext.ts). */
export const trackingOn = () => tracking;
export function setTracking(on: boolean) {
  tracking = on;
}

/** used when the settings have no reviewer name (the UI passes its own word for it) */
let fallbackAuthor = "Author";
let author = "";
/** The reviewer name new comments and changes are written with: the settings' name, else the fallback word. */
export const reviewAuthor = () => author || fallbackAuthor;
export function setReviewAuthor(name: string, fallback?: string) {
  author = name.trim();
  if (fallback) fallbackAuthor = fallback;
}

/** This computer's clock time without a zone (as Word's w:date and 한글's memo time are read: core/review.ts). */
export function localNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let revSeq = 0;
const revBase = Date.now().toString(36);
/** A change made now by the reviewer (`src` new, so it never meets a change of the file). */
export function newRevision(kind: Revision["kind"]): Revision {
  return { kind, author: reviewAuthor(), date: localNow(), src: `omw-${revBase}-${++revSeq}` };
}

/** A new comment id (written as the file's own id kind when saved). */
export const newCommentId = () => `omw-c${revBase}-${++revSeq}`;

/**
 * Whether the change was made in this editing session (newRevision: its `src` starts with this session's mark). A change
 * read from a file never is — even one of the same author name (someone else named alike, or the settings' empty name
 * written as the word 'Author'): QA doc-review2.
 */
export const isSessionRevision = (rev: Revision | undefined): boolean => !!rev?.src && rev.src.startsWith(`omw-${revBase}-`);

/** The reviewer's own change of `kind` made in this session (same name now, made here: isSessionRevision). */
export const isOwnRevision = (rev: Revision | undefined, kind: Revision["kind"]): boolean => !!rev && rev.kind === kind && (rev.author ?? "") === reviewAuthor() && isSessionRevision(rev);

/** The reviewer's own insertion of this session (deleting it removes the text: it was never part of the document before). */
export const isOwnInsertion = (rev: Revision | undefined): boolean => isOwnRevision(rev, "ins");

/** Text the change took out of the document: deleted, or moved away from here. */
export const isRemoved = (r: Pick<TextRun, "rev">): boolean => r.rev?.kind === "del" || r.rev?.kind === "moveFrom";

/** The run takes no room and is not drawn in the current view. */
export const hiddenInView = (r: Pick<TextRun, "rev">): boolean => view === "final" && isRemoved(r);

/**
 * The offset `o` of the paragraph moved past the text the view hides right next to it in direction `dir` (the final
 * view's deleted text): a caret step or a Backspace / Delete there acts on the visible character beyond it, never on
 * text the reader cannot see. `o` itself when nothing is hidden there.
 */
export function skipHidden(p: Pick<TextParagraph, "runs">, o: number, dir: -1 | 1): number {
  if (view !== "final") return o;
  for (let moved = true; moved; ) {
    moved = false;
    let acc = 0;
    for (const r of p.runs) {
      const end = acc + r.text.length;
      if (r.text && hiddenInView(r) && (dir > 0 ? o >= acc && o < end : o > acc && o <= end)) {
        o = dir > 0 ? end : acc;
        moved = true;
        break;
      }
      acc = end;
    }
  }
  return o;
}

/** Whether two runs carry the same change and comment marks (runs of different marks are never merged into one). */
export function sameMarks(a: Pick<TextRun, "rev" | "fmtRev" | "comments">, b: Pick<TextRun, "rev" | "fmtRev" | "comments">): boolean {
  if (!a.rev && !b.rev && !a.fmtRev && !b.fmtRev && !a.comments?.length && !b.comments?.length) return true;
  // (a format change made here with a different format before it is another piece of the change: never merged)
  const rev = (x?: Revision) => (x ? `${x.kind}|${x.author ?? ""}|${x.date ?? ""}|${x.src ?? ""}${x.was ? "|" + JSON.stringify(x.was) : ""}` : "");
  return rev(a.rev) === rev(b.rev) && rev(a.fmtRev) === rev(b.fmtRev) && (a.comments ?? []).join("\u0001") === (b.comments ?? []).join("\u0001");
}

// ── colours (one per author, as Word's '작성자별') ──

/** Word-like reviewer colours, picked by author */
const AUTHOR_COLORS = ["#b5082e", "#1f5fa8", "#7a3fa0", "#b85c00", "#00706b", "#a0006a", "#4a6a00", "#6b4a2b"];
/** moved text (Word draws moves green, double-lined) */
export const MOVE_COLOR = "#2e7d32";
/** shading of commented text */
export const COMMENT_FILL = "#fbe9a6";
/** shading of the comment the panel has selected */
export const COMMENT_FILL_ON = "#f6cf5a";

/** A stable colour for an author (the same name always gets the same colour). */
export function authorColor(author: string | undefined): string {
  const s = author ?? "";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length];
}

let activeComment: string | null = null;
/** The comment the panel has selected: its range is shaded stronger. */
export function setActiveComment(id: string | null) {
  activeComment = id;
}
export const activeCommentId = () => activeComment;

/**
 * The run as the current view draws it: in the markup view inserted text underlined and deleted text struck through in
 * its author's colour, moved text green, commented text shaded. The same object when nothing changes.
 */
export function reviewLook(r: TextRun): TextRun {
  if (view !== "markup" || (!r.rev && !r.comments?.length)) return r;
  const out: TextRun = { ...r };
  const k = r.rev?.kind;
  if (k === "ins" || k === "moveTo") {
    out.underline = true;
    out.color = k === "moveTo" ? MOVE_COLOR : authorColor(r.rev!.author);
  } else if (k === "del" || k === "moveFrom") {
    out.strike = true;
    out.color = k === "moveFrom" ? MOVE_COLOR : authorColor(r.rev!.author);
  }
  if (r.comments?.length && !r.highlight && !printing) out.highlight = activeComment && r.comments.includes(activeComment) ? COMMENT_FILL_ON : COMMENT_FILL;
  return out;
}

let printing = false;
/**
 * Run an export / print in view `v` (PDF: with the change marks or as the final text, whatever the screen shows),
 * without the comment shading of the screen; the screen's view comes back after. Text is laid out for it (core/text.ts
 * caches lines per view: dropped before and after).
 */
export async function withReviewPrint<T>(v: ReviewView, fn: () => Promise<T>): Promise<T> {
  const was = view;
  const wasPrinting = printing;
  view = v;
  printing = true;
  if (was !== v) relayoutHook?.();
  try {
    return await fn();
  } finally {
    view = was;
    printing = wasPrinting;
    if (was !== v) relayoutHook?.();
  }
}
let relayoutHook: (() => void) | null = null;
/** What drops laid-out lines when the view changes (core/text.ts fontsChanged; set there to avoid an import cycle). */
export function setReviewRelayout(fn: () => void) {
  relayoutHook = fn;
}

// ── final text (exports without tracked changes: Markdown, HTML, plain text, PPTX …) ──

/** The runs as if every change were accepted: removed text left out, the marks dropped. */
export function acceptedRuns(runs: readonly TextRun[]): TextRun[] {
  if (!runs.some((r) => r.rev || r.fmtRev || r.comments)) return runs as TextRun[];
  return runs.filter((r) => !isRemoved(r)).map(withoutReview);
}

/** A run without its change and comment marks (new text typed next to it, accepted text). */
export function withoutReview<T extends Partial<TextRun>>(r: T): T {
  if (!r.rev && !r.fmtRev && !r.comments) return r;
  const { rev: _r, fmtRev: _f, comments: _c, ...rest } = r;
  return rest as T;
}

/** The paragraph's text as accepted (removed text left out). */
export const acceptedText = (p: Pick<TextParagraph, "runs">) => p.runs.filter((r) => !isRemoved(r)).map((r) => r.text).join("");

// ── what the review panel lists ──

/** The paragraphs of the pages in reading order: text frames and table cells (notes and headers left out). */
export function pageParagraphs(pages: readonly Page[]): TextParagraph[] {
  const out: TextParagraph[] = [];
  const visit = (n: SceneNode) => {
    if (n.type === "TEXT") out.push(...n.paragraphs);
    else if (n.type === "TABLE") for (const row of n.rows) for (const c of row) if (c.richText) out.push(...c.richText);
  };
  for (const pg of pages) for (const n of pg.nodes) visit(n);
  return out;
}

/** One tracked change as the panel lists it. */
export interface ChangeItem {
  /** "para": a paragraph format change; "markIns" / "markDel": a paragraph mark inserted / deleted (a paragraph split / joined) */
  kind: Revision["kind"] | "para" | "markIns" | "markDel";
  author?: string;
  date?: string;
  /** the changed text (or the paragraph's text for a paragraph change), shortened */
  text: string;
  /** the paragraph it is in */
  para: string;
  /** the change as core/reviewEdit.ts changeKey names it, and every paragraph it is in (ids; pieces of a cut paragraph by the paragraph they belong to) */
  key: string;
  paras: string[];
}

const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * The tracked changes of the paragraphs in order: neighbouring runs of one change (same kind, author and file id) are
 * one item, also over a paragraph cut at a page end.
 */
export function collectChanges(paras: readonly TextParagraph[]): ChangeItem[] {
  type Open = ChangeItem & { group: string; full: string };
  const out: Open[] = [];
  let last: Open | null = null;
  const name = (rev: Revision) => `${rev.author ?? ""}|${rev.src ?? ""}`;
  const push = (kind: ChangeItem["kind"], rev: Revision, text: string, p: TextParagraph, group: string, key: string) => {
    const pid = p.flowCont ?? p.id;
    if (last && last.group === group) {
      last.full += text;
      last.text = short(last.full);
      if (!last.paras.includes(pid)) last.paras.push(pid);
      return;
    }
    last = { kind, author: rev.author, date: rev.date, text: short(text), full: text, para: p.id, group, key, paras: [pid] };
    out.push(last);
  };
  for (const p of paras) {
    if (p.fmtRev) {
      push("para", p.fmtRev, p.runs.map((r) => r.text).join(""), p, `para|${p.id}|${p.fmtRev.src ?? ""}`, `para|${name(p.fmtRev)}`);
      last = null;
    }
    for (const r of p.runs) {
      if (r.rev) push(r.rev.kind, r.rev, r.text, p, `${r.rev.kind}|${name(r.rev)}`, `${r.rev.kind}|${name(r.rev)}`);
      else if (!r.fmtRev && r.text) last = null;
      if (r.fmtRev) {
        // a format change is its own item (it may lie inside an insertion)
        const keep: Open | null = last;
        last = null;
        push("fmt", r.fmtRev, r.text, p, `fmt|${name(r.fmtRev)}`, `fmt|${name(r.fmtRev)}`);
        if (r.rev) last = keep;
      }
    }
    // the paragraph's mark inserted / deleted (a paragraph made / joined): an item of its own unless it is part of a
    // move (Word moves whole paragraphs with their marks) or of the text change it ends; a piece cut at a page end has
    // no mark of its own
    if (p.markRev && !p.flowSplit && (p.markRev.kind === "ins" || p.markRev.kind === "del")) {
      const keep = last as Open | null;
      const along = !!keep && keep.key === `${p.markRev.kind}|${name(p.markRev)}`;
      if (!along) {
        last = null;
        push(p.markRev.kind === "ins" ? "markIns" : "markDel", p.markRev, "¶", p, `mark|${p.id}|${name(p.markRev)}`, `mark|${name(p.markRev)}`);
        last = null;
      }
    }
    // the mark's own format changed (Word w:pPr/w:rPr/w:rPrChange: an empty paragraph's format): a format item — not
    // the document's last mark, which Word does not list either (Revisions, Word 2024; accepting all still takes it)
    if (p.markFmtRev && !p.flowSplit && p !== paras[paras.length - 1]) {
      const keep = last as Open | null;
      last = null;
      push("fmt", p.markFmtRev, "¶", p, `markFmt|${p.id}|${name(p.markFmtRev)}`, `fmt|${name(p.markFmtRev)}`);
      last = keep;
    }
  }
  return out.map(({ kind, author, date, text, para, key, paras }) => ({ kind, author, date, text, para, key, paras }));
}

/** The comments of a document (they live on its first page). */
export const docComments = (pages: readonly Pick<Page, "comments">[]): DocComment[] => pages[0]?.comments ?? [];

/** Comments with their replies (a reply whose parent is unknown is shown as a comment of its own). */
export function commentThreads(list: readonly DocComment[]): { c: DocComment; replies: DocComment[] }[] {
  const ids = new Set(list.map((c) => c.id));
  const top = list.filter((c) => !c.parent || !ids.has(c.parent));
  const rootOf = (c: DocComment): string => {
    const seen = new Set<string>();
    let x = c;
    while (x.parent && ids.has(x.parent) && !seen.has(x.id)) {
      seen.add(x.id);
      x = list.find((y) => y.id === x.parent)!;
    }
    return x.id;
  };
  return top.map((c) => ({ c, replies: list.filter((r) => r !== c && r.parent && ids.has(r.parent) && rootOf(r) === c.id) }));
}

/** The text a comment covers (its runs in reading order), shortened. */
export function commentedText(paras: readonly TextParagraph[], id: string, n = 50): string {
  let s = "";
  for (const p of paras) {
    let inP = false;
    for (const r of p.runs)
      if (r.comments?.includes(id)) {
        s += r.text;
        inP = true;
      }
    if (inP && s && !s.endsWith(" ")) s += " ";
    if (s.length > n) break;
  }
  return short(s.trim(), n);
}

/** Whether the pages hold any comment or tracked change (the panel offers its tab). */
export function hasReview(pages: readonly Page[]): boolean {
  if (docComments(pages).length) return true;
  return pageParagraphs(pages).some((p) => p.fmtRev || p.markRev || p.markFmtRev || p.runs.some((r) => r.rev || r.fmtRev));
}

// ── accepted copies for writers without tracked changes ──

const marked = (p: TextParagraph) => !!(p.markRev || p.fmtRev || p.markFmtRev) || p.runs.some((r) => r.rev || r.fmtRev || r.comments || r.note?.paras.some(marked));

/** A paragraph as if every change were accepted (removed text left out, marks dropped); the same object when unmarked. */
export function acceptedParagraph(p: TextParagraph): TextParagraph {
  if (!marked(p)) return p;
  const { markRev: _m, fmtRev: _f, markFmtRev: _k, ...rest } = p;
  let runs = acceptedRuns(p.runs).map((r) => (r.note ? { ...r, note: { ...r.note, paras: r.note.paras.map(acceptedParagraph) } } : r));
  // a paragraph whose text was all deleted keeps an empty run in its format
  if (!runs.length && p.runs.length) runs = [{ ...withoutReview(p.runs[0]), text: "" }];
  return { ...rest, runs };
}

function acceptedNode(n: SceneNode): SceneNode {
  if (n.type === "TEXT") return n.paragraphs.some(marked) ? { ...n, paragraphs: n.paragraphs.map(acceptedParagraph) } : n;
  if (n.type === "TABLE" && n.rows.some((row) => row.some((c) => c.richText?.some(marked))))
    return {
      ...n,
      rows: n.rows.map((row) =>
        row.map((c) => {
          if (!c.richText?.some(marked)) return c;
          const rich = c.richText.map(acceptedParagraph);
          // the cell's plain text follows its rich text while they matched
          const same = c.richText.map((q) => q.runs.map((r) => r.text).join("")).join("\n") === c.text;
          return { ...c, richText: rich, ...(same ? { text: rich.map((q) => q.runs.map((r) => r.text).join("")).join("\n") } : {}) };
        }),
      ),
    };
  return n;
}

/**
 * The pages as if every change were accepted and without comments: for writers that have no tracked changes or comments
 * (HWPX written anew, Markdown, HTML, plain text), so deleted text never comes back as text. The same array when
 * nothing is marked.
 */
export function acceptedPages<P extends Page>(pages: readonly P[]): P[] {
  if (!pages.some((pg) => pg.comments?.length) && !pageParagraphs(pages).some(marked)) return pages as P[];
  return pages.map((pg) => {
    const { comments: _c, ...rest } = pg;
    return { ...rest, nodes: pg.nodes.map(acceptedNode) } as P;
  });
}
