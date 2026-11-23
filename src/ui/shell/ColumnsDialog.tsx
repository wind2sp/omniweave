// 단 설정 dialog (레이아웃 › 단 › 단 설정…, Word's Columns window): number of columns, each column's width and the gap
// after it (numbers in a length unit), equal widths, the line between, where it applies (this section / the whole
// document) and a preview of the page. Work is in ui/pageSetupActions.ts applyColumns (one undo step).

import { useMemo, useState } from "react";
import { DEFAULT_COL_GAP, bodyBox, columnBoxes, fromUnit, toUnit, type LengthUnit } from "../../core/pageSetup";
import { useStore } from "../../core/store";
import type { PageColumns } from "../../core/types";
import { useT } from "../../i18n";
import { applyColumns, columnsHere } from "../pageSetupActions";
import { Modal } from "./Dialogs";
import { Seg, Select } from "./controls";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });
const UNITS: LengthUnit[] = ["cm", "mm", "in", "pt"];
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The columns' widths and gaps (px) of a setting in a body `w` wide. */
export function colLayout(c: PageColumns | undefined, w: number): { widths: number[]; gaps: number[] } {
  const boxes = columnBoxes({ x: 0, w }, c);
  return { widths: boxes.map((b) => r2(b.w)), gaps: boxes.slice(1).map((b, i) => r2(b.x - boxes[i].x - boxes[i].w)) };
}

/**
 * The columns a dialog state stands for: equal widths → n columns `gaps[0]` apart (Word num / space); otherwise each
 * column's own width and gap (Word w:col, 한글 colSz).
 */
export function columnsOf(n: number, equal: boolean, widths: number[], gaps: number[], line: boolean): PageColumns | undefined {
  if (n < 2) return undefined;
  const ln = line ? { line: true as const } : {};
  if (equal) return { n, gap: r2(Math.max(0, gaps[0] ?? DEFAULT_COL_GAP)), ...ln };
  return { n, gap: r2(Math.max(0, gaps[0] ?? DEFAULT_COL_GAP)), widths: widths.slice(0, n).map(r2), gaps: gaps.slice(0, n - 1).map((g) => r2(Math.max(0, g))), ...ln };
}

export function ColumnsDialog() {
  const t = useT();
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const bodyW = page ? bodyBox(page).w : 600;
  // (where the caret is: its 이어서 구역's columns, else the section's)
  const start = useMemo(() => columnsHere(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const first = colLayout(start, bodyW);
  const [n, setN] = useState(start?.n ?? 1);
  const [equal, setEqual] = useState(!start?.widths);
  const [widths, setWidths] = useState<number[]>(first.widths);
  const [gaps, setGaps] = useState<number[]>(first.gaps.length ? first.gaps : [DEFAULT_COL_GAP]);
  const [line, setLine] = useState(!!start?.line);
  const [scope, setScope] = useState<"section" | "document">("section");
  const [unit, setUnit] = useState<LengthUnit>("cm");
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);

  /** n columns of equal width with `gap` between them */
  const equalize = (k: number, gap: number) => {
    const g = Math.max(0, Math.min(gap, (bodyW - 16 * k) / Math.max(1, k - 1)));
    const w = r2((bodyW - g * (k - 1)) / k);
    setWidths(Array.from({ length: k }, () => w));
    setGaps(Array.from({ length: Math.max(1, k - 1) }, () => r2(g)));
  };
  const changeN = (k: number) => {
    k = Math.max(1, Math.min(12, Math.round(k) || 1));
    setN(k);
    equalize(k, gaps[0] ?? DEFAULT_COL_GAP);
    if (k < 2) setLine(false);
  };
  /** width `i` set: equal widths → the gap follows; else the last column (the one before when `i` is last) takes the rest */
  const setWidth = (i: number, v: number) => {
    if (equal) {
      const w = Math.max(16, Math.min(v, bodyW / n));
      return equalize(n, n > 1 ? (bodyW - w * n) / (n - 1) : 0);
    }
    const ws = [...widths];
    ws[i] = Math.max(16, v);
    const j = i === n - 1 ? n - 2 : n - 1;
    const others = ws.reduce((a, b, k) => (k === j ? a : a + b), 0) + gaps.slice(0, n - 1).reduce((a, b) => a + b, 0);
    ws[j] = r2(Math.max(16, bodyW - others));
    setWidths(ws.map(r2));
  };
  const setGap = (i: number, v: number) => {
    if (equal) return equalize(n, v);
    const gs = [...gaps];
    gs[i] = Math.max(0, v);
    const j = n - 1;
    const ws = [...widths];
    const others = ws.reduce((a, b, k) => (k === j ? a : a + b), 0) + gs.slice(0, n - 1).reduce((a, b) => a + b, 0);
    ws[j] = r2(Math.max(16, bodyW - others));
    setGaps(gs.map(r2));
    setWidths(ws.map(r2));
  };
  const cols = columnsOf(n, equal, widths, gaps, line);
  const total = widths.slice(0, n).reduce((a, b) => a + b, 0) + gaps.slice(0, n - 1).reduce((a, b) => a + b, 0);
  const bad = n > 1 && (widths.slice(0, n).some((w) => w < 16) || total > bodyW + 1);

  const num = (key: string, px: number, on: (v: number) => void, disabled = false, label?: string) => (
    <input
      type="number"
      aria-label={label}
      min={0}
      step={unit === "pt" ? 1 : unit === "mm" ? 0.5 : 0.01}
      disabled={disabled}
      value={editing?.key === key ? editing.text : toUnit(px, unit)}
      onFocus={() => setEditing({ key, text: String(toUnit(px, unit)) })}
      onBlur={() => setEditing(null)}
      onChange={(e) => {
        setEditing({ key, text: e.target.value });
        const v = Number(e.target.value);
        if (e.target.value.trim() && Number.isFinite(v) && v >= 0) on(fromUnit(v, unit));
      }}
      style={{ width: 76 }}
    />
  );

  // preview: the page's body as a sheet with its columns and the line between
  const pw = 120, scale = pw / (page?.width ?? 794);
  const ph = (page?.height ?? 1123) * scale;
  const box = page ? bodyBox(page) : { x: 76, y: 76, w: bodyW, h: 900 };
  const boxes = columnBoxes({ x: box.x, w: box.w }, cols);

  return (
    <Modal labelledBy="cols-title" className="modal-sm columns-dialog" onClose={close}>
      <h2 id="cols-title">{t("cols.dlg.title")}</h2>
      <div className="tools-opt">
        <span>{t("cols.dlg.presets")}</span>
        <Seg<string>
          value={!cols ? "1" : cols.widths ? (cols.widths[0] < cols.widths[1] && n === 2 ? "left" : n === 2 ? "right" : "") : String(n)}
          onChange={(v) => {
            if (v === "left" || v === "right") {
              setN(2);
              setEqual(false);
              const g = gaps[0] ?? DEFAULT_COL_GAP, a = r2((bodyW - g) / 3), b = r2(bodyW - g - a);
              setWidths(v === "left" ? [a, b] : [b, a]);
              setGaps([g]);
            } else {
              setEqual(true);
              changeN(Number(v));
            }
          }}
          options={[
            { value: "1", label: t("docmode.cols.one") },
            { value: "2", label: t("docmode.cols.two") },
            { value: "3", label: t("docmode.cols.three") },
            { value: "left", label: t("docmode.cols.left") },
            { value: "right", label: t("docmode.cols.right") },
          ]}
        />
      </div>
      <div className="tools-opt">
        <label className="tools-opt">
          <span>{t("cols.dlg.count")}</span>
          <input type="number" aria-label={t("cols.dlg.count")} min={1} max={12} step={1} value={n} onChange={(e) => changeN(Number(e.target.value))} style={{ width: 56 }} />
        </label>
        <span>{t("pagesetup.unit")}</span>
        <Select<LengthUnit> value={unit} width={70} onChange={setUnit} options={UNITS.map((u) => ({ value: u, label: u }))} />
      </div>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <table className="cols-table">
          <thead>
            <tr>
              <th>{t("cols.dlg.col")}</th>
              <th>{t("cols.dlg.width")}</th>
              <th>{t("cols.dlg.gap")}</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: n }, (_, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{num(`w${i}`, widths[i] ?? 0, (v) => setWidth(i, v), equal && i > 0, t("cols.dlg.widthOf", { n: i + 1 }))}</td>
                <td>{i < n - 1 ? num(`g${i}`, gaps[i] ?? 0, (v) => setGap(i, v), equal && i > 0, t("cols.dlg.gapOf", { n: i + 1 })) : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <svg width={pw} height={ph} viewBox={`0 0 ${pw} ${ph}`} role="img" aria-label={t("cols.dlg.preview")} style={{ flex: "none", background: "#fff", border: "1px solid var(--line, #c9ced8)" }}>
          {boxes.map((b, i) => (
            <g key={i}>
              {Array.from({ length: Math.floor((box.h * scale) / 6) }, (_, k) => (
                <rect key={k} x={b.x * scale} y={box.y * scale + k * 6} width={b.w * scale} height={2.2} fill="#9aa3b5" />
              ))}
            </g>
          ))}
          {line &&
            cols &&
            boxes.slice(1).map((b, i) => {
              const x = ((boxes[i].x + boxes[i].w + b.x) / 2) * scale;
              return <line key={i} x1={x} x2={x} y1={box.y * scale} y2={(box.y + box.h) * scale} stroke="#1d1f24" strokeWidth={0.8} />;
            })}
        </svg>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
      <label className="check">
        <input type="checkbox" checked={equal} disabled={n < 2} onChange={(e) => (setEqual(e.target.checked), e.target.checked && equalize(n, gaps[0] ?? DEFAULT_COL_GAP))} />
        <span>{t("cols.dlg.equal")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={line} disabled={n < 2} onChange={(e) => setLine(e.target.checked)} />
        <span>{t("docmode.cols.line")}</span>
      </label>
      </div>
      <p className="modal-sub" aria-live="polite">
        {bad ? t("cols.dlg.tooWide") : t("cols.dlg.body", { w: `${toUnit(bodyW, unit)} ${unit}` })}
      </p>
      <div className="tools-opt">
        <span>{t("pagesetup.scope")}</span>
        <Seg<"section" | "document">
          value={scope}
          onChange={setScope}
          options={[
            { value: "section", label: t("pagesetup.scope.section") },
            { value: "document", label: t("pagesetup.scope.document") },
          ]}
        />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("pagesetup.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={bad || !page}
          data-autofocus
          onClick={() => {
            applyColumns(cols, scope);
            close();
          }}
        >
          {t("pagesetup.apply")}
        </button>
      </div>
    </Modal>
  );
}
