// Labelled test pictures for the super-resolution classifier and the Auto choice (omw-* names; synthetic or from the
// repository's own screenshots — no personal files). JPEG damage is simulated the way a baseline JPEG encoder makes it:
// YCbCr 4:2:0, 8 × 8 DCT, the standard quantisation tables scaled by the quality (IJG formula), then back.

import { readFileSync } from "node:fs";
import { newImg, type Img } from "../../src/core/image/pixels";
import { decodePngRgba } from "../../src/io/formats/psdWrite";

const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99)];

function table(q: number, base: number[]) {
  const s = q < 50 ? 5000 / q : 200 - 2 * q;
  return base.map((v) => Math.max(1, Math.min(255, Math.floor((v * s + 50) / 100))));
}

const COS = Array.from({ length: 64 }, (_, k) => Math.cos(((2 * (k % 8) + 1) * Math.floor(k / 8) * Math.PI) / 16)); // [u*8+x]
const cu = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);

function dctBlock(b: Float64Array, q: number[]) {
  const F = new Float64Array(64);
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += b[y * 8 + x] * COS[u * 8 + x] * COS[v * 8 + y];
      F[v * 8 + u] = Math.round((0.25 * cu(u) * cu(v) * s) / q[v * 8 + u]) * q[v * 8 + u];
    }
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) s += cu(u) * cu(v) * F[v * 8 + u] * COS[u * 8 + x] * COS[v * 8 + y];
      b[y * 8 + x] = 0.25 * s;
    }
}

/** The picture after a JPEG save at quality q (1..100). */
export function jpegLike(img: Img, q: number): Img {
  const { width: w, height: h, data: d } = img;
  const ql = table(q, QL), qc = table(q, QC);
  const Y = new Float64Array(w * h), cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  const Cb = new Float64Array(cw * ch), Cr = new Float64Array(cw * ch), cn = new Float64Array(cw * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, r = d[p], g = d[p + 1], b = d[p + 2];
      Y[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      const c = (y >> 1) * cw + (x >> 1);
      Cb[c] += -0.168736 * r - 0.331264 * g + 0.5 * b;
      Cr[c] += 0.5 * r - 0.418688 * g - 0.081312 * b;
      cn[c]++;
    }
  for (let i = 0; i < Cb.length; i++) (Cb[i] /= cn[i]), (Cr[i] /= cn[i]);
  const plane = (P: Float64Array, pw: number, ph: number, qt: number[]) => {
    const b = new Float64Array(64);
    for (let by = 0; by < ph; by += 8)
      for (let bx = 0; bx < pw; bx += 8) {
        for (let k = 0; k < 64; k++) b[k] = P[Math.min(ph - 1, by + (k >> 3)) * pw + Math.min(pw - 1, bx + (k & 7))];
        dctBlock(b, qt);
        for (let k = 0; k < 64; k++) if (by + (k >> 3) < ph && bx + (k & 7) < pw) P[(by + (k >> 3)) * pw + bx + (k & 7)] = b[k];
      }
  };
  plane(Y, w, h, ql);
  plane(Cb, cw, ch, qc);
  plane(Cr, cw, ch, qc);
  const out = newImg(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const yy = Y[y * w + x] + 128, c = (y >> 1) * cw + (x >> 1), p = (y * w + x) * 4;
      out.data[p] = yy + 1.402 * Cr[c];
      out.data[p + 1] = yy - 0.344136 * Cb[c] - 0.714136 * Cr[c];
      out.data[p + 2] = yy + 1.772 * Cb[c];
      out.data[p + 3] = d[p + 3];
    }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function gaussNoise(img: Img, sigma: number, seed = 7): Img {
  const r = rng(seed), out = newImg(img.width, img.height);
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const g = Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
      out.data[i + c] = img.data[i + c] + sigma * g;
    }
    out.data[i + 3] = img.data[i + 3];
  }
  return out;
}

/** Photo-like: lit, textured surfaces (multi-octave noise), soft-edged objects, depth blur, slight sensor grain. */
export function omwPhoto(W: number, H: number, seed: number): Img {
  const img = newImg(W, H), d = img.data, r = rng(seed);
  const hash = (x: number, y: number, c: number) => {
    let n = (x * 374761393 + y * 668265263 + c * 1442695 + seed * 144269) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (x: number, y: number, c: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(x0, y0, c), b = hash(x0 + 1, y0, c), e = hash(x0, y0 + 1, c), f = hash(x0 + 1, y0 + 1, c);
    return a + (b - a) * sx + (e - a) * sy + (a - b - e + f) * sx * sy;
  };
  const blobs = Array.from({ length: 5 }, () => ({ x: r() * W, y: r() * H, r: (0.1 + r() * 0.25) * W, col: [r() * 255, r() * 255, r() * 255], soft: 1 + r() * 6 }));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const light = 0.55 + 0.45 * Math.cos((x / W - 0.3) * 2.2) * Math.cos((y / H - 0.4) * 1.8);
      let col = [90 + 80 * noise(x / 60, y / 60, 1), 110 + 60 * noise(x / 70, y / 50, 2), 80 + 70 * noise(x / 50, y / 80, 3)];
      for (const b of blobs) {
        const t = Math.max(0, Math.min(1, (b.r - Math.hypot(x - b.x, y - b.y)) / b.soft));
        if (t > 0) col = col.map((v, i) => v + t * (b.col[i] - v));
      }
      let tex = 0, amp = 0.5, fq = 1 / 6;
      for (let o = 0; o < 4; o++, amp *= 0.5, fq *= 2) tex += amp * (noise(x * fq, y * fq, 9 + o) - 0.5);
      const p = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) d[p + c] = col[c] * light * (1 + 0.35 * tex) + (r() - 0.5) * 3;
      d[p + 3] = 255;
    }
  return img;
}

/** Flat illustration: flat-coloured anti-aliased shapes with outlines. */
export function omwIllustration(W: number, H: number, seed: number): Img {
  const r = rng(seed), img = newImg(W, H), d = img.data;
  const shapes = Array.from({ length: 9 }, () => ({ x: r() * W, y: r() * H, rx: (0.06 + r() * 0.2) * W, ry: (0.06 + r() * 0.2) * H, col: [Math.round(r() * 5) * 51, Math.round(r() * 5) * 51, Math.round(r() * 5) * 51] }));
  const bg = [235, 228, 210];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0];
      for (let s = 0; s < 4; s++) {
        const X = x + 0.25 + (s & 1) * 0.5, Y = y + 0.25 + (s >> 1) * 0.5;
        let c = bg;
        for (const e of shapes) {
          const q = Math.hypot((X - e.x) / e.rx, (Y - e.y) / e.ry);
          if (q < 1) c = q > 0.93 ? [30, 25, 35] : e.col;
        }
        for (let k = 0; k < 3; k++) acc[k] += c[k];
      }
      const p = (y * W + x) * 4;
      d[p] = acc[0] / 4; d[p + 1] = acc[1] / 4; d[p + 2] = acc[2] / 4; d[p + 3] = 255;
    }
  return img;
}

/** Line art: dark strokes (curves and hatching) on paper white. */
export function omwLineArt(W: number, H: number, seed: number): Img {
  const r = rng(seed), img = newImg(W, H), d = img.data;
  const curves = Array.from({ length: 7 }, () => ({ cx: r() * W, cy: r() * H, R: (0.15 + r() * 0.4) * W, w: 0.8 + r() * 1.8 }));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let cov = 0;
      for (let s = 0; s < 4; s++) {
        const X = x + 0.25 + (s & 1) * 0.5, Y = y + 0.25 + (s >> 1) * 0.5;
        let ink = curves.some((c) => Math.abs(Math.hypot(X - c.cx, Y - c.cy) - c.R) < c.w);
        if (!ink && X < W * 0.35 && Y > H * 0.6) ink = Math.abs(((X + Y) % 9) - 4.5) < 0.7;
        cov += ink ? 1 : 0;
      }
      const v = 250 - (cov / 4) * 225, p = (y * W + x) * 4;
      d[p] = v; d[p + 1] = v; d[p + 2] = v - 4; d[p + 3] = 255;
    }
  return img;
}

/** A crop of one of the repository's own UI screenshots (text, icons, flat panels). */
export function omwScreenshot(file: string, W: number, H: number, x0 = 0, y0 = 0): Img {
  const p = decodePngRgba(new Uint8Array(readFileSync(file)));
  const img = newImg(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (Math.min(p.height - 1, y0 + y) * p.width + Math.min(p.width - 1, x0 + x)) * 4;
      img.data.set([p.rgba[s], p.rgba[s + 1], p.rgba[s + 2], 255], (y * W + x) * 4);
    }
  return img;
}

export interface Case {
  name: string;
  img: Img;
  content: "photo" | "art";
  damage: "low" | "mid" | "high";
}

/** The labelled set: clean pictures and their damaged versions. */
export function srSet(size = 192): Case[] {
  const S = size;
  const clean: [string, Img, "photo" | "art"][] = [
    ["omw-photo-1", omwPhoto(S, S, 1), "photo"],
    ["omw-photo-2", omwPhoto(S, S, 2), "photo"],
    ["omw-photo-3", omwPhoto(S, S, 3), "photo"],
    ["omw-illust-1", omwIllustration(S, S, 4), "art"],
    ["omw-illust-2", omwIllustration(S, S, 5), "art"],
    ["omw-lineart-1", omwLineArt(S, S, 6), "art"],
    ["omw-lineart-2", omwLineArt(S, S, 7), "art"],
    ["omw-screen-word", omwScreenshot("docs/design/ui-top-mockups/word.png", S, S, 40, 60), "art"],
    ["omw-screen-cad", omwScreenshot("docs/images/cad/cad-1-import.png", S, S, 200, 120), "art"],
  ];
  const out: Case[] = [];
  for (const [name, img, content] of clean) {
    out.push({ name, img, content, damage: "low" });
    out.push({ name: name + "-q80", img: jpegLike(img, 80), content, damage: "low" });
    out.push({ name: name + "-q50", img: jpegLike(img, 50), content, damage: "mid" });
    out.push({ name: name + "-q30", img: jpegLike(img, 30), content, damage: "high" });
    if (content === "photo") out.push({ name: name + "-noise12", img: gaussNoise(img, 12, name.length), content, damage: "high" });
  }
  return out;
}
