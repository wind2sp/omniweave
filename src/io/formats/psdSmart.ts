// PSD smart objects (placed layers): the placed-layer block of a record (SoLd / SoLE / PlLd — which file, its transform,
// warp and smart filters) and the document's linked-file blocks (global lnk2 / lnk3 / lnkD / lnkE: the embedded file
// itself, or the path of an external one). Clean-room from Adobe's "Photoshop File Formats Specification" ("Placed
// Layer Data", "Linked Layer") and Photoshop's own files (qa/interop/adobe-made/fidelity/omni-fid-smart-*).
//
// What this gives the editor:
//   • an embedded smart object's content (PSB / PSD / PNG / JPEG) opens as a document of its own — Photoshop's
//     'Edit Contents' — and saving it there puts the new file back into the parent's linked-file entry
//     (replaceLinkedData) and draws the layer's pixels anew from it through the placed transform (projectPlaced:
//     the four corners, a perspective one included);
//   • a linked one names its file (path as stored) so its state — found next to the document or missing — is said.
// Nothing here changes an unedited file: the Surgeon still copies every block byte for byte.

import { t } from "../../i18n";
import { readDescEnd, type DVal, type Desc } from "./psdFx";
import { LONG_KEYS, type PsdBlock, type PsdLayout, type PsdRecord } from "./psd";

export const PLACED_KEYS = new Set(["SoLd", "SoLE", "PlLd", "plLd"]);
export const LINKED_FILE_KEYS = new Set(["lnk2", "lnk3", "lnkD", "lnkE"]);

/** One entry of a linked-file block. Offsets are absolute in the file. */
export interface PsdLinkedFile {
  /** block it lives in (its key and start) */
  key: string;
  blockStart: number;
  /** liFD = data embedded here, liFE = external file, liFA = alias */
  type: string;
  version: number;
  /** unique id the placed-layer block names (Idnt) */
  id: string;
  /** original file name */
  name: string;
  /** file type ('8BPB', 'png ', 'JPEG', 'PDF ' …) and creator */
  fileType: string;
  creator: string;
  /** the embedded bytes (liFD; liFE version 2) */
  data?: { start: number; end: number };
  /** where its 8-byte data length is, and where its file name (Unicode string) starts */
  lengthAt: number;
  nameAt: number;
  /** external file: the paths its descriptor stores */
  fullPath?: string;
  relPath?: string;
  originalPath?: string;
  /** the entry, from its 8-byte length to the end of its padding */
  start: number;
  end: number;
}

const str4 = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function textOf(d: Desc | undefined, key: string): string | undefined {
  const v = d?.items.find((x) => x[0] === key)?.[1];
  return v?.t === "TEXT" ? v.v.replace(/\0+$/, "") : undefined;
}

/** Entries of one linked-file block (null when its layout cannot be followed). */
export function linkedFilesOf(b: Uint8Array, blk: PsdBlock): PsdLinkedFile[] | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: PsdLinkedFile[] = [];
  let o = blk.dataStart;
  while (o + 8 <= blk.dataEnd) {
    const len = dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);
    const s = o + 8, e = s + len;
    if (len < 9 || e > blk.dataEnd) return null;
    let end = e;
    while ((end - blk.dataStart) % 4 && end < blk.dataEnd) end++;
    const f: PsdLinkedFile = { key: blk.key, blockStart: blk.start, type: str4(b, s), version: dv.getUint32(s + 4), id: "", name: "", fileType: "", creator: "", lengthAt: -1, nameAt: -1, start: o, end };
    try {
      let p = s + 8;
      const idLen = b[p++];
      for (let i = 0; i < idLen; i++) f.id += String.fromCharCode(b[p + i]);
      p += idLen;
      f.nameAt = p;
      const nl = dv.getUint32(p);
      p += 4;
      if (p + nl * 2 > e) throw new Error("name");
      for (let i = 0; i < nl; i++) f.name += String.fromCharCode(dv.getUint16(p + i * 2));
      f.name = f.name.replace(/\0+$/, "");
      p += nl * 2;
      f.fileType = str4(b, p);
      f.creator = str4(b, p + 4);
      p += 8;
      f.lengthAt = p;
      const dataLen = dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4);
      p += 8;
      const open = b[p++];
      if (open) p = readDescEnd(b, p + 4).end; // version 16, then the open parameters
      if (f.type === "liFE") {
        const lf = readDescEnd(b, p + 4); // version, then the linked file descriptor
        p = lf.end;
        f.fullPath = textOf(lf.desc, "fullPath");
        f.relPath = textOf(lf.desc, "relPath");
        f.originalPath = textOf(lf.desc, "originalPath");
        if (!f.name) f.name = textOf(lf.desc, "Nm  ") ?? "";
        if (f.version > 3) p += 16; // date and time of the file
        const size = dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4);
        p += 8;
        if (f.version === 2 && p + size <= e) f.data = { start: p, end: p + size };
      } else if (f.type === "liFD" && p + dataLen <= e) f.data = { start: p, end: p + dataLen };
    } catch {
      // a layout this does not follow: the entry is kept as it is, its content not offered
      f.data = undefined;
    }
    out.push(f);
    o = end;
  }
  return o === blk.dataEnd ? out : null;
}

/** Every linked-file entry of the document. */
export function linkedFiles(L: Pick<PsdLayout, "bytes" | "globalBlocks">): PsdLinkedFile[] {
  const out: PsdLinkedFile[] = [];
  for (const blk of L.globalBlocks) if (LINKED_FILE_KEYS.has(blk.key)) out.push(...(linkedFilesOf(L.bytes, blk) ?? []));
  return out;
}

/** A placed layer's settings: which file (Idnt), its four corners on the page, its size, and what it is drawn with. */
export interface PsdPlaced {
  /** the linked-file entry's id */
  id: string;
  /** SoLE = a linked (external) file; SoLd / PlLd = data in the document */
  key: string;
  /** corners top-left, top-right, bottom-right, bottom-left (x, y) on the canvas; the perspective one when present */
  quad: number[];
  /** the content size the placed layer was made with ('Sz  ') */
  size?: { w: number; h: number };
  /** warp other than none, smart filters, or a descriptor this could not read: its pixels cannot be redrawn here */
  warped: boolean;
  filters: boolean;
  exact: boolean;
}

const doubles = (v: DVal | undefined): number[] | null => (v?.t === "VlLs" && v.v.length === 8 && v.v.every((x) => x.t === "doub") ? v.v.map((x) => (x as { v: number }).v) : null);
const item = (d: Desc | undefined, k: string) => d?.items.find((x) => x[0] === k)?.[1];

/** The record's placed-layer block, read (null: not a smart object, or nothing usable). */
export function readPlaced(b: Uint8Array, rec: PsdRecord): PsdPlaced | null {
  const blk = rec.blocks.find((k) => k.key === "SoLd" || k.key === "SoLE") ?? rec.blocks.find((k) => k.key === "PlLd" || k.key === "plLd");
  if (!blk) return null;
  const d = b.subarray(blk.dataStart, blk.dataEnd);
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (blk.key === "SoLd" || blk.key === "SoLE") {
    if (d.length < 12 || str4(d, 0) !== "soLD") return null;
    try {
      const { desc } = readDescEnd(d, 12);
      const id = textOf(desc, "Idnt") ?? "";
      const quad = doubles(item(desc, "nonAffineTransform")) ?? doubles(item(desc, "Trnf"));
      if (!id || !quad) return null;
      const sz = item(desc, "Sz  ");
      const w = sz?.t === "Objc" ? item(sz.v, "Wdth") : undefined, h = sz?.t === "Objc" ? item(sz.v, "Hght") : undefined;
      const warp = item(desc, "warp");
      const style = warp?.t === "Objc" ? item(warp.v, "warpStyle") : undefined;
      const warped = (style?.t === "enum" && style.v !== "warpNone") || !!(warp?.t === "Objc" && item(warp.v, "customEnvelopeWarp"));
      const filters = !!item(desc, "filterFX");
      return { id, key: blk.key, quad, ...(w?.t === "doub" && h?.t === "doub" ? { size: { w: w.v, h: h.v } } : {}), warped, filters, exact: true };
    } catch {
      return null;
    }
  }
  // the older PlLd alone: 'plcL', version, Pascal id, page, pages, anti-alias, layer type, eight doubles
  if (d.length < 9 || str4(d, 0) !== "plcL") return null;
  const n = d[8];
  let id = "";
  for (let i = 0; i < n; i++) id += String.fromCharCode(d[9 + i]);
  const p = 9 + n + 16;
  if (p + 64 > d.length) return null;
  const quad = Array.from({ length: 8 }, (_, i) => dv.getFloat64(p + i * 8));
  return { id, key: blk.key, quad, warped: true, filters: false, exact: false };
}

// ───────── drawing the content through the placed transform ─────────

/** Homography mapping the unit square (0,0) (1,0) (1,1) (0,1) onto the quad (x0,y0 … x3,y3); 3×3 row-major. */
export function squareToQuad(q: number[]): number[] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new Error("singular placed transform");
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export interface ProjectedPixels {
  rgba: Uint8Array;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The content (straight RGBA, cw × ch) drawn onto the page through the placed quad — the layer pixels Photoshop keeps
 * for a smart object. Bounds = the quad's box on whole pixels. Each page pixel is the content's colour at its centre
 * mapped back through the inverse perspective (bilinear on premultiplied colour), averaged over a few points per
 * pixel when the content is shrunk. An unscaled, unrotated quad on whole pixels is a plain copy.
 */
export function projectPlaced(src: Uint8Array, cw: number, ch: number, quad: number[]): ProjectedPixels {
  const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
  const eps = 1e-6;
  const left = Math.floor(Math.min(...xs) + eps), top = Math.floor(Math.min(...ys) + eps);
  const right = Math.ceil(Math.max(...xs) - eps), bottom = Math.ceil(Math.max(...ys) - eps);
  const width = Math.max(0, right - left) || 0, height = Math.max(0, bottom - top) || 0;
  // (checked before anything is allocated: corners come from the file — a hostile or broken one is huge or not finite)
  if (width * height > 200_000_000 || cw * ch > 200_000_000 || src.length < cw * ch * 4) throw new Error(t("engine.psdsmart.tooBig"));
  if (!width || !height || cw <= 0 || ch <= 0) return { rgba: new Uint8Array(0), left: Number.isFinite(left) ? left : 0, top: Number.isFinite(top) ? top : 0, width: 0, height: 0 };
  const out = new Uint8Array(width * height * 4);
  // plain copy: the quad is the content rectangle at whole pixels
  const ident = Math.abs(quad[0] - left) < eps && Math.abs(quad[1] - top) < eps && Math.abs(quad[2] - (left + cw)) < eps && Math.abs(quad[3] - top) < eps && Math.abs(quad[4] - (left + cw)) < eps && Math.abs(quad[5] - (top + ch)) < eps && Math.abs(quad[6] - left) < eps && Math.abs(quad[7] - (top + ch)) < eps;
  if (ident && width === cw && height === ch) {
    out.set(src.subarray(0, cw * ch * 4));
    return { rgba: out, left, top, width, height };
  }
  const H = squareToQuad(quad);
  const inv = invert3(H);
  // how many content pixels one page pixel covers (shrinking: a few samples per pixel)
  const sideX = Math.max(Math.hypot(quad[2] - quad[0], quad[3] - quad[1]), Math.hypot(quad[4] - quad[6], quad[5] - quad[7]));
  const sideY = Math.max(Math.hypot(quad[6] - quad[0], quad[7] - quad[1]), Math.hypot(quad[4] - quad[2], quad[5] - quad[3]));
  const ss = Math.max(1, Math.min(4, Math.ceil(Math.max(cw / Math.max(1, sideX), ch / Math.max(1, sideY)))));
  const sample = (u: number, v: number, acc: number[]) => {
    // content pixel centres at (i + 0.5): bilinear between the four around (u·cw − 0.5, v·ch − 0.5)
    const fx = u * cw - 0.5, fy = v * ch - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    for (let k = 0; k < 4; k++) {
      const x = x0 + (k & 1), y = y0 + (k >> 1);
      const wgt = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
      if (!wgt || x < 0 || y < 0 || x >= cw || y >= ch) continue;
      const o = (y * cw + x) * 4;
      const a = src[o + 3] * wgt;
      acc[0] += src[o] * a;
      acc[1] += src[o + 1] * a;
      acc[2] += src[o + 2] * a;
      acc[3] += a;
    }
  };
  const acc = [0, 0, 0, 0];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const px = left + x + (sx + 0.5) / ss, py = top + y + (sy + 0.5) / ss;
          const w = inv[6] * px + inv[7] * py + inv[8];
          const u = (inv[0] * px + inv[1] * py + inv[2]) / w, v = (inv[3] * px + inv[4] * py + inv[5]) / w;
          if (u < -0.5 / cw || v < -0.5 / ch || u > 1 + 0.5 / cw || v > 1 + 0.5 / ch) continue;
          // inside the quad only (no colour bleeding past its edges)
          if (u < 0 || v < 0 || u > 1 || v > 1) continue;
          sample(u, v, acc);
        }
      const o = (y * width + x) * 4;
      const n = ss * ss;
      if (acc[3] <= 0) continue;
      out[o] = Math.round(acc[0] / acc[3]);
      out[o + 1] = Math.round(acc[1] / acc[3]);
      out[o + 2] = Math.round(acc[2] / acc[3]);
      out[o + 3] = Math.round(acc[3] / n);
    }
  return { rgba: out, left, top, width, height };
}

/** Pixels cut to their non-transparent box (Photoshop keeps a layer's bounds tight); an empty one stays 0 × 0. */
export function trimTransparent(p: ProjectedPixels): ProjectedPixels {
  let x0 = p.width, y0 = p.height, x1 = -1, y1 = -1;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++)
      if (p.rgba[(y * p.width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { rgba: new Uint8Array(0), left: p.left, top: p.top, width: 0, height: 0 };
  if (x0 === 0 && y0 === 0 && x1 === p.width - 1 && y1 === p.height - 1) return p;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(p.rgba.subarray(((y + y0) * p.width + x0) * 4, ((y + y0) * p.width + x0 + w) * 4), y * w * 4);
  return { rgba: out, left: p.left + x0, top: p.top + y0, width: w, height: h };
}

// ───────── writing a new embedded file back ─────────

const u64 = (v: number) => {
  const o = new Uint8Array(8);
  const dv = new DataView(o.buffer);
  dv.setUint32(0, Math.floor(v / 2 ** 32));
  dv.setUint32(4, v % 2 ** 32);
  return o;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** New content for an entry; `name` / `fileType` when its kind changed (a JPEG put back as PNG). */
export interface LinkedData {
  data: Uint8Array;
  name?: string;
  fileType?: string;
}

function uniString(s: string): Uint8Array {
  const o = new Uint8Array(4 + s.length * 2);
  const dv = new DataView(o.buffer);
  dv.setUint32(0, s.length);
  for (let i = 0; i < s.length; i++) dv.setUint16(4 + i * 2, s.charCodeAt(i));
  return o;
}

/** One entry with its embedded bytes replaced (lengths fixed, everything else as it was, padded to 4). */
export function entryWithData(b: Uint8Array, f: PsdLinkedFile, nd: LinkedData): Uint8Array {
  if (f.type !== "liFD" || !f.data || f.lengthAt < 0 || f.nameAt < 0) throw new Error(t("engine.psdsmart.entryFixed"));
  const s = f.start + 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const e = s + dv.getUint32(f.start) * 2 ** 32 + dv.getUint32(f.start + 4);
  // the stored name's count includes its terminating null (Photoshop's own entries): without it Photoshop drops the
  // last letter ("x.png" → "x.pn", seen in QA reference files) — kept the way the original entry had it
  const nl = dv.getUint32(f.nameAt);
  const nulled = nl > 0 && dv.getUint16(f.nameAt + 4 + (nl - 1) * 2) === 0;
  const head = nd.name !== undefined || nd.fileType !== undefined
    ? concat([b.subarray(s, f.nameAt), nd.name !== undefined ? uniString(nulled || nl === 0 ? nd.name.replace(/\0+$/, "") + "\0" : nd.name) : b.subarray(f.nameAt, f.lengthAt - 8), nd.fileType !== undefined ? Uint8Array.from((nd.fileType + "    ").slice(0, 4), (c) => c.charCodeAt(0) & 255) : b.subarray(f.lengthAt - 8, f.lengthAt - 4), b.subarray(f.lengthAt - 4, f.lengthAt)])
    : b.subarray(s, f.lengthAt);
  const body = concat([head, u64(nd.data.length), b.subarray(f.lengthAt + 8, f.data.start), nd.data, b.subarray(f.data.end, e)]);
  const pad = (4 - ((8 + body.length) % 4)) % 4;
  return concat([u64(body.length), body, new Uint8Array(pad)]);
}

/**
 * A linked-file block rebuilt: entries whose id is in `replace` get those bytes, entries `keep` rejects are left out
 * (an orphan nobody references), the rest copied byte for byte. null when the block cannot be followed.
 */
export function rebuildLinkedBlock(b: Uint8Array, blk: PsdBlock, psb: boolean, replace: Map<string, LinkedData>, keep: (id: string) => boolean = () => true): { bytes: Uint8Array; replaced: number; dropped: number } | null {
  const entries = linkedFilesOf(b, blk);
  if (!entries) return null;
  const parts: Uint8Array[] = [];
  let replaced = 0, dropped = 0;
  for (const f of entries) {
    if (!keep(f.id)) {
      dropped++;
      continue;
    }
    const nb = replace.get(f.id);
    if (nb && f.type === "liFD" && f.data) {
      parts.push(entryWithData(b, f, nb));
      replaced++;
    } else parts.push(b.subarray(f.start, f.end));
  }
  const body = concat(parts);
  const long = blk.long || (psb && LONG_KEYS.has(blk.key));
  const head = new Uint8Array(8 + (long ? 8 : 4));
  for (let i = 0; i < 4; i++) {
    head[i] = blk.sig.charCodeAt(i);
    head[4 + i] = blk.key.charCodeAt(i);
  }
  head.set(long ? u64(body.length) : [(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255], 8);
  return { bytes: concat([head, body]), replaced, dropped };
}

/**
 * The placed-layer block's content size ('Sz  ' Wdth / Hght) set to the new content's, in place (same length).
 * Null when the block has no size to set.
 */
export function placedWithSize(data: Uint8Array, w: number, h: number): Uint8Array | null {
  const d = data.slice();
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const find = (s: string, from: number) => {
    outer: for (let i = from; i + s.length <= d.length; i++) {
      for (let k = 0; k < s.length; k++) if (d[i + k] !== s.charCodeAt(k)) continue outer;
      return i;
    }
    return -1;
  };
  const sz = find("Sz  Objc", 0);
  if (sz < 0) return null;
  const wi = find("Wdthdoub", sz), hi = find("Hghtdoub", sz);
  if (wi < 0 || hi < 0 || wi + 16 > d.length || hi + 16 > d.length) return null;
  dv.setFloat64(wi + 8, w);
  dv.setFloat64(hi + 8, h);
  return d;
}

/**
 * The placed-layer block's corners set to `quad` (TL, TR, BR, BL), in place: SoLd / SoLE 'Trnf' and
 * 'nonAffineTransform' (eight doubles each), PlLd's header transform. Null when the layout is not the one read.
 */
export function placedWithCorners(data: Uint8Array, key: string, quad: number[]): Uint8Array | null {
  if (quad.length !== 8 || !quad.every(Number.isFinite)) return null;
  const d = data.slice();
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const at = (o: number, s: string) => o >= 0 && o + s.length <= d.length && [...s].every((c, i) => d[o + i] === c.charCodeAt(0));
  if (key === "PlLd" || key === "plLd") {
    if (!at(0, "plcL") || d.length < 9) return null;
    const p = 9 + d[8] + 16;
    if (p + 64 > d.length) return null;
    quad.forEach((v, i) => dv.setFloat64(p + i * 8, v));
    return d;
  }
  if (!at(0, "soLD")) return null;
  let set = 0;
  for (const [name, pre] of [["Trnf", [0, 0, 0, 0]], ["nonAffineTransform", [0, 0, 0, 18]]] as const) {
    for (let o = 4; o + name.length <= d.length; o++) {
      if (!at(o, name) || !pre.every((v, i) => d[o - 4 + i] === v)) continue;
      let p = o + name.length;
      if (!at(p, "VlLs") || p + 8 > d.length || dv.getUint32(p + 4) !== 8) continue;
      p += 8;
      for (let i = 0; i < 8; i++, p += 12) {
        if (!at(p, "doub") || p + 12 > d.length) return null;
        dv.setFloat64(p + 4, quad[i]);
      }
      set++;
    }
  }
  return set ? d : null;
}

/**
 * Corners for new content of w × h in place of content of cw × ch: the same scale and perspective, centred where the
 * old content's centre was (Photoshop keeps a smart object's centre when its content's canvas changes).
 */
export function quadForSize(quad: number[], cw: number, ch: number, w: number, h: number): number[] {
  if (cw === w && ch === h) return quad.slice();
  const H = squareToQuad(quad);
  const map = (x: number, y: number) => {
    const u = x / cw, v = y / ch;
    const k = H[6] * u + H[7] * v + H[8];
    return [(H[0] * u + H[1] * v + H[2]) / k, (H[3] * u + H[4] * v + H[5]) / k];
  };
  const x0 = (cw - w) / 2, y0 = (ch - h) / 2;
  // rounding noise off whole pixels (an unrotated corner stays exact: the plain-copy drawing applies)
  const snap = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) + 0 : v);
  return [...map(x0, y0), ...map(x0 + w, y0), ...map(x0 + w, y0 + h), ...map(x0, y0 + h)].map(snap);
}

/**
 * Pixel size of embedded content from its header (PSD / PSB, PNG, JPEG frame), or null. The placed corners belong to
 * this size — what an edited content's new canvas is measured against (quadForSize). Reads only the bytes given.
 */
export function contentDims(b: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : null);
  if (b.length >= 26 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return ok(dv.getUint32(18), dv.getUint32(14));
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ok(dv.getUint32(16), dv.getUint32(20));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // markers up to the first frame header (SOF0…SOF15 but DHT C4, JPG C8, DAC CC)
    let o = 2;
    for (let guard = 0; o + 4 <= b.length && guard < 10_000; guard++) {
      if (b[o] !== 0xff) return null;
      const m = b[o + 1];
      if (m === 0xff) {
        o++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = dv.getUint16(o + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return o + 9 <= b.length ? ok(dv.getUint16(o + 7), dv.getUint16(o + 5)) : null;
      if (m === 0xda || len < 2) return null;
      o += 2 + len;
    }
  }
  return null;
}

/** Which kinds of embedded content open as a document here (and can be written back). */
export function smartContentKind(f: Pick<PsdLinkedFile, "fileType" | "name">, bytes?: Uint8Array): "psd" | "psb" | "png" | "jpg" | null {
  const t = f.fileType.trim().toUpperCase();
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (bytes && bytes.length > 8) {
    if (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53) return bytes[5] === 2 ? "psb" : "psd";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
    return null;
  }
  if (t === "8BPB" || ext === "psb") return "psb";
  if (t === "8BPS" || ext === "psd") return "psd";
  if (t === "PNG" || ext === "png") return "png";
  if (t === "JPEG" || ext === "jpg" || ext === "jpeg") return "jpg";
  return null;
}
