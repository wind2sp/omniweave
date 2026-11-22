// JPEG segments and the photo information (EXIF, APP1) of a picture saved again as JPEG: read it from the original
// file, tidy it (orientation 1 — the pixels are already drawn upright; no thumbnail — it shows the old picture; the
// pixel size of the new picture; the location (GPS) zeroed out when asked) and put it into the newly encoded JPEG.
// Plain bytes, no DOM: Node-testable. The TIFF inside APP1 is edited in place (offsets stay valid); what is taken
// out is overwritten with zeros, so it is gone from the file, not just unlinked.

const EXIF_HEAD = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"

export interface JpegSegment {
  marker: number;
  /** offset of the 0xFF of the marker */
  start: number;
  /** offset just after the segment's data */
  end: number;
}

/** The marker segments before the image data (SOS), in order. Empty when the bytes are not a JPEG. */
export function jpegSegments(b: Uint8Array): JpegSegment[] {
  const out: JpegSegment[] = [];
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return out;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const m = b[i + 1];
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push({ marker: m, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) break;
    out.push({ marker: m, start: i, end: i + 2 + len });
    if (m === 0xda) break; // the scan follows
    i += 2 + len;
  }
  return out;
}

export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

const isExifSeg = (b: Uint8Array, s: JpegSegment) => s.marker === 0xe1 && s.end - s.start >= 4 + 6 + 8 && EXIF_HEAD.every((c, k) => b[s.start + 4 + k] === c);

/** The EXIF block of a JPEG ("Exif\0\0" + TIFF), a copy; null when it has none. */
export function jpegExif(b: Uint8Array): Uint8Array | null {
  const s = jpegSegments(b).find((x) => isExifSeg(b, x));
  return s ? b.slice(s.start + 4, s.end) : null;
}

/** The pixel size in the frame header (SOF0…SOF15, not DHT / JPG / DAC), or null. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  for (const s of jpegSegments(b)) {
    const m = s.marker;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && s.end - s.start >= 9) return { height: (b[s.start + 5] << 8) | b[s.start + 6], width: (b[s.start + 7] << 8) | b[s.start + 8] };
  }
  return null;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

class Tiff {
  readonly le: boolean;
  constructor(readonly b: Uint8Array, readonly t: number) {
    if (b.length < t + 8) throw new Error("short");
    const o = String.fromCharCode(b[t], b[t + 1]);
    if (o !== "II" && o !== "MM") throw new Error("order");
    this.le = o === "II";
  }
  private at(o: number, n: number) {
    if (o < this.t || o + n > this.b.length) throw new Error("range");
    return this.t + (o - this.t);
  }
  u16(o: number) {
    this.at(o, 2);
    return this.le ? this.b[o] | (this.b[o + 1] << 8) : (this.b[o] << 8) | this.b[o + 1];
  }
  u32(o: number) {
    this.at(o, 4);
    const b = this.b;
    return this.le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24 : b[o] * 2 ** 24 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  }
  w16(o: number, v: number) {
    this.at(o, 2);
    if (this.le) (this.b[o] = v & 0xff), (this.b[o + 1] = v >> 8);
    else (this.b[o] = v >> 8), (this.b[o + 1] = v & 0xff);
  }
  w32(o: number, v: number) {
    this.at(o, 4);
    const x = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    for (let k = 0; k < 4; k++) this.b[o + k] = this.le ? x[k] : x[3 - k];
  }
  zero(o: number, n: number) {
    if (n <= 0) return;
    this.at(o, n);
    this.b.fill(0, o, o + n);
  }
  /** absolute offset of an IFD that the TIFF header / a pointer names (relative to the TIFF start) */
  abs(rel: number) {
    return this.t + rel;
  }
  /** entries of the IFD at absolute offset `o`: [entry offset, tag, type, count] */
  entries(o: number): { e: number; tag: number; type: number; count: number }[] {
    const n = this.u16(o);
    this.at(o, 2 + n * 12 + 4);
    return Array.from({ length: n }, (_, k) => {
      const e = o + 2 + k * 12;
      return { e, tag: this.u16(e), type: this.u16(e + 2), count: this.u32(e + 4) };
    });
  }
  /** the bytes of an entry's value that live outside the entry (>4 bytes): [absolute offset, length] or null */
  outside(x: { e: number; type: number; count: number }): [number, number] | null {
    const n = (TYPE_SIZE[x.type] ?? 1) * x.count;
    return n > 4 ? [this.abs(this.u32(x.e + 8)), n] : null;
  }
  /** overwrite an IFD (no sub-IFDs inside, as GPS and the thumbnail's IFD1) and every value it points at */
  wipe(o: number, extra?: (x: { e: number; tag: number; type: number; count: number }) => void) {
    const list = this.entries(o);
    for (const x of list) {
      extra?.(x);
      const r = this.outside(x);
      if (r) this.zero(r[0], Math.min(r[1], this.b.length - r[0]));
    }
    this.zero(o, 2 + list.length * 12 + 4);
  }
  /** take one entry out of an IFD: the ones after it move up, the next-IFD pointer follows, the freed bytes are zeroed */
  remove(o: number, e: number) {
    const n = this.u16(o);
    const end = o + 2 + n * 12 + 4;
    this.b.copyWithin(e, e + 12, end);
    this.zero(end - 12, 12);
    this.w16(o, n - 1);
  }
}

export interface ExifCleanOptions {
  /** zero out the location (GPS IFD) */
  dropGps: boolean;
  /** the new picture's pixel size, written into the Exif IFD's PixelX/YDimension when present */
  width?: number;
  height?: number;
}

/** Does this EXIF block carry a location (a GPS IFD pointer)? */
export function exifHasGps(exif: Uint8Array): boolean {
  try {
    const tf = new Tiff(exif, 6);
    return tf.entries(tf.abs(tf.u32(tf.t + 4))).some((x) => x.tag === 0x8825);
  } catch {
    return false;
  }
}

/** The orientation (1…8) in an EXIF block; 1 when it says none. */
export function exifOrientation(exif: Uint8Array): number {
  try {
    const tf = new Tiff(exif, 6);
    const x = tf.entries(tf.abs(tf.u32(tf.t + 4))).find((x) => x.tag === 0x0112);
    return x ? tf.u16(x.e + 8) : 1;
  } catch {
    return 1;
  }
}

/**
 * The EXIF block for a picture drawn again (a copy): orientation 1 (the pixels are upright already — keeping 6 would
 * turn it a second time), no thumbnail (IFD1 — it shows the picture before the edit), PixelX/YDimension of the new
 * size, and with `dropGps` no location. Null when the block cannot be read safely (then nothing is kept).
 */
export function cleanExif(exif: Uint8Array, opts: ExifCleanOptions): Uint8Array | null {
  if (exif.length < 14 || !EXIF_HEAD.every((c, k) => exif[k] === c)) return null;
  const b = exif.slice();
  try {
    const tf = new Tiff(b, 6);
    if (tf.u16(tf.t + 2) !== 42) return null;
    const ifd0 = tf.abs(tf.u32(tf.t + 4));
    let list = tf.entries(ifd0);
    // the thumbnail (IFD1) and its JPEG
    const nextAt = ifd0 + 2 + list.length * 12;
    const ifd1 = tf.u32(nextAt);
    if (ifd1) {
      let thumbAt = 0, thumbLen = 0;
      tf.wipe(tf.abs(ifd1), (x) => {
        if (x.tag === 0x0201) thumbAt = tf.abs(tf.u32(x.e + 8));
        if (x.tag === 0x0202) thumbLen = tf.u32(x.e + 8);
      });
      if (thumbAt && thumbLen) tf.zero(thumbAt, Math.min(thumbLen, b.length - thumbAt));
      tf.w32(nextAt, 0);
    }
    for (const x of list) {
      if (x.tag === 0x0112 && x.type === 3) tf.w16(x.e + 8, 1);
      if (x.tag === 0x8769 && opts.width && opts.height) {
        for (const y of tf.entries(tf.abs(tf.u32(x.e + 8)))) {
          const v = y.tag === 0xa002 ? opts.width : y.tag === 0xa003 ? opts.height : 0;
          if (!v || y.count !== 1) continue;
          if (y.type === 3 && v <= 0xffff) tf.w16(y.e + 8, v), tf.w16(y.e + 10, 0);
          else if (y.type === 4) tf.w32(y.e + 8, v);
        }
      }
    }
    if (opts.dropGps) {
      const gps = list.find((x) => x.tag === 0x8825);
      if (gps) {
        tf.wipe(tf.abs(tf.u32(gps.e + 8)));
        tf.remove(ifd0, gps.e);
        list = tf.entries(ifd0);
      }
    }
    return b;
  } catch {
    return null;
  }
}

/**
 * A JPEG with this EXIF block in place of any it had (APP1, after SOI and the JFIF APP0 — as Photoshop writes it);
 * `exif` null takes the EXIF out. The image data is not touched. A block too long for one segment is left out.
 */
export function withExif(jpeg: Uint8Array, exif: Uint8Array | null): Uint8Array {
  const segs = jpegSegments(jpeg);
  if (!segs.length) return jpeg;
  const drop = segs.filter((s) => isExifSeg(jpeg, s));
  const put = exif && exif.length + 2 <= 0xffff ? exif : null;
  if (!drop.length && !put) return jpeg;
  const app0 = segs.find((s) => s.marker === 0xe0 && s.start === 2);
  const insertAt = app0 ? app0.end : 2;
  const parts: Uint8Array[] = [];
  let i = 0;
  const pushUntil = (to: number) => {
    let at = i;
    for (const s of drop) {
      if (s.start < at || s.start >= to) continue;
      parts.push(jpeg.subarray(at, s.start));
      at = s.end;
    }
    parts.push(jpeg.subarray(at, to));
    i = to;
  };
  pushUntil(insertAt);
  if (put) {
    const n = put.length + 2;
    parts.push(new Uint8Array([0xff, 0xe1, n >> 8, n & 0xff]), put);
  }
  pushUntil(jpeg.length);
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

/** What to do with the original's photo information in a JPEG that is written anew. */
export type ExifMode = "keep" | "noGps" | "none";

/** The newly encoded JPEG with the original's EXIF, tidied for `mode` (see cleanExif). */
export function carryExif(encoded: Uint8Array, original: Uint8Array | null, mode: ExifMode): Uint8Array {
  const exif = mode === "none" || !original ? null : jpegExif(original);
  if (!exif) return withExif(encoded, null);
  const size = jpegSize(encoded);
  return withExif(encoded, cleanExif(exif, { dropGps: mode === "noGps", width: size?.width, height: size?.height }));
}
