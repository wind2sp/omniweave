// integ-cad (0.1.8 + CAD 2차): what the merged screen needed for drawings.
// - Chromium (Edge / WebView2) gives pointerdown a click count (detail) of 0, so a double-click on a block member never
//   reached isolation mode; the canvas now counts presses itself (core/clickCount.ts).
// - Opening a DXF / DWG shows the layer panel (drawing layers are what a drawing is read by).
// - The drawing layer row shows "frozen" as a word, not a snowflake glyph (VISUAL_DESIGN.md §6, no emoji).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countPress, PRESS_MS, type PressCount } from "../src/core/clickCount";
import { useStore } from "../src/core/store";
import { resetSessionsForTest } from "../src/core/sessions";
import { newDocument } from "../src/core/types";
import { openInTab } from "../src/ui/actions";
import { useUI } from "../src/ui/shell/uiStore";
import "../src/ui/tabs";

const fresh = (): PressCount => ({ t: -1e9, x: 0, y: 0, n: 0 });

describe("press click count (pointerdown detail 0 in Chromium)", () => {
  it("counts a quick second press at the same place as a double-click", () => {
    const c = fresh();
    expect(countPress(c, 0, 1000, 100, 100)).toBe(1);
    expect(countPress(c, 0, 1200, 101, 101)).toBe(2);
    expect(countPress(c, 0, 1350, 101, 100)).toBe(3);
  });
  it("starts again when the press is late or elsewhere", () => {
    const c = fresh();
    countPress(c, 0, 1000, 100, 100);
    expect(countPress(c, 0, 1000 + PRESS_MS + 1, 100, 100)).toBe(1);
    expect(countPress(c, 0, 1700, 140, 100)).toBe(1);
  });
  it("keeps the engine's own count when it gives one", () => {
    const c = fresh();
    expect(countPress(c, 2, 1000, 0, 0)).toBe(2);
    expect(countPress(c, 1, 5000, 0, 0)).toBe(1);
  });
});

describe("opening a drawing", () => {
  beforeEach(() => {
    useStore.getState().load(newDocument());
    resetSessionsForTest();
    useUI.getState().set({ leftTab: "pages" });
  });
  afterEach(() => useUI.getState().set({ leftTab: "pages" }));

  it("a DXF opens in its tab with the layer panel showing; other files leave the panel alone", async () => {
    const bytes = new Uint8Array(readFileSync("tests/fixtures/cad/omni-cad-basic.dxf"));
    const pages = await openInTab({ name: "omni-cad-basic.dxf", path: null, bytes });
    expect(pages.length).toBe(2);
    expect(pages[0].source?.cad).toBeTruthy();
    expect(useUI.getState().leftTab).toBe("layers");

    useUI.getState().set({ leftTab: "pages" });
    await openInTab({ name: "note.txt", path: null, bytes: new TextEncoder().encode("hello") });
    expect(useUI.getState().leftTab).toBe("pages");
  });

  it("the layer row has no snowflake glyph for a frozen layer", () => {
    const src = readFileSync("src/ui/shell/LeftDock.tsx", "utf8");
    expect(src).not.toMatch(/❄/);
  });
});
