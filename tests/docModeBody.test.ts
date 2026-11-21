// Choosing 문서 on a page without a body (a picture or design page from the start screen) makes the editing a
// document's: an empty body flow with the caret on its first line (EDIT_MODES.md 6). Nothing typed and the mode
// left → no trace (document and history as before); typed → one undo returns the page as it was. Round trips
// document → design → document keep the flow as it is.
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { isFlowPageAt } from "../src/core/flow";
import { bodyBox } from "../src/core/pageSetup";
import { newDocument, newImage, newPage, newText, type OmwDocument, type TextNode } from "../src/core/types";
import { startEditModes } from "../src/ui/editModes";
import { attachInput, flowActive, onInput, useFlow } from "../src/ui/docFlow";

const S = () => useStore.getState();
/** typing into the hidden input the body editor listens to (ui/FlowEditor.tsx) */
function type(text: string) {
  const el = { value: text, blur() {}, focus() {} } as unknown as HTMLTextAreaElement;
  attachInput(el);
  onInput({} as Event);
}

function photoDoc(w = 3000, h = 2000): OmwDocument {
  const doc = newDocument();
  const p = newPage("DESIGN", w, h, "photo");
  const img = newImage("as1", w, h, "photo.png");
  img.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  p.nodes.push(img);
  p.source = { format: "png", name: "photo.png" };
  doc.pages = [p];
  return doc;
}

beforeEach(() => {
  startEditModes();
  S().set({ mode: "AUTO" });
});

describe("문서 mode on a page without a body", () => {
  it("makes an empty body with the caret on its first line; leaving untouched leaves no trace", () => {
    const doc = photoDoc();
    S().load(doc);
    S().set({ mode: "DOCUMENT" });
    const pages = S().doc.pages;
    expect(pages[0].kind).toBe("DOCUMENT");
    expect(isFlowPageAt(pages, 0)).toBe(true);
    expect(flowActive()).toBe(true);
    expect(useFlow.getState().focus).toEqual({ p: 0, o: 0 });
    // the page keeps its size; margins scale with a big page; the picture stays, behind the text
    expect([pages[0].width, pages[0].height]).toEqual([3000, 2000]);
    expect(bodyBox(pages[0]).x).toBeGreaterThan(150);
    const img = pages[0].nodes.find((n) => n.type === "IMAGE")!;
    expect(img.type === "IMAGE" && img.place).toEqual({ mode: "float", wrap: "behind" });
    S().set({ mode: "DESIGN" });
    expect(S().doc).toBe(doc);
    expect(S().past).toHaveLength(0);
    expect(S().dirty).toBe(false);
  });

  it("while nothing is typed the document is not marked unsaved; the first letter marks it (integ-0117)", () => {
    S().load(photoDoc());
    S().set({ mode: "DOCUMENT" });
    expect(flowActive()).toBe(true);
    expect(S().dirty).toBe(false);
    type("가");
    expect(S().dirty).toBe(true);
    S().set({ mode: "AUTO" });
  });

  it("typed text stays; one undo returns the page as it was", () => {
    const doc = photoDoc();
    S().load(doc);
    S().set({ mode: "DOCUMENT" });
    type("가");
    type("나");
    const body = S().doc.pages[0].nodes.find((n) => n.type === "TEXT" && n.flow) as TextNode;
    expect(body.paragraphs[0].runs.map((r) => r.text).join("")).toBe("가나");
    S().set({ mode: "DESIGN" });
    expect(S().doc.pages[0].kind).toBe("DOCUMENT");
    // out of the 문서 edit mode the body is not typed in (one text box there)
    expect(flowActive()).toBe(false);
    S().undo();
    expect(S().doc).toBe(doc);
    expect(S().past).toHaveLength(0);
  });

  it("a paper-sized design page keeps the default margins; a single text box at the body place becomes the body", () => {
    const doc = newDocument();
    const p = newPage("DESIGN", 794, 1123, "a4");
    const box = bodyBox(p);
    const tb = newText("hello", box.w);
    tb.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
    p.nodes.push(tb);
    doc.pages = [p];
    S().load(doc);
    S().set({ mode: "DOCUMENT" });
    const pg = S().doc.pages[0];
    expect(pg.margins).toBeUndefined();
    const texts = pg.nodes.filter((n) => n.type === "TEXT") as TextNode[];
    expect(texts).toHaveLength(1);
    expect(texts[0].flow).toBe(true);
    expect(texts[0].transform.y).toBeCloseTo(box.y, 0);
  });

  it("a text box elsewhere stays a free object, the new body goes over it", () => {
    const doc = newDocument();
    const p = newPage("DESIGN", 1080, 1080, "post");
    const tb = newText("Title", 500);
    tb.transform = { x: 300, y: 400, rotation: 0, scale: 1 };
    p.nodes.push(tb);
    doc.pages = [p];
    S().load(doc);
    S().set({ mode: "DOCUMENT" });
    const nodes = S().doc.pages[0].nodes;
    expect(nodes.find((n) => n.id === tb.id)!.flow).toBeFalsy();
    expect(nodes.find((n) => n.id === tb.id)!.transform).toMatchObject({ x: 300, y: 400 });
    expect(nodes[nodes.length - 1].type === "TEXT" && nodes[nodes.length - 1].flow).toBe(true);
  });

  it("a flowing document round-trips through the other modes unchanged", () => {
    const doc = newDocument();
    const p = newPage("DOCUMENT", 794, 1123, "doc");
    const box = bodyBox(p);
    const b = newText("본문", box.w);
    b.flow = true;
    b.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
    p.nodes.push(b);
    doc.pages = [p];
    S().load(doc);
    const before = S().doc;
    for (const m of ["DOCUMENT", "DESIGN", "IMAGE", "SLIDE", "DOCUMENT", "AUTO"] as const) S().set({ mode: m });
    expect(S().doc).toBe(before);
    expect(S().past).toHaveLength(0);
  });

  it("자동 does not give a picture a body", () => {
    const doc = photoDoc();
    S().load(doc);
    S().set({ mode: "AUTO" });
    expect(S().doc).toBe(doc);
  });
});
