// The review commands (메모·변경 내용 추적, core/review.ts and core/reviewEdit.ts): markup / final view, the comment the
// panel has selected, going to a comment or change in the body (stage 1), and from stage 2 adding, answering,
// resolving, editing and deleting comments, recording changes on / off, accepting and rejecting changes. Every edit is
// one undo step of the document.

import { create } from "zustand";
import { setActiveComment, setReviewAuthor, setReviewView, setTracking, trackingOn, docComments, type ChangeItem, type ReviewView } from "../core/review";
import { changeAt, changeKey, editComment, mapStories, newComment, pickAll, pickInRange, resolveChanges, setThreadDone, tagComment, tagReply, threadIds, threadRoot, untagComments, withComments, type ChangePick } from "../core/reviewEdit";
import type * as RT from "../core/richtext";
import { useStore } from "../core/store";
import { fontsChanged, layoutText } from "../core/text";
import type { DocComment, Page, TextParagraph } from "../core/types";
import { t } from "../i18n";
import { beginTyping, flowSelection, sealTyping, storyEdit } from "./docFlow";
import { goToPage } from "./shell/DocNav";
import { useUI } from "./shell/uiStore";

/** A comment being written in the review pane: a new one on `range` of the story `segId`, a reply, or an edit. */
export interface Composer {
  mode: "new" | "reply" | "edit";
  /** the comment answered / edited */
  id?: string;
  segId?: string;
  range?: RT.Range;
  /** the words the new comment is on (shown above the box) */
  quote?: string;
  /** the text it starts with (an edit) */
  text?: string;
}

export const useReview = create<{ view: ReviewView; active: string | null; tracking: boolean; composer: Composer | null }>(() => ({ view: "markup", active: null, tracking: false, composer: null }));

const S = () => useStore.getState();

/** Painted tiles (and, for the final view, laid-out lines) are dropped and the pages drawn again. */
function repaint(relayout: boolean) {
  if (relayout) fontsChanged();
  // (the canvas module is loaded lazily: commands and shortcuts import this file outside the browser too)
  void import("./CanvasView").then((m) => m.weave.clear());
  const st = useStore.getState();
  st.set({ view: { ...st.view } });
}

/** Markup (changes in colour) or final (as if accepted); the file does not change. */
export function setReviewViewNow(v: ReviewView) {
  if (useReview.getState().view === v) return;
  setReviewView(v);
  useReview.setState({ view: v });
  repaint(true);
}

/** Shade one comment's range stronger (null: none). */
export function selectComment(id: string | null) {
  setActiveComment(id);
  useReview.setState({ active: id });
  repaint(false);
}

/** Go to the body paragraph `paraId` (or the first one whose runs `has`): its page becomes current, scrolled to it. */
export function goToParagraph(paraId: string | null, has?: (runs: { comments?: string[] }[]) => boolean) {
  const doc = useStore.getState().doc;
  for (const page of doc.pages)
    for (const n of page.nodes) {
      if (n.type !== "TEXT") {
        if (n.type === "TABLE" && n.rows.some((row) => row.some((c) => c.richText?.some((p) => p.id === paraId || (has && has(p.runs)))))) return goToPage(page.id, n.transform.y);
        continue;
      }
      const i = n.paragraphs.findIndex((p) => p.id === paraId || p.flowCont === paraId || (has && has(p.runs)));
      if (i < 0) continue;
      const line = layoutText(n).lines.find((l) => l.paragraph === i);
      return goToPage(page.id, n.transform.y + (line ? line.y * n.transform.scale : 0));
    }
}

function commitPages(label: string, pages: Page[]) {
  if (pages === S().doc.pages) return;
  // the body's typing group ends first: this is a step of its own (QA doc-review2)
  sealTyping();
  S().commit(label, (d) => {
    d.pages = pages as typeof d.pages;
  });
}

// ── reviewer name and recording changes ──

/** The reviewer name of the settings (empty: the word 'Author' of the language) for new comments and changes. */
function syncAuthor() {
  setReviewAuthor(useUI.getState().reviewAuthor ?? "", t("review.defaultAuthor"));
}

/** Recording follows the document's setting (its first page; read from the file). */
function syncTracking() {
  const on = !!S().doc.pages[0]?.trackChanges;
  if (trackingOn() !== on) setTracking(on);
  if (useReview.getState().tracking !== on) useReview.setState({ tracking: on });
}

if (typeof window !== "undefined") {
  syncAuthor();
  syncTracking();
  useUI.subscribe((s, p) => s.reviewAuthor !== p.reviewAuthor && syncAuthor());
  useStore.subscribe((s, p) => s.doc !== p.doc && syncTracking());
}

/** Record changes on / off (the document's setting: saved with it, as Word and 한글 do). */
export function setTrackingNow(on: boolean) {
  sealTyping();
  syncAuthor();
  const pages = S().doc.pages;
  if (!pages.length || !!pages[0].trackChanges === on) return;
  const first = { ...pages[0] };
  if (on) first.trackChanges = true;
  else delete first.trackChanges;
  commitPages(t(on ? "review.hist.trackOn" : "review.hist.trackOff"), [first, ...pages.slice(1)]);
  syncTracking();
  S().notify(t(on ? "review.toast.trackOn" : "review.toast.trackOff"));
}

// ── comments ──

/**
 * 새 메모 (Ctrl+Alt+M, the context menu, the pane's button): the review pane opens with a box for the comment on the
 * selected text — or the word at the caret. False when the caret is not in the document body.
 */
export function startComment(): boolean {
  syncAuthor();
  const fs = flowSelection();
  if (!fs) {
    S().notify(t("review.toast.pickText"));
    return false;
  }
  const range = RT_collapsed(fs.sel) ? fs.word : fs.sel;
  if (RT_collapsed(range)) {
    S().notify(t("review.toast.pickText"));
    return false;
  }
  const quote = textIn(fs.paras, range);
  useUI.getState().set({ rightOpen: true, rightTab: "review" });
  useReview.setState({ composer: { mode: "new", segId: fs.segId, range, quote } });
  return true;
}

const RT_collapsed = (r: RT.Range) => r.start.p === r.end.p && r.start.o === r.end.o;

function textIn(paras: TextParagraph[], r: RT.Range): string {
  let s = "";
  for (let i = r.start.p; i <= r.end.p && i < paras.length; i++) {
    const text = paras[i].runs.map((x) => x.text).join("");
    s += (i > r.start.p ? " " : "") + text.slice(i === r.start.p ? r.start.o : 0, i === r.end.p ? r.end.o : text.length);
  }
  return s.length > 50 ? s.slice(0, 49) + "…" : s;
}

export const reply = (id: string) => useReview.setState({ composer: { mode: "reply", id } });
export const editStart = (c: DocComment) => useReview.setState({ composer: { mode: "edit", id: c.id, text: c.text } });
export const closeComposer = () => useReview.setState({ composer: null });

/** The pane's box was sent: the new comment, reply or edit goes into the document (one undo step). */
export function submitComposer(text: string): boolean {
  const c = useReview.getState().composer;
  const body = text.replace(/\r\n?/g, "\n").trim();
  if (!c || !body) return false;
  sealTyping();
  syncAuthor();
  const list = docComments(S().doc.pages);
  let ok = false;
  if (c.mode === "new" && c.range && c.segId) {
    const nc = newComment(body);
    const run = () => storyEdit(t("review.hist.comment"), (paras) => { const ps = tagComment(paras, c.range!, nc.id); return ps ? { paras: ps } : null; }, (pages) => withComments(pages, [...docComments(pages), nc]), c.segId);
    ok = run() || (beginTyping(c.segId, c.range.start) && run());
    if (ok) selectComment(nc.id);
  } else if (c.mode === "reply" && c.id) {
    const root = threadRoot(list, c.id);
    const nc = newComment(body, root);
    commitPages(t("review.hist.reply"), withComments(mapStories(S().doc.pages, (ps) => tagReply(ps, root, nc.id)), [...list, nc]));
    ok = true;
  } else if (c.mode === "edit" && c.id) {
    commitPages(t("review.hist.editComment"), withComments(S().doc.pages, editComment(list, c.id, body)));
    ok = true;
  }
  if (ok) closeComposer();
  return ok;
}

/** Resolve / reopen a comment's thread. */
export function setCommentDone(id: string, done: boolean) {
  sealTyping();
  const list = docComments(S().doc.pages);
  commitPages(t(done ? "review.hist.resolve" : "review.hist.reopen"), withComments(S().doc.pages, setThreadDone(list, id, done)));
}

/** Delete a comment with its replies (their ranges leave the text). */
export function deleteComment(id: string) {
  sealTyping();
  const list = docComments(S().doc.pages);
  const ids = threadIds(list, id);
  const pages = mapStories(S().doc.pages, (ps) => untagComments(ps, ids));
  commitPages(t("review.hist.deleteComment"), withComments(pages, list.filter((c) => !ids.has(c.id))));
  if (useReview.getState().active && ids.has(useReview.getState().active!)) selectComment(null);
}

/** The comments on the text at the caret / selection of the body (first: the innermost one). */
export function commentsHere(): string[] {
  const fs = flowSelection();
  if (!fs) return [];
  const p = fs.paras[fs.sel.start.p];
  if (!p) return [];
  let acc = 0;
  for (const r of p.runs) {
    const end = acc + r.text.length;
    if (r.text && fs.sel.start.o >= acc && fs.sel.start.o <= end && r.comments?.length) return [...r.comments].reverse();
    acc = end;
  }
  return [];
}

// ── accepting / rejecting ──

/** The panel item's change: its key in the paragraphs it lists (a mark along a text change goes with it). */
function pickItem(item: ChangeItem): ChangePick {
  const ids = new Set(item.paras);
  return (rev, at) => ids.has(at.paraId) && (changeKey(at.level, rev) === item.key || (at.level === "mark" && changeKey("run", rev) === item.key));
}

function notifyCount(n: number, accept: boolean) {
  S().notify(n ? t(n === 1 ? (accept ? "review.toast.accepted_one" : "review.toast.rejected_one") : accept ? "review.toast.accepted" : "review.toast.rejected", { n }) : t("review.toast.noChange"));
}

/** Accept / reject one change of the panel, or all of them. */
export function resolveDoc(accept: boolean, item?: ChangeItem) {
  sealTyping();
  const pick = item ? pickItem(item) : pickAll;
  let n = 0;
  const pages = mapStories(S().doc.pages, (ps) => {
    const r = resolveChanges(ps, accept, pick);
    n += r.count;
    return r.paras;
  });
  commitPages(t(item ? (accept ? "review.hist.accept" : "review.hist.reject") : accept ? "review.hist.acceptAll" : "review.hist.rejectAll"), pages);
  if (!item) notifyCount(n, accept);
}

/** Accept / reject the changes in the body's selection, or the one at the caret (the context menu). */
export function resolveHere(accept: boolean): boolean {
  let n = 0;
  const ok = storyEdit(t(accept ? "review.hist.accept" : "review.hist.reject"), (paras, sel) => {
    const pick = pickInRange(paras, sel);
    if (!pick) return null;
    const r = resolveChanges(paras, accept, pick);
    n = r.count;
    return r.count ? { paras: r.paras } : null;
  });
  if (!ok) notifyCount(0, accept);
  return ok && n > 0;
}

/** Whether the body's caret / selection has a change to accept or reject. */
export function changeHere(): boolean {
  const fs = flowSelection();
  if (!fs) return false;
  if (RT_collapsed(fs.sel)) return !!changeAt(fs.paras, fs.sel.start);
  const pick = pickInRange(fs.paras, fs.sel);
  return !!pick && resolveChanges(fs.paras, true, pick).count > 0;
}
