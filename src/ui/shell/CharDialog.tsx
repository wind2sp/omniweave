// 글자 모양 (한글 Alt+L) / 글꼴 (Word Ctrl+D): font, size, bold · italic · underline · strike, colour, 자간 and 장평 of
// the selected text (or of what is typed next at the caret) — the same target as the ribbon's text controls
// (Ribbon.tsx textTargetNow). Only the fields changed here are applied, as one undo step (QA 11-24 basic-ux).

import { useMemo, useState } from "react";
import type * as RT from "../../core/richtext";
import { useT } from "../../i18n";
import { Modal } from "./Dialogs";
import { keyContext } from "../keymap";
import { FONTS, textTargetNow } from "./Ribbon";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });
const PT = 96 / 72;
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The character patch of the fields that differ from how the dialog opened (sizes in pt → px). `pct`: 자간 as 한글
 * gives it — percent of each character's own advance (TextRun.spacingPct), in a 한글 document — instead of pt.
 */
export function charDialogPatch(init: CharState, cur: CharState, pct = false): RT.RunPatch {
  const out: RT.RunPatch = {};
  if (cur.font !== init.font && cur.font) out.fontFamily = cur.font;
  if (cur.size !== init.size && cur.size > 0) out.fontSize = Math.round(cur.size * PT * 100) / 100;
  for (const k of ["bold", "italic", "underline", "strike"] as const) if (cur[k] !== init[k]) out[k] = cur[k];
  if (cur.color !== init.color) out.color = cur.color;
  if (cur.spacing !== init.spacing) {
    if (pct) out.spacingPct = cur.spacing ? Math.round(cur.spacing) : null;
    else out.letterSpacing = cur.spacing ? Math.round(cur.spacing * PT * 100) / 100 : null;
  }
  if (cur.scale !== init.scale) out.hscale = cur.scale && cur.scale !== 100 ? cur.scale : null;
  return out;
}

export interface CharState {
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  /** 자간: pt (Word), % of the character (한글 document) */
  spacing: number;
  /** 장평, % */
  scale: number;
}

/**
 * A number field that keeps what is being typed ("-", "-0.", "") until it is a number (a controlled field turned
 * "-" into 0, so -5 could not be typed: QA 11-25 real use, 한글 자간 -5 % became 5 %).
 */
function NumInput({ value, onValue, ...rest }: { value: number; onValue: (v: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [raw, setRaw] = useState(value ? String(value) : "");
  return (
    <input
      type="number"
      {...rest}
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(v)) onValue(v);
        else if (e.target.value === "") onValue(0);
      }}
    />
  );
}

export function CharDialog() {
  const t = useT();
  const tg = useMemo(textTargetNow, []);
  const f = tg?.fmt ?? {};
  // a 한글 document: 자간 in percent, as 한글's own 글자 모양 (QA 11-25 real use: -5 typed as pt became +50 %)
  const pct = useMemo(() => keyContext() === "HWP", []);
  const [init] = useState<CharState>(() => ({
    font: f.fontFamily ?? "",
    size: f.fontSize ? r1(f.fontSize / PT) : 0,
    bold: f.bold === true,
    italic: f.italic === true,
    underline: f.underline === true,
    strike: f.strike === true,
    color: f.color ?? "#000000",
    spacing: pct ? f.spacingPct ?? 0 : f.letterSpacing ? r1(f.letterSpacing / PT) : 0,
    scale: f.hscale ?? 100,
  }));
  const [cur, setCur] = useState(init);
  const set = (p: Partial<CharState>) => setCur((c) => ({ ...c, ...p }));
  const fonts = cur.font && !FONTS.includes(cur.font) ? [cur.font, ...FONTS] : FONTS;
  const apply = () => {
    const patch = charDialogPatch(init, cur, pct);
    if (tg?.applyRun && Object.keys(patch).length) tg.applyRun(patch, t("docux.char.title"));
    close();
  };
  return (
    <Modal labelledBy="char-title" className="modal-sm" onClose={close}>
      <h2 id="char-title">{t("docux.char.title")}</h2>
      <p className="modal-sub">{tg ? t("docux.char.sub") : t("paragraph.noText")}</p>
      <label className="tools-opt">
        <span>{t("ribbon.text.font")}</span>
        <select value={cur.font} onChange={(e) => set({ font: e.target.value })} aria-label={t("ribbon.text.font")}>
          {!cur.font && <option value="">—</option>}
          {fonts.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      <label className="tools-opt">
        <span>{t("docux.char.size")}</span>
        <NumInput min={1} max={1638} step={0.5} value={cur.size} onValue={(v) => set({ size: v })} style={{ width: 76 }} />
        <span className="muted-note">pt</span>
      </label>
      <div className="tools-opt">
        <span>{t("docux.char.style")}</span>
        {(["bold", "italic", "underline", "strike"] as const).map((k) => (
          <label key={k} style={{ marginRight: 10 }}>
            <input type="checkbox" checked={cur[k]} onChange={(e) => set({ [k]: e.target.checked })} /> {t(k === "strike" ? "ribbon.text.strike" : `ribbon.text.${k}`)}
          </label>
        ))}
      </div>
      <label className="tools-opt">
        <span>{t("ribbon.text.color")}</span>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(cur.color) ? cur.color : "#000000"} onChange={(e) => set({ color: e.target.value })} />
      </label>
      <label className="tools-opt">
        <span>{t("docux.char.spacing")}</span>
        <NumInput min={pct ? -50 : -20} max={50} step={pct ? 1 : 0.1} value={cur.spacing} onValue={(v) => set({ spacing: v })} style={{ width: 76 }} />
        <span className="muted-note">{pct ? "%" : "pt"}</span>
      </label>
      <label className="tools-opt">
        <span>{t("docux.char.scale")}</span>
        <NumInput min={10} max={500} step={1} value={cur.scale} onValue={(v) => set({ scale: v || 100 })} style={{ width: 76 }} />
        <span className="muted-note">%</span>
      </label>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("paragraph.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={!tg} onClick={apply}>
          {t("paragraph.apply")}
        </button>
      </div>
    </Modal>
  );
}
