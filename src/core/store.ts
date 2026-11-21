// State orchestrator. Documents are immutable; history is a list of document roots, so
// undo/redo is an O(1) pointer swap and never copies pixel data.

import { produce, type Draft } from "immer";
import { create } from "zustand";
import { t } from "../i18n";
import { newDocument, type OmwDocument, type Page, type SceneNode } from "./types";
import { normalizeGroups } from "./layerTree";
import { settleSlides } from "./slides";

export type Tool =
  | "select" | "direct" | "hand" | "brush" | "eraser" | "pen" | "rect" | "ellipse" | "text"
  // image mode (Photoshop): marquee M, lasso L, magic wand W, eyedropper I, gradient G, zoom Z (ui/pixelSelect.ts)
  | "marquee" | "lasso" | "wand" | "eyedropper" | "gradient" | "zoom"
  // design mode (Illustrator): line segment \, add / delete anchor point + -, convert anchor point Shift+C,
  // curvature Shift+` (ui/designTools.ts, ui/pathTools.ts) — the last four sit under the pen in the tool strip
  | "line" | "anchorAdd" | "anchorDel" | "anchorConvert" | "curvature";
/** Top bar work mode: AUTO follows each page (ui/editModes.ts), the others pick that edit mode for every page. */
export type Mode = "AUTO" | "DOCUMENT" | "SLIDE" | "IMAGE" | "DESIGN";

export interface BrushSettings {
  size: number;
  hardness: number; // 0..1
  opacity: number; // 0..1
  color: string;
}

export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

const HISTORY_LIMIT = 300;

interface State {
  doc: OmwDocument;
  past: { doc: OmwDocument; label: string }[];
  future: { doc: OmwDocument; label: string }[];
  dirty: boolean;
  filePath: string | null;
  pageId: string;
  selection: string[];
  tool: Tool;
  /** the tool stays after one object (double-clicked); otherwise text and shape tools return to select */
  toolLocked: boolean;
  mode: Mode;
  view: View;
  brush: BrushSettings;
  fill: string;
  stroke: string;
  editingTextId: string | null;
  presenting: boolean;
  toast: string | null;
  gestureBase: OmwDocument | null;

  commit: (label: string, recipe: (d: Draft<OmwDocument>) => void) => void;
  beginGesture: () => void;
  updateGesture: (recipe: (d: Draft<OmwDocument>) => void) => void;
  endGesture: (label: string) => void;
  cancelGesture: () => void;
  undo: () => void;
  redo: () => void;
  /** Replace the whole document as one undoable step (history restore). */
  replaceDoc: (label: string, doc: OmwDocument) => void;
  load: (doc: OmwDocument, filePath?: string | null) => void;
  set: (p: Partial<State>) => void;
  notify: (msg: string) => void;
}

/** The whole store state (core/sessions.ts snapshots the per-document part of it for document tabs). */
export type StoreState = State;

/** A fresh, empty view for a document that has not been fitted yet. */
export const DEFAULT_VIEW: View = { zoom: 0.5, panX: 40, panY: 40 };

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Hooks used by the history timeline (core/history.ts) without an import cycle. */
export const storeHooks: {
  beforeCommit: (() => void) | null;
  committed: ((doc: OmwDocument, label: string) => void) | null;
  loaded: ((doc: OmwDocument) => void) | null;
  /**
   * A session that keeps a gesture open between pointer events (the crop box) must close it before any
   * other change: "edit" (commit / replaceDoc / a new gesture) or "history" (undo / redo). Without this the
   * other change would be built on — or thrown away with — the session's gesture base.
   */
  interrupt: ((why: "edit" | "history") => void) | null;
} = { beforeCommit: null, committed: null, loaded: null, interrupt: null };

export const useStore = create<State>((set, get) => {
  const initial = newDocument();
  return {
    doc: initial,
    past: [],
    future: [],
    dirty: false,
    filePath: null,
    pageId: initial.pages[0].id,
    selection: [],
    tool: "select",
    toolLocked: false,
    mode: "AUTO",
    view: { ...DEFAULT_VIEW },
    brush: { size: 24, hardness: 0.8, opacity: 1, color: "#1d1f24" },
    fill: "#4f7cff",
    stroke: "#1d1f24",
    editingTextId: null,
    presenting: false,
    toast: null,
    gestureBase: null,

    commit(label, recipe) {
      storeHooks.interrupt?.("edit");
      storeHooks.beforeCommit?.();
      const { doc, past } = get();
      // slide placeholders that changed get their autofit and anchor (core/slides.ts)
      const next = settleSlides(produce(doc, (d) => {
        recipe(d);
        normalizeDocGroups(d as OmwDocument);
        d.modified = new Date().toISOString();
      }), doc);
      if (next === doc) return;
      set({ doc: next, past: [...past.slice(-HISTORY_LIMIT + 1), { doc, label }], future: [], dirty: true });
      storeHooks.committed?.(next, label);
    },
    replaceDoc(label, next) {
      storeHooks.interrupt?.("edit");
      const { doc, past } = get();
      if (next === doc) return;
      set({ doc: next, past: [...past.slice(-HISTORY_LIMIT + 1), { doc, label }], future: [], dirty: true, gestureBase: null });
      fixSelection();
      storeHooks.committed?.(next, label);
    },
    beginGesture() {
      storeHooks.interrupt?.("edit");
      storeHooks.beforeCommit?.();
      set({ gestureBase: get().doc });
    },
    updateGesture(recipe) {
      const base = get().gestureBase;
      if (!base) return;
      set({ doc: produce(base, recipe) });
    },
    endGesture(label) {
      const { gestureBase, doc, past } = get();
      if (!gestureBase) return;
      if (doc === gestureBase) return set({ gestureBase: null });
      const stamped = produce(settleSlides(doc, gestureBase), (d) => {
        d.modified = new Date().toISOString();
      });
      set({ doc: stamped, gestureBase: null, past: [...past.slice(-HISTORY_LIMIT + 1), { doc: gestureBase, label }], future: [], dirty: true });
      storeHooks.committed?.(stamped, label);
    },
    cancelGesture() {
      const base = get().gestureBase;
      if (base) set({ doc: base, gestureBase: null });
    },
    undo() {
      storeHooks.interrupt?.("history");
      const { past, doc, future } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      set({ doc: prev.doc, past: past.slice(0, -1), future: [...future, { doc, label: prev.label }], dirty: true });
      fixSelection();
      const msg = t("engine.history.undo", { label: prev.label });
      storeHooks.committed?.(prev.doc, msg);
      get().notify(msg);
    },
    redo() {
      storeHooks.interrupt?.("history");
      const { past, doc, future } = get();
      const next = future[future.length - 1];
      if (!next) return;
      set({ doc: next.doc, future: future.slice(0, -1), past: [...past, { doc, label: next.label }], dirty: true });
      fixSelection();
      const msg = t("engine.history.redo", { label: next.label });
      storeHooks.committed?.(next.doc, msg);
      get().notify(msg);
    },
    load(doc, filePath = null) {
      set({ doc, past: [], future: [], dirty: false, filePath, pageId: doc.pages[0]?.id ?? "", selection: [], editingTextId: null, gestureBase: null });
      storeHooks.loaded?.(doc);
    },
    set(p) {
      // switching tools ends a lock unless the caller sets it (chooseTool)
      if (p.tool !== undefined && p.toolLocked === undefined && p.tool !== get().tool) p = { ...p, toolLocked: false };
      set(p);
    },
    notify(msg) {
      clearTimeout(toastTimer);
      set({ toast: msg });
      toastTimer = setTimeout(() => set({ toast: null }), 2200);
    },
  };
});

function fixSelection() {
  const s = useStore.getState();
  const all = [...s.doc.pages, ...s.doc.masters];
  if (!all.some((p) => p.id === s.pageId)) s.set({ pageId: s.doc.pages[0]?.id ?? "" });
  const page = currentPage();
  if (page) s.set({ selection: s.selection.filter((id) => page.nodes.some((n) => n.id === id)) });
}

/** Tools that hand back to the select tool after one object unless locked (pen, brush and eraser keep going). */
export const ONE_SHOT_TOOLS: readonly Tool[] = ["text", "rect", "ellipse", "line"];

/** Toolbar click: picks the tool unlocked (so clicking a locked tool unlocks it); double-click locks it. */
export function chooseTool(tool: Tool, lock = false): void {
  useStore.getState().set({ tool, toolLocked: lock });
}

/**
 * A text box or shape made with `by` is finished: back to the select tool unless the tool is locked — or was
 * changed meanwhile (picking another tool while a text box is open must keep that tool).
 */
export function toolDone(by: Tool): void {
  const s = useStore.getState();
  if (s.tool === by && ONE_SHOT_TOOLS.includes(by) && !s.toolLocked) s.set({ tool: "select" });
}

export function findPage(doc: OmwDocument, id: string): Page | undefined {
  return doc.pages.find((p) => p.id === id) ?? doc.masters.find((p) => p.id === id);
}

export function currentPage(): Page | undefined {
  const s = useStore.getState();
  return findPage(s.doc, s.pageId);
}

export function draftPage(d: Draft<OmwDocument>, id: string): Draft<Page> | undefined {
  return d.pages.find((p) => p.id === id) ?? d.masters.find((p) => p.id === id);
}

export function selectedNodes(): SceneNode[] {
  const s = useStore.getState();
  const page = findPage(s.doc, s.pageId);
  if (!page) return [];
  return page.nodes.filter((n) => s.selection.includes(n.id));
}

export function masterOf(doc: OmwDocument, page: Page): Page | null {
  if (!page.masterId) return null;
  return doc.masters.find((m) => m.id === page.masterId) ?? null;
}

/** Keep every page's layer groups canonical after an edit (members together, no dangling ids); see core/layerTree.ts. */
function normalizeDocGroups(d: OmwDocument) {
  for (const p of d.pages) if (p.groups) normalizeGroups(p);
  for (const p of d.masters) if (p.groups) normalizeGroups(p);
}
