// Saved paths (Photoshop's Paths panel) ↔ PSD image resources 2000–2997 (Adobe Photoshop File Formats Specification,
// "Path resource format"): 26-byte records — fill rule, subpath length, Bézier knots (preceding control, anchor,
// leaving control, each vertical then horizontal as 8.24 fixed fractions of the canvas height / width).

import type { Contour, SavedPath, VectorAnchor } from "../../core/types";

const FIX = 1 << 24;

/** Unicode → CP949 (Korean Windows, the code page Photoshop reads path names in), built once from the decoder. */
let cp949: Map<string, number> | null = null;
function cp949Table(): Map<string, number> {
  if (cp949) return cp949;
  cp949 = new Map();
  try {
    const dec = new TextDecoder("euc-kr");
    for (let lead = 0x81; lead <= 0xfe; lead++)
      for (let trail = 0x41; trail <= 0xfe; trail++) {
        const c = dec.decode(new Uint8Array([lead, trail]));
        if (c.length === 1 && c !== "\ufffd" && !cp949.has(c)) cp949.set(c, (lead << 8) | trail);
      }
  } catch {
    /* no decoder: Hangul becomes ? */
  }
  return cp949;
}

/** A path name as Photoshop reads it: a Pascal string in CP949 (Korean Windows; other letters become ?). */
export function pascalCp949(name: string): number[] {
  const s: number[] = [];
  for (const c of name) {
    const k = c.charCodeAt(0);
    if (k < 128) s.push(k);
    else {
      const m = cp949Table().get(c);
      if (m) s.push(m >> 8, m & 255);
      else s.push(63);
    }
    if (s.length >= 254) break;
  }
  return s.slice(0, 255);
}

function pascal(name: string): number[] {
  const s = pascalCp949(name);
  const out = [s.length, ...s];
  if (out.length % 2) out.push(0);
  return out;
}

/** The image resources (concatenated '8BIM' blocks) of `paths` for a W × H canvas. */
export function pathResources(paths: readonly SavedPath[], W: number, H: number): Uint8Array {
  const out: number[] = [];
  const u16 = (a: number[], v: number) => a.push((v >> 8) & 255, v & 255);
  const i32 = (a: number[], v: number) => {
    const x = Math.round(v) | 0;
    a.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  };
  const rec = (a: number[], sel: number, body: (b: number[]) => void) => {
    const b: number[] = [];
    u16(b, sel);
    body(b);
    while (b.length < 26) b.push(0);
    a.push(...b);
  };
  const pt = (b: number[], p: [number, number]) => {
    i32(b, (p[1] / H) * FIX);
    i32(b, (p[0] / W) * FIX);
  };
  paths.slice(0, 998).forEach((p, k) => {
    const data: number[] = [];
    rec(data, 6, () => {});
    rec(data, 8, (b) => u16(b, 0));
    for (const c of p.contours) {
      if (c.nodes.length < 2 && !c.closed) continue;
      rec(data, c.closed ? 0 : 3, (b) => u16(b, c.nodes.length));
      for (const n of c.nodes)
        rec(data, c.closed ? (n.isCorner ? 2 : 1) : n.isCorner ? 5 : 4, (b) => {
          pt(b, n.handleIn);
          pt(b, n.anchor);
          pt(b, n.handleOut);
        });
    }
    out.push(...[56, 66, 73, 77]);
    u16(out, 2000 + k);
    out.push(...pascal(p.name));
    const len = data.length;
    out.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
    out.push(...data);
    if (len % 2) out.push(0);
  });
  return Uint8Array.from(out);
}

/** A path resource's data → contours on a W × H canvas (page px); null when it does not read. */
export function readPathResource(d: Uint8Array, W: number, H: number): Contour[] | null {
  if (d.length % 26) return null;
  const i32 = (o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) | 0;
  const pt = (o: number): [number, number] => [(i32(o + 4) / FIX) * W, (i32(o) / FIX) * H];
  const out: Contour[] = [];
  let cur: Contour | null = null;
  let left = 0;
  for (let o = 0; o + 26 <= d.length; o += 26) {
    const sel = (d[o] << 8) | d[o + 1];
    if (sel === 0 || sel === 3) {
      left = (d[o + 2] << 8) | d[o + 3];
      cur = { closed: sel === 0, nodes: [] };
      out.push(cur);
    } else if (sel >= 1 && sel <= 5 && sel !== 3 && cur && left > 0) {
      const a: VectorAnchor = { handleIn: pt(o + 2), anchor: pt(o + 10), handleOut: pt(o + 18), isCorner: sel === 2 || sel === 5 };
      cur.nodes.push(a);
      left--;
    }
  }
  return out.filter((c) => c.nodes.length > 0);
}

/** Image resource bytes with every saved-path resource (2000–2997) replaced by `paths`. */
export function replacePathResources(res: Uint8Array, paths: readonly SavedPath[], W: number, H: number): Uint8Array {
  const keep: number[] = [];
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
    if (!(id >= 2000 && id <= 2997)) for (let i = o; i < end; i++) keep.push(res[i]);
    o = end;
  }
  for (let i = o; i < res.length; i++) keep.push(res[i]);
  const add = pathResources(paths, W, H);
  const out = new Uint8Array(keep.length + add.length);
  out.set(keep);
  out.set(add, keep.length);
  return out;
}

/** The saved paths of a PSD's image resources (bytes `b`, resource items with their spans). */
export function readPaths(b: Uint8Array, items: readonly { id: number; start: number; dataStart: number; dataEnd: number }[], W: number, H: number, uid: () => string): SavedPath[] {
  const out: SavedPath[] = [];
  for (const it of items) {
    if (it.id < 2000 || it.id > 2997) continue;
    const nl = b[it.start + 6];
    const raw = b.subarray(it.start + 7, it.start + 7 + nl);
    let name = String.fromCharCode(...raw);
    if (raw.some((x) => x >= 0x80))
      try {
        name = new TextDecoder("euc-kr").decode(raw);
      } catch {
        /* as bytes */
      }
    name ||= `Path ${out.length + 1}`;
    const c = readPathResource(b.subarray(it.dataStart, it.dataEnd), W, H);
    if (c?.length) out.push({ id: uid(), name, contours: c });
  }
  return out;
}