// Synthetic test scenes shared by tests/image/perf.test.ts and bench/image.node.ts.

import { newImg, type Img } from "../../src/core/image/pixels";

/** 1000×1000 logo-like scene: anti-aliased ring, disks, bars and a diagonal band (4× supersampled coverage). */
export function logo(colour: boolean): Img {
  const W = 1000, img = newImg(W, W);
  const shapes: { inside: (x: number, y: number) => boolean; rgb: [number, number, number] }[] = [
    { inside: (x, y) => { const d = Math.hypot(x - 500, y - 500); return d < 420 && d > 300; }, rgb: colour ? [220, 40, 40] : [0, 0, 0] },
    { inside: (x, y) => Math.hypot(x - 500, y - 500) < 180, rgb: colour ? [30, 90, 200] : [0, 0, 0] },
    { inside: (x, y) => x > 120 && x < 880 && y > 470 && y < 530, rgb: colour ? [250, 190, 20] : [0, 0, 0] },
    { inside: (x, y) => Math.abs(x - y) < 25 && x > 100 && x < 900, rgb: colour ? [20, 150, 80] : [0, 0, 0] },
    { inside: (x, y) => Math.hypot(x - 150, y - 150) < 60 || Math.hypot(x - 850, y - 150) < 60, rgb: colour ? [120, 40, 160] : [0, 0, 0] },
  ];
  const d = img.data;
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const X = x + 0.25 + sx * 0.5, Y = y + 0.25 + sy * 0.5;
          let c: [number, number, number] = [255, 255, 255];
          for (const s of shapes) if (s.inside(X, Y)) c = s.rgb;
          r += c[0]; g += c[1]; b += c[2];
        }
      const i = (y * W + x) * 4;
      d[i] = r / 4; d[i + 1] = g / 4; d[i + 2] = b / 4; d[i + 3] = 255;
    }
  return img;
}

export function photo(W: number, H: number): Img {
  const img = newImg(W, H), d = img.data;
  let s = 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      s = (s * 16807) % 2147483647;
      const n = (s / 2147483647 - 0.5) * 30;
      const i = (y * W + x) * 4;
      d[i] = 128 + 100 * Math.sin(x / 70) + n;
      d[i + 1] = 128 + 100 * Math.cos(y / 50) + n;
      d[i + 2] = 128 + 60 * Math.sin((x + y) / 90) + n;
      d[i + 3] = 255;
    }
  return img;
}
