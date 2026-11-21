// Document tabs — the flows around core/sessions.ts: close with "save changes?", save all, close all before
// quitting / updating / closing the window, and what ends when a tab is parked (docs/design/SHELL_LAYOUT.md §5).
//
// Public API for other departments: openInTab() (actions.ts) opens a file in a tab; newSession() / switchTo()
// (core/sessions.ts) make and pick tabs; closeTab() / confirmAllSaved() here ask about unsaved changes.

import { create } from "zustand";
import { useStore } from "../core/store";
import { activeSessionId, cycleTab, dirtyTabs, removeSession, sessionDoc, sessionHooks, switchTo, tabMeta, useSessions, type TabMeta } from "../core/sessions";
import { releaseCmyk } from "../render/cmykView";
import { journalClear } from "../io/journal";
import { saveDoc } from "./actions";
import { applyCrop, useCrop } from "./cropTool";
import { endTransformSession, useXform } from "./xform";
import { useCellSel } from "./CellEditor";
import { useLayersUI } from "./groups";
import { useUI } from "./shell/uiStore";
import { smartChildrenFirst } from "./smartObject";

export { cycleTab, switchTo };

const S = () => useStore.getState();

// ───────── parking a tab ─────────

// whatever is in progress belongs to the document it was started on: finish it there before the tab is parked
sessionHooks.quiesce.push(() => {
  if (useCrop.getState().id) applyCrop();
  if (useXform.getState().session != null) endTransformSession(false);
  // the text editor commits what was typed when editing ends (RichTextEditor watches editingTextId)
  if (S().editingTextId) S().set({ editingTextId: null });
});
// panel state that points into the parked document
sessionHooks.switched.push(() => {
  useCellSel.setState({ target: null, end: null });
  useLayersUI.getState().set({ activeGroup: null });
});
// a closed document's crash-recovery copy goes with it
sessionHooks.closed.push((id) => void journalClear(id).catch(() => {}));
// and the CMYK channels / composite tiles of PSD files no open document uses any more (render/cmykView.ts)
sessionHooks.closed.push(() => {
  const inUse = new Set<string>();
  for (const t of useSessions.getState().tabs) for (const a of Object.values(sessionDoc(t.id)?.assets ?? {})) inUse.add(a.hash);
  releaseCmyk(inUse);
});

// ───────── "save changes?" ─────────

export type UnsavedAnswer = "save" | "discard" | "cancel";

interface PromptState {
  pending: { tabs: TabMeta[]; resolve: (a: UnsavedAnswer) => void } | null;
}
/** The open question (ui/shell/TabDialogs.tsx shows it). */
export const useTabPrompt = create<PromptState>(() => ({ pending: null }));

/** Ask once about these unsaved documents. With nobody to ask (tests), the answer is "cancel". */
export function askUnsaved(tabs: TabMeta[]): Promise<UnsavedAnswer> {
  if (typeof document === "undefined") return Promise.resolve("cancel");
  const prev = useTabPrompt.getState().pending;
  prev?.resolve("cancel");
  return new Promise((resolve) => useTabPrompt.setState({ pending: { tabs, resolve } }));
}

export function answerUnsaved(a: UnsavedAnswer) {
  const p = useTabPrompt.getState().pending;
  useTabPrompt.setState({ pending: null });
  p?.resolve(a);
}

/** Save one tab (it becomes active). False when it is still unsaved (save dialog cancelled, error). */
async function saveTab(id: string): Promise<boolean> {
  if (!switchTo(id)) return false;
  await saveDoc();
  return !S().dirty;
}

/** Save every tab with unsaved changes, in order; stops at the first one that is not saved. */
export async function saveAllDirty(): Promise<boolean> {
  const back = activeSessionId();
  // a smart object's content tab first: its save puts it into its parent, which then needs saving too
  for (const id of smartChildrenFirst(useSessions.getState().tabs.map((t) => t.id))) if (tabMeta(id)?.dirty && !(await saveTab(id))) return false;
  if (tabMeta(back)) switchTo(back);
  return true;
}

/**
 * Close a tab. Unsaved changes are asked about (save / don't save / cancel). Closing the last tab leaves a new,
 * empty document and shows the start screen. Returns false when the person cancelled.
 */
export async function closeTab(id: string = activeSessionId()): Promise<boolean> {
  const meta = tabMeta(id);
  if (!meta) return true;
  if (meta.dirty) {
    switchTo(id); // the question is about the document in front of them
    const a = await askUnsaved([meta]);
    if (a === "cancel") return false;
    if (a === "save" && !(await saveTab(id))) return false;
  }
  const last = useSessions.getState().tabs.length === 1;
  removeSession(id);
  if (last) useUI.getState().set({ welcome: true });
  return true;
}

/** Close several tabs with one question about the unsaved ones among them. */
export async function closeTabs(ids: string[]): Promise<boolean> {
  const metas = ids.map(tabMeta).filter((t): t is TabMeta => !!t);
  const dirty = metas.filter((t) => t.dirty);
  if (dirty.length) {
    const a = await askUnsaved(dirty);
    if (a === "cancel") return false;
    // (content tabs before their parents: putting a smart object's content back makes its parent unsaved again)
    if (a === "save") for (const id of smartChildrenFirst(metas.map((t) => t.id))) if (tabMeta(id)?.dirty && !(await saveTab(id))) return false;
  }
  const lastAll = metas.length === useSessions.getState().tabs.length;
  for (const t of metas) removeSession(t.id);
  if (lastAll) useUI.getState().set({ welcome: true });
  return true;
}

export const closeOtherTabs = (id: string) => closeTabs(useSessions.getState().tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id));
export function closeTabsToRight(id: string) {
  const tabs = useSessions.getState().tabs;
  const i = tabs.findIndex((t) => t.id === id);
  return closeTabs(tabs.slice(i + 1).filter((t) => !t.pinned).map((t) => t.id));
}
export const closeAllTabs = () => closeTabs(useSessions.getState().tabs.map((t) => t.id));

/**
 * Before quitting, closing the window or installing an update: one question about every unsaved document.
 * True = go on (all saved, or the person chose not to save).
 */
export async function confirmAllSaved(): Promise<boolean> {
  const dirty = dirtyTabs();
  if (!dirty.length) return true;
  const a = await askUnsaved(dirty);
  if (a === "cancel") return false;
  // 저장 안 함: what was not saved is given up — its crash-recovery copy too
  if (a === "discard") {
    await Promise.all(dirty.map((m) => journalClear(m.id).catch(() => {})));
    return true;
  }
  return saveAllDirty();
}

/** Any open document with unsaved changes (window close guard, update prompt). */
export const anyDirty = () => dirtyTabs().length > 0;
