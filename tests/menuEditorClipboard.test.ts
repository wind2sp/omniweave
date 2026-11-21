// Edit → Cut / Copy / Paste from the menu bar while a text box is being edited: the menu bar no longer closes the
// editor, so these must act on the edited text (through the editor), never cut or paste whole objects.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ api: null as null | { focus: () => void; insertText: (s: string) => void } }));
vi.mock("../src/ui/RichTextEditor", async (orig) => ({ ...(await orig<typeof import("../src/ui/RichTextEditor")>()), richApi: () => fake.api }));

import { useStore } from "../src/core/store";
import { newDocument, newPage, newText } from "../src/core/types";
import { COMMANDS } from "../src/ui/commands";
import { clearClipboard, copySelection, hasClipboard } from "../src/ui/menuActions";

const S = () => useStore.getState();
const page = () => S().doc.pages[0];
const cmd = (id: string) => COMMANDS.find((c) => c.id === id)!;

describe("menu clipboard while editing text", () => {
  let focused = 0;
  let inserted: string[] = [];
  beforeEach(() => {
    const doc = newDocument("t");
    const p = newPage("DESIGN", 800, 600, "P");
    p.nodes = [newText("hello world"), newText("other")];
    doc.pages = [p];
    S().load(doc);
    clearClipboard();
    focused = 0;
    inserted = [];
    fake.api = null;
  });

  it("Cut / Copy leave the edited text box alone and hand the action to the editor", () => {
    const tx = page().nodes[0];
    S().set({ selection: [tx.id], editingTextId: tx.id });
    fake.api = { focus: () => void focused++, insertText: (s) => void inserted.push(s) };
    const past = S().past.length;
    cmd("edit.cut").run();
    cmd("edit.copy").run();
    expect(page().nodes.map((n) => n.id)).toContain(tx.id);
    expect(S().past.length).toBe(past);
    expect(hasClipboard()).toBe(false);
    expect(focused).toBe(2);
  });

  it("Paste does not drop copied objects into the page while text is edited", async () => {
    S().set({ selection: [page().nodes[1].id] });
    copySelection();
    const tx = page().nodes[0];
    S().set({ selection: [tx.id], editingTextId: tx.id });
    fake.api = { focus: () => void focused++, insertText: (s) => void inserted.push(s) };
    const n = page().nodes.length;
    cmd("edit.paste").run();
    cmd("edit.pasteInPlace").run();
    await new Promise((r) => setTimeout(r, 0));
    expect(page().nodes.length).toBe(n);
    expect(focused).toBe(2);
  });

  it("outside text editing the menu still cuts objects", () => {
    const tx = page().nodes[0];
    S().set({ selection: [tx.id] });
    cmd("edit.cut").run();
    expect(page().nodes.map((n) => n.id)).not.toContain(tx.id);
    expect(hasClipboard()).toBe(true);
  });
});
