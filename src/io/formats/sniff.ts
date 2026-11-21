// Byte sniffing: image dimensions from headers (no decoding), and container signatures.
// Works in Node and the browser so importers can lay out pages without a canvas.

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export function startsWith(b: Uint8Array, sig: number[] | string, at = 0): boolean {
  const arr = typeof sig === "string" ? Array.from(sig, (c) => c.charCodeAt(0)) : sig;
  if (b.length < at + arr.length) return false;
  for (let i = 0; i < arr.length; i++) if (b[at + i] !== arr[i]) return false;
  return true;
}

export function isZip(b: Uint8Array) {
  return startsWith(b, [0x50, 0x4b, 0x03, 0x04]);
}
/** OLE2 / Compound File Binary (DOC, XLS, PPT, HWP 5.0). */
export function isCfb(b: Uint8Array) {
  return startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}
/** The PDF signature (%PDF-) as bytes, never as a string: this module is its own small chunk, and the desktop app's
 *  asset server guesses a file's type from its first bytes — the text near the top made it serve this script as
 *  application/pdf, the module failed to load and the app stayed on its start screen (vite.config.ts sniffGuard;
 *  a String.fromCharCode spelling is folded back into the text by the minifier). */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
export function isPdf(b: Uint8Array) {
  // the header may be preceded by junk within the first 1KB (PDF 1.7 §7.5.2 tolerance)
  const end = Math.min(1024, b.length) - PDF_MAGIC.length;
  for (let i = 0; i <= end; i++) if (startsWith(b, PDF_MAGIC, i)) return true;
  return false;
}

/**
 * CAD drawing by content: DWG starts with its version ("AC1015" …), DXF with the binary sentinel or a "0 / SECTION"
 * group (comments allowed before it). Lets a mislabelled .dxf / .dwg open as what it is.
 */
export function cadKind(b: Uint8Array): "dxf" | "dwg" | null {
  if (b.length > 0x80 && /^AC10\d\d$/.test(ascii(b, 0, 6))) return "dwg";
  if (startsWith(b, "AutoCAD Binary DXF\r\n\x1a\0")) return "dxf";
  const head = ascii(b, 0, Math.min(b.length, 2048)).replace(/^\xEF\xBB\xBF/, "");
  return /^\s*(?:999\s*\r?\n[^\n]*\r?\n\s*)*0\s*\r?\n\s*SECTION\s*\r?\n/.test(head) ? "dxf" : null;
}

/** ISO-BMFF brand ("ftyp" box): heic/heix/mif1 → HEIF, avif, mp4/isom/qt. */
export function isoBrand(b: Uint8Array): string | null {
  if (b.length < 12 || ascii(b, 4, 4) !== "ftyp") return null;
  return ascii(b, 8, 4);
}
export function isHeic(b: Uint8Array) {
  const brand = isoBrand(b);
  if (!brand) return false;
  if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return true;
  if (brand === "mif1" || brand === "msf1") {
    const box = ascii(b, 8, Math.min(64, u32be(b, 0) - 8));
    return /heic|heix/.test(box) && !/avif/.test(box);
  }
  return false;
}

export function imageMime(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, "GIF8")) return "image/gif";
  if (startsWith(b, "RIFF") && startsWith(b, "WEBP", 8)) return "image/webp";
  if (startsWith(b, "BM")) return "image/bmp";
  if (startsWith(b, [0, 0, 1, 0])) return "image/x-icon";
  if (startsWith(b, "II*\0") || startsWith(b, "MM\0*")) return "image/tiff";
  const brand = isoBrand(b);
  if (brand === "avif" || brand === "avis") return "image/avif";
  if (isHeic(b)) return "image/heic";
  const head = ascii(b, 0, Math.min(512, b.length));
  if (/<svg[\s>]/i.test(head) || (/^\s*<\?xml/.test(head) && /<svg/i.test(ascii(b, 0, Math.min(4096, b.length))))) return "image/svg+xml";
  return null;
}

/** Pixel size from the file header, or null when unknown. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  try {
    const mime = imageMime(b);
    switch (mime) {
      case "image/png":
        return { width: u32be(b, 16), height: u32be(b, 20) };
      case "image/gif":
        return { width: u16le(b, 6), height: u16le(b, 8) };
      case "image/bmp":
        return { width: Math.abs(u32le(b, 18) | 0), height: Math.abs(u32le(b, 22) | 0) };
      case "image/webp": {
        const chunk = ascii(b, 12, 4);
        if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        if (chunk === "VP8L") {
          const bits = u32le(b, 21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        return null;
      }
      case "image/jpeg": {
        let o = 2;
        while (o + 9 < b.length) {
          if (b[o] !== 0xff) {
            o++;
            continue;
          }
          const m = b[o + 1];
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
            o += m === 0xff ? 1 : 2;
            continue;
          }
          const len = u16be(b, o + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16be(b, o + 7), height: u16be(b, o + 5) };
          o += 2 + len;
        }
        return null;
      }
      case "image/x-icon": {
        const w = b[6] || 256, h = b[7] || 256;
        return { width: w, height: h };
      }
      case "image/svg+xml": {
        const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 8192)));
        const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? "";
        const num = (name: string) => {
          const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`).exec(tag);
          return m ? Number(m[1]) : NaN;
        };
        let w = num("width"), h = num("height");
        const vb = /viewBox\s*=\s*["']([^"']+)["']/.exec(tag);
        if ((!w || !h) && vb) {
          const [, , vw, vh] = vb[1].split(/[\s,]+/).map(Number);
          if (!w && !h) (w = vw), (h = vh);
          else if (!w) w = (h * vw) / vh;
          else h = (w * vh) / vw;
        }
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
    }
  } catch {
    /* truncated header */
  }
  return null;
}

/** Media kind from container signature. */
export function mediaKind(b: Uint8Array): { media: "video" | "audio"; mime: string } | null {
  const brand = isoBrand(b);
  if (brand) {
    if (/^(M4A |M4B |M4P )$/.test(brand)) return { media: "audio", mime: "audio/mp4" };
    if (brand === "qt  ") return { media: "video", mime: "video/quicktime" };
    if (!isHeic(b) && brand !== "avif" && brand !== "avis") return { media: "video", mime: "video/mp4" };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { media: "video", mime: "video/webm" };
  if (startsWith(b, "RIFF") && startsWith(b, "AVI ", 8)) return { media: "video", mime: "video/x-msvideo" };
  if (startsWith(b, "RIFF") && startsWith(b, "WAVE", 8)) return { media: "audio", mime: "audio/wav" };
  if (startsWith(b, "OggS")) return { media: "audio", mime: "audio/ogg" };
  if (startsWith(b, "fLaC")) return { media: "audio", mime: "audio/flac" };
  if (startsWith(b, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return { media: "audio", mime: "audio/mpeg" };
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { media: "audio", mime: "audio/aac" }; // ADTS
  return null;
}
