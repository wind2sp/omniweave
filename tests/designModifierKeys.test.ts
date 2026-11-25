// 2026-11-24, the owner's check of the PC installer: an .ai opened as a PDF screen (승격 needed), and Ctrl / Alt with
// the mouse — copy by dragging, transform, paste in the same place on the same artboard — did nothing. Illustrator's
// keys in the design mode: Alt+drag / Alt+arrow copies, Ctrl+D Transform Again, Ctrl+F / Ctrl+B Paste in Front / in
// Back, Ctrl+Shift+V in place, Ctrl+Alt+Shift+V on all artboards.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newVector, type Page, type VectorNode } from "../src/core/types";
import { corner } from "../src/core/vector";
import { copySelection, pasteClipboard, pasteOnAllArtboards } from "../src/ui/menuActions";
import { copiesOf, lastMove, moveSelection, placeCopies, recordMove, transformAgain } from "../src/ui/transformAgain";
import { resolveBinding } from "../src/ui/keymap";
import { command } from "../src/ui/commands";
import { isPdfFormatPage } from "../src/ui/editModes";

const S = () => useStore.getState();

function rect(name: string, x: number, y: number, fill: string): VectorNode {
  const v = newVector([{ closed: true, nodes: [corner(x, y), corner(x + 100, y), corner(x + 100, y + 100), corner(x, y + 100)] }], name);
  v.fill = fill;
  return v;
}

function design(pages = 1): Page[] {
  const doc = newDocument();
  doc.pages = Array.from({ length: pages }, (_, i) => {
    const p = newPage("DESIGN", 800, 600, `아트보드 ${i + 1}`);
    if (i === 0) p.nodes.push(rect("omni-A", 50, 50, "#e63946"), rect("omni-B", 350, 250, "#2a9d8f"), rect("omni-C", 600, 400, "#457b9d"));
    return p;
  });
  S().load(doc);
  S().set({ pageId: doc.pages[0].id, selection: [], mode: "DESIGN" });
  return doc.pages;
}
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;
const fills = () => page().nodes.map((n) => (n as VectorNode).fill);

describe("Illustrator keys of the design mode", () => {
  it("the key table gives Ctrl+D / Ctrl+F / Ctrl+B / Ctrl+Alt+Shift+V to Illustrator's commands there (Word keeps its own)", () => {
    expect(resolveBinding("DESIGN", "Ctrl+D")?.cmd).toBe("edit.transformAgain");
    expect(resolveBinding("DESIGN", "Ctrl+F")?.cmd).toBe("edit.pasteInFront");
    expect(resolveBinding("DESIGN", "Ctrl+B")?.cmd).toBe("edit.pasteInBack");
    expect(resolveBinding("DESIGN", "Ctrl+Alt+Shift+V")?.cmd).toBe("edit.pasteOnAllArtboards");
    expect(resolveBinding("DESIGN", "Ctrl+Shift+V")?.cmd).toBe("edit.pasteInPlace");
    expect(resolveBinding("WORD", "Ctrl+F")?.cmd).toBe("edit.find");
    expect(resolveBinding("WORD", "Ctrl+B")?.cmd).toBe("text.bold");
    expect(resolveBinding("IMAGE", "Ctrl+D")?.cmd).toBe("act.pixel.deselect");
  });

  it("Alt+arrow copies (the original stays), Ctrl+D repeats the copy-and-move", () => {
    design();
    S().set({ selection: [page().nodes[0].id] });
    moveSelection(10, 0, true);
    expect(fills()).toEqual(["#e63946", "#e63946", "#2a9d8f", "#457b9d"]);
    expect(page().nodes[0].transform.x).toBe(0);
    expect(page().nodes[1].transform.x).toBe(10);
    expect(lastMove()).toEqual({ dx: 10, dy: 0, copy: true });
    expect(transformAgain()).toBe(true);
    expect(page().nodes.length).toBe(5);
    expect(page().nodes[2].transform.x).toBe(20);
    expect(S().past.at(-1)?.label).toBe("변형 반복");
  });

  it("an Alt+drag's copies sit right above their originals at every step of the drag", () => {
    const [p] = design();
    const made = copiesOf(S().doc, p.id, [p.nodes[1].id]);
    expect(made.length).toBe(1);
    const nodes = [...p.nodes];
    placeCopies(nodes, made.map((m) => m.node), Object.fromEntries(made.map((m) => [m.node.id, m.orig])));
    expect(nodes.map((n) => n.name)).toEqual(["omni-A", "omni-B", "omni-B", "omni-C"]);
    // the original keeps its own transform object
    expect(nodes[2].transform).not.toBe(nodes[1].transform);
  });

  it("Ctrl+D after a plain move moves again; with nothing moved yet it does nothing", () => {
    design();
    S().set({ selection: [page().nodes[2].id] });
    recordMove(0, 0, false);
    moveSelection(0, -25, false);
    transformAgain();
    expect(page().nodes[2].transform.y).toBe(-50);
    expect(page().nodes.length).toBe(3);
  });

  it("Paste in Front / in Back go right above / below the selection in the same place; in place keeps the position", () => {
    design();
    S().set({ selection: [page().nodes[0].id] });
    expect(copySelection()).toBe(1);
    S().set({ selection: [page().nodes[1].id] });
    pasteClipboard(false, "front");
    expect(fills()).toEqual(["#e63946", "#2a9d8f", "#e63946", "#457b9d"]);
    expect(page().nodes[2].transform).toEqual(page().nodes[0].transform);
    S().set({ selection: [page().nodes[1].id] });
    pasteClipboard(false, "back");
    expect(fills()).toEqual(["#e63946", "#e63946", "#2a9d8f", "#e63946", "#457b9d"]);
    pasteClipboard(true);
    expect(page().nodes.at(-1)!.transform.x).toBe(0);
  });

  it("Paste on All Artboards puts the copy in place on every artboard", () => {
    const pages = design(3);
    S().set({ selection: [page().nodes[2].id] });
    copySelection();
    expect(pasteOnAllArtboards()).toBe(3);
    expect(S().doc.pages.map((p) => p.nodes.length)).toEqual([4, 1, 1]);
    expect(S().doc.pages[1].nodes[0].name).toBe("omni-C");
    expect(pages.length).toBe(3);
  });
});

describe("an .ai is a design, not a PDF screen", () => {
  it("its pages are not PDF-format pages and 'PDF 텍스트 편집 (승격)' is not offered on them", () => {
    const doc = newDocument();
    const p = newPage("PDF", 800, 533, "omni-store-design");
    p.source = { format: "ai", name: "omni-store-design.ai" };
    doc.pages = [p];
    S().load(doc);
    S().set({ pageId: p.id, mode: "AUTO" });
    expect(isPdfFormatPage(p)).toBe(false);
    expect(command("text.editPdf")!.when!()).toBe(false);
    const q = { ...p, source: { format: "pdf", name: "omni.pdf" } };
    expect(isPdfFormatPage(q)).toBe(true);
  });
});
