// OCR — text detection. Model: PP-OCRv5 mobile detector (PP-LCNetV3 + RSE-FPN + DB head, Apache-2.0) as a Loom
// Infer graph. DB = Differentiable Binarization (Liao et al., AAAI 2020): the network predicts a "shrunk text"
// probability map; text instances are the connected regions above a threshold, grown back by the unclip distance
// D = A·r / L (area, perimeter, r = 1.5).
//
// Documents are deskewed before detection, so boxes are axis-aligned rectangles (no polygon clipping library).

import type { Img } from "../pixels";
import { runGraph, type GraphModel, type Tensor } from "../infer/graph";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetBox extends Box {
  /** mean probability inside the region */
  score: number;
  /** the shrunk core (before unclip): close to the ink extent, used for font size estimates */
  core: Box;
}

export interface DetOptions {
  /** longest side fed to the network (multiple of 32); larger = small print found, slower */
  maxSide?: number;
  thresh?: number;
  boxThresh?: number;
  unclip?: number;
}

/** Resize to the network size (multiples of 32) and normalize (B, G, R planes, ImageNet mean/std as the reference). */
export function detInput(img: Img, maxSide: number, mean: number[], std: number[]): { x: Tensor; sx: number; sy: number } {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(32, Math.round((img.width * s) / 32) * 32), h = Math.max(32, Math.round((img.height * s) / 32) * 32);
  const sx = img.width / w, sy = img.height / h;
  const d = new Float32Array(3 * w * h);
  const src = img.data, W = img.width;
  // area average when shrinking (keeps thin strokes), bilinear-ish nearest when not
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, ws = 0;
      for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(W, Math.ceil(x1)); xx++) {
          const wt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const i = (yy * W + xx) * 4, a = src[i + 3] / 255;
          r += wt * (src[i] * a + 255 * (1 - a));
          g += wt * (src[i + 1] * a + 255 * (1 - a));
          b += wt * (src[i + 2] * a + 255 * (1 - a));
          ws += wt;
        }
      }
      const p = y * w + x;
      d[p] = (b / ws / 255 - mean[0]) / std[0];
      d[w * h + p] = (g / ws / 255 - mean[1]) / std[1];
      d[2 * w * h + p] = (r / ws / 255 - mean[2]) / std[2];
    }
  }
  return { x: { s: [1, 3, h, w], d, int: false }, sx, sy };
}

/** Connected regions of prob > thresh → boxes in image coordinates. */
export function dbBoxes(prob: Float32Array, w: number, h: number, sx: number, sy: number, imgW: number, imgH: number, o: DetOptions = {}): DetBox[] {
  const thresh = o.thresh ?? 0.3, boxThresh = o.boxThresh ?? 0.6, ratio = o.unclip ?? 1.5;
  const lab = new Int32Array(w * h).fill(-1);
  const out: DetBox[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] !== -1 || prob[s] <= thresh) continue;
    // flood fill (8-connected)
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0, sum = 0;
    lab[s] = s;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w, py = (p - px) / w;
      n++;
      sum += prob[p];
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx, qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
          const q = qy * w + qx;
          if (lab[q] === -1 && prob[q] > thresh) {
            lab[q] = s;
            stack.push(q);
          }
        }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < 2 || n < 6) continue;
    const score = sum / n;
    if (score < boxThresh) continue;
    // unclip: offset the rectangle by D = A·r / L
    const D = (bw * bh * ratio) / (2 * (bw + bh));
    const ux0 = Math.max(0, (x0 - D) * sx), uy0 = Math.max(0, (y0 - D) * sy);
    const ux1 = Math.min(imgW, (x1 + 1 + D) * sx), uy1 = Math.min(imgH, (y1 + 1 + D) * sy);
    out.push({ x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0, score, core: { x: x0 * sx, y: y0 * sy, w: bw * sx, h: bh * sy } });
  }
  return out;
}

export interface DetResult {
  boxes: DetBox[];
  /** network input size */
  size: [number, number];
  ms: number;
}

export function detectText(model: GraphModel, img: Img, o: DetOptions = {}): DetResult {
  const t0 = performance.now();
  const { x, sx, sy } = detInput(img, o.maxSide ?? 1536, model.meta.mean, model.meta.std);
  return detResult(runGraph(model, x), x, sx, sy, img, o, t0);
}

/** detectText with the network run elsewhere (WebGPU, infer/graphGpu.ts). */
export async function detectTextWith(run: (x: Tensor) => Promise<Tensor>, model: GraphModel, img: Img, o: DetOptions = {}): Promise<DetResult> {
  const t0 = performance.now();
  const { x, sx, sy } = detInput(img, o.maxSide ?? 1536, model.meta.mean, model.meta.std);
  return detResult(await run(x), x, sx, sy, img, o, t0);
}

function detResult(y: Tensor, x: Tensor, sx: number, sy: number, img: Img, o: DetOptions, t0: number): DetResult {
  const boxes = dbBoxes(y.d, y.s[3], y.s[2], sx, sy, img.width, img.height, o);
  return { boxes, size: [x.s[3], x.s[2]], ms: performance.now() - t0 };
}
