// The body under a head (background removal of a person). The subject model (U²-Netp) at times sees only a head:
// the shirt and shoulders below it, which run to the picture's bottom edge, came out removed (realuse img-bg-person
// 2026-11-25: face kept, shirt gone — "배경 지우기가 안 된다"). After the matte, when what was kept looks like a head
// and shoulders are missing, the region below it that is not background-coloured is grown from the kept part's lower
// edge and kept as well:
//   - background colours: sampled along the top edge and the side edges beside the head (the body is below it);
//   - grown 4-connected from the kept pixels' lower half, through pixels away from every background colour;
//   - given up when the growth reaches the top edge or takes most of the picture (that was background after all).
// Only for the photo types (portrait / object / complex / animal), never for products, graphics or documents.

import type { Img } from "../pixels";

export interface BodyResult {
  /** pixels added to the matte */
  added: number;
  /** why nothing was added (tests, the engine's notes) */
  skipped?: "noSubject" | "notHead" | "noBody" | "background";
}

/** colour distance (0..441) */
const dist = (a: Uint8ClampedArray, i: number, c: readonly number[]) => Math.hypot(a[i] - c[0], a[i + 1] - c[1], a[i + 2] - c[2]);

/**
 * Grow `alpha` (W × H, 0..255, changed in place) with the body under a head-like kept region. `tol`: how far from
 * every background colour a pixel must be to count as body.
 */
export function extendBody(img: Img, alpha: Uint8ClampedArray, tol = 42): BodyResult {
  const W = img.width, H = img.height, d = img.data;
  // the kept region's box
  let x0 = W, x1 = -1, y0 = H, y1 = -1, kept = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (alpha[y * W + x] >= 128) {
        kept++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (!kept) return { added: 0, skipped: "noSubject" };
  // a head: well above the bottom edge, narrower than the picture, not touching the left / right edges, in the upper
  // half, about as tall as wide — and with skin in it (a bird on a branch is not grown into its branch)
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (y1 >= H * 0.9 || bw > W * 0.75 || x0 <= 1 || x1 >= W - 2 || y0 > H * 0.5 || bh < bw * 0.7 || bh > bw * 2.5) return { added: 0, skipped: "notHead" };
  let skin = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const p = y * W + x;
      if (alpha[p] < 128) continue;
      const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      // a common RGB skin rule (any skin tone under ordinary light)
      if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15) skin++;
    }
  if (skin < kept * 0.15) return { added: 0, skipped: "notHead" };
  // background colours: every 4th pixel of the top, left and right edges (2 px in), a few hundred colours at most
  const bg: number[][] = [];
  const take = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    if (alpha[y * W + x] < 128 && d[i + 3] > 0) bg.push([d[i], d[i + 1], d[i + 2]]);
  };
  for (let x = 0; x < W; x += 4) take(x, 1);
  // (the side edges only beside the head: lower down the shoulders often run out of the frame there)
  for (let y = 0; y <= y1; y += 4) take(1, y), take(W - 2, y);
  if (!bg.length) return { added: 0, skipped: "noBody" };
  const step = Math.max(1, Math.floor(bg.length / 400));
  const pal = bg.filter((_, i) => i % step === 0);
  const isBody = (p: number) => {
    const i = p * 4;
    if (d[i + 3] < 128) return false;
    for (const c of pal) if (dist(d, i, c) < tol) return false;
    return true;
  };
  // seeds: kept pixels in the lower half of the kept box whose neighbour below is not kept but body-coloured
  const mid = Math.floor((y0 + y1) / 2);
  const grown = new Uint8Array(W * H);
  const queue: number[] = [];
  for (let y = mid; y <= y1 && y < H - 1; y++)
    for (let x = x0; x <= x1; x++) {
      const p = y * W + x;
      if (alpha[p] < 128) continue;
      for (const q of [p + W, p - 1, p + 1]) {
        if (q < 0 || q >= W * H || grown[q] || alpha[q] >= 128) continue;
        if (Math.floor(q / W) < mid) continue;
        if (isBody(q)) {
          grown[q] = 1;
          queue.push(q);
        }
      }
    }
  if (!queue.length) return { added: 0, skipped: "noBody" };
  let n = 0, touchedTop = false;
  const limit = W * H * 0.7;
  while (queue.length) {
    const p = queue.pop()!;
    n++;
    if (n > limit) return { added: 0, skipped: "background" };
    const y = Math.floor(p / W), x = p - y * W;
    if (y === 0) touchedTop = true;
    const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
    for (const q of nb) {
      if (q < 0 || grown[q] || alpha[q] >= 128) continue;
      // the body grows down and sideways from the head's middle, never up past it
      if (Math.floor(q / W) < mid) continue;
      if (!isBody(q)) continue;
      grown[q] = 1;
      queue.push(q);
    }
  }
  if (touchedTop) return { added: 0, skipped: "background" };
  // only a body the frame cuts off at the bottom edge (shoulders, a shirt): not a patch under the head
  let maxY = 0;
  for (let p = 0; p < W * H; p++) if (grown[p]) maxY = Math.max(maxY, Math.floor(p / W));
  if (maxY < H - 3) return { added: 0, skipped: "noBody" };
  let added = 0;
  for (let p = 0; p < W * H; p++)
    if (grown[p]) {
      alpha[p] = 255;
      added++;
    }
  // a soft 1 px edge where the grown body meets the background
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (!grown[p]) continue;
      const out = (alpha[p - 1] < 128 ? 1 : 0) + (alpha[p + 1] < 128 ? 1 : 0) + (alpha[p - W] < 128 ? 1 : 0) + (alpha[p + W] < 128 ? 1 : 0);
      if (out) alpha[p] = 255 - out * 40;
    }
  return { added };
}
