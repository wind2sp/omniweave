// Slide commands (docs/design/SLIDE_MODE.md): new slide from a layout, change / reset layout, hide, sections, notes,
// and starting the show from the first or the current slide. Each document change is one store.commit (undoable).

import { getBlob } from "../core/assets";
import { currentPage, findPage, useStore } from "../core/store";
import { applyLayoutInPlace, builtinLayout, isBuiltinLayout, layoutOfPage, makePh, SLIDE_LAYOUTS, slideFromLayout, swapDeckLayout, type SlideLayoutDef } from "../core/slides";
import { copyNode, newPage, uid, type AssetRef, type OmwDocument, type Page } from "../core/types";
import { DEFAULT_THEME, themeBg, themeDecor, themeNewSlide } from "../core/slideTheme";
import { customLayouts, isLayoutPage, layoutDefOf, layoutPageFrom } from "../core/slideLayouts";
import { pptxLayoutSlides } from "../io/formats/pptx";
import { t } from "../i18n";
import { fitCurrent } from "./actions";
import { hintEditMode } from "./editModes";
import { startSlideshow } from "./shell/TopBar";
import { useRibbonTab } from "./ribbonTabs";
import { create } from "zustand";

const S = () => useStore.getState();

/** Slide view state: the sorter (격자) instead of the canvas, the notes pane, the slides picked in the list. */
/** Extra pages picked in the page list with Ctrl / Shift+click (the current page is always included). */
export const usePagePick = create<{ ids: string[]; anchor: string | null }>(() => ({ ids: [], anchor: null }));
/** Pages picked in the list, in document order; empty = just the current page. */
export const pickedPages = () => usePagePick.getState().ids;

/** The show's own choices: the presenter view (Alt+F5) instead of the slide alone. */
export const useShowUI = create<{ presenterView: boolean }>(() => ({ presenterView: false }));

export const useSlideUI = create<{ sorter: boolean; notes: boolean; notesH: number; folded: string[]; renaming: string | null }>(() => ({ sorter: false, notes: true, notesH: 96, folded: [], renaming: null }));

/** One choice of the layout gallery. */
export interface LayoutChoice {
  /** built-in layout id or the deck's slideLayout part */
  id: string;
  name: string;
  layout: SlideLayoutDef;
  /** the deck's layout read as a slide (decorations + empty placeholders) and the pictures it uses */
  page?: Page;
  /** a layout made / edited here (core/slideLayouts.ts): slides made from it are drawn over it */
  custom?: Page;
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
  // the built-in layouts — a built-in edited here (레이아웃 편집) by its edited copy — then the ones made here
  const custom = customLayouts(doc);
  const editedOf = (id: string) => custom.find((l) => l.source?.name === id);
  return [
    ...SLIDE_LAYOUTS.map((id) => {
      const e = editedOf(id);
      return e ? { id: e.id, name: e.name, layout: layoutDefOf(e), custom: e } : { id, name: t(`slide.layout.${id}`), layout: builtinLayout(id, W, H) };
    }),
    ...custom.filter((l) => !SLIDE_LAYOUTS.includes(l.source?.name as never)).map((l) => ({ id: l.id, name: l.name, layout: layoutDefOf(l), custom: l })),
  ];
}

/** The layout a slide usually takes next: after a title slide the title-and-content one, else the same as this slide. */
export function defaultChoice(choices: LayoutChoice[], page: Page | undefined): LayoutChoice | undefined {
  const cur = choices.find((c) => c.id === page?.layout);
  const isTitle = (c: LayoutChoice) => c.layout.slots.some((s) => s.type === "ctrTitle");
  // PowerPoint's "Title and Content": one title over one body. The first layout with a title and a body was taken
  // before, which in a deck listing its layouts out of order was "Content with Caption" (a small title, a caption under
  // it and the content beside them: 실사용 점검 2026-11-23 #57 — it looked like overlapping placeholders)
  const score = (c: LayoutChoice) => {
    const titles = c.layout.slots.filter((s) => s.type === "title"), bodies = c.layout.slots.filter((s) => s.type === "body");
    const tb = titles[0]?.box, bb = bodies[0]?.box;
    const over = tb && bb && tb[1] + tb[3] * 0.9 <= bb[1] && bb[2] >= tb[2] * 0.8;
    return (titles.length === 1 && bodies.length === 1 ? 2 : 0) + (over ? 1 : 0);
  };
  const partNo = (c: LayoutChoice) => Number(/(\d+)\.xml$/.exec(c.id)?.[1] ?? 1e9);
  const content = choices
    .filter((c) => !isTitle(c) && c.layout.slots.some((s) => s.type === "title") && c.layout.slots.some((s) => s.type === "body"))
    .sort((a, b) => score(b) - score(a) || partNo(a) - partNo(b))[0];
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
  } else page = slideFromLayout(c.layout, W, H, name, c.custom ? c.custom.id : masterUnder(s.doc, like?.masterId ?? null));
  if (like && !c.page) {
    page.background = like.background;
    if (like.bgGrad) page.bgGrad = JSON.parse(JSON.stringify(like.bgGrad));
  }
  // a themed deck: the new slide in the theme's look
  if (s.doc.theme && !c.page) themeNewSlide(page, s.doc.theme);
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
      else {
        applyLayoutInPlace(p as Page, isBuiltinLayout(choice.id) ? builtinLayout(choice.id, p.width, p.height) : choice.layout);
        // drawn over the layout made here, or (a built-in) over the master that layout was under
        p.masterId = choice.custom ? choice.custom.id : masterUnder(d as OmwDocument, p.masterId);
      }
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

/** The slide the master view was opened from (보기 › 슬라이드 마스터, closed back to it). */
let masterReturn: string | null = null;

/**
 * 보기 › 슬라이드 마스터: edit the master the current slide is drawn with (its shapes appear under every slide that
 * uses it). A deck without one gets one first — the theme's, used by every slide — as PowerPoint always has a master.
 */
export function enterMasterView() {
  const s = S();
  const cur = currentPage();
  const slide = cur?.kind === "SLIDE" ? cur : s.doc.pages.find((p) => p.kind === "SLIDE");
  if (!slide) return;
  masterReturn = slide.id;
  layoutsAtOpen = layoutsKey();
  let mid = masterUnder(s.doc, slide.masterId && s.doc.masters.some((m) => m.id === slide.masterId) ? slide.masterId : null);
  if (!mid) {
    const th = s.doc.theme ?? DEFAULT_THEME;
    const m = newPage("MASTER", slide.width, slide.height, th.name);
    m.id = uid("mtheme_");
    m.background = themeBg(th);
    m.nodes = themeDecor(th, slide.width, slide.height);
    mid = m.id;
    s.commit(t("slideppt.hist.master"), (d) => {
      d.masters.push(m as never);
      for (const p of d.pages) if (p.kind === "SLIDE" && !p.masterId) p.masterId = m.id;
      // layouts made here without a master go under it too
      for (const l of d.masters) if (isLayoutPage(l as Page) && !l.masterId) l.masterId = m.id;
    });
  }
  // the master is edited in the slide mode (PowerPoint's 슬라이드 마스터 tab), not as a design page
  hintEditMode(mid, "SLIDE");
  S().set({ pageId: mid, selection: [], editingTextId: null });
  useSlideUI.setState({ sorter: false });
  // PowerPoint opens its 슬라이드 마스터 tab (with 마스터 보기 닫기) in place of 홈: the ribbon goes there
  useRibbonTab.getState().set("slide", "home");
  setTimeout(fitCurrent, 30);
}

/** The master a page over `id` is drawn with, not a layout: a layout's own master (or `id` itself). */
function masterUnder(doc: Pick<OmwDocument, "masters">, id: string | null): string | null {
  const m = id ? doc.masters.find((x) => x.id === id) : undefined;
  return m && isLayoutPage(m) ? m.masterId : id;
}

/** The layouts as they were when the master view opened (to put the slides' placeholders where an edited one has them). */
let layoutsAtOpen = "";
const layoutsKey = () => JSON.stringify(customLayouts(S().doc).map((l) => [l.id, l.nodes.filter((n) => n.type === "TEXT" && n.ph).map((n) => [n.transform, n.type === "TEXT" ? [n.width, n.ph] : 0])]));

/** 레이아웃 삽입: a new layout (title and content placeholders) under the master being edited; it is opened. */
export function insertLayout() {
  const s = S();
  const cur = currentPage();
  const master = cur && isLayoutPage(cur) ? cur.masterId : cur?.kind === "MASTER" ? cur.id : null;
  const n = customLayouts(s.doc).length + 1;
  const lp = layoutPageFrom("titleContent", cur?.width ?? 1280, cur?.height ?? 720, t("slideppt.master.newLayoutName", { n }), master);
  lp.source = { format: "layout", name: lp.id };
  s.commit(t("slideppt.hist.layout"), (d) => void d.masters.push(lp as never));
  hintEditMode(lp.id, "SLIDE");
  S().set({ pageId: lp.id, selection: [] });
  setTimeout(fitCurrent, 30);
}

/**
 * 레이아웃 편집: the layout of the slide the master view was opened from, as a layout page to edit (a built-in one is
 * copied once; the slides using it then use the copy).
 */
export function editLayout() {
  const s = S();
  const slide = (masterReturn && s.doc.pages.find((p) => p.id === masterReturn)) || s.doc.pages.find((p) => p.kind === "SLIDE");
  if (!slide) return;
  const id = slide.layout ?? "blank";
  let lp = customLayouts(s.doc).find((l) => l.id === id || l.source?.name === id);
  if (!lp) {
    if (!isBuiltinLayout(id)) return;
    const master = masterUnder(s.doc, slide.masterId);
    const made = layoutPageFrom(id, slide.width, slide.height, t(`slide.layout.${id}`), master);
    s.commit(t("slideppt.hist.layout"), (d) => {
      d.masters.push(made as never);
      for (const p of d.pages) if (p.kind === "SLIDE" && p.layout === id) {
        p.layout = made.id;
        p.masterId = made.id;
      }
    });
    lp = made;
  }
  hintEditMode(lp.id, "SLIDE");
  S().set({ pageId: lp.id, selection: [] });
  setTimeout(fitCurrent, 30);
}

/** 개체 틀 삽입 on a layout being edited: one more content placeholder in its middle. */
export function insertPlaceholder() {
  const s = S();
  const lp = currentPage();
  if (!lp || !isLayoutPage(lp)) return;
  const idx = String(Math.max(1, ...lp.nodes.map((n) => (n.type === "TEXT" && n.ph?.idx ? Number(n.ph.idx) || 0 : 0))) + 1);
  const W = lp.width, H = lp.height;
  const node = makePh({ type: "body", idx, box: [W * 0.3, H * 0.35, W * 0.4, H * 0.3], pt: 24, bullets: true }, H);
  s.commit(t("slideppt.hist.layout"), (d) => void d.masters.find((m) => m.id === lp.id)?.nodes.push(node as never));
  S().set({ selection: [node.id] });
}

/** 레이아웃 삭제: the layout being edited goes; its slides go back to the built-in it came from (or 제목 및 내용). */
export function deleteLayout() {
  const s = S();
  const lp = currentPage();
  if (!lp || !isLayoutPage(lp)) return;
  const back = isBuiltinLayout(lp.source?.name) ? lp.source!.name! : "titleContent";
  s.commit(t("slideppt.hist.layout"), (d) => {
    d.masters = d.masters.filter((m) => m.id !== lp.id);
    for (const p of d.pages)
      if (p.masterId === lp.id) {
        p.masterId = lp.masterId;
        applyLayoutInPlace(p as Page, builtinLayout(back as never, p.width, p.height));
      }
  });
  closeMasterView();
}

/** 마스터 보기 닫기: back to the slide it was opened from. */
export function closeMasterView() {
  const s = S();
  // a layout edited in the view: the slides made from it take its placeholders' new places (their text kept)
  if (layoutsKey() !== layoutsAtOpen) {
    const lays = customLayouts(s.doc);
    s.commit(t("slideppt.hist.layout"), (d) => {
      for (const p of d.pages) {
        const lp = p.kind === "SLIDE" ? lays.find((l) => l.id === p.masterId) : undefined;
        if (lp) applyLayoutInPlace(p as Page, layoutDefOf(lp));
      }
    });
  }
  const back = (masterReturn && s.doc.pages.find((p) => p.id === masterReturn)) || s.doc.pages.find((p) => p.kind === "SLIDE");
  masterReturn = null;
  if (back) S().set({ pageId: back.id, selection: [], editingTextId: null });
  setTimeout(fitCurrent, 30);
}

/** Slide show from the first slide (F5) or the current one (Shift+F5); `presenter`: in the presenter view (Alt+F5). */
export function startShow(fromStart: boolean, presenter = false) {
  const s = S();
  useShowUI.setState({ presenterView: presenter });
  if (fromStart) {
    const first = s.doc.pages.find((p) => p.kind === "SLIDE" && !p.hidden) ?? s.doc.pages[0];
    if (first) s.set({ pageId: first.id, selection: [] });
  }
  startSlideshow();
}
