// Slide structure (docs/design/SLIDE_MODE.md): layouts and their placeholders, the empty placeholder's prompt,
// autofit and the vertical anchor of placeholder text.
//
// A placeholder is a text node with `ph` (core/types.ts Placeholder): its box is the node's width × ph.h, the text
// sits ph.dy below the box top (the anchor). An empty placeholder draws nothing anywhere — the canvas shows its prompt
// over it (ui/CanvasView) — and is saved as an empty p:ph, which PowerPoint shows with its own prompt.

import { produce } from "immer";
import { DEFAULT_RUN, copyNode, newPage, newParagraph, newText, uid, type AssetRef, type OmwDocument, type Page, type Placeholder, type SceneNode, type TextNode, type TextParagraph } from "./types";
import { layoutText } from "./text";
import { t as tr } from "../i18n";
import { applyList, markerLength, paraText } from "./richtext";

/** Built-in layouts (the order of the gallery). */
export const SLIDE_LAYOUTS = ["title", "titleContent", "section", "twoContent", "comparison", "titleOnly", "blank"] as const;
export type SlideLayoutId = (typeof SLIDE_LAYOUTS)[number];

/** One placeholder of a layout: role, box in page px, anchor and the text it starts with. */
export interface PhSlot {
  type: Placeholder["type"];
  idx?: string;
  box: [number, number, number, number];
  anchor?: Placeholder["anchor"];
  /** first-level size, pt (at a 720 px tall slide) */
  pt: number;
  bullets?: boolean;
  align?: TextParagraph["align"];
  bold?: boolean;
  color?: string;
  /** the empty placeholder as the deck's own layout gives it (fonts, sizes, anchor read from PPTX); copied as is */
  node?: TextNode;
}

/** A layout the gallery offers: built-in, or a slideLayout of the deck's own file. */
export interface SlideLayoutDef {
  /** built-in id or the PPTX part path */
  id: string;
  /** name from the file (PPTX cSld name); built-in layouts are named by i18n `slide.layout.<id>` */
  name?: string;
  slots: PhSlot[];
}

const TITLE_BOX: [number, number, number, number] = [0.0688, 0.0532, 0.8625, 0.1932];
const BODY_BOX: [number, number, number, number] = [0.0688, 0.2661, 0.8625, 0.6342];
const GREY = "#5b6170";

/** Slots of a built-in layout as fractions of the slide (x, y, w, h). */
const BUILTIN: Record<SlideLayoutId, (Omit<PhSlot, "box"> & { f: [number, number, number, number] })[]> = {
  title: [
    { type: "ctrTitle", f: [0.125, 0.1636, 0.75, 0.348], anchor: "b", pt: 54, align: "CENTER" },
    { type: "subTitle", idx: "1", f: [0.125, 0.525, 0.75, 0.2415], pt: 24, align: "CENTER", color: GREY },
  ],
  titleContent: [
    { type: "title", f: TITLE_BOX, anchor: "ctr", pt: 40 },
    { type: "body", idx: "1", f: BODY_BOX, pt: 26, bullets: true },
  ],
  section: [
    { type: "title", f: [0.0688, 0.2494, 0.8625, 0.4161], anchor: "b", pt: 54 },
    { type: "body", idx: "1", f: [0.0688, 0.6694, 0.8625, 0.2188], pt: 24, color: GREY },
  ],
  twoContent: [
    { type: "title", f: TITLE_BOX, anchor: "ctr", pt: 40 },
    { type: "body", idx: "1", f: [0.0688, 0.2661, 0.425, 0.6342], pt: 26, bullets: true },
    { type: "body", idx: "2", f: [0.5063, 0.2661, 0.425, 0.6342], pt: 26, bullets: true },
  ],
  comparison: [
    { type: "title", f: TITLE_BOX, anchor: "ctr", pt: 40 },
    { type: "body", idx: "1", f: [0.0688, 0.245, 0.4227, 0.1203], anchor: "b", pt: 24, bold: true },
    { type: "body", idx: "2", f: [0.0688, 0.3653, 0.4227, 0.538], pt: 24, bullets: true },
    { type: "body", idx: "3", f: [0.5058, 0.245, 0.4255, 0.1203], anchor: "b", pt: 24, bold: true },
    { type: "body", idx: "4", f: [0.5058, 0.3653, 0.4255, 0.538], pt: 24, bullets: true },
  ],
  titleOnly: [{ type: "title", f: TITLE_BOX, anchor: "ctr", pt: 40 }],
  blank: [],
};

export const isBuiltinLayout = (id: string | undefined): id is SlideLayoutId => !!id && (SLIDE_LAYOUTS as readonly string[]).includes(id);

/** A built-in layout for a slide of W × H px. */
export function builtinLayout(id: SlideLayoutId, W: number, H: number): SlideLayoutDef {
  return {
    id,
    slots: BUILTIN[id].map(({ f, ...s }) => ({ ...s, box: [f[0] * W, f[1] * H, f[2] * W, f[3] * H] })),
  };
}

export const builtinLayouts = (W: number, H: number) => SLIDE_LAYOUTS.map((id) => builtinLayout(id, W, H));

/** px of `pt` on a slide `H` px tall (PowerPoint's 7.5 in slide is 720 px at 96 dpi). */
const ptPx = (pt: number, H: number) => ((pt * 96) / 72) * (H / 720);

/** Text of a paragraph after its list marker. */
const bodyText = (p: TextParagraph) => paraText(p).slice(markerLength(p));

/** A placeholder with no text typed in (list markers do not count). */
export function isEmptyPh(n: SceneNode): n is TextNode & { ph: Placeholder } {
  return n.type === "TEXT" && !!n.ph && n.paragraphs.every((p) => !bodyText(p).trim());
}

/** i18n key of an empty placeholder's prompt. */
export function promptKey(ph: Placeholder): string {
  return ph.type === "title" || ph.type === "ctrTitle" ? "slide.ph.title" : ph.type === "subTitle" ? "slide.ph.subtitle" : "slide.ph.text";
}

/** The paragraphs an empty placeholder starts with (a bulleted one for content). */
export function emptyParas(slot: PhSlot, H: number): TextParagraph[] {
  const p = newParagraph("", { fontFamily: DEFAULT_RUN.fontFamily, fontSize: ptPx(slot.pt, H), bold: !!slot.bold, color: slot.color ?? DEFAULT_RUN.color }, slot.align ?? "LEFT");
  // PowerPoint's 90 % line spacing (its 100 % is 1.2 × the size), no space after; content paragraphs 10 pt before
  p.lineSpacing = 0.9 * 1.2;
  p.spaceAfter = 0;
  if (slot.bullets) p.spaceBefore = ptPx(10, H);
  return slot.bullets ? applyList([p], 0, 0, "bullet").paras : [p];
}

/** An empty placeholder for a layout slot. */
export function makePh(slot: PhSlot, H: number): TextNode {
  if (slot.node) return copyNode(slot.node, uid());
  const [x, y, w, h] = slot.box;
  const t = newText("", w);
  t.name = tr(slot.type === "title" || slot.type === "ctrTitle" ? "slide.name.title" : slot.type === "subTitle" ? "slide.name.subtitle" : "slide.name.content", { n: slot.idx ?? "1" });
  t.paragraphs = emptyParas(slot, H);
  t.wordBreak = "normal";
  t.ph = { type: slot.type, ...(slot.idx ? { idx: slot.idx } : {}), h, ...(slot.anchor ? { anchor: slot.anchor } : {}) };
  t.transform = { x, y, rotation: 0, scale: 1 };
  return anchored(t);
}

/** A new slide from a layout, W × H px. */
export function slideFromLayout(layout: SlideLayoutDef, W: number, H: number, name: string, masterId: string | null = null): Page {
  const p = newPage("SLIDE", W, H, name);
  p.masterId = masterId;
  p.layout = layout.id;
  p.nodes = layout.slots.map((s) => makePh(s, H));
  return p;
}

/** The layout a slide of the deck's own file gives (its placeholders as read, core/types Placeholder). */
export function layoutOfPage(page: Page): SlideLayoutDef {
  const slots: PhSlot[] = [];
  for (const n of page.nodes) {
    const b = phBox(n);
    if (!b || n.type !== "TEXT" || !n.ph) continue;
    const pt = ((n.paragraphs[0]?.runs[0]?.fontSize ?? 24) * 72) / 96;
    slots.push({ type: n.ph.type, ...(n.ph.idx ? { idx: n.ph.idx } : {}), box: [b.x, b.y, b.w, b.h], ...(n.ph.anchor ? { anchor: n.ph.anchor } : {}), pt, node: n });
  }
  return { id: page.layout ?? "", name: page.name, slots };
}

/** Placeholder box of `n` in page px (x, y, w, h); null for a node that is not a placeholder. */
export function phBox(n: SceneNode): { x: number; y: number; w: number; h: number } | null {
  if (n.type !== "TEXT" || !n.ph) return null;
  const k = n.transform.scale, ky = n.transform.scaleY ?? k;
  return { x: n.transform.x, y: n.transform.y - (n.ph.dy ?? 0) * ky, w: n.width * k, h: n.ph.h * ky };
}

/** The slot of `layout` a placeholder fills: same type and idx, else same kind (title / text) in order. */
function slotFor(layout: SlideLayoutDef, ph: Placeholder, taken: Set<PhSlot>): PhSlot | undefined {
  const kind = (t: Placeholder["type"]) => (t === "title" || t === "ctrTitle" ? "title" : "text");
  const free = layout.slots.filter((s) => !taken.has(s));
  return free.find((s) => s.type === ph.type && (s.idx ?? "") === (ph.idx ?? "")) ?? free.find((s) => s.type === ph.type) ?? free.find((s) => kind(s.type) === kind(ph.type));
}

/**
 * Apply a layout to a slide (change layout, or reset with the slide's own): placeholders move into the matching slots
 * with their text, empty ones without a slot go, missing slots get empty placeholders. Text placeholders without a slot
 * and every other object stay where they are.
 */
export function applyLayoutInPlace(page: Page, layout: SlideLayoutDef): void {
  const H = page.height;
  const taken = new Set<PhSlot>();
  const out: SceneNode[] = [];
  for (const n of page.nodes) {
    if (n.type !== "TEXT" || !n.ph) {
      out.push(n);
      continue;
    }
    const s = slotFor(layout, n.ph, taken);
    if (!s) {
      if (!isEmptyPh(n)) out.push(n);
      continue;
    }
    taken.add(s);
    const [x, y, w, h] = s.box;
    const empty = isEmptyPh(n);
    const q: TextNode = {
      ...n,
      width: w,
      transform: { x, y, rotation: 0, scale: 1 },
      ph: { type: s.type, ...(s.idx ? { idx: s.idx } : {}), h, ...(s.anchor ? { anchor: s.anchor } : {}) },
      ...(empty ? { paragraphs: s.node ? copyNode(s.node, n.id).paragraphs : emptyParas(s, H) } : {}),
    };
    if (s.node) q.ph = { ...s.node.ph!, dy: undefined };
    if (q.ph && q.ph.dy === undefined) delete q.ph.dy;
    out.push(anchored(q));
  }
  for (const s of layout.slots) if (!taken.has(s)) out.push(makePh(s, H));
  page.nodes = out;
  page.layout = layout.id;
}

// ───────── a deck's own layouts (PPTX) ─────────

/**
 * A node as content only: ids and names left out, pictures by their content hash — a layout's decoration copied onto
 * a slide (new ids, assets read apart) gives the same key as the layout's own.
 */
export function contentKey(n: SceneNode, assets: Record<string, AssetRef>): string {
  return JSON.stringify(n, (k, x) => (k === "id" || k === "name" ? undefined : (k === "assetId" || k === "posterAssetId") && typeof x === "string" ? assets[x]?.hash ?? x : x));
}

/** The decorations of a deck layout read as a slide (ui/slideActions LayoutChoice.page): its nodes that are not placeholders. */
export const layoutDecor = (layoutPage: Page): SceneNode[] => layoutPage.nodes.filter((n) => !(n.type === "TEXT" && n.ph));

/** The layout's placeholder that `n` sits in as the layout places it (same type and idx, same box within 1 px), or undefined. */
export function layoutPhOf(n: SceneNode, layoutPage: Page): (TextNode & { ph: Placeholder }) | undefined {
  if (n.type !== "TEXT" || !n.ph) return undefined;
  const ph = n.ph;
  const b = phBox(n)!;
  return layoutPage.nodes.find((m): m is TextNode & { ph: Placeholder } => {
    if (m.type !== "TEXT" || !m.ph || m.ph.type !== ph.type || (m.ph.idx ?? "") !== (ph.idx ?? "")) return false;
    const c = phBox(m)!;
    return Math.abs(c.x - b.x) < 1 && Math.abs(c.y - b.y) < 1 && Math.abs(c.w - b.w) < 1 && Math.abs(c.h - b.h) < 1;
  });
}

/**
 * A slide moved from one deck layout to another (PowerPoint's change layout): the old layout's decorations leave the
 * slide's drawing and the new one's come in at the bottom, the background follows when it was the old layout's. Then
 * the placeholders move into the new layout's (applyLayoutInPlace). `assets`: the document's and the layouts' pictures.
 */
export function swapDeckLayout(page: Page, from: Page | undefined, to: Page, layout: SlideLayoutDef, assets: Record<string, AssetRef>): void {
  const old = new Set((from ? layoutDecor(from) : []).map((n) => contentKey(n, assets)));
  const kept = page.nodes.filter((n) => !old.has(contentKey(n, assets)));
  page.nodes = [...layoutDecor(to).map((n) => copyNode(n, uid())), ...kept];
  if (!from || page.background === from.background) page.background = to.background;
  applyLayoutInPlace(page, layout);
}

// ───────── autofit and anchor ─────────

/** PowerPoint-like shrink steps (normAutofit fontScale). */
const FIT_STEPS = [1, 0.9, 0.8, 0.7, 0.62, 0.55, 0.48, 0.4, 0.33, 0.25];

const scaled = (paras: TextParagraph[], k: number): TextParagraph[] =>
  k === 1 ? paras : paras.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, fontSize: r.fontSize * k })), ...(p.spaceBefore ? { spaceBefore: p.spaceBefore * k } : {}) }));

/** `n` with its text shrunk (or grown back) so it fits the placeholder box. */
export function autofit(n: TextNode): TextNode {
  if (!n.ph || n.ph.noFit) return n;
  if (isEmptyPh(n)) {
    if (!n.ph.fit) return n;
    const { fit: _f, ...ph } = n.ph;
    return { ...n, paragraphs: scaled(n.paragraphs, 1 / n.ph.fit), ph };
  }
  const cur = n.ph.fit ?? 1;
  const base = scaled(n.paragraphs, 1 / cur);
  const fits = (k: number) => layoutText({ ...n, paragraphs: k === cur ? n.paragraphs : scaled(base, k) }).height <= n.ph!.h + 0.5;
  // the size it has (PowerPoint's own fontScale from the file, too) stays while it fits and one step larger would not
  const above = FIT_STEPS.filter((k) => k > cur + 1e-6).pop();
  if (fits(cur) && (above === undefined || !fits(above))) return n;
  let fit = FIT_STEPS[FIT_STEPS.length - 1];
  for (const k of FIT_STEPS) {
    if (fits(k)) {
      fit = k;
      break;
    }
  }
  if (Math.abs(fit - cur) < 1e-6) return n;
  const ph: Placeholder = { ...n.ph, fit: fit === 1 ? undefined : fit };
  if (ph.fit === undefined) delete ph.fit;
  return { ...n, paragraphs: scaled(base, fit), ph };
}

/** `n` moved so its text sits at the placeholder's anchor (top, middle, bottom of the box). */
export function anchored(n: TextNode): TextNode {
  if (!n.ph) return n;
  const th = layoutText(n).height;
  const dy = n.ph.anchor === "ctr" ? (n.ph.h - th) / 2 : n.ph.anchor === "b" ? n.ph.h - th : 0;
  const old = n.ph.dy ?? 0;
  if (Math.abs(dy - old) < 0.01) return n;
  const ky = n.transform.scaleY ?? n.transform.scale;
  const ph: Placeholder = { ...n.ph, dy };
  if (!dy) delete ph.dy;
  return { ...n, ph, transform: { ...n.transform, y: n.transform.y + (dy - old) * ky } };
}

/**
 * After an edit: placeholders whose node changed get autofit and their anchor again. Returns `next` itself when
 * nothing moved (store.commit calls it on every edit; only changed slide pages are looked at).
 */
export function settleSlides(next: OmwDocument, prev: OmwDocument): OmwDocument {
  if (next.pages === prev.pages) return next;
  const before = new Map(prev.pages.map((p) => [p.id, p]));
  const fixes: { page: number; node: number; to: TextNode }[] = [];
  next.pages.forEach((p, pi) => {
    const old = before.get(p.id);
    // a page that was not there before (opened, inserted, pasted) stays as it came: its placeholders are as read
    if (p.kind !== "SLIDE" || !old || old === p) return;
    const oldById = new Map(old.nodes.map((n) => [n.id, n]));
    p.nodes.forEach((n, ni) => {
      if (n.type !== "TEXT" || !n.ph) return;
      // only when its text, width or box changed (a move keeps the autofit the file had)
      const o = oldById.get(n.id);
      if (o === n || (o?.type === "TEXT" && o.paragraphs === n.paragraphs && o.width === n.width && o.ph?.h === n.ph.h && o.ph?.anchor === n.ph.anchor)) return;
      const to = anchored(autofit(n));
      if (to !== n) fixes.push({ page: pi, node: ni, to });
    });
  });
  if (!fixes.length) return next;
  return produce(next, (d) => {
    for (const f of fixes) d.pages[f.page].nodes[f.node] = f.to as never;
  });
}

// ───────── slide list ─────────

/** The slides a show plays from `startId`: hidden slides are left out unless the show starts on one. */
export function showSlides(pages: readonly Page[], startId?: string): Page[] {
  const slides = pages.some((p) => p.kind === "SLIDE") ? pages.filter((p) => p.kind === "SLIDE") : [...pages];
  return slides.filter((p) => !p.hidden || p.id === startId);
}

/** Sections of the slide list: each one's name, first index and the pages in it (pages before the first section: name null). */
export function sectionsOf(pages: readonly Page[]): { name: string | null; start: number; pages: Page[] }[] {
  const out: { name: string | null; start: number; pages: Page[] }[] = [];
  pages.forEach((p, i) => {
    if (p.section !== undefined || !out.length) out.push({ name: p.section ?? null, start: i, pages: [] });
    out[out.length - 1].pages.push(p);
  });
  return out;
}
