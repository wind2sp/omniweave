// Small controls shared by the image dialogs (ImageDialog, TraceDialog). Inline styles on theme tokens so the
// shared stylesheet is left to the UI department.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { Img } from "../../core/image/pixels";

export const imgStyles = {
  body: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 16, padding: "18px 20px 0" } as CSSProperties,
  stage: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 320,
    borderRadius: 10,
    border: "1px solid var(--line-2)",
    backgroundColor: "var(--bg-2, #1d1f26)",
    backgroundImage: "linear-gradient(45deg, rgba(128,128,128,.18) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.18) 75%), linear-gradient(45deg, rgba(128,128,128,.18) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.18) 75%)",
    backgroundSize: "16px 16px",
    backgroundPosition: "0 0, 8px 8px",
    overflow: "hidden",
  } as CSSProperties,
  side: { display: "flex", flexDirection: "column", gap: 10, maxHeight: "62vh", overflowY: "auto", paddingRight: 4 } as CSSProperties,
  row: { display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-ui)" } as CSSProperties,
  rowHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", color: "var(--text-2)" } as CSSProperties,
  value: { fontVariantNumeric: "tabular-nums", color: "var(--text)" } as CSSProperties,
  foot: { display: "flex", alignItems: "center", gap: 8, padding: "14px 20px 18px" } as CSSProperties,
  note: { fontSize: "var(--fs-caption)", color: "var(--text-3)" } as CSSProperties,
  check: { display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-ui)", color: "var(--text-2)" } as CSSProperties,
};

/** Draws an RGBA image into a canvas scaled to fit (pixelated when enlarged). */
export function ImgCanvas({ img, title, children }: { img: Img | null; title?: string; children?: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  }, [img]);
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 0 }}>
      <canvas ref={ref} style={{ maxWidth: "100%", maxHeight: 420, imageRendering: "auto", display: img ? "block" : "none" }} />
      {children}
      {title && <span style={imgStyles.note}>{title}</span>}
    </div>
  );
}

export function RangeRow({ label, value, min, max, step, unit, def, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; /** double-click resets to this (default 0 clamped) */ def?: number; onChange: (v: number) => void }) {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return (
    <label style={imgStyles.row}>
      <span style={imgStyles.rowHead}>
        <span>{label}</span>
        <input
          type="number"
          value={+value.toFixed(digits)}
          min={min}
          max={max}
          step={step}
          style={{ width: 64, textAlign: "right", background: "transparent", border: "1px solid var(--line-2)", borderRadius: 6, color: "var(--text)", padding: "1px 4px", ...imgStyles.value }}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
        />
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input type="range" min={min} max={max} step={step} value={value} style={{ flex: 1 }} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(Math.min(max, Math.max(min, def ?? 0)))} />
        {unit && <span style={imgStyles.note}>{unit}</span>}
      </span>
    </label>
  );
}

export function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={imgStyles.check}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

