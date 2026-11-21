// Anchor point options in the context strip while a pen-family tool or direct selection is active (Illustrator's
// control bar "Anchors": convert to corner / smooth, remove, connect end points, cut path; PowerPoint's 점 편집 menu
// names in slides: 꼭짓점 · 부드러운 점 · 점 삭제 · 경로 닫기 · 경로 열기).

import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { useEditMode } from "../editModes";
import { cutSelected, joinSelected, removeSelectedAnchors, setSelectedKind, useAnchors } from "../pathTools";
import { Sep } from "./controls";

const glyph = (d: string, dot?: [number, number]) => (
  <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
    {dot && <rect x={dot[0] - 1.8} y={dot[1] - 1.8} width="3.6" height="3.6" fill="currentColor" stroke="none" />}
  </svg>
);

export function AnchorBar() {
  const t = useT();
  const mode = useEditMode();
  const count = useAnchors((s) => s.sel.length);
  useStore((s) => s.doc);
  // PowerPoint's own words in slides, Illustrator's elsewhere
  const L = (k: string) => t(`pen.bar.${mode}.${k}`, undefined, t(`pen.bar.${k}`));
  const btn = (k: string, icon: React.ReactNode, run: () => boolean, need = 1) => (
    <button type="button" className="ibtn ibtn-md" data-tip={L(k)} aria-label={L(k)} disabled={count < need} onClick={() => run()}>
      {icon}
    </button>
  );
  return (
    <span className="btn-row anchor-bar" role="group" aria-label={L("title")}>
      <span className="ctx-hint">{L("title")}</span>
      {btn("corner", glyph("M3 15 10 5l7 10", [10, 5]), () => setSelectedKind("corner"))}
      {btn("smooth", glyph("M3 14c3-9 11-9 14 0M4.5 6.5h11", [10, 6.5]), () => setSelectedKind("smooth"))}
      {btn("remove", glyph("M3 13c3-6 11-6 14 0M7.5 4.5l5 5M12.5 4.5l-5 5"), removeSelectedAnchors)}
      {btn("join", glyph("M3 14h5M12 14h5M8 14c0-5 4-5 4 0", [10, 9.5]), joinSelected, 0)}
      {btn("cut", glyph("M3 13h5.5M11.5 13H17M8 5l4 12"), cutSelected)}
      <Sep />
    </span>
  );
}
