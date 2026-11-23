// 캔버스 크기 (이미지 › 캔버스 크기, image / design modes): width · height with a unit (px · % · mm · cm · in), relative
// values, the 3 × 3 anchor (which part of the old canvas stays put) and how the added room is filled — Photoshop's
// Canvas Size. Separate from the document mode's 쪽 설정 (paper, margins, sections). Work: ui/canvasActions.ts.

import { useMemo, useState } from "react";
import type { Anchor, CanvasFill } from "../../core/canvasSize";
import { currentPage } from "../../core/store";
import { useT } from "../../i18n";
import { CANVAS_MAX, canvasField, canvasTarget, resizeCanvas, type CanvasUnit } from "../canvasActions";
import { Modal } from "./Dialogs";
import { Select } from "./controls";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });
const UNITS: CanvasUnit[] = ["px", "%", "mm", "cm", "in"];

const ARROWS = ["↖", "↑", "↗", "←", "•", "→", "↙", "↓", "↘"];

type FillChoice = "background" | "transparent" | "#ffffff" | "#000000" | "custom";

export function CanvasSizeDialog() {
  const t = useT();
  const page = useMemo(currentPage, []);
  const cur = { w: page?.width ?? 1, h: page?.height ?? 1 };
  const [unit, setUnit] = useState<CanvasUnit>("px");
  const [relative, setRelative] = useState(false);
  const [w, setW] = useState(cur.w);
  const [h, setH] = useState(cur.h);
  const [anchor, setAnchor] = useState<Anchor>(4);
  const [fill, setFill] = useState<FillChoice>("background");
  const [custom, setCustom] = useState("#808080");
  const [editing, setEditing] = useState<{ key: "w" | "h"; text: string } | null>(null);
  const bad = !(w >= 1 && h >= 1);

  const field = (key: "w" | "h", label: string) => {
    const px = key === "w" ? w : h, c = key === "w" ? cur.w : cur.h, set = key === "w" ? setW : setH;
    const shown = canvasField(px, c, unit, relative);
    return (
      <label className="tools-opt" key={key}>
        <span>{label}</span>
        <input
          type="number"
          aria-label={label}
          step={unit === "px" ? 1 : 0.01}
          value={editing?.key === key ? editing.text : shown}
          onFocus={() => setEditing({ key, text: String(shown) })}
          onBlur={() => setEditing(null)}
          onChange={(e) => {
            setEditing({ key, text: e.target.value });
            const v = canvasTarget(Number(e.target.value), c, unit, relative);
            set(e.target.value.trim() && Number.isFinite(v) ? v : NaN);
          }}
          style={{ width: 96 }}
        />
        <span className="muted-note">{unit}</span>
      </label>
    );
  };

  const fillValue: CanvasFill = fill === "custom" ? custom : fill;
  return (
    <Modal labelledBy="canvassize-title" className="modal-sm" onClose={close}>
      <h2 id="canvassize-title">{t("canvas.size.title")}</h2>
      <p className="modal-sub">{t("canvas.size.current", { w: cur.w, h: cur.h })}</p>
      <div className="tools-opt">
        {field("w", t("canvas.size.width"))}
        {field("h", t("canvas.size.height"))}
      </div>
      <div className="tools-opt">
        <span>{t("canvas.size.unit")}</span>
        <Select<CanvasUnit> value={unit} width={70} onChange={setUnit} options={UNITS.map((u) => ({ value: u, label: u }))} />
        <label className="tools-opt">
          <input type="checkbox" checked={relative} onChange={(e) => setRelative(e.target.checked)} />
          <span>{t("canvas.size.relative")}</span>
        </label>
      </div>
      <div className="tools-opt">
        <span>{t("canvas.size.anchor")}</span>
        <div role="radiogroup" aria-label={t("canvas.size.anchor")} style={{ display: "grid", gridTemplateColumns: "repeat(3, 28px)", gap: 2 }}>
          {ARROWS.map((a, i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={anchor === i}
              aria-label={t(`canvas.size.anchor.${i}`)}
              title={t(`canvas.size.anchor.${i}`)}
              className={anchor === i ? "btn btn-primary" : "btn btn-ghost"}
              style={{ width: 28, height: 28, padding: 0 }}
              onClick={() => setAnchor(i as Anchor)}
            >
              {anchor === i ? "■" : a}
            </button>
          ))}
        </div>
      </div>
      <div className="tools-opt">
        <span>{t("canvas.size.fill")}</span>
        <Select<FillChoice>
          value={fill}
          width={150}
          onChange={setFill}
          options={[
            { value: "background", label: t("canvas.size.fill.background") },
            { value: "transparent", label: t("canvas.size.fill.transparent") },
            { value: "#ffffff", label: t("canvas.size.fill.white") },
            { value: "#000000", label: t("canvas.size.fill.black") },
            { value: "custom", label: t("canvas.size.fill.custom") },
          ]}
        />
        {fill === "custom" && <input type="color" aria-label={t("canvas.size.fill.custom")} value={custom} onChange={(e) => setCustom(e.target.value)} />}
      </div>
      <p className="modal-sub" aria-live="polite">
        {bad ? t("canvas.size.range", { max: CANVAS_MAX }) : t("canvas.size.new", { w, h }) + (w < cur.w || h < cur.h ? ` ${t("canvas.size.shrinkNote")}` : "")}
      </p>
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
            if (resizeCanvas(w, h, anchor, fillValue)) close();
          }}
        >
          {t("canvas.size.apply")}
        </button>
      </div>
    </Modal>
  );
}
