// Dialogs and popups of the sheet grid, stage 2 (표 계산 대화 상자): Find and Replace (Ctrl+F / Ctrl+H, Excel's small
// dialog with Find All list), Sort (levels, my data has headers), Insert / Delete (entire row / column), the AutoFilter
// menu (sort, value checklist with search), the data-validation list and its error message, the note editor, and the
// right-click menu of cells and headings. State: ui/sheet/sheetEdit.ts useSheetDlg.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../core/store";
import type { Page } from "../../core/types";
import { useT } from "../../i18n";
import { addr, colLetters, parseAddr, parseRange } from "../../io/sheet/formula";
import { filterValues, guessHeader, shownText } from "../../io/sheet/sortFilter";
import { filterOf } from "../../io/sheet/filters";
import { Modal } from "../shell/Dialogs";
import { FeatureDialog } from "./SheetFeatureDialogs";
import { hideLines } from "./sheetFeatures";
import { cx } from "../shell/controls";
import { clearRange, copyFromMenu, enterText, lang, norm, pasteFromMenu, pasteValues, selOf, setSel, useSheetClip } from "./sheetActions";
import {
  changeLines,
  doFindAll,
  doFindNext,
  doReplace,
  doReplaceAll,
  fillDir,
  insertOrDelete,
  shiftCells,
  setFilterCustom,
  listItems,
  openDlg,
  quickSort,
  setFilterColumn,
  setNote,
  sortArea,
  sortRange,
  toggleFilter,
  useFind,
  useSheetDlg,
  type SheetDlg,
} from "./sheetEdit";

/** Keeps a fixed popup on screen. */
function usePopPos(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setPos({ left: Math.max(6, Math.min(x, window.innerWidth - w - 6)), top: Math.max(6, Math.min(y, window.innerHeight - h - 6)) });
  }, [x, y]);
  return { ref, style: pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: "hidden" as const } };
}

/** Closes a popup on a click outside it and on Escape. */
function useDismiss(ref: React.RefObject<HTMLElement>, close: () => void) {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [ref, close]);
}

const close = () => openDlg(null);

export function SheetDialogs({ page, refocus }: { page: Page; refocus: () => void }) {
  const dlg = useSheetDlg((s) => s.dlg);
  if (!dlg || !page.sheet) return null;
  const done = () => {
    close();
    refocus();
  };
  switch (dlg.kind) {
    case "find":
      return <FindDialog page={page} replace={dlg.replace} onClose={done} />;
    case "sort":
      return <SortDialog page={page} onClose={done} />;
    case "insert":
    case "delete":
      return <LinesDialog page={page} del={dlg.kind === "delete"} onClose={done} />;
    case "filter":
      return <FilterMenu page={page} col={dlg.col} table={dlg.table} x={dlg.x} y={dlg.y} onClose={done} />;
    case "customFilter":
      return <CustomFilterDialog page={page} col={dlg.col} table={dlg.table} op={dlg.op} text={dlg.text} onClose={done} />;
    case "list":
      return <ListPopup page={page} r={dlg.r} c={dlg.c} x={dlg.x} y={dlg.y} onClose={done} />;
    case "invalid":
      return <InvalidDialog dlg={dlg} />;
    case "menu":
      return <ContextMenu page={page} x={dlg.x} y={dlg.y} head={dlg.head} onClose={done} />;
    case "note":
      return null; // drawn by the grid beside the cell (NoteEditor)
    default:
      return <FeatureDialog page={page} dlg={dlg} onClose={done} />;
  }
}

// ───── Find and Replace ─────

function FindDialog({ page, replace, onClose }: { page: Page; replace: boolean; onClose: () => void }) {
  const t = useT();
  const { q, by, opts, found } = useFind();
  const [tab, setTab] = useState<"find" | "replace">(replace ? "replace" : "find");
  useEffect(() => setTab(replace ? "replace" : "find"), [replace]);
  useEffect(() => useFind.setState({ found: null }), [q, opts]);
  const set = (p: Partial<ReturnType<typeof useFind.getState>>) => useFind.setState(p);
  const sh = page.sheet!;
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      doFindNext(page.id, e.shiftKey);
    }
  };
  return (
    <div className="sheet-find" role="dialog" aria-labelledby="sheet-find-title" onKeyDown={onKey}>
      <div className="sheet-find-head">
        <h2 id="sheet-find-title">{t("sheet.find.title")}</h2>
        <button type="button" className="sheet-x" aria-label={t("sheet.dlg.close")} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="sheet-find-tabs" role="tablist">
        {(["find", "replace"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={cx(tab === k && "on")} onClick={() => setTab(k)}>
            {t(k === "find" ? "sheet.find.tabFind" : "sheet.find.tabReplace")}
          </button>
        ))}
      </div>
      <label className="sheet-find-row">
        <span>{t("sheet.find.what")}</span>
        <input autoFocus data-autofocus value={q} onChange={(e) => set({ q: e.target.value })} onFocus={(e) => e.target.select()} />
      </label>
      {tab === "replace" && (
        <label className="sheet-find-row">
          <span>{t("sheet.find.with")}</span>
          <input value={by} onChange={(e) => set({ by: e.target.value })} />
        </label>
      )}
      <div className="sheet-find-opts">
        <label>
          <input type="checkbox" checked={!!opts.matchCase} onChange={(e) => set({ opts: { ...opts, matchCase: e.target.checked } })} />
          {t("sheet.find.matchCase")}
        </label>
        {/* 서식…: the active cell's formats looked for (Excel's 셀에서 서식 선택), 서식 찾기 지우기 */}
        <label className="sheet-find-fmt">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              const s = selOf(page.id);
              const st = page.sheet!.styles[page.sheet!.cells[addr(s.ar, s.ac)]?.s ?? 0] ?? {};
              set({ opts: { ...opts, format: { bold: !!st.bold, italic: !!st.italic, ...(st.fill ? { fill: st.fill } : {}), ...(st.color ? { color: st.color } : {}) } } });
            }}
          >
            {t("sheetx.findfmt.pick")}
          </button>
          {opts.format && (
            <>
              <span className="sx-hint" style={{ fontWeight: opts.format.bold ? 700 : 400, fontStyle: opts.format.italic ? "italic" : undefined, background: opts.format.fill, color: opts.format.color }}>
                {t("sheetx.findfmt.preview")}
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => set({ opts: { ...opts, format: undefined } })}>
                {t("sheetx.findfmt.clear")}
              </button>
            </>
          )}
        </label>
        <label>
          <input type="checkbox" checked={!!opts.whole} onChange={(e) => set({ opts: { ...opts, whole: e.target.checked } })} />
          {t("sheet.find.whole")}
        </label>
        <label>
          {t("sheet.find.search")}
          <select value={opts.byCols ? "cols" : "rows"} onChange={(e) => set({ opts: { ...opts, byCols: e.target.value === "cols" } })}>
            <option value="rows">{t("sheet.find.byRows")}</option>
            <option value="cols">{t("sheet.find.byCols")}</option>
          </select>
        </label>
        {tab === "find" && (
          <label>
            {t("sheet.find.lookIn")}
            <select value={opts.lookIn ?? "formulas"} onChange={(e) => set({ opts: { ...opts, lookIn: e.target.value as "formulas" | "values" } })}>
              <option value="formulas">{t("sheet.find.formulas")}</option>
              <option value="values">{t("sheet.find.values")}</option>
            </select>
          </label>
        )}
      </div>
      <div className="sheet-find-actions">
        {tab === "replace" && (
          <>
            <button type="button" className="btn btn-ghost" disabled={!q} onClick={() => doReplaceAll(page.id)}>
              {t("sheet.find.replaceAll")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={!q} onClick={() => doReplace(page.id)}>
              {t("sheet.find.replaceOne")}
            </button>
          </>
        )}
        <button type="button" className="btn btn-ghost" disabled={!q && !opts.format} onClick={() => doFindAll(page.id)}>
          {t("sheet.find.findAll")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!q && !opts.format} onClick={() => doFindNext(page.id)}>
          {t("sheet.find.findNext")}
        </button>
      </div>
      {found && found.length > 0 && (
        <div className="sheet-find-list">
          <div className="sheet-find-count">{t("sheet.find.count", { n: found.length })}</div>
          <table>
            <thead>
              <tr>
                <th>{t("sheet.find.cell")}</th>
                <th>{t("sheet.find.values")}</th>
                <th>{t("sheet.find.formulas")}</th>
              </tr>
            </thead>
            <tbody>
              {found.slice(0, 500).map((a) => (
                <tr
                  key={a}
                  tabIndex={0}
                  onClick={() => {
                    const p = parseAddr(a)!;
                    setSel(page.id, { ar: p.r, ac: p.c, r0: p.r, c0: p.c, r1: p.r, c1: p.c });
                  }}
                >
                  <td>{"$" + a.replace(/(\d+)$/, "$$$1")}</td>
                  <td>{shownText(sh, sh.cells[a], lang())}</td>
                  <td>{sh.cells[a]?.f ? "=" + sh.cells[a].f : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───── Sort ─────

function SortDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const sel = selOf(page.id);
  const g = useMemo(() => sortArea(sh, sel), [sh, sel]);
  const [header, setHeader] = useState(() => (sh.filter && parseRange(sh.filter.ref)!.r0 === g.r0 ? true : guessHeader(sh, g)));
  const [levels, setLevels] = useState([{ col: Math.min(g.c1, Math.max(g.c0, sel.ac)), desc: false }]);
  const cols: { c: number; label: string }[] = [];
  for (let c = g.c0; c <= g.c1; c++) {
    const h = header ? shownText(sh, sh.cells[addr(g.r0, c)], lang()) : "";
    cols.push({ c, label: h || t("sheet.sort.column", { col: colLetters(c) }) });
  }
  const ok = () => {
    sortRange(page.id, g, levels, header);
    setSel(page.id, { ar: g.r0 + (header ? 1 : 0), ac: sel.ac, r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1 });
    onClose();
  };
  return (
    <Modal labelledBy="sheet-sort-title" onClose={onClose} className="sheet-dlg">
      <h2 id="sheet-sort-title">{t("sheet.sort.title")}</h2>
      <div className="sheet-sort-bar">
        <button type="button" className="btn btn-ghost" onClick={() => setLevels([...levels, { col: g.c0, desc: false }])}>
          {t("sheet.sort.addLevel")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={levels.length < 2} onClick={() => setLevels(levels.slice(0, -1))}>
          {t("sheet.sort.delLevel")}
        </button>
        <label className="sheet-sort-head">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
          {t("sheet.sort.header")}
        </label>
      </div>
      <table className="sheet-sort-levels">
        <thead>
          <tr>
            <th />
            <th>{t("sheet.find.cell")}</th>
            <th>{t("sheet.sort.order")}</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((lv, i) => (
            <tr key={i}>
              <td>{t(i ? "sheet.sort.thenBy" : "sheet.sort.sortBy")}</td>
              <td>
                <select value={lv.col} onChange={(e) => setLevels(levels.map((x, j) => (j === i ? { ...x, col: Number(e.target.value) } : x)))}>
                  {cols.map((c) => (
                    <option key={c.c} value={c.c}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={lv.desc ? "d" : "a"} onChange={(e) => setLevels(levels.map((x, j) => (j === i ? { ...x, desc: e.target.value === "d" } : x)))}>
                  <option value="a">{t("sheet.sort.asc")}</option>
                  <option value="d">{t("sheet.sort.desc")}</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("sheet.dlg.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={ok}>
          {t("sheet.dlg.ok")}
        </button>
      </div>
    </Modal>
  );
}

// ───── Insert / Delete ─────

type LinesChoice = "right" | "down" | "left" | "up" | "row" | "col";
const LINES_KEYS: Record<LinesChoice, string> = { right: "i", down: "d", left: "l", up: "u", row: "r", col: "c" };

/** Excel's 삽입 / 삭제 box: 셀을 오른쪽으로·아래로 밀기 (삭제: 왼쪽으로·위로), 행 전체, 열 전체; the letters pick. */
function LinesDialog({ page, del, onClose }: { page: Page; del: boolean; onClose: () => void }) {
  const t = useT();
  const g0 = norm(selOf(page.id));
  const choices: LinesChoice[] = del ? ["left", "up", "row", "col"] : ["right", "down", "row", "col"];
  // (Excel: a selection wider than it is tall shifts down / up, otherwise right / left)
  const wide = g0.c1 - g0.c0 > g0.r1 - g0.r0;
  const [pick, setPick] = useState<LinesChoice>(del ? (wide ? "up" : "left") : wide ? "down" : "right");
  const ok = () => {
    onClose();
    if (pick === "row" || pick === "col") insertOrDelete(page.id, del, pick);
    else shiftCells(page.id, g0, pick);
  };
  const label: Record<LinesChoice, string> = { right: "sheetx.cells.right", down: "sheetx.cells.down", left: "sheetx.cells.left", up: "sheetx.cells.up", row: "sheetx.cells.rowAll", col: "sheetx.cells.colAll" };
  return (
    <Modal labelledBy="sheet-lines-title" onClose={onClose} className="sheet-dlg modal-sm">
      <div
        onKeyDown={(e) => {
          e.stopPropagation();
          const c = choices.find((x) => LINES_KEYS[x] === e.key.toLowerCase());
          if (c) setPick(c);
          else if (e.key === "Enter") ok();
          else return;
          e.preventDefault();
        }}
      >
      <h2 id="sheet-lines-title">{t(del ? "sheet.b.delete" : "sheet.b.insert")}</h2>
      <div className="sheet-radios" role="radiogroup">
        {choices.map((k) => (
          <label key={k}>
            <input type="radio" name="sheet-lines" checked={pick === k} onChange={() => setPick(k)} />
            {t(label[k])}
          </label>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("sheet.dlg.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          onClick={ok}
        >
          {t("sheet.dlg.ok")}
        </button>
      </div>
      </div>
    </Modal>
  );
}

// ───── AutoFilter menu ─────

/** 숫자 필터 / 텍스트 필터 items: the condition (OOXML operator + wildcards) and its label key */
const NUM_OPS: [string, string][] = [["equal", "eq"], ["notEqual", "ne"], ["greaterThan", "gt"], ["greaterThanOrEqual", "ge"], ["lessThan", "lt"], ["lessThanOrEqual", "le"], ["between", "between"], ["custom", "custom"]];
const TEXT_OPS: [string, string][] = [["equal", "eq"], ["notEqual", "ne"], ["begins", "begins"], ["ends", "ends"], ["contains", "contains"], ["notContains", "notContains"], ["custom", "custom"]];

/** 사용자 지정 자동 필터: two conditions with 그리고 / 또는 (text conditions as wildcards: 시작 문자 abc*, 포함 *abc*). */
function CustomFilterDialog({ page, col, table, op, text, onClose }: { page: Page; col: number; table?: string; op: string; text: boolean; onClose: () => void }) {
  const t = useT();
  const OPS: [string, string][] = text
    ? [["equal", "eq"], ["notEqual", "ne"], ["begins", "begins"], ["ends", "ends"], ["contains", "contains"], ["notContains", "notContains"], ["greaterThan", "gt"], ["lessThan", "lt"]]
    : [["equal", "eq"], ["notEqual", "ne"], ["greaterThan", "gt"], ["greaterThanOrEqual", "ge"], ["lessThan", "lt"], ["lessThanOrEqual", "le"]];
  const first = op === "between" ? "greaterThanOrEqual" : op === "custom" ? "equal" : op;
  const [a, setA] = useState({ op: first, val: "" });
  const [b, setB] = useState({ op: op === "between" ? "lessThanOrEqual" : "equal", val: "" });
  const [and, setAnd] = useState(true);
  const toItem = (x: { op: string; val: string }) =>
    x.op === "begins" ? { op: "equal" as const, val: `${x.val}*` } : x.op === "ends" ? { op: "equal" as const, val: `*${x.val}` } : x.op === "contains" ? { op: "equal" as const, val: `*${x.val}*` } : x.op === "notContains" ? { op: "notEqual" as const, val: `*${x.val}*` } : { op: x.op as "equal", val: x.val };
  const ok = () => {
    const items = [a, b].filter((x) => x.val !== "").map(toItem);
    onClose();
    if (items.length) setFilterCustom(page.id, col, { ...(and && items.length > 1 ? { and: true } : {}), items }, table);
  };
  const row = (x: { op: string; val: string }, set: (v: { op: string; val: string }) => void, first: boolean) => (
    <div className="sx-row sheet-cf-row">
      <select aria-label={t("sheetx.cf.op")} value={x.op} onChange={(e) => set({ ...x, op: e.target.value })}>
        {OPS.map(([o, k]) => (
          <option key={o} value={o}>
            {t(`sheetx.cf.op.${k}`)}
          </option>
        ))}
      </select>
      <input aria-label={t("sheetx.cf.value")} autoFocus={first} data-autofocus={first || undefined} value={x.val} onChange={(e) => set({ ...x, val: e.target.value })} />
    </div>
  );
  return (
    <Modal labelledBy="sheet-cf-title" onClose={onClose} className="sheet-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sheet-cf-title">{t("sheetx.cf.title")}</h2>
        <p className="sx-hint">{t("sheetx.cf.hint")}</p>
        {row(a, setA, true)}
        <div className="sheet-radios" role="radiogroup">
          <label>
            <input type="radio" name="sheet-cf-and" checked={and} onChange={() => setAnd(true)} />
            {t("sheetx.cf.and")}
          </label>
          <label>
            <input type="radio" name="sheet-cf-and" checked={!and} onChange={() => setAnd(false)} />
            {t("sheetx.cf.or")}
          </label>
        </div>
        {row(b, setB, false)}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("sheet.dlg.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={ok}>
            {t("sheet.dlg.ok")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FilterMenu({ page, col, table, x, y, onClose }: { page: Page; col: number; table?: string; x: number; y: number; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const f = filterOf(sh, table)!;
  const { values, blank } = useMemo(() => {
    // the values of the column with the other columns' filters applied (Excel lists what is reachable)
    const others = { ...f, cols: Object.fromEntries(Object.entries(f.cols ?? {}).filter(([k]) => Number(k) !== col)) };
    const g = parseRange(f.ref)!;
    const hidden = new Set(Object.keys(others.cols).length ? (sh.hiddenRows ?? []) : []);
    const vis = { ...sh, cells: Object.fromEntries(Object.entries(sh.cells).filter(([a]) => !hidden.has(parseAddr(a)!.r) || parseAddr(a)!.r === g.r0)) };
    return filterValues(vis, f, col, lang());
  }, [sh, f, col]);
  const cur = f.cols?.[col];
  // a column of numbers gets 숫자 필터, else 텍스트 필터 (Excel)
  const numeric = useMemo(() => {
    const g = parseRange(f.ref)!;
    let n = 0, s = 0;
    for (let r = g.r0 + 1; r <= Math.min(g.r1, g.r0 + 2000); r++) {
      const v = sh.cells[addr(r, g.c0 + col)]?.v;
      if (typeof v === "number") n++;
      else if (v !== undefined && v !== "") s++;
    }
    return n > s;
  }, [sh, f.ref, col]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(cur?.vals && !cur.other ? values.filter((v) => cur.vals!.some((w) => w.toLowerCase() === v.toLowerCase())) : values));
  const [blanks, setBlanks] = useState(cur?.vals && !cur.other ? !!cur.blank : true);
  const [search, setSearch] = useState("");
  const shown = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));
  const all = shown.every((v) => checked.has(v)) && (!blank || !!search || blanks);
  const { ref, style } = usePopPos(x, y);
  useDismiss(ref, onClose);
  const sortBy = (desc: boolean) => {
    const g = parseRange(f.ref)!;
    setSel(page.id, { ar: g.r0, ac: g.c0 + col, r0: g.r0, c0: g.c0 + col, r1: g.r0, c1: g.c0 + col });
    // a table sorts its own rows (header kept); the sheet's filter as before
    if (table) sortRange(page.id, g, [{ col: g.c0 + col, desc }], true);
    else quickSort(page.id, desc);
    onClose();
  };
  const ok = () => {
    const everything = values.every((v) => checked.has(v)) && (!blank || blanks);
    setFilterColumn(page.id, col, everything ? null : [...checked], blanks && blank, table);
    onClose();
  };
  return (
    <div ref={ref} className="menu-pop sheet-filter" role="dialog" style={style} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="menu-item" onClick={() => sortBy(false)}>
        <span className="menu-label">{t("sheet.b.sortAsc")}</span>
      </button>
      <button type="button" className="menu-item" onClick={() => sortBy(true)}>
        <span className="menu-label">{t("sheet.b.sortDesc")}</span>
      </button>
      <div className="menu-sep" role="separator" />
      <button
        type="button"
        className="menu-item"
        disabled={!cur}
        onClick={() => {
          setFilterColumn(page.id, col, null, false, table);
          onClose();
        }}
      >
        <span className="menu-label">{t("sheet.filter.clear")}</span>
      </button>
      {/* 숫자 필터 / 텍스트 필터: the conditions box, with the condition picked */}
      <details className="sheet-filter-cond">
        <summary className="menu-item">
          <span className="menu-label">{t(numeric ? "sheetx.cf.number" : "sheetx.cf.text")}</span>
        </summary>
        <div className="sheet-filter-conds">
          {(numeric ? NUM_OPS : TEXT_OPS).map(([op, key]) => (
            <button key={key} type="button" className="menu-item" onClick={() => openDlg({ kind: "customFilter", col, table, op, text: !numeric })}>
              <span className="menu-label">{t(`sheetx.cf.op.${key}`)}</span>
            </button>
          ))}
        </div>
      </details>
      <input className="sheet-filter-search" placeholder={t("sheet.filter.search")} aria-label={t("sheet.filter.search")} value={search} autoFocus data-autofocus onChange={(e) => setSearch(e.target.value)} />
      <div className="sheet-filter-list">
        <label>
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              const n = new Set(checked);
              for (const v of shown) e.target.checked ? n.add(v) : n.delete(v);
              setChecked(n);
              if (!search) setBlanks(e.target.checked);
            }}
          />
          {t("sheet.filter.all")}
        </label>
        {shown.map((v) => (
          <label key={v}>
            <input
              type="checkbox"
              checked={checked.has(v)}
              onChange={(e) => {
                const n = new Set(checked);
                e.target.checked ? n.add(v) : n.delete(v);
                setChecked(n);
              }}
            />
            {v}
          </label>
        ))}
        {blank && !search && (
          <label>
            <input type="checkbox" checked={blanks} onChange={(e) => setBlanks(e.target.checked)} />
            {t("sheet.filter.blanks")}
          </label>
        )}
      </div>
      <div className="sheet-filter-actions">
        <button type="button" className="btn btn-primary" disabled={!checked.size && !blanks} onClick={ok}>
          {t("sheet.dlg.ok")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("sheet.dlg.cancel")}
        </button>
      </div>
    </div>
  );
}

// ───── data validation ─────

function ListPopup({ page, r, c, x, y, onClose }: { page: Page; r: number; c: number; x: number; y: number; onClose: () => void }) {
  const t = useT();
  const pages = useStore((s) => s.doc.pages);
  const sh = page.sheet!;
  const v = (sh.valid ?? []).find((x2) => x2.ranges.some((rg) => {
    const g = parseRange(rg);
    return g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  }));
  const items = v ? listItems(pages, sh, v) : [];
  const cur = shownText(sh, sh.cells[addr(r, c)], lang());
  const { ref, style } = usePopPos(x, y);
  useDismiss(ref, onClose);
  const pick = (s: string) => {
    enterText(page.id, r, c, s);
    onClose();
  };
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".on, button")?.focus();
  }, [ref]);
  return (
    <div
      ref={ref}
      className="menu-pop sheet-list"
      role="listbox"
      aria-label={t("sheet.valid.list")}
      style={style}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const bs = Array.from(ref.current?.querySelectorAll("button") ?? []);
        const i = bs.indexOf(document.activeElement as HTMLButtonElement);
        bs[Math.max(0, Math.min(bs.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }}
    >
      {items.map((s, i) => (
        <button key={i} type="button" role="option" aria-selected={s === cur} className={cx("menu-item", s === cur && "on")} onClick={() => pick(s)}>
          <span className="menu-label">{s}</span>
        </button>
      ))}
    </div>
  );
}

function InvalidDialog({ dlg }: { dlg: Extract<SheetDlg, { kind: "invalid" }> }) {
  const t = useT();
  const v = dlg.v;
  const style = v.errStyle ?? "stop";
  const run = (f: () => void) => () => {
    close();
    f();
  };
  return (
    <Modal labelledBy="sheet-invalid-title" onClose={run(dlg.retry)} className="sheet-dlg modal-sm">
      <h2 id="sheet-invalid-title">{v.errTitle || t("sheet.valid.title")}</h2>
      <p className="modal-text">{v.error || t("sheet.valid.msg")}</p>
      {style === "warning" && <p className="modal-text">{t("sheet.valid.continue")}</p>}
      <div className="modal-actions">
        {style === "stop" ? (
          <button type="button" className="btn btn-primary" data-autofocus onClick={run(dlg.retry)}>
            {t("sheet.valid.retry")}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" data-autofocus onClick={run(dlg.accept)}>
            {style === "warning" ? t("sheet.valid.yes") : t("sheet.dlg.ok")}
          </button>
        )}
        {style === "warning" && (
          <button type="button" className="btn btn-ghost" onClick={run(dlg.retry)}>
            {t("sheet.valid.no")}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={run(dlg.cancel)}>
          {t("sheet.dlg.cancel")}
        </button>
      </div>
    </Modal>
  );
}

// ───── right-click menu ─────

function ContextMenu({ page, x, y, head, onClose }: { page: Page; x: number; y: number; head: "col" | "row" | null; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const sel = selOf(page.id);
  const g = norm(sel);
  const a = addr(sel.ar, sel.ac);
  const note = sh.notes?.[a];
  const { ref, style } = usePopPos(x, y);
  useDismiss(ref, onClose);
  const item = (label: string, run: () => void, opts: { disabled?: boolean; kbd?: string } = {}) => (
    <button
      type="button"
      className="menu-item"
      disabled={opts.disabled}
      onClick={() => {
        onClose();
        run();
      }}
    >
      <span className="menu-label">{label}</span>
      {opts.kbd && <kbd>{opts.kbd}</kbd>}
    </button>
  );
  const sep = (k: string) => <div key={k} className="menu-sep" role="separator" />;
  const lines = (del: boolean) => () => {
    if (head) changeLines(page.id, head === "row" ? { axis: "row", at: g.r0, n: (del ? -1 : 1) * (g.r1 - g.r0 + 1) } : { axis: "col", at: g.c0, n: (del ? -1 : 1) * (g.c1 - g.c0 + 1) });
    else insertOrDelete(page.id, del);
  };
  return (
    <div ref={ref} className="menu-pop" role="menu" style={style} onKeyDown={(e) => e.stopPropagation()}>
      {/* Excel's cell menu starts with the clipboard (QA 2026-11-24: it had none of it) */}
      {item(t("sheet.menu.cut"), () => copyFromMenu(page.id, g, true), { kbd: "Ctrl+X" })}
      {item(t("sheet.menu.copy"), () => copyFromMenu(page.id, g, false), { kbd: "Ctrl+C" })}
      {item(t("sheet.menu.paste"), () => void pasteFromMenu(page.id, { r: sel.ar, c: sel.ac }).then((area) => area && setSel(page.id, { ...sel, r0: area.r0, c0: area.c0, r1: area.r1, c1: area.c1 })), { kbd: "Ctrl+V" })}
      {item(t("sheet.menu.pasteValues"), () => {
        const area = pasteValues(page.id, { r: sel.ar, c: sel.ac });
        if (area) setSel(page.id, { ...sel, r0: area.r0, c0: area.c0, r1: area.r1, c1: area.c1 });
      }, { disabled: !useSheetClip.getState().clip || useSheetClip.getState().clip!.cut })}
      {item(t("sheetx.ps.menu"), () => openDlg({ kind: "pasteSpecial" }), { kbd: "Ctrl+Alt+V", disabled: !useSheetClip.getState().clip || useSheetClip.getState().clip!.cut })}
      {sep("s0")}
      {item(t("sheet.b.insert"), lines(false), { kbd: "Ctrl++" })}
      {item(t("sheet.b.delete"), lines(true), { kbd: "Ctrl+-" })}
      {head && item(t("sheetx.hide"), () => hideLines(page.id, head, g, true))}
      {head && item(t("sheetx.unhide"), () => hideLines(page.id, head, g, false))}
      {item(t("sheet.menu.clear"), () => clearRange(page.id, g), { kbd: "Delete" })}
      {sep("sx0")}
      {item(t("sheetx.fmt.title") + "…", () => openDlg({ kind: "fmt" }), { kbd: "Ctrl+1" })}
      {!head && item(sh.links?.[a] ? t("sheetx.link.edit") + "…" : t("sheetx.link.title") + "…", () => openDlg({ kind: "link" }), { kbd: "Ctrl+K" })}
      {!head && item(t("sheetx.name.define") + "…", () => openDlg({ kind: "name" }))}
      {!head && (
        <>
          {sep("s1")}
          {item(t("sheet.b.sortAsc"), () => quickSort(page.id, false))}
          {item(t("sheet.b.sortDesc"), () => quickSort(page.id, true))}
          {item(t("sheet.b.customSort"), () => openDlg({ kind: "sort" }))}
          {item(t("sheet.b.filter"), () => toggleFilter(page.id), { kbd: "Ctrl+Shift+L" })}
          {sep("s2")}
          {item(note ? t("sheet.note.edit") : t("sheet.note.new"), () => openDlg({ kind: "note", a }), { disabled: !!note?.threaded, kbd: "Shift+F2" })}
          {note && item(t("sheet.note.delete"), () => setNote(page.id, a, null), { disabled: !!note.threaded })}
          {sep("s3")}
          {item(t("sheet.b.fillDown"), () => fillDir(page.id, "down"), { kbd: "Ctrl+D" })}
          {item(t("sheet.b.fillRight"), () => fillDir(page.id, "right"), { kbd: "Ctrl+R" })}
        </>
      )}
    </div>
  );
}

// ───── note editor and note on hover ─────

export function NoteEditor({ page, a, box, onDone }: { page: Page; a: string; box: { x: number; y: number }; onDone: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const [text, setText] = useState(sh.notes?.[a]?.text ?? "");
  const save = () => {
    setNote(page.id, a, text.trim() ? text : null);
    onDone();
  };
  return (
    <textarea
      className="sheet-note sheet-note-edit"
      style={{ left: box.x, top: box.y }}
      aria-label={t("sheet.note.label")}
      autoFocus data-autofocus
      value={text}
      spellCheck={false}
      // (Excel: an existing note opens with the caret after its text)
      onFocus={(e) => {
        const n = e.target.value.length;
        e.target.setSelectionRange(n, n);
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          save();
        }
      }}
    />
  );
}

export function NoteTip({ text, author, box }: { text: string; author?: string; box: { x: number; y: number } }) {
  return (
    <div className="sheet-note" style={{ left: box.x, top: box.y }} role="note">
      {author && !text.startsWith(author) && <b>{author}:</b>}
      {author && !text.startsWith(author) && "\n"}
      {text}
    </div>
  );
}
