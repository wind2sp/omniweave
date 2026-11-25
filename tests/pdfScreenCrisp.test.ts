// PDF / AI pages on screen (docs/design/RENDER_CRISPNESS.md 5): rendered at the exact device scale and put down 1:1 on
// whole device pixels; a big page (high zoom) in cells, only those the tile shows; a stand-in while rendering marks
// the tile incomplete so it is painted again (before, the first low-resolution render stayed in the tile for good).
import { beforeEach, describe, expect, it, vi } from "vitest";

const asked: { hash: string; scale: number; cell: [number, number] | null }[] = [];
let ready = true;
vi.mock("../src/io/pdf", async (orig) => {
  const real = await orig<typeof import("../src/io/pdf")>();
  return {
    ...real,
    pdfScreenBitmap: (hash: string, _i: number, scale: number, cell: [number, number] | null) => {
      asked.push({ hash, scale, cell });
      return ready ? ({ width: 10, height: 10, tag: `${scale}:${cell}` } as unknown as HTMLCanvasElement) : null;
    },
    pdfAnyBitmap: () => ({ width: 5, height: 5, tag: "fallback" }),
  };
});
import { drawPdfScreen } from "../src/render/draw";
import { PDF_CELL, pdfScreenCells, pdfScreenScale } from "../src/io/pdf";

function fakeCtx(m: { a: number; b: number; c: number; d: number; e: number; f: number }, w = 256, h = 256) {
  const draws: { tag: string; args: number[]; t: number[] }[] = [];
  let cur = { ...m };
  const stack: (typeof cur)[] = [];
  const ctx = {
    canvas: { width: w, height: h },
    fillStyle: "",
    getTransform: () => ({ ...cur }),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void (cur = { a, b, c, d, e, f }),
    save: () => void stack.push({ ...cur }),
    restore: () => void (cur = stack.pop()!),
    drawImage: (b: { tag: string }, ...args: number[]) => void draws.push({ tag: b.tag, args, t: [cur.a, cur.e, cur.f] }),
    fillRect: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
}
const node = (w = 800, h = 600) => ({ type: "PDF", pageIndex: 0, width: w, height: h, covers: [] }) as never;
const env = () => ({ incomplete: false, onResourceReady: () => {}, scale: 1, clip: { x: 0, y: 0, w: 1, h: 1 }, doc: {} as never, screen: true });

beforeEach(() => {
  asked.length = 0;
  ready = true;
});

describe("PDF pages on screen", () => {
  it("asks for the exact device scale (zoom × dpr × node scale) and draws it 1:1 on whole device pixels", () => {
    for (const k of [0.63, 1, 1.25, 1.4142, 1.5, 2, 2.37]) {
      asked.length = 0;
      const { ctx, draws } = fakeCtx({ a: k, b: 0, c: 0, d: k, e: -256.4, f: 13.6 });
      const e = env();
      expect(drawPdfScreen(ctx, node(), e, "h", null)).toBe(true);
      expect(asked[0].scale).toBe(pdfScreenScale(k));
      expect(draws).toHaveLength(1);
      // identity transform, integer position, natural size (no resampling)
      expect(draws[0].t).toEqual([1, 0, 0]);
      expect(draws[0].args).toEqual([-256, 14]);
      expect(e.incomplete).toBe(false);
    }
  });

  it("a big page at high zoom is rendered in cells, only those the tile covers", () => {
    const k = 8; // 800×600 page px → 6400×4800 device px = 30.7 Mpx: cells
    expect(pdfScreenCells(800, 600, k)).toBe(true);
    const { ctx, draws } = fakeCtx({ a: k, b: 0, c: 0, d: k, e: -2100, f: -3000 });
    drawPdfScreen(ctx, node(), env(), "h", null);
    expect(asked.map((a) => a.cell)).toEqual([[1, 1]]);
    expect(draws[0].args).toEqual([-2100 + PDF_CELL, -3000 + PDF_CELL]);
  });

  it("while rendering, the sharpest render made so far stands in and the tile is not kept", () => {
    ready = false;
    const { ctx, draws } = fakeCtx({ a: 1.5, b: 0, c: 0, d: 1.5, e: 0, f: 0 });
    const e = env();
    drawPdfScreen(ctx, node(), e, "h", null);
    expect(e.incomplete).toBe(true);
    expect(draws.map((d) => d.tag)).toEqual(["fallback"]);
    expect(draws[0].args).toEqual([0, 0, 800, 600]); // stretched through the node transform
  });

  it("a rotated or flipped page is left to the transform path", () => {
    const { ctx } = fakeCtx({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 });
    expect(drawPdfScreen(ctx, node(), env(), "h", null)).toBe(false);
    const f = fakeCtx({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(drawPdfScreen(f.ctx, node(), env(), "h", null)).toBe(false);
  });
});
