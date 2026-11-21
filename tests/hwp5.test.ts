// HWP 5.0 binary → HWPX: the converted package of qa/interop/adobe-made/hwp_doc.hwp against hwpx_doc.hwpx, the same
// document 한글 saved as HWPX (the oracle): paragraph texts, fonts, page setup, the table, the picture and 한글's own
// line layout (every paragraph mapped by the layout-truth reader, textpos units consistent).
// OMW_HWP5_FILES=<a.hwp>;<b.hwp>… also converts local HWP files (not in the repo): same text as the plain-text
// import and every paragraph mapped by the layout-truth reader.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { parseHwpx, parseHwpxFlow, type OfficeImportReport } from "../src/io/office";
import { hwp5ToHwpx } from "../src/io/formats/hwp5";
import { readHwpxTruth } from "../src/core/layoutcheck/hwpxLineseg";
import { compareLayout } from "../src/core/layoutcheck/compare";
import type { OfficePic } from "../src/io/officeDrawing";
import { hwpText } from "../src/io/formats/legacy";
import { exportById, formatForExt } from "../src/io/formats";
import type { OmwDocument } from "../src/core/types";

const DIR = join(process.cwd(), "qa/interop/adobe-made");
const HWP = join(DIR, "hwp_doc.hwp"), HWPX = join(DIR, "hwpx_doc.hwpx");
const has = existsSync(HWP) && existsSync(HWPX);

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const report = (): OfficeImportReport => ({ notesDropped: 0, pictures: [] as OfficePic[], sectionBlocks: [] });

describe.skipIf(!has)("hwp5ToHwpx: hwp_doc.hwp against 한글's own HWPX", () => {
  const conv = () => hwp5ToHwpx(new Uint8Array(readFileSync(HWP)));
  const real = () => new Uint8Array(readFileSync(HWPX));

  it("writes an HWPX package", () => {
    const f = unzipSync(conv());
    expect(Object.keys(f)[0]).toBe("mimetype");
    expect(strFromU8(f.mimetype)).toBe("application/hwp+zip");
    for (const k of ["Contents/header.xml", "Contents/section0.xml", "Contents/content.hpf", "BinData/image1.png"]) expect(f[k]).toBeDefined();
  });

  it("same paragraphs, runs, tables, page setup and picture as the HWPX", () => {
    const ra = report(), rb = report();
    const a = parseHwpxFlow(conv(), ra), b = parseHwpxFlow(real(), rb);
    const text = (items: typeof a) => items.map((i) => (i.kind === "p" ? i.p.runs.map((r) => r.text).join("") : "[table]"));
    expect(text(a)).toEqual(text(b));
    // runs keep their formatting (font, size, bold / italic / underline / strike, colour, highlight, spacing)
    const fmt = (items: typeof a) =>
      items.flatMap((i) => (i.kind === "p" ? i.p.runs.map((r) => [r.text, r.fontFamily, r.fontSize, r.bold, r.italic, r.underline, r.strike, r.script, r.color, r.highlight, r.spacingPct, r.hscale]) : []));
    expect(fmt(a)).toEqual(fmt(b));
    const pa = a.find((i) => i.kind === "p")!, pb = b.find((i) => i.kind === "p")!;
    expect(pa.kind === "p" && pa.p.runs[0].fontFamily).toBe(pb.kind === "p" && pb.p.runs[0].fontFamily);
    // paragraph shapes
    const para = (items: typeof a) => items.flatMap((i) => (i.kind === "p" ? [[i.p.align, i.p.lineSpacing, i.p.indent, i.p.indentLeft, i.p.spaceAfter, i.p.spaceBefore]] : []));
    expect(para(a)).toEqual(para(b));
    // the table: same cells
    const tbl = (items: typeof a) => items.flatMap((i) => (i.kind === "table" ? [i.table] : []));
    const [ta] = tbl(a), [tb] = tbl(b);
    expect(ta).toBeDefined();
    expect(JSON.stringify(ta.rows.map((r) => r.length))).toBe(JSON.stringify(tb.rows.map((r) => r.length)));
    expect(ta.colWidths).toEqual(tb.colWidths);
    // page setup, page breaks, header / footer / page number
    expect(ra.layout!.sections.map((s) => s.setup)).toEqual(rb.layout!.sections.map((s) => s.setup));
    expect(ra.layout!.pageBreaks).toEqual(rb.layout!.pageBreaks);
    const noIds = (k: string, v: unknown) => (k === "id" ? undefined : v);
    expect(JSON.stringify(ra.layout!.sections.map((s) => s.hf), noIds)).toBe(JSON.stringify(rb.layout!.sections.map((s) => s.hf), noIds));
    expect(ra.notesDropped).toBe(rb.notesDropped);
    // the picture
    expect(ra.pictures!.length).toBe(1);
    const [qa, qb] = [ra.pictures![0], rb.pictures![0]];
    expect([qa.g, qa.inline, qa.mime, qa.bytes.length]).toEqual([qb.g, qb.inline, qb.mime, qb.bytes.length]);
  });

  it("lineseg: every paragraph maps, same lines as 한글's HWPX", () => {
    const x = conv();
    const truth = readHwpxTruth(x);
    const rep = compareLayout(truth, parseHwpx(x), { fontAvailable: () => false, fit: false });
    expect(rep.skipped.unmapped ?? 0).toBe(0);
    expect(rep.simulatorAgrees).toBe(rep.compared);
    const oracle = readHwpxTruth(real());
    expect(truth.hancom).toBe(true);
    expect(truth.paras.map((p) => [p.text, p.segs, p.units, p.pos])).toEqual(oracle.paras.map((p) => [p.text, p.segs, p.units, p.pos]));
    expect(truth.sections).toEqual(oracle.sections);
    // shapes as the layout reader sees them
    expect([...truth.charPr.entries()]).toEqual([...oracle.charPr.entries()]);
    expect([...truth.paraPr.entries()]).toEqual([...oracle.paraPr.entries()]);
  });

  it("opens through the HWPX importer and saves unedited as the converted package, byte for byte", async () => {
    const bytes = new Uint8Array(readFileSync(HWP));
    const r = await formatForExt("hwp")!.open({ name: "omw-hwp.hwp", path: null, bytes }, {} as any);
    expect(r.pages.every((p) => p.source?.format === "hwpx" && p.source.name === "omw-hwp.hwpx")).toBe(true);
    expect(r.pages[0].source?.office).toBeDefined();
    // 한글's own lines on the body paragraphs, 한글 tables drawn from their cell paragraphs
    const nodes = r.pages.flatMap((p) => p.nodes);
    expect(nodes.some((n) => n.type === "TEXT" && n.paragraphs.some((q) => q.hwpLines))).toBe(true);
    expect(nodes.some((n) => n.type === "TABLE" && !!n.cellBox)).toBe(true);
    const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
    const out = (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
    expect(Buffer.from(out).equals(Buffer.from(conv()))).toBe(true);
  });

  it("refuses non-HWP input", () => {
    expect(() => hwp5ToHwpx(new Uint8Array(600))).toThrow();
  });
});

const extra = (process.env.OMW_HWP5_FILES ?? "").split(";").filter((f) => f && existsSync(f));
describe.skipIf(!extra.length)("hwp5ToHwpx: local HWP files (OMW_HWP5_FILES)", () => {
  for (const [k, f] of extra.entries())
    it(`file #${k + 1}`, () => {
      const bytes = new Uint8Array(readFileSync(f));
      const x = hwp5ToHwpx(bytes);
      // body text as the plain-text import reads it (paragraphs outside tables, then table cells)
      const items = parseHwpxFlow(x);
      const flowText = items.flatMap((i) => (i.kind === "p" ? [i.p.runs.map((r) => r.text).join("")] : i.table.paras.map((p) => p.runs.map((r) => r.text).join(""))));
      const legacy = hwpText(bytes).blocks.flatMap((b) => (b.kind === "para" ? [b.text] : b.kind === "table" ? b.rows.flat() : []));
      // the same characters (the text import joins nested-table cells with " | " and puts a text box's text after its
      // paragraph, the HWPX flow at the box's anchor); on a mismatch only counts are reported, not the text
      const chars = (xs: string[]) => [...xs.join("").replace(/[\s|]+/g, "")].sort().join("");
      const [na, nb] = [chars(flowText), chars(legacy)];
      let at = 0;
      while (at < na.length && na[at] === nb[at]) at++;
      expect(at === na.length && na.length === nb.length, `characters differ (${na.length} / ${nb.length}, sorted index ${at})`).toBe(true);
      const rep = compareLayout(readHwpxTruth(x), parseHwpx(x), { fontAvailable: () => false, fit: false });
      expect(rep.skipped.unmapped ?? 0).toBe(0);
      expect(rep.simulatorAgrees).toBe(rep.compared);
    });
});
