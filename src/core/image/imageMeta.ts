// Metadata carried from an original picture file to a re-encoded one (the upscale result, ui/upscaleActions.ts), so
// a picture saved in its own format keeps what it said about itself. Pure byte work, no DOM.
//
//  - JPEG: Exif (APP1, with Orientation set to 1 — the pixels are already turned — and the pixel size updated), XMP
//    (APP1, its tiff:Orientation set to 1 as well), an RGB ICC profile (APP2 ICC_PROFILE), Photoshop / IPTC (APP13)
//    and comments (COM) go in after the new file's JFIF. Other APP2 segments (MPF: offsets into the old file's extra
//    pictures, FlashPix) are not carried — they would point at bytes that are not there.
//  - PNG: colour (iCCP · sRGB · gAMA · cHRM), text (tEXt · zTXt · iTXt; XMP orientation set to 1), eXIf (orientation
//    set to 1, pixel size updated) and the physical pixel size (pHYs, scaled so the print size stays the same) go in
//    before the first IDAT.
// The pixels must be in the original's colour space (decoded without colour conversion) for the profile to stay right
// — `keepsProfile` says when that holds. A grey or CMYK profile cannot describe the RGB pixels written back, so then
// the picture is decoded to sRGB and no colour information is carried.

import { unzlibSync } from "fflate";
import { pngChunk } from "./png";

const SOI = 0xd8, SOS = 0xda, EOI = 0xd9;

interface Segment {
  marker: number;
  start: number;
  end: number;
}

/** Marker segments before the scan (SOS) of a JPEG; null when the bytes are not a JPEG. */
function jpegSegments(b: Uint8Array): Segment[] | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== SOI) return null;
  const out: Segment[] = [];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === SOS || m === EOI) {
      out.push({ marker: m, start: p, end: p });
      break;
    }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > b.length) return null;
    out.push({ marker: m, start: p, end: p + 2 + len });
    p += 2 + len;
  }
  return out;
}

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
const isIcc = (seg: Uint8Array) => ascii(seg, 4, "ICC_PROFILE\0");

/** Colour space signature of an ICC profile header ("RGB ", "GRAY", "CMYK" …), "" when too short. */
const iccSpace = (profile: Uint8Array) => (profile.length >= 20 ? String.fromCharCode(...profile.subarray(16, 20)) : "");

/**
 * Exif TIFF block copy (`t`: where the TIFF header starts) with Orientation → 1 and PixelX/YDimension → the new size
 * (tags left alone where absent).
 */
function fixExif(seg: Uint8Array, t: number, width: number, height: number): Uint8Array {
  const out = seg.slice();
  if (out.length < t + 8) return out;
  const le = out[t] === 0x49;
  const dv = new DataView(out.buffer, out.byteOffset + t, out.length - t);
  const u16 = (o: number) => dv.getUint16(o, le), u32 = (o: number) => dv.getUint32(o, le);
  const ifd = (o: number, f: (tag: number, type: number, at: number) => void) => {
    if (o + 2 > dv.byteLength) return;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > dv.byteLength) return;
      f(u16(e), u16(e + 2), e + 8);
    }
  };
  const set = (type: number, at: number, v: number) => (type === 3 ? dv.setUint16(at, v, le) : type === 4 ? dv.setUint32(at, v, le) : undefined);
  try {
    let exifIfd = 0;
    ifd(u32(4), (tag, type, at) => {
      if (tag === 0x0112) set(type, at, 1);
      if (tag === 0x8769) exifIfd = u32(at);
    });
    if (exifIfd)
      ifd(exifIfd, (tag, type, at) => {
        if (tag === 0xa002) set(type, at, width);
        if (tag === 0xa003) set(type, at, height);
      });
  } catch {
    /* a damaged Exif block is copied as it is */
  }
  return out;
}

/**
 * XMP packet bytes with tiff:Orientation set to 1 (attribute or element form). The value is one digit either way, so
 * the length — and the segment / chunk length — stays the same.
 */
function fixXmp(b: Uint8Array): Uint8Array {
  // a single-byte decoding: string index = byte index (only the digit's byte is written, the rest stays as it was)
  const s = new TextDecoder("windows-1252").decode(b);
  let out: Uint8Array | null = null;
  for (const re of [/(tiff:Orientation\s*=\s*["'])[2-8]["']/g, /(<tiff:Orientation>\s*)[2-8]\s*<\/tiff:Orientation>/g])
    for (let m = re.exec(s); m; m = re.exec(s)) (out ??= b.slice())[m.index + m[1].length] = 0x31;
  return out ?? b;
}

const XMP_APP1 = "http://ns.adobe.com/xap/1.0/\0";

/** Number of colour components of a JPEG's frame (SOF), 0 when none was found. */
function jpegComponents(b: Uint8Array, segs: Segment[]): number {
  for (const s of segs) if (s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc && s.end - s.start >= 10) return b[s.start + 9];
  return 0;
}

/** The JPEG's ICC profile (its APP2 chunks joined; the header is enough here), or null. */
function jpegIcc(b: Uint8Array, segs: Segment[]): Uint8Array | null {
  const parts = segs.filter((s) => s.marker === 0xe2 && isIcc(b.subarray(s.start, s.end))).map((s) => b.subarray(s.start + 18, s.end));
  return parts.length ? concat(parts) : null;
}

/**
 * Whether the picture's colours can be kept as stored: decoded without colour conversion and written back with its
 * own profile. False for formats whose metadata is not carried (WebP and the rest — decode them to sRGB), CMYK JPEGs
 * and grey / CMYK profiles (the result is RGB).
 */
export function keepsProfile(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") {
    const segs = jpegSegments(bytes);
    if (!segs) return false;
    const icc = jpegIcc(bytes, segs);
    return jpegComponents(bytes, segs) !== 4 && (!icc || iccSpace(icc) === "RGB ");
  }
  if (mime === "image/png") {
    const cs = pngChunks(bytes);
    if (!cs) return false;
    const c = cs.find((x) => x.type === "iCCP");
    return !c || pngIccSpace(bytes, c) === "RGB ";
  }
  return false;
}

/**
 * The original JPEG's metadata segments put into a freshly encoded JPEG (which keeps its own JFIF / quantisation /
 * Huffman tables). Returns `fresh` unchanged when either is not a JPEG.
 */
export function keepJpegMeta(orig: Uint8Array, fresh: Uint8Array, width: number, height: number): Uint8Array {
  const so = jpegSegments(orig), sf = jpegSegments(fresh);
  if (!so || !sf) return fresh;
  const icc = jpegIcc(orig, so);
  const keepIcc = !!icc && iccSpace(icc) === "RGB " && jpegComponents(orig, so) !== 4;
  const keep: Uint8Array[] = [];
  for (const s of so) {
    const b = orig.subarray(s.start, s.end);
    if (s.marker === 0xe1 && ascii(b, 4, "Exif\0\0")) keep.push(fixExif(b, 10, width, height));
    else if (s.marker === 0xe1) keep.push(ascii(b, 4, XMP_APP1) ? fixXmp(b) : b);
    else if (s.marker === 0xe2) {
      if (keepIcc && isIcc(b)) keep.push(b);
    } else if (s.marker === 0xed || s.marker === 0xfe) keep.push(b);
  }
  if (!keep.length) return fresh;
  // the new file: SOI, its APP0 (JFIF) if any, the kept segments, then everything else except its own APP1/APP2
  const app0 = sf.filter((s) => s.marker === 0xe0);
  const rest = sf.filter((s) => s.marker !== 0xe0 && s.marker !== 0xe1 && s.marker !== 0xe2);
  const scanAt = rest.length ? rest[rest.length - 1].start : 2;
  const parts: Uint8Array[] = [fresh.subarray(0, 2), ...app0.map((s) => fresh.subarray(s.start, s.end)), ...keep, ...rest.filter((s) => s.marker !== SOS).map((s) => fresh.subarray(s.start, s.end)), fresh.subarray(scanAt)];
  return concat(parts);
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const COLOUR = new Set(["iCCP", "sRGB", "gAMA", "cHRM"]);
const CARRY = new Set([...COLOUR, "tEXt", "zTXt", "iTXt", "eXIf", "pHYs"]);

interface Chunk {
  type: string;
  start: number;
  end: number;
}

function pngChunks(b: Uint8Array): Chunk[] | null {
  if (b.length < 8 || PNG_SIG.some((v, i) => b[i] !== v)) return null;
  const out: Chunk[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (p + 12 + len > b.length) return null;
    out.push({ type, start: p, end: p + 12 + len });
    p += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}

/** Colour space of a PNG iCCP chunk's profile ("" when it cannot be read). */
function pngIccSpace(b: Uint8Array, c: Chunk): string {
  const data = b.subarray(c.start + 8, c.end - 4), z = data.indexOf(0);
  if (z < 0 || z + 2 > data.length) return "";
  try {
    return iccSpace(unzlibSync(data.subarray(z + 2)));
  } catch {
    return "";
  }
}

/**
 * The original PNG's colour, text, Exif and pixel-size chunks put into a freshly encoded PNG. `sx` / `sy`: the
 * enlargement, so pHYs (pixels per metre) keeps the print size. Returns `fresh` when either is not a PNG.
 */
export function keepPngMeta(orig: Uint8Array, fresh: Uint8Array, sx: number, sy: number): Uint8Array {
  const co = pngChunks(orig), cf = pngChunks(fresh);
  if (!co || !cf) return fresh;
  const ihdr = co.find((c) => c.type === "IHDR");
  const dv0 = new DataView(orig.buffer, orig.byteOffset, orig.byteLength);
  const W = ihdr ? Math.round(dv0.getUint32(ihdr.start + 8) * sx) : 0, H = ihdr ? Math.round(dv0.getUint32(ihdr.start + 12) * sy) : 0;
  // a grey profile cannot describe RGB pixels: then none of the colour chunks is carried (the pixels are sRGB)
  const iccp = co.find((c) => c.type === "iCCP");
  const colourOk = !iccp || pngIccSpace(orig, iccp) === "RGB ";
  const keep: Uint8Array[] = [];
  let colour = false;
  for (const c of co) {
    if (!CARRY.has(c.type)) continue;
    if (COLOUR.has(c.type) && !colourOk) continue;
    // ancillary chunks after IDAT (text may sit there) are carried as well, all before the new IDAT
    if (COLOUR.has(c.type)) colour = true;
    const data = orig.subarray(c.start + 8, c.end - 4);
    if (c.type === "pHYs" && data.length === 9) {
      const d = data.slice(), dv = new DataView(d.buffer);
      dv.setUint32(0, Math.round(dv.getUint32(0) * sx));
      dv.setUint32(4, Math.round(dv.getUint32(4) * sy));
      keep.push(pngChunk("pHYs", d));
    } else if (c.type === "eXIf") keep.push(pngChunk("eXIf", fixExif(data, 0, W, H)));
    else if (c.type === "iTXt" && ascii(data, 0, "XML:com.adobe.xmp\0")) {
      const x = fixXmp(data);
      keep.push(x === data ? orig.subarray(c.start, c.end) : pngChunk("iTXt", x));
    } else keep.push(orig.subarray(c.start, c.end));
  }
  if (!keep.length) return fresh;
  const drop = (t: string) => CARRY.has(t) && (t === "pHYs" || t === "eXIf" || (colour && COLOUR.has(t)));
  const parts: Uint8Array[] = [fresh.subarray(0, 8)];
  let placed = false;
  for (const c of cf) {
    if (drop(c.type)) continue;
    if (!placed && (c.type === "IDAT" || c.type === "IEND")) {
      parts.push(...keep);
      placed = true;
    }
    parts.push(fresh.subarray(c.start, c.end));
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const q of parts) {
    out.set(q, p);
    p += q.length;
  }
  return out;
}
