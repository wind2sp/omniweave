// 상용구 (한글) / 자동 텍스트 (Word 빠른 문서 요소 ▸ 자동 텍스트): text the person keeps under a short name (준말) and
// puts in again — kept for this user on this computer (the program's own settings, not the document).
//   한글: Alt+I with text selected = 상용구 등록; after a 준말 = its text in its place; Ctrl+F3 = 상용구 내용 (the list)
//   Word: Alt+F3 = 새 자동 텍스트 from the selection; F3 after its name = the text in its place

import { t } from "../i18n";
import { useStore } from "../core/store";
import { richApi } from "./RichTextEditor";
import { useUI } from "./shell/uiStore";

export interface AutoTextEntry {
  /** 준말: the short name typed before Alt+I / F3 */
  name: string;
  /** 본말: what it becomes */
  text: string;
}

const KEY = "omniweave.autotext";

export function autoTexts(): AutoTextEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === "string" && typeof x.text === "string") : [];
  } catch {
    return [];
  }
}

function store(list: AutoTextEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* (private window: the list lives for this session only) */
  }
}

/** Keep `text` under `name` (an entry of that name is replaced). */
export function addAutoText(name: string, text: string) {
  const n = name.trim();
  if (!n || !text) return;
  store([...autoTexts().filter((e) => e.name !== n), { name: n, text }]);
}

export function removeAutoText(name: string) {
  store(autoTexts().filter((e) => e.name !== name));
}

/** The entry whose name ends the text before the caret (the longest one), if any. */
export function autoTextBefore(before: string): AutoTextEntry | null {
  let best: AutoTextEntry | null = null;
  for (const e of autoTexts()) {
    if (!before.endsWith(e.name)) continue;
    // (the name as a word of its own: nothing but a space or the paragraph start before it)
    const prev = before.slice(0, before.length - e.name.length);
    if (prev && !/\s$/.test(prev)) continue;
    if (!best || e.name.length > best.name.length) best = e;
  }
  return best;
}

/** The 준말 before the caret becomes its 본말; false when there is none. */
export function expandAutoText(): boolean {
  const api = richApi();
  const e = autoTextBefore(api?.textBefore?.() ?? "");
  if (!api?.replaceBefore || !e) return false;
  api.replaceBefore(e.name.length, e.text, t("autotext.hist"));
  return true;
}

/** The text to keep as a new entry: the selection. */
export const autoTextSelection = () => richApi()?.selectedText?.() ?? "";

let mode: "add" | "list" = "list";
export const autoTextMode = () => mode;
const open = (m: "add" | "list") => {
  mode = m;
  useUI.getState().set({ shellDialog: "autotext" });
};

/** 한글 Alt+I: with a selection, 상용구 등록; after a 준말, its 본말; else the list. */
export function autoTextKey() {
  if (autoTextSelection()) return open("add");
  if (expandAutoText()) return;
  open("list");
}

/** Word F3: the name before the caret becomes its text (nothing to expand: said so). */
export function autoTextExpand() {
  if (!expandAutoText()) useStore.getState().notify(t("autotext.noName"));
}

export const openAutoTextAdd = () => open("add");
export const openAutoTextList = () => open("list");
