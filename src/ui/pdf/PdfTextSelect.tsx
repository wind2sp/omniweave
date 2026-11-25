// Selecting and copying text on a PDF page, as in Acrobat (기본 작업 사용성 점검 2026-11-24 #4: dragging over a PDF's
// words showed nothing and copied nothing). With the selection tool, a press on the page's words starts a text
// selection instead of picking the page: dragging marks the words in reading order (ui/pdf/textMark.ts — the same
// order the highlighter uses), Ctrl+C copies them, Esc or a press elsewhere drops the selection. Elevated pages are
// text boxes already and select as text boxes.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { applyTransform, invertTransform } from "../../core/geom";
import { useStore } from "../../core/store";
import type { PdfNode } from "../../core/types";
import { t } from "../../i18n";
import { nodePointToPdf, pdfPageGeom, pdfTextItems, widgetRectOnNode, type PdfFormInfo, type PdfTextItem } from "../../io/pdf";
import { isTyping } from "../shell/ops";
import { pdfSearchNode } from "./PdfFind";
import { usePdfAnnot } from "./PdfAnnotLayer";
import { usePdfTools } from "./pdfToolsStore";
import { quadsBetween, textBetween } from "./textMark";

export const usePdfTextSel = create<{ sel: { pageId: string; a: [number, number]; b: [number, number] } | null }>(() => ({ sel: null }));

const S = () => useStore.getState();
/** a press on these is theirs (form fields, comments, the find bar), never a text selection */
const OWN = ".pdf-field, .pdf-field-edit, .pdf-annot-hit, .pdf-annot-pop, .pdf-find-bar, .modal, .menu-pop";

export function PdfTextSelectLayer() {
  const pageId = useStore((s) => s.pageId);
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const view = useStore((s) => s.view);
  const node = page && pdfSearchNode(page);
  const hash = useStore((s) => (node ? s.doc.assets[node.assetId]?.hash : undefined));
  const [geom, setGeom] = useState<Pick<PdfFormInfo, "pages"> | null>(null);
  const [items, setItems] = useState<PdfTextItem[]>([]);
  const sel = usePdfTextSel((s) => s.sel);

  useEffect(() => {
    let live = true;
    setGeom(null);
    setItems([]);
    if (hash && node) {
      void pdfPageGeom(hash).then((g) => live && setGeom(g));
      void pdfTextItems(hash, node.pageIndex).then((x) => live && setItems(x)).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [hash, node?.pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  // another page: the selection goes
  useEffect(() => usePdfTextSel.setState({ sel: null }), [pageId]);

  useEffect(() => {
    const wrap = document.querySelector<HTMLElement>(".canvas-wrap");
    if (!wrap || !node || !geom || !items.length) return;
    const n: PdfNode = node;
    const toPdf = (e: PointerEvent): [number, number] => {
      const r = wrap.getBoundingClientRect(), v = S().view;
      const p = invertTransform(n.transform, [(e.clientX - r.left - v.panX) / v.zoom, (e.clientY - r.top - v.panY) / v.zoom]);
      return nodePointToPdf(geom, n.pageIndex, p as [number, number]);
    };
    const onText = (p: [number, number]) => items.some((it) => p[0] >= it.x0 - 2 && p[0] <= it.x1 + 2 && p[1] >= it.y0 - 2 && p[1] <= it.y1 + 2);
    // (a comment tool or a tool of the 도구 tab — redaction marks, links, fields, crop, pictures — takes the drag)
    const usable = (e: PointerEvent) => S().tool === "select" && !usePdfAnnot.getState().tool && !usePdfTools.getState().tool && !(e.target as Element | null)?.closest?.(OWN);
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !usable(e)) return;
      const p = toPdf(e);
      if (!onText(p)) {
        if (usePdfTextSel.getState().sel) usePdfTextSel.setState({ sel: null });
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      const id = S().pageId;
      const cur = usePdfTextSel.getState().sel;
      // Shift+press: the selection grows to here
      const a = e.shiftKey && cur?.pageId === id ? cur.a : p;
      usePdfTextSel.setState({ sel: { pageId: id, a, b: p } });
      S().set({ selection: [] });
      const move = (ev: PointerEvent) => usePdfTextSel.setState((s) => (s.sel ? { sel: { ...s.sel, b: toPdf(ev) } } : s));
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        const s = usePdfTextSel.getState().sel;
        if (s && !textBetween(items, s.a, s.b).trim()) usePdfTextSel.setState({ sel: null });
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
    };
    // the I-beam over the words, as Acrobat shows it
    const hover = (e: PointerEvent) => {
      if (e.buttons || !usable(e)) return;
      const over = onText(toPdf(e));
      if (over) wrap.style.cursor = "text";
      else if (wrap.style.cursor === "text") wrap.style.cursor = "";
    };
    const key = (e: KeyboardEvent) => {
      const s = usePdfTextSel.getState().sel;
      if (!s || isTyping(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyC" || e.code === "Insert")) {
        e.preventDefault();
        e.stopPropagation();
        const text = textBetween(items, s.a, s.b);
        void navigator.clipboard?.writeText(text).then(
          () => S().notify(t("pdf.select.copied", { n: [...text.replace(/\s/g, "")].length })),
          () => S().notify(t("pdf.select.copyFailed")),
        );
      } else if (e.key === "Escape") usePdfTextSel.setState({ sel: null });
    };
    wrap.addEventListener("pointerdown", down, true);
    wrap.addEventListener("pointermove", hover);
    window.addEventListener("keydown", key, true);
    return () => {
      wrap.removeEventListener("pointerdown", down, true);
      wrap.removeEventListener("pointermove", hover);
      window.removeEventListener("keydown", key, true);
    };
  }, [node, geom, items]);

  if (!sel || !node || !geom || sel.pageId !== pageId) return null;
  const box = (q: number[]) => {
    const [x, y, w, h] = widgetRectOnNode(geom, node.pageIndex, [q[4], q[5], q[2], q[3]]);
    const a = applyTransform(node.transform, [x, y]), b = applyTransform(node.transform, [x + w, y + h]);
    return { left: Math.min(a[0], b[0]) * view.zoom + view.panX, top: Math.min(a[1], b[1]) * view.zoom + view.panY, width: Math.abs(b[0] - a[0]) * view.zoom, height: Math.abs(b[1] - a[1]) * view.zoom };
  };
  return (
    <div className="pdf-text-sel" aria-hidden="true">
      {quadsBetween(items, sel.a, sel.b).map((q, i) => (
        <div key={i} className="pdf-text-sel-box" style={box(q)} />
      ))}
    </div>
  );
}
