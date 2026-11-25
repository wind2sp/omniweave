// Styles of the document's text (Word 홈 › 스타일, 스타일 창 Ctrl+Alt+Shift+S; 한글 스타일 F6): apply one to the
// paragraphs under the caret, change one (every paragraph in it changes too), make one from the selection, clear the
// formatting. The model is core/docStyles.ts; the text target is the one the ribbon uses (ui/shell/Ribbon.tsx).

import { useStore } from "../core/store";
import { applyStyle, changeStyle, clearFormatting, findStyle, lookOf, restyleParas, styleFromParagraph, styleIdOf, styleLabel, styleSheet, withSheet, type DocStyle } from "../core/docStyles";
import { isFlowSegment, reflowSegment, segments } from "../core/flow";
import type { Page, SceneNode, TextParagraph } from "../core/types";
import { t } from "../i18n";
import { textTargetNow } from "./shell/Ribbon";
import { richApi } from "./RichTextEditor";

const S = () => useStore.getState();

/** The document's style sheet now. */
export const sheetNow = (): DocStyle[] => styleSheet(S().doc.pages);

/** The paragraph the caret is in (first of the selection), and the paragraphs with the selection. */
export function hereNow(): { para: TextParagraph; paras: TextParagraph[]; from: number; to: number } | null {
  const snap = textTargetNow()?.snapshot?.() ?? richApi()?.snapshot?.() ?? null;
  if (!snap || !snap.paras.length) return null;
  const from = Math.min(snap.sel.start.p, snap.paras.length - 1);
  return { para: snap.paras[from], paras: snap.paras, from, to: Math.min(snap.sel.end.p, snap.paras.length - 1) };
}

/** The style of the paragraph under the caret (null: no text is being edited or selected). */
export function styleHere(): string | null {
  const h = hereNow();
  return h ? styleIdOf(h.para, sheetNow()) : null;
}

export const labelOf = (s: DocStyle) => styleLabel(s, t);

/** Apply style `id` to the paragraphs with the selection (one undo step). */
export function applyStyleNow(id: string): boolean {
  const tg = textTargetNow();
  const sheet = sheetNow();
  const s = findStyle(sheet, id);
  if (!tg?.transform || !s) return false;
  tg.transform((ps, r) => ({ paras: applyStyle(ps, r.start.p, r.end.p, sheet, id) }), t("docstyle.hist.apply", { name: labelOf(s) }));
  return true;
}

/** 서식 지우기: the default style and none of the text's own character formats. */
export function clearFormattingNow(): boolean {
  const tg = textTargetNow();
  if (!tg?.transform) return false;
  const sheet = sheetNow();
  tg.transform((ps, r) => ({ paras: clearFormatting(ps, r.start.p, r.end.p, sheet) }), t("docstyle.hist.clear"));
  return true;
}

function restyleNode(n: SceneNode, before: DocStyle[], after: DocStyle[]): SceneNode {
  if (n.type === "TEXT") {
    const ps = restyleParas(n.paragraphs, before, after);
    return ps === n.paragraphs ? n : { ...n, paragraphs: ps };
  }
  if (n.type === "TABLE") {
    let changed = false;
    const rows = n.rows.map((row) =>
      row.map((c) => {
        if (!c.richText?.length) return c;
        const ps = restyleParas(c.richText, before, after);
        if (ps === c.richText) return c;
        changed = true;
        return { ...c, richText: ps };
      }),
    );
    return changed ? { ...n, rows } : n;
  }
  return n;
}

/** The pages with every paragraph moved from sheet `before` to `after` and the flowing runs laid out again. */
export function restylePages(pages: readonly Page[], before: DocStyle[], after: DocStyle[]): Page[] {
  let out = pages.map((pg) => {
    const nodes = pg.nodes.map((n) => restyleNode(n, before, after));
    return nodes.every((n, i) => n === pg.nodes[i]) ? pg : { ...pg, nodes };
  });
  out = withSheet(out, after);
  for (const seg of segments(out)) {
    let touched = false;
    for (let i = seg.start; i < seg.end; i++) if (out[i] !== pages[i] && out[i].nodes !== pages[i].nodes) touched = true;
    if (touched && isFlowSegment(out, seg)) out = reflowSegment(out, seg.start);
  }
  return out;
}

/** Commit a new sheet: every paragraph in a changed style follows it (one undo step). */
export function commitSheet(after: DocStyle[], label: string) {
  const before = sheetNow();
  const pages = restylePages(S().doc.pages, before, after);
  S().commit(label, (d) => {
    d.pages = pages as typeof d.pages;
  });
}

/** 수정…: style `id` becomes `next` (name, look, based on, next style); its paragraphs follow. */
export function modifyStyle(id: string, next: DocStyle) {
  commitSheet(changeStyle(sheetNow(), id, next), t("docstyle.hist.modify", { name: labelOf(next) }));
}

/** 선택 영역과 일치하도록 업데이트: the style takes the look of the paragraph under the caret. */
export function updateStyleToMatch(id: string): boolean {
  const h = hereNow();
  const s = findStyle(sheetNow(), id);
  if (!h || !s) return false;
  const look = lookOf(h.para);
  modifyStyle(id, { ...s, run: look.run, para: look.para });
  return true;
}

/** A new style (from the dialog, or the selection's look) added to the sheet and applied to the selection. */
export function addStyle(s: DocStyle, apply = true) {
  const sheet = sheetNow();
  const style: DocStyle = { ...s, edited: true };
  commitSheet([...sheet, style], t("docstyle.hist.new", { name: labelOf(style) }));
  if (apply) applyStyleNow(style.id);
}

/** 선택 영역으로 새 스타일: a style from the look of the paragraph under the caret. */
export function styleFromSelection(name: string): DocStyle | null {
  const h = hereNow();
  if (!h) return null;
  return styleFromParagraph(sheetNow(), h.para, name);
}

/** Show or hide a style in the ribbon's gallery (Word: 스타일 갤러리에서 제거). */
export function setQuick(id: string, quick: boolean) {
  const sheet = sheetNow();
  const out = sheet.map((s) => (s.id === id ? { ...s, quick, edited: true as const } : s));
  S().commit(t("docstyle.hist.gallery"), (d) => {
    d.pages = withSheet(d.pages as Page[], out) as typeof d.pages;
  });
}

/** Delete a style made here (its paragraphs go back to the style it was based on). */
export function deleteStyle(id: string): boolean {
  const sheet = sheetNow();
  const s = findStyle(sheet, id);
  if (!s || s.id === sheet[0]?.id) return false;
  const to = s.basedOn && findStyle(sheet, s.basedOn) ? s.basedOn : sheet[0].id;
  const out = sheet.filter((x) => x.id !== id).map((x) => (x.basedOn === id ? { ...x, basedOn: to } : x.next === id ? { ...x, next: to } : x));
  const pages = S().doc.pages.map((pg) => {
    const nodes = pg.nodes.map((n) => {
      if (n.type !== "TEXT" || !n.paragraphs.some((p) => p.style === id)) return n;
      return { ...n, paragraphs: n.paragraphs.map((p) => (p.style === id ? applyStyle([p], 0, 0, sheet, to)[0] : p)) };
    });
    return nodes.every((n, i) => n === pg.nodes[i]) ? pg : { ...pg, nodes };
  });
  let next = withSheet(pages, out);
  for (const seg of segments(next)) if (isFlowSegment(next, seg)) next = reflowSegment(next, seg.start);
  S().commit(t("docstyle.hist.delete", { name: labelOf(s) }), (d) => {
    d.pages = next as typeof d.pages;
  });
  return true;
}

/** The styles the ribbon's gallery shows: the quick ones, the default first. */
export function galleryStyles(sheet: DocStyle[]): DocStyle[] {
  return sheet.filter((s, i) => s.type === "para" && (i === 0 || s.quick));
}

/** How many paragraphs of the document are in style `id` (스타일 창: 모든 n개 인스턴스 선택). */
export function styleUses(id: string): number {
  const sheet = sheetNow();
  let n = 0;
  for (const pg of S().doc.pages) for (const node of pg.nodes) if (node.type === "TEXT") for (const p of node.paragraphs) if (!p.flowCont && styleIdOf(p, sheet) === id) n++;
  return n;
}
