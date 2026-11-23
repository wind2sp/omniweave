// Ctrl chords the whole app answers even while a text on the page is being typed in (Word / 한글 / PowerPoint): 열기,
// 저장, 새로 만들기, 닫기, 찾기 / 바꾸기, 인쇄 and the document tab keys. A text editor on the page lets these go on to
// the app's shortcuts (ui/shell/shortcuts.ts) instead of keeping them (QA ui-audit #40 and the 11-23 recheck: in a text
// box — ODT, slides, PDF text — Ctrl+O / S / N / W / F did nothing, or the browser's own command ran).

/** The editors on the page whose typing does not keep the app's chords from working. */
export const PAGE_EDITORS = ".flow-editor, .rich-editor, .cell-editor, .psd-text-editor, .notes-text, .sheet-editor, .sheet-formula, .pdf-field-edit";

export function isAppChord(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "key" | "code">): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (e.key === "Tab" || e.key === "PageUp" || e.key === "PageDown" || e.key === "F4") return true;
  return ["KeyO", "KeyS", "KeyN", "KeyW", "KeyF", "KeyH", "KeyP"].includes(e.code);
}
