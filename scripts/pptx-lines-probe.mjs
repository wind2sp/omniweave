// node scripts/pptx-lines-probe.mjs [<folder of omni-pptx-lines.pptx>]
// PowerPoint's line placement, read from the PDF PowerPoint printed of the probe deck (qa/interop/scripts/pptx_lines_make.ps1):
// per text box (font, size, line spacing, space before) the first baseline below the box top, the pitch of a line
// break inside a paragraph and of the next paragraph, in points. docs/design/FIDELITY_PPTX.md 5장.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = process.argv[2] ?? join(tmpdir(), "omw-pptx-lines");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(dir, "omni-pptx-lines.pptx.ref.pdf"))), isEvalSupported: false, verbosity: 0 }).promise;
const cases = readFileSync(join(dir, "omni-pptx-lines.tsv"), "utf8").trim().split("\n").map((l) => {
  const [slide, x, y, font, size, ln, bef, bu] = l.split("\t");
  return { slide: +slide, x: +x, y: +y, font, size: +size, ln: +ln, bef: +bef, bu };
});
const bySlide = new Map();
for (let i = 1; i <= pdf.numPages; i++) {
  const pg = await pdf.getPage(i);
  const h = pg.getViewport({ scale: 1 }).height;
  const tc = await pg.getTextContent();
  bySlide.set(i, tc.items.filter((t) => t.str && t.str.trim()).map((t) => ({ x: t.transform[4], y: h - t.transform[5], s: t.str })));
}
const rows = [];
for (const c of cases) {
  const its = bySlide.get(c.slide).filter((t) => t.x >= c.x - 1 && t.x < c.x + 300 && t.y >= c.y && t.y < c.y + 260);
  const ys = [...new Set(its.map((t) => Math.round(t.y * 100) / 100))].sort((a, b) => a - b);
  // one baseline per line (items of a line share it)
  const lines = [];
  for (const y of ys) if (!lines.length || y - lines[lines.length - 1] > 1) lines.push(y);
  const [b1, b2, b3] = lines;
  rows.push({ ...c, first: b1 - c.y, within: b2 - b1, next: b3 - b2 });
}
const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : "-");
console.log("font\tbullet\tsize\tln\tbef\tfirst\tfirst/size\twithin\tnext");
for (const r of rows) console.log(`${r.font}\t${r.bu}\t${r.size}\t${r.ln}\t${r.bef}\t${f(r.first)}\t${f(r.first / r.size)}\t${f(r.within)}\t${f(r.next)}`);
