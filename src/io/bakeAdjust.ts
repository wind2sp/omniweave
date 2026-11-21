// Adjustment layers (PSD levels, curves, … — RasterNode.adjust) recolour what is below them. PDF, SVG, DOCX, HWPX
// and PPTX have no such layer, so before those exports the layers an adjustment touches are drawn together, the
// adjustment applied (render/compose.ts), and go in as one picture (UNIFIED_STYLES: "what the format cannot hold is
// set as a picture so the page keeps its look"). Everything above the topmost adjustment stays live (text, vectors).
// An unedited PSD page goes in as Photoshop's own merged image (core/fidelity/overlay.ts pristinePsdView).
import { makeAsset } from "../core/assets";
import { pristinePsdView } from "../core/fidelity/overlay";
import { groupIndex, groupPath } from "../core/layerTree";
import { newImage, type AssetRef, type OmwDocument, type Page, type SceneNode } from "../core/types";

export type BakeRasterize = (doc: OmwDocument, page: Page, nodes: SceneNode[]) => Promise<{ png: Uint8Array; x: number; y: number; w: number; h: number } | null>;

/** Is this node an adjustment layer that shows (its own eye and every enclosing folder's)? */
function liveAdjust(n: SceneNode, gi: ReturnType<typeof groupIndex>): boolean {
  return n.type === "RASTER" && !!n.adjust && n.visible && n.opacity > 0 && groupPath(n.groupId, gi).every((g) => g.visible);
}

/**
 * How many of the page's nodes (from the bottom) must be drawn as one picture: up to the topmost showing adjustment
 * layer, grown so that no folder or clipping stack is split; 0 when the page has none.
 */
export function bakeCount(page: Pick<Page, "nodes" | "groups">): number {
  const gi = groupIndex(page.groups);
  let k = -1;
  page.nodes.forEach((n, i) => liveAdjust(n, gi) && (k = i));
  if (k < 0) return 0;
  const top = (n: SceneNode) => groupPath(n.groupId, gi)[0]?.id;
  for (let grown = true; grown; ) {
    grown = false;
    // a folder reaching above the cut: the whole folder (its blend / opacity apply to all its members at once)
    const folders = new Set(page.nodes.slice(0, k + 1).map(top).filter(Boolean));
    for (let i = page.nodes.length - 1; i > k; i--) {
      if (folders.has(top(page.nodes[i]))) {
        k = i;
        grown = true;
        break;
      }
    }
    // layers clipped to a layer of the picture
    while (k + 1 < page.nodes.length && page.nodes[k + 1].clip) {
      k++;
      grown = true;
    }
  }
  return k + 1;
}

/**
 * The document with every page that has a showing adjustment layer drawn as described above (new picture assets
 * added), plus how many pages changed. Pages without one are passed through as they are (same objects).
 */
export async function bakeAdjustDoc(doc: OmwDocument, pages: Page[], rasterize: BakeRasterize): Promise<{ doc: OmwDocument; pages: Page[]; baked: number }> {
  let baked = 0;
  const assets: Record<string, AssetRef> = { ...doc.assets };
  const map = new Map<Page, Page>();
  for (const page of new Set([...doc.pages, ...pages])) {
    const n = bakeCount(page);
    if (!n) continue;
    // unedited PSD: Photoshop's merged image is the truth (adjustments exactly as Photoshop drew them)
    const view = pristinePsdView(page);
    const below = view ? view.nodes : page.nodes.slice(0, n);
    const rest = view ? [] : page.nodes.slice(n);
    const r = await rasterize(doc, view ?? page, below);
    const nodes: SceneNode[] = [...rest];
    if (r) {
      const a = makeAsset(r.png, "image/png", `${page.name}.png`);
      assets[a.id] = a;
      const img = newImage(a.id, r.w, r.h, below.find((x) => x.type === "RASTER" && x.adjust)?.name ?? page.name);
      img.transform = { ...img.transform, x: r.x, y: r.y };
      nodes.unshift(img);
    }
    const used = new Set(nodes.map((x) => x.groupId).filter(Boolean));
    const gi = groupIndex(page.groups);
    const keep = new Set([...used].flatMap((id) => groupPath(id, gi).map((g) => g.id)));
    const groups = page.groups?.filter((g) => keep.has(g.id));
    map.set(page, { ...page, nodes, groups: groups?.length ? groups : undefined });
    baked++;
  }
  if (!baked) return { doc, pages, baked };
  const out = { ...doc, assets, pages: doc.pages.map((p) => map.get(p) ?? p) };
  return { doc: out, pages: pages.map((p) => map.get(p) ?? p), baked };
}
