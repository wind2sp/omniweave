// PowerPoint's 전환 and 애니메이션 galleries for slides: a click on a transition sets it on the slide (and plays it
// once in the preview), a click on an animation effect adds it to the selected objects (ui/slideActions; the 애니메이션
// pane in the right dock orders, times and triggers them).

import { useStore } from "../../core/store";
import { addAnimation } from "../actions";
import { PRESET_CLASS, ANIM_PRESETS, type AnimPreset } from "../../core/anim";
import type { Page, TransitionType } from "../../core/types";
import { useT } from "../../i18n";
import { setPageProps } from "../actions";
import { cx } from "./controls";
import { Icon, type IconName } from "./Icons";

/** Transitions in PowerPoint's gallery order (미묘한 효과 → 화려한 효과). */
export const TRANSITION_ORDER: TransitionType[] = ["NONE", "CUT", "FADE", "SLIDE_LEFT", "PUSH_UP", "WIPE", "SPLIT", "COVER", "UNCOVER", "RANDOM_BARS", "CIRCLE", "DISSOLVE", "ZOOM"];

/** A small picture of a transition: the old slide (grey) and the new one (accent) as it comes in. */
function TransitionIcon({ type }: { type: TransitionType }) {
  const a = "var(--accent, #7c5cff)", g = "#9aa1ad";
  const body = (() => {
    switch (type) {
      case "NONE":
        return <rect x={4} y={6} width={32} height={20} fill="none" stroke={g} strokeWidth={1.5} />;
      case "CUT":
        return <><rect x={4} y={6} width={15} height={20} fill={g} /><rect x={21} y={6} width={15} height={20} fill={a} /></>;
      case "FADE":
        return <rect x={4} y={6} width={32} height={20} fill={a} opacity={0.5} />;
      case "SLIDE_LEFT":
        return <><rect x={4} y={6} width={14} height={20} fill={g} /><rect x={18} y={6} width={18} height={20} fill={a} /><path d="M30 16h-8m3-3-3 3 3 3" stroke="#fff" fill="none" /></>;
      case "PUSH_UP":
        return <><rect x={4} y={6} width={32} height={8} fill={g} /><rect x={4} y={14} width={32} height={12} fill={a} /><path d="M20 23v-7m-3 3 3-3 3 3" stroke="#fff" fill="none" /></>;
      case "WIPE":
        return <><rect x={4} y={6} width={32} height={20} fill={g} /><rect x={4} y={6} width={20} height={20} fill={a} /><path d="M24 6v20" stroke="#fff" /></>;
      case "SPLIT":
        return <><rect x={4} y={6} width={32} height={20} fill={g} /><rect x={13} y={6} width={14} height={20} fill={a} /></>;
      case "COVER":
        return <><rect x={4} y={6} width={32} height={20} fill={g} /><rect x={16} y={8} width={20} height={18} fill={a} /></>;
      case "UNCOVER":
        return <><rect x={4} y={6} width={32} height={20} fill={a} /><rect x={4} y={8} width={14} height={18} fill={g} /></>;
      case "RANDOM_BARS":
        return <><rect x={4} y={6} width={32} height={20} fill={g} />{[7, 12, 15, 21, 24].map((y) => <rect key={y} x={4} y={y} width={32} height={2} fill={a} />)}</>;
      case "CIRCLE":
        return <><rect x={4} y={6} width={32} height={20} fill={g} /><circle cx={20} cy={16} r={8} fill={a} /></>;
      case "DISSOLVE":
        return <><rect x={4} y={6} width={32} height={20} fill={g} />{[[6, 8], [14, 12], [22, 8], [28, 18], [10, 20], [18, 20], [30, 10]].map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width={4} height={4} fill={a} />)}</>;
      case "ZOOM":
        return <><rect x={4} y={6} width={32} height={20} fill={g} /><rect x={12} y={11} width={16} height={10} fill={a} /></>;
    }
  })();
  return (
    <svg width={40} height={32} viewBox="0 0 40 32" aria-hidden="true">
      {body}
    </svg>
  );
}

export function TransitionGallery({ page }: { page: Page }) {
  const t = useT();
  return (
    <div className="sd-gallery sd-anim-gallery" role="listbox" aria-label={t("slideppt.trans.gallery")}>
      {TRANSITION_ORDER.map((ty) => (
        <button key={ty} type="button" role="option" aria-selected={page.transition.type === ty} className={cx("sd-theme", page.transition.type === ty && "on")} data-tip={t(`ribbon.transition.${ty}`)} onClick={() => setPageProps({ transition: { ...page.transition, type: ty, duration: ty === "CUT" ? 0 : page.transition.duration || 700 } })}>
          <TransitionIcon type={ty} />
          <span className="sd-name">{t(`ribbon.transition.${ty}`)}</span>
        </button>
      ))}
    </div>
  );
}

const CLASS_ICON: Record<"entr" | "emph" | "exit", IconName> = { entr: "sparkle", emph: "sun", exit: "eyeOff" };

/** Effects in PowerPoint's gallery order: 나타내기 (green), 강조 (yellow), 끝내기 (red). */
const ANIM_ORDER: AnimPreset[] = ["appear", "fade-in", "fly-left", "fly-right", "fly-up", "fly-down", "float-in", "zoom-in", "spin-in", "pulse", "spin", "grow", "fade-out", "fly-out", "zoom-out"];

export function AnimationGallery() {
  const t = useT();
  const sel = useStore((s) => s.selection.length);
  return (
    <div className="sd-gallery sd-anim-gallery" role="listbox" aria-label={t("slideppt.anim.gallery")}>
      {ANIM_ORDER.map((k) => (
        <button key={k} type="button" role="option" aria-selected={false} disabled={!sel} className={cx("sd-theme", `sd-anim-${PRESET_CLASS[k]}`)} data-tip={sel ? t(`dock.anim.preset.${k}`, undefined, ANIM_PRESETS[k].label) : t("dock.anim.selectFirst")} onClick={() => addAnimation(k, "ON_CLICK")}>
          <Icon name={CLASS_ICON[PRESET_CLASS[k]]} size={18} />
          <span className="sd-name">{t(`dock.anim.preset.${k}`, undefined, ANIM_PRESETS[k].label)}</span>
        </button>
      ))}
    </div>
  );
}
