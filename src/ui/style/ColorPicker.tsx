// Common colour control (design ch. 7.2, phase A skeleton): colour well + hex + alpha + eyedropper + document
// swatches row. Works on the unified Color (core/style), so the original CMYK / spot / theme components of a colour
// survive as long as the user does not change it: only an actual edit replaces the colour with a plain sRGB one.
// Phase B / S2 grows it into the full picker (HSB / CMYK / Lab fields, recent colours, theme row) and replaces the
// shell's ColorField everywhere.

import { useRef, useState, type CSSProperties } from "react";
import { colorOf, cssColor, withAlpha, type Color, type Swatch } from "../../core/style";
import { useT } from "../../i18n";
import { useEyeDropper } from "./eyedropper";

/** "live" while a drag is in progress, "commit" when the change is final (one undo step). */
export type ColorPhase = "live" | "commit";

export interface ColorPickerProps {
  value: Color | null;
  onChange: (c: Color | null, phase: ColorPhase) => void;
  /** offer "none" (fills, strokes) */
  allowNone?: boolean;
  /** document swatches; undefined = the document has none yet (placeholder row) */
  swatches?: readonly Swatch[];
  label?: string;
  showAlpha?: boolean;
}

/**
 * New colour from a picked or typed hex. Six digits keep the old alpha; an alpha typed with the hex (#rgba,
 * #rrggbbaa) replaces it. An unchanged hex keeps the colour as is (original CMYK / spot / theme components), and
 * only the alpha changes when just the typed alpha differs.
 */
export function colorFromHex(hex: string, old: Color | null): Color | null {
  const c = colorOf(hex);
  if (!c) return old;
  const t = hex.trim();
  const typedAlpha = /^#?([0-9a-f]{4}|[0-9a-f]{8})$/i.test(t);
  const a = typedAlpha ? c.a ?? 1 : old?.a ?? 1;
  if (old && old.hex.toLowerCase() === c.hex.toLowerCase()) return (old.a ?? 1) === a ? old : withAlpha(old, a);
  return withAlpha(c, a);
}

/**
 * A gesture that streams "live" changes (colour well drag, alpha slider by mouse or keys): end() says whether it
 * changed anything, so the control sends exactly one "commit" (one undo step) — comparing the final value with the
 * prop does not work, because the live changes have already updated the prop.
 */
export function liveEdit(): { live: () => void; end: () => boolean } {
  let dirty = false;
  return {
    live: () => void (dirty = true),
    end: () => {
      const d = dirty;
      dirty = false;
      return d;
    },
  };
}

export function ColorPicker({ value, onChange, allowNone, swatches, label, showAlpha = true }: ColorPickerProps) {
  const t = useT();
  const eye = useEyeDropper();
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const well = useRef(liveEdit()).current;
  const slider = useRef(liveEdit()).current;
  const hex = value ? value.hex.toLowerCase() : "#000000";
  const alpha = Math.round((value?.a ?? 1) * 100);
  return (
    <div className="st-color" data-space={value?.space ?? "rgb"}>
      {label != null && <span className="st-label">{label}</span>}
      <span className={"swatch" + (value ? "" : " none")} style={{ "--sw": value ? cssColor(value) : "transparent" } as CSSProperties}>
        <input
          type="color"
          value={hex}
          aria-label={label ?? t("style.color.label")}
          onChange={(e) => {
            well.live();
            onChange(colorFromHex(e.target.value, value), "live");
          }}
          onBlur={(e) => well.end() && onChange(colorFromHex(e.target.value, value), "commit")}
        />
      </span>
      <input
        className="hex-input"
        aria-label={t("style.color.hex")}
        value={hexDraft ?? (value ? value.hex.toUpperCase() : t("style.color.none"))}
        onFocus={() => setHexDraft(value ? value.hex.toUpperCase() : "")}
        onChange={(e) => setHexDraft(e.target.value)}
        onBlur={() => {
          const d = (hexDraft ?? "").trim();
          setHexDraft(null);
          if (!d) return allowNone && value && onChange(null, "commit");
          const c = colorFromHex(d.startsWith("#") ? d : "#" + d, value);
          if (c !== value) onChange(c, "commit");
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {showAlpha && value && (
        <input
          className="st-alpha"
          type="range"
          min={0}
          max={100}
          value={alpha}
          aria-label={t("style.color.alpha")}
          title={`${t("style.color.alpha")} ${alpha}%`}
          onChange={(e) => {
            slider.live();
            onChange(withAlpha(value, +e.target.value / 100), "live");
          }}
          onPointerUp={(e) => slider.end() && onChange(withAlpha(value, +(e.target as HTMLInputElement).value / 100), "commit")}
          onKeyUp={(e) => slider.end() && onChange(withAlpha(value, +(e.target as HTMLInputElement).value / 100), "commit")}
          onBlur={(e) => slider.end() && onChange(withAlpha(value, +e.target.value / 100), "commit")}
        />
      )}
      <button
        type="button"
        className="ibtn ibtn-sm st-eyedropper"
        disabled={!eye.supported}
        aria-label={eye.supported ? t("style.color.eyedropper") : t("style.color.eyedropperUnsupported")}
        data-tip={eye.supported ? t("style.color.eyedropper") : t("style.color.eyedropperUnsupported")}
        onClick={async () => {
          const h = await eye.pick();
          if (h) onChange(colorFromHex(h, value), "commit");
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M11.5 1.5a2 2 0 0 1 2.8 2.8L12.6 6l.7.7-1.4 1.4-.7-.7-5.5 5.5H3.5v-2.2L9 5.2l-.7-.7 1.4-1.4.7.7z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      </button>
      {allowNone && value && (
        <button type="button" className="st-none" onClick={() => onChange(null, "commit")}>
          {t("style.color.none")}
        </button>
      )}
      <div className="st-swatches" role="group" aria-label={t("style.color.swatches")}>
        {swatches?.length ? (
          swatches.map((s) => (
            <button
              key={s.id}
              type="button"
              className="st-swatch"
              title={s.name}
              aria-label={s.name}
              style={{ "--sw": cssColor(s.color) } as CSSProperties}
              onClick={() => onChange({ ...s.color, ref: { swatch: s.id } }, "commit")}
            />
          ))
        ) : (
          <span className="st-empty">{t("style.color.swatchesEmpty")}</span>
        )}
      </div>
    </div>
  );
}
