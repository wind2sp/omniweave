// PDF Surgeon — /ForeignObject in Illustrator's native data: art Illustrator imported from a PDF and keeps as that
// PDF (a one-page document in /Data, ASCII85 on %-lines, sometimes zlib-compressed). Its page is drawn into the
// object's /Bounds (art space); aiNativePdf.ts embeds the page as a form XObject.

import { a85decode, inflateCapped } from "./aiPrivate";
import { XP_NORMAL, type ForeignNode } from "./aiNativeScene";

const MAX_FOREIGN = 64_000_000;

const startsPdf = (b: Uint8Array) => b.length > 8 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

/** `src`: the dictionary object's text from after "/ForeignObject :" to its closing ";". */
export function foreignObject(src: string): ForeignNode | null {
  // the bounds: four numbers right before "/Bounds ," (looked for near the key only — the data can be megabytes)
  const bi = src.indexOf("/Bounds");
  const bm = bi < 0 ? null : /(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+\/Bounds\s*,/.exec(src.slice(Math.max(0, bi - 160), bi + 16));
  const di = src.indexOf("/Data ,");
  if (!bm || di < 0) return null;
  const [x0, y0, x1, y1] = bm.slice(1, 5).map(Number);
  if (!(x1 > x0 && y1 > y0) || ![x0, y0, x1, y1].every(Number.isFinite)) return null;
  // the data: the %-lines after "/Data ,", up to the ASCII85 end mark
  const lines: string[] = [];
  let total = 0;
  for (const line of src.slice(di + 7).split(/\r\n|\r|\n/)) {
    if (!line.startsWith("%")) {
      if (lines.length) break;
      continue;
    }
    lines.push(line.slice(1));
    total += line.length;
    if (total > MAX_FOREIGN * 1.3 || line.includes("~>")) break;
  }
  let bytes: Uint8Array = a85decode(lines.join(""));
  if (!startsPdf(bytes)) {
    try {
      bytes = inflateCapped(bytes, MAX_FOREIGN);
    } catch {
      return null;
    }
  }
  if (!startsPdf(bytes) || bytes.length > MAX_FOREIGN) return null;
  return { t: "foreign", pdf: bytes, box: { x0, y0, x1, y1 }, xp: { ...XP_NORMAL } };
}
