import { flatten } from "../../src/core/vector";
import type { Contour, Vec2 } from "../../src/core/types";
import { newImg, type Img } from "../../src/core/image/pixels";

/** White opaque canvas. */
export function canvas(w: number, h: number, rgb: [number, number, number] = [255, 255, 255], a = 255): Img {
  const img = newImg(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0];
    img.data[i + 1] = rgb[1];
    img.data[i + 2] = rgb[2];
    img.data[i + 3] = a;
  }
  return img;
}

export function fillRect(img: Img, x: number, y: number, w: number, h: number, rgb: [number, number, number], a = 255) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = a;
    }
}

/** Disk by pixel-centre test (aliased). Returns the painted pixel count. */
export function fillDisk(img: Img, cx: number, cy: number, r: number, rgb: [number, number, number], a = 255): number {
  let n = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = a;
      n++;
    }
  return n;
}

export function px(img: Img, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

function shoelace(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

/** Signed area of a contour (flattened finely). */
export function contourArea(c: Contour): number {
  return shoelace(flatten(c, 0.05));
}

/** Filled area of a set of contours under the even-odd rule, assuming nesting = holes (sum of signed areas, abs). */
export function evenOddArea(cs: Contour[]): number {
  return Math.abs(cs.reduce((s, c) => s + contourArea(c), 0));
}

/** Gradient test image: R = x, G = y, B = 128 (for point-op checks). */
export function gradient(w = 256, h = 256): Img {
  const img = newImg(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = x & 255;
      img.data[i + 1] = y & 255;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  return img;
}
