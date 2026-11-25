// 하이퍼링크 (Word / 한글 / PowerPoint Ctrl+K): put a link on the selected text (or type new linked text at the caret),
// change or remove it, and open it (Ctrl+click, the right-click menu). The link is TextRun.link; DOCX writes it as a
// HYPERLINK field, reads w:hyperlink and HYPERLINK fields (io/office.ts).

import * as RT from "../core/richtext";
import { DEFAULT_RUN } from "../core/types";
import { t } from "../i18n";
import { richApi } from "./RichTextEditor";
import { textTargetNow } from "./shell/Ribbon";

/** Word's Hyperlink style colour. */
export const LINK_COLOR = "#0563C1";

/** "www.x.com" → "https://www.x.com"; a mail address → "mailto:"; "#mark" and full URLs as they are. */
export function normalizeLink(raw: string): string {
  const v = raw.trim();
  if (!v || v.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "mailto:" + v;
  return "https://" + v;
}

/** The link the text target has now (the whole selection / caret format), if any. */
export const linkHere = (): string | undefined => textTargetNow()?.fmt.link;

/**
 * Link the selection (or, at a caret, type `text` linked). `text` replaces the selection when it was changed in the
 * dialog. One undo step for the format (and one for typed text).
 */
export function applyLink(url: string, text: string, selected: string): boolean {
  const tg = textTargetNow();
  const api = richApi();
  const link = normalizeLink(url);
  if (!tg?.applyRun || !link) return false;
  const patch: RT.RunPatch = { link, color: LINK_COLOR, underline: true };
  if (selected && text === selected) {
    tg.applyRun(patch, t("docux.link.hist"));
    return true;
  }
  if (!api) return false;
  // the caret (or a selection whose text was changed): the next typed text takes the link
  tg.applyRun(patch, t("docux.link.hist"));
  api.insertText(text || link);
  return true;
}

/** Take the link off the selection (its text back to the body colour, not underlined). */
export function removeLink(): boolean {
  const tg = textTargetNow();
  if (!tg?.applyRun) return false;
  tg.applyRun({ link: null, color: DEFAULT_RUN.color, underline: false }, t("docux.link.remove"));
  return true;
}

export { openLink } from "./openLink";
