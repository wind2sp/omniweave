// 쪽 테두리 / Word page border (Page.border): the box drawn around a document page. It is drawn by a locked line node
// the body flow makes on each page (core/flow.ts reflowSegment, like the rule between columns: `notes`, never body
// content, never written as a shape), so the screen, print and every export show it the same way.

import { bodyBox } from "./pageSetup";
import type { Page, PageBorder, SceneNode } from "./types";

/** The rectangle the border's (outer) line runs along, page coordinates. */
export function borderRect(page: Pick<Page, "width" | "height" | "margins">, b: PageBorder): { x: number; y: number; w: number; h: number } {
  if (b.from === "text") {
    const body = bodyBox(page as Page);
    return { x: body.x - b.space, y: body.y - b.space, w: body.w + 2 * b.space, h: body.h + 2 * b.space };
  }
  return { x: b.space, y: b.space, w: page.width - 2 * b.space, h: page.height - 2 * b.space };
}

const rectNode = (id: string, r: { x: number; y: number; w: number; h: number }, b: PageBorder, width: number): SceneNode =>
  ({
    id,
    name: "page border",
    visible: true,
    locked: true,
    opacity: 1,
    blendMode: "NORMAL",
    transform: { x: r.x, y: r.y, rotation: 0, scale: 1 },
    type: "VECTOR",
    contours: [
      {
        closed: true,
        nodes: [
          [0, 0],
          [r.w, 0],
          [r.w, r.h],
          [0, r.h],
        ].map(([x, y]) => ({ anchor: [x, y] as [number, number], handleIn: [x, y] as [number, number], handleOut: [x, y] as [number, number], isCorner: true })),
      },
    ],
    fill: null,
    stroke: b.color,
    strokeWidth: width,
    ...(b.style === "dashed" ? { strokeDash: [width * 4, width * 2] } : b.style === "dotted" ? { strokeDash: [width, width * 1.5] } : {}),
    fillRule: "nonzero",
    strokeCap: "butt",
    notes: "foot",
  }) as SceneNode;

/** The line nodes of a page's border (two for a double line), ids `<page>:pgborder…`; none without a border. */
export function pageBorderNodes(page: Page): SceneNode[] {
  const b = page.border;
  if (!b || page.kind !== "DOCUMENT" || !(b.width > 0)) return [];
  const r = borderRect(page, b);
  if (b.style !== "double") return [rectNode(`${page.id}:pgborder`, r, b, b.style === "thick" ? b.width * 2 : b.width)];
  const gap = b.width * 2;
  return [
    rectNode(`${page.id}:pgborder`, r, b, b.width),
    rectNode(`${page.id}:pgborder2`, { x: r.x + gap, y: r.y + gap, w: r.w - 2 * gap, h: r.h - 2 * gap }, b, b.width),
  ];
}

/** Is `n` a page border line (made from Page.border, not content)? */
export const isPageBorderNode = (n: SceneNode) => n.id.includes(":pgborder");

/** Word's border width: w:sz in eighths of a point → px (and back). */
export const pxOfEighths = (sz: number) => Math.round(((sz / 8) * 96) / 72 * 100) / 100;
export const eighthsOfPx = (px: number) => Math.max(2, Math.min(96, Math.round(((px * 72) / 96) * 8)));
