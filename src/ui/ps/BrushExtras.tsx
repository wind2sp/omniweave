// The image mode's brush options beside size / hardness / opacity (Photoshop's options bar): 흐름 (flow) and brush
// presets (soft / hard round in common sizes, Photoshop's default set). Shown for the brush, the eraser and the
// retouching tools that paint (spot healing, healing, clone stamp, quick selection).

import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { NumField, Select } from "../shell/controls";
import { plainLive } from "../shell/ops";

const S = () => useStore.getState();

/** Tools that take the brush options bar (besides the brush and the eraser). */
export const PS_BRUSH_TOOLS = new Set<string>(["spotHeal", "heal", "clone", "quickSelect", "dodge", "burn", "sponge"]);

const PRESETS: { id: string; size: number; hardness: number }[] = [
  { id: "soft30", size: 30, hardness: 0 },
  { id: "soft100", size: 100, hardness: 0 },
  { id: "soft300", size: 300, hardness: 0 },
  { id: "hard10", size: 10, hardness: 1 },
  { id: "hard30", size: 30, hardness: 1 },
  { id: "hard100", size: 100, hardness: 1 },
  { id: "mid50", size: 50, hardness: 0.5 },
];

export function BrushExtras() {
  const t = useT();
  const brush = useStore((s) => s.brush);
  const cur = PRESETS.find((p) => p.size === brush.size && Math.abs(p.hardness - brush.hardness) < 0.005)?.id ?? "";
  return (
    <>
      <NumField icon="opacity" tip={t("psfeat.brush.flow")} label={t("psfeat.brush.flowShort")} value={brush.flow ?? 1} scale={100} min={1} max={100} unit="%" width={84} live={plainLive((v) => S().set({ brush: { ...S().brush, flow: v } }))} />
      <Select<string>
        tip={t("psfeat.brush.preset")}
        icon="brush"
        value={cur}
        width={150}
        onChange={(id) => {
          const p = PRESETS.find((x) => x.id === id);
          if (p) S().set({ brush: { ...S().brush, size: p.size, hardness: p.hardness } });
        }}
        options={PRESETS.map((p) => ({ value: p.id, label: t(`psfeat.brush.p.${p.id.replace(/\d+/, "")}`, { n: p.size }) }))}
      />
    </>
  );
}
