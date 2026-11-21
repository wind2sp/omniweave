// QA docx-flow (2026-11-21): adversarial checks of the flow engine changes (c5aa6f2) —
//  - Word's continuous section break mark (TextParagraph.sectMark) under editing: Enter in it, typing, Backspace into
//    it, the caret on its line of no height, and the in-place DOCX save keeping the w:sectPr after those edits
//  - DOC: a first paragraph of nothing but a page break keeps its break; a DOC edit next to the page-break paragraph
//    saves in place and reads back with the break
//  - tables: extreme w:tblInd kept over the column, a right-to-left table not pushed by w:tblInd
//  - keep with next: chains and kept tables longer than a page end (Word breaks the chain)
//  - the highlight of a centred line's last word in the exported PDF is the width the screen draws (shadeWidth)
import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { caretBox, flowLines, gatherStory, paginateStory, reanchor, reflowPages, reflowSegment, segments, tableShift } from "../src/core/flow";
import { bodyFormat, deleteChar, insertText, paraText, splitParagraph } from "../src/core/richtext";
import { layoutText, shadeWidth } from "../src/core/text";
import { DEFAULT_RUN, newDocument, newPage, newParagraph, newTable, newText, type OmwDocument, type Page, type TableNode, type TextNode, type TextParagraph } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";
import { lastLegacySave, legacyFingerprint, legacySource } from "../src/io/formats/legacyWrite";
import { collectFlow } from "../src/io/office";
import { installDom } from "./coverage/helpers";

beforeAll(installDom);

const read = (f: string) => new Uint8Array(readFileSync(f));
const asDoc = (pages: Page[], assets: unknown = {}) =>
  ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets }) as unknown as OmwDocument;
async function openAs(ext: "docx" | "doc", bytes: Uint8Array, name = `omw-qa.${ext}`) {
  const r = (await formatForExt(ext)!.open({ name, path: null, bytes }, {} as never)) as { pages: Page[]; assets?: unknown; doc?: { pages: Page[] } };
  return asDoc(r.doc?.pages ?? r.pages, r.assets ?? {});
}
const saveAs = async (ext: "docx" | "doc", doc: OmwDocument) => (await exportById(ext)!.run(doc, doc.pages[0], { confirm: () => true } as never)) as Uint8Array;
const flowParas = (pages: readonly Page[]) => collectFlow(pages).flatMap((it) => (it.kind === "p" ? [it.p] : []));
/** the body story of the segment holding paragraph `pred`, edited as the editor applies an edit */
function editStory(doc: OmwDocument, pred: (p: TextParagraph) => boolean, fn: (ps: TextParagraph[], i: number) => TextParagraph[]) {
  for (const seg of segments(doc.pages)) {
    const st = gatherStory(doc.pages, seg);
    const i = st.paras.findIndex(pred);
    if (i < 0) continue;
    const out = fn(st.paras, i);
    doc.pages = reflowSegment(doc.pages, seg.start, { ...st, paras: out, objs: reanchor(st.objs, st.paras, out) }) as Page[];
    return;
  }
  throw new Error("no such paragraph");
}
const sectPrs = (docx: Uint8Array) => strFromU8(unzipSync(docx)["word/document.xml"]).match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g) ?? [];
const SECT = "qa/interop/word-made/omni-fid-spacing-sect.docx";

describe("section break mark under editing", () => {
  const P = (s: string, x: Partial<TextParagraph> = {}): TextParagraph => ({ ...newParagraph(s, { fontSize: 16 }), ...x });
  const frame = (ps: TextParagraph[]) => {
    const t = newText("", 600);
    t.paragraphs = ps;
    t.wordSpacing = "max";
    return t;
  };

  it("Enter in the empty mark paragraph shows a new line; the mark stays with the paragraph keeping its id", () => {
    const ps = [P("앞", { spaceAfter: 10 }), P("", { spaceAfter: 4, sectMark: true }), P("제목", { spaceBefore: 20 })];
    const r = splitParagraph(ps, { p: 1, o: 0 });
    expect(r.paras.length).toBe(4);
    expect(r.paras[1].id).toBe(ps[1].id);
    expect(r.paras[1].sectMark).toBe(true);
    expect(r.paras[2].sectMark).toBeUndefined();
    const lay = layoutText(frame(r.paras));
    expect(lay.lines.filter((l) => l.paragraph === 1)[0].height).toBe(0);
    expect(lay.lines.filter((l) => l.paragraph === 2)[0].height).toBeGreaterThan(10);
    // typing in the new line, and in the mark itself, gives ordinary lines
    const typed = insertText(r.paras, r.pos, "새 글").paras;
    expect(paraText(typed[2])).toBe("새 글");
    const inMark = insertText(ps, { p: 1, o: 0 }, "글").paras;
    expect(layoutText(frame(inMark)).lines.find((l) => l.paragraph === 1)!.height).toBeGreaterThan(10);
    // Enter at the end of text typed into the mark: the text keeps the mark (and its line), the new paragraph is plain
    const r2 = splitParagraph(inMark, { p: 1, o: 1 });
    expect(r2.paras[1].sectMark).toBe(true);
    expect(r2.paras[2].sectMark).toBeUndefined();
    expect(layoutText(frame(r2.paras)).lines.find((l) => l.paragraph === 2)!.height).toBeGreaterThan(10);
  });

  it("Backspace at the start of the next paragraph joins into the mark paragraph: its text is a line", () => {
    const ps = [P("앞"), P("", { sectMark: true }), P("제목")];
    const r = deleteChar(ps, { p: 2, o: 0 }, -1);
    expect(r.paras.length).toBe(2);
    expect(paraText(r.paras[1])).toBe("제목");
    expect(layoutText(frame(r.paras)).lines.find((l) => l.paragraph === 1)!.height).toBeGreaterThan(10);
    // Delete at the end of the paragraph before: the mark paragraph goes (its break with it in the saved file)
    const d = deleteChar(ps, { p: 0, o: 1 }, 1);
    expect(d.paras.length).toBe(2);
    expect(d.paras.some((q) => q.sectMark)).toBe(false);
  });

  it("the caret on the mark's line of no height has a height", async () => {
    const doc = await openAs("docx", read(SECT));
    const seg = segments(doc.pages).find((s) => gatherStory(doc.pages, s).paras.some((p) => p.sectMark))!;
    const st = gatherStory(doc.pages, seg);
    const i = st.paras.findIndex((p) => p.sectMark);
    const box = caretBox(flowLines(doc.pages, seg), i, 0)!;
    expect(box.h).toBeGreaterThan(8);
  });

  it("DOCX saved in place after Enter / typing at the mark keeps every w:sectPr and the continuous break", async () => {
    const orig = read(SECT);
    const n0 = sectPrs(orig).length;
    for (const edit of ["enter", "type", "joinNext", "typeNext"] as const) {
      const doc = await openAs("docx", orig);
      editStory(doc, (p) => !!p.sectMark, (ps, i) => {
        if (edit === "enter") return insertText(splitParagraph(ps, { p: i, o: 0 }, { body: bodyFormat(ps) }).paras, { p: i + 1, o: 0 }, "omw 새 줄").paras;
        if (edit === "type") return insertText(ps, { p: i, o: 0 }, "omw 글").paras;
        if (edit === "joinNext") return deleteChar(ps, { p: i + 1, o: 0 }, -1).paras;
        return insertText(ps, { p: i + 1, o: 0 }, "omw ").paras;
      });
      const out = await saveAs("docx", doc);
      const xml = strFromU8(unzipSync(out)["word/document.xml"]);
      expect(sectPrs(out).length, edit).toBe(n0);
      expect(xml.match(/w:type w:val="continuous"/g)?.length ?? 0, edit).toBe(sectPrs(orig).join("").match(/w:type w:val="continuous"/g)?.length ?? 0);
      if (edit !== "joinNext") expect(xml, edit).toContain("omw");
      // read again: the mark (or the text typed into it) is where it was
      const again = flowParas((await openAs("docx", out)).pages);
      if (edit === "enter") {
        const k = again.findIndex((p) => p.sectMark);
        expect(k, edit).toBeGreaterThanOrEqual(0);
        expect(paraText(again[k + 1]), edit).toBe("omw 새 줄");
      }
      if (edit === "type") expect(again.some((p) => p.sectMark), edit).toBe(false);
    }
  });
});

describe("DOC page-break paragraphs", () => {
  it("word_doc.doc: typing into the page-break paragraph at the top of page 3 saves in place, the break read back", async () => {
    const orig = read("qa/interop/adobe-made/word_doc.doc");
    const doc = await openAs("doc", orig, "word_doc.doc");
    const pages0 = reflowPages(doc.pages);
    const firstOf3 = (pages: Page[]) => pages[2].nodes.find((n): n is TextNode => n.type === "TEXT" && !!n.flow)!.paragraphs;
    const target = firstOf3(pages0)[0];
    expect(paraText(target)).toBe("");
    editStory(doc, (p) => p.id === target.id, (ps, i) => insertText(ps, { p: i, o: 0 }, "omw").paras);
    const out = await saveAs("doc", doc);
    expect(lastLegacySave.doc).toBe("text");
    const back = reflowPages((await openAs("doc", out, "word_doc.doc")).pages);
    const top = firstOf3(back);
    expect(paraText(top[0])).toBe("omw");
    expect(paraText(top[1])).toMatch(/^두 번째 쪽/);
    expect(back.length).toBe(pages0.length);
  });
});

describe("DOC opened before w:tblInd was read", () => {
  it("its fingerprint (tables without wordInd) still matches: a text edit saves in place", async () => {
    const orig = read("qa/interop/adobe-made/word_doc.doc");
    const doc = await openAs("doc", orig, "word_doc.doc");
    const tbs = doc.pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
    expect(tbs.some((t) => t.wordInd !== undefined)).toBe(true);
    // the pages as the open before c5aa6f2 made them, and their fingerprint
    for (const t of tbs) delete t.wordInd;
    const src = legacySource(doc.pages, "doc")!;
    src.legacy!.fp = legacyFingerprint("doc", doc.pages);
    editStory(doc, (p) => /^두 번째 쪽/.test(paraText(p)), (ps, i) => insertText(ps, { p: i, o: 0 }, "omw ").paras);
    await saveAs("doc", doc);
    expect(lastLegacySave.doc).toBe("text");
  });
});

describe("table position edge cases", () => {
  const tbl = (ind: string, extra = "") =>
    `<w:tbl><w:tblPr>${extra}<w:tblW w:w="2000" w:type="dxa"/>${ind}</w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>`;
  const docx = (body: string) =>
    zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
      "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
      "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
      "word/styles.xml": strToU8(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`),
      "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>앞</w:t></w:r></w:p>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    });
  const tables = (pages: Page[]) => pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");

  it("an extreme negative / positive w:tblInd keeps part of the table over the column; RTL tables are not pushed", async () => {
    const doc = await openAs("docx", docx(tbl(`<w:tblInd w:w="-9999999" w:type="dxa"/>`) + tbl(`<w:tblInd w:w="9999999" w:type="dxa"/>`) + tbl(`<w:tblInd w:w="720" w:type="dxa"/>`, "<w:bidiVisual/>") + tbl(`<w:tblInd w:w="720" w:type="dxa"/>`)));
    const ts = tables(doc.pages);
    expect(ts.length).toBe(4);
    const pg = doc.pages[0];
    const left = pg.margins?.left ?? 96;
    const colW = pg.width - left - (pg.margins?.right ?? 96);
    const xs = ts.map((t) => t.transform.x - left);
    const w = (t: TableNode) => t.colWidths.reduce((s, c) => s + c, 0);
    // some of the table over the column, inside Word's ±22 inch range
    expect(xs[0] + w(ts[0])).toBeGreaterThan(0);
    expect(xs[1]).toBeLessThan(colW);
    // (a file without settings.xml is read as before compatibility mode 15: less the left cell margin, 108 twips)
    expect(Math.abs(ts[0].wordInd!)).toBeLessThanOrEqual(((31680 + 108) / 20) * (96 / 72) + 0.01);
    expect(ts[2].wordInd).toBeUndefined();
    expect(xs[3]).toBeCloseTo(((720 - 108) / 20) * (96 / 72), 0);
    expect(tableShift(ts[0], colW)).toBeCloseTo(xs[0], 6);
  });
});

describe("keep with next longer than a page", () => {
  const P = (s: string, x: Partial<TextParagraph> = {}): TextParagraph => ({ ...newParagraph(s, { fontSize: 16 }), ...x });
  const pageWith = (paras: TextParagraph[], table?: TableNode) => {
    const p = newPage("DOCUMENT", 794, 1123, "1");
    p.source = { format: "docx" } as Page["source"];
    const t = newText("", 600);
    t.flow = true;
    t.wordSpacing = "max";
    t.paragraphs = paras;
    p.nodes.push(t);
    if (table) {
      table.flow = true;
      table.transform = { x: 0, y: 2000, rotation: 0, scale: 1 };
      p.nodes.push(table);
    }
    return p;
  };

  it("a chain of 200 kept paragraphs flows on (no endless loop, the chain broken where the page is full)", () => {
    const ps = [...Array.from({ length: 5 }, (_, i) => P(`앞 ${i}`)), ...Array.from({ length: 200 }, (_, i) => P(`묶음 ${i}`, { keepNext: true })), P("끝")];
    const out = reflowPages([pageWith(ps)]);
    expect(out.length).toBeGreaterThan(3);
    const texts = out.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).flatMap((n) => n.paragraphs.map(paraText)));
    expect(texts.filter((s) => s.startsWith("묶음")).length).toBe(200);
    // the first page is not left empty by the chain (it starts right after the lines before it)
    expect(out[0].nodes.some((n) => n.type === "TEXT" && n.paragraphs.some((q) => paraText(q) === "묶음 0"))).toBe(true);
  });

  it("a table of 80 kept rows (taller than a page) after a kept heading: flows over pages, the heading not moved alone", () => {
    const rows = Array.from({ length: 80 }, (_, i) => [{ text: `행 ${i}`, richText: [P(`행 ${i}`, { keepNext: true })] }]);
    const tb = newTable(rows, [300], "표");
    const ps = [...Array.from({ length: 10 }, (_, i) => P(`앞 ${i}`)), P("제목", { keepNext: true })];
    const t0 = Date.now();
    const out = reflowPages([pageWith(ps, tb)]);
    expect(Date.now() - t0).toBeLessThan(20000);
    const parts = out.flatMap((pg) => pg.nodes).filter((n): n is TableNode => n.type === "TABLE");
    expect(parts.reduce((s, t) => s + t.rows.length, 0)).toBeGreaterThanOrEqual(80);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("paginateStory with a kept table taller than the page: every row placed", () => {
    const rows = Array.from({ length: 120 }, (_, i) => [{ text: `${i}`, richText: [P(`${i}`, { keepNext: true })] }]);
    const tb = newTable(rows, [300], "표");
    const out = reflowPages([pageWith([P("앞", { keepNext: true }), P("뒤")], tb)]);
    expect(out.flatMap((pg) => pg.nodes).filter((n): n is TableNode => n.type === "TABLE").reduce((s, t) => s + t.rows.length, 0)).toBeGreaterThanOrEqual(120);
    expect(typeof paginateStory).toBe("function");
  });
});

describe("highlight width: exported PDF = screen", { timeout: 60_000 }, () => {
  it("a centred line's highlighted last word is shaded its own width in the vector PDF", async () => {
    const { exportPdfVector } = await import("../src/io/pdfVector");
    const pdfjs: any = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
    const fonts = { regular: read("assets/fonts/Pretendard-Regular.ttf"), bold: read("assets/fonts/Pretendard-Bold.ttf") };
    const pg = newPage("DOCUMENT", 794, 1123, "P");
    const t = newText("", 600);
    t.paragraphs = [{ ...newParagraph(""), align: "CENTER", runs: [{ ...DEFAULT_RUN, fontFamily: "Pretendard", text: "가운데 정렬 " }, { ...DEFAULT_RUN, fontFamily: "Pretendard", text: "Center ", highlight: "#FFFF00" } as never] }];
    t.transform = { x: 60, y: 80, rotation: 0, scale: 1 };
    pg.nodes.push(t);
    const doc = newDocument("t");
    doc.pages = [pg];
    const line = layoutText(t).lines[0];
    const last = line.pieces[line.pieces.length - 1];
    const want = shadeWidth(line, last);
    expect(want).toBeGreaterThan(10);
    const bytes = await exportPdfVector(doc, [pg], { fonts });
    const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
    const ol = await (await d.getPage(1)).getOperatorList();
    await d.destroy();
    const widths: number[] = [];
    ol.fnArray.forEach((fn: number, k: number) => {
      if (fn !== pdfjs.OPS.constructPath) return;
      const [ops, args] = ol.argsArray[k];
      let a = 0;
      for (const op of ops) {
        if (op === pdfjs.OPS.rectangle) widths.push(Math.abs(args[a + 2]));
        a += op === pdfjs.OPS.rectangle ? 4 : op === pdfjs.OPS.curveTo ? 6 : op === pdfjs.OPS.curveTo2 || op === pdfjs.OPS.curveTo3 ? 4 : op === pdfjs.OPS.closePath ? 0 : 2;
      }
    });
    // the page is drawn in px scaled to pt (or in pt): one of the two
    expect(widths.some((w) => Math.abs(w - want) < 0.05 || Math.abs(w - want * 0.75) < 0.05), `${widths} vs ${want}`).toBe(true);
    // the old cut (line width less the moved x) was much narrower on a centred line
    expect(Math.max(0, line.width - last.x)).toBeLessThan(want - 5);
  });
});
