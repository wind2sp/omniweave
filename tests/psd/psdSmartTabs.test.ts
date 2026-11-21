// '고급 개체 열기' with document tabs (ui/smartObject.ts): the smart object's content opens in a tab of its own; Ctrl+S
// there puts it back into the parent (one undo step there, no file written); the parent's PSD save keeps it a smart
// object with the new content. A linked smart object does not open (its path is said).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTile } from "../../src/core/tile";
import { activeSessionId, resetSessionsForTest, sessionDoc, switchTo, tabMeta } from "../../src/core/sessions";
import { currentPage, useStore } from "../../src/core/store";
import type { RasterNode } from "../../src/core/types";
import { openInTab, saveDoc } from "../../src/ui/actions";
import { openSmartObject, smartLinkOf, smartTarget } from "../../src/ui/smartObject";
import { parsePsdLayout, recordName } from "../../src/io/formats/psd";
import { linkedFiles, readPlaced } from "../../src/io/formats/psdSmart";
import { writePsd } from "../../src/io/formats/psdWrite";

const FID = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));
const S = () => useStore.getState();
const smart = () => currentPage()!.nodes.find((n): n is RasterNode => n.type === "RASTER" && !!n.psdSmart)!;

describe("smart object contents in a tab of their own", () => {
  beforeEach(() => resetSessionsForTest());

  it("opens, edits, puts back on save, and the parent saves it as a smart object", async () => {
    await openInTab({ name: "omni-fid-smart-embedded.psd", path: null, bytes: read("omni-fid-smart-embedded.psd") });
    const parent = activeSessionId();
    const node = smart();
    S().set({ selection: [node.id] });
    expect(smartTarget()?.id).toBe(node.id);
    expect(await openSmartObject()).toBe(true);
    const child = activeSessionId();
    expect(child).not.toBe(parent);
    expect(smartLinkOf()).toMatchObject({ parent, nodeId: node.id, content: "psb", w: 174, h: 126 });
    expect([currentPage()!.width, currentPage()!.height]).toEqual([174, 126]);
    // opening it again brings the same tab forward
    switchTo(parent);
    S().set({ selection: [node.id] });
    expect(await openSmartObject()).toBe(true);
    expect(activeSessionId()).toBe(child);
    // paint in the content
    const page = currentPage()!;
    const layer = page.nodes.find((n): n is RasterNode => n.type === "RASTER" && n.id !== page.source?.psd?.compositeNode && Object.keys(n.tiles).length > 0)!;
    const key = Object.keys(layer.tiles)[0];
    const data = new Uint8ClampedArray(layer.tiles[key].data);
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) data.set([0, 0, 255, 255], (y * 256 + x) * 4);
    S().commit("paint", (d) => {
      const p = d.pages[0];
      p.nodes = p.nodes.map((n) => (n.id === layer.id ? { ...layer, tiles: { ...layer.tiles, [key]: makeTile(data) } } : n));
    });
    expect(S().dirty).toBe(true);
    await saveDoc();
    // put back: the content tab is clean, the parent has one more undo step and is unsaved
    expect(S().dirty).toBe(false);
    expect(tabMeta(parent)!.dirty).toBe(true);
    const pdoc = sessionDoc(parent)!;
    const pnode = pdoc.pages[0].nodes.find((n) => n.id === node.id) as RasterNode;
    expect(pnode.psdSmart!.edited).toBeDefined();
    expect(pdoc.assets[pnode.psdSmart!.edited!.assetId]).toBeDefined();
    switchTo(parent);
    expect(S().past.at(-1)?.label).toContain("고급 개체");
    const out = await writePsd(S().doc, currentPage()!);
    const L = parsePsdLayout(out.bytes);
    const rec = L.records.find((r) => recordName(out.bytes, r) === "omni-smart embedded")!;
    expect(readPlaced(out.bytes, rec)).not.toBeNull();
    const f = linkedFiles(L)[0];
    expect(f.data!.end - f.data!.start).toBeGreaterThan(1000);
    // undo in the parent brings Photoshop's layer back (and its unedited save)
    S().undo();
    expect((await writePsd(S().doc, currentPage()!)).method).toBe("original");
  });

  it("a linked smart object does not open; its path is said", async () => {
    await openInTab({ name: "omni-fid-smart-linked.psd", path: null, bytes: read("omni-fid-smart-linked.psd") });
    const node = smart();
    S().set({ selection: [node.id] });
    expect(smartTarget()).toBeNull();
    const before = activeSessionId();
    expect(await openSmartObject(node.id)).toBe(false);
    expect(activeSessionId()).toBe(before);
  });
});
