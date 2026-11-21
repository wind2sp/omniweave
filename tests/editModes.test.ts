// Edit modes (ui/editModes.ts): AUTO picks the way of editing from the page kind and the file it came from; an explicit
// work mode re-targets the page; the document mode scrolls through its pages (ui/docView.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newImage, newPage, newRaster, newVector, TILE } from "../src/core/types";
import { rectContour } from "../src/core/vector";
import { PROFILES, autoEditMode, currentEditMode, editModeOf, editUnit, hintEditMode, startEditModes, toolForKey, toolKeyAllowed } from "../src/ui/editModes";
import { docScroll, fitWidthView, neighbours, PAGE_GAP } from "../src/ui/docView";

const S = () => useStore.getState();

describe("AUTO edit mode", () => {
  it("follows the page kind", () => {
    expect(autoEditMode(newPage("DOCUMENT", 794, 1123))).toBe("DOCUMENT");
    expect(autoEditMode(newPage("PDF", 794, 1123))).toBe("DOCUMENT");
    expect(autoEditMode(newPage("SLIDE", 1280, 720))).toBe("SLIDE");
    expect(autoEditMode(newPage("DESIGN", 1920, 1080))).toBe("DESIGN");
  });
  it("follows the source format before the kind", () => {
    const psd = newPage("DESIGN", 800, 600);
    psd.source = { format: "psd", name: "a.psd" };
    expect(autoEditMode(psd)).toBe("IMAGE");
    const png = newPage("DOCUMENT", 794, 1123);
    png.source = { format: "image", name: "a.png" };
    expect(autoEditMode(png)).toBe("IMAGE");
    const pptx = newPage("SLIDE", 1280, 720);
    pptx.source = { format: "pptx", name: "a.pptx" };
    expect(autoEditMode(pptx)).toBe("SLIDE");
    const docx = newPage("DOCUMENT", 794, 1123);
    docx.source = { format: "docx", name: "a.docx" };
    expect(autoEditMode(docx)).toBe("DOCUMENT");
  });
  it("tells a picture from a vector design by content", () => {
    const painted = newPage("DESIGN", 400, 400);
    const r = newRaster();
    r.tiles["0_0"] = { data: new Uint8ClampedArray(TILE * TILE * 4) } as any;
    painted.nodes.push(r);
    expect(autoEditMode(painted)).toBe("IMAGE");
    const photo = newPage("DESIGN", 400, 400);
    photo.nodes.push(newImage("a", 380, 380));
    expect(autoEditMode(photo)).toBe("IMAGE");
    const vectors = newPage("DESIGN", 400, 400);
    for (let i = 0; i < 4; i++) vectors.nodes.push(newVector([rectContour(0, 0, 10, 10)]));
    photo.nodes.push(...vectors.nodes);
    expect(autoEditMode(photo)).toBe("DESIGN");
    expect(autoEditMode(newPage("DESIGN", 400, 400))).toBe("DESIGN");
  });
  it("takes a start-screen hint for a page", () => {
    const p = newPage("DESIGN", 3000, 2000);
    hintEditMode(p.id, "IMAGE");
    expect(autoEditMode(p)).toBe("IMAGE");
  });
  it("an explicit work mode wins", () => {
    const p = newPage("DOCUMENT", 794, 1123);
    expect(editModeOf("AUTO", p)).toBe("DOCUMENT");
    expect(editModeOf("DESIGN", p)).toBe("DESIGN");
    expect(editModeOf("IMAGE", p)).toBe("IMAGE");
  });
});

describe("edit profiles", () => {
  beforeEach(() => {
    const doc = newDocument();
    doc.pages = [newPage("DOCUMENT", 794, 1123)];
    S().load(doc);
    S().set({ pageId: doc.pages[0].id, mode: "AUTO" });
  });
  it("documents: letters are text, units mm, caret on click", () => {
    expect(toolKeyAllowed("brush")).toBe(false);
    expect(editUnit(S().doc.pages[0])).toMatch(/^(mm|in)$/);
    expect(PROFILES.DOCUMENT.clickText).toBe("caret");
    expect(PROFILES.DOCUMENT.slideshow).toBe(false);
  });
  it("images: brush keys, px; design: direct selection and pen", () => {
    S().set({ mode: "IMAGE" });
    expect(toolKeyAllowed("brush")).toBe(true);
    // Photoshop A = path / direct selection (the pen group's points)
    expect(toolKeyAllowed("direct")).toBe(true);
    expect(toolForKey("c", true)).toBeNull();
    S().set({ mode: "DESIGN" });
    expect(toolKeyAllowed("direct")).toBe(true);
    expect(toolKeyAllowed("pen")).toBe(true);
  });
  it("a print-size design is measured in mm, a screen design in px", () => {
    S().set({ mode: "AUTO" });
    expect(editUnit(newPage("DESIGN", 794, 1123))).toBe("mm");
    expect(editUnit(newPage("DESIGN", 1920, 1080))).toBe("px");
  });
});

describe("document view (continuous pages)", () => {
  beforeEach(() => {
    const doc = newDocument();
    doc.pages = [newPage("DOCUMENT", 794, 1123), newPage("DOCUMENT", 794, 1123), newPage("DOCUMENT", 794, 1123)];
    S().load(doc);
    S().set({ pageId: doc.pages[0].id, mode: "AUTO", editingTextId: null });
  });
  it("shows the next page under the current one", () => {
    const v = fitWidthView(S().doc.pages[0], 900, 1);
    const n = neighbours(S().doc, S().pageId, { ...v, panY: -800 }, 800);
    expect(n.map((x) => x.page.id)).toEqual([S().doc.pages[1].id]);
    expect(n[0].view.panY).toBeCloseTo(-800 + 1123 * v.zoom + PAGE_GAP);
  });
  it("scrolling past the middle makes the next page current without moving anything", () => {
    const v = { zoom: 1, panX: 50, panY: 24 };
    const r = docScroll(v, 0, 900, 900, 800);
    expect(r.pageId).toBe(S().doc.pages[1].id);
    // page 2's top is where it was drawn: page 1 top (24 - 900) + its height + gap
    expect(r.view.panY).toBeCloseTo(24 - 900 + 1123 + PAGE_GAP);
  });
  it("stops at the top of the first page", () => {
    const r = docScroll({ zoom: 1, panX: 50, panY: 24 }, 0, -500, 900, 800);
    expect(r.pageId).toBeUndefined();
    expect(r.view.panY).toBe(24);
  });
});

describe("AUTO edit mode while working on a page", () => {
  it("content does not switch the mode under the pointer; leaving and coming back judges it again", () => {
    startEditModes();
    const doc = newDocument();
    doc.pages = [newPage("DESIGN", 400, 400), newPage("DESIGN", 400, 400)];
    S().load(doc);
    S().set({ pageId: doc.pages[0].id, mode: "AUTO" });
    expect(currentEditMode()).toBe("DESIGN");
    // the first brush stroke on the empty artboard: a painted raster layer
    const r = newRaster();
    r.tiles["0_0"] = { data: new Uint8ClampedArray(TILE * TILE * 4) } as any;
    S().commit("paint", (d) => void d.pages[0].nodes.push(r as any));
    expect(currentEditMode()).toBe("DESIGN");
    S().set({ pageId: S().doc.pages[1].id });
    S().set({ pageId: S().doc.pages[0].id });
    expect(currentEditMode()).toBe("IMAGE");
  });
  it("a fixed work mode stays when the page changes", () => {
    startEditModes();
    const doc = newDocument();
    const slide = newPage("SLIDE", 1280, 720);
    doc.pages = [newPage("DOCUMENT", 794, 1123), slide];
    S().load(doc);
    S().set({ pageId: doc.pages[0].id, mode: "DOCUMENT" });
    S().set({ pageId: slide.id });
    expect(S().mode).toBe("DOCUMENT");
    expect(currentEditMode()).toBe("DOCUMENT");
    S().set({ mode: "AUTO" });
    expect(currentEditMode()).toBe("SLIDE");
  });
});
