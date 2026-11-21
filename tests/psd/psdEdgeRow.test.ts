// QA 2026-11-19 item 2-1: a thin red line at a layer's top edge. It was the layer's own pixels (its first rows are
// stored opaque red, and Photoshop's merged image shows the same line), not a decode or compositing artefact. These
// tests pin that a layer's edge rows are read exactly as stored (RLE row by row, no bleed into the next row) and that
// our layers composite to Photoshop's merged image there. Fixture synthesized with the writer; no user content.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodePsd } from "../../src/io/formats/psd";
import { buildPsd } from "../../src/io/formats/psdWrite";

/** a 256-wide layer: row 0 opaque red, row 1 red on the left 144 px then transparent, the rest faint white */
function edgeLayer(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const red = y === 0 || (y === 1 && x < 144);
      px.set(red ? [255, 0, 0, 255] : [255, 255, 255, y === 1 ? 0 : 20], i);
    }
  return px;
}

describe("PSD layer edge rows (QA 2-1)", () => {
  it("reads the top rows as stored, without bleeding into the rows below", () => {
    const w = 256, h = 6;
    const bg = new Uint8Array(300 * 20 * 4).fill(250);
    const bytes = buildPsd({
      width: 300,
      height: 20,
      layers: [
        { name: "omni-bg", px: { rgba: bg, left: 0, top: 0, width: 300, height: 20 }, opacity: 1, visible: true, blend: "NORMAL" },
        { name: "omni-edge", px: { rgba: edgeLayer(w, h), left: 20, top: 8, width: w, height: h }, opacity: 1, visible: true, blend: "NORMAL" },
      ],
    });
    const img = decodePsd(bytes);
    const l = img.layers.find((k) => k.name === "omni-edge")!;
    expect([l.left, l.top, l.width, l.height]).toEqual([20, 8, w, h]);
    const at = (x: number, y: number) => Array.from(l.rgba!.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
    expect(at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(255, 0)).toEqual([255, 0, 0, 255]);
    expect(at(143, 1)).toEqual([255, 0, 0, 255]);
    expect(at(144, 1)[3]).toBe(0);
    for (let y = 2; y < h; y++) for (let x = 0; x < w; x += 17) expect(at(x, y)).toEqual([255, 255, 255, 20]);
  });

  // the user's file (never committed): OMW_QA_PSD_2_1=<path to the reported PSD>
  const user = process.env.OMW_QA_PSD_2_1;
  it.skipIf(!user || !existsSync(user))("the reported file: our layers composite to Photoshop's merged image", () => {
    const img = decodePsd(new Uint8Array(readFileSync(user!)));
    const W = img.width, H = img.height, out = new Float32Array(W * H * 3);
    for (const l of img.layers) {
      if (!l.rgba || !l.visible || l.blend !== "norm" || l.opacity < 1) continue;
      for (let y = 0; y < l.height; y++)
        for (let x = 0; x < l.width; x++) {
          const X = x + l.left, Y = y + l.top;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const i = (y * l.width + x) * 4, o = (Y * W + X) * 3, a = l.rgba[i + 3] / 255;
          for (let k = 0; k < 3; k++) out[o + k] = out[o + k] * (1 - a) + l.rgba[i + k] * a;
        }
    }
    let worst = 0;
    for (let p = 0; p < W * H; p++) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[p * 3 + k] - img.composite![p * 4 + k]));
    expect(worst).toBeLessThan(40);
  });
});
