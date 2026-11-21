// Navigation pane of the document edit mode (left dock): the headings of the document (paragraphs styled
// 제목 1–6 / Heading 1–6, click to go there) and the page thumbnails (click to go to the page). Layers and slide
// masters are not shown here — they belong to the design / slide modes.

import { useMemo, useState } from "react";
import { useStore } from "../../core/store";
import type { OmwDocument, Page, TextNode } from "../../core/types";
import { layoutText } from "../../core/text";
import { paraText, textStats, type TextStats } from "../../core/textSearch";
import { fitCurrent } from "../actions";
import { editModeOf } from "../editModes";
import { IconBtn, cx } from "./controls";
import { Icon } from "./Icons";
import { Thumb } from "./Thumbs";
import { uiScaleFactor, useUI } from "./uiStore";
import { useT } from "../../i18n";

const S = () => useStore.getState();

export interface HeadingItem {
  pageId: string;
  pageIndex: number;
  nodeId: string;
  para: number;
  level: number;
  text: string;
}

/** Pages that edit as documents under the current work mode. */
export const docPages = (doc: OmwDocument, mode = S().mode) => doc.pages.filter((p) => editModeOf(mode, p) === "DOCUMENT");

const textNodes = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && n.visible).sort((a, b) => a.transform.y - b.transform.y || a.transform.x - b.transform.x);

/** The headings of the document pages, in reading order (pages, then text boxes top to bottom). */
export function docOutline(doc: OmwDocument, mode = S().mode): HeadingItem[] {
  const out: HeadingItem[] = [];
  doc.pages.forEach((p, pageIndex) => {
    if (editModeOf(mode, p) !== "DOCUMENT") return;
    for (const n of textNodes(p))
      n.paragraphs.forEach((para, i) => {
        const m = /^h([1-6])$/.exec(para.role ?? "");
        if (!m) return;
        const text = paraText(para).trim();
        if (text) out.push({ pageId: p.id, pageIndex, nodeId: n.id, para: i, level: Number(m[1]), text });
      });
  });
  return out;
}

/** Characters / words of the document pages' text (status bar). */
/** docStats per document root and work mode: panels that re-render on every page change (continuous scrolling in
 * the document mode crosses page boundaries all the time) must not walk every paragraph each time */
const statsCache = new WeakMap<OmwDocument, Map<string, TextStats>>();

export function docStats(doc: OmwDocument, mode = S().mode): TextStats {
  let byMode = statsCache.get(doc);
  if (!byMode) statsCache.set(doc, (byMode = new Map()));
  let st = byMode.get(mode);
  if (!st) byMode.set(mode, (st = countDocStats(doc, mode)));
  return st;
}

function countDocStats(doc: OmwDocument, mode: NonNullable<Parameters<typeof docPages>[1]>): TextStats {
  // body text and table cells, as Word / 한글 count them
  return textStats(docPages(doc, mode).flatMap((p) => p.nodes.flatMap((n) => (n.type === "TEXT" ? n.paragraphs.map(paraText) : n.type === "TABLE" ? n.rows.flat().map((c) => c.text) : []))));
}

/** The language most of the text is written in, by script (status bar): ko / ja / zh / en. */
export function docLanguage(doc: OmwDocument, mode = S().mode): "ko" | "ja" | "zh" | "en" | null {
  let hangul = 0, kana = 0, han = 0, latin = 0, seen = 0;
  outer: for (const p of docPages(doc, mode))
    for (const n of p.nodes) {
      if (n.type !== "TEXT") continue;
      for (const para of n.paragraphs) {
        const s = paraText(para);
        for (const ch of s) {
          if (/\p{Script=Hangul}/u.test(ch)) hangul++;
          else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana++;
          else if (/\p{Script=Han}/u.test(ch)) han++;
          else if (/[A-Za-z]/.test(ch)) latin++;
          if (++seen > 4000) break outer;
        }
      }
    }
  if (!hangul && !kana && !han && !latin) return null;
  if (hangul >= Math.max(kana, han, latin * 0.3)) return "ko";
  if (kana > 0 && kana + han >= latin * 0.3) return "ja";
  if (han >= latin * 0.3) return "zh";
  return "en";
}

/** Go to a page (and optionally a point on it, page px): it becomes current, scrolled so the point is near the top. */
export function goToPage(pageId: string, y?: number) {
  const s = S();
  if (s.pageId !== pageId) s.set({ pageId, selection: [], editingTextId: null });
  if (y === undefined) return void setTimeout(fitCurrent);
  setTimeout(() => {
    fitCurrent();
    const v = S().view;
    S().set({ view: { ...v, panY: Math.min(v.panY, 48 - y * v.zoom) } });
  });
}

function goToHeading(h: HeadingItem) {
  const page = S().doc.pages.find((p) => p.id === h.pageId);
  const node = page?.nodes.find((n) => n.id === h.nodeId);
  if (!page || !node || node.type !== "TEXT") return goToPage(h.pageId);
  const line = layoutText(node).lines.find((l) => l.paragraph === h.para);
  goToPage(h.pageId, node.transform.y + (line ? line.y * node.transform.scale : 0));
}

function Headings() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.mode);
  const pageId = useStore((s) => s.pageId);
  const items = useMemo(() => docOutline(doc, mode), [doc, mode]);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  if (!items.length)
    return (
      <div className="empty-state nav-empty">
        <Icon name="outline" size={22} />
        <p>{t("docmode.nav.noHeadings")}</p>
        <small>{t("docmode.nav.noHeadingsHint")}</small>
      </div>
    );
  // a heading hides the deeper ones under it while folded
  const rows: JSX.Element[] = [];
  let hideBelow = 99;
  items.forEach((h, i) => {
    if (h.level > hideBelow) return;
    hideBelow = 99;
    const key = `${h.nodeId}:${h.para}`;
    const hasKids = items[i + 1] && items[i + 1].level > h.level;
    const isFolded = !!folded[key];
    if (isFolded) hideBelow = h.level;
    // the current page's first heading is marked (where you are)
    const here = h.pageId === pageId && items.findIndex((x) => x.pageId === pageId) === i;
    rows.push(
      <div key={key} className={cx("nav-row", `lv-${Math.min(h.level, 4)}`, here && "here")} style={{ paddingLeft: 6 + (h.level - 1) * 14 }}>
        {hasKids ? (
          <button type="button" className="nav-fold" aria-label={isFolded ? t("layers.row.unfold") : t("layers.row.fold")} aria-expanded={!isFolded} onClick={() => setFolded((f) => ({ ...f, [key]: !isFolded }))}>
            <Icon name={isFolded ? "chevronRight" : "chevron"} size={12} />
          </button>
        ) : (
          <span className="nav-fold" />
        )}
        <button type="button" className="nav-text" title={h.text} onClick={() => goToHeading(h)}>
          {h.text}
        </button>
      </div>,
    );
  });
  return (
    <div className="dock-scroll nav-list" role="tree" aria-label={t("docmode.nav.headings")}>
      {rows}
    </div>
  );
}

function PageThumbs() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.mode);
  const pageId = useStore((s) => s.pageId);
  const leftW = useUI((s) => s.leftW);
  const uiK = uiScaleFactor(useUI((s) => s.uiScale));
  const thumbW = Math.max(96, Math.round((leftW - 72) * uiK));
  const pages = doc.pages.map((p, i) => ({ p, i })).filter(({ p }) => editModeOf(mode, p) === "DOCUMENT");
  return (
    <div className="dock-scroll nav-pages" role="listbox" aria-label={t("docmode.nav.pages")}>
      {pages.map(({ p, i }) => {
        const w = Math.round(p.width >= p.height ? thumbW : Math.min(thumbW, (thumbW * 1.42 * p.width) / p.height));
        return (
          <button key={p.id} type="button" role="option" aria-selected={p.id === pageId} className={cx("nav-page", p.id === pageId && "on")} onClick={() => goToPage(p.id)}>
            <span className="nav-thumb">
              <Thumb page={p} width={w} />
            </span>
            <span className="nav-num">{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

type NavView = "headings" | "pages";

export function DocNav() {
  const t = useT();
  const set = useUI((s) => s.set);
  const [view, setView] = useState<NavView>("headings");
  return (
    <aside className="dock dock-left dock-nav" aria-label={t("docmode.nav.title")}>
      <div className="dock-tabs" role="tablist">
        <span className="dock-title">
          <Icon name="outline" size={14} />
          {t("docmode.nav.title")}
        </span>
        <span className="dock-tabs-spacer" />
        <IconBtn icon="panelLeft" size="sm" tip={t("dock.collapse")} kbd="Ctrl+Alt+1" onClick={() => set({ leftOpen: false })} />
      </div>
      <div className="nav-switch" role="tablist">
        {(["headings", "pages"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={cx("nav-switch-btn", view === v && "on")} onClick={() => setView(v)}>
            {t(`docmode.nav.${v}`)}
          </button>
        ))}
      </div>
      <div className="dock-body">{view === "headings" ? <Headings /> : <PageThumbs />}</div>
    </aside>
  );
}
