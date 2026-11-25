// 책갈피 (Ctrl+Shift+F5), 캡션 삽입, 상호 참조, 필드 업데이트 (F9) — the commands over core/docRefs.ts, acting on the
// text being edited (the ribbon's text target) and on the whole document.

import { useStore } from "../core/store";
import { addBookmark, bookmarksOf, captionParagraph, captionRange, captionsOf, headingRange, headingsOf, nextCaptionNumber, refName, refRun, removeBookmark, updateFields, type RefKind } from "../core/docRefs";
import { isFlowSegment, reflowSegment, segments } from "../core/flow";
import * as RT from "../core/richtext";
import { markerLength } from "../core/richtext";
import type { Page, TextParagraph } from "../core/types";
import { t } from "../i18n";
import { beginTyping, flowActive, insertParagraphBy } from "./docFlow";
import { sheetNow, hereNow } from "./docStyleActions";
import { useCellSel } from "./CellEditor";
import { richApi } from "./RichTextEditor";
import { textTargetNow } from "./shell/Ribbon";

const S = () => useStore.getState();

/** The word at the caret (a bookmark with nothing selected covers it, as a double-click would select it). */
function wordAt(p: TextParagraph, o: number): [number, number] {
  const s = RT.paraText(p);
  const isW = (c: string) => /[\p{L}\p{N}_]/u.test(c);
  let a = o, b = o;
  while (a > 0 && isW(s[a - 1])) a--;
  while (b < s.length && isW(s[b])) b++;
  return a === b ? [0, s.length] : [a, b];
}

/** 책갈피 추가: name on the selection (or the word at the caret). False when there is no text to mark. */
export function addBookmarkNow(name: string): boolean {
  const tg = textTargetNow();
  if (!tg?.transform) return false;
  let ok = false;
  tg.transform((ps, r) => {
    let range = r;
    if (RT.collapsed(r)) {
      const [a, b] = wordAt(ps[r.start.p], r.start.o);
      if (a === b) return null;
      range = { start: { p: r.start.p, o: a }, end: { p: r.start.p, o: b } };
    }
    ok = true;
    return { paras: addBookmark(ps, range, name), sel: r };
  }, t("docref.hist.bookmark", { name }));
  return ok;
}

/** Take bookmark `name` off the document (one undo step). */
export function deleteBookmarkNow(name: string) {
  const pages = mapParas(S().doc.pages, (ps) => removeBookmark(ps, name));
  S().commit(t("docref.hist.bookmarkDelete", { name }), (d) => {
    d.pages = pages as typeof d.pages;
  });
}

/** 이동: select bookmark `name` in the text being edited (false when it is not in it). */
export function goToBookmark(name: string): boolean {
  const api = richApi();
  const snap = api?.snapshot?.();
  if (!api?.select || !snap) return false;
  let start: RT.Pos | null = null, end: RT.Pos | null = null;
  snap.paras.forEach((p, i) => {
    let o = 0;
    for (const r of p.runs) {
      if (r.bookmarks?.includes(name)) {
        start ??= { p: i, o };
        end = { p: i, o: o + r.text.length };
      }
      o += r.text.length;
    }
  });
  if (!start || !end) return false;
  api.select({ start, end });
  return true;
}

/** Every paragraph list of the pages through `fn` (frames, text boxes, table cells); unchanged pages stay. */
function mapParas(pages: readonly Page[], fn: (ps: TextParagraph[]) => TextParagraph[]): Page[] {
  return pages.map((pg) => {
    const nodes = pg.nodes.map((n) => {
      if (n.type === "TEXT") {
        const ps = fn(n.paragraphs);
        return ps === n.paragraphs ? n : { ...n, paragraphs: ps };
      }
      if (n.type === "TABLE") {
        let ch = false;
        const rows = n.rows.map((row) =>
          row.map((c) => {
            if (!c.richText?.length) return c;
            const ps = fn(c.richText);
            if (ps === c.richText) return c;
            ch = true;
            return { ...c, richText: ps };
          }),
        );
        return ch ? { ...n, rows } : n;
      }
      return n;
    });
    return nodes.every((n, i) => n === pg.nodes[i]) ? pg : { ...pg, nodes };
  });
}

// ───────── captions ─────────

/** The table or picture the caption is for: the one selected or being edited, else none (the caret's paragraph). */
function captionTarget(): { id: string; kind: "table" | "figure" } | null {
  const s = S();
  const cell = useCellSel.getState().target;
  const pg = s.doc.pages.find((p) => p.id === s.pageId);
  const id = cell?.nodeId ?? s.selection[0];
  const n = id ? pg?.nodes.find((x) => x.id === id) : undefined;
  if (n?.type === "TABLE") return { id: n.id, kind: "table" };
  if (n?.type === "IMAGE") return { id: n.id, kind: "figure" };
  // the caret in a paragraph holding a picture like a character
  const h = hereNow();
  const obj = h?.para.runs.find((r) => r.obj);
  if (obj?.obj) return { id: obj.obj.id, kind: "figure" };
  return null;
}

/** What 캡션 삽입 is for now: a table above, a picture below (Word's defaults). */
export function captionDefaults(): { label: "figure" | "table"; where: "above" | "below" } {
  const tg = captionTarget();
  return tg?.kind === "table" ? { label: "table", where: "above" } : { label: "figure", where: "below" };
}

/** The number the next caption of `label` gets at the caret. */
export function captionNumberNow(label: string): number {
  const h = hereNow();
  return nextCaptionNumber(S().doc.pages, label, h ? { para: h.para.id } : null);
}

/**
 * 캡션 삽입: "{label} {n}{text}" in the caption style above / below the selected table or picture (or the caret's
 * paragraph); the captions after it are numbered again. False when there is no body to put it in.
 */
export function insertCaption(label: string, text: string, where: "above" | "below"): boolean {
  const s = S();
  const target = captionTarget();
  if (!flowActive() && !beginTyping(s.pageId)) {
    s.notify(t("docref.noBody"));
    return false;
  }
  const sheet = sheetNow();
  const n = captionNumberNow(label);
  // (a picture's caption lines up with a centred picture paragraph)
  const p = captionParagraph(sheet, label, n, text, target && hereNow()?.para.align === "CENTER" ? "CENTER" : undefined);
  if (!insertParagraphBy(p, where, target?.id ?? null, t("docref.hist.caption", { label }))) return false;
  // the captions after it count on (Word renumbers them when its fields are updated: here at once)
  updateFieldsNow(true);
  return true;
}

// ───────── cross-references ─────────

export type RefType = "heading" | "bookmark" | { label: string };

export interface RefTarget {
  key: string;
  text: string;
  page: number;
  para?: TextParagraph;
  bookmark?: string;
}

/** The things a cross-reference of this type can point at, in document order. */
export function refTargets(type: RefType): RefTarget[] {
  const pages = S().doc.pages;
  if (type === "heading") return headingsOf(pages).map((h) => ({ key: h.para.id, text: h.text, page: h.page, para: h.para }));
  if (type === "bookmark") return bookmarksOf(pages).map((b) => ({ key: b.name, text: b.name, page: b.page, bookmark: b.name }));
  return captionsOf(pages, type.label).map((c) => ({ key: c.para.id, text: c.text, page: c.page, para: c.para }));
}

/** The bookmark the reference points at: the bookmark itself, or a hidden _Ref one put on the heading / caption text. */
function ensureBookmark(target: RefTarget, kind: RefKind, type: RefType): string | null {
  if (target.bookmark) return target.bookmark;
  const p0 = target.para;
  if (!p0) return null;
  // (a caption's whole text for its text and above / below; its label and number for those and its page)
  const whole = typeof type === "object" && (kind === "text" || kind === "aboveBelow");
  const [a, b] = type === "heading" ? headingRange(p0, markerLength(p0)) : captionRange(p0, whole);
  // a hidden bookmark already on exactly that text
  let o = 0;
  const have = new Map<string, [number, number]>();
  for (const r of p0.runs) {
    for (const nm of r.bookmarks ?? []) {
      const v = have.get(nm);
      have.set(nm, v ? [v[0], o + r.text.length] : [o, o + r.text.length]);
    }
    o += r.text.length;
  }
  for (const [nm, [x, y]] of have) if (nm.startsWith("_Ref") && x === a && y === b) return nm;
  const name = refName();
  const pages = mapParas(S().doc.pages, (ps) => {
    const i = ps.findIndex((q) => q.id === p0.id);
    if (i < 0) return ps;
    return addBookmark(ps, { start: { p: i, o: a }, end: { p: i, o: b } }, name);
  });
  S().commit(t("docref.hist.bookmark", { name }), (d) => {
    d.pages = pages as typeof d.pages;
  });
  return name;
}

/** 상호 참조 삽입: a REF / PAGEREF field at the caret showing the target's text, label and number, or page. */
export function insertCrossRef(type: RefType, target: RefTarget, kind: RefKind): boolean {
  const name = ensureBookmark(target, kind, type);
  const tg = textTargetNow();
  if (!name || !tg?.transform) return false;
  // the value it shows now (the fields' update gives the same)
  const info = bookmarksOf(S().doc.pages, true).find((b) => b.name === name);
  const value = updatedValue(kind, name) ?? info?.text ?? target.text;
  tg.transform((ps, r) => {
    let paras = ps;
    let at = r.start;
    if (!RT.collapsed(r)) ({ paras, pos: at } = RT.deleteRange(ps, r));
    const run = refRun(RT.formatAt(paras, at), kind, name, value);
    const res = RT.insertRun(paras, at, run);
    return { paras: res.paras, sel: { start: res.pos, end: res.pos } };
  }, t("docref.hist.crossRef"));
  return true;
}

/** What a field of this kind to bookmark `name` shows now. */
function updatedValue(kind: RefKind, name: string): string | null {
  const probe: TextParagraph = { id: "probe", runs: [refRun({}, kind, name, "?")], align: "LEFT", lineSpacing: 1, indent: 0, spaceAfter: 0 };
  const pages = S().doc.pages;
  if (!pages.length) return null;
  const trial: Page[] = [{ ...pages[0], nodes: [...pages[0].nodes, { id: "probe-node", type: "TEXT", paragraphs: [probe] } as never] }, ...pages.slice(1)];
  const r = updateFields(trial, { above: t("docref.above"), below: t("docref.below") });
  const node = r.pages[0].nodes.find((n) => n.id === "probe-node");
  const v = node && node.type === "TEXT" ? node.paragraphs[0].runs[0].text : null;
  return v && v !== "?" ? v : null;
}

// ───────── updating ─────────

/** F9: every field of the document again (caption numbers, cross-references); `quiet` = no message. */
export function updateFieldsNow(quiet = false): boolean {
  const s = S();
  const r = updateFields(s.doc.pages, { above: t("docref.above"), below: t("docref.below") });
  if (!r.changed) {
    if (!quiet) s.notify(r.missing ? t("docref.missing", { n: r.missing }) : t("docref.upToDate"));
    return false;
  }
  let pages = r.pages;
  for (const seg of segments(pages)) {
    let touched = false;
    for (let i = seg.start; i < seg.end; i++) if (pages[i] !== s.doc.pages[i]) touched = true;
    if (touched && isFlowSegment(pages, seg)) pages = reflowSegment(pages, seg.start);
  }
  s.commit(t("docref.hist.update"), (d) => {
    d.pages = pages as typeof d.pages;
  });
  if (!quiet) s.notify(r.missing ? t("docref.missing", { n: r.missing }) : t("docref.updated", { n: r.changed }));
  return true;
}

/** The labels captions can use: Word's three and the ones the document's captions already have. */
export function captionLabels(): string[] {
  const base = [t("docref.label.figure"), t("docref.label.table"), t("docref.label.equation")];
  const used = captionsOf(S().doc.pages).map((c) => c.label);
  return [...new Set([...base, ...used])];
}
