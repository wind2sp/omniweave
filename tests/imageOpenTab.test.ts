// Opening a picture (integration of the image/design modes with the document tabs): File ▸ Open of a PNG opens it as
// a canvas of its own size in a tab of its own (the untouched new-document tab is reused), while Insert ▸ Picture
// and dropping onto the canvas (`place`) still put it on the current page — at the caret when typing in a body.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftPage, useStore } from "../src/core/store";
import { activeSessionId, isPristineActive, resetSessionsForTest, sessionDoc, useSessions } from "../src/core/sessions";
import { newDocument, newText } from "../src/core/types";
import { importFile, openInTab } from "../src/ui/actions";
import { docHooks } from "../src/ui/editModes";
import "../src/ui/tabs";

const S = () => useStore.getState();
const tabs = () => useSessions.getState().tabs;

/** Smallest PNG the size sniffer reads: signature + IHDR (width, height). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}
const file = (name: string, w = 120, h = 80) => ({ name, path: null, bytes: png(w, h) });

beforeEach(() => {
  S().load(newDocument());
  resetSessionsForTest();
});
afterEach(() => {
  docHooks.insertInline = null;
});

describe("opening a picture", () => {
  it("reuses the untouched new-document tab: one canvas page of the picture's size", async () => {
    const a = activeSessionId();
    expect(isPristineActive()).toBe(true);
    const pages = await importFile(file("photo.png", 120, 80));
    expect(tabs()).toHaveLength(1);
    expect(activeSessionId()).toBe(a);
    expect(pages).toHaveLength(1);
    expect(S().doc.pages).toHaveLength(1);
    expect([S().doc.pages[0].width, S().doc.pages[0].height]).toEqual([120, 80]);
    expect(S().doc.pages[0].source?.format).toBe("png");
    expect(isPristineActive()).toBe(false); // claimed: the next picture gets a tab of its own
  });

  it("opens in a new tab when the active document is in use, leaving that document alone", async () => {
    const a = activeSessionId();
    const t = newText("keep me");
    S().commit("text", (d) => void draftPage(d, S().pageId)!.nodes.push(t as any));
    const before = S().doc;
    await importFile(file("second.png", 64, 32));
    expect(tabs()).toHaveLength(2);
    expect(activeSessionId()).not.toBe(a);
    expect(S().doc.pages).toHaveLength(1);
    expect(S().doc.pages[0].width).toBe(64);
    expect(sessionDoc(a)).toBe(before);
  });

  it("Insert ▸ Picture / drop (`place`) puts it on the current page of the same tab", async () => {
    const page = S().doc.pages[0];
    const n0 = page.nodes.length;
    await importFile(file("logo.png"), { place: true });
    expect(tabs()).toHaveLength(1);
    expect(S().doc.pages).toHaveLength(1);
    expect(S().doc.pages[0].nodes.length).toBe(n0 + 1);
    expect(S().doc.pages[0].nodes.at(-1)?.type).toBe("IMAGE");
  });

  it("a file opened into a tab of its own is clean: no undo step, no 'save changes?' (openInTab)", async () => {
    const t = newText("busy");
    S().commit("text", (d) => void draftPage(d, S().pageId)!.nodes.push(t as any));
    const a = activeSessionId();
    await openInTab(file("clean.png", 50, 40));
    expect(activeSessionId()).not.toBe(a);
    expect(S().dirty).toBe(false);
    expect(S().past).toHaveLength(0);
    expect(tabs().find((x) => x.id === activeSessionId())?.dirty).toBeFalsy();
    expect(S().doc.pages[0].width).toBe(50);
    // the first tab keeps its own edit
    expect(tabs().find((x) => x.id === a)?.dirty).toBe(true);
  });

  it("`place` while typing in a document body goes in at the caret (흐름 2단계 그림 글자처럼)", async () => {
    let got: string | null = null;
    docHooks.insertInline = (n) => ((got = n.type), true);
    const n0 = S().doc.pages[0].nodes.length;
    await importFile(file("inline.png"), { place: true });
    expect(got).toBe("IMAGE");
    expect(S().doc.pages[0].nodes.length).toBe(n0);
  });
});
