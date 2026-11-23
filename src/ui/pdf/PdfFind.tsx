// Find on PDF pages (실사용 점검 2026-11-23 #70): the word processor's Find searches text boxes and table cells, so a
// PDF page — whose words live in the file, not in nodes — answered "no matches" for text plainly on screen. Like
// Acrobat's Find bar: the words of every (not elevated) PDF page are read from the file (pdf.js text content), every
// match is tinted on the page and Enter / the arrows go from one to the next, turning pages and scrolling to it.
// Text boxes and table cells (an elevated page, the text layer OCR puts over a scan, added text) are found too.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { applyTransform } from "../../core/geom";
import { nodeBounds } from "../../core/loom";
import { useStore } from "../../core/store";
import { findMatches, matchRanges, searchRegex } from "../../core/textSearch";
import type { OmwDocument, PdfNode } from "../../core/types";
import { useT } from "../../i18n";
import { pdfPageGeom, pdfTextItems, widgetRectOnNode, type PdfFormInfo, type PdfTextItem } from "../../io/pdf";
import { selectPage } from "../pageActions";
import { Icon } from "../shell/Icons";
import { useUI } from "../shell/uiStore";

/** One match: its page and its boxes on the page (page px [x, y, w, h], one per text run it covers). */
export interface PdfHit {
  pageId: string;
  boxes: [number, number, number, number][];
  /** a match in a text box or table cell: that object (selected when it is the current match) */
  nodeId?: string;
}

export const usePdfFind = create<{ hits: PdfHit[]; cur: number }>(() => ({ hits: [], cur: -1 }));

/** A PDF page node that shows the file's own words (an elevated page's words are text boxes instead). */
export function pdfSearchNode(page: { nodes: readonly { type: string }[] }): PdfNode | undefined {
  const n = page.nodes.find((x): x is PdfNode => x.type === "PDF") as PdfNode | undefined;
  return n && n.visible && !n.covers.length ? n : undefined;
}

/** Text runs → lines (same baseline, left to right), each joined as one string with the runs' offsets in it. */
export function pdfLines(items: readonly PdfTextItem[]): { text: string; runs: { item: PdfTextItem; start: number; end: number }[] }[] {
  const sorted = [...items].sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0);
  const lines: PdfTextItem[][] = [];
  for (const it of sorted) {
    const h = it.y1 - it.y0;
    const line = lines.find((l) => Math.abs(l[0].y0 - it.y0) < h * 0.4);
    if (line) line.push(it);
    else lines.push([it]);
  }
  return lines.map((l) => {
    l.sort((a, b) => a.x0 - b.x0);
    let text = "";
    const runs: { item: PdfTextItem; start: number; end: number }[] = [];
    for (const it of l) {
      const prev = runs[runs.length - 1]?.item;
      // a gap wider than a thin space between runs reads as a word space
      if (prev && it.x0 - prev.x1 > (it.y1 - it.y0) * 0.15 && !text.endsWith(" ") && !it.str.startsWith(" ")) text += " ";
      runs.push({ item: it, start: text.length, end: text.length + it.str.length });
      text += it.str;
    }
    return { text, runs };
  });
}

/** Every match of `query` on one page's text runs, as boxes in PDF user space. */
export function pdfMatches(items: readonly PdfTextItem[], query: string, matchCase = false): [number, number, number, number][][] {
  const re = searchRegex(query, matchCase);
  if (!re) return [];
  const out: [number, number, number, number][][] = [];
  for (const line of pdfLines(items))
    for (const [a, b] of matchRanges(line.text, re)) {
      const boxes: [number, number, number, number][] = [];
      for (const r of line.runs) {
        const s = Math.max(a, r.start), e = Math.min(b, r.end);
        if (s >= e) continue;
        // the run's width shared evenly by its characters (pdf.js gives the run's width only)
        const len = Math.max(1, r.end - r.start), w = r.item.x1 - r.item.x0;
        boxes.push([r.item.x0 + (w * (s - r.start)) / len, r.item.y0, r.item.x0 + (w * (e - r.start)) / len, r.item.y1]);
      }
      if (boxes.length) out.push(boxes);
    }
  return out;
}

/** A box in PDF user space → page px through the page node (its rotation, position and scale). */
function onPage(geom: Pick<PdfFormInfo, "pages">, n: PdfNode, r: [number, number, number, number]): [number, number, number, number] {
  const [x, y, w, h] = widgetRectOnNode(geom, n.pageIndex, r);
  const a = applyTransform(n.transform, [x, y]), b = applyTransform(n.transform, [x + w, y + h]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
}

async function searchDoc(doc: OmwDocument, query: string, matchCase: boolean): Promise<PdfHit[]> {
  const hits: PdfHit[] = [];
  const inBoxes = findMatches(doc, query, matchCase);
  for (const page of doc.pages) {
    const n = pdfSearchNode(page);
    const hash = n && doc.assets[n.assetId]?.hash;
    if (n && hash) {
      const [items, geom] = await Promise.all([pdfTextItems(hash, n.pageIndex).catch(() => [] as PdfTextItem[]), pdfPageGeom(hash)]);
      if (geom) for (const boxes of pdfMatches(items, query, matchCase)) hits.push({ pageId: page.id, boxes: boxes.map((b) => onPage(geom, n, b)) });
    }
    // text boxes / cells on the page: the whole object is marked and selected, as the regular Find does
    for (const m of inBoxes) {
      const node = m.pageId === page.id ? page.nodes.find((x) => x.id === m.nodeId) : undefined;
      if (!node) continue;
      const b = nodeBounds(node);
      hits.push({ pageId: page.id, boxes: [[b.x, b.y, b.w, b.h]], nodeId: node.id });
    }
    // the text layer OCR lays over a scan is locked (it only makes the page searchable): found, not selected
    const re = searchRegex(query, matchCase);
    for (const n of page.nodes)
      if (re && n.locked && n.visible && n.type === "TEXT")
        for (const p of n.paragraphs)
          if (matchRanges(p.runs.map((r) => r.text).join(""), re).length) {
            const b = nodeBounds(n);
            hits.push({ pageId: page.id, boxes: [[b.x, b.y, b.w, b.h]] });
            break;
          }
  }
  return hits;
}

const S = () => useStore.getState();

/** Brings the match into view: its page, scrolled so the match sits in the middle of the screen. */
function reveal(h: PdfHit) {
  const wasOn = S().pageId === h.pageId;
  selectPage(h.pageId);
  // (selectPage fits the new page after a tick; the scroll comes after that)
  setTimeout(
    () => {
      if (S().pageId !== h.pageId) return;
      const [, y, , hh] = h.boxes[0];
      const vh = document.querySelector(".canvas-wrap")?.clientHeight ?? 800;
      const v = S().view;
      S().set({ view: { ...v, panY: vh / 2 - (y + hh / 2) * v.zoom }, ...(h.nodeId ? { selection: [h.nodeId] } : {}) });
    },
    wasOn ? 0 : 40,
  );
}

/** The Find bar for PDF pages (Ctrl+F on a PDF page; PDF ▸ 찾기). */
export function PdfFindBar() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const [q, setQ] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [busy, setBusy] = useState(false);
  const { hits, cur } = usePdfFind();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // closing clears the tint
  useEffect(() => () => usePdfFind.setState({ hits: [], cur: -1 }), []);
  useEffect(() => {
    let live = true;
    if (!q) {
      usePdfFind.setState({ hits: [], cur: -1 });
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      void searchDoc(doc, q, matchCase).then((h) => {
        if (!live) return;
        setBusy(false);
        usePdfFind.setState({ hits: h, cur: -1 });
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, matchCase, doc.pages]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = hits.length;
  const go = (dir: 1 | -1) => {
    if (!n) return void (q && !busy && S().notify(t("menu.toast.noMatch")));
    // first Enter: the first match on or after the current page
    let i: number;
    if (cur < 0) {
      const order = S().doc.pages.map((p) => p.id);
      const here = order.indexOf(S().pageId);
      i = dir > 0 ? Math.max(0, hits.findIndex((h) => order.indexOf(h.pageId) >= here)) : n - 1;
    } else i = (cur + dir + n) % n;
    usePdfFind.setState({ cur: i });
    reveal(hits[i]);
  };
  const close = () => useUI.getState().set({ shellDialog: null });
  const status = !q ? t("pdf.find.hint") : busy ? t("pdf.find.searching") : !n ? t("menu.find.none") : cur >= 0 ? t("menu.find.position", { i: cur + 1, n }) : t("menu.find.total", { n });

  return (
    <div className="pdf-find-bar" role="search" aria-label={t("menu.find.title")} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), close())}>
      <Icon name="search" size={14} />
      <input
        ref={input}
        value={q}
        aria-label={t("menu.find.find")}
        placeholder={t("menu.find.title")}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.preventDefault(), go(e.shiftKey ? -1 : 1));
        }}
      />
      <span className="pdf-find-status" role="status" aria-live="polite">
        {status}
      </span>
      <label className="find-case" data-tip={t("menu.find.matchCase")}>
        <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
        <span>Aa</span>
      </label>
      <button type="button" className="btn btn-ghost btn-icon" disabled={!n} aria-label={t("menu.find.prev")} data-tip={t("menu.find.prev")} onClick={() => go(-1)}>
        <Icon name="up" size={14} />
      </button>
      <button type="button" className="btn btn-ghost btn-icon" disabled={!n} aria-label={t("menu.find.next")} data-tip={t("menu.find.next")} onClick={() => go(1)}>
        <Icon name="down" size={14} />
      </button>
      <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} data-tip={t("common.close")} onClick={close}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** The matches tinted on the current PDF page (CanvasView), the current one stronger. */
export function PdfFindLayer() {
  const { hits, cur } = usePdfFind();
  const pageId = useStore((s) => s.pageId);
  const view = useStore((s) => s.view);
  if (!hits.length) return null;
  const toScreen = ([x, y, w, h]: [number, number, number, number]) => ({ left: x * view.zoom + view.panX, top: y * view.zoom + view.panY, width: w * view.zoom, height: h * view.zoom });
  return (
    <div className="pdf-find-layer" aria-hidden="true">
      {hits.map((h, i) =>
        h.pageId !== pageId ? null : h.boxes.map((b, k) => <div key={`${i}:${k}`} className={"pdf-find-hit" + (i === cur ? " cur" : "")} style={toScreen(b)} />),
      )}
    </div>
  );
}
