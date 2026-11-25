// SmartArt graphics (PowerPoint 삽입 › SmartArt): the layouts Omniweave draws, their items (text pane lines with a
// level) and the shapes they are drawn with. A graphic is a layer group whose `smart` holds what it shows
// (ui/slideDesign.ts inserts and edits it); a PPTX save writes it as PowerPoint's own SmartArt (diagram data with the
// built-in layout it maps to: io/formats/pptxSmartArt.ts), so PowerPoint lays it out and edits it as SmartArt.

import { corner, ellipseContour, rectContour } from "./vector";
import { DEFAULT_RUN, newText, newVector, uid, type SceneNode, type TextNode, type VectorNode } from "./types";
import type { SlideTheme } from "./slideTheme";

export type SmartLayout = "blockList" | "bulletList" | "process" | "arrowProcess" | "cycle" | "hierarchy" | "pyramid";
export const SMART_LAYOUTS: { id: SmartLayout; cat: "list" | "process" | "cycle" | "hierarchy" | "pyramid" }[] = [
  { id: "blockList", cat: "list" },
  { id: "bulletList", cat: "list" },
  { id: "process", cat: "process" },
  { id: "arrowProcess", cat: "process" },
  { id: "cycle", cat: "cycle" },
  { id: "hierarchy", cat: "hierarchy" },
  { id: "pyramid", cat: "pyramid" },
];

export interface SmartItem {
  text: string;
  level: number;
}

/** Text pane lines ("  sub" = level 1 by two spaces or a tab) → items. */
export function parseSmartText(s: string): SmartItem[] {
  return s
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const lead = /^[\t ]*/.exec(l)![0].replace(/\t/g, "  ").length;
      return { text: l.trim().replace(/^[-•·]\s*/, ""), level: Math.min(2, Math.floor(lead / 2)) };
    });
}
export const smartText = (items: SmartItem[]) => items.map((i) => "  ".repeat(i.level) + i.text).join("\n");

const box = (x: number, y: number, w: number, h: number, fill: string, name: string, round = 0.1): VectorNode => {
  const r = Math.min(w, h) * round;
  const v = newVector([round ? roundRect(x, y, w, h, r) : rectContour(x, y, w, h)], name);
  v.fill = fill;
  v.stroke = "#FFFFFF";
  v.strokeWidth = 1.5;
  return v;
};

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  const k = 0.5523 * r;
  const n = (ax: number, ay: number, ix: number, iy: number, ox: number, oy: number) => ({ anchor: [ax, ay] as [number, number], handleIn: [ix, iy] as [number, number], handleOut: [ox, oy] as [number, number], isCorner: false });
  return {
    closed: true,
    nodes: [
      n(x + r, y, x + r - k, y, x + r, y),
      n(x + w - r, y, x + w - r, y, x + w - r + k, y),
      n(x + w, y + r, x + w, y + r - k, x + w, y + r),
      n(x + w, y + h - r, x + w, y + h - r, x + w, y + h - r + k),
      n(x + w - r, y + h, x + w - r + k, y + h, x + w - r, y + h),
      n(x + r, y + h, x + r, y + h, x + r - k, y + h),
      n(x, y + h - r, x, y + h - r + k, x, y + h - r),
      n(x, y + r, x, y + r, x, y + r - k),
    ],
  };
}

function label(text: string, x: number, y: number, w: number, h: number, size: number, color: string, font: string, align: "CENTER" | "LEFT" = "CENTER"): TextNode {
  const n = newText("", Math.max(8, w));
  n.name = text;
  n.paragraphs = text.split("\n").map((line) => ({ id: uid("p"), runs: [{ ...DEFAULT_RUN, text: line, fontSize: size, color, fontFamily: font }], align, lineSpacing: 1.15, indent: 0, spaceAfter: 0 }));
  const lines = n.paragraphs.length;
  n.transform = { x, y: y + Math.max(0, (h - size * 1.15 * 1.25 * lines) / 2), rotation: 0, scale: 1 };
  return n;
}

/** The shapes of a SmartArt graphic in a frame (PowerPoint's look: accent fills, white text), top level items with their children. */
export function smartShapes(layout: SmartLayout, items: SmartItem[], frame: { x: number; y: number; w: number; h: number }, th: SlideTheme): SceneNode[] {
  const { x, y, w, h } = frame;
  const tops = items.filter((i) => i.level === 0);
  const kids = (ti: number) => {
    const start = items.indexOf(tops[ti]);
    const end = ti + 1 < tops.length ? items.indexOf(tops[ti + 1]) : items.length;
    return items.slice(start + 1, end);
  };
  const n = Math.max(1, tops.length);
  const a = th.colors.accent1, light = "#FFFFFF", font = th.minor;
  const fs = Math.max(12, Math.min(28, h / 9));
  const out: SceneNode[] = [];
  const name = (k: string) => `SmartArt ${k}`;
  switch (layout) {
    case "blockList": {
      const cols = n <= 3 ? n : Math.ceil(n / 2), rows = Math.ceil(n / cols);
      const gw = w / (cols + (cols - 1) * 0.1), gh = Math.min(h / (rows + (rows - 1) * 0.1), gw * 0.6);
      tops.forEach((it, i) => {
        const cx = x + (i % cols) * gw * 1.1, cy = y + (h - rows * gh * 1.1) / 2 + Math.floor(i / cols) * gh * 1.1;
        out.push(box(cx, cy, gw, gh, a, name(String(i + 1)), 0));
        out.push(label([it.text, ...kids(i).map((k) => "• " + k.text)].join("\n"), cx + gw * 0.05, cy, gw * 0.9, gh, fs, light, font));
      });
      break;
    }
    case "bulletList": {
      const gw = w / (n + (n - 1) * 0.06);
      tops.forEach((it, i) => {
        const cx = x + i * gw * 1.06;
        out.push(box(cx, y, gw, h * 0.18, a, name(String(i + 1)), 0));
        out.push(label(it.text, cx, y, gw, h * 0.18, fs, light, font));
        const body = box(cx, y + h * 0.18, gw, h * 0.82, th.colors.lt2 ?? "#E7E6E6", name(`${i + 1}b`), 0);
        body.stroke = a;
        out.push(body);
        const ks = kids(i);
        if (ks.length) out.push(label(ks.map((k) => "• " + k.text).join("\n"), cx + gw * 0.06, y + h * 0.2, gw * 0.88, h * 0.3, fs * 0.8, th.colors.dk1, font, "LEFT"));
      });
      break;
    }
    case "process":
    case "arrowProcess": {
      const gap = layout === "process" ? 0.35 : 0.08;
      const gw = w / (n + (n - 1) * gap), gh = Math.min(h, gw * 0.62);
      const cy = y + (h - gh) / 2;
      tops.forEach((it, i) => {
        const cx = x + i * gw * (1 + gap);
        if (layout === "arrowProcess") {
          const tip = gw * 0.18;
          const v = newVector([{ closed: true, nodes: [corner(cx, cy), corner(cx + gw - tip, cy), corner(cx + gw, cy + gh / 2), corner(cx + gw - tip, cy + gh), corner(cx, cy + gh), ...(i ? [corner(cx + tip, cy + gh / 2)] : [])] }], name(String(i + 1)));
          v.fill = a;
          v.stroke = "#FFFFFF";
          v.strokeWidth = 1.5;
          out.push(v);
        } else out.push(box(cx, cy, gw, gh, a, name(String(i + 1))));
        out.push(label([it.text, ...kids(i).map((k) => k.text)].join("\n"), cx + gw * 0.08, cy, gw * 0.84, gh, fs, light, font));
        if (layout === "process" && i < n - 1) {
          const ax = cx + gw + gw * gap * 0.2, aw = gw * gap * 0.6, ah = gh * 0.3, ay = cy + gh / 2;
          const arr = newVector([{ closed: true, nodes: [corner(ax, ay - ah * 0.3), corner(ax + aw * 0.55, ay - ah * 0.3), corner(ax + aw * 0.55, ay - ah / 2), corner(ax + aw, ay), corner(ax + aw * 0.55, ay + ah / 2), corner(ax + aw * 0.55, ay + ah * 0.3), corner(ax, ay + ah * 0.3)] }], name(`→${i + 1}`));
          arr.fill = th.colors.accent1 + "99";
          arr.fill = "#BFBFBF";
          arr.stroke = null;
          arr.strokeWidth = 0;
          out.push(arr);
        }
      });
      break;
    }
    case "cycle": {
      const R = Math.min(w, h) * 0.36, cx0 = x + w / 2, cy0 = y + h / 2;
      const r = Math.min(R * 0.55, (Math.PI * R) / n * 0.62);
      tops.forEach((it, i) => {
        const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const px = cx0 + R * Math.cos(ang), py = cy0 + R * Math.sin(ang);
        const c = newVector([ellipseContour(px, py, r, r)], name(String(i + 1)));
        c.fill = a;
        c.stroke = "#FFFFFF";
        c.strokeWidth = 1.5;
        out.push(c);
        out.push(label(it.text, px - r * 0.85, py - r, r * 1.7, r * 2, fs * 0.85, light, font));
        // arrow between this item and the next, on the circle
        const a1 = ang + (Math.PI / n) * 0.55, a2 = ang + (2 * Math.PI) / n - (Math.PI / n) * 0.55;
        const steps = 12;
        const nodes = Array.from({ length: steps + 1 }, (_, k) => {
          const t0 = a1 + ((a2 - a1) * k) / steps;
          return corner(cx0 + R * Math.cos(t0), cy0 + R * Math.sin(t0));
        });
        const arc = newVector([{ closed: false, nodes }], name(`↻${i + 1}`));
        arc.fill = null;
        arc.stroke = "#BFBFBF";
        arc.strokeWidth = Math.max(2, r * 0.12);
        out.push(arc);
      });
      break;
    }
    case "pyramid": {
      const levels = n;
      tops.forEach((it, i) => {
        const y0 = y + (h * i) / levels, y1 = y + (h * (i + 1)) / levels;
        const half = (yy: number) => ((yy - y) / h) * (w * 0.4);
        const cx = x + w / 2;
        const v = newVector([{ closed: true, nodes: [corner(cx - half(y0), y0), corner(cx + half(y0), y0), corner(cx + half(y1), y1), corner(cx - half(y1), y1)] }], name(String(i + 1)));
        v.fill = [th.colors.accent1, th.colors.accent2, th.colors.accent3, th.colors.accent4, th.colors.accent5, th.colors.accent6][i % 6];
        v.stroke = "#FFFFFF";
        v.strokeWidth = 1.5;
        out.push(v);
        out.push(label(it.text, cx - w * 0.25, y0, w * 0.5, y1 - y0, fs * 0.85, light, font));
      });
      break;
    }
    case "hierarchy": {
      // level 0 = the top box, level 1 = the row under it, level 2 = under each of those
      const root = tops[0] ?? { text: "", level: 0 };
      const rest = items.slice(items.indexOf(root) + 1);
      const l1 = rest.filter((i) => i.level >= 1 && i.level === 1);
      const bw = Math.min(w / Math.max(1, l1.length) * 0.8, w * 0.3), bh = h * 0.2;
      const rx = x + (w - bw) / 2;
      out.push(box(rx, y, bw, bh, a, name("1")));
      out.push(label(root.text, rx, y, bw, bh, fs * 0.9, light, font));
      const conn = (x1: number, y1: number, x2: number, y2: number, k: string) => {
        const my = (y1 + y2) / 2;
        const v = newVector([{ closed: false, nodes: [corner(x1, y1), corner(x1, my), corner(x2, my), corner(x2, y2)] }], name(k));
        v.fill = null;
        v.stroke = "#7F7F7F";
        v.strokeWidth = 1.5;
        out.push(v);
      };
      const slot = w / Math.max(1, l1.length);
      l1.forEach((it, i) => {
        const bx = x + slot * i + (slot - bw) / 2, by = y + h * 0.4;
        conn(rx + bw / 2, y + bh, bx + bw / 2, by, `-${i + 1}`);
        out.push(box(bx, by, bw, bh, th.colors.accent2, name(`1.${i + 1}`)));
        out.push(label(it.text, bx, by, bw, bh, fs * 0.8, light, font));
        const at = rest.indexOf(it);
        const next = l1[i + 1] ? rest.indexOf(l1[i + 1]) : rest.length;
        rest.slice(at + 1, next).filter((k) => k.level >= 2).forEach((k, j) => {
          const kx = bx + bw * 0.1, ky = by + bh * 1.3 + j * bh * 0.9;
          if (ky + bh * 0.75 > y + h) return;
          out.push(box(kx, ky, bw * 0.9, bh * 0.75, th.colors.accent3, name(`1.${i + 1}.${j + 1}`)));
          out.push(label(k.text, kx, ky, bw * 0.9, bh * 0.75, fs * 0.7, light, font));
        });
      });
      break;
    }
  }
  for (const s of out) s.transform = { ...s.transform };
  return out;
}

/** What a SmartArt group holds (kept on the group so its text pane can draw it again). */
export interface SmartData {
  /** where its first shape was when it was drawn (or read): how far the graphic has been moved since */
  anchor?: { x: number; y: number };
  layout: SmartLayout;
  items: SmartItem[];
  frame: { x: number; y: number; w: number; h: number };
}

