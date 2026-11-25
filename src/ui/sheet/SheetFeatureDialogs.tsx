// Excel's dialogs of the sheet ribbon tabs (표 계산 대화 상자 3단계): 셀 서식 (Ctrl+1: 표시 형식 · 맞춤 · 글꼴 · 테두리 ·
// 채우기 · 보호), 조건부 서식 새 규칙 / 규칙 관리, 데이터 유효성 검사 (설정 · 설명 메시지 · 오류 메시지), 중복된 항목 제거,
// 텍스트 나누기, 하이퍼링크 (Ctrl+K), 시트 보호 / 해제, 통합 문서 보호, 페이지 설정 (페이지 · 여백 · 머리글/바닥글 · 시트),
// 이름 정의 / 이름 관리자, 차트 편집, 피벗 테이블 만들기, 함수 삽입, and the chart's right-click menu. Commands:
// ui/sheet/sheetFeatures.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PivotFn, SheetBorder, SheetChartSpec, SheetCondRule, SheetPrint, SheetStyle, SheetValidation } from "../../core/sheetTypes";
import type { Page } from "../../core/types";
import { useStore } from "../../core/store";
import { t as tt, useT } from "../../i18n";
import { addr, colLetters, parseAddr, parseRange, rangeText } from "../../io/sheet/formula";
import { formatValue } from "../../io/sheet/numfmt";
import { periodFormula } from "../../io/sheet/writeParts";
import { guessHeader, shownText } from "../../io/sheet/sortFilter";
import { FUNCTIONS } from "../../io/sheet/functions";
import { FILL_LISTS, USER_LISTS } from "../../io/sheet/fill";
import { ICON_SETS } from "../../render/sheetIcons";
import { Modal } from "../shell/Dialogs";
import { cx } from "../shell/controls";
import { FONTS } from "../shell/Ribbon";
import { bookPages, formatRange, lang, norm, pasteSpecial, selOf, setCells, setSel, styleAt, toggleMerge, type PasteOp, type PasteWhat } from "./sheetActions";
import {
  absRef,
  addCondRule,
  insertSlicers,
  slicerSourceAt,
  addSparklines,
  createTable,
  goalSeek,
  goSpecial,
  goTo,
  fillSeries,
  moveCopySheet,
  type GoSpecial,
  evalSteps,
  consolidate,
  type ConsolFn,
  saveScenario,
  deleteScenario,
  showScenario,
  scenarioSummary,
  dataTable,
  saveUserLists,
  postThread,
  resolveThread,
  deleteThread,
  groupLines,
  nextError,
  subtotals,
  SUBTOTAL_FNS,
  dataArea,
  DEFAULT_MARGINS,
  defineName,
  deleteCondRule,
  replaceCondRule,
  deleteDrawing,
  protectBook,
  protectSheet,
  removeDuplicates,
  selArea,
  setLink,
  setPrint,
  setValidation,
  splitText,
  startCellEdit,
  textToColumns,
  unprotectSheet,
  updateChart,
  writePivot,
  type SplitOpts,
} from "./sheetFeatures";
import { openDlg, type SheetDlg } from "./sheetEdit";

const S = () => useStore.getState();

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="sheet-find-tabs" role="tablist">
      {tabs.map((x) => (
        <button key={x.id} type="button" role="tab" aria-selected={value === x.id} className={cx(value === x.id && "on")} onClick={() => onChange(x.id)}>
          {x.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="sx-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="sx-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Actions({ onClose, onOk, okLabel, extra, disabled }: { onClose: () => void; onOk: () => void; okLabel?: string; extra?: React.ReactNode; disabled?: boolean }) {
  const t = useT();
  return (
    <div className="modal-actions">
      {extra}
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        {t("sheet.dlg.cancel")}
      </button>
      <button type="button" className="btn btn-primary" data-autofocus disabled={disabled} onClick={onOk}>
        {okLabel ?? t("sheet.dlg.ok")}
      </button>
    </div>
  );
}

const stop = (e: React.KeyboardEvent) => e.stopPropagation();

export function FeatureDialog({ page, dlg, onClose }: { page: Page; dlg: SheetDlg; onClose: () => void }) {
  switch (dlg.kind) {
    case "fmt":
      return <FormatCells page={page} tab0={dlg.tab ?? "number"} onClose={onClose} />;
    case "cond":
      return <CondRule page={page} type={dlg.type} edit={dlg.edit} onClose={onClose} />;
    case "condMgr":
      return <CondManager page={page} onClose={onClose} />;
    case "valid":
      return <Validation page={page} onClose={onClose} />;
    case "dedupe":
      return <Dedupe page={page} onClose={onClose} />;
    case "split":
      return <Split page={page} onClose={onClose} />;
    case "link":
      return <LinkDialog page={page} onClose={onClose} />;
    case "protect":
      return <ProtectDialog page={page} onClose={onClose} />;
    case "unprotect":
    case "book":
      return <PasswordDialog page={page} kind={dlg.kind} onClose={onClose} />;
    case "page":
      return <PageSetup page={page} tab0={dlg.tab ?? "page"} onClose={onClose} />;
    case "name":
      // (opened from 이름 관리자: back to the manager when done, as in Excel)
      return <NameDialog page={page} edit={dlg.edit} onClose={dlg.from === "names" ? () => openDlg({ kind: "names" }) : onClose} />;
    case "names":
      return <NameManager page={page} onClose={onClose} />;
    case "chart":
      return <ChartDialog page={page} i={dlg.i} onClose={onClose} />;
    case "pivot":
      return <PivotDialog page={page} onClose={onClose} />;
    case "fn":
      return <FnDialog onClose={onClose} />;
    case "pasteSpecial":
      return <PasteSpecialDialog page={page} onClose={onClose} />;
    case "table":
      return <TableCreate page={page} style={dlg.style} onClose={onClose} />;
    case "group":
      return <GroupDialog page={page} ungroup={dlg.ungroup} onClose={onClose} />;
    case "subtotal":
      return <SubtotalDialog page={page} onClose={onClose} />;
    case "goalSeek":
      return <GoalSeekDialog page={page} onClose={onClose} />;
    case "goTo":
      return <GoToDialog page={page} onClose={onClose} />;
    case "goSpecial":
      return <GoSpecialDialog page={page} onClose={onClose} />;
    case "moveCopy":
      return <MoveCopyDialog page={page} pageId={dlg.pageId} onClose={onClose} />;
    case "series":
      return <SeriesDialog page={page} onClose={onClose} />;
    case "evalFormula":
      return <EvalFormulaDialog page={page} onClose={onClose} />;
    case "consol":
      return <ConsolidateDialog page={page} onClose={onClose} />;
    case "scenarios":
      return <ScenarioManager page={page} onClose={onClose} />;
    case "scenarioEdit":
      return <ScenarioEdit page={page} i={dlg.i} onClose={onClose} />;
    case "dataTable":
      return <DataTableDialog page={page} onClose={onClose} />;
    case "customLists":
      return <CustomListsDialog onClose={onClose} />;
    case "thread":
      return <ThreadDialog page={page} a={dlg.a} onClose={onClose} />;
    case "errCheck":
      return <ErrorCheckDialog page={page} onClose={onClose} />;
    case "slicer":
      return <SlicerDialog page={page} onClose={onClose} />;
    case "spark":
      return <SparkDialog page={page} type={dlg.type} onClose={onClose} />;
    case "chartMenu":
      return <ChartMenu page={page} i={dlg.i} x={dlg.x} y={dlg.y} onClose={onClose} />;
    default:
      return null;
  }
}

// ───── 셀 서식 (Ctrl+1) ─────

type NumCat = "general" | "number" | "currency" | "accounting" | "date" | "time" | "percent" | "fraction" | "scientific" | "text" | "special" | "custom";
const CATS: NumCat[] = ["general", "number", "currency", "accounting", "date", "time", "percent", "fraction", "scientific", "text", "special", "custom"];

/** The category a number format belongs to (as Excel's list shows it). */
export function catOf(fmt: string | undefined): NumCat {
  const f = fmt ?? "General";
  if (f === "General") return "general";
  if (f === "@") return "text";
  const plain = f.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  if (/[yd]|m{3,}/i.test(plain) || /^(yyyy|m\/d|d)/i.test(plain)) return "date";
  if (/[hs]/i.test(plain)) return "time";
  if (/%/.test(plain)) return "percent";
  if (/E\+/i.test(plain)) return "scientific";
  if (/\?\/\?/.test(plain)) return "fraction";
  if (/^_[-(]/.test(f) || /\*/.test(f)) return "accounting";
  if (/[₩$¥€]/.test(f)) return "currency";
  if (/^[#0,.;\-()\s]+$/.test(plain)) return "number";
  return "custom";
}

const DATE_CODES: Record<string, string[]> = {
  ko: ["yyyy-mm-dd", 'yyyy"년" m"월" d"일"', 'yyyy"년" m"월" d"일" dddd', "yy-mm-dd", "m/d", "mm-dd", 'm"월" d"일"', "yyyy-mm-dd h:mm", "mmm-yy"], // i18n: keep — format codes
  en: ["m/d/yyyy", "dddd, mmmm d, yyyy", "m/d", "m/d/yy", "mm/dd/yy", "d-mmm", "d-mmm-yy", "mmm-yy", "m/d/yy h:mm"],
  ja: ["yyyy/m/d", 'yyyy"年"m"月"d"日"', "m/d", 'm"月"d"日"', "yyyy/m/d h:mm"],
  zh: ["yyyy/m/d", 'yyyy"年"m"月"d"日"', "m/d", 'm"月"d"日"', "yyyy/m/d h:mm"],
};
const TIME_CODES = ["h:mm", "h:mm:ss", "h:mm AM/PM", "h:mm:ss AM/PM", "[h]:mm:ss", "mm:ss"];
const CUSTOM_CODES = ["0", "0.00", "#,##0", "#,##0.00", "#,##0;-#,##0", "#,##0;[Red]-#,##0", "0%", "0.00%", "0.00E+00", "# ?/?", "@", 'yyyy-mm-dd', "h:mm:ss", '#,##0"원"']; // i18n: keep — format codes

function numberCode(cat: NumCat, o: { dec: number; sep: boolean; neg: number; sym: string; date: string; time: string; custom: string; frac: string }): string | undefined {
  const d = o.dec ? "." + "0".repeat(o.dec) : "";
  const body = (o.sep ? "#,##0" : "0") + d;
  const negs = [`${body};-${body}`, `${body};[Red]${body}`, `${body};[Red]-${body}`, `${body}_);(${body})`, `${body}_);[Red](${body})`];
  switch (cat) {
    case "general":
      return undefined;
    case "number":
      return o.neg ? negs[o.neg] : body;
    case "currency": {
      const s = o.sym ? `"${o.sym}"` : "";
      const b = `${s}#,##0${d}`;
      return o.neg === 1 ? `${b};[Red]${b}` : o.neg === 2 ? `${b};[Red]-${b}` : b;
    }
    case "accounting": {
      const s = o.sym ? `"${o.sym}"` : "";
      return `_-${s}* #,##0${d}_-;-${s}* #,##0${d}_-;_-${s}* "-"${o.dec ? "?".repeat(o.dec) : ""}_-;_-@_-`;
    }
    case "date":
      return o.date;
    case "time":
      return o.time;
    case "percent":
      return "0" + d + "%";
    case "fraction":
      return o.frac;
    case "scientific":
      return "0" + d + "E+00";
    case "text":
      return "@";
    case "special":
      return o.custom || "000-0000-0000";
    default:
      return o.custom || undefined;
  }
}

type Sides = "bl" | "br" | "bt" | "bb";
const FONT_SAMPLE = "AaBbCc 가나다"; // i18n: keep — a font sample, not UI text

function FormatCells({ page, tab0, onClose }: { page: Page; tab0: string; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const sel = selOf(page.id);
  const g = norm(sel);
  const st0 = styleAt(sh, sel.ar, sel.ac);
  const [tab, setTab] = useState(tab0);
  const [st, setSt] = useState<SheetStyle>({ ...st0 });
  const touched = useRef(new Set<keyof SheetStyle>());
  const set = (p: Partial<SheetStyle>) => {
    for (const k of Object.keys(p) as (keyof SheetStyle)[]) touched.current.add(k);
    setSt((s) => ({ ...s, ...p }));
  };
  const [merge, setMerge] = useState<boolean | null>(null);
  // number tab
  const lng = lang();
  const [cat, setCat] = useState<NumCat>(catOf(st0.fmt));
  const decOf = (f?: string) => /\.(0+)/.exec(f ?? "")?.[1].length ?? (catOf(f) === "currency" || catOf(f) === "accounting" ? (lng === "en" ? 2 : 0) : 2);
  const [opt, setOpt] = useState({
    dec: st0.fmt ? decOf(st0.fmt) : 2,
    sep: /#,##0/.test(st0.fmt ?? ""),
    neg: 0,
    sym: /"([^"]*)"/.exec(st0.fmt ?? "")?.[1] ?? (lng === "ko" ? "₩" : lng === "en" ? "$" : "¥"),
    date: catOf(st0.fmt) === "date" ? st0.fmt! : DATE_CODES[lng][0],
    time: catOf(st0.fmt) === "time" ? st0.fmt! : TIME_CODES[1],
    custom: st0.fmt ?? "General",
    frac: catOf(st0.fmt) === "fraction" ? st0.fmt! : "# ?/?",
  });
  const setO = (p: Partial<typeof opt>) => {
    touched.current.add("fmt");
    const next = { ...opt, ...p };
    setOpt(next);
    setSt((s) => ({ ...s, fmt: numberCode(cat, next) }));
  };
  const pickCat = (c: NumCat) => {
    touched.current.add("fmt");
    setCat(c);
    const next = { ...opt, dec: c === "currency" || c === "accounting" ? (lng === "en" ? 2 : 0) : c === "percent" ? 0 : opt.dec, custom: c === "custom" ? st.fmt ?? "General" : opt.custom };
    setOpt(next);
    setSt((s) => ({ ...s, fmt: numberCode(c, next) }));
  };
  const cell = sh.cells[addr(sel.ar, sel.ac)];
  const sample = cell?.v !== undefined ? formatValue(cell.v as number, st.fmt, { date1904: sh.date1904, lang: lng }).text : "";
  // border tab
  const [line, setLine] = useState<SheetBorder>({ style: "thin", color: "#000000" });
  const [inner, setInner] = useState<{ h?: SheetBorder | null; v?: SheetBorder | null }>({});
  const side = (k: Sides) => set({ [k]: st[k] ? undefined : line } as Partial<SheetStyle>);
  const ok = () => {
    const keys = [...touched.current];
    if (keys.length)
      formatRange(page.id, g, (s) => {
        const out = { ...s };
        for (const k of keys) (out as Record<string, unknown>)[k] = st[k];
        return out;
      });
    // inside lines (가로 / 세로 안쪽): the cells' bottom / right edges inside the range
    if (inner.h !== undefined && g.r1 > g.r0) formatRange(page.id, { ...g, r1: g.r1 - 1 }, (s) => ({ ...s, bb: inner.h ?? undefined }));
    if (inner.v !== undefined && g.c1 > g.c0) formatRange(page.id, { ...g, c1: g.c1 - 1 }, (s) => ({ ...s, br: inner.v ?? undefined }));
    const merged = sh.merges.some((m) => {
      const q = parseRange(m)!;
      return q.r0 === g.r0 && q.c0 === g.c0 && q.r1 === g.r1 && q.c1 === g.c1;
    });
    if (merge !== null && merge !== merged) toggleMerge(page.id, g);
    onClose();
  };
  const fontOpts = FONTS.includes(st.font ?? sh.baseFont) ? FONTS : [st.font ?? sh.baseFont, ...FONTS];
  const COLORS = ["#000000", "#FFFFFF", "#E7E6E6", "#44546A", "#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#C00000", "#FF0000", "#FFFF00", "#92D050", "#00B050", "#00B0F0", "#0070C0", "#002060", "#7030A0", "#F2F2F2", "#FCE4D6", "#FFF2CC", "#E2EFDA", "#DDEBF7"];
  return (
    <Modal labelledBy="sx-fmt-title" onClose={onClose} className="sheet-dlg sx-dlg sx-wide">
      <div onKeyDown={stop}>
        <h2 id="sx-fmt-title">{t("sheetx.fmt.title")}</h2>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={(["number", "align", "font", "border", "fill", "protect"] as const).map((id) => ({ id, label: t(`sheetx.fmt.tab.${id}`) }))}
        />
        {tab === "number" && (
          <div className="sx-split">
            <div className="sx-list" role="listbox" aria-label={t("sheetx.fmt.category")}>
              {CATS.map((c) => (
                <button key={c} type="button" role="option" aria-selected={cat === c} className={cx(cat === c && "on")} onClick={() => pickCat(c)}>
                  {t(`sheetx.fmt.cat.${c}`)}
                </button>
              ))}
            </div>
            <div className="sx-pane">
              <div className="sx-sample">
                <span>{t("sheetx.fmt.sample")}</span>
                <b>{sample || " "}</b>
              </div>
              {["number", "currency", "accounting", "percent", "scientific"].includes(cat) && (
                <Row label={t("sheetx.fmt.decimals")}>
                  <input type="number" min={0} max={30} value={opt.dec} onChange={(e) => setO({ dec: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })} />
                </Row>
              )}
              {cat === "number" && <Check label={t("sheetx.fmt.sep")} checked={opt.sep} onChange={(v) => setO({ sep: v })} />}
              {(cat === "currency" || cat === "accounting") && (
                <Row label={t("sheetx.fmt.symbol")}>
                  <select value={opt.sym} onChange={(e) => setO({ sym: e.target.value })}>
                    {["", "₩", "$", "¥", "€", "£", "CN¥"].map((x) => (
                      <option key={x} value={x}>
                        {x || t("sheetx.fmt.none")}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
              {(cat === "number" || cat === "currency") && (
                <Row label={t("sheetx.fmt.negative")}>
                  <select value={opt.neg} onChange={(e) => setO({ neg: Number(e.target.value) })}>
                    {(cat === "number" ? ["-1234.10", "1234.10 (red)", "-1234.10 (red)", "(1234.10)", "(1234.10) (red)"] : ["-1234.10", "1234.10 (red)", "-1234.10 (red)"]).map((x, i) => (
                      <option key={i} value={i}>
                        {x.replace("(red)", t("sheetx.fmt.red"))}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
              {(cat === "date" || cat === "time" || cat === "fraction") && (
                <div className="sx-list sx-codes" role="listbox">
                  {(cat === "date" ? DATE_CODES[lng] : cat === "time" ? TIME_CODES : ["# ?/?", "# ??/??", "# ???/???", "# ?/2", "# ?/4", "# ?/8", "# ??/16", "# ?/10", "# ??/100"]).map((code) => {
                    const cur = cat === "date" ? opt.date : cat === "time" ? opt.time : opt.frac;
                    const demo = formatValue(cat === "fraction" ? 1.25 : cat === "time" ? 0.5625 : 46296.5625, code, { lang: lng }).text;
                    return (
                      <button key={code} type="button" className={cx(cur === code && "on")} onClick={() => setO(cat === "date" ? { date: code } : cat === "time" ? { time: code } : { frac: code })}>
                        {demo}
                      </button>
                    );
                  })}
                </div>
              )}
              {(cat === "custom" || cat === "special") && (
                <>
                  <Row label={t("sheetx.fmt.type")}>
                    <input value={opt.custom} spellCheck={false} onChange={(e) => setO({ custom: e.target.value })} />
                  </Row>
                  <div className="sx-list sx-codes" role="listbox">
                    {CUSTOM_CODES.map((code) => (
                      <button key={code} type="button" className={cx(opt.custom === code && "on")} onClick={() => setO({ custom: code })}>
                        {code}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="sx-hint">{t(`sheetx.fmt.hint.${cat}`)}</p>
            </div>
          </div>
        )}
        {tab === "align" && (
          <div className="sx-grid2">
            <Row label={t("sheetx.fmt.horizontal")}>
              <select value={st.h ?? ""} onChange={(e) => set({ h: (e.target.value || undefined) as SheetStyle["h"] })}>
                {["", "left", "center", "right", "fill", "justify", "centerContinuous", "distributed"].map((x) => (
                  <option key={x} value={x}>
                    {t(`sheetx.fmt.h.${x || "general"}`)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("sheetx.fmt.vertical")}>
              <select value={st.v ?? "bottom"} onChange={(e) => set({ v: e.target.value === "bottom" ? undefined : (e.target.value as SheetStyle["v"]) })}>
                {["top", "center", "bottom", "justify", "distributed"].map((x) => (
                  <option key={x} value={x}>
                    {t(`sheetx.fmt.v.${x}`)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("sheetx.fmt.indent")}>
              <input type="number" min={0} max={15} value={st.indent ?? 0} onChange={(e) => set({ indent: Number(e.target.value) || undefined })} />
            </Row>
            <Row label={t("sheetx.fmt.rotation")}>
              <input type="number" min={-90} max={90} value={st.rot ? (st.rot > 90 ? 90 - st.rot : st.rot) : 0} onChange={(e) => {
                const d = Math.max(-90, Math.min(90, Number(e.target.value) || 0));
                set({ rot: d < 0 ? 90 - d : d || undefined });
              }} />
            </Row>
            <Check label={t("sheet.b.wrap")} checked={!!st.wrap} onChange={(v) => set({ wrap: v || undefined })} />
            <Check label={t("sheetx.fmt.shrink")} checked={!!st.shrink} onChange={(v) => set({ shrink: v || undefined })} />
            <Check label={t("sheetx.fmt.merge")} checked={merge ?? sh.merges.some((m) => { const q = parseRange(m)!; return q.r0 === g.r0 && q.c0 === g.c0 && q.r1 === g.r1 && q.c1 === g.c1; })} onChange={setMerge} />
          </div>
        )}
        {tab === "font" && (
          <div className="sx-grid2">
            <Row label={t("sheet.b.font")}>
              <select value={st.font ?? sh.baseFont} onChange={(e) => set({ font: e.target.value === sh.baseFont ? undefined : e.target.value })}>
                {fontOpts.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("sheetx.fmt.fontStyle")}>
              <select value={(st.bold ? "b" : "") + (st.italic ? "i" : "")} onChange={(e) => set({ bold: e.target.value.includes("b") || undefined, italic: e.target.value.includes("i") || undefined })}>
                {["", "i", "b", "bi"].map((x) => (
                  <option key={x} value={x}>
                    {t(`sheetx.fmt.style.${x || "regular"}`)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("sheet.b.size")}>
              <input type="number" min={1} max={409} step={0.5} value={st.size ?? sh.baseSize} onChange={(e) => set({ size: Number(e.target.value) === sh.baseSize ? undefined : Number(e.target.value) || undefined })} />
            </Row>
            <Row label={t("sheetx.fmt.underline")}>
              <select value={st.underline ?? ""} onChange={(e) => set({ underline: (e.target.value || undefined) as SheetStyle["underline"] })}>
                <option value="">{t("sheetx.fmt.none")}</option>
                <option value="single">{t("sheetx.fmt.single")}</option>
                <option value="double">{t("sheetx.fmt.double")}</option>
              </select>
            </Row>
            <Row label={t("sheet.b.fontColor")}>
              <input type="color" value={st.color ?? "#000000"} onChange={(e) => set({ color: e.target.value.toLowerCase() === "#000000" ? undefined : e.target.value })} />
            </Row>
            <Check label={t("ribbon.text.strike")} checked={!!st.strike} onChange={(v) => set({ strike: v || undefined })} />
            <div className="sx-sample sx-font-sample" style={{ fontFamily: st.font ?? sh.baseFont, fontWeight: st.bold ? 700 : 400, fontStyle: st.italic ? "italic" : "normal", textDecoration: [st.underline ? "underline" : "", st.strike ? "line-through" : ""].join(" "), color: st.color ?? "#000", fontSize: Math.min(28, ((st.size ?? sh.baseSize) * 96) / 72) }}>
              {FONT_SAMPLE}
            </div>
          </div>
        )}
        {tab === "border" && (
          <div className="sx-split">
            <div className="sx-pane">
              <Row label={t("sheetx.fmt.lineStyle")}>
                <select value={line.style} onChange={(e) => setLine({ ...line, style: e.target.value })}>
                  {["thin", "medium", "thick", "dashed", "dotted", "double", "hair", "mediumDashed", "dashDot"].map((x) => (
                    <option key={x} value={x}>
                      {t(`sheetx.fmt.line.${x}`)}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t("sheetx.fmt.lineColor")}>
                <input type="color" value={line.color} onChange={(e) => setLine({ ...line, color: e.target.value })} />
              </Row>
              <div className="sx-btns">
                <button type="button" className="btn btn-ghost" onClick={() => (set({ bl: undefined, br: undefined, bt: undefined, bb: undefined }), setInner({ h: null, v: null }))}>
                  {t("sheetx.fmt.bNone")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => set({ bl: line, br: line, bt: line, bb: line })}>
                  {t("sheetx.fmt.bOutline")}
                </button>
                <button type="button" className="btn btn-ghost" disabled={g.r0 === g.r1 && g.c0 === g.c1} onClick={() => setInner({ h: line, v: line })}>
                  {t("sheetx.fmt.bInside")}
                </button>
              </div>
            </div>
            <div className="sx-border-box" aria-label={t("sheetx.fmt.tab.border")}>
              {(["bt", "bb", "bl", "br"] as Sides[]).map((k) => (
                <button key={k} type="button" className={cx("sx-bside", `sx-${k}`, st[k] && "on")} aria-pressed={!!st[k]} data-tip={t(`sheetx.fmt.side.${k}`)} onClick={() => side(k)} />
              ))}
              <div className="sx-bcell" style={{ borderTop: st.bt ? `2px solid ${st.bt.color}` : undefined, borderBottom: st.bb ? `2px solid ${st.bb.color}` : undefined, borderLeft: st.bl ? `2px solid ${st.bl.color}` : undefined, borderRight: st.br ? `2px solid ${st.br.color}` : undefined }}>
                {t("sheetx.fmt.text")}
              </div>
            </div>
          </div>
        )}
        {tab === "fill" && (
          <div>
            <div className="sx-swatches">
              <button type="button" className={cx("sx-swatch", "sx-nofill", !st.fill && "on")} data-tip={t("sheetx.fmt.noFill")} onClick={() => set({ fill: undefined })} />
              {COLORS.map((c) => (
                <button key={c} type="button" className={cx("sx-swatch", st.fill?.toUpperCase() === c && "on")} style={{ background: c }} data-tip={c} onClick={() => set({ fill: c })} />
              ))}
            </div>
            <Row label={t("sheetx.fmt.moreColors")}>
              <input type="color" value={st.fill ?? "#ffffff"} onChange={(e) => set({ fill: e.target.value })} />
            </Row>
            <div className="sx-sample sx-fill-sample" style={{ background: st.fill ?? "transparent" }} />
          </div>
        )}
        {tab === "protect" && (
          <div>
            <Check label={t("sheetx.fmt.locked")} checked={!st.unlocked} onChange={(v) => set({ unlocked: v ? undefined : true })} />
            <Check label={t("sheetx.fmt.hidden")} checked={!!st.hideFormula} onChange={(v) => set({ hideFormula: v || undefined })} />
            <p className="sx-hint">{t("sheetx.fmt.protectHint")}</p>
          </div>
        )}
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 조건부 서식 ─────

/** Excel's ready-made looks of 셀 강조 규칙 / 상위·하위 규칙. */
const LOOKS: { id: string; style: NonNullable<SheetCondRule["style"]> }[] = [
  { id: "lightRed", style: { fill: "#FFC7CE", color: "#9C0006" } },
  { id: "yellow", style: { fill: "#FFEB9C", color: "#9C5700" } },
  { id: "green", style: { fill: "#C6EFCE", color: "#006100" } },
  { id: "redFill", style: { fill: "#FFC7CE" } },
  { id: "redText", style: { color: "#9C0006" } },
  { id: "bold", style: { bold: true } },
];

/** Excel's 새 서식 규칙 ▸ 규칙 유형 선택: the six rule types, each with the kinds it offers (the first is its default). */
const RULE_TYPES: { id: string; kinds: string[] }[] = [
  { id: "scale", kinds: ["scale2", "scale3", "bar"] },
  { id: "contains", kinds: ["cellIs", "containsText", "timePeriod", "blanks", "noBlanks"] },
  { id: "rank", kinds: ["top10", "bottom10"] },
  { id: "average", kinds: ["above", "below"] },
  { id: "dup", kinds: ["duplicateValues", "uniqueValues"] },
  { id: "expression", kinds: ["expression"] },
];

/** The dialog's kind for a rule being edited (규칙 관리 ▸ 편집). */
function kindOf(r: SheetCondRule): string {
  if (r.type === "colorScale") return (r.scale?.length ?? 2) === 3 ? "scale3" : "scale2";
  if (r.type === "dataBar") return "bar";
  if (r.type === "top10") return r.bottom ? "bottom10" : "top10";
  if (r.type === "aboveAverage") return r.below ? "below" : "above";
  if (r.type === "containsBlanks") return "blanks";
  if (r.type === "notContainsBlanks") return "noBlanks";
  return r.type;
}
const unlit = (f: string) => (/^".*"$/.test(f) ? f.slice(1, -1).replace(/""/g, '"') : f);

function CondRule({ page, type, edit, onClose }: { page: Page; type: string; edit?: { b: number; r: number }; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const er = edit ? sh.cond?.[edit.b]?.rules[edit.r] : undefined;
  const g = edit && sh.cond?.[edit.b] ? parseRange(sh.cond[edit.b].ranges[0]) ?? selArea(sh, page.id) : selArea(sh, page.id);
  const [kind, setKind] = useState(er ? kindOf(er) : type === "new" || ["gt", "lt", "between", "eq"].includes(type) ? "cellIs" : type);
  const [op, setOp] = useState(er?.op ?? (type === "lt" ? "lessThan" : type === "between" ? "between" : type === "eq" ? "equal" : "greaterThan"));
  const [a, setA] = useState(er ? (er.type === "top10" ? String(er.rank ?? 10) : er.type === "containsText" ? er.text ?? "" : er.type === "expression" ? "=" + (er.formulas?.[0] ?? "") : unlit(er.formulas?.[0] ?? "")) : type === "top10" || type === "bottom10" ? "10" : "");
  const [b, setB] = useState(er ? unlit(er.formulas?.[1] ?? "") : "");
  const [period, setPeriod] = useState(er?.period ?? "today");
  const lookOf = (st?: SheetCondRule["style"]) => LOOKS.find((l) => JSON.stringify(l.style) === JSON.stringify(st ?? {}))?.id ?? "custom";
  const [look, setLook] = useState(er ? lookOf(er.style) : "lightRed");
  const [custom, setCustom] = useState<{ fill?: string; color?: string; bold?: boolean }>(er?.style ? { fill: er.style.fill, color: er.style.color, bold: er.style.bold } : { fill: "#FFC7CE" });
  const [pct, setPct] = useState(!!er?.percent);
  // 셀 값을 기준으로 모든 셀의 서식 지정: the colours of the lowest / middle / highest value (Excel's defaults)
  const [sc, setSc] = useState<string[]>(er?.type === "colorScale" && er.scale ? er.scale.map((x) => x.color || "#FFFFFF") : er?.type === "dataBar" ? [er.bar ?? "#638EC6"] : ["#F8696B", "#FFEB84", "#63BE7B"]);
  const style = look === "custom" ? { ...custom, bold: custom.bold || undefined } : LOOKS.find((l) => l.id === look)!.style;
  const lit = (s: string) => (/^[-+]?\d+(\.\d+)?$/.test(s.trim()) || s.startsWith("=") ? s.replace(/^=/, "") : `"${s.replace(/"/g, '""')}"`);
  const ok = () => {
    let rule: Omit<SheetCondRule, "priority">;
    if (kind === "scale2" || kind === "scale3") {
      const c = kind === "scale3" ? [sc[0], sc[1] ?? "#FFEB84", sc[2] ?? sc[1]] : [sc[0], sc[sc.length - 1]];
      rule = { type: "colorScale", scale: kind === "scale3" ? [{ kind: "min", color: c[0] }, { kind: "percentile", val: "50", color: c[1] }, { kind: "max", color: c[2] }] : [{ kind: "min", color: c[0] }, { kind: "max", color: c[1] }] };
    } else if (kind === "bar") rule = { type: "dataBar", bar: sc[0] ?? "#638EC6", scale: [{ kind: "min", color: "" }, { kind: "max", color: "" }] };
    else if (kind === "timePeriod") rule = { type: "timePeriod", period, formulas: [periodFormula(period, addr(g.r0, g.c0))], style };
    else if (kind === "cellIs") rule = { type: "cellIs", op, formulas: op === "between" || op === "notBetween" ? [lit(a), lit(b)] : [lit(a)], style };
    else if (kind === "containsText") rule = { type: "containsText", op: "containsText", text: a, style };
    else if (kind === "duplicateValues" || kind === "uniqueValues") rule = { type: kind, style };
    else if (kind === "top10" || kind === "bottom10") rule = { type: "top10", rank: Math.max(1, Number(a) || 10), ...(kind === "bottom10" ? { bottom: true } : {}), ...(pct ? { percent: true } : {}), style };
    else if (kind === "above" || kind === "below") rule = { type: "aboveAverage", ...(kind === "below" ? { below: true } : {}), style };
    else if (kind === "blanks" || kind === "noBlanks") rule = { type: kind === "blanks" ? "containsBlanks" : "notContainsBlanks", style };
    else rule = { type: "expression", formulas: [a.replace(/^=/, "")], style };
    if ((kind === "cellIs" || kind === "containsText" || kind === "expression") && !a.trim()) return;
    if (edit && er) replaceCondRule(page.id, edit.b, edit.r, rule);
    else addCondRule(page.id, g, rule);
    onClose();
  };
  const needsA = ["cellIs", "containsText", "top10", "bottom10", "expression"].includes(kind);
  return (
    <Modal labelledBy="sx-cond-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-cond-title">{t(er ? "sheetx.cond.editRule" : type === "new" ? "sheetx.cond.newRule" : `sheetx.cond.k.${type}`)}</h2>
        <p className="sx-hint">{t("sheetx.cond.applies", { range: edit && sh.cond?.[edit.b] ? sh.cond[edit.b].ranges.join(" ") : rangeText(g) })}</p>
        {kind === "timePeriod" && (
          <Row label={t("sheetx.cond.period")}>
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {["yesterday", "today", "tomorrow", "last7Days", "lastWeek", "thisWeek", "nextWeek", "lastMonth", "thisMonth", "nextMonth"].map((k) => (
                <option key={k} value={k}>
                  {t(`sheetx.cond.p.${k}`)}
                </option>
              ))}
            </select>
          </Row>
        )}
        {(type === "new" || er) && (() => {
          // Excel: 규칙 유형 선택 (a list of the six types), then 규칙 설명 편집 for the type picked
          const rt = RULE_TYPES.find((x) => x.kinds.includes(kind)) ?? RULE_TYPES[1];
          return (
            <>
              <div className="sx-label">{t("sheetx.cond.pickType")}</div>
              <div className="sx-list sx-ruletypes" role="listbox" aria-label={t("sheetx.cond.pickType")}>
                {RULE_TYPES.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="option"
                    aria-selected={x === rt}
                    className={cx(x === rt && "on")}
                    onClick={() => {
                      if (x === rt) return;
                      setKind(x.kinds[0]);
                      if (x.id === "scale") setSc(["#F8696B", "#FFEB84", "#63BE7B"]);
                    }}
                  >
                    ► {t(`sheetx.cond.type.${x.id}`)}
                  </button>
                ))}
              </div>
              <div className="sx-label">{t("sheetx.cond.editDesc")}</div>
              {rt.kinds.length > 1 && (
                <Row label={t(`sheetx.cond.sub.${rt.id}`)}>
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      if (e.target.value === "bar") setSc(["#638EC6"]);
                      else if (rt.id === "scale") setSc(e.target.value === "scale3" ? ["#F8696B", "#FFEB84", "#63BE7B"] : ["#F8696B", "#63BE7B"]);
                    }}
                  >
                    {rt.kinds.map((k) => (
                      <option key={k} value={k}>
                        {t(`sheetx.cond.kk.${k}`)}
                      </option>
                    ))}
                  </select>
                </Row>
              )}
              {rt.id === "scale" && (
                <div className="sx-btns">
                  {(kind === "bar" ? ["bar"] : kind === "scale3" ? ["min", "mid", "max"] : ["min", "max"]).map((w, i) => (
                    <Row key={w} label={t(`sheetx.cond.pt.${w}`)}>
                      <input type="color" aria-label={t(`sheetx.cond.pt.${w}`)} value={sc[i] ?? "#FFFFFF"} onChange={(e) => setSc(sc.map((c, j) => (j === i ? e.target.value : c)).concat(i >= sc.length ? [e.target.value] : []))} />
                    </Row>
                  ))}
                </div>
              )}
            </>
          );
        })()}
        {kind === "cellIs" && (
          <Row label={t("sheetx.cond.op")}>
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              {["greaterThan", "lessThan", "between", "notBetween", "equal", "notEqual", "greaterThanOrEqual", "lessThanOrEqual"].map((k) => (
                <option key={k} value={k}>
                  {t(`sheetx.op.${k}`)}
                </option>
              ))}
            </select>
          </Row>
        )}
        {needsA && (
          <Row label={t(kind === "expression" ? "sheetx.cond.formula" : kind === "top10" || kind === "bottom10" ? "sheetx.cond.count" : "sheetx.cond.value")}>
            <input autoFocus data-autofocus value={a} spellCheck={false} placeholder={kind === "expression" ? "=$B2>100" : ""} onChange={(e) => setA(e.target.value)} />
          </Row>
        )}
        {kind === "cellIs" && (op === "between" || op === "notBetween") && (
          <Row label={t("sheetx.cond.and")}>
            <input value={b} onChange={(e) => setB(e.target.value)} />
          </Row>
        )}
        {(kind === "top10" || kind === "bottom10") && <Check label={t("sheetx.cond.percent")} checked={pct} onChange={setPct} />}
        {!["scale2", "scale3", "bar"].includes(kind) && (
        <>
        <Row label={t("sheetx.cond.look")}>
          <select value={look} onChange={(e) => setLook(e.target.value)}>
            {[...LOOKS.map((l) => l.id), "custom"].map((k) => (
              <option key={k} value={k}>
                {t(`sheetx.cond.look.${k}`)}
              </option>
            ))}
          </select>
        </Row>
        {look === "custom" && (
          <div className="sx-btns">
            <Row label={t("sheet.b.fill")}>
              <input type="color" value={custom.fill ?? "#ffffff"} onChange={(e) => setCustom({ ...custom, fill: e.target.value })} />
            </Row>
            <Row label={t("sheet.b.fontColor")}>
              <input type="color" value={custom.color ?? "#000000"} onChange={(e) => setCustom({ ...custom, color: e.target.value })} />
            </Row>
            <Check label={t("ribbon.text.bold")} checked={!!custom.bold} onChange={(v) => setCustom({ ...custom, bold: v })} />
          </div>
        )}
        <div className="sx-sample sx-cond-sample" style={{ background: style.fill, color: style.color, fontWeight: style.bold ? 700 : 400 }}>
          AaBbCc 123
        </div>
        </>
        )}
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

function ruleText(r: SheetCondRule): string {
  const t = tt;
  switch (r.type) {
    case "cellIs":
      return `${t("sheetx.cond.cellValue")} ${t(`sheetx.op.${r.op ?? "equal"}`)} ${(r.formulas ?? []).join(` ${t("sheetx.cond.and")} `)}`;
    case "containsText":
      return t("sheetx.cond.textHas", { text: r.text ?? "" });
    case "top10":
      return t(r.bottom ? "sheetx.cond.bottomN" : "sheetx.cond.topN", { n: `${r.rank ?? 10}${r.percent ? "%" : ""}` });
    case "aboveAverage":
      return t(r.below ? "sheetx.cond.k.below" : "sheetx.cond.k.above");
    case "expression":
      return `${t("sheetx.cond.formula")}: =${r.formulas?.[0] ?? ""}`;
    case "dataBar":
      return t("sheetx.cond.dataBar");
    case "colorScale":
      return t("sheetx.cond.colorScale");
    case "iconSet":
      return `${t("sheetx.cond.iconSet")} (${r.icons})`;
    default:
      return t(`sheetx.cond.k.${r.type}`) === `sheetx.cond.k.${r.type}` ? r.type : t(`sheetx.cond.k.${r.type}`);
  }
}

function CondManager({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = useStore((s) => s.doc.pages.find((p) => p.id === page.id)?.sheet) ?? page.sheet!;
  const [scope, setScope] = useState<"sel" | "sheet">("sheet");
  const g = selArea(sh, page.id);
  const list = (sh.cond ?? [])
    .flatMap((cf, bi) => cf.rules.map((r, ri) => ({ cf, r, bi, ri })))
    .filter((x) => scope === "sheet" || x.cf.ranges.some((rg) => {
      const q = parseRange(rg);
      return q && !(q.r1 < g.r0 || q.r0 > g.r1 || q.c1 < g.c0 || q.c0 > g.c1);
    }))
    .sort((a, b) => a.r.priority - b.r.priority);
  return (
    <Modal labelledBy="sx-condm-title" onClose={onClose} className="sheet-dlg sx-dlg sx-wide">
      <div onKeyDown={stop}>
        <h2 id="sx-condm-title">{t("sheetx.cond.manage")}</h2>
        <div className="sx-btns">
          <Row label={t("sheetx.cond.showFor")}>
            <select value={scope} onChange={(e) => setScope(e.target.value as "sel" | "sheet")}>
              <option value="sel">{t("sheetx.cond.scopeSel")}</option>
              <option value="sheet">{t("sheetx.cond.scopeSheet")}</option>
            </select>
          </Row>
          <button type="button" className="btn btn-ghost" onClick={() => openDlg({ kind: "cond", type: "new" })}>
            {t("sheetx.cond.newRule")}
          </button>
        </div>
        <table className="sheet-sort-levels sx-table">
          <thead>
            <tr>
              <th>{t("sheetx.cond.rule")}</th>
              <th>{t("sheetx.cond.look")}</th>
              <th>{t("sheetx.cond.appliesTo")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={`${x.bi}-${x.ri}`}>
                <td>{ruleText(x.r)}</td>
                <td>
                  <span className="sx-look" style={{ background: x.r.style?.fill ?? (x.r.type === "dataBar" ? x.r.bar : undefined), color: x.r.style?.color, fontWeight: x.r.style?.bold ? 700 : 400 }}>
                    AaBb
                  </span>
                </td>
                <td>{x.cf.ranges.join(" ")}</td>
                <td>
                  {!["dataBar", "colorScale", "iconSet"].includes(x.r.type) && (
                    <button type="button" className="btn btn-ghost" onClick={() => openDlg({ kind: "cond", type: "new", edit: { b: x.bi, r: x.ri } })}>
                      {t("sheetx.edit")}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => deleteCondRule(page.id, x.bi, x.ri)}>
                    {t("sheetx.delete")}
                  </button>
                </td>
              </tr>
            ))}
            {!list.length && (
              <tr>
                <td colSpan={4}>{t("sheetx.cond.noRules")}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            {t("sheet.dlg.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───── 데이터 유효성 검사 ─────

function Validation({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const sel = selOf(page.id);
  const g = selArea(sh, page.id);
  const cur = (sh.valid ?? []).find((v) => v.ranges.some((rg) => {
    const q = parseRange(rg);
    return q && sel.ar >= q.r0 && sel.ar <= q.r1 && sel.ac >= q.c0 && sel.ac <= q.c1;
  }));
  const [tab, setTab] = useState<"settings" | "input" | "error">("settings");
  const [v, setV] = useState<Omit<SheetValidation, "ranges">>(() => (cur ? { ...cur } : { type: "none", allowBlank: true, showError: true, showInput: true, op: "between" }));
  const set = (p: Partial<SheetValidation>) => setV((x) => ({ ...x, ...p }));
  const ranged = ["whole", "decimal", "date", "time", "textLength"].includes(v.type);
  const two = ranged && (v.op ?? "between").includes("etween");
  const ok = () => {
    const { ranges: _r, x14: _x, ...rest } = v as SheetValidation;
    void _r;
    void _x;
    setValidation(page.id, g, v.type === "none" && !v.prompt ? null : rest);
    onClose();
  };
  return (
    <Modal labelledBy="sx-valid-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-valid-title">{t("sheetx.valid.title")}</h2>
        <Tabs value={tab} onChange={setTab} tabs={(["settings", "input", "error"] as const).map((id) => ({ id, label: t(`sheetx.valid.tab.${id}`) }))} />
        {tab === "settings" && (
          <>
            <Row label={t("sheetx.valid.allow")}>
              <select value={v.type} onChange={(e) => set({ type: e.target.value, ...(e.target.value === "list" ? { op: undefined } : { op: v.op ?? "between" }) })}>
                {["none", "whole", "decimal", "list", "date", "time", "textLength", "custom"].map((k) => (
                  <option key={k} value={k}>
                    {t(`sheetx.valid.type.${k}`)}
                  </option>
                ))}
              </select>
            </Row>
            {ranged && (
              <Row label={t("sheetx.valid.data")}>
                <select value={v.op ?? "between"} onChange={(e) => set({ op: e.target.value })}>
                  {["between", "notBetween", "equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"].map((k) => (
                    <option key={k} value={k}>
                      {t(`sheetx.op.${k}`)}
                    </option>
                  ))}
                </select>
              </Row>
            )}
            {(ranged || v.type === "list" || v.type === "custom") && (
              <Row label={t(v.type === "list" ? "sheetx.valid.source" : v.type === "custom" ? "sheetx.cond.formula" : two ? "sheetx.valid.min" : "sheetx.cond.value")}>
                <input
                  autoFocus data-autofocus
                  value={v.type === "list" && v.f1 && /^".*"$/.test(v.f1) ? v.f1.slice(1, -1) : v.f1 ?? ""}
                  placeholder={v.type === "list" ? t("sheetx.valid.sourceHint") : ""}
                  spellCheck={false}
                  onChange={(e) => {
                    const x = e.target.value;
                    // a list typed as items is a quoted constant; =A1:A5 / a name is a reference
                    set({ f1: v.type === "list" ? (x.startsWith("=") ? x.slice(1) : `"${x}"`) : x.replace(/^=/, "") });
                  }}
                />
              </Row>
            )}
            {two && (
              <Row label={t("sheetx.valid.max")}>
                <input value={v.f2 ?? ""} onChange={(e) => set({ f2: e.target.value.replace(/^=/, "") })} />
              </Row>
            )}
            <Check label={t("sheetx.valid.ignoreBlank")} checked={!!v.allowBlank} onChange={(x) => set({ allowBlank: x || undefined })} />
            {v.type === "list" && <Check label={t("sheetx.valid.dropdown")} checked={!v.noDropdown} onChange={(x) => set({ noDropdown: x ? undefined : true })} />}
          </>
        )}
        {tab === "input" && (
          <>
            <Check label={t("sheetx.valid.showInput")} checked={!!v.showInput} onChange={(x) => set({ showInput: x || undefined })} />
            <Row label={t("sheetx.valid.msgTitle")}>
              <input value={v.promptTitle ?? ""} maxLength={32} onChange={(e) => set({ promptTitle: e.target.value || undefined })} />
            </Row>
            <Row label={t("sheetx.valid.msg")}>
              <textarea value={v.prompt ?? ""} maxLength={255} rows={4} onChange={(e) => set({ prompt: e.target.value || undefined })} />
            </Row>
          </>
        )}
        {tab === "error" && (
          <>
            <Check label={t("sheetx.valid.showError")} checked={!!v.showError} onChange={(x) => set({ showError: x || undefined })} />
            <Row label={t("sheetx.valid.style")}>
              <select value={v.errStyle ?? "stop"} onChange={(e) => set({ errStyle: e.target.value === "stop" ? undefined : e.target.value })}>
                {["stop", "warning", "information"].map((k) => (
                  <option key={k} value={k}>
                    {t(`sheetx.valid.err.${k}`)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("sheetx.valid.msgTitle")}>
              <input value={v.errTitle ?? ""} maxLength={32} onChange={(e) => set({ errTitle: e.target.value || undefined })} />
            </Row>
            <Row label={t("sheetx.valid.errMsg")}>
              <textarea value={v.error ?? ""} maxLength={255} rows={4} onChange={(e) => set({ error: e.target.value || undefined })} />
            </Row>
          </>
        )}
        <Actions
          onClose={onClose}
          onOk={ok}
          extra={
            <button type="button" className="btn btn-ghost sx-left" onClick={() => (setValidation(page.id, g, null), onClose())}>
              {t("sheetx.valid.clearAll")}
            </button>
          }
        />
      </div>
    </Modal>
  );
}

// ───── 중복된 항목 제거 / 텍스트 나누기 ─────

function Dedupe({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const g = useMemo(() => dataArea(sh, page.id), [sh, page.id]);
  const [header, setHeader] = useState(() => guessHeader(sh, g));
  const cols = Array.from({ length: g.c1 - g.c0 + 1 }, (_, i) => g.c0 + i);
  const [on, setOn] = useState<Set<number>>(new Set(cols));
  const ok = () => {
    const r = removeDuplicates(page.id, g, [...on], header);
    S().notify(r.removed ? t("sheetx.dedupe.done", { n: r.removed, left: r.left }) : t("sheetx.dedupe.none"));
    onClose();
  };
  return (
    <Modal labelledBy="sx-dd-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-dd-title">{t("sheetx.dedupe.title")}</h2>
        <p className="sx-hint">{t("sheetx.dedupe.hint", { range: rangeText(g) })}</p>
        <div className="sx-btns">
          <button type="button" className="btn btn-ghost" onClick={() => setOn(new Set(cols))}>
            {t("sheetx.selectAll")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setOn(new Set())}>
            {t("sheetx.unselectAll")}
          </button>
          <Check label={t("sheet.sort.header")} checked={header} onChange={setHeader} />
        </div>
        <div className="sx-checklist">
          {cols.map((c) => (
            <Check key={c} label={(header && shownText(sh, sh.cells[addr(g.r0, c)], lang())) || t("sheet.sort.column", { col: colLetters(c) })} checked={on.has(c)} onChange={(v) => {
              const n = new Set(on);
              v ? n.add(c) : n.delete(c);
              setOn(n);
            }} />
          ))}
        </div>
        <Actions onClose={onClose} onOk={ok} disabled={!on.size} />
      </div>
    </Modal>
  );
}

function Split({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const g0 = selArea(sh, page.id);
  const g = { ...g0, c1: g0.c0 };
  const [mode, setMode] = useState<"delim" | "fixed">("delim");
  const [d, setD] = useState({ tab: true, semicolon: false, comma: true, space: false, other: "" });
  const [merge, setMerge] = useState(false);
  const [quote, setQuote] = useState('"');
  const [fixed, setFixed] = useState("");
  const [dest, setDest] = useState(addr(g.r0, g.c0));
  const opts: SplitOpts = {
    delims: [d.tab && "\t", d.semicolon && ";", d.comma && ",", d.space && " ", ...[...d.other]].filter((x): x is string => !!x),
    merge,
    quote,
    ...(mode === "fixed" ? { fixed: fixed.split(/[,\s]+/).map(Number).filter((n) => n > 0) } : {}),
  };
  const preview = [];
  for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5); r++) {
    const x = sh.cells[addr(r, g.c0)];
    if (x?.v !== undefined) preview.push(splitText(String(x.v), opts));
  }
  const ok = () => {
    const to = parseRange(dest.toUpperCase().replace(/\$/g, ""));
    textToColumns(page.id, g, opts, to ? { r: to.r0, c: to.c0 } : undefined);
    onClose();
  };
  return (
    <Modal labelledBy="sx-split-title" onClose={onClose} className="sheet-dlg sx-dlg sx-wide">
      <div onKeyDown={stop}>
        <h2 id="sx-split-title">{t("sheetx.split.title")}</h2>
        <div className="sheet-radios sx-inline">
          <label>
            <input type="radio" checked={mode === "delim"} onChange={() => setMode("delim")} />
            {t("sheetx.split.delimited")}
          </label>
          <label>
            <input type="radio" checked={mode === "fixed"} onChange={() => setMode("fixed")} />
            {t("sheetx.split.fixed")}
          </label>
        </div>
        {mode === "delim" ? (
          <div className="sx-btns">
            {(["tab", "semicolon", "comma", "space"] as const).map((k) => (
              <Check key={k} label={t(`sheetx.split.${k}`)} checked={d[k]} onChange={(v) => setD({ ...d, [k]: v })} />
            ))}
            <Row label={t("sheetx.split.other")}>
              <input className="sx-short" maxLength={1} value={d.other} onChange={(e) => setD({ ...d, other: e.target.value })} />
            </Row>
            <Check label={t("sheetx.split.merge")} checked={merge} onChange={setMerge} />
            <Row label={t("sheetx.split.quote")}>
              <select value={quote} onChange={(e) => setQuote(e.target.value)}>
                <option value={'"'}>"</option>
                <option value="'">'</option>
                <option value="">{t("sheetx.fmt.none")}</option>
              </select>
            </Row>
          </div>
        ) : (
          <Row label={t("sheetx.split.positions")}>
            <input value={fixed} placeholder="4, 8" onChange={(e) => setFixed(e.target.value)} />
          </Row>
        )}
        <Row label={t("sheetx.split.dest")}>
          <input value={dest} onChange={(e) => setDest(e.target.value)} />
        </Row>
        <table className="sheet-sort-levels sx-table sx-preview">
          <tbody>
            {preview.map((row, i) => (
              <tr key={i}>
                {row.map((x, j) => (
                  <td key={j}>{x}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <Actions onClose={onClose} onOk={ok} okLabel={t("sheetx.split.finish")} />
      </div>
    </Modal>
  );
}

// ───── 하이퍼링크 ─────

function LinkDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const sel = selOf(page.id);
  const a = addr(sel.ar, sel.ac);
  const cur = sh.links?.[a];
  const tabs = bookPages(S().doc, page).map((p) => p.sheet!.name);
  const [mode, setMode] = useState<"url" | "place">(cur?.loc && !cur.url ? "place" : "url");
  const [url, setUrl] = useState(cur?.url ?? "");
  const [sheet, setSheet] = useState(() => (cur?.loc?.includes("!") ? cur.loc.slice(0, cur.loc.lastIndexOf("!")).replace(/^'|'$/g, "") : sh.name));
  const [ref, setRef] = useState(() => (cur?.loc ? cur.loc.slice(cur.loc.lastIndexOf("!") + 1) : "A1"));
  const [text, setText] = useState(shownText(sh, sh.cells[a], lang()));
  const [tip, setTip] = useState(cur?.tip ?? "");
  const q = (n: string) => (/^[A-Za-z_][\w.]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
  const ok = () => {
    if (mode === "url" && !url.trim()) return;
    const names = Object.keys(sh.names ?? {});
    const loc = names.includes(ref) ? ref : `${q(sheet)}!${ref.toUpperCase()}`;
    setLink(page.id, a, mode === "url" && !url.trim().startsWith("#") ? { url: url.trim(), ...(tip ? { tip } : {}) } : { loc: mode === "url" ? url.trim().slice(1) : loc, ...(tip ? { tip } : {}) }, text); // "#Sheet1!D30" typed as the address: a place in this book (Excel)
    onClose();
  };
  return (
    <Modal labelledBy="sx-link-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-link-title">{t(cur ? "sheetx.link.edit" : "sheetx.link.title")}</h2>
        <Tabs value={mode} onChange={setMode} tabs={[{ id: "url", label: t("sheetx.link.url") }, { id: "place", label: t("sheetx.link.place") }]} />
        <Row label={t("sheetx.link.text")}>
          <input value={text} onChange={(e) => setText(e.target.value)} />
        </Row>
        {mode === "url" ? (
          <Row label={t("sheetx.link.address")}>
            <input autoFocus data-autofocus value={url} placeholder="https://" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
          </Row>
        ) : (
          <>
            <Row label={t("sheetx.link.sheet")}>
              <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                {tabs.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </Row>
            <Row label={t("sheetx.link.ref")}>
              <input value={ref} onChange={(e) => setRef(e.target.value)} list="sx-names" />
            </Row>
            <datalist id="sx-names">
              {Object.keys(sh.names ?? {}).map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}
        <Row label={t("sheetx.link.tip")}>
          <input value={tip} onChange={(e) => setTip(e.target.value)} />
        </Row>
        <Actions
          onClose={onClose}
          onOk={ok}
          extra={
            cur ? (
              <button type="button" className="btn btn-ghost sx-left" onClick={() => (setLink(page.id, a, null), onClose())}>
                {t("sheetx.link.remove")}
              </button>
            ) : undefined
          }
        />
      </div>
    </Modal>
  );
}

// ───── 보호 ─────

const ALLOW = ["selectLocked", "selectUnlocked", "formatCells", "formatColumns", "formatRows", "insertColumns", "insertRows", "insertHyperlinks", "deleteColumns", "deleteRows", "sort", "autoFilter", "pivotTables"];

function ProtectDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [step, setStep] = useState(0);
  const [allow, setAllow] = useState<Set<string>>(new Set(["selectLocked", "selectUnlocked"]));
  const ok = () => {
    if (pw && step === 0) return setStep(1);
    if (pw && pw2 !== pw) {
      S().notify(t("sheetx.protect.mismatch"));
      return setStep(0);
    }
    protectSheet(page.id, [...allow], pw);
    onClose();
  };
  return (
    <Modal labelledBy="sx-prot-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-prot-title">{t("sheetx.protect.title")}</h2>
        {step === 0 ? (
          <>
            <Row label={t("sheetx.protect.password")}>
              <input type="password" autoComplete="new-password" autoFocus data-autofocus value={pw} onChange={(e) => setPw(e.target.value)} />
            </Row>
            <p className="sx-hint">{t("sheetx.protect.allowAll")}</p>
            <div className="sx-checklist">
              {ALLOW.map((k) => (
                <Check key={k} label={t(`sheetx.protect.a.${k}`)} checked={allow.has(k)} onChange={(v) => {
                  const n = new Set(allow);
                  v ? n.add(k) : n.delete(k);
                  setAllow(n);
                }} />
              ))}
            </div>
          </>
        ) : (
          <Row label={t("sheetx.protect.confirm")}>
            <input type="password" autoComplete="new-password" autoFocus data-autofocus value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} />
          </Row>
        )}
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

function PasswordDialog({ page, kind, onClose }: { page: Page; kind: "unprotect" | "book"; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const [pw, setPw] = useState("");
  const locking = kind === "book" && !sh.bookProtect;
  const needs = kind === "unprotect" ? !!sh.protect?.hash : locking || !!sh.bookProtect?.hash;
  const ok = () => {
    const good = kind === "unprotect" ? unprotectSheet(page.id, pw) : protectBook(page.id, locking, pw);
    if (!good) return void S().notify(t("sheetx.protect.wrong"));
    onClose();
  };
  // nothing to ask: Excel unprotects / protects at once
  useEffect(() => {
    if (!needs) ok();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!needs) return null;
  return (
    <Modal labelledBy="sx-pw-title" onClose={onClose} className="sheet-dlg sx-dlg modal-sm">
      <div onKeyDown={stop}>
        <h2 id="sx-pw-title">{t(kind === "unprotect" ? "sheetx.protect.unprotect" : locking ? "sheetx.protect.book" : "sheetx.protect.unbook")}</h2>
        {locking && <p className="sx-hint">{t("sheetx.protect.bookHint")}</p>}
        <Row label={t("sheetx.protect.password")}>
          <input type="password" autoComplete="off" autoFocus data-autofocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok()} />
        </Row>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 페이지 설정 ─────

export const PAPERS: [number, string][] = [
  [9, "A4"],
  [8, "A3"],
  [11, "A5"],
  [12, "B4 (JIS)"],
  [13, "B5 (JIS)"],
  [1, "Letter"],
  [5, "Legal"],
];

const HF_PRESETS = ["", "&P", "&P / &N", "&A", "&F", "&D", "&A - &P"];

/** Split an Excel header / footer into its &L &C &R sections. */
export function hfParts(s: string | undefined): { l: string; c: string; r: string } {
  const out = { l: "", c: "", r: "" };
  let cur: "l" | "c" | "r" = "c";
  const re = /&([LCR])/g;
  let at = 0;
  for (let m = re.exec(s ?? ""); m; m = re.exec(s ?? "")) {
    out[cur] += (s ?? "").slice(at, m.index);
    cur = m[1].toLowerCase() as "l" | "c" | "r";
    at = m.index + 2;
  }
  out[cur] += (s ?? "").slice(at);
  return out;
}
const hfJoin = (p: { l: string; c: string; r: string }) => (p.l ? "&L" + p.l : "") + (p.c ? "&C" + p.c : "") + (p.r ? "&R" + p.r : "") || undefined;

function PageSetup({ page, tab0, onClose }: { page: Page; tab0: string; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const [tab, setTab] = useState(tab0);
  const [p, setP] = useState<SheetPrint>(() => ({ ...(sh.print ?? {}) }));
  const set = (x: Partial<SheetPrint>) => setP((v) => ({ ...v, ...x }));
  const m = p.margins ?? DEFAULT_MARGINS;
  const [hd, setHd] = useState(() => hfParts(p.header));
  const [ft, setFt] = useState(() => hfParts(p.footer));
  const rowsText = p.titleRows ? `$${p.titleRows[0] + 1}:$${p.titleRows[1] + 1}` : "";
  const colsText = p.titleCols ? `$${colLetters(p.titleCols[0])}:$${colLetters(p.titleCols[1])}` : "";
  const [titleRows, setTitleRows] = useState(rowsText);
  const [titleCols, setTitleCols] = useState(colsText);
  const [area, setArea] = useState((p.area ?? []).join(","));
  const ok = () => {
    const tr = /^\$?(\d+):\$?(\d+)$/.exec(titleRows.trim()), tc = /^\$?([A-Z]+):\$?([A-Z]+)$/i.exec(titleCols.trim());
    const areas = area.split(",").map((x) => x.trim().replace(/\$/g, "").toUpperCase()).filter((x) => parseRange(x));
    setPrint(page.id, () => ({
      ...p,
      header: hfJoin(hd),
      footer: hfJoin(ft),
      titleRows: tr ? [Number(tr[1]) - 1, Number(tr[2]) - 1] : undefined,
      titleCols: tc ? [parseRange(tc[1].toUpperCase() + "1")!.c0, parseRange(tc[2].toUpperCase() + "1")!.c0] : undefined,
      area: areas.length ? areas : undefined,
    }));
    onClose();
  };
  const hfRow = (label: string, v: { l: string; c: string; r: string }, setV: (x: { l: string; c: string; r: string }) => void) => (
    <fieldset className="sx-hf">
      <legend>{label}</legend>
      <select value={HF_PRESETS.includes(v.c) && !v.l && !v.r ? v.c : "custom"} onChange={(e) => e.target.value !== "custom" && setV({ l: "", c: e.target.value, r: "" })}>
        {HF_PRESETS.map((x) => (
          <option key={x} value={x}>
            {t(`sheetx.page.hf.${x === "" ? "none" : x.replace(/[^A-Z]/g, "")}`)}
          </option>
        ))}
        <option value="custom">{t("sheetx.page.hf.custom")}</option>
      </select>
      <div className="sx-hf3">
        {(["l", "c", "r"] as const).map((k) => (
          <input key={k} aria-label={t(`sheetx.page.sec.${k}`)} placeholder={t(`sheetx.page.sec.${k}`)} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
        ))}
      </div>
    </fieldset>
  );
  return (
    <Modal labelledBy="sx-page-title" onClose={onClose} className="sheet-dlg sx-dlg sx-wide">
      <div onKeyDown={stop}>
        <h2 id="sx-page-title">{t("sheetx.page.title")}</h2>
        <Tabs value={tab} onChange={setTab} tabs={(["page", "margins", "hf", "sheet"] as const).map((id) => ({ id, label: t(`sheetx.page.tab.${id}`) }))} />
        {tab === "page" && (
          <div className="sx-grid2">
            <div className="sheet-radios sx-inline">
              <label>
                <input type="radio" checked={!p.landscape} onChange={() => set({ landscape: undefined })} />
                {t("sheetx.page.portrait")}
              </label>
              <label>
                <input type="radio" checked={!!p.landscape} onChange={() => set({ landscape: true })} />
                {t("sheetx.page.landscape")}
              </label>
            </div>
            <div className="sheet-radios">
              <label>
                <input type="radio" checked={!p.fit} onChange={() => set({ fit: undefined })} />
                {t("sheetx.page.adjust")}
                <input type="number" min={10} max={400} value={p.scale ?? 100} disabled={!!p.fit} onChange={(e) => set({ scale: Math.max(10, Math.min(400, Number(e.target.value) || 100)) })} /> %
              </label>
              <label>
                <input type="radio" checked={!!p.fit} onChange={() => set({ fit: { w: 1, h: 1 }, scale: undefined })} />
                {t("sheetx.page.fit")}
                <input type="number" min={0} value={p.fit?.w ?? 1} disabled={!p.fit} onChange={(e) => set({ fit: { w: Number(e.target.value) || 0, h: p.fit?.h ?? 1 } })} />
                {t("sheetx.page.wide")}
                <input type="number" min={0} value={p.fit?.h ?? 1} disabled={!p.fit} onChange={(e) => set({ fit: { w: p.fit?.w ?? 1, h: Number(e.target.value) || 0 } })} />
                {t("sheetx.page.tall")}
              </label>
            </div>
            <Row label={t("sheetx.page.paper")}>
              <select value={p.paper ?? 9} onChange={(e) => set({ paper: Number(e.target.value) })}>
                {PAPERS.map(([id, n]) => (
                  <option key={id} value={id}>
                    {n}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("sheetx.page.firstPage")}>
              <input value={p.firstPage ?? ""} placeholder={t("sheetx.page.auto")} onChange={(e) => set({ firstPage: Number(e.target.value) || undefined })} />
            </Row>
          </div>
        )}
        {tab === "margins" && (
          <div className="sx-grid3">
            {(["t", "b", "l", "r", "header", "footer"] as const).map((k) => (
              <Row key={k} label={t(`sheetx.page.m.${k}`)}>
                <input type="number" step={0.1} min={0} value={Math.round(m[k] * 2.54 * 10) / 10} onChange={(e) => set({ margins: { ...m, [k]: (Number(e.target.value) || 0) / 2.54 } })} />
                <span className="sx-unit">cm</span>
              </Row>
            ))}
            <Check label={t("sheetx.page.hCenter")} checked={!!p.hCenter} onChange={(v) => set({ hCenter: v || undefined })} />
            <Check label={t("sheetx.page.vCenter")} checked={!!p.vCenter} onChange={(v) => set({ vCenter: v || undefined })} />
          </div>
        )}
        {tab === "hf" && (
          <>
            {hfRow(t("sheetx.page.header"), hd, setHd)}
            {hfRow(t("sheetx.page.footer"), ft, setFt)}
            <p className="sx-hint">{t("sheetx.page.hfCodes")}</p>
          </>
        )}
        {tab === "sheet" && (
          <div className="sx-grid2">
            <Row label={t("sheetx.page.area")}>
              <input value={area} placeholder="A1:F40" onChange={(e) => setArea(e.target.value)} />
            </Row>
            <Row label={t("sheetx.page.titleRows")}>
              <input value={titleRows} placeholder="$1:$1" onChange={(e) => setTitleRows(e.target.value)} />
            </Row>
            <Row label={t("sheetx.page.titleCols")}>
              <input value={titleCols} placeholder="$A:$A" onChange={(e) => setTitleCols(e.target.value)} />
            </Row>
            <Check label={t("sheetx.page.grid")} checked={!!p.grid} onChange={(v) => set({ grid: v || undefined })} />
            <Check label={t("sheetx.page.printHeadings")} checked={!!p.headings} onChange={(v) => set({ headings: v || undefined })} />
            <div className="sheet-radios">
              <label>
                <input type="radio" checked={!p.overThenDown} onChange={() => set({ overThenDown: undefined })} />
                {t("sheetx.page.downThenOver")}
              </label>
              <label>
                <input type="radio" checked={!!p.overThenDown} onChange={() => set({ overThenDown: true })} />
                {t("sheetx.page.overThenDown")}
              </label>
            </div>
          </div>
        )}
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 이름 ─────

function NameDialog({ page, edit, onClose }: { page: Page; edit?: string; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const g = selArea(sh, page.id);
  const [name, setName] = useState(edit ?? (() => {
    const above = g.r0 === g.r1 && g.c0 === g.c1 && g.c0 > 0 ? shownText(sh, sh.cells[addr(g.r0, g.c0 - 1)], lang()) : shownText(sh, sh.cells[addr(Math.max(0, g.r0 - 1), g.c0)], lang());
    return above.replace(/[^\p{L}\p{N}_.]+/gu, "_").replace(/^(\p{N})/u, "_$1");
  })());
  const [ref, setRef] = useState(edit ? "=" + (sh.names?.[edit] ?? "") : "=" + absRef(sh, g));
  const ok = () => {
    if (defineName(page.id, name, ref, edit)) onClose();
  };
  return (
    <Modal labelledBy="sx-name-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-name-title">{t(edit ? "sheetx.name.edit" : "sheetx.name.new")}</h2>
        <Row label={t("sheetx.name.name")}>
          <input autoFocus data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
        </Row>
        <Row label={t("sheetx.name.scope")}>
          <select disabled value="book">
            <option value="book">{t("sheetx.name.book")}</option>
          </select>
        </Row>
        <Row label={t("sheetx.name.refers")}>
          <input value={ref} spellCheck={false} onChange={(e) => setRef(e.target.value)} />
        </Row>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

function NameManager({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = useStore((s) => s.doc.pages.find((p) => p.id === page.id)?.sheet) ?? page.sheet!;
  const names = Object.entries(sh.names ?? {}).sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <Modal labelledBy="sx-names-title" onClose={onClose} className="sheet-dlg sx-dlg sx-wide">
      <div onKeyDown={stop}>
        <h2 id="sx-names-title">{t("sheetx.name.manager")}</h2>
        <div className="sx-btns">
          <button type="button" className="btn btn-ghost" onClick={() => openDlg({ kind: "name", from: "names" })}>
            {t("sheetx.name.newBtn")}
          </button>
        </div>
        <table className="sheet-sort-levels sx-table">
          <thead>
            <tr>
              <th>{t("sheetx.name.name")}</th>
              <th>{t("sheetx.name.refers")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {names.map(([n, f]) => (
              <tr key={n}>
                <td>{n}</td>
                <td>={f}</td>
                <td>
                  <button type="button" className="btn btn-ghost" onClick={() => openDlg({ kind: "name", edit: n, from: "names" })}>
                    {t("sheetx.edit")}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => defineName(page.id, n, null)}>
                    {t("sheetx.delete")}
                  </button>
                </td>
              </tr>
            ))}
            {!names.length && (
              <tr>
                <td colSpan={3}>{t("sheetx.name.none")}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            {t("sheet.dlg.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───── 차트 ─────

export const CHART_TYPES = ["col", "bar", "line", "pie", "doughnut", "scatter", "area", "combo"];

function ChartDialog({ page, i, onClose }: { page: Page; i: number; onClose: () => void }) {
  const t = useT();
  const d = page.sheet!.drawings?.[i];
  const own = !!d?.spec;
  const titleNow = d?.spec?.title ?? /<(?:\w+:)?chart>\s*<(?:\w+:)?title>[\s\S]*?<(?:\w+:)?t>([^<]*)</.exec(d?.chart ?? "")?.[1] ?? "";
  const [s, setS] = useState<SheetChartSpec>(() => d?.spec ?? { type: "col", ref: "", title: titleNow, legend: /<(?:\w+:)?legend>/.test(d?.chart ?? "") ? ((/<(?:\w+:)?legendPos val="(\w)"/.exec(d?.chart ?? "")?.[1] as SheetChartSpec["legend"]) ?? "r") : "none", labels: /<(?:\w+:)?showVal val="1"/.test(d?.chart ?? "") });
  if (!d) return null;
  const set = (p: Partial<SheetChartSpec>) => setS((x) => ({ ...x, ...p }));
  const ok = () => {
    if (own) updateChart(page.id, i, s);
    else updateChart(page.id, i, { title: s.title ?? "", legend: s.legend ?? "none", labels: !!s.labels });
    onClose();
  };
  return (
    <Modal labelledBy="sx-chart-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-chart-title">{t("sheetx.chart.edit")}</h2>
        {own && (
          <>
            <Row label={t("sheetx.chart.type")}>
              <select value={s.type} onChange={(e) => set({ type: e.target.value })}>
                {CHART_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`sheetx.chart.t.${k}`)}
                  </option>
                ))}
              </select>
            </Row>
            <Row label={t("sheetx.chart.data")}>
              <input value={s.ref} onChange={(e) => set({ ref: e.target.value.toUpperCase().replace(/\$/g, "") })} />
            </Row>
            <Check label={t("sheetx.chart.byRow")} checked={!!s.byRow} onChange={(v) => set({ byRow: v || undefined })} />
            {["col", "bar", "area"].includes(s.type) && (
              <Row label={t("sheetx.chart.grouping")}>
                <select value={s.grouping ?? "clustered"} onChange={(e) => set({ grouping: e.target.value as SheetChartSpec["grouping"] })}>
                  {["clustered", "stacked", "percentStacked"].map((k) => (
                    <option key={k} value={k}>
                      {t(`sheetx.chart.g.${k}`)}
                    </option>
                  ))}
                </select>
              </Row>
            )}
          </>
        )}
        <Row label={t("sheetx.chart.chartTitle")}>
          <input autoFocus data-autofocus value={s.title ?? ""} onChange={(e) => set({ title: e.target.value })} />
        </Row>
        <Row label={t("sheetx.chart.legend")}>
          <select value={s.legend ?? "b"} onChange={(e) => set({ legend: e.target.value as SheetChartSpec["legend"] })}>
            {["none", "r", "t", "b", "l"].map((k) => (
              <option key={k} value={k}>
                {t(`sheetx.chart.lg.${k}`)}
              </option>
            ))}
          </select>
        </Row>
        <Check label={t("sheetx.chart.labels")} checked={!!s.labels} onChange={(v) => set({ labels: v || undefined })} />
        {own && !["pie", "doughnut"].includes(s.type) && (
          <>
            <Row label={t("sheetx.chart.xTitle")}>
              <input value={s.xTitle ?? ""} onChange={(e) => set({ xTitle: e.target.value || undefined })} />
            </Row>
            <Row label={t("sheetx.chart.yTitle")}>
              <input value={s.yTitle ?? ""} onChange={(e) => set({ yTitle: e.target.value || undefined })} />
            </Row>
          </>
        )}
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

function ChartMenu({ page, i, x, y, onClose }: { page: Page; i: number; x: number; y: number; onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="menu-pop" role="menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="menu-item" onClick={() => openDlg({ kind: "chart", i })}>
        <span className="menu-label">{t("sheetx.chart.edit")}</span>
      </button>
      <button type="button" className="menu-item" onClick={() => (deleteDrawing(page.id, i), onClose())}>
        <span className="menu-label">{t("sheetx.chart.delete")}</span>
        <kbd>Delete</kbd>
      </button>
      <button type="button" className="menu-item" onClick={onClose}>
        <span className="menu-label">{t("sheet.dlg.cancel")}</span>
      </button>
    </div>
  );
}

// ───── 피벗 테이블 ─────

function PivotDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const g0 = useMemo(() => dataArea(sh, page.id), [sh, page.id]);
  const [ref, setRef] = useState(rangeText(g0));
  const [where, setWhere] = useState<"new" | "here">("new");
  const [at, setAt] = useState(addr(g0.r0, g0.c1 + 2));
  const g = parseRange(ref.toUpperCase().replace(/\$/g, "")) ?? g0;
  const fields = Array.from({ length: g.c1 - g.c0 + 1 }, (_, k) => shownText(sh, sh.cells[addr(g.r0, g.c0 + k)], lang()) || colLetters(g.c0 + k));
  const numeric = (k: number) => typeof sh.cells[addr(g.r0 + 1, g.c0 + k)]?.v === "number";
  const itemsOf = (f: string) => {
    const k = fields.indexOf(f);
    const set = new Set<string>();
    for (let r = g.r0 + 1; r <= g.r1; r++) set.add(shownText(sh, sh.cells[addr(r, g.c0 + k)], lang()));
    return [...set].sort((a, b) => a.localeCompare(b));
  };
  const [rows, setRows] = useState<string[]>(() => fields.filter((_, k) => !numeric(k)).slice(0, 1));
  const [cols, setCols] = useState<string[]>([]);
  const [pages, setPages] = useState<{ field: string; item?: string }[]>([]);
  const [vals, setVals] = useState<{ field: string; fn: PivotFn }[]>(() => fields.filter((_, k) => numeric(k)).slice(0, 1).map((f) => ({ field: f, fn: "sum" })));
  const area = (f: string) => (rows.includes(f) ? "rows" : cols.includes(f) ? "cols" : pages.some((x) => x.field === f) ? "pages" : "");
  const put = (f: string, to: string) => {
    setRows((r) => (to === "rows" ? [...r.filter((x) => x !== f), f] : r.filter((x) => x !== f)));
    setCols((r) => (to === "cols" ? [...r.filter((x) => x !== f), f] : r.filter((x) => x !== f)));
    setPages((r) => (to === "pages" ? [...r.filter((x) => x.field !== f), { field: f }] : r.filter((x) => x.field !== f)));
  };
  const ok = async () => {
    const spec = { sheet: sh.name, ref: rangeText(g), at: "A3", rows, cols, vals, ...(pages.length ? { pages } : {}) };
    if (where === "new") {
      const { addSheet } = await import("./sheetActions");
      const id = addSheet(page.id);
      if (!id) return;
      writePivot(id, { ...spec, at: pages.length ? "A1" : "A3" }, null);
    } else {
      const p = parseRange(at.toUpperCase().replace(/\$/g, ""));
      if (!p) return;
      writePivot(page.id, { ...spec, at: addr(p.r0, p.c0) }, null);
    }
    onClose();
  };
  const FN_LIST: PivotFn[] = ["sum", "count", "average", "max", "min", "product", "countNums", "stdDev", "stdDevp", "var", "varp"];
  return (
    <Modal labelledBy="sx-pivot-title" onClose={onClose} className="sheet-dlg sx-dlg sx-wide">
      <div onKeyDown={stop}>
        <h2 id="sx-pivot-title">{t("sheetx.pivot.title")}</h2>
        <Row label={t("sheetx.pivot.source")}>
          <input value={ref} onChange={(e) => setRef(e.target.value)} />
        </Row>
        <div className="sheet-radios sx-inline">
          <label>
            <input type="radio" checked={where === "new"} onChange={() => setWhere("new")} />
            {t("sheetx.pivot.newSheet")}
          </label>
          <label>
            <input type="radio" checked={where === "here"} onChange={() => setWhere("here")} />
            {t("sheetx.pivot.existing")}
            <input className="sx-short" value={at} disabled={where !== "here"} onChange={(e) => setAt(e.target.value)} />
          </label>
        </div>
        <table className="sheet-sort-levels sx-table">
          <thead>
            <tr>
              <th>{t("sheetx.pivot.field")}</th>
              <th>{t("sheetx.pivot.area")}</th>
              <th>{t("sheetx.pivot.filterItem")}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f}>
                <td>{f}</td>
                <td>
                  <select aria-label={`${f} ${t("sheetx.pivot.area")}`} value={area(f)} onChange={(e) => put(f, e.target.value)}>
                    <option value="">—</option>
                    <option value="pages">{t("sheetx.pivot.pages")}</option>
                    <option value="rows">{t("sheetx.pivot.rows")}</option>
                    <option value="cols">{t("sheetx.pivot.cols")}</option>
                  </select>
                  {(area(f) === "rows" || area(f) === "cols") && <span className="sx-unit"> {(area(f) === "rows" ? rows : cols).indexOf(f) + 1}</span>}
                </td>
                <td>
                  {area(f) === "pages" && (
                    <select aria-label={`${f} ${t("sheetx.pivot.filterItem")}`} value={pages.find((x) => x.field === f)!.item ?? "\u0000all"} onChange={(e) => setPages(pages.map((x) => (x.field === f ? { field: f, ...(e.target.value === "\u0000all" ? {} : { item: e.target.value }) } : x)))}>
                      <option value={"\u0000all"}>{t("sheetx.pivot.all")}</option>
                      {itemsOf(f).map((v) => (
                        <option key={v} value={v}>
                          {v || t("sheetx.pivot.blank")}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="sx-sub">{t("sheetx.pivot.vals")}</h3>
        {vals.map((v, i) => (
          <div key={i} className="sx-btns sx-valrow">
            <select aria-label={t("sheetx.pivot.field")} value={v.field} onChange={(e) => setVals(vals.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select aria-label={t("sheetx.pivot.summary")} value={v.fn} onChange={(e) => setVals(vals.map((x, j) => (j === i ? { ...x, fn: e.target.value as PivotFn } : x)))}>
              {FN_LIST.map((k) => (
                <option key={k} value={k}>
                  {t(`sheetx.pivot.fn.${k}`)}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost" onClick={() => setVals(vals.filter((_, j) => j !== i))}>
              {t("sheetx.delete")}
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => setVals([...vals, { field: fields.find((_, k) => numeric(k)) ?? fields[0], fn: "sum" }])}>
          {t("sheetx.pivot.addValue")}
        </button>
        <Actions onClose={onClose} onOk={() => void ok()} disabled={!vals.length} />
      </div>
    </Modal>
  );
}

// ───── 함수 삽입 ─────

export const FN_CATS: Record<string, string[]> = {
  common: ["SUM", "AVERAGE", "IF", "COUNT", "MAX", "MIN", "VLOOKUP", "XLOOKUP", "SUMIF", "COUNTIF", "IFERROR", "ROUND", "TODAY", "TEXT", "CONCAT"],
  math: ["SUM", "SUMIF", "SUMIFS", "SUMPRODUCT", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "MOD", "ABS", "POWER", "SQRT", "PRODUCT", "CEILING", "FLOOR", "RAND", "RANDBETWEEN", "SUBTOTAL"],
  stat: ["AVERAGE", "AVERAGEIF", "AVERAGEIFS", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF", "COUNTIFS", "MAX", "MAXIFS", "MIN", "MINIFS", "MEDIAN", "MODE", "RANK", "LARGE", "SMALL", "STDEV", "VAR"],
  logic: ["IF", "IFS", "AND", "OR", "NOT", "XOR", "IFERROR", "IFNA", "SWITCH", "TRUE", "FALSE"],
  text: ["CONCAT", "CONCATENATE", "TEXTJOIN", "LEFT", "RIGHT", "MID", "LEN", "FIND", "SEARCH", "REPLACE", "SUBSTITUTE", "UPPER", "LOWER", "PROPER", "TRIM", "TEXT", "VALUE", "REPT"],
  date: ["TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "WEEKDAY", "WEEKNUM", "EDATE", "EOMONTH", "DATEDIF", "NETWORKDAYS", "WORKDAY", "DAYS"],
  lookup: ["VLOOKUP", "HLOOKUP", "XLOOKUP", "INDEX", "MATCH", "XMATCH", "LOOKUP", "CHOOSE", "OFFSET", "INDIRECT", "ROW", "COLUMN", "ROWS", "COLUMNS", "FILTER", "SORT", "UNIQUE"],
  finance: ["PMT", "FV", "PV", "NPV", "IRR", "RATE", "NPER"],
};

function FnDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const all = useMemo(() => Object.keys(FUNCTIONS).sort(), []);
  const [cat, setCat] = useState("common");
  const [q, setQ] = useState("");
  const list = q ? all.filter((f) => f.includes(q.toUpperCase())) : cat === "all" ? all : FN_CATS[cat].filter((f) => all.includes(f) || f === "TRUE" || f === "FALSE");
  const [pick, setPick] = useState(list[0] ?? "SUM");
  const ok = (name = pick) => {
    onClose();
    startCellEdit(`=${name}(`);
  };
  return (
    <Modal labelledBy="sx-fn-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-fn-title">{t("sheetx.fn.title")}</h2>
        <Row label={t("sheetx.fn.search")}>
          <input autoFocus data-autofocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && list[0] && ok(list[0])} />
        </Row>
        <Row label={t("sheetx.fn.category")}>
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {[...Object.keys(FN_CATS), "all"].map((k) => (
              <option key={k} value={k}>
                {t(`sheetx.fn.cat.${k}`)}
              </option>
            ))}
          </select>
        </Row>
        <div className="sx-list sx-fnlist" role="listbox">
          {list.map((f) => (
            <button key={f} type="button" role="option" aria-selected={pick === f} className={cx(pick === f && "on")} onClick={() => setPick(f)} onDoubleClick={() => ok(f)}>
              {f}
            </button>
          ))}
        </div>
        <Actions onClose={onClose} onOk={() => ok()} />
      </div>
    </Modal>
  );
}

// ───── 선택하여 붙여넣기 (Ctrl+Alt+V) ─────

const PS_WHAT: [PasteWhat, string][] = [["all", "a"], ["formulas", "f"], ["values", "v"], ["formats", "t"], ["comments", "c"], ["allExceptBorders", "x"], ["colWidths", "w"], ["formulasNumFmt", "r"], ["valuesNumFmt", "u"]];
const PS_OP: [PasteOp, string][] = [["none", "o"], ["add", "d"], ["sub", "s"], ["mul", "m"], ["div", "i"]];

/** Excel's Paste Special: 붙여넣기 (what), 연산, 내용 있는 셀만 붙여넣기, 행/열 바꿈; the underlined letters pick an option
 *  (V then Enter = values, as in Excel). */
function PasteSpecialDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const [what, setWhat] = useState<PasteWhat>("all");
  const [op, setOp] = useState<PasteOp>("none");
  const [skipBlanks, setSkip] = useState(false);
  const [transpose, setTranspose] = useState(false);
  const ok = () => {
    onClose();
    const sel = selOf(page.id);
    const area = pasteSpecial(page.id, { r: sel.ar, c: sel.ac }, { what, op, skipBlanks, transpose });
    if (area) setSel(page.id, { ...sel, r0: area.r0, c0: area.c0, r1: area.r1, c1: area.c1 });
  };
  const opsOn = what === "all" || what === "formulas" || what === "values" || what === "allExceptBorders" || what === "formulasNumFmt" || what === "valuesNumFmt";
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const w = PS_WHAT.find((x) => x[1] === k);
    const o = PS_OP.find((x) => x[1] === k);
    if (w) setWhat(w[0]);
    else if (o) setOp(o[0]);
    else if (k === "b") setSkip((v) => !v);
    else if (k === "e") setTranspose((v) => !v);
    else if (e.key === "Enter") ok();
    else return;
    e.preventDefault();
  };
  return (
    <Modal labelledBy="sx-ps-title" onClose={onClose} className="sheet-dlg sx-dlg sx-ps">
      <div onKeyDown={onKey}>
        <h2 id="sx-ps-title">{t("sheetx.ps.title")}</h2>
        <fieldset className="sx-ps-group" role="radiogroup" aria-label={t("sheetx.ps.paste")}>
          <legend>{t("sheetx.ps.paste")}</legend>
          {PS_WHAT.map(([k]) => (
            <label key={k} className="sx-check">
              <input type="radio" name="sx-ps-what" checked={what === k} onChange={() => setWhat(k)} />
              {t(`sheetx.ps.${k}`)}
            </label>
          ))}
        </fieldset>
        <fieldset className="sx-ps-group" role="radiogroup" aria-label={t("sheetx.ps.operation")} disabled={!opsOn}>
          <legend>{t("sheetx.ps.operation")}</legend>
          {PS_OP.map(([k]) => (
            <label key={k} className="sx-check">
              <input type="radio" name="sx-ps-op" checked={op === k} onChange={() => setOp(k)} />
              {t(`sheetx.ps.${k}`)}
            </label>
          ))}
        </fieldset>
        <div className="sx-ps-checks">
          <Check label={t("sheetx.ps.skipBlanks")} checked={skipBlanks} onChange={setSkip} />
          <Check label={t("sheetx.ps.transpose")} checked={transpose} onChange={setTranspose} />
        </div>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

/** The 조건부 서식 menu's data bar / colour scale / icon set galleries (applied at once, as in Excel). */
export const DATA_BARS = ["#638EC6", "#63BE7B", "#FF555A", "#FFB628", "#008AEF", "#D6007B"];
export const COLOR_SCALES: { id: string; colors: string[] }[] = [
  { id: "gyr", colors: ["#F8696B", "#FFEB84", "#63BE7B"] },
  { id: "ryg", colors: ["#63BE7B", "#FFEB84", "#F8696B"] },
  { id: "gwr", colors: ["#F8696B", "#FFFFFF", "#63BE7B"] },
  { id: "bwr", colors: ["#F8696B", "#FFFFFF", "#5A8AC6"] },
  { id: "wg", colors: ["#FFFFFF", "#63BE7B"] },
  { id: "wr", colors: ["#FFFFFF", "#F8696B"] },
];
export { ICON_SETS };

// ───── 표 만들기 (Ctrl+T · 홈 ▸ 표 서식) ─────

/** The label of a built-in table style (보통 2). */
export function tableStyleLabel(style: string): string {
  const m = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(style);
  return m ? tt(`sheetx.table.${m[1].toLowerCase()}`, { n: m[2] }) : style;
}

function TableCreate({ page, style, onClose }: { page: Page; style?: string; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const g0 = useMemo(() => dataArea(sh, page.id), [sh, page.id]);
  const [ref, setRef] = useState(() => (g0.r0 === g0.r1 && g0.c0 === g0.c1 ? addr(g0.r0, g0.c0) : rangeText(g0)));
  const [header, setHeader] = useState(() => guessHeader(sh, g0));
  const ok = () => {
    const g = parseRange(ref.replace(/\$/g, "").replace(/^.*!/, ""));
    if (!g) return void S().notify(t("sheetx.table.bad"));
    onClose();
    createTable(page.id, g, header, style);
  };
  return (
    <Modal labelledBy="sx-tb-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sx-tb-title">{t("sheetx.table.h")}</h2>
        <Row label={t("sheetx.table.where")}>
          <input autoFocus data-autofocus value={ref} spellCheck={false} onChange={(e) => setRef(e.target.value)} onFocus={(e) => e.target.select()} />
        </Row>
        <Check label={t("sheetx.table.header")} checked={header} onChange={setHeader} />
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 그룹 (행 / 열을 고르는 상자) ─────

function GroupDialog({ page, ungroup, onClose }: { page: Page; ungroup?: boolean; onClose: () => void }) {
  const t = useT();
  const [axis, setAxis] = useState<"row" | "col">("row");
  const ok = () => {
    onClose();
    groupLines(page.id, axis, norm(selOf(page.id)), ungroup ? -1 : 1);
  };
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key.toLowerCase() === "r") setAxis("row");
    else if (e.key.toLowerCase() === "c") setAxis("col");
    else if (e.key === "Enter") ok();
    else return;
    e.preventDefault();
  };
  return (
    <Modal labelledBy="sx-gr-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={onKey}>
        <h2 id="sx-gr-title">{t(ungroup ? "sheetx.ungroup.btn" : "sheetx.group.title")}</h2>
        <div role="radiogroup">
          {(["row", "col"] as const).map((k) => (
            <label key={k} className="sx-check">
              <input type="radio" name="sx-gr" checked={axis === k} onChange={() => setAxis(k)} />
              {t(k === "row" ? "sheetx.group.rows" : "sheetx.group.cols")}
            </label>
          ))}
        </div>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 부분합 ─────

function SubtotalDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const g = useMemo(() => dataArea(sh, page.id), [sh, page.id]);
  const names = Array.from({ length: g.c1 - g.c0 + 1 }, (_, i) => shownText(sh, sh.cells[addr(g.r0, g.c0 + i)], lang()) || colLetters(g.c0 + i));
  const [by, setBy] = useState(g.c0);
  const [fn, setFn] = useState(9);
  const [cols, setCols] = useState<Set<number>>(() => new Set([g.c1]));
  const ok = () => {
    onClose();
    if (cols.size) subtotals(page.id, g, by, fn, [...cols].sort((a, b) => a - b));
  };
  return (
    <Modal labelledBy="sx-st-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-st-title">{t("sheetx.sub.h")}</h2>
        <Row label={t("sheetx.sub.by")}>
          <select value={by} onChange={(e) => setBy(Number(e.target.value))}>
            {names.map((n, i) => (
              <option key={i} value={g.c0 + i}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("sheetx.sub.fn")}>
          <select value={fn} onChange={(e) => setFn(Number(e.target.value))}>
            {SUBTOTAL_FNS.map((k) => (
              <option key={k} value={k}>
                {t(`sheetx.sub.f${k}`)}
              </option>
            ))}
          </select>
        </Row>
        <fieldset className="sx-ps-group">
          <legend>{t("sheetx.sub.cols")}</legend>
          {names.map((n, i) => (
            <Check
              key={i}
              label={n}
              checked={cols.has(g.c0 + i)}
              onChange={(v) =>
                setCols((s) => {
                  const x = new Set(s);
                  if (v) x.add(g.c0 + i);
                  else x.delete(g.c0 + i);
                  return x;
                })
              }
            />
          ))}
        </fieldset>
        <Actions onClose={onClose} onOk={ok} disabled={!cols.size} />
      </div>
    </Modal>
  );
}

// ───── 목표값 찾기 ─────

function GoalSeekDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sel = selOf(page.id);
  const [set, setSet] = useState(addr(sel.ar, sel.ac));
  const [to, setTo] = useState("");
  const [by, setBy] = useState("");
  const [res, setRes] = useState<{ found: boolean; x: number; y: number; a: string; c: string } | null>(null);
  const clean = (s: string) => s.replace(/\$/g, "").replace(/^.*!/, "").trim().toUpperCase();
  const run = () => {
    const a = clean(set), c = clean(by), target = Number(to);
    if (!parseAddr(a) || !parseAddr(c) || to.trim() === "" || !Number.isFinite(target)) return void S().notify(t("sheetx.goal.bad"));
    if (!page.sheet!.cells[a]?.f) return void S().notify(t("sheetx.goal.noFormula"));
    const r = goalSeek(page.id, a, target, c);
    if (r) setRes({ ...r, a, c });
  };
  const keep = () => {
    if (res) {
      const old = page.sheet!.cells[res.c];
      setCells(page.id, [{ a: res.c, cell: { ...(old?.s ? { s: old.s } : {}), v: Math.round(res.x * 1e10) / 1e10 } }], t("sheetx.goal.title"));
    }
    onClose();
  };
  const show = (v: number) => String(Math.round(v * 1e6) / 1e6);
  return (
    <Modal labelledBy="sx-gs-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && (res ? keep() : run()))}>
        <h2 id="sx-gs-title">{t("sheetx.goal.title")}</h2>
        {!res ? (
          <>
            <Row label={t("sheetx.goal.set")}>
              <input autoFocus data-autofocus value={set} spellCheck={false} onChange={(e) => setSet(e.target.value)} onFocus={(e) => e.target.select()} />
            </Row>
            <Row label={t("sheetx.goal.to")}>
              <input value={to} inputMode="decimal" onChange={(e) => setTo(e.target.value)} />
            </Row>
            <Row label={t("sheetx.goal.by")}>
              <input value={by} spellCheck={false} onChange={(e) => setBy(e.target.value)} />
            </Row>
            <Actions onClose={onClose} onOk={run} />
          </>
        ) : (
          <>
            <p className="sx-hint" role="status">
              {t(res.found ? "sheetx.goal.found" : "sheetx.goal.notFound", { a: res.a })}
            </p>
            <p className="sx-hint">{t("sheetx.goal.result", { t: to, v: show(res.y) })}</p>
            <Actions onClose={onClose} onOk={keep} />
          </>
        )}
      </div>
    </Modal>
  );
}

// ───── 오류 검사 ─────

const ERR_KEY: Record<string, string> = { "#DIV/0!": "div0", "#N/A": "na", "#NAME?": "name", "#REF!": "ref", "#VALUE!": "value", "#NUM!": "num" };

function ErrorCheckDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const sh = useStore((s) => s.doc.pages.find((p) => p.id === page.id)?.sheet) ?? page.sheet!;
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const pick = (from: { r: number; c: number }, back = false) => {
    let p = nextError(sh, from.r, from.c, back);
    for (let i = 0; p && ignored.has(addr(p.r, p.c)) && i < 10000; i++) p = nextError(sh, p.r, p.c, back);
    return p && !ignored.has(addr(p.r, p.c)) ? p : null;
  };
  const [cur, setCur] = useState(() => {
    const s = selOf(page.id);
    const here = sh.cells[addr(s.ar, s.ac)];
    return here?.t === "e" ? { r: s.ar, c: s.ac, err: String(here.v) } : nextError(sh, s.ar, s.ac);
  });
  useEffect(() => {
    if (cur) setSel(page.id, { ar: cur.r, ac: cur.c, r0: cur.r, c0: cur.c, r1: cur.r, c1: cur.c });
  }, [cur, page.id]);
  const go = (back: boolean) => cur && setCur(pick(cur, back));
  const a = cur ? addr(cur.r, cur.c) : "";
  return (
    <Modal labelledBy="sx-ec-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-ec-title">{t("sheetx.err.btn")}</h2>
        {cur ? (
          <>
            <p className="sx-hint">
              <b>{t("sheetx.err.at", { a })}</b>
            </p>
            <p className="sx-hint">
              <code>={sh.cells[a]?.f ?? ""}</code>
            </p>
            <p className="sx-hint">{t(`sheetx.err.d.${ERR_KEY[cur.err] ?? "other"}`)}</p>
            <div className="sx-btns">
              <button type="button" className="btn btn-ghost" onClick={() => (onClose(), startCellEdit(`=${sh.cells[a]?.f ?? ""}`))}>
                {t("sheetx.err.edit")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  const x = new Set(ignored).add(a);
                  setIgnored(x);
                  const n = nextError(sh, cur.r, cur.c);
                  setCur(n && !x.has(addr(n.r, n.c)) ? n : null);
                }}
              >
                {t("sheetx.err.ignore")}
              </button>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => go(true)}>
                {t("sheetx.err.prev")}
              </button>
              <button type="button" className="btn btn-primary" data-autofocus onClick={() => go(false)}>
                {t("sheetx.err.next")}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sx-hint" role="status">
              {t("sheetx.err.none")}
            </p>
            <Actions onClose={onClose} onOk={onClose} />
          </>
        )}
      </div>
    </Modal>
  );
}

// ───── 스파크라인 만들기 ─────

function SparkDialog({ page, type, onClose }: { page: Page; type: "line" | "column" | "stacked"; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const g0 = useMemo(() => selArea(sh, page.id), [sh, page.id]);
  const [data, setData] = useState(() => (g0.r0 === g0.r1 && g0.c0 === g0.c1 ? "" : rangeText(g0)));
  const [loc, setLoc] = useState("");
  const ok = () => {
    if (!addSparklines(page.id, data.trim(), loc.trim(), type)) return void S().notify(t("sheetx.spark.bad"));
    onClose();
  };
  return (
    <Modal labelledBy="sx-sp-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sx-sp-title">{t("sheetx.spark.title")}</h2>
        <Row label={t("sheetx.spark.data")}>
          <input autoFocus={!data} value={data} spellCheck={false} onChange={(e) => setData(e.target.value)} />
        </Row>
        <Row label={t("sheetx.spark.loc")}>
          <input autoFocus={!!data} data-autofocus value={loc} spellCheck={false} onChange={(e) => setLoc(e.target.value)} />
        </Row>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 슬라이서 삽입 ─────

function SlicerDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const src = useMemo(() => slicerSourceAt(page.id), [page.id]);
  const [on, setOn] = useState<Set<string>>(new Set());
  if (!src) {
    return (
      <Modal labelledBy="sx-sl-title" onClose={onClose} className="sheet-dlg sx-dlg">
        <div onKeyDown={stop}>
          <h2 id="sx-sl-title">{t("sheetx.slicer.title")}</h2>
          <p className="sx-hint">{t("sheetx.slicer.none")}</p>
          <Actions onClose={onClose} onOk={onClose} />
        </div>
      </Modal>
    );
  }
  const ok = () => {
    onClose();
    insertSlicers(page.id, src.fields.filter((f) => on.has(f)));
  };
  return (
    <Modal labelledBy="sx-sl-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-sl-title">{t("sheetx.slicer.title")}</h2>
        <div className="sx-list">
          {src.fields.map((f) => (
            <Check
              key={f}
              label={f}
              checked={on.has(f)}
              onChange={(v) =>
                setOn((x) => {
                  const n = new Set(x);
                  v ? n.add(f) : n.delete(f);
                  return n;
                })
              }
            />
          ))}
        </div>
        <Actions onClose={onClose} onOk={ok} disabled={!on.size} />
      </div>
    </Modal>
  );
}

// ───── 이동 (F5 / Ctrl+G) · 이동 옵션 ─────

/** 이동: the names of the workbook and the places gone to, a reference typed; 옵션… opens 이동 옵션 (Excel). */
function GoToDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const names = Object.keys(page.sheet!.names ?? {}).filter((n) => !/^_xlnm\./i.test(n));
  const [ref, setRef] = useState("");
  const go = () => {
    if (!ref.trim()) return;
    if (goTo(page.id, ref)) onClose();
    else S().notify(t("sheetx.goto.bad"));
  };
  return (
    <Modal labelledBy="sx-goto-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && go())}>
        <h2 id="sx-goto-title">{t("sheetx.goto.title")}</h2>
        <div className="sx-label">{t("sheetx.goto.list")}</div>
        <div className="sx-list sx-goto-list" role="listbox" aria-label={t("sheetx.goto.list")}>
          {names.map((n) => (
            <button key={n} type="button" role="option" aria-selected={ref === n} className={cx(ref === n && "on")} onClick={() => setRef(n)} onDoubleClick={() => (goTo(page.id, n), onClose())}>
              {n}
            </button>
          ))}
        </div>
        <Row label={t("sheetx.goto.ref")}>
          <input autoFocus data-autofocus value={ref} spellCheck={false} onChange={(e) => setRef(e.target.value)} />
        </Row>
        <Actions onClose={onClose} onOk={go} extra={<button type="button" className="btn btn-ghost" onClick={() => openDlg({ kind: "goSpecial" })}>{t("sheetx.goto.special")}</button>} />
      </div>
    </Modal>
  );
}

const GO_KINDS: GoSpecial[] = ["notes", "constants", "formulas", "blanks", "region", "lastCell", "cond", "validation"];

/** 이동 옵션: the cells of one kind picked (빈 셀 · 상수 · 수식 · 메모 …), as a multi-area selection. */
function GoSpecialDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<GoSpecial>("blanks");
  const ok = () => {
    if (goSpecial(page.id, kind)) onClose();
  };
  return (
    <Modal labelledBy="sx-gs2-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sx-gs2-title">{t("sheetx.gs.title")}</h2>
        <div className="sheet-radios sx-radios2" role="radiogroup">
          {GO_KINDS.map((k) => (
            <label key={k}>
              <input type="radio" name="sx-gs2" checked={kind === k} onChange={() => setKind(k)} />
              {t(`sheetx.gs.${k}`)}
            </label>
          ))}
        </div>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 이동/복사 (시트 탭) ─────

function MoveCopyDialog({ page, pageId, onClose }: { page: Page; pageId: string; onClose: () => void }) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const pages = bookPages(doc, page);
  const [before, setBefore] = useState<string | null>(pages[pages.findIndex((p) => p.id === pageId) + 1]?.id ?? null);
  const [copy, setCopy] = useState(false);
  const ok = () => {
    onClose();
    moveCopySheet(pageId, before, copy);
  };
  return (
    <Modal labelledBy="sx-mc-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sx-mc-title">{t("sheetx.mc.title")}</h2>
        <div className="sx-label">{t("sheetx.mc.before")}</div>
        <div className="sx-list sx-goto-list" role="listbox" aria-label={t("sheetx.mc.before")}>
          {pages.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={before === p.id} className={cx(before === p.id && "on")} onClick={() => setBefore(p.id)}>
              {p.sheet!.name}
            </button>
          ))}
          <button type="button" role="option" aria-selected={before === null} className={cx(before === null && "on")} onClick={() => setBefore(null)}>
            {t("sheetx.mc.end")}
          </button>
        </div>
        <Check label={t("sheetx.mc.copy")} checked={copy} onChange={setCopy} />
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 채우기 ▸ 계열 ─────

function SeriesDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const g = norm(selOf(page.id));
  const [dir, setDir] = useState<"rows" | "cols">(g.r1 - g.r0 >= g.c1 - g.c0 ? "cols" : "rows");
  const [type, setType] = useState<"linear" | "growth" | "date">("linear");
  const [unit, setUnit] = useState<"day" | "weekday" | "month" | "year">("day");
  const [step, setStep] = useState("1");
  const [stop, setStopV] = useState("");
  const ok = () => {
    const s = Number(step);
    if (!Number.isFinite(s)) return;
    onClose();
    fillSeries(page.id, { dir, type, unit, step: s, ...(stop.trim() && Number.isFinite(Number(stop)) ? { stop: Number(stop) } : {}) });
  };
  const radios = <T extends string>(name: string, list: T[], v: T, set: (x: T) => void, disabled = false) => (
    <fieldset className="sx-fieldset" disabled={disabled}>
      <legend>{t(`sheetx.series.${name}`)}</legend>
      {list.map((k) => (
        <label key={k}>
          <input type="radio" name={`sx-series-${name}`} checked={v === k} onChange={() => set(k)} />
          {t(`sheetx.series.${k}`)}
        </label>
      ))}
    </fieldset>
  );
  return (
    <Modal labelledBy="sx-series-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sx-series-title">{t("sheetx.series.title")}</h2>
        <div className="sx-series">
          {radios("dir", ["rows", "cols"] as const, dir, setDir)}
          {radios("type", ["linear", "growth", "date"] as const, type, setType)}
          {radios("unit", ["day", "weekday", "month", "year"] as const, unit, setUnit, type !== "date")}
        </div>
        <Row label={t("sheetx.series.step")}>
          <input autoFocus data-autofocus value={step} inputMode="decimal" onChange={(e) => setStep(e.target.value)} />
        </Row>
        <Row label={t("sheetx.series.stop")}>
          <input value={stop} inputMode="decimal" onChange={(e) => setStopV(e.target.value)} />
        </Row>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 수식 계산 ─────

/** 수식 계산: the active cell's formula worked out one step at a time (계산), back to the start (다시 시작). */
function EvalFormulaDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const s = selOf(page.id);
  const a = addr(s.ar, s.ac);
  const steps = useMemo(() => evalSteps(page.id, a), [page.id, a]);
  const [i, setI] = useState(0);
  const last = i >= steps.length - 1;
  return (
    <Modal labelledBy="sx-eval-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-eval-title">{t("sheetx.eval.title")}</h2>
        <Row label={t("sheetx.eval.ref")}>
          <input readOnly value={`${page.sheet!.name}!${a}`} />
        </Row>
        <div className="sx-label">{t("sheetx.eval.value")}</div>
        <div className="sx-eval" aria-live="polite">{steps.length ? steps[i] : t("sheetx.eval.none")}</div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={!steps.length} onClick={() => setI(last ? 0 : i + 1)}>
            {t(last ? "sheetx.eval.restart" : "sheetx.eval.step")}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            {t("sheetx.eval.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───── 통합 ─────

function ConsolidateDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const [fn, setFn] = useState<ConsolFn>("sum");
  const [ref, setRef] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [top, setTop] = useState(false);
  const [left, setLeft] = useState(false);
  const add = () => {
    const r = ref.trim();
    if (r && !refs.includes(r)) setRefs([...refs, r]);
    setRef("");
  };
  const ok = () => {
    const list = ref.trim() && !refs.includes(ref.trim()) ? [...refs, ref.trim()] : refs;
    if (consolidate(page.id, list, fn, top, left)) onClose();
  };
  return (
    <Modal labelledBy="sx-consol-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-consol-title">{t("sheetx.consol.title")}</h2>
        <Row label={t("sheetx.consol.fn")}>
          <select value={fn} onChange={(e) => setFn(e.target.value as ConsolFn)}>
            {(["sum", "count", "average", "max", "min", "product"] as const).map((k) => (
              <option key={k} value={k}>
                {t(`sheetx.consol.f.${k}`)}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t("sheetx.consol.ref")}>
          <input autoFocus data-autofocus value={ref} spellCheck={false} onChange={(e) => setRef(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        </Row>
        <div className="sx-label">{t("sheetx.consol.all")}</div>
        <div className="sx-list sx-goto-list" role="listbox" aria-label={t("sheetx.consol.all")}>
          {refs.map((r) => (
            <button key={r} type="button" role="option" aria-selected={false}>
              {r}
            </button>
          ))}
        </div>
        <div className="sx-btns">
          <button type="button" className="btn btn-ghost" onClick={add}>
            {t("sheetx.consol.add")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!refs.length} onClick={() => setRefs(refs.slice(0, -1))}>
            {t("sheetx.consol.del")}
          </button>
        </div>
        <Check label={t("sheetx.consol.top")} checked={top} onChange={setTop} />
        <Check label={t("sheetx.consol.left")} checked={left} onChange={setLeft} />
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 시나리오 관리자 ─────

function ScenarioManager({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const sh = doc.pages.find((p) => p.id === page.id)?.sheet ?? page.sheet!;
  const list = sh.scenarios?.list ?? [];
  const [i, setI] = useState(0);
  const [results, setResults] = useState("");
  const cur = list[i];
  return (
    <Modal labelledBy="sx-scen-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-scen-title">{t("sheetx.scen.title")}</h2>
        <div className="sx-label">{t("sheetx.scen.list")}</div>
        <div className="sx-list sx-goto-list" role="listbox" aria-label={t("sheetx.scen.list")}>
          {list.length ? (
            list.map((x, k) => (
              <button key={k} type="button" role="option" aria-selected={k === i} className={cx(k === i && "on")} onClick={() => setI(k)} onDoubleClick={() => showScenario(page.id, k)}>
                {x.name}
              </button>
            ))
          ) : (
            <span className="sx-hint">{t("sheetx.scen.empty")}</span>
          )}
        </div>
        {cur && <p className="sx-hint">{t("sheetx.scen.cells", { cells: cur.cells.join(",") })}</p>}
        <div className="sx-btns">
          <button type="button" className="btn btn-ghost" onClick={() => openDlg({ kind: "scenarioEdit" })}>
            {t("sheetx.scen.add")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!cur} onClick={() => deleteScenario(page.id, i)}>
            {t("sheetx.scen.del")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!cur} onClick={() => openDlg({ kind: "scenarioEdit", i })}>
            {t("sheetx.scen.edit")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!cur} onClick={() => showScenario(page.id, i)}>
            {t("sheetx.scen.show")}
          </button>
        </div>
        <Row label={t("sheetx.scen.resultCells")}>
          <input value={results} spellCheck={false} placeholder="B5" onChange={(e) => setResults(e.target.value)} />
        </Row>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={!list.length} onClick={() => (onClose(), scenarioSummary(page.id, results.split(/[,\s]+/).map((x) => x.replace(/\$/g, "").toUpperCase()).filter((x) => !!parseAddr(x))))}>
            {t("sheetx.scen.summaryBtn")}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            {t("sheetx.eval.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 시나리오 추가 / 편집: the name and changing cells, then the values (now in the cells, or typed). */
function ScenarioEdit({ page, i, onClose }: { page: Page; i?: number; onClose: () => void }) {
  const t = useT();
  const sh = page.sheet!;
  const old = i != null ? sh.scenarios?.list[i] : undefined;
  const g = norm(selOf(page.id));
  const [name, setName] = useState(old?.name ?? "");
  const [cells, setCellsText] = useState(old?.cells.join(",") ?? (g.r0 === g.r1 && g.c0 === g.c1 ? addr(g.r0, g.c0) : `${addr(g.r0, g.c0)}:${addr(g.r1, g.c1)}`));
  const [vals, setVals] = useState<string[] | null>(old ? [...old.vals] : null);
  const list = useMemo(() => {
    const out: string[] = [];
    for (const part of cells.split(/[,\s]+/)) {
      const q = parseRange(part.replace(/\$/g, "").toUpperCase());
      if (q) for (let r = q.r0; r <= Math.min(q.r1, q.r0 + 31); r++) for (let c = q.c0; c <= Math.min(q.c1, q.c0 + 31); c++) out.push(addr(r, c));
    }
    return out.slice(0, 32);
  }, [cells]);
  const ok = () => {
    if (!name.trim() || !list.length) return;
    if (!vals) return setVals(list.map((a) => (sh.cells[a]?.v !== undefined ? String(sh.cells[a]!.v) : "")));
    onClose();
    saveScenario(page.id, name.trim(), list, vals, undefined, i);
    openDlg({ kind: "scenarios" });
  };
  return (
    <Modal labelledBy="sx-scenedit-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sx-scenedit-title">{t(vals ? "sheetx.scen.values" : old ? "sheetx.scen.editTitle" : "sheetx.scen.addTitle")}</h2>
        {!vals ? (
          <>
            <Row label={t("sheetx.scen.name")}>
              <input autoFocus data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
            </Row>
            <Row label={t("sheetx.scen.changing")}>
              <input value={cells} spellCheck={false} onChange={(e) => setCellsText(e.target.value)} />
            </Row>
          </>
        ) : (
          list.map((a, k) => (
            <Row key={a} label={a}>
              <input autoFocus={k === 0} data-autofocus={k === 0 || undefined} value={vals[k] ?? ""} onChange={(e) => setVals(vals.map((v, j) => (j === k ? e.target.value : v)))} />
            </Row>
          ))
        )}
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 데이터 표 ─────

function DataTableDialog({ page, onClose }: { page: Page; onClose: () => void }) {
  const t = useT();
  const [row, setRow] = useState("");
  const [col, setCol] = useState("");
  const ok = () => {
    if (dataTable(page.id, row, col)) onClose();
  };
  return (
    <Modal labelledBy="sx-dt-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && ok())}>
        <h2 id="sx-dt-title">{t("sheetx.dt.title")}</h2>
        <Row label={t("sheetx.dt.row")}>
          <input autoFocus data-autofocus value={row} spellCheck={false} onChange={(e) => setRow(e.target.value)} />
        </Row>
        <Row label={t("sheetx.dt.col")}>
          <input value={col} spellCheck={false} onChange={(e) => setCol(e.target.value)} />
        </Row>
        <Actions onClose={onClose} onOk={ok} />
      </div>
    </Modal>
  );
}

// ───── 사용자 지정 목록 ─────

function CustomListsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [lists, setLists] = useState<string[][]>(() => [...USER_LISTS]);
  const [pick, setPick] = useState<number | null>(null);
  const [text, setText] = useState("");
  const add = () => {
    const items = text.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    if (items.length < 2) return;
    const next = pick != null ? lists.map((l, k) => (k === pick ? items : l)) : [...lists, items];
    setLists(next);
    saveUserLists(next);
    setPick(null);
    setText("");
  };
  const del = () => {
    if (pick == null) return;
    const next = lists.filter((_, k) => k !== pick);
    setLists(next);
    saveUserLists(next);
    setPick(null);
    setText("");
  };
  return (
    <Modal labelledBy="sx-lists-title" onClose={onClose} className="sheet-dlg sx-dlg">
      <div onKeyDown={stop}>
        <h2 id="sx-lists-title">{t("sheetx.lists.title")}</h2>
        <div className="sx-split">
          <div className="sx-list sx-goto-list" role="listbox" aria-label={t("sheetx.lists.lists")}>
            <button type="button" role="option" aria-selected={pick == null} className={cx(pick == null && "on")} onClick={() => (setPick(null), setText(""))}>
              {t("sheetx.lists.new")}
            </button>
            {lists.map((l, k) => (
              <button key={k} type="button" role="option" aria-selected={pick === k} className={cx(pick === k && "on")} onClick={() => (setPick(k), setText(l.join("\n")))}>
                {l.join(", ")}
              </button>
            ))}
            {FILL_LISTS.slice(0, 10).map((l, k) => (
              <button key={`b${k}`} type="button" role="option" aria-selected={false} disabled>
                {l.join(", ")}
              </button>
            ))}
          </div>
          <label className="sx-col">
            <span>{t("sheetx.lists.entries")}</span>
            <textarea aria-label={t("sheetx.lists.entries")} rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={add}>
            {t("sheetx.lists.add")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={pick == null} onClick={del}>
            {t("sheetx.lists.del")}
          </button>
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            {t("sheet.dlg.ok")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───── 메모 스레드 ─────

/** A cell's thread: the comments in order, 답글 (Ctrl+Enter posts), 스레드 해결 / 다시 열기, 스레드 삭제. */
function ThreadDialog({ page, a, onClose }: { page: Page; a: string; onClose: () => void }) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const sh = doc.pages.find((p) => p.id === page.id)?.sheet ?? page.sheet!;
  const th = sh.threads?.[a];
  const [text, setText] = useState("");
  const post = () => {
    if (!text.trim()) return;
    postThread(page.id, a, text);
    setText("");
  };
  return (
    <Modal labelledBy="sx-thread-title" onClose={onClose} className="sheet-dlg sx-dlg sx-thread">
      <div onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.ctrlKey && (e.preventDefault(), post()))}>
        <h2 id="sx-thread-title">
          {t("sheetx.thread.title", { cell: a })}
          {th?.done && <span className="sx-thread-done"> · {t("sheetx.thread.resolved")}</span>}
        </h2>
        <div className="sx-thread-list" role="list">
          {th?.items.map((x) => (
            <div key={x.id} className="sx-thread-item" role="listitem">
              <b>{x.author}</b> <span className="sx-hint">{x.date.slice(0, 16).replace("T", " ")}</span>
              <div>{x.text}</div>
            </div>
          ))}
        </div>
        {!th?.done && (
          <textarea
            className="sx-thread-input"
            aria-label={t(th ? "sheetx.thread.reply" : "sheetx.thread.start")}
            placeholder={t(th ? "sheetx.thread.reply" : "sheetx.thread.start")}
            autoFocus
            data-autofocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <div className="modal-actions">
          {th && (
            <button type="button" className="btn btn-ghost" onClick={() => deleteThread(page.id, a)}>
              {t("sheetx.thread.delete")}
            </button>
          )}
          {th && (
            <button type="button" className="btn btn-ghost" onClick={() => resolveThread(page.id, a, !th.done)}>
              {t(th.done ? "sheetx.thread.reopen" : "sheetx.thread.resolve")}
            </button>
          )}
          {!th?.done && (
            <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={post}>
              {t("sheetx.thread.post")}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("sheetx.eval.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
