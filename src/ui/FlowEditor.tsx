// Caret, selection and the hidden input of the document body editor (ui/docFlow.ts) over the canvas.
// Only DOM boxes positioned with the view transform: the canvas keeps drawing the text from the real layout.

import { useEffect, useRef } from "react";
import { caretBox, flowLines, rangeRects, segmentAt } from "../core/flow";
import * as RT from "../core/richtext";
import { useStore } from "../core/store";
import { t as tx } from "../i18n";
import { attachInput, tailCaret, onCompositionEnd, onCompositionStart, onCompositionUpdate, onCopy, onInput, onKeyDown, onPaste, picLayoutOf, setPicLayout, useFlow, type PicLayout } from "./docFlow";
import { useState } from "react";
import { nodeBounds } from "../core/loom";
import { isFlowPageAt } from "../core/flow";
import { docModeNow, neighbours } from "./docView";

export function FlowEditor() {
  const f = useFlow();
  const doc = useStore((s) => s.doc);
  const pageId = useStore((s) => s.pageId);
  const view = useStore((s) => s.view);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ta.current;
    attachInput(el);
    if (!el) return;
    const kd = (e: KeyboardEvent) => onKeyDown(e);
    const inp = (e: Event) => onInput(e);
    const cs = () => onCompositionStart();
    const cu = (e: CompositionEvent) => onCompositionUpdate(e.data ?? "");
    const ce = (e: CompositionEvent) => onCompositionEnd(e.data ?? "");
    const cp = (e: ClipboardEvent) => onCopy(e, false);
    const ct = (e: ClipboardEvent) => onCopy(e, true);
    const ps = (e: ClipboardEvent) => onPaste(e);
    el.addEventListener("keydown", kd);
    el.addEventListener("input", inp);
    el.addEventListener("compositionstart", cs);
    el.addEventListener("compositionupdate", cu);
    el.addEventListener("compositionend", ce);
    el.addEventListener("copy", cp);
    el.addEventListener("cut", ct);
    el.addEventListener("paste", ps);
    return () => {
      attachInput(null);
      el.removeEventListener("keydown", kd);
      el.removeEventListener("input", inp);
      el.removeEventListener("compositionstart", cs);
      el.removeEventListener("compositionupdate", cu);
      el.removeEventListener("compositionend", ce);
      el.removeEventListener("copy", cp);
      el.removeEventListener("cut", ct);
      el.removeEventListener("paste", ps);
    };
  }, [f.active]);

  if (!f.active || !f.segId) return null;
  const pages = doc.pages;
  const si = pages.findIndex((p) => p.id === f.segId);
  if (si < 0) return null;
  const lines = flowLines(pages, segmentAt(pages, si));
  const pi = pages.findIndex((p) => p.id === pageId);
  // the pages shown together in the document mode (docView.ts): a selection crossing a page end shows on each of
  // them, the caret on the page it is on — each page in its own view
  const shown: { i: number; v: typeof view }[] = [{ i: pi, v: view }];
  if (docModeNow()) for (const n of neighbours(doc, pageId, view, typeof window === "undefined" ? 1080 : window.innerHeight)) shown.push({ i: pages.indexOf(n.page), v: n.view });
  const cb = caretBox(lines, f.focus.p, f.focus.o);
  const r = RT.range(f.anchor, f.focus);
  const boxes = (a: RT.Pos, b: RT.Pos) => shown.flatMap(({ i, v }) => rangeRects(lines, i, a, b).map((q) => ({ x: q.x * v.zoom + v.panX, y: q.y * v.zoom + v.panY, w: q.w * v.zoom, h: q.h * v.zoom })));
  const rects = RT.collapsed(r) ? [] : boxes(r.start, r.end);
  const comp = f.comp && f.comp.b > f.comp.a ? boxes({ p: f.comp.p, o: f.comp.a }, { p: f.comp.p, o: f.comp.b }) : [];
  // after the picture that ends the body (docFlow tail), else at the story position
  const tc = f.tail ? tailCaret() : null;
  const at = tc ?? cb;
  const cv = at ? shown.find((s) => s.i === at.page)?.v : undefined;
  const caret = at && cv ? { x: at.x * cv.zoom + cv.panX, y: at.y * cv.zoom + cv.panY, h: Math.max(8, at.h * cv.zoom) } : null;
  return (
    <div className="flow-editor" aria-hidden={false}>
      {rects.map((q, i) => (
        <div key={i} className="flow-sel" style={{ left: q.x, top: q.y, width: q.w, height: q.h }} />
      ))}
      {comp.map((q, i) => (
        <div key={`c${i}`} className="flow-comp" style={{ left: q.x, top: q.y + q.h - 2, width: q.w }} />
      ))}
      {caret && RT.collapsed(r) && <div key={f.tick} className="flow-caret" style={{ left: Math.round(caret.x), top: caret.y, height: caret.h }} />}
      <textarea
        ref={ta}
        className="flow-input"
        aria-label={tx("docflow.input")}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        style={{ left: caret ? caret.x : 0, top: caret ? caret.y : 0, height: caret ? caret.h : 16 }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

const LAYOUTS: PicLayout[] = ["inline", "square", "topBottom", "behind", "front"];

/**
 * Word's 레이아웃 옵션 button beside a selected picture or shape on a flowing document page: in line with text, square,
 * top and bottom, behind / in front of text.
 */
export function PicLayoutButton() {
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const pages = useStore((s) => s.doc.pages);
  const sel = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const editing = useStore((s) => s.editingTextId);
  const [open, setOpen] = useState(false);
  if (!page || editing || sel.length !== 1) return null;
  const n = page.nodes.find((x) => x.id === sel[0]);
  const cur = picLayoutOf(n);
  if (!n || !cur || !isFlowPageAt(pages, pages.indexOf(page))) return null;
  const b = nodeBounds(n);
  const left = (b.x + b.w) * view.zoom + view.panX + 8, top = b.y * view.zoom + view.panY;
  return (
    <div className="pic-layout" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="pic-layout-btn" aria-label={tx("docflow.layout.title")} data-tip={tx("docflow.layout.title")} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5" y="4" width="6" height="5" rx="0.5" fill="none" stroke="currentColor" />
          <path d="M1 2h14M1 11h14M1 14h10M1 6.5h3M12 6.5h3" stroke="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="pic-layout-menu" role="menu">
          <div className="pic-layout-head">{tx("docflow.layout.title")}</div>
          {LAYOUTS.map((l) => (
            <button
              key={l}
              type="button"
              role="menuitemradio"
              aria-checked={cur === l}
              className={cur === l ? "on" : undefined}
              onClick={() => {
                setOpen(false);
                setPicLayout(n.id, l);
              }}
            >
              {tx(`docflow.layout.${l}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
