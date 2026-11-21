// Body flow polish (QA-DOCFLOW1 leftovers): the caret goes to what undo changed; a click below the picture that
// ends the body puts the caret after it, and only typing makes the paragraph there (an untouched file keeps its end).
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { gatherStory, reflowPages, segmentAt } from "../src/core/flow";
import { bodyBox } from "../src/core/pageSetup";
import { newDocument, newImage, newPage, newText, type TextNode } from "../src/core/types";
import { attachInput, beginTyping, changedAt, flowPointerDown, onInput, tailCaret, useFlow } from "../src/ui/docFlow";
import { startEditModes } from "../src/ui/editModes";

const S = () => useStore.getState();
const P = (s: string) => ({ id: s, runs: [{ text: s }] }) as never;

function type(text: string) {
  attachInput({ value: text, blur() {}, focus() {} } as unknown as HTMLTextAreaElement);
  onInput({} as Event);
}

describe("changedAt (caret after undo / redo)", () => {
  it("at the end of what changed", () => {
    expect(changedAt([P("XabcY")], [P("XY")])).toEqual({ p: 0, o: 1 });
    expect(changedAt([P("XY")], [P("XabcY")])).toEqual({ p: 0, o: 4 });
    expect(changedAt([P("a"), P("b")], [P("a"), P("b"), P("new")])).toEqual({ p: 2, o: 3 });
    expect(changedAt([P("same")], [P("same")])).toBeNull();
  });
});

describe("a body that ends with a picture", () => {
  beforeEach(() => {
    startEditModes();
    const doc = newDocument();
    const p = newPage("DOCUMENT", 794, 1123, "p");
    const box = bodyBox(p);
    const t = newText("본문", box.w);
    t.flow = true;
    t.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
    const img = newImage("as-x", 300, 200, "pic");
    img.flow = true;
    img.transform = { x: box.x, y: box.y + 1, rotation: 0, scale: 1 };
    p.nodes.push(t, img);
    doc.pages = reflowPages([p]);
    S().load(doc);
    S().set({ mode: "DOCUMENT" });
  });

  it("a click below it waits after it; nothing is added until typing; typing adds the paragraph after the picture", () => {
    const before = S().doc;
    const page = before.pages[0];
    const img = page.nodes.find((n) => n.type === "IMAGE")!;
    beginTyping(page.id);
    expect(flowPointerDown(page, 200, img.transform.y + 260, { detail: 1, shift: false })).toBe(true);
    expect(useFlow.getState().tail).toBe(true);
    expect(tailCaret()!.y).toBeGreaterThan(img.transform.y + 199);
    expect(S().doc).toBe(before);
    type("끝");
    const st = gatherStory(S().doc.pages, segmentAt(S().doc.pages, 0));
    expect(st.paras.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["본문", "끝"]);
    expect(st.objs.find((o) => o.node.id === img.id)!.before).toBe(st.paras[1].id);
    expect(S().past).toHaveLength(1);
    // one undo: the file's end as it was
    S().undo();
    expect(S().doc).toBe(before);
    expect((S().doc.pages[0].nodes.find((n) => n.type === "TEXT") as TextNode).paragraphs).toHaveLength(1);
  });
});
