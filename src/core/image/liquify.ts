// 픽셀 유동화 (Photoshop's Liquify, forward warp ‘W’ and reconstruct ‘R’): a displacement field the brush pushes,
// sampled backwards — each output pixel reads the source at its place plus the field there (bilinear). The field is
// kept at the dialog's preview size and scaled to the picture when applied, so the result matches the preview.

import { newImg, type Img } from "./pixels";

export interface LiquifyField {
  w: number;
  h: number;
  /** source offset (field px) per field pixel, x then y interleaved */
  d: Float32Array;
}

export const newField = (w: number, h: number): LiquifyField => ({ w, h, d: new Float32Array(w * h * 2) });

const lerpField = (f: LiquifyField, x: number, y: number, out: [number, number]) => {
  const x0 = Math.max(0, Math.min(f.w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(f.h - 1, Math.floor(y)));
  const x1 = Math.min(f.w - 1, x0 + 1), y1 = Math.min(f.h - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, x - x0)), ay = Math.max(0, Math.min(1, y - y0));
  for (let k = 0; k < 2; k++) {
    const a = f.d[(y0 * f.w + x0) * 2 + k], b = f.d[(y0 * f.w + x1) * 2 + k];
    const c = f.d[(y1 * f.w + x0) * 2 + k], e = f.d[(y1 * f.w + x1) * 2 + k];
    out[k] = (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + e * ax) * ay;
  }
};

/**
 * 앞으로 밀기 (forward warp): the brush at (cx, cy), radius r, moved by (vx, vy) — what is under it goes along, most at
 * the centre (smooth falloff). `pressure` 0…1 is Photoshop's brush pressure.
 */
export function pushField(f: LiquifyField, cx: number, cy: number, vx: number, vy: number, r: number, pressure = 1) {
  if (r <= 0 || (!vx && !vy)) return;
  const old = new Float32Array(f.d);
  const src = { w: f.w, h: f.h, d: old };
  const tmp: [number, number] = [0, 0];
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(f.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(f.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const q = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
      if (q >= 1) continue;
      const w = (1 - q) * (1 - q) * pressure;
      // the pixel now shows what was w·v behind it
      const sx = x - w * vx, sy = y - w * vy;
      lerpField(src, sx, sy, tmp);
      const i = (y * f.w + x) * 2;
      f.d[i] = tmp[0] + (sx - x);
      f.d[i + 1] = tmp[1] + (sy - y);
    }
}

/** 재구성 (reconstruct): the field under the brush eased back toward none. */
export function restoreField(f: LiquifyField, cx: number, cy: number, r: number, amount = 0.3) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(f.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(f.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const q = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r);
      if (q >= 1) continue;
      const k = 1 - amount * (1 - q);
      const i = (y * f.w + x) * 2;
      f.d[i] *= k;
      f.d[i + 1] *= k;
    }
}

export const fieldIsEmpty = (f: LiquifyField) => !f.d.some((v) => Math.abs(v) > 1e-3);

/** The picture with the field applied (the field stretched over the whole picture). */
export function liquifyImg(img: Img, f: LiquifyField): Img {
  const W = img.width, H = img.height, out = newImg(W, H);
  const s = img.data, o = out.data;
  const kx = f.w / W, ky = f.h / H;
  const tmp: [number, number] = [0, 0];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      lerpField(f, (x + 0.5) * kx - 0.5, (y + 0.5) * ky - 0.5, tmp);
      let sx = x + tmp[0] / kx, sy = y + tmp[1] / ky;
      sx = Math.max(0, Math.min(W - 1, sx));
      sy = Math.max(0, Math.min(H - 1, sy));
      const ax0 = Math.floor(sx), ay0 = Math.floor(sy), ax1 = Math.min(W - 1, ax0 + 1), ay1 = Math.min(H - 1, ay0 + 1);
      const fx = sx - ax0, fy = sy - ay0;
      const i = (y * W + x) * 4;
      const p00 = (ay0 * W + ax0) * 4, p10 = (ay0 * W + ax1) * 4, p01 = (ay1 * W + ax0) * 4, p11 = (ay1 * W + ax1) * 4;
      for (let c = 0; c < 4; c++) o[i + c] = Math.round((s[p00 + c] * (1 - fx) + s[p10 + c] * fx) * (1 - fy) + (s[p01 + c] * (1 - fx) + s[p11 + c] * fx) * fy);
    }
  return out;
}
