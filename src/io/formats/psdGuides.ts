// Ruler guides in a PSD: image resource 1032 (Grid and guides) — version 1, the grid cycle (576 = a quarter inch, as
// Photoshop writes it), then each guide as its position in 1/32 px and its direction (0 = vertical, 1 = horizontal).
// Read into page.guides (x = vertical lines, y = horizontal lines, in page px) and written back from it, so guides
// made in the image mode (보기 › 안내선 …) are in the file Photoshop opens, and a PSD's own guides come in.
import type { PageGuides } from "../../core/types";

const ID = 1032;

/** the whole '8BIM' block of resource 1032 for these guides, or an empty array when there are none */
export function guidesResource(g: PageGuides | undefined): Uint8Array {
  const list = [...(g?.x ?? []).map((v) => [v, 0] as const), ...(g?.y ?? []).map((v) => [v, 1] as const)].filter(([v]) => Number.isFinite(v));
  if (!list.length) return new Uint8Array(0);
  const n = 16 + list.length * 5;
  const out = new Uint8Array(12 + n + (n % 2));
  const dv = new DataView(out.buffer);
  out.set([56, 66, 73, 77], 0); // 8BIM
  dv.setUint16(4, ID);
  // (empty Pascal name: length 0 + a pad byte)
  dv.setUint32(8, n);
  let o = 12;
  dv.setUint32(o, 1);
  dv.setUint32(o + 4, 576);
  dv.setUint32(o + 8, 576);
  dv.setUint32(o + 12, list.length);
  o += 16;
  for (const [v, dir] of list) {
    dv.setInt32(o, Math.round(v * 32));
    out[o + 4] = dir;
    o += 5;
  }
  return out;
}

/** the guides of resource 1032 among a PSD's image resource items, or undefined when it has none */
export function readGuides(b: Uint8Array, items: readonly { id: number; dataStart: number; dataEnd: number }[]): PageGuides | undefined {
  const it = items.find((x) => x.id === ID);
  if (!it || it.dataEnd - it.dataStart < 16) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset + it.dataStart, it.dataEnd - it.dataStart);
  const n = dv.getUint32(12);
  const x: number[] = [], y: number[] = [];
  for (let i = 0, o = 16; i < n && o + 5 <= dv.byteLength; i++, o += 5) {
    const v = dv.getInt32(o) / 32;
    (dv.getUint8(o + 4) ? y : x).push(v);
  }
  if (!x.length && !y.length) return undefined;
  return { ...(x.length ? { x } : {}), ...(y.length ? { y } : {}) };
}

/** a resources section (whole '8BIM' blocks) with its 1032 block replaced by these guides (or dropped) */
export function replaceGuidesResource(res: Uint8Array, g: PageGuides | undefined): Uint8Array {
  const keep: Uint8Array[] = [];
  let o = 0;
  while (o + 12 <= res.length && res[o] === 56 && res[o + 1] === 66 && res[o + 2] === 73 && res[o + 3] === 77) {
    const id = (res[o + 4] << 8) | res[o + 5];
    let p = o + 6;
    const nl = res[p];
    p += 1 + nl;
    if ((1 + nl) % 2) p++;
    const len = ((res[p] << 24) | (res[p + 1] << 16) | (res[p + 2] << 8) | res[p + 3]) >>> 0;
    const end = p + 4 + len + (len % 2);
    if (end > res.length) break;
    if (id !== ID) keep.push(res.subarray(o, end));
    o = end;
  }
  if (o < res.length) keep.push(res.subarray(o));
  keep.push(guidesResource(g));
  const out = new Uint8Array(keep.reduce((a, x) => a + x.length, 0));
  let at = 0;
  for (const x of keep) out.set(x, (at += x.length) - x.length);
  return out;
}
