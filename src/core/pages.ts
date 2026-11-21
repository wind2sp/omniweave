// Page organising and guide editing (pure). Mutating helpers work on plain objects and on immer
// drafts alike, so the UI calls them inside store.commit and tests call them on plain pages.

import { t } from "../i18n";
import type { Page, PageGuides } from "./types";

// ───────── page ranges ─────────

export interface RangeParse {
  /** zero-based page indices per group, in the order written */
  groups: number[][];
  error?: string;
}

/**
 * "1-3, 5, 8-" → [[0,1,2],[4],[7..total-1]]. Accepts "-4" (from the first), "8-" (to the last),
 * "~" or "–" as dashes, ";" or "," as separators, and reversed ranges ("5-3" → 5,4,3).
 * Numbers past the last page are an error, so nothing is silently dropped.
 */
export function parsePageRanges(text: string, total: number): RangeParse {
  const groups: number[][] = [];
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { groups, error: t("engine.pages.empty") };
  for (const part of parts) {
    const m = /^(\d*)\s*(?:([-~–—])\s*(\d*))?$/.exec(part);
    if (!m || (!m[1] && !m[3] && !m[2]) || (!m[1] && !m[2])) return { groups: [], error: t("engine.pages.unreadable", { part }) };
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : total) : a;
    if (a < 1 || b < 1) return { groups: [], error: t("engine.pages.fromOne", { part }) };
    if (a > total || b > total) return { groups: [], error: t("engine.pages.noSuchPage", { page: Math.max(a, b), total }) };
    const g: number[] = [];
    if (a <= b) for (let i = a; i <= b; i++) g.push(i - 1);
    else for (let i = a; i >= b; i--) g.push(i - 1);
    groups.push(g);
  }
  return { groups };
}

/** All indices of a range string in order, without repeats (for "insert pages 2-4, 7"). */
export function flattenRanges(groups: number[][]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const g of groups) for (const i of g) if (!seen.has(i)) seen.add(i), out.push(i);
  return out;
}

/** Split 0..total-1 into consecutive groups of `n` pages (the last may be shorter). */
export function chunkPages(total: number, n: number): number[][] {
  const size = Math.max(1, Math.floor(n));
  const out: number[][] = [];
  for (let i = 0; i < total; i += size) out.push(Array.from({ length: Math.min(size, total - i) }, (_, k) => i + k));
  return out;
}

/** "1-3, 5" — compact label for a set of zero-based indices (file names, notices). */
export function rangeLabel(indices: number[]): string {
  const s = [...new Set(indices)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i] + 1}-${s[j] + 1}` : `${s[i] + 1}`);
    i = j + 1;
  }
  return out.join(", ");
}

// ───────── ordering ─────────

/**
 * Move the items with `ids` so they sit, in their current relative order, just before the item
 * that was at `target` in the original list (target = list.length → at the end).
 */
export function moveIdsTo<T extends { id: string }>(list: T[], ids: Iterable<string>, target: number): T[] {
  const set = new Set(ids);
  const moving = list.filter((x) => set.has(x.id));
  if (!moving.length) return list;
  const t = Math.max(0, Math.min(list.length, target));
  const before = list.slice(0, t).filter((x) => !set.has(x.id));
  const after = list.slice(t).filter((x) => !set.has(x.id));
  const out = [...before, ...moving, ...after];
  return out.every((x, i) => x === list[i]) ? list : out;
}

/**
 * Lists shown top-first (layers: the top of the stack is drawn first) but stored bottom-first:
 * dropping on the upper / lower half of display row `row` → insertion index in the stored list.
 */
export function reversedDropIndex(count: number, row: number, below: boolean): number {
  return Math.max(0, Math.min(count, below ? count - 1 - row : count - row));
}

export type InsertWhere = "start" | "end" | "before" | "after" | { afterPage: number };

/** Index to insert at. `cur` = index of the reference (current / first selected) page; afterPage is 1-based (0 = start). */
export function insertionIndex(where: InsertWhere, cur: number, total: number): number {
  if (where === "start") return 0;
  if (where === "end") return total;
  if (where === "before") return Math.max(0, Math.min(total, cur));
  if (where === "after") return Math.max(0, Math.min(total, cur + 1));
  return Math.max(0, Math.min(total, Math.floor(where.afterPage)));
}

// ───────── rotate / resize ─────────

const normDeg = (d: number) => {
  let r = ((d % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return Math.abs(r) < 1e-9 ? 0 : r;
};

type MutablePage = Pick<Page, "width" | "height" | "nodes"> & { guides?: PageGuides };

/**
 * Turn a page a quarter turn (dir 1 = clockwise, -1 = counter-clockwise), the same way for every
 * page kind: width and height swap, and every object — including an imported PDF page, which is
 * an object — turns with the page about the page origin. Nothing is resampled: PDF pages stay the
 * original vector page (the PDF writer embeds it with a rotation matrix), images keep their pixels.
 * Guides turn with the page.
 */
export function rotatePageInPlace(p: MutablePage, dir: 1 | -1) {
  const W = p.width, H = p.height;
  for (const n of p.nodes) {
    const t = n.transform;
    const x = t.x, y = t.y;
    if (dir === 1) {
      t.x = H - y;
      t.y = x;
    } else {
      t.x = y;
      t.y = W - x;
    }
    t.rotation = normDeg(t.rotation + 90 * dir);
  }
  if (p.guides) {
    const gx = p.guides.x ?? [], gy = p.guides.y ?? [];
    const nx = dir === 1 ? gy.map((v) => H - v) : gy.slice();
    const ny = dir === 1 ? gx.slice() : gx.map((v) => W - v);
    p.guides = cleanGuides({ x: nx, y: ny });
  }
  p.width = H;
  p.height = W;
}

/**
 * New page size. With `scaleContent` the objects are scaled uniformly (fit) and centred, so the
 * content keeps its proportions; otherwise only the page size changes (objects stay at their
 * coordinates). Guides are scaled per axis when content is scaled.
 */
export function resizePageInPlace(p: MutablePage, width: number, height: number, scaleContent = false) {
  const W = p.width, H = p.height;
  if (scaleContent && W > 0 && H > 0) {
    const k = Math.min(width / W, height / H);
    const ox = (width - W * k) / 2, oy = (height - H * k) / 2;
    for (const n of p.nodes) {
      n.transform.x = n.transform.x * k + ox;
      n.transform.y = n.transform.y * k + oy;
      n.transform.scale = n.transform.scale * k;
      // non-uniform objects keep their proportions
      if (n.transform.scaleY !== undefined) n.transform.scaleY = n.transform.scaleY * k;
    }
    if (p.guides) p.guides = cleanGuides({ x: (p.guides.x ?? []).map((v) => v * k + ox), y: (p.guides.y ?? []).map((v) => v * k + oy) });
  }
  p.width = width;
  p.height = height;
}

// ───────── guides ─────────

export type GuideAxis = "x" | "y";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Sorted, de-duplicated, finite; empty axes removed; undefined when nothing is left (keeps files unchanged). */
export function cleanGuides(g: PageGuides | undefined | null): PageGuides | undefined {
  if (!g) return undefined;
  const fix = (a?: number[]) => [...new Set((a ?? []).filter((v) => isFinite(v)).map(r3))].sort((p, q) => p - q);
  const x = fix(g.x), y = fix(g.y);
  if (!x.length && !y.length) return undefined;
  const out: PageGuides = {};
  if (x.length) out.x = x;
  if (y.length) out.y = y;
  return out;
}

export function addGuide(g: PageGuides | undefined, axis: GuideAxis, v: number): PageGuides | undefined {
  const next = { x: [...(g?.x ?? [])], y: [...(g?.y ?? [])] };
  next[axis].push(v);
  return cleanGuides(next);
}

export function removeGuide(g: PageGuides | undefined, axis: GuideAxis, v: number): PageGuides | undefined {
  if (!g) return g;
  const next = { x: [...(g.x ?? [])], y: [...(g.y ?? [])] };
  const i = next[axis].findIndex((q) => Math.abs(q - v) < 1e-6);
  if (i >= 0) next[axis].splice(i, 1);
  return cleanGuides(next);
}

export function moveGuide(g: PageGuides | undefined, axis: GuideAxis, from: number, to: number): PageGuides | undefined {
  return addGuide(removeGuide(g, axis, from), axis, to);
}

/** Nearest guide to a page point within `tol` (page px). */
export function hitGuide(g: PageGuides | undefined, px: number, py: number, tol: number): { axis: GuideAxis; v: number } | null {
  let best: { axis: GuideAxis; v: number } | null = null;
  let bd = tol;
  for (const v of g?.x ?? []) if (Math.abs(v - px) <= bd) (bd = Math.abs(v - px)), (best = { axis: "x", v });
  for (const v of g?.y ?? []) if (Math.abs(v - py) <= bd) (bd = Math.abs(v - py)), (best = { axis: "y", v });
  return best;
}

/** Guides of a page plus its master's (slides show the master's guides too). */
export function mergedGuides(page: { guides?: PageGuides }, master: { guides?: PageGuides } | null): PageGuides {
  return { x: [...(page.guides?.x ?? []), ...(master?.guides?.x ?? [])], y: [...(page.guides?.y ?? []), ...(master?.guides?.y ?? [])] };
}
