// 내보내기 ▸ — one list for the 파일 menu's submenu, the command bar's 내보내기 button and the command search (Alt+Q):
// the formats most used in the current edit mode first, then by kind (그림 · 문서 · 발표 · 표). A format that cannot make
// anything meaningful of this document (Excel / CSV without a table, Markdown / text without text) is greyed out
// with the reason — never an error after the click; one that keeps only part of it says what is left out.

import { t } from "../i18n";
import { useStore } from "../core/store";
import type { Page } from "../core/types";
import { collectTables } from "../io/formats/csv";
import { usedRange } from "../io/sheet/pages";
import { pagesToText } from "../io/formats/text";
import { cuesFromPages } from "../io/formats/srt";
import { hwp5Source } from "../io/formats/hwp5Fp";
import { LEGACY_KINDS, legacySource, type LegacyKind } from "../io/formats/legacyWrite";
import { exportAs, exportTargets } from "./actions";
import { currentEditMode, type EditMode } from "./editModes";
import type { MenuItem } from "./shell/controls";
import { useUI } from "./shell/uiStore";

type Kind = "img" | "doc" | "show" | "table";
const KINDS: [Kind, string[]][] = [
  ["img", ["png", "jpg", "webp", "svg", "psd", "pdf-image"]],
  ["doc", ["pdf", "docx", "doc", "hwpx", "hwp", "md", "html", "txt"]],
  ["show", ["pptx", "ppt"]],
  ["table", ["xlsx", "xls", "csv", "srt"]],
];
/** what comes first in each edit mode (the mode's own format and the most common ones) */
const FIRST: Record<EditMode, string[]> = {
  IMAGE: ["png", "jpg", "psd", "pdf"],
  DOCUMENT: ["pdf", "docx", "hwpx"],
  SLIDE: ["pptx", "pdf"],
  DESIGN: ["svg", "pdf", "png"],
};

/** Why this format cannot make anything of the document now (shown greyed with this), or null when it can. */
export function exportBlocked(id: string, pages: Page[] = useStore.getState().doc.pages): string | null {
  // a workbook is a table (XLSX writes its sheets as they are); the other formats see the sheets laid out as table
  // pages, as the export itself does (io/formats/index.ts — expandSheetPages)
  // (a sheet with any filled cell is a table with text; checked without laying out a large sheet)
  if (id === "xlsx" && pages.some((p) => p.sheet)) return null;
  if ((id === "csv" || id === "md" || id === "txt" || id === "html") && pages.some((p) => p.sheet && usedRange(p.sheet).r1 >= 0)) return null;
  if (id === "xlsx" || id === "csv") return collectTables(pages).length ? null : t("menu.export.noTable");
  if (id === "srt") return cuesFromPages(pages).cues.length ? null : t("menu.export.noCues");
  if (id === "md" || id === "txt" || id === "html") return pagesToText(pages).trim() ? null : t("menu.export.noText");
  return null;
}

/** What a word processor format leaves out of this document (shapes, layers), said in its hint; null when nothing. */
function partialNote(id: string, pages: Page[]): string | null {
  if (id !== "docx" && id !== "hwpx") return null;
  const lost = pages.some((p) => p.nodes.some((n) => n.visible && (n.type === "VECTOR" || (n.type === "RASTER" && Object.keys(n.tiles).length))));
  return lost ? t("menu.export.textOnly") : null;
}

interface Target {
  id: string;
  label: string;
  hint: string;
  blocked: string | null;
}

function targets(): { same: Target | null; first: Target[]; groups: [Kind, Target[]][] } {
  const pages = useStore.getState().doc.pages;
  const all = exportTargets();
  const as = (id: string): Target | null => {
    const x = all.find((e) => e.id === id);
    if (!x) return null;
    // HWP: only for a document opened from an HWP file (io/formats/hwp5Write.ts)
    if (id === "hwp" && !hwp5Source(pages)) return null;
    // DOC / XLS / PPT: only for a document opened from such a file, kept as it was (io/formats/legacyWrite.ts)
    if ((LEGACY_KINDS as readonly string[]).includes(id) && !legacySource(pages, id as LegacyKind)) return null;
    const note = partialNote(id, pages);
    return { id, label: x.label, hint: note ? `${x.hint} · ${note}` : x.hint, blocked: exportBlocked(id, pages) };
  };
  const first = FIRST[currentEditMode()].map(as).filter((x): x is Target => !!x);
  const taken = new Set(first.map((x) => x.id));
  const groups = KINDS.map(([k, ids]) => [k, ids.filter((id) => !taken.has(id)).map(as).filter((x): x is Target => !!x)] as [Kind, Target[]]).filter(([, l]) => l.length);
  return { same: as("same"), first, groups };
}

/** The 내보내기 list as menu items (`icons`: the 파일 menu shows them; the command bar's button does not). */
export function exportMenuItems(icons = true): MenuItem[] {
  const { same, first, groups } = targets();
  const item = (x: Target): MenuItem => ({
    label: x.label,
    hint: x.blocked ?? x.hint,
    tip: x.blocked ?? undefined,
    disabled: !!x.blocked,
    icon: x.id === "same" ? "save" : icons ? "export" : undefined,
    onSelect: () => void exportAs(x.id),
  });
  const out: MenuItem[] = [];
  if (same) out.push(item(same), { sep: true });
  out.push(...first.map(item));
  for (const [k, list] of groups) out.push({ heading: t(`menu.export.kind.${k}`) }, ...list.map(item));
  // size-reduced PDF (lossless by default; lossy photo re-encoding only when chosen in the dialog)
  out.push({ sep: true }, { label: t("size.menu"), hint: t("size.menuHint"), icon: icons ? "export" : undefined, onSelect: () => useUI.getState().set({ shellDialog: "sizePdf" }) });
  return out;
}

/** The formats as commands for the command search: "내보내기 ▸ PDF (.pdf)". */
export function exportCommandList(): { id: string; label: string; enabled: boolean; blocked: string | null; run: () => void }[] {
  const { same, first, groups } = targets();
  const head = t("menu.head.export");
  const formats = [...(same ? [same] : []), ...first, ...groups.flatMap(([, l]) => l)].map((x) => ({
    id: `export.${x.id}`,
    label: `${head} ▸ ${x.label}`,
    enabled: !x.blocked,
    blocked: x.blocked,
    run: () => void exportAs(x.id),
  }));
  // the last row of the menus too (size-reduced PDF), so the command search offers the same list
  return [...formats, { id: "export.sizePdf", label: `${head} ▸ ${t("size.menu")}`, enabled: true, blocked: null, run: () => useUI.getState().set({ shellDialog: "sizePdf" }) }];
}
