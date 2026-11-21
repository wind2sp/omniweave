// Slide commands (docs/design/SLIDE_MODE.md): new slide from a layout, change / reset layout, hide, sections, notes,
// and starting the show from the first or the current slide. Each document change is one store.commit (undoable).

import { getBlob } from "../core/assets";
import { currentPage, findPage, useStore } from "../core/store";
import { applyLayoutInPlace, builtinLayout, isBuiltinLayout, layoutOfPage, SLIDE_LAYOUTS, slideFromLayout, swapDeckLayout, type SlideLayoutDef } from "../core/slides";
import { copyNode, uid, type AssetRef, type OmwDocument, type Page } from "../core/types";
import { pptxLayoutSlides } from "../io/formats/pptx";
import { t } from "../i18n";
import { fitCurrent } from "./actions";
import { startSlideshow } from "./shell/TopBar";
import { create } from "zustand";

const S = () => useStore.getState();

/** Slide view state: the sorter (격자) instead of the canvas, the notes pane, the slides picked in the list. */
/** Extra pages picked in the page list with Ctrl / Shift+click (the current page is always included). */
export const usePagePick = create<{ ids: string[]; anchor: string | null }>(() => ({ ids: [], anchor: null }));
/** Pages picked in the list, in document order; empty = just the current page. */
export const pickedPages = () => usePagePick.getState().ids;

export const useSlideUI = create<{ sorter: boolean; notes: boolean; notesH: number; folded: string[]; renaming: string | null }>(() => ({ sorter: false, notes: true, notesH: 96, folded: [], renaming: null }));

/** One choice of the layout gallery. */
export interface LayoutChoice {
  /** built-in layout id or the deck's slideLayout part */
  id: string;
  name: string;
  layout: SlideLayoutDef;
  /** the deck's layout read as a slide (decorations + empty placeholders) and the pictures it uses */
  page?: Page;
  assets?: Record<string, AssetRef>;
}

const deckCache = new Map<string, LayoutChoice[]>();

/** The original PPTX a slide came from (kept for the source-preserving save), or null. */
function deckBytes(page: Page | undefined): { hash: string; bytes: Uint8Array } | null {
  const h = page?.source?.format === "pptx" ? page.source.office?.hash : undefined;
  const b = h ? getBlob(h) : undefined;
  return h && b ? { hash: h, bytes: b } : null;
}

/** The layouts a new slide can take: the deck's own (a PPTX), else Omniweave's built-in set. */
export function layoutChoices(doc: OmwDocument, page: Page | undefined): LayoutChoice[] {
  const W = page?.width ?? 1280, H = page?.height ?? 720;
  const src = deckBytes(page) ?? deckBytes(doc.pages.find((p) => deckBytes(p)));
  if (src) {
    let got = deckCache.get(src.hash);
    if (!got) {
      try {
        const r = pptxLayoutSlides(src.bytes);
        // pictures the document already holds (the same deck read before) are named by its own asset ids: the gallery
        // thumbnails draw them and a new slide adds no second copy
        const byHash = new Map(Object.values(doc.assets).map((a) => [a.hash, a.id]));
        const map = new Map(Object.values(r.assets).flatMap((a) => (byHash.has(a.hash) ? [[a.id, byHash.get(a.hash)!] as const] : [])));
        const own = (p: Page): Page => (map.size ? JSON.parse(JSON.stringify(p, (k, x) => ((k === "assetId" || k === "posterAssetId") && typeof x === "string" ? map.get(x) ?? x : x))) : p);
        const assets = Object.fromEntries(Object.entries(r.assets).filter(([k]) => !map.has(k)));
        got = r.layouts.map((l) => {
          const page = own(l.page);
          return { id: l.part, name: l.name || l.part.split("/").pop()!, layout: layoutOfPage(page), page, assets };
        });
      } catch {
        got = [];
      }
      deckCache.set(src.hash, got);
    }
    if (got.length) return got;
  }
  return SLIDE_LAYOUTS.map((id) => ({ id, name: t(`slide.layout.${id}`), layout: builtinLayout(id, W, H) }));
}

/** The layout a slide usually takes next: after a title slide the title-and-content one, else the same as this slide. */
export function defaultChoice(choices: LayoutChoice[], page: Page | undefined): LayoutChoice | undefined {
  const cur = choices.find((c) => c.id === page?.layout);
  const isTitle = (c: LayoutChoice) => c.layout.slots.some((s) => s.type === "ctrTitle");
  const content = choices.find((c) => !isTitle(c) && c.layout.slots.some((s) => s.type === "title") && c.layout.slots.some((s) => s.type === "body"));
  if (!cur || isTitle(cur)) return content ?? choices[0];
  return cur;
}

/** A new slide made from `choice`, after the current slide (or at `at`). Returns its id. */
export function newSlide(choice?: LayoutChoice, at?: number): string | null {
  const s = S();
  const cur = currentPage();
  const like = cur?.kind === "SLIDE" ? cur : s.doc.pages.find((p) => p.kind === "SLIDE");
  const W = like?.width ?? 1280, H = like?.height ?? 720;
  const c = choice ?? defaultChoice(layoutChoices(s.doc, like), like);
  if (!c) return null;
  const n = s.doc.pages.filter((p) => p.kind === "SLIDE").length + 1;
  const name = t("doc.pageName.SLIDE", { n });
  let page: Page;
  if (c.page) {
    // the deck's layout: its decorations and placeholders as read, with new ids (pictures join the document)
    page = { ...c.page, id: uid("pg"), name, nodes: c.page.nodes.map((x) => copyNode(x, uid())), animations: [], layout: c.id };
    delete page.source;
  } else page = slideFromLayout(c.layout, W, H, name, like?.masterId ?? null);
  if (like && !c.page) page.background = like.background;
  const idx = at ?? (cur ? s.doc.pages.findIndex((p) => p.id === cur.id) + 1 : s.doc.pages.length);
  s.commit(t("slide.hist.new"), (d) => {
    if (c.assets) for (const [k, a] of Object.entries(c.assets)) if (!d.assets[k]) d.assets[k] = a;
    d.pages.splice(Math.max(0, Math.min(d.pages.length, idx)), 0, page as never);
  });
  S().set({ pageId: page.id, selection: [], editingTextId: null });
  setTimeout(fitCurrent);
  return page.id;
}

/** The slides a slide command acts on: those picked in the list, else the current one. */
export function targetSlides(picked: readonly string[] = []): string[] {
  const s = S();
  const ids = picked.length ? picked : [s.pageId];
  return s.doc.pages.filter((p) => ids.includes(p.id) && p.kind === "SLIDE").map((p) => p.id);
}

/** Change the layout of slides (their placeholders move into the new one's, with their text). */
export function changeLayout(choice: LayoutChoice, ids = targetSlides()) {
  if (!ids.length) return;
  const s = S();
  const choices = choice.page ? layoutChoices(s.doc, findPage(s.doc, ids[0])) : [];
  const assets = { ...(choice.assets ?? {}), ...s.doc.assets };
  s.commit(t("slide.hist.layout", { name: choice.name }), (d) => {
    // the deck's own layout: its decorations and background come with it (the old layout's leave), pictures join the document
    if (choice.assets) for (const [k, a] of Object.entries(choice.assets)) if (!d.assets[k]) d.assets[k] = a;
    for (const p of d.pages) {
      if (!ids.includes(p.id)) continue;
      if (choice.page) swapDeckLayout(p as Page, choices.find((c) => c.id === p.layout)?.page, choice.page, choice.layout, assets);
      else applyLayoutInPlace(p as Page, isBuiltinLayout(choice.id) ? builtinLayout(choice.id, p.width, p.height) : choice.layout);
    }
  });
}

/** Put the placeholders of slides back where their layout has them (reset). */
export function resetLayout(ids = targetSlides()) {
  const s = S();
  const pages = ids.map((id) => findPage(s.doc, id)).filter((p): p is Page => !!p);
  const choices = layoutChoices(s.doc, pages[0]);
  S().commit(t("slide.hist.reset"), (d) => {
    for (const p of d.pages) {
      if (!ids.includes(p.id)) continue;
      const c = choices.find((x) => x.id === p.layout);
      if (c) applyLayoutInPlace(p as Page, isBuiltinLayout(c.id) ? builtinLayout(c.id, p.width, p.height) : c.layout);
    }
  });
}

/** Hide or show slides in the show (all hidden → shown, else hidden). */
export function toggleHidden(ids = targetSlides()) {
  const s = S();
  const pages = s.doc.pages.filter((p) => ids.includes(p.id));
  if (!pages.length) return;
  const hide = !pages.every((p) => p.hidden);
  s.commit(t(hide ? "slide.hist.hide" : "slide.hist.unhide"), (d) => {
    for (const p of d.pages) if (ids.includes(p.id)) hide ? (p.hidden = true) : delete p.hidden;
  });
}

/** A section beginning at slide `id` (named `name`). */
export function addSection(id: string, name = t("slide.section.untitled")) {
  S().commit(t("slide.hist.addSection"), (d) => {
    const p = d.pages.find((x) => x.id === id);
    if (p) p.section = name;
  });
}

export function renameSection(id: string, name: string) {
  const p = findPage(S().doc, id);
  if (!p || p.section === name) return;
  S().commit(t("slide.hist.renameSection"), (d) => {
    const q = d.pages.find((x) => x.id === id);
    if (q) q.section = name;
  });
}

/** Remove the section that begins at `id` (its slides join the section before). */
export function removeSection(id: string) {
  S().commit(t("slide.hist.removeSection"), (d) => {
    const p = d.pages.find((x) => x.id === id);
    if (p) delete p.section;
  });
}

/** Speaker notes of a slide (one history step per settled edit). */
export function setNotes(id: string, text: string) {
  const p = findPage(S().doc, id);
  if (!p || (p.notes ?? "") === text) return;
  S().commit(t("slide.hist.notes"), (d) => {
    const q = d.pages.find((x) => x.id === id);
    if (!q) return;
    if (text) q.notes = text;
    else delete q.notes;
  });
}

/** Slide show from the first slide (F5) or the current one (Shift+F5). */
export function startShow(fromStart: boolean) {
  const s = S();
  if (fromStart) {
    const first = s.doc.pages.find((p) => p.kind === "SLIDE" && !p.hidden) ?? s.doc.pages[0];
    if (first) s.set({ pageId: first.id, selection: [] });
  }
  startSlideshow();
}
