// 쪽 설정 dialog (Page → Page setup…): paper preset or custom size with units, orientation, the six margins and the
// scope (this page / this section / the whole document). Work is in ui/pageSetupActions.ts (one undo step).

import { useMemo, useState } from "react";
import { DEFAULT_MARGINS, PAPERS, fromUnit, paperOf, paperPx, toUnit, type LengthUnit, type PageSetup, type PaperId } from "../../core/pageSetup";
import type { PageMargins } from "../../core/types";
import { useT } from "../../i18n";
import { applyPageSetup, currentSetup, type SetupScope } from "../pageSetupActions";
import { Modal } from "./Dialogs";
import { Seg, Select } from "./controls";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });
const UNITS: LengthUnit[] = ["mm", "cm", "in", "pt", "px"];
const MARGIN_KEYS: (keyof PageMargins)[] = ["top", "bottom", "left", "right", "header", "footer"];

export function PageSetupDialog() {
  const t = useT();
  const start = useMemo(currentSetup, []);
  const [setup, setSetup] = useState<PageSetup>(() => start ?? { ...paperPx("A4"), margins: { ...DEFAULT_MARGINS } });
  const [unit, setUnit] = useState<LengthUnit>("mm");
  const [scope, setScope] = useState<SetupScope>("section");
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const paper = paperOf(setup.width, setup.height);
  const landscape = setup.width > setup.height;
  const m = setup.margins;
  const bodyW = setup.width - m.left - m.right, bodyH = setup.height - m.top - m.bottom;
  const bad = bodyW < 16 || bodyH < 16;

  const setPaper = (id: PaperId | "custom") => {
    if (id === "custom") return;
    const p = paperPx(id);
    setSetup({ ...setup, ...(landscape ? { width: p.height, height: p.width } : p) });
  };
  const setOrientation = (v: "portrait" | "landscape") => {
    if ((v === "landscape") !== landscape) setSetup({ ...setup, width: setup.height, height: setup.width });
  };
  // a paper preset shows its own millimetres (A4 = 210 × 297, not the rounded pixels' 210.1)
  const preset = paper !== "custom" && unit === "mm" ? PAPERS.find((p) => p.id === paper)! : null;
  const shown = (px: number, side?: "w" | "h") => {
    if (preset && side) return landscape === (side === "w") ? preset.h : preset.w;
    return toUnit(px, unit);
  };
  const num = (key: string, label: string, px: number, onPx: (v: number) => void, tip?: string, side?: "w" | "h") => (
    <label className="tools-opt" title={tip} key={key}>
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={unit === "px" || unit === "pt" ? 1 : unit === "mm" ? 0.5 : 0.05}
        // while typing the field keeps the text as typed ("20." is not turned into "20")
        value={editing?.key === key ? editing.text : shown(px, side)}
        onFocus={() => setEditing({ key, text: String(shown(px, side)) })}
        onBlur={() => setEditing(null)}
        onChange={(e) => {
          setEditing({ key, text: e.target.value });
          const v = Number(e.target.value);
          if (e.target.value.trim() && Number.isFinite(v) && v >= 0) onPx(fromUnit(v, unit));
        }}
        style={{ width: 84 }}
      />
      <span className="muted-note">{unit}</span>
    </label>
  );

  return (
    <Modal labelledBy="pagesetup-title" className="modal-sm" onClose={close}>
      <h2 id="pagesetup-title">{t("pagesetup.title")}</h2>
      <p className="modal-sub">{t("pagesetup.sub")}</p>
      <div className="tools-opt">
        <span>{t("pagesetup.paper")}</span>
        <Select<PaperId | "custom">
          value={paper}
          width={170}
          onChange={setPaper}
          options={[...PAPERS.map((p) => ({ value: p.id as PaperId | "custom", label: `${p.id} (${p.w} × ${p.h} mm)` })), { value: "custom", label: t("pagesetup.paper.custom") }]}
        />
        <span>{t("pagesetup.unit")}</span>
        <Select<LengthUnit> value={unit} width={70} onChange={setUnit} options={UNITS.map((u) => ({ value: u, label: u }))} />
      </div>
      <div className="tools-opt">
        {num("w", t("pagesetup.width"), setup.width, (v) => setSetup({ ...setup, width: Math.max(32, Math.round(v * 100) / 100) }), undefined, "w")}
        {num("h", t("pagesetup.height"), setup.height, (v) => setSetup({ ...setup, height: Math.max(32, Math.round(v * 100) / 100) }), undefined, "h")}
      </div>
      <div className="tools-opt">
        <span>{t("pagesetup.orientation")}</span>
        <Seg<"portrait" | "landscape">
          value={landscape ? "landscape" : "portrait"}
          onChange={setOrientation}
          options={[
            { value: "portrait", label: t("pagesetup.portrait") },
            { value: "landscape", label: t("pagesetup.landscape") },
          ]}
        />
      </div>
      <h3 className="modal-sub">{t("pagesetup.margins")}</h3>
      <div className="grid2">
        {MARGIN_KEYS.map((k) =>
          num(k, t(`pagesetup.${k}`), m[k], (v) => setSetup({ ...setup, margins: { ...m, [k]: Math.round(v * 100) / 100 } }), k === "header" ? t("pagesetup.headerTip") : k === "footer" ? t("pagesetup.footerTip") : undefined),
        )}
      </div>
      <p className="modal-sub" aria-live="polite">
        {bad ? t("pagesetup.tooSmall") : t("pagesetup.body", { w: `${toUnit(bodyW, unit)}`, h: `${toUnit(bodyH, unit)} ${unit}` })}
      </p>
      <div className="tools-opt">
        <span>{t("pagesetup.scope")}</span>
        <Seg<SetupScope>
          value={scope}
          onChange={setScope}
          options={[
            { value: "page", label: t("pagesetup.scope.page"), tip: t("pagesetup.scopePageNote") },
            { value: "section", label: t("pagesetup.scope.section") },
            { value: "document", label: t("pagesetup.scope.document") },
          ]}
        />
      </div>
      <p className="modal-sub">{scope === "page" ? t("pagesetup.scopePageNote") : t("pagesetup.noReflow")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("pagesetup.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={bad || !start}
          data-autofocus
          onClick={() => {
            if (applyPageSetup(setup, scope)) close();
          }}
        >
          {t("pagesetup.apply")}
        </button>
      </div>
    </Modal>
  );
}
