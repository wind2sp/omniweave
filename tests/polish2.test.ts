// polish-2: pen point-by-point undo and close-with-drag (Illustrator), the image mode's Shift+P pen cycle key, and
// the screen-only crisp path cache (render/draw.ts — exports untouched).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentPage, useStore } from "../src/core/store";
import { newDocument, newVector, type Vec2, type VectorNode } from "../src/core/types";
import { drawing, cancelDrawing, isDrawing, pathDown, pathMove, pathUp, undoDrawnPoint, type PathEnv } from "../src/ui/pathCanvas";
import { keyOfTool, PROFILES } from "../src/ui/editModes";
import { drawNode, type DrawEnv } from "../src/render/draw";
import { rectContour } from "../src/core/vector";
import { useUI } from "../src/ui/shell/uiStore";

const S = () => useStore.getState();
const env: PathEnv = { zoom: 1, dpr: 1, toScreen: (p) => p, invalidate: () => {} };
const ev = (o: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; detail: number }> = {}) => ({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, detail: 1, ...o });

/** press (and drag to `to`), release */
function click(p: Vec2, to?: Vec2) {
  const d = pathDown(ev(), p, env);
  if (d && to) pathMove(d, ev(), to, env);
  if (d) pathUp(d, env);
}

beforeEach(() => {
  // exact points: no snapping to the page edges / grid
  useUI.getState().set({ snap: false });
  cancelDrawing();
  S().load(newDocument());
  S().set({ tool: "pen" });
});

describe("pen: Ctrl+Z while drawing takes back one point at a time", () => {
  it("removes the last point with its handles, then ends the drawing without touching the history", () => {
    const past = S().past.length;
    click([10, 10]);
    click([100, 10], [130, 40]); // a smooth point with handles
    click([100, 100]);
    expect(drawing.pts.length).toBe(3);
    expect(undoDrawnPoint()).toBe(true);
    expect(drawing.pts.length).toBe(2);
    // the second point keeps the handles it was dragged out with
    expect(drawing.pts[1].handleOut).toEqual([130, 40]);
    expect(undoDrawnPoint()).toBe(true);
    expect(drawing.pts.length).toBe(1);
    expect(drawing.pts[0].handleOut).toEqual([10, 10]);
    expect(undoDrawnPoint()).toBe(true);
    expect(isDrawing()).toBe(false);
    expect(undoDrawnPoint()).toBe(false); // nothing drawn: the history undo runs instead
    expect(S().past.length).toBe(past);
    expect(currentPage()!.nodes.some((n) => n.type === "VECTOR")).toBe(false);
  });

  it("takes back a retracted handle (click on the last point) before the point itself", () => {
    click([10, 10]);
    click([100, 10], [140, 10]);
    click([100, 10]); // retract the out handle
    expect(drawing.pts[1].handleOut).toEqual([100, 10]);
    undoDrawnPoint();
    expect(drawing.pts.length).toBe(2);
    expect(drawing.pts[1].handleOut).toEqual([140, 10]);
  });
});

describe("pen: closing on the first point with a drag pulls its handles", () => {
  it("a drag from the first point makes it smooth (the closing segment curves); a click keeps it a corner", () => {
    click([0, 0]);
    click([100, 0]);
    click([100, 100]);
    click([0, 0], [0, -30]); // close, dragging up
    expect(isDrawing()).toBe(false);
    const v = currentPage()!.nodes.find((n) => n.type === "VECTOR") as VectorNode;
    expect(v.contours[0].closed).toBe(true);
    const f = v.contours[0].nodes[0];
    expect(f.isCorner).toBe(false);
    expect([f.handleOut[0] - f.anchor[0], f.handleOut[1] - f.anchor[1]]).toEqual([0, -30]);
    expect([f.handleIn[0] - f.anchor[0], f.handleIn[1] - f.anchor[1]]).toEqual([0, 30]);
    expect(S().past.length).toBe(1); // one history step for the whole path

    S().load(newDocument());
    click([0, 0]);
    click([100, 0]);
    click([100, 100]);
    click([0, 0]);
    const w = currentPage()!.nodes.find((n) => n.type === "VECTOR") as VectorNode;
    expect(w.contours[0].closed).toBe(true);
    expect(w.contours[0].nodes[0].isCorner).toBe(true);
  });

  it("the other end of a continued path closes with a drag too", () => {
    const open = newVector([{ nodes: [[0, 0], [100, 0], [100, 100]].map((p) => ({ anchor: p as Vec2, handleIn: p as Vec2, handleOut: p as Vec2, isCorner: true })), closed: false }], "p");
    open.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
    S().commit("add", (d) => void d.pages[0].nodes.push(open as never));
    click([100, 100]); // continue from the last point
    click([0, 100]);
    click([0, 0], [-20, 0]); // the path's other end: close with a drag
    const v = currentPage()!.nodes.find((n) => n.id === open.id) as VectorNode;
    expect(v.contours[0].closed).toBe(true);
    expect(v.contours[0].nodes.length).toBe(4);
    const f = v.contours[0].nodes[0];
    expect(f.isCorner).toBe(false);
    expect(f.handleIn).toEqual([20, 0]);
  });
});

describe("image mode pen group key", () => {
  it("Shift+P is shown for the curvature pen (Photoshop's pen group cycle)", () => {
    expect(keyOfTool(PROFILES.IMAGE, "curvature")).toBe("Shift+P");
    expect(keyOfTool(PROFILES.IMAGE, "pen")).toBe("P");
  });
});

class FakePath2D {
  constructor(public d = "") {}
}
beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D ??= FakePath2D;
});

describe("crisp screen paths are cached", () => {
  type M = [number, number, number, number, number, number];
  function ctxAt(m: M) {
    const strokes: unknown[] = [];
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "", strokeStyle: "", lineWidth: 1, lineJoin: "round", lineCap: "round",
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {},
      getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
      fill() {},
      stroke: (p: unknown) => void strokes.push(p),
    };
    return { ctx, strokes };
  }
  const denv = (screen: boolean): DrawEnv => ({ doc: newDocument(), clip: { x: 0, y: 0, w: 1e4, h: 1e4 }, scale: 1, incomplete: false, onResourceReady: () => {}, screen });
  it("repaints and whole-pixel shifts reuse the fitted Path2D; another fractional offset or scale builds a new one", () => {
    const n = newVector([rectContour(0.3, 0.3, 50.2, 20.1)], "r");
    n.stroke = "#000";
    n.strokeWidth = 1;
    const draw = (m: M) => {
      const { ctx, strokes } = ctxAt(m);
      drawNode(ctx as never, n, denv(true));
      return strokes[0];
    };
    const a = draw([1.25, 0, 0, 1.25, 0.4, 0.2]);
    expect(draw([1.25, 0, 0, 1.25, 0.4, 0.2])).toBe(a);
    expect(draw([1.25, 0, 0, 1.25, 7.4, 3.2])).toBe(a);
    expect(draw([1.25, 0, 0, 1.25, 0.6, 0.2])).not.toBe(a);
    expect(draw([1.5, 0, 0, 1.5, 0.6, 0.2])).not.toBe(a);
  });
});
