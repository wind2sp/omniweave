// The text marking of src/ui/pdf/textMark.ts as it was before the column (X-Y cut) change (commit bd522af^),
// frozen as the reference a one-column page must keep matching (annotRotateQa.test.ts).
import type { PdfTextItem } from "../../src/io/pdf";

interface Line {
  y0: number;
  y1: number;
  items: PdfTextItem[];
}

export function textLinesV1(items: PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  for (const it of [...items].sort((a, b) => b.y1 + b.y0 - (a.y1 + a.y0))) {
    const mid = (it.y0 + it.y1) / 2;
    const line = lines.find((l) => mid >= l.y0 && mid <= l.y1);
    if (line) {
      line.items.push(it);
      line.y0 = Math.min(line.y0, it.y0);
      line.y1 = Math.max(line.y1, it.y1);
    } else lines.push({ y0: it.y0, y1: it.y1, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x0 - b.x0);
  return lines.sort((a, b) => b.y1 - a.y1);
}

function locate(lines: Line[], p: [number, number]): { line: number; x: number } {
  let best = 0, dist = Infinity;
  lines.forEach((l, i) => {
    const d = p[1] < l.y0 ? l.y0 - p[1] : p[1] > l.y1 ? p[1] - l.y1 : 0;
    if (d < dist) (dist = d), (best = i);
  });
  return { line: best, x: p[0] };
}

function snap(it: PdfTextItem, x: number, up: boolean): number {
  const n = Math.max(1, [...it.str].length);
  const w = (it.x1 - it.x0) / n;
  const k = Math.min(n, Math.max(0, (up ? Math.ceil : Math.floor)((x - it.x0) / w)));
  return it.x0 + k * w;
}

export function quadsBetweenV1(items: PdfTextItem[], a: [number, number], b: [number, number]): number[][] {
  const lines = textLinesV1(items);
  if (!lines.length) return [];
  let s = locate(lines, a), e = locate(lines, b);
  if (s.line > e.line || (s.line === e.line && s.x > e.x)) [s, e] = [e, s];
  const quads: number[][] = [];
  for (let li = s.line; li <= e.line; li++) {
    const l = lines[li];
    const xs = li === s.line ? s.x : -Infinity, xe = li === e.line ? e.x : Infinity;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const it of l.items) {
      if (it.x1 <= xs || it.x0 >= xe) continue;
      const a0 = xs > it.x0 ? snap(it, xs, false) : it.x0;
      const a1 = xe < it.x1 ? snap(it, xe, true) : it.x1;
      if (a1 - a0 < 0.5) continue;
      x0 = Math.min(x0, a0);
      x1 = Math.max(x1, a1);
      y0 = Math.min(y0, it.y0);
      y1 = Math.max(y1, it.y1);
    }
    if (x1 - x0 >= 0.5) quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  return quads;
}
