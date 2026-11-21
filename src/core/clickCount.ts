// Click count of a press. Chromium (Edge, the WebView2 desktop app) gives pointerdown a `detail` of 0, so a
// double-click cannot be read off the press itself; this counts presses that come close together in time and place
// (the system double-click defaults: 500 ms, a few pixels). Engines that do fill in `detail` keep their own count.

export interface PressCount {
  t: number;
  x: number;
  y: number;
  n: number;
}

export const PRESS_MS = 500;
export const PRESS_PX = 4;

/** The press's click count (1, 2, 3 …), remembering this press in `c` for the next one. */
export function countPress(c: PressCount, detail: number, t: number, x: number, y: number): number {
  const near = t - c.t <= PRESS_MS && Math.hypot(x - c.x, y - c.y) <= PRESS_PX;
  c.n = detail > 0 ? detail : near ? c.n + 1 : 1;
  c.t = t;
  c.x = x;
  c.y = y;
  return c.n;
}
