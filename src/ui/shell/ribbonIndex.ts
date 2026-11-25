// The command search (Alt+Q) finds the buttons of the ribbon too (QA 11-24 basic-ux: '정렬', '병합하고 가운데',
// '레이아웃' found nothing — many ribbon buttons run code of their own, not a registry command). When the search opens,
// the tabs of the current ribbon are drawn one by one (synchronously, so nothing is painted in between) and their
// buttons listed; choosing one shows its tab and presses that button, as a click would.

import { flushSync } from "react-dom";
import { t } from "../../i18n";
import { RIBBON_TABS, isMenuSurface, surfaceOf, useRibbonTab, type Surface } from "../ribbonTabs";
import { findPage, useStore } from "../../core/store";
import { useCadScreen } from "../editModes";
import type { Command } from "../commands";

interface Entry {
  surface: Surface;
  tab: string;
  label: string;
  disabled: boolean;
}

let entries: Entry[] = [];

const ROOT = ".ribbon.doc-ribbon";

/** A button's name as people see it: its aria-label, tooltip or text (one line). */
function nameOf(b: HTMLElement): string {
  // (the words on the button first: a tooltip can be a long explanation — "여백 — 지금 여백 위 25 …")
  const own = (b.textContent || "").replace(/\s+/g, " ").trim();
  const s = (own && own.length <= 40 ? own : b.getAttribute("aria-label") || b.dataset.tip || own || "").replace(/\s+/g, " ").trim();
  return s.length > 0 && s.length <= 60 ? s : "";
}

/** List the buttons of every tab of the current ribbon (call it outside React rendering — it renders each tab). */
export function indexRibbon(): void {
  const s = useStore.getState();
  const surface = surfaceOf(findPage(s.doc, s.pageId), s.mode, useCadScreen.getState().on);
  entries = [];
  if (isMenuSurface(surface) || typeof document === "undefined") return;
  const was = useRibbonTab.getState().tab;
  const seen = new Set<string>();
  try {
    for (const tab of RIBBON_TABS[surface]) {
      flushSync(() => useRibbonTab.getState().set(surface, tab));
      const root = document.querySelector(ROOT);
      if (!root) continue;
      for (const b of root.querySelectorAll<HTMLButtonElement>("button")) {
        const label = nameOf(b);
        if (!label || seen.has(`${tab}\u0000${label}`)) continue;
        seen.add(`${tab}\u0000${label}`);
        entries.push({ surface, tab, label, disabled: b.disabled });
      }
    }
  } finally {
    flushSync(() => useRibbonTab.setState({ tab: was }));
  }
}

/** Show the entry's tab and press its button. */
function press(e: Entry) {
  useRibbonTab.getState().set(e.surface, e.tab);
  requestAnimationFrame(() => {
    const root = document.querySelector(ROOT);
    const b = root && [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => nameOf(x) === e.label);
    if (b && !b.disabled) b.click();
  });
}

/** The listed ribbon buttons as search rows: "이름 — 탭" (the current ribbon's: they come first for the same words). */
export function ribbonCommands(): Command[] {
  return entries.map((e, i) => ({
    id: `ribbon.${e.tab}.${i}`,
    label: () => `${e.label} — ${t(`topui.tab.${e.surface}.${e.tab}`, undefined, e.tab)}`,
    when: () => !e.disabled,
    run: () => press(e),
  }));
}
