// Which tabs the tab row shows (docs/design/UI_TOP_REDESIGN.md §3): the FILE FORMAT of the current page picks the tab
// set first, the work mode only after that — so a PDF never gets the word processor's tabs and a drawing (DXF / DWG) its
// CAD tab, whatever the work mode was on the page before.
//
//   surface   first tab        tab row (after 파일)                                        body
//   doc       홈               홈 · 삽입 · 레이아웃 · 참조 · 검토 · 보기 · 그리기 (+ 맥락 탭) ribbon
//   sheet     홈               홈                                                        ribbon
//   pdf       PDF              PDF · 주석 · 쪽 · 보호 · 보기 (+ 맥락 탭)                     ribbon
//   cad       CAD              CAD · 보기 · 출력                                           ribbon (+ command line below)
//   slide     홈               홈 · 삽입 · 디자인 · 전환 · 애니메이션 · 슬라이드 쇼 · 보기 (+ 맥락) ribbon
//   image     (menus)          편집▾ · 이미지▾ · 레이어▾ · 선택▾ · 필터▾ · 보기▾               options bar + left toolbox
//   design    (menus)          편집▾ · 개체▾ · 문자▾ · 선택▾ · 효과▾ · 보기▾                   options bar + left toolbox

import { create } from "zustand";
import type { Mode } from "../core/store";
import { findPage, useStore } from "../core/store";
import type { Page } from "../core/types";
import { editModeOf, isPdfFormatPage, useCadScreen } from "./editModes";

export type Surface = "doc" | "sheet" | "pdf" | "cad" | "slide" | "image" | "design";

/** Surfaces whose tab names open drop-down menus over a one-line options bar (Photoshop / Illustrator). */
export const MENU_SURFACES: Surface[] = ["image", "design"];
export const isMenuSurface = (s: Surface) => MENU_SURFACES.includes(s);

/** Tab ids of each surface, in order; the first is the format's own tab. Labels: `topui.tab.<surface>.<id>`. */
export const RIBBON_TABS: Record<Surface, string[]> = {
  doc: ["home", "insert", "layout", "references", "review", "view", "draw"],
  sheet: ["home"],
  pdf: ["pdf", "comment", "pages", "protect", "view"],
  cad: ["cad", "view", "output"],
  slide: ["home", "insert", "design", "transitions", "animations", "show", "view"],
  image: ["edit", "image", "layer", "select", "filter", "view"],
  design: ["edit", "object", "type", "select", "effect", "view"],
};

/** Office-style key tips (Alt, then the letter): 파일 is F everywhere. */
export const KEY_TIPS: Record<string, string> = {
  file: "F",
  home: "H",
  insert: "N",
  layout: "P",
  references: "S",
  review: "R",
  view: "W",
  draw: "D",
  pdf: "A",
  comment: "C",
  pages: "G",
  protect: "T",
  cad: "A",
  output: "O",
  design: "G",
  transitions: "K",
  animations: "M",
  show: "Y",
  edit: "E",
  image: "I",
  layer: "L",
  select: "S",
  filter: "T",
  object: "O",
  type: "Y",
  effect: "C",
  ctx: "J",
};

/** Is `page` a drawing shown on the drawing screen (DXF / DWG with the CAD screen on)? */
export const isDrawingPage = (page: Pick<Page, "source"> | undefined, cadOn = useCadScreen.getState().on) => !!(cadOn && page?.source?.cad);

/** Is `page` a PDF page (opened from a PDF: its own tabs, a fixed work mode)? An .ai / .eps page is a design. */
export const isPdfPage = (page: Pick<Page, "kind" | "source"> | undefined) => isPdfFormatPage(page);

/** The tab set a page gets under the work mode `mode` (pure: tests and the hook below). */
export function surfaceOf(page: Page | undefined, mode: Mode, cadOn = useCadScreen.getState().on): Surface {
  if (!page) return mode === "DOCUMENT" ? "doc" : mode === "SLIDE" ? "slide" : mode === "IMAGE" ? "image" : "design";
  if (isPdfPage(page)) return "pdf";
  if (isDrawingPage(page, cadOn)) return "cad";
  const m = editModeOf(mode, page);
  if (m === "DOCUMENT") return page.sheet ? "sheet" : "doc";
  if (m === "SLIDE") return "slide";
  if (m === "IMAGE") return "image";
  return "design";
}

/** The current page's tab set, re-rendering when it changes. */
export function useSurface(): Surface {
  const cadOn = useCadScreen((s) => s.on);
  return useStore((s) => surfaceOf(findPage(s.doc, s.pageId), s.mode, cadOn));
}

/** The chosen tab of each surface ("ctx" = the contextual tab), kept while the viewer moves between formats. */
export const useRibbonTab = create<{ tab: Partial<Record<Surface, string>>; set: (surface: Surface, tab: string) => void }>((set) => ({
  tab: {},
  set: (surface, tab) => set((s) => ({ tab: { ...s.tab, [surface]: tab } })),
}));

/** The tab shown on `surface` now: the chosen one when it is still offered, else the format's first tab. */
export function activeTab(surface: Surface, chosen: string | undefined, ctx: string | null): string {
  if (chosen === "ctx") return ctx ? "ctx" : RIBBON_TABS[surface][0];
  return chosen && RIBBON_TABS[surface].includes(chosen) ? chosen : RIBBON_TABS[surface][0];
}
