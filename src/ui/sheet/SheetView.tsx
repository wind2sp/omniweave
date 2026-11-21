// Sheet grid (표 계산 화면): a workbook page shown and edited as Excel does — endless cell grid with A B C / 1 2 3
// headings, name box and formula bar, sheet tabs, frozen panes, selection by click / drag / Shift, keyboard moves
// (arrows, Ctrl+arrows, Tab, Enter, Home, PgUp/PgDn), typing straight into a cell or F2 / double-click, IME input,
// copy / paste with Excel and HTML tables, column width dragging (double-click fits), Ctrl+wheel zoom, and the
// sum / count / average of the selection. In a sheet, Excel's keys win: Ctrl+PgUp/PgDn change sheets and
// Ctrl+Shift+1…6 apply number formats (outside sheets they keep their Omniweave meaning — docs/design/EDIT_MODES.md §7).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { currentPage, useStore } from "../../core/store";
import type { Page } from "../../core/types";
import { t, useT } from "../../i18n";
import { addr, MAX_COL, MAX_ROW, parseRange, rangeText, colLetters } from "../../io/sheet/formula";
import { usedRange } from "../../io/sheet/pages";
import { display, cellRect, geomOf, hitCell, paintSheet, panes } from "../../render/sheet";
import { onDrawingReady } from "../../render/sheetDrawings";
import { filterButtonAt, filterButtonRect, listArrowRect, type SheetPaintExtra } from "../../render/sheetExtras";
import { cx } from "../shell/controls";
import { useUI } from "../shell/uiStore";
import {
  addSheet,
  autoSumFormula,
  bookPages,
  clearRange,
  copyRange,
  dataEdge,
  editText,
  enterText,
  formatRange,
  applyNumberFormat,
  NUMBER_KEYS,
  lang,
  norm,
  one,
  paste,
  renameSheet,
  setColWidth,
  setSel,
  styleAt,
  useSheetUI,
  type Sel,
} from "./sheetActions";
import { NoteEditor, NoteTip, SheetDialogs } from "./SheetDialogs";
import { fill, fillDir, insertOrDelete, openDlg, passesValidation, toggleFilter, useSheetDlg, validationAt } from "./sheetEdit";

const S = () => useStore.getState();

/** View state per sheet page (scroll, zoom), kept while switching tabs. */
const views = new Map<string, { x: number; y: number; zoom: number }>();

interface Editing {
  a: string;
  r: number;
  c: number;
  text: string;
  /** "enter": typed over the cell (arrows commit); "edit": F2 / double-click (arrows move the caret) */
  mode: "enter" | "edit";
  fromBar?: boolean;
}

export function SheetView() {
  useT();
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  return page?.sheet ? <SheetGrid page={page} /> : null;
}

function SheetGrid({ page }: { page: Page }) {
  const pages = useStore((s) => s.doc.pages);
  const theme = useUI((s) => s.theme);
  const sh = page.sheet!;
  const pageId = page.id;
  const sel = useSheetUI((s) => s.sel[pageId]) ?? one(0, 0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState(() => views.get(pageId) ?? { x: 0, y: 0, zoom: sh?.zoom ?? 1 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [nameBox, setNameBox] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const drag = useRef<null | { kind: "cells" | "cols" | "rows" | "colSize" | "fill"; start: Sel; col?: number; x0?: number; w0?: number; ids?: number[] }>(null);
  const [fillTo, setFillTo] = useState<{ r0: number; c0: number; r1: number; c1: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const dlg = useSheetDlg((s) => s.dlg);
  const tabs = useMemo(() => bookPages({ pages } as never, page).filter((p) => !p.sheet!.hidden), [pages, page]);

  // per-page view restore / save
  useEffect(() => {
    const v = views.get(pageId) ?? { x: 0, y: 0, zoom: sh?.zoom ?? 1 };
    setView(v);
    setEditing(null);
    if (!useSheetUI.getState().sel[pageId] && sh) {
      const a = sh.active ? /^([A-Z]+\d+)/.exec(sh.active)?.[1] : null;
      const g = a ? parseRange(a) : null;
      setSel(pageId, g ? one(g.r0, g.c0) : one(sh.freeze?.rows ?? 0, sh.freeze?.cols ?? 0));
    }
    const w = wrapRef.current;
    if (w) {
      w.scrollLeft = v.x * v.zoom;
      w.scrollTop = v.y * v.zoom;
    }
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  useEffect(() => void views.set(pageId, view), [pageId, view]);

  // size of the viewport
  useLayoutEffect(() => {
    const w = wrapRef.current;
    if (!w) return;
    const ro = new ResizeObserver(() => setSize({ w: w.clientWidth, h: w.clientHeight }));
    ro.observe(w);
    setSize({ w: w.clientWidth, h: w.clientHeight });
    return () => ro.disconnect();
  }, []);

  const vrule = validationAt(sh, sel.ar, sel.ac);
  const paint: SheetPaintExtra = {
        width: size.w,
        height: size.h,
        zoom: view.zoom,
        scrollX: view.x,
        scrollY: view.y,
        headings: true,
        lang: lang(),
        sheets: tabs.map((p) => p.sheet!),
        sel: { g: norm(sel), ar: sel.ar, ac: sel.ac },
        editing: editing && !editing.fromBar ? editing.a : null,
        theme,
        fillTo,
        listArrow: !!vrule && vrule.type === "list" && !vrule.noDropdown && !(editing && !editing.fromBar),
      };

  // charts / pictures that become ready after the first paint repaint the grid
  const [, setDrawn] = useState(0);
  useEffect(() => onDrawingReady(() => setDrawn((n) => n + 1)), []);

  // draw
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(size.w * dpr)), H = Math.max(1, Math.round(size.h * dpr));
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintSheet(ctx, sh, paint);
  });

  // scroll extent: the used range plus a screen, growing as you go (an endless sheet)
  const extent = useMemo(() => {
    const g = geomOf(sh);
    const u = usedRange(sh);
    const L = panes(sh, { zoom: view.zoom, headings: true, scrollX: 0, scrollY: 0 });
    const w = Math.min(g.cols.pos(MAX_COL), Math.max(g.cols.pos(u.c1 + 1), view.x + g.cols.pos(L.fc)) - g.cols.pos(L.fc)) * view.zoom + size.w * 2;
    const h = Math.min(g.rows.pos(MAX_ROW), Math.max(g.rows.pos(u.r1 + 1), view.y + g.rows.pos(L.fr)) - g.rows.pos(L.fr)) * view.zoom + size.h * 2;
    return { w, h };
  }, [sh, view, size]);

  const onScroll = () => {
    const w = wrapRef.current!;
    setView((v) => ({ ...v, x: w.scrollLeft / v.zoom, y: w.scrollTop / v.zoom }));
  };

  /** Scroll so a cell is in view. */
  const reveal = useCallback(
    (r: number, c: number) => {
      const L = panes(sh, paint);
      const w = wrapRef.current!;
      const q = cellRect(sh, paint, r, c);
      if (c >= L.fc) {
        if (q.x < L.x0) w.scrollLeft += q.x - L.x0;
        else if (q.x + q.w > size.w - 16) w.scrollLeft += q.x + q.w - (size.w - 16);
      }
      if (r >= L.fr) {
        if (q.y < L.y0) w.scrollTop += q.y - L.y0;
        else if (q.y + q.h > size.h - 16) w.scrollTop += q.y + q.h - (size.h - 16);
      }
    },
    [sh, paint, size],
  );

  const g = norm(sel);
  const active = sh.cells[addr(sel.ar, sel.ac)];
  const merges = sh.merges.map(parseRange).filter((m): m is NonNullable<typeof m> => !!m);
  const mergeOf = (r: number, c: number) => merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);

  const select = (s: Sel, scroll = true) => {
    setSel(pageId, s);
    if (scroll) reveal(s.r1, s.c1);
  };

  const commitEdit = (move: [number, number] | null, keepFocus = true) => {
    if (!editing) return true;
    // data validation: an Excel-like message for input the rule does not allow
    const v = validationAt(sh, editing.r, editing.c);
    if (v?.showError && !passesValidation(S().doc.pages, sh, v, editing.text)) {
      const ed = editing;
      openDlg({
        kind: "invalid",
        v,
        retry: () => {
          setEditing({ ...ed, mode: "edit" });
          requestAnimationFrame(() => {
            editorRef.current?.focus({ preventScroll: true });
            editorRef.current?.select();
          });
        },
        cancel: cancelEdit,
        accept: () => {
          if (enterText(pageId, ed.r, ed.c, ed.text.replace(/\r\n/g, "\n"))) setEditing(null);
          requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
        },
      });
      return false;
    }
    const ok = enterText(pageId, editing.r, editing.c, editing.text.replace(/\r\n/g, "\n"));
    if (!ok) return false;
    setEditing(null);
    if (move) {
      const [dr, dc] = move;
      const m = mergeOf(editing.r, editing.c);
      const r = Math.min(MAX_ROW, Math.max(0, (dr > 0 && m ? m.r1 : editing.r) + dr)), c = Math.min(MAX_COL, Math.max(0, (dc > 0 && m ? m.c1 : editing.c) + dc));
      select(one(r, c));
    }
    if (keepFocus) requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
    return true;
  };
  const cancelEdit = () => {
    setEditing(null);
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
  };
  const startEdit = (mode: "enter" | "edit", text?: string, fromBar = false) => {
    const a = addr(sel.ar, sel.ac);
    setEditing({ a, r: sel.ar, c: sel.ac, text: text ?? editText(sh, active), mode, fromBar });
    if (!fromBar)
      requestAnimationFrame(() => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.focus({ preventScroll: true });
        const n = ed.value.length;
        ed.setSelectionRange(n, n);
      });
  };

  // ───── pointer ─────

  const pointAt = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** column whose right border is under x (heading drag) */
  const colBorderAt = (x: number, y: number): number | null => {
    const L = panes(sh, paint);
    if (y >= L.hh) return null;
    const h = hitCell(sh, paint, x, L.hh + 1);
    for (const c of [h.c - 1, h.c]) {
      if (c < 0) continue;
      const q = cellRect(sh, paint, 0, c);
      if (Math.abs(q.x + q.w - x) <= 4) return c;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = pointAt(e);
    // the scroll bars of the layer are not the grid
    if (x >= size.w || y >= size.h) return;
    // keep the keyboard on the cell editor (no focus change to the scroll layer)
    e.preventDefault();
    editorRef.current?.focus({ preventScroll: true });
    const h = hitCell(sh, paint, x, y);
    const border = colBorderAt(x, y);
    const cr = canvasRef.current!.getBoundingClientRect();
    // AutoFilter button, validation list arrow, fill handle
    const fb = !h.head ? filterButtonAt(sh, paint, x, y) : null;
    if (fb != null && (!editing || commitEdit(null))) {
      const b = filterButtonRect(sh, paint, fb);
      return openDlg({ kind: "filter", col: fb, x: cr.left + b.x, y: cr.top + b.y + b.h + 2 });
    }
    if (paint.listArrow) {
      const b = listArrowRect(sh, paint);
      const q = cellRect(sh, paint, sel.ar, sel.ac);
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return openDlg({ kind: "list", r: sel.ar, c: sel.ac, x: cr.left + q.x, y: cr.top + b.y + b.h + 1 });
    }
    if (!editing && onFillHandle(x, y)) {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { kind: "fill", start: sel };
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // a formula being typed: clicking a cell puts its reference in (Excel's point mode)
    if (editing && editing.text.startsWith("=") && !h.head && /[=(,+\-*/^&<>:]$/.test(editing.text.trimEnd())) {
      e.preventDefault();
      setEditing({ ...editing, text: editing.text + addr(h.r, h.c) });
      return;
    }
    if (editing && !commitEdit(null)) return;
    if (border != null) {
      const s = norm(sel);
      const ids = s.c0 <= border && border <= s.c1 && sel.r0 === 0 && sel.r1 === MAX_ROW ? Array.from({ length: s.c1 - s.c0 + 1 }, (_, i) => s.c0 + i) : [border];
      drag.current = { kind: "colSize", start: sel, col: border, x0: x, w0: geomOf(sh).cols.size(border), ids };
      S().beginGesture();
      return;
    }
    if (h.head === "corner") return select({ ar: 0, ac: 0, r0: 0, c0: 0, r1: MAX_ROW, c1: MAX_COL }, false);
    if (h.head === "col") {
      const s = e.shiftKey ? { ...sel, r0: 0, r1: MAX_ROW, c1: h.c } : { ar: 0, ac: h.c, r0: 0, c0: h.c, r1: MAX_ROW, c1: h.c };
      drag.current = { kind: "cols", start: s };
      return select(s, false);
    }
    if (h.head === "row") {
      const s = e.shiftKey ? { ...sel, c0: 0, c1: MAX_COL, r1: h.r } : { ar: h.r, ac: 0, r0: h.r, c0: 0, r1: h.r, c1: MAX_COL };
      drag.current = { kind: "rows", start: s };
      return select(s, false);
    }
    const s = e.shiftKey ? { ...sel, r1: h.r, c1: h.c } : one(h.r, h.c);
    drag.current = { kind: "cells", start: s };
    select(s, false);
    editorRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = pointAt(e);
    const cv = wrapRef.current!;
    cv.style.cursor = colBorderAt(x, y) != null || drag.current?.kind === "colSize" ? "col-resize" : drag.current?.kind === "fill" || (!drag.current && onFillHandle(x, y)) ? "crosshair" : y < panes(sh, paint).hh ? "s-resize" : x < panes(sh, paint).hw ? "e-resize" : filterButtonAt(sh, paint, x, y) != null ? "default" : "cell";
    const d = drag.current;
    if (!d) {
      // a note shows while the pointer is on its cell
      const hc = hitCell(sh, paint, x, y);
      const a = !hc.head ? addr(hc.r, hc.c) : null;
      const na = a && sh.notes?.[a] ? a : null;
      if (na !== hover) setHover(na);
      return;
    }
    if (d.kind === "fill") {
      const hc = hitCell(sh, paint, Math.max(0, x), Math.max(0, y));
      const s = norm(d.start);
      const down = hc.r - s.r1, up = s.r0 - hc.r, right = hc.c - s.c1, left = s.c0 - hc.c;
      const v = Math.max(down, up), hz = Math.max(right, left);
      let to: typeof fillTo = null;
      if (v > 0 && v >= hz) to = down > 0 ? { ...s, r1: hc.r } : { ...s, r0: hc.r };
      else if (hz > 0) to = right > 0 ? { ...s, c1: hc.c } : { ...s, c0: hc.c };
      if (JSON.stringify(to) !== JSON.stringify(fillTo)) setFillTo(to);
      return;
    }
    if (d.kind === "colSize") {
      const w = Math.max(0, Math.round(d.w0! + (x - d.x0!) / view.zoom));
      S().updateGesture((doc) => {
        const p = doc.pages.find((q) => q.id === pageId);
        if (p?.sheet) for (const c of d.ids!) p.sheet.colW[c] = w;
      });
      return;
    }
    const h = hitCell(sh, paint, Math.max(0, x), Math.max(0, y));
    if (d.kind === "cells") select({ ...d.start, r1: h.r, c1: h.c }, false);
    else if (d.kind === "cols") select({ ...d.start, c1: h.c }, false);
    else select({ ...d.start, r1: h.r }, false);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "colSize") S().endGesture(t("sheet.h.colWidth"));
    if (d?.kind === "fill") {
      setFillTo(null);
      if (fillTo) {
        fill(pageId, norm(d.start), fillTo, "auto", e.ctrlKey || e.metaKey);
        select({ ...d.start, r0: fillTo.r0, c0: fillTo.c0, r1: fillTo.r1, c1: fillTo.c1 }, false);
      }
    }
  };
  /** the small square at the selection's bottom-right corner */
  const onFillHandle = (x: number, y: number) => {
    const s = norm(sel);
    if (s.r1 === MAX_ROW && s.c1 === MAX_COL) return false;
    const q = cellRect(sh, paint, s.r0, s.c0, Math.min(s.r1, MAX_ROW), Math.min(s.c1, MAX_COL));
    return Math.abs(x - (q.x + q.w)) <= 5 && Math.abs(y - (q.y + q.h)) <= 5;
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = pointAt(e);
    const border = colBorderAt(x, y);
    if (border != null) return autoFit(border);
    const h = hitCell(sh, paint, x, y);
    if (h.head) return;
    select(one(h.r, h.c), false);
    setEditing({ a: addr(h.r, h.c), r: h.r, c: h.c, text: editText(sh, sh.cells[addr(h.r, h.c)]), mode: "edit" });
    requestAnimationFrame(() => {
      const ed = editorRef.current;
      ed?.focus({ preventScroll: true });
      ed?.setSelectionRange(ed.value.length, ed.value.length);
    });
  };
  const autoFit = (col: number) => {
    const cv = document.createElement("canvas").getContext("2d")!;
    let w = 0;
    for (const [a, cell] of Object.entries(sh.cells)) {
      const m = /^([A-Z]+)/.exec(a);
      if (!m || m[1] !== colLetters(col) || cell.v === undefined) continue;
      const st = sh.styles[cell.s ?? 0] ?? {};
      cv.font = `${st.italic ? "italic " : ""}${st.bold ? "bold " : ""}${((st.size ?? sh.baseSize) * 96) / 72}px "${st.font ?? sh.baseFont}"`;
      w = Math.max(w, cv.measureText(display(sh, cell, lang()).text).width);
    }
    setColWidth(pageId, [col], w ? Math.ceil(w + 7) : sh.defColW);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setView((v) => ({ ...v, zoom: Math.min(4, Math.max(0.1, Math.round((v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) * 100) / 100)) }));
  };

  // ───── keys ─────

  const move = (dr: number, dc: number, extend: boolean, jump: boolean) => {
    const fromR = extend ? sel.r1 : sel.ar, fromC = extend ? sel.c1 : sel.ac;
    let to = jump ? dataEdge(sh, fromR, fromC, dr, dc) : { r: fromR + dr, c: fromC + dc };
    // skip hidden rows / columns
    const gm = geomOf(sh);
    while (dr && to.r > 0 && to.r < MAX_ROW && gm.rows.size(to.r) === 0) to = { ...to, r: to.r + dr };
    while (dc && to.c > 0 && to.c < MAX_COL && gm.cols.size(to.c) === 0) to = { ...to, c: to.c + dc };
    // leaving a merged cell goes past its far edge
    const m = !extend && mergeOf(sel.ar, sel.ac);
    if (m && !jump) to = { r: dr > 0 ? m.r1 + 1 : dr < 0 ? m.r0 - 1 : sel.ar, c: dc > 0 ? m.c1 + 1 : dc < 0 ? m.c0 - 1 : sel.ac };
    const r = Math.min(MAX_ROW, Math.max(0, to.r)), c = Math.min(MAX_COL, Math.max(0, to.c));
    select(extend ? { ...sel, r1: r, c1: c } : one(r, c));
  };

  const switchSheet = (dir: number) => {
    const i = tabs.findIndex((p) => p.id === pageId);
    const next = tabs[i + dir];
    if (next) S().set({ pageId: next.id });
  };


  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.nativeEvent.isComposing) return;
    // Excel's meaning wins in a sheet (docs/design/EDIT_MODES.md §7)
    if (ctrl && (k === "PageUp" || k === "PageDown")) {
      stop();
      if (editing) commitEdit(null);
      return switchSheet(k === "PageUp" ? -1 : 1);
    }
    if (ctrl && e.shiftKey && NUMBER_KEYS[e.code]) {
      stop();
      if (editing) commitEdit(null);
      return applyNumberFormat(NUMBER_KEYS[e.code]);
    }
    if (editing) {
      if (k === "Enter" && !e.altKey) {
        stop();
        return void commitEdit(e.shiftKey ? [-1, 0] : [1, 0]);
      }
      if (k === "Enter" && e.altKey) {
        stop();
        const ed = e.currentTarget;
        const at = ed.selectionStart;
        const text = editing.text.slice(0, at) + "\n" + editing.text.slice(ed.selectionEnd);
        setEditing({ ...editing, text });
        requestAnimationFrame(() => ed.setSelectionRange(at + 1, at + 1));
        return;
      }
      if (k === "Tab") {
        stop();
        return void commitEdit(e.shiftKey ? [0, -1] : [0, 1]);
      }
      if (k === "Escape") {
        stop();
        return cancelEdit();
      }
      if (k === "F2") {
        stop();
        return setEditing({ ...editing, mode: editing.mode === "edit" ? "enter" : "edit" });
      }
      if (editing.mode === "enter" && /^Arrow/.test(k) && !(editing.text.startsWith("="))) {
        stop();
        const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[k] as [number, number];
        return void commitEdit(d);
      }
      e.stopPropagation();
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    // Alt+Down: the validation list, or the AutoFilter menu on a filter heading
    if (e.altKey && k === "ArrowDown") {
      stop();
      const cr = canvasRef.current!.getBoundingClientRect();
      if (paint.listArrow) {
        const q = cellRect(sh, paint, sel.ar, sel.ac);
        return openDlg({ kind: "list", r: sel.ar, c: sel.ac, x: cr.left + q.x, y: cr.top + q.y + q.h + 1 });
      }
      const f = sh.filter && parseRange(sh.filter.ref);
      if (f && sel.ar === f.r0 && sel.ac >= f.c0 && sel.ac <= f.c1) {
        const b = filterButtonRect(sh, paint, sel.ac - f.c0);
        return openDlg({ kind: "filter", col: sel.ac - f.c0, x: cr.left + b.x, y: cr.top + b.y + b.h + 2 });
      }
      return;
    }
    if (arrows[k]) {
      stop();
      return move(arrows[k][0], arrows[k][1], e.shiftKey, ctrl);
    }
    if (k === "Tab" || k === "Enter") {
      stop();
      const back = e.shiftKey;
      const d: [number, number] = k === "Tab" ? [0, back ? -1 : 1] : [back ? -1 : 1, 0];
      // inside a selected range, Enter / Tab walk through it
      if (g.r0 !== g.r1 || g.c0 !== g.c1) {
        let r = sel.ar + d[0], c = sel.ac + d[1];
        if (c > g.c1) [r, c] = [r + 1, g.c0];
        if (c < g.c0) [r, c] = [r - 1, g.c1];
        if (r > g.r1) [r, c] = [g.r0, c + (k === "Enter" ? 1 : 0)];
        if (r < g.r0) [r, c] = [g.r1, c];
        if (c > g.c1) c = g.c0;
        return select({ ...sel, ar: r, ac: c }, true);
      }
      return move(d[0], d[1], false, false);
    }
    if (k === "Home") {
      stop();
      const r = ctrl ? sh.freeze?.rows ?? 0 : sel.ar;
      return select(one(r, ctrl ? sh.freeze?.cols ?? 0 : 0));
    }
    if (k === "End" && ctrl) {
      stop();
      const u = usedRange(sh);
      return select(one(Math.max(0, u.r1), Math.max(0, u.c1)));
    }
    if (k === "PageDown" || k === "PageUp") {
      stop();
      const rows = Math.max(1, Math.floor(size.h / (sh.defRowH * view.zoom)) - 2);
      return move(k === "PageDown" ? rows : -rows, 0, e.shiftKey, false);
    }
    if (k === "F2" && e.shiftKey) {
      stop();
      if (sh.notes?.[addr(sel.ar, sel.ac)]?.threaded) return S().notify(t("sheet.note.threaded"));
      return openDlg({ kind: "note", a: addr(sel.ar, sel.ac) });
    }
    if (k === "F2") {
      stop();
      return startEdit("edit");
    }
    // Ctrl++ / Ctrl+- (insert / delete), Ctrl+D / Ctrl+R (fill), Ctrl+Shift+L (filter), Ctrl+F / Ctrl+H (find)
    if (ctrl && !e.altKey && (k === "+" || e.code === "NumpadAdd" || (e.shiftKey && e.code === "Equal"))) return stop(), void insertOrDelete(pageId, false);
    if (ctrl && !e.altKey && (k === "-" || e.code === "NumpadSubtract" || e.code === "Minus")) return stop(), void insertOrDelete(pageId, true);
    if (ctrl && !e.shiftKey && !e.altKey && (e.code === "KeyD" || e.code === "KeyR")) return stop(), fillDir(pageId, e.code === "KeyD" ? "down" : "right");
    if (ctrl && e.shiftKey && !e.altKey && e.code === "KeyL") return stop(), toggleFilter(pageId);
    if (ctrl && !e.shiftKey && !e.altKey && (e.code === "KeyF" || e.code === "KeyH")) return stop(), openDlg({ kind: "find", replace: e.code === "KeyH" });
    if (k === "Delete") {
      stop();
      return clearRange(pageId, g);
    }
    if (k === "Backspace") {
      stop();
      clearRange(pageId, { r0: sel.ar, c0: sel.ac, r1: sel.ar, c1: sel.ac });
      return startEdit("enter", "");
    }
    if (k === "Escape") {
      stop();
      return;
    }
    if (ctrl && !e.shiftKey && !e.altKey) {
      const toggle = (key: "bold" | "italic" | "strike") => {
        const on = !styleAt(sh, sel.ar, sel.ac)[key];
        formatRange(pageId, g, (st) => ({ ...st, [key]: on }));
      };
      if (e.code === "KeyB") return stop(), toggle("bold");
      if (e.code === "KeyI") return stop(), toggle("italic");
      if (e.code === "Digit5") return stop(), toggle("strike");
      if (e.code === "KeyU") {
        stop();
        const on = !styleAt(sh, sel.ar, sel.ac).underline;
        return formatRange(pageId, g, (st) => ({ ...st, underline: on ? "single" : undefined }));
      }
      if (e.code === "KeyA") return stop(), select({ ar: sel.ar, ac: sel.ac, r0: 0, c0: 0, r1: MAX_ROW, c1: MAX_COL }, false);
      if (e.code === "Semicolon") {
        stop();
        const d = new Date();
        return startEdit("enter", lang() === "en" ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }
      if (e.code === "KeyC" || e.code === "KeyX") {
        stop();
        const { text, html } = copyRange(pageId, g);
        writeClipboard(text, html);
        if (e.code === "KeyX") clearRange(pageId, g);
        return;
      }
      if (e.code === "KeyV") {
        e.stopPropagation(); // the paste event follows on this editor
        return;
      }
      if (e.code === "Space") return stop(), select({ ...sel, r0: 0, r1: MAX_ROW }, false);
    }
    if (e.altKey && (k === "=" || e.code === "Equal")) {
      stop();
      return startEdit("enter", autoSumFormula(sh, sel.ar, sel.ac));
    }
    if (ctrl || e.altKey) return; // Ctrl+Z, Ctrl+S, … go to the app
    // a printable key starts typing over the cell (the input event of this editor does it, IME included)
    e.stopPropagation();
  };

  const onEditorInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const text = e.currentTarget.value;
    if (editing && !editing.fromBar) return setEditing({ ...editing, text });
    // typing over the active cell
    setEditing({ a: addr(sel.ar, sel.ac), r: sel.ar, c: sel.ac, text, mode: "enter" });
  };
  const onCompositionStart = () => {
    if (!editing) setEditing({ a: addr(sel.ar, sel.ac), r: sel.ar, c: sel.ac, text: "", mode: "enter" });
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const html = e.clipboardData.getData("text/html");
    const area = paste(pageId, { r: sel.ar, c: sel.ac }, text, html);
    if (area) select({ ar: sel.ar, ac: sel.ac, r0: area.r0, c0: area.c0, r1: area.r1, c1: area.c1 }, false);
  };
  const onCopy = (e: React.ClipboardEvent, cut = false) => {
    if (editing) return;
    e.preventDefault();
    const { text, html } = copyRange(pageId, g);
    e.clipboardData.setData("text/plain", text);
    e.clipboardData.setData("text/html", html);
    if (cut) clearRange(pageId, g);
  };

  // ───── editor placement ─────

  const em = editing && !editing.fromBar ? mergeOf(editing.r, editing.c) : null;
  const eq = editing && !editing.fromBar ? (em ? cellRect(sh, paint, em.r0, em.c0, em.r1, em.c1) : cellRect(sh, paint, editing.r, editing.c)) : cellRect(sh, paint, sel.ar, sel.ac);
  const est = styleAt(sh, editing?.r ?? sel.ar, editing?.c ?? sel.ac);
  const editorStyle: React.CSSProperties = editing && !editing.fromBar
    ? {
        left: eq.x,
        top: eq.y,
        minWidth: eq.w,
        minHeight: eq.h,
        width: Math.max(eq.w, Math.min(size.w - eq.x - 4, (editing.text.length + 2) * ((((est.size ?? sh.baseSize) * 96) / 72) * view.zoom) * 0.62)),
        font: `${est.italic ? "italic " : ""}${est.bold ? "bold " : ""}${(((est.size ?? sh.baseSize) * 96) / 72) * view.zoom}px "${est.font ?? sh.baseFont}", "맑은 고딕", sans-serif`, // i18n: keep — font names
        color: est.color ?? "#000",
        background: est.fill ?? "#fff",
        textAlign: est.h === "center" ? "center" : est.h === "right" ? "right" : "left",
      }
    : { left: Math.max(0, eq.x), top: Math.max(0, eq.y), width: 4, height: 4 };

  // ───── status: sum / count / average of the selection ─────

  const stats = useMemo(() => {
    if (g.r0 === g.r1 && g.c0 === g.c1) return null;
    let n = 0, cnt = 0, sum = 0;
    for (const [a, cell] of Object.entries(sh.cells)) {
      const p = /^([A-Z]+)(\d+)$/.exec(a);
      if (!p || cell.v === undefined || cell.v === "") continue;
      const r = Number(p[2]) - 1;
      if (r < g.r0 || r > g.r1) continue;
      const pc = parseRange(a)!.c0;
      if (pc < g.c0 || pc > g.c1) continue;
      cnt++;
      if (typeof cell.v === "number" && cell.t !== "e") {
        n++;
        sum += cell.v;
      }
    }
    if (!cnt) return null;
    return { n, cnt, sum: Number(sum.toPrecision(15)), avg: n ? Number((sum / n).toPrecision(15)) : null };
  }, [sh, g.r0, g.r1, g.c0, g.c1]);
  const fmtStat = (v: number) => display(sh, { v, s: sh.cells[addr(sel.ar, sel.ac)]?.s }, lang()).text || String(v);

  // where a note shows: beside the top-right corner of its cell
  const noteAt = dlg?.kind === "note" ? dlg.a : hover;
  const noteBox = (() => {
    const g0 = noteAt ? parseRange(noteAt) : null;
    if (!g0) return null;
    const m = mergeOf(g0.r0, g0.c0);
    const q = m ? cellRect(sh, paint, m.r0, m.c0, m.r1, m.c1) : cellRect(sh, paint, g0.r0, g0.c0);
    return { x: Math.max(0, Math.min(size.w - 200, q.x + q.w + 8)), y: Math.max(0, q.y - 4) };
  })();

  const barText = editing ? editing.text : editText(sh, active);
  const nameText = nameBox ?? (g.r0 === g.r1 && g.c0 === g.c1 ? addr(sel.ar, sel.ac) : mergeOf(sel.ar, sel.ac) && rangeText(mergeOf(sel.ar, sel.ac)!) === rangeText(g) ? addr(sel.ar, sel.ac) : `${g.r1 - g.r0 + 1}R x ${g.c1 - g.c0 + 1}C`);

  const goName = (text: string) => {
    const s = text.trim().toUpperCase().replace(/\$/g, "");
    const r = parseRange(s);
    setNameBox(null);
    if (r) select({ ar: r.r0, ac: r.c0, r0: r.r0, c0: r.c0, r1: r.r1, c1: r.c1 });
    editorRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="sheet-view" data-theme-sheet={theme}>
      <div className="sheet-bar">
        <input
          className="sheet-namebox"
          aria-label={t("sheet.nameBox")}
          data-tip={t("sheet.nameBox")}
          value={nameText}
          onFocus={(e) => {
            setNameBox(addr(sel.ar, sel.ac));
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setNameBox(e.target.value)}
          onBlur={() => setNameBox(null)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") goName(e.currentTarget.value);
            if (e.key === "Escape") {
              setNameBox(null);
              editorRef.current?.focus();
            }
          }}
        />
        <span className="sheet-fx" aria-hidden>
          <i>fx</i>
        </span>
        <input
          ref={barRef}
          className="sheet-formula"
          aria-label={t("sheet.formulaBar")}
          value={barText}
          spellCheck={false}
          onFocus={() => {
            if (!editing) startEdit("edit", undefined, true);
            else setEditing({ ...editing, fromBar: true });
          }}
          onChange={(e) => setEditing((ed) => (ed ? { ...ed, text: e.target.value } : { a: addr(sel.ar, sel.ac), r: sel.ar, c: sel.ac, text: e.target.value, mode: "edit", fromBar: true }))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit([e.shiftKey ? -1 : 1, 0]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            } else if (e.key === "Tab") {
              e.preventDefault();
              commitEdit([0, e.shiftKey ? -1 : 1]);
            }
          }}
          onBlur={() => {
            if (editing?.fromBar) commitEdit(null, false);
          }}
        />
      </div>
      <div className="sheet-body">
        <canvas ref={canvasRef} className="sheet-canvas" style={{ width: size.w, height: size.h }} />
        {/* the scroll layer over the canvas: native scroll bars, and the pointer events of the grid */}
        <div
          className="sheet-scroll"
          ref={wrapRef}
          onScroll={onScroll}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => {
            e.preventDefault();
            if (editing && !commitEdit(null)) return;
            const { x, y } = pointAt(e);
            const h = hitCell(sh, paint, x, y);
            const g0 = norm(sel);
            const inside = h.r >= g0.r0 && h.r <= g0.r1 && h.c >= g0.c0 && h.c <= g0.c1;
            const head = h.head === "col" || h.head === "row" ? h.head : null;
            if (!inside && h.head !== "corner")
              select(head === "col" ? { ar: 0, ac: h.c, r0: 0, c0: h.c, r1: MAX_ROW, c1: h.c } : head === "row" ? { ar: h.r, ac: 0, r0: h.r, c0: 0, r1: h.r, c1: MAX_COL } : one(h.r, h.c), false);
            const wholeCols = inside ? g0.r0 === 0 && g0.r1 === MAX_ROW : head === "col";
            const wholeRows = inside ? g0.c0 === 0 && g0.c1 === MAX_COL : head === "row";
            openDlg({ kind: "menu", x: e.clientX, y: e.clientY, head: wholeCols && !wholeRows ? "col" : wholeRows && !wholeCols ? "row" : null });
          }}
          onPointerLeave={() => setHover(null)}
        >
          <div className="sheet-spacer" style={{ width: extent.w, height: extent.h }} />
        </div>
        <textarea
          ref={editorRef}
          className={cx("sheet-editor", editing && !editing.fromBar && "on")}
          style={editorStyle}
          value={editing && !editing.fromBar ? editing.text : ""}
          spellCheck={false}
          aria-label={`${sh.name} ${addr(sel.ar, sel.ac)}`}
          onChange={onEditorInput}
          onCompositionStart={onCompositionStart}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCopy={(e) => onCopy(e)}
          onCut={(e) => onCopy(e, true)}
          onBlur={() => {
            if (editing && !editing.fromBar && document.activeElement !== barRef.current && !useSheetDlg.getState().dlg) commitEdit(null, false);
          }}
        />
        {noteBox && dlg?.kind === "note" && <NoteEditor key={dlg.a} page={page} a={dlg.a} box={noteBox} onDone={() => (openDlg(null), editorRef.current?.focus({ preventScroll: true }))} />}
        {noteBox && hover && dlg?.kind !== "note" && sh.notes?.[hover] && <NoteTip text={sh.notes[hover].text} author={sh.notes[hover].author} box={noteBox} />}
        <SheetDialogs page={page} refocus={() => requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))} />
      </div>
      <div className="sheet-tabs" role="tablist" aria-label={t("sheet.tabs")}>
        <button type="button" className="sheet-tab-nav" aria-label="◀" onClick={() => switchSheet(-1)}>
          ◀
        </button>
        <button type="button" className="sheet-tab-nav" aria-label="▶" onClick={() => switchSheet(1)}>
          ▶
        </button>
        <div className="sheet-tab-list">
          {tabs.map((p: Page) =>
            renaming === p.id ? (
              <input
                key={p.id}
                className="sheet-tab-rename"
                autoFocus
                defaultValue={p.sheet!.name}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && renameSheet(p.id, e.currentTarget.value)) setRenaming(null);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={(e) => {
                  renameSheet(p.id, e.currentTarget.value);
                  setRenaming(null);
                }}
              />
            ) : (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === pageId}
                className={cx("sheet-tab", p.id === pageId && "on")}
                style={p.sheet!.tabColor ? ({ ["--tab-color" as string]: p.sheet!.tabColor } as React.CSSProperties) : undefined}
                data-tip={t("sheet.renameTip")}
                onClick={() => {
                  if (editing) commitEdit(null, false);
                  S().set({ pageId: p.id });
                }}
                onDoubleClick={() => setRenaming(p.id)}
              >
                {p.sheet!.name}
              </button>
            ),
          )}
          <button type="button" className="sheet-tab-add" aria-label={t("sheet.addSheet")} data-tip={t("sheet.addSheet")} onClick={() => addSheet(pageId)}>
            +
          </button>
        </div>
        <div className="sheet-stats" aria-live="polite">
          {stats && (
            <>
              {stats.avg != null && (
                <span>
                  {t("sheet.stat.avg")}: {fmtStat(stats.avg)}
                </span>
              )}
              <span>
                {t("sheet.stat.count")}: {stats.cnt}
              </span>
              {stats.n > 0 && (
                <span>
                  {t("sheet.stat.sum")}: {fmtStat(stats.sum)}
                </span>
              )}
            </>
          )}
          <span className="sheet-zoom" data-tip={t("sheet.zoom")} onDoubleClick={() => setView((v) => ({ ...v, zoom: 1 }))}>
            {Math.round(view.zoom * 100)}%
          </span>
        </div>
      </div>
    </div>
  );
}

function writeClipboard(text: string, html: string) {
  try {
    const C = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (C && navigator.clipboard?.write) {
      void navigator.clipboard.write([new C({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]).catch(() => navigator.clipboard?.writeText(text));
      return;
    }
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard not available */
  }
}

/** Whether the current page is shown as a sheet grid. */
export const isSheetPage = () => !!currentPage()?.sheet;
