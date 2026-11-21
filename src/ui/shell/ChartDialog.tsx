// Chart data editor (slide ribbon → "차트 데이터"): the chart's series names, categories and values in a grid, and its
// type (column, bar, line, pie). Work is in ui/chartEdit.ts.

import { useState } from "react";
import type { SlideChart } from "../../core/types";
import { useT } from "../../i18n";
import { setChartData } from "../chartEdit";
import { Modal } from "./Dialogs";
import { Seg } from "./controls";

type Kind = "col" | "bar" | "line" | "pie";
const KINDS: Kind[] = ["col", "bar", "line", "pie"];

/** A number as typed ("1,234.5", "12%" → 0.12); null when it is not one. */
export function parseChartNumber(s: string): number | null {
  const v = s.trim().replace(/,/g, "");
  if (!v) return 0;
  const pct = /%$/.test(v);
  const n = Number(pct ? v.slice(0, -1) : v);
  return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
}

export function ChartDialog({ headId, data, onClose }: { headId: string; data: SlideChart; onClose: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<SlideChart["kind"]>(data.kind);
  const [cats, setCats] = useState<string[]>(() => [...data.categories]);
  const [names, setNames] = useState<string[]>(() => data.series.map((s) => s.name));
  const [vals, setVals] = useState<string[][]>(() => data.series.map((s) => data.categories.map((_, i) => String(s.values[i] ?? 0))));
  const bad = vals.some((col) => col.some((v) => parseChartNumber(v) === null));

  const setCell = (k: number, i: number, v: string) => setVals((cur) => cur.map((col, kk) => (kk === k ? col.map((x, ii) => (ii === i ? v : x)) : col)));
  const addCat = () => {
    setCats((c) => [...c, t("slideLayout.chart.newCat", { n: c.length + 1 })]);
    setVals((cur) => cur.map((col) => [...col, "0"]));
  };
  const dropCat = () => {
    if (cats.length <= 1) return;
    setCats((c) => c.slice(0, -1));
    setVals((cur) => cur.map((col) => col.slice(0, -1)));
  };
  const addSer = () => {
    setNames((n) => [...n, t("slideLayout.chart.newSeries", { n: n.length + 1 })]);
    setVals((cur) => [...cur, cats.map(() => "0")]);
  };
  const dropSer = () => {
    if (names.length <= 1) return;
    setNames((n) => n.slice(0, -1));
    setVals((cur) => cur.slice(0, -1));
  };
  const ok = () => {
    if (bad) return;
    const series = names.map((name, k) => ({ name, values: vals[k].map((v) => parseChartNumber(v) ?? 0), color: data.series[k]?.color ?? null }));
    const { frame: _f, ...rest } = data;
    setChartData(headId, { ...rest, kind, categories: cats, series });
    onClose();
  };
  const kindOpts = (KINDS.includes(data.kind as Kind) ? KINDS : [data.kind, ...KINDS]).map((k) => ({ value: k, label: t(`slideLayout.chart.kind.${k}`) }));

  return (
    <Modal labelledBy="chart-data-title" className="modal-chart" onClose={onClose}>
      <h2 id="chart-data-title">{t("slideLayout.chart.title")}</h2>
      <p className="modal-sub">{t("slideLayout.chart.sub")}</p>
      <div className="tools-opt">
        <span>{t("slideLayout.chart.kind")}</span>
        <Seg<SlideChart["kind"]> value={kind} onChange={setKind} options={kindOpts} ariaLabel={t("slideLayout.chart.kind")} />
      </div>
      <div className="chart-grid-wrap">
        <table className="chart-grid">
          <thead>
            <tr>
              <th scope="col" />
              {names.map((n, k) => (
                <th key={k} scope="col">
                  <input value={n} aria-label={t("slideLayout.chart.seriesName", { n: k + 1 })} onChange={(e) => setNames((cur) => cur.map((x, kk) => (kk === k ? e.target.value : x)))} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cats.map((c, i) => (
              <tr key={i}>
                <th scope="row">
                  <input value={c} aria-label={t("slideLayout.chart.catName", { n: i + 1 })} onChange={(e) => setCats((cur) => cur.map((x, ii) => (ii === i ? e.target.value : x)))} />
                </th>
                {names.map((_, k) => {
                  const v = vals[k]?.[i] ?? "0";
                  return (
                    <td key={k}>
                      <input className={parseChartNumber(v) === null ? "bad" : undefined} inputMode="decimal" value={v} aria-label={t("slideLayout.chart.value", { s: names[k], c })} onChange={(e) => setCell(k, i, e.target.value)} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="chart-grid-tools">
        <button type="button" className="btn btn-ghost" onClick={addCat}>
          {t("slideLayout.chart.addCat")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={cats.length <= 1} onClick={dropCat}>
          {t("slideLayout.chart.dropCat")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={addSer}>
          {t("slideLayout.chart.addSeries")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={names.length <= 1} onClick={dropSer}>
          {t("slideLayout.chart.dropSeries")}
        </button>
      </div>
      <p className="modal-sub" aria-live="polite">
        {bad ? t("slideLayout.chart.badNumber") : kind === "pie" && names.length > 1 ? t("slideLayout.chart.pieFirst") : ""}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("slideLayout.chart.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={bad} onClick={ok} data-autofocus>
          {t("slideLayout.chart.ok")}
        </button>
      </div>
    </Modal>
  );
}
