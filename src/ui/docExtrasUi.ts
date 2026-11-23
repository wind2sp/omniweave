// 문서 탭의 목차 넣기 (참조 › 목차) and 문단 부호 (보기 › 문단 부호, Word Ctrl+Shift+8) — QA ui-audit #26: both were
// "준비 중". The table of contents is a borderless two-column table of the headings (제목 1–3) with their page numbers
// as they are when it is put in (Word's TOC field is updated by hand too); the marks are a screen-only ¶ at the end
// of every paragraph of the document body.

import { caretBox, flowLines, gatherStory, isFlowPageAt, nodeOrder, segmentAt } from "../core/flow";
import { formatPageNumber, hfInfo } from "../core/headerFooter";
import { useStore } from "../core/store";
import { newTable, uid, type OmwDocument, type Page, type TableCell, type TextParagraph } from "../core/types";
import { t } from "../i18n";
import { beginTyping, flowActive, insertObject, useDocView } from "./docFlow";

const S = () => useStore.getState();

/** The headings (제목 1–3) of the document's flowing body in order, with the page each starts on (as numbered there). */
export function tocEntries(doc: Pick<OmwDocument, "pages">): { level: number; text: string; page: string }[] {
  const pages = doc.pages;
  const info = hfInfo(pages);
  const out: { level: number; text: string; page: string }[] = [];
  const seen = new Set<string>();
  pages.forEach((pg, i) => {
    if (pg.kind !== "DOCUMENT") return;
    const frames = pg.nodes.filter((n) => n.type === "TEXT" && n.flow).sort(nodeOrder);
    for (const n of frames) {
      if (n.type !== "TEXT") continue;
      for (const p of n.paragraphs) {
        const m = /^h([1-3])$/.exec(p.role ?? "");
        // (a heading cut at a page end: only its first piece)
        if (!m || p.flowCont || seen.has(p.id)) continue;
        seen.add(p.id);
        const text = p.runs.filter((r) => !r.obj && !r.note).map((r) => r.text).join("").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const pi = info.pages[i];
        out.push({ level: Number(m[1]), text, page: pi ? formatPageNumber(pi.num, pi.fmt) : String(i + 1) });
      }
    }
  });
  return out;
}

/** 목차 넣기: at the caret of the body (its start when the caret is not in it). False when there is nothing to list. */
export function insertToc(): boolean {
  const s = S();
  const entries = tocEntries(s.doc);
  if (!entries.length) {
    s.notify(t("docmode.toc.none"));
    return false;
  }
  if (!flowActive()) {
    const i = s.doc.pages.findIndex((p) => p.id === s.pageId);
    if (!isFlowPageAt(s.doc.pages, i) || !beginTyping(s.pageId)) {
      s.notify(t("docmode.toc.noBody"));
      return false;
    }
  }
  const pg = s.doc.pages.find((p) => p.id === s.pageId)!;
  const m = pg.margins;
  const bodyW = Math.max(200, pg.width - (m?.left ?? 76) - (m?.right ?? 76));
  const size = 14;
  const para = (text: string, level: number, bold: boolean, align: TextParagraph["align"] = "LEFT"): TextParagraph => ({
    id: uid("p"),
    runs: [{ text, fontFamily: "Pretendard", fontSize: size, bold, italic: false, underline: false, color: "#1d1f24" }],
    align,
    lineSpacing: 1.3,
    indent: 0,
    ...(level > 1 ? { indentLeft: (level - 1) * 18 } : {}),
    spaceAfter: 2,
  });
  const title = t("docmode.toc.title");
  const rows: TableCell[][] = [
    [{ text: title, bold: true, colSpan: 2, richText: [para(title, 1, true)] }, { text: "" }],
    ...entries.map((e): TableCell[] => [
      { text: e.text, bold: e.level === 1, richText: [para(e.text, e.level, e.level === 1)] },
      { text: e.page, align: "RIGHT", richText: [para(e.page, 1, e.level === 1, "RIGHT")] },
    ]),
  ];
  const tbl = newTable(rows, [bodyW - 56, 56], title);
  tbl.headerRow = false;
  // (no visible lines: the page colour, which every writer keeps as a colour)
  tbl.borderColor = "#ffffff";
  tbl.background = null;
  tbl.fontSize = size;
  tbl.rowHeight = 22;
  const ok = insertObject(tbl);
  if (ok) S().notify(t("docmode.toc.done", { n: entries.length }));
  return ok;
}

// ───────── 문단 부호 ─────────

export function toggleFormatMarks() {
  useDocView.setState({ marks: !useDocView.getState().marks });
  S().set({ view: { ...S().view } });
}

/** ¶ after every paragraph of the body on `page` (screen only), in `view` (the page's own view in the document mode). */
export function drawFormatMarks(c: CanvasRenderingContext2D, doc: OmwDocument, page: Page, view: { zoom: number; panX: number; panY: number }, dpr: number) {
  if (!useDocView.getState().marks) return;
  const pages = doc.pages;
  const i = pages.indexOf(page);
  if (!isFlowPageAt(pages, i)) return;
  const seg = segmentAt(pages, i);
  const st = gatherStory(pages, seg);
  const lines = flowLines(pages, seg);
  const { zoom, panX, panY } = view;
  c.save();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = "rgba(43,116,236,.8)";
  c.textBaseline = "alphabetic";
  st.paras.forEach((p, k) => {
    const len = p.runs.reduce((a, r) => a + r.text.length, 0);
    const cb = caretBox(lines, k, len);
    if (!cb || cb.page !== i) return;
    const h = cb.h * zoom;
    c.font = `${Math.max(6, h * 0.72)}px "Segoe UI", Arial, sans-serif`;
    c.fillText("¶", cb.x * zoom + panX + 1, cb.y * zoom + panY + h * 0.8);
  });
  c.restore();
}
