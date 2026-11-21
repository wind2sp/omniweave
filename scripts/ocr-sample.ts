// Dev-only: OCR a page image and save every output for review. Runs through vitest (vite resolves the app imports):
//   OCR_SAMPLE="<image.rgba>|<det.lwt>|<rec.lwt>|<out dir>|<name>" npx vitest run tests/ocr/sample-export.dev.test.ts
// Writes <name>.ocr.json, <name>.overlay.png (line boxes by confidence: green ≥ 0.9, amber ≥ 0.6, red below;
// tables blue, check boxes magenta), <name>.docx / .hwpx / .pdf (rebuilt) and <name>.searchable.pdf (image + invisible
// text layer), and prints the text pdf.js extracts from the searchable PDF.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseGraph } from "../src/core/image/infer/graph";
import { ocrPage, pageText } from "../src/core/image/ocr/pipeline";
import { reconstruct } from "../src/core/image/ocr/reconstruct";
import { encodePng } from "../src/core/image/png";
import { getBlob, makeAsset } from "../src/core/assets";
import { newDocument, newPage, type Page } from "../src/core/types";
import { exportDocx, exportHwpx } from "../src/io/office";
import { exportPdfVector } from "../src/io/pdfVector";
import type { Img } from "../src/core/image/pixels";

export async function ocrSample(src: string, detPath: string, recPath: string, out: string, name = "sample") {
mkdirSync(out, { recursive: true });
const b = readFileSync(src);
const img: Img = { width: b.readUInt32LE(0), height: b.readUInt32LE(4), data: new Uint8ClampedArray(b.buffer, b.byteOffset + 8, b.readUInt32LE(0) * b.readUInt32LE(4) * 4) };
const det = parseGraph(new Uint8Array(readFileSync(detPath))), rec = parseGraph(new Uint8Array(readFileSync(recPath)));
const p = ocrPage(det, rec, img, { maxSide: 1280 });
console.log(`skew ${p.angle}°, ${p.lines.length} lines, ${p.tables.length} tables, ${p.checks.length} check boxes, ${Math.round(p.ms.total)} ms`);
writeFileSync(`${out}/${name}.ocr.json`, JSON.stringify({ angle: p.angle, ms: p.ms, lines: p.lines.map((l) => ({ text: l.text, conf: +l.conf.toFixed(3), box: l.box, cell: l.cell })), tables: p.tables.map((t) => ({ xs: t.xs, ys: t.ys, cells: t.cells.map((c, i) => ({ ...c, text: t.text[i] })) })), checks: p.checks, text: pageText(p) }, null, 1));

// overlay: the deskewed page with boxes
const ov = new Uint8ClampedArray(p.image.data);
const W = p.width;
const rect = (x: number, y: number, w: number, h: number, c: number[], t = 2) => {
  for (let k = 0; k < t; k++)
    for (let i = Math.max(0, Math.floor(x)); i < Math.min(W, x + w); i++)
      for (const yy of [Math.floor(y) + k, Math.floor(y + h) - k])
        if (yy >= 0 && yy < p.height) ov.set(c, (yy * W + i) * 4);
  for (let k = 0; k < t; k++)
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(p.height, y + h); j++)
      for (const xx of [Math.floor(x) + k, Math.floor(x + w) - k])
        if (xx >= 0 && xx < W) ov.set(c, (j * W + xx) * 4);
};
for (const t of p.tables) for (const c of t.cells) rect(c.box.x + 3, c.box.y + 3, c.box.w - 6, c.box.h - 6, [40, 110, 255, 255], 2);
for (const c of p.checks) rect(c.box.x - 4, c.box.y - 4, c.box.w + 8, c.box.h + 8, [220, 0, 200, 255], 3);
for (const l of p.lines) {
  rect(l.box.x, l.box.y, l.box.w, l.box.h, l.conf >= 0.9 ? [20, 170, 60, 255] : l.conf >= 0.6 ? [240, 160, 0, 255] : [230, 30, 30, 255], 2);
  for (const ch of l.chars) if (ch.ch !== " " && (ch.p < 0.6 || ch.jamo)) rect(ch.x0, l.box.y + l.box.h - 6, ch.x1 - ch.x0, 4, [230, 30, 30, 255], 2);
}
writeFileSync(`${out}/${name}.overlay.png`, encodePng(ov, W, p.height, 4));

// documents
const png = encodePng(p.image.data, p.width, p.height, 4);
const asset = makeAsset(png, "image/png", `${name}.png`);
const doc = newDocument("OCR");
doc.assets[asset.id] = asset;
const pageOf = (mode: "rebuild" | "layer"): Page => {
  const pg = newPage("DOCUMENT", 794, Math.round((794 * p.height) / p.width), "OCR");
  pg.nodes = reconstruct(p, { mode, pageWidth: 794, assetId: asset.id, markBelow: 0 });
  return pg;
};
const rebuilt = pageOf("rebuild"), layer = pageOf("layer");
doc.pages = [rebuilt];
writeFileSync(`${out}/${name}.docx`, exportDocx([rebuilt]));
writeFileSync(`${out}/${name}.hwpx`, exportHwpx([rebuilt], name));
const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
const pdf = await exportPdfVector(doc, [rebuilt], { fonts, getBlob });
writeFileSync(`${out}/${name}.pdf`, pdf);
doc.pages = [layer];
const spdf = await exportPdfVector(doc, [layer], { fonts, getBlob });
writeFileSync(`${out}/${name}.searchable.pdf`, spdf);
const pdfjs = await import("pdfjs-dist");
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
const d = await pdfjs.getDocument({ data: spdf.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
const tc = await (await d.getPage(1)).getTextContent();
const txt = tc.items.map((i: any) => i.str).join(" ");
console.log(`searchable PDF text (${txt.length} chars): ${txt.slice(0, 160)}…`);
console.log(`sizes: docx ${readFileSync(`${out}/${name}.docx`).length}, hwpx ${readFileSync(`${out}/${name}.hwpx`).length}, pdf ${pdf.length}, searchable ${spdf.length}`);
}
