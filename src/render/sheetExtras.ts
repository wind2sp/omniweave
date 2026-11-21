// Sheet painter extras (표 계산 격자 덧그림): what the grid draws over the cells for editing stage 2 — the red corner
// triangle of a note, the AutoFilter buttons of the header row (a funnel when the column is filtered), the dropdown
// arrow beside the active cell of a list validation, and the dashed outline of a fill-handle drag.

import type { SheetData } from "../core/sheetTypes";
import { parseAddr, parseRange, type Rect } from "../io/sheet/formula";
import { cellRect, panes, type SheetPaint } from "./sheet";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface SheetPaintExtra extends SheetPaint {
  /** the range a fill-handle drag would fill */
  fillTo?: Rect | null;
  /** the active cell has a list validation with an in-cell dropdown */
  listArrow?: boolean;
}

const mergeRect = (sh: SheetData, r: number, c: number): Rect | null => {
  for (const m of sh.merges) {
    const g = parseRange(m);
    if (g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1) return g;
  }
  return null;
};

/** Screen box of the filter button of a filter column (offset `k` from the range's first column). */
export function filterButtonRect(sh: SheetData, p: SheetPaint, k: number) {
  const g = parseRange(sh.filter!.ref)!;
  const q = cellRect(sh, p, g.r0, g.c0 + k);
  const s = Math.max(10, Math.min(q.h - 2, Math.round(16 * p.zoom)));
  return { x: q.x + q.w - s - 1, y: q.y + q.h - s - 1, w: s, h: s };
}

/** The filter column whose button is under a point, or null. */
export function filterButtonAt(sh: SheetData, p: SheetPaint, x: number, y: number): number | null {
  if (!sh.filter) return null;
  const g = parseRange(sh.filter.ref);
  if (!g) return null;
  for (let k = 0; k <= g.c1 - g.c0; k++) {
    const b = filterButtonRect(sh, p, k);
    if (b.w > 0 && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return k;
  }
  return null;
}

/** Screen box of the validation dropdown arrow beside the active cell. */
export function listArrowRect(sh: SheetData, p: SheetPaint) {
  const s = p.sel!;
  const m = mergeRect(sh, s.ar, s.ac);
  const q = m ? cellRect(sh, p, m.r0, m.c0, m.r1, m.c1) : cellRect(sh, p, s.ar, s.ac);
  const h = Math.max(12, Math.min(q.h, Math.round(20 * p.zoom)));
  return { x: q.x + q.w + 1, y: q.y + q.h - h, w: Math.round(h * 0.85), h };
}

function arrow(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  const cx = x + w / 2, cy = y + h / 2;
  const a = Math.max(2.5, w / 5);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - a, cy - a / 2);
  ctx.lineTo(cx + a, cy - a / 2);
  ctx.lineTo(cx, cy + a / 2);
  ctx.closePath();
  ctx.fill();
}

/** Paint the extras (call after the cells and the selection, before the headings). */
export function paintSheetExtras(ctx: Ctx, sh: SheetData, p: SheetPaintExtra) {
  const L = panes(sh, p);
  const z = p.zoom;
  const g = L.g;
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.hw, L.hh, p.width - L.hw, p.height - L.hh);
  ctx.clip();
  const visible = (q: { x: number; y: number; w: number; h: number }) => q.w > 0 && q.h > 0 && q.x + q.w >= L.hw && q.y + q.h >= L.hh && q.x <= p.width && q.y <= p.height;
  // notes: a red triangle in the top-right corner
  if (sh.notes) {
    const t = Math.max(4, Math.round(6 * z));
    ctx.fillStyle = "#C00000";
    for (const a of Object.keys(sh.notes)) {
      const at = parseAddr(a);
      if (!at || g.rows.size(at.r) === 0 || g.cols.size(at.c) === 0) continue;
      const m = mergeRect(sh, at.r, at.c);
      const q = m ? cellRect(sh, p, m.r0, m.c0, m.r1, m.c1) : cellRect(sh, p, at.r, at.c);
      if (!visible(q)) continue;
      const x = q.x + q.w - 1, y = q.y + 1;
      ctx.beginPath();
      ctx.moveTo(x - t, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + t);
      ctx.closePath();
      ctx.fill();
    }
  }
  // AutoFilter buttons
  const fg = sh.filter && parseRange(sh.filter.ref);
  if (fg && g.rows.size(fg.r0) > 0) {
    for (let k = 0; k <= fg.c1 - fg.c0; k++) {
      if (g.cols.size(fg.c0 + k) === 0) continue;
      const b = filterButtonRect(sh, p, k);
      if (!visible(b)) continue;
      const on = !!sh.filter!.cols?.[k];
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = "#ABABAB";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, b.w - 1, b.h - 1);
      if (on) {
        // funnel + small arrow (a filtered column)
        const s = b.w;
        ctx.fillStyle = "#2b74ec";
        ctx.beginPath();
        ctx.moveTo(b.x + s * 0.18, b.y + s * 0.22);
        ctx.lineTo(b.x + s * 0.62, b.y + s * 0.22);
        ctx.lineTo(b.x + s * 0.45, b.y + s * 0.48);
        ctx.lineTo(b.x + s * 0.45, b.y + s * 0.8);
        ctx.lineTo(b.x + s * 0.35, b.y + s * 0.72);
        ctx.lineTo(b.x + s * 0.35, b.y + s * 0.48);
        ctx.closePath();
        ctx.fill();
        arrow(ctx, b.x + s * 0.5, b.y + s * 0.45, s * 0.45, s * 0.45, "#444444");
      } else arrow(ctx, b.x, b.y, b.w, b.h, "#444444");
    }
  }
  // the list validation arrow beside the active cell
  if (p.listArrow && p.sel) {
    const b = listArrowRect(sh, p);
    if (visible(b)) {
      ctx.fillStyle = "#F3F3F3";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = "#ABABAB";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, b.w - 1, b.h - 1);
      arrow(ctx, b.x, b.y, b.w, b.h, "#444444");
    }
  }
  // fill-handle drag
  if (p.fillTo) {
    const f = p.fillTo;
    const q = cellRect(sh, p, f.r0, f.c0, f.r1, f.c1);
    ctx.strokeStyle = "#7A7A7A";
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5, Math.round(q.w) - 1, Math.round(q.h) - 1);
    ctx.setLineDash([]);
  }
  ctx.restore();
}
