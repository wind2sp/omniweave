// '고급 개체 열기' — a PSD smart object's content in a document tab of its own, as Photoshop's Edit Contents: the
// embedded PSB / PSD / PNG / JPEG opens in a new tab; saving there (Ctrl+S) puts it back into the parent document —
// the layer drawn anew from it through its transform, the embedded file replaced on the next PSD save — instead of
// writing a file. The engine part is io/formats/psdSmartEdit.ts.

import { activeSessionId, sessionDoc, sessionHooks, switchTo, tabMeta, updateSessionDoc } from "../core/sessions";
import { currentPage, useStore } from "../core/store";
import type { RasterNode } from "../core/types";
import { t } from "../i18n";
import { rasterizeNode } from "../io/export";
import { applySmartContent, smartContentBytes, smartContentName, smartContentOut } from "../io/formats/psdSmartEdit";
import { withProgress } from "./progress";

/** A tab showing a smart object's content: where it goes back to. */
export interface SmartLink {
  parent: string;
  pageId: string;
  nodeId: string;
  /** the linked-file entry it shows (instances of one smart object — duplicated layers — share it) */
  smartId: string;
  content: NonNullable<NonNullable<RasterNode["psdSmart"]>["content"]>;
  /** content size when it was opened (only a fallback: the size the corners belong to is the parent layer's own) */
  w: number;
  h: number;
}

const links = new Map<string, SmartLink>();
const S = () => useStore.getState();

sessionHooks.closed.push((id) => {
  links.delete(id);
  for (const [k, v] of links) if (v.parent === id) links.delete(k);
});

export const smartLinkOf = (session: string = activeSessionId()) => links.get(session) ?? null;

/**
 * Tabs in the order they are to be saved when several are saved together (closing, quitting): a smart object's content
 * tab before the document it goes back into — its save changes that document, which is then saved with it.
 */
export function smartChildrenFirst(ids: string[]): string[] {
  const depth = (id: string) => {
    let d = 0;
    for (let l = links.get(id); l && d < 64; l = links.get(l.parent)) d++;
    return d;
  };
  return ids.map((id, i) => ({ id, i, d: depth(id) })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.id);
}

/** The content size the layer's placed corners belong to: its last put-back content, else the original's. */
function cornersSize(n: RasterNode, link: SmartLink): { w: number; h: number } {
  const sm = n.psdSmart!;
  return sm.edited ? { w: sm.edited.w, h: sm.edited.h } : sm.contentSize ?? { w: link.w, h: link.h };
}

/** The selected (or given) layer when it is a smart object whose content opens here. */
export function smartTarget(nodeId?: string): RasterNode | null {
  const page = currentPage();
  const id = nodeId ?? (S().selection.length === 1 ? S().selection[0] : undefined);
  const n = id ? page?.nodes.find((x) => x.id === id) : undefined;
  return n?.type === "RASTER" && n.psdSmart?.kind === "embedded" && n.psdSmart.content ? n : null;
}

/** Why a smart layer does not open (linked, a kind that does not open), or null when it does. */
export function smartRefusal(n: RasterNode): string | null {
  const sm = n.psdSmart;
  if (!sm) return null;
  if (sm.kind === "linked") return t(sm.found === false ? "psdsmart.linkedMissing" : "psdsmart.linked", { path: sm.path ?? sm.name });
  if (!sm.content) return t("psdsmart.cannotOpen", { name: sm.name });
  return null;
}

/** Open the smart object's content in a tab of its own (an already open one is brought forward). */
export async function openSmartObject(nodeId?: string): Promise<boolean> {
  const page = currentPage();
  const id = nodeId ?? (S().selection.length === 1 ? S().selection[0] : undefined);
  const any = id ? page?.nodes.find((x) => x.id === id) : undefined;
  if (any?.type === "RASTER" && any.psdSmart && !smartTarget(any.id)) {
    S().notify(smartRefusal(any) ?? t("psdsmart.cannotOpen", { name: any.name }));
    return false;
  }
  const node = smartTarget(id);
  if (!page || !node) return false;
  const parent = activeSessionId();
  // already open (this layer, or another instance of the same smart object): that tab
  for (const [k, v] of links) if (v.parent === parent && (v.nodeId === node.id || v.smartId === node.psdSmart!.id) && tabMeta(k)) return switchTo(k);
  const bytes = smartContentBytes(S().doc, page, node);
  if (!bytes) {
    S().notify(t("psdsmart.noData", { name: node.name }));
    return false;
  }
  const { openInTab } = await import("./actions");
  const pages = await openInTab({ name: smartContentName(node.psdSmart!), path: null, bytes });
  const child = activeSessionId();
  if (!pages.length || child === parent) return false;
  const cp = pages[0];
  links.set(child, { parent, pageId: page.id, nodeId: node.id, smartId: node.psdSmart!.id, content: node.psdSmart!.content!, w: Math.round(cp.width), h: Math.round(cp.height) });
  S().notify(t("psdsmart.opened", { name: node.name }));
  return true;
}

/**
 * Save of a content tab: back into the parent document (one undo step there). True when this tab is one (the caller
 * then writes no file).
 */
export async function saveSmartToParent(): Promise<boolean> {
  const child = activeSessionId();
  const link = links.get(child);
  if (!link) return false;
  const parentDoc = sessionDoc(link.parent);
  const ppage = parentDoc?.pages.find((p) => p.id === link.pageId);
  const pnode = ppage?.nodes.find((n) => n.id === link.nodeId);
  if (!parentDoc || !ppage || pnode?.type !== "RASTER" || !pnode.psdSmart) {
    links.delete(child);
    S().notify(t("psdsmart.parentGone"));
    return false; // saved as an ordinary document instead
  }
  const doc = S().doc;
  const page = doc.pages[0];
  // every instance of this smart object (duplicated layers share one embedded file): all show the new content, as in
  // Photoshop; one that cannot be drawn back (warp, smart filters, mask) keeps its pixels and is said
  const sid = pnode.psdSmart.id;
  const instances = ppage!.nodes.filter((n): n is RasterNode => n.type === "RASTER" && n.psdSmart?.kind === "embedded" && n.psdSmart.id === sid);
  try {
    const put = await withProgress(t("psdsmart.putting"), async () => {
      const out = await smartContentOut(doc, page, link.content, { rasterize: rasterizeNode });
      // (the layer this tab was opened from first: when it cannot be drawn back, nothing is put back)
      const first = applySmartContent(pnode, out, cornersSize(pnode, link));
      const done = new Map<string, RasterNode>([[pnode.id, first.node]]);
      let kept = 0;
      for (const n of instances) {
        if (n.id === pnode.id) continue;
        if (!n.psdSmart!.redraw) {
          kept++;
          continue;
        }
        const r = applySmartContent(n, out, cornersSize(n, link));
        // (one asset for the one embedded file)
        r.node.psdSmart = { ...r.node.psdSmart!, edited: { ...r.node.psdSmart!.edited!, assetId: first.asset.id } };
        done.set(n.id, r.node);
      }
      return { out, asset: first.asset, done, kept };
    });
    updateSessionDoc(link.parent, t("psdsmart.hist", { name: pnode.name }), (d) => ({
      ...d,
      assets: { ...d.assets, [put.asset.id]: put.asset },
      pages: d.pages.map((p) => (p.id === link.pageId ? { ...p, nodes: p.nodes.map((n) => put.done.get(n.id) ?? n) } : p)),
    }));
    S().set({ dirty: false });
    const notes = [...(put.done.size > 1 ? [t("psdsmart.instances", { n: put.done.size })] : []), ...(put.kept ? [t("psdsmart.instancesKept", { n: put.kept })] : []), ...put.out.warnings];
    S().notify(t("psdsmart.putBack", { name: pnode.name }) + (notes.length ? " · " + notes.join(" · ") : ""));
  } catch (e: any) {
    S().notify(t("psdsmart.failed", { error: String(e?.message ?? e) }));
  }
  return true;
}
