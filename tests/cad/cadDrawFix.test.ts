// QA 2026-11-19 1-2 and 1-3 (docs/qa/ISSUES-2026-11-19.md): a LINE drawn on an opened drawing beyond its imported
// extents is painted (model space has no edge on the drawing screen), and the green tracking ray of a point request
// goes when the command ends, is cancelled or the pointer leaves.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentPage, useStore } from "../../src/core/store";
import { resetSessionsForTest } from "../../src/core/sessions";
import { newDocument, type VectorNode } from "../../src/core/types";
import { openInTab } from "../../src/ui/actions";
import "../../src/ui/tabs";
import { useCadScreen } from "../../src/ui/editModes";
import { cancel, submit } from "../../src/ui/cad/engine";
import { ap, wToPage } from "../../src/ui/cad/geom";
import { useCadUI } from "../../src/ui/cad/state";
import { guidesNow, hooks } from "../../src/ui/cad/view";
import { WeaveCache } from "../../src/render/weave";

const S = () => useStore.getState();

// a recording 2D context: every call is a no-op; stroke() records the stroke colour
let strokes: string[] = [];
const fakeCtx = (): unknown => {
  const st: Record<string | symbol, unknown> = { strokeStyle: "#000", fillStyle: "#000", globalAlpha: 1, lineWidth: 1 };
  return new Proxy(st, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "stroke") return () => strokes.push(String(t.strokeStyle));
      if (k === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (k === "measureText") return () => ({ width: 1, actualBoundingBoxAscent: 1, actualBoundingBoxDescent: 0 });
      if (k === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      if (k === "getLineDash") return () => [];
      return () => undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
};
const g = globalThis as { OffscreenCanvas?: unknown; Path2D?: unknown };
const hadOC = g.OffscreenCanvas, hadP2 = g.Path2D;
beforeAll(() => {
  g.Path2D ??= class {};
  g.OffscreenCanvas = class {
    width: number;
    height: number;
    private c = fakeCtx();
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return this.c;
    }
  };
  useCadScreen.getState().set(true);
});
afterAll(() => {
  g.OffscreenCanvas = hadOC;
  g.Path2D = hadP2;
});

beforeEach(async () => {
  S().load(newDocument());
  resetSessionsForTest();
  cancel(true);
  const bytes = new Uint8Array(readFileSync("qa/interop/autocad-made/omni-cad-01-lines-2018.dxf"));
  await openInTab({ name: "omni-cad-01-lines-2018.dxf", path: null, bytes });
  S().set({ selection: [] });
});

describe("1-2 a new LINE on an opened drawing is painted", () => {
  it("drawn beyond the imported extents, it has the layer's colour and stroke and is painted on screen", () => {
    const cad = currentPage()!.source!.cad!;
    const before = new Set(currentPage()!.nodes.map((n) => n.id));
    submit("L");
    submit("400,50");
    submit("@100,0");
    submit("");
    const made = currentPage()!.nodes.filter((n) => !before.has(n.id)) as VectorNode[];
    expect(made.length).toBe(1);
    const n = made[0];
    const grp = currentPage()!.groups!.find((x) => x.id === n.groupId)!;
    expect(n.stroke).toBe(grp.cad!.color);
    expect(n.strokeWidth).toBeGreaterThan(0);
    expect(n.visible).toBe(true);
    // the line lies right of the imported page
    const a = ap(wToPage(cad), [400, 50]);
    const page = currentPage()!;
    expect(a[0]).toBeGreaterThan(page.width);
    // the canvas paints the drawing screen with model space (as CanvasView does): the line is stroked
    expect(readFileSync("src/ui/CanvasView.tsx", "utf8")).toMatch(/ch\.displayPage\(page, zoom\)[^\n]*invalidate, MODEL_SPACE\)/);
    const MODEL_SPACE = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };
    strokes = [];
    const screen = fakeCtx() as CanvasRenderingContext2D;
    const view = { zoom: 1, panX: -(a[0] - 100), panY: 0 };
    const disp = hooks.displayPage(page, 1);
    const st = new WeaveCache(16).render(screen, S().doc, disp, null, view, 400, 600, 1, null, () => {}, MODEL_SPACE);
    expect(st.tiles).toBeGreaterThan(0);
    expect(strokes.length).toBeGreaterThan(0);
  });
});

describe("1-3 tracking guides do not outlive their request", () => {
  const ev = { buttons: 0 } as PointerEvent;
  const screenOf = (w: [number, number]): [number, number] => {
    const cad = currentPage()!.source!.cad!;
    const v = S().view;
    const p = ap(wToPage(cad), w);
    return [p[0] * v.zoom + v.panX, p[1] * v.zoom + v.panY];
  };
  const track = () => {
    useCadUI.setState({ ortho: true, osnap: false, snap: false });
    submit("L");
    submit("10,10");
    const [sx, sy] = screenOf([60, 14]);
    hooks.move(ev, sx, sy);
    expect(guidesNow().tracking).not.toBeNull();
  };
  it("cleared when the command ends", () => {
    track();
    submit("@50,0");
    submit("");
    expect(guidesNow().tracking).toBeNull();
    const [sx, sy] = screenOf([70, 20]);
    hooks.move(ev, sx, sy);
    expect(guidesNow().tracking).toBeNull();
  });
  it("cleared when the command is cancelled", () => {
    track();
    cancel();
    expect(guidesNow().tracking).toBeNull();
  });
  it("cleared when the pointer leaves", () => {
    track();
    hooks.leave();
    expect(guidesNow().tracking).toBeNull();
    cancel();
  });
});
