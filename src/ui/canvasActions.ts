// Canvas commands of the image / design modes: 캔버스 크기 (dialog), canvas flip and 180° turn — one undo step each.
// The model work is in core/canvasSize.ts; the view fits the new canvas by itself (ui/viewFollow.ts).

import { flipCanvasInPlace, resizeCanvasInPlace, type Anchor, type CanvasFill } from "../core/canvasSize";
import { rotatePageInPlace } from "../core/pages";
import { UNIT_PX } from "../core/pageSetup";
import { currentPage, draftPage, useStore } from "../core/store";
import { t } from "../i18n";

const S = () => useStore.getState();

/** Canvas size range (px): what a canvas / PSD can hold. */
export const CANVAS_MIN = 1;
export const CANVAS_MAX = 30000;

export function resizeCanvas(w: number, h: number, anchor: Anchor, fill: CanvasFill): boolean {
  const s = S();
  const page = currentPage();
  if (!page) return false;
  const W = Math.round(w), H = Math.round(h);
  if (!(W >= CANVAS_MIN && H >= CANVAS_MIN && W <= CANVAS_MAX && H <= CANVAS_MAX)) {
    s.notify(t("canvas.size.range", { max: CANVAS_MAX }));
    return false;
  }
  if (W === page.width && H === page.height && fill !== "transparent") return true;
  s.commit(t("canvas.size.hist", { w: W, h: H }), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) resizeCanvasInPlace(pg as any, W, H, anchor, fill, t("canvas.size.fillLayer"));
  });
  s.notify(t("canvas.size.done", { w: W, h: H }));
  return true;
}

/** Flip the whole canvas (no layer needs to be selected; 레이어 뒤집기 is object.flipH / flipV). */
export function flipCanvas(axis: "h" | "v") {
  const s = S();
  const page = currentPage();
  if (!page) return;
  s.commit(t(axis === "h" ? "canvas.flipH" : "canvas.flipV"), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) flipCanvasInPlace(pg as any, axis);
  });
}

/** Turn the whole canvas 180°. */
export function rotateCanvas180() {
  const s = S();
  const page = currentPage();
  if (!page) return;
  s.commit(t("canvas.rotate180"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    rotatePageInPlace(pg as any, 1);
    rotatePageInPlace(pg as any, 1);
  });
}

// ───────── the dialog's fields ─────────

export type CanvasUnit = "px" | "%" | "mm" | "cm" | "in";

const per = (unit: CanvasUnit, cur: number) => (unit === "%" ? cur / 100 : unit === "px" ? 1 : UNIT_PX[unit]);
const round = (v: number, unit: CanvasUnit) => (unit === "px" ? Math.round(v) : Math.round(v * 100) / 100);

/** The field value for a size in px (absolute, or the change from the current size when relative). */
export function canvasField(px: number, cur: number, unit: CanvasUnit, relative: boolean): number {
  return round((relative ? px - cur : px) / per(unit, cur), unit);
}

/** The new size in whole px from a field value (absolute or relative), or NaN when it is not a size. */
export function canvasTarget(value: number, cur: number, unit: CanvasUnit, relative: boolean): number {
  if (!Number.isFinite(value)) return NaN;
  const px = Math.round((relative ? cur : 0) + value * per(unit, cur));
  return px >= 1 && px <= CANVAS_MAX ? px : NaN;
}
