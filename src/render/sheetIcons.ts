// Icon sets of conditional formatting (조건부 서식 ▸ 아이콘 집합): Excel's arrows, traffic lights, signs, symbols, flags,
// stars, ratings and quarters drawn as small vector icons at the left of a cell. `i` counts from the lowest band (0)
// up, as the rule's thresholds do; a reversed rule is turned round before it gets here.

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const GREEN = "#1d9a4b", YELLOW = "#f2b600", RED = "#d9342b", GRAY = "#7f7f7f", ORANGE = "#ed7d31", BLACK = "#404040", PINK = "#f4a3a3", LIGHT = "#bfbfbf";

/** Number of icons of a set (3Arrows → 3). */
export const iconCount = (set: string) => Number(/^(\d)/.exec(set)?.[1] ?? 3);

/** Icon sets offered in the dialog (Excel's gallery order). */
export const ICON_SETS = ["3Arrows", "3ArrowsGray", "4Arrows", "5Arrows", "3TrafficLights1", "3TrafficLights2", "3Signs", "4TrafficLights", "4RedToBlack", "3Symbols", "3Symbols2", "3Flags", "3Stars", "4Rating", "5Rating", "5Quarters"];

function arrow(ctx: Ctx, x: number, y: number, s: number, dir: number, color: string) {
  // dir: 90 up, 45 up-right, 0 right, -45 down-right, -90 down
  ctx.save();
  ctx.translate(x + s / 2, y + s / 2);
  ctx.rotate((-dir * Math.PI) / 180);
  ctx.fillStyle = color;
  ctx.beginPath();
  const h = s * 0.42;
  ctx.moveTo(h, 0);
  ctx.lineTo(0, -h);
  ctx.lineTo(0, -h * 0.45);
  ctx.lineTo(-h, -h * 0.45);
  ctx.lineTo(-h, h * 0.45);
  ctx.lineTo(0, h * 0.45);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function circle(ctx: Ctx, x: number, y: number, s: number, color: string, ring = false) {
  ctx.beginPath();
  ctx.arc(x + s / 2, y + s / 2, s * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (ring) {
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.lineWidth = Math.max(0.6, s / 16);
    ctx.stroke();
  }
}

function mark(ctx: Ctx, x: number, y: number, s: number, kind: "check" | "bang" | "cross", white: boolean) {
  ctx.strokeStyle = white ? "#fff" : kind === "check" ? GREEN : kind === "bang" ? YELLOW : RED;
  ctx.lineWidth = Math.max(1.2, s / 7);
  ctx.lineCap = "round";
  ctx.beginPath();
  const c = x + s / 2, m = y + s / 2, k = s * 0.2;
  if (kind === "check") {
    ctx.moveTo(c - k, m);
    ctx.lineTo(c - k * 0.2, m + k * 0.8);
    ctx.lineTo(c + k * 1.1, m - k * 0.9);
  } else if (kind === "cross") {
    ctx.moveTo(c - k, m - k);
    ctx.lineTo(c + k, m + k);
    ctx.moveTo(c + k, m - k);
    ctx.lineTo(c - k, m + k);
  } else {
    ctx.moveTo(c, m - k * 1.2);
    ctx.lineTo(c, m + k * 0.3);
    ctx.moveTo(c, m + k * 1.1);
    ctx.lineTo(c, m + k * 1.15);
  }
  ctx.stroke();
}

function star(ctx: Ctx, x: number, y: number, s: number, fill: number) {
  const cx = x + s / 2, cy = y + s / 2, R = s * 0.45, r = R * 0.45;
  const path = () => {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const rr = k % 2 ? r : R;
      ctx.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
    }
    ctx.closePath();
  };
  path();
  ctx.fillStyle = "#fff";
  ctx.fill();
  if (fill > 0) {
    ctx.save();
    path();
    ctx.clip();
    ctx.fillStyle = "#f5b400";
    ctx.fillRect(x, y, s * fill, s);
    ctx.restore();
  }
  path();
  ctx.strokeStyle = "#f5b400";
  ctx.lineWidth = Math.max(0.8, s / 14);
  ctx.stroke();
}

/** Draw icon `i` (0 = lowest band) of `set` in the s×s box at (x, y). */
export function drawIcon(ctx: Ctx, set: string, i: number, x: number, y: number, s: number) {
  const n = iconCount(set);
  const top = n - 1 - i; // 0 = the best icon
  ctx.save();
  switch (set) {
    case "3Arrows":
    case "3ArrowsGray":
      arrow(ctx, x, y, s, [90, 0, -90][top], set.endsWith("Gray") ? GRAY : [GREEN, YELLOW, RED][top]);
      break;
    case "4Arrows":
    case "4ArrowsGray":
      arrow(ctx, x, y, s, [90, 45, -45, -90][top], set.endsWith("Gray") ? GRAY : [GREEN, YELLOW, YELLOW, RED][top]);
      break;
    case "5Arrows":
    case "5ArrowsGray":
      arrow(ctx, x, y, s, [90, 45, 0, -45, -90][top], set.endsWith("Gray") ? GRAY : [GREEN, YELLOW, YELLOW, YELLOW, RED][top]);
      break;
    case "3TrafficLights2": {
      ctx.fillStyle = BLACK;
      ctx.beginPath();
      ctx.roundRect?.(x + s * 0.1, y + s * 0.02, s * 0.8, s * 0.96, s * 0.2);
      ctx.fill();
      circle(ctx, x + s * 0.15, y + s * 0.15, s * 0.7, [GREEN, YELLOW, RED][top]);
      break;
    }
    case "3Signs": {
      const c = [GREEN, YELLOW, RED][top];
      ctx.fillStyle = c;
      ctx.beginPath();
      if (top === 0) ctx.arc(x + s / 2, y + s / 2, s * 0.4, 0, Math.PI * 2);
      else if (top === 1) {
        ctx.moveTo(x + s / 2, y + s * 0.1);
        ctx.lineTo(x + s * 0.92, y + s * 0.88);
        ctx.lineTo(x + s * 0.08, y + s * 0.88);
      } else {
        ctx.moveTo(x + s / 2, y + s * 0.08);
        ctx.lineTo(x + s * 0.92, y + s / 2);
        ctx.lineTo(x + s / 2, y + s * 0.92);
        ctx.lineTo(x + s * 0.08, y + s / 2);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "4TrafficLights":
      circle(ctx, x, y, s, [GREEN, YELLOW, RED, BLACK][top], true);
      break;
    case "4RedToBlack":
      circle(ctx, x, y, s, [RED, PINK, GRAY, BLACK][top], true);
      break;
    case "3Symbols":
      circle(ctx, x, y, s, [GREEN, YELLOW, RED][top]);
      mark(ctx, x, y, s, (["check", "bang", "cross"] as const)[top], true);
      break;
    case "3Symbols2":
      mark(ctx, x, y, s, (["check", "bang", "cross"] as const)[top], false);
      break;
    case "3Flags": {
      ctx.strokeStyle = BLACK;
      ctx.lineWidth = Math.max(1, s / 12);
      ctx.beginPath();
      ctx.moveTo(x + s * 0.25, y + s * 0.1);
      ctx.lineTo(x + s * 0.25, y + s * 0.92);
      ctx.stroke();
      ctx.fillStyle = [GREEN, YELLOW, RED][top];
      ctx.beginPath();
      ctx.moveTo(x + s * 0.28, y + s * 0.12);
      ctx.lineTo(x + s * 0.88, y + s * 0.3);
      ctx.lineTo(x + s * 0.28, y + s * 0.52);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "3Stars":
      star(ctx, x, y, s, [1, 0.5, 0][top]);
      break;
    case "4Rating":
    case "5Rating": {
      // signal bars, as many dark as the rating
      const k = n - top - (set === "5Rating" ? 1 : 0);
      for (let b = 0; b < 4; b++) {
        ctx.fillStyle = b < k ? "#2f5597" : LIGHT;
        const bh = (s * 0.8 * (b + 1)) / 4;
        ctx.fillRect(x + s * 0.08 + b * s * 0.22, y + s * 0.9 - bh, s * 0.16, bh);
      }
      break;
    }
    case "5Quarters": {
      const frac = [1, 0.75, 0.5, 0.25, 0][top];
      ctx.beginPath();
      ctx.arc(x + s / 2, y + s / 2, s * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = BLACK;
      ctx.lineWidth = Math.max(0.8, s / 14);
      ctx.stroke();
      if (frac) {
        ctx.beginPath();
        ctx.moveTo(x + s / 2, y + s / 2);
        ctx.arc(x + s / 2, y + s / 2, s * 0.4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = BLACK;
        ctx.fill();
      }
      break;
    }
    default:
      // 3TrafficLights1 and anything unknown: plain lights
      circle(ctx, x, y, s, n >= 4 ? [GREEN, YELLOW, ORANGE, RED, BLACK][top] ?? GRAY : [GREEN, YELLOW, RED][top] ?? GRAY, true);
  }
  ctx.restore();
}
