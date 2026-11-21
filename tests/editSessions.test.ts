// QA (A조, 2026-11-11): edit sessions that hold state across other edits — Ctrl+T transform session,
// crop session — plus page-level fixes found in review (scaleY on page resize, page ids on insert).
import { beforeEach, describe, expect, it } from "vitest";
import { resizePageInPlace } from "../src/core/pages";
import { draftPage, useStore } from "../src/core/store";
import { newDocument, newImage, newPage, newText, newVector } from "../src/core/types";
import { rectContour } from "../src/core/vector";
import { packOmw } from "../src/io/omw";
import { importFile, lastImport } from "../src/ui/actions";
import { applyCrop, cancelCrop, startCrop, useCrop } from "../src/ui/cropTool";
import { endTransformSession, startTransformSession, useXform } from "../src/ui/xform";

const S = () => useStore.getState();
const page = () => S().doc.pages[0];

function setup() {
  const doc = newDocument("세션");
  const p = newPage("DESIGN", 800, 600, "A");
  const img = newImage("asset", 400, 200, "img");
  img.transform = { x: 10, y: 10, rotation: 0, scale: 1 };
  const box = newVector([rectContour(0, 0, 50, 50)], "box");
  box.transform = { x: 500, y: 300, rotation: 0, scale: 1 };
  p.nodes.push(img as any, box as any);
  doc.pages = [p];
  S().load(doc);
  return { img: img.id, box: box.id };
}

beforeEach(() => {
  useXform.getState().set({ session: null, readout: null });
  if (useCrop.getState().id) cancelCrop();
});

describe("Ctrl+T transform session does not outlive its selection", () => {
  it("Esc after the selection was cleared and other work was done does not undo that work", () => {
    const { box } = setup();
    S().set({ selection: [box] });
    startTransformSession();
    expect(useXform.getState().session).toBe(0);
    // the user clicks away and keeps working without pressing Enter
    S().set({ selection: [] });
    S().commit("other 1", (d) => void (draftPage(d, S().pageId)!.name = "B"));
    S().commit("other 2", (d) => void (draftPage(d, S().pageId)!.name = "C"));
    // Esc (deselect) must not run the session's cancel
    expect(endTransformSession(true)).toBe(false);
    expect(page().name).toBe("C");
    expect(S().past.length).toBe(2);
  });

  it("opening another document ends the session", () => {
    const { box } = setup();
    S().set({ selection: [box] });
    S().commit("move", (d) => void (draftPage(d, S().pageId)!.nodes[1].transform.x = 1));
    startTransformSession();
    setup();
    expect(useXform.getState().session).toBe(null);
  });

  it("Esc inside a live session still undoes every step made since", () => {
    const { box } = setup();
    S().set({ selection: [box] });
    startTransformSession();
    S().commit("크기 조절", (d) => void (draftPage(d, S().pageId)!.nodes[1].transform.scale = 2));
    S().commit("회전", (d) => void (draftPage(d, S().pageId)!.nodes[1].transform.rotation = 30));
    expect(endTransformSession(true)).toBe(true);
    expect(page().nodes[1].transform).toMatchObject({ scale: 1, rotation: 0 });
  });
});

describe("crop session and other edits", () => {
  it("a commit made while cropping keeps both the crop and that edit, each one undo step", () => {
    const { img, box } = setup();
    S().set({ selection: [img] });
    startCrop();
    expect(useCrop.getState().id).toBe(img);
    useCrop.getState().set({ rect: { x: 0, y: 0, w: 200, h: 100 } });
    // e.g. a menu command / property field while the crop box is up
    S().commit("이동", (d) => void (draftPage(d, S().pageId)!.nodes.find((n) => n.id === box)!.transform.x = 77));
    expect(useCrop.getState().id).toBe(null);
    const n = page().nodes.find((x) => x.id === img) as any;
    expect(n.crop).toEqual({ x: 0, y: 0, w: 200, h: 100 });
    expect(page().nodes.find((x) => x.id === box)!.transform.x).toBe(77);
    expect(S().past.map((p) => p.label)).toEqual(["자르기", "이동"]);
    S().undo();
    S().undo();
    expect((page().nodes.find((x) => x.id === img) as any).crop).toBeUndefined();
  });

  it("undo while cropping cancels the crop first and never leaves a gesture open", () => {
    const { img } = setup();
    S().commit("name", (d) => void (draftPage(d, S().pageId)!.name = "B"));
    S().set({ selection: [img] });
    startCrop();
    useCrop.getState().set({ rect: { x: 0, y: 0, w: 100, h: 100 } });
    S().undo();
    expect(useCrop.getState().id).toBe(null);
    expect(S().gestureBase).toBe(null);
    expect(page().name).toBe("A");
    expect((page().nodes.find((x) => x.id === img) as any).crop).toBeUndefined();
  });

  it("a slider gesture (beginGesture) while cropping applies the crop first", () => {
    const { img, box } = setup();
    S().set({ selection: [img] });
    startCrop();
    useCrop.getState().set({ rect: { x: 0, y: 0, w: 100, h: 100 } });
    S().beginGesture();
    S().updateGesture((d) => void (draftPage(d, S().pageId)!.nodes.find((n) => n.id === box)!.opacity = 0.5));
    S().endGesture("불투명도");
    expect((page().nodes.find((x) => x.id === img) as any).crop).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(S().past.map((p) => p.label)).toEqual(["자르기", "불투명도"]);
  });

  it("Enter still applies as one step", () => {
    const { img } = setup();
    S().set({ selection: [img] });
    startCrop();
    useCrop.getState().set({ rect: { x: 0, y: 0, w: 100, h: 100 } });
    applyCrop();
    expect(S().past.map((p) => p.label)).toEqual(["자르기"]);
  });
});

describe("page resize with content keeps non-uniform objects in proportion", () => {
  it("scales scaleY together with scale", () => {
    const p = newPage("DESIGN", 100, 100, "p");
    const v = newVector([rectContour(0, 0, 10, 10)]);
    v.transform = { x: 0, y: 0, rotation: 0, scale: 2, scaleY: 3 };
    p.nodes.push(v as any);
    resizePageInPlace(p, 50, 50, true);
    expect(v.transform.scale).toBeCloseTo(1);
    expect(v.transform.scaleY).toBeCloseTo(1.5);
  });
});

describe("inserting pages of an .omw keeps page and object ids unique", () => {
  it("inserting the open document's own file twice gives every page and object its own id", async () => {
    const doc = newDocument("self");
    const p = newPage("DESIGN", 800, 600, "A");
    const t = newText("hello");
    p.nodes.push(newVector([rectContour(0, 0, 5, 5)]) as any, t as any);
    p.animations.push({ id: "an_1", targetNodeId: t.id } as any);
    doc.pages = [p];
    S().load(doc);
    S().commit("touch", (d) => void (d.title = "self"));
    const bytes = packOmw(S().doc).bytes;
    const a = await importFile({ name: "self.omw", path: null, bytes }, { at: 1 });
    const b = await importFile({ name: "self.omw", path: null, bytes }, { at: 0 });
    expect(lastImport?.error).toBeUndefined();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    const ids = S().doc.pages.map((x) => x.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    const nodeIds = S().doc.pages.flatMap((x) => x.nodes.map((n) => n.id));
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
    // references follow the renamed object
    for (const pg of S().doc.pages) expect(pg.nodes.some((n) => n.id === pg.animations[0].targetNodeId)).toBe(true);
    // the returned pages are the ones in the document
    expect(ids).toContain(a[0].id);
  });
});
