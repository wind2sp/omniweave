import { describe, expect, it } from "vitest";
import { despeckle, marchingSquares, polygonArea, presetOptions, rdpClosed, traceImage, TRACE_PRESETS } from "../../src/core/image/trace";
import type { Vec2 } from "../../src/core/types";
import { flatten } from "../../src/core/vector";
import { canvas, contourArea, evenOddArea, fillDisk, fillRect } from "./helpers";
import { newImg } from "../../src/core/image/pixels";

const BLACK: [number, number, number] = [0, 0, 0];

describe("marching squares", () => {
  it("a w×h pixel block gives one loop along the pixel edges with ½-px chamfers (area = w·h − 0.5)", () => {
    const w = 10, h = 8, mask = new Uint8Array(w * h);
    for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) mask[y * w + x] = 1;
    const loops = marchingSquares(mask, w, h);
    expect(loops.length).toBe(1);
    expect(Math.abs(polygonArea(loops[0]))).toBeCloseTo(5 * 4 - 0.5, 6);
    const xs = loops[0].map((p) => p[0]), ys = loops[0].map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3, 8, 2, 6]);
  });

  it("holes come out with the opposite orientation", () => {
    const w = 12, h = 12, mask = new Uint8Array(w * h);
    for (let y = 1; y < 11; y++) for (let x = 1; x < 11; x++) mask[y * w + x] = 1;
    for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) mask[y * w + x] = 0;
    const loops = marchingSquares(mask, w, h);
    expect(loops.length).toBe(2);
    const areas = loops.map(polygonArea).sort((a, b) => Math.abs(b) - Math.abs(a));
    expect(Math.sign(areas[0])).toBe(-Math.sign(areas[1]));
    expect(Math.abs(areas[0] + areas[1])).toBeCloseTo(100 - 0.5 - (16 - 0.5), 6);
  });

  it("diagonal neighbours are joined (8-connected foreground)", () => {
    const w = 4, h = 4, mask = new Uint8Array(w * h);
    mask[1 * w + 1] = 1;
    mask[2 * w + 2] = 1;
    expect(marchingSquares(mask, w, h).length).toBe(1);
  });
});

describe("Ramer–Douglas–Peucker", () => {
  it("every dropped point stays within the tolerance of the simplified polygon", () => {
    const pts: Vec2[] = [];
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      pts.push([100 + 50 * Math.cos(a) + Math.sin(i * 7) * 0.3, 100 + 30 * Math.sin(a)]);
    }
    for (const tol of [0.5, 1, 2]) {
      const keep = rdpClosed(pts, tol);
      expect(keep.length).toBeLessThan(pts.length);
      const poly = keep.map((i) => pts[i]);
      for (const p of pts) {
        let best = Infinity;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
          best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
        }
        expect(best).toBeLessThanOrEqual(tol + 1e-9);
      }
    }
  });
});

describe("image trace — black & white", () => {
  it("rectangle → 1 path, 4 sharp corners, straight sides, area within 0.5 %", () => {
    const img = canvas(200, 150);
    fillRect(img, 40, 30, 100, 60, BLACK);
    const r = traceImage(img, presetOptions("logo"));
    expect(r.layers.length).toBe(1);
    expect(r.paths).toBe(1);
    const c = r.layers[0].contours[0];
    expect(c.nodes.length).toBe(4);
    expect(c.nodes.every((n) => n.isCorner)).toBe(true);
    // straight segments: handles sit on the anchors
    expect(c.nodes.every((n) => n.handleIn[0] === n.anchor[0] || n.handleOut[0] === n.anchor[0])).toBe(true);
    expect(Math.abs(Math.abs(contourArea(c)) - 6000) / 6000).toBeLessThan(0.005);
    // every true corner has an anchor within 0.75 px
    for (const [x, y] of [[40, 30], [140, 30], [140, 90], [40, 90]]) expect(Math.min(...c.nodes.map((n) => Math.hypot(n.anchor[0] - x, n.anchor[1] - y)))).toBeLessThan(0.75);
    expect(r.layers[0].color).toBe("#000000");
  });

  it("disk → 1 smooth path with few anchors, area within 1.5 %, outline within precision of the true circle", () => {
    const img = canvas(200, 200);
    const pxCount = fillDisk(img, 100, 100, 60, BLACK);
    const r = traceImage(img, { ...presetOptions("logo"), precision: 1 });
    expect(r.paths).toBe(1);
    const c = r.layers[0].contours[0];
    expect(c.nodes.length).toBeLessThanOrEqual(12);
    expect(c.nodes.filter((n) => n.isCorner).length).toBe(0);
    expect(Math.abs(Math.abs(contourArea(c)) - pxCount) / pxCount).toBeLessThan(0.015);
    for (const p of flatten(c, 0.1)) expect(Math.abs(Math.hypot(p[0] - 100, p[1] - 100) - 60)).toBeLessThan(1.6);
  });

  it("ring → outer + hole (2 paths, even-odd), filled area within 2 % of the pixels", () => {
    const img = canvas(200, 200);
    const outer = fillDisk(img, 100, 100, 70, BLACK);
    const inner = fillDisk(img, 100, 100, 35, [255, 255, 255]);
    const r = traceImage(img, presetOptions("logo"));
    expect(r.paths).toBe(2);
    const area = evenOddArea(r.layers[0].contours);
    expect(Math.abs(area - (outer - inner)) / (outer - inner)).toBeLessThan(0.02);
  });

  it("noise below the minimum area is ignored; holes below it are filled", () => {
    const img = canvas(120, 120);
    fillRect(img, 20, 20, 60, 60, BLACK);
    fillRect(img, 100, 100, 2, 2, BLACK); // 4-px speck
    fillRect(img, 40, 40, 2, 2, [255, 255, 255]); // 4-px pinhole
    expect(traceImage(img, { ...presetOptions("logo"), minArea: 8 }).paths).toBe(1);
    expect(traceImage(img, { ...presetOptions("logo"), minArea: 1 }).paths).toBe(3);
  });

  it("threshold decides what is ink", () => {
    const img = canvas(100, 50);
    fillRect(img, 10, 10, 20, 20, [100, 100, 100]);
    fillRect(img, 60, 10, 20, 20, [200, 200, 200]);
    expect(traceImage(img, { mode: "bw", threshold: 150 }).paths).toBe(1);
    expect(traceImage(img, { mode: "bw", threshold: 220 }).paths).toBe(2);
  });

  it("transparent pixels are background", () => {
    const img = canvas(100, 100, [0, 0, 0], 0);
    fillRect(img, 30, 30, 40, 40, [0, 0, 0]);
    const r = traceImage(img, { mode: "bw" });
    expect(r.paths).toBe(1);
    expect(Math.abs(contourArea(r.layers[0].contours[0]))).toBeCloseTo(1600, -1);
  });

  it("maps coordinates with (sx, sy, ox, oy)", () => {
    const img = canvas(100, 100);
    fillRect(img, 10, 20, 30, 40, BLACK);
    const r = traceImage(img, presetOptions("logo"), { sx: 2, sy: 0.5, ox: 100, oy: 7 });
    const xs = r.layers[0].contours[0].nodes.map((n) => n.anchor[0]), ys = r.layers[0].contours[0].nodes.map((n) => n.anchor[1]);
    expect(Math.min(...xs)).toBeCloseTo(120, 0);
    expect(Math.max(...xs)).toBeCloseTo(180, 0);
    expect(Math.min(...ys)).toBeCloseTo(17, 0);
    expect(Math.max(...ys)).toBeCloseTo(37, 0);
  });

  it("curves off → polygon whose vertices are all corners with straight segments", () => {
    const img = canvas(200, 200);
    fillDisk(img, 100, 100, 50, BLACK);
    const r = traceImage(img, { ...presetOptions("logo"), curves: false, precision: 1 });
    const c = r.layers[0].contours[0];
    expect(c.nodes.every((n) => n.isCorner && n.handleOut[0] === n.anchor[0] && n.handleOut[1] === n.anchor[1])).toBe(true);
    expect(c.nodes.length).toBeGreaterThan(12);
  });

  it("finer precision gives more anchors", () => {
    const img = canvas(300, 300);
    fillDisk(img, 150, 150, 100, BLACK);
    fillRect(img, 60, 60, 40, 180, [255, 255, 255]);
    const coarse = traceImage(img, { ...presetOptions("logo"), precision: 3 }).anchors;
    const fine = traceImage(img, { ...presetOptions("logo"), precision: 0.4 }).anchors;
    expect(fine).toBeGreaterThan(coarse);
  });
});

describe("image trace — colour", () => {
  const scene = () => {
    const img = canvas(240, 120);
    fillRect(img, 10, 10, 60, 60, [220, 30, 30]);
    fillRect(img, 90, 10, 60, 60, [30, 160, 40]);
    fillRect(img, 170, 10, 60, 100, [20, 40, 200]);
    return img;
  };

  it("finds the palette colours exactly and stacks layers by area (largest at the bottom)", () => {
    const r = traceImage(scene(), { ...presetOptions("color6"), colors: 4 });
    const cols = r.layers.map((l) => l.color);
    expect(cols.slice(0, 2)).toEqual(["#ffffff", "#1428c8"]);
    expect(cols.slice(2).sort()).toEqual(["#1ea028", "#dc1e1e"]); // equal areas: either order
    // stacked: the bottom layer covers every opaque pixel
    expect(evenOddArea(r.layers[0].contours)).toBeGreaterThan(240 * 120 * 0.99);
  });

  it("ignore white turns white regions into holes", () => {
    const r = traceImage(scene(), { ...presetOptions("color6"), colors: 4, ignoreWhite: true });
    expect(r.layers.some((l) => l.color === "#ffffff")).toBe(false);
    expect(r.layers.length).toBe(3);
    const total = evenOddArea(r.layers[0].contours);
    expect(Math.abs(total - (3600 + 3600 + 6000)) / 13200).toBeLessThan(0.01);
  });

  it("abut method traces each colour on its own (areas match pixel counts)", () => {
    const r = traceImage(scene(), { ...presetOptions("color6"), colors: 4, method: "abut", ignoreWhite: true });
    const blue = r.layers.find((l) => l.color === "#1428c8")!;
    expect(Math.abs(evenOddArea(blue.contours) - 6000) / 6000).toBeLessThan(0.01);
  });

  it("asking for more colours than exist never invents colours", () => {
    const r = traceImage(scene(), { ...presetOptions("color16") });
    expect(r.layers.length).toBe(4);
  });

  it("every preset runs and yields closed, editable contours", () => {
    const img = scene();
    fillDisk(img, 40, 90, 20, [250, 200, 0]);
    for (const p of TRACE_PRESETS) {
      const r = traceImage(img, presetOptions(p.id));
      expect(r.paths, p.id).toBeGreaterThan(0);
      for (const l of r.layers) for (const c of l.contours) {
        expect(c.closed).toBe(true);
        for (const n of c.nodes) expect([...n.anchor, ...n.handleIn, ...n.handleOut].every(Number.isFinite)).toBe(true);
      }
    }
  });
});

describe("despeckle", () => {
  it("merges small regions into the dominant neighbour, keeps border background", () => {
    const w = 10, h = 10, lab = new Uint8Array(w * h).fill(0);
    lab[55] = 1; // single pixel island
    lab[0] = 255; // corner background touching the border is kept
    despeckle(lab, w, h, 4);
    expect(lab[55]).toBe(0);
    expect(lab[0]).toBe(255);
  });
});

describe("image trace — degenerate inputs", () => {
  it("empty, fully transparent and 1 px images trace without throwing", () => {
    for (const mode of ["bw", "color"] as const) {
      expect(traceImage(newImg(0, 0), { mode }).paths).toBe(0);
      expect(traceImage(canvas(16, 16, [0, 0, 0], 0), { mode }).paths).toBe(0);
      const one = traceImage(canvas(1, 1, [0, 0, 0]), { mode, minArea: 1 });
      expect(one.layers.length).toBeLessThanOrEqual(1);
      const line = traceImage(canvas(40, 1, [0, 0, 0]), { mode, minArea: 1 });
      for (const l of line.layers) for (const c of l.contours) for (const n of c.nodes) for (const v of n.anchor) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
