// 2-D affine matrices in PDF order [a b c d e f]: (x, y) → (a·x + c·y + e, b·x + d·y + f).
// mul(m1, m2) applies m1 first, then m2 (the PDF "m1 × m2" convention).

export type M = [number, number, number, number, number, number];

export const I: M = [1, 0, 0, 1, 0, 0];

export function mul(m1: readonly number[], m2: readonly number[]): M {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function inv(m: readonly number[]): M | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function apply(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
export const rotate = (rad: number): M => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];

/** mean linear scale (for line widths) */
export const scaleOf = (m: readonly number[]) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export function toM(v: unknown): M | null {
  if (!Array.isArray(v) || v.length < 6 || !v.slice(0, 6).every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return v.slice(0, 6) as M;
}

/**
 * The pdf.js PageViewport transform: default user space → page pixels (y down), for the visible
 * box `view` = [x0 y0 x1 y1], page /Rotate and a scale (Omniweave uses 96/72).
 */
export function viewportMatrix(view: readonly number[], rotate: number, scale: number): { m: M; width: number; height: number } {
  const [x0, y0, x1, y1] = view;
  const r = (((rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  let A = 1, B = 0, C = 0, D = -1;
  if (r === 90) (A = 0), (B = 1), (C = 1), (D = 0);
  else if (r === 180) (A = -1), (B = 0), (C = 0), (D = 1);
  else if (r === 270) (A = 0), (B = -1), (C = -1), (D = 0);
  const cx = (x1 + x0) / 2, cy = (y1 + y0) / 2;
  let ox: number, oy: number, width: number, height: number;
  if (A === 0) {
    ox = Math.abs(cy - y0) * scale;
    oy = Math.abs(cx - x0) * scale;
    width = Math.abs(y1 - y0) * scale;
    height = Math.abs(x1 - x0) * scale;
  } else {
    ox = Math.abs(cx - x0) * scale;
    oy = Math.abs(cy - y0) * scale;
    width = Math.abs(x1 - x0) * scale;
    height = Math.abs(y1 - y0) * scale;
  }
  return { m: [A * scale, B * scale, C * scale, D * scale, ox - A * scale * cx - C * scale * cy, oy - B * scale * cx - D * scale * cy], width, height };
}
