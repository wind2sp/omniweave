// Layouts edited here (PowerPoint 슬라이드 마스터 보기 › 레이아웃 삽입 / 레이아웃 편집): a layout is a master page
// (doc.masters) marked LAYOUT_MARK in `layout`, drawn over its own master (its masterId) — its placeholders say where a
// new slide's go, its other shapes are drawn under every slide made from it. Slides made from it point at it (masterId
// = the layout, layout = its id), so renderMasterOf draws master + layout under them (layoutChain).

import { builtinLayout, isBuiltinLayout, layoutOfPage, makePh, type SlideLayoutDef } from "./slides";
import { newPage, uid, type OmwDocument, type Page, type SceneNode } from "./types";

export const LAYOUT_MARK = "@layout";
export const isLayoutPage = (p: Pick<Page, "kind" | "layout"> | undefined | null): boolean => !!p && p.kind === "MASTER" && p.layout === LAYOUT_MARK;

/** The layouts made / edited here, under masters (in document order). */
export const customLayouts = (doc: Pick<OmwDocument, "masters">): Page[] => doc.masters.filter(isLayoutPage);

/** A layout page from a built-in layout (its placeholders), over `masterId`; `from` names the built-in it copies. */
export function layoutPageFrom(id: string, W: number, H: number, name: string, masterId: string | null): Page {
  const def = isBuiltinLayout(id) ? builtinLayout(id, W, H) : builtinLayout("titleContent", W, H);
  const p = newPage("MASTER", W, H, name);
  p.id = uid("lay_");
  p.layout = LAYOUT_MARK;
  p.masterId = masterId;
  p.background = "rgba(0,0,0,0)";
  p.nodes = def.slots.map((s) => makePh(s, H));
  // (the built-in it was made from: 레이아웃 편집 of that built-in finds it again)
  p.source = { format: "layout", name: id };
  return p;
}

/** A layout page as the gallery and new slides see it: its placeholders. */
export const layoutDefOf = (p: Page): SlideLayoutDef => ({ ...layoutOfPage(p), id: p.id, name: p.name });

/** The decoration of a layout page (its shapes that are not placeholders). */
export const layoutDecorNodes = (p: Page): SceneNode[] => p.nodes.filter((n) => !(n.type === "TEXT" && n.ph));

/**
 * The page a slide is drawn over, with the chain under it: a layout page's master first, then the layout's own
 * decoration (its placeholders are left out: they are the slide's). `base` is the page the slide's masterId names.
 */
const chainMemo = new WeakMap<Page, { master: Page | null; out: Page }>();
export function layoutChain(doc: Pick<OmwDocument, "masters">, base: Page | null): Page | null {
  if (!base || !isLayoutPage(base)) return base;
  const master = base.masterId ? doc.masters.find((m) => m.id === base.masterId && !isLayoutPage(m)) ?? null : null;
  const hit = chainMemo.get(base);
  if (hit && hit.master === master) return hit.out;
  const out: Page = { ...base, background: master?.background ?? base.background, nodes: [...(master?.nodes ?? []), ...layoutDecorNodes(base)], groups: [...(master?.groups ?? []), ...(base.groups ?? [])] };
  chainMemo.set(base, { master, out });
  return out;
}
