// Feature coverage: document/page/layer operations driven through the real store and actions.
import { beforeEach, describe, expect, it } from "vitest";
import { makeTile, weaveKey } from "../../src/core/loom";
import { masterOf } from "../../src/core/store";
import { currentEditMode } from "../../src/ui/editModes";
import { TILE, newDocument, newPage, newRaster, newText, newVector } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import {
  addMaster,
  addPage,
  deletePage,
  deleteSelected,
  duplicatePage,
  duplicateSelected,
  fitView,
  movePage,
  newFile,
  reorderSelected,
  runPathfinder,
  selectAll,
  setPageProps,
  updateNodes,
} from "../../src/ui/actions";
import { S, freshStore, page } from "./helpers";

const tile = (v: number) => {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  d.fill(v);
  return makeTile(d);
};

beforeEach(() => freshStore());

describe("new documents", () => {
  it("[PS-001][IL-001][WD-001][HG-001][PP-001] new file from presets (artboard, A4 document, 16:9 slide)", () => {
    newFile("ARTBOARD");
    expect(page()).toMatchObject({ kind: "DESIGN", width: 1920, height: 1080 });
    expect(page().nodes[0].type).toBe("RASTER");
    newFile("A4");
    expect(page()).toMatchObject({ kind: "DOCUMENT", width: 794, height: 1123 });
    expect(page().nodes[0].type).toBe("TEXT");
    // the work mode stays 자동 and the page decides the edit mode (ui/editModes.ts)
    expect(S().mode).toBe("AUTO");
    expect(currentEditMode()).toBe("DOCUMENT");
    newFile("SLIDE_16_9");
    expect(page()).toMatchObject({ kind: "SLIDE", width: 1280, height: 720, transition: { type: "FADE" } });
    expect(currentEditMode()).toBe("SLIDE");
  });
});

describe("layers", () => {
  beforeEach(() => {
    const doc = newDocument();
    const r = newRaster("배경");
    r.tiles = { "0_0": tile(200) };
    doc.pages[0].nodes = [r, { ...newText("글자", 200), name: "글자" }, newVector([rectContour(0, 0, 10, 10)], "도형")];
    freshStore(doc);
  });
  const names = () => page().nodes.map((n) => n.name);

  it("[PS-013][IL-061] duplicate selected layer/object (offset copy, new id)", () => {
    S().set({ selection: [page().nodes[0].id] });
    duplicateSelected();
    expect(names()).toEqual(["배경", "글자", "도형", "배경 사본"]);
    const [orig, , , copy] = page().nodes;
    expect(copy.id).not.toBe(orig.id);
    expect(copy.transform.x).toBe(orig.transform.x + 20);
    expect(copy.type === "RASTER" && orig.type === "RASTER" && copy.tiles["0_0"].hash).toBe(orig.type === "RASTER" && orig.tiles["0_0"].hash); // tiles shared by content address
  });

  it("[PS-014][PS-017][IL-062] delete removes selected layers but never locked ones", () => {
    const [a, b] = page().nodes;
    updateNodes([a.id], "잠금", (n) => (n.locked = true));
    S().set({ selection: [a.id, b.id] });
    deleteSelected();
    expect(names()).toEqual(["배경", "도형"]);
  });

  it("[PS-015][IL-060][PP-034] stacking order: forward, backward, to front, to back", () => {
    const [a] = page().nodes;
    S().set({ selection: [a.id] });
    reorderSelected("up");
    expect(names()).toEqual(["글자", "배경", "도형"]);
    reorderSelected("top");
    expect(names()).toEqual(["글자", "도형", "배경"]);
    reorderSelected("bottom");
    expect(names()).toEqual(["배경", "글자", "도형"]);
  });

  it("[PS-016][IL-062] hidden layers drop out of the render key (and so out of the picture)", () => {
    const pg = page();
    const region = { x: 0, y: 0, w: 256, h: 256 };
    const before = weaveKey(pg, null, region, 1, null);
    expect(before.nodes.map((n) => n.name)).toContain("배경");
    updateNodes([pg.nodes[0].id], "숨기기", (n) => (n.visible = false));
    const after = weaveKey(page(), null, region, 1, null);
    expect(after.nodes.map((n) => n.name)).not.toContain("배경");
    expect(after.key).not.toBe(before.key);
  });

  it("[PS-018] rename layer", () => {
    updateNodes([page().nodes[1].id], "이름 변경", (n) => (n.name = "제목"));
    expect(names()[1]).toBe("제목");
  });

  it("[PS-077][PS-078][WD-013][HG-013][IL-084][PP-071][AC-018] undo/redo with labelled history; a drag gesture is one step", () => {
    const id = page().nodes[2].id;
    S().beginGesture();
    for (let i = 1; i <= 5; i++) S().updateGesture((d) => void (d.pages[0].nodes[2].transform.x = i * 10));
    S().endGesture("이동");
    updateNodes([id], "채우기", (n) => (n.fill = "#ff0000"));
    expect(S().past.map((p) => p.label)).toEqual(["이동", "채우기"]);
    S().undo();
    expect((page().nodes[2] as any).fill).not.toBe("#ff0000");
    expect(page().nodes[2].transform.x).toBe(50);
    S().undo();
    expect(page().nodes[2].transform.x).toBe(0);
    S().redo();
    S().redo();
    expect((page().nodes[2] as any).fill).toBe("#ff0000");
  });

  it("[PS-035][IL-054] select all picks every visible unlocked object", () => {
    updateNodes([page().nodes[0].id], "잠금", (n) => (n.locked = true));
    selectAll();
    expect(S().selection).toHaveLength(2);
  });

  it("[IL-030][IL-031] pathfinder action replaces the selected shapes with the result (undoable)", () => {
    const doc = newDocument();
    const a = newVector([rectContour(0, 0, 100, 100)], "A");
    const b = newVector([rectContour(50, 0, 100, 100)], "B");
    doc.pages[0].nodes = [a, b];
    freshStore(doc);
    S().set({ selection: [a.id, b.id] });
    runPathfinder("union");
    expect(page().nodes).toHaveLength(1);
    expect(page().nodes[0].name).toContain("union");
    S().undo();
    expect(page().nodes.map((n) => n.name)).toEqual(["A", "B"]);
  });
});

describe("pages, artboards, slides", () => {
  it("[IL-011][PP-010][AC-028] add design/slide/document pages after the current one", () => {
    addPage("SLIDE");
    addPage("DOCUMENT");
    addPage("DESIGN");
    expect(S().doc.pages.map((p) => p.kind)).toEqual(["DESIGN", "SLIDE", "DOCUMENT", "DESIGN"]);
    expect(S().doc.pages[1]).toMatchObject({ width: 1280, height: 720 });
    expect(S().doc.pages[2]).toMatchObject({ width: 794, height: 1123 });
  });

  it("[IL-013][PP-011][PP-012][PP-013][AC-020][AC-021][AC-027] duplicate, reorder and delete pages", () => {
    addPage("SLIDE");
    const [p0, p1] = S().doc.pages;
    duplicatePage(p1.id);
    expect(S().doc.pages).toHaveLength(3);
    movePage(p1.id, -1);
    expect(S().doc.pages[0].id).toBe(p1.id);
    deletePage(p0.id);
    expect(S().doc.pages.map((p) => p.id)).not.toContain(p0.id);
    // the last page is protected
    deletePage(S().doc.pages[0].id);
    deletePage(S().doc.pages[0].id);
    expect(S().doc.pages).toHaveLength(1);
  });

  it("[PS-052][IL-012][WD-062][HG-045][PP-016] page/canvas size and orientation", () => {
    setPageProps({ width: 794, height: 1123 });
    expect(page()).toMatchObject({ width: 794, height: 1123 });
    setPageProps({ width: page().height, height: page().width }); // 가로/세로 바꾸기
    expect(page()).toMatchObject({ width: 1123, height: 794 });
  });

  it("[PP-017][WD-067][HG-052] page background colour", () => {
    setPageProps({ background: "#112233" });
    expect(page().background).toBe("#112233");
    const k1 = weaveKey(page(), null, { x: 0, y: 0, w: 256, h: 256 }, 1, null).key;
    setPageProps({ background: "#445566" });
    expect(weaveKey(page(), null, { x: 0, y: 0, w: 256, h: 256 }, 1, null).key).not.toBe(k1);
  });

  it("[PP-015][HG-051] master page objects appear under every page that uses the master (slides and documents)", () => {
    const slideId = S().pageId;
    addMaster();
    const masterId = S().doc.masters[0].id;
    const logo = newText("로고", 100);
    S().commit("로고", (d) => void d.masters[0].nodes.push(logo as any));
    S().set({ pageId: slideId });
    setPageProps({ masterId, kind: "DOCUMENT" });
    const pg = page();
    const m = masterOf(S().doc, pg)!;
    expect(m.id).toBe(masterId);
    expect(weaveKey(pg, m, { x: 0, y: 0, w: 256, h: 256 }, 1, null).nodes.map((n) => n.name)).toContain(logo.name);
  });

  it("[AC-003] fit page to the viewport", () => {
    const doc = newDocument();
    doc.pages = [newPage("PDF", 600, 800)];
    freshStore(doc);
    fitView(1000, 1000);
    const v = S().view;
    expect(v.zoom).toBeCloseTo((1000 - 80) / 800);
    expect(v.panY).toBeCloseTo((1000 - 800 * v.zoom) / 2);
  });
});
