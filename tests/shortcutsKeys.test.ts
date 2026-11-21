// The window key handler (src/ui/shell/shortcuts.ts globalKey) with made-up key presses: a key that types a
// character in a field stays a character (AltGr on Windows, Option on a Mac), and nothing reaches the page behind an
// open dialog (F5 slide show, tool letters, Delete). The key table itself: tests/keymap.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ui/actions", async (orig) => ({ ...(await orig<typeof import("../src/ui/actions")>()), saveDoc: vi.fn(async () => undefined) }));
vi.mock("../src/ui/reviewActions", async (orig) => ({ ...(await orig<typeof import("../src/ui/reviewActions")>()), startComment: vi.fn() }));

import { useStore, type Mode } from "../src/core/store";
import { newDocument, newPage, type Page, type PageKind } from "../src/core/types";
import { globalKey } from "../src/ui/shell/shortcuts";
import { useUI } from "../src/ui/shell/uiStore";
import { saveDoc } from "../src/ui/actions";
import { startComment } from "../src/ui/reviewActions";

const S = () => useStore.getState();
let modal = false;

function load(kind: PageKind, format: string, mode: Mode = "AUTO") {
  const p: Page = newPage(kind, 800, 600, "P");
  p.source = { format } as Page["source"];
  const doc = newDocument("t");
  doc.pages = [p];
  S().load(doc);
  S().set({ mode, pageId: p.id, presenting: false, editingTextId: null });
}

interface Opts { ctrl?: boolean; alt?: boolean; shift?: boolean; altGr?: boolean; typing?: boolean }
function press(key: string, code: string, o: Opts = {}) {
  const e = {
    key, code, ctrlKey: !!o.ctrl, metaKey: false, altKey: !!o.alt, shiftKey: !!o.shift, repeat: false, isComposing: false,
    // a field (input / text box being edited) or the page / a dialog's button
    target: { closest: () => (o.typing ? {} : null) },
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    getModifierState: (m: string) => m === "AltGraph" && !!o.altGr,
  };
  globalKey(e as unknown as KeyboardEvent);
  return e;
}

beforeEach(() => {
  modal = false;
  vi.stubGlobal("document", { querySelector: (sel: string) => (modal && sel.includes("aria-modal") ? {} : null), activeElement: null });
  useUI.getState().set({ shellDialog: null });
  vi.mocked(saveDoc).mockClear();
  vi.mocked(startComment).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nothing reaches the page behind an open dialog", () => {
  it("F5 on a slide starts the show — but not while a dialog is open (its key is still kept from the browser's reload)", () => {
    load("SLIDE", "pptx");
    modal = true;
    const e = press("F5", "F5");
    expect(e.defaultPrevented).toBe(true);
    expect(S().presenting).toBe(false);
    modal = false;
    press("F5", "F5");
    expect(S().presenting).toBe(true);
  });

  it("a tool letter of the image mode does not change the tool behind a dialog", () => {
    load("DESIGN", "psd");
    S().set({ tool: "select" });
    modal = true;
    press("u", "KeyU");
    expect(S().tool).toBe("select");
    modal = false;
    press("u", "KeyU");
    expect(S().tool).toBe("rect");
  });

  it("command search (Alt+Q) does not open over another dialog", () => {
    load("DOCUMENT", "docx");
    modal = true;
    press("q", "KeyQ", { alt: true });
    expect(useUI.getState().shellDialog).toBeNull();
  });
});

describe("a key that types a character in a field stays a character", () => {
  it("tool letters of the image / design modes are text while typing in a text box", () => {
    load("DESIGN", "psd");
    S().set({ tool: "select" });
    const e = press("u", "KeyU", { typing: true });
    expect(e.defaultPrevented).toBe(false);
    expect(S().tool).toBe("select");
    load("DESIGN", "svg");
    S().set({ tool: "select", editingTextId: "some-text" });
    press("m", "KeyM");
    expect(S().tool).toBe("select");
  });

  it("tool letters work by position under the Korean IME (ㅕ on U) and a Cyrillic layout (г on U)", () => {
    load("DESIGN", "psd");
    for (const ch of ["ㅕ", "г", "Process"]) {
      S().set({ tool: "select" });
      press(ch, "KeyU");
      expect(S().tool, ch).toBe("rect");
    }
  });

  it("Polish AltGr+S (ś) in a field is not Ctrl+S save", () => {
    load("DOCUMENT", "docx");
    const e = press("ś", "KeyS", { ctrl: true, alt: true, altGr: true, typing: true });
    expect(e.defaultPrevented).toBe(false);
    expect(saveDoc).not.toHaveBeenCalled();
  });

  it("German AltGr+M (µ) in the document body is not Ctrl+Alt+M 새 메모", () => {
    load("DOCUMENT", "docx");
    const e = press("µ", "KeyM", { ctrl: true, alt: true, altGr: true, typing: true });
    expect(e.defaultPrevented).toBe(false);
    expect(startComment).not.toHaveBeenCalled();
  });

  it("Mac Option+Q (œ) and 한글 Option+S (ß) in a field type their character; outside a field Option+Q is command search", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    load("DOCUMENT", "docx");
    expect(press("œ", "KeyQ", { alt: true, typing: true }).defaultPrevented).toBe(false);
    expect(useUI.getState().shellDialog).toBeNull();
    load("DOCUMENT", "hwpx");
    expect(press("ß", "KeyS", { alt: true, typing: true }).defaultPrevented).toBe(false);
    expect(saveDoc).not.toHaveBeenCalled();
    load("DOCUMENT", "docx");
    press("œ", "KeyQ", { alt: true });
    expect(useUI.getState().shellDialog).toBe("palette");
  });

  it("Windows Alt+Q opens command search also while typing — with the Korean IME too", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    load("DOCUMENT", "docx");
    expect(press("q", "KeyQ", { alt: true, typing: true }).defaultPrevented).toBe(true);
    expect(useUI.getState().shellDialog).toBe("palette");
    useUI.getState().set({ shellDialog: null });
    press("ㅂ", "KeyQ", { alt: true, typing: true });
    expect(useUI.getState().shellDialog).toBe("palette");
  });
});

describe("cleared keys change nothing", () => {
  it("Word Ctrl+D / Ctrl+J / Ctrl+G with an object selected leave the document as it is", () => {
    load("DOCUMENT", "docx");
    const before = JSON.stringify(S().doc);
    for (const [key, code] of [["d", "KeyD"], ["j", "KeyJ"], ["g", "KeyG"], ["t", "KeyT"]]) press(key, code, { ctrl: true });
    expect(JSON.stringify(S().doc)).toBe(before);
  });
});
