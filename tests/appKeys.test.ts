// The app's Ctrl chords go on from a text being typed in on the page (ui/appKeys.ts; checked by key in the app too).
import { describe, expect, it } from "vitest";
import { PAGE_EDITORS, isAppChord } from "../src/ui/appKeys";

const k = (code: string, o: Partial<KeyboardEvent> = {}) => ({ ctrlKey: true, metaKey: false, altKey: false, key: code.replace(/^Key/, "").toLowerCase(), code, ...o }) as KeyboardEvent;

describe("app chords while typing", () => {
  it("열기 · 저장 · 새로 · 닫기 · 찾기 · 바꾸기 · 인쇄 and the tab keys; not the editor's own (B, I, Z…)", () => {
    for (const c of ["KeyO", "KeyS", "KeyN", "KeyW", "KeyF", "KeyH", "KeyP"]) expect(isAppChord(k(c))).toBe(true);
    expect(isAppChord(k("KeyO", { ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isAppChord({ ...k("Tab"), key: "Tab" })).toBe(true);
    for (const c of ["KeyB", "KeyI", "KeyU", "KeyZ", "KeyY", "KeyA", "KeyC", "KeyV", "KeyE"]) expect(isAppChord(k(c))).toBe(false);
    expect(isAppChord(k("KeyO", { ctrlKey: false }))).toBe(false);
    expect(isAppChord(k("KeyO", { altKey: true }))).toBe(false);
  });
  it("the page's editors: body, text box, table cell, slide notes", () => {
    for (const c of ["flow-editor", "rich-editor", "cell-editor", "notes-text"]) expect(PAGE_EDITORS).toContain("." + c);
  });
});
