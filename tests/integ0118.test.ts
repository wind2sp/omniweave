// integ-0118: keys shared by the merged branches stay in their own context. A sheet page (xlsx-dept) is a DOCUMENT
// page with a cell grid instead of a text body, so the document-body keys (Ctrl+Enter page break, Alt+Shift+Enter
// section break — and the notes keys of docx-pages-notes, Ctrl+Alt+F / D) are not offered there.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage } from "../src/core/types";
import { sheetPages } from "../src/io/sheet/book";
import { tableToSheet } from "../src/io/sheet/pages";
import { onDocumentPage } from "../src/ui/pageSetupActions";
import { inSheetGrid } from "../src/ui/sheet/sheetActions";
import { COMMANDS } from "../src/ui/commands";

const S = () => useStore.getState();
const cmd = (id: string) => COMMANDS.find((c) => c.id === id)!;

beforeEach(() => {
  const doc = newDocument();
  const sheet = sheetPages([tableToSheet("Sheet1", [[{ text: "a" }, { text: "1" }], [{ text: "b" }, { text: "2" }]], [72, 72])], "t.xlsx")[0];
  const text = newPage("DOCUMENT", 794, 1123, "doc");
  doc.pages = [sheet, text];
  S().load(doc);
  S().set({ mode: "AUTO" });
});

describe("document-body keys vs sheet grid", () => {
  it("a sheet page is not a document body: no page / section break, no footnote / endnote", () => {
    S().set({ pageId: S().doc.pages[0].id });
    expect(inSheetGrid()).toBe(true);
    expect(onDocumentPage()).toBe(false);
    for (const id of ["insert.pageBreak", "insert.sectionBreak", "insert.footnote", "insert.endnote"]) expect(cmd(id).when?.() ?? true).toBe(false);
    expect(cmd("sheet.next").when?.()).toBe(true);
  });

  it("an ordinary document page keeps them, and the sheet keys are gone", () => {
    S().set({ pageId: S().doc.pages[1].id });
    expect(inSheetGrid()).toBe(false);
    expect(onDocumentPage()).toBe(true);
    for (const id of ["insert.pageBreak", "insert.sectionBreak", "insert.footnote", "insert.endnote"]) expect(cmd(id).when?.()).toBe(true);
    expect(cmd("sheet.next").when?.()).toBe(false);
  });
});

describe("pen hint matches the pen (polish-2)", () => {
  it("Esc ends the path and keeps it (Illustrator), Ctrl+Z takes back a point: the hint says so in every language", () => {
    for (const l of ["ko", "en", "ja", "zh"]) {
      const hint: string = JSON.parse(readFileSync(`src/i18n/parts/ribbon/${l}.json`, "utf8"))["ribbon.shape.penHint"];
      expect(hint).toContain("Ctrl+Z");
      expect(hint).not.toMatch(/Esc (cancel|취소|キャンセル|取消)/);
    }
  });
});
