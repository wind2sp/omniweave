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
import { Modal } from "../shell/Dialogs";
import { cx } from "../shell/controls";
import { clearRange, enterText, lang, norm, selOf, setSel } from "./sheetActions";
import {
  changeLines,
  doFindAll,
  doFindNext,
  doReplace,
  doReplaceAll,
  fillDir,
  insertOrDelete,
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
      return <FilterMenu page={page} col={dlg.col} x={dlg.x} y={dlg.y} onClose={done} />;
    case "list":
      return <ListPopup page={page} r={dlg.r} c={dlg.c} x={dlg.x} y={dlg.y} onClose={done} />;
    case "invalid":
      return <InvalidDialog dlg={dlg} />;
    case "menu":
      return <ContextMenu page={page} x={dlg.x} y={dlg.y} head={dlg.head} onClose={done} />;
    case "note":
      return null; // drawn by the grid beside the cell (NoteEditor)
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
        <input autoFocus value={q} onChange={(e) => set({ q: e.target.value })} onFocus={(e) => e.target.select()} />
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
        <button type="button" className="btn btn-ghost" disabled={!q} onClick={() => doFindAll(page.id)}>
          {t("sheet.find.findAll")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!q} onClick={() => doFindNext(page.id)}>
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

function LinesDialog({ page, del, onClose }: { page: Page; del: boolean; onClose: () => void }) {
  const t = useT();
  const [axis, setAxis] = useState<"row" | "col">("row");
  return (
    <Modal labelledBy="sheet-lines-title" onClose={onClose} className="sheet-dlg modal-sm">
      <h2 id="sheet-lines-title">{t(del ? "sheet.b.delete" : "sheet.b.insert")}</h2>
      <div className="sheet-radios">
        {(["row", "col"] as const).map((k) => (
          <label key={k}>
            <input type="radio" name="sheet-lines" checked={axis === k} onChange={() => setAxis(k)} />
            {t(k === "row" ? "sheet.dlg.entireRow" : "sheet.dlg.entireCol")}
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
          onClick={() => {
            onClose();
            insertOrDelete(page.id, del, axis);
          }}
        >
          {t("sheet.dlg.ok")}
        </button>
      </div>
    </Modal>
  );
}

// ───── AutoFilter menu ─────

function FilterMenu({ page, col, x, y, onClose }: { page: Page; col: number; x: number; y: number; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const f = sh.filter!;
  const { values, blank } = useMemo(() => {
    // the values of the column with the other columns' filters applied (Excel lists what is reachable)
    const others = { ...f, cols: Object.fromEntries(Object.entries(f.cols ?? {}).filter(([k]) => Number(k) !== col)) };
    const g = parseRange(f.ref)!;
    const hidden = new Set(Object.keys(others.cols).length ? (sh.hiddenRows ?? []) : []);
    const vis = { ...sh, cells: Object.fromEntries(Object.entries(sh.cells).filter(([a]) => !hidden.has(parseAddr(a)!.r) || parseAddr(a)!.r === g.r0)) };
    return filterValues(vis, f, col, lang());
  }, [sh, f, col]);
  const cur = f.cols?.[col];
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
    quickSort(page.id, desc);
    onClose();
  };
  const ok = () => {
    const everything = values.every((v) => checked.has(v)) && (!blank || blanks);
    setFilterColumn(page.id, col, everything ? null : [...checked], blanks && blank);
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
          setFilterColumn(page.id, col, null);
          onClose();
        }}
      >
        <span className="menu-label">{t("sheet.filter.clear")}</span>
      </button>
      <input className="sheet-filter-search" placeholder={t("sheet.filter.search")} aria-label={t("sheet.filter.search")} value={search} autoFocus onChange={(e) => setSearch(e.target.value)} />
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
      {item(t("sheet.b.insert"), lines(false), { kbd: "Ctrl++" })}
      {item(t("sheet.b.delete"), lines(true), { kbd: "Ctrl+-" })}
      {item(t("sheet.menu.clear"), () => clearRange(page.id, g), { kbd: "Delete" })}
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
      autoFocus
      value={text}
      spellCheck={false}
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
