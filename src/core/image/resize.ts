// Resampling for 이미지 크기 (Photoshop's Image Size): nearest neighbour, bilinear, bicubic (Keys a = −0.5) and
// "자동" (bicubic; area-averaged first when shrinking past half, as Photoshop's 자동 picks bicubic sharper there).
// Colours are weighted by alpha (premultiplied), so transparent pixels do not darken edges. Pure (no DOM).

import { downscale, newImg, type Img } from "./pixels";

export type Resample = "auto" | "bicubic" | "bilinear" | "nearest";

const cubic = (x: number) => {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
  if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
  return 0;
};

/** `img` resampled to w × h. */
export function resizeImg(img: Img, w: number, h: number, how: Resample = "auto"): Img {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w === img.width && h === img.height) return { width: w, height: h, data: new Uint8ClampedArray(img.data) };
  let src = img;
  if (how === "auto" && (w < img.width / 2 || h < img.height / 2)) {
    // area average down to twice the target first: no aliasing, then a bicubic step to the exact size
    src = downscale(img, 2 * (img.width >= img.height ? w : h)).img;
  }
  const out = newImg(w, h);
  const sw = src.width, sh = src.height, s = src.data, d = out.data;
  const kx = sw / w, ky = sh / h;
  if (how === "nearest") {
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, Math.floor((y + 0.5) * ky));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, Math.floor((x + 0.5) * kx));
        d.set(s.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * w + x) * 4);
      }
    }
    return out;
  }
  const bil = how === "bilinear";
  const R = bil ? 1 : 2;
  const kern = bil ? (x: number) => Math.max(0, 1 - Math.abs(x)) : cubic;
  // separable: horizontal pass into a float buffer (premultiplied), then vertical
  const tmp = new Float32Array(w * sh * 4);
  const shrinkX = Math.max(1, kx), shrinkY = Math.max(1, ky);
  for (let x = 0; x < w; x++) {
    const cx = (x + 0.5) * kx - 0.5;
    const r = R * (how === "auto" ? 1 : shrinkX);
    const x0 = Math.floor(cx - r) + 1, x1 = Math.floor(cx + r);
    const ws: number[] = [], xs: number[] = [];
    let sum = 0;
    for (let sx = x0; sx <= x1; sx++) {
      const wt = kern((sx - cx) / (how === "auto" ? 1 : shrinkX));
      if (!wt) continue;
      ws.push(wt);
      xs.push(Math.min(sw - 1, Math.max(0, sx)));
      sum += wt;
    }
    for (let y = 0; y < sh; y++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let k = 0; k < ws.length; k++) {
        const i = (y * sw + xs[k]) * 4, a = s[i + 3] * ws[k];
        r0 += s[i] * a; g0 += s[i + 1] * a; b0 += s[i + 2] * a; a0 += a;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r0 / sum; tmp[o + 1] = g0 / sum; tmp[o + 2] = b0 / sum; tmp[o + 3] = a0 / sum;
    }
  }
  for (let y = 0; y < h; y++) {
    const cy = (y + 0.5) * ky - 0.5;
    const r = R * (how === "auto" ? 1 : shrinkY);
    const y0 = Math.floor(cy - r) + 1, y1 = Math.floor(cy + r);
    const ws: number[] = [], ys: number[] = [];
    let sum = 0;
    for (let sy = y0; sy <= y1; sy++) {
      const wt = kern((sy - cy) / (how === "auto" ? 1 : shrinkY));
      if (!wt) continue;
      ws.push(wt);
      ys.push(Math.min(sh - 1, Math.max(0, sy)));
      sum += wt;
    }
    for (let x = 0; x < w; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let k = 0; k < ws.length; k++) {
        const i = (ys[k] * w + x) * 4, wt = ws[k];
        r0 += tmp[i] * wt; g0 += tmp[i + 1] * wt; b0 += tmp[i + 2] * wt; a0 += tmp[i + 3] * wt;
      }
      const o = (y * w + x) * 4;
      const a = a0 / sum;
      if (a > 0.5) {
        d[o] = r0 / sum / a;
        d[o + 1] = g0 / sum / a;
        d[o + 2] = b0 / sum / a;
      }
      d[o + 3] = a;
    }
  }
  return out;
}

/** A grey plane (one byte a pixel) resampled the same way (layer masks). */
export function resizePlane(p: Uint8Array, w0: number, h0: number, w: number, h: number, how: Resample = "auto"): Uint8Array {
  const img = newImg(w0, h0);
  for (let i = 0; i < p.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = p[i];
    img.data[i * 4 + 3] = 255;
  }
  const r = resizeImg(img, w, h, how);
  const out = new Uint8Array(r.width * r.height);
  for (let i = 0; i < out.length; i++) out[i] = r.data[i * 4];
  return out;
}
