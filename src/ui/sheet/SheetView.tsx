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
import { filterOf, sheetFilters } from "../../io/sheet/filters";
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
import { isAppChord } from "../appKeys";
import { calcNow, copySelection, scrollSplit, enterTextAll, fitRowHeights, forgetCopy, paintFormats, rememberCopy, repeatLast, selOf, setRepeat, useCalcPending, useFormatPainter, useSheetClip } from "./sheetActions";
import { currentRegion } from "../../io/sheet/sortFilter";
import type { SheetAnchor, SheetData, SheetSlicer } from "../../core/sheetTypes";
import { drawingBox } from "../../render/sheetDrawings";
import { fnArgs, openCall } from "../../io/sheet/fnSigs";
import { FUNCTIONS } from "../../io/sheet/functions";
import { addWatch, useWatch } from "./sheetFeatures";
import { deleteSlicer, moveSlicer, outlineGroups, pickSlicer, setGroupShown, showLevel, slicerState } from "./sheetFeatures";
import { absRef, defineName, deleteDrawing, hideLines, deleteSheet, flashFill, followLink, goTo, groupLines, hideSheet, moveSheet, setTabColor, lockedAt, mayEdit, pickChart, toggleFormulas, useCellCmd, useChartSel, useGridView, useTrace } from "./sheetFeatures";

/** F4 on a reference: A1 → $A$1 → A$1 → $A1 → A1. */
export function cycleRef(ref: string): string {
  return ref.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (_m, a: string, col: string, b: string, row: string) => {
    const k = (a ? 2 : 0) + (b ? 1 : 0); // 0 A1, 3 $A$1, 1 A$1, 2 $A1
    const next = k === 0 ? 3 : k === 3 ? 1 : k === 1 ? 2 : 0;
    return `${next & 2 ? "$" : ""}${col}${next & 1 ? "$" : ""}${row}`;
  });
}

/** The reference around a caret position in a formula (F4): its span, or null. */
export function refAt(text: string, at: number): { start: number; end: number } | null {
  const re = /(?:'[^']+'|[A-Za-z_][\w.]*)?!?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/g;
  let best: { start: number; end: number } | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // a sheet prefix is not cycled: only from the column letters on
    const bang = m[0].lastIndexOf("!");
    const start = m.index + (bang >= 0 ? bang + 1 : 0), end = m.index + m[0].length;
    if (start <= at && at <= end) return { start, end };
    if (end <= at) best = { start, end };
  }
  return best;
}

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

const NO_ARROWS: never[] = [];

const OL_STEP = 15;

/**
 * Excel's outline bar beside the row headings (and over the column headings): the level buttons 1 2 3 …, a bracket
 * along each group and its − button on the summary line after it (+ when the group is folded). Clicking folds /
 * unfolds; a level button shows that many levels.
 */
function OutlineBar({ pageId, sh, paint, size, gw, gh }: { pageId: string; sh: SheetData; paint: SheetPaintExtra; size: { w: number; h: number }; gw: number; gh: number }) {
  const t = useT();
  const L = panes(sh, paint);
  const out: React.ReactNode[] = [];
  for (const axis of ["row", "col"] as const) {
    const levels = axis === "row" ? sh.rowLevel : sh.colLevel;
    if (!levels || !Object.keys(levels).length) continue;
    const max = Math.max(...Object.values(levels as Record<number, number>));
    const hidden = new Set(axis === "row" ? (sh.hiddenRows ?? []) : (sh.hiddenCols ?? []));
    // level buttons: in the corner of the bar
    for (let n = 1; n <= max + 1; n++) {
      const style: React.CSSProperties = axis === "row" ? { left: -gw + (n - 1) * OL_STEP + 2, top: Math.max(0, (L.hh - 14) / 2) } : { left: Math.max(0, (L.hw - 14) / 2), top: -gh + (n - 1) * OL_STEP + 2 };
      out.push(
        <button key={`${axis}-lv-${n}`} type="button" className="sheet-ol-level" style={style} aria-label={t("sheetx.outline.level", { n })} onClick={() => showLevel(pageId, axis, n)}>
          {n}
        </button>,
      );
    }
    const pos = (i: number) => {
      const q = axis === "row" ? cellRect(sh, paint, i, 0) : cellRect(sh, paint, 0, i);
      return axis === "row" ? { at: q.y, len: q.h } : { at: q.x, len: q.w };
    };
    const lim = axis === "row" ? size.h : size.w;
    const head = axis === "row" ? L.hh : L.hw;
    for (const grp of outlineGroups(levels)) {
      const a = pos(grp.a), b = pos(grp.b), s = pos(grp.b + 1);
      const folded = Array.from({ length: Math.min(grp.b - grp.a + 1, 100000) }, (_, k) => hidden.has(grp.a + k)).every(Boolean);
      const lane = (grp.level - 1) * OL_STEP + OL_STEP / 2 + 2;
      if (s.at + s.len < head && b.at + b.len < head) continue;
      if (a.at > lim) continue;
      if (!folded) {
        const from = Math.max(head, a.at + 2), to = Math.min(lim, b.at + b.len);
        if (to > from)
          out.push(
            <span
              key={`${axis}-br-${grp.level}-${grp.a}`}
              className={`sheet-ol-bracket sheet-ol-${axis}`}
              style={axis === "row" ? { left: -gw + lane, top: from, height: to - from } : { top: -gh + lane, left: from, width: to - from }}
            />,
          );
      }
      const mid = s.at + s.len / 2;
      if (mid < head || mid > lim) continue;
      out.push(
        <button
          key={`${axis}-bt-${grp.level}-${grp.a}`}
          type="button"
          className="sheet-ol-toggle"
          style={axis === "row" ? { left: -gw + lane - 6, top: mid - 6 } : { top: -gh + lane - 6, left: mid - 6 }}
          aria-label={t(folded ? "sheetx.detail.show" : "sheetx.detail.hide")}
          aria-expanded={!folded}
          onClick={() => setGroupShown(pageId, axis, grp.a, grp.b, folded)}
        >
          {folded ? "+" : "−"}
        </button>,
      );
    }
  }
  return <>{out}</>;
}

/**
 * A slicer on the grid (Excel's): its caption, 다중 선택 and 필터 지우기, and an item button per value — a click picks
 * that item alone, Ctrl+click (or 다중 선택) adds / removes one; the header drags it, Delete removes it.
 */
function SlicerBox({ pageId, s, box, zoom, cellAt }: { pageId: string; s: SheetSlicer; box: { x: number; y: number; w: number; h: number }; zoom: number; cellAt: (x: number, y: number) => { r: number; c: number; x: number; y: number } }) {
  const t = useT();
  useStore((st) => st.doc);
  const [multi, setMulti] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number; x0: number; y0: number } | null>(null);
  const state = slicerState(pageId, s);
  if (!state) return null;
  const picked = state.picked;
  const isOn = (v: string) => !picked || picked.has(v);
  const click = (v: string, add: boolean) => {
    if (add || multi) {
      const cur = new Set(picked ?? state.items);
      cur.has(v) ? cur.delete(v) : cur.add(v);
      pickSlicer(pageId, s, cur.size === state.items.length ? null : [...cur]);
    } else pickSlicer(pageId, s, [v]);
  };
  const left = box.x + (drag?.dx ?? 0), top = box.y + (drag?.dy ?? 0);
  return (
    <div
      className="sx-slicer"
      role="group"
      aria-label={s.caption}
      tabIndex={0}
      style={{ left, top, width: box.w, height: box.h, fontSize: Math.max(9, 12 * zoom) }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Delete" && e.target === e.currentTarget) deleteSlicer(pageId, s.name);
      }}
    >
      <div
        className="sx-slicer-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          (e.currentTarget.parentElement as HTMLElement).focus();
          setDrag({ dx: 0, dy: 0, x0: e.clientX, y0: e.clientY });
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 })}
        onPointerUp={() => {
          if (!drag) return;
          if (Math.abs(drag.dx) + Math.abs(drag.dy) > 3) {
            const at = cellAt(left, top);
            moveSlicer(pageId, s.name, { c0: at.c, x0: at.x / zoom, r0: at.r, y0: at.y / zoom, w: box.w / zoom, h: box.h / zoom });
          }
          setDrag(null);
        }}
      >
        <span className="sx-slicer-cap">{s.caption}</span>
        <button type="button" className={cx("sx-slicer-tool", multi && "on")} aria-pressed={multi} aria-label={t("sheetx.slicer.multi")} data-tip={t("sheetx.slicer.multi")} onClick={() => setMulti(!multi)}>
          ☰
        </button>
        <button type="button" className="sx-slicer-tool" disabled={!picked} aria-label={t("sheetx.slicer.clear")} data-tip={t("sheetx.slicer.clear")} onClick={() => pickSlicer(pageId, s, null)}>
          ⨯
        </button>
      </div>
      <div className="sx-slicer-items">
        {state.items.map((v) => (
          <button key={v} type="button" className={cx("sx-slicer-item", isOn(v) && "on")} aria-pressed={isOn(v)} onClick={(e) => click(v, e.ctrlKey || e.metaKey)}>
            {v === "" ? t("sheetx.pivot.blank") : v}
          </button>
        ))}
      </div>
    </div>
  );
}

const TAB_COLORS = ["#C00000", "#FF0000", "#FFC000", "#FFFF00", "#92D050", "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0"];

/** The sheet tab's menu (Excel's right-click on a tab): 삽입 · 삭제 · 이름 바꾸기 · 이동 · 탭 색 · 숨기기 · 숨기기 취소. */
/** 조사식 창: the cells watched, with their sheet, value and formula, live; 조사식 추가 takes the selection. */
function WatchPanel({ pageId }: { pageId: string }) {
  const t = useT();
  const { open, items } = useWatch();
  const doc = useStore((s) => s.doc);
  const [pick, setPick] = useState<number | null>(null);
  if (!open) return null;
  return (
    <div className="sx-watch" role="dialog" aria-label={t("sheetx.watch.title")} onKeyDown={(e) => e.stopPropagation()}>
      <div className="sx-watch-head">
        <b>{t("sheetx.watch.title")}</b>
        <button type="button" className="btn btn-ghost" onClick={() => addWatch(pageId)}>
          {t("sheetx.watch.add")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={pick == null} onClick={() => (useWatch.setState({ items: items.filter((_, k) => k !== pick) }), setPick(null))}>
          {t("sheetx.watch.del")}
        </button>
        <button type="button" className="btn btn-ghost" aria-label={t("sheetx.eval.close")} onClick={() => useWatch.setState({ open: false })}>
          ×
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>{t("sheetx.watch.sheet")}</th>
            <th>{t("sheetx.watch.cell")}</th>
            <th>{t("sheetx.watch.value")}</th>
            <th>{t("sheetx.watch.formula")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w, k) => {
            const sh = doc.pages.find((p) => p.id === w.pageId)?.sheet;
            const cell = sh?.cells[w.a];
            return (
              <tr key={`${w.pageId}${w.a}`} className={cx(pick === k && "on")} onClick={() => setPick(k)}>
                <td>{sh?.name ?? ""}</td>
                <td>{w.a}</td>
                <td>{sh ? display(sh, cell ?? {}, lang()).text : ""}</td>
                <td>{cell?.f ? "=" + cell.f : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TabMenu({ at, onRename, onClose }: { at: { id: string; x: number; y: number }; onRename: () => void; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const doc = useStore((s) => s.doc);
  const page = doc.pages.find((p) => p.id === at.id);
  // the menu opens upward from the tab, as tall as it is (kept on screen)
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(8, Math.min(at.y - h, window.innerHeight - h - 8)));
  }, [at.y]);
  useEffect(() => {
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("pointerdown", off, true);
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => window.removeEventListener("pointerdown", off, true);
  }, [onClose]);
  if (!page?.sheet) return null;
  const hidden = bookPages(doc, page).filter((p) => p.sheet!.hidden);
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  const item = (label: string, f: () => void, disabled = false) => (
    <button type="button" role="menuitem" className="menu-item" disabled={disabled} onClick={run(f)}>
      <span className="menu-label">{label}</span>
    </button>
  );
  const del = () => {
    const sh = page.sheet!;
    if (Object.keys(sh.cells).length && typeof confirm === "function" && !confirm(t("sheetx.tab.deleteAsk"))) return;
    deleteSheet(at.id);
  };
  return (
    <div ref={ref} className="menu-pop sx-tabmenu" role="menu" style={{ position: "fixed", left: at.x, top: top ?? Math.max(8, at.y - 300), maxHeight: `calc(100vh - 16px)`, overflowY: "auto" }} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && onClose())}>
      {item(t("sheetx.tab.insert"), () => addSheet(at.id))}
      {item(t("sheetx.tab.delete"), del)}
      {item(t("sheetx.tab.rename"), onRename)}
      {item(t("sheetx.tab.moveLeft"), () => moveSheet(at.id, -1))}
      {item(t("sheetx.tab.moveRight"), () => moveSheet(at.id, 1))}
      {item(t("sheetx.mc.menu"), () => openDlg({ kind: "moveCopy", pageId: at.id }))}
      <div className="menu-sep" role="separator" />
      <div className="sx-tabcolors" role="group" aria-label={t("sheetx.tab.color")}>
        <span className="menu-label">{t("sheetx.tab.color")}</span>
        <span className="sx-swatches">
          {TAB_COLORS.map((c) => (
            <button key={c} type="button" role="menuitem" className="sx-swatch" style={{ background: c }} aria-label={`${t("sheetx.tab.color")} ${c}`} onClick={run(() => setTabColor(at.id, c))} />
          ))}
          <button type="button" role="menuitem" className="sx-swatch sx-swatch-none" aria-label={t("sheetx.tab.noColor")} onClick={run(() => setTabColor(at.id, null))} />
        </span>
      </div>
      <div className="menu-sep" role="separator" />
      {item(t("sheetx.tab.hide"), () => hideSheet(at.id, true))}
      {hidden.map((p) => item(`${t("sheetx.tab.unhide")}: ${p.sheet!.name}`, () => hideSheet(p.id, false)))}
      {!hidden.length && item(t("sheetx.tab.unhide"), () => {}, true)}
    </div>
  );
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
  const barRef = useRef<HTMLTextAreaElement>(null);
  /** a range being dragged out with the mouse (the name box shows its size meanwhile) */
  const [sizing, setSizing] = useState(false);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState(() => views.get(pageId) ?? { x: 0, y: 0, zoom: sh?.zoom ?? 1 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [nameBox, setNameBox] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  /** the column a run of Tabs began in (Enter goes back under it) */
  const tabFrom = useRef<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<null | { kind: "cells" | "cols" | "rows" | "colSize" | "rowSize" | "fill" | "ref" | "chartMove" | "chartSize"; start: Sel; col?: number; x0?: number; w0?: number; ids?: number[]; y0?: number; i?: number; at0?: SheetAnchor; box0?: { x: number; y: number; w: number; h: number } }>(null);
  /** the reference a click / drag put into the formula being typed (Excel's point mode): where it is in the text */
  const refPoint = useRef<{ start: number; end: number; r: number; c: number; pr?: number; pc?: number } | null>(null);
  const chartSel = useChartSel((s) => (s.pageId === pageId ? s.i : -1));
  const gridView = useGridView();
  const cellCmd = useCellCmd((s) => s.edit);
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
  const clip = useSheetClip((s) => s.clip);
  const paint: SheetPaintExtra = {
        width: size.w,
        height: size.h,
        zoom: view.zoom,
        scrollX: view.x,
        scrollY: view.y,
        headings: sh.headings !== false,
        lang: lang(),
        sheets: tabs.map((p) => p.sheet!),
        sel: { g: norm(sel), ar: sel.ar, ac: sel.ac, more: sel.more },
        editing: editing && !editing.fromBar ? editing.a : null,
        theme,
        fillTo,
        // the range copied / cut: marching ants until Esc or typing (Excel)
        clip: clip?.pageId === pageId ? clip.g : null,
        listArrow: !!vrule && vrule.type === "list" && !vrule.noDropdown && !(editing && !editing.fromBar),
        formulas: gridView.formulas,
      };

  // development-only diagnostics: where a cell is on the canvas (the browser checks click real cells with it)
  if (import.meta.env.DEV) (window as unknown as { __omwCellRect?: unknown }).__omwCellRect = (r: number, c: number) => cellRect(sh, paint, r, c);

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
    const L = panes(sh, { zoom: view.zoom, headings: sh.headings !== false, scrollX: 0, scrollY: 0 });
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
  const arrows = useTrace((st) => st.arrows[pageId]) ?? NO_ARROWS;
  // the outline bar's room (데이터 ▸ 그룹): a lane per level and one for the level buttons
  const olW = sh.rowLevel && Object.keys(sh.rowLevel).length ? (Math.max(...Object.values(sh.rowLevel)) + 1) * OL_STEP + 4 : 0;
  const olH = sh.colLevel && Object.keys(sh.colLevel).length ? (Math.max(...Object.values(sh.colLevel)) + 1) * OL_STEP + 4 : 0;
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
      const r = Math.min(MAX_ROW, Math.max(0, (dr > 0 && m ? m.r1 : editing.r) + dr));
      let c = Math.min(MAX_COL, Math.max(0, (dc > 0 && m ? m.c1 : editing.c) + dc));
      // Excel: Tab, Tab, … then Enter goes to the next row under the cell where the Tabs began
      if (dc === 1 && !dr) tabFrom.current ??= editing.c;
      else if (dr === 1 && !dc && tabFrom.current != null) c = tabFrom.current;
      if (!(dc === 1 && !dr)) tabFrom.current = null;
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

  /** row whose bottom border is under y in the row headings (height drag / double-click autofit) */
  const rowBorderAt = (x: number, y: number): number | null => {
    const L = panes(sh, paint);
    if (x >= L.hw || y < L.hh) return null;
    const h = hitCell(sh, paint, L.hw + 1, y);
    for (const r of [h.r - 1, h.r]) {
      if (r < 0) continue;
      const q = cellRect(sh, paint, r, 0);
      if (Math.abs(q.y + q.h - y) <= 3) return r;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    tabFrom.current = null;
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
      const b = filterButtonRect(sh, paint, fb.k, filterOf(sh, fb.table));
      return openDlg({ kind: "filter", col: fb.k, table: fb.table, x: cr.left + b.x, y: cr.top + b.y + b.h + 2 });
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
    // a formula being typed: clicking a cell puts its reference in, dragging makes it a range, Shift+click stretches the
    // last one, Ctrl+click adds another after a comma (Excel's point mode)
    if (editing && editing.text.startsWith("=") && !h.head) {
      const text = editing.text;
      const rp = refPoint.current && refPoint.current.end === text.length ? refPoint.current : null;
      const open = /[=(,+\-*/^&<>:]$/.test(text.trimEnd());
      if (rp || open) {
        e.preventDefault();
        let start = text.length, anchor = { r: h.r, c: h.c };
        if (rp && e.shiftKey) anchor = { r: rp.r, c: rp.c };
        if (rp && !e.shiftKey && (e.ctrlKey || e.metaKey)) start = text.length + 1;
        else if (rp) start = rp.start;
        const base = rp && !e.shiftKey && (e.ctrlKey || e.metaKey) ? text + "," : text.slice(0, start);
        const ref = anchor.r === h.r && anchor.c === h.c ? addr(h.r, h.c) : rangeText({ r0: Math.min(anchor.r, h.r), c0: Math.min(anchor.c, h.c), r1: Math.max(anchor.r, h.r), c1: Math.max(anchor.c, h.c) });
        refPoint.current = { start: base.length, end: base.length + ref.length, r: anchor.r, c: anchor.c };
        setEditing({ ...editing, text: base + ref });
        drag.current = { kind: "ref", start: sel };
        return;
      }
    }
    // a picked chart: click inside drags it, the corner handle sizes it; elsewhere the pick goes
    const ci = chartAt(x, y);
    if (ci != null && !editing) {
      const d = sh.drawings![ci.i];
      pickChart(pageId, ci.i);
      if (d.spec || d.anchorIx != null) {
        drag.current = { kind: ci.handle ? "chartSize" : "chartMove", start: sel, x0: x, y0: y, i: ci.i, at0: { ...d.at }, box0: drawingBox(sh, { ...d, box: undefined }) };
        S().beginGesture();
      }
      return;
    }
    if (chartSel >= 0) pickChart(null);
    if (editing && !commitEdit(null)) return;
    // a hyperlink: clicking its text follows it (Excel); elsewhere in the cell selects it
    const la = !h.head && !e.shiftKey ? addr(h.r, h.c) : null;
    if (la && sh.links?.[la] && overText(h.r, h.c, x)) {
      drag.current = null;
      select(one(h.r, h.c), false);
      return followLink(pageId, la);
    }
    const rb = border == null ? rowBorderAt(x, y) : null;
    if (rb != null) {
      // a row's height by its bottom border (Excel: with whole rows picked, all of them)
      const s = norm(sel);
      const ids = s.r0 <= rb && rb <= s.r1 && sel.c0 === 0 && sel.c1 === MAX_COL ? Array.from({ length: s.r1 - s.r0 + 1 }, (_, i) => s.r0 + i) : [rb];
      drag.current = { kind: "rowSize", start: sel, col: rb, y0: y, w0: geomOf(sh).rows.size(rb), ids };
      S().beginGesture();
      return;
    }
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
    // Ctrl+click / Ctrl+drag: another area added to the selection (Excel's multi-area selection)
    const s = e.shiftKey ? { ...sel, r1: h.r, c1: h.c } : (e.ctrlKey || e.metaKey) && !useFormatPainter.getState().src ? { ...one(h.r, h.c), more: [...(sel.more ?? []), norm(sel)] } : one(h.r, h.c);
    drag.current = { kind: "cells", start: s };
    setSizing(true);
    select(s, false);
    editorRef.current?.focus({ preventScroll: true });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = pointAt(e);
    const cv = wrapRef.current!;
    cv.style.cursor = colBorderAt(x, y) != null || drag.current?.kind === "colSize" ? "col-resize" : rowBorderAt(x, y) != null || drag.current?.kind === "rowSize" ? "row-resize" : drag.current?.kind === "fill" || (!drag.current && onFillHandle(x, y)) ? "crosshair" : y < panes(sh, paint).hh ? "s-resize" : x < panes(sh, paint).hw ? "e-resize" : filterButtonAt(sh, paint, x, y) != null ? "default" : "cell";
    const d = drag.current;
    if (!d) {
      // a note shows while the pointer is on its cell
      const hc = hitCell(sh, paint, x, y);
      const a = !hc.head ? addr(hc.r, hc.c) : null;
      const na = a && (sh.notes?.[a] || sh.links?.[a]) ? a : null;
      if (na !== hover) setHover(na);
      const ch = chartAt(x, y);
      if (ch) cv.style.cursor = ch.handle ? "nwse-resize" : sh.drawings![ch.i].spec || sh.drawings![ch.i].anchorIx != null ? "move" : "default";
      else if (a && sh.links?.[a] && overText(hc.r, hc.c, x)) cv.style.cursor = "pointer";
      return;
    }
    if (d.kind === "ref") {
      // dragging out a range in point mode
      const hc = hitCell(sh, paint, Math.max(0, x), Math.max(0, y));
      const rp = refPoint.current;
      if (!rp || !editing) return;
      const ref = rp.r === hc.r && rp.c === hc.c ? addr(hc.r, hc.c) : rangeText({ r0: Math.min(rp.r, hc.r), c0: Math.min(rp.c, hc.c), r1: Math.max(rp.r, hc.r), c1: Math.max(rp.c, hc.c) });
      const text = editing.text.slice(0, rp.start) + ref;
      if (text !== editing.text) {
        refPoint.current = { ...rp, end: text.length };
        setEditing({ ...editing, text });
      }
      return;
    }
    if (d.kind === "chartMove" || d.kind === "chartSize") {
      const dx = (x - d.x0!) / view.zoom, dy = (y - d.y0!) / view.zoom;
      const b = d.box0!;
      const gm = geomOf(sh);
      const nb = d.kind === "chartMove" ? { ...b, x: Math.max(0, b.x + dx), y: Math.max(0, b.y + dy) } : { ...b, w: Math.max(40, b.w + dx), h: Math.max(30, b.h + dy) };
      const c0 = gm.cols.at(nb.x), r0 = gm.rows.at(nb.y);
      const at: SheetAnchor = { c0, x0: nb.x - gm.cols.pos(c0), r0, y0: nb.y - gm.rows.pos(r0), w: nb.w, h: nb.h };
      S().updateGesture((doc) => {
        const p = doc.pages.find((q) => q.id === pageId);
        const dd = p?.sheet?.drawings?.[d.i!];
        // a group member moves its whole group (they share one anchor in the file)
        if (dd) for (const x of p!.sheet!.drawings!) if (x === dd || (dd.anchorIx != null && x.anchorIx === dd.anchorIx)) x.at = at;
      });
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
    if (d.kind === "rowSize") {
      const hgt = Math.max(0, Math.round(d.w0! + (y - d.y0!) / view.zoom));
      S().updateGesture((doc) => {
        const p = doc.pages.find((q) => q.id === pageId);
        if (!p?.sheet) return;
        for (const r of d.ids!) {
          p.sheet.rowH[r] = hgt;
          if (p.sheet.rowAuto) delete p.sheet.rowAuto[r];
        }
      });
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
    if (d?.kind === "cells" || d?.kind === "rows" || d?.kind === "cols") setSizing(false);
    if (d?.kind === "colSize") S().endGesture(t("sheet.h.colWidth"));
    if (d?.kind === "rowSize") S().endGesture(t("sheet.h.rowHeight"));
    // 서식 복사: the range just picked takes the painter's formats
    if (d?.kind === "cells" && useFormatPainter.getState().src) paintFormats(pageId, norm(selOf(pageId)));
    if (d?.kind === "chartMove" || d?.kind === "chartSize") S().endGesture(t(d.kind === "chartMove" ? "sheetx.h.chartMove" : "sheetx.h.chartSize"));
    if (d?.kind === "ref") requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
    if (d?.kind === "fill") {
      setFillTo(null);
      if (fillTo) {
        fill(pageId, norm(d.start), fillTo, "auto", e.ctrlKey || e.metaKey);
        select({ ...d.start, r0: fillTo.r0, c0: fillTo.c0, r1: fillTo.r1, c1: fillTo.c1 }, false);
      }
    }
  };
  /** A drawing's box on screen (its anchor cell's place plus the offset; size by the zoom). */
  const chartRect = (i: number) => {
    const d = sh.drawings?.[i];
    if (!d) return null;
    const q = cellRect(sh, paint, d.at.r0, d.at.c0);
    const b = drawingBox(sh, d);
    const gm = geomOf(sh);
    return { x: q.x + (b.x - gm.cols.pos(d.at.c0)) * view.zoom, y: q.y + (b.y - gm.rows.pos(d.at.r0)) * view.zoom, w: b.w * view.zoom, h: b.h * view.zoom };
  };
  /** The chart under a point (front first), and whether it is on the picked chart's corner handle. */
  const chartAt = (x: number, y: number): { i: number; handle: boolean } | null => {
    const ds = sh.drawings ?? [];
    for (let i = ds.length - 1; i >= 0; i--) {
      if (ds[i].kind !== "chart") continue;
      const q = chartRect(i);
      if (!q) continue;
      if (i === chartSel && Math.abs(x - (q.x + q.w)) <= 6 && Math.abs(y - (q.y + q.h)) <= 6) return { i, handle: true };
      if (x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h) return { i, handle: false };
    }
    return null;
  };
  /** Is x over the text of a cell (a hyperlink is followed there, Excel 2013+)? */
  const overText = (r: number, c: number, x: number) => {
    const cell = sh.cells[addr(r, c)];
    if (!cell || cell.v === undefined) return false;
    const q = cellRect(sh, paint, r, c);
    const st = sh.styles[cell.s ?? 0] ?? {};
    const cvx = document.createElement("canvas").getContext("2d")!;
    cvx.font = `${((st.size ?? sh.baseSize) * 96 * view.zoom) / 72}px "${st.font ?? sh.baseFont}"`;
    const w = Math.min(q.w, cvx.measureText(display(sh, cell, lang()).text).width + 4);
    const right = typeof cell.v === "number" || st.h === "right";
    const center = st.h === "center";
    const x0 = right ? q.x + q.w - w : center ? q.x + (q.w - w) / 2 : q.x;
    return x >= x0 && x <= x0 + w;
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
    // a row border: the height fitted to the row's text (Excel's AutoFit — the row goes back to fitting itself)
    const rb = rowBorderAt(x, y);
    if (rb != null) return fitRows([rb]);
    // the fill handle: filled down as far as the column beside has data (Excel)
    if (!editing && onFillHandle(x, y)) {
      const s = norm(sel);
      let last = s.r1;
      for (const c of [s.c0 - 1, s.c1 + 1]) {
        if (c < 0) continue;
        let r = s.r1;
        while (r + 1 <= MAX_ROW && sh.cells[addr(r + 1, c)]?.v !== undefined && sh.cells[addr(r + 1, c)]?.v !== "") r++;
        last = Math.max(last, r);
        if (last > s.r1) break;
      }
      if (last > s.r1) {
        fill(pageId, s, { ...s, r1: last }, "auto", false);
        select({ ...sel, r0: s.r0, r1: last, c0: s.c0, c1: s.c1 }, false);
      }
      return;
    }
    const ch = chartAt(x, y);
    if (ch) return openDlg({ kind: "chart", i: ch.i });
    const h = hitCell(sh, paint, x, y);
    if (h.head) return;
    if (sh.protect && lockedCell(h.r, h.c)) return;
    select(one(h.r, h.c), false);
    setEditing({ a: addr(h.r, h.c), r: h.r, c: h.c, text: editText(sh, sh.cells[addr(h.r, h.c)]), mode: "edit" });
    requestAnimationFrame(() => {
      const ed = editorRef.current;
      ed?.focus({ preventScroll: true });
      ed?.setSelectionRange(ed.value.length, ed.value.length);
    });
  };
  const fitRows = (rows: number[]) => fitRowHeights(pageId, rows);
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
    if (dr || !dc || extend || jump) tabFrom.current = null;
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
    // the app's chords (열기 · 저장 · 새로 · 닫기 · 찾기 · 인쇄 · Ctrl+Tab): a cell being typed is entered first, then the
    // key goes on to the app's shortcuts (ui/shell/shortcuts.ts; Ctrl+F / H open the sheet's own Find there). While
    // editing every key used to stop here, so Ctrl+S / O / N / W / P did nothing (or the browser's own command ran).
    if (isAppChord(e.nativeEvent)) {
      if (editing && !commitEdit(null)) return stop();
      return;
    }
    if (ctrl && e.shiftKey && NUMBER_KEYS[e.code]) {
      stop();
      if (editing) commitEdit(null);
      return applyNumberFormat(NUMBER_KEYS[e.code]);
    }
    if (editing) {
      // Ctrl+Enter: the entry into every cell of the selection, the selection kept (Excel)
      if (k === "Enter" && ctrl && !e.altKey && !editing.fromBar && (g.r0 !== g.r1 || g.c0 !== g.c1 || !!sel.more?.length)) {
        stop();
        const text = editing.text;
        setEditing(null);
        enterTextAll(pageId, g, { r: editing.r, c: editing.c }, text);
        requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }));
        return;
      }
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
        // a function name being typed: Tab takes the first suggestion (Excel's formula AutoComplete)
        if (!e.shiftKey && suggest.length) {
          const text = editing.text.replace(/[A-Za-z][A-Za-z0-9.]*$/, suggest[0] + "(");
          setEditing({ ...editing, text });
          return;
        }
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
      // F4: the reference at the caret goes absolute / mixed / relative (Excel)
      if (k === "F4" && !ctrl && editing.text.startsWith("=")) {
        stop();
        const ed = e.currentTarget;
        const at = ed.selectionStart ?? editing.text.length;
        const span = refAt(editing.text, at);
        if (!span) return;
        const next = cycleRef(editing.text.slice(span.start, span.end));
        const text = editing.text.slice(0, span.start) + next + editing.text.slice(span.end);
        setEditing({ ...editing, text });
        refPoint.current = null;
        const caret = span.start + next.length;
        requestAnimationFrame(() => ed.setSelectionRange(caret, caret));
        return;
      }
      // point mode by keys: after an operator in a formula being typed (입력 mode), the arrows put the cell they reach in;
      // Shift+arrows stretch it to a range; F2 switches to 편집 mode, where the arrows move the caret (Excel)
      if (editing.mode === "enter" && /^Arrow/.test(k) && editing.text.startsWith("=") && !ctrl && !e.altKey) {
        const rp = refPoint.current && refPoint.current.end === editing.text.length ? refPoint.current : null;
        if (rp || /[=(,+\-*/^&<>:]$/.test(editing.text.trimEnd())) {
          stop();
          const d = ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, [number, number]>)[k];
          const from = rp ? { r: rp.pr ?? rp.r, c: rp.pc ?? rp.c } : { r: editing.r, c: editing.c };
          const pr = Math.min(MAX_ROW, Math.max(0, from.r + d[0])), pc = Math.min(MAX_COL, Math.max(0, from.c + d[1]));
          const anchor = rp && e.shiftKey ? { r: rp.r, c: rp.c } : { r: pr, c: pc };
          const start = rp ? rp.start : editing.text.length;
          const ref = anchor.r === pr && anchor.c === pc ? addr(pr, pc) : rangeText({ r0: Math.min(anchor.r, pr), c0: Math.min(anchor.c, pc), r1: Math.max(anchor.r, pr), c1: Math.max(anchor.c, pc) });
          refPoint.current = { start, end: start + ref.length, r: anchor.r, c: anchor.c, pr, pc };
          setEditing({ ...editing, text: editing.text.slice(0, start) + ref });
          reveal(pr, pc);
          return;
        }
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
      for (const fa of sheetFilters(sh)) {
        const f = parseRange(fa.f.ref);
        if (f && sel.ar === f.r0 && sel.ac >= f.c0 && sel.ac <= f.c1) {
          const b = filterButtonRect(sh, paint, sel.ac - f.c0, fa.f);
          return openDlg({ kind: "filter", col: sel.ac - f.c0, table: fa.table, x: cr.left + b.x, y: cr.top + b.y + b.h + 2 });
        }
      }
      return;
    }
    // 그룹 / 그룹 해제 (Alt+Shift+→ / ←): whole rows or columns at once, a cell range asks 행 / 열
    if (e.altKey && e.shiftKey && !ctrl && (k === "ArrowRight" || k === "ArrowLeft")) {
      stop();
      const by = k === "ArrowRight" ? 1 : -1;
      const rows = g.c0 === 0 && g.c1 === MAX_COL, cols = g.r0 === 0 && g.r1 === MAX_ROW;
      if (rows !== cols) return groupLines(pageId, rows ? "row" : "col", g, by);
      return openDlg({ kind: "group", ungroup: by < 0 });
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
      // (Tab … Enter comes back to the column the Tabs began in, as in Excel)
      if (k === "Tab" && !back) tabFrom.current ??= sel.ac;
      else if (k === "Enter" && !back && tabFrom.current != null) {
        const c0 = tabFrom.current;
        tabFrom.current = null;
        return select(one(Math.min(MAX_ROW, sel.ar + 1), c0));
      } else tabFrom.current = null;
      return move(d[0], d[1], false, false);
    }
    if (k === "Home") {
      stop();
      const r = ctrl ? sh.freeze?.rows ?? 0 : sel.ar;
      const c = ctrl ? sh.freeze?.cols ?? 0 : 0;
      // with Shift the selection grows from the active cell to there (Ctrl+Shift+Home, Shift+Home)
      return select(e.shiftKey ? { ...sel, r1: r, c1: c } : one(r, c));
    }
    if (k === "End" && ctrl) {
      stop();
      const u = usedRange(sh);
      return select(e.shiftKey ? { ...sel, r1: Math.max(0, u.r1), c1: Math.max(0, u.c1) } : one(Math.max(0, u.r1), Math.max(0, u.c1)));
    }
    if (k === "PageDown" || k === "PageUp") {
      stop();
      const rows = Math.max(1, Math.floor(size.h / (sh.defRowH * view.zoom)) - 2);
      return move(k === "PageDown" ? rows : -rows, 0, e.shiftKey, false);
    }
    // a picked chart: Delete removes it, Esc lets it go
    if (chartSel >= 0 && (k === "Delete" || k === "Backspace")) return stop(), deleteDrawing(pageId, chartSel);
    if (chartSel >= 0 && k === "Escape") return stop(), pickChart(null);
    // Excel's dialogs and data keys: Ctrl+1 셀 서식, Ctrl+K 하이퍼링크, Ctrl+E 빠른 채우기, Ctrl+` 수식 표시,
    // Ctrl+F3 이름 관리자, Shift+F3 함수 삽입, Ctrl+G / F5 이동 (the name box)
    if (ctrl && !e.altKey && !e.shiftKey && (e.code === "Digit1" || e.code === "Numpad1")) return stop(), openDlg({ kind: "fmt" });
    if (ctrl && !e.altKey && !e.shiftKey && e.code === "KeyK") return stop(), openDlg({ kind: "link" });
    // Ctrl+Shift+; the time now (Excel), Shift+F11 a new sheet
    if (ctrl && e.shiftKey && !e.altKey && e.code === "Semicolon") {
      stop();
      const d = new Date();
      return startEdit("enter", `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`);
    }
    if (e.shiftKey && !ctrl && !e.altKey && k === "F11") return stop(), void addSheet(pageId);
    // 표 만들기 (Ctrl+T, also Ctrl+L as in Excel)
    if (ctrl && !e.altKey && !e.shiftKey && (e.code === "KeyT" || e.code === "KeyL")) return stop(), openDlg({ kind: "table" });
    if (ctrl && !e.altKey && !e.shiftKey && e.code === "KeyE") return stop(), void flashFill(pageId);
    if (ctrl && !e.altKey && !e.shiftKey && e.code === "Backquote") return stop(), toggleFormulas();
    if (ctrl && !e.altKey && k === "F3") return stop(), openDlg({ kind: e.shiftKey ? "names" : "names" });
    if (!ctrl && e.shiftKey && k === "F3") return stop(), openDlg({ kind: "fn" });
    if ((ctrl && !e.altKey && !e.shiftKey && e.code === "KeyG") || (k === "F5" && !ctrl && !e.shiftKey)) {
      stop();
      return openDlg({ kind: "goTo" });
    }
    if (k === "F2" && e.shiftKey && ctrl) {
      // Ctrl+Shift+F2: 새 메모 (a thread), as Excel 365
      stop();
      return openDlg({ kind: "thread", a: addr(sel.ar, sel.ac) });
    }
    if (k === "F2" && e.shiftKey) {
      stop();
      // a cell with a thread: its thread (답글 · 해결), as Excel 365 shows it
      if (sh.notes?.[addr(sel.ar, sel.ac)]?.threaded) return openDlg({ kind: "thread", a: addr(sel.ar, sel.ac) });
      return openDlg({ kind: "note", a: addr(sel.ar, sel.ac) });
    }
    if (k === "F2") {
      stop();
      return startEdit("edit");
    }
    // Ctrl++ / Ctrl+- (insert / delete), Ctrl+D / Ctrl+R (fill), Ctrl+Shift+L (filter), Ctrl+F / Ctrl+H (find)
    // Excel's keys for lines, borders and the cell above
    if (ctrl && !e.altKey && (e.code === "Digit9" || e.code === "Digit0")) {
      // Ctrl+9 / Ctrl+0 hide the rows / columns of the selection, with Shift shows them again
      stop();
      const axis = e.code === "Digit9" ? "row" : "col", hide = !e.shiftKey;
      setRepeat((p) => hideLines(p, axis, norm(selOf(p)), hide));
      return hideLines(pageId, axis, g, hide);
    }
    if (ctrl && e.shiftKey && !e.altKey && (e.code === "Digit7" || e.code === "Minus")) {
      // Ctrl+Shift+& the outline border, Ctrl+Shift+_ no borders
      stop();
      if (e.code === "Minus") return formatRange(pageId, g, (s) => ({ ...s, bt: undefined, bb: undefined, bl: undefined, br: undefined }));
      const b = { style: "thin" as const, color: "#000000" };
      const outline = (p: string, q: typeof g) => {
        formatRange(p, { ...q, r1: q.r0 }, (s) => ({ ...s, bt: b }));
        formatRange(p, { ...q, r0: q.r1 }, (s) => ({ ...s, bb: b }));
        formatRange(p, { ...q, c1: q.c0 }, (s) => ({ ...s, bl: b }));
        formatRange(p, { ...q, c0: q.c1 }, (s) => ({ ...s, br: b }));
      };
      outline(pageId, g);
      return setRepeat((p) => outline(p, norm(selOf(p))));
    }
    if (ctrl && !e.altKey && e.code === "Quote" && sel.ar > 0) {
      // Ctrl+' the formula of the cell above (as it is), Ctrl+Shift+" its value — typed into this cell
      stop();
      const up = sh.cells[addr(sel.ar - 1, sel.ac)];
      return startEdit("enter", e.shiftKey ? editText(sh, up ? { ...up, f: undefined } : undefined) : editText(sh, up));
    }
    if (ctrl && e.shiftKey && !e.altKey && e.code === "Digit8") {
      // Ctrl+* the current region
      stop();
      const r = currentRegion(sh, sel.ar, sel.ac);
      return select({ ar: sel.ar, ac: sel.ac, ...r }, false);
    }
    if (k === "F4" && !ctrl && !e.shiftKey && !e.altKey) {
      // F4: the last format again (Excel's 반복)
      stop();
      return void repeatLast(pageId);
    }
    if (k === "F9" && !ctrl && !e.altKey) {
      // F9 지금 계산 · Shift+F9 시트 계산 (the book is recalculated either way)
      stop();
      return calcNow(pageId);
    }
    if (ctrl && !e.altKey && (k === "+" || e.code === "NumpadAdd" || (e.shiftKey && e.code === "Equal"))) return stop(), void insertOrDelete(pageId, false);
    if (ctrl && !e.altKey && (k === "-" || e.code === "NumpadSubtract" || e.code === "Minus")) return stop(), void insertOrDelete(pageId, true);
    if (ctrl && !e.shiftKey && !e.altKey && (e.code === "KeyD" || e.code === "KeyR")) return stop(), fillDir(pageId, e.code === "KeyD" ? "down" : "right");
    if (ctrl && e.shiftKey && !e.altKey && e.code === "KeyL") return stop(), toggleFilter(pageId);
    if (ctrl && !e.shiftKey && !e.altKey && (e.code === "KeyF" || e.code === "KeyH")) return stop(), openDlg({ kind: "find", replace: e.code === "KeyH" });
    if (k === "Delete") {
      stop();
      if (!mayEdit(sh, g)) return;
      return clearRange(pageId, g);
    }
    if (k === "Backspace") {
      stop();
      if (!mayEdit(sh, { r0: sel.ar, c0: sel.ac, r1: sel.ar, c1: sel.ac })) return;
      clearRange(pageId, { r0: sel.ar, c0: sel.ac, r1: sel.ar, c1: sel.ac });
      return startEdit("enter", "");
    }
    if (k === "Escape") {
      stop();
      forgetCopy();
      useFormatPainter.setState({ src: null, keep: false });
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
      if (e.code === "KeyA") {
        // Ctrl+A: the current region first, the whole sheet when pressed again (or from an empty cell) — Excel
        stop();
        const r = currentRegion(sh, sel.ar, sel.ac);
        const cur = norm(sel);
        const same = cur.r0 === r.r0 && cur.c0 === r.c0 && cur.r1 === r.r1 && cur.c1 === r.c1;
        const lone = r.r0 === r.r1 && r.c0 === r.c1;
        return select(same || lone ? { ar: sel.ar, ac: sel.ac, r0: 0, c0: 0, r1: MAX_ROW, c1: MAX_COL } : { ar: sel.ar, ac: sel.ac, ...r }, false);
      }
      if (e.code === "Semicolon") {
        stop();
        const d = new Date();
        return startEdit("enter", lang() === "en" ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }
      if (e.code === "KeyC" || e.code === "KeyX") {
        stop();
        // a multi-area selection: copied when its areas line up (Excel), cutting it is refused
        if (sel.more?.length && e.code === "KeyX") return void S().notify(t("sheetx.multi.copyBad"));
        const cp = copySelection(pageId);
        if (!cp) return;
        writeClipboard(cp.text, cp.html);
        // a cut stays until it is pasted (Excel), then the cells move (sheetActions paste)
        rememberCopy(pageId, g, e.code === "KeyX", cp.text, cp.html);
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
      // a range picked down a column (Excel): its total goes under it, for every column of it
      if (g.r1 > g.r0 && g.r1 < MAX_ROW && g.c1 - g.c0 < 64) {
        for (let c = g.c0; c <= g.c1; c++) enterText(pageId, g.r1 + 1, c, `=SUM(${addr(g.r0, c)}:${addr(g.r1, c)})`);
        return select(one(g.r1 + 1, g.c0));
      }
      return startEdit("enter", autoSumFormula(sh, sel.ar, sel.ac));
    }
    // 선택하여 붙여넣기 (Excel's Paste Special, Ctrl+Alt+V): the dialog, for what was copied on a sheet here
    if (ctrl && e.altKey && !e.shiftKey && e.code === "KeyV") {
      stop();
      const clip = useSheetClip.getState().clip;
      if (!clip || clip.cut) return void S().notify(t("sheet.paste.nothingCopied"));
      return openDlg({ kind: "pasteSpecial" });
    }
    // Excel's keys on the grid: Shift+Space picks the row (it used to start typing a space over the cell — the value
    // was lost, QA 2026-11-24 #2); Ctrl+Z / Ctrl+Y undo and redo (the app's undo skips keys typed in a field)
    if (e.shiftKey && !ctrl && !e.altKey && e.code === "Space") return stop(), select({ ...sel, c0: 0, c1: MAX_COL }, false);
    if (ctrl && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
      stop();
      if (e.code === "KeyY" || e.shiftKey) S().redo();
      else S().undo();
      return;
    }
    if (ctrl || e.altKey) return; // Ctrl+S, Ctrl+O, … go to the app
    // a printable key starts typing over the cell (the input event of this editor does it, IME included)
    e.stopPropagation();
  };

  const onEditorInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const text = e.currentTarget.value;
    if (editing && !editing.fromBar) return setEditing({ ...editing, text });
    // a protected sheet's locked cell: Excel's message, nothing typed
    if (lockedCell(sel.ar, sel.ac)) {
      e.currentTarget.value = "";
      mayEdit(sh, { r0: sel.ar, c0: sel.ac, r1: sel.ar, c1: sel.ac });
      return;
    }
    // typing over the active cell (and the copied range stops marching, as in Excel)
    forgetCopy();
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
    rememberCopy(pageId, g, cut, text, html);
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
    : // kept inside the grid even when the active cell is scrolled away: typing into it must not scroll the page
      { left: Math.min(Math.max(0, eq.x), Math.max(0, size.w - 8)), top: Math.min(Math.max(0, eq.y), Math.max(0, size.h - 8)), width: 4, height: 4 };

  // ───── status: sum / count / average of the selection ─────

  const stats = useMemo(() => {
    // every area of a multi-area selection counts (a cell in two areas counts once, as in Excel)
    const areas = sel.more?.length ? [...sel.more, g] : [g];
    if (areas.length === 1 && g.r0 === g.r1 && g.c0 === g.c1) return null;
    let n = 0, cnt = 0, sum = 0;
    for (const [a, cell] of Object.entries(sh.cells)) {
      const p = /^([A-Z]+)(\d+)$/.exec(a);
      if (!p || cell.v === undefined || cell.v === "") continue;
      const r = Number(p[2]) - 1;
      const pc = parseRange(a)!.c0;
      if (!areas.some((q) => r >= q.r0 && r <= q.r1 && pc >= q.c0 && pc <= q.c1)) continue;
      cnt++;
      if (typeof cell.v === "number" && cell.t !== "e") {
        n++;
        sum += cell.v;
      }
    }
    if (!cnt) return null;
    return { n, cnt, sum: Number(sum.toPrecision(15)), avg: n ? Number((sum / n).toPrecision(15)) : null };
  }, [sh, g.r0, g.r1, g.c0, g.c1, sel.more]);
  const calcPending = useCalcPending((s) => !!sh.calcManual && !!s.books[sh.book ?? pageId]);
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

  // a formula formatted 숨김 on a protected sheet shows nothing in the bar (Excel); its value stays in the cell
  const barText = editing ? editing.text : sh.protect && active?.f && styleAt(sh, sel.ar, sel.ac).hideFormula ? "" : editText(sh, active);
  const abs = absRef(sh, g);
  const named = Object.entries(sh.names ?? {}).find(([, f]) => f.replace(/^'?([^'!]*)'?!/, (_m, n) => n + "!") === abs.replace(/^'?([^'!]*)'?!/, (_m, n) => n + "!"))?.[0];
  // Excel's name box: the active cell, "3R x 2C" only while a range is being dragged out
  const nameText = nameBox ?? named ?? (g.r0 === g.r1 && g.c0 === g.c1 || !sizing ? addr(sel.ar, sel.ac) : mergeOf(sel.ar, sel.ac) && rangeText(mergeOf(sel.ar, sel.ac)!) === rangeText(g) ? addr(sel.ar, sel.ac) : `${g.r1 - g.r0 + 1}R x ${g.c1 - g.c0 + 1}C`);

  const goName = (text: string) => {
    const s = text.trim().toUpperCase().replace(/\$/g, "");
    const r = parseRange(s);
    setNameBox(null);
    if (r) select({ ar: r.r0, ac: r.c0, r0: r.r0, c0: r.c0, r1: r.r1, c1: r.c1 });
    // a name or another sheet's cells: go there; a new name typed over a selection defines it (Excel's name box)
    else if (text.trim() && !goTo(pageId, text.trim())) defineName(pageId, text.trim(), absRef(sh, g));
    editorRef.current?.focus({ preventScroll: true });
  };
  const lockedCell = (r: number, c: number) => lockedAt(sh, r, c);
  // formula AutoComplete: the function names the word being typed starts
  const suggest = useMemo(() => {
    const m = editing && editing.text.startsWith("=") ? /(?:^=|[^A-Za-z0-9_.$])([A-Za-z][A-Za-z0-9.]*)$/.exec(editing.text) : null;
    if (!m || m[1].length < 1) return [];
    const w = m[1].toUpperCase();
    return Object.keys(FUNCTIONS).filter((f) => f.startsWith(w) && f !== w).sort().slice(0, 8);
  }, [editing]);
  // the function argument hint (Excel's ScreenTip): the open call at the end of the formula being typed
  const hint = useMemo(() => {
    if (!editing || !editing.text.startsWith("=") || suggest.length) return null;
    const call = openCall(editing.text);
    const args = call ? fnArgs(call.name) : null;
    return call && args ? { name: call.name, args, arg: Math.min(call.arg, Math.max(0, args.length - 1)) } : null;
  }, [editing, suggest.length]);
  // the grid asked to start typing (함수 삽입, 자동 합계 ▾ …)
  useEffect(() => {
    if (!cellCmd) return;
    startEdit("enter", cellCmd.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellCmd?.n]);
  // a ribbon command run (a button or a menu item): the keys go back to the grid, as in Excel — Ctrl+B after
  // 찾기 및 선택 ▸ 수식 makes the formulas bold (not the ribbon button focused)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const btn = el?.closest?.(".ribbon button, .menu-pop button, .menu-pop [role=menuitem]") as HTMLElement | null;
      if (!btn || btn.getAttribute("aria-haspopup") || btn.getAttribute("aria-expanded") === "true") return;
      requestAnimationFrame(() => {
        if (useSheetDlg.getState().dlg || document.querySelector(".menu-pop, .modal")) return;
        const a = document.activeElement as HTMLElement | null;
        if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
        if (useStore.getState().pageId !== pageId) return;
        editorRef.current?.focus({ preventScroll: true });
      });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [pageId]);
  // the cell at the grid's top-left now (보기 ▸ 나누기 splits the panes from there)
  useEffect(() => {
    const L = panes(sh, paint);
    const h = hitCell(sh, paint, L.x0 + 1, L.y0 + 1);
    const cur = useGridView.getState().topLeft?.[pageId];
    if (!cur || cur.r !== h.r || cur.c !== h.c) useGridView.setState((s) => ({ topLeft: { ...(s.topLeft ?? {}), [pageId]: { r: h.r, c: h.c } } }));
  });
  // 창 나누기: the wheel over the top (left) pane scrolls that pane on its own (a native listener: React's wheel
  // listener is passive and cannot keep the grid from scrolling too)
  const splitWheel = useRef<(e: WheelEvent) => void>(() => {});
  splitWheel.current = (e: WheelEvent) => {
    if (e.ctrlKey || !sh.split || sh.freeze) return;
    const L = panes(sh, paint);
    const r = canvasRef.current!.getBoundingClientRect();
    const y = e.clientY - r.top, x = e.clientX - r.left;
    const k = Math.sign(e.deltaY || e.deltaX) * 3;
    if (L.fr && y > L.hh && y < L.y0) return void (e.preventDefault(), scrollSplit(pageId, e.shiftKey ? 0 : k, e.shiftKey ? k : 0));
    if (L.fc && x > L.hw && x < L.x0 && y >= L.y0) return void (e.preventDefault(), scrollSplit(pageId, 0, k));
  };
  useEffect(() => {
    const w = wrapRef.current;
    if (!w) return;
    const f = (e: WheelEvent) => splitWheel.current(e);
    w.addEventListener("wheel", f, { passive: false });
    return () => w.removeEventListener("wheel", f);
  }, []);
  // a zoom asked for (보기 ▸ 100% / 선택 영역 확대/축소)
  useEffect(() => {
    const z = gridView.zoom;
    if (!z) return;
    if (z.z === "sel") {
      const q = cellRect(sh, { ...paint, zoom: 1 }, g.r0, g.c0, g.r1, g.c1);
      const k = Math.min(4, Math.max(0.1, Math.min((size.w - 60) / Math.max(1, q.w), (size.h - 40) / Math.max(1, q.h))));
      setView((v) => ({ ...v, zoom: Math.round(k * 100) / 100 }));
      requestAnimationFrame(() => reveal(g.r0, g.c0));
    } else setView((v) => ({ ...v, zoom: z.z as number }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridView.zoom?.n]);

  return (
    <div className="sheet-view" data-theme-sheet={theme}>
      <div className="sheet-bar">
        <input
          ref={nameRef}
          list="sheet-names"
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
            // (the Enter itself must not reach the cell editor the focus goes to: it started typing a line break there)
            if (e.key === "Enter") (e.preventDefault(), goName(e.currentTarget.value));
            if (e.key === "Escape") {
              setNameBox(null);
              editorRef.current?.focus();
            }
          }}
        />
        <datalist id="sheet-names">
          {Object.keys(sh.names ?? {}).map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <button type="button" className="sheet-fx" aria-label={t("sheetx.fn.insert")} data-tip={t("sheetx.fn.insert")} onMouseDown={(e) => e.preventDefault()} onClick={() => openDlg({ kind: "fn" })}>
          <i>fx</i>
        </button>
        {/* a one-line textarea: a cell's line breaks (Alt+Enter) are kept, shown and edited here as in Excel */}
        <textarea
          ref={barRef}
          rows={1}
          wrap="off"
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
            // the app's chords: what is typed in the bar is entered first, then the key goes on to the app
            if (!e.nativeEvent.isComposing && isAppChord(e.nativeEvent)) {
              if (editing && !commitEdit(null)) e.preventDefault();
              return;
            }
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && e.altKey) {
              // Alt+Enter: a line break in the cell (Excel)
              e.preventDefault();
              const el = e.currentTarget, a = el.selectionStart, b = el.selectionEnd;
              const text = el.value.slice(0, a) + "\n" + el.value.slice(b);
              setEditing((ed) => (ed ? { ...ed, text } : ed));
              requestAnimationFrame(() => el.setSelectionRange(a + 1, a + 1));
            } else if (e.key === "Enter") {
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
      <div className="sheet-body" style={olW || olH ? { marginLeft: olW, marginTop: olH } : undefined}>
        {(olW > 0 || olH > 0) && <OutlineBar pageId={pageId} sh={sh} paint={paint} size={size} gw={olW} gh={olH} />}
        <canvas ref={canvasRef} className="sheet-canvas" style={{ width: size.w, height: size.h }} />
        {(sh.slicers ?? []).map((sl) => {
          // the slicer's box on screen: its anchor cell's place plus the offset, sized by the zoom
          const q = cellRect(sh, paint, sl.at.r0, sl.at.c0);
          const w = sl.at.c1 != null ? cellRect(sh, paint, sl.at.r1 ?? sl.at.r0, sl.at.c1).x + (sl.at.x1 ?? 0) * view.zoom - (q.x + sl.at.x0 * view.zoom) : (sl.at.w ?? 180) * view.zoom;
          const h = sl.at.c1 != null ? cellRect(sh, paint, sl.at.r1 ?? sl.at.r0, sl.at.c1).y + (sl.at.y1 ?? 0) * view.zoom - (q.y + sl.at.y0 * view.zoom) : (sl.at.h ?? 220) * view.zoom;
          const box = { x: q.x + sl.at.x0 * view.zoom, y: q.y + sl.at.y0 * view.zoom, w: Math.max(60, w), h: Math.max(40, h) };
          const cellAt = (x: number, y: number) => {
            const hc = hitCell(sh, paint, Math.max(x, 1), Math.max(y, 1));
            const c0 = cellRect(sh, paint, hc.r, hc.c);
            return { r: hc.r, c: hc.c, x: Math.max(0, x - c0.x), y: Math.max(0, y - c0.y) };
          };
          return <SlicerBox key={sl.name} pageId={pageId} s={sl} box={box} zoom={view.zoom} cellAt={cellAt} />;
        })}
        {arrows.length > 0 && (
          // 수식 추적: blue arrows from the cells a formula uses (a box round a range) to the formula's cell
          <svg className="sheet-trace" width={size.w} height={size.h} style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} aria-hidden>
            <defs>
              <marker id="sheet-trace-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#2F5BEA" />
              </marker>
            </defs>
            {arrows.map((ar, i) => {
              const a = cellRect(sh, paint, ar.from.r0, ar.from.c0, ar.from.r1, ar.from.c1);
              const one1 = cellRect(sh, paint, ar.from.r0, ar.from.c0);
              const b = cellRect(sh, paint, ar.to.r, ar.to.c);
              const x0 = one1.x + one1.w / 2, y0 = one1.y + one1.h / 2, x1 = b.x + b.w / 2, y1 = b.y + b.h / 2;
              const box = ar.from.r1 > ar.from.r0 || ar.from.c1 > ar.from.c0;
              return (
                <g key={i} className="sheet-trace-arrow">
                  {box && <rect x={a.x + 0.5} y={a.y + 0.5} width={a.w - 1} height={a.h - 1} fill="none" stroke="#2F5BEA" strokeWidth={1.5} />}
                  <circle cx={x0} cy={y0} r={3} fill="#2F5BEA" />
                  <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#2F5BEA" strokeWidth={1.5} markerEnd="url(#sheet-trace-head)" />
                </g>
              );
            })}
          </svg>
        )}
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
            const ch = chartAt(x, y);
            if (ch) {
              pickChart(pageId, ch.i);
              return openDlg({ kind: "chartMenu", i: ch.i, x: e.clientX, y: e.clientY });
            }
            const h = hitCell(sh, paint, x, y);
            const g0 = norm(sel);
            const head = h.head === "col" || h.head === "row" ? h.head : null;
            // a heading right-clicked keeps the selection only when whole rows / columns holding it are picked (Excel);
            // a cell selection in that row (A2 for row 2) gives way to the row, so the menu offers 숨기기 · 행 삽입
            const inside =
              head === "row" ? h.r >= g0.r0 && h.r <= g0.r1 && g0.c0 === 0 && g0.c1 === MAX_COL : head === "col" ? h.c >= g0.c0 && h.c <= g0.c1 && g0.r0 === 0 && g0.r1 === MAX_ROW : h.r >= g0.r0 && h.r <= g0.r1 && h.c >= g0.c0 && h.c <= g0.c1;
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
        {chartSel >= 0 && chartRect(chartSel) && (() => {
          const q = chartRect(chartSel)!;
          return (
            <div className="sx-chart-sel" style={{ left: q.x, top: q.y, width: q.w, height: q.h }} aria-hidden>
              {(sh.drawings![chartSel].spec || sh.drawings![chartSel].anchorIx != null) && <span className="sx-chart-handle" />}
            </div>
          );
        })()}
        {editing && hint && (
          <div className="sx-fnhint" role="tooltip" style={{ left: editing.fromBar ? 4 : eq.x, top: editing.fromBar ? 2 : eq.y + eq.h + 2 }}>
            {hint.name}(
            {hint.args.map((a, i) => (
              <span key={i}>
                {i ? ", " : ""}
                {i === hint.arg && !a.startsWith("…") ? <b>{a}</b> : a}
              </span>
            ))}
            )
          </div>
        )}
        {editing && !editing.fromBar && suggest.length > 0 && (
          <div className="menu-pop sx-suggest" role="listbox" style={{ left: eq.x, top: eq.y + eq.h + 2 }}>
            {suggest.map((f, i) => (
              <button
                key={f}
                type="button"
                role="option"
                aria-selected={i === 0}
                className={cx("menu-item", i === 0 && "on")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setEditing({ ...editing, text: editing.text.replace(/[A-Za-z][A-Za-z0-9.]*$/, f + "(") });
                  editorRef.current?.focus({ preventScroll: true });
                }}
              >
                <span className="menu-label">{f}</span>
              </button>
            ))}
          </div>
        )}
        {!editing && vrule?.showInput && (vrule.prompt || vrule.promptTitle) && !dlg && (() => {
          const q = cellRect(sh, paint, sel.ar, sel.ac);
          return (
            <div className="sheet-note sx-prompt" role="note" style={{ left: Math.min(size.w - 200, q.x + 8), top: q.y + q.h + 6 }}>
              {vrule.promptTitle && <b>{vrule.promptTitle}</b>}
              {vrule.promptTitle && "\n"}
              {vrule.prompt}
            </div>
          );
        })()}
        {hover && sh.links?.[hover] && !dlg && noteBox && !sh.notes?.[hover] && (
          <div className="sheet-note sx-linktip" role="tooltip" style={{ left: noteBox.x, top: noteBox.y }}>
            {sh.links[hover].tip ?? sh.links[hover].url ?? sh.links[hover].loc}
            {"\n"}
            {t("sheetx.link.clickTip")}
          </div>
        )}
        {noteBox && dlg?.kind === "note" && <NoteEditor key={dlg.a} page={page} a={dlg.a} box={noteBox} onDone={() => (openDlg(null), editorRef.current?.focus({ preventScroll: true }))} />}
        {noteBox && hover && dlg?.kind !== "note" && sh.threads?.[hover] ? (
          <NoteTip text={sh.threads[hover].items.map((x) => `${x.author}: ${x.text}`).join("\n") + (sh.threads[hover].done ? `\n(${t("sheetx.thread.resolved")})` : "")} box={noteBox} />
        ) : (
          noteBox && hover && dlg?.kind !== "note" && sh.notes?.[hover] && <NoteTip text={sh.notes[hover].text} author={sh.notes[hover].author} box={noteBox} />
        )}
        <SheetDialogs page={page} refocus={() => requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))} />
        <WatchPanel pageId={pageId} />
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (editing) commitEdit(null, false);
                  S().set({ pageId: p.id });
                  setTabMenu({ id: p.id, x: e.clientX, y: e.clientY });
                }}
              >
                {p.sheet!.name}
              </button>
            ),
          )}
          <button type="button" className="sheet-tab-add" aria-label={t("sheet.addSheet")} data-tip={t("sheet.addSheet")} onClick={() => addSheet(pageId)}>
            +
          </button>
        </div>
        {tabMenu && <TabMenu at={tabMenu} onRename={() => setRenaming(tabMenu.id)} onClose={() => setTabMenu(null)} />}
        <div className="sheet-stats" aria-live="polite">
          {/* Excel's status: 입력 (typing over), 편집 (F2: arrows move the caret), 참조 (pointing at cells) */}
          {calcPending && <span className="sx-mode sx-calc-pending">{t("sheetx.calc.pending")}</span>}
          {editing && <span className="sx-mode">{t(refPoint.current && refPoint.current.end === editing.text.length ? "sheetx.mode.point" : editing.mode === "edit" ? "sheetx.mode.edit" : "sheetx.mode.enter")}</span>}
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
