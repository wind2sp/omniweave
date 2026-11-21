// Copies pdf.js CMaps and standard font data next to the app (public/pdfjs/), so PDFs whose CJK or
// base-14 fonts are not embedded still render correctly — offline, in the desktop app and on the web.
//
// The 169 CMaps go into ONE file, public/pdfjs/cmaps.pack (read by src/io/pdfCMaps.ts): the installer compresses
// every bundled file on its own, and one file lets the compressor share what the CMaps have in common
// (951 KB → 432 KB in the installer, docs/design/INSTALLER_SIZE.md). Pack layout (little endian):
//   "OCM1" | u32 count | count × (u8 nameLength | name (ASCII) | u32 length | bcmap bytes)
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {{ name: string, data: Uint8Array }[]} entries */
export function packCMaps(entries) {
  const enc = new TextEncoder();
  const parts = [];
  let size = 8;
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const n = enc.encode(e.name);
    if (n.length > 255) throw new Error("cmap name too long: " + e.name);
    parts.push([n, e.data]);
    size += 1 + n.length + 4 + e.data.length;
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x43, 0x4d, 0x31]); // OCM1
  dv.setUint32(4, parts.length, true);
  let p = 8;
  for (const [n, d] of parts) {
    out[p++] = n.length;
    out.set(n, p);
    p += n.length;
    dv.setUint32(p, d.length, true);
    p += 4;
    out.set(d, p);
    p += d.length;
  }
  return out;
}

/**
 * Standard font data the app can actually request: with system fonts on (the browser / WebView default) pdf.js fetches
 * data only for non-embedded Symbol and ZapfDingbats; Helvetica / Times / Courier use the system fonts. The worker
 * never builds Liberation URLs either, because our CMap factory turns its own fetching off. Proven by
 * tests/size/stdFonts.test.ts and qa/size/stdfonts-compare.html (docs/design/INSTALLER_SIZE.md §8).
 */
export const STANDARD_FONTS_KEPT = ["FoxitSymbol.pfb", "FoxitDingbats.pfb", "LICENSE_FOXIT"];

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const src = "node_modules/pdfjs-dist";
  const dst = "public/pdfjs";
  mkdirSync(dst, { recursive: true });
  if (existsSync(`${src}/standard_fonts`)) {
    rmSync(`${dst}/standard_fonts`, { recursive: true, force: true }); // drop files of earlier builds
    mkdirSync(`${dst}/standard_fonts`, { recursive: true });
    for (const f of STANDARD_FONTS_KEPT) copyFileSync(`${src}/standard_fonts/${f}`, `${dst}/standard_fonts/${f}`);
  }
  if (existsSync(`${src}/cmaps`)) {
    const files = readdirSync(`${src}/cmaps`).filter((f) => f.endsWith(".bcmap"));
    writeFileSync(`${dst}/cmaps.pack`, packCMaps(files.map((f) => ({ name: f.slice(0, -6), data: new Uint8Array(readFileSync(`${src}/cmaps/${f}`)) }))));
    copyFileSync(`${src}/cmaps/LICENSE`, `${dst}/LICENSE_CMAPS`);
    // the loose files of earlier builds would otherwise still be bundled
    rmSync(`${dst}/cmaps`, { recursive: true, force: true });
  }
}
