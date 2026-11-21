// What a save / export changes, said before or after writing (design ch. 5 "honest fallback"): read from the one
// capability table (core/style/caps.ts exportIssues) — e.g. "PPTX: inner glow — turned into a picture (2)".
// Layer effects are always listed; for other properties only what is lost or turned into a picture (an approximate
// line spacing on every PDF export would be noise).

import { CAP_FORMATS, exportIssues, summarizeIssues, type CapFormat } from "../core/style/caps";
import type { Page } from "../core/types";
import { t } from "../i18n";

const asFormat = (ext: string): CapFormat | null => ((CAP_FORMATS as readonly string[]).includes(ext) ? (ext as CapFormat) : null);

/** Short notices for saving `pages` as `ext` (empty when nothing changes). */
export function exportNotes(pages: readonly Page[], ext: string, max = 3): string[] {
  const fmt = asFormat(ext.toLowerCase());
  if (!fmt) return [];
  const items = summarizeIssues(exportIssues(pages, fmt)).filter((i) => i.prop.startsWith("fx.") || i.level !== "approx");
  const lines = items.map((i) => t("fx.notice.item", { fmt: fmt.toUpperCase(), prop: t(`style.prop.${i.prop}`), level: t(`style.cap.${i.level}`), n: i.count }));
  return lines.length > max ? [...lines.slice(0, max), t("fx.notice.more", { n: lines.length - max })] : lines;
}
