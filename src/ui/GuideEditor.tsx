// Small popover to type a guide's exact position (double-click a guide, or View ▸ "안내선 추가…").
// Accepts any unit ("12mm", "1.5in", "300px"); a bare number uses the ruler unit.

import { useEffect, useRef, useState } from "react";
import { currentPage } from "../core/store";
import { parseLength, toUnit } from "../core/units";
import { addGuideAt, deleteGuide, setGuide, unitFor, useAids } from "./aids";
import { Icon } from "./shell/Icons";
import { useT } from "../i18n";

export function GuideEditor() {
  const edit = useAids((s) => s.guideEdit);
  if (!edit) return null;
  return <Editor key={`${edit.axis}:${edit.v}:${edit.sx}:${edit.sy}`} />;
}

function Editor() {
  const t = useT();
  const edit = useAids((s) => s.guideEdit)!;
  const page = currentPage();
  const unit = unitFor(page);
  const [axis, setAxis] = useState(edit.axis);
  const [text, setText] = useState(() => (edit.v == null ? "" : String(Math.round(toUnit(edit.v, unit) * 100) / 100)));
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => useAids.getState().set({ guideEdit: null });

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const apply = () => {
    const v = parseLength(text, unit);
    if (v == null) return setError(t("ribbon.guide.numError"));
    if (edit.v == null || axis !== edit.axis) {
      if (edit.v != null) deleteGuide(edit.axis, edit.v);
      addGuideAt(axis, v);
    } else if (Math.abs(v - edit.v) > 1e-9) setGuide(axis, edit.v, v);
    close();
  };

  return (
    <div
      className="guide-pop"
      role="dialog"
      aria-label={t("ribbon.guide.position")}
      style={{ left: Math.max(8, edit.sx + 10), top: Math.max(28, edit.sy + 10) }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
      }}
    >
      <div className="guide-pop-row">
        <select value={axis} aria-label={t("ribbon.guide.direction")} onChange={(e) => setAxis(e.target.value as "x" | "y")} disabled={edit.v != null}>
          <option value="x">{t("ribbon.guide.vertical")}</option>
          <option value="y">{t("ribbon.guide.horizontal")}</option>
        </select>
      </div>
      <div className="guide-pop-row">
        <input
          ref={input}
          value={text}
          aria-label={t("ribbon.guide.pos")}
          spellCheck={false}
          placeholder={t("ribbon.guide.posPh", { unit })}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
          }}
        />
        <span className="guide-pop-unit">{unit}</span>
      </div>
      {error && <p className="guide-pop-err">{error}</p>}
      <div className="guide-pop-row end">
        {edit.v != null && (
          <button
            type="button"
            className="btn btn-ghost danger"
            onClick={() => {
              deleteGuide(edit.axis, edit.v!);
              close();
            }}
          >
            <Icon name="trash" size={13} />
            <span>{t("ribbon.delete")}</span>
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("ribbon.cancel")}
        </button>
        <button type="button" className="btn btn-primary" onClick={apply}>
          {t("ribbon.apply")}
        </button>
      </div>
    </div>
  );
}
