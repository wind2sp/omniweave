// Document sessions — several open documents, one per tab (docs/design/SHELL_LAYOUT.md §5).
//
// The editing store (core/store.ts) keeps holding exactly one document: the active tab's. Every module keeps
// reading `useStore` as before. A tab switch parks the active document's part of the store (document, undo
// stack, selection, view, work mode, file path, dirty flag…) in a snapshot and puts the other tab's snapshot
// back. Modules that keep per-document state of their own outside the store (history timeline, password
// session of an .omw…) register a SessionPart and are parked and restored with it.
//
// Snapshots hold immutable document roots, so parking a tab copies nothing; pixel tiles are shared by hash.

import { create } from "zustand";
import { DEFAULT_VIEW, useStore, type StoreState } from "./store";
import { DEFAULT_TITLE, newDocument, uid, type OmwDocument } from "./types";

/** The part of the store that belongs to one document. Tool, brush and colours stay with the app. */
export const DOC_KEYS = ["doc", "past", "future", "dirty", "filePath", "pageId", "selection", "mode", "view", "editingTextId", "gestureBase"] as const;
export type DocSnap = Pick<StoreState, (typeof DOC_KEYS)[number]>;

/** Per-document state kept by another module; `restore(undefined)` = a brand-new document. */
export interface SessionPart<T = unknown> {
  key: string;
  capture: () => T;
  restore: (v: T | undefined, doc: OmwDocument) => void;
}

/** What the tab strip shows for a document (the active tab's entry follows the store live). */
export interface TabMeta {
  id: string;
  /** stored title (docTitle() shows the default one in the viewer's language) */
  title: string;
  dirty: boolean;
  /** .omw file it is saved to */
  filePath: string | null;
  /** file it was opened from (a .docx, .pdf… — "open" of the same file again goes to this tab) */
  openedPath: string | null;
  /** format of the first page's source, or the page kind — for the tab icon */
  kind: string;
  pinned: boolean;
  /** a file is being opened into this tab (the tab shows a busy mark; visual-design owns its look) */
  busy?: boolean;
  /** creation number: a still-untitled document shows as "Untitled 2", "Untitled 3"… (stable, like Word's Document2) */
  seq: number;
  /** a new document or opened file was put in this tab on purpose (it is never reused as an "empty" tab) */
  claimed?: boolean;
}

interface Parked {
  snap: DocSnap;
  parts: Record<string, unknown>;
}

interface SessionsState {
  tabs: TabMeta[];
  active: string;
}

const parts: SessionPart<any>[] = [];
const parked = new Map<string, Parked>();

/** Hooks: `quiesce` ends what is in progress (text editing, crop, free transform, history preview) before the
 * active document is parked; `switched` runs after another tab became active; `closed` after a tab was removed. */
export const sessionHooks: {
  quiesce: (() => void)[];
  switched: ((from: string, to: string) => void)[];
  closed: ((id: string) => void)[];
} = { quiesce: [], switched: [], closed: [] };

export function registerSessionPart<T>(p: SessionPart<T>) {
  const i = parts.findIndex((x) => x.key === p.key);
  if (i >= 0) parts[i] = p;
  else parts.push(p);
}

/** Icon kind for a document: the first page's source format, else its page kind. */
export function docKind(doc: OmwDocument, filePath: string | null): string {
  if (filePath && /\.omw$/i.test(filePath)) return "omw";
  const p = doc.pages[0];
  if (!p) return "DESIGN";
  return p.source?.format ?? (p.nodes.some((n) => n.type === "PDF") ? "pdf" : p.kind);
}

let seqCounter = 0;

function metaFromStore(id: string, prev?: TabMeta): TabMeta {
  const s = useStore.getState();
  return {
    id,
    title: s.doc.title,
    dirty: s.dirty,
    filePath: s.filePath,
    openedPath: prev?.openedPath ?? null,
    kind: docKind(s.doc, s.filePath),
    pinned: prev?.pinned ?? false,
    busy: prev?.busy,
    seq: prev?.seq ?? ++seqCounter,
    claimed: prev?.claimed,
  };
}

const firstId = uid("ds");
export const useSessions = create<SessionsState>(() => ({ tabs: [metaFromStore(firstId)], active: firstId }));
const SS = () => useSessions.getState();

export const activeSessionId = () => SS().active;
export const sessionCount = () => SS().tabs.length;
export const tabMeta = (id: string) => SS().tabs.find((t) => t.id === id);

function setTab(id: string, p: Partial<TabMeta>) {
  useSessions.setState((st) => ({ tabs: st.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
}

/** set while a tab is being swapped in, so the store change is not taken for an edit of the old tab */
let swapping = false;

// the active tab's title / dirty flag / path follow the store
useStore.subscribe((s, prev) => {
  if (swapping) return;
  if (s.doc.title === prev.doc.title && s.dirty === prev.dirty && s.filePath === prev.filePath && s.doc.pages[0] === prev.doc.pages[0]) return;
  const id = SS().active;
  const cur = tabMeta(id);
  if (!cur) return;
  const next = metaFromStore(id, cur);
  if (next.title !== cur.title || next.dirty !== cur.dirty || next.filePath !== cur.filePath || next.kind !== cur.kind) setTab(id, next);
});

function quiesce() {
  for (const f of sessionHooks.quiesce)
    try {
      f();
    } catch (e) {
      console.error(e);
    }
  // a gesture still open after that has no owner left: drop it rather than park half an edit
  const s = useStore.getState();
  if (s.gestureBase) s.cancelGesture();
}

function capture(): Parked {
  const s = useStore.getState();
  const snap = {} as Record<string, unknown>;
  for (const k of DOC_KEYS) snap[k] = s[k];
  const out: Record<string, unknown> = {};
  for (const p of parts) out[p.key] = p.capture();
  return { snap: snap as DocSnap, parts: out };
}

function freshSnap(): DocSnap {
  const doc = newDocument();
  return { doc, past: [], future: [], dirty: false, filePath: null, pageId: doc.pages[0]?.id ?? "", selection: [], mode: "AUTO", view: { ...DEFAULT_VIEW }, editingTextId: null, gestureBase: null };
}

function apply(p: Parked | null) {
  const snap = p?.snap ?? freshSnap();
  swapping = true;
  try {
    useStore.setState({ ...snap });
  } finally {
    swapping = false;
  }
  for (const part of parts) part.restore(p?.parts[part.key], snap.doc);
}

/** True for a new document nobody has touched (opening a file can reuse its tab instead of adding one). */
export function isPristineActive(): boolean {
  const s = useStore.getState();
  if (s.dirty || s.filePath || s.past.length || s.future.length) return false;
  const meta = tabMeta(SS().active);
  if (meta?.openedPath || meta?.claimed) return false;
  return s.doc.pages.length === 1 && s.doc.pages[0].nodes.every((n) => n.type === "RASTER" && !Object.keys(n.tiles).length);
}

/** Open a new, empty document in a tab right after the active one and make it active. Returns its id. */
export function newSession(title: string = DEFAULT_TITLE): string {
  quiesce();
  const from = SS().active;
  parked.set(from, capture());
  const id = uid("ds");
  apply(null);
  if (title !== DEFAULT_TITLE) {
    swapping = true;
    useStore.setState((s) => ({ doc: { ...s.doc, title } }));
    swapping = false;
  }
  const tabs = [...SS().tabs];
  const at = tabs.findIndex((t) => t.id === from);
  tabs.splice(at + 1, 0, metaFromStore(id));
  useSessions.setState({ tabs, active: id });
  for (const f of sessionHooks.switched) f(from, id);
  return id;
}

/** Make another tab active. */
export function switchTo(id: string): boolean {
  const from = SS().active;
  if (id === from) return true;
  const target = parked.get(id);
  if (!target || !tabMeta(id)) return false;
  quiesce();
  parked.set(from, capture());
  parked.delete(id);
  apply(target);
  useSessions.setState({ active: id });
  setTab(id, metaFromStore(id, tabMeta(id)));
  for (const f of sessionHooks.switched) f(from, id);
  return true;
}

/** Tab after / before the active one, wrapping around (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycleTab(delta: 1 | -1) {
  const { tabs, active } = SS();
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === active);
  switchTo(tabs[(i + delta + tabs.length) % tabs.length].id);
}

/**
 * Remove a tab without asking (the caller asked about unsaved changes). Closing the active tab activates its
 * right neighbour (else the left one); closing the last tab leaves one new, empty document.
 */
export function removeSession(id: string) {
  const { tabs, active } = SS();
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  if (id === active) {
    quiesce();
    const next = tabs[i + 1] ?? tabs[i - 1];
    if (next) {
      apply(parked.get(next.id) ?? null);
      parked.delete(next.id);
      useSessions.setState({ tabs: tabs.filter((t) => t.id !== id), active: next.id });
      setTab(next.id, metaFromStore(next.id, next));
      for (const f of sessionHooks.switched) f(id, next.id);
    } else {
      const fresh = uid("ds");
      apply(null);
      useSessions.setState({ tabs: [metaFromStore(fresh)], active: fresh });
      for (const f of sessionHooks.switched) f(id, fresh);
    }
  } else {
    parked.delete(id);
    useSessions.setState({ tabs: tabs.filter((t) => t.id !== id) });
  }
  for (const f of sessionHooks.closed) f(id);
}

/** Move a tab to another index (drag to reorder). Pinned tabs stay in front of the others. */
export function moveTab(id: string, to: number) {
  const tabs = [...SS().tabs];
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  const pinnedCount = tabs.filter((x) => x.pinned).length;
  const lo = t.pinned ? 0 : pinnedCount, hi = t.pinned ? pinnedCount : tabs.length;
  tabs.splice(Math.max(lo, Math.min(hi, to)), 0, t);
  useSessions.setState({ tabs });
}

export function setPinned(id: string, pinned: boolean) {
  const tabs = SS().tabs.map((t) => (t.id === id ? { ...t, pinned } : t));
  // pinned first, keeping each group's order
  useSessions.setState({ tabs: [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)] });
}

export function setOpenedPath(id: string, path: string | null) {
  setTab(id, { openedPath: path });
}

/** The active tab now holds a document someone asked for (a blank slide is not "empty" either). */
export function claimTab(id: string = SS().active) {
  setTab(id, { claimed: true });
}

export function setTabBusy(id: string, busy: boolean) {
  setTab(id, { busy: busy || undefined });
}

const samePath = (a: string | null, b: string) => !!a && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** The tab that already shows this file (saved to or opened from it). */
export function tabForPath(path: string): string | null {
  return SS().tabs.find((t) => samePath(t.filePath, path) || samePath(t.openedPath, path))?.id ?? null;
}

/** Tabs with unsaved changes, in tab order. */
export function dirtyTabs(): TabMeta[] {
  return SS().tabs.filter((t) => t.dirty);
}

/** The document of a tab (active: the store's; parked: its snapshot). */
/** Name a tab shows: the stored title, numbered while it is still the untitled default. */
export function tabTitle(meta: TabMeta, shown: (stored: string) => string): string {
  const name = shown(meta.title);
  return meta.title === DEFAULT_TITLE && meta.seq > 1 ? `${name} ${meta.seq}` : name;
}

export function sessionDoc(id: string): OmwDocument | null {
  if (id === SS().active) return useStore.getState().doc;
  return parked.get(id)?.snap.doc ?? null;
}

/**
 * Change another tab's document (a smart object's content saved in its own tab goes back into its parent): one undo
 * step there, marked unsaved. The active tab goes through the store as usual. False when the tab is gone.
 */
export function updateSessionDoc(id: string, label: string, fn: (doc: OmwDocument) => OmwDocument): boolean {
  if (id === SS().active) {
    const s = useStore.getState();
    const next = fn(s.doc);
    useStore.setState({ doc: next, past: [...s.past, { doc: s.doc, label }], future: [], dirty: true });
    return true;
  }
  const p = parked.get(id);
  if (!p || !tabMeta(id)) return false;
  const doc = p.snap.doc;
  p.snap = { ...p.snap, doc: fn(doc), past: [...p.snap.past, { doc, label }], future: [], dirty: true };
  setTab(id, { dirty: true });
  return true;
}

/** Tests: back to one fresh tab. */
export function resetSessionsForTest() {
  parked.clear();
  seqCounter = 0;
  const id = uid("ds");
  useSessions.setState({ tabs: [metaFromStore(id)], active: id });
}
