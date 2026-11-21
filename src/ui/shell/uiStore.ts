// Shell-only UI state (dock sizes, tabs, theme). Persisted per viewer in localStorage.

import { create } from "zustand";
import type { AlignRef } from "../../core/align";
import type { PageKind } from "../../core/types";
import type { GridSpec, Unit } from "../../core/units";

export type Theme = "dark" | "light";
/** UI text & control size (Preferences): 작게 90% · 보통 100% · 크게 112% · 아주 크게 125%. Canvas zoom is separate. */
export type UIScale = "small" | "normal" | "large" | "xlarge";
export const UI_SCALES: { id: UIScale; factor: number }[] = [
  { id: "small", factor: 0.9 },
  { id: "normal", factor: 1 },
  { id: "large", factor: 1.12 },
  { id: "xlarge", factor: 1.25 },
];
export const uiScaleFactor = (s: UIScale) => UI_SCALES.find((x) => x.id === s)?.factor ?? 1;
export type LeftTab = "pages" | "layers";
export type RightTab = "props" | "anim" | "history" | "review";
export type ShellDialog = "palette" | "settings" | "shortcuts" | "about" | "find" | "replace" | "wordCount" | "symbol" | "sizePdf" | "pageSetup" | "paragraph" | "listFormat" | "pageNumber";

interface UIState {
  theme: Theme;
  /** size of UI text and controls (root --ui-scale) */
  uiScale: UIScale;
  leftOpen: boolean;
  rightOpen: boolean;
  leftW: number;
  rightW: number;
  leftTab: LeftTab;
  rightTab: RightTab;
  /** New-document chooser / welcome panel. */
  welcome: boolean;
  /** Timestamp of the last successful Shuttle journal autosave. */
  journalAt: number | null;
  /** Open quick tool (Tools menu dialog), or null. */
  quickTool: string | null;
  /** View aids: rulers (Ctrl+R), guides shown (Ctrl+;), guides locked (Ctrl+Alt+;), grid (Ctrl+'), snapping (Ctrl+Shift+;) */
  rulers: boolean;
  guides: boolean;
  guidesLocked: boolean;
  grid: boolean;
  snap: boolean;
  /** what snapping uses */
  snapTo: SnapTo;
  /** ruler / position unit; "auto" = mm on document and PDF pages, px elsewhere */
  rulerUnit: Unit | "auto";
  /** grid spacing chosen per page kind (missing = core/units defaultGrid) */
  grids: Partial<Record<PageKind, GridSpec>>;
  /** what align buttons line objects up with */
  alignRef: AlignRef;
  /** full-screen page organiser */
  organizer: boolean;
  /** organiser panel to open with it (Page → Split), taken once by the organiser */
  organizerPanel: "split" | null;
  /** developer read-outs (the Loom render meter in the status bar) — off for everyone else (Settings) */
  devInfo: boolean;
  /** reviewer name for new comments and tracked changes (Settings; empty = the language's word for 'author', never the PC account) */
  reviewAuthor: string;
  /** command search (Alt+Q), preferences, keyboard shortcuts or About, or null */
  shellDialog: ShellDialog | null;
  set: (p: Partial<UIState>) => void;
}

export interface SnapTo {
  grid: boolean;
  guides: boolean;
  page: boolean;
  objects: boolean;
  /** equal spacing between objects */
  spacing: boolean;
}

export const DEFAULT_SNAP_TO: SnapTo = { grid: true, guides: true, page: true, objects: true, spacing: true };

const KEY = "omniweave.ui.v1";
const PERSIST: (keyof UIState)[] = ["theme", "uiScale", "leftOpen", "rightOpen", "leftW", "rightW", "leftTab", "rightTab", "rulers", "guides", "guidesLocked", "grid", "snap", "snapTo", "rulerUnit", "grids", "alignRef", "devInfo", "reviewAuthor"];
const UNIT_VALUES = ["auto", "px", "mm", "cm", "pt", "in"];
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

function loadGrids(v: unknown): Partial<Record<PageKind, GridSpec>> {
  const out: Partial<Record<PageKind, GridSpec>> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, g] of Object.entries(v as Record<string, any>))
    if (g && typeof g.size === "number" && g.size > 0 && isFinite(g.size) && typeof g.sub === "number" && g.sub >= 1 && g.sub <= 100) out[k as PageKind] = { size: g.size, sub: Math.round(g.sub) };
  return out;
}

function load(): Partial<UIState> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Partial<UIState>) : {};
  } catch {
    return {};
  }
}

export const DOCK_MIN = 200;
export const DOCK_MAX = 440;
const clampW = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? Math.min(DOCK_MAX, Math.max(DOCK_MIN, v)) : d);

const saved = load();

export const useUI = create<UIState>((set) => ({
  theme: saved.theme === "light" ? "light" : "dark",
  uiScale: UI_SCALES.some((x) => x.id === saved.uiScale) ? (saved.uiScale as UIScale) : "normal",
  leftOpen: saved.leftOpen ?? true,
  rightOpen: saved.rightOpen ?? true,
  leftW: clampW(saved.leftW, 240),
  rightW: clampW(saved.rightW, 280),
  leftTab: saved.leftTab === "layers" ? "layers" : "pages",
  rightTab: saved.rightTab === "anim" || saved.rightTab === "history" || saved.rightTab === "review" ? saved.rightTab : "props",
  welcome: false,
  journalAt: null,
  quickTool: null,
  rulers: bool(saved.rulers, true),
  guides: bool(saved.guides, true),
  guidesLocked: bool(saved.guidesLocked, false),
  grid: bool(saved.grid, false),
  snap: bool(saved.snap, true),
  snapTo: { ...DEFAULT_SNAP_TO, ...(saved.snapTo && typeof saved.snapTo === "object" ? Object.fromEntries(Object.entries(saved.snapTo).filter(([, v]) => typeof v === "boolean")) : {}) },
  rulerUnit: UNIT_VALUES.includes(saved.rulerUnit as string) ? (saved.rulerUnit as Unit | "auto") : "auto",
  grids: loadGrids(saved.grids),
  alignRef: saved.alignRef === "page" || saved.alignRef === "key" ? saved.alignRef : "selection",
  organizer: false,
  organizerPanel: null,
  devInfo: bool(saved.devInfo, false),
  reviewAuthor: typeof saved.reviewAuthor === "string" ? saved.reviewAuthor.slice(0, 80) : "",
  shellDialog: null,
  set: (p) => set(p),
}));

let persistTimer: ReturnType<typeof setTimeout> | undefined;
useUI.subscribe((s) => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const out: Record<string, unknown> = {};
      for (const k of PERSIST) out[k] = s[k];
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
      /* storage unavailable — per-viewer convenience only */
    }
  }, 300);
});
