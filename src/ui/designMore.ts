// More of Illustrator in the design mode (design 2, 2026-11-25): Select › Same (fill colour, stroke colour, fill and
// stroke, stroke weight), the Magic Wand (Y: a click selects every object painted like it), the Smooth tool (a drag
// along a path re-fits it smoother), Pathfinder › Trim and Outline (curves kept), and File › Package (the document,
// its linked pictures and the list of its fonts in one ZIP).

import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { zipSync, strToU8 } from "fflate";
import { invertTransform } from "../core/geom";
import { currentPage, draftPage, useStore } from "../core/store";
import { uid, type Contour, type Vec2, type VectorAnchor, type VectorNode } from "../core/types";
import { autoSmooth } from "../core/pathEdit";
import { flatten } from "../core/vector";
import { curvedContours, pageContours, sampleShapes } from "../core/curveKeep";
import { pickableOn } from "../core/layerTree";
import { simplifyTrack } from "./designPaint";
import { getBlob } from "../core/assets";
import { packOmw } from "../io/omw";
import { saveFile } from "../io/platform";
import { t } from "../i18n";

const S = () => useStore.getState();
const norm = (c: string | null) => (c ?? "none").trim().toLowerCase();

// ───────── Select › Same / Magic Wand ─────────

export type SameKind = "fill" | "stroke" | "fillStroke" | "strokeWidth";

/** Every visible, unlocked path on the page painted like `like` in `kind`. */
function sameAs(like: VectorNode, kind: SameKind): string[] {
  const page = currentPage();
  if (!page) return [];
  const pick = pickableOn(page);
  return page.nodes
    .filter((n): n is VectorNode => n.type === "VECTOR" && n.visible && !n.locked && pick(n))
    .filter((n) =>
      kind === "fill" ? norm(n.fill) === norm(like.fill)
      : kind === "stroke" ? norm(n.stroke) === norm(like.stroke)
      : kind === "fillStroke" ? norm(n.fill) === norm(like.fill) && norm(n.stroke) === norm(like.stroke)
      : Math.abs(n.strokeWidth - like.strokeWidth) < 1e-6 && !!n.stroke === !!like.stroke,
    )
    .map((n) => n.id);
}

/** Select › Same › …: every path like the (first) selected one. */
export function selectSame(kind: SameKind): number {
  const page = currentPage();
  const like = page?.nodes.find((n): n is VectorNode => n.type === "VECTOR" && S().selection.includes(n.id));
  if (!like) return 0;
  const ids = sameAs(like, kind);
  S().set({ selection: ids });
  return ids.length;
}

/** The Magic Wand (Y): a click on a path selects every path with the same fill (Shift adds to the selection). */
export function wandAt(hit: VectorNode | undefined, add: boolean): number {
  if (!hit || hit.type !== "VECTOR") {
    if (!add) S().set({ selection: [] });
    return 0;
  }
  const ids = sameAs(hit, "fill");
  S().set({ selection: add ? [...new Set([...S().selection, ...ids])] : ids });
  return ids.length;
}

// ───────── Smooth tool ─────────

/**
 * The Smooth tool: a drag along a selected path re-fits the part of it the drag passed over — its points there
 * thinned out and the curve through them made smooth. True when a path changed.
 */
export function smoothAlong(track: Vec2[], zoom: number): boolean {
  const page = currentPage();
  if (!page || track.length < 2) return false;
  const reach = 12 / Math.max(zoom, 1e-3);
  const sel = page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && S().selection.includes(n.id) && !n.locked);
  const done = new Map<string, Contour[]>();
  for (const n of sel) {
    const cs = n.contours.map((c) => {
      const local = track.map((q) => invertTransform(n.transform, q));
      const k = Math.abs(n.transform.scale) || 1;
      const close = (p: Vec2) => local.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) * k < reach);
      if (!c.nodes.some((a) => close(a.anchor))) return c;
      // the path as drawn, thinned out with a tolerance of a few screen px, then a smooth curve through what is left
      const pts = flatten(c, 0.5);
      const kept = simplifyTrack(c.closed ? [...pts, pts[0]] : pts, 3 / Math.max(zoom, 1e-3) / k);
      if (c.closed) kept.pop();
      if (kept.length >= c.nodes.length && c.nodes.every((a) => !a.isCorner)) return c;
      const nodes: VectorAnchor[] = kept.map((p) => ({ anchor: [p[0], p[1]], handleIn: [p[0], p[1]], handleOut: [p[0], p[1]], isCorner: false }));
      autoSmooth(nodes, c.closed);
      return { closed: c.closed, nodes };
    });
    if (cs.some((c, i) => c !== n.contours[i])) done.set(n.id, cs);
  }
  if (!done.size) return false;
  S().commit(t("design.hist.smooth"), (d) => {
    for (const n of draftPage(d, page.id)?.nodes ?? []) {
      const cs = done.get(n.id);
      if (cs && n.type === "VECTOR") n.contours = cs as never;
    }
  });
  return true;
}

// ───────── Pathfinder › Trim, Outline ─────────

function selectedClosed(): VectorNode[] {
  const page = currentPage();
  const sel = new Set(S().selection);
  return (page?.nodes ?? []).filter((n): n is VectorNode => n.type === "VECTOR" && sel.has(n.id) && !n.locked && n.contours.some((c) => c.closed && c.nodes.length > 2));
}

function areasOf(sel: VectorNode[]) {
  const sm = sampleShapes(sel.map(pageContours));
  const areas: MultiPolygon[] = sm.rings.map((rs) => (!rs.length ? [] : rs.length === 1 ? [[rs[0]]] : polygonClipping.xor([rs[0]], ...rs.slice(1).map((r) => [r] as Polygon))));
  return { sm, areas };
}

function replaceSelection(label: string, sel: VectorNode[], out: VectorNode[]): number {
  const page = currentPage();
  if (!page || !out.length) return 0;
  const ids = new Set(sel.map((n) => n.id));
  S().commit(label, (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const at = pg.nodes.findIndex((x) => ids.has(x.id));
    pg.nodes = pg.nodes.filter((x) => !ids.has(x.id)) as never;
    pg.nodes.splice(Math.max(0, at), 0, ...(out as never[]));
  });
  S().set({ selection: out.map((v) => v.id) });
  return out.length;
}

const plainOf = (n: VectorNode, contours: Contour[], patch: Partial<VectorNode> = {}): VectorNode => ({ ...n, id: uid("n"), contours, transform: { x: 0, y: 0, rotation: 0, scale: 1 }, strokeWidth: n.strokeWidth * (Math.abs(n.transform.scale) || 1), fillRule: "nonzero", ...patch });

/** Pathfinder › Trim: each shape keeps only what is not under the shapes above it; strokes go (Illustrator). */
export function trimPaths(): number {
  const sel = selectedClosed();
  if (sel.length < 2) return 0;
  const { sm, areas } = areasOf(sel);
  const out: VectorNode[] = [];
  sel.forEach((n, i) => {
    const above = areas.slice(i + 1).filter((a) => a.length);
    const own = above.length ? polygonClipping.difference(areas[i], ...above) : areas[i];
    for (const poly of own) {
      const cs = curvedContours([poly], sm);
      if (cs.length) out.push(plainOf(n, cs, { stroke: null, strokeWidth: 0 }));
    }
  });
  return replaceSelection(t("design.path.hist.trim"), sel, out);
}

/** Pathfinder › Outline: the shapes divided, each piece's edge a stroked line in its fill colour, no fill. */
export function outlinePaths(): number {
  const sel = selectedClosed();
  if (sel.length < 2) return 0;
  const { sm, areas } = areasOf(sel);
  const pieces: { mp: MultiPolygon; top: VectorNode }[] = [];
  // the regions of the overlap pattern (as Divide), each with the colour of the topmost shape over it
  let seen: MultiPolygon = [];
  let atoms: { mp: MultiPolygon; top: VectorNode }[] = [];
  sel.forEach((n, i) => {
    const a = areas[i];
    if (!a.length) return;
    const next: typeof atoms = [];
    for (const x of atoms) {
      const inter = polygonClipping.intersection(x.mp, a), diff = polygonClipping.difference(x.mp, a);
      if (inter.length) next.push({ mp: inter, top: n });
      if (diff.length) next.push({ mp: diff, top: x.top });
    }
    const rest = seen.length ? polygonClipping.difference(a, seen) : a;
    if (rest.length) next.push({ mp: rest, top: n });
    seen = seen.length ? polygonClipping.union(seen, a) : a;
    atoms = next;
  });
  pieces.push(...atoms);
  const out: VectorNode[] = [];
  for (const p of pieces)
    for (const poly of p.mp) {
      const cs = curvedContours([poly], sm);
      if (cs.length) out.push(plainOf(p.top, cs, { fill: null, stroke: p.top.fill ?? p.top.stroke ?? "#000000", strokeWidth: 1 }));
    }
  return replaceSelection(t("design.path.hist.outline"), sel, out);
}

// ───────── File › Package ─────────

/** File › Package: the document (.omw), its pictures (Links/) and the fonts it uses (Fonts.txt) in one ZIP. */
export async function packageDoc(): Promise<boolean> {
  const doc = S().doc;
  const name = (doc.title || "document").replace(/[\\/:*?"<>|]/g, "_");
  const files: Record<string, Uint8Array> = {};
  files[`${name}.omw`] = packOmw(doc).bytes;
  const fonts = new Set<string>();
  for (const p of [...doc.pages, ...doc.masters])
    for (const n of p.nodes) if (n.type === "TEXT") for (const para of n.paragraphs) for (const r of para.runs) fonts.add(r.fontFamily);
  let k = 0;
  for (const a of Object.values(doc.assets)) {
    const b = getBlob(a.hash);
    if (!b) continue;
    const ext = (a.mime.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
    files[`Links/${(a.name || `link-${++k}`).replace(/[\\/:*?"<>|]/g, "_").replace(/\.[^.]+$/, "")}.${ext}`] = b;
  }
  files["Fonts.txt"] = strToU8([...fonts].sort().join("\r\n") + "\r\n");
  files["Instructions.txt"] = strToU8(t("design.pkg.readme", { name, links: Object.keys(files).filter((f) => f.startsWith("Links/")).length, fonts: fonts.size }) + "\r\n");
  const zip = zipSync(files);
  const saved = await saveFile(`${name} Folder.zip`, zip, [{ name: "ZIP", extensions: ["zip"] }]);
  if (saved) S().notify(t("design.pkg.done", { name: `${name} Folder.zip` }));
  return !!saved;
}
