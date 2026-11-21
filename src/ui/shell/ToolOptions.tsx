// Options bar of the image (Photoshop) and design (Illustrator) tools: what the tool does now and its settings,
// in the ribbon's context strip. Omniweave's own features sit where those programs' users look for them — a pixel
// selection offers "Layer via Copy" next to AI background removal and text recognition (OCR).

import { useStore, type Tool } from "../../core/store";
import { useT } from "../../i18n";
import { ColorField, IconBtn, NumField, Seg, Sep } from "./controls";
import { Icon } from "./Icons";
import { nodeLive, plainLive } from "./ops";
import { updateSelected } from "../actions";
import type { VectorNode } from "../../core/types";
import { useImageUI } from "./imageMenu";
import {
  clearSelectionPixels, cropToSelection, defaultColors, deselect, fillSelection, invertSelection, layerViaCopy, swapColors, usePixelSel, type GradientKind, type MarqueeShape,
} from "../pixelSelect";

const S = () => useStore.getState();

const IMAGE_TOOLS = new Set<Tool>(["marquee", "lasso", "wand", "eyedropper", "gradient", "zoom"]);
const DESIGN_TOOLS = new Set<Tool>(["line", "anchorAdd", "anchorDel", "anchorConvert", "curvature"]);

export const hasToolOptions = (tool: Tool) => IMAGE_TOOLS.has(tool) || DESIGN_TOOLS.has(tool);

type Cap = NonNullable<VectorNode["strokeCap"]>;
type Join = NonNullable<VectorNode["strokeJoin"]>;

/** Stroke panel (Illustrator 획): caps, corners and dashes of the selected paths. */
export function StrokeOptions({ node }: { node: VectorNode }) {
  const t = useT();
  const cap = node.strokeCap ?? "round", join = node.strokeJoin ?? "round";
  const dash = node.strokeDash?.[0] ?? 0;
  const glyph = (d: string) => (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
  return (
    <span className="btn-row stroke-opts" role="group" aria-label={t("design.stroke")}>
      <Seg<Cap>
        value={cap}
        ariaLabel={t("design.stroke.cap")}
        onChange={(v) => updateSelected(t("design.stroke.cap"), (x) => x.type === "VECTOR" && (x.strokeCap = v))}
        options={[
          { value: "butt", label: glyph("M3 6h11v8H3M14 4v12"), tip: t("design.stroke.cap.butt") },
          { value: "round", label: glyph("M3 6h9a4 4 0 0 1 0 8H3"), tip: t("design.stroke.cap.round") },
          { value: "square", label: glyph("M3 6h13v8H3M12 4v12"), tip: t("design.stroke.cap.square") },
        ]}
      />
      <Seg<Join>
        value={join}
        ariaLabel={t("design.stroke.join")}
        onChange={(v) => updateSelected(t("design.stroke.join"), (x) => x.type === "VECTOR" && (x.strokeJoin = v))}
        options={[
          { value: "miter", label: glyph("M4 16V4h12"), tip: t("design.stroke.join.miter") },
          { value: "round", label: glyph("M4 16V9a5 5 0 0 1 5-5h7"), tip: t("design.stroke.join.round") },
          { value: "bevel", label: glyph("M4 16V8l4-4h8"), tip: t("design.stroke.join.bevel") },
        ]}
      />
      <NumField
        label={t("design.stroke.dash")}
        tip={t("design.stroke.dashTip")}
        value={dash}
        min={0}
        max={500}
        unit="px"
        width={60}
        live={nodeLive(t("design.stroke.dash"), (x, v: number) => {
          if (x.type !== "VECTOR") return;
          if (v > 0) x.strokeDash = [v, v];
          else delete x.strokeDash;
        })}
      />
    </span>
  );
}

/** Foreground / background colour pair (D default, X swap) — Photoshop's swatches at the bottom of the toolbar. */
export function FgBg() {
  const t = useT();
  const fg = useStore((s) => s.brush.color);
  const bg = usePixelSel((s) => s.bg);
  return (
    <span className="fgbg" role="group" aria-label={t("imgmode.colors")}>
      <ColorField tip={t("imgmode.fg")} value={fg} live={plainLive((v) => S().set({ brush: { ...S().brush, color: v } }))} />
      <ColorField tip={t("imgmode.bg")} value={bg} live={plainLive((v) => usePixelSel.setState({ bg: v }))} />
      <IconBtn icon="swapArrows" size="sm" tip={t("imgmode.swap")} kbd="X" onClick={swapColors} />
      <button type="button" className="btn btn-ghost fgbg-default" data-tip={t("imgmode.defaultColors")} data-kbd="D" onClick={defaultColors}>
        <span className="fgbg-mini" aria-hidden="true" />
      </button>
    </span>
  );
}

/** What a pixel selection can do — Photoshop's contextual task bar, with Omniweave's own image features. */
function SelectionActions() {
  const t = useT();
  const has = usePixelSel((s) => !!s.mask && s.pageId === useStore.getState().pageId);
  const pageSel = useStore((s) => s.selection.length > 0);
  if (!has) return <span className="ctx-hint">{t("imgmode.sel.hint")}</span>;
  const img = useImageUI.getState();
  return (
    <span className="btn-row sel-actions" role="group" aria-label={t("imgmode.sel.actions")}>
      <button type="button" className="btn btn-ghost" data-kbd="Ctrl+J" data-tip={t("imgmode.sel.copyTip")} onClick={() => layerViaCopy(false)}>
        <Icon name="copy" size={14} />
        <span>{t("imgmode.sel.copy")}</span>
      </button>
      <button type="button" className="btn btn-ghost" data-kbd="Delete" onClick={clearSelectionPixels}>
        <Icon name="eraser" size={14} />
        <span>{t("imgmode.sel.clear")}</span>
      </button>
      <button type="button" className="btn btn-ghost" data-kbd="Alt+Backspace" data-tip={t("imgmode.sel.fillTip")} onClick={() => fillSelection("fg")}>
        <span>{t("imgmode.sel.fill")}</span>
      </button>
      <button type="button" className="btn btn-ghost" data-tip={t("imgmode.sel.cropTip")} onClick={cropToSelection}>
        <Icon name="crop" size={14} />
        <span>{t("imgmode.sel.crop")}</span>
      </button>
      <Sep />
      <button type="button" className="btn btn-ghost" data-kbd="Ctrl+Shift+I" onClick={invertSelection}>
        {t("imgmode.sel.invert")}
      </button>
      <button type="button" className="btn btn-ghost" data-kbd="Ctrl+D" onClick={deselect}>
        {t("imgmode.sel.deselect")}
      </button>
      <Sep />
      {/* Omniweave: AI background removal and text recognition, where a selection's next step is looked for */}
      <button type="button" className="btn btn-ghost" disabled={!pageSel} data-tip={t("imgmode.sel.matteTip")} onClick={() => img.set({ kind: "matte" })}>
        <Icon name="sparkle" size={14} />
        <span>{t("imgmode.sel.matte")}</span>
      </button>
      <button type="button" className="btn btn-ghost" disabled={!pageSel} data-tip={t("imgmode.sel.ocrTip")} onClick={() => img.set({ kind: "ocr" })}>
        <span>{t("imgmode.sel.ocr")}</span>
      </button>
    </span>
  );
}

export function ToolOptions({ tool }: { tool: Tool }) {
  const t = useT();
  const ps = usePixelSel();
  const brush = useStore((s) => s.brush);
  const chip = (label: string, icon: Parameters<typeof Icon>[0]["name"]) => (
    <span className="ctx-chip">
      <Icon name={icon} size={14} />
      {label}
    </span>
  );
  switch (tool) {
    case "marquee":
      return (
        <>
          {chip(t(ps.marquee === "ellipse" ? "imgmode.tool.marqueeEllipse" : "imgmode.tool.marqueeRect"), ps.marquee === "ellipse" ? "marqueeEllipse" : "marquee")}
          <Seg<MarqueeShape>
            value={ps.marquee}
            ariaLabel={t("imgmode.marquee.shape")}
            onChange={(v) => ps.set({ marquee: v })}
            options={[
              { value: "rect", icon: "marquee", tip: t("imgmode.tool.marqueeRect"), kbd: "Shift+M" },
              { value: "ellipse", icon: "marqueeEllipse", tip: t("imgmode.tool.marqueeEllipse"), kbd: "Shift+M" },
            ]}
          />
          <Sep />
          <SelectionActions />
        </>
      );
    case "lasso":
      return (
        <>
          {chip(t("ribbon.tool.lasso"), "lasso")}
          <Sep />
          <SelectionActions />
        </>
      );
    case "wand":
      return (
        <>
          {chip(t("ribbon.tool.wand"), "wand")}
          <NumField label={t("imgmode.wand.tolerance")} tip={t("imgmode.wand.toleranceTip")} value={ps.wandTolerance} min={0} max={255} width={64} live={plainLive((v) => ps.set({ wandTolerance: v }))} />
          <label className="check-inline">
            <input type="checkbox" checked={ps.wandContiguous} onChange={(e) => ps.set({ wandContiguous: e.target.checked })} />
            {t("imgmode.wand.contiguous")}
          </label>
          <label className="check-inline">
            <input type="checkbox" checked={ps.sampleAll} onChange={(e) => ps.set({ sampleAll: e.target.checked })} />
            {t("imgmode.wand.sampleAll")}
          </label>
          <Sep />
          <SelectionActions />
        </>
      );
    case "eyedropper":
      return (
        <>
          {chip(t("ribbon.tool.eyedropper"), "eyedropper")}
          <FgBg />
          <span className="ctx-hint">{t("imgmode.eyedropper.hint")}</span>
        </>
      );
    case "gradient":
      return (
        <>
          {chip(t("ribbon.tool.gradient"), "gradient")}
          <FgBg />
          <Seg<GradientKind>
            value={ps.gradient}
            ariaLabel={t("imgmode.gradient.kind")}
            onChange={(v) => ps.set({ gradient: v })}
            options={[
              { value: "linear", label: t("imgmode.gradient.linear") },
              { value: "radial", label: t("imgmode.gradient.radial") },
            ]}
          />
          <NumField icon="opacity" tip={t("ribbon.opacity")} value={brush.opacity} scale={100} min={1} max={100} unit="%" width={72} live={plainLive((v) => S().set({ brush: { ...S().brush, opacity: v } }))} />
          <span className="ctx-hint">{t("imgmode.gradient.hint")}</span>
        </>
      );
    case "zoom":
      return (
        <>
          {chip(t("ribbon.tool.zoom"), "zoom")}
          <span className="ctx-hint">{t("imgmode.zoom.hint")}</span>
        </>
      );
    case "line":
      return (
        <>
          {chip(t("ribbon.tool.line"), "line")}
          <ColorField label={t("ribbon.stroke")} tip={t("ribbon.shape.newStroke")} value={useStore.getState().stroke} live={plainLive((v) => S().set({ stroke: v }))} />
          <span className="ctx-hint">{t("design.line.hint")}</span>
        </>
      );
    case "anchorAdd":
    case "anchorDel":
    case "anchorConvert":
    case "curvature":
      return (
        <>
          {chip(t(`ribbon.tool.${tool}`), tool)}
          <span className="ctx-hint">{t(`pen.hint.${tool}`)}</span>
        </>
      );
  }
  return null;
}
