import { beforeEach, describe, expect, it } from "vitest";
import { cancelPreview, clearHistory, historyStats, previewEntry, recordHistory, restoreEntry, useHistory } from "../src/core/history";
import { makeTile } from "../src/core/loom";
import { draftPage, useStore } from "../src/core/store";
import { TILE, newDocument, newText } from "../src/core/types";
import { packOmw, unpackOmw } from "../src/io/omw";

const S = () => useStore.getState();
const H = () => useHistory.getState();
const tile = (v: number) => {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  d.fill(v);
  return makeTile(d);
};

function addText(t: string) {
  const n = newText(t);
  S().commit(`텍스트 ${t}`, (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
  return n;
}

beforeEach(() => {
  H().set({ recording: true, includeInFile: true });
  S().load(newDocument("히스토리"));
});

describe("history timeline", () => {
  it("records every command from the start and merges rapid repeats", () => {
    expect(H().entries.map((e) => e.label)).toEqual(["열기"]);
    addText("a");
    addText("b");
    const n = addText("c");
    expect(H().entries).toHaveLength(4);
    // three quick moves of the same kind become one entry
    for (let i = 0; i < 3; i++) S().commit("이동", (d) => void (draftPage(d, S().pageId)!.nodes.find((x) => x.id === n.id)!.transform.x += 5));
    expect(H().entries).toHaveLength(5);
    expect(H().entries[4].label).toBe("이동");
  });

  it("previews a past state without changing the document, then restores it as one undoable step", () => {
    addText("a");
    const afterA = S().doc;
    addText("b");
    const current = S().doc;
    const target = H().entries.find((e) => e.label === "텍스트 a")!;
    previewEntry(target.id);
    expect(S().doc).toBe(afterA);
    cancelPreview();
    expect(S().doc).toBe(current);
    restoreEntry(target.id);
    expect(S().doc).toBe(afterA);
    expect(H().entries[H().entries.length - 1].label).toMatch(/^히스토리 복원/);
    S().undo();
    expect(S().doc).toBe(current);
  });

  it("editing during preview restores first, then applies the edit", () => {
    addText("a");
    addText("b");
    const target = H().entries.find((e) => e.label === "텍스트 a")!;
    previewEntry(target.id);
    addText("c");
    const texts = S().doc.pages[0].nodes.filter((n) => n.type === "TEXT").length;
    expect(texts).toBe(2); // a + c, b was not there at that time
    expect(H().previewId).toBeNull();
  });

  it("clear history keeps the document and restarts the log", () => {
    addText("a");
    addText("b");
    const doc = S().doc;
    clearHistory();
    expect(S().doc).toBe(doc);
    expect(H().entries).toHaveLength(1);
  });

  it("is stored in .omw history/ with shared threads and survives a round trip", () => {
    const shared = tile(9);
    S().commit("타일", (d) => void ((draftPage(d, S().pageId)!.nodes[0] as any).tiles = { "0_0": shared }));
    for (let i = 0; i < 20; i++) addText(`문단 ${i}`);
    const withHist = packOmw(S().doc, H().entries);
    const without = packOmw(S().doc, []);
    expect(withHist.stats.historyEntries).toBe(H().entries.length);
    expect(withHist.stats.tiles).toBe(without.stats.tiles); // pixel tile stored once for doc + all history
    // 22 history steps cost only a few KB on top of the document
    expect(withHist.bytes.length - without.bytes.length).toBeLessThan(16 * 1024);
    const back = unpackOmw(withHist.bytes);
    expect(back.report.historySkipped).toBe(0);
    expect(back.history.map((e) => e.root)).toEqual(H().entries.map((e) => e.root));
    expect(back.history[3].doc.pages[0].nodes.length).toBe(H().entries[3].doc.pages[0].nodes.length);
    expect(unpackOmw(without.bytes).history).toHaveLength(0);
  });

  it("stats count shared nodes once", () => {
    for (let i = 0; i < 5; i++) addText(`x${i}`);
    const st = historyStats(H().entries);
    expect(st.entries).toBe(6);
    expect(st.nodes).toBe(6); // raster layer + 5 texts, not 1+2+3+4+5+...
  });

  it("does nothing when recording is off", () => {
    H().set({ recording: false });
    addText("a");
    expect(H().entries).toHaveLength(1);
    recordHistory(S().doc, "x");
    expect(H().entries).toHaveLength(1);
  });
});
