// Procedural, labelled test pictures for background removal (no third-party images). Every case has a known type and,
// where it makes sense, the exact ground-truth alpha (coverage by 4×4 supersampling, hair / fur strands included).

import { newImg, type Img } from "../../src/core/image/pixels";
import type { MatteType } from "../../src/core/image/matte/classify";

export interface Case {
  name: string;
  type: MatteType;
  img: Img;
  /** ground-truth alpha 0..1 (null = no single right answer, e.g. a busy scene) */
  gt: Float32Array | null;
}

type RGB = [number, number, number];

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Inside test with an optional bounding box [x0, y0, x1, y1] (lets the renderer skip far shapes quickly). */
type Cov = ((x: number, y: number) => boolean) & { box?: [number, number, number, number] };
/** A layer painter: coverage(x, y) in 0..1 at sub-pixel positions, colour(x, y). */
type Shape = { cov: Cov; col: (x: number, y: number) => RGB; alpha?: number; inGt?: boolean };
const withBox = (f: (x: number, y: number) => boolean, box: [number, number, number, number]): Cov => Object.assign(f, { box });

/** Render shapes over a background with 4×4 supersampling. Returns image + coverage of the shapes marked inGt. */
function render(W: number, H: number, bg: (x: number, y: number) => RGB, shapes: Shape[], bgAlpha = 255): { img: Img; gt: Float32Array } {
  const img = newImg(W, H);
  const gt = new Float32Array(W * H);
  const SS = 4;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const near = shapes.filter((s) => !s.cov.box || (x + 1 >= s.cov.box[0] && x <= s.cov.box[2] && y + 1 >= s.cov.box[1] && y <= s.cov.box[3]));
      let r = 0, g = 0, b = 0, a = 0, cov = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          let c: RGB = bg(px, py);
          let al = bgAlpha / 255;
          let gc = 0;
          for (const s of near) {
            if (!s.cov(px, py)) continue;
            const sa = s.alpha ?? 1;
            const sc = s.col(px, py);
            c = [c[0] * (1 - sa) + sc[0] * sa, c[1] * (1 - sa) + sc[1] * sa, c[2] * (1 - sa) + sc[2] * sa];
            al = al + sa * (1 - al);
            if (s.inGt !== false) gc = gc + sa * (1 - gc);
            else gc = gc * (1 - sa);
          }
          r += c[0] * al;
          g += c[1] * al;
          b += c[2] * al;
          a += al;
          cov += gc;
        }
      const i = (y * W + x) * 4;
      img.data[i] = a ? r / a : 0;
      img.data[i + 1] = a ? g / a : 0;
      img.data[i + 2] = a ? b / a : 0;
      img.data[i + 3] = (a / (SS * SS)) * 255;
      gt[y * W + x] = cov / (SS * SS);
    }
  return { img, gt };
}

const ellipse = (cx: number, cy: number, rx: number, ry: number) => withBox((x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, [cx - rx, cy - ry, cx + rx, cy + ry]);
const rect = (x0: number, y0: number, x1: number, y1: number) => withBox((x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1, [x0, y0, x1, y1]);
const roundRect = (x0: number, y0: number, x1: number, y1: number, r: number) => withBox((x: number, y: number) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x1 - r, x)), cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}, [x0, y0, x1, y1]);
const solid = (c: RGB) => () => c;
/** thick polyline (segments) */
const strokes = (pts: [number, number][], wid: number) => withBox((x: number, y: number) => {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= (wid / 2) ** 2) return true;
  }
  return false;
}, [Math.min(...pts.map((p) => p[0])) - wid, Math.min(...pts.map((p) => p[1])) - wid, Math.max(...pts.map((p) => p[0])) + wid, Math.max(...pts.map((p) => p[1])) + wid]);
const noise = (R: () => number, amp: number) => (c: RGB): RGB => {
  const n = (R() - 0.5) * 2 * amp;
  return [c[0] + n, c[1] + n, c[2] + n];
};

/** value noise (smooth), for textures */
function valueNoise(seed: number, cell: number) {
  const R = rng(seed);
  const G = 64, g = new Float32Array(G * G).map(() => R());
  return (x: number, y: number) => {
    const fx = x / cell, fy = y / cell;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const v = (i: number, j: number) => g[(((j % G) + G) % G) * G + (((i % G) + G) % G)];
    const s = (t: number) => t * t * (3 - 2 * t);
    const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * s(tx);
    const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * s(tx);
    return a + (b - a) * s(ty);
  };
}

export function transparentCase(seed: number, W = 320, H = 240): Case {
  const R = rng(seed);
  const col: RGB = [R() * 255, R() * 255, R() * 255];
  const { img, gt } = render(W, H, () => [0, 0, 0], [{ cov: ellipse(W / 2, H / 2, W * 0.3, H * 0.35), col: solid(col) }, { cov: rect(W * 0.2, H * 0.6, W * 0.8, H * 0.7), col: solid([255 - col[0], 200, 90]) }], 0);
  return { name: `transparent-${seed}`, type: "transparent", img, gt };
}

export function graphicCase(seed: number, W = 360, H = 240): Case {
  const R = rng(seed);
  const bg: RGB = R() < 0.5 ? [255, 255, 255] : [Math.round(200 + R() * 55), Math.round(200 + R() * 55), Math.round(180 + R() * 75)];
  const c1: RGB = [Math.round(R() * 120), Math.round(R() * 160), Math.round(100 + R() * 155)];
  const c2: RGB = [Math.round(180 + R() * 75), Math.round(R() * 90), Math.round(R() * 60)];
  const shapes: Shape[] = [
    // ring ("O"): the hole is background
    { cov: (x, y) => ellipse(W * 0.25, H * 0.5, H * 0.3, H * 0.3)(x, y) && !ellipse(W * 0.25, H * 0.5, H * 0.17, H * 0.17)(x, y), col: solid(c1) },
    { cov: roundRect(W * 0.5, H * 0.25, W * 0.85, H * 0.45, 10), col: solid(c2) },
    { cov: strokes([[W * 0.5, H * 0.7], [W * 0.62, H * 0.58], [W * 0.74, H * 0.75], [W * 0.88, H * 0.6]], 9), col: solid(c1) },
  ];
  const { img, gt } = render(W, H, solid(bg), shapes);
  return { name: `graphic-${seed}`, type: "graphic", img, gt };
}

export function documentCase(seed: number, W = 420, H = 300): Case {
  const R = rng(seed);
  const paper: RGB = [246 - R() * 10, 240 - R() * 12, 222 - R() * 20];
  const N = rng(seed + 99);
  const light = (x: number, y: number) => 1 - 0.12 * (((x - W * 0.3) / W) ** 2 + ((y - H * 0.4) / H) ** 2) * 3;
  const pts: [number, number][] = [];
  let x = W * 0.12, y = H * 0.55;
  for (let i = 0; i < 14; i++) {
    pts.push([x, y]);
    x += W * (0.03 + R() * 0.04);
    y = H * (0.42 + R() * 0.25);
  }
  const ink: RGB = R() < 0.5 ? [20, 30, 110] : [25, 25, 30];
  const stampC: RGB = [200, 30, 40];
  const shapes: Shape[] = [
    { cov: strokes(pts, 3), col: solid(ink) },
    { cov: strokes([[W * 0.15, H * 0.8], [W * 0.55, H * 0.82]], 2), col: solid(ink) },
    { cov: (px, py) => ellipse(W * 0.78, H * 0.35, 46, 46)(px, py) && !ellipse(W * 0.78, H * 0.35, 40, 40)(px, py), col: solid(stampC), alpha: 0.9 },
    { cov: (px, py) => rect(W * 0.78 - 22, H * 0.35 - 20, W * 0.78 + 22, H * 0.35 + 20)(px, py) && Math.floor((py - (H * 0.35 - 20)) / 6) % 2 === 0, col: solid(stampC), alpha: 0.9 },
  ];
  const { img, gt } = render(W, H, (px, py) => noise(N, 5)(paper.map((v) => v * light(px, py)) as RGB), shapes);
  return { name: `document-${seed}`, type: "document", img, gt };
}

/** Person-like figure used by portrait and chroma cases. Returns its shapes (hair strands with partial alpha). */
function person(W: number, H: number, R: () => number, skin: RGB, hair: RGB, shirt: RGB): Shape[] {
  const cx = W * (0.45 + R() * 0.1), hy = H * 0.36, hr = H * 0.17;
  const strands: Shape[] = [];
  for (let i = 0; i < 40; i++) {
    const a = -Math.PI * (0.1 + 0.8 * R());
    const r0 = hr * 1.0, r1 = hr * (1.12 + R() * 0.2);
    const p0: [number, number] = [cx + Math.cos(a) * r0, hy + Math.sin(a) * r0 * 1.1];
    const p1: [number, number] = [cx + Math.cos(a + (R() - 0.5) * 0.2) * r1, hy + Math.sin(a) * r1 * 1.15];
    strands.push({ cov: strokes([p0, p1], 1.2), col: solid(hair), alpha: 0.85 });
  }
  return [
    { cov: (x, y) => ellipse(cx, H * 1.02, W * 0.33, H * 0.36)(x, y), col: (x) => shirt.map((v) => v * (0.8 + 0.2 * Math.sin(x / 9))) as RGB },
    { cov: rect(cx - hr * 0.42, hy + hr * 0.6, cx + hr * 0.42, H * 0.75), col: solid(skin.map((v) => v * 0.92) as RGB) },
    { cov: ellipse(cx, hy, hr * 0.85, hr * 1.1), col: (x, y) => skin.map((v) => v * (1 - 0.1 * ((x - cx) / hr) ** 2 - 0.05 * ((y - hy) / hr))) as RGB },
    { cov: (x, y) => ellipse(cx, hy - hr * 0.25, hr * 1.0, hr * 0.95)(x, y) && y < hy - hr * 0.2, col: solid(hair) },
    { cov: ellipse(cx - hr * 0.33, hy + hr * 0.05, hr * 0.1, hr * 0.06), col: solid([40, 30, 30]) },
    { cov: ellipse(cx + hr * 0.33, hy + hr * 0.05, hr * 0.1, hr * 0.06), col: solid([40, 30, 30]) },
    { cov: ellipse(cx, hy + hr * 0.55, hr * 0.3, hr * 0.08), col: solid([170, 80, 80]) },
    ...strands,
  ];
}

const SKINS: RGB[] = [[232, 190, 160], [210, 160, 125], [175, 120, 90], [240, 200, 175]];
const HAIRS: RGB[] = [[40, 28, 20], [90, 60, 35], [20, 20, 22], [150, 110, 60]];

export function portraitCase(seed: number, W = 360, H = 400): Case {
  const R = rng(seed);
  const vn = valueNoise(seed, 40);
  const b1: RGB = [R() * 200 + 30, R() * 200 + 30, R() * 200 + 30], b2: RGB = [R() * 200 + 30, R() * 200 + 30, R() * 200 + 30];
  const bg = (x: number, y: number): RGB => {
    const t = vn(x, y);
    return [b1[0] * t + b2[0] * (1 - t), b1[1] * t + b2[1] * (1 - t), b1[2] * t + b2[2] * (1 - t)];
  };
  const shirt: RGB = [R() * 200, R() * 200, R() * 200];
  const { img, gt } = render(W, H, bg, person(W, H, R, SKINS[seed % 4], HAIRS[(seed >> 1) % 4], shirt));
  return { name: `portrait-${seed}`, type: "portrait", img, gt };
}

export function chromaCase(seed: number, W = 360, H = 360): Case {
  const R = rng(seed);
  const blue = seed % 3 === 2;
  const screen: RGB = blue ? [30, 70, 200] : [50, 185, 70];
  const N = rng(seed + 7);
  // wardrobe avoids the key colour (as on a real set): warm reds / browns / greys
  const shapes = person(W, H, R, SKINS[seed % 4], HAIRS[seed % 4], [R() * 100 + 130, R() * 80 + 40, R() * 50 + 30]);
  const { img, gt } = render(W, H, (x, y) => noise(N, 6)(screen.map((v) => v * (0.85 + 0.15 * Math.sin(x / 60 + y / 80))) as RGB), shapes);
  // spill: edge pixels of the subject pick up the screen colour
  const k = blue ? 2 : 1;
  for (let p = 0; p < W * H; p++) if (gt[p] > 0.5 && gt[p] < 1) img.data[p * 4 + k] = Math.min(255, img.data[p * 4 + k] + 35);
  return { name: `chroma-${seed}`, type: "chroma", img, gt };
}

export function productCase(seed: number, W = 400, H = 400): Case {
  const R = rng(seed);
  const top = 225 + R() * 20, bot = 248;
  const tint: RGB = R() < 0.5 ? [1, 1, 1] : [1, 0.97, 0.94];
  const N = rng(seed + 3);
  const cx = W * (0.4 + R() * 0.2), base = H * 0.78;
  const bw = W * (0.14 + R() * 0.1), bh = H * (0.38 + R() * 0.15);
  const col: RGB = [R() * 200 + 20, R() * 200 + 20, R() * 200 + 20];
  const bg = (x: number, y: number): RGB => {
    const v = top + (bot - top) * (y / H);
    // soft contact shadow under the object
    const sh = Math.exp(-(((x - cx) / (bw * 1.3)) ** 2) - (((y - base) / 10) ** 2)) * 0.35;
    return noise(N, 1.5)([v * tint[0] * (1 - sh), v * tint[1] * (1 - sh), v * tint[2] * (1 - sh)]);
  };
  const shapes: Shape[] = [
    { cov: roundRect(cx - bw, base - bh, cx + bw, base, 18), col: (x) => col.map((v) => v * (0.7 + 0.45 * Math.sin(((x - cx + bw) / (2 * bw)) * Math.PI))) as RGB },
    { cov: roundRect(cx - bw * 0.35, base - bh - H * 0.08, cx + bw * 0.35, base - bh + 4, 6), col: solid([40, 40, 45]) },
    { cov: rect(cx - bw * 0.8, base - bh * 0.6, cx + bw * 0.8, base - bh * 0.35), col: solid([245, 245, 240]) },
  ];
  const { img, gt } = render(W, H, bg, shapes);
  return { name: `product-${seed}`, type: "product", img, gt };
}

export function animalCase(seed: number, W = 420, H = 340): Case {
  const R = rng(seed);
  const vn = valueNoise(seed, 6), vn2 = valueNoise(seed + 1, 30);
  const bg = (x: number, y: number): RGB => {
    const t = vn(x * 0.3, y * 2) * 0.6 + vn2(x, y) * 0.4;
    return [60 + 60 * t, 110 + 70 * t, 40 + 30 * t];
  };
  const fur: RGB = R() < 0.5 ? [190, 120, 60] : [120, 100, 85];
  const fn = valueNoise(seed + 5, 2);
  const furCol = (x: number, y: number): RGB => {
    const t = 0.7 + 0.5 * fn(x, y * 3);
    return [fur[0] * t, fur[1] * t, fur[2] * t];
  };
  const cx = W * 0.48, cy = H * 0.58, rx = W * 0.26, ry = H * 0.22;
  const hx = cx + rx * 0.95, hy = cy - ry * 0.9, hr = H * 0.14;
  const strands: Shape[] = [];
  for (let i = 0; i < 220; i++) {
    const a = R() * Math.PI * 2;
    const onHead = R() < 0.3;
    const [ox, oy, ex, ey] = onHead ? [hx, hy, hr, hr] : [cx, cy, rx, ry];
    const p0: [number, number] = [ox + Math.cos(a) * ex * 0.95, oy + Math.sin(a) * ey * 0.95];
    const len = 6 + R() * 12;
    const p1: [number, number] = [p0[0] + Math.cos(a + (R() - 0.5) * 0.6) * len, p0[1] + Math.sin(a + (R() - 0.5) * 0.6) * len];
    strands.push({ cov: strokes([p0, p1], 1.3), col: furCol, alpha: 0.8 });
  }
  const shapes: Shape[] = [
    { cov: ellipse(cx, cy, rx, ry), col: furCol },
    { cov: ellipse(hx, hy, hr, hr), col: furCol },
    { cov: (x, y) => ellipse(hx - hr * 0.5, hy - hr * 0.9, hr * 0.3, hr * 0.5)(x, y), col: furCol },
    { cov: (x, y) => ellipse(hx + hr * 0.5, hy - hr * 0.9, hr * 0.3, hr * 0.5)(x, y), col: furCol },
    { cov: ellipse(hx + hr * 0.35, hy - hr * 0.1, hr * 0.1, hr * 0.1), col: solid([20, 20, 20]) },
    ...strands,
  ];
  const { img, gt } = render(W, H, bg, shapes);
  return { name: `animal-${seed}`, type: "animal", img, gt };
}

export function complexCase(seed: number, W = 400, H = 300): Case {
  const R = rng(seed);
  const shapes: Shape[] = [];
  for (let i = 0; i < 60; i++) {
    const c: RGB = [R() * 255, R() * 255, R() * 255];
    const x = R() * W, y = R() * H, s = 10 + R() * 50;
    shapes.push({ cov: R() < 0.5 ? ellipse(x, y, s, s * (0.5 + R())) : rect(x - s, y - s / 2, x + s, y + s / 2), col: solid(c) });
  }
  const vn = valueNoise(seed, 15);
  const { img } = render(W, H, (x, y) => [255 * vn(x, y), 200 * vn(y, x), 160], shapes);
  return { name: `complex-${seed}`, type: "complex", img, gt: null };
}

export function allCases(perType = 3): Case[] {
  const out: Case[] = [];
  for (let i = 0; i < perType; i++) {
    const s = 11 + i * 17;
    out.push(transparentCase(s), graphicCase(s), documentCase(s), chromaCase(s + i), productCase(s), portraitCase(s + i), animalCase(s), complexCase(s));
  }
  return out;
}

/** IoU at 0.5 and mean absolute alpha error (0..1). */
export function scoreAlpha(alpha: Uint8ClampedArray, gt: Float32Array): { iou: number; mad: number } {
  let inter = 0, uni = 0, sad = 0;
  for (let i = 0; i < gt.length; i++) {
    const a = alpha[i] / 255, g = gt[i];
    const A = a >= 0.5, G = g >= 0.5;
    if (A && G) inter++;
    if (A || G) uni++;
    sad += Math.abs(a - g);
  }
  return { iou: uni ? inter / uni : 1, mad: sad / gt.length };
}
