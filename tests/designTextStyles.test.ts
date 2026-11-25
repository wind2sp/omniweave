// 2026-11-24, features-ps-ai.md (Illustrator Character / Paragraph Styles): a style made from the selected text,
// applied to other text, redefined (every text using it follows), deleted (the text keeps its look).
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newText, type TextNode } from "../src/core/types";
import { applyStyle, currentStyleId, deleteStyle, newStyle, redefineStyle, renameStyle, stylesOf } from "../src/ui/textStyles";

const S = () => useStore.getState();
const texts = () => S().doc.pages[0].nodes as TextNode[];

function setup() {
  const doc = newDocument();
  const p = newPage("DESIGN", 800, 600, "아트보드 1");
  const a = newText("제목", 300, { fontSize: 40, bold: true, color: "#e63946" });
  a.paragraphs[0].align = "CENTER";
  const b = newText("본문", 300, { fontSize: 14 });
  const c = newText("다른 본문", 300, { fontSize: 14 });
  p.nodes.push(a, b, c);
  doc.pages = [p];
  S().load(doc);
  S().set({ pageId: p.id, selection: [a.id], mode: "DESIGN" });
  return [a, b, c];
}

describe("character and paragraph styles", () => {
  it("a character style from the selection applies its run look to other text", () => {
    const [, b, c] = setup();
    const id = newStyle("char")!;
    expect(stylesOf(S().doc).char[0].name).toMatch(/1$/);
    S().set({ selection: [b.id, c.id] });
    expect(applyStyle("char", id)).toBe(2);
    const r = texts()[1].paragraphs[0].runs[0];
    expect([r.fontSize, r.bold, r.color, r.text]).toEqual([40, true, "#e63946", "본문"]);
    expect(currentStyleId("char")).toBe(id);
  });

  it("a paragraph style carries the alignment; redefining updates every text that uses it", () => {
    const [a, b] = setup();
    const id = newStyle("para")!;
    S().set({ selection: [b.id] });
    applyStyle("para", id);
    expect(texts()[1].paragraphs[0].align).toBe("CENTER");
    // redefine from a 20 px left-aligned text: the title (not linked) stays, the linked body follows
    S().commit("t", (d) => {
      const n = d.pages[0].nodes[2] as TextNode;
      n.paragraphs[0].align = "LEFT";
      n.paragraphs[0].runs[0].fontSize = 20;
    });
    S().set({ selection: [texts()[2].id] });
    redefineStyle("para", id);
    expect(texts()[1].paragraphs[0].align).toBe("LEFT");
    expect(texts()[1].paragraphs[0].runs[0].fontSize).toBe(20);
    expect(texts()[0].paragraphs[0].align).toBe("CENTER");
    expect(texts()[0].id).toBe(a.id);
  });

  it("rename and delete: the text keeps its look and loses the link", () => {
    const [, b] = setup();
    const id = newStyle("char")!;
    renameStyle("char", id, "  강조  ");
    expect(stylesOf(S().doc).char[0].name).toBe("강조");
    S().set({ selection: [b.id] });
    applyStyle("char", id);
    deleteStyle("char", id);
    expect(stylesOf(S().doc).char.length).toBe(0);
    const r = texts()[1].paragraphs[0].runs[0];
    expect(r.fontSize).toBe(40);
    expect(r.charStyle).toBeUndefined();
  });
});
