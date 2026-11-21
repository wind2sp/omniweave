// "오메 견본": the first swatches next to the fill / stroke fields — the logo's three threads and ink, then white and
// black. A click colours the front swatch (fill, or stroke after X in the design mode) of the selected paths, or the
// new-shape default when nothing is selected. Shapes never start in these colours (the programs' own defaults do).

import { selectedNodes, useStore } from "../../core/store";
import { useT } from "../../i18n";
import { updateSelected } from "../actions";
import { useDesign } from "../designTools";
import { OME_SWATCHES, useShapeStroke } from "../drawDefaults";
import { useEditMode } from "../editModes";

export function OmeSwatches() {
  const t = useT();
  const design = useEditMode() === "DESIGN";
  const focus = useDesign((s) => s.focus);
  const target = design ? focus : "fill";
  const apply = (hex: string) => {
    const vs = selectedNodes().filter((n) => n.type === "VECTOR");
    if (vs.length) {
      updateSelected(t(target === "fill" ? "ribbon.fill" : "ribbon.strokeColor"), (x) => {
        if (x.type !== "VECTOR") return;
        x[target] = hex;
        if (target === "stroke" && x.strokeWidth <= 0) x.strokeWidth = useShapeStroke.getState().width;
      });
      return;
    }
    useStore.getState().set(target === "fill" ? { fill: hex } : { stroke: hex });
    if (target === "stroke") useShapeStroke.getState().setNone(false);
  };
  return (
    <span className="ome-swatches" role="group" aria-label={t("swatch.group")}>
      {OME_SWATCHES.map((s, i) => (
        <button
          key={s.key}
          type="button"
          className={"ome-swatch" + (i === 4 ? " gap" : "")}
          style={{ background: s.hex }}
          data-tip={`${t(`swatch.${s.key}`)} · ${t(target === "fill" ? "ribbon.fill" : "ribbon.stroke")}`}
          aria-label={t(`swatch.${s.key}`)}
          onClick={() => apply(s.hex)}
        />
      ))}
    </span>
  );
}
