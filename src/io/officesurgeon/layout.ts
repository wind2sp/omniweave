// Office Surgeon — page layout (page breaks, sections, paper size, orientation, margins) of a DOCX / HWPX save.
//
// The original's layout is read again with the importer (OfficeLayout: page breaks before items, sections with their
// setup) and compared with the pages (core/pageSetup sectionsOf via office.ts flowLayout):
//   • a section whose paper / margins changed → only that section's settings element is rewritten (w:pgSz + w:pgMar,
//     hp:pagePr); unchanged sections keep their original text;
//   • a new hard page break (Ctrl+Enter, a new page) → a break is added before the item that starts the page
//     (DOCX: Word's page-break paragraph, HWPX: pageBreak="1" on that paragraph);
//   • what cannot be expressed in place — sections added or removed, a break removed, an item that had a break
//     deleted, empty pages — makes the save fall back to writing the file anew (with the usual notice).

import { legacyWordPages, sameSetup, type PageSetup } from "../../core/pageSetup";
import { PAGE_PRESETS, type Page } from "../../core/types";
import { flowLayout, type FlowItem, type OfficeLayout } from "../office";
import { itemId } from "./common";
import { SurgeryUnavailable } from "./docx";

export interface LayoutDiff {
  /** item id → page breaks to add before it */
  addBreaks: Map<string, number>;
  /** section (original order) → its new setup, for sections whose paper or margins changed */
  setups: Map<number, PageSetup>;
  /** nothing to change */
  none: boolean;
}

/** Nothing to change in the original's layout. */
export const NO_LAYOUT_CHANGE: LayoutDiff = { addBreaks: new Map(), setups: new Map(), none: true };

/**
 * A block map of rules version 1 (an .omw saved before page setup): its pages carry no layout (A4, default margins,
 * no breaks), so the original's layout is kept as it is — the save works as it did then. Only while the pages are
 * still as that app made them: once a break or a page setup was made, the file is written anew (with the notice).
 * Returns the layout diff to use (none), or throws SurgeryUnavailable.
 */
export function legacyLayout(pages: Page[], engine: number): LayoutDiff {
  if (engine !== 1) throw new SurgeryUnavailable("engine");
  const untouched = legacyWordPages(pages) && pages.every((p) => !p.margins && p.breakBefore === undefined && p.width === PAGE_PRESETS.A4.width && p.height === PAGE_PRESETS.A4.height);
  if (!untouched) throw new SurgeryUnavailable("engine");
  return NO_LAYOUT_CHANGE;
}

/** What the save must change in the original's page layout (throws SurgeryUnavailable when it cannot be done in place). */
export function layoutDiff(pages: Page[], flow: FlowItem[], starts: number[], origIds: string[], orig: OfficeLayout): LayoutDiff {
  const lay = flowLayout(pages, starts, flow.length);
  const idAt = (i: number) => itemId(flow[i]);
  // sections: the same sections must start at the same items
  const curSec: string[] = [];
  for (const p of lay.pages)
    if (p.begin === "section") {
      if (p.from >= p.to) throw new SurgeryUnavailable("empty section");
      curSec.push(idAt(p.from));
    }
  const origSec = orig.sections.slice(1).map((s) => origIds[s.start]);
  if (curSec.length !== origSec.length || curSec.some((id, i) => id !== origSec[i])) throw new SurgeryUnavailable("sections");
  const setups = new Map<number, PageSetup>();
  lay.sections.forEach((s, j) => {
    if (orig.sections[j] && !sameSetup(s, orig.sections[j].setup)) setups.set(j, s);
  });
  // hard page breaks (an empty page is one more break before the next item)
  const cur = new Map<string, number>();
  let empty = 0;
  for (const p of lay.pages) {
    if (p.begin === "section" && empty) throw new SurgeryUnavailable("empty page");
    const own = p.begin === "page" ? 1 : 0;
    if (p.from >= p.to) {
      empty += own;
      continue;
    }
    if (own + empty) cur.set(idAt(p.from), own + empty);
    empty = 0;
  }
  if (empty) throw new SurgeryUnavailable("empty page");
  const present = new Set(flow.map(itemId));
  const secStarts = new Set(orig.sections.map((s) => s.start));
  const before = new Map<string, number>();
  for (const i of orig.pageBreaks) {
    if (secStarts.has(i)) continue;
    const id = origIds[i];
    if (!present.has(id)) throw new SurgeryUnavailable("break item deleted");
    before.set(id, 1);
  }
  const addBreaks = new Map<string, number>();
  for (const id of new Set([...cur.keys(), ...before.keys()])) {
    const extra = (cur.get(id) ?? 0) - (before.get(id) ?? 0);
    if (extra < 0) throw new SurgeryUnavailable("break removed");
    if (extra) addBreaks.set(id, extra);
  }
  return { addBreaks, setups, none: !addBreaks.size && !setups.size };
}
