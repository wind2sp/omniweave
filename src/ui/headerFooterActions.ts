// Header / footer / page number commands (머리말·꼬리말·쪽 번호) — each one undo step. The model rules live in
// core/headerFooter.ts; editing the text itself happens in place on the canvas (CanvasView + RichTextEditor).

import { HF_EDIT_EVENT, hfInfo, insertPageNumber, isLinked, parseHfId, setEvenOdd, setLinked, setTitlePage, type HFArea } from "../core/headerFooter";
import { useStore } from "../core/store";
import type { FieldKind, Page, PageNumFormat, PageNumPos } from "../core/types";
import { t } from "../i18n";
import { richApi } from "./RichTextEditor";

const S = () => useStore.getState();
const pageIndex = () => S().doc.pages.findIndex((p) => p.id === S().pageId);

/** The current page is a document page (headers and footers belong to document pages). */
export const onDocPage = () => S().doc.pages[pageIndex()]?.kind === "DOCUMENT";

/** A header / footer is being edited on the canvas. */
export const editingHF = () => !!S().editingTextId && !!parseHfId(S().editingTextId!);

/** 머리말 / 꼬리말 편집: edit the current page's header or footer in place (the canvas opens the editor). */
export function editHeaderFooter(area: HFArea) {
  if (!onDocPage()) return S().notify(t("headerfooter.toast.docOnly"));
  // leave a header being edited first (the other area opens after it closed)
  if (S().editingTextId) S().set({ editingTextId: null });
  setTimeout(() => window.dispatchEvent(new CustomEvent(HF_EDIT_EVENT, { detail: { area } })));
}

/** The area of the header / footer being edited, else the given default. */
const areaNow = (def: HFArea = "header"): HFArea => (S().editingTextId && parseHfId(S().editingTextId!)?.area) || def;

function commitPages(label: string, fn: (pages: Page[], i: number) => void) {
  const i = pageIndex();
  if (i < 0 || !onDocPage()) return;
  S().commit(label, (d) => fn(d.pages as Page[], i));
}

/** Section of the current page: different first page. */
export const titlePageOn = () => {
  const pages = S().doc.pages;
  const i = pageIndex();
  return i >= 0 && !!pages[hfInfo(pages).pages[i]?.start ?? 0]?.hf?.titlePg;
};
export function toggleTitlePage() {
  const on = !titlePageOn();
  commitPages(t("headerfooter.hist.titlePage"), (pages, i) => setTitlePage(pages, i, on));
}

/** Document: different odd and even pages. */
export const evenOddOn = () => !!S().doc.pages[0]?.hf?.evenOdd;
export function toggleEvenOdd() {
  const on = !evenOddOn();
  commitPages(t("headerfooter.hist.evenOdd"), (pages) => setEvenOdd(pages, on));
}

/** The header / footer the current page shows is linked to the section before (앞 구역과 연결). */
export const linkedNow = (area: HFArea = areaNow()) => {
  const pages = S().doc.pages;
  const i = pageIndex();
  const pi = hfInfo(pages).pages[i];
  return !!pi && isLinked(pages, i, area, pi.variant);
};
/** It can be linked at all: not in the document's first section. */
export const canLink = () => {
  const pi = hfInfo(S().doc.pages).pages[pageIndex()];
  return !!pi && pi.section > 0 && onDocPage();
};
export function toggleLinked(area: HFArea = areaNow()) {
  const linked = !linkedNow(area);
  commitPages(t(linked ? "headerfooter.hist.link" : "headerfooter.hist.unlink"), (pages, i) => setLinked(pages, i, area, hfInfo(pages).pages[i].variant, linked));
}

/**
 * 쪽 번호 넣기 (the dialog's choice), one undo step: position (null = none), format, start number (null = continue),
 * and — when given — the section's different first page and the document's different odd / even pages.
 */
export function applyPageNumber(pos: PageNumPos | null, fmt: PageNumFormat, start: number | null, opts: { side?: string; titlePg?: boolean; evenOdd?: boolean } = {}) {
  commitPages(t(pos ? "headerfooter.hist.pageNumber" : "headerfooter.hist.noPageNumber"), (pages, i) => {
    insertPageNumber(pages, i, { pos, fmt, start, side: opts.side });
    if (opts.titlePg !== undefined && opts.titlePg !== !!pages[hfInfo(pages).pages[i].start].hf?.titlePg) setTitlePage(pages, i, opts.titlePg);
    if (opts.evenOdd !== undefined && opts.evenOdd !== !!pages[0].hf?.evenOdd) setEvenOdd(pages, opts.evenOdd);
  });
  S().notify(t(pos ? "headerfooter.toast.pageNumber" : "headerfooter.toast.noPageNumber"));
}

/** The current section's page number settings (for the dialog). */
export function pageNumberNow(): { pos: PageNumPos | null; fmt: PageNumFormat; start: number | null; side: string } {
  const pages = S().doc.pages;
  const i = pageIndex();
  const info = hfInfo(pages);
  const pi = info.pages[i];
  const hf = pi ? pages[pi.start].hf : undefined;
  let pn: { pos: PageNumPos; side?: string } | null = null;
  if (pi)
    for (let k = pi.section; k >= 0; k--) {
      const v = pages[info.runs[k].start].hf?.pageNum;
      if (v !== undefined) {
        pn = v;
        break;
      }
    }
  return { pos: pn?.pos ?? null, fmt: hf?.pageFmt ?? "decimal", start: hf?.pageStart ?? null, side: pn?.side ?? "" };
}

/** Insert a field at the caret of the text being edited (a header / footer, or any text box). */
export function insertField(kind: FieldKind) {
  const api = richApi();
  if (!api) return S().notify(t("headerfooter.toast.fieldNeedsText"));
  api.insertField(kind);
}

/** Close the header / footer editor. */
export function closeHeaderFooter() {
  if (editingHF()) S().set({ editingTextId: null });
}
