// Drawing screen settings (AutoCAD's status bar toggles), kept per viewer: model space colour, grid (F7), snap (F9),
// ortho (F8), polar tracking (F10) and its increment, object snap (F3) and its modes, lineweight display, dynamic
// input (F12), crosshair size, the command line history panel (F2).

import { create } from "zustand";
import type { SnapKind } from "./geom";

export interface CadUI {
  dark: boolean;
  grid: boolean;
  snap: boolean;
  ortho: boolean;
  polar: boolean;
  polarInc: number;
  osnap: boolean;
  modes: Record<SnapKind, boolean>;
  lwt: boolean;
  dyn: boolean;
  /** crosshair length, percent of the canvas (AutoCAD CURSORSIZE) */
  cursorSize: number;
  histOpen: boolean;
  cmdLine: boolean;
}

const KEY = "omniweave.cadScreen.ui";
const DEFAULTS: CadUI = {
  dark: true,
  grid: false,
  snap: false,
  ortho: false,
  polar: true,
  polarInc: 90,
  osnap: true,
  // AutoCAD starts with endpoint, centre, intersection (and extension); midpoint and perpendicular are the next most used
  modes: { end: true, mid: true, cen: true, int: true, per: true, tan: false, nea: false },
  lwt: false,
  dyn: true,
  cursorSize: 5,
  histOpen: false,
  cmdLine: true,
};

function load(): CadUI {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { ...DEFAULTS, ...v, modes: { ...DEFAULTS.modes, ...(v?.modes ?? {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

export const useCadUI = create<CadUI & { set: (p: Partial<CadUI>) => void }>((set, get) => ({
  ...load(),
  set: (p) => {
    set(p);
    const { set: _s, ...rest } = get();
    void _s;
    try {
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {}
  },
}));

export type Toggle = "grid" | "snap" | "ortho" | "polar" | "osnap" | "lwt" | "dyn";
/** F-key toggles; ortho and polar tracking exclude each other, as in AutoCAD. */
export function toggle(k: Toggle) {
  const u = useCadUI.getState();
  const on = !u[k];
  const p: Partial<CadUI> = { [k]: on };
  if (on && k === "ortho") p.polar = false;
  if (on && k === "polar") p.ortho = false;
  u.set(p);
}
export const F_KEYS: Record<string, Toggle> = { F3: "osnap", F7: "grid", F8: "ortho", F9: "snap", F10: "polar", F12: "dyn" };
