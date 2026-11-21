// Excel's printed geometry per Normal font, read from the PDFs of qa/interop/scripts/xlsx_print_fonts_make.ps1:
//   node scripts/xlsx-print-fonts.mjs <folder> [out.json]
// For each omni-xlsx-pfont-<font>-<size>.pdf: the printed font size, column and row pitch (dots at 600 dpi, between
// gridlines) and every "0"'s baseline below its row's top gridline — written as the truth JSON the print-font tests use
// (qa/interop/excel-made/omni-xlsx-print-fonts.truth.json). Excel's screen numbers (omni-xlsx-pfont.excel.json) are
// carried over: the stored column widths depend on the screen DPI Excel ran at (StandardWidth).
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join, resolve } from "node:path";

const D = 600 / 72;
const dir = resolve(process.argv[2] ?? ".");
const outFile = process.argv[3];

function contentStreams(file) {
  const b = readFileSync(file);
  const s = b.toString("latin1");
  const out = [];
  let i = 0;
  while ((i = s.indexOf("stream", i)) >= 0) {
    if (s.slice(i - 3, i) === "end") { i += 6; continue; }
    let st = i + 6;
    if (s[st] === "\r") st++;
    if (s[st] === "\n") st++;
    const end = s.indexOf("endstream", st);
    try {
      const o = inflateSync(b.subarray(st, end)).toString("latin1");
      if (/\bBT\b/.test(o)) out.push(o);
    } catch {
      /* not a content stream */
    }
    i = end + 9;
  }
  return out;
}

const r1 = (v) => Math.round(v * 10) / 10;
function page(txt) {
  const vx = new Set(), hy = new Set();
  const reLine = /(-?[\d.]+) (-?[\d.]+) m\s+(-?[\d.]+) (-?[\d.]+) l\s+S/g;
  let m;
  while ((m = reLine.exec(txt))) {
    const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
    if (Math.abs(x1 - x2) < 0.01) vx.add(r1(x1 * D));
    else if (Math.abs(y1 - y2) < 0.01) hy.add(r1(y1 * D));
  }
  const texts = [];
  const reT = /BT\s+\/\w+ ([\d.]+) Tf\s+1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm[\s\S]*?\[\(([^)]*)\)\] TJ/g;
  while ((m = reT.exec(txt))) texts.push({ size: r1(Number(m[1]) * D), x: r1(Number(m[2]) * D), y: r1(Number(m[3]) * D), t: m[4] });
  return { vx: [...vx].sort((a, b) => a - b), hy: [...hy].sort((a, b) => b - a), texts };
}

const excelJson = join(dir, "omni-xlsx-pfont.excel.json");
const excel = existsSync(excelJson) ? [].concat(JSON.parse(readFileSync(excelJson, "utf8").replace(/^﻿/, ""))) : [];
const rows = [];
for (const f of readdirSync(dir).filter((n) => /^omni-xlsx-pfont-.+\.pdf$/.test(n)).sort()) {
  const [, font, size] = /^omni-xlsx-pfont-(.+)-(\d+)\.pdf$/.exec(f);
  const p = page(contentStreams(join(dir, f)).join("\n"));
  // the printed block's outer line sits 4 dots outside the first gridline: lines from the second on bound the cells
  const xs = p.vx.slice(1), ys = p.hy.slice(1);
  const col = xs.slice(1).map((x, i) => r1(x - xs[i]));
  const row = ys.slice(1).map((y, i) => r1(ys[i] - y));
  // each "0" in the cell whose gridlines hold its start and baseline
  const txt = p.texts;
  const base = {};
  for (const t of txt) {
    const c = xs.findIndex((x, i) => i + 1 < xs.length && t.x >= x && t.x < xs[i + 1]);
    const r = ys.findIndex((y, i) => i + 1 < ys.length && t.y <= y && t.y > ys[i + 1]);
    if (c < 0 || r < 0) continue;
    base[String.fromCharCode(65 + c) + (r + 1)] = { size: t.size, below: r1(ys[r] - t.y) };
  }
  const xl = excel.find((e) => e.name === `omni-xlsx-pfont-${font}-${size}`);
  // baselines of the cells the tests read: A1 bottom, A2 centre, A3 top (default row), B13 / C13 / D13 (set row)
  const keep = Object.fromEntries(["A1", "A2", "A3", "B13", "C13", "D13"].filter((c) => base[c]).map((c) => [c, base[c].below]));
  rows.push({ font, size: Number(size), printSize: txt[0]?.size, col: col.slice(0, 6), row: [row[0], row[12], row[13]], base: keep, ...(xl ? { excel: { standardWidth: xl.standardWidth, standardHeight: xl.standardHeight, rowHeightPt: [xl.rowHeightPt[0], xl.rowHeightPt[12], xl.rowHeightPt[13]] } } : {}) });
}
// one book a line
const json = `{\n "about": "Excel 16 print of omni-xlsx-pfont-<font>-<size> (xlsx_print_fonts_make.ps1), screen at 120 dpi: dots at 600 dpi; col A default, B-F 1/3/5/12/20 chars; row = [default, set 30 pt, fitted to 2x font]; base = baseline below the row's top gridline",\n "books": [\n${rows.map((r) => "  " + JSON.stringify(r)).join(",\n")}\n ]\n}`;
if (outFile) writeFileSync(outFile, json.replace(/\n/g, "\r\n") + "\r\n");
else console.log(json);
