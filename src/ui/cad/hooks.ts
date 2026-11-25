// The drawing screen's door (docs/design/CAD_SCREEN.md): the canvas asks these hooks while the current page is a
// drawing on the drawing screen (editModes isCadScreen). They come from the code of the drawing screen (ui/cad/view.ts),
// loaded the first time a drawing is shown — nothing of it is in the start-up bundle.

import type { Page } from "../../core/types";
import type { MenuItem } from "../shell/controls";
import { cadHooks, cadScreenNow } from "../editModes";

export interface CanvasEnv {
  w: number;
  h: number;
  dpr: number;
}

export interface CadCanvasHooks {
  /** what the canvas paints for the page: model-space colours (dark background), lineweight display */
  displayPage(page: Page, zoom: number): Page;
  /** model space colour around (and under) the page */
  background(): string;
  /** crosshair, object snap marker, previews, selection, UCS icon (screen px, already scaled to the device) */
  overlay(o: CanvasRenderingContext2D, page: Page, env: CanvasEnv): void;
  /** pointer events in canvas px; true = taken (the canvas does nothing else with it) */
  down(e: PointerEvent, sx: number, sy: number): boolean;
  move(e: PointerEvent, sx: number, sy: number): void;
  up(e: PointerEvent, sx: number, sy: number): boolean;
  leave(): void;
  wheel(e: WheelEvent, sx: number, sy: number): boolean;
  /** a selected object under this canvas point (a finger pressed there drags it instead of moving the view) */
  selectedAt?(sx: number, sy: number): boolean;
  /** the shortcut menu at a right click (null: none — a command is running) */
  menu?(): MenuItem[] | null;
  /** the canvas repaint, lent once */
  attach(invalidate: () => void): void;
}

export const cad: {
  hooks: CadCanvasHooks | null;
  invalidate: (() => void) | null;
  key: ((e: KeyboardEvent) => boolean) | null;
  /** the canvas's in-place text editor, lent by CanvasView (MTEXT, TEXTEDIT, double click) */
  editText: ((id: string) => boolean) | null;
} = { hooks: null, invalidate: null, key: null, editText: null };

let loading: Promise<void> | null = null;
/** Load the drawing screen's code (once). */
export function loadCadScreen(): Promise<void> {
  loading ??= import("./view").then((m) => {
    cad.hooks = m.hooks;
    cad.key = (e) => m.cadKey(e);
    if (cad.invalidate) m.hooks.attach(cad.invalidate);
    cad.invalidate?.();
  });
  return loading;
}
cadHooks.enter = () => void loadCadScreen();

/** The hooks when the current page is on the drawing screen and its code is loaded. */
export const cadCanvas = (): CadCanvasHooks | null => (cad.hooks && cadScreenNow() ? cad.hooks : null);

/** CanvasView hands its repaint over (the hooks may load later). */
export function attachCanvas(invalidate: () => void) {
  cad.invalidate = invalidate;
  cad.hooks?.attach(invalidate);
  if (cadScreenNow()) void loadCadScreen();
}
