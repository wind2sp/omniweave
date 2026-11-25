// 2026-11-24, features-ps-ai.md (Illustrator): every artboard on one canvas — the design pages laid out in a row (or
// at their own place), a press on another makes it current with nothing moving, the artboard tool moves / adds /
// deletes artboards, Ctrl+Alt+0 fits them all.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage } from "../src/core/types";
import { BOARD_GAP, addBoard, boardsOf, deleteBoard, fitAllBoardsView, moveBoard, otherBoards, pickBoardAt } from "../src/ui/artboards";
import { resolveBinding } from "../src/ui/keymap";
import { PROFILES } from "../src/ui/editModes";

const S = () => useStore.getState();

function doc3() {
  const doc = newDocument();
  doc.pages = [newPage("DESIGN", 400, 300, "대지 1"), newPage("DESIGN", 200, 200, "대지 2"), newPage("DESIGN", 300, 100, "대지 3")];
  S().load(doc);
  S().set({ pageId: doc.pages[0].id, selection: [], mode: "DESIGN", view: { zoom: 1, panX: 100, panY: 50 } });
  return doc.pages;
}

describe("artboards on one canvas", () => {
  it("lays the design pages out in a row with 20 pt between them", () => {
    doc3();
    const b = boardsOf(S().doc);
    expect(b.map((x) => x.x)).toEqual([0, 400 + BOARD_GAP, 600 + 2 * BOARD_GAP]);
    expect(b.every((x) => x.y === 0)).toBe(true);
  });

  it("a press on another artboard makes it current with the view shifted so nothing moves", () => {
    const [, p2] = doc3();
    const o = otherBoards(S().doc, S().pageId, S().view);
    expect(o[0].view.panX).toBeCloseTo(100 + 400 + BOARD_GAP);
    expect(pickBoardAt(100 + 400 + BOARD_GAP + 10, 60)).toBe(true);
    expect(S().pageId).toBe(p2.id);
    expect(S().view.panX).toBeCloseTo(100 + 400 + BOARD_GAP);
    // inside the current one: stays
    expect(pickBoardAt(S().view.panX + 5, 60)).toBe(false);
  });

  it("moving one pins the row and moves only that one; add and delete keep the others in place", () => {
    const [p1] = doc3();
    moveBoard(p1.id, 0, 500);
    const b = boardsOf(S().doc);
    expect(b[0].y).toBe(500);
    expect(b[1].x).toBeCloseTo(400 + BOARD_GAP);
    expect(b[1].y).toBe(0);
    const id = addBoard(0, 400, 100, 50)!;
    expect(S().pageId).toBe(id);
    expect(boardsOf(S().doc).length).toBe(4);
    expect(boardsOf(S().doc).find((x) => x.page.id === id)!.y).toBe(900);
    expect(deleteBoard()).toBe(true);
    expect(boardsOf(S().doc).length).toBe(3);
  });

  it("fit all shows every artboard; the tool and Ctrl+Alt+0 are on the design mode's keys", () => {
    doc3();
    const v = fitAllBoardsView(1000, 500)!;
    const span = 900 + 2 * BOARD_GAP;
    expect(v.zoom).toBeCloseTo(920 / span, 3);
    expect(PROFILES.DESIGN.keys["shift+o"]).toBe("artboard");
    expect(resolveBinding("DESIGN", "Ctrl+Alt+0")?.cmd).toBe("view.fitAllBoards");
  });
});

describe("export for screens", () => {
  it("Ctrl+Alt+E opens it in the design mode; SVG files are named after their artboards", async () => {
    expect(resolveBinding("DESIGN", "Ctrl+Alt+E")?.cmd).toBe("file.exportScreens");
    const pages = doc3();
    pages[1].name = "아이콘/작게";
    const { screenFiles } = await import("../src/ui/shell/ExportScreensDialog");
    const files = await screenFiles(S().doc, S().doc.pages.slice(0, 2), ["svg"], [1]);
    expect(Object.keys(files)).toEqual(["대지 1.svg", "아이콘_작게.svg"]);
    expect(new TextDecoder().decode(files["대지 1.svg"])).toContain("<svg");
  });
});
