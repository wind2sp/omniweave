// Office Surgeon — Omniweave's source-preserving save for Office documents (public API).
//
//   open:  bytes ──import──▶ pages, and the original bytes kept as an asset + a block map (page.source.office)
//   save:  pages ──saveOfficeSurgical──▶ the original package with only the changed paragraphs / cells rewritten
//
// Design: docs/design/OFFICE_SURGEON.md. Stage 1: DOCX, XLSX, HWPX.

import type { AssetRef, Page, PageSource } from "../../core/types";
import { t } from "../../i18n";
import { SAVE_CANCELLED } from "../errors";
import { saveDocxSurgical, SurgeryUnavailable, type SurgeryResult } from "./docx";
import { saveXlsxSurgical } from "./xlsx";
import { saveHwpxSurgical } from "./hwpx";

export { ENGINE_VERSION } from "./common";
export { docxMeta, SurgeryUnavailable, type SurgeryResult } from "./docx";
export { xlsxMeta } from "./xlsx";
export { hwpxMeta } from "./hwpx";

type Fmt = "docx" | "xlsx" | "hwpx";

const SURGEONS: Record<Fmt, (pages: Page[], meta: NonNullable<PageSource["office"]>, assets?: Record<string, AssetRef>) => SurgeryResult> = { docx: saveDocxSurgical, xlsx: saveXlsxSurgical, hwpx: saveHwpxSurgical };

function askNotes(confirm: (msg: string) => boolean, notes: string[]) {
  if (notes.length && !confirm([t("engine.officeSurgeon.notesTitle"), ...notes.map((n) => "- " + n), "", t("engine.common.saveConfirm")].join("\n"))) throw new Error(SAVE_CANCELLED);
}

/** The source (with block map) of the pages that came from one Office file, if any. */
export function officeSource(pages: Page[], fmt: Fmt): PageSource | undefined {
  return pages.find((p) => p.source?.format === fmt && p.source.office)?.source;
}

/**
 * Save `pages` as `fmt`: surgically into the original file when the pages came from one, else (or when the
 * original cannot be matched) with `fresh`. Notes about the save are confirmed first; cancelling throws SAVE_CANCELLED.
 * `assets`: the document's (pictures added, changed or kept — officesurgeon/pics.ts).
 */
export function saveOffice(pages: Page[], fmt: Fmt, confirm: (msg: string) => boolean, fresh: () => Uint8Array, assets?: Record<string, AssetRef>): Uint8Array {
  const src = officeSource(pages, fmt);
  if (!src?.office) {
    // pages from such a file without the map (its first page was deleted, or an older .omw): say what is lost
    if (pages.some((p) => p.source?.format === fmt)) askNotes(confirm, [t("engine.officeSurgeon.fallback")]);
    return fresh();
  }
  const ask = (notes: string[]) => askNotes(confirm, notes);
  // pages from another file cannot go into this one (stage 1)
  const foreign = pages.some((p) => p.source && p.source.name !== src.name);
  try {
    if (foreign) throw new SurgeryUnavailable("foreign");
    const r = SURGEONS[fmt](pages, src.office, assets);
    ask(r.warnings);
    return r.bytes;
  } catch (e) {
    if (!(e instanceof SurgeryUnavailable)) throw e;
    ask([t("engine.officeSurgeon.fallback"), ...e.notes]);
    return fresh();
  }
}
