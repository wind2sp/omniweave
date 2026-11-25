// Slide transitions as the show draws them (core/types TransitionType; PowerPoint's 전환 gallery): `from` is the old
// slide as it was last drawn, `paint` draws the new one at the current time, `e` runs 0 → 1 (eased).

import type { TransitionType } from "../core/types";

type Ctx = CanvasRenderingContext2D;
type Src = OffscreenCanvas | HTMLCanvasElement;

/** Draws one frame of a transition into `c` (W × H device pixels). */
export function drawTransition(c: Ctx, type: TransitionType, from: Src, paint: (c: Ctx) => void, e: number, W: number, H: number): void {
  const clipNew = (path: () => void) => {
    c.drawImage(from, 0, 0);
    c.save();
    c.beginPath();
    path();
    c.clip();
    paint(c);
    c.restore();
  };
  switch (type) {
    case "FADE":
      c.drawImage(from, 0, 0);
      c.globalAlpha = e;
      paint(c);
      c.globalAlpha = 1;
      return;
    case "SLIDE_LEFT":
      c.drawImage(from, -W * e, 0);
      c.save();
      c.translate(W * (1 - e), 0);
      paint(c);
      c.restore();
      return;
    case "PUSH_UP":
      c.drawImage(from, 0, -H * e);
      c.save();
      c.translate(0, H * (1 - e));
      paint(c);
      c.restore();
      return;
    case "COVER":
      c.drawImage(from, 0, 0);
      c.save();
      c.translate(W * (1 - e), 0);
      paint(c);
      c.restore();
      return;
    case "UNCOVER":
      paint(c);
      c.drawImage(from, -W * e, 0);
      return;
    case "WIPE":
      return clipNew(() => c.rect(0, 0, W * e, H));
    case "SPLIT":
      return clipNew(() => c.rect((W * (1 - e)) / 2, 0, W * e, H));
    case "CIRCLE":
      return clipNew(() => c.arc(W / 2, H / 2, Math.hypot(W, H) * 0.5 * e, 0, Math.PI * 2));
    case "RANDOM_BARS": {
      const n = 48;
      // each bar shows at its own moment (a fixed shuffle)
      return clipNew(() => {
        for (let i = 0; i < n; i++) if (((i * 37) % n) / n < e) c.rect(0, (H * i) / n, W, H / n + 1);
      });
    }
    case "DISSOLVE": {
      const cols = 32, rows = 18;
      return clipNew(() => {
        for (let i = 0; i < cols * rows; i++) if (((i * 7919) % (cols * rows)) / (cols * rows) < e) c.rect(((i % cols) * W) / cols, (Math.floor(i / cols) * H) / rows, W / cols + 1, H / rows + 1);
      });
    }
    case "ZOOM": {
      c.drawImage(from, 0, 0);
      c.globalAlpha = e;
      const z = 0.7 + 0.3 * e;
      c.save();
      c.translate((W * (1 - z)) / 2, (H * (1 - z)) / 2);
      c.scale(z, z);
      paint(c);
      c.restore();
      c.globalAlpha = 1;
      return;
    }
    default:
      paint(c);
  }
}
