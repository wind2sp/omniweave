// Canvas edits of the image and design modes (Photoshop 이미지 › 캔버스 크기 · 캔버스 뒤집기): pure, on a page or a
// draft page. The layers are not resampled: a smaller canvas leaves what falls outside it in the layers (it shows
// again when the canvas grows back), a bigger one adds room around them.

import { applyTransform } from "./geom";
import { localBounds, makeTile } from "./loom";
import { cleanGuides } from "./pages";
import { flipNodeScreen } from "./transform";
import { TILE, newRaster, type Page, type PixelTile, type RasterNode, type SceneNode } from "./types";

type MutablePage = Pick<Page, "width" | "height" | "background" | "guides"> & { nodes: SceneNode[] };

/** Anchor 0…8: row-major 3 × 3 (0 top-left, 4 centre, 8 bottom-right) — the part of the old canvas that stays put. */
export type Anchor = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** How the added room is filled: the canvas colour as it is, transparent, or a colour (#rrggbb). */
export type CanvasFill = "background" | "transparent" | string;

/** Where the old canvas's top-left corner goes on the new canvas (whole pixels). */
export function anchorOffset(oldW: number, oldH: number, newW: number, newH: number, anchor: Anchor): [number, number] {
  const col = anchor % 3, row = Math.floor(anchor / 3);
  return [Math.round(((newW - oldW) * col) / 2), Math.round(((newH - oldH) * row) / 2)];
}

const isOpaque = (c: string | null | undefined): c is string => !!c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);

function rgba(hex: string): [number, number, number, number] {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
}

/** Tiles of a W × H layer painted `color` where `paint(x, y)` (pixel centres) — only the tiles that get any pixel. */
export function fillTiles(W: number, H: number, color: string, paint: (x: number, y: number) => boolean): Record<string, PixelTile> {
  const [r, g, b, a] = rgba(color);
  const tiles: Record<string, PixelTile> = {};
  for (let ty = 0; ty * TILE < H; ty++)
    for (let tx = 0; tx * TILE < W; tx++) {
      const d = new Uint8ClampedArray(TILE * TILE * 4);
      let any = false;
      for (let y = 0; y < TILE; y++) {
        const py = ty * TILE + y;
        if (py >= H) break;
        for (let x = 0; x < TILE; x++) {
          const px = tx * TILE + x;
          if (px >= W) break;
          if (!paint(px + 0.5, py + 0.5)) continue;
          const i = (y * TILE + x) * 4;
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = a;
          any = true;
        }
      }
      if (any) tiles[`${tx}_${ty}`] = makeTile(d);
    }
  return tiles;
}

/**
 * Canvas size (one draft): the canvas becomes `w` × `h`, the old canvas placed by `anchor`; layers and guides move
 * with it. The added room:
 *  - "background": the canvas colour, as it is;
 *  - "transparent": the canvas turns transparent; an opaque canvas colour stays under the old area as a layer;
 *  - a colour: a layer at the bottom fills only the added room.
 * Returns the layer it added (or null).
 */
export function resizeCanvasInPlace(p: MutablePage, w: number, h: number, anchor: Anchor, fill: CanvasFill, layerName: string): RasterNode | null {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  const oldW = p.width, oldH = p.height;
  const [dx, dy] = anchorOffset(oldW, oldH, W, H, anchor);
  for (const n of p.nodes) {
    n.transform.x += dx;
    n.transform.y += dy;
  }
  if (p.guides) p.guides = cleanGuides({ x: (p.guides.x ?? []).map((v) => v + dx), y: (p.guides.y ?? []).map((v) => v + dy) });
  p.width = W;
  p.height = H;
  const inOld = (x: number, y: number) => x >= dx && x < dx + oldW && y >= dy && y < dy + oldH;
  const grows = dx > 0 || dy > 0 || dx + oldW < W || dy + oldH < H;
  let layer: RasterNode | null = null;
  if (fill === "transparent") {
    const bg = p.background;
    p.background = "transparent";
    if (grows && isOpaque(bg)) layer = { ...newRaster(layerName), tiles: fillTiles(W, H, bg, inOld) };
  } else if (fill !== "background" && isOpaque(fill) && grows) layer = { ...newRaster(layerName), tiles: fillTiles(W, H, fill, (x, y) => !inOld(x, y)) };
  if (layer && Object.keys(layer.tiles).length) p.nodes.unshift(layer as any);
  else layer = null;
  return layer;
}

/** Flip the whole canvas (every layer mirrored across the canvas's middle, guides too) — the layers keep their pixels. */
export function flipCanvasInPlace(p: MutablePage, axis: "h" | "v") {
  const W = p.width, H = p.height;
  for (const n of p.nodes) {
    const lb = localBounds(n);
    const c = applyTransform(n.transform, [lb.x + lb.w / 2, lb.y + lb.h / 2]);
    n.transform = flipNodeScreen(n, lb, axis);
    if (axis === "h") n.transform.x += W - 2 * c[0];
    else n.transform.y += H - 2 * c[1];
  }
  if (p.guides) p.guides = cleanGuides(axis === "h" ? { x: (p.guides.x ?? []).map((v) => W - v), y: p.guides.y ?? [] } : { x: p.guides.x ?? [], y: (p.guides.y ?? []).map((v) => H - v) });
}
